import { ArrowElbowDownLeftIcon as ArrowElbowDownLeft } from '@phosphor-icons/react/dist/csr/ArrowElbowDownLeft';
import { ArrowLineRightIcon as ArrowLineRight } from '@phosphor-icons/react/dist/csr/ArrowLineRight';
import { CodeIcon as Code } from '@phosphor-icons/react/dist/csr/Code';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import type { ConversationFileLocation, ConversationOpenTarget, ConversationResource, ConversationResourcePreview } from '@zeus/shared';
import { conversationFileLocationFromReference, conversationMarkdownReferences, enableConversationCjkStrong, normalizeConversationResourceReference } from '@zeus/shared';
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
const MERMAID_OPTIONS = {
  maxHeight: 'none',
  isStrict: true,
  enableMermaidInteractions: false,
  showHeader: false,
  showCopyButton: false,
  showExportButton: false,
  showFullscreenButton: false,
  showCollapseButton: false,
  showTooltips: false,
} as const;
/** 由运行库按帧释放增量；小片段平滑呈现，积压与完成内容及时追齐。 */
const SMOOTH_STREAMING_OPTIONS = {
  /** 正常片段每帧约呈现一到两字，避免一次刷新耗尽整个片段。 */
  minCharsPerSecond: 60,
  /** 大批到达仍允许快速追赶，不用固定打字速度拖延完整回复。 */
  maxCharsPerSecond: 100_000,
  /** 以短缓冲平摊收包间隔，单位为毫秒。 */
  targetLatencyMs: 180,
  /** 积压时缩短目标延迟，单位为毫秒。 */
  catchUpLatencyMs: 80,
  /** 普通句子保持平滑，超过此字数才进入快速追赶。 */
  catchUpThreshold: 256,
  /** 跟随浏览器绘制，限制每秒 Markdown 更新次数。 */
  maxCommitFps: 60,
  /** 首个片段到达后立即开始呈现，不额外等待启动计时。 */
  startDelayMs: 0,
  /** 保留大段输出的单帧追赶能力。 */
  maxCharsPerCommit: 2_048,
  /** 完成时立即显示剩余内容，不继续播放打字效果。 */
  flushOnFinish: true,
} as const;

