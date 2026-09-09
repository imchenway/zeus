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
  /** 侧栏显示朝向结果的行旁操作；结果栏只保留冲突高亮。 */
  side?: ConflictSide;
  /** 只读参照仍可选入，操作禁用单独跟随页面忙碌状态。 */
  actionsDisabled?: boolean;
  /** 聚焦片段在原始文件中的起点，用于换算冲突行。 */
  contentOffset?: number;
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
  /** 各栏按自己的文本偏移定位，同一套标记同时覆盖完整文件与聚焦片段。 */
  const regions = useMemo(
    () =>
      (props.blocks ?? [])
        .map((block) => ({
          block,
          from: (props.side === 'source' ? block.sourceStart : props.side === 'task' ? block.taskStart : block.visibleStart) - (props.contentOffset ?? 0),
          to: (props.side === 'source' ? block.sourceEnd : props.side === 'task' ? block.taskEnd : block.visibleEnd) - (props.contentOffset ?? 0),
        }))
        .filter((region) => region.from >= 0)
        .sort((left, right) => left.from - right.from),
    [props.blocks, props.side, props.contentOffset],
  );
  /** 文本修改由编辑器保留，扩展仅随冲突位置或阅读状态更新。 */
  const extensions = useMemo(
    () => [
      // 冲突模型以原文字符定位；保留 CR 字符，避免 CRLF 被折叠后编辑偏移失准。
      EditorState.lineSeparator.of('\n'),
      lineNumbers({ formatNumber: (number: number) => String(number + (props.lineOffset ?? 0)) }),
      ViewPlugin.define(
        (view) => ({
          decorations: conflictDecorations(view, regions, props.range),
          update(update: ViewUpdate) {
            if (update.viewportChanged || update.docChanged) this.decorations = conflictDecorations(update.view, regions, props.range);
          },
        }),
        { decorations: (plugin) => plugin.decorations },
      ),
      props.side && props.blocks
        ? gutter({
            class: 'conflict-code-actions',
            side: props.side === 'source' ? 'after' : 'before',
            lineMarker: (view, line) => {
              /** 二分查找当前可见行的冲突，不在每次滚动扫描整份文件。 */
              const region = regions[precedingBlock(regions, line.to)];
              return region && region.from >= line.from && region.from <= line.to ? new ConflictMarker(region.block, props.side!, current, Boolean(props.actionsDisabled), props.zh) : null;
            },
          })
        : [],
      EditorView.domEventHandlers({ scroll: (_event, view) => current.current.onScroll(view) }),
      EditorView.theme({
        '.cm-line.is-conflict': { backgroundColor: 'color-mix(in srgb, #d74733 16%, transparent)' },
        '.cm-line.is-conflict-resolved': { backgroundColor: 'color-mix(in srgb, #267a4c 12%, transparent)' },
        '.conflict-code-actions': { minWidth: '48px' },
        '.conflict-code-actions .cm-gutterElement': { display: 'flex', alignItems: 'center' },
        '.conflict-code-actions [data-conflict-block]': { display: 'inline-flex' },
        '.conflict-code-actions button': { width: '24px', height: '24px', padding: '0', border: '0', borderRadius: '3px', background: 'transparent', fontSize: '18px', lineHeight: '20px', cursor: 'pointer' },
        '.conflict-code-actions .is-accepted': { color: 'var(--zeus-success-text, #267a4c)' },
        '.conflict-code-actions .is-ignored': { color: 'var(--zeus-danger-text, #c43c32)' },
        '.conflict-code-actions button[aria-pressed=true], .conflict-code-actions button:hover:not(:disabled)': { background: 'var(--zeus-control-bg)' },
        '.conflict-code-actions button:focus-visible': { outline: '2px solid var(--zeus-control-accent)', outlineOffset: '-2px' },
        '.conflict-code-actions button:disabled': { opacity: '0.45', cursor: 'not-allowed' },
      }),
    ],
    [regions, props.blocks, props.range, props.lineOffset, props.side, props.actionsDisabled, props.zh],
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
      onView={(view) => {
        // CodeMirror 默认将行号栏从辅助技术隐藏；只公开操作栏，普通行号仍保持隐藏。
        for (const container of view?.dom.querySelectorAll('.cm-gutters') ?? []) {
          if (!container.querySelector('.conflict-code-actions')) continue;
          container.removeAttribute('aria-hidden');
          for (const column of container.children) column.setAttribute('aria-hidden', String(!column.classList.contains('conflict-code-actions')));
        }
        props.onView(view);
      }}
    />
  );
});

