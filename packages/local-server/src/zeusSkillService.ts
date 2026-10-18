import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  list(input: { cwd: string; forceReload?: boolean }): Promise<ZeusSkillCatalog>;
  /** 普通 Skill 每轮复制到受管产物目录，元数据和参考文件一起冻结。 */
  freeze(input: { cwd: string; identity: string }): Promise<ZeusSkillCatalog>;
  /** 只读已冻结的技能清单，供历史过程显示当时的名称。 */
  readFrozen(snapshotId: string): Promise<ZeusSkillCatalog>;
  /** 将历史整目录副本改为内容对象硬链接，释放重复文件块。 */
  compact(): Promise<{ snapshotCount: number; linkedFileCount: number; errorCount: number }>;
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
  /** Skill 快照根目录继续保留旧路径契约。 */
  const snapshotRoot = requireAbsolutePath(options.snapshotRoot ?? join(dirname(skillProfileRoot), 'artifacts', 'skill-resources'), 'Skill 快照根目录');
  /** 内容对象按目录摘要保存，所有提交快照只保留只读硬链接视图。 */
  const skillObjectRoot = join(snapshotRoot, 'objects');
  const now = options.now ?? (() => new Date());
  /** 未完成的同类读取共享请求，超时返回本地目录后也不重复堆积订阅请求。 */
  const pendingProviderCatalogs = new Map<string, Promise<CodexSkillsListEntry[]>>();

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
    /** 每位调用者独立清理计时器，迟到的结果不修改已经返回或冻结的目录。 */
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

  async function list(input: { cwd: string; forceReload?: boolean; startProvider?: boolean }): Promise<ZeusSkillCatalog> {
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
    const catalogs = await Promise.all([...roots].map(([root, scope]) => discoverZeusInstalledSkills(root, scope)));
    const installed = { skills: catalogs.flatMap((catalog) => catalog.skills), errors: catalogs.flatMap((catalog) => catalog.errors) };
    let providerSkills: CodexSkillMetadata[] = [];
    let providerErrors: Array<Record<string, unknown>> = [];
    try {
      const entries = await readProviderCatalog({ ...input, cwd });
      const entry = entries.find((candidate) => resolve(candidate.cwd) === cwd) ?? entries[0];
      if (entry) {
        providerSkills = entry.skills;
        providerErrors = entry.errors;
      }
    } catch (error) {
      providerErrors.push({ source: 'codex_app_server', message: boundedDiagnostic(error) });
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
    const catalog = await list({ cwd: input.cwd });
    const skill = catalog.skills.find((candidate) => candidate.id === requireSkillId(input.skillId));
    if (!skill) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_NOT_FOUND', '所选 Skill 在当前项目中不可用，请重新选择。', 404);
    return { id: skill.id, name: skill.name, description: skill.description, path: skill.path };
  }

  /** 同一提交复用已冻结的目录，新提交按内容对象创建兼容旧路径的只读视图。 */
  async function freeze(input: { cwd: string; identity: string }): Promise<ZeusSkillCatalog> {
    const target = join(snapshotRoot, createHash('sha256').update(input.identity).digest('hex'));
    const manifest = join(target, 'catalog.json');
    try {
      return JSON.parse(await readFile(manifest, 'utf8')) as ZeusSkillCatalog;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    const catalog = await list({ cwd: input.cwd });
    await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(snapshotRoot, '.prepare-'));
    try {
      const skills: ZeusSkillDescriptor[] = [];
      for (const skill of catalog.skills) {
        const name = createHash('sha256').update(skill.id).digest('hex').slice(0, 24);
        const destination = join(staging, name);
        const object = await publishSkillObject(dirname(skill.path), skillObjectRoot);
        await materializeSkillHardLinkView(object.path, destination);
        skills.push({ ...skill, ...object.metadata, path: join(target, name, 'SKILL.md'), removable: false, contentHash: object.hash });
      }
      const frozen = { ...catalog, skills };
      await writeFile(join(staging, 'catalog.json'), JSON.stringify(frozen), { mode: 0o600 });
      try {
        await rename(staging, target);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error;
      }
      return JSON.parse(await readFile(manifest, 'utf8')) as ZeusSkillCatalog;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** 仅接受受管快照编号，禁止将请求参数作为任意文件路径读取。 */
  async function readFrozen(snapshotId: string): Promise<ZeusSkillCatalog> {
    if (typeof snapshotId !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshotId)) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INPUT_INVALID', '技能快照编号无效。');
    /** 历史展示只读取清单，不重建快照或启动服务。 */
    try {
      return JSON.parse(await readFile(join(snapshotRoot, snapshotId, 'catalog.json'), 'utf8')) as ZeusSkillCatalog;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_NOT_FOUND', '技能快照已不存在。', 404);
      throw error;
    }
  }

  /** 逐个迁移旧快照；单个失败不阻断其他快照，也不删除仍可读取的旧文件。 */
  async function compact(): Promise<{ snapshotCount: number; linkedFileCount: number; errorCount: number }> {
    await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    const entries = await readdir(snapshotRoot, { withFileTypes: true });
    let snapshotCount = 0;
    let linkedFileCount = 0;
    let errorCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
      const target = join(snapshotRoot, entry.name);
      try {
        const manifest = join(target, 'catalog.json');
        const catalog = JSON.parse(await readFile(manifest, 'utf8')) as ZeusSkillCatalog;
        /** 已写入完整内容摘要的快照由上次原子清单写入证明迁移完成，无需重复扫描文件。 */
        const alreadyCompacted =
          catalog.skills.every((skill) => typeof skill.contentHash === 'string' && /^[a-f0-9]{64}$/u.test(skill.contentHash)) &&
          (await Promise.all(catalog.skills.map((skill) => pathExists(join(skillObjectRoot, skill.contentHash!))))).every(Boolean);
        if (alreadyCompacted) {
          snapshotCount += 1;
          continue;
        }
        const skills: ZeusSkillDescriptor[] = [];
        for (const skill of catalog.skills) {
          const directory = dirname(resolve(skill.path));
          const relativeDirectory = relative(target, directory);
          if (basename(skill.path).toLowerCase() !== 'skill.md' || relativeDirectory.split(sep).length !== 1 || !/^[a-f0-9]{24}$/u.test(relativeDirectory)) {
            throw new Error(`冻结 Skill 路径不属于快照：${skill.path}`);
          }
          await removeSkillHardLinkTemps(directory);
          const object = await publishSkillObject(directory, skillObjectRoot);
          linkedFileCount += await replaceSkillFilesWithHardLinks(object.path, directory);
          skills.push({ ...skill, ...object.metadata, contentHash: object.hash });
        }
        const temporaryManifest = join(target, `.catalog-${randomUUID()}.json`);
        await writeFile(temporaryManifest, JSON.stringify({ ...catalog, skills }), { mode: 0o600 });
        await rename(temporaryManifest, manifest);
        snapshotCount += 1;
      } catch (error) {
        errorCount += 1;
        console.error(`Skill 快照 ${entry.name} 内容去重失败：${boundedDiagnostic(error)}`);
      }
    }
    return { snapshotCount, linkedFileCount, errorCount };
  }

  return { list, freeze, readFrozen, compact, install, remove, resolve: resolveSkill };
}

