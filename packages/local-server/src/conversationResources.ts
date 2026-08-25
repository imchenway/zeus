import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants as fsConstants, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationAttachmentResource, ConversationFileIconKind, ConversationFileLocation, ConversationFileResource, ConversationResource, ConversationResourcePresentation, ConversationWebsiteResource } from '@zeus/shared';
import type { ZeusConversationItemRecord, ZeusConversationResourceRecord } from '@zeus/storage';

interface ResourceCandidateBase {
  sourceIndex: number;
  presentation: ConversationResourcePresentation;
  delivery?: 'assistant';
  displayName: string;
}

interface FileResourceCandidate extends ResourceCandidateBase {
  kind: 'file';
  absolutePath: string;
  projectRelativePath: string;
  projectRoot: string;
  allowedRoot: string;
  location?: ConversationFileLocation;
  mimeType?: string;
  iconKind: ConversationFileIconKind;
}

interface WebsiteResourceCandidate extends ResourceCandidateBase {
  kind: 'website';
  url: string;
  domain: string;
  local: boolean;
  title?: string;
}

interface AttachmentResourceCandidate extends ResourceCandidateBase {
  kind: 'attachment';
  absolutePath: string;
  allowedRoot: string;
  attachmentRef: string;
  mimeType?: string;
  previewKind: 'image' | 'document' | 'none';
  iconKind: ConversationFileIconKind;
  taskPushAttachmentKey?: string;
  origin?: 'assistant_markdown_image';
}

type ResourceCandidate = FileResourceCandidate | WebsiteResourceCandidate | AttachmentResourceCandidate;

export interface NormalizeConversationResourcesInput {
  projectId: string;
  projectRoot: string;
  conversationId: string;
  turnId: string;
  item: ZeusConversationItemRecord;
  payload: Record<string, unknown>;
  text: string;
  trustedAttachmentRoots: readonly string[];
  generatedImageRoot?: string;
  assistantImageArchiveRoot?: string;
  now: string;
}

export interface ConversationResourceOpenIntent {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  itemId: string;
  kind: 'file' | 'website' | 'attachment';
  presentation: ConversationResourcePresentation;
  display: Record<string, unknown>;
  target: Record<string, unknown>;
  authority: Record<string, unknown>;
}

export interface ConversationFileOpenGrant {
  resource: ConversationFileResource;
  intent: ConversationResourceOpenIntent;
}

const markdownLinkPattern = /(!?)\[([^\]\n]+)\]\(([^)\n]+)\)/gu;
const maximumResourceUrlLength = 8_192;
const maximumResourcesPerItem = 128;
const maximumArchivedAssistantImageBytes = 16 * 1_024 * 1_024;
const maximumArchivedAssistantImageBatchBytes = 64 * 1_024 * 1_024;

