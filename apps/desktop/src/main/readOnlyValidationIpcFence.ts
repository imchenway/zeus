import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type { ReadOnlyValidationDescriptor } from '@zeus/shared';

const allowedChannels = new Set([
  'zeus:get-local-server-config',
  'zeus:execution-host-maintenance:get-status',
  'zeus:conversation-store-migration:get-status',
  'zeus:browser:get-snapshot',
  'zeus:browser:get-settings',
  'zeus:task-git-delivery:get-current-context',
  'zeus:automatic-update-indicator:get',
  'zeus:requesting-window-foreground',
  'zeus:activate-requesting-window',
  'zeus:renderer-bootstrap-failed',
  'zeus:renderer-bootstrap-ready',
  'zeus:renderer-runtime-failed',
  'zeus:task-table-layout-dirty-changed',
  'zeus:unsaved-change-state',
  'zeus:sensitive-request-draft-changed',
  'zeus:session-context-activity-changed',
  'zeus:app-close-layer-activity-changed',
  'zeus:window-drag-start',
  'zeus:window-drag-move',
  'zeus:window-drag-end',
]);

const installedTargets = new WeakSet<object>();

/**
 * 在任何 Main/BrowserHost IPC 注册前包装 singleton；默认拒绝，只有窗口投影和连接配置查询放行。
 * 因此后续新增 channel 不会静默穿过正式副本 fence。
 */
export function installReadOnlyValidationIpcFence(ipcMain: IpcMain, descriptor: ReadOnlyValidationDescriptor): void {
  if (installedTargets.has(ipcMain)) return;
  installedTargets.add(ipcMain);
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalHandleOnce = ipcMain.handleOnce.bind(ipcMain);
  const originalOn = ipcMain.on.bind(ipcMain);
  const originalAddListener = ipcMain.addListener.bind(ipcMain);
  const originalOnce = ipcMain.once.bind(ipcMain);
  const originalPrependListener = ipcMain.prependListener.bind(ipcMain);
  const originalPrependOnceListener = ipcMain.prependOnceListener.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    originalHandle(channel, (event, ...args) => {
      assertAllowed(channel, descriptor);
      return listener(event, ...args);
    })) as IpcMain['handle'];
  ipcMain.handleOnce = ((channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    originalHandleOnce(channel, (event, ...args) => {
      assertAllowed(channel, descriptor);
      return listener(event, ...args);
    })) as IpcMain['handleOnce'];

  const wrapEventListener =
    (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) =>
    (event: IpcMainEvent, ...args: unknown[]) => {
      if (!allowedChannels.has(channel)) return;
      listener(event, ...args);
    };
  ipcMain.on = ((channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => originalOn(channel, wrapEventListener(channel, listener))) as IpcMain['on'];
  ipcMain.addListener = ((channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => originalAddListener(channel, wrapEventListener(channel, listener))) as IpcMain['addListener'];
  ipcMain.once = ((channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => originalOnce(channel, wrapEventListener(channel, listener))) as IpcMain['once'];
  ipcMain.prependListener = ((channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => originalPrependListener(channel, wrapEventListener(channel, listener))) as IpcMain['prependListener'];
  ipcMain.prependOnceListener = ((channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => originalPrependOnceListener(channel, wrapEventListener(channel, listener))) as IpcMain['prependOnceListener'];
}

function assertAllowed(channel: string, descriptor: ReadOnlyValidationDescriptor): void {
  if (allowedChannels.has(channel)) return;
  throw Object.assign(new Error(`只读验证模式已阻止 Main IPC：${channel}`), {
    code: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
    statusCode: 503,
    runId: descriptor.runId,
    manifestHash: descriptor.manifestHash,
    recoveryRequired: false as const,
  });
}

export function readOnlyValidationAllowedIpcChannels(): readonly string[] {
  return [...allowedChannels].sort();
}
