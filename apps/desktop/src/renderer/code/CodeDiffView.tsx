import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { detectSourceLanguage } from '@zeus/shared';
import type { TaskGitFileDiff } from '../session/sessionTypes.js';
import { monaco, initializeSourceEditor, editorLanguage, exposeEditorControl, createTransientSourceModel } from './monacoRuntime.js';
import { loadEditorGrammar } from './monacoGrammars.js';
import { CodeEditor } from './CodeEditor.js';
import { CodeReviewTextContext } from './codeReviewContext.js';
import './codeDiffView.css';

export interface DiffAnnotationLine {
  line: number;
  side: 'left' | 'right';
}
interface DiffRow {
  left: string;
  right: string;
  leftNumber: number | null;
  rightNumber: number | null;
  kind: string;
}
interface CodeDiffViewProps {
  file: TaskGitFileDiff;
  unified?: boolean;
  alignReplacements?: boolean;
  resizable?: boolean;
  omitHunkHeaders?: boolean;
  label: string;
  annotationLines?: DiffAnnotationLine[];
  focusAnnotation?: DiffAnnotationLine;
  renderLineNumber?: (line: number, side: 'left' | 'right') => ReactNode;
  renderLineComments?: (line: number, side: 'left' | 'right') => ReactNode;
}

/** 普通审阅采用原生 Diff；含评论的补丁保留权威行号映射，共用 Monaco 模型和高亮。 */
export const CodeDiffView = memo(function CodeDiffView(props: CodeDiffViewProps) {
  return props.renderLineNumber || props.renderLineComments ? <AnnotatedDiff {...props} /> : <NativeDiff {...props} />;
});

