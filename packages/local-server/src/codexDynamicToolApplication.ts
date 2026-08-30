import type { CodexAppServerEvent, CodexAppServerManager, CodexServerRequestResponse } from '@zeus/ai-runtime';
import type { ManagedConversationToolResultStore } from './conversationPortableContext.js';
import type { CodexProviderCommandApplicationService } from './codexProviderCommandApplication.js';
import { isZeusNativeToolMutation, type ZeusToolBroker } from './zeusToolRegistry.js';

interface CodexDynamicToolApplicationOptions {
  manager: Pick<CodexAppServerManager, 'respondToServerRequest'>;
  providerCommands: CodexProviderCommandApplicationService;
  toolResults: ManagedConversationToolResultStore;
  toolBroker?: ZeusToolBroker;
  findConversation(threadId: string): { id: string; permissionMode?: string } | undefined;
  broadcast(event: string, payload: Record<string, unknown>): void;
  now(): string;
}

/** 动态工具先完成本地计算，再以单一、可审计的 server-request response 写入 Provider。 */
export function createCodexDynamicToolApplication(options: CodexDynamicToolApplicationOptions) {
  return async (event: CodexAppServerEvent): Promise<void> => {
    if (event.requestId === undefined) return;
    const requestEvent: CodexAppServerEvent & { requestId: NonNullable<CodexAppServerEvent['requestId']> } = { ...event, requestId: event.requestId };
    const params = isRecord(event.params) ? event.params : {};
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const callId = stringValue(params.callId);
    const namespace = stringValue(params.namespace);
    const tool = stringValue(params.tool);
    const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
    const conversation = threadId ? options.findConversation(threadId) : undefined;
    if (!threadId || !turnId) {
      options.broadcast('conversation.native.error', {
        ...(conversation ? { conversationId: conversation.id } : {}),
        providerThreadId: threadId || null,
        providerTurnId: turnId || null,
        error: 'ZEUS_BROWSER_TOOL_CONTEXT_INVALID',
        message: 'Codex dynamic tool request lacks auditable native session or turn identity.',
      });
      return;
    }

    const response = await resolveResponse({
      options,
      conversation,
      threadId,
      turnId,
      callId,
      namespace,
      tool,
      argumentsValue,
      event: requestEvent,
    });
    try {
      await options.providerCommands.executeTurn({
        operation: 'server_request_response',
        commandKey: `dynamic-tool:${event.generationId}:${JSON.stringify(requestEvent.requestId)}`,
        scope: { kind: 'turn', id: turnId },
        idempotencyKey: `dynamic-tool:${event.generationId}:${JSON.stringify(requestEvent.requestId)}`,
        issuedAt: event.receivedAt,
        resourceId: conversation?.id ?? threadId,
        requestIdentity: response,
        providerGenerationId: event.generationId,
        invoke: (traceIdentity) => options.manager.respondToServerRequest({ ...response, traceIdentity }),
        nativeSessionId: threadId,
        nativeTurnId: () => turnId,
      });
    } catch (error) {
      options.broadcast('conversation.native.error', {
        ...(conversation ? { conversationId: conversation.id } : {}),
        providerThreadId: threadId,
        providerTurnId: turnId,
        error: 'ZEUS_BROWSER_TOOL_RESPONSE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

async function resolveResponse(input: {
  options: CodexDynamicToolApplicationOptions;
  conversation: { id: string; permissionMode?: string } | undefined;
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string;
  tool: string;
  argumentsValue: Record<string, unknown>;
  event: CodexAppServerEvent & { requestId: NonNullable<CodexAppServerEvent['requestId']> };
}): Promise<CodexServerRequestResponse> {
  try {
    if (!input.conversation || !input.callId) throw dynamicToolError('ZEUS_BROWSER_TOOL_CONTEXT_INVALID', 'The browser tool call is not attached to a durable Zeus conversation.');
    if ((!input.namespace || input.namespace === 'zeus') && input.tool === 'read_conversation_tool_result') {
      const page = await input.options.toolResults.readPage({
        conversationId: input.conversation.id,
        handle: requiredString(input.argumentsValue.handle, 'tool result handle'),
        offset: nonNegativeInteger(input.argumentsValue.offset, 0),
        limit: positiveBoundedInteger(input.argumentsValue.limit, 16_384, 16_384),
      });
      return dynamicToolResponse(input.event, [{ type: 'inputText', text: JSON.stringify(page) }], true);
    }
    if (!input.options.toolBroker) throw dynamicToolError('ZEUS_NATIVE_AUTOMATION_UNAVAILABLE', 'The Zeus native automation host is unavailable.');
    if (!input.tool || (input.namespace !== 'zeus_browser' && input.namespace !== 'zeus_computer')) {
      throw dynamicToolError('ZEUS_NATIVE_TOOL_UNSUPPORTED', 'The requested dynamic tool is not owned by a Zeus native automation namespace.');
    }
    if (input.conversation.permissionMode === 'read-only' && isZeusNativeToolMutation(input.namespace, input.tool, input.argumentsValue)) {
      throw dynamicToolError('ZEUS_NATIVE_TOOL_READ_ONLY', '当前会话是只读模式，已拒绝 Browser 或 Computer 交互。');
    }
    const result = await input.options.toolBroker.invoke({
      conversationId: input.conversation.id,
      threadId: input.threadId,
      turnId: input.turnId,
      callId: input.callId,
      namespace: input.namespace,
      tool: input.tool,
      arguments: input.argumentsValue,
    });
    return dynamicToolResponse(input.event, result.contentItems, result.success);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return dynamicToolResponse(input.event, [{ type: 'inputText', text: `Zeus native tool failed: ${detail.slice(0, 1200)}` }], false);
  }
}

function dynamicToolResponse(
  event: CodexAppServerEvent & { requestId: NonNullable<CodexAppServerEvent['requestId']> },
  contentItems: Extract<CodexServerRequestResponse, { type: 'dynamic_tool' }>['contentItems'],
  success: boolean,
): Extract<CodexServerRequestResponse, { type: 'dynamic_tool' }> {
  return { generationId: event.generationId, requestId: event.requestId, type: 'dynamic_tool', contentItems, success };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw dynamicToolError('ZEUS_BROWSER_TOOL_ARGUMENT_INVALID', `Missing ${label}.`);
  return value;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return value === undefined ? fallback : Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function positiveBoundedInteger(value: unknown, fallback: number, maximum: number): number {
  return value === undefined ? fallback : Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(Number(value), maximum) : fallback;
}

function dynamicToolError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
