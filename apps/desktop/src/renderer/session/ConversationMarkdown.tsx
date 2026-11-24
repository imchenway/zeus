import { ArrowElbowDownLeftIcon as ArrowElbowDownLeft } from '@phosphor-icons/react/dist/csr/ArrowElbowDownLeft';
import { ArrowLineRightIcon as ArrowLineRight } from '@phosphor-icons/react/dist/csr/ArrowLineRight';
import { CodeIcon as Code } from '@phosphor-icons/react/dist/csr/Code';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import type { ConversationFileLocation, ConversationOpenTarget, ConversationResource, ConversationResourcePreview } from '@zeus/shared';
import { conversationFileLocationFromReference, conversationMarkdownReferences, enableConversationCjkStrong, filePreviewLimits, normalizeConversationResourceReference } from '@zeus/shared';
import MarkdownRender, { MermaidBlockNode, ParagraphNode, TableNode, setCustomComponents, type CustomComponentMap, type NodeComponentProps, type NodeRendererProps } from 'markstream-react';
import 'markstream-react/index.css';
import './conversationMermaid.css';
// 公式与字体资源随应用打包，供所有 Markdown 展示入口共用。
import 'katex/dist/katex.min.css';
import { memo, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ConversationInlineResource, ConversationMarkdownImage, ConversationResourceCard, ConversationResourceVideo, isImageResource, isVideoResource } from './ConversationResources.js';
import { MessageCheckIcon } from './SessionMessageIcons.js';
import { MarkdownDocumentOutline } from './MarkdownDocumentOutline.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { Button } from '../ui/Button.js';

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
/** 媒体段落仅在助手正文中覆盖默认段落渲染。 */
const MEDIA_CUSTOM_COMPONENTS_ID = 'zeus-conversation-markdown-media';
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
  /** 实时首段一次性完成时仍淡入；历史水合和虚拟列表恢复不重播。 */
  animateArrival?: boolean;
  language: SessionUiLanguage;
  resources?: ConversationResource[];
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  onVisibleContentChange?: () => void;
  /** 报告最终正文是否已渲染完成，可用于启用依赖正文位置的操作。 */
  onRenderSettledChange?: (ready: boolean) => void;
  /** 助手正文的独立媒体链接可在原段落位置展开。 */
  showMedia?: boolean;
  /** 用户消息中的结构化引用标签，按原标签文本渲染为胶囊而不是普通 Markdown 文本。 */
  structuredTokens?: readonly StructuredMessageToken[];
  /** 编辑器等场景可主动关闭流式分批；已完成正文默认一次呈现。 */
  renderImmediately?: boolean;
  /** 文件阅读使用读取上限和屏外延迟绘制，不套用会话的正文、代码与节点截断。 */
  documentMode?: boolean;
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
  /** 文件代码块保留读取到的完整源码，仍按纯文本显示。 */
  documentMode?: boolean;
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
  /** 本次挂载中收到实时正文后，完成事件只结束节流，不截断文字淡入。 */
  const motion = useRef({ streamId: props.streamId, enabled: false });
  if (motion.current.streamId !== props.streamId) motion.current = { streamId: props.streamId, enabled: false };
  motion.current.enabled ||= props.phase === 'streaming' || Boolean(props.animateArrival);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onVisibleContentChangeRef = useRef(props.onVisibleContentChange);
  /** 回调更新不影响当前正文的渲染状态。 */
  const onRenderSettledChangeRef = useRef(props.onRenderSettledChange);
  const [settled, setSettled] = useState(false);
  const languageLabels = labels[props.language];
  onVisibleContentChangeRef.current = props.onVisibleContentChange;
  onRenderSettledChangeRef.current = props.onRenderSettledChange;

  const bounded = useMemo(() => boundConversationMarkdown(props.text, props.language, props.documentMode), [props.documentMode, props.language, props.text]);
  const customId = props.customComponentsId ?? (props.structuredTokens?.length ? STRUCTURED_CUSTOM_COMPONENTS_ID : props.showMedia ? MEDIA_CUSTOM_COMPONENTS_ID : CUSTOM_COMPONENTS_ID);
  const parseOptions = useMemo<NonNullable<NodeRendererProps['parseOptions']>>(
    () => ({
      reuseStableTopLevelNodes: true,
      streamParse: 'auto',
      // 所有链接都进入 Zeus 自定义节点；节点仅在页内锚点或权威资源匹配成功后才会变为可点击。
      validateLink: (href: string) => Boolean(href.trim()),
      // 文件保留完整语法树，由浏览器延迟绘制屏外内容；会话继续限制语法树规模。
      postTransformNodes: props.documentMode ? undefined : (nodes: MarkstreamNode[]) => limitParsedNodes(nodes, languageLabels.contentTruncated),
    }),
    [languageLabels.contentTruncated, props.documentMode],
  );
  const contextValue = useMemo<MarkdownRuntimeContextValue>(
    () => ({
      language: props.language,
      phase: props.phase,
      documentMode: props.documentMode,
      resources: props.resources ?? EMPTY_RESOURCES,
      onOpenResource: props.onOpenResource,
      onLoadResourcePreview: props.onLoadResourcePreview,
      structuredTokens: props.structuredTokens,
      filePreview: props.filePreview,
    }),
    [props.documentMode, props.language, props.onLoadResourcePreview, props.onOpenResource, props.phase, props.resources, props.structuredTokens, props.filePreview],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    // ResizeObserver 已在绘制前合并尺寸变化；此处再等一帧会把正文增高与贴底拆开。
    const observer = new ResizeObserver(() => onVisibleContentChangeRef.current?.());
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    /** 正文标记和依赖选区的操作使用同一次渲染检查。 */
    const reportSettled = (ready: boolean) => {
      setSettled(ready);
      onRenderSettledChangeRef.current?.(ready);
    };
    reportSettled(false);
    if (props.phase !== 'final') return;
    let frame = 0;
    const inspect = () => {
      frame = 0;
      reportSettled(!root.querySelector('.node-placeholder'));
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
      onRenderSettledChangeRef.current?.(false);
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
        data-document-mode={props.documentMode || undefined}
      >
        {props.documentMode ? <MarkdownDocumentOutline key={props.streamId} root={rootRef} language={props.language} /> : null}
        <MarkdownRender
          content={bounded.text}
          final={props.phase === 'final'}
          parseOptions={parseOptions}
          customMarkdownIt={enableConversationCjkStrong}
          customId={customId}
          indexKey={props.streamId}
          htmlPolicy="escape"
          typewriter={false}
          // 最终批次仍淡入新增文字，完整历史与已经读过的文字不重复入场。
          fade={motion.current.enabled && !props.renderImmediately}
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

/** 完成答复中独占段落的视频和本地网站按已登记的身份呈现。 */
function ConversationParagraphNode(props: ComponentProps<typeof ParagraphNode>) {
  /** 流式正文的最后一段可能继续追加文字，完成后再确定它是否独占一段。 */
  const runtime = useContext(MarkdownRuntimeContext);
  if (runtime?.phase === 'final' && runtime.onOpenResource && props.node.children?.length === 1) {
    /** 只有普通 Markdown 链接可以升级为块级资源。 */
    const link = props.node.children[0];
    if (link?.type === 'link' && link.href) {
      /** 使用和普通内联链接一致的身份匹配。 */
      const resource = matchingInlineResource(runtime.resources, link.text || link.href, link.href);
      if (resource && isVideoResource(resource)) {
        return <ConversationResourceVideo key={`${resource.id}:${resource.updatedAt}`} resource={resource} language={runtime.language} onOpenResource={runtime.onOpenResource} />;
      }
      if (resource?.kind === 'website' && resource.local) {
        return <ConversationResourceCard resource={resource} language={runtime.language} onOpenResource={runtime.onOpenResource} />;
      }
    }
  }
  return <ParagraphNode {...props} />;
}

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
          return runtime.filePreview?.openLink(href);
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
          <Button
            unstyled
            type="button"
            onClick={() => {
              return Promise.resolve(imageResources.reload?.()).catch(() => undefined);
            }}
          >
            {runtime?.language === 'zh-CN' ? '重新加载' : 'Retry'}
          </Button>
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
  /** 文件代码按纯文本完整显示，会话仍保留单块长度限制。 */
  const codeTruncated = !runtime?.documentMode && sourceCode.length > MAX_CONVERSATION_MARKDOWN_CODE_CHARACTERS;
  /** 显示与复制共用同一份源码，换行不会插入额外字符。 */
  const code = codeTruncated ? sourceCode.slice(0, MAX_CONVERSATION_MARKDOWN_CODE_CHARACTERS) : sourceCode;
  /** 只清理语言标记的首尾空白，其余语言名称保留原文。 */
  const codeLanguage = typeof props.node.language === 'string' ? props.node.language.trim() : '';
  /** 无语言标记及不区分大小写的纯文本别名共用同一显示规则。 */
  const isPlainText = ['', 'text', 'plain', 'plaintext'].includes(codeLanguage.toLowerCase());
  /** 纯文本使用本地化标题，其他块显示原有语言名称。 */
  const title = isPlainText ? languageLabels.plainText : codeLanguage;
  /** 手动切换只作用于当前块，流式更新时保留选择。 */
  const [wrapPreference, setWrapPreference] = useState<boolean>();
  /** 手动切换前，纯文本按当前语言标记默认软换行。 */
  const wrap = wrapPreference ?? isPlainText;
  /** 按钮与全局悬停提示共用下一步操作文案。 */
  const wrapLabel = wrap ? languageLabels.disableWordWrap : languageLabels.enableWordWrap;
  return (
    <div className="session-code-block session-markdown-code-block" data-language={codeLanguage || undefined} data-wrap={wrap} aria-busy={props.node.loading || undefined}>
      <div className="session-code-toolbar">
        <span className="session-code-title">
          <Code aria-hidden="true" weight="regular" />
          <span>{title}</span>
        </span>
        <Button unstyled type="button" aria-label={wrapLabel} aria-pressed={wrap} data-icon-tooltip={wrapLabel} onClick={() => setWrapPreference((current) => !(current ?? isPlainText))}>
          {wrap ? <ArrowElbowDownLeft aria-hidden="true" weight="regular" /> : <ArrowLineRight aria-hidden="true" weight="regular" />}
        </Button>
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

/** 预载首屏闭合图表的运行库与语法模块，绘制沿用主题感知的共享图表组件。 */
export async function preloadConversationDiagram(text: string): Promise<void> {
  const source = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)^ {0,3}\1[ \t]*\r?$/imu.exec(text)?.[2];
  if (source) await (await ensureMermaidRuntime())?.parse(source, { suppressErrors: true });
}

/** 用单像素画布把 CSS 实色转换为 sRGB，无法解析的颜色保留为透明像素。 */
function readMermaidColor(context: CanvasRenderingContext2D, color: string): Uint8ClampedArray | null {
  if (!CSS.supports('color', color)) return null;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = 'transparent';
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data;
}

/** 将 SVG 的实色填充读取为 sRGB 像素，渐变和图案没有单一对比度。 */
function readMermaidFill(context: CanvasRenderingContext2D, element: SVGElement): Uint8ClampedArray | null {
  /** 使用浏览器实际计算的填充，包含主题、style 和 classDef 的结果。 */
  const style = getComputedStyle(element);
  if (style.opacity !== '1' || style.fillOpacity !== '1') return null;
  return readMermaidColor(context, style.fill === 'currentcolor' ? style.color : style.fill);
}

/** WCAG 相对亮度使用线性 sRGB，半透明文字先与节点底色混合。 */
function mermaidFillLuminance(fill: Uint8ClampedArray, background = fill): number {
  /** 像素的不透明度从字节转换为比例。 */
  const alpha = fill[3] / 255;
  /** 将一个混色后的 sRGB 通道转换为线性亮度。 */
  const linear = (channel: number): number => {
    /** 浏览器返回的像素通道值范围为 0 到 255。 */
    const value = (fill[channel] * alpha + background[channel] * (1 - alpha)) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(0) + 0.7152 * linear(1) + 0.0722 * linear(2);
}

/** 默认手绘色板同时用于绘制流程图和识别作者着色的节点。 */
const handDrawnFlowchartColors = {
  light: { canvas: '#ffffff', node: '#e7f0fa', group: '#f3f6fa', border: '#6382a0', groupBorder: '#7898b8', line: '#65798e', text: '#233e5a' },
  dark: { canvas: '#181818', node: '#23354a', group: '#202b38', border: '#6f8da8', groupBorder: '#6f8da8', line: '#8b9cb1', text: '#e1eeff' },
};

/** SVG 预览中可独立修正的轮廓、纹理或文字颜色。 */
type MermaidPaintCorrection = { element: SVGElement; property: 'fill' | 'stroke'; replacement: string };

/** 将作者强调色用于手绘轮廓、低反差斜纹和高对比文字。 */
function handDrawnHighlightCorrections(diagram: SVGSVGElement, context: CanvasRenderingContext2D, isDark: boolean): MermaidPaintCorrection[] {
  /** 原始路径若使用默认色板，该节点没有自定义强调色。 */
  const defaults = handDrawnFlowchartColors[isDark ? 'dark' : 'light'];
  /** 批量收集改色项，避免读取文字颜色时触发重复样式计算。 */
  const corrections: MermaidPaintCorrection[] = [];
  for (const node of diagram.querySelectorAll('g.rough-node')) {
    /** ponytail: 简单手绘形状按顺序输出斜纹和轮廓。复合形状需要分别识别装饰路径。 */
    const paths = node.querySelectorAll<SVGPathElement>(':scope > g:first-child > path[fill="none"][stroke]');
    if (paths.length !== 2) continue;
    /** 直接读取路径属性，避免 classDef 让斜纹继承外轮廓色。 */
    const [hatch, outline] = paths;
    /** 外轮廓的原始描边色。 */
    const outlineStroke = outline.getAttribute('stroke');
    /** Mermaid 用斜纹的描边记录原节点填充色。 */
    const hatchStroke = hatch.getAttribute('stroke');
    /** 作者设置的描边优先，只有自定义填充时从斜纹取强调色。 */
    const accent = (outlineStroke?.toLowerCase() !== defaults.border && outlineStroke) || (hatchStroke?.toLowerCase() !== defaults.node && hatchStroke);
    if (!accent) continue;
    /** 透明色不作为节点的强调色。 */
    const color = readMermaidColor(context, accent);
    if (!color?.[3]) continue;
    /** OKLCH 保留色相，独立控制亮度和色度上限以保证阅读对比度。 */
    const tone = (lightness: number, chroma: number) => `oklch(from rgb(${color[0]} ${color[1]} ${color[2]}) ${lightness} min(c, ${chroma}) h)`;
    corrections.push(
      { element: hatch, property: 'fill', replacement: 'none' },
      { element: outline, property: 'fill', replacement: 'none' },
      { element: hatch, property: 'stroke', replacement: tone(isDark ? 0.29 : 0.96, 0.04) },
      { element: outline, property: 'stroke', replacement: tone(isDark ? 0.78 : 0.49, 0.14) },
    );
    /** 文字与斜纹、纹理间隙都保留明暗差。 */
    const textColor = isDark ? tone(0.94, 0.055) : tone(0.3, 0.07);
    for (const label of node.querySelectorAll<SVGTextContentElement>('text, tspan')) {
      if (readMermaidFill(context, label)?.[3]) corrections.push({ element: label, property: 'fill', replacement: textColor });
    }
  }
  return corrections;
}

/** 应用流程图预览的对比度修正，并返回原色恢复操作。 */
function improveMermaidPreviewContrast(diagram: SVGSVGElement, isDark: boolean, handDrawn: boolean): (() => void) | undefined {
  /** 单像素画布复用浏览器的 CSS 颜色解析，不读取图表内容。 */
  const canvas = diagram.ownerDocument.createElement('canvas');
  canvas.width = canvas.height = 1;
  /** 软件画布用于连续读取单像素颜色。 */
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;
  /** 先读取所有颜色，再应用修正，避免写样式后重复计算。 */
  const corrections = handDrawn ? handDrawnHighlightCorrections(diagram, context, isDark) : [];
  for (const node of isDark ? diagram.querySelectorAll('g.node') : []) {
    /** 与会话主题使用相同的 Mermaid 节点填充形状。 */
    const shape = node.querySelector<SVGElement>(':is(rect, path, polygon, circle, ellipse).label-container, .label-container path');
    if (!shape) continue;
    /** 只根据不透明底色调整，透明节点的背景取决于所在分组。 */
    const background = readMermaidFill(context, shape);
    if (!background || background[3] !== 255) continue;
    /** 加 0.05 后可直接计算 WCAG 对比度。 */
    const backgroundLevel = mermaidFillLuminance(background) + 0.05;
    for (const label of node.querySelectorAll<SVGTextContentElement>('text, tspan')) {
      /** 完全透明的文字是主动隐藏的，不补色。 */
      const foreground = readMermaidFill(context, label);
      if (!foreground || foreground[3] === 0) continue;
      /** 不足 4.5:1 时选择对比度较高的黑色或白色。 */
      const foregroundLevel = mermaidFillLuminance(foreground, background) + 0.05;
      if (Math.max(backgroundLevel, foregroundLevel) / Math.min(backgroundLevel, foregroundLevel) >= 4.5) continue;
      corrections.push({
        element: label,
        property: 'fill',
        replacement: backgroundLevel / 0.05 >= 1.05 / backgroundLevel ? '#000' : '#fff',
      });
    }
  }
  /** 保存改色前的内联属性，供图表替换或主题切换时恢复。 */
  const originals = corrections.map(({ element, property, replacement }) => {
    /** 原有的颜色和优先级分别属于 SVG 的一个绘制属性。 */
    const value = element.style.getPropertyValue(property);
    /** 内联样式的原始优先级可能为 important。 */
    const priority = element.style.getPropertyPriority(property);
    element.style.setProperty(property, replacement, 'important');
    return { element, property, value, priority };
  });
  return () => {
    for (const { element, property, value, priority } of originals) element.style.setProperty(property, value, priority);
  };
}

/** 横排布局的最小显示字号，单位为 CSS 像素。 */
const MIN_HORIZONTAL_FLOWCHART_FONT_SIZE = 14;

/** 横排缩短节点间距并提早换行，纵排为长标签留出更多宽度，单位均为 CSS 像素。 */
const handDrawnFlowchartLayouts = {
  horizontal: { rankSpacing: 22, wrappingWidth: 150 },
  vertical: { rankSpacing: 24, wrappingWidth: 248 },
};

/** 返回横图声明中方向字样的位置，供预览切换方向时保留其余源码。 */
function horizontalFlowchartDirectionOffset(source: string): number | undefined {
  /** 只取第一条图声明，兼容前置注释和同一行结束的初始化指令。 */
  const header = /(?:^|\}%%)[ \t]*(?:flowchart|graph)(?:\s+(LR|RL|TB|BT|TD))?(?=[\s;]|$)/mu.exec(source);
  return header?.[1] === 'LR' || header?.[1] === 'RL' ? header.index + header[0].length - 2 : undefined;
}

/** 为流程图预览选择手绘色板和布局，固定笔触种子保持切换主题前后的轮廓一致。 */
function handDrawnFlowchartSource(source: string, isDark: boolean, layout?: keyof typeof handDrawnFlowchartLayouts): string {
  /** 背景、节点、分组和标签均使用与当前会话深浅色匹配的色组。 */
  const colors = handDrawnFlowchartColors[isDark ? 'dark' : 'light'];
  /** Markstream 使用开头的 init 指令作为本图配置，并在渲染前交给 Mermaid。 */
  const config = {
    look: 'handDrawn',
    handDrawnSeed: 1,
    theme: 'base',
    /** 西文优先用系统手写字体，中文优先用楷体，缺字时回退到系统界面字体。 */
    fontFamily: '"Chalkboard SE", "Segoe Print", "Kaiti SC", KaiTi, STKaiti, system-ui, sans-serif',
    /** 原生纵图沿用 Mermaid 的默认布局参数。 */
    flowchart: layout ? handDrawnFlowchartLayouts[layout] : undefined,
    themeVariables: {
      darkMode: isDark,
      radius: 12,
      background: colors.canvas,
      primaryColor: colors.node,
      primaryBorderColor: colors.border,
      primaryTextColor: colors.text,
      secondaryColor: colors.group,
      secondaryTextColor: colors.text,
      tertiaryColor: colors.group,
      tertiaryBorderColor: colors.groupBorder,
      tertiaryTextColor: colors.text,
      lineColor: colors.line,
      arrowheadColor: colors.line,
      edgeLabelBackground: colors.canvas,
    },
  };
  return `%%{init: ${JSON.stringify(config)}}%%\n${source}`;
}

/** 自定义节点不会收到默认 loading=false，须显式结束已闭合图表的生成状态。 */
function ConversationMermaidNode(props: ComponentProps<typeof MermaidBlockNode>) {
  /** 语言和正文阶段来自所有 Markdown 展示入口共用的上下文。 */
  const runtime = useContext(MarkdownRuntimeContext);
  /** 图表标题和操作文案使用当前会话语言。 */
  const languageLabels = labels[runtime?.language ?? 'en-US'];
  /** 图表外壳用于读取当前应用主题。 */
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** 预览元素承载 SVG 的配色修正和视口宽度。 */
  const previewRef = useRef<HTMLDivElement | null>(null);
  /** 上游把"画不出来"处理成源码视图且不报错，这里补上用户能看懂的原因。 */
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  /** 源码视图保留原文，预览继续挂载以保留已有缩放状态。 */
  const [showSource, setShowSource] = useState(false);
  /** 已解析源码的样式选择。流式更新后按原文匹配，避免沿用上一段源码的判定。 */
  const [parsedStyle, setParsedStyle] = useState<{ source: string; useDefaultTheme: boolean; handDrawn: boolean; horizontalDirectionOffset?: number } | null>(null);
  /** 纵排时记住同一张图的横排宽度阈值，拉宽窗口后据此恢复横排。 */
  const [narrowLayout, setNarrowLayout] = useState<{ source: string; minimumWidth: number } | null>(null);
  /** 只有当前源码的解析结果能控制预览。 */
  const diagramStyle = parsedStyle?.source === props.node.code ? parsedStyle : null;
  /** 同一个手绘判定控制预览源码配色和绘制后的颜色修正。 */
  const handDrawn = diagramStyle?.handDrawn ?? false;
  /** 默认手绘横图才需要对视口宽度切换方向。 */
  const directionOffset = diagramStyle?.horizontalDirectionOffset;
  /** 宽度阈值以原图源码为身份，避免沿用其他图的测量结果。 */
  const responsiveSource = directionOffset === undefined ? undefined : props.node.code;
  /** 原图命中纵排记录时，保留从横排 SVG 测出的宽度。 */
  const verticalWidth = responsiveSource === narrowLayout?.source ? narrowLayout?.minimumWidth : undefined;
  /** 横图先尝试紧凑横排，达到宽度阈值后再恢复该布局。 */
  const flowchartLayout = responsiveSource === undefined ? undefined : verticalWidth === undefined ? 'horizontal' : 'vertical';
  /** Zeus 手绘预览使用 Mermaid 色板，常规图表继续使用会话 CSS 配色。 */
  const useDefaultTheme = (diagramStyle?.useDefaultTheme ?? true) && !handDrawn;
  /** 正文已经结束时图表代码块不会再增长，必须结束生成态，否则上游会一直只显示源码。 */
  const phase = runtime?.phase ?? 'streaming';
  /** 未闭合代码块继续生成；正文完成后覆盖解析节点残留的生成状态。 */
  const streaming = phase === 'streaming' && Boolean(props.node.loading);
  /** Mermaid 的图形颜色跟随应用主题，而非固定使用浅色。 */
  const [isDark, setIsDark] = useState(false);
  /** 换图、切换方向或主题时重建横图视图，使测量针对当前的 SVG。 */
  const previewKey = flowchartLayout ? `${isDark}:${flowchartLayout}:${responsiveSource}` : String(isDark);
  /** 只替换绘制用的代码，源码查看与复制继续读取助手原文。 */
  const node = useMemo(() => {
    /** 纵排只改预览用的方向，节点、连线和标签使用原图内容。 */
    const source = flowchartLayout === 'vertical' && directionOffset !== undefined ? `${props.node.code.slice(0, directionOffset)}TB${props.node.code.slice(directionOffset + 2)}` : props.node.code;
    return {
      ...props.node,
      code: handDrawn ? handDrawnFlowchartSource(source, isDark, flowchartLayout) : source,
      loading: streaming,
    };
  }, [props.node, directionOffset, flowchartLayout, handDrawn, isDark, streaming]);
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
  useLayoutEffect(() => {
    /** 手绘强调色使用深浅两套规则，常规流程图在深色主题下修正文字。 */
    const preview = previewRef.current;
    if (!preview || (!isDark && !handDrawn)) return;
    /** 上游异步替换 SVG，已有图形在主题规则变更时重新评估。 */
    let diagram: SVGSVGElement | null = null;
    /** 重新评估前恢复作者和主题的原始填充。 */
    let restore: (() => void) | undefined;
    /** 当前源码保持横排字号所需的最小可用宽度。 */
    let minimumWidth = verticalWidth;
    /** 跟随预览列宽度跨过字号阈值，视口退出布局时保留已有方向。 */
    const updateLayout = () => {
      if (responsiveSource === undefined || minimumWidth === undefined) return;
      /** 预览横向内边距为零，列宽即 SVG 的适配宽度。 */
      const availableWidth = preview.clientWidth;
      if (availableWidth === 0) return;
      /** 预计显示字号低于阈值时使用纵排。 */
      const needsVertical = availableWidth < minimumWidth;
      if (needsVertical === (verticalWidth !== undefined)) return;
      setNarrowLayout(needsVertical ? { source: responsiveSource, minimumWidth } : null);
    };
    /** 只处理新增的流程图 SVG，手动缩放不改变其布局阈值。 */
    const applyDiagram = () => {
      /** Mermaid 用无障碍描述标识图表类型。 */
      const next = preview.querySelector<SVGSVGElement>('svg[aria-roledescription^="flowchart"]');
      if (next === diagram) return;
      restore?.();
      diagram = next;
      restore = diagram ? improveMermaidPreviewContrast(diagram, isDark, handDrawn) : undefined;
      if (diagram && responsiveSource !== undefined && verticalWidth === undefined) {
        /** Mermaid 的基础字号在根 SVG 上，viewBox 宽度不受预览缩放影响。 */
        const naturalFontSize = Number.parseFloat(getComputedStyle(diagram).fontSize);
        /** 显示字号按可用宽度等比缩放，反推达到保底字号所需的宽度。 */
        const threshold = (diagram.viewBox.baseVal.width * MIN_HORIZONTAL_FLOWCHART_FONT_SIZE) / naturalFontSize;
        minimumWidth = Number.isFinite(threshold) && threshold > 0 ? threshold : undefined;
        updateLayout();
      }
    };
    /** 只监听 SVG 插入和替换，不监听修正自身的样式变更。 */
    const observer = new MutationObserver(applyDiagram);
    observer.observe(preview, { childList: true, subtree: true });
    /** 横图随会话列和侧栏宽度变化自动选择布局。 */
    const viewportObserver = responsiveSource === undefined ? undefined : new ResizeObserver(updateLayout);
    viewportObserver?.observe(preview);
    applyDiagram();
    return () => {
      observer.disconnect();
      viewportObserver?.disconnect();
      restore?.();
    };
  }, [handDrawn, isDark, responsiveSource, useDefaultTheme, verticalWidth]);
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
        if (!active) return;
        if (parsed === false) {
          setDiagnostic(`${languageLabels.diagramRenderFailed}${languageLabels.diagramSyntaxInvalid}`);
          return;
        }
        /** 显式主题由作者决定。带 YAML 头的图保留其元数据位置和原有渲染入口。 */
        const authoredTheme = Boolean(parsed.config.theme) || Object.keys(parsed.config.themeVariables ?? {}).length > 0;
        /** 只有使用 Zeus 默认手绘主题的流程图参与自适应布局。 */
        const useHandDrawn = !authoredTheme && !parsed.config.themeCSS && /^flowchart(?:-|$)/.test(parsed.diagramType) && (!parsed.config.look || parsed.config.look === 'handDrawn') && !props.node.code.trimStart().startsWith('---');
        setParsedStyle({
          source: props.node.code,
          useDefaultTheme: !authoredTheme,
          handDrawn: useHandDrawn,
          horizontalDirectionOffset: useHandDrawn ? horizontalFlowchartDirectionOffset(props.node.code) : undefined,
        });
      } catch (error) {
        if (active) onRenderError(error);
      }
    });
    return () => {
      active = false;
    };
  }, [languageLabels.diagramRenderFailed, languageLabels.diagramRuntimeUnavailable, languageLabels.diagramSyntaxInvalid, onRenderError, props.node.code, streaming]);
  return (
    <div
      ref={containerRef}
      className="session-code-block session-mermaid-block"
      aria-label={languageLabels.diagram}
      role="group"
      data-source={showSource || Boolean(diagnostic) || undefined}
      data-error={diagnostic ? 'true' : undefined}
      aria-busy={streaming || undefined}
    >
      <div className="session-mermaid-content">
        <div ref={previewRef} className="session-mermaid-preview" data-default-theme={useDefaultTheme} hidden={Boolean(diagnostic)} inert={showSource}>
          {/* 重建后的图从整体视图开始，宽度测量读取当前布局的 SVG。 */}
          <MermaidBlockNode key={previewKey} {...props} node={node} loading={streaming} isDark={isDark} showHeader={false} onRenderError={onRenderError} />
        </div>
        {showSource || diagnostic ? (
          <pre>
            <code>{props.node.code}</code>
          </pre>
        ) : null}
      </div>
      {diagnostic ? (
        <small className="session-markdown-code-truncated" role="status">
          {diagnostic}
        </small>
      ) : null}
      <div className="session-mermaid-toolbar">
        {/* 为已有缩放控件保留同行位置，由图表范围内的 CSS 锚点定位。 */}
        {!showSource && !diagnostic ? <span className="session-mermaid-zoom-slot" aria-hidden="true" /> : null}
        {/* 查看源码不改变图形内容；语法错误时直接显示源码与原因。 */}
        {!diagnostic ? (
          <Button unstyled type="button" onClick={() => setShowSource((current) => !current)}>
            {showSource ? languageLabels.showDiagramPreview : languageLabels.showDiagramSource}
          </Button>
        ) : null}
        <ConversationMarkdownCopyButton label={languageLabels.copyDiagram} copiedLabel={languageLabels.copied} text={props.node.code} />
      </div>
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
} as unknown as CustomComponentMap;

