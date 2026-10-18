import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import type { CodexAppServerManager, CodexSkillMetadata, CodexSkillScope, CodexSkillsListEntry } from '@zeus/ai-runtime';
import { skillFrontmatterScalar } from './skillFrontmatter.js';

/** Git 安装命令沿用 Node 的异步子进程接口。 */
const execFileAsync = promisify(execFile);
/** 单个 Skill 最多允许的文件系统节点数量。 */
const maximumSkillNodes = 5_000;
/** 单个 Skill 最多允许的总文件字节数。 */
const maximumSkillBytes = 50 * 1024 * 1024;
/** 运行时目录只读取入口元数据；单个入口文件仍需设置明确内存上限。 */
const maximumSkillManifestBytes = 1024 * 1024;
/** 元数据缓存限制跨项目累计目录数量，避免长期运行时无界增长。 */
const maximumSkillManifestCacheEntries = 1_000;
/** 订阅服务只补充目录，等待预算必须远小于本地接口的读取期限。 */
const providerCatalogWaitMs = 1_000;

export type ZeusSkillInstallSource = { kind: 'local'; path: string } | { kind: 'git'; repositoryUrl: string; ref?: string; subdirectory?: string };

export interface ZeusSkillDescriptor {
  id: string;
  name: string;
  description: string;
  shortDescription?: string;
  invocation: string;
  path: string;
  scope: CodexSkillScope;
  removable: boolean;
  interface?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  /** 冻结 Skill 的内容摘要；旧清单迁移后补齐。 */
  contentHash?: string;
}

export interface ZeusSkillCatalog {
  cwd: string;
  skills: ZeusSkillDescriptor[];
  errors: Array<Record<string, unknown>>;
  refreshedAt: string;
}

export interface ZeusSkillService {
  list(input: {
    /** 发现 Skill 的实际工作目录。 */
    cwd: string;
    /** 是否要求 Provider 刷新其补充元数据。 */
    forceReload?: boolean;
    /** 发送链路传 false，只读取本地目录并隔离 Provider 网络状态。 */
    includeProvider?: boolean;
  }): Promise<ZeusSkillCatalog>;
  /** 只读历史版本生成的技能清单，不再创建新的 Skill 快照。 */
  readFrozen(snapshotId: string): Promise<ZeusSkillCatalog>;
  install(input: { cwd: string; source: ZeusSkillInstallSource }): Promise<{ skill: ZeusSkillDescriptor; installedAt: string }>;
  remove(input: { cwd: string; skillId: string }): Promise<{ removed: true; skillId: string; name: string }>;
  resolve(input: { cwd: string; skillId: string }): Promise<{ id: string; name: string; description: string; path: string }>;
}

export type ZeusSkillServiceErrorCode = 'ZEUS_SKILL_INPUT_INVALID' | 'ZEUS_SKILL_SOURCE_UNAVAILABLE' | 'ZEUS_SKILL_UNSAFE_SOURCE' | 'ZEUS_SKILL_ALREADY_EXISTS' | 'ZEUS_SKILL_INVALID' | 'ZEUS_SKILL_NOT_FOUND' | 'ZEUS_SKILL_REMOVE_FORBIDDEN';

export class ZeusSkillServiceError extends Error {
  readonly name = 'ZeusSkillServiceError';
  readonly code: ZeusSkillServiceErrorCode;

  constructor(
    code:
      | 'ZEUS_CODEX_SKILL_INPUT_INVALID'
      | 'ZEUS_CODEX_SKILL_SOURCE_UNAVAILABLE'
      | 'ZEUS_CODEX_SKILL_UNSAFE_SOURCE'
      | 'ZEUS_CODEX_SKILL_ALREADY_EXISTS'
      | 'ZEUS_CODEX_SKILL_INVALID'
      | 'ZEUS_CODEX_SKILL_NOT_FOUND'
      | 'ZEUS_CODEX_SKILL_REMOVE_FORBIDDEN',
    message: string,
    readonly statusCode: 400 | 404 | 409 | 422 = 400,
  ) {
    super(message);
    this.code = code.replace('ZEUS_CODEX_', 'ZEUS_') as ZeusSkillServiceErrorCode;
  }
}

