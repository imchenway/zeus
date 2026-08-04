import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import Markdown, {type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageCheckIcon, MessageEditIcon, MessageExpandIcon, MessageThumbIcon } from './SessionMessageIcons.js';
import type { NativeSessionItemBuffer } from './sessionTypes.js';
import { autosizeTextarea } from './textareaAutosize.js';
import type { ConversationFileLocation, ConversationOpenTarget, ConversationResource, ConversationResourcePreview } from '@zeus/shared';
import { ConversationInlineResource, ConversationMarkdownImage, ConversationResourceCards } from './ConversationResources.js';

export type SessionUiLanguage = 'zh-CN' | 'en-US';
export type ThreadItemRole = 'user' | 'assistant' | 'commentary' | 'tool' | 'file' | 'request' | 'error' | 'unknown';
export const MAX_MARKDOWN_CHARACTERS = 200_000;
export const MAX_MARKDOWN_BLOCK_CHARACTERS = 50_000;
export const MAX_MARKDOWN_BLOCKS = 512;
export const MAX_MARKDOWN_NODES = 4_096;
const STREAM_IDLE_FLUSH_MS = 80;
const STREAM_MAX_FLUSH_MS = 180;

const copy = {
  'zh-CN': {
    user: '你',
    assistant: 'Codex',
    commentary: 'Codex',
    tool: '工具调用',
    file: '文件变更',
    request: '等待操作',
    error: '本轮错误',
    unknown: '未知 provider 项',
    thinking: '正在思考',
    expand: '展开完整消息',
    collapse: '收起消息',
    copy: '复制消息',
    copied: '已复制',
    copyCommand: '复制命令',
    copyCode: '复制代码',
    edit: '编辑并重新发送',
    editInput: '在原消息中编辑',
    cancelEdit: '取消',
    sendEdit: '发送编辑内容',
    editFailed: '发送失败，编辑内容已保留。',
    good: '好的回答',
    bad: '不好的回答',
    expandMessage: '展开消息',
    collapseMessage: '收起消息',
    image: '会话图片',
    attachments: '附件',
    details: '技术详情',
    complexityTruncated: '内容过于复杂，已截断',
  },
  'en-US': {
    user: 'You',
    assistant: 'Codex',
    commentary: 'Codex',
    tool: 'Tool call',
    file: 'File change',
    request: 'Action pending',
    error: 'Turn error',
    unknown: 'Unknown provider item',
    thinking: 'Thinking',
    expand: 'Expand full message',
    collapse: 'Collapse message',
    copy: 'Copy message',
    copied: 'Copied',
    copyCommand: 'Copy command',
    copyCode: 'Copy code',
    edit: 'Edit and resend',
    editInput: 'Edit in the original message',
    cancelEdit: 'Cancel',
    sendEdit: 'Send edited message',
    editFailed: 'Send failed. Your edited message is preserved.',
    good: 'Good response',
    bad: 'Bad response',
    expandMessage: 'Expand message',
    collapseMessage: 'Collapse message',
    image: 'Conversation image',
    attachments: 'Attachments',
    details: 'Technical details',
    complexityTruncated: 'Content complexity truncated',
  },
} as const;

export interface ThreadItemViewProps {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  isLatest?: boolean;
  showAssistantActions?: boolean;
  isLatestUser?: boolean;
  onEdit?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  onRetry?: (item: NativeSessionItemBuffer) => void;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
}

