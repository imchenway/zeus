import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCodexAppServerManager, type CodexAppServerProcess } from '../packages/ai-runtime/src/codexAppServerManager.js';

/** 通过完整管理器协议确认默认恢复不会误发取消订阅，也不会擦除自定义容量记录。 */
async function verifyCapacityResume(): Promise<void> {
  /** 只记录协议调用，不接触真实会话或账号。 */
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** 常驻内核中的会话独立于客户端连接存在。 */
  const threads = new Map<string, 'idle' | 'active' | 'notLoaded'>([['existing-default', 'idle']]);
  /** 精确模拟客户端断连，保留原会话加载状态。 */
  let connection: EventEmitter;
  /** 默认场景一旦误触卸载就立即失败，避免真的等待 90 秒。 */
  let allowUnload = false;
  /** 使用真实管理器，只替换协议传输。 */
  const manager = createCodexAppServerManager({
    lightweightGeneration: true,
    spawn: () => {
      /** 每个连接独立接收消息，线程记录仍由上面的常驻内核持有。 */
      const events = new EventEmitter();
      /** 模拟标准输出与诊断输出。 */
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      connection = events;
      return Object.assign(events, {
        stdout,
        stderr,
        stdin: {
          write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void) {
            /** 只处理带编号的请求；初始化通知无需回包。 */
            const request = JSON.parse(String(chunk));
            callback?.();
            if (request.id === undefined) return true;
            calls.push({ method: request.method, params: request.params });
            /** 让响应在管理器登记请求后异步到达。 */
            queueMicrotask(() => {
              try {
                /** 未涉及的启动响应保持为空，拒绝意外出现的新协议调用。 */
                let result: unknown;
                switch (request.method) {
                  case 'initialize':
                    result = { userAgent: 'capacity-probe' };
                    break;
                  case 'model/list':
                    result = { data: [{ id: 'probe-model', model: 'probe-model' }], nextCursor: null };
                    break;
                  case 'thread/start':
                    threads.set('custom-thread', 'idle');
                    result = { thread: { id: 'custom-thread', status: { type: 'idle' } }, model: 'probe-model' };
                    break;
                  case 'thread/read':
                    result = { thread: { id: request.params.threadId, status: { type: threads.get(request.params.threadId), activeFlags: [] } } };
                    break;
                  case 'thread/unsubscribe':
                    assert.ok(allowUnload, '默认恢复或未传容量不得取消订阅');
                    threads.set(request.params.threadId, 'notLoaded');
                    result = { status: 'unsubscribed' };
                    break;
                  case 'thread/resume':
                    if (threads.get(request.params.threadId) === 'notLoaded') threads.set(request.params.threadId, 'idle');
                    result = { thread: { id: request.params.threadId, status: { type: threads.get(request.params.threadId), activeFlags: [] } }, model: 'probe-model' };
                    break;
                  default:
                    throw new Error(`意外协议调用：${request.method}`);
                }
                stdout.emit('data', JSON.stringify({ id: request.id, result }) + '\n');
              } catch (error) {
                stdout.emit('data', JSON.stringify({ id: request.id, error: { code: -32603, message: String(error) } }) + '\n');
              }
            });
            return true;
          },
        },
        kill() {
          events.emit('exit', 0);
          return true;
        },
      }) as CodexAppServerProcess;
    },
  });
  try {
    await manager.ensureReady({ commandPath: process.execPath });
    calls.length = 0;
    await manager.resumeThread({ threadId: 'existing-default', contextCapacityTokens: null });
    await manager.resumeThread({ threadId: 'existing-default' });
    assert.deepEqual(
      calls.map((call) => call.method),
      ['thread/resume', 'thread/resume'],
    );

    connection!.emit('exit', 0);
    await manager.ensureReady({ commandPath: process.execPath });
    calls.length = 0;
    await manager.resumeThread({ threadId: 'existing-default', contextCapacityTokens: null });
    assert.deepEqual(
      calls.map((call) => call.method),
      ['thread/resume'],
      '默认会话重连后不得因代次变化触发卸载',
    );

    await manager.startThread({ model: 'probe-model', cwd: process.cwd(), sandbox: { type: 'readOnly', networkAccess: false }, contextCapacityTokens: 64_000 });
    calls.length = 0;
    await manager.resumeThread({ threadId: 'custom-thread' });
    await manager.resumeThread({ threadId: 'custom-thread', contextCapacityTokens: 64_000 });
    assert.deepEqual(
      calls.map((call) => call.method),
      ['thread/resume', 'thread/resume'],
      '订阅恢复不能把已知自定义容量改记为默认',
    );

    allowUnload = true;
    calls.length = 0;
    await manager.resumeThread({ threadId: 'custom-thread', contextCapacityTokens: null });
    assert.deepEqual(
      calls.map((call) => call.method),
      ['thread/read', 'thread/unsubscribe', 'thread/read', 'thread/resume'],
      '已知自定义容量改回默认仍须确认实际卸载',
    );
    calls.length = 0;
    await manager.resumeThread({ threadId: 'custom-thread', contextCapacityTokens: 128_000 });
    assert.equal(calls.filter((call) => call.method === 'thread/unsubscribe').length, 1);
    assert.equal((calls.at(-1)!.params.config as Record<string, unknown>).model_context_window, 128_000);

    allowUnload = false;
    threads.set('custom-thread', 'active');
    calls.length = 0;
    await manager.resumeThread({ threadId: 'custom-thread', contextCapacityTokens: 256_000 });
    assert.deepEqual(
      calls.map((call) => call.method),
      ['thread/read', 'thread/resume'],
      '活动会话不得被卸载',
    );
    threads.set('custom-thread', 'idle');
    allowUnload = true;
    calls.length = 0;
    await manager.resumeThread({ threadId: 'custom-thread', contextCapacityTokens: 256_000 });
    assert.equal(calls.filter((call) => call.method === 'thread/unsubscribe').length, 1, '活动期间未应用的新容量不能提前记为已生效');
    console.info('容量恢复检查通过：默认恢复、连接换代、订阅恢复、自定义切换、恢复默认及活动会话保护。');
  } finally {
    await manager.close();
  }
}

await verifyCapacityResume();
