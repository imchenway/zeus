import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createCodexAppServerManager, type CodexAppServerEvent, type CodexAppServerManager, type CodexServerRequestResponse, type ExternalAgentImportEvent } from '../src/index.js';

const execFileAsync = promisify(execFile);
const commandPath = process.env.ZEUS_CODEX_COMMAND_PATH ?? 'codex';
type ResponseWithoutRequestIdentity<T> = T extends unknown ? Omit<T, 'generationId' | 'requestId'> : never;
type LiveApprovalResponse = ResponseWithoutRequestIdentity<CodexServerRequestResponse>;

describe('approval probe guardrails', () => {
  it('revokes an approved item after multi-file, conflicting, outside, or unknown path updates', () => {
    const approvedPath = '/tmp/zeus-codex-approval-probe-test/APPROVED.txt';
    const approvedItems = new Set<string>();
    const event = (method: string, params: unknown): CodexAppServerEvent => ({ generationId: 'test', sequence: 1, method, params, receivedAt: '2026-07-13T00:00:00.000Z' });

    recordApprovedFileItem(event('item/started', { item: { id: 'item-1', type: 'fileChange', changes: [{ relativePath: 'APPROVED.txt' }] } }), approvedPath, approvedItems);
    expect(approvedItems.has('item-1')).toBe(true);
    recordApprovedFileItem(event('item/fileChange/patchUpdated', { itemId: 'item-1', changes: [{ relativePath: 'APPROVED.txt' }, { relativePath: 'OTHER.txt' }] }), approvedPath, approvedItems);
    expect(approvedItems.has('item-1')).toBe(false);

    recordApprovedFileItem(event('item/fileChange/patchUpdated', { itemId: 'item-1', changes: [{ relativePath: 'APPROVED.txt' }] }), approvedPath, approvedItems);
    recordApprovedFileItem(event('item/fileChange/patchUpdated', { itemId: 'item-1', changes: [{ path: approvedPath, relativePath: '../escape.txt' }] }), approvedPath, approvedItems);
    expect(approvedItems.has('item-1')).toBe(false);

    recordApprovedFileItem(event('item/fileChange/patchUpdated', { itemId: 'item-1', changes: [{ relativePath: 'APPROVED.txt' }] }), approvedPath, approvedItems);
    recordApprovedFileItem(event('item/fileChange/patchUpdated', { itemId: 'item-1', changes: [{ relativePath: '../escape.txt' }] }), approvedPath, approvedItems);
    expect(approvedItems.has('item-1')).toBe(false);

    recordApprovedFileItem(event('item/fileChange/patchUpdated', { itemId: 'item-1', changes: [{ relativePath: 'APPROVED.txt' }] }), approvedPath, approvedItems);
    recordApprovedFileItem(event('item/fileChange/patchUpdated', { itemId: 'item-1', changes: [{ kind: 'update' }] }), approvedPath, approvedItems);
    expect(approvedItems.has('item-1')).toBe(false);
  });

  it('requires command, file, Plan request_user_input, and matching resolved notifications', () => {
    const evidence = createApprovalProbeEvidence();
    recordApprovalProbeEvent(evidence, { generationId: 'test', sequence: 1, method: 'item/commandExecution/requestApproval', params: {}, requestId: 'command-1', receivedAt: 'now' });
    recordApprovalProbeResponse(evidence, 'command-1');
    recordApprovalProbeEvent(evidence, { generationId: 'test', sequence: 2, method: 'serverRequest/resolved', params: { requestId: 'command-1' }, receivedAt: 'now' });
    expect(() => assertApprovalProbeEvidence(evidence)).toThrow('file approval');

    recordApprovalProbeEvent(evidence, { generationId: 'test', sequence: 3, method: 'item/fileChange/requestApproval', params: {}, requestId: 'file-1', receivedAt: 'now' });
    recordApprovalProbeResponse(evidence, 'file-1');
    recordApprovalProbeEvent(evidence, { generationId: 'test', sequence: 4, method: 'item/tool/requestUserInput', params: {}, requestId: 'input-1', receivedAt: 'now' });
    recordApprovalProbeResponse(evidence, 'input-1');
    for (const requestId of ['command-1', 'file-1', 'input-1']) {
      recordApprovalProbeEvent(evidence, { generationId: 'test', sequence: 5, method: 'serverRequest/resolved', params: { requestId }, receivedAt: 'now' });
    }
    expect(() => assertApprovalProbeEvidence(evidence)).not.toThrow();
  });

  it('does not combine a response and resolved notification from different request ids', () => {
    const evidence = createApprovalProbeEvidence();
    recordApprovalProbeEvent(evidence, { generationId: 'test', sequence: 1, method: 'item/commandExecution/requestApproval', params: {}, requestId: 'command-a', receivedAt: 'now' });
    recordApprovalProbeEvent(evidence, { generationId: 'test', sequence: 2, method: 'item/commandExecution/requestApproval', params: {}, requestId: 'command-b', receivedAt: 'now' });
    recordApprovalProbeResponse(evidence, 'command-a');
    recordApprovalProbeEvent(evidence, { generationId: 'test', sequence: 3, method: 'serverRequest/resolved', params: { requestId: 'command-b' }, receivedAt: 'now' });

    for (const [method, requestId] of [
      ['item/fileChange/requestApproval', 'file-1'],
      ['item/tool/requestUserInput', 'input-1'],
    ] as const) {
      recordApprovalProbeEvent(evidence, { generationId: 'test', sequence: 4, method, params: {}, requestId, receivedAt: 'now' });
      recordApprovalProbeResponse(evidence, requestId);
      recordApprovalProbeEvent(evidence, { generationId: 'test', sequence: 5, method: 'serverRequest/resolved', params: { requestId }, receivedAt: 'now' });
    }

    expect(() => assertApprovalProbeEvidence(evidence)).toThrow('command approval');
  });

  it('changes the controlled source content hash when an already-dirty source file changes again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zeus-source-hash-test-'));
    try {
      await execFileAsync('git', ['init', '--quiet', root]);
      await mkdir(join(root, 'packages/example/src'), { recursive: true });
      const source = join(root, 'packages/example/src/index.ts');
      await writeFile(source, 'export const value = 1;\n');
      const before = await hashProjectSourceContent(root);
      await writeFile(source, 'export const value = 2;\n');
      const after = await hashProjectSourceContent(root);
      expect(after).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Codex app-server opt-in live probes', () => {
  it.skipIf(process.env.ZEUS_LIVE_CODEX_IMPORT_PROBE !== '1')(
    'detects and imports a Zeus legacy JSONL session through the bundled Rust app-server',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'zeus-codex-import-probe-'));
      const codexHome = join(root, 'codex-home');
      const externalAgentHome = join(root, 'zeus-legacy-import');
      const projectRoot = join(root, 'project');
      const snapshotPath = join(externalAgentHome, 'projects', 'project-live', 'legacy-session.jsonl');
      const manager = createCodexAppServerManager();
      const previousCodexHome = process.env.CODEX_HOME;
      try {
        await mkdir(codexHome, { recursive: true });
        await mkdir(projectRoot, { recursive: true });
        await mkdir(join(externalAgentHome, 'projects', 'project-live'), { recursive: true });
        await writeFile(
          snapshotPath,
          [
            JSON.stringify({ type: 'custom-title', customTitle: 'Zeus live legacy import' }),
            JSON.stringify({ type: 'user', cwd: projectRoot, timestamp: '2026-07-14T00:00:00.000Z', message: { content: 'Preserve this imported question.' } }),
            JSON.stringify({ type: 'assistant', cwd: projectRoot, timestamp: '2026-07-14T00:00:01.000Z', message: { content: 'Preserve this imported answer.' } }),
          ].join('\n') + '\n',
          { mode: 0o600 },
        );
        const canonicalSnapshotPath = await realpath(snapshotPath);
        process.env.CODEX_HOME = codexHome;
        await manager.ensureReady({ commandPath, externalAgentHome });
        const detected = await manager.detectExternalAgentConfig({ includeHome: true, cwds: [projectRoot] });
        expect(detected.items.some((item) => item.itemType === 'SESSIONS')).toBe(true);

        const completed = new Promise<ExternalAgentImportEvent>((resolveCompleted, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out waiting for Codex legacy import completion.')), 30_000);
          const unsubscribe = manager.subscribeExternalAgentImport((event) => {
            if (event.type !== 'completed') return;
            clearTimeout(timeout);
            unsubscribe();
            resolveCompleted(event);
          });
        });
        const started = await manager.startExternalAgentImport({
          source: 'zeus-legacy',
          migrationItems: [
            {
              itemType: 'SESSIONS',
              description: '1 Zeus legacy session',
              cwd: projectRoot,
              details: { sessions: [{ path: canonicalSnapshotPath, cwd: projectRoot, title: 'Zeus live legacy import' }] },
            },
          ],
        });
        const event = await completed;
        expect(event.importId).toBe(started.importId);
        const success = event.itemTypeResults.flatMap((item) => item.successes).find((item) => item.source === canonicalSnapshotPath);
        if (!success?.target) throw new Error(`Codex import did not produce a thread: ${JSON.stringify(event.itemTypeResults)}`);
        expect((await manager.readThread({ threadId: success!.target })).id).toBe(success!.target);
        expect((await manager.readExternalAgentImportHistories()).some((history) => history.importId === started.importId)).toBe(true);
      } finally {
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
        await manager.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(process.env.ZEUS_LIVE_CODEX_PROBE !== '1')(
    'keeps safe three-turn, resume-generation, dual-thread, and delayed-interrupt probes isolated from approvals',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'zeus-codex-safe-probe-'));
      const firstManager = createCodexAppServerManager();
      let secondManager: CodexAppServerManager | null = null;
      try {
        await execFileAsync('git', ['init', '--quiet', root]);
        await firstManager.ensureReady({ commandPath });
        const firstEvents = collectEvents(firstManager);
        const firstThread = await firstManager.startThread({
          cwd: root,
          model: requiredLiveModel(),
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
        });
        const firstTurnIds: string[] = [];
        for (const prompt of ['Reply with SAFE-ONE only.', 'Reply with SAFE-TWO only.', 'Reply with SAFE-THREE only.']) {
          const turn = await firstManager.startTurn({ threadId: firstThread.id, input: [{ type: 'text', text: prompt }] });
          firstTurnIds.push(turn.id);
          await firstEvents.waitFor((event) => isTurnEvent(event, 'turn/completed', firstThread.id, turn.id));
        }
        expect(new Set(firstTurnIds)).toHaveLength(3);

        const secondThread = await firstManager.startThread({
          cwd: root,
          model: requiredLiveModel(),
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
        });
        expect(secondThread.id).not.toBe(firstThread.id);
        const [leftIsolationTurn, rightIsolationTurn] = await Promise.all([
          firstManager.startTurn({ threadId: firstThread.id, input: [{ type: 'text', text: 'Reply with LEFT-ISOLATED only.' }] }),
          firstManager.startTurn({ threadId: secondThread.id, input: [{ type: 'text', text: 'Reply with RIGHT-ISOLATED only.' }] }),
        ]);
        await Promise.all([
          firstEvents.waitFor((event) => isTurnEvent(event, 'turn/completed', firstThread.id, leftIsolationTurn.id)),
          firstEvents.waitFor((event) => isTurnEvent(event, 'turn/completed', secondThread.id, rightIsolationTurn.id)),
        ]);
        const interruptTurn = await firstManager.startTurn({ threadId: secondThread.id, input: [{ type: 'text', text: 'Wait until interrupted.' }] });
        await firstManager.interruptTurn({ threadId: secondThread.id, turnId: interruptTurn.id });
        await firstEvents.waitFor((event) => isTurnEvent(event, 'turn/started', secondThread.id, interruptTurn.id));
        await firstManager.close();

        secondManager = createCodexAppServerManager();
        const secondCapabilities = await secondManager.ensureReady({ commandPath });
        const resumed = await secondManager.resumeThread({ threadId: firstThread.id, cwd: root });
        expect(resumed.id).toBe(firstThread.id);
        expect(secondCapabilities.generationId).not.toBe(firstEvents.generationId);
      } finally {
        await firstManager.close();
        await secondManager?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it.skipIf(process.env.ZEUS_LIVE_CODEX_APPROVAL_PROBE !== '1')(
    'confines command, file, resolved-request, and Plan request_user_input approval probes to their temporary repository',
    async () => {
      const probeRoot = await mkdtemp('/tmp/zeus-codex-approval-probe-');
      const projectRoot = resolve(new URL('../../..', import.meta.url).pathname);
      const beforeProjectSourceHash = await hashProjectSourceContent(projectRoot);
      const manager = createCodexAppServerManager({ appServerFlags: ['--enable', 'request_permissions_tool', '--enable', 'exec_permission_approvals'] });
      const slash = '\\';
      const exactCommand = `/bin/zsh -lc "python3 -c 'print(${slash}"ZEUS-COMMAND-APPROVAL${slash}")'"`;
      const approvedPath = resolve(probeRoot, 'APPROVED.txt');
      const evidence = createApprovalProbeEvidence();
      const approvedFileItems = new Set<string>();
      try {
        await execFileAsync('git', ['init', '--quiet', probeRoot]);
        await manager.ensureReady({ commandPath });
        manager.subscribe((event) => {
          recordApprovalProbeEvent(evidence, event);
          recordApprovedFileItem(event, approvedPath, approvedFileItems);
          if (event.requestId === undefined) return;
          const response = approvalResponse(event, probeRoot, exactCommand, approvedFileItems);
          if (response) {
            void manager.respondToServerRequest({ ...response, generationId: event.generationId, requestId: event.requestId } as CodexServerRequestResponse).then(() => recordApprovalProbeResponse(evidence, event.requestId!));
          }
        });
        const thread = await manager.startThread({
          cwd: probeRoot,
          model: requiredLiveModel(),
          approvalPolicy: 'untrusted',
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly', networkAccess: false },
        });
        const events = collectEvents(manager);
        const turn = await manager.startTurn({
          threadId: thread.id,
          collaborationMode: {
            mode: 'plan',
            settings: { model: requiredLiveModel(), reasoning_effort: null, developer_instructions: null },
          },
          input: [
            {
              type: 'text',
              text: `Plan first and request user input. Then run exactly ${exactCommand}. Finally request permission to create only ${join(probeRoot, 'APPROVED.txt')}. Do nothing else.`,
            },
          ],
        });
        await events.waitFor((event) => isTurnEvent(event, 'turn/completed', thread.id, turn.id));
        assertApprovalProbeEvidence(evidence);
        expect(await readFile(join(probeRoot, 'APPROVED.txt'), 'utf8')).toBeDefined();
        expect(await hashProjectSourceContent(projectRoot)).toBe(beforeProjectSourceHash);
      } finally {
        await manager.close();
        await rm(probeRoot, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it.skip('does not claim permissions approval round-trip coverage until a separate real protocol proof exists', () => {});
});

function requiredLiveModel(): string {
  const model = process.env.ZEUS_LIVE_CODEX_MODEL;
  if (!model) throw new Error('ZEUS_LIVE_CODEX_MODEL is required for opt-in live probes.');
  return model;
}

function collectEvents(manager: CodexAppServerManager): {
  generationId: string | null;
  waitFor(predicate: (event: CodexAppServerEvent) => boolean): Promise<CodexAppServerEvent>;
} {
  const events: CodexAppServerEvent[] = [];
  const waiters = new Set<{ predicate: (event: CodexAppServerEvent) => boolean; resolve: (event: CodexAppServerEvent) => void }>();
  manager.subscribe((event) => {
    events.push(event);
    for (const waiter of waiters) {
      if (!waiter.predicate(event)) continue;
      waiters.delete(waiter);
      waiter.resolve(event);
    }
  });
  return {
    get generationId() {
      return events[0]?.generationId ?? null;
    },
    waitFor(predicate) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.add(waiter);
        setTimeout(() => {
          if (!waiters.delete(waiter)) return;
          reject(new Error('Timed out waiting for opt-in Codex live event.'));
        }, 120_000);
      });
    },
  };
}

function isTurnEvent(event: CodexAppServerEvent, method: string, threadId: string, turnId: string): boolean {
  if (event.method !== method || typeof event.params !== 'object' || event.params === null) return false;
  const params = event.params as { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } };
  return params.threadId === threadId && (params.turnId === turnId || params.turn?.id === turnId);
}

