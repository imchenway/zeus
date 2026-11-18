import { estimateCodexUsageWithRateSnapshot, isCodexServiceTierId, normalizeCodexPricingServiceTier, type CodexUsageEstimate, type CodexUsageRateSnapshot, type TokenUsageBreakdown } from '@zeus/shared';

/** 自动跟踪仅访问官方公开文档，不发送账户凭据。 */
export const codexPricingUrl = 'https://developers.openai.com/api/docs/pricing.md';
/** 美元单价的单位是每百万 Token。 */
type DollarRates = NonNullable<CodexUsageRateSnapshot['usdPerMillion']>;
/** 同一计价期间适用的上下文费率。 */
interface PublishedContextRates {
  /** 短上下文费率；cacheWrite 只代表 30 分钟或旧页面未区分时长的费率。 */
  shortContext: DollarRates;
  /** 长上下文费率，缺项不猜测。 */
  longContext: DollarRates | null;
  /** 官方上下文分档的输入 Token 阈值；null 表示未分档。 */
  contextThreshold?: number | null;
  /** 页面明确区分时长时保留 12 小时价格，禁止套用 30 分钟价格。 */
  cacheWrite12h?: { short: number | null; long: number | null };
  /** 该组费率最近一次被来源确认的时间。 */
  retrievedAt?: string;
}

