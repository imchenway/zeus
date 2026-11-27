import { isMacOSPlatform } from '../platform.js';
import { notifyProjectGitChanged } from './projectGitWorkbenchState.js';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { GitDiffIcon as GitDiff } from '@phosphor-icons/react/dist/csr/GitDiff';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import type { FilePreviewRequest, GitDeliveryFileActionInput } from '@zeus/shared';
import { GitContextMenu, GitMenuActionDialog, type GitMenuConfirmation, type GitMenuItem } from './GitContextMenu.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { Button } from '../ui/Button.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { useDeliveryChangelists } from './deliveryChangelists.js';
import type { DeliveryFile, DeliveryRepositoryGroup } from './GitDeliveryWorkspace.js';

/** 文件菜单与快捷键共享动作，提交勾选不决定文件操作范围。 */
export function useDeliveryFileMenu(props: {
  projectId: string;
  zh: boolean;
  disabled: boolean;
  working: boolean;
  /** 已回收的工作树没有可跳转的工作区源码。 */
  committedOnly?: boolean;
  request(workspaceId: string, path: string): FilePreviewRequest;
  onRefresh(): Promise<void>;
  onBusyChange(busy: boolean): void;
  onSelectFile(workspaceId: string, path: string): void;
  onOpenFile(workspaceId: string, path: string): void;
}) {
  /** 一次菜单固定点击节点及实际仓库，刷新后由宿主再次校验。 */
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: GitMenuItem[]; anchor: HTMLElement } | null>(null);
  /** 删除和回滚共用可取消的确认框。 */
  const [confirmation, setConfirmation] = useState<GitMenuConfirmation | null>(null);
  /** 文件动作错误不覆盖页面读取状态。 */
  const [error, setError] = useState<unknown>();
  /** 移动列表保留节点范围，不依赖提交复选框。 */
  const [move, setMove] = useState<{ root: string; paths: string[] } | null>(null);
  /** 立即阻止 React 重绘前的重复执行。 */
  const pending = useRef(false);
  /** 项目分组偏好在同源窗口间同步。 */
  const lists = useDeliveryChangelists(props.projectId);

  // 范围切换或其他交付动作开始时，关闭旧菜单而不是保留旧可用状态。
  useEffect(() => setMenu(null), [props.disabled, props.working, props.projectId]);

  /** 失败也刷新，批量删除已完成的部分不能留在旧文件树里。 */
  async function run(action: GitDeliveryFileActionInput['action'] | 'refresh', id: string, files: DeliveryFile[]) {
    if (pending.current || props.disabled) return;
    pending.current = true;
    props.onBusyChange(true);
    setError(undefined);
    try {
      if (action !== 'refresh') {
        if (!window.zeus?.actOnGitDeliveryFiles) throw new Error(props.zh ? '当前窗口不支持文件操作。' : 'File actions are unavailable in this window.');
        await window.zeus.actOnGitDeliveryFiles({ action, requests: files.map((file) => props.request(id, file.path)) });
      }
    } finally {
      try {
        if (action !== 'source') {
          notifyProjectGitChanged(props.projectId);
          await props.onRefresh();
        }
      } finally {
        pending.current = false;
        props.onBusyChange(false);
      }
    }
  }

  /** 目录操作只包含该节点内的可见文件，单文件动作不扩大为提交勾选。 */
  function items(group: DeliveryRepositoryGroup, files: DeliveryFile[]): GitMenuItem[] {
    /** 节点身份与预览请求保持一致。 */
    const id = group.workspace.id;
    /** 单文件才能打开独立差异或源码页。 */
    const single = files.length === 1 ? files[0] : undefined;
    /** 加入版本控制仅暂存未跟踪文件。 */
    const untracked = files.filter((file) => file.status === 'untracked');
    /** 回滚与列表只作用于已受 Git 管理的文件。 */
    const tracked = files.filter((file) => file.status !== 'untracked');
    /** 已删除文件没有可移入回收站的内容。 */
    const existing = files.filter((file) => file.status !== 'deleted');
    /** 交付写入期间和已丢弃任务工作区不能接纳文件动作。 */
    const disabled = props.disabled || group.workspace.state === 'discarded';
    /** 确认框列出真实受影响文件，目录展开与提交勾选不会改变这个快照。 */
    function confirm(action: 'rollback' | 'trash', affected: DeliveryFile[]) {
      setConfirmation({
        title: action === 'trash' ? (props.zh ? '删除文件' : 'Delete files') : props.zh ? '回滚文件' : 'Rollback files',
        description: `${
          action === 'trash'
            ? props.zh
              ? '将以下文件移入系统废纸篓或回收站：'
              : 'Move these files to the system Trash or Recycle Bin:'
            : props.zh
              ? '恢复到 HEAD，丢弃暂存和未暂存修改。已暂存的新文件会被移除；首次提交前只取消暂存并保留文件：'
              : 'Restore HEAD and discard staged and unstaged changes. Staged new files are removed; before the first commit, files are only unstaged and kept:'
        }\n${affected.map((file) => file.path).join('\n')}`,
        danger: true,
        run: async () => {
          await run(action, id, affected);
          return true;
        },
      });
    }
    /** Mac 使用 Command，Windows 与 Linux 使用 Ctrl。 */
    const primary = isMacOSPlatform() ? '⌘' : 'Ctrl+';
    const alt = isMacOSPlatform() ? '⌥' : 'Alt+';
    const shift = isMacOSPlatform() ? '⇧' : 'Shift+';
    return [
      { icon: <GitDiff aria-hidden="true" />, label: props.zh ? '查看差异' : 'Show Diff', shortcut: `${primary}D`, disabled: disabled || !single, run: () => props.onSelectFile(id, single!.path) },
      { icon: <ArrowSquareOut aria-hidden="true" />, label: props.zh ? '在新窗口查看差异' : 'Show Diff in a New Window', disabled: disabled || !single, run: () => props.onOpenFile(id, single!.path) },
      { icon: <ArrowClockwise aria-hidden="true" />, label: props.zh ? '刷新' : 'Refresh', shortcut: 'F5', disabled: props.disabled, run: () => run('refresh', id, []) },
      { icon: <Plus aria-hidden="true" />, label: props.zh ? '加入版本控制' : 'Add to VCS', shortcut: `${alt}${primary}A`, disabled: disabled || !props.working || !untracked.length, run: () => run('stage', id, untracked) },
      {
        icon: <ArrowRight aria-hidden="true" />,
        label: props.zh ? '移动到变更列表…' : 'Move to Changelist…',
        shortcut: `${shift}${primary}M`,
        disabled: disabled || !props.working || !tracked.length || !group.localPath,
        run: () => setMove({ root: group.localPath!, paths: tracked.map((file) => file.path) }),
      },
      { icon: <Trash aria-hidden="true" />, label: props.zh ? '删除…' : 'Delete…', disabled: disabled || !props.working || !existing.length, danger: true, run: () => confirm('trash', existing) },
      {
        icon: <ArrowCounterClockwise aria-hidden="true" />,
        label: props.zh ? '回滚…' : 'Rollback…',
        shortcut: `${alt}${primary}Z`,
        disabled: disabled || !props.working || !tracked.length || files.some((file) => file.status === 'conflict'),
        danger: true,
        run: () => confirm('rollback', tracked),
      },
      {
        icon: <FileCode aria-hidden="true" />,
        label: props.zh ? '跳转到源码' : 'Jump to Source',
        shortcut: `${primary}↓`,
        disabled: props.committedOnly || disabled || !single || single.status === 'deleted',
        run: () => run('source', id, files),
      },
    ];
  }
  /** 键盘菜单使用当前节点的屏幕边界；不拦截编辑器内快捷键。 */
  function openMenu(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, group: DeliveryRepositoryGroup, files: DeliveryFile[]) {
    event.preventDefault();
    event.stopPropagation();
    /** 键盘菜单定位到当前节点，鼠标菜单沿用点击位置。 */
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({
      x: 'clientX' in event ? event.clientX : rect.left,
      y: 'clientY' in event ? event.clientY : rect.bottom,
      title: files.length === 1 ? files[0]!.path : `${group.workspace.repositoryName} · ${files.length}`,
      items: items(group, files),
      anchor: event.currentTarget,
    });
  }
  return {
    lists,
    onError: setError,
    openMenu,
    /** 快捷键只在文件树当前节点内生效，菜单和确认框仍使用共享键盘处理。 */
    onKeyDown(event: KeyboardEvent<HTMLElement>, group: DeliveryRepositoryGroup, files: DeliveryFile[]) {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        openMenu(event, group, files);
        return;
      }
      if (event.repeat || event.nativeEvent.isComposing || event.defaultPrevented) return;
      const primary = isMacOSPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const key = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
      const index =
        primary && key === 'd' && !event.altKey && !event.shiftKey
          ? 0
          : primary && event.altKey && key === 'a'
            ? 3
            : primary && event.shiftKey && key === 'm'
              ? 4
              : primary && event.altKey && key === 'z'
                ? 6
                : primary && event.key === 'ArrowDown'
                  ? 7
                  : event.key === 'F5'
                    ? 2
                    : -1;
      if (index < 0) return;
      event.preventDefault();
      event.stopPropagation();
      const item = items(group, files)[index]!;
      if (!item.disabled) void Promise.resolve(item.run()).catch(setError);
    },
    dialogs: (
      <>
        {error ? <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} /> : null}
        {menu ? <GitContextMenu {...menu} onClose={() => setMenu(null)} onError={setError} /> : null}
        {confirmation ? <GitMenuActionDialog value={confirmation} zh={props.zh} onClose={() => setConfirmation(null)} /> : null}
        {move ? (
          <GitChangelistDialog
            zh={props.zh}
            names={lists.names}
            onClose={() => setMove(null)}
            onMove={(name) => {
              lists.move(move.root, move.paths, name);
              setMove(null);
            }}
          />
        ) : null}
      </>
    ),
  };
}

