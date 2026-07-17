import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

export type TaskClipboardAttachmentPayload = { name: string; type: string; data: ArrayBuffer };

type NativeClipboardImage = {
  isEmpty(): boolean;
  toPNG(): Uint8Array;
};

export type NativeTaskClipboardReader = {
  readImage(): NativeClipboardImage;
  availableFormats(): string[];
  readBuffer(format: string): Uint8Array;
  readText(): string;
  readHTML(): string;
};

export type TaskClipboardReadOptions = {
  readSystemFileReferences?: () => Promise<string[]>;
};

const fileReferenceClipboardFormats = ['public.file-url', 'text/uri-list', 'text/plain', 'public.utf8-plain-text', 'NSStringPboardType', 'NSFilenamesPboardType'] as const;
const maxDecodedClipboardReferenceBytes = 8 * 1024 * 1024;

const attachmentMimeTypesByExtension = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.bmp', 'image/bmp'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.log', 'text/plain'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.zip', 'application/zip'],
]);

const embeddedFileReferenceExtensions = Array.from(attachmentMimeTypesByExtension.keys())
  .map((extension) => extension.slice(1).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  .join('|');

const nativeClipboardImageFormats = new Map<string, { type: string; extension: string }>([
  ['public.png', { type: 'image/png', extension: 'png' }],
  ['png', { type: 'image/png', extension: 'png' }],
  ['image/png', { type: 'image/png', extension: 'png' }],
  ['public.jpeg', { type: 'image/jpeg', extension: 'jpg' }],
  ['public.jpg', { type: 'image/jpeg', extension: 'jpg' }],
  ['jpg', { type: 'image/jpeg', extension: 'jpg' }],
  ['jpeg', { type: 'image/jpeg', extension: 'jpg' }],
  ['image/jpeg', { type: 'image/jpeg', extension: 'jpg' }],
  ['public.tiff', { type: 'image/tiff', extension: 'tiff' }],
  ['image/tiff', { type: 'image/tiff', extension: 'tiff' }],
  ['public.gif', { type: 'image/gif', extension: 'gif' }],
  ['com.compuserve.gif', { type: 'image/gif', extension: 'gif' }],
  ['image/gif', { type: 'image/gif', extension: 'gif' }],
  ['public.webp', { type: 'image/webp', extension: 'webp' }],
  ['image/webp', { type: 'image/webp', extension: 'webp' }],
  ['public.heic', { type: 'image/heic', extension: 'heic' }],
  ['image/heic', { type: 'image/heic', extension: 'heic' }],
]);

export function coerceTaskClipboardAttachmentBuffer(data: unknown): Buffer | undefined {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

export function toTaskClipboardArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = Buffer.from(data);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

export function inferTaskClipboardAttachmentMimeType(filePath: string): string {
  return attachmentMimeTypesByExtension.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

export function buildTaskAttachmentPreviewDataUrl(data: Uint8Array, mimeType: string): string | undefined {
  if (!mimeType.toLowerCase().startsWith('image/') || data.byteLength === 0) return undefined;
  return `data:${mimeType};base64,${Buffer.from(data).toString('base64')}`;
}

export async function readTaskAttachmentFilePathPayloads(filePaths: string[], readBinaryFile: (filePath: string) => Promise<Uint8Array> = readFile): Promise<TaskClipboardAttachmentPayload[]> {
  const attachments: TaskClipboardAttachmentPayload[] = [];
  const seenFilePaths = new Set<string>();
  for (const filePath of filePaths) {
    const normalizedPath = filePath.trim();
    if (!normalizedPath || seenFilePaths.has(normalizedPath)) continue;
    seenFilePaths.add(normalizedPath);
    try {
      const fileData = await readBinaryFile(normalizedPath);
      attachments.push({
        name: basename(normalizedPath),
        type: inferTaskClipboardAttachmentMimeType(normalizedPath),
        data: toTaskClipboardArrayBuffer(fileData),
      });
    } catch {
      // 本地文件可能被移动、撤销授权或是目录；跳过坏项，不阻断其他可读附件。
    }
  }
  return attachments;
}

export function extractTaskClipboardFileReferences(values: Array<string | undefined | null>): string[] {
  const references = new Map<string, string>();
  for (const rawValue of values) {
    if (!rawValue) continue;
    const candidates = [...extractFileReferencesFromPlainText(rawValue), ...extractFileReferencesFromHtml(rawValue)];
    for (const candidate of candidates) {
      if (!references.has(candidate)) references.set(candidate, candidate);
    }
  }
  return Array.from(references.values());
}

export async function readTaskClipboardAttachmentsFromClipboard(reader: NativeTaskClipboardReader, options: TaskClipboardReadOptions = {}): Promise<TaskClipboardAttachmentPayload[]> {
  const clipboardTexts = readNativeClipboardReferenceTexts(reader);
  const systemFileReferences = await readSystemClipboardFileReferences(options);
  const fileReferenceAttachments = await readTaskClipboardFileReferenceAttachments(clipboardTexts, systemFileReferences);
  if (fileReferenceAttachments.length > 0) return fileReferenceAttachments;

  const inlineImageAttachments = extractTaskClipboardInlineImageAttachments(clipboardTexts);
  if (inlineImageAttachments.length > 0) return inlineImageAttachments;

  const imageAttachment = readTaskClipboardImageAttachment(reader.readImage());
  if (imageAttachment) return [imageAttachment];

  const nativeImageBufferAttachments = readNativeClipboardImageBufferAttachments(reader);
  if (nativeImageBufferAttachments.length > 0) return nativeImageBufferAttachments;

  return [];
}

async function readSystemClipboardFileReferences(options: TaskClipboardReadOptions): Promise<string[]> {
  if (!options.readSystemFileReferences) return [];
  try {
    return await options.readSystemFileReferences();
  } catch {
    // 系统剪贴板私有格式不可读时继续走 Electron 标准格式和 bitmap 回退。
    return [];
  }
}

async function readTaskClipboardFileReferenceAttachments(clipboardTexts: string[], systemFileReferences: string[]): Promise<TaskClipboardAttachmentPayload[]> {
  return readTaskAttachmentFilePathPayloads([...extractTaskClipboardFileReferences(clipboardTexts), ...systemFileReferences]);
}

function readNativeClipboardImageBufferAttachments(reader: NativeTaskClipboardReader): TaskClipboardAttachmentPayload[] {
  const attachments: TaskClipboardAttachmentPayload[] = [];
  for (const format of reader.availableFormats()) {
    const imageFormat = nativeClipboardImageFormats.get(format.toLowerCase());
    if (!imageFormat) continue;
    try {
      const data = reader.readBuffer(format);
      if (data.byteLength === 0) continue;
      attachments.push({
        name: `pasted-task-image-${Date.now()}-${attachments.length + 1}.${imageFormat.extension}`,
        type: imageFormat.type,
        data: toTaskClipboardArrayBuffer(data),
      });
    } catch {
      // 单个原生图片格式读取失败时继续尝试其他格式；避免一个私有格式阻断真实 PNG/JPEG。
    }
  }
  return attachments;
}

function extractTaskClipboardInlineImageAttachments(values: string[]): TaskClipboardAttachmentPayload[] {
  const attachments: TaskClipboardAttachmentPayload[] = [];
  const dataUrlPattern = /\b(?:src|href)\s*=\s*["']data:([^;,]+)(?:;charset=[^;,]+)?;base64,([^"']+)["']/giu;
  for (const value of values) {
    for (const match of value.matchAll(dataUrlPattern)) {
      const type = decodeHtmlEntities(match[1] ?? '')
        .trim()
        .toLowerCase();
      const encoded = decodeHtmlEntities(match[2] ?? '').replace(/\s+/gu, '');
      if (!type.startsWith('image/') || !encoded) continue;
      const extension = type.split('/')[1]?.replace(/[^a-z0-9]+/giu, '') || 'png';
      try {
        const data = Buffer.from(encoded, 'base64');
        if (data.byteLength === 0) continue;
        attachments.push({
          name: `pasted-task-inline-image-${Date.now()}-${attachments.length + 1}.${extension}`,
          type,
          data: toTaskClipboardArrayBuffer(data),
        });
      } catch {
        // 非法 data URL 跳过；普通文字粘贴由 renderer 兜底回填。
      }
    }
  }
  return attachments;
}

function readTaskClipboardImageAttachment(image: NativeClipboardImage): TaskClipboardAttachmentPayload | null {
  if (image.isEmpty()) return null;
  return {
    name: `pasted-task-screenshot-${Date.now()}.png`,
    type: 'image/png',
    data: toTaskClipboardArrayBuffer(image.toPNG()),
  };
}

function readNativeClipboardReferenceTexts(reader: NativeTaskClipboardReader): string[] {
  const values: string[] = [];
  const formats = new Set(reader.availableFormats());
  const decodedFormats = new Set<string>();
  try {
    const text = reader.readText();
    if (text) values.push(text);
  } catch {
    // 默认文本剪贴板在部分环境不可读时继续解析格式化 buffer。
  }
  for (const format of fileReferenceClipboardFormats) {
    if (!formats.has(format)) continue;
    try {
      const buffer = reader.readBuffer(format);
      decodedFormats.add(format);
      values.push(...decodeClipboardBuffer(buffer));
    } catch {
      // 无法读取的私有格式直接忽略；真正的 bitmap 已在 readImage 处理。
    }
  }
  for (const format of formats) {
    if (decodedFormats.has(format) || nativeClipboardImageFormats.has(format.toLowerCase())) continue;
    try {
      const buffer = reader.readBuffer(format);
      if (buffer.byteLength > maxDecodedClipboardReferenceBytes) continue;
      // Paste.app、Finder 和部分 macOS 来源会把 file:// 或 /Users/... 路径塞进私有/动态格式；
      // 这里只解码小块文本候选，真正的图片二进制仍由 readImage/native image formats 处理。
      values.push(...decodeClipboardBuffer(buffer));
    } catch {
      // 私有格式不保证可读；跳过即可，继续尝试其他格式和 HTML。
    }
  }
  try {
    const html = reader.readHTML();
    if (html) values.push(html);
  } catch {
    // Electron 在部分测试/运行环境可能没有 HTML clipboard，跳过即可。
  }
  return values;
}

function decodeClipboardBuffer(data: Uint8Array): string[] {
  if (data.byteLength === 0) return [];
  const buffer = Buffer.from(data);
  const utf8 = buffer.toString('utf8').replace(/\0/g, '').trim();
  const utf16le = buffer.toString('utf16le').replace(/\0/g, '').trim();
  return [utf8, utf16le].filter(Boolean);
}

function extractFileReferencesFromPlainText(value: string): string[] {
  const references = new Map<string, string>();
  const candidates = [
    ...value
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
    ...extractEmbeddedFileReferenceCandidates(value),
  ];
  for (const candidate of candidates) {
    for (const reference of fileReferenceToPath(candidate)) {
      if (!references.has(reference)) references.set(reference, reference);
    }
  }
  return Array.from(references.values());
}

function extractEmbeddedFileReferenceCandidates(value: string): string[] {
  const candidates: string[] = [];
  const fileUrlPattern = /\bfile:\/\/\/[^\s"'<>]+/giu;
  for (const match of value.matchAll(fileUrlPattern)) {
    candidates.push(match[0]);
  }
  const absolutePathPattern = new RegExp(`(?:^|[^\\w])((?:/(?:Users|Volumes|private|var|tmp|opt|Applications)/)[^\\0\\r\\n"'<>]*?\\.(?:${embeddedFileReferenceExtensions}))\\b`, 'giu');
  for (const match of value.matchAll(absolutePathPattern)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  return candidates;
}

function extractFileReferencesFromHtml(value: string): string[] {
  const references: string[] = [];
  const attributePattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/giu;
  for (const match of value.matchAll(attributePattern)) {
    references.push(...fileReferenceToPath(decodeHtmlEntities(match[1] ?? '')));
  }
  return references;
}

function fileReferenceToPath(value: string): string[] {
  const trimmed = value.trim().replace(/^["']|["']$/gu, '');
  if (!trimmed) return [];
  if (trimmed.startsWith('file://')) {
    try {
      return [fileURLToPath(trimmed)];
    } catch {
      return [];
    }
  }
  if (trimmed.startsWith('/')) {
    try {
      return [decodeURIComponent(trimmed)];
    } catch {
      return [trimmed];
    }
  }
  return [];
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>');
}
