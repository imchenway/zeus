import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexTaskPushCapabilities, TaskPushSupplementalAttachmentDraft } from '../../session/sessionTypes.js';
import { useConversationInputResources } from '../../session/useConversationInputResources.js';
import { mergeTaskPushSupplementalAttachments, taskPushEnvironmentLabel, taskPushSupplementalAttachmentIdentity, taskPushSupplementalRequestAttachments, TaskPushLayoutPreview } from '../../task/TaskModelPushModal.js';
import { TaskPushSupplementalAttachmentCards } from '../../task/TaskPushSupplementalAttachmentCards.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { AgentExecutionConfigFields, type AgentExecutionConfigValue } from './AgentExecutionConfigFields.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { CommandRunDetail } from '../runtime/runtimeContracts.js';
import type { DigitalEmployeeRecord, TaskWorkConversationRequestRecord, TaskWorkDecisionRecord, TaskWorkDeliverableRecord, TaskWorkItemRecord, TaskWorkManagementProjection, TaskWorkPreview } from './digitalEmployeeContracts.js';
import { errorMessage, formatDateTime, type DigitalEmployeeLanguage } from './digitalEmployeeUiSupport.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
import './digitalEmployees.css';

export type TaskDigitalEmployeeSkillClient = Pick<NativeConversationAppClient, 'loadSkills'>;

export interface TaskDigitalEmployeePanelProps {
  taskId: string;
  projectId: string;
  terminalReadOnly: boolean;
  client: DigitalEmployeeApiClient | null;
  management: TaskDigitalEmployeeManagement;
  language: DigitalEmployeeLanguage;
  onOpenConversation?: (conversationId: string) => void;
}

export interface TaskDigitalEmployeeManagement {
  employees: DigitalEmployeeRecord[];
  projection: TaskWorkManagementProjection | null;
  loadState: 'loading' | 'ready' | 'failed';
  busy: string | null;
  error: string | null;
  load(): Promise<void>;
  act(identity: string, operation: () => Promise<unknown>): Promise<boolean>;
}

export function useTaskDigitalEmployeeManagement(props: Pick<TaskDigitalEmployeePanelProps, 'taskId' | 'projectId' | 'client' | 'language'>): TaskDigitalEmployeeManagement {
  const zh = props.language === 'zh-CN';
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  const [projection, setProjection] = useState<TaskWorkManagementProjection | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!props.client) return;
    setLoadState('loading');
    try {
      const [nextEmployees, nextProjection] = await Promise.all([props.client.loadProjectDigitalEmployees(props.projectId), props.client.loadTaskWorkManagement(props.taskId)]);
      setEmployees(nextEmployees.filter((employee) => employee.enabled && employee.entrypointMigrationState === 'ready' && employee.entrypoint?.kind === 'agent'));
      setProjection(nextProjection);
      setError(null);
      setLoadState('ready');
    } catch (cause) {
      setLoadState('failed');
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    }
  }, [props.client, props.projectId, props.taskId, zh]);

  useEffect(() => void load(), [load]);
  const shouldPoll = Boolean(projection?.summary.activeWorkItems || projection?.summary.pendingActions);
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [load, shouldPoll]);

  const act = useCallback(
    async (identity: string, operation: () => Promise<unknown>): Promise<boolean> => {
      setBusy(identity);
      setError(null);
      try {
        await operation();
        await load();
        return true;
      } catch (cause) {
        setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load, zh],
  );

  return { employees, projection, loadState, busy, error, load, act };
}

type ManagementTab = 'overview' | 'collaboration' | 'deliverables' | 'evidence';

