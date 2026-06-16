import { describe, expect, it } from 'vitest';
import {
  buildAiRuntimePrompt,
  checkAiCliAdapter,
  createAiCliAdapterInvocation,
  createAiRuntimeSessionManager,
  createNodePtyRuntimeSpawn,
  createOptionalNodePtyRuntimeSpawn,
  listAiCliAdapters,
  parseAiRuntimeOutputState,
  type AiRuntimeProcessHandle,
  type AiRuntimeSpawn,
} from '../src/index.js';

function createScriptedSpawn(): {
  spawn: AiRuntimeSpawn;
  handles: AiRuntimeProcessHandle[];
} {
  const handles: AiRuntimeProcessHandle[] = [];
  const spawn: AiRuntimeSpawn = () => {
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 42,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        return handle;
      },
      kill() {
        callbacks.get('exit')?.forEach((callback) => callback(143));
      },
    };
    handles.push(handle);
    queueMicrotask(() => {
      callbacks.get('stdout')?.forEach((callback) => callback('真实 stdout'));
      callbacks.get('stderr')?.forEach((callback) => callback(Buffer.from('真实 stderr')));
      callbacks.get('exit')?.forEach((callback) => callback(0));
    });
    return handle;
  };
  return { spawn, handles };
}

describe('AI runtime session manager', () => {
  it('starts a real process session contract and records stdout, stderr, and exit status', async () => {
    const { spawn } = createScriptedSpawn();
    const manager = createAiRuntimeSessionManager({
      spawn,
      allowedRoot: '/Users/david/hypha/zeus',
      now: () => '2026-06-13T00:00:00.000Z',
    });

    const session = await manager.startSession({
      projectId: 'project-1',
      taskId: 'task-1',
      command: 'codex',
      args: ['--version'],
      cwd: '/Users/david/hypha/zeus',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updated = manager.getSession(session.id);
    expect(updated?.status).toBe('exited');
    expect(updated?.exitCode).toBe(0);
    expect(manager.getLogs(session.id).map((entry) => `${entry.stream}:${entry.text}`)).toEqual(['system:启动 AI Runtime 会话：codex --version', 'stdout:真实 stdout', 'stderr:真实 stderr', 'system:AI Runtime 会话已退出：0']);
  });

  it('rejects sessions outside the allowed workspace root', async () => {
    const { spawn } = createScriptedSpawn();
    const manager = createAiRuntimeSessionManager({
      spawn,
      allowedRoot: '/Users/david/hypha/zeus',
    });

    await expect(
      manager.startSession({
        projectId: 'project-1',
        command: 'codex',
        cwd: '/private/tmp',
      }),
    ).rejects.toThrow('必须位于允许的项目目录内');
  });

  it('normalizes ANSI terminal control output before storing runtime logs', async () => {
    const manager = createAiRuntimeSessionManager({
      allowedRoot: '/Users/david/hypha/zeus',
      now: () => '2026-06-14T00:00:00.000Z',
      spawn: () => {
        const callbacks = new Map<string, Array<(value: unknown) => void>>();
        const handle: AiRuntimeProcessHandle = {
          pid: 44,
          on(event, callback) {
            const entries = callbacks.get(event) ?? [];
            entries.push(callback as (value: unknown) => void);
            callbacks.set(event, entries);
            return handle;
          },
          kill() {},
        };
        queueMicrotask(() => {
          callbacks.get('stdout')?.forEach((callback) => callback(Buffer.from('\u001b[32m真实绿色输出\u001b[0m\r\n下一行')));
          callbacks.get('exit')?.forEach((callback) => callback(0));
        });
        return handle;
      },
    });

    const session = await manager.startSession({
      projectId: 'project-1',
      command: 'codex',
      cwd: '/Users/david/hypha/zeus',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stdout = manager.getLogs(session.id).find((entry) => entry.stream === 'stdout')?.text;
    expect(stdout).toBe('真实绿色输出\n下一行');
  });

  it('redacts authorization headers cookies ssh private keys and env secrets from runtime logs', async () => {
    const manager = createAiRuntimeSessionManager({
      allowedRoot: '/Users/david/hypha/zeus',
      now: () => '2026-06-13T00:00:00.000Z',
      spawn: () => {
        const callbacks = new Map<string, Array<(value: unknown) => void>>();
        const handle: AiRuntimeProcessHandle = {
          pid: 43,
          on(event, callback) {
            const entries = callbacks.get(event) ?? [];
            entries.push(callback as (value: unknown) => void);
            callbacks.set(event, entries);
            return handle;
          },
          kill() {},
        };
        queueMicrotask(() => {
          callbacks
            .get('stdout')
            ?.forEach((callback) =>
              callback(
                ['Authorization: Bearer runtime-secret', 'Cookie: session=runtime-cookie', 'DATABASE_PASSWORD="runtime-db-password"', '-----BEGIN OPENSSH PRIVATE KEY-----', 'runtime-private-key', '-----END OPENSSH PRIVATE KEY-----'].join(
                  '\n',
                ),
              ),
            );
          callbacks.get('exit')?.forEach((callback) => callback(0));
        });
        return handle;
      },
    });

    const session = await manager.startSession({
      projectId: 'project-1',
      command: 'codex',
      cwd: '/Users/david/hypha/zeus',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const logs = manager
      .getLogs(session.id)
      .map((entry) => entry.text)
      .join('\n');

    expect(logs).toContain('Authorization: Bearer [REDACTED]');
    expect(logs).toContain('Cookie: [REDACTED]');
    expect(logs).toContain('DATABASE_PASSWORD=[REDACTED]');
    expect(logs).toContain('[REDACTED SSH PRIVATE KEY]');
    expect(logs).not.toContain('runtime-secret');
    expect(logs).not.toContain('runtime-cookie');
    expect(logs).not.toContain('runtime-db-password');
    expect(logs).not.toContain('runtime-private-key');
  });
});

it('notifies persistence hooks when sessions and logs change', async () => {
  const { spawn } = createScriptedSpawn();
  const sessionChanges: string[] = [];
  const logEntries: string[] = [];
  const manager = createAiRuntimeSessionManager({
    spawn,
    allowedRoot: '/Users/david/hypha/zeus',
    now: () => '2026-06-13T00:00:00.000Z',
    onSessionChange: (session) => sessionChanges.push(`${session.status}:${session.exitCode ?? 'none'}:${session.pid ?? 'no-pid'}`),
    onLog: (log) => logEntries.push(`${log.stream}:${log.text}`),
  });

  await manager.startSession({
    projectId: 'project-1',
    command: 'codex',
    cwd: '/Users/david/hypha/zeus',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(sessionChanges).toEqual(['running:none:no-pid', 'running:none:42', 'exited:0:42']);
  expect(logEntries).toContain('stdout:真实 stdout');
  expect(logEntries).toContain('system:AI Runtime 会话已退出：0');
});

it('exposes the required AI CLI adapter registry and real detection results', async () => {
  const adapters = listAiCliAdapters();

  expect(adapters.map((adapter) => adapter.id)).toEqual(['codex', 'claude', 'gemini', 'generic']);
  const codex = await checkAiCliAdapter('codex');

  expect(codex).toMatchObject({
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
  });
  expect(typeof codex.available).toBe('boolean');
  expect(codex.reason).not.toHaveLength(0);
  await expect(checkAiCliAdapter('missing')).rejects.toThrow('AI CLI adapter not found');
});

it('probes adapter version from real command output when the CLI exists', async () => {
  const status = await checkAiCliAdapter('codex', {
    findCommand: async () => '/mock/bin/codex',
    runCommand: async () => ({
      stdout: 'codex-cli 1.2.3\n',
      stderr: '',
      exitCode: 0,
    }),
  });

  expect(status.available).toBe(true);
  expect(status.version).toBe('1.2.3');
  expect(status.authStatus).toBe('unknown');
  expect(status.reason).toContain('1.2.3');
});

it('marks adapter auth as unauthenticated when the probe reports login is required', async () => {
  const status = await checkAiCliAdapter('claude', {
    findCommand: async () => '/mock/bin/claude',
    runCommand: async () => ({
      stdout: '',
      stderr: 'not logged in, please login first',
      exitCode: 1,
    }),
  });

  expect(status.available).toBe(true);
  expect(status.version).toBeNull();
  expect(status.authStatus).toBe('unauthenticated');
  expect(status.reason).toContain('需要登录');
});

it('builds source-backed runtime prompts and adapter startup commands without fabricating context', () => {
  const prompt = buildAiRuntimePrompt({
    taskTitle: '修复登录 Bug',
    taskDescription: '用户点击登录后返回 500',
    projectName: 'Zeus',
    projectPath: '/Users/david/hypha/zeus',
    sourceContext: {
      issue: '真实任务来源',
      file: 'apps/desktop/src/renderer/App.tsx',
    },
  });
  const codex = createAiCliAdapterInvocation('codex', prompt);
  const claude = createAiCliAdapterInvocation('claude', prompt);
  const gemini = createAiCliAdapterInvocation('gemini', prompt);

  expect(prompt).toContain('任务：修复登录 Bug');
  expect(prompt).toContain('项目路径：/Users/david/hypha/zeus');
  expect(prompt).toContain('只能基于真实仓库、真实日志、真实错误输出行动');
  expect(prompt).toContain('"file":"apps/desktop/src/renderer/App.tsx"');
  expect(prompt).not.toContain('假设已经');
  expect(codex).toMatchObject({ command: 'codex', args: ['exec', prompt] });
  expect(claude).toMatchObject({ command: 'claude', args: ['-p', prompt] });
  expect(gemini).toMatchObject({ command: 'gemini', args: ['-p', prompt] });
});

it('adds user-configured model arguments to adapter invocations without changing prompt content', () => {
  const prompt = '真实任务 prompt';
  const codex = createAiCliAdapterInvocation('codex', prompt, {
    model: 'gpt-5.1-codex',
  });
  const claude = createAiCliAdapterInvocation('claude', prompt, {
    model: 'claude-sonnet-real',
  });
  const gemini = createAiCliAdapterInvocation('gemini', prompt, {
    model: 'gemini-pro-real',
  });

  expect(codex).toMatchObject({
    command: 'codex',
    args: ['exec', '--model', 'gpt-5.1-codex', prompt],
  });
  expect(claude).toMatchObject({
    command: 'claude',
    args: ['-p', prompt, '--model', 'claude-sonnet-real'],
  });
  expect(gemini).toMatchObject({
    command: 'gemini',
    args: ['-p', prompt, '--model', 'gemini-pro-real'],
  });
  expect(createAiCliAdapterInvocation('codex', prompt)).toMatchObject({
    command: 'codex',
    args: ['exec', prompt],
  });
});

it('uses a user-configured absolute CLI path for adapter invocations without changing adapter args', () => {
  const prompt = '真实任务 prompt';
  const claude = createAiCliAdapterInvocation('claude', prompt, {
    commandPath: '/opt/homebrew/bin/claude',
  });

  expect(claude).toMatchObject({
    command: '/opt/homebrew/bin/claude',
    args: ['-p', prompt],
  });
});

it('parses runtime output states for waiting input, completed, and error signals', () => {
  expect(parseAiRuntimeOutputState('Do you want to proceed? (y/N)')).toMatchObject({ state: 'waiting_input' });
  expect(parseAiRuntimeOutputState('任务 completed successfully')).toMatchObject({ state: 'completed' });
  expect(parseAiRuntimeOutputState('Error: command failed')).toMatchObject({
    state: 'error',
  });
  expect(parseAiRuntimeOutputState('正在分析真实文件')).toMatchObject({
    state: 'running',
  });
});

it('records parsed runtime output states as system logs without fabricating results', async () => {
  const manager = createAiRuntimeSessionManager({
    allowedRoot: '/Users/david/hypha/zeus',
    now: () => '2026-06-13T00:00:00.000Z',
    spawn: () => {
      const callbacks = new Map<string, Array<(value: unknown) => void>>();
      const handle: AiRuntimeProcessHandle = {
        pid: 99,
        on(event, callback) {
          const entries = callbacks.get(event) ?? [];
          entries.push(callback as (value: unknown) => void);
          callbacks.set(event, entries);
          return handle;
        },
        kill() {},
      };
      queueMicrotask(() => callbacks.get('stdout')?.forEach((callback) => callback('Do you want to proceed? (y/N)')));
      return handle;
    },
  });

  const session = await manager.startSession({
    projectId: 'project-1',
    command: 'codex',
    cwd: '/Users/david/hypha/zeus',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(manager.getLogs(session.id).map((entry) => `${entry.stream}:${entry.text}`)).toContain('system:AI Runtime 输出状态：waiting_input · 检测到等待用户输入或确认的输出。');
});

it('writes input, sends interrupt, resizes PTY-capable handles, and exposes terminal snapshots', async () => {
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const manager = createAiRuntimeSessionManager({
    allowedRoot: '/Users/david/hypha/zeus',
    now: () => '2026-06-13T00:00:00.000Z',
    spawn: () => {
      const callbacks = new Map<string, Array<(value: unknown) => void>>();
      const handle: AiRuntimeProcessHandle = {
        pid: 77,
        on(event, callback) {
          const entries = callbacks.get(event) ?? [];
          entries.push(callback as (value: unknown) => void);
          callbacks.set(event, entries);
          return handle;
        },
        kill(signal) {
          callbacks.get('stderr')?.forEach((callback) => callback(`signal:${signal}`));
        },
        write(input) {
          writes.push(input);
          callbacks.get('stdout')?.forEach((callback) => callback(`echo:${input}`));
        },
        resize(cols, rows) {
          resizes.push({ cols, rows });
        },
      };
      return handle;
    },
  });
  const session = await manager.startSession({
    projectId: 'project-1',
    command: 'codex',
    cwd: '/Users/david/hypha/zeus',
  });

  manager.inputSession(session.id, '继续执行');
  manager.resizeSession(session.id, 120, 32);
  manager.interruptSession(session.id);
  const snapshot = manager.getTerminalSnapshot(session.id);

  expect(writes).toEqual(['继续执行']);
  expect(resizes).toEqual([{ cols: 120, rows: 32 }]);
  expect(snapshot.logs.map((entry) => entry.text)).toContain('echo:继续执行');
  expect(snapshot.logs.map((entry) => entry.text)).toContain('signal:SIGINT');
});

it('adapts a node-pty process to runtime output, input, resize, and exit contracts', async () => {
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const kills: Array<string | undefined> = [];
  const spawnCalls: Array<{
    command: string;
    args: string[];
    options: {
      cwd?: string;
      name?: string;
      cols?: number;
      rows?: number;
      env?: NodeJS.ProcessEnv;
    };
  }> = [];
  let emitData: ((chunk: string) => void) | undefined;
  let emitExit: ((event: { exitCode: number }) => void) | undefined;
  const spawn = createNodePtyRuntimeSpawn({
    spawn(
      command: string,
      args: string[],
      options: {
        cwd?: string;
        name?: string;
        cols?: number;
        rows?: number;
        env?: NodeJS.ProcessEnv;
      },
    ) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 501,
        onData(callback: (chunk: string) => void) {
          emitData = callback;
        },
        onExit(callback: (event: { exitCode: number }) => void) {
          emitExit = callback;
        },
        write(input: string) {
          writes.push(input);
        },
        resize(cols: number, rows: number) {
          resizes.push({ cols, rows });
        },
        kill(signal?: string) {
          kills.push(signal);
        },
      };
    },
  });
  const manager = createAiRuntimeSessionManager({
    allowedRoot: '/Users/david/hypha/zeus',
    now: () => '2026-06-14T00:00:00.000Z',
    spawn,
  });

  const session = await manager.startSession({
    projectId: 'project-1',
    command: 'codex',
    args: ['exec', '真实任务'],
    cwd: '/Users/david/hypha/zeus',
    env: { ZEUS_REAL: '1' },
  });
  emitData?.('PTY 输出');
  manager.inputSession(session.id, '继续\r');
  manager.resizeSession(session.id, 132, 40);
  manager.interruptSession(session.id);
  emitExit?.({ exitCode: 0 });

  expect(spawnCalls).toEqual([
    {
      command: 'codex',
      args: ['exec', '真实任务'],
      options: expect.objectContaining({
        cwd: '/Users/david/hypha/zeus',
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        env: { ZEUS_REAL: '1' },
      }),
    },
  ]);
  expect(manager.getSession(session.id)?.pid).toBe(501);
  expect(manager.getSession(session.id)?.status).toBe('exited');
  expect(manager.getLogs(session.id).map((entry) => `${entry.stream}:${entry.text}`)).toContain('stdout:PTY 输出');
  expect(writes).toEqual(['继续\r']);
  expect(resizes).toEqual([{ cols: 132, rows: 40 }]);
  expect(kills).toEqual(['SIGINT']);
});

it('reports optional node-pty availability without requiring the native dependency at startup', async () => {
  const missing = createOptionalNodePtyRuntimeSpawn({
    loadNodePty: () => null,
  });
  expect(missing.available).toBe(false);
  expect(missing.spawn).toBeUndefined();
  expect(missing.reason).toContain('node-pty');

  let dataCallback: ((chunk: string) => void) | undefined;
  const available = createOptionalNodePtyRuntimeSpawn({
    loadNodePty: () => ({
      spawn() {
        return {
          pid: 777,
          onData(callback: (chunk: string) => void) {
            dataCallback = callback;
          },
          onExit() {},
          write() {},
          resize() {},
          kill() {},
        };
      },
    }),
  });
  const manager = createAiRuntimeSessionManager({
    allowedRoot: '/Users/david/hypha/zeus',
    now: () => '2026-06-14T00:00:00.000Z',
    spawn: available.spawn,
  });

  const session = await manager.startSession({
    projectId: 'project-1',
    command: 'codex',
    cwd: '/Users/david/hypha/zeus',
  });
  dataCallback?.('optional PTY output');

  expect(available.available).toBe(true);
  expect(available.reason).toContain('node-pty 已可用');
  expect(manager.getSession(session.id)?.pid).toBe(777);
  expect(manager.getLogs(session.id).map((entry) => entry.text)).toContain('optional PTY output');
});
