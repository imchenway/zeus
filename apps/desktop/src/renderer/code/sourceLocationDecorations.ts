import { Decoration, ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { ConversationFileLocation } from '@zeus/shared';

/** 源码与通用文件预览共用行定位装饰，引用变化时读取最新位置。 */
export function sourceLocationDecorations(location: () => ConversationFileLocation | undefined) {
  return ViewPlugin.define(
    (view) => ({
      /** 装饰只覆盖编辑器当前可见的代码行。 */
      decorations: selectedLineDecorations(view, location()),
      /** 外部定位、文档更新和滚动后同步高亮，不遍历完整文件。 */
      update(update: ViewUpdate) {
        this.decorations = selectedLineDecorations(update.view, location());
      },
    }),
    { decorations: (plugin) => plugin.decorations },
  );
}

/** 行号与现有滚动定位一样收敛到文档范围，单行和连续范围均可高亮。 */
function selectedLineDecorations(view: EditorView, location?: ConversationFileLocation) {
  /** 非法位置不产生高亮，合法位置沿用原文件的一基行号。 */
  const start = location?.line && Number.isFinite(location.line) ? Math.max(1, Math.min(Math.trunc(location.line), view.state.doc.lines)) : null;
  /** 范围终点不能早于起点，也不能超出当前文档。 */
  const end = start && location?.endLine && Number.isFinite(location.endLine) ? Math.max(start, Math.min(Math.trunc(location.endLine), view.state.doc.lines)) : start;
  /** 每次只保存屏幕附近的行装饰。 */
  const decorations = [];
  for (const range of view.visibleRanges) {
    for (let position = range.from; position <= range.to;) {
      /** 根据文档偏移读取当前行。 */
      const line = view.state.doc.lineAt(position);
      /** 引用范围之外的代码保持普通阅读底色。 */
      const selected = start !== null && end !== null && line.number >= start && line.number <= end;
      decorations.push(Decoration.line({ attributes: { 'data-source-line': String(line.number), ...(selected ? { 'data-selected': 'true' } : {}) } }).range(line.from));
      position = line.to + 1;
    }
  }
  return Decoration.set(decorations, true);
}
