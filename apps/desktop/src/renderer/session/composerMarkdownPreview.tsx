import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { createRoot, type Root } from 'react-dom/client';
import { ConversationMarkdown } from './ConversationMarkdown.js';
import type { StructuredToken } from './StructuredComposerInput.js';

/** Markdown 的语义样式直接标注原文范围，不创建另一份可编辑正文。 */
const inlineClasses: Record<string, string> = {
  StrongEmphasis: 'composer-md-strong',
  Emphasis: 'composer-md-emphasis',
  Strikethrough: 'composer-md-strike',
  InlineCode: 'composer-md-code',
  Link: 'composer-md-link',
};

/** 复杂表格复用会话渲染器；点击单元格即定位原文，无需切换整个输入框。 */
class ComposerTableWidget extends WidgetType {
  /** 表格渲染根节点随编辑器装饰销毁，避免遗留 React 树。 */
  private root: Root | null = null;
  /** 保存原文与单元格偏移，所有显示值仍来自原文。 */
  constructor(
    private text: string,
    private from: number,
    private cells: number[],
    private language: 'zh-CN' | 'en-US',
  ) {
    super();
  }
  /** 同一表格与位置不变时复用 DOM，保留横向滚动位置。 */
  eq(other: ComposerTableWidget): boolean {
    return this.text === other.text && this.from === other.from && this.language === other.language;
  }
  /** 挂载现有 Markdown 表格，编辑器只负责将点击位置还原为原文坐标。 */
  toDOM(view: EditorView): HTMLElement {
    /** 宽表在自身容器内滚动，不撑开输入框。 */
    const element = document.createElement('div');
    element.className = 'composer-md-table';
    this.root = createRoot(element);
    this.root.render(<ConversationMarkdown text={this.text} streamId={`composer-table:${this.from}`} phase="final" language={this.language} />);
    element.addEventListener('click', (event) => {
      if (view.state.readOnly || !(event.target instanceof Element)) return;
      /** 表格工具按钮保留原行为；单元格点击进入对应的原文位置。 */
      const cell = event.target.closest('th, td');
      if (!cell || event.target.closest('button, a, input')) return;
      event.preventDefault();
      /** 渲染顺序与解析树单元格顺序一致。 */
      const index = Array.from(element.querySelectorAll('th, td')).indexOf(cell);
      view.dispatch({ selection: { anchor: this.cells[index] ?? this.from }, scrollIntoView: true });
      view.focus();
    });
    requestAnimationFrame(() => {
      if (element.isConnected) view.requestMeasure();
    });
    return element;
  }
  /** 表格内部滚动、复制等交互由已有渲染器处理。 */
  ignoreEvent(): boolean {
    return true;
  }
  /** 避免在父组件提交期间同步卸载独立渲染根。 */
  destroy(): void {
    /** 先取出本次根节点，防止后续装饰复用改写引用。 */
    const root = this.root;
    queueMicrotask(() => root?.unmount());
  }
}

/** 原文、选区或结构化引用变化时更新排版；始终由同一个 Markdown 语法树解释格式。 */
export function composerMarkdownPreview(tokens: () => StructuredToken[], language: 'zh-CN' | 'en-US') {
  /** ponytail: 按输入全文计算装饰；超长恢复草稿出现卡顿时再按可见范围更新。 */
  function decorations(state: EditorState): DecorationSet {
    /** 一次有序合并所有行样式、内联格式和引用标签。 */
    const ranges: Range<Decoration>[] = [];
    /** 选中格式片段时显示其标记，用户可直接修改 Markdown 语法。 */
    const editing = (from: number, to: number) => state.selection.ranges.some((range) => range.from < to && range.to > from);
    syntaxTree(state).iterate({
      enter: ({ name, from, to, node }) => {
        if (name === 'Table' && !editing(from, to)) {
          /** 保留单元格的原文起点，点击后精确定位。 */
          const cells: number[] = [];
          node.toTree().iterate({
            enter: (cell) => {
              if (cell.name === 'TableCell') cells.push(from + cell.from);
            },
          });
          ranges.push(Decoration.replace({ block: true, widget: new ComposerTableWidget(state.sliceDoc(from, to), from, cells, language) }).range(from, to));
          return false;
        }
        /** 按语法节点添加字号和字形，未闭合的 Markdown 保留可输入原文。 */
        const className = inlineClasses[name];
        if (className) ranges.push(Decoration.mark({ class: className }).range(from, to));
        if (/^(ATX|Setext)Heading[1-6]$/u.test(name)) ranges.push(Decoration.line({ class: `composer-md-heading composer-md-h${name.at(-1)}` }).range(state.doc.lineAt(from).from));
        if (name === 'FencedCode' || name === 'CodeBlock' || name === 'Blockquote') {
          for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number += 1) {
            ranges.push(Decoration.line({ class: name === 'Blockquote' ? 'composer-md-quote' : 'composer-md-code-block' }).range(state.doc.line(number).from));
          }
        }
        /** 仅隐藏非编辑片段的语法符号；代码内容中的符号不会被当作格式解析。 */
        const parent = node.parent;
        if (parent && !editing(parent.from, parent.to)) {
          if (['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'QuoteMark', 'LinkMark'].includes(name) || (name === 'URL' && parent.name === 'Link')) {
            ranges.push(Decoration.replace({}).range(from, to));
          } else if (name === 'Escape') {
            ranges.push(Decoration.replace({}).range(from, from + 1));
          }
        }
      },
    });
    for (const token of tokens()) {
      if (token.end <= state.doc.length && state.sliceDoc(token.start, token.end) === token.label) {
        ranges.push(Decoration.mark({ class: 'structured-composer-token', attributes: { 'data-kind': token.kind } }).range(token.start, token.end));
      }
    }
    return Decoration.set(ranges, true);
  }
  return StateField.define<DecorationSet>({
    create: decorations,
    update: (_current, transaction) => decorations(transaction.state),
    provide: (field) => EditorView.decorations.from(field),
  });
}
