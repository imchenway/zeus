import { join } from 'node:path';
import type { CodexDynamicToolSpec, PiDynamicToolSpec } from '@zeus/ai-runtime';
import type { SecretStore } from './securityCore.js';
import type { CodexBootstrapAdditionalContext } from '@zeus/shared';
import { createZeusPluginHookRuntime, pluginDispatchHookWaitLimitMs, type ZeusPluginHookEvent, type ZeusPluginHookEventResult, type ZeusPluginHookRuntime } from './zeusPluginHookRuntime.js';
import {
  createZeusPluginMcpApprovalEvidence,
  createZeusPluginMcpBroker,
  type ZeusPluginDynamicTool,
  type ZeusPluginMcpApprovalEvidence,
  type ZeusPluginMcpApprovalSource,
  type ZeusPluginMcpBroker,
  type ZeusPluginMcpCatalog,
  type ZeusPluginMcpToolResult,
} from './zeusPluginMcpBroker.js';
import type { PluginActivationState, ZeusPluginService } from './zeusPluginService.js';

/** Codex 仅注册两个稳定入口，真实 MCP 目录在模型需要时读取当前状态。 */
const codexPluginDynamicTools: CodexDynamicToolSpec[] = [
  {
    type: 'namespace',
    name: 'zeus_plugin',
    description: '按当前安装、启用和权限状态发现并调用 Zeus Plugin MCP 工具。',
    tools: [
      {
        type: 'function',
        name: 'catalog',
        description: '搜索当前可用的 Plugin MCP 工具。精确 name 会返回完整参数结构，普通查询最多返回 20 项。',
        inputSchema: { type: 'object', properties: { name: { type: 'string' }, query: { type: 'string' } }, additionalProperties: false },
        deferLoading: true,
      },
      {
        type: 'function',
        name: 'invoke',
        description: '按 catalog 返回的精确名称调用当前仍可用的 Plugin MCP 工具。',
        inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name', 'arguments'], additionalProperties: false },
        deferLoading: true,
      },
    ],
  },
];

/** Pi 使用独立的当前态发现入口，避免创建会话时连接全部 MCP Server。 */
const piPluginDynamicTools: PiDynamicToolSpec[] = [
  {
    name: 'zeus_plugin_catalog',
    label: '发现 Plugin 工具',
    description: '搜索当前可用的 Plugin MCP 工具。精确 name 会返回完整参数结构，普通查询最多返回 20 项。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, query: { type: 'string' } }, additionalProperties: false },
    executionMode: 'parallel',
  },
  {
    name: 'zeus_plugin_invoke',
    label: '调用 Plugin 工具',
    description: '按 zeus_plugin_catalog 返回的精确名称调用当前仍可用的 Plugin MCP 工具。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name', 'arguments'], additionalProperties: false },
    executionMode: 'sequential',
  },
];

