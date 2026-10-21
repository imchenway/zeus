import { useEffect, useRef } from 'react';

/** 连接带只需要当前可见区块的边界和语义颜色。 */
interface VisibleDiffBlock {
  /** 新增、删除或修改使用共享色板。 */
  tone: string;
  /** 实际绘制范围包含对齐补白。 */
  top: number;
  bottom: number;
}

/** 只读取已挂载代码行，不为整份长文件创建连接节点。 */
function visibleBlocks(editor: HTMLElement, origin: number): Map<string, VisibleDiffBlock> {
  /** 同一连续改动在可见行之间合并。 */
  const blocks = new Map<string, VisibleDiffBlock>();
  editor.querySelectorAll<HTMLElement>('[data-diff-block], .code-diff-alignment').forEach((element) => {
    /** 空身份属于上下文行，不产生连接带。 */
    const id = element.dataset.diffBlock ?? (element.classList.contains('code-diff-alignment') ? (element.previousElementSibling as HTMLElement | null)?.dataset.diffBlock : undefined);
    if (!id) return;
    /** 补白与真实行使用相同区块分类。 */
    const tone = element.dataset.diffTone ?? ['addition', 'deletion', 'replacement'].find((value) => element.classList.contains(`is-${value}`));
    if (!tone) return;
    if (tone === 'replacement' && element.classList.contains('cm-mergeSpacer')) return;
    /** 编辑器虚拟滚动只提供可见行的实际像素。 */
    const rect = element.getBoundingClientRect();
    if (!rect.height) return;
    /** 同一区块的首末可见边界。 */
    const previous = blocks.get(id);
    blocks.set(id, { tone, top: Math.min(previous?.top ?? Infinity, rect.top - origin), bottom: Math.max(previous?.bottom ?? -Infinity, rect.bottom - origin) });
  });
  return blocks;
}

/** 两种 Diff 共用色带；只覆盖中缝，编辑、拖选、滚动及恢复按钮不受影响。 */
export function DiffConnectorLayer() {
  /** SVG 由 React 挂载，内部路径由本组件按实际布局更新。 */
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    /** 连接层与两个编辑器属于同一个差异容器。 */
    const svg = svgRef.current;
    const root = svg?.parentElement;
    const owner = root?.ownerDocument.defaultView;
    if (!svg || !root || !owner) return;
    /** 同一帧的编辑、滚动和重排只测量一次。 */
    let frame = 0;
    /** 相同路径不重复写入 DOM。 */
    let previous = '';
    /** 只在根容器大小或编辑器可见节点变化后更新。 */
    const paint = () => {
      frame = 0;
      /** 单栏视图不会挂载此连接层。 */
      const editors = [...root.querySelectorAll<HTMLElement>('.cm-editor')];
      if (editors.length !== 2) return;
      /** 所有坐标转换成当前容器内的 CSS 像素。 */
      const bounds = root.getBoundingClientRect();
      const left = editors[0]!;
      const right = editors[1]!;
      const x1 = left.getBoundingClientRect().right - bounds.left;
      const x2 = right.getBoundingClientRect().left - bounds.left;
      /** 对应区块依靠来源身份配对，不能依赖可见 DOM 顺序。 */
      const before = visibleBlocks(left, bounds.top);
      const after = visibleBlocks(right, bounds.top);
      /** 连接带采用不透明共享背景，不叠加额外深色。 */
      const paths: Array<{ className: string; d: string }> = [];
      /** 补白没有行号节点，只给这段空行号区补色，不覆盖真实行号或提交人。 */
      for (const editor of editors) {
        const edge = editor.getBoundingClientRect().left - bounds.left;
        editor.querySelectorAll<HTMLElement>('.cm-mergeSpacer[data-diff-tone], .code-diff-alignment').forEach((element) => {
          const tone = element.dataset.diffTone ?? ['addition', 'deletion', 'replacement'].find((value) => element.classList.contains(`is-${value}`));
          const rect = element.getBoundingClientRect();
          if (!tone || tone === 'replacement' || !rect.height) return;
          const end = rect.left - bounds.left;
          const top = rect.top - bounds.top;
          const bottom = rect.bottom - bounds.top;
          paths.push({ className: `is-${tone}`, d: `M${edge} ${top} H${end} V${bottom} H${edge} Z` });
        });
        /** 波浪边界贯穿行号区，正文部分仍由可点击的折叠控件绘制。 */
        editor.querySelectorAll<HTMLElement>('.code-diff-fold, .cm-collapsedLines').forEach((element) => {
          const rect = element.getBoundingClientRect();
          const y = rect.top - bounds.top + 4;
          paths.push({ className: 'is-fold', d: foldWave(edge, rect.left - bounds.left, y) });
        });
      }
      if (x2 > x1) {
        for (const [id, a] of before) {
          const b = after.get(id);
          if (!b || Math.max(a.bottom, b.bottom) < 0 || Math.min(a.top, b.top) > bounds.height) continue;
          paths.push({ className: `is-${a.tone}`, d: `M${x1} ${a.top} L${x2} ${b.top} L${x2} ${b.bottom} L${x1} ${a.bottom} Z` });
        }
        /** 折叠边界在中缝继续绘制，左右按当前可见高度对应。 */
        const rightFolds = [...right.querySelectorAll<HTMLElement>('.code-diff-fold, .cm-collapsedLines')].map((element) => element.getBoundingClientRect().top - bounds.top + 4);
        left.querySelectorAll<HTMLElement>('.code-diff-fold, .cm-collapsedLines').forEach((element) => {
          const y = element.getBoundingClientRect().top - bounds.top + 4;
          if (!rightFolds.some((other) => Math.abs(other - y) < 2)) return;
          paths.push({ className: 'is-fold', d: foldWave(x1, x2, y) });
        });
      }
      /** 宽高与路径一同比较，拖动分栏时不保留旧连接位置。 */
      const signature = JSON.stringify([bounds.width, bounds.height, paths]);
      if (signature === previous) return;
      previous = signature;
      svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
      svg.replaceChildren(
        ...paths.map(({ className, d }) => {
          const path = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('class', className);
          path.setAttribute('d', d);
          return path;
        }),
      );
    };
    /** 所属窗口负责调度，独立交付窗口不依赖主窗口刷新时钟。 */
    const schedule = () => {
      if (!frame) frame = owner.requestAnimationFrame(paint);
    };
    /** 监听真实代码布局，忽略连接层自身更新以避免循环。 */
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !svg.contains(record.target))) schedule();
    });
    mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'data-diff-block', 'data-diff-tone'] });
    /** 容器改变尺寸时重新计算两栏边界。 */
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    root.addEventListener('scroll', schedule, true);
    schedule();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      root.removeEventListener('scroll', schedule, true);
      if (frame) owner.cancelAnimationFrame(frame);
    };
  }, []);
  return <svg ref={svgRef} className="code-diff-connectors" aria-hidden="true" />;
}

/** 波浪周期与共享 CSS 一致，末段在行号区或中缝边缘收束。 */
function foldWave(start: number, end: number, y: number): string {
  /** 路径只跨越当前空白宽度，不延伸到代码正文。 */
  let d = `M${start} ${y}`;
  for (let x = start; x < end; x += 8) d += ` Q${Math.min(x + 4, end)} ${y + (Math.floor((x - start) / 8) % 2 ? 5 : -5)} ${Math.min(x + 8, end)} ${y}`;
  return d;
}
