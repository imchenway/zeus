import type {
  AutomationDefinitionSnapshot,
  AutomationRevisionRecord,
  AutomationRunRecord,
  AutomationRunRepository,
  AutomationTaskRecord,
  AutomationTaskRepository,
  ConversationRepository,
  ConversationSubmissionRepository,
  ZeusProjectRecord,
} from '@zeus/storage';
import { automationEventStatusId, type AutomationDispatchTarget, type AutomationExecutionReference, type AutomationExecutionState } from '@zeus/shared';

export interface AutomationDispatchResult {
  conversationId: string;
  submissionId: string;
}

export interface AutomationSchedulerOptions {
  /** 每轮结果持久化后补齐逐会话通知；漏事件和重启均可收敛。 */
  synchronizeNotifications?(): void;
  /** 在旧调度启动前原子移交员工规则及在途关联。 */
  migrateLegacy?(): void;
  /** 按原规则修订或原事件序号解释退役项目状态，不扩大多项目筛选范围。 */
  resolveLegacyTaskStatus?(projectId: string, statusId: string, source: { revisionId: string } | { eventSequence: number }): string;
  /** 接纳前解析并冻结任务与项目绑定，任务池为空返回明确跳过。 */
  prepareAction?(input: { run: AutomationRunRecord; snapshot: AutomationDefinitionSnapshot; project: ZeusProjectRecord; target: AutomationDispatchTarget }): Promise<{ taskId: string; employeeId: string } | null>;
  /** 每次只接纳一个已冻结目标，准确引用由调度器耐久保存。 */
  dispatchAction?(input: { run: AutomationRunRecord; snapshot: AutomationDefinitionSnapshot; project: ZeusProjectRecord; target: AutomationDispatchTarget }): Promise<AutomationExecutionReference | null>;
  /** 读取真实工作或完整流程，暂停不等于终态。 */
  readExecution?(reference: AutomationExecutionReference): AutomationExecutionState | undefined;
  tasks: AutomationTaskRepository;
  runs: AutomationRunRepository;
  conversations: ConversationRepository;
  submissions: ConversationSubmissionRepository;
  getProject(projectId: string): ZeusProjectRecord | undefined;
  /** 无项目运行按需创建 Zeus 托管的临时会话工作区。 */
  ensureTemporaryWorkspace(runId: string): ZeusProjectRecord;
  /** 一次派发接收整组冻结项目，只能产生一个会话。 */
  dispatch(input: { run: AutomationRunRecord; snapshot: AutomationDefinitionSnapshot; project: ZeusProjectRecord; projects: ZeusProjectRecord[] }): Promise<AutomationDispatchResult>;
  save(): Promise<void>;
  now(): string;
  publish(type: string, payload: Record<string, unknown>): void;
}

export interface AutomationScheduler {
  kick(): void;
  close(): Promise<void>;
}

const interactionConversationStages = new Set(['waiting_user', 'waiting_approval', 'paused', 'archived']);

