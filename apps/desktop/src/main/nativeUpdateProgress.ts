import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export type NativeUpdateProgressAction = 'download' | 'restart' | 'retry' | 'later' | 'closed' | 'close';

export interface NativeUpdateProgressState {
  state: 'checking' | 'available' | 'upToDate' | 'updating' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'failed';
  title: string;
  detail: string;
  progressCaption?: string;
  progressText?: string;
  progress?: number;
  technicalDetail?: string;
  present?: boolean;
}

export interface NativeUpdateProgressHost {
  /** 用户显式要求打开窗口时调用，允许原生窗口获得一次键盘焦点。 */
  show(): void;
  hide(): void;
  /** 只更新内容与可见性，不得把更新窗口重新激活到前台。 */
  update(state: NativeUpdateProgressState): void;
  relaunchAfterProcessExit(input: { pid: number; appPath: string; bundleId: string; version: string }): void;
  close(): void;
  onAction(listener: (action: NativeUpdateProgressAction) => void): () => void;
  onExit(listener: () => void): () => void;
}

interface CreateNativeUpdateProgressHostOptions {
  executablePath: string;
  language: 'zh-CN' | 'en-US';
}

/**
 * AppKit 辅助程序只承载原生窗口；下载和安装责任始终留在 Main 的受控服务中。
 */
export async function createNativeUpdateProgressHost(options: CreateNativeUpdateProgressHostOptions): Promise<NativeUpdateProgressHost> {
  await access(options.executablePath);
  const child = spawn(options.executablePath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  const actionListeners = new Set<(action: NativeUpdateProgressAction) => void>();
  const exitListeners = new Set<() => void>();
  let closed = false;

  child.on('error', (error) => {
    console.warn('Zeus 原生更新进度窗口运行失败。', error);
  });
  child.stdin.on('error', (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') console.warn('Zeus 无法向原生更新进度窗口发送状态。', error);
  });

  const stdout = createInterface({ input: child.stdout });
  stdout.on('line', (line) => {
    const action = parseAction(line);
    if (!action) return;
    for (const listener of actionListeners) listener(action);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const message = chunk.toString('utf8').trim();
    if (message) console.warn('Zeus 原生更新进度窗口输出了错误信息。', message);
  });
  child.once('exit', () => {
    closed = true;
    stdout.close();
    for (const listener of exitListeners) listener();
  });

  function send(message: Record<string, unknown>): void {
    if (closed || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify({ ...message, language: options.language })}\n`);
  }

  return {
    show: () => send({ type: 'show' }),
    hide: () => send({ type: 'hide' }),
    update: (state) => send({ type: 'state', ...state }),
    relaunchAfterProcessExit: (input) => send({ type: 'relaunch', ...input }),
    close: () => {
      if (closed) return;
      send({ type: 'quit' });
      child.stdin.end();
    },
    onAction: (listener) => {
      actionListeners.add(listener);
      return () => actionListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
}

function parseAction(line: string): NativeUpdateProgressAction | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) return null;
    const action = value.action;
    return action === 'download' || action === 'restart' || action === 'retry' || action === 'later' || action === 'closed' || action === 'close' ? action : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