/** Markdown 内容和操作提示统一跟随当前界面语言。 */
const labels = {
  'zh-CN': {
    copied: '已复制',
    copyCode: '复制代码',
    /** 未标注语言及纯文本别名使用同一个可读标题。 */
    plainText: '纯文本',
    /** 换行提示描述点击后执行的操作。 */
    enableWordWrap: '启用自动换行',
    /** 已开启时允许恢复原始行布局。 */
    disableWordWrap: '关闭自动换行',
    copyTable: '复制表格 Markdown',
    copyDiagram: '复制图表源码',
    /** 图表操作采用会话语言，不显示运行库的英文标签页。 */
    diagram: '图表',
    showDiagramSource: '查看源码',
    showDiagramPreview: '返回图表',
    copyFailed: '复制失败，请重试',
    image: '图片',
    imageUnavailable: '图片不可用',
    contentTruncated: '内容过于复杂，已截断',
    codeTruncated: '代码块过长，已截断',
    diagramRuntimeUnavailable: '图表运行库未加载，只能显示源码',
    diagramRenderFailed: '图表渲染失败：',
    diagramSyntaxInvalid: 'Mermaid 语法不完整或无效，已保留源码',
  },
  'en-US': {
    copied: 'Copied',
    copyCode: 'Copy code',
    /** 英文界面使用对应的纯文本标题。 */
    plainText: 'Plain text',
    /** 英文换行提示同样描述下一次操作。 */
    enableWordWrap: 'Enable word wrap',
    /** 英文关闭提示与按钮状态保持一致。 */
    disableWordWrap: 'Disable word wrap',
    copyTable: 'Copy table Markdown',
    copyDiagram: 'Copy diagram source',
    /** 英文界面使用同一组紧凑操作。 */
    diagram: 'Diagram',
    showDiagramSource: 'View source',
    showDiagramPreview: 'Back to diagram',
    copyFailed: 'Copy failed, try again',
    image: 'Image',
    imageUnavailable: 'Image unavailable',
    contentTruncated: 'Content complexity truncated',
    codeTruncated: 'Code block truncated',
    diagramRuntimeUnavailable: 'Diagram runtime unavailable; showing source',
    diagramRenderFailed: 'Diagram failed to render: ',
    diagramSyntaxInvalid: 'Incomplete or invalid Mermaid syntax; showing source',
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
  /** 编辑器等场景可主动关闭流式分批；已完成正文默认一次呈现。 */
  renderImmediately?: boolean;
  /** 输入框可替换表格交互，单元格解析、安全链接和内联格式仍沿用正文渲染。 */
  customComponentsId?: string;
  /** 源码页提供自己的已授权相对资源解析，不伪造会话资源身份。 */
  filePreview?: {
    /** 只返回当前文件预览授权下的图片地址。 */
    imageUrl(path: string): string | undefined;
    /** 文件链接由源码页打开，不改变会话路由。 */
    openLink(path: string): void | Promise<void>;
  };
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
  /** 文件预览能力只由受信源码页提供。 */
  filePreview?: ConversationMarkdownProps['filePreview'];
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

/** 同一会话中的图片共用资源水合状态和显式重读入口，不触及正文身份。 */
export const ConversationImageResourcesContext = createContext<{
  /** 资源页未读取或正在恢复时不能声称图片不可用。 */
  state: 'loading' | 'ready' | 'failed';
  /** 只读取当前会话已授权的资源。 */
  reload?: () => void | Promise<void>;
} | null>(null);

/** 每张 Markdown 图片分别核对，已有一张图片不能掩盖其余缺失资源。 */
export function hasMissingMarkdownImages(text: string, resources: ConversationResource[]): boolean {
  for (const match of conversationMarkdownReferences(text).filter((reference) => reference.image)) {
    /** 解析仅用于发现缺失，真正加载仍走已授权资源编号。 */
    const resource = matchingInlineResource(resources, match.label, match.href);
    if (!resource || !isImageResource(resource)) return true;
  }
  return false;
}

/** 会话正文共用安全 Markdown 渲染与增量显示策略。 */
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
      filePreview: props.filePreview,
    }),
    [props.language, props.onLoadResourcePreview, props.onOpenResource, props.phase, props.resources, props.structuredTokens, props.filePreview],
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
          customMarkdownIt={enableConversationCjkStrong}
          customId={customId}
          indexKey={props.streamId}
          htmlPolicy="escape"
          typewriter={false}
          // 运行库只淡入新增文字，已读正文与完整历史不重复播放动画。
          fade={props.phase === 'streaming' && !props.renderImmediately}
          smoothStreaming={props.phase === 'streaming' && !props.renderImmediately}
          smoothStreamingOptions={SMOOTH_STREAMING_OPTIONS}
          // 文字已有按帧调度；节点直接挂载，避免每个新段落先闪占位条再改变高度。
          batchRendering={false}
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

/** 链接以授权资源是否就绪为准，解析器缓存的流式标记不能遮住已完成链接。 */
function SecureLinkNode(props: NodeComponentProps<MarkstreamNode>) {
  const runtime = useContext(MarkdownRuntimeContext);
  const href = typeof props.node.href === 'string' ? props.node.href : '';
  const label = typeof props.node.text === 'string' && props.node.text ? props.node.text : href;
  if (!runtime || !href) {
    return <span className="session-markdown-unavailable-resource">{label}</span>;
  }
  const resource = matchingInlineResource(runtime.resources, label, href);
  if (resource) {
    return <ConversationInlineResource resource={resource} label={label || resource.displayName} language={runtime.language} onOpenResource={runtime.onOpenResource} />;
  }
  if (runtime.filePreview) {
    return (
      <a
        href="#"
        onClick={(event) => {
          event.preventDefault();
          void runtime.filePreview?.openLink(href);
        }}
      >
        {label}
      </a>
    );
  }
  if (href.startsWith('#')) return <a href={href}>{label}</a>;
  return (
    <span className="session-markdown-unavailable-resource" data-icon-tooltip={href}>
      {label}
    </span>
  );
}

