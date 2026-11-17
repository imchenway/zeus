import type { ConversationResource, ConversationFileLocation } from '@zeus/shared';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { AppWindowIcon as AppWindow } from '@phosphor-icons/react/dist/csr/AppWindow';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { FileMagnifyingGlassIcon as FileMagnifyingGlass } from '@phosphor-icons/react/dist/csr/FileMagnifyingGlass';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { OpenWithMenu } from './ConversationResources.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { Button } from '../ui/Button.js';
import type { ConversationOpenTarget, ConversationResourceOpenTarget } from '@zeus/shared';
import { listConversationResourceOpenTargetsInMain } from '../appShellBridge.js';
import { FilePreview, FileReviewContent, FileSourceEditButton, PreviewImage } from '../code/FilePreview.js';
import { Suspense, lazy, useEffect, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowsInIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { ArrowsOutIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
import { FileWorkspaceToolbar } from '../code/FileWorkspaceToolbar.js';
import { useFilePreviewRefresh } from '../code/useFilePreviewRefresh.js';
import { fileStatusLabel } from '../code/fileStatus.js';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { ConversationResourcePreview } from './sessionTypes.js';
import { copyText, type SessionUiLanguage } from './ThreadItemView.js';
import { ConversationMarkdown } from './ConversationMarkdown.js';
import type { FilePreviewItem, FilePreviewRequest, ConversationCodeComment } from '@zeus/shared';
import { ReadingStateScope, useReadingScroll } from '../ui/readingState.js';
/** 与项目源码编辑器一样按需加载，避免会话首屏加载编辑器和评论运行时。 */
const CommentableSourceCodePreview = lazy(() => import('./CommentableSourceCodePreview.js').then((module) => ({ default: module.CommentableSourceCodePreview })));

/** Markdown 可在排版预览与源码之间切换。 */
export type SourceWorkspaceViewMode = 'preview' | 'source';

/** 标签按已授权文件去重；资源记录仍独立用于后端读取与打开授权。 */
function sourceWorkspaceTabId(preview: ConversationResourcePreview): string {
  return JSON.stringify([preview.resource.projectId, preview.resource.conversationId, preview.fileIdentity ? 'file' : 'resource', preview.fileIdentity ?? preview.resource.id]);
}

/** Markdown 默认展示排版，其余文件直接展示源码。 */
export function defaultSourceWorkspaceViewMode(preview: ConversationResourcePreview): SourceWorkspaceViewMode {
  if (preview.kind === 'source' && preview.location?.line) return 'source';
  return supportsMarkdownPreview(preview) ? 'preview' : 'source';
}

/** 源码标签状态由会话持有，组件卸载后仍可恢复。 */
export interface SourceWorkspaceState {
  /** 已处理的打开请求，恢复面板时不重新选择旧请求。 */
  requestedPreview: ConversationResourcePreview;
  /** 每个标签保留自己的预览模式和已授权资源。 */
  tabs: { preview: ConversationResourcePreview; mode: SourceWorkspaceViewMode }[];
  /** 当前文件标签标识独立于消息中的资源记录。 */
  activeId: string;
}

/** 同一会话保留已打开文件，关闭当前标签后回到相邻文件。 */
export function SourceWorkspace(
  props: Parameters<typeof SourceWorkspaceView>[0] & {
    /** 会话保存的源码标签状态。 */
    state: SourceWorkspaceState | null;
    /** 所有标签操作写回所属会话。 */
    onStateChange: Dispatch<SetStateAction<SourceWorkspaceState | null>>;
    /** 重新读取资源正文与 Git 状态，不触发打开、导航或焦点变化。 */
    onLoadPreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  },
) {
  /** 隐藏的侧栏不接管其他工作面的关闭命令。 */
  const workspaceRef = useRef<HTMLElement | null>(null);
  /** 首次打开可直接展示，后续挂载读取会话保存的选择。 */
  const { tabs, activeId } = props.state ?? { tabs: [{ preview: props.preview, mode: props.viewMode }], activeId: sourceWorkspaceTabId(props.preview) };
  useEffect(() => {
    props.onStateChange((current) => {
      if (current?.requestedPreview === props.preview) return current;
      /** 重复打开只更新正文、授权与定位，保留原标签顺序。 */
      const id = sourceWorkspaceTabId(props.preview);
      /** 没有指定行号时保留用户选择的阅读模式。 */
      const existing = current?.tabs.find((tab) => sourceWorkspaceTabId(tab.preview) === id);
      /** 行号链接必须显示源码，普通重开沿用原模式。 */
      const tab = { preview: props.preview, mode: props.preview.kind === 'source' && props.preview.location?.line ? ('source' as const) : (existing?.mode ?? props.viewMode) };
      return {
        requestedPreview: props.preview,
        tabs: existing ? current!.tabs.map((entry) => (sourceWorkspaceTabId(entry.preview) === id ? tab : entry)) : [...(current?.tabs ?? []), tab],
        activeId: id,
      };
    });
  }, [props.onStateChange, props.preview, props.viewMode]);
  /** 外部预览到达但状态尚未同步时仍显示真实文件。 */
  const active = tabs.find((tab) => sourceWorkspaceTabId(tab.preview) === activeId) ?? tabs[0]!;
  /** 异步读取按代次接纳，较早回执不能覆盖较新内容。 */
  const readRevision = useRef(0);
  /** 刷新反馈绑定文件身份，切换标签不显示其他文件的状态。 */
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<{ id: string; error: unknown } | null>(null);
  /** 原标签原位接纳新正文，保留阅读模式、标签顺序与行定位。 */
  async function refreshPreview(): Promise<void> {
    if (!props.onLoadPreview) return;
    const preview = active.preview;
    const id = sourceWorkspaceTabId(preview);
    const revision = ++readRevision.current;
    setRefreshingId(id);
    setRefreshError(null);
    try {
      const refreshed = await props.onLoadPreview(preview.resource);
      if (revision !== readRevision.current) return;
      props.onStateChange((current) =>
        current
          ? {
              ...current,
              tabs: current.tabs.map((tab) =>
                sourceWorkspaceTabId(tab.preview) === id ? { ...tab, preview: refreshed.kind === 'source' && tab.preview.kind === 'source' ? { ...refreshed, location: tab.preview.location } : refreshed } : tab,
              ),
            }
          : current,
      );
    } catch (error) {
      if (revision === readRevision.current) setRefreshError({ id, error });
    } finally {
      if (revision === readRevision.current) setRefreshingId(null);
    }
  }
  useFilePreviewRefresh(
    props.onLoadPreview ? { kind: 'resource', projectId: active.preview.resource.projectId, conversationId: active.preview.resource.conversationId, resourceId: active.preview.resource.id } : null,
    refreshPreview,
    (error) => setRefreshError({ id: sourceWorkspaceTabId(active.preview), error }),
  );
  useEffect(
    () => () => {
      readRevision.current += 1;
    },
    [],
  );
  /** 原生快捷键和关闭按钮共享同一标签更新，连续命令读取最新状态。 */
  function closeTab(id?: string): void {
    /** 仅最后一个标签需要关闭整个侧栏。 */
    let closeWorkspace = false;
    props.onStateChange((current) => {
      if (!current) return current;
      /** 快捷键在执行时确定当前标签，不捕获上一帧的标签。 */
      const closingId = id ?? current.activeId;
      /** 其他文件保留原顺序和各自的阅读状态。 */
      const remaining = current.tabs.filter((tab) => sourceWorkspaceTabId(tab.preview) !== closingId);
      if (!remaining.length) {
        closeWorkspace = true;
        return current;
      }
      return { ...current, tabs: remaining, activeId: closingId === current.activeId ? sourceWorkspaceTabId(remaining.at(-1)!.preview) : current.activeId };
    });
    if (closeWorkspace) props.onClose();
  }
  useEffect(
    () =>
      window.zeus?.onNativeCloseActiveContextTab?.((owner) => {
        /** 以实际承载会话为准，资源引用可以来自另一条消息。 */
        const workspace = workspaceRef.current;
        if (!workspace?.getClientRects().length || workspace.closest('[hidden], [inert], [data-tool-covered="true"]')) return;
        if (owner && owner !== (workspace.closest('[data-context-owner]')?.getAttribute('data-context-owner') ?? props.preview.resource.conversationId)) return;
        closeTab();
      }),
    [props.onStateChange, props.onClose, props.preview.resource.conversationId],
  );
  return (
    <ReadingStateScope id={`source:${sourceWorkspaceTabId(active.preview)}`}>
      <SourceWorkspaceView
        {...props}
        workspaceRef={workspaceRef}
        preview={active.preview}
        onRefresh={props.onLoadPreview ? refreshPreview : undefined}
        refreshing={refreshingId === sourceWorkspaceTabId(active.preview)}
        refreshError={refreshError?.id === sourceWorkspaceTabId(active.preview) ? refreshError.error : null}
        viewMode={active.mode}
        tabs={tabs.map((tab) => tab.preview)}
        onSelectTab={(preview) => props.onStateChange((current) => (current ? { ...current, activeId: sourceWorkspaceTabId(preview) } : current))}
        onViewModeChange={(mode) => props.onStateChange((current) => (current ? { ...current, tabs: current.tabs.map((tab) => (sourceWorkspaceTabId(tab.preview) === current.activeId ? { ...tab, mode } : tab)) } : current))}
        onCloseTab={(preview) => closeTab(sourceWorkspaceTabId(preview))}
      />
    </ReadingStateScope>
  );
}

/** 会话资源共用的预览入口，源码交给可视区域渲染，图片与 Markdown 保持原有展示。 */
function SourceWorkspaceView(props: {
  /** 刷新使用当前资源授权，不重新打开标签。 */
  onRefresh?: () => void | Promise<void>;
  /** 当前文件正在读取时提供忙碌状态并阻止重复点击。 */
  refreshing?: boolean;
  /** 刷新失败时保留原正文并显示具体原因。 */
  refreshError?: unknown;
  /** 原生快捷键根据真实工作面的可见性确认归属。 */
  workspaceRef?: RefObject<HTMLElement | null>;
  /** 文件标题与浏览器标签共用会话顶栏位置。 */
  toolbarHost?: HTMLElement | null;
  preview: ConversationResourcePreview;
  /** 外部打开沿用宿主的资源授权。 */
  onOpen?: (target: ConversationOpenTarget, resource?: ConversationResource) => void | Promise<void>;
  /** 多文件标签由外层持有，正文组件只负责当前文件。 */
  tabs?: ConversationResourcePreview[];
  onSelectTab?: (preview: ConversationResourcePreview) => void;
  onCloseTab?: (preview: ConversationResourcePreview) => void;
  /** 新增标签从本会话已有授权文件中选择。 */
  resources?: ConversationResource[];
  onOpenFile?: (resource: ConversationResource) => void | Promise<void>;
  viewMode: SourceWorkspaceViewMode;
  onViewModeChange: (viewMode: SourceWorkspaceViewMode) => void;
  language: SessionUiLanguage;
  fullWidth: boolean;
  /** 窄窗口已经全宽，分栏按钮给出明确的不可用原因。 */
  canSplit?: boolean;
  onFullWidthChange: (fullWidth: boolean) => void;
  onClose: () => void;
  comments?: ConversationCodeComment[];
  onCommentsChange?: (comments: ConversationCodeComment[]) => void;
}) {
  /** 当前界面文案与资源展示信息。 */
  const zh = props.language === 'zh-CN';
  /** 分段打开按钮保留本次预览选择的外部应用。 */
  const [openTarget, setOpenTarget] = useState<ConversationOpenTarget | null>(null);
  /** 图标与菜单共用本机检测结果，不显示未安装应用。 */
  const [openTargets, setOpenTargets] = useState<ConversationResourceOpenTarget[]>([]);
  /** 每次点击都请求聚焦当前文件的查找面板，关闭后也能再次打开。 */
  const [searchRequest, setSearchRequest] = useState(0);
  useEffect(() => {
    /** 文件切换后拒绝上一文件的迟到检测结果。 */
    let active = true;
    setOpenTargets([]);
    setOpenTarget(null);
    void listConversationResourceOpenTargetsInMain({ zeus: window.zeus, projectId: props.preview.resource.projectId, conversationId: props.preview.resource.conversationId, resourceId: props.preview.resource.id })
      .then((result) => {
        if (!active) return;
        setOpenTargets(result.targets);
        // 首次检测只补齐尚未选择的目标，保留用户已选的应用。
        setOpenTarget((current) => current ?? result.targets.find((target) => target.available && target.id.startsWith('editor:'))?.id ?? 'system_default');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [props.preview.resource.projectId, props.preview.resource.conversationId, props.preview.resource.id]);
  /** 文件标签与正文共用稳定身份，消息资源变化不重新挂载同一文件。 */
  const tabId = sourceWorkspaceTabId(props.preview);
  /** Markdown 和图片正文沿用当前文件自己的阅读坐标。 */
  const contentScroll = useReadingScroll(`content:${props.viewMode}`);
  /** 当前打开应用的真实图标与名称。 */
  const openApplication = openTargets.find((target) => target.id === openTarget);
  /** 展示宿主打开失败，不吞掉权限或应用错误。 */
  const [openError, setOpenError] = useState<unknown>(null);
  /** 成功提示绑定资源，切换文件不会显示上一文件的复制结果。 */
  const [copiedResourceId, setCopiedResourceId] = useState<string | null>(null);
  /** 复制提示短暂显示，卸载或提示变更时取消定时器。 */
  useEffect(() => {
    if (!copiedResourceId) return;
    /** 提示持续到期后恢复复制入口。 */
    const timeout = window.setTimeout(() => setCopiedResourceId(null), 1600);
    return () => window.clearTimeout(timeout);
  }, [copiedResourceId]);
  /** 工具栏只展示当前文件的复制结果。 */
  const copied = copiedResourceId === props.preview.resource.id;
  /** 图标提示与无障碍反馈共用全文复制文案。 */
  const copyLabel = copied ? (zh ? '已复制全文' : 'Full text copied') : zh ? '复制全文' : 'Copy full text';
  /** 复制当前文件已完整加载的正文，不复制路径或当前选区。 */
  async function copyFullText(): Promise<void> {
    if (props.preview.kind !== 'source' || props.preview.truncated) return;
    setOpenError(null);
    setCopiedResourceId(null);
    try {
      if (!(await copyText(props.preview.content))) throw new Error(zh ? '复制全文失败，请重试。' : 'Could not copy the full text. Please try again.');
      setCopiedResourceId(props.preview.resource.id);
    } catch (error) {
      setOpenError(error);
    }
  }
  /** 外部应用和打开方式菜单共用原有授权入口。 */
  async function openResource(target: ConversationOpenTarget): Promise<void> {
    setOpenError(null);
    try {
      await props.onOpen?.(target, props.preview.resource);
    } catch (error) {
      setOpenError(error);
    }
  }
  /** 图片和文件操作只使用宿主发放的文件令牌，操作结束撤销全部令牌。 */
  async function fileAction(action: 'export' | 'open' | 'reveal'): Promise<void> {
    /** 当前受信桥接同时负责授权读取、系统操作和授权释放。 */
    const bridge = window.zeus;
    if (!bridge) {
      setOpenError(new Error(zh ? '当前环境没有文件操作服务。' : 'File actions are unavailable in this environment.'));
      return;
    }
    /** 令牌只在此次用户操作期间有效。 */
    let ids: string[] = [];
    setOpenError(null);
    try {
      /** 仅请求当前会话登记的资源，不接受渲染层拼接的本地路径。 */
      const items = await bridge.loadFilePreview({ kind: 'resource', projectId: props.preview.resource.projectId, conversationId: props.preview.resource.conversationId, resourceId: props.preview.resource.id });
      ids = items.map((item) => item.id).filter(Boolean);
      if (!ids[0]) throw new Error(zh ? '当前文件无法执行此操作。' : 'This action is unavailable for the current file.');
      await bridge.actOnFilePreview(ids[0], action);
    } catch (error) {
      setOpenError(error);
    } finally {
      if (ids.length) void bridge.releaseFilePreview(ids).catch(() => undefined);
    }
  }
  /** 打开资源时供键盘用户定位预览标题。 */
  const titleRef = useRef<HTMLButtonElement | null>(null);
  /** 图片资源不参与源码或 Markdown 渲染。 */
  const sourcePreview = props.preview.kind === 'source' ? props.preview : null;
  /** 文件用项目相对路径，附件使用显示名称。 */
  const displayPath = props.preview.resource.kind === 'file' ? props.preview.resource.projectRelativePath : props.preview.resource.displayName;
  /** 是否提供 Markdown 排版切换入口。 */
  const markdownPreview = supportsMarkdownPreview(props.preview);
  /** 当前只挂载被选中的一种展示模式。 */
  const renderedMarkdown = Boolean(sourcePreview && markdownPreview && props.viewMode === 'preview');
  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabId, sourcePreview?.location]);

  /** 顶栏展示文件名与预览操作，正文从文件信息行直接开始。 */
  const header = (
    <header className="session-context-workspace-header session-source-header">
      <div
        className="session-source-tabs zeus-workspace-tabs"
        role="tablist"
        aria-label={zh ? '已打开文件' : 'Open files'}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
          event.preventDefault();
          const tabs = props.tabs ?? [props.preview];
          const index = tabs.findIndex((tab) => sourceWorkspaceTabId(tab) === tabId);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          props.onSelectTab?.(tabs[next]!);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {(props.tabs ?? [props.preview]).map((preview) => (
          <div className="zeus-workspace-tab-shell" data-active={sourceWorkspaceTabId(preview) === tabId || undefined} key={sourceWorkspaceTabId(preview)}>
            <Button
              unstyled
              type="button"
              ref={sourceWorkspaceTabId(preview) === tabId ? titleRef : undefined}
              role="tab"
              className="zeus-workspace-tab"
              tabIndex={sourceWorkspaceTabId(preview) === tabId ? 0 : -1}
              aria-selected={sourceWorkspaceTabId(preview) === tabId}
              data-icon-tooltip={preview.review?.status ? `${preview.resource.displayName} · ${fileStatusLabel(preview.review.status, zh)}` : preview.resource.displayName}
              aria-label={preview.review?.status ? `${preview.resource.displayName} · ${fileStatusLabel(preview.review.status, zh)}` : preview.resource.displayName}
              onClick={() => props.onSelectTab?.(preview)}
            >
              {supportsMarkdownPreview(preview) ? <File aria-hidden="true" /> : <FileTypeIcon name={preview.resource.kind === 'file' ? preview.resource.projectRelativePath : preview.resource.displayName} />}
              <span data-file-status={preview.review?.status}>{basename(preview.resource.kind === 'file' ? preview.resource.projectRelativePath : preview.resource.displayName)}</span>
            </Button>
            <Button
              unstyled
              type="button"
              className="zeus-workspace-tab-close"
              aria-label={`${zh ? '关闭' : 'Close'} ${preview.resource.displayName}`}
              data-icon-tooltip={`${zh ? '关闭' : 'Close'} ${preview.resource.displayName}`}
              onClick={() => (props.onCloseTab ? props.onCloseTab(preview) : props.onClose())}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        ))}
        {props.onOpenFile && props.resources?.length ? (
          <div className="session-source-add-tab-shell">
            <Plus aria-hidden="true" />
            <select
              className="session-source-add-tab"
              aria-label={zh ? '打开文件标签' : 'Open file tab'}
              value=""
              data-icon-tooltip={zh ? '打开本会话中的文件' : 'Open a file from this conversation'}
              onChange={(event) => {
                const resource = props.resources?.find((candidate) => candidate.id === event.currentTarget.value);
                if (resource) return Promise.resolve(props.onOpenFile?.(resource)).catch(setOpenError);
              }}
            >
              <option value="">{zh ? '打开文件…' : 'Open file…'}</option>
              {props.resources?.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.displayName}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <nav aria-label={zh ? '源码预览操作' : 'Source preview actions'}>
        <Button
          unstyled
          type="button"
          aria-label={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
          disabled={props.canSplit === false}
          data-icon-tooltip={props.canSplit === false ? (zh ? '窗口较窄，已自动全宽显示' : 'This window is too narrow for split view') : props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
          onClick={() => props.onFullWidthChange(!props.fullWidth)}
        >
          {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
        </Button>
      </nav>
    </header>
  );

  return (
    <section
      ref={props.workspaceRef}
      className="session-context-workspace session-source-workspace"
      aria-label={props.preview.kind === 'image' ? (zh ? '图片预览' : 'Image preview') : renderedMarkdown ? (zh ? 'Markdown 预览' : 'Markdown preview') : zh ? '源码预览' : 'Source preview'}
    >
      {props.toolbarHost ? createPortal(header, props.toolbarHost) : header}
      {props.refreshError || openError ? (
        <p role="alert">
          <VisibleApplicationError error={props.refreshError ?? openError} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      <FileReviewContent
        onSaved={props.onRefresh}
        previewRequest={
          props.preview.resource.kind === 'file'
            ? { kind: 'resource', projectId: props.preview.resource.projectId, conversationId: props.preview.resource.conversationId, resourceId: props.preview.resource.id, comparison: 'head' }
            : undefined
        }
        sourceRequest={searchRequest}
        key={`${tabId}:${sourcePreview?.location?.line ?? ''}:${sourcePreview?.location?.endLine ?? ''}`}
        review={sourcePreview ? { ...sourcePreview.review, location: sourcePreview.location } : undefined}
        zh={zh}
        toolbar={(reviewActions) => (
          <>
            <FileWorkspaceToolbar path={displayPath} zh={zh}>
              {reviewActions}
              {props.onRefresh ? (
                <Button unstyled type="button" aria-label={zh ? '刷新文件' : 'Refresh file'} data-icon-tooltip={zh ? '刷新文件' : 'Refresh file'} aria-busy={props.refreshing} disabled={props.refreshing} onClick={() => props.onRefresh?.()}>
                  <ArrowClockwise aria-hidden="true" />
                </Button>
              ) : null}
              {sourcePreview && props.preview.resource.kind === 'file' ? (
                <FileSourceEditButton zh={zh} request={{ kind: 'resource', projectId: props.preview.resource.projectId, conversationId: props.preview.resource.conversationId, resourceId: props.preview.resource.id }} />
              ) : null}
              <Button
                unstyled
                type="button"
                aria-label={zh ? '在文件中搜索' : 'Find in file'}
                data-icon-tooltip={zh ? '在文件中搜索' : 'Find in file'}
                disabled={!sourcePreview}
                onClick={() => {
                  props.onViewModeChange('source');
                  setSearchRequest((request) => request + 1);
                }}
              >
                <FileMagnifyingGlass aria-hidden="true" />
              </Button>
              {markdownPreview ? (
                <Button size="compact" className="session-source-mode-toggle" onClick={() => props.onViewModeChange(renderedMarkdown ? 'source' : 'preview')}>
                  {renderedMarkdown ? (zh ? '查看源代码' : 'View source') : zh ? '查看预览' : 'View preview'}
                </Button>
              ) : null}
              <Button
                unstyled
                type="button"
                aria-label={copyLabel}
                data-icon-tooltip={
                  !sourcePreview ? (zh ? '当前文件没有可复制的文本' : 'This file has no text to copy') : sourcePreview.truncated ? (zh ? '预览不完整，无法复制全文' : 'The preview is incomplete; full text cannot be copied') : copyLabel
                }
                disabled={!sourcePreview || sourcePreview.truncated}
                onClick={() => copyFullText()}
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </Button>
              <span role="status" className="session-source-copy-status">
                {copied ? copyLabel : ''}
              </span>
              <div className="session-source-open-group">
                <Button unstyled type="button" disabled={!props.onOpen} data-icon-tooltip={openApplication?.label} onClick={() => openResource(openTarget ?? 'system_default')}>
                  {openApplication?.iconDataUrl ? (
                    <img src={openApplication.iconDataUrl} alt="" width={18} height={18} />
                  ) : openTarget === 'system_default' ? (
                    <FolderOpen className="session-open-with-default-icon" aria-hidden="true" weight="duotone" />
                  ) : (
                    <AppWindow aria-hidden="true" />
                  )}
                  {zh ? '打开' : 'Open'}
                </Button>
                <OpenWithMenu
                  key={props.preview.resource.id}
                  resource={props.preview.resource}
                  language={props.language}
                  disabled={!props.onOpen}
                  applicationsOnly
                  preferBelow
                  targets={openTargets.length ? openTargets : undefined}
                  footer={
                    <>
                      <Button unstyled type="button" role="menuitem" onClick={() => openResource('file_manager')}>
                        {zh ? '打开所在文件夹' : 'Show in folder'}
                      </Button>
                      <Button unstyled type="button" role="menuitem" onClick={() => fileAction('export')}>
                        {zh ? '另存为…' : 'Save as…'}
                      </Button>
                    </>
                  }
                  onOpen={(target) => {
                    setOpenTarget(target);
                    return openResource(target);
                  }}
                  label=""
                />
              </div>
            </FileWorkspaceToolbar>
            {sourcePreview?.truncated ? <div role="status">{zh ? '预览已截断' : 'Preview truncated'}</div> : null}
          </>
        )}
      >
        <div ref={contentScroll} className={renderedMarkdown ? 'session-source-markdown-scroll' : `session-source-scroll ${props.preview.kind === 'image' ? 'session-image-preview' : ''}`}>
          {props.preview.kind === 'image' ? (
            <PreviewImage key={props.preview.dataUrl} url={props.preview.dataUrl} name={props.preview.resource.displayName} zh={zh} onFileAction={fileAction} />
          ) : renderedMarkdown ? (
            <ConversationMarkdown text={props.preview.content} streamId={`source-preview:${tabId}`} phase="final" language={props.language} documentMode />
          ) : (
            <Suspense fallback={null}>
              <CommentableSourceCodePreview
                key={tabId}
                identity={tabId}
                path={displayPath}
                content={props.preview.content}
                language={props.preview.language}
                label={zh ? `${displayPath} 源码` : `${displayPath} source`}
                projectId={props.preview.resource.kind === 'file' ? props.preview.resource.projectId : undefined}
                conversationId={props.preview.resource.kind === 'file' ? props.preview.resource.conversationId : undefined}
                resourceId={props.preview.resource.kind === 'file' ? props.preview.resource.id : undefined}
                locale={props.language}
                searchRequest={searchRequest}
                location={props.preview.location}
                comments={props.comments}
                onCommentsChange={props.onCommentsChange}
              />
            </Suspense>
          )}
        </div>
      </FileReviewContent>
    </section>
  );
}

/** 依据资源类型、语言及后缀保留 Markdown 预览能力。 */
function supportsMarkdownPreview(preview: ConversationResourcePreview): boolean {
  if (preview.kind !== 'source') return false;
  if (preview.resource.iconKind === 'markdown') return true;
  /** 语言信息可能来自文件后缀或附件预览。 */
  const language = preview.language?.trim().toLowerCase();
  if (language === 'markdown' || language === 'md' || language === 'mdx') return true;
  /** 文件用项目相对路径，附件使用显示名称。 */
  const displayPath = preview.resource.kind === 'file' ? preview.resource.projectRelativePath : preview.resource.displayName;
  return /\.(?:md|markdown|mdx)$/iu.test(displayPath);
}

/** 标题仅显示文件名，完整路径仍在副标题中保留。 */
function basename(path: string): string {
  /** 统一路径分隔符后取文件名。 */
  const normalized = path.replaceAll('\\', '/');
  return normalized.split('/').filter(Boolean).at(-1) ?? path;
}

/** 通用文件沿用会话右侧审阅容器，预览组件负责授权读取、格式展示和失败重试。 */
export function FilePreviewWorkspace(props: {
  request: FilePreviewRequest;
  /** 本次点击的位置独立于资源首次登记的行号。 */
  location?: ConversationFileLocation;
  /** 会话评论使用的项目相对路径或附件名称。 */
  commentPath?: string;
  language: SessionUiLanguage;
  toolbarHost?: HTMLElement | null;
  fullWidth: boolean;
  canSplit: boolean;
  /** 当前会话全部代码评论。 */
  comments?: ConversationCodeComment[];
  /** 缺省表示当前会话只读。 */
  onCommentsChange?: (comments: ConversationCodeComment[]) => void;
  onFullWidthChange: (value: boolean) => void;
  onClose: () => void;
}) {
  /** 当前界面的中英文文案。 */
  const zh = props.language === 'zh-CN';
  /** 每次切换文件将焦点移到当前文件标签。 */
  const titleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, [props.request]);
  /** 文件标签使用本次预览返回的名称，加载前使用已有展示路径。 */
  function renderHeader(item: FilePreviewItem | null) {
    /** 标题只读取展示信息，不用路径申请额外文件授权。 */
    const name = item?.name ?? basename(props.commentPath ?? ('path' in props.request ? props.request.path : zh ? '文件审阅' : 'File review'));
    /** 文件审阅复用源码标签的尺寸、关闭入口和键盘焦点样式。 */
    const header = (
      <header className="session-context-workspace-header session-source-header">
        <div className="session-source-tabs zeus-workspace-tabs" role="tablist" aria-label={zh ? '已打开文件' : 'Open files'}>
          <div className="zeus-workspace-tab-shell" data-active="true">
            <Button unstyled type="button" role="tab" aria-selected="true" className="zeus-workspace-tab" ref={titleRef} data-icon-tooltip={name}>
              <FileTypeIcon name={name} />
              <span data-file-status={item?.review?.status}>{name}</span>
            </Button>
            <Button unstyled type="button" className="zeus-workspace-tab-close" aria-label={`${zh ? '关闭' : 'Close'} ${name}`} data-icon-tooltip={`${zh ? '关闭' : 'Close'} ${name}`} onClick={props.onClose}>
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>
        <nav aria-label={zh ? '文件审阅操作' : 'File review actions'}>
          <Button
            unstyled
            type="button"
            disabled={!props.canSplit}
            data-icon-tooltip={!props.canSplit ? (zh ? '窗口较窄，已自动全宽显示' : 'This window is too narrow for split view') : props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            aria-label={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            onClick={() => props.onFullWidthChange(!props.fullWidth)}
          >
            {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
          </Button>
        </nav>
      </header>
    );
    return props.toolbarHost ? createPortal(header, props.toolbarHost) : header;
  }
  return (
    <section className="session-context-workspace session-source-workspace" aria-label={zh ? '文件审阅' : 'File review'}>
      <FilePreview request={props.request} location={props.location} zh={zh} renderHeader={renderHeader} commentPath={props.commentPath} comments={props.comments} onCommentsChange={props.onCommentsChange} />
    </section>
  );
}
