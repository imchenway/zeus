import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { useCallback, useEffect, useRef, useState } from 'react';
import { areRequiredRequestAnswersComplete, buildPendingRequestResponse, normalizeRequestQuestions, supportedRequestDecisions, type RequestQuestion, type SupportedRequestDecision } from '../../session/PendingRequestSurface.js';
import type { CodexTaskPushCapabilities, NativePendingRequest } from '../../session/sessionTypes.js';
import { TaskPushLayoutPreview } from '../../task/TaskModelPushModal.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { AgentExecutionConfigFields, type AgentExecutionConfigValue } from './AgentExecutionConfigFields.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { CommandRunDetail } from '../runtime/runtimeContracts.js';
import type { DigitalEmployeeRecord, TaskWorkDecisionRecord, TaskWorkDeliverableRecord, TaskWorkItemRecord, TaskWorkManagementProjection, TaskWorkPreview } from './digitalEmployeeContracts.js';
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
      setError(errorMessage(cause, zh ? '无法读取任务工作管理状态。' : 'Could not load task work management.'));
    }
  }, [props.client, props.projectId, props.taskId, zh]);

  useEffect(() => void load(), [load]);
  const shouldPoll = Boolean(projection?.summary.activeWorkItems || projection?.summary.pendingManagerDecisions);
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
        setError(errorMessage(cause, zh ? '工作管理操作失败。' : 'Work management action failed.'));
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
          <ManagerInbox decisions={pendingDecisions} language={props.language} onSelect={setDecisionOpen} />
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
        <p>{zh ? '每个工作项是一份独立工作责任。' : 'Each item is an independent responsibility.'}</p>
      </span>
      <span>
        <small>{zh ? '待我处理' : 'Needs me'}</small>
        <strong>{summary?.pendingManagerDecisions ?? 0}</strong>
        <p>{zh ? '补充信息、授权、验收与异常处置。' : 'Input, approval, acceptance, and recovery.'}</p>
      </span>
      <span>
        <small>{zh ? '正式交付物' : 'Deliverables'}</small>
        <strong>{props.projection?.deliverables.length ?? 0}</strong>
        <p>{zh ? '版本化保留，会话结束不等于验收。' : 'Versioned; conversation completion is not acceptance.'}</p>
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
          <small>{zh ? '每个任务同时只运行一个执行者；历史工作项完整保留' : 'One active executor per task; historical work items remain available'}</small>
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
                <p>{item.description || (zh ? '按冻结配置执行当前任务。' : 'Runs from its frozen configuration.')}</p>
                {current?.errorMessage ? <small className="is-error">{current.errorMessage}</small> : null}
                {current ? (
                  <small>
                    {zh ? `第 ${current.attempt} 次运行` : `Run ${current.attempt}`} · {runStatus(current.status, props.language)}
                  </small>
                ) : null}
              </span>
              <span className="task-work-item-actions">
                {current?.conversationId && props.onOpenConversation ? (
                  <Button variant="secondary" size="compact" onClick={() => props.onOpenConversation?.(current.conversationId!)}>
                    {zh ? '查看证据' : 'Evidence'}
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
            <small>{zh ? '请在上方“执行者”中选择数字员工并开始执行。' : 'Choose a digital employee from Executor above to start.'}</small>
          </span>
        ) : null}
      </div>
    </section>
  );
}

