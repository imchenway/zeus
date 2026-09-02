import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createConversationAttachmentGrant, resolveConversationAttachmentGrant } from '@zeus/local-server/conversation-attachment-grant';
import {
  buildTaskAttachmentPreviewDataUrl,
  coerceTaskClipboardAttachmentBuffer,
  inferTaskClipboardAttachmentMimeType,
  isSupportedImageInputMimeType,
  readTaskClipboardAttachmentsFromClipboard,
  readTaskClipboardFileReferencesFromClipboard,
  type NativeTaskClipboardReader,
  type TaskClipboardReadOptions,
} from './taskClipboard.js';

export type ConversationInputResourceSource = 'picker' | 'paste' | 'drop';
export type ConversationInputResourceKind = 'image' | 'file' | 'directory' | 'pasted_text';

export type ConversationInputResource = {
  name: string;
  mime: string;
  size: number;
  kind: ConversationInputResourceKind;
  source: ConversationInputResourceSource;
  characterCount?: number;
  restorableText?: string;
} & ({ localPath: string; uploadRef?: never } | { localPath?: never; uploadRef: string });

export interface ConversationResourcePayload {
  name?: string;
  type?: string;
  data?: ArrayBuffer | Uint8Array;
  text?: string;
  source?: ConversationInputResourceSource;
  kind?: ConversationInputResourceKind;
}

export interface ConversationInputResourceBroker {
  describePaths(paths: string[], source: ConversationInputResourceSource): Promise<ConversationInputResource[]>;
  materialize(payloads: ConversationResourcePayload[], commandId: string): Promise<ConversationInputResource[]>;
  readClipboard(commandId: string): Promise<{ resources: ConversationInputResource[]; text: string }>;
  resolve(resource: { localPath?: string; uploadRef?: string }): Promise<string | null>;
  preview(resource: { localPath?: string; uploadRef?: string }): Promise<{ previewUrl: string; mimeType: string } | null>;
  discard(resources: Array<{ localPath?: string; uploadRef?: string }>): Promise<{ discardedCount: number }>;
}

export interface CreateConversationInputResourceBrokerOptions {
  attachmentRoot: string;
  grantSecret: string;
  clipboard: NativeTaskClipboardReader;
  clipboardReadOptions?: TaskClipboardReadOptions;
  convertImagePathToPng?: (path: string) => Uint8Array | null;
}

const maximumResourceCount = 100;
const maximumResourceBytes = 100 * 1024 * 1024;
const maximumBatchBytes = 256 * 1024 * 1024;
const longPasteThreshold = 5_000;
const maximumRestorableTextCharacters = 25_000;

