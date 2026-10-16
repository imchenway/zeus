import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { businessProcessEnvironment, findExecutable, normalizeProcessEnvironment, resolveCommandInvocation, resolveExecutableInvocation } from '../packages/ai-runtime/src/commandExecution.js';
import { spawnManagedProcess } from '../packages/ai-runtime/src/managedProcess.js';
import { codexInstallationCommand } from '../packages/ai-runtime/src/codexInstallation.js';
import { createCodexAppServerManager } from '../packages/ai-runtime/src/codexAppServerManager.js';
import { isInteractiveShellSession } from '../packages/shared/src/terminalOutput.js';
import { validateCommandDefinitionInput } from '../packages/shared/src/commands.js';
import { CommandDefinitionRepository, CommandRunRepository, migrateCommandCenterSchema } from '../packages/storage/src/commands.js';
import type { SqlValue, ZeusDatabasePort } from '../packages/storage/src/databasePort.js';
import { builtinWechatInvocation } from '../packages/local-server/src/builtinWechatCommands.js';

/** 验证 Windows 环境覆盖不留下 Path/PATH 两份相互冲突的定义。 */
const environment = normalizeProcessEnvironment({ Path: 'old', PATH: 'new', ComSpec: 'cmd.exe', TEMP: 'temp' }, 'win32');
assert.equal(environment.PATH, 'new');
assert.equal(Object.keys(environment).filter((key) => key.toUpperCase() === 'PATH').length, 1);
assert.equal(normalizeProcessEnvironment({ Path: 'old', PATH: undefined }, 'win32').PATH, undefined);
/** 未登记宿主字段包括未来新增字段，不能因名称变化泄露给命令；业务凭据只保留显式原环境。 */
assert.deepEqual(businessProcessEnvironment({ ZEUS_TELEGRAM_BOT_TOKEN: 'fixture', zeus_execution_host_bootstrap_path: 'fixture', ZEUS_FUTURE_CONTROL_TOKEN: 'fixture', ZEUS_PROJECT_ROOT: 'project', OPENAI_API_KEY: 'fixture-provider' }), {
  ZEUS_PROJECT_ROOT: 'project',
  OPENAI_API_KEY: 'fixture-provider',
});
assert.match(codexInstallationCommand('C:\\Zeus 中文', 'win32'), /C:\\Zeus 中文\\bin/u);
assert.match(codexInstallationCommand(undefined, 'win32'), /install\.ps1/u);
assert.match(codexInstallationCommand(undefined, 'darwin'), /install\.sh/u);
assert.ok(isInteractiveShellSession({ command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo', '-NoExit'] }));
assert.ok(isInteractiveShellSession({ command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/k'] }));
assert.equal(isInteractiveShellSession({ command: 'powershell.exe', args: ['-Command', 'Remove-Item'] }), false);
assert.equal(findExecutable(process.execPath), process.execPath);
assert.throws(() => resolveExecutableInvocation('zeus-missing-executable-0098', []), /尚未启动/u);
if (process.platform !== 'win32') assert.throws(() => resolveCommandInvocation('powershell', 'Get-Date'), /Windows/u);
assert.equal(builtinWechatInvocation('preview', 'win32').shell, 'powershell');
assert.equal(builtinWechatInvocation('preview', 'darwin').shell, 'sh');
assert.throws(() => builtinWechatInvocation('preview; arbitrary'), /无效/u);
assert.ok(validateCommandDefinitionInput({ name: 'example', title: 'Example', command: 'echo ok', shell: 'invalid' as never }).some((issue) => issue.field === 'shell'));

/** 独立内存数据库只验证迁移和命令持久化，不访问用户数据。 */
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('CREATE TABLE schema_migrations (migration_id TEXT PRIMARY KEY, description TEXT, checksum TEXT, applied_at TEXT)');
/** 适配真实 SQLite 事务，不用对象假实现代替数据库约束。 */
const database: ZeusDatabasePort = {
  /** 执行本次内存数据库的写入。 */
  execute(sql: string, values: SqlValue[] = []) {
    sqlite.prepare(sql).run(...values);
  },
  /** 读取实际数据库结果。 */
  get<T>(sql: string, values: SqlValue[] = []) {
    return sqlite.prepare(sql).get(...values) as T | undefined;
  },
  /** 读取多行实际结果。 */
  select<T>(sql: string, values: SqlValue[] = []) {
    return sqlite.prepare(sql).all(...values) as T[];
  },
  /** 当前检查不使用通用计数入口。 */
  countRows() {
    throw new Error('此检查不使用通用计数');
  },
  /** 当前命令仓库不登记提交回调。 */
  afterCommit(callback) {
    void callback();
  },
  /** 验证迁移具有真实事务边界。 */
  transaction<T>(operation: () => T): T {
    sqlite.exec('BEGIN');
    try {
      const result = operation();
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
  /** 同一 SQLite 事务能力满足仓库端口。 */
  durableTransactionSync<T>(operation: () => T) {
    return this.transaction(operation);
  },
  /** 本检查的关键写入仍走同一真实事务。 */
  commitCriticalFactSync<T>(operation: () => T) {
    return this.transaction(operation);
  },
};
migrateCommandCenterSchema(database);
migrateCommandCenterSchema(database);
/** 缺少 shell 的历史创建请求必须保留 sh。 */
const definitions = new CommandDefinitionRepository(database);
const original = definitions.create({ name: 'legacy-script', title: '历史脚本', command: 'printf ok', scope: 'global', projectId: null });
assert.equal(original.shell, 'sh');
const updated = definitions.update(original.id, { ...original, shell: 'powershell', command: 'Write-Output ok', revision: original.revision + 1 });
assert.equal(updated.shell, 'powershell');
assert.throws(() => sqlite.prepare("UPDATE command_definitions SET command_shell='unknown' WHERE id=?").run(original.id), /CHECK/u);
/** 历史快照保持原 JSON，只在读取边界补足旧解释器语义。 */
const historical = { ...original };
delete historical.shell;
const runs = new CommandRunRepository(database);
const run = runs.create({ commandId: original.id, projectId: 'project', trigger: 'desktop', status: 'succeeded', commandSnapshot: historical, parameterSnapshot: {}, cwd: process.cwd(), timeoutSeconds: 300 });
assert.equal(run.commandSnapshot.shell, 'sh');
assert.equal(JSON.parse(String(sqlite.prepare('SELECT command_snapshot_json FROM command_runs WHERE id=?').get(run.id)?.command_snapshot_json)).shell, undefined);
sqlite.close();

/** 空格、中文、引号和 shell 元字符必须作为普通 argv 到达真实子进程。 */
const argumentsValue = ['空 格', 'a"b', '%PATH%', '!bang!', 'x&y', '$(echo unexpected)'];
const child = spawnManagedProcess(
  process.execPath,
  ['-e', 'if(process.env.ZEUS_TELEGRAM_BOT_TOKEN || process.env.ZEUS_EXECUTION_HOST_BOOTSTRAP_PATH || process.env.ZEUS_FUTURE_CONTROL_TOKEN) process.exit(23); process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...argumentsValue],
  {
    env: { ...process.env, ZEUS_TELEGRAM_BOT_TOKEN: 'fixture', ZEUS_EXECUTION_HOST_BOOTSTRAP_PATH: 'fixture', ZEUS_FUTURE_CONTROL_TOKEN: 'fixture' },
  },
);
let output = '';
child.stdout.on('data', (chunk: Buffer) => {
  output += chunk.toString('utf8');
});
const completion = once(child, 'close');
child.stdin.end();
const [exitCode] = await completion;
assert.equal(exitCode, 0);
assert.deepEqual(JSON.parse(output), argumentsValue);
if (process.platform === 'win32') {
  /** 实机路径覆盖带空格和中文的 npm 式批处理 shim，结束后删除全部夹具。 */
  const directory = mkdtempSync(join(tmpdir(), 'Zeus 中文 shim '));
  try {
    writeFileSync(join(directory, 'argv.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    writeFileSync(join(directory, 'zeus-check.cmd'), `@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
    writeFileSync(join(directory, 'zeus-check'), '#!/bin/sh\nexit 1\n');
    assert.equal(findExecutable('zeus-check', { ...process.env, PATH: directory, PATHEXT: '.COM;.EXE;.BAT;.CMD' }), join(directory, 'zeus-check.cmd'));
    /** 当前主机才验证真实 cmd、PowerShell 和原生 Job，其他平台不伪造这些证据。 */
    for (const invocation of [
      resolveExecutableInvocation(join(directory, 'zeus-check.cmd'), argumentsValue),
      resolveCommandInvocation('powershell', "[Console]::Write('中文 & % !')"),
      resolveCommandInvocation('cmd', 'echo Windows原生命令'),
    ]) {
      const processHandle = spawnManagedProcess(invocation.command, invocation.args, { ...invocation, cwd: directory });
      const stdout: Buffer[] = [];
      processHandle.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      const closed = once(processHandle, 'close');
      processHandle.stdin.end();
      assert.equal((await closed)[0], 0);
      const actual = Buffer.concat(stdout).toString('utf8');
      if (invocation.windowsVerbatimArguments && invocation.args.join(' ').includes('zeus-check.cmd')) assert.deepEqual(JSON.parse(actual), argumentsValue);
      else if (!invocation.windowsVerbatimArguments) assert.equal(actual, '中文 & % !');
      else assert.match(actual, /Windows/u);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
/** 只模拟平台选择验证失败状态，不能把它记作 Windows daemon 实机运行。 */
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
/** 未确认的 Main 启动回执不得触发管理器自动重试。 */
let bootstrapCalls = 0;
/** 调度回调比计时等待更直接地证明没有登记自动重试。 */
let scheduledRestarts = 0;
/** 此检查拒绝启动任何实际 Codex，只覆盖已授权内部桥的失败收口。 */
const manager = createCodexAppServerManager({
  runtimeEnvironment: { PATH: process.env.PATH ?? 'unused' },
  ensureRemoteControlDaemon: async () => {
    bootstrapCalls += 1;
    throw new Error('启动结果未知');
  },
  onRestartScheduled: () => {
    scheduledRestarts += 1;
  },
});
try {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  await assert.rejects(manager.ensureReady({ commandPath: process.execPath, remoteControl: true }), { code: 'ZEUS_CODEX_REMOTE_CONTROL_BOOTSTRAP_FAILED', message: '启动结果未知' });
  assert.equal(bootstrapCalls, 1);
  assert.equal(scheduledRestarts, 0);
  await assert.rejects(manager.ensureReady({ commandPath: process.execPath, remoteControl: true }), /启动结果未知/u);
  assert.equal(bootstrapCalls, 1);
} finally {
  await manager.close();
  Object.defineProperty(process, 'platform', platformDescriptor);
}
console.info('Windows 运行契约检查通过：历史迁移、解释器、终端识别、参数边界。当前平台：' + process.platform);
