import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import type { ConversationFileLocation, ConversationOpenTarget, ConversationResource, ConversationResourcePreview } from '@zeus/shared';
import MarkdownRender, { setCustomComponents, type CustomComponentMap, type NodeComponentProps, type NodeRendererProps } from 'markstream-react';
import 'markstream-react/index.css';
import { memo, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ConversationInlineResource, ConversationMarkdownImage, isImageResource } from './ConversationResources.js';
import { MessageCheckIcon } from './SessionMessageIcons.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

export type ConversationMarkdownPhase = 'streaming' | 'final';

export function conversationMarkdownPhaseForStatus(status: string): ConversationMarkdownPhase {
  return status === 'completed' || status === 'failed' || status === 'interrupted' ? 'final' : 'streaming';
}

export const MAX_CONVERSATION_MARKDOWN_CHARACTERS = 200_000;
export const MAX_CONVERSATION_MARKDOWN_CODE_CHARACTERS = 50_000;
export const MAX_CONVERSATION_MARKDOWN_TOP_LEVEL_NODES = 512;
export const MAX_CONVERSATION_MARKDOWN_NODES = 4_096;

const CUSTOM_COMPONENTS_ID = 'zeus-conversation-markdown';
const EMPTY_RESOURCES: ConversationResource[] = [];
const CHILD_ARRAY_FIELDS = ['children', 'items', 'rows', 'cells', 'term', 'definition'] as const;
const SMOOTH_STREAMING_OPTIONS = {
  minCharsPerSecond: 1_200,
  maxCharsPerSecond: 100_000,
  targetLatencyMs: 80,
  catchUpLatencyMs: 32,
  catchUpThreshold: 64,
  maxCommitFps: 60,
  startDelayMs: 0,
  maxCharsPerCommit: 2_048,
  flushOnFinish: true,
} as const;

const labels = {
  'zh-CN': {
    copied: '已复制',
    copyCode: '复制代码',
    image: '图片',
    imageUnavailable: '图片不可用',
    contentTruncated: '内容过于复杂，已截断',
    codeTruncated: '代码块过长，已截断',
  },
  'en-US': {
    copied: 'Copied',
    copyCode: 'Copy code',
    image: 'Image',
    imageUnavailable: 'Image unavailable',
    contentTruncated: 'Content complexity truncated',
    codeTruncated: 'Code block truncated',
  },
} as const;

export interface ConversationMarkdownProps {
  text: string;
  streamId: string;
  phase: ConversationMarkdownPhase;
  language: SessionUiLanguage;
  resources?: ConversationResource[];
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  onVisibleContentChange?: () => void;
  onRenderSettled?: () => void;
}

interface MarkdownRuntimeContextValue {
  language: SessionUiLanguage;
  resources: ConversationResource[];
  onOpenResource?: ConversationMarkdownProps['onOpenResource'];
  onLoadResourcePreview?: ConversationMarkdownProps['onLoadResourcePreview'];
}

interface MarkstreamNode {
  type: string;
  raw?: string;
  loading?: boolean;
  content?: string;
  text?: string;
  code?: string;
  href?: string;
  src?: string;
  alt?: string;
  title?: string | null;
  language?: string;
  header?: MarkstreamNode | boolean;
  children?: MarkstreamNode[];
  items?: MarkstreamNode[];
  rows?: MarkstreamNode[];
  cells?: MarkstreamNode[];
  term?: MarkstreamNode[];
  definition?: MarkstreamNode[];
  [key: string]: unknown;
}

const MarkdownRuntimeContext = createContext<MarkdownRuntimeContextValue | null>(null);

