import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeExecutionHostResources, type ExecutionHostCloseResources } from '../apps/desktop/src/main/executionHostClosePlan.js';
import { closeLocalHttpServer } from '../apps/desktop/src/main/closeLocalHttpServer.js';
import { createBeforeQuitCleanupHandler } from '../apps/desktop/src/main/beforeQuitCleanup.js';

const successCalls: string[] = [];
await closeExecutionHostResources(resources(successCalls));
assert.deepEqual(successCalls, ['record-closing', 'runtime', 'control', 'rendezvous', 'startup', 'identity', 'lease', 'record-closed']);

const runtimeFailureCalls: string[] = [];
await assert.rejects(
  closeExecutionHostResources(
    resources(runtimeFailureCalls, {
      runtime: new Error('runtime close failed'),
    }),
  ),
  (error: unknown) =>
    error instanceof AggregateError && error.errors.some((entry) => entry instanceof Error && entry.message === 'closeRuntime: runtime close failed' && entry.cause instanceof Error && entry.cause.message === 'runtime close failed'),
);
assert.deepEqual(runtimeFailureCalls, ['record-closing', 'runtime', 'control']);

const cleanupFailureCalls: string[] = [];
await assert.rejects(
  closeExecutionHostResources(
    resources(cleanupFailureCalls, {
      rendezvous: new Error('rendezvous cleanup failed'),
      startup: new Error('startup cleanup failed'),
    }),
  ),
  (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
);
assert.deepEqual(cleanupFailureCalls, ['record-closing', 'runtime', 'control', 'rendezvous', 'startup', 'identity', 'lease', 'record-closed']);

// 真实回环连接故意不完成请求体：退出不能等待调用方继续发送或关闭连接。
await verifyPendingConnectionQuit();

process.stdout.write('Execution Host close plan verified: cleanup is best-effort; runtime failure retains identity/lease and all callers can exit non-zero.\n');

/** 通过实际 HTTP 连接核对正式退出能到达 exitApp，并且重复退出不会重复清理。 */
async function verifyPendingConnectionQuit(): Promise<void> {
  /** 不返回响应，保留仍在读取请求体的活动连接。 */
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  /** 只访问此检查刚创建的随机回环端口。 */
  const address = server.address() as AddressInfo;
  /** 请求到达后才开始退出，避免误把无活动连接的关闭当作通过。 */
  const received = once(server, 'request');
  /** 声明两字节正文，但只发送一字节并保持连接。 */
  const client = request({ host: '127.0.0.1', port: address.port, method: 'POST', headers: { 'content-length': '2' } });
  // 退出主动断开连接是预期结果，不自动重发请求。
  client.on('error', () => undefined);
  client.write('{');
  await received;
  /** 退出回调超时必须失败，不能通过结束检查进程伪造退出完成。 */
  let deadline: ReturnType<typeof setTimeout> | undefined;
  /** 同一退出请求只能执行一次资源关闭。 */
  let closes = 0;
  try {
    /** 复用 Main 的实际退出控制器，检查到达的退出码。 */
    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      deadline = setTimeout(() => rejectExit(new Error('活动 HTTP 连接阻塞了正式退出')), 2_000);
      /** 只替换应用出口，不退出执行检查的 Node 进程。 */
      const quit = createBeforeQuitCleanupHandler({
        closeLocalServer: async () => {
          closes += 1;
          await closeLocalHttpServer(server);
        },
        exitApp: resolveExit,
        onCleanupError: (error) => {
          rejectExit(error);
          return 'keep_open';
        },
      });
      quit({ preventDefault() {} });
      quit({ preventDefault() {} });
    });
    assert.equal(exitCode, 0);
    assert.equal(closes, 1);
    assert.equal(server.listening, false);
    await closeLocalHttpServer(server);
  } finally {
    clearTimeout(deadline);
    client.destroy();
    await closeLocalHttpServer(server);
  }
}

function resources(calls: string[], failures: Partial<Record<'runtime' | 'control' | 'rendezvous' | 'startup' | 'identity' | 'lease', Error>> = {}): ExecutionHostCloseResources {
  const asynchronous = (name: keyof typeof failures | 'record-closing' | 'record-closed') => async () => {
    calls.push(name);
    const failure = failures[name as keyof typeof failures];
    if (failure) throw failure;
  };
  return {
    recordClosing: asynchronous('record-closing'),
    closeRuntime: asynchronous('runtime'),
    closeControlServer: asynchronous('control'),
    removeRendezvous: asynchronous('rendezvous'),
    removeStartupStatus: asynchronous('startup'),
    removeLockIdentity: asynchronous('identity'),
    releaseKernelLease: () => {
      calls.push('lease');
      if (failures.lease) throw failures.lease;
    },
    recordClosed: asynchronous('record-closed'),
  };
}
