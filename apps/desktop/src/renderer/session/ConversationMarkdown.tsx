import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import type { ConversationFileLocation, ConversationOpenTarget, ConversationResource, ConversationResourcePreview } from '@zeus/shared';
import { conversationFileLocationFromReference } from '@zeus/shared';
import MarkdownRender, { MermaidBlockNode, TableNode, setCustomComponents, type CustomComponentMap, type NodeComponentProps, type NodeRendererProps } from 'markstream-react';
import 'markstream-react/index.css';
import { memo, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
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
const STRUCTURED_CUSTOM_COMPONENTS_ID = 'zeus-conversation-markdown-structured';
const EMPTY_RESOURCES: ConversationResource[] = [];
const CHILD_ARRAY_FIELDS = ['children', 'items', 'rows', 'cells', 'term', 'definition'] as const;
/** 图表复用按需加载的原生预览，禁止正文开启脚本、链接交互或导出入口。 */
const MERMAID_OPTIONS = { isStrict: true, enableMermaidInteractions: false, showCopyButton: false, showExportButton: false, showFullscreenButton: false, showCollapseButton: false, showTooltips: false } as const;
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
    copyTable: '复制表格 Markdown',
    copyDiagram: '复制图表源码',
    copyFailed: '复制失败，请重试',
    image: '图片',
    imageUnavailable: '图片不可用',
    contentTruncated: '内容过于复杂，已截断',
    codeTruncated: '代码块过长，已截断',
    diagramRuntimeUnavailable: '图表运行库未加载，只能显示源码',
    diagramRenderFailed: '图表渲染失败：',
    diagramNotRendered: '图表没有渲染出来，已回退为源码',
  },
  'en-US': {
    copied: 'Copied',
    copyCode: 'Copy code',
    copyTable: 'Copy table Markdown',
    copyDiagram: 'Copy diagram source',
    copyFailed: 'Copy failed, try again',
    image: 'Image',
    imageUnavailable: 'Image unavailable',
    contentTruncated: 'Content complexity truncated',
    codeTruncated: 'Code block truncated',
    diagramRuntimeUnavailable: 'Diagram runtime unavailable; showing source',
    diagramRenderFailed: 'Diagram failed to render: ',
    diagramNotRendered: 'Diagram did not render; showing source',
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
  /** 用户消息中的结构化引用标签，按原标签文本渲染为胶囊而不是普通 Markdown 文本。 */
  structuredTokens?: readonly StructuredMessageToken[];
  /** 已冻结的短文档可一次呈现，长会话继续按批次渲染。 */
  renderImmediately?: boolean;
  /** 输入框可替换表格交互，单元格解析、安全链接和内联格式仍沿用正文渲染。 */
  customComponentsId?: string;
}

export type StructuredMessageToken = {
  label: string;
  kind: 'expert' | 'skill' | 'plugin' | 'plugin-skill' | 'computer';
};

interface MarkdownRuntimeContextValue {
  language: SessionUiLanguage;
  /** 正文整体是否已经结束生成，用于判断图表代码块是否还会继续增长。 */
  phase: ConversationMarkdownPhase;
  resources: ConversationResource[];
  onOpenResource?: ConversationMarkdownProps['onOpenResource'];
  onLoadResourcePreview?: ConversationMarkdownProps['onLoadResourcePreview'];
  structuredTokens?: readonly StructuredMessageToken[];
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
  const customId = props.customComponentsId ?? (props.structuredTokens?.length ? STRUCTURED_CUSTOM_COMPONENTS_ID : CUSTOM_COMPONENTS_ID);
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
      phase: props.phase,
      resources: props.resources ?? EMPTY_RESOURCES,
      onOpenResource: props.onOpenResource,
      onLoadResourcePreview: props.onLoadResourcePreview,
      structuredTokens: props.structuredTokens,
    }),
    [props.language, props.onLoadResourcePreview, props.onOpenResource, props.phase, props.resources, props.structuredTokens],
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
          customId={customId}
          indexKey={props.streamId}
          htmlPolicy="escape"
          typewriter={false}
          fade={false}
          smoothStreaming={!props.renderImmediately}
          smoothStreamingOptions={SMOOTH_STREAMING_OPTIONS}
          batchRendering={!props.renderImmediately}
          initialRenderBatchSize={24}
          renderBatchSize={16}
          renderBatchDelay={8}
          renderBatchBudgetMs={4}
          renderBatchIdleTimeoutMs={64}
          deferNodesUntilVisible={false}
          maxLiveNodes={0}
          renderCodeBlocksAsPre
          mermaidProps={MERMAID_OPTIONS}
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

/**
 * 图表运行库只在首次需要时加载，上游加载失败会永久降级为源码视图。
 * 这里提前探测一次，把"没加载出来"变成可读原因，而不是只丢一段源码。
 */
