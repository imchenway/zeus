import { createHash } from 'node:crypto';
import { artifactRetentionPolicies, type ArtifactRetentionOwnerClass } from './artifactStore.js';
import type { ZeusDatabasePort } from './databasePort.js';

export const artifactRetentionLifecycleGeneration = '2026-08-21-artifact-retention-lifecycle-v1';

export interface ArtifactRetentionTransitionResult {
  generation: typeof artifactRetentionLifecycleGeneration;
  scope: { kind: 'conversation' | 'owner'; id: string; ownerKind?: string };
  ownerClass: ArtifactRetentionOwnerClass;
  artifacts: number;
  holdsActivated: number;
  holdsReleased: number;
  ownersDetached: number;
  retainUntil: string;
  transitionedAt: string;
}

export interface ArtifactRetentionSweepResult {
  generation: typeof artifactRetentionLifecycleGeneration;
  releasedDeletedOwnerHolds: number;
  sweptAt: string;
}

interface ArtifactOwnerRow {
  artifact_sha256: string;
  owner_kind: string;
  owner_id: string;
}

/**
 * 把业务生命周期翻译为 Artifact owner、保留锁与 GC 可回收性的原子状态转换。
 * archived/export/recovery 不会靠时间自动失效；删除 owner 只有在宽限期到期并执行 sweep 后才可进入 GC。
 */
export class ArtifactRetentionLifecycleService {
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  markTaskActive(input: { taskId: string; reason?: string; transitionedAt?: string }): ArtifactRetentionTransitionResult {
    const taskId = normalizeIdentity(input.taskId, 'taskId');
    return this.transitionOwner({
      owner: { kind: 'task', id: taskId },
      ownerClass: 'active_task',
      reason: input.reason ?? `任务 ${taskId} 仍处于活动生命周期`,
      transitionedAt: input.transitionedAt,
    });
  }

  markConversationActive(input: { conversationId: string; reason?: string; transitionedAt?: string }): ArtifactRetentionTransitionResult {
    return this.transitionConversation({
      conversationId: input.conversationId,
      ownerClass: 'active_conversation',
      reason: input.reason ?? `会话 ${input.conversationId} 仍处于活动生命周期`,
      transitionedAt: input.transitionedAt,
    });
  }

  archiveConversation(input: { conversationId: string; reason?: string; transitionedAt?: string }): ArtifactRetentionTransitionResult {
    return this.transitionConversation({
      conversationId: input.conversationId,
      ownerClass: 'archived_conversation',
      reason: input.reason ?? `会话 ${input.conversationId} 已归档`,
      transitionedAt: input.transitionedAt,
    });
  }

  deleteConversation(input: { conversationId: string; reason?: string; transitionedAt?: string }): ArtifactRetentionTransitionResult {
    return this.transitionConversation({
      conversationId: input.conversationId,
      ownerClass: 'deleted_owner',
      reason: input.reason ?? `会话 ${input.conversationId} 已删除，进入可恢复宽限期`,
      transitionedAt: input.transitionedAt,
      detachOwners: true,
    });
  }

  retainExport(input: { exportId: string; reason?: string; transitionedAt?: string }): ArtifactRetentionTransitionResult {
    const exportId = normalizeIdentity(input.exportId, 'exportId');
    return this.transitionOwner({
      owner: { kind: 'export', id: exportId },
      ownerClass: 'export',
      reason: input.reason ?? `导出 ${exportId} 仍由用户保留`,
      transitionedAt: input.transitionedAt,
    });
  }

  retainRestoredRecovery(input: { recoveryId: string; reason?: string; transitionedAt?: string }): ArtifactRetentionTransitionResult {
    const recoveryId = normalizeIdentity(input.recoveryId, 'recoveryId');
    return this.transitionOwner({
      owner: { kind: 'restored_recovery', id: recoveryId },
      ownerClass: 'restored_recovery',
      reason: input.reason ?? `恢复批次 ${recoveryId} 处于恢复保护期`,
      transitionedAt: input.transitionedAt,
    });
  }

