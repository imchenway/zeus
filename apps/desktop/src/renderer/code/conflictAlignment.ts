import { RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
import { BlockType, Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';

/** 只保留对齐需要的冲突身份和本栏字符位置。 */
interface AlignmentRegion {
  /** 同一冲突在三栏使用同一身份。 */
  block: { id: string };
  /** 本栏起始字符。 */
  from: number;
  /** 本栏结束字符。 */
  to: number;
}

/** 补白属于视图，不进入文本、复制内容或撤销记录。 */
class AlignmentSpace extends WidgetType {
  /** 补白高度使用编辑器实际测量的像素。 */
  constructor(readonly height: number) {
    super();
  }
  /** 高度未变化时复用节点。 */
  eq(other: AlignmentSpace): boolean {
    return this.height === other.height;
  }
  /** 虚拟滚动在节点未挂载时同样知道其高度。 */
  get estimatedHeight(): number {
    return this.height;
  }
  /** 空白不接受焦点，也不参与辅助阅读。 */
  toDOM(): HTMLElement {
    /** 原生块节点仅承担显示高度。 */
    const element = document.createElement('div');
    element.style.height = `${this.height}px`;
    element.setAttribute('aria-hidden', 'true');
    return element;
  }
}

/** 一次性替换本栏的稀疏补白。 */
const setAlignment = StateEffect.define<DecorationSet>();
/** 块级补白必须直接来自状态字段，不能来自可见区域插件。 */
const alignmentSpaces = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (spaces, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setAlignment)) return effect.value;
    return spaces.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 每个冲突工作区独立维护三栏，弱引用随页面卸载释放。 */
const groups = new WeakMap<object, AlignmentGroup>();

/** 用冲突起止位置连接三份不同长度的文档。 */
class AlignmentGroup {
  /** 当前挂载的三栏和各自的冲突位置。 */
  readonly panes = new Map<EditorView, AlignmentRegion[]>();
  /** 将一轮编辑和窗口变化合并成一次测量。 */
  private frame = 0;
  /** 记录程序设置的滚动，避免三栏异步滚动事件互相覆盖。 */
  private readonly expectedScroll = new WeakMap<EditorView, number>();

  /** 等三栏完成当前事务后，读取最新软换行布局。 */
  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.panes.size !== 3) return;
      /** 使用原生测量阶段，补白变化继续由编辑器校准虚拟行高度。 */
      const view = this.panes.keys().next().value!;
      view.requestMeasure({
        key: this,
        read: () => this.measure(),
        // 测量仍处于编辑器更新中，退出当前事务后再发布块装饰。
        write: (updates) =>
          queueMicrotask(() => {
            /** 只有补白确实变化才恢复统一滚动位置。 */
            let changed = false;
            for (const [pane, spaces] of updates) {
              if (this.panes.has(pane) && !RangeSet.eq([pane.state.field(alignmentSpaces)], [spaces])) {
                pane.dispatch({ effects: setAlignment.of(spaces) });
                changed = true;
              }
            }
            // 编辑器会自动保持本栏阅读位置；补白更新后重新统一三栏滚动。
            if (changed && this.panes.has(view)) {
              this.expectedScroll.delete(view);
              this.scroll(view);
            }
          }),
      });
    });
  }

  /** 相同冲突位置已补齐高度，只同步纵向滚动。 */
  scroll(source: EditorView): void {
    /** 浏览器可能将位置取整，容许一个像素误差。 */
    const top = source.scrollDOM.scrollTop;
    if (Math.abs((this.expectedScroll.get(source) ?? -Infinity) - top) < 1) return;
    this.expectedScroll.delete(source);
    for (const pane of this.panes.keys()) {
      if (pane === source || Math.abs(pane.scrollDOM.scrollTop - top) < 1) continue;
      pane.scrollDOM.scrollTop = top;
      this.expectedScroll.set(pane, pane.scrollDOM.scrollTop);
    }
  }

  /** 先扣除旧补白，再按共同冲突位置计算新补白，避免高度累加。 */
  private measure(): Map<EditorView, DecorationSet> {
    /** 每栏保存自然位置、已有补白以及此次新增高度。 */
    const panes = [...this.panes].map(([view, regions]) => {
      /** 稀疏补白按文档顺序读取。 */
      const old: Array<{ from: number; height: number; side: number }> = [];
      view.state.field(alignmentSpaces).between(0, view.state.doc.length, (from, _to, decoration) => {
        old.push({ from, side: decoration.spec.side, height: (decoration.spec.widget as AlignmentSpace).height });
      });
      /** 各冲突起止行作为锚点；未知位置不猜测。 */
      const anchors = new Map<string, number>();
      for (const region of regions) {
        anchors.set(`${region.block.id}:start`, view.state.doc.lineAt(Math.min(region.from, view.state.doc.length)).from);
        if (region.to > region.from && region.to <= view.state.doc.length) anchors.set(`${region.block.id}:end`, view.state.doc.lineAt(region.to).from);
      }
      return { view, anchors, old, added: 0, spaces: [] as ReturnType<Decoration['range']>[] };
    });
    /** 只对三栏均有可靠位置、且没有空冲突重合的边界对齐。 */
    const keys = [...panes[0]!.anchors.keys()].filter((key) => panes.every((pane) => pane.anchors.has(key) && (!key.endsWith(':end') || pane.anchors.get(key)! > pane.anchors.get(key.replace(/:end$/, ':start'))!)));
    for (const key of keys) {
      /** 文本块的顶部包含本行之前的补白；扣除后取得原始布局高度。 */
      const positions = panes.map((pane) => {
        /** 本栏相同冲突边界的原始字符位置。 */
        const from = pane.anchors.get(key)!;
        /** 原生高度索引包含软换行和虚拟行估算。 */
        const block = pane.view.lineBlockAt(from);
        /** 块补白与文本可能共用一个逻辑行，只取文本顶部。 */
        const text = Array.isArray(block.type) ? (block.type.find((part) => part.type === BlockType.Text) ?? block) : block;
        // ponytail: 按冲突数量平方扫描稀疏补白；大量冲突时改为前缀高度索引。
        const removed = pane.old.reduce((height, space) => height + (space.from < from || (space.from === from && space.side < 0) ? space.height : 0), 0);
        return { from, top: text.top - removed + pane.added };
      });
      /** 较短的一栏补齐到最高的位置。 */
      const target = Math.max(...positions.map((position) => position.top));
      panes.forEach((pane, index) => {
        /** 当前栏距离公共边界缺少的显示高度。 */
        const position = positions[index]!;
        /** 忽略不足一个像素的布局舍入误差。 */
        const height = Math.max(0, target - position.top);
        if (height < 1) return;
        pane.spaces.push(Decoration.widget({ widget: new AlignmentSpace(height), block: true, side: -1 }).range(position.from));
        pane.added += height;
      });
    }
    /** 文件尾部同样补齐，让短栏滚到底时不会被浏览器截断同步位置。 */
    const heights = panes.map((pane) => pane.view.contentHeight - pane.old.reduce((sum, space) => sum + space.height, 0) + pane.added);
    /** 三栏统一的文档末尾。 */
    const bottom = Math.max(...heights);
    return new Map(
      panes.map((pane, index) => {
        /** 尾部补白排在最后一个文本行之后。 */
        const height = bottom - heights[index]!;
        if (height >= 1) pane.spaces.push(Decoration.widget({ widget: new AlignmentSpace(height), block: true, side: 1 }).range(pane.view.state.doc.length));
        return [pane.view, Decoration.set(pane.spaces, true)];
      }),
    );
  }
}

/** 完整文件和聚焦片段共用同一个对齐扩展。 */
export function conflictAlignmentExtension(identity: object, regions: AlignmentRegion[]): Extension {
  /** 每组三栏只创建一个协调器。 */
  let group = groups.get(identity);
  if (!group) groups.set(identity, (group = new AlignmentGroup()));
  /** 插件生命周期只维护本栏注册，不保留已关闭的编辑器。 */
  const alignment = group;
  return [
    alignmentSpaces,
    ViewPlugin.define((view) => {
      alignment.panes.set(view, regions);
      alignment.schedule();
      return {
        update(update) {
          if (update.geometryChanged || update.viewportChanged || update.docChanged) alignment.schedule();
        },
        destroy() {
          alignment.panes.delete(view);
        },
      };
    }),
    EditorView.domEventHandlers({ scroll: (_event, view) => alignment.scroll(view) }),
  ];
}
