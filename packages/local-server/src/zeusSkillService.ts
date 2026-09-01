import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { CodexAppServerManager, CodexSkillMetadata, CodexSkillScope } from '@zeus/ai-runtime';

const execFileAsync = promisify(execFile);
const maximumSkillNodes = 5_000;
const maximumSkillBytes = 50 * 1024 * 1024;

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

export function createZeusSkillService(options: { skillsRoot: string; manager: Pick<CodexAppServerManager, 'listSkills'>; ensureReady(): Promise<void>; now?: () => Date }): ZeusSkillService {
  const skillsRoot = requireAbsolutePath(options.skillsRoot, 'Zeus Skill Root');
  const skillProfileRoot = dirname(skillsRoot);
  const now = options.now ?? (() => new Date());

  async function list(input: { cwd: string; forceReload?: boolean; startProvider?: boolean }): Promise<ZeusSkillCatalog> {
    const cwd = await requireDirectory(input.cwd, 'Skill 工作目录');
    const installed = await discoverZeusInstalledSkills(skillsRoot);
    let providerSkills: CodexSkillMetadata[] = [];
    let providerErrors: Array<Record<string, unknown>> = [];
    try {
      if (input.startProvider) await options.ensureReady();
      const entries = await options.manager.listSkills({ cwds: [cwd], ...(input.forceReload ? { forceReload: true } : {}) });
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

  return { list, install, remove, resolve: resolveSkill };
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

async function discoverZeusInstalledSkills(skillsRoot: string): Promise<{ skills: CodexSkillMetadata[]; errors: Array<Record<string, unknown>> }> {
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
        scope: 'user',
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