export function createAutomationScheduler(options: AutomationSchedulerOptions): AutomationScheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickPromise: Promise<void> | null = null;
  let closed = false;
  let recovered = false;
  /** 本次启动之前错过的时间点只推进排程，不补发历史工作。 */
  const startedAt = options.now();

  async function tick(): Promise<void> {
    options.migrateLegacy?.();
    if (!recovered) {
      recoverInterruptedDispatches();
      reconcileRruleSchedules();
      await options.save();
      recovered = true;
    }
    const now = options.now();
    acceptDue(now);
    acceptEvents();
    reconcileRunning();
    /** 未完成逐目标派发的原运行优先恢复，不能让排队运行越过它。 */
    for (const candidate of [...options.runs.listInFlight().filter((run) => run.status === 'dispatching'), ...options.runs.listDispatchable(8)]) await dispatch(candidate);
    await options.save();
    options.synchronizeNotifications?.();
  }

  /** 按原事件的前后状态与来源接纳，不从处理时的任务状态重新推断。 */
  function acceptEvents(): void {
    for (const task of options.tasks.list().filter((entry) => entry.status === 'active' && entry.triggerKind === 'event')) {
      /** 条件来源固定到实际作者修订，状态、游标等后续更新时间不能替代。 */
      const revision = options.tasks.getRevision(task.currentRevisionId);
      if (!revision) continue;
      for (const target of options.tasks.listTargets(task.id).filter((entry) => entry.enabled)) {
        const events = task.triggerConfig.eventKinds?.includes('code_changed')
          ? options.tasks.listCodeTriggerEvents(target.projectId, task.eventCursors[target.projectId] ?? 0)
          : options.tasks.listTriggerEvents(target.projectId, task.eventCursors[target.projectId] ?? 0);
        for (const event of events) {
          options.tasks.consumeEvent(task.id, target.projectId, event.sequence, () => {
            /** 项目流程自身生成的任务事件不会反向触发新的自动化。 */
            const source = event.payload.source;
            if (event.eventType === 'task.management_status.migrated' || event.payload.suppressAutomation === true || ['automation', 'digital_employee_automation', 'digital_team_workflow', 'task_push'].includes(String(source))) return;
            /** 旧规则与界面均允许使用业务触发名称。 */
            const kinds = task.triggerConfig.eventKinds ?? [];
            const aliases: Record<string, string[]> = {
              task_created: ['task.created'],
              task_updated: ['task.updated', 'task.tags.updated', 'task.relationships.updated'],
              task_status_changed: ['task.status.changed', 'task.management_status.changed'],
            };
            if (kinds.length > 0 && !kinds.some((kind) => kind === event.eventType || aliases[kind]?.includes(event.eventType))) return;
            /** 原事件与原规则分别投影；新全局事件、后来保存的规则不再套旧映射。 */
            const resolveEventStatus = (statusId: string | null): string | null => (statusId ? (options.resolveLegacyTaskStatus?.(target.projectId, statusId, { eventSequence: event.sequence }) ?? statusId) : null);
            const before = resolveEventStatus(automationEventStatusId(event.payload, true));
            const after = resolveEventStatus(automationEventStatusId(event.payload, false));
            /** 原作者修订在本项目要求的发生前状态。 */
            const expectedBefore = resolveRevisionTaskStatus(revision, target.projectId, task.triggerConfig.beforeStatusId);
            /** 原作者修订在本项目要求的发生后状态。 */
            const expectedAfter = resolveRevisionTaskStatus(revision, target.projectId, task.triggerConfig.afterStatusId);
            if (expectedBefore && before !== expectedBefore) return;
            if (expectedAfter && after !== expectedAfter) return;
            options.runs.enqueue({ automationId: task.id, projectIds: [target.projectId], triggerKind: 'event', triggerIdentity: event.identity, scheduledAt: event.occurredAt, sourceEvent: event });
          });
        }
      }
    }
  }

  /** 同名旧状态按规则修订和当前目标项目解析，不能合并其他项目映射。 */
  function resolveRevisionTaskStatus(revision: AutomationRevisionRecord, projectId: string, statusId: string | undefined): string | undefined {
    return statusId ? (options.resolveLegacyTaskStatus?.(projectId, statusId, { revisionId: revision.id }) ?? statusId) : undefined;
  }

  /** 历史运行只生成目标项目的执行视图，冻结修订保持原文。 */
  function snapshotForProject(revision: AutomationRevisionRecord, projectId: string): AutomationDefinitionSnapshot {
    if (!options.resolveLegacyTaskStatus || !revision.snapshot.action.taskFilter?.managementStatuses?.length) return revision.snapshot;
    /** 仅修改本次交给任务领取边界的状态条件。 */
    const snapshot = structuredClone(revision.snapshot);
    snapshot.action.taskFilter!.managementStatuses = snapshot.action.taskFilter!.managementStatuses.map((statusId) => resolveRevisionTaskStatus(revision, projectId, statusId)!);
    return snapshot;
  }

  /** 重算旧 RRULE 缓存，截止或周期修正必须在首次接纳之前生效。 */
  function reconcileRruleSchedules(): void {
    /** 启动时刻本身仍可触发；更早的计划时间遵循不补跑规则。 */
    const beforeStartup = new Date(new Date(startedAt).getTime() - 1);
    // 启动时只推进活动规则；暂停规则在显式恢复时重新计算。
    for (const task of options.tasks.list().filter((entry) => entry.status === 'active' && entry.triggerKind === 'rrule')) {
      try {
        options.tasks.setNextRun(task.id, computeNextRun(task, beforeStartup));
      } catch (error) {
        pauseInvalidSchedule(task, error);
      }
    }
  }

  /** 配置错误只暂停对应规则，不接纳工作，也不阻断其他自动化。 */
  function pauseInvalidSchedule(task: AutomationTaskRecord, error: unknown): void {
    options.tasks.setStatus(task.id, 'paused');
    options.tasks.setNextRun(task.id, null);
    options.publish('automation.schedule.failed', { automationId: task.id, code: errorCode(error), message: error instanceof Error ? error.message : String(error) });
  }

  /** 在接纳前计算后继时间，避免非法配置先产生运行再中断调度。 */
  function acceptDue(now: string): void {
    for (const task of options.tasks.listDue(now)) {
      /** 后继时间为空表示本次之后已无有效计划。 */
      let nextRunAt: string | null;
      try {
        nextRunAt = computeNextRun(task, new Date(now));
      } catch (error) {
        pauseInvalidSchedule(task, error);
        continue;
      }
      if (task.nextRunAt && task.nextRunAt < startedAt) {
        options.tasks.setNextRun(task.id, nextRunAt);
        options.publish('automation.schedule.skipped', { automationId: task.id, scheduledAt: task.nextRunAt, reason: '启动前已错过的时间点不补跑' });
        continue;
      }
      /** 定时触发同样把全部启用项目冻结到一条运行。 */
      const projectIds = options.tasks
        .listTargets(task.id)
        .filter((entry) => entry.enabled)
        .map((entry) => entry.projectId);
      const scheduledAt = task.nextRunAt ?? now;
      /** 无项目定时触发必须先建立回执外键所需的托管工作区。 */
      const projectId = projectIds[0] ?? options.ensureTemporaryWorkspace(`schedule:${task.id}:${scheduledAt}`).id;
      options.runs.enqueue({
        automationId: task.id,
        projectIds,
        projectId,
        triggerKind: task.triggerKind,
        triggerIdentity: `schedule:${scheduledAt}`,
        scheduledAt,
      });
      options.tasks.setNextRun(task.id, nextRunAt, now);
    }
  }

  /** 启动只对账既有身份，旧部分成功不能静默补派。 */
  function recoverInterruptedDispatches(): void {
    for (const legacy of options.runs.listUntrackedActionRuns()) {
      /** 旧引用从真实业务归属重建，无法证明全部目标时暂停核对。 */
      const run = options.runs.ensureDispatchTargets(legacy.id);
      if (!run.dispatchCompletedAt) options.runs.recordIncompleteReconciliation(run.id, '旧运行没有全部冻结目标的接纳证据，请核对已执行范围后继续剩余项目。');
    }
    for (const run of options.runs.listInFlight()) {
      if (run.status !== 'dispatching') continue;
      /** 员工动作在后续逐目标派发中先对账 accepting，不依赖引用数量。 */
      if (options.tasks.getRevision(run.automationRevisionId)?.snapshot.action.kind !== 'conversation') continue;
      const accepted = options.runs.findAcceptedSubmission(run);
      if (accepted) options.runs.markRunning(run.id, accepted.conversationId, accepted.submissionId);
      else markOutcomeUnknown(run, '进程在提交期间退出，尚未找到接收回执。请检查会话后再恢复自动化。');
    }
  }

  function markOutcomeUnknown(run: AutomationRunRecord, message: string): void {
    // 结果未知时暂停后续调度，避免旧操作仍在执行而新队列继续产生副作用。
    options.tasks.setStatus(run.automationId, 'paused');
    options.runs.setTerminal(run.id, 'outcome_unknown', 'ZEUS_AUTOMATION_DISPATCH_OUTCOME_UNKNOWN', message);
    options.publish('automation.run.terminal', { automationId: run.automationId, runId: run.id, projectId: run.projectId, status: 'outcome_unknown', unread: true });
  }

  function reconcileRunning(): void {
    for (const run of options.runs.listInFlight()) {
      if (run.status === 'running' && run.dispatchTargets.length > 0 && !run.dispatchCompletedAt) {
        options.runs.recordIncompleteReconciliation(run.id, '运行仍有目标没有明确接纳结果，不能结算整体成功。');
        continue;
      }
      if (run.status === 'running' && run.dispatchCompletedAt && run.executionReferences.length === 0) {
        settle(run, 'blocked', 'ZEUS_AUTOMATION_NO_ELIGIBLE_TASK', '全部目标均无可领取任务，本次没有执行工作。');
        continue;
      }
      if ((run.status === 'running' || run.status === 'awaiting_review') && run.executionReferences.length > 0) {
        const states = run.executionReferences.map((reference) => options.readExecution?.(reference));
        if (states.some((state) => !state)) {
          markOutcomeUnknown(run, '运行关联的工作或流程已不可用，请核对实际交付记录。');
          continue;
        }
        if (states.some((state) => state?.status === 'running')) continue;
        if (states.some((state) => state?.status === 'outcome_unknown')) {
          markOutcomeUnknown(run, '关联执行的结果未知，自动化不会重新派发。');
          continue;
        }
        /** 多目标运行保留真实失败，其他目标的用户取消不能掩盖失败原因。 */
        const failed = states.find((state) => state?.status === 'failed');
        /** 全部执行均已停止后，准确保留用户取消结果，同时释放下一次独立触发。 */
        const cancelled = states.find((state) => state?.status === 'cancelled');
        if (failed) settle(run, 'failed', failed.errorCode ?? 'ZEUS_AUTOMATION_EXECUTION_FAILED', failed.errorMessage ?? '关联工作或流程未完成。');
        else if (cancelled) settle(run, 'cancelled', cancelled.errorCode ?? 'ZEUS_AUTOMATION_EXECUTION_CANCELLED', cancelled.errorMessage ?? '关联工作或流程已取消。');
        else if (states.some((state) => state?.status === 'awaiting_review')) {
          /** 全部工作停止执行后，独立员工工作可排下一轮；项目流程继续等待验收。 */
          const updated = options.runs.markAwaitingReview(run.id);
          if (updated.status !== run.status) options.publish('automation.run.awaiting_review', { automationId: run.automationId, runId: run.id, unread: true });
        } else settle(run, 'succeeded');
        continue;
      }
      if (run.status !== 'running' || !run.conversationId) continue;
      const conversation = options.conversations.getById(run.conversationId);
      if (!conversation) {
        markOutcomeUnknown(run, '运行关联的会话已不可用，请检查实际执行结果后再恢复自动化。');
        continue;
      }
      const submission = run.submissionId ? options.submissions.getById(run.submissionId) : undefined;
      if (!submission) {
        markOutcomeUnknown(run, '运行关联的提交已不可用，请检查实际执行结果后再恢复自动化。');
        continue;
      }
      // 原会话可能同时存在其他轮次，不能用整条会话的完成态替代本次提交结果。
      if (submission.status === 'completed' || submission.status === 'resolved') settle(run, 'succeeded');
      else if (submission.status === 'failed') settle(run, 'failed', 'ZEUS_AUTOMATION_DISPATCH_PROVIDER_FAILED', '模型运行失败。');
      else if (['cancelled', 'deleted', 'paused'].includes(submission.status) || (submission.status === 'active' && interactionConversationStages.has(conversation.stage))) {
        settle(run, 'blocked', 'ZEUS_AUTOMATION_DISPATCH_INTERACTION_REQUIRED', '自动化运行需要用户处理审批、问题或恢复边界。');
      }
    }
  }

  /** 耐久记录准确终态，再发布收件箱变化并由仓储释放串行队列。 */
  function settle(run: AutomationRunRecord, status: 'succeeded' | 'failed' | 'blocked' | 'cancelled', errorCode: string | null = null, errorMessage: string | null = null): void {
    const updated = options.runs.setTerminal(run.id, status, errorCode, errorMessage);
    options.publish('automation.run.terminal', { automationId: updated.automationId, runId: updated.id, projectId: updated.projectId, status: updated.status, unread: true });
  }

  /** 同一原运行逐目标接纳，首目标的引用不会改变整条派发状态。 */
  async function dispatch(candidate: AutomationRunRecord): Promise<void> {
    /** 新候选正常领取，恢复中的原派发沿用原尝试身份。 */
    const running = candidate.status === 'dispatching' ? options.runs.getById(candidate.id) : options.runs.markDispatching(candidate.id);
    if (!running || options.tasks.getById(running.automationId)?.status !== 'active') return;
    /** 只读取运行冻结修订，当前编辑不会影响剩余目标。 */
    const revision = options.tasks.getRevision(running.automationRevisionId);
    if (!revision) {
      options.runs.setTerminal(running.id, 'blocked', 'ZEUS_AUTOMATION_CONFIG_TARGET_UNAVAILABLE', '运行修订已不可用。');
      return;
    }
    /** 身份迁移后旧运行不借用当前规则映射；原接纳工作终结后才释放串行占位。 */
    const migratedTarget = running.dispatchTargets.find((target) => target.reason?.startsWith('ZEUS_AUTOMATION_EMPLOYEE_IDENTITY_MIGRATED:'));
    if (migratedTarget) {
      for (const target of running.dispatchTargets.filter((entry) => entry.status === 'accepting')) {
        /** 迁移时未知的外部接纳必须先核对，不能因暂缺运行引用就结束占位。 */
        try {
          const accepted = options.runs.findAcceptedExecution(target);
          options.runs.updateDispatchTarget(running.id, { ...target, status: accepted ? 'accepted' : accepted === false ? 'skipped' : 'pending', reference: accepted || null, reason: accepted ? null : target.reason });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('ZEUS_AUTOMATION_DISPATCH_OUTCOME_UNKNOWN:')) throw error;
          options.tasks.setStatus(running.automationId, 'paused');
          await options.save();
          return;
        }
      }
      /** 全部目标已有真实结果时回到正常执行结算，不把已完成接纳误报为迁移阻塞。 */
      const reconciled = options.runs.getById(running.id)!;
      if (reconciled.dispatchTargets.every((target) => target.status === 'accepted' || target.status === 'skipped')) {
        options.runs.completeDispatch(running.id);
        await options.save();
        return;
      }
      if (
        reconciled.executionReferences.some((reference) => {
          const state = options.readExecution?.(reference);
          return !state || state.status === 'running' || state.status === 'outcome_unknown';
        })
      )
        return;
      options.runs.setTerminal(running.id, 'blocked', 'ZEUS_AUTOMATION_EMPLOYEE_IDENTITY_MIGRATED', migratedTarget.reason);
      await options.save();
      return;
    }
    if (revision.snapshot.action.kind !== 'conversation') {
      /** 完整范围先持久化，即使首目标尚未接纳也可以恢复。 */
      options.runs.ensureDispatchTargets(running.id);
      await options.save();
      for (const frozen of options.runs.getById(running.id)!.dispatchTargets) {
        /** 每个目标重新核对人工控制，等待保存期间取消或暂停后不得继续接纳。 */
        if (options.runs.getById(running.id)?.status !== 'dispatching' || options.tasks.getById(running.automationId)?.status !== 'active') return;
        if (frozen.status === 'accepted' || frozen.status === 'skipped') continue;
        /** 操作中的目标保留准确任务和绑定，异常时据此对账。 */
        let target = frozen;
        try {
          if (target.status === 'accepting') {
            /** 未收到回执也可能已经接纳，先查现有业务账本。 */
            const accepted = options.runs.findAcceptedExecution(target);
            if (accepted === false) {
              options.runs.updateDispatchTarget(running.id, { ...target, status: 'skipped', reason: '原工作安排没有可领取分工。' });
              await options.save();
              continue;
            }
            if (accepted) {
              options.runs.updateDispatchTarget(running.id, { ...target, status: 'accepted', reference: accepted, reason: null });
              await options.save();
              continue;
            }
          }
          if (revision.snapshot.action.kind === 'project_task' && !revision.snapshot.action.taskFilter) throw new Error('ZEUS_AUTOMATION_MIGRATION_REVIEW_REQUIRED: 原运行未冻结任务筛选，请核对规则后重新运行。');
          /** 手动、定时、事件和恢复都在准备新目标前核对实际用量。 */
          options.runs.assertDailyTokenBudget(running.automationId, options.now());
          assertFullAccessGrant(running, revision);
          /** 缺失项目明确阻塞，已有目标引用不被清空。 */
          const project = options.getProject(target.projectId) ?? (running.projectIds.length === 0 ? options.ensureTemporaryWorkspace(running.id) : undefined);
          if (!project) throw new Error('ZEUS_AUTOMATION_CONFIG_TARGET_UNAVAILABLE: 目标项目已不可用。');
          /** 多项目领取按各自原状态语义核对，不能共享合并后的筛选列表。 */
          const snapshot = snapshotForProject(revision, project.id);
          if (!options.prepareAction || !options.dispatchAction) throw new Error('ZEUS_AUTOMATION_ACTION_UNAVAILABLE: 员工工作入口不可用。');
          if (!target.taskId || !target.employeeId) {
            /** 尚未接纳的目标只解析一次，跳过也须耐久记账。 */
            const prepared = await options.prepareAction({ run: options.runs.getById(running.id)!, snapshot, project, target });
            if (!prepared) {
              options.runs.updateDispatchTarget(running.id, { ...target, status: 'skipped', reason: '没有符合条件且可领取的任务。' });
              await options.save();
              continue;
            }
            target = { ...target, ...prepared };
          }
          target = { ...target, status: 'accepting', reason: null };
          options.runs.updateDispatchTarget(running.id, target);
          await options.save();
          /** 保存可能让出控制权，业务接纳前最后核对暂停或取消。 */
          if (options.runs.getById(running.id)?.status !== 'dispatching' || options.tasks.getById(running.automationId)?.status !== 'active') return;
          /** 保存期间可能收到新的用量回执，不能沿用准备前的额度判断。 */
          options.runs.assertDailyTokenBudget(running.automationId, options.now());
          assertFullAccessGrant(running, revision);
          /** 接纳后保存该目标引用，仍保持 dispatching 直到全部目标完成。 */
          const reference = await options.dispatchAction({ run: options.runs.getById(running.id)!, snapshot, project, target });
          options.runs.updateDispatchTarget(running.id, { ...target, status: reference ? 'accepted' : 'skipped', reference, reason: reference ? null : '原工作安排没有可领取分工。' });
          await options.save();
        } catch (error) {
          /** 正式账本能证明接纳时保存原引用，不能重派。 */
          try {
            const accepted = target.status === 'accepting' ? options.runs.findAcceptedExecution(target) : null;
            if (accepted === false) {
              options.runs.updateDispatchTarget(running.id, { ...target, status: 'skipped', reason: '原工作安排没有可领取分工。' });
              await options.save();
              continue;
            }
            if (accepted) {
              options.runs.updateDispatchTarget(running.id, { ...target, status: 'accepted', reference: accepted, reason: null });
              await options.save();
              continue;
            }
            /** 未发生业务接纳的目标保留准确失败原因，人工恢复仍沿冻结范围。 */
            options.runs.updateDispatchTarget(running.id, { ...target, status: 'pending', reason: error instanceof Error ? error.message : String(error) });
            /** 部分接纳遇到日额度耗尽时保留原占位并等待下一自然日，其他错误仍需人工恢复。 */
            if (options.runs.getById(running.id)?.executionReferences.length) {
              if (errorCode(error) !== 'ZEUS_AUTOMATION_BUDGET_TOKENS_EXHAUSTED') options.tasks.setStatus(running.automationId, 'paused');
            } else options.runs.setTerminal(running.id, 'blocked', errorCode(error), error instanceof Error ? error.message : String(error));
          } catch (reconciliationError) {
            /** 接纳事实待核对时同样保留原占位和身份，不能放行后继运行。 */
            options.tasks.setStatus(running.automationId, 'paused');
            /** 使用当前目标事实，避免把已记账的引用覆盖为未接纳。 */
            const currentTarget = options.runs.getById(running.id)?.dispatchTargets.find((entry) => entry.projectId === target.projectId);
            if (currentTarget) options.runs.updateDispatchTarget(running.id, { ...currentTarget, reason: reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError) });
          }
          await options.save();
          return;
        }
      }
      /** 所有目标均明确处理后，才能等待全部真实执行终态。 */
      const updated = options.runs.completeDispatch(running.id);
      await options.save();
      options.publish('automation.run.started', { automationId: updated.automationId, runId: updated.id, executionReferences: updated.executionReferences, dispatchTargets: updated.dispatchTargets });
      return;
    }
    /** 普通会话仅恢复已有接纳回执，不再触发新会话。 */
    const accepted = options.runs.findAcceptedSubmission(running);
    if (accepted) options.runs.markRunning(running.id, accepted.conversationId, accepted.submissionId);
    else options.runs.setTerminal(running.id, 'blocked', 'ZEUS_AUTOMATION_MIGRATION_REVIEW_REQUIRED', '普通会话自动化已停止，请选择数字员工或项目流程并重新运行。');
  }

  /** 逐次接纳核对冻结修订授权，撤销与配置变化立即阻止尚未派发的目标。 */
  function assertFullAccessGrant(run: AutomationRunRecord, revision: AutomationRevisionRecord): void {
    if (revision.snapshot.permissionMode === 'full-access' && !options.tasks.hasFullAccessGrant(run.automationId, revision.revision)) {
      throw new Error('ZEUS_AUTOMATION_PERMISSION_GRANT_REQUIRED: 原运行修订的完全访问授权已失效，请保存并授权新修订后重新运行。');
    }
  }

  function kick(): void {
    if (closed || tickPromise) return;
    tickPromise = tick()
      .catch((error) => options.publish('automation.scheduler.failed', { message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        tickPromise = null;
      });
  }

  timer = setInterval(kick, 10_000);
  timer.unref?.();
  kick();

  return {
    kick,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await tickPromise;
    },
  };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\b(ZEUS_[A-Z0-9_]+)\b/u.exec(message);
  return match?.[1] ?? 'ZEUS_AUTOMATION_DISPATCH_FAILED';
}

