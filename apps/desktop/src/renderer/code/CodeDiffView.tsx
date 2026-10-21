import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { diffWordsWithSpace } from 'diff';
import { ModalPortal } from '../ui/ModalPortal.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { createPortal } from 'react-dom';
import { detectSourceLanguage, type FilePreviewBlameLine, type FilePreviewChangeRange } from '@zeus/shared';
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, gutterLineClass, gutterWidgetClass, type ViewUpdate } from '@codemirror/view';
import { Text, Prec, RangeSet, type Extension } from '@codemirror/state';
import type { TaskGitFileDiff } from '../session/sessionTypes.js';
import { GitPaneSeparator } from '../git/GitPaneSeparator.js';
import { CodeEditor } from './CodeEditor.js';
import { CommentWidget } from './SourceCodePreview.js';
import './codeDiffView.css';
import { FilePreviewDataContext } from './FilePreview.js';
import { fullFileDiff, normalizedFileLine, refreshedFileDiff } from './fullFileDiff.js';
import { useGitBlame } from './useGitBlame.js';
import type { GitBlameLine } from '../features/git/gitContracts.js';
import { diffAlignmentExtension, AlignmentSpace } from './conflictAlignment.js';
import { EditableCodeDiffView } from './EditableCodeDiffView.js';
import { DiffReviewToolbar } from './DiffReviewToolbar.js';
import { DiffConnectorLayer } from './DiffConnectorLayer.js';

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
  /** 连续改动身份用于两栏色带衔接，不参与文件正文。 */
  block?: number;
  /** 区块语义底色；修改块只给真实内容铺蓝色，空侧由连接带表达。 */
  tone?: 'addition' | 'deletion' | 'replacement';
  /** 只在每个独立改动的首行保存恢复坐标。 */
  change?: FilePreviewChangeRange;
  /** 配对修改行中实际变化的字词范围。 */
  words?: () => DiffWordRanges;
  /** 折叠行只标识省略范围，不伪造源码行号。 */
  folded?: { key: string; count: number; unavailable?: boolean };
}
/** 字词偏移按各自原始文本计算，不含行号和显示补位。 */
interface DiffWordRanges {
  left: Array<[number, number]>;
  right: Array<[number, number]>;
}
/** 当前可见行号的 React 门户容器。 */
interface GutterPortal {
  element: HTMLElement;
  row: number;
  side: 'left' | 'right';
  /** 恢复轨道与行号轨道各自拥有可见节点。 */
  action?: boolean;
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
export interface CodeDiffViewProps {
  /** 已解析的补丁，只在文件内容变化时转换一次。 */
  file: TaskGitFileDiff;
  /** 统一视图按行底色区分增删，保留两侧原始行号。 */
  unified?: boolean;
  /** 新增或删除文件只挂载实际存在的一侧，保留原始行号和评论身份。 */
  singleSide?: 'left' | 'right';
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
  /** 外部 Git 操作进行中禁止区块恢复。 */
  revertDisabled?: boolean;
  /** 可见行号支持现有评论、范围选择和打开源码操作。 */
  renderLineNumber?: (line: number, side: 'left' | 'right') => ReactNode;
  /** React 继续管理评论编辑，不随代码行滚出而卸载。 */
  renderLineComments?: (line: number, side: 'left' | 'right') => ReactNode;
}

/** 差异全文存于编辑器文档，页面节点只覆盖可视区域。 */
export const CodeDiffView = memo(function CodeDiffView(props: CodeDiffViewProps) {
  /** 当前工作区有完整两端时使用真实正文编辑；只读证据继续使用原有差异投影。 */
  const preview = useContext(FilePreviewDataContext);
  const editable = preview?.editing?.writable && preview.items?.length === 2 && preview.items.every((item) => item.missing || (item.kind === 'text' && !item.truncated));
  return editable ? <EditableCodeDiffView {...props} /> : <ReadonlyCodeDiffView {...props} />;
});

/** 纯补丁、暂存版本和历史快照保持原有只读浏览及评论语义。 */
const ReadonlyCodeDiffView = memo(function ReadonlyCodeDiffView(props: CodeDiffViewProps) {
  /** 所有差异入口共享已有文件读取，版本切换不会重新授权。 */
  const preview = useContext(FilePreviewDataContext);
  /** 本页恢复后的补丁绑定新正文，避免等待外部工作区列表刷新。 */
  const original = useMemo(() => refreshedFileDiff(props.file, preview?.items ?? null, preview?.reverted), [props.file, preview?.items, preview?.reverted]);
  /** 确认操作绑定当时的两端令牌，预览变化后不再执行旧坐标。 */
  const [pending, setPending] = useState<{ range: FilePreviewChangeRange; items: unknown } | null>(null);
  /** 同一预览只允许一个在途恢复请求。 */
  const [reverting, setReverting] = useState(false);
  /** 写入失败留在原确认界面，不自动重放。 */
  const [revertError, setRevertError] = useState<unknown>(null);
  /** 关闭确认后回到触发箭头；恢复后箭头消失则回到当前代码栏。 */
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  /** 校验完整两端一次，范围切换只改变显示行。 */
  const complete = useMemo(() => (preview?.items ? fullFileDiff(original, preview.items) : null), [original, preview?.items]);
  /** 没有外层预览的快照也复用布局操作，但不能假装有全文。 */
  const [localUnified, setLocalUnified] = useState(Boolean(props.unified));
  /** 局部展开只作用于当前文件，不影响全局显示范围。 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** 导航序号只用于当前连续差异编辑器。 */
  const [currentChange, setCurrentChange] = useState(-1);
  /** 明确区分可用全文与用户当前选择。 */
  const full = Boolean(preview?.full && complete);
  /** 全文与片段均保留原始增删身份。 */
  const file = complete ?? original;
  useEffect(() => {
    setExpanded(new Set());
    setCurrentChange(-1);
  }, [props.file, preview?.full]);
  /** 左右归属分别绑定实际版本，索引和工作区不共用 HEAD 行号。 */
  const leftBlame = useGitBlame({ previewId: props.blame || preview?.items?.[0]?.blame !== undefined || preview?.items?.[0]?.blameError ? undefined : preview?.items?.[0]?.id });
  const rightBlame = useGitBlame({ previewId: props.blame || preview?.items?.[1]?.blame !== undefined || preview?.items?.[1]?.blameError ? undefined : preview?.items?.[1]?.id });
  /** 所有入口对新增、删除文件只显示有效侧，不留空白旧行号列。 */
  const singleSide = props.singleSide ?? (props.file.changeType === 'added' ? 'right' : props.file.changeType === 'deleted' ? 'left' : undefined);
  /** 两侧均存在时才需要统一视图的双行号。 */
  const unified = Boolean((preview?.unified ?? localUnified) && !singleSide);
  /** 先生成准确的连续行，再按差异和评论保留上下文。 */
  const allRows = useMemo(() => diffRows(file, !unified, true), [file, unified]);
  /** 恢复能力只对核对成功的当前工作区开放，统一视图也沿用右侧写入语义。 */
  const canRevert = Boolean(complete && preview?.onRevert && !singleSide);
  /** 三行上下文之外使用可展开分隔线，评论与定位目标始终可见。 */
  const rows = useMemo(
    () => (full ? allRows : collapseContextRows(allRows, expanded, [...(props.annotationLines ?? []), ...(props.revealLine ? [props.revealLine] : [])])),
    [allRows, full, expanded, props.annotationLines, props.revealLine],
  );
  /** 连续增删行算一处差异，片段中的多个改动仍可逐一定位。 */
  const changes = useMemo(() => rows.flatMap((row, index) => (isChangedRow(row) && !isChangedRow(rows[index - 1]) ? [index] : [])), [rows]);
  /** 恢复减少改动后，箭头与可见序号使用同一有效范围。 */
  const visibleChange = Math.min(currentChange, changes.length - 1);
  /** 显示行包含片段头与补位，作者必须按各侧原始行号映射。 */
  const authors = useMemo(() => {
    /** 稀疏数组让补位行显示无归属，而不冒用邻行作者。 */
    const result = { left: new Array<GitBlameLine>(rows.length), right: new Array<GitBlameLine>(rows.length) };
    /** Git 返回的一基行号与文件行直接匹配。 */
    const left = new Map((props.blame?.left ?? preview?.items?.[0]?.blame ?? leftBlame?.lines)?.map((line) => [line.line, line]));
    const right = new Map((props.blame?.right ?? preview?.items?.[1]?.blame ?? rightBlame?.lines)?.map((line) => [line.line, line]));
    /** 补丁与文件分开读取时，内容不匹配的行不展示可能错位的提交人。 */
    const leftContent = preview?.items?.[0]?.content?.split('\n').map((line, index) => normalizedFileLine(line, index + 1));
    const rightContent = preview?.items?.[1]?.content?.split('\n').map((line, index) => normalizedFileLine(line, index + 1));
    rows.forEach((row, index) => {
      /** 片段头、补位和过期行不对应可核实的文件内容。 */
      const validLeft = row.leftNumber !== null && (!preview?.items || leftContent?.[row.leftNumber - 1] === row.left);
      const validRight = row.rightNumber !== null && (!preview?.items || rightContent?.[row.rightNumber - 1] === row.right);
      /** 统一视图中删除行来自左侧，其余来自右侧。 */
      const before = unified && row.kind !== 'deletion' ? validRight && right.get(row.rightNumber ?? 0) : validLeft && left.get(row.leftNumber ?? 0);
      const after = validRight && right.get(row.rightNumber ?? 0);
      if (before) result.left[index] = before;
      if (after) result.right[index] = after;
    });
    return result;
  }, [rows, props.blame, leftBlame, rightBlame, unified, preview?.items]);
  /** 显示行包含补位，行尾详情按显示位置读取，不能再按原文件行号建立索引。 */
  const cursorBlame = useMemo(() => ({ left: (line: number) => authors.left[line - 1], right: (line: number) => authors.right[line - 1] }), [authors]);
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
  /** 两个编辑器共用纵向位置，横向保持独立。 */
  const views = useRef<{ left: EditorView | null; right: EditorView | null }>({ left: null, right: null });
  useEffect(() => {
    if (pending || !returnFocus.current) return;
    /** 等确认门户从文档移除后恢复焦点，避免 React 删除按钮时再次清空焦点。 */
    const trigger = returnFocus.current;
    returnFocus.current = null;
    queueMicrotask(() => {
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
      else (views.current.right ?? views.current.left)?.focus();
    });
  }, [pending]);
  useEffect(() => {
    if (!props.revealLine) return;
    /** 左右视图使用同一显示行，删除行也能准确定位。 */
    const row = positions.get(`${props.revealLine.side}:${props.revealLine.line}`);
    const view = views.current.left ?? views.current.right;
    if (row !== undefined && view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(row + 1).from, { y: 'center' }) });
  }, [props.revealLine, positions]);
  /** 文档行变化后释放旧补白，同一显示文档两栏共用对齐身份。 */
  const alignment = useMemo(() => ({}), [rows]);
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
      !unified && !singleSide
        ? diffAlignmentExtension(
            alignment,
            rows.map((row) => (row.tone && row.tone !== 'replacement' ? `code-diff-alignment is-${row.tone}` : '')),
          )
        : [],
      gutterWidgetClass.of((_view, widget, block) => {
        /** 纯增删补白覆盖行号轨道；修改补白、评论和折叠保持原背景。 */
        const tone = rows[documents[side].lineAt(block.from).number - 1]?.tone;
        return widget instanceof AlignmentSpace && tone && tone !== 'replacement' ? new DiffToneMarker(tone) : null;
      }),
      gutterLineClass.of(RangeSet.of(rows.flatMap((row, index) => (row.tone && visibleRowTone(row, side, unified) !== 'context' ? [new DiffToneMarker(row.tone).range(documents[side].line(index + 1).from)] : [])))),
      canRevert && (side === 'right' || unified) ? Prec.high(gutter({ class: 'code-diff-revert-gutter', lineMarker: (view, line) => new DiffGutterMarker(view.state.doc.lineAt(line.from).number - 1, side, gutterPortals, true) })) : [],
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
          rows.flatMap((row, index) => {
            if (!row.folded) return [];
            /** 两侧使用同一个折叠身份，展开后重新对齐。 */
            const line = documents[side].line(index + 1);
            return [Decoration.replace({ widget: new DiffFoldWidget(row.folded, preview?.zh !== false, () => setExpanded((current) => new Set(current).add(row.folded!.key))), block: true }).range(line.from, line.to)];
          }),
          true,
        ),
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
  }, [rows, pairs, documents, unified, singleSide, gutterPortals, alignment, preview?.zh, canRevert]);

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

  /** 只定位本编辑器中的真实改动，不修改文件选择或片段操作范围。 */
  function navigateChange(direction: -1 | 1): void {
    /** 无差异和边界状态没有循环跳转。 */
    const next = Math.max(0, Math.min(changes.length - 1, visibleChange + direction));
    /** 差异索引映射到当前范围内的显示行。 */
    const row = changes[next];
    if (row === undefined) return;
    setCurrentChange(next);
    for (const view of [views.current.left, views.current.right]) {
      if (!view) continue;
      /** 滚动目标使用显示行，原始行号继续由左右 gutter 保留。 */
      const position = view.state.doc.line(row + 1).from;
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
    }
  }
  /** 控件优先进入已有标题行，纯快照在自身顶部显示同一工具栏。 */
  const toolbar = (
    <DiffReviewToolbar
      zh={preview?.zh !== false}
      full={full}
      fullAvailable={Boolean(complete)}
      onFullChange={(value) => {
        setExpanded(new Set());
        preview?.onFullChange(value);
      }}
      current={visibleChange}
      count={changes.length}
      onNavigate={navigateChange}
      unified={unified}
      allowLayout={!singleSide}
      onUnifiedChange={preview?.onUnifiedChange ?? setLocalUnified}
      onPreview={preview?.onPreview}
      onRefresh={preview?.onRefresh}
    />
  );
  if ((preview?.full || preview?.reverted) && !complete) return <p role="status">{preview.zh ? '差异与文件内容不一致，请刷新差异后重试。' : 'The diff no longer matches the file contents. Refresh the diff and retry.'}</p>;
  return (
    <div className="code-diff-container">
      {pending ? (
        <ModalPortal
          role="alertdialog"
          aria-label={preview?.zh === false ? 'Revert change' : '恢复此处改动'}
          onDismiss={() => {
            if (!reverting) setPending(null);
          }}
          dismissDisabled={reverting}
        >
          <section className="code-diff-revert-dialog" data-modal-surface="dialog">
            <strong>{preview?.zh === false ? 'Restore this change from the left version?' : '将此处改动恢复为左侧版本？'}</strong>
            <p>
              {original.newPath || original.oldPath} ·{' '}
              {preview?.zh === false
                ? `Current lines ${pending.range.newStart + 1}–${pending.range.newStart + Math.max(1, pending.range.newLines)}`
                : `工作区第 ${pending.range.newStart + 1}–${pending.range.newStart + Math.max(1, pending.range.newLines)} 行`}
            </p>
            <p>
              {preview?.zh === false
                ? 'Only this block in the working file will change. Other changes and the index stay unchanged. This view cannot undo the write.'
                : '只修改当前工作区文件的这个区块，保留其他改动和暂存区内容。此视图无法撤销这次写入。'}
            </p>
            {pending.items !== preview?.items ? <p role="status">{preview?.zh === false ? 'The preview changed. Cancel and select the change again.' : '文件已刷新，请取消后重新选择改动。'}</p> : null}
            {revertError ? <VisibleApplicationError error={revertError} language={preview?.zh === false ? 'en' : 'zh-CN'} /> : null}
            <footer>
              <button type="button" disabled={reverting} onClick={() => setPending(null)}>
                {preview?.zh === false ? 'Cancel' : '取消'}
              </button>
              <button
                type="button"
                disabled={reverting || props.revertDisabled || Boolean(revertError) || pending.items !== preview?.items}
                onClick={() => {
                  if (!preview?.onRevert || reverting || pending.items !== preview.items) return;
                  setReverting(true);
                  void preview
                    .onRevert(pending.range)
                    .then(() => setPending(null))
                    .catch(setRevertError)
                    .finally(() => setReverting(false));
                }}
              >
                {reverting ? (preview?.zh === false ? 'Restoring…' : '正在恢复…') : preview?.zh === false ? 'Restore block' : '恢复区块'}
              </button>
            </footer>
          </section>
        </ModalPortal>
      ) : null}
      {preview?.toolbarTarget ? createPortal(toolbar, preview.toolbarTarget) : toolbar}
      <div className={`code-diff-view${unified ? ' is-unified' : ''}${props.resizable ? ' is-resizable' : ''}${singleSide ? ' is-single-side' : ''}`} aria-label={props.label}>
        {!unified && !singleSide ? <DiffConnectorLayer /> : null}
        {singleSide !== 'right' ? (
          <CodeEditor
            path={`${props.file.oldPath || props.file.newPath}:left:${unified}`}
            language={detectSourceLanguage(unified ? props.file.newPath || props.file.oldPath : props.file.oldPath) ?? null}
            content={documents.left}
            readOnly
            blameLines={authors.left}
            locale={preview?.zh === false ? 'en-US' : 'zh-CN'}
            label={props.label}
            extensions={extensions.left}
            blame={cursorBlame.left}
            blameLocale={props.blameLocale}
            onView={(view) => {
              views.current.left = view;
              exposeDiffGutters(view);
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
            blameLines={authors.right}
            locale={preview?.zh === false ? 'en-US' : 'zh-CN'}
            label={props.label}
            extensions={extensions.right}
            blame={cursorBlame.right}
            blameLocale={props.blameLocale}
            onView={(view) => {
              views.current.right = view;
              exposeDiffGutters(view);
            }}
          />
        ) : null}
        {[...gutterPortals.entries.values()].map((portal) => {
          const row = rows[portal.row];
          if (!row) return null;
          if (portal.action)
            return createPortal(
              row.change ? (
                <button
                  type="button"
                  className="code-diff-revert"
                  disabled={reverting || props.revertDisabled}
                  aria-label={preview?.zh === false ? 'Revert this change to the left version' : '将此处改动恢复为左侧版本'}
                  data-icon-tooltip={preview?.zh === false ? 'Revert this change to the left version' : '将此处改动恢复为左侧版本'}
                  onClick={(event) => {
                    returnFocus.current = event.currentTarget;
                    setRevertError(null);
                    setPending({ range: row.change!, items: preview?.items });
                  }}
                >
                  <span className="code-diff-revert-icon" aria-hidden="true" />
                </button>
              ) : null,
              portal.element,
              `revert:${portal.row}`,
            );
          /** 统一视图的删除行使用旧版本，其余行使用新版本。 */
          const side = unified ? (row.kind === 'deletion' ? 'left' : 'right') : portal.side;
          const number = row[side === 'left' ? 'leftNumber' : 'rightNumber'];
          return createPortal(
            <>
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
    private readonly action = false,
  ) {
    super();
  }
  /** 未变化的可见行号不重新挂载。 */
  eq(other: DiffGutterMarker): boolean {
    return this.row === other.row && this.side === other.side && this.registry === other.registry && this.action === other.action;
  }
  /** 创建用于行号和操作按钮的容器。 */
  toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = this.action ? 'code-diff-revert-slot' : 'code-diff-line-number';
    this.registry.entries.set(element, { element, row: this.row, side: this.side, action: this.action });
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
      /** 新增和删除的补位继续着色；修改区块只给真实行着色，由中缝连接不同高度。 */
      const kind = visibleRowTone(row, side, unified);
      decorations.push(
        Decoration.line({
          attributes: {
            class: `code-diff-line is-${kind}`,
            'data-diff-row': String(line.number),
            'data-diff-block': row?.block === undefined || kind === 'context' ? '' : String(row.block),
            'data-file-line': String(row?.[side === 'left' ? 'leftNumber' : 'rightNumber'] ?? ''),
          },
        }).range(line.from),
      );
      /** 行内范围已在行模型生成时计算，不随滚动重复比对。 */
      const wordSide = unified && row?.kind !== 'deletion' ? 'right' : side;
      for (const [from, to] of row?.words?.()?.[wordSide] ?? [])
        if (to > from && to <= line.length) decorations.push(Decoration.mark({ class: `code-diff-word is-${wordSide === 'left' ? 'deletion' : 'addition'}` }).range(line.from + from, line.from + to));
      position = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}

/** 修改区块的空侧不铺蓝色，统一视图中的真实增删行仍保留修改语义。 */
function visibleRowTone(row: DiffRow | undefined, side: 'left' | 'right', unified: boolean): string | undefined {
  if (!unified && row?.tone === 'replacement' && row[side === 'left' ? 'leftNumber' : 'rightNumber'] === null) return 'context';
  return row?.tone ?? row?.kind;
}

/** 将补丁转换成左右显示行；不截断，完整内容可滚动和复制。 */
function diffRows(file: TaskGitFileDiff, align: boolean, omitHunkHeaders: boolean): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    /** 片段快照也显示省略边界，但没有授权正文时不提供假展开。 */
    const previous = file.hunks[hunkIndex - 1];
    /** 左右省略长度同时约束可确认的上下文范围。 */
    const oldGap = hunk.oldStart - (previous ? previous.oldStart + previous.oldLines : 1);
    /** 新侧保留独立原始行号。 */
    const newGap = hunk.newStart - (previous ? previous.newStart + previous.newLines : 1);
    /** 只展示两侧都确认省略的行数。 */
    const gap = Math.max(0, Math.min(oldGap, newGap));
    if (gap) rows.push({ left: '…', right: '…', leftNumber: null, rightNumber: null, kind: 'fold', folded: { key: `snapshot:${hunk.oldStart}:${hunk.newStart}`, count: gap, unavailable: true } });
    if (!omitHunkHeaders) rows.push({ left: hunk.header, right: hunk.header, leftNumber: null, rightNumber: null, kind: 'header' });
    /** 两端游标随正文单次推进，避免大量小区块重复扫描前文。 */
    let oldCursor = hunk.oldStart + (hunk.oldLines === 0 ? 0 : -1);
    let newCursor = hunk.newStart + (hunk.newLines === 0 ? 0 : -1);
    for (let index = 0; index < hunk.lines.length;) {
      const line = hunk.lines[index]!;
      if (line.type === 'deletion' || line.type === 'addition') {
        /** 区块以连续增删为边界，不能用含多个改动的整个 Git hunk 代替。 */
        const deleted: typeof hunk.lines = [];
        const added: typeof hunk.lines = [];
        const oldStart = oldCursor;
        const newStart = newCursor;
        while (index < hunk.lines.length && ['deletion', 'addition', 'metadata'].includes(hunk.lines[index]!.type)) {
          const changed = hunk.lines[index++]!;
          if (changed.type !== 'metadata') (changed.type === 'deletion' ? deleted : added).push(changed);
          if (changed.oldLineNumber !== null) oldCursor += 1;
          if (changed.newLineNumber !== null) newCursor += 1;
        }
        const tone = deleted.length && added.length ? 'replacement' : deleted.length ? 'deletion' : 'addition';
        const change = { oldStart, newStart, oldLines: deleted.length, newLines: added.length };
        const first = rows.length;
        /** 修改区块整体蓝色，配对行的字词另用更深的增删颜色。 */
        const words = deleted.map((before, offset) =>
          added[offset] ? lazyChangedWords(normalizedFileLine(before.content, before.oldLineNumber ?? 0), normalizedFileLine(added[offset]!.content, added[offset]!.newLineNumber ?? 0)) : undefined,
        );
        if (align)
          for (let offset = 0; offset < Math.max(deleted.length, added.length); offset += 1) {
            rows.push({
              left: deleted[offset]?.content ?? '',
              right: added[offset]?.content ?? '',
              leftNumber: deleted[offset]?.oldLineNumber ?? null,
              rightNumber: added[offset]?.newLineNumber ?? null,
              kind: deleted[offset] && added[offset] ? 'replacement' : deleted[offset] ? 'deletion' : 'addition',
              tone,
              block: first,
              words: words[offset],
            });
          }
        else {
          deleted.forEach((item, offset) => rows.push({ left: item.content, right: '', leftNumber: item.oldLineNumber, rightNumber: null, kind: 'deletion', tone, block: first, words: words[offset] }));
          added.forEach((item, offset) => rows.push({ left: '', right: item.content, leftNumber: null, rightNumber: item.newLineNumber, kind: 'addition', tone, block: first, words: words[offset] }));
        }
        rows[first]!.change = change;
      } else {
        rows.push({ left: line.content, right: line.content, leftNumber: line.oldLineNumber, rightNumber: line.newLineNumber, kind: line.type });
        if (line.oldLineNumber !== null) oldCursor += 1;
        if (line.newLineNumber !== null) newCursor += 1;
        index += 1;
      }
    }
  }
  // 二进制或仅文件模式变化的 diff 没有文本 hunk；CodeMirror 文档仍必须至少有一行。
  if (rows.length === 0) rows.push({ left: '', right: '', leftNumber: null, rightNumber: null, kind: 'empty' });
  return rows.map((row) => ({ ...row, left: normalizedFileLine(row.left, row.leftNumber ?? 0), right: normalizedFileLine(row.right, row.rightNumber ?? 0) }));
}

/** 增删和配对替换都属于可导航的真实差异。 */
function isChangedRow(row: DiffRow | undefined): boolean {
  return Boolean(row && ['addition', 'deletion', 'replacement'].includes(row.kind));
}

/** 未改动片段折叠成单行，保留差异、评论前后三行。 */
function collapseContextRows(rows: DiffRow[], expanded: Set<string>, annotations: DiffAnnotationLine[]): DiffRow[] {
  /** 索引只针对当前文件快照，原始行号不会重新编号。 */
  const visible = new Set<number>();
  /** 评论查找按原始行身份索引，避免长文件逐行扫描全部评论。 */
  const annotated = new Set(annotations.map((position) => `${position.side}:${position.line}`));
  rows.forEach((row, index) => {
    if (isChangedRow(row) || annotated.has(`left:${row.leftNumber}`) || annotated.has(`right:${row.rightNumber}`)) {
      for (let neighbor = Math.max(0, index - 3); neighbor <= Math.min(rows.length - 1, index + 3); neighbor += 1) visible.add(neighbor);
    }
  });
  /** 折叠只处理未修改行，不隐藏补丁元信息。 */
  const result: DiffRow[] = [];
  for (let index = 0; index < rows.length;) {
    if (visible.has(index) || rows[index]!.kind !== 'context') {
      result.push(rows[index++]!);
      continue;
    }
    /** 每个连续未修改区间具有稳定的本地展开身份。 */
    const start = index;
    while (index < rows.length && !visible.has(index) && rows[index]!.kind === 'context') index += 1;
    /** 当前文件中该区间的起止显示行组成展开键。 */
    const key = `${start}:${index}`;
    if (index - start < 4 || expanded.has(key)) result.push(...rows.slice(start, index));
    else result.push({ left: '…', right: '…', leftNumber: null, rightNumber: null, kind: 'fold', folded: { key, count: index - start } });
  }
  return result;
}

/** 折叠提示采用轻量波浪边界，两侧按钮都能展开同一片段。 */
class DiffFoldWidget extends WidgetType {
  /** 文案和回调属于当前文件，不读取编辑器外的路径。 */
  constructor(
    private readonly folded: { key: string; count: number; unavailable?: boolean },
    private readonly zh: boolean,
    private readonly expand: () => void,
  ) {
    super();
  }
  /** 虚拟行高与实际波浪线保持一致。 */
  get estimatedHeight(): number {
    return 8;
  }
  /** 每次行列表更新都替换回调，避免展开到旧文件。 */
  toDOM(view: EditorView): HTMLElement {
    /** 原生按钮提供焦点和键盘激活。 */
    const button = view.dom.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'code-diff-fold';
    /** 行数仅用于悬停和读屏，正文不再显示整行说明。 */
    const label = this.folded.unavailable
      ? this.zh
        ? `已省略 ${this.folded.count} 行，快照未包含原文`
        : `${this.folded.count} lines omitted from snapshot`
      : this.zh
        ? `展开 ${this.folded.count} 行未修改内容`
        : `Expand ${this.folded.count} unchanged lines`;
    button.disabled = Boolean(this.folded.unavailable);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', this.expand);
    return button;
  }
  /** 按钮自行处理事件，编辑器不会把点击视为源码选择。 */
  ignoreEvent(): boolean {
    return true;
  }
}

/** 统一行号、提交人和恢复轨道的区块底色。 */
class DiffToneMarker extends GutterMarker {
  /** 底色仅取共享区块分类，不接受任意 CSS。 */
  constructor(private readonly tone: string) {
    super();
    this.elementClass = `code-diff-tone is-${tone}`;
  }
  /** 行号轨道与正文使用同一区块分类。 */
  elementClass: string;
  /** 相同分类复用原行号节点。 */
  eq(other: DiffToneMarker): boolean {
    return this.tone === other.tone;
  }
}

/** 有界字词比较只处理配对修改行，保留语法高亮和鼠标选区。 */
function changedWords(before: string, after: string): DiffWordRanges {
  /** 两侧分别累计 UTF-16 字符偏移，与 CodeMirror 文档一致。 */
  const result: DiffWordRanges = { left: [], right: [] };
  const parts = before.length + after.length <= 16000 ? diffWordsWithSpace(before, after, { timeout: 5, maxEditLength: 500 }) : undefined;
  if (!parts) return result;
  let left = 0;
  let right = 0;
  for (const part of parts) {
    if (part.removed) result.left.push([left, left + part.value.length]);
    if (part.added) result.right.push([right, right + part.value.length]);
    if (!part.added) left += part.value.length;
    if (!part.removed) right += part.value.length;
  }
  return result;
}

/** 配对行首次进入可见区域才计算字词，左右两栏复用同一结果。 */
function lazyChangedWords(before: string, after: string): () => DiffWordRanges {
  /** 缓存只属于当前行模型，换文件或正文更新时自然释放。 */
  let cached: DiffWordRanges | undefined;
  return () => (cached ??= changedWords(before, after));
}

/** 差异行号包含可聚焦的恢复和评论按钮，不能继承 CodeMirror 的装饰性隐藏标记。 */
function exposeDiffGutters(view: EditorView | null): void {
  view?.dom.querySelectorAll('.cm-gutters').forEach((element) => element.removeAttribute('aria-hidden'));
}
