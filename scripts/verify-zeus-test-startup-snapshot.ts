import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor } from '../packages/local-server/src/readOnlyValidation.ts';

const arguments_ = parseArguments(process.argv.slice(2));
const expectedRoot = await requireRealDirectory(arguments_.expectedRoot, 'Test 数据根');
const databasePath = await requireContainedRegularFile(arguments_.databasePath, expectedRoot, 'Test 数据库');
const formalSourcePath = arguments_.formalSourcePath ? await requireRegularFile(arguments_.formalSourcePath, '正式源数据库') : null;
const readOnlyValidation = arguments_.validationManifestPath ? await verifyReadOnlyValidationDescriptor(inspectReadOnlyValidationManifest(await requireRegularFile(arguments_.validationManifestPath, '只读验证 manifest'))) : null;

if (readOnlyValidation && (readOnlyValidation.validationRoot !== expectedRoot || readOnlyValidation.database.path !== databasePath)) {
  fail('ZEUS_TEST_STARTUP_VALIDATION_IDENTITY_MISMATCH', '只读验证 manifest 与指定 Test 数据根或数据库不一致。');
}

if (formalSourcePath) {
  const [sourceStats, targetStats] = await Promise.all([lstat(formalSourcePath, { bigint: true }), lstat(databasePath, { bigint: true })]);
  if (sourceStats.dev === targetStats.dev && sourceStats.ino === targetStats.ino) {
    fail('ZEUS_TEST_STARTUP_DATABASE_ALIASES_FORMAL', 'Test 数据库与正式源数据库是同一个 inode，拒绝启动。');
  }
}
if (process.env.ZEUS_CODEX_NATIVE_ENABLED !== '0') fail('ZEUS_TEST_STARTUP_CODEX_NOT_DISABLED', '隔离副本验收必须显式设置 ZEUS_CODEX_NATIVE_ENABLED=0。');
if (process.env.ZEUS_TELEGRAM_BOT_TOKEN?.trim()) fail('ZEUS_TEST_STARTUP_TELEGRAM_TOKEN_PRESENT', '隔离副本验收环境不得携带 Telegram token。');
if (process.env.ZEUS_ALLOW_UNTRUSTED_UPDATE_TEST === '1' || process.env.ZEUS_RELEASE_UPDATE_MANIFEST_URL?.trim()) {
  fail('ZEUS_TEST_STARTUP_UPDATE_OVERRIDE_PRESENT', '隔离副本验收不得启用 Test 更新 override 或外部更新清单。');
}

