export type TaskAttachmentKind = 'image' | 'file';

export interface TaskAttachmentView {
  path: string;
  name: string;
  kind: TaskAttachmentKind;
  mimeType?: string;
  previewUrl?: string;
}

export type PersistedTaskAttachment = Pick<TaskAttachmentView, 'path' | 'name' | 'kind' | 'mimeType'>;

function inferAttachmentName(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? path;
}

export function normalizeTaskAttachment(rawAttachment: unknown): TaskAttachmentView | undefined {
  if (!rawAttachment || typeof rawAttachment !== 'object' || Array.isArray(rawAttachment)) return undefined;
  const attachment = rawAttachment as Record<string, unknown>;
  const path = typeof attachment.path === 'string' ? attachment.path.trim() : '';
  if (!path) return undefined;
  const kind = attachment.kind === 'image' ? 'image' : 'file';
  const name = typeof attachment.name === 'string' && attachment.name.trim() ? attachment.name.trim() : inferAttachmentName(path);
  const mimeType = typeof attachment.mimeType === 'string' && attachment.mimeType.trim() ? attachment.mimeType.trim() : undefined;
  const previewUrl = typeof attachment.previewUrl === 'string' && attachment.previewUrl.startsWith('data:image/') ? attachment.previewUrl : undefined;
  return { path, name, kind, mimeType, previewUrl };
}

export function toPersistedTaskAttachment(attachment: TaskAttachmentView): PersistedTaskAttachment {
  return {
    path: attachment.path,
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
  };
}

export function parseTaskSourceContextJson(sourceContextJson?: string): Record<string, unknown> {
  if (!sourceContextJson) return {};
  try {
    const parsed = JSON.parse(sourceContextJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseTaskAttachments(sourceContextJson?: string): TaskAttachmentView[] {
  const sourceContext = parseTaskSourceContextJson(sourceContextJson);
  const attachments = Array.isArray(sourceContext.attachments) ? sourceContext.attachments : [];
  return attachments
    .map(normalizeTaskAttachment)
    .filter((attachment): attachment is TaskAttachmentView => Boolean(attachment))
    .slice(0, 24);
}

export function mergeTaskAttachments(existing: TaskAttachmentView[], additions: TaskAttachmentView[]): PersistedTaskAttachment[] {
  const byPath = new Map<string, TaskAttachmentView>();
  for (const attachment of existing) byPath.set(attachment.path, attachment);
  for (const attachment of additions) byPath.set(attachment.path, attachment);
  return Array.from(byPath.values()).map(toPersistedTaskAttachment);
}

export function buildTaskSourceContextWithAttachments(sourceContextJson: string | undefined, additions: TaskAttachmentView[]): Record<string, unknown> | undefined {
  if (additions.length === 0) return undefined;
  const sourceContext = parseTaskSourceContextJson(sourceContextJson);
  return {
    ...sourceContext,
    attachments: mergeTaskAttachments(parseTaskAttachments(sourceContextJson), additions),
  };
}
