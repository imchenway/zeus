import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { filePreviewMime, filePreviewKind, filePreviewLimits, detectSourceLanguage, type ConversationResource, type ConversationResourcePreview } from '@zeus/shared';
import { toConversationResourceOpenIntent } from './conversationResources.js';

export function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

export function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function readConversationResourcePreview(resource: Exclude<ConversationResource, { kind: 'website' }>, intent: ReturnType<typeof toConversationResourceOpenIntent>): ConversationResourcePreview {
  const absolutePath = typeof intent.target.absolutePath === 'string' ? resolve(intent.target.absolutePath) : '';
  const allowedRoot = typeof intent.authority.allowedRoot === 'string' ? resolve(intent.authority.allowedRoot) : '';
  if (!absolutePath || !allowedRoot || !isPathInsideRoot(absolutePath, allowedRoot) || absolutePath === allowedRoot) {
    throw Object.assign(new Error('Conversation resource path is outside its authorized root.'), { code: 'ZEUS_CONVERSATION_RESOURCE_FORBIDDEN' });
  }
  const rootRealPath = realpathSync(allowedRoot);
  const fileRealPath = realpathSync(absolutePath);
  if (!isPathInsideRoot(fileRealPath, rootRealPath)) {
    throw Object.assign(new Error('Conversation resource resolves outside its authorized root.'), { code: 'ZEUS_CONVERSATION_RESOURCE_FORBIDDEN' });
  }
  const fileStat = statSync(fileRealPath);
  if (!fileStat.isFile()) {
    throw Object.assign(new Error('Conversation resource is not a regular file.'), { code: 'ZEUS_CONVERSATION_RESOURCE_NOT_FILE' });
  }
  const imageMimeType = conversationImageMimeType(fileRealPath);
  const maximumPreviewBytes = imageMimeType ? filePreviewLimits.image : filePreviewLimits.text;
  if (fileStat.size > maximumPreviewBytes) {
    throw Object.assign(new Error('Conversation resource is too large for the Zeus preview.'), { code: 'ZEUS_CONVERSATION_RESOURCE_TOO_LARGE' });
  }
  const bytes = readFileSync(fileRealPath);
  if (imageMimeType) {
    return {
      kind: 'image',
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
