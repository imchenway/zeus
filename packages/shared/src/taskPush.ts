import type { TaskAttachmentField, TaskType } from './index.js';

export interface TaskPushPromptAttachment {
  key: string;
  field: TaskAttachmentField;
  name: string;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
  mimeType?: string;
  size?: number;
}

export interface TaskPushSupplementalAttachment {
  key: string;
  name: string;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
  mimeType?: string;
  size?: number;
}

/** 任务首发中可见的任务内容；运行配置不进入该契约。 */
export interface TaskPushPromptTaskContent {
  taskTitle: string;
  taskType: TaskType;
  taskDescription?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  tags?: string[];
  attachments?: TaskPushPromptAttachment[];
}

export interface TaskPushPromptParentContext extends TaskPushPromptTaskContent {
  taskId: string;
  taskCode: string;
  conversationPaths: string[];
}

export interface TaskPushPromptRelatedContext extends TaskPushPromptTaskContent {
  taskId: string;
  taskCode: string;
  conversationPaths: string[];
}

export interface TaskPushPromptInput extends TaskPushPromptTaskContent {
  taskId?: string;
  taskCode?: string;
  supplementalInfo?: string;
  supplementalAttachments?: TaskPushSupplementalAttachment[];
  parentContexts?: TaskPushPromptParentContext[];
  relatedContexts?: TaskPushPromptRelatedContext[];
}

export interface TaskPushContextConversationOption {
  id: string;
  title: string;
  createdAt: string;
  archived: boolean;
  path: string | null;
  available: boolean;
  unavailableReason: string | null;
}

export type TaskPushParentConversationOption = TaskPushContextConversationOption;

export interface TaskPushContextAttachmentOption extends TaskPushPromptAttachment {
  available: boolean;
  unavailableReason: string | null;
}

export type TaskPushParentAttachmentOption = TaskPushContextAttachmentOption;

export interface TaskPushContextOption extends TaskPushPromptTaskContent {
  taskId: string;
  taskCode: string;
  conversations: TaskPushContextConversationOption[];
  attachments: TaskPushContextAttachmentOption[];
}

/** 父任务顺序固定为根任务到直接父任务。 */
export interface TaskPushParentContextOption extends TaskPushContextOption {
  depth: number;
}

/** 关联任务按任务详情的稳定展示顺序返回。 */
export interface TaskPushRelatedContextOption extends TaskPushContextOption {
  updatedAt: string;
}

export interface TaskPushContextSelection {
  taskId: string;
  conversationIds: string[];
  attachmentKeys: string[];
}

export type TaskPushParentContextSelection = TaskPushContextSelection;
export type TaskPushRelatedContextSelection = TaskPushContextSelection;

export type TaskPushLayoutContextKind = 'current' | 'parent' | 'related';

export interface TaskPushLayoutField {
  field: TaskAttachmentField;
  label: string;
  text: string;
  attachmentKeys: string[];
}

export interface TaskPushLayoutTaskBlock {
  contextKind: TaskPushLayoutContextKind;
  taskId?: string;
  taskCode?: string;
  taskTitle: string;
  taskType: TaskType;
  taskTypeLabel: string;
  fields: TaskPushLayoutField[];
  attachments: TaskPushPromptAttachment[];
  conversationPaths: string[];
}

/** 排队、Provider 派发和已发消息共用的任务首发快照。 */
export interface TaskPushMessageLayout {
  kind: 'task_push';
  blocks: TaskPushLayoutTaskBlock[];
  supplementalInfo: string;
  supplementalAttachments: TaskPushSupplementalAttachment[];
}

export type TaskPushInputPart = { type: 'text'; text: string } | { type: 'attachment'; attachmentKey: string };

const taskTypeLabels: Record<TaskType, string> = {
  requirement: '需求',
  defect: '缺陷',
  optimization: '优化',
};

function taskContentFields(input: TaskPushPromptTaskContent): Array<{ field: TaskAttachmentField; label: string; text: string }> {
  return input.taskType === 'defect'
    ? [
        { field: 'defectCurrentState', label: '现状', text: input.defectCurrentState?.trim() ?? '' },
        { field: 'defectExpectedOutcome', label: '预期', text: input.defectExpectedOutcome?.trim() ?? '' },
        { field: 'defectReproductionSteps', label: '复现步骤', text: input.defectReproductionSteps?.trim() ?? '' },
      ]
    : input.taskType === 'optimization'
      ? [
          { field: 'optimizationCurrentState', label: '现状', text: input.optimizationCurrentState?.trim() ?? '' },
          { field: 'optimizationExpectedOutcome', label: '预期', text: input.optimizationExpectedOutcome?.trim() ?? '' },
        ]
      : [{ field: 'description', label: '需求描述', text: input.taskDescription?.trim() ?? '' }];
}

function activeTaskFields(input: TaskPushPromptTaskContent, attachmentKeysByField: Map<TaskAttachmentField, string[]>): Array<{ field: TaskAttachmentField; label: string; text: string }> {
  const typedFields = taskContentFields(input);
  return typedFields.filter((field) => field.text.length > 0 || (attachmentKeysByField.get(field.field)?.length ?? 0) > 0);
}

