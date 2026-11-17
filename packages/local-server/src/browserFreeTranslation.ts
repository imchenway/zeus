import type { BrowserTranslationSegment, FreeBrowserTranslationService } from '@zeus/shared';
import { setTimeout as delay } from 'node:timers/promises';

/** Google 公共接口的初始请求间隔，单位毫秒；这是本地保护值，不代表供应商配额。 */
const googleRequestIntervalMs = 1000;
/** 429 没有有效 Retry-After 时的初始冷却时间，单位毫秒。 */
const rateLimitCooldownMs = 60_000;
/** Core 只在内存中保留最近插入的 256 段 Google 译文。 */
const googleTranslationCacheLimit = 256;
/** 所有标签共用一条 Google 请求队列，失败不会阻断后续排队。 */
let googleRequestQueue: Promise<void> = Promise.resolve();
/** 下一次允许发出 Google 请求的时间，单位 Unix 毫秒。 */
let googleNextRequestAt = 0;
/** Google 限流结束前，未命中缓存的请求直接返回冷却原因。 */
let googleRetryAt = 0;
/** Google 固定使用自动源语言、简体中文目标语言，因此按完整原文缓存。 */
const googleTranslations = new Map<string, string>();

/** 公共翻译失败仅公开服务和原因，不把请求正文或供应商原始响应交给界面。 */
export class BrowserFreeTranslationError extends Error {
  /** 限流允许重试的时间，单位 Unix 毫秒；其他错误没有此值。 */
  readonly retryAt?: number;

  /** 保留可公开原因与供应商冷却期限，供调用调度和 HTTP 响应共用。 */
  constructor(message: string, retryAt?: number) {
    super(message);
    this.retryAt = retryAt;
  }
}

/** 按固定公共接口发送正文，不使用网站 Cookie、云服务密钥或模型登录。 */
async function requestFreeTranslation(url: URL, signal: AbortSignal, label: string, texts?: string[]): Promise<unknown> {
  /** 每次 HTTP 请求最多等待 20 秒；关闭页面时沿用外层取消信号。 */
  const response = await fetch(url, {
    method: texts ? 'POST' : 'GET',
    ...(texts ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(texts) } : {}),
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    if (response.status === 429) {
      /** Retry-After 支持秒数与 HTTP 日期，不把缺失或无效值当作立即重试。 */
      const retryAfter = response.headers.get('retry-after')?.trim() ?? '';
      /** 供应商期限采用 Unix 毫秒，与共享队列的时钟口径一致。 */
      const retryAt = /^\d+$/u.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
      throw new BrowserFreeTranslationError(`${label}请求过于频繁，请稍后重试或在翻译服务菜单中切换服务。`, Math.max(Date.now() + googleRequestIntervalMs, Number.isFinite(retryAt) ? retryAt : Date.now() + rateLimitCooldownMs));
    }
    throw new BrowserFreeTranslationError(`${label}暂不可用（HTTP ${response.status}），请重试或切换翻译服务。`);
  }
  return response.json();
}

/** 返回值必须是有界纯文本；网页只按 textContent 写入译文。 */
function requireTranslationText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new Error('Invalid free translation text');
  return value.trim();
}

/** 微软公共接口按数组位置返回结果，整批数量匹配后才交付页面。 */
async function translateMicrosoft(segments: BrowserTranslationSegment[], signal: AbortSignal): Promise<BrowserTranslationSegment[]> {
  /** 空源语言表示由服务检测，目标语言固定为简体中文。 */
  const url = new URL('https://edge.microsoft.com/translate/translatetext');
  url.search = new URLSearchParams({ from: '', to: 'zh-Hans', isEnterpriseClient: 'false' }).toString();
  /** 只发送段落文本；页面内部身份由本地顺序恢复。 */
  const result = await requestFreeTranslation(
    url,
    signal,
    '微软免费翻译',
    segments.map((segment) => segment.text),
  );
  if (!Array.isArray(result) || result.length !== segments.length) throw new Error('Incomplete Microsoft translation');
  return segments.map((segment, index) => {
    /** 不接受服务返回的其他目标语言或缺失的结果。 */
    const translations: unknown = result[index]?.translations;
    if (!Array.isArray(translations) || translations.length !== 1 || translations[0]?.to !== 'zh-Hans') throw new Error('Invalid Microsoft translation');
    return { id: segment.id, text: requireTranslationText(translations[0].text) };
  });
}