function approvalResponse(event: CodexAppServerEvent, probeRoot: string, exactCommand: string, approvedFileItems: ReadonlySet<string>): LiveApprovalResponse | null {
  const params = typeof event.params === 'object' && event.params !== null ? (event.params as Record<string, unknown>) : {};
  if (event.method === 'item/commandExecution/requestApproval') {
    return { type: 'command', decision: params.command === exactCommand ? 'accept' : 'decline' };
  }
  if (event.method === 'item/fileChange/requestApproval') {
    const onlyApprovedFile = typeof params.itemId === 'string' && approvedFileItems.has(params.itemId) && (!params.grantRoot || resolve(String(params.grantRoot)) === resolve(probeRoot));
    return { type: 'file', decision: onlyApprovedFile ? 'accept' : 'decline' };
  }
  if (event.method === 'item/permissions/requestApproval') {
    return { type: 'permissions', permissions: {}, scope: 'turn' };
  }
  if (event.method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const answers = Object.fromEntries(
      questions.filter((question): question is { id: string } => typeof question === 'object' && question !== null && typeof (question as { id?: unknown }).id === 'string').map((question) => [question.id, { answers: ['continue'] }]),
    );
    return { type: 'request_user_input', answers };
  }
  if (event.method === 'mcpServer/elicitation/request') {
    return { type: 'mcp', action: 'decline', content: null, _meta: null };
  }
  return null;
}

