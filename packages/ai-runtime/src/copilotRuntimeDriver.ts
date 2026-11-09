import type { CopilotSession, ResumeSessionConfig, SessionConfig, Tool, ToolResultObject } from '@github/copilot-sdk';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  AcceptedAgentRun,
  AgentDescriptor,
  AgentRuntimeEvent,
  AgentRuntimeFailureKind,
  AgentRuntimeHealthSnapshot,
  AgentRuntimeProbe,
  AgentSessionIdentity,
  AgentSessionSnapshot,
  CompactAgentSessionInput,
  CompactAgentSessionResult,
  FollowUpAgentRunInput,
  InterruptAgentRunInput,
  OpenAgentSessionInput,
  ReadAgentSessionInput,
  RespondAgentInteractionInput,
  ResumeAgentSessionInput,
  StartAgentRunInput,
  SteerAgentRunInput,
  SupervisedAgentRuntimeDriver,
} from './agentRuntimeContracts.js';
import { CopilotRuntimeManager } from './copilotRuntimeManager.js';
import { CopilotSdkEventAdapter } from './copilotSdkEventAdapter.js';
import {
  readPiBuiltinToolCatalog,
  type PiPermissionReviewInput,
  type PiPermissionReviewResult,
  type PiPortableHistoryImportInput,
  type PiPortableHistoryImportResult,
  type PiSdkRuntimeDriver,
  type PiZeusToolBroker,
  type PiZeusToolDefinitionSpec,
} from './piSdkRuntimeDriver.js';

/** Copilot 原生会话与当前 Zeus 轮次的绑定；SDK 事件只能进入所属轮次。 */
interface CopilotSessionBinding {
  session: CopilotSession;
  identity: AgentSessionIdentity;
  cwd: string;
  modelId: string;
  importedSummary: string | null;
  metadata: Record<string, unknown> | undefined;
  activeRunId: string | null;
  adapter: CopilotSdkEventAdapter | null;
  unsubscribe: () => void;
  accepting: boolean;
  pendingEvents: AgentRuntimeEvent[];
}

/** Copilot 仅通过 Zeus 已审计的工具 broker 访问文件、进程和外部应用。 */
export interface CreateCopilotRuntimeDriverOptions {
  manager: CopilotRuntimeManager;
  toolBroker: PiZeusToolBroker;
  nativeTools?: PiZeusToolDefinitionSpec[];
  now?: () => string;
}

/** 复用 Agent 驱动契约，封装 SDK 会话、持久接纳、事件和进程恢复。 */
export class CopilotRuntimeDriver implements SupervisedAgentRuntimeDriver, PiSdkRuntimeDriver {
  readonly kind = 'copilot' as const;
  private readonly bindings = new Map<string, CopilotSessionBinding>();
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>();
  private readonly now: () => string;
  private generationId: string | null = null;
  private lifecycle: AgentRuntimeHealthSnapshot['lifecycle'] = 'stopped';
  private lastFailure: AgentRuntimeHealthSnapshot['lastFailure'] = null;
  private consecutiveFailures = 0;