  transitionConversation(input: { conversationId: string; ownerClass: 'active_conversation' | 'archived_conversation' | 'deleted_owner'; reason: string; transitionedAt?: string; detachOwners?: boolean }): ArtifactRetentionTransitionResult {
    const conversationId = normalizeIdentity(input.conversationId, 'conversationId');
    const owners = this.db.select<ArtifactOwnerRow>(
      `SELECT DISTINCT artifact_sha256, owner_kind, owner_id
         FROM artifact_owners
        WHERE conversation_id = ?
        ORDER BY artifact_sha256, owner_kind, owner_id`,
      [conversationId],
    );
    return this.transition({
      scope: { kind: 'conversation', id: conversationId },
      owners,
      ownerClass: input.ownerClass,
      reason: input.reason,
      transitionedAt: input.transitionedAt,
      detachOwners: input.detachOwners === true,
    });
  }

  transitionOwner(input: { owner: { kind: string; id: string }; ownerClass: ArtifactRetentionOwnerClass; reason: string; transitionedAt?: string; detachOwner?: boolean }): ArtifactRetentionTransitionResult {
    const ownerKind = normalizeIdentity(input.owner.kind, 'owner.kind');
    const ownerId = normalizeIdentity(input.owner.id, 'owner.id');
    const owners = this.db.select<ArtifactOwnerRow>(
      `SELECT artifact_sha256, owner_kind, owner_id
         FROM artifact_owners
        WHERE owner_kind = ? AND owner_id = ?
        ORDER BY artifact_sha256`,
      [ownerKind, ownerId],
    );
    return this.transition({
      scope: { kind: 'owner', id: ownerId, ownerKind },
      owners,
      ownerClass: input.ownerClass,
      reason: input.reason,
      transitionedAt: input.transitionedAt,
      detachOwners: input.detachOwner === true,
    });
  }

  /** export/recovery 等显式保留只有在调用方确认生命周期结束后才释放。 */
  releaseOwnerClass(input: { owner: { kind: string; id: string }; ownerClass: 'export' | 'restored_recovery'; releasedAt?: string }): number {
    const ownerKind = normalizeIdentity(input.owner.kind, 'owner.kind');
    const ownerId = normalizeIdentity(input.owner.id, 'owner.id');
    const releasedAt = normalizeTimestamp(input.releasedAt ?? this.now());
    return this.db.durableTransactionSync(() => {
      const count =
        this.db.get<{ row_count: number }>(
          `SELECT COUNT(*) AS row_count
             FROM artifact_retention_holds
            WHERE owner_kind = ? AND owner_id = ? AND owner_class = ? AND state = 'active'`,
          [ownerKind, ownerId, input.ownerClass],
        )?.row_count ?? 0;
      this.db.execute(
        `UPDATE artifact_retention_holds
            SET state = 'released', released_at = ?
          WHERE owner_kind = ? AND owner_id = ? AND owner_class = ? AND state = 'active'`,
        [releasedAt, ownerKind, ownerId, input.ownerClass],
      );
      return count;
    });
  }

  /** 只自动释放已删除 owner 的宽限锁；活动、归档、导出与恢复锁均需显式生命周期事件。 */
  sweepExpiredDeletedOwners(input: { sweptAt?: string } = {}): ArtifactRetentionSweepResult {
    const sweptAt = normalizeTimestamp(input.sweptAt ?? this.now());
    const releasedDeletedOwnerHolds = this.db.durableTransactionSync(() => {
      const count =
        this.db.get<{ row_count: number }>(
          `SELECT COUNT(*) AS row_count
             FROM artifact_retention_holds
            WHERE owner_class = 'deleted_owner'
              AND state = 'active'
              AND retain_until IS NOT NULL
              AND retain_until <= ?`,
          [sweptAt],
        )?.row_count ?? 0;
      this.db.execute(
        `UPDATE artifact_retention_holds
            SET state = 'released', released_at = ?
          WHERE owner_class = 'deleted_owner'
            AND state = 'active'
            AND retain_until IS NOT NULL
            AND retain_until <= ?`,
        [sweptAt, sweptAt],
      );
      return count;
    });
    return { generation: artifactRetentionLifecycleGeneration, releasedDeletedOwnerHolds, sweptAt };
  }

