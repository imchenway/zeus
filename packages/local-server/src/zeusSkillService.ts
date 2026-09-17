import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import type { CodexAppServerManager, CodexSkillMetadata, CodexSkillScope, CodexSkillsListEntry } from '@zeus/ai-runtime';

const execFileAsync = promisify(execFile);
const maximumSkillNodes = 5_000;
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

  /** 同一提交复用已冻结的目录，新提交重新读取本地来源，不移动用户文件。 */
  async function freeze(input: { cwd: string; identity: string }): Promise<ZeusSkillCatalog> {
    const root = options.snapshotRoot ?? join(dirname(skillProfileRoot), 'artifacts', 'skill-resources');
    const target = join(root, createHash('sha256').update(input.identity).digest('hex'));
    const manifest = join(target, 'catalog.json');
    try {
      return JSON.parse(await readFile(manifest, 'utf8')) as ZeusSkillCatalog;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    const catalog = await list({ cwd: input.cwd });
    await mkdir(root, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(root, '.prepare-'));
    try {
      const skills: ZeusSkillDescriptor[] = [];
      for (const skill of catalog.skills) {
        const name = createHash('sha256').update(skill.id).digest('hex').slice(0, 24);
        const destination = join(staging, name);
        await inspectSkillSource(dirname(skill.path));
        await cp(dirname(skill.path), destination, { recursive: true, dereference: false, errorOnExist: true });
        const metadata = await inspectSkillSource(destination);
        skills.push({ ...skill, ...metadata, path: join(target, name, 'SKILL.md'), removable: false });
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
    const root = options.snapshotRoot ?? join(dirname(skillProfileRoot), 'artifacts', 'skill-resources');
    try {
      return JSON.parse(await readFile(join(root, snapshotId, 'catalog.json'), 'utf8')) as ZeusSkillCatalog;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw new CodexSkillServiceError('ZEUS_CODEX_SKILL_NOT_FOUND', '技能快照已不存在。', 404);
      throw error;
    }
  }

  return { list, freeze, readFrozen, install, remove, resolve: resolveSkill };
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
  const name = frontmatterScalar(skillMarkdown, 'name');
  const description = frontmatterScalar(skillMarkdown, 'description');
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

function frontmatterScalar(markdown: string, key: string): string | null {
  const normalized = markdown.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return null;
  const lines = normalized.slice(4, end).split('\n');
  const keyPattern = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'u');
  const lineIndex = lines.findIndex((line) => keyPattern.test(line));
  if (lineIndex < 0) return null;
  const raw = keyPattern.exec(lines[lineIndex]!)?.[1]?.trim() ?? '';
  if (/^[>|][+-]?(?:\s+#.*)?$/u.test(raw)) {
    const blockLines: string[] = [];
    for (let index = lineIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.trim() && !/^\s/u.test(line)) break;
      blockLines.push(line);
    }
    const nonEmptyIndents = blockLines.filter((line) => line.trim()).map((line) => /^\s*/u.exec(line)?.[0].length ?? 0);
    if (nonEmptyIndents.length === 0) return null;
    const indentation = Math.min(...nonEmptyIndents);
    const values = blockLines.map((line) => line.slice(Math.min(indentation, line.length)).trimEnd());
    const value = raw.startsWith('>') ? values.join(' ').replace(/\s+/gu, ' ').trim() : values.join('\n').trim();
    return value || null;
  }
  if (!raw) return null;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed.trim() : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'").trim();
  return raw.replace(/\s+#.*$/u, '').trim();
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
