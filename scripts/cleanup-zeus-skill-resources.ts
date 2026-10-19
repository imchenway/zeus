import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { taskWorkCurrentSkillReferenceChecksum, taskWorkCurrentSkillReferenceMigrationId, taskWorkSkillReferenceGeneration } from '../packages/storage/src/taskWorkStore.js';
import {
  assertOfflineMaintenance,
  assertHistoricalCleanupAvailable,
  inspectMaintenanceTree,
  maintenancePathContains,
  readMaintenanceAllowlist,
  readMaintenanceIdentity,
  readMaintenanceMetadata,
  requireMaintenanceDirectory,
  withMaintenanceLease,
  type MaintenancePathIdentity,
  type MaintenanceTreeFacts,
} from './maintenanceSafety.js';

/** 只回收旧资源内容，清单和回收凭证永久留在原快照路径。 */
const planFormat = 'zeus-skill-resource-cleanup-2026-10-19';
/** 每个快照完成后保留的资源回收凭证文件名。 */
const receiptName = 'resources-reclaimed.json';

/** 命令行默认只读；执行必须提供精确快照根白名单和计划摘要。 */
interface Arguments {
  /** 显式在线授权只忽略应用存活，引用、目录身份和目标占用保护继续生效。 */
  allowOnline: boolean;
  /** 正式数据根，不能直接指向资源子目录。 */
  dataRoot: string;
  /** 只允许白名单中的完整快照根参与回收。 */
  selectedPaths: string[] | null;
  /** 只有显式执行才允许修改文件。 */
  apply: boolean;
  /** 用户审阅的计划摘要全文。 */
  confirmation: string | null;
}

/** 实际可执行引用用于保护旧资源，历史正文和 catalog 不作为可执行引用。 */
interface ResourceReference {
  /** 引用所属记录，便于人工查明保留原因。 */
  owner: string;
  /** 当前仍可能读取的路径。 */
  path: string;
}

/** 单个物理资源目录的身份和内容树摘要。 */
interface Payload {
  /** 删除严格限制在当前快照的一级资源目录。 */
  path: string;
  /** 防止同名目录被替换。 */
  identity: MaintenancePathIdentity;
  /** 防止根目录身份不变但深层资源变化。 */
  tree: MaintenanceTreeFacts;
}

/** 快照根只作为审阅单位，不会被整体删除。 */
interface SnapshotCandidate {
  /** 原快照编号供历史界面继续读取。 */
  snapshotId: string;
  /** 保留此目录及 catalog.json。 */
  path: string;
  /** 快照根原始身份。 */
  identity: MaintenancePathIdentity;
  /** catalog 原字节摘要；执行不会改写 catalog。 */
  catalogSha256: string;
  /** 清单明确列出的一级资源目录。 */
  payloads: Payload[];
}

/** 计划包含所有保护理由，失败或未知布局不能静默进入回收。 */
interface Plan {
  /** 在线模式必须进入审阅摘要，默认仍要求离线。 */
  allowOnline: boolean;
  /** 当前维护格式。 */
  format: string;
  /** 平台也参与确认身份。 */
  platform: NodeJS.Platform;
  /** 文件写入和审计所属数据根。 */
  dataRoot: string;
  /** 唯一允许回收的旧 Skill 资源根。 */
  resourceRoot: string;
  /** 精确快照根白名单。 */
  selectedPaths: string[] | null;
  /** 当前存量执行引用；匹配这些路径的快照保持受保护。 */
  references: ResourceReference[];
  /** 旧授权和迁移核对失败时保护整个资源根。 */
  referenceBlockers: string[];
  /** 完成全部检查的快照。 */
  candidates: SnapshotCandidate[];
  /** 未纳入回收的精确路径和原因。 */
  protected: Array<{ path: string; reason: string }>;
}

/** 用于审计当前已删除子目录及异常，未知结果不能自动重放。 */
interface Result {
  /** 对应审阅的快照根。 */
  path: string;
  /** 已确认完成删除的一级资源目录。 */
  removedPaths: string[];
  /** 某项失败立即停止剩余计划。 */
  status: 'started' | 'removed' | 'failed';
  /** 失败原因，不包含完整数据库记录。 */
  error: string | null;
}

/** 有界收集结构化配置中的资源路径；不搜索会话正文或 Provider 历史。 */
function collectResourcePaths(value: unknown, owner: string, root: string, output: ResourceReference[], depth = 0): void {
  if (depth > 32) throw new Error('Skill 引用结构超过安全深度，已拒绝回收。');
  if (typeof value === 'string') {
    if (isAbsolute(value) && maintenancePathContains(root, value)) output.push({ owner, path: resolve(value) });
  } else if (Array.isArray(value)) for (const child of value) collectResourcePaths(child, owner, root, output, depth + 1);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) collectResourcePaths(child, owner, root, output, depth + 1);
}

