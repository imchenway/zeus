import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { FileArchiveIcon as FileArchive } from '@phosphor-icons/react/dist/csr/FileArchive';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileCssIcon as FileCss } from '@phosphor-icons/react/dist/csr/FileCss';
import { FileDocIcon as FileDoc } from '@phosphor-icons/react/dist/csr/FileDoc';
import { FileHtmlIcon as FileHtml } from '@phosphor-icons/react/dist/csr/FileHtml';
import { FileJsIcon as FileJs } from '@phosphor-icons/react/dist/csr/FileJs';
import { FileMdIcon as FileMd } from '@phosphor-icons/react/dist/csr/FileMd';
import { FilePdfIcon as FilePdf } from '@phosphor-icons/react/dist/csr/FilePdf';
import { FilePptIcon as FilePpt } from '@phosphor-icons/react/dist/csr/FilePpt';
import { FileSqlIcon as FileSql } from '@phosphor-icons/react/dist/csr/FileSql';
import { FileTextIcon as FileText } from '@phosphor-icons/react/dist/csr/FileText';
import { FileTsIcon as FileTs } from '@phosphor-icons/react/dist/csr/FileTs';
import { FileXlsIcon as FileXls } from '@phosphor-icons/react/dist/csr/FileXls';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { ResourceLoading } from './ResourceLoading.js';
import { isPendingResourceText, pendingResourceDisplayName } from './pendingResourcePolicy.js';
import { ResourceTextPreview } from './ResourceTextPreview.js';
import type { FilePreviewRequest } from '@zeus/shared';

export type PendingResourceKind = 'image' | 'file' | 'directory' | 'pasted_text';

export interface PendingResourceCardItem {
  id: string;
  name: string;
  kind: PendingResourceKind;
  mimeType?: string;
  size?: number;
  characterCount?: number;
  /** 已有正文只取开头供界面显示，不重复保存完整文本。 */
  textExcerpt?: string;
  /** 旧文本附件通过业务身份读取；名称不能成为读取权限。 */
  textPreviewRequest?: FilePreviewRequest;
  previewUrl?: string;
  /** 外部读取缩略图时也使用统一加载占位。 */
  previewLoading?: boolean;
  /** 读取失败后停止动画，保留文件打开入口。 */
  previewFailed?: boolean;
  /** 临时卡片只提供即时反馈，宿主确认前不能打开、移除或恢复。 */
  pending?: boolean;
  /** 任务表单用字段定位临时卡片，不写入附件持久化。 */
  scope?: string;
  restorable?: boolean;
  title?: string;
}

export interface PendingResourceCardsProps {
  resources: PendingResourceCardItem[];
  language: 'zh-CN' | 'en-US';
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  onRemove?: (resource: PendingResourceCardItem) => void;
  onRestoreText?: (resource: PendingResourceCardItem) => void;
  onActivate?: (resource: PendingResourceCardItem, trigger: HTMLButtonElement) => void;
  onLoadPreview?: (resource: PendingResourceCardItem) => Promise<{ previewUrl: string; mimeType: string } | null>;
}

/** 所有输入和原始附件共用资源卡片，不改变附件身份。 */
export function PendingResourceCards(props: PendingResourceCardsProps) {
  if (props.resources.length === 0) return null;
  const className = ['pending-resource-strip', props.className].filter(Boolean).join(' ');
  return (
    <ul className={className} aria-label={props.ariaLabel ?? (props.language === 'zh-CN' ? '待提交资源' : 'Pending resources')}>
      {props.resources.map((resource) => (
        <PendingResourceCard
          key={resource.id}
          resource={resource}
          language={props.language}
          disabled={Boolean(props.disabled)}
          onRemove={props.onRemove}
          onRestoreText={props.onRestoreText}
          onActivate={props.onActivate}
          onLoadPreview={props.onLoadPreview}
        />
      ))}
    </ul>
  );
}

