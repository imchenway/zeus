import { useWindowDocument } from '../ui/windowDocument.js';
import { createContext, lazy, Suspense, useEffect, useMemo, useState, useRef, useCallback, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ReadingStateScope, useReadingScroll, useReadingState } from '../ui/readingState.js';
import { isMacOSPlatform } from '../platform.js';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { ArrowsInSimpleIcon as ArrowsInSimple } from '@phosphor-icons/react/dist/csr/ArrowsInSimple';
import { ArrowsOutSimpleIcon as ArrowsOutSimple } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { EyeIcon as Eye } from '@phosphor-icons/react/dist/csr/Eye';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { GitDiffIcon as GitDiff } from '@phosphor-icons/react/dist/csr/GitDiff';
import { MinusIcon as Minus } from '@phosphor-icons/react/dist/csr/Minus';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import {
  sourceLanguageOptions,
  filePreviewTextEncodings,
  type FilePreviewTextEncoding,
  detectSourceLanguage,
  userFacingErrorCause,
  type FilePreviewItem,
  type FilePreviewRequest,
  type FilePreviewChangeRange,
  type FileReview,
  type ConversationFileLocation,
  type ConversationCodeComment,
  type ConversationCodeCommentSide,
  type UserFacingErrorCause,
} from '@zeus/shared';
import { ModalPortal } from '../ui/ModalPortal.js';
import { Button } from '../ui/Button.js';
import { VisibleApplicationError, reportApplicationError } from '../ui/ApplicationErrorDialog.js';
import { FileTypeIcon } from './FileTypeIcon.js';
import { sourceLocationDecorations } from './sourceLocationDecorations.js';
import './filePreview.css';
import { useFilePreviewDraft } from './useFilePreviewDraft.js';
import { useGitBlame } from './useGitBlame.js';

/** 会话统一选择预览容器：图片可用弹窗，其他文件进入右侧审阅。 */
export const FilePreviewOpenContext = createContext<((request: FilePreviewRequest, image?: boolean) => void) | null>(null);
/** 文本差异复用已经读取的准确前后版本，不重复申请文件或改变授权范围。 */
export const FilePreviewDataContext = createContext<{
  /** 已授权的两端内容与显示偏好。 */
  items: FilePreviewItem[] | null;
  full: boolean;
  zh: boolean;
  unified: boolean;
  /** 本页恢复后按新快照重建差异。 */
  reverted?: boolean;
  /** 可写当前版本的草稿与保存状态，历史侧仍只读。 */
  editing?: ReturnType<typeof useFilePreviewDraft>;
  /** 只有工作区配对授权可写；调用期间由共享 Diff 阻止重复操作。 */
  onRevert?: (range: FilePreviewChangeRange) => Promise<void>;
  /** 工具栏放入现有标题行，避免重复占用垂直空间。 */
  toolbarTarget: HTMLElement | null;
  onFullChange: (full: boolean) => void;
  onUnifiedChange: (unified: boolean) => void;
  onPreview: () => void;
  onRefresh: () => void;
} | null>(null);

/** 文本编辑器仅在真正查看文本时加载。 */
const CodeEditor = lazy(() => import('./CodeEditor.js').then((module) => ({ default: module.CodeEditor })));
/** Git 差异继续使用既有的虚拟化增删行视图。 */
const CodeDiffView = lazy(() => import('./CodeDiffView.js').then((module) => ({ default: module.CodeDiffView })));
/** Markdown 沿用受限渲染器，不加载任意活动 HTML。 */
const Markdown = lazy(() => import('../session/ConversationMarkdown.js').then((module) => ({ default: module.ConversationMarkdown })));
/** 只有会话文件允许评论时才加载评论编辑器和门户。 */
const CommentableSourceCodePreview = lazy(() => import('../session/CommentableSourceCodePreview.js').then((module) => ({ default: module.CommentableSourceCodePreview })));