const CodexSkillServiceError = ZeusSkillServiceError;

export function createZeusSkillService(options: { skillsRoot: string; snapshotRoot?: string; manager: Pick<CodexAppServerManager, 'listSkills'>; ensureReady(): Promise<void>; now?: () => Date }): ZeusSkillService {
  const skillsRoot = requireAbsolutePath(options.skillsRoot, 'Zeus Skill Root');
  const skillProfileRoot = dirname(skillsRoot);
  const now = options.now ?? (() => new Date());
  /** 未完成的同类读取共享请求，超时返回本地目录后也不重复堆积订阅请求。 */
  const pendingProviderCatalogs = new Map<string, Promise<CodexSkillsListEntry[]>>();
  /** 目录发现只缓存 SKILL.md 解析结果；文件身份变化或强制刷新时立即失效。 */
  const installedSkillManifestCache = new Map<string, { signature: string; name: string; description: string }>();

  /** 将启动和目录读取一起限时；底层请求自行收尾，不让可选元数据阻塞主流程。 */
  async function readProviderCatalog(input: { cwd: string; forceReload?: boolean; startProvider?: boolean }): Promise<CodexSkillsListEntry[]> {
    /** 启动与强制刷新语义不同，不能用普通读取替代。 */
    const key = JSON.stringify([input.cwd, Boolean(input.forceReload), Boolean(input.startProvider)]);
    /** 仅复用执行中的请求，不缓存可能已失效的 Skill 路径。 */
    let pending = pendingProviderCatalogs.get(key);
    if (!pending) {
      pending = (async () => {
        if (input.startProvider) await options.ensureReady();
        return options.manager.listSkills({ cwds: [input.cwd], ...(input.forceReload ? { forceReload: true } : {}) });
      })().finally(() => pendingProviderCatalogs.delete(key));
      pendingProviderCatalogs.set(key, pending);
    }
    /** 每位调用者独立清理计时器，迟到的结果不修改已经返回的目录。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('订阅服务 Skill 目录读取超时，当前仅使用本地可用 Skill。')), providerCatalogWaitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function list(input: { cwd: string; forceReload?: boolean; startProvider?: boolean; includeProvider?: boolean }): Promise<ZeusSkillCatalog> {
    const cwd = await requireDirectory(input.cwd, 'Skill 工作目录');
    /** 普通目录由 Zeus 本地发现，订阅服务只补充原生元数据。 */
    const roots = new Map<string, CodexSkillScope>([
      [skillsRoot, 'user'],
      [join(skillsRoot, '.system'), 'system'],
      [join(homedir(), '.agents', 'skills'), 'user'],
    ]);
    for (let directory = cwd; ; directory = dirname(directory)) {
      roots.set(join(directory, '.agents', 'skills'), 'repo');
      roots.set(join(directory, '.codex', 'skills'), 'repo');
      if (directory === homedir() || dirname(directory) === directory || (await pathExists(join(directory, '.git')))) break;
    }
    /** 各来源独立报告损坏条目，不让一个 Skill 隐藏整个目录。 */
    const catalogs = await Promise.all([...roots].map(([root, scope]) => discoverZeusInstalledSkills(root, scope, installedSkillManifestCache, input.forceReload === true)));
    const installed = { skills: catalogs.flatMap((catalog) => catalog.skills), errors: catalogs.flatMap((catalog) => catalog.errors) };
    const providerSkills: CodexSkillMetadata[] = [];
    const providerErrors: Array<Record<string, unknown>> = [];
    if (input.includeProvider !== false) {
      try {
        const entries = await readProviderCatalog({ ...input, cwd });
        const entry = entries.find((candidate) => resolve(candidate.cwd) === cwd) ?? entries[0];
        if (entry) {
          providerSkills.push(...entry.skills);
          providerErrors.push(...entry.errors);
        }
      } catch (error) {
        providerErrors.push({ source: 'codex_app_server', message: boundedDiagnostic(error) });
      }
    }
    const byPath = new Map<string, CodexSkillMetadata>();
    for (const skill of installed.skills) byPath.set(resolve(skill.path), skill);
    // App Server 元数据补充 repo/system/admin scope；Provider 的 enabled 标志不能限制 Zeus 的显式 Skill 选择。
    for (const skill of providerSkills) byPath.set(resolve(skill.path), skill);
    const descriptors = await Promise.all([...byPath.values()].map((skill) => toDescriptor(skill, skillsRoot, cwd)));
    descriptors.sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope) || left.name.localeCompare(right.name));
    return { cwd, skills: descriptors, errors: [...installed.errors, ...providerErrors], refreshedAt: now().toISOString() };
  }

  async function install(input: { cwd: string; source: ZeusSkillInstallSource }): Promise<{ skill: ZeusSkillDescriptor; installedAt: string }> {
    const cwd = await requireDirectory(input.cwd, 'Skill 工作目录');
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = await mkdtemp(join(skillProfileRoot, '.skill-install-'));
    let installedDirectory: string | null = null;
    try {
      const sourceDirectory = await materializeSource(input.source, stagingRoot);
      const sourceInspection = await inspectSkillSource(sourceDirectory);
      const stagedSkill = join(stagingRoot, `ready-${randomUUID()}`);
      await cp(sourceDirectory, stagedSkill, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      // 本地来源可能在复制期间变化；只信任复制后的隔离快照，并再次检查符号链接、大小和元数据。
      const inspection = await inspectSkillSource(stagedSkill);
      if (inspection.name !== sourceInspection.name) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', 'Skill 在复制期间发生变化，请确认来源稳定后重试。', 422);
      const before = await list({ cwd, forceReload: true, startProvider: true });
      if (before.skills.some((skill) => skill.name === inspection.name)) {
        throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_ALREADY_EXISTS', `Skill “${inspection.name}” 已安装；Zeus 不会覆盖现有 Skill。`, 409);
      }
      const directoryName = skillDirectoryName(inspection.name);
      installedDirectory = join(skillsRoot, directoryName);
      if (await pathExists(installedDirectory)) {
        throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_ALREADY_EXISTS', `安装目录 ${directoryName} 已存在；Zeus 不会覆盖现有内容。`, 409);
      }
      await rename(stagedSkill, installedDirectory);

      const after = await list({ cwd, forceReload: true, startProvider: true });
      const installedRealpath = await realpath(installedDirectory);
      const skill = after.skills.find((candidate) => candidate.name === inspection.name && skillDirectory(candidate.path) === installedRealpath);
      if (!skill) {
        const detail = after.errors.map((error) => JSON.stringify(error)).join('；');
        await rm(installedDirectory, { recursive: true, force: true });
        installedDirectory = null;
        throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INVALID', detail ? `Zeus 未接受该 Skill：${detail}` : 'Zeus 未能发现安装后的 Skill，请检查 SKILL.md 元数据。', 422);
      }
      installedDirectory = null;
      return { skill, installedAt: now().toISOString() };
    } finally {
      if (installedDirectory) await rm(installedDirectory, { recursive: true, force: true }).catch(() => undefined);
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function remove(input: { cwd: string; skillId: string }): Promise<{ removed: true; skillId: string; name: string }> {
    const catalog = await list({ cwd: input.cwd, forceReload: true, startProvider: true });
    const skill = catalog.skills.find((candidate) => candidate.id === requireSkillId(input.skillId));
    if (!skill) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_NOT_FOUND', '没有找到要移除的 Skill。', 404);
    if (!skill.removable) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_REMOVE_FORBIDDEN', '只能移除通过 Zeus 用户 Skill 目录安装的 Skill。', 409);
    const directory = skillDirectory(skill.path);
    const root = await realpath(skillsRoot);
    if (dirname(directory) !== root || basename(directory) === '.system') {
      throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_REMOVE_FORBIDDEN', 'Skill 路径不属于可移除的用户 Skill 目录。', 409);
    }
    await rm(directory, { recursive: true, force: false });
    await list({ cwd: catalog.cwd, forceReload: true, startProvider: true });
    return { removed: true, skillId: skill.id, name: skill.name };
  }

  async function resolveSkill(input: { cwd: string; skillId: string }): Promise<{ id: string; name: string; description: string; path: string }> {
    const catalog = await list({ cwd: input.cwd, includeProvider: false });
    const skill = catalog.skills.find((candidate) => candidate.id === requireSkillId(input.skillId));
    if (!skill) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_NOT_FOUND', '所选 Skill 在当前项目中不可用，请重新选择。', 404);
    return { id: skill.id, name: skill.name, description: skill.description, path: skill.path };
  }

  /** 仅接受受管快照编号，禁止将请求参数作为任意文件路径读取。 */
  async function readFrozen(snapshotId: string): Promise<ZeusSkillCatalog> {
    if (typeof snapshotId !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshotId)) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INPUT_INVALID', '技能快照编号无效。');
    /** 历史展示只读取清单，不重建快照或启动服务。 */
    const root = options.snapshotRoot ?? join(dirname(skillProfileRoot), 'artifacts', 'skill-resources');
    try {
      return JSON.parse(await readFile(join(root, snapshotId, 'catalog.json'), 'utf8')) as ZeusSkillCatalog;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_NOT_FOUND', '技能快照已不存在。', 404);
      throw error;
    }
  }

  return { list, readFrozen, install, remove, resolve: resolveSkill };
}

async function materializeSource(source: ZeusSkillInstallSource, stagingRoot: string): Promise<string> {
  if (!source || typeof source !== 'object') throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INPUT_INVALID', '安装来源无效。');
  if (source.kind === 'local') {
    const rawPath = typeof source.path === 'string' ? source.path.trim() : '';
    const localPath = requireAbsolutePath(rawPath, '本地 Skill 路径');
    try {
      const sourceStat = await lstat(localPath);
      if (sourceStat.isSymbolicLink()) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', '本地 Skill 根目录不能是符号链接。', 422);
      if (sourceStat.isFile() && basename(localPath) === 'SKILL.md') return dirname(localPath);
      if (sourceStat.isDirectory()) return localPath;
      throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_SOURCE_UNAVAILABLE', '本地 Skill 路径必须是目录或 SKILL.md。', 404);
    } catch (error) {
      if (error instanceof CodexSkillServiceError) throw error;
      if (isNodeError(error, 'ENOENT')) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_SOURCE_UNAVAILABLE', '本地 Skill 路径不存在。', 404);
      throw error;
    }
  }
  if (source.kind !== 'git') throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INPUT_INVALID', '不支持的 Skill 安装来源。');
  const repositoryUrl = boundedText(source.repositoryUrl, 'Git 仓库地址', 2_000);
  const gitRef = optionalBoundedText(source.ref, 'Git ref', 255);
  const subdirectory = optionalRelativePath(source.subdirectory);
  const cloneRoot = join(stagingRoot, 'repository');
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--no-tags'];
  if (gitRef) args.push('--branch', gitRef);
  args.push('--', repositoryUrl, cloneRoot);
  try {
    await execFileAsync('git', args, {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=10' },
    });
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim().slice(0, 800) : '';
    throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_SOURCE_UNAVAILABLE', stderr ? `Git 仓库读取失败：${stderr}` : 'Git 仓库读取失败，请检查地址、ref 与访问权限。', 404);
  }
  await rm(join(cloneRoot, '.git'), { recursive: true, force: true });
  const sourceDirectory = subdirectory ? resolve(cloneRoot, subdirectory) : cloneRoot;
  if (!isInside(sourceDirectory, cloneRoot) && sourceDirectory !== cloneRoot) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INPUT_INVALID', 'Git 子目录不能离开仓库根目录。');
  return sourceDirectory;
}

async function inspectSkillSource(sourceDirectory: string): Promise<{ name: string; description: string }> {
  const sourceStat = await lstat(sourceDirectory).catch(() => null);
  if (sourceStat?.isSymbolicLink()) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', 'Skill 来源目录不能是符号链接。', 422);
  if (!sourceStat?.isDirectory()) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_SOURCE_UNAVAILABLE', 'Skill 来源目录不存在或不是目录。', 404);
  const root = await requireDirectory(sourceDirectory, 'Skill 来源目录');
  let nodeCount = 0;
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const entryStat = await lstat(path);
      nodeCount += 1;
      if (nodeCount > maximumSkillNodes) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', `Skill 文件数量不能超过 ${maximumSkillNodes}。`, 422);
      if (entryStat.isSymbolicLink()) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', `Skill 不能包含符号链接：${relative(root, path)}`, 422);
      if (entryStat.isDirectory()) await visit(path);
      else if (entryStat.isFile()) totalBytes += entryStat.size;
      else throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', `Skill 包含不支持的文件类型：${relative(root, path)}`, 422);
      if (totalBytes > maximumSkillBytes) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', 'Skill 总大小不能超过 50 MB。', 422);
    }
  };
  await visit(root);
  let skillMarkdown: string;
  try {
    const skillFile = join(root, 'SKILL.md');
    const skillStat = await stat(skillFile);
    if (!skillStat.isFile()) throw new Error('not a file');
    skillMarkdown = await readFile(skillFile, 'utf8');
  } catch {
    throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INVALID', 'Skill 根目录必须包含 SKILL.md。', 422);
  }
  const name = skillFrontmatterScalar(skillMarkdown, 'name');
  const description = skillFrontmatterScalar(skillMarkdown, 'description');
  return validateSkillManifest(name, description);
}

