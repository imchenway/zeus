import { Prec, Transaction, type Extension } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { keymap, type EditorView } from '@codemirror/view';
import { continueMarkdownList, indentMarkdownList } from '../../preload/markdownListEditing.js';

/** 会话及 Markdown 源码共用列表规则，修改仍属于编辑器原生事务。 */
export const markdownListKeymap: Extension = Prec.high(
  keymap.of([
    { key: 'Enter', run: continueList },
    { key: 'Shift-Enter', run: continueList },
    { key: 'Tab', run: (view) => indentList(view, false) },
    { key: 'Shift-Tab', run: (view) => indentList(view, true) },
  ]),
);

/** 多光标和只读视图保持 CodeMirror 原有语义，不只修改其中一个选区。 */
function applyListEdit(view: EditorView, action: 'newline' | 'indent' | 'outdent'): boolean {
  if (view.composing || view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
  /** 同一个文本变换服务于原生输入框和富文本会话编辑器。 */
  const selection = view.state.selection.main;
  const text = view.state.doc.toString();
  const edit = action === 'newline' ? continueMarkdownList(text, selection.from, selection.to) : indentMarkdownList(text, selection.from, selection.to, action === 'outdent');
  if (!edit) return false;
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.anchor, head: edit.head },
    annotations: [Transaction.userEvent.of(action === 'newline' ? 'input' : 'input.indent'), isolateHistory.of('full')],
    scrollIntoView: true,
  });
  return true;
}

/** 实际换行时续写；会话捕获阶段已经处理 Enter 发送和命令选择。 */
function continueList(view: EditorView): boolean {
  return applyListEdit(view, 'newline');
}

/** 只消费列表的缩进键，其余 Tab 保留原编辑器或焦点行为。 */
function indentList(view: EditorView, outdent: boolean): boolean {
  return applyListEdit(view, outdent ? 'outdent' : 'indent');
}
