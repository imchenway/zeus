import type { CuaDriverLike, PrivateWorkerOptions } from '@trycua/cua-driver';
import { computerSdkUrl } from './computerSdk.js';

/** 此入口只能由 Electron 的专用 utility process 执行。 */
const parent = process.parentPort;
if (!parent) throw new Error('Computer SDK 仅允许在专用后台进程运行。');
/** 用户内容无关的第三方遥测始终关闭。 */
process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false';
/** 官方 SDK 保留全部原生协议、授权边界和响应结构。 */
let driver: (CuaDriverLike & { uniffiDestroy?: () => void }) | null = null;
/** 可接受的方法只覆盖宿主的实际调用。 */
const methods = new Set(['callTool', 'metadata', 'startSession', 'endSession', 'listApps', 'listWindows', 'getAgentCursorState', 'shutdown']);
/** 请求内的 AbortController 不跨会话复用。 */
const controllers = new Map<number, AbortController>();
/** 生命周期与工具共用原生串行通道，取消后的清理必须排在真实操作完成之后。 */
let operationTail: Promise<void> = Promise.resolve();

parent.on('message', ({ data }: { data: unknown }) => {
  if (!data || typeof data !== 'object') return;
  /** 私有父子通道仍校验身份和方法，不开放任意对象调用。 */
  const request = data as { id?: unknown; method?: unknown; args?: unknown; abort?: unknown };
  if (typeof request.id !== 'number' || !Number.isSafeInteger(request.id) || request.id <= 0) return;
  if (request.abort === true) {
    controllers.get(request.id)?.abort();
    return;
  }
  if (typeof request.method !== 'string' || (request.method !== 'initialize' && !methods.has(request.method)) || !Array.isArray(request.args) || request.args.length > 2) return;
  /** 排队时登记取消身份，尚未派发的请求可以直接撤销。 */
  const controller = new AbortController();
  controllers.set(request.id, controller);
  /** 先固定已校验参数，异步队列不再读取可变消息。 */
  const { id, method, args } = request;
  operationTail = operationTail.then(() => invoke(id, method, args, controller));
});

/** SDK 同步初始化留在本进程；主线程停止时可直接退出本进程。 */
async function invoke(id: number, method: string, args: unknown[], controller: AbortController): Promise<void> {
  try {
    if (controller.signal.aborted) throw Object.assign(new Error('CUA SDK 排队请求已取消。'), { name: 'AbortError' });
    if (method === 'initialize') {
      if (driver) throw new Error('CUA SDK 已初始化。');
      /** 只接受父进程生成的固定私有 worker 配置。 */
      const cua = (await import(computerSdkUrl('@trycua/cua-driver'))) as typeof import('@trycua/cua-driver');
      driver = cua.CuaDriver.createPrivateWorker(cua.PrivateWorkerOptions.new(args[0] as PrivateWorkerOptions));
      parent.postMessage({ id, result: null, available: driver.isAvailable() });
      return;
    }
    if (!driver) throw new Error('CUA SDK 尚未初始化。');
    /** 白名单方法均为官方 SDK 的异步入口，参数在 SDK 信任边界解析。 */
    const call = (driver as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method];
    /** 已派发输入由宿主原生取消信号停止；等待真实回复后再清理，避免 SDK 提前拒绝导致生命周期请求越序。 */
    const result = await call.apply(driver, args);
    parent.postMessage({ id, result, available: method !== 'shutdown' && driver.isAvailable() });
    if (method === 'shutdown') {
      driver.uniffiDestroy?.();
      driver = null;
    }
  } catch (error) {
    /** 错误保留官方 tag 与完成状态，不包含调用参数或堆栈。 */
    const source = error && typeof error === 'object' ? (error as { tag?: string; inner?: unknown }) : {};
    parent.postMessage({ id, error: { message: error instanceof Error ? error.message : String(error), tag: source.tag, inner: source.inner }, available: driver?.isAvailable() ?? false });
  } finally {
    controllers.delete(id);
  }
}
