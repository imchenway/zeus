import {
    type FormEvent,
    Fragment,
    type KeyboardEvent,
    type ReactNode,
    useEffect,
    useLayoutEffect,
    useRef,
    useState
} from 'react';
import {CopyIcon as Copy} from '@phosphor-icons/react/dist/csr/Copy';
import {TerminalWindowIcon as TerminalWindow} from '@phosphor-icons/react/dist/csr/TerminalWindow';
import {MessageCheckIcon, MessageEditIcon, MessageExpandIcon, MessageThumbIcon} from './SessionMessageIcons.js';
import type {NativeSessionItemBuffer} from './sessionTypes.js';
import {autosizeTextarea} from './textareaAutosize.js';

export type SessionUiLanguage = 'zh-CN' | 'en-US';
export type ThreadItemRole = 'user' | 'assistant' | 'commentary' | 'tool' | 'file' | 'request' | 'error' | 'unknown';
export const MAX_MARKDOWN_CHARACTERS = 200_000;
export const MAX_MARKDOWN_BLOCK_CHARACTERS = 50_000;
export const MAX_MARKDOWN_BLOCKS = 512;
export const MAX_MARKDOWN_NODES = 4_096;

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
  const role = itemRole(props.item);
  const itemText = transcriptItemText(props.item);
  const longUserMessage = role === 'user' && itemText.length > 640;
  const visibleText = longUserMessage && !expanded ? `${itemText.slice(0, 620).trimEnd()}…` : itemText;
  const label = roleLabel(role, labels);
  const commentary = role === 'commentary';
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
                    {editError ? <small role="alert">{editError}</small> : <span/>}
                    <button type="button" onClick={cancelEditing} disabled={submittingEdit}>
                        {labels.cancelEdit}
                    </button>
                    <button type="submit" className="session-user-message-editor-submit"
                            disabled={!editDraft.trim() || submittingEdit}>
                        {labels.sendEdit}
                    </button>
                </footer>
            </form>
        ) : command ? (
        <CommandExecutionItem item={props.item} language={props.language} />
      ) : commentary && visibleText ? (
            <div className="session-commentary-flow">
          <SafeMarkdown text={visibleText} language={props.language} />
            </div>
      ) : visibleText ? (
        <SafeMarkdown text={visibleText} language={props.language} />
      ) : role === 'assistant' && props.item.status !== 'completed' ? (
        <span className="session-thinking-indicator">{labels.thinking}</span>
      ) : null}
      {!command ? <TypedItemFacts item={props.item} role={role} language={props.language} /> : null}
      <ItemAttachments item={props.item} label={labels.attachments} />
      <ItemImages item={props.item} label={labels.image} />
      {hasActions ? (
          <footer className="session-thread-item-actions" data-message-actions={role}>
              {role === 'user' && messageTimestamp && timestampSource ?
                  <MessageTimestamp dateTime={timestampSource} value={messageTimestamp}/> : null}
              {visibleText ? <CopyIconButton label={labels.copy} copiedLabel={labels.copied} text={itemText}/> : null}
              {role === 'assistant' ? (
                  <>
                      <MessageIconButton label={labels.good} pressed={feedback === 'good'}
                                         onClick={() => setFeedback((current) => (current === 'good' ? null : 'good'))}>
                          <MessageThumbIcon direction="up" selected={feedback === 'good'}/>
                      </MessageIconButton>
                      <MessageIconButton label={labels.bad} pressed={feedback === 'bad'}
                                         onClick={() => setFeedback((current) => (current === 'bad' ? null : 'bad'))}>
                          <MessageThumbIcon direction="down" selected={feedback === 'bad'}/>
                      </MessageIconButton>
                      <MessageIconButton label={messageExpanded ? labels.collapseMessage : labels.expandMessage}
                                         expanded={messageExpanded}
                                         onClick={() => setMessageExpanded((current) => !current)}>
                          <MessageExpandIcon collapsed={messageExpanded}/>
                      </MessageIconButton>
                      {messageTimestamp && timestampSource ?
                          <MessageTimestamp dateTime={timestampSource} value={messageTimestamp}/> : null}
                  </>
          ) : null}
              {role === 'user' && longUserMessage ? (
                  <MessageIconButton label={expanded ? labels.collapse : labels.expand} expanded={expanded}
                                     onClick={() => setExpanded((current) => !current)}>
                      <MessageExpandIcon collapsed={expanded}/>
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
                      <MessageEditIcon/>
                  </MessageIconButton>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

export function SafeMarkdown(props: { text: string; language?: SessionUiLanguage }) {
  const bounded = boundedMarkdownText(props.text);
  const labels = copy[props.language ?? 'en-US'];
    const rendered = markdownBlocks(bounded.text, labels.copyCode, labels.copied, labels.complexityTruncated);
  return (
    <div className="session-markdown" data-truncated={bounded.truncated || rendered.truncated || undefined}>
      {rendered.blocks}
    </div>
  );
}

export function boundedMarkdownText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MARKDOWN_CHARACTERS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_MARKDOWN_CHARACTERS)}\n\n[content truncated]`, truncated: true };
}

export function boundedMarkdownBlockText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MARKDOWN_BLOCK_CHARACTERS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_MARKDOWN_BLOCK_CHARACTERS)}\n[block truncated]`, truncated: true };
}

