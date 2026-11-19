import { RangeSet, StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state';
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from '@codemirror/view';
import { diffLines } from 'diff';
import './sourceGitGutter.css';

/** 新增和修改覆盖当前行，删除标记位于剩余代码的边界。 */
type GitChangeTone = 'addition' | 'replacement' | 'deletion';

/** 色条的位置决定圆角及删除标记的行间锚点。 */
class SourceGitMarker extends GutterMarker {
  constructor(
    /** 当前变化类型决定标记颜色。 */
    readonly tone: GitChangeTone,
    /** 鼠标和辅助技术共用变更类型与行数。 */
    readonly label: string,
    /** 起止类只作用于连续色带的边缘；末尾删除锚在上一行底部。 */
    readonly edges = '',
  ) {
    super();
  }

  /** 相同内容和位置的标记复用可见 DOM。 */
  eq(other: SourceGitMarker): boolean {
    return this.tone === other.tone && this.label === other.label && this.edges === other.edges;
  }

  /** 小色块借用 CodeMirror 行号栏的实际高度。 */
  toDOM(view: EditorView): HTMLElement {
    /** 标记为展示型元素，不占用键盘焦点。 */
    const element = view.dom.ownerDocument.createElement('span');
    element.className = `cm-source-git-marker ${this.tone}${this.edges}`;
    element.title = this.label;
    return element;
  }
}

/** 每个连续变更保留一个范围，视图按可见行绘制小色块。 */
const setSourceGitChanges = StateEffect.define<RangeSet<SourceGitMarker>>();

/** 新结果到来前按编辑事务移动已有范围，滚动和换行不重算 Git 差异。 */
const sourceGitChanges = StateField.define<RangeSet<SourceGitMarker>>({
  create: () => RangeSet.empty,
  update(ranges, transaction) {
    /** 替换范围与文档一同提交给视图。 */
    const result = transaction.effects.find((effect) => effect.is(setSourceGitChanges));
    return result ? result.value : ranges.map(transaction.changes);
  },
});

/** 可见行和光标提示共用同一份变更位置。 */
function markerAt(ranges: RangeSet<SourceGitMarker> | undefined, position: number): SourceGitMarker | null {
  /** 仅当行首落在变更范围内时返回标记。 */
  let result: SourceGitMarker | null = null;
  ranges?.between(position, position, (from, to, marker) => {
    result = marker.tone === 'deletion' ? marker : new SourceGitMarker(marker.tone, marker.label, `${from === position ? ' start' : ''}${to === position ? ' end' : ''}`);
    return false;
  });
  return result;
}

/** 固定行号栏宽度，异步基线返回时源码列不横移。 */
const gitGutter = gutter({
  class: 'cm-source-git-gutter',
  lineMarker: (view, line) => markerAt(view.state.field(sourceGitChanges, false), line.from),
  lineMarkerChange: (update) => update.startState.field(sourceGitChanges, false) !== update.state.field(sourceGitChanges, false),
});

/** 在项目源码编辑器内比较当前文档和已授权的 HEAD 正文。 */
export function sourceGitGutter(baseline: string | null, zh: boolean): Extension {
  if (baseline === null) return gitGutter;
  return [
    gitGutter,
    sourceGitChanges,
    ViewPlugin.define((view) => {
      /** 合并连续输入，用户停顿后再比较完整文档。 */
      let timer: ReturnType<typeof setTimeout>;
      /** 每次计算读取当前视图文档，基线变化和关闭文件会取消旧计算。 */
      const schedule = (delayMs: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => view.dispatch({ effects: setSourceGitChanges.of(sourceGitRanges(baseline, view.state.doc, zh)) }), delayMs);
      };
      schedule(0);
      return {
        /** 仅编辑、撤销等文档更新触发比较，移动光标时重用已有结果。 */
        update(update: ViewUpdate) {
          if (update.docChanged) schedule(120);
        },
        /** 销毁扩展后旧定时器不能向其他文件绘制标记。 */
        destroy() {
          clearTimeout(timer);
        },
      };
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged || !update.view.hasFocus || (!update.selectionSet && !update.focusChanged)) return;
      /** 光标进入变更行时通知辅助技术，移动同一行的列时保持安静。 */
      const position = update.state.doc.lineAt(update.state.selection.main.head).from;
      if (!update.focusChanged && position === update.startState.doc.lineAt(update.startState.selection.main.head).from) return;
      /** CodeMirror 原生播报区域可读取隐藏行号栏里的变更语义。 */
      const marker = markerAt(update.state.field(sourceGitChanges), position);
      if (marker) update.view.dispatch({ effects: EditorView.announce.of(marker.label) });
    }),
  ];
}

/** 把相邻的增删行合并为变更块，混合增删表示修改。 */
function sourceGitRanges(baseline: string, doc: Text, zh: boolean): RangeSet<SourceGitMarker> {
  /** 比较包含尚未保存的正文。 */
  const content = doc.toString();
  if (baseline === content) return RangeSet.empty;
  /** 限制差异搜索为 40 毫秒；末尾换行先忽略，避免吞掉真正的行间删除。 */
  const parts = diffLines(baseline, content, { timeout: 40, ignoreNewlineAtEof: true });
  if (!parts) return RangeSet.empty;
  /** 标记范围以当前文档的行首偏移表示。 */
  const ranges: Range<SourceGitMarker>[] = [];
  /** 下一块在当前文档中的一基行号。 */
  let line = 1;
  /** 当前块两侧的文本行数。 */
  let added = 0;
  let removed = 0;
  /** 遇到不变行时记下当前块；纯删除附着于下一行的顶边或文档末尾。 */
  const flush = () => {
    if (!added && !removed) return;
    /** 文件末尾没有下一行时使用最后一行的底边。 */
    const atEnd = line > doc.lines;
    /** CodeMirror 的空文档仍有一行，可承载删除标记。 */
    const from = doc.line(Math.min(line, doc.lines)).from;
    if (added) {
      /** 同一块同时移除旧行和增加新行时标记修改。 */
      const tone = removed ? 'replacement' : 'addition';
      /** 连续色块覆盖当前侧的首行到末行。 */
      const to = doc.line(line + added - 1).from;
      ranges.push(new SourceGitMarker(tone, changeLabel(tone, added, zh)).range(from, to));
    } else {
      ranges.push(new SourceGitMarker('deletion', changeLabel('deletion', removed, zh), atEnd ? ' at-end' : '').range(from));
    }
    line += added;
    added = removed = 0;
  };
  for (const part of parts) {
    if (part.added) added += part.count;
    else if (part.removed) removed += part.count;
    else {
      flush();
      line += part.count;
    }
  }
  flush();
  if (!ranges.length) {
    /** 仅文件结尾的换行变化附着到最后一行正文。 */
    const lastLine = content.endsWith('\n') ? doc.lines - 1 : doc.lines;
    ranges.push(new SourceGitMarker('replacement', changeLabel('replacement', 1, zh)).range(doc.line(lastLine).from));
  }
  return RangeSet.of(ranges);
}

/** 用简短、可本地化的内容解释小色块。 */
function changeLabel(tone: GitChangeTone, count: number, zh: boolean): string {
  if (zh) return `${{ addition: '新增', replacement: '修改', deletion: '删除' }[tone]} ${count} 行`;
  return `${{ addition: 'Added', replacement: 'Modified', deletion: 'Deleted' }[tone]} ${count} ${count === 1 ? 'line' : 'lines'}`;
}