function NativeDiff(props: CodeDiffViewProps) {
  const fullText = useContext(CodeReviewTextContext);
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [error, setError] = useState('');
  const rows = useMemo(() => diffRows(props.file, false, Boolean(props.omitHunkHeaders)), [props.file, props.omitHunkHeaders]);
  const documents = useMemo(() => {
    if (fullText && !props.omitHunkHeaders) return { left: fullText.original, right: fullText.modified, leftNumbers: null, rightNumbers: null };
    const left = rows.filter((row) => row.leftNumber !== null || row.kind === 'header');
    const right = rows.filter((row) => row.rightNumber !== null || row.kind === 'header');
    return { left: left.map((row) => row.left).join('\n'), right: right.map((row) => row.right).join('\n'), leftNumbers: left.map((row) => row.leftNumber), rightNumbers: right.map((row) => row.rightNumber) };
  }, [rows, fullText, props.omitHunkHeaders]);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void initializeSourceEditor()
      .then(async () => {
        await loadEditorGrammar(editorLanguage(props.file.newPath || props.file.oldPath, detectSourceLanguage(props.file.newPath || props.file.oldPath)));
        if (disposed || !host.current) return;
        const language = editorLanguage(props.file.newPath || props.file.oldPath, detectSourceLanguage(props.file.newPath || props.file.oldPath));
        const original = await createTransientSourceModel(documents.left, language);
        const modified = await createTransientSourceModel(documents.right, language).catch((error: unknown) => {
          original.dispose();
          throw error;
        });
        if (disposed || !host.current) {
          original.dispose();
          modified.dispose();
          return;
        }
        const editor = monaco.editor.createDiffEditor(host.current, {
          automaticLayout: true,
          readOnly: true,
          originalEditable: false,
          renderSideBySide: !props.unified,
          enableSplitViewResizing: props.resizable ?? true,
          diffAlgorithm: 'advanced',
          ignoreTrimWhitespace: false,
          renderIndicators: true,
          renderOverviewRuler: true,
          minimap: { enabled: false },
          fontSize: 12,
          lineHeight: 20,
          scrollBeyondLastLine: false,
          ariaLabel: props.label,
          hideUnchangedRegions: { enabled: Boolean(fullText && !props.omitHunkHeaders), contextLineCount: 4, minimumLineCount: 8, revealLineCount: 20 },
          renderSideBySideInlineBreakpoint: 0,
        });
        editor.setModel({ original: original.model, modified: modified.model });
        if (documents.leftNumbers) editor.getOriginalEditor().updateOptions({ lineNumbers: (number) => String(documents.leftNumbers?.[number - 1] ?? '') });
        if (documents.rightNumbers) editor.getModifiedEditor().updateOptions({ lineNumbers: (number) => String(documents.rightNumbers?.[number - 1] ?? '') });
        setView(editor);
        cleanup = () => {
          editor.dispose();
          original.dispose();
          modified.dispose();
        };
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [documents, props.file.newPath, props.file.oldPath]);
  useEffect(() => {
    view?.updateOptions({ renderSideBySide: !props.unified, enableSplitViewResizing: props.resizable ?? true, ariaLabel: props.label });
  }, [view, props.unified, props.resizable, props.label]);
  return (
    <div className="zeus-monaco-diff" aria-label={props.label}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <div className="zeus-diff-navigation" role="group" aria-label="差异导航">
        <button type="button" onClick={() => view?.goToDiff('previous')} aria-label="上一个差异" title="上一个差异">
          ↑
        </button>
        <button type="button" onClick={() => view?.goToDiff('next')} aria-label="下一个差异" title="下一个差异">
          ↓
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

interface LinePortal {
  key: string;
  element: HTMLElement;
  row: number;
  side: 'left' | 'right';
}
interface CommentPortal extends LinePortal {
  body: HTMLElement;
}

/** 评论使用 ViewZone；不会把空白和评论写进源码，也不会随滚动丢失草稿。 */
function AnnotatedDiff(props: CodeDiffViewProps) {
  const rows = useMemo(() => diffRows(props.file, Boolean(props.alignReplacements && !props.unified), Boolean(props.omitHunkHeaders)), [props.file, props.alignReplacements, props.unified, props.omitHunkHeaders]);
  const content = useMemo(
    () => ({
      left: rows.map((row) => (props.unified ? (row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '-' : ' ') + (row.kind === 'deletion' ? row.left : row.right) : row.left)).join('\n'),
      right: rows.map((row) => row.right).join('\n'),
    }),
    [rows, props.unified],
  );
  const [left, setLeft] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [right, setRight] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [linePortals, setLinePortals] = useState<LinePortal[]>([]);
  const commentNodes = useRef(new Map<string, CommentPortal>());
  const comments = useMemo(() => {
    const result: CommentPortal[] = [];
    for (const position of props.annotationLines ?? []) {
      const row = rows.findIndex((item) => item[position.side === 'left' ? 'leftNumber' : 'rightNumber'] === position.line);
      if (row < 0 || result.some((item) => item.row === row && item.side === position.side)) continue;
      const key = props.file.oldPath + ':' + props.file.newPath + ':' + position.side + ':' + position.line;
      let portal = commentNodes.current.get(key);
      if (!portal) {
        const element = document.createElement('div'),
          body = document.createElement('div');
        element.className = 'code-diff-annotation';
        element.append(body);
        portal = { key, element, body, side: position.side, row };
        commentNodes.current.set(key, portal);
      }
      result.push({ ...portal, row });
    }
    const retained = new Set(result.map((portal) => portal.key));
    for (const key of commentNodes.current.keys()) if (!retained.has(key)) commentNodes.current.delete(key);
    return result;
  }, [props.annotationLines, rows, props.file.oldPath, props.file.newPath]);
  useEffect(() => {
    if (!left || (!props.unified && !right)) return;
    const views = props.unified ? [left] : [left, right!];
    let syncing = false,
      frame = 0,
      active = true;
    const disposables: monaco.IDisposable[] = [];
    const widgets: Array<{ view: monaco.editor.IStandaloneCodeEditor; widget: monaco.editor.IGlyphMarginWidget }> = [];
    function renderMargins() {
      frame = 0;
      if (!active) return;
      widgets.splice(0).forEach(({ view, widget }) => view.removeGlyphMarginWidget(widget));
      const portals: LinePortal[] = [];
      views.forEach((view, index) => {
        const side: 'left' | 'right' = index === 0 ? 'left' : 'right';
        for (const visible of view.getVisibleRanges())
          for (let number = visible.startLineNumber; number <= visible.endLineNumber; number++) {
            const row = rows[number - 1];
            if (!row) continue;
            const sides: readonly ('left' | 'right')[] = props.unified ? ['left', 'right'] : [side];
            const element = document.createElement('div');
            element.className = 'zeus-diff-margin';
            for (const current of sides) {
              if (row[current === 'left' ? 'leftNumber' : 'rightNumber'] === null) continue;
              const part = document.createElement('span');
              element.append(part);
              portals.push({ key: side + ':' + current + ':' + number, element: part, row: number - 1, side: current });
            }
            const widget: monaco.editor.IGlyphMarginWidget = {
              getId: () => 'zeus-line-' + number,
              getDomNode: () => element,
              getPosition: () => ({ lane: monaco.editor.GlyphMarginLane.Left, zIndex: 10, range: new monaco.Range(number, 1, number, 1) }),
            };
            view.addGlyphMarginWidget(widget);
            exposeEditorControl(view, element);
            widgets.push({ view, widget });
          }
      });
      setLinePortals(portals);
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(renderMargins);
    };
    views.forEach((view, index) => {
      view.updateOptions({ glyphMargin: true, lineNumbers: 'off', lineDecorationsWidth: props.unified ? 100 : 54, wordWrap: 'off', padding: { top: 0, bottom: 32 } });
      const marks = view.createDecorationsCollection(
        rows.map((row, offset) => {
          const kind = props.unified || row.kind === 'header' ? row.kind : row[index === 0 ? 'leftNumber' : 'rightNumber'] === null ? 'empty' : row.kind === 'replacement' ? (index === 0 ? 'deletion' : 'addition') : row.kind;
          return { range: new monaco.Range(offset + 1, 1, offset + 1, 1), options: { isWholeLine: true, className: 'code-diff-line is-' + kind } };
        }),
      );
      const container = view.getDomNode();
      const copy = (event: ClipboardEvent) => {
        if (props.unified || !view.hasTextFocus() || !event.clipboardData) return;
        const selections = view.getSelections()?.filter((selection) => !selection.isEmpty());
        const model = view.getModel();
        if (!model || !selections?.length) return;
        // 复制时去掉对齐空行与区块标题，保留原文中的空行和首尾选择范围。
        const text = selections
          .map((selection) => {
            const parts: string[] = [];
            for (let line = selection.startLineNumber; line <= selection.endLineNumber; line++) {
              if (rows[line - 1]?.[index === 0 ? 'leftNumber' : 'rightNumber'] == null) continue;
              const content = model.getLineContent(line);
              parts.push(content.slice(line === selection.startLineNumber ? selection.startColumn - 1 : 0, line === selection.endLineNumber ? selection.endColumn - 1 : undefined));
            }
            return parts.join('\n');
          })
          .join('\n');
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      container?.addEventListener('copy', copy, true);
      disposables.push({ dispose: () => container?.removeEventListener('copy', copy, true) });
      disposables.push({ dispose: () => marks.clear() });
      disposables.push(
        view.onDidScrollChange(() => {
          if (!syncing) {
            syncing = true;
            for (const other of views) if (other !== view) other.setScrollTop(view.getScrollTop());
            syncing = false;
          }
          schedule();
        }),
        view.onDidLayoutChange(schedule),
      );
    });
    renderMargins();
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      widgets.forEach(({ view, widget }) => view.removeGlyphMarginWidget(widget));
      disposables.forEach((item) => item.dispose());
    };
  }, [left, right, rows, props.unified]);
  useEffect(() => {
    if (!left || (!props.unified && !right)) return;
    const zones: Array<{ view: monaco.editor.IStandaloneCodeEditor; id: string; row: number; node: HTMLElement; height: number }> = [];
    const views = props.unified ? [left] : [left, right!];
    const rowIds = [...new Set(comments.map((comment) => comment.row))];
    for (const row of rowIds)
      views.forEach((view, index) => {
        const node = document.createElement('div');
        node.className = 'code-diff-annotation';
        comments.filter((item) => item.row === row && (props.unified || item.side === (index === 0 ? 'left' : 'right'))).forEach((item) => node.append(item.element));
        view.changeViewZones((accessor) => {
          zones.push({ view, row, node, height: 1, id: accessor.addZone({ afterLineNumber: row + 1, heightInPx: 1, domNode: node, suppressMouseDown: false }) });
          exposeEditorControl(view, node);
        });
      });
    const resize = new ResizeObserver(() => {
      for (const row of rowIds) {
        const pair = zones.filter((zone) => zone.row === row);
        const height = Math.max(1, ...pair.map((zone) => [...zone.node.children].reduce((sum, node) => sum + node.getBoundingClientRect().height, 0)));
        for (const zone of pair) {
          if (zone.height === height) continue;
          zone.height = height;
          zone.view.changeViewZones((accessor) => {
            accessor.removeZone(zone.id);
            zone.id = accessor.addZone({ afterLineNumber: zone.row + 1, heightInPx: height, domNode: zone.node, suppressMouseDown: false });
          });
        }
      }
    });
    comments.forEach((comment) => resize.observe(comment.body));
    return () => {
      resize.disconnect();
      zones.forEach((zone) => zone.view.changeViewZones((accessor) => accessor.removeZone(zone.id)));
    };
  }, [left, right, comments, props.unified]);
  useEffect(() => {
    const target = props.focusAnnotation;
    if (!target) return;
    const comment = comments.find((item) => item.side === target.side && rows[item.row]?.[target.side === 'left' ? 'leftNumber' : 'rightNumber'] === target.line);
    if (!comment) return;
    const view = props.unified || target.side === 'left' ? left : right;
    view?.revealLineInCenter(comment.row + 1);
    const frame = requestAnimationFrame(() => comment.body.querySelector('textarea')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [props.focusAnnotation, comments, rows, left, right, props.unified]);
  return (
    <div className={'code-diff-view' + (props.unified ? ' is-unified' : '')} aria-label={props.label}>
      <CodeEditor path={props.file.oldPath + ':review-left'} language={detectSourceLanguage(props.file.oldPath || props.file.newPath)} content={content.left} readOnly onView={setLeft} />
      {!props.unified ? <CodeEditor path={props.file.newPath + ':review-right'} language={detectSourceLanguage(props.file.newPath)} content={content.right} readOnly onView={setRight} /> : null}
      {linePortals.map((portal) => {
        const number = rows[portal.row]?.[portal.side === 'left' ? 'leftNumber' : 'rightNumber'];
        return createPortal(number == null ? null : (props.renderLineNumber?.(number, portal.side) ?? number), portal.element, portal.key);
      })}
      {comments.map((portal) => {
        const number = rows[portal.row]?.[portal.side === 'left' ? 'leftNumber' : 'rightNumber'];
        return createPortal(number == null ? null : props.renderLineComments?.(number, portal.side), portal.body, portal.key);
      })}
    </div>
  );
}

/** 将补丁转换成左右显示行；不截断，完整内容可滚动和复制。 */
function diffRows(file: TaskGitFileDiff, align: boolean, omitHunkHeaders: boolean): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of file.hunks) {
    if (!omitHunkHeaders) rows.push({ left: hunk.header, right: hunk.header, leftNumber: null, rightNumber: null, kind: 'header' });
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
  // 二进制或仅文件模式变化的 diff 没有文本 hunk；编辑器文档仍必须至少有一行。
  if (rows.length === 0) rows.push({ left: '', right: '', leftNumber: null, rightNumber: null, kind: 'empty' });
  return rows;
}