export function TaskDigitalEmployeePanel(props: TaskDigitalEmployeePanelProps) {
  const zh = props.language === 'zh-CN';
  const [tab, setTab] = useState<ManagementTab>('collaboration');
  const [decisionOpen, setDecisionOpen] = useState<TaskWorkDecisionRecord | null>(null);
  const [commandEvidenceRunId, setCommandEvidenceRunId] = useState<string | null>(null);

  if (!props.client) return null;
  const { projection, loadState, busy, error, load, act } = props.management;
  const summary = projection?.summary;
  const pendingDecisions = projection?.managerDecisions.filter((decision) => decision.status === 'pending') ?? [];
  const pendingConversationRequests = projection?.conversationRequests ?? [];

  return (
    <section className="task-work-cockpit" aria-label={zh ? '数字员工管理驾驶舱' : 'Digital employee management cockpit'}>
      <header className="task-work-cockpit-header">
        <nav aria-label={zh ? '任务详情页签' : 'Task detail tabs'}>
          {(['overview', 'collaboration', 'deliverables', 'evidence'] as const).map((value) => (
            <button key={value} type="button" className={tab === value ? 'is-active' : undefined} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}>
              {tabLabel(value, props.language)}
              {value === 'collaboration' && summary?.activeWorkItems ? <small>{summary.activeWorkItems}</small> : null}
              {value === 'deliverables' && summary?.submittedDeliverables ? <small>{summary.submittedDeliverables}</small> : null}
            </button>
          ))}
        </nav>
        <span>
          <Button variant="secondary" size="compact" busy={loadState === 'loading'} aria-label={zh ? '刷新工作管理' : 'Refresh work management'} onClick={() => void load()}>
            <ArrowsClockwise size={16} aria-hidden="true" />
          </Button>
        </span>
      </header>

      {error ? (
        <p className="digital-employee-feedback is-error" role="alert">
          {error}
        </p>
      ) : null}

      {tab === 'overview' ? <WorkOverview projection={projection} language={props.language} /> : null}
      {tab === 'collaboration' ? (
        <div className="task-work-cockpit-grid">
          <WorkItemBoard
            items={projection?.workItems ?? []}
            relationships={projection?.relationships ?? []}
            busy={busy}
            readOnly={props.terminalReadOnly}
            language={props.language}
            onOpenConversation={props.onOpenConversation}
            onRetry={(item) => void act(`retry:${item.id}`, () => props.client!.retryTaskWorkItem(props.taskId, item))}
            onCancel={(item) => void act(`cancel:${item.id}`, () => props.client!.cancelTaskWorkItem(props.taskId, item))}
          />
          <ManagerInbox requests={pendingConversationRequests} decisions={pendingDecisions} language={props.language} onOpenConversation={props.onOpenConversation} onSelect={setDecisionOpen} />
        </div>
      ) : null}
      {tab === 'deliverables' ? <DeliverablesView deliverables={projection?.deliverables ?? []} language={props.language} /> : null}
      {tab === 'evidence' ? <EvidenceView refs={projection?.evidenceRefs ?? []} language={props.language} onOpenConversation={props.onOpenConversation} onOpenCommand={setCommandEvidenceRunId} /> : null}

      {decisionOpen ? (
        <DecisionDialog
          decision={decisionOpen}
          projection={projection}
          client={props.client}
          taskId={props.taskId}
          language={props.language}
          busy={busy === `decision:${decisionOpen.id}`}
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
      {commandEvidenceRunId ? <CommandEvidenceDialog runId={commandEvidenceRunId} client={props.client} language={props.language} onDismiss={() => setCommandEvidenceRunId(null)} /> : null}
    </section>
  );
}

function WorkOverview(props: { projection: TaskWorkManagementProjection | null; language: DigitalEmployeeLanguage }) {
  const zh = props.language === 'zh-CN';
  const summary = props.projection?.summary;
  return (
    <div className="task-work-overview">
      <span>
        <small>{zh ? '工作项' : 'Work items'}</small>
        <strong>{summary?.workItems ?? 0}</strong>
        <p>{zh ? '每个工作项对应一次单独指派的工作。' : 'Each work item represents a separately assigned piece of work.'}</p>
      </span>
      <span>
        <small>{zh ? '待我处理' : 'Needs me'}</small>
        <strong>{summary?.pendingActions ?? 0}</strong>
        <p>{zh ? '会话请求、验收与异常处置。' : 'Conversation requests, acceptance, and recovery.'}</p>
      </span>
      <span>
        <small>{zh ? '正式交付物' : 'Deliverables'}</small>
        <strong>{props.projection?.deliverables.length ?? 0}</strong>
        <p>{zh ? '保留各次交付的内容，供你检查并确认验收。' : 'Keep each delivery for you to review and accept.'}</p>
      </span>
      <span>
        <small>{zh ? '历史执行' : 'Legacy runs'}</small>
        <strong>{summary?.legacyExecutions ?? 0}</strong>
        <p>{zh ? '旧阶段和旧执行只读展示，不会被改写。' : 'Legacy stages and runs remain read-only.'}</p>
      </span>
    </div>
  );
}

function WorkItemBoard(props: {
  items: TaskWorkItemRecord[];
  relationships: Array<Record<string, unknown>>;
  busy: string | null;
  readOnly: boolean;
  language: DigitalEmployeeLanguage;
  onOpenConversation?: (conversationId: string) => void;
  onRetry(item: TaskWorkItemRecord): void;
  onCancel(item: TaskWorkItemRecord): void;
}) {
  const zh = props.language === 'zh-CN';
  return (
    <section className="task-work-board" aria-label={zh ? '工作项' : 'Work items'}>
      <header>
        <span>
          <strong>{zh ? '工作项' : 'Work items'}</strong>
          <small>{zh ? '每次指派创建独立工作项；活动与历史工作项完整保留' : 'Each assignment creates an independent work item; active and historical items remain available'}</small>
        </span>
      </header>
      {props.relationships.length === 0 && props.items.length > 1 ? <p className="task-work-relationship-note">{zh ? '这些是独立指派，当前没有依赖关系。' : 'These are independent assignments with no dependencies.'}</p> : null}
      <div className="task-work-item-list">
        {props.items.map((item) => {
          const current = item.runs.find((run) => run.id === item.currentRunId) ?? item.runs.at(-1);
          return (
            <article key={item.id} className={`task-work-item is-${item.status}`}>
              <span className="task-work-entry-icon" aria-hidden="true">
                {item.entrypointKind === 'command' ? <TerminalWindow size={20} /> : <ChatCircle size={20} />}
              </span>
              <span className="task-work-item-copy">
                <span>
                  <strong>{employeeName(current) || item.title}</strong>
                  <small>
                    {item.entrypointKind === 'command' ? 'Command' : 'Agent'} · {workItemStatus(item.status, props.language)}
                  </small>
                </span>
                <p>{item.description || (zh ? '使用启动时确认的配置执行此任务。' : 'Run this task with the settings confirmed at the start.')}</p>
                {current?.errorMessage ? (
                  <small className="is-error">
                    <VisibleApplicationError error={{ code: current.errorCode, message: current.errorMessage }} language={zh ? 'zh-CN' : 'en'} />
                  </small>
                ) : null}
                {current ? (
                  <small>
                    {zh ? `第 ${current.attempt} 次运行` : `Run ${current.attempt}`} · {runStatus(current.status, props.language)}
                  </small>
                ) : null}
              </span>
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
          <span className="task-work-empty">
            <strong>{zh ? '尚无工作项' : 'No work items yet'}</strong>
            <small>{zh ? '请在上方“执行者”中选择数字员工并配置本次运行。' : 'Choose a digital employee from Executor above and configure this run.'}</small>
          </span>
        ) : null}
      </div>
    </section>
  );
}

function ManagerInbox(props: {
  requests: TaskWorkConversationRequestRecord[];
  decisions: TaskWorkDecisionRecord[];
  language: DigitalEmployeeLanguage;
  onOpenConversation?: (conversationId: string) => void;
  onSelect(decision: TaskWorkDecisionRecord): void;
}) {
  const zh = props.language === 'zh-CN';
  const count = props.requests.length + props.decisions.length;
  return (
    <aside className="task-work-inbox" aria-label={zh ? '待我处理' : 'Needs my attention'}>
      <header>
        <span>
          <strong>{zh ? '待我处理' : 'Needs me'}</strong>
          <small>{count ? (zh ? `${count} 项待办` : `${count} pending`) : zh ? '当前无待办' : 'Nothing pending'}</small>
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
          </button>
        ))}
        {count === 0 ? <p>{zh ? '会话请求、交付物验收和异常处置会集中出现在这里。' : 'Conversation requests, deliverable acceptance, and recovery appear here.'}</p> : null}
      </div>
    </aside>
  );
}

