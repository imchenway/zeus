import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const repositoryRoot = resolve(import.meta.dirname, '..');
const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-test-startup-snapshot-probe-'));
const sourceRoot = join(probeRoot, 'source-root');
const dataDirectory = join(sourceRoot, 'data');
const databasePath = join(dataDirectory, 'zeus.db');
const validationBase = join(probeRoot, 'test-instance');
const validationRoot = join(validationBase, 'read-only-validation', '55555555-5555-4555-8555-555555555555');

try {
  await mkdir(dataDirectory, { mode: 0o700, recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE runtime_sessions(status TEXT);
      CREATE TABLE command_runs(status TEXT);
      CREATE TABLE task_integration_attempts(state TEXT);
      CREATE TABLE conversation_turns(agent_kind TEXT, status TEXT);
      CREATE TABLE conversations(id TEXT PRIMARY KEY, agent_kind TEXT);
      CREATE TABLE conversation_submissions(conversation_id TEXT, status TEXT);
    `);
  } finally {
    database.close();
  }
  await chmod(databasePath, 0o600);

  const safe = runPreflight({ ZEUS_CODEX_NATIVE_ENABLED: '0' });
  assertProbe(safe.status === 0 && parseOutput(safe.stdout).status === 'passed', '无活动外部恢复状态且 Codex 禁用时必须通过');

  const writable = new DatabaseSync(databasePath);
  try {
    writable.prepare(`INSERT INTO runtime_sessions (status) VALUES ('running')`).run();
  } finally {
    writable.close();
  }
  const unsafe = runPreflight({ ZEUS_CODEX_NATIVE_ENABLED: '0' });
  assertProbe(unsafe.status !== 0 && `${unsafe.stdout}\n${unsafe.stderr}`.includes('ZEUS_TEST_STARTUP_EXTERNAL_RESUME_RISK'), 'process-owning Runtime 必须失败关闭');

  await mkdir(join(validationRoot, 'data'), { recursive: true, mode: 0o700 });
  await chmod(validationRoot, 0o700);
  await chmod(join(validationRoot, 'data'), 0o700);
  const canonicalValidationRoot = await realpath(validationRoot);
  const copyArguments = [
    '--source',
    databasePath,
    '--validation-root',
    canonicalValidationRoot,
    '--validation-base',
    await realpath(validationBase),
    '--destination',
    join(canonicalValidationRoot, 'data', 'zeus.db'),
    '--require-source-tree-immutable',
  ];
  const copyPlan = spawnSync('pnpm', ['exec', 'tsx', 'scripts/create-zeus-test-database-copy.ts', ...copyArguments], { cwd: repositoryRoot, encoding: 'utf8', env: process.env, maxBuffer: 8 * 1024 * 1024 });
  const expectedConfirmation = String((parseOutput(copyPlan.stdout) as { expectedConfirmation?: unknown }).expectedConfirmation ?? '');
  assertProbe(copyPlan.status === 2 && expectedConfirmation.startsWith('COPY '), 'manifest Fence 分支必须先取得 Backup API 复制确认计划');
  const copied = spawnSync('pnpm', ['exec', 'tsx', 'scripts/create-zeus-test-database-copy.ts', ...copyArguments, '--confirmation', expectedConfirmation], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  assertProbe(copied.status === 0, `manifest Fence 分支必须创建有效副本：${String(copied.stderr).slice(0, 500)}`);
  const manifestFenced = runPreflight(
    { ZEUS_CODEX_NATIVE_ENABLED: '0' },
    {
      databasePath: join(canonicalValidationRoot, 'data', 'zeus.db'),
      expectedRoot: canonicalValidationRoot,
      validationManifestPath: join(canonicalValidationRoot, 'data', 'zeus.db.read-only-validation.json'),
    },
  );
  const manifestFencedResult = parseOutput(manifestFenced.stdout);
  assertProbe(
    manifestFenced.status === 0 &&
      typeof manifestFencedResult.readOnlyValidation === 'object' &&
      manifestFencedResult.readOnlyValidation !== null &&
      (manifestFencedResult.readOnlyValidation as { activeStatesRemainProjectionOnly?: unknown }).activeStatesRemainProjectionOnly === true,
    '已核验 manifest 的硬 Fence 必须允许活动记录作为只读历史投影，而不是误报会恢复外部效果。',
  );

  const missingCodexFence = runPreflight({});
  assertProbe(missingCodexFence.status !== 0 && `${missingCodexFence.stdout}\n${missingCodexFence.stderr}`.includes('ZEUS_TEST_STARTUP_CODEX_NOT_DISABLED'), '未显式禁用 Codex 时必须失败关闭');

  console.info(
    JSON.stringify({
      status: 'passed',
      positiveSnapshotAccepted: true,
      activeRuntimeRejected: true,
      manifestFenceAllowsActiveStateProjection: true,
      missingCodexFenceRejected: true,
      databaseOpenedByPreflightReadOnly: true,
    }),
  );
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

function runPreflight(overrides: NodeJS.ProcessEnv, paths: { databasePath: string; expectedRoot: string; validationManifestPath?: string } = { databasePath, expectedRoot: sourceRoot }): ReturnType<typeof spawnSync> {
  const environment = { ...process.env, ...overrides };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'ZEUS_CODEX_NATIVE_ENABLED')) delete environment.ZEUS_CODEX_NATIVE_ENABLED;
  delete environment.ZEUS_TELEGRAM_BOT_TOKEN;
  delete environment.ZEUS_ALLOW_UNTRUSTED_UPDATE_TEST;
  delete environment.ZEUS_RELEASE_UPDATE_MANIFEST_URL;
  return spawnSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/verify-zeus-test-startup-snapshot.ts', '--db', paths.databasePath, '--expected-root', paths.expectedRoot, ...(paths.validationManifestPath ? ['--validation-manifest', paths.validationManifestPath] : [])],
    { cwd: repositoryRoot, encoding: 'utf8', env: environment, maxBuffer: 8 * 1024 * 1024 },
  );
}

function parseOutput(value: string | Buffer | null): Record<string, unknown> {
  const text = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
  return JSON.parse(text) as Record<string, unknown>;
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Zeus Test 启动快照行为验证失败：${message}`);
}
