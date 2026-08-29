import type { CodexAppServerEvent, CodexAppServerManager, CodexServerRequestResponse } from '@zeus/ai-runtime';
import type { BrowserAutomationPort } from './browserAutomation.js';
import type { ManagedConversationToolResultStore } from './conversationPortableContext.js';
import type { CodexProviderCommandApplicationService } from './codexProviderCommandApplication.js';
import type { ZeusConversationPluginRuntime } from './zeusConversationPluginRuntime.js';

interface CodexDynamicToolApplicationOptions {
  manager: Pick<CodexAppServerManager, 'respondToServerRequest'>;
  providerCommands: CodexProviderCommandApplicationService;
  toolResults: ManagedConversationToolResultStore;
  browserAutomation?: BrowserAutomationPort;
  plugins?: ZeusConversationPluginRuntime;
  findConversation(threadId: string): { id: string } | undefined;
  pluginContext(conversationId: string): { cwd: string; model: string; permissionMode: string } | null;
  requestPluginApproval(input: { conversationId: string; threadId: string; turnId: string; callId: string; generationId: string; namespace: string; tool: string; argumentKeys: string[] }): Promise<boolean>;
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
  conversation: { id: string } | undefined;
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
    if (input.options.plugins && input.namespace.startsWith('mcp__') && input.tool) {
      const pluginContext = input.options.pluginContext(input.conversation.id);
      if (!pluginContext) throw dynamicToolError('ZEUS_PLUGIN_CONVERSATION_CONTEXT_MISSING', 'The Plugin Host is not bound to this conversation context.');
      const catalog = await input.options.plugins.getCatalog(input.conversation.id);
      const tool = catalog.tools.find((candidate) => candidate.namespace === input.namespace && candidate.toolName === input.tool);
      if (!tool) throw dynamicToolError('ZEUS_PLUGIN_MCP_TOOL_NOT_FOUND', 'The requested MCP tool is not part of this conversation’s frozen Plugin snapshot.');
      const pre = await input.options.plugins.emitHook({
        event: 'PreToolUse',
        conversationId: input.conversation.id,
        cwd: pluginContext.cwd,
        model: pluginContext.model,
        turnId: input.turnId,
        permissionMode: pluginContext.permissionMode,
        payload: { tool_name: `${input.namespace}.${input.tool}`, tool_input: input.argumentsValue },
      });
      if (pre.permissionDecision === 'deny') throw dynamicToolError('ZEUS_PLUGIN_HOOK_TOOL_DENIED', pre.permissionDecisionReason ?? 'A Plugin Hook denied the MCP tool call.');
      const args = pre.updatedInput ?? input.argumentsValue;
      if (tool.approvalMode === 'prompt' && pre.permissionDecision !== 'allow') {
        const hookApproval = await input.options.plugins.emitHook({
          event: 'PermissionRequest',
          conversationId: input.conversation.id,
          cwd: pluginContext.cwd,
          model: pluginContext.model,
          turnId: input.turnId,
          permissionMode: pluginContext.permissionMode,
          payload: { tool_name: `${input.namespace}.${input.tool}`, tool_input: args },
        });
        if (hookApproval.permissionDecision === 'deny') throw dynamicToolError('ZEUS_PLUGIN_HOOK_PERMISSION_DENIED', hookApproval.permissionDecisionReason ?? 'A Plugin Hook denied MCP tool approval.');
        if (
          hookApproval.permissionDecision !== 'allow' &&
          !(await input.options.requestPluginApproval({
            conversationId: input.conversation.id,
            threadId: input.threadId,
            turnId: input.turnId,
            callId: input.callId,
            generationId: input.event.generationId,
            namespace: input.namespace,
            tool: input.tool,
            argumentKeys: Object.keys(args).sort(),
          }))
        ) {
          throw dynamicToolError('ZEUS_PLUGIN_MCP_TOOL_DECLINED', 'The user declined the Plugin MCP tool call.');
        }
      }
      const result = await input.options.plugins.invokeMcp({ conversationId: input.conversation.id, namespace: input.namespace, toolName: input.tool, args });
      const post = await input.options.plugins.emitHook({
        event: 'PostToolUse',
        conversationId: input.conversation.id,
        cwd: pluginContext.cwd,
        model: pluginContext.model,
        turnId: input.turnId,
        permissionMode: pluginContext.permissionMode,
        payload: { tool_name: `${input.namespace}.${input.tool}`, tool_input: args, tool_response: result.text },
      });
      const text = post.replaceToolResult ?? result.text;
      if (result.app) {
        input.options.broadcast('conversation.plugin_app.created', {
          conversationId: input.conversation.id,
          providerThreadId: input.threadId,
          providerTurnId: input.turnId,
          callId: input.callId,
          pluginId: tool.pluginId,
          pluginRevisionId: tool.pluginRevisionId,
          serverId: tool.serverId,
          toolName: tool.originalToolName,
          app: result.app,
          toolResult: { text: result.text, structuredContent: result.structuredContent, isError: result.isError },
        });
      }
      return dynamicToolResponse(input.event, [{ type: 'inputText', text }], !result.isError);
    }
    if (!input.options.browserAutomation) throw dynamicToolError('ZEUS_BROWSER_AUTOMATION_UNAVAILABLE', 'The built-in browser automation host is unavailable.');
    if (input.namespace !== 'zeus_browser' || !input.tool) throw dynamicToolError('ZEUS_BROWSER_TOOL_UNSUPPORTED', 'The requested dynamic tool is not owned by the Zeus browser namespace.');
    const result = await input.options.browserAutomation.invoke({
      conversationId: input.conversation.id,
      threadId: input.threadId,
      turnId: input.turnId,
      callId: input.callId,
      tool: input.tool,
      arguments: input.argumentsValue,
    });
    return dynamicToolResponse(input.event, result.contentItems, result.success);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return dynamicToolResponse(input.event, [{ type: 'inputText', text: `Zeus dynamic tool failed: ${detail.slice(0, 1200)}` }], false);
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