/** 每条价格独立携带来源和获取时间，保留旧价时不刷新其时间。 */
export interface PublishedModelPrice extends PublishedContextRates {
  /** 官方完整模型身份。 */
  model: string;
  /** 交互请求的处理档位。 */
  serviceTier: string;
  /** 已核对过的官方表标题，用于当前目录不再提供旧档位时。 */
  sourceTierLabel?: string;
  /** 标价生效前使用这组优惠费率。 */
  promotion?: PublishedContextRates & {
    /** 标价生效的美国太平洋时区日历日期，格式为 YYYY-MM-DD。 */
    listStartsOn: string;
  };
  /** 独立来源，不把模型详情页冒充总表。 */
  sourceUrl?: string;
}
/** 原文与规范化目录一起保存；旧缓存仍从原文解析。 */
export interface PublishedCodexPricing {
  /** 最近一次接受价格数据的时间，不代表生效时间。 */
  fetchedAt: string;
  /** 官方总表原文。 */
  document: string;
  /** 合并后的可信记录，缺失条目保留旧值和旧时间。 */
  prices?: PublishedModelPrice[];
  /** 本轮无法确认的条目或来源。 */
  issues?: string[];
  /** 已采纳模型详情原文，保留补价依据。 */
  modelDocuments?: Record<string, string>;
}
/** 厂商目录或历史请求提供的模型与档位身份。 */
export interface CodexPricingTier {
  /** 官方价目和用量账本使用的模型 ID。 */
  model: string;
  /** 用量事件中匹配的档位 ID。 */
  id: string;
  /** 厂商公布的档位名称或已确认的官方表标题。 */
  name?: string;
}
/** 可接受的字段语义；其他列保持未知。 */
const fields = [
  'model',
  'short input',
  'short output',
  'short cached input',
  'short cache writes',
  'short 30m write',
  'short 12h write',
  'long input',
  'long output',
  'long cached input',
  'long cache writes',
  'long 30m write',
  'long 12h write',
];
/** 表格内的格式标记不参与字段含义。 */
function clean(value: string): string {
  return value.replace(/[`*_]/gu, '').trim().replace(/\s+/gu, ' ');
}
/** 表格单元格保持原始顺序，列含义另行映射。 */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/gu, '')
    .split('|')
    .map(clean);
}
/** 只接受美元数值或明确空值。 */
function dollar(value: string | undefined): number | null {
  if (value == null || /^(?:-|—|N\/A)$/iu.test(value)) return null;
  if (!/^\$\d+(?:\.\d+)?$/u.test(value)) throw new Error('价格单元格缺少明确美元金额');
  const amount = Number(value.slice(1));
  if (!Number.isFinite(amount)) throw new Error('价格金额无效');
  return amount;
}
/** 列顺序可变，通用输入输出列属于短上下文。 */
function field(header: string): string {
  const key = clean(header)
    .toLowerCase()
    .replace(/ context/gu, '');
  const normalized = /^(model name|model id)$/u.test(key) ? 'model' : /^(input|output|cached input|cache writes)$/u.test(key) ? `short ${key}` : key;
  return fields.includes(normalized) ? normalized : '';
}

/** 官方 Ultrafast 切换时间用美国太平洋时区的日历日表示。 */
const pacificDateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 只用有效时间戳选择费率，避免把缺失时间当成当前时间。 */
function pacificDate(occurredAt: string | undefined): string | null {
  const instant = Date.parse(occurredAt ?? '');
  if (!Number.isFinite(instant)) return null;
  const parts = Object.fromEntries(pacificDateFormat.formatToParts(instant).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 只有该模型已知的档位 ID 或唯一官方名称可以与价格表关联。 */
function pricingTierLookup(tiers: readonly CodexPricingTier[]) {
  const idsByModel = new Map<string, Map<string, Set<string>>>();
  const labels = new Set(['standard', 'fast', 'priority']);
  for (const { model, id, name } of tiers) {
    if (!isCodexServiceTierId(id)) continue;
    const entries = idsByModel.get(model) ?? new Map<string, Set<string>>();
    idsByModel.set(model, entries);
    for (const label of [id.toLowerCase(), clean(name ?? '').toLowerCase()]) {
      if (!label) continue;
      labels.add(label);
      const ids = entries.get(label) ?? new Set<string>();
      ids.add(normalizeCodexPricingServiceTier(id));
      entries.set(label, ids);
    }
  }
  /** 同名冲突需要指出受影响的档位，单纯缺失映射只保留缺价。 */
  const candidates = (model: string, label: string) => idsByModel.get(model)?.get(label);
  return {
    labels,
    candidates,
    resolve(model: string, label: string): string | null {
      const ids = candidates(model, label);
      if (label === 'standard' || label === 'fast' || label === 'priority') {
        const id = normalizeCodexPricingServiceTier(label);
        return !ids || (ids.size === 1 && ids.has(id)) ? id : null;
      }
      return ids?.size === 1 ? (ids.values().next().value ?? null) : null;
    },
  };
}

/** 公开说明必须明确档位、相邻日历日及美国太平洋时区。 */
function pricingPromotionTerms(document: string) {
  const periods = new Map<string, { model: string; label: string; listStartsOn: string | null }>();
  const terms = /^For (.+?), ([^,\n]+?) costs \d+(?:\.\d+)? times the Standard rate through ([A-Za-z]+ \d{1,2}, \d{4}), and \d+(?:\.\d+)? times the Standard rate starting ([A-Za-z]+ \d{1,2}, \d{4}) \(Pacific time\)\./gimu;
  for (const [, models, mode, lastPromotionDay, firstListDay] of document.matchAll(terms)) {
    const label = clean(mode!).toLowerCase();
    const startsAt = Date.parse(firstListDay + ' UTC');
    const endsAt = Date.parse(lastPromotionDay + ' UTC');
    const date = startsAt - endsAt === 86_400_000 ? new Date(startsAt).toISOString().slice(0, 10) : null;
    for (const name of models!.split(/\s*,\s*(?:and\s+)?|\s+and\s+/iu)) {
      const model = clean(name)
        .toLowerCase()
        .replace(/[‐‑–−]/gu, '-')
        .replace(/\s+/gu, '-');
      const key = JSON.stringify([model, label]);
      const prior = periods.get(key);
      periods.set(key, { model, label, listStartsOn: prior && prior.listStartsOn !== date ? null : date });
    }
  }
  return periods.values();
}

/** 逐模型解析失败隔离，避免一行阻断全部新模型。 */
function parseCatalog(document: string, modelTiers: readonly CodexPricingTier[]): { prices: PublishedModelPrice[]; issues: string[]; unconfirmed: Set<string> } {
  if (!/(?:per|每)\s*(?:1M|1,000,000|million|百万)\s*(?:tokens|Token)/iu.test(document)) throw new Error('官方价格单位未确认为每百万 Token');
  /** 存在不同上下文阈值时，未明确阈值归属的表保持缺价。 */
  const thresholds = new Set(
    [...document.matchAll(/Short context:\s*([≤<])\s*([\d,]+)K input tokens/giu)]
      .map(([, comparison, thousands]) => Number(thousands!.replace(/,/gu, '')) * 1_000 - (comparison === '<' ? 1 : 0))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  );
  const threshold = thresholds.size === 1 ? (thresholds.values().next().value ?? null) : null;
  const prices = new Map<string, PublishedModelPrice>();
  const tiers = pricingTierLookup(modelTiers);
  /** 仅在来源公布切换日时组合两张费率表。 */
  const scheduled = new Map<string, string | null>();
  for (const { model, label, listStartsOn } of pricingPromotionTerms(document)) {
    const id = tiers.resolve(model, label);
    if (!id) continue;
    const key = `${model}:${id}`;
    scheduled.set(key, scheduled.has(key) && scheduled.get(key) !== listStartsOn ? null : listStartsOn);
  }
  const rejected = new Set<string>();
  /** 已匹配身份但无法确认费率的条目不能沿用旧费率。 */
  const unconfirmed = new Set<string>();
  const issues: string[] = [];
  /** 当前表标题只提供候选名称，等模型行出现后再确认档位 ID。 */
  let tierLabel: string | null = null;
  /** 普通表、优惠表和标价表使用相同的价格列。 */
  let pricePeriod: 'promotion' | 'list' | null = null;
  let columns: string[] = [];
  const lines = document.split('\n');
  for (const [lineIndex, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      const heading = clean(line.replace(/^#+\s*/u, '')).toLowerCase();
      const caption = /^(.+?)(?: (promotion|list))? pricing(?: data)?$/u.exec(heading);
      const label = caption?.[1] ?? heading;
      tierLabel = tiers.labels.has(label) ? label : null;
      pricePeriod = caption?.[2] === 'promotion' ? 'promotion' : caption?.[2] === 'list' ? 'list' : null;
      columns = [];
      continue;
    }
    if (!tierLabel || !line.startsWith('|')) continue;
    if (/^\|[\s|:-]+\|$/u.test(line)) continue;
    const row = cells(line);
    if (/^\|[\s|:-]+\|$/u.test(lines[lineIndex + 1]?.trim() ?? '')) {
      columns = row.map(field);
      continue;
    }
    if (!columns.length) continue;
    const model = row[columns.indexOf('model')]?.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)(?: \(<272K context length\))?$/u)?.[1];
    if (!model) continue;
    const tier = tiers.resolve(model, tierLabel);
    if (!tier) {
      const candidates = tiers.candidates(model, tierLabel);
      if (candidates) {
        for (const id of candidates) unconfirmed.add(`${model}:${id}`);
        issues.push(`${model}: ${tierLabel} 未能唯一对应到档位 ID`);
      }
      continue;
    }
    const rateKey = `${model}:${tier}`;
    if (pricePeriod && !scheduled.has(rateKey)) scheduled.set(rateKey, null);
    const key = pricePeriod ? `${rateKey}:${pricePeriod}` : rateKey;
    try {
      if (row.length !== columns.length || columns.some((column) => !column) || new Set(columns).size !== columns.length) throw new Error('价格列含义不完整或重复');
      const value = (name: string): number | null => dollar(row[columns.indexOf(name)]);
      const rates = (prefix: string): DollarRates | null => {
        const input = value(`${prefix} input`),
          output = value(`${prefix} output`),
          cachedInput = value(`${prefix} cached input`);
        return input == null || output == null || cachedInput == null ? null : { input, output, cachedInput, cacheWrite: value(`${prefix} 30m write`) ?? value(`${prefix} cache writes`) };
      };
      const shortContext = rates('short');
      if (!shortContext) throw new Error('输入、输出或缓存读取单价缺失');
      const contextThreshold = row[columns.indexOf('model')]?.includes('<272K context length') ? 271_999 : threshold;
      if (columns.some((column) => column.startsWith('long ')) && contextThreshold == null) throw new Error('上下文分档阈值未确认');
      const price: PublishedModelPrice = {
        model,
        serviceTier: tier,
        sourceTierLabel: tierLabel,
        shortContext,
        contextThreshold,
        longContext: rates('long'),
        ...(columns.includes('short 12h write') ? { cacheWrite12h: { short: value('short 12h write'), long: value('long 12h write') } } : {}),
      };
      const previous = prices.get(key);
      if (previous && JSON.stringify({ ...previous, sourceTierLabel: tierLabel }) !== JSON.stringify(price)) throw new Error('同模型同档位来源冲突');
      if (!rejected.has(key)) prices.set(key, price);
    } catch (error) {
      prices.delete(key);
      rejected.add(key);
      unconfirmed.add(rateKey);
      issues.push(`${key}: ${error instanceof Error ? error.message : '无法识别'}`);
    }
  }
  for (const [key, listStartsOn] of scheduled) {
    const list = prices.get(`${key}:list`);
    const promotion = prices.get(`${key}:promotion`);
    prices.delete(`${key}:list`);
    prices.delete(`${key}:promotion`);
    prices.delete(key);
    if (list && promotion && listStartsOn) {
      const { shortContext, longContext, contextThreshold, cacheWrite12h } = promotion;
      prices.set(key, { ...list, promotion: { shortContext, longContext, contextThreshold, cacheWrite12h, listStartsOn } });
    } else {
      unconfirmed.add(key);
      issues.push(`${key}: 优惠价、标价或生效日期未确认`);
    }
  }
  return { prices: [...prices.values()].filter((price) => !unconfirmed.has(`${price.model}:${price.serviceTier}`)), issues, unconfirmed };
}
/** 旧缓存和调用方共用同一语义解析器。 */
export function parsePublishedCodexPrices(document: string, modelTiers: readonly CodexPricingTier[] = []): PublishedModelPrice[] {
  const result = parseCatalog(document, modelTiers);
  if (!result.prices.length) throw new Error('官方页面未提供可识别的价格表');
  return result.prices;
}
/** 缓存和新目录采用相同金额边界，不让无效快照中断用量记账。 */
export function readPublishedCodexPrices(catalog: PublishedCodexPricing, modelTiers: readonly CodexPricingTier[] = []): PublishedModelPrice[] {
  const prices = catalog.prices ?? parsePublishedCodexPrices(catalog.document, modelTiers);
  const validAmount = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const validRates = (rates: DollarRates | null): boolean => Boolean(rates && validAmount(rates.input) && validAmount(rates.output) && validAmount(rates.cachedInput) && (rates.cacheWrite === null || validAmount(rates.cacheWrite)));
  /** 缓存中的标价和优惠价均须通过上下文及金额校验。 */
  const validContextRates = (price: PublishedContextRates): boolean =>
    validRates(price.shortContext) &&
    (price.longContext === null || validRates(price.longContext)) &&
    (price.contextThreshold == null || (validAmount(price.contextThreshold) && price.contextThreshold > 0)) &&
    (!price.cacheWrite12h || [price.cacheWrite12h.short, price.cacheWrite12h.long].every((value) => value === null || validAmount(value)));
  /** 优惠与模型档位独立，切换日期无效的缓存不能参与选价。 */
  const validPrice = (price: PublishedModelPrice): boolean =>
    Boolean(price) &&
    typeof price.model === 'string' &&
    isCodexServiceTierId(price.serviceTier) &&
    validContextRates(price) &&
    (!price.promotion || (/^\d{4}-\d{2}-\d{2}$/u.test(price.promotion.listStartsOn) && validContextRates(price.promotion)));
  if (!Array.isArray(prices) || !prices.every(validPrice)) throw new Error('价格目录包含无效费率');
  /** 仅在请求或目录提供额外档位证据时重读已保存的官方原文。 */
  const known = new Set(prices.map((price) => `${price.model}:${price.serviceTier}`));
  if (catalog.prices && modelTiers.some(({ model, id }) => !known.has(`${model}:${normalizeCodexPricingServiceTier(id)}`))) {
    try {
      const restored = parseCatalog(catalog.document, modelTiers).prices.filter((price) => !known.has(`${price.model}:${price.serviceTier}`) && validPrice(price));
      return [...prices, ...restored];
    } catch {
      // 原文无法重读时继续使用已核验的价格快照。
    }
  }
  return prices;
}
/** 公开文档读取限制时长、来源与大小。 */
async function readOfficialDocument(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]), redirect: 'error' });
  if (!response.ok) throw new Error(`官方价格读取失败 HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('官方价格正文为空');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 512_000) throw new Error('官方价格页面超出读取上限');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** 模型详情页只按明确的文本 Token 表和倍率说明生成费率。 */
function parseModelPage(model: string, document: string): PublishedModelPrice[] {
  if (!document.includes(`Model ID: \`${model}\``)) throw new Error('模型详情页身份不匹配');
  const section = document.split('### Text tokens')[1]?.split('## Endpoints')[0] ?? '';
  const values = new Map<string, number | null>();
  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const row = cells(line);
    if (row[2] === '1M tokens') values.set(row[0]!.toLowerCase(), dollar(row[1]));
  }
  const input = values.get('input'),
    output = values.get('output'),
    cachedInput = values.get('cached input');
  if (input == null || output == null || cachedInput == null) throw new Error('模型详情页没有完整文本单价');
  const shortContext: DollarRates = { input, output, cachedInput, cacheWrite: values.get('cache writes') ?? null };
  const multipliers = section.match(/more than ([\d,]+)K input tokens.*?([\d.]+)x input and cache rates and ([\d.]+)x output/u);
  if (!multipliers && /more than|long.context/iu.test(section)) throw new Error('模型上下文分档含义未确认');
  const scale = (rates: DollarRates, inputFactor: number, outputFactor: number): DollarRates => ({
    input: rates.input * inputFactor,
    cachedInput: rates.cachedInput * inputFactor,
    cacheWrite: rates.cacheWrite == null ? null : rates.cacheWrite * inputFactor,
    output: rates.output * outputFactor,
  });
  const longContext = multipliers ? scale(shortContext, Number(multipliers[2]), Number(multipliers[3])) : null;
  const longWrite = section.match(/\$([\d.]+) per million tokens for 30-minute retention and \$([\d.]+) for 12-hour retention/u);
  const base: PublishedModelPrice = {
    model,
    serviceTier: 'default',
    contextThreshold: multipliers ? Number(multipliers[1]!.replace(/,/gu, '')) * 1_000 : null,
    shortContext,
    longContext,
    ...(longWrite ? { cacheWrite12h: { short: Number(longWrite[2]), long: multipliers ? Number(longWrite[2]) * Number(multipliers[2]) : null } } : {}),
  };
  const fast = section.match(/Fast mode prices are ([\d.]+)x Standard/u);
  return [
    base,
    ...(fast
      ? [
          {
            ...base,
            serviceTier: 'priority' as const,
            shortContext: scale(shortContext, Number(fast[1]), Number(fast[1])),
            longContext: longContext ? scale(longContext, Number(fast[1]), Number(fast[1])) : null,
            ...(base.cacheWrite12h ? { cacheWrite12h: { short: base.cacheWrite12h.short! * Number(fast[1]), long: base.cacheWrite12h.long == null ? null : base.cacheWrite12h.long * Number(fast[1]) } } : {}),
          },
        ]
      : []),
  ];
}
/** 总表覆盖全部新模型；缺价模型按精确身份读取详情页，失败保留旧目录。 */
export async function fetchPublishedCodexPricing(signal: AbortSignal, options: { previous?: PublishedCodexPricing | null; models?: string[]; modelTiers?: readonly CodexPricingTier[] } = {}): Promise<PublishedCodexPricing> {
  const fetchedAt = new Date().toISOString();
  const fetchedOn = pacificDate(fetchedAt)!;
  const previous = options.previous ? readPublishedCodexPrices(options.previous).map((price) => ({ ...price, retrievedAt: price.retrievedAt ?? options.previous!.fetchedAt, sourceUrl: price.sourceUrl ?? codexPricingUrl })) : [];
  const merged = new Map(previous.map((price) => [`${price.model}:${price.serviceTier}`, price]));
  /** 保留过去已核对的标题和 ID 对应关系，以便下架后的历史计价。 */
  const modelTiers = [...(options.modelTiers ?? []), ...previous.map((price) => ({ model: price.model, id: price.serviceTier, name: price.sourceTierLabel }))];
  const issues: string[] = [];
  /** 有明确冲突的总表条目不能退回旧值或无有效期的详情页。 */
  const unconfirmed = new Set<string>();
  const modelDocuments = { ...options.previous?.modelDocuments };
  let document = options.previous?.document ?? '';
  let accepted = 0;
  try {
    document = await readOfficialDocument(codexPricingUrl, signal);
    const parsed = parseCatalog(document, modelTiers);
    issues.push(...parsed.issues);
    for (const key of parsed.unconfirmed) {
      merged.delete(key);
      unconfirmed.add(key);
    }
    /** 目录遗漏不能把旧价伪装成刚确认的现价。 */
    for (const price of previous)
      if (price.sourceUrl === codexPricingUrl && merged.has(`${price.model}:${price.serviceTier}`) && !parsed.prices.some((entry) => entry.model === price.model && entry.serviceTier === price.serviceTier))
        issues.push(`${price.model}:${price.serviceTier}: 本次总表缺少条目，保留已确认的旧价`);
    for (const price of parsed.prices) {
      const key = `${price.model}:${price.serviceTier}`;
      const oldPromotion = merged.get(key)?.promotion;
      /** 优惠到期后总表可只列标价，旧优惠费率仍适用于待补价的历史请求。 */
      if (oldPromotion && !price.promotion && fetchedOn < oldPromotion.listStartsOn) {
        issues.push(`${key}: 优惠期内的未分期价格无法确认，保留旧价`);
        continue;
      }
      const promotion = price.promotion ? { ...price.promotion, retrievedAt: fetchedAt } : oldPromotion;
      merged.set(key, { ...price, ...(promotion ? { promotion } : {}), sourceUrl: codexPricingUrl, retrievedAt: fetchedAt });
      accepted++;
    }
    if (!parsed.prices.length) issues.push('官方价格表格式无法识别');
  } catch (error) {
    issues.push(error instanceof Error ? error.message : '官方价格读取失败');
  }
  for (const model of [...new Set(options.models ?? [])]) {
    if (signal.aborted) throw signal.reason;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u.test(model)) continue;
    if (['default', 'priority'].every((tier) => merged.get(`${model}:${tier}`)?.retrievedAt === fetchedAt)) continue;
    const url = `https://developers.openai.com/api/docs/models/${encodeURIComponent(model)}.md`;
    try {
      const modelDocument = await readOfficialDocument(url, signal);
      const prices = parseModelPage(model, modelDocument);
      modelDocuments[model] = modelDocument;
      for (const price of prices) {
        const key = `${model}:${price.serviceTier}`;
        if (unconfirmed.has(key)) continue;
        const current = merged.get(key);
        if (
          current?.retrievedAt === fetchedAt &&
          JSON.stringify([current.shortContext, current.longContext, current.cacheWrite12h, current.contextThreshold]) !== JSON.stringify([price.shortContext, price.longContext, price.cacheWrite12h, price.contextThreshold])
        ) {
          issues.push(`${key}: 官方来源价格冲突`);
          merged.delete(key);
          unconfirmed.add(key);
          continue;
        }
        merged.set(key, { ...price, sourceUrl: url, retrievedAt: fetchedAt });
        accepted++;
      }
    } catch (error) {
      issues.push(`${model}: ${error instanceof Error ? error.message : '详情页不可用'}`);
    }
  }
  if (!accepted && !unconfirmed.size) throw new Error(issues.slice(0, 3).join('；') || '官方未公布所需价格');
  const catalog = { fetchedAt, document, modelDocuments, prices: [...merged.values()], issues: [...new Set(issues)] };
  readPublishedCodexPrices(catalog);
  return catalog;
}