let mermaidRuntimeProbe: Promise<boolean> | null = null;
function ensureMermaidRuntime(): Promise<boolean> {
  mermaidRuntimeProbe ??= import('mermaid').then(() => true).catch(() => false);
  return mermaidRuntimeProbe;
}

/** 自定义节点不会收到默认 loading=false，须显式结束已闭合图表的生成状态。 */
function ConversationMermaidNode(props: ComponentProps<typeof MermaidBlockNode>) {
  /** 复用带可访问名称的复制按钮，关闭原生组件未标注名称的图标操作。 */
  const languageLabels = labels[useContext(MarkdownRuntimeContext)?.language ?? 'en-US'];
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** 上游把"画不出来"处理成源码视图且不报错，这里补上用户能看懂的原因。 */
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  /** 正文已经结束时图表代码块不会再增长，必须结束生成态，否则上游会一直只显示源码。 */
  const phase = useContext(MarkdownRuntimeContext)?.phase ?? 'streaming';
  const streaming = phase === 'streaming' && Boolean(props.node.loading);
  useEffect(() => {
    let active = true;
    void ensureMermaidRuntime().then((available) => {
      if (active && !available) setDiagnostic(languageLabels.diagramRuntimeUnavailable);
    });
    return () => {
      active = false;
    };
  }, [languageLabels.diagramRuntimeUnavailable]);
  /** 返回 true 表示异常已由本组件说明，避免与上游错误界面重复提示。 */
  const onRenderError = useCallback(
    (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      setDiagnostic(`${languageLabels.diagramRenderFailed}${reason.slice(0, 200)}`);
      return true;
    },
    [languageLabels.diagramRenderFailed],
  );
  /** 生成结束后仍然没有图形，说明上游已静默回退，标出事实并允许后续重试覆盖它。 */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || streaming) return;
    let active = true;
    const observer = new MutationObserver(() => {
      if (container.querySelector('svg')) setDiagnostic(null);
    });
    observer.observe(container, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      if (active && !container.querySelector('svg')) setDiagnostic((current) => current ?? languageLabels.diagramNotRendered);
    }, 2_500);
    return () => {
      active = false;
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [languageLabels.diagramNotRendered, streaming]);
  return (
    <div ref={containerRef} className="session-code-block">
      <ConversationMarkdownCopyButton label={languageLabels.copyDiagram} copiedLabel={languageLabels.copied} text={props.node.code} />
      <MermaidBlockNode {...props} loading={streaming} onRenderError={onRenderError} />
      {diagnostic ? (
        <small className="session-markdown-code-truncated" role="status">
          {diagnostic}
        </small>
      ) : null}
    </div>
  );
}

/** 表格沿用原生渲染与横向滚动；复制可重新解析的 Markdown，保留对齐和内联格式。 */
function ConversationTableNode(props: ComponentProps<typeof TableNode>) {
  /** 跟随会话语言提供明确的复制格式说明。 */
  const languageLabels = labels[useContext(MarkdownRuntimeContext)?.language ?? 'en-US'];
  /** 解析器会移除分隔行和竖线转义，按单元格重建完整表格语法。 */
  const header: MarkstreamNode[] = props.node.header?.cells ?? [];
  /** 单元格原文保留内联格式；恢复被表格解析器消耗的竖线转义。 */
  const rows = [header, ...(props.node.rows ?? []).map((row: MarkstreamNode) => row.cells ?? [])].map((cells: MarkstreamNode[]) => `| ${cells.map((cell) => (cell.raw ?? '').replaceAll('|', '\\|')).join(' | ')} |`);
  /** 分隔行保留每列显式对齐方式。 */
  const separator = `| ${header.map((cell) => (cell.align === 'center' ? ':---:' : cell.align === 'right' ? '---:' : cell.align === 'left' ? ':---' : '---')).join(' | ')} |`;
  /** 空表头尚未完成时不提供无效的复制内容。 */
  const markdown = header.length ? [rows[0], separator, ...rows.slice(1)].join('\n') : '';
  return (
    <div className="session-code-block session-markdown-table-block">
      <ConversationMarkdownCopyButton label={languageLabels.copyTable} copiedLabel={languageLabels.copied} text={markdown} />
      <TableNode {...props} />
    </div>
  );
}

function PlainMathNode(props: NodeComponentProps<MarkstreamNode>) {
  const content = typeof props.node.raw === 'string' ? props.node.raw : typeof props.node.content === 'string' ? props.node.content : '';
  return props.node.type === 'math_block' ? <pre className="session-markdown-math-plain">{content}</pre> : <span className="session-markdown-math-plain">{content}</span>;
}