/** 运行时只校验并读取入口文件；完整资源树检查保留在安装边界。 */
async function inspectInstalledSkillManifest(directory: string, cache: Map<string, { signature: string; name: string; description: string }>, forceReload: boolean): Promise<{ name: string; description: string }> {
  /** 目录本身必须是普通目录，不能借符号链接改变资源边界。 */
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', 'Skill 目录不能是符号链接且必须是目录。', 422);
  /** 运行时发现只读取固定入口文件。 */
  const skillFile = join(directory, 'SKILL.md');
  /** 文件身份用于缓存失效，也阻止入口符号链接。 */
  const skillStat = await lstat(skillFile);
  if (skillStat.isSymbolicLink() || !skillStat.isFile()) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INVALID', 'Skill 根目录必须包含普通文件 SKILL.md。', 422);
  if (skillStat.size > maximumSkillManifestBytes) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INVALID', 'SKILL.md 不能超过 1 MiB。', 422);
  /** 目录与入口文件身份共同覆盖创建、替换、编辑和删除后重建。 */
  const signature = [directoryStat.dev, directoryStat.ino, directoryStat.mtimeMs, skillStat.dev, skillStat.ino, skillStat.size, skillStat.mtimeMs, skillStat.ctimeMs].join(':');
  /** 强制刷新跳过缓存，其余调用只在签名不变时复用解析结果。 */
  const cached = forceReload ? undefined : cache.get(directory);
  if (cached?.signature === signature) {
    cache.delete(directory);
    cache.set(directory, cached);
    return { name: cached.name, description: cached.description };
  }
  /** 单次读取同时解析名称和说明，避免同一入口重复 I/O。 */
  const skillMarkdown = await readFile(skillFile, 'utf8');
  /** 运行时与安装阶段共用同一元数据约束。 */
  const inspection = validateSkillManifest(skillFrontmatterScalar(skillMarkdown, 'name'), skillFrontmatterScalar(skillMarkdown, 'description'));
  cache.set(directory, { signature, ...inspection });
  while (cache.size > maximumSkillManifestCacheEntries) cache.delete(cache.keys().next().value!);
  return inspection;
}

