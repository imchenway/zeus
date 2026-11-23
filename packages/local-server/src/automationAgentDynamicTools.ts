import type { CodexDynamicToolSpec } from '@zeus/ai-runtime';
import { parseJsonObject } from './localServerPlatformSupport.js';

/** 由宿主保存的操作归属，模型参数不能指定另一产品会话。 */
export interface AutomationAgentContext {
  /** 当前子任务负责的操作能力。 */
  capability: 'browser' | 'computer';
  /** 原会话继续持有标签页、登录状态和控制预览。 */
  ownerConversationId: string;
  /** 发起委派的父轮次；停止该轮次后不能自动续接。 */
  parentTurnId: string;
}

/** 从持久子会话归属读取操作能力及其主会话。 */
export function automationAgentContextFromRelation(relation: { contextJson: string } | undefined): AutomationAgentContext | null {
  const automation = relation ? parseJsonObject(relation.contextJson).automation : null;
  if (!automation || typeof automation !== 'object') return null;
  const { capability, ownerConversationId, parentTurnId } = automation as Partial<AutomationAgentContext>;
  if ((capability !== 'browser' && capability !== 'computer') || typeof ownerConversationId !== 'string' || typeof parentTurnId !== 'string') return null;
  return { capability, ownerConversationId, parentTurnId };
}

/** 操作模型委派复用现有子代理；工具立即返回接纳状态，不等待任务结束。 */
export function automationAgentDynamicTools(): CodexDynamicToolSpec[] {
  return [
    {
      type: 'namespace',
      name: 'zeus_automation',
      description:
        'Delegate browser or computer work to the configured operation model. Tasks run asynchronously as ordinary Zeus subagents and remain visible in the current conversation. After delegation, finish the current turn without a user-facing answer. Zeus shows task progress and automatically resumes the parent with the result. Give the user one consolidated answer after the result arrives. Do not poll or wait unless the user asks. Before operating, read settings; follow-conversation mode uses the normal tools directly. Use followup for corrections and stop for cancellation.',
      tools: [
        {
          type: 'function',
          name: 'settings',
          description: 'Read configured browser/computer models and whether this conversation is already an operation executor.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          type: 'function',
          name: 'delegate',
          description:
            'Start one complete browser or computer task using its configured model. Include the user goal, exact constraints, target browser/window, and completion criteria. Returns immediately after queue acceptance; execution results automatically resume this conversation. If user input or permission is needed, the executor must report a blocked result to the parent instead of waiting for user interaction inside its thread. Do not use native spawn_agent to bypass the configured model or tool ownership.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              capability: { type: 'string', enum: ['browser', 'computer'] },
              task_name: { type: 'string', minLength: 1, maxLength: 100 },
              message: { type: 'string', minLength: 1, maxLength: 100000 },
            },
            required: ['capability', 'task_name', 'message'],
          },
        },
        {
          type: 'function',
          name: 'followup',
          description: 'Forward a user correction or additional instruction to an existing operation agent. Input is queued on that agent and does not change its model.',
          inputSchema: { type: 'object', additionalProperties: false, properties: { target: { type: 'string', minLength: 1 }, message: { type: 'string', minLength: 1, maxLength: 100000 } }, required: ['target', 'message'] },
        },
        {
          type: 'function',
          name: 'list',
          description: 'Read operation agent identities, execution states and latest results. This is a status query, not a wait loop.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          type: 'function',
          name: 'stop',
          description: 'Stop an operation agent and its descendants; cancel queued instructions and preserve existing results.',
          inputSchema: { type: 'object', additionalProperties: false, properties: { target: { type: 'string', minLength: 1 } }, required: ['target'] },
        },
      ],
    },
  ];
}
