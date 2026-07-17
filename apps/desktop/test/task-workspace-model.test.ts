import { describe, expect, it } from 'vitest';
import {
  createTaskWorkspaceViewModel,
  filterVisibleTasks,
  findLinkedRuntimeSession,
  formatRuntimeCommandPreview,
  formatTaskNextAction,
  formatTaskSource,
  formatTaskUpdatedAt,
  moveTaskTableColumn,
  normalizeTaskTableColumnPreferences,
  setTaskTableColumnWidth,
  toggleTaskTableColumn,
} from '../src/renderer/task/taskWorkspaceModel.js';
import type { AiRuntimeSession, TaskRecord } from '../src/renderer/apiClient.js';

const tasks: TaskRecord[] = [
  {
    id: 'task_beta',
    projectId: 'project_real',
    taskCode: 'ZEU-000003',
    taskSequence: 3,
    title: '修复运行按钮误点',
    description: '按钮全部收进详情抽屉',
    status: 'ready',
    priority: 'normal',
    tags: ['ux', 'bug'],
    createdFrom: 'manual',
    sourceContextJson: JSON.stringify({ type: 'manual', path: '/Users/david/hypha/zeus/apps/desktop/src/renderer/task/TaskWorkspace.tsx' }),
    createdAt: '2026-06-25T00:30:00.000Z',
    updatedAt: '2026-06-25T03:00:00.000Z',
  },
  {
    id: 'task_alpha',
    projectId: 'project_real',
    taskCode: 'ZEU-000002',
    taskSequence: 2,
    title: '重构任务页 HERO',
    description: '首屏只保留任务表格',
    status: 'running',
    priority: 'high',
    tags: ['ui'],
    createdFrom: 'graph_view',
    sourceContextJson: JSON.stringify({ type: 'graph_view', graphViewId: 'graph-view-real' }),
    createdAt: '2026-06-25T00:20:00.000Z',
    updatedAt: '2026-06-25T02:00:00.000Z',
  },
  {
    id: 'task_gamma',
    projectId: 'project_real',
    taskCode: 'ZEU-000001',
    taskSequence: 1,
    title: '补充空态',
    description: '筛选无结果保持紧凑行',
    status: 'completed',
    priority: 'low',
    tags: ['empty'],
    createdFrom: 'graph_node',
    sourceContextJson: JSON.stringify({ type: 'graph_node', nodeId: 'graph-node-real' }),
    createdAt: '2026-06-25T00:10:00.000Z',
    updatedAt: '2026-06-25T01:00:00.000Z',
  },
];

