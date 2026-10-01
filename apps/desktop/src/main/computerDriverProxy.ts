import { utilityProcess, type UtilityProcess } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { timingSafeEqual } from 'node:crypto';
import type { CuaDriverLike, PrivateWorkerOptions } from '@trycua/cua-driver';

/** 原生只读回调的固定通知，不包含截图、输入内容或任意操作。 */
export type ComputerControlEvent = {
  /** 原生 worker 的真实进程身份，由宿主再次核对。 */
  workerPid: number;
  /** 实际停止共享或被用户接管的应用身份。 */
  pid: number;
  /** 仅允许原生输入闸门已处理的暂停原因。 */
  reason: 'ZEUS_COMPUTER_USER_CONTROL' | 'ZEUS_COMPUTER_SHARING_STOPPED';
  /** 只统计其他应用键盘事件，用于实机验收；不包含键盘内容。 */
  otherKeyboardEvents: number;
};

/** 只转发宿主实际使用的官方 SDK 方法，禁止开放任意原生调用。 */
export type ComputerDriver = Pick<CuaDriverLike, 'callTool' | 'metadata' | 'startSession' | 'endSession' | 'listApps' | 'listWindows' | 'getAgentCursorState' | 'shutdown' | 'isAvailable'> & {
  /** SDK 所在后台进程，用于核对原生 worker 父进程。 */
  readonly workerParentPid?: number;
  /** 停止后释放本任务后台进程。 */
  uniffiDestroy?: () => void;
};

/** 官方 SDK 的同步初始化和等待留在专用进程，Electron 主线程保持可停止。 */
export class ComputerDriverProxy implements ComputerDriver {
  /** 当前任务独占的 SDK 进程。 */
  private readonly child: UtilityProcess;
  /** 正在等待的有界请求；取消后迟到回复直接丢弃。 */
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** 本进程通道内的请求身份。 */
  private nextId = 0;
  /** 退出后不允许向其他进程或重建实例投递迟到命令。 */
  private closed = false;
  /** 官方 SDK 在正常回复中报告的实际 worker 健康状态。 */
  private available = false;
  /** UTF-8 跨数据块解码，不把系统错误日志转成产品指令。 */
  private readonly eventDecoder = new StringDecoder('utf8');
  /** 私有通知一行最多四千字符，超长日志直接丢弃。 */
  private eventLine = '';
  /** 丢弃超长行时等待真正换行，不能截断后重新识别前缀。 */
  private discardingEventLine = false;
  /** 当前私有进程的通知密钥，不能持久化或投影到工具结果。 */
  private readonly eventToken: Buffer | null;
  /** 最近一个已校验通知，仅供本任务实时诊断，不保存私有密钥。 */
  private latestControlEvent: ComputerControlEvent | null = null;

