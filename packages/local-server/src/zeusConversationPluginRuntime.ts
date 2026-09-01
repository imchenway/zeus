import { join } from 'node:path';
import type { CodexDynamicToolSpec, PiDynamicToolSpec } from '@zeus/ai-runtime';
import type { SecretStore } from '@zeus/security-core';
import type { CodexBootstrapAdditionalContext } from '@zeus/shared';
import { createZeusPluginHookRuntime, type ZeusPluginHookEvent, type ZeusPluginHookEventResult, type ZeusPluginHookRuntime } from './zeusPluginHookRuntime.js';
import { createZeusPluginMcpBroker, type ZeusPluginDynamicTool, type ZeusPluginMcpBroker, type ZeusPluginMcpCatalog, type ZeusPluginMcpToolResult } from './zeusPluginMcpBroker.js';
import type { PluginActivationSnapshot, ZeusPluginService } from './zeusPluginService.js';

export interface ZeusPluginConversationPreparation {
  activations: PluginActivationSnapshot[];
  skills: Array<{ id: string; name: string; description: string; path: string }>;
  mcp: ZeusPluginMcpCatalog;
  codexDynamicTools: CodexDynamicToolSpec[];
  piDynamicTools: PiDynamicToolSpec[];
  developerInstructions: string;
  sessionStart: ZeusPluginHookEventResult;
}

