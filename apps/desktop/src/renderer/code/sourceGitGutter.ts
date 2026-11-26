import { isolateHistory } from '@codemirror/commands';
import { Prec, RangeSet, StateEffect, StateField, Text, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, keymap, type DecorationSet } from '@codemirror/view';
import { diffLines } from 'diff';
import { changedWords, type DiffWordRanges } from './fullFileDiff.js';
import './sourceGitGutter.css';

/** 类型决定色块颜色和旧内容的显示方式。 */
type GitChangeTone = 'addition' | 'replacement' | 'deletion';

/** 两端使用一基行号，纯增加和纯删除的空侧保留插入位置。 */
interface SourceGitChange {
  beforeLine: number;
  afterLine: number;
  removed: number;
  added: number;
}

/** 连续色带共用一个索引，中间的每一行指向同一段差异。 */
class SourceGitRange extends GutterMarker {
  constructor(readonly index: number) {
    super();
  }
}

/** 对比按钮传递同一份草稿和真实侧行号，整文件删除块定位到旧侧。 */
export interface SourceGitComparison {
  draft: Text;
  /** 完整 Diff 沿用色块的两侧行号和分组。 */
  changes: readonly SourceGitChange[];
  revealLine: { side: 'left' | 'right'; line: number };
}

/** React 工具栏与 CodeMirror 区块共享同一份选中内容。 */
export interface SourceGitPreview {
  host: HTMLElement;
  focusOnMount: boolean;
  index: number;
  count: number;
  tone: GitChangeTone;
  before: string | null;
  words: DiffWordRanges['left'];
  navigate(direction: -1 | 1): void;
  compare(): void;
  restore(): void;
  close(): void;
}

/** 嵌入源码编辑器的操作沿用所在工作区的焦点、草稿和保存状态。 */
interface SourceGitActions {
  mount(preview: SourceGitPreview): void;
  unmount(host: HTMLElement): void;
  compare(comparison: SourceGitComparison): void;
  canRestore(): boolean;
}

/** 窄色条与原有行号各有点击轨道，按钮按行复用。 */
class SourceGitMarker extends GutterMarker {
  constructor(
    readonly index: number,
    readonly tone: GitChangeTone,
    readonly label: string,
    readonly position: number,
    readonly edges: string,
    readonly first: boolean,
    readonly expanded: boolean,
    private readonly toggle: (view: EditorView, position: number) => void,
    private readonly close: (view: EditorView) => boolean,
  ) {
    super();
  }

  /** 仅在行位置或交互状态改变时重建已有按钮。 */
  eq(other: SourceGitMarker): boolean {
    return (
      this.index === other.index &&
      this.tone === other.tone &&
      this.label === other.label &&
      this.position === other.position &&
      this.edges === other.edges &&
      this.first === other.first &&
      this.expanded === other.expanded &&
      this.toggle === other.toggle
    );
  }

  /** 可见色带上的每一行可点击，每个变更只保留一个 Tab 停靠点。 */
  toDOM(view: EditorView): HTMLElement {
    const button = view.dom.ownerDocument.createElement('button');
    button.type = 'button';
    button.tabIndex = this.first ? 0 : -1;
    button.className = 'cm-source-git-marker ' + this.tone + this.edges;
    button.dataset.sourceGitIndex = String(this.index);
    button.title = this.label;
    button.setAttribute('aria-label', this.label);
    button.setAttribute('aria-expanded', String(this.expanded));
    button.addEventListener('click', () => this.toggle(view, this.position));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.close(view)) return;
      event.preventDefault();
      event.stopPropagation();
    });
    return button;
  }
}

/** 区块使用编辑器自己的滚动和高度模型，工具栏内容挂载到所属文档。 */
class SourceGitWidget extends WidgetType {
  /** 仅第一次展开或导航时主动获得焦点，滚进视口的重新挂载保留当前焦点。 */
  private focusOnMount = true;
  /** 工具栏换行与视口宽度变化后重新测量区块高度。 */
  private resize: ResizeObserver | null = null;

  constructor(
    private readonly mount: (view: EditorView, host: HTMLElement, focusOnMount: boolean) => void,
    private readonly unmount: SourceGitActions['unmount'],
  ) {
    super();
  }

