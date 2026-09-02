import { randomUUID } from 'node:crypto';
import { parseZentaoInstanceBaseUrl, zentaoInstanceApiBase, zentaoSecretAccount, type SaveZentaoInstanceRequest, type ZentaoInstanceRecord, type ZentaoInstanceVerifyCode, type ZentaoInstanceVerifyResult } from '@zeus/shared';
import type { SecretStore } from './securityCore.js';
import type { SettingRepository } from '@zeus/storage';

const zentaoInstancesSettingKey = 'zentao.instances';
const zentaoAccountMaxLength = 200;
const zentaoVerifyTimeoutMs = 12_000;

export interface ZentaoCredentialService {
  list(): Promise<ZentaoInstanceRecord[]>;
  get(id: string): Promise<ZentaoInstanceRecord | undefined>;
  create(input: SaveZentaoInstanceRequest): Promise<ZentaoInstanceRecord>;
  createWithId(id: string, input: SaveZentaoInstanceRequest): Promise<ZentaoInstanceRecord>;
  update(id: string, input: SaveZentaoInstanceRequest): Promise<ZentaoInstanceRecord>;
  remove(id: string): Promise<void>;
  clearPassword(id: string): Promise<ZentaoInstanceRecord>;
  verify(id: string): Promise<ZentaoInstanceVerifyResult>;
}

/** 禅道实例元数据进 SQLite settings，密码只进 SecretStore。 */
export function createZentaoCredentialService(options: { settings: SettingRepository; secretStore: SecretStore; save: () => Promise<void>; now?: () => string; fetch?: typeof fetch }): ZentaoCredentialService {
  const now = options.now ?? (() => new Date().toISOString());
  const fetcher = options.fetch ?? fetch;

  function readStored(): ZentaoInstanceRecord[] {
    return normalizeStoredZentaoInstances(options.settings.getJson<unknown>(zentaoInstancesSettingKey));
  }

  async function hydrate(records = readStored()): Promise<ZentaoInstanceRecord[]> {
    return Promise.all(
      records.map(async (record) => ({
        ...record,
        passwordConfigured: Boolean(await options.secretStore.getSecret(zentaoSecretAccount(record.id))),
      })),
    );
  }

  async function write(records: readonly ZentaoInstanceRecord[]): Promise<void> {
    options.settings.setJson(
      zentaoInstancesSettingKey,
      records.map((record) => ({ ...record, passwordConfigured: false })),
    );
    await options.save();
  }

  async function requireInstance(id: string): Promise<ZentaoInstanceRecord> {
    const instance = (await hydrate()).find((candidate) => candidate.id === id);
    if (!instance) throw serviceError('ZEUS_ZENTAO_INSTANCE_NOT_FOUND', '禅道实例不存在。', 404);
    return instance;
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
    await write(records);
    return record;
  }

  async function exchangeToken(instance: ZentaoInstanceRecord, account: string, password: string): Promise<{ token: string } | { code: ZentaoInstanceVerifyCode; message: string }> {
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
      if (response.status === 400 || response.status === 401 || response.status === 403) return { code: 'auth_failed', message: '账号或密码不正确，无法换取访问令牌。' };
      if (!response.ok) return { code: 'network_failed', message: `换取访问令牌失败，HTTP ${response.status}。` };
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const token = typeof payload.token === 'string' && payload.token.trim() ? payload.token.trim() : '';
      if (!token) return { code: 'auth_failed', message: '禅道没有返回访问令牌，请检查账号密码与实例配置。' };
      return { token };
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError' ? '连接禅道实例超时，请检查地址与网络。' : '无法连接禅道实例，请检查地址与网络。';
      return { code: 'network_failed', message };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async list() {
      return hydrate();
    },
    async get(id) {
      return (await hydrate()).find((candidate) => candidate.id === id);
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
      await write(readStored().filter((candidate) => candidate.id !== id));
    },
    async clearPassword(id) {
      const existing = await requireInstance(id);
      await options.secretStore.deleteSecret(zentaoSecretAccount(id));
      return { ...existing, passwordConfigured: false, updatedAt: now() };
    },
    async verify(id) {
      const checkedAt = now();
      const instance = await requireInstance(id);
      if (!instance.account) return { ok: false, code: 'bad_request', checkedAt, message: '请先为该实例配置账号。' };
      const password = await options.secretStore.getSecret(zentaoSecretAccount(id));
      if (!password) return { ok: false, code: 'password_missing', checkedAt, message: '请先为该实例保存密码。' };
      const exchange = await exchangeToken(instance, instance.account, password);
      if ('token' in exchange) return { ok: true, code: 'verified', checkedAt, message: '登录验证通过。' };
      return { ok: false, code: exchange.code, checkedAt, message: exchange.message };
    },
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
