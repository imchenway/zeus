import { basename, extname, isAbsolute } from 'node:path';
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

/** 只有声明为文件列表的格式才授予文件读取语义；普通正文和 HTML 不隐式授权路径。 */
const fileReferenceClipboardFormats = ['public.file-url', 'text/uri-list', 'NSFilenamesPboardType'] as const;
const maxDecodedClipboardReferenceBytes = 8 * 1024 * 1024;
const supportedImageInputMimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

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

export function isSupportedImageInputMimeType(mimeType: string): boolean {
  return supportedImageInputMimeTypes.has(mimeType.trim().toLowerCase());
}

export function buildTaskAttachmentPreviewDataUrl(data: Uint8Array, mimeType: string): string | undefined {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (!isSupportedImageInputMimeType(normalizedMimeType) || data.byteLength === 0) return undefined;
  return `data:${normalizedMimeType};base64,${Buffer.from(data).toString('base64')}`;
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
  /** 标准格式已有文件引用时无需启动系统回退读取，避免每次粘贴都等待外部进程。 */
  const fileReferences = extractTaskClipboardFileReferences(clipboardTexts);
  if (fileReferences.length === 0) fileReferences.push(...extractTaskClipboardFileReferences(await readSystemClipboardFileReferences(options)));
  // Windows 的文件剪贴板图片可能只是资源管理器图标，必须保留原文件。
  if (process.platform !== 'win32' && isSingleUnsupportedImageReference(fileReferences)) {
    const normalizedImageAttachment = safelyReadTaskClipboardImageAttachment(reader);
    if (normalizedImageAttachment) return [normalizedImageAttachment];
  }
  const fileReferenceAttachments = await readTaskAttachmentFilePathPayloads(fileReferences);
  if (fileReferenceAttachments.length > 0) return fileReferenceAttachments;
  // Windows 禁止把资源管理器图标当附件；其他平台保持原有图片回退顺序。
  if (process.platform === 'win32' && fileReferences.length > 0) throw new Error('剪贴板引用的文件无法读取，请确认文件仍存在且具有访问权限。');

  const inlineImageAttachments = extractTaskClipboardInlineImageAttachments([safelyReadClipboardHtml(reader)]);
  if (inlineImageAttachments.length > 0) return inlineImageAttachments;

  const imageAttachment = safelyReadTaskClipboardImageAttachment(reader);
  if (imageAttachment) return [imageAttachment];

  const nativeImageBufferAttachments = readNativeClipboardImageBufferAttachments(reader);
  if (nativeImageBufferAttachments.length > 0) return nativeImageBufferAttachments;

  return [];
}

/** 返回剪贴板中的真实本地路径，不读取文件内容；会话附件借此保留目录和任意文件类型。 */
export async function readTaskClipboardFileReferencesFromClipboard(reader: NativeTaskClipboardReader, options: TaskClipboardReadOptions = {}): Promise<string[]> {
  const clipboardTexts = readNativeClipboardReferenceTexts(reader);
  /** Electron 能识别真实路径时直接授权；私有格式才需要系统读取。 */
  const fileReferences = extractTaskClipboardFileReferences(clipboardTexts);
  if (fileReferences.length === 0) fileReferences.push(...extractTaskClipboardFileReferences(await readSystemClipboardFileReferences(options)));
  if (process.platform !== 'win32' && isSingleUnsupportedImageReference(fileReferences) && hasReadableClipboardImage(reader)) return [];
  return fileReferences;
}

/** Windows 必须报告原生文件读取失败；其他平台沿用既有图片回退契约。 */
async function readSystemClipboardFileReferences(options: TaskClipboardReadOptions): Promise<string[]> {
  if (!options.readSystemFileReferences) return [];
  try {
    return await options.readSystemFileReferences();
  } catch (error) {
    // Windows 读取失败或超限不能伪装为无文件，避免把资源管理器图标当成原文件。
    if (process.platform === 'win32') throw error;
    return [];
  }
}

function isSingleUnsupportedImageReference(fileReferences: string[]): boolean {
  if (fileReferences.length !== 1) return false;
  const mimeType = inferTaskClipboardAttachmentMimeType(fileReferences[0] ?? '');
  return mimeType.startsWith('image/') && !isSupportedImageInputMimeType(mimeType);
}

function hasReadableClipboardImage(reader: NativeTaskClipboardReader): boolean {
  try {
    return !reader.readImage().isEmpty();
  } catch {
    return false;
  }
}

