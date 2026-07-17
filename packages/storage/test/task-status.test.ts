import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createZeusDatabase, ProjectRepository, TaskRepository } from '../src/index.js';

describe('Task status persistence', () => {
  it('updates a task status and preserves updatedAt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-status-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const project = new ProjectRepository(db).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const tasks = new TaskRepository(db);
      const task = tasks.create({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '真实任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
      });
      const updated = tasks.updateStatus(task.id, 'running');
      expect(updated.status).toBe('running');
      expect(tasks.getById(task.id)?.status).toBe('running');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('archives a task without deleting its timeline source record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-archive-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const project = new ProjectRepository(db).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const tasks = new TaskRepository(db);
      const task = tasks.create({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '真实任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
      });

      const archived = tasks.archive(task.id);

      expect(archived.id).toBe(task.id);
      expect(tasks.listByProject(project.id).map((item) => item.id)).toEqual([]);
      expect(tasks.listArchivedByProject(project.id).map((item) => item.id)).toEqual([task.id]);
      expect(tasks.getById(task.id)?.id).toBe(task.id);

      const restored = tasks.restore(task.id);

      expect(restored.id).toBe(task.id);
      expect(tasks.listByProject(project.id).map((item) => item.id)).toEqual([task.id]);
      expect(tasks.listArchivedByProject(project.id)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('searches, filters, sorts, and preserves task tags without fake records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-search-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const project = new ProjectRepository(db).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const tasks = new TaskRepository(db);
      tasks.create({
        projectId: project.id,
        title: '修复 API Bug',
        description: '真实后端缺陷',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
        tags: ['backend', 'bug'],
      });
      const uiTask = tasks.create({
        projectId: project.id,
        title: '优化任务 UI',
        description: '真实前端任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
        tags: ['frontend'],
      });
      tasks.updateStatus(uiTask.id, 'running');

      const filtered = tasks.listByProject(project.id, {
        query: 'Bug',
        status: 'ready',
        tag: 'backend',
        sortBy: 'title',
        sortDirection: 'asc',
      });

      expect(filtered.map((task) => task.title)).toEqual(['修复 API Bug']);
      expect(filtered[0]?.tags).toEqual(['backend', 'bug']);
      expect(tasks.listByProject(project.id, { status: 'running' }).map((task) => task.title)).toEqual(['优化任务 UI']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates task detail, edits tags, and soft deletes without losing source context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-detail-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const project = new ProjectRepository(db).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const tasks = new TaskRepository(db);
      const task = tasks.create({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '真实任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
        tags: ['analysis'],
      });

      const updated = tasks.update(task.id, {
        title: '分析 Zeus 项目结构',
        description: '更新后的真实任务',
      });
      const tagged = tasks.updateTags(task.id, ['analysis', 'backend']);
      const deleted = tasks.delete(task.id);

      expect(updated.title).toBe('分析 Zeus 项目结构');
      expect(tagged.tags).toEqual(['analysis', 'backend']);
      expect(JSON.parse(tagged.sourceContextJson)).toEqual({
        path: project.localPath,
      });
      expect(deleted.id).toBe(task.id);
      expect(tasks.getById(task.id)).toBeUndefined();
      expect(tasks.listByProject(project.id)).toEqual([]);
      expect(db.countRows('tasks')).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('generates stable readable task codes per project without exposing raw ids as identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-code-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const projects = new ProjectRepository(db);
      const zeus = projects.create({ name: 'Zeus', localPath: '/Users/david/hypha/zeus' });
      const giraffe = projects.create({ name: 'Giraffe', localPath: '/Users/david/hypha/giraffe' });
      const tasks = new TaskRepository(db);

      const first = tasks.create({
        projectId: zeus.id,
        title: '分析任务字段',
        description: '真实任务',
        createdFrom: 'user',
        sourceContext: { path: zeus.localPath },
      });
      const second = tasks.create({
        projectId: zeus.id,
        title: '启动 AI Runtime',
        description: '真实任务',
        createdFrom: 'runtime_session',
        sourceContext: { sessionId: 'session_real' },
      });
      const otherProject = tasks.create({
        projectId: giraffe.id,
        title: '分析 Giraffe 任务页',
        description: '真实任务',
        createdFrom: 'graph_node',
        sourceContext: { nodeId: 'node_real' },
      });

      expect(first.taskCode).toBe('ZEU-000001');
      expect(first.taskSequence).toBe(1);
      expect(second.taskCode).toBe('ZEU-000002');
      expect(second.taskSequence).toBe(2);
      expect(otherProject.taskCode).toBe('ZEU-000001');
      expect(otherProject.taskSequence).toBe(1);
      expect(first.taskCode).not.toContain('task_');
      expect(tasks.getById(first.id)?.taskCode).toBe('ZEU-000001');
      const tasksById = new Map(tasks.listByProject(zeus.id).map((task) => [task.id, task]));
      expect(tasksById.get(first.id)?.taskCode).toBe('ZEU-000001');
      expect(tasksById.get(second.id)?.taskCode).toBe('ZEU-000002');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backfills existing task rows missing codes idempotently for local databases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-code-backfill-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const firstDb = await createZeusDatabase(dbPath);
      const project = new ProjectRepository(firstDb).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const firstRepo = new TaskRepository(firstDb);
      const first = firstRepo.create({
        projectId: project.id,
        title: '旧任务一',
        description: '旧库真实任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
      });
      const second = firstRepo.create({
        projectId: project.id,
        title: '旧任务二',
        description: '旧库真实任务',
        createdFrom: 'template',
        sourceContext: { templateId: 'task_template_real' },
      });
      firstDb.execute(
        `UPDATE tasks
         SET created_at = CASE id WHEN ? THEN ? WHEN ? THEN ? ELSE created_at END,
             updated_at = CASE id WHEN ? THEN ? WHEN ? THEN ? ELSE updated_at END
         WHERE id IN (?, ?)`,
        [first.id, '2026-06-25T00:00:01.000Z', second.id, '2026-06-25T00:00:02.000Z', first.id, '2026-06-25T00:00:01.000Z', second.id, '2026-06-25T00:00:02.000Z', first.id, second.id],
      );
      firstDb.execute('UPDATE tasks SET task_code = NULL, task_sequence = NULL WHERE project_id = ?', [project.id]);
      await firstDb.save();

      const reopened = await createZeusDatabase(dbPath);
      const reopenedTasks = new TaskRepository(reopened).listByProject(project.id, { sortBy: 'createdAt', sortDirection: 'asc' });
      const reopenedById = new Map(reopenedTasks.map((task) => [task.id, task]));
      expect(reopenedById.get(first.id)?.taskCode).toBe('ZEU-000001');
      expect(reopenedById.get(first.id)?.taskSequence).toBe(1);
      expect(reopenedById.get(second.id)?.taskCode).toBe('ZEU-000002');
      expect(reopenedById.get(second.id)?.taskSequence).toBe(2);
      await reopened.save();

      const reopenedAgain = await createZeusDatabase(dbPath);
      const stable = new TaskRepository(reopenedAgain).listByProject(project.id, { sortBy: 'createdAt', sortDirection: 'asc' });
      const stableById = new Map(stable.map((task) => [task.id, task]));
      expect(stableById.get(first.id)?.taskCode).toBe('ZEU-000001');
      expect(stableById.get(first.id)?.taskSequence).toBe(1);
      expect(stableById.get(second.id)?.taskCode).toBe('ZEU-000002');
      expect(stableById.get(second.id)?.taskSequence).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backfills noncanonical task codes to the canonical six digit Zeus format', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-code-normalize-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const firstDb = await createZeusDatabase(dbPath);
      const project = new ProjectRepository(firstDb).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const firstRepo = new TaskRepository(firstDb);
      const task = firstRepo.create({
        projectId: project.id,
        title: '旧任务编码格式不规范',
        description: '旧库真实任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
      });
      firstDb.execute('UPDATE tasks SET task_code = ?, task_sequence = ? WHERE id = ?', ['ZEU-1', 1, task.id]);
      await firstDb.save();

      const reopened = await createZeusDatabase(dbPath);
      const normalized = new TaskRepository(reopened).getById(task.id);

      expect(normalized?.taskCode).toBe('ZEU-000001');
      expect(normalized?.taskSequence).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backfills duplicated canonical task codes from the final project sequence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-code-duplicate-backfill-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const firstDb = await createZeusDatabase(dbPath);
      const project = new ProjectRepository(firstDb).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const firstRepo = new TaskRepository(firstDb);
      const first = firstRepo.create({
        projectId: project.id,
        title: '旧任务编码重复一',
        description: '旧库真实任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
      });
      const second = firstRepo.create({
        projectId: project.id,
        title: '旧任务编码重复二',
        description: '旧库真实任务',
        createdFrom: 'template',
        sourceContext: { templateId: 'task_template_real' },
      });
      firstDb.execute(
        `UPDATE tasks
         SET task_code = ?, task_sequence = NULL,
             created_at = CASE id WHEN ? THEN ? WHEN ? THEN ? ELSE created_at END,
             updated_at = CASE id WHEN ? THEN ? WHEN ? THEN ? ELSE updated_at END
         WHERE id IN (?, ?)`,
        ['ZEU-000999', first.id, '2026-06-25T00:00:01.000Z', second.id, '2026-06-25T00:00:02.000Z', first.id, '2026-06-25T00:00:01.000Z', second.id, '2026-06-25T00:00:02.000Z', first.id, second.id],
      );
      await firstDb.save();

      const reopened = await createZeusDatabase(dbPath);
      const reopenedTasks = new TaskRepository(reopened).listByProject(project.id, { sortBy: 'createdAt', sortDirection: 'asc' });

      expect(reopenedTasks.map((task) => [task.id, task.taskCode, task.taskSequence])).toEqual([
        [first.id, 'ZEU-000001', 1],
        [second.id, 'ZEU-000002', 2],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backfills duplicated task sequences by keeping the first valid sequence and assigning the next free one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-sequence-duplicate-backfill-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const firstDb = await createZeusDatabase(dbPath);
      const project = new ProjectRepository(firstDb).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const firstRepo = new TaskRepository(firstDb);
      const first = firstRepo.create({
        projectId: project.id,
        title: '旧任务序号重复一',
        description: '旧库真实任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
      });
      const second = firstRepo.create({
        projectId: project.id,
        title: '旧任务序号重复二',
        description: '旧库真实任务',
        createdFrom: 'template',
        sourceContext: { templateId: 'task_template_real' },
      });
      firstDb.execute(
        `UPDATE tasks
         SET task_code = ?, task_sequence = ?,
             created_at = CASE id WHEN ? THEN ? WHEN ? THEN ? ELSE created_at END,
             updated_at = CASE id WHEN ? THEN ? WHEN ? THEN ? ELSE updated_at END
         WHERE id IN (?, ?)`,
        ['ZEU-000999', 999, first.id, '2026-06-25T00:00:01.000Z', second.id, '2026-06-25T00:00:02.000Z', first.id, '2026-06-25T00:00:01.000Z', second.id, '2026-06-25T00:00:02.000Z', first.id, second.id],
      );
      await firstDb.save();

      const reopened = await createZeusDatabase(dbPath);
      const reopenedTasks = new TaskRepository(reopened).listByProject(project.id, { sortBy: 'createdAt', sortDirection: 'asc' });

      expect(reopenedTasks.map((task) => [task.id, task.taskCode, task.taskSequence])).toEqual([
        [first.id, 'ZEU-000999', 999],
        [second.id, 'ZEU-001000', 1000],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backfills missing middle task sequence without stealing a later valid sequence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-sequence-gap-backfill-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const firstDb = await createZeusDatabase(dbPath);
      const project = new ProjectRepository(firstDb).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const firstRepo = new TaskRepository(firstDb);
      const first = firstRepo.create({
        projectId: project.id,
        title: '旧任务序号一',
        description: '旧库真实任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
      });
      const middle = firstRepo.create({
        projectId: project.id,
        title: '旧任务缺序号',
        description: '旧库真实任务',
        createdFrom: 'template',
        sourceContext: { templateId: 'task_template_real' },
      });
      const third = firstRepo.create({
        projectId: project.id,
        title: '旧任务序号二',
        description: '旧库真实任务',
        createdFrom: 'graph_node',
        sourceContext: { nodeId: 'node_real' },
      });
      firstDb.execute(
        `UPDATE tasks
         SET task_sequence = CASE id WHEN ? THEN 1 WHEN ? THEN NULL WHEN ? THEN 2 ELSE task_sequence END,
             task_code = CASE id WHEN ? THEN 'ZEU-000001' WHEN ? THEN NULL WHEN ? THEN 'ZEU-000002' ELSE task_code END,
             created_at = CASE id WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? ELSE created_at END,
             updated_at = CASE id WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? ELSE updated_at END
         WHERE id IN (?, ?, ?)`,
        [
          first.id,
          middle.id,
          third.id,
          first.id,
          middle.id,
          third.id,
          first.id,
          '2026-06-25T00:00:01.000Z',
          middle.id,
          '2026-06-25T00:00:02.000Z',
          third.id,
          '2026-06-25T00:00:03.000Z',
          first.id,
          '2026-06-25T00:00:01.000Z',
          middle.id,
          '2026-06-25T00:00:02.000Z',
          third.id,
          '2026-06-25T00:00:03.000Z',
          first.id,
          middle.id,
          third.id,
        ],
      );
      await firstDb.save();

      const reopened = await createZeusDatabase(dbPath);
      const byId = new Map(new TaskRepository(reopened).listByProject(project.id, { sortBy: 'createdAt', sortDirection: 'asc' }).map((task) => [task.id, task]));

      expect(byId.get(first.id)?.taskSequence).toBe(1);
      expect(byId.get(first.id)?.taskCode).toBe('ZEU-000001');
      expect(byId.get(middle.id)?.taskSequence).toBe(3);
      expect(byId.get(middle.id)?.taskCode).toBe('ZEU-000003');
      expect(byId.get(third.id)?.taskSequence).toBe(2);
      expect(byId.get(third.id)?.taskCode).toBe('ZEU-000002');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
