import type { FormEvent, KeyboardEvent } from 'react';
import { buildTaskPushPrompt, type TaskPushParentContextOption, type TaskPushPromptParentContext } from '@zeus/shared';
import type { TaskRecord } from '../apiClient.js';
import type { CodexTaskPushCapabilities, NativePermissionMode, NativeServiceTierSelection } from '../session/sessionTypes.js';
import { normalizeServiceTierSelection, serviceTierDescription, serviceTierOptions, serviceTierSelectionFromValue, serviceTierSelectionValue } from '../session/serviceTierSelection.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { TaskAttachmentPreviewList } from './TaskAttachmentPreviewList.js';
import { parseTaskAttachments } from './taskAttachments.js';

export interface TaskModelPushForm {
  model: string;
  effort: string;
  serviceTier: NativeServiceTierSelection;
  serviceTierDowngraded: boolean;
  workMode: 'default' | 'plan';
  permissionMode: NativePermissionMode;
  workspaceMode: 'direct' | 'worktree';
  directConcurrencyConfirmed: boolean;
  repositorySelections: Record<string, { sourceRef: string; branchName: string; includeLocalChanges: boolean }>;
  parentContextSelections: Record<string, { selected: boolean; conversationIds: string[]; attachmentKeys: string[] }>;
  supplementalInfo: string;
}

export type TaskModelPushModalStatus = 'loading' | 'ready' | 'authenticating' | 'submitting' | 'error';

export type TaskModelPushPreferences = Pick<TaskModelPushForm, 'model' | 'effort' | 'workMode' | 'permissionMode'> & {
  workspaceMode?: 'direct' | 'worktree';
};

const preferencesKeyPrefix = 'zeus.task-model-push-preferences:v1:';

export function buildTaskModelPushMessage(
  task: Pick<TaskRecord, 'title' | 'taskType' | 'description' | 'defectCurrentState' | 'defectExpectedOutcome' | 'defectReproductionSteps' | 'optimizationCurrentState' | 'optimizationExpectedOutcome'>,
  supplementalInfo: string,
  parentContexts: TaskPushPromptParentContext[] = [],
): string {
  return buildTaskPushPrompt({
    taskTitle: task.title,
    taskType: task.taskType,
    taskDescription: task.description,
    defectCurrentState: task.defectCurrentState,
    defectExpectedOutcome: task.defectExpectedOutcome,
    defectReproductionSteps: task.defectReproductionSteps,
    optimizationCurrentState: task.optimizationCurrentState,
    optimizationExpectedOutcome: task.optimizationExpectedOutcome,
    supplementalInfo,
    parentContexts,
  });
}

/** 按服务端给出的根到父顺序生成正文上下文；附件只走结构化通道，不进入文本。 */
export function selectedTaskPushParentContexts(options: TaskPushParentContextOption[], selections: TaskModelPushForm['parentContextSelections']): TaskPushPromptParentContext[] {
  return options.flatMap((option) => {
    const selection = selections[option.taskId];
    if (!selection?.selected) return [];
    const selectedConversationIds = new Set(selection.conversationIds);
    return [
      {
        taskId: option.taskId,
        taskCode: option.taskCode,
        taskTitle: option.taskTitle,
        taskType: option.taskType,
        taskDescription: option.taskDescription,
        defectCurrentState: option.defectCurrentState,
        defectExpectedOutcome: option.defectExpectedOutcome,
        defectReproductionSteps: option.defectReproductionSteps,
        optimizationCurrentState: option.optimizationCurrentState,
        optimizationExpectedOutcome: option.optimizationExpectedOutcome,
        conversationPaths: option.conversations.filter((conversation) => selectedConversationIds.has(conversation.id) && conversation.available && conversation.path).map((conversation) => conversation.path!),
      },
    ];
  });
}

