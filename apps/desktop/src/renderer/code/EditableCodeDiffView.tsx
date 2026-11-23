import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Compartment, EditorState, StateEffect, StateField, RangeSet, Text, type Extension } from '@codemirror/state';
import { historyField } from '@codemirror/commands';
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, gutterLineClass, type DecorationSet } from '@codemirror/view';
import { getChunks, MergeView, mergeViewSiblings, unifiedMergeView, uncollapseUnchanged, Chunk } from '@codemirror/merge';
import { detectSourceLanguage } from '@zeus/shared';
import { CodeEditor, codeEditorTheme } from './CodeEditor.js';
import { fileFindShortcut, requestGroupedFileFind, useFileFindGroup } from './fileFind.js';
import { readLoadedSourceLanguage } from './sourceLanguageRegistry.js';
import { FilePreviewDataContext } from './FilePreview.js';
import { DiffReviewToolbar } from './DiffReviewToolbar.js';
import { DiffConnectorLayer } from './DiffConnectorLayer.js';
import { previewText } from './useFilePreviewDraft.js';
import { useGitBlame } from './useGitBlame.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { GitPaneSeparator } from '../git/GitPaneSeparator.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import type { CodeDiffViewProps } from './CodeDiffView.js';
import './editableCodeDiffView.css';
import { Button } from '../ui/Button.js';

/** 修改块使用统一语义色，两侧新增或删除的空白由 MergeView 负责对齐。 */
function chunkTone(chunk: Chunk): string {
  return chunk.fromA === chunk.toA ? 'addition' : chunk.fromB === chunk.toB ? 'deletion' : 'replacement';
}

/** 未改区间在两侧的字符偏移由前一个变更决定。 */
function unchangedOffset(view: EditorView, position: number): number {
  const info = getChunks(view.state);
  if (!info) return 0;
  const left = info.side === 'a';
  /** 区块按文档坐标排列，编辑长文件时不为每个折叠重新扫描全部变更。 */
  let first = 0;
  let end = info.chunks.length;
  while (first < end) {
    const middle = Math.floor((first + end) / 2);
    const chunk = info.chunks[middle]!;
    if ((left ? chunk.toA : chunk.toB) <= position) first = middle + 1;
    else end = middle;
  }
  const chunk = info.chunks[first - 1];
  return chunk ? (left ? chunk.toB - chunk.toA : chunk.toA - chunk.toB) : 0;
}

/** 定位、查找和评论都从实际折叠区起点同时展开两侧。 */
function expandDiffFold(view: EditorView, position: number): void {
  const line = view.lineBlockAt(position);
  const blocks = Array.isArray(line.type) ? line.type : [line];
  const folded = blocks.find((block) => block.widget?.type === 'collapsed-unchanged-code' && block.from <= position && block.to >= position);
  if (!folded) return;
  const pair = mergeViewSiblings(view);
  const offset = unchangedOffset(view, folded.from);
  view.dispatch({ effects: uncollapseUnchanged.of(folded.from) });
  if (pair) (pair.a === view ? pair.b : pair.a).dispatch({ effects: uncollapseUnchanged.of(folded.from + offset) });
}

/** 获取整份文档中原生 Diff 折叠的边界，包含当前视口之外的区间。 */
function collapsedDiffRanges(view: EditorView): Map<number, number> {
  const ranges = new Map<number, number>();
  for (const decorations of view.state.facet(EditorView.decorations)) {
    if (typeof decorations === 'function') continue;
    decorations.between(0, view.state.doc.length, (from, to, decoration) => {
      if (decoration.spec.widget?.type === 'collapsed-unchanged-code') ranges.set(from, to);
    });
  }
  return ranges;
}

/** 编辑器会独立更新各侧折叠。只有两侧仍指向同一段未改内容时才保留折叠。 */
function synchronizeDiffFolds(merge: MergeView): void {
  const remaining = collapsedDiffRanges(merge.b);
  const expandLeft: StateEffect<number>[] = [];
  for (const [from, to] of collapsedDiffRanges(merge.a)) {
    const offset = unchangedOffset(merge.a, from);
    if (remaining.get(from + offset) === to + offset) remaining.delete(from + offset);
    else expandLeft.push(uncollapseUnchanged.of(from));
  }
  if (expandLeft.length) merge.a.dispatch({ effects: expandLeft });
  if (remaining.size) merge.b.dispatch({ effects: Array.from(remaining.keys(), (from) => uncollapseUnchanged.of(from)) });
}