export const ConversationMarkdown = memo(function ConversationMarkdown(props: ConversationMarkdownProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onVisibleContentChangeRef = useRef(props.onVisibleContentChange);
  const onRenderSettledRef = useRef(props.onRenderSettled);
  const settledNotificationRef = useRef<string | null>(null);
  const [settled, setSettled] = useState(false);
  const languageLabels = labels[props.language];
  onVisibleContentChangeRef.current = props.onVisibleContentChange;
  onRenderSettledRef.current = props.onRenderSettled;

  const bounded = useMemo(() => boundConversationMarkdown(props.text, props.language), [props.language, props.text]);
  const parseOptions = useMemo<NonNullable<NodeRendererProps['parseOptions']>>(
    () => ({
      reuseStableTopLevelNodes: true,
      streamParse: 'auto',
      // 所有链接都进入 Zeus 自定义节点；节点仅在页内锚点或权威资源匹配成功后才会变为可点击。
      validateLink: (href: string) => Boolean(href.trim()),
      postTransformNodes: (nodes: MarkstreamNode[]) => limitParsedNodes(nodes, languageLabels.contentTruncated),
    }),
    [languageLabels.contentTruncated],
  );
  const contextValue = useMemo<MarkdownRuntimeContextValue>(
    () => ({
      language: props.language,
      resources: props.resources ?? EMPTY_RESOURCES,
      onOpenResource: props.onOpenResource,
      onLoadResourcePreview: props.onLoadResourcePreview,
    }),
    [props.language, props.onLoadResourcePreview, props.onOpenResource, props.resources],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        onVisibleContentChangeRef.current?.();
      });
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const notificationKey = `${props.streamId}:${bounded.text}`;
    setSettled(false);
    if (props.phase !== 'final') {
      settledNotificationRef.current = null;
      return;
    }
    let frame = 0;
    const inspect = () => {
      frame = 0;
      const renderSettled = !root.querySelector('.node-placeholder');
      setSettled(renderSettled);
      if (renderSettled && settledNotificationRef.current !== notificationKey) {
        settledNotificationRef.current = notificationKey;
        onRenderSettledRef.current?.();
      }
    };
    const scheduleInspect = () => {
      if (!frame) frame = requestAnimationFrame(inspect);
    };
    const observer = new MutationObserver(scheduleInspect);
    observer.observe(root, { childList: true, subtree: true });
    scheduleInspect();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [bounded.text, props.phase, props.streamId]);

  return (
    <MarkdownRuntimeContext.Provider value={contextValue}>
      <div
        ref={rootRef}
        className="session-markdown zeus-fidelity-markdown session-conversation-markdown"
        data-markdown-phase={props.phase}
        data-render-settled={settled || undefined}
        data-stream-id={props.streamId}
        data-truncated={bounded.truncated || undefined}
      >
        <MarkdownRender
          content={bounded.text}
          final={props.phase === 'final'}
          parseOptions={parseOptions}
          customId={CUSTOM_COMPONENTS_ID}
          indexKey={props.streamId}
          htmlPolicy="escape"
          typewriter={false}
          fade={false}
          smoothStreaming
          smoothStreamingOptions={SMOOTH_STREAMING_OPTIONS}
          batchRendering
          initialRenderBatchSize={24}
          renderBatchSize={16}
          renderBatchDelay={8}
          renderBatchBudgetMs={4}
          renderBatchIdleTimeoutMs={64}
          deferNodesUntilVisible={false}
          maxLiveNodes={0}
          renderCodeBlocksAsPre
          codeBlockStream={false}
          showTooltips={false}
        />
      </div>
    </MarkdownRuntimeContext.Provider>
  );
});

function SecureLinkNode(props: NodeComponentProps<MarkstreamNode>) {
  const runtime = useContext(MarkdownRuntimeContext);
  const href = typeof props.node.href === 'string' ? props.node.href : '';
  const label = typeof props.node.text === 'string' && props.node.text ? props.node.text : href;
  if (!runtime || props.node.loading || !href) {
    return <span className="session-markdown-unavailable-resource">{label}</span>;
  }
  const resource = matchingInlineResource(runtime.resources, label, href);
  if (resource) {
    return <ConversationInlineResource resource={resource} label={label || resource.displayName} language={runtime.language} onOpenResource={runtime.onOpenResource} />;
  }
  if (href.startsWith('#')) return <a href={href}>{label}</a>;
  return (
    <span className="session-markdown-unavailable-resource" title={href}>
      {label}
    </span>
  );
}

function SecureImageNode(props: NodeComponentProps<MarkstreamNode>) {
  const runtime = useContext(MarkdownRuntimeContext);
  const src = typeof props.node.src === 'string' ? props.node.src : '';
  const fallbackLabel = runtime?.language === 'zh-CN' ? labels['zh-CN'].image : labels['en-US'].image;
  const label = (typeof props.node.alt === 'string' && props.node.alt.trim()) || (typeof props.node.title === 'string' && props.node.title.trim()) || fallbackLabel;
  const resource = runtime && !props.node.loading ? matchingInlineResource(runtime.resources, label, src) : null;
  if (!runtime || !resource || !isImageResource(resource)) {
    const unavailableLabel = runtime?.language === 'zh-CN' ? labels['zh-CN'].imageUnavailable : labels['en-US'].imageUnavailable;
    return (
      <span className="session-markdown-image-unavailable" role="img" aria-label={label}>
        {`${unavailableLabel}：${label}`}
      </span>
    );
  }
  return <ConversationMarkdownImage resource={resource} label={label} language={runtime.language} onOpenResource={runtime.onOpenResource} onLoadResourcePreview={runtime.onLoadResourcePreview} />;
}