/** 返回严格晚于查询时刻的计划时间；规则已结束时返回空值。 */
export function computeNextRun(task: AutomationTaskRecord, from: Date): string | null {
  if (task.triggerKind === 'manual' || task.triggerKind === 'event') return null;
  if (task.triggerKind === 'once') {
    const at = task.triggerConfig.at ? new Date(task.triggerConfig.at) : null;
    return at && Number.isFinite(at.getTime()) && at > from ? at.toISOString() : null;
  }
  if (task.triggerKind === 'interval') {
    const minutes = Number(task.triggerConfig.everyMinutes ?? 60);
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error('ZEUS_AUTOMATION_CONFIG_INTERVAL_INVALID: 间隔必须至少一分钟。');
    return new Date(from.getTime() + Math.trunc(minutes) * 60_000).toISOString();
  }
  if (task.triggerKind === 'rrule') return nextRrule(task, from);
  const parts = localParts(from, task.timezone);
  const [hour, minute] = parseLocalTime(task.triggerConfig.localTime ?? '09:00');
  if (task.triggerKind === 'daily' || task.triggerKind === 'weekly') {
    const allowed = task.triggerKind === 'weekly' ? new Set(task.triggerConfig.weekdays ?? [1]) : null;
    for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
      const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, hour, minute));
      if (allowed && !allowed.has(localDate.getUTCDay())) continue;
      const candidate = zonedLocalToUtc(localDate, task.timezone);
      if (candidate > from) return candidate.toISOString();
    }
    return null;
  }
  return null;
}