/** 图标按钮只接受一个功能名称，同时用于悬浮提示和无障碍名称。 */
export function PreviewIconButton({
  label,
  children,
  tooltip = true,
  ...buttonProps
}: { label: string; children: ReactNode; /** 保留调用接口；普通图标与常见操作现在共用延迟提示。 */ tooltip?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'className' | 'title' | 'type'>) {
  // 不把提示样式参数透传给原生按钮，所有已有提示使用统一气泡。
  void tooltip;
  return (
    <button {...buttonProps} className="file-preview-icon-button" type="button" aria-label={label} data-icon-tooltip={label}>
      {children}
    </button>
  );
}

/** 已经有独立源码预览的页面按需申请编辑目标，不提前重复读取整份文件。 */
export function FileSourceEditButton(props: { request: FilePreviewRequest; zh: boolean }) {
  /** 等待源码页导航时禁止重复申请。 */
  const [busy, setBusy] = useState(false);
  /** 源码页保存独立授权后立即释放本次临时预览。 */
  async function openEditor() {
    if (!window.zeus || busy) return;
    setBusy(true);
    /** 释放的令牌只来自本次操作，不影响原页面预览。 */
    let ids: string[] = [];
    try {
      /** 主进程重新检查当前文件存在性和工作区边界。 */
      const items = await window.zeus.loadFilePreview(props.request);
      ids = items.map((item) => item.id).filter(Boolean);
      /** 历史比较优先定位右侧当前工作区。 */
      const item = items.findLast((candidate) => candidate.canEdit);
      if (!item) throw new Error(props.zh ? '此文件没有可编辑的工作区版本。' : 'No editable workspace file is available.');
      await window.zeus.actOnFilePreview(item.id, 'edit');
    } catch (error) {
      reportApplicationError(error, { language: props.zh ? 'zh-CN' : 'en' });
    } finally {
      if (ids.length) await window.zeus.releaseFilePreview(ids).catch(() => undefined);
      setBusy(false);
    }
  }
  return (
    <PreviewIconButton label={props.zh ? '编辑工作区文件' : 'Edit workspace file'} disabled={busy} onClick={() => void openEditor()}>
      <PencilSimple size={16} aria-hidden="true" />
    </PreviewIconButton>
  );
}

/** 打开引用先阅读文件；有 Git 改动时通过标准按钮进入比较，读取失败仍保留说明。 */
export function FileReviewContent(props: {
  review?: FileReview;
  zh: boolean;
  /** 工具栏搜索时先显示完整源码，再由源码编辑器打开查找。 */
  sourceRequest?: number;
  /** 会话源码对比时使用同一资源授权读取前后全文。 */
  previewRequest?: FilePreviewRequest;
  /** 保存比较中的当前版本后，所属源码预览重新读取正文。 */
  onSaved?: () => void | Promise<void>;
  /** 审阅操作并入调用方的文件工具栏，不再生成独立一行。 */
  toolbar: (actions: ReactNode) => ReactNode;
  children: ReactNode;
}) {
  /** 文件内容是默认入口，只有用户主动查看改动才显示差异。 */
  const [showDiff, setShowDiff] = useReadingState(`review-diff:${JSON.stringify(props.review?.location)}`, false);
  /** 恢复同一个行号入口时不覆盖之后手动选择的比较模式。 */
  const initialLocation = useRef(props.review?.location).current;
  useEffect(() => {
    // 再次点击同一引用也回到源码，不能停留在上次切换的差异页。
    if (props.review?.location?.line && props.review.location !== initialLocation) setShowDiff(false);
  }, [props.review?.location]);
  useEffect(() => {
    // 搜索当前文件必须挂载源码，不能继续停在差异编辑器。
    if (props.sourceRequest) setShowDiff(false);
  }, [props.sourceRequest]);
  return (
    <>
      {props.toolbar(
        props.review?.diff ? (
          <>
            <Button
              size="compact"
              title={showDiff ? (props.zh ? '返回文件内容' : 'Back to file content') : props.zh ? '与上次提交比较（含暂存与未暂存改动）' : 'Compare with the last commit (staged and unstaged changes)'}
              onClick={() => setShowDiff(!showDiff)}
            >
              {showDiff ? <FileCode aria-hidden="true" /> : <GitDiff aria-hidden="true" />}
              {showDiff ? (props.zh ? '返回文件' : 'Back to file') : props.zh ? '查看改动' : 'View changes'}
            </Button>
            <span className="file-review-stats">
              <span className="is-addition" aria-label={`${props.zh ? '新增行数' : 'Added lines'}: ${props.review.diff.addedLines}`}>
                +{props.review.diff.addedLines}
              </span>
              <span className="is-deletion" aria-label={`${props.zh ? '删除行数' : 'Deleted lines'}: ${props.review.diff.deletedLines}`}>
                −{props.review.diff.deletedLines}
              </span>
            </span>
          </>
        ) : null,
      )}
      {props.review?.error ? (
        <p role="status">
          {props.zh ? 'Git 差异读取失败：' : 'Could not read Git diff: '}
          {props.review.error}
        </p>
      ) : null}
      {showDiff && props.review?.diff ? (
        <Suspense fallback={null}>
          {props.previewRequest ? (
            <FilePreview request={props.previewRequest} zh={props.zh} onSaved={props.onSaved}>
              <CodeDiffView file={props.review.diff} unified label={props.zh ? '文件 Git 差异' : 'File Git diff'} />
            </FilePreview>
          ) : (
            <CodeDiffView file={props.review.diff} unified label={props.zh ? '文件 Git 差异' : 'File Git diff'} />
          )}
        </Suspense>
      ) : (
        props.children
      )}
    </>
  );
}

/** 所有文件入口共用加载、版本选择、失败重试和令牌释放。 */
export function FilePreview(props: {
  /** 业务身份同时作为缓存与异步隔离边界。 */
  request: FilePreviewRequest;
  /** 每次点击独立的位置，不作为文件读取权限发送。 */
  location?: ConversationFileLocation;
  /** 中英文文案。 */
  zh: boolean;
  /** 文本继续复用原差异与评论界面。 */
  children?: ReactNode | ((toolbar: ReactNode, items: FilePreviewItem[] | null) => ReactNode);
  /** 调用方已有的关闭等操作并入预览工具栏。 */
  actions?: ReactNode;
  /** Git 比较已知的变更状态同时用于媒体文件名称。 */
  fileStatus?: string;
  /** 外部已知的修订用于显式刷新当前文件。 */
  revision?: string | number;
  /** 文件保存成功后由所属页面刷新文件列表与统计。 */
  onSaved?: () => void | Promise<void>;
  /** 会话评论使用的稳定文件路径，附件缺省使用预览名称。 */
  commentPath?: string;
  /** 当前会话全部代码评论。 */
  comments?: ConversationCodeComment[];
  /** 缺省表示只读预览，不展示逐行评论入口。 */
  onCommentsChange?: (comments: ConversationCodeComment[]) => void;
}) {
  /** 序列化的请求避免父组件重渲染触发重复读取。 */
  const identity = JSON.stringify(props.request);
  return (
    <ReadingStateScope id={`${identity}:${JSON.stringify(props.location)}:${props.revision ?? ''}`}>
      <FilePreviewBody
        key={`${identity}:${JSON.stringify(props.location)}:${props.revision ?? ''}`}
        identity={identity}
        location={props.location}
        zh={props.zh}
        actions={props.actions}
        fileStatus={props.fileStatus}
        commentPath={props.commentPath}
        comments={props.comments}
        onCommentsChange={props.onCommentsChange}
        onSaved={props.onSaved}
      >
        {props.children}
      </FilePreviewBody>
    </ReadingStateScope>
  );
}

/** 一个挂载周期只对应一个文件身份。 */
function FilePreviewBody(props: {
  location?: ConversationFileLocation;
  identity: string;
  zh: boolean;
  children?: ReactNode | ((toolbar: ReactNode, items: FilePreviewItem[] | null) => ReactNode);
  /** 嵌入预览的附加操作。 */ actions?: ReactNode;
  /** 文件的实际 Git 变更状态。 */ fileStatus?: string;
  /** 弹窗提供关闭动作，单张图片据此使用纯预览布局。 */ onClose?: () => void;
  /** 会话评论使用的稳定文件路径。 */ commentPath?: string;
  /** 当前会话全部代码评论。 */ comments?: ConversationCodeComment[];
  /** 缺省表示只读预览，不展示逐行评论入口。 */ onCommentsChange?: (comments: ConversationCodeComment[]) => void;
  /** 正文回执已核实后通知所属页面，不把列表刷新失败当作保存失败。 */ onSaved?: () => void | Promise<void>;
}) {
  /** 系统标题栏使用当前文件名，嵌入式预览不改主工作区标题。 */
  const ownerDocument = useWindowDocument();
  /** 资源读取完成前不复用旧文件的内容。 */
  const [items, setItems] = useState<FilePreviewItem[] | null>(null);
  /** 本次操作的可见错误。 */
  const [error, setError] = useState<UserFacingErrorCause | string>('');
  /** 用户主动刷新次数。 */
  const [attempt, setAttempt] = useState(0);
  /** 编码选择仅重载只读预览，不影响源码保存。 */
  const [textEncoding, setTextEncoding] = useReadingState<FilePreviewTextEncoding | ''>('encoding', () => (JSON.parse(props.identity) as FilePreviewRequest).textEncoding ?? '');
  /** 当前选择的版本侧。 */
  const [selected, setSelected] = useReadingState('version', 1);
  /** 当前差异或内容展示方式。 */
  const [mode, setMode] = useReadingState<'auto' | 'preview' | 'diff'>('mode', 'auto');
  /** 全文只改变显示范围，不改变 Git 比较端点。 */
  const [full, setFull] = useReadingState('full', false);
  /** 布局与全文范围独立，切换范围不会重置布局。 */
  const [unified, setUnified] = useReadingState('unified', false);
  /** 实际差异组件将公共控件挂到同一标题行。 */
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    /** 卸载后拒绝迟到结果。 */
    let active = true;
    /** 本次加载需要撤销的资源令牌。 */
    let ids: string[] = [];
    /** 当前窗口的受信主进程桥接。 */
    const bridge = window.zeus;
    setItems(null);
    setError('');
    if (!bridge?.loadFilePreview) {
      setError(props.zh ? '当前环境没有文件预览服务。' : 'File preview service is unavailable.');
      return;
    }
    void bridge
      .loadFilePreview({ ...(JSON.parse(props.identity) as FilePreviewRequest), textEncoding: textEncoding || undefined })
      .then((result) => {
        ids = result.map((item) => item.id).filter(Boolean);
        if (active) setItems(result);
        else void bridge.releaseFilePreview(ids).catch(() => undefined);
      })
      .catch((cause: unknown) => {
        if (active) setError(userFacingErrorCause(cause));
      });
    return () => {
      active = false;
      if (ids.length) void bridge.releaseFilePreview(ids).catch(() => undefined);
    };
  }, [props.identity, props.zh, attempt, textEncoding]);
  /** 文字默认差异；有媒体时优先展示实际内容。 */
  const textOnly = items?.some((item) => item.kind === 'text') && items.every((item) => item.kind === 'text' || item.kind === 'unavailable');
  /** 按文件类型和用户选择确定当前视图。 */
  const showDiff = Boolean(props.children) && (mode === 'diff' || (mode === 'auto' && textOnly));
  /** 图片两端使用并排展示。 */
  const images = items && items.length === 2 && items.some((item) => item.kind === 'image') && items.every((item) => item.kind === 'image' || item.kind === 'unavailable');
  /** 当前可用版本侧。 */
  const current = items?.[Math.min(selected, items.length - 1)];
  /** 优先编辑右侧的当前工作区文件；历史版本也只能打开已授权的当前文件。 */
  const editableItem = items?.findLast((item) => item.canEdit);
  /** 完整前后端都存在或明确为空时，才允许宣称左右全文。 */
  const fullAvailable = items?.length === 2 && items.every((item) => item.missing || (item.kind === 'text' && item.content !== undefined && !item.truncated));
  /** 恢复产生的新令牌由当前预览统一管理，关闭后不遗留授权。 */
  const restoredIds = useRef<string[]>([]);
  /** 异步恢复回执不再更新已关闭的预览。 */
  const active = useRef(true);
  /** 本页正文已由恢复后的新快照接管。 */
  const [reverted, setReverted] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (restoredIds.current.length) void window.zeus?.releaseFilePreview(restoredIds.current).catch(() => undefined);
      restoredIds.current = [];
    };
  }, []);
  /** 保存与恢复回执统一接管授权，关闭后的迟到结果立即释放。 */
  const acceptItems = useCallback(
    (result: FilePreviewItem[]) => {
      const ids = result.map((item) => item.id).filter(Boolean);
      if (!active.current) {
        void window.zeus?.releaseFilePreview(ids).catch(() => undefined);
        return;
      }
      const previous = restoredIds.current;
      restoredIds.current = ids;
      if (previous.length) void window.zeus?.releaseFilePreview(previous).catch(() => undefined);
      setReverted(true);
      setItems(result);
      void Promise.resolve()
        .then(() => props.onSaved?.())
        .catch((cause) => reportApplicationError(cause, { language: props.zh ? 'zh-CN' : 'en' }));
    },
    [props.onSaved, props.zh],
  );
  /** 草稿跨文件切换保留，重新载入仍使用主进程的新版本授权。 */
  const editing = useFilePreviewDraft(props.identity, items, acceptItems);
  /** 后端从旧侧读取替换文本，页面只传原始行范围。 */
  const revertBlock = useCallback(
    async (range: FilePreviewChangeRange) => {
      if (editing.dirty || editing.saving) throw new Error('请先保存或放弃当前草稿。');
      if (!items?.[0]?.id || !items[1]?.canRevert || !window.zeus?.revertFilePreviewBlock) throw new Error('当前差异没有可恢复的工作区版本。');
      acceptItems(await window.zeus.revertFilePreviewBlock({ ...range, beforeId: items[0].id, afterId: items[1].id }));
    },
    [items, acceptItems, editing.dirty, editing.saving],
  );
  /** 内容和显示范围通过上下文传给全部差异入口。 */
  const previewData = useMemo(
    () => ({
      items,
      reverted,
      editing,
      onRevert: items?.[1]?.canRevert && window.zeus?.revertFilePreviewBlock ? revertBlock : undefined,
      full: full && Boolean(fullAvailable),
      zh: props.zh,
      unified,
      toolbarTarget,
      onFullChange: setFull,
      onUnifiedChange: setUnified,
      onPreview: () => setMode('preview'),
      onRefresh: () => setAttempt((value) => value + 1),
    }),
    [items, reverted, editing, revertBlock, full, fullAvailable, props.zh, unified, toolbarTarget],
  );
  /** 只精简单图弹窗，仓库内容、版本对比与其他文件仍使用完整操作。 */
  const simpleImage = Boolean(props.onClose && items?.length === 1 && current?.kind === 'image' && current.url);
  useEffect(() => {
    if (props.onClose && ownerDocument !== document && current) ownerDocument.title = `${current.name} · ${props.zh ? '文件预览' : 'File preview'}`;
  }, [ownerDocument, current, props.onClose, props.zh]);
  /** 目录附件或不可解码附件仍保留既有受信打开操作。 */
  const attachment = JSON.parse(props.identity) as FilePreviewRequest;
  /** 继续通过附件凭据打开，不根据错误状态放宽路径权限。 */
  async function openAttachment() {
    if (attachment.kind !== 'attachment') return;
    try {
      if (!(await window.zeus?.openConversationInputResource(attachment))?.opened) throw new Error(props.zh ? '附件无法打开。' : 'Could not open attachment.');
    } catch (cause) {
      setError(userFacingErrorCause(cause));
    }
  }
  /** 单文件的刷新、版本切换与系统操作放在同一行；比较视图保留公共操作栏。 */
  const toolbar = (
    <>
      {showDiff ? (
        <span className="diff-review-toolbar-slot" ref={setToolbarTarget} />
      ) : props.children ? (
        <Button size="compact" onClick={() => setMode('diff')}>
          <GitDiff size={16} aria-hidden="true" />
          {props.zh ? '查看差异' : 'View changes'}
        </Button>
      ) : null}
      {!showDiff && !images && items && items.length > 1
        ? items.map((item, index) => (
            <PreviewIconButton key={index} label={item.label} aria-pressed={current === item} onClick={() => setSelected(index)}>
              {index === 0 ? <ArrowCounterClockwise size={16} aria-hidden="true" /> : <ArrowClockwise size={16} aria-hidden="true" />}
            </PreviewIconButton>
          ))
        : null}
      {attachment.kind === 'attachment' && items?.every((item) => item.kind === 'unavailable') ? (
        <PreviewIconButton label={props.zh ? '打开附件' : 'Open attachment'} onClick={() => void openAttachment()}>
          <ArrowSquareOut size={16} aria-hidden="true" />
        </PreviewIconButton>
      ) : null}
      {!showDiff ? (
        <PreviewIconButton label={error ? (props.zh ? '重试' : 'Retry') : props.zh ? '刷新' : 'Refresh'} onClick={() => setAttempt((value) => value + 1)}>
          <ArrowClockwise size={16} aria-hidden="true" />
        </PreviewIconButton>
      ) : null}
      {editableItem ? (
        <Button
          size="compact"
          disabled={editing.dirty || editing.saving}
          title={editing.dirty ? (props.zh ? '请先保存或放弃 Diff 草稿' : 'Save or discard the diff draft first') : props.zh ? '在源码页编辑工作区文件' : 'Edit workspace file in Source'}
          onClick={() => {
            void window.zeus
              ?.actOnFilePreview(editableItem.id, 'edit')
              .then(() => props.onClose?.())
              .catch((cause: unknown) => setError(userFacingErrorCause(cause)));
          }}
        >
          <PencilSimple size={16} aria-hidden="true" />
          {props.zh ? '编辑' : 'Edit'}
        </Button>
      ) : null}
      {props.actions}
    </>
  );
  return (
    <FilePreviewDataContext.Provider value={previewData}>
      <section className={`file-preview${simpleImage ? ' file-preview-simple-image' : ''}`} aria-label={props.zh ? '文件预览' : 'File preview'}>
        {props.onClose ? (
          <header className="file-preview-dialog-header">
            <strong>{simpleImage ? (props.zh ? '图片预览' : 'Image preview') : props.zh ? '文件预览' : 'File preview'}</strong>
            <button type="button" className="file-preview-close" aria-label={props.zh ? '关闭' : 'Close'} data-icon-tooltip={props.zh ? '关闭' : 'Close'} onClick={props.onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </header>
        ) : null}
        {showDiff && error ? (
          <p role="alert">
            <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} />
          </p>
        ) : null}
        {showDiff && items?.some((item) => item.truncated || (item.kind === 'unavailable' && !item.missing)) ? (
          <p role="status">{props.zh ? '部分版本不可用或已截断，无法显示两侧全文。' : 'A version is unavailable or truncated. Full-file comparison is unavailable.'}</p>
        ) : null}
        {(!simpleImage || error) && !(showDiff && typeof props.children === 'function') && (showDiff || images || !current || error) ? (
          <nav className="file-preview-toolbar" aria-label={props.zh ? '预览操作' : 'Preview actions'}>
            {toolbar}
          </nav>
        ) : null}
        {showDiff ? (
          typeof props.children === 'function' ? (
            props.children(toolbar, items)
          ) : (
            props.children
          )
        ) : error ? (
          <p role="alert">{simpleImage && typeof error === 'string' ? error : <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} />}</p>
        ) : !items ? (
          <p role="status">{props.zh ? '正在读取文件…' : 'Loading file…'}</p>
        ) : simpleImage && current?.url ? (
          <PreviewImage url={current.url} name={current.name} zh={props.zh} compact onError={() => setError(props.zh ? '图片已损坏或无法解码，请重试。' : 'The image could not be decoded. Please retry.')} />
        ) : (
          <div className={images ? 'file-preview-pair' : 'file-preview-single'}>
            {(images ? items : current ? [current] : []).map((item, index) => (
              <ReadingStateScope key={`${item.id}:${index}:${item.label}`} id={item.label}>
                <FilePreviewContent
                  onSaved={() => setAttempt((value) => value + 1)}
                  key={`${item.id}:${index}:${item.label}`}
                  item={props.location ? { ...item, review: { ...item.review, location: props.location } } : item}
                  request={attachment}
                  zh={props.zh}
                  fileStatus={props.fileStatus}
                  commentPath={props.commentPath}
                  commentSide={items.length > 1 && current === items[0] ? 'left' : 'right'}
                  comments={props.comments}
                  onCommentsChange={props.onCommentsChange}
                  encoding={textEncoding}
                  onEncodingChange={(encoding) => {
                    // 用户选择编码时保留内容预览，避免文本解码成功后跳回默认差异页。
                    setMode('preview');
                    setTextEncoding(encoding);
                  }}
                  toolbar={images ? undefined : toolbar}
                />
              </ReadingStateScope>
            ))}
          </div>
        )}
      </section>
    </FilePreviewDataContext.Provider>
  );
}