export function readTaskModelPushPreferences(storage: Pick<Storage, 'getItem'> | undefined, projectId: string): TaskModelPushPreferences | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(`${preferencesKeyPrefix}${encodeURIComponent(projectId)}`) ?? 'null') as Partial<TaskModelPushPreferences> | null;
    if (!value || typeof value.model !== 'string' || typeof value.effort !== 'string') return null;
    if (value.workMode !== 'default' && value.workMode !== 'plan') return null;
    if (value.permissionMode !== 'read-only' && value.permissionMode !== 'auto' && value.permissionMode !== 'full-access') return null;
    return {
      model: value.model,
      effort: value.effort,
      workMode: value.workMode,
      permissionMode: value.permissionMode,
      ...(value.workspaceMode === 'direct' || value.workspaceMode === 'worktree' ? { workspaceMode: value.workspaceMode } : {}),
    };
  } catch {
    return null;
  }
}

export function writeTaskModelPushPreferences(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, projectId: string, form: TaskModelPushForm): void {
  if (!storage) return;
  storage.setItem(
    `${preferencesKeyPrefix}${encodeURIComponent(projectId)}`,
    JSON.stringify({
      model: form.model,
      effort: form.effort,
      workMode: form.workMode,
      permissionMode: form.permissionMode,
      workspaceMode: form.workspaceMode,
    } satisfies TaskModelPushPreferences),
  );
}

export function resolveTaskModelPushInitialForm(capabilities: CodexTaskPushCapabilities, remembered: TaskModelPushPreferences | null, serviceTier: NativeServiceTierSelection = { type: 'follow' }): TaskModelPushForm {
  const rememberedModel = capabilities.models.find((model) => model.model === remembered?.model || model.id === remembered?.model);
  const selectedModel = rememberedModel ?? capabilities.models.find((model) => model.model === capabilities.preferredModel || model.id === capabilities.preferredModel) ?? capabilities.models[0];
  if (!selectedModel) throw new Error('Codex app-server did not report an available model.');
  const effort = rememberedModel && remembered && selectedModel.supportedReasoningEfforts.includes(remembered.effort) ? remembered.effort : (selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? '');
  return {
    model: selectedModel.id,
    effort,
    serviceTier: normalizeServiceTierSelection(serviceTier, selectedModel).selection,
    serviceTierDowngraded: serviceTier.type === 'catalog' && !selectedModel.serviceTiers.some((tier) => tier.id === serviceTier.id),
    workMode: remembered?.workMode ?? 'default',
    // 用户已确认：项目没有成功记忆时，权限必须回退为只读。
    permissionMode: remembered?.permissionMode ?? 'read-only',
    workspaceMode: remembered?.workspaceMode ?? (capabilities.repositories.length > 0 ? 'worktree' : 'direct'),
    directConcurrencyConfirmed: false,
    repositorySelections: Object.fromEntries(
      capabilities.repositories.map((repository) => {
        const currentSourceRef = repository.sourceRefs.find((source) => source.current)?.ref ?? '';
        return [
          repository.id,
          {
            // 远端模式按当前同名远端分支选默认值；纯本地模式才使用当前本地分支。
            sourceRef: currentSourceRef,
            branchName: repository.suggestedBranchName,
            includeLocalChanges: false,
          },
        ];
      }),
    ),
    parentContextSelections: {},
    supplementalInfo: '',
  };
}

