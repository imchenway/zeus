#!/usr/bin/env node
/* global clearTimeout, process, setTimeout */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { createCodexProviderRuntimeHealthReader, createConfiguredModelDefinition, createPiRuntimeWorkerDriver } from '../packages/ai-runtime/dist/index.js';

const temporaryRoot = await mkdtemp(join(tmpdir(), 'zeus-pi-worker-probe-'));
const sockets = new Set();
let providerRequestCount = 0;
let observeProviderRequest;
const providerRequestObserved = new Promise((resolve) => {
  observeProviderRequest = resolve;
});
const server = createServer((request) => {
  providerRequestCount += 1;
  const chunks = [];
  request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    observeProviderRequest(body ? JSON.parse(body) : {});
  });
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') throw new Error('Pi Worker 行为探针无法建立本机 Provider 端点。');

const model = createConfiguredModelDefinition('probe-model', {
  displayName: 'Probe Model',
  runtimeAdapter: 'pi_sdk',
  protocolFamily: 'openai_completions',
  authenticationScheme: 'bearer',
  enabled: true,
  contextWindow: 32_768,
  maxTokens: 1_024,
});
const connection = {
  id: 'probe-connection',
  name: 'Probe Connection',
  templateId: 'custom',
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  modelsPath: '/models',
  enabled: true,
  apiKeyConfigured: true,
  apiKey: 'probe-credential-never-log',
  models: [model],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
const runtimeErrors = [];
const providerTraceIdentity = '66666666-6666-4666-8666-666666666666';
let durableAcceptanceCount = 0;
let providerWriteBoundaryCount = 0;
let providerPayloadCount = 0;
const driver = createPiRuntimeWorkerDriver({
  adapterVersion: 'zeus-pi-worker-probe',
  agentDirectory: join(temporaryRoot, 'agent'),
  sessionDirectory: join(temporaryRoot, 'sessions'),
  loadConnections: async () => [connection],
  toolBroker: {
    execute: async () => {
      throw new Error('行为探针不允许执行工具。');
    },
  },
});
driver.subscribe((event) => {
  if (event.type === 'runtime_error') runtimeErrors.push(event);
});

try {
  const session = await driver.openSession({
    cwd: temporaryRoot,
    model: { sourceId: connection.id, modelId: model.id, displayName: model.displayName },
  });
  const run = await driver.startRun({
    session,
    traceIdentity: providerTraceIdentity,
    content: '只用于本机 Worker 故障边界探针。',
    clientRequestId: 'pi-worker-probe-request',
    applicationContext: {
      fingerprint: 'a'.repeat(64),
      manifest: '{"probe":"ZEUS_CONTEXT_MANIFEST_PROBE"}',
      content: 'ZEUS_APPLICATION_CONTEXT_PROBE',
    },
    untrustedContext: {
      fingerprint: 'a'.repeat(64),
      content: 'ZEUS_UNTRUSTED_CONTEXT_PROBE',
    },
    durableTransactionSync: () => {
      durableAcceptanceCount += 1;
    },
    providerWriteMayStart: () => {
      providerWriteBoundaryCount += 1;
    },
    providerPayloadObserved: () => {
      providerPayloadCount += 1;
    },
  });
  const providerRequest = await within(providerRequestObserved, 10_000, '本机 Provider 请求未出现');
  const providerMessages = Array.isArray(providerRequest.messages) ? providerRequest.messages : [];
  const systemPayload = JSON.stringify({ system: providerRequest.system ?? null, messages: providerMessages.filter((message) => message?.role === 'system' || message?.role === 'developer') });
  const userPayload = JSON.stringify(providerMessages.filter((message) => message?.role === 'user'));
  assert(systemPayload.includes('ZEUS_CONTEXT_MANIFEST_PROBE') && systemPayload.includes('ZEUS_APPLICATION_CONTEXT_PROBE'), 'application context 必须进入 Pi 正式 system/application 通道');
  assert(!systemPayload.includes('ZEUS_UNTRUSTED_CONTEXT_PROBE'), 'untrusted context 禁止进入 Pi system/application 通道');
  assert(userPayload.includes('ZEUS_UNTRUSTED_CONTEXT_PROBE') && userPayload.includes('ZEUS_UNTRUSTED_CONTEXT'), 'untrusted context 必须保留在当前 user 边界');
  const beforeCrash = driver.getRuntimeHealth();
  if (!beforeCrash.processId) throw new Error('Pi Worker 健康快照缺少进程 ID。');
  process.kill(beforeCrash.processId, 'SIGKILL');
  await waitUntil(() => driver.getRuntimeHealth().circuit.state === 'open', 10_000, 'Pi Worker 崩溃后没有打开熔断');
  await waitUntil(() => runtimeErrors.some((event) => event.nativeRunId === run.nativeRunId && event.payload?.code === 'ZEUS_PROVIDER_WORKER_RESULT_UNKNOWN'), 10_000, '活动轮次没有收敛为结果未知');

  const codexHealth = createCodexProviderRuntimeHealthReader({
    getState: () => ({
      type: 'ready',
      generationId: 'codex-probe-generation',
      capabilities: { generationId: 'codex-probe-generation', initializedAt: new Date(0).toISOString(), models: [], supportedModels: [], goals: { supported: false, enabled: false, stage: null } },
    }),
  });
  const codexBefore = codexHealth.getRuntimeHealth();
  await Promise.resolve();
  const recovered = await driver.recoverRuntime({ reason: 'explicit_user_action' });
  const snapshot = await driver.readSession({ session });
  const codexAfter = codexHealth.getRuntimeHealth();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert(durableAcceptanceCount === 1, '持久接纳回调必须且只能执行一次');
  assert(providerWriteBoundaryCount === 1, 'Provider 写入边界必须且只能执行一次');
  assert(providerPayloadCount === 1, 'Provider 请求体观察必须且只能执行一次');
  assert(providerRequestCount === 1, 'Worker 恢复不得重发结果未知的 Provider 请求');
  assert(snapshot.session.nativeSessionId === session.nativeSessionId, '恢复后 nativeSessionId 必须保持不变');
  assert(snapshot.session.nativeSessionPath === session.nativeSessionPath, '恢复后 nativeSessionPath 必须保持不变');
  assert(snapshot.session.runtimeInstanceId !== session.runtimeInstanceId, '显式恢复必须创建新的 Worker generation');
  assert(recovered.circuit.state === 'closed' && recovered.lifecycle === 'healthy', '显式恢复后 Worker 必须回到健康闭合状态');
  assert(codexBefore.lifecycle === 'healthy' && codexAfter.generationId === codexBefore.generationId, 'Pi Worker 故障不得改变其他 Provider 健康状态');

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      providerRequestCount,
      durableAcceptanceCount,
      providerWriteBoundaryCount,
      providerPayloadCount,
      unknownRuntimeEvent: true,
      nativeSessionIdPreserved: true,
      nativeSessionPathPreserved: true,
      generationChanged: true,
      otherProviderHealthy: true,
      applicationContextInSystem: true,
      untrustedContextInUser: true,
      providerTraceIdentity,
      workerRpcTraceMatched: true,
    })}\n`,
  );
} finally {
  await driver.close({ mode: 'final' }).catch(() => undefined);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function within(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
