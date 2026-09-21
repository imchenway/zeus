import { type Api, type AssistantMessage, type Context, type Model, type ProviderStreams, type SimpleStreamOptions, type ThinkingLevel, type Tool } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { Type } from 'typebox';
import { applyModelAuthentication, toPiModel } from './piSdkRuntimeDriver.js';
import { resolvePiThinkingLevel, type ConfiguredModelCapability, type ConfiguredModelDefinition, type ModelCapabilityEvidence, type ModelCapabilityState, type ModelConnectionRecord, type PiThinkingLevel } from './modelConnectionCatalog.js';

/** 探测单个模型的输入：供应商连接、模型定义、已解密的 API Key。 */
export interface ProbeConfiguredModelInput {
  connection: Pick<ModelConnectionRecord, 'id' | 'name' | 'baseUrl' | 'templateId'>;
  model: ConfiguredModelDefinition;
  /** 只在本次探测内使用，不落库、不写日志。 */
  apiKey: string;
  /** 沿用调用方的网络实现，便于代理和自签场景统一。 */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** 一次真实请求得到的结论，只描述本次观测，不继承任何静态声明。 */
export interface ModelProbeResult {
  modelId: string;
  ok: boolean;
  /** 服务端响应里回报的实际模型标识；服务端不回报时为 null。 */
  servedModelId: string | null;
  /** 覆盖后的能力证据，交给调用方整段替换。 */
  capability: ConfiguredModelCapability;
  /** 供界面直接展示的一句话结论。 */
  message: string;
}

/** 单次请求的观测记录；不含结论，只记录看到了什么。 */
interface ProbeObservation {
  ok: boolean;
  failure: string | null;
  servedModelId: string | null;
  deltaCount: number;
  thinkingSeen: boolean;
  toolCallSeen: boolean;
  usage: AssistantMessage['usage'] | null;
}

/** 探测用工具名，只在探测请求内出现，不与真实会话工具冲突。 */
const probeToolName = 'zeus_capability_probe';
/** 探测请求的输出预算：思考档位开启时思考内容会占用预算，留足空间再判断工具调用。 */
const probeMaxTokens = 512;
/** 单次探测请求超时；探测是可选操作，宁可给出明确失败也不长时间挂起。 */
const defaultProbeTimeoutMs = 30_000;
/** 逐档体检的档位上限：Pi 只有七个档位词，超过就不可能都发出去。 */
const maximumAuditLevels = 7;
/** 1×1 透明 PNG；只用于确认接口是否接受图片输入。 */
const probeImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 对单个已配置模型真实发送一次最小请求，用真实观测替换静态猜测。
 *
 * 判定口径：
 * - 工具调用：模型在本次响应里真的发起了 `zeus_capability_probe` 调用才算支持。
 * - 流式输出：收到任意增量事件才算支持。
 * - 用量字段：响应带回了 token 统计才算支持。
 * - 图片输入：只有上游目录已经声明支持时才真的发一张图片去验证；失败只记“未验证”，
 *   因为小图被接口拒绝不足以证明模型不支持图片。
 * - 推理档位：只有真的观测到思考输出才升级为已确认；没观测到就保持原证据，不因一次
 *   简单提问就关闭真实会话里的思考能力。
 */
export async function probeConfiguredModel(input: ProbeConfiguredModelInput): Promise<ModelProbeResult> {
  const model = input.model;
  const checkedAt = new Date().toISOString();
  const timeoutMs = input.timeoutMs ?? defaultProbeTimeoutMs;
  const piModel = toPiModel(model, `zeus-probe-${input.connection.id}`, input.connection.baseUrl);
  const streams = streamApiFor(piModel);

  const textObservation = await runProbeRequest(streams, piModel, input, {
    context: {
      systemPrompt: '你是 Zeus 的能力探测请求。只按用户指令执行，不解释，不寒暄。',
      messages: [{ role: 'user', content: `请调用 ${probeToolName} 工具，value 参数填 ok。`, timestamp: Date.now() }],
      tools: [probeToolDefinition()],
    },
    timeoutMs,
  });

  if (!textObservation.ok) {
    const reason = textObservation.failure ?? '探测请求没有成功完成。';
    return {
      modelId: model.id,
      ok: false,
      servedModelId: null,
      capability: {
        ...model.capability,
        tools: probeEvidence('unverified', checkedAt, `探测失败，无法判断工具调用：${reason}`),
        streaming: probeEvidence('unverified', checkedAt, `探测失败，无法判断流式输出：${reason}`),
        usage: probeEvidence('unverified', checkedAt, `探测失败，无法判断用量字段：${reason}`),
        imageInput: model.capability.imageInput.state === 'unsupported' ? model.capability.imageInput : probeEvidence('unverified', checkedAt, `探测失败，无法判断图片输入：${reason}`),
      },
      message: `探测失败：${reason}`,
    };
  }

  const imageEvidence = await probeImageInput(streams, piModel, input, model, checkedAt, timeoutMs);
  const reasoning = probeReasoningEvidence(model, checkedAt);
  return {
    modelId: model.id,
    ok: true,
    servedModelId: textObservation.servedModelId,
    capability: {
      reasoning,
      tools: textObservation.toolCallSeen ? probeEvidence('supported', checkedAt, '已观测到模型真实发起工具调用。') : probeEvidence('unverified', checkedAt, '请求成功，但模型没有按提示发起工具调用，工具能力无法确认。'),
      streaming: textObservation.deltaCount > 0 ? probeEvidence('supported', checkedAt, '已观测到增量流式输出。') : probeEvidence('unverified', checkedAt, '请求成功，但没有观测到增量事件，无法确认流式输出。'),
      usage: hasUsage(textObservation.usage) ? probeEvidence('supported', checkedAt, '接口在响应中返回了 token 用量。') : probeEvidence('unverified', checkedAt, '接口没有返回 token 用量字段。'),
      imageInput: imageEvidence,
    },
    message: summarizeProbe(model.id, textObservation, imageEvidence),
  };
}

/** 单个档位的体检结果：这次请求到底看到了什么，不做任何推断。 */
export interface ReasoningLevelAuditEntry {
  /** 用户词，和界面显示的一致。 */
  id: string;
  /** 这次实际交给 Pi 的中转词。 */
  piLevel: PiThinkingLevel;
  /** 这次真正发出去的取值；null 表示没有发送取值字段。 */
  wire: string | null;
  ok: boolean;
  failure: string | null;
  thinkingSeen: boolean;
  /** 服务端回报的思考 token 数；接口不回报时为 null。 */
  reasoningTokens: number | null;
}

export interface ReasoningLevelAuditResult {
  modelId: string;
  entries: ReasoningLevelAuditEntry[];
  /** 供界面直接显示的一句话结论。 */
  verdict: string;
}

/**
 * 逐档体检：把清单里的每个档位各发一次真实请求，比较服务端回报的思考用量。
 *
 * 这是唯一能证明「强度真的随档位变化」的手段——普通探测区分不了「档位生效了」和
 * 「渠道把字段吃掉了」。代价是每个档位一次真实调用，所以只由用户显式触发，且绝不写入配置。
 */
export async function auditConfiguredModelReasoningLevels(input: ProbeConfiguredModelInput): Promise<ReasoningLevelAuditResult> {
  const model = input.model;
  const timeoutMs = input.timeoutMs ?? defaultProbeTimeoutMs;
  const piModel = toPiModel(model, `zeus-probe-${input.connection.id}`, input.connection.baseUrl);
  const streams = streamApiFor(piModel);
  const entries: ReasoningLevelAuditEntry[] = [];
  // 串行执行：每个档位的结论都要独立可读，并发会互相掩盖失败原因，也更容易触发上游限流。
  for (const option of model.capability.reasoning.options.slice(0, maximumAuditLevels)) {
    const observation = await runProbeRequest(streams, piModel, input, {
      context: {
        systemPrompt: '你是 Zeus 的推理档位体检请求。只按用户指令执行，不解释，不寒暄。',
        messages: [{ role: 'user', content: '请思考后只回答：ok', timestamp: Date.now() }],
      },
      timeoutMs,
      reasoningLevel: option.piLevel,
    });
    entries.push({
      id: option.id,
      piLevel: option.piLevel,
      wire: option.wire,
      ok: observation.ok,
      failure: observation.failure,
      thinkingSeen: observation.thinkingSeen,
      // Pi 把思考 token 放在 usage.reasoning（未回报时是 undefined，不是 0）。
      reasoningTokens: observation.usage?.reasoning ?? null,
    });
  }
  return { modelId: model.id, entries, verdict: summarizeReasoningAudit(entries) };
}

/** 只根据观测到的思考用量说话，不猜档位是否"应该"生效。 */
function summarizeReasoningAudit(entries: readonly ReasoningLevelAuditEntry[]): string {
  if (entries.length === 0) return '这个模型还没有档位清单，无法体检。';
  const failed = entries.filter((entry) => !entry.ok);
  if (failed.length === entries.length) return `所有档位请求都失败了：${failed[0]?.failure ?? '未返回原因'}。`;
  const tokens = entries.filter((entry) => entry.ok).map((entry) => entry.reasoningTokens);
  if (tokens.every((value) => value === null)) return '接口没有回报思考用量，无法比较档位是否生效（只能确认请求本身成功）。';
  const distinct = new Set(tokens.filter((value): value is number => value !== null));
  if (distinct.size > 1) return `各档思考用量不同（${tokens.map((value) => value ?? '—').join(' / ')}），说明档位确实传到了模型。`;
  return '各档思考用量完全相同，可能被当前渠道忽略或该模型只有一档强度，建议只保留一个档位。';
}

/** 只有目录已经声明支持图片时才真的发图片；其余情况沿用原证据。 */
async function probeImageInput(streams: ProviderStreams, piModel: Model<Api>, input: ProbeConfiguredModelInput, model: ConfiguredModelDefinition, checkedAt: string, timeoutMs: number): Promise<ModelCapabilityEvidence> {
  if (model.capability.imageInput.state === 'unsupported') return model.capability.imageInput;
  const observation = await runProbeRequest(streams, piModel, input, {
    context: {
      systemPrompt: '你是 Zeus 的能力探测请求。只回答看到的内容，不解释。',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图片是什么颜色？只回答颜色。' },
            { type: 'image', data: probeImageBase64, mimeType: 'image/png' },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    timeoutMs,
  });
  // 小尺寸图片可能被接口以“尺寸不合规”拒绝，这种失败不足以证明模型不支持图片。
  return observation.ok ? probeEvidence('supported', checkedAt, '已用真实图片请求确认接口接受图片输入。') : probeEvidence('unverified', checkedAt, `图片请求未成功，无法确认图片输入：${observation.failure ?? '未返回原因'}`);
}

/**
 * 探测只记录「什么时候用真实请求跑过这个档位」，不改变档位清单本身。
 * 档位清单归档案/目录/用户，观测归探测：以前这里会把兜底值盖章成「已确认支持」，
 * 正是「界面写 off、实际在思考」那条假证据的来源。
 * 没观测到思考输出也照样记下探测时间：那不代表模型不支持，只代表这一次没看到。
 */
function probeReasoningEvidence(model: ConfiguredModelDefinition, checkedAt: string): ConfiguredModelCapability['reasoning'] {
  const profile = model.capability.reasoning;
  // 未识别（没有档位清单）时不留任何痕迹，否则又会被误读成「确认过一个档位」。
  if (profile.options.length === 0) return profile;
  return { ...profile, checkedAt };
}

/** 按协议选择 Pi 的原生流式实现，与运行内核使用同一套适配器。 */
function streamApiFor(piModel: Model<Api>): ProviderStreams {
  if (piModel.api === 'anthropic-messages') return anthropicMessagesApi();
  if (piModel.api === 'openai-responses') return openAIResponsesApi();
  return openAICompletionsApi();
}

/** 执行一次真实请求并把观测结果收敛成纯数据；失败只返回原因，不抛出。 */
async function runProbeRequest(streams: ProviderStreams, piModel: Model<Api>, input: ProbeConfiguredModelInput, request: { context: Context; timeoutMs: number; reasoningLevel?: PiThinkingLevel | null }): Promise<ProbeObservation> {
  const observation: ProbeObservation = { ok: false, failure: null, servedModelId: null, deltaCount: 0, thinkingSeen: false, toolCallSeen: false, usage: null };
  /**
   * 探测也走「用户词 → Pi 中转词」的同一条换算，用清单默认档跑；
   * 未识别（清单为空）时不带档位，和真实会话的行为保持一致。
   */
  const preferredReasoning = piModel.reasoning ? (request.reasoningLevel ?? resolvePiThinkingLevel(input.model.capability.reasoning)) : null;
  const reasoning: ThinkingLevel | null = preferredReasoning && preferredReasoning !== 'off' ? preferredReasoning : null;
  const options: SimpleStreamOptions = {
    apiKey: input.apiKey,
    maxTokens: probeMaxTokens,
    signal: AbortSignal.timeout(request.timeoutMs),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
  /** 认证摆放由运行内核同一函数决定，避免探测与真实会话发不同的请求头。 */
  const authenticated = (applyModelAuthentication(options, input.model.authenticationScheme) ?? options) as SimpleStreamOptions;
  let final: AssistantMessage | null = null;
  try {
    for await (const event of streams.streamSimple(piModel, request.context, authenticated)) {
      if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') observation.deltaCount += 1;
      else if (event.type === 'thinking_start') observation.thinkingSeen = true;
      else if (event.type === 'toolcall_end') observation.toolCallSeen = true;
      else if (event.type === 'done') final = event.message;
      else if (event.type === 'error') final = event.error;
    }
  } catch (error) {
    return { ...observation, failure: error instanceof Error ? error.message : '探测请求抛出未知错误。' };
  }
  if (!final) return { ...observation, failure: authenticated.signal?.aborted ? '探测请求超时。' : '探测请求没有返回任何结果。' };
  const finished = final;
  observation.servedModelId = typeof finished.responseModel === 'string' && finished.responseModel.trim() ? finished.responseModel.trim() : null;
  observation.usage = finished.usage ?? null;
  observation.thinkingSeen = observation.thinkingSeen || finished.content.some((part) => part.type === 'thinking');
  observation.toolCallSeen = observation.toolCallSeen || finished.content.some((part) => part.type === 'toolCall');
  if (finished.stopReason === 'error' || finished.stopReason === 'aborted') return { ...observation, failure: finished.errorMessage?.trim() || '探测请求被服务端或网络中断。' };
  return { ...observation, ok: true };
}

/** 用量字段只要有一项真实统计就视为接口提供了用量。 */
function hasUsage(usage: AssistantMessage['usage'] | null): boolean {
  if (!usage) return false;
  return usage.totalTokens > 0 || usage.input > 0 || usage.output > 0;
}

/** 生成探测工具定义；要求必填参数，才能区分“发起调用”和“顺口复述”。 */
function probeToolDefinition(): Tool {
  return {
    name: probeToolName,
    description: 'Zeus 能力探测工具，调用一次即可。',
    parameters: Type.Object({ value: Type.String({ description: '固定填写 ok' }) }),
  };
}

/** 服务端返回的模型标识和请求 ID 不同才值得展示，因此只回报差异情况。 */
function summarizeProbe(modelId: string, observation: ProbeObservation, imageEvidence: ModelCapabilityEvidence): string {
  const parts = [observation.toolCallSeen ? '工具调用可用' : '工具调用未确认', observation.deltaCount > 0 ? '流式可用' : '流式未确认', hasUsage(observation.usage) ? '有用量' : '无用量'];
  if (observation.servedModelId && observation.servedModelId !== modelId) parts.push(`服务端返回 ${observation.servedModelId}`);
  if (imageEvidence.state === 'supported') parts.push('支持图片');
  else if (imageEvidence.state === 'unverified' && imageEvidence.source === 'probe') parts.push('图片未确认');
  return parts.join('；');
}

/** 统一构造探针证据，保证来源与检查时间始终成对出现。 */
function probeEvidence(state: ModelCapabilityState, checkedAt: string, reason: string): ModelCapabilityEvidence {
  return { source: 'probe', state, checkedAt, reason };
}