/** 统一校验安装和运行时发现所读取的 Skill 入口元数据。 */
function validateSkillManifest(name: string | null | undefined, description: string | null | undefined): { name: string; description: string } {
  if (!name || !description) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INVALID', 'SKILL.md frontmatter 必须包含非空 name 和 description。', 422);
  if ([...name].length > 100 || /[\r\n\0]/u.test(name)) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INVALID', 'Skill name 不能超过 100 个字符或包含换行。', 422);
  return { name, description };
}

/** 使用入口元数据缓存发现指定作用域，不在消息派发时递归扫描资源树。 */
async function discoverZeusInstalledSkills(
  skillsRoot: string,
  scope: CodexSkillScope,
  cache: Map<string, { signature: string; name: string; description: string }>,
  forceReload: boolean,
): Promise<{ skills: CodexSkillMetadata[]; errors: Array<Record<string, unknown>> }> {
  const skills: CodexSkillMetadata[] = [];
  const errors: Array<Record<string, unknown>> = [];
  /** 当前目录项集合用于清理已删除 Skill 的旧缓存。 */
  const visibleDirectories = new Set<string>();
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { skills, errors };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.system') continue;
    const directory = join(skillsRoot, entry.name);
    visibleDirectories.add(directory);
    try {
      const inspection = await inspectInstalledSkillManifest(directory, cache, forceReload);
      skills.push({
        name: inspection.name,
        description: inspection.description,
        path: join(directory, 'SKILL.md'),
        scope,
        enabled: true,
      });
    } catch (error) {
      errors.push({ source: 'zeus', path: directory, message: boundedDiagnostic(error) });
    }
  }
  /** 删除当前根目录已经移除的入口，其他项目的缓存不受影响。 */
  for (const directory of cache.keys()) if (dirname(directory) === resolve(skillsRoot) && !visibleDirectories.has(directory)) cache.delete(directory);
  return { skills, errors };
}