export function normalizeConversationResources(input: NormalizeConversationResourcesInput): Array<Omit<ZeusConversationResourceRecord, 'createdAt' | 'updatedAt'>> {
  const candidates: ResourceCandidate[] = [];
  const assistantImageArchiveBudget = { remainingBytes: maximumArchivedAssistantImageBatchBytes };
  const assistantImageSourceRoots = [input.projectRoot, ...input.trustedAttachmentRoots, input.generatedImageRoot, tmpdir(), '/private/tmp']
    .filter((root): root is string => Boolean(root))
    .map(safeRealpath)
    .filter((root): root is string => Boolean(root));
  let sourceIndex = 0;

  const generatedImages = normalizeGeneratedImageResources({
    sourceIndex,
    item: input.item,
    payload: input.payload,
    generatedImageRoot: input.generatedImageRoot,
  });
  for (const generatedImage of generatedImages) {
    candidates.push(generatedImage);
    sourceIndex += 1;
  }

  for (const link of markdownLinks(input.text)) {
    const linkSourceIndex = sourceIndex++;
    const candidate =
      (link.image
        ? normalizeArchivedAssistantMarkdownImage({
            sourceIndex: linkSourceIndex,
            label: link.label,
            href: link.href,
            conversationId: input.conversationId,
            item: input.item,
            archiveRoot: input.assistantImageArchiveRoot ?? input.trustedAttachmentRoots.find((root) => basename(root) === 'conversation-attachments'),
            sourceRoots: assistantImageSourceRoots,
            budget: assistantImageArchiveBudget,
          })
        : null) ??
      normalizeLinkedResource({
        sourceIndex: linkSourceIndex,
        label: link.label,
        href: link.href,
        presentation: 'inline',
        projectRoot: input.projectRoot,
      });
    if (candidate) {
      candidates.push(candidate);
      const artifactCard = localHtmlArtifactCard(candidate, sourceIndex);
      if (artifactCard) {
        candidates.push(artifactCard);
        sourceIndex += 1;
      }
    }
    if (candidates.length >= maximumResourcesPerItem) break;
  }

  if (candidates.length < maximumResourcesPerItem) {
    for (const change of recordArray(input.payload.changes)) {
      for (const path of fileChangeResourcePaths(change)) {
        const candidate = normalizeFileChangeResource({
          sourceIndex: sourceIndex++,
          path,
          projectRoot: input.projectRoot,
        });
        if (candidate) candidates.push(candidate);
        if (candidates.length >= maximumResourcesPerItem) break;
      }
      if (candidates.length >= maximumResourcesPerItem) break;
    }
  }

  if (candidates.length < maximumResourcesPerItem) {
    for (const attachment of recordArray(input.payload.attachments)) {
      const candidate = normalizeAttachmentResource({
        sourceIndex: sourceIndex++,
        value: attachment,
        projectRoot: input.projectRoot,
        trustedAttachmentRoots: input.trustedAttachmentRoots,
      });
      if (candidate) candidates.push(candidate);
      if (candidates.length >= maximumResourcesPerItem) break;
    }
  }

  if (candidates.length < maximumResourcesPerItem) {
    const presentation = isRecord(input.payload.presentation) ? input.payload.presentation : {};
    for (const resource of [...recordArray(input.payload.deliverables), ...recordArray(presentation.deliverables)]) {
      const candidate = normalizeStructuredResource({
        sourceIndex: sourceIndex++,
        value: resource,
        projectRoot: input.projectRoot,
        trustedAttachmentRoots: input.trustedAttachmentRoots,
        assistantDelivery: true,
      });
      if (candidate) candidates.push(candidate);
      if (candidates.length >= maximumResourcesPerItem) break;
    }
  }

  if (candidates.length < maximumResourcesPerItem) {
    for (const resource of recordArray(input.payload.resources ?? input.payload.artifacts)) {
      const candidate = normalizeStructuredResource({
        sourceIndex: sourceIndex++,
        value: resource,
        projectRoot: input.projectRoot,
        trustedAttachmentRoots: input.trustedAttachmentRoots,
        assistantDelivery: resource.delivery === 'assistant' || resource.presentation === 'deliverable',
      });
      if (candidate) candidates.push(candidate);
      if (candidates.length >= maximumResourcesPerItem) break;
    }
  }

  return dedupeCandidates(candidates).map((candidate) => {
    const canonicalTargetDigest = digestResourceCandidate(candidate);
    return {
      id: stableResourceId(input.item.id, candidate.sourceIndex, canonicalTargetDigest),
      projectId: input.projectId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      itemId: input.item.id,
      sourceIndex: candidate.sourceIndex,
      canonicalTargetDigest,
      kind: candidate.kind,
      presentation: candidate.presentation,
      displayJson: JSON.stringify(displayForCandidate(candidate)),
      targetJson: JSON.stringify(targetForCandidate(candidate)),
      authorityJson: JSON.stringify(authorityForCandidate(candidate)),
    };
  });
}

/**
 * 助手最终答复引用的本地图片不能继续依赖 /tmp、任务 worktree 或 Provider 临时目录。
 * 资源投影完成时把图片复制进 Zeus 自管目录；目标身份由会话、item 与原始引用共同决定，
 * 后续即使来源已清理，也能从同一稳定位置恢复，而不会在重复水合时删除已归档图片。
 */
function normalizeArchivedAssistantMarkdownImage(input: {
  sourceIndex: number;
  label: string;
  href: string;
  conversationId: string;
  item: ZeusConversationItemRecord;
  archiveRoot?: string;
  sourceRoots: readonly string[];
  budget: { remainingBytes: number };
}): AttachmentResourceCandidate | null {
  if (!input.archiveRoot || input.item.itemType === 'userMessage' || input.item.status !== 'completed' || input.item.phase !== 'final_answer') return null;
  try {
    const sourcePath = localMarkdownImagePath(input.href);
    if (!sourcePath) return null;
    const sourceExtension = extname(sourcePath).toLocaleLowerCase();
    const expectedMimeType = supportedArchivedImageMimeType(sourceExtension);
    if (!expectedMimeType) return null;

    const archiveRoot = resolve(input.archiveRoot);
    const conversationDirectory = join(archiveRoot, 'assistant-markdown-images', createHash('sha256').update(input.conversationId).digest('hex').slice(0, 24));
    const sourceIdentity = createHash('sha256').update(`${input.item.id}\0${input.href}`).digest('hex');
    const destination = join(conversationDirectory, `${sourceIdentity}${sourceExtension}`);
    mkdirSync(conversationDirectory, { recursive: true, mode: 0o700 });
    const canonicalArchiveRoot = safeRealpath(archiveRoot);
    const canonicalConversationDirectory = safeRealpath(conversationDirectory);
    if (!canonicalArchiveRoot || !canonicalConversationDirectory || !isInsideRoot(canonicalConversationDirectory, canonicalArchiveRoot)) return null;

    const existingMimeType = archivedImageMimeType(destination);
    if (existingMimeType) {
      return archivedAssistantImageCandidate({ ...input, absolutePath: destination, allowedRoot: canonicalArchiveRoot, mimeType: existingMimeType });
    }

    const canonicalSource = safeRealpath(sourcePath);
    if (!canonicalSource || !resolveAuthorizedPath(canonicalSource, input.sourceRoots)) return null;
    const sourceStat = statSync(canonicalSource);
    if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > maximumArchivedAssistantImageBytes || sourceStat.size > input.budget.remainingBytes) return null;
    const sourceMimeType = generatedImageMimeType(canonicalSource);
    if (sourceMimeType !== expectedMimeType) return null;

    const bytes = readFileSync(canonicalSource);
    if (bytes.byteLength !== sourceStat.size) return null;
    const staging = join(conversationDirectory, `.${sourceIdentity}.${randomUUID()}.tmp`);
    try {
      writeFileSync(staging, bytes, { flag: 'wx', mode: 0o600 });
      chmodSync(staging, 0o600);
      syncPath(staging);
      try {
        linkSync(staging, destination);
        input.budget.remainingBytes -= bytes.byteLength;
      } catch (error) {
        if (!isFileExistsError(error)) throw error;
      }
    } finally {
      try {
        unlinkSync(staging);
      } catch {
        // 暂存文件可能尚未创建，或已经完成清理。
      }
    }
    syncPath(conversationDirectory);
    const archivedMimeType = archivedImageMimeType(destination);
    return archivedMimeType ? archivedAssistantImageCandidate({ ...input, absolutePath: destination, allowedRoot: canonicalArchiveRoot, mimeType: archivedMimeType }) : null;
  } catch {
    // 单张图片归档失败不能阻断会话正文或其他资源投影。
    return null;
  }
}

