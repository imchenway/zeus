import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { access, lstat, mkdir, open, opendir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  CreateProjectSourceEntryInput,
  MoveProjectSourceEntryInput,
  ProjectSourceDirectorySnapshot,
  ProjectSourceDocument,
  ProjectSourceEntry,
  ProjectSourceEvent,
  ProjectSourceRevision,
  ProjectSourceSearchResult,
  SaveProjectSourceFileInput,
} from '@zeus/shared';

const maximumEditableBytes = 2 * 1024 * 1024;
const maximumSearchResults = 200;
const maximumSearchVisits = 50_000;
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

export interface ProjectSourceWorkspaceServices {
  loadProjectRoot(projectId: string): Promise<string>;
  trashItem(path: string): Promise<void>;
}

export class ProjectSourceWorkspaceService {
  readonly #services: ProjectSourceWorkspaceServices;

  constructor(services: ProjectSourceWorkspaceServices) {
    this.#services = services;
  }

  async listDirectory(projectId: string, relativePath = ''): Promise<ProjectSourceDirectorySnapshot> {
    const root = await this.#projectRoot(projectId);
    const directory = await resolveExistingPath(root, relativePath, 'directory');
    const names = await opendir(directory.absolutePath);
    const entries: ProjectSourceEntry[] = [];
    for await (const item of names) {
      if (item.name === '.git') continue;
      const entryRelativePath = joinRelative(directory.relativePath, item.name);
      entries.push(await describeEntry(root, entryRelativePath));
    }
    entries.sort(compareEntries);
    return { relativePath: directory.relativePath, entries };
  }

  async search(projectId: string, query: string): Promise<ProjectSourceSearchResult> {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return { entries: [], truncated: false };
    const root = await this.#projectRoot(projectId);
    const entries: ProjectSourceEntry[] = [];
    const directories = [''];
    let visited = 0;
    let resultLimitReached = false;
    while (directories.length > 0 && entries.length < maximumSearchResults && visited < maximumSearchVisits) {
      const directoryRelativePath = directories.shift()!;
      const directory = await resolveExistingPath(root, directoryRelativePath, 'directory');
      const handle = await opendir(directory.absolutePath);
      for await (const item of handle) {
        if (item.name === '.git') continue;
        visited += 1;
        const entryRelativePath = joinRelative(directory.relativePath, item.name);
        const entry = await describeEntry(root, entryRelativePath);
        if (item.name.toLocaleLowerCase().includes(normalizedQuery)) entries.push(entry);
        if (item.isDirectory()) directories.push(entryRelativePath);
        if (entries.length >= maximumSearchResults) {
          resultLimitReached = true;
          break;
        }
        if (visited >= maximumSearchVisits) break;
      }
    }
    entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return { entries, truncated: resultLimitReached || directories.length > 0 || visited >= maximumSearchVisits };
  }

  async readFile(projectId: string, relativePath: string): Promise<ProjectSourceDocument> {
    const root = await this.#projectRoot(projectId);
    const target = await resolveExistingPath(root, relativePath);
    const targetLstat = await lstat(target.absolutePath);
    const targetStat = await stat(target.absolutePath);
    const isSymlink = targetLstat.isSymbolicLink();
    const basicRevision = revisionFromStat(targetStat.size, targetStat.mtimeMs);
    if (!targetStat.isFile()) return readOnlyDocument(target.relativePath, basicRevision, 'not_regular_file');
    if (targetStat.size > maximumEditableBytes) return readOnlyDocument(target.relativePath, await revisionFromFile(target.absolutePath, targetStat.size, targetStat.mtimeMs), 'too_large');
    const bytes = await readFile(target.absolutePath);
    const revision = revisionFromBytes(bytes, targetStat.mtimeMs);
    if (bytes.includes(0)) return readOnlyDocument(target.relativePath, revision, 'binary');
    const hasBom = bytes.subarray(0, utf8Bom.length).equals(utf8Bom);
    const contentBytes = hasBom ? bytes.subarray(utf8Bom.length) : bytes;
    let rawContent: string;
    try {
      rawContent = new TextDecoder('utf-8', { fatal: true }).decode(contentBytes);
    } catch {
      return readOnlyDocument(target.relativePath, revision, 'invalid_encoding');
    }
    const eol = detectEol(rawContent);
    return {
      relativePath: target.relativePath,
      name: basename(target.relativePath),
      language: sourceLanguageForPath(target.relativePath),
      content: rawContent.replace(/\r\n?|\n/gu, '\n'),
      encoding: 'utf-8',
      eol,
      hasBom,
      editable: !isSymlink,
      ...(isSymlink ? { readOnlyReason: 'symlink' as const } : {}),
      revision,
    };
  }

