import { createContext, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { detectSourceLanguage, userFacingErrorCause, type FilePreviewItem, type FilePreviewRequest, type FileReview, type ConversationFileLocation, type UserFacingErrorCause } from '@zeus/shared';
import { ModalPortal } from '../ui/ModalPortal.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import './filePreview.css';
import { CodeReviewTextContext } from './codeReviewContext.js';

/** 会话统一选择预览容器：图片可用弹窗，其他文件进入右侧审阅。 */
export const FilePreviewOpenContext = createContext<((request: FilePreviewRequest, image?: boolean) => void) | null>(null);

/** 文本编辑器仅在真正查看文本时加载。 */
const CodeEditor = lazy(() => import('./CodeEditor.js').then((module) => ({ default: module.CodeEditor })));
/** Git 差异按需加载 Monaco 审阅视图。 */
const CodeDiffView = lazy(() => import('./CodeDiffView.js').then((module) => ({ default: module.CodeDiffView })));
/** Markdown 沿用受限渲染器，不加载任意活动 HTML。 */
const Markdown = lazy(() => import('../session/ConversationMarkdown.js').then((module) => ({ default: module.ConversationMarkdown })));

/** 两类文件审阅共用切换入口；带行号先定位源码，普通打开优先查看差异。 */
export function FileReviewContent(props: { review?: FileReview; zh: boolean; children: ReactNode }) {
  /** 用户选择只影响本次打开的文件。 */
  const [showDiff, setShowDiff] = useState(Boolean(props.review?.diff && !props.review.location?.line));
  useEffect(() => {
    // 再次点击同一引用也回到源码，不能停留在上次切换的差异页。
    if (props.review?.location?.line) setShowDiff(false);
  }, [props.review?.location]);
  return (
    <>
      {props.review?.diff ? (
        <nav className="file-preview-toolbar" aria-label={props.zh ? 'Git 差异与源码' : 'Git diff and source'}>
          <button type="button" aria-pressed={showDiff} onClick={() => setShowDiff(true)}>
            {props.zh ? 'Git 差异' : 'Git diff'}
          </button>
          <button type="button" aria-pressed={!showDiff} onClick={() => setShowDiff(false)}>
            {props.zh ? '源码' : 'Source'}
          </button>
          <span>{props.zh ? 'HEAD → 当前文件（含暂存与未暂存）' : 'HEAD → Current file (staged and unstaged)'}</span>
        </nav>
      ) : props.review?.diff === null ? (
        <p role="status">{props.zh ? '与 HEAD 相同，无 Git 差异。' : 'No Git diff from HEAD.'}</p>
      ) : null}
      {props.review?.error ? (
        <p role="status">
          {props.zh ? 'Git 差异读取失败：' : 'Could not read Git diff: '}
          {props.review.error}
        </p>
      ) : null}
      {showDiff && props.review?.diff ? (
        <Suspense fallback={<p role="status">{props.zh ? '正在打开差异…' : 'Opening diff…'}</p>}>
          <CodeDiffView file={props.review.diff} unified label={props.zh ? '文件 Git 差异' : 'File Git diff'} />
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
  children?: ReactNode;
  /** 外部已知的修订用于显式刷新当前文件。 */
  revision?: string | number;
}) {
  /** 序列化的请求避免父组件重渲染触发重复读取。 */
  const identity = JSON.stringify(props.request);
  return (
    <FilePreviewBody key={`${identity}:${JSON.stringify(props.location)}:${props.revision ?? ''}`} identity={identity} location={props.location} zh={props.zh}>
      {props.children}
    </FilePreviewBody>
  );
}

/** 一个挂载周期只对应一个文件身份。 */
function FilePreviewBody(props: { location?: ConversationFileLocation; identity: string; zh: boolean; children?: ReactNode; /** 弹窗提供关闭动作，单张图片据此使用纯预览布局。 */ onClose?: () => void }) {
  /** 资源读取完成前不复用旧文件的内容。 */
  const [items, setItems] = useState<FilePreviewItem[] | null>(null);
  /** 本次操作的可见错误。 */
  const [error, setError] = useState<UserFacingErrorCause | string>('');
  /** 用户主动刷新次数。 */
  const [attempt, setAttempt] = useState(0);
  /** 当前选择的版本侧。 */
  const [selected, setSelected] = useState(1);
  /** 当前差异或内容展示方式。 */
  const [mode, setMode] = useState<'auto' | 'preview' | 'diff'>('auto');
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
      .loadFilePreview(JSON.parse(props.identity) as FilePreviewRequest)
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
  }, [props.identity, props.zh, attempt]);
  /** 文字默认差异；有媒体时优先展示实际内容。 */
  const textOnly = items?.some((item) => item.kind === 'text') && items.every((item) => item.kind === 'text' || item.kind === 'unavailable');
  /** 按文件类型和用户选择确定当前视图。 */
  const showDiff = Boolean(props.children) && (mode === 'diff' || (mode === 'auto' && textOnly));
  // 无法读取的版本不能推断为空；仅在两端文本都可用时提供完整内容。
  const reviewText = useMemo(() => (items?.length === 2 && items.every((item) => item.kind === 'text') ? { original: items[0]!.content ?? '', modified: items[1]!.content ?? '' } : null), [items]);
  /** 图片两端使用并排展示。 */
  const images = items && items.length === 2 && items.some((item) => item.kind === 'image') && items.every((item) => item.kind === 'image' || item.kind === 'unavailable');
  /** 当前可用版本侧。 */
  const current = items?.[Math.min(selected, items.length - 1)];
  /** 只精简单图弹窗，仓库内容、版本对比与其他文件仍使用完整操作。 */
  const simpleImage = Boolean(props.onClose && items?.length === 1 && current?.kind === 'image' && current.url);
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
  return (
    <section className={`file-preview${simpleImage ? ' file-preview-simple-image' : ''}`} aria-label={props.zh ? '文件预览' : 'File preview'}>
      {props.onClose ? (
        <header className="file-preview-dialog-header">
          <strong>{simpleImage ? (props.zh ? '图片预览' : 'Image preview') : props.zh ? '文件预览' : 'File preview'}</strong>
          {simpleImage ? <span title={current?.name}>{current?.name}</span> : null}
          <button type="button" className="file-preview-close" aria-label={props.zh ? '关闭' : 'Close'} title={props.zh ? '关闭' : 'Close'} onClick={props.onClose}>
            <XIcon size={18} aria-hidden="true" />
          </button>
        </header>
      ) : null}
      {!simpleImage || error ? (
        <nav className="file-preview-toolbar" aria-label={props.zh ? '预览操作' : 'Preview actions'}>
          {props.children ? (
            <>
              <button type="button" aria-pressed={showDiff} onClick={() => setMode('diff')}>
                {props.zh ? '差异' : 'Diff'}
              </button>
              <button type="button" aria-pressed={!showDiff} onClick={() => setMode('preview')}>
                {props.zh ? '内容预览' : 'Preview'}
              </button>
            </>
          ) : null}
          {!showDiff && !images && items && items.length > 1
            ? items.map((item, index) => (
                <button key={index} type="button" aria-pressed={current === item} onClick={() => setSelected(index)}>
                  {item.label}
                </button>
              ))
            : null}
          {attachment.kind === 'attachment' && items?.every((item) => item.kind === 'unavailable') ? (
            <button type="button" onClick={() => void openAttachment()}>
              {props.zh ? '打开附件' : 'Open attachment'}
            </button>
          ) : null}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            {error ? (props.zh ? '重试' : 'Retry') : props.zh ? '刷新' : 'Refresh'}
          </button>
        </nav>
      ) : null}
      {showDiff ? (
        <CodeReviewTextContext.Provider value={reviewText}>{props.children}</CodeReviewTextContext.Provider>
      ) : error ? (
        <p role="alert">{simpleImage && typeof error === 'string' ? error : <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} />}</p>
      ) : !items ? (
        <p role="status">{props.zh ? '正在读取文件…' : 'Loading file…'}</p>
      ) : simpleImage && current?.url ? (
        <PreviewImage url={current.url} name={current.name} zh={props.zh} compact onError={() => setError(props.zh ? '图片已损坏或无法解码，请重试。' : 'The image could not be decoded. Please retry.')} />
      ) : (
        <div className={images ? 'file-preview-pair' : 'file-preview-single'}>
          {(images ? items : current ? [current] : []).map((item, index) => (
            <FilePreviewContent key={`${item.id}:${index}:${item.label}`} item={props.location ? { ...item, review: { ...item.review, location: props.location } } : item} zh={props.zh} />
          ))}
        </div>
      )}
    </section>
  );
}

