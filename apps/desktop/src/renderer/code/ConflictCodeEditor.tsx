import { memo, useMemo, useRef } from 'react';
import { detectSourceLanguage } from '@zeus/shared';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, lineNumbers, type ViewUpdate } from '@codemirror/view';
import type { ConflictBlock, ConflictSide, ConflictSideState } from '../task/taskConflictModel.js';
import { CodeEditor, type CodeTextChange } from './CodeEditor.js';

/** 聚焦冲突和完整文件共用一套编辑器，操作仍修改原有冲突模型。 */
interface ConflictCodeEditorProps {
  /** 文件路径决定语言和编辑器身份。 */
  path: string;
  /** 标明来源、任务或结果栏。 */
  label: string;
  /** 完整文件或当前冲突片段。 */
  content: string;
  /** 来源栏与任务栏只能选择复制，结果栏按当前状态编辑。 */
  readOnly: boolean;
  /** 聚焦模式保留原始行号。 */
  lineOffset?: number;
  /** 全文模式进入当前冲突附近，语言加载不影响首次定位。 */
  revealLine?: number;
  /** 聚焦片段中需要标记的零基行范围。 */
  range?: { from: number; to: number };
  /** 完整文件按冲突偏移构建稀疏操作标记。 */
  blocks?: ConflictBlock[];
  /** 操作按钮使用当前界面语言。 */
  zh: boolean;
  /** 中间结果继续交给现有冲突编辑模型。 */
  onChange?: (content: string, change: CodeTextChange) => void;
  /** 四种选入与忽略操作保持原有语义。 */
  onSideAction?: (block: ConflictBlock, side: ConflictSide, action: Exclude<ConflictSideState, 'pending'>) => void;
  /** 登记实例，卸载时释放父级引用。 */
  onView: (view: EditorView | null) => void;
  /** 多栏同步滚动直接更新编辑器，不触发 React 重绘。 */
  onScroll: (view: EditorView) => void;
}

/** 完整冲突不再叠加 textarea 和三份全文行节点。 */
export const ConflictCodeEditor = memo(function ConflictCodeEditor(props: ConflictCodeEditorProps) {
  /** 按钮与滚动事件读取最新业务回调。 */
  const current = useRef(props);
  current.current = props;
  /** 文本修改由编辑器保留，扩展仅随冲突位置或阅读状态更新。 */
  const extensions = useMemo(
    () => [
      // 冲突模型以原文字符定位；保留 CR 字符，避免 CRLF 被折叠后编辑偏移失准。
      EditorState.lineSeparator.of('\n'),
      lineNumbers({ formatNumber: (number: number) => String(number + (props.lineOffset ?? 0)) }),
      ViewPlugin.define(
        (view) => ({
          decorations: conflictDecorations(view, props.blocks, props.range),
          update(update: ViewUpdate) {
            if (update.viewportChanged || update.docChanged) this.decorations = conflictDecorations(update.view, current.current.blocks, current.current.range);
          },
        }),
        { decorations: (plugin) => plugin.decorations },
      ),
      props.blocks
        ? gutter({
            class: 'conflict-code-actions',
            lineMarker: (view, line) => {
              /** 二分查找当前可见行的冲突，不在每次滚动扫描整份文件。 */
              const blocks = current.current.blocks ?? [];
              const index = precedingBlock(blocks, line.to);
              const block = blocks[index];
              return block && block.visibleStart >= line.from && block.visibleStart <= line.to ? new ConflictMarker(block, current, props.readOnly) : null;
            },
          })
        : [],
      EditorView.domEventHandlers({ scroll: (_event, view) => current.current.onScroll(view) }),
      EditorView.theme({
        '.cm-line.is-conflict': { backgroundColor: 'color-mix(in srgb, #d74733 16%, transparent)' },
        '.conflict-code-actions .cm-gutterElement': { display: 'flex', alignItems: 'center' },
        '.conflict-code-actions button': { width: '20px', height: '20px', padding: '0', border: '0', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      }),
    ],
    [props.blocks, props.range, props.lineOffset, props.readOnly],
  );
  return (
    <CodeEditor
      path={props.path}
      label={props.label}
      content={props.content}
      language={detectSourceLanguage(props.path) ?? null}
      readOnly={props.readOnly}
      revealLine={props.revealLine}
      extensions={extensions}
      onChange={props.onChange}
      onView={props.onView}
    />
  );
});

/** 可见冲突开始行才创建操作按钮。 */
class ConflictMarker extends GutterMarker {
  /** 按钮绑定权威冲突块，回调保持最新。 */
  constructor(
    private readonly block: ConflictBlock,
    private readonly current: { current: ConflictCodeEditorProps },
    private readonly disabled: boolean,
  ) {
    super();
  }
  /** 未变化的冲突按钮保留原生焦点。 */
  eq(other: ConflictMarker): boolean {
    return this.block === other.block && this.disabled === other.disabled;
  }
  /** 使用原生按钮保留键盘和辅助技术操作。 */
  toDOM(): HTMLElement {
    const group = document.createElement('span');
    group.dataset.conflictBlock = this.block.id;
    for (const [side, action, symbol] of [
      ['source', 'accepted', '→'],
      ['source', 'ignored', '×'],
      ['task', 'ignored', '×'],
      ['task', 'accepted', '←'],
    ] as const) {
      const button = document.createElement('button');
      const zh = this.current.current.zh;
      button.type = 'button';
      button.disabled = this.disabled;
      button.textContent = symbol;
      button.title = zh ? `${action === 'accepted' ? '选入' : '忽略'}${side === 'source' ? '来源分支' : '任务分支'}` : `${action === 'accepted' ? 'Include' : 'Ignore'} ${side === 'source' ? 'source branch' : 'task branch'}`;
      button.setAttribute('aria-label', button.title);
      button.onclick = () => this.current.current.onSideAction?.(this.block, side, action);
      group.append(button);
    }
    return group;
  }
}

/** 查找起点不晚于当前偏移的最后一个冲突块。 */
function precedingBlock(blocks: ConflictBlock[], offset: number): number {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (blocks[middle]!.visibleStart <= offset) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** 只装饰可见行；冲突跨度再长也不生成全文标记。 */
function conflictDecorations(view: EditorView, blocks?: ConflictBlock[], range?: { from: number; to: number }) {
  const decorations = [];
  for (const visible of view.visibleRanges) {
    for (let position = visible.from; position <= visible.to; ) {
      const line = view.state.doc.lineAt(position);
      const block = blocks?.[precedingBlock(blocks, line.to)];
      if ((block && block.visibleEnd >= line.from) || (range && line.number - 1 >= range.from && line.number - 1 < range.to)) decorations.push(Decoration.line({ class: 'is-conflict' }).range(line.from));
      position = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}