  /** 环境只含系统必需项和遥测策略，不继承 Provider 凭据。 */
  constructor(
    private readonly options: PrivateWorkerOptions,
    private readonly onControlEvent?: (event: ComputerControlEvent) => void,
  ) {
    /** 仅接受宿主生成的完整随机密钥；缺少密钥时禁止通知改变产品状态。 */
    const token = options.environment.find((entry) => entry.name === 'ZEUS_CUA_EVENT_TOKEN')?.value;
    this.eventToken = token && /^[a-f0-9]{64}$/u.test(token) ? Buffer.from(token, 'hex') : null;
    this.child = utilityProcess.fork(resolve(import.meta.dirname, 'computerDriverWorker.js'), [], {
      serviceName: 'Zeus Computer Runtime',
      env: Object.fromEntries(options.environment.map(({ name, value }) => [name, value])),
      stdio: 'pipe',
    });
    this.child.stdout?.resume();
    this.child.stderr?.on('data', (chunk: Buffer) => this.receiveControlEvents(this.eventDecoder.write(chunk)));
    this.child.on('spawn', () => {
      if (this.closed) this.child.kill();
    });
    this.child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      /** 通道回复必须匹配当前等待请求，不能把迟到动作当成新动作。 */
      const reply = message as { id?: unknown; result?: unknown; error?: { message: string; tag?: string; inner?: unknown }; available?: boolean };
      if (typeof reply.id !== 'number') return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      if (typeof reply.available === 'boolean') this.available = reply.available;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(Object.assign(new Error(reply.error.message), { tag: reply.error.tag, inner: reply.error.inner }));
      else pending.resolve(reply.result);
    });
    this.child.once('exit', (code) => this.failAll(`CUA SDK 后台进程已退出：code=${code}`));
  }

  /** 只解析本 SDK 子进程继承的固定元数据通知，其他日志不保留、不广播。 */
  private receiveControlEvents(chunk: string): void {
    for (const character of chunk) {
      if (character !== '\n') {
        if (!this.discardingEventLine) {
          this.eventLine += character;
          if (this.eventLine.length > 4_096) {
            this.eventLine = '';
            this.discardingEventLine = true;
          }
        }
        continue;
      }
      /** 仅完整、长度受限且具有固定前缀的行才有通知资格。 */
      const line = this.eventLine;
      this.eventLine = '';
      if (this.discardingEventLine) {
        this.discardingEventLine = false;
        continue;
      }
      if (this.closed || !line.startsWith('_ZEUS_COMPUTER_EVENT_ ')) continue;
      try {
        /** 子进程内容仍校验类型及正整数 PID，不开放动态方法。 */
        const event: unknown = JSON.parse(line.slice('_ZEUS_COMPUTER_EVENT_ '.length));
        if (!event || typeof event !== 'object') continue;
        /** 白名单投影后再交给宿主，不能附带其他控制字段。 */
        const { workerPid, pid, reason, token, otherKeyboardEvents } = event as Record<string, unknown>;
        if (!this.eventToken || typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token) || !timingSafeEqual(this.eventToken, Buffer.from(token, 'hex'))) continue;
        if (!Number.isSafeInteger(workerPid) || (workerPid as number) <= 0 || !Number.isSafeInteger(pid) || (pid as number) <= 0 || (reason !== 'ZEUS_COMPUTER_USER_CONTROL' && reason !== 'ZEUS_COMPUTER_SHARING_STOPPED')) continue;
        if (!Number.isSafeInteger(otherKeyboardEvents) || (otherKeyboardEvents as number) < 0) continue;
        this.latestControlEvent = { workerPid: workerPid as number, pid: pid as number, reason, otherKeyboardEvents: otherKeyboardEvents as number };
        this.onControlEvent?.(this.latestControlEvent);
      } catch {
        /* 非本协议日志或不完整 JSON 不产生产品状态。 */
      }
    }
  }

  /** 实时诊断取得经过验证的事件副本，不提供密钥或原始日志。 */
  get lastControlEvent(): ComputerControlEvent | null {
    return this.latestControlEvent ? { ...this.latestControlEvent } : null;
  }

  /** SDK 子进程身份在 Electron 的真实 spawn 之后可用。 */
  get workerParentPid(): number | undefined {
    return this.child.pid;
  }

  /** 官方私有 worker 初始化也通过异步通道，停止不受同步 FFI 阻塞。 */
  async initialize(): Promise<void> {
    await this.request('initialize', [this.options]);
  }

  /** 原样保留官方工具内容与动作结果。 */
  callTool(...args: Parameters<CuaDriverLike['callTool']>): ReturnType<CuaDriverLike['callTool']> {
    return this.request('callTool', args.slice(0, 2), args[2]?.signal) as ReturnType<CuaDriverLike['callTool']>;
  }
  /** 获取原生 worker 实际身份。 */
  metadata(...args: Parameters<CuaDriverLike['metadata']>): ReturnType<CuaDriverLike['metadata']> {
    return this.request('metadata', [], args[0]?.signal) as ReturnType<CuaDriverLike['metadata']>;
  }
  /** 创建官方命名会话。 */
  startSession(...args: Parameters<CuaDriverLike['startSession']>): ReturnType<CuaDriverLike['startSession']> {
    return this.request('startSession', args.slice(0, 1), args[1]?.signal) as ReturnType<CuaDriverLike['startSession']>;
  }
  /** 结束命名会话并释放虚拟输入。 */
  endSession(...args: Parameters<CuaDriverLike['endSession']>): ReturnType<CuaDriverLike['endSession']> {
    return this.request('endSession', args.slice(0, 1), args[1]?.signal) as ReturnType<CuaDriverLike['endSession']>;
  }
  /** 应用发现沿用官方 SDK，不自行扫描或启动应用。 */
  listApps(...args: Parameters<CuaDriverLike['listApps']>): ReturnType<CuaDriverLike['listApps']> {
    return this.request('listApps', args.slice(0, 1), args[1]?.signal) as ReturnType<CuaDriverLike['listApps']>;
  }
  /** 真实运行检查只读取本任务的原生窗口。 */
  listWindows(...args: Parameters<CuaDriverLike['listWindows']>): ReturnType<CuaDriverLike['listWindows']> {
    return this.request('listWindows', args.slice(0, 1), args[1]?.signal) as ReturnType<CuaDriverLike['listWindows']>;
  }
  /** 读取官方会话光标状态，不能替代可见画面验收。 */
  getAgentCursorState(...args: Parameters<CuaDriverLike['getAgentCursorState']>): ReturnType<CuaDriverLike['getAgentCursorState']> {
    return this.request('getAgentCursorState', args.slice(0, 1), args[1]?.signal) as ReturnType<CuaDriverLike['getAgentCursorState']>;
  }
  /** 健康值由已完成的原生回复维护，不在主线程调用同步 FFI。 */
  isAvailable(): boolean {
    return !this.closed && this.available;
  }
  /** 官方正常关闭完成后退出 SDK 进程。 */
  async shutdown(): Promise<void> {
    try {
      await this.request('shutdown', []);
    } finally {
      this.uniffiDestroy();
    }
  }
  /** 仅结束本任务 SDK 进程，重复调用无副作用。 */
  uniffiDestroy(): void {
    if (!this.closed) {
      this.failAll('CUA SDK 后台进程已停止。');
      this.child.kill();
    }
  }

  /** 启动卡住时核对父进程及可执行路径，再退出尚未接收输入的原生子进程。 */
  async abortStartup(): Promise<void> {
    try {
      if (this.child.pid) {
        /** comm 不包含命令参数或环境凭据。 */
        const processes = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 1_500 });
        for (const line of processes.stdout.split('\n')) {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
          if (Number(match?.[2]) === this.child.pid && match?.[3] === resolve(dirname(this.options.binaryPath), 'cua-driver')) {
            try {
              process.kill(Number(match[1]), 'SIGTERM');
            } catch {
              /* 该原生子进程已退出。 */
            }
          }
        }
      }
    } finally {
      this.uniffiDestroy();
    }
  }

  /** 进程退出与主动停止统一拒绝等待，不重发任何未知输入。 */
  private failAll(message: string): void {
    this.closed = true;
    this.available = false;
    for (const pending of this.pending.values()) pending.reject(Object.assign(new Error(message), { tag: 'Worker' }));
    this.pending.clear();
  }

  /** 仅发送固定 SDK 方法和参数，取消消息只作用于同一请求身份。 */
  private async request(method: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw Object.assign(new Error('CUA SDK 后台进程已停止。'), { tag: 'Shutdown' });
    /** 同一通道中单调增加的身份，禁止串轮次取消。 */
    const id = ++this.nextId;
    /** 取消只撤销本请求，原生释放由宿主 SIGUSR1 和官方生命周期完成。 */
    const abort = (): void => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(Object.assign(new Error('CUA SDK 请求已取消。'), { name: 'AbortError' }));
      if (!this.closed) this.child.postMessage({ id, abort: true });
    };
    try {
      return await new Promise((resolveRequest, reject) => {
        this.pending.set(id, { resolve: resolveRequest, reject });
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        this.child.postMessage({ id, method, args });
      });
    } finally {
      signal?.removeEventListener('abort', abort);
      this.pending.delete(id);
    }
  }
}
