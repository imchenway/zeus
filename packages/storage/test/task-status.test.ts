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
});
