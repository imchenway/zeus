import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  AuditLogRepository,
  ConversationItemRepository,
  ConversationRepository,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  CodexLegacyImportRepository,
  createZeusDatabase,
  GitSnapshotRepository,
  IdempotencyRequestRepository,
  ProjectRepository,
  SettingRepository,
  TaskRepository,
  TaskTemplateRepository,
  TerminalEventRepository,
} from '../src/index.js';

describe('Zeus storage', () => {
  it('Codex legacy import reuses source/hash, enforces transitions, and binds atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-codex-legacy-import-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const projects = new ProjectRepository(db);
      const conversations = new ConversationRepository(db);
      const project = projects.create({ name: 'Legacy import', localPath: dir });
      const source = conversations.create({ projectId: project.id, title: '旧会话', transportKind: 'legacy_cli' });
      conversations.appendMessage({ conversationId: source.id, role: 'user', content: '原始问题', source: 'task_prompt', metadata: {}, createdAt: '2026-07-14T00:00:00.000Z' });
      let importSequence = 0;
      const imports = new CodexLegacyImportRepository(db, { now: () => '2026-07-14T00:00:01.000Z', id: () => `legacy-import-record-${++importSequence}` });

      const created = imports.createRun({
        sourceConversationId: source.id,
        snapshotPath: join(dir, 'projects', 'legacy.jsonl'),
        snapshotSha256: 'a'.repeat(64),
        providerBinaryVersion: '0.144.2',
      });
      expect(imports.createRun({ sourceConversationId: source.id, snapshotPath: join(dir, 'projects', 'legacy.jsonl'), snapshotSha256: 'a'.repeat(64), providerBinaryVersion: '0.144.2' })).toEqual(created);
      expect(imports.listRecoverable()).toEqual([created]);

      const retrySource = conversations.create({ projectId: project.id, title: '重试旧会话', transportKind: 'legacy_cli' });
      const retryRun = imports.createRun({
        sourceConversationId: retrySource.id,
        snapshotPath: join(dir, 'projects', 'retry.jsonl'),
        snapshotSha256: 'c'.repeat(64),
        providerBinaryVersion: '0.144.2',
      });
      imports.markFailed(retryRun.id, { stage: 'provider', message: 'provider exited' });
      expect(imports.listRecent()).toEqual([expect.objectContaining({ id: retryRun.id, status: 'failed' }), expect.objectContaining({ id: created.id, status: 'prepared' })]);
      expect(imports.retryFailed(retryRun.id)).toMatchObject({ status: 'prepared', providerImportId: null, failureStage: null, failureMessage: null, completedAt: null });

      const started = imports.markStarted(created.id, 'provider-import-1');
      expect(started.status).toBe('waiting');
      const completed = imports.bindThreadAndArchiveSource({ id: created.id, targetThreadId: 'thread-imported-1', providerBinaryVersion: '0.144.2' });
      expect(completed.run).toMatchObject({ status: 'completed', targetThreadId: 'thread-imported-1', targetConversationId: completed.conversation.id });
      expect(completed.conversation).toMatchObject({ transportKind: 'codex_native', providerThreadId: 'thread-imported-1', legacySourceConversationId: source.id });
      expect(conversations.getById(source.id)?.archived).toBe(true);
      expect(completed.conversation.messages.map((message) => message.content)).toEqual(['原始问题']);
      expect(() => imports.markStarted(created.id, 'provider-import-2')).toThrow(/transition/iu);

      const rollbackSource = conversations.create({ projectId: project.id, title: '回滚旧会话', transportKind: 'legacy_cli' });
      const rollbackRun = imports.createRun({
        sourceConversationId: rollbackSource.id,
        snapshotPath: join(dir, 'projects', 'rollback.jsonl'),
        snapshotSha256: 'b'.repeat(64),
        providerBinaryVersion: '0.144.2',
      });
      imports.markStarted(rollbackRun.id, 'provider-import-2');
      expect(() => imports.bindThreadAndArchiveSource({ id: rollbackRun.id, targetThreadId: 'thread-imported-1', providerBinaryVersion: '0.144.2' })).toThrow();
      expect(conversations.getById(rollbackSource.id)?.archived).toBe(false);
      expect(imports.getById(rollbackRun.id)?.status).toBe('waiting');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a real SQLite file with core tables but no fake records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      expect(db.listTableNames()).toContain('projects');
      expect(db.listTableNames()).toContain('tasks');
      expect(db.listTableNames()).toContain('settings');
      expect(db.listTableNames()).toEqual(expect.arrayContaining(['conversation_turns', 'conversation_items', 'conversation_submissions', 'conversation_server_requests', 'idempotency_requests']));
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
        expect.objectContaining({
          migration_id: '20260713_0002_codex_native_conversation',
          description: expect.stringContaining('Codex native'),
          checksum: expect.stringMatching(/^sha256:/u),
        }),
        expect.objectContaining({
          migration_id: '20260714_0003_codex_legacy_import',
          description: expect.stringContaining('Codex legacy'),
          checksum: expect.stringMatching(/^sha256:/u),
        }),
        expect.objectContaining({
          migration_id: '20260715_0004_conversation_permission_mode',
          description: expect.stringContaining('权限模式'),
          checksum: expect.stringMatching(/^sha256:/u),
        }),
      ]);

      await db.save();
      const reopened = await createZeusDatabase(dbPath);
      const reopenedMigrations = reopened.select<{ migration_id: string }>('SELECT migration_id FROM schema_migrations ORDER BY migration_id');

      expect(reopenedMigrations).toEqual([
        { migration_id: '20260613_0001_core_schema' },
        { migration_id: '20260713_0002_codex_native_conversation' },
        { migration_id: '20260714_0003_codex_legacy_import' },
        { migration_id: '20260715_0004_conversation_permission_mode' },
      ]);
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
          { name: 'idx_conversations_provider_thread_id', tbl_name: 'conversations' },
          { name: 'idx_conversations_task_updated_at', tbl_name: 'conversations' },
          { name: 'idx_conversation_turn_provider', tbl_name: 'conversation_turns' },
          { name: 'idx_conversation_item_provider', tbl_name: 'conversation_items' },
          { name: 'idx_conversation_submission_idempotency', tbl_name: 'conversation_submissions' },
          { name: 'idx_conversation_server_request_provider', tbl_name: 'conversation_server_requests' },
          { name: 'idx_conversation_messages_provider_item', tbl_name: 'conversation_messages' },
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

  it('recovers interrupted project scans on repository startup instead of leaving projects permanently scanning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-scan-recovery-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const projects = new ProjectRepository(db);
      const project = projects.create({
        name: 'tc-app-core',
        localPath: '/Users/david/cckg/tcapp/Back-End/tc-app-core',
      });

      projects.updateScanStatus(project.id, 'scanning');
      await db.save();

      const reopened = await createZeusDatabase(dbPath);
      const recoveredProjects = new ProjectRepository(reopened);
      const recoveredCount = recoveredProjects.recoverInterruptedScans();

      expect(recoveredCount).toBe(1);
      expect(recoveredProjects.getById(project.id)?.scanStatus).toBe('failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the current in-flight scan untouched when recovering inactive scan leftovers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-scan-recovery-active-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const projects = new ProjectRepository(db);
      const stale = projects.create({
        name: 'tc-app-core',
        localPath: '/Users/david/cckg/tcapp/Back-End/tc-app-core',
      });
      const active = projects.create({
        name: 'Zeus E2E',
        localPath: '/Users/david/hypha/zeus',
      });

      projects.updateScanStatus(stale.id, 'scanning');
      projects.updateScanStatus(active.id, 'scanning');
      const recoveredCount = projects.recoverInterruptedScans([active.id]);

      expect(recoveredCount).toBe(1);
      expect(projects.getById(stale.id)?.scanStatus).toBe('failed');
      expect(projects.getById(active.id)?.scanStatus).toBe('scanning');
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

  it('migrates legacy conversation rows without changing messages and remains repeatable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-legacy-migration-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const SQL = await initSqlJs();
      const legacy = new SQL.Database();
      legacy.run(`
        CREATE TABLE schema_migrations (
          migration_id TEXT PRIMARY KEY, description TEXT NOT NULL,
          checksum TEXT NOT NULL, applied_at TEXT NOT NULL
        );
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, session_id TEXT,
          title TEXT NOT NULL, summary TEXT, status TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE conversation_messages (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
          content TEXT NOT NULL, source TEXT NOT NULL, metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      legacy.run(`INSERT INTO schema_migrations VALUES (?, ?, ?, ?)`, ['20260613_0001_core_schema', 'legacy core schema', 'sha256:legacy-checksum-sentinel', '2026-06-13T00:00:00.000Z']);
      legacy.run(`INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['legacy-conversation', 'project-1', 'task-1', 'session-1', '旧会话', '旧摘要', 'open', '2026-07-01T00:00:00.000Z', '2026-07-01T00:01:00.000Z', 0]);
      legacy.run(`INSERT INTO conversation_messages VALUES (?, ?, ?, ?, ?, ?, ?)`, ['legacy-message', 'legacy-conversation', 'user', '原始消息不得变更', 'runtime', '{"legacy":true}', '2026-07-01T00:00:30.000Z']);
      await writeFile(dbPath, Buffer.from(legacy.export()));
      legacy.close();

      const db = await createZeusDatabase(dbPath);
      expect(db.get<{ transport_kind: string; provider_thread_id: string | null }>(`SELECT transport_kind, provider_thread_id FROM conversations WHERE id = ?`, ['legacy-conversation'])).toEqual({
        transport_kind: 'legacy_cli',
        provider_thread_id: null,
      });
      expect(db.select<{ id: string; content: string; metadata_json: string }>(`SELECT id, content, metadata_json FROM conversation_messages`)).toEqual([
        { id: 'legacy-message', content: '原始消息不得变更', metadata_json: '{"legacy":true}' },
      ]);
      const oldChecksum = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = '20260613_0001_core_schema'`)?.checksum;
      expect(oldChecksum).toBe('sha256:legacy-checksum-sentinel');
      await db.save();

      const reopened = await createZeusDatabase(dbPath);
      expect(reopened.countRows('conversation_messages')).toBe(1);
      expect(reopened.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = '20260613_0001_core_schema'`)?.checksum).toBe(oldChecksum);
      expect(reopened.select<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = '20260713_0002_codex_native_conversation'`)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps provider thread and item identities unique while completed text overrides deltas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-identities-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const conversations = new ConversationRepository(db);
      const first = conversations.create({ projectId: 'project-1', title: '第一个', transportKind: 'codex_native', legacySourceConversationId: 'legacy-source-1' });
      const second = conversations.create({ projectId: 'project-1', title: '第二个', transportKind: 'codex_native' });
      conversations.bindProvider(first.id, {
        providerId: 'codex',
        providerThreadId: 'thread-1',
        providerThreadPath: '/tmp/thread-1.jsonl',
        providerModel: 'gpt-5.4',
        providerState: 'binding',
        providerProtocolVersion: '2',
        providerBinaryVersion: '1.2.3',
      });
      conversations.bindProvider(first.id, { providerId: 'codex', providerThreadId: 'thread-1', providerState: 'ready' });
      expect(conversations.getById(first.id)).toMatchObject({
        transportKind: 'codex_native',
        legacySourceConversationId: 'legacy-source-1',
        providerThreadId: 'thread-1',
        providerThreadPath: '/tmp/thread-1.jsonl',
        providerModel: 'gpt-5.4',
        providerProtocolVersion: '2',
        providerBinaryVersion: '1.2.3',
      });
      expect(() => conversations.bindProvider(second.id, { providerId: 'codex', providerThreadId: 'thread-1', providerState: 'ready' })).toThrow();

      const items = new ConversationItemRepository(db);
      const common = {
        conversationId: first.id,
        turnId: 'turn-local-1',
        providerThreadId: 'thread-1',
        providerTurnId: 'turn-provider-1',
        providerItemId: 'item-1',
        itemType: 'agentMessage' as const,
        phase: 'final_answer' as const,
        payload: { type: 'agentMessage' },
        updatedAt: '2026-07-13T01:00:00.000Z',
      };
      items.appendDelta({ ...common, delta: '部分' });
      items.appendDelta({ ...common, delta: '文本', updatedAt: '2026-07-13T01:00:01.000Z' });
      items.upsertCompleted({ ...common, textContent: '最终权威文本', completedAt: '2026-07-13T01:00:02.000Z', updatedAt: '2026-07-13T01:00:02.000Z' });
      items.upsertCompleted({ ...common, textContent: '最终权威文本', completedAt: '2026-07-13T01:00:02.000Z', updatedAt: '2026-07-13T01:00:02.000Z' });
      items.upsertCompleted({ ...common, status: 'in_progress', textContent: '过期回放', completedAt: null, updatedAt: '2026-07-13T01:00:03.000Z' });

      expect(db.countRows('conversation_items')).toBe(1);
      expect(items.getByProvider('thread-1', 'item-1')).toMatchObject({ status: 'completed', textContent: '最终权威文本' });
      expect(() => items.upsertCompleted({ ...common, status: 'unknown' as 'completed', textContent: '不应写入', completedAt: null })).toThrow('Unknown conversation item status');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists the Codex-compatible conversation permission mode and updates it explicitly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-permission-mode-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const conversations = new ConversationRepository(db);
      const conversation = conversations.create({ projectId: 'project-1', title: '权限模式', transportKind: 'codex_native', permissionMode: 'full-access' });
      expect(conversation.permissionMode).toBe('full-access');

      expect(conversations.updatePermissionMode(conversation.id, 'auto')).toMatchObject({ id: conversation.id, permissionMode: 'auto' });
      await db.save();

      const reopened = await createZeusDatabase(dbPath);
      expect(new ConversationRepository(reopened).getById(conversation.id)).toMatchObject({ permissionMode: 'auto' });
      expect(reopened.select<{ permission_mode: string }>('SELECT permission_mode FROM conversations WHERE id = ?', [conversation.id])).toEqual([{ permission_mode: 'auto' }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps one provider turn row and never regresses a completed turn on replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-turns-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const turns = new ConversationTurnRepository(db);
      const common = {
        conversationId: 'conversation-1',
        providerThreadId: 'thread-1',
        providerTurnId: 'provider-turn-1',
        clientSubmissionId: 'submission-1',
        error: undefined,
        startedAt: '2026-07-13T01:00:00.000Z',
        createdAt: '2026-07-13T01:00:00.000Z',
      };
      const completed = turns.upsert({ ...common, status: 'completed', completedAt: '2026-07-13T01:01:00.000Z', updatedAt: '2026-07-13T01:01:00.000Z' });
      const replayed = turns.upsert({ ...common, status: 'running', completedAt: null, updatedAt: '2026-07-13T01:00:30.000Z' });

      expect(db.countRows('conversation_turns')).toBe(1);
      expect(replayed).toEqual(completed);
      expect(() => turns.upsert({ ...common, providerTurnId: 'provider-turn-2', status: 'unknown' as 'running', completedAt: null, updatedAt: '2026-07-13T01:02:00.000Z' })).toThrow('Unknown conversation turn status');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('replays task and conversation idempotency results and rejects hash conflicts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-idempotency-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const requests = new IdempotencyRequestRepository(db);
      for (const scope of ['task:task-1', 'conversation:conversation-1']) {
        const input = {
          scope,
          idempotencyKey: 'same-key',
          requestHash: 'sha256:request-a',
          status: 'completed' as const,
          httpStatus: 202,
          response: { accepted: true },
          resourceId: 'resource-1',
          createdAt: '2026-07-13T02:00:00.000Z',
        };
        expect(requests.createOrGet(input)).toEqual(requests.createOrGet(input));
        expect(() => requests.createOrGet({ ...input, requestHash: 'sha256:request-b' })).toThrowError(expect.objectContaining({ code: 'ZEUS_IDEMPOTENCY_CONFLICT' }));
      }
      expect(db.countRows('idempotency_requests')).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps queued submissions out of transcript and upserts provider user messages by identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-submission-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const conversations = new ConversationRepository(db);
      const conversation = conversations.create({ projectId: 'project-1', title: '排队测试', transportKind: 'codex_native' });
      const submissions = new ConversationSubmissionRepository(db);
      const submission = submissions.createOrGet({
        conversationId: conversation.id,
        idempotencyKey: 'submission-key',
        requestHash: 'sha256:submission',
        clientMessageId: 'client-message-1',
        kind: 'message',
        requestedDelivery: 'queue',
        status: 'queued',
        queuePosition: 1,
        input: { text: '真实用户输入' },
        createdAt: '2026-07-13T03:00:00.000Z',
      });
      expect(conversations.listMessages(conversation.id)).toEqual([]);
      expect(submissions.createOrGet({ ...submission, input: { text: '不会覆盖' } }).id).toBe(submission.id);
      expect(() => submissions.createOrGet({ ...submission, requestHash: 'sha256:other' })).toThrowError(expect.objectContaining({ code: 'ZEUS_IDEMPOTENCY_CONFLICT' }));
      expect(() => submissions.createOrGet({ ...submission, idempotencyKey: 'unknown-delivery', requestedDelivery: 'later' as 'queue' })).toThrow('Unknown conversation submission requested delivery');

      const messageInput = {
        conversationId: conversation.id,
        role: 'user',
        content: '真实用户输入',
        source: 'codex_native',
        metadata: {},
        createdAt: '2026-07-13T03:01:00.000Z',
        providerThreadId: 'thread-1',
        providerTurnId: 'turn-1',
        providerItemId: 'user-item-1',
        clientMessageId: 'client-message-1',
      };
      conversations.appendMessage(messageInput);
      conversations.appendMessage(messageInput);
      expect(conversations.listMessages(conversation.id)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists task execution permissions and durable queued submission edits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-permissions-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const projects = new ProjectRepository(db);
      const project = projects.create({ name: 'Zeus', localPath: '/tmp/zeus-native-permissions' });
      const tasks = new TaskRepository(db);
      const task = tasks.create({
        projectId: project.id,
        title: '受限任务',
        description: '验证 native 权限映射',
        createdFrom: 'test',
        sourceContext: {},
        allowCodeChanges: true,
        allowTests: true,
        allowGitCommit: false,
      });

      expect(task).toMatchObject({ allowCodeChanges: true, allowTests: true, allowGitCommit: false });
      expect(tasks.getById(task.id)).toMatchObject({ allowCodeChanges: true, allowTests: true, allowGitCommit: false });

      const conversations = new ConversationRepository(db);
      const conversation = conversations.create({ projectId: project.id, taskId: task.id, title: '队列', transportKind: 'codex_native' });
      const submissions = new ConversationSubmissionRepository(db);
      const first = submissions.createOrGet({
        conversationId: conversation.id,
        idempotencyKey: 'queue-1',
        requestHash: 'sha256:queue-1',
        clientMessageId: 'client-1',
        kind: 'message',
        requestedDelivery: 'queue',
        status: 'queued',
        queuePosition: 1,
        input: { text: '第一条' },
        createdAt: '2026-07-13T03:00:00.000Z',
      });
      const second = submissions.createOrGet({
        conversationId: conversation.id,
        idempotencyKey: 'queue-2',
        requestHash: 'sha256:queue-2',
        clientMessageId: 'client-2',
        kind: 'message',
        requestedDelivery: 'queue',
        status: 'queued',
        queuePosition: 2,
        input: { text: '第二条' },
        createdAt: '2026-07-13T03:00:01.000Z',
      });
      submissions.updateQueuedInput(first.id, { requestHash: 'sha256:queue-1-edited', input: { text: '第一条（已编辑）' }, updatedAt: '2026-07-13T03:00:02.000Z' });
      submissions.reorderQueued(conversation.id, [second.id, first.id], '2026-07-13T03:00:03.000Z');
      await db.save();

      const reopened = await createZeusDatabase(dbPath);
      const persistedTasks = new TaskRepository(reopened);
      const persistedSubmissions = new ConversationSubmissionRepository(reopened).listByConversation(conversation.id);
      expect(persistedTasks.getById(task.id)).toMatchObject({ allowCodeChanges: true, allowTests: true, allowGitCommit: false });
      expect(persistedSubmissions.map((entry) => entry.id)).toEqual([second.id, first.id]);
      expect(JSON.parse(persistedSubmissions[1]!.inputJson)).toEqual({ text: '第一条（已编辑）' });
      expect(persistedSubmissions[1]!.requestHash).toBe('sha256:queue-1-edited');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists only recoverable native provider bindings and excludes closed or failed conversations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-recoverable-bindings-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const conversations = new ConversationRepository(db);
      const ready = conversations.create({ projectId: 'project-1', title: 'ready', transportKind: 'codex_native' });
      const closed = conversations.create({ projectId: 'project-1', title: 'closed', transportKind: 'codex_native' });
      const failed = conversations.create({ projectId: 'project-1', title: 'failed', transportKind: 'codex_native' });
      conversations.bindProvider(ready.id, { providerId: 'codex', providerThreadId: 'thread-ready', providerState: 'ready' });
      conversations.bindProvider(closed.id, { providerId: 'codex', providerThreadId: 'thread-closed', providerState: 'closed' });
      conversations.bindProvider(failed.id, { providerId: 'codex', providerThreadId: 'thread-failed', providerState: 'failed' });

      expect(conversations.listNativeBound().map((conversation) => conversation.id)).toEqual([ready.id]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes numeric and string provider request ids and never exports secret answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-secret-'));
    const dbPath = join(dir, 'zeus.db');
    const secret = 'ZEUS-SECRET-DO-NOT-PERSIST-7f91';
    try {
      const db = await createZeusDatabase(dbPath);
      const requests = new ConversationServerRequestRepository(db);
      const base = {
        conversationId: 'conversation-1',
        transportGenerationId: 'generation-1',
        requestKind: 'request_user_input' as const,
        payload: { questions: [{ id: 'question-1', header: '密钥', question: '请输入密钥', isSecret: true }] },
        status: 'pending' as const,
        createdAt: '2026-07-13T04:00:00.000Z',
      };
      const numeric = requests.upsert({ ...base, providerRequestId: 1 });
      expect(requests.upsert({ ...base, providerRequestId: 1 }).id).toBe(numeric.id);
      const textual = requests.upsert({ ...base, providerRequestId: '1' });
      expect(() => requests.upsert({ ...base, providerRequestId: 'unknown-kind', requestKind: 'unknown' as 'request_user_input' })).toThrow('Unknown conversation server request kind');
      requests.resolve(numeric.id, { response: { answers: { 'question-1': { answers: [secret] } } }, resolvedAt: '2026-07-13T04:01:00.000Z' });
      requests.upsert({ ...base, providerRequestId: 1, containsSecret: false, status: 'resolved', response: { answers: { 'question-1': secret } }, resolvedAt: '2026-07-13T04:01:00.000Z' });
      requests.upsert({ ...base, providerRequestId: 1, containsSecret: false, status: 'pending', response: undefined, resolvedAt: null });

      expect(numeric.providerRequestIdJson).toBe('1');
      expect(textual.providerRequestIdJson).toBe('"1"');
      expect(requests.getById(numeric.id)?.responseJson).toContain('[REDACTED]');
      expect(requests.getById(numeric.id)?.responseJson).not.toContain(secret);
      expect(JSON.parse(requests.getById(numeric.id)?.responseJson ?? '{}')).toEqual({ questionIds: ['question-1'], answerCount: 1, answers: '[REDACTED]' });
      expect(requests.getById(numeric.id)?.status).toBe('resolved');
      expect(db.countRows('conversation_server_requests')).toBe(2);
      const logicalDump = JSON.stringify(db.listTableNames().flatMap((table) => db.select<Record<string, unknown>>(`SELECT * FROM "${table}"`)));
      expect(logicalDump).not.toContain(secret);
      await db.save();
      expect((await readFile(dbPath)).toString('utf8')).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps generation-scoped server request method, payload, and status immutable across replays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-request-identity-'));
    try {
      const db = await createZeusDatabase(join(dir, 'zeus.db'));
      const requests = new ConversationServerRequestRepository(db);
      const base = {
        conversationId: 'conversation-identity',
        turnId: 'turn-identity',
        itemId: 'item-identity',
        transportGenerationId: 'generation-identity',
        providerRequestId: 'provider-request-identity',
        requestKind: 'command' as const,
        status: 'pending' as const,
        createdAt: '2026-07-13T04:10:00.000Z',
      };
      const original = requests.upsert({
        ...base,
        payload: { threadId: 'thread-identity', turnId: 'turn-identity', command: ['echo', 'safe'], metadata: { cwd: '/tmp', timeoutMs: 1_000 } },
      });

      const identicalReplay = requests.upsert({
        ...base,
        payload: { metadata: { timeoutMs: 1_000, cwd: '/tmp' }, command: ['echo', 'safe'], turnId: 'turn-identity', threadId: 'thread-identity' },
        createdAt: '2026-07-13T04:10:01.000Z',
      });
      expect(identicalReplay).toEqual(original);

      expect(() =>
        requests.upsert({
          ...base,
          requestKind: 'file',
          payload: { threadId: 'thread-identity', turnId: 'turn-identity', command: ['echo', 'safe'], metadata: { cwd: '/tmp', timeoutMs: 1_000 } },
          createdAt: '2026-07-13T04:10:02.000Z',
        }),
      ).toThrow(expect.objectContaining({ code: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT' }));
      expect(() =>
        requests.upsert({
          ...base,
          payload: { threadId: 'thread-identity', turnId: 'turn-identity', command: ['echo', 'mutated'], metadata: { cwd: '/tmp', timeoutMs: 1_000 } },
          createdAt: '2026-07-13T04:10:03.000Z',
        }),
      ).toThrow(expect.objectContaining({ code: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT' }));

      expect(requests.getById(original.id)).toEqual(original);
      const resolved = requests.resolve(original.id, { response: { decision: 'decline' }, resolvedAt: '2026-07-13T04:10:04.000Z' });
      const resolvedReplay = requests.upsert({
        ...base,
        payload: { command: ['echo', 'safe'], metadata: { timeoutMs: 1_000, cwd: '/tmp' }, threadId: 'thread-identity', turnId: 'turn-identity' },
        createdAt: '2026-07-13T04:10:05.000Z',
      });
      expect(resolvedReplay).toEqual(resolved);
      expect(resolvedReplay.status).toBe('resolved');
      expect(db.countRows('conversation_server_requests')).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists typed provider snapshots and ignores duplicate or older sequence updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-storage-native-snapshots-'));
    const dbPath = join(dir, 'zeus.db');
    try {
      const db = await createZeusDatabase(dbPath);
      const conversations = new ConversationRepository(db);
      const conversation = conversations.create({ projectId: 'project-1', title: '快照', transportKind: 'codex_native' });
      conversations.upsertProviderSettingsSnapshot(conversation.id, { generationId: 'generation-1', sequence: 5, model: 'gpt-5.4', effort: 'high' });
      conversations.upsertProviderSettingsSnapshot(conversation.id, { generationId: 'generation-1', sequence: 4, model: 'stale-model', effort: 'low' });
      conversations.upsertProviderTokenUsageSnapshot(conversation.id, { generationId: 'generation-1', sequence: 8, inputTokens: 100, outputTokens: 25, totalTokens: 125 });
      conversations.upsertProviderTokenUsageSnapshot(conversation.id, { generationId: 'generation-1', sequence: 8, inputTokens: 999, outputTokens: 999, totalTokens: 1998 });
      expect(() => conversations.upsertProviderSettingsSnapshot(conversation.id, { generationId: 'generation-1', sequence: 9, model: 'unsafe', effort: 'high', nested: { token: 'must-reject' } } as never)).toThrow(
        'Secret-like provider field rejected',
      );
      expect(() => conversations.upsertProviderTokenUsageSnapshot(conversation.id, { generationId: 'generation-1', sequence: 9, inputTokens: '100', outputTokens: 25, totalTokens: 125 } as never)).toThrow(
        'Invalid provider token usage snapshot',
      );

      const settings = new SettingRepository(db);
      settings.upsertCodexRateLimitsSnapshot({ generationId: 'generation-1', sequence: 7, value: { primary: { remaining: 42 } } });
      settings.upsertCodexRateLimitsSnapshot({ generationId: 'generation-1', sequence: 6, value: { primary: { remaining: 0 } } });
      settings.upsertCodexMcpStartupStatusSnapshot({ generationId: 'generation-1', sequence: 9, value: { filesystem: 'ready' } });
      expect(() => settings.upsertCodexRateLimitsSnapshot({ generationId: 'generation-1', sequence: 8, value: { primary: { remaining: 42, privateKey: 'must-reject' } } })).toThrow('Secret-like provider field rejected');
      for (const secretKey of ['apiKey', 'api_key', 'accessKey']) {
        expect(() => settings.upsertCodexRateLimitsSnapshot({ generationId: 'generation-1', sequence: 8, value: { primary: { remaining: 42, [secretKey]: 'must-reject' } } } as never)).toThrow('Secret-like provider field rejected');
      }
      expect(() => settings.upsertCodexMcpStartupStatusSnapshot({ generationId: 'generation-1', sequence: 10, value: { filesystem: { status: 'ready', nested: { cookie: 'must-reject' } } } })).toThrow('Secret-like provider field rejected');

      conversations.upsertProviderSettingsSnapshot(conversation.id, { generationId: 'generation-2', sequence: 1, model: 'gpt-5.5', effort: 'medium' });
      conversations.upsertProviderTokenUsageSnapshot(conversation.id, { generationId: 'generation-2', sequence: 2, inputTokens: 200, outputTokens: 50, totalTokens: 250 });
      settings.upsertCodexRateLimitsSnapshot({ generationId: 'generation-2', sequence: 3, value: { primary: { remaining: 80 } } });
      settings.upsertCodexMcpStartupStatusSnapshot({ generationId: 'generation-2', sequence: 4, value: { filesystem: 'restarted' } });
      await db.save();

      const reopened = await createZeusDatabase(dbPath);
      const persistedConversations = new ConversationRepository(reopened);
      const persistedSettings = new SettingRepository(reopened);
      persistedConversations.upsertProviderSettingsSnapshot(conversation.id, { generationId: 'generation-1', sequence: 99, model: 'late-old-generation', effort: 'low' });
      persistedConversations.upsertProviderTokenUsageSnapshot(conversation.id, { generationId: 'generation-1', sequence: 99, inputTokens: 999, outputTokens: 999, totalTokens: 1998 });
      persistedSettings.upsertCodexRateLimitsSnapshot({ generationId: 'generation-1', sequence: 99, value: { primary: { remaining: 0 } } });
      persistedSettings.upsertCodexMcpStartupStatusSnapshot({ generationId: 'generation-1', sequence: 99, value: { filesystem: 'late-old-generation' } });

      expect(persistedConversations.getProviderSettingsSnapshot(conversation.id)).toMatchObject({ generationId: 'generation-2', sequence: 1, model: 'gpt-5.5', effort: 'medium' });
      expect(persistedConversations.getProviderTokenUsageSnapshot(conversation.id)).toMatchObject({ generationId: 'generation-2', sequence: 2, totalTokens: 250 });
      expect(persistedSettings.getCodexRateLimitsSnapshot()).toMatchObject({ generationId: 'generation-2', sequence: 3, value: { primary: { remaining: 80 } } });
      expect(persistedSettings.getCodexMcpStartupStatusSnapshot()).toMatchObject({ generationId: 'generation-2', sequence: 4, value: { filesystem: 'restarted' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
