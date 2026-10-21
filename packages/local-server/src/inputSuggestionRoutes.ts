import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { currentDatabasePerformanceTraceId, type ConversationSnapshotV2Repository } from '@zeus/storage';
import { generateConfiguredModelText, modelRef } from '@zeus/ai-runtime';
import {
  classifyAssistantMessage,
  normalizeInputSuggestionSettings,
  normalizePerformanceTraceIdentity,
  userFacingErrorCause,
  type InputSuggestionRequest,
  type InputSuggestionResult,
  type InputSuggestionModelOption,
  type InputSuggestionSettings,
} from '@zeus/shared';
import type { ModelConnectionService } from './modelConnectionService.js';
import { createCodexTextPool, type CodexTextGenerationOptions } from './gitCommitCodexGeneration.js';
import { createInputSuggestionContextReader, inputSuggestionSourcesFingerprint, type InputSuggestionSources } from './inputSuggestionContext.js';
import type { InputSuggestionDiagnostic } from './inputSuggestionDiagnostics.js';

/** 建议以有依据的用户意图为起点，组织模型可理解和执行的专业提示词。 */
const inputSuggestionInstructions = `目的：根据对话、任务资料和已确认记忆，替用户生成下一条要发给 AI 助手的消息，供用户预览和选择，不自动发送。

要求：
1. 以用户意图为准，保留仍有效的原始目标和约束。
2. 用户是发信人，助手是收信人。正文的“我”指用户，“你”指 AI 助手，原文引用除外。
3. 围绕未解决的问题写追问、纠偏、补充或授权下一步；信息不足时，围绕实际缺失的信息提出具体澄清。不要重复已回答的问题、只作催促或重新启动正在执行的工作；
4. 可以推测用户的回应，以及推测的用户意图来生成表达清晰的提示词用于发送给 AI 助手。
5. 风格沿用用户的语言、语气和术语，表达自然具体。

输出：始终只给一条可直接发送给 AI 助手的提示词。不返回空白或 NO_SUGGESTION。`;

/** 主动点击表达起草意愿，但不等于用户批准候选中的新决定或执行操作。 */
const manualInputSuggestionInstructions = '\n\n本次由用户主动请求建议，任务进行中也可围绕未解决的问题起草具体追问或纠偏；这不构成新的执行授权。';

/** 润色允许识别意图并适度扩写，扩写只服务于当前目标，不能扩大事实或授权边界。 */
const inputPolishInstructions = `目的：将用户尚未发送的草稿整理为清楚、自然、可直接交给 AI 助手的专业提示词，可按已有意图适度扩写。

要求：
1. 当前草稿和用户最新修正优先，结合对话、任务资料和已确认记忆，明确任务对象、目的和期望结果。
2. 始终以用户对 AI 助手说话的视角表达，保留实际行为归属和原文引用；不能把助手的操作、解释、道歉或承诺写成用户做的事。
3. 可补足实现已有目标直接需要的步骤、要求和交付内容，补充必须有草稿或上下文依据，作为待执行要求表达。
4. 保留有效约束、否定条件、例外和不确定性；代码、路径、链接、数字及 @ 和 / 引用标签原样保留，不增删引用。沿用用户的语言、语气和术语，按需要分段或列点，不套固定模板。

输出：始终只给完整的提示词正文，不加改写说明、分析、多个方案或外围引号。不返回空白或 NO_SUGGESTION。`;

/** 所有生成场景以实际目录能力确定最低档位，不猜测供应商参数。 */
function lowestSuggestionEffort(options: readonly string[]): string | undefined {
  return ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].find((value) => options.includes(value)) ?? options[0];
}

