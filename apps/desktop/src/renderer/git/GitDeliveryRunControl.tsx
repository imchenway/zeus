import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GitDeliveryCombinationContext } from './gitDeliverySettings.js';
import { formatTaskManagementStatusLabel, type CommandDefinition, type GitDeliveryInput, type GitDeliveryRun, type GitDeliverySettings, type GitDeliveryStep, type TaskManagementStatusDefinition } from '@zeus/shared';
import type { DashboardClient } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { FormDialog } from '../ui/FormDialog.js';
import { loadGitCommitModelOptions } from './gitCommitModels.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { SkillSelector } from '../features/skills/SkillSelector.js';
import { ConflictAiPermissions, TaskGitConflictWorkspace } from '../task/TaskGitConflictWorkspace.js';
import { TaskManagementStatusSelect } from '../task/TaskManagementStatusSelect.js';
import { createConflictDocument, serializeConflictForGit, countUnresolvedConflictBlocks, type ConflictDocument } from '../task/taskConflictModel.js';
import type { TaskIntegrationConflictFile } from '../session/sessionTypes.js';
import { GitDeliveryProgress, gitDeliveryActionLabel as actionLabel } from './GitDeliveryProgress.js';
import { GitDeliveryRunActions, GitDeliveryCleanupConfirmation } from './GitDeliveryRunActions.js';
import { useGitDeliveryRuns } from './useGitDeliveryRuns.js';
import { GitDeliveryCommandSelect } from './GitDeliveryCommandSelect.js';

/** 两个入口使用同一后台交付客户端。 */
export type GitDeliveryClient = Pick<
  DashboardClient,
  | 'loadGitDeliveryRuns'
  | 'loadGitDeliveryOptions'
  | 'startGitDeliveryRun'
  | 'loadGitCommitModels'
  | 'resumeGitDeliveryRun'
  | 'stopGitDeliveryRun'
  | 'acknowledgeGitDelivery'
  | 'loadGitDeliveryConflict'
  | 'saveGitDeliveryConflict'
  | 'startGitDeliveryConflictAi'
  | 'loadSkills'
  | 'subscribeEvents'
>;

export { readGitDeliverySettings } from './gitDeliverySettings.js';

