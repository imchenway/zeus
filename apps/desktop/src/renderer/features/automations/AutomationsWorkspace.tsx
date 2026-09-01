import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowClockwiseIcon as Refresh } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ClockCountdownIcon as Clock } from '@phosphor-icons/react/dist/csr/ClockCountdown';
import { TrayIcon as Inbox } from '@phosphor-icons/react/dist/csr/Tray';
import { PauseIcon as Pause } from '@phosphor-icons/react/dist/csr/Pause';
import { PlayIcon as Play } from '@phosphor-icons/react/dist/csr/Play';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import type { CodexTaskPushModelCapability } from '../../session/sessionTypes.js';
import type { DashboardClient, ProjectRecord } from '../../apiClient.js';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import type { AutomationBlockStrategy, AutomationConversationMode, AutomationPermissionMode, AutomationRunRecord, AutomationTaskInput, AutomationTaskRecord, AutomationTriggerKind } from './automationContracts.js';

type Draft = AutomationTaskInput & { pluginIdsText: string; maxRunsPerDayText: string; maxTokensPerDayText: string };
type View = 'tasks' | 'inbox';

export function AutomationsWorkspace(props: { client: DashboardClient | null; projects: ProjectRecord[]; language: 'zh-CN' | 'en-US'; onOpenConversation: (run: AutomationRunRecord) => Promise<void> }) {
  const zh = props.language === 'zh-CN';
  const [view, setView] = useState<View>('tasks');
  const [tasks, setTasks] = useState<AutomationTaskRecord[]>([]);
  const [inbox, setInbox] = useState<AutomationRunRecord[]>([]);
  const [models, setModels] = useState<CodexTaskPushModelCapability[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(props.projects));
  const [fullAccessAcknowledged, setFullAccessAcknowledged] = useState(false);
  const editorHeadingRef = useRef<HTMLHeadingElement>(null);

  async function refresh(): Promise<void> {
    if (!props.client) return;
    setLoading(true);
    setError(null);
    try {
      const projectId = draft.projectIds[0] ?? props.projects[0]?.id;
      const [nextTasks, nextInbox, capabilities] = await Promise.all([props.client.loadAutomations(), props.client.loadAutomationInbox(), projectId ? props.client.loadCodexConversationCapabilities(projectId) : Promise.resolve(null)]);
      setTasks(nextTasks);
      setInbox(nextInbox);
      setModels(capabilities?.models.filter((model) => model.available !== false) ?? []);
      setDraft((current) => {
        if (current.modelId || !capabilities?.models.length) return current;
        const preferred = capabilities.models.find((model) => model.model === capabilities.preferredModel) ?? capabilities.models[0]!;
        return { ...current, modelSourceId: preferred.sourceId ?? 'codex', modelId: preferred.model, reasoningEffort: preferred.defaultReasoningEffort ?? null };
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // 首次进入并行读取定义、收件箱和能力；后续由用户显式刷新，避免定时水合打断编辑。
  }, [props.client]);

  const modelOptions = useMemo(
    () =>
      models.map((model) => ({
        value: `${model.sourceId ?? 'codex'}\u0000${model.model}`,
        label: `${model.sourceName ? `${model.sourceName} · ` : ''}${model.displayName ?? model.model}${model.speedLabel === 'flash' ? ' · Flash' : ''}${model.supports1MContext ? ' · 1M' : ''}`,
        model,
      })),
    [models],
  );
  const selectedModelValue = `${draft.modelSourceId}\u0000${draft.modelId}`;
  const selectedModelOption = modelOptions.find((option) => option.value === selectedModelValue);
  const selectedModel = selectedModelOption?.model;
  const exactModelOptions =
    selectedModelOption || !draft.modelId ? modelOptions : [{ value: selectedModelValue, label: `${draft.modelSourceId} · ${draft.modelId} · ${zh ? '当前不可用' : 'Currently unavailable'}`, disabled: true }, ...modelOptions];
  const reasoningEffort = draft.reasoningEffort ?? '';
  const reasoningOptions = [
    { value: '', label: zh ? '模型默认' : 'Model default' },
    ...(selectedModel?.supportedReasoningEfforts ?? []).map((effort) => ({ value: effort, label: effort })),
    ...(reasoningEffort && !selectedModel?.supportedReasoningEfforts.includes(reasoningEffort) ? [{ value: reasoningEffort, label: `${reasoningEffort} · ${zh ? '当前不可用' : 'Currently unavailable'}`, disabled: true }] : []),
  ];
  const unreadCount = inbox.filter((run) => run.unread).length;

  function startCreate(): void {
    setEditingId('new');
    setDraft(emptyDraft(props.projects, modelOptions[0]?.model));
    setFullAccessAcknowledged(false);
    setError(null);
    requestAnimationFrame(() => editorHeadingRef.current?.focus());
  }

  function startEdit(task: AutomationTaskRecord): void {
    setEditingId(task.id);
    setDraft({
      name: task.name,
      description: task.description,
      prompt: task.prompt,
      projectIds: task.projectIds,
      triggerKind: task.triggerKind,
      triggerConfig: task.triggerConfig,
      timezone: task.timezone,
      conversationMode: task.conversationMode,
      originalConversationId: task.originalConversationId,
      permissionMode: task.permissionMode,
      modelSourceId: task.modelSourceId,
      modelId: task.modelId,
      reasoningEffort: task.reasoningEffort,
      serviceTier: task.serviceTier,
      fastMode: task.fastMode,
      skillId: task.skillId,
      pluginIds: task.pluginIds,
      pluginIdsText: task.pluginIds.join(', '),
      blockStrategy: task.blockStrategy,
      queueCapacity: task.queueCapacity,
      maxRunsPerDay: task.maxRunsPerDay,
      maxRunsPerDayText: task.maxRunsPerDay?.toString() ?? '',
      maxTokensPerDay: task.maxTokensPerDay,
      maxTokensPerDayText: task.maxTokensPerDay?.toString() ?? '',
      retentionDays: task.retentionDays,
      notifications: task.notifications,
    });
    setFullAccessAcknowledged(false);
    setError(null);
    requestAnimationFrame(() => editorHeadingRef.current?.focus());
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!props.client || !editingId) return;
    setBusyId(editingId);
    setError(null);
    try {
      const input = normalizeDraft(draft);
      const saved = editingId === 'new' ? await props.client.createAutomation(input) : await props.client.updateAutomation(editingId, tasks.find((task) => task.id === editingId)!.revision, input);
      if (saved.permissionMode === 'full-access' && fullAccessAcknowledged) await props.client.setAutomationFullAccessGrant(saved.id, saved.revision, true);
      setEditingId(null);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function mutate(id: string, operation: () => Promise<unknown>): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusyId(null);
    }
  }

  if (!props.client) {
    return (
      <section className="automations-workspace">
        <p role="alert">{zh ? '自动化服务尚未连接。' : 'Automation service is not connected.'}</p>
      </section>
    );
  }

  return (
    <section className="automations-workspace" aria-labelledby="automations-title">
      <header className="automations-header">
        <div>
          <span className="automations-kicker">ZEUS AUTOMATIONS</span>
          <h1 id="automations-title">{zh ? '自动化' : 'Automations'}</h1>
          <p>{zh ? '把固定指令交给精确的模型、项目和时间，每次运行都保留独立证据。' : 'Bind an instruction to exact models, projects, and time with durable evidence for every run.'}</p>
        </div>
        <div className="automations-header-actions">
          <button type="button" className="automations-icon-button" aria-label={zh ? '刷新自动化' : 'Refresh automations'} onClick={() => void refresh()} disabled={loading}>
            <Refresh aria-hidden="true" />
          </button>
          <Button variant="primary" onClick={startCreate}>
            <Plus aria-hidden="true" />
            {zh ? '新建自动化' : 'New automation'}
          </Button>
        </div>
      </header>

      <nav className="automations-tabs" aria-label={zh ? '自动化视图' : 'Automation views'}>
        <button type="button" aria-current={view === 'tasks' ? 'page' : undefined} onClick={() => setView('tasks')}>
          <Clock aria-hidden="true" />
          {zh ? '任务' : 'Tasks'}
          <span>{tasks.length}</span>
        </button>
        <button type="button" aria-current={view === 'inbox' ? 'page' : undefined} onClick={() => setView('inbox')}>
          <Inbox aria-hidden="true" />
          {zh ? '收件箱' : 'Inbox'}
          {unreadCount ? <span className="automations-unread-count">{unreadCount}</span> : null}
        </button>
      </nav>

      {error ? (
        <p className="automations-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className={`automations-layout${editingId ? ' has-editor' : ''}`}>
        <div className="automations-list" aria-busy={loading}>
          {view === 'tasks' ? (
            tasks.length ? (
              tasks.map((task) => (
                <article className="automation-row" key={task.id} data-status={task.status}>
                  <button type="button" className="automation-row-main" onClick={() => startEdit(task)}>
                    <span className="automation-status-dot" aria-hidden="true" />
                    <span>
                      <strong>{task.name}</strong>
                      <small>
                        {projectNames(task.projectIds, props.projects)} · {modelName(task, models)}
                      </small>
                    </span>
                    <span className="automation-row-schedule">{scheduleLabel(task, zh)}</span>
                  </button>
                  <div className="automation-row-actions">
                    <button
                      type="button"
                      title={zh ? '立即运行' : 'Run now'}
                      aria-label={`${zh ? '立即运行' : 'Run'} ${task.name}`}
                      disabled={busyId === task.id || task.status !== 'active'}
                      onClick={() => void mutate(task.id, () => props.client!.runAutomation(task.id))}
                    >
                      <Play aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      title={task.status === 'active' ? (zh ? '暂停' : 'Pause') : zh ? '恢复' : 'Resume'}
                      aria-label={`${task.status === 'active' ? (zh ? '暂停' : 'Pause') : zh ? '恢复' : 'Resume'} ${task.name}`}
                      disabled={busyId === task.id}
                      onClick={() => void mutate(task.id, () => props.client!.setAutomationStatus(task.id, task.status === 'active' ? 'paused' : 'active'))}
                    >
                      {task.status === 'active' ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      title={zh ? '删除' : 'Delete'}
                      aria-label={`${zh ? '删除' : 'Delete'} ${task.name}`}
                      disabled={busyId === task.id}
                      onClick={() => {
                        if (globalThis.confirm(zh ? `删除“${task.name}”？历史运行仍保留。` : `Delete “${task.name}”? Run history will remain.`)) void mutate(task.id, () => props.client!.deleteAutomation(task.id));
                      }}
                    >
                      <Trash aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <EmptyState title={zh ? '还没有自动化' : 'No automations yet'} body={zh ? '创建第一个自动化，从手动触发开始验证。' : 'Create one and begin with a manual trigger.'} />
            )
          ) : inbox.length ? (
            inbox.map((run) => {
              const task = tasks.find((candidate) => candidate.id === run.automationId);
              return (
                <article className="automation-inbox-row" key={run.id} data-unread={run.unread ? 'true' : 'false'}>
                  <span className={`automation-run-status status-${run.status}`}>{runStatusLabel(run.status, zh)}</span>
                  <div>
                    <strong>{task?.name ?? run.automationId}</strong>
                    <small>
                      {projectNames([run.projectId], props.projects)} · {formatDate(run.completedAt ?? run.createdAt)}
                    </small>
                    {run.errorMessage ? <p>{run.errorMessage}</p> : null}
                    {run.mayOverlapPrevious ? <p className="automation-warning">{zh ? '可能与旧运行重叠' : 'May overlap a previous run'}</p> : null}
                  </div>
                  <div className="automation-inbox-actions">
                    {run.conversationId ? (
                      <button type="button" onClick={() => void props.onOpenConversation(run)}>
                        {zh ? '打开会话' : 'Open conversation'}
                      </button>
                    ) : null}
                    {run.unread ? (
                      <button type="button" onClick={() => void mutate(run.id, () => props.client!.acknowledgeAutomationRun(run.id))}>
                        {zh ? '标为已读' : 'Mark read'}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })
          ) : (
            <EmptyState title={zh ? '收件箱很安静' : 'Inbox is quiet'} body={zh ? '运行进入成功、失败、阻塞或结果未知后会出现在这里。' : 'Terminal runs appear here, including blocked and unknown outcomes.'} />
          )}
        </div>

        {editingId ? (
          <form className="automation-editor" onSubmit={(event) => void submit(event)}>
            <header>
              <div>
                <span>{editingId === 'new' ? (zh ? '新建' : 'New') : zh ? '编辑' : 'Edit'}</span>
                <h2 ref={editorHeadingRef} tabIndex={-1}>
                  {draft.name || (zh ? '未命名自动化' : 'Untitled automation')}
                </h2>
              </div>
              <button type="button" onClick={() => setEditingId(null)}>
                {zh ? '关闭' : 'Close'}
              </button>
            </header>
            <div className="automation-editor-scroll">
              <label>
                <span>{zh ? '名称' : 'Name'}</span>
                <input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
              </label>
              <label>
                <span>{zh ? '指令' : 'Instruction'}</span>
                <textarea required rows={7} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })} />
              </label>
              <fieldset>
                <legend>{zh ? '目标项目' : 'Target projects'}</legend>
                <div className="automation-project-options">
                  {props.projects.map((project) => (
                    <label key={project.id}>
                      <input
                        type="checkbox"
                        checked={draft.projectIds.includes(project.id)}
                        onChange={(event) => setDraft({ ...draft, projectIds: event.currentTarget.checked ? [...draft.projectIds, project.id] : draft.projectIds.filter((id) => id !== project.id) })}
                      />
                      <span>{project.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="automation-form-grid">
                <SelectField label={zh ? '触发方式' : 'Trigger'} value={draft.triggerKind ?? 'manual'} options={triggerOptions(zh)} onChange={(value) => setDraft({ ...draft, triggerKind: value as AutomationTriggerKind })} />
                <label>
                  <span>{zh ? 'IANA 时区' : 'IANA timezone'}</span>
                  <input value={draft.timezone ?? ''} onChange={(event) => setDraft({ ...draft, timezone: event.currentTarget.value })} />
                </label>
              </div>
              <TriggerFields draft={draft} setDraft={setDraft} zh={zh} />
              <label>
                <span>{zh ? '精确模型' : 'Exact model'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '选择精确模型' : 'Choose exact model'}
                  value={selectedModelValue}
                  options={exactModelOptions}
                  onChange={(value) => {
                    const option = modelOptions.find((candidate) => candidate.value === value);
                    if (option) setDraft({ ...draft, modelSourceId: option.model.sourceId ?? 'codex', modelId: option.model.model, reasoningEffort: option.model.defaultReasoningEffort ?? null });
                  }}
                  searchPlaceholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
                  emptyLabel={zh ? '没有可用模型' : 'No available models'}
                  triggerLabel={!draft.modelId ? (zh ? '暂无可用模型' : 'No available models') : undefined}
                  disabled={!modelOptions.length}
                />
              </label>
              <div className="automation-form-grid">
                <label>
                  <span>{zh ? '推理强度' : 'Reasoning effort'}</span>
                  <ZeusSelect
                    size="regular"
                    ariaLabel={zh ? '选择推理强度' : 'Choose reasoning effort'}
                    value={reasoningEffort}
                    options={reasoningOptions}
                    onChange={(value) => setDraft({ ...draft, reasoningEffort: value || null })}
                    disabled={!selectedModel}
                    searchable={false}
                  />
                </label>
                <SelectField
                  label={zh ? '权限' : 'Permission'}
                  value={draft.permissionMode ?? 'read-only'}
                  options={[
                    ['read-only', zh ? '只读' : 'Read only'],
                    ['auto', zh ? '需审批写入' : 'Approve writes'],
                    ['full-access', zh ? '完全访问' : 'Full access'],
                  ]}
                  onChange={(value) => {
                    setDraft({ ...draft, permissionMode: value as AutomationPermissionMode });
                    setFullAccessAcknowledged(false);
                  }}
                />
              </div>
              {draft.permissionMode === 'full-access' ? (
                <label className="automation-risk-ack">
                  <input type="checkbox" checked={fullAccessAcknowledged} onChange={(event) => setFullAccessAcknowledged(event.currentTarget.checked)} />
                  <span>{zh ? '我理解该授权会持续到配置变更或撤销，且可产生不可逆副作用。' : 'I understand this grant persists until configuration changes or revocation and may produce irreversible side effects.'}</span>
                </label>
              ) : null}
              <div className="automation-form-grid">
                <SelectField
                  label={zh ? '会话模式' : 'Conversation mode'}
                  value={draft.conversationMode ?? 'independent'}
                  options={[
                    ['independent', zh ? '每次独立会话' : 'Independent conversation'],
                    ['original', zh ? '追加原会话' : 'Append to original'],
                  ]}
                  onChange={(value) => setDraft({ ...draft, conversationMode: value as AutomationConversationMode })}
                />
                <SelectField
                  label={zh ? '阻塞策略' : 'Blocking policy'}
                  value={draft.blockStrategy ?? 'serial'}
                  options={[
                    ['serial', zh ? '串行排队' : 'Serial queue'],
                    ['discard', zh ? '丢弃新触发' : 'Discard new'],
                    ['cover', zh ? '覆盖旧运行' : 'Cover previous'],
                  ]}
                  onChange={(value) => setDraft({ ...draft, blockStrategy: value as AutomationBlockStrategy })}
                />
              </div>
              {draft.conversationMode === 'original' ? (
                <label>
                  <span>{zh ? '原会话 ID' : 'Original conversation ID'}</span>
                  <input required value={draft.originalConversationId ?? ''} onChange={(event) => setDraft({ ...draft, originalConversationId: event.currentTarget.value })} />
                </label>
              ) : null}
              <details>
                <summary>{zh ? '能力、预算与保留' : 'Capabilities, budgets, and retention'}</summary>
                <div className="automation-form-grid">
                  <label>
                    <span>Skill ID</span>
                    <input value={draft.skillId ?? ''} onChange={(event) => setDraft({ ...draft, skillId: event.currentTarget.value || null })} />
                  </label>
                  <label>
                    <span>Plugin IDs</span>
                    <input value={draft.pluginIdsText} placeholder="plugin-a, plugin-b" onChange={(event) => setDraft({ ...draft, pluginIdsText: event.currentTarget.value })} />
                  </label>
                </div>
                <div className="automation-form-grid">
                  <label>
                    <span>{zh ? '队列容量' : 'Queue capacity'}</span>
                    <input type="number" min="1" max="10000" value={draft.queueCapacity ?? 10} onChange={(event) => setDraft({ ...draft, queueCapacity: event.currentTarget.valueAsNumber })} />
                  </label>
                  <label>
                    <span>{zh ? '保留天数' : 'Retention days'}</span>
                    <input type="number" min="1" max="3650" value={draft.retentionDays ?? 30} onChange={(event) => setDraft({ ...draft, retentionDays: event.currentTarget.valueAsNumber })} />
                  </label>
                </div>
                <div className="automation-form-grid">
                  <label>
                    <span>{zh ? '每日运行上限' : 'Runs per day'}</span>
                    <input type="number" min="1" value={draft.maxRunsPerDayText} placeholder={zh ? '不限' : 'Unlimited'} onChange={(event) => setDraft({ ...draft, maxRunsPerDayText: event.currentTarget.value })} />
                  </label>
                  <label>
                    <span>{zh ? '每日 Token 上限' : 'Tokens per day'}</span>
                    <input type="number" min="1" value={draft.maxTokensPerDayText} placeholder={zh ? '不限' : 'Unlimited'} onChange={(event) => setDraft({ ...draft, maxTokensPerDayText: event.currentTarget.value })} />
                  </label>
                </div>
                <label className="automation-check">
                  <input type="checkbox" checked={draft.fastMode === true} onChange={(event) => setDraft({ ...draft, fastMode: event.currentTarget.checked })} />
                  <span>{zh ? '启用 Fast 服务档位（仅在模型支持时）' : 'Use Fast service tier when supported'}</span>
                </label>
              </details>
            </div>
            <footer>
              <Button variant="secondary" type="button" onClick={() => setEditingId(null)}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button variant="primary" type="submit" busy={busyId === editingId} disabled={!selectedModel || (draft.permissionMode === 'full-access' && !fullAccessAcknowledged)}>
                {zh ? '保存并启用' : 'Save and enable'}
              </Button>
            </footer>
          </form>
        ) : null}
      </div>
    </section>
  );
}

function EmptyState(props: { title: string; body: string }) {
  return (
    <section className="automations-empty">
      <Clock aria-hidden="true" />
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </section>
  );
}

function SelectField(props: { label: string; value: string; options: Array<[string, string]>; onChange(value: string): void }) {
  return (
    <label>
      <span>{props.label}</span>
      <ZeusSelect size="regular" ariaLabel={props.label} value={props.value} options={props.options.map(([value, label]) => ({ value, label }))} onChange={props.onChange} searchable={false} />
    </label>
  );
}

function TriggerFields(props: { draft: Draft; setDraft(value: Draft): void; zh: boolean }) {
  const { draft } = props;
  if (draft.triggerKind === 'interval')
    return (
      <label>
        <span>{props.zh ? '间隔分钟' : 'Interval minutes'}</span>
        <input type="number" min="1" value={draft.triggerConfig?.everyMinutes ?? 60} onChange={(event) => props.setDraft({ ...draft, triggerConfig: { ...draft.triggerConfig, everyMinutes: event.currentTarget.valueAsNumber } })} />
      </label>
    );
  if (draft.triggerKind === 'once')
    return (
      <label>
        <span>{props.zh ? '执行时间' : 'Run at'}</span>
        <input
          type="datetime-local"
          value={draft.triggerConfig?.at?.slice(0, 16) ?? ''}
          onChange={(event) => props.setDraft({ ...draft, triggerConfig: { ...draft.triggerConfig, at: event.currentTarget.value ? new Date(event.currentTarget.value).toISOString() : undefined } })}
        />
      </label>
    );
  if (draft.triggerKind === 'daily' || draft.triggerKind === 'weekly')
    return (
      <label>
        <span>{props.zh ? '当地时间' : 'Local time'}</span>
        <input type="time" value={draft.triggerConfig?.localTime ?? '09:00'} onChange={(event) => props.setDraft({ ...draft, triggerConfig: { ...draft.triggerConfig, localTime: event.currentTarget.value } })} />
      </label>
    );
  if (draft.triggerKind === 'rrule')
    return (
      <label>
        <span>RFC 5545 RRULE</span>
        <input placeholder="FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9" value={draft.triggerConfig?.rrule ?? ''} onChange={(event) => props.setDraft({ ...draft, triggerConfig: { ...draft.triggerConfig, rrule: event.currentTarget.value } })} />
      </label>
    );
  if (draft.triggerKind === 'event')
    return (
      <label>
        <span>{props.zh ? '事件类型（逗号分隔）' : 'Event kinds (comma separated)'}</span>
        <input
          value={draft.triggerConfig?.eventKinds?.join(', ') ?? ''}
          onChange={(event) =>
            props.setDraft({
              ...draft,
              triggerConfig: {
                ...draft.triggerConfig,
                eventKinds: event.currentTarget.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              },
            })
          }
        />
      </label>
    );
  return null;
}

function emptyDraft(projects: ProjectRecord[], model?: CodexTaskPushModelCapability): Draft {
  return {
    name: '',
    description: '',
    prompt: '',
    projectIds: projects[0] ? [projects[0].id] : [],
    triggerKind: 'manual',
    triggerConfig: {},
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    conversationMode: 'independent',
    originalConversationId: null,
    permissionMode: 'read-only',
    modelSourceId: model?.sourceId ?? 'codex',
    modelId: model?.model ?? '',
    reasoningEffort: model?.defaultReasoningEffort ?? null,
    serviceTier: null,
    fastMode: false,
    skillId: null,
    pluginIds: [],
    pluginIdsText: '',
    blockStrategy: 'serial',
    queueCapacity: 10,
    maxRunsPerDay: null,
    maxRunsPerDayText: '',
    maxTokensPerDay: null,
    maxTokensPerDayText: '',
    retentionDays: 30,
    notifications: { success: true, failure: true, blocked: true },
  };
}

function normalizeDraft(draft: Draft): AutomationTaskInput {
  return {
    ...draft,
    pluginIds: draft.pluginIdsText
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    maxRunsPerDay: draft.maxRunsPerDayText ? Number(draft.maxRunsPerDayText) : null,
    maxTokensPerDay: draft.maxTokensPerDayText ? Number(draft.maxTokensPerDayText) : null,
  };
}

function triggerOptions(zh: boolean): Array<[string, string]> {
  return [
    ['manual', zh ? '仅手动' : 'Manual only'],
    ['once', zh ? '单次' : 'Once'],
    ['interval', zh ? '固定间隔' : 'Interval'],
    ['daily', zh ? '每日' : 'Daily'],
    ['weekly', zh ? '每周' : 'Weekly'],
    ['rrule', zh ? '高级 RRULE' : 'Advanced RRULE'],
    ['event', zh ? '事件触发' : 'Event'],
  ];
}

function projectNames(ids: string[], projects: ProjectRecord[]): string {
  return ids.map((id) => projects.find((project) => project.id === id)?.name ?? id).join(', ');
}
function modelName(task: AutomationTaskRecord, models: CodexTaskPushModelCapability[]): string {
  return models.find((model) => (model.sourceId ?? 'codex') === task.modelSourceId && model.model === task.modelId)?.displayName ?? task.modelId;
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function scheduleLabel(task: AutomationTaskRecord, zh: boolean): string {
  if (task.status === 'paused') return zh ? '已暂停' : 'Paused';
  if (task.triggerKind === 'manual') return zh ? '手动触发' : 'Manual';
  return task.nextRunAt ? formatDate(task.nextRunAt) : zh ? '等待计算' : 'Awaiting schedule';
}
function runStatusLabel(status: AutomationRunRecord['status'], zh: boolean): string {
  const labels = zh
    ? { queued: '排队', dispatching: '派发中', running: '运行中', succeeded: '成功', failed: '失败', blocked: '阻塞', cancelled: '已取消', outcome_unknown: '结果未知' }
    : { queued: 'Queued', dispatching: 'Dispatching', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', blocked: 'Blocked', cancelled: 'Cancelled', outcome_unknown: 'Unknown' };
  return labels[status];
}
