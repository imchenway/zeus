import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';

/** 独立会话环境中一个 Git 仓库的恢复身份；共享目录的会话使用同一记录。 */
export interface ConversationWorktreeRecovery {
  /** 所属项目。 */
  projectId: string;
  /** 会话原执行根目录。 */
  rootPath: string;
  /** 原项目中的来源仓库目录。 */
  repositoryPath: string;
  /** 通过 Git 身份校验的工作树目录。 */
  worktreePath: string;
  /** 原检出分支；空串表示 detached HEAD。 */
  branchName: string;
  /** 删除前提交，用于恢复 detached HEAD。 */
  headSha: string;
}

/** 在现有 SQLite 迁移事务中登记恢复信息；清理不会删除 Git 分支。 */
export function migrateConversationWorktreeRecovery(db: ZeusDatabasePort): void {
  /** 独立记录迁移，已有数据库只建表一次。 */
  const migrationId = '20261104_conversation_worktree_recovery';
  if (db.get('SELECT 1 FROM schema_migrations WHERE migration_id=?', [migrationId])) return;
  db.transaction(() => {
    db.execute(`CREATE TABLE conversation_worktree_recovery (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, -- 所属项目
      root_path TEXT NOT NULL, -- 会话原执行根目录
      repository_path TEXT NOT NULL, -- 已校验的来源仓库绝对路径
      worktree_path TEXT NOT NULL, -- 已校验的工作树绝对路径
      branch_name TEXT NOT NULL, -- 原分支名，空串表示 detached HEAD
      head_sha TEXT NOT NULL, -- 删除前提交，空串表示尚无提交
      PRIMARY KEY(project_id, worktree_path)
    )`);
    db.execute('CREATE INDEX conversation_worktree_recovery_root ON conversation_worktree_recovery(project_id,root_path)');
    db.execute('INSERT INTO schema_migrations(migration_id,description,checksum,applied_at) VALUES(?,?,?,?)', [migrationId, '独立会话工作树清理与恢复身份', createHash('sha256').update(migrationId).digest('hex'), new Date().toISOString()]);
  });
}

/** 恢复记录先耐久保存，再允许回收目录；多次归档更新同一个仓库快照。 */
export class ConversationWorktreeRecoveryRepository {
  /** 使用业务数据库的耐久事务。 */
  constructor(private readonly db: ZeusDatabasePort) {}

  /** 按项目和执行根读取，禁止跨项目恢复其他目录。 */
  list(projectId: string, rootPath: string): ConversationWorktreeRecovery[] {
    return this.db.select<ConversationWorktreeRecovery>(
      'SELECT project_id AS projectId,root_path AS rootPath,repository_path AS repositoryPath,worktree_path AS worktreePath,branch_name AS branchName,head_sha AS headSha FROM conversation_worktree_recovery WHERE project_id=? AND root_path=? ORDER BY length(worktree_path),worktree_path',
      [projectId, rootPath],
    );
  }

  /** 物理删除前保存完整恢复身份。 */
  save(items: ConversationWorktreeRecovery[]): void {
    this.db.commitCriticalFactSync(() => {
      for (const item of items)
        this.db.execute(
          'INSERT INTO conversation_worktree_recovery(project_id,root_path,repository_path,worktree_path,branch_name,head_sha) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,worktree_path) DO UPDATE SET root_path=excluded.root_path,repository_path=excluded.repository_path,branch_name=excluded.branch_name,head_sha=excluded.head_sha',
          [item.projectId, item.rootPath, item.repositoryPath, item.worktreePath, item.branchName, item.headSha],
        );
    });
  }

  /** 全部成员恢复后撤销旧快照，下一次归档重新读取当前 Git 身份。 */
  clear(projectId: string, rootPath: string): void {
    this.db.commitCriticalFactSync(() => this.db.execute('DELETE FROM conversation_worktree_recovery WHERE project_id=? AND root_path=?', [projectId, rootPath]));
  }
}
