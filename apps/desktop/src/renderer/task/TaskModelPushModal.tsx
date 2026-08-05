import type { FormEvent, KeyboardEvent } from 'react';
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
  repositorySelections: Record<string, { sourceRef: string; branchName: string }>;
  supplementalInfo: string;
}

export type TaskModelPushModalStatus = 'loading' | 'ready' | 'submitting' | 'error';

export type TaskModelPushPreferences = Pick<TaskModelPushForm, 'model' | 'effort' | 'workMode' | 'permissionMode'>;

const preferencesKeyPrefix = 'zeus.task-model-push-preferences:v1:';

export function buildTaskModelPushMessage(task: Pick<TaskRecord, 'title' | 'description'>, supplementalInfo: string): string {
  const description = [task.description?.trim() ?? '', supplementalInfo.trim()].filter(Boolean).join('\n\n') || '未提供';
  return `任务标题：${task.title.trim()}\n任务描述：${description}`;
}

export function readTaskModelPushPreferences(storage: Pick<Storage, 'getItem'> | undefined, projectId: string): TaskModelPushPreferences | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(`${preferencesKeyPrefix}${encodeURIComponent(projectId)}`) ?? 'null') as Partial<TaskModelPushPreferences> | null;
    if (!value || typeof value.model !== 'string' || typeof value.effort !== 'string') return null;
    if (value.workMode !== 'default' && value.workMode !== 'plan') return null;
    if (value.permissionMode !== 'read-only' && value.permissionMode !== 'auto' && value.permissionMode !== 'full-access') return null;
    return value as TaskModelPushPreferences;
  } catch {
    return null;
  }
}

export function writeTaskModelPushPreferences(storage: Pick<Storage, 'setItem'> | undefined, projectId: string, form: TaskModelPushForm): void {
  if (!storage) return;
  storage.setItem(`${preferencesKeyPrefix}${encodeURIComponent(projectId)}`, JSON.stringify({ model: form.model, effort: form.effort, workMode: form.workMode, permissionMode: form.permissionMode } satisfies TaskModelPushPreferences));
}

