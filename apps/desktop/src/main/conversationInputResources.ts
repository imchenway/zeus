import {randomBytes, randomUUID} from 'node:crypto';
import {chmod, mkdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, isAbsolute, join, relative, resolve} from 'node:path';
import {createConversationAttachmentGrant, resolveConversationAttachmentGrant} from '@zeus/local-server';
import {
  buildTaskAttachmentPreviewDataUrl,
  coerceTaskClipboardAttachmentBuffer,
  inferTaskClipboardAttachmentMimeType,
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
} & ({localPath: string; uploadRef?: never} | {localPath?: never; uploadRef: string});

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
  materialize(payloads: ConversationResourcePayload[]): Promise<ConversationInputResource[]>;
  readClipboard(): Promise<{resources: ConversationInputResource[]; text: string}>;
  preview(resource: {localPath?: string; uploadRef?: string}): Promise<{previewUrl: string; mimeType: string} | null>;
}

export interface CreateConversationInputResourceBrokerOptions {
  attachmentRoot: string;
  grantSecret: string;
  clipboard: NativeTaskClipboardReader;
  clipboardReadOptions?: TaskClipboardReadOptions;
}

const maximumResourceCount = 100;
const maximumResourceBytes = 100 * 1024 * 1024;
const maximumBatchBytes = 256 * 1024 * 1024;
const longPasteThreshold = 5_000;
const maximumRestorableTextCharacters = 25_000;

export function createConversationInputResourceBroker(
  options: CreateConversationInputResourceBrokerOptions,
): ConversationInputResourceBroker {
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
            kind: directory ? 'directory' : mime.startsWith('image/') ? 'image' : 'file',
            source,
            uploadRef: createConversationAttachmentGrant(canonicalPath, options.grantSecret),
          });
        } catch {
          // 单个来源失效时保留同批次中的其他成功项。
        }
      }
      return resources;
    },

    async materialize(payloads) {
      await mkdir(attachmentRoot, {recursive: true, mode: 0o700});
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
        const filePath = join(attachmentRoot, `${Date.now()}-${randomUUID()}-${safeName}`);
        await writeFile(filePath, data, {mode: 0o600, flag: 'wx'});
        const mime = pastedText ? 'text/plain' : normalizeMime(payload.type, filePath);
        resources.push({
          name: safeName,
          mime,
          size: data.byteLength,
          kind: pastedText ? 'pasted_text' : mime.startsWith('image/') ? 'image' : 'file',
          source,
          ...(pastedText ? {characterCount: text?.length ?? 0} : {}),
          ...(pastedText && text !== undefined && text.length <= maximumRestorableTextCharacters ? {restorableText: text} : {}),
          localPath: filePath,
        });
      }
      return resources;
    },

    async readClipboard() {
      const referencedPaths = await readTaskClipboardFileReferencesFromClipboard(options.clipboard, options.clipboardReadOptions);
      if (referencedPaths.length > 0) {
        return {resources: await this.describePaths(referencedPaths, 'paste'), text: ''};
      }
      const binaryResources = await readTaskClipboardAttachmentsFromClipboard(options.clipboard, options.clipboardReadOptions);
      if (binaryResources.length > 0) {
        return {
          resources: await this.materialize(binaryResources.map((resource) => ({...resource, source: 'paste'}))),
          text: '',
        };
      }
      const text = safelyReadClipboardText(options.clipboard);
      if (text.length >= longPasteThreshold) {
        return {
          resources: await this.materialize([{name: 'Pasted text.txt', type: 'text/plain', text, source: 'paste', kind: 'pasted_text'}]),
          text: '',
        };
      }
      return {resources: [], text};
    },

    async preview(resource) {
      const resolvedPath = await resolvePreviewPath(resource, options.grantSecret, attachmentRoot);
      if (!resolvedPath) return null;
      const mimeType = inferTaskClipboardAttachmentMimeType(resolvedPath);
      if (!mimeType.startsWith('image/')) return null;
      const pathStat = await stat(resolvedPath);
      if (!pathStat.isFile() || pathStat.size > maximumResourceBytes) return null;
      const data = await readFile(resolvedPath);
      const previewUrl = buildTaskAttachmentPreviewDataUrl(data, mimeType);
      return previewUrl ? {previewUrl, mimeType} : null;
    },
  };
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

  await mkdir(dirname(resolvedPath), {recursive: true, mode: 0o700});
  const secret = randomBytes(32).toString('base64url');
  try {
    await writeFile(resolvedPath, `${secret}\n`, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
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

async function resolvePreviewPath(
  resource: {localPath?: string; uploadRef?: string},
  grantSecret: string,
  attachmentRoot: string,
): Promise<string | null> {
  const granted = typeof resource.uploadRef === 'string'
    ? resolveConversationAttachmentGrant(resource.uploadRef, grantSecret)
    : null;
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

/** 供 UI 只显示后缀时使用，避免 broker 退化成 picker filter。 */
export function conversationResourceExtension(name: string): string {
  return extname(name).toLocaleLowerCase();
}
