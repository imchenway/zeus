import type { NativeConversationAttachmentInput } from './codexNativeConversationContracts.js';

/** 正文或文件名无法形成标题时使用的任务占位。 */
export const localConversationPlaceholderTitle = '新任务';

/** 中文标题最多 20 字，其他语言最多 10 词且不超过 80 字符。 */
export function normalizeConversationTitle(text: string): string | null {
  /** 去掉模型常见的外层引号，长度按 Unicode 字符计算。 */
  const title = text
    .trim()
    .replace(/^["'“「『]|["'”」』]$/gu, '')
    .trim();
  return title && /[\p{L}\p{N}]/u.test(title) && (/\p{Script=Han}/u.test(title) ? [...title].length <= 20 : [...title].length <= 80 && title.split(/\s+/u).length <= 10) && !/[<>`\p{Cc}]/u.test(title) ? title : null;
}

/** 从用户原话或附件名提取临时标题，空值表示来源无法形成标题。 */
export function localConversationTitle(text: string, attachments: readonly { name: string }[] = []): string | null {
  /** 有正文时只取首个非空行，纯附件请求取首个有效文件名。 */
  const firstLine = text.split(/\r\n?|\n/u).find((line) => line.trim()) ?? attachments.find((attachment) => attachment.name.trim())?.name ?? '';
  /** 清除标记及控制字符，再执行分词和长度限制。 */
  const words = firstLine
    .replace(/[<>`\p{Cc}]/gu, ' ')
    .trim()
    .split(/\s+/u)
    .slice(0, 10)
    .join(' ');
  return normalizeConversationTitle([...words].slice(0, /\p{Script=Han}/u.test(words) ? 20 : 80).join(''));
}

/** 会话标题只取当前用户输入，不借 Provider 回显猜测。 */
export function projectNativeConversationTitle(prompt: string, attachments: NativeConversationAttachmentInput[] | undefined): string {
  const firstLine = prompt
    .split(/\r\n?|\n/u)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .find(Boolean);
  if (firstLine) return [...firstLine].slice(0, 48).join('');
  const attachmentName = attachments?.find((attachment) => attachment.name.trim())?.name.trim();
  if (attachmentName) return [...attachmentName].slice(0, 48).join('');
  throw Object.assign(new Error('Project conversation content or attachments are required.'), { code: 'ZEUS_INVALID_CONVERSATION_START' });
}
