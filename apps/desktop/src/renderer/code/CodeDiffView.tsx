import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { detectSourceLanguage, type FilePreviewBlameLine } from '@zeus/shared';
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
  /** 统一视图按行底色区分增删，保留两侧原始行号。 */
  unified?: boolean;
  /** 新增或删除文件只挂载实际存在的一侧，保留原始行号和评论身份。 */
  singleSide?: 'left' | 'right';
  /** Git 原有左右视图会配对相邻增删行。 */
  alignReplacements?: boolean;
  /** Git 工作台保留可拖动的左右分隔条。 */
  resizable?: boolean;
  /** 外层已经提供区块标题时，不再重复显示原始 @@ 片段头。 */
  omitHunkHeaders?: boolean;
  /** 视图无障碍名称。 */
  label: string;
  /** 只有实际存在评论或草稿的行需要区块装饰。 */
  annotationLines?: DiffAnnotationLine[];
  /** 新建或编辑评论时，在区块挂载后定位并聚焦。 */
  focusAnnotation?: DiffAnnotationLine;
  /** 归属按原始文件行号关联，未提交和空白对齐行显示空白。 */
  blame?: { left: FilePreviewBlameLine[]; right: FilePreviewBlameLine[] };
  /** 光标行详情与左侧日期作者并存，语言跟随调用页面。 */
  blameLocale?: string;
  /** 片段导航只滚动同一个连续编辑器。 */
  revealLine?: DiffAnnotationLine;
  /** 可见行号支持现有评论、范围选择和打开源码操作。 */
  renderLineNumber?: (line: number, side: 'left' | 'right') => ReactNode;
  /** React 继续管理评论编辑，不随代码行滚出而卸载。 */
  renderLineComments?: (line: number, side: 'left' | 'right') => ReactNode;
}

