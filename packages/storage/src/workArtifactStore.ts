import { createHash } from 'node:crypto';
import type { ArtifactRef } from './artifactStore.js';
import type { ZeusDatabasePort } from './databasePort.js';
import { TaskWorkStoreError } from './taskWorkStore.js';

/** 一份正式成果内可按需读取的固定文件。 */
export interface WorkArtifactFile {
  /** 发布目录内的安全相对路径。 */
  path: string;
  /** 内容寻址存储中的不可变引用。 */
  ref: ArtifactRef;
}

/** 正式成果与可重建目录的耐久关系，不以磁盘目录推动流程。 */
export interface WorkArtifactPublication {
  /** 原工作交付物的稳定身份。 */
  deliverableId: string;
  /** 不随任务编码变化的任务身份。 */
  taskId: string;
  /** 准确工作运行身份。 */
  runId: string;
  /** 已冻结文件清单。 */
  files: WorkArtifactFile[];
  /** 最近实际写出的目录；失败或尚未导出时为空。 */
  exportedRoot: string | null;
  /** 目录导出失败不改变模型运行结果。 */
  exportError: string | null;
  /** 最后一次发布尝试时间。 */
  updatedAt: string;
}

/** 成果目录迁移只登记新关系，不改写已有成果正文。 */
export function migrateWorkArtifactSchema(db: ZeusDatabasePort): void {
  /** 迁移名称没有含糊的版本别名。 */
  const id = '20261005_work_artifact_publication';
  db.transaction(() => {
    db.execute(`CREATE TABLE IF NOT EXISTS work_artifact_submissions (run_id TEXT NOT NULL REFERENCES task_work_runs(id), path TEXT NOT NULL, ref_json TEXT NOT NULL CHECK(json_valid(ref_json)), PRIMARY KEY(run_id,path))`);
    db.execute(
      `CREATE TABLE IF NOT EXISTS work_artifact_publications (deliverable_id TEXT PRIMARY KEY REFERENCES task_work_deliverables(id), task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES task_work_runs(id), files_json TEXT NOT NULL CHECK(json_valid(files_json)), exported_root TEXT, export_error TEXT, updated_at TEXT NOT NULL)`,
    );
    db.execute('CREATE INDEX IF NOT EXISTS idx_work_artifact_task ON work_artifact_publications(task_id,run_id)');
    db.execute(`CREATE TABLE IF NOT EXISTS work_task_doc_locations (task_id TEXT PRIMARY KEY REFERENCES tasks(id), root TEXT NOT NULL, owned_files_json TEXT NOT NULL CHECK(json_valid(owned_files_json)))`);
    if (!db.select<{ name: string }>('PRAGMA table_info(work_task_doc_locations)').some((column) => column.name === 'legacy_sources_json'))
      db.execute(`ALTER TABLE work_task_doc_locations ADD COLUMN legacy_sources_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(legacy_sources_json))`);
    db.execute('INSERT OR IGNORE INTO schema_migrations(migration_id,description,checksum,applied_at) VALUES(?,?,?,?)', [id, '工作成果冻结清单与可恢复任务目录', createHash('sha256').update(id).digest('hex'), new Date().toISOString()]);
  });
}

/** 复用 Task Work 的工作与交付物身份，文件状态不另建执行账本。 */
export class WorkArtifactRepository {
  /** 所有关系仍保存到同一 Core 数据库。 */
  constructor(private readonly db: ZeusDatabasePort) {}