function recordApprovedFileItem(event: CodexAppServerEvent, approvedPath: string, approvedFileItems: Set<string>): void {
  if (typeof event.params !== 'object' || event.params === null) return;
  const params = event.params as { itemId?: unknown; item?: { id?: unknown; type?: unknown; changes?: unknown }; changes?: unknown };
  const isStartedFileChange = event.method === 'item/started' && params.item?.type === 'fileChange';
  const isPatchUpdate = event.method === 'item/fileChange/patchUpdated';
  if (!isStartedFileChange && !isPatchUpdate) return;
  const itemId = isPatchUpdate ? params.itemId : params.item?.id;
  if (typeof itemId !== 'string') return;
  approvedFileItems.delete(itemId);
  const changes = isPatchUpdate ? params.changes : params.item?.changes;
  if (!Array.isArray(changes) || changes.length !== 1) return;
  const change = changes[0];
  if (typeof change !== 'object' || change === null) return;
  const { path, relativePath } = change as { path?: unknown; relativePath?: unknown };
  if (path !== undefined && typeof path !== 'string') return;
  if (relativePath !== undefined && typeof relativePath !== 'string') return;
  if (path === undefined && relativePath === undefined) return;
  const root = probeRootFor(approvedPath);
  const resolvedPath = typeof path === 'string' ? resolve(root, path) : null;
  const resolvedRelativePath = typeof relativePath === 'string' ? resolve(root, relativePath) : null;
  if (resolvedPath && resolvedRelativePath && resolvedPath !== resolvedRelativePath) return;
  if ((resolvedPath ?? resolvedRelativePath) === approvedPath) approvedFileItems.add(itemId);
}

