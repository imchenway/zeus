import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App.js';
import type { DashboardSnapshot, TaskRecord } from '../src/renderer/apiClient.js';

function createSnapshot(tasks: TaskRecord[]): DashboardSnapshot {
  return {
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
    tasks,
    runtime: {
      aiCli: { available: false, reason: '未检测到可用 AI CLI。' },
      telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
    },
    git: { isRepository: true, branch: 'main', changedFiles: [] },
    graph: { nodeCount: 0, edgeCount: 0, viewCount: 0 },
  };
}

describe('Zeus App task controls rendering', () => {
  it('renders primary controls for a ready task in the conversation workspace', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_real',
            projectId: 'project_real',
            title: '分析当前项目结构',
            status: 'ready',
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );

    expect(html).toContain('workspace-view-conversations');
    expect(html).toContain('推送到 CLI 对话');
    expect(html).toContain('标记完成');
    expect(html).toContain('取消任务');
    expect(html).toContain('要求后续变更');
    expect(html).not.toContain('任务详情');
  });

  it('renders lifecycle controls according to the current selected task state', () => {
    const runningHtml = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_running',
            projectId: 'project_real',
            title: '运行中真实任务',
            status: 'running',
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );
    const pausedHtml = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_paused',
            projectId: 'project_real',
            title: '暂停真实任务',
            status: 'paused',
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );

    expect(runningHtml).toContain('暂停 Runtime');
    expect(runningHtml).toContain('标记完成');
    expect(pausedHtml).toContain('继续 Runtime');
    expect(pausedHtml).toContain('标记完成');
  });

  it('renders archived task recovery in the left archive group without adding fake records', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([])}
        initialMainNavTarget="tasks"
        initialArchivedTasks={[
          {
            id: 'task_archived',
            projectId: 'project_real',
            title: '已归档真实任务',
            status: 'ready',
          },
        ]}
      />,
    );

    expect(html).toContain('归档任务');
    expect(html).toContain('已归档真实任务');
    expect(html).toContain('恢复任务');
    expect(html).not.toContain('归档任务为空');
  });

  it('keeps task list search shallow and moves secondary data into drawers', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_backend',
            projectId: 'project_real',
            title: '修复 API Bug',
            status: 'ready',
            tags: ['backend', 'bug'],
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );

    expect(html).toContain('搜索任务');
    expect(html).toContain('修复 API Bug');
    expect(html).toContain('运行环境');
    expect(html).toContain('上下文');
    expect(html).toContain('代码变更');
    expect(html).toContain('模板');
    expect(html).not.toContain('筛选状态');
    expect(html).not.toContain('任务详情');
  });

  it('uses the composer as the shallow edit path for the selected task', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_real',
            projectId: 'project_real',
            title: '分析当前项目结构',
            description: '真实任务',
            status: 'ready',
            tags: ['analysis'],
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );

    expect(html).toContain('分析当前项目结构');
    expect(html).toContain('真实任务');
    expect(html).toContain('要求后续变更');
    expect(html).toContain('发送');
    expect(html).not.toContain('任务标题');
    expect(html).not.toContain('确认删除任务');
  });
});