export function createConversationInputResourceBroker(options: CreateConversationInputResourceBrokerOptions): ConversationInputResourceBroker {
  const attachmentRoot = resolve(options.attachmentRoot);

  return {
    async describePaths(paths, source) {
      const resources: ConversationInputResource[] = [];
      const seen = new Set<string>();
      for (const path of paths.slice(0, maximumResourceCount)) {
        if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) continue;
        try {
          const canonicalPath = await realpath(path);
          if (seen.has(canonicalPath)) continue;
          seen.add(canonicalPath);
          const pathStat = await stat(canonicalPath);
          if (!pathStat.isFile() && !pathStat.isDirectory()) continue;
          const directory = pathStat.isDirectory();
          const mime = directory ? 'inode/directory' : inferTaskClipboardAttachmentMimeType(canonicalPath);
          resources.push({
            name: basename(canonicalPath) || canonicalPath,
            mime,
            size: directory ? 0 : pathStat.size,
            kind: directory ? 'directory' : isSupportedImageInputMimeType(mime) ? 'image' : 'file',
            source,
            uploadRef: createConversationAttachmentGrant(canonicalPath, options.grantSecret),
          });
        } catch {
          // 单个来源失效时保留同批次中的其他成功项。
        }
      }
      return resources;
    },

    async materialize(payloads, commandId) {
      await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
      const operationKey = commandResourceKey(commandId);
      const resources: ConversationInputResource[] = [];
      let batchBytes = 0;
      for (const [index, payload] of payloads.slice(0, maximumResourceCount).entries()) {
        const source = normalizeSource(payload.source);
        const text = typeof payload.text === 'string' ? payload.text : undefined;
        const data = text === undefined ? coerceTaskClipboardAttachmentBuffer(payload.data) : Buffer.from(text, 'utf8');
        if (!data || data.byteLength === 0 || data.byteLength > maximumResourceBytes || batchBytes + data.byteLength > maximumBatchBytes) continue;
        batchBytes += data.byteLength;
        const pastedText = text !== undefined || payload.kind === 'pasted_text';
        const safeName = sanitizeResourceName(payload.name || (pastedText ? 'Pasted text.txt' : `pasted-resource-${index + 1}`));
        const contentHash = createHash('sha256').update(data).digest('hex');
        const filePath = join(attachmentRoot, `${operationKey}-${index + 1}-${contentHash.slice(0, 16)}-${safeName}`);
        await writeAtomicResourceFile(filePath, data, contentHash);
        const mime = pastedText ? 'text/plain' : normalizeMime(payload.type, filePath);
        resources.push({
          name: safeName,
          mime,
          size: data.byteLength,
          kind: pastedText ? 'pasted_text' : isSupportedImageInputMimeType(mime) ? 'image' : 'file',
          source,
          ...(pastedText ? { characterCount: text?.length ?? 0 } : {}),
          ...(pastedText && text !== undefined && text.length <= maximumRestorableTextCharacters ? { restorableText: text } : {}),
          localPath: filePath,
        });
      }
      return resources;
    },

    async readClipboard(commandId) {
      const referencedPaths = await readTaskClipboardFileReferencesFromClipboard(options.clipboard, options.clipboardReadOptions);
      if (referencedPaths.length > 0) {
        return { resources: await this.describePaths(referencedPaths, 'paste'), text: '' };
      }
      const binaryResources = await readTaskClipboardAttachmentsFromClipboard(options.clipboard, options.clipboardReadOptions);
      if (binaryResources.length > 0) {
        return {
          resources: await this.materialize(
            binaryResources.map((resource) => ({ ...resource, source: 'paste' })),
            commandId,
          ),
          text: '',
        };
      }
      const text = safelyReadClipboardText(options.clipboard);
      if (text.length >= longPasteThreshold) {
        return {
          resources: await this.materialize([{ name: 'Pasted text.txt', type: 'text/plain', text, source: 'paste', kind: 'pasted_text' }], commandId),
          text: '',
        };
      }
      return { resources: [], text };
    },

    async resolve(resource) {
      return resolveInputResourcePath(resource, options.grantSecret, attachmentRoot);
    },

    async preview(resource) {
      const resolvedPath = await resolveInputResourcePath(resource, options.grantSecret, attachmentRoot);
      if (!resolvedPath) return null;
      const mimeType = inferTaskClipboardAttachmentMimeType(resolvedPath);
      if (!mimeType.startsWith('image/')) return null;
      const pathStat = await stat(resolvedPath);
      if (!pathStat.isFile() || pathStat.size > maximumResourceBytes) return null;
      const data = await readFile(resolvedPath);
      const previewUrl = buildTaskAttachmentPreviewDataUrl(data, mimeType);
      if (previewUrl) return { previewUrl, mimeType };
      const png = options.convertImagePathToPng?.(resolvedPath);
      const convertedPreviewUrl = png ? buildTaskAttachmentPreviewDataUrl(png, 'image/png') : undefined;
      return convertedPreviewUrl ? { previewUrl: convertedPreviewUrl, mimeType: 'image/png' } : null;
    },

    async discard(resources) {
      let discardedCount = 0;
      for (const resource of resources.slice(0, maximumResourceCount)) {
        // uploadRef 指向用户原文件，永远不由 Zeus 的草稿清理删除。
        if (resource.uploadRef || typeof resource.localPath !== 'string' || !isAbsolute(resource.localPath)) continue;
        try {
          const canonicalPath = await realpath(resource.localPath);
          const relativePath = relative(attachmentRoot, canonicalPath);
          if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) continue;
          const pathStat = await stat(canonicalPath);
          if (!pathStat.isFile()) continue;
          await rm(canonicalPath, { force: true });
          discardedCount += 1;
        } catch {
          // 资源已不存在或不属于托管根时保持安全无操作。
        }
      }
      return { discardedCount };
    },
  };
}