/** 双栏与统一视图保留相同的上下文行数和最短折叠长度。 */
const diffFoldOptions = { margin: 3, minSize: 4 };
/** 行号背景与正文保持相同区块语义。 */
class ToneMarker extends GutterMarker {
  /** CSS 类只表达增删改状态。 */
  constructor(tone: string) {
    super();
    this.elementClass = `code-diff-tone is-${tone}`;
  }
}
/** 从实际文档坐标生成区块底色，输入和撤销后由 MergeView 同步更新。 */
function editableDiffColors(): Extension {
  /** 只遍历当前可见代码行，长文件不生成全量节点。 */
  const colors = ViewPlugin.define(
    (view) => {
      /** 同一状态产生正文和行号两份稀疏装饰。 */
      const build = () => {
        const info = getChunks(view.state);
        const lines: ReturnType<Decoration['range']>[] = [];

        for (const [block, chunk] of (info?.chunks ?? []).entries()) {
          const start = info?.side === 'a' ? chunk.fromA : chunk.fromB;
          const end = info?.side === 'a' ? chunk.toA : chunk.toB;
          for (const range of view.visibleRanges) {
            if (start === end || range.to < start || range.from >= end) continue;
            let position = view.state.doc.lineAt(Math.min(view.state.doc.length, Math.max(range.from, start))).from;
            while (position < Math.min(range.to + 1, end) && position <= view.state.doc.length) {
              lines.push(Decoration.line({ attributes: { class: `code-diff-line is-${chunkTone(chunk)}`, 'data-diff-block': String(block) } }).range(position));

              position = view.state.doc.lineAt(position).to + 1;
            }
          }
        }
        return { lines: Decoration.set(lines, true) };
      };
      return {
        value: build(),
        chunks: getChunks(view.state)?.chunks,
        update(update) {
          const chunks = getChunks(update.state)?.chunks;
          if (update.docChanged || update.viewportChanged || chunks !== this.chunks) this.value = build();
          this.chunks = chunks;
        },
      };
    },
    { decorations: (plugin) => plugin.value.lines },
  );
  /** 所有差异事务均刷新行号颜色，旧侧正文不变时也能跟随当前侧输入。 */
  const tones = StateField.define<{ chunks?: readonly Chunk[]; marks: RangeSet<GutterMarker> }>({
    create: () => ({ marks: RangeSet.empty }),
    update(value, transaction) {
      const info = getChunks(transaction.state);
      if (!transaction.docChanged && info?.chunks === value.chunks) return value;
      return {
        chunks: info?.chunks,
        marks: RangeSet.of(
          (info?.chunks ?? []).flatMap((chunk) => {
            const result: ReturnType<ToneMarker['range']>[] = [];
            const from = info?.side === 'a' ? chunk.fromA : chunk.fromB;
            const to = info?.side === 'a' ? chunk.toA : chunk.toB;
            for (let pos = from; pos < to && pos <= transaction.state.doc.length; pos = transaction.state.doc.lineAt(pos).to + 1) result.push(new ToneMarker(chunkTone(chunk)).range(pos));
            return result;
          }),
          true,
        ),
      };
    },
    provide: (field) => gutterLineClass.from(field, (value) => value.marks),
  });
  return [colors, tones];
}

/** 原生折叠继续负责双侧展开，只补充紧凑边界的提示和键盘入口。 */
function accessibleDiffFolds(): Extension {
  return ViewPlugin.define((view) => {
    /** 等 CodeMirror 完成节点更新后设置辅助信息，不替换折叠内容或状态。 */
    const decorate = () =>
      view.requestMeasure({
        read: () => [...view.dom.querySelectorAll<HTMLElement>('.cm-collapsedLines')],
        write: (elements) => {
          for (const element of elements) {
            /** 现有本地化行数文本只在悬停和读屏时显示。 */
            const label = element.textContent ?? '';
            element.title = label;
            element.setAttribute('aria-label', label);
            element.setAttribute('role', 'button');
            element.tabIndex = 0;
            element.onkeydown = (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              element.click();
              view.focus();
            };
          }
        },
      });
    decorate();
    return { update: decorate };
  });
}

