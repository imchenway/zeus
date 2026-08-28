import { access, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProjectionDatabaseRuntimeManager, createProjectionIndexCandidate, createZeusDatabase } from '../packages/storage/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-projection-runtime-probe-'));
const databasePath = join(probeRoot, 'core.db');
const projectionDirectory = join(probeRoot, 'projections');
const sourceDatabaseIdentity = resolve(databasePath);
const observed: Record<string, unknown> = {};

try {
  const database = await createZeusDatabase(databasePath);
  let injectPromotionFailure = false;
  let runtime: ProjectionDatabaseRuntimeManager | null = null;
  try {
    database.execute(`CREATE TABLE projection_core_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`);
    database.execute(`INSERT INTO projection_core_probe (id, value) VALUES (1, 'before-projection')`);
    await database.save();

    runtime = new ProjectionDatabaseRuntimeManager({
      source: database,
      directory: projectionDirectory,
      sourceDatabaseIdentity,
      now: monotonicClock('2026-08-21T03:00:00.000Z'),
      faultInjection: {
        beforeCandidatePublish() {
          if (injectPromotionFailure) throw new Error('injected projection publication failure');
        },
      },
    });
    await runtime.start();
    const stateImmediatelyAfterMissingStart = runtime.snapshot();
    observed.missingReadFallback = runtime.index.select(`SELECT * FROM project_nodes`).length === 0 && runtime.cache.select(`SELECT * FROM cache_entries`).length === 0;
    database.execute(`INSERT INTO projection_core_probe (id, value) VALUES (2, 'while-rebuilding')`);
    await database.save();
    observed.coreWritableWhileMissing = database.get<{ value: string }>(`SELECT value FROM projection_core_probe WHERE id = 2`)?.value === 'while-rebuilding';
    observed.initialMissingState = {
      index: stateImmediatelyAfterMissingStart.index.availability,
      cache: stateImmediatelyAfterMissingStart.cache.availability,
    };

    await waitForReady(runtime, ['index', 'cache']);
    const initial = runtime.snapshot();
    observed.initialGenerations = { index: initial.index.generationId, cache: initial.cache.generationId };
    observed.backgroundRebuilt = initial.index.availability === 'ready' && initial.cache.availability === 'ready' && Boolean(initial.index.generationId) && Boolean(initial.cache.generationId);

    await runtime.enqueueIndexWrite((index) =>
      index.execute(
        `INSERT INTO project_nodes (id, project_name, node_type, name, qualified_name, source_ref, symbol_id, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['probe-node', 'probe-project', 'module', 'Probe Node', 'probe.node', 'src/probe.ts', null, '{}'],
      ),
    );
    await runtime.putCache({ namespace: 'probe', key: 'answer', payload: Buffer.from('cached'), expiresAt: '2026-08-22T00:00:00.000Z' });
    const afterWrites = runtime.snapshot();
    observed.independentWaterlines = { index: afterWrites.index.eventWaterline, cache: afterWrites.cache.eventWaterline };
    observed.cacheRoundTrip = Buffer.from(runtime.getCache('probe', 'answer', '2026-08-21T04:00:00.000Z') ?? []).toString('utf8') === 'cached';

    const firstIndexGeneration = afterWrites.index.generationId;
    const rebuilt = await runtime.rebuild('index');
    observed.generationAdvanced = rebuilt.availability === 'ready' && rebuilt.generationId !== firstIndexGeneration && rebuilt.previousAvailable;
    const rolledBack = await runtime.rollback('index');
    observed.rollbackReopenedPrevious = rolledBack.generationId === firstIndexGeneration && runtime.index.get<{ id: string }>(`SELECT id FROM project_nodes WHERE id = ?`, ['probe-node'])?.id === 'probe-node';

    const failingReceipt = await createProjectionIndexCandidate({
      source: database,
      candidatePath: join(projectionDirectory, 'injected-failure.index.candidate.db'),
      generationId: 'injected-failure-generation',
      sourceDatabaseIdentity,
      createdAt: '2026-08-21T05:00:00.000Z',
    });
    injectPromotionFailure = true;
    observed.failedSwitch = await captureFailure(() => runtime!.promote(failingReceipt));
    injectPromotionFailure = false;
    const afterFailedSwitch = runtime.snapshot().index;
    observed.failedSwitchRolledBack =
      afterFailedSwitch.availability === 'ready' &&
      afterFailedSwitch.generationId === firstIndexGeneration &&
      runtime.index.get<{ id: string }>(`SELECT id FROM project_nodes WHERE id = ?`, ['probe-node'])?.id === 'probe-node' &&
      !(await exists(failingReceipt.candidatePath));

    await runtime.close();
    runtime = null;
    await unlink(join(projectionDirectory, 'index.db'));
    await unlink(join(projectionDirectory, 'cache.db'));
    const previousGenerationIds = observed.initialGenerations as { index: string; cache: string };
    const rebuiltRuntime = new ProjectionDatabaseRuntimeManager({
      source: database,
      directory: projectionDirectory,
      sourceDatabaseIdentity,
      now: monotonicClock('2026-08-21T06:00:00.000Z'),
    });
    runtime = rebuiltRuntime;
    await rebuiltRuntime.start();
    observed.coreReadableAfterProjectionDeletion = database.get<{ value: string }>(`SELECT value FROM projection_core_probe WHERE id = 1`)?.value === 'before-projection';
    database.execute(`INSERT INTO projection_core_probe (id, value) VALUES (3, 'after-projection-delete')`);
    await database.save();
    observed.coreWritableAfterProjectionDeletion = database.get<{ value: string }>(`SELECT value FROM projection_core_probe WHERE id = 3`)?.value === 'after-projection-delete';
    await waitForReady(rebuiltRuntime, ['index', 'cache']);
    const afterDeletionRebuild = rebuiltRuntime.snapshot();
    observed.deletionBackgroundRebuilt =
      afterDeletionRebuild.index.availability === 'ready' &&
      afterDeletionRebuild.cache.availability === 'ready' &&
      afterDeletionRebuild.index.generationId !== previousGenerationIds.index &&
      afterDeletionRebuild.cache.generationId !== previousGenerationIds.cache;
    observed.pendingWritesDrained = afterDeletionRebuild.index.pendingWrites === 0 && afterDeletionRebuild.cache.pendingWrites === 0;
    observed.coreQuickCheck = database.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check ?? null;

    assertProbe(observed.missingReadFallback === true && observed.coreWritableWhileMissing === true, '投影缺失时读取必须安全降级且 Core 仍可写');
    assertProbe(observed.backgroundRebuilt === true, '缺失 index/cache 必须在后台建立到有效 generation');
    assertProbe((afterWrites.index.eventWaterline ?? 0) >= 1 && (afterWrites.cache.eventWaterline ?? 0) >= 1 && observed.cacheRoundTrip === true, '两库必须拥有独立队列和水位');
    assertProbe(observed.generationAdvanced === true && observed.rollbackReopenedPrevious === true, '新 generation 提升必须保留并可重开 previous');
    assertProbe(observed.failedSwitch !== null && observed.failedSwitchRolledBack === true, '候选发布失败必须自动回退到原 generation');
    assertProbe(observed.coreReadableAfterProjectionDeletion === true && observed.coreWritableAfterProjectionDeletion === true, '物理删除投影库不得阻断 Core 业务');
    assertProbe(observed.deletionBackgroundRebuilt === true && observed.pendingWritesDrained === true, '删除后必须后台重建新 generation 并排空两队列');
    assertProbe(observed.coreQuickCheck === 'ok', 'Core 临时库 quick_check 必须通过');
  } finally {
    await runtime?.close().catch(() => undefined);
    await database.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

async function waitForReady(runtime: ProjectionDatabaseRuntimeManager, kinds: Array<'index' | 'cache'>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = runtime.snapshot();
    if (kinds.every((kind) => snapshot[kind].availability === 'ready' && snapshot[kind].generationId !== null)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  const state = runtime.snapshot();
  throw new Error(`投影后台重建超时：${JSON.stringify(state)}`);
}

function monotonicClock(start: string): () => string {
  let value = Date.parse(start);
  return () => new Date((value += 1_000)).toISOString();
}

async function captureFailure(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof Error ? `${error.name}:${error.message}` : String(error);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Projection Database 行为探针失败：${message}`);
}
