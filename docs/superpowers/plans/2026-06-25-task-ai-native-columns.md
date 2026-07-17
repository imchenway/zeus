# Task AI Native Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal AI work-queue task list with readable task codes, customizable columns, real time sorting, and a task drawer identity section that does not introduce team workflow fields.

**Architecture:** Add task identity and task-table preferences at the existing local-first data boundaries: SQLite/storage owns `taskCode` and `taskSequence`; local-server normalizes API/settings contracts; renderer owns AI-native view models, dynamic columns, and drawer presentation. The feature remains a single task-page vertical slice and does not add external dependencies or foreground Zeus automation.

**Tech Stack:** TypeScript, React 19 server-rendered tests, Fastify local-server, sql.js SQLite storage, Vitest, Electron desktop packaging.

---

## Execution constraints

- Do not open Zeus in the foreground and do not use Computer Use for screenshots unless the user explicitly allows it.
- Do not run git commit, git push, git merge, git revert, or any file-changing git operation unless the user explicitly requests it.
- Use TDD for every code change: write the failing test, run it to confirm failure, implement the minimum fix, run the focused test, then move on.
- After any source-code change, the completion gate is: quit Zeus in the background if it is running, then run `pnpm package:mac` successfully before claiming implementation completion.
- Keep Chinese comments for key implementation logic, matching the project convention.
- Keep the task page cardless and hero-free. Do not reintroduce `task-detail-status-row`, task-page `zeus-object-toolbar`, row action button piles, or team workflow fields.

## Scope check

This is one coherent vertical slice: task storage identity, local API shape, renderer task table model, dynamic columns, and drawer identity. It should stay in one implementation plan because every layer must agree on the same task fields and acceptance tests.

## File structure

- Modify: `/Users/david/hypha/zeus/packages/storage/src/index.ts`
  - Owns SQLite schema migration, task code generation, task record mapping, task filtering and sorting.
- Modify: `/Users/david/hypha/zeus/packages/storage/test/task-status.test.ts`
  - Storage red/green tests for task code generation, backfill, real sort/search fields.
- Modify: `/Users/david/hypha/zeus/packages/local-server/src/index.ts`
  - Owns API response shape, portable import/export, app-shell task table preferences normalization.
- Modify: `/Users/david/hypha/zeus/packages/local-server/test/server.test.ts`
  - App-shell settings tests for task table column preferences.