/** 评论容器属于 React，编辑时只映射锚点，不把评论文字写入文档。 */
class InlineCommentWidget extends WidgetType {
  /** 容器身份在当前文件生命周期内稳定。 */
  constructor(readonly element: HTMLElement) {
    super();
  }
  /** 相同容器不重复挂载评论输入框。 */
  eq(other: InlineCommentWidget) {
    return this.element === other.element;
  }
  /** 返回已有门户节点。 */
  toDOM() {
    return this.element;
  }
}
/** 评论定位使用来源版本行号，当前草稿插入行后仍指向原评论。 */
interface CommentAnchor {
  side: 'left' | 'right';
  line: number;
  element: HTMLElement;
  /** 另一侧只保留同高占位，不复制评论内容。 */
  mirror: HTMLElement;
}
/** 外部评论变化替换装饰，文本输入则交给 CodeMirror 映射偏移。 */
const setComments = StateEffect.define<DecorationSet>();
/** 评论块可以随编辑移动，不覆盖编辑器正文或历史。 */
const commentsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setComments)) return effect.value;
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 展开评论所在区块，让恢复折叠模式或刷新正文后仍能看到评论。 */
function revealDiffComments(view: EditorView): void {
  view.state.field(commentsField, false)?.between(0, view.state.doc.length, (from) => expandDiffFold(view, from));
}
/** 可见行号的 React 操作门户。 */
class EditableLineMarker extends GutterMarker {
  /** 只在行号或回调变化时更新门户。 */
  constructor(
    readonly line: number,
    readonly mount: (element: HTMLElement, line: number) => void,
    readonly unmount: (element: HTMLElement) => void,
  ) {
    super();
  }
  /** 行号节点滚动时由 CodeMirror 复用。 */
  eq(other: EditableLineMarker) {
    return this.line === other.line && this.mount === other.mount;
  }
  /** 行操作沿用现有审核和会话的 React 回调。 */
  toDOM() {
    const element = document.createElement('span');
    element.className = 'code-diff-line-number';
    this.mount(element, this.line);
    return element;
  }
  /** 可视区回收时释放门户登记。 */
  destroy(element: HTMLElement) {
    this.unmount(element);
  }
}