function archivedAssistantImageCandidate(input: { sourceIndex: number; label: string; absolutePath: string; allowedRoot: string; mimeType: string }): AttachmentResourceCandidate {
  return {
    kind: 'attachment',
    sourceIndex: input.sourceIndex,
    presentation: 'inline',
    origin: 'assistant_markdown_image',
    displayName: input.label,
    absolutePath: input.absolutePath,
    allowedRoot: input.allowedRoot,
    attachmentRef: basename(input.absolutePath),
    mimeType: input.mimeType,
    previewKind: 'image',
    iconKind: 'image',
  };
}

function localMarkdownImagePath(href: string): string | null {
  let reference = href.trim().replace(/^<|>$/gu, '');
  if (!reference || reference.includes('\0')) return null;
  if (/^file:/iu.test(reference)) {
    try {
      const url = new URL(reference);
      if (url.username || url.password || url.search || url.hash) return null;
      reference = fileURLToPath(url);
    } catch {
      return null;
    }
  } else {
    if (!isAbsolute(reference) || reference.includes('?') || reference.includes('#')) return null;
    try {
      reference = decodeURIComponent(reference);
    } catch {
      return null;
    }
  }
  return isAbsolute(reference) ? resolve(reference) : null;
}

function supportedArchivedImageMimeType(extension: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  return null;
}

function archivedImageMimeType(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumArchivedAssistantImageBytes) return null;
    return generatedImageMimeType(path);
  } catch {
    return null;
  }
}

function syncPath(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // fsync 是持久化强化；不支持目录 fsync 的文件系统仍可依赖原子 hard-link。
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/** 图片和音频二进制只保留会话恢复所需的元数据，避免 base64 进入数据库或 Renderer。 */
export function sanitizeConversationItemPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.type !== 'imageGeneration') return sanitizeRichPayloadValue(payload) as Record<string, unknown>;
  const allowedKeys = [
    'type',
    'id',
    'callId',
    'call_id',
    'status',
    'prompt',
    'revisedPrompt',
    'revised_prompt',
    'savedPath',
    'saved_path',
    'outputHint',
    'output_hint',
    'error',
    'message',
    'startedAt',
    'completedAt',
    'presentation',
  ] as const;
  return Object.fromEntries(allowedKeys.flatMap((key) => (Object.prototype.hasOwnProperty.call(payload, key) ? [[key, payload[key]]] : [])));
}

function sanitizeRichPayloadValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRichPayloadValue);
  if (!isRecord(value)) return value;
  const type = stringValue(value.type)?.toLocaleLowerCase();
  if (type && ['input_image', 'image', 'input_audio', 'audio'].includes(type)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['data', 'image_url', 'imageUrl', 'audio_url', 'audioUrl'].includes(key))
        .map(([key, entry]) => [key, sanitizeRichPayloadValue(entry)]),
    );
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeRichPayloadValue(entry)]));
}

