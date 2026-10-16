import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { normalizeProcessEnvironment } from './commandExecution.js';
import type { AiRuntimeProcessHandle, AiRuntimeSpawn, NodePtyRuntimeModule } from './index.js';

/** 只有宿主能够写入的 Windows 命令隔离描述，不传给实际业务程序。 */
export interface WindowsRuntimeSandboxPolicy {
  /** 与会话授权相同的文件访问等级。 */
  mode: 'read-only' | 'workspace-write';
  /** 受限会话当前统一关闭网络，完全访问模式不创建本策略。 */
  network: 'blocked';
  /** 宿主凭据与数据的真实禁止路径，优先于读取与写入根。 */
  deniedRoots: string[];
  /** 广域工作区遍历时跳过的宿主私有树，明确授权的附件子根另行读取。 */
  excludedRoots: string[];
  /** 已解析真实路径的只读根目录。 */
  readableRoots: string[];
  /** 已冻结的可写目录；只读模式仅允许本次专用临时目录。 */
  writableRoots: string[];
  /** 本次执行独占的临时目录。 */
  scratchDirectory: string;
}

/** 宿主与 helper 共用的内部环境字段；进入用户命令前必须移除。 */
export const windowsRuntimePolicyEnvironmentKey = 'ZEUS_WINDOWS_SANDBOX_POLICY';

/** 从启动器注入的绝对路径读取原生组件，禁止搜索 PATH 或降级执行。 */
export function resolveWindowsRuntimeHelper(configuredPath = process.env.ZEUS_WINDOWS_RUNTIME_HELPER): string {
  if (!configuredPath || !isAbsolute(configuredPath) || !existsSync(configuredPath)) throw new Error('Windows 原生执行组件不可用，请修复 Zeus 安装；命令尚未执行。');
  return configuredPath;
}

/** 复用现有管道和 node-pty；helper 只负责隔离、Job 和精确命令创建。 */
export function createWindowsNativeRuntimeSpawn(configuration: { helperPath?: string; terminal?: boolean } = {}): AiRuntimeSpawn {
  return (command, args, options) => {
    /** 控制描述只给受信任 helper，原生创建业务进程前删除。 */
    const helperPath = resolveWindowsRuntimeHelper(configuration.helperPath);
    const environment = normalizeProcessEnvironment(options.env);
    const policy = options.windowsSandboxPolicy;
    /** 私有配置只能来自宿主启动环境，普通命令自定义 env 无权替换。 */
    for (const key of Object.keys(environment)) if (['ZEUS_WINDOWS_RUNTIME_HELPER', 'ZEUS_WINDOWS_SANDBOX_HOME', 'ZEUS_WINDOWS_SANDBOX_POLICY', 'ZEUS_WINDOWS_RUNTIME_REQUEST'].includes(key.toUpperCase())) delete environment[key];
    if (process.env.ZEUS_WINDOWS_SANDBOX_HOME) environment.ZEUS_WINDOWS_SANDBOX_HOME = process.env.ZEUS_WINDOWS_SANDBOX_HOME;
    environment.ZEUS_WINDOWS_RUNTIME_HELPER = helperPath;
    /** 普通 Provider 探针同样有独立 generation，不借用另一命令的身份。 */
    const generation = environment.ZEUS_RUNTIME_PROCESS_IDENTITY_TOKEN ?? randomUUID();
    if (!/^[0-9a-f-]{36}$/iu.test(generation)) throw new Error('Windows Runtime 进程身份无效。');
    const terminal = options.terminal ?? configuration.terminal ?? false;
    environment.ZEUS_WINDOWS_RUNTIME_REQUEST = JSON.stringify({ command, args, cwd: options.cwd, generation, terminal, windowsVerbatimArguments: options.windowsVerbatimArguments ?? false, policy });
    if (environment.ZEUS_WINDOWS_RUNTIME_REQUEST.length > 32_000) throw new Error('Windows 命令与参数超出原生启动描述上限；命令尚未执行，请将长脚本保存为文件再执行。');
    const events = new EventEmitter();
    /** helper 出错由现有 Runtime 记录；不自动换后端或重复执行。 */
    const notifyError = (error: unknown): void => {
      events.emit('error', error);
    };
    if (terminal) {
      const pty = createRequire(import.meta.url)('node-pty') as NodePtyRuntimeModule;
      const child = pty.spawn(helperPath, ['serve'], { cwd: options.cwd, env: environment, name: 'xterm-256color', cols: options.cols ?? 100, rows: options.rows ?? 30 });
      child.onData((chunk) => events.emit('stdout', chunk));
      child.onExit((exit) => {
        events.emit('exit', exit.exitCode ?? null);
        events.emit('close', exit.exitCode ?? null);
      });
      const handle: AiRuntimeProcessHandle = {
        pid: child.pid,
        on(event, callback) {
          events.on(event, callback);
          return handle;
        },
        kill(signal) {
          if (signal === 'SIGINT') child.write('\x03');
          else if (controlWindowsRuntime(generation, child.pid, 'stop').state !== 'verified') child.kill();
        },
        write(input) {
          child.write(input);
        },
        resize(cols, rows) {
          child.resize(cols, rows);
        },
      };
      return handle;
    }
    const child = spawn(helperPath, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: environment, cwd: options.cwd, shell: false });
    child.on('error', notifyError);
    child.stdin.on('error', notifyError);
    child.stdout.on('data', (chunk) => events.emit('stdout', chunk));
    child.stderr.on('data', (chunk) => events.emit('stderr', chunk));
    child.on('exit', (code) => events.emit('exit', code));
    child.on('close', (code) => events.emit('close', code));
    const handle: AiRuntimeProcessHandle = {
      pid: child.pid,
      on(event, callback) {
        events.on(event, callback);
        return handle;
      },
      kill() {
        /** 创建 Job 前 helper 没有业务子进程；启动竞争窗口仅结束本次 ChildProcess 句柄。 */
        if (!child.pid || controlWindowsRuntime(generation, child.pid, 'stop').state !== 'verified') child.kill();
      },
      write(input) {
        child.stdin.write(input);
      },
      endInput() {
        child.stdin.end();
      },
      pauseOutput(stream) {
        child[stream].pause();
      },
      resumeOutput(stream) {
        child[stream].resume();
      },
    };
    return handle;
  };
}

