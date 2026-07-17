import { EventEmitter } from 'node:events';
import { delimiter } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAppServerManager, type CodexAppServerEvent, type CodexAppServerProcess, type CodexAppServerSpawn } from '../src/index.js';
import type { CodexWireId } from '../src/codexAppServerProtocol.js';

type WireRequest = { id?: CodexWireId; method: string; params?: Record<string, unknown>; error?: { code: number; message: string } };

class FakeCodexProcess implements CodexAppServerProcess {
  readonly pid = 42_424;
  readonly stdin = {
    write: (chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      for (const line of text.split('\n').filter(Boolean)) {
        const wire = JSON.parse(line) as { id?: CodexWireId; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };
        const request: WireRequest = wire.method ? { id: wire.id, method: wire.method, params: wire.params } : { id: wire.id, method: '<response>', params: wire.result, ...(wire.error ? { error: wire.error } : {}) };
        this.requests.push(request);
        this.onRequest?.(request, this);
      }
      return true;
    },
  };
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly requests: WireRequest[] = [];
  readonly killSignals: NodeJS.Signals[] = [];
  killCount = 0;
  private readonly events = new EventEmitter();
  private exited = false;

  constructor(
    readonly onRequest?: (request: WireRequest, process: FakeCodexProcess) => void,
    private readonly onKill?: (signal: NodeJS.Signals, process: FakeCodexProcess) => void,
  ) {}

  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): this {
    this.events.on(event, listener);
    return this;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCount += 1;
    this.killSignals.push(signal);
    if (this.onKill) this.onKill(signal, this);
    else queueMicrotask(() => this.exit(signal === 'SIGKILL' ? 137 : 143, signal));
    return true;
  }

  respond(id: CodexWireId, result: unknown): void {
    queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify({ id, result })}\n`)));
  }

  notify(method: string, params: unknown, id?: CodexWireId): void {
    const message = id === undefined ? { method, params } : { id, method, params };
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
  }

  emitError(error = new Error('synthetic child-process error')): void {
    this.events.emit('error', error);
  }

  exit(code = 1, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.events.emit('exit', code, signal);
  }
}

function createServer(options: { respondToInitialize?: boolean; onKill?: (signal: NodeJS.Signals, process: FakeCodexProcess) => void } = {}): {
  spawn: CodexAppServerSpawn;
  processes: FakeCodexProcess[];
  calls: Array<{ command: string; args: string[] }>;
} {
  const processes: FakeCodexProcess[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  let threadSequence = 0;
  let turnSequence = 0;
  const spawn: CodexAppServerSpawn = (command, args) => {
    calls.push({ command, args: [...args] });
    const process = new FakeCodexProcess((request, current) => {
      if (request.id === undefined) return;
      if (request.method === 'initialize' && options.respondToInitialize !== false) {
        current.respond(request.id, { userAgent: 'fake-codex', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' });
      } else if (request.method === 'model/list') {
        current.respond(request.id, {
          data: [
            {
              id: 'gpt-5.4',
              model: 'gpt-5.4',
              displayName: 'GPT-5.4',
              supportedReasoningEfforts: [
                { reasoningEffort: 'medium', description: 'Balanced' },
                { reasoningEffort: 'high', description: 'Deep' },
              ],
              defaultReasoningEffort: 'medium',
            },
          ],
          nextCursor: null,
        });
      } else if (request.method === 'thread/start') {
        threadSequence += 1;
        current.respond(request.id, { thread: { id: `thread-${threadSequence}`, turns: [] }, model: request.params?.model ?? 'gpt-5.4' });
      } else if (request.method === 'thread/resume' || request.method === 'thread/read') {
        current.respond(request.id, { thread: { id: request.params?.threadId, turns: [] }, model: 'gpt-5.4' });
      } else if (request.method === 'turn/start') {
        turnSequence += 1;
        current.respond(request.id, { turn: { id: `turn-${turnSequence}`, status: 'inProgress', items: [] } });
      } else if (request.method === 'turn/steer') {
        current.respond(request.id, { turnId: request.params?.expectedTurnId });
      } else if (request.method === 'turn/interrupt') {
        current.respond(request.id, {});
      } else if (request.method === 'externalAgentConfig/detect') {
        current.respond(request.id, {
          items: [{ itemType: 'SESSIONS', description: '1 session', cwd: '/tmp/project', details: { sessions: [{ path: '/private/zeus/session.jsonl', cwd: '/tmp/project', title: 'Legacy' }] } }],
        });
      } else if (request.method === 'externalAgentConfig/import') {
        current.respond(request.id, { importId: 'import-1' });
      } else if (request.method === 'externalAgentConfig/import/readHistories') {
        current.respond(request.id, { data: [{ importId: 'import-1', completedAtMs: '1784000000000', successes: [], failures: [] }] });
      }
    }, options.onKill);
    processes.push(process);
    return process;
  };
  return { spawn, processes, calls };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('CodexAppServerManager', () => {
  it('injects an absolute private external-agent home and pins it for the manager lifetime', async () => {
    const fake = createServer();
    let spawnEnvironment: NodeJS.ProcessEnv | undefined;
    const spawn: CodexAppServerSpawn = (command, args, options) => {
      spawnEnvironment = options?.env;
      return fake.spawn(command, args);
    };
    const manager = createCodexAppServerManager({ spawn });

    await manager.ensureReady({ commandPath: '/mock/codex', externalAgentHome: '/private/application-support/zeus/legacy-agent-home' });
    expect(spawnEnvironment?.ZEUS_CODEX_EXTERNAL_AGENT_HOME).toBe('/private/application-support/zeus/legacy-agent-home');
    await expect(manager.ensureReady({ commandPath: '/mock/codex', externalAgentHome: '/private/other' })).rejects.toMatchObject({ code: 'ZEUS_CODEX_EXTERNAL_AGENT_HOME_CHANGED' });
    await manager.close();

    const relativeManager = createCodexAppServerManager({ spawn: fake.spawn });
    await expect(relativeManager.ensureReady({ commandPath: '/mock/codex', externalAgentHome: 'relative/path' })).rejects.toMatchObject({ code: 'ZEUS_CODEX_EXTERNAL_AGENT_HOME_INVALID' });
  });

  it('uses the exact external-agent RPC methods and delivers typed import events despite listener failures', async () => {
    const fake = createServer();
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-import' });
    await manager.ensureReady({ commandPath: '/mock/codex' });

    await expect(manager.detectExternalAgentConfig({ includeHome: false, cwds: ['/tmp/project'] })).resolves.toMatchObject({ items: [{ itemType: 'SESSIONS' }] });
    await expect(
      manager.startExternalAgentImport({
        source: 'zeus-legacy',
        migrationItems: [{ itemType: 'SESSIONS', description: '1 session', cwd: '/tmp/project', details: { sessions: [{ path: '/private/zeus/session.jsonl', cwd: '/tmp/project', title: 'Legacy' }] } }],
      }),
    ).resolves.toEqual({ importId: 'import-1' });
    await expect(manager.readExternalAgentImportHistories()).resolves.toEqual([{ importId: 'import-1', completedAtMs: 1784000000000n, successes: [], failures: [] }]);

    const delivered: unknown[] = [];
    manager.subscribeExternalAgentImport(() => {
      throw new Error('consumer failure');
    });
    const unsubscribe = manager.subscribeExternalAgentImport((event) => delivered.push(event));
    expect(() =>
      fake.processes[0]?.notify('externalAgentConfig/import/progress', {
        importId: 'import-1',
        itemTypeResults: [{ itemType: 'FUTURE_ITEM_TYPE', successes: [], failures: [] }],
      }),
    ).not.toThrow();
    expect(delivered).toEqual([{ type: 'progress', generationId: 'generation-import', importId: 'import-1', itemTypeResults: [{ itemType: 'FUTURE_ITEM_TYPE', successes: [], failures: [] }] }]);
    unsubscribe();
    fake.processes[0]?.notify('externalAgentConfig/import/completed', { importId: 'import-1', itemTypeResults: [] });
    expect(delivered).toHaveLength(1);

    expect(fake.processes[0]?.requests.filter((request) => request.method.startsWith('externalAgentConfig/'))).toEqual([
      { id: 'generation-import:3', method: 'externalAgentConfig/detect', params: { includeHome: false, cwds: ['/tmp/project'] } },
      {
        id: 'generation-import:4',
        method: 'externalAgentConfig/import',
        params: {
          source: 'zeus-legacy',
          migrationItems: [{ itemType: 'SESSIONS', description: '1 session', cwd: '/tmp/project', details: { sessions: [{ path: '/private/zeus/session.jsonl', cwd: '/tmp/project', title: 'Legacy' }] } }],
        },
      },
      { id: 'generation-import:5', method: 'externalAgentConfig/import/readHistories', params: {} },
    ]);
  });

  it('spawns Codex with the expanded desktop CLI search path when Finder provides a restricted PATH', async () => {
    vi.stubEnv('PATH', ['/usr/bin', '/bin'].join(delimiter));
    const fake = createServer();
    let spawnEnvironment: NodeJS.ProcessEnv | undefined;
    const spawn: CodexAppServerSpawn = (...args: Parameters<CodexAppServerSpawn>) => {
      spawnEnvironment = (args as unknown as [string, string[], { env?: NodeJS.ProcessEnv }?])[2]?.env;
      return fake.spawn(args[0], args[1]);
    };
    const manager = createCodexAppServerManager({ spawn });

    await manager.ensureReady({ commandPath: 'codex' });

    expect(spawnEnvironment?.PATH?.split(delimiter)).toEqual(expect.arrayContaining(['/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin']));
    expect(spawnEnvironment).toMatchObject({ PATH: expect.any(String) });
    await manager.close();
  });

  it('lazily spawns one private stdio server and handshakes initialize -> initialized -> model/list', async () => {
    const fake = createServer();
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-1' });

    const [first, second] = await Promise.all([manager.ensureReady({ commandPath: '/mock/codex' }), manager.ensureReady({ commandPath: '/mock/codex' })]);
    await Promise.all([
      manager.startThread({ cwd: '/tmp/one', model: 'gpt-5.4', sandbox: { type: 'readOnly', networkAccess: false } }),
      manager.startThread({ cwd: '/tmp/two', model: 'gpt-5.4', sandbox: { type: 'readOnly', networkAccess: false } }),
    ]);

    expect(fake.calls).toEqual([{ command: '/mock/codex', args: ['app-server', '--listen', 'stdio://'] }]);
    expect(fake.processes[0]?.requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'model/list', 'thread/start', 'thread/start']);
    expect(first).toEqual(second);
    expect(first.supportedModels).toEqual(['gpt-5.4']);
  });

  it('fails closed for unavailable models, unsupported effort, and unsafe sandbox while omitting absent effort', async () => {
    const fake = createServer();
    const manager = createCodexAppServerManager({ spawn: fake.spawn });
    await manager.ensureReady({ commandPath: '/mock/codex' });

    await expect(manager.startThread({ cwd: '/tmp', model: 'missing', sandbox: { type: 'readOnly', networkAccess: false } })).rejects.toMatchObject({
      code: 'ZEUS_CODEX_MODEL_UNAVAILABLE',
      supportedModels: ['gpt-5.4'],
    });
    await expect(manager.startThread({ cwd: '/tmp', model: 'gpt-5.4', sandbox: { type: 'dangerFullAccess', networkAccess: false } as never })).rejects.toMatchObject({ code: 'ZEUS_CODEX_SANDBOX_UNAVAILABLE' });
    await expect(manager.startThread({ cwd: '/tmp', model: 'gpt-5.4', sandbox: { type: 'workspaceWrite', writableRoots: ['/tmp'], networkAccess: true } })).rejects.toMatchObject({ code: 'ZEUS_CODEX_SANDBOX_UNAVAILABLE' });
    await expect(manager.startThread({ cwd: '/tmp', model: 'gpt-5.4', sandbox: { type: 'workspaceWrite', writableRoots: ['/tmp', 42], networkAccess: false } as never })).rejects.toMatchObject({ code: 'ZEUS_CODEX_SANDBOX_UNAVAILABLE' });
    await expect(manager.startThread({ cwd: '/tmp', model: 'gpt-5.4', sandbox: { type: 'readOnly', networkAccess: false }, config: { model_reasoning_effort: 'max' } } as never)).rejects.toMatchObject({
      code: 'ZEUS_CODEX_CONFIG_UNAVAILABLE',
    });

    const thread = await manager.startThread({ cwd: '/tmp', model: 'gpt-5.4', sandbox: { type: 'readOnly', networkAccess: false } });
    await expect(manager.startTurn({ threadId: thread.id, input: [{ type: 'text', text: 'bad' }], effort: 'max' })).rejects.toMatchObject({
      code: 'ZEUS_CODEX_EFFORT_UNAVAILABLE',
      supportedEfforts: ['medium', 'high'],
    });
    await expect(
      manager.startTurn({
        threadId: thread.id,
        input: [{ type: 'text', text: 'bad nested model' }],
        collaborationMode: { mode: 'plan', settings: { model: 'missing', reasoning_effort: 'medium', developer_instructions: null } },
      }),
    ).rejects.toMatchObject({ code: 'ZEUS_CODEX_MODEL_UNAVAILABLE' });
    await expect(
      manager.startTurn({
        threadId: thread.id,
        input: [{ type: 'text', text: 'bad nested effort' }],
        collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.4', reasoning_effort: 'max', developer_instructions: null } },
      }),
    ).rejects.toMatchObject({ code: 'ZEUS_CODEX_EFFORT_UNAVAILABLE' });
    await manager.startTurn({ threadId: thread.id, input: [{ type: 'text', text: 'no override' }] });
    await manager.startTurn({ threadId: thread.id, input: [{ type: 'text', text: 'validated' }], effort: 'high' });

    const turnStarts = fake.processes[0]?.requests.filter((request) => request.method === 'turn/start') ?? [];
    expect(turnStarts[0]?.params).not.toHaveProperty('effort');
    expect(turnStarts[1]?.params).toHaveProperty('effort', 'high');
  });

  it('serializes danger-full-access for Codex App compatible thread and turn permission profiles', async () => {
    const fake = createServer();
    const manager = createCodexAppServerManager({ spawn: fake.spawn });
    await manager.ensureReady({ commandPath: '/mock/codex' });

    const thread = await manager.startThread({
      cwd: '/tmp',
      model: 'gpt-5.4',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'dangerFullAccess' },
    });
    await manager.startTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'full access' }],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });

    const threadStart = fake.processes[0]?.requests.find((request) => request.method === 'thread/start');
    const turnStart = fake.processes[0]?.requests.find((request) => request.method === 'turn/start');
    expect(threadStart?.params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' });
    expect(turnStart?.params).toMatchObject({ sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' });
  });

  it('keeps three turns and out-of-order item notifications isolated by threadId, turnId, and itemId', async () => {
    const fake = createServer();
    const manager = createCodexAppServerManager({ spawn: fake.spawn, now: () => '2026-07-13T00:00:00.000Z' });
    await manager.ensureReady({ commandPath: '/mock/codex' });
    const left = await manager.startThread({ cwd: '/tmp/left', model: 'gpt-5.4', sandbox: { type: 'readOnly', networkAccess: false } });
    const right = await manager.startThread({ cwd: '/tmp/right', model: 'gpt-5.4', sandbox: { type: 'readOnly', networkAccess: false } });
    const turns = [];
    for (const text of ['one', 'two', 'three']) turns.push(await manager.startTurn({ threadId: left.id, input: [{ type: 'text', text }] }));
    const rightTurn = await manager.startTurn({ threadId: right.id, input: [{ type: 'text', text: 'right' }] });
    const events: Array<{ method: string; params: unknown; sequence: number }> = [];
    manager.subscribe((event) => events.push(event));

    fake.processes[0]?.notify('item/completed', { threadId: right.id, turnId: rightTurn.id, item: { id: 'right-item' } });
    fake.processes[0]?.notify('item/completed', { threadId: left.id, turnId: turns[2]?.id, item: { id: 'left-3-item' } });
    fake.processes[0]?.notify('item/completed', { threadId: left.id, turnId: turns[1]?.id, item: { id: 'left-2-item' } });
    fake.processes[0]?.notify('item/completed', { threadId: left.id, turnId: turns[0]?.id, item: { id: 'left-1-item' } });

    expect(events.map((event) => event.params)).toEqual([
      { threadId: right.id, turnId: rightTurn.id, item: { id: 'right-item' } },
      { threadId: left.id, turnId: turns[2]?.id, item: { id: 'left-3-item' } },
      { threadId: left.id, turnId: turns[1]?.id, item: { id: 'left-2-item' } },
      { threadId: left.id, turnId: turns[0]?.id, item: { id: 'left-1-item' } },
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(turns.map((turn) => turn.id))).toHaveLength(3);
    const buckets = new Map<string, string[]>();
    for (const event of events) {
      const params = event.params as { threadId: string; turnId: string; item: { id: string } };
      const key = `${params.threadId}/${params.turnId}`;
      buckets.set(key, [...(buckets.get(key) ?? []), params.item.id]);
    }
    expect(Object.fromEntries(buckets)).toEqual({
      [`${right.id}/${rightTurn.id}`]: ['right-item'],
      [`${left.id}/${turns[2]?.id}`]: ['left-3-item'],
      [`${left.id}/${turns[1]?.id}`]: ['left-2-item'],
      [`${left.id}/${turns[0]?.id}`]: ['left-1-item'],
    });
    expect([...buckets.keys()].filter((key) => key.startsWith(`${left.id}/`))).toHaveLength(3);
    expect([...buckets.keys()].filter((key) => key.startsWith(`${right.id}/`))).toHaveLength(1);
  });

  it('replays a bounded current-generation event window to subscribers attached after a local-server handoff', async () => {
    const fake = createServer();
    let generation = 0;
    const manager = createCodexAppServerManager({
      spawn: fake.spawn,
      generationId: () => `generation-replay-${++generation}`,
      eventReplayLimit: 2,
    });
    await manager.ensureReady({ commandPath: '/mock/codex' });

    fake.processes[0]?.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'too-old' } });
    fake.processes[0]?.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'kept' } });
    fake.processes[0]?.notify('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: ['/bin/pwd'] }, 'approval-during-handoff');

    const replayed: CodexAppServerEvent[] = [];
    const unsubscribe = manager.subscribe((event) => replayed.push(event));

    expect(replayed.map((event) => [event.sequence, event.method])).toEqual([
      [2, 'item/completed'],
      [3, 'item/commandExecution/requestApproval'],
    ]);
    expect((replayed[0]?.params as { item: { id: string } }).item.id).toBe('kept');
    await expect(
      manager.respondToServerRequest({
        type: 'command',
        generationId: 'generation-replay-1',
        requestId: 'approval-during-handoff',
        decision: 'accept',
      }),
    ).resolves.toBeUndefined();

    unsubscribe();
    vi.useFakeTimers();
    fake.processes[0]?.exit();
    await vi.advanceTimersByTimeAsync(250);
    await manager.ensureReady({ commandPath: '/mock/codex' });
    const nextGenerationReplay: CodexAppServerEvent[] = [];
    manager.subscribe((event) => nextGenerationReplay.push(event));
    expect(nextGenerationReplay).toEqual([]);
  });

  it('steers the expected turn, delays early interrupt until matching turn/started, and sends typed server responses', async () => {
    const fake = createServer();
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-typed' });
    await manager.ensureReady({ commandPath: '/mock/codex' });
    const thread = await manager.startThread({ cwd: '/tmp', model: 'gpt-5.4', sandbox: { type: 'readOnly', networkAccess: false } });
    const turn = await manager.startTurn({ threadId: thread.id, input: [{ type: 'text', text: 'start' }] });

    await expect(manager.steerTurn({ threadId: thread.id, turnId: turn.id, clientUserMessageId: 'steer-client-message', input: [{ type: 'text', text: 'steer' }] })).resolves.toEqual({ turnId: turn.id });
    expect(fake.processes[0]?.requests.find((request) => request.method === 'turn/steer')?.params).toMatchObject({
      threadId: thread.id,
      expectedTurnId: turn.id,
      clientUserMessageId: 'steer-client-message',
    });
    await manager.interruptTurn({ threadId: thread.id, turnId: turn.id });
    expect(fake.processes[0]?.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
    fake.processes[0]?.notify('turn/started', { threadId: 'other-thread', turn: { id: turn.id } });
    expect(fake.processes[0]?.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
    fake.processes[0]?.notify('turn/started', { threadId: thread.id, turn: { id: turn.id } });
    await flush();
    expect(fake.processes[0]?.requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(1);

    const process = fake.processes[0];
    process?.notify('item/commandExecution/requestApproval', { threadId: thread.id }, 'command-request');
    process?.notify('item/fileChange/requestApproval', { threadId: thread.id }, 'file-request');
    process?.notify('item/permissions/requestApproval', { threadId: thread.id }, 'permissions-request');
    process?.notify('item/tool/requestUserInput', { threadId: thread.id }, 'input-request');
    process?.notify('mcpServer/elicitation/request', { threadId: thread.id }, 'mcp-request');
    await manager.respondToServerRequest({ type: 'command', generationId: 'generation-typed', requestId: 'command-request', decision: 'accept' });
    await manager.respondToServerRequest({ type: 'file', generationId: 'generation-typed', requestId: 'file-request', decision: 'decline' });
    await manager.respondToServerRequest({
      type: 'permissions',
      generationId: 'generation-typed',
      requestId: 'permissions-request',
      permissions: {},
      scope: 'turn',
    });
    await manager.respondToServerRequest({ type: 'request_user_input', generationId: 'generation-typed', requestId: 'input-request', answers: { answer: { answers: ['yes'] } } });
    await manager.respondToServerRequest({ type: 'mcp', generationId: 'generation-typed', requestId: 'mcp-request', action: 'decline', content: null, _meta: null });

    expect(process?.requests.slice(-5)).toEqual([
      { id: 'command-request', method: '<response>', params: { decision: 'accept' } },
      { id: 'file-request', method: '<response>', params: { decision: 'decline' } },
      { id: 'permissions-request', method: '<response>', params: { permissions: {}, scope: 'turn' } },
      { id: 'input-request', method: '<response>', params: { answers: { answer: { answers: ['yes'] } } } },
      { id: 'mcp-request', method: '<response>', params: { action: 'decline', content: null, _meta: null } },
    ]);
    await expect(manager.respondToServerRequest({ type: 'command', generationId: 'old-generation', requestId: 'command-request', decision: 'accept' })).rejects.toMatchObject({
      code: 'ZEUS_CODEX_STALE_GENERATION',
    });
  });

  it('rejects unknown id-bearing server requests instead of leaving the provider pending', async () => {
    const fake = createServer();
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-unknown-request' });
    await manager.ensureReady({ commandPath: '/mock/codex' });
    const events: CodexAppServerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    fake.processes[0]?.notify('item/tool/call', { threadId: 'thread-1', turnId: 'turn-1', tool: 'future-tool' }, 'unknown-tool-request');

    expect(fake.processes[0]?.requests.at(-1)).toEqual({
      id: 'unknown-tool-request',
      method: '<response>',
      params: undefined,
      error: { code: -32601, message: 'Unsupported Codex server request method.' },
    });
    expect(events.at(-1)).toMatchObject({
      method: 'transport/unsupported_server_request',
      params: { method: 'item/tool/call', threadId: 'thread-1', turnId: 'turn-1' },
    });
    await expect(manager.respondToServerRequest({ type: 'command', generationId: 'generation-unknown-request', requestId: 'unknown-tool-request', decision: 'decline' })).rejects.toMatchObject({
      code: 'ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND',
    });
  });

  it('pins each generation-scoped server request identity while allowing exact idempotent replays', async () => {
    const fake = createServer();
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-request-identity' });
    await manager.ensureReady({ commandPath: '/mock/codex' });
    const events: CodexAppServerEvent[] = [];
    manager.subscribe((event) => events.push(event));
    const process = fake.processes[0];

    process?.notify('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: ['pwd'], metadata: { cwd: '/tmp', timeoutMs: 1_000 } }, 'idempotent-request');
    process?.notify('item/commandExecution/requestApproval', { metadata: { timeoutMs: 1_000, cwd: '/tmp' }, command: ['pwd'], turnId: 'turn-1', threadId: 'thread-1' }, 'idempotent-request');

    expect(events.filter((event) => event.requestId === 'idempotent-request' && event.method === 'item/commandExecution/requestApproval')).toHaveLength(1);
    await manager.respondToServerRequest({ type: 'command', generationId: 'generation-request-identity', requestId: 'idempotent-request', decision: 'decline' });
    process?.notify('item/commandExecution/requestApproval', { command: ['pwd'], threadId: 'thread-1', metadata: { cwd: '/tmp', timeoutMs: 1_000 }, turnId: 'turn-1' }, 'idempotent-request');
    expect(events.filter((event) => event.requestId === 'idempotent-request' && event.method === 'item/commandExecution/requestApproval')).toHaveLength(2);
    await expect(manager.respondToServerRequest({ type: 'command', generationId: 'generation-request-identity', requestId: 'idempotent-request', decision: 'decline' })).resolves.toBeUndefined();

    process?.notify('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: ['echo', 'safe'] }, 'method-conflict');
    process?.notify('item/fileChange/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: ['echo', 'safe'] }, 'method-conflict');
    process?.notify('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: ['echo', 'first'] }, 'payload-conflict');
    process?.notify('item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-1', command: ['echo', 'second'] }, 'payload-conflict');

    expect(process?.requests.filter((request) => request.method === '<response>' && (request.id === 'method-conflict' || request.id === 'payload-conflict'))).toEqual([
      {
        id: 'method-conflict',
        method: '<response>',
        params: undefined,
        error: { code: -32600, message: 'Conflicting Codex server request identity.' },
      },
      {
        id: 'payload-conflict',
        method: '<response>',
        params: undefined,
        error: { code: -32600, message: 'Conflicting Codex server request identity.' },
      },
    ]);
    expect(events.filter((event) => event.method === 'transport/server_request_identity_conflict').map((event) => event.requestId)).toEqual(['method-conflict', 'payload-conflict']);
    await expect(manager.respondToServerRequest({ type: 'command', generationId: 'generation-request-identity', requestId: 'method-conflict', decision: 'decline' })).rejects.toMatchObject({
      code: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT',
    });
    await expect(manager.respondToServerRequest({ type: 'command', generationId: 'generation-request-identity', requestId: 'payload-conflict', decision: 'decline' })).rejects.toMatchObject({
      code: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT',
    });
  });

  it('isolates valid JSON with invalid wire shapes inside the stdout callback', async () => {
    const fake = createServer();
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-invalid-shape' });
    await manager.ensureReady({ commandPath: '/mock/codex' });
    const events: CodexAppServerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    expect(() => fake.processes[0]?.stdout.emit('data', Buffer.from('null\n42\n{}\n{"method":"thread/status/changed","params":{}}\n'))).not.toThrow();

    expect(events.map((event) => event.method)).toEqual(['transport/protocol_error', 'transport/protocol_error', 'transport/protocol_error', 'thread/status/changed']);
    expect(events.slice(0, 3).map((event) => event.params)).toEqual([
      { code: 'INVALID_MESSAGE', detail: 'invalid wire message' },
      { code: 'INVALID_MESSAGE', detail: 'invalid wire message' },
      { code: 'INVALID_MESSAGE', detail: 'invalid wire message' },
    ]);
  });

  it('rejects invalid tagged server responses instead of writing unchecked payloads', async () => {
    const fake = createServer();
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-invalid-response' });
    await manager.ensureReady({ commandPath: '/mock/codex' });
    fake.processes[0]?.notify('item/commandExecution/requestApproval', {}, 'command-request');

    await expect(manager.respondToServerRequest({ type: 'command', generationId: 'generation-invalid-response', requestId: 'command-request', decision: 'allow-anything' } as never)).rejects.toMatchObject({
      code: 'ZEUS_CODEX_SERVER_RESPONSE_INVALID',
    });
    fake.processes[0]?.notify('item/permissions/requestApproval', {}, 'permissions-request');
    await expect(manager.respondToServerRequest({ type: 'permissions', generationId: 'generation-invalid-response', requestId: 'permissions-request', permissions: { evil: true }, scope: 'turn' } as never)).rejects.toMatchObject({
      code: 'ZEUS_CODEX_SERVER_RESPONSE_INVALID',
    });
    expect(fake.processes[0]?.requests.some((request) => request.method === '<response>')).toBe(false);
  });

  it('rejects pending RPCs on crash, isolates request ids by generation, applies capped backoff, and closes idempotently', async () => {
    vi.useFakeTimers();
    const processes: FakeCodexProcess[] = [];
    const delays: number[] = [];
    let generation = 0;
    const manager = createCodexAppServerManager({
      generationId: () => `generation-${++generation}`,
      onRestartScheduled: (delay) => delays.push(delay),
      spawn: () => {
        const process = new FakeCodexProcess();
        processes.push(process);
        return process;
      },
    });

    const firstReady = manager.ensureReady({ commandPath: '/mock/codex' });
    expect(processes[0]?.requests[0]?.id).toBe('generation-1:1');
    processes[0]?.exit();
    await expect(firstReady).rejects.toMatchObject({ code: 'ZEUS_CODEX_GENERATION_EXITED' });
    expect(delays).toEqual([250]);
    await vi.advanceTimersByTimeAsync(250);
    expect(processes[1]?.requests[0]?.id).toBe('generation-2:1');
    processes[1]?.exit();
    expect(delays).toEqual([250, 500]);
    await vi.advanceTimersByTimeAsync(500);
    expect(processes[2]?.requests[0]?.id).toBe('generation-3:1');
    processes[2]?.exit();
    await vi.advanceTimersByTimeAsync(1_000);
    processes[3]?.exit();
    await vi.advanceTimersByTimeAsync(2_000);
    processes[4]?.exit();
    await vi.advanceTimersByTimeAsync(5_000);
    processes[5]?.exit();
    expect(delays).toEqual([250, 500, 1_000, 2_000, 5_000, 5_000]);

    await manager.close();
    await manager.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(processes).toHaveLength(6);
    expect(manager.getState()).toEqual({ type: 'closed' });
  });

  it('kills a ready child only once and emits only redacted stderr summaries', async () => {
    const fake = createServer();
    const diagnostics: unknown[] = [];
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-log', onDiagnostic: (entry) => diagnostics.push(entry) });
    await manager.ensureReady({ commandPath: '/mock/codex' });
    fake.processes[0]?.stderr.emit('data', Buffer.from('Authorization: Bearer secret-token\npassword=hunter2'));

    await Promise.all([manager.close(), manager.close()]);

    expect(fake.processes[0]?.killCount).toBe(1);
    expect(JSON.stringify(diagnostics)).not.toContain('secret-token');
    expect(JSON.stringify(diagnostics)).not.toContain('hunter2');
    expect(diagnostics).toMatchObject([{ generationId: 'generation-log', sequence: 1 }]);
  });

  it('keeps close pending until a delayed child exit and shares one idempotent shutdown promise', async () => {
    const fake = createServer({ onKill: () => undefined });
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-delayed-close', shutdownTimeoutMs: 1_000 });
    await manager.ensureReady({ commandPath: '/mock/codex' });
    await manager.prepareForShutdown();
    expect(fake.processes[0]?.killSignals).toEqual([]);

    let settled = false;
    const firstClose = manager.close();
    const secondClose = manager.close();
    expect(secondClose).toBe(firstClose);
    void firstClose.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(fake.processes[0]?.killSignals).toEqual(['SIGTERM']);
    expect(settled).toBe(false);
    fake.processes[0]?.exit(0);
    await firstClose;
    expect(settled).toBe(true);
    expect(manager.getState()).toEqual({ type: 'closed' });
  });

  it('does not retire or replace a pid-bearing child on an error event before the real exit signal', async () => {
    vi.useFakeTimers();
    const fake = createServer({ onKill: () => undefined });
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-process-error', shutdownTimeoutMs: 1_000 });
    await manager.ensureReady({ commandPath: '/mock/codex' });

    fake.processes[0]?.emitError();
    await Promise.resolve();

    expect(manager.getState()).toMatchObject({ type: 'ready', generationId: 'generation-process-error' });
    expect(fake.processes).toHaveLength(1);

    let settled = false;
    const close = manager.close();
    void close.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(fake.processes[0]?.killSignals).toEqual(['SIGTERM']);
    expect(settled).toBe(false);

    fake.processes[0]?.exit(0);
    await close;
    expect(settled).toBe(true);
    expect(fake.processes).toHaveLength(1);
  });

  it('escalates a child that ignores SIGTERM to SIGKILL after the bounded shutdown timeout', async () => {
    vi.useFakeTimers();
    const fake = createServer({
      onKill: (signal, process) => {
        if (signal === 'SIGKILL') queueMicrotask(() => process.exit(137, 'SIGKILL'));
      },
    });
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => 'generation-force-close', shutdownTimeoutMs: 100 });
    await manager.ensureReady({ commandPath: '/mock/codex' });

    let settled = false;
    const close = manager.close();
    void close.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(fake.processes[0]?.killSignals).toEqual(['SIGTERM']);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(99);
    expect(fake.processes[0]?.killSignals).toEqual(['SIGTERM']);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await close;

    expect(fake.processes[0]?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(settled).toBe(true);
    expect(manager.getState()).toEqual({ type: 'closed' });
  });

  it('rejects callers waiting on a cancelled restart when close clears the backoff', async () => {
    const processes: FakeCodexProcess[] = [];
    const manager = createCodexAppServerManager({
      spawn: () => {
        const process = new FakeCodexProcess();
        processes.push(process);
        return process;
      },
    });
    const initial = manager.ensureReady({ commandPath: '/mock/codex' });
    processes[0]?.exit();
    await expect(initial).rejects.toMatchObject({ code: 'ZEUS_CODEX_GENERATION_EXITED' });
    const waitingForRestart = manager.ensureReady({ commandPath: '/mock/codex' });

    await manager.close();

    await expect(waitingForRestart).rejects.toMatchObject({ code: 'ZEUS_CODEX_CLOSED' });
  });

  it('does not reuse observed turn/started state across process generations', async () => {
    vi.useFakeTimers();
    const fake = createServer();
    let generation = 0;
    const manager = createCodexAppServerManager({ spawn: fake.spawn, generationId: () => `generation-${++generation}` });
    await manager.ensureReady({ commandPath: '/mock/codex' });
    const thread = await manager.startThread({ cwd: '/tmp', model: 'gpt-5.4', sandbox: { type: 'readOnly', networkAccess: false } });
    const turn = await manager.startTurn({ threadId: thread.id, input: [{ type: 'text', text: 'start' }] });
    fake.processes[0]?.notify('turn/started', { threadId: thread.id, turn: { id: turn.id } });
    fake.processes[0]?.exit();
    await vi.advanceTimersByTimeAsync(250);
    await manager.ensureReady({ commandPath: '/mock/codex' });

    await manager.interruptTurn({ threadId: thread.id, turnId: turn.id });

    expect(fake.processes[1]?.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
  });

  it('terminates a generation whose handshake response is invalid instead of caching a rejected starting promise', async () => {
    const processes: FakeCodexProcess[] = [];
    const manager = createCodexAppServerManager({
      spawn: () => {
        const process = new FakeCodexProcess((request, current) => {
          if (request.id === undefined) return;
          if (request.method === 'initialize') current.respond(request.id, {});
          if (request.method === 'model/list') current.respond(request.id, { invalid: true });
        });
        processes.push(process);
        return process;
      },
    });

    await expect(manager.ensureReady({ commandPath: '/mock/codex' })).rejects.toMatchObject({ code: 'ZEUS_CODEX_INVALID_RESPONSE' });

    expect(processes[0]?.killCount).toBe(1);
    expect(manager.getState()).toMatchObject({ type: 'restarting', attempt: 1 });
  });
});
