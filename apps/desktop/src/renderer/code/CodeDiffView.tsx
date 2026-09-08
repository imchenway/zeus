import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { detectSourceLanguage } from '@zeus/shared';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from '@codemirror/view';
import { Text, type Extension } from '@codemirror/state';
import type { TaskGitFileDiff } from '../session/sessionTypes.js';
import { GitPaneSeparator } from '../git/GitPaneSeparator.js';
import { CodeEditor } from './CodeEditor.js';
import { CommentWidget } from './SourceCodePreview.js';
import './codeDiffView.css';

/** 评论位置沿用原始文件的左右行号。 */
export interface DiffAnnotationLine {
  line: number;
  side: 'left' | 'right';
}
/** 每个显示行对应旧文件、新文件或补丁元信息。 */
interface DiffRow {
  left: string;
  right: string;
  leftNumber: number | null;
  rightNumber: number | null;
  kind: string;
}
/** 当前可见行号的 React 门户容器。 */
interface GutterPortal {
  element: HTMLElement;
  row: number;
  side: 'left' | 'right';
}
/** 两侧评论容器始终同高，滚出视口后仍保留 React 草稿。 */
interface AnnotationPair {
  row: number;
  left: HTMLDivElement;
  right: HTMLDivElement;
  leftBody: HTMLDivElement;
  rightBody: HTMLDivElement;
}
/** 共用差异视图保留不同入口的行排列及操作能力。 */
interface CodeDiffViewProps {
  /** 已解析的补丁，只在文件内容变化时转换一次。 */
  file: TaskGitFileDiff;
  /** 统一视图保留补丁的增删前缀和双行号。 */
  unified?: boolean;
  /** Git 原有左右视图会配对相邻增删行。 */
  alignReplacements?: boolean;
  /** Git 工作台保留可拖动的左右分隔条。 */
  resizable?: boolean;
  /** 视图无障碍名称。 */
  label: string;
  /** 只有实际存在评论或草稿的行需要区块装饰。 */
  annotationLines?: DiffAnnotationLine[];
  /** 新建或编辑评论时，在区块挂载后定位并聚焦。 */
  focusAnnotation?: DiffAnnotationLine;
  /** 可见行号支持现有评论、范围选择和打开源码操作。 */
  renderLineNumber?: (line: number, side: 'left' | 'right') => ReactNode;
  /** React 继续管理评论编辑，不随代码行滚出而卸载。 */
  renderLineComments?: (line: number, side: 'left' | 'right') => ReactNode;
}