/** 运行控件不持有执行循环，只接纳固定输入并显示后台事实。 */
export function GitDeliveryRunControl(props: {
  /** 原有已认证客户端。 */
  client: GitDeliveryClient;
  /** 当前真实项目。 */
  projectId: string;
  /** 会话仓库交付仍使用会话范围，收尾选项按其真实任务归属展示。 */
  taskId?: string | null;
  /** 当前输入；点击时再次固定副本。 */
  input: Omit<GitDeliveryInput, 'settings'>;
  /** 保存设置后，单步与组合交付同时使用选中的合入方式。 */
  onModeChange: (mode: GitDeliveryInput['mode']) => void;
  /** 原页正在处理单步操作。 */
  disabled: boolean;
  /** 当前语言。 */
  zh: boolean;
  /** 服务端持久接纳后销毁已隐藏的原窗口。 */
  onAccepted(): void;
}) {
  /** 功能区与底部按钮读取同一份组合，避免勾选和执行不一致。 */
  const combination = useContext(GitDeliveryCombinationContext);
  if (!combination) throw new Error('代码交付运行按钮必须位于交付操作栏。');
  const { settings, setSettings, executionSettings, followUps, setFollowUps, canMerge, settingsOpen, setSettingsOpen, setRunning, footerHost } = combination;
  /** 任务工作区与关联任务的普通会话共享任务收尾。 */
  const taskId = props.input.scope.kind === 'task' ? props.input.scope.taskId : props.taskId;
  /** 设置草稿只包含该弹窗可编辑的合入与冲突选项。 */
  const [draft, setDraft] = useState<(Pick<GitDeliverySettings, 'permissionMode' | 'skillId'> & Pick<GitDeliveryInput, 'mode'>) | null>(null);
  /** 项目当前真实状态定义。 */
  const [statuses, setStatuses] = useState<TaskManagementStatusDefinition[]>([]);
  /** 命令目录沿用项目与全局合并结果，不在交付页复制脚本配置。 */
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  /** 未读取成功前禁止携带上次选择运行，避免旧命令被静默省略。 */
  const [commandsLoaded, setCommandsLoaded] = useState(false);
  /** 加载、接纳或继续时阻止重复操作。 */
  const [busy, setBusy] = useState(false);
  /** 保留失败原因与手动重读入口。 */
  const [error, setError] = useState<unknown>(null);
  /** 从底栏执行失败时，滚动到表单中的错误原因。 */
  const actionErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) actionErrorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  /** 终态清理只能在用户看到真实影响后明确确认。 */
  const [cleanupRun, setCleanupRun] = useState<GitDeliveryRun | null>(null);
  /** 真实接纳身份在未知响应重试时保持不变。 */
  const request = useRef<{ json: string; sourceJson: string; key: string } | null>(null);
  /** React 更新前的同步锁。 */
  const pending = useRef(false);
  /** 后台查询只属于当前入口。 */
  const scopeId = props.input.scope.kind === 'task' ? props.input.scope.taskId : props.input.scope.conversationId;
  /** 与环境卡片共用后台进度，关闭交付窗口不影响执行。 */
  const { runs, error: runsError, refresh, acceptRun } = useGitDeliveryRuns(props.client, props.projectId, scopeId);
  /** 冲突页复用原三栏编辑器。 */
  const [conflict, setConflict] = useState<{ run: GitDeliveryRun; step: GitDeliveryStep; files: string[]; sourceBranch: string; targetBranch: string; file: TaskIntegrationConflictFile | null } | null>(null);
  /** 用户编辑内容只在保存或 AI 接管时发送。 */
  const [document, setDocument] = useState<ConflictDocument | null>(null);
  /** 当前是否有已接纳运行。 */
  const running = runs.some((run) => run.state === 'queued' || run.state === 'running');

  /** 只显示最后一次交付，较早的失败不能重新成为可继续流程。 */
  const visibleRuns = runs.slice(0, 1).filter((run) => run.state !== 'succeeded');

  /** 两个交付入口读取同一命令目录，聚焦或定义变化时重新核对可用项。 */
  useEffect(() => {
    let disposed = false;
    setCommandsLoaded(false);
    setCommands([]);
    /** 加载失败保留明确错误，不能把失败当成项目没有命令。 */
    const reload = () => {
      void props.client
        .loadGitDeliveryOptions(props.projectId)
        .then((result) => {
          if (!disposed) {
            setCommands(result.commands);
            setStatuses(result.statuses);
            setCommandsLoaded(true);
          }
        })
        .catch((reason) => {
          if (!disposed) {
            setCommandsLoaded(false);
            setError(reason);
          }
        });
    };
    reload();
    const unsubscribe = props.client.subscribeEvents(
      (event) => {
        if (event.type.startsWith('command.definition.')) reload();
      },
      (state) => {
        if (state === 'connected') reload();
      },
    );
    window.addEventListener('focus', reload);
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener('focus', reload);
    };
  }, [props.client, props.projectId]);

  /** 每次打开交付设置时恢复当前合入方式和冲突选项。 */
  useEffect(() => {
    if (!settingsOpen) {
      setDraft(null);
      return;
    }
    let active = true;
    setError(null);
    setDraft({ mode: props.input.mode, permissionMode: settings.permissionMode, skillId: settings.skillId });
    void props.client
      .loadGitDeliveryOptions(props.projectId)
      .then((result) => {
        if (active) setStatuses(result.statuses);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason);
      });
    return () => {
      active = false;
    };
  }, [settingsOpen, props.client, props.projectId, props.input.mode, settings.permissionMode, settings.skillId]);

  /** 接纳与后台运行期间，功能旁的复选框不能改变正在执行的组合。 */
  useEffect(() => {
    setRunning(busy || running);
    return () => setRunning(false);
  }, [busy, running, setRunning]);

  /** 立即隐藏窗口，将固定快照交给后台；接纳失败时恢复原窗口。 */
  async function start(): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    /** 接纳或偏好保存失败时仍需恢复窗口展示原因。 */
    let dismissed = false;
    try {
      /** 读取模型前固定文件和设置，接纳重试继续使用同一快照。 */
      const sourceJson = JSON.stringify({
        ...props.input,
        postPushCommands: executionSettings.push ? (executionSettings.postPushCommandIds ?? []).map((commandId) => ({ commandId, expectedRevision: commands.find((command) => command.id === commandId)?.revision ?? 0 })) : [],
        settings: executionSettings,
      });
      await window.zeus?.setTaskGitDeliverySubmissionState?.('pending');
      if (request.current?.sourceJson !== sourceJson) {
        /** 模型参数随运行冻结，之后修改项目偏好不影响已接纳步骤。 */
        const input = JSON.parse(sourceJson) as GitDeliveryInput;
        if (input.settings.push && input.settings.postPushCommandIds?.length) {
          if (!commandsLoaded) throw new Error(props.zh ? '命令列表尚未读取成功。' : 'The command list has not loaded.');
          input.postPushCommands = input.settings.postPushCommandIds.map((commandId) => {
            /** 冻结用户当前看到的定义版本，后台执行前再次核对。 */
            const command = commands.find((entry) => entry.id === commandId);
            if (!command) throw new Error(props.zh ? '所选命令已停用或删除，请重新选择。' : 'A selected command is disabled or deleted. Select it again.');
            return { commandId, expectedRevision: command.revision };
          });
        }
        if (input.settings.commit && input.settings.generateCommitMessage && input.repositories.some((repository) => repository.paths.length > 0)) {
          /** 与原 AI 生成按钮共用模型、推理深度和速率偏好。 */
          const models = await loadGitCommitModelOptions(props.client, props.projectId);
          if (!models.modelRef) throw new Error(models.warning || (props.zh ? '暂无可用模型，请在 AI 生成设置中选择模型。' : 'No model is available. Choose a model in AI generation settings.'));
          input.commitMessageGeneration = { ...models.settings, language: props.zh ? 'zh-CN' : 'en' };
        }
        request.current = { json: JSON.stringify(input), sourceJson, key: crypto.randomUUID() };
      }
      /** 接纳结果立即进入本地运行列表，偏好写入失败也不会允许重复启动。 */
      const acceptedRun = await props.client.startGitDeliveryRun(props.projectId, JSON.parse(request.current.json) as GitDeliveryInput, request.current.key);
      acceptRun(acceptedRun);
      /** 只记录后台实际接纳的固定组合，失败请求和临时勾选不覆盖上次运行。 */
      const acceptedSettings = (JSON.parse(request.current.json) as GitDeliveryInput).settings;
      request.current = null;
      try {
        localStorage.setItem(`zeus.git-delivery.settings:${props.projectId}`, JSON.stringify(acceptedSettings));
      } catch {
        setError(props.zh ? '组合已开始运行，但项目偏好保存失败。' : 'The combination started, but its project preference could not be saved.');
        return;
      }
      await window.zeus?.setTaskGitDeliverySubmissionState?.('accepted');
      props.onAccepted();
      dismissed = true;
    } catch (reason) {
      setError(reason);
    } finally {
      pending.current = false;
      setBusy(false);
      if (!dismissed) await window.zeus?.setTaskGitDeliverySubmissionState?.('failed').catch((reason: unknown) => setError(reason));
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
      setError(reason);
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
      setError(reason);
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
      setError(reason);
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
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  /** 单步操作及后台运行期间锁定收尾配置。 */
  const controlsDisabled = props.disabled || busy || running;
  /** 只有启用推送才可开启命令；目录读取失败时仍能取消勾选。 */
  const commandToggleDisabled = controlsDisabled || !settings.push;
  /** 只计入本次会执行的已选命令。 */
  const commandCount = executionSettings.push ? (executionSettings.postPushCommandIds?.length ?? 0) : 0;
  /** 任务状态提示使用本次实际提交的状态。 */
  const finalTaskStatus = executionSettings.finalTaskStatus;
  /** 内置状态跟随界面语言，自定义状态使用配置中的名称。 */
  const language = props.zh ? 'zh-CN' : 'en-US';
  /** 下拉菜单按配置顺序显示状态名称和颜色。 */
  const statusOptions = statuses.map((status) => ({ value: status.id, label: formatTaskManagementStatusLabel(status, language), color: status.color }));
  /** 提示与下拉共用名称，目录尚未加载时使用内置文案或状态标识。 */
  const finalStatusLabel = statusOptions.find((status) => status.value === finalTaskStatus)?.label ?? (finalTaskStatus ? formatTaskManagementStatusLabel({ id: finalTaskStatus, label: null }, language) : null);
  /** 按钮名称直接表达实际执行顺序，不再重复渲染功能说明。 */
  const summary = (['commit', 'merge', 'push'] as const)
    .filter((action) => executionSettings[action])
    .map((action) => actionLabel(action, props.zh, props.input.mode))
    .concat(commandCount ? [props.zh ? `命令（${commandCount}）` : `Commands (${commandCount})`] : [])
    .join(' → ');
  return (
    <>
      <div className="git-delivery-follow-up-fields">
        <div className="task-git-delivery-field-row">
          <label className="git-delivery-checkbox" aria-disabled={commandToggleDisabled || undefined}>
            <input type="checkbox" checked={followUps.commands} disabled={commandToggleDisabled} onChange={(event) => setFollowUps((current) => ({ ...current, commands: event.target.checked }))} />
            {props.zh ? '推送后执行命令' : 'Run after push'}
          </label>
          <GitDeliveryCommandSelect
            commands={commands}
            selectedIds={settings.postPushCommandIds ?? []}
            disabled={commandToggleDisabled || !followUps.commands || !commandsLoaded}
            zh={props.zh}
            onChange={(ids) => setSettings((current) => ({ ...current, postPushCommandIds: ids }))}
          />
        </div>
        {taskId ? (
          <div className="task-git-delivery-field-row">
            <label className="git-delivery-checkbox" aria-disabled={controlsDisabled || undefined}>
              <input type="checkbox" checked={followUps.taskStatus} disabled={controlsDisabled} onChange={(event) => setFollowUps((current) => ({ ...current, taskStatus: event.target.checked }))} />
              {props.zh ? '修改任务状态' : 'Set task status'}
            </label>
            <TaskManagementStatusSelect
              size="compact"
              disabled={controlsDisabled || !followUps.taskStatus}
              value={settings.finalTaskStatus ?? ''}
              triggerLabel={settings.finalTaskStatus ? undefined : props.zh ? '选择状态' : 'Select status'}
              options={statusOptions}
              onChange={(value) => setSettings((current) => ({ ...current, finalTaskStatus: value }))}
              ariaLabel={props.zh ? '交付成功后修改任务状态' : 'Task status after delivery succeeds'}
            />
          </div>
        ) : (
          <label className="git-delivery-checkbox">
            <input type="checkbox" disabled={controlsDisabled} checked={settings.archiveConversation === true} onChange={(event) => setSettings((current) => ({ ...current, archiveConversation: event.target.checked }))} />
            {props.zh ? '交付成功后自动归档会话' : 'Archive conversation after delivery succeeds'}
          </label>
        )}
      </div>
      <section className="git-delivery-combination" aria-label={props.zh ? '执行交付' : 'Run delivery'}>
        {error || runsError ? (
          <div ref={actionErrorRef} role="alert">
            <VisibleApplicationError error={error || runsError} language={props.zh ? 'zh-CN' : 'en'} />
            <Button
              size="compact"
              onClick={() => {
                setError(null);
                return refresh().catch((reason) => setError(reason));
              }}
            >
              {props.zh ? '重新读取' : 'Reload'}
            </Button>
          </div>
        ) : null}
        {visibleRuns.map((run) => {
          /** 进度摘要已显示当前动作，只为异常、冲突和附加原因保留详情行。 */
          const detailedSteps = run.steps.filter(
            (step) =>
              step.state !== 'succeeded' && step.state !== 'pending' && (step.state === 'attention' || step.state === 'unknown' || step.message || step.error || step.conversationId || (step.action === 'merge' && step.state === 'waiting')),
          );
          return (
            <section key={run.id} className="git-delivery-run" aria-label={props.zh ? '交付进度' : 'Delivery progress'}>
              <GitDeliveryProgress run={run} zh={props.zh} />
              {detailedSteps.length > 0 ? (
                <ul>
                  {detailedSteps.map((step) => (
                    <li key={step.id}>
                      <div className="git-delivery-run-step-heading">
                        <strong>{step.action === 'task_status' || step.action === 'conversation_archive' ? actionLabel(step.action, props.zh) : `${step.repositoryName} · ${actionLabel(step.action, props.zh)}`}</strong>
                        <span data-state={step.state}>
                          {
                            {
                              pending: props.zh ? '等待前序步骤' : 'Pending',
                              running: props.zh ? '执行中' : 'Running',
                              waiting: step.action === 'command' ? (props.zh ? '命令运行中' : 'Command running') : props.zh ? 'AI 处理中' : 'AI running',
                              attention: props.zh ? '需要处理' : 'Needs attention',
                              unknown: props.zh ? '结果待核对' : 'Outcome unknown',
                              succeeded: props.zh ? '已完成' : 'Completed',
                            }[step.state]
                          }
                        </span>
                      </div>
                      {step.message || step.error ? (
                        <small>
                          <VisibleApplicationError error={step.error ?? step.message} summary={step.message ?? undefined} title={`${step.repositoryName} · ${actionLabel(step.action, props.zh)}`} language={props.zh ? 'zh-CN' : 'en'} />
                        </small>
                      ) : null}
                      {step.conversationId ? (
                        <Button size="compact" onClick={() => openConversation(run, step.conversationId!)}>
                          {props.zh ? '打开冲突会话' : 'Open conflict conversation'}
                        </Button>
                      ) : null}
                      {step.action === 'merge' && ['attention', 'waiting'].includes(step.state) ? (
                        <Button size="compact" disabled={busy} onClick={() => openConflict(run, step)}>
                          {props.zh ? '处理冲突' : 'Resolve conflicts'}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <GitDeliveryRunActions client={props.client} run={run} zh={props.zh} disabled={busy} onResume={resume} onUpdated={() => refresh()} />
            </section>
          );
        })}
        {footerHost
          ? createPortal(
              <Button
                variant="primary"
                size="compact"
                busy={busy}
                disabled={controlsDisabled || !props.input.repositories.length || !summary || (commandCount > 0 && !commandsLoaded)}
                data-icon-tooltip={
                  finalTaskStatus && taskId
                    ? props.zh
                      ? `完成后状态：${finalStatusLabel}`
                      : `Final status: ${finalStatusLabel}`
                    : executionSettings.archiveConversation
                      ? props.zh
                        ? '交付成功后归档会话'
                        : 'Archive conversation after delivery succeeds'
                      : undefined
                }
                onClick={() => start()}
              >
                {summary || (props.zh ? '执行交付' : 'Run delivery')}
              </Button>,
              footerHost,
            )
          : null}
        {cleanupRun ? <GitDeliveryCleanupConfirmation run={cleanupRun} zh={props.zh} busy={busy} error={error} onClose={() => setCleanupRun(null)} onConfirm={() => resume(cleanupRun, true)} /> : null}
        {draft ? (
          <FormDialog
            title={props.zh ? '交付设置' : 'Delivery settings'}
            zh={props.zh}
            busy={busy}
            submitLabel={props.zh ? '保存' : 'Save'}
            onClose={() => {
              setDraft(null);
              setSettingsOpen(false);
            }}
            onSubmit={(event) => {
              event.preventDefault();
              props.onModeChange(draft.mode);
              setSettings((current) => ({ ...current, permissionMode: draft.permissionMode, skillId: draft.skillId }));
              setDraft(null);
              setSettingsOpen(false);
            }}
          >
            {error ? <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} /> : null}
            <fieldset className="project-git-update-strategies" disabled={!canMerge}>
              <legend>{props.zh ? '合入方式' : 'Merge method'}</legend>
              <label className="git-delivery-checkbox">
                <input type="radio" name="git-delivery-merge-mode" value="merge" checked={draft.mode === 'merge'} onChange={() => setDraft({ ...draft, mode: 'merge' })} />
                {props.zh ? '保留提交' : 'Preserve commits'}
              </label>
              <label className="git-delivery-checkbox">
                <input type="radio" name="git-delivery-merge-mode" value="squash" checked={draft.mode === 'squash'} onChange={() => setDraft({ ...draft, mode: 'squash' })} />
                {props.zh ? '合成一个提交' : 'Squash into one commit'}
              </label>
            </fieldset>
            {settings.resolveConflicts ? (
              <>
                <ConflictAiPermissions zh={props.zh} value={draft.permissionMode} disabled={busy} onChange={(value) => setDraft({ ...draft, permissionMode: value })} />
                <SkillSelector client={props.client} projectId={props.projectId} value={draft.skillId ?? ''} onChange={(value) => setDraft({ ...draft, skillId: value || null })} language={props.zh ? 'zh-CN' : 'en-US'} />
              </>
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
              return saveConflict();
            }}
          >
            {error ? <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} /> : null}
            {conflict.files.length ? (
              <TaskGitConflictWorkspace
                allRepositories
                zh={props.zh}
                busy={busy}
                aiBusy={busy}
                integration={{ conflictFiles: conflict.files, targetBranch: conflict.targetBranch }}
                taskBranch={conflict.sourceBranch}
                conflictPath={conflict.file?.path ?? ''}
                conflict={document}
                onSelectPath={(path) => openConflict(conflict.run, conflict.step, path)}
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
                    return resume(run);
                  }}
                >
                  {props.zh ? '继续交付' : 'Continue delivery'}
                </Button>
              </>
            )}
          </FormDialog>
        ) : null}
      </section>
    </>
  );
}