/** 立即读取剪贴板图片快照；无图片或格式不可读时返回空值。 */
export function safelyReadTaskClipboardImageAttachment(reader: NativeTaskClipboardReader): TaskClipboardAttachmentPayload | null {
  try {
    return readTaskClipboardImageAttachment(reader.readImage());
  } catch {
    return null;
  }
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

/** 只解码显式文件引用格式，其他私有格式及正文交由对应的图片或文本入口处理。 */
function readNativeClipboardReferenceTexts(reader: NativeTaskClipboardReader): string[] {
  /** 标准文件格式中的候选由路径解析器继续校验。 */
  const values: string[] = [];
  /** 一次读取格式列表，避免同轮读取中反复探测系统剪贴板。 */
  const formats = new Set(reader.availableFormats());
  for (const format of fileReferenceClipboardFormats) {
    if (!formats.has(format)) continue;
    try {
      /** 文件列表只允许有界元数据，不解码任意大块内容。 */
      const buffer = reader.readBuffer(format);
      if (buffer.byteLength > maxDecodedClipboardReferenceBytes) throw new Error('剪贴板文件列表超过大小限制。');
      values.push(...decodeClipboardBuffer(buffer));
    } catch {
      // 平台格式不可读时由现有系统文件列表读取处理，不猜测正文中的路径。
    }
  }
  return values;
}

/** HTML 只提供内联图片数据，不将其中的本地链接变成文件授权。 */
function safelyReadClipboardHtml(reader: NativeTaskClipboardReader): string {
  try {
    return reader.readHTML();
  } catch {
    return '';
  }
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
  for (const candidate of plainTextFileReferenceCandidates(value)) {
    for (const reference of fileReferenceToPath(candidate)) {
      if (!references.has(reference)) references.set(reference, reference);
    }
  }
  return Array.from(references.values());
}

/** 剪贴板纯文本里可能指向本地文件的候选：整行或以 file:// 链接内嵌在正文里。 */
function plainTextFileReferenceCandidates(value: string): string[] {
  return [
    ...value
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
    ...extractEmbeddedFileReferenceCandidates(value),
  ];
}

function extractEmbeddedFileReferenceCandidates(value: string): string[] {
  const candidates: string[] = [];
  // 只提取明确的 file:// 引用；不再从正文中抓取内嵌绝对路径，避免把日志里
  // <zeus_attachment> 描述的附件地址误当成待写入的文件附件。
  for (const match of value.matchAll(clipboardFileUrlPattern)) {
    candidates.push(match[0]);
  }
  return candidates;
}

/** 剪贴板正文里的 file:// 链接；附件识别与正文剥离共用同一条规则。 */
const clipboardFileUrlPattern = /\bfile:\/\/[^\s"'<>]+/giu;

/** 判断一段候选文本是否整段都已经变成附件，只有整段命中才允许从正文里移除。 */
function isConsumedFileReference(candidate: string, consumedPaths: ReadonlySet<string>): boolean {
  const references = fileReferenceToPath(candidate);
  return references.length > 0 && references.every((reference) => consumedPaths.has(reference));
}

/**
 * 计算剪贴板文字里没有被附件消费、仍应留在输入框的正文。
 * 粘贴“文件路径 + 文字说明”时，路径变成附件，说明文字必须留在原来的字段里。
 */
export function extractTaskClipboardResidualText(value: string, referencedPaths: readonly string[]): string {
  const consumedPaths = new Set(referencedPaths);
  return value
    .split(/\r?\n/gu)
    .filter((line) => !isConsumedFileReference(line.trim(), consumedPaths))
    .join('\n')
    .replace(clipboardFileUrlPattern, (match) => (isConsumedFileReference(match, consumedPaths) ? '' : match))
    .trim();
}

function extractFileReferencesFromHtml(value: string): string[] {
  const references: string[] = [];
  const attributePattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/giu;
  for (const match of value.matchAll(attributePattern)) {
    references.push(...fileReferenceToPath(decodeHtmlEntities(match[1] ?? '')));
  }
  return references;
}

/** 只把当前系统的绝对路径或合法文件 URL 识别为文件，保留普通正文。 */
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
  if (isAbsolute(trimmed)) {
    // Windows 文件列表提供原始路径，百分号是文件名内容，不是 URL 转义。
    if (process.platform === 'win32') return [trimmed];
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
