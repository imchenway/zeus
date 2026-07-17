import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexAppServerManager, CodexThreadSnapshot, CodexTransportState } from '@zeus/ai-runtime';
import {
  ConversationItemRepository,
  ConversationRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  createZeusDatabase,
  ProjectRepository,
  RuntimeSessionRepository,
  TaskEventRepository,
  TaskRepository,
} from '@zeus/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyCodexThreads } from '../src/legacyCodexThreadMigration.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class MigrationCodexManager implements CodexAppServerManager {
  readonly resumes: string[] = [];
  readonly reads: string[] = [];
  readonly failures = new Set<string>();
  state: CodexTransportState = {
    type: 'ready',
    generationId: 'legacy-import-generation',
    capabilities: {
      generationId: 'legacy-import-generation',
      initializedAt: '2026-07-14T00:00:00.000Z',
      models: [],
      supportedModels: ['gpt-5.5'],
    },
  };

  constructor(readonly snapshots: Map<string, CodexThreadSnapshot>) {}

  async ensureReady() {
    if (this.state.type !== 'ready') throw new Error('transport unavailable');
    return this.state.capabilities;
  }

  async resumeThread(input: { threadId: string }) {
    this.resumes.push(input.threadId);
    if (this.failures.has(input.threadId)) throw new Error(`resume failed: ${input.threadId}`);
    const snapshot = this.snapshots.get(input.threadId);
    if (!snapshot) throw new Error(`missing snapshot: ${input.threadId}`);
    return snapshot;
  }

  async readThread(input: { threadId: string }) {
    this.reads.push(input.threadId);
    if (this.failures.has(input.threadId)) throw new Error(`read failed: ${input.threadId}`);
    const snapshot = this.snapshots.get(input.threadId);
    if (!snapshot) throw new Error(`missing snapshot: ${input.threadId}`);
    return snapshot;
  }

  async startThread(): Promise<CodexThreadSnapshot> {
    throw new Error('not used');
  }

  async startTurn() {
    throw new Error('not used');
  }

  async steerTurn() {
    throw new Error('not used');
  }

  async interruptTurn() {}
  async respondToServerRequest() {}
  subscribe() {
    return () => undefined;
  }
  getState() {
    return this.state;
  }
  async prepareForShutdown() {}
  async close() {}
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'zeus-legacy-thread-import-'));
  cleanup.push(directory);
  const db = await createZeusDatabase(join(directory, 'zeus.db'));
  const projects = new ProjectRepository(db);
  const tasks = new TaskRepository(db);
  const taskEvents = new TaskEventRepository(db);
  const runtimeSessions = new RuntimeSessionRepository(db);
  const conversations = new ConversationRepository(db);
  const turns = new ConversationTurnRepository(db);
  const items = new ConversationItemRepository(db);
  const submissions = new ConversationSubmissionRepository(db);
  const project = projects.create({ name: 'tc-app-core', localPath: directory });
  const task = tasks.create({
    projectId: project.id,
    title: '分析当前项目结构',
    description: '基于真实扫描和 Git 状态分析当前仓库',
    createdFrom: 'user',
    sourceContext: { path: directory },
    allowCodeChanges: true,
    allowTests: true,
    allowGitCommit: false,
  });
  const legacy = conversations.create({
    projectId: project.id,
    taskId: task.id,
    title: `任务会话：${task.title}`,
    summary: '旧 Zeus 聚合会话',
    status: 'exited',
    transportKind: 'legacy_cli',
  });
  return { db, projects, tasks, taskEvents, runtimeSessions, conversations, turns, items, submissions, project, task, legacy };
}