/** 可见冲突开始行才创建操作按钮。 */
class ConflictMarker extends GutterMarker {
  /** 按钮绑定权威冲突块，回调保持最新。 */
  constructor(
    private readonly block: ConflictBlock,
    private readonly side: ConflictSide,
    private readonly current: { current: ConflictCodeEditorProps },
    private readonly disabled: boolean,
    private readonly zh: boolean,
  ) {
    super();
  }
  /** 未变化的冲突按钮保留原生焦点。 */
  eq(other: ConflictMarker): boolean {
    return this.block === other.block && this.side === other.side && this.disabled === other.disabled && this.zh === other.zh;
  }
  /** 使用原生按钮保留键盘和辅助技术操作。 */
  toDOM(): HTMLElement {
    /** 每个侧栏只操作自身，移除表示不采用该侧修改。 */
    const group = document.createElement('span');
    group.dataset.conflictBlock = this.block.id;
    for (const action of ['accepted', 'ignored'] as const) {
      /** 原生按钮支持 Tab、回车以及已选状态朗读。 */
      const button = document.createElement('button');
      /** 选入与移除都显示当前侧的处理状态。 */
      const state = this.side === 'source' ? this.block.sourceState : this.block.taskState;
      button.type = 'button';
      button.disabled = this.disabled;
      button.className = `is-${action}`;
      button.textContent = action === 'ignored' ? '×' : this.side === 'source' ? '→' : '←';
      button.title = this.zh
        ? `${action === 'accepted' ? '选入' : '移除'}${this.side === 'source' ? '来源分支' : '任务分支'}的此处修改${action === 'ignored' ? '（不采用该侧修改）' : ''}`
        : `${action === 'accepted' ? 'Include' : 'Exclude'} this ${this.side === 'source' ? 'source branch' : 'task branch'} change`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(state === action));
      button.onclick = () => this.current.current.onSideAction?.(this.block, this.side, action);
      group.append(button);
    }
    return group;
  }
}

/** 查找起点不晚于当前偏移的最后一个冲突块。 */
function precedingBlock(blocks: Array<{ from: number }>, offset: number): number {
  /** 当前候选区间，右端不包含在内。 */
  let low = 0;
  /** 二分上界随候选收缩。 */
  let high = blocks.length;
  while (low < high) {
    /** 检查中点起始偏移。 */
    const middle = (low + high) >>> 1;
    if (blocks[middle]!.from <= offset) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** 只装饰可见行；冲突跨度再长也不生成全文标记。 */
function conflictDecorations(view: EditorView, regions: Array<{ block: ConflictBlock; from: number; to: number }>, range?: { from: number; to: number }) {
  /** 装饰仅覆盖当前可见行。 */
  const decorations = [];
  for (const visible of view.visibleRanges) {
    for (let position = visible.from; position <= visible.to; ) {
      /** 使用编辑器行索引定位，避免扫描全文。 */
      const line = view.state.doc.lineAt(position);
      /** 各栏使用各自的冲突位置，已处理块改用完成色。 */
      const region = regions[precedingBlock(regions, line.to)];
      if ((region && (region.to > line.from || region.from === line.from)) || (range && line.number - 1 >= range.from && line.number - 1 < range.to))
        decorations.push(Decoration.line({ class: region && region.block.status !== 'pending' ? 'is-conflict-resolved' : 'is-conflict' }).range(line.from));
      position = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}
