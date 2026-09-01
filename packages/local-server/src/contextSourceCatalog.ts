import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ContextFragment } from './contextCompiler.js';

export const defaultProjectDocumentPageBytes = 64 * 1024;
export const maximumProjectDocumentPageBytes = 256 * 1024;
export interface ContextSourceRoot {
  id: string;
  path: string;
}

export interface ProjectTaskDocumentCandidate {
  rootId: string;
  projectId: string;
  taskCode: string;
  relativePath: string;
  format: 'markdown' | 'html';
  role: 'primary' | 'supplemental';
  byteLength: number;
  modifiedAt: string;
  selectionReasons: string[];
}

export interface ProjectTaskDocumentSelection {
  primary: ProjectTaskDocumentCandidate | null;
  candidates: ProjectTaskDocumentCandidate[];
  truncatedDirectory: boolean;
}

export interface ProjectDocumentPage {
  document: ProjectTaskDocumentCandidate;
  text: string;
  byteOffset: number;
  byteLength: number;
  totalByteLength: number;
  nextByteOffset: number | null;
  sha256: string;
}

export type ContextSourceCatalogErrorCode = 'ZEUS_CONTEXT_SOURCE_INVALID_ARGUMENT' | 'ZEUS_CONTEXT_SOURCE_ROOT_NOT_FOUND' | 'ZEUS_CONTEXT_SOURCE_PATH_INVALID' | 'ZEUS_CONTEXT_SOURCE_NOT_FOUND' | 'ZEUS_CONTEXT_SOURCE_CHANGED';

export class ContextSourceCatalogError extends Error {
  readonly name = 'ContextSourceCatalogError';

  constructor(
    readonly code: ContextSourceCatalogErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
  }
}

/**
 * 项目 `/docs` 的有界读取边界。构造函数只登记受控根目录，不会扫描目录。
 */
export class ContextSourceCatalog {
  private readonly roots: ReadonlyMap<string, ContextSourceRoot>;

  constructor(roots: ContextSourceRoot[]) {
    const normalized = roots.map(normalizeRoot);
    if (new Set(normalized.map((root) => root.id)).size !== normalized.length) throw invalidArgument('Context source root ID 不能重复。', { field: 'roots' });
    this.roots = new Map(normalized.map((root) => [root.id, root]));
  }