function SecureImageNode(props: NodeComponentProps<MarkstreamNode>) {
  const runtime = useContext(MarkdownRuntimeContext);
  /** 流式节点和资源归档各自就绪，不能由节点缓存的 loading 标记阻挡已授权图片。 */
  const imageResources = useContext(ConversationImageResourcesContext);
  const src = typeof props.node.src === 'string' ? props.node.src : '';
  const fallbackLabel = runtime?.language === 'zh-CN' ? labels['zh-CN'].image : labels['en-US'].image;
  const label = (typeof props.node.alt === 'string' && props.node.alt.trim()) || (typeof props.node.title === 'string' && props.node.title.trim()) || fallbackLabel;
  const resource = runtime ? matchingInlineResource(runtime.resources, label, src) : null;
  /** 项目文件图片使用已授权的预览 URL，会话资源仍走原有链路。 */
  const fileImage = !resource ? runtime?.filePreview?.imageUrl(src) : undefined;
  if (fileImage) return <SourcePreviewImage key={fileImage} url={fileImage} label={label} language={runtime?.language ?? 'en-US'} />;
  if (!runtime || !resource || !isImageResource(resource)) {
    /** 正文生成与资源水合均未结束时保持真实的准备状态。 */
    const preparing = runtime?.phase === 'streaming' || imageResources?.state === 'loading';
    /** 已结束但元数据缺失与实际读取失败使用不同提示。 */
    const status = preparing
      ? runtime?.language === 'zh-CN'
        ? '正在准备图片'
        : 'Preparing image'
      : imageResources?.state === 'failed'
        ? runtime?.language === 'zh-CN'
          ? '图片加载失败'
          : 'Image loading failed'
        : runtime?.language === 'zh-CN'
          ? '图片引用未登记'
          : 'Image reference is not registered';
    return (
      <span className="session-markdown-image-unavailable" role="status" aria-busy={preparing || undefined}>
        <span>{`${status}：${label}`}</span>
        {!preparing && imageResources?.reload ? (
          <button
            type="button"
            onClick={() => {
              void Promise.resolve(imageResources.reload?.()).catch(() => undefined);
            }}
          >
            {runtime?.language === 'zh-CN' ? '重新加载' : 'Retry'}
          </button>
        ) : null}
      </span>
    );
  }
  return <ConversationMarkdownImage resource={resource} label={label} language={runtime.language} onOpenResource={runtime.onOpenResource} onLoadResourcePreview={runtime.onLoadResourcePreview} />;
}

/** 图片解码失败时保留文件说明，不影响文档其余部分。 */
function SourcePreviewImage(props: { url: string; label: string; language: SessionUiLanguage }) {
  /** 图片身份变化通过 key 重新开始解码。 */
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span role="status">
      {props.language === 'zh-CN' ? '图片不可用：' : 'Image unavailable: '}
      {props.label}
    </span>
  ) : (
    <img className="project-source-markdown-image" src={props.url} alt={props.label} loading="lazy" onError={() => setFailed(true)} />
  );
}

/** 普通代码块共用标题与操作；仅改变显示换行，不改写或执行源码。 */
function SecureCodeBlockNode(props: NodeComponentProps<MarkstreamNode>) {
  /** 所有 Markdown 展示入口共享同一语言上下文。 */
  const runtime = useContext(MarkdownRuntimeContext);
  /** 独立渲染时保持原有英文回退。 */
  const language = runtime?.language ?? 'en-US';
  /** 标题、换行与复制提示使用相同语言。 */
  const languageLabels = labels[language];
  /** 原始代码仅接受解析器提供的字符串。 */
  const sourceCode = typeof props.node.code === 'string' ? props.node.code : '';
  /** 沿用现有单块长度限制和截断提示。 */
  const codeTruncated = sourceCode.length > MAX_CONVERSATION_MARKDOWN_CODE_CHARACTERS;
  /** 显示与复制共用这一份受限源码，换行不会插入额外字符。 */
  const code = sourceCode.slice(0, MAX_CONVERSATION_MARKDOWN_CODE_CHARACTERS);
  /** 只清理语言标记的首尾空白，其余语言名称保留原文。 */
  const codeLanguage = typeof props.node.language === 'string' ? props.node.language.trim() : '';
  /** 常见纯文本别名不区分大小写，其余语言直接显示名称。 */
  const title = ['', 'text', 'plain', 'plaintext'].includes(codeLanguage.toLowerCase()) ? languageLabels.plainText : codeLanguage;
  /** 状态只属于当前块；流式追加不重置，重新挂载后默认关闭。 */
  const [wrap, setWrap] = useState(false);
  /** 按钮与全局悬停提示共用下一步操作文案。 */
  const wrapLabel = wrap ? languageLabels.disableWordWrap : languageLabels.enableWordWrap;
  return (
    <div className="session-code-block session-markdown-code-block" data-language={codeLanguage || undefined} data-wrap={wrap} aria-busy={props.node.loading || undefined}>
      <div className="session-code-toolbar">
        <span className="session-code-title">
          <Code aria-hidden="true" weight="regular" />
          <span>{title}</span>
        </span>
        <button type="button" aria-label={wrapLabel} aria-pressed={wrap} data-icon-tooltip={wrapLabel} onClick={() => setWrap((current) => !current)}>
          {wrap ? <ArrowElbowDownLeft aria-hidden="true" weight="regular" /> : <ArrowLineRight aria-hidden="true" weight="regular" />}
        </button>
        <ConversationMarkdownCopyButton label={languageLabels.copyCode} copiedLabel={languageLabels.copied} text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
      {codeTruncated ? <small className="session-markdown-code-truncated">{languageLabels.codeTruncated}</small> : null}
    </div>
  );
}