/** 已校验的规则只包含当前排程支持的字段，时间上限为包含边界的 UTC 毫秒。 */
interface ParsedAutomationRrule {
  /** 重复周期的单位。 */
  frequency: 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY';
  /** 相邻活动周期之间的单位数，至少为一。 */
  interval: number;
  /** 日周规则的本地小时列表，按升序排列。 */
  hours: number[];
  /** 日周规则的本地分钟列表，按升序排列。 */
  minutes: number[];
  /** 星期筛选，零表示星期日；空值表示采用对应频率的默认规则。 */
  weekdays: number[] | null;
  /** 每周起始星期，默认星期一。 */
  weekStart: number;
  /** 截止时刻，单位为 UTC 毫秒；空值表示没有截止时间。 */
  until: number | null;
}

/** RRULE 星期缩写与 JavaScript 星期编号的对应关系。 */
const rruleWeekdays = new Map<string, number>([
  ['SU', 0],
  ['MO', 1],
  ['TU', 2],
  ['WE', 3],
  ['TH', 4],
  ['FR', 5],
  ['SA', 6],
]);
/** 当前可完整解释的字段；其余字段必须明确拒绝。 */
const rruleFields = new Set(['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE', 'BYDAY', 'WKST', 'UNTIL']);
/** 日历日期用 UTC 表示以计算天数，避免把夏令时的一天当成固定实时时长。 */
const calendarDayMilliseconds = 86_400_000;
/** RRULE 四位年份所能表示的最后一个日历日期。 */
const lastRruleCalendarDay = Date.UTC(9999, 11, 31);

