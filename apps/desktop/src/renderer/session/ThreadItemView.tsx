import { Fragment, useState, type ReactNode } from 'react';
import type { NativeSessionItemBuffer } from './sessionTypes.js';

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
    copyCode: '复制代码',
    edit: '复用并编辑',
    image: '会话图片',
    progress: '展开工作进度',
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
    copyCode: 'Copy code',
    edit: 'Edit and resend',
    image: 'Conversation image',
    progress: 'Show work progress',
    attachments: 'Attachments',
    details: 'Technical details',
    complexityTruncated: 'Content complexity truncated',
  },
} as const;

export interface ThreadItemViewProps {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  isLatest?: boolean;
  isLatestUser?: boolean;
  onEdit?: (item: NativeSessionItemBuffer) => void;
  onRetry?: (item: NativeSessionItemBuffer) => void;
}

export function ThreadItemView(props: ThreadItemViewProps) {
  const labels = copy[props.language];
  const [expanded, setExpanded] = useState(false);
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
  const hasActions = Boolean(visibleText) || longUserMessage || (role === 'user' && props.isLatestUser && props.onEdit);

  return (
    <article
      className={`session-thread-item session-thread-item-${role}${props.isLatest ? ' is-latest' : ''}`}
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
      {command ? (
        <CommandExecutionItem item={props.item} language={props.language} />
      ) : commentary && visibleText ? (
        <details className="session-progress-details">
          <summary>{labels.progress}</summary>
          <SafeMarkdown text={visibleText} language={props.language} />
        </details>
      ) : visibleText ? (
        <SafeMarkdown text={visibleText} language={props.language} />
      ) : role === 'assistant' && props.item.status !== 'completed' ? (
        <span className="session-thinking-indicator">{labels.thinking}</span>
      ) : null}
      {!command ? <TypedItemFacts item={props.item} role={role} language={props.language} /> : null}
      <ItemAttachments item={props.item} label={labels.attachments} />
      <ItemImages item={props.item} label={labels.image} />
      {hasActions ? (
        <footer className="session-thread-item-actions">
          {visibleText ? (
            <button type="button" onClick={() => void copyText(itemText)}>
              {labels.copy}
            </button>
          ) : null}
          {longUserMessage ? (
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
              {expanded ? labels.collapse : labels.expand}
            </button>
          ) : null}
          {role === 'user' && props.isLatestUser && props.onEdit ? (
            <button type="button" onClick={() => props.onEdit?.(props.item)}>
              {labels.edit}
            </button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

export function SafeMarkdown(props: { text: string; language?: SessionUiLanguage }) {
  const bounded = boundedMarkdownText(props.text);
  const labels = copy[props.language ?? 'en-US'];
  const rendered = markdownBlocks(bounded.text, labels.copyCode, labels.complexityTruncated);
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

function markdownBlocks(text: string, copyCodeLabel: string, complexityTruncatedLabel: string): { blocks: ReactNode[]; truncated: boolean } {
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
          <button type="button" aria-label={copyCodeLabel} onClick={() => void copyText(code)}>
            {copyCodeLabel}
          </button>
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
  const copyLabel = copy[props.language].copy;
  const outputLabel = props.language === 'zh-CN' ? '命令输出' : 'Command output';
  const cwdLabel = props.language === 'zh-CN' ? '工作目录' : 'Working directory';

  return (
    <section className="session-command-item" aria-label={props.language === 'zh-CN' ? '命令执行' : 'Command execution'}>
      {command ? (
        <div className="session-command-line">
          <code>{command}</code>
          <button type="button" aria-label={copyLabel} onClick={() => void copyText(command)}>
            {copyLabel}
          </button>
        </div>
      ) : null}
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
        <details className="session-command-output">
          <summary>{outputLabel}</summary>
          <pre>{output}</pre>
        </details>
      ) : null}
    </section>
  );
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
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* 剪贴板不可用时，消息仍可由用户手动选择。 */
  }
}