export function TaskModelPushModal(props: {
  open: boolean;
  language: 'zh-CN' | 'en-US';
  task: TaskRecord | null;
  projectName?: string;
  capabilities: CodexTaskPushCapabilities | null;
  form: TaskModelPushForm;
  status: TaskModelPushModalStatus;
  refreshingRepositoryId: string | null;
  error: string | null;
  onChange: (next: TaskModelPushForm) => void;
  onRefreshRepository: (repositoryId: string) => void;
  onClose: () => void;
  onCancelAuthentication: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onLoadAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
}) {
  if (!props.open || !props.task) return null;
  const zh = props.language === 'zh-CN';
  const authenticating = props.status === 'authenticating';
  const busy = authenticating || props.status === 'submitting';
  const attachments = parseTaskAttachments(props.task.sourceContextJson);
  const selectedModel = props.capabilities?.models.find((model) => model.model === props.form.model || model.id === props.form.model);
  const codexLoginRequired = selectedModel?.agentKind !== 'pi' && props.capabilities?.codexAccount.requiresOpenaiAuth === true && !props.capabilities.codexAccount.signedIn;
  const repositories = props.capabilities?.repositories ?? [];
  const directWorkspaceBusy = (props.capabilities?.directWorkspace.activeWritableConversationCount ?? 0) > 0;
  const directWorkspaceNeedsConfirmation = directWorkspaceBusy && props.form.permissionMode !== 'read-only';
  const parentContextOptions = props.capabilities?.parentContextOptions ?? [];
  const selectedParentContexts = selectedTaskPushParentContexts(parentContextOptions, props.form.parentContextSelections);
  const selectedParentAttachmentCount = parentContextOptions.reduce(
    (count, option) => count + (props.form.parentContextSelections[option.taskId]?.selected ? (props.form.parentContextSelections[option.taskId]?.attachmentKeys.length ?? 0) : 0),
    0,
  );

  function onModelChange(model: string): void {
    const capability = props.capabilities?.models.find((candidate) => candidate.model === model || candidate.id === model);
    const normalizedTier = normalizeServiceTierSelection(props.form.serviceTier, capability);
    props.onChange({
      ...props.form,
      model: capability?.id ?? model,
      effort: capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? '',
      serviceTier: normalizedTier.selection,
      serviceTierDowngraded: normalizedTier.downgraded,
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Escape' && !busy) props.onClose();
  }

  function toggleParentTask(option: TaskPushParentContextOption, selected: boolean): void {
    props.onChange({
      ...props.form,
      parentContextSelections: {
        ...props.form.parentContextSelections,
        [option.taskId]: selected ? { selected: true, conversationIds: [], attachmentKeys: [] } : { selected: false, conversationIds: [], attachmentKeys: [] },
      },
    });
  }

  function toggleParentResource(taskId: string, field: 'conversationIds' | 'attachmentKeys', value: string, selected: boolean): void {
    const current = props.form.parentContextSelections[taskId] ?? { selected: true, conversationIds: [], attachmentKeys: [] };
    const values = current[field];
    props.onChange({
      ...props.form,
      parentContextSelections: {
        ...props.form.parentContextSelections,
        [taskId]: { ...current, [field]: selected ? [...values.filter((entry) => entry !== value), value] : values.filter((entry) => entry !== value) },
      },
    });
  }

  const modal = (
    <ModalPortal rootClassName="task-model-push-portal-root" backdropClassName="task-model-push-backdrop" dismissDisabled={busy} onDismiss={props.onClose}>
      <form className="task-model-push-modal zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="task-model-push-title" onSubmit={props.onSubmit} onKeyDown={handleKeyDown}>
        <header className="task-model-push-header">
          <span>
            <strong id="task-model-push-title">{zh ? '推送到新会话' : 'Push to new conversation'}</strong>
            <small>{props.projectName ? `${props.projectName} · ${props.task.taskCode ?? props.task.id}` : (props.task.taskCode ?? props.task.id)}</small>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={busy}>
            ×
          </button>
        </header>

        <div className="task-model-push-body">
          <section className="task-model-push-workspace" aria-label={zh ? '本次推送工作区' : 'Workspace for this push'}>
            <span className="task-model-push-section-heading">
              <strong>{zh ? '本次推送工作区' : 'Workspace for this push'}</strong>
              <small>{zh ? '直接使用项目目录，或按需创建独立分支和 worktree' : 'Use the project directory directly, or create isolated branches and worktrees'}</small>
            </span>
            <fieldset className="task-model-push-mode-choice">
              <legend>{zh ? '工作方式' : 'Workspace mode'}</legend>
              <label className={props.form.workspaceMode === 'direct' ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name="task-workspace-mode"
                  value="direct"
                  checked={props.form.workspaceMode === 'direct'}
                  onChange={() => props.onChange({ ...props.form, workspaceMode: 'direct', directConcurrencyConfirmed: false })}
                  disabled={busy}
                />
                <span>
                  <strong>{zh ? '直接使用项目目录' : 'Use project directory directly'}</strong>
                  <small>{zh ? '不创建分支或隔离目录，修改直接写入真实项目' : 'No branch or isolated directory; changes write to the real project'}</small>
                </span>
              </label>
              <label className={props.form.workspaceMode === 'worktree' ? 'is-selected' : undefined}>
                <input
                  type="radio"
                  name="task-workspace-mode"
                  value="worktree"
                  checked={props.form.workspaceMode === 'worktree'}
                  onChange={() => props.onChange({ ...props.form, workspaceMode: 'worktree', directConcurrencyConfirmed: false })}
                  disabled={busy}
                />
                <span>
                  <strong>Worktree</strong>
                  <small>{zh ? '自动发现全部 Git 仓库，并创建独立任务分支' : 'Discover all Git repositories and create isolated task branches'}</small>
                </span>
              </label>
            </fieldset>
            {props.form.workspaceMode === 'direct' ? (
              <div className="task-model-push-direct-summary">
                <small>
                  {zh ? '工作目录' : 'Working directory'}：{props.capabilities?.directWorkspace.path ?? '—'}
                </small>
                <p className="task-model-push-warning">
                  {zh ? 'AI 将直接读写项目真实目录；现有文件和当前 Git 分支不会被隔离。' : 'The agent writes directly to the real project directory; existing files and the current Git branch are not isolated.'}
                </p>
                {directWorkspaceNeedsConfirmation ? (
                  <label className="task-model-push-concurrency-confirm">
                    <input type="checkbox" checked={props.form.directConcurrencyConfirmed} onChange={(event) => props.onChange({ ...props.form, directConcurrencyConfirmed: event.currentTarget.checked })} disabled={busy} />
                    <span>
                      {zh
                        ? `当前已有 ${props.capabilities?.directWorkspace.activeWritableConversationCount ?? 0} 条可写会话使用这个目录；我了解并发修改可能互相覆盖。`
                        : `${props.capabilities?.directWorkspace.activeWritableConversationCount ?? 0} writable conversation(s) already use this directory; I understand concurrent changes may overwrite each other.`}
                    </span>
                  </label>
                ) : null}
              </div>
            ) : !props.capabilities ? (
              <p className={props.status === 'error' ? 'task-model-push-error' : 'task-model-push-message'} role="status">
                {props.status === 'error'
                  ? zh
                    ? 'Git 仓库检查未完成，不能判断项目是否存在仓库。请根据下方错误处理后重试。'
                    : 'The Git repository check did not complete, so repository presence is unknown. Resolve the error below and try again.'
                  : zh
                    ? '正在扫描项目目录下的 Git 仓库…'
                    : 'Scanning the project directory for Git repositories…'}
              </p>
            ) : repositories.length > 0 ? (
              <div className="task-model-push-repository-list">
                {repositories.map((repository) => {
                  const selection = props.form.repositorySelections[repository.id] ?? {
                    sourceRef: '',
                    branchName: repository.suggestedBranchName,
                    includeLocalChanges: false,
                  };
                  const selectedSource = repository.sourceRefs.find((source) => source.ref === selection.sourceRef);
                  const refreshing = props.refreshingRepositoryId === repository.id;
                  return (
                    <fieldset key={repository.id} className="task-model-push-repository">
                      <legend>
                        <span>
                          <strong>{repository.name}</strong>
                          <small>{repository.relativePath}</small>
                        </span>
                        <Button variant="secondary" size="compact" busy={refreshing} onClick={() => props.onRefreshRepository(repository.id)} disabled={busy || refreshing || !repository.defaultRemoteName}>
                          {refreshing ? (zh ? '正在刷新…' : 'Refreshing…') : zh ? '刷新远端分支' : 'Refresh remote branches'}
                        </Button>
                      </legend>
                      <div className="task-model-push-workspace-grid">
                        <label>
                          <span>{zh ? '来源分支（必选）' : 'Source branch (required)'}</span>
                          <ZeusSelect
                            size="regular"
                            ariaLabel={`${repository.name} ${zh ? '来源分支' : 'source branch'}`}
                            value={selection.sourceRef}
                            options={[
                              { value: '', label: zh ? '请选择来源分支' : 'Select source branch', disabled: true },
                              ...repository.sourceRefs.map((source) => ({
                                value: source.ref,
                                label: `${source.label}${source.current ? (zh ? ' · 当前分支' : ' · current branch') : ''}`,
                                group:
                                  source.kind === 'local'
                                    ? zh
                                      ? '本地分支'
                                      : 'Local branches'
                                    : zh
                                      ? `${source.group} 远端分支`
                                      : `${source.group} remote branches`,
                              })),
                            ]}
                            onChange={(sourceRef) =>
                              props.onChange({
                                ...props.form,
                                repositorySelections: { ...props.form.repositorySelections, [repository.id]: { ...selection, sourceRef } },
                              })
                            }
                            disabled={!props.capabilities || busy || refreshing}
                            searchPlaceholder={zh ? '搜索分支' : 'Search branches'}
                          />
                        </label>
                        <label>
                          <span>{zh ? '新分支' : 'New branch'}</span>
                          <input
                            value={selection.branchName}
                            onChange={(event) =>
                              props.onChange({
                                ...props.form,
                                repositorySelections: { ...props.form.repositorySelections, [repository.id]: { ...selection, branchName: event.target.value } },
                              })
                            }
                            disabled={busy}
                            spellCheck={false}
                          />
                        </label>
                      </div>
                      <p className={repository.remoteRefreshError ? 'task-model-push-error' : 'task-model-push-warning'}>
                        {repository.remoteRefreshError
                          ? zh
                            ? `远端刷新失败：${repository.remoteRefreshError}。本地分支、已知远端分支和当前选择不受影响。`
                            : `Remote refresh failed: ${repository.remoteRefreshError}. Local branches, known remote branches, and the current selection remain available.`
                          : repository.remoteRefreshStatus === 'succeeded'
                            ? zh
                              ? '远端分支已手动刷新。来源分支仍由你选择。'
                              : 'Remote branches were refreshed manually. The source branch remains your choice.'
                            : repository.defaultRemoteName
                              ? zh
                                ? '当前展示本地分支和本机已知的远端分支；需要最新远端状态时再手动刷新。'
                                : 'Local branches and locally known remote branches are shown. Refresh manually when current remote state is needed.'
                              : zh
                                ? '该仓库没有远端，当前使用本地分支快照。默认不带入原工作区未提交内容。'
                                : 'This repository has no remote, so a local branch snapshot is used. Local uncommitted changes are excluded by default.'}
                      </p>
                      {selectedSource?.kind === 'local' && repository.clean === false ? (
                        <label className="task-model-push-concurrency-confirm">
                          <input
                            type="checkbox"
                            checked={selection.includeLocalChanges}
                            onChange={(event) =>
                              props.onChange({
                                ...props.form,
                                repositorySelections: {
                                  ...props.form.repositorySelections,
                                  [repository.id]: {
                                    ...selection,
                                    includeLocalChanges: event.currentTarget.checked,
                                  },
                                },
                              })
                            }
                            disabled={busy}
                          />
                          <span>{zh ? '显式带入当前项目目录中的未提交内容。' : 'Explicitly copy uncommitted changes from the current project directory.'}</span>
                        </label>
                      ) : null}
                    </fieldset>
                  );
                })}
              </div>
            ) : (
              <p className="task-model-push-error" role="alert">
                {zh ? '项目目录下没有发现 Git 仓库。请先自行初始化仓库，或改用“直接使用项目目录”。' : 'No Git repository was found. Initialize one first, or use the project directory directly.'}
              </p>
            )}
            {props.form.workspaceMode === 'worktree' ? (
              <small className="task-model-push-worktree-root">
                {zh ? '新工作区路径' : 'New workspace path'}：{props.capabilities?.git.worktreeRoot ?? '—'}/&lt;{zh ? '项目' : 'project'}&gt;/&lt;{zh ? '推送标识' : 'push-id'}&gt;/{props.task.taskCode ?? props.task.id}
              </small>
            ) : null}
          </section>

          <div className="task-model-push-config-grid">
            <label>
              <span>{zh ? '模型' : 'Model'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '模型' : 'Model'}
                value={props.form.model}
                options={(props.capabilities?.models ?? []).map((model) => ({
                  value: model.id,
                  label: `${model.sourceName ? `${model.sourceName} / ` : ''}${model.displayName ?? model.model}${model.speedLabel && model.speedLabel !== 'standard' ? ` · ${model.speedLabel}` : ''}`,
                  disabled: model.available === false,
                }))}
                onChange={onModelChange}
                disabled={!props.capabilities || busy}
                searchPlaceholder={zh ? '搜索模型' : 'Search models'}
                emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
              />
            </label>
            {selectedModel?.supportedReasoningEfforts.length ? (
              <label>
                <span>{zh ? '模型等级' : 'Reasoning effort'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '模型等级' : 'Reasoning effort'}
                  value={props.form.effort}
                  options={selectedModel.supportedReasoningEfforts.map((effort) => ({
                    value: effort,
                    label: effort,
                  }))}
                  onChange={(effort) => props.onChange({ ...props.form, effort })}
                  disabled={busy}
                  searchable={false}
                />
              </label>
            ) : null}
            <label>
              <span>{zh ? '服务档位' : 'Service tier'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '服务档位' : 'Service tier'}
                value={serviceTierSelectionValue(props.form.serviceTier)}
                options={serviceTierOptions(selectedModel, props.language, true)}
                onChange={(value) => props.onChange({ ...props.form, serviceTier: serviceTierSelectionFromValue(value), serviceTierDowngraded: false })}
                disabled={!selectedModel || busy}
                searchable={false}
              />
            </label>
            <label>
              <span>{zh ? '工作模式' : 'Work mode'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '工作模式' : 'Work mode'}
                value={props.form.workMode}
                options={[
                  { value: 'default', label: zh ? '默认' : 'Default' },
                  { value: 'plan', label: zh ? '规划' : 'Plan' },
                ]}
                onChange={(workMode) => props.onChange({ ...props.form, workMode })}
                disabled={busy}
                searchable={false}
              />
            </label>
            <label>
              <span>{zh ? '权限模式' : 'Permission mode'}</span>
              <ZeusSelect<NativePermissionMode>
                size="regular"
                ariaLabel={zh ? '权限模式' : 'Permission mode'}
                value={props.form.permissionMode}
                options={[
                  { value: 'read-only', label: zh ? '只读' : 'Read only' },
                  { value: 'auto', label: zh ? '自动' : 'Auto' },
                  { value: 'full-access', label: zh ? '完全访问' : 'Full access' },
                ]}
                onChange={(permissionMode) => props.onChange({ ...props.form, permissionMode })}
                disabled={busy}
                searchable={false}
              />
            </label>
          </div>

          <p className="task-model-push-message" role={props.form.serviceTierDowngraded ? 'status' : undefined}>
            {props.form.serviceTierDowngraded
              ? zh
                ? '所选模型不支持原 Fast 档位，已保留模型并切换为标准。'
                : 'The selected model does not support the previous Fast tier. The model was kept and the tier changed to Standard.'
              : serviceTierDescription(props.form.serviceTier, selectedModel, props.language)}
          </p>

          {codexLoginRequired || authenticating ? (
            <section className="task-model-push-account" aria-live="polite">
              <span>
                <strong>{zh ? 'Zeus 专属 Codex 需要登录' : 'Sign in to Codex for Zeus'}</strong>
                <small>{zh ? 'Zeus 与 Codex App 使用独立账号状态，不会复制或覆盖 Codex App 的登录信息。' : 'Zeus keeps a separate account state and does not copy or overwrite the Codex App sign-in.'}</small>
              </span>
              <p>
                {authenticating
                  ? zh
                    ? '浏览器已打开。完成登录后，这里会自动继续创建当前会话。'
                    : 'Your browser is open. This conversation will be created automatically after sign-in.'
                  : zh
                    ? '点击“登录并继续”后会打开官方登录页；当前模型、工作区和补充信息都会保留。'
                    : 'Choose “Sign in and continue” to open the official sign-in page. Your current configuration will be preserved.'}
              </p>
            </section>
          ) : null}

          <label className="task-model-push-supplement">
            <span>{zh ? '补充信息（可选）' : 'Supplemental information (optional)'}</span>
            <textarea
              value={props.form.supplementalInfo}
              maxLength={20_000}
              onChange={(event) => props.onChange({ ...props.form, supplementalInfo: event.target.value })}
              disabled={busy}
              placeholder={zh ? '仅影响本次推送，不会修改任务本身。' : 'Applies only to this push and does not modify the task.'}
            />
          </label>

          {parentContextOptions.length > 0 ? (
            <section className="task-model-push-parent-context" aria-labelledby="task-model-push-parent-context-title">
              <span className="task-model-push-section-heading">
                <strong id="task-model-push-parent-context-title">{zh ? '父任务上下文' : 'Parent task context'}</strong>
                <small>{zh ? '默认全部不选；任务信息、会话路径和附件均按本次选择发送' : 'Nothing is selected by default; task details, session paths, and attachments are sent only when selected'}</small>
              </span>
              <div className="task-model-push-parent-list">
                {parentContextOptions.map((option) => {
                  const selection = props.form.parentContextSelections[option.taskId] ?? { selected: false, conversationIds: [], attachmentKeys: [] };
                  const selectedConversations = new Set(selection.conversationIds);
                  const selectedAttachments = new Set(selection.attachmentKeys);
                  return (
                    <fieldset key={option.taskId} className={selection.selected ? 'task-model-push-parent is-selected' : 'task-model-push-parent'}>
                      <legend>
                        <label>
                          <input type="checkbox" checked={selection.selected} onChange={(event) => toggleParentTask(option, event.currentTarget.checked)} disabled={busy} />
                          <span>
                            <strong>
                              {option.taskCode} · {option.taskTitle}
                            </strong>
                            <small>{option.taskType === 'defect' ? (zh ? '缺陷' : 'Defect') : option.taskType === 'optimization' ? (zh ? '优化' : 'Optimization') : zh ? '需求' : 'Requirement'}</small>
                          </span>
                        </label>
                      </legend>
                      {selection.selected ? (
                        <div className="task-model-push-parent-resources">
                          <div>
                            <strong>{zh ? '内部会话' : 'Sessions'}</strong>
                            {option.conversations.length > 0 ? (
                              option.conversations.map((conversation) => (
                                <label key={conversation.id} className={!conversation.available ? 'is-unavailable' : undefined}>
                                  <input
                                    type="checkbox"
                                    checked={selectedConversations.has(conversation.id)}
                                    onChange={(event) => toggleParentResource(option.taskId, 'conversationIds', conversation.id, event.currentTarget.checked)}
                                    disabled={busy || !conversation.available}
                                  />
                                  <span>
                                    <strong>{conversation.title}</strong>
                                    <small>
                                      {conversation.archived ? (zh ? '已归档 · ' : 'Archived · ') : ''}
                                      {conversation.available ? conversation.path : conversation.unavailableReason}
                                    </small>
                                  </span>
                                </label>
                              ))
                            ) : (
                              <small>{zh ? '没有会话' : 'No sessions'}</small>
                            )}
                          </div>
                          <div>
                            <strong>{zh ? '父任务附件' : 'Parent attachments'}</strong>
                            {option.attachments.length > 0 ? (
                              option.attachments.map((attachment) => {
                                const checked = selectedAttachments.has(attachment.key);
                                return (
                                  <label key={attachment.key} className={!attachment.available ? 'is-unavailable' : undefined}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(event) => toggleParentResource(option.taskId, 'attachmentKeys', attachment.key, event.currentTarget.checked)}
                                      disabled={busy || !attachment.available}
                                    />
                                    <span>
                                      <strong>{attachment.name}</strong>
                                      <small>{attachment.available ? `${attachment.kind}${attachment.size !== undefined ? ` · ${attachment.size} B` : ''}` : attachment.unavailableReason}</small>
                                    </span>
                                  </label>
                                );
                              })
                            ) : (
                              <small>{zh ? '没有附件' : 'No attachments'}</small>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </fieldset>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="task-model-push-canonical">
            <strong>{zh ? '将发送的任务内容' : 'Task content to send'}</strong>
            <pre>{buildTaskModelPushMessage(props.task, props.form.supplementalInfo, selectedParentContexts)}</pre>
          </section>

          <section className="task-model-push-attachments">
            <span>
              <strong>{zh ? '附件' : 'Attachments'}</strong>
              <small>{attachments.length + selectedParentAttachmentCount}</small>
            </span>
            {attachments.length > 0 ? (
              <TaskAttachmentPreviewList
                attachments={attachments}
                mode="readonly"
                onLoadPreview={props.onLoadAttachmentPreview}
                onOpenAttachment={props.onOpenAttachment}
                copy={{
                  imageLabel: zh ? '图片' : 'Image',
                  fileLabel: zh ? '文件' : 'File',
                  openFileLabel: zh ? '打开附件' : 'Open attachment',
                  openPreviewLabel: zh ? '预览附件' : 'Preview attachment',
                  closePreviewLabel: zh ? '关闭预览' : 'Close preview',
                  previewUnavailable: zh ? '无法预览' : 'Preview unavailable',
                  localPathLabel: zh ? '本机路径' : 'Local path',
                }}
              />
            ) : (
              <small>{zh ? '无附件' : 'No attachments'}</small>
            )}
            {selectedParentAttachmentCount > 0 ? (
              <small>{zh ? `另有 ${selectedParentAttachmentCount} 个父任务附件，将随本次推送发送。` : `${selectedParentAttachmentCount} parent attachment(s) will be sent with this push.`}</small>
            ) : null}
          </section>

          {props.status === 'loading' ? <p className="task-model-push-message">{zh ? '正在连接 app-server 并读取可用模型…' : 'Connecting to app-server and loading models…'}</p> : null}
          {props.error ? (
            <p className="task-model-push-error" role="alert">
              {props.error}
            </p>
          ) : null}
        </div>

        <footer className="task-model-push-footer">
          <small>{zh ? '确认后会创建新会话并立即进入；历史会话不会被覆盖。' : 'A new conversation will be created and opened; history remains unchanged.'}</small>
          <span>
            <Button variant="secondary" size="regular" onClick={authenticating ? props.onCancelAuthentication : props.onClose} disabled={props.status === 'submitting'}>
              {authenticating ? (zh ? '取消登录' : 'Cancel sign-in') : zh ? '取消' : 'Cancel'}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="regular"
              busy={busy}
              disabled={
                busy ||
                props.status === 'loading' ||
                !props.form.model ||
                (props.form.workspaceMode === 'direct'
                  ? directWorkspaceNeedsConfirmation && !props.form.directConcurrencyConfirmed
                  : repositories.length === 0 ||
                    repositories.some((repository) => {
                      const selection = props.form.repositorySelections[repository.id];
                      return !selection?.sourceRef || !selection.branchName.trim();
                    }))
              }
            >
              {authenticating
                ? zh
                  ? '等待登录…'
                  : 'Waiting for sign-in…'
                : props.status === 'submitting'
                  ? zh
                    ? '正在创建…'
                    : 'Creating…'
                  : codexLoginRequired
                    ? zh
                      ? '登录并继续'
                      : 'Sign in and continue'
                    : zh
                      ? '创建新会话'
                      : 'Create conversation'}
            </Button>
          </span>
        </footer>
      </form>
    </ModalPortal>
  );
  return modal;
}
