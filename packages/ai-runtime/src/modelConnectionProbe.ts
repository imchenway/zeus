import { type Api, type AssistantMessage, type Context, type Model, type ProviderStreams, type SimpleStreamOptions, type ThinkingLevel, type Tool } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { Type } from 'typebox';
import { applyModelAuthentication, toPiModel } from './piSdkRuntimeDriver.js';
import type { ConfiguredModelCapability, ConfiguredModelDefinition, ModelCapabilityEvidence, ModelCapabilityState, ModelConnectionRecord } from './modelConnectionCatalog.js';

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
  const reasoning = probeReasoningEvidence(model, textObservation, checkedAt);
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

/** 观测到思考输出才升级为已确认；否则完全保留原证据，避免误关真实会话的思考能力。 */
function probeReasoningEvidence(model: ConfiguredModelDefinition, observation: ProbeObservation, checkedAt: string): ConfiguredModelCapability['reasoning'] {
  if (!observation.thinkingSeen) return model.capability.reasoning;
  const level = model.capability.reasoning.defaultLevel;
  return {
    ...model.capability.reasoning,
    state: 'supported',
    source: 'probe',
    checkedAt,
    reason: `已在 ${level} 档位观测到真实思考输出；其余档位仍来自上游目录声明。`,
  };
}

/** 按协议选择 Pi 的原生流式实现，与运行内核使用同一套适配器。 */
function streamApiFor(piModel: Model<Api>): ProviderStreams {
  if (piModel.api === 'anthropic-messages') return anthropicMessagesApi();
  if (piModel.api === 'openai-responses') return openAIResponsesApi();
  return openAICompletionsApi();
}

/** 执行一次真实请求并把观测结果收敛成纯数据；失败只返回原因，不抛出。 */
async function runProbeRequest(streams: ProviderStreams, piModel: Model<Api>, input: ProbeConfiguredModelInput, request: { context: Context; timeoutMs: number }): Promise<ProbeObservation> {
  const observation: ProbeObservation = { ok: false, failure: null, servedModelId: null, deltaCount: 0, thinkingSeen: false, toolCallSeen: false, usage: null };
  /** 只有目录声明支持推理时才带档位；'off' 不是 Pi 的思考档位取值。 */
  const preferredReasoning = input.model.capability.reasoning.defaultLevel;
  const reasoning: ThinkingLevel | null = piModel.reasoning && preferredReasoning !== 'off' ? preferredReasoning : null;
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
