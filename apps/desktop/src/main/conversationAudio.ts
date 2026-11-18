import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** A process tap is available from macOS 14.2. */
function supportsSystemPlayback(): boolean {
  if (process.platform !== 'darwin') return false;
  const [major = 0, minor = 0] = process.getSystemVersion().split('.').map(Number);
  return major > 14 || (major === 14 && minor >= 2);
}

/** Share one local system audio tap across visible session navigators. */
export function registerConversationAudio(helperPath: string, accepts: (event: IpcMainInvokeEvent) => boolean): void {
  /** Each window owns its subscription and its lifecycle listeners. */
  const subscribers = new Map<WebContents, () => void>();
  /** The helper owns the tap, and closing its parent pipe releases it. */
  let helper: ChildProcess | undefined;

  /** Shut down even if Core Audio setup is waiting on a system prompt. */
  function stop(): void {
    const current = helper;
    helper = undefined;
    if (!current) return;
    const deadline = setTimeout(() => current.kill(), 2000).unref();
    current.once('close', () => clearTimeout(deadline));
    current.stdin?.end();
  }

  /** Close a subscription on opt-out, renderer exit, or navigation. */
  function remove(contents: WebContents): void {
    const dispose = subscribers.get(contents);
    subscribers.delete(contents);
    dispose?.();
    if (subscribers.size === 0) stop();
  }

  /** Forward only spectrum measurements and never log playback data. */
  function start(): void {
    const current = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    helper = current;
    current.stdin.on('error', () => undefined);
    current.on('error', () => undefined);
    const lines = createInterface({ input: current.stdout });
    lines.on('line', (line) => {
      if (helper !== current || line.length > 12000) return;
      const [binSize, level, powers] = line.split(' ');
      const hzPerBin = Number(binSize);
      const rms = Number(level);
      if (!powers || !Number.isFinite(hzPerBin) || hzPerBin <= 0 || !Number.isFinite(rms) || rms < 0) return;
      for (const contents of subscribers.keys()) {
        if (!contents.isDestroyed()) contents.send('zeus:conversation-audio:frame', { hzPerBin, rms, powers });
      }
    });
    current.once('close', () => {
      lines.close();
      if (helper !== current) return;
      helper = undefined;
      for (const contents of subscribers.keys()) {
        if (!contents.isDestroyed()) contents.send('zeus:conversation-audio:unavailable');
      }
    });
  }

  ipcMain.handle('zeus:conversation-audio:subscribe', (event, active: unknown) => {
    if (!accepts(event) || !supportsSystemPlayback() || typeof active !== 'boolean') return;
    const contents = event.sender;
    if (!active) {
      remove(contents);
      return;
    }
    if (!subscribers.has(contents)) {
      const dispose = () => remove(contents);
      contents.once('destroyed', dispose);
      contents.once('render-process-gone', dispose);
      contents.on('will-navigate', dispose);
      subscribers.set(contents, () => {
        contents.removeListener('destroyed', dispose);
        contents.removeListener('render-process-gone', dispose);
        contents.removeListener('will-navigate', dispose);
      });
    }
    if (!helper) start();
  });
  app.once('before-quit', stop);
}
