import { memo, useEffect, useRef, type RefObject } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { syntaxHighlighting } from '@codemirror/language';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, keymap, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import type { ConversationFileLocation } from '@zeus/shared';
import { blameDecorations } from './blameDecorations.js';
import { loadSourceLanguage } from './sourceLanguageRegistry.js';
import { useGitBlame } from './useGitBlame.js';
import { sourceLocationDecorations } from './sourceLocationDecorations.js';
import './blameGutter.css';

/** 文件查找采用编辑器原生文案表，界面与会话语言一致。 */
const sourceSearchPhrases = {
  Find: '查找',
  Replace: '替换',
  next: '下一处',
  previous: '上一处',
  all: '全部',
  'match case': '区分大小写',
  regexp: '正则表达式',
  'by word': '全字匹配',
  close: '关闭',
  'current match': '当前匹配',
  'on line': '所在行',
};

/** 评论继续由 React 管理，代码视图只负责把容器放在对应行之后。 */
interface SourceLineWidget {
  /** 使用源码的一基行号，保持与评论持久化位置一致。 */
  line: number;
  /** 滚出可视区域时保留容器，以免丢失尚未保存的评论草稿。 */
  element: HTMLElement;
}

/** 文件文字评论在 CodeMirror 文档中的稳定选区。 */
export interface SourceTextHighlight {
  /** 选区起点的零基字符偏移。 */
  from: number;
  /** 选区终点的零基字符偏移，右端不包含在内。 */
  to: number;
}

/** 只读源码预览的内容、定位和可选评论入口。 */
interface SourceCodePreviewProps {
  path: string;
  content: string;
  language: string | null;
  label: string;
  projectId?: string;
  conversationId?: string;
  resourceId?: string;
  /** 行尾归属日期使用当前界面语言。 */
  locale?: string;
  /** 工具栏递增请求用于打开或重新聚焦原生文件查找面板。 */
  searchRequest?: number;
  location?: ConversationFileLocation;
  widgets: SourceLineWidget[];
  /** 已保存文字评论的高亮范围。 */
  highlights?: SourceTextHighlight[];
  /** 新打开的评论容器，完成代码区布局后再聚焦。 */
  focusWidget?: HTMLElement;
  onComment?: (line: number, extendRange: boolean) => void;
  commentLabel: (line: number) => string;
  /** 暴露当前只读编辑器，供文字选区评论读取准确文档偏移和视口坐标。 */
  onView?: (view: EditorView | null) => void;
}