/** 两种模式共用正文校验，空白及放弃标记按无效输出处理，不触发自动补调。 */
export function normalizeInputSuggestion(text: string, mode: InputSuggestionRequest['mode'] = 'suggest'): string {
  /** 模型围栏属于展示包装，不属于用户将采纳的正文。 */
  const cleaned = text
    .trim()
    .replace(/^```[^\n]*\n/u, '')
    .replace(/\n```$/u, '')
    .trim();
  if (!cleaned || cleaned === 'NO_SUGGESTION') throw Object.assign(new Error('未生成有效的输入建议，请重试。'), { code: 'ZEUS_INPUT_SUGGESTION_OUTPUT_INVALID' });
  return mode === 'polish' ? text : Array.from(cleaned).slice(0, 300).join('');
}

/** 独立生成只使用明确选中的模型和现有凭据，不回退或创建主会话。 */
async function generateSuggestionText(options: {
  /** 固定材料来自本会话已保存的对话，手动操作可以包含仍在进行的轮次。 */
  context: string;
  /** 两种模型显式接收同一份全局与项目规则，不依赖 Provider 自行发现项目文件。 */
  agentRules: string | null;
  /** 明确区分预测下一句与保留原意的草稿润色。 */
  mode: InputSuggestionRequest['mode'];
  /** 主动与自动触发都要求正文，主动请求额外允许围绕进行中的任务起草。 */
  trigger: InputSuggestionRequest['trigger'];
  /** 档位来自输入建议自己的设置，空值才自动选择最低。 */
  effort: string | null;
  /** 专用速度设置与主会话独立，调用前已核对当前模型目录。 */
  serviceTier: 'priority' | null;
  /** 已保存并捕获的专用模型身份。 */
  selectedModelRef: string;
  /** API 连接使用现有鉴权和协议映射。 */
  modelConnections: ModelConnectionService;
  /** 当前宿主的 Codex 运行身份，不读取全局终端配置。 */
  codexOptions: () => CodexTextGenerationOptions;
  /** 所有 Provider 共用 20 秒总取消信号。 */
  signal: AbortSignal;
  /** 只解析用户选中的模型，不等待无关供应商的目录。 */
  selected: InputSuggestionModelOption;
  /** 建议专用池与提交说明分别拥有自己的进程。 */
  codexPool: ReturnType<typeof createCodexTextPool>;
  /** 只有真正开始请求模型时才结束准备计时。 */
  onGenerationStarted: () => void;
  /** 状态与计数不携带正文，所有阶段沿用本次请求的诊断身份。 */
  onDiagnostic: (entry: InputSuggestionDiagnostic) => void;
}): Promise<string> {
  /** 模型失效时不改用其他模型产生用量。 */
  const selected = options.selected;
  /** 生成档位与会话本身的推理设置分开。 */
  const effort = options.effort ?? lowestSuggestionEffort(selected.supportedReasoningEfforts ?? []);
  /** 两种操作共享模型预算，仅通过提示词区分正文要求。 */
  const instructions = options.mode === 'polish' ? inputPolishInstructions : inputSuggestionInstructions + (options.trigger === 'manual' ? manualInputSuggestionInstructions : '');
  /** 规则单独保留完整正文，不挤占对话预算，也不把其中的执行要求当作本次工具授权。 */
  const system = options.agentRules
    ? `${instructions}\n\n以下全局和项目规则按所列优先级约束生成内容的语言、表达、业务要求和权限边界。当前任务仅是起草或改写用户消息，不执行规则中的操作，也不新增执行授权。\n\n${options.agentRules}`
    : instructions;
  options.onDiagnostic({ event: 'generation_configured', effort: effort ?? 'default', inputCharacters: options.context.length, promptHash: createHash('sha256').update(system).digest('hex').slice(0, 16) });
  if (options.selectedModelRef.startsWith('codex:')) {
    /** 所选 Codex 才读取宿主配置，准备阶段包括进程、账户和临时线程。 */
    const codexOptions = options.codexOptions();
    /** Codex 复用提交说明的租用实现，每次创建独立临时线程。 */
    const result = await options.codexPool.generate(
      { modelRef: options.selectedModelRef, system, prompt: options.context, effort, serviceTier: options.serviceTier },
      {
        ...codexOptions,
        signal: options.signal,
        timeoutMs: 20_000,
        stopOnRetry: true,
        onProgress: (stage, elapsedMs) => {
          codexOptions.onProgress?.(stage, elapsedMs);
          options.onDiagnostic({ event: 'codex_stage', stage });
          if (stage === '等待模型响应') options.onGenerationStarted();
        },
      },
    );
    return result.text;
  }
  /** 已配置 API 模型使用没有工具的文本生成通路。 */
  const connections = await options.modelConnections.loadRuntimeConnections(options.selectedModelRef);
  for (const connection of connections) {
    if (!connection.enabled || !connection.apiKey) continue;
    /** 完整目录身份同时绑定连接和模型。 */
    const model = connection.models.find((entry) => entry.enabled && modelRef(connection.id, entry.id) === options.selectedModelRef);
    if (!model) continue;
    options.onDiagnostic({ event: 'provider_selected', protocol: model.protocolFamily, maxTokens: model.maxTokens });
    options.onGenerationStarted();
    return generateConfiguredModelText({
      connection,
      model,
      apiKey: connection.apiKey,
      system,
      text: options.context,
      effort,
      /** 推理与正文可能共用输出额度；沿用所选模型上限，不能用短建议长度压缩推理空间。 */
      maxTokens: model.maxTokens,
      maxRetries: 0,
      timeoutMs: 20_000,
      signal: options.signal,
      onDiagnostic: (entry) => options.onDiagnostic({ ...entry }),
    });
  }
  throw new Error('输入建议模型不可用。');
}

