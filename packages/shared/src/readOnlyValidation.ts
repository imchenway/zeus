/**
 * SQLite Backup API 生成的正式数据副本，经 Main 核验后才会产生该描述符。
 *
 * 描述符只携带不可变身份和摘要，不携带 Provider、Telegram、Keychain 或 API 凭据；
 * Main、Detached Core 与 Local Server 必须逐层原样绑定同一 manifestHash。
 */
export interface ReadOnlyValidationDescriptor {
  readonly formatVersion: 2 | 3 | 4;
  readonly mode: 'read_only_validation';
  readonly runId: string;
  readonly createdAt: string;
  readonly copyPlanHash: string;
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly validationRoot: string;
  readonly allowedApplication: {
    readonly bundleId: 'dev.hypha.zeus.test';
    readonly executableName: 'Zeus Test';
  };
  readonly source: {
    readonly path: string;
    readonly inferredDataRoot: string;
    readonly device: string;
    readonly inode: string;
    readonly sha256?: string;
    readonly bytes?: number;
    readonly treeImmutability: 'required_quiescent' | 'online_backup_snapshot';
  };
  /**
   * formatVersion=3 的在线 WAL 快照证据。它描述 Backup API 的有界窗口，
   * 不授权 Test 在启动后继续读取或复核正式来源数据库。
   */
  readonly backup?: {
    readonly startedAt: string;
    readonly completedAt: string;
    readonly sourcePageCountBefore: number;
    readonly sourcePageCountAfter: number;
    readonly sourceDataVersionBefore: number;
    readonly sourceDataVersionAfter: number;
    readonly targetPageCount: number;
    readonly pageSize: number;
    readonly sourceAdvancedAfterBackup: boolean;
  };
  /**
   * formatVersion=4 在在线快照连接关闭后，只对尚未发布的候选副本执行当前
   * schema 迁移。正式来源没有 writer fence 之外的任何变更，Test 启动也不会迁移。
   */
  readonly migration?: {
    readonly strategy: 'offline_candidate_schema_migration';
    readonly startedAt: string;
    readonly completedAt: string;
    readonly sourceAccessClosedBeforeMigration: true;
    readonly runtimeWriterCount: 0;
    readonly rollbackWindow: 'source_unchanged_candidate_only';
    readonly preMigrationPageCount: number;
    readonly preMigrationSchemaSha256: string;
    readonly preMigrationLedgerSha256: string;
    readonly postMigrationPageCount: number;
    readonly postMigrationSchemaSha256: string;
    readonly postMigrationLedgerSha256: string;
    readonly appliedMigrationIds: readonly string[];
  };
  readonly database: {
    readonly path: string;
    readonly device: string;
    readonly inode: string;
    readonly nlink: 1;
    readonly sha256: string;
    readonly bytes: number;
    readonly schemaSha256: string;
    readonly journalMode: 'delete';
  };
}

/** Detached Core/rendezvous 只需要公开这组非敏感绑定事实。 */
export interface ReadOnlyValidationIdentity {
  readonly mode: 'read_only_validation';
  readonly runId: string;
  readonly manifestHash: string;
  readonly databaseSha256: string;
}

export function readOnlyValidationIdentity(descriptor: ReadOnlyValidationDescriptor): ReadOnlyValidationIdentity {
  return {
    mode: descriptor.mode,
    runId: descriptor.runId,
    manifestHash: descriptor.manifestHash,
    databaseSha256: descriptor.database.sha256,
  };
}

export function sameReadOnlyValidationIdentity(left: ReadOnlyValidationIdentity | undefined, right: ReadOnlyValidationIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return left.mode === right.mode && left.runId === right.runId && left.manifestHash === right.manifestHash && left.databaseSha256 === right.databaseSha256;
}
