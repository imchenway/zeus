import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createZeusDatabase, ProjectRepository, TaskEventRepository, TaskRepository } from '../src/index.js';

describe('Task event repository', () => {
  it('creates and lists real task timeline events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-events-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const project = new ProjectRepository(db).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const task = new TaskRepository(db).create({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '真实任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
      });
      const events = new TaskEventRepository(db);
      events.create({
        taskId: task.id,
        eventType: 'task.created',
        title: '任务已创建',
        payload: { status: task.status },
      });
      expect(events.listByTask(task.id).map((event) => event.title)).toEqual(['任务已创建']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
