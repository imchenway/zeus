import { estimateCodexUsageWithRateSnapshot, type CodexUsageEstimate, type CodexUsageRateSnapshot, type TokenUsageBreakdown } from '@zeus/shared';

/** 自动补价只读取固定的官方地址，不接收会话内容或第三方连接凭据。 */
export const codexPricingUrl = 'https://developers.openai.com/api/docs/pricing.md';

/** 每百万 Token 的完整美元费率；缺少计价项的行不进入自动价格目录。 */
type DollarRates = NonNullable<CodexUsageRateSnapshot['usdPerMillion']>;

/** 官方表格明确列出的模型、速度档位和上下文档位。 */
interface PublishedModelPrice {
  /** 官方模型标识，不做近似模型匹配。 */
  model: string;
  /** 普通、快速和弹性处理分别保存，避免拿批处理折扣估算交互请求。 */
  serviceTier: 'default' | 'priority' | 'flex';
  /** 短上下文的公开费率。 */
  shortContext: DollarRates;
  /** 长上下文的公开费率；未公布时保留未知。 */
  longContext: DollarRates | null;
}

/** 原文与获取时间一起缓存，重启后仍可追溯补价依据。 */
export interface PublishedCodexPricing {
  /** 这是获取时间，不冒充价格生效日期。 */
  fetchedAt: string;
  /** 官方 Markdown 原文，解析规则失效时拒绝补价。 */
  document: string;
}

/** 固定表头用于检测官网结构变化，不猜测调整后的列含义。 */
const pricingHeader = '| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |';

/** 只接受官方金额语法和明确的缺值，拒绝负数、非有限数及其他文本。 */
function parseDollar(value: string): number | null {
  if (value === '-') return null;
  if (!/^\$\d+(?:\.\d+)?$/u.test(value)) throw new Error('官方价格金额格式已变化');
  /** 官网页面的金额单位固定为每百万 Token。 */
  const amount = Number(value.slice(1));
  if (!Number.isFinite(amount)) throw new Error('官方价格不是有效金额');
  return amount;
}

/** 输入、缓存读取和输出必须有价；缓存写入未知时仍由既有估算器控制覆盖范围。 */
function parseRates(cells: string[]): DollarRates | null {
  /** 固定顺序与已验证表头一致。 */
  const [input, cachedInput, cacheWrite, output] = cells.map(parseDollar);
  return input == null || cachedInput == null || output == null ? null : { input, cachedInput, cacheWrite: cacheWrite ?? null, output };
}

/** 仅解析明确命名的交互计价表；页面改版或同档位重复模型时停止，避免静默错价。 */
export function parsePublishedCodexPrices(document: string): PublishedModelPrice[] {
  /** 只保留验证过的价格行，忽略其他产品、工具和批处理表。 */
  const prices: PublishedModelPrice[] = [];
  /** 当前标题决定服务档位，不能依靠表格出现顺序猜测。 */
  let serviceTier: PublishedModelPrice['serviceTier'] | null = null;
  /** 表头确认后才消费数据行。 */
  let inTable = false;
  for (const rawLine of document.split('\n')) {
    /** 官网 Markdown 的空白不参与含义判断。 */
    const line = rawLine.trim();
    if (line.startsWith('#')) {
      serviceTier = line === '### Standard pricing data' ? 'default' : line === '### Fast pricing data' ? 'priority' : line === '### Flex pricing data' ? 'flex' : null;
      inTable = false;
      continue;
    }
    if (!serviceTier) continue;
    if (line === pricingHeader) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith('|')) {
      if (line) inTable = false;
      continue;
    }
    /** 对齐分隔行不是模型数据。 */
    if (/^\|[\s|:-]+\|$/u.test(line)) continue;
    /** 两端竖线不属于表格单元格。 */
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    /** 仅去掉官网明确的上下文说明，模型别名必须精确匹配。 */
    const model = cells[0]?.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)(?: \(<272K context length\))?$/u)?.[1];
    if (cells.length !== 9 || !model) throw new Error('官方价格表结构已变化');
    if (prices.some((price) => price.model === model && price.serviceTier === serviceTier)) throw new Error('官方价格存在重复模型');
    /** 缺少必要单价时跳过该行，不能把横线当成零。 */
    const shortContext = parseRates(cells.slice(1, 5));
    /** 长上下文的空价格仍保留为空。 */
    const longContext = parseRates(cells.slice(5, 9));
    if (shortContext) prices.push({ model, serviceTier, shortContext, longContext });
  }
  if (!prices.some((price) => price.serviceTier === 'default')) throw new Error('官方页面未提供可识别的普通价格表');
  return prices;
}

/** 价格下载有超时与大小限制，失败不会影响真实 Token 的记录。 */
export async function fetchPublishedCodexPricing(signal: AbortSignal): Promise<PublishedCodexPricing> {
  /** 不向公共定价页面发送账户凭据，也不跟随未知重定向。 */
  const response = await fetch(codexPricingUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]), redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 512_000) throw new Error('官方价格暂时不可读取');
  /** 原文只作为数据解析，不执行其中任何内容。 */
  const document = await response.text();
  if (document.length > 512_000) throw new Error('官方价格页面超出读取上限');
  parsePublishedCodexPrices(document);
  return { fetchedAt: new Date().toISOString(), document };
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
  const longContext = input.usage.inputTokens > 272_000;
  /** 缺少该档位价格时保持未知，不退回便宜档位。 */
  const rates = longContext ? price.longContext : price.shortContext;
  if (!rates) return null;
  return estimateCodexUsageWithRateSnapshot(input.usage, {
    catalogDate: input.catalog.fetchedAt.slice(0, 10),
    model: input.model,
    normalizedModel: price.model,
    serviceTier: input.serviceTier ?? null,
    longContext,
    creditsPerMillion: null,
    usdPerMillion: rates,
    sourceUrls: [codexPricingUrl],
    retrievedAt: input.catalog.fetchedAt,
    ...(input.backfilledAt ? { backfilledAt: input.backfilledAt } : {}),
  });
}