function appendRuntime(input: { fixture: Awaited<ReturnType<typeof createFixture>>; runtimeSessionId: string; threadIds: string[]; eventType?: string; projectId?: string; taskId?: string; includeModel?: boolean }) {
  const { fixture } = input;
  fixture.runtimeSessions.create({
    id: input.runtimeSessionId,
    projectId: input.projectId ?? fixture.project.id,
    taskId: input.taskId ?? fixture.task.id,
    command: 'codex',
    args: ['exec', '真实任务提示'],
    cwd: fixture.project.localPath,
    status: 'exited',
    startedAt: '2026-07-09T09:00:00.000Z',
  });
  fixture.runtimeSessions.appendLog({
    id: `runtime-log-${input.runtimeSessionId}`,
    sessionId: input.runtimeSessionId,
    stream: 'stdout',
    text: `OpenAI Codex v0.142.5\n${input.includeModel === false ? '' : 'model: gpt-5.5\n'}${input.threadIds.map((threadId) => `session id: ${threadId}`).join('\n')}`,
    createdAt: '2026-07-09T09:00:01.000Z',
  });
  fixture.taskEvents.create({
    taskId: fixture.task.id,
    eventType: input.eventType ?? 'task.runtime.run',
    title: '真实 Runtime 事件',
    payload: { runtimeSessionId: input.runtimeSessionId, conversationId: fixture.legacy.id, projectId: fixture.project.id, adapterId: 'codex' },
  });
}

function snapshot(threadId: string, turnId: string, status: 'completed' | 'interrupted' = 'completed'): CodexThreadSnapshot {
  return {
    id: threadId,
    path: `/Users/david/.codex/sessions/2026/07/09/rollout-${threadId}.jsonl`,
    cwd: '/Users/david/cckg/tcapp/Back-End/tc-app-core',
    cliVersion: '0.142.5',
    preview: `真实历史 ${threadId}`,
    createdAt: 1_783_576_287,
    updatedAt: 1_783_576_300,
    status: { type: 'idle' },
    turns: [
      {
        id: turnId,
        status,
        startedAt: 1_783_576_287,
        completedAt: status === 'completed' ? 1_783_576_300 : null,
        items: [
          { id: `${turnId}-user`, type: 'userMessage', clientId: `${turnId}-client`, content: [{ type: 'text', text: `用户消息 ${threadId}` }] },
          { id: `${turnId}-assistant`, type: 'agentMessage', text: `助手回复 ${threadId}`, phase: 'final_answer' },
        ],
      },
    ],
  };
}

function migrationInput(fixture: Awaited<ReturnType<typeof createFixture>>, manager: MigrationCodexManager) {
  return {
    db: fixture.db,
    projects: fixture.projects,
    tasks: fixture.tasks,
    taskEvents: fixture.taskEvents,
    runtimeSessions: fixture.runtimeSessions,
    conversations: fixture.conversations,
    turns: fixture.turns,
    items: fixture.items,
    submissions: fixture.submissions,
    manager,
    commandPath: 'codex',
  };
}

