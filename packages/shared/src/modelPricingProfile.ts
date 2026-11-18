import { isMeteredPrice, isPricingAmount, isPricingAttribute, isPricingIdentifier, type MeteredUsage } from './meteredPricing.js';
import type { ModelPrice } from './modelPricing.js';

/** 一个已确认的费率来源可直接提供价目，或声明读取结构化响应的方式。 */
export interface ModelPricingProfile {
  /** 经来源核对的明确费率，用于没有结构化接口的表格。 */
  prices?: ModelPrice[];
  /** 将结构化接口的项目和子项目映射成统一价目。 */
  source?: {
    items: string;
    entries?: string;
    /** 必须明确承认每个可能影响价格的项目字段。 */
    fields: string[];
    /** 在 root、item、entry 中按路径读取数据的 JSON 模板。 */
    template: Record<string, unknown>;
    /** 一组明确的等值条件，用于排除无法表达的账单规则。 */
    match?: Record<string, string | number | boolean | null>;
    /** 分页游标的响应路径，下一页复用原地址及认证范围。 */
    cursor?: { path: string; parameter: string };
    bearer?: boolean;
  };
  /** 回执真实提供的计量字段；数量与适用条件使用明确的结构化路径。 */
  usage?: {
    quantities?: Array<{ meter: string; unit: string; path: string }>;
    attributes?: Record<string, string>;
  };
}

/** 公开目录价目必须明确模型、原币和完整计费规则。 */
export function isMeteredCatalogPrice(value: unknown): value is ModelPrice {
  const row = record(value);
  return (
    Object.keys(row).every((key) => ['model', 'currency', 'basis', 'evidence', 'perMillion', 'perRequest', 'metered'].includes(key)) &&
    typeof row.model === 'string' &&
    Boolean(row.model.trim()) &&
    row.model.length <= 256 &&
    typeof row.currency === 'string' &&
    /^[A-Z]{3}$/u.test(row.currency) &&
    typeof row.basis === 'string' &&
    Boolean(row.basis.trim()) &&
    row.basis.length <= 1024 &&
    typeof row.evidence === 'string' &&
    Boolean(row.evidence.trim()) &&
    row.evidence.length <= 8192 &&
    row.perMillion === null &&
    row.perRequest === null &&
    isMeteredPrice(row.metered)
  );
}

/** 数据路径只沿 JSON 自有字段读取，空路径指向当前对象。 */
export function pricingField(value: unknown, path: string): unknown {
  return path
    ? path.split('.').reduce<unknown>((current, key) => {
        const object = record(current);
        return Object.hasOwn(object, key) ? object[key] : undefined;
      }, value)
    : value;
}

/** 仅对明确的配置路径开放字段访问。 */
function isPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && (!value || value.split('.').every(isPricingIdentifier));
}

/** 定义中只有对象具备可读取字段。 */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 配置保存与调用入口共用校验，原文 JSON 与凭据分开。 */
export function parseModelPricingProfile(input: string): ModelPricingProfile {
  const invalid = () => new Error('价格源配置必须为有效的 JSON 价目、字段映射或回执映射。');
  if (typeof input !== 'string' || input.length > 120_000) throw invalid();
  let profile: ModelPricingProfile;
  try {
    profile = JSON.parse(input) as ModelPricingProfile;
  } catch {
    throw invalid();
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).some((key) => !['prices', 'source', 'usage'].includes(key))) throw invalid();
  if (profile.prices !== undefined && (!Array.isArray(profile.prices) || !profile.prices.every(isMeteredCatalogPrice))) throw invalid();
  if (profile.source !== undefined) {
    const s = profile.source;
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some((key) => !['items', 'entries', 'fields', 'template', 'match', 'cursor', 'bearer'].includes(key))) throw invalid();
    if (!isPath(s.items) || (s.entries !== undefined && !isPath(s.entries)) || !Array.isArray(s.fields) || !s.fields.length || !s.fields.every(isPricingIdentifier)) throw invalid();
    if (!s.template || typeof s.template !== 'object' || Array.isArray(s.template) || (s.bearer !== undefined && typeof s.bearer !== 'boolean')) throw invalid();
    if (
      s.match !== undefined &&
      (!s.match || typeof s.match !== 'object' || Array.isArray(s.match) || Object.entries(s.match).some(([key, value]) => !isPath(key) || !key || (value !== null && !['string', 'number', 'boolean'].includes(typeof value))))
    )
      throw invalid();
    if (s.cursor !== undefined && (!s.cursor || !isPath(s.cursor.path) || !s.cursor.path || !isPricingIdentifier(s.cursor.parameter))) throw invalid();
  }
  if (profile.usage !== undefined) {
    const usage = profile.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage) || Object.keys(usage).some((key) => !['quantities', 'attributes'].includes(key))) throw invalid();
    if (
      usage.quantities !== undefined &&
      (!Array.isArray(usage.quantities) ||
        usage.quantities.length > 32 ||
        usage.quantities.some((item) => !item || !isPricingIdentifier(item.meter) || !isPricingIdentifier(item.unit) || !isPath(item.path) || !item.path) ||
        new Set(usage.quantities.map((item) => item.meter)).size !== usage.quantities.length)
    )
      throw invalid();
    if (
      usage.attributes !== undefined &&
      (!usage.attributes ||
        typeof usage.attributes !== 'object' ||
        Array.isArray(usage.attributes) ||
        Object.entries(usage.attributes).some(([key, value]) => !isPricingAttribute(key) || !isPath(value) || !value || !value.split('.').every(isPricingAttribute)))
    )
      throw invalid();
  }
  return profile;
}

/** 请求依据来自真实用量回执；可配置计量只补充回执明确返回的值。 */
export function readMeteredUsage(value: unknown, profile: ModelPricingProfile['usage'], completed: boolean, hasTokenUsage: boolean): MeteredUsage {
  const quantities: MeteredUsage['quantities'] = [];
  /** Pi 的 input 是未缓存输入量，缓存读写分别来自独立回执字段。 */
  const standard = [
    { meter: 'input_tokens', unit: 'token', path: 'input' },
    { meter: 'output_tokens', unit: 'token', path: 'output' },
    { meter: 'cached_input_tokens', unit: 'token', path: 'cacheRead' },
    { meter: 'cache_write_tokens', unit: 'token', path: 'cacheWrite' },
    { meter: 'output_images', unit: 'image', path: 'image_count' },
  ];
  const configured = profile?.quantities ?? [];
  const measures = [...standard.filter((measure) => (measure.unit !== 'token' || hasTokenUsage) && !configured.some((entry) => entry.meter === measure.meter)), ...configured];
  for (const { meter, unit, path } of measures) {
    const quantity = pricingField(value, path);
    if (isPricingAmount(quantity)) quantities.push({ meter, unit, quantity });
  }
  if (completed && !configured.some(({ meter }) => meter === 'requests')) quantities.push({ meter: 'requests', unit: 'request', quantity: 1 });
  const attributes = Object.fromEntries(
    Object.entries(profile?.attributes ?? {}).flatMap(([key, path]) => {
      const valueAtPath = pricingField(value, path);
      return typeof valueAtPath === 'string' && valueAtPath.trim() ? [[key, valueAtPath]] : [];
    }),
  );
  return { quantities, attributes };
}
