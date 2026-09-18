import { monaco } from './monacoRuntime.js';

interface Region {
  block: { id: string };
  from: number;
  to: number;
}
interface Pane {
  view: monaco.editor.IStandaloneCodeEditor;
  regions: Region[];
  zones: string[];
}
const groups = new WeakMap<object, { panes: Set<Pane>; frame: number; scrolling: boolean }>();

/** 稀疏 ViewZone 补齐三份文档的冲突边界，空白不进入草稿和复制内容。 */
export function attachConflictAlignment(identity: object, view: monaco.editor.IStandaloneCodeEditor, regions: Region[]): monaco.IDisposable {
  let group = groups.get(identity);
  if (!group) {
    group = { panes: new Set(), frame: 0, scrolling: false };
    groups.set(identity, group);
  }
  const state = group;
  const pane: Pane = { view, regions, zones: [] };
  state.panes.add(pane);
  const clear = (item: Pane) =>
    item.view.changeViewZones((accessor) => {
      item.zones.forEach((zone) => accessor.removeZone(zone));
      item.zones = [];
    });
  const schedule = () => {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      const panes = [...state.panes];
      if (panes.length !== 3) return;
      const top = view.getScrollTop();
      panes.forEach(clear);
      const entries = panes.map((item) => {
        const model = item.view.getModel()!;
        const anchors = new Map<string, number>();
        item.regions.forEach((region) => {
          anchors.set(region.block.id + ':start', model.getPositionAt(region.from).lineNumber);
          if (region.to > region.from) anchors.set(region.block.id + ':end', model.getPositionAt(region.to).lineNumber);
        });
        return { item, anchors, added: 0, spaces: [] as Array<{ line: number; height: number }> };
      });
      const keys = [...entries[0]!.anchors.keys()].filter((key) => entries.every((entry) => entry.anchors.has(key)));
      for (const key of keys) {
        const tops = entries.map((entry) => entry.item.view.getTopForLineNumber(entry.anchors.get(key)!) + entry.added);
        const maximum = Math.max(...tops);
        entries.forEach((entry, index) => {
          const height = maximum - tops[index]!;
          if (height > 1) {
            entry.spaces.push({ line: entry.anchors.get(key)! - 1, height });
            entry.added += height;
          }
        });
      }
      const bottoms = entries.map((entry) => entry.item.view.getTopForLineNumber(entry.item.view.getModel()!.getLineCount() + 1) + entry.added);
      const bottom = Math.max(...bottoms);
      entries.forEach((entry, index) => {
        const height = bottom - bottoms[index]!;
        if (height > 1) entry.spaces.push({ line: entry.item.view.getModel()!.getLineCount(), height });
        entry.item.view.changeViewZones((accessor) => {
          for (const space of entry.spaces) {
            const node = document.createElement('div');
            node.setAttribute('aria-hidden', 'true');
            entry.item.zones.push(accessor.addZone({ afterLineNumber: space.line, heightInPx: space.height, domNode: node }));
          }
        });
      });
      state.scrolling = true;
      panes.forEach((item) => item.view.setScrollTop(top));
      state.scrolling = false;
    });
  };
  const listeners = [
    view.onDidChangeModelContent(schedule),
    view.onDidLayoutChange(schedule),
    view.onDidScrollChange(() => {
      if (state.scrolling) return;
      state.scrolling = true;
      state.panes.forEach((item) => {
        if (item !== pane && Math.abs(item.view.getScrollTop() - view.getScrollTop()) > 1) item.view.setScrollTop(view.getScrollTop());
      });
      state.scrolling = false;
    }),
  ];
  schedule();
  return {
    dispose() {
      listeners.forEach((listener) => listener.dispose());
      clear(pane);
      state.panes.delete(pane);
      if (!state.panes.size) {
        cancelAnimationFrame(state.frame);
        state.frame = 0;
      }
    },
  };
}
