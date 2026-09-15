import { MotionPresence } from '../toolPageHost.js';
import { reportApplicationError, VisibleApplicationError } from '../toolPageHost.js';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowClockwiseIcon as Refresh } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ClockCountdownIcon as Clock } from '@phosphor-icons/react/dist/csr/ClockCountdown';
import { TrayIcon as Inbox } from '@phosphor-icons/react/dist/csr/Tray';
import { PauseIcon as Pause } from '@phosphor-icons/react/dist/csr/Pause';
import { PlayIcon as Play } from '@phosphor-icons/react/dist/csr/Play';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import type { CodexTaskPushModelCapability } from '../toolPageHost.js';
import type { DashboardClient, ProjectRecord } from '../toolPageHost.js';
import { Button } from '../toolPageHost.js';
import { FormDialog } from '../toolPageHost.js';
import { ZeusSelect } from '../toolPageHost.js';
import type { SkillCatalog } from '../toolPageHost.js';
import { codexCapabilitiesChangedEvent } from '../toolPageHost.js';
import { SkillSelector } from '../toolPageHost.js';
import type { AutomationBlockStrategy, AutomationConversationMode, AutomationPermissionMode, AutomationRunRecord, AutomationTaskInput, AutomationTaskRecord, AutomationTriggerKind } from '../toolPageHost.js';

type Draft = Omit<AutomationTaskInput, 'pluginIds'> & { pluginIds: string[]; maxRunsPerDayText: string; maxTokensPerDayText: string };
type View = 'tasks' | 'inbox';
const allProjectsValue = '__all_projects__';

