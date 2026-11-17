import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { filePreviewMime, filePreviewKind, filePreviewLimits, detectSourceLanguage, type ConversationResource, type ConversationResourcePreview, type FileReview } from '@zeus/shared';
import { getFileReview } from '@zeus/git-core';
import { toConversationResourceOpenIntent } from './conversationResources.js';

export function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

export function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 已授权文件的正文缓存；文件身份变化后重新读取，不保存会话或授权信息。 */
const previewBytes = new Map<string, { revision: string; size: number; read: Promise<Buffer> }>();
/** 原始正文最多保留 32 MiB，避免图片预览长期占用服务内存。 */
const previewCacheByteLimit = 32 * 1024 * 1024;

/** 复用同一磁盘版本的在途读取；授权和文件大小由调用方每次重新核对。 */
function readPreviewBytes(path: string, identity: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): Promise<Buffer> {
  const revision = `${identity.ino}:${identity.size}:${identity.mtimeMs}:${identity.ctimeMs}`;
  const cached = previewBytes.get(path);
  if (cached?.revision === revision) {
    previewBytes.delete(path);
    previewBytes.set(path, cached);
    return cached.read;
  }
  previewBytes.delete(path);
  const entry = {
    revision,
    size: identity.size,
    read: readFile(path).then(async (bytes) => {
      const current = await stat(path);
      if (bytes.byteLength !== identity.size || `${current.ino}:${current.size}:${current.mtimeMs}:${current.ctimeMs}` !== revision)
        throw Object.assign(new Error('文件正在变化，请重新读取预览。'), { code: 'ZEUS_CONVERSATION_RESOURCE_CHANGED' });
      return bytes;
    }),
  };
  previewBytes.set(path, entry);
  let retainedBytes = [...previewBytes.values()].reduce((total, value) => total + value.size, 0);
  for (const [key, value] of previewBytes) {
    if (retainedBytes <= previewCacheByteLimit && previewBytes.size <= 64) break;
    previewBytes.delete(key);
    retainedBytes -= value.size;
  }
  void entry.read.catch(() => {
    if (previewBytes.get(path) === entry) previewBytes.delete(path);
  });
  return entry.read;
}

/** 异步读取当前授权文件；缓存仅复用正文，不能跳过路径和大小校验。 */
export async function readConversationResourcePreview(resource: Exclude<ConversationResource, { kind: 'website' }>, intent: ReturnType<typeof toConversationResourceOpenIntent>): Promise<ConversationResourcePreview> {
  const absolutePath = typeof intent.target.absolutePath === 'string' ? resolve(intent.target.absolutePath) : '';
  const allowedRoot = typeof intent.authority.allowedRoot === 'string' ? resolve(intent.authority.allowedRoot) : '';
  if (!absolutePath || !allowedRoot || !isPathInsideRoot(absolutePath, allowedRoot) || absolutePath === allowedRoot) {
    throw Object.assign(new Error('Conversation resource path is outside its authorized root.'), { code: 'ZEUS_CONVERSATION_RESOURCE_FORBIDDEN' });
  }
  const [rootRealPath, fileRealPath] = await Promise.all([realpath(allowedRoot), realpath(absolutePath)]);
  if (!isPathInsideRoot(fileRealPath, rootRealPath)) {
    throw Object.assign(new Error('Conversation resource resolves outside its authorized root.'), { code: 'ZEUS_CONVERSATION_RESOURCE_FORBIDDEN' });
  }
  const fileStat = await stat(fileRealPath);
  if (!fileStat.isFile()) {
    throw Object.assign(new Error('Conversation resource is not a regular file.'), { code: 'ZEUS_CONVERSATION_RESOURCE_NOT_FILE' });
  }
  /** 以授权后的真实路径识别文件，跨消息复用标签，同时区分工作目录与附件副本。 */
  const fileIdentity = createHash('sha256').update(fileRealPath).digest('hex');
  const imageMimeType = conversationImageMimeType(fileRealPath);
  const maximumPreviewBytes = imageMimeType ? filePreviewLimits.image : filePreviewLimits.text;
  if (fileStat.size > maximumPreviewBytes) {
    throw Object.assign(new Error('Conversation resource is too large for the Zeus preview.'), { code: 'ZEUS_CONVERSATION_RESOURCE_TOO_LARGE' });
  }
  const bytes = await readPreviewBytes(fileRealPath, fileStat);
  if (imageMimeType) {
    return {
      kind: 'image',
      fileIdentity,
      resource,
      mimeType: imageMimeType,
      dataUrl: `data:${imageMimeType};base64,${bytes.toString('base64')}`,
      byteLength: bytes.byteLength,
    };
  }
  if (bytes.includes(0)) {
    throw Object.assign(new Error('Binary files cannot be rendered in the source preview.'), { code: 'ZEUS_CONVERSATION_RESOURCE_BINARY' });
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return {
    kind: 'source',
    fileIdentity,
    resource,
    language: sourceLanguageForPath(fileRealPath),
    content,
    lineCount: sourcePreviewLineCount(content),
    truncated: false,
    ...(resource.kind === 'file' && resource.location ? { location: resource.location } : {}),
  };
}

export function sourcePreviewLineCount(content: string): number {
  const normalized = content.replace(/\r\n?/gu, '\n');
  if (normalized === '') return 1;
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n').length;
}

/** 两类审阅在授权根内读取同一份 Git 状态，失败不阻断源码阅读。 */
export async function readConversationFileReview(resource: Exclude<ConversationResource, { kind: 'website' }>, intent: ReturnType<typeof toConversationResourceOpenIntent>): Promise<FileReview | undefined> {
  if (resource.kind !== 'file') return undefined;
  /** 行号来自登记资源，点击时可由渲染层覆盖本次定位。 */
  const review: FileReview = { location: resource.location };
  try {
    /** Git 读取前再次校验真实文件路径，拒绝符号链接逃逸。 */
    const [root, path] = await Promise.all([realpath(String(intent.authority.allowedRoot || '')), realpath(String(intent.target.absolutePath || ''))]);
    if (path === root || !isPathInsideRoot(path, root) || relative(root, path).split(sep).includes('.git')) throw new Error('文件不在允许审阅的目录内。');
    Object.assign(review, await getFileReview(path));
  } catch (error) {
    review.error = error instanceof Error ? error.message : 'Git 差异读取失败。';
  }
  return review;
}

/** 预览格式独立于模型图片输入格式，SVG 仅作为图片元素读取。 */
export function conversationImageMimeType(path: string): Extract<ConversationResourcePreview, { kind: 'image' }>['mimeType'] | null {
  const mime = filePreviewMime(path);
  return filePreviewKind(mime) === 'image' ? (mime as Extract<ConversationResourcePreview, { kind: 'image' }>['mimeType']) : null;
}

export function isPathInsideRoot(candidate: string, root: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

export function sourceLanguageForPath(path: string): ReturnType<typeof detectSourceLanguage> {
  return detectSourceLanguage(path);
}