- Modify: `/Users/david/hypha/zeus/packages/local-server/test/task-control-api.test.ts`
  - Task API response tests for task code and expanded fields.
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/apiClient.ts`
  - Frontend API types for expanded `TaskRecord`, `TaskTableColumnKey`, and settings preferences.
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/task/taskWorkspaceModel.ts`
  - AI-native row model, column definitions, field preference normalization, source/next-action formatting.
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/task/TaskWorkspace.tsx`
  - Dynamic table headers/cells and low-noise field configuration popover.
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/task/TaskDetailDrawerContent.tsx`
  - Drawer identity section with task code, next action, AI execution facts, and source facts.
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`
  - Wires runtime sessions, task table preferences, save callbacks, and copy into `TaskWorkspace`/drawer.
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
  - Column layout, field popover, compact task code and AI facts styling without cards or blue outlines.
- Modify: `/Users/david/hypha/zeus/apps/desktop/test/task-workspace-model.test.ts`
  - Model tests for default AI-native columns, search, real sorting, and no team fields.
- Modify: `/Users/david/hypha/zeus/apps/desktop/test/app-task-controls-rendering.test.tsx`
  - Renderer tests for task codes, dynamic columns, field popover structure, drawer identity, and regressions.
- Modify: `/Users/david/hypha/zeus/apps/desktop/test/app-shell-layout.test.tsx`
  - Broad layout regression tests and no-team-field negative assertions.
- Modify: `/Users/david/hypha/zeus/docs/TASK_20260624_002_任务页去HERO化与可用性重构.md`
  - Append implementation status and verification evidence after implementation.

## Task 1: Baseline and red tests for storage task identity

**Files:**
- Modify: `/Users/david/hypha/zeus/packages/storage/test/task-status.test.ts`
- Modify later: `/Users/david/hypha/zeus/packages/storage/src/index.ts`

- [ ] **Step 1: Run current focused baseline**

Run:

```bash
pnpm vitest run packages/storage/test/task-status.test.ts --reporter=verbose
```

Expected: current tests pass before modifications. If they fail, record the failure in the task doc before changing code.

- [ ] **Step 2: Add failing storage tests for generated task codes**

Append these tests inside the existing `describe('Task status persistence', () => { })` block in `/Users/david/hypha/zeus/packages/storage/test/task-status.test.ts`:

```ts
  it('generates stable readable task codes per project without exposing raw ids as identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-code-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const projects = new ProjectRepository(db);
      const zeus = projects.create({ name: 'Zeus', localPath: '/Users/david/hypha/zeus' });
      const giraffe = projects.create({ name: 'Giraffe', localPath: '/Users/david/hypha/giraffe' });
      const tasks = new TaskRepository(db);

      const first = tasks.create({
        projectId: zeus.id,
        title: '分析任务字段',
        description: '真实任务',
        createdFrom: 'user',
        sourceContext: { path: zeus.localPath },
      });
      const second = tasks.create({
        projectId: zeus.id,
        title: '启动 AI Runtime',
        description: '真实任务',
        createdFrom: 'runtime_session',
        sourceContext: { sessionId: 'session_real' },
      });
      const otherProject = tasks.create({
        projectId: giraffe.id,
        title: '分析 Giraffe 任务页',
        description: '真实任务',
        createdFrom: 'graph_node',
        sourceContext: { nodeId: 'node_real' },
      });

      expect(first.taskCode).toBe('ZEU-000001');
      expect(first.taskSequence).toBe(1);
      expect(second.taskCode).toBe('ZEU-000002');
      expect(second.taskSequence).toBe(2);
      expect(otherProject.taskCode).toBe('ZEU-000001');
      expect(otherProject.taskSequence).toBe(1);
      expect(first.taskCode).not.toContain('task_');
      expect(tasks.getById(first.id)?.taskCode).toBe('ZEU-000001');
      expect(tasks.listByProject(zeus.id).map((task) => task.taskCode)).toEqual(['ZEU-000001', 'ZEU-000002']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('backfills missing task codes idempotently for existing local databases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-task-code-backfill-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const firstDb = await createZeusDatabase(dbPath);
      const project = new ProjectRepository(firstDb).create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const firstRepo = new TaskRepository(firstDb);
      const first = firstRepo.create({
        projectId: project.id,
        title: '旧任务一',
        description: '旧库真实任务',
        createdFrom: 'user',
        sourceContext: { path: project.localPath },
      });
      const second = firstRepo.create({
        projectId: project.id,
        title: '旧任务二',
        description: '旧库真实任务',
        createdFrom: 'template',
        sourceContext: { templateId: 'task_template_real' },
      });
      firstDb.execute('UPDATE tasks SET task_code = NULL, task_sequence = NULL WHERE project_id = ?', [project.id]);
      await firstDb.save();

      const reopened = await createZeusDatabase(dbPath);
      const reopenedTasks = new TaskRepository(reopened).listByProject(project.id, { sortBy: 'createdAt', sortDirection: 'asc' });
      expect(reopenedTasks.map((task) => [task.id, task.taskCode, task.taskSequence])).toEqual([
        [first.id, 'ZEU-000001', 1],
        [second.id, 'ZEU-000002', 2],
      ]);
      await reopened.save();

      const reopenedAgain = await createZeusDatabase(dbPath);
      const stable = new TaskRepository(reopenedAgain).listByProject(project.id, { sortBy: 'createdAt', sortDirection: 'asc' });
      expect(stable.map((task) => task.taskCode)).toEqual(['ZEU-000001', 'ZEU-000002']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 3: Run the red storage tests**

Run:

```bash
pnpm vitest run packages/storage/test/task-status.test.ts --testNamePattern "task codes|backfills" --reporter=verbose
```

Expected: FAIL because `taskCode` and `taskSequence` do not exist yet.

## Task 2: Implement storage schema, mapping, search, and real sort

**Files:**
- Modify: `/Users/david/hypha/zeus/packages/storage/src/index.ts`
- Test: `/Users/david/hypha/zeus/packages/storage/test/task-status.test.ts`

- [ ] **Step 1: Extend `ZeusTaskRecord`**

In `/Users/david/hypha/zeus/packages/storage/src/index.ts`, change `ZeusTaskRecord` to include the new fields:

```ts
export interface ZeusTaskRecord {
  id: string;
  projectId: string;
  taskCode: string;
  taskSequence: number | null;
  title: string;
  description: string;
  status: 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';
  priority: string;
  templateId: string | null;
  tags: string[];
  createdFrom: string;
  sourceContextJson: string;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Add schema migration and indexes**

After the `CREATE TABLE IF NOT EXISTS tasks` statement, add idempotent migrations:

```ts
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN task_code TEXT`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN task_sequence INTEGER`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
```

Add these two index statements to the index array:

```ts
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_task_code ON tasks(project_id, task_code)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_sequence ON tasks(project_id, task_sequence)`,
```

- [ ] **Step 3: Add task code helpers**

Near `normalizeTags`, add:

```ts
function formatTaskCode(sequence: number): string {
  return `ZEU-${String(sequence).padStart(6, '0')}`;
}

function normalizeTaskSequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeTaskCode(value: unknown, sequence: number | null): string {
  if (typeof value === 'string') {
    const code = value.trim();
    if (/^[A-Z]{2,8}-\d{1,12}$/u.test(code)) return code;
  }
  return formatTaskCode(sequence ?? 1);
}
```

- [ ] **Step 4: Add database backfill helper**

Near schema helpers, add:

```ts
function backfillMissingTaskCodes(db: ZeusDatabase): void {
  const projectIds = db
    .select<{ project_id: string }>(`SELECT DISTINCT project_id FROM tasks WHERE deleted_at IS NULL ORDER BY project_id ASC`)
    .map((row) => row.project_id);
  for (const projectId of projectIds) {
    const rows = db.select<{ id: string; task_sequence: number | null; task_code: string | null }>(
      `SELECT id, task_sequence, task_code FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`,
      [projectId],
    );
    let nextSequence = 1;
    for (const row of rows) {
      const currentSequence = normalizeTaskSequence(row.task_sequence);
      const sequence = currentSequence ?? nextSequence;
      nextSequence = Math.max(nextSequence, sequence + 1);
      const code = normalizeTaskCode(row.task_code, sequence);
      if (row.task_sequence !== sequence || row.task_code !== code) {
        db.execute(`UPDATE tasks SET task_sequence = ?, task_code = ? WHERE id = ?`, [sequence, code, row.id]);
      }
    }
  }
}
```

Call it after indexes are created:

```ts
  backfillMissingTaskCodes(db);
```

- [ ] **Step 5: Update row type and mapping**

Update `DbTaskRow`:

```ts
interface DbTaskRow {
  id: string;
  project_id: string;
  task_code: string | null;
  task_sequence: number | null;
  title: string;
  description: string;
  status: ZeusTaskRecord['status'];
  priority: string;
  tags_json: string;
  template_id: string | null;
  created_from: string;
  source_context_json: string;
  created_at: string;
  updated_at: string;
}
```

Update `mapTaskRow`:

```ts
function mapTaskRow(row: DbTaskRow): ZeusTaskRecord {
  const sequence = normalizeTaskSequence(row.task_sequence);
  return {
    id: row.id,
    projectId: row.project_id,
    taskCode: normalizeTaskCode(row.task_code, sequence),
    taskSequence: sequence,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority || 'normal',
    templateId: row.template_id,
    tags: parseTagsJson(row.tags_json),
    createdFrom: row.created_from,
    sourceContextJson: row.source_context_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

- [ ] **Step 6: Add `SELECT_TASK_FIELDS` and use it in all task queries**

Near `TaskRepository`, add:

```ts
const selectTaskFields = `id, project_id, task_code, task_sequence, title, description, status, priority, tags_json, template_id, created_from, source_context_json, created_at, updated_at`;
```

Replace each task select list with `${selectTaskFields}`. Example:

```ts
const row = this.db.get<DbTaskRow>(`SELECT ${selectTaskFields} FROM tasks WHERE id = ? AND deleted_at IS NULL`, [taskId]);
```

- [ ] **Step 7: Generate task code during create**

Inside `TaskRepository`, add:

```ts
  private nextTaskSequence(projectId: string): number {
    const row = this.db.get<{ sequence: number | null }>(`SELECT MAX(task_sequence) AS sequence FROM tasks WHERE project_id = ? AND deleted_at IS NULL`, [projectId]);
    return (row?.sequence ?? 0) + 1;
  }
```

Update `create(input: CreateTaskInput)` so the record includes sequence/code/priority and the insert writes them:

```ts
    const taskSequence = this.nextTaskSequence(input.projectId);
    const record: ZeusTaskRecord = {
      id: `task_${nanoid(12)}`,
      projectId: input.projectId,
      taskCode: formatTaskCode(taskSequence),
      taskSequence,
      title: input.title,
      description: input.description,
      status: 'ready',
      priority: 'normal',
      templateId: input.templateId ?? null,
      tags: normalizeTags(input.tags ?? []),
      createdFrom: input.createdFrom,
      sourceContextJson: JSON.stringify(input.sourceContext),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.execute(
      `INSERT INTO tasks (id, project_id, task_code, task_sequence, title, description, status, priority, tags_json, template_id, created_from, source_context_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.taskCode,
        record.taskSequence,
        record.title,
        record.description,
        record.status,
        record.priority,
        JSON.stringify(record.tags),
        record.templateId,
        record.createdFrom,
        record.sourceContextJson,
        record.createdAt,
        record.updatedAt,
      ],
    );
```

- [ ] **Step 8: Expand task search and keep real sorting**

Update `filterAndSortTasks` query matching:

```ts
    const matchesQuery =
      !query ||
      [record.taskCode, record.id, record.title, record.description, record.createdFrom, record.sourceContextJson, record.priority]
        .join('\n')
        .toLowerCase()
        .includes(query);
```

Keep the existing `left[sortBy]` sort after `TaskListOptions` can address `createdAt` and `updatedAt` because `ZeusTaskRecord` now exposes both to callers.

- [ ] **Step 9: Run storage tests**

Run:

```bash
pnpm vitest run packages/storage/test/task-status.test.ts --reporter=verbose
```

Expected: PASS.

## Task 3: Local-server API and app-shell column preferences

**Files:**
- Modify: `/Users/david/hypha/zeus/packages/local-server/src/index.ts`
- Modify: `/Users/david/hypha/zeus/packages/local-server/test/server.test.ts`
- Modify: `/Users/david/hypha/zeus/packages/local-server/test/task-control-api.test.ts`

- [ ] **Step 1: Add failing app-shell settings test**

In `/Users/david/hypha/zeus/packages/local-server/test/server.test.ts`, update the existing app-shell settings test to expect defaults:

```ts
      expect(initialResponse.json().taskTableColumns).toEqual({
        visibleColumnKeys: ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt'],
        columnOrder: ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt', 'createdAt', 'template', 'project', 'priority', 'description', 'runtimeSession', 'rawId', 'createdFrom'],
      });
```

In the save payload, add intentionally messy preferences:

```ts
          taskTableColumns: {
            visibleColumnKeys: ['intent', 'priority', 'owner', 'intent', 'code'],
            columnOrder: ['priority', 'intent', 'assignee', 'code'],
          },
```

After the saved response assertion, add:

```ts
      expect(savedResponse.json().taskTableColumns).toEqual({
        visibleColumnKeys: ['intent', 'priority', 'code'],
        columnOrder: ['priority', 'intent', 'code', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt', 'createdAt', 'template', 'project', 'description', 'runtimeSession', 'rawId', 'createdFrom'],
      });
      expect(JSON.stringify(savedResponse.json().taskTableColumns)).not.toContain('owner');
      expect(JSON.stringify(savedResponse.json().taskTableColumns)).not.toContain('assignee');
```

- [ ] **Step 2: Add failing task API response test**

In `/Users/david/hypha/zeus/packages/local-server/test/task-control-api.test.ts`, add or extend a task creation/list/load test with these assertions on the task JSON returned by the task API:

```ts
      expect(createdTask).toMatchObject({
        taskCode: 'ZEU-000001',
        taskSequence: 1,
        priority: 'normal',
        createdFrom: 'user',
      });
      expect(typeof createdTask.createdAt).toBe('string');
      expect(typeof createdTask.updatedAt).toBe('string');
      expect(typeof createdTask.sourceContextJson).toBe('string');
      expect(JSON.stringify(createdTask)).not.toContain('assignee');
      expect(JSON.stringify(createdTask)).not.toContain('owner');
```

- [ ] **Step 3: Run red local-server tests**

Run:

```bash
pnpm vitest run packages/local-server/test/server.test.ts --testNamePattern "app shell operations settings" --reporter=verbose
pnpm vitest run packages/local-server/test/task-control-api.test.ts --testNamePattern "task" --reporter=verbose
```

Expected: FAIL because `taskTableColumns` and task code fields are not yet normalized/exposed in local-server snapshots.

- [ ] **Step 4: Add task column preference types and normalizer**

In `/Users/david/hypha/zeus/packages/local-server/src/index.ts`, add near app-shell settings types:

```ts
type TaskTableColumnKey =
  | 'code'
  | 'intent'
  | 'nextAction'
  | 'aiExecution'
  | 'source'
  | 'signals'
  | 'updatedAt'
  | 'createdAt'
  | 'template'
  | 'project'
  | 'priority'
  | 'description'
  | 'runtimeSession'
  | 'rawId'
  | 'createdFrom';

interface TaskTableColumnPreferences {
  visibleColumnKeys: TaskTableColumnKey[];
  columnOrder: TaskTableColumnKey[];
}

const defaultTaskTableColumnOrder: TaskTableColumnKey[] = ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt', 'createdAt', 'template', 'project', 'priority', 'description', 'runtimeSession', 'rawId', 'createdFrom'];
const defaultVisibleTaskTableColumns: TaskTableColumnKey[] = ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt'];
const taskTableColumnKeySet = new Set<TaskTableColumnKey>(defaultTaskTableColumnOrder);

function normalizeTaskTableColumnKeys(value: unknown, fallback: TaskTableColumnKey[]): TaskTableColumnKey[] {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<TaskTableColumnKey>();
  const keys = value.filter((item): item is TaskTableColumnKey => typeof item === 'string' && taskTableColumnKeySet.has(item as TaskTableColumnKey));
  for (const key of keys) seen.add(key);
  return seen.size > 0 ? Array.from(seen) : fallback;
}

function normalizeTaskTableColumnPreferences(value: unknown): TaskTableColumnPreferences {
  const input = typeof value === 'object' && value !== null ? (value as Partial<TaskTableColumnPreferences>) : {};
  const visible = normalizeTaskTableColumnKeys(input.visibleColumnKeys, defaultVisibleTaskTableColumns);
  const visibleWithRequired = Array.from(new Set<TaskTableColumnKey>([...visible, 'code', 'intent']));
  const order = normalizeTaskTableColumnKeys(input.columnOrder, defaultTaskTableColumnOrder);
  const ordered = [...order, ...defaultTaskTableColumnOrder.filter((key) => !order.includes(key))];
  return {
    visibleColumnKeys: visibleWithRequired.filter((key) => taskTableColumnKeySet.has(key)),
    columnOrder: ordered,
  };
}
```

- [ ] **Step 5: Add settings fields and patch behavior**

Add to `AppShellSettingsSnapshot` and `UpdateAppShellSettingsBody`:

```ts
  taskTableColumns: TaskTableColumnPreferences;
```

```ts
  taskTableColumns?: Partial<TaskTableColumnPreferences>;
```

Add to `normalizeAppShellSettings` return:

```ts
      taskTableColumns: normalizeTaskTableColumnPreferences(value?.taskTableColumns),
```

Add to `patchAppShellSettings` input object:

```ts
        taskTableColumns: input.taskTableColumns ? normalizeTaskTableColumnPreferences(input.taskTableColumns) : current.taskTableColumns,
```

Add to app-shell audit payload:

```ts
        taskTableColumns: appShellSettings.taskTableColumns,
```

- [ ] **Step 6: Extend portable task data**

Add the new fields to `PortableTaskRecord`:

```ts
  taskCode?: string;
  taskSequence?: number | null;
  priority?: string;
```

Update portable export mapping to include `taskCode`, `taskSequence`, and `priority`. Update portable import insert SQL to include `task_code`, `task_sequence`, and `priority`, using `task.taskCode ?? null`, `task.taskSequence ?? null`, and `task.priority ?? 'normal'`. Keep source context, createdAt, and updatedAt intact.

- [ ] **Step 7: Run local-server tests**

Run:

```bash
pnpm vitest run packages/local-server/test/server.test.ts --testNamePattern "app shell operations settings" --reporter=verbose
pnpm vitest run packages/local-server/test/task-control-api.test.ts --testNamePattern "task" --reporter=verbose
```

Expected: PASS.

## Task 4: Renderer API types and task workspace model

**Files:**
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/apiClient.ts`
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/task/taskWorkspaceModel.ts`
- Modify: `/Users/david/hypha/zeus/apps/desktop/test/task-workspace-model.test.ts`

- [ ] **Step 1: Add failing model tests**

Replace the fixture tasks in `/Users/david/hypha/zeus/apps/desktop/test/task-workspace-model.test.ts` with expanded records including `taskCode`, time fields, source fields, and priority. Add these tests:

```ts
  it('uses personal AI-native default columns without team workflow fields', () => {
    const model = createTaskWorkspaceViewModel({
      tasks,
      query: '',
      status: '',
      tag: '',
      sortBy: 'updatedAt',
      runtimeAiAvailable: true,
      runtimeSessions: [{ id: 'session_running', taskId: 'task_alpha', command: 'codex', args: [], cwd: '/Users/david/hypha/zeus', status: 'running', startedAt: '2026-06-25T01:00:00.000Z' }],
    });

    expect(model.visibleColumns).toEqual(['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt']);
    expect(model.visibleColumns).not.toContain('assignee');
    expect(model.visibleColumns).not.toContain('owner');
    expect(model.rows[0]?.cells.code.primary).toMatch(/^ZEU-/u);
    expect(model.rows.find((row) => row.id === 'task_alpha')?.cells.aiExecution.primary).toBe('AI 运行中');
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
```

- [ ] **Step 2: Run red model tests**

Run:

```bash
pnpm vitest run apps/desktop/test/task-workspace-model.test.ts --reporter=verbose
```

Expected: FAIL because the model does not expose columns, cells, runtime sessions, or normalize helpers.

- [ ] **Step 3: Extend renderer API types**

In `/Users/david/hypha/zeus/apps/desktop/src/renderer/apiClient.ts`, add:

```ts
export type TaskTableColumnKey = 'code' | 'intent' | 'nextAction' | 'aiExecution' | 'source' | 'signals' | 'updatedAt' | 'createdAt' | 'template' | 'project' | 'priority' | 'description' | 'runtimeSession' | 'rawId' | 'createdFrom';

export interface TaskTableColumnPreferences {
  visibleColumnKeys: TaskTableColumnKey[];
  columnOrder: TaskTableColumnKey[];
}
```

Update `TaskRecord`:

```ts
export interface TaskRecord {
  id: string;
  projectId: string;
  taskCode: string;
  taskSequence?: number | null;
  title: string;
  description?: string;
  status: TaskStatus;
  priority?: string;
  templateId?: string | null;
  tags?: string[];
  createdFrom?: string;
  sourceContextJson?: string;
  createdAt?: string;
  updatedAt?: string;
}
```

Update `AppShellSettings` and `UpdateAppShellSettingsRequest` to include `taskTableColumns`.

- [ ] **Step 4: Implement model helpers**

In `/Users/david/hypha/zeus/apps/desktop/src/renderer/task/taskWorkspaceModel.ts`, add exported defaults and normalizer:

```ts
export const defaultTaskTableColumnOrder: TaskTableColumnKey[] = ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt', 'createdAt', 'template', 'project', 'priority', 'description', 'runtimeSession', 'rawId', 'createdFrom'];
export const defaultVisibleTaskTableColumns: TaskTableColumnKey[] = ['code', 'intent', 'nextAction', 'aiExecution', 'source', 'signals', 'updatedAt'];
const taskTableColumnKeySet = new Set<TaskTableColumnKey>(defaultTaskTableColumnOrder);

export function normalizeTaskTableColumnPreferences(input?: Partial<TaskTableColumnPreferences>): TaskTableColumnPreferences {
  const visible = normalizeColumnKeys(input?.visibleColumnKeys, defaultVisibleTaskTableColumns);
  const visibleWithRequired = Array.from(new Set<TaskTableColumnKey>([...visible, 'code', 'intent']));
  const order = normalizeColumnKeys(input?.columnOrder, defaultTaskTableColumnOrder);
  return {
    visibleColumnKeys: visibleWithRequired,
    columnOrder: [...order, ...defaultTaskTableColumnOrder.filter((key) => !order.includes(key))],
  };
}

function normalizeColumnKeys(value: unknown, fallback: TaskTableColumnKey[]): TaskTableColumnKey[] {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<TaskTableColumnKey>();
  for (const item of value) {
    if (typeof item === 'string' && taskTableColumnKeySet.has(item as TaskTableColumnKey)) seen.add(item as TaskTableColumnKey);
  }
  return seen.size > 0 ? Array.from(seen) : fallback;
}
```

- [ ] **Step 5: Implement AI-native row cells**

Add the cell type:

```ts
export interface TaskTableCellViewModel {
  primary: string;
  secondary?: string;
}
```

Extend `TaskWorkspaceViewModelInput` with `runtimeAiAvailable?: boolean`, `runtimeSessions?: AiRuntimeSession[]`, and `taskTableColumns?: Partial<TaskTableColumnPreferences>`.

Add formatter helpers:

```ts
function formatNextAction(task: TaskRecord): string {
  if (task.status === 'draft' || task.status === 'ready') return '可启动 AI';
  if (task.status === 'running') return '等待 AI 输出';
  if (task.status === 'paused') return '可继续';
  if (task.status === 'waiting_confirmation') return '需要我确认';
  if (task.status === 'failed') return '可重试';
  if (task.status === 'completed') return '已完成';
  return '已取消';
}

function formatSource(task: TaskRecord): string {
  const context = parseSourceContext(task.sourceContextJson);
  if (task.createdFrom === 'graph_node') return '图谱节点';
  if (task.createdFrom === 'graph_view') return '代码图谱';
  if (task.createdFrom === 'runtime_session') return 'Runtime 会话';
  if (task.createdFrom === 'template') return '任务模板';
  if (task.createdFrom === 'graph_question') return '图谱问答';
  if (typeof context.type === 'string' && context.type.trim()) return context.type;
  return '手动创建';
}

function parseSourceContext(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
```

Build `row.cells` using the current task and runtime sessions. Keep labels in Chinese for now because existing tests use Chinese copy in this page. English copy can be added later through `App.tsx` copy when rendering.

- [ ] **Step 6: Fix `filterVisibleTasks` real search/sort**

Update query matching to include task code and source fields:

```ts
    const matchesQuery =
      !normalizedQuery ||
      [task.taskCode, task.title, task.description ?? '', task.id, task.createdFrom ?? '', task.sourceContextJson ?? '', task.priority ?? '']
        .some((value) => value.toLowerCase().includes(normalizedQuery));
```

Update sorting:

```ts
    if (sortBy === 'createdAt') return (left.createdAt ?? left.id).localeCompare(right.createdAt ?? right.id);
    if (sortBy === 'updatedAt') return (left.updatedAt ?? left.id).localeCompare(right.updatedAt ?? right.id);
```

- [ ] **Step 7: Run model tests**

Run:

```bash
pnpm vitest run apps/desktop/test/task-workspace-model.test.ts --reporter=verbose
```

Expected: PASS.

## Task 5: Renderer task table dynamic columns and field popover

**Files:**
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/task/TaskWorkspace.tsx`
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
- Modify: `/Users/david/hypha/zeus/apps/desktop/test/app-task-controls-rendering.test.tsx`

- [ ] **Step 1: Add failing rendering tests**

In `/Users/david/hypha/zeus/apps/desktop/test/app-task-controls-rendering.test.tsx`, update test fixtures so each task contains `taskCode`, `createdAt`, `updatedAt`, `createdFrom`, and `sourceContextJson`. Add:

```ts
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

  it('renders a low-noise task column settings popover contract without adding a second primary button', () => {
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
        copy={{ ...createTaskWorkspaceCopy(), fieldSettings: '字段', fieldSettingsAria: '自定义任务字段', restoreDefaultColumns: '恢复默认字段' }}
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
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('task-table-field-settings-popover');
    expect(html.match(/task-table-new-task-button/gu)?.length).toBe(1);
  });
```

If `createTaskWorkspaceCopy()` does not exist in the test, add a small local helper returning the current copy shape plus the new field labels.

- [ ] **Step 2: Run red renderer tests**

Run:

```bash
pnpm vitest run apps/desktop/test/app-task-controls-rendering.test.tsx --testNamePattern "AI-native default task columns|column settings" --reporter=verbose
```

Expected: FAIL because dynamic columns and copy fields are not implemented.

- [ ] **Step 3: Extend `TaskWorkspaceCopy` and props**

In `TaskWorkspace.tsx`, add copy fields:

```ts
  codeColumnTitle: string;
  intentColumnTitle: string;
  nextActionColumnTitle: string;
  aiExecutionColumnTitle: string;
  sourceColumnTitle: string;
  signalsColumnTitle: string;
  createdAtColumnTitle: string;
  updatedAtColumnTitle: string;
  priorityColumnTitle: string;
  projectColumnTitle: string;
  templateColumnTitle: string;
  descriptionColumnTitle: string;
  runtimeSessionColumnTitle: string;
  rawIdColumnTitle: string;
  createdFromColumnTitle: string;
  fieldSettings: string;
  fieldSettingsAria: string;
  restoreDefaultColumns: string;
```

Add props:

```ts
  runtimeSessions: AiRuntimeSession[];
  taskTableColumns?: Partial<TaskTableColumnPreferences>;
  onTaskTableColumnsChange: (value: TaskTableColumnPreferences) => void;
```

- [ ] **Step 4: Render dynamic headers and cells**

Inside `TaskWorkspace`, use `model.visibleColumns` to render headers and row cells. Replace fixed header spans with:

```tsx
{model.visibleColumns.map((columnKey) => (
  <span className={`task-table-cell task-table-${columnKey}-cell`} role="columnheader" key={columnKey}>
    {columnLabels[columnKey]}
  </span>
))}
```

Replace fixed row cells with:

```tsx
{model.visibleColumns.map((columnKey) => {
  const cell = row.cells[columnKey];
  return (
    <span className={`task-table-cell task-table-${columnKey}-cell`} role="gridcell" key={columnKey}>
      <strong>{cell.primary}</strong>
      {cell.secondary ? <small>{cell.secondary}</small> : null}
    </span>
  );
})}
```

Keep the row button itself as the single row action.

- [ ] **Step 5: Add the field settings popover structure**

Add local `fieldSettingsOpen` state. Render a low-noise trigger before `newTask`:

```tsx
<button className="task-table-field-settings-trigger" type="button" aria-haspopup="menu" aria-expanded={fieldSettingsOpen} aria-label={props.copy.fieldSettingsAria} onClick={() => setFieldSettingsOpen((open) => !open)}>
  {props.copy.fieldSettings}
</button>
```

When open, render:

```tsx
<section className="task-table-field-settings-popover" role="menu" aria-label={props.copy.fieldSettingsAria}>
  {model.columnPreferences.columnOrder.map((columnKey) => (
    <label className="task-table-field-option" key={columnKey}>
      <input
        type="checkbox"
        checked={model.columnPreferences.visibleColumnKeys.includes(columnKey)}
        disabled={columnKey === 'code' || columnKey === 'intent'}
        onChange={(event) => props.onTaskTableColumnsChange(toggleTaskTableColumn(model.columnPreferences, columnKey, event.currentTarget.checked))}
      />
      <span>{columnLabels[columnKey]}</span>
    </label>
  ))}
  <button type="button" className="task-table-field-reset" onClick={() => props.onTaskTableColumnsChange(normalizeTaskTableColumnPreferences())}>
    {props.copy.restoreDefaultColumns}
  </button>
</section>
```

Implement `toggleTaskTableColumn` in `taskWorkspaceModel.ts` and export it.

- [ ] **Step 6: Wire App settings**

In `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`, pass:

```tsx
runtimeSessions={runtimeSessions}
taskTableColumns={appShellSettings.taskTableColumns}
onTaskTableColumnsChange={(taskTableColumns) => void saveTaskTableColumns(taskTableColumns)}
```

Add `saveTaskTableColumns`:

```ts
  async function saveTaskTableColumns(taskTableColumns: TaskTableColumnPreferences): Promise<void> {
    const nextSettings = { ...appShellSettings, taskTableColumns };
    setAppShellSettings(nextSettings);
    if (!props.onSaveAppShellSettings) return;
    try {
      const savedSettings = await props.onSaveAppShellSettings({
        appLanguage: nextSettings.appLanguage,
        appearance: nextSettings.appearance,
        webviewDebugEnabled: nextSettings.webviewDebugEnabled,
        developerModeEnabled: nextSettings.developerModeEnabled,
        multiWindowEnabled: nextSettings.multiWindowEnabled,
        backgroundModeEnabled: nextSettings.backgroundModeEnabled,
        desktopNotificationsEnabled: nextSettings.desktopNotificationsEnabled,
        openAtLoginEnabled: nextSettings.openAtLoginEnabled,
        autoUpdateChannel: nextSettings.autoUpdateChannel,
        defaultProjectId: nextSettings.defaultProjectId,
        pinnedProjectIds: nextSettings.pinnedProjectIds,
        defaultModel: nextSettings.defaultModel,
        defaultTaskTemplateId: nextSettings.defaultTaskTemplateId,
        taskTableColumns,
      });
      setAppShellSettings(savedSettings);
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }
```

Also include `taskTableColumns` in `saveAppShellSettings()` and `togglePinnedProject()` payloads so later settings saves do not drop field preferences.

- [ ] **Step 7: Add CSS without card frames**

In `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`, add a marked block:

```css
/* 任务页 AI-native 字段与自定义列最终覆盖 */
.task-table-field-settings-trigger {
  min-height: var(--zeus-control-height);
  border: 0;
  border-radius: var(--zeus-control-radius);
  background: transparent;
  color: var(--zeus-product-text-secondary);
  padding: 0 10px;
}

.task-table-field-settings-trigger:hover,
.task-table-field-settings-trigger:focus-visible {
  background: var(--zeus-source-list-hover);
  color: var(--zeus-product-text-primary);
  outline: none;
}

.task-table-field-settings-popover {
  position: absolute;
  inset-block-start: calc(100% + 6px);
  inset-inline-end: 88px;
  z-index: 42;
  min-inline-size: 220px;
  padding: 8px;
  border: 1px solid var(--zeus-popover-line);
  border-radius: var(--zeus-popover-radius);
  background: var(--zeus-popover-bg);
  box-shadow: 0 16px 34px oklch(0% 0 0 / 0.12);
}

.task-table-field-option {
  display: flex;
  min-height: 30px;
  align-items: center;
  gap: 8px;
  padding: 0 6px;
  border-radius: 7px;
  font-size: 13px;
}

.task-table-field-option:hover {
  background: var(--zeus-source-list-hover);
}

.task-table-code-cell {
  min-inline-size: 92px;
  font-family: var(--zeus-font-mono);
  color: var(--zeus-product-text-secondary);
}

.task-table-nextAction-cell,
.task-table-aiExecution-cell,
.task-table-source-cell {
  min-inline-size: 132px;
}
```

- [ ] **Step 8: Run renderer tests**

Run:

```bash
pnpm vitest run apps/desktop/test/app-task-controls-rendering.test.tsx --testNamePattern "AI-native default task columns|column settings" --reporter=verbose
```

Expected: PASS.

## Task 6: Task detail drawer identity and AI facts

**Files:**
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/task/TaskDetailDrawerContent.tsx`
- Modify: `/Users/david/hypha/zeus/apps/desktop/test/app-task-controls-rendering.test.tsx`
- Modify: `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`

- [ ] **Step 1: Add failing drawer rendering test**

Add:

```ts
  it('renders task drawer identity as personal AI facts with task code and next action', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawerContent
        task={{
          id: 'task_real',
          projectId: 'project_real',
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
        statusLabels={{ '': '全部', draft: '草稿', ready: '待开始', running: '运行中', paused: '已暂停', waiting_confirmation: '等待确认', completed: '已完成', failed: '已失败', cancelled: '已取消' }}
        eventTypeLabels={{}}
        runtimeAiAvailable={true}
        busy={false}
        onRuntimeAction={() => undefined}
        onMarkComplete={() => undefined}
        controlBusyProps={() => ({})}
      />,
    );

    expect(html).toContain('ZEU-000001');
    expect(html).toContain('需要我确认');
    expect(html).toContain('Runtime 会话');
    expect(html).toContain('task-detail-ai-facts');
    expect(html).not.toContain('负责人');
    expect(html).not.toContain('处理人');
  });
```

- [ ] **Step 2: Run red drawer test**

Run:

```bash
pnpm vitest run apps/desktop/test/app-task-controls-rendering.test.tsx --testNamePattern "drawer identity" --reporter=verbose
```

Expected: FAIL because drawer identity does not render task code or AI facts.

- [ ] **Step 3: Use task workspace model formatters in drawer**

Export these helpers from `taskWorkspaceModel.ts`: `formatTaskNextAction`, `formatTaskSource`, and `formatTaskUpdatedAt`.

In `TaskDetailDrawerContent.tsx`, render header:

```tsx
<header className="task-detail-drawer-header task-detail-summary-row">
  <span className="task-detail-drawer-title">
    <small>{props.task.taskCode}</small>
    <strong>{props.task.title}</strong>
  </span>
  <span className="task-detail-drawer-status" aria-label={statusLabel}>
    {statusLabel} · {formatTaskNextAction(props.task)}
  </span>
</header>
```

Render facts:

```tsx
<section className="task-detail-summary-grid task-detail-ai-facts" aria-label={props.copy.metadataTitle}>
  <span className="task-detail-summary-row">
    <small>{props.copy.aiCliLabel}</small>
    <strong>{props.runtimeAiAvailable ? props.copy.aiDetected : props.copy.aiNotConfigured}</strong>
  </span>
  <span className="task-detail-summary-row">
    <small>{props.copy.sourceLabel}</small>
    <strong>{formatTaskSource(props.task)}</strong>
  </span>
  <span className="task-detail-summary-row">
    <small>{props.copy.updatedAtLabel}</small>
    <strong>{formatTaskUpdatedAt(props.task.updatedAt)}</strong>
  </span>
</section>
```

Add `sourceLabel` and `updatedAtLabel` to `TaskDetailDrawerCopy` and language copy in `App.tsx`.

- [ ] **Step 4: Run drawer test**

Run:

```bash
pnpm vitest run apps/desktop/test/app-task-controls-rendering.test.tsx --testNamePattern "drawer identity" --reporter=verbose
```

Expected: PASS.

## Task 7: Broad renderer regression and no-team-field guardrails

**Files:**
- Modify: `/Users/david/hypha/zeus/apps/desktop/test/app-shell-layout.test.tsx`
- Modify: `/Users/david/hypha/zeus/apps/desktop/test/app-task-controls-rendering.test.tsx`
- Modify: `/Users/david/hypha/zeus/docs/TASK_20260624_002_任务页去HERO化与可用性重构.md`

- [ ] **Step 1: Add broad no-team-field source and render test**

In `/Users/david/hypha/zeus/apps/desktop/test/app-shell-layout.test.tsx`, add a test that reads renderer source files and asserts team fields are absent outside explicit negative tests:

```ts
  it('keeps task workspace personal and does not introduce team workflow fields', () => {
    const taskWorkspace = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const taskModel = readFileSync(new URL('../src/renderer/task/taskWorkspaceModel.ts', import.meta.url), 'utf8');
    const drawer = readFileSync(new URL('../src/renderer/task/TaskDetailDrawerContent.tsx', import.meta.url), 'utf8');
    const combined = `${taskWorkspace}\n${taskModel}\n${drawer}`;

    expect(combined).not.toContain('assignee');
    expect(combined).not.toContain('owner');
    expect(combined).not.toContain('负责人');
    expect(combined).not.toContain('处理人');
    expect(combined).not.toContain('@我');
    expect(combined).not.toContain('SLA');
    expect(combined).not.toContain('逾期');
  });
```

- [ ] **Step 2: Run focused broad renderer tests**

Run:

```bash
pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx --testNamePattern "team workflow|task|任务|table|drawer|ZeusSelect|select|下拉|hover|selected" --reporter=verbose
pnpm vitest run apps/desktop/test/app-task-controls-rendering.test.tsx --reporter=verbose
```

Expected: PASS.

- [ ] **Step 3: Update task document implementation status**

Append to `/Users/david/hypha/zeus/docs/TASK_20260624_002_任务页去HERO化与可用性重构.md`:

```md

## 2026-06-25 实施：个人 × AI 协作任务字段与自定义列

### 实施状态
- [x] 任务编码与项目内序号入库。
- [x] 旧任务编码幂等回填。
- [x] `TaskRecord` 扩展为真实 AI 工作队列字段。
- [x] 任务列表默认列改为任务编码、任务/意图、状态/下一步、AI 执行、上下文来源、标签/信号、更新时间。
- [x] 字段显示/隐藏与恢复默认偏好持久化到 app shell settings。
- [x] 详情抽屉展示任务编码、下一步和个人 AI facts。
- [x] 反回归：不引入负责人、处理人、assignee、owner、@我、SLA、逾期。

### 验证记录
- 待执行命令结果由最终验证步骤补充。
```

This is documentation, not source-code completion evidence. Replace the last bullet list with exact command results after final verification.

## Task 8: Full verification and package gate

**Files:**
- No source files expected.
- Update: `/Users/david/hypha/zeus/docs/TASK_20260624_002_任务页去HERO化与可用性重构.md`

- [ ] **Step 1: Run focused storage and server tests**

Run:

```bash
pnpm vitest run packages/storage/test/task-status.test.ts --reporter=verbose
pnpm vitest run packages/local-server/test/server.test.ts --testNamePattern "app shell operations settings" --reporter=verbose
pnpm vitest run packages/local-server/test/task-control-api.test.ts --testNamePattern "task" --reporter=verbose
```

Expected: PASS.

- [ ] **Step 2: Run focused renderer tests**

Run:

```bash
pnpm vitest run apps/desktop/test/task-workspace-model.test.ts --reporter=verbose
pnpm vitest run apps/desktop/test/app-task-controls-rendering.test.tsx --reporter=verbose
pnpm vitest run apps/desktop/test/app-shell-layout.test.tsx --testNamePattern "team workflow|task|任务|table|drawer|ZeusSelect|select|下拉|hover|selected|AI-native|字段" --reporter=verbose
```

Expected: PASS.

- [ ] **Step 3: Run full project quality gates**

Run:

```bash
pnpm test
pnpm format:check
pnpm lint
pnpm typecheck
git diff --check
```

Expected: all commands PASS. Do not stage or commit changes.

- [ ] **Step 4: Reverse scan for prohibited old patterns**

Run:

```bash
rg -n "task-detail-status-row|task-filter-command-rail|zeus-object-toolbar.*task|assignee|owner|负责人|处理人|@我|SLA|逾期" apps/desktop/src packages/local-server/src packages/storage/src apps/desktop/test packages/local-server/test packages/storage/test || true
```

Expected: no production source hits for old task-page hero/toolbar or team workflow fields. Test files may contain negative assertions only.

- [ ] **Step 5: Quit Zeus in the background without foreground app control**

Run:

```bash
osascript -e 'tell application id "dev.hypha.zeus" to quit' || true
sleep 2
pgrep -fl "Zeus|dev.hypha.zeus" || true
```

Expected: no running Zeus process remains. If a process remains, record it and do not claim completion until resolved.

- [ ] **Step 6: Run macOS package gate**

Run:

```bash
pnpm package:mac
```

Expected: PASS. Vite chunk-size warnings and unsigned local identity messages are acceptable if the command exits successfully and codesign verification remains valid.

- [ ] **Step 7: Update task doc with exact verification evidence**

In `/Users/david/hypha/zeus/docs/TASK_20260624_002_任务页去HERO化与可用性重构.md`, replace the pending verification note with exact command names and results. Include whether screenshot-level visual QA was skipped because the user requested no foreground Zeus usage.

## Self-review checklist

- Spec coverage: task code, customizable fields, AI-native default columns, no team workflow fields, real time sorting, drawer identity, no mock data, and `pnpm package:mac` gate are all mapped to tasks above.
- Placeholder scan: this plan uses concrete file paths, commands, expected results, and code snippets for each implementation task.
- Type consistency: `TaskTableColumnKey`, `TaskTableColumnPreferences`, `taskCode`, `taskSequence`, `createdFrom`, `sourceContextJson`, `createdAt`, and `updatedAt` are named consistently across storage, local-server, renderer, and tests.
- Git constraint: no commit steps are included because the project-level instruction forbids self-initiated git commits.
