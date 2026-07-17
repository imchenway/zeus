import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import {
  App,
  buildTaskCreateInitialForm,
  mergeAppShellSettingsSaveResponse,
  normalizeTaskCreateDraft,
  normalizeTaskRuntimeControlHandlerResult,
  resolveTaskRuntimeActionRoute,
  resolveTaskRuntimeConversationNavigation,
  resolveTaskTableColumnsSaveResponse,
  toAppShellSettingsSavePayload,
} from '../src/renderer/App.js';
import { TaskAttachmentPreviewList, resolveTaskAttachmentPreviewSrc } from '../src/renderer/task/TaskAttachmentPreviewList.js';
import { TaskDetailDrawerContent, type TaskDetailDrawerCopy } from '../src/renderer/task/TaskDetailDrawerContent.js';
import { TaskModelPushModal, readTaskModelPushPreferences, resolveTaskModelPushInitialForm, writeTaskModelPushPreferences } from '../src/renderer/task/TaskModelPushModal.js';
import { TaskWorkspace, type TaskWorkspaceCopy } from '../src/renderer/task/TaskWorkspace.js';
import { normalizeTaskTableColumnPreferences } from '../src/renderer/task/taskWorkspaceModel.js';
import type { AppShellSettings, DashboardSnapshot, GraphConversationHistoryItem, TaskRecord, TaskTableColumnPreferences } from '../src/renderer/apiClient.js';

function completeTaskRecord(task: TaskRecord, index: number): TaskRecord {
  return {
    taskCode: `ZEU-${String(index + 1).padStart(6, '0')}`,
    taskSequence: index + 1,
    priority: 'normal',
    tags: [],
    createdFrom: 'manual',
    sourceContextJson: JSON.stringify({ type: 'manual' }),
    createdAt: `2026-06-25T0${index + 1}:00:00.000Z`,
    updatedAt: `2026-06-25T0${index + 2}:00:00.000Z`,
    ...task,
  };
}

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
    tasks: tasks.map(completeTaskRecord),
    runtime: {
      aiCli: { available: false, reason: '未检测到可用 AI CLI。' },
      telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
    },
    git: { isRepository: true, branch: 'main', changedFiles: [] },
    graph: { nodeCount: 0, edgeCount: 0, viewCount: 0 },
  };
}

function createTaskWorkspaceCopy(): TaskWorkspaceCopy {
  return {
    filterAria: '任务筛选与新建',
    searchAria: '搜索任务',
    searchTitle: '搜索任务',
    statusAria: '任务状态',
    statusSelectAria: '任务状态筛选',
    statusTitle: '状态',
    sortAria: '任务排序',
    sortSelectAria: '任务排序',
    sortTitle: '排序',
    selectSearchPlaceholder: '搜索选项',
    selectNoResults: '没有匹配选项',
    rowMetaTitle: '来源',
    defaultTaskLabel: '默认任务',
    templateTaskLabel: '模板任务',
    tagsAria: '任务标签',
    tagFilterAria: '任务标签筛选',
    tagsTitle: '标签',
    newTask: '新任务',
    today: '今天',
    emptyTitle: '还没有任务',
    emptyHelp: '用“新任务”创建第一条研发任务；创建后会显示状态、AI 执行入口、证据和更新时间。',
    emptySecondaryAction: '查看项目代码',
    emptyOutcomeStatus: '状态会随任务推进更新',
    emptyOutcomeAi: 'AI Runtime 连接后显示执行状态',
    emptyOutcomeEvidence: '运行、来源和事件会形成证据',
    taskListLoadingToolbarStatus: '任务加载中',
    taskListLoadingTitle: '正在读取任务',
    taskListLoadingHelp: '保留当前视图框架',
    taskListLoadingMeta: '等待本机数据',
    taskListErrorToolbarStatus: '任务暂不可用',
    taskListErrorTitle: '无法读取任务列表',
    taskListErrorHelp: '请重试，或在项目设置中确认本机路径权限。错误详情只进入本机日志，不在普通界面暴露堆栈。',
    taskListErrorRetry: '重试',
    taskListErrorProjectSettings: '项目设置',
    noResultsTitle: '没有匹配任务',
    noResultsHelp: '调整筛选条件',
    noResultsPrimaryAction: '清除筛选',
    noResultsSecondaryAction: '查看全部状态',
    noProjectSelected: '未选择项目',
    workbenchAria: '任务管理工作台',
    noTags: '未设置标签',
    aiCliLabel: 'AI CLI',
    aiDetected: '已检测',
    aiNotConfigured: '未配置',
    openTaskDetail: '打开任务详情',
    taskCountPrefix: '任务',
    filteredState: '筛选中',
    allState: '全部状态',
    codeColumnTitle: '任务编码',
    intentColumnTitle: '任务 / 意图',
    nextActionColumnTitle: '状态 / 下一步',
    aiExecutionColumnTitle: 'AI 执行',
    sourceColumnTitle: '上下文来源',
    signalsColumnTitle: '证据',
    createdAtColumnTitle: '创建时间',
    updatedAtColumnTitle: '更新时间',
    priorityColumnTitle: '优先级',
    projectColumnTitle: '项目',
    templateColumnTitle: '模板',
    descriptionColumnTitle: '描述',
    runtimeSessionColumnTitle: 'Runtime 会话',
    rawIdColumnTitle: '原始任务 ID',
    createdFromColumnTitle: '创建来源',
    fieldSettings: '字段',
    fieldSettingsAria: '自定义任务字段',
    fieldSettingsHelp: '显示、隐藏或调整任务表格字段',
    restoreDefaultColumns: '恢复默认字段',
    requiredColumnReason: '固定列，不能隐藏',
    moveColumnUpAria: (columnTitle) => `上移字段：${columnTitle}`,
    moveColumnDownAria: (columnTitle) => `下移字段：${columnTitle}`,
    compactColumnAria: (columnTitle) => `压缩字段宽度：${columnTitle}`,
    standardColumnAria: (columnTitle) => `标准字段宽度：${columnTitle}`,
    wideColumnAria: (columnTitle) => `放宽字段宽度：${columnTitle}`,
    selectTaskAria: (taskTitle) => `选择任务：${taskTitle}`,
    selectAllVisibleTasks: '选择当前筛选结果',
    clearTaskSelection: '清除选择',
    bulkSelectedCount: (count) => `已选择 ${count} 项`,
    bulkStatusTargetAria: '批量状态目标',
    bulkStatusTargetTitle: '批量状态',
    bulkApplyStatus: '应用状态',
    bulkDelete: '批量删除',
    bulkDeleteConfirm: (count, skippedCount) => `确认删除 ${count} 个任务？${skippedCount ? `将跳过 ${skippedCount} 个运行中任务。` : ''}此操作不可撤销。`,
    bulkStatusSkippedHint: (eligibleCount, skippedCount) => `可处理 ${eligibleCount} 项，跳过 ${skippedCount} 项`,
  };
}

type TestTaskWorkspaceProps = ComponentProps<typeof TaskWorkspace> & Record<string, unknown>;