/** 可复用的透明背景图片视图，支持原尺寸与放大检查小图标。 */
export function PreviewImage(props: { url: string; name: string; zh: boolean; onError?: () => void; /** 单图弹窗将尺寸和缩放收在底部一行。 */ compact?: boolean }) {
  /** 零代表适应窗口，正值代表原尺寸倍率。 */
  const [zoom, setZoom] = useState(0);
  /** 解码后的真实像素尺寸。 */
  const [dimensions, setDimensions] = useState('');
  /** 记录当前图片解码失败。 */
  const [failed, setFailed] = useState(false);
  return (
    <div className={`file-preview-image${props.compact ? ' file-preview-image-compact' : ''}`}>
      <div className="file-preview-toolbar" role="group" aria-label={props.zh ? '图片缩放' : 'Image zoom'}>
        <span>{dimensions}</span>
        {props.compact ? (
          <button type="button" title={zoom ? (props.zh ? '适应窗口' : 'Fit') : props.zh ? '原始尺寸' : 'Actual size'} onClick={() => setZoom(zoom ? 0 : 1)}>
            {zoom ? `${zoom * 100}%` : props.zh ? '适应窗口' : 'Fit'}
          </button>
        ) : (
          <>
            <button type="button" aria-pressed={zoom === 0} onClick={() => setZoom(0)}>
              {props.zh ? '适应窗口' : 'Fit'}
            </button>
            <button type="button" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>
              {props.zh ? '原始尺寸' : 'Actual size'}
            </button>
          </>
        )}
        <button type="button" aria-label={props.zh ? '缩小' : 'Zoom out'} onClick={() => setZoom((value) => Math.max(0.25, (value || 1) / 2))}>
          −
        </button>
        <button type="button" aria-label={props.zh ? '放大' : 'Zoom in'} onClick={() => setZoom((value) => Math.min(16, (value || 1) * 2))}>
          +
        </button>
        {zoom && !props.compact ? <span>{zoom * 100}%</span> : null}
      </div>
      <div className="file-preview-checker">
        {failed ? (
          <p role="alert">{props.zh ? '图片已损坏或无法解码。请尝试系统预览。' : 'The image could not be decoded. Try system preview.'}</p>
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
function FilePreviewContent(props: { item: FilePreviewItem; zh: boolean }) {
  /** 当前已授权的文件描述。 */
  const item = props.item;
  /** 用户选择的源码展示状态。 */
  const [source, setSource] = useState(Boolean(item.review?.location?.line));
  /** 本次操作的可见错误。 */
  const [error, setError] = useState<UserFacingErrorCause | string>('');
  /** Markdown 使用已有受限阅读组件。 */
  const markdown = /\.(md|markdown)$/iu.test(item.name);
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
      <header>
        <strong title={item.name}>{item.name}</strong>
        <small>
          {item.label} · {item.mime} · {item.byteLength.toLocaleString()} B
        </small>
      </header>
      {item.id ? (
        <div className="file-preview-toolbar">
          {(markdown || item.mime === 'image/svg+xml') && item.content !== undefined ? (
            <button type="button" aria-pressed={source} onClick={() => setSource(!source)}>
              {source ? (props.zh ? '查看效果' : 'Rendered') : props.zh ? '查看源码' : 'Source'}
            </button>
          ) : null}
          <button type="button" onClick={() => void action('quick-look')}>
            {props.zh ? '系统预览' : 'Quick Look'}
          </button>
          <button type="button" onClick={() => void action('open')}>
            {props.zh ? '打开文件' : 'Open'}
          </button>
          <button type="button" onClick={() => void action('reveal')}>
            {props.zh ? '定位文件' : 'Reveal'}
          </button>
          <button type="button" onClick={() => void action('export')}>
            {props.zh ? '导出此版本' : 'Export version'}
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert">
          <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      {item.reason ? <p role="status">{item.reason}</p> : item.id && item.byteLength === 0 ? <p role="status">{props.zh ? '此版本是空文件。' : 'This version is an empty file.'}</p> : null}
      <FileReviewContent review={item.kind === 'text' ? item.review : undefined} zh={props.zh}>
        {(item.kind === 'text' || source) && item.content !== undefined ? (
          <Suspense fallback={<p role="status">{props.zh ? '正在打开文本…' : 'Opening text…'}</p>}>
            {markdown && !source ? (
              <div className="file-preview-markdown">
                <Markdown text={item.content} streamId={item.id} phase="final" language={props.zh ? 'zh-CN' : 'en-US'} />
              </div>
            ) : (
              <div className="file-preview-text">
                <CodeEditor path={item.name} label={item.name} language={detectSourceLanguage(item.name)} content={item.content} revealLine={item.review?.location?.line} readOnly />
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
            onError={() => setError(props.zh ? 'PDF 阅读器加载失败，请使用系统预览。' : 'PDF viewer failed. Try Quick Look.')}
          />
        ) : item.kind === 'audio' && item.url ? (
          <audio controls preload="metadata" src={item.url} aria-label={item.name} onError={() => setError(props.zh ? '音频无法解码，请使用系统预览。' : 'Audio could not be decoded.')} />
        ) : item.kind === 'video' && item.url ? (
          <video controls preload="metadata" src={item.url} aria-label={item.name} onError={() => setError(props.zh ? '视频无法解码，请使用系统预览。' : 'Video could not be decoded.')} />
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
    <ModalPortal rootClassName="file-preview-portal" onDismiss={props.onClose} role="dialog" aria-label={props.zh ? '文件预览' : 'File preview'}>
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