/** 在模型调用前校验主动操作与草稿边界，防止自动事件发送未提交草稿。 */
function validInputSuggestionRequest(value: unknown): value is InputSuggestionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  /** 请求只携带操作和会话身份，不允许覆盖模型配置。 */
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => !['mode', 'trigger', 'projectId', 'conversationId', 'completedTurnId', 'draft'].includes(key))) return false;
  if (!['suggest', 'polish'].includes(String(request.mode)) || !['automatic', 'manual'].includes(String(request.trigger))) return false;
  for (const key of ['projectId', 'conversationId', 'completedTurnId']) {
    if (request[key] !== undefined && (typeof request[key] !== 'string' || !request[key].trim() || request[key].length > 256)) return false;
  }
  if (request.conversationId && !request.projectId) return false;
  if (request.draft !== undefined && (typeof request.draft !== 'string' || request.draft.length > 16_000)) return false;
  if (request.mode === 'polish') return request.trigger === 'manual' && typeof request.draft === 'string' && Boolean(request.draft.trim());
  return !request.draft && (request.trigger === 'manual' || Boolean(request.projectId && request.conversationId && request.completedTurnId));
}

/** 建议与润色共用有界生成；新会话的主动草稿润色不创建会话或执行任务。 */
export function registerInputSuggestionRoutes(options: {
  /** 复用本地 Core 的路由与鉴权边界。 */
  server: FastifyInstance;
  /** 所有 Provider 共用持久快照和受控正文读取。 */
  repository: ConversationSnapshotV2Repository;
  /** 先核对项目存在性，避免错误项目读取正文。 */
  projectExists: (projectId: string) => boolean;
  /** 会话记录拥有所属项目身份。 */
  getConversation: (conversationId: string) => { projectId: string } | undefined;
  /** 尚未建立轮次的新提交也阻止生成，不能只看 activeTurn。 */
  hasPendingSubmission: (conversationId: string) => boolean;
  /** 设置变化立即用于取消或拒绝过期输出。 */
  readSettings: () => InputSuggestionSettings | undefined;
  /** API 生成复用现有连接。 */
  modelConnections: ModelConnectionService;
  /** 建议和提交说明共用完整模型目录。 */
  loadModels: () => Promise<{ items: Array<InputSuggestionModelOption & { supportedReasoningEfforts?: string[] }>; warning: string }>;
  /** 生成只查选中模型；设置页面仍可读取完整目录。 */
  loadModel: (modelRef: string) => Promise<InputSuggestionModelOption | undefined>;
  /** 每次从当前项目和会话读取规则、任务描述及已生效记忆。 */
  readSources: (projectId?: string, conversationId?: string) => Promise<InputSuggestionSources>;
  /** 当前任务运行身份在每次调用时读取。 */
  codexOptions: () => CodexTextGenerationOptions;
  /** 正式宿主写入有界本机日志；只读验收可以不配置落盘。 */
  recordDiagnostic?: (entry: InputSuggestionDiagnostic) => void;
  /** 关闭生成池后再排空已收到的诊断记录。 */
  flushDiagnostics?: () => Promise<void>;
}): () => void {
  /** 材料缓存不持有草稿，所有操作复用同一取材规则。 */
  const contextReader = createInputSuggestionContextReader(options.repository);
  /** 输入建议的独立池不会取消主会话或提交说明。 */
  const codexPool = createCodexTextPool();
  /** 宿主关闭时取消并等待独立生成释放自己的进程。 */
  const pending = new Map<AbortController, Promise<unknown>>();
  /** 只取消本功能的独立请求，不影响主会话、提交说明或其他任务。 */
  const cancelPending = (reason: 'settings_changed' | 'host_shutdown' = 'settings_changed') => {
    for (const controller of pending.keys()) controller.abort(reason);
    contextReader.clear();
  };
  options.server.addHook('onClose', async () => {
    cancelPending('host_shutdown');
    await Promise.allSettled(pending.values());
    await codexPool.close();
    await options.flushDiagnostics?.();
  });
  options.server.get('/api/input-suggestions/models', () => options.loadModels());
  options.server.post('/api/input-suggestions/generate', { bodyLimit: 128_000 }, async (request: FastifyRequest<{ Body: unknown }>, reply): Promise<InputSuggestionResult | unknown> => {
    if (!validInputSuggestionRequest(request.body)) return reply.code(400).send({ error: 'ZEUS_INPUT_SUGGESTION_INVALID', message: '输入建议请求无效，草稿最多支持 16,000 个字符。' });
    /** 后续材料只来自已校验的请求，草稿不会写入会话历史。 */
    const input = request.body;
    /** 所属关系在任何正文读取之前核对。 */
    const { projectId, conversationId } = input;
    if ((projectId && !options.projectExists(projectId)) || (conversationId && options.getConversation(conversationId)?.projectId !== projectId))
      return reply.code(404).send({ error: 'ZEUS_CONVERSATION_NOT_FOUND', message: '会话不存在。' });
    /** 当前请求捕获模型身份，生成期间不切换模型。 */
    const settings = normalizeInputSuggestionSettings(options.readSettings());
    /** 复用既有 HTTP trace 头；无效或非界面调用使用独立随机身份。 */
    const suppliedTraceId = request.headers['x-zeus-trace-id'];
    /** 所有无建议结果使用相同形状，不改变输入框。 */
    const result: InputSuggestionResult = {
      diagnosticId: currentDatabasePerformanceTraceId() ?? normalizePerformanceTraceIdentity(suppliedTraceId) ?? randomUUID(),
      completedTurnId: input.completedTurnId ?? null,
      modelRef: settings.modelRef,
      text: null,
      reason: 'disabled',
    };
    /** 仅记录阶段时长和结果，不记录提示词、草稿或记忆正文。 */
    const startedAt = performance.now();
    /** 所有旁路记录携带相同身份；日志异常不能影响用户操作。 */
    const record = (entry: InputSuggestionDiagnostic): void => {
      try {
        options.recordDiagnostic?.({ ...entry, requestId: result.diagnosticId, projectId, conversationId, mode: input.mode, trigger: input.trigger, modelRef: settings.modelRef, elapsedMs: Math.round(performance.now() - startedAt) });
      } catch {
        /* 日志失败不改变生成结果。 */
      }
    };
    record({ event: 'request_started', effort: settings.effort ?? 'automatic' });
    if ((input.trigger === 'automatic' && !settings.enabled) || !settings.modelRef) {
      result.reason = settings.modelRef ? 'disabled' : 'model_unavailable';
      record({ event: 'request_finished', outcome: result.reason });
      return result;
    }
    /** 三个阶段合计包含本地准备和远端等待。 */
    const timings = { material: 0, model: 0, generation: 0 };
    /** 失败和超时也记录当前阶段的等待时间。 */
    let stage: keyof typeof timings = 'material';
    /** 阶段边界使用单调时钟。 */
    let stageStartedAt = startedAt;
    /** API 调用不使用 Codex 进程；Codex 可区分冷启动和复用。 */
    let processReused: boolean | null = null;
    /** 统一切换阶段，避免仅成功请求才有耗时记录。 */
    const advanceStage = (next: keyof typeof timings) => {
      timings[stage] += performance.now() - stageStartedAt;
      stageStartedAt = performance.now();
      stage = next;
      record({ event: 'stage', stage });
    };
    /** HTTP 断开或宿主关闭时取消本次生成。 */
    const controller = new AbortController();
    /** 区分界面断开、宿主或设置取消，以及材料变化造成的过期。 */
    let cancellation: string | null = null;
    /** 总超时包含目录、账户读取、线程初始化和模型生成。 */
    const deadline = AbortSignal.timeout(20_000);
    /** 用户取消与总超时分别反馈，不能把模型失败当成没有合理建议。 */
    const signal = AbortSignal.any([controller.signal, deadline]);
    /** 取消竞态的两个收口路径必须返回同一种原因。 */
    const cancelledResult = (): InputSuggestionResult => ({ ...result, reason: deadline.aborted ? 'timed_out' : 'cancelled' });
    /** 已发送回执的正常关闭不能取消其他请求。 */
    const disconnect = () => {
      if (!reply.raw.writableEnded) {
        cancellation = 'client_disconnected';
        controller.abort();
      }
    };
    reply.raw.once('close', disconnect);
    /** 生成任务保留真实清理承诺，供宿主退出等待。 */
    const run = async (): Promise<InputSuggestionResult> => {
      try {
        /** 主动操作可使用已打开的历史会话；自动操作仍核对刚完成轮次。 */
        const snapshot = conversationId ? options.repository.readSnapshot(conversationId, { closedTurnLimit: 1, includeSessionMetrics: false }) : null;
        if (snapshot?.conversation.archived || (input.trigger === 'automatic' && (snapshot?.activeTurn || (conversationId && options.hasPendingSubmission(conversationId))))) return { ...result, reason: 'context_unavailable' };
        /** 本地轮次身份用于生成前后核对，新草稿可以没有历史。 */
        const latestTurnId = snapshot?.recentClosedTurns[0]?.id ?? null;
        /** 自动触发仍绑定真实成功轮次，不把旧回复或阶段进展当成最终回复。 */
        const latest = snapshot?.recentClosedTurns[0];
        if (
          input.trigger === 'automatic' &&
          (!conversationId ||
            !latest ||
            options.repository.resolveTurnId(conversationId, input.completedTurnId!) !== latest.id ||
            latest.status !== 'completed' ||
            latest.hasError ||
            !latest.completionOutput ||
            latest.completionOutput.role !== 'assistant' ||
            latest.completionOutput.reasoningSummary ||
            Boolean(latest.completionOutput.toolPairId) ||
            classifyAssistantMessage({ ...latest.completionOutput.assistantMessage }, latest.completionOutput.phase) !== 'final')
        )
          return { ...result, reason: 'context_unavailable' };
        /** 读取文件前冻结用户要求的水位，读取期间的新要求也会使候选失效。 */
        const userRevision = conversationId ? contextReader.userRevision(conversationId) : '';
        /** 规则读取纳入原有总时限，失败不能静默退回不带规则的生成。 */
        const sources = await options.readSources(projectId, conversationId);
        signal.throwIfAborted();
        /** 对话、任务和记忆仍用原预算，规则在共同生成入口单独注入。 */
        const context = contextReader.read({ snapshot, projectId, sources, draft: input.draft });
        if (input.mode === 'suggest' && !context.hasDialogue) return { ...result, reason: 'context_unavailable' };
        /** 目录加载和生成都是异步边界，每次跨过边界都重新核对本轮归属。 */
        const isCurrent = async (): Promise<boolean> => {
          /** 先完成异步规则读取，再核对设置和会话，避免读取期间的变化被遗漏。 */
          const currentSources = await options.readSources(projectId, conversationId);
          signal.throwIfAborted();
          /** 设置变化不能让本次调用带着旧模型或深度继续。 */
          const current = normalizeInputSuggestionSettings(options.readSettings());
          if ((input.trigger === 'automatic' && current.enabled !== settings.enabled) || current.modelRef !== settings.modelRef || current.effort !== settings.effort || current.serviceTier !== settings.serviceTier) {
            cancellation = 'settings_changed';
            return false;
          }
          if (inputSuggestionSourcesFingerprint(currentSources) !== context.sourcesFingerprint) {
            cancellation = 'sources_changed';
            return false;
          }
          if (!conversationId) return true;
          /** 新要求或会话重建使旧候选失效，普通助手进度不取消手动润色。 */
          const after = options.repository.readSnapshot(conversationId, { closedTurnLimit: 1, includeSessionMetrics: false });
          /** 持久状态变化单独记录为材料失效，不归为模型故障。 */
          const currentContext =
            after.conversation.projectId === projectId &&
            !after.conversation.archived &&
            after.orderEpoch === snapshot?.orderEpoch &&
            after.eventStreamGeneration === snapshot?.eventStreamGeneration &&
            contextReader.userRevision(conversationId) === userRevision &&
            (input.trigger === 'manual' || (!options.hasPendingSubmission(conversationId) && !after.activeTurn && (after.recentClosedTurns[0]?.id ?? null) === latestTurnId));
          if (!currentContext) cancellation = 'conversation_changed';
          return currentContext;
        };
        advanceStage('model');
        /** 生成只解析选中模型，API 请求不等待 Codex 目录或账户读取。 */
        const selected = await options.loadModel(settings.modelRef!);
        signal.throwIfAborted();
        if (!(await isCurrent())) return { ...result, reason: 'cancelled' };
        /** 显式档位失效必须说明原因，不能悄悄换成更深或更浅的档位。 */
        if (!selected) return { ...result, reason: 'model_unavailable' };
        if (settings.effort && !selected.supportedReasoningEfforts?.includes(settings.effort)) return { ...result, reason: 'effort_unavailable' };
        // 能力失效时保留明确错误，不把已选 Fast 静默改成标准速度。
        if (settings.serviceTier && !selected.serviceTiers?.some((tier) => tier.id === settings.serviceTier)) return { ...result, reason: 'service_tier_unavailable' };
        /** JSON 分区说明材料身份，草稿中的角色文字不提升为生成指令。 */
        const material = input.mode === 'polish' ? JSON.stringify({ conversation: context.text, draft: input.draft }) : context.text;
        /** 纯文本生成不注册执行工具，也不进入任务或提交队列。 */
        const text = await generateSuggestionText({
          context: material,
          agentRules: sources.agentRules,
          mode: input.mode,
          trigger: input.trigger,
          effort: settings.effort ?? null,
          serviceTier: settings.serviceTier ?? null,
          selectedModelRef: settings.modelRef!,
          modelConnections: options.modelConnections,
          codexOptions: () => ({
            ...options.codexOptions(),
            onReuse: (reused) => {
              processReused = reused;
            },
          }),
          signal,
          selected,
          codexPool,
          onGenerationStarted: () => advanceStage('generation'),
          onDiagnostic: record,
        });
        record({ event: 'model_result', outputKind: !text.trim() ? 'empty' : text.trim() === 'NO_SUGGESTION' ? 'explicit_no_suggestion' : 'text', outputCharacters: text.length });
        signal.throwIfAborted();
        /** 主会话或设置已经变化时不返回旧建议。 */
        if (!(await isCurrent())) return { ...result, reason: 'cancelled' };
        /** 两种模式都拒绝空白和放弃标记，原文已合适时保留明确反馈。 */
        const suggestion = normalizeInputSuggestion(text, input.mode);
        if (input.mode === 'polish' && suggestion.trim() === input.draft?.trim()) return { ...result, reason: 'no_change' };
        return { ...result, text: suggestion, reason: null };
      } catch (error) {
        /** 仅保存错误码，不持久化可能包含供应商报文的错误正文。 */
        const cause = userFacingErrorCause(error);
        record({ event: 'generation_failed', stage, errorCode: cause.code ?? cause.cause?.code ?? 'unclassified' });
        // 可选功能失败不影响正文；沿用统一脱敏边界保留真实原因，供用户按需查看。
        return signal.aborted ? cancelledResult() : { ...result, reason: 'failed', cause };
      }
    };
    /** 将真实调用与宿主清理绑定，不另建任务安排。 */
    const operation = run().finally(() => pending.delete(controller));
    pending.set(controller, operation);
    /** 目录 RPC 不能取消共享传输，HTTP 仍严格按总时限返回空建议。 */
    let resolveAborted: () => void = () => {};
    /** 信号到期后，迟到目录结果在运行函数内被拒绝，不再发起模型调用。 */
    const aborted = new Promise<InputSuggestionResult>((resolve) => {
      resolveAborted = () => resolve(cancelledResult());
    });
    signal.addEventListener('abort', resolveAborted, { once: true });
    if (signal.aborted) resolveAborted();
    /** 统计无需改写、取消、超时和失败，不用正文判断生成成功。 */
    let outcome: InputSuggestionResult['reason'] = 'cancelled';
    /** 最终回执只记录字数，未完成或失败时保持为零。 */
    let outputCharacters = 0;
    try {
      /** 单一回执也保证只记录一次端到端耗时。 */
      const response = await Promise.race([operation, aborted]);
      outcome = response.reason;
      outputCharacters = response.text?.length ?? 0;
      return response;
    } finally {
      timings[stage] += performance.now() - stageStartedAt;
      record({
        event: 'request_finished',
        outcome: outcome ?? 'generated',
        stage,
        cancellation: outcome === 'timed_out' ? 'deadline' : outcome === 'cancelled' ? (cancellation ?? (typeof controller.signal.reason === 'string' ? controller.signal.reason : 'cancelled')) : null,
        processReused,
        outputCharacters,
        materialMs: Math.round(timings.material),
        modelPreparationMs: Math.round(timings.model),
        generationMs: Math.round(timings.generation),
      });
      console.info(
        JSON.stringify({
          event: 'input_suggestion_generation',
          mode: input.mode,
          trigger: input.trigger,
          outcome: outcome ?? 'generated',
          processReused,
          materialMs: Math.round(timings.material),
          modelPreparationMs: Math.round(timings.model),
          generationMs: Math.round(timings.generation),
          totalMs: Math.round(performance.now() - startedAt),
        }),
      );
      signal.removeEventListener('abort', resolveAborted);
      reply.raw.off('close', disconnect);
      controller.abort();
    }
  });
  return cancelPending;
}
