import { useWindowDocument } from '../ui/windowDocument.js';
import { FilePreviewDialog, FilePreviewOpenContext } from '../code/FilePreview.js';
import { prepareFilePreview } from '../code/preparedFilePreview.js';
import { VideoPlayer } from '../code/VideoPlayer.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { useMotionPresence } from '../ui/useMotionPresence.js';
import { type CSSProperties, type KeyboardEvent, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import { GithubLogoIcon as GithubLogo } from '@phosphor-icons/react/dist/csr/GithubLogo';
import { AppWindowIcon as AppWindow } from '@phosphor-icons/react/dist/csr/AppWindow';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
import type { ConversationFileIconKind, ConversationFileLocation, ConversationOpenTarget, ConversationResource, ConversationResourceOpenTarget, ConversationResourcePreview } from '@zeus/shared';
import { filePreviewKind, filePreviewMime, userFacingErrorCause } from '@zeus/shared';
import { listConversationResourceOpenTargetsInMain } from '../appShellBridge.js';
import type { NativeConversationAttachment } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ResourceLoading } from '../ui/ResourceLoading.js';
import { pendingResourceDisplayName } from '../ui/pendingResourcePolicy.js';
import { Button } from '../ui/Button.js';

/** 图片回到虚拟窗口时复用预览地址、解码状态和固有尺寸。 */
interface CachedConversationImage {
  dataUrl: string;
  width?: number;
  height?: number;
  decoded?: boolean;
}

/** 当前窗口最多保留 32 张、64 MiB 的图片地址，避免长会话无限持有 Base64。 */
const conversationImageCacheLimit = 32;
/** 图片地址按 UTF-16 字符占用估算，单位为字节。 */
const conversationImageCacheByteLimit = 64 * 1024 * 1024;
/** 项目、会话、资源修订隔离图片；待登记附件使用完整受控引用。 */
const conversationImageCache = new Map<string, CachedConversationImage>();
/** 同一图片在多个位置挂载时共用一次正在进行的受控读取。 */
const pendingConversationImages = new Map<string, Promise<CachedConversationImage | null>>();
/** 当前缓存中图片地址的估算字节数。 */
let conversationImageCacheBytes = 0;

/** 命中的预览移到最近使用位置，不缓存读取或解码失败。 */
function cachedConversationImage(key: string): CachedConversationImage | null {
  const image = conversationImageCache.get(key);
  if (!image) return null;
  conversationImageCache.delete(key);
  conversationImageCache.set(key, image);
  return image;
}

/** 超出容量的大图只在当前组件使用，其余预览按最近使用顺序淘汰。 */
function rememberConversationImage(key: string, image: CachedConversationImage): CachedConversationImage {
  forgetConversationImage(key);
  if (image.dataUrl.length * 2 > conversationImageCacheByteLimit) return image;
  conversationImageCache.set(key, image);
  conversationImageCacheBytes += image.dataUrl.length * 2;
  while (conversationImageCache.size > conversationImageCacheLimit || conversationImageCacheBytes > conversationImageCacheByteLimit) forgetConversationImage(conversationImageCache.keys().next().value!);
  return image;
}

/** 失败和显式重试均移除旧预览，下一次仍经过原授权读取入口。 */
function forgetConversationImage(key: string): void {
  const previous = conversationImageCache.get(key);
  if (previous) conversationImageCacheBytes -= previous.dataUrl.length * 2;
  conversationImageCache.delete(key);
}

/** 虚拟行卸载不取消共享读取；失败不留缓存，用户可沿用原入口重试。 */
function loadCachedConversationImage(key: string, load: () => Promise<string | null>): Promise<CachedConversationImage | null> {
  const cached = cachedConversationImage(key);
  if (cached) return Promise.resolve(cached);
  const pending = pendingConversationImages.get(key);
  if (pending) return pending;
  const request = load()
    .then((dataUrl) => (dataUrl ? rememberConversationImage(key, { dataUrl }) : null))
    .finally(() => pendingConversationImages.delete(key));
  pendingConversationImages.set(key, request);
  return request;
}

/** 记录浏览器确认的尺寸，重新挂载第一帧即可保留图片比例。 */
function decodedConversationImage(key: string, preview: CachedConversationImage, image: HTMLImageElement): CachedConversationImage {
  return rememberConversationImage(key, { ...preview, width: image.naturalWidth, height: image.naturalHeight, decoded: true });
}

/** 预取和缩略图按同一个修订身份共用读取和解码结果。 */
function conversationResourceImageKey(resource: ConversationResource): string {
  return JSON.stringify(['resource', resource.projectId, resource.conversationId, resource.id, resource.updatedAt]);
}

/** 预先解码受控缩略图，正式组件挂载时可直接取得图片与固有尺寸。 */
export async function preloadConversationImage(resource: ConversationResource, load: () => Promise<ConversationResourcePreview>, signal: AbortSignal): Promise<void> {
  const key = conversationResourceImageKey(resource);
  const preview = await loadCachedConversationImage(key, async () => {
    const result = await load();
    return result.kind === 'image' ? result.dataUrl : null;
  });
  if (!preview || preview.decoded || signal.aborted) return;
  const image = new Image();
  image.src = preview.dataUrl;
  await image.decode();
  if (!signal.aborted) decodedConversationImage(key, preview, image);
}

