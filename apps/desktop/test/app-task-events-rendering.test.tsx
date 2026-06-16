import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App.js';
import type { DashboardSnapshot, TaskEventRecord } from '../src/renderer/apiClient.js';

describe('Zeus App task timeline rendering', () => {
  it('renders task events inside the current conversation instead of a standalone timeline page', () => {
    const snapshot: DashboardSnapshot = {
      app: 'Zeus',
      localServer: { host: '127.0.0.1', port: 49152 },
      projects: [
        {
          id: 'project_real',
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
          scanStatus: 'not_scanned',
        },
      ],
      tasks: [
        {
          id: 'task_real',
          projectId: 'project_real',
          title: '分析当前项目结构',
          status: 'ready',
        },
      ],
      runtime: {
        aiCli: { available: false, reason: '未检测到可用 AI CLI。' },
        telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
      },
      git: { isRepository: true, branch: 'main', changedFiles: [] },
      graph: { nodeCount: 0, edgeCount: 0, viewCount: 0 },
    };
    const taskEvents: TaskEventRecord[] = [
      {
        id: 'event_1',
        taskId: 'task_real',
        eventType: 'task.created',
        title: '任务已创建',
        payloadJson: '{}',
        createdAt: '2026-06-13T00:00:00.000Z',
      },
    ];
    const html = renderToStaticMarkup(<App snapshot={snapshot} initialTaskEvents={taskEvents} />);

    expect(html).toContain('workspace-view-conversations');
    expect(html).toContain('任务事件');
    expect(html).toContain('任务已创建');
    expect(html).not.toContain('任务时间线');
  });
});
