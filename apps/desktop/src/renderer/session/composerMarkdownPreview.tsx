import { redo, undo } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range, StateField, Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { createContext, useContext, useState, type ComponentProps } from 'react';
import { setCustomComponents, type RenderNodeFn, type TableNode, type CustomComponentMap } from 'markstream-react';
import { createRoot, type Root } from 'react-dom/client';
import { ConversationMarkdown, conversationMarkdownComponents } from './ConversationMarkdown.js';
import type { StructuredToken } from './StructuredComposerInput.js';

/** Markdown 的语义样式直接标注原文范围，不创建另一份可编辑正文。 */
const inlineClasses: Record<string, string> = {
  StrongEmphasis: 'composer-md-strong',
  Emphasis: 'composer-md-emphasis',
  Strikethrough: 'composer-md-strike',
  InlineCode: 'composer-md-code',
  Link: 'composer-md-link',
};

/** 单元格使用原文范围回写；缺失的尾列在首次编辑时补上分隔符。 */
interface ComposerTableCell {
  from: number;
  to: number;
  prefix: string;
}

/** 从语法树的分隔符提取空单元格，避免按非空节点序号写错列。 */
function tableRows(state: EditorState, table: SyntaxNode): ComposerTableCell[][] {
  /** 按表头列数补齐短行，保持显示列和原文位置一致。 */
  const rows: ComposerTableCell[][] = [];
  for (let row = table.firstChild; row; row = row.nextSibling) {
    if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
    /** 语法树已排除转义竖线，边界只包含实际分列符。 */
    const boundaries = row.getChildren('TableDelimiter').map((delimiter) => delimiter.from);
    if (boundaries[0] !== row.from) boundaries.unshift(row.from - 1);
    if (boundaries.at(-1) !== row.to - 1) boundaries.push(row.to);
    /** 保留空格外的可编辑内容，空列仍有合法插入点。 */
    const cells = boundaries.slice(1).map((end, index) => {
      const start = boundaries[index]! + 1;
      const text = state.sliceDoc(start, end);
      const from = start + text.length - text.trimStart().length;
      return { from, to: Math.max(from, end - (text.length - text.trimEnd().length)), prefix: '' };
    });
    /** Markdown 允许数据行省略尾列；新增值时只补缺失的列。 */
    const columns = rows[0]?.length ?? cells.length;
    const missingFrom = cells.length;
    while (cells.length < columns) {
      cells.push({ from: row.to, to: row.to, prefix: `${state.sliceDoc(row.to - 1, row.to) === '|' ? ' ' : ' | '}${' | '.repeat(cells.length - missingFrom)}` });
    }
    rows.push(cells.slice(0, columns));
  }
  return rows;
}

/** 单元格中的换行和裸竖线作为内容保存，不允许输入意外改变表格结构。 */
function tableCellMarkdown(value: string): string {
  return value.replace(/\r\n?|\n/gu, ' ').replace(/(?<!\\)((?:\\\\)*)\|/gu, '$1\\|');
}

/** 编辑上下文只服务当前表格，渲染组件继续接收 Markdown 解析后的单元格。 */
const ComposerTableContext = createContext<{ view: EditorView; rows: ComposerTableCell[][]; language: 'zh-CN' | 'en-US' } | null>(null);

