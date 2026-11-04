import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createDesktopApi, type DesktopTransport } from './desktopApi.cjs';

/** Electron 适配器只传递业务载荷，不把原生 IPC 事件暴露给界面。 */
const transport: DesktopTransport = {
  kind: 'electron-ipc',
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  subscribe: <T,>(channel: string, listener: (value: T) => void) => {
    /** 每次订阅持有独立包装函数，取消时不影响其他监听者。 */
    const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('zeus', createDesktopApi(transport));