/** 只读核对迁移、Artifact 旧授权和当前执行配置，禁止为维护偷偷迁移正式库。 */
function inspectReferences(dataRoot: string, resourceRoot: string): { references: ResourceReference[]; referenceBlockers: string[] } {
  const database = new DatabaseSync(join(dataRoot, 'data', 'zeus.db'), { readOnly: true, timeout: 3_000 });
  const references: ResourceReference[] = [];
  const referenceBlockers: string[] = [];
  try {
    database.exec('PRAGMA query_only=ON; BEGIN');
    /** 缺少任一所有权事实时不能将未知当作零引用。 */
    const hasTable = (name: string): boolean => Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
    for (const table of ['schema_migrations', 'task_work_runs', 'artifact_owners', 'artifact_retention_holds', 'runtime_sessions']) if (!hasTable(table)) throw new Error(`缺少资源所有权表：${table}`);
    const migration = database.prepare('SELECT checksum FROM schema_migrations WHERE migration_id=?').get(taskWorkCurrentSkillReferenceMigrationId) as { checksum: string } | undefined;
    if (migration?.checksum !== taskWorkCurrentSkillReferenceChecksum) referenceBlockers.push('正式数据库尚未完成经过核对的 Skill 当前引用迁移。');
    const owners = database.prepare("SELECT COUNT(*) AS count FROM artifact_owners WHERE owner_kind='task_work_run_skill'").get() as { count: number };
    const holds = database.prepare("SELECT COUNT(*) AS count FROM artifact_retention_holds WHERE owner_kind='task_work_run_skill' AND state='active'").get() as { count: number };
    if (owners.count || holds.count) referenceBlockers.push(`仍有旧 Skill Artifact owner ${owners.count} 条、有效保留 ${holds.count} 条。`);
    for (const row of database.prepare('SELECT id,skill_snapshot_json FROM task_work_runs').all() as Array<{ id: string; skill_snapshot_json: string }>) {
      const value = JSON.parse(row.skill_snapshot_json) as { generation?: string };
      if (value.generation !== taskWorkSkillReferenceGeneration) referenceBlockers.push(`任务运行 ${row.id} 仍使用旧 Skill 执行格式。`);
      collectResourcePaths(value, `task_work_run:${row.id}`, resourceRoot, references);
    }
    for (const row of database.prepare("SELECT id,cwd,args_json FROM runtime_sessions WHERE status IN ('running','orphan_detected')").all() as Array<{ id: string; cwd: string; args_json: string }>)
      collectResourcePaths([row.cwd, JSON.parse(row.args_json)], `runtime:${row.id}`, resourceRoot, references);
    if (hasTable('task_stage_attempts'))
      for (const row of database.prepare("SELECT id,source_snapshot_json FROM task_stage_attempts WHERE status IN ('starting','active','outcome_unknown')").all() as Array<{ id: string; source_snapshot_json: string }>)
        collectResourcePaths(JSON.parse(row.source_snapshot_json), `task_stage_attempt:${row.id}`, resourceRoot, references);
    database.exec('COMMIT');
    references.sort((left, right) => left.path.localeCompare(right.path) || left.owner.localeCompare(right.owner));
    return { references, referenceBlockers: [...new Set(referenceBlockers)].sort() };
  } finally {
    database.close();
  }
}

/** 检查快照与清单，只接受清单中直接指向的一级物理资源目录。 */
async function inspectSnapshot(path: string, references: ResourceReference[]): Promise<SnapshotCandidate> {
  await requireMaintenanceDirectory(path);
  const metadata = await readMaintenanceMetadata(join(path, 'catalog.json'));
  const catalog = JSON.parse(metadata.text) as { skills?: Array<{ path?: unknown }> };
  if (!Array.isArray(catalog.skills)) throw new Error('历史清单缺少 skills。');
  const allowed = new Set<string>();
  for (const skill of catalog.skills) {
    if (typeof skill.path !== 'string' || !isAbsolute(skill.path) || !maintenancePathContains(path, skill.path)) throw new Error('清单资源路径离开当前快照，需单独核对。');
    const first = relative(path, skill.path).split(sep)[0]!;
    if (!/^[a-f0-9]{24}$/u.test(first)) throw new Error('清单资源布局未知，继续保留。');
    allowed.add(first);
  }
  const children = await readdir(path, { withFileTypes: true });
  const payloads: Payload[] = [];
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    if (child.name === 'catalog.json' || child.name === receiptName) continue;
    if (!allowed.has(child.name) || !child.isDirectory() || child.isSymbolicLink()) throw new Error(`快照包含未由清单登记的内容：${child.name}`);
    const payload = join(path, child.name);
    if (references.some((reference) => maintenancePathContains(payload, reference.path) || maintenancePathContains(reference.path, payload))) throw new Error('资源仍有结构化执行引用，已保留。');
    payloads.push({ path: payload, identity: await readMaintenanceIdentity(payload), tree: await inspectMaintenanceTree(payload) });
  }
  if (payloads.length === 0) throw new Error('只保留历史清单，无资源内容需要删除。');
  if (children.some((child) => child.name === receiptName)) throw new Error('已有回收凭证但资源再次出现，不能追删新内容。');
  return { snapshotId: path.split(sep).at(-1)!, path, identity: await readMaintenanceIdentity(path), catalogSha256: metadata.sha256, payloads };
}

