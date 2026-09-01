import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';

export const digitalEmployeeLegacyRetirementMigrationId = '20260901_0001_digital_employee_legacy_runtime_retired';

/**
 * 旧执行表继续作为只读历史证据保留；这里只收口已经没有活动提交的陈旧状态，
 * 不删除会话、提交、员工快照或交付状态，也不把历史输出冒充为已交付。
 */
export function migrateDigitalEmployeeLegacyRetirement(db: ZeusDatabasePort): void {
  const checksumSource = ['digital_employee_executions:retire-legacy-runtime', 'preserve-all-legacy-evidence', 'cancel-only-without-nonterminal-submission'].join(';');
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;

  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [digitalEmployeeLegacyRetirementMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('旧数字员工执行收口迁移账本与当前规则不一致。');
    if (existing) return;

    const retiredAt = new Date().toISOString();
    db.execute(
      `UPDATE digital_employee_executions
          SET status = 'cancelled',
              error_code = 'ZEUS_DIGITAL_EMPLOYEE_LEGACY_RUNTIME_RETIRED',
              error_message = '旧版单会话执行器已停用；历史会话、提交与执行快照仍保留为只读证据。',
              completed_at = COALESCE(completed_at, ?),
              finalized_at = COALESCE(finalized_at, ?),
              lease_owner = NULL,
              lease_expires_at = NULL,
              revision = revision + 1,
              updated_at = ?
        WHERE execution_mode = 'legacy_single_conversation'
          AND status IN ('queued', 'dispatching', 'running', 'waiting', 'delivery_pending')
          AND (
            conversation_id IS NULL
            OR NOT EXISTS (
              SELECT 1
                FROM conversation_submissions AS submission
               WHERE submission.conversation_id = digital_employee_executions.conversation_id
                 AND submission.status IN ('queued', 'dispatching', 'active', 'paused')
            )
          )`,
      [retiredAt, retiredAt, retiredAt],
    );
    db.execute(`INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [digitalEmployeeLegacyRetirementMigrationId, '停用旧数字员工单会话执行器并保留全部历史证据', checksum, retiredAt]);
  });
}