  /** 用可视编辑宽度约束操作栏，横向滚动时代码和操作各自保持可见。 */
  toDOM(view: EditorView): HTMLElement {
    const host = view.dom.ownerDocument.createElement('div');
    host.className = 'source-git-preview-slot';
    const gutters = view.dom.querySelector<HTMLElement>('.cm-gutters');
    const resize = () => {
      const gutterWidth = gutters?.offsetWidth ?? 0;
      host.style.inlineSize = Math.max(0, view.scrollDOM.clientWidth - gutterWidth) + 'px';
      host.style.insetInlineStart = gutterWidth + 'px';
      view.requestMeasure();
    };
    resize();
    this.resize = new ResizeObserver(resize);
    this.resize.observe(view.scrollDOM);
    if (gutters) this.resize.observe(gutters);
    this.resize.observe(host);
    this.mount(view, host, this.focusOnMount);
    this.focusOnMount = false;
    return host;
  }

  /** 收起或换文件时释放门户和尺寸监听。 */
  destroy(dom: HTMLElement): void {
    this.resize?.disconnect();
    this.unmount(dom);
  }
}

/** 范围与旧文字只在对应的不可变文档上可用于操作。 */
interface SourceGitSnapshot {
  doc: Text | null;
  changes: SourceGitChange[];
  markers: RangeSet<SourceGitRange>;
}

/** 一次只展开一个变更，区块和字词装饰与选择同时更新。 */
interface SourceGitState extends SourceGitSnapshot {
  active: number;
  decorations: DecorationSet;
}

/** 完成后台比较后替换当前范围。 */
const setSourceGitChanges = StateEffect.define<SourceGitSnapshot>();
/** -1 表示关闭预览。 */
const showSourceGitChange = StateEffect.define<number>();
/** HEAD 尚未加载时仍保留色块栏宽度。 */
const emptyGitGutter = gutter({ class: 'cm-source-git-gutter' });

