import {type ComponentType, type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {CaretDownIcon as CaretDown} from '@phosphor-icons/react/dist/csr/CaretDown';
import {FileIcon as File} from '@phosphor-icons/react/dist/csr/File';
import {FileArchiveIcon as FileArchive} from '@phosphor-icons/react/dist/csr/FileArchive';
import {FileCodeIcon as FileCode} from '@phosphor-icons/react/dist/csr/FileCode';
import {FileCssIcon as FileCss} from '@phosphor-icons/react/dist/csr/FileCss';
import {FileDocIcon as FileDoc} from '@phosphor-icons/react/dist/csr/FileDoc';
import {FileHtmlIcon as FileHtml} from '@phosphor-icons/react/dist/csr/FileHtml';
import {FileImageIcon as FileImage} from '@phosphor-icons/react/dist/csr/FileImage';
import {FileJsIcon as FileJs} from '@phosphor-icons/react/dist/csr/FileJs';
import {FileMdIcon as FileMd} from '@phosphor-icons/react/dist/csr/FileMd';
import {FilePdfIcon as FilePdf} from '@phosphor-icons/react/dist/csr/FilePdf';
import {FilePptIcon as FilePpt} from '@phosphor-icons/react/dist/csr/FilePpt';
import {FileSqlIcon as FileSql} from '@phosphor-icons/react/dist/csr/FileSql';
import {FileTsIcon as FileTs} from '@phosphor-icons/react/dist/csr/FileTs';
import {FileXlsIcon as FileXls} from '@phosphor-icons/react/dist/csr/FileXls';
import {GlobeSimpleIcon as GlobeSimple} from '@phosphor-icons/react/dist/csr/GlobeSimple';
import {GithubLogoIcon as GithubLogo} from '@phosphor-icons/react/dist/csr/GithubLogo';
import type {
  ConversationFileLocation,
  ConversationFileIconKind,
  ConversationOpenTarget,
  ConversationResource,
  ConversationResourceOpenTarget,
} from '@zeus/shared';
import {
  listConversationResourceOpenTargetsInMain,
} from '../appShellBridge.js';
import type {SessionUiLanguage} from './ThreadItemView.js';

export interface ConversationResourceInteraction {
  onOpenResource?: (
    resource: ConversationResource,
    target: ConversationOpenTarget,
    location?: ConversationFileLocation,
  ) => void | Promise<void>;
}

export function ConversationInlineResource(
  props: ConversationResourceInteraction & {
    resource: ConversationResource;
    label: string;
    language: SessionUiLanguage;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rawLocation = props.resource.kind === 'file' ? locationLabel(props.resource, props.language) : null;
  const location = rawLocation && !/\(\s*lines?\s+\d+/iu.test(props.label) ? rawLocation : null;
  const title =
    props.resource.kind === 'file'
      ? props.resource.projectRelativePath
      : props.resource.kind === 'website'
        ? props.resource.url
        : props.resource.displayName;

  async function open(): Promise<void> {
    if (!props.onOpenResource || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onOpenResource(props.resource, defaultOpenTarget(props.resource));
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="session-inline-resource-shell" data-resource-kind={props.resource.kind}>
      <button
        type="button"
        className="session-inline-resource"
        title={error ?? title}
        aria-label={`${props.label}${location ? ` ${location}` : ''}`}
        aria-busy={busy || undefined}
        data-error={Boolean(error) || undefined}
        onClick={() => void open()}
      >
        <ResourceIcon resource={props.resource}/>
        <span>{props.label}</span>
        {location ? <span className="session-inline-resource-location">{location}</span> : null}
      </button>
      {error ? <span className="session-sr-only" role="alert">{error}</span> : null}
    </span>
  );
}

export function ConversationResourceCards(
  props: ConversationResourceInteraction & {
    resources: ConversationResource[];
    language: SessionUiLanguage;
  },
) {
  const resources = props.resources.filter((resource) => resource.presentation === 'card');
  if (resources.length === 0) return null;
  return (
    <section
      className="session-resource-card-list"
      aria-label={props.language === 'zh-CN' ? '会话资源' : 'Conversation resources'}
    >
      {resources.map((resource) => (
        <ConversationResourceCard
          key={resource.id}
          resource={resource}
          language={props.language}
          onOpenResource={props.onOpenResource}
        />
      ))}
    </section>
  );
}

function ConversationResourceCard(
  props: ConversationResourceInteraction & {
    resource: ConversationResource;
    language: SessionUiLanguage;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subtitle = resourceSubtitle(props.resource, props.language);

  async function open(target = defaultOpenTarget(props.resource)): Promise<void> {
    if (!props.onOpenResource || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onOpenResource(props.resource, target);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="session-resource-card" data-resource-kind={props.resource.kind} data-error={Boolean(error) || undefined}>
      <button
        type="button"
        className="session-resource-card-main"
        aria-busy={busy || undefined}
        onClick={() => void open()}
      >
        <span className="session-resource-card-icon"><ResourceIcon resource={props.resource}/></span>
        <span className="session-resource-card-copy">
          <strong>{props.resource.displayName}</strong>
          <small>{error ?? subtitle}</small>
        </span>
      </button>
      <OpenWithMenu
        resource={props.resource}
        language={props.language}
        disabled={busy}
        onOpen={(target) => open(target)}
      />
    </article>
  );
}

function OpenWithMenu(props: {
  resource: ConversationResource;
  language: SessionUiLanguage;
  disabled: boolean;
  onOpen: (target: ConversationOpenTarget) => void | Promise<void>;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [targets, setTargets] = useState<ConversationResourceOpenTarget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{left: number; top: number} | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) || menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
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
      const left = Math.max(
        margin,
        Math.min(triggerRect.right - menuRect.width, window.innerWidth - menuRect.width - margin),
      );
      const above = triggerRect.top - menuRect.height - gap;
      const below = triggerRect.bottom + gap;
      const top = above >= margin
        ? above
        : Math.max(margin, Math.min(below, window.innerHeight - menuRect.height - margin));
      setMenuPosition({left, top});
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [error, loading, open, targets.length]);

  useEffect(() => {
    if (!open || loading || targets.length === 0) return;
    requestAnimationFrame(() => menuButtons(menuRef.current)[0]?.focus());
  }, [loading, open, targets]);

  async function toggle(): Promise<void> {
    if (props.disabled) return;
    const next = !open;
    setOpen(next);
    if (!next || targets.length > 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listConversationResourceOpenTargetsInMain({
        zeus: window.zeus,
        projectId: props.resource.projectId,
        conversationId: props.resource.conversationId,
        resourceId: props.resource.id,
      });
      setTargets(result.targets);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
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
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? (Math.max(currentIndex, -1) + 1) % buttons.length
            : (currentIndex <= 0 ? buttons.length : currentIndex) - 1;
    buttons[nextIndex]?.focus();
  }

  return (
    <div className="session-open-with" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="session-open-with-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.language === 'zh-CN' ? `选择 ${props.resource.displayName} 的打开方式` : `Open ${props.resource.displayName} with`}
        disabled={props.disabled}
        onClick={() => void toggle()}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          if (!open) void toggle();
          else menuButtons(menuRef.current)[0]?.focus();
        }}
      >
        <span>{props.language === 'zh-CN' ? '打开方式' : 'Open with'}</span>
        <CaretDown aria-hidden="true" weight="bold"/>
      </button>
      {open
        ? createPortal(
            <div className={openWithPortalClassName()}>
              <div
                className="session-open-with-menu"
                role="menu"
                ref={menuRef}
                onKeyDown={handleMenuKeyDown}
                style={menuPositionStyle(menuPosition)}
              >
                {loading ? <span className="session-open-with-status">{props.language === 'zh-CN' ? '正在检测应用…' : 'Detecting apps…'}</span> : null}
                {error ? <span className="session-open-with-status" role="alert">{error}</span> : null}
                {!loading && !error
                  ? targets.map((target) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={target.id}
                        disabled={!target.available}
                        title={!target.available ? target.reason : undefined}
                        onClick={() => {
                          closeAndRestoreFocus();
                          void props.onOpen(target.id);
                        }}
                      >
                        <span>{localizedTargetLabel(target, props.language)}</span>
                        {target.exactLocation && target.available ? <small>{props.language === 'zh-CN' ? '精确到行' : 'Exact line'}</small> : null}
                      </button>
                    ))
                  : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function menuPositionStyle(position: {left: number; top: number} | null): CSSProperties {
  return position
    ? {left: position.left, top: position.top}
    : {left: 0, top: 0, visibility: 'hidden'};
}

function openWithPortalClassName(): string {
  const app = document.querySelector('.macos-ai-app.zeus-shell');
  const theme = app?.classList.contains('theme-dark')
    ? 'theme-dark'
    : app?.classList.contains('theme-light')
      ? 'theme-light'
      : 'theme-system';
  return `session-open-with-portal session-codex-parity-v1 ${theme}`;
}

function menuButtons(menu: HTMLDivElement | null): HTMLButtonElement[] {
  return menu ? [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')] : [];
}

function focusAdjacentDocumentControl(trigger: HTMLButtonElement | null, backwards: boolean): void {
  if (!trigger) return;
  const controls = [...document.querySelectorAll<HTMLElement>([
    'a[href]',
    'button:not(:disabled)',
    'input:not(:disabled)',
    'select:not(:disabled)',
    'textarea:not(:disabled)',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))].filter((element) => (
    !element.closest('.session-open-with-portal')
    && element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0
    && window.getComputedStyle(element).visibility !== 'hidden'
  ));
  const currentIndex = controls.indexOf(trigger);
  if (currentIndex < 0 || controls.length < 2) {
    trigger.focus();
    return;
  }
  const offset = backwards ? -1 : 1;
  controls[(currentIndex + offset + controls.length) % controls.length]?.focus();
}

export function defaultOpenTarget(resource: ConversationResource): ConversationOpenTarget {
  return resource.kind === 'website' && resource.url.startsWith('mailto:')
    ? 'system_default'
    : 'preferred';
}

function ResourceIcon(props: {resource: ConversationResource}) {
  if (props.resource.kind === 'file' && props.resource.presentation === 'card' && props.resource.iconKind === 'html') {
    return <GlobeSimple aria-hidden="true" weight="duotone"/>;
  }
  if (props.resource.kind === 'website') {
    return props.resource.domain.toLocaleLowerCase().replace(/^www\./u, '') === 'github.com'
      ? <GithubLogo aria-hidden="true" weight="fill"/>
      : <GlobeSimple aria-hidden="true" weight="duotone"/>;
  }
  const Icon = fileIcon(props.resource.iconKind);
  return <Icon aria-hidden="true" weight="duotone"/>;
}

function fileIcon(kind: ConversationFileIconKind): ComponentType<{weight?: 'duotone'; 'aria-hidden'?: string}> {
  if (kind === 'javascript') return FileJs;
  if (kind === 'typescript') return FileTs;
  if (kind === 'sql') return FileSql;
  if (kind === 'html') return FileHtml;
  if (kind === 'css') return FileCss;
  if (kind === 'markdown') return FileMd;
  if (kind === 'image') return FileImage;
  if (kind === 'pdf') return FilePdf;
  if (kind === 'spreadsheet') return FileXls;
  if (kind === 'presentation') return FilePpt;
  if (kind === 'document') return FileDoc;
  if (kind === 'archive') return FileArchive;
  if (sourceIconKinds.has(kind)) return FileCode;
  return File;
}

const sourceIconKinds = new Set<ConversationFileIconKind>([
  'code',
  'java',
  'javascript',
  'typescript',
  'json',
  'markdown',
  'sql',
  'css',
]);

function locationLabel(
  resource: Extract<ConversationResource, {kind: 'file'}>,
  language: SessionUiLanguage,
): string | null {
  const line = resource.location?.line;
  const endLine = resource.location?.endLine;
  if (!line) return null;
  if (endLine && endLine > line) return language === 'zh-CN' ? `(lines ${line}–${endLine})` : `(lines ${line}–${endLine})`;
  return `(line ${line})`;
}

function resourceSubtitle(resource: ConversationResource, language: SessionUiLanguage): string {
  if (resource.kind === 'website') return language === 'zh-CN' ? `网站 · ${resource.domain}` : `Website · ${resource.domain}`;
  if (resource.kind === 'file' && resource.presentation === 'card' && resource.iconKind === 'html') {
    return language === 'zh-CN' ? '网站' : 'Website';
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
