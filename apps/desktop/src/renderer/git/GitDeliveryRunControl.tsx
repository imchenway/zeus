import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GitDeliveryCombinationContext, writeGitDeliveryFollowUps, writeGitDeliverySettings, type GitDeliveryFollowUpPreferences } from './gitDeliverySettings.js';
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
import { GitDeliveryProgress, GitDeliveryStepError, gitDeliveryActionLabel as actionLabel } from './GitDeliveryProgress.js';
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

/** 下拉打开时，选项可能移到浮层 DOM 之外的选择器 portal。 */
const OPEN_SELECT_TRIGGER = '.zeus-select-trigger[aria-expanded="true"]';

/** 组合配置随按钮悬停和键盘焦点打开，按钮负责启动当前组合。 */
function GitDeliveryCombinationPopover(props: {
  zh: boolean;
  summary: string;
  /** 无可执行步骤时仍可聚焦按钮并恢复勾选。 */
  runDisabled: boolean;
  onStart(): Promise<void>;
  children: ReactNode;
}) {
  /** 触发器向辅助技术标识它控制的表单。 */
  const optionsId = useId();
  /** 浮层以当前底栏按钮为锚点，跟随操作区宽度和高度变化。 */
  const optionsAnchor = `--delivery-combination-${optionsId.replace(/:/g, '')}`;
  /** 鼠标或键盘都能打开同一份交付配置。 */
  const [open, setOpen] = useState(false);
  /** 从配置用 Escape 退出时将焦点还给组合按钮。 */
  const trigger = useRef<HTMLButtonElement>(null);
  /** 用于区分面板内交互与外部关闭操作。 */
  const panel = useRef<HTMLElement>(null);
  /** 只延迟关闭，让鼠标跨过按钮与面板之间的间距。 */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  /** 进入组合按钮或浮层后，取消正在等待的关闭。 */
  function cancelClose(): void {
    clearTimeout(closeTimer.current);
  }

  /** 鼠标和键盘离开配置后收起，选择器打开时保留父面板。 */
  function scheduleClose(): void {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (trigger.current?.matches(':hover, :focus-visible') || panel.current?.matches(':hover, :focus-within') || panel.current?.querySelector(OPEN_SELECT_TRIGGER)) return;
      setOpen(false);
    }, 120);
  }

  useEffect(() => {
    /** 只在当前配置可见时接管 Escape 与外部点击。 */
    if (!open || !panel.current) return;
    const options = panel.current;

    /** 选择器优先关闭，随后 Escape 才关闭组合配置。 */
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || options.closest('[inert]') || options.querySelector(OPEN_SELECT_TRIGGER)) return;
      event.preventDefault();
      event.stopPropagation();
      if (options.matches(':focus-within')) trigger.current?.focus({ preventScroll: true });
      setOpen(false);
    }

    /** 原下拉菜单挂载在应用壳层，点选其选项仍属于配置交互。 */
    function closeOnOutsidePointerDown(event: PointerEvent): void {
      /** 外部点击由实际命中的 DOM 节点判断。 */
      const target = event.target;
      if (!(target instanceof Element) || trigger.current?.contains(target) || options.contains(target)) return;
      if (target.closest('.zeus-select-portal-root') && options.querySelector(OPEN_SELECT_TRIGGER)) return;
      setOpen(false);
    }

    options.ownerDocument.addEventListener('keydown', closeOnEscape, true);
    options.ownerDocument.addEventListener('pointerdown', closeOnOutsidePointerDown, true);
    return () => {
      options.ownerDocument.removeEventListener('keydown', closeOnEscape, true);
      options.ownerDocument.removeEventListener('pointerdown', closeOnOutsidePointerDown, true);
    };
  }, [open]);

  return (
    <>
      <Button
        ref={trigger}
        className="git-delivery-combination-button"
        style={{ anchorName: optionsAnchor }}
        variant="primary"
        size="compact"
        busyLabel={props.zh ? '启动中…' : 'Starting…'}
        aria-controls={optionsId}
        aria-expanded={open}
        aria-disabled={props.runDisabled || undefined}
        onPointerEnter={(event) => {
          cancelClose();
          if (event.pointerType !== 'touch' && event.buttons === 0) setOpen(true);
        }}
        onPointerLeave={scheduleClose}
        onFocus={(event) => {
          cancelClose();
          if (event.currentTarget.matches(':focus-visible')) setOpen(true);
        }}
        onBlur={scheduleClose}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          cancelClose();
          setOpen(true);
        }}
        onClick={(event) => {
          if (!open && event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === 'touch') {
            setOpen(true);
            return;
          }
          if (props.runDisabled) return;
          setOpen(false);
          return props.onStart();
        }}
      >
        {props.summary || (props.zh ? '执行交付' : 'Run delivery')}
      </Button>
      <section
        ref={panel}
        id={optionsId}
        className="task-git-delivery-action-step git-delivery-workflow"
        style={{ positionAnchor: optionsAnchor }}
        aria-label={props.zh ? '组合交付' : 'Combined delivery'}
        hidden={!open}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onFocus={cancelClose}
        onBlur={scheduleClose}
      >
        <strong>{props.zh ? '组合交付' : 'Combined delivery'}</strong>
        {open ? props.children : null}
      </section>
    </>
  );
}

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
  /** 原页正在处理单步操作。 */
  disabled: boolean;
  /** 当前语言。 */
  zh: boolean;
  /** 服务端持久接纳后销毁已隐藏的原窗口。 */
  onAccepted(): void;
}) {
  /** 配置浮层与执行按钮读取同一份组合。 */
  const combination = useContext(GitDeliveryCombinationContext);
  if (!combination) throw new Error('代码交付运行按钮必须位于交付操作栏。');
  const { settings, setSettings, executionSettings, followUps, setFollowUps, canMerge, stepsLocked, settingsOpen, setSettingsOpen, setRunning, combinationHost } = combination;
  /** 任务工作区与关联任务的普通会话共享任务收尾。 */
  const taskId = props.input.scope.kind === 'task' ? props.input.scope.taskId : props.taskId;
  /** 设置草稿承载需要保存的 AI 冲突权限与 Skill。 */
  const [draft, setDraft] = useState<Pick<GitDeliverySettings, 'permissionMode' | 'skillId'> | null>(null);
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
  /** 启动交付失败时，滚动到表单中的错误原因。 */
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

  /** 打开交付设置时读取当前 AI 冲突选项。 */
  useEffect(() => {
    if (!settingsOpen || !settings.resolveConflicts) {
      setDraft(null);
      return;
    }
    let active = true;
    setError(null);
    setDraft({ permissionMode: settings.permissionMode, skillId: settings.skillId });
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
  }, [settingsOpen, props.client, props.projectId, settings.resolveConflicts, settings.permissionMode, settings.skillId]);

  /** 接纳与后台运行期间，功能旁的复选框不能改变正在执行的组合。 */
  useEffect(() => {
    setRunning(busy || running);
    return () => setRunning(false);
  }, [busy, running, setRunning]);

  /** 选择或勾选改变时立即记住，当前窗口始终采用用户刚修改的值。 */
  function changeFollowUps(changes: Partial<GitDeliveryFollowUpPreferences>): void {
    setFollowUps((current) => ({ ...current, ...changes }));
    try {
      writeGitDeliveryFollowUps(props.projectId, changes);
    } catch {
      setError(props.zh ? '收尾选项已更新，但项目偏好保存失败。' : 'Follow-up options changed, but the project preference could not be saved.');
    }
  }

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
      /** 单独记录后台实际接纳的组合参数。 */
      const acceptedSettings = (JSON.parse(request.current.json) as GitDeliveryInput).settings;
      request.current = null;
      try {
        writeGitDeliverySettings(props.projectId, acceptedSettings);
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
  /** 内置状态跟随界面语言，自定义状态使用配置中的名称。 */
  const language = props.zh ? 'zh-CN' : 'en-US';
  /** 下拉菜单按配置顺序显示状态名称和颜色。 */
  const statusOptions = statuses.map((status) => ({ value: status.id, label: formatTaskManagementStatusLabel(status, language), color: status.color }));
  /** 按钮名称直接表达实际执行顺序，不再重复渲染功能说明。 */
  const summary = (['commit', 'merge', 'push'] as const)
    .filter((action) => executionSettings[action])
    .map((action) => actionLabel(action, props.zh, props.input.mode))
    .concat(commandCount ? [props.zh ? `命令（${commandCount}）` : `Commands (${commandCount})`] : [])
    .join(' → ');
  /** 提交、合入与推送复用同一勾选规则，合入额外要求有效目标分支。 */
  function combinationOption(action: 'commit' | 'merge' | 'push', label: string): ReactNode {
    return (
      <label className="git-delivery-checkbox" aria-disabled={action === 'merge' && !canMerge ? true : undefined}>
        <input
          type="checkbox"
          checked={settings[action]}
          disabled={stepsLocked || (action === 'merge' && !canMerge)}
          aria-label={props.zh ? `组合包含${label}` : `Include ${label} in combination`}
          onChange={(event) => setSettings((current) => ({ ...current, [action]: event.target.checked }))}
        />
        <span>{label}</span>
      </label>
    );
  }

  return (
    <>
      {combinationHost
        ? createPortal(
            <GitDeliveryCombinationPopover zh={props.zh} summary={summary} runDisabled={controlsDisabled || !props.input.repositories.length || !summary || (commandCount > 0 && !commandsLoaded)} onStart={start}>
              <div className="git-delivery-workflow-steps">
                {combinationOption('commit', actionLabel('commit', props.zh))}
                {combinationOption('merge', actionLabel('merge', props.zh, props.input.mode))}
                {combinationOption('push', actionLabel('push', props.zh))}
              </div>
              <div className="git-delivery-workflow-options">
                <label className="git-delivery-checkbox" aria-disabled={stepsLocked || !settings.commit || undefined}>
                  <input
                    type="checkbox"
                    checked={settings.generateCommitMessage}
                    disabled={stepsLocked || !settings.commit}
                    aria-label={props.zh ? '组合中 AI 生成提交说明' : 'Generate commit messages with AI in combination'}
                    onChange={(event) => setSettings((current) => ({ ...current, generateCommitMessage: event.target.checked }))}
                  />
                  <span>{props.zh ? 'AI 生成提交说明' : 'AI commit message'}</span>
                </label>
                {canMerge ? (
                  <label className="git-delivery-checkbox" aria-disabled={stepsLocked || !settings.merge || undefined}>
                    <input type="checkbox" checked={settings.resolveConflicts} disabled={stepsLocked || !settings.merge} onChange={(event) => setSettings((current) => ({ ...current, resolveConflicts: event.target.checked }))} />
                    <span>{props.zh ? 'AI 处理冲突' : 'AI conflict resolution'}</span>
                  </label>
                ) : null}
              </div>
              <div className="git-delivery-follow-up-fields">
                <div className="task-git-delivery-field-row">
                  <label className="git-delivery-checkbox" aria-disabled={commandToggleDisabled || undefined}>
                    <input type="checkbox" checked={followUps.commands} disabled={commandToggleDisabled} onChange={(event) => changeFollowUps({ commands: event.target.checked })} />
                    {props.zh ? '推送后执行命令' : 'Run after push'}
                  </label>
                  <GitDeliveryCommandSelect
                    commands={commands}
                    selectedIds={followUps.postPushCommandIds}
                    disabled={commandToggleDisabled || !followUps.commands || !commandsLoaded}
                    zh={props.zh}
                    onChange={(ids) => changeFollowUps({ postPushCommandIds: ids })}
                  />
                </div>
                {taskId ? (
                  <div className="task-git-delivery-field-row">
                    <label className="git-delivery-checkbox" aria-disabled={controlsDisabled || undefined}>
                      <input type="checkbox" checked={followUps.taskStatus} disabled={controlsDisabled} onChange={(event) => changeFollowUps({ taskStatus: event.target.checked })} />
                      {props.zh ? '修改任务状态' : 'Set task status'}
                    </label>
                    <TaskManagementStatusSelect
                      size="compact"
                      disabled={controlsDisabled || !followUps.taskStatus}
                      value={followUps.finalTaskStatus ?? ''}
                      triggerLabel={followUps.finalTaskStatus ? undefined : props.zh ? '选择状态' : 'Select status'}
                      options={statusOptions}
                      onChange={(value) => changeFollowUps({ finalTaskStatus: value })}
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
            </GitDeliveryCombinationPopover>,
            combinationHost,
          )
        : null}
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
        {runs.map((run) => {
          /** 进度摘要已显示当前动作，只为异常、冲突和附加原因保留详情行。 */
          const detailedSteps = run.steps.filter(
            (step) =>
              step.state !== 'succeeded' &&
              step.state !== 'pending' &&
              ((step.state === 'attention' && !step.stopped) || step.state === 'unknown' || step.message || step.error || step.conversationId || (step.action === 'merge' && step.state === 'waiting')),
          );
          return (
            <section key={run.id} className="git-delivery-run" aria-label={props.zh ? '交付进度' : 'Delivery progress'}>
              <GitDeliveryProgress run={run} zh={props.zh} />
              {detailedSteps.length > 0 ? (
                <ul>
                  {detailedSteps.map((step) => (
                    <li key={step.id}>
                      <div className="git-delivery-run-step-heading">
                        <strong>{step.action === 'task_status' || step.action === 'conversation_archive' ? actionLabel(step.action, props.zh) : `${step.repositoryName} · ${actionLabel(step.action, props.zh, run.input.mode)}`}</strong>
                        <span data-state={step.state}>
                          {
                            {
                              pending: props.zh ? '等待前序步骤' : 'Pending',
                              running: props.zh ? '执行中' : 'Running',
                              waiting: step.action === 'command' ? (props.zh ? '命令运行中' : 'Command running') : props.zh ? 'AI 处理中' : 'AI running',
                              attention: step.stopped ? (props.zh ? '已终止' : 'Stopped') : props.zh ? '需要处理' : 'Needs attention',
                              unknown: props.zh ? '结果待核对' : 'Outcome unknown',
                              succeeded: props.zh ? '已完成' : 'Completed',
                            }[step.state]
                          }
                        </span>
                      </div>
                      {step.state === 'unknown' || step.message || step.error ? (
                        <small>
                          <GitDeliveryStepError step={step} zh={props.zh} mode={run.input.mode} />
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
        {cleanupRun ? <GitDeliveryCleanupConfirmation run={cleanupRun} zh={props.zh} busy={busy} error={error} onClose={() => setCleanupRun(null)} onConfirm={() => resume(cleanupRun, true)} /> : null}
        {settingsOpen && settings.resolveConflicts && draft ? (
          <FormDialog
            title={props.zh ? '交付设置' : 'Delivery settings'}
            zh={props.zh}
            busy={busy}
            submitLabel={props.zh ? '保存' : 'Save'}
            submitBusyLabel={props.zh ? '保存中…' : 'Saving…'}
            onClose={() => {
              setDraft(null);
              setSettingsOpen(false);
            }}
            onSubmit={(event) => {
              event.preventDefault();
              setSettings((current) => ({ ...current, permissionMode: draft.permissionMode, skillId: draft.skillId }));
              setDraft(null);
              setSettingsOpen(false);
            }}
          >
            {error ? <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} /> : null}
            <ConflictAiPermissions zh={props.zh} value={draft.permissionMode} disabled={busy} onChange={(value) => setDraft({ ...draft, permissionMode: value })} />
            <SkillSelector client={props.client} projectId={props.projectId} value={draft.skillId ?? ''} onChange={(value) => setDraft({ ...draft, skillId: value || null })} language={props.zh ? 'zh-CN' : 'en-US'} />
          </FormDialog>
        ) : null}
        {conflict ? (
          <FormDialog
            title={props.zh ? '处理交付冲突' : 'Resolve delivery conflicts'}
            className="git-delivery-conflict-dialog"
            zh={props.zh}
            busy={busy}
            submitLabel={props.zh ? '保存解决结果' : 'Save resolution'}
            submitBusyLabel={props.zh ? '保存中…' : 'Saving…'}
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
