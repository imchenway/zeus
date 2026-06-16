import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLogRepository, ConversationRepository, createZeusDatabase, GitSnapshotRepository, ProjectRepository, SettingRepository, TaskRepository, TaskTemplateRepository, TerminalEventRepository } from '../src/index.js';

describe('Zeus storage', () => {
  it('creates a real SQLite file with core tables but no fake records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      expect(db.listTableNames()).toContain('projects');
      expect(db.listTableNames()).toContain('tasks');
      expect(db.listTableNames()).toContain('settings');
      expect(db.countRows('projects')).toBe(0);
      expect(db.countRows('tasks')).toBe(0);
      await db.save();
      expect((await stat(dbPath)).size).toBeGreaterThan(0);
      expect((await readFile(dbPath)).subarray(0, 6).toString()).toBe('SQLite');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records applied schema migrations without duplicating them on reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-migrations-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      expect(db.listTableNames()).toContain('schema_migrations');
      const migrations = db.select<{
        migration_id: string;
        description: string;
        checksum: string;
      }>('SELECT migration_id, description, checksum FROM schema_migrations ORDER BY migration_id');

      expect(migrations).toEqual([
        expect.objectContaining({
          migration_id: '20260613_0001_core_schema',
          description: expect.stringContaining('核心表'),
          checksum: expect.stringMatching(/^sha256:/u),
        }),
      ]);

      await db.save();
      const reopened = await createZeusDatabase(dbPath);
      const reopenedMigrations = reopened.select<{ migration_id: string }>('SELECT migration_id FROM schema_migrations ORDER BY migration_id');

      expect(reopenedMigrations).toEqual([{ migration_id: '20260613_0001_core_schema' }]);
      expect(reopened.countRows('projects')).toBe(0);
      expect(reopened.countRows('tasks')).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates real SQLite indexes required by the design book', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-indexes-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const indexes = db.select<{ name: string; tbl_name: string }>("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name");

      expect(indexes).toEqual(
        expect.arrayContaining([
          { name: 'idx_projects_slug', tbl_name: 'projects' },
          { name: 'idx_tasks_project_status_updated_at', tbl_name: 'tasks' },
          { name: 'idx_task_events_task_created_at', tbl_name: 'task_events' },
          {
            name: 'idx_runtime_sessions_task_status',
            tbl_name: 'runtime_sessions',
          },
          {
            name: 'idx_terminal_events_session_seq',
            tbl_name: 'terminal_events',
          },
          {
            name: 'idx_conversation_messages_conversation_created_at',
            tbl_name: 'conversation_messages',
          },
          {
            name: 'idx_git_snapshots_task_created_at',
            tbl_name: 'git_snapshots',
          },
          { name: 'idx_git_changes_task_file_path', tbl_name: 'git_changes' },
          { name: 'idx_audit_logs_action_created_at', tbl_name: 'audit_logs' },
        ]),
      );
      expect(db.countRows('projects')).toBe(0);
      expect(db.countRows('tasks')).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists design-book terminal conversation git and audit records without seed data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-design-book-records-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const tableNames = db.listTableNames();

      expect(tableNames).toEqual(expect.arrayContaining(['terminal_events', 'conversations', 'conversation_messages', 'git_snapshots', 'git_changes', 'audit_logs']));
      expect(db.countRows('terminal_events')).toBe(0);
      expect(db.countRows('conversation_messages')).toBe(0);
      expect(db.countRows('git_snapshots')).toBe(0);
      expect(db.countRows('audit_logs')).toBe(0);

      const projects = new ProjectRepository(db);
      const tasks = new TaskRepository(db);
      const project = projects.create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });
      const task = tasks.create({
        projectId: project.id,
        title: '验证设计书持久化表',
        description: '写入终端事件、对话、Git 快照和审计日志',
        createdFrom: 'user',
        sourceContext: { path: '/Users/david/hypha/zeus' },
      });

      const terminalEvents = new TerminalEventRepository(db);
      terminalEvents.append({
        sessionId: 'session-real',
        taskId: task.id,
        seq: 1,
        eventType: 'stdout',
        content: 'pnpm test',
        createdAt: '2026-06-13T00:00:00.000Z',
      });
      terminalEvents.append({
        sessionId: 'session-real',
        taskId: task.id,
        seq: 2,
        eventType: 'stdout',
        content: 'pass',
        createdAt: '2026-06-13T00:00:01.000Z',
      });

      const conversations = new ConversationRepository(db);
      const conversation = conversations.create({
        projectId: project.id,
        taskId: task.id,
        sessionId: 'session-real',
        title: '设计书验收对话',
      });
      conversations.appendMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: '已完成持久化表补齐',
        source: 'runtime',
        metadata: { command: 'pnpm test' },
        createdAt: '2026-06-13T00:00:02.000Z',
      });

      const gitSnapshots = new GitSnapshotRepository(db);
      gitSnapshots.createSnapshot({
        taskId: task.id,
        projectId: project.id,
        snapshotType: 'pre_run',
        branch: 'main',
        headSha: 'abc123',
        status: { clean: false },
        createdAt: '2026-06-13T00:00:03.000Z',
      });
      gitSnapshots.createChange({
        taskId: task.id,
        projectId: project.id,
        filePath: 'packages/storage/src/index.ts',
        changeType: 'modified',
        additions: 12,
        deletions: 1,
        linkedGraphNodes: ['node_storage'],
        createdAt: '2026-06-13T00:00:04.000Z',
      });

      const auditLogs = new AuditLogRepository(db);
      auditLogs.append({
        actorType: 'local_user',
        actorRef: 'david',
        action: 'storage.design_book_records.append',
        resourceType: 'task',
        resourceId: task.id,
        payload: { verified: true },
        createdAt: '2026-06-13T00:00:05.000Z',
      });

      await db.save();
      const reopened = await createZeusDatabase(dbPath);

      expect(new TerminalEventRepository(reopened).listBySession('session-real').map((event) => event.seq)).toEqual([1, 2]);
      expect(new ConversationRepository(reopened).listMessages(conversation.id).map((message) => message.content)).toEqual(['已完成持久化表补齐']);
      expect(new GitSnapshotRepository(reopened).listSnapshots(task.id).map((snapshot) => snapshot.snapshotType)).toEqual(['pre_run']);
      expect(new GitSnapshotRepository(reopened).listChanges(task.id).map((change) => change.filePath)).toEqual(['packages/storage/src/index.ts']);
      expect(new AuditLogRepository(reopened).listRecent().map((entry) => entry.action)).toEqual(['storage.design_book_records.append']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('orders audit logs by insertion order when timestamps are equal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-audit-order-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      db.execute(
        `INSERT INTO audit_logs (id, actor_type, actor_ref, action, resource_type, resource_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['z_first_same_time', 'local_api', null, 'audit.first', 'test', null, '{}', '2026-06-14T00:00:00.000Z', 'a_second_same_time', 'local_api', null, 'audit.second', 'test', null, '{}', '2026-06-14T00:00:00.000Z'],
      );

      expect(new AuditLogRepository(db).listRecent().map((entry) => entry.action)).toEqual(['audit.second', 'audit.first']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists local settings across database reopen without storing secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-settings-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const settings = new SettingRepository(db);
      settings.setJson('telegram.notificationSettings', {
        enabled: true,
        chatIds: [1001, 1002],
        silentMode: true,
      });
      await db.save();

      const reopened = await createZeusDatabase(dbPath);
      const value = new SettingRepository(reopened).getJson<{
        enabled: boolean;
        chatIds: number[];
        silentMode: boolean;
      }>('telegram.notificationSettings');

      expect(value).toEqual({
        enabled: true,
        chatIds: [1001, 1002],
        silentMode: true,
      });
      expect(JSON.stringify(value)).not.toContain('telegram-token-real');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists user-created project and task records only when explicitly inserted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const projects = new ProjectRepository(db);
      const tasks = new TaskRepository(db);
      const project = projects.create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实当前仓库',
      });
      const task = tasks.create({
        projectId: project.id,
        title: '分析当前项目结构',
        description: '扫描 /Users/david/hypha/zeus 的真实源码结构',
        createdFrom: 'user',
        sourceContext: { path: '/Users/david/hypha/zeus' },
      });
      await db.save();

      const reopened = await createZeusDatabase(dbPath);
      expect(new ProjectRepository(reopened).list().map((item) => item.name)).toEqual(['Zeus']);
      expect(new TaskRepository(reopened).listByProject(project.id).map((item) => item.id)).toEqual([task.id]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('archives a project without deleting its record or seeding replacement data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-project-archive-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const projects = new ProjectRepository(db);
      const project = projects.create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实当前仓库',
      });

      const archived = projects.archive(project.id);

      expect(archived.id).toBe(project.id);
      expect(projects.list()).toEqual([]);
      expect(projects.listArchived().map((item) => item.id)).toEqual([project.id]);
      expect(projects.getById(project.id)?.id).toBe(project.id);
      expect(db.countRows('projects')).toBe(1);

      const restored = projects.restore(project.id);

      expect(restored.id).toBe(project.id);
      expect(projects.list().map((item) => item.id)).toEqual([project.id]);
      expect(projects.listArchived()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('installs built-in task templates as product definitions, not task records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-templates-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const templates = new TaskTemplateRepository(db).listBuiltIn();

      expect(templates.map((template) => template.name)).toEqual(['需求分析', '代码实现', 'Bug 修复', '代码评审', '单元测试', '性能分析', '架构分析', 'SQL 优化']);
      expect(templates.every((template) => template.builtIn)).toBe(true);
      expect(templates.every((template) => template.promptTemplate.includes('{{'))).toBe(true);
      expect(db.countRows('tasks')).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates project templates, marks default template, and creates tasks from real template definitions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-template-task-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const projects = new ProjectRepository(db);
      const templates = new TaskTemplateRepository(db);
      const tasks = new TaskRepository(db);
      const project = projects.create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
      });

      const customTemplate = templates.createCustom({
        projectId: project.id,
        name: 'Zeus 专项重构',
        description: '面向真实 Zeus 仓库的项目级任务模板',
        promptTemplate: '请基于 {{project_path}} 完成 {{goal}}',
        category: 'custom',
        defaultOptions: { allowTests: true },
      });
      const defaultProject = projects.setDefaultTemplate(project.id, customTemplate.id);
      const task = tasks.createFromTemplate({
        projectId: project.id,
        template: customTemplate,
        title: 'Zeus 专项重构',
        variables: {
          project_path: '/Users/david/hypha/zeus',
          goal: '整理任务模板闭环',
        },
      });

      expect(customTemplate.builtIn).toBe(false);
      expect(defaultProject.defaultTemplateId).toBe(customTemplate.id);
      expect(templates.listForProject(project.id).map((template) => template.id)).toContain(customTemplate.id);
      expect(task.templateId).toBe(customTemplate.id);
      expect(task.createdFrom).toBe('template');
      expect(task.description).toContain('/Users/david/hypha/zeus');
      expect(task.description).toContain('整理任务模板闭环');
      expect(db.countRows('tasks')).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates, searches, confirms archive, and soft deletes real project records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-project-management-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const projects = new ProjectRepository(db);
      const zeus = projects.create({
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        description: '真实当前仓库',
      });
      projects.create({
        name: 'Hermes',
        localPath: '/Users/david/hypha/hermes',
        description: '另一个真实仓库',
      });

      const updated = projects.update(zeus.id, {
        name: 'Zeus Workbench',
        description: '本地优先工作台',
      });
      const searchResult = projects.search({ query: 'workbench' });
      const confirmation = projects.prepareArchive(zeus.id);
      const deleted = projects.delete(zeus.id);

      expect(updated.name).toBe('Zeus Workbench');
      expect(searchResult.map((project) => project.id)).toEqual([zeus.id]);
      expect(confirmation.confirmationText).toBe('确认归档项目 Zeus Workbench');
      expect(deleted.id).toBe(zeus.id);
      expect(projects.getById(zeus.id)).toBeUndefined();
      expect(projects.list().map((project) => project.name)).toEqual(['Hermes']);
      expect(db.countRows('projects')).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps one active project per local path instead of duplicating search results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-project-path-unique-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const projects = new ProjectRepository(db);
      const first = projects.create({
        name: 'Zeus E2E',
        localPath: '/Users/david/hypha/zeus',
      });
      const duplicate = projects.create({
        name: 'Zeus Copy',
        localPath: '/Users/david/hypha/zeus/',
      });
      const other = projects.create({
        name: 'Hermes',
        localPath: '/Users/david/hypha/hermes',
      });

      expect(duplicate.id).toBe(first.id);
      expect(projects.search({ query: 'Zeus' }).map((project) => project.localPath)).toEqual(['/Users/david/hypha/zeus']);
      expect(projects.list().map((project) => project.id)).toEqual([first.id, other.id]);
      expect(db.countRows('projects')).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects moving a project onto another active project path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-project-path-update-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const projects = new ProjectRepository(db);
      projects.create({ name: 'Zeus', localPath: '/Users/david/hypha/zeus' });
      const hermes = projects.create({
        name: 'Hermes',
        localPath: '/Users/david/hypha/hermes',
      });

      expect(() => projects.update(hermes.id, { localPath: '/Users/david/hypha/zeus/' })).toThrow('Zeus project localPath already exists');
      expect(projects.list().map((project) => project.localPath)).toEqual(['/Users/david/hypha/zeus', '/Users/david/hypha/hermes']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