/** 文件移动与 Undo Commit 共用既有列表、新建名称和异步提交状态。 */
export function GitChangelistDialog(props: {
  zh: boolean;
  names: string[];
  title?: string;
  description?: string;
  suggestedName?: string;
  actionLabel?: string;
  optionLabel?: string;
  onClose(): void;
  onMove(name: string, checked: boolean): void | Promise<void>;
}) {
  /** 默认列表与新建选项使用独立身份，允许用户列表拥有任意名称。 */
  const [choice, setChoice] = useState(() => (props.suggestedName ? 'new' : 'default'));
  /** 名称仅在选择新建时提交。 */
  const [name, setName] = useState(props.suggestedName?.slice(0, 120) ?? '');
  /** 用户决定是否移除已应用的 Shelf 文件。 */
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const title = props.title ?? (props.zh ? '移动到变更列表' : 'Move to Changelist');
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={busy} role="dialog" aria-label={title}>
      <section className="project-git-menu-action-dialog" data-modal-surface="dialog">
        <header>
          <strong>{title}</strong>
          {props.description ? <p>{props.description}</p> : null}
        </header>
        <ZeusSelect
          size="compact"
          ariaLabel={props.zh ? '变更列表' : 'Changelist'}
          value={choice}
          disabled={busy}
          onChange={setChoice}
          options={[{ value: 'default', label: props.zh ? '默认变更列表' : 'Default Changelist' }, ...props.names.map((label) => ({ value: `name:${label}`, label })), { value: 'new', label: props.zh ? '新建变更列表…' : 'New Changelist…' }]}
        />
        {choice === 'new' ? (
          <label>
            {props.zh ? '名称' : 'Name'}
            <input autoFocus value={name} maxLength={120} disabled={busy} onChange={(event) => setName(event.target.value)} />
          </label>
        ) : null}
        {props.optionLabel ? (
          <label className="project-git-checkbox">
            <input type="checkbox" checked={checked} disabled={busy} onChange={(event) => setChecked(event.currentTarget.checked)} />
            {props.optionLabel}
          </label>
        ) : null}
        {error ? <VisibleApplicationError error={error} /> : null}
        <footer>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            busy={busy}
            disabled={busy || (choice === 'new' && !name.trim())}
            onClick={async () => {
              if (submitting.current) return;
              submitting.current = true;
              setBusy(true);
              setError(undefined);
              try {
                await props.onMove(choice === 'default' ? '' : choice === 'new' ? name.trim() : choice.slice(5), checked);
              } catch (reason) {
                setError(reason);
              } finally {
                submitting.current = false;
                setBusy(false);
              }
            }}
          >
            {props.actionLabel ?? (props.zh ? '移动' : 'Move')}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}