/** 表格只替换被编辑单元格的原文；排版、滚动和编辑节点持续存在。 */
function ComposerTableEditor(props: ComponentProps<typeof TableNode>) {
  /** 原文范围来自编辑器，内联显示和对齐来自原有 Markdown 表格解析。 */
  const runtime = useContext(ComposerTableContext)!;
  const renderedRows = [props.node.header, ...(props.node.rows ?? [])];
  /** 行列索引在修改文本长度时保持稳定，输入法和光标不会随偏移变化重建。 */
  const [active, setActive] = useState<{ key: string; draft: string; source: string } | null>(null);
  /** 原文始终取自当前编辑器，草稿、发送和撤销共用同一份内容。 */
  const state = runtime.view.state;
  return (
    <div className="composer-md-table-scroll">
      <table>
        {runtime.rows.map((row, rowIndex) => {
          /** 原生表头和数据行保留辅助阅读语义。 */
          const Group = rowIndex === 0 ? 'thead' : 'tbody';
          const Cell = rowIndex === 0 ? 'th' : 'td';
          return (
            <Group key={rowIndex}>
              <tr>
                {row.map((cell, columnIndex) => {
                  /** 标识只在本表格内使用，不随正文偏移变化。 */
                  const key = `${rowIndex}:${columnIndex}`;
                  const text = state.sliceDoc(cell.from, cell.to);
                  return (
                    <Cell
                      key={columnIndex}
                      tabIndex={state.readOnly || active?.key === key ? -1 : 0}
                      style={{ textAlign: renderedRows[rowIndex]?.cells[columnIndex]?.align }}
                      onFocus={(event) => {
                        if (!state.readOnly && event.target === event.currentTarget) setActive({ key, draft: text, source: text });
                      }}
                      onClick={(event) => {
                        if (!state.readOnly && !(event.target instanceof HTMLInputElement)) setActive({ key, draft: text, source: text });
                      }}
                    >
                      <div className="composer-md-cell">
                        <div style={{ visibility: active?.key === key && !state.readOnly ? 'hidden' : undefined }}>
                          {renderedRows[rowIndex]?.cells[columnIndex]?.children.map((child: Parameters<RenderNodeFn>[0], index: number) => props.renderNode?.(child, index, props.ctx!))}
                        </div>
                        {active?.key === key && !state.readOnly ? (
                          <input
                            className="composer-md-cell-input"
                            autoFocus
                            aria-label={runtime.language === 'zh-CN' ? `表格第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列` : `Table row ${rowIndex + 1}, column ${columnIndex + 1}`}
                            value={text === active.source ? active.draft : text}
                            onChange={(event) => {
                              // 输入即写入正文，不依赖失焦提交，防止发送或切换会话丢失最后一次修改。
                              if (runtime.view.state.readOnly) return;
                              const draft = event.currentTarget.value;
                              const source = tableCellMarkdown(draft).trim();
                              // 保留尚未输入下一字的空格和组合文本，原文只替换实际内容范围。
                              setActive({ key, draft, source });
                              runtime.view.dispatch({ changes: { from: cell.from, to: cell.to, insert: cell.prefix + source }, annotations: Transaction.userEvent.of('input') });
                            }}
                            onKeyDown={(event) => {
                              // 单元格内的回车完成编辑，中文候选确认不退出、不触发发送。
                              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
                                event.preventDefault();
                                (event.shiftKey ? redo : undo)(runtime.view);
                              } else if (event.key === 'Enter' || event.key === 'Escape') {
                                event.preventDefault();
                                setActive(null);
                                runtime.view.contentDOM.focus();
                              }
                            }}
                            onBlur={() => setActive(null)}
                          />
                        ) : null}
                      </div>
                    </Cell>
                  );
                })}
              </tr>
            </Group>
          );
        })}
      </table>
    </div>
  );
}

/** 输入框仅替换表格，其余安全节点与会话正文完全一致。 */
const composerMarkdownId = 'zeus-composer-markdown';
setCustomComponents(composerMarkdownId, { ...conversationMarkdownComponents, table: ComposerTableEditor } as CustomComponentMap);

/** 根节点跟随 DOM 而非短生命周期的装饰对象，输入时保留 React 状态与横向滚动。 */
const tableRoots = new WeakMap<HTMLElement, Root>();

/** 表格在同一编辑器内直接编辑，单元格正文继续复用安全的 Markdown 渲染器。 */
class ComposerTableWidget extends WidgetType {
  /** 保存原文与单元格偏移，所有显示值仍来自原文。 */
  constructor(
    private text: string,
    private from: number,
    private rows: ComposerTableCell[][],
    private language: 'zh-CN' | 'en-US',
    private readOnly: boolean,
  ) {
    super();
  }
  /** 同一表格与位置不变时复用 DOM，保留横向滚动位置。 */
  eq(other: ComposerTableWidget): boolean {
    return this.text === other.text && this.from === other.from && this.language === other.language && this.readOnly === other.readOnly;
  }
  /** 挂载可编辑表格，单元格格式继续由会话 Markdown 解释。 */
  toDOM(view: EditorView): HTMLElement {
    /** 宽表在自身容器内滚动，不撑开输入框。 */
    const element = document.createElement('div');
    element.className = 'composer-md-table';
    tableRoots.set(element, createRoot(element));
    this.updateDOM(element, view);
    requestAnimationFrame(() => {
      if (element.isConnected) view.requestMeasure();
    });
    return element;
  }
  /** 只更新单元格数据，不销毁当前输入节点、选区或浏览器组合输入。 */
  updateDOM(element: HTMLElement, view: EditorView): boolean {
    tableRoots.get(element)?.render(
      <ComposerTableContext.Provider value={{ view, rows: this.rows, language: this.language }}>
        <ConversationMarkdown text={this.text} streamId="composer-table" phase="final" language={this.language} renderImmediately customComponentsId={composerMarkdownId} onVisibleContentChange={() => view.requestMeasure()} />
      </ComposerTableContext.Provider>,
    );
    return true;
  }
  /** 表格内部的原生输入与滚动不交给外层正文编辑器重复处理。 */
  ignoreEvent(): boolean {
    return true;
  }
  /** 避免在父组件提交期间同步卸载独立渲染根。 */
  destroy(element: HTMLElement): void {
    /** 先取出本次根节点，防止后续装饰复用改写引用。 */
    const root = tableRoots.get(element);
    tableRoots.delete(element);
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
        if (name === 'Table') {
          ranges.push(Decoration.replace({ block: true, widget: new ComposerTableWidget(state.sliceDoc(from, to), from, tableRows(state, node), language, state.readOnly) }).range(from, to));
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
