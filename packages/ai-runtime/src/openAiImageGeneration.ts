import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams, StreamOptions, TranscriptContext, UserMessage } from '@earendil-works/pi-ai';
import { lazyStream } from '@earendil-works/pi-ai/api/lazy';
import { modelConnectionRequestEndpoint } from './modelConnectionCatalog.js';

/** OpenAI Images 使用独立端点，回执随现有 Pi 请求结束事件交给账本。 */
export const openAiImageGenerationApi: ProviderStreams = { stream, streamSimple: stream };

/** 同步生成可耗时超过文本流的响应头超时，仍采用原请求的取消信号。 */
function stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions) {
  return lazyStream(model, async () => generate(model, context, options));
}

/** 结果链接与计费张数分别取自回执，缺失张数不影响查看已经返回的图片。 */
async function* generate(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AsyncGenerator<AssistantMessageEvent> {
  const user = context.messages.filter((message): message is UserMessage => message.role === 'user').at(-1);
  const parts = Array.isArray(user?.content) ? user.content : [];
  const prompt = (typeof user?.content === 'string' ? user.content : parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')).trim();
  if (!prompt) throw new Error('生成图片需要文字提示。');
  const images = parts.flatMap((part) => (part.type === 'image' ? [`data:${part.mimeType};base64,${part.data}`] : []));
  const request = { model: model.id, prompt, ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}) };
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options?.apiKey) headers.set('Authorization', `Bearer ${options.apiKey}`);
  for (const [name, value] of Object.entries(options?.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const payload = (await options?.onPayload?.(request, model)) ?? request;
  const timeout = AbortSignal.timeout(options?.timeoutMs ?? 180_000);
  const response = await (options?.fetch ?? globalThis.fetch)(modelConnectionRequestEndpoint(model.baseUrl, 'openai_images'), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`生成图片请求失败（HTTP ${response.status}）。`);
  }
  const receipt = (await response.json()) as { data?: Array<{ url?: unknown }>; usage?: { image_count?: unknown }; request_id?: unknown };
  const count = receipt?.usage?.image_count;
  const imageCount = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  const links = Array.isArray(receipt?.data) ? receipt.data.flatMap((item) => providerImageLink(item?.url)) : [];
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-dashscope-request-id') ?? (typeof receipt?.request_id === 'string' ? receipt.request_id : undefined);
  const message: AssistantMessage & { usage: AssistantMessage['usage'] & { image_count?: number } } = {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseId: requestId,
    content: [],
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, image_count: imageCount },
  };
  yield { type: 'start', partial: message };
  const text = links.length ? links.join('\n\n') : '服务商未返回可打开的图片链接。';
  yield { type: 'done', reason: 'stop', message: { ...message, content: [{ type: 'text', text }] } };
}

/** 仅呈现 HTTPS 结果链接，图片 URL 不参与账本金额计算。 */
function providerImageLink(value: unknown): string[] {
  if (typeof value !== 'string' || !URL.canParse(value)) return [];
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password ? [`[生成的图片](<${url.href.replace(/[<>]/gu, (character) => encodeURIComponent(character))}>)`] : [];
}
