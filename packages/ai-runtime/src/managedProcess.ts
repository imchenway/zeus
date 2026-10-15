import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { businessProcessEnvironment, resolveExecutableInvocation } from './commandExecution.js';
import { createWindowsNativeRuntimeSpawn } from './windowsNativeRuntime.js';

/** Provider、Hook 和工具共享的管道启动选项，不接受任意 shell 拼接。 */
export interface ManagedProcessOptions {
  /** 已授权的执行目录。 */
  cwd?: string;
  /** 调用方冻结的环境。 */
  env?: NodeJS.ProcessEnv;
  /** 只允许统一解析器设置，用于原样传递已转义 cmd 参数。 */
  windowsVerbatimArguments?: boolean;
}

/** 把 Windows Job 私有通道适配成现有 ChildProcess 流接口，其他平台保持 Node 管道。 */
export function spawnManagedProcess(command: string, args: readonly string[], options: ManagedProcessOptions = {}): ChildProcessWithoutNullStreams {
  /** 业务子进程不能继承 Main/Core 的控制凭据；正式宿主启动有独立入口。 */
  const env = businessProcessEnvironment(options.env);
  /** 显式 cmd 参数已经解析完成，不能再次交给转义器。 */
  const invocation = options.windowsVerbatimArguments ? { command, args: [...args], env, windowsVerbatimArguments: true } : resolveExecutableInvocation(command, args, { ...options, env });
  if (process.platform !== 'win32') return spawn(invocation.command, invocation.args, { cwd: options.cwd, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  /** 原生宿主拥有进程与 Job；流对象不拥有第二份进程身份。 */
  const handle = createWindowsNativeRuntimeSpawn({ terminal: false })(invocation.command, invocation.args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...invocation.env, ZEUS_RUNTIME_PROCESS_IDENTITY_TOKEN: randomUUID() },
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  /** 现有 Provider 只使用事件、三个管道和停止方法，复用这些已公开的 ChildProcess 成员。 */
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  /** 输入管道可能在 UTF-8 字符中间分块，解码器保留未完成的字节。 */
  const inputDecoder = new StringDecoder('utf8');
  /** 只从原生退出通知更新状态，不把已经发出终止请求当作退出。 */
  let exitCode: number | null = null;
  /** 兼容 ChildProcess 的信号已发送状态。 */
  let killed = false;
  Object.defineProperty(child, 'exitCode', { get: () => exitCode });
  Object.defineProperty(child, 'killed', { get: () => killed });
  Object.defineProperty(child, 'pid', { get: () => handle.pid });
  child.stdin.on('data', (chunk: Buffer) => {
    try {
      handle.write?.(inputDecoder.write(chunk));
    } catch (error) {
      child.emit('error', error);
    }
  });
  child.stdin.on('finish', () => {
    try {
      /** 最后一段输入必须先送达，再关闭原生输入管道。 */
      const tail = inputDecoder.end();
      if (tail) handle.write?.(tail);
      handle.endInput?.();
    } catch (error) {
      child.emit('error', error);
    }
  });
  child.kill = (signal = 'SIGTERM') => {
    if (child.exitCode !== null) return false;
    handle.kill(signal as NodeJS.Signals);
    killed = true;
    return true;
  };
  for (const stream of ['stdout', 'stderr'] as const) {
    /** 保留原始字节和背压，避免 JSON 的中文损坏或暂停消费时无限缓存。 */
    const output = child[stream] as PassThrough;
    handle.on(stream, (chunk) => {
      if (!output.write(Buffer.isBuffer(chunk) || typeof chunk === 'string' ? chunk : String(chunk))) handle.pauseOutput?.(stream);
    });
    output.on('drain', () => handle.resumeOutput?.(stream));
  }
  handle.on('error', (error) => child.emit('error', error));
  handle.on('exit', (code) => {
    exitCode = typeof code === 'number' ? code : 1;
    child.emit('exit', child.exitCode, null);
  });
  handle.on('close', () => {
    (child.stdout as PassThrough).end();
    (child.stderr as PassThrough).end();
    child.stdin.destroy();
    child.emit('close', child.exitCode, null);
  });
  return child;
}
