import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeSessionRepository, TerminalEventRepository, createZeusDatabase } from '../src/index.js';

describe('RuntimeSessionRepository', () => {
  it('persists runtime sessions and logs across database reopen without seed data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-storage-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const repository = new RuntimeSessionRepository(db);
      const session = repository.create({
        id: 'session-real-1',
        projectId: 'project-1',
        taskId: 'task-1',
        command: 'codex',
        args: ['--version'],
        cwd: '/Users/david/hypha/zeus',
        status: 'running',
        pid: 123,
        startedAt: '2026-06-13T00:00:00.000Z',
      });
      repository.appendLog({
        id: 'log-real-1',
        sessionId: session.id,
        stream: 'stdout',
        text: '真实 Runtime 输出',
        createdAt: '2026-06-13T00:00:01.000Z',
      });
      repository.updateStatus(session.id, {
        status: 'exited',
        exitCode: 0,
        endedAt: '2026-06-13T00:00:02.000Z',
      });
      await db.save();

      const reopened = await createZeusDatabase(dbPath);
      const restored = new RuntimeSessionRepository(reopened);

      expect(
        restored.list().map((item) => ({
          id: item.id,
          status: item.status,
          exitCode: item.exitCode,
        })),
      ).toEqual([{ id: 'session-real-1', status: 'exited', exitCode: 0 }]);
      expect(restored.listLogs(session.id).map((log) => `${log.stream}:${log.text}`)).toEqual(['stdout:真实 Runtime 输出']);
      expect(new TerminalEventRepository(reopened).listBySession(session.id).map((event) => `${event.seq}:${event.eventType}:${event.content}`)).toEqual(['1:stdout:真实 Runtime 输出']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('searches, favorites, archives, deletes, and summarizes runtime sessions from real logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-management-'));
  const dbPath = join(dir, 'zeus.db');
  try {
    const db = await createZeusDatabase(dbPath);
    const repository = new RuntimeSessionRepository(db);
    const session = repository.create({
      id: 'session-manage-1',
      projectId: 'project-1',
      command: 'codex',
      args: ['--version'],
      cwd: '/Users/david/hypha/zeus',
      status: 'exited',
      startedAt: '2026-06-13T00:00:00.000Z',
    });
    repository.appendLog({
      id: 'log-manage-1',
      sessionId: session.id,
      stream: 'stdout',
      text: '真实分析完成：发现 Runtime 风险',
      createdAt: '2026-06-13T00:00:01.000Z',
    });
    repository.appendLog({
      id: 'log-manage-2',
      sessionId: session.id,
      stream: 'stderr',
      text: '真实警告：需要人工确认',
      createdAt: '2026-06-13T00:00:02.000Z',
    });

    const summary = repository.generateSummary(session.id);
    const favorite = repository.setFavorite(session.id, true);
    const searched = repository.list({
      query: 'Runtime 风险',
      favoriteOnly: true,
    });
    const archived = repository.archive(session.id);
    const archivedList = repository.list({ archived: true });
    const deleted = repository.delete(session.id);

    expect(summary.summary).toContain('真实分析完成');
    expect(favorite.favorite).toBe(true);
    expect(searched.map((item) => item.id)).toEqual([session.id]);
    expect(archived.archived).toBe(true);
    expect(archivedList.map((item) => item.id)).toEqual([session.id]);
    expect(deleted.deletedAt).toBeTruthy();
    expect(repository.list({ archived: true }).map((item) => item.id)).toEqual([]);
    expect(new TerminalEventRepository(db).listBySession(session.id).map((event) => `${event.seq}:${event.eventType}`)).toEqual(['1:stdout', '2:stderr']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not persist a fake runtime summary when a session has no real logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-empty-summary-'));
  const dbPath = join(dir, 'zeus.db');
  try {
    const db = await createZeusDatabase(dbPath);
    const repository = new RuntimeSessionRepository(db);
    const session = repository.create({
      id: 'session-empty-summary-1',
      projectId: 'project-1',
      command: 'codex',
      args: ['--version'],
      cwd: '/Users/david/hypha/zeus',
      status: 'exited',
      startedAt: '2026-06-13T00:00:00.000Z',
    });

    const summary = repository.generateSummary(session.id);

    expect(summary.summary).toBeNull();
    expect(repository.getById(session.id)?.summary).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('paginates terminal events in SQLite without requiring callers to load the whole session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-terminal-events-page-'));
  const dbPath = join(dir, 'zeus.db');
  try {
    const db = await createZeusDatabase(dbPath);
    const runtimeSessions = new RuntimeSessionRepository(db);
    const terminalEvents = new TerminalEventRepository(db);
    const session = runtimeSessions.create({
      id: 'session-terminal-page-1',
      projectId: 'project-1',
      command: 'codex',
      args: ['run'],
      cwd: '/Users/david/hypha/zeus',
      status: 'running',
      startedAt: '2026-06-13T00:00:00.000Z',
    });
    for (const index of [1, 2, 3]) {
      runtimeSessions.appendLog({
        id: `log-terminal-page-${index}`,
        sessionId: session.id,
        stream: 'stdout',
        text: `真实终端事件 ${index}`,
        createdAt: `2026-06-13T00:00:0${index}.000Z`,
      });
    }

    const page = terminalEvents.listBySessionPage(session.id, {
      limit: 1,
      offset: 1,
    });

    expect(page).toMatchObject({
      sessionId: session.id,
      total: 3,
      limit: 1,
      offset: 1,
    });
    expect(page.items.map((event) => `${event.seq}:${event.content}`)).toEqual(['2:真实终端事件 2']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('restores archived runtime sessions and filters by project and task binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zeus-runtime-restore-'));
  const dbPath = join(dir, 'zeus.db');
  try {
    const db = await createZeusDatabase(dbPath);
    const repository = new RuntimeSessionRepository(db);
    const first = repository.create({
      id: 'session-bound-1',
      projectId: 'project-1',
      taskId: 'task-1',
      command: 'codex',
      args: ['--version'],
      cwd: '/Users/david/hypha/zeus',
      status: 'exited',
      startedAt: '2026-06-13T00:00:00.000Z',
    });
    repository.create({
      id: 'session-bound-2',
      projectId: 'project-2',
      taskId: 'task-2',
      command: 'codex',
      args: ['--help'],
      cwd: '/Users/david/hypha/zeus',
      status: 'exited',
      startedAt: '2026-06-13T00:01:00.000Z',
    });

    repository.archive(first.id);
    expect(repository.list({ archived: true, projectId: 'project-1' }).map((item) => item.id)).toEqual([first.id]);

    const restored = repository.restore(first.id);

    expect(restored.archived).toBe(false);
    expect(repository.list({ projectId: 'project-1', taskId: 'task-1' }).map((item) => item.id)).toEqual([first.id]);
    expect(repository.list({ projectId: 'project-2', taskId: 'task-2' }).map((item) => item.id)).toEqual(['session-bound-2']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