const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 30_000 });
try {
  database.exec('PRAGMA query_only = ON');
  const quickCheck = String((database.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined)?.quick_check ?? '').toLowerCase();
  if (quickCheck !== 'ok') fail('ZEUS_TEST_STARTUP_QUICK_CHECK_FAILED', 'Test 数据库 quick_check 未通过。');

  const counts = {
    activeExecutionHostHandoffs: countIfTable(database, 'execution_host_handoffs', `SELECT COUNT(*) AS count FROM execution_host_handoffs WHERE status IN ('draining', 'prepared', 'claimed', 'recovery_required')`),
    preparingTaskIntegrations: countIfTable(database, 'task_integration_attempts', `SELECT COUNT(*) AS count FROM task_integration_attempts WHERE state = 'preparing'`),
    processOwningRuntimeSessions: countIfTable(database, 'runtime_sessions', `SELECT COUNT(*) AS count FROM runtime_sessions WHERE status IN ('running', 'orphan_detected')`),
    activeCommandRuns: countIfTable(database, 'command_runs', `SELECT COUNT(*) AS count FROM command_runs WHERE status IN ('pending_confirmation', 'starting', 'running', 'stopping')`),
    effectfulPiTurns: countIfTable(database, 'conversation_turns', `SELECT COUNT(*) AS count FROM conversation_turns WHERE agent_kind = 'pi' AND status IN ('dispatching', 'running', 'waiting')`),
    effectfulPiSubmissions:
      tableExists(database, 'conversation_submissions') && tableExists(database, 'conversations')
        ? count(
            database,
            `SELECT COUNT(*) AS count
               FROM conversation_submissions AS submission
               JOIN conversations AS conversation ON conversation.id = submission.conversation_id
              WHERE conversation.agent_kind = 'pi'
                AND submission.status IN ('dispatching', 'active')`,
          )
        : 0,
  };
  const unsafe = Object.entries(counts).filter(([, value]) => value > 0);
  if (unsafe.length > 0 && !readOnlyValidation) {
    fail('ZEUS_TEST_STARTUP_EXTERNAL_RESUME_RISK', `Test 副本仍有可能自动触发外部恢复的活动状态：${JSON.stringify(Object.fromEntries(unsafe))}`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        databasePath,
        expectedRoot,
        formalSourcePath,
        sourceAndTargetDistinct: formalSourcePath !== null,
        openedReadOnly: true,
        queryOnly: true,
        quickCheck: 'ok',
        environment: {
          codexNativeEnabled: false,
          telegramTokenPresent: false,
          untrustedUpdateOverride: false,
        },
        readOnlyValidation: readOnlyValidation
          ? {
              runId: readOnlyValidation.runId,
              manifestHash: readOnlyValidation.manifestHash,
              databaseSha256: readOnlyValidation.database.sha256,
              activeStateCount: unsafe.reduce((total, [, value]) => total + value, 0),
              activeStatesRemainProjectionOnly: true,
            }
          : null,
        counts,
        note: readOnlyValidation
          ? '活动状态可作为复制历史展示；Main/Core manifest Fence、query_only Storage 和外部能力默认拒绝共同阻止恢复或派发。'
          : '没有 validation manifest 时仍执行旧版快照状态硬闸机；Codex waiting requests 仅在显式禁用 Provider 后可见。',
      },
      null,
      2,
    )}\n`,
  );
} finally {
  database.close();
}

interface ParsedArguments {
  databasePath: string;
  expectedRoot: string;
  formalSourcePath: string | null;
  validationManifestPath: string | null;
}

function parseArguments(values: string[]): ParsedArguments {
  const parsed: ParsedArguments = { databasePath: '', expectedRoot: '', formalSourcePath: null, validationManifestPath: null };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--db') parsed.databasePath = requiredValue(values[++index], '--db');
    else if (value === '--expected-root') parsed.expectedRoot = requiredValue(values[++index], '--expected-root');
    else if (value === '--formal-source') parsed.formalSourcePath = requiredValue(values[++index], '--formal-source');
    else if (value === '--validation-manifest') parsed.validationManifestPath = requiredValue(values[++index], '--validation-manifest');
    else fail('ZEUS_TEST_STARTUP_INVALID_ARGUMENT', `未知参数：${String(value)}`);
  }
  if (!parsed.databasePath || !parsed.expectedRoot) {
    fail('ZEUS_TEST_STARTUP_INVALID_ARGUMENT', '用法：--db <Test zeus.db> --expected-root <独立 ZEUS_USER_DATA_DIR> [--formal-source <正式 zeus.db>] [--validation-manifest <manifest>]');
  }
  return parsed;
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith('--')) fail('ZEUS_TEST_STARTUP_INVALID_ARGUMENT', `${flag} 缺少参数。`);
  return value;
}

async function requireRealDirectory(value: string, label: string): Promise<string> {
  const requested = requireAbsolute(value, label);
  const stats = await lstat(requested);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail('ZEUS_TEST_STARTUP_PATH_INVALID', `${label}必须是已存在的真实目录，不能是软链接。`);
  return realpath(requested);
}

async function requireRegularFile(value: string, label: string): Promise<string> {
  const requested = requireAbsolute(value, label);
  const stats = await lstat(requested);
  if (!stats.isFile() || stats.isSymbolicLink()) fail('ZEUS_TEST_STARTUP_PATH_INVALID', `${label}必须是普通文件，不能是软链接。`);
  return realpath(requested);
}

async function requireContainedRegularFile(value: string, root: string, label: string): Promise<string> {
  const file = await requireRegularFile(value, label);
  const nested = relative(root, file);
  if (!nested || nested === '..' || nested.startsWith(`..${sep}`) || isAbsolute(nested)) {
    fail('ZEUS_TEST_STARTUP_PATH_OUTSIDE_ROOT', `${label}不在指定 Test 数据根内。`);
  }
  return file;
}

function requireAbsolute(value: string, label: string): string {
  if (!isAbsolute(value)) fail('ZEUS_TEST_STARTUP_PATH_INVALID', `${label}必须使用绝对路径。`);
  return resolve(value);
}

function countIfTable(database: DatabaseSync, table: string, sql: string): number {
  return tableExists(database, table) ? count(database, sql) : 0;
}

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table) as { present?: unknown } | undefined;
  return Number(row?.present) === 1;
}

function count(database: DatabaseSync, sql: string): number {
  const value = Number((database.prepare(sql).get() as { count?: unknown } | undefined)?.count);
  if (!Number.isSafeInteger(value) || value < 0) fail('ZEUS_TEST_STARTUP_COUNT_INVALID', '启动风险查询没有返回有效计数。');
  return value;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, failClosed: true as const });
}