function normalizeGeneratedImageResources(input: { sourceIndex: number; item: ZeusConversationItemRecord; payload: Record<string, unknown>; generatedImageRoot?: string }): AttachmentResourceCandidate[] {
  const generatedImageRoot = input.generatedImageRoot;
  if (input.item.status !== 'completed' || !generatedImageRoot || !input.item.providerThreadId) return [];
  const savedPaths: string[] = [];
  if (input.item.itemType === 'imageGeneration' || input.payload.type === 'imageGeneration') {
    const savedPath = stringValue(input.payload.savedPath ?? input.payload.saved_path);
    if (savedPath) savedPaths.push(savedPath);
  }

  const outputBlocks = richOutputBlocks(input.payload);
  const hasRenderedImage = outputBlocks.some((block) => ['input_image', 'image'].includes(stringValue(block.type)?.toLocaleLowerCase() ?? ''));
  if (hasRenderedImage) {
    const outputText = [stringValue(input.payload.outputHint ?? input.payload.output_hint), ...outputBlocks.map((block) => stringValue(block.text))].filter((value): value is string => Boolean(value)).join('\n');
    for (const match of outputText.matchAll(/Generated images are saved to [^\r\n]+ as (.+?) by default\./gu)) {
      const savedPath = match[1]?.trim();
      if (savedPath) savedPaths.push(savedPath);
    }
  }

  return [...new Set(savedPaths)].flatMap((savedPath, index) => {
    const candidate = normalizeGeneratedImagePath({ item: input.item, generatedImageRoot, sourceIndex: input.sourceIndex + index, savedPath });
    return candidate ? [candidate] : [];
  });
}

function richOutputBlocks(payload: Record<string, unknown>): Record<string, unknown>[] {
  return [payload.output, payload.result, payload.content].flatMap((value) => (Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : []));
}

function normalizeGeneratedImagePath(input: { sourceIndex: number; item: ZeusConversationItemRecord; generatedImageRoot: string; savedPath: string }): AttachmentResourceCandidate | null {
  if (!isAbsolute(input.savedPath)) return null;

  const generatedImageRoot = resolve(input.generatedImageRoot);
  const sessionRoot = resolve(generatedImageRoot, input.item.providerThreadId);
  if (!isInsideRoot(sessionRoot, generatedImageRoot) || sessionRoot === generatedImageRoot) return null;
  const resolved = resolveAuthorizedPath(input.savedPath, [sessionRoot]);
  if (!resolved) return null;

  let regularFile = false;
  try {
    regularFile = statSync(resolved.absolutePath).isFile();
  } catch {
    return null;
  }
  const mimeType = generatedImageMimeType(resolved.absolutePath);
  if (!regularFile || !mimeType) return null;
  const displayName = basename(resolved.absolutePath);
  return {
    kind: 'attachment',
    sourceIndex: input.sourceIndex,
    presentation: 'card',
    delivery: 'assistant',
    displayName,
    absolutePath: resolved.absolutePath,
    allowedRoot: resolved.allowedRoot,
    attachmentRef: displayName,
    mimeType,
    previewKind: 'image',
    iconKind: 'image',
  };
}

