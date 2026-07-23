import {createPortal} from 'react-dom';
import type {FormEvent, KeyboardEvent} from 'react';
import type {TaskRecord} from '../apiClient.js';
import type {CodexTaskPushCapabilities, NativePermissionMode} from '../session/sessionTypes.js';
import {ZeusSelect} from '../ZeusSelect.js';
import {TaskAttachmentPreviewList} from './TaskAttachmentPreviewList.js';
import {parseTaskAttachments} from './taskAttachments.js';

export interface TaskModelPushForm {
  model: string;
  effort: string;
  workMode: 'default' | 'plan';
  permissionMode: NativePermissionMode;
  supplementalInfo: string;
}

export type TaskModelPushModalStatus = 'loading' | 'ready' | 'submitting' | 'error';

export type TaskModelPushPreferences = Omit<TaskModelPushForm, 'supplementalInfo'>;

const preferencesKeyPrefix = 'zeus.task-model-push-preferences:v1:';

export function buildTaskModelPushMessage(canonicalPrompt: string, supplementalInfo: string): string {
    const supplement = supplementalInfo.trim();
    return supplement ? `${canonicalPrompt}\n\n## 本次推送补充信息\n${supplement}` : canonicalPrompt;
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

export function resolveTaskModelPushInitialForm(capabilities: CodexTaskPushCapabilities, remembered: TaskModelPushPreferences | null): TaskModelPushForm {
  const rememberedModel = capabilities.models.find((model) => model.model === remembered?.model || model.id === remembered?.model);
  const selectedModel = rememberedModel ?? capabilities.models.find((model) => model.model === capabilities.preferredModel || model.id === capabilities.preferredModel) ?? capabilities.models[0];
  if (!selectedModel) throw new Error('Codex app-server did not report an available model.');
  const effort = rememberedModel && remembered && selectedModel.supportedReasoningEfforts.includes(remembered.effort) ? remembered.effort : (selectedModel.defaultReasoningEffort ?? selectedModel.supportedReasoningEfforts[0] ?? '');
  return {
    model: selectedModel.model,
    effort,
    workMode: remembered?.workMode ?? 'default',
    // 用户已确认：项目没有成功记忆时，权限必须回退为只读。
    permissionMode: remembered?.permissionMode ?? 'read-only',
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
    const canonicalPrompt = props.capabilities?.canonicalPrompt ?? `${zh ? '任务标题' : 'Task title'}：${props.task.title}\n${zh ? '任务要求' : 'Task request'}：${props.task.description?.trim() || (zh ? '未填写' : 'Not provided')}`;

  function onModelChange(model: string): void {
    const capability = props.capabilities?.models.find((candidate) => candidate.model === model || candidate.id === model);
    props.onChange({
      ...props.form,
      model: capability?.model ?? model,
      effort: capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? '',
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Escape' && !busy) props.onClose();
  }

  const modal = (
    <div className="macos-ai-app task-model-push-portal-root">
      <div className="task-model-push-backdrop" onPointerDown={(event) => event.currentTarget === event.target && !busy && props.onClose()}>
        <form className="task-model-push-modal" role="dialog" aria-modal="true" aria-labelledby="task-model-push-title" onSubmit={props.onSubmit} onKeyDown={handleKeyDown}>
          <header className="task-model-push-header">
            <span>
              <strong id="task-model-push-title">{zh ? '推送到模型' : 'Push to model'}</strong>
              <small>{props.projectName ? `${props.projectName} · ${props.task.taskCode ?? props.task.id}` : (props.task.taskCode ?? props.task.id)}</small>
            </span>
            <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={busy}>
              ×
            </button>
          </header>

          <div className="task-model-push-body">
            <div className="task-model-push-config-grid">
              <label>
                <span>{zh ? '模型' : 'Model'}</span>
                  <ZeusSelect
                      ariaLabel={zh ? '模型' : 'Model'}
                      value={props.form.model}
                      options={(props.capabilities?.models ?? []).map((model) => ({
                          value: model.model,
                          label: model.displayName ?? model.model
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
                      ariaLabel={zh ? '模型等级' : 'Reasoning effort'}
                      value={props.form.effort}
                      options={(selectedModel?.supportedReasoningEfforts ?? []).map((effort) => ({
                          value: effort,
                          label: effort
                      }))}
                      onChange={(effort) => props.onChange({...props.form, effort})}
                      disabled={!selectedModel || busy}
                      searchable={false}
                  />
              </label>
              <label>
                <span>{zh ? '工作模式' : 'Work mode'}</span>
                  <ZeusSelect
                      ariaLabel={zh ? '工作模式' : 'Work mode'}
                      value={props.form.workMode}
                      options={[
                          {value: 'default', label: zh ? '默认' : 'Default'},
                          {value: 'plan', label: zh ? '规划' : 'Plan'},
                      ]}
                      onChange={(workMode) => props.onChange({...props.form, workMode})}
                      disabled={busy}
                      searchable={false}
                  />
              </label>
              <label>
                <span>{zh ? '权限模式' : 'Permission mode'}</span>
                  <ZeusSelect<NativePermissionMode>
                      ariaLabel={zh ? '权限模式' : 'Permission mode'}
                      value={props.form.permissionMode}
                      options={[
                          {value: 'read-only', label: zh ? '只读' : 'Read only'},
                          {value: 'auto', label: zh ? '自动' : 'Auto'},
                          {value: 'full-access', label: zh ? '完全访问' : 'Full access'},
                      ]}
                      onChange={(permissionMode) => props.onChange({...props.form, permissionMode})}
                      disabled={busy}
                      searchable={false}
                  />
              </label>
            </div>

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
                <pre>{buildTaskModelPushMessage(canonicalPrompt, props.form.supplementalInfo)}</pre>
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
              <small>{zh ? '推送后将立即进入会话；成功后才会记住本次选择。' : 'You will enter the conversation immediately; selections are remembered after success.'}</small>
            <span>
              <button type="button" onClick={props.onClose} disabled={busy}>
                {zh ? '取消' : 'Cancel'}
              </button>
              <button type="submit" className="task-model-push-submit" disabled={props.status === 'loading' || busy || !props.form.model}>
                {busy ? (zh ? '正在推送…' : 'Pushing…') : zh ? '确认推送' : 'Push'}
              </button>
            </span>
          </footer>
        </form>
      </div>
    </div>
  );
  return typeof document !== 'undefined' && document.body ? createPortal(modal, document.body) : modal;
}
