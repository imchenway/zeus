import { userFacingErrorCause, type UserFacingErrorCause } from '@zeus/shared';
import { randomUUID } from 'node:crypto';
import { parseZentaoInstanceBaseUrl, zentaoInstanceApiBase, zentaoSecretAccount, type SaveZentaoInstanceRequest, type ZentaoInstanceRecord, type ZentaoInstanceVerifyCode, type ZentaoInstanceVerifyResult } from '@zeus/shared';
import type { SecretStore } from './securityCore.js';
import type { SettingRepository } from '@zeus/storage';

/** 实例设置的持久化键，不保存登录令牌。 */
const zentaoInstancesSettingKey = 'zentao.instances';
/** 禅道账号的输入长度上限。 */
const zentaoAccountMaxLength = 200;
/** 单次登录验证的最长等待毫秒数。 */
const zentaoVerifyTimeoutMs = 12_000;

export interface ZentaoCredentialService {
  list(): Promise<ZentaoInstanceRecord[]>;
  get(id: string): Promise<ZentaoInstanceRecord | undefined>;
  create(input: SaveZentaoInstanceRequest): Promise<ZentaoInstanceRecord>;
  createWithId(id: string, input: SaveZentaoInstanceRequest): Promise<ZentaoInstanceRecord>;
  update(id: string, input: SaveZentaoInstanceRequest): Promise<ZentaoInstanceRecord>;
  remove(id: string): Promise<void>;
  clearPassword(id: string): Promise<ZentaoInstanceRecord>;
  /** 仅供用户主动查看单个已配置实例，列表始终只返回存在状态。 */
  revealPassword(id: string): Promise<string | null>;
  verify(id: string): Promise<ZentaoInstanceVerifyResult>;
  /** 仅供本机禅道同步服务使用；密码和令牌不会离开此服务。 */
  request(id: string, input: { path: string; method?: 'GET' | 'POST' | 'PUT'; body?: Record<string, unknown> }): Promise<{ status: number; payload: unknown }>;
  /** 读取当前账号“我的地盘”列表；禅道此接口使用 Web 会话 Cookie。 */
  requestMyWork(id: string, kind: 'task' | 'bug'): Promise<{ status: number; payload: unknown }>;
}