function ManagerInbox(props: { decisions: TaskWorkDecisionRecord[]; language: DigitalEmployeeLanguage; onSelect(decision: TaskWorkDecisionRecord): void }) {
  const zh = props.language === 'zh-CN';
  return (
    <aside className="task-work-inbox" aria-label={zh ? '待我处理' : 'Needs my attention'}>
      <header>
        <span>
          <strong>{zh ? '待我处理' : 'Needs me'}</strong>
          <small>{props.decisions.length ? (zh ? `${props.decisions.length} 项待办` : `${props.decisions.length} pending`) : zh ? '当前无待办' : 'Nothing pending'}</small>
        </span>
      </header>
      <div>
        {props.decisions.map((decision) => (
          <button key={decision.id} type="button" onClick={() => props.onSelect(decision)}>
            <span aria-hidden="true">
              {decision.kind === 'deliverable_acceptance' ? <CheckCircle size={19} /> : decision.kind === 'outcome_unknown' || decision.kind === 'command_failure' ? <WarningCircle size={19} /> : <ChatCircle size={19} />}
            </span>
            <span>
              <strong>{decision.title}</strong>
              <small>{decision.prompt}</small>
              <time>{formatDateTime(decision.createdAt, props.language)}</time>
            </span>
          </button>
        ))}
        {props.decisions.length === 0 ? <p>{zh ? '员工的问题、授权、验收和未知结果会集中出现在这里。' : 'Questions, approvals, acceptance, and unknown outcomes appear here.'}</p> : null}
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
        <small>{zh ? '每个版本独立保留验收状态和内容哈希' : 'Every version keeps its acceptance state and content hash'}</small>
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
        <small>{zh ? '会话、命令日志与历史执行只在此下钻' : 'Conversations, command logs, and legacy runs are evidence only'}</small>
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
  const activeItem = activeItems[0] ?? null;
  const activeRun = activeItem ? currentWorkRun(activeItem) : undefined;
  const activeEmployee = activeItem ? props.management.employees.find((employee) => employee.id === activeItem.employeeId) : null;
  const activeEmployeeName = activeEmployee?.name || employeeName(activeRun) || (activeItem ? activeItem.title : '');
  const options = [
    { value: '', label: zh ? '选择数字员工' : 'Choose an employee' },
    ...props.management.employees.map((employee) => ({ value: employee.id, label: `${employee.name} · ${entrypointLabel(employee, props.language)}`, searchText: `${employee.name} ${employee.role} ${employee.domain}` })),
  ];
  if (activeItem && !options.some((option) => option.value === activeItem.employeeId))
    options.push({ value: activeItem.employeeId, label: `${activeEmployeeName} · ${zh ? '历史配置' : 'Saved configuration'}`, searchText: activeEmployeeName });
  return (
    <span className="task-digital-employee-executor">
      <ZeusSelect
        size="regular"
        ariaLabel={zh ? '选择任务执行者' : 'Choose task executor'}
        value={activeItem?.employeeId ?? ''}
        options={options}
        searchable
        searchPlaceholder={zh ? '搜索员工、岗位或领域' : 'Search employee, role, or domain'}
        emptyLabel={zh ? '没有可执行的数字员工' : 'No runnable digital employees'}
        disabled={props.terminalReadOnly || props.management.loadState === 'loading' || props.management.busy !== null || props.management.employees.length === 0}
        onChange={(employeeId) => {
          const employee = props.management.employees.find((candidate) => candidate.id === employeeId);
          if (employee) setSelectedEmployee(employee);
        }}
        triggerLabel={activeItem ? activeEmployeeName : zh ? '选择数字员工' : 'Choose an employee'}
      />
      {activeRun ? (
        <small className="task-digital-employee-executor-status">
          {runStatus(activeRun.status, props.language)}
          {activeItems.length > 1 ? ` · ${zh ? `${activeItems.length} 个历史活动项` : `${activeItems.length} active legacy items`}` : ''}
        </small>
      ) : null}
      {selectedEmployee ? (
        <TaskEmployeeRunDialog
          key={selectedEmployee.id}
          taskId={props.taskId}
          projectId={props.projectId}
          employee={selectedEmployee}
          activeItems={activeItems}
          acceptedDeliverables={props.management.projection?.deliverables.filter((deliverable) => deliverable.status === 'accepted') ?? []}
          client={props.client}
          skillClient={props.skillClient}
          language={props.language}
          busy={props.management.busy === 'start-executor'}
          operationError={props.management.error}
          onLoadCapabilities={props.onLoadCapabilities}
          onDismiss={() => setSelectedEmployee(null)}
          onSubmit={async (preview, replacements) => {
            const success = await props.management.act('start-executor', () => props.client!.createTaskWorkItem(props.taskId, preview, replacements));
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
  activeItems: TaskWorkItemRecord[];
  acceptedDeliverables: TaskWorkDeliverableRecord[];
  client: DigitalEmployeeApiClient;
  skillClient: TaskDigitalEmployeeSkillClient | null;
  language: DigitalEmployeeLanguage;
  busy: boolean;
  operationError: string | null;
  onLoadCapabilities?: () => Promise<CodexTaskPushCapabilities>;
  onDismiss(): void;
  onSubmit(preview: TaskWorkPreview, replacements: Array<{ id: string; expectedRevision: number }>): Promise<boolean>;
}) {
  const zh = props.language === 'zh-CN';
  const agentEntrypoint = props.employee.entrypoint?.kind === 'agent' ? props.employee.entrypoint : null;
  const [models, setModels] = useState<CodexTaskPushCapabilities['models']>([]);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [config, setConfig] = useState<AgentExecutionConfigValue>(() => initialRunConfig(props.employee));
  const [selectedDeliverableIds, setSelectedDeliverableIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<TaskWorkPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const previewVersion = useRef(0);
  const loadCapabilitiesRef = useRef(props.onLoadCapabilities);
  loadCapabilitiesRef.current = props.onLoadCapabilities;

  useEffect(() => {
    if (!agentEntrypoint) return;
    let active = true;
    setCapabilityError(null);
    const request = loadCapabilitiesRef.current ? loadCapabilitiesRef.current().then((capabilities) => ({ models: capabilities.models, preferredModel: capabilities.preferredModel })) : props.client.loadDigitalEmployeeCapabilities();
    void request
      .then((capabilities) => {
        if (!active) return;
        setModels(capabilities.models);
        setConfig((current) => {
          if (current.model) return current;
          const model = capabilities.models.find((candidate) => candidate.id === ('preferredModel' in capabilities ? capabilities.preferredModel : '')) ?? capabilities.models.find((candidate) => candidate.available !== false);
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
        if (active) setCapabilityError(errorMessage(cause, zh ? '无法读取本次执行能力。' : 'Could not load run capabilities.'));
      });
    return () => {
      active = false;
    };
  }, [agentEntrypoint, props.client, zh]);

  useEffect(() => {
    const version = previewVersion.current + 1;
    previewVersion.current = version;
    setPreviewBusy(true);
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      void props.client
        .previewTaskWorkItem(props.taskId, {
          employeeId: props.employee.id,
          modelOverride: config.model || null,
          reasoningEffort: config.reasoningEffort || null,
          serviceTier: config.serviceTier || null,
          workMode: config.workMode,
          permissionMode: config.permissionMode,
          promptOverride: config.prompt,
          skillIds: config.skillIds,
          selectedDeliverableIds,
        })
        .then((nextPreview) => {
          if (previewVersion.current === version) setPreview(nextPreview);
        })
        .catch((cause) => {
          if (previewVersion.current === version) {
            setPreview(null);
            setPreviewError(errorMessage(cause, zh ? '无法生成本次执行预览。' : 'Could not generate this run preview.'));
          }
        })
        .finally(() => {
          if (previewVersion.current === version) setPreviewBusy(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [config, props.client, props.employee.id, props.taskId, selectedDeliverableIds, zh]);

  async function submit(): Promise<void> {
    if (!preview || preview.blockers.length > 0) return;
    setSubmitError(null);
    const success = await props.onSubmit(
      preview,
      props.activeItems.map((item) => ({ id: item.id, expectedRevision: item.revision })),
    );
    if (!success) setSubmitError(zh ? '停止或启动未完成；原运行状态已保留，请查看页面错误并刷新后重试。' : 'Stop or start did not complete. The original run state was preserved; review the error and refresh.');
  }

  return (
    <ModalPortal rootClassName="task-work-run-root" backdropClassName="task-work-run-backdrop" dismissDisabled={props.busy} onDismiss={props.onDismiss}>
      <section className="task-work-run-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="task-work-run-title">
        <header>
          <span>
            <strong id="task-work-run-title">{props.activeItems.length ? (zh ? '切换任务执行者' : 'Switch task executor') : zh ? '开始任务执行' : 'Start task execution'}</strong>
            <small>{zh ? '修改只冻结到本次运行，不回写员工或系统模板。' : 'Changes are frozen into this run and do not update the employee or template.'}</small>
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
              <small>{zh ? '治理上限' : 'Governance ceiling'}</small>
              <strong>{props.employee.permissionMode}</strong>
              <p>{zh ? `${props.employee.skillIds.length} 个 Skill` : `${props.employee.skillIds.length} skills`}</p>
            </span>
          </section>

          {props.activeItems.length > 0 ? (
            <section className="task-work-switch-confirmation" role="note" aria-label={zh ? '停止并切换确认' : 'Stop and switch confirmation'}>
              <WarningCircle size={20} aria-hidden="true" />
              <span>
                <strong>{zh ? `先真实停止以下执行，再启动“${props.employee.name}”` : `Stop the following runs before starting “${props.employee.name}”`}</strong>
                <small>{zh ? '只有全部停止获得耐久确认后才会启动新员工；关闭此弹窗不会改变当前运行。' : 'The new employee starts only after every stop is durably confirmed. Closing this dialog leaves the current runs unchanged.'}</small>
                <ul>
                  {props.activeItems.map((item) => {
                    const run = currentWorkRun(item);
                    return (
                      <li key={item.id}>
                        <span>{employeeName(run) || item.title}</span>
                        <small>{run ? runStatus(run.status, props.language) : item.status}</small>
                      </li>
                    );
                  })}
                </ul>
              </span>
            </section>
          ) : null}

          {agentEntrypoint ? (
            <AgentExecutionConfigFields
              value={config}
              models={models}
              skillClient={props.skillClient}
              projectId={props.projectId}
              language={props.language}
              allowedModelIds={agentEntrypoint.modelPolicy.allowedModels}
              allowedReasoningEfforts={agentEntrypoint.modelPolicy.allowedReasoningEfforts}
              allowedServiceTiers={agentEntrypoint.modelPolicy.allowedServiceTiers}
              allowedSkillIds={agentEntrypoint.skillPolicy.allowedSkillIds}
              maximumPermissionMode={agentEntrypoint.authorityPolicy.permissionMode}
              compact
              onChange={(patch) => setConfig((current) => ({ ...current, ...patch }))}
            />
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
            <section className="task-work-preview" aria-label={zh ? '冻结后的有效配置' : 'Frozen effective configuration'}>
              <span>
                <small>{zh ? '执行能力' : 'Execution capability'}</small>
                <strong>{zh ? 'Agent 会话' : 'Agent conversation'}</strong>
              </span>
              {preview.model ? (
                <span>
                  <small>{zh ? '模型与运行内核' : 'Model and runtime'}</small>
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
            </section>
          ) : null}
          {preview?.promptPreview ? <TaskPushLayoutPreview layout={preview.promptPreview} language={props.language} /> : null}
          {previewBusy ? (
            <p className="task-work-preview-status" role="status">
              {zh ? '正在自动刷新权威预览…' : 'Refreshing authoritative preview…'}
            </p>
          ) : null}
          {capabilityError || previewError || props.operationError || submitError ? (
            <p className="digital-employee-feedback is-error" role="alert">
              {capabilityError ?? previewError ?? props.operationError ?? submitError}
            </p>
          ) : null}
          {preview?.blockers.map((blocker) => (
            <p key={blocker.code} className="digital-employee-feedback is-error">
              <WarningCircle size={17} aria-hidden="true" />
              {blocker.message}
            </p>
          ))}
        </div>
        <footer>
          <small>
            {props.activeItems.length
              ? zh
                ? '停止失败、结果未知或活动集合已变化时，不会启动新员工。'
                : 'A stop failure, unknown outcome, or stale active set prevents the new employee from starting.'
              : zh
                ? '确认一次即创建并启动，不再经过手动预览步骤。'
                : 'One confirmation creates and starts the run without a manual preview step.'}
          </small>
          <Button variant="primary" size="regular" busy={props.busy} disabled={!preview || previewBusy || preview.blockers.length > 0 || Boolean(capabilityError)} onClick={() => void submit()}>
            {props.activeItems.length ? (zh ? '停止并切换' : 'Stop and switch') : zh ? '开始执行' : 'Start execution'}
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
        if (active) setError(errorMessage(cause, zh ? '无法读取命令证据。' : 'Could not load command evidence.'));
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
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [commandParameters, setCommandParameters] = useState<Record<string, string | number | boolean>>({});
  const [parseError, setParseError] = useState<string | null>(null);
  const [deliverableContent, setDeliverableContent] = useState<string | null>(null);
  const [deliverableContentError, setDeliverableContentError] = useState<string | null>(null);
  const deliverable = props.decision.deliverableId ? (props.projection?.deliverables.find((candidate) => candidate.id === props.decision.deliverableId) ?? null) : null;
  const pendingRequest = managedPendingRequest(props.decision);
  const questions = pendingRequest && props.decision.kind === 'input_required' ? normalizeRequestQuestions(pendingRequest) : [];
  const authorizationDecisions = pendingRequest && props.decision.kind === 'authorization' ? supportedRequestDecisions(pendingRequest) : [];
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
        if (active) setDeliverableContentError(errorMessage(cause, zh ? '无法读取交付物正文。' : 'Could not load deliverable content.'));
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
            <strong id="task-work-decision-title">{props.decision.title}</strong>
            <small>{props.decision.prompt}</small>
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
          {props.decision.kind === 'input_required' ? (
            <fieldset className="task-work-manager-questions">
              <legend>{zh ? '补充信息' : 'Additional information'}</legend>
              {questions.map((question) => (
                <ManagerQuestion
                  key={question.id}
                  question={question}
                  answers={answers[question.id] ?? []}
                  otherAnswer={otherAnswers[question.id] ?? ''}
                  language={props.language}
                  onAnswers={(values) => setAnswers((current) => ({ ...current, [question.id]: values }))}
                  onOtherAnswer={(value) => setOtherAnswers((current) => ({ ...current, [question.id]: value }))}
                />
              ))}
              {questions.length === 0 ? (
                <p className="digital-employee-feedback is-error">
                  {zh ? '员工问题缺少可验证的结构，已安全阻止回复。请从证据页检查原始请求。' : 'The employee request has no valid question structure. Reply is blocked; inspect the original request under Evidence.'}
                </p>
              ) : null}
              {parseError ? <p className="digital-employee-feedback is-error">{parseError}</p> : null}
            </fieldset>
          ) : null}
          {props.decision.kind === 'authorization' ? (
            <section className="task-work-manager-authorization">
              <strong>{authorizationTitle(pendingRequest, props.language)}</strong>
              <pre>{authorizationSummary(pendingRequest, props.language)}</pre>
              {authorizationDecisions.length === 0 ? (
                <p className="digital-employee-feedback is-error">{zh ? '授权请求不完整，Zeus 不提供放行操作。' : 'The approval request is incomplete, so Zeus does not offer an allow action.'}</p>
              ) : null}
              {parseError ? <p className="digital-employee-feedback is-error">{parseError}</p> : null}
            </section>
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
              {zh ? '请先核对命令日志和外部现场，再确认成功或失败；任一处置都不会自动重发。' : 'Check command logs and external state, then mark success or failure. Neither action resends the command.'}
            </p>
          ) : null}
          {props.decision.kind === 'command_failure' ? (
            <p className="digital-employee-feedback is-error">
              <WarningCircle size={18} />
              {zh
                ? '命令已明确失败。查看命令证据后可创建一次全新的显式尝试；Zeus 不会复用敏感参数或自动重发。'
                : 'The command failed. After checking evidence, create a new explicit attempt; Zeus will not reuse sensitive parameters or resend automatically.'}
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
          {props.decision.kind === 'input_required' ? (
            <Button
              variant="primary"
              size="compact"
              busy={props.busy}
              disabled={!pendingRequest || !areRequiredRequestAnswersComplete(questions, answers, otherAnswers)}
              onClick={() => {
                try {
                  if (!pendingRequest) throw new Error();
                  const parsed = buildPendingRequestResponse(pendingRequest, answers, otherAnswers, {}, props.language);
                  setParseError(null);
                  void props.onRespond(parsed);
                } catch {
                  setParseError(zh ? '请完成全部问题后再提交。' : 'Complete every question before submitting.');
                }
              }}
            >
              {zh ? '回复并继续运行' : 'Reply and continue'}
            </Button>
          ) : null}
          {props.decision.kind === 'authorization'
            ? authorizationDecisions.map((decision) => (
                <Button
                  key={decision}
                  variant={decision === 'accept' || decision === 'acceptForSession' ? 'primary' : 'secondary'}
                  size="compact"
                  busy={props.busy}
                  onClick={() => {
                    try {
                      if (!pendingRequest) throw new Error();
                      const parsed = buildPendingRequestResponse(pendingRequest, { decision: [decision] }, {}, {}, props.language);
                      setParseError(null);
                      void props.onRespond(parsed);
                    } catch {
                      setParseError(zh ? '该授权请求无法安全处置，请从证据页检查原始请求。' : 'This approval cannot be resolved safely. Inspect the original request under Evidence.');
                    }
                  }}
                >
                  {authorizationDecisionLabel(decision, props.language)}
                </Button>
              ))
            : null}
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

function managedPendingRequest(decision: TaskWorkDecisionRecord): NativePendingRequest | null {
  if (decision.kind !== 'input_required' && decision.kind !== 'authorization') return null;
  const requestId = typeof decision.requestPayload.requestId === 'string' ? decision.requestPayload.requestId : null;
  const requestKind = typeof decision.requestPayload.requestKind === 'string' ? decision.requestPayload.requestKind : null;
  const payload = isRecord(decision.requestPayload.payload) ? decision.requestPayload.payload : null;
  if (!requestId || !requestKind || !payload) return null;
  return {
    id: requestId,
    conversationId: `managed:${decision.workItemId}`,
    turnId: null,
    itemId: null,
    generationId: 'task-work-management-v2',
    type: requestKind,
    status: 'pending',
    payload,
    response: null,
    containsSecret: decision.requestPayload.containsSecret === true,
    expiresAt: decision.expiresAt,
    createdAt: decision.createdAt,
    resolvedAt: null,
  };
}

function ManagerQuestion(props: { question: RequestQuestion; answers: string[]; otherAnswer: string; language: DigitalEmployeeLanguage; onAnswers(values: string[]): void; onOtherAnswer(value: string): void }) {
  const zh = props.language === 'zh-CN';
  const otherValue = managerOtherAnswerValue(props.question);
  if (props.question.kind === 'freeform') {
    return (
      <label className="task-work-manager-question">
        <strong>{props.question.header}</strong>
        <span>{props.question.question}</span>
        {props.question.secret ? (
          <input type="password" value={props.answers[0] ?? ''} onChange={(event) => props.onAnswers([event.target.value])} autoComplete="off" />
        ) : (
          <textarea rows={4} value={props.answers[0] ?? ''} onChange={(event) => props.onAnswers([event.target.value])} />
        )}
        {props.question.secret ? <small>{zh ? '敏感回答不会写入工作项快照或待办记录。' : 'Sensitive answers are not stored in the work item snapshot or decision record.'}</small> : null}
      </label>
    );
  }
  return (
    <fieldset className="task-work-manager-question">
      <legend>{props.question.header}</legend>
      <p>{props.question.question}</p>
      {props.question.options.map((option) => {
        const checked = props.answers.includes(option.label);
        return (
          <label key={option.label}>
            <input
              type={props.question.kind === 'multiple' ? 'checkbox' : 'radio'}
              name={`managed-question-${props.question.id}`}
              checked={checked}
              onChange={(event) => props.onAnswers(updateManagerAnswers(props.question, props.answers, option.label, event.target.checked))}
            />
            <span>
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </span>
          </label>
        );
      })}
      {props.question.allowOther ? (
        <>
          <label>
            <input
              type={props.question.kind === 'multiple' ? 'checkbox' : 'radio'}
              name={`managed-question-${props.question.id}`}
              checked={props.answers.includes(otherValue)}
              onChange={(event) => props.onAnswers(updateManagerAnswers(props.question, props.answers, otherValue, event.target.checked))}
            />
            <span>{zh ? '其他' : 'Other'}</span>
          </label>
          {props.answers.includes(otherValue) ? <input type={props.question.secret ? 'password' : 'text'} value={props.otherAnswer} autoComplete="off" onChange={(event) => props.onOtherAnswer(event.target.value)} /> : null}
        </>
      ) : null}
    </fieldset>
  );
}

function updateManagerAnswers(question: RequestQuestion, current: string[], value: string, checked: boolean): string[] {
  if (question.kind !== 'multiple') return checked ? [value] : [];
  return checked ? [...new Set([...current, value])] : current.filter((entry) => entry !== value);
}

function managerOtherAnswerValue(question: RequestQuestion): string {
  const labels = new Set(question.options.map((option) => option.label));
  let value = '__other__';
  while (labels.has(value)) value += '_';
  return value;
}

function authorizationTitle(request: NativePendingRequest | null, language: DigitalEmployeeLanguage): string {
  const zh = language === 'zh-CN';
  if (request?.type === 'command') return zh ? '允许员工运行命令？' : 'Allow the employee to run this command?';
  if (request?.type === 'file') return zh ? '允许员工修改文件？' : 'Allow the employee to edit these files?';
  if (request?.type === 'permissions') return zh ? '员工请求额外权限' : 'The employee requests additional permissions';
  if (request?.type === 'mcp' || request?.type === 'MCP') return zh ? '员工请求外部工具授权' : 'The employee requests external tool approval';
  return zh ? '员工等待授权' : 'The employee is waiting for approval';
}

function authorizationSummary(request: NativePendingRequest | null, language: DigitalEmployeeLanguage): string {
  if (!request) return language === 'zh-CN' ? '授权请求缺少来源信息。' : 'The approval request has no source details.';
  const payload = request.payload;
  const candidates = [payload.command, payload.cmd, payload.path, payload.cwd, payload.reason, payload.description, payload.toolName, payload.serverName];
  const lines = candidates.flatMap((value) => (typeof value === 'string' && value.trim() ? [value.trim()] : Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [value.join('\n')] : []));
  return lines.length > 0 ? lines.join('\n') : language === 'zh-CN' ? '请在证据页核对原始请求后作出决定。' : 'Review the original request under Evidence before deciding.';
}

function authorizationDecisionLabel(decision: SupportedRequestDecision, language: DigitalEmployeeLanguage): string {
  const zh = language === 'zh-CN';
  const labels = zh
    ? { accept: '允许一次', acceptWithExecpolicyAmendment: '允许类似命令', acceptForSession: '本会话允许', decline: '拒绝', cancel: '取消' }
    : { accept: 'Allow once', acceptWithExecpolicyAmendment: 'Allow similar commands', acceptForSession: 'Allow for session', decline: 'Decline', cancel: 'Cancel' };
  return labels[decision];
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
    ? { prepared: '已准备', dispatching: '派发中', active: '执行中', waiting_input: '等待输入', runtime_completed: '待验收', succeeded: '已成功', failed: '失败', outcome_unknown: '结果未知', cancelled: '已取消' }
    : {
        prepared: 'Prepared',
        dispatching: 'Dispatching',
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
