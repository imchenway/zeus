import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { type ClipboardEventHandler, type KeyboardEventHandler, type RefObject, useLayoutEffect, useRef } from 'react';
import type { StructuredToken } from './StructuredComposerInput.js';
import { composerMarkdownPreview } from './composerMarkdownPreview.js';

/** 普通目标输入和 Markdown 输入共用正文、选区与焦点接口，不依赖具体编辑节点。 */
export type ComposerInputHandle = Pick<HTMLTextAreaElement, 'value' | 'selectionStart' | 'selectionEnd' | 'focus' | 'setSelectionRange' | 'isConnected' | 'contains'>;

/** 会话输入只暴露正文和编辑事件，排版不参与发送内容计算。 */
interface MarkdownComposerEditorProps {
  value: string;
  inputRef: RefObject<ComposerInputHandle | null>;
  tokens: StructuredToken[];
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel: string;
  ariaKeyShortcuts?: string;
  placeholder: string;
  language: 'zh-CN' | 'en-US';
  listboxId?: string;
  activeDescendant?: string;
  onChange(value: string, caret: number): void;
  onSelect(caret: number): void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement | HTMLDivElement>;
  onCompositionStart(): void;
  onCompositionEnd(value: string): void;
  onBlur?(value: string): void;
}

/** 同一个编辑器持续保存原文、撤销和输入法状态，外部草稿仅在实际变化时写入。 */
export function MarkdownComposerEditor(props: MarkdownComposerEditorProps) {
  /** React 更新回调时不重建正在输入的编辑器。 */
  const latest = useRef(props);
  latest.current = props;
  /** 承载编辑器的唯一节点。 */
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** 编辑器实例用于同步草稿和恢复光标。 */
  const viewRef = useRef<EditorView | null>(null);
  /** 可变属性通过配置事务更新，保留撤销栈。 */
  const options = useRef(new Compartment());
  /** 发送清空时移除旧消息的撤销记录。 */
  const undoSlot = useRef(new Compartment());
  /** 标识外部草稿回写，避免再次通知调用方。 */
  const applying = useRef(false);

  useLayoutEffect(() => {
    if (!hostRef.current) return;
    /** 会话按键在 React 捕获阶段处理，CodeMirror 继续管理普通编辑与撤销。 */
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          markdown({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false, pasteURLAsLink: false }),
          undoSlot.current.of(history()),
          EditorView.lineWrapping,
          keymap.of([{ key: 'Shift-Enter', run: insertNewline }, ...defaultKeymap, ...historyKeymap]),
          composerMarkdownPreview(() => latest.current.tokens, latest.current.language),
          options.current.of([]),
          EditorView.updateListener.of((update) => {
            if (applying.current) return;
            if (update.docChanged) latest.current.onChange(update.state.doc.toString(), update.state.selection.main.head);
            else if (update.selectionSet) latest.current.onSelect(update.state.selection.main.head);
          }),
        ],
      }),
    });
    viewRef.current = view;
    /** 光标接口以原文偏移为准，结构化标签和附件恢复沿用同一坐标。 */
    const handle: ComposerInputHandle = {
      get value() {
        return view.state.doc.toString();
      },
      get selectionStart() {
        return view.state.selection.main.from;
      },
      get selectionEnd() {
        return view.state.selection.main.to;
      },
      get isConnected() {
        return view.dom.isConnected;
      },
      contains: (node) => view.dom.contains(node),
      focus: () => view.focus(),
      setSelectionRange: (start, end) => {
        view.dispatch({ selection: { anchor: Math.max(0, Math.min(start ?? 0, view.state.doc.length)), head: Math.max(0, Math.min(end ?? 0, view.state.doc.length)) }, scrollIntoView: true });
      },
    };
    latest.current.inputRef.current = handle;
    if (latest.current.autoFocus) view.focus();
    return () => {
      if (latest.current.inputRef.current === handle) latest.current.inputRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    /** 禁用和菜单语义同步到实际可编辑节点。 */
    viewRef.current?.dispatch({
      effects: options.current.reconfigure([
        EditorState.readOnly.of(Boolean(props.disabled)),
        EditorView.editable.of(!props.disabled),
        placeholder(props.placeholder),
        EditorView.contentAttributes.of({
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': props.ariaLabel,
          'aria-keyshortcuts': props.ariaKeyShortcuts ?? '',
          'aria-disabled': String(Boolean(props.disabled)),
          'aria-autocomplete': props.listboxId ? 'list' : 'none',
          'aria-expanded': String(Boolean(props.listboxId)),
          'aria-controls': props.listboxId ?? '',
          'aria-activedescendant': props.activeDescendant ?? '',
        }),
      ]),
    });
  }, [props.disabled, props.placeholder, props.ariaLabel, props.ariaKeyShortcuts, props.listboxId, props.activeDescendant]);

  useLayoutEffect(() => {
    /** 本地输入的回显不替换文档；发送清空同时清理撤销，避免下一轮撤销恢复已发消息。 */
    const view = viewRef.current;
    if (!view || view.composing) return;
    if (view.state.doc.toString() === props.value) {
      // 标签的偏移也会随输入更新，空事务只刷新装饰而不动文档和选区。
      view.dispatch({});
      return;
    }
    applying.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, annotations: Transaction.addToHistory.of(false), ...(props.value ? {} : { effects: undoSlot.current.reconfigure([]) }) });
      if (!props.value) view.dispatch({ effects: undoSlot.current.reconfigure(history()) });
    } finally {
      applying.current = false;
    }
  }, [props.value, props.tokens]);

  return (
    <div
      ref={hostRef}
      className="structured-composer-editor"
      onKeyDownCapture={props.onKeyDown}
      onPasteCapture={props.onPaste}
      onCompositionStart={props.onCompositionStart}
      onCompositionEnd={() => {
        // 等待编辑器收取最终组合文本，再解除调用方的草稿持久化保护。
        requestAnimationFrame(() => {
          if (viewRef.current) latest.current.onCompositionEnd(viewRef.current.state.doc.toString());
        });
      }}
      onBlur={() => props.onBlur?.(viewRef.current?.state.doc.toString() ?? props.value)}
    />
  );
}
