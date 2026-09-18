import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { detectSourceLanguage } from '@zeus/shared';
import type { ConflictBlock, ConflictSide, ConflictSideState } from '../task/taskConflictModel.js';
import { CodeEditor, type CodeTextChange } from './CodeEditor.js';
import { monaco, exposeEditorControl } from './monacoRuntime.js';
import { attachConflictAlignment } from './monacoConflictAlignment.js';

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
  /** 三栏共用的布局身份，显示空白不进入草稿。 */
  alignment: object;
}

/** 三栏继续操作权威冲突模型，Monaco 只负责编辑、选择、装饰和滚动。 */
export const ConflictCodeEditor = memo(function ConflictCodeEditor(props: ConflictCodeEditorProps) {
  const current = useRef(props);
  current.current = props;
  const [view, setView] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
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
  useEffect(() => {
    if (!view) return;
    const model = view.getModel();
    if (!model) return;
    const decorations = view.createDecorationsCollection(
      regions.map((region) => {
        const start = model.getPositionAt(region.from),
          end = model.getPositionAt(region.to);
        const last = end.column === 1 && end.lineNumber > start.lineNumber ? new monaco.Position(end.lineNumber - 1, model.getLineMaxColumn(end.lineNumber - 1)) : end;
        return { range: monaco.Range.fromPositions(start, last), options: { isWholeLine: true, className: region.block.status === 'pending' ? 'source-conflict-incoming' : 'source-conflict-current' } };
      }),
    );
    if (props.range) decorations.append([{ range: new monaco.Range(props.range.from + 1, 1, Math.max(props.range.from + 1, props.range.to), 1), options: { isWholeLine: true, className: 'source-conflict-incoming' } }]);
    const widgets: monaco.editor.IGlyphMarginWidget[] = [];
    if (props.side)
      for (const region of regions) {
        const side = props.side,
          block = region.block;
        const body = document.createElement('div');
        body.className = 'zeus-conflict-actions';
        const state = side === 'source' ? block.sourceState : block.taskState;
        for (const action of ['accepted', 'ignored'] as const) {
          const button = document.createElement('button');
          button.type = 'button';
          button.disabled = Boolean(props.actionsDisabled);
          button.textContent = action === 'ignored' ? '×' : side === 'source' ? '→' : '←';
          button.className = 'is-' + action;
          button.setAttribute('aria-pressed', String(state === action));
          button.title = props.zh ? (action === 'accepted' ? '选入' : '移除') + (side === 'source' ? '来源分支' : '任务分支') + '的此处修改' : (action === 'accepted' ? 'Include ' : 'Exclude ') + side + ' change';
          button.setAttribute('aria-label', button.title);
          button.onclick = () => current.current.onSideAction?.(block, side, action);
          body.append(button);
        }
        const widget: monaco.editor.IGlyphMarginWidget = {
          getId: () => 'conflict-' + block.id,
          getDomNode: () => body,
          getPosition: () => ({ range: monaco.Range.fromPositions(model.getPositionAt(region.from)), lane: monaco.editor.GlyphMarginLane.Left, zIndex: 10 }),
        };
        view.addGlyphMarginWidget(widget);
        exposeEditorControl(view, body);
        widgets.push(widget);
      }
    const alignment = attachConflictAlignment(props.alignment, view, regions);
    return () => {
      alignment.dispose();
      widgets.forEach((widget) => view.removeGlyphMarginWidget(widget));
      decorations.clear();
    };
  }, [view, regions, props.alignment, props.range, props.side, props.actionsDisabled, props.zh]);
  const options = useMemo(
    () => ({
      wordWrap: 'on' as const,
      glyphMargin: true,
      lineDecorationsWidth: props.side ? 32 : 8,
      lineNumbers: (number: number) => String(number + (props.lineOffset ?? 0)),
    }),
    [props.lineOffset, props.side],
  );
  return (
    <CodeEditor
      path={props.path}
      label={props.label}
      content={props.content}
      language={detectSourceLanguage(props.path)}
      readOnly={props.readOnly}
      revealLine={props.revealLine}
      options={options}
      onChange={props.onChange}
      onView={setView}
    />
  );
});
