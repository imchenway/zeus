import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { parsePerformanceTraceIdentity } from '../packages/shared/src/commandEnvelope.js';
import { LocalApiPerformanceCollector } from '../packages/local-server/src/performanceObservability.js';
import { DatabasePerformanceCollector } from '../packages/storage/dist/databasePerformance.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-performance-trace-'));
const databasePath = join(probeRoot, 'trace-probe.db');
const database = new DatabaseSync(databasePath);
const databasePerformance = new DatabasePerformanceCollector(databasePath, 5);
const apiPerformance = new LocalApiPerformanceCollector(5);
const server = Fastify({ logger: false });

const alphaTraceId = '11111111-1111-4111-8111-111111111111';
const bravoTraceId = '22222222-2222-4222-8222-222222222222';
const hostileTraceHeader = 'customer_email_alice_example_com';
const abandonedTraceId = '33333333-3333-4333-8333-333333333333';
const sqlBodySecret = 'SQL_BODY_MUST_NOT_BE_RETAINED';
const parameterSecrets = {
  alpha: 'PARAMETER_ALPHA_MUST_NOT_BE_RETAINED',
  bravo: 'PARAMETER_BRAVO_MUST_NOT_BE_RETAINED',
} as const;
const selectSql = {
  alpha: `SELECT marker, '${sqlBodySecret}' AS sql_secret FROM trace_probe_alpha WHERE marker = ?`,
  bravo: `SELECT marker, '${sqlBodySecret}' AS sql_secret FROM trace_probe_bravo WHERE marker = ?`,
} as const;
let arrivedAtBarrier = 0;
let releaseBarrier: (() => void) | null = null;
const barrier = new Promise<void>((resolve) => {
  releaseBarrier = resolve;
});
let signalAbortHandlerStarted: (() => void) | null = null;
const abortHandlerStarted = new Promise<void>((resolve) => {
  signalAbortHandlerStarted = resolve;
});