setCustomComponents(CUSTOM_COMPONENTS_ID, conversationMarkdownComponents);
setCustomComponents(MEDIA_CUSTOM_COMPONENTS_ID, { ...conversationMarkdownComponents, paragraph: ConversationParagraphNode });
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
    <Button
      unstyled
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
    </Button>
  );
}

/** 文件遵守现有读取上限；会话额外限制正文和代码块，避免流式输出持续增长。 */
function boundConversationMarkdown(text: string, language: SessionUiLanguage, documentMode = false): { text: string; truncated: boolean } {
  const languageLabels = labels[language];
  /** 文件读取已经限制字节数，此处再限制字符数，保护独立使用组件的调用方。 */
  const characterLimit = documentMode ? filePreviewLimits.text : MAX_CONVERSATION_MARKDOWN_CHARACTERS;
  const documentTruncated = text.length > characterLimit;
  const boundedText = documentTruncated ? `${text.slice(0, characterLimit)}\n\n[${languageLabels.contentTruncated}]` : text;
  const codeBounded = documentMode ? { text: boundedText, truncated: false } : boundMarkdownCodeBlocks(boundedText, languageLabels.codeTruncated);
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
  /** 完整引用优先于旧记录的相对路径匹配，同名文件可以各自打开。 */
  const reference = normalizeConversationResourceReference(href);
  /** 图片按完整来源匹配，同说明不能替代资源身份。 */
  const exactImage = resources.find((candidate) => candidate.presentation === 'inline' && candidate.kind === 'attachment' && candidate.sourceReference && normalizeConversationResourceReference(candidate.sourceReference) === reference);
  /** 目录外文件以完整 Markdown 目标登记，避免不同目录出现同名串链。 */
  const exactExternalFile = resources.find((candidate) => candidate.presentation === 'inline' && candidate.kind === 'file' && candidate.externalReference && normalizeConversationResourceReference(candidate.externalReference) === reference);
  /** 旧记录若存在同说明图片则拒绝猜测；新记录始终按完整引用匹配。 */
  const legacyImages = resources.filter((candidate) => candidate.kind === 'attachment' && !candidate.sourceReference && candidate.displayName === label);
  const candidates = legacyImages.length > 1 ? resources.filter((candidate) => !legacyImages.includes(candidate)) : resources;
  const resource =
    exactImage ??
    exactExternalFile ??
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
  if (resource.kind === 'attachment' || resource.externalReference) return false;
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
