import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startZeusLocalServer } from '../src/index.js';

describe('Task events API', () => {
  it('returns task timeline events after creating a real task', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-events-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'events-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const projectResponse = await fetch(`${running.baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer events-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
        }),
      });
      const project = await projectResponse.json();
      const taskResponse = await fetch(`${running.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer events-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          title: '分析当前项目结构',
          description: '真实任务',
          sourceContext: { path: project.localPath },
        }),
      });
      const task = await taskResponse.json();
      const eventsResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/events`, { headers: { authorization: 'Bearer events-token' } });
      expect(eventsResponse.status).toBe(200);
      const events = await eventsResponse.json();
      expect(events.map((event: { title: string }) => event.title)).toContain('任务已创建');
      const taskLog = await readFile(join(dir, 'zeus.db.logs', 'tasks', task.id, 'timeline.normalized.log'), 'utf8');
      expect(taskLog).toContain('task.created');
      expect(taskLog).toContain('任务已创建');
      expect(taskLog).toContain(task.id);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