/** 解析整数列表，不截断非法尾部，也不把越界时间滚动到其他日期。 */
function parseRruleNumbers(value: string, field: string, maximum: number): number[] {
  /** 每个列表项都必须是完整十进制非负整数。 */
  const numbers = value.split(',').map((entry) => {
    /** 转换后仍需核对原文，防止空串或科学计数法被接受。 */
    const number = Number(entry);
    if (!/^\d+$/u.test(entry) || !Number.isInteger(number) || number < 0 || number > maximum) throw new Error(`ZEUS_AUTOMATION_CONFIG_RRULE_INVALID: ${field} 必须是 0 至 ${maximum} 的整数列表。`);
    return number;
  });
  return [...new Set(numbers)].sort((left, right) => left - right);
}

/** 带 IANA 时区的计划仅接收 UTC 截止时刻，防止宿主时区改变边界。 */
function parseRruleUntil(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d{8}T\d{6}Z$/u.test(value)) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_UNTIL_INVALID: UNTIL 必须为 YYYYMMDDTHHMMSSZ 格式的 UTC 时间。');
  /** 显式 UTC 格式供日期解析，随后回写比对以拒绝不存在的日期。 */
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
  /** 截止时刻，单位为 UTC 毫秒。 */
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== iso) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_UNTIL_INVALID: UNTIL 必须是有效的 UTC 日期和时间。');
  return timestamp;
}