function SecureCodeBlockNode(props: NodeComponentProps<MarkstreamNode>) {
  const runtime = useContext(MarkdownRuntimeContext);
  const language = runtime?.language ?? 'en-US';
  const languageLabels = labels[language];
  const sourceCode = typeof props.node.code === 'string' ? props.node.code : '';
  const codeTruncated = sourceCode.length > MAX_CONVERSATION_MARKDOWN_CODE_CHARACTERS;
  const code = sourceCode.slice(0, MAX_CONVERSATION_MARKDOWN_CODE_CHARACTERS);
  return (
    <div className="session-code-block" data-language={typeof props.node.language === 'string' ? props.node.language : undefined} aria-busy={props.node.loading || undefined}>
      <ConversationMarkdownCopyButton label={languageLabels.copyCode} copiedLabel={languageLabels.copied} text={code} />
      <pre>
        <code>{code}</code>
      </pre>
      {codeTruncated ? <small className="session-markdown-code-truncated">{languageLabels.codeTruncated}</small> : null}
    </div>
  );
}

function PlainMathNode(props: NodeComponentProps<MarkstreamNode>) {
  const content = typeof props.node.raw === 'string' ? props.node.raw : typeof props.node.content === 'string' ? props.node.content : '';
  return props.node.type === 'math_block' ? <pre className="session-markdown-math-plain">{content}</pre> : <span className="session-markdown-math-plain">{content}</span>;
}

const customComponents = {
  link: SecureLinkNode,
  image: SecureImageNode,
  code_block: SecureCodeBlockNode,
  mermaid: SecureCodeBlockNode,
  infographic: SecureCodeBlockNode,
  d2: SecureCodeBlockNode,
  d2lang: SecureCodeBlockNode,
  math_inline: PlainMathNode,
  math_block: PlainMathNode,
} as unknown as CustomComponentMap;

setCustomComponents(CUSTOM_COMPONENTS_ID, customComponents);

function ConversationMarkdownCopyButton(props: { label: string; copiedLabel: string; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_400);
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

function boundConversationMarkdown(text: string, language: SessionUiLanguage): { text: string; truncated: boolean } {
  const languageLabels = labels[language];
  const documentTruncated = text.length > MAX_CONVERSATION_MARKDOWN_CHARACTERS;
  const boundedText = documentTruncated ? `${text.slice(0, MAX_CONVERSATION_MARKDOWN_CHARACTERS)}\n\n[${languageLabels.contentTruncated}]` : text;
  const codeBounded = boundMarkdownCodeBlocks(boundedText, languageLabels.codeTruncated);
  return { text: codeBounded.text, truncated: documentTruncated || codeBounded.truncated };
}

function boundMarkdownCodeBlocks(text: string, truncationLabel: string): { text: string; truncated: boolean } {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const output: string[] = [];
  let fence: string | null = null;
  let codeCharacters = 0;
  let blockTruncated = false;
  let truncated = false;
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
      if (blockTruncated) output.push(`[${truncationLabel}]`);
      output.push(line);
      fence = null;
      continue;
    }
    if (!fence) {
      output.push(line);
      continue;
    }
    const remaining = MAX_CONVERSATION_MARKDOWN_CODE_CHARACTERS - codeCharacters;
    if (remaining > 0) output.push(line.slice(0, remaining));
    codeCharacters += line.length + 1;
    if (codeCharacters > MAX_CONVERSATION_MARKDOWN_CODE_CHARACTERS) {
      blockTruncated = true;
      truncated = true;
    }
  }
  if (fence && blockTruncated) output.push(`[${truncationLabel}]`);
  return { text: output.join('\n'), truncated };
}