/** 复用 CodeMirror 的可视区域渲染和增量高亮，输入框更新不再遍历全文。 */
export const SourceCodePreview = memo(function SourceCodePreview(props: SourceCodePreviewProps) {
  /** 当前预览的挂载节点与编辑器生命周期。 */
  const hostRef = useRef<HTMLDivElement>(null);
  /** 保存唯一编辑器实例，卸载时释放解析与事件资源。 */
  const viewRef = useRef<EditorView | null>(null);
  /** 事件读取最新属性，避免父会话更新触发编辑器重建。 */
  const propsRef = useRef(props);
  propsRef.current = props;
  /** 语言和评论单独更新，均不替换全文或重置滚动位置。 */
  const languageSlot = useRef(new Compartment()).current;
  /** 评论装饰单独更新。 */
  const widgetSlot = useRef(new Compartment()).current;
  /** 文字选区高亮独立更新，不重建编辑器和滚动状态。 */
  const highlightSlot = useRef(new Compartment()).current;
  /** Git blame 装饰单独更新，不因异步读取结果重建编辑器。 */
  const blameSlot = useRef(new Compartment()).current;
  /** 只读历史仍可查看代码，无评论权限时只显示行号。 */
  const commentsEnabled = Boolean(props.onComment);
  /** 自动读取当前资源归属，不再创建额外的按钮或状态行。 */
  const gitBlame = useGitBlame({ projectId: props.projectId, filePath: props.path, conversationId: props.conversationId, resourceId: props.resourceId, content: props.content });

  useEffect(() => {
    if (!hostRef.current) return;
    /** 仅对可视行添加定位样式，定位范围再大也不创建全文行节点。 */
    const selectedLines = sourceLocationDecorations(() => propsRef.current.location);
    /** 预览仍允许键盘选择与复制，所有编辑操作由只读状态拒绝。 */
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: props.content,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': propsRef.current.label, 'aria-readonly': 'true' }),
          search({ top: true }),
          EditorState.phrases.of(propsRef.current.locale === 'zh-CN' ? sourceSearchPhrases : {}),
          keymap.of([...searchKeymap, ...defaultKeymap]),
          syntaxHighlighting(classHighlighter),
          languageSlot.of([]),
          widgetSlot.of([]),
          highlightSlot.of([]),
          blameSlot.of([]),
          selectedLines,
          commentsEnabled
            ? gutter({
                class: 'session-source-comment-gutter',
                lineMarker: (editor, line) => new CommentMarker(editor.state.doc.lineAt(line.from).number, propsRef),
              })
            : lineNumbers(),
        ],
      }),
    });
    viewRef.current = view;
    propsRef.current.onView?.(view);
    return () => {
      propsRef.current.onView?.(null);
      viewRef.current = null;
      view.destroy();
    };
  }, [props.content, props.path, props.label, commentsEnabled, blameSlot, highlightSlot, languageSlot, widgetSlot]);

  useEffect(() => {
    /** Markdown 搜索切到源码后也查找完整文档，不受可视行范围限制。 */
    const view = viewRef.current;
    if (view && props.searchRequest) openSearchPanel(view);
  }, [props.searchRequest, props.content, props.path, props.label, commentsEnabled]);

  useEffect(() => {
    /** 先显示纯文本；加载高亮期间仍可滚动、选择和输入会话内容。 */
    const view = viewRef.current;
    /** 切换文件后忽略旧语言加载结果。 */
    let cancelled = false;
    if (!view) return;
    view.dispatch({ effects: languageSlot.reconfigure([]) });
    void loadSourceLanguage(props.language)
      .then((loaded) => {
        if (!cancelled) view.dispatch({ effects: languageSlot.reconfigure(loaded?.extension ?? []) });
      })
      .catch(() => {
        // 语法模块加载失败时保留可操作的纯文本预览。
      });
    return () => {
      cancelled = true;
    };
  }, [props.language, props.content, props.path, props.label, commentsEnabled, languageSlot]);

  useEffect(() => {
    /** 稀疏评论只按评论数构建，完整代码行由编辑器管理。 */
    const view = viewRef.current;
    if (!view) return;
    /** 区块装饰只占用实际评论所在的行。 */
    const decorations = props.widgets
      .filter((widget) => widget.line >= 1 && widget.line <= view.state.doc.lines)
      .map((widget) => Decoration.widget({ widget: new CommentWidget(widget.element), block: true, side: 1 }).range(view.state.doc.line(widget.line).to));
    view.dispatch({ effects: widgetSlot.reconfigure(EditorView.decorations.of(Decoration.set(decorations, true))) });
    /** 评论编辑、折行与拖动高度变化后同步滚动尺寸。 */
    const observer = new ResizeObserver(() => view.requestMeasure());
    props.widgets.forEach((widget) => observer.observe(widget.element));
    return () => observer.disconnect();
  }, [props.widgets, props.content, props.path, props.label, commentsEnabled, widgetSlot]);

  useEffect(() => {
    /** 只装饰当前文档内的非空选区，失效锚点不影响文件阅读。 */
    const view = viewRef.current;
    if (!view) return;
    const decorations = (props.highlights ?? [])
      .filter((highlight) => Number.isFinite(highlight.from) && Number.isFinite(highlight.to) && highlight.from >= 0 && highlight.to > highlight.from && highlight.to <= view.state.doc.length)
      .map((highlight) => Decoration.mark({ class: 'session-source-comment-range' }).range(Math.trunc(highlight.from), Math.trunc(highlight.to)));
    view.dispatch({ effects: highlightSlot.reconfigure(EditorView.decorations.of(Decoration.set(decorations, true))) });
  }, [props.highlights, props.content, props.path, props.label, commentsEnabled, highlightSlot]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    /** 只在可信资源内容对应的归属读取完成后添加当前行提示。 */
    const extension = gitBlame?.lines.length ? blameDecorations(gitBlame.lines, { locale: props.locale }) : [];
    view.dispatch({ effects: blameSlot.reconfigure(extension) });
  }, [props.locale, blameSlot, gitBlame, props.content, props.path, props.label, commentsEnabled]);

  useEffect(() => {
    /** 新评论先定位到所属行，反向范围评论的结束行也可能在屏幕外。 */
    const view = viewRef.current;
    const widget = propsRef.current.widgets.find((candidate) => candidate.element === props.focusWidget);
    if (!view || !widget || widget.line < 1 || widget.line > view.state.doc.lines) return;
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(widget.line).to, { y: 'center' }) });
    /** 等区块完成挂载与测量再聚焦，不依赖任意延时或与布局争抢滚动位置。 */
    let cancelled = false;
    view.requestMeasure({
      read: () => widget.element.querySelector('textarea'),
      write: (textarea) =>
        queueMicrotask(() => {
          if (!cancelled) textarea?.focus({ preventScroll: true });
        }),
    });
    return () => {
      cancelled = true;
    };
  }, [props.focusWidget, props.content, props.path, props.label, commentsEnabled]);

  useEffect(() => {
    /** 定位只滚动代码区域，不抢回用户正在打字的输入焦点。 */
    const view = viewRef.current;
    /** 外部定位输入先检查有限数值，再收敛到文档范围。 */
    const line = props.location?.line;
    if (!view || !line || !Number.isFinite(line)) return;
    /** 避免越界或小数行号导致编辑器抛错。 */
    const boundedLine = Math.max(1, Math.min(Math.trunc(line), view.state.doc.lines));
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(boundedLine).from, { y: 'center' }) });
  }, [props.location, props.content, props.path, props.label, commentsEnabled]);

  return <div className="session-source-code-preview" ref={hostRef} />;
});