/** 在源码编辑器中查看和恢复相对 HEAD 的连续改动。 */
export function sourceGitGutter(baseline: string | null, zh: boolean, actions: SourceGitActions): Extension {
  if (baseline === null) return emptyGitGutter;

  /** 旧行号和恢复内容共用解析一次的 HEAD 文本。 */
  const before = Text.of(baseline.split('\n'));
  /** 基线变更时使用新的字段实例，销毁旧预览及其操作。 */
  const field = StateField.define<SourceGitState>({
    create: () => ({ doc: null, changes: [], markers: RangeSet.empty, active: -1, decorations: Decoration.none }),
    update(current, transaction) {
      if (transaction.docChanged) {
        return { ...current, doc: null, markers: current.markers.map(transaction.changes), active: -1, decorations: Decoration.none };
      }
      const result = transaction.effects.find((effect) => effect.is(setSourceGitChanges));
      const selection = transaction.effects.find((effect) => effect.is(showSourceGitChange));
      if (!result && !selection) return current;
      const snapshot = result?.value ?? current;
      const active = selection?.value ?? -1;
      const change = snapshot.changes[active];
      const decorations = change && snapshot.doc ? previewDecorations(snapshot.doc, change, active, snapshot.changes.length) : Decoration.none;
      return { ...snapshot, active, decorations };
    },
    provide: (source) => EditorView.decorations.from(source, (state) => state.decorations),
  });

  /** 关闭后返回已选色块；该行不可见时返回源码正文。 */
  function close(view: EditorView): boolean {
    const active = view.state.field(field, false)?.active ?? -1;
    if (active < 0) return false;
    view.dispatch({ effects: showSourceGitChange.of(-1) });
    const marker = view.dom.querySelector<HTMLButtonElement>('.cm-source-git-marker[data-source-git-index="' + active + '"]:not([tabindex="-1"])');
    if (marker) marker.focus({ preventScroll: true });
    else view.focus();
    return true;
  }

  /** 导航时把对应的预览放进视口，不替换源码选择和撤销记录。 */
  function open(view: EditorView, snapshot: SourceGitSnapshot, index: number, refresh = false) {
    const change = snapshot.changes[index];
    const effects: StateEffect<unknown>[] = refresh ? [setSourceGitChanges.of(snapshot)] : [];
    if (change && snapshot.doc) effects.push(showSourceGitChange.of(index), EditorView.scrollIntoView(previewAnchor(snapshot.doc, change).position, { y: 'nearest' }));
    if (effects.length) view.dispatch({ effects });
  }

  /** 输入后的合并计算尚未完成时，点击先按最新草稿重新定位。 */
  function toggle(view: EditorView, position: number): void {
    const current = view.state.field(field, false);
    if (!current) return;
    const refresh = current.doc !== view.state.doc;
    const snapshot = refresh ? sourceGitSnapshot(baseline!, view.state.doc) : current;
    const index = rangeAt(snapshot.markers, position)?.index ?? -1;
    if (index >= 0 && index === current.active) close(view);
    else open(view, snapshot, index, refresh);
  }

  /** 控件、撤销内容和显示装饰使用选中块在这一份文档中的精确范围。 */
  function previewDecorations(doc: Text, change: SourceGitChange, index: number, count: number): DecorationSet {
    const tone = changeTone(change);
    const oldText = change.removed ? blockText(before, change.beforeLine, change.removed) : null;
    const anchor = previewAnchor(doc, change);
    const newStart = change.added ? doc.line(change.afterLine).from : anchor.position;
    const words = tone === 'replacement' ? changedWords(oldText!, blockText(doc, change.afterLine, change.added)) : null;
    const widget = new SourceGitWidget((view, host, focusOnMount) => {
      /** 异步操作或编辑后不再允许访问旧区块。 */
      const isCurrent = () => view.state.doc === doc && view.state.field(field, false)?.active === index;
      actions.mount({
        host,
        focusOnMount,
        index,
        count,
        tone,
        before: oldText,
        words: words?.left ?? [],
        navigate(direction) {
          if (isCurrent()) open(view, view.state.field(field), index + direction);
        },
        compare() {
          if (isCurrent()) actions.compare({ draft: doc, changes: view.state.field(field).changes, revealLine: change.added ? { side: 'right', line: change.afterLine } : { side: 'left', line: change.beforeLine } });
        },
        restore() {
          if (!isCurrent() || view.state.readOnly || !actions.canRestore()) return;
          const changes = restoreChange(before, doc, change, oldText ?? '');
          view.dispatch({ changes, selection: { anchor: changes.from }, annotations: isolateHistory.of('full'), scrollIntoView: true, userEvent: 'revert' });
          view.focus();
        },
        close: () => {
          if (isCurrent()) close(view);
        },
      });
    }, actions.unmount);
    return Decoration.set(
      [Decoration.widget({ widget, block: true, side: anchor.side }).range(anchor.position), ...(words?.right.map(([from, to]) => Decoration.mark({ class: 'source-git-current-word' }).range(newStart + from, newStart + to)) ?? [])],
      true,
    );
  }

  return [
    field,
    gutter({
      class: 'cm-source-git-gutter',
      lineMarker(view, line) {
        const current = view.state.field(field);
        const match = rangeAt(current.markers, line.from);
        const change = match && current.changes[match.index];
        if (!match || !change) return null;
        const tone = changeTone(change);
        const edges = tone === 'deletion' ? (change.afterLine > (current.doc ?? view.state.doc).lines ? ' at-end' : '') : (match.from === line.from ? ' start' : '') + (match.to === line.from ? ' end' : '');
        return new SourceGitMarker(match.index, tone, changeLabel(tone, change.added || change.removed, zh), line.from, edges, match.from === line.from, current.active === match.index, toggle, close);
      },
      lineMarkerChange: (update) => update.startState.field(field, false) !== update.state.field(field, false),
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged || !update.view.hasFocus || (!update.selectionSet && !update.focusChanged)) return;
      /** 读屏进入变更行仍播报类型与行数。 */
      const position = update.state.doc.lineAt(update.state.selection.main.head).from;
      if (!update.focusChanged && position === update.startState.doc.lineAt(update.startState.selection.main.head).from) return;
      const snapshot = update.state.field(field);
      const match = rangeAt(snapshot.markers, position);
      if (!match) return;
      const change = snapshot.changes[match.index]!;
      update.view.dispatch({ effects: EditorView.announce.of(changeLabel(changeTone(change), change.added || change.removed, zh)) });
    }),
    EditorView.decorations.of((view) => {
      const current = view.state.field(field);
      const change = current.changes[current.active];
      if (!change?.added) return Decoration.none;
      const tone = changeTone(change);
      const starts: Range<Decoration>[] = [];
      /** 只染色可见行，打开长变更时不为整段生成逐行装饰。 */
      for (const visible of view.visibleRanges) {
        const first = Math.max(change.afterLine, view.state.doc.lineAt(visible.from).number);
        const last = Math.min(change.afterLine + change.added - 1, view.state.doc.lineAt(visible.to).number);
        for (let line = first; line <= last; line++) starts.push(Decoration.line({ class: 'source-git-current ' + tone }).range(view.state.doc.line(line).from));
      }
      return Decoration.set(starts, true);
    }),
    ViewPlugin.define((view) => {
      /** 输入停顿 120 ms 再比较，滚动和光标移动不重算。 */
      let timer: ReturnType<typeof setTimeout>;
      const schedule = (delayMs: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (view.state.field(field).doc !== view.state.doc) view.dispatch({ effects: setSourceGitChanges.of(sourceGitSnapshot(baseline!, view.state.doc)) });
        }, delayMs);
      };
      /** 与共享 Diff 一样，解除对包含真实按钮的色块栏的装饰性隐藏。 */
      view.dom.querySelector('.cm-gutters')?.removeAttribute('aria-hidden');
      schedule(0);
      return {
        update(update) {
          if (update.docChanged) schedule(120);
        },
        destroy() {
          clearTimeout(timer);
        },
      };
    }),
    Prec.high(keymap.of([{ key: 'Escape', run: close }])),
  ];
}

