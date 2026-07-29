import {createHash} from 'node:crypto';
import {closeSync, openSync, readSync, realpathSync, statSync} from 'node:fs';
import {basename, dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {
  ConversationAttachmentResource,
  ConversationFileIconKind,
  ConversationFileLocation,
  ConversationFileResource,
  ConversationResource,
  ConversationResourcePresentation,
  ConversationWebsiteResource,
} from '@zeus/shared';
import type {ZeusConversationItemRecord, ZeusConversationResourceRecord} from '@zeus/storage';

interface ResourceCandidateBase {
  sourceIndex: number;
  presentation: ConversationResourcePresentation;
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

const markdownLinkPattern = /\[([^\]\n]+)\]\(([^)\n]+)\)/gu;
const maximumResourceUrlLength = 8_192;
const maximumResourcesPerItem = 128;

export function normalizeConversationResources(
  input: NormalizeConversationResourcesInput,
): Array<Omit<ZeusConversationResourceRecord, 'createdAt' | 'updatedAt'>> {
  const candidates: ResourceCandidate[] = [];
  let sourceIndex = 0;

  for (const link of markdownLinks(input.text)) {
    const candidate = normalizeLinkedResource({
      sourceIndex: sourceIndex++,
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
    for (const resource of recordArray(input.payload.resources ?? input.payload.artifacts)) {
      const candidate = normalizeStructuredResource({
        sourceIndex: sourceIndex++,
        value: resource,
        projectRoot: input.projectRoot,
        trustedAttachmentRoots: input.trustedAttachmentRoots,
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

function normalizeFileChangeResource(input: {
  sourceIndex: number;
  path: string;
  projectRoot: string;
}): FileResourceCandidate | null {
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
  return [
    stringValue(kind.move_path ?? kind.movePath),
    stringValue(value.path),
  ].filter((path, index, paths): path is string => Boolean(path) && paths.indexOf(path) === index);
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
      ...(location ? {location} : {}),
      ...(stringValue(display.mimeType) ? {mimeType: stringValue(display.mimeType)!} : {}),
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
      ...(stringValue(display.title) ? {title: stringValue(display.title)!} : {}),
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
    ...(stringValue(display.mimeType) ? {mimeType: stringValue(display.mimeType)!} : {}),
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

function normalizeLinkedResource(input: {
  sourceIndex: number;
  label: string;
  href: string;
  presentation: ConversationResourcePresentation;
  projectRoot: string;
}): ResourceCandidate | null {
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

function localHtmlArtifactCard(
  candidate: ResourceCandidate,
  sourceIndex: number,
): FileResourceCandidate | null {
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
    const title = decodeHtmlText(match[1].replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim());
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

function normalizeAttachmentResource(input: {
  sourceIndex: number;
  value: Record<string, unknown>;
  projectRoot: string;
  trustedAttachmentRoots: readonly string[];
}): AttachmentResourceCandidate | null {
  const rawPath = stringValue(input.value.localPath ?? input.value.path ?? input.value.filePath);
  if (!rawPath) return null;
  const resolved =
    resolveExactAttachmentGrant(rawPath, stringValue(input.value.authorizedPath)) ??
    resolveAuthorizedPath(rawPath, [input.projectRoot, ...input.trustedAttachmentRoots]);
  if (!resolved) return null;
  const mimeType = stringValue(input.value.mime ?? input.value.mimeType) ?? undefined;
  const displayName = stringValue(input.value.name) ?? basename(resolved.absolutePath);
  return {
    kind: 'attachment',
    sourceIndex: input.sourceIndex,
    presentation: 'card',
    displayName,
    absolutePath: resolved.absolutePath,
    allowedRoot: resolved.allowedRoot,
    attachmentRef: displayName,
    ...(mimeType ? {mimeType} : {}),
    previewKind: previewKindForPath(resolved.absolutePath, mimeType),
    iconKind: iconKindForPath(resolved.absolutePath, mimeType),
  };
}

function resolveExactAttachmentGrant(
  rawPath: string,
  authorizedPath: string | null,
): {absolutePath: string; allowedRoot: string} | null {
  if (!authorizedPath || rawPath.includes('\0') || authorizedPath.includes('\0')) return null;
  const absolutePath = resolve(rawPath);
  const exactPath = resolve(authorizedPath);
  const absoluteRealPath = safeRealpath(absolutePath);
  const exactRealPath = safeRealpath(exactPath);
  if (!absoluteRealPath || !exactRealPath || absoluteRealPath !== exactRealPath) return null;
  return {absolutePath: absoluteRealPath, allowedRoot: dirname(absoluteRealPath)};
}

function normalizeStructuredResource(input: {
  sourceIndex: number;
  value: Record<string, unknown>;
  projectRoot: string;
  trustedAttachmentRoots: readonly string[];
}): ResourceCandidate | null {
  const url = stringValue(input.value.url ?? input.value.href);
  if (url) {
    const website = normalizeWebsiteUrl(url);
    if (website) {
      const title = stringValue(input.value.title ?? input.value.name);
      return {
        kind: 'website',
        sourceIndex: input.sourceIndex,
        presentation: 'card',
        displayName: title ?? website.domain,
        ...(title ? {title} : {}),
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
      displayName: stringValue(input.value.title ?? input.value.name) ?? basename(resolvedAttachment.absolutePath),
      absolutePath: resolvedAttachment.absolutePath,
      allowedRoot: resolvedAttachment.allowedRoot,
      attachmentRef: stringValue(input.value.name) ?? basename(resolvedAttachment.absolutePath),
      ...(mimeType ? {mimeType} : {}),
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
    displayName: stringValue(input.value.title ?? input.value.name) ?? basename(parsedFile.absolutePath),
    absolutePath: parsedFile.absolutePath,
    projectRelativePath: parsedFile.projectRelativePath,
    projectRoot: parsedFile.projectRoot,
    allowedRoot: parsedFile.projectRoot,
    location: parsedFile.location,
    ...(mimeType ? {mimeType} : {}),
    iconKind: iconKindForPath(parsedFile.absolutePath, mimeType),
  };
}

function parseFileReference(
  rawReference: string,
  projectRoot: string,
): {absolutePath: string; projectRelativePath: string; projectRoot: string; location?: ConversationFileLocation} | null {
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
          ...(suffix[2] ? {column: Number(suffix[2])} : {}),
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
    ...(location ? {location} : {}),
  };
}

function normalizeWebsiteUrl(rawUrl: string): {url: string; domain: string; local: boolean} | null {
  if (!rawUrl || rawUrl.length > maximumResourceUrlLength) return null;
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return null;
    if (url.protocol === 'mailto:') {
      const address = url.pathname.trim();
      if (!address) return null;
      return {url: url.href, domain: address, local: false};
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

function resolveAuthorizedPath(rawPath: string, roots: readonly string[]): {absolutePath: string; allowedRoot: string} | null {
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
        if (isInsideRoot(ancestorRealPath, rootRealPath)) return {absolutePath, allowedRoot};
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

function markdownLinks(text: string): Array<{label: string; href: string}> {
  const links: Array<{label: string; href: string}> = [];
  let match: RegExpExecArray | null;
  markdownLinkPattern.lastIndex = 0;
  while ((match = markdownLinkPattern.exec(text))) {
    const label = (match[1] ?? '').trim();
    const href = (match[2] ?? '').trim().replace(/^<|>$/gu, '');
    if (label && href) links.push({label, href});
    if (links.length >= maximumResourcesPerItem) break;
  }
  return links;
}

function displayForCandidate(candidate: ResourceCandidate): Record<string, unknown> {
  if (candidate.kind === 'file') {
    return {
      displayName: candidate.displayName,
      projectRelativePath: candidate.projectRelativePath,
      iconKind: candidate.iconKind,
      ...(candidate.location ? {location: candidate.location} : {}),
      ...(candidate.mimeType ? {mimeType: candidate.mimeType} : {}),
    };
  }
  if (candidate.kind === 'website') {
    return {
      displayName: candidate.displayName,
      domain: candidate.domain,
      local: candidate.local,
      ...(candidate.title ? {title: candidate.title} : {}),
    };
  }
  return {
    displayName: candidate.displayName,
    attachmentRef: candidate.attachmentRef,
    previewKind: candidate.previewKind,
    iconKind: candidate.iconKind,
    ...(candidate.mimeType ? {mimeType: candidate.mimeType} : {}),
  };
}

function targetForCandidate(candidate: ResourceCandidate): Record<string, unknown> {
  if (candidate.kind === 'website') return {url: candidate.url};
  return {
    absolutePath: candidate.absolutePath,
    ...(candidate.kind === 'file' ? {projectRoot: candidate.projectRoot, projectRelativePath: candidate.projectRelativePath, location: candidate.location ?? null} : {}),
  };
}

function authorityForCandidate(candidate: ResourceCandidate): Record<string, unknown> {
  if (candidate.kind === 'website') return {allowedSchemes: ['http:', 'https:', 'mailto:']};
  return {allowedRoot: candidate.allowedRoot};
}

function digestResourceCandidate(candidate: ResourceCandidate): string {
  return createHash('sha256')
    .update(JSON.stringify({kind: candidate.kind, target: targetForCandidate(candidate)}))
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
    ...(match[2] ? {endLine: Number(match[2])} : {}),
  });
}

function normalizeLocation(value: unknown): ConversationFileLocation | undefined {
  if (!isRecord(value)) return undefined;
  const line = positiveInteger(value.line);
  const column = positiveInteger(value.column);
  const endLine = positiveInteger(value.endLine);
  if (!line && !column && !endLine) return undefined;
  return {
    ...(line ? {line} : {}),
    ...(column ? {column} : {}),
    ...(endLine && (!line || endLine >= line) ? {endLine} : {}),
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
  const allowed: ConversationFileIconKind[] = [
    'code',
    'java',
    'javascript',
    'typescript',
    'json',
    'markdown',
    'sql',
    'html',
    'css',
    'image',
    'pdf',
    'spreadsheet',
    'presentation',
    'document',
    'archive',
    'file',
  ];
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
