import assert from 'node:assert/strict';
import { mock } from 'node:test';

/** 仅替代 Electron 导出，检查不启动应用、不访问网页或用户数据。 */
mock.module('electron', {
  namedExports: Object.fromEntries(['BrowserWindow', 'clipboard', 'dialog', 'ipcMain', 'Menu', 'MenuItem', 'nativeImage', 'session', 'WebContentsView'].map((name) => [name, {}])),
});

/** 导入实际宿主，检查待展开状态而非复制一份实现。 */
const { BrowserHost } = await import('../apps/desktop/src/main/browserHost.ts');
/** 仅提供布局和关闭实际会调用的窗口边界。 */
const window = { id: 1, contentView: { addChildView() {}, removeChildView() {} } };
/** 标签已有网页视图，检查过程无需创建原生 WebContentsView。 */
const tab = {
  snapshot: { id: 'page', conversationId: 'owner', createdAt: '2026-11-16T00:00:00Z' },
  ownerWindowId: window.id,
  view: { webContents: { isDestroyed: () => false, isFocused: () => false, close() {} }, setBounds() {}, setVisible() {} },
};
/** 跳过依赖 Electron 会话的构造，仅检查宿主真实状态转换。 */
const host = Object.assign(Object.create(BrowserHost.prototype), {
  tabs: new Map([[tab.snapshot.id, tab]]),
  windows: new Map(),
  activeTabByConversation: new Map([['owner', tab.snapshot.id]]),
  visibleTabByWindow: new Map(),
  pendingApprovals: new Map(),
  pendingOpenRequests: new Set(),
  advancedHandles: new Map(),
  advancedTabClaims: new Map(),
  settings: { enabled: true },
  options: {},
  schedulePersist() {},
});
/** 正尺寸用于确认显示后才消费请求，隐藏布局不能消费。 */
const bounds = { x: 0, y: 0, width: 800, height: 600 };

host.emitOpenRequested('owner');
assert.equal(host.snapshotFor('owner').openRequested, true, '未订阅界面仍须能恢复打开请求');
assert.equal(host.snapshotFor('owner').openRequested, true, '读取快照不能提前消费打开请求');
assert.equal(host.snapshotFor('other').openRequested, false, '打开请求不能串到其他会话');
await host.setLayout(window, 'owner', tab.snapshot.id, bounds, false);
assert.equal(host.snapshotFor('owner').openRequested, true, '暂停或隐藏网页不能丢失打开请求');
await host.setLayout(window, 'owner', tab.snapshot.id, bounds, true);
assert.equal(host.snapshotFor('owner').openRequested, false, '网页实际显示后须消费打开请求');
host.emitOpenRequested('owner');
host.closeTab(window, 'owner', tab.snapshot.id);
assert.equal(host.snapshotFor('owner').openRequested, false, '关闭全部标签须清除打开请求');
assert.equal(host.snapshotFor('owner').tabs.length, 0);
console.log('Browser open request recovery passed.');