/** 差异全文存于编辑器文档，页面节点只覆盖可视区域。 */
export const CodeDiffView = memo(function CodeDiffView(props: CodeDiffViewProps) {
  /** 所有入口对新增、删除文件只显示有效侧，不留空白旧行号列。 */
  const singleSide = props.singleSide ?? (props.file.changeType === 'added' ? 'right' : props.file.changeType === 'deleted' ? 'left' : undefined);
  /** 两侧均存在时才需要统一视图的双行号。 */
  const unified = Boolean(props.unified && !singleSide);
  /** 文件内容和布局变化时才构造显示行。 */
  const rows = useMemo(() => diffRows(props.file, Boolean(props.alignReplacements && !unified), Boolean(props.omitHunkHeaders)), [props.file, props.alignReplacements, unified, props.omitHunkHeaders]);
  /** 行文本只生成一次，不跟随评论或会话输入更新。 */
  const documents = useMemo(
    () => ({
      left: Text.of(rows.map((row) => (unified ? (row.kind === 'deletion' ? row.left : row.right) : row.left))),
      right: Text.of(rows.map((row) => row.right)),
    }),
    [rows, unified],
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
  /** 归属只在版本内容变化时建立索引，滚动时只渲染可见行。 */
  const blameByLine = useMemo(() => ({ left: new Map(props.blame?.left.map((line) => [line.line, line])), right: new Map(props.blame?.right.map((line) => [line.line, line])) }), [props.blame]);
  /** 仅为光标所在显示行解析归属，不复制全文索引或重复读取 Git。 */
  const cursorBlame = useMemo(() => {
    /** 统一视图的删除行取旧版，其余行取新版；左右视图各取自身版本。 */
    const resolve = (side: 'left' | 'right') => (displayLine: number) => {
      /** 差异显示行可能是片段头或用于两侧对齐的空行。 */
      const row = rows[displayLine - 1];
      if (!row) return undefined;
      /** 版本侧与左侧逐行归属采用相同规则。 */
      const version = unified ? (row.kind === 'deletion' ? 'left' : 'right') : side;
      /** 没有原始行号的补位行不显示提交信息。 */
      const line = row[version === 'left' ? 'leftNumber' : 'rightNumber'];
      return line === null ? undefined : blameByLine[version].get(line);
    };
    return { left: resolve('left'), right: resolve('right') };
  }, [rows, unified, blameByLine]);
  /** 两个编辑器共用纵向位置，横向保持独立。 */
  const views = useRef<{ left: EditorView | null; right: EditorView | null }>({ left: null, right: null });
  useEffect(() => {
    if (!props.revealLine) return;
    /** 左右视图使用同一显示行，删除行也能准确定位。 */
    const row = positions.get(`${props.revealLine.side}:${props.revealLine.line}`);
    const view = views.current.left ?? views.current.right;
    if (row !== undefined && view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(row + 1).from, { y: 'center' }) });
  }, [props.revealLine, positions]);
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
          decorations: diffLineDecorations(view, rows, side, unified),
          update(update: ViewUpdate) {
            if (update.viewportChanged || update.docChanged) this.decorations = diffLineDecorations(update.view, rows, side, unified);
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
        if (state.selection.ranges.every((range) => range.empty)) return text;
        // 复制按原始行过滤补位与片段头，保留真实空行和首尾选择范围。
        return state.selection.ranges
          .filter((range) => !range.empty)
          .map((range) => {
            const fromLine = state.doc.lineAt(range.from).number;
            const toLine = state.doc.lineAt(range.to).number;
            const selected: string[] = [];
            for (let number = fromLine; number <= toLine; number += 1) {
              const row = rows[number - 1];
              if (!row || (unified ? row.leftNumber === null && row.rightNumber === null : row[side === 'left' ? 'leftNumber' : 'rightNumber'] === null)) continue;
              const line = state.doc.line(number);
              selected.push(state.doc.sliceString(Math.max(range.from, line.from), Math.min(range.to, line.to)));
            }
            return selected.join('\n');
          })
          .join('\n');
      }),
    ];
    return { left: make('left'), right: make('right') };
  }, [rows, pairs, documents, unified, gutterPortals]);

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
    <div className={`code-diff-view${unified ? ' is-unified' : ''}${props.resizable ? ' is-resizable' : ''}${singleSide ? ' is-single-side' : ''}`} aria-label={props.label}>
      {singleSide !== 'right' ? (
        <CodeEditor
          path={`${props.file.oldPath || props.file.newPath}:left:${unified}`}
          language={detectSourceLanguage(unified ? props.file.newPath || props.file.oldPath : props.file.oldPath) ?? null}
          content={documents.left}
          readOnly
          label={props.label}
          extensions={extensions.left}
          blame={props.blame ? cursorBlame.left : undefined}
          blameLocale={props.blameLocale}
          onView={(view) => {
            views.current.left = view;
          }}
        />
      ) : null}
      {!unified && !singleSide && props.resizable ? <GitPaneSeparator name="diff" label={props.label} initial={50} min={20} max={80} target=".project-git-diff-side-by-side" /> : null}
      {!unified && singleSide !== 'left' ? (
        <CodeEditor
          path={`${props.file.newPath || props.file.oldPath}:right`}
          language={detectSourceLanguage(props.file.newPath) ?? null}
          content={documents.right}
          readOnly
          label={props.label}
          extensions={extensions.right}
          blame={props.blame ? cursorBlame.right : undefined}
          blameLocale={props.blameLocale}
          onView={(view) => {
            views.current.right = view;
          }}
        />
      ) : null}
      {[...gutterPortals.entries.values()].map((portal) => {
        const row = rows[portal.row];
        if (!row) return null;
        /** 统一视图的删除行使用旧版本，其余行使用新版本。 */
        const side = unified ? (row.kind === 'deletion' ? 'left' : 'right') : portal.side;
        const number = row[side === 'left' ? 'leftNumber' : 'rightNumber'];
        /** 空白对齐行和未提交行不显示占位文案。 */
        const blame = number === null ? undefined : blameByLine[side].get(number);
        const attribution = formatDiffBlame(blame);
        return createPortal(
          <>
            {props.blame ? (
              <small className="code-diff-line-blame" data-icon-tooltip={attribution ? `${attribution} · ${blame?.commitHash}` : undefined}>
                {attribution}
              </small>
            ) : null}
            {unified ? (
              <>
                <span>{row.leftNumber ?? ''}</span>
                <span>{row.rightNumber ?? ''}</span>
              </>
            ) : number === null ? null : (
              (props.renderLineNumber?.(number, portal.side) ?? number)
            )}
          </>,
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
    for (let position = range.from; position <= range.to;) {
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
function diffRows(file: TaskGitFileDiff, align: boolean, omitHunkHeaders: boolean): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of file.hunks) {
    if (!omitHunkHeaders) rows.push({ left: hunk.header, right: hunk.header, leftNumber: null, rightNumber: null, kind: 'header' });
    for (let index = 0; index < hunk.lines.length;) {
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
  // 二进制或仅文件模式变化的 diff 没有文本 hunk；CodeMirror 文档仍必须至少有一行。
  if (rows.length === 0) rows.push({ left: '', right: '', leftNumber: null, rightNumber: null, kind: 'empty' });
  return rows;
}

/** 日期固定为年/月/日，时间按用户本机时区显示；未提交行保持空白。 */
function formatDiffBlame(blame: FilePreviewBlameLine | undefined): string {
  if (!blame || /^0+$/u.test(blame.commitHash) || !blame.author || !Number.isFinite(blame.authorTime) || blame.authorTime <= 0) return '';
  /** Unix 秒转换为当前平台的本地日历日期。 */
  const date = new Date(blame.authorTime * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${blame.author}`;
}
