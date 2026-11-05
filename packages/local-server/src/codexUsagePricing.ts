import { estimateCodexUsageWithRateSnapshot, type CodexUsageEstimate, type CodexUsageRateSnapshot, type TokenUsageBreakdown } from '@zeus/shared';

/** 自动跟踪仅访问官方公开文档，不发送账户凭据。 */
export const codexPricingUrl = 'https://developers.openai.com/api/docs/pricing.md';
/** 美元单价的单位是每百万 Token。 */
type DollarRates = NonNullable<CodexUsageRateSnapshot['usdPerMillion']>;
/** 每条价格独立携带来源和获取时间，保留旧价时不刷新其时间。 */
export interface PublishedModelPrice {
  /** 官方完整模型身份。 */
  model: string;
  /** 交互请求的处理档位。 */
  serviceTier: 'default' | 'priority' | 'flex';
  /** 短上下文费率；cacheWrite 只代表 30 分钟或旧页面未区分时长的费率。 */
  shortContext: DollarRates;
  /** 长上下文费率，缺项不猜测。 */
  longContext: DollarRates | null;
  /** 官方上下文分档的输入 Token 阈值；null 表示未分档。 */
  contextThreshold?: number | null;
  /** 页面明确区分时长时保留 12 小时价格，禁止套用 30 分钟价格。 */
  cacheWrite12h?: { short: number | null; long: number | null };
  /** 独立来源，不把模型详情页冒充总表。 */
  sourceUrl?: string;
  /** 该条价格最近一次被来源确认的时间。 */
  retrievedAt?: string;
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
/** 模型只识别列名称，金额仍从对应原文单元格读取。 */
export type PricingHeaderExtractor = (headers: string[], signal: AbortSignal) => Promise<Record<string, string>>;
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
function field(header: string, aliases: Record<string, string>): string {
  const key = clean(header)
    .toLowerCase()
    .replace(/ context/gu, '');
  const normalized = /^(model name|model id)$/u.test(key) ? 'model' : /^(input|output|cached input|cache writes)$/u.test(key) ? `short ${key}` : key;
  return fields.includes(normalized) ? normalized : (aliases[header] ?? '');
}
/** 逐模型解析失败隔离，避免一行阻断全部新模型。 */
function parseCatalog(document: string, aliases: Record<string, string> = {}): { prices: PublishedModelPrice[]; issues: string[]; unknownHeaders: string[] } {
  if (!/(?:per|每)\s*(?:1M|1,000,000|million|百万)\s*(?:tokens|Token)/iu.test(document)) throw new Error('官方价格单位未确认为每百万 Token');
  const thresholdMatch = document.match(/Short context:\s*[≤<]\s*([\d,]+)K input tokens/iu);
  const threshold = thresholdMatch ? Number(thresholdMatch[1]!.replace(/,/gu, '')) * 1_000 : null;
  const prices = new Map<string, PublishedModelPrice>();
  const rejected = new Set<string>();
  const issues: string[] = [];
  const unknownHeaders = new Set<string>();
  let tier: PublishedModelPrice['serviceTier'] | null = null;
  let columns: string[] = [];
  const lines = document.split('\n');
  for (const [lineIndex, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      const heading = clean(line.replace(/^#+\s*/u, '')).toLowerCase();
      tier = /^(standard|fast|priority|flex)(?: pricing(?: data)?)?$/u.test(heading) ? (heading.startsWith('standard') ? 'default' : heading.startsWith('flex') ? 'flex' : 'priority') : null;
      columns = [];
      continue;
    }
    if (!tier || !line.startsWith('|')) continue;
    if (/^\|[\s|:-]+\|$/u.test(line)) continue;
    const row = cells(line);
    if (/^\|[\s|:-]+\|$/u.test(lines[lineIndex + 1]?.trim() ?? '')) {
      columns = row.map((value) => field(value, aliases));
      row.forEach((value, index) => {
        if (!columns[index]) unknownHeaders.add(value);
      });
      continue;
    }
    if (!columns.length) continue;
    const model = row[columns.indexOf('model')]?.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)(?: \(<272K context length\))?$/u)?.[1];
    if (!model) continue;
    const key = `${model}:${tier}`;
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
      if (!shortContext) continue;
      const contextThreshold = threshold ?? (row[columns.indexOf('model')]?.includes('<272K context length') ? 272_000 : null);
      if (columns.some((column) => column.startsWith('long ')) && contextThreshold == null) throw new Error('上下文分档阈值未确认');
      const price: PublishedModelPrice = {
        model,
        serviceTier: tier,
        shortContext,
        contextThreshold,
        longContext: rates('long'),
        ...(columns.includes('short 12h write') ? { cacheWrite12h: { short: value('short 12h write'), long: value('long 12h write') } } : {}),
      };
      const previous = prices.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(price)) throw new Error('同模型同档位来源冲突');
      if (!rejected.has(key)) prices.set(key, price);
    } catch (error) {
      prices.delete(key);
      rejected.add(key);
      issues.push(`${key}: ${error instanceof Error ? error.message : '无法识别'}`);
    }
  }
  return { prices: [...prices.values()], issues, unknownHeaders: [...unknownHeaders] };
}
/** 旧缓存和调用方共用同一语义解析器。 */
export function parsePublishedCodexPrices(document: string): PublishedModelPrice[] {
  const result = parseCatalog(document);
  if (!result.prices.length) throw new Error('官方页面未提供可识别的价格表');
  return result.prices;
}
/** 缓存和新目录采用相同金额边界，不让无效快照中断用量记账。 */
export function readPublishedCodexPrices(catalog: PublishedCodexPricing): PublishedModelPrice[] {
  const prices = catalog.prices ?? parsePublishedCodexPrices(catalog.document);
  const validAmount = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const validRates = (rates: DollarRates | null): boolean => Boolean(rates && validAmount(rates.input) && validAmount(rates.output) && validAmount(rates.cachedInput) && (rates.cacheWrite === null || validAmount(rates.cacheWrite)));
  if (
    !Array.isArray(prices) ||
    prices.some(
      (price) =>
        !price ||
        typeof price.model !== 'string' ||
        !['default', 'priority', 'flex'].includes(price.serviceTier) ||
        !validRates(price.shortContext) ||
        (price.longContext !== null && !validRates(price.longContext)) ||
        (price.contextThreshold != null && (!validAmount(price.contextThreshold) || price.contextThreshold === 0)) ||
        (price.cacheWrite12h && [price.cacheWrite12h.short, price.cacheWrite12h.long].some((value) => value !== null && !validAmount(value))),
    )
  )
    throw new Error('价格目录包含无效费率');
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
export async function fetchPublishedCodexPricing(signal: AbortSignal, options: { previous?: PublishedCodexPricing | null; models?: string[]; extractHeaders?: PricingHeaderExtractor } = {}): Promise<PublishedCodexPricing> {
  const fetchedAt = new Date().toISOString();
  const previous = options.previous ? readPublishedCodexPrices(options.previous).map((price) => ({ ...price, retrievedAt: price.retrievedAt ?? options.previous!.fetchedAt, sourceUrl: price.sourceUrl ?? codexPricingUrl })) : [];
  const merged = new Map(previous.map((price) => [`${price.model}:${price.serviceTier}`, price]));
  const issues: string[] = [];
  const modelDocuments = { ...options.previous?.modelDocuments };
  let document = options.previous?.document ?? '';
  let accepted = 0;
  try {
    document = await readOfficialDocument(codexPricingUrl, signal);
    let parsed = parseCatalog(document);
    if (parsed.unknownHeaders.length && options.extractHeaders) {
      try {
        const aliases = await options.extractHeaders(parsed.unknownHeaders, signal);
        if (Object.entries(aliases).some(([key, value]) => !parsed.unknownHeaders.includes(key) || !fields.includes(value))) throw new Error('模型返回的列含义不符合价格字段');
        parsed = parseCatalog(document, aliases);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : '字段识别失败');
      }
    }
    issues.push(...parsed.issues);
    /** 目录遗漏不能把旧价伪装成刚确认的现价。 */
    for (const price of previous)
      if (price.sourceUrl === codexPricingUrl && !parsed.prices.some((entry) => entry.model === price.model && entry.serviceTier === price.serviceTier)) issues.push(`${price.model}:${price.serviceTier}: 本次总表未确认，保留旧价`);
    for (const price of parsed.prices) {
      merged.set(`${price.model}:${price.serviceTier}`, { ...price, sourceUrl: codexPricingUrl, retrievedAt: fetchedAt });
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
        if (issues.includes(`${key}: 同模型同档位来源冲突`)) continue;
        const current = merged.get(key);
        if (
          current?.retrievedAt === fetchedAt &&
          JSON.stringify([current.shortContext, current.longContext, current.cacheWrite12h, current.contextThreshold]) !== JSON.stringify([price.shortContext, price.longContext, price.cacheWrite12h, price.contextThreshold])
        ) {
          issues.push(`${key}: 官方来源价格冲突`);
          if (previous.some((entry) => `${entry.model}:${entry.serviceTier}` === key))
            merged.set(
              key,
              previous.find((entry) => `${entry.model}:${entry.serviceTier}` === key)!,
            );
          else merged.delete(key);
          continue;
        }
        merged.set(key, { ...price, sourceUrl: url, retrievedAt: fetchedAt });
        accepted++;
      }
    } catch (error) {
      issues.push(`${model}: ${error instanceof Error ? error.message : '详情页不可用'}`);
    }
  }
  if (!accepted) throw new Error(issues.slice(0, 3).join('；') || '官方未公布所需价格');
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
  usage: TokenUsageBreakdown;
  backfilledAt?: string;
}): CodexUsageEstimate | null {
  /** 服务端支持 fast 和 priority 两种快速模式名称。 */
  const tier = input.serviceTier === 'fast' || input.serviceTier === 'priority' ? 'priority' : input.serviceTier == null || input.serviceTier === 'default' || input.serviceTier === 'standard' ? 'default' : input.serviceTier;
  /** 模型身份精确匹配；没有页面别名依据时不删除日期后缀。 */
  const model = input.model.trim();
  /** 原文在下载或载入时只解析一次，补算多条记录共用同一价格目录。 */
  const prices = input.prices.filter((price) => price.serviceTier === tier);
  /** 不把未知模型映射到“类似”模型。 */
  const price = prices.find((entry) => entry.model === model);
  if (!price) return null;
  /** 调用方传入单次请求用量，按该请求的上下文选择费率。 */
  const threshold = price.contextThreshold === undefined ? 272_000 : price.contextThreshold;
  const longContext = threshold !== null && input.usage.inputTokens > threshold;
  /** 缺少该档位价格时保持未知，不退回便宜档位。 */
  const publishedRates = longContext ? price.longContext : price.shortContext;
  /** 用量缺少保留时长时，不对有多种写入费率的 Token 猜价。 */
  const rates = publishedRates && price.cacheWrite12h ? { ...publishedRates, cacheWrite: null } : publishedRates;
  if (!rates) return null;
  return estimateCodexUsageWithRateSnapshot(input.usage, {
    catalogDate: (price.retrievedAt ?? input.catalog.fetchedAt).slice(0, 10),
    model: input.model,
    normalizedModel: price.model,
    serviceTier: input.serviceTier ?? null,
    longContext,
    creditsPerMillion: null,
    usdPerMillion: rates,
    sourceUrls: [price.sourceUrl ?? codexPricingUrl],
    retrievedAt: price.retrievedAt ?? input.catalog.fetchedAt,
    ...(input.backfilledAt ? { backfilledAt: input.backfilledAt } : {}),
  });
}
