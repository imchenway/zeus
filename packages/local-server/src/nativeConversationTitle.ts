import type { NativeConversationAttachmentInput } from './codexNativeConversationContracts.js';

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
