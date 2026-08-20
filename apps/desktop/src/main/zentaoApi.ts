import { net } from 'electron';
import { zentaoInstanceApiBase, type ZentaoLinkKind } from '@zeus/shared';

const ZENTAO_API_TIMEOUT_MS = 12_000;

type ZentaoApiErrorCode = 'auth_failed' | 'api_unavailable' | 'not_found' | 'network' | 'invalid_response';

class ZentaoApiError extends Error {
  constructor(
    readonly code: ZentaoApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ZentaoApiError';
  }
}

export interface ZentaoRestEndpoint {
  host: string;
  basePath: string;
  account: string;
  password: string;
}

export type ZentaoRestAttempt = { kind: 'ok'; payload: Record<string, unknown> } | { kind: 'auth_failed' } | { kind: 'api_unavailable' } | { kind: 'not_found' } | { kind: 'network' };

/** 用账号密码换取访问令牌；令牌只存在于内存，绝不落盘或回传渲染层。 */
export async function exchangeZentaoToken(endpoint: ZentaoRestEndpoint): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZENTAO_API_TIMEOUT_MS);
  try {
    const response = await net.fetch(`${zentaoInstanceApiBase(endpoint)}/tokens`, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Zeus/1.0 Safari/537.36',
      },
      body: JSON.stringify({ account: endpoint.account, password: endpoint.password }),
    });
    if (response.status === 404) throw new ZentaoApiError('api_unavailable', '该实例未开启禅道 REST 接口。');
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new ZentaoApiError('auth_failed', '账号或密码不正确。');
    if (!response.ok) throw new ZentaoApiError('network', `换取访问令牌失败，HTTP ${response.status}。`);
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const token = typeof payload.token === 'string' && payload.token.trim() ? payload.token.trim() : '';
    if (!token) throw new ZentaoApiError('invalid_response', '禅道没有返回访问令牌。');
    return token;
  } catch (error) {
    if (error instanceof ZentaoApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ZentaoApiError('network', '连接禅道实例超时。');
    throw new ZentaoApiError('network', '无法连接禅道实例。');
  } finally {
    clearTimeout(timer);
  }
}

/** 读取单个禅道对象详情；兼容直接对象与 { data: {...} } 两种返回结构。 */
export async function fetchZentaoDetail(endpoint: ZentaoRestEndpoint, zentaoKind: ZentaoLinkKind, objectId: string, token: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZENTAO_API_TIMEOUT_MS);
  const pluralKind = zentaoKind === 'bug' ? 'bugs' : zentaoKind === 'story' ? 'stories' : 'tasks';
  try {
    const response = await net.fetch(`${zentaoInstanceApiBase(endpoint)}/${pluralKind}/${objectId}`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Token: token,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Zeus/1.0 Safari/537.36',
      },
    });
    if (response.status === 401 || response.status === 403) throw new ZentaoApiError('auth_failed', '访问令牌无效或已过期。');
    if (response.status === 404) throw new ZentaoApiError('not_found', '禅道对象不存在。');
    if (!response.ok) throw new ZentaoApiError('network', `读取禅道详情失败，HTTP ${response.status}。`);
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const candidate = isRecord(payload.data) ? payload.data : payload;
    if (!isRecord(candidate)) throw new ZentaoApiError('invalid_response', '禅道详情响应格式不兼容。');
    return candidate;
  } catch (error) {
    if (error instanceof ZentaoApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ZentaoApiError('network', '读取禅道详情超时。');
    throw new ZentaoApiError('network', '无法连接禅道实例。');
  } finally {
    clearTimeout(timer);
  }
}

/** REST 优先尝试：换令牌→读详情；详情 401/403 时重换一次令牌再试，仍失败归为凭据失效。 */
export async function attemptZentaoRestDetail(endpoint: ZentaoRestEndpoint, zentaoKind: ZentaoLinkKind, objectId: string): Promise<ZentaoRestAttempt> {
  try {
    const token = await exchangeZentaoToken(endpoint);
    try {
      return { kind: 'ok', payload: await fetchZentaoDetail(endpoint, zentaoKind, objectId, token) };
    } catch (error) {
      if (!(error instanceof ZentaoApiError) || error.code !== 'auth_failed') throw error;
      const renewedToken = await exchangeZentaoToken(endpoint);
      return { kind: 'ok', payload: await fetchZentaoDetail(endpoint, zentaoKind, objectId, renewedToken) };
    }
  } catch (error) {
    if (!(error instanceof ZentaoApiError)) return { kind: 'network' };
    if (error.code === 'auth_failed') return { kind: 'auth_failed' };
    if (error.code === 'api_unavailable') return { kind: 'api_unavailable' };
    if (error.code === 'not_found') return { kind: 'not_found' };
    return { kind: 'network' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