/** Execution Host 独立于桌面主进程存活，Job 仍由专属 helper 持有并可按 generation 恢复。 */
export function spawnDetachedWindowsRuntime(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; generation: string }) {
  /** Bootstrap 已冻结本轮身份，控制通道使用相同 UUID。 */
  const environment = { ...options.env, ZEUS_WINDOWS_RUNTIME_REQUEST: JSON.stringify({ command, args, cwd: options.cwd, generation: options.generation, terminal: false, windowsVerbatimArguments: false }) };
  return spawn(resolveWindowsRuntimeHelper(), ['serve'], { cwd: options.cwd, env: environment, stdio: 'ignore', detached: true, windowsHide: true });
}

/** 原生进程身份由命名管道的内核 server PID 与创建时间共同证明。 */
export interface WindowsRuntimeIdentity {
  /** 正在持有本任务 Job 的 helper PID。 */
  pid: number;
  /** Windows FILETIME 原始十进制字符串，不经浮点数转换。 */
  creationTime: string;
  /** 内核查询到的可执行文件路径。 */
  imagePath: string;
  /** 仅原生进程查询返回；Runtime 恢复依赖私有管道而不依赖父 PID。 */
  parentPid?: number;
}

/** 桌面宿主调用安装和 CUA 身份查询；不经过受管业务命令，避免递归启动。 */
export function runWindowsRuntimeHelper(
  action: 'setup' | 'status' | 'cleanup' | 'info' | 'children' | 'terminate-child' | 'capabilities',
  input: Record<string, unknown>,
  options: { helperPath?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  return new Promise((resolveRequest, rejectRequest) => {
    const helper = spawn(resolveWindowsRuntimeHelper(options.helperPath), [action], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timeout = setTimeout(() => {
      helper.kill();
      rejectRequest(new Error('Windows 原生组件请求超时，请检查实际状态后手动重试。'));
    }, options.timeoutMs ?? 5_000);
    helper.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        helper.kill();
        rejectRequest(new Error('Windows 原生组件回复超出限制。'));
      } else chunks.push(chunk);
    });
    helper.stderr.resume();
    helper.on('error', (error) => {
      clearTimeout(timeout);
      rejectRequest(error);
    });
    helper.stdin.on('error', (error) => {
      clearTimeout(timeout);
      rejectRequest(error);
    });
    helper.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectRequest(new Error('Windows 原生组件请求失败，未确认操作结果。'));
        return;
      }
      try {
        resolveRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectRequest(new Error('Windows 原生组件返回了无效结果。'));
      }
    });
    helper.stdin.end(JSON.stringify(action === 'setup' ? { ...input, generation: randomUUID() } : input));
  });
}

/** 同步恢复只走有界原生身份查询，不扫描其他进程的环境或命令行。 */
function controlWindowsRuntime(
  token: string,
  pid: number | undefined,
  action: 'inspect' | 'stop',
): { state: 'verified' | 'mismatch' | 'not_found' | 'unavailable'; identity?: WindowsRuntimeIdentity; childIdentity?: WindowsRuntimeIdentity } {
  try {
    const result = spawnSync(resolveWindowsRuntimeHelper(), ['control'], { input: JSON.stringify({ token, pid, action }), encoding: 'utf8', timeout: 3_000, windowsHide: true, maxBuffer: 16 * 1024 });
    if (result.error || result.status !== 0) return { state: 'unavailable' };
    const value = JSON.parse(result.stdout) as { state?: unknown; identity?: WindowsRuntimeIdentity; childIdentity?: WindowsRuntimeIdentity };
    if (!['verified', 'mismatch', 'not_found', 'unavailable'].includes(String(value.state))) return { state: 'unavailable' };
    if (value.state === 'verified' && (!value.identity || !Number.isSafeInteger(value.identity.pid) || value.identity.pid <= 1 || !/^\d+$/u.test(value.identity.creationTime) || !isAbsolute(value.identity.imagePath)))
      return { state: 'unavailable' };
    return value as ReturnType<typeof controlWindowsRuntime>;
  } catch {
    return { state: 'unavailable' };
  }
}

/** 查询当前 token 对应的活跃 helper；跨重启恢复不依赖可复用的裸 PID。 */
export function inspectWindowsRuntimeIdentity(token: string, pid?: number): ReturnType<typeof controlWindowsRuntime> {
  return controlWindowsRuntime(token, pid, 'inspect');
}

/** 身份与停止在同一受保护管道中完成，消除验证后 PID 被复用的竞争。 */
export function stopWindowsRuntimeIdentity(token: string, pid: number): void {
  const result = controlWindowsRuntime(token, pid, 'stop');
  if (result.state !== 'verified' && result.state !== 'not_found') throw new Error('Windows 进程身份无法验证，未停止任何进程。');
}