/** 自动化目录与收件箱使用全局控件，编辑及删除复用表单弹窗。 */
export function AutomationsWorkspace(props: { client: DashboardClient | null; projects: ProjectRecord[]; language: 'zh-CN' | 'en-US'; onOpenConversation: (run: AutomationRunRecord) => Promise<void> }) {
  const zh = props.language === 'zh-CN';
  const [view, setView] = useState<View>('tasks');
  const [tasks, setTasks] = useState<AutomationTaskRecord[]>([]);
  const [inbox, setInbox] = useState<AutomationRunRecord[]>([]);
  const [models, setModels] = useState<CodexTaskPushModelCapability[]>([]);
  const [extensionCatalog, setExtensionCatalog] = useState<SkillCatalog | null>(null);
  const [extensionsLoading, setExtensionsLoading] = useState(false);
  const [extensionsError, setExtensionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(props.projects));
  const [fullAccessAcknowledged, setFullAccessAcknowledged] = useState(false);
  /** 删除前保留任务，只有确认成功才关闭弹窗。 */
  const [pendingDelete, setPendingDelete] = useState<AutomationTaskRecord | null>(null);
  /** 模型刷新独立于自动化表单与运行记录。 */
  const modelRevisionRef = useRef(0);
  /** 目录按当前编辑的项目读取。 */
  const modelProjectId = draft.projectIds[0] ?? props.projects[0]?.id;

  useEffect(() => {
    const client = props.client;
    if (!client || !modelProjectId) return;
    /** 切换项目后，旧目录读取不能覆盖当前模型选项。 */
    let disposed = false;
    const refreshModels = (): void => {
      const revision = ++modelRevisionRef.current;
      void client
        .loadCodexConversationCapabilities(modelProjectId)
        .then((next) => {
          if (!disposed && revision === modelRevisionRef.current) setModels(next.models.filter((model) => model.available !== false));
        })
        .catch(() => {
          // 网络恢复后的目录通知会重试，不打断自动化草稿编辑。
        });
    };
    window.addEventListener(codexCapabilitiesChangedEvent, refreshModels);
    return () => {
      disposed = true;
      modelRevisionRef.current += 1;
      window.removeEventListener(codexCapabilitiesChangedEvent, refreshModels);
    };
  }, [props.client, modelProjectId]);

  async function refresh(): Promise<void> {
    if (!props.client) return;
    /** 页面读取与目录通知共用代次，避免迟到结果回写。 */
    const modelRevision = ++modelRevisionRef.current;
    setLoading(true);
    setError(null);
    try {
      const projectId = draft.projectIds[0] ?? props.projects[0]?.id;
      const [nextTasks, nextInbox, capabilities] = await Promise.all([props.client.loadAutomations(), props.client.loadAutomationInbox(), projectId ? props.client.loadCodexConversationCapabilities(projectId) : Promise.resolve(null)]);
      setTasks(nextTasks);
      setInbox(nextInbox);
      if (modelRevision === modelRevisionRef.current) setModels(capabilities?.models.filter((model) => model.available !== false) ?? []);
      setDraft((current) => {
        if (current.modelId || !capabilities?.models.length) return current;
        const preferred = capabilities.models.find((model) => model.model === capabilities.preferredModel) ?? capabilities.models[0]!;
        return { ...current, modelSourceId: preferred.sourceId ?? 'codex', modelId: preferred.model, reasoningEffort: preferred.defaultReasoningEffort ?? null };
      });
    } catch (cause) {
      setError(reportApplicationError(cause, { language: zh ? 'zh-CN' : 'en' }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // 首次进入并行读取定义、收件箱和能力；后续由用户显式刷新，避免定时水合打断编辑。
  }, [props.client]);

  const selectedProjectKey = draft.projectIds.join('\u0000');
  useEffect(() => {
    if (!props.client || !editingId || !selectedProjectKey) {
      setExtensionCatalog(null);
      setExtensionsLoading(false);
      setExtensionsError(null);
      return;
    }
    let active = true;
    setExtensionCatalog(null);
    setExtensionsLoading(true);
    setExtensionsError(null);
    const projectIds = selectedProjectKey.split('\u0000');
    void Promise.all(projectIds.map((projectId) => props.client!.loadSkills(projectId)))
      .then((catalogs) => {
        if (!active) return;
        const first = catalogs[0]!;
        const rest = catalogs.slice(1);
        setExtensionCatalog({
          ...first,
          skills: first.skills.filter((skill) => skill.source !== 'plugin' && rest.every((catalog) => catalog.skills.some((candidate) => candidate.source !== 'plugin' && candidate.id === skill.id))),
          plugins: (first.plugins ?? []).filter((plugin) => rest.every((catalog) => catalog.plugins?.some((candidate) => candidate.id === plugin.id))),
          errors: catalogs.flatMap((catalog) => catalog.errors),
        });
      })
      .catch((cause: unknown) => {
        if (active) setExtensionsError(reportApplicationError(cause, { language: zh ? 'zh-CN' : 'en' }));
      })
      .finally(() => {
        if (active) setExtensionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [editingId, props.client, selectedProjectKey]);

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
  const allProjectsSelected = props.projects.length > 0 && props.projects.every((project) => draft.projectIds.includes(project.id));
  const projectOptions = [
    { value: allProjectsValue, label: zh ? `全选项目（${props.projects.length}）` : `Select all projects (${props.projects.length})`, group: zh ? '批量选择' : 'Bulk selection' },
    ...props.projects.map((project) => ({ value: project.id, label: project.name, group: zh ? '项目' : 'Projects', searchText: project.localPath })),
  ];
  const projectSelectionValues = allProjectsSelected ? [allProjectsValue, ...draft.projectIds] : draft.projectIds;
  const selectedProjectNames = draft.projectIds.map((id) => props.projects.find((project) => project.id === id)?.name ?? id);
  const projectTriggerLabel = allProjectsSelected
    ? zh
      ? `全部 ${props.projects.length} 个项目`
      : `All ${props.projects.length} projects`
    : selectedProjectNames.length === 0
      ? zh
        ? '未选择项目'
        : 'No projects selected'
      : selectedProjectNames.length === 1
        ? selectedProjectNames[0]
        : zh
          ? `已选择 ${selectedProjectNames.length} 个项目`
          : `${selectedProjectNames.length} projects selected`;
  const availablePluginIds = new Set((extensionCatalog?.plugins ?? []).map((plugin) => plugin.id));
  const pluginOptions = [
    ...(extensionCatalog?.plugins ?? []).map((plugin) => ({
      value: plugin.id,
      label: plugin.displayName || plugin.name,
      group: plugin.scope === 'project' ? (zh ? '项目 Plugin' : 'Project plugins') : zh ? '个人 Plugin' : 'Personal plugins',
      searchText: `${plugin.name} ${plugin.description} ${plugin.sourceLocator} ${plugin.id}`,
    })),
    ...draft.pluginIds.filter((id) => !availablePluginIds.has(id)).map((id) => ({ value: id, label: `${id} · ${zh ? '当前不可用' : 'Currently unavailable'}`, group: zh ? '需要重选' : 'Reselect' })),
  ];
  const selectedPluginNames = draft.pluginIds.map((id) => pluginOptions.find((option) => option.value === id)?.label ?? id);
  const pluginTriggerLabel =
    selectedPluginNames.length === 0
      ? extensionsLoading
        ? zh
          ? '正在读取 Plugin…'
          : 'Loading plugins…'
        : zh
          ? '不使用 Plugin'
          : 'No plugins'
      : selectedPluginNames.length === 1
        ? selectedPluginNames[0]
        : zh
          ? `已选择 ${selectedPluginNames.length} 个 Plugin`
          : `${selectedPluginNames.length} plugins selected`;
  const extensionsValid =
    (!draft.skillId && draft.pluginIds.length === 0) ||
    (!extensionsLoading && !extensionsError && Boolean(extensionCatalog) && (!draft.skillId || extensionCatalog!.skills.some((skill) => skill.id === draft.skillId)) && draft.pluginIds.every((id) => availablePluginIds.has(id)));

  /** 创建时重置草稿，弹窗负责初始焦点。 */
  function startCreate(): void {
    setEditingId('new');
    setDraft(emptyDraft(props.projects, modelOptions[0]?.model));
    setFullAccessAcknowledged(false);
    setError(null);
  }

  /** 编辑沿用已保存配置，不改变运行状态。 */
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
  }

  /** 保存期间锁定表单，权限确认仍按既有服务流程执行。 */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!props.client || !editingId || busyId) return;
    setBusyId(editingId);
    setError(null);
    try {
      const input = normalizeDraft(draft);
      const saved = editingId === 'new' ? await props.client.createAutomation(input) : await props.client.updateAutomation(editingId, tasks.find((task) => task.id === editingId)!.revision, input);
      if (saved.permissionMode === 'full-access' && fullAccessAcknowledged) await props.client.setAutomationFullAccessGrant(saved.id, saved.revision, true);
      setEditingId(null);
      await refresh();
    } catch (cause) {
      setError(reportApplicationError(cause, { language: zh ? 'zh-CN' : 'en' }));
    } finally {
      setBusyId(null);
    }
  }

  /** 所有列表操作共用等待状态，避免同时提交后互相覆盖反馈。 */
  async function mutate(id: string, operation: () => Promise<unknown>): Promise<boolean> {
    if (busyId) return false;
    setBusyId(id);
    setError(null);
    try {
      await operation();
      await refresh();
      return true;
    } catch (cause) {
      setError(reportApplicationError(cause, { language: zh ? 'zh-CN' : 'en' }));
      return false;
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
          <h1 id="automations-title">{zh ? '自动化' : 'Automations'}</h1>
          <p>{zh ? '按设定的时间和项目自动执行指令，并查看每次运行的结果。' : 'Run instructions automatically for selected projects on a schedule, and view the result of each run.'}</p>
        </div>
        <div className="automations-header-actions">
          <Button aria-label={zh ? '刷新自动化' : 'Refresh automations'} onClick={() => void refresh()} busy={loading} disabled={loading || Boolean(busyId)}>
            <Refresh aria-hidden="true" />
            {zh ? '刷新' : 'Refresh'}
          </Button>
          <Button variant="primary" onClick={startCreate} disabled={loading || Boolean(busyId)}>
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

      {error && !editingId && !pendingDelete ? (
        <p className="automations-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="automations-layout">
        <div className="automations-list" aria-busy={loading}>
          {view === 'tasks' ? (
            loading && !tasks.length ? (
              <div className="automations-empty" role="status">
                {zh ? '正在读取自动化…' : 'Loading automations…'}
              </div>
            ) : tasks.length ? (
              tasks.map((task) => (
                <article className="automation-row" key={task.id} data-status={task.status}>
                  <button type="button" className="automation-row-main" disabled={Boolean(busyId)} onClick={() => startEdit(task)}>
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
                    <Button
                      className="automation-icon-action"
                      title={zh ? '立即运行' : 'Run now'}
                      aria-label={`${zh ? '立即运行' : 'Run'} ${task.name}`}
                      busy={busyId === `run:${task.id}`}
                      disabled={Boolean(busyId) || task.status !== 'active'}
                      onClick={() => void mutate(`run:${task.id}`, () => props.client!.runAutomation(task.id))}
                    >
                      <Play aria-hidden="true" />
                    </Button>
                    <Button
                      className="automation-icon-action"
                      title={task.status === 'active' ? (zh ? '暂停' : 'Pause') : zh ? '恢复' : 'Resume'}
                      aria-label={`${task.status === 'active' ? (zh ? '暂停' : 'Pause') : zh ? '恢复' : 'Resume'} ${task.name}`}
                      busy={busyId === `status:${task.id}`}
                      disabled={Boolean(busyId)}
                      onClick={() => void mutate(`status:${task.id}`, () => props.client!.setAutomationStatus(task.id, task.status === 'active' ? 'paused' : 'active'))}
                    >
                      {task.status === 'active' ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                    </Button>
                    <Button className="automation-icon-action" variant="danger" title={zh ? '删除' : 'Delete'} aria-label={`${zh ? '删除' : 'Delete'} ${task.name}`} disabled={Boolean(busyId)} onClick={() => setPendingDelete(task)}>
                      <Trash aria-hidden="true" />
                    </Button>
                  </div>
                </article>
              ))
            ) : (
              <EmptyState title={zh ? '还没有自动化' : 'No automations yet'} body={zh ? '创建自动化，让重复工作按时执行。' : 'Create an automation to run recurring work on a schedule.'} />
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
                    {run.errorMessage ? (
                      <p>
                        <VisibleApplicationError error={{ code: run.errorCode, message: run.errorMessage }} language={zh ? 'zh-CN' : 'en'} />
                      </p>
                    ) : null}
                    {run.mayOverlapPrevious ? <p className="automation-warning">{zh ? '可能与旧运行重叠' : 'May overlap a previous run'}</p> : null}
                  </div>
                  <div className="automation-inbox-actions">
                    {run.conversationId ? (
                      <Button disabled={Boolean(busyId)} onClick={() => void props.onOpenConversation(run)}>
                        {zh ? '打开会话' : 'Open conversation'}
                      </Button>
                    ) : null}
                    {run.unread ? (
                      <Button busy={busyId === `read:${run.id}`} disabled={Boolean(busyId)} onClick={() => void mutate(`read:${run.id}`, () => props.client!.acknowledgeAutomationRun(run.id))}>
                        {zh ? '标为已读' : 'Mark read'}
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })
          ) : (
            <EmptyState title={zh ? '收件箱很安静' : 'Inbox is quiet'} body={zh ? '自动化的运行结果和需要你处理的问题会显示在这里。' : 'Automation results and requests for your attention appear here.'} />
          )}
        </div>
      </div>
      <MotionPresence>
        {editingId ? (
          <FormDialog
            className="automation-editor"
            title={editingId === 'new' ? (zh ? '新建自动化' : 'New automation') : zh ? '编辑自动化' : 'Edit automation'}
            zh={zh}
            busy={Boolean(busyId)}
            submitLabel={editingId === 'new' ? (zh ? '创建并启用' : 'Create and enable') : zh ? '保存更改' : 'Save changes'}
            submitDisabled={!draft.name.trim() || !draft.prompt.trim() || !draft.projectIds.length || !selectedModel || !extensionsValid || (draft.permissionMode === 'full-access' && !fullAccessAcknowledged)}
            onClose={() => setEditingId(null)}
            onSubmit={(event) => void submit(event)}
          >
            {error ? (
              <p className="automations-error" role="alert">
                {error}
              </p>
            ) : null}
            <fieldset className="automation-form-section">
              <legend>{zh ? '执行内容' : 'Instructions and projects'}</legend>
              <label>
                <span>{zh ? '名称' : 'Name'}</span>
                <input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
              </label>
              <label>
                <span>{zh ? '指令' : 'Instruction'}</span>
                <textarea required rows={7} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })} />
              </label>
              <div className="automation-form-field">
                <span>{zh ? '目标项目' : 'Target projects'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '选择目标项目' : 'Choose target projects'}
                  value=""
                  selectedValues={projectSelectionValues}
                  options={projectOptions}
                  onChange={(value) => {
                    if (value === allProjectsValue) {
                      setDraft({ ...draft, projectIds: allProjectsSelected ? [] : props.projects.map((project) => project.id) });
                      return;
                    }
                    setDraft({ ...draft, projectIds: draft.projectIds.includes(value) ? draft.projectIds.filter((id) => id !== value) : [...draft.projectIds, value] });
                  }}
                  triggerLabel={projectTriggerLabel}
                  disabled={!props.projects.length}
                  searchable={props.projects.length > 8}
                  searchPlaceholder={zh ? '搜索项目' : 'Search projects'}
                  emptyLabel={zh ? '没有匹配的项目' : 'No matching projects'}
                />
              </div>
            </fieldset>
            <fieldset className="automation-form-section">
              <legend>{zh ? '运行安排' : 'Schedule'}</legend>
              <div className="automation-form-grid">
                <SelectField label={zh ? '触发方式' : 'Trigger'} value={draft.triggerKind ?? 'manual'} options={triggerOptions(zh)} onChange={(value) => setDraft({ ...draft, triggerKind: value as AutomationTriggerKind })} />
                <label>
                  <span>{zh ? '时区（如 Asia/Shanghai）' : 'Time zone (for example, Asia/Shanghai)'}</span>
                  <input value={draft.timezone ?? ''} onChange={(event) => setDraft({ ...draft, timezone: event.currentTarget.value })} />
                </label>
              </div>
              <TriggerFields draft={draft} setDraft={setDraft} zh={zh} />
            </fieldset>
            <fieldset className="automation-form-section">
              <legend>{zh ? '模型与权限' : 'Model and permissions'}</legend>
              <label>
                <span>{zh ? '使用模型' : 'Model'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '选择模型' : 'Select a model'}
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
                  <span>
                    {zh ? '我允许此自动化持续使用以上权限，直到我修改或撤销授权；执行的操作可能无法撤销。' : 'I allow this automation to keep using these permissions until I change or revoke them. Its actions may be irreversible.'}
                  </span>
                </label>
              ) : null}
            </fieldset>
            <fieldset className="automation-form-section">
              <legend>{zh ? '运行方式' : 'Run behavior'}</legend>
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
                  label={zh ? '上次运行未结束时' : 'When the previous run is unfinished'}
                  value={draft.blockStrategy ?? 'serial'}
                  options={[
                    ['serial', zh ? '排队等待' : 'Wait in line'],
                    ['discard', zh ? '跳过新运行' : 'Skip the new run'],
                    ['cover', zh ? '停止旧运行并开始新的运行' : 'Stop the previous run and start the new one'],
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
            </fieldset>
            <details>
              <summary>{zh ? '插件、用量限制与记录保留' : 'Plugins, usage limits, and history retention'}</summary>
              <div className="automation-form-grid">
                <label>
                  <span>{zh ? '技能' : 'Skill'}</span>
                  <SkillSelector
                    client={props.client}
                    value={draft.skillId ?? ''}
                    onChange={(value) => setDraft({ ...draft, skillId: value || null })}
                    language={props.language}
                    catalog={extensionCatalog}
                    disabled={!draft.projectIds.length || extensionsLoading || Boolean(extensionsError) || !extensionCatalog}
                    ariaLabel={zh ? '选择自动化 Skill' : 'Choose automation skill'}
                  />
                </label>
                <label>
                  <span>{zh ? '插件' : 'Plugins'}</span>
                  <ZeusSelect
                    size="regular"
                    ariaLabel={zh ? '选择自动化 Plugin' : 'Choose automation plugins'}
                    value=""
                    selectedValues={draft.pluginIds}
                    options={pluginOptions}
                    onChange={(value) => setDraft({ ...draft, pluginIds: draft.pluginIds.includes(value) ? draft.pluginIds.filter((id) => id !== value) : [...draft.pluginIds, value] })}
                    triggerLabel={pluginTriggerLabel}
                    disabled={!draft.projectIds.length || extensionsLoading || Boolean(extensionsError) || !extensionCatalog || !pluginOptions.length}
                    searchable
                    searchPlaceholder={zh ? '搜索 Plugin' : 'Search plugins'}
                    emptyLabel={zh ? '没有可用的 Plugin' : 'No available plugins'}
                  />
                </label>
              </div>
              {extensionsError ? (
                <small className="automation-capability-error" role="alert">
                  {extensionsError}
                </small>
              ) : null}
              <div className="automation-form-grid">
                <label>
                  <span>{zh ? '最多等待运行数' : 'Maximum waiting runs'}</span>
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
                  <span>{zh ? '每日用量上限（Token）' : 'Daily usage limit (tokens)'}</span>
                  <input type="number" min="1" value={draft.maxTokensPerDayText} placeholder={zh ? '不限' : 'Unlimited'} onChange={(event) => setDraft({ ...draft, maxTokensPerDayText: event.currentTarget.value })} />
                </label>
              </div>
              <label className="automation-check">
                <input type="checkbox" checked={draft.fastMode === true} onChange={(event) => setDraft({ ...draft, fastMode: event.currentTarget.checked })} />
                <span>{zh ? '启用 Fast 服务档位（仅在模型支持时）' : 'Use Fast service tier when supported'}</span>
              </label>
            </details>
          </FormDialog>
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {pendingDelete ? (
          <FormDialog
            title={zh ? `删除“${pendingDelete.name}”？` : `Delete “${pendingDelete.name}”?`}
            description={zh ? '此自动化将不再接受新的运行，历史运行记录会保留。' : 'This automation will no longer accept new runs. Run history is kept.'}
            zh={zh}
            busy={Boolean(busyId)}
            danger
            submitLabel={zh ? '删除自动化' : 'Delete automation'}
            onClose={() => setPendingDelete(null)}
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(`delete:${pendingDelete.id}`, () => props.client!.deleteAutomation(pendingDelete.id)).then((deleted) => {
                if (deleted) setPendingDelete(null);
              });
            }}
          >
            {error ? (
              <p className="automations-error" role="alert">
                {error}
              </p>
            ) : null}
          </FormDialog>
        ) : null}
      </MotionPresence>
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
    ['rrule', zh ? '自定义重复规则（RRULE）' : 'Custom recurrence rule (RRULE)'],
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
function scheduleLabel(task: AutomationTaskRecord, zh: boolean): string {
  if (task.status === 'paused') return zh ? '已暂停' : 'Paused';
  if (task.triggerKind === 'manual') return zh ? '手动触发' : 'Manual';
  return task.nextRunAt ? formatDate(task.nextRunAt) : zh ? '等待计算' : 'Awaiting schedule';
}
function runStatusLabel(status: AutomationRunRecord['status'], zh: boolean): string {
  const labels = zh
    ? { queued: '排队', dispatching: '正在启动', running: '运行中', succeeded: '成功', failed: '失败', blocked: '等待处理', cancelled: '已取消', outcome_unknown: '结果未知' }
    : { queued: 'Queued', dispatching: 'Starting', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', blocked: 'Needs attention', cancelled: 'Cancelled', outcome_unknown: 'Unknown' };
  return labels[status];
}
