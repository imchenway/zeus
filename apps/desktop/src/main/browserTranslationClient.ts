import type { BrowserTranslationModel, BrowserTranslationSegment } from '@zeus/shared';

/** Main 只把正文交给自己的 Core；网页从不持有服务地址或访问令牌。 */
export function createBrowserTranslationClient(config: () => Promise<{ baseUrl: string; apiToken: string }>) {
  /** Core 重启后重新读取地址，不记录正文或令牌。 */
  async function request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    /** 读取真实运行配置，不使用开发时固定端口。 */
    const runtime = await config();
    signal.throwIfAborted();
    /** HTTP 取消沿用页面生命周期。 */
    const response = await fetch(`${runtime.baseUrl}/api/browser/translation${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${runtime.apiToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    /** Core 的可公开错误不包含供应商响应和凭据。 */
    const payload = (await response.json()) as { message?: string };
    if (!response.ok) throw new Error(payload.message || '网页翻译服务不可用。');
    return payload;
  }
  return {
    /** 仅用户选择时读取完整目录，日常翻译只检查已选模型。 */
    async models(signal: AbortSignal, modelRef?: string, source?: 'codex' | 'custom'): Promise<{ items: BrowserTranslationModel[]; warning: string; codexLoginRequired?: boolean }> {
      /** 只查询用户打开的目录，避免启动无关供应商。 */
      const query = new URLSearchParams();
      if (modelRef) query.set('modelRef', modelRef);
      if (source) query.set('source', source);
      return (await request(`/models${query.size ? `?${query}` : ''}`, signal)) as { items: BrowserTranslationModel[]; warning: string; codexLoginRequired?: boolean };
    },
    /** 同一文档每次只交付一批有界片段。 */
    async translate(serviceId: string, segments: BrowserTranslationSegment[], signal: AbortSignal): Promise<BrowserTranslationSegment[]> {
      return ((await request('', signal, { serviceId, segments })) as { segments: BrowserTranslationSegment[] }).segments;
    },
  };
}