/** 图表运行库按需加载并复用，用于在上游静默回退之前说明加载或语法错误。 */
let mermaidRuntimeProbe: Promise<(typeof import('mermaid'))['default'] | null> | null = null;
/** 返回实际运行库，完成态直接用其解析接口核对语法，不依赖图标或等待时长判断成功。 */
function ensureMermaidRuntime(): NonNullable<typeof mermaidRuntimeProbe> {
  mermaidRuntimeProbe ??= import('mermaid').then((module) => module.default).catch(() => null);
  return mermaidRuntimeProbe;
}

/** 自定义节点不会收到默认 loading=false，须显式结束已闭合图表的生成状态。 */
function ConversationMermaidNode(props: ComponentProps<typeof MermaidBlockNode>) {
  /** 语言和正文阶段来自所有 Markdown 展示入口共用的上下文。 */
  const runtime = useContext(MarkdownRuntimeContext);
  /** 图表标题和操作文案使用当前会话语言。 */
  const languageLabels = labels[runtime?.language ?? 'en-US'];
  /** 图表外壳用于读取当前应用主题。 */
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** 上游把"画不出来"处理成源码视图且不报错，这里补上用户能看懂的原因。 */
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  /** 源码视图保留原文，预览继续挂载以保留已有缩放状态。 */
  const [showSource, setShowSource] = useState(false);
  /** 未指定图表主题时才使用会话默认配色，作者的整图主题继续生效。 */
  const [useDefaultTheme, setUseDefaultTheme] = useState(true);
  /** 正文已经结束时图表代码块不会再增长，必须结束生成态，否则上游会一直只显示源码。 */
  const phase = runtime?.phase ?? 'streaming';
  /** 未闭合代码块继续生成；正文完成后覆盖解析节点残留的生成状态。 */
  const streaming = phase === 'streaming' && Boolean(props.node.loading);
  /** 上游优先读取 node.loading，必须与组件 loading 同步。 */
  const node = useMemo(() => ({ ...props.node, loading: streaming }), [props.node, streaming]);
  /** Mermaid 的图形颜色跟随应用主题，而非固定使用浅色。 */
  const [isDark, setIsDark] = useState(false);
  useLayoutEffect(() => {
    /** 应用主题由已有容器类和系统主题共同决定。 */
    const container = containerRef.current;
    if (!container) return;
    /** 设置变化时重新读取最终生效的颜色模式。 */
    const syncTheme = () => setIsDark(getComputedStyle(container).colorScheme === 'dark');
    /** 只观察当前应用主题容器，避免监听整个正文的更新。 */
    const observer = new MutationObserver(syncTheme);
    observer.observe(container.closest('.zeus-shell') ?? document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    /** 自动主题随系统设置变化更新图形。 */
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', syncTheme);
    syncTheme();
    return () => {
      observer.disconnect();
      media.removeEventListener('change', syncTheme);
    };
  }, []);
  /** 返回 true 表示异常已由本组件说明，避免与上游错误界面重复提示。 */
  const onRenderError = useCallback(
    (error: unknown) => {
      /** 错误摘要有界显示，完整源码继续可复制。 */
      const reason = error instanceof Error ? error.message : String(error);
      setDiagnostic(`${languageLabels.diagramRenderFailed}${reason.slice(0, 200)}`);
      return true;
    },
    [languageLabels.diagramRenderFailed],
  );
  /** 上游解析失败可能不触发渲染回调；直接核对闭合图表，避免把标题图标当作成功。 */
  useEffect(() => {
    /** 取消旧正文的异步结果，防止其错误覆盖新图表。 */
    let active = true;
    setDiagnostic(null);
    setUseDefaultTheme(true);
    void ensureMermaidRuntime().then(async (mermaid) => {
      if (!active) return;
      if (!mermaid) {
        setDiagnostic(languageLabels.diagramRuntimeUnavailable);
        return;
      }
      if (streaming) return;
      try {
        /** 未闭合语法返回 false，不让 Mermaid 额外插入错误图形。 */
        const parsed = await mermaid.parse(props.node.code, { suppressErrors: true });
        if (active && parsed !== false) setUseDefaultTheme(!parsed.config.theme && Object.keys(parsed.config.themeVariables ?? {}).length === 0);
        if (active && parsed === false) setDiagnostic(`${languageLabels.diagramRenderFailed}${languageLabels.diagramSyntaxInvalid}`);
      } catch (error) {
        if (active) onRenderError(error);
      }
    });
    return () => {
      active = false;
    };
  }, [languageLabels.diagramRenderFailed, languageLabels.diagramRuntimeUnavailable, languageLabels.diagramSyntaxInvalid, onRenderError, props.node.code, streaming]);
  return (
    <div ref={containerRef} className="session-code-block session-mermaid-block" data-error={diagnostic ? 'true' : undefined} aria-busy={streaming || undefined}>
      <div className="session-mermaid-toolbar">
        <span>{languageLabels.diagram}</span>
        {/* 为已有缩放控件保留同行位置，由图表范围内的 CSS 锚点定位。 */}
        {!showSource && !diagnostic ? <span className="session-mermaid-zoom-slot" aria-hidden="true" /> : null}
        {/* 查看源码不改变图形内容；语法错误时直接显示源码与原因。 */}
        {!diagnostic ? (
          <button type="button" onClick={() => setShowSource((current) => !current)}>
            {showSource ? languageLabels.showDiagramPreview : languageLabels.showDiagramSource}
          </button>
        ) : null}
        <ConversationMarkdownCopyButton label={languageLabels.copyDiagram} copiedLabel={languageLabels.copied} text={props.node.code} />
      </div>
      <div className="session-mermaid-preview" data-default-theme={useDefaultTheme} hidden={showSource || Boolean(diagnostic)}>
        {/* 主题变化时重建图形状态，避免上游复用仅按源码缓存的旧 SVG。 */}
        <MermaidBlockNode key={isDark ? 'dark' : 'light'} {...props} node={node} loading={streaming} isDark={isDark} showHeader={false} onRenderError={onRenderError} />
      </div>
      {showSource || diagnostic ? (
        <pre>
          <code>{props.node.code}</code>
        </pre>
      ) : null}
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
      data-icon-tooltip={feedback || props.label}
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

/** 正文渲染与缺失资源检测共用匹配规则，打开仍使用登记身份。 */
export function matchingInlineResource(resources: ConversationResource[], label: string, href: string): ConversationResource | null {
  /** 图片按完整来源匹配，同说明不能替代资源身份。 */
  const exactImage = resources.find(
    (candidate) => candidate.presentation === 'inline' && candidate.kind === 'attachment' && candidate.sourceReference && normalizeConversationResourceReference(candidate.sourceReference) === normalizeConversationResourceReference(href),
  );
  /** 旧记录若存在同说明图片则拒绝猜测；新记录始终按完整引用匹配。 */
  const legacyImages = resources.filter((candidate) => candidate.kind === 'attachment' && !candidate.sourceReference && candidate.displayName === label);
  const candidates = legacyImages.length > 1 ? resources.filter((candidate) => !legacyImages.includes(candidate)) : resources;
  const resource =
    exactImage ??
    candidates.find((candidate) => candidate.presentation === 'inline' && candidate.displayName === label && inlineResourceMatches(candidate, label, href)) ??
    candidates.find((candidate) => candidate.presentation === 'inline' && inlineResourceMatches(candidate, label, href));
  if (!resource) return null;
  /** 位置属于本次点击，访问权限始终使用已登记的资源身份。 */
  const location = resource.kind === 'file' ? (conversationFileLocationFromReference(href) ?? conversationFileLocationFromReference(label) ?? resource.location) : undefined;
  return resource.kind === 'file' && location ? { ...resource, location } : resource;
}

/** 按已登记资源核对链接目标，说明标签不充当文件路径。 */
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
  // 带目录的引用按完整路径匹配，只有裸文件名才允许省略目录。
  return reference === resource.projectRelativePath || reference.endsWith(`/${resource.projectRelativePath}`) || (!reference.includes('/') && reference === resource.projectRelativePath.split('/').at(-1));
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
  if (resource.kind === 'attachment') return resource.sourceReference ? normalizeConversationResourceReference(resource.sourceReference) === normalizeConversationResourceReference(href) : resource.displayName === label;
  // 相同的“代码位置”标签不能把另一份文件的行号带入当前文件。
  return inlineResourceHrefMatches(resource, href);
}

/** 先规范化路径编码，再分离引用位置，访问仍要求匹配已登记资源。 */
function decodeReferencePath(href: string): string {
  let value = href.replace(/^file:\/\//iu, '');
  try {
    value = decodeURIComponent(value);
  } catch {
    // 非法编码保留原值，且仍需匹配权威资源后才能获得打开权限。
  }
  // 先解码再去除位置，百分号编码的行号也必须落在同一文件上。
  return value
    .replace(/#L\d+(?:-L?\d+)?$/iu, '')
    .replace(/:L\d+(?:-L?\d+)?$/iu, '')
    .replace(/:\d+(?::\d+)?$/u, '');
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