  /** 只枚举单个项目的 `/docs` 一级目录；不会跨项目或递归扫描历史目录。 */
  async discoverTaskDocuments(input: { rootId: string; projectId: string; taskCode: string; maximumDirectoryEntries?: number }): Promise<ProjectTaskDocumentSelection> {
    const root = this.requireRoot(input.rootId);
    const projectId = boundedText(input.projectId, 'projectId', 1, 512);
    const taskCode = normalizeTaskCode(input.taskCode);
    const maximumDirectoryEntries = boundedInteger(input.maximumDirectoryEntries ?? 4_096, 'maximumDirectoryEntries', 1, 20_000);
    const rootPath = await canonicalRoot(root);
    const docsPath = join(rootPath, 'docs');
    const entries: Dirent[] = [];
    let truncatedDirectory = false;
    try {
      const docsStatus = await lstat(docsPath);
      if (docsStatus.isSymbolicLink() || !docsStatus.isDirectory()) throw pathError('项目 docs 不是普通目录或是符号链接。', { rootId: root.id });
      const directory = await opendir(docsPath);
      let scannedEntries = 0;
      for await (const entry of directory) {
        scannedEntries += 1;
        if (scannedEntries > maximumDirectoryEntries) {
          truncatedDirectory = true;
          break;
        }
        entries.push(entry);
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { primary: null, candidates: [], truncatedDirectory: false };
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const matchingEntries = entries.filter((entry) => {
      const extension = extname(entry.name).toLowerCase();
      return entry.isFile() && filenameMatchesTaskCode(entry.name, taskCode) && (extension === '.md' || extension === '.html');
    });
    const candidates: ProjectTaskDocumentCandidate[] = [];
    for (const entry of matchingEntries) {
      const extension = extname(entry.name).toLowerCase();
      const absolutePath = join(docsPath, entry.name);
      const fileStatus = await lstat(absolutePath);
      if (fileStatus.isSymbolicLink() || !fileStatus.isFile()) continue;
      const canonicalPath = await realpath(absolutePath);
      assertPathInside(rootPath, canonicalPath, root.id);
      const role = supplementalDocumentPattern.test(entry.name) ? 'supplemental' : 'primary';
      const format = extension === '.md' ? 'markdown' : 'html';
      candidates.push({
        rootId: root.id,
        projectId,
        taskCode,
        relativePath: toPosixRelative(rootPath, canonicalPath),
        format,
        role,
        byteLength: fileStatus.size,
        modifiedAt: fileStatus.mtime.toISOString(),
        selectionReasons: [role === 'primary' ? '文件名未标记为补充材料' : '文件名标记为补充材料', format === 'markdown' ? 'Markdown 主资料优先于展示型 HTML' : 'HTML 作为次级展示资料'],
      });
    }
    candidates.sort(compareDocumentCandidates);
    return { primary: truncatedDirectory ? null : (candidates.find((candidate) => candidate.role === 'primary') ?? null), candidates, truncatedDirectory };
  }

  async readDocumentPage(input: { document: ProjectTaskDocumentCandidate; byteOffset?: number; maximumBytes?: number }): Promise<ProjectDocumentPage> {
    const root = this.requireRoot(input.document.rootId);
    const byteOffset = boundedInteger(input.byteOffset ?? 0, 'byteOffset', 0, Number.MAX_SAFE_INTEGER);
    const maximumBytes = boundedInteger(input.maximumBytes ?? defaultProjectDocumentPageBytes, 'maximumBytes', 1, maximumProjectDocumentPageBytes);
    const resolved = await resolveOwnedFile(root, input.document.relativePath);
    const before = await stat(resolved.path);
    if (byteOffset > before.size) throw invalidArgument('byteOffset 超过文档长度。', { byteOffset, totalByteLength: before.size });
    const page = await readUtf8Page(resolved.path, byteOffset, maximumBytes, before.size);
    const after = await stat(resolved.path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw sourceChanged('任务文档在分页读取期间发生变化，请重新定位主文档。', { rootId: root.id, relativePath: resolved.relativePath });
    }
    return { document: { ...input.document, byteLength: after.size, modifiedAt: after.mtime.toISOString() }, ...page, totalByteLength: after.size };
  }

  async primaryTaskDocumentFragment(input: {
    rootId: string;
    projectId: string;
    taskId: string;
    taskCode: string;
    maximumBytes?: number;
  }): Promise<{ fragment: ContextFragment | null; selection: ProjectTaskDocumentSelection; page: ProjectDocumentPage | null }> {
    const selection = await this.discoverTaskDocuments(input);
    if (!selection.primary) return { fragment: null, selection, page: null };
    const page = await this.readDocumentPage({ document: selection.primary, maximumBytes: input.maximumBytes });
    return {
      selection,
      page,
      fragment: {
        id: `task-document:${input.taskId}:${selection.primary.relativePath}`,
        category: 'task_document',
        authority: 'project_document',
        status: 'current',
        provenance: 'zeus_current',
        projectId: selection.primary.projectId,
        taskId: input.taskId,
        taskCode: selection.primary.taskCode,
        content: page.text,
        sourceRef: `${selection.primary.rootId}:${selection.primary.relativePath}`,
        sourceVersion: `${page.document.modifiedAt}:${page.totalByteLength}:${page.sha256}`,
        updatedAt: page.document.modifiedAt,
        contentSha256: page.sha256,
        dedupeKey: `task-document:${selection.primary.projectId}:${selection.primary.taskCode}`,
        primaryTaskDocument: true,
        sourceTruncationReason: page.nextByteOffset === null ? undefined : 'source_page_limit',
      },
    };
  }

  private requireRoot(rootId: string): ContextSourceRoot {
    const id = boundedText(rootId, 'rootId', 1, 256);
    const root = this.roots.get(id);
    if (!root) throw new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_ROOT_NOT_FOUND', '受控上下文来源根目录未登记。', { rootId: id });
    return root;
  }
}

const supplementalDocumentPattern = /(?:^|_)(?:设计图|方案图|原型|可视化|截图|附录|补充)(?:_|\.|$)/iu;

function normalizeRoot(root: ContextSourceRoot): ContextSourceRoot {
  const id = boundedText(root.id, 'root.id', 1, 256);
  const path = boundedText(root.path, 'root.path', 1, 4_096);
  if (!isAbsolute(path)) throw invalidArgument('Context source root 必须是绝对路径。', { rootId: id });
  return { id, path: resolve(path) };
}

async function canonicalRoot(root: ContextSourceRoot): Promise<string> {
  try {
    const path = await realpath(root.path);
    const status = await stat(path);
    if (!status.isDirectory()) throw pathError('受控上下文来源根路径不是目录。', { rootId: root.id });
    return path;
  } catch (error) {
    if (error instanceof ContextSourceCatalogError) throw error;
    throw new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_ROOT_NOT_FOUND', '受控上下文来源根目录不存在或不可读取。', { rootId: root.id });
  }
}

async function resolveOwnedFile(root: ContextSourceRoot, relativePath: string): Promise<{ path: string; relativePath: string }> {
  const normalizedRelative = normalizeRelativePath(relativePath);
  const rootPath = await canonicalRoot(root);
  const candidate = resolve(rootPath, normalizedRelative);
  assertPathInside(rootPath, candidate, root.id);
  const candidateStatus = await lstat(candidate).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') throw new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_NOT_FOUND', '上下文来源文件不存在。', { rootId: root.id, relativePath: normalizedRelative });
    throw error;
  });
  if (candidateStatus.isSymbolicLink() || !candidateStatus.isFile()) throw pathError('上下文来源必须是非符号链接普通文件。', { rootId: root.id, relativePath: normalizedRelative });
  const canonical = await realpath(candidate);
  assertPathInside(rootPath, canonical, root.id);
  return { path: canonical, relativePath: toPosixRelative(rootPath, canonical) };
}

