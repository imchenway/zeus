import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalServer } from '../src/index';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'zeus-graph-task-writeback-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('graph task writeback', () => {
  it('writes completed graph-node task summary back to the real graph node metadata', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const project = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Zeus', localPath: '/Users/david/hypha/zeus' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });
    const view = await server.inject({
      method: 'GET',
      url: '/api/graph/views/architecture',
      headers: { authorization: 'Bearer token' },
    });
    const node = view.json().nodes[0];
    const created = await server.inject({
      method: 'POST',
      url: `/api/graph/nodes/${node.id}/tasks`,
      headers: { authorization: 'Bearer token' },
      payload: { projectId: project.json().id, intent: '分析该节点的实现风险' },
    });
    const task = created.json();
    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/status`,
      headers: { authorization: 'Bearer token' },
      payload: { status: 'running' },
    });

    await server.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/status`,
      headers: { authorization: 'Bearer token' },
      payload: { status: 'completed' },
    });

    const updatedView = await server.inject({
      method: 'GET',
      url: '/api/graph/views/architecture',
      headers: { authorization: 'Bearer token' },
    });
    const updatedNode = updatedView.json().nodes.find((item: { id: string }) => item.id === node.id);
    expect(updatedNode.metadata.recentTasks).toEqual([
      expect.objectContaining({
        taskId: task.id,
        title: task.title,
        status: 'completed',
      }),
    ]);
    expect(updatedNode.metadata.riskTags).toEqual(expect.arrayContaining(['task_completed']));
    const events = await server.inject({
      method: 'GET',
      url: `/api/tasks/${task.id}/events`,
      headers: { authorization: 'Bearer token' },
    });
    expect(events.json().map((event: { eventType: string }) => event.eventType)).toContain('graph.node.writeback');
    await server.close();
  });
});
