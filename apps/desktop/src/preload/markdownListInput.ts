import { continueMarkdownList, indentMarkdownList, type MarkdownListEdit } from './markdownListEditing.js';

/** 每个应用文档或评论影子根只安装一组委托事件。 */
const installations = new WeakMap<Document | ShadowRoot, { count: number; dispose(): void }>();

/** 全局处理原生多行文本；代码、结构化配置和终端明确保留字面输入。 */
export function installMarkdownListInput(root: Document | ShadowRoot): () => void {
  /** 系统窗口可能有多个挂载方，监听按引用计数释放。 */
  const existing = installations.get(root);
  if (existing) {
    existing.count += 1;
    return () => release(root);
  }
  /** 组合输入只在确认后处理，避免中文候选回车插入编号。 */
  const composing = new WeakSet<EventTarget>();
  /** 只获取当前根中的可写 textarea，不接管网页正文或 CodeMirror 内部节点。 */
  function target(event: Event): HTMLTextAreaElement | null {
    const element = event.composedPath()[0] as HTMLTextAreaElement | undefined;
    if (element?.tagName !== 'TEXTAREA' || element.disabled || element.readOnly || element.closest('[data-markdown-lists="off"], .xterm, .cm-editor')) return null;
    return element;
  }
  /** 换行事件发生在发送和命令菜单快捷键之后，已处理的按键不会走到这里。 */
  function beforeInput(event: Event): void {
    const input = event as InputEvent;
    const textarea = target(event);
    if (!textarea || input.defaultPrevented || !input.cancelable || input.isComposing || composing.has(textarea) || !['insertLineBreak', 'insertParagraph'].includes(input.inputType)) return;
    const edit = continueMarkdownList(textarea.value, textarea.selectionStart, textarea.selectionEnd);
    if (edit && applyEdit(textarea, edit)) event.preventDefault();
  }
  /** 列表内 Tab 调整层级，其他场景继续移动焦点。 */
  function keyDown(event: Event): void {
    const key = event as KeyboardEvent;
    const textarea = target(event);
    if (!textarea || key.defaultPrevented || key.key !== 'Tab' || key.altKey || key.ctrlKey || key.metaKey || key.isComposing || key.keyCode === 229 || composing.has(textarea)) return;
    const edit = indentMarkdownList(textarea.value, textarea.selectionStart, textarea.selectionEnd, key.shiftKey);
    if (edit && applyEdit(textarea, edit)) event.preventDefault();
  }
  /** 输入法开始时记录真实编辑节点，不依赖事件重定向后的影子宿主。 */
  function compositionStart(event: Event): void {
    const textarea = target(event);
    if (textarea) composing.add(textarea);
  }
  /** 确认输入后释放组合状态，最终文字仍由原生输入事件写入。 */
  function compositionEnd(event: Event): void {
    const textarea = target(event);
    if (textarea) composing.delete(textarea);
  }
  root.addEventListener('beforeinput', beforeInput);
  root.addEventListener('keydown', keyDown);
  root.addEventListener('compositionstart', compositionStart);
  root.addEventListener('compositionend', compositionEnd);
  installations.set(root, {
    count: 1,
    /** 关闭当前窗口或评论层后完整移除其监听。 */
    dispose() {
      root.removeEventListener('beforeinput', beforeInput);
      root.removeEventListener('keydown', keyDown);
      root.removeEventListener('compositionstart', compositionStart);
      root.removeEventListener('compositionend', compositionEnd);
    },
  });
  return () => release(root);
}

/** 由 Chromium 原生编辑事务写入，保持撤销、重做和 React 的 input 回调。 */
function applyEdit(textarea: HTMLTextAreaElement, edit: MarkdownListEdit): boolean {
  /** 长度限制不允许把编号截断成半个标记，交回原生输入处理。 */
  const expected = textarea.value.slice(0, edit.from) + edit.insert + textarea.value.slice(edit.to);
  if (textarea.maxLength >= 0 && expected.length > textarea.maxLength) return false;
  /** 保存原选区，命令未执行时恢复，继续由原生默认行为处理。 */
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const direction = textarea.selectionDirection;
  textarea.setSelectionRange(edit.from, edit.to);
  // Electron Chromium 的 insertText 保留原生撤销；直接写 value 或 setRangeText 会丢失这次编辑历史。
  const applied = textarea.ownerDocument.execCommand('insertText', false, edit.insert);
  if (!applied) {
    textarea.setSelectionRange(start, end, direction);
    return false;
  }
  textarea.setSelectionRange(edit.anchor, edit.head);
  return true;
}

/** 按安装者数量释放，避免一个门户关闭影响另一个门户。 */
function release(root: Document | ShadowRoot): void {
  const entry = installations.get(root);
  if (!entry || --entry.count > 0) return;
  entry.dispose();
  installations.delete(root);
}
