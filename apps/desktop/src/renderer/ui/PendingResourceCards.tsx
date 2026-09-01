import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { FileArchiveIcon as FileArchive } from '@phosphor-icons/react/dist/csr/FileArchive';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileCssIcon as FileCss } from '@phosphor-icons/react/dist/csr/FileCss';
import { FileDocIcon as FileDoc } from '@phosphor-icons/react/dist/csr/FileDoc';
import { FileHtmlIcon as FileHtml } from '@phosphor-icons/react/dist/csr/FileHtml';
import { FileImageIcon as FileImage } from '@phosphor-icons/react/dist/csr/FileImage';
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

export type PendingResourceKind = 'image' | 'file' | 'directory' | 'pasted_text';

export interface PendingResourceCardItem {
  id: string;
  name: string;
  kind: PendingResourceKind;
  mimeType?: string;
  size?: number;
  characterCount?: number;
  previewUrl?: string;
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

function PendingResourceCard(props: Omit<PendingResourceCardsProps, 'resources' | 'className'> & { resource: PendingResourceCardItem }) {
  const [loadedPreviewUrl, setLoadedPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const resourceRef = useRef(props.resource);
  const previewLoaderRef = useRef(props.onLoadPreview);
  resourceRef.current = props.resource;
  previewLoaderRef.current = props.onLoadPreview;
  const previewUrl = props.resource.previewUrl ?? loadedPreviewUrl;
  const previewLoaderAvailable = Boolean(props.onLoadPreview);
  const extension = pendingResourceExtension(props.resource.name);
  const typeLabel = pendingResourceTypeLabel(props.resource, props.language);
  const resourceColor = pendingResourceColorFamily(props.resource, extension);

  useEffect(() => {
    let active = true;
    const resource = resourceRef.current;
    const loadPreview = previewLoaderRef.current;
    setLoadedPreviewUrl(null);
    setPreviewFailed(false);
    if (resource.kind !== 'image' || resource.previewUrl || !loadPreview) {
      return () => {
        active = false;
      };
    }
    void loadPreview(resource)
      .then((preview) => {
        if (active) setLoadedPreviewUrl(preview?.previewUrl ?? null);
      })
      .catch(() => {
        if (active) setPreviewFailed(true);
      });
    return () => {
      active = false;
    };
  }, [previewLoaderAvailable, props.resource.id, props.resource.kind, props.resource.previewUrl]);

  function activate(event: ReactMouseEvent<HTMLButtonElement>): void {
    props.onActivate?.(props.resource, event.currentTarget);
  }

  const visual = (
    <span className="pending-resource-visual" data-color-family={resourceColor} aria-hidden="true">
      {props.resource.kind === 'image' && previewUrl && !previewFailed ? <img src={previewUrl} alt="" onError={() => setPreviewFailed(true)} /> : <PendingResourceIcon resource={props.resource} extension={extension} />}
    </span>
  );

  return (
    <li className="pending-resource-card" data-resource-kind={props.resource.kind} title={props.resource.title ?? props.resource.name}>
      {props.onActivate ? (
        <button type="button" className="pending-resource-activate" aria-label={`${pendingResourceOpenLabel(props.resource.kind, props.language)}: ${props.resource.name}`} disabled={props.disabled} onClick={activate}>
          {visual}
        </button>
      ) : (
        visual
      )}
      {props.resource.kind === 'image' ? null : (
        <span className="pending-resource-copy">
          <strong>{props.resource.name}</strong>
          <span className="pending-resource-meta">
            <small>{typeLabel}</small>
            {props.resource.kind === 'pasted_text' && props.resource.restorable && props.onRestoreText ? (
              <button type="button" className="pending-resource-restore" disabled={props.disabled} onClick={() => props.onRestoreText?.(props.resource)}>
                {props.language === 'zh-CN' ? '恢复' : 'Restore'}
              </button>
            ) : null}
          </span>
        </span>
      )}
      {props.onRemove ? (
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
  const iconProps = { size: 25, weight: 'fill' as const, 'aria-hidden': true };
  if (props.resource.kind === 'image') return <FileImage {...iconProps} />;
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

function pendingResourceColorFamily(resource: PendingResourceCardItem, extension: string): string {
  if (resource.kind === 'directory') return 'folder';
  if (resource.kind === 'pasted_text') return 'text';
  if (resource.kind === 'image') return 'image';
  if (['xls', 'xlsx', 'numbers', 'csv'].includes(extension)) return 'sheet';
  if (['doc', 'docx', 'pages', 'rtf'].includes(extension)) return 'document';
  if (['ppt', 'pptx', 'key'].includes(extension)) return 'presentation';
  if (extension === 'pdf') return 'pdf';
  if (['zip', 'gz', 'tgz', 'rar', '7z', 'tar'].includes(extension)) return 'archive';
  if (['js', 'jsx', 'mjs', 'ts', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'sql', 'json', 'yaml', 'yml', 'toml', 'xml', 'sh', 'py', 'java', 'go', 'rs'].includes(extension)) return 'code';
  return 'file';
}