/** 已获取的价格只用于缺价记录；已记账的快照由调用方保持不变。 */
export function estimatePublishedCodexUsage(input: {
  catalog: PublishedCodexPricing;
  prices: readonly PublishedModelPrice[];
  model: string;
  serviceTier?: string | null;
  /** 实时与历史记账均以该请求的发生时间选择有期限的费率。 */
  occurredAt?: string;
  usage: TokenUsageBreakdown;
  backfilledAt?: string;
}): CodexUsageEstimate | null {
  const tier = normalizeCodexPricingServiceTier(input.serviceTier);
  /** 模型身份精确匹配；没有页面别名依据时不删除日期后缀。 */
  const model = input.model.trim();
  /** 原文在下载或载入时只解析一次，补算多条记录共用同一价格目录。 */
  /** 不把未知模型映射到“类似”模型。 */
  const price = input.prices.find((entry) => entry.model === model && entry.serviceTier === tier);
  if (!price) return null;
  /** 优惠结束后的同一模型使用标价，仍按单次请求判定上下文。 */
  let priced: PublishedContextRates = price;
  if (price.promotion) {
    const requestDay = pacificDate(input.occurredAt);
    if (!requestDay) return null;
    if (requestDay < price.promotion.listStartsOn) priced = price.promotion;
  }
  /** 调用方传入单次请求用量，按该请求的上下文选择费率。 */
  const threshold = priced.contextThreshold === undefined ? 272_000 : priced.contextThreshold;
  const longContext = threshold !== null && input.usage.inputTokens > threshold;
  /** 缺少该档位价格时保持未知，不退回便宜档位。 */
  const publishedRates = longContext ? priced.longContext : priced.shortContext;
  /** 用量缺少保留时长时，不对有多种写入费率的 Token 猜价。 */
  const rates = publishedRates && priced.cacheWrite12h ? { ...publishedRates, cacheWrite: null } : publishedRates;
  if (!rates) return null;
  const retrievedAt = priced.retrievedAt ?? input.catalog.fetchedAt;
  return estimateCodexUsageWithRateSnapshot(input.usage, {
    catalogDate: retrievedAt.slice(0, 10),
    model: input.model,
    normalizedModel: price.model,
    serviceTier: input.serviceTier ?? null,
    longContext,
    creditsPerMillion: null,
    usdPerMillion: rates,
    sourceUrls: [price.sourceUrl ?? codexPricingUrl],
    retrievedAt,
    ...(input.backfilledAt ? { backfilledAt: input.backfilledAt } : {}),
  });
}