function probeRootFor(approvedPath: string): string {
  return resolve(approvedPath, '..');
}

type ApprovalProbeKind = 'command approval' | 'file approval' | 'Plan request_user_input';
type ApprovalProbeEvidence = {
  requestKinds: Map<string, ApprovalProbeKind>;
  responded: Set<string>;
  resolved: Set<string>;
};

function createApprovalProbeEvidence(): ApprovalProbeEvidence {
  return { requestKinds: new Map(), responded: new Set(), resolved: new Set() };
}

function recordApprovalProbeEvent(evidence: ApprovalProbeEvidence, event: CodexAppServerEvent): void {
  if (event.requestId !== undefined) {
    const kind = approvalKindForMethod(event.method);
    if (kind) evidence.requestKinds.set(wireIdKey(event.requestId), kind);
  }
  if (event.method !== 'serverRequest/resolved' || typeof event.params !== 'object' || event.params === null) return;
  const requestId = (event.params as { requestId?: unknown }).requestId;
  if (typeof requestId === 'string' || typeof requestId === 'number') evidence.resolved.add(wireIdKey(requestId));
}

function recordApprovalProbeResponse(evidence: ApprovalProbeEvidence, requestId: string | number): void {
  evidence.responded.add(wireIdKey(requestId));
}

function assertApprovalProbeEvidence(evidence: ApprovalProbeEvidence): void {
  for (const kind of ['command approval', 'file approval', 'Plan request_user_input'] as const) {
    const entries = [...evidence.requestKinds].filter(([, recordedKind]) => recordedKind === kind);
    if (entries.length === 0) throw new Error(`Missing ${kind} request.`);
    if (!entries.some(([requestId]) => evidence.responded.has(requestId) && evidence.resolved.has(requestId))) {
      throw new Error(`Missing same-request response and serverRequest/resolved for ${kind}.`);
    }
  }
}

function approvalKindForMethod(method: string): ApprovalProbeKind | null {
  if (method === 'item/commandExecution/requestApproval') return 'command approval';
  if (method === 'item/fileChange/requestApproval') return 'file approval';
  if (method === 'item/tool/requestUserInput') return 'Plan request_user_input';
  return null;
}

function wireIdKey(requestId: string | number): string {
  return `${typeof requestId}:${String(requestId)}`;
}

async function hashProjectSourceContent(projectRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'scripts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json', 'eslint.config.js', 'prettier.config.js'],
    { cwd: projectRoot },
  );
  const paths = stdout
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    const content = await readFile(resolve(projectRoot, path));
    hash.update(path);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
  }
  return hash.digest('hex');
}
