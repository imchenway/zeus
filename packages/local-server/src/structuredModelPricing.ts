import { isMeteredCatalogPrice, pricingField, type ModelPrice, type ModelPricingProfile } from '@zeus/shared';
import { readPricingDocument } from './modelPricingDocument.js';

/** 配置模板只复制结构化字段，可将明确的十进制金额转成数值。 */
function mapValue(value: unknown, context: object, depth = 0): unknown {
  if (depth > 16) throw new Error('价格字段映射层级过深。');
  if (Array.isArray(value)) return value.map((entry) => mapValue(entry, context, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, '$path')) {
    if (typeof object.$path !== 'string' || Object.keys(object).some((key) => !['$path', '$number', '$values'].includes(key))) return undefined;
    const field = pricingField(context, object.$path);
    if (object.$number === true) return typeof field === 'string' && /^\d+(?:\.\d+)?$/u.test(field) ? Number(field) : typeof field === 'number' ? field : undefined;
    if (object.$values && typeof object.$values === 'object' && (typeof field === 'string' || typeof field === 'number')) return Object.hasOwn(object.$values, field) ? (object.$values as Record<string, unknown>)[field] : undefined;
    return field;
  }
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, mapValue(child, context, depth + 1)]));
}

/** 标准价目 JSON 使用明确的 schema 标记，普通 JSON 不能被误认成费率。 */
export function readUnifiedPriceDocument(document: unknown): ModelPrice[] | null {
  if (pricingField(document, 'kind') !== 'model-prices') return null;
  const prices = pricingField(document, 'prices');
  if (!Array.isArray(prices) || !prices.every(isMeteredCatalogPrice)) throw new Error('价目 JSON 有无法确认的计费规则。');
  return prices;
}

/** 声明式映射可处理常见父子数组和游标分页，所有页使用同一可信价格源。 */
export async function readMappedPriceDocument(url: string, source: NonNullable<ModelPricingProfile['source']>, signal: AbortSignal, token?: string): Promise<{ prices: ModelPrice[]; unavailableModels: string[] }> {
  const prices: ModelPrice[] = [];
  const unconfirmed = new Set<string>();
  const cursors = new Set<string>();
  const allowed = new Set(source.fields);
  let next = url;
  for (let page = 0; page < 20; page += 1) {
    const root: unknown = JSON.parse(await readPricingDocument(next, signal, 0, token));
    const items = pricingField(root, source.items);
    if (!Array.isArray(items)) throw new Error('价格接口未返回配置的目录数组。');
    for (const item of items) {
      const entries = source.entries === undefined ? [item] : pricingField(item, source.entries);
      if (!Array.isArray(entries)) throw new Error('价格接口未返回配置的费率数组。');
      for (const entry of entries) {
        const context = { root, item, entry };
        if (Object.entries(source.match ?? {}).some(([field, expected]) => pricingField(context, field) !== expected)) continue;
        const model = mapValue(source.template.model, context);
        if (typeof model !== 'string' || !model.trim() || model.length > 256) throw new Error('价格映射不能确认模型身份。');
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => !allowed.has(key))) {
          unconfirmed.add(model);
          continue;
        }
        const price = mapValue(source.template, context);
        if (isMeteredCatalogPrice(price)) prices.push(price);
        else unconfirmed.add(model);
      }
    }
    const cursor = source.cursor ? pricingField(root, source.cursor.path) : null;
    if (!source.cursor || cursor === null || cursor === '') return { prices: prices.filter((price) => !unconfirmed.has(price.model)), unavailableModels: [...unconfirmed] };
    if (typeof cursor !== 'string' || Buffer.byteLength(cursor, 'utf8') > 2048 || cursors.has(cursor)) throw new Error('价格接口分页游标无效。');
    cursors.add(cursor);
    const target = new URL(url);
    target.searchParams.set(source.cursor.parameter, cursor);
    next = target.href;
  }
  throw new Error('价格目录超过单轮读取页数。');
}
