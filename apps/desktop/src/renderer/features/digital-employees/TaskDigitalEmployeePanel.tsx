import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { useCallback, useEffect, useState } from 'react';
import { areRequiredRequestAnswersComplete, buildPendingRequestResponse, normalizeRequestQuestions, supportedRequestDecisions, type RequestQuestion, type SupportedRequestDecision } from '../../session/PendingRequestSurface.js';
import type { NativePendingRequest } from '../../session/sessionTypes.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { CommandRunDetail } from '../runtime/runtimeContracts.js';
import type { DigitalEmployeeRecord, TaskWorkDecisionRecord, TaskWorkDeliverableRecord, TaskWorkItemRecord, TaskWorkManagementProjection, TaskWorkPreview } from './digitalEmployeeContracts.js';
import { errorMessage, formatDateTime, type DigitalEmployeeLanguage } from './digitalEmployeeUiSupport.js';
import './digitalEmployees.css';

export interface TaskDigitalEmployeePanelProps {
  taskId: string;
  projectId: string;
  terminalReadOnly: boolean;
  client: DigitalEmployeeApiClient | null;
  language: DigitalEmployeeLanguage;
  onOpenConversation?: (conversationId: string) => void;
}

type ManagementTab = 'overview' | 'collaboration' | 'deliverables' | 'evidence';

