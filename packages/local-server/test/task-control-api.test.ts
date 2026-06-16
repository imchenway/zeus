import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AiRuntimeProcessHandle, AiRuntimeSpawn } from '@zeus/ai-runtime';
import { AuditLogRepository, createZeusDatabase } from '@zeus/storage';
import { startZeusLocalServer } from '../src/index.js';

function createImmediateRuntimeSpawn(invocations: Array<{ command: string; args: string[] }>): AiRuntimeSpawn {
  return (command, args) => {
    invocations.push({ command, args });
    const callbacks = new Map<string, Array<(value: unknown) => void>>();
    const handle: AiRuntimeProcessHandle = {
      pid: 717,
      on(event, callback) {
        const entries = callbacks.get(event) ?? [];
        entries.push(callback as (value: unknown) => void);
        callbacks.set(event, entries);
        return handle;
      },
      kill() {
        callbacks.get('exit')?.forEach((callback) => callback(143));
      },
    };
    queueMicrotask(() => {
      callbacks.get('stdout')?.forEach((callback) => callback('真实任务 Runtime 输出'));
      callbacks.get('exit')?.forEach((callback) => callback(0));
    });
    return handle;
  };
}

describe('Task control API', () => {
  it('transitions task status and records timeline events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-control-'));
    try {
      const dbPath = join(dir, 'zeus.db');
      const running = await startZeusLocalServer({
        dbPath,
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '真实任务',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();
      const runningTask = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/status`, {
          method: 'PATCH',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ status: 'running' }),
        })
      ).json();
      expect(runningTask.status).toBe('running');
      const pausedTask = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/status`, {
          method: 'PATCH',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ status: 'paused' }),
        })
      ).json();
      expect(pausedTask.status).toBe('paused');
      const events = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/events`, {
          headers: { authorization: 'Bearer control-token' },
        })
      ).json();
      expect(events.map((event: { eventType: string }) => event.eventType)).toContain('task.status.changed');
      await running.close();
      const auditLogs = new AuditLogRepository(await createZeusDatabase(dbPath)).listRecent();
      const statusAuditPayloads = auditLogs.filter((entry) => entry.action === 'task.status.changed').map((entry) => JSON.parse(entry.payloadJson));
      expect(statusAuditPayloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: 'ready',
            to: 'running',
            taskId: task.id,
          }),
          expect.objectContaining({
            from: 'running',
            to: 'paused',
            taskId: task.id,
          }),
        ]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid status transitions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-control-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '真实任务',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();
      await fetch(`${running.baseUrl}/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'running' }),
      });
      await fetch(`${running.baseUrl}/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'completed' }),
      });
      const invalid = await fetch(`${running.baseUrl}/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'running' }),
      });
      expect(invalid.status).toBe(409);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs, pauses, continues, cancels, and retries a task through dedicated Runtime control endpoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-runtime-control-'));
    const invocations: Array<{ command: string; args: string[] }> = [];
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
        aiRuntimeSpawn: createImmediateRuntimeSpawn(invocations),
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '执行真实任务',
            description: '通过 dedicated API 启动 Runtime',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();

      const runResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/run`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const runBody = await runResponse.json();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const pauseResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/pause`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const continueResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/continue`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const cancelResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/cancel`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const retryResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/retry`, { method: 'POST', headers: { authorization: 'Bearer control-token' } });
      const sessions = await (await fetch(`${running.baseUrl}/api/runtime/sessions?taskId=${task.id}`, { headers: { authorization: 'Bearer control-token' } })).json();
      const events = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/events`, {
          headers: { authorization: 'Bearer control-token' },
        })
      ).json();

      expect(runResponse.status).toBe(201);
      expect(runBody.task.status).toBe('running');
      expect(runBody.runtimeSession.id).toMatch(/^ai-session-/);
      expect(pauseResponse.status).toBe(200);
      expect((await pauseResponse.json()).status).toBe('paused');
      expect(continueResponse.status).toBe(201);
      expect((await continueResponse.json()).task.status).toBe('running');
      expect(cancelResponse.status).toBe(200);
      expect((await cancelResponse.json()).status).toBe('cancelled');
      expect(retryResponse.status).toBe(200);
      expect((await retryResponse.json()).status).toBe('ready');
      expect(invocations[0]).toMatchObject({ command: 'codex' });
      expect(invocations[0].args.join('\n')).toContain('执行真实任务');
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(events.map((event: { eventType: string }) => event.eventType)).toContain('task.runtime.run');
      expect(events.map((event: { eventType: string }) => event.eventType)).toContain('task.runtime.continue');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('archives a task and hides it from dashboard active tasks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-archive-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '真实任务',
            sourceContext: { path: project.localPath },
          }),
        })
      ).json();

      const archiveResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/archive`, {
        method: 'POST',
        headers: { authorization: 'Bearer control-token' },
      });
      expect(archiveResponse.status).toBe(200);
      expect((await archiveResponse.json()).id).toBe(task.id);

      const dashboard = await (
        await fetch(`${running.baseUrl}/api/dashboard`, {
          headers: { authorization: 'Bearer control-token' },
        })
      ).json();
      expect(dashboard.tasks).toHaveLength(0);
      const archivedTasks = await (await fetch(`${running.baseUrl}/api/tasks/archived?projectId=${project.id}`, { headers: { authorization: 'Bearer control-token' } })).json();
      expect(archivedTasks.map((item: { id: string }) => item.id)).toEqual([task.id]);

      const restoreResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/restore`, {
        method: 'POST',
        headers: { authorization: 'Bearer control-token' },
      });
      expect(restoreResponse.status).toBe(200);
      expect((await restoreResponse.json()).id).toBe(task.id);
      const restoredDashboard = await (
        await fetch(`${running.baseUrl}/api/dashboard`, {
          headers: { authorization: 'Bearer control-token' },
        })
      ).json();
      expect(restoredDashboard.tasks).toHaveLength(1);
      const restoredArchivedTasks = await (await fetch(`${running.baseUrl}/api/tasks/archived?projectId=${project.id}`, { headers: { authorization: 'Bearer control-token' } })).json();
      expect(restoredArchivedTasks).toEqual([]);
      const events = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/events`, {
          headers: { authorization: 'Bearer control-token' },
        })
      ).json();
      expect(events.map((event: { title: string }) => event.title)).toContain('任务已归档');
      expect(events.map((event: { title: string }) => event.title)).toContain('任务已恢复');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists tasks with query, status, tag, and sort filters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-search-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      await fetch(`${running.baseUrl}/api/tasks`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          title: '修复 API Bug',
          description: '真实后端缺陷',
          sourceContext: { path: project.localPath },
          tags: ['backend', 'bug'],
        }),
      });
      const uiTask = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '优化任务 UI',
            description: '真实前端任务',
            sourceContext: { path: project.localPath },
            tags: ['frontend'],
          }),
        })
      ).json();
      await fetch(`${running.baseUrl}/api/tasks/${uiTask.id}/status`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 'running' }),
      });

      const response = await fetch(`${running.baseUrl}/api/tasks?projectId=${project.id}&query=Bug&status=ready&tag=backend&sortBy=title&sortDirection=asc`, { headers: { authorization: 'Bearer control-token' } });

      expect(response.status).toBe(200);
      const filtered = await response.json();
      expect(filtered.map((task: { title: string }) => task.title)).toEqual(['修复 API Bug']);
      expect(filtered[0].tags).toEqual(['backend', 'bug']);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads, edits, retags, and soft deletes a task through APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-detail-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'control-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();
      const task = await (
        await fetch(`${running.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer control-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: project.id,
            title: '分析当前项目结构',
            description: '真实任务',
            sourceContext: { path: project.localPath },
            tags: ['analysis'],
          }),
        })
      ).json();

      const detailResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}`, { headers: { authorization: 'Bearer control-token' } });
      const updateResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: '分析 Zeus 项目结构',
          description: '更新后的真实任务',
        }),
      });
      const tagResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}/tags`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer control-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tags: ['analysis', 'backend'] }),
      });
      const deleteResponse = await fetch(`${running.baseUrl}/api/tasks/${task.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer control-token' },
      });
      const tasksResponse = await fetch(`${running.baseUrl}/api/tasks?projectId=${project.id}`, { headers: { authorization: 'Bearer control-token' } });

      expect(detailResponse.status).toBe(200);
      expect((await updateResponse.json()).title).toBe('分析 Zeus 项目结构');
      expect((await tagResponse.json()).tags).toEqual(['analysis', 'backend']);
      expect(deleteResponse.status).toBe(200);
      expect(await tasksResponse.json()).toEqual([]);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