/** 真实正文是唯一可编辑文档；补白、折叠、旧侧与差异颜色均不参与保存。 */
export function EditableCodeDiffView(props: CodeDiffViewProps) {
  /** 能力和正文来自同一次预览授权。 */
  const preview = useContext(FilePreviewDataContext)!;
  const editing = preview.editing!;
  const zh = preview.zh;
  /** MergeView 两端的查找都挂在公共工具栏下方。 */
  const findGroup = useFileFindGroup();
  findGroup.reveal = (view) => {
    const position = view.state.selection.main.from;
    expandDiffFold(view, position);
    view.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) });
    /** 宽度变化和折行会修正估算行高，待命中标记绘制后按真实位置对齐。 */
    const selection = view.state.selection.main;
    view.dom.ownerDocument.defaultView?.requestAnimationFrame(() => {
      if (view.dom.isConnected && view.state.selection.main.eq(selection)) view.dom.querySelector('.cm-searchMatch-selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  };
  const single = props.singleSide === 'right' || props.file.changeType === 'added';
  const unified = preview.unified && !single;
  /** 容器只归 MergeView 所有，共享 CodeEditor 负责语言、键位及阅读设置。 */
  const host = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const [views, setViews] = useState<{ left?: EditorView; right?: EditorView }>({});
  const latest = useRef({ preview, props });
  latest.current = { preview, props };
  /** 布局切换复用实际正文的撤销记录和选区。 */
  const previousState = useRef<EditorState | null>(null);
  const [revision, setRevision] = useState(0);
  const [current, setCurrent] = useState(-1);
  /** 放弃草稿使用共享确认层，避免误触清空尚未保存的代码。 */
  const [discarding, setDiscarding] = useState(false);
  const before = previewText(preview.items?.[0]);
  /** 全文切换只重配折叠扩展，不替换真实文档。 */
  const unifiedSlot = useRef(new Compartment()).current;
  /** 逐行归属分别绑定已保存版本，草稿变化行不冒用旧作者。 */
  const leftBlame = useGitBlame({ previewId: preview.items?.[0]?.blame === undefined ? preview.items?.[0]?.id : undefined });
  const rightBlame = useGitBlame({ previewId: preview.items?.[1]?.blame === undefined ? preview.items?.[1]?.id : undefined });
  const blame = { left: props.blame?.left ?? preview.items?.[0]?.blame ?? leftBlame?.lines, right: editing.showingDraft ? undefined : (props.blame?.right ?? preview.items?.[1]?.blame ?? rightBlame?.lines) };
  /** 评论门户登记只随可见节点变化；正文输入不重新创建门户容器。 */
  const portals = useMemo(() => {
    const entries = new Map<HTMLElement, { line: number; side: 'left' | 'right' }>();
    let active = true;
    let queued = false;
    const notify = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) setRevision((value) => value + 1);
      });
    };
    const make = (side: 'left' | 'right') => ({
      mount(element: HTMLElement, line: number) {
        entries.set(element, { line, side });
        notify();
      },
      unmount(element: HTMLElement) {
        entries.delete(element);
        notify();
      },
    });
    return {
      entries,
      left: make('left'),
      right: make('right'),
      activate() {
        active = true;
      },
      dispose() {
        active = false;
      },
    };
  }, []);
  useEffect(() => {
    portals.activate();
    return () => portals.dispose();
  }, [portals]);
  /** 评论容器按原行保留，改变文件正文不会卸载正在填写的评论。 */
  const anchorCache = useRef(new Map<string, CommentAnchor>());
  const anchors = useMemo<CommentAnchor[]>(() => {
    const next = new Map<string, CommentAnchor>();
    for (const { line, side } of props.annotationLines ?? []) {
      const key = `${side}:${line}`;
      next.set(
        key,
        anchorCache.current.get(key) ?? {
          line,
          side,
          element: Object.assign(document.createElement('div'), { className: 'code-diff-annotation' }),
          mirror: Object.assign(document.createElement('div'), { className: 'code-diff-annotation' }),
        },
      );
    }
    anchorCache.current = next;
    return [...next.values()];
  }, [props.annotationLines]);
  /** 变更统计合并同一事件周期，异步语言高亮不触发额外渲染。 */
  const updates = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (update.docChanged) queueMicrotask(() => setRevision((value) => value + 1));
        const changedChunks = getChunks(update.state)?.chunks !== getChunks(update.startState)?.chunks;
        if (changedChunks && mergeRef.current?.b === update.view && !latest.current.preview.full) {
          /** 整份正文替换使旧折叠失去坐标，等两侧变更完成后用新正文重建折叠。 */
          let replacedDocument = false;
          update.changes.iterChangedRanges((from, to) => {
            replacedDocument ||= from === 0 && to === update.startState.doc.length;
          });
          queueMicrotask(() => {
            const merge = mergeRef.current;
            if (!merge || merge.b !== update.view || latest.current.preview.full) return;
            if (replacedDocument) {
              merge.reconfigure({ collapseUnchanged: undefined });
              merge.reconfigure({ collapseUnchanged: diffFoldOptions });
              revealDiffComments(merge.a);
              revealDiffComments(merge.b);
            }
            synchronizeDiffFolds(merge);
          });
        }
        if (changedChunks || update.docChanged || update.viewportChanged || update.geometryChanged)
          queueMicrotask(() => {
            if (!update.view.dom.isConnected) return;
            const info = getChunks(update.view.state);
            /** 双栏补位只匹配变更的空侧，统一视图的旧文段挂在新侧区块起点。 */
            update.view.dom.querySelectorAll<HTMLElement>('.cm-mergeSpacer, .cm-deletedChunk').forEach((element) => {
              const pos = update.view.posAtDOM(element);
              const spacer = element.classList.contains('cm-mergeSpacer');
              const block =
                info?.chunks.findIndex((item) => {
                  const from = info.side === 'a' ? item.fromA : item.fromB;
                  const to = info.side === 'a' ? item.toA : item.toB;
                  return (!spacer || from === to) && Math.min(from, update.view.state.doc.length) === pos;
                }) ?? -1;
              const chunk = info?.chunks[block];
              element.dataset.diffTone = chunk ? chunkTone(chunk) : '';
              element.dataset.diffBlock = chunk ? String(block) : '';
            });
          });
      }),
    [],
  );
  /** 每个编辑器继续使用原有评论行号入口。 */
  const extensions = useMemo(() => {
    const make = (side: 'left' | 'right'): Extension => [
      editableDiffColors(),
      accessibleDiffFolds(),
      commentsField,
      updates,
      EditorState.phrases.of(zh ? { '$ unchanged lines': '省略 $ 行未修改内容' } : {}),
      props.renderLineNumber ? gutter({ class: 'code-diff-gutter', lineMarker: (view, line) => new EditableLineMarker(view.state.doc.lineAt(line.from).number, portals[side].mount, portals[side].unmount) }) : [],
    ];
    return { left: make('left'), right: make('right') };
  }, [zh, Boolean(props.renderLineNumber), portals, updates]);

  // 比较两端在同一绘制前准备好，避免先显示空白再挂载 MergeView。
  useLayoutEffect(() => {
    if (single || unified || !host.current) {
      return;
    }
    const saved = previousState.current;
    /** 只有正文相同时才移交选区和撤销栈，外部重载不得套用旧历史。 */
    const reusable = saved?.doc.toString() === latest.current.preview.editing!.content;
    const merge = new MergeView({
      parent: host.current,
      // 首次测量就使用共享字体和已预读语言，不能先用 MergeView 默认样式再覆盖。
      a: { doc: before, extensions: [codeEditorTheme, readLoadedSourceLanguage(detectSourceLanguage(latest.current.props.file.oldPath))?.extension ?? []] },
      b: {
        doc: latest.current.preview.editing!.content,
        selection: reusable ? saved.selection : undefined,
        extensions: [
          codeEditorTheme,
          readLoadedSourceLanguage(detectSourceLanguage(latest.current.props.file.newPath))?.extension ?? [],
          reusable && saved.field(historyField, false) ? historyField.init(() => saved.field(historyField)) : [],
        ],
      },
      revertControls: 'a-to-b',
      renderRevertControl: () => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'code-diff-revert';
        /** 两种差异入口使用同一细线双箭头，不受系统字体和基线影响。 */
        const icon = document.createElement('span');
        icon.className = 'code-diff-revert-icon';
        icon.setAttribute('aria-hidden', 'true');
        button.append(icon);
        button.setAttribute('aria-label', zh ? '将此处改动恢复到草稿' : 'Restore this change in the draft');
        button.title = zh ? '恢复此处改动，可撤销；保存后写入文件' : 'Restore this change; save to write the file';
        // MergeView 以鼠标按下执行恢复；键盘激活使用相同入口，并回到当前正文。
        button.addEventListener('click', (event) => {
          if (event.detail !== 0) return;
          button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          queueMicrotask(() => mergeRef.current?.b.focus());
        });
        return button;
      },
      collapseUnchanged: preview.full ? undefined : diffFoldOptions,
      diffConfig: { scanLimit: 10000, timeout: 40 },
    });
    mergeRef.current = merge;
    synchronizeDiffFolds(merge);
    setViews({ left: merge.a, right: merge.b });
    /** 在途或外部 Git 命令锁定恢复按钮，不能绕过共享只读状态。 */
    const blockRevert = (event: MouseEvent) => {
      if (latest.current.preview.editing?.saving || latest.current.preview.editing?.conflict || latest.current.props.revertDisabled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    merge.dom.querySelector<HTMLElement>('.cm-merge-revert')?.addEventListener('mousedown', blockRevert, true);
    return () => {
      previousState.current = merge.b.state;
      mergeRef.current = null;
      merge.destroy();
    };
  }, [single, unified, before, zh]);
  useLayoutEffect(() => {
    const merge = mergeRef.current;
    if (!merge) return;
    merge.reconfigure({ collapseUnchanged: preview.full ? undefined : diffFoldOptions });
    synchronizeDiffFolds(merge);
  }, [preview.full]);
  /** 单栏和统一视图也保留真实当前文档；删除内容仅为只读装饰。 */
  const unifiedConfig = useMemo(
    () =>
      unifiedMergeView({
        original: before,
        mergeControls: (type, action) => {
          /** 统一视图同样用紧凑恢复图标，避免白色说明文字覆盖代码。 */
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'code-diff-revert';
          button.title = zh ? '恢复此处改动，可撤销；保存后写入文件' : 'Restore this change; save to write the file';
          button.setAttribute('aria-label', zh ? '将此处改动恢复到草稿' : 'Restore this change in the draft');
          /** 与双栏和只读差异保持同一图形。 */
          const icon = document.createElement('span');
          icon.className = 'code-diff-revert-icon';
          icon.setAttribute('aria-hidden', 'true');
          button.append(icon);
          if (type === 'accept') button.style.display = 'none';
          if (type === 'reject')
            button.onclick = (event) => {
              if (!latest.current.preview.editing?.saving && !latest.current.preview.editing?.conflict && !latest.current.props.revertDisabled) action(event);
            };
          return button;
        },
        collapseUnchanged: preview.full ? undefined : diffFoldOptions,
        diffConfig: { scanLimit: 10000, timeout: 40 },
      }),
    [before, preview.full, zh],
  );
  const onePane = useMemo(() => unifiedSlot.of(unifiedConfig), [unifiedConfig, unifiedSlot]);
  const rightExtensions = useMemo(() => [extensions.right, single || unified ? onePane : []], [extensions, single, unified, onePane]);
  /** 当前已挂载的真实文档用于定位、评论和差异计数。 */
  const right = views.right;
  useEffect(() => {
    // 嵌套 Compartment 保留自身配置，切换范围时必须明确重配而非重建父装饰。
    if ((single || unified) && right) right.dispatch({ effects: unifiedSlot.reconfigure(unifiedConfig) });
  }, [single, unified, right, unifiedConfig, unifiedSlot]);
  const chunks = right ? (getChunks(right.state)?.chunks ?? []) : [];
  /** 编辑或恢复可能减少差异数量，显示和导航共同使用仍有效的序号。 */
  const currentChange = Math.min(current, chunks.length - 1);
  void revision;
  useEffect(() => {
    for (const side of ['left', 'right'] as const) {
      const view = views[side];
      if (!view) continue;
      view.dom.querySelectorAll('.cm-gutters').forEach((element) => element.removeAttribute('aria-hidden'));
      const decorations = anchors.flatMap((anchor) => {
        const source = views[anchor.side];
        const sourceDoc = source?.state.doc ?? (unified && anchor.side === 'left' ? Text.of(before.split('\n')) : undefined);
        if (!sourceDoc) return [];
        let sourcePos = sourceDoc.line(Math.min(anchor.line, sourceDoc.lines)).to;
        if (anchor.side === 'right' && editing.showingDraft) {
          // 重新打开已有草稿时先把磁盘评论行映射到当前正文，不把插入行当成旧评论位置。
          const saved = Text.of(editing.base.split('\n'));
          const pos = saved.line(Math.min(anchor.line, saved.lines)).to;
          let delta = 0;
          for (const chunk of Chunk.build(saved, sourceDoc, { scanLimit: 10000, timeout: 40 })) {
            if (pos < chunk.fromA) break;
            if (pos < chunk.toA) {
              delta = chunk.fromB - chunk.fromA;
              break;
            }
            delta = chunk.toB - chunk.toA;
          }
          sourcePos = Math.min(sourceDoc.length, Math.max(0, pos + delta));
        }
        // 未修改部分按字符偏移映射，改动内部映射到对应区块的行边界。
        let position = sourcePos;
        if (anchor.side !== side) {
          let delta = 0;
          for (const chunk of getChunks((source ?? views.right!).state)?.chunks ?? []) {
            const from = anchor.side === 'left' ? chunk.fromA : chunk.fromB;
            const to = anchor.side === 'left' ? chunk.toA : chunk.toB;
            const otherFrom = anchor.side === 'left' ? chunk.fromB : chunk.fromA;
            const otherTo = anchor.side === 'left' ? chunk.toB : chunk.toA;
            if (position < from) break;
            if (position < to) {
              delta = otherFrom - from;
              position = Math.min(position, from + Math.max(0, otherTo - otherFrom - 1));
              break;
            }
            delta = otherTo - to;
          }
          position += delta;
        }
        return [
          Decoration.widget({ widget: new InlineCommentWidget(anchor.side === side || unified ? anchor.element : anchor.mirror), block: true, side: 1 }).range(
            view.state.doc.lineAt(Math.max(0, Math.min(position, view.state.doc.length))).to,
          ),
        ];
      });
      view.dispatch({ effects: setComments.of(Decoration.set(decorations, true)) });
    }
  }, [views, anchors, editing.showingDraft]);
  useEffect(() => {
    /** 评论正文高度和窗口宽度变化后同步另一栏补白。 */
    const alignComments = () => {
      for (const anchor of anchors) {
        const view = views[anchor.side] ?? (unified ? views.right : undefined);
        if (!view) continue;
        const width = Math.max(0, (view.dom.parentElement?.clientWidth ?? 0) - (view.dom.querySelector<HTMLElement>('.cm-gutters')?.offsetWidth ?? 0));
        anchor.element.style.width = `${width}px`;
        anchor.mirror.style.height = `${anchor.element.getBoundingClientRect().height}px`;
      }
      views.left?.requestMeasure();
      views.right?.requestMeasure();
    };
    const observer = new ResizeObserver(alignComments);
    anchors.forEach((anchor) => observer.observe(anchor.element));
    for (const view of [views.left, views.right]) if (view) observer.observe(view.dom);
    alignComments();
    return () => observer.disconnect();
  }, [anchors, views]);
  useEffect(() => {
    const position = props.focusAnnotation ?? props.revealLine;
    if (!position) return;
    const view = views[position.side] ?? (unified ? right : undefined);
    if (!view) return;
    const line = view.state.doc.line(Math.min(position.line, view.state.doc.lines));
    expandDiffFold(view, line.from);
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    if (props.focusAnnotation)
      queueMicrotask(() =>
        anchors
          .find((anchor) => anchor.side === position.side && anchor.line === position.line)
          ?.element.querySelector('textarea')
          ?.focus(),
      );
  }, [props.focusAnnotation, props.revealLine, views, unified, anchors, right]);
  useEffect(() => {
    // 切回折叠模式时保留评论所在片段，使用已经随输入映射的实际坐标。
    for (const view of [views.left, views.right]) {
      if (view) revealDiffComments(view);
    }
  }, [preview.full, anchors, editing.showingDraft, views]);
  /** 每次导航按当前实时差异坐标定位，不依赖已经过期的补丁行号。 */
  function navigate(direction: -1 | 1) {
    const index = Math.max(0, Math.min(chunks.length - 1, currentChange + direction));
    const chunk = chunks[index];
    if (!chunk) return;
    setCurrent(index);
    for (const side of ['left', 'right'] as const) {
      const view = views[side];
      if (!view) continue;
      const pos = Math.min(view.state.doc.length, side === 'left' ? chunk.fromA : chunk.fromB);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    }
  }
  /** 页内编辑状态放入原工具栏，继续保留原生源码页入口。 */
  const toolbar = (
    <>
      <DiffReviewToolbar
        onFind={props.hideFindButton ? undefined : () => requestGroupedFileFind(findGroup)}
        zh={zh}
        full={preview.full}
        fullAvailable
        onFullChange={preview.onFullChange}
        current={currentChange}
        count={chunks.length}
        onNavigate={navigate}
        unified={unified}
        allowLayout={!single}
        onUnifiedChange={(value) => {
          previousState.current = views.right?.state ?? null;
          return preview.onUnifiedChange(value);
        }}
        onPreview={preview.onPreview}
        onRefresh={preview.onRefresh}
      />
      <span className="diff-edit-status" role="status">
        {editing.saving
          ? zh
            ? '正在保存…'
            : 'Saving…'
          : editing.conflict
            ? editing.showingDraft
              ? zh
                ? '保留草稿（只读）'
                : 'Retained draft (read only)'
              : zh
                ? '工作区差异'
                : 'Working tree diff'
            : editing.dirty
              ? zh
                ? '未保存'
                : 'Unsaved'
              : zh
                ? '可直接编辑'
                : 'Editable'}
      </span>
      {editing.conflict ? (
        <Button unstyled type="button" aria-pressed={editing.showingDraft} onClick={editing.onToggleDraft}>
          {editing.showingDraft ? (zh ? '查看工作区' : 'View working tree') : zh ? '查看保留草稿' : 'View retained draft'}
        </Button>
      ) : null}
      <Button unstyled type="button" className="diff-edit-save" disabled={!editing.dirty || editing.saving || editing.conflict || props.revertDisabled} onClick={() => editing.onSave()}>
        {zh ? '保存' : 'Save'}
      </Button>
      {editing.dirty ? (
        <Button
          unstyled
          type="button"
          disabled={editing.saving}
          onClick={() => {
            setDiscarding(true);
          }}
        >
          {zh ? '放弃' : 'Discard'}
        </Button>
      ) : null}
    </>
  );
  return (
    <div className="code-diff-container" onKeyDown={(event) => fileFindShortcut(event, () => requestGroupedFileFind(findGroup))}>
      {discarding ? (
        <ModalPortal role="alertdialog" aria-label={zh ? '放弃未保存修改' : 'Discard unsaved changes'} onDismiss={() => setDiscarding(false)}>
          <section className="code-diff-revert-dialog" data-modal-surface="dialog">
            <strong>{zh ? '放弃此文件的未保存修改？' : 'Discard unsaved changes to this file?'}</strong>
            <p>{props.file.newPath}</p>
            <footer>
              <Button unstyled type="button" onClick={() => setDiscarding(false)}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button
                unstyled
                type="button"
                onClick={() => {
                  editing.onDiscard();
                  setDiscarding(false);
                  queueMicrotask(() => views.right?.focus());
                }}
              >
                {zh ? '放弃修改' : 'Discard changes'}
              </Button>
            </footer>
          </section>
        </ModalPortal>
      ) : null}
      {preview.toolbarTarget ? createPortal(toolbar, preview.toolbarTarget) : toolbar}
      {editing.conflict ? (
        <p role="alert">{zh ? '文件已更新，未保存草稿已保留。可切换查看和复制，放弃草稿后可继续编辑。' : 'The file changed. Your unsaved draft is retained. Switch views to copy it, or discard it to resume editing.'}</p>
      ) : null}
      {editing.error ? <VisibleApplicationError error={editing.error} language={zh ? 'zh-CN' : 'en'} /> : null}
      <div className="file-find-slot" ref={findGroup.host} />
      <div className={`code-diff-view code-diff-editable${single || unified ? ' is-single-side' : ''}${props.renderLineNumber ? ' has-line-actions' : ''}`} aria-label={props.label}>
        {!single && !unified ? <DiffConnectorLayer /> : null}
        {!single && !unified ? <div className="editable-diff-host" ref={host} /> : null}
        {views.left && mergeRef.current && !single && !unified ? (
          <CodeEditor
            key="before"
            externalView={views.left}
            findGroup={findGroup}
            findSide="before"
            path={`${props.file.oldPath}:editable-before`}
            content={before}
            language={detectSourceLanguage(props.file.oldPath)}
            readOnly
            label={zh ? '旧版本（只读）' : 'Original (read only)'}
            extensions={extensions.left}
            blameLines={blame.left}
            blame={blame.left}
            locale={zh ? 'zh-CN' : 'en-US'}
          />
        ) : null}
        {single || unified || (views.right && mergeRef.current) ? (
          <CodeEditor
            key={single || unified ? 'one-pane' : 'two-pane'}
            externalView={single || unified ? undefined : views.right}
            findGroup={findGroup}
            findSide="after"
            historyState={previousState.current ?? undefined}
            path={`${props.file.newPath}:editable-current`}
            content={editing.content}
            savedContent={editing.base}
            language={detectSourceLanguage(props.file.newPath)}
            readOnly={Boolean(editing.saving || editing.conflict || props.revertDisabled)}
            label={editing.conflict ? (editing.showingDraft ? (zh ? '保留草稿（只读）' : 'Retained draft (read only)') : zh ? '工作区版本（只读）' : 'Working tree (read only)') : zh ? '当前版本（可编辑）' : 'Current version (editable)'}
            extensions={rightExtensions}
            blameLines={blame.right}
            blame={blame.right}
            locale={zh ? 'zh-CN' : 'en-US'}
            onChange={editing.onChange}
            onSave={() => {
              if (!props.revertDisabled) return editing.onSave();
            }}
            onView={(view) => {
              if (view) {
                view.dom.querySelectorAll('.cm-gutters').forEach((element) => element.removeAttribute('aria-hidden'));
                if (single || unified) setViews({ right: view });
              } else if (single || unified) {
                previousState.current = right?.state ?? null;
              }
            }}
          />
        ) : null}
        {props.resizable && !single && !unified ? <GitPaneSeparator name="diff" label={props.label} initial={50} min={20} max={80} target=".code-diff-editable" /> : null}
        {[...portals.entries].map(([element, position]) => createPortal(position.side === 'right' && editing.showingDraft ? position.line : (props.renderLineNumber?.(position.line, position.side) ?? position.line), element))}
        {anchors.map((anchor) => createPortal(props.renderLineComments?.(anchor.line, anchor.side), anchor.element, `${anchor.side}:${anchor.line}`))}
      </div>
    </div>
  );
}
