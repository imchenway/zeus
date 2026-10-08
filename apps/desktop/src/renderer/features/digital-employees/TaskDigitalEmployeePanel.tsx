import { MotionPresence } from '../../ui/MotionPresence.js';
import { VisibleApplicationError, modelSetupRequestedEvent } from '../../ui/ApplicationErrorDialog.js';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { NativeConversationChoice, CodexTaskPushCapabilities, TaskPushSupplementalAttachmentDraft } from '../../session/sessionTypes.js';
import { useConversationInputResources } from '../../session/useConversationInputResources.js';
import { mergeTaskPushSupplementalAttachments, taskPushEnvironmentLabel, taskPushSupplementalAttachmentIdentity, taskPushSupplementalRequestAttachments } from '../../task/TaskModelPushModal.js';
import { TaskPushSupplementalAttachmentCards } from '../../task/TaskPushSupplementalAttachmentCards.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { CommandRunDetail } from '../runtime/runtimeContracts.js';
import type { DigitalEmployeeRecord, TaskWorkConversationRequestRecord, TaskWorkDecisionRecord, TaskWorkDeliverableRecord, TaskWorkItemRecord, TaskWorkManagementProjection, TaskWorkPreview } from './digitalEmployeeContracts.js';
import { errorMessage, formatDateTime, templateDraft, type DigitalEmployeeLanguage } from './digitalEmployeeUiSupport.js';
import { codexCapabilitiesChangedEvent } from '../codex/codexApiClient.js';
import { DigitalEmployeeAvatar } from './DigitalEmployeeAvatar.js';
import { TaskConversationPane } from './TaskConversationPane.js';
import { TaskDeliverableReader, TaskDeliverableContent, readTaskDeliverableContent } from './TaskDeliverableReader.js';
import { TaskWorkReviewPanel } from './TaskWorkReviewPanel.js';
import { TaskWorkPlanPanel } from './TaskWorkPlanPanel.js';
import { digitalTeamExecutionDefinition, type DigitalTeamWorkflowTemplateRecord, type EmployeeWorkSettings } from '@zeus/shared';
import type { DigitalTeamApiClient, DigitalTeamRunProjection } from '../digital-teams/digitalTeamApiClient.js';
import type { DigitalTeamProgressSubscription } from '../digital-teams/TaskDigitalTeamProgress.js';
import { buildTaskConversationNavigation, isCurrentTaskTeam } from './taskConversationNavigation.js';
import { getDigitalTeamRunBlocker } from '../digital-teams/digitalTeamRunPresentation.js';

import { EmployeeExecutionSettings } from './EmployeeExecutionSettings.js';
import { EmployeeExecutionPreview } from './EmployeeExecutionPreview.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';

import './digitalEmployees.css';

export interface TaskDigitalEmployeePanelProps {
  /** 新协作统一进入数字团队，已有安排只保留运行与历史。 */
  onArrangeTeam?(): void;
  /** 所选团队的状态处理仍进入原流程页面。 */
  onOpenTeamRun?(runId: string): void;
  /** 当前任务会话使用原始身份，不复制消息。 */
  conversations?: NativeConversationChoice[];
  /** 会话列表读取状态。 */
  conversationsLoading?: boolean;
  /** 会话列表失败保留可见原因。 */
  conversationsError?: string | null;
  /** 当前唯一会话控制器身份。 */
  activeConversationId?: string | null;
  /** 从工作区注入原会话组件。 */
  conversationWorkspace?: ReactNode;
  /** 首次讨论复用原新建会话输入与耐久接纳。 */
  newConversationWorkspace?: ReactNode;
  /** 内嵌选择不会离开任务详情。 */
  onSelectConversation?(conversationId: string): Promise<void>;
  /** 重读会话列表的真实操作。 */
  onReloadConversations?(): void;
  taskId: string;
  projectId: string;
  terminalReadOnly: boolean;
  client: DigitalEmployeeApiClient | null;
  management: TaskDigitalEmployeeManagement;
  language: DigitalEmployeeLanguage;
  onOpenConversation?: (conversationId: string) => void;
}

export interface TaskDigitalEmployeeManagement {
  /** 按原始执行身份读取的团队历史。 */
  teams: DigitalTeamRunProjection[];
  /** 团队名称目录。 */
  teamTemplates: DigitalTeamWorkflowTemplateRecord[];
  /** 接纳后等待真实会话，不能把接纳回执当成启动完成。 */
  pendingAssignment: { employeeId: string; workflowRunId?: string; workRunId?: string; previousAttempts: string[]; reason?: string } | null;
  /** 交接成功后要求打开的原会话。 */
  conversationRequest: { conversationId: string } | null;
  /** 跟随本次接纳的准确运行，不使用最近会话猜测结果。 */
  followAssignment(employeeId: string, result: { workflowRunId: string } | { run: { id: string } }): void;
  employees: DigitalEmployeeRecord[];
  /** 正式全局员工可直接指派，项目绑定由实际接纳透明建立。 */
  assignableEmployees: DigitalEmployeeRecord[];
  projection: TaskWorkManagementProjection | null;
  loadState: 'loading' | 'ready' | 'failed';
  busy: string | null;
  error: string | null;
  /** 仅清除指定已结束操作的提示，不隐藏读取或其他操作错误。 */
  dismissOperationError(identity: string): void;
  load(): Promise<void>;
  act(identity: string, operation: () => Promise<unknown>): Promise<boolean>;
}