function commandResourceKey(commandId: string): string {
  if (typeof commandId !== 'string' || !commandId.trim() || commandId.length > 256 || commandId.includes('\0')) throw new TypeError('Conversation resource command identity is invalid.');
  return `command-${createHash('sha256').update(commandId).digest('hex').slice(0, 24)}`;
}

async function writeAtomicResourceFile(destination: string, data: Buffer, expectedSha256: string): Promise<void> {
  const existing = await readFile(destination).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (existing) {
    if (createHash('sha256').update(existing).digest('hex') !== expectedSha256) throw new Error('Conversation resource CAS destination contains different bytes.');
    return;
  }
  const temporaryPath = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      // hard-link 发布同时具备原子可见与 no-replace 语义；同 command 的并发只允许相同内容胜出。
      await link(temporaryPath, destination);
    } catch (error) {
      if (!isExistingFileError(error)) throw error;
      const concurrentWinner = await readFile(destination);
      if (createHash('sha256').update(concurrentWinner).digest('hex') !== expectedSha256) {
        throw new Error('Conversation resource CAS destination contains different bytes.');
      }
    }
    await unlink(temporaryPath);
    const directory = await open(dirname(destination), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function readOrCreateConversationAttachmentGrantSecret(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  try {
    const existing = (await readFile(resolvedPath, 'utf8')).trim();
    if (existing.length >= 43) {
      await chmod(resolvedPath, 0o600);
      return existing;
    }
    throw new Error('Conversation attachment grant secret is invalid.');
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  await mkdir(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('base64url');
  try {
    await writeFile(resolvedPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return secret;
  } catch (error) {
    if (!isExistingFileError(error)) throw error;
    const existing = (await readFile(resolvedPath, 'utf8')).trim();
    if (existing.length < 43) throw new Error('Conversation attachment grant secret is invalid.');
    await chmod(resolvedPath, 0o600);
    return existing;
  }
}

function normalizeSource(value: unknown): ConversationInputResourceSource {
  return value === 'picker' || value === 'drop' ? value : 'paste';
}

function normalizeMime(value: unknown, filePath: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : inferTaskClipboardAttachmentMimeType(filePath);
}

function sanitizeResourceName(value: string): string {
  const safeName = basename(value)
    .replace(/[^\p{L}\p{N}._ ()[\]-]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
  return safeName || 'pasted-resource';
}

async function resolveInputResourcePath(resource: { localPath?: string; uploadRef?: string }, grantSecret: string, attachmentRoot: string): Promise<string | null> {
  const granted = typeof resource.uploadRef === 'string' ? resolveConversationAttachmentGrant(resource.uploadRef, grantSecret) : null;
  const requested = granted ?? (typeof resource.localPath === 'string' ? resource.localPath : '');
  if (!requested || !isAbsolute(requested) || requested.includes('\0')) return null;
  try {
    const canonicalPath = await realpath(requested);
    if (granted) return canonicalPath === granted ? canonicalPath : null;
    const root = await realpath(attachmentRoot);
    const delta = relative(root, canonicalPath);
    return delta && !delta.startsWith('..') && !isAbsolute(delta) ? canonicalPath : null;
  } catch {
    return null;
  }
}

function safelyReadClipboardText(reader: NativeTaskClipboardReader): string {
  try {
    return reader.readText();
  } catch {
    return '';
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isExistingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}