try {
  assertBehavior(parsePerformanceTraceIdentity(alphaTraceId.toUpperCase()) === alphaTraceId, 'Command trace identity 必须规范化为小写 UUID。');
  assertBehavior(captureTraceIdentityError(hostileTraceHeader) === 'ZEUS_COMMAND_ENVELOPE_INVALID', 'CommandEnvelope 不得接纳含调用方载荷的 trace identity。');
  database.exec('CREATE TABLE trace_probe_alpha (marker TEXT PRIMARY KEY) STRICT; CREATE TABLE trace_probe_bravo (marker TEXT PRIMARY KEY) STRICT');
  database.prepare('INSERT INTO trace_probe_alpha(marker) VALUES (?)').run(parameterSecrets.alpha);
  database.prepare('INSERT INTO trace_probe_bravo(marker) VALUES (?)').run(parameterSecrets.bravo);

  server.addHook('onRequest', async (request, reply) => {
    apiPerformance.begin(request, reply);
  });
  server.addHook('onSend', async (request, reply, payload) => {
    apiPerformance.capturePayload(request, reply, payload);
    return payload;
  });
  server.addHook('onResponse', async (request, reply) => {
    apiPerformance.finish(request, reply);
  });
  server.get<{ Params: { identity: keyof typeof parameterSecrets } }>('/probe/:identity', async (request) => {
    const parameterSecret = parameterSecrets[request.params.identity];
    assertBehavior(typeof parameterSecret === 'string', '行为路由收到未知探针身份。');
    readMarker(request.params.identity);
    arrivedAtBarrier += 1;
    if (arrivedAtBarrier === 2) releaseBarrier?.();
    await barrier;
    await new Promise<void>((resolve) => setImmediate(resolve));
    readMarker(request.params.identity);
    return { ok: true, identity: request.params.identity };
  });
  server.get('/hostile-trace', async () => {
    readMarker('alpha');
    return { ok: true };
  });
  server.get('/abort-trace', async () => {
    signalAbortHandlerStarted?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    return { ok: true };
  });
  server.get('/after-abort', async () => ({ ok: true }));

  const [alphaResponse, bravoResponse] = await Promise.all([
    server.inject({ method: 'GET', url: '/probe/alpha', headers: { 'x-zeus-trace-id': alphaTraceId } }),
    server.inject({ method: 'GET', url: '/probe/bravo', headers: { 'x-zeus-trace-id': bravoTraceId } }),
  ]);
  assertBehavior(alphaResponse.statusCode === 200 && bravoResponse.statusCode === 200, '两个并发 Fastify 请求必须成功。');
  assertBehavior(alphaResponse.headers['x-zeus-trace-id'] === alphaTraceId, 'alpha 响应没有回传原始有效 trace identity。');
  assertBehavior(bravoResponse.headers['x-zeus-trace-id'] === bravoTraceId, 'bravo 响应没有回传原始有效 trace identity。');

  // 当前调用不在任何 Fastify request async scope 中，必须明确记录为 null。
  readMarker('alpha');
  const tracedSnapshot = snapshotDatabasePerformance(10);
  const alphaSamples = tracedSnapshot.recent.filter((sample) => sample.traceId === alphaTraceId);
  const bravoSamples = tracedSnapshot.recent.filter((sample) => sample.traceId === bravoTraceId);
  const backgroundSamples = tracedSnapshot.recent.filter((sample) => sample.traceId === null);
  assertBehavior(alphaSamples.length === 2, `alpha trace 样本数错误：${alphaSamples.length}`);
  assertBehavior(bravoSamples.length === 2, `bravo trace 样本数错误：${bravoSamples.length}`);
  assertBehavior(backgroundSamples.length === 1, `后台查询必须且只能产生一个 null trace 样本：${backgroundSamples.length}`);
  assertBehavior(
    alphaSamples.every((sample) => sample.statementTarget === 'trace_probe_alpha'),
    'alpha SQLite 查询被另一个请求的 trace identity 接管。',
  );
  assertBehavior(
    bravoSamples.every((sample) => sample.statementTarget === 'trace_probe_bravo'),
    'bravo SQLite 查询被另一个请求的 trace identity 接管。',
  );
  assertBehavior(backgroundSamples[0]?.statementTarget === 'trace_probe_alpha', '无 trace 的后台查询目标与探针预期不一致。');
  assertBehavior(
    tracedSnapshot.recent.every((sample) => sample.traceId === alphaTraceId || sample.traceId === bravoTraceId || sample.traceId === null),
    'SQLite 样本出现跨请求污染的未知 trace identity。',
  );

  const hostileResponse = await server.inject({ method: 'GET', url: '/hostile-trace', headers: { 'x-zeus-trace-id': hostileTraceHeader } });
  const sanitizedTraceId = String(hostileResponse.headers['x-zeus-trace-id'] ?? '');
  assertBehavior(hostileResponse.statusCode === 200 && sanitizedTraceId !== hostileTraceHeader, '含调用方载荷的 trace header 必须由 Core 替换。');
  assertBehavior(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sanitizedTraceId), 'Core 替换后的 trace identity 必须是规范 UUID。');
  const hostileSqliteSnapshot = snapshotDatabasePerformance(10);
  const hostileApiSnapshot = apiPerformance.snapshot({ recentLimit: 10 });
  assertBehavior(!JSON.stringify(hostileSqliteSnapshot).includes(hostileTraceHeader), 'SQLite 观测投影保留了不可信 trace header 载荷。');
  assertBehavior(!JSON.stringify(hostileApiSnapshot).includes(hostileTraceHeader), 'API 观测投影保留了不可信 trace header 载荷。');

  const listeningAddress = await server.listen({ host: '127.0.0.1', port: 0 });
  const abandonedRequest = httpRequest(`${listeningAddress}/abort-trace`, { headers: { 'x-zeus-trace-id': abandonedTraceId } });
  const abandonedRequestClosed = new Promise<void>((resolve) => {
    abandonedRequest.once('error', () => resolve());
    abandonedRequest.once('close', () => resolve());
  });
  abandonedRequest.end();
  await abortHandlerStarted;
  abandonedRequest.destroy();
  await abandonedRequestClosed;
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  const afterAbortResponse = await server.inject({ method: 'GET', url: '/after-abort', headers: { 'x-zeus-trace-id': abandonedTraceId } });
  assertBehavior(afterAbortResponse.headers['x-zeus-trace-id'] === abandonedTraceId, '客户端断连后 trace identity 未释放，活动身份集合发生泄漏。');

  const serializedTracedSnapshot = JSON.stringify(hostileSqliteSnapshot);
  const serializedApiSnapshot = JSON.stringify(hostileApiSnapshot);
  for (const secret of [sqlBodySecret, parameterSecrets.alpha, parameterSecrets.bravo, selectSql.alpha, selectSql.bravo]) {
    assertBehavior(!serializedTracedSnapshot.includes(secret), `SQLite 观测样本泄露 SQL 或参数正文：${secret}`);
    assertBehavior(!serializedApiSnapshot.includes(secret), `API 观测样本泄露请求或响应正文：${secret}`);
  }
  assertBehavior(
    tracedSnapshot.recent.every(
      (sample) => Object.keys(sample).sort().join(',') === ['completedAt', 'durationMs', 'operation', 'returnedOrChangedRows', 'scannedRows', 'sqlFingerprint', 'statementKind', 'statementTarget', 'success', 'traceId'].sort().join(','),
    ),
    'SQLite 样本字段集合出现未登记正文或动态载荷。',
  );

  for (let index = 0; index < 12; index += 1) readMarker('alpha');
  const boundedSnapshot = snapshotDatabasePerformance(500);
  assertBehavior(boundedSnapshot.capacity === 5 && boundedSnapshot.capturedSampleCount === 5 && boundedSnapshot.recent.length === 5, 'SQLite 观测样本没有按固定容量淘汰。');
  const boundedApiSnapshot = apiPerformance.snapshot({ recentLimit: 500 });
  assertBehavior(boundedApiSnapshot.capacity === 5 && boundedApiSnapshot.capturedSampleCount === 4 && boundedApiSnapshot.recent.length === 4, 'API 观测样本容量或请求计数错误。');

  console.log(
    JSON.stringify(
      {
        status: 'passed',
        observed: {
          concurrentTraceSamples: { [alphaTraceId]: alphaSamples.length, [bravoTraceId]: bravoSamples.length },
          backgroundTraceId: backgroundSamples[0]?.traceId ?? null,
          sqliteCapacity: boundedSnapshot.capacity,
          sqliteCapturedSamples: boundedSnapshot.capturedSampleCount,
          apiCapturedSamples: boundedApiSnapshot.capturedSampleCount,
          hostileTraceHeaderRetained: false,
          abandonedTraceIdentityReleased: true,
          retainedFields: Object.keys(tracedSnapshot.recent[0] ?? {}).sort(),
          sqlOrParameterBodyRetained: false,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await server.close().catch(() => undefined);
  apiPerformance.close();
  database.close();
  await rm(probeRoot, { recursive: true, force: true });
}

function readMarker(identity: keyof typeof parameterSecrets): void {
  const marker = parameterSecrets[identity];
  const sql = selectSql[identity];
  const result = databasePerformance.measureSql(
    'select',
    sql,
    () => database.prepare(sql).get(marker) as { marker?: unknown } | undefined,
    (row) => (row ? 1 : 0),
  );
  assertBehavior(result?.marker === marker, 'SQLite 行为探针没有读回精确参数。');
}

function snapshotDatabasePerformance(recentLimit: number) {
  return databasePerformance.snapshot({ pageCount: 1, pageSizeBytes: 4_096, freePageCount: 0 }, { recentLimit });
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ZARCH 性能 trace 行为核验失败：${message}`);
}

function captureTraceIdentityError(value: unknown): string | null {
  try {
    parsePerformanceTraceIdentity(value);
    return null;
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : String(error);
  }
}