function DeliverablesView(props: { deliverables: TaskWorkDeliverableRecord[]; language: DigitalEmployeeLanguage }) {
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
              v{deliverable.version} · {deliverableStatus(deliverable.status, props.language)}
            </small>
          </span>
          <p>{deliverable.summary}</p>
          <code>{deliverable.contentSha256.slice(0, 16)}…</code>
        </article>
      ))}
      {props.deliverables.length === 0 ? <p>{zh ? '尚无正式交付物。' : 'No formal deliverables yet.'}</p> : null}
    </section>
  );
}

function EvidenceView(props: { refs: Array<Record<string, unknown>>; language: DigitalEmployeeLanguage; onOpenConversation?: (conversationId: string) => void; onOpenCommand(runId: string): void }) {
  const zh = props.language === 'zh-CN';
  return (
    <section className="task-work-evidence">
      <header>
        <strong>{zh ? '证据' : 'Evidence'}</strong>
        <small>{zh ? '查看相关对话、命令日志和历史运行' : 'View related conversations, command logs, and past runs'}</small>
      </header>
      {props.refs.map((ref, index) => (
        <button
          key={`${String(ref.kind)}:${String(ref.id)}:${index}`}
          type="button"
          disabled={typeof ref.id !== 'string' || (ref.kind !== 'conversation' && ref.kind !== 'command_run') || (ref.kind === 'conversation' && !props.onOpenConversation)}
          onClick={() => (typeof ref.id !== 'string' ? undefined : ref.kind === 'conversation' ? props.onOpenConversation?.(ref.id) : ref.kind === 'command_run' ? props.onOpenCommand(ref.id) : undefined)}
        >
          <span>{ref.kind === 'command_run' ? <TerminalWindow size={18} /> : <ChatCircle size={18} />}</span>
          <span>
            <strong>{evidenceLabel(ref.kind, props.language)}</strong>
            <small>{String(ref.id ?? '')}</small>
          </span>
        </button>
      ))}
      {props.refs.length === 0 ? <p>{zh ? '尚无运行证据。' : 'No runtime evidence yet.'}</p> : null}
    </section>
  );
}