export interface ZeusPluginConversationPreparation {
  activations: PluginActivationState[];
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
  getActivations(conversationId: string): Promise<PluginActivationState[]>;
  getCatalog(conversationId: string): Promise<ZeusPluginMcpCatalog>;
  invokeMcp(input: { conversationId: string; tool: ZeusPluginDynamicTool; args: Record<string, unknown>; approval: ZeusPluginMcpApprovalEvidence; signal?: AbortSignal }): Promise<ZeusPluginMcpToolResult>;
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
  const stopHookActive = new Set<string>();
  /** 每次调用都读取当前 Plugin 状态，删除或停用立即影响下一次派发与工具调用。 */
  const getActivations = async (conversationId: string): Promise<PluginActivationState[]> => {
    const context = contexts.get(conversationId);
    if (!context) throw runtimeError('ZEUS_PLUGIN_CONVERSATION_CONTEXT_MISSING', 'Plugin Host 尚未绑定该 Zeus 会话。');
    return options.service.resolveCurrentActivations({
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

  /** 每次派发重建当前本地 Plugin 元数据，且不在这里连接 MCP。 */
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
      throw runtimeError('ZEUS_PLUGIN_CONVERSATION_IDENTITY_MISMATCH', 'Plugin 会话上下文与当前项目身份不一致。');
    }
    const pendingReference = pendingReferences.get(input.conversationId);
    if (pendingReference && pendingReference.projectId !== input.projectId) throw runtimeError('ZEUS_PLUGIN_CONVERSATION_IDENTITY_MISMATCH', 'Plugin 结构化引用与会话项目不一致。');
    const explicitReferences =
      input.explicitReferences ??
      (pendingReference ? pendingReference.references : existing ? existing.explicitReferences : input.prompt ? await options.service.resolveExplicitReferences({ projectId: input.projectId, text: input.prompt }) : []);
    pendingReferences.delete(input.conversationId);
    contexts.set(input.conversationId, {
      projectId: input.projectId,
      cwd: input.cwd,
      model: input.model,
      explicitReferences,
    });
    return buildPreparation(input, !existing);
  }

  /** 准备过程只读取本地当前态；MCP 网络连接推迟到 catalog 或 invoke。 */
  async function buildPreparation(input: { conversationId: string; projectId: string; cwd: string; model: string; source: 'startup' | 'resume' | 'clear' | 'compact' }, emitSessionStart: boolean): Promise<ZeusPluginConversationPreparation> {
    const activations = await getActivations(input.conversationId);
    const mcp: ZeusPluginMcpCatalog = { tools: [], appTools: [], failures: [] };
    const sessionStart: ZeusPluginHookEventResult = emitSessionStart
      ? await hooks.emit({ event: 'SessionStart', conversationId: input.conversationId, cwd: input.cwd, model: input.model, payload: { source: input.source }, maximumWaitMs: pluginDispatchHookWaitLimitMs })
      : {
          event: 'SessionStart',
          runs: [],
          continue: true,
          systemMessages: [],
          additionalContext: [],
          continuationPrompts: [],
          stopReasons: [],
          permissionDecision: null,
          permissionDecisionReason: null,
          updatedInput: null,
          replaceToolResult: null,
        };
    rejectTimedOutDispatchHooks(sessionStart);
    const skills = activations.flatMap((activation) =>
      activation.components.skills.map((skill) => ({
        id: `plugin:${activation.pluginId}:skill:${skill.id}`,
        name: `${activation.name}/${skill.name}`,
        description: skill.description,
        path: join(activation.installPath, skill.path, 'SKILL.md'),
      })),
    );
    const codexDynamicTools = codexPluginDynamicTools;
    const piDynamicTools = piPluginDynamicTools;
    const developerInstructions = [
      ...sessionStart.systemMessages,
      ...sessionStart.additionalContext,
      activations.some((activation) => activation.components.mcpServers.length > 0 || activation.connectors.some((connector) => connector.connected))
        ? 'Plugin MCP 工具按需读取当前目录。Codex 使用 zeus_plugin.catalog/invoke，Pi 使用 zeus_plugin_catalog/zeus_plugin_invoke；删除、停用或权限变更立即影响后续调用。'
        : '',
      skills.length > 0 ? `当前可用的 Zeus Plugin Skill 如下；删除或停用后立即不可用：\n${skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    options.publish?.('plugin.conversation.activated', {
      conversationId: input.conversationId,
      pluginCount: activations.length,
      skillCount: skills.length,
      toolCount: null,
      connectionFailureCount: 0,
    });
    return { activations, skills, mcp, codexDynamicTools, piDynamicTools, developerInstructions, sessionStart };
  }

  async function closeConversation(input: { conversationId: string; cwd: string; model: string; reason: string }): Promise<void> {
    if (contexts.has(input.conversationId)) {
      await hooks.emit({ event: 'SessionEnd', conversationId: input.conversationId, cwd: input.cwd, model: input.model, payload: { reason: input.reason } }).catch(() => undefined);
    }
    await Promise.allSettled([hooks.closeConversation(input.conversationId), broker.closeConversation(input.conversationId)]);
    contexts.delete(input.conversationId);
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
    stopHookActive.clear();
  }

  return {
    bindExplicitReferences(input) {
      const existing = contexts.get(input.conversationId);
      if (existing && existing.projectId !== input.projectId) throw runtimeError('ZEUS_PLUGIN_CONVERSATION_IDENTITY_MISMATCH', 'Plugin 结构化引用与会话项目不一致。');
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
      if (!tool) throw runtimeError('ZEUS_PLUGIN_MCP_APP_TOOL_NOT_FOUND', '该 MCP App 工具在当前 Plugin 状态下不可用。');
      const hookToolName = `${tool.namespace}.${tool.toolName}`;
      const pre = await hooks.emit({ event: 'PreToolUse', conversationId: input.conversationId, cwd: context.cwd, model: context.model, payload: { tool_name: hookToolName, tool_input: input.args } });
      if (pre.permissionDecision === 'deny') throw runtimeError('ZEUS_PLUGIN_HOOK_TOOL_DENIED', pre.permissionDecisionReason ?? 'Plugin Hook 已阻断 MCP App 工具。');
      const args = pre.updatedInput ?? input.args;
      if (tool.approvalMode === 'deny') throw runtimeError('ZEUS_PLUGIN_MCP_TOOL_DENIED', 'Plugin MCP App 工具策略已拒绝执行。');
      let approvalSource: ZeusPluginMcpApprovalSource | null = tool.approvalMode === 'approve' ? 'policy' : pre.permissionDecision === 'allow' ? 'pre_tool_hook' : null;
      if (!approvalSource && tool.approvalMode === 'prompt') {
        const permission = await hooks.emit({ event: 'PermissionRequest', conversationId: input.conversationId, cwd: context.cwd, model: context.model, payload: { tool_name: hookToolName, tool_input: args } });
        if (permission.permissionDecision === 'deny') throw runtimeError('ZEUS_PLUGIN_HOOK_PERMISSION_DENIED', permission.permissionDecisionReason ?? 'Plugin Hook 已拒绝 MCP App 工具。');
        if (permission.permissionDecision === 'allow') approvalSource = 'permission_hook';
      }
      if (!approvalSource) throw runtimeError('ZEUS_PLUGIN_MCP_APP_APPROVAL_REQUIRED', 'MCP App 工具需要当前策略允许或可信 PermissionRequest Hook 审批。');
      const approval = createZeusPluginMcpApprovalEvidence(tool, args, approvalSource);
      const result = await broker.invokeApp({ conversationId: input.conversationId, tool, args, approval, ...(input.signal ? { signal: input.signal } : {}) });
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
        maximumWaitMs: pluginDispatchHookWaitLimitMs,
      });
      rejectTimedOutDispatchHooks(result);
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

/** 发送前同步 Hook 超时属于未知外部结果，必须停止本次派发并交给用户明确重试。 */
function rejectTimedOutDispatchHooks(result: ZeusPluginHookEventResult): void {
  if (!result.runs.some((run) => run.state === 'timed_out')) return;
  throw runtimeError('ZEUS_PLUGIN_HOOK_DISPATCH_TIMEOUT', 'Plugin Hook 等待超时，本次消息尚未发送。请检查 Plugin 后重试。');
}

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