/** 差异全文存于编辑器文档，页面节点只覆盖可视区域。 */
export const CodeDiffView = memo(function CodeDiffView(props: CodeDiffViewProps) {
  /** 文件内容和布局变化时才构造显示行。 */
  const rows = useMemo(() => diffRows(props.file, Boolean(props.alignReplacements && !props.unified)), [props.file, props.alignReplacements, props.unified]);
  /** 行文本只生成一次，不跟随评论或会话输入更新。 */
  const documents = useMemo(
    () => ({
      left: Text.of(rows.map((row) => (props.unified ? `${row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '-' : row.kind === 'header' ? '' : ' '}${row.kind === 'deletion' ? row.left : row.right}` : row.left))),
      right: Text.of(rows.map((row) => row.right)),
    }),
    [rows, props.unified],
  );
  /** 原始行号到显示行的索引供稀疏评论定位。 */
  const positions = useMemo(() => {
    const result = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.leftNumber !== null) result.set(`left:${row.leftNumber}`, index);
      if (row.rightNumber !== null) result.set(`right:${row.rightNumber}`, index);
    });
    return result;
  }, [rows]);
  /** 两个编辑器共用纵向位置，横向保持独立。 */
  const views = useRef<{ left: EditorView | null; right: EditorView | null }>({ left: null, right: null });
  /** 仅在可见行号容器变化时发布一次 React 更新。 */
  const [, setGutterRevision] = useState(0);
  /** 行号容器注册表大小随可视行数变化。 */
  const gutterPortals = useMemo(
    () => ({
      entries: new Map<HTMLElement, GutterPortal>(),
      queued: false,
      active: true,
      notify() {
        if (this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          if (this.active) setGutterRevision((revision) => revision + 1);
        });
      },
    }),
    [],
  );
  useEffect(() => {
    gutterPortals.active = true;
    return () => {
      gutterPortals.active = false;
    };
  }, [gutterPortals]);
  /** 相同评论行继续使用已有节点，避免取消正在输入的草稿。 */
  const pairCache = useRef(new Map<string, AnnotationPair>());
  /** 区块只按实际评论行构建，不再为每一行筛选所有评论。 */
  const pairs = useMemo(() => {
    const next = new Map<string, AnnotationPair>();
    for (const position of props.annotationLines ?? []) {
      const row = positions.get(`${position.side}:${position.line}`);
      if (row === undefined) continue;
      const key = `${props.file.oldPath}:${props.file.newPath}:${row}`;
      if (next.has(key)) continue;
      let pair = pairCache.current.get(key);
      if (!pair) {
        const left = document.createElement('div');
        const right = document.createElement('div');
        const leftBody = document.createElement('div');
        const rightBody = document.createElement('div');
        left.className = right.className = 'code-diff-annotation';
        left.append(leftBody);
        right.append(rightBody);
        pair = { row, left, right, leftBody, rightBody };
      }
      next.set(key, pair);
    }
    pairCache.current = next;
    return [...next.values()];
  }, [props.annotationLines, positions, props.file.oldPath, props.file.newPath]);

  /** 视图扩展只依赖实际行内容、评论位置与布局。 */
  const extensions = useMemo(() => {
    /** 两个侧栏使用相同的显示行和评论高度。 */
    const make = (side: 'left' | 'right'): Extension => [
      gutter({ class: 'code-diff-gutter', lineMarker: (view, line) => new DiffGutterMarker(view.state.doc.lineAt(line.from).number - 1, side, gutterPortals) }),
      ViewPlugin.define(
        (view) => ({
          decorations: diffLineDecorations(view, rows, side, Boolean(props.unified)),
          update(update: ViewUpdate) {
            if (update.viewportChanged || update.docChanged) this.decorations = diffLineDecorations(update.view, rows, side, Boolean(props.unified));
          },
        }),
        { decorations: (plugin) => plugin.decorations },
      ),
      EditorView.decorations.of(
        Decoration.set(
          pairs.map((pair) =>
            Decoration.widget({ widget: new CommentWidget(pair[side]), block: true, side: 1 }).range(
              // 显示文档与 rows 同序，避免在 React 更新里查询所有编辑器行。
              documents[side].line(pair.row + 1).to,
            ),
          ),
          true,
        ),
      ),
      EditorView.domEventHandlers({
        scroll: (_event, view) => {
          const other = views.current[side === 'left' ? 'right' : 'left'];
          if (other && Math.abs(other.scrollDOM.scrollTop - view.scrollDOM.scrollTop) > 1) other.scrollDOM.scrollTop = view.scrollDOM.scrollTop;
        },
      }),
      EditorView.clipboardOutputFilter.of((text, state) => {
        if (props.unified || state.selection.ranges.every((range) => range.empty)) return text;
        // 复制按原始行过滤补位与片段头，保留真实空行和首尾选择范围。
        return state.selection.ranges
          .filter((range) => !range.empty)
          .map((range) => {
            const fromLine = state.doc.lineAt(range.from).number;
            const toLine = state.doc.lineAt(range.to).number;
            const selected: string[] = [];
            for (let number = fromLine; number <= toLine; number += 1) {
              const row = rows[number - 1];
              if (!row || row[side === 'left' ? 'leftNumber' : 'rightNumber'] === null) continue;
              const line = state.doc.line(number);
              selected.push(state.doc.sliceString(Math.max(range.from, line.from), Math.min(range.to, line.to)));
            }
            return selected.join('\n');
          })
          .join('\n');
      }),
    ];
    return { left: make('left'), right: make('right') };
  }, [rows, pairs, documents, props.unified, gutterPortals]);

  useEffect(() => {
    /** 评论折行、编辑和左右宽度变化时同步区块高度。 */
    const synchronize = () => {
      /** 长代码行可以横向延伸，评论仍限制在所在栏的可见宽度。 */
      for (const side of ['left', 'right'] as const) {
        const view = views.current[side];
        if (!view) continue;
        const width = Math.max(0, view.scrollDOM.clientWidth - (view.dom.querySelector<HTMLElement>('.cm-gutters')?.offsetWidth ?? 0));
        pairs.forEach((pair) => {
          pair[side].style.width = `${width}px`;
        });
      }
      for (const pair of pairs) {
        const height = Math.max(pair.leftBody.getBoundingClientRect().height, pair.rightBody.getBoundingClientRect().height);
        if (height > 0) pair.left.style.height = pair.right.style.height = `${height}px`;
      }
      views.current.left?.requestMeasure();
      views.current.right?.requestMeasure();
    };
    const observer = new ResizeObserver(synchronize);
    pairs.forEach((pair) => {
      observer.observe(pair.leftBody);
      observer.observe(pair.rightBody);
    });
    if (views.current.left) observer.observe(views.current.left.scrollDOM);
    if (views.current.right) observer.observe(views.current.right.scrollDOM);
    synchronize();
    return () => observer.disconnect();
  }, [pairs]);
  useEffect(() => {
    views.current.left?.requestMeasure();
    views.current.right?.requestMeasure();
  });

  /** 活跃评论容器身份稳定，其他评论变化不夺走输入焦点。 */
  const focusedPair = props.focusAnnotation ? pairs.find((pair) => pair.row === positions.get(`${props.focusAnnotation!.side}:${props.focusAnnotation!.line}`)) : undefined;
  const focusBody = props.focusAnnotation ? focusedPair?.[props.focusAnnotation.side === 'left' ? 'leftBody' : 'rightBody'] : undefined;
  useEffect(() => {
    const side = props.focusAnnotation?.side;
    const view = side ? views.current[side] : null;
    if (!view || !focusedPair || !focusBody) return;
    let cancelled = false;
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(focusedPair.row + 1).to, { y: 'center' }) });
    view.requestMeasure({
      read: () => focusBody.querySelector('textarea'),
      write: (textarea) =>
        queueMicrotask(() => {
          if (!cancelled) textarea?.focus({ preventScroll: true });
        }),
    });
    return () => {
      cancelled = true;
    };
  }, [focusBody]);

  return (
    <div className={`code-diff-view${props.unified ? ' is-unified' : ''}${props.resizable ? ' is-resizable' : ''}`} aria-label={props.label}>
      <CodeEditor
        path={`${props.file.oldPath || props.file.newPath}:left:${Boolean(props.unified)}`}
        language={detectSourceLanguage(props.unified ? props.file.newPath || props.file.oldPath : props.file.oldPath) ?? null}
        content={documents.left}
        readOnly
        label={props.label}
        extensions={extensions.left}
        onView={(view) => {
          views.current.left = view;
        }}
      />
      {!props.unified && props.resizable ? <GitPaneSeparator name="diff" label={props.label} initial={50} min={20} max={80} target=".project-git-diff-side-by-side" /> : null}
      {!props.unified ? (
        <CodeEditor
          path={`${props.file.newPath || props.file.oldPath}:right`}
          language={detectSourceLanguage(props.file.newPath) ?? null}
          content={documents.right}
          readOnly
          label={props.label}
          extensions={extensions.right}
          onView={(view) => {
            views.current.right = view;
          }}
        />
      ) : null}
      {[...gutterPortals.entries.values()].map((portal) => {
        const row = rows[portal.row];
        if (!row) return null;
        const number = row[portal.side === 'left' ? 'leftNumber' : 'rightNumber'];
        return createPortal(
          props.unified ? (
            <>
              <span>{row.leftNumber ?? ''}</span>
              <span>{row.rightNumber ?? ''}</span>
            </>
          ) : number === null ? null : (
            (props.renderLineNumber?.(number, portal.side) ?? number)
          ),
          portal.element,
          `${portal.side}:${portal.row}`,
        );
      })}
      {pairs.flatMap((pair) =>
        (['left', 'right'] as const).map((side) => {
          const number = rows[pair.row]?.[side === 'left' ? 'leftNumber' : 'rightNumber'];
          return createPortal(number == null ? null : props.renderLineComments?.(number, side), pair[side === 'left' ? 'leftBody' : 'rightBody'], `${side}:${pair.row}:comment`);
        }),
      )}
    </div>
  );
});