export function resolveTaskModelPushInitialForm(capabilities: CodexTaskPushCapabilities, remembered: TaskModelPushPreferences | null, serviceTier: NativeServiceTierSelection = { type: 'follow' }): TaskModelPushForm {
  const rememberedModel = capabilities.models.find((model) => model.model === remembered?.model || model.id === remembered?.model);
  const selectedModel = rememberedModel ?? capabilities.models.find((model) => model.model === capabilities.preferredModel || model.id === capabilities.preferredModel) ?? capabilities.models[0];
  if (!selectedModel) throw new Error('Codex app-server did not report an available model.');
  const effort = rememberedModel && remembered && selectedModel.supportedReasoningEfforts.includes(remembered.effort) ? remembered.effort : (selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? '');
  return {
    model: selectedModel.model,
    effort,
    serviceTier: normalizeServiceTierSelection(serviceTier, selectedModel).selection,
    serviceTierDowngraded: serviceTier.type === 'catalog' && !selectedModel.serviceTiers.some((tier) => tier.id === serviceTier.id),
    workMode: remembered?.workMode ?? 'default',
    // 用户已确认：项目没有成功记忆时，权限必须回退为只读。
    permissionMode: remembered?.permissionMode ?? 'read-only',
    repositorySelections: Object.fromEntries(
      capabilities.repositories.map((repository) => [
        repository.id,
        {
          // 每个仓库都要求用户在弹窗内确认，初始值不替用户选择来源分支。
          sourceRef: '',
          branchName: repository.suggestedBranchName,
        },
      ]),
    ),
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
  error: string | null;
  onChange: (next: TaskModelPushForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onLoadAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
}) {
  if (!props.open || !props.task) return null;
  const zh = props.language === 'zh-CN';
  const busy = props.status === 'submitting';
  const attachments = parseTaskAttachments(props.task.sourceContextJson);
  const selectedModel = props.capabilities?.models.find((model) => model.model === props.form.model || model.id === props.form.model);
  const repositories = props.capabilities?.repositories ?? [];
  const repositoryRegistrationRequired = props.capabilities?.repositoryRegistrationRequired === true;

  function onModelChange(model: string): void {
    const capability = props.capabilities?.models.find((candidate) => candidate.model === model || candidate.id === model);
    const normalizedTier = normalizeServiceTierSelection(props.form.serviceTier, capability);
    props.onChange({
      ...props.form,
      model: capability?.model ?? model,
      effort: capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? '',
      serviceTier: normalizedTier.selection,
      serviceTierDowngraded: normalizedTier.downgraded,
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Escape' && !busy) props.onClose();
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
              <small>{zh ? '每次推送都会从本次选择的来源创建独立目录和分支' : 'Every push creates an isolated directory and branch from the selected source'}</small>
            </span>
            {repositories.length > 0 ? (
              <div className="task-model-push-repository-list">
                {repositories.map((repository) => {
                  const selection = props.form.repositorySelections[repository.id] ?? { sourceRef: '', branchName: repository.suggestedBranchName };
                  return (
                    <fieldset key={repository.id} className="task-model-push-repository">
                      <legend>
                        <strong>{repository.name}</strong>
                        <small>{repository.relativePath}</small>
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
                                label: `${source.label}${source.current ? (zh ? ' · 当前' : ' · current') : ''}`,
                              })),
                            ]}
                            onChange={(sourceRef) =>
                              props.onChange({
                                ...props.form,
                                repositorySelections: { ...props.form.repositorySelections, [repository.id]: { ...selection, sourceRef } },
                              })
                            }
                            disabled={!props.capabilities || busy}
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
                      {repository.clean === false ? (
                        <p className="task-model-push-warning">
                          {zh ? '该仓库的未提交改动会带入新任务工作区；忽略文件仅按 .worktreeinclude 带入。' : 'Uncommitted changes are copied into the new task workspace; ignored files are included only through .worktreeinclude.'}
                        </p>
                      ) : null}
                    </fieldset>
                  );
                })}
              </div>
            ) : repositoryRegistrationRequired ? (
              <p className="task-model-push-error" role="alert">
                {zh
                  ? `已发现 ${props.capabilities?.discoveredRepositories.length ?? 0} 个 Git 仓库，请先到项目设置确认任务仓库后再推送。`
                  : `${props.capabilities?.discoveredRepositories.length ?? 0} Git repositories were found. Confirm the task repositories in project settings before pushing.`}
              </p>
            ) : (
              <p className="task-model-push-message">
                {zh ? '该项目未登记 Git 仓库，将直接使用项目目录，不创建分支或 worktree。' : 'No Git repositories are registered. The project directory is used directly without branches or worktrees.'}
              </p>
            )}
            <small className="task-model-push-worktree-root">
              {zh ? '新工作区路径' : 'New workspace path'}：{props.capabilities?.git.worktreeRoot ?? '—'}/&lt;{zh ? '项目' : 'project'}&gt;/&lt;{zh ? '推送标识' : 'push-id'}&gt;/{props.task.taskCode ?? props.task.id}
            </small>
          </section>

          <div className="task-model-push-config-grid">
            <label>
              <span>{zh ? '模型' : 'Model'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '模型' : 'Model'}
                value={props.form.model}
                options={(props.capabilities?.models ?? []).map((model) => ({
                  value: model.model,
                  label: model.displayName ?? model.model,
                }))}
                onChange={onModelChange}
                disabled={!props.capabilities || busy}
                searchPlaceholder={zh ? '搜索模型' : 'Search models'}
                emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
              />
            </label>
            <label>
              <span>{zh ? '模型等级' : 'Reasoning effort'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '模型等级' : 'Reasoning effort'}
                value={props.form.effort}
                options={(selectedModel?.supportedReasoningEfforts ?? []).map((effort) => ({
                  value: effort,
                  label: effort,
                }))}
                onChange={(effort) => props.onChange({ ...props.form, effort })}
                disabled={!selectedModel || busy}
                searchable={false}
              />
            </label>
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

          <section className="task-model-push-canonical">
            <strong>{zh ? '将发送的任务内容' : 'Task content to send'}</strong>
            <pre>{buildTaskModelPushMessage(props.task, props.form.supplementalInfo)}</pre>
          </section>

          <section className="task-model-push-attachments">
            <span>
              <strong>{zh ? '附件' : 'Attachments'}</strong>
              <small>{attachments.length}</small>
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
            <Button variant="secondary" size="regular" onClick={props.onClose} disabled={busy}>
              {zh ? '取消' : 'Cancel'}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="regular"
              busy={busy}
              disabled={
                props.status === 'loading' ||
                !props.form.model ||
                repositoryRegistrationRequired ||
                repositories.some((repository) => {
                  const selection = props.form.repositorySelections[repository.id];
                  return !selection?.sourceRef || !selection.branchName.trim();
                })
              }
            >
              {busy ? (zh ? '正在创建…' : 'Creating…') : zh ? '创建新会话' : 'Create conversation'}
            </Button>
          </span>
        </footer>
      </form>
    </ModalPortal>
  );
  return modal;
}
