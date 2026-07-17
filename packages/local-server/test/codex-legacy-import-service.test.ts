import { mkdtemp, mkdir, realpath, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerManager, ExternalAgentImportEvent } from '@zeus/ai-runtime';
import { CodexLegacyImportRepository, ConversationRepository, createZeusDatabase, ProjectRepository } from '@zeus/storage';
import { createCodexLegacyImportService } from '../src/codexLegacyImportService.js';

function createManager() {
  let listener: ((event: ExternalAgentImportEvent) => void) | undefined;
  const manager = {
    ensureReady: vi.fn(async () => ({ generationId: 'generation-1', initializedAt: '2026-07-14T00:00:00.000Z', models: [], supportedModels: [] })),
    detectExternalAgentConfig: vi.fn(async () => ({ items: [] })),
    startExternalAgentImport: vi.fn(async () => ({ importId: 'provider-import-1' })),
    readExternalAgentImportHistories: vi.fn(async () => []),
    readThread: vi.fn(async ({ threadId }: { threadId: string }) => ({ id: threadId, turns: [] })),
    subscribeExternalAgentImport: vi.fn((next: (event: ExternalAgentImportEvent) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
    emit(event: ExternalAgentImportEvent) {
      listener?.(event);
    },
  };
  return manager;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Codex legacy import service', () => {
  it('detects only eligible legacy conversations and atomically writes Codex-compatible 0600 JSONL snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zeus-codex-import-detect-'));
    const projectRoot = join(root, 'project');
    const sourceRoot = join(root, 'application-support', 'codex-legacy');
    await mkdir(projectRoot, { recursive: true });
    try {
      const db = await createZeusDatabase(join(root, 'zeus.db'));
      const projects = new ProjectRepository(db);
      const conversations = new ConversationRepository(db);
      const project = projects.create({ name: 'Project', localPath: projectRoot });
      const eligible = conversations.create({ projectId: project.id, title: '旧会话', transportKind: 'legacy_cli' });
      conversations.appendMessage({ conversationId: eligible.id, role: 'user', content: '第一条问题', source: 'task_prompt', metadata: {}, createdAt: '2026-07-14T00:00:00.000Z' });
      conversations.appendMessage({ conversationId: eligible.id, role: 'assistant', content: '第一条回答', source: 'runtime', metadata: {}, createdAt: '2026-07-14T00:00:01.000Z' });
      conversations.create({ projectId: project.id, title: '没有用户消息', transportKind: 'legacy_cli' });
      conversations.create({ projectId: project.id, title: '已经是 native', transportKind: 'codex_native', providerThreadId: 'thread-existing', providerState: 'ready' });
      const manager = createManager();
      const service = createCodexLegacyImportService({
        manager: manager as unknown as CodexAppServerManager,
        db,
        conversations,
        imports: new CodexLegacyImportRepository(db),
        sourceRoot,
        allowedProjectRoots: [projectRoot],
        commandPath: '/bundled/codex',
        providerBinaryVersion: '0.144.2',
      });

      const snapshot = await service.detect();
      const canonicalProjectRoot = await realpath(projectRoot);
      const canonicalSourceRoot = await realpath(sourceRoot);

      expect(snapshot.eligible).toHaveLength(1);
      expect(snapshot.eligible[0]).toMatchObject({ sourceConversationId: eligible.id, title: '旧会话', cwd: canonicalProjectRoot });
      const snapshotPath = snapshot.eligible[0]!.snapshotPath;
      expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600);
      const lines = (await readFile(snapshotPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toEqual([
        { type: 'custom-title', customTitle: '旧会话' },
        { type: 'user', cwd: canonicalProjectRoot, timestamp: '2026-07-14T00:00:00.000Z', message: { content: '第一条问题' } },
        { type: 'assistant', cwd: canonicalProjectRoot, timestamp: '2026-07-14T00:00:01.000Z', message: { content: '第一条回答' } },
      ]);
      expect(manager.ensureReady).toHaveBeenCalledWith({ commandPath: '/bundled/codex', externalAgentHome: canonicalSourceRoot });
      expect(manager.detectExternalAgentConfig).toHaveBeenCalledWith({ includeHome: true, cwds: [canonicalProjectRoot] });
      await service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('imports once, validates the target thread, then atomically exposes a resumable native conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zeus-codex-import-success-'));
    const projectRoot = join(root, 'project');
    const sourceRoot = join(root, 'legacy-source');
    await mkdir(projectRoot, { recursive: true });
    try {
      const db = await createZeusDatabase(join(root, 'zeus.db'));
      const projects = new ProjectRepository(db);
      const conversations = new ConversationRepository(db);
      const project = projects.create({ name: 'Project', localPath: projectRoot });
      const source = conversations.create({ projectId: project.id, title: '继续这个会话', transportKind: 'legacy_cli' });
      conversations.appendMessage({ conversationId: source.id, role: 'user', content: '继续前的消息', source: 'task_prompt', metadata: {}, createdAt: '2026-07-14T00:00:00.000Z' });
      const imports = new CodexLegacyImportRepository(db);
      const manager = createManager();
      const service = createCodexLegacyImportService({
        manager: manager as unknown as CodexAppServerManager,
        db,
        conversations,
        imports,
        sourceRoot,
        allowedProjectRoots: [projectRoot],
        commandPath: '/bundled/codex',
        providerBinaryVersion: '0.144.2',
      });

      const started = await service.start({ sourceConversationIds: [source.id] });
      expect(started).toMatchObject({ importId: 'provider-import-1', status: 'waiting' });
      const run = imports.getByImportId('provider-import-1')[0]!;
      manager.emit({
        type: 'completed',
        generationId: 'generation-1',
        importId: 'provider-import-1',
        itemTypeResults: [{ itemType: 'SESSIONS', successes: [{ itemType: 'SESSIONS', cwd: projectRoot, source: run.snapshotPath, target: 'thread-imported' }], failures: [] }],
      });
      await flush();

      expect(manager.readThread).toHaveBeenCalledWith({ threadId: 'thread-imported' });
      const completed = service.get('provider-import-1').runs[0]!;
      expect(completed).toMatchObject({ status: 'completed', targetThreadId: 'thread-imported', targetConversationId: expect.any(String) });
      expect(conversations.getById(source.id)?.archived).toBe(true);
      expect(conversations.getById(completed.targetConversationId!)?.providerState).toBe('ready');

      await expect(service.start({ sourceConversationIds: [source.id] })).resolves.toMatchObject({ importId: 'provider-import-1', status: 'completed' });
      expect(manager.startExternalAgentImport).toHaveBeenCalledTimes(1);
      await service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the legacy source readable when provider completion cannot be validated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zeus-codex-import-failure-'));
    const projectRoot = join(root, 'project');
    await mkdir(projectRoot, { recursive: true });
    try {
      const db = await createZeusDatabase(join(root, 'zeus.db'));
      const projects = new ProjectRepository(db);
      const conversations = new ConversationRepository(db);
      const project = projects.create({ name: 'Project', localPath: projectRoot });
      const source = conversations.create({ projectId: project.id, title: '不能丢', transportKind: 'legacy_cli' });
      conversations.appendMessage({ conversationId: source.id, role: 'user', content: '保留', source: 'task_prompt', metadata: {}, createdAt: '2026-07-14T00:00:00.000Z' });
      const imports = new CodexLegacyImportRepository(db);
      const manager = createManager();
      manager.readThread.mockRejectedValueOnce(new Error('secret-token provider read failed'));
      const service = createCodexLegacyImportService({
        manager: manager as unknown as CodexAppServerManager,
        db,
        conversations,
        imports,
        sourceRoot: join(root, 'legacy'),
        allowedProjectRoots: [projectRoot],
        commandPath: '/bundled/codex',
        providerBinaryVersion: '0.144.2',
      });
      await service.start({ sourceConversationIds: [source.id] });
      const run = imports.getByImportId('provider-import-1')[0]!;

      manager.emit({
        type: 'completed',
        generationId: 'generation-1',
        importId: 'provider-import-1',
        itemTypeResults: [{ itemType: 'SESSIONS', successes: [{ itemType: 'SESSIONS', cwd: projectRoot, source: run.snapshotPath, target: 'thread-unreadable' }], failures: [] }],
      });
      await flush();

      expect(conversations.getById(source.id)?.archived).toBe(false);
      expect(imports.getById(run.id)).toMatchObject({ status: 'failed', failureStage: 'thread_read' });
      expect(imports.getById(run.id)?.failureMessage).not.toContain('secret-token');
      await expect(service.detect()).resolves.toMatchObject({
        runs: [expect.objectContaining({ id: run.id, status: 'failed', failureStage: 'thread_read' })],
      });
      await service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
