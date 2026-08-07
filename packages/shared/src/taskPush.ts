import type { TaskType } from './index.js';

/** 子任务首发正文中可发送的任务字段；运行配置与附件不进入这段文本。 */
export interface TaskPushPromptTaskContent {
  taskTitle: string;
  taskType: TaskType;
  taskDescription?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
}

/** 用户显式选择后写入首发正文的单个祖先任务上下文。 */
export interface TaskPushPromptParentContext extends TaskPushPromptTaskContent {
  taskId: string;
  taskCode: string;
  conversationPaths: string[];
}

export interface TaskPushPromptInput extends TaskPushPromptTaskContent {
  supplementalInfo?: string;
  parentContexts?: TaskPushPromptParentContext[];
}

export interface TaskPushParentConversationOption {
  id: string;
  title: string;
  createdAt: string;
  archived: boolean;
  path: string | null;
  available: boolean;
  unavailableReason: string | null;
}

export interface TaskPushParentAttachmentOption {
  key: string;
  name: string;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
  mimeType?: string;
  size?: number;
  available: boolean;
  unavailableReason: string | null;
}

/** 弹窗中展示的祖先任务选项，顺序固定为根任务到直接父任务。 */
export interface TaskPushParentContextOption extends TaskPushPromptTaskContent {
  taskId: string;
  taskCode: string;
  depth: number;
  conversations: TaskPushParentConversationOption[];
  attachments: TaskPushParentAttachmentOption[];
}

export interface TaskPushParentContextSelection {
  taskId: string;
  conversationIds: string[];
  attachmentKeys: string[];
}

function appendTaskContent(lines: string[], input: TaskPushPromptTaskContent): void {
  lines.push(`任务标题：${input.taskTitle.trim()}`);
  if (input.taskType === 'defect') {
    lines.push('任务类型：缺陷', `现状：${input.defectCurrentState?.trim() || '未提供'}`, `预期：${input.defectExpectedOutcome?.trim() || '未提供'}`, `复现步骤：${input.defectReproductionSteps?.trim() || '未提供'}`);
  } else if (input.taskType === 'optimization') {
    lines.push('任务类型：优化', `现状：${input.optimizationCurrentState?.trim() || '未提供'}`, `预期：${input.optimizationExpectedOutcome?.trim() || '未提供'}`);
  } else {
    lines.push('任务类型：需求', `需求描述：${input.taskDescription?.trim() || '未提供'}`);
  }
}

/** 构造子任务首发正文；未选择祖先任务时保持既有正文逐字不变。 */
export function buildTaskPushPrompt(input: TaskPushPromptInput): string {
  const lines: string[] = [];
  appendTaskContent(lines, input);
  if (input.supplementalInfo?.trim()) lines.push(`补充信息：${input.supplementalInfo.trim()}`);
  const parentContexts = input.parentContexts ?? [];
  if (parentContexts.length === 0) return lines.join('\n');

  lines.push('', '父任务上下文：');
  for (const [index, parent] of parentContexts.entries()) {
    if (index > 0) lines.push('');
    lines.push(`父任务：${parent.taskCode.trim()} · ${parent.taskTitle.trim()}`);
    const parentLines: string[] = [];
    appendTaskContent(parentLines, parent);
    lines.push(...parentLines.slice(1));
    if (parent.conversationPaths.length > 0) {
      lines.push('会话文件路径：', ...parent.conversationPaths.map((path) => `- ${path}`));
    }
  }
  return lines.join('\n');
}