/** 禅道实例元数据进 SQLite settings，密码只进 SecretStore。 */
export function createZentaoCredentialService(options: { settings: SettingRepository; secretStore: SecretStore; save: () => Promise<void>; now?: () => string; fetch?: typeof fetch }): ZentaoCredentialService {
  const now = options.now ?? (() => new Date().toISOString());
  const fetcher = options.fetch ?? fetch;
  /** 登录结果只在当前宿主内有效，重启后重新验证。 */
  const authentication = new Map<string, ZentaoInstanceVerifyResult>();
  /** 凭据修订阻止旧请求恢复已经清除或替换的登录状态。 */
  const generations = new Map<string, number>();
  /** 实例列表和设置页共用正在进行的验证，避免并发重复登录。 */
  const verifications = new Map<string, Promise<ZentaoInstanceVerifyResult>>();

  /** 凭据变化后立即撤销旧登录结果。 */
  function invalidateAuthentication(id: string): void {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    authentication.delete(id);
    verifications.delete(id);
  }

  /** 网络故障不撤销已验证身份，明确认证失败才撤销。 */
  function rememberAuthentication(id: string, generation: number, result: ZentaoInstanceVerifyResult): void {
    if ((generations.get(id) ?? 0) !== generation) return;
    if (result.code === 'network_failed' && authentication.get(id)?.ok) return;
    authentication.set(id, result);
  }

  function readStored(): ZentaoInstanceRecord[] {
    return normalizeStoredZentaoInstances(options.settings.getJson<unknown>(zentaoInstancesSettingKey));
  }

  async function hydrate(records = readStored()): Promise<ZentaoInstanceRecord[]> {
    return Promise.all(
      records.map(async (record) => {
        /** 密码缺失时无论历史结果如何，均视为未登录。 */
        const passwordConfigured = Boolean(await options.secretStore.getSecret(zentaoSecretAccount(record.id)));
        /** 只将非敏感的验证结果交给界面。 */
        const result = authentication.get(record.id);
        return {
          ...record,
          passwordConfigured,
          authenticationStatus: !record.account || !passwordConfigured ? 'unauthenticated' : result?.ok ? 'authenticated' : result?.code === 'network_failed' ? 'unavailable' : 'unauthenticated',
        } as ZentaoInstanceRecord;
      }),
    );
  }

  async function write(records: readonly ZentaoInstanceRecord[]): Promise<void> {
    options.settings.setJson(
      zentaoInstancesSettingKey,
      records.map((record) => ({ ...record, passwordConfigured: false })),
    );
    await options.save();
  }

  /** 单实例操作只访问自身凭据，启动时并行验证不会重复读取所有密码。 */
  async function requireInstance(id: string): Promise<ZentaoInstanceRecord> {
    /** 元数据查找不触发其他实例的安全存储访问。 */
    const record = readStored().find((candidate) => candidate.id === id);
    if (!record) throw serviceError('ZEUS_ZENTAO_INSTANCE_NOT_FOUND', '禅道实例不存在。', 404);
    return (await hydrate([record]))[0]!;
  }

  function normalizeInput(input: SaveZentaoInstanceRequest): { host: string; basePath: string; account: string; password: string | undefined } {
    const parsed = parseZentaoInstanceBaseUrl(typeof input.baseUrl === 'string' ? input.baseUrl : '');
    if (!parsed) throw serviceError('ZEUS_ZENTAO_BASE_URL_INVALID', '实例地址必须是有效的 http/https 地址，且不包含账号、查询参数或片段。', 400);
    const account = typeof input.account === 'string' ? input.account.trim() : '';
    if (account.length > zentaoAccountMaxLength) throw serviceError('ZEUS_ZENTAO_ACCOUNT_INVALID', `账号长度不能超过 ${zentaoAccountMaxLength} 个字符。`, 400);
    // 允许只配置地址不配置账号：解析回退 HTML 抓取；无账号时密码没有意义，忽略输入。
    const password = account && typeof input.password === 'string' && input.password.trim() ? input.password : undefined;
    return { host: parsed.host, basePath: parsed.basePath, account, password };
  }

  async function saveInstance(id: string, input: SaveZentaoInstanceRequest, existing?: ZentaoInstanceRecord): Promise<ZentaoInstanceRecord> {
    const timestamp = now();
    const normalized = normalizeInput(input);
    const records = readStored();
    const duplicate = records.find((candidate) => candidate.host === normalized.host && candidate.id !== id);
    if (duplicate) throw serviceError('ZEUS_ZENTAO_DUPLICATE_HOST', `实例地址 ${normalized.host} 已配置。`, 409);
    const record: ZentaoInstanceRecord = {
      id,
      host: normalized.host,
      basePath: normalized.basePath,
      account: normalized.account,
      passwordConfigured: Boolean(normalized.password || (normalized.account ? existing?.passwordConfigured : false)),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const index = records.findIndex((candidate) => candidate.id === id);
    if (index >= 0) records[index] = record;
    else records.push(record);
    if (normalized.password) await options.secretStore.setSecret(zentaoSecretAccount(id), normalized.password);
    else if (!normalized.account) await options.secretStore.deleteSecret(zentaoSecretAccount(id));
    invalidateAuthentication(id);
    await write(records);
    await verify(id);
    return requireInstance(id);
  }

  async function exchangeToken(instance: ZentaoInstanceRecord, account: string, password: string): Promise<{ token: string } | { code: ZentaoInstanceVerifyCode; message: string; cause?: UserFacingErrorCause }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), zentaoVerifyTimeoutMs);
    try {
      const response = await fetcher(`${zentaoInstanceApiBase(instance)}/tokens`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, password }),
        signal: controller.signal,
      });
      if (response.status === 404) return { code: 'api_unavailable', message: '该实例未开启禅道 REST 接口（/api.php/v1/tokens 不存在）。' };
      if (response.status === 400 || response.status === 401 || response.status === 403)
        return { code: 'auth_failed', cause: { code: `ZEUS_ZENTAO_HTTP_${response.status}`, message: `HTTP ${response.status}` }, message: '账号或密码不正确，无法换取访问令牌。' };
      if (!response.ok) return { code: 'network_failed', cause: { code: 'ZEUS_ZENTAO_HTTP_FAILED', message: `HTTP ${response.status}` }, message: `换取访问令牌失败，HTTP ${response.status}。` };
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const token = typeof payload.token === 'string' && payload.token.trim() ? payload.token.trim() : '';
      if (!token) return { code: 'auth_failed', cause: { code: 'ZEUS_ZENTAO_TOKEN_MISSING', message: 'The response did not include a token' }, message: '禅道没有返回访问令牌，请检查账号密码与实例配置。' };
      return { token };
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError' ? '连接禅道实例超时，请检查地址与网络。' : '无法连接禅道实例，请检查地址与网络。';
      return {
        code: 'network_failed',
        message,
        cause: error instanceof Error && error.name === 'AbortError' ? { code: 'ZEUS_ZENTAO_TIMEOUT', message: 'Request timed out' } : { code: 'ZEUS_ZENTAO_CONNECT_FAILED', message: 'Connection failed', cause: userFacingErrorCause(error) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function readResponsePayload(response: Response): Promise<unknown> {
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > 4 * 1024 * 1024) throw serviceError('ZEUS_ZENTAO_RESPONSE_TOO_LARGE', '禅道响应超过安全大小限制。', 502);
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw serviceError('ZEUS_ZENTAO_RESPONSE_TOO_LARGE', '禅道响应超过安全大小限制。', 502);
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { message: text.slice(0, 512) };
    }
  }

  type ZentaoCredentialResponse = { status: number; payload: unknown };

  async function withToken(id: string, send: (instance: ZentaoInstanceRecord, token: string) => Promise<ZentaoCredentialResponse>): Promise<ZentaoCredentialResponse> {
    /** 捕获当前凭据代次，异步请求不能恢复旧登录。 */
    const generation = generations.get(id) ?? 0;
    const instance = await requireInstance(id);
    if (!instance.account) throw serviceError('ZEUS_ZENTAO_ACCOUNT_MISSING', '请先为禅道实例配置账号。', 400);
    const password = await options.secretStore.getSecret(zentaoSecretAccount(id));
    if (!password) throw serviceError('ZEUS_ZENTAO_PASSWORD_MISSING', '请先为禅道实例保存密码。', 401);
    const exchange = await exchangeToken(instance, instance.account, password);
    rememberAuthentication(id, generation, 'token' in exchange ? { ok: true, code: 'verified', checkedAt: now(), message: '登录验证通过。' } : { ok: false, ...exchange, checkedAt: now() });
    if (!('token' in exchange)) throw serviceError(`ZEUS_ZENTAO_${exchange.code.toUpperCase()}`, exchange.message, exchange.code === 'auth_failed' ? 401 : 502);

    let result = await send(instance, exchange.token);
    if (result.status === 401 || result.status === 403) {
      const refreshed = await exchangeToken(instance, instance.account, password);
      rememberAuthentication(id, generation, 'token' in refreshed ? { ok: true, code: 'verified', checkedAt: now(), message: '登录验证通过。' } : { ok: false, ...refreshed, checkedAt: now() });
      if (!('token' in refreshed)) throw serviceError(`ZEUS_ZENTAO_${refreshed.code.toUpperCase()}`, refreshed.message, refreshed.code === 'auth_failed' ? 401 : 502);
      result = await send(instance, refreshed.token);
    }
    if (result.status === 401) rememberAuthentication(id, generation, { ok: false, code: 'auth_failed', checkedAt: now(), message: '禅道登录已失效。' });
    return result;
  }

  /** 设置页显式验证和启动时的首次验证共用同一事实来源。 */
  async function verify(id: string): Promise<ZentaoInstanceVerifyResult> {
    /** 同一实例的并发验证共享结果。 */
    const existing = verifications.get(id);
    if (existing) return existing;
    /** 绑定本次凭据修订，清除密码后旧结果不再生效。 */
    const generation = generations.get(id) ?? 0;
    /** 整个验证操作只向界面返回状态，不返回令牌。 */
    const pending = (async (): Promise<ZentaoInstanceVerifyResult> => {
      const checkedAt = now();
      const instance = await requireInstance(id);
      const password = instance.account ? await options.secretStore.getSecret(zentaoSecretAccount(id)) : undefined;
      const exchange = !instance.account
        ? { code: 'bad_request' as const, message: '请先为该实例配置账号。' }
        : !password
          ? { code: 'password_missing' as const, message: '请先为该实例保存密码。' }
          : await exchangeToken(instance, instance.account, password);
      const result: ZentaoInstanceVerifyResult = 'token' in exchange ? { ok: true, code: 'verified', checkedAt, message: '登录验证通过。' } : { ok: false, ...exchange, checkedAt };
      rememberAuthentication(id, generation, result);
      return result;
    })();
    verifications.set(id, pending);
    try {
      return await pending;
    } finally {
      if (verifications.get(id) === pending) verifications.delete(id);
    }
  }

  async function request(id: string, input: { path: string; method?: 'GET' | 'POST' | 'PUT'; body?: Record<string, unknown> }): Promise<ZentaoCredentialResponse> {
    if (!input.path.startsWith('/') || input.path.includes('://')) throw serviceError('ZEUS_ZENTAO_PATH_INVALID', '禅道接口路径无效。', 400);
    return withToken(id, async (instance, token) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), zentaoVerifyTimeoutMs * 2);
      try {
        const response = await fetcher(`${zentaoInstanceApiBase(instance)}${input.path}`, {
          method: input.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            // 禅道 RESTful API v1 约定使用 Token 头；Authorization Bearer 会导致业务接口返回 401。
            Token: token,
            ...(input.body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(input.body ? { body: JSON.stringify(input.body) } : {}),
          signal: controller.signal,
        });
        return { status: response.status, payload: await readResponsePayload(response) };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw serviceError('ZEUS_ZENTAO_TIMEOUT', '连接禅道实例超时，请检查地址与网络。', 504);
        if (error && typeof error === 'object' && 'statusCode' in error) throw error;
        throw serviceError('ZEUS_ZENTAO_NETWORK_FAILED', '无法连接禅道实例，请检查地址与网络。', 502);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async function requestMyWork(id: string, kind: 'task' | 'bug'): Promise<ZentaoCredentialResponse> {
    return withToken(id, async (instance, token) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), zentaoVerifyTimeoutMs * 2);
      try {
        const workPath = kind === 'task' ? '/my-work-task.json' : '/my-work-bug-assignedTo--id_desc.json';
        const response = await fetcher(`${instance.host}${instance.basePath}${workPath}`, {
          method: 'GET',
          headers: {
            Accept: 'application/json, text/javascript, */*; q=0.01',
            Token: token,
            'User-Agent': 'Mozilla/5.0',
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: `zentaosid=${token}; lang=zh-cn; vision=rnd`,
          },
          signal: controller.signal,
        });
        return { status: response.status, payload: await readResponsePayload(response) };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw serviceError('ZEUS_ZENTAO_TIMEOUT', '连接禅道实例超时，请检查地址与网络。', 504);
        if (error && typeof error === 'object' && 'statusCode' in error) throw error;
        throw serviceError('ZEUS_ZENTAO_NETWORK_FAILED', '无法连接禅道实例，请检查地址与网络。', 502);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  return {
    async list() {
      // 每个宿主首次读取时验证已保存凭据，之后复用运行期结果。
      await Promise.all(
        readStored()
          .filter((record) => !authentication.has(record.id))
          .map((record) => verify(record.id)),
      );
      return hydrate();
    },
    async get(id) {
      /** 读取单个实例时不请求其他账号的凭据。 */
      const record = readStored().find((candidate) => candidate.id === id);
      return record ? (await hydrate([record]))[0] : undefined;
    },
    async create(input) {
      return saveInstance(`zentao_instance_${randomUUID().replace(/-/gu, '')}`, input);
    },
    async createWithId(id, input) {
      if (!/^zentao_instance_[a-zA-Z0-9_-]{8,200}$/u.test(id)) throw serviceError('ZEUS_ZENTAO_INSTANCE_ID_INVALID', '禅道实例身份无效。', 400);
      if (readStored().some((candidate) => candidate.id === id)) throw serviceError('ZEUS_ZENTAO_INSTANCE_ALREADY_EXISTS', '禅道实例已存在。', 409);
      return saveInstance(id, input);
    },
    async update(id, input) {
      const existing = await requireInstance(id);
      return saveInstance(id, input, existing);
    },
    async remove(id) {
      await requireInstance(id);
      await options.secretStore.deleteSecret(zentaoSecretAccount(id));
      invalidateAuthentication(id);
      await write(readStored().filter((candidate) => candidate.id !== id));
    },
    async clearPassword(id) {
      const existing = await requireInstance(id);
      await options.secretStore.deleteSecret(zentaoSecretAccount(id));
      invalidateAuthentication(id);
      return { ...existing, passwordConfigured: false, authenticationStatus: 'unauthenticated', updatedAt: now() };
    },
    /** 先验证实例存在，再读取所属密码，禁止将任意钥匙串键当作实例标识。 */
    async revealPassword(id) {
      await requireInstance(id);
      return (await options.secretStore.getSecret(zentaoSecretAccount(id))) ?? null;
    },
    verify,
    request,
    requestMyWork,
  };
}

function normalizeStoredZentaoInstances(value: unknown): ZentaoInstanceRecord[] {
  if (!Array.isArray(value)) return [];
  const instances: ZentaoInstanceRecord[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = typeof candidate.id === 'string' && candidate.id ? candidate.id : '';
    const host = typeof candidate.host === 'string' ? candidate.host.trim() : '';
    const basePath = typeof candidate.basePath === 'string' ? candidate.basePath : '';
    const account = typeof candidate.account === 'string' ? candidate.account : '';
    const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt : '';
    const updatedAt = typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '';
    if (!id || !host) continue;
    instances.push({ id, host, basePath, account, passwordConfigured: false, createdAt, updatedAt });
  }
  return instances;
}

function serviceError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
