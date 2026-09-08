import { memo, useEffect, useRef, type RefObject } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, keymap, lineNumbers, type ViewUpdate } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import type { ConversationFileLocation } from '@zeus/shared';
import { loadSourceLanguage } from './sourceLanguageRegistry.js';

/** 评论继续由 React 管理，代码视图只负责把容器放在对应行之后。 */
interface SourceLineWidget {
  /** 使用源码的一基行号，保持与评论持久化位置一致。 */
  line: number;
  /** 滚出可视区域时保留容器，以免丢失尚未保存的评论草稿。 */
  element: HTMLElement;
}

/** 只读源码预览的内容、定位和可选评论入口。 */
interface SourceCodePreviewProps {
  path: string;
  content: string;
  language: string | null;
  label: string;
  location?: ConversationFileLocation;
  widgets: SourceLineWidget[];
  /** 新打开的评论容器，完成代码区布局后再聚焦。 */
  focusWidget?: HTMLElement;
  onComment?: (line: number, extendRange: boolean) => void;
  commentLabel: (line: number) => string;
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
  /** 只读历史仍可查看代码，无评论权限时不创建加号入口。 */
  const commentsEnabled = Boolean(props.onComment);

  useEffect(() => {
    if (!hostRef.current) return;
    /** 仅对可视行添加定位样式，定位范围再大也不创建全文行节点。 */
    const selectedLines = ViewPlugin.define(
      (view) => ({
        /** 当前可视范围的行定位装饰。 */
        decorations: selectedLineDecorations(view, propsRef.current.location),
        /** 滚动和定位更新时重新计算可视行，成本不随文件长度增长。 */
        update(update: ViewUpdate) {
          this.decorations = selectedLineDecorations(update.view, propsRef.current.location);
        },
      }),
      {
        decorations: (plugin) => plugin.decorations,
      },
    );
    /** 预览仍允许键盘选择与复制，所有编辑操作由只读状态拒绝。 */
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: props.content,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': propsRef.current.label, 'aria-readonly': 'true' }),
          keymap.of(defaultKeymap),
          syntaxHighlighting(classHighlighter),
          languageSlot.of([]),
          widgetSlot.of([]),
          selectedLines,
          commentsEnabled
            ? gutter({
                class: 'session-source-comment-gutter',
                lineMarker: (editor, line) => new CommentMarker(editor.state.doc.lineAt(line.from).number, propsRef),
              })
            : [],
          lineNumbers(),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [props.content, props.path, props.label, commentsEnabled, languageSlot, widgetSlot]);

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

/** 只为可视代码行提供原有的加号与键盘可达的评论按钮。 */
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
    /** 原生按钮自带焦点与键盘语义。 */
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-code-comment-add';
    button.textContent = '+';
    button.setAttribute('aria-label', this.props.current.commentLabel(this.line));
    button.onclick = (event) => this.props.current.onComment?.(this.line, event.shiftKey);
    return button;
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

/** 高亮仅遍历当前可视范围，避免长范围定位重新展开全文。 */
function selectedLineDecorations(view: EditorView, location?: ConversationFileLocation) {
  /** 每次只保存屏幕附近的行装饰。 */
  const decorations = [];
  // 编辑器已经计算好可视范围，无须扫描全文。
  for (const range of view.visibleRanges) {
    for (let position = range.from; position <= range.to; ) {
      /** 根据文档偏移读取当前行。 */
      const line = view.state.doc.lineAt(position);
      /** 高亮原始请求范围内的可视行。 */
      const selected = Boolean(location?.line && line.number >= location.line && line.number <= (location.endLine ?? location.line));
      decorations.push(Decoration.line({ attributes: { 'data-source-line': String(line.number), ...(selected ? { 'data-selected': 'true' } : {}) } }).range(line.from));
      position = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}