function renderTaskWorkspace(overrides: Partial<TestTaskWorkspaceProps> = {}): string {
  const props = {
    projectName: 'Zeus E2E',
    tasks: [],
    searchQuery: '',
    statusFilter: '',
    tagFilter: '',
    sortBy: 'title',
    statusOptions: ['', 'ready', 'running'],
    sortOptions: ['title', 'updatedAt'],
    statusLabels: { '': '全部', draft: '草稿', ready: '就绪', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' },
    sortLabels: { title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' },
    copy: {
      ...createTaskWorkspaceCopy(),
      emptyHelp: '用“新任务”创建第一条研发任务；创建后会显示状态、AI 执行入口、证据和更新时间。',
      emptySecondaryAction: '查看项目代码',
      taskListLoadingToolbarStatus: '任务加载中',
      taskListLoadingTitle: '正在读取任务',
      taskListLoadingHelp: '保留当前视图框架',
      taskListLoadingMeta: '等待本机数据',
      taskListErrorToolbarStatus: '任务暂不可用',
      taskListErrorTitle: '无法读取任务列表',
      taskListErrorHelp: '请重试，或在项目设置中确认本机路径权限。错误详情只进入本机日志，不在普通界面暴露堆栈。',
      taskListErrorRetry: '重试',
      taskListErrorProjectSettings: '项目设置',
    },
    runtime: { aiCli: { available: false, reason: '未配置' }, telegram: { enabled: false, reason: '未配置' } },
    runtimeSessions: [],
    creatingTaskBusy: false,
    activeProjectId: 'project_real',
    onSearchChange: () => undefined,
    onStatusFilterChange: () => undefined,
    onTagFilterChange: () => undefined,
    onSortChange: () => undefined,
    onTaskTableColumnsChange: () => undefined,
    onCreateTask: () => undefined,
    onOpenTaskDetail: () => undefined,
    onRetryTaskList: () => undefined,
    onOpenProjectSettings: () => undefined,
    onOpenProjectCode: () => undefined,
    controlBusyProps: () => ({}),
    ...overrides,
  } as ComponentProps<typeof TaskWorkspace>;
  return renderToStaticMarkup(<TaskWorkspace {...props} />);
}

function createTaskDetailDrawerCopy(): TaskDetailDrawerCopy {
  return {
    requestTitle: '任务要求',
    noRequest: '暂无任务要求',
    eventsTitle: '事件',
    noEvents: '暂无事件',
    runTask: '推送到模型',
    pauseRuntime: '暂停 Runtime',
    continueRuntime: '继续 Runtime',
    retryTask: '重试任务',
    markComplete: '标记完成',
    cancelTask: '取消任务',
    primaryActionsTitle: '主操作',
    secondaryActionsTitle: '次操作',
    dangerActionsTitle: '危险操作',
    metadataTitle: 'AI facts',
    projectLabel: '项目',
    templateLabel: '模板',
    aiCliLabel: 'AI CLI',
    aiDetected: 'AI CLI 可用',
    aiNotConfigured: 'AI 未配置',
    taskCodeLabel: '任务编码',
    sourceLabel: '上下文来源',
    updatedAtLabel: '更新时间',
    runtimeSessionLabel: 'Runtime 会话',
    runtimeCommandLabel: '运行命令 / 状态',
    latestEvidenceLabel: '最近事件',
    noEvidence: '暂无执行证据',
    runtimeSessionNotStarted: '未启动 Runtime 会话',
    runtimeCommandMissing: '未记录运行命令',
    nextActionLabels: {
      draft: '可启动 AI',
      ready: '可启动 AI',
      running: '等待 AI 输出',
      paused: '可继续',
      waiting_confirmation: '需要我确认',
      failed: '可重试',
      completed: '已完成',
      cancelled: '已取消',
    },
    sourceLabels: {
      manual: '手动创建',
      user: '手动创建',
      graph_node: '图谱节点',
      graph_view: '代码图谱',
      runtime_session: 'Runtime 会话',
      template: '任务模板',
      graph_question: '图谱问答',
    },
    updatedAtMissing: '未记录',
    sensitiveCommandArgument: '已隐藏敏感参数',
    runtimeSessionStatusLabels: {
      running: '运行中',
      exited: '已退出',
      failed: '已失败',
      stopped: '已停止',
      orphan_detected: '孤儿进程',
      lost: '已丢失',
    },
    cancelConfirm: '确认取消任务？',
  };
}

function createEnglishTaskDetailDrawerCopy(): TaskDetailDrawerCopy {
  return {
    ...createTaskDetailDrawerCopy(),
    requestTitle: 'Task request',
    noRequest: 'No task request yet',
    eventsTitle: 'Events',
    noEvents: 'No events yet',
    runTask: 'Push to model',
    pauseRuntime: 'Pause Runtime',
    continueRuntime: 'Continue Runtime',
    retryTask: 'Retry task',
    markComplete: 'Mark complete',
    cancelTask: 'Cancel task',
    primaryActionsTitle: 'Primary actions',
    secondaryActionsTitle: 'Secondary actions',
    dangerActionsTitle: 'Dangerous actions',
    metadataTitle: 'AI facts',
    aiDetected: 'AI CLI available',
    aiNotConfigured: 'AI not configured',
    taskCodeLabel: 'Task code',
    sourceLabel: 'Context source',
    updatedAtLabel: 'Updated',
    runtimeSessionLabel: 'Runtime session',
    runtimeCommandLabel: 'Command / status',
    latestEvidenceLabel: 'Latest evidence',
    noEvidence: 'No execution evidence yet',
    runtimeSessionNotStarted: 'Runtime session not started',
    runtimeCommandMissing: 'No runtime command recorded',
    nextActionLabels: {
      draft: 'Can start AI',
      ready: 'Can start AI',
      running: 'Waiting for AI output',
      paused: 'Can continue',
      waiting_confirmation: 'Needs my confirmation',
      failed: 'Can retry',
      completed: 'Completed',
      cancelled: 'Cancelled',
    },
    sourceLabels: {
      manual: 'Manual',
      user: 'Manual',
      graph_node: 'Graph node',
      graph_view: 'Code graph',
      runtime_session: 'Runtime session',
      template: 'Task template',
      graph_question: 'Graph Q&A',
    },
    updatedAtMissing: 'Not recorded',
    sensitiveCommandArgument: 'Sensitive argument hidden',
    runtimeSessionStatusLabels: {
      running: 'Running',
      exited: 'Exited',
      failed: 'Failed',
      stopped: 'Stopped',
      orphan_detected: 'Orphan detected',
      lost: 'Lost',
    },
    cancelConfirm: 'Cancel this task?',
  };
}

function createAppShellSettings(taskTableColumns: TaskTableColumnPreferences): AppShellSettings {
  return {
    appLanguage: 'zh-CN',
    appearance: 'system',
    webviewDebugEnabled: false,
    developerModeEnabled: false,
    multiWindowEnabled: true,
    backgroundModeEnabled: true,
    desktopNotificationsEnabled: true,
    openAtLoginEnabled: false,
    autoUpdateChannel: 'manual',
    defaultProjectId: null,
    pinnedProjectIds: [],
    defaultModel: null,
    defaultTaskTemplateId: null,
    taskTableColumns,
    localLogDirectory: 'Zeus/logs',
    localConfigPath: 'Zeus/zeus.config.json',
    dataPortability: {
      importSupported: true,
      exportSupported: true,
      redactsSecrets: true,
    },
    cache: { codeIndex: true, graphView: true, layout: true },
    lastCacheClearAt: null,
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

    expect(html).toContain('workspace-view-project-tasks');
    expect(html).toContain('task-table-workbench');
    expect(html).toContain('分析当前项目结构');
    expect(html).not.toContain('运行任务');
    expect(html).not.toContain('标记完成');
    expect(html).not.toContain('取消任务');
    expect(html).not.toContain('要求后续变更');
    expect(html).not.toContain('task-detail-drawer-pane');
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

    expect(runningHtml).toContain('task-table-workbench');
    expect(runningHtml).toContain('运行中真实任务');
    expect(runningHtml).not.toContain('暂停 Runtime');
    expect(runningHtml).not.toContain('标记完成');
    expect(pausedHtml).toContain('暂停真实任务');
    expect(pausedHtml).not.toContain('继续 Runtime');
    expect(pausedHtml).not.toContain('标记完成');
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

    expect(html).toContain('task-table-workbench');
    expect(html).not.toContain('归档任务');
    expect(html).not.toContain('已归档真实任务');
    expect(html).not.toContain('恢复任务');
    expect(html).not.toContain('归档任务为空');
  });

  it('normalizes archived task recovery into compact restore rows instead of generic object rows', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([])}
        initialMainNavTarget="tasks"
        initialArchivedTasks={[
          {
            id: 'task_archived',
            projectId: 'project_real',
            title: '已归档真实任务',
            description: '来自真实任务',
            status: 'ready',
          },
        ]}
      />,
    );
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).not.toContain('task-archive-workbench');
    expect(html).not.toContain('task-archive-row');
    expect(html).not.toContain('task-archive-copy');
    expect(html).not.toContain('task-archive-action');
    expect(source).not.toContain('className="object-row" key={task.id} onClick={() => restoreTask(task.id)}');
    expect(css).toContain('任务页纯表格首屏最终覆盖');
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
    expect(html).toContain('上下文来源');
    expect(html).not.toContain('运行环境');
    expect(html).not.toContain('代码变更');
    expect(html).not.toContain('筛选状态');
    expect(html).not.toContain('task-management-context-rail');
    expect(html).not.toContain('task-detail-drawer-pane');
  });

  it('renders AI-native default task columns with readable task code and no team workflow fields', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_real',
            projectId: 'project_real',
            taskCode: 'ZEU-000001',
            taskSequence: 1,
            title: '分析任务字段',
            description: '让任务页成为个人 AI 工作队列',
            status: 'running',
            priority: 'normal',
            tags: ['ai-native'],
            createdFrom: 'graph_node',
            sourceContextJson: JSON.stringify({ nodeId: 'graph-node-real' }),
            createdAt: '2026-06-25T01:00:00.000Z',
            updatedAt: '2026-06-25T02:00:00.000Z',
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );

    expect(html).toContain('任务编码');
    expect(html).toContain('ZEU-000001');
    expect(html).toContain('状态 / 下一步');
    expect(html).toContain('AI 执行');
    expect(html).toContain('上下文来源');
    expect(html).toContain('图谱节点');
    expect(html).not.toContain('负责人');
    expect(html).not.toContain('处理人');
    expect(html).not.toContain('assignee');
    expect(html).not.toContain('owner');
  });

  it('renders updated time as a single formatted line instead of leaking raw ISO text', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_time',
            projectId: 'project_real',
            taskCode: 'ZEU-000002',
            title: '检查更新时间列',
            status: 'ready',
            createdAt: '2026-06-25T01:00:00.000Z',
            updatedAt: '2026-06-25T02:38:45.819Z',
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );

    expect(html).toContain('2026-06-25 10:38:45');
    expect(html).not.toContain('2026-06-25T02:38:45.819Z');
  });

  it('keeps custom column settings after New Task while making the entry explicit', () => {
    const html = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_real',
            projectId: 'project_real',
            taskCode: 'ZEU-000001',
            title: '分析任务字段',
            status: 'ready',
            tags: [],
            createdAt: '2026-06-25T01:00:00.000Z',
            updatedAt: '2026-06-25T02:00:00.000Z',
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['']}
        sortOptions={['updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={{ ...createTaskWorkspaceCopy(), fieldSettings: '自定义列', fieldSettingsAria: '自定义任务字段', restoreDefaultColumns: '恢复默认字段' }}
        runtime={{ aiCli: { name: 'codex', command: 'codex', available: true, reason: 'ready' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        taskTableColumns={{ visibleColumnKeys: ['code', 'intent'], columnOrder: ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt'] }}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('task-table-field-settings-trigger');
    expect(html).toContain('task-table-view-pill-strong');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('task-table-field-settings-popover');
    expect(html).toContain('task-table-field-settings-heading');
    expect(html).toContain('显示、隐藏或调整任务表格字段');
    expect(html).toContain('>列<');
    expect(html.match(/task-table-new-task-button/gu)?.length).toBe(1);
    expect(html.indexOf('task-table-new-task-button')).toBeLessThan(html.indexOf('task-table-field-settings-trigger'));
  });

  it('renders the multi-scene prototype toolbar as primary actions plus a quieter view-control row', () => {
    const html = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus E2E"
        tasks={[
          {
            id: 'task_one',
            projectId: 'project_real',
            taskCode: 'ZEU-000001',
            taskSequence: 1,
            title: '123',
            description: '123',
            status: 'ready',
            priority: 'normal',
            tags: [],
            createdFrom: 'manual',
            updatedAt: '2026-07-01T02:38:45.819Z',
          },
          {
            id: 'task_two',
            projectId: 'project_real',
            taskCode: 'ZEU-000002',
            taskSequence: 2,
            title: '带图任务',
            status: 'ready',
            priority: 'normal',
            tags: ['image'],
            createdFrom: 'manual',
            updatedAt: '2026-07-02T05:52:00.000Z',
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="title"
        statusOptions={['', 'ready', 'running']}
        sortOptions={['title', 'updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '就绪', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { available: false, reason: '未配置' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('task-table-primary-toolbar');
    expect(html).toContain('task-table-view-toolbar');
    expect(html).toContain('task-table-status-segments');
    expect(html).toContain('task-table-status-segment');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('task-table-view-summary');
    expect(html).toContain('task-table-view-actions');
    expect(html).toContain('task-table-view-bulk-pill');
    expect(html).toContain('>批量<');
    expect(html).toContain('>列<');
    expect(html).toContain('task-table-more-settings');
    expect(html).toContain('>更多<');
    expect(html).toContain('disabled="" aria-disabled="true"');
    expect(html).not.toContain('task-table-view-more-panel');
    expect(html).not.toContain('>清除筛选<');
    expect(html).not.toContain('>恢复默认列<');
    expect(html).toContain('视图控制');
    expect(html).toContain('默认视图');
    expect(html).toContain('任务编码、任务 / 意图、状态 / 下一步、AI 执行、上下文来源、证据、更新时间');
    expect(html).not.toContain('task-table-compact-toolbar');
    expect(html.indexOf('task-table-primary-toolbar')).toBeLessThan(html.indexOf('task-table-view-toolbar'));
    expect(html.indexOf('task-table-view-toolbar')).toBeLessThan(html.indexOf('task-list-workbench task-list-protagonist'));
    expect(html.indexOf('task-table-new-task-button')).toBeLessThan(html.indexOf('task-table-field-settings-trigger'));
  });

  it('does not open a dead More floating menu when filters and columns are already at defaults', () => {
    const html = renderTaskWorkspace({ tasks: [] });

    expect(html).toContain('class="task-table-view-pill task-table-more-settings-trigger"');
    expect(html).toContain('disabled="" aria-disabled="true"');
    expect(html).not.toContain('task-table-view-more-panel');
    expect(html).not.toContain('>清除筛选<');
    expect(html).not.toContain('>恢复默认列<');
  });

  it('keeps the More view control as action-only menu instead of reopening sort and tag form fields', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const html = renderTaskWorkspace({ tasks: [], searchQuery: 'release', taskTableColumns: { columnWidths: { updatedAt: 'wide' } } });
    const finalCss = css.slice(css.indexOf('任务页多场景原型高还原最终覆盖'));
    const morePanelCss = finalCss.match(/\.macos-ai-app \.task-table-view-more-panel\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(morePanelCss).toContain('inline-size: min(220px, calc(100vw - 32px))');
    expect(morePanelCss).not.toMatch(/inline-size:\s*min\(320px/);
    expect(html).toContain('role="menu"');
    expect(html).toContain('task-table-more-menu-action');
    expect(html).toContain('>清除筛选<');
    expect(html).toContain('>恢复默认列<');
    expect(source).not.toContain('task-table-more-menu-input');
    expect(source).not.toContain('task-table-more-menu-select');
    expect(source).not.toContain('props.copy.tagFilterAria');
    expect(source).not.toContain('props.copy.sortSelectAria');
    expect(finalCss).not.toContain('.task-table-view-more-panel .task-filter-control-row');
    expect(finalCss).not.toContain('.task-table-view-more-panel .task-table-more-menu-input');
    expect(finalCss).not.toContain('.task-table-view-more-panel .task-table-more-menu-select');
  });

  it('keeps the packaged desktop toolbar dense instead of stacking search and new task at 980px widths', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const finalCss = css.slice(css.indexOf('任务页多场景原型高还原最终覆盖'));
    const compactCss = finalCss.replace(/\s+/g, ' ');

    expect(finalCss).toMatch(/\.macos-ai-app \.task-table-primary-toolbar\s*\{[\s\S]*grid-template-columns:\s*max-content minmax\(260px,\s*1fr\) auto auto/);
    expect(finalCss).toMatch(/\.macos-ai-app \.task-table-primary-toolbar \.task-table-context-meta\s*\{[\s\S]*grid-column:\s*1/);
    expect(finalCss).toMatch(/\.macos-ai-app \.task-table-primary-toolbar \.task-toolbar-search\s*\{[\s\S]*grid-column:\s*2/);
    expect(finalCss).toMatch(/\.macos-ai-app \.task-table-primary-toolbar \.task-table-status-segments\s*\{[\s\S]*grid-column:\s*3/);
    expect(finalCss).toMatch(/\.macos-ai-app \.task-table-primary-toolbar \.task-table-new-task-button\s*\{[\s\S]*grid-column:\s*4/);
    expect(compactCss).not.toMatch(/@media \(max-width:\s*980px\)[^{]*\{[^@]*\.macos-ai-app \.task-table-primary-toolbar[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(compactCss).not.toMatch(/@media \(max-width:\s*980px\)[^{]*\{[^@]*\.macos-ai-app \.task-table-primary-toolbar \.task-toolbar-search[^}]*grid-column:\s*1 \/ -1/);
    expect(finalCss).toMatch(/\.macos-ai-app \.task-table-primary-toolbar \.task-table-new-task-button\s*\{[\s\S]*inline-size:\s*auto[\s\S]*justify-self:\s*end/);
  });

  it('keeps the empty-state toolbar on one dense row and removes duplicate empty-state action buttons', () => {
    const html = renderTaskWorkspace({ tasks: [] });

    expect(html).toContain('Zeus E2E · 任务 0/0 · 全部状态');
    expect(html).toContain('task-table-primary-toolbar');
    expect(html).toContain('task-toolbar-search');
    expect(html).toContain('task-table-status-segments');
    expect(html).toContain('task-table-new-task-button');
    expect(html.indexOf('task-table-context-meta')).toBeLessThan(html.indexOf('task-toolbar-search'));
    expect(html.indexOf('task-toolbar-search')).toBeLessThan(html.indexOf('task-table-status-segments'));
    expect(html.indexOf('task-table-status-segments')).toBeLessThan(html.indexOf('task-table-new-task-button'));
    expect(html).toContain('<strong>还没有任务</strong>');
    expect(html).toContain('用“新任务”创建第一条研发任务；创建后会显示状态、AI 执行入口、证据和更新时间。');
    expect(html).not.toContain('task-empty-state-action-rail');
    expect(html).not.toContain('task-empty-state-primary-action');
    expect(html).not.toContain('task-empty-state-secondary-action');
    expect(html).not.toContain('查看项目代码');
    expect((html.match(/>新任务</g) ?? []).length).toBe(1);
    expect(html).not.toContain('task-empty-state-outcome-grid');
  });

  it('keeps the no-results state inside the same table frame with clear-filter recovery actions', () => {
    const html = renderTaskWorkspace({
      tasks: [
        {
          id: 'task_existing',
          projectId: 'project_real',
          taskCode: 'ZEU-000001',
          title: '已有任务',
          status: 'ready',
          priority: 'normal',
          tags: ['backend'],
          createdAt: '2026-07-01T02:38:45.819Z',
          updatedAt: '2026-07-01T02:38:45.819Z',
        },
      ],
      searchQuery: 'release',
      statusFilter: 'running',
    });

    expect(html).toContain('没有匹配任务');
    expect(html).toContain('调整筛选条件');
    expect(html).toContain('>清除筛选<');
    expect(html).toContain('>查看全部状态<');
    expect(html).toContain('task-table-header');
    expect(html).toContain('任务编码');
    expect(html).toContain('更新时间');
    expect(html).not.toContain('>新任务</button></span>');
  });

  it('renders loading and recoverable error task-list states without replacing the toolbar or exposing stack details', () => {
    const loadingHtml = renderTaskWorkspace({ listState: 'loading' });
    const errorHtml = renderTaskWorkspace({ listState: 'error' });
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const finalCss = css.slice(css.indexOf('任务页多场景原型高还原最终覆盖'));
    const compactCss = finalCss.replace(/\s+/g, ' ');

    expect(loadingHtml).toContain('task-list-loading-state');
    expect(loadingHtml).toContain('正在读取任务');
    expect(loadingHtml).toContain('保留当前视图框架');
    expect(loadingHtml).toContain('task-loading-skeleton-line');
    expect(loadingHtml).not.toContain('还没有任务');
    expect(errorHtml).toContain('task-list-error-row');
    expect(errorHtml).toContain('无法读取任务列表');
    expect(errorHtml).toContain('请重试，或在项目设置中确认本机路径权限。错误详情只进入本机日志，不在普通界面暴露堆栈。');
    expect(errorHtml).toContain('>重试<');
    expect(errorHtml).toContain('>项目设置<');
    expect(errorHtml).not.toContain('Error:');
    expect(errorHtml).not.toContain('stack');
    expect(compactCss).toMatch(/\.macos-ai-app \.task-list-loading-state\s*\{[^}]*display:\s*grid/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-list-error-row\s*\{[^}]*display:\s*grid/);
  });

  it('keeps the default table free of a fake scrollbar while expanded columns get the single horizontal fallback', () => {
    const defaultHtml = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus E2E"
        tasks={[
          {
            id: 'task_default_scroll',
            projectId: 'project_real',
            taskCode: 'ZEU-000001',
            title: '默认列不出现假横条',
            status: 'ready',
            priority: 'normal',
            tags: [],
            createdFrom: 'manual',
            updatedAt: '2026-07-02T05:52:00.000Z',
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="title"
        statusOptions={['', 'ready', 'running']}
        sortOptions={['title']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '就绪', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { available: false, reason: '未配置' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );
    const wideHtml = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus E2E"
        tasks={[
          {
            id: 'task_wide_scroll',
            projectId: 'project_real',
            taskCode: 'ZEU-000002',
            title: '宽列需要横向兜底',
            status: 'ready',
            priority: 'normal',
            tags: [],
            createdFrom: 'manual',
            updatedAt: '2026-07-02T05:52:00.000Z',
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="title"
        statusOptions={['', 'ready', 'running']}
        sortOptions={['title']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '就绪', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { available: false, reason: '未配置' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        taskTableColumns={{
          visibleColumnKeys: ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt'],
          columnOrder: ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt'],
          columnWidths: { intent: 'wide' },
        }}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    expect(defaultHtml).not.toContain('task-list-horizontal-scroll');
    expect(wideHtml).toContain('task-list-horizontal-scroll');
    expect(css).toContain('任务页多场景原型高还原最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-workbench > \.task-list-workbench\.task-list-protagonist:not\(\.task-list-empty\):not\(\.task-list-horizontal-scroll\)\s*\{[^}]*overflow-x:\s*visible[^}]*overflow-y:\s*visible/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-workbench > \.task-list-workbench\.task-list-protagonist\.task-list-horizontal-scroll\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*visible/);
  });

  it('renders field settings as a bounded polished popover instead of a clipped white panel', () => {
    const html = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_real',
            projectId: 'project_real',
            taskCode: 'ZEU-000001',
            title: '分析任务字段',
            status: 'ready',
            tags: [],
            createdAt: '2026-06-25T01:00:00.000Z',
            updatedAt: '2026-06-25T02:00:00.000Z',
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['']}
        sortOptions={['updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { name: 'codex', command: 'codex', available: true, reason: 'ready' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        taskTableColumns={{
          visibleColumnKeys: ['code', 'intent'],
          columnOrder: ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt', 'createdAt', 'template', 'project', 'priority', 'description', 'runtimeSession', 'rawId', 'createdFrom'],
        }}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );
    const source = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    expect(html).toContain('task-table-field-settings-heading');
    expect(html).toContain('task-table-field-settings-list');
    expect(html).toContain('task-table-field-settings-footer');
    expect(source).toContain('字段弹层是有边界的 popover');
    expect(css).toContain('任务字段弹层产品化最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-field-settings-popover\s*\{[^}]*inline-size:\s*min\(360px,\s*calc\(100vw - 32px\)\)[^}]*max-block-size:\s*min\(420px,\s*calc\(100vh - 140px\)\)[^}]*overflow:\s*hidden/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-field-settings-popover\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-field-settings-list\s*\{[^}]*overflow:\s*auto/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-field-option\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto[^}]*min-block-size:\s*38px/);
  });

  it('field settings exposes required column reason and move controls', () => {
    const html = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_real',
            projectId: 'project_real',
            taskCode: 'ZEU-000001',
            title: '分析任务字段',
            status: 'ready',
            tags: [],
            createdAt: '2026-06-25T01:00:00.000Z',
            updatedAt: '2026-06-25T02:00:00.000Z',
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['']}
        sortOptions={['updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { name: 'codex', command: 'codex', available: true, reason: 'ready' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        taskTableColumns={{ visibleColumnKeys: ['code', 'intent', 'project'], columnOrder: ['code', 'intent', 'project', 'updatedAt'] }}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('固定列，不能隐藏');
    expect(html).toContain('aria-describedby="task-table-field-code-reason"');
    expect(html).toContain('aria-describedby="task-table-field-intent-reason"');
    expect(html).toContain('aria-label="上移字段：任务编码"');
    expect(html).toContain('aria-label="下移字段：任务编码"');
    expect(html).toContain('class="task-table-field-order-button"');
    expect(html).toMatch(/aria-label="上移字段：任务编码" disabled=""/u);
    expect(html).toMatch(/aria-label="下移字段：创建来源" disabled=""/u);

    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const orderButtonBlock = css.match(/\.macos-ai-app \.task-table-field-order-button\s*\{[\s\S]*?\}/u)?.[0] ?? '';
    expect(orderButtonBlock).toContain('min-block-size: 24px');
    expect(orderButtonBlock).toContain('min-inline-size: 24px');
  });

  it('field settings exposes per-column width controls and the task rows stay compact', () => {
    const html = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_width',
            projectId: 'project_real',
            taskCode: 'ZEU-000006',
            title: '自定义任务列宽',
            status: 'ready',
            tags: [],
            updatedAt: '2026-06-25T02:38:45.819Z',
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['']}
        sortOptions={['updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { name: 'codex', command: 'codex', available: true, reason: 'ready' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        taskTableColumns={{ visibleColumnKeys: ['code', 'intent', 'updatedAt'], columnOrder: ['code', 'intent', 'updatedAt'] }}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    expect(html).toContain('task-table-field-width-controls');
    expect(html).toContain('aria-label="压缩字段宽度：更新时间"');
    expect(html).toContain('aria-label="标准字段宽度：更新时间"');
    expect(html).toContain('aria-label="放宽字段宽度：更新时间"');
    expect(taskSource).toContain('getTaskTableColumnTrack');
    expect(taskSource).toContain('columnWidths');
    expect(css).toContain('任务表格密度与更新时间列返修最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-row\s*\{[^}]*min-block-size:\s*44px[^}]*padding:\s*3px 12px/);
  });

  it('keeps default task columns inside the workbench without forcing a horizontal scrollbar', () => {
    const html = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_fit',
            projectId: 'project_real',
            taskCode: 'ZEU-000007',
            title: '默认列不横向溢出',
            status: 'ready',
            priority: 'normal',
            tags: [],
            createdFrom: 'manual',
            sourceContextJson: JSON.stringify({ path: '/Users/david/hypha/zeus' }),
            updatedAt: '2026-07-01T02:38:45.819Z',
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['']}
        sortOptions={['updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { name: 'codex', command: 'codex', available: true, reason: 'ready' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    expect(html).toContain('手动创建');
    expect(html).not.toContain('/Users/david/hypha/zeus');
    expect(taskSource).toContain("minWidth: 'min(100%, 880px)'");
    expect(taskSource).toContain("intent: 'minmax(168px, 1.1fr)'");
    expect(taskSource).not.toContain("minWidth: model.visibleColumns.length > 2 ? '920px' : '480px'");
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-header,\s*\.macos-ai-app \.task-table-row\s*\{[^}]*gap:\s*8px/);
  });

  it('keeps the custom column popover compact with width controls on the same row', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    expect(css).toContain('任务字段弹层截图返修最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-field-settings-popover\s*\{[^}]*max-block-size:\s*min\(300px,\s*calc\(100vh - 140px\)\)/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-field-option\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto auto/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-field-width-controls\s*\{[^}]*grid-column:\s*auto/);
  });

  it('lets the custom column popover escape the table scroll area instead of clipping at the first row bottom', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    expect(css).toContain('任务字段弹层裁切返修最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-layout,\s*\.macos-ai-app \.task-table-only-layout\s*\{[^}]*overflow:\s*visible/);
    expect(compactCss).toMatch(
      /\.macos-ai-app \.task-management-codex-layout > \.task-management-navigation,\s*\.macos-ai-app \.workspace-view-project-tasks \.task-management-detail-pane,\s*\.macos-ai-app \.task-table-workbench\s*\{[^}]*overflow:\s*visible/,
    );
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-workbench > \.task-list-workbench\.task-list-protagonist\.task-list-horizontal-scroll\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*visible/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-field-settings-popover\s*\{[^}]*z-index:\s*260/);
  });

  it('keeps the task table horizontally reachable without creating a tall blank scroll viewport', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    expect(css).toContain('任务表格默认列可达性最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-workbench\s*\{[^}]*block-size:\s*auto[^}]*grid-template-rows:\s*auto auto[^}]*min-block-size:\s*0/);
    expect(compactCss).toMatch(
      /\.macos-ai-app \.task-table-workbench > \.task-list-workbench\.task-list-protagonist:not\(\.task-list-empty\)\s*\{[^}]*align-content:\s*start[^}]*block-size:\s*auto[^}]*grid-auto-rows:\s*minmax\(44px,\s*auto\)[^}]*grid-template-rows:\s*auto/,
    );
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-workbench > \.task-list-workbench\.task-list-protagonist:not\(\.task-list-empty\):not\(\.task-list-horizontal-scroll\)\s*\{[^}]*overflow-x:\s*visible/);
    expect(compactCss).not.toMatch(/任务表格横向滚动条底部返修最终覆盖[\s\S]*?block-size:\s*min\(72vh,\s*760px\)/);
    expect(compactCss).not.toMatch(/\.macos-ai-app \.task-table-workbench > \.task-list-workbench\.task-list-protagonist:not\(\.task-list-empty\)\s*\{[^}]*block-size:\s*100%/);
  });

  it('keeps default right-side task columns rendered and reachable while wide custom columns keep the scroll marker', () => {
    const defaultHtml = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_default_columns',
            projectId: 'project_real',
            taskCode: 'ZEU-000001',
            title: '默认列必须可达',
            status: 'ready',
            priority: 'normal',
            tags: [],
            updatedAt: '2026-07-02T05:52:00.000Z',
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['', 'ready']}
        sortOptions={['updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { name: 'codex', command: 'codex', available: true, reason: 'ready' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );
    const wideHtml = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_wide_columns',
            projectId: 'project_real',
            taskCode: 'ZEU-000002',
            title: '宽列才允许横向滚动',
            status: 'ready',
            tags: [],
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['', 'ready']}
        sortOptions={['updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { name: 'codex', command: 'codex', available: true, reason: 'ready' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        taskTableColumns={{
          visibleColumnKeys: ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt'],
          columnOrder: ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt'],
          columnWidths: { intent: 'wide' },
        }}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    expect(defaultHtml).toContain('证据');
    expect(defaultHtml).toContain('更新时间');
    expect(defaultHtml).toContain('优先级 normal');
    expect(defaultHtml).toContain('2026-07-02 13:52:00');
    expect(wideHtml).toContain('task-list-horizontal-scroll');
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-workbench > \.task-list-workbench\.task-list-protagonist:not\(\.task-list-empty\):not\(\.task-list-horizontal-scroll\)\s*\{[^}]*overflow-x:\s*visible[^}]*overflow-y:\s*visible/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-workbench > \.task-list-workbench\.task-list-protagonist\.task-list-horizontal-scroll\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*visible/);
  });

  it('renders task bulk selection controls without nesting checkboxes inside row buttons', () => {
    const html = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_ready',
            projectId: 'project_real',
            taskCode: 'ZEU-000001',
            title: '准备批量处理',
            status: 'ready',
            tags: [],
          },
          {
            id: 'task_running',
            projectId: 'project_real',
            taskCode: 'ZEU-000002',
            title: '运行中不误删',
            status: 'running',
            tags: [],
          },
        ]}
        selectedTaskId="task_ready"
        selectedTaskIds={['task_ready']}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['', 'ready', 'running', 'completed', 'cancelled']}
        sortOptions={['updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { name: 'codex', command: 'codex', available: true, reason: 'ready' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        taskTableColumns={{ visibleColumnKeys: ['code', 'intent', 'updatedAt'], columnOrder: ['code', 'intent', 'updatedAt'] }}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        onToggleTaskSelection={() => undefined}
        onToggleAllVisibleTaskSelection={() => undefined}
        onClearTaskSelection={() => undefined}
        onBulkTaskStatusChange={() => undefined}
        onBulkTaskDelete={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('task-table-bulk-action-bar');
    expect(html).toContain('已选择 1 项');
    expect(html).toContain('批量状态');
    expect(html).toContain('批量删除');
    expect(html).toContain('aria-label="选择任务：准备批量处理"');
    expect(html).toContain('class="task-list-row selected task-table-row"');
    expect(html).toContain('role="row"');
    expect(html).not.toMatch(/<button[^>]*class="task-list-row[^"]*task-table-row"[^>]*role="row"/u);
  });

  it('keeps task table header and rows on one shared grid track including the selection column', () => {
    const html = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_align',
            projectId: 'project_real',
            taskCode: 'ZEU-000003',
            title: '对齐任务列',
            status: 'ready',
            tags: [],
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['', 'ready']}
        sortOptions={['updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { name: 'codex', command: 'codex', available: true, reason: 'ready' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        taskTableColumns={{ visibleColumnKeys: ['code', 'intent', 'updatedAt'], columnOrder: ['code', 'intent', 'updatedAt'] }}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const finalGridBlock = css.match(/\.macos-ai-app \.task-table-header,\n\.macos-ai-app \.task-table-row\s*\{[\s\S]*?\}/gu)?.at(-1) ?? '';

    expect(html).toContain('task-table-select-cell');
    expect(html).toContain('role="columnheader"');
    expect(html).toContain('role="gridcell"');
    expect(taskSource).toContain("'--task-table-grid-template'");
    expect(taskSource).toContain("gridTemplateColumns: 'var(--task-table-grid-template)'");
    expect(css).toContain('任务表格选择列与轨道对齐最终覆盖');
    expect(finalGridBlock).toContain('grid-template-columns: var(--task-table-grid-template)');
  });

  it('keeps bulk delete behind selected mode with confirmation copy instead of the default toolbar', () => {
    const defaultHtml = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_backend',
            projectId: 'project_real',
            title: '修复 API Bug',
            status: 'ready',
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );
    const selectedHtml = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_delete',
            projectId: 'project_real',
            taskCode: 'ZEU-000004',
            title: '批量删除候选',
            status: 'ready',
            tags: [],
          },
        ]}
        selectedTaskIds={['task_delete']}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['', 'ready', 'cancelled']}
        sortOptions={['updatedAt']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { name: 'codex', command: 'codex', available: true, reason: 'ready' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        onToggleTaskSelection={() => undefined}
        onToggleAllVisibleTaskSelection={() => undefined}
        onClearTaskSelection={() => undefined}
        onBulkTaskStatusChange={() => undefined}
        onBulkTaskDelete={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(defaultHtml).not.toContain('task-table-bulk-delete-button');
    expect(selectedHtml).toContain('task-table-bulk-delete-button');
    expect(appSource).toContain('window.confirm');
    expect(appSource).toContain('bulkDeleteConfirm');
  });

  it('field settings has Escape close and focus return contract', () => {
    const source = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');

    expect(source).toContain("document.addEventListener('keydown'");
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("document.addEventListener('pointerdown'");
    expect(source).toContain('fieldSettingsPopoverRef.current');
    expect(source).toContain('fieldSettingsTriggerRef.current?.focus()');
    expect(source).toContain('aria-haspopup="dialog"');
  });

  it('app shell settings keeps taskTableColumns and ignores stale field preference responses', () => {
    const latestColumns: TaskTableColumnPreferences = normalizeTaskTableColumnPreferences({
      visibleColumnKeys: ['intent', 'code', 'project'],
      columnOrder: ['intent', 'code', 'project', 'updatedAt'],
    });
    const savedFieldColumns: TaskTableColumnPreferences = normalizeTaskTableColumnPreferences({
      visibleColumnKeys: ['code', 'intent', 'priority'],
      columnOrder: ['code', 'intent', 'priority', 'updatedAt'],
    });
    const ordinarySaveColumns: TaskTableColumnPreferences = normalizeTaskTableColumnPreferences({
      visibleColumnKeys: ['code', 'intent', 'description'],
      columnOrder: ['code', 'intent', 'description', 'updatedAt'],
    });
    const currentSettings = {
      ...createAppShellSettings(latestColumns),
      appearance: 'dark' as const,
    };
    const staleFieldSavedSettings = {
      ...createAppShellSettings(savedFieldColumns),
      appearance: 'system' as const,
    };
    const ordinarySavedSettings = {
      ...createAppShellSettings(ordinarySaveColumns),
      appearance: 'light' as const,
      pinnedProjectIds: ['project_saved'],
    };

    const payload = toAppShellSettingsSavePayload(currentSettings);
    const staleResolution = resolveTaskTableColumnsSaveResponse({
      currentSettings,
      savedSettings: staleFieldSavedSettings,
      requestId: 1,
      latestRequestId: 2,
    });
    const latestResolution = resolveTaskTableColumnsSaveResponse({
      currentSettings,
      savedSettings: staleFieldSavedSettings,
      requestId: 2,
      latestRequestId: 2,
    });
    const ordinaryResolution = mergeAppShellSettingsSaveResponse({
      currentSettings,
      savedSettings: ordinarySavedSettings,
    });

    expect(payload.taskTableColumns).toEqual(latestColumns);
    expect(staleResolution.taskTableColumns).toEqual(latestColumns);
    expect(staleResolution.appearance).toBe('dark');
    expect(latestResolution.taskTableColumns).toEqual(savedFieldColumns);
    expect(latestResolution.appearance).toBe('dark');
    expect(ordinaryResolution.taskTableColumns).toEqual(latestColumns);
    expect(ordinaryResolution.appearance).toBe('light');
    expect(ordinaryResolution.pinnedProjectIds).toEqual(['project_saved']);
  });

  it('normalizes task create modal draft before touching the real task API', () => {
    expect(buildTaskCreateInitialForm('zh-CN')).toEqual({
      title: '',
      description: '',
      tags: '',
      attachments: [],
    });
    expect(normalizeTaskCreateDraft({ title: '  ', description: '保留输入', tags: 'ai', attachments: [] }, '标题必填')).toEqual({
      error: '标题必填',
    });
    expect(
      normalizeTaskCreateDraft(
        {
          title: '  修复任务创建体验  ',
          description: '  先弹窗再创建  ',
          tags: ' ai, UI ,ai, , zeus ',
          attachments: [
            { path: '/Users/david/Desktop/screenshot.png', name: 'screenshot.png', kind: 'image' },
            { path: '/Users/david/Desktop/notes.pdf', name: 'notes.pdf', kind: 'file' },
          ],
        },
        '标题必填',
      ),
    ).toEqual({
      draft: {
        title: '修复任务创建体验',
        description: '先弹窗再创建',
        tags: ['ai', 'UI', 'zeus'],
        attachments: [
          { path: '/Users/david/Desktop/screenshot.png', name: 'screenshot.png', kind: 'image' },
          { path: '/Users/david/Desktop/notes.pdf', name: 'notes.pdf', kind: 'file' },
        ],
      },
    });
  });

  it('renders task attachments as a horizontal image filmstrip with Codex-style managed preview URLs', () => {
    expect(
      resolveTaskAttachmentPreviewSrc(
        {
          path: '/Users/david/Desktop/error state.png',
          name: 'error state.png',
          kind: 'image',
          previewUrl: 'data:image/png;base64,iVBORw0KGgo=',
        },
        new Map(),
      ),
    ).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(resolveTaskAttachmentPreviewSrc({ path: '/Users/david/Desktop/error state.png', name: 'error state.png', kind: 'image' }, new Map())).toBe('');

    const html = renderToStaticMarkup(
      <TaskAttachmentPreviewList
        attachments={[
          {
            path: '/Users/david/Desktop/error state.png',
            name: 'error state.png',
            kind: 'image',
            previewUrl: 'data:image/png;base64,iVBORw0KGgo=',
          },
          { path: '/Users/david/Desktop/context.xlsx', name: 'context.xlsx', kind: 'file' },
        ]}
        mode="editable"
        onRemove={() => undefined}
        copy={{
          imageLabel: '图片',
          fileLabel: '文件',
          openFileLabel: '打开附件',
          removeLabel: '移除附件',
          openPreviewLabel: '放大预览附件',
          closePreviewLabel: '关闭附件预览',
          previewUnavailable: '无法预览，本机路径已保存',
          localPathLabel: '本机路径',
          addedStatus: (count) => `已添加 ${count} 个附件，图片可点击放大预览。`,
        }}
      />,
    );

    expect(html).toContain('task-attachment-filmstrip');
    expect(html).toContain('task-attachment-thumb-button');
    expect(html).toContain('task-attachment-file-button');
    expect(html).toContain('aria-label="打开附件: context.xlsx"');
    expect(html).toContain('data-attachment-extension="XLSX"');
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(html).not.toContain('file:///Users/david/Desktop/error%20state.png');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('移除附件: error state.png');
    expect(html).toContain('task-attachment-zoom-dialog');
  });

  it('normalizes the active task list into compact rows instead of generic object cards', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_backend',
            projectId: 'project_real',
            title: '修复 API Bug',
            description: '收敛任务列表视觉',
            status: 'ready',
            tags: ['backend', 'bug'],
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('task-list-workbench');
    expect(html).toContain('task-list-row');
    expect(html).toContain('task-list-copy');
    expect(html).toContain('task-list-meta');
    expect(html).not.toContain('class="object-row selected"');
    expect(source).not.toContain("className={task.id === selectedTask?.id ? 'object-row selected' : 'object-row'}");
    expect(css).toContain('任务普通列表最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-list-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  });

  it('keeps the empty task list as a lightweight source-list row instead of a full-height blank panel', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot([])} initialMainNavTarget="tasks" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('task-list-workbench task-list-protagonist zeus-source-list task-list-empty');
    expect(html).toContain('project-inline-recovery-row task-list-empty-row');
    expect(html).toContain('task-table-context-meta');
    expect(html).not.toContain('task-detail-status-row');
    expect(html).not.toContain('zeus-object-toolbar');
    expect(source).toContain('任务列表空态必须保持轻量行');
    expect(css).toContain('任务页表格不留半屏空白最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-workbench:has\(\.task-list-empty\) > \.task-list-workbench\.task-list-protagonist\.task-list-empty\s*\{[\s\S]*block-size:\s*auto/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-workbench:has\(\.task-list-empty\) \.task-list-empty-row\s*\{[\s\S]*min-block-size:\s*44px/);
    expect(css).not.toMatch(/\.macos-ai-app \.task-management-navigation > \.task-list-workbench\.task-list-protagonist\.task-list-empty\s*\{[^}]*min-block-size:\s*min\(52vh,\s*520px\)/);
  });

  it('keeps the empty task table as a compact full-width row instead of reserving a split-detail parking lot', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot([])} initialMainNavTarget="tasks" />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const finalCss = css.slice(css.indexOf('任务页多场景原型高还原最终覆盖'));

    expect(html).toContain('<strong>还没有任务</strong>');
    expect(css).toContain('任务页多场景原型高还原最终覆盖');
    expect(finalCss).toMatch(/\.macos-ai-app \.task-table-workbench:has\(\.task-list-empty\)\s*\{[\s\S]*grid-template-rows:\s*auto auto auto/);
    expect(finalCss).toMatch(/\.macos-ai-app \.task-table-workbench:has\(\.task-list-empty\) > \.task-list-workbench\.task-list-protagonist\.task-list-empty\s*\{[\s\S]*inline-size:\s*100%/);
    expect(finalCss).not.toContain('grid-template-rows: auto minmax(320px, 1fr)');
    expect(finalCss).not.toContain('min-block-size: 320px');
    expect(finalCss).not.toMatch(/\.macos-ai-app \.task-management-navigation:has\(\.task-list-empty\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(320px,\s*420px\) minmax\(0,\s*720px\)/);
  });

  it('turns the empty task table into a purposeful compact state instead of a crude blank banner', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot([])} initialMainNavTarget="tasks" />);
    const source = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const finalCss = css.slice(css.indexOf('任务页多场景原型高还原最终覆盖'));
    const compactCss = finalCss.replace(/\s+/g, ' ');

    expect(html).toContain('task-list-empty-row task-empty-state');
    expect(html).toContain('task-empty-state-mark');
    expect(html).toContain('用“新任务”创建第一条研发任务；创建后会显示状态、AI 执行入口、证据和更新时间。');
    expect(html).not.toContain('task-empty-state-action-rail');
    expect(html).not.toContain('task-empty-state-primary-action');
    expect(html).not.toContain('task-empty-state-secondary-action');
    expect(html).not.toContain('查看项目代码');
    expect((html.match(/>新任务</g) ?? []).length).toBe(1);
    expect(html).not.toContain('task-empty-state-outcome-grid');
    expect(html).toContain('状态 / 下一步');
    expect(html).toContain('AI 执行');
    expect(html).toContain('证据');
    expect(source).toContain('visual thesis: 空任务态只说明下一步');
    expect(css).toContain('任务页多场景原型高还原最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app \.task-table-workbench:has\(\.task-empty-state\) > \.task-list-workbench\.task-list-protagonist\.task-list-empty\s*\{[^}]*align-content:\s*start/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-list-empty-row\.task-empty-state\s*\{[^}]*inline-size:\s*100%[^}]*max-inline-size:\s*none[^}]*min-block-size:\s*96px/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-list-empty-row\.task-empty-state\s*\{[^}]*grid-template-areas:\s*'copy'/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-list-empty-row\.task-empty-state\s*\{[^}]*background:\s*transparent/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-list-empty-row\.task-empty-state\s*\{[^}]*border:\s*0/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-empty-state-mark\s*\{[^}]*display:\s*none/);
  });

  it('keeps task list status metadata as quiet inline text instead of pill badges', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const marker = '任务列表状态元信息低噪音最终覆盖';
    const start = css.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);
    const finalCss = css.slice(start);
    const metaBlock = finalCss.match(/\.macos-ai-app \.task-list-meta\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const statusBlock = finalCss.match(/\.macos-ai-app \.task-list-meta span\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(metaBlock).toContain('align-items: baseline');
    expect(metaBlock).toContain('gap: 6px');
    expect(metaBlock).toContain('justify-items: end');
    expect(statusBlock).toContain('background: transparent');
    expect(statusBlock).toContain('border: 0');
    expect(statusBlock).toContain('border-radius: 0');
    expect(statusBlock).toContain('padding: 0');
    expect(statusBlock).not.toContain('999px');
  });

  it('keeps the selected task detail status as quiet text instead of a pill badge', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const marker = '任务详情状态低噪音最终覆盖';
    const start = css.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);
    const finalCss = css.slice(start);
    const statusBlock = finalCss.match(/\.macos-ai-app \.task-management-status-pill\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(statusBlock).toContain('background: transparent');
    expect(statusBlock).toContain('border: 0');
    expect(statusBlock).toContain('border-radius: 0');
    expect(statusBlock).toContain('padding: 0');
    expect(statusBlock).toContain('font-size: 12px');
    expect(statusBlock).not.toContain('999px');
    expect(statusBlock).not.toContain('--zeus-status-pill-bg');
  });

  it('normalizes task filters into one compact table toolbar without an explicit filter button', () => {
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
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('task-filter-workbench');
    expect(html).toContain('task-filter-search');
    expect(html).toContain('task-table-primary-toolbar');
    expect(html).toContain('task-table-view-toolbar');
    expect(html).toContain('task-table-context-meta');
    expect(html).toContain('task-table-new-task-button');
    expect(html).not.toContain('task-table-compact-toolbar');
    expect(html).not.toContain('task-filter-submit');
    expect(html).not.toContain('>筛选<');
    expect(source).not.toContain('className="pane-toolbar task-toolbar"');
    expect(css).toContain('任务页多场景原型高还原最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-primary-toolbar\s*\{[\s\S]*grid-template-columns:\s*max-content minmax\(260px,\s*1fr\) auto auto/);
  });

  it('keeps task toolbar controls above the hidden titlebar drag strip so hover and click targets match the visible controls', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('任务页多场景原型高还原最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-primary-toolbar,\n\.macos-ai-app \.task-table-view-toolbar\s*\{[\s\S]*position:\s*relative/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-primary-toolbar,\n\.macos-ai-app \.task-table-view-toolbar\s*\{[\s\S]*z-index:\s*31/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-primary-toolbar,\n\.macos-ai-app \.task-table-view-toolbar\s*\{[\s\S]*-webkit-app-region:\s*no-drag/);
    expect(css).toMatch(/\.macos-ai-app :where\(\.task-table-primary-toolbar,\s*\.task-table-view-toolbar\) :where\(input,\s*select,\s*button\)\s*\{[\s\S]*pointer-events:\s*auto/);
  });

  it('keeps compact task toolbar dropdowns free of the oversized search header chrome', () => {
    const html = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus"
        tasks={[
          {
            id: 'task_real',
            projectId: 'project_real',
            taskCode: 'ZEU-000001',
            title: '修复任务页下拉',
            status: 'ready',
            tags: [],
          },
        ]}
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="updatedAt"
        statusOptions={['', 'ready', 'running', 'completed']}
        sortOptions={['updatedAt', 'title']}
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { available: false, reason: '未配置' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        creatingTaskBusy={false}
        activeProjectId="project_real"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const selectSource = readFileSync(new URL('../src/renderer/ZeusSelect.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(taskSource).toContain('searchable={false}');
    expect(selectSource).toContain('const searchable');
    expect(html).not.toContain('zeus-select-search-row');
    expect(html).not.toContain('搜索选项');
    expect(css).toContain('任务工具栏紧凑下拉最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-view-toolbar \.zeus-select-popover\s*\{[\s\S]*min-inline-size:\s*max\(100%,\s*210px\)/);
  });

  it('removes decorative frame lines from the task table so the task page reads as an open workbench', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('任务页开放表格去装饰线最终覆盖');
    const tableWorkbenchBlock = css.match(/\.macos-ai-app \.task-table-workbench\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const listWorkbenchBlock = css.match(/\.macos-ai-app \.task-table-workbench > \.task-list-workbench\.task-list-protagonist\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const tableHeaderBlock = css.match(/\.macos-ai-app \.task-table-header\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const tableRowBlock = css.match(/\.macos-ai-app \.task-table-row\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(tableWorkbenchBlock).toContain('background: transparent');
    expect(tableWorkbenchBlock).toContain('border: 0');
    expect(tableWorkbenchBlock).toContain('border-radius: 0');
    expect(tableWorkbenchBlock).toContain('box-shadow: none');
    expect(listWorkbenchBlock).toContain('border: 0');
    expect(listWorkbenchBlock).toContain('border-radius: 0');
    expect(tableHeaderBlock).toContain('border-block-end: 0');
    expect(tableRowBlock).toContain('border-block-end: 0');
  });

  it('keeps task row selection as a quiet fill instead of drawing a blue outline around the row', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('任务行选中态去蓝框最终覆盖');
    const interactiveRowBlock = css.match(/\.macos-ai-app \.task-table-row:not\(\.selected\):hover,\n\.macos-ai-app \.task-table-row:not\(\.selected\):focus-visible\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const selectedRowBlock = css.match(/\.macos-ai-app \.task-table-row\.selected\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const focusRowBlock = css.match(/\.macos-ai-app \.task-table-row:focus-visible\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const rowBaseBlock = css.match(/\.macos-ai-app \.task-table-row\s*\{[\s\S]*?\}/g)?.at(-1) ?? '';

    expect(rowBaseBlock).toContain('cursor: pointer');
    expect(interactiveRowBlock).toContain('background: var(--zeus-source-list-hover)');
    expect(interactiveRowBlock).toContain('box-shadow: inset 0 0 0 1px var(--zeus-task-row-focus-line)');
    expect(interactiveRowBlock).not.toContain('var(--zeus-product-accent)');
    expect(selectedRowBlock).toContain('box-shadow: none');
    expect(selectedRowBlock).not.toContain('var(--zeus-product-accent)');
    expect(focusRowBlock).toContain('outline: 0');
    expect(focusRowBlock).toContain('box-shadow: inset 0 0 0 1px var(--zeus-task-row-focus-line)');
  });

  it('does not pin a selected gray background to the first task before the drawer is opened', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_first',
            projectId: 'project_real',
            title: '分析当前项目结构',
            status: 'running',
          },
          {
            id: 'task_second',
            projectId: 'project_real',
            title: '重构任务页 hover',
            status: 'ready',
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).not.toContain('task-list-row selected task-table-row');
    expect(html).toMatch(/class="task-list-row task-table-row"[^>]*aria-selected="false"[^>]*aria-label="打开任务详情：分析当前项目结构"[^>]*tabindex="0"/);
    expect(html).toMatch(/class="task-list-row task-table-row"[^>]*aria-selected="false"[^>]*aria-label="打开任务详情：重构任务页 hover"[^>]*tabindex="-1"/);
    expect(css).toContain('任务行 hover 与默认选中解耦最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-row:not\(\.selected\):hover,[\s\S]*background:\s*var\(--zeus-source-list-hover\)/);
  });

  it('keeps new task as the only high-weight toolbar command instead of a loose button rail', () => {
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
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('task-filter-actions');
    expect(css).not.toContain('task-filter-actions');
    expect(html).not.toContain('task-filter-command-rail');
    expect(source).not.toContain('loadFilteredTasks');
    expect(html).toContain('task-table-new-task-button');
    expect(css).toContain('任务页去 HERO 化紧凑工具栏最终覆盖');
  });

  it('opens a create task modal before creating the real task and keeps the success drawer feedback', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const helperStart = source.indexOf('async function createProjectTaskFromDraft');
    const helperEnd = source.indexOf('async function updateTaskStatus');
    const helperBody = source.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(source).toContain('function openTaskCreateModal');
    expect(source).toContain('function closeTaskCreateModal');
    expect(source).toContain('async function submitTaskCreateModal');
    expect(source).toContain('onCreateTask={openTaskCreateModal}');
    expect(source).not.toContain('onCreateTask={createTaskFromTaskToolbar}');
    expect(source).not.toContain('async function createTaskFromTaskToolbar');
    expect(source).toContain('taskCreateModalOpen');
    expect(source).toContain('taskCreateForm');
    expect(source).toContain('taskCreateError');
    expect(helperBody).toContain('const previousTaskIds = new Set(snapshot.tasks.map((task) => task.id));');
    expect(helperBody).toMatch(/const createdTask = selectCreatedProjectTask\(nextSnapshot,\s*previousTaskIds,\s*activeProjectId\)/);
    expect(helperBody).toContain("setTaskSearchQuery('')");
    expect(helperBody).toContain("setTaskStatusFilter('')");
    expect(helperBody).toContain("setTaskTagFilter('')");
    expect(helperBody).toContain('setTaskDetail(createdTask)');
    expect(helperBody).toContain('setTaskDrawerTaskId(createdTask.id)');
    expect(helperBody).toMatch(/setTaskEditForm\(\{\s*title: createdTask\.title,/);
  });

  it('defines a native accessible task create modal instead of reusing the right-side drawer or a giraffe form', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(appSource).toContain('task-create-modal');
    expect(appSource).toContain('role="dialog"');
    expect(appSource).toContain('aria-modal="true"');
    expect(appSource).toContain('task-create-title-input');
    expect(appSource).toContain('task-create-description-input');
    expect(appSource).toContain('task-create-tags-input');
    expect(appSource).toContain('task-create-attachment-picker');
    expect(appSource).toContain('TaskAttachmentPreviewList');
    expect(appSource).toContain('type TaskCreateFormState = { title: string; description: string; tags: string; attachments: TaskCreateAttachment[] }');
    expect(appSource).toContain('attachments={props.form.attachments}');
    expect(appSource).toContain('function mergeTaskCreateAttachments');
    expect(appSource).toContain('onLoadTaskAttachmentPreview');
    expect(appSource).toContain('onOpenTaskAttachment');
    expect(appSource).not.toContain('conversationComposerAttachments');
    expect(appSource).not.toContain('conversation-composer-attachments');
    expect(appSource).toContain('mode="editable"');
    expect(appSource).toContain('taskCreatePreviewAttachment');
    expect(appSource).toContain('taskCreatePreviewUnavailable');
    expect(appSource).toContain('taskCreateAttachmentAddedStatus');
    expect(appSource).toContain('props.onChooseAttachments');
    expect(appSource).toContain('taskCreateAttachmentPickerFailed');
    expect(appSource).toContain('taskCreateImageAttachment');
    expect(appSource).toContain('taskCreateFileAttachment');
    expect(appSource).toContain('task-create-project-source');
    expect(appSource).toContain('taskCreateTitleRequired');
    expect(appSource).toContain('taskCreateSubmit');
    expect(appSource).toContain('taskCreateCancel');
    expect(appSource).toContain("event.key === 'Escape'");
    expect(appSource).toContain('function trapTaskCreateModalFocus');
    expect(appSource).toContain("event.key !== 'Tab'");
    expect(appSource).toContain('querySelectorAll<HTMLElement>');
    expect(appSource).toContain('taskCreateReturnFocusRef.current?.focus()');
    expect(appSource).not.toContain('project-task-create-modal');
    expect(appSource).not.toContain('selectedCreateOwnerUserId');
    expect(appSource).not.toContain('createModalRichEditorReady');
    expect(css).toContain('任务创建弹窗最终覆盖');
    expect(appSource).toContain('task-create-modal-backdrop');
    expect(appSource).toContain('function handleTaskCreateBackdropPointerDown');
    expect(appSource).toContain('event.currentTarget !== event.target');
    expect(appSource).toContain('props.onClose();');
    expect(appSource).toContain('const modalSurface = (');
    expect(appSource).toContain('createPortal(modalSurface, document.body)');
    expect(css).toMatch(/\.task-create-modal-portal-root\.macos-ai-app\s*\{[\s\S]*inset:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.task-create-modal-backdrop\s*\{[\s\S]*background:\s*oklch\(20% 0\.004 255 \/ 0\.025\)/);
    expect(css).toMatch(/\.macos-ai-app \.task-create-modal\s*\{[\s\S]*inline-size:\s*min\(640px,\s*calc\(100vw - 32px\)\)/);
    expect(css).toContain('task-attachment-filmstrip');
    expect(css).toContain('task-attachment-zoom-dialog');
    expect(css).toMatch(/\.macos-ai-app \.task-attachment-filmstrip\s*\{[\s\S]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.macos-ai-app \.task-attachment-film-item\s*\{[\s\S]*flex:\s*0 0 88px/);
    expect(css).toMatch(/\.macos-ai-app \.task-attachment-file-button\s*\{[\s\S]*min-block-size:\s*38px/);
    expect(css).not.toMatch(/\.macos-ai-app \.task-attachment-film-item\s*\{[\s\S]*grid-template-rows:\s*72px/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.macos-ai-app \.task-create-modal/);
  });

  it('renders the create task dialog with a light dismissible backdrop and lets users paste images or files into the task request', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const portalBlock = css.match(/\.task-create-modal-portal-root\.macos-ai-app\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? '';
    const backdropBlock = css.match(/\.macos-ai-app \.task-create-modal-backdrop\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? '';
    const modalBlock = css.match(/\.macos-ai-app \.task-create-modal\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? '';

    expect(appSource).toContain('task-create-modal-backdrop');
    expect(appSource).toContain('handleTaskCreateBackdropPointerDown');
    expect(appSource).toContain('onPointerDown={handleTaskCreateBackdropPointerDown}');
    expect(appSource).toContain('event.currentTarget !== event.target');
    expect(appSource).toContain('props.busy');
    expect(css).toContain('task-create-modal-backdrop');
    expect(portalBlock).toContain('position: fixed;');
    expect(portalBlock).toContain('inset: 0;');
    expect(portalBlock).toContain('background: transparent;');
    expect(portalBlock).not.toContain('background: oklch(99.7% 0.001 255);');
    expect(backdropBlock).toContain('position: absolute;');
    expect(backdropBlock).toContain('inset: 0;');
    expect(backdropBlock).toContain('display: grid;');
    expect(backdropBlock).toContain('place-items: center;');
    expect(backdropBlock).toContain('background: oklch(20% 0.004 255 / 0.025);');
    expect(backdropBlock).not.toContain('backdrop-filter');
    expect(modalBlock).toContain('inline-size: min(640px, calc(100vw - 32px));');
    expect(modalBlock).toContain('background: var(--zeus-product-panel);');
    expect(modalBlock).toContain('pointer-events: auto;');
    expect(modalBlock).not.toContain('backdrop-filter');
    expect(css).not.toContain('--zeus-task-create-veil-bg');
    expect(css).not.toContain('--zeus-task-create-sheet-bg');
    expect(css).not.toContain('--zeus-task-create-chrome-bg');
    expect(css).not.toContain('--zeus-task-create-control-bg');
    expect(css).not.toContain('background: oklch(22% 0.006 255 / 0.18);');
    expect(appSource).toContain('function handleTaskCreateClipboardPaste');
    expect(appSource).toContain('onPaste={handleTaskCreateClipboardPaste}');
    expect(appSource).toContain('event.clipboardData.files');
    expect(appSource).toContain('event.clipboardData.items');
    expect(appSource).toContain("safelyReadClipboardData(event.clipboardData, 'text/plain')");
    expect(appSource).toContain('event.preventDefault();');
    expect(appSource).toContain('item.getAsFile()');
    expect(appSource).toContain('file.arrayBuffer()');
    expect(appSource).toContain('props.onPasteAttachments');
    expect(appSource).toContain('props.onPasteClipboardAttachments');
    expect(appSource).toContain('const didPasteClipboardAttachments = await props.onPasteClipboardAttachments();');
    expect(appSource).toContain('event.preventDefault();\n    const didPasteClipboardAttachments = await props.onPasteClipboardAttachments();\n    if (didPasteClipboardAttachments) return;');
    expect(appSource).toContain('pasteShortcutFallbackTokenRef');
    expect(appSource).toContain('function handleTaskCreatePasteShortcutFallback');
    expect(appSource).toContain("event.key.toLowerCase() !== 'v'");
    expect(appSource).toContain('!event.metaKey && !event.ctrlKey');
    expect(appSource).toContain('window.setTimeout');
    expect(appSource).toMatch(/props\s*\.onPasteClipboardAttachments\(\)\s*\.then/u);
    expect(appSource).toContain('pasteShortcutFallbackTokenRef.current += 1');
    expect(appSource).toContain('insertTaskCreatePlainTextPaste');
    expect(appSource).toContain('resolveTaskCreatePasteField');
    expect(appSource).not.toContain('shouldReadNativeTaskClipboardAttachments(event.clipboardData)');
    expect(appSource).toContain('async function pasteTaskClipboardAttachments');
    expect(appSource).toContain('props.onSaveTaskClipboardAttachments');
    expect(appSource).toContain('onPasteClipboardAttachments={() => pasteTaskClipboardAttachments()}');
    expect(appSource).toContain('async function pasteTaskCreateAttachments');
    expect(appSource).toContain('props.onSaveTaskPastedAttachments');
  });

  it('matches the prototype create task dialog field order, helper copy, and compact body spacing', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const finalCss = css.slice(css.indexOf('任务页多场景原型高还原最终覆盖'));
    const compactCss = finalCss.replace(/\s+/g, ' ');

    expect(appSource).toContain("taskCreateTitlePlaceholder: '例如：修复任务表格列可见性'");
    expect(appSource).toContain("taskCreateTitleHelp: '必填，保存后作为任务列表主标题。'");
    expect(appSource).toContain("taskCreateDescriptionLabel: '任务要求 / 意图'");
    expect(appSource).toContain('描述期望行为、验收口径、必要上下文。支持粘贴用户原始要求，不在这里启动 AI。');
    expect(appSource).toContain('task-create-field-help');
    expect(appSource).toContain('task-create-two-column-row');
    expect(appSource).toContain('task-create-priority-field');
    expect(appSource).toContain("taskCreatePriorityDefault: 'normal'");
    expect(appSource).toContain('当前项目');
    expect(appSource).toContain('手动创建');
    expect(appSource).toContain('task-create-runtime-notice');
    expect(appSource).toContain('runtimeAiAvailable');
    expect(appSource).toContain('AI Runtime 未配置时仍可创建任务');
    expect(compactCss).toMatch(/\.macos-ai-app \.task-create-modal-body\s*\{[^}]*gap:\s*10px[^}]*padding:\s*14px/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-create-two-column-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*1fr\)/);
    expect(compactCss).toMatch(/\.macos-ai-app \.task-create-runtime-notice\s*\{[^}]*background:\s*color-mix\(in oklch,\s*var\(--zeus-warning-bg/);
  });

  it('renders the task detail drawer as a polished product sheet with summary rows and a sticky action rail', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawerContent
        task={{
          id: 'task_backend',
          projectId: 'project_real',
          title: '修复 API Bug',
          description: '把任务推进动作收进抽屉。',
          status: 'ready',
          tags: ['bug'],
          templateId: 'template_fix',
        }}
        events={[
          {
            id: 'event_real',
            taskId: 'task_backend',
            eventType: 'task.created',
            title: '任务已创建',
            createdAt: '2026-06-24T06:00:00.000Z',
          },
        ]}
        copy={{
          requestTitle: '任务描述',
          noRequest: '暂无描述',
          eventsTitle: '事件',
          noEvents: '暂无事件',
          runTask: '推送到模型',
          pauseRuntime: '暂停 Runtime',
          continueRuntime: '继续 Runtime',
          retryTask: '重试任务',
          markComplete: '标记完成',
          cancelTask: '取消任务',
          primaryActionsTitle: '主操作',
          secondaryActionsTitle: '次操作',
          dangerActionsTitle: '危险操作',
          metadataTitle: '任务事实',
          projectLabel: '项目',
          templateLabel: '模板',
          aiCliLabel: 'AI CLI',
          aiDetected: '已检测',
          aiNotConfigured: '未配置',
          cancelConfirm: '确认取消任务？',
        }}
        statusLabels={{ ready: '就绪', running: '运行中', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败', draft: '草稿', '': '全部' }}
        eventTypeLabels={{ 'task.created': '任务已创建' }}
        runtimeAiAvailable={true}
        busy={false}
        onRuntimeAction={() => undefined}
        onMarkComplete={() => undefined}
        onLoadAttachmentPreview={() => Promise.resolve(null)}
        controlBusyProps={() => ({})}
      />,
    );
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('task-detail-drawer-shell');
    expect(html).toContain('task-detail-summary-row');
    expect(html).toContain('task-detail-request-text');
    expect(html).toContain('task-detail-event-row');
    expect(html).toContain('task-detail-action-rail');
    expect(html).toContain('task-detail-action-row task-detail-action-row-primary');
    expect(html).toContain('task-detail-action-copy');
    expect(css).toContain('任务详情抽屉产品化最终覆盖');
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.task-drawer\s*\{[\s\S]*--zeus-drawer-inline-size:\s*min\(720px,/);
    expect(css).toMatch(/\.macos-ai-app \.task-detail-action-rail\s*\{[\s\S]*position:\s*sticky/);
    expect(css).toMatch(/\.macos-ai-app \.task-detail-summary-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  });

  it('renders drawer identity and AI facts with task code, next action, source, updated time, and runtime command', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawerContent
        task={{
          id: 'task_raw_internal_id',
          projectId: 'project_raw_internal_id',
          taskCode: 'ZEU-000001',
          title: '分析任务字段',
          description: '让任务页成为个人 AI 工作队列',
          status: 'waiting_confirmation',
          priority: 'normal',
          tags: ['ai-native'],
          createdFrom: 'runtime_session',
          sourceContextJson: JSON.stringify({ sessionId: 'session_real' }),
          createdAt: '2026-06-25T01:00:00.000Z',
          updatedAt: '2026-06-25T02:00:00.000Z',
        }}
        events={[]}
        copy={createTaskDetailDrawerCopy()}
        statusLabels={{ ready: '待开始', running: '运行中', waiting_confirmation: '等待确认', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败', draft: '草稿', '': '全部' }}
        eventTypeLabels={{}}
        runtimeAiAvailable={true}
        runtimeSessions={[
          {
            id: 'session_real',
            projectId: 'project_raw_internal_id',
            taskId: 'task_raw_internal_id',
            command: 'codex',
            args: ['develop'],
            cwd: '/Users/david/hypha/zeus',
            status: 'running',
            startedAt: '2026-06-25T01:30:00.000Z',
          },
        ]}
        busy={false}
        onRuntimeAction={() => undefined}
        onMarkComplete={() => undefined}
        onLoadAttachmentPreview={() => Promise.resolve(null)}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('task-detail-ai-facts');
    expect(html).toContain('ZEU-000001');
    expect(html).toContain('分析任务字段');
    expect(html).toContain('需要我确认');
    expect(html).toContain('Runtime 会话');
    expect(html).toContain('最近事件');
    expect(html).toContain('暂无执行证据');
    expect(html).toContain('2026-06-25 10:00:00');
    expect(html).toContain('AI CLI 可用');
    expect(html).toContain('session_real');
    expect(html).toContain('codex develop');
    expect(html).toContain('运行中');
    expect(html).not.toContain('project_raw_internal_id');
    expect(html).not.toContain('task_raw_internal_id');
    expect(html).not.toContain('负责人');
    expect(html).not.toContain('处理人');
    expect(html).not.toContain('assignee');
    expect(html).not.toContain('owner');
    expect(html).not.toContain('SLA');
    expect(html).not.toContain('@我');
  });

  it('shows the latest event as drawer evidence instead of hiding execution proof below the fold', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawerContent
        task={{
          id: 'task_with_evidence',
          projectId: 'project_real',
          taskCode: 'ZEU-000006',
          title: '收敛任务抽屉证据',
          status: 'running',
          createdFrom: 'manual',
          updatedAt: '2026-06-25T02:00:00.000Z',
        }}
        events={[
          {
            id: 'event_started',
            taskId: 'task_with_evidence',
            eventType: 'task.started',
            title: 'Runtime 已启动',
            createdAt: '2026-06-25T02:10:00.000Z',
          },
        ]}
        copy={createTaskDetailDrawerCopy()}
        statusLabels={{ ready: '待开始', running: '运行中', waiting_confirmation: '等待确认', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败', draft: '草稿', '': '全部' }}
        eventTypeLabels={{ 'task.started': '任务运行' }}
        runtimeAiAvailable={true}
        runtimeSessions={[]}
        busy={false}
        onRuntimeAction={() => undefined}
        onMarkComplete={() => undefined}
        onLoadAttachmentPreview={() => Promise.resolve(null)}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('最近事件');
    expect(html).toContain('Runtime 已启动');
    expect(html).toContain('任务运行');
    expect(html).toContain('2026-06-25T02:10:00.000Z');
  });

  it('shows task create image and file attachments in the task detail drawer after creation', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawerContent
        task={{
          id: 'task_with_attachment',
          projectId: 'project_real',
          title: '分析截图里的问题',
          description: '',
          status: 'ready',
          createdFrom: 'user',
          sourceContextJson: JSON.stringify({
            path: '/Users/david/hypha/zeus',
            attachments: [
              { path: '/Users/david/Desktop/error.png', name: 'error.png', kind: 'image' },
              { path: '/Users/david/Desktop/context.txt', name: 'context.txt', kind: 'file' },
            ],
          }),
        }}
        events={[]}
        copy={createTaskDetailDrawerCopy()}
        statusLabels={{ ready: '待开始', running: '运行中', waiting_confirmation: '等待确认', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败', draft: '草稿', '': '全部' }}
        eventTypeLabels={{}}
        runtimeAiAvailable={false}
        busy={false}
        onRuntimeAction={() => undefined}
        onMarkComplete={() => undefined}
        onLoadAttachmentPreview={() => Promise.resolve(null)}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('task-detail-attachments');
    expect(html).toContain('task-attachment-filmstrip');
    expect(html).toContain('task-attachment-thumb-button');
    expect(html).toContain('放大预览附件');
    expect(html).not.toContain('file:///Users/david/Desktop/error.png');
    expect(html).toContain('data-attachment-preview-state="loading"');
    expect(html).toContain('task-attachment-zoom-dialog');
    expect(html).not.toContain('task-detail-attachment-row');
    expect(html).toContain('error.png');
    expect(html).toContain('/Users/david/Desktop/error.png');
    expect(html).toContain('context.txt');
    expect(html).toContain('/Users/david/Desktop/context.txt');
  });

  it('renders drawer AI facts as true unconfigured and no-session states without fabricating runtime work', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawerContent
        task={{
          id: 'task_without_runtime',
          projectId: 'project_real',
          taskCode: 'ZEU-000002',
          title: '等待 AI 配置',
          description: '没有真实 Runtime 会话时必须明确降级。',
          status: 'ready',
          priority: 'normal',
          tags: [],
          createdFrom: 'manual',
          sourceContextJson: JSON.stringify({ type: 'manual' }),
          createdAt: '2026-06-25T01:00:00.000Z',
          updatedAt: '2026-06-25T02:00:00.000Z',
        }}
        events={[]}
        copy={createTaskDetailDrawerCopy()}
        statusLabels={{ ready: '待开始', running: '运行中', waiting_confirmation: '等待确认', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败', draft: '草稿', '': '全部' }}
        eventTypeLabels={{}}
        runtimeAiAvailable={false}
        runtimeSessions={[]}
        busy={false}
        onRuntimeAction={() => undefined}
        onMarkComplete={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('AI 未配置');
    expect(html).toContain('未启动 Runtime 会话');
    expect(html).toContain('未记录运行命令');
    expect(html).not.toContain('AI 运行中');
    expect(html).not.toContain('codex');
  });

  it('keeps the app-server session action enabled when AI CLI is not configured', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawerContent
        task={{
          id: 'task_without_runtime_cli',
          projectId: 'project_real',
          taskCode: 'ZEU-000007',
          title: '先推送到模型',
          description: 'AI CLI 不可用时也要让 app-server 接住任务提示词。',
          status: 'ready',
          createdFrom: 'manual',
          sourceContextJson: JSON.stringify({ type: 'manual' }),
        }}
        events={[]}
        copy={createTaskDetailDrawerCopy()}
        statusLabels={{ ready: '待开始', running: '运行中', waiting_confirmation: '等待确认', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败', draft: '草稿', '': '全部' }}
        eventTypeLabels={{}}
        runtimeAiAvailable={false}
        runtimeSessions={[]}
        busy={false}
        onRuntimeAction={() => undefined}
        onMarkComplete={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    const primaryActionButton = html.match(/<button[^>]*class="task-detail-primary-action"[^>]*>推送到模型<\/button>/)?.[0] ?? '';
    expect(primaryActionButton).toContain('推送到模型');
    expect(primaryActionButton).not.toContain('disabled');
    expect(html).toContain('AI 未配置');
  });

  it('keeps drawer status accessible name aligned with the visible next action', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawerContent
        task={{
          id: 'task_accessibility',
          projectId: 'project_real',
          taskCode: 'ZEU-000003',
          title: '补齐抽屉可访问状态',
          status: 'waiting_confirmation',
          updatedAt: '2026-06-25T02:00:00.000Z',
        }}
        events={[]}
        copy={createTaskDetailDrawerCopy()}
        statusLabels={{ ready: '待开始', running: '运行中', waiting_confirmation: '等待确认', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败', draft: '草稿', '': '全部' }}
        eventTypeLabels={{}}
        runtimeAiAvailable={false}
        runtimeSessions={[]}
        busy={false}
        onRuntimeAction={() => undefined}
        onMarkComplete={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('aria-label="等待确认 · 需要我确认"');
  });

  it('renders English drawer facts without leaking Chinese fallback copy', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawerContent
        task={{
          id: 'task_english_facts',
          projectId: 'project_real',
          taskCode: 'ZEU-000004',
          title: 'Review drawer facts',
          status: 'waiting_confirmation',
          createdFrom: 'manual',
        }}
        events={[]}
        copy={createEnglishTaskDetailDrawerCopy()}
        statusLabels={{ ready: 'Ready', running: 'Running', waiting_confirmation: 'Waiting for confirmation', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed', draft: 'Draft', '': 'All' }}
        eventTypeLabels={{}}
        runtimeAiAvailable={false}
        runtimeSessions={[]}
        busy={false}
        onRuntimeAction={() => undefined}
        onMarkComplete={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('Waiting for confirmation · Needs my confirmation');
    expect(html).toContain('Manual');
    expect(html).toContain('Not recorded');
    expect(html).toContain('Runtime session not started');
    for (const leakedChinese of ['需要我确认', '手动创建', '未记录', '未启动 Runtime 会话']) {
      expect(html).not.toContain(leakedChinese);
    }
  });

  it('links drawer runtime facts by sourceContext session id and masks sensitive command arguments', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawerContent
        task={{
          id: 'task_source_context_session',
          projectId: 'project_real',
          taskCode: 'ZEU-000005',
          title: '从 Runtime 会话生成任务',
          status: 'running',
          createdFrom: 'runtime_session',
          sourceContextJson: JSON.stringify({ sessionId: 'session_from_context' }),
          updatedAt: '2026-06-25T02:00:00.000Z',
        }}
        events={[]}
        copy={createTaskDetailDrawerCopy()}
        statusLabels={{ ready: '待开始', running: '运行中', waiting_confirmation: '等待确认', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败', draft: '草稿', '': '全部' }}
        eventTypeLabels={{}}
        runtimeAiAvailable={true}
        runtimeSessions={[
          {
            id: 'session_from_context',
            projectId: 'project_real',
            command: 'codex',
            args: ['--token=secret-real-token', '--model', 'gpt-5'],
            cwd: '/Users/david/hypha/zeus',
            status: 'running',
            startedAt: '2026-06-25T01:30:00.000Z',
          },
        ]}
        busy={false}
        onRuntimeAction={() => undefined}
        onMarkComplete={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('session_from_context');
    expect(html).toContain('codex --token=*** --model gpt-5');
    expect(html).not.toContain('secret-real-token');
  });

  it('keeps internal project and task ids out of the visible task table cells', () => {
    const html = renderToStaticMarkup(
      <TaskWorkspace
        projectName="Zeus E2E"
        tasks={[
          {
            id: 'task_raw_internal_id',
            projectId: 'project_raw_internal_id',
            taskCode: 'ZEU-000321',
            taskSequence: 321,
            title: '修复任务页视觉',
            description: '不要再把内部 id 当成用户文案',
            status: 'ready',
            priority: 'normal',
            tags: [],
            createdFrom: 'manual',
            sourceContextJson: JSON.stringify({ type: 'manual' }),
            createdAt: '2026-06-25T01:00:00.000Z',
            updatedAt: '2026-06-25T02:00:00.000Z',
          },
        ]}
        selectedTaskId="task_raw_internal_id"
        searchQuery=""
        statusFilter=""
        tagFilter=""
        sortBy="title"
        statusOptions={['']}
        sortOptions={['title']}
        statusLabels={{ ready: '待开始', running: '运行中', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败', draft: '草稿', '': '全部' }}
        sortLabels={{ title: '标题', status: '状态', createdAt: '创建时间', updatedAt: '更新时间' }}
        copy={createTaskWorkspaceCopy()}
        runtime={{ aiCli: { available: false, reason: '未配置' }, telegram: { enabled: false, reason: '未配置' } }}
        runtimeSessions={[]}
        taskTableColumns={{ visibleColumnKeys: ['code', 'intent', 'project', 'updatedAt'], columnOrder: ['code', 'intent', 'project', 'updatedAt'] }}
        creatingTaskBusy={false}
        activeProjectId="project_raw_internal_id"
        onSearchChange={() => undefined}
        onStatusFilterChange={() => undefined}
        onTagFilterChange={() => undefined}
        onSortChange={() => undefined}
        onTaskTableColumnsChange={() => undefined}
        onCreateTask={() => undefined}
        onOpenTaskDetail={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('修复任务页视觉');
    expect(html).toContain('ZEU-000321');
    expect(html).toContain('Zeus E2E');
    expect(html).toContain('不要再把内部 id 当成用户文案');
    expect(html).not.toContain('project_raw_internal_id');
    expect(html).not.toContain('task_raw_internal_id');
  });

  it('replaces the task drawer system focus outline with a subtle product focus treatment', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('任务抽屉截图返修最终覆盖');
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\.task-drawer:focus-visible\s*\{[\s\S]*outline:\s*0/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app:has\(\.task-drawer\) \.workspace-drawer-backdrop\s*\{[\s\S]*background:\s*oklch\(20% 0\.004 255 \/ 0\.16\)/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\.task-drawer\s*\{[\s\S]*box-shadow:\s*-10px 0 30px/);
  });

  it('pins the task drawer to the right edge with native chrome instead of cutting through the toolbar', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('className="workspace-drawer-close-button"');
    expect(css).toContain('任务抽屉右侧 sheet 截图返修最终覆盖');
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app:has\(\.task-drawer\)\s*\{[\s\S]*--zeus-drawer-backdrop-inset-block:\s*0 0/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app:has\(\.task-drawer\)\s*\{[\s\S]*--zeus-drawer-inset-block:\s*0 0/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\.task-drawer\s*\{[\s\S]*inline-size:\s*min\(720px,\s*calc\(100vw - 236px\)\)/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\.task-drawer \.workspace-drawer-close-button\s*\{[\s\S]*border:\s*0/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\.task-drawer \.workspace-drawer-chrome strong\s*\{[\s\S]*font-size:\s*13px/);
  });

  it('removes the duplicate task drawer title strip and excessive internal divider lines', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('任务抽屉无标题条与少线条最终覆盖');
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\.task-drawer \.workspace-drawer-chrome\s*\{[\s\S]*position:\s*absolute/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\.task-drawer \.workspace-drawer-chrome strong\s*\{[\s\S]*clip:\s*rect\(0 0 0 0\)/);
    expect(css).toMatch(/\.macos-ai-app \.task-detail-drawer-header\.task-detail-summary-row\s*\{[\s\S]*border-block-end:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.task-detail-summary-grid\.task-detail-ai-facts\s*\{[\s\S]*border-block-end:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.task-detail-summary-grid \.task-detail-summary-row\s*\{[\s\S]*border-inline-end:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.task-detail-action-rail\s*\{[\s\S]*border-block-start:\s*0/);
  });

  it('marks every task row as the open-detail action and removes first-view task progression buttons', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot([
          {
            id: 'task_backend',
            projectId: 'project_real',
            title: '修复 API Bug',
            description: '详情只能进抽屉',
            status: 'ready',
            tags: ['backend', 'bug'],
          },
        ])}
        initialMainNavTarget="tasks"
      />,
    );

    expect(html).toContain('data-task-row-action="open-detail"');
    expect(html).toContain('aria-label="打开任务详情：修复 API Bug"');
    expect(html).not.toContain('运行任务');
    expect(html).not.toContain('暂停 Runtime');
    expect(html).not.toContain('继续 Runtime');
    expect(html).not.toContain('标记完成');
    expect(html).not.toContain('取消任务');
    expect(html).not.toContain('task-detail-drawer-pane');
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
    expect(html).toContain('task-table-workbench');
    expect(html).not.toContain('task-management-command-dock');
    expect(html).not.toContain('task-management-compose-row');
    expect(html).not.toContain('task-management-context-rail');
    expect(html).not.toContain('要求后续变更');
    expect(html).not.toContain('保存要求');
    expect(html).not.toContain('conversation-action-bar');
    expect(html).not.toContain('conversation-composer');
    expect(html).not.toContain('conversation-drawer-tabs');
    expect(html).not.toContain('任务标题');
    expect(html).not.toContain('确认删除任务');
  });

  it('resolves a created app-server task conversation to the project sessions view', () => {
    const snapshot = createSnapshot([
      {
        id: 'task_real',
        projectId: 'project_real',
        title: '分析当前项目结构',
        description: '真实任务',
        status: 'running',
      },
    ]);
    const task = snapshot.tasks[0]!;
    const conversation: GraphConversationHistoryItem = {
      id: 'conversation_real',
      projectId: 'project_real',
      taskId: task.id,
      sessionId: 'session_real',
      title: '任务会话：分析当前项目结构',
      summary: null,
      status: 'running',
      createdAt: '2026-07-09T05:51:27.347Z',
      updatedAt: '2026-07-09T05:51:27.347Z',
      archived: false,
      messages: [],
    };

    const normalized = normalizeTaskRuntimeControlHandlerResult({ snapshot, task, conversation });
    const navigation = resolveTaskRuntimeConversationNavigation('run', normalized);

    expect(navigation).toEqual({
      task,
      mainNavTarget: 'conversations',
      projectSection: 'sessions',
      hash: '#project-sessions',
    });
  });

  it('routes a task run action to the task model push modal instead of the old conversation chooser', () => {
    const snapshot = createSnapshot([
      {
        id: 'task_real',
        projectId: 'project_real',
        title: '分析当前项目结构',
        description: '真实任务',
        status: 'ready',
      },
    ]);
    const task = snapshot.tasks[0]!;
    const navigation = resolveTaskRuntimeConversationNavigation('run', normalizeTaskRuntimeControlHandlerResult({ snapshot, task }));

    expect(resolveTaskRuntimeActionRoute).toBeTypeOf('function');
    expect(resolveTaskRuntimeActionRoute('run')).toBe('model_push');
    for (const action of ['pause', 'continue', 'cancel', 'retry'] as const) {
      expect(resolveTaskRuntimeActionRoute(action)).toBe('runtime_api');
    }
    expect(navigation).toEqual({
      task,
      mainNavTarget: 'conversations',
      projectSection: 'sessions',
      hash: '#project-sessions',
    });
  });

  it('defaults task model push to read-only, remembers only a valid project selection, and falls back with new capabilities', () => {
    const capabilities = {
      generationId: 'generation-1',
      initializedAt: '2026-07-17T00:00:00.000Z',
      projectId: 'project_real',
      preferredModel: 'gpt-5.4',
      models: [
        { id: 'gpt-5.4', model: 'gpt-5.4', supportedReasoningEfforts: ['medium', 'high'], defaultReasoningEffort: 'medium' },
        { id: 'gpt-5.5', model: 'gpt-5.5', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high' },
      ],
    };
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(resolveTaskModelPushInitialForm(capabilities, null)).toMatchObject({ model: 'gpt-5.4', effort: 'medium', workMode: 'default', permissionMode: 'read-only' });
    writeTaskModelPushPreferences(storage, 'project_real', { model: 'gpt-5.5', effort: 'high', workMode: 'plan', permissionMode: 'full-access', supplementalInfo: '不应写入记忆' });
    const remembered = readTaskModelPushPreferences(storage, 'project_real');
    expect(remembered).toEqual({ model: 'gpt-5.5', effort: 'high', workMode: 'plan', permissionMode: 'full-access' });
    expect(resolveTaskModelPushInitialForm(capabilities, remembered)).toMatchObject({ model: 'gpt-5.5', effort: 'high', workMode: 'plan', permissionMode: 'full-access', supplementalInfo: '' });
    expect(resolveTaskModelPushInitialForm({ ...capabilities, models: capabilities.models.slice(0, 1) }, remembered)).toMatchObject({ model: 'gpt-5.4', effort: 'medium' });
  });

  it('renders the task model push composer with model settings, canonical content, supplement, and the full attachment list', () => {
    const task = completeTaskRecord(
      {
        id: 'task_push',
        projectId: 'project_real',
        title: '推送真实任务',
        description: '发送任务内容与附件',
        status: 'ready',
        sourceContextJson: JSON.stringify({
          attachments: [
            { path: '/tmp/evidence.png', name: 'evidence.png', kind: 'image', mimeType: 'image/png' },
            { path: '/tmp/notes.md', name: 'notes.md', kind: 'file', mimeType: 'text/markdown' },
          ],
        }),
      },
      0,
    );
    const markup = renderToStaticMarkup(
      <TaskModelPushModal
        open
        language="zh-CN"
        task={task}
        projectName="Zeus"
        capabilities={{
          generationId: 'generation-1',
          initializedAt: '2026-07-17T00:00:00.000Z',
          projectId: 'project_real',
          preferredModel: 'gpt-5.4',
          models: [{ id: 'gpt-5.4', model: 'gpt-5.4', supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }],
        }}
        form={{ model: 'gpt-5.4', effort: 'medium', workMode: 'default', permissionMode: 'read-only', supplementalInfo: '' }}
        status="ready"
        error={null}
        onChange={() => undefined}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(markup).toContain('推送到模型');
    expect(markup).toContain('模型等级');
    expect(markup).toContain('补充信息（可选）');
    expect(markup).toContain('推送真实任务');
    expect(markup).toContain('evidence.png');
    expect(markup).toContain('notes.md');
    expect(markup).toContain('value="read-only" selected');
  });
});
