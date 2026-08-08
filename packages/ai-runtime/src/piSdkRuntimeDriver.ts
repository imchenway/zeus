import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type AgentSession, type AgentSessionEvent, createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type {
  AcceptedAgentRun,
  AgentDescriptor,
  AgentModelIdentity,
  AgentRuntimeDriver,
  AgentRuntimeEvent,
  AgentRuntimeProbe,
  AgentSessionIdentity,
  AgentSessionSnapshot,
  FollowUpAgentRunInput,
  InterruptAgentRunInput,
  OpenAgentSessionInput,
  ReadAgentSessionInput,
  RespondAgentInteractionInput,
  ResumeAgentSessionInput,
  StartAgentRunInput,
  SteerAgentRunInput,
} from './agentRuntimeContracts.js';
import type { ConfiguredModelDefinition, ModelConnectionRecord, PiThinkingLevel } from './modelConnectionCatalog.js';

export interface PiRuntimeConnection extends ModelConnectionRecord {
  apiKey?: string;
}

export interface PiZeusToolRequest {
  requestId: string;
  session: AgentSessionIdentity;
  toolCallId: string;
  toolName: 'read' | 'grep' | 'find' | 'ls' | 'write' | 'edit' | 'bash';
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface PiZeusToolResult {
  text: string;
  details?: unknown;
  isError?: boolean;
}

export interface PiZeusToolBroker {
  execute(input: PiZeusToolRequest): Promise<PiZeusToolResult>;
  respond?(input: RespondAgentInteractionInput): Promise<void>;
}

export interface CreatePiSdkRuntimeDriverOptions {
  adapterVersion: string;
  agentDirectory: string;
  sessionDirectory: string;
  loadConnections: () => Promise<PiRuntimeConnection[]>;
  toolBroker: PiZeusToolBroker;
  now?: () => string;
  runtimeInstanceId?: string;
}

interface PiSessionEntry {
  identity: AgentSessionIdentity;
  cwd: string;
  session: AgentSession;
  activeRunId: string | null;
  sequence: number;
  unsubscribe: () => void;
}

const piThinkingLevels = new Set<PiThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * 把 Pi SDK 收敛为 Zeus 的公共运行内核驱动。
 * Pi 默认工具全部关闭，只有经过 Zeus broker 的同名工具可以执行。
 */
export function createPiSdkRuntimeDriver(options: CreatePiSdkRuntimeDriverOptions): AgentRuntimeDriver {
  const now = options.now ?? (() => new Date().toISOString());
  const runtimeInstanceId = options.runtimeInstanceId ?? `pi_runtime_${randomUUID()}`;
  const sessions = new Map<string, PiSessionEntry>();
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  let modelRuntimePromise: Promise<{ runtime: ModelRuntime; connections: PiRuntimeConnection[] }> | null = null;
  let closed = false;

  async function loadModelRuntime(force = false): Promise<{ runtime: ModelRuntime; connections: PiRuntimeConnection[] }> {
    if (!force && modelRuntimePromise) return modelRuntimePromise;
    modelRuntimePromise = (async () => {
      const connections = await options.loadConnections();
      const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
      for (const connection of connections) {
        if (!connection.enabled || connection.models.length === 0) continue;
        runtime.registerProvider(piProviderId(connection.id), {
          name: connection.name,
          baseUrl: connection.baseUrl,
          api: 'openai-completions',
          models: connection.models.map((model) => toPiModelConfig(model)),
        });
        if (connection.apiKey) await runtime.setRuntimeApiKey(piProviderId(connection.id), connection.apiKey, { allowNetwork: false });
      }
      return { runtime, connections };
    })();
    return modelRuntimePromise;
  }

  async function createSession(input: OpenAgentSessionInput | (ResumeAgentSessionInput & { cwd: string }), sessionManager: SessionManager): Promise<PiSessionEntry> {
    assertOpen();
    await Promise.all([mkdir(options.agentDirectory, { recursive: true, mode: 0o700 }), mkdir(options.sessionDirectory, { recursive: true, mode: 0o700 })]);
    const { runtime } = await loadModelRuntime();
    const requestedModel = 'model' in input ? input.model : undefined;
    const model = requestedModel ? resolveModel(runtime, requestedModel) : undefined;
    const settingsManager = SettingsManager.inMemory(
      {
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
        defaultProjectTrust: 'never',
        enableAnalytics: false,
        enableInstallTelemetry: false,
      },
      { projectTrusted: false },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: options.agentDirectory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    let entryRef: PiSessionEntry | null = null;
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir: options.agentDirectory,
      modelRuntime: runtime,
      ...(model ? { model } : {}),
      noTools: 'builtin',
      customTools: createZeusTools(() => entryRef, options.toolBroker),
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    const identity: AgentSessionIdentity = {
      agentKind: 'pi',
      nativeSessionId: session.sessionId,
      nativeSessionPath: session.sessionFile ?? null,
      runtimeInstanceId,
    };
    const entry: PiSessionEntry = {
      identity,
      cwd: input.cwd,
      session,
      activeRunId: null,
      sequence: 0,
      unsubscribe: () => undefined,
    };
    entryRef = entry;
    entry.unsubscribe = session.subscribe((event) => publishPiEvent(entry, event));
    sessions.set(identity.nativeSessionId, entry);
    return entry;
  }

  function publishPiEvent(entry: PiSessionEntry, event: AgentSessionEvent): void {
    const nativeRunId = entry.activeRunId;
    if (event.type === 'agent_settled' || event.type === 'agent_end') {
      if (event.type === 'agent_settled') entry.activeRunId = null;
    }
    const envelope: AgentRuntimeEvent = {
      agentKind: 'pi',
      runtimeInstanceId,
      nativeSessionId: entry.identity.nativeSessionId,
      nativeRunId,
      sequence: (entry.sequence += 1),
      type: event.type,
      payload: event,
      createdAt: now(),
    };
    for (const listener of listeners) listener(envelope);
  }

  async function start(entry: PiSessionEntry, input: StartAgentRunInput, mode: 'prompt' | 'steer' | 'follow_up'): Promise<AcceptedAgentRun> {
    if (mode === 'steer' && !entry.activeRunId) throw runtimeError('ZEUS_PI_RUN_NOT_ACTIVE', 'Pi 插话需要一个正在执行的轮次。');
    if (input.model) {
      if (!entry.session.isIdle) throw runtimeError('ZEUS_PI_MODEL_CHANGE_IN_PROGRESS', 'Pi 模型只能在会话空闲时切换。');
      const { runtime } = await loadModelRuntime();
      await entry.session.setModel(resolveModel(runtime, input.model));
    }
    if (input.thinkingLevel) {
      if (!piThinkingLevels.has(input.thinkingLevel as PiThinkingLevel)) throw runtimeError('ZEUS_PI_THINKING_LEVEL_INVALID', `Pi 不支持推理等级：${input.thinkingLevel}`);
      entry.session.setThinkingLevel(input.thinkingLevel as PiThinkingLevel);
    }
    const nativeRunId = mode === 'steer' ? entry.activeRunId! : `pi_run_${randomUUID()}`;
    entry.activeRunId = nativeRunId;
    const acceptedAt = now();
    const images = input.images?.map((image): { type: 'image'; data: string; mimeType: string } => ({ type: 'image', data: image.data, mimeType: image.mimeType }));
    const operation = mode === 'steer' ? entry.session.steer(input.content, images) : mode === 'follow_up' ? entry.session.followUp(input.content, images) : entry.session.prompt(input.content, images?.length ? { images } : undefined);
    void operation.catch((error: unknown) => {
      const payload = { message: error instanceof Error ? error.message : String(error), code: readErrorCode(error) };
      // 等协调器登记已接受轮次后再投递错误，避免同步失败事件被忽略。
      queueMicrotask(() => {
        publishSyntheticEvent(entry, nativeRunId, 'runtime_error', payload);
        entry.activeRunId = null;
      });
    });
    return { nativeRunId, acceptedAt };
  }

  function publishSyntheticEvent(entry: PiSessionEntry, nativeRunId: string | null, type: string, payload: unknown): void {
    const envelope: AgentRuntimeEvent = {
      agentKind: 'pi',
      runtimeInstanceId,
      nativeSessionId: entry.identity.nativeSessionId,
      nativeRunId,
      sequence: (entry.sequence += 1),
      type,
      payload,
      createdAt: now(),
    };
    for (const listener of listeners) listener(envelope);
  }

  function requireSession(identity: AgentSessionIdentity): PiSessionEntry {
    if (identity.agentKind !== 'pi') throw runtimeError('ZEUS_PI_SESSION_IDENTITY_INVALID', '会话不属于 Pi Agent。');
    const entry = sessions.get(identity.nativeSessionId);
    if (!entry) throw runtimeError('ZEUS_PI_SESSION_NOT_LOADED', 'Pi 会话尚未载入当前运行内核。');
    return entry;
  }

  function assertOpen(): void {
    if (closed) throw runtimeError('ZEUS_PI_RUNTIME_CLOSED', 'Pi 运行内核已经关闭。');
  }

  return {
    kind: 'pi',
    async probe(): Promise<AgentRuntimeProbe> {
      try {
        const { connections } = await loadModelRuntime(true);
        const configuredModels = connections.filter((connection) => connection.enabled && connection.apiKey && connection.models.some((model) => model.enabled)).flatMap((connection) => connection.models);
        return {
          available: configuredModels.length > 0,
          checkedAt: now(),
          adapterVersion: options.adapterVersion,
          binaryVersion: 'pi-sdk-0.83.0',
          protocolVersion: 'sdk',
          reason: configuredModels.length > 0 ? `Pi SDK 已载入 ${configuredModels.length} 个带凭据模型。` : 'Pi SDK 已安装，但没有启用且配置凭据的模型连接。',
        };
      } catch (error) {
        return {
          available: false,
          checkedAt: now(),
          adapterVersion: options.adapterVersion,
          binaryVersion: 'pi-sdk-0.83.0',
          protocolVersion: 'sdk',
          reason: error instanceof Error ? error.message : 'Pi SDK 初始化失败。',
        };
      }
    },
    async readCapabilities(): Promise<AgentDescriptor> {
      const probe = await this.probe();
      const evidence = {
        state: probe.available ? ('supported' as const) : ('unverified' as const),
        checkedAt: probe.checkedAt,
        adapterVersion: probe.adapterVersion,
        binaryVersion: probe.binaryVersion,
        reason: probe.reason,
      };
      return {
        kind: 'pi',
        displayName: 'Pi Agent',
        transport: 'sdk',
        supportStatus: probe.available ? 'experimental' : 'unavailable',
        visibleToUsers: probe.available,
        capabilities: Object.fromEntries(['session', 'streaming', 'steer', 'follow_up', 'interrupt', 'approval', 'user_input', 'model_catalog', 'usage', 'compaction', 'retry'].map((id) => [id, { ...evidence }])),
      };
    },
    async openSession(input: OpenAgentSessionInput): Promise<AgentSessionIdentity> {
      const entry = await createSession(input, SessionManager.create(resolve(input.cwd), options.sessionDirectory));
      return entry.identity;
    },
    async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSessionIdentity> {
      const path = input.nativeSessionPath?.trim();
      if (!path) throw runtimeError('ZEUS_PI_SESSION_PATH_REQUIRED', '恢复 Pi 会话需要持久化会话路径。');
      const manager = SessionManager.open(path, options.sessionDirectory, input.cwd);
      const entry = await createSession({ ...input, cwd: input.cwd ?? manager.getCwd() }, manager);
      if (entry.identity.nativeSessionId !== input.nativeSessionId) throw runtimeError('ZEUS_PI_SESSION_IDENTITY_MISMATCH', 'Pi 会话文件与持久化会话 ID 不一致。');
      return entry.identity;
    },
    async startRun(input: StartAgentRunInput): Promise<AcceptedAgentRun> {
      return start(requireSession(input.session), input, 'prompt');
    },
    async steerRun(input: SteerAgentRunInput): Promise<AcceptedAgentRun> {
      return start(requireSession(input.session), input, 'steer');
    },
    async followUp(input: FollowUpAgentRunInput): Promise<AcceptedAgentRun> {
      return start(requireSession(input.session), input, 'follow_up');
    },
    async interruptRun(input: InterruptAgentRunInput): Promise<void> {
      const entry = requireSession(input.session);
      if (entry.activeRunId && entry.activeRunId !== input.nativeRunId) throw runtimeError('ZEUS_PI_RUN_IDENTITY_MISMATCH', '中断目标不是当前 Pi 执行轮次。');
      await entry.session.abort();
      entry.activeRunId = null;
    },
    async respondToInteraction(input: RespondAgentInteractionInput): Promise<void> {
      if (!options.toolBroker.respond) throw runtimeError('ZEUS_PI_INTERACTION_RESPONSE_UNAVAILABLE', 'Pi 工具审批响应通道不可用。');
      await options.toolBroker.respond(input);
    },
    async readSession(input: ReadAgentSessionInput): Promise<AgentSessionSnapshot> {
      const entry = requireSession(input.session);
      return {
        session: entry.identity,
        state: entry.session.isIdle ? 'idle' : 'active',
        raw: {
          model: entry.session.model ? { sourceId: sourceIdFromPiProvider(entry.session.model.provider), modelId: entry.session.model.id } : null,
          thinkingLevel: entry.session.thinkingLevel,
          pendingMessageCount: entry.session.pendingMessageCount,
          messages: entry.session.messages,
        },
      };
    },
    async recover(): Promise<void> {
      assertOpen();
      await loadModelRuntime(true);
    },
    async close(): Promise<void> {
      closed = true;
      for (const entry of sessions.values()) {
        if (!entry.session.isIdle) await entry.session.abort().catch(() => undefined);
        entry.unsubscribe();
        entry.session.dispose();
      }
      sessions.clear();
      listeners.clear();
    },
    subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createZeusTools(getEntry: () => PiSessionEntry | null, broker: PiZeusToolBroker): ToolDefinition[] {
  const execute = async (toolCallId: string, toolName: PiZeusToolRequest['toolName'], args: Record<string, unknown>, signal?: AbortSignal) => {
    const entry = getEntry();
    if (!entry) throw runtimeError('ZEUS_PI_TOOL_SESSION_UNBOUND', 'Pi 工具尚未绑定 Zeus 会话。');
    const result = await broker.execute({ requestId: `pi_tool_${randomUUID()}`, session: entry.identity, toolCallId, toolName, args, ...(signal ? { signal } : {}) });
    if (result.isError) throw runtimeError('ZEUS_PI_TOOL_EXECUTION_FAILED', result.text);
    return { content: [{ type: 'text' as const, text: result.text }], details: result.details ?? null };
  };
  return [
    defineTool({
      name: 'read',
      label: '读取文件',
      description: '读取 Zeus 当前工作区中的文本文件。',
      parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
      execute: (id, args, signal) => execute(id, 'read', args, signal),
    }),
    defineTool({
      name: 'grep',
      label: '搜索文本',
      description: '在 Zeus 当前工作区中搜索文本。',
      parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
      execute: (id, args, signal) => execute(id, 'grep', args, signal),
    }),
    defineTool({
      name: 'find',
      label: '查找文件',
      description: '在 Zeus 当前工作区中按名称查找文件。',
      parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
      execute: (id, args, signal) => execute(id, 'find', args, signal),
    }),
    defineTool({ name: 'ls', label: '列出目录', description: '列出 Zeus 当前工作区中的目录内容。', parameters: Type.Object({ path: Type.Optional(Type.String()) }), execute: (id, args, signal) => execute(id, 'ls', args, signal) }),
    defineTool({
      name: 'write',
      label: '写入文件',
      description: '经 Zeus 权限判断和用户审批后写入文件。',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      executionMode: 'sequential',
      execute: (id, args, signal) => execute(id, 'write', args, signal),
    }),
    defineTool({
      name: 'edit',
      label: '编辑文件',
      description: '经 Zeus 权限判断和用户审批后精确替换文件内容。',
      parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
      executionMode: 'sequential',
      execute: (id, args, signal) => execute(id, 'edit', args, signal),
    }),
    defineTool({
      name: 'bash',
      label: '执行命令',
      description: '经 Zeus 权限判断和用户审批后在当前工作区执行命令。',
      parameters: Type.Object({ command: Type.String() }),
      executionMode: 'sequential',
      execute: (id, args, signal) => execute(id, 'bash', args, signal),
    }),
  ];
}

function toPiModelConfig(model: ConfiguredModelDefinition) {
  const supportedLevels = new Set(model.capability.reasoning.levels);
  return {
    id: model.id,
    name: model.displayName,
    reasoning: model.capability.reasoning.state === 'supported',
    thinkingLevelMap: Object.fromEntries([...piThinkingLevels].map((level) => [level, supportedLevels.has(level) ? level : null])),
    // 模型是否接受图片由实际运行内核和服务商判断，不使用本地能力档案预先拦截。
    input: ['text', 'image'] as Array<'text' | 'image'>,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: {
      thinkingFormat: model.capability.reasoning.thinkingFormat,
      supportsReasoningEffort: model.capability.reasoning.state === 'supported',
      supportsUsageInStreaming: model.capability.usage.state !== 'unsupported',
      supportsStrictMode: false,
    },
  };
}

function resolveModel(runtime: ModelRuntime, identity: AgentModelIdentity) {
  const model = runtime.getModel(piProviderId(identity.sourceId ?? ''), identity.modelId);
  if (!model) throw runtimeError('ZEUS_PI_MODEL_UNAVAILABLE', `Pi 模型不可用：${identity.modelId}`);
  return model;
}

function piProviderId(sourceId: string): string {
  if (!sourceId) throw runtimeError('ZEUS_PI_MODEL_SOURCE_REQUIRED', 'Pi 模型必须指定连接来源。');
  return `zeus-${sourceId}`;
}

function sourceIdFromPiProvider(providerId: string): string | null {
  return providerId.startsWith('zeus-') ? providerId.slice('zeus-'.length) : null;
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