/** 统一校验规则语法和支持范围，禁止默默忽略未知或重复字段。 */
function parseAutomationRrule(value: string | undefined): ParsedAutomationRrule {
  if (typeof value !== 'string' || !value.trim()) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_REQUIRED: 高级调度必须提供 RRULE。');
  /** 可选前缀不参与规则字段解析。 */
  const source = value.trim().replace(/^RRULE:/iu, '');
  /** 字段名统一为大写，映射保留重复检查所需的存在性。 */
  const values = new Map<string, string>();
  // 每段必须恰好包含一个非空字段和值。
  for (const part of source.split(';')) {
    /** 字段允许等号两侧空白，不允许多行日历内容。 */
    const match = /^([A-Z]+)\s*=\s*([^=\s]+)$/u.exec(part.trim().toUpperCase());
    if (!match) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_INVALID: RRULE 必须由分号分隔的字段和值组成。');
    /** 当前字段身份和值。 */
    const [, key, entry] = match;
    if (!rruleFields.has(key)) throw new Error(`ZEUS_AUTOMATION_CONFIG_RRULE_UNSUPPORTED: 不支持 RRULE 字段 ${key}。`);
    if (values.has(key)) throw new Error(`ZEUS_AUTOMATION_CONFIG_RRULE_INVALID: RRULE 字段 ${key} 不能重复。`);
    values.set(key, entry);
  }
  /** 当前只支持四种既有重复单位。 */
  const frequency = values.get('FREQ');
  if (frequency !== 'MINUTELY' && frequency !== 'HOURLY' && frequency !== 'DAILY' && frequency !== 'WEEKLY') throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_UNSUPPORTED: 当前支持 MINUTELY、HOURLY、DAILY 和 WEEKLY。');
  /** INTERVAL 沿用 RFC 整数上限，不截断小数或非法尾部。 */
  const intervalSource = values.get('INTERVAL') ?? '1';
  /** 相邻活动周期的单位数。 */
  const interval = Number(intervalSource);
  if (!/^\d+$/u.test(intervalSource) || !Number.isInteger(interval) || interval < 1 || interval > 2_147_483_647) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_INVALID: INTERVAL 必须是 1 至 2147483647 的整数。');
  if ((frequency === 'MINUTELY' || frequency === 'HOURLY') && ['BYHOUR', 'BYMINUTE', 'BYDAY', 'WKST'].some((field) => values.has(field)))
    throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_UNSUPPORTED: 分钟和小时规则仅支持 FREQ、INTERVAL、UNTIL。');
  if (frequency !== 'WEEKLY' && values.has('WKST')) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_UNSUPPORTED: WKST 仅用于每周规则。');
  /** 星期列表中任一无效项都会拒绝整条规则。 */
  const weekdays = values.has('BYDAY')
    ? values
        .get('BYDAY')!
        .split(',')
        .map((day) => {
          /** 已登记的星期编号，零也是有效值。 */
          const weekday = rruleWeekdays.get(day);
          if (weekday === undefined) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_INVALID: BYDAY 必须是 MO、TU、WE、TH、FR、SA、SU 的列表。');
          return weekday;
        })
    : null;
  /** 默认以星期一划分活动周。 */
  const weekStart = rruleWeekdays.get(values.get('WKST') ?? 'MO');
  if (weekStart === undefined) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_INVALID: WKST 必须是有效的星期缩写。');
  return {
    frequency,
    interval,
    hours: parseRruleNumbers(values.get('BYHOUR') ?? '9', 'BYHOUR', 23),
    minutes: parseRruleNumbers(values.get('BYMINUTE') ?? '0', 'BYMINUTE', 59),
    weekdays,
    weekStart,
    until: parseRruleUntil(values.get('UNTIL')),
  };
}