interface MarkdownComplexityBudget {
  blocks: number;
  nodes: number;
  truncated: boolean;
}

function markdownBlocks(text: string, copyCodeLabel: string, copiedLabel: string, complexityTruncatedLabel: string): {
    blocks: ReactNode[];
    truncated: boolean
} {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  const budget: MarkdownComplexityBudget = { blocks: 0, nodes: 0, truncated: false };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith('```')) {
      if (!beginMarkdownBlock(budget, 4)) break;
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      let characters = 0;
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        const next = lines[index] ?? '';
        if (characters < MAX_MARKDOWN_BLOCK_CHARACTERS) codeLines.push(next.slice(0, Math.max(0, MAX_MARKDOWN_BLOCK_CHARACTERS - characters)));
        characters += next.length + 1;
        index += 1;
      }
      if (index < lines.length) index += 1;
      const code = `${codeLines.join('\n')}${characters > MAX_MARKDOWN_BLOCK_CHARACTERS ? '\n[code block truncated]' : ''}`;
      blocks.push(
        <div className="session-code-block" key={`code-${index}`}>
            <CopyIconButton label={copyCodeLabel} copiedLabel={copiedLabel} text={code}/>
          <pre data-language={language || undefined}>
            <code>{code}</code>
          </pre>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      if (!beginMarkdownBlock(budget)) break;
      blocks.push(<hr key={`hr-${index}`} />);
      index += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      if (!beginMarkdownBlock(budget)) break;
      const level = heading[1]?.length ?? 1;
      const content = inlineMarkdown(boundedMarkdownBlockText(heading[2] ?? '').text, `heading-${index}`, budget);
      blocks.push(level === 1 ? <h1 key={`h-${index}`}>{content}</h1> : level === 2 ? <h2 key={`h-${index}`}>{content}</h2> : level === 3 ? <h3 key={`h-${index}`}>{content}</h3> : <h4 key={`h-${index}`}>{content}</h4>);
      index += 1;
      if (budget.truncated) break;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!beginMarkdownBlock(budget)) break;
      const items: ReactNode[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index] ?? '')) {
        if (!takeMarkdownNode(budget)) break;
        const value = boundedMarkdownBlockText((lines[index] ?? '').replace(/^[-*]\s+/, '')).text;
        items.push(<li key={`li-${index}`}>{inlineMarkdown(value, `li-${index}`, budget)}</li>);
        index += 1;
        if (budget.truncated) break;
      }
      blocks.push(<ul key={`ul-${index}`}>{items}</ul>);
      if (budget.truncated) break;
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      if (!beginMarkdownBlock(budget)) break;
      const items: ReactNode[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index] ?? '')) {
        if (!takeMarkdownNode(budget)) break;
        const value = boundedMarkdownBlockText((lines[index] ?? '').replace(/^\d+\.\s+/, '')).text;
        items.push(<li key={`oli-${index}`}>{inlineMarkdown(value, `oli-${index}`, budget)}</li>);
        index += 1;
        if (budget.truncated) break;
      }
      blocks.push(<ol key={`ol-${index}`}>{items}</ol>);
      if (budget.truncated) break;
      continue;
    }
    if (line.startsWith('> ')) {
      if (!beginMarkdownBlock(budget)) break;
      blocks.push(<blockquote key={`quote-${index}`}>{inlineMarkdown(boundedMarkdownBlockText(line.slice(2)).text, `quote-${index}`, budget)}</blockquote>);
      index += 1;
      if (budget.truncated) break;
      continue;
    }
    if (!beginMarkdownBlock(budget)) break;
    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim() && !startsMarkdownBlock(lines[index] ?? '')) {
      paragraphLines.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{inlineMarkdown(boundedMarkdownBlockText(paragraphLines.join('\n')).text, `p-${index}`, budget)}</p>);
    if (budget.truncated) break;
  }
  if (budget.truncated) {
    blocks.push(
      <p className="session-markdown-complexity-truncated" role="status" key="complexity-truncated">
        {complexityTruncatedLabel}
      </p>,
    );
  }
  return { blocks, truncated: budget.truncated };
}

