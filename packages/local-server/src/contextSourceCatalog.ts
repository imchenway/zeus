import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { maximumColdEvidenceAnchorsPerSource, type ColdEvidenceAnchorRecord, type ColdEvidenceRepository, type ColdEvidenceSourceKind, type ColdEvidenceSourceRecord } from '@zeus/storage';
import type { ContextFragment } from './contextCompiler.js';

export const defaultProjectDocumentPageBytes = 64 * 1024;
export const maximumProjectDocumentPageBytes = 256 * 1024;
export const defaultColdEvidenceIndexBytes = 512 * 1024 * 1024;
export const maximumColdEvidenceIndexBytes = 2 * 1024 * 1024 * 1024;
export const defaultColdEvidenceReadBytes = 64 * 1024;
export const maximumColdEvidenceReadBytes = 1024 * 1024;
const maximumJsonlLineBytes = 16 * 1024 * 1024;
const jsonlCheckpointLineInterval = 128;

export type ContextSourceOwner = 'project' | 'provider' | 'runtime';

export interface ContextSourceRoot {
  id: string;
  path: string;
  owner: ContextSourceOwner;
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

export interface IndexJsonlColdEvidenceInput {
  sourceId?: string;
  rootId: string;
  relativePath: string;
  kind: Extract<ColdEvidenceSourceKind, 'provider_rollout' | 'provider_history' | 'runtime_evidence'>;
  projectId?: string | null;
  taskCode?: string | null;
  providerId?: string | null;
  nativeSessionId?: string | null;
  summary?: string;
  indexedAt: string;
  maximumBytes?: number;
}

export interface ColdEvidenceReadEntry {
  anchor: ColdEvidenceAnchorRecord;
  text: string;
}

export interface ColdEvidenceReadPage {
  source: ColdEvidenceSourceRecord;
  entries: ColdEvidenceReadEntry[];
  hasMore: boolean;
  nextOrdinal: number | null;
  returnedBytes: number;
}

export type ContextSourceCatalogErrorCode =
  | 'ZEUS_CONTEXT_SOURCE_INVALID_ARGUMENT'
  | 'ZEUS_CONTEXT_SOURCE_ROOT_NOT_FOUND'
  | 'ZEUS_CONTEXT_SOURCE_PATH_INVALID'
  | 'ZEUS_CONTEXT_SOURCE_NOT_FOUND'
  | 'ZEUS_CONTEXT_SOURCE_CHANGED'
  | 'ZEUS_CONTEXT_SOURCE_IDENTITY_MISMATCH'
  | 'ZEUS_CONTEXT_SOURCE_PAGE_BUDGET_EXCEEDED'
  | 'ZEUS_CONTEXT_SOURCE_UNAUTHORIZED';

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
 * `/docs` 与冷证据文件的有界读取边界。
 *
 * 构造函数只登记受控根目录；不会扫描目录。Provider Adapter 必须显式调用 indexJsonl，
 * 普通启动和 Context Compiler 都不会读取 rollout/history。
 */
export class ContextSourceCatalog {
  private readonly roots: ReadonlyMap<string, ContextSourceRoot>;

  constructor(
    roots: ContextSourceRoot[],
    private readonly evidence: ColdEvidenceRepository,
    private readonly authorizeColdRead: (source: ColdEvidenceSourceRecord) => boolean,
  ) {
    const normalized = roots.map(normalizeRoot);
    if (new Set(normalized.map((root) => root.id)).size !== normalized.length) throw invalidArgument('Context source root ID 不能重复。', { field: 'roots' });
    this.roots = new Map(normalized.map((root) => [root.id, root]));
  }