export interface ConversationResourceInteraction {
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
}

export function isPendingImageAttachment(attachment: Pick<NativeConversationAttachment, 'kind' | 'mime'>): boolean {
  return attachment.kind === 'image' || ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.mime.toLowerCase());
}

/** 待入库图片沿用本地预览；任务提示词也只显示缩略图。 */
export function ConversationPendingAttachmentImages(props: {
  attachments: NativeConversationAttachment[];
  language: SessionUiLanguage;
  onVisibleContentChange?: () => void;
  /** 任务字段在资源登记前后保持相同的附件布局。 */ compact?: boolean;
}) {
  const images = props.attachments.filter(isPendingImageAttachment);
  if (images.length === 0) return null;
  return (
    <section className="session-resource-card-list session-pending-attachment-images" data-layout="images" data-compact={props.compact || undefined} aria-label={props.language === 'zh-CN' ? '待处理图片' : 'Pending images'}>
      {images.map((attachment) => (
        <ConversationPendingAttachmentImage key={pendingAttachmentIdentity(attachment)} attachment={attachment} language={props.language} compact={props.compact} onVisibleContentChange={props.onVisibleContentChange} />
      ))}
    </section>
  );
}

/** 本地缩略图只读取已授权附件，点击沿用统一文件预览。 */
function ConversationPendingAttachmentImage(props: { attachment: NativeConversationAttachment; language: SessionUiLanguage; onVisibleContentChange?: () => void; /** 紧凑缩略图保留文件名与打开入口。 */ compact?: boolean }) {
  /** 图片由会话统一打开弹窗，独立页面沿用自身预览。 */
  const openFilePreview = useContext(FilePreviewOpenContext);
  /** 本地路径和上传引用共同隔离待登记图片。 */
  const previewKey = JSON.stringify(['pending', props.attachment.localPath, props.attachment.uploadRef]);
  const [preview, setPreview] = useState<CachedConversationImage | null>(() => cachedConversationImage(previewKey));
  const previewUrl = preview?.dataUrl ?? null;
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  /** 读取返回后等待浏览器解码，加载结束才切换为真实图片。 */
  const [decodedPreviewUrl, setDecodedPreviewUrl] = useState<string | null>(() => (preview?.decoded ? preview.dataUrl : null));
  const [previewOpen, setPreviewOpen] = useState(false);
  const identity = pendingAttachmentIdentity(props.attachment);

  useEffect(() => {
    let active = true;
    const cached = cachedConversationImage(previewKey);
    setPreview(cached);
    setDecodedPreviewUrl(cached?.decoded ? cached.dataUrl : null);
    setFailed(false);
    setPreviewOpen(false);
    if (cached) {
      setLoading(false);
      return;
    }
    const loadConversationPreview = window.zeus?.getConversationResourcePreview;
    const loadTaskPreview = window.zeus?.getTaskAttachmentPreview;
    if (!loadConversationPreview && (!props.attachment.localPath || !loadTaskPreview)) {
      setFailed(true);
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    void loadCachedConversationImage(previewKey, async () => {
      const result = await loadPendingAttachmentPreview(props.attachment, loadConversationPreview, loadTaskPreview);
      return result?.mimeType.startsWith('image/') ? result.previewUrl : null;
    })
      .then((preview) => {
        if (!active) return;
        if (!preview) {
          setFailed(true);
          return;
        }
        setPreview(preview);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [identity, previewKey, props.attachment.localPath, props.attachment.uploadRef]);

  useLayoutEffect(() => {
    props.onVisibleContentChange?.();
  }, [failed, previewUrl, decodedPreviewUrl, props.onVisibleContentChange]);

  return (
    <>
      <Button
        unstyled
        type="button"
        className="session-resource-image session-pending-attachment-image"
        aria-label={`${props.language === 'zh-CN' ? '在 Zeus 中预览' : 'Preview in Zeus'}：${props.attachment.name}`}
        aria-busy={(!failed && (loading || decodedPreviewUrl !== previewUrl)) || undefined}
        data-icon-tooltip={failed ? (props.language === 'zh-CN' ? '缩略图不可用，点击查看文件与可用操作' : 'Thumbnail unavailable. Open file preview and actions.') : props.language === 'zh-CN' ? '预览图片' : 'Preview image'}
        onClick={() => (openFilePreview ? openFilePreview({ kind: 'attachment', localPath: props.attachment.localPath, uploadRef: props.attachment.uploadRef }, true) : setPreviewOpen(true))}
      >
        {failed ? (
          <span className="session-resource-image-placeholder" role="status">
            <FileTypeIcon path={props.attachment.name} />
            <span>{props.compact ? (props.language === 'zh-CN' ? '打开' : 'Open') : props.language === 'zh-CN' ? '缩略图不可用，点击查看文件与可用操作' : 'Thumbnail unavailable. Open file preview and actions.'}</span>
          </span>
        ) : previewUrl ? (
          <>
            <img
              decoding="async"
              src={previewUrl}
              width={preview?.width}
              height={preview?.height}
              alt={props.attachment.name}
              style={decodedPreviewUrl === previewUrl ? undefined : { visibility: 'hidden' }}
              onLoad={(event) => {
                if (preview) setPreview(decodedConversationImage(previewKey, preview, event.currentTarget));
                setDecodedPreviewUrl(previewUrl);
              }}
              onError={() => {
                forgetConversationImage(previewKey);
                setFailed(true);
              }}
            />
            {decodedPreviewUrl !== previewUrl ? <ResourceLoading label={props.language === 'zh-CN' ? '正在加载图片' : 'Loading image'} /> : null}
          </>
        ) : (
          <ResourceLoading label={props.language === 'zh-CN' ? '正在加载图片' : 'Loading image'} />
        )}
      </Button>
      <MotionPresence>
        {previewOpen ? <FilePreviewDialog request={{ kind: 'attachment', localPath: props.attachment.localPath, uploadRef: props.attachment.uploadRef }} zh={props.language === 'zh-CN'} onClose={() => setPreviewOpen(false)} /> : null}
      </MotionPresence>
    </>
  );
}

function pendingAttachmentIdentity(attachment: NativeConversationAttachment): string {
  return attachment.localPath ?? attachment.uploadRef;
}

async function loadPendingAttachmentPreview(
  attachment: NativeConversationAttachment,
  loadConversationPreview: NonNullable<typeof window.zeus>['getConversationResourcePreview'] | undefined,
  loadTaskPreview: NonNullable<typeof window.zeus>['getTaskAttachmentPreview'] | undefined,
): Promise<{ previewUrl: string; mimeType: string } | null> {
  if (loadConversationPreview) {
    try {
      const preview = await loadConversationPreview({
        ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
        ...(attachment.uploadRef ? { uploadRef: attachment.uploadRef } : {}),
      });
      if (preview) return preview;
    } catch {
      // 两类附件使用独立受信目录；会话预览拒绝任务附件后继续走任务附件复验。
    }
  }
  if (!attachment.localPath || !loadTaskPreview) return null;
  return loadTaskPreview(attachment.localPath);
}

/** 消息文件引用显示真实文件名，点击仍使用登记资源和本次行号。 */
export function ConversationInlineResource(
  props: ConversationResourceInteraction & {
    resource: ConversationResource;
    label: string;
    language: SessionUiLanguage;
  },
) {
  /** 打开完成前阻止重复请求，不把处理中状态当作打开成功。 */
  const [busy, setBusy] = useState(false);
  /** 本次打开失败沿用消息中的可见错误说明。 */
  const [error, setError] = useState<unknown>(null);
  /** 文件位置使用统一英文格式，与文件名分开显示。 */
  const rawLocation = props.resource.kind === 'file' ? locationLabel(props.resource) : null;
  /** 文件引用显示真实文件名，说明性链接文字不覆盖文件身份。 */
  const label = props.resource.kind === 'file' ? props.resource.projectRelativePath.split('/').at(-1) || props.resource.displayName : props.label;
  /** 位置只追加一次，保留未带行号的普通文件引用。 */
  const location = rawLocation && !label.endsWith(rawLocation) ? rawLocation : null;
  /** 完整路径或网址作为提示，原文件名不承担访问授权。 */
  const title = props.resource.kind === 'file' ? props.resource.projectRelativePath : props.resource.kind === 'website' ? props.resource.url : props.resource.displayName;

  /** 打开沿用资源身份和当前点击的位置，不按显示名称读取文件。 */
  async function open(): Promise<void> {
    if (!props.onOpenResource || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onOpenResource(props.resource, defaultOpenTarget(props.resource), props.resource.kind === 'file' ? props.resource.location : undefined);
    } catch (openError) {
      setError(openError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="session-inline-resource-shell" data-resource-kind={props.resource.kind}>
      <Button
        unstyled
        type="button"
        className="session-inline-resource"
        data-file-path={props.resource.kind === 'file' ? props.resource.projectRelativePath : undefined}
        data-icon-tooltip={props.resource.kind === 'file' ? (props.resource.externalReference ?? label) : title}
        aria-label={`${label}${location ? ` ${location}` : ''}`}
        aria-busy={busy || undefined}
        data-error={Boolean(error) || undefined}
        onClick={() => open()}
      >
        <ResourceIcon resource={props.resource} size={14} />
        {props.resource.kind === 'file' ? '\u00a0' : null}
        <span>{label}</span>
        {location ? (
          <>
            {' '}
            <span className="session-inline-resource-location">{location}</span>
          </>
        ) : null}
      </Button>
      {error ? <VisibleApplicationError error={error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} /> : null}
    </span>
  );
}

export function ConversationMarkdownImage(
  props: ConversationResourceInteraction & {
    resource: ConversationResource;
    label: string;
    language: SessionUiLanguage;
  },
) {
  return <ConversationImagePreview {...props} className="session-markdown-image" placeholderClassName="session-markdown-image-placeholder" />;
}

export function ConversationGeneratedImage(
  props: ConversationResourceInteraction & {
    resource: ConversationResource;
    label: string;
    language: SessionUiLanguage;
    onVisibleContentChange?: () => void;
  },
) {
  return <ConversationImagePreview {...props} className="session-generated-image" placeholderClassName="session-generated-image-placeholder" />;
}

/** 图片正文和附件共用受控读取；已知的大小限制改走文件打开入口。 */
function ConversationImagePreview(
  props: ConversationResourceInteraction & {
    resource: ConversationResource;
    label: string;
    language: SessionUiLanguage;
    className: string;
    placeholderClassName: string;
    /** 附件缩略图使用简短提示，完整原因保留在悬停说明中。 */
    compact?: boolean;
    onVisibleContentChange?: () => void;
  },
) {
  const rootRef = useRef<HTMLButtonElement | null>(null);
  /** 资源更新后重新读取，不能沿用旧修订的像素和尺寸。 */
  const previewKey = conversationResourceImageKey(props.resource);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<CachedConversationImage | null>(() => cachedConversationImage(previewKey));
  const [loading, setLoading] = useState(false);
  /** 资源读取已按可见区域延迟；回执后立即解码，避免再次懒加载而停在占位。 */
  const [decodedPreviewUrl, setDecodedPreviewUrl] = useState<string | null>(() => (preview?.decoded ? preview.dataUrl : null));
  const [error, setError] = useState<unknown>(null);
  /** 重试只重新读取相同受控资源，不打开另一个窗口或改变消息位置。 */
  const [retry, setRetry] = useState(0);
  const resourceRef = useRef(props.resource);
  const languageRef = useRef(props.language);
  const loadPreviewRef = useRef(props.onLoadResourcePreview);
  const visibleContentChangeRef = useRef(props.onVisibleContentChange);
  resourceRef.current = props.resource;
  languageRef.current = props.language;
  loadPreviewRef.current = props.onLoadResourcePreview;
  visibleContentChangeRef.current = props.onVisibleContentChange;

  useLayoutEffect(() => {
    visibleContentChangeRef.current?.();
  }, [error, preview, decodedPreviewUrl]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '240px' },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    const cached = cachedConversationImage(previewKey);
    setPreview(cached);
    setDecodedPreviewUrl(cached?.decoded ? cached.dataUrl : null);
    setError(null);
    setVisible(Boolean(cached));
  }, [previewKey]);

  useEffect(() => {
    const loadPreview = loadPreviewRef.current;
    if (!visible || !loadPreview) return;
    const cached = cachedConversationImage(previewKey);
    if (cached) {
      setPreview(cached);
      setDecodedPreviewUrl(cached.decoded ? cached.dataUrl : null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void loadCachedConversationImage(previewKey, async () => {
      const result = await loadPreview(resourceRef.current);
      if (result.kind !== 'image') throw new Error(languageRef.current === 'zh-CN' ? '该资源不是可预览图片。' : 'This resource is not a previewable image.');
      return result.dataUrl;
    })
      .then((result) => {
        if (!active) return;
        setPreview(result);
      })
      .catch((loadError) => {
        if (active) reportPreviewFailure(loadError);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [previewKey, Boolean(props.onLoadResourcePreview), visible, retry]);

  /** 图片缩略图也沿用会话资源入口，不自行创建弹窗。 */
  async function open(): Promise<void> {
    try {
      await props.onOpenResource?.(props.resource, defaultOpenTarget(props.resource));
    } catch (cause) {
      reportPreviewFailure(cause);
    }
  }

  /** 解码失败不能让同一坏预览在虚拟行恢复时再次命中。 */
  function reportPreviewFailure(cause: unknown): void {
    forgetConversationImage(previewKey);
    setError(cause);
  }

  /** 超出大小限制无法靠重试恢复，仍允许打开文件和选择可用应用。 */
  const previewTooLarge = userFacingErrorCause(error).code === 'ZEUS_CONVERSATION_RESOURCE_TOO_LARGE';
  const unavailable = !loadPreviewRef.current;
  /** 小缩略图只显示可执行的简短状态，完整原因使用同一悬停说明。 */
  const compactStatus = previewTooLarge
    ? props.language === 'zh-CN'
      ? '大图'
      : 'Large'
    : error
      ? props.language === 'zh-CN'
        ? '重试'
        : 'Retry'
      : unavailable
        ? props.language === 'zh-CN'
          ? '打开'
          : 'Open'
        : props.language === 'zh-CN'
          ? '加载中'
          : 'Loading';
  const status = error
    ? formatVisibleApplicationError(error, props.language === 'zh-CN' ? 'zh-CN' : 'en')
    : unavailable
      ? props.language === 'zh-CN'
        ? '图片预览不可用'
        : 'Image preview unavailable'
      : loading || !preview
        ? props.language === 'zh-CN'
          ? '正在加载图片'
          : 'Loading image'
        : props.label;

  return (
    <Button
      unstyled
      ref={rootRef}
      type="button"
      className={props.className}
      aria-label={`${error && !previewTooLarge ? (props.language === 'zh-CN' ? '重新加载图片' : 'Retry image') : props.language === 'zh-CN' ? '在 Zeus 中预览' : 'Preview in Zeus'}：${props.label}`}
      aria-busy={(!error && !unavailable && (loading || !preview || decodedPreviewUrl !== preview.dataUrl)) || undefined}
      data-error={Boolean(error) || undefined}
      data-icon-tooltip={error ? status : props.language === 'zh-CN' ? '预览图片' : 'Preview image'}
      onClick={() => {
        setVisible(true);
        if (error && !previewTooLarge) {
          forgetConversationImage(previewKey);
          setPreview(null);
          setRetry((value) => value + 1);
          return;
        }
        return open();
      }}
    >
      {preview && !error ? (
        <>
          <img
            decoding="async"
            src={preview.dataUrl}
            width={preview.width}
            height={preview.height}
            alt={props.label}
            style={decodedPreviewUrl === preview.dataUrl ? undefined : { visibility: 'hidden' }}
            onLoad={(event) => {
              setPreview(decodedConversationImage(previewKey, preview, event.currentTarget));
              setDecodedPreviewUrl(preview.dataUrl);
            }}
            onError={() => reportPreviewFailure(languageRef.current === 'zh-CN' ? '图片预览加载失败。' : 'The image preview failed to load.')}
          />
          {decodedPreviewUrl !== preview.dataUrl ? <ResourceLoading label={status} /> : null}
        </>
      ) : error || unavailable ? (
        <span className={props.placeholderClassName} role="status">
          <ResourceIcon resource={props.resource} />
          <span>{props.compact ? compactStatus : status}</span>
          {error && !props.compact ? <span>{previewTooLarge ? (props.language === 'zh-CN' ? '点击打开' : 'Click to open') : props.language === 'zh-CN' ? '点击重试' : 'Click to retry'}</span> : null}
        </span>
      ) : (
        <ResourceLoading label={status} />
      )}
      {preview ? <span className="session-sr-only">{status}</span> : null}
    </Button>
  );
}

/** 正文视频使用短期文件预览令牌，离开虚拟行时归还授权。 */
export function ConversationResourceVideo(props: ConversationResourceInteraction & { resource: ConversationResource; language: SessionUiLanguage }) {
  /** 同一份资源修订对应一次读取，调用方以修订身份挂载播放器。 */
  const { projectId, conversationId, id: resourceId } = props.resource;
  /** 未收到文件地址时保留播放器位置，失败时恢复可打开的文件引用。 */
  const [preview, setPreview] = useState<{ url: string } | { reason?: string } | null>(null);
  /** 加载和解码失败使用会话语言，保留已有文件打开入口。 */
  const zh = props.language === 'zh-CN';
  const unavailable = zh ? '无法预览视频。' : 'Video preview is unavailable.';

  useEffect(() => {
    /** 挂载结束后，迟到的响应由共享预览读取器自动归还。 */
    let active = true;
    /** 只申请当前会话与资源编号对应的预览。 */
    const file = prepareFilePreview({ kind: 'resource', projectId, conversationId, resourceId });
    void file.read.then(
      ([item]) => {
        if (!active) return;
        setPreview(item?.kind === 'video' && item.url ? { url: item.url } : { reason: item?.reason });
      },
      () => {
        if (active) setPreview({});
      },
    );
    return () => {
      active = false;
      file.dispose();
    };
  }, [projectId, conversationId, resourceId]);

  return (
    <div className="session-resource-video">
      {preview && 'url' in preview ? (
        <VideoPlayer key={preview.url} url={preview.url} name={props.resource.displayName} zh={zh} onError={() => setPreview({})} />
      ) : preview ? (
        <div className="session-resource-video-fallback">
          <span role="status">{preview.reason || unavailable}</span>
          <ConversationInlineResource {...props} label={props.resource.displayName} />
        </div>
      ) : (
        <div className="session-resource-video-loading" aria-busy="true">
          <ResourceLoading label={zh ? '正在读取视频' : 'Loading video'} />
        </div>
      )}
    </div>
  );
}

/** 图片只显示缩略图；助手交付的视频在会话内播放。 */
export function ConversationResourceCards(
  props: ConversationResourceInteraction & {
    resources: ConversationResource[];
    language: SessionUiLanguage;
    /** 任务字段的附件列表避免大幅挤占正文空间。 */
    compact?: boolean;
    /** 仅完整的助手消息允许资源卡展开播放器。 */
    showVideos?: boolean;
  },
) {
  const resources = props.resources.filter((resource) => resource.presentation === 'card');
  if (resources.length === 0) return null;
  const imageCount = resources.filter(isImageResource).length;
  const layout = imageCount === resources.length ? 'images' : imageCount === 0 ? 'files' : 'mixed';
  return (
    <section className="session-resource-card-list" data-layout={layout} data-compact={props.compact || undefined} aria-label={props.language === 'zh-CN' ? '会话资源' : 'Conversation resources'}>
      {resources.map((resource) =>
        isImageResource(resource) ? (
          <ConversationResourceImage key={resource.id} resource={resource} language={props.language} compact={props.compact} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
        ) : props.showVideos && props.onOpenResource && isVideoResource(resource) ? (
          <ConversationResourceVideo key={`${resource.id}:${resource.updatedAt}`} resource={resource} language={props.language} onOpenResource={props.onOpenResource} />
        ) : (
          <ConversationResourceCard key={resource.id} resource={resource} language={props.language} compact={props.compact} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
        ),
      )}
    </section>
  );
}

function ConversationResourceImage(
  props: ConversationResourceInteraction & {
    resource: ConversationResource;
    language: SessionUiLanguage;
    /** 小缩略图的失败提示保留完整悬停说明，只显示短文案。 */
    compact?: boolean;
  },
) {
  return (
    <ConversationImagePreview
      resource={props.resource}
      label={props.resource.displayName}
      language={props.language}
      compact={props.compact}
      onOpenResource={props.onOpenResource}
      onLoadResourcePreview={props.onLoadResourcePreview}
      className="session-resource-image"
      placeholderClassName="session-resource-image-placeholder"
    />
  );
}

/** 文件名保留完整悬停说明，自动转换的文本显示易读名称。 */
export function ConversationResourceCard(
  props: ConversationResourceInteraction & {
    resource: ConversationResource;
    language: SessionUiLanguage;
    /** 紧凑附件行使用小缩略图和收窄的操作按钮。 */
    compact?: boolean;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const subtitle = resourceSubtitle(props.resource, props.language);

  /** 读取错误就地显示，打开目标仍由受控资源决定。 */
  async function open(target = defaultOpenTarget(props.resource)): Promise<void> {
    if (!props.onOpenResource || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onOpenResource(props.resource, target);
    } catch (openError) {
      setError(openError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="session-resource-card" data-resource-kind={props.resource.kind} data-web-page={isWebPageResource(props.resource) || undefined} data-compact={props.compact || undefined} data-error={Boolean(error) || undefined}>
      <Button unstyled type="button" className="session-resource-card-main" data-file-name={props.resource.displayName} data-icon-tooltip={props.resource.displayName} aria-busy={busy || undefined} onClick={() => open()}>
        <span className="session-resource-card-icon">
          <ResourceIcon resource={props.resource} />
        </span>
        <span className="session-resource-card-copy">
          <strong>{pendingResourceDisplayName(props.resource.displayName, props.language)}</strong>
          <small>{subtitle}</small>
        </span>
      </Button>
      {/* 附件卡只保留默认预览入口，外部应用操作由文件预览承载。 */}
      {props.resource.kind !== 'attachment' ? <OpenWithMenu resource={props.resource} language={props.language} disabled={busy} onOpen={(target) => open(target)} /> : null}
      {error ? <VisibleApplicationError error={error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} /> : null}
    </article>
  );
}

/** 资源卡和文件工具栏复用同一套可用应用检测及键盘菜单。 */
export function OpenWithMenu(props: {
  label?: string;
  applicationsOnly?: boolean;
  /** 文件工具栏优先向下展开，空间不足时仍避开窗口边界。 */ preferBelow?: boolean;
  /** 已检测的真实应用供工具栏与菜单共用，避免重复检测。 */ targets?: ConversationResourceOpenTarget[];
  /** 文件操作与应用列表分隔，仍处于同一个键盘菜单。 */ footer?: ReactNode;
  resource: ConversationResource;
  language: SessionUiLanguage;
  disabled: boolean;
  onOpen: (target: ConversationOpenTarget) => void | Promise<void>;
}) {
  /** 文件菜单跟随当前预览窗口，桥接调用仍使用原授权。 */
  const document = useWindowDocument();
  /** 浮层位置按当前窗口的客户区计算。 */
  const viewport = document.defaultView!;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  /** 打开方式关闭后仅保留视觉退场，不再接受操作。 */
  const { ref: menuRef, present: menuPresent } = useMotionPresence<HTMLDivElement>(open);
  const [loading, setLoading] = useState(false);
  const [targets, setTargets] = useState<ConversationResourceOpenTarget[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) || menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    viewport.addEventListener('pointerdown', close, true);
    return () => viewport.removeEventListener('pointerdown', close, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }
    const position = (): void => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const left = Math.max(margin, Math.min(triggerRect.right - menuRect.width, viewport.innerWidth - menuRect.width - margin));
      const above = triggerRect.top - menuRect.height - gap;
      const below = triggerRect.bottom + gap;
      const top = props.preferBelow && below + menuRect.height <= viewport.innerHeight - margin ? below : above >= margin ? above : Math.max(margin, Math.min(below, viewport.innerHeight - menuRect.height - margin));
      setMenuPosition({ left, top });
    };
    position();
    viewport.addEventListener('resize', position);
    viewport.addEventListener('scroll', position, true);
    return () => {
      viewport.removeEventListener('resize', position);
      viewport.removeEventListener('scroll', position, true);
    };
  }, [error, loading, open, targets.length, props.preferBelow]);

  useEffect(() => {
    if (!open || loading || targets.length === 0) return;
    requestAnimationFrame(() => menuButtons(menuRef.current)[0]?.focus());
  }, [loading, open, targets]);

  /** 优先复用工具栏的检测结果，其他入口仍按需请求宿主。 */
  async function toggle(): Promise<void> {
    if (props.disabled) return;
    const next = !open;
    setOpen(next);
    if (!next || targets.length > 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = props.targets
        ? { targets: props.targets }
        : await listConversationResourceOpenTargetsInMain({
            zeus: window.zeus,
            projectId: props.resource.projectId,
            conversationId: props.resource.conversationId,
            resourceId: props.resource.id,
          });
      /** 文件菜单先显示首选编辑器、默认应用和终端，其余编辑器随后展示。 */
      const applications = result.targets.filter((target) => target.available && (target.id === 'system_default' || target.id.startsWith('editor:') || target.id.startsWith('terminal:')));
      /** 与工具栏使用同一检测顺序，首个可用编辑器优先。 */
      const primary = applications.find((target) => target.id.startsWith('editor:'));
      setTargets(
        props.applicationsOnly
          ? [
              ...(primary ? [primary] : []),
              ...applications.filter((target) => target.id === 'system_default'),
              ...applications.filter((target) => target.id.startsWith('terminal:')),
              ...applications.filter((target) => target.id.startsWith('editor:') && target !== primary),
            ]
          : result.targets,
      );
    } catch (loadError) {
      setError(loadError);
    } finally {
      setLoading(false);
    }
  }

  function closeAndRestoreFocus(): void {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const buttons = menuButtons(menuRef.current);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      setOpen(false);
      const trigger = triggerRef.current;
      requestAnimationFrame(() => focusAdjacentDocumentControl(trigger, event.shiftKey));
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || buttons.length === 0) return;
    event.preventDefault();
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (Math.max(currentIndex, -1) + 1) % buttons.length : (currentIndex <= 0 ? buttons.length : currentIndex) - 1;
    buttons[nextIndex]?.focus();
  }

  return (
    <div className="session-open-with" ref={rootRef}>
      <Button
        unstyled
        ref={triggerRef}
        type="button"
        className="session-open-with-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        data-icon-tooltip={props.label ?? (props.language === 'zh-CN' ? '打开方式' : 'Open with')}
        aria-label={props.language === 'zh-CN' ? `选择 ${props.resource.displayName} 的打开方式` : `Open ${props.resource.displayName} with`}
        disabled={props.disabled}
        onClick={() => toggle()}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          if (!open) return toggle();
          else menuButtons(menuRef.current)[0]?.focus();
        }}
      >
        <span>{props.label ?? (props.language === 'zh-CN' ? '打开方式' : 'Open with')}</span>
        <CaretDown aria-hidden="true" weight="bold" />
      </Button>
      {menuPresent
        ? createPortal(
            <div className={openWithPortalClassName(document)}>
              <div
                className={`session-open-with-menu${props.applicationsOnly ? ' session-open-with-app-menu' : ''}`}
                data-motion-surface="popover"
                data-motion-state={open ? 'open' : 'closing'}
                inert={!open}
                aria-hidden={!open}
                role="menu"
                ref={menuRef}
                onKeyDown={handleMenuKeyDown}
                style={menuPositionStyle(menuPosition)}
              >
                {/* 底部操作先关闭菜单并恢复焦点，随后由各自受控入口执行。 */}
                {loading ? <span className="session-open-with-status">{props.language === 'zh-CN' ? '正在检测应用…' : 'Detecting apps…'}</span> : null}
                {error ? (
                  <span className="session-open-with-status" role="alert">
                    <VisibleApplicationError error={error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
                  </span>
                ) : null}
                {!loading && !error
                  ? targets.map((target) => (
                      <Button
                        unstyled
                        type="button"
                        role="menuitem"
                        key={target.id}
                        disabled={!target.available}
                        data-icon-tooltip={!target.available ? target.reason : undefined}
                        onClick={() => {
                          closeAndRestoreFocus();
                          return props.onOpen(target.id);
                        }}
                      >
                        <span className="session-open-with-target-label">
                          {target.iconDataUrl ? (
                            <img src={target.iconDataUrl} alt="" width={20} height={20} />
                          ) : target.id === 'system_default' && props.applicationsOnly ? (
                            <FolderOpen className="session-open-with-default-icon" aria-hidden="true" weight="duotone" />
                          ) : target.id.startsWith('terminal:') ? (
                            <TerminalWindow aria-hidden="true" />
                          ) : target.id === 'copy_path' || target.id === 'copy_link' ? (
                            <Copy aria-hidden="true" />
                          ) : target.id === 'file_manager' ? (
                            <FolderOpen aria-hidden="true" weight="regular" />
                          ) : target.id === 'zeus_browser' ? (
                            <GlobeSimple aria-hidden="true" />
                          ) : target.id === 'zeus_source' ? (
                            <FileCode aria-hidden="true" />
                          ) : (
                            <AppWindow aria-hidden="true" />
                          )}
                          {props.applicationsOnly && target.id === 'system_default' ? 'Default app' : props.applicationsOnly && target.id === 'editor:vscode' ? 'VS Code' : localizedTargetLabel(target, props.language)}
                        </span>
                        {target.exactLocation && target.available ? <small>{props.language === 'zh-CN' ? '精确到行' : 'Exact line'}</small> : null}
                      </Button>
                    ))
                  : null}
                {props.footer ? (
                  <div className="session-open-with-footer" onClick={closeAndRestoreFocus}>
                    {props.footer}
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function menuPositionStyle(position: { left: number; top: number } | null): CSSProperties {
  return position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' };
}

function openWithPortalClassName(document: Document): string {
  const app = document.querySelector('.macos-ai-app.zeus-shell');
  const theme = app?.classList.contains('theme-dark') ? 'theme-dark' : app?.classList.contains('theme-light') ? 'theme-light' : 'theme-system';
  return `macos-ai-app session-open-with-portal session-codex-parity-v1 ${theme}`;
}

function menuButtons(menu: HTMLDivElement | null): HTMLButtonElement[] {
  return menu ? [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')] : [];
}

function focusAdjacentDocumentControl(trigger: HTMLButtonElement | null, backwards: boolean): void {
  if (!trigger) return;
  /** Tab 仅访问触发器所属文档的控件。 */
  const document = trigger.ownerDocument;
  const controls = [...document.querySelectorAll<HTMLElement>(['a[href]', 'button:not(:disabled)', 'input:not(:disabled)', 'select:not(:disabled)', 'textarea:not(:disabled)', '[tabindex]:not([tabindex="-1"])'].join(','))].filter(
    (element) => !element.closest('.session-open-with-portal') && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0 && element.ownerDocument.defaultView!.getComputedStyle(element).visibility !== 'hidden',
  );
  const currentIndex = controls.indexOf(trigger);
  if (currentIndex < 0 || controls.length < 2) {
    trigger.focus();
    return;
  }
  const offset = backwards ? -1 : 1;
  controls[(currentIndex + offset + controls.length) % controls.length]?.focus();
}

/** 会话文件交由统一入口选择预览容器，网页进入内置浏览器；邮件链接交给邮件应用。 */
export function defaultOpenTarget(resource: ConversationResource): ConversationOpenTarget {
  if (resource.kind === 'website') return resource.url.startsWith('mailto:') ? 'system_default' : 'zeus_browser';
  if (resource.kind === 'file' && resource.externalReference) return 'system_default';
  return resource.iconKind === 'html' ? 'zeus_browser' : 'zeus_source';
}

export function isImageResource(resource: ConversationResource): boolean {
  return resource.kind === 'attachment' ? resource.previewKind === 'image' : resource.kind === 'file' && !resource.externalReference && resource.iconKind === 'image';
}

/** 视频类型沿用文件预览器的格式范围，项目文件以真实的相对路径为准。 */
export function isVideoResource(resource: ConversationResource): boolean {
  if (resource.kind === 'website') return false;
  if (resource.kind === 'file') return !resource.externalReference && filePreviewKind(filePreviewMime(resource.projectRelativePath)) === 'video';
  return [resource.mimeType ?? '', filePreviewMime(resource.attachmentRef), filePreviewMime(resource.displayName)].some((mime) => filePreviewKind(mime) === 'video');
}

/** 浏览器可打开的网页资源共用卡片外观，邮件链接保持原入口。 */
function isWebPageResource(resource: ConversationResource): boolean {
  return resource.kind === 'website' ? !resource.url.startsWith('mailto:') : resource.kind === 'file' && resource.iconKind === 'html';
}

/** 文件和附件共用类型图标，网址显示站点标识。 */
export function ResourceIcon(props: { resource: ConversationResource; size?: number }) {
  if (props.resource.kind === 'website') {
    return props.resource.domain.toLocaleLowerCase().replace(/^www\./u, '') === 'github.com' ? <GithubLogo aria-hidden="true" weight="regular" /> : <GlobeSimple aria-hidden="true" weight="regular" />;
  }
  /** 引用使用登记的真实路径，附件使用原文件名。 */
  const path = props.resource.kind === 'file' ? props.resource.projectRelativePath : props.resource.displayName;
  return <FileTypeIcon path={path} size={props.size} />;
}

/** 行号保留英文表达，实际打开仍使用原始位置字段。 */
function locationLabel(resource: Extract<ConversationResource, { kind: 'file' }>): string | null {
  const line = resource.location?.line;
  const endLine = resource.location?.endLine;
  if (!line) return null;
  if (endLine && endLine > line) return `(lines ${line}–${endLine})`;
  return `(line ${line})`;
}

/** 本地网页不能用“网站”暗示已发布，线上资源继续展示域名。 */
function resourceSubtitle(resource: ConversationResource, language: SessionUiLanguage): string {
  if (resource.kind === 'website') return language === 'zh-CN' ? `网站 · ${resource.domain}` : `Website · ${resource.domain}`;
  if (resource.kind === 'file' && resource.presentation === 'card' && resource.iconKind === 'html') {
    return language === 'zh-CN' ? '本地网页' : 'Local web page';
  }
  const kind = resource.iconKind;
  const zh: Record<ConversationFileIconKind, string> = {
    code: '代码',
    java: 'Java 源码',
    javascript: 'JavaScript 源码',
    typescript: 'TypeScript 源码',
    json: 'JSON 文件',
    markdown: 'Markdown 文档',
    sql: 'SQL 文件',
    html: '网页',
    css: '样式表',
    image: '图片',
    pdf: 'PDF 文档',
    spreadsheet: '表格',
    presentation: '演示文稿',
    document: '文档',
    archive: '压缩文件',
    file: '文件',
  };
  const en: Record<ConversationFileIconKind, string> = {
    code: 'Code',
    java: 'Java source',
    javascript: 'JavaScript source',
    typescript: 'TypeScript source',
    json: 'JSON file',
    markdown: 'Markdown document',
    sql: 'SQL file',
    html: 'Website',
    css: 'Stylesheet',
    image: 'Image',
    pdf: 'PDF document',
    spreadsheet: 'Spreadsheet',
    presentation: 'Presentation',
    document: 'Document',
    archive: 'Archive',
    file: 'File',
  };
  return (language === 'zh-CN' ? zh : en)[kind];
}

function localizedTargetLabel(target: ConversationResourceOpenTarget, language: SessionUiLanguage): ReactNode {
  if (language !== 'zh-CN') return target.label;
  const labels: Partial<Record<ConversationOpenTarget, string>> = {
    zeus_source: '在 Zeus 中预览',
    zeus_browser: '在 Zeus 浏览器中打开',
    system_default: '使用系统默认应用',
    file_manager: '在 Finder 中显示',
    copy_link: '复制链接',
    copy_path: '复制路径',
  };
  return labels[target.id] ?? target.label;
}