  private transition(input: {
    scope: ArtifactRetentionTransitionResult['scope'];
    owners: ArtifactOwnerRow[];
    ownerClass: ArtifactRetentionOwnerClass;
    reason: string;
    transitionedAt?: string;
    detachOwners: boolean;
  }): ArtifactRetentionTransitionResult {
    const transitionedAt = normalizeTimestamp(input.transitionedAt ?? this.now());
    const reason = normalizeReason(input.reason);
    const policy = artifactRetentionPolicies[input.ownerClass];
    if (!policy) throw new Error(`Artifact ownerClass 无效：${input.ownerClass}`);
    const retainUntil = new Date(Date.parse(transitionedAt) + policy.minimumRetentionMs).toISOString();
    const uniqueArtifacts = new Set(input.owners.map((owner) => owner.artifact_sha256));
    const transitionClasses: ArtifactRetentionOwnerClass[] = ['active_task', 'active_conversation', 'archived_conversation', 'deleted_owner'];

    const counts = this.db.durableTransactionSync(() => {
      let holdsReleased = 0;
      let holdsActivated = 0;
      let ownersDetached = 0;
      for (const owner of input.owners) {
        if (transitionClasses.includes(input.ownerClass)) {
          const placeholders = transitionClasses.map(() => '?').join(', ');
          holdsReleased +=
            this.db.get<{ row_count: number }>(
              `SELECT COUNT(*) AS row_count
                 FROM artifact_retention_holds
                WHERE artifact_sha256 = ? AND owner_kind = ? AND owner_id = ?
                  AND owner_class IN (${placeholders}) AND state = 'active'`,
              [owner.artifact_sha256, owner.owner_kind, owner.owner_id, ...transitionClasses],
            )?.row_count ?? 0;
          this.db.execute(
            `UPDATE artifact_retention_holds
                SET state = 'released', released_at = ?
              WHERE artifact_sha256 = ? AND owner_kind = ? AND owner_id = ?
                AND owner_class IN (${placeholders}) AND state = 'active'`,
            [transitionedAt, owner.artifact_sha256, owner.owner_kind, owner.owner_id, ...transitionClasses],
          );
        }

        const holdId = retentionHoldId(owner, input.ownerClass, reason);
        const existingActive = this.db.get<{ present: number }>(`SELECT 1 AS present FROM artifact_retention_holds WHERE id = ? AND state = 'active'`, [holdId]);
        this.db.execute(
          `INSERT INTO artifact_retention_holds
           (id, artifact_sha256, owner_kind, owner_id, owner_class, reason, state, retain_until, created_at, released_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
           ON CONFLICT(id) DO UPDATE SET
             state = 'active', retain_until = excluded.retain_until, released_at = NULL`,
          [holdId, owner.artifact_sha256, owner.owner_kind, owner.owner_id, input.ownerClass, reason, retainUntil, transitionedAt],
        );
        if (!existingActive) holdsActivated += 1;

        if (input.detachOwners) {
          this.db.execute(`DELETE FROM artifact_owners WHERE artifact_sha256 = ? AND owner_kind = ? AND owner_id = ?`, [owner.artifact_sha256, owner.owner_kind, owner.owner_id]);
          ownersDetached += 1;
        }
      }
      return { holdsReleased, holdsActivated, ownersDetached };
    });

    return {
      generation: artifactRetentionLifecycleGeneration,
      scope: input.scope,
      ownerClass: input.ownerClass,
      artifacts: uniqueArtifacts.size,
      holdsActivated: counts.holdsActivated,
      holdsReleased: counts.holdsReleased,
      ownersDetached: counts.ownersDetached,
      retainUntil,
      transitionedAt,
    };
  }
}

function retentionHoldId(owner: ArtifactOwnerRow, ownerClass: ArtifactRetentionOwnerClass, reason: string): string {
  return `artifact_hold_${createHash('sha256').update(`${owner.artifact_sha256}\0${owner.owner_kind}\0${owner.owner_id}\0${ownerClass}\0${reason}`).digest('hex').slice(0, 32)}`;
}

function normalizeIdentity(value: string, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 512 || !/^[\w:./@+-]+$/u.test(normalized)) throw new Error(`${field} 格式无效。`);
  return normalized;
}

function normalizeTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('Artifact 生命周期时间戳无效。');
  return new Date(value).toISOString();
}

function normalizeReason(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || Buffer.byteLength(normalized) > 4_096) throw new Error('Artifact 生命周期原因无效。');
  return normalized;
}
