import type { BrowserTranslationSegment, FreeBrowserTranslationService } from '@zeus/shared';

/** 公共翻译失败仅公开服务和原因，不把请求正文或供应商原始响应交给界面。 */
export class BrowserFreeTranslationError extends Error {}

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
    throw new BrowserFreeTranslationError(response.status === 429 ? `${label}请求过于频繁，请稍后重试或在翻译服务菜单中切换服务。` : `${label}暂不可用（HTTP ${response.status}），请重试或切换翻译服务。`);
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

/** Google 单次只接收一段，不能拼接多段后用标点猜测译文边界。 */
async function translateGoogle(segments: BrowserTranslationSegment[], signal: AbortSignal): Promise<BrowserTranslationSegment[]> {
  /** 同一批串行发送，失败即停止，不增加自动重试或并发压力。 */
  const translated: BrowserTranslationSegment[] = [];
  for (const segment of segments) {
    signal.throwIfAborted();
    /** gtx 公共文本接口不使用 Google Cloud 项目或 API Key。 */
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.search = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'zh-CN', dt: 't', dj: '1', q: segment.text }).toString();
    /** 接口按句返回，一个输入段落可能包含多个句子。 */
    const result = (await requestFreeTranslation(url, signal, 'Google 免费翻译')) as { sentences?: unknown } | null;
    if (!Array.isArray(result?.sentences) || !result.sentences.length) throw new Error('Incomplete Google translation');
    /** 保留服务返回的句间空白，最后统一校验整段。 */
    const text = result.sentences
      .map((sentence: unknown) => {
        if (!sentence || typeof sentence !== 'object' || !('trans' in sentence) || typeof sentence.trans !== 'string') throw new Error('Invalid Google translation sentence');
        return sentence.trans;
      })
      .join('');
    translated.push({ id: segment.id, text: requireTranslationText(text) });
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
