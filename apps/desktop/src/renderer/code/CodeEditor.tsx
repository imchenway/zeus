import { memo, useEffect, useMemo, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { loadSourceLanguage } from './sourceLanguageRegistry.js';

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
  /** 一基目标行号；定位不会抢占其他输入框焦点。 */
  revealLine?: number | null;
  /** 行号、差异标记、评论和滚动同步等实际视图扩展。 */
  extensions?: Extension;
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

  useEffect(() => {
    if (!hostRef.current) return;
    contentRef.current = callbacksRef.current.content;
    /** 已有编辑器同时承担长文本浏览和源码编辑，限制实际挂载行数。 */
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: callbacksRef.current.content === callbacksRef.current.savedContent && savedDocumentRef.current ? savedDocumentRef.current : callbacksRef.current.content,
        extensions: [
          // 只读栏同样显示控制字符，CRLF 原文中的 CR 不额外撑开代码行。
          callbacksRef.current.onChange || callbacksRef.current.onDocumentChange ? basicSetup : [lineNumbers(), highlightSpecialChars(), keymap.of(defaultKeymap)],
          languageSlot.of([]),
          accessSlot.of([]),
          decorationSlot.of(callbacksRef.current.extensions ?? []),
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
            '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--zeus-code-editor-selection) !important' },
            '&.cm-focused': { outline: 'none' },
          }),
        ],
      }),
    });
    viewRef.current = view;
    callbacksRef.current.onView?.(view);
    return () => {
      callbacksRef.current.onView?.(null);
      viewRef.current = null;
      view.destroy();
    };
  }, [props.path, languageSlot, accessSlot, decorationSlot]);

  useEffect(() => {
    /** 文件切换后丢弃旧语言加载结果；失败保留可用的纯文本。 */
    let cancelled = false;
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: languageSlot.reconfigure([]) });
    void loadSourceLanguage(props.language)
      .then((loaded) => {
        if (!cancelled) view.dispatch({ effects: languageSlot.reconfigure(loaded?.extension ?? []) });
      })
      .catch(() => {
        /* 高亮失败不阻断文本查看和编辑。 */
      });
    return () => {
      cancelled = true;
    };
  }, [props.language, props.path, languageSlot]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: accessSlot.reconfigure([
        EditorState.readOnly.of(props.readOnly),
        EditorView.editable.of(!props.readOnly),
        EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': props.label ?? props.path, 'aria-readonly': String(props.readOnly) }),
      ]),
    });
  }, [props.readOnly, props.label, props.path, accessSlot]);

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
  }, [props.content, props.path, props.extensions, decorationSlot]);

  useEffect(() => {
    /** 定位仅滚动目标编辑器，不抢占会话或评论输入焦点。 */
    const view = viewRef.current;
    const requested = props.revealLine;
    if (!view || !requested || !Number.isFinite(requested)) return;
    const line = view.state.doc.line(Math.max(1, Math.min(Math.trunc(requested), view.state.doc.lines)));
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
  }, [props.revealLine, props.path]);

  return <div className="project-source-code-editor" style={{ height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden' }} ref={hostRef} aria-label={props.label ?? props.path} />;
});