describe('legacy Codex thread migration', () => {
  it('splits one legacy aggregate into one native conversation per verified Codex thread', async () => {
    const fixture = await createFixture();
    const firstThreadId = '019f461b-9a85-7983-9779-e4bd0fff6676';
    const secondThreadId = '019f463f-5e6f-75c0-b168-34b375e54be2';
    appendRuntime({ fixture, runtimeSessionId: 'ai-session-first', threadIds: [firstThreadId] });
    appendRuntime({ fixture, runtimeSessionId: 'ai-session-second', threadIds: [secondThreadId], eventType: 'task.runtime.reconnect' });
    const manager = new MigrationCodexManager(
      new Map([
        [firstThreadId, snapshot(firstThreadId, 'turn-first')],
        [secondThreadId, snapshot(secondThreadId, 'turn-second', 'interrupted')],
      ]),
    );

    const report = await migrateLegacyCodexThreads(migrationInput(fixture, manager));

    expect(report.imported.map((entry) => entry.providerThreadId)).toEqual([firstThreadId, secondThreadId]);
    expect(report.archivedSourceConversationIds).toEqual([fixture.legacy.id]);
    expect(manager.resumes).toEqual([firstThreadId, secondThreadId]);
    expect(manager.reads).toEqual([firstThreadId, secondThreadId]);
    const active = fixture.conversations.listByProject(fixture.project.id, { limit: 20 }).items;
    expect(active).toHaveLength(2);
    expect(active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transportKind: 'codex_native', providerThreadId: firstThreadId, providerState: 'ready', legacySourceConversationId: fixture.legacy.id }),
        expect.objectContaining({ transportKind: 'codex_native', providerThreadId: secondThreadId, providerState: 'ready', legacySourceConversationId: fixture.legacy.id }),
      ]),
    );
    expect(fixture.conversations.listByProject(fixture.project.id, { archived: true, limit: 20 }).items).toEqual([expect.objectContaining({ id: fixture.legacy.id, transportKind: 'legacy_cli' })]);
    for (const conversation of active) {
      expect(fixture.turns.listByConversation(conversation.id)).toHaveLength(1);
      expect(fixture.items.listByConversation(conversation.id).map((item) => item.itemType)).toEqual(['userMessage', 'agentMessage']);
      expect(fixture.conversations.listMessages(conversation.id)).toEqual([expect.objectContaining({ role: 'user', providerThreadId: conversation.providerThreadId })]);
    }
  });

  it('is idempotent and keeps the legacy source visible until every discovered thread is imported', async () => {
    const fixture = await createFixture();
    const firstThreadId = '019f456e-599f-7872-a6f8-3a4bd0937c44';
    const secondThreadId = '019f461b-9a85-7983-9779-e4bd0fff6676';
    appendRuntime({ fixture, runtimeSessionId: 'ai-session-first', threadIds: [firstThreadId] });
    appendRuntime({ fixture, runtimeSessionId: 'ai-session-second', threadIds: [secondThreadId] });
    const manager = new MigrationCodexManager(
      new Map([
        [firstThreadId, snapshot(firstThreadId, 'turn-first')],
        [secondThreadId, snapshot(secondThreadId, 'turn-second')],
      ]),
    );
    manager.failures.add(secondThreadId);

    const partial = await migrateLegacyCodexThreads(migrationInput(fixture, manager));

    expect(partial.imported).toHaveLength(1);
    expect(partial.archivedSourceConversationIds).toEqual([]);
    expect(fixture.conversations.getById(fixture.legacy.id)?.archived).toBe(false);

    manager.failures.delete(secondThreadId);
    const completed = await migrateLegacyCodexThreads(migrationInput(fixture, manager));
    const repeated = await migrateLegacyCodexThreads(migrationInput(fixture, manager));

    expect(completed.existing.map((entry) => entry.providerThreadId)).toContain(firstThreadId);
    expect(completed.imported.map((entry) => entry.providerThreadId)).toEqual([secondThreadId]);
    expect(completed.archivedSourceConversationIds).toEqual([fixture.legacy.id]);
    expect(repeated.imported).toEqual([]);
    expect(fixture.conversations.listByProject(fixture.project.id, { limit: 20 }).items).toHaveLength(2);
    expect(fixture.turns.listByConversation(fixture.conversations.getByProviderThreadId(firstThreadId)!.id)).toHaveLength(1);
    expect(fixture.items.listByConversation(fixture.conversations.getByProviderThreadId(firstThreadId)!.id)).toHaveLength(2);
    expect(fixture.conversations.listMessages(fixture.conversations.getByProviderThreadId(firstThreadId)!.id)).toHaveLength(1);
  });

  it('fails closed for ambiguous Runtime logs and leaves the legacy conversation unchanged', async () => {
    const fixture = await createFixture();
    const firstThreadId = '019f456e-599f-7872-a6f8-3a4bd0937c44';
    const secondThreadId = '019f461b-9a85-7983-9779-e4bd0fff6676';
    appendRuntime({ fixture, runtimeSessionId: 'ai-session-ambiguous', threadIds: [firstThreadId, secondThreadId] });
    const manager = new MigrationCodexManager(new Map());

    const report = await migrateLegacyCodexThreads(migrationInput(fixture, manager));

    expect(report.imported).toEqual([]);
    expect(report.skipped).toEqual([expect.objectContaining({ sourceConversationId: fixture.legacy.id, runtimeSessionId: 'ai-session-ambiguous', reason: 'ambiguous_provider_thread_id' })]);
    expect(manager.resumes).toEqual([]);
    expect(fixture.conversations.getById(fixture.legacy.id)?.archived).toBe(false);
    expect(fixture.conversations.listByProject(fixture.project.id, { limit: 20 }).items).toEqual([expect.objectContaining({ id: fixture.legacy.id, transportKind: 'legacy_cli' })]);
  });

  it('rejects a task event that points at a Runtime owned by another project', async () => {
    const fixture = await createFixture();
    const otherProject = fixture.projects.create({ name: 'other-project', localPath: join(fixture.project.localPath, 'other') });
    const threadId = '019f456e-599f-7872-a6f8-3a4bd0937c44';
    appendRuntime({ fixture, runtimeSessionId: 'ai-session-wrong-owner', threadIds: [threadId], projectId: otherProject.id });
    const manager = new MigrationCodexManager(new Map([[threadId, snapshot(threadId, 'turn-wrong-owner')]]));

    const report = await migrateLegacyCodexThreads(migrationInput(fixture, manager));

    expect(report.imported).toEqual([]);
    expect(report.skipped).toEqual([expect.objectContaining({ runtimeSessionId: 'ai-session-wrong-owner', reason: 'runtime_ownership_conflict' })]);
    expect(manager.resumes).toEqual([]);
    expect(fixture.conversations.getById(fixture.legacy.id)?.archived).toBe(false);
  });

  it('keeps model-less Runtime history read-only because a future native turn cannot preserve the model', async () => {
    const fixture = await createFixture();
    const threadId = '019f456e-599f-7872-a6f8-3a4bd0937c44';
    appendRuntime({ fixture, runtimeSessionId: 'ai-session-no-model', threadIds: [threadId], includeModel: false });
    const manager = new MigrationCodexManager(new Map([[threadId, snapshot(threadId, 'turn-no-model')]]));

    const report = await migrateLegacyCodexThreads(migrationInput(fixture, manager));

    expect(report.imported).toEqual([]);
    expect(report.skipped).toEqual([expect.objectContaining({ runtimeSessionId: 'ai-session-no-model', reason: 'missing_provider_model' })]);
    expect(manager.resumes).toEqual([]);
    expect(fixture.conversations.getById(fixture.legacy.id)?.archived).toBe(false);
  });

  it('does not invent submission text when a provider turn has no user message', async () => {
    const fixture = await createFixture();
    const threadId = '019f456e-599f-7872-a6f8-3a4bd0937c44';
    appendRuntime({ fixture, runtimeSessionId: 'ai-session-no-user-message', threadIds: [threadId] });
    const providerSnapshot = snapshot(threadId, 'turn-no-user-message');
    providerSnapshot.turns[0]!.items = [{ id: 'turn-no-user-message-assistant', type: 'agentMessage', text: 'provider reply', phase: 'final_answer' }];
    const manager = new MigrationCodexManager(new Map([[threadId, providerSnapshot]]));

    const report = await migrateLegacyCodexThreads(migrationInput(fixture, manager));

    expect(report.imported).toEqual([]);
    expect(report.skipped).toEqual([expect.objectContaining({ runtimeSessionId: 'ai-session-no-user-message', reason: 'provider_snapshot_import_failed' })]);
    expect(fixture.conversations.getByProviderThreadId(threadId)).toBeUndefined();
    expect(fixture.conversations.getById(fixture.legacy.id)?.archived).toBe(false);
  });
});
