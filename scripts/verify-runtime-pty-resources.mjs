import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import { createAiRuntimeSessionManager, createNodePtyRuntimeSpawn } from '../packages/ai-runtime/dist/index.js';

/** 直接加载运行包使用的原生依赖，手动检查 macOS 的真实资源释放。 */
const require = createRequire(new URL('../packages/ai-runtime/package.json', import.meta.url));
/** 与正式受管终端使用同一个 node-pty 实例。 */
const pty = require('node-pty');

/** 只统计当前探针进程；同时检查普通描述符，覆盖低位占位文件的释放。 */
function descriptorCounts() {
  /** lsof 子进程退出后才返回，避免把采集过程算作常驻资源。 */
  const output = execFileSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-Ffn'], { encoding: 'utf8' });
  return {
    terminals: (output.match(/^n\/dev\/(?:ptmx|ttys\w+)$/gm) ?? []).length,
    files: (output.match(/^f\d+/gm) ?? []).length,
  };
}

/** 等待真实退出与输出排空；超时只终止本次创建的进程。 */
async function runTerminal(stop = false) {
  /** 短命令覆盖正常退出，sleep 覆盖用户主动停止。 */
  const child = pty.spawn(stop ? '/bin/sleep' : '/bin/sh', stop ? ['30'] : ['-c', 'printf "pty-resource-probe"'], { cwd: process.cwd(), env: process.env });
  /** 保留实际输出，避免只凭退出码认定终端可用。 */
  let output = '';
  /** 监听器在退出后全部移除。 */
  const data = child.onData((chunk) => {
    output += chunk;
  });
  try {
    await new Promise((resolve, reject) => {
      /** 为卡死的探针设置上界，不能留下占用终端的子进程。 */
      const timer = globalThis.setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('原生终端未在 5 秒内退出'));
      }, 5_000);
      /** node-pty 的退出事件在终端输出排空后触发。 */
      const exit = child.onExit(({ exitCode }) => {
        globalThis.clearTimeout(timer);
        exit.dispose();
        if (!stop && exitCode !== 0) reject(new Error(`终端退出码异常：${exitCode}`));
        else resolve();
      });
      if (stop) child.kill('SIGTERM');
    });
    if (!stop) assert.equal(output, 'pty-resource-probe');
  } finally {
    data.dispose();
  }
  await delay(20);
}

/** 不在其他系统上假称验证过 macOS 的原生分支。 */
assert.equal(process.platform, 'darwin', '此专项检查需要 macOS');
/** 首次运行失败时保留基线，仍可核验资源耗尽出口是否继续泄漏。 */
const initial = descriptorCounts();
try {
  await runTerminal();
} catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith('posix_spawnp failed:')) throw error;
  assert.deepEqual(descriptorCounts(), initial, '首次失败申请泄漏了资源');
  // 系统资源耗尽时，只重复失败申请，不创建额外的长驻会话。
  for (let attempt = 0; attempt < 16; attempt += 1) {
    assert.throws(() => pty.spawn('/bin/true', [], { cwd: process.cwd() }), /posix_spawnp failed:/);
  }
  assert.deepEqual(descriptorCounts(), initial, '连续失败申请泄漏了资源');
  console.log(JSON.stringify({ allocationFailures: 17, before: initial, after: descriptorCounts() }));
  throw new Error('系统当前无法创建终端；失败申请的资源释放已检查，正常退出与停止尚未验收。', { cause: error });
}
/** 首次运行后再取基线，排除 Node 首次初始化的常驻描述符。 */
const baseline = descriptorCounts();
/** 超过系统参数长度限制，确保失败发生在父进程的 posix_spawn 调用。 */
const oversizedArgument = 'x'.repeat(3 * 1024 * 1024);
for (let attempt = 0; attempt < 32; attempt += 1) {
  await runTerminal();
  assert.deepEqual(descriptorCounts(), baseline, `第 ${attempt + 1} 次正常退出泄漏了资源`);
  assert.throws(() => pty.spawn('/bin/echo', [oversizedArgument], { cwd: process.cwd() }), /posix_spawnp failed:/);
  assert.deepEqual(descriptorCounts(), baseline, `第 ${attempt + 1} 次启动失败泄漏了资源`);
}
await runTerminal(true);
assert.deepEqual(descriptorCounts(), baseline, '主动停止后泄漏了资源');

/** 普通 AI 命令在启用了 PTY 后端的同一个管理器中仍必须使用管道。 */
const runtime = createAiRuntimeSessionManager({ allowedRoot: process.cwd(), spawn: createNodePtyRuntimeSpawn(pty) });
try {
  /** 同时检查无终端、标准输入和独立错误输出，不只验证进程能结束。 */
  const command = await runtime.startSession({
    projectId: 'pty-resource-probe',
    command: '/bin/sh',
    args: ['-c', 'if [ -t 0 ] || [ -t 1 ] || [ -t 2 ]; then exit 99; fi; read line; printf "%s" "$line"; printf "pipe-stderr" >&2'],
    cwd: process.cwd(),
    terminal: false,
  });
  assert.equal(descriptorCounts().terminals, baseline.terminals, '普通 AI 命令申请了伪终端');
  runtime.inputSession(command.id, 'pipe-stdin\n');
  assert.equal(await runtime.waitForSessionCompletion(command.id, 5_000), true);
  assert.equal(runtime.getSession(command.id)?.exitCode, 0);
  assert.equal(
    runtime
      .getLogs(command.id)
      .filter((entry) => entry.stream === 'stdout')
      .map((entry) => entry.text)
      .join(''),
    'pipe-stdin',
  );
  assert.equal(
    runtime
      .getLogs(command.id)
      .filter((entry) => entry.stream === 'stderr')
      .map((entry) => entry.text)
      .join(''),
    'pipe-stderr',
  );
  /** 管道命令仍由同一管理器负责停止和回收。 */
  const stopped = await runtime.startSession({ projectId: 'pty-resource-probe', command: '/bin/sleep', args: ['30'], cwd: process.cwd(), terminal: false });
  runtime.stopSession(stopped.id);
  assert.equal(await runtime.waitForSessionCompletion(stopped.id, 5_000), true);
  assert.equal(runtime.getSession(stopped.id)?.status, 'stopped');
} finally {
  await runtime.close();
}
assert.equal(descriptorCounts().terminals, baseline.terminals, '普通命令结束后遗留了伪终端');
console.log(JSON.stringify({ normalExits: 33, spawnFailures: 32, stopped: 1, managedPipeCommands: 2, baseline, after: descriptorCounts() }));