async function toDescriptor(skill: CodexSkillMetadata, skillsRoot: string, cwd: string): Promise<ZeusSkillDescriptor> {
  const canonicalPath = await realpath(skill.path).catch(() => resolve(skill.path));
  const root = await realpath(skillsRoot).catch(() => resolve(skillsRoot));
  const directory = skillDirectory(canonicalPath);
  const removable = dirname(directory) === root && basename(directory) !== '.system';
  return {
    id: skillId(skill, canonicalPath, cwd),
    name: skill.name,
    description: skill.description,
    ...(skill.shortDescription ? { shortDescription: skill.shortDescription } : {}),
    invocation: `$${skill.name}`,
    path: canonicalPath,
    scope: skill.scope,
    removable,
    ...(skill.interface ? { interface: skill.interface } : {}),
    ...(skill.dependencies ? { dependencies: skill.dependencies } : {}),
  };
}

function skillDirectory(path: string): string {
  return basename(path).toLowerCase() === 'skill.md' ? dirname(path) : path;
}

function skillDirectoryName(name: string): string {
  const normalized = name.normalize('NFKC').trim();
  const safe = normalized
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 72);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 10);
  return safe && safe !== '.' && safe !== '..' ? `${safe}-${hash}` : `skill-${hash}`;
}

function skillId(skill: Pick<CodexSkillMetadata, 'name' | 'scope'>, path: string, cwd: string): string {
  const repoRelativePath = skill.scope === 'repo' && (path === cwd || isInside(path, cwd)) ? relative(cwd, path) : null;
  return createHash('sha256')
    .update(`${skill.scope}\0${skill.name}\0${repoRelativePath ?? path}`)
    .digest('hex')
    .slice(0, 32);
}