/** 默认完整盘点；白名单存在时只递归读取选中的快照，避免无关资源扫描。 */
async function createPlan(arguments_: Arguments): Promise<Plan> {
  await requireMaintenanceDirectory(arguments_.dataRoot);
  const resourceRoot = join(arguments_.dataRoot, 'artifacts', 'skill-resources');
  await requireMaintenanceDirectory(resourceRoot);
  const facts = inspectReferences(arguments_.dataRoot, resourceRoot);
  const plan: Plan = { format: planFormat, allowOnline: arguments_.allowOnline, platform: process.platform, dataRoot: arguments_.dataRoot, resourceRoot, selectedPaths: arguments_.selectedPaths, ...facts, candidates: [], protected: [] };
  for (const entry of (await readdir(resourceRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(resourceRoot, entry.name);
    if (!/^[a-f0-9]{64}$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      plan.protected.push({ path, reason: '不是受管历史快照；共享对象及未知内容保持不动。' });
      continue;
    }
    if (arguments_.selectedPaths && !arguments_.selectedPaths.includes(path)) {
      plan.protected.push({ path, reason: '不在本次快照根白名单。' });
      continue;
    }
    if (facts.referenceBlockers.length > 0) {
      plan.protected.push({ path, reason: '引用核对未通过，整个资源回收保持只读。' });
      continue;
    }
    try {
      plan.candidates.push(await inspectSnapshot(path, facts.references));
    } catch (error) {
      plan.protected.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
    if ((plan.candidates.length + plan.protected.length) % 100 === 0) process.stderr.write(`已盘点 ${plan.candidates.length + plan.protected.length} 个旧资源入口。\n`);
  }
  for (const path of arguments_.selectedPaths ?? [])
    if (!plan.candidates.some((candidate) => candidate.path === path) && !plan.protected.some((entry) => entry.path === path)) plan.protected.push({ path, reason: '白名单不是受管快照根，不会删除。' });
  return plan;
}

/** 审计事件只追加并同步落盘，未完成事件在重启后保持未知，不能自动重放。 */
async function writeAudit(path: string, value: unknown): Promise<void> {
  const handle = await open(`${path}.events.jsonl`, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...(value as Record<string, unknown>) })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 只删已核对的历史资源目录，catalog 原字节与快照根保持不变。 */
async function applyPlan(plan: Plan): Promise<unknown> {
  if (plan.referenceBlockers.length || !plan.selectedPaths || plan.selectedPaths.length !== plan.candidates.length || plan.selectedPaths.some((path) => !plan.candidates.some((candidate) => candidate.path === path)))
    throw new Error('白名单包含受保护、缺失或未知快照，整个计划不执行。');
  const paths = plan.candidates.map((candidate) => candidate.path);
  if (plan.allowOnline) await assertHistoricalCleanupAvailable(paths);
  else await assertOfflineMaintenance(plan.dataRoot, paths);
  const currentReferences = inspectReferences(plan.dataRoot, plan.resourceRoot);
  if (JSON.stringify(currentReferences) !== JSON.stringify({ references: plan.references, referenceBlockers: plan.referenceBlockers })) throw new Error('资源执行引用在确认后发生变化。');
  const auditRoot = join(plan.dataRoot, 'artifacts', 'maintenance');
  await mkdir(auditRoot, { recursive: true, mode: 0o700 });
  await requireMaintenanceDirectory(auditRoot);
  const reportPath = join(auditRoot, `skill-resource-cleanup-${randomUUID()}.json`);
  const results: Result[] = [];
  const before = await statfs(plan.dataRoot);
  const availableBytesBefore = Number(before.bavail) * Number(before.bsize);
  await writeFile(reportPath, `${JSON.stringify({ plan, results, availableBytesBefore }, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true });
  await writeFile(`${reportPath}.events.jsonl`, '', { flag: 'wx', mode: 0o600, flush: true });
  for (const candidate of plan.candidates) {
    const result: Result = { path: candidate.path, removedPaths: [], status: 'started', error: null };
    results.push(result);
    await writeAudit(reportPath, { event: 'snapshot_started', path: candidate.path });
    try {
      if (plan.allowOnline) await assertHistoricalCleanupAvailable([candidate.path]);
      else await assertOfflineMaintenance(plan.dataRoot, [candidate.path]);
      const references = inspectReferences(plan.dataRoot, plan.resourceRoot);
      if (references.referenceBlockers.length || JSON.stringify(references.references) !== JSON.stringify(plan.references)) throw new Error('引用事实在执行期间发生变化。');
      if (JSON.stringify(await inspectSnapshot(candidate.path, references.references)) !== JSON.stringify(candidate)) throw new Error('快照内容、身份或清单在确认后发生变化。');
      for (const payload of candidate.payloads) {
        if (JSON.stringify(await readMaintenanceIdentity(payload.path)) !== JSON.stringify(payload.identity)) throw new Error('资源目录在删除前发生替换，剩余内容已保留。');
        await rm(payload.path, { recursive: true, force: false, maxRetries: 40, retryDelay: 250 });
        result.removedPaths.push(payload.path);
      }
      if ((await readMaintenanceMetadata(join(candidate.path, 'catalog.json'))).sha256 !== candidate.catalogSha256) throw new Error('历史清单已变化，停止剩余计划。');
      await writeFile(
        join(candidate.path, receiptName),
        `${JSON.stringify({ format: planFormat, snapshotId: candidate.snapshotId, catalogSha256: candidate.catalogSha256, removedPaths: result.removedPaths, reportPath, completedAt: new Date().toISOString() }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      result.status = 'removed';
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
    }
    await writeAudit(reportPath, { event: 'snapshot_finished', result });
    if (result.status === 'failed') break;
  }
  const after = await statfs(plan.dataRoot);
  const outcome = {
    status: results.some((result) => result.status === 'failed') ? 'partially_completed' : 'completed',
    reportPath,
    results,
    availableBytesBefore,
    availableBytesAfter: Number(after.bavail) * Number(after.bsize),
    unattempted: plan.candidates.filter((candidate) => !results.some((result) => result.path === candidate.path)).map((candidate) => candidate.path),
  };
  await writeFile(`${reportPath}.result.json`, `${JSON.stringify(outcome, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true });
  await writeAudit(reportPath, { event: 'completed', status: outcome.status, resultPath: `${reportPath}.result.json` });
  if (outcome.status !== 'completed') process.exitCode = 1;
  return outcome;
}

/** 只读计划和实际执行使用同一参数解析，不接受模糊确认或资源根整体删除。 */
async function main(): Promise<void> {
  const values = parseArgs({ strict: true, options: { 'data-root': { type: 'string' }, 'paths-file': { type: 'string' }, 'allow-online': { type: 'boolean' }, apply: { type: 'boolean' }, confirmation: { type: 'string' } } }).values;
  const selectedPaths = await readMaintenanceAllowlist(values['paths-file'] ?? null);
  if (values.apply && !selectedPaths) throw new Error('执行回收必须提供审阅后的快照根 --paths-file。');
  const arguments_: Arguments = { allowOnline: values['allow-online'] ?? false, dataRoot: resolve(values['data-root'] ?? join(homedir(), '.zeus')), selectedPaths, apply: values.apply ?? false, confirmation: values.confirmation ?? null };
  const plan = await createPlan(arguments_);
  /** 在线确认不包含无关保护项，原批准资源树和当前执行引用仍全部进入摘要。 */
  const approvalFacts = plan.allowOnline
    ? {
        format: plan.format,
        allowOnline: true,
        platform: plan.platform,
        dataRoot: plan.dataRoot,
        resourceRoot: plan.resourceRoot,
        selectedPaths: plan.selectedPaths,
        references: plan.references,
        referenceBlockers: plan.referenceBlockers,
        candidates: plan.candidates,
      }
    : plan;
  const planHash = createHash('sha256').update(JSON.stringify(approvalFacts)).digest('hex');
  const expectedConfirmation = `DELETE ZEUS SKILL RESOURCES ${planHash}`;
  if (!arguments_.apply || arguments_.confirmation !== expectedConfirmation) {
    process.stdout.write(
      `${JSON.stringify({ status: 'confirmation_required', planHash, expectedConfirmation, summary: { snapshots: plan.candidates.length, protected: plan.protected.length, allocatedBytesEstimate: plan.candidates.reduce((sum, candidate) => sum + candidate.payloads.reduce((bytes, payload) => bytes + payload.tree.allocatedBytes, 0), 0) }, plan }, null, 2)}\n`,
    );
    if (arguments_.apply) process.exitCode = 2;
  } else process.stdout.write(`${JSON.stringify(await withMaintenanceLease(plan.dataRoot, () => applyPlan(plan)), null, 2)}\n`);
}

await main();