function beginMarkdownBlock(budget: MarkdownComplexityBudget, nodes = 1): boolean {
  if (budget.blocks >= MAX_MARKDOWN_BLOCKS || budget.nodes + nodes > MAX_MARKDOWN_NODES) {
    budget.truncated = true;
    return false;
  }
  budget.blocks += 1;
  budget.nodes += nodes;
  return true;
}

function takeMarkdownNode(budget: MarkdownComplexityBudget): boolean {
  if (budget.nodes >= MAX_MARKDOWN_NODES) {
    budget.truncated = true;
    return false;
  }
  budget.nodes += 1;
  return true;
}

function startsMarkdownBlock(line: string): boolean {
  return /^(#{1,4})\s+|^```|^[-*]\s+|^\d+\.\s+|^>\s+/.test(line) || /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function inlineMarkdown(text: string, keyPrefix: string, budget: MarkdownComplexityBudget): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;
  while ((match = tokenPattern.exec(text))) {
    if (match.index > cursor) {
      if (!takeMarkdownNode(budget)) break;
      nodes.push(<Fragment key={`${keyPrefix}-text-${tokenIndex}`}>{text.slice(cursor, match.index)}</Fragment>);
    }
    if (!takeMarkdownNode(budget)) break;
    const token = match[0];
    if (token.startsWith('`')) nodes.push(<code key={`${keyPrefix}-code-${tokenIndex}`}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={`${keyPrefix}-strong-${tokenIndex}`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('*') || token.startsWith('_')) nodes.push(<em key={`${keyPrefix}-em-${tokenIndex}`}>{token.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = link?.[2] ?? '';
      nodes.push(
        isSafeLink(href) ? (
          <a key={`${keyPrefix}-link-${tokenIndex}`} href={href} target="_blank" rel="noreferrer">
            {link?.[1]}
          </a>
        ) : (
          <Fragment key={`${keyPrefix}-unsafe-${tokenIndex}`}>{link?.[1] ?? token}</Fragment>
        ),
      );
    }
    cursor = match.index + token.length;
    tokenIndex += 1;
  }
  if (!budget.truncated && cursor < text.length && takeMarkdownNode(budget)) nodes.push(<Fragment key={`${keyPrefix}-tail`}>{text.slice(cursor)}</Fragment>);
  return nodes;
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
  if (item.text.trim()) return item.text;
  if (itemRole(item) !== 'commentary') return item.text;
  return transcriptTextFragments([item.payload.summary, item.payload.content]).join('\n\n');
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
            <TerminalWindow weight="regular"/>
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
        {command ? <CopyIconButton label={copyLabel} copiedLabel={copy[props.language].copied} text={command}/> : null}
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
            {copied ? <MessageCheckIcon/> : <Copy aria-hidden="true" weight="regular"/>}
        </button>
    );
}

function MessageIconButton(props: {
    label: string;
    pressed?: boolean;
    expanded?: boolean;
    onClick: () => void;
    children: ReactNode
}) {
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
    return new Intl.DateTimeFormat(language, {hour: '2-digit', minute: '2-digit', hour12: false}).format(date);
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
function isSafeLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
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