/** 对目录结构、相对路径、可执行位和文件内容生成稳定摘要。 */
async function hashSkillDirectory(root: string): Promise<string> {
  const hash = createHash('sha256');
  /** 按名称排序，消除文件系统枚举顺序差异。 */
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      const entryStat = await lstat(path);
      if (entryStat.isSymbolicLink()) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', `Skill 不能包含符号链接：${relativePath}`, 422);
      if (entryStat.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await visit(path);
        continue;
      }
      if (!entryStat.isFile()) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', `Skill 包含不支持的文件类型：${relativePath}`, 422);
      hash.update(`F\0${relativePath}\0${entryStat.mode & 0o111}\0${entryStat.size}\0`);
      hash.update(await readFile(path));
      hash.update('\0');
    }
  };
  await visit(root);
  return hash.digest('hex');
}

/** 将对象文件设为只读并保留可执行位，防止一个快照修改所有硬链接视图。 */
async function sealSkillDirectory(root: string): Promise<void> {
  /** 先处理子节点，最后收紧父目录写权限。 */
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        const entryStat = await stat(path);
        await chmod(path, 0o444 | (entryStat.mode & 0o111));
      }
    }
    await chmod(directory, 0o555);
  };
  await visit(root);
}

/** 发布不可变内容对象；并发发布相同摘要时复用先完成的对象。 */
async function publishSkillObject(sourceDirectory: string, objectRoot: string): Promise<{ hash: string; path: string; metadata: { name: string; description: string } }> {
  const metadata = await inspectSkillSource(sourceDirectory);
  const hash = await hashSkillDirectory(sourceDirectory);
  const target = join(objectRoot, hash);
  await mkdir(objectRoot, { recursive: true, mode: 0o700 });
  if (await pathExists(target)) {
    const targetStatus = await lstat(target);
    if (!targetStatus.isDirectory() || targetStatus.isSymbolicLink()) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', 'Skill 内容对象不是受管目录。', 422);
    const [targetHash, targetMetadata] = await Promise.all([hashSkillDirectory(target), inspectSkillSource(target)]);
    if (targetHash !== hash) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', 'Skill 内容对象摘要与目录身份不匹配。', 422);
    return { hash, path: target, metadata: targetMetadata };
  }
  const staging = await mkdtemp(join(objectRoot, '.prepare-'));
  const candidate = join(staging, 'content');
  try {
    await cp(sourceDirectory, candidate, { recursive: true, dereference: false, errorOnExist: true });
    const copiedMetadata = await inspectSkillSource(candidate);
    const copiedHash = await hashSkillDirectory(candidate);
    if (copiedHash !== hash || copiedMetadata.name !== metadata.name || copiedMetadata.description !== metadata.description) {
      throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', 'Skill 在冻结期间发生变化，请确认来源稳定后重试。', 422);
    }
    await sealSkillDirectory(candidate);
    try {
      await rename(candidate, target);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error;
    }
    const [publishedHash, publishedMetadata] = await Promise.all([hashSkillDirectory(target), inspectSkillSource(target)]);
    if (publishedHash !== hash) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_UNSAFE_SOURCE', 'Skill 内容对象发布后摘要不一致。', 422);
    return { hash, path: target, metadata: publishedMetadata };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** 递归创建内容对象的只读硬链接视图，保留历史快照路径契约。 */
async function materializeSkillHardLinkView(objectDirectory: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(objectDirectory, { withFileTypes: true })) {
    const sourcePath = join(objectDirectory, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) await materializeSkillHardLinkView(sourcePath, destinationPath);
    else await link(sourcePath, destinationPath);
  }
  await chmod(destination, 0o555);
}

/** 清除上次进程异常退出后遗留的内部硬链接临时项。 */
async function removeSkillHardLinkTemps(root: string): Promise<void> {
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name.startsWith('.zeus-skill-link-')) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) await removeSkillHardLinkTemps(path);
  }
}