function buildTaskBlock(input: TaskPushPromptTaskContent & { contextKind: TaskPushLayoutContextKind; taskId?: string; taskCode?: string; conversationPaths?: string[] }): TaskPushLayoutTaskBlock {
  const contentFieldNames = new Set(taskContentFields(input).map((field) => field.field));
  const attachments = (input.attachments ?? []).filter((attachment) => contentFieldNames.has(attachment.field));
  const attachmentKeysByField = new Map<TaskAttachmentField, string[]>();
  for (const attachment of attachments) {
    const keys = attachmentKeysByField.get(attachment.field) ?? [];
    keys.push(attachment.key);
    attachmentKeysByField.set(attachment.field, keys);
  }
  const activeFields = activeTaskFields(input, attachmentKeysByField);
  return {
    contextKind: input.contextKind,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.taskCode ? { taskCode: input.taskCode } : {}),
    taskTitle: input.taskTitle.trim(),
    taskType: input.taskType,
    taskTypeLabel: taskTypeLabels[input.taskType],
    fields: activeFields.map((field) => ({ ...field, attachmentKeys: attachmentKeysByField.get(field.field) ?? [] })),
    attachments,
    conversationPaths: input.conversationPaths ?? [],
  };
}

export function buildTaskPushLayout(input: TaskPushPromptInput): TaskPushMessageLayout {
  return {
    kind: 'task_push',
    blocks: [
      buildTaskBlock({ ...input, contextKind: 'current' }),
      ...(input.parentContexts ?? []).map((context) => buildTaskBlock({ ...context, contextKind: 'parent' })),
      ...(input.relatedContexts ?? []).map((context) => buildTaskBlock({ ...context, contextKind: 'related' })),
    ],
    supplementalInfo: input.supplementalInfo?.trim() ?? '',
    supplementalAttachments: input.supplementalAttachments ?? [],
  };
}

function pushText(parts: TaskPushInputPart[], text: string): void {
  const previous = parts.at(-1);
  if (previous?.type === 'text') previous.text += text;
  else parts.push({ type: 'text', text });
}

function appendTaskBlockParts(parts: TaskPushInputPart[], block: TaskPushLayoutTaskBlock): void {
  if (block.contextKind === 'current') pushText(parts, `${block.taskTitle}\n`);
  else pushText(parts, `${block.contextKind === 'parent' ? '父任务' : '关联任务'}：${block.taskCode ?? block.taskId ?? ''} · ${block.taskTitle}\n`);
  for (const field of block.fields) {
    pushText(parts, `${field.label}：\n`);
    for (const attachmentKey of field.attachmentKeys) parts.push({ type: 'attachment', attachmentKey });
    pushText(parts, field.text ? `${field.text}\n` : '\n');
  }
  if (block.conversationPaths.length > 0) {
    pushText(parts, `会话文件路径：\n${block.conversationPaths.map((path) => `- ${path}`).join('\n')}\n`);
  }
}

export function buildTaskPushInputParts(layout: TaskPushMessageLayout): TaskPushInputPart[] {
  const parts: TaskPushInputPart[] = [];
  const current = layout.blocks.find((block) => block.contextKind === 'current');
  if (current) appendTaskBlockParts(parts, current);
  const supplementalAttachments = layout.supplementalAttachments ?? [];
  if (layout.supplementalInfo || supplementalAttachments.length > 0) {
    pushText(parts, `补充信息：${supplementalAttachments.length > 0 ? '\n' : ''}`);
    for (const attachment of supplementalAttachments) parts.push({ type: 'attachment', attachmentKey: attachment.key });
    if (layout.supplementalInfo) pushText(parts, `${layout.supplementalInfo}\n`);
  }
  const parents = layout.blocks.filter((block) => block.contextKind === 'parent');
  if (parents.length > 0) {
    pushText(parts, '\n父任务上下文：\n');
    parents.forEach((block, index) => {
      if (index > 0) pushText(parts, '\n');
      appendTaskBlockParts(parts, block);
    });
  }
  const related = layout.blocks.filter((block) => block.contextKind === 'related');
  if (related.length > 0) {
    pushText(parts, '\n关联任务上下文：\n');
    related.forEach((block, index) => {
      if (index > 0) pushText(parts, '\n');
      appendTaskBlockParts(parts, block);
    });
  }
  const last = parts.at(-1);
  if (last?.type === 'text') {
    last.text = last.text.trimEnd();
    if (!last.text) parts.pop();
  }
  return parts;
}

/** 纯文本投影只用于摘要与兼容显示；附件位置以布局快照为准。 */
export function renderTaskPushLayoutText(layout: TaskPushMessageLayout): string {
  return buildTaskPushInputParts(layout)
    .filter((part): part is Extract<TaskPushInputPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

export function buildTaskPushPrompt(input: TaskPushPromptInput): string {
  return renderTaskPushLayoutText(buildTaskPushLayout(input));
}