/** 评论入口覆盖当前行号，不为每行另占一列宽度。 */
class CommentMarker extends GutterMarker {
  /** 按钮绑定当前行，事件由最新的预览回调处理。 */
  constructor(
    private readonly line: number,
    private readonly props: RefObject<SourceCodePreviewProps>,
  ) {
    super();
  }

  /** 相同行号和文案复用按钮，避免滚动时反复替换焦点节点。 */
  eq(other: CommentMarker): boolean {
    return this.line === other.line && this.props === other.props;
  }

  /** 原生按钮支持鼠标、Shift 范围选择及键盘触发。 */
  toDOM(): HTMLElement {
    /** 行号正常显示；悬停或聚焦时由评论入口覆盖。 */
    const marker = document.createElement('span');
    marker.className = 'session-source-line-number';
    marker.textContent = String(this.line);
    /** 原生按钮自带焦点与键盘语义。 */
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-code-comment-add';
    button.setAttribute('aria-label', this.props.current.commentLabel(this.line));
    button.onclick = (event) => this.props.current.onComment?.(this.line, event.shiftKey);
    marker.append(button);
    return marker;
  }
}

/** 编辑器只挂载评论容器，React 门户继续持有评论组件与草稿。 */
export class CommentWidget extends WidgetType {
  /** 保存 React 拥有的节点，不在滚出可视区域时销毁评论状态。 */
  constructor(private readonly element: HTMLElement) {
    super();
  }

  /** 评论容器身份不变时复用已挂载节点。 */
  eq(other: CommentWidget): boolean {
    return this.element === other.element;
  }

  /** 把已有评论容器交给编辑器放置到指定行后。 */
  toDOM(): HTMLElement {
    return this.element;
  }
}