  /** 只枚举单个项目的 `/docs` 一级目录；不会跨项目或递归扫描历史目录。 */
  async discoverTaskDocuments(input: { rootId: string; projectId: string; taskCode: string; maximumDirectoryEntries?: number }): Promise<ProjectTaskDocumentSelection> {
    const root = this.requireRoot(input.rootId, 'project');
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
    const root = this.requireRoot(input.document.rootId, 'project');
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

  /** 把已选主文档登记为冷定位元数据；只保存当前有界页的摘要与锚点。 */
  async indexProjectDocument(input: { document: ProjectTaskDocumentCandidate; summary?: string; indexedAt: string; maximumBytes?: number }): Promise<ColdEvidenceSourceRecord> {
    const page = await this.readDocumentPage({ document: input.document, maximumBytes: input.maximumBytes });
    const sourceId = contextSourceId(input.document.rootId, input.document.relativePath);
    const indexedAt = validTimestamp(input.indexedAt, 'indexedAt');
    return this.evidence.replaceIndex({
      source: {
        id: sourceId,
        kind: 'project_document',
        rootId: input.document.rootId,
        relativePath: input.document.relativePath,
        projectId: input.document.projectId,
        taskCode: input.document.taskCode,
        providerId: null,
        nativeSessionId: null,
        summary: input.summary?.trim() ?? '',
        status: page.nextByteOffset === null ? 'ready' : 'partial',
        sourceVersion: `${page.document.modifiedAt}:${page.totalByteLength}:${page.sha256}`,
        indexedThroughByte: page.byteOffset + page.byteLength,
        sourceByteLength: page.totalByteLength,
        sourceModifiedAt: page.document.modifiedAt,
        indexedPrefixSha256: page.sha256,
        firstOccurredAt: null,
        lastOccurredAt: null,
        indexedAt,
      },
      anchors:
        page.byteLength === 0
          ? []
          : [
              {
                sourceId,
                ordinal: 1,
                lineNumber: 1,
                byteOffset: 0,
                byteLength: page.byteLength,
                lineSha256: page.sha256,
                eventKind: 'document_page',
                turnId: null,
                eventSequence: null,
                occurredAt: page.document.modifiedAt,
              },
            ],
    });
  }

  /** Provider/运行 owner 显式触发的单文件流式索引；不会遍历 sessions 目录。 */
  async indexJsonl(input: IndexJsonlColdEvidenceInput): Promise<ColdEvidenceSourceRecord> {
    const kind = validJsonlKind(input.kind);
    const requiredOwner: ContextSourceOwner = kind === 'runtime_evidence' ? 'runtime' : 'provider';
    const root = this.requireRoot(input.rootId, requiredOwner);
    if (!input.relativePath.toLowerCase().endsWith('.jsonl')) throw invalidArgument('冷证据 JSONL 必须使用 .jsonl 相对路径。', { relativePath: input.relativePath });
    const resolved = await resolveOwnedFile(root, input.relativePath);
    const before = await stat(resolved.path);
    const maximumBytes = boundedInteger(input.maximumBytes ?? defaultColdEvidenceIndexBytes, 'maximumBytes', 1, maximumColdEvidenceIndexBytes);
    const scanLimit = Math.min(before.size, maximumBytes);
    const sourceId = input.sourceId === undefined ? contextSourceId(root.id, resolved.relativePath) : boundedText(input.sourceId, 'sourceId', 1, 512);
    const scan = await scanJsonlPrefix(resolved.path, sourceId, scanLimit, before.size);
    const after = await stat(resolved.path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size < before.size) {
      throw sourceChanged('冷证据来源在索引期间被替换或截断，未写入索引。', { sourceId });
    }
    const projectId = optionalCatalogIdentity(input.projectId, 'projectId', 512);
    const taskCode = optionalCatalogIdentity(input.taskCode, 'taskCode', 160);
    const providerId = optionalCatalogIdentity(input.providerId, 'providerId', 160);
    const expectedNativeSessionId = optionalCatalogIdentity(input.nativeSessionId, 'nativeSessionId', 512);
    if ((kind === 'provider_rollout' || kind === 'provider_history') && !providerId) {
      throw invalidArgument('Provider rollout/history 索引必须携带 providerId。', { sourceId, kind });
    }
    if (expectedNativeSessionId && scan.nativeSessionId && expectedNativeSessionId.toLowerCase() !== scan.nativeSessionId.toLowerCase()) {
      throw new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_IDENTITY_MISMATCH', 'JSONL session_meta 与请求的原生会话身份不一致。', { sourceId, expectedNativeSessionId, actualNativeSessionId: scan.nativeSessionId });
    }
    const indexedAt = validTimestamp(input.indexedAt, 'indexedAt');
    return this.evidence.replaceIndex({
      source: {
        id: sourceId,
        kind,
        rootId: root.id,
        relativePath: resolved.relativePath,
        projectId,
        taskCode,
        providerId,
        nativeSessionId: expectedNativeSessionId ?? scan.nativeSessionId,
        summary: input.summary?.trim() ?? '',
        status: scan.indexedThroughByte === after.size ? 'ready' : 'partial',
        sourceVersion: `${scan.indexedThroughByte}:${scan.indexedPrefixSha256}`,
        indexedThroughByte: scan.indexedThroughByte,
        sourceByteLength: after.size,
        sourceModifiedAt: after.mtime.toISOString(),
        indexedPrefixSha256: scan.indexedPrefixSha256,
        firstOccurredAt: scan.firstOccurredAt,
        lastOccurredAt: scan.lastOccurredAt,
        indexedAt,
      },
      anchors: scan.anchors,
    });
  }

  /** 按已索引 source/turn/event 锚点精确分页；不会全文搜索或扫描目录。 */
  async readColdEvidencePage(input: { sourceId: string; turnId?: string; eventSequence?: number; afterOrdinal?: number; limit?: number; maximumBytes?: number }): Promise<ColdEvidenceReadPage> {
    const source = this.evidence.getSource(input.sourceId);
    if (!source) throw new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_NOT_FOUND', '冷证据来源不存在。', { sourceId: input.sourceId });
    if (!this.authorizeColdRead(source)) throw new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_UNAUTHORIZED', '当前请求没有读取该冷证据来源的授权。', { sourceId: source.id });
    if (source.status === 'missing' || source.status === 'stale') throw sourceChanged('冷证据来源已缺失或索引过时，必须重建索引后再分页读取。', { sourceId: source.id, status: source.status });
    const root = this.requireRoot(source.rootId, source.kind === 'runtime_evidence' ? 'runtime' : source.kind === 'project_document' ? 'project' : 'provider');
    const resolved = await resolveOwnedFile(root, source.relativePath);
    const maximumBytes = boundedInteger(input.maximumBytes ?? defaultColdEvidenceReadBytes, 'maximumBytes', 1, maximumColdEvidenceReadBytes);
    const anchorPage = this.evidence.listAnchors({ sourceId: source.id, turnId: input.turnId, eventSequence: input.eventSequence, afterOrdinal: input.afterOrdinal, limit: input.limit });
    const selected: ColdEvidenceAnchorRecord[] = [];
    let returnedBytes = 0;
    for (const anchor of anchorPage.items) {
      if (selected.length === 0 && anchor.byteLength > maximumBytes) {
        throw new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_PAGE_BUDGET_EXCEEDED', '单条证据超过当前读取预算，请显式提高 maximumBytes 后重试。', {
          sourceId: source.id,
          ordinal: anchor.ordinal,
          byteLength: anchor.byteLength,
          maximumBytes,
        });
      }
      if (selected.length > 0 && returnedBytes + anchor.byteLength > maximumBytes) break;
      selected.push(anchor);
      returnedBytes += anchor.byteLength;
    }
    const handle = await open(resolved.path, 'r');
    try {
      const entries: ColdEvidenceReadEntry[] = [];
      for (const anchor of selected) {
        const buffer = Buffer.alloc(anchor.byteLength);
        const result = await handle.read(buffer, 0, buffer.length, anchor.byteOffset);
        if (result.bytesRead !== buffer.length || createHash('sha256').update(buffer).digest('hex') !== anchor.lineSha256) {
          throw sourceChanged('冷证据锚点与当前原始文件不一致，索引已过时。', { sourceId: source.id, ordinal: anchor.ordinal });
        }
        entries.push({ anchor, text: decodeUtf8(buffer, source.id) });
      }
      const moreWithinFetchedPage = selected.length < anchorPage.items.length;
      return {
        source,
        entries,
        hasMore: moreWithinFetchedPage || anchorPage.hasMore,
        nextOrdinal: selected.at(-1)?.ordinal ?? null,
        returnedBytes,
      };
    } finally {
      await handle.close();
    }
  }