  /** 旧返工尚未派发时，从唯一正式审查事件补齐交接；已开始的工作上下文永不改写。 */
  restorePreparedReworkHandoff(runId: string): boolean {
    return this.db.transaction(() => {
      /** 恢复只处理原工作项仍指向的未执行轮次，不能借历史事件扩大已有会话权限。 */
      const run = this.db.get<{ task_id: string; project_id: string; work_item_id: string; attempt: number; revision: number; entrypoint_snapshot_json: string }>(
        `SELECT run.* FROM task_work_runs run JOIN task_work_items item ON item.id=run.work_item_id AND item.current_run_id=run.id
         WHERE run.id=? AND run.status='prepared' AND run.conversation_id IS NULL AND run.command_run_id IS NULL AND run.started_at IS NULL`,
        [runId],
      );
      if (!run) return false;
      /** 团队返工读取准确冻结尝试链，普通返工仅读取原审查事件。 */
      const snapshot = JSON.parse(run.entrypoint_snapshot_json) as Record<string, unknown>;
      if (typeof snapshot.reworkDeliverableId === 'string' && Array.isArray(snapshot.upstreamDeliverableIds) && snapshot.upstreamDeliverableIds.includes(snapshot.reworkDeliverableId)) return false;
      if (snapshot.digitalTeamPurpose) {
        /** 同节点紧邻的失效尝试是唯一前次来源，正式成果还须对应其准确工作身份。 */
        const prior = this.db.select<{ deliverable_id: string | null; owned_id: string | null }>(
          `SELECT previous.deliverable_id,deliverable.id AS owned_id FROM digital_team_node_attempts current
           JOIN digital_team_workflow_runs team ON team.id=current.run_id AND team.task_id=? AND team.project_id=?
           JOIN digital_team_node_attempts previous ON previous.run_id=current.run_id AND previous.node_id=current.node_id AND previous.attempt=current.attempt-1 AND previous.status='invalidated'
           LEFT JOIN task_work_deliverables deliverable ON deliverable.id=previous.deliverable_id AND deliverable.task_id=team.task_id AND deliverable.project_id=team.project_id AND deliverable.run_id=previous.work_run_id AND deliverable.work_item_id=previous.work_item_id
           WHERE current.work_run_id=? AND current.work_item_id=?`,
          [run.task_id, run.project_id, runId, run.work_item_id],
        );
        if (!prior.length || (prior.length === 1 && !prior[0]!.deliverable_id)) return false;
        if (prior.length !== 1 || prior[0]!.owned_id !== prior[0]!.deliverable_id) throw new TaskWorkStoreError('ZEUS_TASK_WORK_REWORK_HANDOFF_UNRESOLVED', '团队返工的前次正式成果无法唯一核对，请检查原节点尝试。');
        const deliverableId = prior[0]!.owned_id!;
        if (Array.isArray(snapshot.upstreamDeliverableIds) && snapshot.upstreamDeliverableIds.includes(deliverableId)) return false;
        snapshot.reworkDeliverableId = deliverableId;
        snapshot.upstreamDeliverableIds = [...new Set([...(Array.isArray(snapshot.upstreamDeliverableIds) ? snapshot.upstreamDeliverableIds.filter((id): id is string => typeof id === 'string') : []), deliverableId])];
        this.db.execute('UPDATE task_work_runs SET entrypoint_snapshot_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', [JSON.stringify(snapshot), new Date().toISOString(), runId, run.revision]);
        return true;
      }
      if (typeof snapshot.reworkReason !== 'string') return false;
      /** 事件、前次运行及正式成果必须准确属于同一工作项，缺失或多份来源保持阻塞。 */
      const sources = this.db.select<{ deliverable_id: string }>(
        `SELECT deliverable.id AS deliverable_id FROM task_events event
         JOIN task_work_runs previous ON previous.id=json_extract(event.payload_json,'$.previousRunId') AND previous.work_item_id=? AND previous.task_id=? AND previous.project_id=? AND previous.attempt=? AND previous.status='failed' AND previous.error_code='ZEUS_TASK_WORK_CHANGES_REQUESTED'
         JOIN task_work_deliverables deliverable ON deliverable.id=json_extract(event.payload_json,'$.deliverableId') AND deliverable.run_id=previous.id AND deliverable.work_item_id=previous.work_item_id AND deliverable.task_id=previous.task_id AND deliverable.project_id=previous.project_id AND deliverable.status='changes_requested'
         WHERE event.task_id=? AND event.event_type='task.work_deliverable.changes_requested' AND json_extract(event.payload_json,'$.runId')=? AND json_extract(event.payload_json,'$.workItemId')=?`,
        [run.work_item_id, run.task_id, run.project_id, run.attempt - 1, run.task_id, runId, run.work_item_id],
      );
      if (sources.length !== 1) throw new TaskWorkStoreError('ZEUS_TASK_WORK_REWORK_HANDOFF_UNRESOLVED', '旧返工的前次成果来源无法唯一核对，请通过正常审查建立新返工。');
      /** 只追加此次被要求修改的准确成果，其余冻结交接范围保持原样。 */
      const deliverableId = sources[0]!.deliverable_id;
      if (snapshot.reworkDeliverableId && snapshot.reworkDeliverableId !== deliverableId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_REWORK_HANDOFF_UNRESOLVED', '旧返工的正式成果来源存在冲突，请核对原审查记录。');
      snapshot.reworkDeliverableId = deliverableId;
      snapshot.upstreamDeliverableIds = [...new Set([...(Array.isArray(snapshot.upstreamDeliverableIds) ? snapshot.upstreamDeliverableIds.filter((id): id is string => typeof id === 'string') : []), deliverableId])];
      this.db.execute('UPDATE task_work_runs SET entrypoint_snapshot_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', [JSON.stringify(snapshot), new Date().toISOString(), runId, run.revision]);
      return true;
    });
  }

  /** 工作结束前可再次提交同一路径，正式冻结后不能替换。 */
  submit(runId: string, file: WorkArtifactFile): void {
    if (this.db.get('SELECT deliverable_id FROM work_artifact_publications WHERE run_id = ?', [runId])) throw new TaskWorkStoreError('ZEUS_WORK_ARTIFACT_FROZEN', '本轮正式成果已经冻结，不能替换文件。');
    this.db.execute('INSERT INTO work_artifact_submissions(run_id,path,ref_json) VALUES(?,?,?) ON CONFLICT(run_id,path) DO UPDATE SET ref_json=excluded.ref_json', [runId, file.path, JSON.stringify(file.ref)]);
  }

  /** 只返回该工作显式提交的文件。 */
  submissions(runId: string): WorkArtifactFile[] {
    return this.db.select<{ path: string; ref_json: string }>('SELECT path,ref_json FROM work_artifact_submissions WHERE run_id = ? ORDER BY path', [runId]).map((row) => ({ path: row.path, ref: JSON.parse(row.ref_json) as ArtifactRef }));
  }

  /** 同一成果身份只能绑定一份冻结清单，重入只返回原记录。 */
  freeze(input: Pick<WorkArtifactPublication, 'deliverableId' | 'taskId' | 'runId' | 'files'>): WorkArtifactPublication {
    /** 文件清单由 Core 生成，不从磁盘目录反推正式关系。 */
    const existing = this.get(input.deliverableId);
    if (existing) return existing;
    this.db.execute('INSERT INTO work_artifact_publications(deliverable_id,task_id,run_id,files_json,updated_at) VALUES(?,?,?,?,?)', [input.deliverableId, input.taskId, input.runId, JSON.stringify(input.files), new Date().toISOString()]);
    return this.get(input.deliverableId)!;
  }

  /** 读取固定成果的文件清单。 */
  get(deliverableId: string): WorkArtifactPublication | undefined {
    /** 行类型局限于该表，不把原始 JSON 暴露给调用者。 */
    const row = this.db.get<{ deliverable_id: string; task_id: string; run_id: string; files_json: string; exported_root: string | null; export_error: string | null; updated_at: string }>(
      'SELECT * FROM work_artifact_publications WHERE deliverable_id = ?',
      [deliverableId],
    );
    return row
      ? { deliverableId: row.deliverable_id, taskId: row.task_id, runId: row.run_id, files: JSON.parse(row.files_json) as WorkArtifactFile[], exportedRoot: row.exported_root, exportError: row.export_error, updatedAt: row.updated_at }
      : undefined;
  }

  /** 按稳定任务身份重建，任务重编号不影响成果归属。 */
  list(taskId: string): WorkArtifactPublication[] {
    return this.db.select<{ deliverable_id: string }>('SELECT deliverable_id FROM work_artifact_publications WHERE task_id = ? ORDER BY updated_at,deliverable_id', [taskId]).map((row) => this.get(row.deliverable_id)!);
  }

  /** 保存实际导出结果，失败可以独立重试而无需重新执行员工。 */
  exported(deliverableId: string, root: string | null, error: string | null): void {
    this.db.execute('UPDATE work_artifact_publications SET exported_root=?,export_error=?,updated_at=? WHERE deliverable_id=?', [root, error, new Date().toISOString(), deliverableId]);
  }

  /** 目录中的已知哈希限制 Core 的覆盖权限。 */
  location(taskId: string): { root: string; ownedFiles: Record<string, string>; legacySources: Record<string, string> } | undefined {
    /** 旧位置属于稳定任务 ID，不从目录名称猜测。 */
    const row = this.db.get<{ root: string; owned_files_json: string; legacy_sources_json: string }>('SELECT * FROM work_task_doc_locations WHERE task_id=?', [taskId]);
    return row ? { root: row.root, ownedFiles: JSON.parse(row.owned_files_json) as Record<string, string>, legacySources: JSON.parse(row.legacy_sources_json) as Record<string, string> } : undefined;
  }

  /** 仅在成功写出后记下实际位置和校验摘要。 */
  saveLocation(taskId: string, root: string, ownedFiles: Record<string, string>, legacySources: Record<string, string> = {}): void {
    this.db.execute(
      'INSERT INTO work_task_doc_locations(task_id,root,owned_files_json,legacy_sources_json) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET root=excluded.root,owned_files_json=excluded.owned_files_json,legacy_sources_json=excluded.legacy_sources_json',
      [taskId, root, JSON.stringify(ownedFiles), JSON.stringify(legacySources)],
    );
  }

  /** 正式修复读取原失败成果；父流程只回收本闭环已完成修复的接纳成果。 */
  repairHandoff(taskId: string, sourceRef: string, deliverableId: string): boolean {
    if (
      this.db.get(
        `SELECT defect.id FROM defect_workflow_records defect JOIN digital_team_node_attempts source ON source.id=defect.source_attempt_id WHERE defect.defect_task_id=? AND source.deliverable_id=? AND defect.repair_run_id IS NOT NULL AND substr(?,1,length('digital-team:' || defect.repair_run_id || ':')) = 'digital-team:' || defect.repair_run_id || ':'`,
        [taskId, deliverableId, sourceRef],
      )
    )
      return true;
    /** 反向交接同时核对父任务、父流程、修复流程和正式结果，不能凭子任务身份扩大读取。 */
    return Boolean(
      this.db.get(
        `SELECT defect.id FROM defect_workflow_records defect
       JOIN digital_team_workflow_runs parent ON parent.id=defect.parent_run_id AND parent.task_id=defect.parent_task_id
       JOIN digital_team_workflow_runs repair ON repair.id=defect.repair_run_id AND repair.task_id=defect.defect_task_id AND repair.project_id=parent.project_id AND repair.status='completed'
       JOIN digital_team_node_attempts attempt ON attempt.run_id=repair.id AND attempt.status='succeeded' AND attempt.deliverable_id=?
       JOIN task_work_deliverables deliverable ON deliverable.id=attempt.deliverable_id AND deliverable.run_id=attempt.work_run_id AND deliverable.work_item_id=attempt.work_item_id AND deliverable.task_id=defect.defect_task_id AND deliverable.project_id=parent.project_id AND deliverable.status='accepted'
       WHERE defect.parent_task_id=? AND defect.status IN ('awaiting_retest','accepted') AND substr(?,1,length('digital-team:' || parent.id || ':'))='digital-team:' || parent.id || ':'`,
        [deliverableId, taskId, sourceRef],
      ),
    );
  }

  /** 实际读取时再次从本工作记录校验同一正式缺陷交接关系。 */
  repairHandoffForRun(runId: string, deliverableId: string): boolean {
    const run = this.db.get<{ task_id: string; source_ref: string | null }>('SELECT run.task_id,item.source_ref FROM task_work_runs run JOIN task_work_items item ON item.id=run.work_item_id WHERE run.id=?', [runId]);
    return Boolean(run?.source_ref && this.repairHandoff(run.task_id, run.source_ref, deliverableId));
  }

  /** 既有调度循环只领取少量待导出或任务重编号的目录，失败后留出恢复间隔。 */
  pendingTaskIds(limit: number, eligibleBefore: string): string[] {
    return this.db
      .select<{ task_id: string }>(
        `SELECT publication.task_id FROM work_artifact_publications publication JOIN tasks task ON task.id=publication.task_id LEFT JOIN work_task_doc_locations location ON location.task_id=task.id WHERE publication.updated_at<=? AND (publication.exported_root IS NULL OR publication.export_error IS NOT NULL OR location.root IS NULL OR substr(location.root,-length(task.task_code)-1)<>'/' || task.task_code) GROUP BY publication.task_id ORDER BY MIN(publication.updated_at),publication.task_id LIMIT ?`,
        [eligibleBefore, limit],
      )
      .map((row) => row.task_id);
  }
}
