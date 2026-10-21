import { useEffect, useRef, useState } from 'react';
import { GearSixIcon } from '@phosphor-icons/react/dist/csr/GearSix';
import { defaultGitDeliverySettings, defaultTaskManagementStatusLabels, type GitDeliveryInput, type GitDeliveryRun, type GitDeliverySettings, type GitDeliveryStep, type TaskManagementStatusDefinition } from '@zeus/shared';
import type { DashboardClient } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { FormDialog } from '../ui/FormDialog.js';
import { loadGitCommitModelOptions } from './gitCommitModels.js';
import { GitCommitGenerationSettingsButton } from './GitCommitGenerationSettings.js';
import { VisibleApplicationError, formatVisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { SkillSelector } from '../features/skills/SkillSelector.js';
import { ConflictAiPermissions, TaskGitConflictWorkspace } from '../task/TaskGitConflictWorkspace.js';
import { createConflictDocument, serializeConflictForGit, countUnresolvedConflictBlocks, type ConflictDocument } from '../task/taskConflictModel.js';
import type { TaskIntegrationConflictFile } from '../session/sessionTypes.js';

/** 两个入口使用同一后台交付客户端。 */
export type GitDeliveryClient = Pick<
  DashboardClient,
  | 'loadGitDeliveryRuns'
  | 'loadGitDeliveryOptions'
  | 'startGitDeliveryRun'
  | 'loadGitCommitModels'
  | 'resumeGitDeliveryRun'
  | 'acknowledgeGitDelivery'
  | 'loadGitDeliveryConflict'
  | 'saveGitDeliveryConflict'
  | 'startGitDeliveryConflictAi'
  | 'loadSkills'
  | 'subscribeEvents'
>;

/** 本机项目偏好只保存操作选择，不保存文件或分支。 */
function readSettings(projectId: string): GitDeliverySettings {
  try {
    const value = JSON.parse(localStorage.getItem(`zeus.git-delivery.settings:${projectId}`) ?? 'null') as Partial<GitDeliverySettings> | null;
    if (
      !value ||
      ['commit', 'merge', 'push', 'resolveConflicts'].some((key) => typeof value[key as 'commit'] !== 'boolean') ||
      (value.generateCommitMessage !== undefined && typeof value.generateCommitMessage !== 'boolean') ||
      !['auto', 'full-access'].includes(value.permissionMode ?? '') ||
      (value.skillId !== null && typeof value.skillId !== 'string') ||
      (value.finalTaskStatus !== null && typeof value.finalTaskStatus !== 'string')
    )
      return { ...defaultGitDeliverySettings };
    return { ...defaultGitDeliverySettings, ...value };
  } catch {
    return { ...defaultGitDeliverySettings };
  }
}

/** 固定步骤的用户文案同时用于摘要和运行进度。 */
function actionLabel(action: GitDeliveryStep['action'], zh: boolean): string {
  return { commit: zh ? '提交' : 'Commit', merge: zh ? '合入' : 'Merge', push: zh ? '推送' : 'Push', task_status: zh ? '任务状态' : 'Task status' }[action];
}

/** 运行控件不持有执行循环，只接纳固定输入并显示后台事实。 */
export function GitDeliveryRunControl(props: {
  /** 原有已认证客户端。 */
  client: GitDeliveryClient;
  /** 当前真实项目。 */
  projectId: string;
  /** 当前输入；点击时再次固定副本。 */
  input: Omit<GitDeliveryInput, 'settings'>;
  /** 原页正在处理单步操作。 */
  disabled: boolean;
  /** 当前语言。 */
  zh: boolean;
  /** 只有服务端持久接纳后才关闭原窗口。 */
  onAccepted(): void;
}) {
  /** 已保存设置与表单草稿分离。 */
  const [settings, setSettings] = useState(() => readSettings(props.projectId));
  /** 设置弹窗草稿。 */
  const [draft, setDraft] = useState<GitDeliverySettings | null>(null);
  /** 项目当前真实状态定义。 */
  const [statuses, setStatuses] = useState<TaskManagementStatusDefinition[]>([]);
  /** 后台结果不从文件列表推算。 */
  const [runs, setRuns] = useState<GitDeliveryRun[]>([]);
  /** 加载、接纳或继续时阻止重复操作。 */
  const [busy, setBusy] = useState(false);
  /** 保留失败原因与手动重读入口。 */
  const [error, setError] = useState<string | null>(null);
  /** 终态清理只能在用户看到真实影响后明确确认。 */
  const [cleanupRun, setCleanupRun] = useState<GitDeliveryRun | null>(null);
  /** 真实接纳身份在未知响应重试时保持不变。 */
  const request = useRef<{ json: string; sourceJson: string; key: string } | null>(null);
  /** React 更新前的同步锁。 */
  const pending = useRef(false);
  /** 后台查询只属于当前入口。 */
  const scopeId = props.input.scope.kind === 'task' ? props.input.scope.taskId : props.input.scope.conversationId;
  /** 冲突页复用原三栏编辑器。 */
  const [conflict, setConflict] = useState<{ run: GitDeliveryRun; step: GitDeliveryStep; files: string[]; sourceBranch: string; targetBranch: string; file: TaskIntegrationConflictFile | null } | null>(null);
  /** 用户编辑内容只在保存或 AI 接管时发送。 */
  const [document, setDocument] = useState<ConflictDocument | null>(null);
  /** 当前是否有已接纳运行。 */
  const running = runs.some((run) => run.state === 'queued' || run.state === 'running');

  /** 操作栏只保留进行中或待处理运行，成功历史不再占用交付空间。 */
  const visibleRuns = runs.filter((run) => run.state !== 'succeeded').slice(0, 5);

  /** 重开窗口或实时变化都重新查询服务端进度。 */
  async function refresh(): Promise<void> {
    const result = await props.client.loadGitDeliveryRuns(props.projectId, scopeId);
    setRuns(result.items);
  }

  useEffect(() => {
    let disposed = false;
    /** 合并同一批逐仓事件，避免完成通知产生请求风暴。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      if (disposed) return;
      void props.client
        .loadGitDeliveryRuns(props.projectId, scopeId)
        .then((result) => {
          if (!disposed) setRuns(result.items);
        })
        .catch((reason) => {
          if (!disposed) setError(formatVisibleApplicationError(reason, props.zh ? 'zh-CN' : 'en'));
        });
    };
    reload();
    const unsubscribe = props.client.subscribeEvents(
      (event) => {
        if (event.type === 'project.git_delivery.changed') {
          clearTimeout(timer);
          timer = setTimeout(reload, 80);
        }
      },
      (state) => {
        if (state === 'connected') reload();
      },
    );
    window.addEventListener('focus', reload);
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', reload);
    };
  }, [props.client, props.projectId, scopeId, props.zh]);

  /** 设置打开时读取项目状态，不用全局默认代替真实定义。 */
  async function openSettings(): Promise<void> {
    setError(null);
    setDraft({ ...settings });
    try {
      setStatuses((await props.client.loadGitDeliveryOptions(props.projectId)).statuses);
    } catch (reason) {
      setError(formatVisibleApplicationError(reason, props.zh ? 'zh-CN' : 'en'));
    }
  }

  /** 将固定快照交给后台；成功后不等待任何 Git 或 AI 步骤。 */
  async function start(): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      /** 读取模型前固定文件和设置，接纳重试继续使用同一快照。 */
      const sourceJson = JSON.stringify({ ...props.input, settings: { ...settings, finalTaskStatus: props.input.scope.kind === 'task' ? settings.finalTaskStatus : null } });
      if (request.current?.sourceJson !== sourceJson) {
        /** 模型参数随运行冻结，之后修改项目偏好不影响已接纳步骤。 */
        const input = JSON.parse(sourceJson) as GitDeliveryInput;
        if (input.settings.commit && input.settings.generateCommitMessage && input.repositories.some((repository) => repository.paths.length > 0)) {
          /** 与原 AI 生成按钮共用模型、推理深度和速率偏好。 */
          const models = await loadGitCommitModelOptions(props.client, props.projectId);
          if (!models.modelRef) throw new Error(models.warning || (props.zh ? '暂无可用模型，请在 AI 生成设置中选择模型。' : 'No model is available. Choose a model in AI generation settings.'));
          input.commitMessageGeneration = { ...models.settings, language: props.zh ? 'zh-CN' : 'en' };
        }
        request.current = { json: JSON.stringify(input), sourceJson, key: crypto.randomUUID() };
      }
      await props.client.startGitDeliveryRun(props.projectId, JSON.parse(request.current.json) as GitDeliveryInput, request.current.key);
      request.current = null;
      props.onAccepted();
    } catch (reason) {
      setError(formatVisibleApplicationError(reason, props.zh ? 'zh-CN' : 'en'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  /** 手动继续沿用原运行，已成功步骤不再执行。 */
  async function resume(run: GitDeliveryRun, confirmWorktreeCleanup = false): Promise<void> {
    if (!confirmWorktreeCleanup && run.steps.some((step) => step.state === 'attention' && step.cleanupConfirmation)) {
      setCleanupRun(run);
      return;
    }
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await props.client.resumeGitDeliveryRun(props.projectId, run.id, confirmWorktreeCleanup ? { confirmWorktreeCleanup: true } : undefined);
      setCleanupRun(null);
      await refresh();
    } catch (reason) {
      setError(formatVisibleApplicationError(reason, props.zh ? 'zh-CN' : 'en'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  /** 打开已经存在的原冲突会话，不重复创建。 */
  async function openConversation(run: GitDeliveryRun, conversationId: string): Promise<void> {
    try {
      if (!window.zeus?.openTaskGitDeliveryConversation) throw new Error(props.zh ? '会话导航暂不可用。' : 'Conversation navigation is unavailable.');
      await window.zeus.openTaskGitDeliveryConversation(run.scope.kind === 'task' ? { taskId: run.scope.taskId, conversationId } : { projectId: run.projectId, conversationId });
      props.onAccepted();
    } catch (reason) {
      setError(formatVisibleApplicationError(reason, props.zh ? 'zh-CN' : 'en'));
    }
  }

  /** 冲突文件切换后只使用新读取的三方指纹。 */
  async function openConflict(run: GitDeliveryRun, step: GitDeliveryStep, path?: string): Promise<void> {
    setBusy(true);
    try {
      const current = await props.client.loadGitDeliveryConflict(props.projectId, run.id, step.id, path);
      const loaded = !path && current.files[0] ? await props.client.loadGitDeliveryConflict(props.projectId, run.id, step.id, current.files[0]) : current;
      setConflict({ run, step, ...loaded });
      setDocument(loaded.file ? createConflictDocument(loaded.file) : null);
    } catch (reason) {
      setError(formatVisibleApplicationError(reason, props.zh ? 'zh-CN' : 'en'));
    } finally {
      setBusy(false);
    }
  }

  /** 保存全部已解决块后由服务端继续检查合入条件。 */
  async function saveConflict(): Promise<void> {
    if (!conflict?.file || !document) return;
    setBusy(true);
    try {
      await props.client.saveGitDeliveryConflict(props.projectId, conflict.run.id, conflict.step.id, { path: conflict.file.path, content: serializeConflictForGit(document), fingerprint: conflict.file.fingerprint });
      await openConflict(conflict.run, conflict.step);
    } catch (reason) {
      setError(formatVisibleApplicationError(reason, props.zh ? 'zh-CN' : 'en'));
    } finally {
      setBusy(false);
    }
  }

  /** 任务状态变更保留按钮提示，具体配置统一在设置中查看。 */
  const finalStatusLabel = statuses.find((status) => status.id === settings.finalTaskStatus)?.label ?? defaultTaskManagementStatusLabels[props.zh ? 'zh-CN' : 'en-US'][settings.finalTaskStatus ?? ''] ?? settings.finalTaskStatus;
  /** 按钮名称直接表达实际执行顺序，不再重复渲染功能说明。 */
  const summary = (['commit', 'merge', 'push'] as const)
    .filter((action) => settings[action])
    .map((action) => actionLabel(action, props.zh))
    .join(' → ');
  return (
    <section className="task-git-delivery-action-step git-delivery-combination" aria-label={props.zh ? '组合交付' : 'Combined delivery'}>
      <div className="git-delivery-combination-buttons">
        <Button
          variant="primary"
          size="compact"
          busy={busy}
          disabled={props.disabled || busy || running || !props.input.repositories.length || !summary}
          data-icon-tooltip={settings.finalTaskStatus && props.input.scope.kind === 'task' ? (props.zh ? `完成后状态：${finalStatusLabel}` : `Final status: ${finalStatusLabel}`) : undefined}
          onClick={() => void start()}
        >
          {summary || (props.zh ? '执行交付' : 'Run delivery')}
        </Button>
        <Button variant="secondary" size="compact" disabled={busy} aria-label={props.zh ? '组合操作设置' : 'Combination settings'} data-icon-tooltip={props.zh ? '组合操作设置' : 'Combination settings'} onClick={() => void openSettings()}>
          <GearSixIcon aria-hidden="true" />
        </Button>
      </div>
      {error ? (
        <div role="alert">
          <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} />
          <Button
            size="compact"
            onClick={() => {
              setError(null);
              void refresh().catch((reason) => setError(String(reason)));
            }}
          >
            {props.zh ? '重新读取' : 'Reload'}
          </Button>
        </div>
      ) : null}
      {visibleRuns.map((run) => (
        <section key={run.id} className="git-delivery-run" aria-label={props.zh ? '交付进度' : 'Delivery progress'}>
          <strong>
            {run.state === 'attention' ? (props.zh ? '交付需要处理' : 'Delivery needs attention') : props.zh ? '后台交付中' : 'Delivering in background'} · {run.steps.filter((step) => step.state === 'succeeded').length}/{run.steps.length}
          </strong>
          <ul>
            {run.steps
              .filter((step) => step.state !== 'succeeded' && step.state !== 'pending')
              .map((step) => (
                <li key={step.id}>
                  <strong>{step.action === 'task_status' ? actionLabel(step.action, props.zh) : `${step.repositoryName} · ${actionLabel(step.action, props.zh)}`}</strong>
                  <span>
                    {
                      {
                        pending: props.zh ? '等待前序步骤' : 'Pending',
                        running: props.zh ? '执行中' : 'Running',
                        waiting: props.zh ? 'AI 处理中' : 'AI running',
                        attention: props.zh ? '需要处理' : 'Needs attention',
                        unknown: props.zh ? '结果待核对' : 'Outcome unknown',
                        succeeded: props.zh ? '已完成' : 'Completed',
                      }[step.state]
                    }
                  </span>
                  {step.message ? <small>{step.message}</small> : null}
                  {step.conversationId ? (
                    <Button size="compact" onClick={() => void openConversation(run, step.conversationId!)}>
                      {props.zh ? '打开冲突会话' : 'Open conflict conversation'}
                    </Button>
                  ) : null}
                  {step.action === 'merge' && ['attention', 'waiting'].includes(step.state) ? (
                    <Button size="compact" disabled={busy} onClick={() => void openConflict(run, step)}>
                      {props.zh ? '处理冲突' : 'Resolve conflicts'}
                    </Button>
                  ) : null}
                </li>
              ))}
          </ul>
          {run.state === 'attention' ? (
            <Button size="compact" disabled={busy} onClick={() => void resume(run)}>
              {props.zh ? '继续未完成步骤' : 'Continue remaining steps'}
            </Button>
          ) : null}
        </section>
      ))}
      {cleanupRun ? (
        <FormDialog
          danger
          title={props.zh ? '确认任务结束清理' : 'Confirm task cleanup'}
          description={
            props.zh ? '该状态变更需要停止并归档任务会话，并永久移除任务工作树。未提交的修改会被删除。' : 'This status change stops and archives task sessions and permanently removes task worktrees, including uncommitted changes.'
          }
          zh={props.zh}
          busy={busy}
          submitLabel={props.zh ? '确认清理并继续' : 'Confirm cleanup and continue'}
          onClose={() => setCleanupRun(null)}
          onSubmit={(event) => {
            event.preventDefault();
            void resume(cleanupRun, true);
          }}
        >
          {cleanupRun.steps
            .filter((step) => step.cleanupConfirmation)
            .map((step) => (
              <p key={step.id}>
                {props.zh
                  ? `有修改的工作区：${step.cleanupConfirmation!.dirtyWorkspaceCount}；活动会话：${step.cleanupConfirmation!.activeConversationCount}；活动运行：${step.cleanupConfirmation!.activeRuntimeSessionCount}`
                  : `${step.cleanupConfirmation!.dirtyWorkspaceCount} modified worktrees; ${step.cleanupConfirmation!.activeConversationCount} active conversations; ${step.cleanupConfirmation!.activeRuntimeSessionCount} active runtimes`}
              </p>
            ))}
          {error ? <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} /> : null}
        </FormDialog>
      ) : null}
      {draft ? (
        <FormDialog
          title={props.zh ? '组合操作设置' : 'Combination settings'}
          description={props.zh ? '按项目保存。各仓库独立执行，只有全部成功才更新任务状态。' : 'Saved for this project. Repositories run independently; task status changes only after all succeed.'}
          zh={props.zh}
          busy={busy}
          submitLabel={props.zh ? '保存' : 'Save'}
          submitDisabled={!draft.commit && !draft.merge && !draft.push}
          onClose={() => setDraft(null)}
          onSubmit={(event) => {
            event.preventDefault();
            try {
              localStorage.setItem(`zeus.git-delivery.settings:${props.projectId}`, JSON.stringify(draft));
              setSettings(draft);
              setDraft(null);
            } catch {
              setError(props.zh ? '设置保存失败，请重试。' : 'Could not save settings.');
            }
          }}
        >
          {error ? <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} /> : null}
          {(['commit', 'merge', 'push'] as const).map((action, index) => (
            <div key={action} className="git-delivery-operation-row">
              <label className="git-delivery-checkbox">
                <input type="checkbox" checked={draft[action]} onChange={(event) => setDraft({ ...draft, [action]: event.target.checked })} />
                {index + 1}. {actionLabel(action, props.zh)}
              </label>
              {action === 'commit' ? (
                <>
                  <label className="git-delivery-checkbox" aria-disabled={!draft.commit}>
                    <input type="checkbox" checked={draft.generateCommitMessage} disabled={!draft.commit || busy} onChange={(event) => setDraft({ ...draft, generateCommitMessage: event.target.checked })} />
                    {props.zh ? 'AI 生成提交信息' : 'Generate commit messages with AI'}
                  </label>
                  <GitCommitGenerationSettingsButton client={props.client} projectId={props.projectId} zh={props.zh} disabled={busy} />
                </>
              ) : null}
            </div>
          ))}
          <label className="git-delivery-checkbox">
            <input type="checkbox" checked={draft.resolveConflicts} onChange={(event) => setDraft({ ...draft, resolveConflicts: event.target.checked })} />
            {props.zh ? '出现合入冲突时自动交给 AI，成功后继续' : 'Automatically resolve merge conflicts with AI and continue'}
          </label>
          {draft.resolveConflicts ? (
            <>
              <ConflictAiPermissions zh={props.zh} value={draft.permissionMode} disabled={busy} onChange={(value) => setDraft({ ...draft, permissionMode: value })} />
              <SkillSelector client={props.client} projectId={props.projectId} value={draft.skillId ?? ''} onChange={(value) => setDraft({ ...draft, skillId: value || null })} language={props.zh ? 'zh-CN' : 'en-US'} />
            </>
          ) : null}
          {props.input.scope.kind === 'task' ? (
            <label>
              <span>{props.zh ? '最后变更任务状态' : 'Final task status'}</span>
              <ZeusSelect
                size="compact"
                value={draft.finalTaskStatus ?? ''}
                options={[
                  { value: '', label: props.zh ? '不变更' : 'Do not change' },
                  ...statuses.map((status) => ({ value: status.id, label: status.label ?? defaultTaskManagementStatusLabels[props.zh ? 'zh-CN' : 'en-US'][status.id] ?? status.id })),
                ]}
                onChange={(value) => setDraft({ ...draft, finalTaskStatus: value || null })}
                ariaLabel={props.zh ? '最后变更任务状态' : 'Final task status'}
              />
            </label>
          ) : null}
        </FormDialog>
      ) : null}
      {conflict ? (
        <FormDialog
          title={props.zh ? '处理交付冲突' : 'Resolve delivery conflicts'}
          className="git-delivery-conflict-dialog"
          zh={props.zh}
          busy={busy}
          submitLabel={props.zh ? '保存解决结果' : 'Save resolution'}
          submitDisabled={!document || countUnresolvedConflictBlocks(document) > 0}
          onClose={() => {
            setConflict(null);
            setDocument(null);
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void saveConflict();
          }}
        >
          {error ? <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} /> : null}
          {conflict.files.length ? (
            <TaskGitConflictWorkspace
              zh={props.zh}
              busy={busy}
              aiBusy={busy}
              integration={{ conflictFiles: conflict.files, targetBranch: conflict.targetBranch }}
              taskBranch={conflict.sourceBranch}
              conflictPath={conflict.file?.path ?? ''}
              conflict={document}
              onSelectPath={(path) => void openConflict(conflict.run, conflict.step, path)}
              onDocumentChange={setDocument}
              skillClient={props.client}
              projectId={props.projectId}
              onAskAi={async (content, fingerprint, permissionMode, skillId) => {
                if (permissionMode !== 'auto' && permissionMode !== 'full-access') throw new Error('请选择自动审批或完全访问。');
                await props.client.startGitDeliveryConflictAi(props.projectId, conflict.run.id, conflict.step.id, { path: conflict.file!.path, content, fingerprint, permissionMode, skillId });
                setConflict(null);
                await refresh();
              }}
            />
          ) : (
            <>
              <p>{props.zh ? '冲突已解决，可以继续合入。' : 'Conflicts resolved. Continue the merge.'}</p>
              <Button
                onClick={() => {
                  const run = conflict.run;
                  setConflict(null);
                  void resume(run);
                }}
              >
                {props.zh ? '继续交付' : 'Continue delivery'}
              </Button>
            </>
          )}
        </FormDialog>
      ) : null}
    </section>
  );
}
