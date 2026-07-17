import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App.js';
import type { DashboardSnapshot, TaskEventRecord, TaskRecord, TaskStatus } from '../src/renderer/apiClient.js';
import { TaskDetailDrawerContent, type TaskDetailDrawerCopy } from '../src/renderer/task/TaskDetailDrawerContent.js';

const taskStatusLabels: Record<TaskStatus | '', string> = {
  '': '全部',
  draft: '草稿',
  ready: '待开始',
  running: '运行中',
  paused: '已暂停',
  waiting_confirmation: '等待确认',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已取消',
};

function createTaskDetailCopy(language: 'zh-CN' | 'en-US'): TaskDetailDrawerCopy {
  const english = language === 'en-US';
  return {
    requestTitle: english ? 'Task request' : '任务要求',
    noRequest: english ? 'No task request yet' : '暂无任务要求',
    eventsTitle: english ? 'Task events' : '任务事件',
    noEvents: english ? 'No events yet' : '暂无任务事件',
    runTask: english ? 'Push to model' : '推送到模型',
    pauseRuntime: english ? 'Pause Runtime' : '暂停 Runtime',
    continueRuntime: english ? 'Continue Runtime' : '继续 Runtime',
    retryTask: english ? 'Retry task' : '重试任务',
    markComplete: english ? 'Mark complete' : '标记完成',
    cancelTask: english ? 'Cancel task' : '取消任务',
    primaryActionsTitle: english ? 'Primary actions' : '主操作',
    secondaryActionsTitle: english ? 'Secondary actions' : '次操作',
    dangerActionsTitle: english ? 'Dangerous actions' : '危险操作',
    metadataTitle: english ? 'AI facts' : 'AI 事实',
    projectLabel: english ? 'Project' : '项目',
    templateLabel: english ? 'Template' : '模板',
    aiCliLabel: 'AI CLI',
    aiDetected: english ? 'Available' : '已检测',
    aiNotConfigured: english ? 'Not configured' : '未配置',
    updatedAtMissing: english ? 'Not recorded' : '未记录',
    nextActionLabels: english
      ? {
          draft: 'Can start AI',
          ready: 'Can start AI',
          running: 'Waiting for AI output',
          paused: 'Can continue',
          waiting_confirmation: 'Needs confirmation',
          completed: 'Completed',
          failed: 'Can retry',
          cancelled: 'Cancelled',
        }
      : undefined,
    cancelConfirm: english ? 'Cancel this task?' : '确认取消任务？',
  };
}

function taskEventTypeLabels(language: 'zh-CN' | 'en-US'): Record<string, string> {
  return language === 'en-US'
    ? {
        'task.created': 'Task created',
        'task.status.changed': 'Task status changed',
        'task.runtime.run': 'Task runtime run',
        'telegram.notification.sent': 'Telegram notification sent',
      }
    : {
        'task.created': '任务创建',
        'task.status.changed': '任务状态变更',
        'task.runtime.run': '任务运行',
        'telegram.notification.sent': 'Telegram 通知已发送',
      };
}

function renderTaskDetail(task: TaskRecord, events: TaskEventRecord[], language: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  return renderToStaticMarkup(
    <TaskDetailDrawerContent
      task={task}
      events={events}
      copy={createTaskDetailCopy(language)}
      statusLabels={language === 'en-US' ? { ...taskStatusLabels, ready: 'Ready', running: 'Running' } : taskStatusLabels}
      eventTypeLabels={taskEventTypeLabels(language)}
      runtimeAiAvailable={true}
      busy={false}
      onRuntimeAction={() => undefined}
      onMarkComplete={() => undefined}
      controlBusyProps={() => ({})}
    />,
  );
}

describe('Zeus App task event rendering', () => {
  it('keeps task events in task details instead of injecting them into the native session transcript', () => {
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
    const sessionHtml = renderToStaticMarkup(<App snapshot={snapshot} initialTaskEvents={taskEvents} />);
    const detailHtml = renderTaskDetail(snapshot.tasks[0]!, taskEvents);

    expect(sessionHtml).toContain('workspace-view-project-sessions');
    expect(sessionHtml).toContain('session-workspace-root');
    expect(sessionHtml).not.toContain('任务事件');
    expect(sessionHtml).not.toContain('任务已创建');
    expect(detailHtml).toContain('task-detail-events');
    expect(detailHtml).toContain('任务事件');
    expect(detailHtml).toContain('任务已创建');
    expect(detailHtml).not.toContain('任务时间线');
  });

  it('localizes task event type metadata in task details while the task page keeps events collapsed', () => {
    const snapshot: DashboardSnapshot = {
      app: 'Zeus',
      localServer: { host: '127.0.0.1', port: 49152 },
      projects: [
        {
          id: 'project_real',
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
          scanStatus: 'completed',
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
        id: 'event_status',
        taskId: 'task_real',
        eventType: 'task.status.changed',
        title: '任务状态已更新',
        payloadJson: '{}',
        createdAt: '2026-06-13T00:00:00.000Z',
      },
      {
        id: 'event_telegram',
        taskId: 'task_real',
        eventType: 'telegram.notification.sent',
        title: 'Telegram 通知已发送',
        payloadJson: '{}',
        createdAt: '2026-06-13T00:01:00.000Z',
      },
    ];

    const zhTaskHtml = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="tasks" initialTaskEvents={taskEvents} />);
    const enDetailHtml = renderTaskDetail(snapshot.tasks[0]!, taskEvents, 'en-US');

    expect(zhTaskHtml).toContain('task-table-only-layout');
    expect(zhTaskHtml).not.toContain('任务状态变更');
    expect(zhTaskHtml).not.toContain('Telegram 通知已发送');
    expect(zhTaskHtml).not.toContain('task.status.changed');
    expect(zhTaskHtml).not.toContain('telegram.notification.sent');
    expect(enDetailHtml).toContain('Task events');
    expect(enDetailHtml).toContain('Task status changed');
    expect(enDetailHtml).toContain('Telegram notification sent');
    expect(enDetailHtml).not.toContain('task.status.changed');
    expect(enDetailHtml).not.toContain('telegram.notification.sent');
  });

  it('renders task event timestamps as readable local time instead of raw UTC ISO text', () => {
    const snapshot: DashboardSnapshot = {
      app: 'Zeus',
      localServer: { host: '127.0.0.1', port: 49152 },
      projects: [
        {
          id: 'project_real',
          name: 'Zeus',
          localPath: '/Users/david/hypha/zeus',
          scanStatus: 'completed',
        },
      ],
      tasks: [
        {
          id: 'task_real',
          projectId: 'project_real',
          title: '分析当前项目结构',
          status: 'running',
        },
      ],
      runtime: {
        aiCli: { available: true, reason: '已检测到 Codex CLI。' },
        telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
      },
      git: { isRepository: true, branch: 'main', changedFiles: [] },
      graph: { nodeCount: 0, edgeCount: 0, viewCount: 0 },
    };
    const taskEvents: TaskEventRecord[] = [
      {
        id: 'event_runtime_started',
        taskId: 'task_real',
        eventType: 'task.runtime.run',
        title: '任务已通过本地 API 启动 Runtime',
        payloadJson: '{}',
        createdAt: '2026-07-09T05:51:27.347Z',
      },
    ];

    const html = renderTaskDetail(snapshot.tasks[0]!, taskEvents);

    expect(html).toContain('任务已通过本地 API 启动 Runtime');
    expect(html).toMatch(/<time dateTime="2026-07-09T05:51:27\.347Z">2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/time>/);
    expect(html).not.toContain('>2026-07-09T05:51:27.347Z</time>');
  });
});