function requireSkillId(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/u.test(value)) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INPUT_INVALID', 'Skill ID 无效。');
  return value;
}

function requireAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INPUT_INVALID', `${label}必须是绝对路径。`);
  return resolve(value.trim());
}

async function requireDirectory(value: string, label: string): Promise<string> {
  const path = requireAbsolutePath(value, label);
  try {
    const pathStat = await stat(path);
    if (!pathStat.isDirectory()) throw new Error('not directory');
    return await realpath(path);
  } catch {
    throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_SOURCE_UNAVAILABLE', `${label}不存在或不是目录。`, 404);
  }
}

function boundedText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumLength || /[\r\n\0]/u.test(value)) {
    throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INPUT_INVALID', `${label}无效。`);
  }
  return value.trim();
}

function optionalBoundedText(value: unknown, label: string, maximumLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedText(value, label, maximumLength);
}

function optionalRelativePath(value: unknown): string | undefined {
  const path = optionalBoundedText(value, 'Git 子目录', 1_000);
  if (!path) return undefined;
  if (isAbsolute(path) || path.split(/[\\/]+/u).some((segment) => segment === '..')) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INPUT_INVALID', 'Git 子目录必须是仓库内的相对路径。');
  return path;
}

function isInside(path: string, root: string): boolean {
  const value = relative(root, path);
  return Boolean(value) && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function scopeRank(scope: CodexSkillScope): number {
  return scope === 'user' ? 0 : scope === 'repo' ? 1 : scope === 'system' ? 2 : 3;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedDiagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]+/gu, ' ').slice(0, 800);
}