/** 用不可变的创建时间确定周期相位，查询时刻只限定搜索下界。 */
function nextRrule(task: AutomationTaskRecord, from: Date): string | null {
  /** 先校验完整规则，即使已截止也不能掩盖错误配置。 */
  const rule = parseAutomationRrule(task.triggerConfig.rrule);
  /** RRULE 以秒为时间精度，创建时间的小数毫秒不参与周期。 */
  const anchor = new Date(Math.floor(Date.parse(task.createdAt) / 1000) * 1000);
  if (!Number.isFinite(anchor.getTime()) || !Number.isFinite(from.getTime())) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_ANCHOR_INVALID: 周期基点和查询时间必须有效。');
  if (rule.until !== null && from.getTime() >= rule.until) return null;
  if (rule.frequency === 'MINUTELY' || rule.frequency === 'HOURLY') {
    /** 高频规则按实际经过时长推进，单位为毫秒。 */
    const duration = rule.interval * (rule.frequency === 'MINUTELY' ? 60_000 : 3_600_000);
    /** 直接跳到查询时刻之后的周期，避免枚举历史发生次数。 */
    const step = Math.max(0, Math.floor((from.getTime() - anchor.getTime()) / duration) + 1);
    /** 与创建基点对齐的下一次绝对时刻。 */
    const candidate = new Date(anchor.getTime() + step * duration);
    return Number.isFinite(candidate.getTime()) && candidate.getUTCFullYear() <= 9999 && (rule.until === null || candidate.getTime() <= rule.until) ? candidate.toISOString() : null;
  }
  /** 周期基点在规则时区中的日期。 */
  const anchorParts = localParts(anchor, task.timezone);
  /** 查询下界在同一时区中的日期。 */
  const fromParts = localParts(from, task.timezone);
  /** 本地日历日期以 UTC 零点编码，单位为毫秒。 */
  const anchorDay = Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day);
  /** 搜索开始日期，不用真实经过的毫秒数推断跨日。 */
  const fromDay = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day);
  /** 周规则未给定 BYDAY 时沿用创建日期的星期。 */
  const anchorWeekday = new Date(anchorDay).getUTCDay();
  /** 当前周期是否以自然周划分。 */
  const weekly = rule.frequency === 'WEEKLY';
  /** 周期第一天的本地日历日期。 */
  const firstPeriod = weekly ? anchorDay - ((anchorWeekday - rule.weekStart + 7) % 7) * calendarDayMilliseconds : anchorDay;
  /** 相邻活动周期的日历跨度，单位为毫秒。 */
  const period = rule.interval * (weekly ? 7 : 1) * calendarDayMilliseconds;
  /** 周内候选日按 WKST 排序，日规则每个周期只有起始日。 */
  const dayOffsets = weekly ? [...new Set((rule.weekdays ?? [anchorWeekday]).map((weekday) => (weekday - rule.weekStart + 7) % 7))].sort((left, right) => left - right) : [0];
  // 日周期的星期相位最多七次重复即可遍历，提前排除永远不匹配的组合。
  if (!weekly && rule.weekdays && !Array.from({ length: 7 }, (_, index) => (anchorWeekday + index * (rule.interval % 7)) % 7).some((weekday) => rule.weekdays!.includes(weekday))) return null;
  /** 截止日期也按规则时区限定搜索，避免无结果时继续扫描。 */
  const untilParts = rule.until === null ? null : localParts(new Date(rule.until), task.timezone);
  /** 四位年份和可选截止日期共同限定最后搜索日。 */
  const lastDay = untilParts ? Math.min(lastRruleCalendarDay, Date.UTC(untilParts.year, untilParts.month - 1, untilParts.day)) : lastRruleCalendarDay;
  // 直接定位查询所在周期；超出日期范围即结束，不使用任意天数的搜索截断。
  for (let periodStart = firstPeriod + Math.max(0, Math.floor((fromDay - firstPeriod) / period)) * period; periodStart <= lastDay; periodStart += period) {
    // 每个活动周期只检查允许的星期。
    for (const dayOffset of dayOffsets) {
      /** 候选日历日期，尚未转换为绝对时刻。 */
      const day = new Date(periodStart + dayOffset * calendarDayMilliseconds);
      if (day.getTime() < fromDay || day.getTime() > lastDay || (!weekly && rule.weekdays && !rule.weekdays.includes(day.getUTCDay()))) continue;
      // 小时和分钟都已排序，首个有效结果就是该日最早的下一次时间。
      for (const hour of rule.hours) {
        for (const minute of rule.minutes) {
          /** 本地钟表时间暂用 UTC 字段承载。 */
          const local = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute));
          /** 规则时区中的候选绝对时刻。 */
          const candidate = zonedLocalToUtc(local, task.timezone);
          /** 回读本地钟表时间，跳过夏令时跳跃中不存在的时刻。 */
          const actual = localParts(candidate, task.timezone);
          if (Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute) !== local.getTime()) continue;
          if (candidate < anchor || candidate <= from) continue;
          if (rule.until !== null && candidate.getTime() > rule.until) return null;
          return candidate.toISOString();
        }
      }
    }
  }
  return null;
}

function parseLocalTime(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('ZEUS_AUTOMATION_CONFIG_LOCAL_TIME_INVALID: 时间必须为 HH:mm。');
  return [hour, minute];
}

/** 读取规则时区的日历与钟表字段，小时固定使用 00 至 23。 */
function localParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  /** 显式时区避免依赖 macOS 或 Windows 的系统默认时区。 */
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  /** 格式片段按名称读取，不依赖平台的日期排列顺序。 */
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

function zonedLocalToUtc(local: Date, timeZone: string): Date {
  let candidate = new Date(local.getTime());
  for (let index = 0; index < 3; index += 1) {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    candidate = new Date(candidate.getTime() + (local.getTime() - represented));
  }
  return candidate;
}