  private requireRoot(rootId: string, owner: ContextSourceOwner): ContextSourceRoot {
    const id = boundedText(rootId, 'rootId', 1, 256);
    const root = this.roots.get(id);
    if (!root) throw new ContextSourceCatalogError('ZEUS_CONTEXT_SOURCE_ROOT_NOT_FOUND', '受控上下文来源根目录未登记。', { rootId: id });
    if (root.owner !== owner) throw pathError('上下文来源 root owner 与操作类型不匹配。', { rootId: id, expectedOwner: owner, actualOwner: root.owner });
    return root;
  }
}

export function contextSourceId(rootId: string, relativePath: string): string {
  return `cold_${createHash('sha256').update(`${rootId}\0${relativePath}`).digest('hex')}`;
}

const supplementalDocumentPattern = /(?:^|_)(?:设计图|方案图|原型|可视化|截图|附录|补充)(?:_|\.|$)/iu;

function normalizeRoot(root: ContextSourceRoot): ContextSourceRoot {
  const id = boundedText(root.id, 'root.id', 1, 256);
  const path = boundedText(root.path, 'root.path', 1, 4_096);
  if (!isAbsolute(path)) throw invalidArgument('Context source root 必须是绝对路径。', { rootId: id });
  if (root.owner !== 'project' && root.owner !== 'provider' && root.owner !== 'runtime') throw invalidArgument('未知 Context source owner。', { rootId: id, owner: String(root.owner) });
  return { id, path: resolve(path), owner: root.owner };
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

async function scanJsonlPrefix(
  path: string,
  sourceId: string,
  scanLimit: number,
  sourceByteLength: number,
): Promise<{
  anchors: ColdEvidenceAnchorRecord[];
  indexedThroughByte: number;
  indexedPrefixSha256: string;
  nativeSessionId: string | null;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
}> {
  const anchors: ColdEvidenceAnchorRecord[] = [];
  const prefixHash = createHash('sha256');
  let pending = Buffer.alloc(0);
  let pendingOffset = 0;
  let lineNumber = 0;
  let indexedThroughByte = 0;
  let nativeSessionId: string | null = null;
  let firstOccurredAt: string | null = null;
  let lastOccurredAt: string | null = null;

  if (scanLimit === 0) {
    return { anchors, indexedThroughByte, indexedPrefixSha256: prefixHash.digest('hex'), nativeSessionId, firstOccurredAt, lastOccurredAt };
  }

  const consume = (rawWithOptionalNewline: Buffer, hasNewline: boolean): boolean => {
    const nextLineNumber = lineNumber + 1;
    const newlineBytes = hasNewline ? (rawWithOptionalNewline.length >= 2 && rawWithOptionalNewline.at(-2) === 0x0d ? 2 : 1) : 0;
    const line = rawWithOptionalNewline.subarray(0, rawWithOptionalNewline.length - newlineBytes);
    if (line.length > maximumJsonlLineBytes) throw invalidArgument('JSONL 单行超过冷证据索引上限。', { sourceId, lineNumber: nextLineNumber, byteLength: line.length, maximum: maximumJsonlLineBytes });
    const metadata = line.length === 0 ? emptyJsonlMetadata('empty') : parseJsonlMetadata(line);
    const checkpoint = nextLineNumber === 1 || nextLineNumber % jsonlCheckpointLineInterval === 0;
    const shouldAnchor =
      line.length > 0 &&
      (checkpoint || Boolean(metadata.turnId) || metadata.eventSequence !== null || metadata.eventKind === 'session_meta' || metadata.eventKind === 'session' || metadata.eventKind === 'turn_context' || metadata.eventKind === 'message');
    if (shouldAnchor && anchors.length >= maximumColdEvidenceAnchorsPerSource) return false;

    lineNumber = nextLineNumber;
    prefixHash.update(rawWithOptionalNewline);
    indexedThroughByte = pendingOffset + rawWithOptionalNewline.length;
    if (lineNumber === 1 && (metadata.eventKind === 'session_meta' || metadata.eventKind === 'session')) nativeSessionId = metadata.nativeSessionId;
    if (metadata.occurredAt) {
      firstOccurredAt ??= metadata.occurredAt;
      lastOccurredAt = metadata.occurredAt;
    }
    if (shouldAnchor) {
      anchors.push({
        sourceId,
        ordinal: anchors.length + 1,
        lineNumber,
        byteOffset: pendingOffset,
        byteLength: line.length,
        lineSha256: createHash('sha256').update(line).digest('hex'),
        eventKind: metadata.eventKind,
        turnId: metadata.turnId,
        eventSequence: metadata.eventSequence,
        occurredAt: metadata.occurredAt,
      });
    }
    return true;
  };

  const stream = createReadStream(path, { start: 0, end: Math.max(0, scanLimit - 1), highWaterMark: 1024 * 1024 });
  let stoppedAtAnchorLimit = false;
  streamLoop: for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let cursor = 0;
    while (true) {
      const newlineIndex = data.indexOf(0x0a, cursor);
      if (newlineIndex < 0) break;
      const rawLine = data.subarray(cursor, newlineIndex + 1);
      if (!consume(rawLine, true)) {
        stoppedAtAnchorLimit = true;
        break streamLoop;
      }
      pendingOffset += rawLine.length;
      cursor = newlineIndex + 1;
    }
    pending = data.subarray(cursor);
    if (pending.length > maximumJsonlLineBytes) throw invalidArgument('JSONL 单行超过冷证据索引上限。', { sourceId, lineNumber: lineNumber + 1, maximum: maximumJsonlLineBytes });
  }
  if (!stoppedAtAnchorLimit && pending.length > 0 && scanLimit === sourceByteLength) consume(pending, false);
  return {
    anchors,
    indexedThroughByte,
    indexedPrefixSha256: prefixHash.digest('hex'),
    nativeSessionId,
    firstOccurredAt,
    lastOccurredAt,
  };
}