/** 可见行号借助门户保留原有 React 按钮及事件。 */
class DiffGutterMarker extends GutterMarker {
  /** 注册表只保存当前可见行的节点。 */
  constructor(
    private readonly row: number,
    private readonly side: 'left' | 'right',
    private readonly registry: { entries: Map<HTMLElement, GutterPortal>; notify(): void },
  ) {
    super();
  }
  /** 未变化的可见行号不重新挂载。 */
  eq(other: DiffGutterMarker): boolean {
    return this.row === other.row && this.side === other.side && this.registry === other.registry;
  }
  /** 创建用于行号和操作按钮的容器。 */
  toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'code-diff-line-number';
    this.registry.entries.set(element, { element, row: this.row, side: this.side });
    this.registry.notify();
    return element;
  }
  /** 行滚出视口后及时释放门户，不保留整份文件的按钮。 */
  destroy(dom: Node): void {
    this.registry.entries.delete(dom as HTMLElement);
    this.registry.notify();
  }
}

/** 只装饰可见行，完整文件的高亮交给编辑器后台增量解析。 */
function diffLineDecorations(view: EditorView, rows: DiffRow[], side: 'left' | 'right', unified: boolean) {
  const decorations = [];
  for (const range of view.visibleRanges) {
    for (let position = range.from; position <= range.to; ) {
      const line = view.state.doc.lineAt(position);
      const row = rows[line.number - 1];
      const kind = row?.kind === 'header' || unified ? row?.kind : row?.[side === 'left' ? 'leftNumber' : 'rightNumber'] === null ? 'empty' : row?.kind === (side === 'left' ? 'addition' : 'deletion') ? 'context' : row?.kind;
      decorations.push(Decoration.line({ attributes: { class: `code-diff-line is-${kind}`, 'data-diff-row': String(line.number), 'data-file-line': String(row?.[side === 'left' ? 'leftNumber' : 'rightNumber'] ?? '') } }).range(line.from));
      position = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}

/** 将补丁转换成左右显示行；不截断，完整内容可滚动和复制。 */
function diffRows(file: TaskGitFileDiff, align: boolean): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of file.hunks) {
    rows.push({ left: hunk.header, right: hunk.header, leftNumber: null, rightNumber: null, kind: 'header' });
    for (let index = 0; index < hunk.lines.length; ) {
      const line = hunk.lines[index]!;
      if (align && (line.type === 'deletion' || line.type === 'addition')) {
        const deleted: typeof hunk.lines = [];
        const added: typeof hunk.lines = [];
        while (index < hunk.lines.length && ['deletion', 'addition'].includes(hunk.lines[index]!.type)) {
          const changed = hunk.lines[index++]!;
          (changed.type === 'deletion' ? deleted : added).push(changed);
        }
        for (let offset = 0; offset < Math.max(deleted.length, added.length); offset += 1) {
          rows.push({ left: deleted[offset]?.content ?? '', right: added[offset]?.content ?? '', leftNumber: deleted[offset]?.oldLineNumber ?? null, rightNumber: added[offset]?.newLineNumber ?? null, kind: 'replacement' });
        }
      } else {
        rows.push({ left: line.type === 'addition' ? '' : line.content, right: line.type === 'deletion' ? '' : line.content, leftNumber: line.oldLineNumber, rightNumber: line.newLineNumber, kind: line.type });
        index += 1;
      }
    }
  }
  return rows;
}
