import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

/** 子进程调用统一使用无 shell 的参数数组，避免路径被二次解释。 */
const executeFile = promisify(execFile);
/** 清理计划格式使用日期代次，避免把未来布局误认为当前布局。 */
const planFormat = 'zeus-generated-data-cleanup-2026-10-18';
/** 只有终态任务允许进入历史 worktree 清理计划。 */
const terminalTaskStatuses = new Set(['completed', 'cancelled']);
/** 这些目录是 Zeus 构建入口生成、删除后可重新生成的缓存。 */
const rebuildableCacheNames = ['cargo-target', 'zeus-release', 'release-candidate-v0.2.8', 'cua-driver-target-arm64', 'cua-driver-target-darwin-arm64', 'electron-dist', 'rust-toolchains', 'clang-module-cache', 'codex-runtime'] as const;
/** 发布失败现场可能仍有恢复价值，必须通过独立参数纳入计划。 */
const releaseRecoveryDirectoryName = 'zeus-release-isolated';
/** Windows 删除刚释放的 SQLite 或 Chromium 文件时允许短暂重试。 */
const deletionRetryCount = 40;
/** 每次 Windows 删除重试间隔四分之一秒。 */
const deletionRetryDelayMs = 250;

/** 命令行参数只允许显式覆盖根目录和两类有证据价值的数据。 */
interface CleanupArguments {
  apply: boolean;
  confirmation: string | null;
  dataRoot: string;
  repositoryPath: string;
  includeValidationSnapshots: boolean;
  includeReleaseRecovery: boolean;
  includeRepositoryTemp: boolean;
}

/** 数据库 owner 用于在物理目录回收后收敛对应路径状态。 */
interface WorktreeOwner {
  type: 'workspace' | 'integration' | 'attempt';
  id: string;
  taskId: string;
  taskCode: string | null;
  state: string;
  kind: string;
}

/** 数据库读取的 worktree 草稿在 Git 校验前不能直接删除。 */
interface WorktreeDraft {
  path: string;
  repositoryPath: string;
  owners: WorktreeOwner[];
}

/** 顶层身份用于确认 dry-run 与 apply 之间没有替换目标。 */
interface PathIdentity {
  present: boolean;
  device: string | null;
  inode: string | null;
  modifiedAtMs: string | null;
}

/** 可删除项只保存执行所需身份，不递归散列大型缓存。 */
interface CleanupCandidate {
  kind: 'task_worktree' | 'integration_worktree' | 'metadata_reconciliation' | 'validation_snapshot' | 'rebuildable_cache' | 'release_recovery' | 'repository_temp' | 'standalone_release';
  path: string;
  identity: PathIdentity;
  repositoryPath?: string;
  registered?: boolean;
  dirty?: boolean;
  orphanedRepository?: boolean;
  owners?: WorktreeOwner[];
}

/** 被保护的路径会显示真实原因，不能静默漏过。 */
interface ProtectedEntry {
  kind: string;
  path: string;
  reason: string;
}

/** Git 仓库上下文缓存主仓路径和已登记 worktree。 */
interface RepositoryContext {
  topLevel: string;
  containerRoot: string;
  worktrees: Set<string>;
}

/** Skill 快照只检查升级后的内容寻址迁移，不由本脚本删除。 */
interface SkillCompactionFacts {
  root: string;
  snapshotCount: number;
  compactedSnapshotCount: number;
  pendingSnapshotCount: number;
  invalidSnapshotCount: number;
}

/** 会话同步事实用于提示仍需候选库压缩的物理数据。 */
interface ConversationSyncFacts {
  archivedEventCount: number;
  archivedPayloadBytes: number;
}

/** 清理计划不包含生成时间，确保同一现场能得到相同确认摘要。 */
interface CleanupPlan {
  format: string;
  platform: NodeJS.Platform;
  dataRoot: string;
  databasePath: string;
  databaseIdentity: PathIdentity;
  repositoryRoot: string;
  includeValidationSnapshots: boolean;
  includeReleaseRecovery: boolean;
  includeRepositoryTemp: boolean;
  candidates: CleanupCandidate[];
  protected: ProtectedEntry[];
  skillCompaction: SkillCompactionFacts;
  conversationSync: ConversationSyncFacts;
}

/** 清理结果逐项记录，失败项可以在修复原因后幂等重跑。 */
interface CleanupResult {
  kind: CleanupCandidate['kind'];
  path: string;
  status: 'removed' | 'reconciled' | 'failed';
  message: string | null;
}

/** 把未知异常转换为稳定、有限的诊断文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

/** 判断 Node 文件系统错误代码。 */
function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