export function TaskDigitalEmployeeExecutor(props: {
  taskId: string;
  projectId: string;
  terminalReadOnly: boolean;
  client: DigitalEmployeeApiClient | null;
  skillClient: TaskDigitalEmployeeSkillClient | null;
  language: DigitalEmployeeLanguage;
  management: TaskDigitalEmployeeManagement;
  onLoadCapabilities?: () => Promise<CodexTaskPushCapabilities>;
}) {
  const zh = props.language === 'zh-CN';
  const [selectedEmployee, setSelectedEmployee] = useState<DigitalEmployeeRecord | null>(null);
  if (!props.client) return <strong>{zh ? '不可用' : 'Unavailable'}</strong>;
  const activeItems = activeTaskWorkItems(props.management.projection);
  const options = [
    { value: '', label: zh ? '选择数字员工' : 'Choose an employee' },
    ...props.management.employees.map((employee) => ({ value: employee.id, label: `${employee.name} · ${entrypointLabel(employee, props.language)}`, searchText: `${employee.name} ${employee.role} ${employee.domain}` })),
  ];
  return (
    <span className="task-digital-employee-executor">
      <ZeusSelect
        size="regular"
        ariaLabel={zh ? '选择任务执行者' : 'Choose task executor'}
        value=""
        options={options}
        searchable
        searchPlaceholder={zh ? '搜索员工、岗位或领域' : 'Search employee, role, or domain'}
        emptyLabel={zh ? '没有可执行的数字员工' : 'No runnable digital employees'}
        disabled={props.terminalReadOnly || props.management.loadState === 'loading' || props.management.busy !== null || props.management.employees.length === 0}
        onChange={(employeeId) => {
          const employee = props.management.employees.find((candidate) => candidate.id === employeeId);
          if (employee) setSelectedEmployee(employee);
        }}
        triggerLabel={zh ? '选择数字员工' : 'Choose an employee'}
      />
      {activeItems.length > 0 ? <small className="task-digital-employee-executor-status">{zh ? `${activeItems.length} 个执行者运行中` : `${activeItems.length} active ${activeItems.length === 1 ? 'executor' : 'executors'}`}</small> : null}
      {selectedEmployee ? (
        <TaskEmployeeRunDialog
          key={selectedEmployee.id}
          taskId={props.taskId}
          projectId={props.projectId}
          employee={selectedEmployee}
          acceptedDeliverables={props.management.projection?.deliverables.filter((deliverable) => deliverable.status === 'accepted') ?? []}
          client={props.client}
          skillClient={props.skillClient}
          language={props.language}
          busy={props.management.busy === 'start-executor'}
          operationError={props.management.error}
          onLoadCapabilities={props.onLoadCapabilities}
          onDismiss={() => setSelectedEmployee(null)}
          onSubmit={async (preview) => {
            const success = await props.management.act('start-executor', () => props.client!.createTaskWorkItem(props.taskId, preview));
            if (success) setSelectedEmployee(null);
            return success;
          }}
        />
      ) : null}
    </span>
  );
}