async function readUtf8Page(path: string, byteOffset: number, maximumBytes: number, totalByteLength: number): Promise<Omit<ProjectDocumentPage, 'document' | 'totalByteLength'>> {
  const requested = Math.min(maximumBytes, totalByteLength - byteOffset);
  if (requested <= 0) return { text: '', byteOffset, byteLength: 0, nextByteOffset: null, sha256: createHash('sha256').update('').digest('hex') };
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(requested);
    const { bytesRead } = await handle.read(buffer, 0, requested, byteOffset);
    let validLength = bytesRead;
    let text: string | null = null;
    for (let trim = 0; trim <= Math.min(3, bytesRead); trim += 1) {
      try {
        validLength = bytesRead - trim;
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, validLength));
        break;
      } catch {
        // 只允许裁掉页尾不完整的 UTF-8 code point；页首偏移必须来自上一个 nextByteOffset。
      }
    }
    if (text === null || validLength === 0) throw pathError('文档分页偏移不在有效 UTF-8 边界。', { byteOffset });
    const bytes = buffer.subarray(0, validLength);
    const nextByteOffset = byteOffset + validLength < totalByteLength ? byteOffset + validLength : null;
    return { text, byteOffset, byteLength: validLength, nextByteOffset, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}

function compareDocumentCandidates(left: ProjectTaskDocumentCandidate, right: ProjectTaskDocumentCandidate): number {
  const role = Number(left.role === 'supplemental') - Number(right.role === 'supplemental');
  const format = Number(left.format === 'html') - Number(right.format === 'html');
  return role || format || right.modifiedAt.localeCompare(left.modifiedAt) || right.byteLength - left.byteLength || left.relativePath.localeCompare(right.relativePath);
}

function filenameMatchesTaskCode(filename: string, taskCode: string): boolean {
  const upper = filename.toUpperCase();
  const code = taskCode.toUpperCase();
  const index = upper.indexOf(code);
  if (index < 0) return false;
  const before = index === 0 ? '' : upper[index - 1]!;
  const after = upper[index + code.length] ?? '';
  return !/[A-Z0-9]/u.test(before) && !/[A-Z0-9]/u.test(after);
}

function normalizeTaskCode(value: string): string {
  const taskCode = boundedText(value, 'taskCode', 1, 160).toUpperCase();
  if (!/^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+$/u.test(taskCode)) throw invalidArgument('taskCode 格式不合法。', { taskCode });
  return taskCode;
}

function normalizeRelativePath(value: string): string {
  const relativePath = boundedText(value, 'relativePath', 1, 4_096);
  if (
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath === '.' ||
    relativePath === '..' ||
    relativePath.endsWith('/') ||
    relativePath.startsWith('../') ||
    relativePath.includes('/../') ||
    relativePath.includes('/./') ||
    relativePath.startsWith('./')
  ) {
    throw pathError('上下文来源必须使用不能越过受控根目录的规范相对路径。', { relativePath });
  }
  return relativePath;
}

function assertPathInside(root: string, candidate: string, rootId: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw pathError('上下文来源路径越过受控根目录。', { rootId });
}

function toPosixRelative(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join('/');
}

function boundedText(value: string, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < minimum || value.length > maximum || value.includes('\0')) {
    throw invalidArgument(`${field} 必须是 ${minimum} 到 ${maximum} 个字符、首尾无空白且不含 NUL 的字符串。`, { field, minimum, maximum });
  }
  return value;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidArgument(`${field} 必须是 ${minimum} 到 ${maximum} 之间的安全整数。`, { field, minimum, maximum });
  return value;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

function invalidArgument(message: string, details: Readonly<Record<string, string | number | boolean | null>>): ContextSourceCatalogError {
  return new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_INVALID_ARGUMENT', message, details);
}

function pathError(message: string, details: Readonly<Record<string, string | number | boolean | null>>): ContextSourceCatalogError {
  return new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_PATH_INVALID', message, details);
}

function sourceChanged(message: string, details: Readonly<Record<string, string | number | boolean | null>>): ContextSourceCatalogError {
  return new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_CHANGED', message, details);
}
