import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TaskStageDeliverableRecord, TaskStageRecord } from '../tasks/taskContracts.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { DigitalEmployeeCollaborationProjection, DigitalEmployeeExecutionRecord, DigitalEmployeeRecord, DigitalEmployeeStageDecisionInput } from './digitalEmployeeContracts.js';
import { errorMessage, executionIsActive, executionStatusLabel, formatDateTime, type DigitalEmployeeLanguage } from './digitalEmployeeUiSupport.js';
import './digitalEmployees.css';

export interface TaskDigitalEmployeePanelProps {
  taskId: string;
  projectId: string;
  terminalReadOnly: boolean;
  client: DigitalEmployeeApiClient | null;
  language: DigitalEmployeeLanguage;
  onOpenConversation?: (conversationId: string) => void;
}

type DecisionMode = 'handoff' | 'rework' | 'retry';

export function TaskDigitalEmployeePanel(props: TaskDigitalEmployeePanelProps) {
  const zh = props.language === 'zh-CN';
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  const [projection, setProjection] = useState<DigitalEmployeeCollaborationProjection | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisionMode, setDecisionMode] = useState<DecisionMode | null>(null);
  const [reworkReason, setReworkReason] = useState('');
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);

  const loadPanel = useCallback(async () => {
    if (!props.client) return;
    setLoadState('loading');
    setError(null);
    try {
      const [nextEmployees, nextProjection] = await Promise.all([props.client.loadProjectDigitalEmployees(props.projectId), props.client.loadTaskDigitalEmployeeCollaboration(props.taskId)]);
      const enabledEmployees = nextEmployees.filter((employee) => employee.enabled);
      setEmployees(enabledEmployees);
      setProjection(nextProjection);
      setSelectedEmployeeId((current) => (current && enabledEmployees.some((employee) => employee.id === current) ? current : (enabledEmployees[0]?.id ?? '')));
      setLoadState('ready');
    } catch (cause) {
      setLoadState('failed');
      setError(errorMessage(cause, zh ? '无法读取数字员工协作状态。' : 'Could not load digital employee collaboration.'));
    }
  }, [props.client, props.projectId, props.taskId, zh]);

  useEffect(() => {
    void loadPanel();
  }, [loadPanel]);

  const execution = projection?.execution ?? null;
  const workflow = projection?.workflow ?? null;
  const currentStage = useMemo(() => workflow?.stages.find((stage) => stage.id === execution?.currentStageId) ?? null, [execution?.currentStageId, workflow]);
  const candidate = useMemo(() => currentStage?.deliverables.filter((deliverable) => deliverable.status === 'submitted').sort((left, right) => right.version - left.version)[0] ?? null, [currentStage]);
  const finalStage = useMemo(() => Boolean(currentStage && !workflow?.stages.some((stage) => stage.sequence > currentStage.sequence && stage.status !== 'skipped')), [currentStage, workflow]);
  const retryAvailable = Boolean(execution && currentStage && !candidate && (execution.status === 'failed' || execution.status === 'blocked') && execution.deliveryState.retryUnsafe !== true);
  const shouldPoll = Boolean(execution && executionIsActive(execution) && !candidate);

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void loadPanel(), 4_000);
    return () => window.clearInterval(timer);
  }, [loadPanel, shouldPoll]);

  async function run(action: string, operation: () => Promise<unknown>): Promise<boolean> {
    setBusyAction(action);
    setError(null);
    try {
      await operation();
      await loadPanel();
      return true;
    } catch (cause) {
      setError(errorMessage(cause, zh ? '数字员工协作操作失败。' : 'Digital employee collaboration action failed.'));
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  function decisionInput(stage: TaskStageRecord, deliverable: TaskStageDeliverableRecord, current: DigitalEmployeeExecutionRecord): DigitalEmployeeStageDecisionInput {
    return {
      sourceStageId: stage.id,
      deliverableId: deliverable.id,
      deliverableVersion: deliverable.version,
      expectedExecutionRevision: current.revision,
      expectedSourceStageRevision: stage.revision,
    };
  }

  async function assign(): Promise<void> {
    if (!props.client || !selectedEmployeeId || execution) return;
    await run('assign', () => props.client!.assignTaskToDigitalEmployee(props.taskId, selectedEmployeeId));
  }

  async function submitDecision(): Promise<void> {
    if (!props.client || !execution || !currentStage || !selectedEmployeeId || !decisionMode) return;
    if (decisionMode === 'retry') {
      const succeeded = await run('retry', () =>
        props.client!.retryStagedDigitalEmployeeExecution(execution.id, props.taskId, {
          targetEmployeeId: selectedEmployeeId,
          expectedExecutionRevision: execution.revision,
        }),
      );
      if (succeeded) setDecisionMode(null);
      return;
    }
    if (!candidate) return;
    const input = decisionInput(currentStage, candidate, execution);
    if (decisionMode === 'rework' && !reworkReason.trim()) {
      setError(zh ? '请说明需要继续完善的内容。' : 'Describe what should be improved.');
      return;
    }
    const succeeded = await run(decisionMode, () =>
      decisionMode === 'handoff'
        ? props.client!.handoffDigitalEmployeeExecution(execution.id, props.taskId, { ...input, targetEmployeeId: selectedEmployeeId })
        : props.client!.reworkDigitalEmployeeExecution(execution.id, props.taskId, { ...input, targetEmployeeId: selectedEmployeeId, reason: reworkReason.trim() }),
    );
    if (!succeeded) return;
    setDecisionMode(null);
    setReworkReason('');
  }

  async function finalize(): Promise<void> {
    if (!props.client || !execution || !currentStage || !candidate) return;
    await run('finalize', () => props.client!.finalizeDigitalEmployeeExecution(execution.id, props.taskId, decisionInput(currentStage, candidate, execution)));
  }

  async function adoptLegacy(): Promise<void> {
    if (!props.client || !execution || execution.executionMode !== 'legacy_single_conversation') return;
    await run('adopt-legacy', () => props.client!.adoptLegacyDigitalEmployeeExecution(execution.id, props.taskId, execution.revision));
  }

  async function openDeliverable(deliverable: TaskStageDeliverableRecord): Promise<void> {
    if (!props.client) return;
    setBusyAction(`preview:${deliverable.id}`);
    setError(null);
    try {
      const loaded = await props.client.loadDigitalEmployeeDeliverableContent(props.taskId, deliverable.id);
      setPreview({ title: `${deliverable.title} · v${deliverable.version}`, content: loaded.content });
    } catch (cause) {
      setError(errorMessage(cause, zh ? '无法读取完整交付物。' : 'Could not load the full deliverable.'));
    } finally {
      setBusyAction(null);
    }
  }

  if (!props.client) return null;

  return (
    <section className="task-detail-block task-digital-employee-panel task-digital-collaboration" aria-label={zh ? '数字员工协作' : 'Digital employee collaboration'}>
      <span className="task-detail-section-heading">
        <span>
          <strong>{zh ? '数字员工协作' : 'Digital employee collaboration'}</strong>
          <small>{collaborationStatus(execution, currentStage, candidate, props.language)}</small>
        </span>
        <Button variant="secondary" size="compact" busy={loadState === 'loading'} onClick={() => void loadPanel()}>
          {zh ? '刷新' : 'Refresh'}
        </Button>
      </span>

      {error ? (
        <p className="digital-employee-feedback is-error" role="alert">
          {error}
        </p>
      ) : null}

      {!execution ? (
        <div className="task-digital-employee-assignment">
          <span>
            <strong>{zh ? '选择首位数字员工' : 'Choose the first employee'}</strong>
            <small>{zh ? '将创建“方案规划 → 实施 → 代码审查”协作骨架；后续每一阶段仍由你选择员工。' : 'Creates a Plan → Implement → Code review workflow. You choose every later employee.'}</small>
          </span>
          <EmployeeSelect employees={employees} value={selectedEmployeeId} onChange={setSelectedEmployeeId} disabled={props.terminalReadOnly} language={props.language} />
          <Button variant="primary" size="compact" busy={busyAction === 'assign'} disabled={!selectedEmployeeId || props.terminalReadOnly} onClick={() => void assign()}>
            {zh ? '指派并开始方案规划' : 'Assign and start planning'}
          </Button>
        </div>
      ) : execution.executionMode === 'legacy_single_conversation' ? (
        <LegacyExecution
          execution={execution}
          adoptionAvailable={projection?.legacyAdoptionAvailable ?? false}
          busy={busyAction === 'adopt-legacy'}
          disabled={props.terminalReadOnly}
          language={props.language}
          onAdopt={() => void adoptLegacy()}
          onOpenConversation={props.onOpenConversation}
        />
      ) : (
        <>
          {currentStage ? <CurrentStage execution={execution} stage={currentStage} language={props.language} onOpenConversation={props.onOpenConversation} /> : null}

          {candidate && currentStage ? (
            <section className="digital-collaboration-candidate" aria-label={zh ? '待确认阶段交付物' : 'Stage deliverable awaiting confirmation'}>
              <span>
                <small>{zh ? `待确认交付物 · 版本 ${candidate.version}` : `Deliverable awaiting confirmation · v${candidate.version}`}</small>
                <strong>{candidate.title}</strong>
                <p>{candidate.summary || (zh ? '暂无摘要，请打开完整预览。' : 'No summary. Open the full preview.')}</p>
              </span>
              <div className="digital-collaboration-candidate-actions">
                <Button variant="secondary" size="compact" busy={busyAction === `preview:${candidate.id}`} onClick={() => void openDeliverable(candidate)}>
                  {zh ? '预览完整方案' : 'Preview full output'}
                </Button>
                <Button variant="secondary" size="compact" disabled={props.terminalReadOnly || busyAction !== null} onClick={() => setDecisionMode('rework')}>
                  {zh ? '继续完善' : 'Continue improving'}
                </Button>
                {finalStage ? (
                  <Button variant="primary" size="compact" busy={busyAction === 'finalize'} disabled={props.terminalReadOnly} onClick={() => void finalize()}>
                    {zh ? '结束协作并进入交付' : 'Finish collaboration and deliver'}
                  </Button>
                ) : (
                  <Button variant="primary" size="compact" disabled={props.terminalReadOnly || busyAction !== null} onClick={() => setDecisionMode('handoff')}>
                    {zh ? '交给另一位数字员工' : 'Hand off to another employee'}
                  </Button>
                )}
              </div>
              <small>{zh ? '点击交接即表示接受当前展示版本；未确认前不会提交、推送、合入、部署或结束任务。' : 'Handing off accepts this version. No commit, push, merge, deploy, or task completion happens before confirmation.'}</small>
            </section>
          ) : null}

          {retryAvailable && currentStage ? (
            <section className="digital-collaboration-candidate" aria-label={zh ? '失败阶段新尝试' : 'New attempt for failed stage'}>
              <span>
                <small>{zh ? `第 ${execution.attempt} 次尝试已保留` : `Attempt ${execution.attempt} is preserved`}</small>
                <strong>{zh ? '选择数字员工创建新尝试' : 'Choose an employee for a new attempt'}</strong>
                <p>{zh ? '不会改写失败记录；新尝试会重新冻结员工、模型、Skill 与权限快照。' : 'The failed record remains unchanged. The new attempt freezes a fresh employee, model, skill, and permission snapshot.'}</p>
              </span>
              <div className="digital-collaboration-candidate-actions">
                <Button variant="primary" size="compact" disabled={props.terminalReadOnly || busyAction !== null} onClick={() => setDecisionMode('retry')}>
                  {zh ? '创建新尝试' : 'Create new attempt'}
                </Button>
              </div>
            </section>
          ) : null}

          {workflow ? <CollaborationTimeline stages={workflow.stages} language={props.language} onOpenConversation={props.onOpenConversation} onOpenDeliverable={(deliverable) => void openDeliverable(deliverable)} /> : null}
        </>
      )}

      {employees.length === 0 && loadState === 'ready' ? <p className="digital-employee-boundary-note">{zh ? '当前项目没有已启用的数字员工。请先在项目设置中添加员工。' : 'This project has no enabled digital employees.'}</p> : null}
      {projection?.blockingReasons.map((reason) => (
        <p key={reason.code} className="digital-employee-boundary-note">
          {reason.message}
        </p>
      ))}

      {decisionMode && execution && currentStage && (decisionMode === 'retry' || candidate) ? (
        <ModalPortal rootClassName="digital-collaboration-modal-root" backdropClassName="digital-collaboration-modal-backdrop" dismissDisabled={busyAction !== null} onDismiss={() => setDecisionMode(null)}>
          <form
            className="digital-collaboration-dialog zeus-solid-form-surface"
            role="dialog"
            aria-modal="true"
            aria-labelledby="digital-collaboration-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDecision();
            }}
          >
            <header>
              <span>
                <strong id="digital-collaboration-dialog-title">
                  {decisionMode === 'handoff'
                    ? zh
                      ? '交给另一位数字员工'
                      : 'Hand off to another employee'
                    : decisionMode === 'rework'
                      ? zh
                        ? '继续完善当前阶段'
                        : 'Continue improving this stage'
                      : zh
                        ? '为失败阶段创建新尝试'
                        : 'Create a new attempt for the failed stage'}
                </strong>
                <small>
                  {decisionMode === 'retry' ? `${currentStage.title} · ${zh ? `第 ${execution.attempt} 次尝试失败` : `Attempt ${execution.attempt} failed`}` : `${currentStage.title} · ${candidate!.title} v${candidate!.version}`}
                </small>
              </span>
              <Button variant="secondary" size="compact" disabled={busyAction !== null} onClick={() => setDecisionMode(null)}>
                {zh ? '取消' : 'Cancel'}
              </Button>
            </header>
            <label>
              <span>{zh ? '选择数字员工' : 'Choose employee'}</span>
              <EmployeeSelect employees={employees} value={selectedEmployeeId} onChange={setSelectedEmployeeId} language={props.language} />
            </label>
            {decisionMode === 'rework' ? (
              <label>
                <span>{zh ? '需要完善的内容' : 'What should be improved'}</span>
                <textarea value={reworkReason} onChange={(event) => setReworkReason(event.target.value)} maxLength={4_000} rows={5} autoFocus />
              </label>
            ) : decisionMode === 'retry' ? (
              <p>{zh ? '确认后会保留失败尝试，并以所选员工创建新的独立阶段尝试。' : 'The failed attempt remains preserved and a new independent stage attempt starts with the selected employee.'}</p>
            ) : (
              <p>{zh ? '确认后，当前版本会被接受，并作为下一阶段独立会话的精确输入。' : 'On confirmation, this version is accepted as the exact input to a new independent stage conversation.'}</p>
            )}
            <footer>
              <Button variant="primary" size="compact" busy={busyAction === decisionMode} disabled={!selectedEmployeeId || (decisionMode === 'rework' && !reworkReason.trim())} type="submit">
                {zh ? '确认并开始下一次尝试' : 'Confirm and start next attempt'}
              </Button>
            </footer>
          </form>
        </ModalPortal>
      ) : null}

      {preview ? (
        <ModalPortal rootClassName="digital-collaboration-modal-root" backdropClassName="digital-collaboration-modal-backdrop" onDismiss={() => setPreview(null)}>
          <section className="digital-collaboration-preview zeus-solid-form-surface" role="dialog" aria-modal="true" aria-label={preview.title}>
            <header>
              <strong>{preview.title}</strong>
              <Button variant="secondary" size="compact" onClick={() => setPreview(null)}>
                {zh ? '关闭' : 'Close'}
              </Button>
            </header>
            <pre>{preview.content}</pre>
          </section>
        </ModalPortal>
      ) : null}
    </section>
  );
}

