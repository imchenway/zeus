import { temporaryWorkspaceId, type AutomationNotificationPage, type AutomationNotificationStatus, type NotificationPosition } from '@zeus/shared';
import {
  AutomationNotificationRepository,
  DigitalTeamNodeAttemptRepository,
  DigitalTeamWorkflowRunRepository,
  TaskWorkPlanningRepository,
  type AutomationNotificationDraft,
  type AutomationRunRecord,
  type AutomationRunRepository,
  type AutomationTaskRepository,
  type ConversationRepository,
  type DigitalEmployeeExecutionRepository,
  type ProjectRepository,
  type TaskWorkRunRepository,
  type ZeusDatabasePort,
} from '@zeus/storage';

/** 通知使用已有领域仓库解析身份，不向 Renderer 暴露执行表。 */
export interface AutomationNotificationServiceOptions {
  /** 同一数据库的耐久事务。 */
  db: ZeusDatabasePort;
  /** 自动化运行事实。 */
  runs: AutomationRunRepository;
  /** 冻结规则名称。 */
  tasks: AutomationTaskRepository;
  /** 会话元数据，不加载正文。 */
  conversations: ConversationRepository;
  /** 项目显示名称。 */
  projects: ProjectRepository;
  /** 准确员工执行身份。 */
  workRuns: TaskWorkRunRepository;
  /** 历史员工执行只按原身份读取。 */
  legacyExecutions: DigitalEmployeeExecutionRepository;
  /** 只读诊断不生成新投影。 */
  readOnly: boolean;
  /** 展示前移除异常中的秘密。 */
  redact(message: string): string;
  /** 提交成功后唤醒现有事件连接。 */
  publish(type: string, payload: Record<string, unknown>): void;
}