/** 可复用的透明背景图片视图，支持原尺寸与放大检查小图标。 */
export function PreviewImage(props: { url: string; name: string; zh: boolean; onError?: () => void; /** 单图弹窗将尺寸和缩放收在底部一行。 */ compact?: boolean }) {
  /** 图片原始尺寸和放大模式下保留画布内的位置。 */
  const imageScroll = useReadingScroll('image');
  /** 零代表适应窗口，正值代表原尺寸倍率。 */
  const [zoom, setZoom] = useReadingState('image-zoom', 0);
  /** 解码后的真实像素尺寸。 */
  const [dimensions, setDimensions] = useState('');
  /** 记录当前图片解码失败。 */
  const [failed, setFailed] = useState(false);
  return (
    <div className={`file-preview-image${props.compact ? ' file-preview-image-compact' : ''}`}>
      <div className="file-preview-toolbar" role="group" aria-label={props.zh ? '图片缩放' : 'Image zoom'}>
        <span>{dimensions}</span>
        {props.compact ? (
          <PreviewIconButton label={zoom ? (props.zh ? '适应窗口' : 'Fit') : props.zh ? '原始尺寸' : 'Actual size'} onClick={() => setZoom(zoom ? 0 : 1)}>
            {zoom ? <ArrowsInSimple size={18} aria-hidden="true" /> : <ArrowsOutSimple size={18} aria-hidden="true" />}
          </PreviewIconButton>
        ) : (
          <>
            <PreviewIconButton label={props.zh ? '适应窗口' : 'Fit'} aria-pressed={zoom === 0} onClick={() => setZoom(0)}>
              <ArrowsInSimple size={18} aria-hidden="true" />
            </PreviewIconButton>
            <PreviewIconButton label={props.zh ? '原始尺寸' : 'Actual size'} aria-pressed={zoom === 1} onClick={() => setZoom(1)}>
              <ArrowsOutSimple size={18} aria-hidden="true" />
            </PreviewIconButton>
          </>
        )}
        <PreviewIconButton tooltip={false} label={props.zh ? '缩小' : 'Zoom out'} onClick={() => setZoom((value) => Math.max(0.25, (value || 1) / 2))}>
          <Minus size={18} aria-hidden="true" />
        </PreviewIconButton>
        <PreviewIconButton tooltip={false} label={props.zh ? '放大' : 'Zoom in'} onClick={() => setZoom((value) => Math.min(16, (value || 1) * 2))}>
          <Plus size={18} aria-hidden="true" />
        </PreviewIconButton>
        {zoom && !props.compact ? <span>{zoom * 100}%</span> : null}
      </div>
      <div ref={imageScroll} className="file-preview-checker">
        {failed ? (
          <p role="alert">{props.zh ? '图片已损坏或无法解码。请使用“打开文件”。' : 'The image could not be decoded. Use Open to view it in a system app.'}</p>
        ) : (
          <img
            src={props.url}
            alt={props.name}
            className={zoom ? 'is-actual-size' : ''}
            style={zoom ? { zoom } : undefined}
            onLoad={(event) => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)}
            onError={() => {
              setFailed(true);
              props.onError?.();
            }}
          />
        )}
      </div>
    </div>
  );
}