/** 读取行首命中的连续范围与变更序号。 */
function rangeAt(ranges: RangeSet<SourceGitRange>, position: number): { index: number; from: number; to: number } | null {
  let match = null;
  ranges.between(position, position, (from, to, range) => {
    match = { index: range.index, from, to };
    return false;
  });
  return match;
}

/** 用同一份逐行结果计算两侧行号和当前侧色块，区分末尾换行与正文增删。 */
function sourceGitSnapshot(baseline: string, doc: Text): SourceGitSnapshot {
  const content = doc.toString();
  const parts = baseline === content ? null : diffLines(baseline, content, { timeout: 40, ignoreNewlineAtEof: true });
  const changes: SourceGitChange[] = [];
  const markers: Range<SourceGitRange>[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let added = 0;
  let removed = 0;
  /** 合并相邻的增加和删除，后续不变行同时推进两侧行号。 */
  const flush = () => {
    if (!added && !removed) return;
    const first = doc.line(Math.min(afterLine, doc.lines)).from;
    const last = added ? doc.line(afterLine + added - 1).from : first;
    markers.push(new SourceGitRange(changes.length).range(first, last));
    changes.push({ beforeLine, afterLine, added, removed });
    beforeLine += removed;
    afterLine += added;
    added = removed = 0;
  };
  if (parts) {
    for (const part of parts) {
      if (part.added) added += part.count;
      else if (part.removed) removed += part.count;
      else {
        flush();
        beforeLine += part.count;
        afterLine += part.count;
      }
    }
    flush();
    if (!changes.length) {
      /** 仅末尾换行变化时，在最后一行正文上保留修改标记。 */
      beforeLine--;
      afterLine--;
      added = removed = 1;
      flush();
    }
  }
  return { doc, changes, markers: RangeSet.of(markers, true) };
}

/** 当前侧有内容时在末行后展开，纯删除在删除位置展开。 */
function previewAnchor(doc: Text, change: SourceGitChange): { position: number; side: -1 | 1 } {
  if (change.added) return { position: doc.line(change.afterLine + change.added - 1).to, side: 1 };
  if (change.afterLine > doc.lines) return { position: doc.length, side: 1 };
  return { position: doc.line(change.afterLine).from, side: -1 };
}

/** 读取变更的源码行，保留内部换行和空行。 */
function blockText(doc: Text, first: number, count: number): string {
  return doc.sliceString(doc.line(first).from, doc.line(first + count - 1).to);
}

/** 文件尾恢复重建前一个分隔符和 HEAD 的结束换行，避免拼接到上一行。 */
function restoreChange(before: Text, doc: Text, change: SourceGitChange, oldText: string): { from: number; to: number; insert: string } {
  const last = doc.line(doc.lines);
  const hasTrailingBreak = doc.lines > 1 && last.from === doc.length;
  const end = change.afterLine + change.added;
  if (end <= doc.lines - Number(hasTrailingBreak) && doc.length) {
    return { from: doc.line(change.afterLine).from, to: doc.line(end).from, insert: change.removed ? oldText + '\n' : '' };
  }
  const from = change.afterLine > 1 ? doc.line(change.afterLine - 1).to : 0;
  const prefix = change.afterLine > 1 ? '\n' : '';
  const suffix = before.lines > 1 && before.line(before.lines).from === before.length ? '\n' : '';
  return { from, to: doc.length, insert: change.removed ? prefix + oldText + suffix : suffix };
}

/** 只有两侧都有内容时使用修改色。 */
function changeTone(change: SourceGitChange): GitChangeTone {
  return change.added ? (change.removed ? 'replacement' : 'addition') : 'deletion';
}

/** 色块名称同时表达类型和行数，鼠标和读屏使用同一措辞。 */
function changeLabel(tone: GitChangeTone, count: number, zh: boolean): string {
  if (zh) return '查看差异 · ' + { addition: '新增', replacement: '修改', deletion: '删除' }[tone] + ' ' + count + ' 行';
  return 'View change · ' + { addition: 'Added', replacement: 'Modified', deletion: 'Deleted' }[tone] + ' ' + count + ' ' + (count === 1 ? 'line' : 'lines');
}
