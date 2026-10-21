import { defaultKeymap, history, historyKeymap, insertNewline, invertedEffects, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Compartment, EditorState, StateEffect, Transaction } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder } from '@codemirror/view';
import { type ClipboardEventHandler, type KeyboardEventHandler, type RefObject, useLayoutEffect, useRef } from 'react';
import type { StructuredToken } from './StructuredComposerInput.js';
import { composerMarkdownPreview } from './composerMarkdownPreview.js';
import { markdownListKeymap } from '../code/markdownListKeymap.js';

/** 标签位置随润色事务进入原生撤销历史，不另建有限长度的草稿缓存。 */
const composerTokenReplacement = StateEffect.define<{ before: StructuredToken[]; after: StructuredToken[] }>();

/** 普通目标输入和 Markdown 输入共用正文、选区与焦点接口，不依赖具体编辑节点。 */
export type ComposerInputHandle = Pick<HTMLTextAreaElement, 'value' | 'selectionStart' | 'selectionEnd' | 'focus' | 'setSelectionRange' | 'isConnected' | 'contains'> & {
  /** 明确采用建议或润色后，以独立可撤销事务替换仍与界面一致的当前原文。 */
  replaceDraft?: (expected: string, text: string) => boolean;
};

/** 润色必须保留所有引用标签的顺序和数量，无法确定位置时拒绝替换。 */
export function relocateComposerTokens(text: string, tokens: readonly StructuredToken[]): StructuredToken[] | null {
  /** 相同标签可出现多次，但不能由模型增删。 */
  const labels = new Set(tokens.map((token) => token.label));
  for (const label of labels) {
    if (!label || text.split(label).length - 1 !== tokens.filter((token) => token.label === label).length) return null;
  }
  /** 引用顺序也是用户意图的一部分。 */
  let cursor = 0;
  /** 保留原身份，只调整文字位置。 */
  const relocated: StructuredToken[] = [];
  for (const token of tokens) {
    /** 每个标签都必须在前一个之后出现。 */
    const start = text.indexOf(token.label, cursor);
    if (start < 0) return null;
    cursor = start + token.label.length;
    relocated.push({ ...token, start, end: cursor });
  }
  return relocated;
}

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
  /** 灰字只属于 placeholder，不改变文档、撤销栈或草稿。 */
  suggestion?: string | null;
  language: 'zh-CN' | 'en-US';
  listboxId?: string;
  activeDescendant?: string;
  onChange(value: string, caret: number, restoredTokens?: StructuredToken[]): void;
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
          // 撤销和重做使用同一效果的反向映射，保留原标签身份。
          invertedEffects.of((transaction) => transaction.effects.flatMap((effect) => (effect.is(composerTokenReplacement) ? [composerTokenReplacement.of({ before: effect.value.after, after: effect.value.before })] : []))),
          EditorView.lineWrapping,
          // 使用编辑器绘制光标，避免多行占位建议拉高浏览器原生光标。
          drawSelection(),
          markdownListKeymap,
          keymap.of([{ key: 'Shift-Enter', run: insertNewline }, ...defaultKeymap, ...historyKeymap]),
          composerMarkdownPreview(() => latest.current.tokens, latest.current.language),
          options.current.of([]),
          EditorView.updateListener.of((update) => {
            if (applying.current) return;
            if (update.docChanged) {
              /** 只有明确润色及其撤销、重做携带标签恢复效果。 */
              const replacement = update.transactions.flatMap((transaction) => transaction.effects).find((effect) => effect.is(composerTokenReplacement));
              latest.current.onChange(update.state.doc.toString(), update.state.selection.main.head, replacement?.is(composerTokenReplacement) ? replacement.value.after : undefined);
            } else if (update.selectionSet) latest.current.onSelect(update.state.selection.main.head);
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
      /** 替换前核对原文，引用未保留时继续编辑，不删除标签。 */
      replaceDraft: (expected, text) => {
        if (view.composing || view.state.readOnly || view.state.doc.toString() !== expected) return false;
        /** 标签按原身份定位，任一缺失都拒绝修改正文。 */
        const relocated = relocateComposerTokens(text, latest.current.tokens);
        if (!relocated) return false;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: text.length },
          effects: composerTokenReplacement.of({ before: latest.current.tokens, after: relocated }),
          annotations: [Transaction.userEvent.of('input.polish'), isolateHistory.of('full')],
        });
        return true;
      },
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
        placeholder(props.suggestion ?? props.placeholder),
        EditorView.contentAttributes.of({
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': props.ariaLabel,
          /** placeholder 不属于正文；辅助技术通过描述读出建议及采纳方法。 */
          'aria-description': props.suggestion
            ? props.language === 'zh-CN'
              ? `输入建议：${props.suggestion} 按 Tab 采纳后编辑，或点击发送按钮直接发送；按 Escape 清除。`
              : `Input suggestion: ${props.suggestion} Press Tab to accept and edit, click Send to send directly, or press Escape to dismiss.`
            : '',
          'aria-keyshortcuts': props.ariaKeyShortcuts ?? '',
          'aria-disabled': String(Boolean(props.disabled)),
          'aria-autocomplete': props.listboxId ? 'list' : 'none',
          'aria-expanded': String(Boolean(props.listboxId)),
          'aria-controls': props.listboxId ?? '',
          'aria-activedescendant': props.activeDescendant ?? '',
        }),
      ]),
    });
  }, [props.disabled, props.placeholder, props.suggestion, props.language, props.ariaLabel, props.ariaKeyShortcuts, props.listboxId, props.activeDescendant]);

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
      onKeyDownCapture={(event) => {
        // 表格单元格拥有自己的编辑快捷键，回车不穿透到会话发送。
        if (!(event.target instanceof HTMLInputElement)) props.onKeyDown(event);
      }}
      onPasteCapture={(event) => {
        // 单元格文本由原生输入控件粘贴，避免按外层光标位置写进别的正文。
        if (!(event.target instanceof HTMLInputElement)) props.onPaste?.(event);
      }}
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