/** 已授权内容和系统操作共用明确的失败状态，绝不自动打开外部应用。 */
function FilePreviewContent(props: {
  item: FilePreviewItem;
  /** 嵌套 Git 比较保存后刷新当前资源预览。 */
  onSaved: () => void;
  /** 会话资源的文件审阅继续使用原业务身份。 */
  request: FilePreviewRequest;
  zh: boolean;
  /** 比较视图提供的真实 Git 状态。 */ fileStatus?: string;
  /** 当前用户选择的解码方式。 */ encoding: FilePreviewTextEncoding | '';
  /** 会话评论使用的稳定文件路径。 */ commentPath?: string;
  /** 当前文件版本对应的评论侧。 */ commentSide: ConversationCodeCommentSide;
  /** 当前会话全部代码评论。 */ comments?: ConversationCodeComment[];
  /** 缺省表示只读预览，不展示逐行评论入口。 */ onCommentsChange?: (comments: ConversationCodeComment[]) => void;
  /** 编码切换重读已授权文件。 */ onEncodingChange(encoding: FilePreviewTextEncoding | ''): void;
  /** 单文件操作与文件元信息共用一行。 */ toolbar?: ReactNode;
}) {
  /** 当前已授权的文件描述。 */
  const item = props.item;
  /** 归属绑定预览版本令牌，不根据显示名称猜测目录。 */
  const blame = useGitBlame({ previewId: item.blame === undefined && !item.blameError ? item.id || undefined : undefined });
  /** 通用文本入口与会话源码使用同一行定位高亮，保留范围终点。 */
  const locationDecorations = useMemo(() => (item.review?.location?.line ? sourceLocationDecorations(() => item.review?.location) : []), [item.review?.location]);
  /** 自动识别可切换为已支持语法或纯文本，不改变文件正文。 */
  const [language, setLanguage] = useReadingState('language', () => detectSourceLanguage(item.name, item.content) ?? 'text'); /** 用户选择的源码展示状态。 */
  const [source, setSource] = useReadingState(`source:${item.label}`, Boolean(item.review?.location?.line));
  /** Markdown 各版本分别恢复，不使用每次加载都会变化的资源令牌。 */
  const markdownScroll = useReadingScroll(`markdown:${item.label}`);
  /** 本次操作的可见错误。 */
  const [error, setError] = useState<UserFacingErrorCause | string>('');
  /** Markdown 使用已有受限阅读组件。 */
  const markdown = /\.(md|markdown)$/iu.test(item.name);
  /** 只读会话仍展示已保存评论，可写会话同时提供评论入口。 */
  const commentsVisible = props.comments !== undefined || props.onCommentsChange !== undefined;
  /** 用户动作只发送资源令牌，主进程再次检查所属窗口与文件身份。 */
  async function action(value: 'quick-look' | 'open' | 'reveal' | 'export') {
    setError('');
    try {
      await window.zeus?.actOnFilePreview(item.id, value);
    } catch (cause) {
      setError(userFacingErrorCause(cause));
    }
  }
  return (
    <article className="file-preview-content">
      <FileReviewContent
        onSaved={props.onSaved}
        previewRequest={props.request.kind === 'resource' ? { ...props.request, comparison: 'head' } : undefined}
        review={item.kind === 'text' ? item.review : undefined}
        zh={props.zh}
        toolbar={(reviewActions) => (
          <>
            <header>
              <FileTypeIcon name={item.name} size={20} />
              <div className="file-preview-identity">
                <strong data-icon-tooltip={item.kind === 'image' ? undefined : item.name} data-file-status={props.fileStatus ?? item.review?.status ?? item.review?.diff?.changeType}>
                  {item.kind === 'image' ? (props.zh ? '图片预览' : 'Image preview') : item.name}
                </strong>
                <small>
                  {item.label} · {item.mime} · {item.byteLength.toLocaleString()} B{item.encoding ? ` · ${item.encoding.toUpperCase()}` : ''}
                </small>
              </div>
              {item.id && (item.kind === 'text' || item.mime === 'application/octet-stream' || item.mime === 'image/svg+xml') ? (
                <label className="file-preview-setting">
                  <span>{props.zh ? '编码' : 'Encoding'}</span>
                  <select aria-label={props.zh ? '预览编码' : 'Preview encoding'} value={props.encoding} onChange={(event) => props.onEncodingChange(event.currentTarget.value as FilePreviewTextEncoding | '')}>
                    <option value="">{props.zh ? '自动识别' : 'Automatic'}</option>
                    {filePreviewTextEncodings.map((encoding) => (
                      <option key={encoding} value={encoding}>
                        {encoding.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {item.content !== undefined && (item.kind === 'text' || source) ? (
                <label className="file-preview-setting">
                  <span>{props.zh ? '语言' : 'Language'}</span>
                  <select
                    aria-label={props.zh ? '预览高亮语言' : 'Preview syntax language'}
                    value={language}
                    onChange={(event) => {
                      // 阅读模式下选择高亮语言时打开源码，使语言选择立即可见。
                      setLanguage(event.currentTarget.value);
                      if (markdown) setSource(true);
                    }}
                  >
                    <option value="text">{props.zh ? '纯文本' : 'Plain text'}</option>
                    {sourceLanguageOptions.map((language) => (
                      <option key={language} value={language}>
                        {language}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {item.id || props.toolbar || reviewActions ? (
                <nav className="file-preview-toolbar" aria-label={props.zh ? '文件操作' : 'File actions'}>
                  {reviewActions}
                  {props.toolbar}
                  {item.id ? (
                    <>
                      {(markdown || item.mime === 'image/svg+xml') && item.content !== undefined ? (
                        <PreviewIconButton label={source ? (props.zh ? '查看效果' : 'Rendered') : props.zh ? '查看源码' : 'Source'} aria-pressed={source} onClick={() => setSource(!source)}>
                          {source ? <Eye size={18} aria-hidden="true" /> : <FileCode size={18} aria-hidden="true" />}
                        </PreviewIconButton>
                      ) : null}
                      {/* Quick Look 仅有 macOS 原生入口，其他系统使用相邻的打开文件操作。 */}
                      {isMacOSPlatform() ? (
                        <PreviewIconButton label={props.zh ? '系统预览' : 'Quick Look'} onClick={() => void action('quick-look')}>
                          <Eye size={18} aria-hidden="true" />
                        </PreviewIconButton>
                      ) : null}
                      <PreviewIconButton label={props.zh ? '打开文件' : 'Open'} onClick={() => void action('open')}>
                        <ArrowSquareOut size={18} aria-hidden="true" />
                      </PreviewIconButton>
                      <PreviewIconButton label={props.zh ? '定位文件' : 'Reveal'} onClick={() => void action('reveal')}>
                        <FolderOpen size={18} aria-hidden="true" />
                      </PreviewIconButton>
                      <PreviewIconButton label={props.zh ? '导出此版本' : 'Export version'} onClick={() => void action('export')}>
                        <DownloadSimple size={18} aria-hidden="true" />
                      </PreviewIconButton>
                    </>
                  ) : null}
                </nav>
              ) : null}
            </header>
            {error ? (
              <p role="alert">
                <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} />
              </p>
            ) : null}
            {item.reason ? <p role="status">{item.reason}</p> : item.id && item.byteLength === 0 ? <p role="status">{props.zh ? '此版本是空文件。' : 'This version is an empty file.'}</p> : null}
          </>
        )}
      >
        {(item.kind === 'text' || source) && item.content !== undefined ? (
          <Suspense fallback={null}>
            {markdown && !source ? (
              <div ref={markdownScroll} className="file-preview-markdown">
                <Markdown text={item.content} streamId={item.id} phase="final" language={props.zh ? 'zh-CN' : 'en-US'} documentMode />
              </div>
            ) : (
              <div className="file-preview-text">
                {commentsVisible ? (
                  <CommentableSourceCodePreview
                    key={item.id}
                    identity={`${item.id}:${item.label}`}
                    path={props.commentPath ?? item.name}
                    content={item.content}
                    blame={item.blame}
                    language={language}
                    label={item.name}
                    side={props.commentSide}
                    locale={props.zh ? 'zh-CN' : 'en-US'}
                    blameLines={item.blame ?? blame?.lines}
                    location={item.review?.location}
                    comments={props.comments}
                    onCommentsChange={props.onCommentsChange}
                  />
                ) : (
                  <CodeEditor
                    path={item.name}
                    label={item.name}
                    language={language}
                    content={item.content}
                    location={item.review?.location}
                    extensions={locationDecorations}
                    blame={item.blame ?? blame?.lines}
                    blameLocale={props.zh ? 'zh-CN' : 'en-US'}
                    blameLines={item.blame ?? blame?.lines}
                    locale={props.zh ? 'zh-CN' : 'en-US'}
                    readOnly
                  />
                )}
              </div>
            )}
          </Suspense>
        ) : item.kind === 'image' && item.url ? (
          <PreviewImage url={item.url} name={item.name} zh={props.zh} />
        ) : item.kind === 'pdf' && item.url ? (
          <iframe /* PDF 使用独立协议源隔离；HTML sandbox 会禁用 Chromium 的 PDF 阅读器。 */
            className="file-preview-pdf"
            src={item.url}
            title={item.name}
            referrerPolicy="no-referrer"
            onError={() => setError(props.zh ? 'PDF 阅读器加载失败，请使用“打开文件”。' : 'PDF viewer failed. Use Open to view it in a system app.')}
          />
        ) : item.kind === 'audio' && item.url ? (
          <audio controls preload="metadata" src={item.url} aria-label={item.name} onError={() => setError(props.zh ? '音频无法解码，请使用“打开文件”。' : 'Audio could not be decoded. Use Open to play it in a system app.')} />
        ) : item.kind === 'video' && item.url ? (
          <video controls preload="metadata" src={item.url} aria-label={item.name} onError={() => setError(props.zh ? '视频无法解码，请使用“打开文件”。' : 'Video could not be decoded. Use Open to play it in a system app.')} />
        ) : null}
      </FileReviewContent>
    </article>
  );
}

/** 文件弹窗复用产品现有焦点管理和 Escape 关闭行为。 */
export function FilePreviewDialog(props: { request: FilePreviewRequest; zh: boolean; onClose(): void }) {
  /** 弹窗与嵌入视图共用加载和释放流程，以请求身份隔离异步结果。 */
  const identity = JSON.stringify(props.request);
  return (
    <ModalPortal
      systemWindow="file-preview"
      windowActivation={identity}
      windowTitle={props.zh ? '文件预览' : 'File preview'}
      rootClassName="file-preview-portal"
      onDismiss={props.onClose}
      role="dialog"
      aria-label={props.zh ? '文件预览' : 'File preview'}
    >
      <section className="file-preview-dialog" data-modal-surface="dialog">
        <FilePreviewBody key={identity} identity={identity} zh={props.zh} onClose={props.onClose} />
      </section>
    </ModalPortal>
  );
}

/** 无文本片段时明确说明已知变更类型，不能从空补丁推断二进制内容。 */
export function fileDiffEmptyMessage(file: { changeType: string; oldPath: string; newPath: string }, zh: boolean): string {
  if (file.changeType === 'added') return zh ? '新增文件，没有文本行变化；内容预览可查看文件。' : 'Added file with no changed text lines. Open the content preview.';
  if (file.changeType === 'deleted') return zh ? '文件已删除；内容预览可查看变更前版本。' : 'Deleted file. Preview the previous version.';
  if (file.changeType === 'renamed') return zh ? `文件已重命名：${file.oldPath} → ${file.newPath}，没有文本行变化。` : `Renamed: ${file.oldPath} → ${file.newPath}; no changed text lines.`;
  if (file.changeType === 'copied') return zh ? `文件已复制：${file.oldPath} → ${file.newPath}。` : `Copied: ${file.oldPath} → ${file.newPath}.`;
  return zh ? '文件发生变化，但没有文本行变化；内容预览可检查文件，属性变化不产生文本差异。' : 'The file changed without changed text lines. Preview its content; attribute changes have no text diff.';
}