/** 按真实引用生成通知，查询、调度和确认使用同一投影入口。 */
export function createAutomationNotificationService(options: AutomationNotificationServiceOptions) {
  /** 通知状态仅由此仓库管理。 */
  const notifications = new AutomationNotificationRepository(options.db);
  /** 流程节点按原流程运行枚举，包含其真实尝试。 */
  const nodes = new DigitalTeamNodeAttemptRepository(options.db);
  /** 流程归属用于检查跨任务引用。 */
  const workflows = new DigitalTeamWorkflowRunRepository(options.db);
  /** 原安排代次保留在历史阶段中。 */
  const plans = new TaskWorkPlanningRepository(options.db);

  /** 已读和新结果都通过相同事件刷新角标。 */
  function publishChanged(): void {
    options.db.afterCommit(() => options.publish('automation.notifications.changed', {}));
  }

  /** 同次运行按会话去重，未创建会话的执行保留独立异常。 */
  function describe(run: AutomationRunRecord): AutomationNotificationDraft[] {
    /** 源队列只收纳需要查看的结果状态。 */
    const status = run.status as AutomationNotificationStatus;
    /** 名称按触发时修订解释，不依赖当前规则是否已删除。 */
    const automationName = options.tasks.getRevision(run.automationRevisionId)?.snapshot.name ?? options.tasks.getById(run.automationId)?.name ?? run.automationId;
    /** 每个会话只能有一条通知，同次运行不同会话互不覆盖。 */
    const items = new Map<string, AutomationNotificationDraft>();
    /** 恢复仍沿用原运行的真实派发进度。 */
    const canResume = (run.status === 'blocked' || run.status === 'outcome_unknown') && !run.dispatchCompletedAt && run.dispatchTargets.some((target) => target.status === 'pending' || target.status === 'accepting');

    /** 摘要只携带真实项目和会话，不制造替代会话。 */
    function add(key: string, projectId: string, conversationId: string | null, reason?: string | null): void {
      /** 元数据查询不读取模型正文。 */
      const conversation = conversationId ? options.conversations.getRecordById(conversationId) : undefined;
      /** 引用失效时保留异常，禁止跳到另一个项目或任务的最新会话。 */
      const valid = conversation && conversation.projectId === projectId;
      /** 会话稳定身份优先于引用身份，同会话的多个引用合并。 */
      const targetKey = conversationId ? `conversation:${conversationId}` : key;
      /** 无会话记录必须说明为什么无法打开。 */
      const errorMessage = conversationId && !valid ? '原会话已不存在或归属已变化。' : (reason ?? run.errorMessage ?? (!conversationId ? '本次执行没有生成会话。' : null));
      items.set(targetKey, {
        targetKey,
        automationName,
        projectId,
        projectName: projectId === temporaryWorkspaceId ? '' : (options.projects.getById(projectId)?.name ?? projectId),
        conversationId: valid ? conversation.id : null,
        conversationTitle: valid ? conversation.title : '',
        status,
        errorMessage: errorMessage ? options.redact(errorMessage).slice(0, 2048) : null,
        errorCode: conversationId && !valid ? 'ZEUS_AUTOMATION_CONVERSATION_NOT_FOUND' : run.errorCode,
        canResume,
      });
    }

    for (const reference of run.executionReferences) {
      /** 冻结目标提供准确项目，即使项目目录后来改变也不串到别处。 */
      const target = run.dispatchTargets.find((entry) => entry.reference?.kind === reference.kind && entry.reference.id === reference.id && entry.reference.generation === reference.generation);
      /** 无目标的旧记录保留原运行归属。 */
      const projectId = target?.projectId ?? run.projectId;
      /** 没有会话的异常按执行身份独立确认。 */
      const key = `execution:${reference.kind}:${reference.id}:${reference.generation ?? ''}`;
      if (reference.kind === 'conversation') {
        add(key, projectId, reference.conversationId ?? reference.id);
      } else if (reference.kind === 'task_work') {
        /** 只读取引用指向的工作运行，不读取工作项的当前运行。 */
        const work = options.workRuns.getById(reference.id);
        if (work && (!reference.taskId || work.taskId === reference.taskId)) add(key, work.projectId, work.conversationId, work.errorMessage);
        else add(key, projectId, null, '原工作运行已不存在或归属已变化。');
      } else if (reference.kind === 'legacy_employee') {
        /** 旧员工执行使用原身份，不重启已退役执行。 */
        const execution = options.legacyExecutions.getById(reference.id);
        if (execution && (!reference.taskId || execution.taskId === reference.taskId)) add(key, execution.projectId, execution.conversationId);
        else add(key, projectId, null, '原员工执行已不存在或归属已变化。');
      } else if (reference.kind === 'workflow') {
        /** 同一任务可能有多轮流程，只能枚举原流程的节点。 */
        const workflow = workflows.getById(reference.id);
        if (!workflow || (reference.taskId && workflow.taskId !== reference.taskId)) {
          add(key, projectId, null, '原流程运行已不存在或归属已变化。');
          continue;
        }
        /** 某些节点会话只登记在准确工作运行中。 */
        const attempts = nodes.listByRun(reference.id);
        /** 只在该流程完全没有查看目标时补一条流程级异常。 */
        let hasWorkflowTarget = false;
        for (const attempt of attempts) {
          /** 只从当前节点尝试的准确工作引用补足会话身份。 */
          const work = attempt.workRunId ? options.workRuns.getById(attempt.workRunId) : undefined;
          if (attempt.conversationId || (work?.taskId === workflow.taskId && work.conversationId)) {
            add(`${key}:${attempt.id}`, workflow.projectId, attempt.conversationId ?? work?.conversationId ?? null);
            hasWorkflowTarget = true;
          } else if (attempt.status === 'failed' || attempt.status === 'outcome_unknown') {
            add(`${key}:${attempt.id}`, workflow.projectId, null);
            hasWorkflowTarget = true;
          }
        }
        if (!hasWorkflowTarget) add(key, workflow.projectId, null);
      } else if (reference.kind === 'task_plan') {
        /** 未冻结代次的引用无法安全解析，不能改用当前安排。 */
        const workIds = reference.generation ? plans.listRunIdsForGeneration(reference.id, reference.generation) : [];
        if (!workIds.length) add(key, projectId, null, '原工作安排尚无可查看的会话。');
        for (const id of workIds) {
          /** 原代次内每次真实工作独立保留其会话。 */
          const work = options.workRuns.getById(id);
          if (work && (!reference.taskId || work.taskId === reference.taskId)) add(`${key}:${id}`, work.projectId, work.conversationId, work.errorMessage);
        }
      }
    }
    if (!run.executionReferences.length && run.conversationId) add('run', run.projectId, run.conversationId);
    // 部分项目尚未接纳时，即使已有其他会话，也保留失败原因和恢复入口。
    if (canResume) for (const target of run.dispatchTargets.filter((entry) => entry.status === 'pending' || entry.status === 'accepting')) add(`target:${target.projectId}`, target.projectId, null, target.reason);
    if (!items.size) add('run', run.projectId, null, run.errorMessage ?? run.dispatchTargets.find((target) => target.reason)?.reason);
    return [...items.values()];
  }

  /** 原始结果和投影之间有耐久游标，重启及漏事件后可以补齐。 */
  function synchronize(): void {
    if (options.readOnly) return;
    /** 每批先读再写；没有待处理数据时不触发数据库保存。 */
    let pending = notifications.pending();
    while (pending.length) {
      options.db.commitCriticalFactSync(() => {
        for (const source of pending) {
          /** 外键保证运行存在，丢失意味着数据已不一致，不能静默遗漏。 */
          const run = options.runs.getById(source.id);
          if (!run) throw new Error('ZEUS_AUTOMATION_RUN_NOT_FOUND: 通知关联的运行不存在。');
          notifications.project(source, describe({ ...run, ...source.snapshot }));
        }
        publishChanged();
      });
      pending = notifications.pending();
    }
  }

  return {
    synchronize,
    /** 查询前补齐源修订，之后确认才不会错过刚产生的结果。 */
    list(cursor?: string, before?: NotificationPosition): AutomationNotificationPage {
      synchronize();
      /** 删除会话或恢复运行后读取现状，不重新制造未读修订。 */
      const page = notifications.list(cursor, before);
      page.items = page.items.map((item) => {
        /** 每页只核对会话元数据与当前恢复资格。 */
        const conversation = item.conversationId ? options.conversations.getRecordById(item.conversationId) : undefined;
        /** 恢复按钮不使用旧摘要判断。 */
        const run = options.runs.getById(item.runId);
        /** 会话删除保留通知，以便用户查看异常并手动确认。 */
        const missing = item.conversationId && (!conversation || conversation.projectId !== item.projectId);
        return {
          ...item,
          ...(missing ? { conversationId: null, errorCode: 'ZEUS_AUTOMATION_CONVERSATION_NOT_FOUND', errorMessage: '原会话已不存在或归属已变化。' } : {}),
          canResume: Boolean(run && (run.status === 'blocked' || run.status === 'outcome_unknown') && !run.dispatchCompletedAt && run.dispatchTargets.some((target) => target.status === 'pending' || target.status === 'accepting')),
        };
      });
      return page;
    },
    /** 全量确认使用调用方的幂等事务，提交成功后统一刷新各窗口角标。 */
    acknowledgeAll() {
      /** 不读取列表分页，避免遗漏尚未加载的通知。 */
      const result = notifications.acknowledgeAll();
      publishChanged();
      return result;
    },
    /** 调用方以已有幂等事务提交确认，只有提交成功才广播。 */
    acknowledge(id: string, expectedRevision: number) {
      /** 返回是否确实确认该修订，过期确认保持新结果未读。 */
      const result = notifications.acknowledge(id, expectedRevision);
      if (result.acknowledged) publishChanged();
      return result;
    },
  };
}

/** 路由只依赖已组装的通知应用服务。 */
export type AutomationNotificationService = ReturnType<typeof createAutomationNotificationService>;