/** 路径比较同时接受目标本身和其真实子路径。 */
function pathContains(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

/** 读取顶层目录身份；不存在时返回稳定空身份。 */
async function readPathIdentity(path: string): Promise<PathIdentity> {
  try {
    const stats = await lstat(path, { bigint: true });
    return { present: true, device: stats.dev.toString(), inode: stats.ino.toString(), modifiedAtMs: stats.mtimeMs.toString() };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { present: false, device: null, inode: null, modifiedAtMs: null };
    throw error;
  }
}

/** 只读打开正式数据库并读取现有 WAL，禁止 dry-run 执行业务写入或迁移。 */
function readOnlyDatabase<T>(databasePath: string, operation: (database: DatabaseSync) => T): T {
  const location = pathToFileURL(databasePath);
  location.searchParams.set('mode', 'ro');
  const database = new DatabaseSync(location.href, { readOnly: true, timeout: 30_000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  try {
    database.exec('PRAGMA query_only = ON');
    return operation(database);
  } finally {
    database.close();
  }
}

/** 查询表是否存在，兼容升级前后的历史数据库。 */
function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare(`SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table));
}

/** 查询字段是否存在，避免把旧数据库当成升级完成。 */
function columnExists(database: DatabaseSync, table: string, column: string): boolean {
  return (database.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>).some((entry) => entry.name === column);
}

/** 使用 Git 公共目录定位主仓，链接 worktree 不会把缓存根指向当前任务。 */
async function resolveRepositoryRoot(repositoryPath: string): Promise<string> {
  const result = await executeFile('git', ['-C', repositoryPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const commonDirectory = resolve(result.stdout.trim());
  const root = basename(commonDirectory) === '.git' ? dirname(commonDirectory) : resolve(repositoryPath);
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: unknown };
  if (packageJson.name !== 'zeus') throw new Error(`清理脚本只能从 Zeus 主仓运行：${root}`);
  return realpath(root);
}

/** 解析 Git porcelain 的 NUL 输出，只读取每个 worktree 的绝对路径。 */
function parseGitWorktreePaths(output: string): Set<string> {
  const paths = new Set<string>();
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) paths.add(resolve(field.slice('worktree '.length)));
  }
  return paths;
}

/** 读取仓库根、Zeus 容器边界和 Git 登记，供同仓候选复用。 */
async function readRepositoryContext(repositoryPath: string): Promise<RepositoryContext> {
  const topLevelResult = await executeFile('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const topLevel = await realpath(resolve(topLevelResult.stdout.trim()));
  const listResult = await executeFile('git', ['-C', topLevel, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { topLevel, containerRoot: resolve(dirname(topLevel), '.zeus-worktrees'), worktrees: parseGitWorktreePaths(listResult.stdout) };
}

/** 校验未登记的目录仍符合 Zeus 合入目录的精确层级。 */
function isManagedIntegrationLayout(containerRoot: string, candidatePath: string): boolean {
  const segments = relative(containerRoot, candidatePath).split(sep);
  const integration = segments.length === 3 && segments[1] === '.integration';
  const attempt = segments.length === 4 && segments[1] === '.integration-attempts';
  return (integration || attempt) && segments.every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

/** 从候选祖先中定位最近的 `.zeus-worktrees`，不接受推导到文件系统根。 */
function findWorktreeContainer(candidatePath: string): string | null {
  for (let directory = dirname(candidatePath); dirname(directory) !== directory; directory = dirname(directory)) {
    if (basename(directory) === '.zeus-worktrees') return directory;
  }
  return null;
}

/** 源仓已经删除时，只接受 `.git` 指向不存在绝对路径的标准终态合入孤儿。 */
async function inspectMissingRepositoryIntegration(draft: WorktreeDraft): Promise<CleanupCandidate> {
  if ((await readPathIdentity(draft.repositoryPath)).present) throw new Error('源仓路径仍存在，不能使用缺失源仓的孤儿清理分支。');
  const candidatePath = resolve(draft.path);
  const containerRoot = findWorktreeContainer(candidatePath);
  if (!containerRoot || !isManagedIntegrationLayout(containerRoot, candidatePath)) throw new Error('源仓不存在，且路径不符合标准合入目录层级。');
  const identity = await readPathIdentity(candidatePath);
  if (!identity.present) return { kind: 'metadata_reconciliation', path: candidatePath, identity, registered: false, orphanedRepository: true, owners: draft.owners };
  const status = await lstat(candidatePath);
  if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(candidatePath)) !== candidatePath) throw new Error('源仓不存在，且合入孤儿不是物理目录。');
  const gitFile = join(candidatePath, '.git');
  const gitFileStatus = await lstat(gitFile);
  if (!gitFileStatus.isFile() || gitFileStatus.isSymbolicLink() || gitFileStatus.size > 4_096) throw new Error('合入孤儿的 .git 身份无效。');
  const match = (await readFile(gitFile, 'utf8')).trim().match(/^gitdir:\s*(.+)$/u);
  if (!match || !isAbsolute(match[1]!)) throw new Error('合入孤儿的 .git 未指向绝对登记路径。');
  if ((await readPathIdentity(resolve(match[1]!))).present) throw new Error('合入孤儿仍有 Git 登记目录，不能绕过原仓清理。');
  return { kind: 'integration_worktree', path: candidatePath, identity, registered: false, dirty: true, orphanedRepository: true, owners: draft.owners };
}

/** 检查终态任务是否仍有运行中 Runtime 或 Provider 工作。 */
function activeTaskIds(database: DatabaseSync): Set<string> {
  const ids = new Set<string>();
  if (tableExists(database, 'runtime_sessions')) {
    for (const row of database.prepare("SELECT DISTINCT task_id AS taskId FROM runtime_sessions WHERE task_id IS NOT NULL AND status IN ('running', 'orphan_detected')").all() as Array<{ taskId: string }>) ids.add(row.taskId);
  }
  if (tableExists(database, 'conversations') && columnExists(database, 'conversations', 'provider_state')) {
    for (const row of database.prepare("SELECT DISTINCT task_id AS taskId FROM conversations WHERE task_id IS NOT NULL AND archived = 0 AND provider_state IN ('binding', 'active', 'waiting')").all() as Array<{ taskId: string }>)
      ids.add(row.taskId);
  }
  return ids;
}

/** 从数据库读取终态任务拥有的普通、冲突和合入 worktree。 */
function readWorktreeDrafts(databasePath: string): { drafts: WorktreeDraft[]; protected: ProtectedEntry[] } {
  return readOnlyDatabase(databasePath, (database) => {
    for (const table of ['projects', 'tasks', 'task_workspaces', 'task_integrations', 'task_integration_attempts']) {
      if (!tableExists(database, table)) throw new Error(`数据库尚未完成升级，缺少 ${table}。请先启动升级后的 Zeus。`);
    }
    const repositoryExpression = columnExists(database, 'task_workspaces', 'repository_path') ? "COALESCE(NULLIF(w.repository_path, ''), NULLIF(p.git_root, ''), p.local_path)" : "COALESCE(NULLIF(p.git_root, ''), p.local_path)";
    const drafts = new Map<string, WorktreeDraft>();
    const protectedEntries: ProtectedEntry[] = [];
    const activeTasks = activeTaskIds(database);
    const add = (pathValue: string, repositoryPath: string, owner: WorktreeOwner, managementStatus: string) => {
      const path = resolve(pathValue);
      if (!terminalTaskStatuses.has(managementStatus)) {
        if (!protectedEntries.some((entry) => entry.kind === 'active_worktree' && entry.path === path)) {
          protectedEntries.push({ kind: 'active_worktree', path, reason: `任务 ${owner.taskCode ?? owner.taskId} 仍处于 ${managementStatus}。` });
        }
        return;
      }
      if (activeTasks.has(owner.taskId)) {
        protectedEntries.push({ kind: 'active_terminal_task', path, reason: `终态任务 ${owner.taskCode ?? owner.taskId} 仍有活动 Runtime 或 Provider 状态。` });
        return;
      }
      const existing = drafts.get(path);
      if (existing && resolve(existing.repositoryPath) !== resolve(repositoryPath)) {
        protectedEntries.push({ kind: 'ambiguous_repository', path, reason: '同一路径被不同 Git 仓库声明，已拒绝自动清理。' });
        drafts.delete(path);
        return;
      }
      if (protectedEntries.some((entry) => entry.path === path && entry.kind === 'ambiguous_repository')) return;
      if (existing) existing.owners.push(owner);
      else drafts.set(path, { path, repositoryPath: resolve(repositoryPath), owners: [owner] });
    };

    const workspaceRows = database
      .prepare(
        `SELECT w.id, w.task_id AS taskId, w.workspace_kind AS kind, w.worktree_path AS path, w.state,
                t.task_code AS taskCode, t.management_status AS managementStatus, ${repositoryExpression} AS repositoryPath
           FROM task_workspaces w
           JOIN tasks t ON t.id = w.task_id
           JOIN projects p ON p.id = w.project_id
          WHERE w.worktree_path IS NOT NULL AND t.deleted_at IS NULL`,
      )
      .all() as Array<{ id: string; taskId: string; kind: string; path: string; state: string; taskCode: string | null; managementStatus: string; repositoryPath: string }>;
    for (const row of workspaceRows) add(row.path, row.repositoryPath, { type: 'workspace', id: row.id, taskId: row.taskId, taskCode: row.taskCode, state: row.state, kind: row.kind }, row.managementStatus);

    const integrationRows = database
      .prepare(
        `SELECT i.id, i.task_id AS taskId, i.integration_path AS path, i.state,
                t.task_code AS taskCode, t.management_status AS managementStatus, ${repositoryExpression} AS repositoryPath
           FROM task_integrations i
           JOIN task_workspaces w ON w.id = i.workspace_id
           JOIN tasks t ON t.id = i.task_id
           JOIN projects p ON p.id = i.project_id
          WHERE i.integration_path IS NOT NULL AND t.deleted_at IS NULL`,
      )
      .all() as Array<{ id: string; taskId: string; path: string; state: string; taskCode: string | null; managementStatus: string; repositoryPath: string }>;
    for (const row of integrationRows) add(row.path, row.repositoryPath, { type: 'integration', id: row.id, taskId: row.taskId, taskCode: row.taskCode, state: row.state, kind: 'integration' }, row.managementStatus);

    const attemptRows = database
      .prepare(
        `SELECT a.id, i.task_id AS taskId, a.worktree_path AS path, a.state,
                t.task_code AS taskCode, t.management_status AS managementStatus, ${repositoryExpression} AS repositoryPath
           FROM task_integration_attempts a
           JOIN task_integrations i ON i.id = a.integration_id
           JOIN task_workspaces w ON w.id = i.workspace_id
           JOIN tasks t ON t.id = i.task_id
           JOIN projects p ON p.id = i.project_id
          WHERE t.deleted_at IS NULL`,
      )
      .all() as Array<{ id: string; taskId: string; path: string; state: string; taskCode: string | null; managementStatus: string; repositoryPath: string }>;
    for (const row of attemptRows) add(row.path, row.repositoryPath, { type: 'attempt', id: row.id, taskId: row.taskId, taskCode: row.taskCode, state: row.state, kind: 'attempt' }, row.managementStatus);
    return { drafts: [...drafts.values()].sort((left, right) => left.path.localeCompare(right.path)), protected: protectedEntries };
  });
}

/** 对数据库候选补齐真实路径、Git 登记和脏状态检查。 */
async function inspectWorktreeCandidates(databasePath: string): Promise<{ candidates: CleanupCandidate[]; protected: ProtectedEntry[] }> {
  const source = readWorktreeDrafts(databasePath);
  const candidates: CleanupCandidate[] = [];
  const protectedEntries = [...source.protected];
  const repositories = new Map<string, Promise<RepositoryContext>>();
  for (const draft of source.drafts) {
    const integrationOwned = draft.owners.some((owner) => owner.type !== 'workspace' || owner.kind === 'conflict');
    try {
      let pendingContext = repositories.get(draft.repositoryPath);
      if (!pendingContext) {
        pendingContext = readRepositoryContext(draft.repositoryPath);
        repositories.set(draft.repositoryPath, pendingContext);
      }
      const context = await pendingContext;
      const candidatePath = resolve(draft.path);
      if (!pathContains(context.containerRoot, candidatePath)) throw new Error('路径离开项目的 .zeus-worktrees 容器。');
      const identity = await readPathIdentity(candidatePath);
      const registered = context.worktrees.has(candidatePath);
      if (!identity.present) {
        candidates.push({ kind: 'metadata_reconciliation', path: candidatePath, identity, repositoryPath: context.topLevel, registered, owners: draft.owners });
        continue;
      }
      const status = await lstat(candidatePath);
      if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('目标不是物理目录。');
      if ((await realpath(candidatePath)) !== candidatePath) throw new Error('目标真实路径与登记路径不一致。');
      if (!registered && !(integrationOwned && isManagedIntegrationLayout(context.containerRoot, candidatePath))) throw new Error('普通 worktree 已失去 Git 登记，不能证明可安全删除。');
      let dirty = false;
      if (registered) {
        const state = await executeFile('git', ['-C', candidatePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        dirty = state.stdout.length > 0;
        if (dirty && !integrationOwned) throw new Error('普通任务 worktree 含未提交或未跟踪内容。');
      }
      candidates.push({ kind: integrationOwned ? 'integration_worktree' : 'task_worktree', path: candidatePath, identity, repositoryPath: context.topLevel, registered, dirty, owners: draft.owners });
    } catch (error) {
      if (integrationOwned) {
        try {
          candidates.push(await inspectMissingRepositoryIntegration(draft));
          continue;
        } catch (orphanError) {
          protectedEntries.push({ kind: 'worktree', path: draft.path, reason: `${errorMessage(error)}；孤儿校验：${errorMessage(orphanError)}` });
          continue;
        }
      }
      protectedEntries.push({ kind: 'worktree', path: draft.path, reason: errorMessage(error) });
    }
  }
  return { candidates, protected: protectedEntries };
}

/** 验证并枚举标准 `.zeus-test` 历史只读验收根。 */
async function inspectValidationSnapshots(testRoot: string, include: boolean): Promise<{ candidates: CleanupCandidate[]; protected: ProtectedEntry[] }> {
  const candidates: CleanupCandidate[] = [];
  const protectedEntries: ProtectedEntry[] = [];
  let instances;
  try {
    instances = await readdir(testRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { candidates, protected: protectedEntries };
    throw error;
  }
  for (const instance of instances) {
    if (!instance.isDirectory() || !/^instance-[a-f0-9]{16}$/u.test(instance.name)) continue;
    const validationBase = join(testRoot, instance.name, 'read-only-validation');
    let runs;
    try {
      runs = await readdir(validationBase, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) continue;
      throw error;
    }
    for (const run of runs) {
      if (!run.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(run.name)) continue;
      const root = resolve(validationBase, run.name);
      try {
        const status = await lstat(root);
        if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(root)) !== root) throw new Error('验收根不是物理目录。');
        const manifestPath = join(root, 'data', 'zeus.db.read-only-validation.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
        const database = manifest.database as Record<string, unknown> | undefined;
        if (manifest.format !== 'zeus-read-only-validation-manifest' || manifest.mode !== 'read_only_validation' || manifest.validationRoot !== root || manifest.runId !== run.name) throw new Error('manifest 与验收根身份不匹配。');
        if (database?.path !== join(root, 'data', 'zeus.db')) throw new Error('manifest 数据库路径不匹配。');
        if (typeof manifest.manifestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.manifestHash)) throw new Error('manifest 摘要无效。');
        if (include) candidates.push({ kind: 'validation_snapshot', path: root, identity: await readPathIdentity(root) });
        else protectedEntries.push({ kind: 'validation_snapshot', path: root, reason: '只读验收证据默认保留；需要 --include-validation-snapshots 才纳入确认计划。' });
      } catch (error) {
        protectedEntries.push({ kind: 'validation_snapshot', path: root, reason: errorMessage(error) });
      }
    }
  }
  return { candidates, protected: protectedEntries };
}

/** 枚举固定名称的可重建缓存，并列出没有规则的 `.tmp` 项。 */
async function inspectRepositoryCaches(repositoryRoot: string, includeReleaseRecovery: boolean, includeRepositoryTemp: boolean): Promise<{ candidates: CleanupCandidate[]; protected: ProtectedEntry[] }> {
  const temporaryRoot = join(repositoryRoot, '.tmp');
  const candidates: CleanupCandidate[] = [];
  const protectedEntries: ProtectedEntry[] = [];
  const temporaryIdentity = await readPathIdentity(temporaryRoot);
  if (!temporaryIdentity.present) return { candidates, protected: protectedEntries };
  const temporaryStatus = await lstat(temporaryRoot);
  if (!temporaryStatus.isDirectory() || temporaryStatus.isSymbolicLink() || (await realpath(temporaryRoot)) !== temporaryRoot) {
    return { candidates, protected: [{ kind: 'repository_temp', path: temporaryRoot, reason: 'Zeus 主仓 .tmp 不是物理目录。' }] };
  }
  if (includeRepositoryTemp) return { candidates: [{ kind: 'repository_temp', path: temporaryRoot, identity: temporaryIdentity }], protected: protectedEntries };
  let entries;
  try {
    entries = await readdir(temporaryRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { candidates, protected: protectedEntries };
    throw error;
  }
  const known = new Set<string>([...rebuildableCacheNames, releaseRecoveryDirectoryName]);
  for (const entry of entries) {
    const path = join(temporaryRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      protectedEntries.push({ kind: 'unclassified_tmp', path, reason: '不是受管物理目录。' });
      continue;
    }
    if (rebuildableCacheNames.includes(entry.name as (typeof rebuildableCacheNames)[number])) {
      candidates.push({ kind: 'rebuildable_cache', path, identity: await readPathIdentity(path) });
      continue;
    }
    if (entry.name === releaseRecoveryDirectoryName) {
      if (includeReleaseRecovery) candidates.push({ kind: 'release_recovery', path, identity: await readPathIdentity(path) });
      else protectedEntries.push({ kind: 'release_recovery', path, reason: '失败发布现场默认保留；需要 --include-release-recovery 才纳入确认计划。' });
      continue;
    }
    if (!known.has(entry.name)) protectedEntries.push({ kind: 'unclassified_tmp', path, reason: '没有可靠所有权或重建规则，已保留。' });
  }
  return { candidates, protected: protectedEntries };
}

/** 解析 Codex 发布目录中的版本和平台后缀。 */
function parseStandaloneRelease(name: string): { version: number[]; stability: number; prerelease: number; target: string } | null {
  const match = name.match(/^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)(?:\.(\d+))?)?-(.+)$/u);
  if (!match) return null;
  const stability = match[4] === undefined ? 2 : match[4] === 'beta' ? 1 : 0;
  return { version: [Number(match[1]), Number(match[2]), Number(match[3])], stability, prerelease: Number(match[5] ?? 0), target: match[6]! };
}

/** 按正式版本、beta、alpha 的顺序比较同平台发布。 */
function compareStandaloneReleases(left: string, right: string): number {
  const leftVersion = parseStandaloneRelease(left);
  const rightVersion = parseStandaloneRelease(right);
  if (!leftVersion || !rightVersion) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.version[index] !== rightVersion.version[index]) return leftVersion.version[index]! - rightVersion.version[index]!;
  }
  return leftVersion.stability - rightVersion.stability || leftVersion.prerelease - rightVersion.prerelease;
}

/** Codex 只删除非当前版本，并保留同平台最新一个回退版本。 */
async function inspectStandaloneReleases(dataRoot: string): Promise<{ candidates: CleanupCandidate[]; protected: ProtectedEntry[] }> {
  const standaloneRoot = join(dataRoot, 'providers', 'codex', 'packages', 'standalone');
  const releasesRoot = join(standaloneRoot, 'releases');
  const currentPath = join(standaloneRoot, 'current');
  const candidates: CleanupCandidate[] = [];
  const protectedEntries: ProtectedEntry[] = [];
  try {
    const realReleasesRoot = await realpath(releasesRoot);
    const currentRelease = await realpath(currentPath);
    if (dirname(currentRelease) !== realReleasesRoot) throw new Error('Codex current 不属于 releases 根。');
    const currentName = basename(currentRelease);
    const currentVersion = parseStandaloneRelease(currentName);
    if (!currentVersion) throw new Error('Codex current 版本目录名称无效。');
    const entries = (await readdir(realReleasesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    const sameTarget = entries.map((entry) => entry.name).filter((name) => parseStandaloneRelease(name)?.target === currentVersion.target && name !== currentName);
    const fallback = sameTarget.sort(compareStandaloneReleases).at(-1) ?? null;
    for (const entry of entries) {
      const path = join(realReleasesRoot, entry.name);
      if (entry.name === currentName || entry.name === fallback) {
        protectedEntries.push({ kind: 'standalone_release', path, reason: entry.name === currentName ? '当前 Codex standalone。' : '保留的最近回退版本。' });
        continue;
      }
      if (!parseStandaloneRelease(entry.name)) {
        protectedEntries.push({ kind: 'standalone_release', path, reason: '发布目录名称不符合官方版本布局。' });
        continue;
      }
      candidates.push({ kind: 'standalone_release', path, identity: await readPathIdentity(path) });
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) protectedEntries.push({ kind: 'standalone_release', path: standaloneRoot, reason: errorMessage(error) });
  }
  return { candidates, protected: protectedEntries };
}

/** 读取 Skill 清单中的内容摘要，确认升级后的硬链接迁移已完成。 */
async function inspectSkillCompaction(dataRoot: string): Promise<SkillCompactionFacts> {
  const root = join(dataRoot, 'artifacts', 'skill-resources');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { root, snapshotCount: 0, compactedSnapshotCount: 0, pendingSnapshotCount: 0, invalidSnapshotCount: 0 };
    throw error;
  }
  let snapshotCount = 0;
  let compactedSnapshotCount = 0;
  let invalidSnapshotCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    snapshotCount += 1;
    try {
      const catalog = JSON.parse(await readFile(join(root, entry.name, 'catalog.json'), 'utf8')) as { skills?: Array<{ contentHash?: unknown }> };
      if (!Array.isArray(catalog.skills)) throw new Error('清单缺少 skills。');
      const hashes = catalog.skills.map((skill) => skill.contentHash).filter((hash): hash is string => typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash));
      if (hashes.length !== catalog.skills.length) continue;
      const objects = await Promise.all(hashes.map((hash) => readPathIdentity(join(root, 'objects', hash))));
      if (objects.every((identity) => identity.present)) compactedSnapshotCount += 1;
    } catch {
      invalidSnapshotCount += 1;
    }
  }
  return { root, snapshotCount, compactedSnapshotCount, pendingSnapshotCount: snapshotCount - compactedSnapshotCount - invalidSnapshotCount, invalidSnapshotCount };
}

/** 统计归档会话仍占用的同步投影，正式库只能走候选压缩流程。 */
function inspectConversationSync(databasePath: string): ConversationSyncFacts {
  return readOnlyDatabase(databasePath, (database) => {
    if (!tableExists(database, 'conversation_sync_events') || !tableExists(database, 'conversations')) return { archivedEventCount: 0, archivedPayloadBytes: 0 };
    const row = database
      .prepare(
        `SELECT COUNT(*) AS eventCount, COALESCE(SUM(event.payload_byte_length), 0) AS payloadBytes
           FROM conversation_sync_events event
           JOIN conversations conversation ON conversation.id = event.conversation_id
          WHERE conversation.archived = 1`,
      )
      .get() as { eventCount: number; payloadBytes: number };
    return { archivedEventCount: Number(row.eventCount), archivedPayloadBytes: Number(row.payloadBytes) };
  });
}

/** 创建确定性计划；同一路径只允许出现一次。 */
async function createPlan(arguments_: CleanupArguments): Promise<CleanupPlan> {
  const databasePath = resolve(arguments_.dataRoot, 'data', 'zeus.db');
  const repositoryRoot = await resolveRepositoryRoot(arguments_.repositoryPath);
  const [worktrees, validations, caches, standalone, skillCompaction] = await Promise.all([
    inspectWorktreeCandidates(databasePath),
    inspectValidationSnapshots(resolve(homedir(), '.zeus-test'), arguments_.includeValidationSnapshots),
    inspectRepositoryCaches(repositoryRoot, arguments_.includeReleaseRecovery, arguments_.includeRepositoryTemp),
    inspectStandaloneReleases(arguments_.dataRoot),
    inspectSkillCompaction(arguments_.dataRoot),
  ]);
  const candidates = [...worktrees.candidates, ...validations.candidates, ...caches.candidates, ...standalone.candidates].sort((left, right) => left.path.localeCompare(right.path));
  const duplicate = candidates.find((candidate, index) => index > 0 && candidate.path === candidates[index - 1]!.path);
  if (duplicate) throw new Error(`清理计划包含重复路径：${duplicate.path}`);
  const protectedEntries = [...worktrees.protected, ...validations.protected, ...caches.protected, ...standalone.protected].sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  return {
    format: planFormat,
    platform: process.platform,
    dataRoot: arguments_.dataRoot,
    databasePath,
    databaseIdentity: await readPathIdentity(databasePath),
    repositoryRoot,
    includeValidationSnapshots: arguments_.includeValidationSnapshots,
    includeReleaseRecovery: arguments_.includeReleaseRecovery,
    includeRepositoryTemp: arguments_.includeRepositoryTemp,
    candidates,
    protected: protectedEntries,
    skillCompaction,
    conversationSync: inspectConversationSync(databasePath),
  };
}

/** 读取全平台进程命令行，apply 时确认 Zeus、Codex 和构建器已经停止。 */
async function readProcessCommands(): Promise<Array<{ pid: number; command: string }>> {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
    const result = await executeFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(result.stdout || '[]') as Record<string, unknown> | Array<Record<string, unknown>>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({ pid: Number(row.ProcessId), command: `${String(row.ExecutablePath ?? '')} ${String(row.CommandLine ?? '')}` })).filter((row) => Number.isSafeInteger(row.pid));
  }
  const result = await executeFile('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ pid: Number(match[1]), command: match[2]! }));
}

/** 找出会写入 Zeus 数据、Codex 发布或构建缓存的活动进程。 */
async function activeProcessBlockers(plan: CleanupPlan): Promise<Array<{ pid: number; command: string }>> {
  const commands = await readProcessCommands();
  const standaloneRoot = join(plan.dataRoot, 'providers', 'codex', 'packages', 'standalone', 'releases');
  return commands.filter(({ pid, command }) => {
    if (pid === process.pid || pid === process.ppid) return false;
    const normalized = command.replaceAll('\\', '/');
    return (
      /\/Zeus(?: Test)?\.app\/Contents\//iu.test(normalized) ||
      /(?:^|[\\/])Zeus(?: Test)?\.exe(?:\s|$)/iu.test(command) ||
      normalized.includes(standaloneRoot.replaceAll('\\', '/')) ||
      /scripts[\\/]release-all\.mjs|electron-builder|(?:^|\s)cargo(?:\.exe)?\s+(?:build|run|test)|package-(?:mac|windows)\.mjs/iu.test(command)
    );
  });
}

/** macOS 使用 lsof 检查所有进程 cwd，防止删除仍被终端或编辑器占用的 worktree。 */
async function occupiedCandidatePaths(candidates: CleanupCandidate[]): Promise<Array<{ pid: number; path: string }>> {
  if (process.platform !== 'darwin') return [];
  const result = await executeFile('/usr/sbin/lsof', ['-Fn', '-d', 'cwd'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const occupied: Array<{ pid: number; path: string }> = [];
  let pid = 0;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (!line.startsWith('n') || pid === process.pid || pid === process.ppid) continue;
    const cwd = resolve(line.slice(1));
    for (const candidate of candidates) {
      if (pathContains(candidate.path, cwd)) occupied.push({ pid, path: candidate.path });
    }
  }
  return occupied;
}

/** 物理删除前再次拒绝符号链接和身份漂移。 */
async function assertCandidateIdentity(candidate: CleanupCandidate): Promise<void> {
  const current = await readPathIdentity(candidate.path);
  if (JSON.stringify(current) !== JSON.stringify(candidate.identity)) throw new Error('目标在计划确认后发生变化，请重新 dry-run。');
  if (!current.present) return;
  const status = await lstat(candidate.path);
  if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(candidate.path)) !== candidate.path) throw new Error('目标不再是原物理目录。');
}

/** 使用 Git 删除已登记 worktree；未登记合入目录才使用受界递归删除。 */
async function removeWorktreeCandidate(candidate: CleanupCandidate): Promise<void> {
  await assertCandidateIdentity(candidate);
  if (candidate.kind === 'task_worktree' && candidate.identity.present) {
    const state = await executeFile('git', ['-C', candidate.path, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (state.stdout.length > 0) throw new Error('普通任务 worktree 在确认后出现未提交内容，已保留。');
  }
  if (candidate.registered) {
    await executeFile('git', ['-C', candidate.repositoryPath!, 'worktree', 'remove', '--force', candidate.path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } else if (candidate.identity.present) {
    await rm(candidate.path, { recursive: true, force: false, maxRetries: deletionRetryCount, retryDelay: deletionRetryDelayMs });
  }
  if ((await readPathIdentity(candidate.path)).present) throw new Error('worktree 删除后仍然存在。');
}

/** 物理回收成功后同步收敛 Zeus 数据库中的路径和终态。 */
function reconcileWorktreeOwners(database: DatabaseSync, owners: WorktreeOwner[]): void {
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const owner of owners) {
      if (owner.type === 'workspace') {
        database.prepare("UPDATE task_workspaces SET worktree_path = NULL, state = CASE WHEN state IN ('merged', 'discarded') THEN state ELSE 'reclaimed' END, last_error = NULL, updated_at = ? WHERE id = ?").run(now, owner.id);
      } else if (owner.type === 'integration') {
        database
          .prepare(
            "UPDATE task_integrations SET integration_path = NULL, state = CASE WHEN state = 'merged' THEN 'merged' ELSE 'failed' END, conflict_files_json = '[]', last_error = CASE WHEN state = 'merged' THEN NULL ELSE '历史终态现场已由离线清理回收。' END, updated_at = ? WHERE id = ?",
          )
          .run(now, owner.id);
      } else if (owner.state === 'preparing' || owner.state === 'active') {
        database.prepare("UPDATE task_integration_attempts SET state = 'stale', last_error = '历史终态现场已由离线清理回收。', updated_at = ? WHERE id = ?").run(now, owner.id);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** 删除普通目录候选，任何路径漂移都保留现场。 */
async function removeDirectoryCandidate(candidate: CleanupCandidate): Promise<void> {
  await assertCandidateIdentity(candidate);
  if (!candidate.identity.present) return;
  await rm(candidate.path, { recursive: true, force: false, maxRetries: deletionRetryCount, retryDelay: deletionRetryDelayMs });
}

/** 执行已确认计划，并把逐项结果写入正式 artifact 审计目录。 */
async function applyPlan(plan: CleanupPlan): Promise<{ reportPath: string; results: CleanupResult[]; availableBytesBefore: number; availableBytesAfter: number }> {
  const processBlockers = await activeProcessBlockers(plan);
  if (processBlockers.length > 0) throw new Error(`仍有 Zeus、Codex 或构建进程运行：${processBlockers.map((entry) => entry.pid).join(', ')}。请完全退出后重试。`);
  const occupied = await occupiedCandidatePaths(plan.candidates);
  if (occupied.length > 0) throw new Error(`候选目录仍被进程作为工作目录：${occupied.map((entry) => `${entry.path}(${entry.pid})`).join('，')}`);
  if (plan.candidates.some((candidate) => pathContains(candidate.path, process.cwd()))) throw new Error('当前脚本工作目录位于清理候选中，请从 Zeus 主仓重新运行。');

  const filesystemBefore = await statfs(plan.dataRoot);
  const availableBytesBefore = Number(filesystemBefore.bavail) * Number(filesystemBefore.bsize);
  const database = new DatabaseSync(plan.databasePath, { timeout: 30_000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  const results: CleanupResult[] = [];
  try {
    for (const candidate of plan.candidates) {
      try {
        if (candidate.owners) {
          await removeWorktreeCandidate(candidate);
          reconcileWorktreeOwners(database, candidate.owners);
          results.push({ kind: candidate.kind, path: candidate.path, status: candidate.identity.present ? 'removed' : 'reconciled', message: null });
        } else {
          await removeDirectoryCandidate(candidate);
          results.push({ kind: candidate.kind, path: candidate.path, status: candidate.identity.present ? 'removed' : 'reconciled', message: null });
        }
      } catch (error) {
        results.push({ kind: candidate.kind, path: candidate.path, status: 'failed', message: errorMessage(error) });
      }
    }
  } finally {
    database.close();
  }
  const filesystemAfter = await statfs(plan.dataRoot);
  const availableBytesAfter = Number(filesystemAfter.bavail) * Number(filesystemAfter.bsize);
  const auditRoot = join(plan.dataRoot, 'artifacts', 'maintenance');
  await mkdir(auditRoot, { recursive: true, mode: 0o700 });
  const reportPath = join(auditRoot, `generated-data-cleanup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  await writeFile(reportPath, `${JSON.stringify({ format: planFormat, completedAt: new Date().toISOString(), availableBytesBefore, availableBytesAfter, plan, results }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { reportPath, results, availableBytesBefore, availableBytesAfter };
}

/** 解析命令行；默认只输出计划，不接收模糊确认。 */
function parseArguments(values: string[]): CleanupArguments {
  const parsed = parseArgs({
    args: values,
    strict: true,
    options: {
      apply: { type: 'boolean' },
      confirmation: { type: 'string' },
      'data-root': { type: 'string' },
      repository: { type: 'string' },
      'include-validation-snapshots': { type: 'boolean' },
      'include-release-recovery': { type: 'boolean' },
      'include-repository-temp': { type: 'boolean' },
    },
  }).values;
  const dataRoot = resolve(parsed['data-root'] ?? join(homedir(), '.zeus'));
  const repositoryPath = resolve(parsed.repository ?? process.cwd());
  return {
    apply: parsed.apply ?? false,
    confirmation: parsed.confirmation ?? null,
    dataRoot,
    repositoryPath,
    includeValidationSnapshots: parsed['include-validation-snapshots'] ?? false,
    includeReleaseRecovery: parsed['include-release-recovery'] ?? false,
    includeRepositoryTemp: parsed['include-repository-temp'] ?? false,
  };
}

/** 主流程先生成计划摘要，只有完全匹配的确认文本才执行删除。 */
async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const plan = await createPlan(arguments_);
  const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  const expectedConfirmation = `DELETE ZEUS ${planHash}`;
  if (!arguments_.apply || arguments_.confirmation !== expectedConfirmation) {
    process.stdout.write(`${JSON.stringify({ status: 'confirmation_required', plan, planHash, expectedConfirmation }, null, 2)}\n`);
    if (arguments_.apply) process.exitCode = 2;
    return;
  }
  const result = await applyPlan(plan);
  const failed = result.results.filter((entry) => entry.status === 'failed');
  process.stdout.write(
    `${JSON.stringify({ status: failed.length === 0 ? 'directory_cleanup_completed' : 'directory_cleanup_partially_completed', remaining: { protected: plan.protected, skillCompaction: plan.skillCompaction, conversationSync: plan.conversationSync }, ...result }, null, 2)}\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
