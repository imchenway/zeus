import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type { ReadOnlyValidationDescriptor } from '../packages/shared/src/readOnlyValidation.ts';
import { installReadOnlyValidationIpcFence, readOnlyValidationAllowedIpcChannels } from '../apps/desktop/src/main/readOnlyValidationIpcFence.ts';

const handles = new Map<string, (event: IpcMainInvokeEvent, ...arguments_: unknown[]) => unknown>();
const oneShotHandles = new Map<string, (event: IpcMainInvokeEvent, ...arguments_: unknown[]) => unknown>();
const events = new Map<string, (event: IpcMainEvent, ...arguments_: unknown[]) => void>();
const addedEvents = new Map<string, (event: IpcMainEvent, ...arguments_: unknown[]) => void>();
const oneShotEvents = new Map<string, (event: IpcMainEvent, ...arguments_: unknown[]) => void>();
const prependedEvents = new Map<string, (event: IpcMainEvent, ...arguments_: unknown[]) => void>();
const prependedOneShotEvents = new Map<string, (event: IpcMainEvent, ...arguments_: unknown[]) => void>();
const fakeIpcMain = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...arguments_: unknown[]) => unknown) {
    handles.set(channel, listener);
  },
  handleOnce(channel: string, listener: (event: IpcMainInvokeEvent, ...arguments_: unknown[]) => unknown) {
    oneShotHandles.set(channel, listener);
  },
  on(channel: string, listener: (event: IpcMainEvent, ...arguments_: unknown[]) => void) {
    events.set(channel, listener);
    return fakeIpcMain;
  },
  addListener(channel: string, listener: (event: IpcMainEvent, ...arguments_: unknown[]) => void) {
    addedEvents.set(channel, listener);
    return fakeIpcMain;
  },
  once(channel: string, listener: (event: IpcMainEvent, ...arguments_: unknown[]) => void) {
    oneShotEvents.set(channel, listener);
    return fakeIpcMain;
  },
  prependListener(channel: string, listener: (event: IpcMainEvent, ...arguments_: unknown[]) => void) {
    prependedEvents.set(channel, listener);
    return fakeIpcMain;
  },
  prependOnceListener(channel: string, listener: (event: IpcMainEvent, ...arguments_: unknown[]) => void) {
    prependedOneShotEvents.set(channel, listener);
    return fakeIpcMain;
  },
} as unknown as IpcMain;

const descriptor = {
  mode: 'read_only_validation',
  runId: '123e4567-e89b-42d3-a456-426614174000',
  manifestHash: 'a'.repeat(64),
} as ReadOnlyValidationDescriptor;

installReadOnlyValidationIpcFence(fakeIpcMain, descriptor);

let allowedHandleCalls = 0;
let blockedHandleCalls = 0;
let allowedEventCalls = 0;
let blockedEventCalls = 0;
let blockedAliasCalls = 0;
fakeIpcMain.handle('zeus:browser:get-snapshot', () => {
  allowedHandleCalls += 1;
  return { allowed: true };
});
fakeIpcMain.handle('zeus:new-side-effect-added-after-fence', () => {
  blockedHandleCalls += 1;
  return { forbidden: true };
});
fakeIpcMain.on('zeus:renderer-bootstrap-ready', () => {
  allowedEventCalls += 1;
});
fakeIpcMain.on('zeus:new-fire-and-forget-side-effect', () => {
  blockedEventCalls += 1;
});
fakeIpcMain.handleOnce('zeus:new-handle-once-side-effect', () => {
  blockedAliasCalls += 1;
});
fakeIpcMain.addListener('zeus:new-add-listener-side-effect', () => {
  blockedAliasCalls += 1;
});
fakeIpcMain.once('zeus:new-once-side-effect', () => {
  blockedAliasCalls += 1;
});
fakeIpcMain.prependListener('zeus:new-prepend-listener-side-effect', () => {
  blockedAliasCalls += 1;
});
fakeIpcMain.prependOnceListener('zeus:new-prepend-once-listener-side-effect', () => {
  blockedAliasCalls += 1;
});

const allowedResult = await handles.get('zeus:browser:get-snapshot')!({} as IpcMainInvokeEvent);
let blockedError: unknown;
try {
  await handles.get('zeus:new-side-effect-added-after-fence')!({} as IpcMainInvokeEvent);
} catch (error) {
  blockedError = error;
}
events.get('zeus:renderer-bootstrap-ready')!({} as IpcMainEvent);
events.get('zeus:new-fire-and-forget-side-effect')!({} as IpcMainEvent);
let blockedHandleOnceError: unknown;
try {
  await oneShotHandles.get('zeus:new-handle-once-side-effect')!({} as IpcMainInvokeEvent);
} catch (error) {
  blockedHandleOnceError = error;
}
addedEvents.get('zeus:new-add-listener-side-effect')!({} as IpcMainEvent);
oneShotEvents.get('zeus:new-once-side-effect')!({} as IpcMainEvent);
prependedEvents.get('zeus:new-prepend-listener-side-effect')!({} as IpcMainEvent);
prependedOneShotEvents.get('zeus:new-prepend-once-listener-side-effect')!({} as IpcMainEvent);

assertProbe(isRecord(allowedResult) && allowedResult.allowed === true && allowedHandleCalls === 1, '显式允许的只读 handle 必须执行一次。');
assertProbe(
  blockedHandleCalls === 0 &&
    blockedError instanceof Error &&
    isRecord(blockedError) &&
    blockedError.code === 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED' &&
    blockedError.runId === descriptor.runId &&
    blockedError.manifestHash === descriptor.manifestHash &&
    blockedError.recoveryRequired === false,
  '未知或副作用 handle 必须在业务 listener 前以同一 manifest 身份失败关闭。',
);
assertProbe(allowedEventCalls === 1, '显式允许的进程内 UI event 必须执行一次。');
assertProbe(blockedEventCalls === 0, '未知 fire-and-forget event 必须被静默丢弃，不能执行 listener。');
assertProbe(
  blockedAliasCalls === 0 && isRecord(blockedHandleOnceError) && blockedHandleOnceError.code === 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
  'handleOnce/addListener/once/prependListener/prependOnceListener 别名不得绕过默认拒绝 Fence。',
);
assertProbe(!readOnlyValidationAllowedIpcChannels().includes('zeus:new-side-effect-added-after-fence'), '默认拒绝策略不得自动收录后来新增的 channel。');

console.log(
  JSON.stringify(
    {
      status: 'passed',
      observed: {
        allowedChannelCount: readOnlyValidationAllowedIpcChannels().length,
        allowedHandleCalls,
        blockedHandleCalls,
        allowedEventCalls,
        blockedEventCalls,
        blockedAliasCalls,
        blockedCode: isRecord(blockedError) ? blockedError.code : null,
        blockedHandleOnceCode: isRecord(blockedHandleOnceError) ? blockedHandleOnceError.code : null,
      },
    },
    null,
    2,
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`只读验证 Main IPC Fence 行为探针失败：${message}`);
}