  async saveFile(input: SaveProjectSourceFileInput): Promise<ProjectSourceDocument> {
    const root = await this.#projectRoot(input.projectId);
    const target = await resolveExistingPath(root, input.relativePath, 'file');
    const targetLstat = await lstat(target.absolutePath);
    if (targetLstat.isSymbolicLink()) throw workspaceError('ZEUS_PROJECT_SOURCE_SYMLINK_READ_ONLY', '符号链接文件只能查看，不能在 Zeus 中保存。');
    const currentBytes = await readFile(target.absolutePath);
    const currentStat = await stat(target.absolutePath);
    const currentRevision = revisionFromBytes(currentBytes, currentStat.mtimeMs);
    if (currentRevision.sha256 !== input.expectedRevision.sha256 || currentRevision.byteLength !== input.expectedRevision.byteLength) {
      throw workspaceError('ZEUS_PROJECT_SOURCE_CONFLICT', '文件已被外部修改，请重新加载或另存为。');
    }
    const eol = input.eol === 'crlf' ? '\r\n' : input.eol === 'cr' ? '\r' : '\n';
    const normalized = input.content.replace(/\r\n?|\n/gu, '\n').replaceAll('\n', eol);
    const body = Buffer.from(normalized, 'utf8');
    const bytes = input.hasBom ? Buffer.concat([utf8Bom, body]) : body;
    if (bytes.byteLength > maximumEditableBytes) throw workspaceError('ZEUS_PROJECT_SOURCE_TOO_LARGE', '保存后的文件超过 2 MiB 编辑上限。');
    const temporaryPath = join(dirname(target.absolutePath), `.${basename(target.absolutePath)}.${randomUUID()}.zeus-tmp`);
    const temporary = await open(temporaryPath, 'wx', targetLstat.mode);
    try {
      await temporary.writeFile(bytes);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await rename(temporaryPath, target.absolutePath);
      const parentDirectory = await open(dirname(target.absolutePath), 'r');
      try {
        await parentDirectory.sync();
      } finally {
        await parentDirectory.close();
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return this.readFile(input.projectId, target.relativePath);
  }

  async createEntry(input: CreateProjectSourceEntryInput): Promise<ProjectSourceEntry> {
    validateEntryName(input.name);
    const root = await this.#projectRoot(input.projectId);
    const parent = await resolveExistingPath(root, input.parentRelativePath, 'directory');
    const relativePath = joinRelative(parent.relativePath, input.name);
    assertSafeRelativePath(relativePath, false);
    const absolutePath = resolveLexicalPath(root, relativePath);
    await assertMissing(absolutePath);
    if (input.kind === 'directory') await mkdir(absolutePath, { mode: 0o755 });
    else {
      const handle = await open(absolutePath, 'wx', 0o644);
      await handle.close();
    }
    return describeEntry(root, relativePath);
  }

  async moveEntry(input: MoveProjectSourceEntryInput): Promise<ProjectSourceEntry> {
    validateEntryName(input.targetName);
    const root = await this.#projectRoot(input.projectId);
    assertSafeRelativePath(normalizeRelativePath(input.relativePath), false);
    const source = await resolveExistingEntryPath(root, input.relativePath);
    const targetParent = await resolveExistingPath(root, input.targetParentRelativePath, 'directory');
    const targetRelativePath = joinRelative(targetParent.relativePath, input.targetName);
    assertSafeRelativePath(targetRelativePath, false);
    if (source.relativePath === targetRelativePath) return describeEntry(root, source.relativePath);
    if ((await lstat(source.absolutePath)).isDirectory() && isPathWithin(targetRelativePath, source.relativePath)) {
      throw workspaceError('ZEUS_PROJECT_SOURCE_MOVE_DESCENDANT', '目录不能移动到自身内部。');
    }
    const targetAbsolutePath = resolveLexicalPath(root, targetRelativePath);
    await assertMissing(targetAbsolutePath);
    await rename(source.absolutePath, targetAbsolutePath);
    return describeEntry(root, targetRelativePath);
  }

  async trashEntry(projectId: string, relativePath: string): Promise<{ trashed: true; relativePath: string }> {
    const root = await this.#projectRoot(projectId);
    assertSafeRelativePath(normalizeRelativePath(relativePath), false);
    const target = await resolveExistingEntryPath(root, relativePath);
    await this.#services.trashItem(target.absolutePath);
    return { trashed: true, relativePath: target.relativePath };
  }

  async revealPath(projectId: string, relativePath: string): Promise<string> {
    const root = await this.#projectRoot(projectId);
    return (await resolveExistingEntryPath(root, relativePath)).absolutePath;
  }

  async watch(projectId: string, listener: (event: ProjectSourceEvent) => void): Promise<FSWatcher> {
    const root = await this.#projectRoot(projectId);
    return watch(root, { recursive: true }, (eventType, fileName) => {
      if (!fileName) return;
      const relativePath = fileName.split(sep).join('/');
      try {
        assertSafeRelativePath(relativePath, false);
      } catch {
        return;
      }
      listener({
        projectId,
        relativePath,
        parentRelativePath: dirname(relativePath) === '.' ? '' : dirname(relativePath).split(sep).join('/'),
        kind: eventType === 'change' ? 'changed' : 'unknown',
      });
    });
  }

  async #projectRoot(projectId: string): Promise<string> {
    if (!projectId.trim() || projectId.includes('\0')) throw workspaceError('ZEUS_PROJECT_SOURCE_PROJECT_REQUIRED', '项目标识无效。');
    const root = await realpath(await this.#services.loadProjectRoot(projectId));
    if (!(await stat(root)).isDirectory()) throw workspaceError('ZEUS_PROJECT_SOURCE_ROOT_INVALID', '项目目录不可用。');
    return root;
  }
}

async function resolveExistingEntryPath(root: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string }> {
  const relativePath = normalizeRelativePath(requestedPath);
  const absolutePath = resolveLexicalPath(root, relativePath);
  const targetLstat = await lstat(absolutePath);
  // 结构操作针对链接本身，因此不跟随可能指向项目外部的符号链接。
  if (!targetLstat.isSymbolicLink()) {
    const canonicalPath = await realpath(absolutePath);
    if (!isPathWithin(canonicalPath, root, true)) throw workspaceError('ZEUS_PROJECT_SOURCE_PATH_FORBIDDEN', '路径解析到了项目目录之外。');
  }
  return { absolutePath, relativePath };
}

async function resolveExistingPath(root: string, requestedPath: string, expected?: 'file' | 'directory'): Promise<{ absolutePath: string; relativePath: string }> {
  const relativePath = normalizeRelativePath(requestedPath);
  const lexicalPath = resolveLexicalPath(root, relativePath);
  const canonicalPath = await realpath(lexicalPath);
  if (!isPathWithin(canonicalPath, root, true)) throw workspaceError('ZEUS_PROJECT_SOURCE_PATH_FORBIDDEN', '路径解析到了项目目录之外。');
  const targetStat = await stat(canonicalPath);
  if (expected === 'file' && !targetStat.isFile()) throw workspaceError('ZEUS_PROJECT_SOURCE_NOT_FILE', '目标不是普通文件。');
  if (expected === 'directory' && !targetStat.isDirectory()) throw workspaceError('ZEUS_PROJECT_SOURCE_NOT_DIRECTORY', '目标不是目录。');
  return { absolutePath: lexicalPath, relativePath };
}

function resolveLexicalPath(root: string, relativePath: string): string {
  const absolutePath = resolve(root, relativePath || '.');
  if (!isPathWithin(absolutePath, root, true)) throw workspaceError('ZEUS_PROJECT_SOURCE_PATH_FORBIDDEN', '路径必须位于当前项目内。');
  return absolutePath;
}

function normalizeRelativePath(value: string): string {
  if (typeof value !== 'string' || value.includes('\0') || isAbsolute(value) || value.includes('\\')) throw workspaceError('ZEUS_PROJECT_SOURCE_PATH_INVALID', '项目文件路径无效。');
  const normalized = value
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');
  assertSafeRelativePath(normalized, true);
  return normalized;
}

function assertSafeRelativePath(value: string, allowRoot: boolean): void {
  if ((!allowRoot && !value) || value.includes('\0') || isAbsolute(value)) throw workspaceError('ZEUS_PROJECT_SOURCE_PATH_INVALID', '项目文件路径无效。');
  const segments = value.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '.git')) throw workspaceError('ZEUS_PROJECT_SOURCE_PATH_FORBIDDEN', '.git 和项目外路径不允许访问。');
}