export function ThreadItemView(props: ThreadItemViewProps) {
  const labels = copy[props.language];
  const [expanded, setExpanded] = useState(false);
  const [messageExpanded, setMessageExpanded] = useState(false);
  const [feedback, setFeedback] = useState<'good' | 'bad' | null>(null);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const commentaryRef = useRef<HTMLDivElement | null>(null);
  const role = itemRole(props.item);
  const itemText = transcriptItemText(props.item);
  const commentary = role === 'commentary';
  const bufferedCommentary = useBufferedTranscriptText(itemText, commentary && props.item.status !== 'completed' && props.item.status !== 'failed');
  const presentedItemText = commentary ? bufferedCommentary.text : itemText;
  const longUserMessage = role === 'user' && itemText.length > 640;
  const visibleText = longUserMessage && !expanded ? `${itemText.slice(0, 620).trimEnd()}…` : presentedItemText;
  const label = roleLabel(role, labels);
  const command = normalizeType(props.item.type) === 'commandexecution' || normalizeType(props.item.type) === 'command';
  const accessibleLabel = command ? (props.language === 'zh-CN' ? '命令执行' : 'Command execution') : label;
  const showVisibleRoleLabel = role !== 'user' && role !== 'assistant' && role !== 'commentary';
  const showMeta = !command && (showVisibleRoleLabel || props.item.optimistic);
  const messageTimestamp = formatMessageTimestamp(props.item, props.language);
  const timestampSource = props.item.updatedAt ?? primitiveText(props.item.payload.createdAt);
  const canEdit = role === 'user' && props.isLatestUser && Boolean(props.onEdit) && !props.item.optimistic;
  const showRoleActions = role === 'user' || (role === 'assistant' && Boolean(props.showAssistantActions ?? props.isLatest));
  const hasActions = !editing && showRoleActions && (Boolean(visibleText) || longUserMessage || Boolean(messageTimestamp) || canEdit);

  useEffect(() => {
    if (!editing) return;
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [editing]);

  useLayoutEffect(() => {
    if (!editing || !editTextareaRef.current) return;
    autosizeTextarea(editTextareaRef.current, 72, 0.48);
  }, [editDraft, editing]);

  useLayoutEffect(() => {
    if (!commentary || bufferedCommentary.revision === 0 || prefersReducedMotion()) return;
    const latestBlock = commentaryRef.current?.querySelector<HTMLElement>('.session-markdown > :last-child');
    const animation = latestBlock?.animate(
      [
        { opacity: 0.68, transform: 'translateY(2px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 140, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    return () => animation?.cancel();
  }, [bufferedCommentary.revision, commentary]);

  async function submitEditedMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!props.onEdit || !editDraft.trim() || submittingEdit) return;
    setEditError(null);
    setSubmittingEdit(true);
    try {
      await props.onEdit(props.item, editDraft);
      setEditing(false);
    } catch {
      setEditError(labels.editFailed);
    } finally {
      setSubmittingEdit(false);
    }
  }

  function cancelEditing(): void {
    setEditing(false);
    setEditError(null);
    setEditDraft('');
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEditing();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <article
      className={`session-thread-item session-thread-item-${role}${props.isLatest ? ' is-latest' : ''}${role === 'assistant' && props.showAssistantActions ? ' is-latest-assistant' : ''}${messageExpanded ? ' is-message-expanded' : ''}${hasActions ? ' has-message-actions' : ''}${editing ? ' is-editing' : ''}`}
      data-item-status={props.item.status}
      data-item-phase={props.item.phase}
      data-item-type={props.item.type}
      data-motion-block="markdown"
      aria-label={accessibleLabel}
    >
      {showMeta ? (
        <header className="session-thread-item-meta">
          {showVisibleRoleLabel ? <strong>{label}</strong> : null}
          {props.item.optimistic ? <span className="session-item-state">{props.language === 'zh-CN' ? '发送中' : 'Sending'}</span> : null}
        </header>
      ) : null}
      {editing ? (
        <form className="session-user-message-editor" onSubmit={(event) => void submitEditedMessage(event)}>
          <label className="session-sr-only" htmlFor={`session-edit-${props.item.itemId}`}>
            {labels.editInput}
          </label>
          <textarea
            id={`session-edit-${props.item.itemId}`}
            ref={editTextareaRef}
            aria-keyshortcuts="Meta+Enter Control+Enter Escape"
            value={editDraft}
            disabled={submittingEdit}
            onChange={(event) => setEditDraft(event.currentTarget.value)}
            onKeyDown={handleEditKeyDown}
          />
          <footer>
            {editError ? <small role="alert">{editError}</small> : <span />}
            <button type="button" onClick={cancelEditing} disabled={submittingEdit}>
              {labels.cancelEdit}
            </button>
            <button type="submit" className="session-user-message-editor-submit" disabled={!editDraft.trim() || submittingEdit}>
              {labels.sendEdit}
            </button>
          </footer>
        </form>
      ) : command ? (
        <CommandExecutionItem item={props.item} language={props.language} />
      ) : commentary && visibleText ? (
        <div ref={commentaryRef} className="session-commentary-flow" data-streaming={(props.item.status !== 'completed' && props.item.status !== 'failed') || undefined}>
          <SafeMarkdown text={visibleText} language={props.language} resources={props.item.resources} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
        </div>
      ) : visibleText ? (
        <SafeMarkdown text={visibleText} language={props.language} resources={props.item.resources} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
      ) : role === 'assistant' && props.item.status !== 'completed' ? (
        <span className="session-thinking-indicator">{labels.thinking}</span>
      ) : null}
      {!command ? <TypedItemFacts item={props.item} role={role} language={props.language} /> : null}
      <ItemAttachments item={props.item} label={labels.attachments} />
      <ConversationResourceCards resources={props.item.resources} language={props.language} onOpenResource={props.onOpenResource} />
      <ItemImages item={props.item} label={labels.image} />
      {hasActions ? (
        <footer className="session-thread-item-actions" data-message-actions={role}>
          {role === 'user' && messageTimestamp && timestampSource ? <MessageTimestamp dateTime={timestampSource} value={messageTimestamp} /> : null}
          {visibleText ? <CopyIconButton label={labels.copy} copiedLabel={labels.copied} text={itemText} /> : null}
          {role === 'assistant' ? (
            <>
              <MessageIconButton label={labels.good} pressed={feedback === 'good'} onClick={() => setFeedback((current) => (current === 'good' ? null : 'good'))}>
                <MessageThumbIcon direction="up" selected={feedback === 'good'} />
              </MessageIconButton>
              <MessageIconButton label={labels.bad} pressed={feedback === 'bad'} onClick={() => setFeedback((current) => (current === 'bad' ? null : 'bad'))}>
                <MessageThumbIcon direction="down" selected={feedback === 'bad'} />
              </MessageIconButton>
              <MessageIconButton label={messageExpanded ? labels.collapseMessage : labels.expandMessage} expanded={messageExpanded} onClick={() => setMessageExpanded((current) => !current)}>
                <MessageExpandIcon collapsed={messageExpanded} />
              </MessageIconButton>
              {messageTimestamp && timestampSource ? <MessageTimestamp dateTime={timestampSource} value={messageTimestamp} /> : null}
            </>
          ) : null}
          {role === 'user' && longUserMessage ? (
            <MessageIconButton label={expanded ? labels.collapse : labels.expand} expanded={expanded} onClick={() => setExpanded((current) => !current)}>
              <MessageExpandIcon collapsed={expanded} />
            </MessageIconButton>
          ) : null}
          {canEdit ? (
            <MessageIconButton
              label={labels.edit}
              onClick={() => {
                setEditDraft(itemText);
                setEditError(null);
                setEditing(true);
              }}
            >
              <MessageEditIcon />
            </MessageIconButton>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

export function SafeMarkdown(props: {
  text: string;
  language?: SessionUiLanguage;
  resources?: ConversationResource[];
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
}) {
  const bounded = boundedMarkdownText(props.text);
  const labels = copy[props.language ?? 'en-US'];
  const resources = props.resources ?? emptyConversationResources;
  const language = props.language ?? 'en-US';
  const components = useMemo<Components>(() => ({
    a({children, href}) {
      const label = markdownNodeText(children);
      const resource = matchingInlineResource(resources, label, href ?? '');
      if (resource) {
        return <ConversationInlineResource resource={resource} label={label || resource.displayName} language={language} onOpenResource={props.onOpenResource}/>;
      }
      if (href?.startsWith('#')) return <a href={href}>{children}</a>;
      return <span className="session-markdown-unavailable-resource" title={href}>{children}</span>;
    },
    img({alt, src, title}) {
      const label = alt?.trim() || title?.trim() || (language === 'zh-CN' ? '图片' : 'Image');
      const resource = matchingInlineResource(resources, label, src ?? '');
      if (!resource || !isImageResource(resource)) {
        return <span className="session-markdown-image-unavailable" role="img" aria-label={label}>{language === 'zh-CN' ? `图片不可用：${label}` : `Image unavailable: ${label}`}</span>;
      }
      return (
        <ConversationMarkdownImage
          resource={resource}
          label={label}
          language={language}
          onOpenResource={props.onOpenResource}
          onLoadResourcePreview={props.onLoadResourcePreview}
        />
      );
    },
    pre({children}) {
      const code = markdownNodeText(children);
      return (
        <div className="session-code-block">
          <CopyIconButton label={labels.copyCode} copiedLabel={labels.copied} text={code}/>
          <pre>{children}</pre>
        </div>
      );
    },
  }), [labels.copied, labels.copyCode, language, props.onLoadResourcePreview, props.onOpenResource, resources]);
  return (
    <div className="session-markdown" data-truncated={bounded.truncated || undefined}>
      <Markdown
        components={components}
        remarkPlugins={[remarkGfm, [limitMarkdownComplexity, {label: labels.complexityTruncated}]]}
        urlTransform={(url) => url}
      >
        {boundMarkdownCodeBlocks(bounded.text)}
      </Markdown>
    </div>
  );
}

const emptyConversationResources: ConversationResource[] = [];

export function boundedMarkdownText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MARKDOWN_CHARACTERS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_MARKDOWN_CHARACTERS)}\n\n[content truncated]`, truncated: true };
}

export function boundedMarkdownBlockText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MARKDOWN_BLOCK_CHARACTERS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_MARKDOWN_BLOCK_CHARACTERS)}\n[block truncated]`, truncated: true };
}

interface MarkdownAstNode {
  type: string;
  children?: MarkdownAstNode[];
}

function limitMarkdownComplexity(options?: {label?: string}) {
  return (tree: MarkdownAstNode): void => {
    const rootChildren = tree.children ?? [];
    let truncated = rootChildren.length > MAX_MARKDOWN_BLOCKS;
    let remainingNodes = MAX_MARKDOWN_NODES;

    function limitNode(node: MarkdownAstNode): boolean {
      if (remainingNodes <= 0) return false;
      remainingNodes -= 1;
      if (!node.children) return true;
      const limitedChildren: MarkdownAstNode[] = [];
      for (const child of node.children) {
        if (!limitNode(child)) {
          truncated = true;
          break;
        }
        limitedChildren.push(child);
      }
      if (limitedChildren.length !== node.children.length) truncated = true;
      node.children = limitedChildren;
      return true;
    }

    tree.children = rootChildren.slice(0, MAX_MARKDOWN_BLOCKS).filter(limitNode);
    if (tree.children.length !== rootChildren.length) truncated = true;
    if (truncated) {
      tree.children.push({
        type: 'paragraph',
        children: [{type: 'text', value: options?.label ?? 'Content complexity truncated'} as MarkdownAstNode],
        data: {hProperties: {className: ['session-markdown-complexity-truncated'], role: 'status'}},
      } as MarkdownAstNode);
    }
  };
}

function boundMarkdownCodeBlocks(text: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const output: string[] = [];
  let fence: string | null = null;
  let codeCharacters = 0;
  let blockTruncated = false;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1] ?? null;
    if (!fence && marker) {
      fence = marker;
      codeCharacters = 0;
      blockTruncated = false;
      output.push(line);
      continue;
    }
    if (fence && marker?.startsWith(fence[0]!) && marker.length >= fence.length) {
      if (blockTruncated) output.push('[code block truncated]');
      output.push(line);
      fence = null;
      continue;
    }
    if (!fence) {
      output.push(line);
      continue;
    }
    const remaining = MAX_MARKDOWN_BLOCK_CHARACTERS - codeCharacters;
    if (remaining > 0) output.push(line.slice(0, remaining));
    codeCharacters += line.length + 1;
    if (codeCharacters > MAX_MARKDOWN_BLOCK_CHARACTERS) blockTruncated = true;
  }
  if (fence && blockTruncated) output.push('[code block truncated]');
  return output.join('\n');
}

function markdownNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(markdownNodeText).join('');
  if (!node || typeof node !== 'object' || !('props' in node)) return '';
  return markdownNodeText((node as {props?: {children?: ReactNode}}).props?.children);
}

function matchingInlineResource(resources: ConversationResource[], label: string, href: string): ConversationResource | null {
  return resources.find((resource) => resource.presentation === 'inline' && inlineResourceMatches(resource, label, href)) ?? null;
}

function isImageResource(resource: ConversationResource): boolean {
  return resource.kind === 'attachment' ? resource.previewKind === 'image' : resource.kind === 'file' && resource.iconKind === 'image';
}

function inlineResourceMatches(resource: ConversationResource, label: string, href: string): boolean {
  if (resource.kind === 'website') {
    try {
      return new URL(href).href === resource.url;
    } catch {
      return resource.displayName === label;
    }
  }
  if (resource.kind === 'attachment') return resource.displayName === label;
  const reference = decodeReferencePath(href);
  return (
    resource.displayName === label ||
    reference.endsWith(resource.projectRelativePath) ||
    reference.endsWith(`/${resource.projectRelativePath}`) ||
    reference
      .split('/')
      .pop()
      ?.replace(/(?::\d+(?::\d+)?)|(?:#L\d+(?:-L?\d+)?)$/u, '') === resource.projectRelativePath.split('/').pop()
  );
}

function decodeReferencePath(href: string): string {
  let value = href
    .replace(/^file:\/\//iu, '')
    .replace(/#L\d+(?:-L?\d+)?$/iu, '')
    .replace(/:\d+(?::\d+)?$/u, '');
  try {
    value = decodeURIComponent(value);
  } catch {
    // 保留原始 href 参与末尾匹配；非法编码不会得到打开权限。
  }
  return value;
}

export function itemRole(item: NativeSessionItemBuffer): ThreadItemRole {
  const type = normalizeType(item.type);
  if (type === 'usermessage' || type === 'user') return 'user';
  if (type === 'agentmessage' || type === 'assistantmessage' || type === 'assistant' || type === 'message') return 'assistant';
  if (type === 'reasoning' || type === 'plan' || type === 'commentary' || type === 'analysis') return 'commentary';
  if (type === 'filechange' || type === 'file') return 'file';
  if (['commandexecution', 'command', 'mcptoolcall', 'dynamictoolcall', 'websearch', 'imageview', 'toolcall', 'tool'].includes(type)) return 'tool';
  if (type.includes('request') || type.includes('approval')) return 'request';
  if (type === 'error' || type.endsWith('error') || item.status === 'failed') return 'error';
  return 'unknown';
}

export function transcriptItemText(item: NativeSessionItemBuffer): string {
  if (typeof item.payload.displayText === 'string' && item.payload.displayText.trim()) return item.payload.displayText;
  if (normalizeType(item.type) === 'reasoning') {
    if (item.text.trim()) return item.text;
    return transcriptTextFragments(item.payload.summary).join('\n\n');
  }
  if (item.text.trim()) return item.text;
  if (itemRole(item) !== 'commentary') return item.text;
  return transcriptTextFragments([item.payload.summary, item.payload.content]).join('\n\n');
}

function useBufferedTranscriptText(text: string, enabled: boolean): { text: string; revision: number } {
  const [visible, setVisible] = useState(() => ({ text, revision: 0 }));
  const visibleTextRef = useRef(text);
  const targetTextRef = useRef(text);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearTimers(): void {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    idleTimerRef.current = null;
    maxTimerRef.current = null;
  }

  function commitTarget(): void {
    clearTimers();
    const next = targetTextRef.current;
    if (next === visibleTextRef.current) return;
    visibleTextRef.current = next;
    setVisible((current) => ({ text: next, revision: current.revision + 1 }));
  }

  useEffect(() => {
    targetTextRef.current = text;
    const prefixCompatible = text.startsWith(visibleTextRef.current);
    if (!enabled || prefersReducedMotion() || !prefixCompatible) {
      commitTarget();
      return;
    }
    if (text === visibleTextRef.current) return;
    const pendingText = text.slice(visibleTextRef.current.length);
    if (hasSemanticFlushBoundary(pendingText)) {
      commitTarget();
      return;
    }
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(commitTarget, STREAM_IDLE_FLUSH_MS);
    maxTimerRef.current ??= setTimeout(commitTarget, STREAM_MAX_FLUSH_MS);
  }, [enabled, text]);

  useEffect(
    () => () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    },
    [],
  );

  return visible;
}

function hasSemanticFlushBoundary(value: string): boolean {
  return /(?:\n|[。！？；!?;](?:\s|$)|\.(?:\s|$))/u.test(value);
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function transcriptTextFragments(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => transcriptTextFragments(entry, depth + 1));
  if (!isRecord(value)) return [];
  return ['text', 'value', 'content', 'summary'].flatMap((key) => transcriptTextFragments(value[key], depth + 1));
}

function normalizeType(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_\-/]+/g, '');
}
function roleLabel(role: ThreadItemRole, labels: (typeof copy)[SessionUiLanguage]): string {
  return labels[role];
}

function TypedItemFacts(props: { item: NativeSessionItemBuffer; role: ThreadItemRole; language: SessionUiLanguage }) {
  if (props.role === 'user' || props.role === 'assistant' || props.role === 'commentary') return null;
  const facts = itemFacts(props.item, props.role);
  if (facts.length === 0 && props.role !== 'unknown') return null;
  return (
    <details className="session-item-facts">
      <summary>{copy[props.language].details}</summary>
      {facts.length > 0 ? (
        <dl>
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {props.role === 'unknown' || props.role === 'error' ? <pre>{safePayloadJson(props.item.payload)}</pre> : null}
    </details>
  );
}

function CommandExecutionItem(props: { item: NativeSessionItemBuffer; language: SessionUiLanguage }) {
  const payload = props.item.payload;
  const command = commandText(payload.command) ?? (props.item.text.trim() || null);
  const cwd = primitiveText(payload.cwd);
  const status = primitiveText(payload.status) ?? props.item.status;
  const exitCode = primitiveText(payload.exitCode);
  const duration = typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs) ? `${Math.max(0, Math.round(payload.durationMs))} ms` : null;
  const output = primitiveText(payload.aggregatedOutput ?? payload.output ?? payload.stdout ?? payload.stderr);
  const copyLabel = copy[props.language].copyCommand;
  const outputLabel = props.language === 'zh-CN' ? '命令输出' : 'Command output';
  const cwdLabel = props.language === 'zh-CN' ? '工作目录' : 'Working directory';

  return (
    <section className="session-command-item" aria-label={props.language === 'zh-CN' ? '命令执行' : 'Command execution'}>
      <details className="session-command-disclosure">
        <summary className="session-command-summary">
          <span className="session-command-terminal-icon" aria-hidden="true">
            <TerminalWindow weight="regular" />
          </span>
          <span className="session-command-summary-copy">
            <strong>{props.language === 'zh-CN' ? '命令执行' : 'Command execution'}</strong>
            {command ? <code>{command}</code> : null}
          </span>
          <span className="session-command-status" data-status={status}>
            {status}
          </span>
        </summary>
        <div className="session-command-body">
          {command ? <code className="session-command-line">{command}</code> : null}
          <dl className="session-command-meta">
            {cwd ? (
              <div>
                <dt>{cwdLabel}</dt>
                <dd>{cwd}</dd>
              </div>
            ) : null}
            <div>
              <dt>{props.language === 'zh-CN' ? '状态' : 'Status'}</dt>
              <dd>{status}</dd>
            </div>
            {duration ? (
              <div>
                <dt>{props.language === 'zh-CN' ? '耗时' : 'Duration'}</dt>
                <dd>{duration}</dd>
              </div>
            ) : null}
            {exitCode ? (
              <div>
                <dt>{props.language === 'zh-CN' ? '退出码' : 'Exit code'}</dt>
                <dd>{exitCode}</dd>
              </div>
            ) : null}
          </dl>
          {output ? (
            <section className="session-command-output" aria-label={outputLabel}>
              <strong>{outputLabel}</strong>
              <pre>{output}</pre>
            </section>
          ) : null}
        </div>
      </details>
      {command ? <CopyIconButton label={copyLabel} copiedLabel={copy[props.language].copied} text={command} /> : null}
    </section>
  );
}

function CopyIconButton(props: { label: string; copiedLabel: string; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="session-copy-button"
      aria-label={copied ? props.copiedLabel : props.label}
      title={copied ? props.copiedLabel : props.label}
      data-copied={copied || undefined}
      onClick={async () => setCopied(await copyText(props.text))}
    >
      {copied ? <MessageCheckIcon /> : <Copy aria-hidden="true" weight="regular" />}
    </button>
  );
}

function MessageIconButton(props: { label: string; pressed?: boolean; expanded?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="session-message-action-button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      aria-expanded={props.expanded === undefined ? undefined : props.expanded}
      data-selected={props.pressed || undefined}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function MessageTimestamp(props: { dateTime: string; value: string }) {
  return (
    <time className="session-message-timestamp" dateTime={props.dateTime}>
      {props.value}
    </time>
  );
}

function formatMessageTimestamp(item: NativeSessionItemBuffer, language: SessionUiLanguage): string | null {
  const source = item.updatedAt ?? primitiveText(item.payload.createdAt);
  if (!source) return null;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function commandText(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string' && Boolean(part.trim()));
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return primitiveText(value);
}

function itemFacts(item: NativeSessionItemBuffer, role: ThreadItemRole): Array<[string, string]> {
  const payload = item.payload;
  const pairs: Array<[string, unknown]> =
    role === 'file'
      ? [
          ['Path', payload.path ?? payload.filePath],
          ['Action', payload.action ?? payload.changeType],
          ['Status', payload.status ?? item.status],
        ]
      : role === 'tool'
        ? [
            ['Tool', payload.toolName ?? payload.name ?? payload.server],
            ['Command', Array.isArray(payload.command) ? payload.command.join(' ') : payload.command],
            ['Working directory', payload.cwd],
            ['Path', payload.path ?? payload.filePath ?? payload.imagePath],
            ['Query', payload.query],
            ['URL', payload.url],
            ['Status', payload.status ?? item.status],
          ]
        : role === 'error'
          ? [
              ['Code', payload.code],
              ['Message', payload.message ?? item.text],
              ['Status', item.status],
            ]
          : role === 'request'
            ? [
                ['Request', payload.requestType ?? payload.type ?? item.type],
                ['Status', item.status],
              ]
            : [
                ['Provider type', item.type],
                ['Status', item.status],
              ];
  return pairs.flatMap(([label, value]) => (primitiveText(value) ? [[label, primitiveText(value)!]] : []));
}

function ItemAttachments(props: { item: NativeSessionItemBuffer; label: string }) {
  if (props.item.resources.some((resource) => resource.kind === 'attachment' && resource.presentation === 'card')) return null;
  const raw = Array.isArray(props.item.payload.attachments) ? props.item.payload.attachments : [];
  const attachments = raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = primitiveText(entry.name ?? entry.path ?? entry.filePath);
    if (!name) return [];
    return [{ name, meta: [primitiveText(entry.mime ?? entry.mimeType), primitiveText(entry.status)].filter(Boolean).join(' · ') }];
  });
  return attachments.length ? (
    <section className="session-item-attachments" aria-label={props.label}>
      <ul>
        {attachments.map((entry, index) => (
          <li key={`${entry.name}-${index}`}>
            <span>{entry.name}</span>
            {entry.meta ? <small>{entry.meta}</small> : null}
          </li>
        ))}
      </ul>
    </section>
  ) : null;
}

function ItemImages(props: { item: NativeSessionItemBuffer; label: string }) {
  const images = Array.isArray(props.item.payload.images) ? props.item.payload.images : [];
  const safeImages = images.filter((value): value is string => typeof value === 'string' && (value.startsWith('data:image/') || value.startsWith('file://')));
  return safeImages.length > 0 ? (
    <div className="session-item-images">
      {safeImages.map((source) => (
        <img key={source} src={source} alt={props.label} loading="lazy" />
      ))}
    </div>
  ) : null;
}

function safePayloadJson(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2).slice(0, 20_000);
  } catch {
    return '[unavailable]';
  }
}
function primitiveText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export async function copyText(
  text: string,
  services: {
    writeNative?: (value: string) => Promise<{ written: boolean } | undefined>;
    writeWeb?: (value: string) => Promise<void>;
    writeLegacy?: (value: string) => boolean;
  } = {},
): Promise<boolean> {
  const writeNative = services.writeNative ?? ((value: string) => globalThis.window?.zeus?.writeClipboardText?.(value));
  try {
    const result = await writeNative(text);
    if (result?.written) return true;
  } catch {
    // 原生桥不可用时继续尝试浏览器与选区兜底。
  }
  const writeWeb = services.writeWeb ?? globalThis.navigator?.clipboard?.writeText?.bind(globalThis.navigator.clipboard);
  try {
    if (writeWeb) {
      await writeWeb(text);
      return true;
    }
  } catch {
    // file:// 页面通常没有 Clipboard API 权限，继续使用同步选区兜底。
  }
  return (services.writeLegacy ?? copyTextWithSelection)(text);
}

function copyTextWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false;
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.inset = '0 auto auto -10000px';
  textarea.style.opacity = '0';
  textarea.style.position = 'fixed';
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
  return copied;
}