/** 当前冷却剩余时间只在用户请求时计算，不启动后台重试或倒计时。 */
function googleCooldownError(): BrowserFreeTranslationError {
  /** 向上取整到秒，避免界面建议的重试时间早于真正解除冷却。 */
  const seconds = Math.max(1, Math.ceil((googleRetryAt - Date.now()) / 1000));
  return new BrowserFreeTranslationError(`Google 免费翻译请求过于频繁，请在 ${seconds} 秒后重试或在翻译服务菜单中切换服务。`, googleRetryAt);
}

/** 跨标签串行调度单段 Google 请求；命中缓存不占用供应商配额。 */
function translateGoogleText(source: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  /** 已有译文可在其他段落请求期间直接交付，不必等待网络队列。 */
  const cached = googleTranslations.get(source);
  if (cached !== undefined) return Promise.resolve(cached);
  if (Date.now() < googleRetryAt) return Promise.reject(googleCooldownError());
  /** 缓存检查放在队列内，前一个相同原文成功后，后一个请求可直接复用。 */
  const request = googleRequestQueue.then(async () => {
    signal.throwIfAborted();
    /** 缓存译文不包含页面身份、Cookie 或云服务凭据。 */
    const cached = googleTranslations.get(source);
    if (cached !== undefined) return cached;
    if (Date.now() < googleRetryAt) throw googleCooldownError();
    await delay(Math.max(0, googleNextRequestAt - Date.now()), undefined, { signal });
    googleNextRequestAt = Date.now() + googleRequestIntervalMs;
    /** gtx 公共文本接口不使用 Google Cloud 项目或 API Key。 */
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.search = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', dj: '1', q: source }).toString();
    try {
      /** 接口按句返回，一个输入段落可能包含多个句子。 */
      const result = (await requestFreeTranslation(url, signal, 'Google 免费翻译')) as { sentences?: unknown } | null;
      if (!Array.isArray(result?.sentences) || !result.sentences.length) throw new Error('Incomplete Google translation');
      /** 保留服务返回的句间空白，最后统一校验整段。 */
      const text = requireTranslationText(
        result.sentences
          .map((sentence: unknown) => {
            if (!sentence || typeof sentence !== 'object' || !('trans' in sentence) || typeof sentence.trans !== 'string') throw new Error('Invalid Google translation sentence');
            return sentence.trans;
          })
          .join(''),
      );
      googleTranslations.set(source, text);
      if (googleTranslations.size > googleTranslationCacheLimit) googleTranslations.delete(googleTranslations.keys().next().value!);
      return text;
    } catch (error) {
      if (error instanceof BrowserFreeTranslationError && error.retryAt !== undefined) {
        googleRetryAt = error.retryAt;
        throw googleCooldownError();
      }
      throw error;
    }
  });
  googleRequestQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

/** Google 单次只接收一段，不能拼接多段后用标点猜测译文边界。 */
async function translateGoogle(segments: BrowserTranslationSegment[], signal: AbortSignal): Promise<BrowserTranslationSegment[]> {
  /** 单段结果沿用原身份；一段失败即停止本批，不自动重发。 */
  const translated: BrowserTranslationSegment[] = [];
  for (const segment of segments) {
    translated.push({ id: segment.id, text: await translateGoogleText(segment.text, signal) });
  }
  return translated;
}

/** 免费服务与 AI 模型共用段落契约；失败不切换到其他服务或消耗模型额度。 */
export async function translateFreeBrowserSegments(serviceId: FreeBrowserTranslationService, segments: BrowserTranslationSegment[], signal: AbortSignal): Promise<BrowserTranslationSegment[]> {
  try {
    return serviceId === 'free:microsoft' ? await translateMicrosoft(segments, signal) : await translateGoogle(segments, signal);
  } catch (error) {
    if (signal.aborted || error instanceof BrowserFreeTranslationError) throw error;
    throw new BrowserFreeTranslationError(`${serviceId === 'free:microsoft' ? '微软' : 'Google'}免费翻译连接失败或结果不完整，请重试或在翻译服务菜单中切换服务。`);
  }
}