function validateEntryName(name: string): void {
  if (!name || name === '.' || name === '..' || name === '.git' || name.includes('/') || name.includes('\\') || name.includes('\0') || name.length > 255) {
    throw workspaceError('ZEUS_PROJECT_SOURCE_NAME_INVALID', '文件或目录名称无效。');
  }
}

async function describeEntry(root: string, relativePath: string): Promise<ProjectSourceEntry> {
  const absolutePath = resolveLexicalPath(root, relativePath);
  const entryLstat = await lstat(absolutePath);
  const kind = entryLstat.isSymbolicLink() ? 'symlink' : entryLstat.isDirectory() ? 'directory' : 'file';
  let accessible = true;
  let symlinkTargetInsideProject: boolean | undefined;
  if (kind === 'symlink') {
    try {
      symlinkTargetInsideProject = isPathWithin(await realpath(absolutePath), root, true);
      accessible = symlinkTargetInsideProject;
    } catch {
      symlinkTargetInsideProject = false;
      accessible = false;
    }
  } else {
    try {
      await access(absolutePath);
    } catch {
      accessible = false;
    }
  }
  return {
    name: basename(relativePath),
    relativePath,
    kind,
    byteLength: entryLstat.size,
    modifiedAtMs: entryLstat.mtimeMs,
    accessible,
    ...(symlinkTargetInsideProject === undefined ? {} : { symlinkTargetInsideProject }),
  };
}

