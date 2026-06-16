import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startZeusLocalServer } from '../src/index.js';

describe('Task template API', () => {
  it('returns built-in prompt templates without creating fake tasks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-template-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'templates-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const templatesResponse = await fetch(`${running.baseUrl}/api/task-templates`, { headers: { authorization: 'Bearer templates-token' } });
      expect(templatesResponse.status).toBe(200);
      const templates = await templatesResponse.json();
      expect(templates.map((template: { name: string }) => template.name)).toContain('Bug 修复');
      expect(templates.every((template: { builtIn: boolean }) => template.builtIn)).toBe(true);

      const dashboard = await (
        await fetch(`${running.baseUrl}/api/dashboard`, {
          headers: { authorization: 'Bearer templates-token' },
        })
      ).json();
      expect(dashboard.tasks).toHaveLength(0);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates custom templates, sets project default template, and creates a task from a template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-template-create-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'templates-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const project = await (
        await fetch(`${running.baseUrl}/api/projects`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer templates-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Zeus',
            localPath: '/Users/david/hypha/zeus',
          }),
        })
      ).json();

      const templateResponse = await fetch(`${running.baseUrl}/api/task-templates`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer templates-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          name: 'Zeus 专项重构',
          description: '真实项目级 prompt 模板',
          promptTemplate: '请在 {{project_path}} 完成 {{goal}}',
          category: 'custom',
          defaultOptions: { allowTests: true },
        }),
      });
      expect(templateResponse.status).toBe(201);
      const template = await templateResponse.json();
      expect(template.builtIn).toBe(false);

      const defaultResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/default-template`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer templates-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ templateId: template.id }),
      });
      expect(defaultResponse.status).toBe(200);
      expect((await defaultResponse.json()).defaultTemplateId).toBe(template.id);

      const templateTaskResponse = await fetch(`${running.baseUrl}/api/task-templates/${template.id}/tasks`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer templates-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId: project.id,
          title: 'Zeus 专项重构',
          variables: {
            project_path: '/Users/david/hypha/zeus',
            goal: '整理任务模板闭环',
          },
        }),
      });
      expect(templateTaskResponse.status).toBe(201);
      const task = await templateTaskResponse.json();
      expect(task.templateId).toBe(template.id);
      expect(task.description).toContain('整理任务模板闭环');

      const events = await (
        await fetch(`${running.baseUrl}/api/tasks/${task.id}/events`, {
          headers: { authorization: 'Bearer templates-token' },
        })
      ).json();
      expect(events.map((event: { title: string }) => event.title)).toContain('任务从模板创建');
      const templates = await (await fetch(`${running.baseUrl}/api/task-templates?projectId=${project.id}`, { headers: { authorization: 'Bearer templates-token' } })).json();
      expect(templates.map((item: { id: string }) => item.id)).toContain(template.id);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
