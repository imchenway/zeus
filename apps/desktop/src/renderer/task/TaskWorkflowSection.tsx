import { useEffect, useState } from 'react';
import type { CodexTaskPushCapabilities, CodexTaskPushModelCapability } from '../session/sessionTypes.js';
import type { TaskApiClient } from '../features/tasks/taskApiClient.js';
import type { CreateTaskStageRequest, TaskRecord, TaskStageDeliverableRecord, TaskStageRecord, TaskWorkflowSnapshot, UpdateTaskStageRequest } from '../features/tasks/taskContracts.js';
import { Button } from '../ui/Button.js';
import { formatVisibleApplicationError, useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';

export type TaskWorkflowClient = Pick<
  TaskApiClient,
  | 'loadTaskWorkflow'
  | 'initializeTaskWorkflow'
  | 'updateTaskStage'
  | 'captureTaskStageDeliverable'
  | 'createTaskStageDeliverable'
  | 'acceptTaskStageDeliverable'
  | 'requestTaskStageChanges'
  | 'skipTaskStage'
  | 'loadTaskStageDeliverableContent'
>;

export interface TaskWorkflowSectionProps {
  language: 'zh-CN' | 'en-US';
  task: TaskRecord;
  terminalReadOnly: boolean;
  client: TaskWorkflowClient;
  loadCapabilities: () => Promise<CodexTaskPushCapabilities>;
  onStartStage: (stage: TaskStageRecord) => Promise<void>;
  onOpenConversation: (conversationId: string) => void;
}

const stageStatusCopy = {
  pending: ['待上游完成', 'Waiting'],
  ready: ['可启动', 'Ready'],
  running: ['执行中', 'Running'],
  awaiting_acceptance: ['待验收', 'Review output'],
  accepted: ['已验收', 'Accepted'],
  changes_requested: ['待返工', 'Changes requested'],
  failed: ['启动失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'],
  skipped: ['已跳过', 'Skipped'],
} as const;

export function TaskWorkflowSection(props: TaskWorkflowSectionProps) {
  const zh = props.language === 'zh-CN';
  const [workflow, setWorkflow] = useState<TaskWorkflowSnapshot | null | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<CodexTaskPushCapabilities | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [manualStageId, setManualStageId] = useState<string | null>(null);
  const [manualContent, setManualContent] = useState('');
  const [openedDeliverable, setOpenedDeliverable] = useState<{ id: string; title: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useApplicationErrorDialog(error, { language: zh ? 'zh-CN' : 'en' });

  useEffect(() => {
    let active = true;
    setWorkflow(undefined);
    setEditingStageId(null);
    setManualStageId(null);
    setOpenedDeliverable(null);
    props.client
      .loadTaskWorkflow(props.task.id)
      .then((snapshot) => {
        if (active) setWorkflow(snapshot);
      })
      .catch((caught) => {
        if (active) setError(visibleError(caught, zh));
      });
    return () => {
      active = false;
    };
  }, [props.client, props.task.id, zh]);

  useEffect(() => {
    if (!workflow || workflow.workflow.status !== 'active') return;
    const timer = window.setInterval(() => {
      void props.client
        .loadTaskWorkflow(props.task.id)
        .then(setWorkflow)
        .catch(() => undefined);
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [props.client, props.task.id, workflow?.workflow.id, workflow?.workflow.status]);

  const acceptedCount = workflow?.stages.filter((stage) => stage.status === 'accepted' || stage.status === 'skipped').length ?? 0;

  async function ensureCapabilities(): Promise<CodexTaskPushCapabilities> {
    if (capabilities) return capabilities;
    const loaded = await props.loadCapabilities();
    setCapabilities(loaded);
    return loaded;
  }

  async function run(key: string, operation: () => Promise<TaskWorkflowSnapshot | null | void>): Promise<void> {
    setBusyKey(key);
    setError(null);
    try {
      const result = await operation();
      if (result !== undefined) setWorkflow(result);
    } catch (caught) {
      setError(visibleError(caught, zh));
    } finally {
      setBusyKey(null);
    }
  }

  async function initialize(): Promise<void> {
    await run('initialize', async () => {
      const catalog = await ensureCapabilities();
      return props.client.initializeTaskWorkflow(props.task.id, defaultStages(catalog));
    });
  }

  async function beginEdit(stage: TaskStageRecord): Promise<void> {
    await run(`catalog:${stage.id}`, async () => {
      await ensureCapabilities();
      setEditingStageId(stage.id);
    });
  }

  async function updateStage(stage: TaskStageRecord, patch: Omit<UpdateTaskStageRequest, 'expectedRevision'>): Promise<void> {
    await run(`save:${stage.id}`, () => props.client.updateTaskStage(props.task.id, stage.id, { expectedRevision: stage.revision, ...patch }));
  }

  async function start(stage: TaskStageRecord): Promise<void> {
    await run(`start:${stage.id}`, async () => {
      await props.onStartStage(stage);
      return props.client.loadTaskWorkflow(props.task.id);
    });
  }

  async function requestChanges(stage: TaskStageRecord, deliverable: TaskStageDeliverableRecord): Promise<void> {
    const reason = window.prompt(zh ? '说明需要修改的内容' : 'Describe the requested changes');
    if (!reason?.trim()) return;
    await run(`changes:${deliverable.id}`, () => props.client.requestTaskStageChanges(props.task.id, deliverable.id, stage.revision, reason.trim()));
  }

  async function skip(stage: TaskStageRecord): Promise<void> {
    const reason = window.prompt(zh ? '说明跳过原因' : 'Explain why this stage is skipped');
    if (!reason?.trim()) return;
    await run(`skip:${stage.id}`, () => props.client.skipTaskStage(props.task.id, stage.id, stage.revision, reason.trim()));
  }

  async function openDeliverable(deliverable: TaskStageDeliverableRecord): Promise<void> {
    await run(`content:${deliverable.id}`, async () => {
      const loaded = await props.client.loadTaskStageDeliverableContent(props.task.id, deliverable.id);
      setOpenedDeliverable({ id: deliverable.id, title: deliverable.title, content: loaded.content });
    });
  }

  if (workflow === undefined) {
    return (
      <section className="task-detail-block task-workflow-section" aria-label={zh ? '阶段交付' : 'Stage delivery'}>
        <span className="task-detail-section-heading">
          <strong>{zh ? '阶段交付' : 'Stage delivery'}</strong>
          <small>{zh ? '载入中…' : 'Loading…'}</small>
        </span>
      </section>
    );
  }

  if (workflow === null) {
    return (
      <section className="task-detail-block task-workflow-section task-workflow-empty" aria-label={zh ? '阶段交付' : 'Stage delivery'}>
        <span className="task-detail-section-heading">
          <span>
            <strong>{zh ? '阶段交付' : 'Stage delivery'}</strong>
            <small>{zh ? '计划 → 实施 → 代码审查' : 'Plan → Implement → Code review'}</small>
          </span>
          <Button variant="secondary" size="compact" disabled={props.terminalReadOnly || busyKey !== null} onClick={() => void initialize()}>
            {busyKey === 'initialize' ? (zh ? '正在启用…' : 'Enabling…') : zh ? '启用阶段工作流' : 'Enable workflow'}
          </Button>
        </span>
        <p>{zh ? '每个阶段使用独立会话和模型；正式交付物按版本沉淀，并作为下一阶段的已验收输入。' : 'Each stage gets its own conversation and model. Versioned deliverables become the accepted inputs of the next stage.'}</p>
      </section>
    );
  }

  return (
    <section className="task-detail-block task-workflow-section" aria-label={zh ? '阶段交付' : 'Stage delivery'}>
      <span className="task-detail-section-heading task-workflow-heading">
        <span>
          <strong>{zh ? '阶段交付' : 'Stage delivery'}</strong>
          <small>
            {acceptedCount}/{workflow.stages.length} · {workflow.workflow.status === 'completed' ? (zh ? '已完成' : 'Complete') : zh ? '进行中' : 'Active'}
          </small>
        </span>
        <Button variant="secondary" size="compact" disabled={busyKey !== null} onClick={() => void run('refresh', () => props.client.loadTaskWorkflow(props.task.id))}>
          {zh ? '刷新' : 'Refresh'}
        </Button>
      </span>

      <ol className="task-workflow-stage-list">
        {workflow.stages.map((stage) => (
          <TaskStageItem
            key={stage.id}
            stage={stage}
            language={props.language}
            models={capabilities?.models ?? []}
            editing={editingStageId === stage.id}
            busy={busyKey !== null}
            terminalReadOnly={props.terminalReadOnly}
            manualOpen={manualStageId === stage.id}
            manualContent={manualContent}
            onManualContent={setManualContent}
            onBeginEdit={() => void beginEdit(stage)}
            onCancelEdit={() => setEditingStageId(null)}
            onUpdate={(patch) => void updateStage(stage, patch)}
            onStart={() => void start(stage)}
            onOpenConversation={(conversationId) => props.onOpenConversation(conversationId)}
            onCapture={() => void run(`capture:${stage.id}`, () => props.client.captureTaskStageDeliverable(props.task.id, stage.id))}
            onToggleManual={() => {
              setManualStageId((current) => (current === stage.id ? null : stage.id));
              setManualContent('');
            }}
            onSubmitManual={() =>
              void run(`manual:${stage.id}`, async () => {
                const result = await props.client.createTaskStageDeliverable(props.task.id, stage.id, manualContent);
                setManualStageId(null);
                setManualContent('');
                return result;
              })
            }
            onAccept={(deliverable) => void run(`accept:${deliverable.id}`, () => props.client.acceptTaskStageDeliverable(props.task.id, deliverable.id, stage.revision))}
            onRequestChanges={(deliverable) => void requestChanges(stage, deliverable)}
            onSkip={() => void skip(stage)}
            onOpenDeliverable={(deliverable) => void openDeliverable(deliverable)}
          />
        ))}
      </ol>

      {openedDeliverable ? (
        <section className="task-workflow-deliverable-preview" aria-label={openedDeliverable.title}>
          <span className="task-detail-section-heading">
            <strong>{openedDeliverable.title}</strong>
            <Button variant="secondary" size="compact" onClick={() => setOpenedDeliverable(null)}>
              {zh ? '关闭' : 'Close'}
            </Button>
          </span>
          <pre>{openedDeliverable.content}</pre>
        </section>
      ) : null}
    </section>
  );
}

function TaskStageItem(props: {
  stage: TaskStageRecord;
  language: 'zh-CN' | 'en-US';
  models: CodexTaskPushModelCapability[];
  editing: boolean;
  busy: boolean;
  terminalReadOnly: boolean;
  manualOpen: boolean;
  manualContent: string;
  onManualContent: (content: string) => void;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onUpdate: (patch: Omit<UpdateTaskStageRequest, 'expectedRevision'>) => void;
  onStart: () => void;
  onOpenConversation: (conversationId: string) => void;
  onCapture: () => void;
  onToggleManual: () => void;
  onSubmitManual: () => void;
  onAccept: (deliverable: TaskStageDeliverableRecord) => void;
  onRequestChanges: (deliverable: TaskStageDeliverableRecord) => void;
  onSkip: () => void;
  onOpenDeliverable: (deliverable: TaskStageDeliverableRecord) => void;
}) {
  const zh = props.language === 'zh-CN';
  const stage = props.stage;
  const [promptDraft, setPromptDraft] = useState(stage.prompt);
  useEffect(() => setPromptDraft(stage.prompt), [stage.id, stage.prompt]);
  const editable = !props.terminalReadOnly && (stage.status === 'pending' || stage.status === 'ready') && stage.attempts.length === 0;
  const selectedModel = props.models.find((model) => model.id === stage.modelRef);
  const latestAttempt = stage.attempts.at(-1);
  const currentDeliverable = [...stage.deliverables].reverse().find((deliverable) => deliverable.status === 'submitted' || deliverable.status === 'accepted');
  const canStart = !props.terminalReadOnly && Boolean(stage.modelRef) && (stage.status === 'ready' || stage.status === 'changes_requested' || stage.status === 'failed');
  const statusText = stageStatusCopy[stage.status][zh ? 0 : 1];
  const modelOptions = props.models.filter((model) => model.available !== false).map((model) => ({ value: model.id, label: model.displayName ? `${model.displayName} · ${model.sourceName ?? model.agentKind ?? ''}` : model.id }));
  if (stage.modelRef && !modelOptions.some((option) => option.value === stage.modelRef)) modelOptions.unshift({ value: stage.modelRef, label: `${stage.modelRef} · ${zh ? '当前配置' : 'Current'}` });
  const effortOptions = selectedModel?.supportedReasoningEfforts.map((effort) => ({ value: effort, label: effort })) ?? [];

  return (
    <li className={`task-workflow-stage task-workflow-stage-${stage.status}`}>
      <span className="task-workflow-stage-marker" aria-hidden="true">
        {stage.sequence}
      </span>
      <div className="task-workflow-stage-body">
        <header>
          <span>
            <strong>{stage.title}</strong>
            <small>{stage.description}</small>
          </span>
          <span className="task-workflow-stage-status">{statusText}</span>
        </header>

        {props.editing ? (
          <div className="task-workflow-stage-editor">
            <label>
              <small>{zh ? '模型' : 'Model'}</small>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '阶段模型' : 'Stage model'}
                value={stage.modelRef}
                options={[{ value: '', label: zh ? '请选择模型' : 'Select a model', disabled: true }, ...modelOptions]}
                onChange={(modelRef) => {
                  const model = props.models.find((candidate) => candidate.id === modelRef);
                  props.onUpdate({ modelRef, agentKind: model?.agentKind === 'pi' ? 'pi' : 'codex', effort: model?.defaultReasoningEffort ?? model?.supportedReasoningEfforts[0] ?? null, serviceTier: null });
                }}
              />
            </label>
            <label>
              <small>{zh ? '推理强度' : 'Reasoning effort'}</small>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '阶段推理强度' : 'Stage reasoning effort'}
                value={stage.effort ?? ''}
                options={[{ value: '', label: zh ? '模型默认' : 'Model default' }, ...effortOptions]}
                onChange={(effort) => props.onUpdate({ effort: effort || null })}
              />
            </label>
            {stage.kind === 'implementation' ? (
              <label>
                <small>{zh ? '权限' : 'Permission'}</small>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '阶段权限' : 'Stage permission'}
                  value={stage.permissionMode}
                  options={[
                    { value: 'read-only', label: zh ? '只读' : 'Read only' },
                    { value: 'auto', label: zh ? '自动批准' : 'Auto' },
                    { value: 'full-access', label: zh ? '完全访问' : 'Full access' },
                  ]}
                  onChange={(permissionMode) => props.onUpdate({ permissionMode: permissionMode as TaskStageRecord['permissionMode'] })}
                />
              </label>
            ) : null}
            <label>
              <small>{zh ? '推进方式' : 'Progression'}</small>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '阶段推进方式' : 'Stage progression'}
                value={stage.advanceMode}
                options={[
                  { value: 'manual', label: zh ? '人工验收' : 'Manual acceptance' },
                  { value: 'auto', label: zh ? '提交后自动推进' : 'Auto after submit' },
                ]}
                onChange={(advanceMode) => props.onUpdate({ advanceMode: advanceMode as TaskStageRecord['advanceMode'] })}
              />
            </label>
            <label className="task-workflow-stage-prompt">
              <small>{zh ? '阶段指令' : 'Stage instructions'}</small>
              <textarea value={promptDraft} rows={4} onChange={(event) => setPromptDraft(event.target.value)} />
            </label>
            <span className="task-workflow-stage-editor-actions">
              <Button variant="secondary" size="compact" onClick={props.onCancelEdit}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button
                size="compact"
                disabled={props.busy || promptDraft === stage.prompt}
                onClick={() => {
                  props.onUpdate({ prompt: promptDraft });
                  props.onCancelEdit();
                }}
              >
                {zh ? '保存指令' : 'Save instructions'}
              </Button>
            </span>
          </div>
        ) : (
          <div className="task-workflow-stage-meta">
            <span>{stage.modelRef || (zh ? '尚未选择模型' : 'No model selected')}</span>
            <span>{stage.effort || (zh ? '默认强度' : 'Default effort')}</span>
            <span>{stage.advanceMode === 'manual' ? (zh ? '人工验收' : 'Manual') : zh ? '自动推进' : 'Auto'}</span>
          </div>
        )}

        <div className="task-workflow-stage-actions">
          {editable && !props.editing ? (
            <Button variant="secondary" size="compact" disabled={props.busy} onClick={props.onBeginEdit}>
              {zh ? '配置' : 'Configure'}
            </Button>
          ) : null}
          {canStart ? (
            <Button size="compact" disabled={props.busy} onClick={props.onStart}>
              {stage.status === 'changes_requested' || stage.status === 'failed' ? (zh ? '新建返工尝试' : 'Start new attempt') : zh ? '启动阶段' : 'Start stage'}
            </Button>
          ) : null}
          {editable && stage.status === 'ready' ? (
            <Button variant="secondary" size="compact" disabled={props.busy} onClick={props.onSkip}>
              {zh ? '跳过' : 'Skip'}
            </Button>
          ) : null}
          {latestAttempt?.conversationId ? (
            <Button variant="secondary" size="compact" onClick={() => props.onOpenConversation(latestAttempt.conversationId!)}>
              {zh ? '打开阶段会话' : 'Open conversation'}
            </Button>
          ) : null}
          {stage.status === 'running' && latestAttempt?.conversationId ? (
            <>
              <Button variant="secondary" size="compact" disabled={props.busy} onClick={props.onCapture}>
                {zh ? '沉淀最新回复' : 'Capture latest reply'}
              </Button>
              <Button variant="secondary" size="compact" disabled={props.busy} onClick={props.onToggleManual}>
                {zh ? '手动交付' : 'Manual deliverable'}
              </Button>
            </>
          ) : null}
          {stage.status === 'awaiting_acceptance' && currentDeliverable ? (
            <>
              <Button size="compact" disabled={props.busy} onClick={() => props.onAccept(currentDeliverable)}>
                {zh ? '验收并推进' : 'Accept and continue'}
              </Button>
              <Button variant="secondary" size="compact" disabled={props.busy} onClick={() => props.onRequestChanges(currentDeliverable)}>
                {zh ? '要求修改' : 'Request changes'}
              </Button>
            </>
          ) : null}
          {stage.status === 'accepted' && currentDeliverable ? (
            <Button variant="secondary" size="compact" disabled={props.busy} onClick={() => props.onRequestChanges(currentDeliverable)}>
              {stage.kind === 'code_review' ? (zh ? '审查不通过并返工' : 'Reopen implementation') : zh ? '重新打开阶段' : 'Reopen stage'}
            </Button>
          ) : null}
        </div>

        {props.manualOpen ? (
          <div className="task-workflow-manual-deliverable">
            <textarea rows={7} value={props.manualContent} onChange={(event) => props.onManualContent(event.target.value)} placeholder={zh ? '粘贴或撰写正式 Markdown 交付物…' : 'Paste or write the final Markdown deliverable…'} />
            <Button size="compact" disabled={props.busy || !props.manualContent.trim()} onClick={props.onSubmitManual}>
              {zh ? '提交交付物' : 'Submit deliverable'}
            </Button>
          </div>
        ) : null}

        {stage.deliverables.length > 0 ? (
          <ol className="task-workflow-deliverable-list">
            {[...stage.deliverables].reverse().map((deliverable) => (
              <li key={deliverable.id}>
                <button type="button" onClick={() => props.onOpenDeliverable(deliverable)}>
                  <span>
                    <strong>
                      v{deliverable.version} · {deliverable.title}
                    </strong>
                    <small>{deliverable.summary || (zh ? '无摘要' : 'No summary')}</small>
                  </span>
                  <small>{deliverableStatus(deliverable.status, zh)}</small>
                </button>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </li>
  );
}

function defaultStages(capabilities: CodexTaskPushCapabilities): CreateTaskStageRequest[] {
  const available = capabilities.models.filter((model) => model.available !== false);
  const preferred = available.find((model) => model.id === capabilities.preferredModel) ?? available[0];
  if (!preferred) throw new Error('当前没有可用于任务阶段的模型。');
  const gpt = available.find((model) => /(?:^|[/:._-])gpt(?:[/:._-]|$)|codex/iu.test(`${model.id} ${model.model} ${model.displayName ?? ''}`)) ?? preferred;
  const deepSeek = available.find((model) => /deepseek/iu.test(`${model.id} ${model.model} ${model.displayName ?? ''}`));
  return [
    createDefaultStage('plan', 'plan', '计划', '明确范围、步骤、风险与验收方式。', gpt, 'plan', 'read-only', '产出可执行的任务计划；不修改代码或数据。', ['目标与范围', '实施步骤', '风险与验收']),
    createDefaultStage('implementation', 'implementation', '实施', '依据已验收计划完成实现并报告验证结果。', deepSeek, 'default', 'auto', '严格依据上游已验收计划实施；报告实际变更、验证证据和剩余风险。', [
      '实现摘要',
      '变更文件',
      '验证结果',
      '剩余风险',
    ]),
    createDefaultStage('code_review', 'code_review', '代码审查', '在同一实施现场中独立审查，并决定通过或返工。', gpt, 'default', 'read-only', '审查完整任务语义、实现差异和验证证据；明确阻断问题与结论。', [
      '审查结论',
      '阻断问题',
      '改进建议',
      '验证证据',
    ]),
  ];
}

function createDefaultStage(
  stageKey: string,
  kind: CreateTaskStageRequest['kind'],
  title: string,
  description: string,
  model: CodexTaskPushModelCapability | undefined,
  workMode: CreateTaskStageRequest['workMode'],
  permissionMode: CreateTaskStageRequest['permissionMode'],
  prompt: string,
  requiredSections: string[],
): CreateTaskStageRequest {
  return {
    stageKey,
    kind,
    title,
    description,
    agentKind: model?.agentKind === 'pi' ? 'pi' : 'codex',
    modelRef: model?.id ?? '',
    effort: model?.defaultReasoningEffort ?? model?.supportedReasoningEfforts[0] ?? null,
    serviceTier: null,
    workMode,
    permissionMode,
    advanceMode: 'manual',
    prompt,
    outputContract: { format: 'markdown', requiredSections },
  };
}

function deliverableStatus(status: TaskStageDeliverableRecord['status'], zh: boolean): string {
  if (status === 'accepted') return zh ? '已验收' : 'Accepted';
  if (status === 'submitted') return zh ? '待验收' : 'Submitted';
  if (status === 'changes_requested') return zh ? '需修改' : 'Changes requested';
  return zh ? '已被新版本替代' : 'Superseded';
}

function visibleError(error: unknown, zh: boolean): string {
  return formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en');
}