export function TaskDigitalEmployeePanel(props: TaskDigitalEmployeePanelProps) {
  const zh = props.language === 'zh-CN';
  const [tab, setTab] = useState<ManagementTab>('collaboration');
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  const [projection, setProjection] = useState<TaskWorkManagementProjection | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState<TaskWorkDecisionRecord | null>(null);
  const [commandEvidenceRunId, setCommandEvidenceRunId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!props.client) return;
    setLoadState('loading');
    try {
      const [nextEmployees, nextProjection] = await Promise.all([props.client.loadProjectDigitalEmployees(props.projectId), props.client.loadTaskWorkManagement(props.taskId)]);
      setEmployees(nextEmployees.filter((employee) => employee.enabled));
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

  async function act(identity: string, operation: () => Promise<unknown>): Promise<boolean> {
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
  }

  if (!props.client) return null;
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
          <Button variant="primary" size="compact" disabled={props.terminalReadOnly} onClick={() => setAssignmentOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            {zh ? '指派数字员工' : 'Assign employee'}
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
            onAssign={() => setAssignmentOpen(true)}
          />
          <ManagerInbox decisions={pendingDecisions} language={props.language} onSelect={setDecisionOpen} />
        </div>
      ) : null}
      {tab === 'deliverables' ? <DeliverablesView deliverables={projection?.deliverables ?? []} language={props.language} /> : null}
      {tab === 'evidence' ? <EvidenceView refs={projection?.evidenceRefs ?? []} language={props.language} onOpenConversation={props.onOpenConversation} onOpenCommand={setCommandEvidenceRunId} /> : null}

      {assignmentOpen ? (
        <AssignmentDrawer
          employees={employees}
          acceptedDeliverables={projection?.deliverables.filter((deliverable) => deliverable.status === 'accepted') ?? []}
          client={props.client}
          taskId={props.taskId}
          language={props.language}
          busy={busy === 'assign'}
          onDismiss={() => setAssignmentOpen(false)}
          onSubmit={async (preview, commandParameters) => {
            const success = await act('assign', () => props.client!.createTaskWorkItem(props.taskId, preview, commandParameters));
            if (success) {
              setAssignmentOpen(false);
              setTab('collaboration');
            }
          }}
        />
      ) : null}

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
  onAssign(): void;
}) {
  const zh = props.language === 'zh-CN';
  return (
    <section className="task-work-board" aria-label={zh ? '工作项' : 'Work items'}>
      <header>
        <span>
          <strong>{zh ? '工作项' : 'Work items'}</strong>
          <small>{zh ? '并行工作，不按指派次数推导流程' : 'Parallel work; assignment count never drives behavior'}</small>
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
          <button type="button" className="task-work-empty" onClick={props.onAssign} disabled={props.readOnly}>
            <Plus size={22} aria-hidden="true" />
            <strong>{zh ? '创建第一个工作项' : 'Create the first work item'}</strong>
            <small>{zh ? '选择员工后，Zeus 按主入口直接启动 Agent 或 Command。' : 'Zeus starts the employee’s Agent or Command entrypoint.'}</small>
          </button>
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

function AssignmentDrawer(props: {
  employees: DigitalEmployeeRecord[];
  acceptedDeliverables: TaskWorkDeliverableRecord[];
  client: DigitalEmployeeApiClient;
  taskId: string;
  language: DigitalEmployeeLanguage;
  busy: boolean;
  onDismiss(): void;
  onSubmit(preview: TaskWorkPreview, commandParameters: Record<string, unknown>): Promise<void>;
}) {
  const zh = props.language === 'zh-CN';
  const [employeeId, setEmployeeId] = useState(props.employees[0]?.id ?? '');
  const [selectedDeliverableIds, setSelectedDeliverableIds] = useState<string[]>([]);
  const [modelOverride, setModelOverride] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [serviceTier, setServiceTier] = useState('');
  const [commandParameters, setCommandParameters] = useState<Record<string, unknown>>({});
  const [preview, setPreview] = useState<TaskWorkPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const employee = props.employees.find((candidate) => candidate.id === employeeId) ?? null;

  async function loadPreview(): Promise<void> {
    if (!employeeId) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      setPreview(
        await props.client.previewTaskWorkItem(props.taskId, { employeeId, selectedDeliverableIds, modelOverride: modelOverride || null, reasoningEffort: reasoningEffort || null, serviceTier: serviceTier || null, commandParameters }),
      );
    } catch (cause) {
      setPreviewError(errorMessage(cause, zh ? '无法解析本次指派。' : 'Could not resolve this assignment.'));
    } finally {
      setPreviewBusy(false);
    }
  }

  useEffect(() => {
    setPreview(null);
    setCommandParameters({});
    setModelOverride('');
    setReasoningEffort('');
    setServiceTier('');
  }, [employeeId]);

  return (
    <ModalPortal rootClassName="task-work-assignment-root" backdropClassName="task-work-assignment-backdrop" dismissDisabled={props.busy} onDismiss={props.onDismiss}>
      <section className="task-work-assignment-drawer zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="task-work-assignment-title">
        <header>
          <span>
            <strong id="task-work-assignment-title">{zh ? '指派数字员工' : 'Assign a digital employee'}</strong>
            <small>{zh ? '先预览真实入口、模型、Skill、权限和上下文，再创建工作项。' : 'Preview the resolved entrypoint, model, skills, authority, and context first.'}</small>
          </span>
          <Button variant="secondary" size="compact" disabled={props.busy} onClick={props.onDismiss}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </header>
        <div className="task-work-assignment-body">
          <label>
            <span>{zh ? '数字员工' : 'Employee'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择数字员工' : 'Choose employee'}
              value={employeeId}
              options={props.employees.map((candidate) => ({ value: candidate.id, label: `${candidate.name} · ${entrypointLabel(candidate, props.language)}` }))}
              onChange={setEmployeeId}
              searchable
            />
          </label>
          {employee ? (
            <section className="task-work-assignment-impact">
              <span>
                <small>{zh ? '主执行入口' : 'Primary entrypoint'}</small>
                <strong>{entrypointLabel(employee, props.language)}</strong>
                <p>
                  {employee.entrypoint?.kind === 'agent'
                    ? employee.entrypoint.prompt
                    : employee.entrypoint?.kind === 'command'
                      ? zh
                        ? '指派后直接确认并启动项目命令，不创建模型会话。'
                        : 'Confirms and starts the project command without a model conversation.'
                      : zh
                        ? '该员工尚未完成主入口配置。'
                        : 'This employee needs entrypoint configuration.'}
                </p>
              </span>
            </section>
          ) : null}
          {employee?.entrypoint?.kind === 'agent' ? (
            <fieldset>
              <legend>{zh ? '本次运行覆盖（仅限员工允许范围）' : 'Run overrides (within employee policy)'}</legend>
              <label>
                <span>{zh ? '模型' : 'Model'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '选择本次运行模型' : 'Choose run model'}
                  value={modelOverride}
                  onChange={setModelOverride}
                  options={[{ value: '', label: zh ? '使用员工默认解析值' : 'Use employee default resolution' }, ...employee.entrypoint.modelPolicy.allowedModels.map((value) => ({ value, label: value }))]}
                />
              </label>
              <label>
                <span>{zh ? '推理强度' : 'Reasoning effort'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '选择本次推理强度' : 'Choose reasoning effort'}
                  value={reasoningEffort}
                  onChange={setReasoningEffort}
                  options={[{ value: '', label: zh ? '使用默认值' : 'Use default' }, ...employee.entrypoint.modelPolicy.allowedReasoningEfforts.map((value) => ({ value, label: value }))]}
                  searchable={false}
                />
              </label>
              <label>
                <span>{zh ? '服务速率' : 'Service tier'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '选择本次服务速率' : 'Choose service tier'}
                  value={serviceTier}
                  onChange={setServiceTier}
                  options={[{ value: '', label: zh ? '使用默认值' : 'Use default' }, ...employee.entrypoint.modelPolicy.allowedServiceTiers.map((value) => ({ value, label: value }))]}
                  searchable={false}
                />
              </label>
            </fieldset>
          ) : null}
          {props.acceptedDeliverables.length ? (
            <fieldset>
              <legend>{zh ? '选入上下文的已验收交付物' : 'Accepted deliverables in context'}</legend>
              {props.acceptedDeliverables.map((deliverable) => (
                <label key={deliverable.id} className="task-work-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedDeliverableIds.includes(deliverable.id)}
                    onChange={(event) => setSelectedDeliverableIds((current) => (event.target.checked ? [...current, deliverable.id] : current.filter((id) => id !== deliverable.id)))}
                  />
                  <span>
                    {deliverable.title} · v{deliverable.version}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {preview?.command ? (
            <fieldset>
              <legend>{zh ? '命令参数' : 'Command parameters'}</legend>
              {preview.command.parameters.map((parameter) => (
                <label key={parameter.key}>
                  <span>
                    {parameter.label}
                    {parameter.required ? ' *' : ''}
                    <small>{parameter.description}</small>
                  </span>
                  {parameter.type === 'boolean' ? (
                    <ZeusSelect
                      size="regular"
                      ariaLabel={parameter.label}
                      value={String(commandParameters[parameter.key] ?? '')}
                      options={[
                        { value: '', label: zh ? '请选择' : 'Choose' },
                        { value: 'true', label: zh ? '是' : 'True' },
                        { value: 'false', label: zh ? '否' : 'False' },
                      ]}
                      onChange={(value) => setCommandParameters((current) => ({ ...current, [parameter.key]: value === '' ? undefined : value === 'true' }))}
                    />
                  ) : (
                    <input
                      type={parameter.sensitive ? 'password' : parameter.type === 'number' ? 'number' : 'text'}
                      value={String(commandParameters[parameter.key] ?? '')}
                      onChange={(event) => setCommandParameters((current) => ({ ...current, [parameter.key]: parameter.type === 'number' ? Number(event.target.value) : event.target.value }))}
                      autoComplete="off"
                    />
                  )}
                </label>
              ))}
            </fieldset>
          ) : null}
          {preview ? (
            <section className="task-work-preview">
              <span>
                <small>{zh ? '解析入口' : 'Resolved entrypoint'}</small>
                <strong>{String(preview.entrypoint?.kind ?? '—')}</strong>
              </span>
              {preview.model ? (
                <span>
                  <small>{zh ? '冻结模型' : 'Frozen model'}</small>
                  <strong>{String(preview.model.displayName ?? preview.model.id)}</strong>
                  <p>
                    {String(preview.model.reasoningEffort ?? '—')} · {String(preview.model.serviceTier ?? '—')}
                  </p>
                </span>
              ) : null}
              <span>
                <small>Skills</small>
                <strong>{preview.skills.length}</strong>
                <p>{preview.skills.map((skill) => skill.name).join('、') || (zh ? '未选择' : 'None selected')}</p>
              </span>
              <span>
                <small>{zh ? '上下文' : 'Context'}</small>
                <strong>
                  {selectedDeliverableIds.length} {zh ? '份已验收交付物' : 'accepted deliverables'}
                </strong>
                <p>{zh ? '不包含其他工作项产物或完整会话。' : 'No unselected outputs or full conversations.'}</p>
              </span>
            </section>
          ) : null}
          {preview?.blockers.map((blocker) => (
            <p key={blocker.code} className="digital-employee-feedback is-error">
              <WarningCircle size={17} aria-hidden="true" />
              {blocker.message}
            </p>
          ))}
          {previewError ? <p className="digital-employee-feedback is-error">{previewError}</p> : null}
        </div>
        <footer>
          <Button variant="secondary" size="compact" busy={previewBusy} disabled={!employeeId || props.busy} onClick={() => void loadPreview()}>
            {preview?.command ? (zh ? '重新解析参数' : 'Resolve parameters') : zh ? '预览实际影响' : 'Preview impact'}
          </Button>
          <Button variant="primary" size="compact" busy={props.busy} disabled={!preview || preview.blockers.length > 0 || previewBusy} onClick={() => (preview ? void props.onSubmit(preview, commandParameters) : undefined)}>
            {preview?.command ? (zh ? '确认并启动命令' : 'Confirm and start command') : zh ? '创建 Agent 工作项' : 'Create Agent work item'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
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
  if (!employee.entrypoint) return language === 'zh-CN' ? '需要配置主入口' : 'Entrypoint required';
  return employee.entrypoint.kind === 'command' ? 'Command' : `Agent · ${employee.entrypoint.agentKind}`;
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