/** 用同内容对象的硬链接原子替换旧快照文件，并返回实际替换数量。 */
async function replaceSkillFilesWithHardLinks(objectDirectory: string, snapshotDirectory: string): Promise<number> {
  await chmod(snapshotDirectory, 0o755);
  let linkedFileCount = 0;
  for (const entry of await readdir(objectDirectory, { withFileTypes: true })) {
    const objectPath = join(objectDirectory, entry.name);
    const snapshotPath = join(snapshotDirectory, entry.name);
    if (entry.isDirectory()) {
      linkedFileCount += await replaceSkillFilesWithHardLinks(objectPath, snapshotPath);
      continue;
    }
    const [objectStat, snapshotStat] = await Promise.all([stat(objectPath), stat(snapshotPath)]);
    if (objectStat.dev === snapshotStat.dev && objectStat.ino === snapshotStat.ino) continue;
    const temporaryPath = join(snapshotDirectory, `.zeus-skill-link-${randomUUID()}`);
    try {
      await link(objectPath, temporaryPath);
      await rename(temporaryPath, snapshotPath);
      linkedFileCount += 1;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
  await chmod(snapshotDirectory, 0o555);
  return linkedFileCount;
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
  if (!name || !description) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INVALID', 'SKILL.md frontmatter 必须包含非空 name 和 description。', 422);
  if ([...name].length > 100 || /[\r\n\0]/u.test(name)) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_INVALID', 'Skill name 不能超过 100 个字符或包含换行。', 422);
  return { name, description };
}

/** 复用同一元数据解析与来源检查，发现指定作用域下的本地 Skill。 */
async function discoverZeusInstalledSkills(skillsRoot: string, scope: CodexSkillScope = 'user'): Promise<{ skills: CodexSkillMetadata[]; errors: Array<Record<string, unknown>> }> {
  const skills: CodexSkillMetadata[] = [];
  const errors: Array<Record<string, unknown>> = [];
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
    try {
      const inspection = await inspectSkillSource(directory);
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
