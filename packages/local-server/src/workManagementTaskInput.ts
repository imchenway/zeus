import { isTaskAttachmentField, type TaskAttachmentReference } from '@zeus/shared';

/** 工作管理写入口共用的字段级附件规范化；只接受有限、可归属的本地引用。 */
export function normalizeWorkManagementTaskAttachments(value: unknown): TaskAttachmentReference[] | null {
  if (!Array.isArray(value) || value.length > 24) return null;
  const byPath = new Map<string, TaskAttachmentReference>();
  for (const rawAttachment of value) {
    if (!rawAttachment || typeof rawAttachment !== 'object' || Array.isArray(rawAttachment)) return null;
    const attachment = rawAttachment as Record<string, unknown>;
    const path = typeof attachment.path === 'string' ? attachment.path.trim() : '';
    const name = typeof attachment.name === 'string' ? attachment.name.trim() : '';
    const kind = attachment.kind;
    if (!path || !name || !isTaskAttachmentField(attachment.field) || (kind !== 'image' && kind !== 'file' && kind !== 'directory' && kind !== 'pasted_text')) return null;
    if (attachment.mimeType !== undefined && typeof attachment.mimeType !== 'string') return null;
    if (attachment.size !== undefined && (!Number.isSafeInteger(attachment.size) || Number(attachment.size) < 0)) return null;
    if (attachment.characterCount !== undefined && (!Number.isSafeInteger(attachment.characterCount) || Number(attachment.characterCount) < 0)) return null;
    byPath.set(path, {
      path,
      name,
      kind,
      field: attachment.field,
      ...(typeof attachment.mimeType === 'string' && attachment.mimeType.trim() ? { mimeType: attachment.mimeType.trim() } : {}),
      ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
      ...(typeof attachment.characterCount === 'number' ? { characterCount: attachment.characterCount } : {}),
    });
  }
  return Array.from(byPath.values());
}