function parseJsonlMetadata(bytes: Buffer): { eventKind: string; nativeSessionId: string | null; turnId: string | null; eventSequence: number | null; occurredAt: string | null } {
  try {
    const parsed = JSON.parse(decodeUtf8(bytes, 'jsonl-index')) as unknown;
    if (!isRecord(parsed)) return emptyJsonlMetadata('unknown');
    const payload = isRecord(parsed.payload) ? parsed.payload : null;
    const nestedTurn = payload && isRecord(payload.turn) ? payload.turn : null;
    const eventKind = boundedEventKind(typeof parsed.type === 'string' ? parsed.type : payload && typeof payload.type === 'string' ? payload.type : 'unknown');
    const nativeSessionId = eventKind === 'session_meta' && payload && typeof payload.id === 'string' ? payload.id : eventKind === 'session' && typeof parsed.id === 'string' ? parsed.id : null;
    const turnId = firstString(parsed.turn_id, parsed.turnId, payload?.turn_id, payload?.turnId, nestedTurn?.id);
    const eventSequence = firstNonNegativeInteger(parsed.sequence, parsed.event_sequence, payload?.sequence, payload?.event_sequence);
    const occurredAt = firstTimestamp(parsed.timestamp, parsed.created_at, parsed.occurred_at, payload?.timestamp, payload?.created_at, payload?.occurred_at);
    return { eventKind, nativeSessionId, turnId, eventSequence, occurredAt };
  } catch {
    return emptyJsonlMetadata('invalid_json');
  }
}