function limitParsedNodes<T>(rawNodes: T, truncationLabel: string): T {
  if (!Array.isArray(rawNodes)) return rawNodes;
  const nodes = rawNodes as MarkstreamNode[];
  const totalNodes = countNodes(nodes, MAX_CONVERSATION_MARKDOWN_NODES + 1);
  if (nodes.length <= MAX_CONVERSATION_MARKDOWN_TOP_LEVEL_NODES && totalNodes <= MAX_CONVERSATION_MARKDOWN_NODES) return rawNodes;

  const budget = { remaining: MAX_CONVERSATION_MARKDOWN_NODES - 2, truncated: nodes.length > MAX_CONVERSATION_MARKDOWN_TOP_LEVEL_NODES };
  const limited: MarkstreamNode[] = [];
  for (const node of nodes.slice(0, MAX_CONVERSATION_MARKDOWN_TOP_LEVEL_NODES - 1)) {
    if (budget.remaining < minimumNodeCost(node)) {
      budget.truncated = true;
      break;
    }
    limited.push(limitNode(node, budget));
    if (budget.remaining <= 0) break;
  }
  if (limited.length < nodes.length) budget.truncated = true;
  if (budget.truncated) {
    limited.push({
      type: 'paragraph',
      raw: truncationLabel,
      children: [{ type: 'text', raw: truncationLabel, content: truncationLabel }],
    });
  }
  return limited as T;
}

function limitNode(node: MarkstreamNode, budget: { remaining: number; truncated: boolean }): MarkstreamNode {
  budget.remaining -= 1;
  const limited: MarkstreamNode = { ...node };
  if (isMarkstreamNode(node.header)) limited.header = limitNode(node.header, budget);
  for (const field of CHILD_ARRAY_FIELDS) {
    const children = node[field];
    if (!Array.isArray(children)) continue;
    const limitedChildren: MarkstreamNode[] = [];
    for (const child of children) {
      if (budget.remaining < minimumNodeCost(child)) {
        budget.truncated = true;
        break;
      }
      limitedChildren.push(limitNode(child, budget));
    }
    if (limitedChildren.length < children.length) budget.truncated = true;
    limited[field] = limitedChildren;
  }
  return limited;
}

function minimumNodeCost(node: MarkstreamNode): number {
  return isMarkstreamNode(node.header) ? 2 : 1;
}

function countNodes(nodes: MarkstreamNode[], stopAfter: number): number {
  let count = 0;
  const visit = (node: MarkstreamNode) => {
    count += 1;
    if (count >= stopAfter) return;
    if (isMarkstreamNode(node.header)) visit(node.header);
    for (const field of CHILD_ARRAY_FIELDS) {
      const children = node[field];
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        visit(child);
        if (count >= stopAfter) return;
      }
    }
  };
  for (const node of nodes) {
    visit(node);
    if (count >= stopAfter) break;
  }
  return count;
}

function isMarkstreamNode(value: unknown): value is MarkstreamNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string';
}

function matchingInlineResource(resources: ConversationResource[], label: string, href: string): ConversationResource | null {
  return resources.find((resource) => resource.presentation === 'inline' && inlineResourceMatches(resource, label, href)) ?? null;
}

function inlineResourceHrefMatches(resource: ConversationResource, href: string): boolean {
  if (resource.presentation !== 'inline') return false;
  if (resource.kind === 'website') {
    try {
      return new URL(href).href === resource.url;
    } catch {
      return false;
    }
  }
  if (resource.kind === 'attachment') return false;
  const reference = decodeReferencePath(href);
  return (
    reference.endsWith(resource.projectRelativePath) ||
    reference.endsWith(`/${resource.projectRelativePath}`) ||
    reference
      .split('/')
      .pop()
      ?.replace(/(?::\d+(?::\d+)?)|(?:#L\d+(?:-L?\d+)?)$/u, '') === resource.projectRelativePath.split('/').pop()
  );
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
  return resource.displayName === label || inlineResourceHrefMatches(resource, href);
}

function decodeReferencePath(href: string): string {
  let value = href
    .replace(/^file:\/\//iu, '')
    .replace(/#L\d+(?:-L?\d+)?$/iu, '')
    .replace(/:\d+(?::\d+)?$/u, '');
  try {
    value = decodeURIComponent(value);
  } catch {
    // 非法编码保留原值，且仍需匹配权威资源后才能获得打开权限。
  }
  return value;
}

async function copyText(text: string): Promise<boolean> {
  try {
    const result = await globalThis.window?.zeus?.writeClipboardText?.(text);
    if (result?.written) return true;
  } catch {
    // 原生桥不可用时继续尝试浏览器剪贴板。
  }
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // file:// 页面通常没有 Clipboard API 权限，继续使用同步选区兜底。
  }
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.inset = '0 auto auto -10000px';
  textarea.style.opacity = '0';
  textarea.style.position = 'fixed';
  document.body.append(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}