/** 图片加载和导入分别完成，现有预览不被导入提示遮住。 */
function PendingResourceCard(props: Omit<PendingResourceCardsProps, 'resources' | 'className'> & { resource: PendingResourceCardItem }) {
  const [loadedPreviewUrl, setLoadedPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  /** URL 返回后仍等待图片解码完成，避免显示空白缩略图。 */
  const [decodedPreviewUrl, setDecodedPreviewUrl] = useState<string | null>(null);
  const resourceRef = useRef(props.resource);
  const previewLoaderRef = useRef(props.onLoadPreview);
  resourceRef.current = props.resource;
  previewLoaderRef.current = props.onLoadPreview;
  const previewUrl = props.resource.previewUrl ?? loadedPreviewUrl;
  const previewLoaderAvailable = Boolean(props.onLoadPreview);
  const extension = pendingResourceExtension(props.resource.name);
  const typeLabel = pendingResourceTypeLabel(props.resource, props.language);
  /** 自动文本附件直接展示内容摘要，普通文件保留文件名。 */
  const textResource = isPendingResourceText(props.resource.name, props.resource.kind);
  /** 外部读取与内部读取共用失败状态，失败不能一直显示加载动画。 */
  const failed = previewFailed || props.resource.previewFailed;
  /** 导入、读取和解码都显示同一骨架，不把等待状态画成文件图标。 */
  const previewLoading = props.resource.kind === 'image' && !failed && (previewUrl ? decodedPreviewUrl !== previewUrl : Boolean(props.resource.pending || props.onLoadPreview || props.resource.previewLoading));
  /** 导入状态继续阻止提交；缩略图加载只影响展示。 */
  const busy = props.resource.pending || previewLoading;
  /** 状态说明保留给辅助技术与悬停提示。 */
  const loadingLabel = props.resource.pending ? (props.language === 'zh-CN' ? '正在导入附件' : 'Importing attachment') : props.language === 'zh-CN' ? '正在加载图片' : 'Loading image';

  useEffect(() => {
    let active = true;
    const resource = resourceRef.current;
    const loadPreview = previewLoaderRef.current;
    setLoadedPreviewUrl(null);
    setPreviewFailed(false);
    if (resource.pending || resource.kind !== 'image' || resource.previewUrl || !loadPreview) {
      return () => {
        active = false;
      };
    }
    void loadPreview(resource)
      .then((preview) => {
        if (!active) return;
        setLoadedPreviewUrl(preview?.previewUrl ?? null);
        setPreviewFailed(!preview?.previewUrl);
      })
      .catch(() => {
        if (active) setPreviewFailed(true);
      });
    return () => {
      active = false;
    };
  }, [previewLoaderAvailable, props.resource.id, props.resource.kind, props.resource.previewUrl, props.resource.pending]);

  /** 激活始终使用原始受信资源，展示名称不参与打开定位。 */
  function activate(event: ReactMouseEvent<HTMLButtonElement>): void {
    props.onActivate?.(props.resource, event.currentTarget);
  }

  /** 图片等待解码时显示骨架，导入中的已有缩略图仅附加进度条。 */
  const visual = (
    <span className="pending-resource-visual" aria-hidden="true">
      {props.resource.kind === 'image' && previewUrl && !failed ? (
        <img src={previewUrl} alt="" style={decodedPreviewUrl === previewUrl ? undefined : { visibility: 'hidden' }} onLoad={() => setDecodedPreviewUrl(previewUrl)} onError={() => setPreviewFailed(true)} />
      ) : previewLoading ? null : props.resource.kind === 'image' ? (
        <span className="pending-resource-image-unavailable">{props.language === 'zh-CN' ? '预览不可用' : 'No preview'}</span>
      ) : (
        <PendingResourceIcon resource={props.resource} extension={extension} />
      )}
      {previewLoading ? <ResourceLoading label={loadingLabel} /> : null}
    </span>
  );

  return (
    <li
      className="pending-resource-card"
      data-resource-kind={props.resource.kind}
      data-text-preview={textResource || undefined}
      aria-busy={busy || undefined}
      aria-label={
        busy ? `${loadingLabel}: ${props.resource.name}` : props.resource.kind === 'image' && (failed || !previewUrl) ? `${props.language === 'zh-CN' ? '图片预览不可用' : 'Image preview unavailable'}: ${props.resource.name}` : undefined
      }
      title={props.resource.kind === 'image' ? pendingResourceOpenLabel(props.resource.kind, props.language) : (props.resource.title ?? props.resource.name)}
    >
      {props.onActivate && !props.resource.pending ? (
        /* 预览只读取附件；提交中和只读界面只禁用移除、恢复等修改操作。 */
        <button type="button" className="pending-resource-activate" aria-label={`${pendingResourceOpenLabel(props.resource.kind, props.language)}: ${props.resource.name}`} onClick={activate}>
          {visual}
        </button>
      ) : (
        visual
      )}
      {props.resource.kind === 'image' ? null : (
        <span className="pending-resource-copy">
          {textResource ? (
            <ResourceTextPreview text={props.resource.textExcerpt} request={props.resource.textPreviewRequest} characterCount={props.resource.characterCount} pending={props.resource.pending} language={props.language} />
          ) : (
            <strong>{pendingResourceDisplayName(props.resource.name, props.language, props.resource.kind)}</strong>
          )}
          <span className="pending-resource-meta">
            {textResource ? null : <small>{props.resource.pending ? (props.language === 'zh-CN' ? '正在导入…' : 'Importing…') : typeLabel}</small>}
            {props.resource.kind === 'pasted_text' && props.resource.restorable && props.onRestoreText ? (
              <button type="button" className="pending-resource-restore" disabled={props.disabled} onClick={() => props.onRestoreText?.(props.resource)}>
                {props.language === 'zh-CN' ? '恢复' : 'Restore'}
              </button>
            ) : null}
          </span>
        </span>
      )}
      {props.resource.pending && !previewLoading ? <ResourceLoading label={loadingLabel} overlay /> : null}
      {props.onRemove && !props.resource.pending ? (
        <button
          type="button"
          className="pending-resource-remove"
          aria-label={`${props.language === 'zh-CN' ? '移除资源' : 'Remove resource'}: ${props.resource.name}`}
          disabled={props.disabled}
          onClick={() => props.onRemove?.(props.resource)}
        >
          <span className="pending-resource-remove-glyph" aria-hidden="true">
            <X size={11} weight="bold" />
          </span>
        </button>
      ) : null}
    </li>
  );
}

function PendingResourceIcon(props: { resource: PendingResourceCardItem; extension: string }): ReactNode {
  const iconProps = { size: 22, weight: 'regular' as const, 'aria-hidden': true };
  if (props.resource.kind === 'directory') return <Folder {...iconProps} />;
  if (props.resource.kind === 'pasted_text') return <FileText {...iconProps} />;
  if (['zip', 'gz', 'tgz', 'rar', '7z', 'tar'].includes(props.extension)) return <FileArchive {...iconProps} />;
  if (['xls', 'xlsx', 'numbers', 'csv'].includes(props.extension)) return <FileXls {...iconProps} />;
  if (['doc', 'docx', 'pages', 'rtf'].includes(props.extension)) return <FileDoc {...iconProps} />;
  if (['ppt', 'pptx', 'key'].includes(props.extension)) return <FilePpt {...iconProps} />;
  if (props.extension === 'pdf') return <FilePdf {...iconProps} />;
  if (props.extension === 'md' || props.extension === 'mdx') return <FileMd {...iconProps} />;
  if (props.extension === 'html' || props.extension === 'htm') return <FileHtml {...iconProps} />;
  if (props.extension === 'css' || props.extension === 'scss' || props.extension === 'less') return <FileCss {...iconProps} />;
  if (props.extension === 'js' || props.extension === 'jsx' || props.extension === 'mjs') return <FileJs {...iconProps} />;
  if (props.extension === 'ts' || props.extension === 'tsx') return <FileTs {...iconProps} />;
  if (props.extension === 'sql') return <FileSql {...iconProps} />;
  if (['json', 'yaml', 'yml', 'toml', 'xml', 'sh', 'py', 'java', 'go', 'rs'].includes(props.extension)) return <FileCode {...iconProps} />;
  return <File {...iconProps} />;
}

function pendingResourceExtension(name: string): string {
  const extension =
    name
      .trim()
      .split('.')
      .at(-1)
      ?.replace(/[^a-z0-9]+/giu, '')
      .toLocaleLowerCase() ?? '';
  return name.includes('.') ? extension : '';
}

function pendingResourceTypeLabel(resource: PendingResourceCardItem, language: 'zh-CN' | 'en-US'): string {
  const extension = pendingResourceExtension(resource.name).toLocaleUpperCase();
  if (resource.kind === 'directory') return language === 'zh-CN' ? '文件夹' : 'FOLDER';
  if (resource.kind === 'pasted_text') {
    const textLabel = resource.characterCount === undefined ? 'TXT' : language === 'zh-CN' ? `TXT · ${resource.characterCount.toLocaleString()} 字符` : `TXT · ${resource.characterCount.toLocaleString()} chars`;
    return textLabel;
  }
  if (extension) return extension;
  if (resource.kind === 'image') return language === 'zh-CN' ? '图片' : 'IMAGE';
  return language === 'zh-CN' ? '文件' : 'FILE';
}

function pendingResourceOpenLabel(kind: PendingResourceKind, language: 'zh-CN' | 'en-US'): string {
  if (language === 'en-US') return kind === 'image' ? 'Preview image' : 'Open resource';
  return kind === 'image' ? '预览图片' : '打开资源';
}