function emptyJsonlMetadata(eventKind: string): { eventKind: string; nativeSessionId: null; turnId: null; eventSequence: null; occurredAt: null } {
  return { eventKind, nativeSessionId: null, turnId: null, eventSequence: null, occurredAt: null };
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512) ?? null;
}

function firstNonNegativeInteger(...values: unknown[]): number | null {
  return values.find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ?? null;
}

function firstTimestamp(...values: unknown[]): string | null {
  const value = values.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length <= 64 && !Number.isNaN(Date.parse(candidate)));
  return value ? new Date(Date.parse(value)).toISOString() : null;
}

function boundedEventKind(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : 'unknown';
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

function validJsonlKind(value: IndexJsonlColdEvidenceInput['kind']): IndexJsonlColdEvidenceInput['kind'] {
  if (value !== 'provider_rollout' && value !== 'provider_history' && value !== 'runtime_evidence') throw invalidArgument('未知 JSONL 冷证据来源类型。', { value: String(value) });
  return value;
}

function optionalCatalogIdentity(value: string | null | undefined, field: string, maximum: number): string | null {
  return value === null || value === undefined ? null : boundedText(value, field, 1, maximum);
}

function assertPathInside(root: string, candidate: string, rootId: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw pathError('上下文来源路径越过受控根目录。', { rootId });
}

function toPosixRelative(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join('/');
}

function decodeUtf8(buffer: Buffer, sourceId: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw pathError('上下文来源不是有效 UTF-8 文本。', { sourceId });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value: string, field: string): string {
  const timestamp = boundedText(value, field, 1, 64);
  const epoch = Date.parse(timestamp);
  if (Number.isNaN(epoch)) throw invalidArgument(`${field} 必须是有效时间字符串。`, { field });
  return new Date(epoch).toISOString();
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