function generatedImageMimeType(path: string): string | null {
  const extension = extname(path).toLocaleLowerCase();
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, 'r');
    const header = Buffer.alloc(12);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    if (extension === '.png' && bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if ((extension === '.jpg' || extension === '.jpeg') && bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
    const asciiHeader = header.subarray(0, bytesRead).toString('ascii');
    if (extension === '.gif' && (asciiHeader.startsWith('GIF87a') || asciiHeader.startsWith('GIF89a'))) return 'image/gif';
    if (extension === '.webp' && bytesRead >= 12 && asciiHeader.startsWith('RIFF') && asciiHeader.slice(8, 12) === 'WEBP') return 'image/webp';
    return null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function normalizeFileChangeResource(input: { sourceIndex: number; path: string; projectRoot: string }): FileResourceCandidate | null {
  const parsedFile = parseFileReference(input.path, input.projectRoot);
  if (!parsedFile) return null;
  return {
    kind: 'file',
    sourceIndex: input.sourceIndex,
    presentation: 'inline',
    displayName: basename(parsedFile.absolutePath),
    absolutePath: parsedFile.absolutePath,
    projectRelativePath: parsedFile.projectRelativePath,
    projectRoot: parsedFile.projectRoot,
    allowedRoot: parsedFile.projectRoot,
    location: parsedFile.location,
    iconKind: iconKindForPath(parsedFile.absolutePath),
  };
}

function fileChangeResourcePaths(value: Record<string, unknown>): string[] {
  const kind = isRecord(value.kind) ? value.kind : {};
  return [stringValue(kind.move_path ?? kind.movePath), stringValue(value.path)].filter((path, index, paths): path is string => Boolean(path) && paths.indexOf(path) === index);
}

export function toConversationResource(record: ZeusConversationResourceRecord): ConversationResource | null {
  const display = parseJsonRecord(record.displayJson);
  const target = parseJsonRecord(record.targetJson);
  const base = {
    id: record.id,
    projectId: record.projectId,
    conversationId: record.conversationId,
    turnId: record.turnId,
    itemId: record.itemId,
    kind: record.kind,
    presentation: record.presentation,
    ...(display.delivery === 'assistant' ? { delivery: 'assistant' as const } : {}),
    displayName: stringValue(display.displayName) ?? 'Resource',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  } as const;
  if (record.kind === 'file') {
    const projectRelativePath = stringValue(display.projectRelativePath);
    const iconKind = fileIconKindValue(display.iconKind);
    if (!projectRelativePath || !iconKind) return null;
    const location = normalizeLocation(display.location);
    return {
      ...base,
      kind: 'file',
      projectRelativePath,
      iconKind,
      ...(location ? { location } : {}),
      ...(stringValue(display.mimeType) ? { mimeType: stringValue(display.mimeType)! } : {}),
    } satisfies ConversationFileResource;
  }
  if (record.kind === 'website') {
    const url = stringValue(target.url);
    const domain = stringValue(display.domain);
    if (!url || !domain) return null;
    return {
      ...base,
      kind: 'website',
      url,
      domain,
      local: display.local === true,
      ...(stringValue(display.title) ? { title: stringValue(display.title)! } : {}),
    } satisfies ConversationWebsiteResource;
  }
  const attachmentRef = stringValue(display.attachmentRef);
  const previewKind = display.previewKind === 'image' || display.previewKind === 'document' ? display.previewKind : 'none';
  const iconKind = fileIconKindValue(display.iconKind);
  if (!attachmentRef || !iconKind) return null;
  return {
    ...base,
    kind: 'attachment',
    attachmentRef,
    previewKind,
    iconKind,
    ...(stringValue(display.mimeType) ? { mimeType: stringValue(display.mimeType)! } : {}),
    ...(stringValue(display.taskPushAttachmentKey) ? { taskPushAttachmentKey: stringValue(display.taskPushAttachmentKey)! } : {}),
  } satisfies ConversationAttachmentResource;
}

export function toConversationResourceOpenIntent(record: ZeusConversationResourceRecord): ConversationResourceOpenIntent {
  return {
    id: record.id,
    projectId: record.projectId,
    conversationId: record.conversationId,
    turnId: record.turnId,
    itemId: record.itemId,
    kind: record.kind,
    presentation: record.presentation,
    display: parseJsonRecord(record.displayJson),
    target: parseJsonRecord(record.targetJson),
    authority: parseJsonRecord(record.authorityJson),
  };
}

/**
 * 变更审核只传递变更身份与项目相对路径；绝对路径和允许根只留在受信服务内。
 */
export function createConversationFileOpenGrant(input: {
  id: string;
  projectId: string;
  projectRoot: string;
  conversationId: string;
  turnId: string;
  itemId: string;
  projectRelativePath: string;
  now: string;
}): ConversationFileOpenGrant | null {
  const candidate = normalizeFileChangeResource({ sourceIndex: 0, path: input.projectRelativePath, projectRoot: input.projectRoot });
  if (!candidate) return null;
  const resource: ConversationFileResource = {
    id: input.id,
    projectId: input.projectId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    itemId: input.itemId,
    kind: 'file',
    presentation: 'inline',
    displayName: candidate.displayName,
    projectRelativePath: candidate.projectRelativePath,
    iconKind: candidate.iconKind,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return {
    resource,
    intent: {
      id: input.id,
      projectId: input.projectId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      itemId: input.itemId,
      kind: 'file',
      presentation: 'inline',
      display: displayForCandidate(candidate),
      target: targetForCandidate(candidate),
      authority: authorityForCandidate(candidate),
    },
  };
}

function normalizeLinkedResource(input: { sourceIndex: number; label: string; href: string; presentation: ConversationResourcePresentation; projectRoot: string }): ResourceCandidate | null {
  const website = normalizeWebsiteUrl(input.href);
  if (website) {
    return {
      kind: 'website',
      sourceIndex: input.sourceIndex,
      presentation: input.presentation,
      displayName: input.label,
      title: input.label,
      ...website,
    };
  }
  const parsedFile = parseFileReference(input.href, input.projectRoot);
  if (!parsedFile) return null;
  return {
    kind: 'file',
    sourceIndex: input.sourceIndex,
    presentation: input.presentation,
    displayName: input.label || basename(parsedFile.absolutePath),
    absolutePath: parsedFile.absolutePath,
    projectRelativePath: parsedFile.projectRelativePath,
    projectRoot: parsedFile.projectRoot,
    allowedRoot: parsedFile.projectRoot,
    location: parsedFile.location,
    iconKind: iconKindForPath(parsedFile.absolutePath),
  };
}

function localHtmlArtifactCard(candidate: ResourceCandidate, sourceIndex: number): FileResourceCandidate | null {
  if (candidate.kind !== 'file' || candidate.iconKind !== 'html') return null;
  return {
    ...candidate,
    sourceIndex,
    presentation: 'card',
    displayName: htmlDocumentTitle(candidate.absolutePath) ?? candidate.displayName,
  };
}

function htmlDocumentTitle(path: string): string | null {
  const maximumProbeBytes = 64 * 1_024;
  let descriptor: number | null = null;
  try {
    const size = statSync(path).size;
    if (size <= 0) return null;
    descriptor = openSync(path, 'r');
    const bytes = Buffer.allocUnsafe(Math.min(size, maximumProbeBytes));
    const readBytes = readSync(descriptor, bytes, 0, bytes.length, 0);
    const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/iu.exec(bytes.subarray(0, readBytes).toString('utf8'));
    if (!match?.[1]) return null;
    const title = decodeHtmlText(
      match[1]
        .replace(/<[^>]*>/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim(),
    );
    return title ? title.slice(0, 240) : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function decodeHtmlText(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu, (entity, decimal, hexadecimal, named) => {
    if (decimal) return safeCodePoint(Number(decimal), entity);
    if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16), entity);
    const entities: Record<string, string> = {
      amp: '&',
      apos: "'",
      gt: '>',
      lt: '<',
      nbsp: ' ',
      quot: '"',
    };
    return entities[String(named).toLocaleLowerCase()] ?? entity;
  });
}

function safeCodePoint(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return fallback;
  }
  return String.fromCodePoint(value);
}

function normalizeAttachmentResource(input: { sourceIndex: number; value: Record<string, unknown>; projectRoot: string; trustedAttachmentRoots: readonly string[] }): AttachmentResourceCandidate | null {
  const rawPath = stringValue(input.value.localPath ?? input.value.path ?? input.value.filePath);
  if (!rawPath) return null;
  const resolved = resolveExactAttachmentGrant(rawPath, stringValue(input.value.authorizedPath)) ?? resolveAuthorizedPath(rawPath, [input.projectRoot, ...input.trustedAttachmentRoots]);
  if (!resolved) return null;
  const mimeType = stringValue(input.value.mime ?? input.value.mimeType) ?? undefined;
  const displayName = stringValue(input.value.name) ?? basename(resolved.absolutePath);
  const taskPushAttachmentKey = stringValue(input.value.taskPushAttachmentKey) ?? undefined;
  return {
    kind: 'attachment',
    sourceIndex: input.sourceIndex,
    presentation: 'card',
    displayName,
    absolutePath: resolved.absolutePath,
    allowedRoot: resolved.allowedRoot,
    attachmentRef: displayName,
    ...(mimeType ? { mimeType } : {}),
    previewKind: previewKindForPath(resolved.absolutePath, mimeType),
    iconKind: iconKindForPath(resolved.absolutePath, mimeType),
    ...(taskPushAttachmentKey ? { taskPushAttachmentKey } : {}),
  };
}

function resolveExactAttachmentGrant(rawPath: string, authorizedPath: string | null): { absolutePath: string; allowedRoot: string } | null {
  if (!authorizedPath || rawPath.includes('\0') || authorizedPath.includes('\0')) return null;
  const absolutePath = resolve(rawPath);
  const exactPath = resolve(authorizedPath);
  const absoluteRealPath = safeRealpath(absolutePath);
  const exactRealPath = safeRealpath(exactPath);
  if (!absoluteRealPath || !exactRealPath || absoluteRealPath !== exactRealPath) return null;
  return { absolutePath: absoluteRealPath, allowedRoot: dirname(absoluteRealPath) };
}

function normalizeStructuredResource(input: { sourceIndex: number; value: Record<string, unknown>; projectRoot: string; trustedAttachmentRoots: readonly string[]; assistantDelivery?: boolean }): ResourceCandidate | null {
  const url = stringValue(input.value.url ?? input.value.href);
  if (url) {
    const website = normalizeWebsiteUrl(url);
    if (website) {
      const title = stringValue(input.value.title ?? input.value.name);
      return {
        kind: 'website',
        sourceIndex: input.sourceIndex,
        presentation: 'card',
        ...(input.assistantDelivery ? { delivery: 'assistant' as const } : {}),
        displayName: title ?? website.domain,
        ...(title ? { title } : {}),
        ...website,
      };
    }
  }
  const path = stringValue(input.value.localPath ?? input.value.path ?? input.value.filePath);
  if (!path) return null;
  const mimeType = stringValue(input.value.mime ?? input.value.mimeType) ?? undefined;
  const resolvedAttachment = resolveAuthorizedPath(path, input.trustedAttachmentRoots);
  if (resolvedAttachment) {
    return {
      kind: 'attachment',
      sourceIndex: input.sourceIndex,
      presentation: 'card',
      ...(input.assistantDelivery ? { delivery: 'assistant' as const } : {}),
      displayName: stringValue(input.value.title ?? input.value.name) ?? basename(resolvedAttachment.absolutePath),
      absolutePath: resolvedAttachment.absolutePath,
      allowedRoot: resolvedAttachment.allowedRoot,
      attachmentRef: stringValue(input.value.name) ?? basename(resolvedAttachment.absolutePath),
      ...(mimeType ? { mimeType } : {}),
      previewKind: previewKindForPath(resolvedAttachment.absolutePath, mimeType),
      iconKind: iconKindForPath(resolvedAttachment.absolutePath, mimeType),
    };
  }
  const parsedFile = parseFileReference(path, input.projectRoot);
  if (!parsedFile) return null;
  return {
    kind: 'file',
    sourceIndex: input.sourceIndex,
    presentation: 'card',
    ...(input.assistantDelivery ? { delivery: 'assistant' as const } : {}),
    displayName: stringValue(input.value.title ?? input.value.name) ?? basename(parsedFile.absolutePath),
    absolutePath: parsedFile.absolutePath,
    projectRelativePath: parsedFile.projectRelativePath,
    projectRoot: parsedFile.projectRoot,
    allowedRoot: parsedFile.projectRoot,
    location: parsedFile.location,
    ...(mimeType ? { mimeType } : {}),
    iconKind: iconKindForPath(parsedFile.absolutePath, mimeType),
  };
}

function parseFileReference(rawReference: string, projectRoot: string): { absolutePath: string; projectRelativePath: string; projectRoot: string; location?: ConversationFileLocation } | null {
  let reference = rawReference.trim();
  if (!reference || reference.includes('\0')) return null;
  let location: ConversationFileLocation | undefined;
  if (/^file:/iu.test(reference)) {
    try {
      const url = new URL(reference);
      location = locationFromHash(url.hash);
      url.hash = '';
      url.search = '';
      reference = fileURLToPath(url);
    } catch {
      return null;
    }
  } else {
    const hashIndex = reference.lastIndexOf('#');
    if (hashIndex >= 0) {
      location = locationFromHash(reference.slice(hashIndex));
      if (location) reference = reference.slice(0, hashIndex);
    }
    if (!location) {
      const suffix = /:(\d+)(?::(\d+))?$/u.exec(reference);
      if (suffix) {
        location = normalizeLocation({
          line: Number(suffix[1]),
          ...(suffix[2] ? { column: Number(suffix[2]) } : {}),
        });
        reference = reference.slice(0, suffix.index);
      }
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference) && !/^[A-Za-z]:[\\/]/u.test(reference)) {
    // Markdown URL schemes that are not explicitly authorized websites/files must
    // never be reinterpreted as project-relative paths.
    return null;
  }
  try {
    reference = decodeURIComponent(reference);
  } catch {
    return null;
  }
  const root = resolve(projectRoot);
  const absolutePath = resolve(isAbsolute(reference) ? reference : resolve(root, reference));
  if (!isInsideRoot(absolutePath, root) || absolutePath === root) return null;
  const authorized = resolveAuthorizedPath(absolutePath, [root]);
  if (!authorized) return null;
  const projectRelativePath = relative(root, absolutePath).split(sep).join('/');
  if (!projectRelativePath || projectRelativePath.startsWith('../')) return null;
  return {
    absolutePath,
    projectRelativePath,
    projectRoot: root,
    ...(location ? { location } : {}),
  };
}

function normalizeWebsiteUrl(rawUrl: string): { url: string; domain: string; local: boolean } | null {
  if (!rawUrl || rawUrl.length > maximumResourceUrlLength) return null;
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return null;
    if (url.protocol === 'mailto:') {
      const address = url.pathname.trim();
      if (!address) return null;
      return { url: url.href, domain: address, local: false };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    const host = url.hostname.toLocaleLowerCase();
    return {
      url: url.href,
      domain: url.host,
      local: host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]',
    };
  } catch {
    return null;
  }
}

function resolveAuthorizedPath(rawPath: string, roots: readonly string[]): { absolutePath: string; allowedRoot: string } | null {
  if (!rawPath || rawPath.includes('\0')) return null;
  const absolutePath = resolve(rawPath);
  for (const candidateRoot of roots) {
    if (!candidateRoot) continue;
    const allowedRoot = resolve(candidateRoot);
    if (!isInsideRoot(absolutePath, allowedRoot) || absolutePath === allowedRoot) continue;
    const rootRealPath = safeRealpath(allowedRoot);
    if (!rootRealPath) continue;
    let ancestor = absolutePath;
    while (true) {
      const ancestorRealPath = safeRealpath(ancestor);
      if (ancestorRealPath) {
        if (isInsideRoot(ancestorRealPath, rootRealPath)) return { absolutePath, allowedRoot };
        break;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  return null;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function markdownLinks(text: string): Array<{ label: string; href: string; image: boolean }> {
  const links: Array<{ label: string; href: string; image: boolean }> = [];
  let match: RegExpExecArray | null;
  markdownLinkPattern.lastIndex = 0;
  while ((match = markdownLinkPattern.exec(text))) {
    const label = (match[2] ?? '').trim();
    const href = (match[3] ?? '').trim().replace(/^<|>$/gu, '');
    if (label && href) links.push({ label, href, image: match[1] === '!' });
    if (links.length >= maximumResourcesPerItem) break;
  }
  return links;
}

function displayForCandidate(candidate: ResourceCandidate): Record<string, unknown> {
  const delivery = candidate.delivery === 'assistant' ? { delivery: candidate.delivery } : {};
  if (candidate.kind === 'file') {
    return {
      ...delivery,
      displayName: candidate.displayName,
      projectRelativePath: candidate.projectRelativePath,
      iconKind: candidate.iconKind,
      ...(candidate.location ? { location: candidate.location } : {}),
      ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
    };
  }
  if (candidate.kind === 'website') {
    return {
      ...delivery,
      displayName: candidate.displayName,
      domain: candidate.domain,
      local: candidate.local,
      ...(candidate.title ? { title: candidate.title } : {}),
    };
  }
  return {
    ...delivery,
    displayName: candidate.displayName,
    attachmentRef: candidate.attachmentRef,
    previewKind: candidate.previewKind,
    iconKind: candidate.iconKind,
    ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
    ...(candidate.taskPushAttachmentKey ? { taskPushAttachmentKey: candidate.taskPushAttachmentKey } : {}),
    ...(candidate.origin ? { origin: candidate.origin } : {}),
  };
}

function targetForCandidate(candidate: ResourceCandidate): Record<string, unknown> {
  if (candidate.kind === 'website') return { url: candidate.url };
  return {
    absolutePath: candidate.absolutePath,
    ...(candidate.kind === 'file' ? { projectRoot: candidate.projectRoot, projectRelativePath: candidate.projectRelativePath, location: candidate.location ?? null } : {}),
  };
}

function authorityForCandidate(candidate: ResourceCandidate): Record<string, unknown> {
  if (candidate.kind === 'website') return { allowedSchemes: ['http:', 'https:', 'mailto:'] };
  return { allowedRoot: candidate.allowedRoot };
}

function digestResourceCandidate(candidate: ResourceCandidate): string {
  return createHash('sha256')
    .update(JSON.stringify({ kind: candidate.kind, target: targetForCandidate(candidate) }))
    .digest('hex');
}

function stableResourceId(itemId: string, sourceIndex: number, digest: string): string {
  return `conversation_resource_${createHash('sha256').update(`${itemId}\0${sourceIndex}\0${digest}`).digest('hex').slice(0, 24)}`;
}

function dedupeCandidates(candidates: ResourceCandidate[]): ResourceCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.presentation}:${digestResourceCandidate(candidate)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function locationFromHash(hash: string): ConversationFileLocation | undefined {
  const match = /^#L(\d+)(?:-L?(\d+))?$/iu.exec(hash);
  if (!match) return undefined;
  return normalizeLocation({
    line: Number(match[1]),
    ...(match[2] ? { endLine: Number(match[2]) } : {}),
  });
}

function normalizeLocation(value: unknown): ConversationFileLocation | undefined {
  if (!isRecord(value)) return undefined;
  const line = positiveInteger(value.line);
  const column = positiveInteger(value.column);
  const endLine = positiveInteger(value.endLine);
  if (!line && !column && !endLine) return undefined;
  return {
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
    ...(endLine && (!line || endLine >= line) ? { endLine } : {}),
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function iconKindForPath(path: string, mimeType?: string): ConversationFileIconKind {
  const extension = extname(path).toLocaleLowerCase();
  if (mimeType?.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic'].includes(extension)) return 'image';
  if (mimeType === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (['.ts', '.tsx'].includes(extension)) return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'javascript';
  if (extension === '.java') return 'java';
  if (extension === '.json' || extension === '.jsonl') return 'json';
  if (['.md', '.mdx'].includes(extension)) return 'markdown';
  if (extension === '.sql') return 'sql';
  if (['.html', '.htm'].includes(extension)) return 'html';
  if (['.css', '.scss', '.sass', '.less'].includes(extension)) return 'css';
  if (['.xlsx', '.xls', '.csv', '.tsv'].includes(extension)) return 'spreadsheet';
  if (['.pptx', '.ppt', '.key'].includes(extension)) return 'presentation';
  if (['.docx', '.doc', '.rtf', '.pages', '.txt'].includes(extension)) return 'document';
  if (['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar'].includes(extension)) return 'archive';
  if (['.py', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.swift', '.kt', '.kts', '.scala', '.sh', '.zsh'].includes(extension)) return 'code';
  return 'file';
}

function previewKindForPath(path: string, mimeType?: string): 'image' | 'document' | 'none' {
  const iconKind = iconKindForPath(path, mimeType);
  if (iconKind === 'image') return 'image';
  if (['pdf', 'spreadsheet', 'presentation', 'document', 'markdown', 'html'].includes(iconKind)) return 'document';
  return 'none';
}

function fileIconKindValue(value: unknown): ConversationFileIconKind | null {
  const allowed: ConversationFileIconKind[] = ['code', 'java', 'javascript', 'typescript', 'json', 'markdown', 'sql', 'html', 'css', 'image', 'pdf', 'spreadsheet', 'presentation', 'document', 'archive', 'file'];
  return typeof value === 'string' && allowed.includes(value as ConversationFileIconKind) ? (value as ConversationFileIconKind) : null;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