export function useTaskDigitalEmployeeManagement(
  props: Pick<TaskDigitalEmployeePanelProps, 'taskId' | 'projectId' | 'client' | 'language'> & {
    /** 任务详情读取一次团队历史，执行人和导航共用。 */
    teamClient?: Pick<DigitalTeamApiClient, 'loadDigitalTeamRuns' | 'loadDigitalTeamRun' | 'loadDigitalTeamTemplates'> | null;
    /** 团队与工作事件触发对账，历史阅读目标仍由导航保存。 */
    subscribe?: DigitalTeamProgressSubscription;
  },
): TaskDigitalEmployeeManagement {
  const zh = props.language === 'zh-CN';
  /** 历史终态缓存按修订复用，活动运行每次读取当前节点。 */
  const teamCache = useRef(new Map<string, DigitalTeamRunProjection>());
  /** 运行列表与员工工作一起刷新，避免两套状态相互覆盖。 */
  const [teams, setTeams] = useState<DigitalTeamRunProjection[]>([]);
  /** 模板名称只补充显示，不参与历史身份关联。 */
  const [teamTemplates, setTeamTemplates] = useState<DigitalTeamWorkflowTemplateRecord[]>([]);
  /** 接纳回执仅用于等待对应真实会话。 */
  const [pendingAssignment, setPendingAssignment] = useState<TaskDigitalEmployeeManagement['pendingAssignment']>(null);
  /** 每次成功交接有新的定位请求，即使目标复用了主会话。 */
  const [conversationRequest, setConversationRequest] = useState<TaskDigitalEmployeeManagement['conversationRequest']>(null);
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  /** 目录包含已有正式全局员工，内置模板本身不是执行人。 */
  const [assignableEmployees, setAssignableEmployees] = useState<DigitalEmployeeRecord[]>([]);
  const [projection, setProjection] = useState<TaskWorkManagementProjection | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 错误来源随回执记录，草稿关闭不能误清除其他故障。 */
  const errorOperation = useRef<string | null>(null);
  /** 新读取与任务切换使旧返回失效。 */
  const readGeneration = useRef(0);
  /** 已显示的内容不因轮询闪回加载态。 */
  const hasLoaded = useRef(false);
  /** 同步保护快速双击，避免重复写入。 */
  const actionInFlight = useRef(false);

  const load = useCallback(async () => {
    if (!props.client) return;
    /** 每次读取拥有独立代次。 */
    const generation = ++readGeneration.current;
    if (!hasLoaded.current) setLoadState('loading');
    try {
      const [nextEmployees, nextAssignableEmployees, nextProjection, teamRecords, templates] = await Promise.all([
        props.client.loadProjectDigitalEmployees(props.projectId),
        props.client.loadProjectDigitalEmployees(props.projectId, true),
        props.client.loadTaskWorkManagement(props.taskId),
        props.teamClient?.loadDigitalTeamRuns(props.projectId, props.taskId) ?? [],
        props.teamClient?.loadDigitalTeamTemplates() ?? [],
      ]);
      /** 旧读取不继续派生额外请求。 */
      if (generation !== readGeneration.current) return;
      /** 每批至多四个历史读取，避免长任务一次占满本地连接。 */
      const nextTeams: DigitalTeamRunProjection[] = [];
      for (let offset = 0; offset < teamRecords.length; offset += 4) {
        const batch = await Promise.all(
          teamRecords.slice(offset, offset + 4).map(async (record) => {
            if (record.taskId !== props.taskId || record.projectId !== props.projectId) throw new Error(zh ? '团队记录不属于当前任务。' : 'Team record belongs to another task.');
            /** 已终结且修订一致的历史不会每三秒重读。 */
            const cached = teamCache.current.get(record.id);
            const team = cached && !isCurrentTaskTeam(cached) && cached.run.revision === record.revision ? cached : await props.teamClient!.loadDigitalTeamRun(record.id);
            if (team.run.id !== record.id || team.run.taskId !== props.taskId || team.run.projectId !== props.projectId) throw new Error(zh ? '团队详情身份不匹配。' : 'Team identity mismatch.');
            return team;
          }),
        );
        if (generation !== readGeneration.current) return;
        nextTeams.push(...batch);
      }
      if (generation !== readGeneration.current) return;
      nextTeams.sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt) || b.run.id.localeCompare(a.run.id));
      teamCache.current = new Map(nextTeams.map((team) => [team.run.id, team]));
      setTeams(nextTeams);
      setTeamTemplates(templates);
      hasLoaded.current = true;
      setEmployees(nextEmployees);
      setAssignableEmployees(nextAssignableEmployees);
      setProjection(nextProjection);
      /** 普通轮询不能把刚发生的交接失败提示清掉。 */
      if (errorOperation.current === null) setError(null);
      setLoadState('ready');
    } catch (cause) {
      if (generation !== readGeneration.current) return;
      setLoadState('failed');
      errorOperation.current = null;
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    }
  }, [props.client, props.teamClient, props.projectId, props.taskId, zh]);

  useEffect(() => {
    hasLoaded.current = false;
    setProjection(null);
    setEmployees([]);
    setAssignableEmployees([]);
    teamCache.current.clear();
    setTeams([]);
    setTeamTemplates([]);
    setPendingAssignment(null);
    setConversationRequest(null);
    errorOperation.current = null;
    setError(null);
    void load();
    return () => {
      readGeneration.current += 1;
    };
  }, [load]);
  /** 新团队可以在详情保持打开时由其他入口接纳，不能只依靠已有活动工作的轮询。 */
  useEffect(() => {
    const dispose = props.subscribe?.(
      (event) => {
        if ((event.type.startsWith('digital_team.') || event.type === 'task.work_management.changed') && event.payload.taskId === props.taskId) void load();
      },
      (state) => {
        if (state === 'connected') void load();
      },
    );
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  }, [props.subscribe, props.taskId, load]);
  const shouldPoll = Boolean(
    pendingAssignment ||
    teams.some(isCurrentTaskTeam) ||
    loadState === 'failed' ||
    projection?.summary.activeWorkItems ||
    projection?.summary.pendingActions ||
    projection?.plan?.state === 'running' ||
    projection?.workItems.some((item) => item.arrangement?.cancellationRequested && item.status !== 'cancelled'),
  );
  useEffect(() => {
    if (!shouldPoll) return;
    /** 等上一次读取完成再调度，慢网络下不积压轮询。 */
    let stopped = false;
    /** 只记录本轮定时器，卸载后不产生下一次读取。 */
    let timer: number;
    /** 刷新不重置已显示内容，失败保留原因。 */
    const poll = async () => {
      await load();
      if (!stopped) timer = window.setTimeout(() => void poll(), 3_000);
    };
    timer = window.setTimeout(() => void poll(), 3_000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [load, shouldPoll]);

  /** 窗口重开也能从服务端耐久交接恢复等待，不重复提交命令。 */
  useEffect(() => {
    if (pendingAssignment) return;
    const team = teams.find((entry) => isCurrentTaskTeam(entry) && entry.run.runtimeState.handoff && entry.run.runtimeState.handoff.status !== 'completed');
    if (team?.run.runtimeState.handoff) setPendingAssignment({ employeeId: team.run.runtimeState.handoff.employeeId, workflowRunId: team.run.id, previousAttempts: team.nodeAttempts.map((attempt) => attempt.id) });
  }, [teams, pendingAssignment]);

  /** 只有停止旧工作并产生新目标会话后才切换视图。 */
  useEffect(() => {
    if (!pendingAssignment) return;
    const team = teams.find((entry) => entry.run.id === pendingAssignment.workflowRunId);
    const handoff = team?.run.runtimeState.handoff;
    if (handoff && handoff.status !== 'completed' && team && isCurrentTaskTeam(team)) {
      /** 停止未确认时保持交接锁，同时提供可读原因，不能显示成无限加载。 */
      const reason =
        team.run.status === 'outcome_unknown'
          ? (getDigitalTeamRunBlocker(team, zh)?.reason ?? (zh ? '旧执行的停止结果尚未确认，请在团队流程中核对。' : 'The previous execution has not confirmed stopping. Review the team workflow.'))
          : undefined;
      if (pendingAssignment.reason !== reason) setPendingAssignment({ ...pendingAssignment, reason });
      return;
    }
    /** 全局目录与项目绑定使用冻结身份对齐，不把历史入口当作当前员工。 */
    const requestedRoles = team?.run.roleSnapshots.filter((role) => [role.employeeId, role.configuration.id, role.configuration.globalEmployeeId].includes(pendingAssignment.employeeId)) ?? [];
    /** 同员工可能有多个节点，以当前有效尝试定位实际会话。 */
    const targetNodeIds = new Set(
      team
        ? digitalTeamExecutionDefinition(team.run)
            .nodes.filter((node) => node.type === 'employee' && requestedRoles.some((role) => role.employeeId === node.data.employeeId))
            .map((node) => node.id)
        : [],
    );
    const attempt = team?.currentAttempts.find((entry) => targetNodeIds.has(entry.nodeId) && (!pendingAssignment.previousAttempts.includes(entry.id) || ['prepared', 'dispatching', 'active'].includes(entry.status)));
    const work = projection?.workItems.flatMap((item) => item.runs).find((run) => run.id === pendingAssignment.workRunId);
    const conversationId = attempt?.conversationId ?? work?.conversationId;
    if (conversationId) {
      setConversationRequest({ conversationId });
      setPendingAssignment(null);
    } else if (['failed', 'cancelled', 'outcome_unknown'].includes(attempt?.status ?? work?.status ?? team?.run.status ?? '')) {
      errorOperation.current = 'start-executor';
      setError(work?.errorMessage ?? (typeof attempt?.error?.message === 'string' ? attempt.error.message : zh ? '新执行尚未产生会话，请查看受阻原因。' : 'The new execution has no conversation. Review its status.'));
      setPendingAssignment(null);
    }
  }, [pendingAssignment, teams, projection, zh]);

  /** 同步记录接纳身份，后续轮询只跟随这次真实交接。 */
  const followAssignment = useCallback(
    (employeeId: string, result: { workflowRunId: string } | { run: { id: string } }) => {
      setPendingAssignment({ employeeId, ...('workflowRunId' in result ? { workflowRunId: result.workflowRunId } : { workRunId: result.run.id }), previousAttempts: teams.flatMap((team) => team.nodeAttempts.map((attempt) => attempt.id)) });
    },
    [teams],
  );

  const act = useCallback(
    async (identity: string, operation: () => Promise<unknown>): Promise<boolean> => {
      if (actionInFlight.current) return false;
      actionInFlight.current = true;
      setBusy(identity);
      errorOperation.current = null;
      setError(null);
      try {
        await operation();
        await load();
        return true;
      } catch (cause) {
        errorOperation.current = identity;
        setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
        return false;
      } finally {
        actionInFlight.current = false;
        setBusy(null);
      }
    },
    [load, zh],
  );

  /** 只处理用户明确结束的草稿操作，进行中的请求仍等待真实回执。 */
  const dismissOperationError = useCallback((identity: string) => {
    if (actionInFlight.current || errorOperation.current !== identity) return;
    errorOperation.current = null;
    setError(null);
  }, []);

  return { employees, assignableEmployees, projection, teams, teamTemplates, pendingAssignment, conversationRequest, followAssignment, loadState, busy, error, load, act, dismissOperationError };
}

type ManagementTab = 'collaboration' | 'work' | 'deliverables' | 'evidence';

/** 在任务概览与工作管理间切换，不重复堆叠两套详情。 */
export function TaskDigitalEmployeePanel(props: TaskDigitalEmployeePanelProps) {
  /** 提示跟随应用语言。 */
  const zh = props.language === 'zh-CN';
  /** 进入详情直接对照任务说明阅读沟通内容。 */
  const [tab, setTab] = useState<ManagementTab>('collaboration');
  /** 待办和工作都定位原会话身份。 */
  const [conversationRequest, setConversationRequest] = useState<{ conversationId: string } | null>(null);
  /** 正式成果保留独立全文阅读状态。 */
  const [readingDeliverable, setReadingDeliverable] = useState<TaskWorkDeliverableRecord | null>(null);
  /** 选中的待处理事项继续使用原有确认弹窗。 */
  const [decisionOpen, setDecisionOpen] = useState<TaskWorkDecisionRecord | null>(null);
  /** 证据预览只读取用户选中的命令。 */
  const [commandEvidenceRunId, setCommandEvidenceRunId] = useState<string | null>(null);
  /** 实际换人完成后回到原会话区域，历史导航自身不触发交接。 */
  useEffect(() => {
    if (!props.management.conversationRequest) return;
    setConversationRequest(props.management.conversationRequest);
    setTab('collaboration');
  }, [props.management.conversationRequest]);

  if (!props.client) return <p className="task-conversation-feedback">{zh ? '工作服务未连接，任务说明仍可编辑。' : 'The work service is disconnected. Task requirements remain editable.'}</p>;
  const { projection, loadState, busy, error, act } = props.management;
  const pendingDecisions = projection?.managerDecisions.filter((decision) => decision.status === 'pending') ?? [];
  const pendingConversationRequests = projection?.conversationRequests ?? [];

  /** 工作和待办进入任务内原会话，没有内嵌能力时使用完整会话入口。 */
  function openConversation(conversationId: string): void {
    if (!props.onSelectConversation) {
      props.onOpenConversation?.(conversationId);
      return;
    }
    setConversationRequest({ conversationId });
    setTab('collaboration');
  }
  return (
    <section className="task-work-cockpit" aria-label={zh ? '任务内容与协作' : 'Task content and collaboration'}>
      {error ? (
        <p className="digital-employee-feedback is-error" role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}

      {projection?.plan && tab !== 'work' ? (
        <button type="button" className="task-work-progress-summary" onClick={() => setTab('work')}>
          <span>
            {projection.plan.state === 'paused'
              ? '后续工作暂停'
              : projection.plan.state === 'completed'
                ? '本轮工作已通过'
                : projection.plan.state === 'cancelled'
                  ? '本轮安排已结束'
                  : projection.plan.state === 'draft'
                    ? '工作安排尚未启动'
                    : '当前阶段'}{' '}
            · {projection.plan.stages.find((stage) => !['accepted', 'skipped'].includes(stage.status))?.title ?? '全部阶段已结束'}
          </span>
          <small>
            {projection.plan.stages.filter((stage) => stage.status === 'accepted').length} / {projection.plan.stages.length} 阶段通过 · 查看安排
          </small>
        </button>
      ) : null}
      {/* 沟通是任务详情默认正文；待办和已有工作仍可按上下文进入。 */}
      <div role="region" aria-label={zh ? '沟通' : 'Conversation'} className="task-work-conversation-panel" hidden={tab !== 'collaboration'}>
        {projection && (pendingConversationRequests.length > 0 || pendingDecisions.length > 0) ? (
          <Button
            className="task-conversation-inbox"
            variant="secondary"
            size="compact"
            onClick={() => {
              // 待办集中在工作页处理，聊天保留原会话及草稿。
              setTab('work');
            }}
          >
            {zh ? '待我处理' : 'Needs my attention'} · {pendingConversationRequests.length + pendingDecisions.length} · {zh ? '查看待办' : 'View pending items'}
          </Button>
        ) : null}
        <TaskConversationPane
          conversations={props.conversations ?? []}
          loading={props.conversationsLoading || props.management.loadState === 'loading'}
          error={props.conversationsError}
          employees={props.management.employees}
          items={projection?.workItems ?? []}
          teams={props.management.teams}
          teamTemplates={props.management.teamTemplates}
          pendingAssignment={props.management.pendingAssignment}
          onArrangeTeam={props.onArrangeTeam}
          onOpenTeamRun={props.onOpenTeamRun}
          activeConversationId={props.activeConversationId}
          workspace={props.conversationWorkspace}
          newWorkspace={props.terminalReadOnly ? null : props.newConversationWorkspace}
          conversationRequest={conversationRequest}
          language={props.language}
          onSelect={props.onSelectConversation}
          onOpen={props.onOpenConversation}
          onReload={props.onReloadConversations}
        />
      </div>
      {tab === 'work' && projection ? (
        <div role="region" aria-label={zh ? '工作' : 'Work'} className="task-work-collaboration">
          {pendingConversationRequests.length + pendingDecisions.length > 0 ? (
            <ManagerInbox requests={pendingConversationRequests} decisions={pendingDecisions} language={props.language} onOpenConversation={openConversation} onSelect={setDecisionOpen} />
          ) : null}
          <TaskWorkPlanPanel onArrangeTeam={props.onArrangeTeam} taskId={props.taskId} client={props.client} management={props.management} readOnly={props.terminalReadOnly} />
          {projection.workItems.some((item) => !item.arrangement || item.currentRunId) ? (
            <WorkItemBoard
              items={projection.workItems.filter((item) => !item.arrangement || item.currentRunId)}
              employees={props.management.employees}
              relationships={projection?.relationships ?? []}
              busy={busy}
              readOnly={props.terminalReadOnly}
              language={props.language}
              onOpenConversation={openConversation}
              onRetry={(item) => void act(`retry:${item.id}`, () => props.client!.retryTaskWorkItem(props.taskId, item))}
              onCancel={(item) => void act(`cancel:${item.id}`, () => props.client!.cancelTaskWorkItem(props.taskId, item))}
            />
          ) : null}
        </div>
      ) : null}
      {tab === 'deliverables' && projection ? (
        <div role="region" aria-label={zh ? '成果' : 'Deliverables'}>
          <DeliverablesView deliverables={projection?.deliverables ?? []} language={props.language} onOpen={setReadingDeliverable} />
        </div>
      ) : null}
      {tab === 'evidence' && projection ? (
        <div role="region" aria-label={zh ? '运行记录' : 'Activity'}>
          <EvidenceView items={projection?.workItems ?? []} refs={projection?.evidenceRefs ?? []} language={props.language} onOpenConversation={openConversation} onOpenCommand={setCommandEvidenceRunId} />
        </div>
      ) : null}

      {tab !== 'collaboration' && !projection && loadState === 'loading' ? (
        <p className="task-conversation-feedback" role="status">
          {zh ? '正在读取工作记录…' : 'Loading work records…'}
        </p>
      ) : null}
      <MotionPresence>
        {readingDeliverable ? (
          <TaskDeliverableReader
            taskId={props.taskId}
            deliverable={readingDeliverable}
            revisions={projection?.deliverables ?? []}
            client={props.client}
            language={props.language}
            onClose={() => setReadingDeliverable(null)}
            onReview={
              !props.terminalReadOnly && pendingDecisions.some((candidate) => candidate.deliverableId === readingDeliverable.id)
                ? () => {
                    /** 验收沿用原决定，历史成果不会重新生成待办。 */
                    const pending = pendingDecisions.find((candidate) => candidate.deliverableId === readingDeliverable.id);
                    if (pending) {
                      setReadingDeliverable(null);
                      setDecisionOpen(pending);
                    }
                  }
                : undefined
            }
          />
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {decisionOpen ? (
          <DecisionDialog
            decision={decisionOpen}
            projection={projection}
            client={props.client}
            taskId={props.taskId}
            language={props.language}
            busy={busy === `decision:${decisionOpen.id}`}
            readOnly={props.terminalReadOnly}
            operationError={error}
            onDismiss={() => setDecisionOpen(null)}
            onAccept={async (deliverable) => {
              const success = await act(`decision:${decisionOpen.id}`, () => props.client!.acceptTaskWorkDeliverable(props.taskId, deliverable));
              if (success) setDecisionOpen(null);
            }}
            onRequestChanges={async (deliverable, reason) => {
              const success = await act(`decision:${decisionOpen.id}`, () => props.client!.requestTaskWorkDeliverableChanges(props.taskId, deliverable, reason));
              if (success) setDecisionOpen(null);
            }}
            onRespond={async (response) => {
              const success = await act(`decision:${decisionOpen.id}`, () => props.client!.resolveTaskWorkDecision(props.taskId, decisionOpen, response));
              if (success) setDecisionOpen(null);
            }}
          />
        ) : null}
      </MotionPresence>
      <MotionPresence>{commandEvidenceRunId ? <CommandEvidenceDialog runId={commandEvidenceRunId} client={props.client} language={props.language} onDismiss={() => setCommandEvidenceRunId(null)} /> : null}</MotionPresence>
    </section>
  );
}

/** 连续列表先展示工作目标，再展示执行者、状态与原有操作。 */
function WorkItemBoard(props: {
  items: TaskWorkItemRecord[];
  /** 项目员工身份与顶部头像保持一致，停用员工仍可追溯。 */
  employees: DigitalEmployeeRecord[];
  relationships: Array<Record<string, unknown>>;
  busy: string | null;
  readOnly: boolean;
  language: DigitalEmployeeLanguage;
  onOpenConversation?: (conversationId: string) => void;
  onRetry(item: TaskWorkItemRecord): void;
  onCancel(item: TaskWorkItemRecord): void;
}) {
  /** 工作标题和操作名称跟随应用语言。 */
  const zh = props.language === 'zh-CN';
  return (
    <section className="task-work-board" aria-label={zh ? '工作项' : 'Work items'}>
      <header>
        <span>
          <strong>{zh ? '工作项' : 'Work items'}</strong>
          <small>{zh ? '每次指派与运行记录均保留在这里' : 'Every assignment and run remains available here'}</small>
        </span>
      </header>
      {props.relationships.length === 0 && props.items.length > 1 ? <p className="task-work-relationship-note">{zh ? '这些是独立指派，当前没有依赖关系。' : 'These are independent assignments with no dependencies.'}</p> : null}
      <div className="task-work-item-list">
        {props.items.map((item) => {
          /** 采用当前运行，旧记录缺少指针时沿用最后一次运行。 */
          const current = item.runs.find((run) => run.id === item.currentRunId) ?? item.runs.at(-1);
          /** 使用真实员工头像，命令与没有员工身份的历史保留类型图标。 */
          const employee = props.employees.find((candidate) => candidate.id === current?.employeeId);
          return (
            <article key={item.id} className={`task-work-item is-${item.status}`}>
              <span className="task-work-entry-icon" aria-hidden="true">
                {employee ? <DigitalEmployeeAvatar {...employee} /> : item.entrypointKind === 'command' ? <TerminalWindow size={20} /> : <ChatCircle size={20} />}
              </span>
              <div className="task-work-item-copy">
                <div className="task-work-item-heading">
                  <strong>{item.title}</strong>
                  <span className={`task-work-item-status is-${item.status}`}>{workItemStatus(item.status, props.language)}</span>
                </div>
                <small className="task-work-item-meta">
                  <span>{employeeName(current) || (item.entrypointKind === 'command' ? (zh ? '命令执行' : 'Command') : zh ? '数字员工' : 'Digital employee')}</span>
                  {current ? (
                    <span>
                      {zh ? `第 ${current.attempt} 次运行` : `Run ${current.attempt}`} · {runStatus(current.status, props.language, current.errorCode)}
                    </span>
                  ) : null}
                </small>
                {item.description ? <p>{item.description}</p> : null}
                {current?.goal ? (
                  <p>
                    自主目标 · {({ active: '推进中', paused: '已暂停', blocked: '等待处理', complete: '已完成' } as Record<string, string>)[current.goal.status] ?? current.goal.status}：{current.goal.objective}
                  </p>
                ) : null}
                {item.arrangement?.parentWorkItemId ? <small>团队子工作 · 通过审查后交回上级汇总</small> : null}
                {item.arrangement?.dependencyIds.length ? <small>等待 {item.arrangement.dependencyIds.length} 份前序分工通过</small> : null}

                {current?.errorMessage ? (
                  <small className="is-error">
                    <VisibleApplicationError error={{ code: current.errorCode, message: current.errorMessage }} language={zh ? 'zh-CN' : 'en'} />
                  </small>
                ) : null}
              </div>
              <span className="task-work-item-actions">
                {current?.conversationId && props.onOpenConversation ? (
                  <Button variant="secondary" size="compact" onClick={() => props.onOpenConversation?.(current.conversationId!)}>
                    {zh ? '打开会话' : 'Open conversation'}
                  </Button>
                ) : null}
                {(item.status === 'failed' || item.status === 'blocked') && item.entrypointKind === 'agent' ? (
                  <Button variant="secondary" size="compact" busy={props.busy === `retry:${item.id}`} disabled={props.readOnly || current?.status === 'outcome_unknown'} onClick={() => props.onRetry(item)}>
                    {zh ? '重试' : 'Retry'}
                  </Button>
                ) : null}
                {['queued', 'active', 'waiting_manager', 'blocked'].includes(item.status) ? (
                  <Button variant="secondary" size="compact" busy={props.busy === `cancel:${item.id}`} disabled={props.readOnly} onClick={() => props.onCancel(item)}>
                    {zh ? '取消' : 'Cancel'}
                  </Button>
                ) : null}
              </span>
            </article>
          );
        })}
        {props.items.length === 0 ? (
          <div className="task-work-empty">
            <ChatCircle size={28} weight="light" aria-hidden="true" />
            <strong>{zh ? '指派第一项工作' : 'Assign the first work item'}</strong>
            <small>{zh ? '在上方“执行人”中选择员工，明确本次工作后开始。' : 'Choose a digital employee from Executor in task properties to configure and start a run.'}</small>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** 待办放在工作列表前，空态仅占一行，不再挤出第三列。 */
function ManagerInbox(props: {
  requests: TaskWorkConversationRequestRecord[];
  decisions: TaskWorkDecisionRecord[];
  language: DigitalEmployeeLanguage;
  onOpenConversation?: (conversationId: string) => void;
  onSelect(decision: TaskWorkDecisionRecord): void;
}) {
  /** 待办与空态文案跟随应用语言。 */
  const zh = props.language === 'zh-CN';
  /** 原始会话请求和管理决策共同组成当前待办。 */
  const count = props.requests.length + props.decisions.length;
  if (count === 0) {
    return (
      <aside className="task-work-inbox is-empty" aria-label={zh ? '待我处理' : 'Needs my attention'}>
        <CheckCircle size={19} aria-hidden="true" />
        <strong>{zh ? '当前无需处理' : 'Nothing needs your attention'}</strong>
        <span>{zh ? '新的会话请求、验收和异常会出现在这里' : 'New requests, reviews, and issues will appear here'}</span>
      </aside>
    );
  }
  return (
    <aside className="task-work-inbox" aria-label={zh ? '待我处理' : 'Needs my attention'}>
      <header>
        <span>
          <strong>{zh ? '待我处理' : 'Needs me'}</strong>
          <small>{zh ? `${count} 项待办` : `${count} pending`}</small>
        </span>
      </header>
      <div>
        {props.requests.map((request) => (
          <button key={request.id} type="button" disabled={!props.onOpenConversation} onClick={() => props.onOpenConversation?.(request.conversationId)}>
            <span aria-hidden="true">
              <ChatCircle size={19} />
            </span>
            <span>
              <strong>{request.requestKind === 'request_user_input' ? (zh ? '员工需要补充信息' : 'Employee needs input') : zh ? '员工等待授权' : 'Employee needs approval'}</strong>
              <small>{zh ? '打开任务会话处理原始请求' : 'Open the task conversation to handle the original request'}</small>
              <time>{formatDateTime(request.createdAt, props.language)}</time>
            </span>
            <CaretRightIcon size={15} aria-hidden="true" />
          </button>
        ))}
        {props.decisions.map((decision) => (
          <button key={decision.id} type="button" onClick={() => props.onSelect(decision)}>
            <span aria-hidden="true">
              {decision.kind === 'deliverable_acceptance' ? <CheckCircle size={19} /> : decision.kind === 'outcome_unknown' || decision.kind === 'command_failure' ? <WarningCircle size={19} /> : <ChatCircle size={19} />}
            </span>
            <span>
              <strong>{decisionCopy(decision, 'title', zh)}</strong>
              <small>{decisionCopy(decision, 'prompt', zh)}</small>
              <time>{formatDateTime(decision.createdAt, props.language)}</time>
            </span>
            <CaretRightIcon size={15} aria-hidden="true" />
          </button>
        ))}
      </div>
    </aside>
  );
}

/** 全部成果均可打开冻结正文，已验收成果也保留完整阅读入口。 */
function DeliverablesView(props: { deliverables: TaskWorkDeliverableRecord[]; language: DigitalEmployeeLanguage; onOpen(deliverable: TaskWorkDeliverableRecord): void }) {
  const zh = props.language === 'zh-CN';
  return (
    <section className="task-work-deliverables">
      <header>
        <strong>{zh ? '正式交付物' : 'Formal deliverables'}</strong>
        <small>{zh ? '查看每次交付的内容与验收状态' : 'View the content and acceptance status of each delivery'}</small>
      </header>
      {props.deliverables.map((deliverable) => (
        <article key={deliverable.id}>
          <span>
            <strong>{deliverable.title}</strong>
            <small>
              {zh ? '修订' : 'Revision'} {deliverable.version} · {deliverableStatus(deliverable.status, props.language)}
            </small>
          </span>
          <p>{deliverable.summary}</p>
          <Button variant="secondary" size="compact" onClick={() => props.onOpen(deliverable)}>
            {zh ? '查看成果' : 'Read deliverable'}
          </Button>
        </article>
      ))}
      {props.deliverables.length === 0 ? <p>{zh ? '尚无正式交付物。' : 'No formal deliverables yet.'}</p> : null}
    </section>
  );
}

/** 运行入口显示对应工作名称；没有可打开原会话的历史记录按文本呈现。 */
function EvidenceView(props: { refs: Array<Record<string, unknown>>; items: TaskWorkItemRecord[]; language: DigitalEmployeeLanguage; onOpenConversation?: (conversationId: string) => void; onOpenCommand(runId: string): void }) {
  /** 文案与工作状态沿用界面语言。 */
  const zh = props.language === 'zh-CN';
  return (
    <section className="task-work-evidence">
      <header>
        <strong>{zh ? '运行记录' : 'Activity'}</strong>
        <small>{zh ? '按工作查看原会话、命令日志和历史记录' : 'Open original conversations, command logs, and history by work item'}</small>
      </header>
      {props.refs.map((ref, index) => {
        /** 工作与尝试身份用于呈现实际名称和状态，不把内部编号作为主要信息。 */
        const item = props.items.find((candidate) => candidate.id === ref.workItemId);
        const run = item?.runs.find((candidate) => candidate.id === ref.runId);
        /** 旧员工执行记录存在原会话时仍可读取，没有来源时不伪造点击行为。 */
        const conversationId = ref.kind === 'conversation' && typeof ref.id === 'string' ? ref.id : ref.kind === 'legacy_execution' && typeof ref.conversationId === 'string' ? ref.conversationId : null;
        const commandId = ref.kind === 'command_run' && typeof ref.id === 'string' ? ref.id : null;
        const content = (
          <>
            <span aria-hidden="true">{commandId ? <TerminalWindow size={18} /> : <ChatCircle size={18} />}</span>
            <span>
              <strong>{item?.title ?? evidenceLabel(ref.kind, props.language)}</strong>
              <small>
                {evidenceLabel(ref.kind, props.language)}
                {run ? ` · ${runStatus(run.status, props.language, run.errorCode)} · ${zh ? '第' : 'Run'} ${run.attempt}${zh ? '次' : ''} · ${formatDateTime(run.createdAt, props.language)}` : ''}
              </small>
            </span>
          </>
        );
        const key = `${String(ref.kind)}:${String(ref.id)}:${index}`;
        return commandId || (conversationId && props.onOpenConversation) ? (
          <button key={key} type="button" onClick={() => (commandId ? props.onOpenCommand(commandId) : props.onOpenConversation?.(conversationId!))}>
            {content}
          </button>
        ) : (
          <article key={key}>{content}</article>
        );
      })}
      {props.refs.length === 0 ? <p>{zh ? '尚无运行记录。' : 'No activity yet.'}</p> : null}
    </section>
  );
}

export function TaskDigitalEmployeeExecutor(props: {
  taskId: string;
  projectId: string;
  terminalReadOnly: boolean;
  client: DigitalEmployeeApiClient | null;
  language: DigitalEmployeeLanguage;
  management: TaskDigitalEmployeeManagement;
  onLoadCapabilities?: () => Promise<CodexTaskPushCapabilities>;
  /** 缺少员工时进入统一的数字员工管理。 */
  onManageEmployees?(): void;
}) {
  const zh = props.language === 'zh-CN';
  const [selectedEmployee, setSelectedEmployee] = useState<DigitalEmployeeRecord | null>(null);
  if (!props.client) return <span>{zh ? '未连接工作服务' : 'Work service is disconnected'}</span>;
  /** 顶部与左栏使用同一权威身份，只提取当前有效工作。 */
  const navigation = buildTaskConversationNavigation({
    teams: props.management.teams,
    templates: props.management.teamTemplates,
    employees: props.management.employees,
    items: props.management.projection?.workItems ?? [],
    conversations: [],
    language: props.language,
  });
  /** 并行工作只显示一个身份及人数，完整名单留在下拉中。 */
  const assignedEmployees = [
    ...new Map(navigation.flatMap((group) => group.employees.filter((member) => member.employee && member.entries.some((entry) => entry.current)).map((member) => [member.employee!.id, member.employee!] as const))).values(),
  ];
  /** 人工交接必须依据当前冻结团队，不使用正在查看的历史团队。 */
  const activeTeam = props.management.teams.find(isCurrentTaskTeam);
  /** 冻结项目身份与全局来源共同定位可交接员工。 */
  const teamEmployeeIds = new Set(activeTeam?.run.roleSnapshots.flatMap((role) => [role.employeeId, role.configuration.id, role.configuration.globalEmployeeId]).filter((id): id is string => typeof id === 'string') ?? []);
  /** 停用员工保留历史身份，但不能成为新指派候选。 */
  const runnableEmployees = props.management.assignableEmployees.filter((employee) => employee.enabled && employee.entrypointMigrationState === 'ready' && employee.entrypoint?.kind === 'agent');
  /** 目录中的全局员工与已执行的项目绑定是同一人。 */
  function isAssigned(employee: DigitalEmployeeRecord): boolean {
    return assignedEmployees.some(
      (current) => current.id === employee.id || current.id === employee.globalEmployeeId || current.globalEmployeeId === employee.id || Boolean(current.globalEmployeeId && current.globalEmployeeId === employee.globalEmployeeId),
    );
  }
  /** 搜索沿用可见名称和岗位，冻结团队之外的员工仍不可交接。 */
  const options = [
    ...runnableEmployees.map((employee) => ({
      value: employee.id,
      label: employee.name,
      icon: <DigitalEmployeeAvatar {...employee} />,
      searchText: `${employee.name} ${employee.role}`,
      description: activeTeam && !teamEmployeeIds.has(employee.id) && !teamEmployeeIds.has(employee.globalEmployeeId ?? '') ? (zh ? '不在本次团队的冻结分工中' : 'Not assigned to this team execution') : employee.role,
      disabled: Boolean(activeTeam && !teamEmployeeIds.has(employee.id) && !teamEmployeeIds.has(employee.globalEmployeeId ?? '')),
    })),
  ];
  return (
    <span className="task-digital-employee-executor">
      {props.terminalReadOnly ? (
        <span>{assignedEmployees.map((employee) => employee.name).join('、') || (zh ? '暂无执行人' : 'No current employee')}</span>
      ) : runnableEmployees.length > 0 ? (
        <ZeusSelect
          size="regular"
          ariaLabel={zh ? '选择任务执行者' : 'Choose task executor'}
          value={assignedEmployees.length === 1 ? (runnableEmployees.find(isAssigned)?.id ?? assignedEmployees[0].id) : ''}
          options={options}
          searchable
          searchPlaceholder={zh ? '搜索员工或岗位' : 'Search employee or role'}
          emptyLabel={zh ? '没有匹配的数字员工' : 'No matching digital employees'}
          disabled={props.terminalReadOnly || props.management.loadState === 'loading' || props.management.busy !== null || Boolean(props.management.pendingAssignment) || runnableEmployees.length === 0}
          onChange={(employeeId) => {
            const employee = props.management.assignableEmployees.find((candidate) => candidate.id === employeeId);
            if (!employee || isAssigned(employee)) return;
            if (!activeTeam && assignedEmployees.length === 0) {
              setSelectedEmployee(employee);
              return;
            }
            void props.management.act('start-executor', async () => {
              /** 同一接纳入口先预检，配置或输入缺失时不停止旧工作。 */
              const preview = await props.client!.previewTaskWorkItem(props.taskId, { employeeId, workspace: { mode: 'create' }, replaceActiveWork: true });
              if (preview.blockers.length) throw new Error(preview.blockers.map((blocker) => blocker.message).join('\n'));
              const result = await props.client!.createTaskWorkItem(props.taskId, preview);
              props.management.followAssignment(employeeId, result);
            });
          }}
          triggerIcon={assignedEmployees[0] ? <DigitalEmployeeAvatar {...assignedEmployees[0]} /> : undefined}
          triggerLabel={
            props.management.pendingAssignment?.reason
              ? zh
                ? '交接受阻'
                : 'Handover blocked'
              : props.management.pendingAssignment || props.management.busy === 'start-executor'
                ? zh
                  ? '正在交接…'
                  : 'Handing over…'
                : assignedEmployees.length
                  ? assignedEmployees[0].name + (assignedEmployees.length > 1 ? ` +${assignedEmployees.length - 1}` : '')
                  : zh
                    ? '选择执行人'
                    : 'Choose an employee'
          }
        />
      ) : props.management.loadState === 'loading' ? (
        <span role="status">{zh ? '正在读取员工…' : 'Loading employees…'}</span>
      ) : props.management.loadState === 'failed' ? (
        <Button variant="secondary" size="compact" onClick={() => void props.management.load()}>
          {zh ? '重新读取员工' : 'Reload employees'}
        </Button>
      ) : props.onManageEmployees ? (
        <Button variant="secondary" size="compact" onClick={props.onManageEmployees}>
          {zh ? '添加数字员工' : 'Add digital employees'}
        </Button>
      ) : (
        <span>{zh ? '尚无可指派员工' : 'No employees available'}</span>
      )}
      <MotionPresence>
        {selectedEmployee ? (
          <TaskEmployeeRunDialog
            key={selectedEmployee.id}
            taskId={props.taskId}
            projectId={props.projectId}
            employee={selectedEmployee}
            acceptedDeliverables={props.management.projection?.deliverables.filter((deliverable) => deliverable.status === 'accepted') ?? []}
            client={props.client}
            language={props.language}
            busy={props.management.busy === 'start-executor'}
            operationError={props.management.error}
            onLoadCapabilities={props.onLoadCapabilities}
            onDismiss={() => setSelectedEmployee(null)}
            onSubmit={async (preview) => {
              const success = await props.management.act('start-executor', async () => {
                const result = await props.client!.createTaskWorkItem(props.taskId, preview);
                props.management.followAssignment(selectedEmployee.id, result);
              });
              if (success) setSelectedEmployee(null);
              return success;
            }}
          />
        ) : null}
      </MotionPresence>
    </span>
  );
}

function TaskEmployeeRunDialog(props: {
  taskId: string;
  projectId: string;
  employee: DigitalEmployeeRecord;
  acceptedDeliverables: TaskWorkDeliverableRecord[];
  client: DigitalEmployeeApiClient;
  language: DigitalEmployeeLanguage;
  busy: boolean;
  operationError: string | null;
  onLoadCapabilities?: () => Promise<CodexTaskPushCapabilities>;
  /** 关闭预览时清理当前指派选择。 */
  onDismiss(): void;
  onSubmit(preview: TaskWorkPreview): Promise<boolean>;
}) {
  const zh = props.language === 'zh-CN';
  const agentEntrypoint = props.employee.entrypoint?.kind === 'agent' ? props.employee.entrypoint : null;
  const [models, setModels] = useState<CodexTaskPushCapabilities['models']>([]);
  /** 首次读取完成前不把空模型数组解释成配置缺失。 */
  const [capabilitiesLoaded, setCapabilitiesLoaded] = useState(false);
  const [capabilities, setCapabilities] = useState<CodexTaskPushCapabilities | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<'create' | 'continue' | null>(null);
  const [workspaceTarget, setWorkspaceTarget] = useState('');
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [supplementalInfo, setSupplementalInfo] = useState('');
  const [supplementalAttachments, setSupplementalAttachments] = useState<TaskPushSupplementalAttachmentDraft[]>([]);
  const [supplementalResourceError, setSupplementalResourceError] = useState<string | null>(null);
  const [selectedDeliverableIds, setSelectedDeliverableIds] = useState<string[]>([]);
  /** 本次选择独立保存，未提供字段继续跟随员工默认。 */
  const [executionSettings, setExecutionSettings] = useState<EmployeeWorkSettings>({});
  const [preview, setPreview] = useState<TaskWorkPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const previewVersion = useRef(0);
  const supplementalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const loadCapabilitiesRef = useRef(props.onLoadCapabilities);
  /** 后台目录读取与弹窗初始化共用代次，防止旧列表回写。 */
  const modelRevisionRef = useRef(0);
  loadCapabilitiesRef.current = props.onLoadCapabilities;
  const inputResources = useConversationInputResources({
    attachments: supplementalAttachments,
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
    textareaRef: supplementalTextareaRef,
    text: supplementalInfo,
    disabled: props.busy,
    onTextChange: setSupplementalInfo,
    onAddAttachments: (attachments) => {
      setSupplementalResourceError(null);
      setSupplementalAttachments((current) => mergeTaskPushSupplementalAttachments(current, attachments));
    },
    onRemoveAttachment: (attachment) => {
      const identity = taskPushSupplementalAttachmentIdentity(attachment);
      setSupplementalAttachments((current) => current.filter((candidate) => taskPushSupplementalAttachmentIdentity(candidate) !== identity));
    },
    onError: setSupplementalResourceError,
  });

  useEffect(() => {
    if (!agentEntrypoint) return;
    let active = true;
    /** 初始请求仍负责工作区选择，目录通知仅替换模型能力。 */
    const modelRevision = ++modelRevisionRef.current;
    setCapabilityError(null);
    const request = loadCapabilitiesRef.current ? loadCapabilitiesRef.current() : props.client.loadDigitalEmployeeCapabilities();
    void request
      .then((nextCapabilities: CodexTaskPushCapabilities | Awaited<ReturnType<typeof props.client.loadDigitalEmployeeCapabilities>>) => {
        if (!active) return;
        setCapabilitiesLoaded(true);
        const taskCapabilities = 'repositories' in nextCapabilities ? nextCapabilities : null;
        const initialWorkspace = taskCapabilities ? initialTaskWorkWorkspaceChoice(taskCapabilities) : ({ mode: 'create' } as const);
        if (modelRevision === modelRevisionRef.current) setCapabilities(taskCapabilities);
        setWorkspaceMode(initialWorkspace?.mode === 'create' ? 'create' : initialWorkspace ? 'continue' : null);
        setWorkspaceTarget(initialWorkspace?.mode === 'existing' ? `environment:${initialWorkspace.environmentId}` : initialWorkspace?.mode === 'local' ? `local:${initialWorkspace.branchName}` : '');
        if (modelRevision === modelRevisionRef.current) setModels(nextCapabilities.models);
      })
      .catch((cause) => {
        if (active) {
          setCapabilitiesLoaded(true);
          setCapabilityError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
        }
      });
    return () => {
      active = false;
    };
  }, [agentEntrypoint, props.client, zh]);

  useEffect(() => {
    if (!agentEntrypoint) return;
    /** 更新目录时保留工作区、运行参数、资料与预览。 */
    let disposed = false;
    const refreshModels = (): void => {
      const revision = ++modelRevisionRef.current;
      const request = loadCapabilitiesRef.current ? loadCapabilitiesRef.current() : props.client.loadDigitalEmployeeCapabilities();
      void request
        .then((next: CodexTaskPushCapabilities | Awaited<ReturnType<typeof props.client.loadDigitalEmployeeCapabilities>>) => {
          if (disposed || revision !== modelRevisionRef.current) return;
          setModels(next.models);
          setCapabilities((current) => (current ? { ...current, models: next.models, ...('repositories' in next ? { preferredModel: next.preferredModel } : {}) } : 'repositories' in next ? next : null));
        })
        .catch(() => {
          // 临时读取失败不影响当前准备，后续目录通知会再次同步。
        });
    };
    window.addEventListener(codexCapabilitiesChangedEvent, refreshModels);
    return () => {
      disposed = true;
      modelRevisionRef.current += 1;
      window.removeEventListener(codexCapabilitiesChangedEvent, refreshModels);
    };
  }, [agentEntrypoint, props.client, props.taskId]);

  useEffect(() => {
    const workspace =
      workspaceMode === 'create'
        ? ({ mode: 'create' } as const)
        : workspaceMode === 'continue' && workspaceTarget.startsWith('environment:')
          ? ({ mode: 'existing', environmentId: workspaceTarget.slice('environment:'.length) } as const)
          : workspaceMode === 'continue' && workspaceTarget.startsWith('local:')
            ? ({ mode: 'local', branchName: workspaceTarget.slice('local:'.length) } as const)
            : null;
    if (agentEntrypoint && !workspace) {
      setPreview(null);
      setPreviewBusy(false);
      return;
    }
    const version = previewVersion.current + 1;
    previewVersion.current = version;
    setPreviewBusy(true);
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      void props.client
        .previewTaskWorkItem(props.taskId, {
          ...executionSettings,
          employeeId: props.employee.id,
          supplementalInfo: supplementalInfo.trim() || null,
          ...(supplementalAttachments.length > 0 ? { supplementalAttachments: taskPushSupplementalRequestAttachments(supplementalAttachments) } : {}),
          selectedDeliverableIds,
          ...(workspace ? { workspace } : {}),
        })
        .then((nextPreview) => {
          if (previewVersion.current === version) setPreview(nextPreview);
        })
        .catch((cause) => {
          if (previewVersion.current === version) {
            setPreview(null);
            setPreviewError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
          }
        })
        .finally(() => {
          if (previewVersion.current === version) setPreviewBusy(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [executionSettings, agentEntrypoint, models, props.client, props.employee.id, props.taskId, selectedDeliverableIds, supplementalAttachments, supplementalInfo, workspaceMode, workspaceTarget, zh]);

  const existingEnvironments = capabilities?.existingEnvironments ?? [];
  const canContinueEnvironment = (environment: NonNullable<CodexTaskPushCapabilities['existingEnvironments']>[number]): boolean => environment.available;
  const localTaskBranches = capabilities ? commonLocalTaskBranches(capabilities) : [];
  const continuationTargets = [
    ...existingEnvironments.filter(canContinueEnvironment).map((environment) => `environment:${environment.id}`),
    ...localTaskBranches.filter((branch) => branch.available).map((branch) => `local:${branch.branchName}`),
  ];
  const selectedEnvironment = workspaceTarget.startsWith('environment:') ? existingEnvironments.find((environment) => environment.id === workspaceTarget.slice('environment:'.length)) : undefined;
  const selectedLocalBranch = workspaceTarget.startsWith('local:') ? localTaskBranches.find((branch) => branch.branchName === workspaceTarget.slice('local:'.length)) : undefined;

  /** 运行条件缺失时提供设置入口，不堆叠不能使用的配置控件。 */
  const hasRunnableModel = models.some((model) => model.available !== false);
  /** 选择器与摘要使用同一模型身份。 */

  async function submit(): Promise<void> {
    if (!preview || preview.blockers.length > 0 || inputResources.processing) return;
    setSubmitError(null);
    const success = await props.onSubmit(preview);
    if (!success) setSubmitError(zh ? '本次运行未能启动，请查看页面上的具体原因。' : 'This run could not start. See the specific cause on this page.');
  }

  return (
    <ModalPortal rootClassName="task-work-run-root" backdropClassName="task-work-run-backdrop" dismissDisabled={props.busy} onDismiss={props.onDismiss} role="dialog" aria-labelledby="task-work-run-title">
      <section className="task-work-run-dialog zeus-solid-form-surface" data-modal-surface="dialog">
        <header>
          <span>
            <strong id="task-work-run-title">{zh ? '指派工作' : 'Assign work'}</strong>
            <small>{zh ? '修改只用于本次工作，不改变员工或模板的默认设置。' : 'Changes apply only to this run and do not change employee or template defaults.'}</small>
          </span>
          <Button variant="secondary" size="compact" disabled={props.busy} onClick={props.onDismiss}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </header>
        <div className="task-work-run-body">
          <section className="task-work-run-person" aria-label={zh ? '执行人' : 'Employee'}>
            <DigitalEmployeeAvatar {...props.employee} />
            <span>
              <strong>{props.employee.name}</strong>
              <small>{props.employee.role}</small>
            </span>
          </section>
          {capabilitiesLoaded && !hasRunnableModel && !capabilityError ? (
            <p className="task-work-setup-note" role="status">
              {zh ? '项目尚未配置可运行模型。请先在项目设置的“可用模型”中启用模型，再回来指派。' : 'Enable a runnable model in project settings before assigning work.'}
            </p>
          ) : null}

          <section className="task-work-run-supplemental" aria-busy={inputResources.processing || undefined} aria-labelledby="task-work-run-supplemental-label">
            <label id="task-work-run-supplemental-label" htmlFor="task-work-run-supplemental-input">
              {zh ? '本次工作要求' : 'Instructions for this work'}
            </label>
            <TaskPushSupplementalAttachmentCards
              attachments={supplementalAttachments}
              pendingResources={inputResources.pendingResources}
              language={props.language}
              disabled={props.busy || inputResources.processing}
              onRemove={(attachment) => {
                const identity = taskPushSupplementalAttachmentIdentity(attachment);
                setSupplementalAttachments((current) => current.filter((candidate) => taskPushSupplementalAttachmentIdentity(candidate) !== identity));
              }}
              onRestoreText={inputResources.restorePastedText}
              onError={setSupplementalResourceError}
            />
            <textarea
              ref={supplementalTextareaRef}
              id="task-work-run-supplemental-input"
              rows={4}
              maxLength={20_000}
              value={supplementalInfo}
              placeholder={zh ? '任务说明已包含在内。可补充这位员工本次要负责的范围与完成标准。' : 'For example: priorities, known clues, or acceptance focus for this work item'}
              disabled={props.busy}
              onChange={(event) => setSupplementalInfo(event.currentTarget.value)}
              onPaste={inputResources.handlePaste}
              onKeyDown={inputResources.handlePasteShortcut}
            />
            <small>
              {zh
                ? '可粘贴图片、文件或长文本；只提供给本次独立工作项，不修改任务描述或员工提示词。'
                : 'Paste images, files, or long text here. They are used only for this independent work item and do not change the task or employee prompt.'}
            </small>
          </section>

          {agentEntrypoint && capabilities && capabilities.repositories.length > 0 ? (
            <fieldset className="task-model-push-mode-choice task-model-push-branch-choice">
              <legend>{zh ? '代码工作目录' : 'Code working folder'}</legend>
              <label className={workspaceMode === 'continue' ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name="task-work-workspace-mode"
                  checked={workspaceMode === 'continue'}
                  onChange={() => {
                    setWorkspaceMode('continue');
                    setWorkspaceTarget((current) => (continuationTargets.includes(current) ? current : continuationTargets.length === 1 ? continuationTargets[0]! : ''));
                  }}
                  disabled={props.busy || continuationTargets.length === 0}
                />
                <span>
                  <strong>{zh ? '继续已有任务分支' : 'Continue existing task branches'}</strong>
                  <small>{zh ? '使用已有任务目录，或为未被使用的本地分支创建独立工作目录' : 'Use an existing task folder, or create a separate working folder for an unused local branch'}</small>
                </span>
              </label>
              <label className={workspaceMode === 'create' ? 'is-selected' : undefined}>
                <input type="radio" name="task-work-workspace-mode" checked={workspaceMode === 'create'} onChange={() => setWorkspaceMode('create')} disabled={props.busy} />
                <span>
                  <strong>{zh ? '创建新的任务分支' : 'Create new task branches'}</strong>
                  <small>{zh ? '创建新的分支和工作目录，与其他员工分别修改代码' : 'Create a new branch and working folder to edit code separately from other employees'}</small>
                </span>
              </label>
              {workspaceMode === 'continue' ? (
                <section className="task-model-push-existing-environment" aria-label={zh ? '选择已有任务分支' : 'Choose existing task branches'}>
                  <ZeusSelect
                    size="regular"
                    ariaLabel={zh ? '选择已有任务分支' : 'Choose existing task branches'}
                    value={workspaceTarget}
                    options={[
                      ...existingEnvironments.map((environment) => ({
                        value: `environment:${environment.id}`,
                        label: taskPushEnvironmentLabel(environment, zh),
                        group: canContinueEnvironment(environment) ? (zh ? '已登记任务环境' : 'Managed environments') : zh ? '暂不可用' : 'Unavailable',
                        disabled: !canContinueEnvironment(environment),
                      })),
                      ...localTaskBranches.map((branch) => ({
                        value: `local:${branch.branchName}`,
                        label: localTaskBranchLabel(branch, zh),
                        group: branch.available ? (zh ? '未登记本地分支' : 'Unmanaged local branches') : zh ? '暂不可用' : 'Unavailable',
                        disabled: !branch.available,
                      })),
                    ]}
                    onChange={setWorkspaceTarget}
                    disabled={props.busy || continuationTargets.length === 0}
                    searchPlaceholder={zh ? '搜索任务分支或仓库' : 'Search task branches or repositories'}
                    emptyLabel={zh ? '没有匹配的任务分支' : 'No matching task branches'}
                  />
                  {selectedEnvironment ? (
                    <ul className="task-model-push-existing-repositories">
                      {selectedEnvironment.repositories.map((repository) => (
                        <li key={`${repository.repositoryId ?? repository.repositoryRelativePath}:${repository.branchName}`}>
                          <span>{repository.repositoryName}</span>
                          <code>{repository.branchName}</code>
                          <small>{zh ? `来源：${repository.sourceBranch}` : `Source: ${repository.sourceBranch}`}</small>
                        </li>
                      ))}
                    </ul>
                  ) : selectedLocalBranch ? (
                    <ul className="task-model-push-existing-repositories">
                      {capabilities?.repositories.map((repository) => (
                        <li key={repository.id}>
                          <span>{repository.name}</span>
                          <code>{selectedLocalBranch.branchName}</code>
                          <small>{zh ? '启动时创建独立工作目录' : 'Create a separate working folder at startup'}</small>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="task-model-push-error" role="alert">
                      {zh ? '请选择一组当前可继续的任务分支。' : 'Choose a task branch environment that can be continued.'}
                    </p>
                  )}
                </section>
              ) : null}
            </fieldset>
          ) : null}

          {props.acceptedDeliverables.length > 0 ? (
            <details className="task-work-context-details">
              <summary>{zh ? `参考已验收成果 · 已选 ${selectedDeliverableIds.length}` : `Accepted deliverable context (${selectedDeliverableIds.length} selected)`}</summary>
              {props.acceptedDeliverables.map((deliverable) => (
                <label key={deliverable.id} className="task-work-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedDeliverableIds.includes(deliverable.id)}
                    onChange={(event) => setSelectedDeliverableIds((current) => (event.currentTarget.checked ? [...current, deliverable.id] : current.filter((id) => id !== deliverable.id)))}
                  />
                  <span>
                    {deliverable.title} · {zh ? '修订' : 'Revision'} {deliverable.version}
                  </span>
                </label>
              ))}
            </details>
          ) : null}

          <details>
            <summary>本次执行配置</summary>
            <EmployeeExecutionSettings
              client={props.client}
              skillClient={'loadSkills' in props.client ? (props.client as DigitalEmployeeApiClient & Pick<NativeConversationAppClient, 'loadSkills'>) : null}
              projectId={props.projectId}
              language={props.language}
              overrides
              value={executionSettings}
              inherited={templateDraft(props.employee).settings}
              disabled={props.busy}
              onChange={setExecutionSettings}
            />
          </details>
          {preview && hasRunnableModel ? (
            <details>
              <summary>执行预览</summary>
              <EmployeeExecutionPreview preview={preview} language={props.language} />
            </details>
          ) : null}
          {!capabilitiesLoaded || (previewBusy && hasRunnableModel) ? (
            <p className="task-work-preview-status" role="status">
              {zh ? '正在更新运行配置预览…' : 'Updating the run settings preview…'}
            </p>
          ) : null}
          {capabilityError || previewError || supplementalResourceError || props.operationError || submitError ? (
            <p className="digital-employee-feedback is-error" role="alert">
              <VisibleApplicationError error={capabilityError ?? previewError ?? supplementalResourceError ?? props.operationError ?? submitError} language={zh ? 'zh-CN' : 'en'} />
            </p>
          ) : null}
          {hasRunnableModel &&
            preview?.blockers.map((blocker) => (
              <p key={blocker.code} className="digital-employee-feedback is-error">
                <VisibleApplicationError error={blocker} language={zh ? 'zh-CN' : 'en'} />
              </p>
            ))}
        </div>
        <footer>
          <small>{zh ? '指派后开始工作，进展和成果会回到当前任务。' : 'Work starts after assignment. Progress and deliverables return to this task.'}</small>
          {capabilitiesLoaded && !hasRunnableModel ? (
            <Button
              variant="primary"
              size="regular"
              onClick={() => {
                props.onDismiss();
                window.dispatchEvent(new CustomEvent(modelSetupRequestedEvent, { detail: 'choose' }));
              }}
            >
              {zh ? '配置模型' : 'Configure models'}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="regular"
              busy={props.busy || inputResources.processing}
              disabled={!preview || previewBusy || inputResources.processing || preview.blockers.length > 0 || Boolean(capabilityError || supplementalResourceError)}
              onClick={() => void submit()}
            >
              {zh ? '指派并开始' : 'Assign and start'}
            </Button>
          )}
        </footer>
      </section>
    </ModalPortal>
  );
}

interface CommonLocalTaskBranch {
  branchName: string;
  available: boolean;
  unavailableReason: 'managed_environment' | 'checked_out' | null;
}

function commonLocalTaskBranches(capabilities: CodexTaskPushCapabilities): CommonLocalTaskBranch[] {
  const [first, ...rest] = capabilities.repositories;
  if (!first) return [];
  // ponytail: 多仓只接管每个仓库都存在的同名任务分支；需要混合分支时再改为逐仓选择。
  return (first.localTaskBranches ?? [])
    .flatMap((candidate) => {
      const matches = [candidate, ...rest.map((repository) => repository.localTaskBranches?.find((branch) => branch.branchName === candidate.branchName))];
      if (matches.some((match) => !match)) return [];
      const unavailable = matches.find((match) => match?.available !== true);
      return [
        {
          branchName: candidate.branchName,
          available: !unavailable,
          unavailableReason: unavailable?.unavailableReason ?? null,
        },
      ];
    })
    .sort((left, right) => left.branchName.localeCompare(right.branchName));
}

function localTaskBranchLabel(branch: CommonLocalTaskBranch, zh: boolean): string {
  if (branch.available) return branch.branchName;
  const reason = branch.unavailableReason === 'checked_out' ? (zh ? '已在其他工作目录使用' : 'In use in another working folder') : zh ? '已由任务环境管理' : 'already managed';
  return `${branch.branchName} · ${reason}`;
}

function initialTaskWorkWorkspaceChoice(capabilities: CodexTaskPushCapabilities): { mode: 'create' } | { mode: 'existing'; environmentId: string } | { mode: 'local'; branchName: string } | null {
  if (capabilities.repositories.length === 0) return { mode: 'create' };
  const environments = capabilities.existingEnvironments ?? [];
  const available = [
    ...environments.filter((environment) => environment.available).map((environment) => ({ mode: 'existing' as const, environmentId: environment.id })),
    ...commonLocalTaskBranches(capabilities)
      .filter((branch) => branch.available)
      .map((branch) => ({ mode: 'local' as const, branchName: branch.branchName })),
  ];
  if (available.length === 0) return { mode: 'create' };
  if (available.length === 1) return available[0]!;
  return null;
}

function CommandEvidenceDialog(props: { runId: string; client: DigitalEmployeeApiClient; language: DigitalEmployeeLanguage; onDismiss(): void }) {
  const zh = props.language === 'zh-CN';
  const [detail, setDetail] = useState<CommandRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    void props.client
      .loadTaskWorkCommandEvidence(props.runId)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
      });
    return () => {
      active = false;
    };
  }, [props.client, props.runId, zh]);
  return (
    <ModalPortal rootClassName="task-work-decision-root" backdropClassName="task-work-decision-backdrop" onDismiss={props.onDismiss} role="dialog" aria-labelledby="task-work-command-evidence-title">
      <section className="task-work-decision-dialog zeus-solid-form-surface" data-modal-surface="dialog">
        <header>
          <span>
            <strong id="task-work-command-evidence-title">{zh ? '命令运行证据' : 'Command run evidence'}</strong>
            <small>{props.runId}</small>
          </span>
          <Button variant="secondary" size="compact" onClick={props.onDismiss}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </header>
        <div>
          {error ? <p className="digital-employee-feedback is-error">{error}</p> : null}
          {!detail && !error ? <p>{zh ? '正在读取命令日志…' : 'Loading command logs…'}</p> : null}
          {detail ? (
            <>
              <section className="task-work-command-evidence-summary">
                <span>
                  <small>{zh ? '命令' : 'Command'}</small>
                  <strong>{detail.run.commandSnapshot.title}</strong>
                </span>
                <span>
                  <small>{zh ? '状态' : 'Status'}</small>
                  <strong>{detail.run.status}</strong>
                </span>
                <span>
                  <small>{zh ? '退出码' : 'Exit code'}</small>
                  <strong>{detail.run.exitCode ?? '—'}</strong>
                </span>
              </section>
              {detail.run.failureReason ? <p className="digital-employee-feedback is-error">{detail.run.failureReason}</p> : null}
              <section>
                <strong>{zh ? '终端日志' : 'Terminal logs'}</strong>
                <pre className="task-work-command-log">{detail.logs.length > 0 ? detail.logs.map((entry) => `${entry.createdAt} [${entry.stream}] ${entry.text}`).join('\n') : zh ? '暂无日志。' : 'No logs.'}</pre>
              </section>
              {detail.artifacts.length > 0 ? (
                <section className="task-work-command-artifacts">
                  <strong>{zh ? '命令产物' : 'Command artifacts'}</strong>
                  {detail.artifacts.map((artifact) => (
                    <span key={artifact.id}>
                      <code>{artifact.relativePath}</code>
                      <small>{artifact.artifactRef?.contentSha256.slice(0, 16) ?? '—'}…</small>
                    </span>
                  ))}
                </section>
              ) : null}
            </>
          ) : null}
        </div>
        <footer>
          <Button variant="secondary" size="compact" onClick={props.onDismiss}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

function DecisionDialog(props: {
  decision: TaskWorkDecisionRecord;
  projection: TaskWorkManagementProjection | null;
  client: DigitalEmployeeApiClient;
  taskId: string;
  language: DigitalEmployeeLanguage;
  busy: boolean;
  /** 结束的任务保留阅读，重新打开后再处理未决事项。 */
  readOnly: boolean;
  /** 写入失败必须出现在当前弹窗内，不能藏在背后的工作区。 */
  operationError: string | null;
  onDismiss(): void;
  onAccept(deliverable: TaskWorkDeliverableRecord): Promise<void>;
  onRequestChanges(deliverable: TaskWorkDeliverableRecord, reason: string): Promise<void>;
  onRespond(response: Record<string, unknown>): Promise<void>;
}) {
  /** 审查意见读取完成且无阻塞后允许验收。 */
  const [reviewReady, setReviewReady] = useState(false);
  const zh = props.language === 'zh-CN';
  const [reason, setReason] = useState('');
  /** 空意见点击后给出就近反馈，并把输入位置带回可见区域。 */
  const [reasonRequired, setReasonRequired] = useState(false);
  /** 修改意见输入框用于错误后的键盘定位。 */
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  /** 错误说明与输入框关联，避免仅用颜色表达校验结果。 */
  const reasonErrorId = useId();
  const [commandParameters, setCommandParameters] = useState<Record<string, string | number | boolean>>({});
  const [deliverableContent, setDeliverableContent] = useState<string | null>(null);
  const [deliverableContentError, setDeliverableContentError] = useState<string | null>(null);
  /** 读取失败可在原审查空间重试，不丢失修改意见。 */
  const [contentRetry, setContentRetry] = useState(0);
  const deliverable = props.decision.deliverableId ? (props.projection?.deliverables.find((candidate) => candidate.id === props.decision.deliverableId) ?? null) : null;
  const command = isRecord(props.decision.requestPayload.command) ? props.decision.requestPayload.command : null;
  const commandParametersSchema = command && Array.isArray(command.parameters) ? command.parameters.filter(isRecord) : [];
  useEffect(() => {
    if (!deliverable) return;
    let active = true;
    setDeliverableContent(null);
    setDeliverableContentError(null);
    void readTaskDeliverableContent(props.client, props.taskId, deliverable, props.language)
      .then((content) => {
        if (active) setDeliverableContent(content);
      })
      .catch((cause) => {
        if (active) setDeliverableContentError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
      });
    return () => {
      active = false;
    };
  }, [deliverable?.id, deliverable?.version, deliverable?.contentSha256, props.client, props.taskId, zh, contentRetry]);
  return (
    <ModalPortal rootClassName="task-work-decision-root" backdropClassName="task-work-decision-backdrop" dismissDisabled={props.busy} onDismiss={props.onDismiss} role="dialog" aria-labelledby="task-work-decision-title">
      <section className={`task-work-decision-dialog zeus-solid-form-surface${deliverable ? ' task-work-deliverable-review' : ''}`} data-modal-surface="dialog">
        <header>
          <span>
            <strong id="task-work-decision-title">{decisionCopy(props.decision, 'title', zh)}</strong>
            <small>{decisionCopy(props.decision, 'prompt', zh)}</small>
          </span>
          <Button variant="secondary" size="compact" disabled={props.busy} onClick={props.onDismiss}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </header>
        <div>
          {deliverable ? (
            <>
              <span className="task-work-decision-deliverable">
                <small>
                  {zh ? '修订' : 'Revision'} {deliverable.version}
                </small>
                <strong>{deliverable.title}</strong>
                <p>{deliverable.summary}</p>
              </span>
              {deliverableContent !== null ? (
                <TaskDeliverableContent key={deliverable.id} id={deliverable.id} title={deliverable.title} content={deliverableContent} language={props.language} />
              ) : (
                <div>
                  <p role={deliverableContentError ? 'alert' : 'status'}>{deliverableContentError ?? (zh ? '正在读取正式交付物…' : 'Loading formal deliverable…')}</p>
                  {deliverableContentError ? (
                    <Button variant="secondary" size="compact" onClick={() => setContentRetry((current) => current + 1)}>
                      {zh ? '重新读取' : 'Try again'}
                    </Button>
                  ) : null}
                </div>
              )}
              <TaskWorkReviewPanel key={deliverable.id} taskId={props.taskId} deliverable={deliverable} client={props.client} readOnly={props.readOnly} onReady={setReviewReady} />
              {!props.readOnly ? (
                <label>
                  <span>{zh ? '修改意见' : 'Review feedback'}</span>
                  <textarea
                    ref={reasonRef}
                    rows={4}
                    maxLength={4_000}
                    value={reason}
                    aria-invalid={reasonRequired || undefined}
                    aria-describedby={reasonRequired ? reasonErrorId : undefined}
                    onChange={(event) => {
                      setReason(event.target.value);
                      if (event.target.value.trim()) setReasonRequired(false);
                    }}
                    placeholder={zh ? '如需返工，请说明具体要修改的内容。' : 'Describe the changes needed before acceptance.'}
                  />
                  {reasonRequired ? (
                    <span id={reasonErrorId} role="alert">
                      {zh ? '请填写具体修改意见，再要求修改。' : 'Describe the changes needed before requesting changes.'}
                    </span>
                  ) : null}
                </label>
              ) : null}
            </>
          ) : null}
          {props.decision.kind === 'command_confirmation' ? (
            <fieldset>
              <legend>{typeof command?.title === 'string' ? command.title : zh ? '命令参数' : 'Command parameters'}</legend>
              {commandParametersSchema.map((parameter) => {
                const key = typeof parameter.key === 'string' ? parameter.key : '';
                const label = typeof parameter.label === 'string' ? parameter.label : key;
                const kind = typeof parameter.type === 'string' ? parameter.type : 'string';
                if (!key) return null;
                return (
                  <label key={key}>
                    <span>
                      {label}
                      {parameter.required === true ? ' *' : ''}
                    </span>
                    {kind === 'boolean' ? (
                      <ZeusSelect
                        size="regular"
                        ariaLabel={label}
                        value={String(commandParameters[key] ?? '')}
                        options={[
                          { value: '', label: zh ? '请选择' : 'Choose' },
                          { value: 'true', label: zh ? '是' : 'True' },
                          { value: 'false', label: zh ? '否' : 'False' },
                        ]}
                        onChange={(value) => setCommandParameters((current) => ({ ...current, [key]: value === 'true' }))}
                      />
                    ) : (
                      <input
                        type={parameter.sensitive === true ? 'password' : kind === 'number' ? 'number' : 'text'}
                        value={String(commandParameters[key] ?? '')}
                        onChange={(event) => setCommandParameters((current) => ({ ...current, [key]: kind === 'number' ? Number(event.target.value) : event.target.value }))}
                        autoComplete="off"
                      />
                    )}
                  </label>
                );
              })}
              {commandParametersSchema.length === 0 ? <p>{zh ? '该命令没有运行时参数。' : 'This command has no runtime parameters.'}</p> : null}
            </fieldset>
          ) : null}
          {props.decision.kind === 'outcome_unknown' ? (
            <p className="digital-employee-feedback is-error">
              <WarningCircle size={18} />
              {zh
                ? 'Zeus 无法确定命令是否执行成功。请检查命令日志和目标应用的实际结果，再确认成功或失败。确认不会再次执行命令。'
                : 'Zeus cannot determine whether the command succeeded. Check the command logs and the result in the target app before confirming success or failure. Confirmation will not run the command again.'}
            </p>
          ) : null}
          {props.decision.kind === 'command_failure' ? (
            <p className="digital-employee-feedback is-error">
              <WarningCircle size={18} />
              {zh ? '命令已失败。请先查看日志并解决原因，再创建新的尝试；敏感参数需要重新填写。' : 'The command failed. Review the logs and address the cause before starting a new attempt. Sensitive parameters must be entered again.'}
            </p>
          ) : null}
        </div>
        {props.operationError ? (
          <p className="digital-employee-feedback is-error" role="alert">
            <VisibleApplicationError error={props.operationError} language={zh ? 'zh-CN' : 'en'} />
          </p>
        ) : null}
        {props.readOnly ? (
          <p className="task-conversation-feedback">{zh ? '任务已结束，当前仅查看记录。重新打开任务后可继续处理。' : 'This task is closed. Reopen it to resolve this item.'}</p>
        ) : (
          <footer>
            {deliverable ? (
              <>
                <Button
                  variant="secondary"
                  size="compact"
                  busy={props.busy && Boolean(reason)}
                  disabled={props.busy}
                  onClick={() => {
                    if (!reason.trim()) {
                      setReasonRequired(true);
                      reasonRef.current?.focus();
                      reasonRef.current?.scrollIntoView({ block: 'center' });
                      return;
                    }
                    void props.onRequestChanges(deliverable, reason.trim());
                  }}
                >
                  {zh ? '要求修改' : 'Request changes'}
                </Button>
                <Button variant="primary" size="compact" busy={props.busy && !reason} disabled={deliverableContent === null || !reviewReady} onClick={() => void props.onAccept(deliverable)}>
                  {zh ? '接受交付物' : 'Accept deliverable'}
                </Button>
              </>
            ) : null}
            {props.decision.kind === 'command_confirmation' ? (
              <Button variant="primary" size="compact" busy={props.busy} onClick={() => void props.onRespond({ parameters: commandParameters })}>
                {zh ? '确认并启动命令' : 'Confirm and start command'}
              </Button>
            ) : null}
            {props.decision.kind === 'outcome_unknown' ? (
              <>
                <Button variant="secondary" size="compact" busy={props.busy} onClick={() => void props.onRespond({ action: 'mark_failed' })}>
                  {zh ? '确认失败' : 'Mark failed'}
                </Button>
                <Button variant="primary" size="compact" busy={props.busy} onClick={() => void props.onRespond({ action: 'mark_succeeded' })}>
                  {zh ? '确认成功' : 'Mark succeeded'}
                </Button>
              </>
            ) : null}
            {props.decision.kind === 'command_failure' ? (
              <>
                <Button variant="secondary" size="compact" busy={props.busy} onClick={() => void props.onRespond({ action: 'cancel' })}>
                  {zh ? '取消工作项' : 'Cancel work item'}
                </Button>
                <Button variant="primary" size="compact" busy={props.busy} onClick={() => void props.onRespond({ action: 'retry' })}>
                  {zh ? '创建新尝试' : 'Create new attempt'}
                </Button>
              </>
            ) : null}
          </footer>
        )}
      </section>
    </ModalPortal>
  );
}

function employeeName(run: TaskWorkItemRecord['runs'][number] | undefined): string {
  return typeof run?.employeeSnapshot.name === 'string' ? run.employeeSnapshot.name : '';
}
function workItemStatus(status: TaskWorkItemRecord['status'], language: DigitalEmployeeLanguage): string {
  const zh = language === 'zh-CN';
  const labels = zh
    ? { queued: '已排队', active: '执行中', waiting_manager: '待我处理', completed: '已完成', blocked: '已阻塞', failed: '失败', cancelled: '已取消' }
    : { queued: 'Queued', active: 'Active', waiting_manager: 'Needs manager', completed: 'Completed', blocked: 'Blocked', failed: 'Failed', cancelled: 'Cancelled' };
  return labels[status];
}
/** 根据真实终止原因区分业务返工和技术失败。 */
function runStatus(status: TaskWorkItemRecord['runs'][number]['status'], language: DigitalEmployeeLanguage, errorCode?: string | null): string {
  if (status === 'failed' && errorCode === 'ZEUS_TASK_WORK_CHANGES_REQUESTED') return language === 'zh-CN' ? '已要求修改' : 'Changes requested';
  const zh = language === 'zh-CN';
  const labels = zh
    ? { prepared: '已准备', dispatching: '正在启动', active: '执行中', waiting_input: '等待输入', runtime_completed: '待验收', succeeded: '已成功', failed: '失败', outcome_unknown: '结果未知', cancelled: '已取消' }
    : {
        prepared: 'Prepared',
        dispatching: 'Starting',
        active: 'Active',
        waiting_input: 'Waiting for input',
        runtime_completed: 'Awaiting acceptance',
        succeeded: 'Succeeded',
        failed: 'Failed',
        outcome_unknown: 'Outcome unknown',
        cancelled: 'Cancelled',
      };
  return labels[status];
}
function deliverableStatus(status: TaskWorkDeliverableRecord['status'], language: DigitalEmployeeLanguage): string {
  const zh = language === 'zh-CN';
  return status === 'submitted' ? (zh ? '待验收' : 'Submitted') : status === 'accepted' ? (zh ? '已验收' : 'Accepted') : status === 'changes_requested' ? (zh ? '已要求修改' : 'Changes requested') : zh ? '已被新版本取代' : 'Superseded';
}
function evidenceLabel(kind: unknown, language: DigitalEmployeeLanguage): string {
  const zh = language === 'zh-CN';
  return kind === 'conversation' ? (zh ? 'Agent 会话' : 'Agent conversation') : kind === 'command_run' ? (zh ? '命令运行' : 'Command run') : zh ? '历史执行' : 'Legacy execution';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 只翻译 Zeus 固定的管理提示，AI 问题和用户文本保持原文。 */
const decisionText: Readonly<Record<string, readonly [string, string]>> = {
  '核对 Agent 会话派发结果': ['检查 AI 是否已开始处理', 'Check whether AI processing started'],
  处置命令未知结果: ['检查命令执行结果', 'Check the command result'],
  '会话可能已经写入 Provider，Zeus 不会自动重发。请核对会话现场后处置。': [
    '尚未确认 AI 是否已开始处理。请先打开会话检查，再确认结果，避免重复执行。',
    'It is not yet confirmed whether the AI started. Open the conversation and check before confirming the result to avoid duplicate work.',
  ],
  '命令可能已产生外部效果，Zeus 不会自动重发。请核对现场后处置。': [
    '尚未确认命令是否已执行。请先检查文件、应用或服务中的实际结果，再确认成功或失败。',
    'It is not yet confirmed whether the command ran. Check the actual result in the files, app, or service before confirming success or failure.',
  ],
  验收数字员工交付物: ['验收交付物', 'Review the deliverable'],
  '请验收该正式交付物，或明确要求修改。': ['请查看交付物，再选择通过验收或要求修改。', 'Review the deliverable, then accept it or request changes.'],
  重新确认项目命令: ['重新确认项目命令', 'Review the project command again'],
  '命令确认已过期或定义发生变化，请重新预览后显式处置。': [
    '先前确认已过期或命令已修改。请查看最新命令和参数后重新确认。',
    'The previous approval expired or the command changed. Review the current command and parameters before confirming again.',
  ],
  处置失败的项目命令: ['处理失败的命令', 'Handle the failed command'],
  '命令已明确失败。请检查日志后取消工作项或显式创建一次新尝试；Zeus 不会自动重发。': [
    '命令执行失败。请查看日志，选择取消工作项或开始新的尝试。新的尝试会再次执行命令。',
    'The command failed. Check its logs, then cancel the work item or start a new attempt. A new attempt runs the command again.',
  ],
  确认重试项目命令: ['确认再次执行命令', 'Confirm another command attempt'],
  '这是一次新的显式尝试。请重新填写参数并确认；敏感值不会从旧运行恢复。': [
    '这会再次执行命令。请重新填写并核对参数；密码或密钥需要重新输入。',
    'This runs the command again. Enter and review the parameters; passwords or keys must be entered again.',
  ],
};

/** 根据固定文案选择当前语言，不根据文字改变管理操作。 */
function decisionCopy(decision: TaskWorkDecisionRecord, field: 'title' | 'prompt', zh: boolean): string {
  return decisionText[decision[field]]?.[zh ? 0 : 1] ?? decision[field];
}