function TaskEmployeeRunDialog(props: {
  taskId: string;
  projectId: string;
  employee: DigitalEmployeeRecord;
  acceptedDeliverables: TaskWorkDeliverableRecord[];
  client: DigitalEmployeeApiClient;
  skillClient: TaskDigitalEmployeeSkillClient | null;
  language: DigitalEmployeeLanguage;
  busy: boolean;
  operationError: string | null;
  onLoadCapabilities?: () => Promise<CodexTaskPushCapabilities>;
  onDismiss(): void;
  onSubmit(preview: TaskWorkPreview): Promise<boolean>;
}) {
  const zh = props.language === 'zh-CN';
  const agentEntrypoint = props.employee.entrypoint?.kind === 'agent' ? props.employee.entrypoint : null;
  const [models, setModels] = useState<CodexTaskPushCapabilities['models']>([]);
  const [capabilities, setCapabilities] = useState<CodexTaskPushCapabilities | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<'create' | 'continue' | null>(null);
  const [workspaceTarget, setWorkspaceTarget] = useState('');
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [config, setConfig] = useState<AgentExecutionConfigValue>(() => initialRunConfig(props.employee));
  const [supplementalInfo, setSupplementalInfo] = useState('');
  const [supplementalAttachments, setSupplementalAttachments] = useState<TaskPushSupplementalAttachmentDraft[]>([]);
  const [supplementalResourceError, setSupplementalResourceError] = useState<string | null>(null);
  const [selectedDeliverableIds, setSelectedDeliverableIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<TaskWorkPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const previewVersion = useRef(0);
  const supplementalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const loadCapabilitiesRef = useRef(props.onLoadCapabilities);
  loadCapabilitiesRef.current = props.onLoadCapabilities;
  const inputResources = useConversationInputResources({
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
    setCapabilityError(null);
    const request = loadCapabilitiesRef.current ? loadCapabilitiesRef.current() : props.client.loadDigitalEmployeeCapabilities();
    void request
      .then((nextCapabilities) => {
        if (!active) return;
        const taskCapabilities = 'repositories' in nextCapabilities ? nextCapabilities : null;
        const initialWorkspace = taskCapabilities ? initialTaskWorkWorkspaceChoice(taskCapabilities) : ({ mode: 'create' } as const);
        setCapabilities(taskCapabilities);
        setWorkspaceMode(initialWorkspace?.mode === 'create' ? 'create' : initialWorkspace ? 'continue' : null);
        setWorkspaceTarget(initialWorkspace?.mode === 'existing' ? `environment:${initialWorkspace.environmentId}` : initialWorkspace?.mode === 'local' ? `local:${initialWorkspace.branchName}` : '');
        setModels(nextCapabilities.models);
        setConfig((current) => {
          if (current.model) return current;
          const model =
            nextCapabilities.models.find((candidate) => candidate.id === ('preferredModel' in nextCapabilities ? nextCapabilities.preferredModel : '')) ?? nextCapabilities.models.find((candidate) => candidate.available !== false);
          return model
            ? {
                ...current,
                agentKind: model.agentKind ?? 'codex',
                model: model.id,
                reasoningEffort: model.defaultReasoningEffort ?? model.supportedReasoningEfforts[0] ?? '',
                serviceTier: model.defaultServiceTier ?? '',
              }
            : current;
        });
      })
      .catch((cause) => {
        if (active) setCapabilityError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
      });
    return () => {
      active = false;
    };
  }, [agentEntrypoint, props.client, zh]);

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
          employeeId: props.employee.id,
          supplementalInfo: supplementalInfo.trim() || null,
          ...(supplementalAttachments.length > 0 ? { supplementalAttachments: taskPushSupplementalRequestAttachments(supplementalAttachments) } : {}),
          modelOverride: config.model || null,
          reasoningEffort: config.reasoningEffort || null,
          serviceTier: config.serviceTier || null,
          workMode: config.workMode,
          permissionMode: config.permissionMode,
          promptOverride: config.prompt,
          skillIds: config.skillIds,
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
  }, [agentEntrypoint, config, props.client, props.employee.id, props.taskId, selectedDeliverableIds, supplementalAttachments, supplementalInfo, workspaceMode, workspaceTarget, zh]);

  const existingEnvironments = capabilities?.existingEnvironments ?? [];
  const canContinueEnvironment = (environment: NonNullable<CodexTaskPushCapabilities['existingEnvironments']>[number]): boolean => environment.available;
  const localTaskBranches = capabilities ? commonLocalTaskBranches(capabilities) : [];
  const continuationTargets = [
    ...existingEnvironments.filter(canContinueEnvironment).map((environment) => `environment:${environment.id}`),
    ...localTaskBranches.filter((branch) => branch.available).map((branch) => `local:${branch.branchName}`),
  ];
  const selectedEnvironment = workspaceTarget.startsWith('environment:') ? existingEnvironments.find((environment) => environment.id === workspaceTarget.slice('environment:'.length)) : undefined;
  const selectedLocalBranch = workspaceTarget.startsWith('local:') ? localTaskBranches.find((branch) => branch.branchName === workspaceTarget.slice('local:'.length)) : undefined;

  async function submit(): Promise<void> {
    if (!preview || preview.blockers.length > 0 || inputResources.processing) return;
    setSubmitError(null);
    const success = await props.onSubmit(preview);
    if (!success) setSubmitError(zh ? '本次运行未能启动，请查看页面上的具体原因。' : 'This run could not start. See the specific cause on this page.');
  }

  return (
    <ModalPortal rootClassName="task-work-run-root" backdropClassName="task-work-run-backdrop" dismissDisabled={props.busy} onDismiss={props.onDismiss}>
      <section className="task-work-run-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="task-work-run-title">
        <header>
          <span>
            <strong id="task-work-run-title">{zh ? '开始任务执行' : 'Start task execution'}</strong>
            <small>{zh ? '修改只用于本次工作，不改变员工或模板的默认设置。' : 'Changes apply only to this run and do not change employee or template defaults.'}</small>
          </span>
          <Button variant="secondary" size="compact" disabled={props.busy} onClick={props.onDismiss}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </header>
        <div className="task-work-run-body">
          <section className="task-work-run-identity" aria-label={zh ? '只读员工身份' : 'Read-only employee identity'}>
            <span>
              <small>{zh ? '员工' : 'Employee'}</small>
              <strong>{props.employee.name}</strong>
            </span>
            <span>
              <small>{zh ? '岗位与领域' : 'Role and domain'}</small>
              <strong>{props.employee.role}</strong>
              <p>{props.employee.domain || (zh ? '通用' : 'General')}</p>
            </span>
            <span>
              <small>{zh ? '运行方式' : 'Runtime'}</small>
              <strong>{entrypointLabel(props.employee, props.language)}</strong>
            </span>
            <span>
              <small>{zh ? '员工默认值' : 'Employee defaults'}</small>
              <strong>{props.employee.permissionMode}</strong>
              <p>{zh ? `${props.employee.skillIds.length} 个 Skill` : `${props.employee.skillIds.length} skills`}</p>
            </span>
          </section>

          <section className="task-work-run-supplemental" aria-busy={inputResources.processing || undefined} aria-labelledby="task-work-run-supplemental-label">
            <label id="task-work-run-supplemental-label" htmlFor="task-work-run-supplemental-input">
              {zh ? '补充信息' : 'Supplemental information'}
            </label>
            <TaskPushSupplementalAttachmentCards
              attachments={supplementalAttachments}
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
              placeholder={zh ? '例如：本次优先处理的边界、已知线索或验收重点' : 'For example: priorities, known clues, or acceptance focus for this work item'}
              disabled={props.busy || inputResources.processing}
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

          {agentEntrypoint ? (
            <AgentExecutionConfigFields value={config} models={models} skillClient={props.skillClient} projectId={props.projectId} language={props.language} compact onChange={(patch) => setConfig((current) => ({ ...current, ...patch }))} />
          ) : null}

          {props.acceptedDeliverables.length > 0 ? (
            <details className="task-work-context-details">
              <summary>{zh ? `已验收交付物上下文（已选 ${selectedDeliverableIds.length}）` : `Accepted deliverable context (${selectedDeliverableIds.length} selected)`}</summary>
              {props.acceptedDeliverables.map((deliverable) => (
                <label key={deliverable.id} className="task-work-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedDeliverableIds.includes(deliverable.id)}
                    onChange={(event) => setSelectedDeliverableIds((current) => (event.currentTarget.checked ? [...current, deliverable.id] : current.filter((id) => id !== deliverable.id)))}
                  />
                  <span>
                    {deliverable.title} · v{deliverable.version}
                  </span>
                </label>
              ))}
            </details>
          ) : null}

          {preview ? (
            <section className="task-work-preview" aria-label={zh ? '本次使用的配置' : 'Settings for this run'}>
              <span>
                <small>{zh ? '执行能力' : 'Execution capability'}</small>
                <strong>{zh ? 'Agent 会话' : 'Agent conversation'}</strong>
              </span>
              {preview.model ? (
                <span>
                  <small>{zh ? '模型与 AI 服务' : 'Model and AI service'}</small>
                  <strong>{String(preview.model.displayName ?? preview.model.id)}</strong>
                  <p>
                    {String(preview.model.agentKind ?? '—')} · {String(preview.model.reasoningEffort ?? '—')} · {String(preview.model.serviceTier ?? '—')}
                  </p>
                </span>
              ) : null}
              <span>
                <small>Skills</small>
                <strong>{preview.skills.length}</strong>
                <p>{preview.skills.map((skill) => skill.name).join(zh ? '、' : ', ') || (zh ? '未选择' : 'None')}</p>
              </span>
              <span>
                <small>{zh ? '权限' : 'Permission'}</small>
                <strong>{String(preview.authority.permissionMode ?? '—')}</strong>
              </span>
              {preview.workspace ? (
                <span>
                  <small>{zh ? '代码工作目录' : 'Code working folder'}</small>
                  <strong>{workspacePreviewLabel(preview.workspace, zh)}</strong>
                </span>
              ) : null}
            </section>
          ) : null}
          {preview?.promptPreview ? <TaskPushLayoutPreview layout={preview.promptPreview} language={props.language} /> : null}
          {previewBusy ? (
            <p className="task-work-preview-status" role="status">
              {zh ? '正在更新运行配置预览…' : 'Updating the run settings preview…'}
            </p>
          ) : null}
          {capabilityError || previewError || supplementalResourceError || props.operationError || submitError ? (
            <p className="digital-employee-feedback is-error" role="alert">
              {capabilityError ?? previewError ?? supplementalResourceError ?? props.operationError ?? submitError}
            </p>
          ) : null}
          {preview?.blockers.map((blocker) => (
            <p key={blocker.code} className="digital-employee-feedback is-error">
              <WarningCircle size={17} aria-hidden="true" />
              <VisibleApplicationError error={blocker} language={zh ? 'zh-CN' : 'en'} />
            </p>
          ))}
        </div>
        <footer>
          <small>{zh ? '确认后创建独立工作项；不会停止或改写其他执行者。' : 'Confirmation creates an independent work item without stopping or changing other executors.'}</small>
          <Button
            variant="primary"
            size="regular"
            busy={props.busy || inputResources.processing}
            disabled={!preview || previewBusy || inputResources.processing || preview.blockers.length > 0 || Boolean(capabilityError || supplementalResourceError)}
            onClick={() => void submit()}
          >
            {zh ? '开始执行' : 'Start execution'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

function initialRunConfig(employee: DigitalEmployeeRecord): AgentExecutionConfigValue {
  const entrypoint = employee.entrypoint?.kind === 'agent' ? employee.entrypoint : null;
  return {
    agentKind: entrypoint?.agentKind ?? employee.agentKind,
    model: entrypoint?.modelPolicy.defaultModel ?? employee.model ?? '',
    reasoningEffort: employee.reasoningEffort ?? '',
    serviceTier: employee.serviceTier ?? '',
    workMode: employee.workMode,
    permissionMode: entrypoint?.authorityPolicy.permissionMode ?? employee.permissionMode,
    skillIds: [...(entrypoint?.skillPolicy.allowedSkillIds ?? employee.skillIds)],
    prompt: entrypoint?.prompt ?? employee.prompt,
  };
}

function currentWorkRun(item: TaskWorkItemRecord): TaskWorkItemRecord['runs'][number] | undefined {
  return item.runs.find((run) => run.id === item.currentRunId) ?? item.runs.at(-1);
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

function workspacePreviewLabel(workspace: NonNullable<TaskWorkPreview['workspace']>, zh: boolean): string {
  if (workspace.mode === 'direct') return zh ? '项目目录' : 'Project directory';
  if (workspace.mode === 'existing') return zh ? '继续已有任务分支' : 'Continue existing task branches';
  const branches = Array.from(new Set(workspace.repositories.map((repository) => repository.branchName)));
  if (workspace.mode === 'local') return branches.length === 1 ? branches[0]! : zh ? `${branches.length} 个已有本地分支` : `${branches.length} existing local branches`;
  return branches.length === 1 ? branches[0]! : zh ? `${branches.length} 个新任务分支` : `${branches.length} new task branches`;
}

function activeTaskWorkItems(projection: TaskWorkManagementProjection | null): TaskWorkItemRecord[] {
  return (projection?.workItems ?? []).filter((item) => {
    const run = currentWorkRun(item);
    return run ? ['prepared', 'dispatching', 'active', 'waiting_input'].includes(run.status) : item.status === 'queued' || item.status === 'active';
  });
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
    <ModalPortal rootClassName="task-work-decision-root" backdropClassName="task-work-decision-backdrop" onDismiss={props.onDismiss}>
      <section className="task-work-decision-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="task-work-command-evidence-title">
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
  onDismiss(): void;
  onAccept(deliverable: TaskWorkDeliverableRecord): Promise<void>;
  onRequestChanges(deliverable: TaskWorkDeliverableRecord, reason: string): Promise<void>;
  onRespond(response: Record<string, unknown>): Promise<void>;
}) {
  const zh = props.language === 'zh-CN';
  const [reason, setReason] = useState('');
  const [commandParameters, setCommandParameters] = useState<Record<string, string | number | boolean>>({});
  const [deliverableContent, setDeliverableContent] = useState<string | null>(null);
  const [deliverableContentError, setDeliverableContentError] = useState<string | null>(null);
  const deliverable = props.decision.deliverableId ? (props.projection?.deliverables.find((candidate) => candidate.id === props.decision.deliverableId) ?? null) : null;
  const command = isRecord(props.decision.requestPayload.command) ? props.decision.requestPayload.command : null;
  const commandParametersSchema = command && Array.isArray(command.parameters) ? command.parameters.filter(isRecord) : [];
  useEffect(() => {
    if (!deliverable) return;
    let active = true;
    setDeliverableContent(null);
    setDeliverableContentError(null);
    void props.client
      .loadTaskWorkDeliverableContent(props.taskId, deliverable.id)
      .then((result) => {
        if (active) setDeliverableContent(result.content);
      })
      .catch((cause) => {
        if (active) setDeliverableContentError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
      });
    return () => {
      active = false;
    };
  }, [deliverable?.id, props.client, props.taskId, zh]);
  return (
    <ModalPortal rootClassName="task-work-decision-root" backdropClassName="task-work-decision-backdrop" dismissDisabled={props.busy} onDismiss={props.onDismiss}>
      <section className="task-work-decision-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="task-work-decision-title">
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
                  v{deliverable.version} · {deliverable.contentSha256.slice(0, 12)}…
                </small>
                <strong>{deliverable.title}</strong>
                <p>{deliverable.summary}</p>
              </span>
              {deliverableContent ? <pre className="task-work-deliverable-content">{deliverableContent}</pre> : <p>{deliverableContentError ?? (zh ? '正在读取正式交付物…' : 'Loading formal deliverable…')}</p>}
              <label>
                <span>{zh ? '要求修改' : 'Request changes'}</span>
                <textarea rows={4} maxLength={4_000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={zh ? '说明必须修改的内容…' : 'Describe the required changes…'} />
              </label>
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
        <footer>
          {deliverable ? (
            <>
              <Button variant="secondary" size="compact" busy={props.busy && Boolean(reason)} disabled={!reason.trim()} onClick={() => void props.onRequestChanges(deliverable, reason.trim())}>
                {zh ? '要求修改' : 'Request changes'}
              </Button>
              <Button variant="primary" size="compact" busy={props.busy && !reason} disabled={!deliverableContent} onClick={() => void props.onAccept(deliverable)}>
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
      </section>
    </ModalPortal>
  );
}

function tabLabel(tab: ManagementTab, language: DigitalEmployeeLanguage): string {
  const zh = language === 'zh-CN';
  return tab === 'overview' ? (zh ? '概览' : 'Overview') : tab === 'collaboration' ? (zh ? '协作' : 'Collaboration') : tab === 'deliverables' ? (zh ? '交付物' : 'Deliverables') : zh ? '证据' : 'Evidence';
}
function entrypointLabel(employee: DigitalEmployeeRecord, language: DigitalEmployeeLanguage): string {
  if (employee.entrypoint?.kind !== 'agent') return language === 'zh-CN' ? '历史配置不可执行' : 'Legacy configuration unavailable';
  return `Agent · ${employee.entrypoint.agentKind}`;
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
function runStatus(status: TaskWorkItemRecord['runs'][number]['status'], language: DigitalEmployeeLanguage): string {
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