function EmployeeSelect(props: { employees: DigitalEmployeeRecord[]; value: string; onChange: (value: string) => void; disabled?: boolean; language: DigitalEmployeeLanguage }) {
  const zh = props.language === 'zh-CN';
  return (
    <ZeusSelect
      size="regular"
      ariaLabel={zh ? '选择项目数字员工' : 'Choose a project digital employee'}
      value={props.value}
      onChange={props.onChange}
      disabled={props.disabled || props.employees.length === 0}
      options={props.employees.map((employee) => ({ value: employee.id, label: `${employee.name} · ${employee.role}`, searchText: `${employee.domain} ${employee.skillIds.join(' ')}` }))}
    />
  );
}

function CurrentStage(props: { execution: DigitalEmployeeExecutionRecord; stage: TaskStageRecord; language: DigitalEmployeeLanguage; onOpenConversation?: (conversationId: string) => void }) {
  const zh = props.language === 'zh-CN';
  const attempt = props.stage.attempts.at(-1);
  return (
    <div className={`task-digital-employee-execution is-${props.execution.status}`}>
      <span className="digital-employee-status-dot" aria-hidden="true" />
      <span className="task-digital-employee-execution-copy">
        <strong>
          {props.stage.title} · {props.execution.employeeSnapshot.name}
        </strong>
        <small>
          {executionStatusLabel(props.execution.status, props.language)} · {zh ? `第 ${attempt?.attemptNumber ?? props.execution.attempt} 次尝试` : `Attempt ${attempt?.attemptNumber ?? props.execution.attempt}`}
        </small>
        <small>
          {props.execution.employeeSnapshot.role} · {props.execution.employeeSnapshot.agentKind} · {props.stage.modelRef || (zh ? '正在解析模型' : 'Resolving model')}
        </small>
      </span>
      <time dateTime={props.execution.updatedAt}>{formatDateTime(props.execution.updatedAt, props.language)}</time>
      {attempt?.conversationId && props.onOpenConversation ? (
        <Button variant="secondary" size="compact" onClick={() => props.onOpenConversation?.(attempt.conversationId!)}>
          {zh ? '打开会话' : 'Open conversation'}
        </Button>
      ) : null}
      {props.execution.errorMessage ? <p role="alert">{props.execution.errorMessage}</p> : null}
    </div>
  );
}

