import { memo, useEffect, useMemo, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { defaultKeymap, historyField, indentWithTab } from '@codemirror/commands';
import { Compartment, EditorState, StateEffect, type Extension, type Text } from '@codemirror/state';
import { EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import type { ConversationFileLocation } from '@zeus/shared';
import { loadSourceLanguage } from './sourceLanguageRegistry.js';
import { editorTooltips } from './editorTooltips.js';
import { markdownListKeymap } from './markdownListKeymap.js';
import { blameDecorations, type BlameSource } from './blameDecorations.js';
import './blameGutter.css';
import { useCodeReadingOptions } from './codeReadingOptions.js';
import type { GitBlameLine } from '../features/git/gitContracts.js';

/** 一次编辑在旧文档中的范围及替换后的长度，多光标编辑取共同覆盖范围。 */
export interface CodeTextChange {
  /** 旧文档中的起始偏移。 */
  from: number;
  /** 旧文档中的结束偏移。 */
  to: number;
  /** 新文档中覆盖范围的字符数。 */
  insertedLength: number;
}

/** 源码、差异和冲突共用可视区域编辑器；额外行操作由调用方提供扩展。 */
export interface CodeEditorProps {
  /** 文档身份，切换文件时释放旧编辑器。 */
  path: string;
  /** 双栏差异由 MergeView 持有视图，本组件复用源码键位、语言、归属和阅读设置。 */
  externalView?: EditorView;
  /** 相同真实正文切换差异布局时移交撤销记录和选区。 */
  historyState?: EditorState;
  /** 空值表示纯文本。 */
  language: string | null;
  /** 草稿可保留编辑器的不可变文档，避免每次输入复制全文。 */
  content: string | Text;
  /** 当前磁盘内容，仅源码编辑页用来计算未保存状态。 */
  savedContent?: string;
  /** 只读视图仍支持键盘选择和复制。 */
  readOnly: boolean;
  /** 无障碍名称默认使用文件路径。 */
  label?: string;
  /** 归属使用当前显示文档行号，差异调用方负责映射原始行号。 */
  blameLines?: GitBlameLine[];
  /** 共享阅读菜单使用所在页面语言。 */
  locale?: string;
  /** 一基目标行号；定位不会抢占其他输入框焦点。 */
  revealLine?: number | null;
  /** 文件引用保留每次点击的位置对象，同一行重复点击也重新定位。 */
  location?: ConversationFileLocation;
  /** 行号、差异标记、评论和滚动同步等实际视图扩展。 */
  extensions?: Extension;
  /** 已授权的版本归属；差异视图可按显示行映射到原始行。 */
  blame?: BlameSource;
  /** 光标行提交详情沿用当前界面的日期语言。 */
  blameLocale?: string;
  /** 需要字符串的冲突模型在这里接收变更。 */
  onChange?(content: string, change: CodeTextChange): void;
  /** 源码标签保留不可变文档，保存时才转为字符串。 */
  onDocumentChange?(content: Text, dirty: boolean): void;
  /** 光标状态用于源码页状态栏。 */
  onCursorChange?(line: number, column: number): void;
  /** 保存当前文件。 */
  onSave?(): void;
  /** 保存所有源码标签。 */
  onSaveAll?(): void;
  /** 视图就绪或卸载时登记实例，供多栏同步使用。 */
  onView?(view: EditorView | null): void;
}

/** 编辑器实例独立于 React 输入更新，语言异步加载期间先显示纯文本。 */
export const CodeEditor = memo(function CodeEditor(props: CodeEditorProps) {
  /** 编辑器宿主。 */
  const hostRef = useRef<HTMLDivElement>(null);
  /** 当前文件唯一编辑器实例。 */
  const viewRef = useRef<EditorView | null>(null);
  // 外部编辑器已经挂载，阅读菜单安装时直接使用其真实父容器。
  if (props.externalView) hostRef.current = props.externalView.dom.parentElement as HTMLDivElement | null;
  /** 事件始终使用最新回调，避免父页面更新重建编辑器。 */
  const callbacksRef = useRef(props);
  callbacksRef.current = props;
  /** 最后发布或接收的内容用于识别受控状态回传。 */
  const contentRef = useRef(props.content);
  /** 外部加载、撤销和冲突选入不应再次被当作手工输入提交。 */
  const applyingContent = useRef(false);
  /** 保存基线只在磁盘内容变化时构造。 */
  const savedDocument = useMemo(() => {
    if (props.savedContent === undefined) return null;
    /** 保存回执匹配当前内容时共用文档树，后续等长编辑也能跳过未修改片段。 */
    const currentDocument = viewRef.current?.state.doc;
    return currentDocument?.toString() === props.savedContent ? currentDocument : EditorState.create({ doc: props.savedContent }).doc;
  }, [props.savedContent]);
  /** 输入监听直接读取当前保存基线。 */
  const savedDocumentRef = useRef(savedDocument);
  savedDocumentRef.current = savedDocument;
  /** 语言加载不替换文档和撤销记录。 */
  const languageSlot = useRef(new Compartment()).current;
  /** 读写状态可动态切换。 */
  const accessSlot = useRef(new Compartment()).current;
  /** 行操作与装饰可独立更新。 */
  const decorationSlot = useRef(new Compartment()).current;
  /** 行尾提交详情独立更新，不重建编辑器或撤销记录。 */
  const blameSlot = useRef(new Compartment()).current;
  /** 阅读选项独立更新，保留选区、滚动和撤销记录。 */
  const readingSlot = useRef(new Compartment()).current;
  /** 源码、只读预览和差异共用行号菜单。 */
  const reading = useCodeReadingOptions(hostRef, props.blameLines, props.locale, props.externalView);

  useEffect(() => {
    if (props.externalView) hostRef.current = props.externalView.dom.parentElement as HTMLDivElement | null;
    if (!hostRef.current) return;
    contentRef.current = callbacksRef.current.content;
    /** 已有编辑器同时承担长文本浏览和源码编辑，限制实际挂载行数。 */
    const retained = callbacksRef.current.historyState;
    const restoreHistory = retained?.doc.toString() === callbacksRef.current.content;
    const config = {
      selection: restoreHistory ? retained.selection : undefined,
      doc: callbacksRef.current.content === callbacksRef.current.savedContent && savedDocumentRef.current ? savedDocumentRef.current : callbacksRef.current.content,
      extensions: [
        // 只读栏同样显示控制字符，CRLF 原文中的 CR 不额外撑开代码行。
        callbacksRef.current.onChange || callbacksRef.current.onDocumentChange ? basicSetup : [lineNumbers(), drawSelection(), highlightSpecialChars(), keymap.of(defaultKeymap)],
        restoreHistory && retained.field(historyField, false) ? historyField.init(() => retained.field(historyField)) : [],
        editorTooltips,
        languageSlot.of([]),
        accessSlot.of([]),
        decorationSlot.of(callbacksRef.current.extensions ?? []),
        blameSlot.of([]),
        readingSlot.of([]),
        syntaxHighlighting(classHighlighter),
        keymap.of([
          indentWithTab,
          {
            key: 'Mod-s',
            run: () => {
              callbacksRef.current.onSave?.();
              return true;
            },
          },
          {
            key: 'Mod-Alt-s',
            run: () => {
              callbacksRef.current.onSaveAll?.();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingContent.current) {
            /** 文档树共用未修改片段，未保存判断不再拆分整份源码。 */
            const content = update.state.doc;
            contentRef.current = callbacksRef.current.onChange ? content.toString() : content;
            if (callbacksRef.current.onChange) {
              /** 直接使用编辑事务的偏移，冲突编辑无需逐字比较全文。 */
              let from = update.startState.doc.length;
              let to = 0;
              let nextFrom = content.length;
              let nextTo = 0;
              update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
                from = Math.min(from, fromA);
                to = Math.max(to, toA);
                nextFrom = Math.min(nextFrom, fromB);
                nextTo = Math.max(nextTo, toB);
              });
              callbacksRef.current.onChange(contentRef.current as string, { from, to, insertedLength: nextTo - nextFrom });
            }
            callbacksRef.current.onDocumentChange?.(content, !savedDocumentRef.current || !content.eq(savedDocumentRef.current));
          }
          if (update.selectionSet || update.docChanged) {
            /** 从文档索引读取光标所在行。 */
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            callbacksRef.current.onCursorChange?.(line.number, head - line.from + 1);
          }
        }),
        EditorView.theme({
          '&': { height: '100%', minHeight: '0', backgroundColor: 'var(--zeus-code-editor-bg, var(--zeus-product-panel))' },
          '.cm-scroller': { overflow: 'auto', fontFamily: "'SFMono-Regular', 'SF Mono', Menlo, Consolas, monospace", fontSize: '12px', lineHeight: '20px' },
          '.cm-content': { caretColor: 'var(--zeus-control-accent)', paddingBlock: '10px 32px' },
          '.cm-gutters': { backgroundColor: 'var(--zeus-code-editor-gutter, var(--zeus-product-panel-muted))', border: '0', color: 'var(--zeus-product-muted)' },
          '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--zeus-code-editor-active-line)' },
          '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--zeus-code-editor-selection, color-mix(in srgb, var(--zeus-brand-primary, #6152d9) 25%, transparent)) !important' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    };
    /** 外部视图保留 MergeView 的增量差异与撤销状态，只追加共享源码能力。 */
    const view = props.externalView ?? new EditorView({ parent: hostRef.current, state: EditorState.create(config) });
    if (props.externalView) view.dispatch({ effects: StateEffect.appendConfig.of(config.extensions) });
    viewRef.current = view;
    callbacksRef.current.onView?.(view);
    return () => {
      callbacksRef.current.onView?.(null);
      viewRef.current = null;
      if (!props.externalView) view.destroy();
    };
  }, [props.path, props.externalView, languageSlot, accessSlot, decorationSlot, blameSlot, readingSlot]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readingSlot.reconfigure(reading.extension) });
  }, [props.path, props.externalView, reading.extension, readingSlot]);

  useEffect(() => {
    /** 文件切换后丢弃旧语言加载结果；失败保留可用的纯文本。 */
    let cancelled = false;
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: languageSlot.reconfigure([]) });
    void loadSourceLanguage(props.language)
      .then((loaded) => {
        // 统一规则先于 Markdown 自带键位处理字母列表，其他代码语言沿用自己的缩进。
        if (!cancelled) view.dispatch({ effects: languageSlot.reconfigure([props.language === 'markdown' ? markdownListKeymap : [], loaded?.extension ?? []]) });
      })
      .catch(() => {
        /* 高亮失败不阻断文本查看和编辑。 */
      });
    return () => {
      cancelled = true;
    };
  }, [props.language, props.path, props.externalView, languageSlot]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: accessSlot.reconfigure([
        EditorState.readOnly.of(props.readOnly),
        EditorView.editable.of(!props.readOnly),
        EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': props.label ?? props.path, 'aria-readonly': String(props.readOnly) }),
      ]),
    });
  }, [props.readOnly, props.label, props.path, props.externalView, accessSlot]);

  useEffect(() => {
    /** 编辑器刚发出的内容无需再转换或替换，保留输入法、选择与撤销记录。 */
    const view = viewRef.current;
    if (!view) return;
    /** 文档和行装饰在同一事务更新，文件缩短时不会引用旧的越界偏移。 */
    const changed = contentRef.current !== props.content && (typeof props.content !== 'string' || view.state.doc.toString() !== props.content);
    contentRef.current = props.content;
    applyingContent.current = true;
    try {
      view.dispatch({ ...(changed ? { changes: { from: 0, to: view.state.doc.length, insert: props.content } } : {}), effects: decorationSlot.reconfigure(props.extensions ?? []) });
    } finally {
      applyingContent.current = false;
    }
  }, [props.content, props.path, props.externalView, props.extensions, decorationSlot]);

  useEffect(() => {
    /** 正文切换后只挂载与本次版本对应的光标行提示。 */
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: blameSlot.reconfigure(props.blame ? blameDecorations(props.blame, { locale: props.blameLocale ?? props.locale }) : []) });
  }, [props.blame, props.blameLocale, props.locale, props.content, props.path, props.externalView, blameSlot]);

  useEffect(() => {
    /** 定位仅滚动目标编辑器，不抢占会话或评论输入焦点。 */
    const view = viewRef.current;
    const requested = props.location?.line ?? props.revealLine;
    if (!view || !requested || !Number.isFinite(requested)) return;
    const line = view.state.doc.line(Math.max(1, Math.min(Math.trunc(requested), view.state.doc.lines)));
    /** 内容搜索保留命中列，长代码行横向滚动到真实位置。 */
    const column = props.location?.column;
    /** 外部列号按当前文档长度收敛，文件变化后仍能安全定位。 */
    const offset = column && Number.isFinite(column) ? Math.max(0, Math.min(Math.trunc(column) - 1, line.length)) : 0;
    view.dispatch({ effects: EditorView.scrollIntoView(line.from + offset, { y: 'center' }) });
  }, [props.location, props.revealLine, props.path, props.externalView]);

  return (
    <>
      {!props.externalView ? <div className="project-source-code-editor" style={{ height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden' }} ref={hostRef} aria-label={props.label ?? props.path} /> : null}
      {reading.menu}
    </>
  );
});