function compareEntries(left: ProjectSourceEntry, right: ProjectSourceEntry): number {
  const leftDirectory = left.kind === 'directory' ? 0 : 1;
  const rightDirectory = right.kind === 'directory' ? 0 : 1;
  return leftDirectory - rightDirectory || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
}

function revisionFromBytes(bytes: Buffer, modifiedAtMs: number): ProjectSourceRevision {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, modifiedAtMs };
}

function revisionFromStat(byteLength: number, modifiedAtMs: number): ProjectSourceRevision {
  return { sha256: createHash('sha256').update(`${byteLength}:${modifiedAtMs}`).digest('hex'), byteLength, modifiedAtMs };
}

async function revisionFromFile(path: string, byteLength: number, modifiedAtMs: number): Promise<ProjectSourceRevision> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { sha256: hash.digest('hex'), byteLength, modifiedAtMs };
}

function readOnlyDocument(relativePath: string, revision: ProjectSourceRevision, reason: NonNullable<ProjectSourceDocument['readOnlyReason']>): ProjectSourceDocument {
  return {
    relativePath,
    name: basename(relativePath),
    language: sourceLanguageForPath(relativePath),
    content: '',
    encoding: 'utf-8',
    eol: 'lf',
    hasBom: false,
    editable: false,
    readOnlyReason: reason,
    revision,
  };
}

function detectEol(content: string): ProjectSourceDocument['eol'] {
  if (content.includes('\r\n')) return 'crlf';
  if (content.includes('\r')) return 'cr';
  return 'lf';
}

function sourceLanguageForPath(path: string): string {
  const extension = extname(path).slice(1).toLocaleLowerCase();
  const languages: Record<string, string> = {
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    h: 'c',
    hpp: 'cpp',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return languages[extension] ?? 'text';
}

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function isPathWithin(candidate: string, root: string, allowEqual = false): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return (allowEqual && value === '') || (!!value && !value.startsWith('..') && !isAbsolute(value));
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw workspaceError('ZEUS_PROJECT_SOURCE_TARGET_EXISTS', '目标文件或目录已经存在。');
}

function workspaceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