/** 用户消息已完成的文本节点只按原标签切出结构化胶囊，普通 Markdown 结构仍由外层节点处理。 */
function StructuredTextNode(props: NodeComponentProps<MarkstreamNode>) {
  const runtime = useContext(MarkdownRuntimeContext);
  const content = typeof props.node.content === 'string' ? props.node.content : '';
  if (!runtime?.structuredTokens?.length || !content) return <>{content}</>;
  return <>{renderStructuredInlineText(content, runtime.structuredTokens)}</>;
}

function renderStructuredInlineText(content: string, tokens: readonly StructuredMessageToken[]): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    let nextIndex = content.length;
    let nextToken: StructuredMessageToken | null = null;
    for (const token of tokens) {
      if (!token.label) continue;
      const index = content.indexOf(token.label, cursor);
      if (index >= 0 && index < nextIndex) {
        nextIndex = index;
        nextToken = token;
      }
    }
    if (!nextToken) {
      parts.push(content.slice(cursor));
      break;
    }
    if (nextIndex > cursor) parts.push(content.slice(cursor, nextIndex));
    parts.push(
      <span key={`${nextIndex}:${nextToken.label}`} className="session-user-message-token" data-kind={nextToken.kind}>
        {nextToken.label}
      </span>,
    );
    cursor = nextIndex + nextToken.label.length;
  }
  return parts;
}

/** 各 Markdown 展示入口共用安全节点，输入框只扩展表格的编辑交互。 */
export const conversationMarkdownComponents = {
  link: SecureLinkNode,
  image: SecureImageNode,
  code_block: SecureCodeBlockNode,
  table: ConversationTableNode,
  // 所有服务商共用图表预览；普通代码块仍保留原有复制与长度限制。
  mermaid: ConversationMermaidNode,
  infographic: SecureCodeBlockNode,
  d2: SecureCodeBlockNode,
  d2lang: SecureCodeBlockNode,
  math_inline: PlainMathNode,
  math_block: PlainMathNode,
} as unknown as CustomComponentMap;

setCustomComponents(CUSTOM_COMPONENTS_ID, conversationMarkdownComponents);
setCustomComponents(STRUCTURED_CUSTOM_COMPONENTS_ID, { ...conversationMarkdownComponents, text: StructuredTextNode } as CustomComponentMap);

/** 共用复制入口只在写入成功后确认，并向键盘和辅助阅读用户报告失败。 */
function ConversationMarkdownCopyButton(props: { label: string; copiedLabel: string; text: string }) {
  /** 状态绑定复制时的文本，流式内容更新后不会继续宣称新内容已复制。 */
  const [result, setResult] = useState<{ text: string; written: boolean } | null>(null);
  /** 错误反馈与会话语言一致。 */
  const languageLabels = labels[useContext(MarkdownRuntimeContext)?.language ?? 'en-US'];
  /** 当前内容对应的成功状态。 */
  const copied = result?.text === props.text && result.written;
  /** 按钮与读屏提示共用相同状态文案。 */
  const feedback = result?.text === props.text ? (result.written ? props.copiedLabel : languageLabels.copyFailed) : '';
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 1_400);
    return () => clearTimeout(timer);
  }, [result]);
  return (
    <button
      type="button"
      className="session-copy-button"
      aria-label={feedback || props.label}
      title={feedback || props.label}
      data-copied={copied || undefined}
      disabled={!props.text}
      onClick={async () => {
        try {
          setResult({ text: props.text, written: await copyText(props.text) });
        } catch {
          setResult({ text: props.text, written: false });
        }
      }}
    >
      {copied ? <MessageCheckIcon /> : <Copy aria-hidden="true" weight="regular" />}
      <span className="session-sr-only" role="status">
        {feedback}
      </span>
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
  /** 标题完全一致的资源优先，避免同文件不同位置命中第一条记录。 */
  const resource =
    resources.find((candidate) => candidate.presentation === 'inline' && candidate.displayName === label && inlineResourceMatches(candidate, label, href)) ??
    resources.find((candidate) => candidate.presentation === 'inline' && inlineResourceMatches(candidate, label, href));
  if (!resource) return null;
  /** 位置属于本次点击，访问权限始终使用已登记的资源身份。 */
  const location = resource.kind === 'file' ? (conversationFileLocationFromReference(href) ?? conversationFileLocationFromReference(label) ?? resource.location) : undefined;
  return resource.kind === 'file' && location ? { ...resource, location } : resource;
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

/** 正文与资源卡共用受信资源；历史元数据未提供网址时按名称回接，打开仍使用资源编号。 */
function inlineResourceMatches(resource: ConversationResource, label: string, href: string): boolean {
  if (resource.kind === 'website') {
    try {
      return new URL(href).href === new URL(resource.url).href;
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
    .replace(/:L\d+(?:-L?\d+)?$/iu, '')
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