function CollaborationTimeline(props: { stages: TaskStageRecord[]; language: DigitalEmployeeLanguage; onOpenConversation?: (conversationId: string) => void; onOpenDeliverable: (deliverable: TaskStageDeliverableRecord) => void }) {
  const zh = props.language === 'zh-CN';
  return (
    <ol className="digital-collaboration-timeline" aria-label={zh ? '协作时间线' : 'Collaboration timeline'}>
      {props.stages.map((stage) => (
        <li key={stage.id} className={`is-${stage.status}`}>
          <span className="digital-collaboration-stage-index">{stage.sequence}</span>
          <div>
            <header>
              <strong>{stage.title}</strong>
              <small>{stageStatusLabel(stage.status, zh)}</small>
            </header>
            <p>{stage.description}</p>
            {stage.attempts.map((attempt) => (
              <span key={attempt.id} className="digital-collaboration-attempt">
                <span>
                  <strong>{employeeSnapshotName(attempt.employeeSnapshot, zh)}</strong>
                  <small>{zh ? `第 ${attempt.attemptNumber} 次 · ${attempt.status}` : `Attempt ${attempt.attemptNumber} · ${attempt.status}`}</small>
                </span>
                {attempt.conversationId && props.onOpenConversation ? (
                  <button type="button" onClick={() => props.onOpenConversation?.(attempt.conversationId!)}>
                    {zh ? '会话' : 'Conversation'}
                  </button>
                ) : null}
              </span>
            ))}
            {stage.deliverables.map((deliverable) => (
              <button key={deliverable.id} type="button" className="digital-collaboration-deliverable" onClick={() => props.onOpenDeliverable(deliverable)}>
                <span>
                  <strong>{deliverable.title}</strong>
                  <small>
                    v{deliverable.version} · {deliverable.status}
                  </small>
                </span>
                <span>›</span>
              </button>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

function LegacyExecution(props: {
  execution: DigitalEmployeeExecutionRecord;
  adoptionAvailable: boolean;
  busy: boolean;
  disabled: boolean;
  language: DigitalEmployeeLanguage;
  onAdopt: () => void;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const zh = props.language === 'zh-CN';
  return (
    <div className="digital-collaboration-legacy">
      <strong>{props.execution.employeeSnapshot.name}</strong>
      <p>{zh ? '这是旧版单会话执行；Zeus 不会伪造阶段和交付物，也不会改写仍在运行的会话。' : 'This is a legacy single-conversation execution. Zeus will not invent stages or rewrite an active conversation.'}</p>
      <span>
        {props.execution.conversationId && props.onOpenConversation ? (
          <Button variant="secondary" size="compact" onClick={() => props.onOpenConversation?.(props.execution.conversationId!)}>
            {zh ? '打开会话' : 'Open conversation'}
          </Button>
        ) : null}
        {props.adoptionAvailable ? (
          <Button variant="primary" size="compact" busy={props.busy} disabled={props.disabled} onClick={props.onAdopt}>
            {zh ? '将本次输出作为交接起点' : 'Use this output as handoff start'}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function collaborationStatus(execution: DigitalEmployeeExecutionRecord | null, stage: TaskStageRecord | null, candidate: TaskStageDeliverableRecord | null, language: DigitalEmployeeLanguage): string {
  const zh = language === 'zh-CN';
  if (!execution) return zh ? '等待首次指派' : 'Waiting for first assignment';
  if (execution.executionMode === 'legacy_single_conversation') return zh ? '旧版单会话' : 'Legacy single conversation';
  if (candidate) return zh ? `${stage?.title ?? '当前阶段'}已完成，等待确认` : `${stage?.title ?? 'Current stage'} complete; awaiting confirmation`;
  return `${stage?.title ?? (zh ? '当前阶段' : 'Current stage')} · ${executionStatusLabel(execution.status, language)}`;
}

function stageStatusLabel(status: TaskStageRecord['status'], zh: boolean): string {
  const labels: Record<TaskStageRecord['status'], [string, string]> = {
    pending: ['待指派', 'Waiting'],
    ready: ['待启动', 'Ready'],
    running: ['执行中', 'Running'],
    awaiting_acceptance: ['待确认', 'Awaiting confirmation'],
    accepted: ['已接受', 'Accepted'],
    changes_requested: ['待返工', 'Changes requested'],
    failed: ['失败', 'Failed'],
    cancelled: ['已取消', 'Cancelled'],
    skipped: ['已跳过', 'Skipped'],
  };
  return labels[status][zh ? 0 : 1];
}

function employeeSnapshotName(snapshot: Record<string, unknown> | null, zh: boolean): string {
  return snapshot && typeof snapshot.name === 'string' ? snapshot.name : zh ? '未记录员工' : 'Employee not recorded';
}
