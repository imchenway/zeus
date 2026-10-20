import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import {
  assertHistoricalCleanupAvailable,
  assertOfflineMaintenance,
  inspectMaintenanceTree,
  type MaintenanceTreeFacts,
  readMaintenanceAllowlist,
  readMaintenanceMetadata,
  requireMaintenanceDirectory,
  withMaintenanceLease,
} from './maintenanceSafety.js';

/** 子进程调用统一使用无 shell 的参数数组，避免路径被二次解释。 */
const executeFile = promisify(execFile);
/** 清理计划格式使用日期代次，避免把未来布局误认为当前布局。 */
const planFormat = 'zeus-generated-data-cleanup-2026-10-21';
/** 只有终态任务允许进入历史 worktree 清理计划。 */
const terminalTaskStatuses = new Set(['completed', 'cancelled']);
/** 这些目录是 Zeus 构建入口生成、删除后可重新生成的缓存。 */
const rebuildableCacheNames = ['cargo-target', 'cua-driver-target-arm64', 'cua-driver-target-darwin-arm64', 'electron-dist', 'rust-toolchains', 'clang-module-cache', 'codex-runtime'] as const;
/** 发布失败现场可能仍有恢复价值，必须通过独立参数纳入计划。 */
const releaseRecoveryDirectoryName = 'zeus-release-isolated';
/** Windows 删除刚释放的 SQLite 或 Chromium 文件时允许短暂重试。 */
const deletionRetryCount = 40;
/** 每次 Windows 删除重试间隔四分之一秒。 */
const deletionRetryDelayMs = 250;
/** 命令行参数只允许显式覆盖根目录和两类有证据价值的数据。 */
interface CleanupArguments {
  /** 显式在线清理仅操作通过当前占用检查的精确候选。 */
  allowOnline: boolean;
  /** 用户明确放弃遗留源码时，按正式任务状态回收并允许丢弃未提交内容。 */
  discardObsoleteWorktrees: boolean;
  apply: boolean;
  confirmation: string | null;
  dataRoot: string;
  repositoryPath: string;
  includeValidationSnapshots: boolean;
  includeReleaseRecovery: boolean;
  /** 删除范围默认限制在正式数据根之外。 */
  scope: 'external' | 'internal' | 'all';
  /** 固定路径白名单是执行的必要条件。 */
  selectedPaths: string[] | null;
  /** 历史安装包和发布材料需要独立纳入审阅。 */
  includeReleaseArtifacts: boolean;
  /** 单独审阅工作树内的依赖、构建输出和固定编译缓存，不删除任务源码。 */
  includeWorktreeCaches: boolean;
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

/** 丢弃计划保存三类完整引用，包含已删除或已失去任务记录的 owner。 */
interface WorktreeReference extends WorktreeOwner {
  /** 每个 owner 的原始路径，允许父目录计划同时回收其嵌套工作树。 */
  path: string;
  /** 任务不存在时为空；存在且未完成的正式任务必须保留。 */
  managementStatus: string | null;
  /** 已删除任务不再属于正式存在的任务。 */
  deletedAt: string | null;
}

/** 聚合环境可能没有 Git 入口，仍必须按正式任务状态保护并收敛根路径。 */
interface WorktreeEnvironment {
  /** 聚合环境的稳定身份。 */
  id: string;
  /** 聚合根目录，不能因成员工作树已回收而漏掉剩余文件。 */
  path: string;
  /** 计划时的环境状态。 */
  state: string;
  /** 正式任务身份，不以目录名称推断。 */
  taskId: string;
  /** 正式任务状态，记录缺失时为空。 */
  managementStatus: string | null;
  /** 已删除任务的时间，正式任务为空。 */
  deletedAt: string | null;
}

/** 只移除准确反向登记的 Git worktree，不修改共享分支或提交。 */
interface LinkedWorktree {
  /** Git worktree 的物理路径。 */
  path: string;
  /** 共享 Git 目录，通过 Git 自身移除登记。 */
  commonDirectory: string;
}

/** 顶层身份用于确认 dry-run 与 apply 之间没有替换目标。 */
interface PathIdentity {
  present: boolean;
  device: string | null;
  inode: string | null;
  modifiedAtMs: string | null;
}

/** 删除项固定路径身份；工作树缓存额外绑定深层目录摘要与原 owner。 */
interface CleanupCandidate {
  kind:
    | 'task_worktree'
    | 'integration_worktree'
    | 'metadata_reconciliation'
    | 'validation_snapshot'
    | 'rebuildable_cache'
    | 'release_recovery'
    | 'release_artifacts'
    | 'release_copy'
    | 'standalone_release'
    | 'worktree_cache'
    | 'obsolete_worktree';
  path: string;
  identity: PathIdentity;
  repositoryPath?: string;
  registered?: boolean;
  dirty?: boolean;
  /** 已审阅的提交和其他命名引用必须在删除前复核。 */
  head?: string;
  /** 不能仅凭工作树干净丢弃未保全提交。 */
  preservingRefs?: string[];
  /** 完整副本的命名引用和 reflog 提交共同参与确认，防止遗漏仅存于历史的代码。 */
  preservedCommitTips?: string[];
  /** 验收清单内容摘要参与计划身份。 */
  manifestSha256?: string;
  /** 历史产物需要复核深层内容是否在审阅后发生变化。 */
  treeFacts?: MaintenanceTreeFacts;
  /** 验收数据库身份独立于清单身份。 */
  validationDatabaseIdentity?: PathIdentity;
  owners?: WorktreeOwner[];
  /** 缓存仅核对所属工作树，不更新或回收工作树 owner。 */
  cacheWorkspace?: WorktreeDraft;
  /** 显式丢弃模式中的所有路径引用，包括嵌套 owner；空数组表示确认无主。 */
  discardedReferences?: WorktreeReference[];
  /** 显式丢弃时需同时移除的准确 Git 登记。 */
  linkedWorktrees?: LinkedWorktree[];
  /** 聚合环境引用参与确认，完成删除后清除准确根路径。 */
  discardedEnvironments?: WorktreeEnvironment[];
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
  worktrees: Set<string>;
}

/** 旧资源只展示离线回收状态，不能把历史清单误报为等待后台迁移。 */
interface SkillResourceFacts {
  /** 历史清单和旧资源所在根。 */
  root: string;
  /** 有效编号的快照数量。 */
  snapshotCount: number;
  /** 仍有资源内容、需要独立离线计划的快照数量。 */
  payloadSnapshotCount: number;
  /** 仅剩清单与回收凭证的快照数量。 */
  metadataOnlySnapshotCount: number;
  /** 清单不完整或存在未知布局的快照数量。 */
  invalidSnapshotCount: number;
}

/** 会话同步事实用于提示仍需候选库压缩的物理数据。 */
interface ConversationSyncFacts {
  archivedEventCount: number;
  archivedPayloadBytes: number;
}

/** 清理计划不包含生成时间，确保同一现场能得到相同确认摘要。 */
interface CleanupPlan {
  /** 执行模式参与确认摘要，不能由确认后的隐含开关改变。 */
  allowOnline: boolean;
  /** 丢弃源码的授权边界必须进入确认摘要。 */
  discardObsoleteWorktrees: boolean;
  format: string;
  platform: NodeJS.Platform;
  dataRoot: string;
  databasePath: string;
  databaseIdentity: PathIdentity;
  repositoryRoot: string;
  includeValidationSnapshots: boolean;
  includeReleaseRecovery: boolean;
  /** 删除范围默认限制在正式数据根之外。 */
  scope: 'external' | 'internal' | 'all';
  /** 固定路径白名单是执行的必要条件。 */
  selectedPaths: string[] | null;
  /** 历史安装包和发布材料需要独立纳入审阅。 */
  includeReleaseArtifacts: boolean;
  /** 工作树缓存范围必须进入确认摘要。 */
  includeWorktreeCaches: boolean;
  candidates: CleanupCandidate[];
  protected: ProtectedEntry[];
  skillResources: SkillResourceFacts | null;
  conversationSync: ConversationSyncFacts | null;
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

/** 同时识别历史缓存名称和原生构建入口生成的平台、架构名称。 */
function isRebuildableCacheName(name: string): boolean {
  return rebuildableCacheNames.includes(name as (typeof rebuildableCacheNames)[number]) || /^cua-driver-target-(?:darwin|win32|linux)-(?:arm64|x64)$/u.test(name);
}

/** 在线模式仅允许明确类别；丢弃工作树另由事务内的正式任务状态保护。 */
function assertOnlineCandidateKind(candidate: CleanupCandidate, dataRoot: string): void {
  if (candidate.kind === 'obsolete_worktree' && candidate.discardedReferences && process.platform === 'darwin' && !pathContains(dataRoot, candidate.path)) return;
  if (candidate.owners || !['validation_snapshot', 'release_artifacts', 'rebuildable_cache', 'release_copy', 'standalone_release', 'worktree_cache'].includes(candidate.kind))
    throw new Error('在线模式不回收整棵工作树，也不修改正式 owner。');
  if (pathContains(dataRoot, candidate.path) && candidate.kind !== 'standalone_release') throw new Error('正式数据根内在线清理仅允许已识别的旧 Codex 发行目录。');
  if (!['validation_snapshot', 'release_artifacts'].includes(candidate.kind) && process.platform !== 'darwin') throw new Error('当前平台尚无生成目录的完整打开文件检查，新增清理类别仍需离线执行。');
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
  return { topLevel, worktrees: parseGitWorktreePaths(listResult.stdout) };
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

/** 定位实际容器，兼容项目祖先下的多仓工作区，不推测或扩大到普通目录。 */
function findManagedWorktreeContainer(path: string): string | null {
  for (let parent = dirname(path); dirname(parent) !== parent; parent = dirname(parent)) if (basename(parent) === '.zeus-worktrees') return parent;
  return null;
}

/** 读取全部正式路径引用，不因任务删除、项目迁移或连接缺失而漏掉遗留 owner。 */
function readWorktreeReferences(database: DatabaseSync): WorktreeReference[] {
  /** 三类引用统一字段，保持普通任务、冲突集成和集成尝试使用相同保留规则。 */
  const queries = [
    "SELECT w.id,w.task_id AS taskId,t.task_code AS taskCode,w.state,w.workspace_kind AS kind,w.worktree_path AS path,t.management_status AS managementStatus,t.deleted_at AS deletedAt,'workspace' AS type FROM task_workspaces w LEFT JOIN tasks t ON t.id=w.task_id WHERE w.worktree_path IS NOT NULL",
    "SELECT i.id,i.task_id AS taskId,t.task_code AS taskCode,i.state,'integration' AS kind,i.integration_path AS path,t.management_status AS managementStatus,t.deleted_at AS deletedAt,'integration' AS type FROM task_integrations i LEFT JOIN tasks t ON t.id=i.task_id WHERE i.integration_path IS NOT NULL",
    "SELECT a.id,i.task_id AS taskId,t.task_code AS taskCode,a.state,'attempt' AS kind,a.worktree_path AS path,t.management_status AS managementStatus,t.deleted_at AS deletedAt,'attempt' AS type FROM task_integration_attempts a LEFT JOIN task_integrations i ON i.id=a.integration_id LEFT JOIN tasks t ON t.id=i.task_id WHERE a.worktree_path IS NOT NULL",
  ];
  return queries.flatMap((query) => database.prepare(query).all() as unknown as WorktreeReference[]).sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
}

/** 包括无成员环境在内的根路径也属于正式任务保护范围。 */
function relatedWorktreeEnvironments(database: DatabaseSync, path: string): WorktreeEnvironment[] {
  /** 环境与任务使用左连接，保留已删除和任务记录缺失的历史环境。 */
  const environments = database
    .prepare('SELECT e.id,e.task_id AS taskId,e.root_path AS path,e.state,t.management_status AS managementStatus,t.deleted_at AS deletedAt FROM task_environments e LEFT JOIN tasks t ON t.id=e.task_id WHERE e.root_path IS NOT NULL')
    .all() as unknown as WorktreeEnvironment[];
  return environments.filter((row) => pathContains(path, resolve(row.path)) || pathContains(resolve(row.path), path)).sort((left, right) => left.id.localeCompare(right.id));
}

/** 仅正式存在且非已完成的任务阻止显式丢弃；已取消仍属于非已完成。 */
function discardableWorktreeReferences(database: DatabaseSync, path: string): WorktreeReference[] {
  /** 关联检查覆盖父子路径，不能通过删除父目录绕过未完成任务保护。 */
  const related = readWorktreeReferences(database).filter((row) => pathContains(path, resolve(row.path)) || pathContains(resolve(row.path), path));
  if (related.some((row) => row.managementStatus !== null && row.deletedAt === null && row.managementStatus !== 'completed')) throw new Error('路径关联正式存在且非已完成的任务，必须保留。');
  if (relatedWorktreeEnvironments(database, path).some((row) => row.managementStatus !== null && row.deletedAt === null && row.managementStatus !== 'completed')) throw new Error('路径关联正式存在且非已完成任务的聚合环境，必须保留。');
  /** 主项目、主仓和集成本地同步目标不是遗留任务副本。 */
  const roots = database
    .prepare(
      'SELECT local_path AS path FROM projects UNION SELECT git_root FROM projects WHERE git_root IS NOT NULL UNION SELECT local_path FROM project_repositories UNION SELECT local_worktree_path FROM task_integrations WHERE local_worktree_path IS NOT NULL',
    )
    .all() as Array<{ path: string }>;
  if (roots.some((row) => row.path && pathContains(path, resolve(row.path)))) throw new Error('候选包含正式项目或主仓入口，不能作为遗留副本删除。');
  return related.filter((row) => pathContains(path, resolve(row.path)));
}

/** 查找目标内准确反向登记的 Git worktree，失效指针仅随物理副本回收。 */
async function inspectLinkedWorktrees(root: string): Promise<LinkedWorktree[]> {
  /** 只遍历物理目录，不跟随依赖链接进入其他任务。 */
  const pending = [root];
  /** 登记按深度排列，先回收嵌套 Git worktree。 */
  const registrations: LinkedWorktree[] = [];
  while (pending.length) {
    /** 当前待检查的物理目录。 */
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      /** 当前入口的准确绝对路径。 */
      const entryPath = join(directory, entry.name);
      if (entry.name !== '.git') {
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(entryPath);
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error(`Git 入口是符号链接，无法确认登记：${entryPath}`);
      if (entry.isDirectory()) {
        /** 独立副本不能承载目标之外的 Git worktree。 */
        const listing = await executeFile('git', ['--git-dir', entryPath, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        if ([...parseGitWorktreePaths(listing.stdout)].some((path) => !pathContains(root, path))) throw new Error(`独立副本仍承载外部 Git worktree：${entryPath}`);
        continue;
      }
      /** 只解析 Git 的固定指针格式，不执行文件内容。 */
      const pointer = (await readMaintenanceMetadata(entryPath)).text.trim();
      if (!pointer.startsWith('gitdir: ')) throw new Error(`Git 指针格式未知：${entryPath}`);
      /** Git 指针可能相对于所属工作树目录。 */
      const gitDirectory = resolve(directory, pointer.slice('gitdir: '.length));
      if (!(await readPathIdentity(gitDirectory)).present) continue;
      await requireMaintenanceDirectory(gitDirectory);
      /** 仅处理标准 linked worktree 元数据，其余失效登记不扩大删除范围。 */
      const commonPointer = join(gitDirectory, 'commondir');
      if (!(await readPathIdentity(commonPointer)).present) continue;
      /** 共享对象库绝对路径。 */
      const commonDirectory = await realpath(resolve(gitDirectory, (await readMaintenanceMetadata(commonPointer)).text.trim()));
      if (dirname(gitDirectory) !== join(commonDirectory, 'worktrees')) throw new Error(`Git 登记不在标准 worktrees 目录：${gitDirectory}`);
      /** 反向路径必须仍精确指向待删 worktree。 */
      const backPointer = (await readMaintenanceMetadata(join(gitDirectory, 'gitdir'))).text.trim();
      if (resolve(gitDirectory, backPointer) !== entryPath) continue;
      registrations.push({ path: directory, commonDirectory });
    }
  }
  return registrations.sort((left, right) => right.path.split(sep).length - left.path.split(sep).length || left.path.localeCompare(right.path));
}

/** 显式放弃源码时从精确白名单建立计划，支持已完成、已删除及无主工作树。 */
async function inspectObsoleteWorktrees(databasePath: string, repositoryRoot: string, selectedPaths: string[]): Promise<{ candidates: CleanupCandidate[]; protected: ProtectedEntry[] }> {
  /** 可执行候选仍固定完整路径身份和深层内容摘要。 */
  const candidates: CleanupCandidate[] = [];
  /** 不能删除的路径保留明确原因。 */
  const protectedEntries: ProtectedEntry[] = [];
  for (const path of selectedPaths) {
    try {
      /** 仅识别受管工作树和现有发布入口的独立恢复副本。 */
      const container = findManagedWorktreeContainer(path);
      /** 沿用原发布副本布局，不接收任意 .tmp 子目录。 */
      const releaseCopy = path === join(repositoryRoot, '.tmp', 'release-candidate-v0.2.8') || (dirname(path) === join(repositoryRoot, '.tmp', releaseRecoveryDirectoryName) && /^[a-f0-9]{40,64}$/u.test(basename(path)));
      if (!container && !releaseCopy) throw new Error('显式丢弃仅接受受管 worktree 或已识别的发布副本。');
      if (container) await requireMaintenanceDirectory(container);
      /** 一次快照核对全部正式 owner，不能仅依赖目录名。 */
      const discardedReferences = readOnlyDatabase(databasePath, (database) => discardableWorktreeReferences(database, path));
      /** 聚合环境也能识别没有 Git 入口的历史根目录。 */
      const discardedEnvironments = readOnlyDatabase(databasePath, (database) => relatedWorktreeEnvironments(database, path));
      /** 当前目录身份也允许已缺失目录进入 owner 对账。 */
      const identity = await readPathIdentity(path);
      if (!identity.present && discardedReferences.length === 0 && discardedEnvironments.length === 0) throw new Error('目录及正式引用均不存在，无需执行。');
      if (identity.present) {
        await requireMaintenanceDirectory(path);
        /** 受管容器内也回收失败创建和成员回收后留下的聚合目录。 */
        if (!container && !(await readPathIdentity(join(path, '.git'))).present) throw new Error('发布副本缺少 Git 入口，不能扩大为任意临时目录。');
        if (releaseCopy) await assertSourceObjectsIndependent(repositoryRoot, path);
      }
      candidates.push({
        kind: 'obsolete_worktree',
        path,
        identity,
        discardedReferences,
        discardedEnvironments,
        linkedWorktrees: identity.present ? await inspectLinkedWorktrees(path) : [],
        ...(identity.present ? { treeFacts: await inspectMaintenanceTree(path, true) } : {}),
      });
    } catch (error) {
      protectedEntries.push({ kind: 'obsolete_worktree', path, reason: errorMessage(error) });
    }
  }
  return { candidates, protected: protectedEntries };
}

/** 整体回收要求终态；缓存盘点允许未完成任务，但继续保护已删除或正在执行的任务。 */
function readWorktreeDrafts(databasePath: string, cacheOnly = false): { drafts: WorktreeDraft[]; protected: ProtectedEntry[] } {
  return readOnlyDatabase(databasePath, (database) => {
    for (const table of ['projects', 'tasks', 'task_workspaces', 'task_integrations', 'task_integration_attempts']) {
      if (!tableExists(database, table)) throw new Error(`数据库尚未完成升级，缺少 ${table}。请先启动升级后的 Zeus。`);
    }
    const repositoryExpression = columnExists(database, 'task_workspaces', 'repository_path') ? "COALESCE(NULLIF(w.repository_path, ''), NULLIF(p.git_root, ''), p.local_path)" : "COALESCE(NULLIF(p.git_root, ''), p.local_path)";
    const drafts = new Map<string, WorktreeDraft>();
    const protectedEntries: ProtectedEntry[] = [];
    const activeTasks = activeTaskIds(database);
    /** 每个 owner 独立判定，最终统一排除任何受保护路径。 */
    const add = (pathValue: string, repositoryPath: string, owner: WorktreeOwner, managementStatus: string, deletedAt: string | null) => {
      const path = resolve(pathValue);
      if (deletedAt !== null) {
        protectedEntries.push({ kind: 'deleted_task_owner', path, reason: `任务 ${owner.taskCode ?? owner.taskId} 已删除，仍需核对遗留内容。` });
        return;
      }
      if (!cacheOnly && !terminalTaskStatuses.has(managementStatus)) {
        if (!protectedEntries.some((entry) => entry.kind === 'active_worktree' && entry.path === path)) {
          protectedEntries.push({ kind: 'active_worktree', path, reason: `任务 ${owner.taskCode ?? owner.taskId} 仍处于 ${managementStatus}。` });
        }
        return;
      }
      if (activeTasks.has(owner.taskId)) {
        protectedEntries.push({ kind: cacheOnly ? 'active_worktree_cache' : 'active_terminal_task', path, reason: `任务 ${owner.taskCode ?? owner.taskId} 仍有活动 Runtime 或 Provider 状态。` });
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
                t.task_code AS taskCode, t.management_status AS managementStatus, t.deleted_at AS deletedAt, ${repositoryExpression} AS repositoryPath
           FROM task_workspaces w
           JOIN tasks t ON t.id = w.task_id
           JOIN projects p ON p.id = w.project_id
          WHERE w.worktree_path IS NOT NULL`,
      )
      .all() as Array<{ id: string; taskId: string; kind: string; path: string; state: string; taskCode: string | null; managementStatus: string; deletedAt: string | null; repositoryPath: string }>;
    for (const row of workspaceRows) add(row.path, row.repositoryPath, { type: 'workspace', id: row.id, taskId: row.taskId, taskCode: row.taskCode, state: row.state, kind: row.kind }, row.managementStatus, row.deletedAt);

    const integrationRows = database
      .prepare(
        `SELECT i.id, i.task_id AS taskId, i.integration_path AS path, i.state,
                t.task_code AS taskCode, t.management_status AS managementStatus, t.deleted_at AS deletedAt, ${repositoryExpression} AS repositoryPath
           FROM task_integrations i
           JOIN task_workspaces w ON w.id = i.workspace_id
           JOIN tasks t ON t.id = i.task_id
           JOIN projects p ON p.id = i.project_id
          WHERE i.integration_path IS NOT NULL`,
      )
      .all() as Array<{ id: string; taskId: string; path: string; state: string; taskCode: string | null; managementStatus: string; deletedAt: string | null; repositoryPath: string }>;
    for (const row of integrationRows) add(row.path, row.repositoryPath, { type: 'integration', id: row.id, taskId: row.taskId, taskCode: row.taskCode, state: row.state, kind: 'integration' }, row.managementStatus, row.deletedAt);

    const attemptRows = database
      .prepare(
        `SELECT a.id, i.task_id AS taskId, a.worktree_path AS path, a.state,
                t.task_code AS taskCode, t.management_status AS managementStatus, t.deleted_at AS deletedAt, ${repositoryExpression} AS repositoryPath
           FROM task_integration_attempts a
           JOIN task_integrations i ON i.id = a.integration_id
           JOIN task_workspaces w ON w.id = i.workspace_id
           JOIN tasks t ON t.id = i.task_id
           JOIN projects p ON p.id = i.project_id
          WHERE 1 = 1`,
      )
      .all() as Array<{ id: string; taskId: string; path: string; state: string; taskCode: string | null; managementStatus: string; deletedAt: string | null; repositoryPath: string }>;
    for (const row of attemptRows) add(row.path, row.repositoryPath, { type: 'attempt', id: row.id, taskId: row.taskId, taskCode: row.taskCode, state: row.state, kind: 'attempt' }, row.managementStatus, row.deletedAt);
    return {
      drafts: [...drafts.values()].filter((draft) => !protectedEntries.some((entry) => pathContains(entry.path, draft.path) || pathContains(draft.path, entry.path))).sort((left, right) => left.path.localeCompare(right.path)),
      protected: protectedEntries,
    };
  });
}

/** 对数据库候选补齐真实路径、Git 登记和脏状态检查。 */
async function inspectWorktreeCandidates(databasePath: string, selectedPaths: string[] | null): Promise<{ candidates: CleanupCandidate[]; protected: ProtectedEntry[] }> {
  const source = readWorktreeDrafts(databasePath);
  const candidates: CleanupCandidate[] = [];
  const protectedEntries = [...source.protected];
  const repositories = new Map<string, Promise<RepositoryContext>>();
  for (const draft of source.drafts) {
    if (selectedPaths && !selectedPaths.includes(draft.path)) {
      protectedEntries.push({ kind: 'not_selected', path: draft.path, reason: '不在本次精确路径白名单。' });
      continue;
    }
    const integrationOwned = draft.owners.some((owner) => owner.type !== 'workspace' || owner.kind === 'conflict');
    try {
      let pendingContext = repositories.get(draft.repositoryPath);
      if (!pendingContext) {
        pendingContext = readRepositoryContext(draft.repositoryPath);
        repositories.set(draft.repositoryPath, pendingContext);
      }
      const context = await pendingContext;
      const candidatePath = resolve(draft.path);
      /** 容器以实际受管祖先为准，Git 登记和数据库 owner 仍必须同时匹配。 */
      const container = findManagedWorktreeContainer(candidatePath);
      if (!container) throw new Error('路径没有受管 .zeus-worktrees 祖先。');
      await requireMaintenanceDirectory(container);
      const identity = await readPathIdentity(candidatePath);
      const registered = context.worktrees.has(candidatePath);
      if (!identity.present) {
        if (draft.owners.every((owner) => owner.type === 'attempt' && owner.state !== 'preparing' && owner.state !== 'active')) {
          protectedEntries.push({ kind: 'reclaimed_historical_path', path: candidatePath, reason: '目录已回收，仅保留非空历史 attempt 路径。' });
          continue;
        }
        if (registered) {
          protectedEntries.push({ kind: 'missing_registered_worktree', path: candidatePath, reason: '实体目录缺失但 Git 仍登记，需单独修复登记。' });
          continue;
        }
        candidates.push({ kind: 'metadata_reconciliation', path: candidatePath, identity, repositoryPath: context.topLevel, registered, owners: draft.owners });
        continue;
      }
      const status = await lstat(candidatePath);
      if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('目标不是物理目录。');
      if ((await realpath(candidatePath)) !== candidatePath) throw new Error('目标真实路径与登记路径不一致。');
      if (!registered) throw new Error('实体目录已经失去 Git 登记，需先保全或明确放弃，不能自动删除。');
      const facts = await inspectCleanGitFacts(candidatePath, context.topLevel);
      candidates.push({ kind: integrationOwned ? 'integration_worktree' : 'task_worktree', path: candidatePath, identity, repositoryPath: context.topLevel, registered, dirty: false, owners: draft.owners, ...facts });
    } catch (error) {
      protectedEntries.push({ kind: 'worktree_requires_review', path: draft.path, reason: errorMessage(error) });
    }
  }
  return { candidates, protected: protectedEntries };
}

/** 验证缓存所属仓库、固定相对路径、忽略规则和占用，不因工作树干净就扩大删除范围。 */
async function assertWorktreeCache(candidate: CleanupCandidate): Promise<void> {
  /** 缓存与所属工作树分别保存身份，避免把缓存删除扩成任务回收。 */
  const workspace = candidate.cacheWorkspace;
  if (!workspace) throw new Error('缓存缺少所属工作树。');
  await requireMaintenanceDirectory(workspace.path);
  /** 沿已有受管容器边界核验，不接受任意外部目录。 */
  const container = findManagedWorktreeContainer(workspace.path);
  if (!container) throw new Error('缓存工作树不在受管容器内。');
  await requireMaintenanceDirectory(container);
  /** Git 当前登记必须仍包含同一工作树。 */
  const context = await readRepositoryContext(workspace.repositoryPath);
  if (!context.worktrees.has(workspace.path)) throw new Error('缓存所属工作树已失去 Git 登记，继续保留。');
  /** 只允许工作树根或固定临时目录下的一层生成物。 */
  const relativePath = relative(workspace.path, candidate.path);
  /** 使用本机路径分隔符兼容 macOS 与 Windows。 */
  const segments = relativePath.split(sep);
  if (!(segments.length === 1 && ['node_modules', 'dist'].includes(segments[0]!)) && !(segments.length === 2 && segments[0] === '.tmp' && isRebuildableCacheName(segments[1]!))) throw new Error('缓存不属于固定的工作树生成目录。');
  await requireMaintenanceDirectory(candidate.path);
  /** 只读 Git 查询禁用可选锁，并限制返回量。 */
  const options = { encoding: 'utf8' as const, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  /** owner 必须对应实际 Git 根，不能只依赖数据库路径。 */
  const root = (await executeFile('git', ['-C', workspace.path, 'rev-parse', '--show-toplevel'], options)).stdout.trim();
  if (resolve(root) !== workspace.path) throw new Error('缓存 owner 不是实际 Git 工作树根。');
  /** 即使命中缓存目录名，也不删除被 Git 跟踪的内容。 */
  const tracked = await executeFile('git', ['-C', workspace.path, 'ls-files', '-z', '--', relativePath], options);
  if (tracked.stdout) throw new Error('生成目录内仍有 Git 跟踪文件，继续保留。');
  await executeFile('git', ['-C', workspace.path, 'check-ignore', '-q', '--', relativePath], options);
  await assertHistoricalCleanupAvailable([workspace.path]);
}

/** 显式盘点工作树内部生成物，复用 owner 查询并与整棵工作树候选去重。 */
async function inspectWorktreeCaches(databasePath: string, selectedPaths: string[] | null, wholeWorktrees: CleanupCandidate[]): Promise<{ candidates: CleanupCandidate[]; protected: ProtectedEntry[] }> {
  /** 复用正式 owner 与活动状态查询。 */
  const source = readWorktreeDrafts(databasePath, true);
  /** 只收集通过当前保护检查的精确路径。 */
  const candidates: CleanupCandidate[] = [];
  /** 保留明确拒绝原因供计划审阅。 */
  const protectedEntries = [...source.protected];
  for (const workspace of source.drafts) {
    if (selectedPaths && !selectedPaths.some((path) => path !== workspace.path && pathContains(workspace.path, path))) continue;
    if (wholeWorktrees.some((candidate) => pathContains(candidate.path, workspace.path))) continue;
    /** 只读取固定层级，不递归猜测临时目录的业务用途。 */
    const paths = [join(workspace.path, 'node_modules'), join(workspace.path, 'dist')];
    /** 临时目录只枚举已知缓存名称。 */
    const temporaryRoot = join(workspace.path, '.tmp');
    if ((await readPathIdentity(temporaryRoot)).present) {
      try {
        await requireMaintenanceDirectory(temporaryRoot);
        for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) if (isRebuildableCacheName(entry.name)) paths.push(join(temporaryRoot, entry.name));
      } catch (error) {
        protectedEntries.push({ kind: 'worktree_cache', path: temporaryRoot, reason: errorMessage(error) });
      }
    }
    for (const path of paths) {
      if (selectedPaths && !selectedPaths.includes(path)) continue;
      /** 目录不存在时不形成待删除事实。 */
      const identity = await readPathIdentity(path);
      if (!identity.present) continue;
      try {
        /** 深层摘要在身份与占用核验通过后生成。 */
        const candidate: CleanupCandidate = { kind: 'worktree_cache', path, identity, cacheWorkspace: workspace };
        await assertWorktreeCache(candidate);
        candidate.treeFacts = await inspectMaintenanceTree(path);
        candidates.push(candidate);
      } catch (error) {
        protectedEntries.push({ kind: 'worktree_cache', path, reason: errorMessage(error) });
      }
    }
  }
  return { candidates, protected: protectedEntries };
}

/** 只沿受管容器的固定层级盘点，不递归读取工作区源码或依赖。 */
async function inspectUnownedWorktreePaths(databasePath: string): Promise<ProtectedEntry[]> {
  const owners = readOnlyDatabase(
    databasePath,
    (database) =>
      [
        ...database.prepare('SELECT worktree_path AS path FROM task_workspaces WHERE worktree_path IS NOT NULL').all(),
        ...database.prepare('SELECT integration_path AS path FROM task_integrations WHERE integration_path IS NOT NULL').all(),
        ...database.prepare('SELECT worktree_path AS path FROM task_integration_attempts WHERE worktree_path IS NOT NULL').all(),
      ] as Array<{ path: string }>,
  ).map((row) => resolve(row.path));
  const containers = new Set<string>();
  for (const path of owners)
    for (let parent = dirname(path); dirname(parent) !== parent; parent = dirname(parent)) {
      if (basename(parent) === '.zeus-worktrees') {
        containers.add(parent);
        break;
      }
    }
  const entries: ProtectedEntry[] = [];
  /** 有任何现存或历史 owner 覆盖时由 owner 计划解释，不重复标成无主。 */
  const inspectLeaf = (path: string) => {
    if (!owners.some((owner) => pathContains(path, owner) || pathContains(owner, path))) entries.push({ kind: 'unowned_worktree', path, reason: '真实目录没有匹配的数据库 owner，不能按目录名称或年龄删除。' });
  };
  for (const container of [...containers].sort()) {
    if (!(await readPathIdentity(container)).present) continue;
    try {
      await requireMaintenanceDirectory(container);
      for (const project of await readdir(container, { withFileTypes: true })) {
        const base = join(container, project.name);
        if (!project.isDirectory() || project.isSymbolicLink()) {
          entries.push({ kind: 'unknown_container_entry', path: base, reason: '不是标准物理工作区容器。' });
          continue;
        }
        if ((await readPathIdentity(join(base, '.git'))).present) {
          inspectLeaf(base);
          continue;
        }
        for (const entry of await readdir(base, { withFileTypes: true })) {
          const parent = join(base, entry.name);
          if (!entry.isDirectory() || entry.isSymbolicLink()) {
            entries.push({ kind: 'unknown_container_entry', path: parent, reason: '工作区父目录布局未知。' });
            continue;
          }
          if (entry.name === '.integration') for (const child of await readdir(parent, { withFileTypes: true })) inspectLeaf(join(parent, child.name));
          else if (entry.name === '.integration-attempts')
            for (const integration of await readdir(parent, { withFileTypes: true })) {
              const integrationPath = join(parent, integration.name);
              if (!integration.isDirectory() || integration.isSymbolicLink()) {
                inspectLeaf(integrationPath);
                continue;
              }
              for (const attempt of await readdir(integrationPath)) inspectLeaf(join(integrationPath, attempt));
            }
          else if (/^[a-f0-9]{20}$/u.test(entry.name)) {
            const children = await readdir(parent);
            if (children.length === 0) entries.push({ kind: 'empty_worktree_parent', path: parent, reason: '空父目录仅列出；仍需 Git 登记与 owner 核对后以 rmdir 单独处理。' });
            else for (const child of children) inspectLeaf(join(parent, child));
          } else inspectLeaf(parent);
        }
      }
    } catch (error) {
      entries.push({ kind: 'worktree_inventory_error', path: container, reason: errorMessage(error) });
    }
  }
  return entries;
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
    if (!instance.isDirectory() || !/^instance-[a-f0-9]{16}$/u.test(instance.name)) {
      protectedEntries.push({ kind: 'test_root_material', path: join(testRoot, instance.name), reason: '不是受管验收 runId，继续保留。' });
      continue;
    }
    await requireMaintenanceDirectory(join(testRoot, instance.name));
    protectedEntries.push({ kind: 'test_instance_root', path: join(testRoot, instance.name), reason: '整个 Test 实例保持受保护，仅独立审核 read-only-validation/runId。' });
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
        const metadata = await readMaintenanceMetadata(manifestPath);
        const manifest = JSON.parse(metadata.text) as Record<string, unknown>;
        const database = manifest.database as Record<string, unknown> | undefined;
        if (manifest.format !== 'zeus-read-only-validation-manifest' || manifest.mode !== 'read_only_validation' || manifest.validationRoot !== root || manifest.runId !== run.name) throw new Error('manifest 与验收根身份不匹配。');
        if (database?.path !== join(root, 'data', 'zeus.db')) throw new Error('manifest 数据库路径不匹配。');
        if (typeof manifest.manifestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.manifestHash)) throw new Error('manifest 摘要无效。');
        /** 自签摘要只核对内容完整性，路径和固定 runId 仍单独检查。 */
        const payload = { ...manifest };
        delete payload.manifestHash;
        if (createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== manifest.manifestHash) throw new Error('验收 manifest 内容与摘要不匹配。');
        const databaseStatus = await lstat(join(root, 'data', 'zeus.db'));
        if (!databaseStatus.isFile() || databaseStatus.isSymbolicLink() || databaseStatus.nlink !== 1 || (await realpath(join(root, 'data', 'zeus.db'))) !== join(root, 'data', 'zeus.db')) throw new Error('验收数据库不是独立普通文件。');
        if (include) candidates.push({ kind: 'validation_snapshot', path: root, identity: await readPathIdentity(root), manifestSha256: metadata.sha256, validationDatabaseIdentity: await readPathIdentity(join(root, 'data', 'zeus.db')) });
        else protectedEntries.push({ kind: 'validation_snapshot', path: root, reason: '只读验收证据默认保留；需要 --include-validation-snapshots 才纳入确认计划。' });
      } catch (error) {
        protectedEntries.push({ kind: 'validation_snapshot', path: root, reason: errorMessage(error) });
      }
    }
  }
  return { candidates, protected: protectedEntries };
}

/** 复核工作树干净且提交由源仓的其他命名引用保全；完整副本还要核对全部引用。 */
async function inspectCleanGitFacts(path: string, repositoryPath: string, independentCopy = false): Promise<{ head: string; preservingRefs: string[]; preservedCommitTips?: string[] }> {
  const options = { encoding: 'utf8' as const, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  const root = (await executeFile('git', ['-C', path, 'rev-parse', '--show-toplevel'], options)).stdout.trim();
  if (resolve(root) !== path) throw new Error('候选路径不是独立 Git 工作树根。');
  const state = await executeFile('git', ['-C', path, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], options);
  if (state.stdout) throw new Error('工作树含未提交或未跟踪内容，需先保全或明确放弃。');
  const head = (await executeFile('git', ['-C', path, 'rev-parse', 'HEAD'], options)).stdout.trim();
  let ownBranch: string | null = null;
  try {
    ownBranch = (await executeFile('git', ['-C', path, 'symbolic-ref', '-q', 'HEAD'], options)).stdout.trim();
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
  }
  const preservingRefs = (await executeFile('git', ['-C', repositoryPath, 'for-each-ref', `--contains=${head}`, '--format=%(refname)'], options)).stdout
    .trim()
    .split('\n')
    .filter((name) => name && (independentCopy || name !== ownBranch))
    .sort();
  if (preservingRefs.length === 0) throw new Error('HEAD 没有其他已保全命名引用，不能只凭工作树干净删除。');
  if (independentCopy) {
    await requireMaintenanceDirectory(join(path, '.git'));
    const common = (await executeFile('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], options)).stdout.trim();
    if (resolve(common) !== join(path, '.git')) throw new Error('发布副本不是独立 Git 仓库，必须走 worktree 回收。');
    await assertSourceObjectsIndependent(repositoryPath, path);
    /** reflog 中的提交即使不再由副本分支指向，也仍是需要保全的恢复来源。 */
    const [references, reflog] = await Promise.all([executeFile('git', ['-C', path, 'for-each-ref', '--format=%(objectname)'], options), executeFile('git', ['-C', path, 'reflog', 'show', '--all', '--format=%H'], options)]);
    /** 排序去重后固定全部恢复入口，避免确认摘要依赖枚举顺序。 */
    const preservedCommitTips = [...new Set(`${references.stdout}\n${reflog.stdout}`.trim().split('\n').filter(Boolean))].sort();
    for (const tip of preservedCommitTips) {
      try {
        /** 每个提交都必须可从源仓命名引用恢复。 */
        const refs = await executeFile('git', ['-C', repositoryPath, 'for-each-ref', `--contains=${tip}`, '--format=%(refname)'], options);
        if (!refs.stdout.trim()) throw new Error('没有保全引用。');
      } catch (error) {
        throw new Error(`发布副本的引用或 reflog 提交尚未由源仓命名引用保全：${tip}。${errorMessage(error)}`);
      }
    }
    return { head, preservingRefs, preservedCommitTips };
  }
  return { head, preservingRefs };
}

/** 源仓对象库及其 alternates 不能依赖待删除副本，否则命名引用也不能保全提交。 */
async function assertSourceObjectsIndependent(repositoryPath: string, candidatePath: string): Promise<void> {
  const common = (await executeFile('git', ['-C', repositoryPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout.trim();
  const pending = [join(resolve(common), 'objects')];
  const visited = new Set<string>();
  while (pending.length) {
    const directory = await realpath(pending.pop()!);
    if (pathContains(candidatePath, directory)) throw new Error('源仓对象库仍依赖该发布副本，继续保留。');
    if (visited.has(directory)) continue;
    visited.add(directory);
    if (visited.size > 256) throw new Error('对象库依赖层级过大，需人工核对。');
    const alternates = join(directory, 'info', 'alternates');
    if (!(await readPathIdentity(alternates)).present) continue;
    for (const line of (await readMaintenanceMetadata(alternates)).text.split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith('"')) throw new Error('对象库依赖使用转义路径，需人工核对。');
      pending.push(resolve(directory, line));
    }
  }
}

/** 枚举固定缓存、独立发布副本与历史产物，禁止整个 .tmp 成为候选。 */
async function inspectRepositoryCaches(repositoryRoot: string, includeReleaseRecovery: boolean, includeReleaseArtifacts: boolean): Promise<{ candidates: CleanupCandidate[]; protected: ProtectedEntry[] }> {
  const candidates: CleanupCandidate[] = [];
  const protectedEntries: ProtectedEntry[] = [];
  const temporaryRoot = join(repositoryRoot, '.tmp');
  /** 只有固定构建入口的物理缓存可以进入默认候选。 */
  const inspect = async (path: string, kind: CleanupCandidate['kind'], include: boolean) => {
    const identity = await readPathIdentity(path);
    if (!identity.present) return;
    try {
      await requireMaintenanceDirectory(path);
      if (!include) throw new Error('历史发布或验收材料默认保留，需要独立参数与精确路径审阅。');
      if (kind === 'release_copy') candidates.push({ kind, path, identity, repositoryPath: repositoryRoot, ...(await inspectCleanGitFacts(path, repositoryRoot, true)) });
      else {
        if ((await readPathIdentity(join(path, '.git'))).present) throw new Error('目标包含 Git 仓库，不能按缓存或产物删除。');
        candidates.push({ kind, path, identity, ...(kind === 'release_artifacts' ? { treeFacts: await inspectMaintenanceTree(path) } : {}) });
      }
    } catch (error) {
      protectedEntries.push({ kind, path, reason: errorMessage(error) });
    }
  };
  if ((await readPathIdentity(temporaryRoot)).present) {
    await requireMaintenanceDirectory(temporaryRoot);
    for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
      const path = join(temporaryRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        protectedEntries.push({ kind: 'unclassified_tmp', path, reason: '不是已登记的物理构建目录。' });
        continue;
      }
      if (isRebuildableCacheName(entry.name)) await inspect(path, 'rebuildable_cache', true);
      else if (entry.name === 'zeus-release') await inspect(path, 'release_artifacts', includeReleaseArtifacts);
      else if (entry.name === 'release-candidate-v0.2.8') await inspect(path, 'release_copy', includeReleaseRecovery);
      else if (entry.name === releaseRecoveryDirectoryName) {
        await requireMaintenanceDirectory(path);
        for (const copy of await readdir(path, { withFileTypes: true })) {
          const copyPath = join(path, copy.name);
          if (!/^[a-f0-9]{40,64}$/u.test(copy.name) || !copy.isDirectory() || copy.isSymbolicLink()) protectedEntries.push({ kind: 'release_copy', path: copyPath, reason: '发布副本布局未知，继续保留。' });
          else await inspect(copyPath, 'release_copy', includeReleaseRecovery);
        }
      } else protectedEntries.push({ kind: 'unclassified_tmp', path, reason: '没有可靠所有权或重建规则，继续保留。' });
    }
  }
  await inspect(join(repositoryRoot, 'dist', 'test'), 'release_artifacts', includeReleaseArtifacts);
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

/** 仅在显式维护时读取清单与一级内容，不在启动或发送链路扫描。 */
async function inspectSkillResources(dataRoot: string): Promise<SkillResourceFacts> {
  const root = join(dataRoot, 'artifacts', 'skill-resources');
  const facts: SkillResourceFacts = { root, snapshotCount: 0, payloadSnapshotCount: 0, metadataOnlySnapshotCount: 0, invalidSnapshotCount: 0 };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return facts;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    facts.snapshotCount += 1;
    try {
      const snapshot = join(root, entry.name);
      await requireMaintenanceDirectory(snapshot);
      const catalog = JSON.parse((await readMaintenanceMetadata(join(snapshot, 'catalog.json'))).text) as { skills?: unknown };
      if (!Array.isArray(catalog.skills)) throw new Error('历史清单缺少 skills。');
      const children = await readdir(snapshot);
      if (children.some((name) => name !== 'catalog.json' && name !== 'resources-reclaimed.json')) facts.payloadSnapshotCount += 1;
      else facts.metadataOnlySnapshotCount += 1;
    } catch {
      facts.invalidSnapshotCount += 1;
    }
  }
  return facts;
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
  await requireMaintenanceDirectory(arguments_.dataRoot);
  const repositoryRoot = await resolveRepositoryRoot(arguments_.repositoryPath);
  const external = arguments_.scope !== 'internal';
  const internal = arguments_.scope !== 'external';
  const worktrees = arguments_.discardObsoleteWorktrees
    ? await inspectObsoleteWorktrees(databasePath, repositoryRoot, arguments_.selectedPaths!)
    : external
      ? await inspectWorktreeCandidates(databasePath, arguments_.selectedPaths)
      : { candidates: [], protected: [] };
  /** 缓存子目录与整棵工作树共用计划、确认和执行保护。 */
  const worktreeCaches = external && arguments_.includeWorktreeCaches ? await inspectWorktreeCaches(databasePath, arguments_.selectedPaths, worktrees.candidates) : { candidates: [], protected: [] };
  /** 历史重复 home 根只在当前平台能形成合法路径时盘点；Windows 不能包含第二个盘符。 */
  const standardTestRoot = join(homedir(), '.zeus-test');
  const legacyTestRoot = join(homedir(), standardTestRoot);
  const testRoots = [...new Set([standardTestRoot, ...(process.platform !== 'win32' || !relative(homedir(), legacyTestRoot).includes(':') ? [legacyTestRoot] : [])])];
  const validationGroups = external && !arguments_.discardObsoleteWorktrees ? await Promise.all(testRoots.map((root) => inspectValidationSnapshots(root, arguments_.includeValidationSnapshots))) : [];
  const caches = external && !arguments_.discardObsoleteWorktrees ? await inspectRepositoryCaches(repositoryRoot, arguments_.includeReleaseRecovery, arguments_.includeReleaseArtifacts) : { candidates: [], protected: [] };
  const standalone = internal && !arguments_.discardObsoleteWorktrees ? await inspectStandaloneReleases(arguments_.dataRoot) : { candidates: [], protected: [] };
  const candidates: CleanupCandidate[] = [];
  const protectedEntries: ProtectedEntry[] = [
    ...(external && !arguments_.discardObsoleteWorktrees ? await inspectUnownedWorktreePaths(databasePath) : []),
    ...worktrees.protected,
    ...worktreeCaches.protected,
    ...validationGroups.flatMap((group) => group.protected),
    ...caches.protected,
    ...standalone.protected,
  ];
  for (const candidate of [...worktrees.candidates, ...worktreeCaches.candidates, ...validationGroups.flatMap((group) => group.candidates), ...caches.candidates, ...standalone.candidates]) {
    const inside = pathContains(arguments_.dataRoot, candidate.path);
    if ((inside && !internal) || (!inside && !external)) protectedEntries.push({ kind: 'outside_scope', path: candidate.path, reason: '不属于本次内外根范围。' });
    else if (arguments_.selectedPaths && !arguments_.selectedPaths.includes(candidate.path)) protectedEntries.push({ kind: 'not_selected', path: candidate.path, reason: '不在本次精确路径白名单。' });
    else {
      try {
        if (arguments_.allowOnline) {
          assertOnlineCandidateKind(candidate, arguments_.dataRoot);
          /** 可变缓存与旧发行目录都固定深层身份，不能只比较顶层目录时间。 */
          if (['rebuildable_cache', 'standalone_release'].includes(candidate.kind)) candidate.treeFacts = await inspectMaintenanceTree(candidate.path);
        }
        candidates.push(candidate);
      } catch (error) {
        protectedEntries.push({ kind: candidate.kind, path: candidate.path, reason: errorMessage(error) });
      }
    }
  }
  if (arguments_.allowOnline) {
    try {
      /** 全部内容扫描结束后一次核对进程，避免每个目录重复读取全机打开文件。 */
      await assertHistoricalCleanupAvailable(candidates.filter((candidate) => candidate.identity.present).map((candidate) => candidate.path));
    } catch {
      /** 只有发现占用时才逐项定位，保持原有准确保留原因。 */
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        /** 本项身份已经完成扫描，此处只核对实际占用。 */
        const candidate = candidates[index]!;
        if (!candidate.identity.present) continue;
        try {
          await assertHistoricalCleanupAvailable([candidate.path]);
        } catch (error) {
          protectedEntries.push({ kind: candidate.kind, path: candidate.path, reason: errorMessage(error) });
          candidates.splice(index, 1);
        }
      }
    }
  }
  candidates.sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates.slice(0, index).some((previous) => pathContains(previous.path, candidates[index]!.path) || pathContains(candidates[index]!.path, previous.path))) throw new Error('清理候选包含重复或父子重叠路径，已拒绝整个计划。');
  }
  for (const path of arguments_.selectedPaths ?? []) {
    if (!candidates.some((candidate) => candidate.path === path) && !protectedEntries.some((entry) => entry.path === path))
      protectedEntries.push({ kind: 'unrecognized_requested_path', path, reason: '白名单路径没有通过受管资源规则，不会删除。' });
  }
  protectedEntries.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  return {
    format: planFormat,
    allowOnline: arguments_.allowOnline,
    discardObsoleteWorktrees: arguments_.discardObsoleteWorktrees,
    platform: process.platform,
    dataRoot: arguments_.dataRoot,
    databasePath,
    databaseIdentity: await readPathIdentity(databasePath),
    repositoryRoot,
    includeValidationSnapshots: arguments_.includeValidationSnapshots,
    includeReleaseRecovery: arguments_.includeReleaseRecovery,
    includeReleaseArtifacts: arguments_.includeReleaseArtifacts,
    includeWorktreeCaches: arguments_.includeWorktreeCaches,
    scope: arguments_.scope,
    selectedPaths: arguments_.selectedPaths,
    candidates,
    protected: protectedEntries,
    skillResources: internal ? await inspectSkillResources(arguments_.dataRoot) : null,
    conversationSync: internal ? inspectConversationSync(databasePath) : null,
  };
}

/** 物理删除前再次拒绝符号链接和身份漂移。 */
async function assertCandidateIdentity(candidate: CleanupCandidate): Promise<void> {
  const current = await readPathIdentity(candidate.path);
  if (JSON.stringify(current) !== JSON.stringify(candidate.identity)) throw new Error('目标在计划确认后发生变化，请重新 dry-run。');
  if (!current.present) return;
  const status = await lstat(candidate.path);
  if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(candidate.path)) !== candidate.path) throw new Error('目标不再是原物理目录。');
}

/** 默认保全模式在删除前复核全部引用，拒绝 owner 漂移、非终态和活动 Runtime。 */
function assertCurrentWorktreeOwners(database: DatabaseSync, candidate: CleanupCandidate): void {
  const references = readWorktreeReferences(database);
  const related = references.filter((row) => pathContains(candidate.path, resolve(row.path)) || pathContains(resolve(row.path), candidate.path));
  if (
    related.length !== candidate.owners?.length ||
    related.some(
      (row) =>
        resolve(row.path) !== candidate.path ||
        row.deletedAt !== null ||
        !terminalTaskStatuses.has(row.managementStatus ?? '') ||
        !candidate.owners?.some((owner) => owner.type === row.type && owner.id === row.id && owner.taskId === row.taskId && owner.state === row.state),
    )
  )
    throw new Error('工作区的全部 owner、路径或任务状态与计划不一致。');
  const active = activeTaskIds(database);
  if (related.some((row) => active.has(row.taskId))) throw new Error('工作区所属任务仍有活动 Runtime 或 Provider。');
}

/** 只用非强制 Git 回收，任何未提交内容、未保全提交或登记变化都保留。 */
async function removeWorktreeCandidate(candidate: CleanupCandidate): Promise<void> {
  await assertCandidateIdentity(candidate);
  if (!candidate.identity.present) {
    if (candidate.registered) throw new Error('目录已缺失但 Git 仍登记，需单独修复登记，不能默认为回收成功。');
    return;
  }
  if (!candidate.registered || !candidate.repositoryPath) throw new Error('实体工作区没有有效 Git 登记，继续保留。');
  const facts = await inspectCleanGitFacts(candidate.path, candidate.repositoryPath);
  if (facts.head !== candidate.head || JSON.stringify(facts.preservingRefs) !== JSON.stringify(candidate.preservingRefs)) throw new Error('工作区 HEAD 或保全引用在确认后发生变化。');
  await executeFile('git', ['-C', candidate.repositoryPath, 'worktree', 'remove', candidate.path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if ((await readPathIdentity(candidate.path)).present) throw new Error('Git 回收后原目录仍然存在。');
}

/** 物理回收成功后条件更新原 owner；事务由调用方持有，失败可重新生成元数据对账计划。 */
function reconcileWorktreeOwners(database: DatabaseSync, candidate: CleanupCandidate): void {
  const now = new Date().toISOString();
  for (const owner of candidate.owners ?? []) {
    let changes: number | bigint = 1;
    if (owner.type === 'workspace')
      changes = database
        .prepare("UPDATE task_workspaces SET worktree_path=NULL,state=CASE WHEN state IN ('merged','discarded') THEN state ELSE 'reclaimed' END,last_error=NULL,updated_at=? WHERE id=? AND worktree_path=? AND state=?")
        .run(now, owner.id, candidate.path, owner.state).changes;
    else if (owner.type === 'integration')
      changes = database
        .prepare(
          "UPDATE task_integrations SET integration_path=NULL,state=CASE WHEN state='merged' THEN state ELSE 'failed' END,conflict_files_json='[]',last_error=CASE WHEN state='merged' THEN NULL ELSE '历史现场已由明确授权的维护清理回收。' END,updated_at=? WHERE id=? AND integration_path=? AND state=?",
        )
        .run(now, owner.id, candidate.path, owner.state).changes;
    else if (owner.state === 'preparing' || owner.state === 'active')
      changes = database
        .prepare("UPDATE task_integration_attempts SET state='stale',last_error='历史现场已由明确授权的维护清理回收。',updated_at=? WHERE id=? AND worktree_path=? AND state=?")
        .run(now, owner.id, candidate.path, owner.state).changes;
    if (Number(changes) !== 1) throw new Error('owner 在更新时不再匹配原计划，需重新对账。');
  }
}

/** 显式丢弃先完成耗时复核，再在短事务内复核任务状态并回收登记和物理目录。 */
async function removeObsoleteWorktree(database: DatabaseSync, candidate: CleanupCandidate, plan: CleanupPlan): Promise<void> {
  if (!plan.discardObsoleteWorktrees || !candidate.discardedReferences) throw new Error('丢弃源码缺少显式授权模式。');
  await assertCandidateIdentity(candidate);
  if (candidate.identity.present) {
    if (JSON.stringify(await inspectMaintenanceTree(candidate.path, true)) !== JSON.stringify(candidate.treeFacts)) throw new Error('待丢弃工作树的内容在确认后已变化。');
    if (JSON.stringify(await inspectLinkedWorktrees(candidate.path)) !== JSON.stringify(candidate.linkedWorktrees)) throw new Error('Git 登记在确认后已变化。');
    if (!findManagedWorktreeContainer(candidate.path)) await assertSourceObjectsIndependent(plan.repositoryRoot, candidate.path);
  }
  if (plan.allowOnline) {
    /** 缺失目录只做元数据对账，物理目录才需要打开文件检查。 */
    if (candidate.identity.present) await assertHistoricalCleanupAvailable([candidate.path]);
  } else await assertOfflineMaintenance(plan.dataRoot, [candidate.path]);
  database.exec('BEGIN IMMEDIATE');
  try {
    /** 写事务阻止任务在最终状态检查与删除之间恢复成未完成状态。 */
    const currentReferences = discardableWorktreeReferences(database, candidate.path);
    if (JSON.stringify(currentReferences) !== JSON.stringify(candidate.discardedReferences)) throw new Error('正式任务或路径引用已经变化，需要重新生成计划。');
    /** 环境引用的并发变化也不能由旧确认放行。 */
    const currentEnvironments = relatedWorktreeEnvironments(database, candidate.path);
    if (JSON.stringify(currentEnvironments) !== JSON.stringify(candidate.discardedEnvironments)) throw new Error('正式任务的聚合环境已经变化，需要重新生成计划。');
    await assertCandidateIdentity(candidate);
    for (const registration of candidate.linkedWorktrees ?? []) {
      await executeFile('git', ['--git-dir', registration.commonDirectory, 'worktree', 'remove', '--force', '--force', registration.path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    }
    if ((await readPathIdentity(candidate.path)).present) await rm(candidate.path, { recursive: true, force: false, maxRetries: deletionRetryCount, retryDelay: deletionRetryDelayMs });
    if ((await readPathIdentity(candidate.path)).present) throw new Error('回收后原目录仍然存在。');
    for (const reference of currentReferences) reconcileWorktreeOwners(database, { ...candidate, path: reference.path, owners: [reference] });
    for (const environment of currentEnvironments.filter((entry) => pathContains(candidate.path, resolve(entry.path)))) {
      /** 根目录确已回收后才清除环境入口，不改任务状态或历史成果。 */
      const changes = database
        .prepare("UPDATE task_environments SET root_path=NULL,state='reclaimed',last_error=NULL,updated_at=? WHERE id=? AND root_path=? AND state=?")
        .run(new Date().toISOString(), environment.id, environment.path, environment.state).changes;
      if (Number(changes) !== 1) throw new Error('聚合环境在更新时已不匹配原计划。');
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** 删除普通目录候选，任何路径漂移都保留现场。 */
async function removeDirectoryCandidate(candidate: CleanupCandidate, plan: CleanupPlan): Promise<void> {
  await assertCandidateIdentity(candidate);
  if (!candidate.identity.present) return;
  if (candidate.manifestSha256 && (await readMaintenanceMetadata(join(candidate.path, 'data', 'zeus.db.read-only-validation.json'))).sha256 !== candidate.manifestSha256) throw new Error('验收清单在确认后已变化。');
  if (candidate.validationDatabaseIdentity && JSON.stringify(await readPathIdentity(join(candidate.path, 'data', 'zeus.db'))) !== JSON.stringify(candidate.validationDatabaseIdentity)) throw new Error('验收数据库在确认后已变化。');
  if (candidate.treeFacts && JSON.stringify(await inspectMaintenanceTree(candidate.path)) !== JSON.stringify(candidate.treeFacts)) throw new Error('历史材料的深层内容在确认后已变化。');
  if (candidate.kind === 'release_copy') {
    const facts = await inspectCleanGitFacts(candidate.path, candidate.repositoryPath!, true);
    if (facts.head !== candidate.head || JSON.stringify(facts.preservingRefs) !== JSON.stringify(candidate.preservingRefs) || JSON.stringify(facts.preservedCommitTips) !== JSON.stringify(candidate.preservedCommitTips))
      throw new Error('发布副本引用或 reflog 在确认后已变化。');
  }
  if (candidate.cacheWorkspace) {
    /** 深层扫描结束后才复核活动状态，避免扫描期间新启动的任务被旧状态放行。 */
    const current = readWorktreeDrafts(plan.databasePath, true).drafts.find((draft) => draft.path === candidate.cacheWorkspace!.path);
    if (JSON.stringify(current) !== JSON.stringify(candidate.cacheWorkspace)) throw new Error('缓存所属工作树的 owner 或活动状态已经变化。');
    await assertWorktreeCache(candidate);
  }
  if (candidate.kind === 'standalone_release') {
    /** 当前版本与回退版本可能在线切换，每项删除前重新读取正式入口。 */
    const current = (await inspectStandaloneReleases(plan.dataRoot)).candidates.find((entry) => entry.path === candidate.path);
    if (!current || JSON.stringify(current.identity) !== JSON.stringify(candidate.identity)) throw new Error('Codex 发行目录已成为当前或回退版本，或身份已变化。');
  }
  /** 所有耗时内容检查完成后再次核验占用，不凭计划生成时的进程快照删除。 */
  if (plan.allowOnline) await assertHistoricalCleanupAvailable([candidate.path]);
  else await assertOfflineMaintenance(plan.dataRoot, [candidate.path]);
  await assertCandidateIdentity(candidate);
  await rm(candidate.path, { recursive: true, force: false, maxRetries: deletionRetryCount, retryDelay: deletionRetryDelayMs });
}

/** 原子更新操作日志，删除中断时仍保留完整计划与当前项目身份。 */
async function updateCleanupAudit(reportPath: string, value: unknown): Promise<void> {
  const temporary = `${reportPath}.${randomUUID()}.pending`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, reportPath);
}

/** 执行精确白名单；在线类别复用同一保护规则，正式 owner 写入仍要求离线。 */
async function applyPlan(plan: CleanupPlan): Promise<{ reportPath: string; results: CleanupResult[]; availableBytesBefore: number; availableBytesAfter: number }> {
  if (!plan.selectedPaths || plan.selectedPaths.length !== plan.candidates.length || plan.selectedPaths.some((path) => !plan.candidates.some((candidate) => candidate.path === path)))
    throw new Error('白名单包含受保护或未知路径，整个计划不执行。');
  if (plan.allowOnline) for (const candidate of plan.candidates) assertOnlineCandidateKind(candidate, plan.dataRoot);
  const paths = plan.candidates.filter((candidate) => candidate.identity.present).map((candidate) => candidate.path);
  if (plan.allowOnline) await assertHistoricalCleanupAvailable(paths);
  else await assertOfflineMaintenance(plan.dataRoot, paths);
  const auditRoot = join(plan.dataRoot, 'artifacts', 'maintenance');
  if (plan.candidates.some((candidate) => pathContains(candidate.path, auditRoot))) throw new Error('审计目录不能位于删除候选内。');
  await mkdir(auditRoot, { recursive: true, mode: 0o700 });
  await requireMaintenanceDirectory(auditRoot);
  const reportPath = join(auditRoot, `generated-data-cleanup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  const filesystemBefore = await statfs(plan.dataRoot);
  const availableBytesBefore = Number(filesystemBefore.bavail) * Number(filesystemBefore.bsize);
  const results: CleanupResult[] = [];
  await writeFile(reportPath, `${JSON.stringify({ format: planFormat, plan, results, availableBytesBefore, inProgress: null }, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true });
  const database = plan.candidates.some((candidate) => candidate.owners || candidate.discardedReferences)
    ? new DatabaseSync(plan.databasePath, { timeout: 3_000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false })
    : null;
  try {
    for (const candidate of plan.candidates) {
      await updateCleanupAudit(reportPath, { format: planFormat, plan, results, availableBytesBefore, inProgress: candidate });
      try {
        if (plan.allowOnline && candidate.kind !== 'obsolete_worktree') {
          /** 缺失目录继续通过事务内任务状态检查完成元数据对账。 */
          if (candidate.identity.present) await assertHistoricalCleanupAvailable([candidate.path]);
        } else if (!plan.allowOnline) await assertOfflineMaintenance(plan.dataRoot, [candidate.path]);
        if (candidate.kind === 'obsolete_worktree' && database) await removeObsoleteWorktree(database, candidate, plan);
        else if (candidate.owners && database) {
          database.exec('BEGIN IMMEDIATE');
          try {
            assertCurrentWorktreeOwners(database, candidate);
            await removeWorktreeCandidate(candidate);
            reconcileWorktreeOwners(database, candidate);
            database.exec('COMMIT');
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
        } else await removeDirectoryCandidate(candidate, plan);
        results.push({ kind: candidate.kind, path: candidate.path, status: candidate.identity.present ? 'removed' : 'reconciled', message: null });
      } catch (error) {
        results.push({ kind: candidate.kind, path: candidate.path, status: 'failed', message: errorMessage(error) });
        await updateCleanupAudit(reportPath, { format: planFormat, plan, results, availableBytesBefore, inProgress: null, stoppedOnFailure: true });
        break;
      }
      await updateCleanupAudit(reportPath, { format: planFormat, plan, results, availableBytesBefore, inProgress: null });
    }
  } finally {
    database?.close();
  }
  const filesystemAfter = await statfs(plan.dataRoot);
  const availableBytesAfter = Number(filesystemAfter.bavail) * Number(filesystemAfter.bsize);
  await updateCleanupAudit(reportPath, {
    format: planFormat,
    completedAt: new Date().toISOString(),
    availableBytesBefore,
    availableBytesAfter,
    plan,
    results,
    inProgress: null,
    unattempted: plan.candidates.filter((candidate) => !results.some((result) => result.path === candidate.path)),
  });
  return { reportPath, results, availableBytesBefore, availableBytesAfter };
}

/** 解析命令行；默认只输出计划，不接收模糊确认。 */
async function parseArguments(values: string[]): Promise<CleanupArguments> {
  const parsed = parseArgs({
    args: values,
    strict: true,
    options: {
      apply: { type: 'boolean' },
      'allow-online': { type: 'boolean' },
      /** 明确放弃历史源码；默认清理仍保全未提交内容。 */
      'discard-obsolete-worktrees': { type: 'boolean' },
      confirmation: { type: 'string' },
      'data-root': { type: 'string' },
      repository: { type: 'string' },
      'include-validation-snapshots': { type: 'boolean' },
      'include-release-recovery': { type: 'boolean' },
      'include-repository-temp': { type: 'boolean' },
      'include-release-artifacts': { type: 'boolean' },
      /** 只有显式指定时才盘点工作树内的固定生成目录。 */
      'include-worktree-caches': { type: 'boolean' },
      scope: { type: 'string', default: 'external' },
      'paths-file': { type: 'string' },
    },
  }).values;
  if (parsed['include-repository-temp']) throw new Error('整根 .tmp 删除已移除，请使用 --paths-file 与具体类别参数。');
  if (!['external', 'internal', 'all'].includes(parsed.scope ?? '')) throw new Error('--scope 只接受 external、internal 或 all。');
  const selectedPaths = await readMaintenanceAllowlist(parsed['paths-file'] ?? null);
  if (parsed.apply && !selectedPaths) throw new Error('执行删除必须提供已经审阅的 --paths-file。');
  if (parsed['discard-obsolete-worktrees'] && (!selectedPaths || parsed['include-worktree-caches'])) throw new Error('丢弃工作树必须提供精确路径清单，不能混用工作树缓存清理。');
  const dataRoot = resolve(parsed['data-root'] ?? join(homedir(), '.zeus'));
  const repositoryPath = resolve(parsed.repository ?? process.cwd());
  return {
    allowOnline: parsed['allow-online'] ?? false,
    discardObsoleteWorktrees: parsed['discard-obsolete-worktrees'] ?? false,
    apply: parsed.apply ?? false,
    confirmation: parsed.confirmation ?? null,
    dataRoot,
    repositoryPath,
    includeValidationSnapshots: parsed['include-validation-snapshots'] ?? false,
    includeReleaseRecovery: parsed['include-release-recovery'] ?? false,
    scope: parsed.scope as CleanupArguments['scope'],
    selectedPaths,
    includeReleaseArtifacts: parsed['include-release-artifacts'] ?? false,
    includeWorktreeCaches: parsed['include-worktree-caches'] ?? false,
  };
}

/** 主流程先生成计划摘要，只有完全匹配的确认文本才执行删除。 */
async function main(): Promise<void> {
  const arguments_ = await parseArguments(process.argv.slice(2));
  const plan = await createPlan(arguments_);
  /** 只固定实际删除事实；正常退出的数据库 checkpoint 和无关诊断不能替换已批准目标。 */
  const approvalFacts = {
    format: plan.format,
    platform: plan.platform,
    allowOnline: plan.allowOnline,
    discardObsoleteWorktrees: plan.discardObsoleteWorktrees,
    dataRoot: plan.dataRoot,
    databasePath: plan.databasePath,
    databaseIdentity: { present: plan.databaseIdentity.present, device: plan.databaseIdentity.device, inode: plan.databaseIdentity.inode },
    repositoryRoot: plan.repositoryRoot,
    scope: plan.scope,
    includeValidationSnapshots: plan.includeValidationSnapshots,
    includeReleaseRecovery: plan.includeReleaseRecovery,
    includeReleaseArtifacts: plan.includeReleaseArtifacts,
    includeWorktreeCaches: plan.includeWorktreeCaches,
    selectedPaths: plan.selectedPaths,
    candidates: plan.candidates,
  };
  const planHash = createHash('sha256').update(JSON.stringify(approvalFacts)).digest('hex');
  const expectedConfirmation = `DELETE ZEUS ${planHash}`;
  if (!arguments_.apply || arguments_.confirmation !== expectedConfirmation) {
    process.stdout.write(
      `${JSON.stringify({ status: 'confirmation_required', summary: { candidates: plan.candidates.length, protected: plan.protected.length, protectedByKind: Object.fromEntries([...new Set(plan.protected.map((entry) => entry.kind))].sort().map((kind) => [kind, plan.protected.filter((entry) => entry.kind === kind).length])) }, plan, planHash, expectedConfirmation }, null, 2)}\n`,
    );
    if (arguments_.apply) process.exitCode = 2;
    return;
  }
  const result = await withMaintenanceLease(plan.dataRoot, () => applyPlan(plan));
  const failed = result.results.filter((entry) => entry.status === 'failed');
  process.stdout.write(
    `${JSON.stringify({ status: failed.length === 0 ? 'directory_cleanup_completed' : 'directory_cleanup_partially_completed', remaining: { protected: plan.protected, skillResources: plan.skillResources, conversationSync: plan.conversationSync }, ...result }, null, 2)}\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