  /** Manager 属于 Core 生命周期；工具处理和账户密钥不进入 Renderer。 */
  constructor(private readonly options: CreateCopilotRuntimeDriverOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 探测可用性只在显式调用时启动 SDK 并读取当前账户。 */
  async probe(): Promise<AgentRuntimeProbe> {
    try {
      const client = await this.options.manager.ensureReady();
      this.generationId ??= randomUUID();
      this.lifecycle = 'healthy';
      const [status, auth] = await Promise.all([client.getStatus(), this.options.manager.refreshAccount()]);
      return {
        available: auth.authenticated,
        checkedAt: this.now(),
        adapterVersion: 'copilot-sdk',
        binaryVersion: status.version,
        protocolVersion: String(status.protocolVersion),
        reason: auth.authenticated ? 'Copilot 已登录。' : 'Copilot 尚未登录。',
      };
    } catch (error) {
      this.recordFailure(error, 'startup', false);
      return { available: false, checkedAt: this.now(), adapterVersion: 'copilot-sdk', binaryVersion: null, protocolVersion: null, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 模型目录和会话能力以实际 SDK 探测为准，不把类型声明写成运行验收。 */
  async readCapabilities(): Promise<AgentDescriptor> {
    const probe = await this.probe();
    const evidence = { state: probe.available ? ('supported' as const) : ('unverified' as const), checkedAt: probe.checkedAt, adapterVersion: probe.adapterVersion, binaryVersion: probe.binaryVersion, reason: probe.reason };
    return {
      kind: 'copilot',
      displayName: 'GitHub Copilot',
      transport: 'sdk',
      supportStatus: probe.available ? 'experimental' : 'unavailable',
      visibleToUsers: false,
      preflightTokenCount: { state: 'unavailable', exact: false, source: null, checkedAt: probe.checkedAt, reason: 'Copilot SDK 未提供发送前的精确 token-count。' },
      capabilities: Object.fromEntries(['session', 'streaming', 'steer', 'follow_up', 'interrupt', 'approval', 'user_input', 'model_catalog', 'usage', 'compaction'].map((id) => [id, evidence])),
    };
  }

  /** 新会话固定工作目录及 Zeus 工具目录；SDK 自行持久化会话身份。 */
  async openSession(input: OpenAgentSessionInput): Promise<AgentSessionIdentity> {
    await this.requireAuthenticated();
    const client = await this.options.manager.ensureReady();
    this.generationId ??= randomUUID();
    const session = await client.createSession(this.sessionConfig(input.cwd, input.model.modelId, input.metadata));
    const identity: AgentSessionIdentity = { agentKind: 'copilot', nativeSessionId: session.sessionId, nativeSessionPath: session.workspacePath ?? null, runtimeInstanceId: this.generationId };
    this.bind(session, identity, input.cwd, input.model.modelId, input.metadata);
    return identity;
  }

  /** 重启后按原生 ID 恢复历史，并重新绑定 Zeus 工具及权限。 */
  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSessionIdentity> {
    await this.requireAuthenticated();
    const existing = this.bindings.get(input.nativeSessionId);
    if (existing) return existing.identity;
    this.generationId ??= randomUUID();
    const cwd = input.cwd;
    if (!cwd) throw new Error('Copilot 会话恢复缺少已冻结的工作目录。');
    const session = await this.options.manager.resumeSession(input.nativeSessionId, this.sessionConfig(cwd, undefined, input.metadata));
    if (session.sessionId !== input.nativeSessionId) {
      await session.disconnect();
      throw new Error('Copilot 恢复返回了不同的原生会话身份。');
    }
    const identity: AgentSessionIdentity = { agentKind: 'copilot', nativeSessionId: session.sessionId, nativeSessionPath: session.workspacePath ?? input.nativeSessionPath ?? null, runtimeInstanceId: this.generationId };
    this.bind(session, identity, cwd, '', input.metadata);
    return identity;
  }

  /** 先完成 Core 持久接纳，再允许 SDK 发送；发送结果未知时绝不自动重放。 */
  async startRun(input: StartAgentRunInput): Promise<AcceptedAgentRun> {
    return this.send(input, 'enqueue');
  }

  /** 正在运行的会话使用 SDK immediate 模式，在同一原生轮次中插话。 */
  async steerRun(input: SteerAgentRunInput): Promise<AcceptedAgentRun> {
    return this.send(input, 'immediate');
  }

  /** 后续消息走同一持久接纳及原生队列。 */
  async followUp(input: FollowUpAgentRunInput): Promise<AcceptedAgentRun> {
    return this.send(input, 'enqueue');
  }

  /** 原生压缩返回实际删减量；SDK 未报告的模型用量保持未知。 */
  async compactSession(input: CompactAgentSessionInput): Promise<CompactAgentSessionResult> {
    const binding = this.requireBinding(input.session.nativeSessionId);
    const result = await binding.session.rpc.history.compact({ customInstructions: input.customInstructions, trigger: 'manual' });
    if (!result.success) throw new Error('Copilot 会话压缩失败。');
    const after = result.contextWindow?.currentTokens ?? 0;
    return {
      summary: result.summaryContent ?? '',
      tokensBefore: after + result.tokensRemoved,
      estimatedTokensAfter: result.contextWindow?.currentTokens ?? null,
      usage: { inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null, reasoningOutputTokens: null, totalTokens: null },
    };
  }

  /** 模型目录刷新由 SDK 账号决定，不能读取 Pi 的连接目录。 */
  async invalidateModelRuntime(): Promise<void> {
    await this.options.manager.refreshModels();
  }

  /** 独立审查不可用时保留人工请求，不能自动放行 Copilot 工具。 */
  async reviewPermission(_input: PiPermissionReviewInput): Promise<PiPermissionReviewResult> {
    return { decision: 'manual', reason: 'Copilot 独立权限审查暂不可用，请人工确认。', tokensUsed: null, usage: null };
  }

  /** 跨 Provider 历史用无工具 Copilot 会话压缩，摘要只注入目标首轮。 */
  async importPortableHistory(input: PiPortableHistoryImportInput): Promise<PiPortableHistoryImportResult> {
    const binding = this.requireBinding(input.session.nativeSessionId);
    if (!binding.modelId) throw new Error('Copilot 历史导入缺少模型身份。');
    const session = await this.options.manager.createSession({ workingDirectory: binding.cwd, model: binding.modelId, availableTools: [], skipCustomInstructions: true });
    let summary = '';
    let batches = 0;
    const usage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    const unsubscribe = session.on((event) => {
      if (event.type !== 'assistant.usage') return;
      usage.inputTokens += Math.max(0, (event.data.inputTokens ?? 0) - (event.data.cacheReadTokens ?? 0) - (event.data.cacheWriteTokens ?? 0));
      usage.cachedInputTokens += event.data.cacheReadTokens ?? 0;
      usage.cacheWriteInputTokens += event.data.cacheWriteTokens ?? 0;
      usage.outputTokens += event.data.outputTokens ?? 0;
      usage.reasoningOutputTokens += event.data.reasoningTokens ?? 0;
      usage.totalTokens += (event.data.inputTokens ?? 0) + (event.data.outputTokens ?? 0);
    });
    try {
      /** 按传入的 token 上限切批，避免整段历史超过模型窗口。 */
      const maximumCharacters = Math.max(4_000, input.batchTokens * 3);
      let batch = '';
      for (const entry of input.entries) {
        const serialized = JSON.stringify({ role: entry.role, content: entry.content }) + '\n';
        if (batch && batch.length + serialized.length > maximumCharacters) {
          const response = await session.sendAndWait({ prompt: `${input.customInstructions}\nPrevious summary:\n${summary}\nHistory:\n${batch}` });
          if (!response?.data.content) throw new Error('Copilot 历史摘要没有返回正文。');
          summary = response.data.content;
          batches += 1;
          batch = '';
        }
        batch += serialized;
      }
      if (batch) {
        const response = await session.sendAndWait({ prompt: `${input.customInstructions}\nPrevious summary:\n${summary}\nHistory:\n${batch}` });
        if (!response?.data.content) throw new Error('Copilot 历史摘要没有返回正文。');
        summary = response.data.content;
        batches += 1;
      }
      binding.importedSummary = summary;
      return { summary, usage, batches };
    } finally {
      unsubscribe();
      await session.disconnect();
      await (await this.options.manager.ensureReady()).deleteSession(session.sessionId);
    }
  }

  /** 停止当前 SDK 回合，不删除会话历史。 */
  async interruptRun(input: InterruptAgentRunInput): Promise<void> {
    const binding = this.requireBinding(input.session.nativeSessionId);
    if (binding.activeRunId !== input.nativeRunId) return;
    await binding.session.abort();
  }

  /** Zeus 的审批和问答沿用 Core broker 的等待身份。 */
  async respondToInteraction(input: RespondAgentInteractionInput): Promise<void> {
    if (!this.options.toolBroker.respond) throw new Error('Copilot 工具交互当前无法回答。');
    await this.options.toolBroker.respond(input);
  }

  /** 只读取 SDK 当前会话历史，不改变 Core 持久投影。 */
  async readSession(input: ReadAgentSessionInput): Promise<AgentSessionSnapshot> {
    const binding = this.requireBinding(input.session.nativeSessionId);
    return { session: binding.identity, state: binding.activeRunId ? 'active' : 'idle', raw: await binding.session.getEvents() };
  }

  /** 旧进程不可用时创建新代次；具体提交只能由上层核对后显式续跑。 */
  async recover(): Promise<void> {
    await this.recoverRuntime({ reason: 'explicit_runtime_need' });
  }

  /** SDK 世代故障后只恢复传输，不重发任何可能已写出的请求。 */
  async recoverRuntime(_input: { reason: 'explicit_user_action' | 'explicit_runtime_need' }): Promise<AgentRuntimeHealthSnapshot> {
    this.lifecycle = 'recovering';
    for (const binding of this.bindings.values()) binding.unsubscribe();
    this.bindings.clear();
    await this.options.manager.close();
    this.generationId = null;
    await this.requireAuthenticated();
    return this.getRuntimeHealth();
  }

  /** 宿主关闭时断开各会话并停止托管进程，保留 SDK 的历史文件。 */
  async close(_input: { mode: 'handoff' | 'final' }): Promise<void> {
    this.lifecycle = 'closing';
    for (const binding of this.bindings.values()) {
      binding.unsubscribe();
      await binding.session.disconnect();
    }
    this.bindings.clear();
    await this.options.manager.close();
    this.generationId = null;
    this.lifecycle = 'stopped';
  }

  /** 向 Core 提供 Provider 进程状态；SDK 不公开子进程 PID 时保持 null。 */
  getRuntimeHealth(): AgentRuntimeHealthSnapshot {
    return {
      agentKind: 'copilot',
      transport: 'sdk',
      generationId: this.generationId,
      lifecycle: this.lifecycle,
      protocolVersion: null,
      processId: null,
      checkedAt: this.now(),
      consecutiveFailures: this.consecutiveFailures,
      circuit: { state: this.lifecycle === 'degraded' ? 'open' : 'closed', openedAt: this.lastFailure?.occurredAt ?? null, reason: this.lastFailure?.kind ?? null, recovery: 'explicit' },
      lastFailure: this.lastFailure,
    };
  }

  /** 事件订阅由 Core 持有，调用者取消后不再收到后续原生事件。 */
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 运行期重载 system context 和 Skill 目录，保证每轮冻结配置进入原生会话。 */
  private async send(input: StartAgentRunInput, mode: 'enqueue' | 'immediate'): Promise<AcceptedAgentRun> {
    const binding = this.requireBinding(input.session.nativeSessionId);
    if (input.model?.modelId) binding.modelId = input.model.modelId;
    if (mode === 'enqueue' && binding.activeRunId) throw new Error('Copilot 会话已有运行中的轮次。');
    if (mode === 'immediate' && !binding.activeRunId) throw new Error('Copilot 插话目标轮次已结束。');
    if (mode === 'enqueue') await this.rebindForRun(binding, input);
    const runId = mode === 'immediate' ? binding.activeRunId! : `copilot_${randomUUID()}`;
    const acceptedAt = this.now();
    const acceptance = { nativeRunId: runId, acceptedAt };
    input.preflightResult?.(true);
    input.durableTransactionSync?.(acceptance);
    if (mode === 'enqueue') {
      binding.activeRunId = runId;
      binding.adapter = new CopilotSdkEventAdapter(binding.identity.nativeSessionId, runId, binding.identity.runtimeInstanceId);
    }
    binding.accepting = true;
    input.providerWriteMayStart?.();
    try {
      await binding.session.send({
        prompt: [binding.importedSummary ? `[ZEUS_IMPORTED_HISTORY_SUMMARY]\n${binding.importedSummary}\n[/ZEUS_IMPORTED_HISTORY_SUMMARY]` : null, input.content, input.untrustedContext?.content].filter(Boolean).join('\n\n'),
        mode,
        ...(input.workMode === 'plan' ? { agentMode: 'plan' as const } : {}),
        ...(input.images?.length ? { attachments: input.images.map((image) => ({ type: 'blob' as const, data: image.data, mimeType: image.mimeType })) } : {}),
      });
      binding.importedSummary = null;
      setImmediate(() => {
        binding.accepting = false;
        for (const event of binding.pendingEvents.splice(0)) this.emit(event);
      });
      return acceptance;
    } catch (error) {
      /** SDK 写出边界已越过；迟到事件仍可用于 Core 核对，不能因发送抛错而丢弃。 */
      setImmediate(() => {
        binding.accepting = false;
        for (const event of binding.pendingEvents.splice(0)) this.emit(event);
      });
      this.recordFailure(error, 'unknown', true);
      throw Object.assign(new Error('Copilot 发送结果未知，需先核对原生会话。'), { code: 'ZEUS_PROVIDER_RESULT_UNKNOWN', cause: error });
    }
  }

  /** SDK 会话重连时重设本轮可信应用上下文和已选 Skill，不继承过期工具目录。 */
  private async rebindForRun(binding: CopilotSessionBinding, input: StartAgentRunInput): Promise<void> {
    binding.unsubscribe();
    await binding.session.disconnect();
    const config = this.sessionConfig(binding.cwd, input.model?.modelId, binding.metadata, input);
    const session = await this.options.manager.resumeSession(binding.identity.nativeSessionId, config);
    if (session.sessionId !== binding.identity.nativeSessionId) {
      await session.disconnect();
      throw new Error('Copilot 轮次重绑定返回了不同的原生会话身份。');
    }
    binding.session = session;
    binding.unsubscribe = session.on((event) => {
      if (event.type === 'session.quota_observation') this.options.manager.observeQuota(event);
      if (!binding.adapter) return;
      for (const projected of binding.adapter.accept(event)) {
        if (binding.accepting) binding.pendingEvents.push(projected);
        else this.emit(projected);
        if (projected.type === 'agent_settled' || projected.type === 'runtime_error') {
          binding.activeRunId = null;
          binding.adapter = null;
        }
      }
    });
  }

  /** 每个自定义工具都回到 Zeus broker；未登记的 CLI 内置工具一律不可用。 */
  private sessionConfig(cwd: string, model?: string, metadata?: Record<string, unknown>, run?: StartAgentRunInput): SessionConfig & ResumeSessionConfig {
    const dynamic = Array.isArray(metadata?.zeusPluginTools) ? metadata.zeusPluginTools.filter(isToolSpec) : [];
    const definitions = [...readPiBuiltinToolCatalog(), ...(this.options.nativeTools ?? []), ...dynamic];
    const tools: Tool[] = definitions.map((definition) => {
      const name = definition.name.startsWith('zeus_') ? definition.name : `zeus_${definition.name}`;
      return {
        name,
        description: definition.description,
        parameters: definition.parameters,
        skipPermission: true,
        defer: definition.deferLoading ? 'auto' : 'never',
        handler: async (args, invocation) => {
          const binding = this.requireBinding(invocation.sessionId);
          if (!binding.activeRunId) throw new Error('Copilot 工具缺少活动轮次。');
          const result = await this.options.toolBroker.execute({
            requestId: invocation.requestId ?? randomUUID(),
            session: binding.identity,
            nativeRunId: binding.activeRunId,
            toolCallId: invocation.toolCallId,
            toolName: definition.name,
            args: isRecord(args) ? args : {},
            ...(invocation.signal ? { signal: invocation.signal } : {}),
          });
          const binaryResultsForLlm = result.contentItems?.filter((item) => item.type === 'image').map((item) => ({ type: 'image' as const, data: item.data, mimeType: item.mimeType }));
          return {
            textResultForLlm: result.text,
            ...(binaryResultsForLlm?.length ? { binaryResultsForLlm } : {}),
            resultType: result.isError ? 'failure' : 'success',
            ...(result.isError ? { error: result.text } : {}),
          } satisfies ToolResultObject;
        },
      };
    });
    return {
      workingDirectory: cwd,
      ...(model ? { model } : {}),
      availableTools: tools.map((tool) => `custom:${tool.name}`),
      tools,
      skipCustomInstructions: true,
      onPermissionRequest: async () => ({ kind: 'reject', feedback: '仅允许 Zeus 已登记且经过当前会话授权的工具。' }),
      ...(run?.applicationContext ? { systemMessage: { mode: 'append', content: run.applicationContext.content } } : {}),
      ...(run?.skillCatalog?.length ? { skillDirectories: [...new Set(run.skillCatalog.map((skill) => dirname(skill.path)))] } : {}),
    };
  }

  /** 绑定事件处理器，登录或恢复后仍按原生 sessionId 路由。 */
  private bind(session: CopilotSession, identity: AgentSessionIdentity, cwd: string, modelId: string, metadata: Record<string, unknown> | undefined): void {
    this.bindings.set(identity.nativeSessionId, { session, identity, cwd, modelId, importedSummary: null, metadata, activeRunId: null, adapter: null, unsubscribe: () => undefined, accepting: false, pendingEvents: [] });
  }

  /** SDK 事件只交给当前 Core 订阅者；接纳期间的事件先排队。 */
  private emit(event: AgentRuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** 找不到会话时要求上层按持久身份恢复，不能重新创建并重放消息。 */
  private requireBinding(sessionId: string): CopilotSessionBinding {
    const binding = this.bindings.get(sessionId);
    if (!binding) throw new Error('Copilot 会话未载入；请先按原生身份恢复。');
    return binding;
  }

  /** 只有 GitHub 已认证身份可以进入原生会话派发。 */
  private async requireAuthenticated(): Promise<void> {
    const status = await this.options.manager.refreshAccount();
    this.generationId ??= randomUUID();
    this.lifecycle = 'healthy';
    if (!status.authenticated) throw Object.assign(new Error('请先登录 GitHub Copilot。'), { code: 'ZEUS_COPILOT_AUTH_REQUIRED' });
  }

  /** 记录传输故障与未知结果，恢复只能显式创建新代次。 */
  private recordFailure(error: unknown, kind: AgentRuntimeFailureKind, resultUnknown: boolean): void {
    this.consecutiveFailures += 1;
    this.lifecycle = 'degraded';
    this.lastFailure = { kind, code: 'ZEUS_COPILOT_RUNTIME_FAILURE', message: error instanceof Error ? error.message : String(error), occurredAt: this.now(), resultUnknown };
  }
}

/** 工具元数据只从 Core 编译的 Plugin 快照接收完整定义。 */
function isToolSpec(value: unknown): value is PiZeusToolDefinitionSpec {
  return isRecord(value) && typeof value.name === 'string' && typeof value.description === 'string' && isRecord(value.parameters);
}

/** 运行时工具参数必须是普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