export interface ZeusConversationPluginRuntime {
  bindExplicitReferences(input: { conversationId: string; projectId: string; references: Array<{ kind: 'plugin' | 'skill'; id: string }> }): void;
  prepare(input: {
    conversationId: string;
    projectId: string;
    cwd: string;
    model: string;
    source: 'startup' | 'resume' | 'clear' | 'compact';
    prompt?: string;
    explicitReferences?: Array<{ kind: 'plugin' | 'skill'; id: string }>;
  }): Promise<ZeusPluginConversationPreparation>;
  getActivations(conversationId: string): Promise<PluginActivationSnapshot[]>;
  getCatalog(conversationId: string): Promise<ZeusPluginMcpCatalog>;
  invokeMcp(input: { conversationId: string; namespace?: string | null; toolName: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult>;
  invokeAppMcp(input: { conversationId: string; pluginId: string; serverId: string; toolName: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult>;
  beforeUserPrompt(input: { conversationId: string; prompt: unknown; turnId?: string | null; permissionMode?: string }): Promise<CodexBootstrapAdditionalContext | undefined>;
  emitHook(event: ZeusPluginHookEvent): Promise<ZeusPluginHookEventResult>;
  observeConversationEvent(type: string, payload: Record<string, unknown>): Promise<void>;
  closeConversation(input: { conversationId: string; cwd: string; model: string; reason: string }): Promise<void>;
  close(): Promise<void>;
}

export function createZeusConversationPluginRuntime(options: {
  service: ZeusPluginService;
  dataRoot: string;
  runtimeRoot: string;
  secretStore: Pick<SecretStore, 'getSecret'>;
  dangerouslyBypassHookTrust?: boolean;
  publish?: (type: string, payload: Record<string, unknown>) => void;
  requestContinuation?: (input: { conversationId: string; sourceTurnId: string | null; prompt: string }) => Promise<void>;
}): ZeusConversationPluginRuntime {
  const contexts = new Map<string, { projectId: string; cwd: string; model: string; explicitReferences: Array<{ kind: 'plugin' | 'skill'; id: string }> }>();
  const pendingReferences = new Map<string, { projectId: string; references: Array<{ kind: 'plugin' | 'skill'; id: string }> }>();
  const prepared = new Map<string, Promise<ZeusPluginConversationPreparation>>();
  const stopHookActive = new Set<string>();
  const getActivations = async (conversationId: string): Promise<PluginActivationSnapshot[]> => {
    const context = contexts.get(conversationId);
    if (!context) throw runtimeError('ZEUS_PLUGIN_CONVERSATION_CONTEXT_MISSING', 'Plugin Host 尚未绑定该 Zeus 会话。');
    return options.service.getOrFreezeConversationActivations({
      conversationId,
      projectId: context.projectId,
      explicitReferences: context.explicitReferences,
    });
  };
  const broker: ZeusPluginMcpBroker = createZeusPluginMcpBroker({
    dataRoot: options.dataRoot,
    getActivations,
    secretStore: options.secretStore,
    publish: options.publish,
  });
  const hooks: ZeusPluginHookRuntime = createZeusPluginHookRuntime({
    runtimeRoot: options.runtimeRoot,
    dataRoot: options.dataRoot,
    getActivations,
    executeMcpTool: (input) => broker.invokeHook(input),
    dangerouslyBypassTrust: options.dangerouslyBypassHookTrust === true,
    publish: options.publish,
  });

  async function prepare(input: {
    conversationId: string;
    projectId: string;
    cwd: string;
    model: string;
    source: 'startup' | 'resume' | 'clear' | 'compact';
    prompt?: string;
    explicitReferences?: Array<{ kind: 'plugin' | 'skill'; id: string }>;
  }): Promise<ZeusPluginConversationPreparation> {
    const existing = contexts.get(input.conversationId);
    if (existing && (existing.projectId !== input.projectId || existing.cwd !== input.cwd)) {
      throw runtimeError('ZEUS_PLUGIN_CONVERSATION_IDENTITY_MISMATCH', 'Plugin 会话上下文与已冻结身份不一致。');
    }
    const pendingReference = pendingReferences.get(input.conversationId);
    if (pendingReference && pendingReference.projectId !== input.projectId) throw runtimeError('ZEUS_PLUGIN_CONVERSATION_IDENTITY_MISMATCH', 'Plugin 结构化引用与会话项目不一致。');
    const explicitReferences =
      input.explicitReferences ??
      (existing ? existing.explicitReferences : pendingReference ? pendingReference.references : input.prompt ? await options.service.resolveExplicitReferences({ projectId: input.projectId, text: input.prompt }) : []);
    pendingReferences.delete(input.conversationId);
    contexts.set(input.conversationId, {
      projectId: input.projectId,
      cwd: input.cwd,
      model: input.model,
      explicitReferences,
    });
    const cached = prepared.get(input.conversationId);
    if (cached) return cached;
    const pending = buildPreparation(input).catch((error) => {
      prepared.delete(input.conversationId);
      throw error;
    });
    prepared.set(input.conversationId, pending);
    return pending;
  }

  async function buildPreparation(input: { conversationId: string; projectId: string; cwd: string; model: string; source: 'startup' | 'resume' | 'clear' | 'compact' }): Promise<ZeusPluginConversationPreparation> {
    const activations = await getActivations(input.conversationId);
    const mcp = await broker.listTools(input.conversationId);
    const sessionStart = await hooks.emit({
      event: 'SessionStart',
      conversationId: input.conversationId,
      cwd: input.cwd,
      model: input.model,
      payload: { source: input.source },
    });
    const skills = activations.flatMap((activation) =>
      activation.components.skills.map((skill) => ({
        id: `plugin:${activation.pluginId}:skill:${skill.id}`,
        name: `${activation.name}/${skill.name}`,
        description: skill.description,
        path: join(activation.installPath, skill.path, 'SKILL.md'),
      })),
    );
    const codexDynamicTools = codexTools(mcp.tools);
    const piDynamicTools = mcp.tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      inputSchema: tool.inputSchema,
      executionMode: 'sequential' as const,
      deferLoading: true,
    }));
    const developerInstructions = [
      ...sessionStart.systemMessages,
      ...sessionStart.additionalContext,
      skills.length > 0 ? `当前会话已冻结以下 Zeus Plugin Skill。可按描述自主选择，也可响应用户的 @Plugin/@Skill 显式引用：\n${skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    options.publish?.('plugin.conversation.activated', {
      conversationId: input.conversationId,
      pluginCount: activations.length,
      skillCount: skills.length,
      toolCount: mcp.tools.length,
      connectionFailureCount: mcp.failures.length,
    });
    return { activations, skills, mcp, codexDynamicTools, piDynamicTools, developerInstructions, sessionStart };
  }

  async function closeConversation(input: { conversationId: string; cwd: string; model: string; reason: string }): Promise<void> {
    if (contexts.has(input.conversationId)) {
      await hooks.emit({ event: 'SessionEnd', conversationId: input.conversationId, cwd: input.cwd, model: input.model, payload: { reason: input.reason } }).catch(() => undefined);
    }
    await Promise.allSettled([hooks.closeConversation(input.conversationId), broker.closeConversation(input.conversationId)]);
    contexts.delete(input.conversationId);
    prepared.delete(input.conversationId);
  }

  async function observeConversationEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
    const context = contexts.get(conversationId);
    if (!context) return;
    if (type === 'conversation.turn.completed') {
      const continuationActive = stopHookActive.delete(conversationId);
      const result = await hooks.emit({
        event: 'Stop',
        conversationId,
        cwd: context.cwd,
        model: context.model,
        turnId: typeof payload.turnId === 'string' ? payload.turnId : typeof payload.providerTurnId === 'string' ? payload.providerTurnId : null,
        payload: { status: payload.status ?? 'completed', stop_hook_active: continuationActive, last_assistant_message: payload.lastAssistantMessage ?? null },
      });
      if (result.continue && result.continuationPrompts.length > 0) {
        const sourceTurnId = typeof payload.turnId === 'string' ? payload.turnId : typeof payload.providerTurnId === 'string' ? payload.providerTurnId : null;
        const prompt = result.continuationPrompts.join('\n\n');
        options.publish?.('plugin.hook.continuation_required', { conversationId, turnId: sourceTurnId, prompts: result.continuationPrompts, automatic: Boolean(options.requestContinuation) });
        if (options.requestContinuation) {
          try {
            await options.requestContinuation({ conversationId, sourceTurnId, prompt });
            stopHookActive.add(conversationId);
          } catch (error) {
            options.publish?.('plugin.hook.continuation_failed', { conversationId, turnId: sourceTurnId, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      return;
    }
    if (type !== 'conversation.item.started' && type !== 'conversation.item.completed') return;
    const itemType = typeof payload.itemType === 'string' ? payload.itemType : '';
    const normalized = itemType.toLocaleLowerCase().replaceAll(/[^a-z0-9]/gu, '');
    if (!normalized.includes('subagent') && !normalized.includes('collabagent')) return;
    await hooks.emit({
      event: type === 'conversation.item.started' ? 'SubagentStart' : 'SubagentStop',
      conversationId,
      cwd: context.cwd,
      model: context.model,
      turnId: typeof payload.turnId === 'string' ? payload.turnId : null,
      payload: { agent_type: itemType, agent_id: payload.itemId ?? payload.providerItemId ?? null, ...(type === 'conversation.item.completed' ? { status: payload.status ?? 'completed' } : {}) },
    });
  }

  async function close(): Promise<void> {
    for (const [conversationId, context] of [...contexts]) {
      await closeConversation({ conversationId, cwd: context.cwd, model: context.model, reason: 'host_shutdown' });
    }
    await Promise.allSettled([hooks.close(), broker.close()]);
    contexts.clear();
    prepared.clear();
    stopHookActive.clear();
  }

  return {
    bindExplicitReferences(input) {
      const existing = contexts.get(input.conversationId);
      if (existing) {
        if (existing.projectId !== input.projectId) throw runtimeError('ZEUS_PLUGIN_CONVERSATION_IDENTITY_MISMATCH', 'Plugin 结构化引用与会话项目不一致。');
        return;
      }
      pendingReferences.set(input.conversationId, { projectId: input.projectId, references: input.references });
    },
    prepare,
    getActivations,
    getCatalog: (conversationId) => broker.listTools(conversationId),
    invokeMcp: (input) => broker.invoke(input),
    invokeAppMcp: async (input) => {
      const context = contexts.get(input.conversationId);
      if (!context) throw runtimeError('ZEUS_PLUGIN_CONVERSATION_CONTEXT_MISSING', 'Plugin Host 尚未绑定该 Zeus 会话。');
      const catalog = await broker.listTools(input.conversationId);
      const tool = catalog.appTools.find((candidate) => candidate.pluginId === input.pluginId && candidate.serverId === input.serverId && candidate.originalToolName === input.toolName);
      if (!tool) throw runtimeError('ZEUS_PLUGIN_MCP_APP_TOOL_NOT_FOUND', '该 MCP App 工具不属于当前会话冻结目录。');
      const hookToolName = `${tool.namespace}.${tool.toolName}`;
      const pre = await hooks.emit({ event: 'PreToolUse', conversationId: input.conversationId, cwd: context.cwd, model: context.model, payload: { tool_name: hookToolName, tool_input: input.args } });
      if (pre.permissionDecision === 'deny') throw runtimeError('ZEUS_PLUGIN_HOOK_TOOL_DENIED', pre.permissionDecisionReason ?? 'Plugin Hook 已阻断 MCP App 工具。');
      const args = pre.updatedInput ?? input.args;
      let approved = tool.approvalMode === 'approve' || pre.permissionDecision === 'allow';
      if (!approved && tool.approvalMode === 'prompt') {
        const permission = await hooks.emit({ event: 'PermissionRequest', conversationId: input.conversationId, cwd: context.cwd, model: context.model, payload: { tool_name: hookToolName, tool_input: args } });
        if (permission.permissionDecision === 'deny') throw runtimeError('ZEUS_PLUGIN_HOOK_PERMISSION_DENIED', permission.permissionDecisionReason ?? 'Plugin Hook 已拒绝 MCP App 工具。');
        approved = permission.permissionDecision === 'allow';
      }
      const result = await broker.invokeApp({ ...input, args, approved });
      const post = await hooks.emit({ event: 'PostToolUse', conversationId: input.conversationId, cwd: context.cwd, model: context.model, payload: { tool_name: hookToolName, tool_input: args, tool_response: result.text } });
      return { ...result, text: post.replaceToolResult ?? result.text };
    },
    beforeUserPrompt: async (input) => {
      const context = contexts.get(input.conversationId);
      if (!context) throw runtimeError('ZEUS_PLUGIN_CONVERSATION_CONTEXT_MISSING', 'Plugin Host 尚未绑定该 Zeus 会话。');
      const result = await hooks.emit({
        event: 'UserPromptSubmit',
        conversationId: input.conversationId,
        cwd: context.cwd,
        model: context.model,
        turnId: input.turnId,
        permissionMode: input.permissionMode,
        payload: { prompt: input.prompt },
      });
      if (!result.continue) throw runtimeError('ZEUS_PLUGIN_HOOK_PROMPT_BLOCKED', result.stopReasons.join('\n') || 'Plugin Hook 已阻断本次提示。');
      const value = [...result.systemMessages, ...result.additionalContext].filter(Boolean).join('\n');
      return value ? { zeus_plugin_hook_context: { kind: 'application', value } } : undefined;
    },
    emitHook: (event) => hooks.emit(event),
    observeConversationEvent,
    closeConversation,
    close,
  };
}

function codexTools(tools: ZeusPluginDynamicTool[]): CodexDynamicToolSpec[] {
  const grouped = new Map<string, ZeusPluginDynamicTool[]>();
  for (const tool of tools) grouped.set(tool.namespace, [...(grouped.get(tool.namespace) ?? []), tool]);
  return [...grouped.entries()].map(([namespace, entries]) => ({
    type: 'namespace',
    name: namespace,
    description: `Zeus Plugin MCP tools for ${entries[0]!.pluginId}/${entries[0]!.serverId}.`,
    tools: entries.map((tool) => ({
      type: 'function',
      name: tool.toolName,
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      deferLoading: true,
    })),
  }));
}

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