describe('task workspace model', () => {
  it('applies query, status, tag and sort immediately without a submit step', () => {
    const visible = filterVisibleTasks(tasks, '任务页', 'running', 'ui', 'title');

    expect(visible.map((task) => task.id)).toEqual(['task_alpha']);
  });

  it('keeps an explicit no-results state separate from a truly empty task list', () => {
    const empty = createTaskWorkspaceViewModel({
      tasks: [],
      query: '',
      status: '',
      tag: '',
      sortBy: 'title',
    });
    const noResults = createTaskWorkspaceViewModel({
      tasks,
      query: '不存在的关键词',
      status: '',
      tag: '',
      sortBy: 'title',
    });

    expect(empty.emptyState).toBe('empty');
    expect(empty.visibleTasks).toEqual([]);
    expect(noResults.emptyState).toBe('no-results');
    expect(noResults.totalCount).toBe(3);
    expect(noResults.visibleTasks).toEqual([]);
  });

  it('builds stable row view models with open-detail action metadata', () => {
    const model = createTaskWorkspaceViewModel({
      tasks,
      query: '',
      status: '',
      tag: '',
      sortBy: 'title',
      selectedTaskId: 'task_alpha',
    });

    expect(model.rows.find((row) => row.id === 'task_alpha')).toMatchObject({
      id: 'task_alpha',
      selected: true,
      action: 'open-detail',
    });
    expect(model.rows.every((row) => row.minHitArea >= 44)).toBe(true);
  });

  it('builds visible selection summary and skips running tasks for bulk delete', () => {
    const model = createTaskWorkspaceViewModel({
      tasks,
      query: '',
      status: '',
      tag: '',
      sortBy: 'updatedAt',
      selectedTaskIds: ['task_alpha', 'task_beta', 'task_missing'],
    });

    expect(model.visibleTaskIds).toEqual(['task_gamma', 'task_alpha', 'task_beta']);
    expect(model.selectedVisibleTaskIds).toEqual(['task_alpha', 'task_beta']);
    expect(model.allVisibleSelected).toBe(false);
    expect(model.someVisibleSelected).toBe(true);
    expect(model.bulkDeleteEligibility).toEqual({
      eligibleTaskIds: ['task_beta'],
      skippedTaskIds: ['task_alpha'],
    });
  });

  it('calculates bulk status eligibility with the task state machine before execution', () => {
    const model = createTaskWorkspaceViewModel({
      tasks,
      query: '',
      status: '',
      tag: '',
      sortBy: 'updatedAt',
      selectedTaskIds: ['task_alpha', 'task_beta', 'task_gamma'],
    });

    expect(model.allVisibleSelected).toBe(true);
    expect(model.bulkStatusEligibility.completed).toEqual({
      targetStatus: 'completed',
      eligibleTaskIds: ['task_alpha'],
      skippedTaskIds: ['task_gamma', 'task_beta'],
    });
    expect(model.bulkStatusEligibility.cancelled).toEqual({
      targetStatus: 'cancelled',
      eligibleTaskIds: ['task_alpha', 'task_beta'],
      skippedTaskIds: ['task_gamma'],
    });
    // 推送到模型必须逐任务确认模型与权限；批量状态修改不能把 ready task 直接送进兼容 /run。
    expect(model.bulkStatusEligibility.running).toEqual({
      targetStatus: 'running',
      eligibleTaskIds: [],
      skippedTaskIds: ['task_gamma', 'task_alpha', 'task_beta'],
    });
  });

  it('uses personal AI-native default columns without team workflow fields', () => {
    const model = createTaskWorkspaceViewModel({
      tasks,
      query: '',
      status: '',
      tag: '',
      sortBy: 'updatedAt',
      runtimeAiAvailable: true,
      runtimeSessions: [
        {
          id: 'session_running',
          taskId: 'task_alpha',
          projectId: 'project_real',
          command: 'codex',
          args: [],
          cwd: '/Users/david/hypha/zeus',
          status: 'running',
          startedAt: '2026-06-25T01:00:00.000Z',
        },
      ],
    });

    expect(model.visibleColumns).toEqual(['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt']);
    expect(model.visibleColumns).not.toContain('assignee');
    expect(model.visibleColumns).not.toContain('owner');
    expect(model.rows[0]?.cells.code.primary).toMatch(/^ZEU-/u);
    expect(model.rows.find((row) => row.id === 'task_alpha')?.cells.aiExecution.primary).toBe('AI 运行中');
    expect(model.rows.find((row) => row.id === 'task_beta')?.cells.aiExecution.primary).toBe('未启动 AI');
  });

  it('keeps updated and created time cells to one formatted line without raw ISO secondary text', () => {
    const model = createTaskWorkspaceViewModel({
      tasks: [tasks[1]],
      query: '',
      status: '',
      tag: '',
      sortBy: 'updatedAt',
      taskTableColumns: {
        visibleColumnKeys: ['code', 'intent', 'updatedAt', 'createdAt'],
        columnOrder: ['code', 'intent', 'updatedAt', 'createdAt'],
      },
    });

    expect(model.rows[0]?.cells.updatedAt).toEqual({ primary: '2026-06-25 10:00:00' });
    expect(model.rows[0]?.cells.createdAt).toEqual({ primary: '2026-06-25 08:20:00' });
    expect(JSON.stringify(model.rows[0]?.cells.updatedAt)).not.toContain('T02:00:00.000Z');
    expect(JSON.stringify(model.rows[0]?.cells.createdAt)).not.toContain('T00:20:00.000Z');
  });

  it('searches by task code and source context and sorts by real updatedAt', () => {
    const byCode = filterVisibleTasks(tasks, 'ZEU-000002', '', '', 'updatedAt');
    const bySource = filterVisibleTasks(tasks, 'graph-node-real', '', '', 'updatedAt');

    expect(byCode.map((task) => task.id)).toEqual(['task_alpha']);
    expect(bySource.map((task) => task.id)).toEqual(['task_gamma']);
    expect(filterVisibleTasks(tasks, '', '', '', 'updatedAt').map((task) => task.id)).toEqual(['task_gamma', 'task_alpha', 'task_beta']);
  });

  it('normalizes task table column preferences with required identity columns', () => {
    expect(
      normalizeTaskTableColumnPreferences({
        visibleColumnKeys: ['priority', 'owner', 'priority'],
        columnOrder: ['priority', 'assignee', 'updatedAt'],
      }),
    ).toEqual({
      visibleColumnKeys: ['priority', 'code', 'intent'],
      columnOrder: ['priority', 'updatedAt', 'code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'createdAt', 'template', 'project', 'description', 'runtimeSession', 'rawId', 'createdFrom'],
    });
  });

  it('keeps legacy task records without task codes searchable with raw id fallback', () => {
    const legacyTask: TaskRecord = {
      id: 'task_legacy_without_code',
      projectId: 'project_real',
      title: '旧快照任务',
      description: '旧 snapshot 没有 taskCode',
      status: 'ready',
      tags: ['legacy'],
      createdFrom: 'user',
      createdAt: '2026-06-25T00:50:00.000Z',
      updatedAt: '2026-06-25T05:00:00.000Z',
    };

    const visible = filterVisibleTasks([legacyTask], 'task_legacy_without_code', '', '', 'updatedAt');
    const model = createTaskWorkspaceViewModel({
      tasks: [legacyTask],
      query: '',
      status: '',
      tag: '',
      sortBy: 'updatedAt',
    });

    expect(visible.map((task) => task.id)).toEqual(['task_legacy_without_code']);
    expect(model.rows[0]?.cells.code.primary).toBe('task_legacy_without_code');
  });

  it('normalizes task table column preferences from unknown persisted json', () => {
    const persistedJson: unknown = JSON.parse('{"visibleColumnKeys":["priority","owner"],"columnOrder":["assignee","updatedAt"]}');

    expect(normalizeTaskTableColumnPreferences(persistedJson)).toEqual({
      visibleColumnKeys: ['priority', 'code', 'intent'],
      columnOrder: ['updatedAt', 'code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'createdAt', 'template', 'project', 'priority', 'description', 'runtimeSession', 'rawId', 'createdFrom'],
    });

    expect(
      createTaskWorkspaceViewModel({
        tasks,
        query: '',
        status: '',
        tag: '',
        sortBy: 'updatedAt',
        taskTableColumns: persistedJson,
      }).columnPreferences,
    ).toEqual({
      visibleColumnKeys: ['priority', 'code', 'intent'],
      columnOrder: ['updatedAt', 'code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'createdAt', 'template', 'project', 'priority', 'description', 'runtimeSession', 'rawId', 'createdFrom'],
    });
  });

  it('returns normalized column preferences for later renderer persistence', () => {
    const model = createTaskWorkspaceViewModel({
      tasks,
      query: '',
      status: '',
      tag: '',
      sortBy: 'updatedAt',
      taskTableColumns: {
        visibleColumnKeys: ['priority', 'owner', 'priority'],
        columnOrder: ['priority', 'assignee', 'updatedAt'],
      },
    });

    expect(model.columnPreferences).toEqual({
      visibleColumnKeys: ['priority', 'code', 'intent'],
      columnOrder: ['priority', 'updatedAt', 'code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'createdAt', 'template', 'project', 'description', 'runtimeSession', 'rawId', 'createdFrom'],
    });
  });

  it('toggles and moves task table columns without dropping required identity columns', () => {
    const normalized = normalizeTaskTableColumnPreferences({
      visibleColumnKeys: ['project', 'code', 'intent', 'owner'],
      columnOrder: ['project', 'code', 'intent', 'assignee', 'updatedAt'],
    });

    const withoutRequiredCode = toggleTaskTableColumn(normalized, 'code', false);
    const withoutProject = toggleTaskTableColumn(withoutRequiredCode, 'project', false);
    const movedIntentDown = moveTaskTableColumn(withoutProject, 'intent', 'down');
    const movedCodeUp = moveTaskTableColumn(movedIntentDown, 'code', 'up');

    expect(withoutProject.visibleColumnKeys).toEqual(expect.arrayContaining(['code', 'intent']));
    expect(withoutProject.visibleColumnKeys).not.toContain('project');
    expect(movedCodeUp.columnOrder.slice(0, 3)).toEqual(['code', 'project', 'updatedAt']);
    expect(movedCodeUp.columnOrder).toHaveLength(new Set(movedCodeUp.columnOrder).size);
    expect(JSON.stringify(movedCodeUp)).not.toContain('owner');
    expect(JSON.stringify(movedCodeUp)).not.toContain('assignee');
  });

  it('normalizes and adjusts per-column width preferences without accepting unknown sizes', () => {
    const normalized = normalizeTaskTableColumnPreferences({
      visibleColumnKeys: ['code', 'intent', 'updatedAt'],
      columnOrder: ['code', 'intent', 'updatedAt'],
      columnWidths: {
        intent: 'wide',
        updatedAt: 'compact',
        owner: 'wide',
        source: 'giant',
      },
    });

    expect(normalized.columnWidths).toEqual({
      intent: 'wide',
      updatedAt: 'compact',
    });

    const widened = setTaskTableColumnWidth(normalized, 'updatedAt', 'wide');
    expect(widened.columnWidths.updatedAt).toBe('wide');
    expect(widened.visibleColumnKeys).toEqual(expect.arrayContaining(['code', 'intent', 'updatedAt']));
    expect(JSON.stringify(widened)).not.toContain('owner');
    expect(JSON.stringify(widened)).not.toContain('giant');
  });

  it('maps source context type to readable labels when createdFrom is missing', () => {
    const contextOnlySourceTask: TaskRecord = {
      id: 'task_context_only',
      projectId: 'project_real',
      taskCode: 'ZEU-000004',
      taskSequence: 4,
      title: '从图谱节点创建任务',
      description: '只保留上下文来源',
      status: 'ready',
      tags: ['graph'],
      sourceContextJson: JSON.stringify({ type: 'graph_node', nodeId: 'graph-node-context-only' }),
      createdAt: '2026-06-25T00:40:00.000Z',
      updatedAt: '2026-06-25T04:00:00.000Z',
    };

    const model = createTaskWorkspaceViewModel({
      tasks: [contextOnlySourceTask],
      query: '',
      status: '',
      tag: '',
      sortBy: 'updatedAt',
    });

    expect(formatTaskSource(contextOnlySourceTask)).toBe('图谱节点');
    expect(model.rows[0]?.cells.source.primary).toBe('图谱节点');
  });

  it('maps user source values with whitespace to manual creation label', () => {
    expect(
      formatTaskSource({
        id: 'task_user_created_from',
        projectId: 'project_real',
        taskCode: 'ZEU-000005',
        title: '手动创建任务',
        status: 'ready',
        createdFrom: ' user ',
      }),
    ).toBe('手动创建');
    expect(
      formatTaskSource({
        id: 'task_user_context',
        projectId: 'project_real',
        taskCode: 'ZEU-000006',
        title: '上下文手动创建任务',
        status: 'ready',
        sourceContextJson: JSON.stringify({ type: ' user ' }),
      }),
    ).toBe('手动创建');
  });

  it('formats drawer facts with language labels instead of leaking Chinese fallbacks', () => {
    const task: TaskRecord = {
      id: 'task_i18n_model',
      projectId: 'project_real',
      title: 'Review i18n facts',
      status: 'waiting_confirmation',
      createdFrom: 'manual',
    };

    expect(formatTaskNextAction(task, { waiting_confirmation: 'Needs my confirmation' })).toBe('Needs my confirmation');
    expect(formatTaskSource(task, { manual: 'Manual' })).toBe('Manual');
    expect(formatTaskUpdatedAt(undefined, 'Not recorded')).toBe('Not recorded');
  });

  it('formats UTC task timestamps as the local wall-clock time', () => {
    expect(formatTaskUpdatedAt('2026-07-09T05:51:27.347Z', '未记录', { timeZone: 'Asia/Shanghai' })).toBe('2026-07-09 13:51:27');
  });

  it('links runtime sessions by source context and masks sensitive command arguments', () => {
    const task: TaskRecord = {
      id: 'task_runtime_source_context',
      projectId: 'project_real',
      title: 'Runtime source context',
      status: 'running',
      sourceContextJson: JSON.stringify({ sessionId: 'session_from_context' }),
    };
    const sessions: AiRuntimeSession[] = [
      {
        id: 'session_from_context',
        projectId: 'project_real',
        command: 'codex',
        args: ['--token=secret-inline', '--api-key', 'secret-paired', '--model', 'gpt-5'],
        cwd: '/Users/david/hypha/zeus',
        status: 'running',
        startedAt: '2026-06-25T01:30:00.000Z',
      },
    ];

    const linkedSession = findLinkedRuntimeSession(task, sessions);
    const model = createTaskWorkspaceViewModel({
      tasks: [task],
      query: '',
      status: '',
      tag: '',
      sortBy: 'updatedAt',
      runtimeAiAvailable: true,
      runtimeSessions: sessions,
    });
    const row = model.rows[0];

    expect(linkedSession?.id).toBe('session_from_context');
    expect(formatRuntimeCommandPreview(linkedSession, 'No runtime command recorded')).toBe('codex --token=*** --api-key *** --model gpt-5');
    expect(row?.cells.aiExecution.primary).toBe('AI 运行中');
    expect(row?.cells.runtimeSession.primary).toBe('session_from_context');
    expect(formatRuntimeCommandPreview(undefined, 'No runtime command recorded')).toBe('No runtime command recorded');
  });
});
