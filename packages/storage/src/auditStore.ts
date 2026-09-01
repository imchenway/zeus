import {randomId} from './randomId.js';
import type {ZeusDatabasePort} from './databasePort.js';

export interface ZeusGitSnapshotRecord {
  id: string;
  taskId: string;
  projectId: string;
  snapshotType: string;
  branch: string | null;
  headSha: string | null;
  statusJson: string;
  diffTextPath: string | null;
  createdAt: string;
}

export interface ZeusGitChangeRecord {
  id: string;
  taskId: string;
  projectId: string;
  filePath: string;
  changeType: string;
  additions: number;
  deletions: number;
  diffHunkPath: string | null;
  linkedGraphNodesJson: string;
  createdAt: string;
}

export interface CreateGitSnapshotInput {
  taskId: string;
  projectId: string;
  snapshotType: string;
  branch?: string;
  headSha?: string;
  status: Record<string, unknown>;
  diffTextPath?: string;
  createdAt: string;
}

export interface CreateGitChangeInput {
  taskId: string;
  projectId: string;
  filePath: string;
  changeType: string;
  additions?: number;
  deletions?: number;
  diffHunkPath?: string;
  linkedGraphNodes?: string[];
  createdAt: string;
}

export interface ZeusAuditLogRecord {
  id: string;
  actorType: string;
  actorRef: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  payloadJson: string;
  createdAt: string;
}

export interface AppendAuditLogInput {
  actorType: string;
  actorRef?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class GitSnapshotRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  createSnapshot(input: CreateGitSnapshotInput): ZeusGitSnapshotRecord {
    const record: ZeusGitSnapshotRecord = {
        id: `git_snapshot_${randomId(12)}`,
      taskId: input.taskId,
      projectId: input.projectId,
      snapshotType: input.snapshotType,
      branch: input.branch ?? null,
      headSha: input.headSha ?? null,
      statusJson: JSON.stringify(input.status),
      diffTextPath: input.diffTextPath ?? null,
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO git_snapshots (id, task_id, project_id, snapshot_type, branch, head_sha, status_json, diff_text_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.taskId, record.projectId, record.snapshotType, record.branch, record.headSha, record.statusJson, record.diffTextPath, record.createdAt],
    );
    return record;
  }

  createChange(input: CreateGitChangeInput): ZeusGitChangeRecord {
    const record: ZeusGitChangeRecord = {
        id: `git_change_${randomId(12)}`,
      taskId: input.taskId,
      projectId: input.projectId,
      filePath: input.filePath,
      changeType: input.changeType,
      additions: input.additions ?? 0,
      deletions: input.deletions ?? 0,
      diffHunkPath: input.diffHunkPath ?? null,
      linkedGraphNodesJson: JSON.stringify(input.linkedGraphNodes ?? []),
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO git_changes (id, task_id, project_id, file_path, change_type, additions, deletions, diff_hunk_path, linked_graph_nodes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.taskId, record.projectId, record.filePath, record.changeType, record.additions, record.deletions, record.diffHunkPath, record.linkedGraphNodesJson, record.createdAt],
    );
    return record;
  }

  listSnapshots(taskId: string): ZeusGitSnapshotRecord[] {
    return this.db
      .select<DbGitSnapshotRow>(
        `SELECT id, task_id, project_id, snapshot_type, branch, head_sha, status_json, diff_text_path, created_at
       FROM git_snapshots WHERE task_id = ? ORDER BY created_at ASC`,
        [taskId],
      )
      .map(mapGitSnapshotRow);
  }

  listChanges(taskId: string): ZeusGitChangeRecord[] {
    return this.db
      .select<DbGitChangeRow>(
        `SELECT id, task_id, project_id, file_path, change_type, additions, deletions, diff_hunk_path, linked_graph_nodes_json, created_at
       FROM git_changes WHERE task_id = ? ORDER BY file_path ASC, created_at ASC`,
        [taskId],
      )
      .map(mapGitChangeRow);
  }
}

/** 审计日志仓储记录真实本地/远程动作，payload 由调用方传入且不写入默认假数据。 */
export class AuditLogRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  append(input: AppendAuditLogInput): ZeusAuditLogRecord {
    const record: ZeusAuditLogRecord = {
        id: `audit_log_${randomId(12)}`,
      actorType: input.actorType,
      actorRef: input.actorRef ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      payloadJson: JSON.stringify(input.payload),
      createdAt: input.createdAt,
    };
    this.db.execute(
      `INSERT INTO audit_logs (id, actor_type, actor_ref, action, resource_type, resource_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.actorType, record.actorRef, record.action, record.resourceType, record.resourceId, record.payloadJson, record.createdAt],
    );
    return record;
  }

  listRecent(limit = 20): ZeusAuditLogRecord[] {
    return this.db
      .select<DbAuditLogRow>(
        `SELECT id, actor_type, actor_ref, action, resource_type, resource_id, payload_json, created_at
       FROM audit_logs ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        [limit],
      )
      .map(mapAuditLogRow);
  }
}

interface DbGitSnapshotRow {
  id: string;
  task_id: string;
  project_id: string;
  snapshot_type: string;
  branch: string | null;
  head_sha: string | null;
  status_json: string;
  diff_text_path: string | null;
  created_at: string;
}

interface DbGitChangeRow {
  id: string;
  task_id: string;
  project_id: string;
  file_path: string;
  change_type: string;
  additions: number;
  deletions: number;
  diff_hunk_path: string | null;
  linked_graph_nodes_json: string;
  created_at: string;
}

interface DbAuditLogRow {
  id: string;
  actor_type: string;
  actor_ref: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  payload_json: string;
  created_at: string;
}

function mapGitSnapshotRow(row: DbGitSnapshotRow): ZeusGitSnapshotRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    snapshotType: row.snapshot_type,
    branch: row.branch,
    headSha: row.head_sha,
    statusJson: row.status_json,
    diffTextPath: row.diff_text_path,
    createdAt: row.created_at,
  };
}

function mapGitChangeRow(row: DbGitChangeRow): ZeusGitChangeRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    filePath: row.file_path,
    changeType: row.change_type,
    additions: row.additions,
    deletions: row.deletions,
    diffHunkPath: row.diff_hunk_path,
    linkedGraphNodesJson: row.linked_graph_nodes_json,
    createdAt: row.created_at,
  };
}

function mapAuditLogRow(row: DbAuditLogRow): ZeusAuditLogRecord {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorRef: row.actor_ref,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}
