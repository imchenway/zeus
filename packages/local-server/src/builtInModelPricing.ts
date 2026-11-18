import type { MeteredCharge, MeteredPrice, ModelPrice } from '@zeus/shared';

/** 百炼缓存命中倍率来自同一地域的官方缓存说明。 */
export const bailianCachePricingUrl = 'https://help.aliyun.com/zh/model-studio/context-cache';

/** 固定官方来源支持代理网络；重定向只能停留在同一官方域名。 */
export async function readBuiltInPricingPage(url: string, signal: AbortSignal): Promise<string> {
  /** 来源由服务内置映射选择，不能接受任意用户地址走此入口。 */
  const origin = new URL(url).origin;
  let target = url;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) break;
      const next = new URL(location, target);
      if (next.origin !== origin) throw new Error('官方价格页面跳转到未知来源，等待更新内置地址。');
      target = next.href;
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`官方价格读取失败（HTTP ${response.status}）。`);
    /** 流式限制大小，不先把整个未知响应装入内存。 */
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) throw new Error('官方价格页面超过读取上限。');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('官方价格页面重定向过多。');
}

/** 只保留单元格文字，不执行网页代码。 */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;|&#160;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 展开官网价格表的合并单元格，避免把下一行金额误配给另一模型。 */
function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const [index, row] of [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].entries()) {
    rows[index] ??= [];
    let column = 0;
    for (const cell of row[1]!.matchAll(/<t[hd]\b([^>]*)>([\s\S]*?)<\/t[hd]>/giu)) {
      while (rows[index]![column] !== undefined) column += 1;
      const width = Math.min(32, Number(cell[1]!.match(/colspan=["']?(\d+)/iu)?.[1] ?? 1));
      const height = Math.min(200, Number(cell[1]!.match(/rowspan=["']?(\d+)/iu)?.[1] ?? 1));
      for (let down = 0; down < height; down += 1) {
        rows[index + down] ??= [];
        for (let across = 0; across < width; across += 1) rows[index + down]![column + across] = text(cell[2]!);
      }
      column += width;
    }
  }
  return rows;
}

/** 仅解析明确普通金额；促销文字、起价及多种单位保持未知。 */
function price(value: string | undefined, currency: 'USD' | 'CNY'): number | null {
  if (value === 'Free') return 0;
  const match = value?.match(currency === 'USD' ? /^\$(\d+(?:\.\d+)?)$/u : /^(\d+(?:\.\d+)?)\s*元$/u);
  return match ? Number(match[1]) : null;
}

/** 内置供应商维护表头与计费语义，模型名称全部来自当前网页。 */
export function parseBuiltInModelPrices(template: string, html: string, cacheHtml = ''): { prices: ModelPrice[]; unavailableModels: string[] } {
  const prices: ModelPrice[] = [];
  const unavailableModels: string[] = [];
  if (template === 'deepseek') {
    const rows = tableRows(html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/iu)?.[1] ?? '');
    const header = rows.find((row) => row[0] === 'MODEL');
    const body = text(html);
    /** 官网明示节假日例外；工作日高峰缺少节假日依据时宁可不估算。 */
    const scheduleKnown = body.includes('01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays');
    if (header && scheduleKnown) {
      for (let column = 1; column < header.length; column += 1) {
        const model = header[column]!.replace(/\s*\(\d+\)$/u, '');
        if (model === 'MODEL' || !/^[a-z0-9][a-z0-9._/-]*$/iu.test(model)) continue;
        const inputRow = rows.find((row) => row.includes('1M INPUT TOKENS (CACHE MISS)') && row.includes('OFF-PEAK'));
        const outputRow = rows.find((row) => row.includes('1M OUTPUT TOKENS') && row.includes('OFF-PEAK'));
        const cachedRow = rows.find((row) => row.includes('1M INPUT TOKENS (CACHE HIT)') && row.includes('OFF-PEAK'));
        const input = price(inputRow?.at(column - header.length), 'USD');
        const output = price(outputRow?.at(column - header.length), 'USD');
        const cachedInput = price(cachedRow?.at(column - header.length), 'USD');
        if (input === null || output === null) {
          unavailableModels.push(model);
          continue;
        }
        prices.push({
          model,
          currency: 'USD',
          perMillion: { input, output, cachedInput, cacheWrite: null },
          perRequest: null,
          excludedUtcWindows: [
            { weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 },
            { weekdays: [1, 2, 3, 4, 5], startMinute: 360, endMinute: 600 },
          ],
          basis: '官网非高峰公开价；工作日高峰涉及法定节假日，缺少日历依据时不估算',
          evidence: JSON.stringify({ header, inputRow, outputRow, cachedRow }),
        });
      }
    }
  } else if (template === 'kimi') {
    /** 官方 Markdown 的 DocTable 是数据，不执行其中的 JSX 或脚本。 */
    for (const table of html.matchAll(/<DocTable\s+columns=\{\[([\s\S]*?)\]\}\s+rows=\{\[([\s\S]*?)\]\}\s*\/>/gu)) {
      const columns = [...table[1]!.matchAll(/title:\s*("(?:[^"\\]|\\.)*")/gu)].map((match) => JSON.parse(match[1]!) as string);
      const inputColumn = columns.indexOf('输入价格（缓存未命中）');
      const cacheColumn = columns.indexOf('输入价格（缓存命中）');
      const outputColumn = columns.indexOf('输出价格');
      if (columns[0] !== '模型' || columns[1] !== '计费单位' || inputColumn < 0 || cacheColumn < 0 || outputColumn < 0) continue;
      for (const match of table[2]!.matchAll(/\[[^[\]]+\]/gu)) {
        const row: unknown = JSON.parse(match[0]);
        if (!Array.isArray(row) || row.length !== columns.length || !row.every((value) => typeof value === 'string') || row[1] !== '1M tokens') continue;
        const input = price(row[inputColumn].replace(/^¥/u, '$'), 'USD');
        const output = price(row[outputColumn].replace(/^¥/u, '$'), 'USD');
        if (input === null || output === null) {
          unavailableModels.push(row[0]);
          continue;
        }
        prices.push({
          model: row[0],
          currency: 'CNY',
          perMillion: { input, output, cachedInput: price(row[cacheColumn].replace(/^¥/u, '$'), 'USD'), cacheWrite: null },
          perRequest: null,
          basis: '官网人民币标准公开价；缓存写入涉及 TTL 档位，未确认时不估算缓存写入',
          evidence: JSON.stringify({ columns, row }),
        });
      }
    }
  } else if (template === 'zai') {
    if (!text(html).includes('Prices per 1M tokens.')) return { prices, unavailableModels };
    for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)) {
      const rows = tableRows(table[1]!);
      if (rows[0]?.join('|') !== 'Model|Input|Cached Input|Cached Input Storage|Output') continue;
      for (const row of rows.slice(1)) {
        /** 此官网展示名称与接口标识采用固定大小写转换，非相似模型匹配。 */
        const model = row[0]?.toLowerCase();
        const input = price(row[1], 'USD');
        const output = price(row[4], 'USD');
        if (!model || !/^[a-z0-9][a-z0-9._/-]*$/u.test(model)) continue;
        if (input === null || output === null || !/^(?:Limited-time Free|Free)$/u.test(row[3] ?? '')) {
          unavailableModels.push(model);
          continue;
        }
        prices.push({ model, currency: 'USD', perMillion: { input, output, cachedInput: price(row[2], 'USD'), cacheWrite: null }, perRequest: null, basis: '官网标准 Token 公开价，缓存存储当前标示免费', evidence: JSON.stringify(row) });
      }
    }
  } else if (template === 'bailian') {
    /** 内置连接是北京地域接口；不能拿海外地域或批处理折扣计价。 */
    let beijing = false;
    let service = '';
    const schedule = publishedPriceWindows(text(html));
    const cacheDiscounts = publishedCacheMultipliers(cacheHtml);
    for (const section of html.matchAll(/<(h[1-6]|table)\b[^>]*>([\s\S]*?)<\/\1>/giu)) {
      if (section[1] !== 'table') {
        const heading = text(section[2]!).replace(/\s/gu, '');
        const areaHeading = /^(?:华北\d|美国|德国|日本|中国香港|新加坡)(?:[（(]|$)/u.test(heading);
        if (/^h[1-3]$/u.test(section[1]!) || (section[1] === 'h4' && !areaHeading)) service = heading;
        if (areaHeading || /^h[1-4]$/u.test(section[1]!)) beijing = heading === '华北2（北京）';
        continue;
      }
      if (!beijing) continue;
      const rows = tableRows(section[2]!);
      const header = rows[0] ?? [];
      const inputColumn = header.findIndex((cell) => /^输入单价（每百万\s*Token）/u.test(cell));
      const outputColumn = header.findIndex((cell) => /^输出单价（每百万\s*Token）/u.test(cell));
      const rangeColumn = header.findIndex((cell) => /单次请求的输入/u.test(cell));
      if (header[0] !== '模型 ID（Model ID）') continue;
      for (const row of rows.slice(1)) {
        const model = row[0]?.match(/^([a-z0-9][a-z0-9._/-]*)(?:\s|$)/u)?.[1];
        if (!model) continue;
        if (service === '千问图像生成与编辑2.0系列' && header.join('|') === '模型 ID（Model ID）|输出单价|免费额度') {
          const unitPrice = row[1]?.match(/^(\d+(?:\.\d+)?)\s*元\s*\/\s*张$/u);
          if (!unitPrice) unavailableModels.push(model);
          else prices.push(meteredTablePrice(model, { charges: [{ meter: 'output_images', unit: 'image', quantityPerPrice: 1, amount: Number(unitPrice[1]), category: 'output' }] }, '北京公开按张价', { header, row }));
          continue;
        }
        if (inputColumn < 0 || outputColumn < 0) continue;
        if (rangeColumn < 0 && /忙时|闲时/u.test(`${row[inputColumn]} ${row[outputColumn]}`)) {
          const input = readPeakPrices(row[inputColumn]);
          const output = readPeakPrices(row[outputColumn]);
          const cache = cacheDiscounts.get(model);
          if (!schedule || !input || !output || !cache) unavailableModels.push(model);
          else {
            for (const kind of ['busy', 'idle'] as const) {
              /** 实时推理采用隐式缓存。显式缓存写入由另一套条件计价。 */
              const charges: MeteredCharge[] = [
                { meter: 'input_tokens', unit: 'token', quantityPerPrice: 1_000_000, amount: input[kind], category: 'input' },
                { meter: 'cached_input_tokens', unit: 'token', quantityPerPrice: 1_000_000, amount: input[kind] * cache.multiplier, category: 'input' },
                { meter: 'cache_write_tokens', unit: 'token', quantityPerPrice: 1_000_000, amount: null, category: 'input' },
                { meter: 'output_tokens', unit: 'token', quantityPerPrice: 1_000_000, amount: output[kind], category: 'output' },
              ];
              prices.push(meteredTablePrice(model, { charges, windows: schedule[kind] }, '北京实时推理公开价和隐式缓存折扣', { header, row, cache: cache.evidence, schedule: schedule.evidence }));
            }
          }
          continue;
        }
        if (rangeColumn < 0) continue;
        const input = price(row[inputColumn], 'CNY');
        const output = price(row[outputColumn], 'CNY');
        const band = row[rangeColumn]?.replace(/\s/gu, '').match(/^(\d+)([KM]?)<Token≤(\d+)([KM]?)$/iu);
        if (input === null || output === null || (!band && row[rangeColumn] !== '无阶梯计价')) {
          unavailableModels.push(model);
          continue;
        }
        const units: Record<string, number> = { '': 1, K: 1000, M: 1_000_000 };
        const inputRange = band ? { minExclusive: Number(band[1]) * units[band[2]!.toUpperCase()]!, maxInclusive: Number(band[3]) * units[band[4]!.toUpperCase()]! } : undefined;
        prices.push({
          model,
          currency: 'CNY',
          perMillion: { input, output, cachedInput: null, cacheWrite: null },
          perRequest: null,
          ...(inputRange ? { inputRange } : {}),
          basis: '北京地域标准公开价，不含批处理折扣；缓存单价未确认时不估算缓存用量',
          evidence: JSON.stringify({ header, row }),
        });
      }
    }
  }
  /** 同一模型多个模式或重复栏目若费率冲突，估算器会拒绝同时命中的条目。 */
  return {
    prices: [...new Map(prices.map((entry) => [JSON.stringify({ model: entry.model, perMillion: entry.perMillion, inputRange: entry.inputRange, metered: entry.metered }), entry])).values()],
    unavailableModels: [...new Set(unavailableModels)],
  };
}

/** 只接收同时明确标出峰、谷和币种的官方单元格。 */
function readPeakPrices(value: string | undefined): { busy: number; idle: number } | null {
  const values = value?.match(/^忙时\s*(\d+(?:\.\d+)?)\s*元\s*闲时\s*(\d+(?:\.\d+)?)\s*元$/u);
  return values ? { busy: Number(values[1]), idle: Number(values[2]) } : null;
}

/** 从原文解析每天互补的时段，跨午夜拆成两个区间。 */
function publishedPriceWindows(body: string): { busy: NonNullable<MeteredPrice['windows']>; idle: NonNullable<MeteredPrice['windows']>; evidence: string } | null {
  const found = body.match(/忙时为北京时间\s*(\d{2}:\d{2})\s*至\s*(\d{2}:\d{2})\s*，\s*闲时为北京时间\s*\2\s*至次日\s*\1\s*。/u);
  if (!found) return null;
  const [start, end] = [found[1]!, found[2]!].map((clock) => {
    const [hour, minute] = clock.split(':').map(Number);
    return hour! < 24 && minute! < 60 ? hour! * 60 + minute! : NaN;
  });
  if (!(start! > 0 && end! < 1440 && start! < end!)) return null;
  const window = (startMinute: number, endMinute: number) => ({ timeZone: 'Asia/Shanghai', weekdays: [0, 1, 2, 3, 4, 5, 6], startMinute, endMinute });
  return { busy: [window(start!, end!)], idle: [window(0, start!), window(end!, 1440)], evidence: found[0] };
}

/** 按文档给出的精确 ID 为隐式缓存匹配输入费率倍率。 */
function publishedCacheMultipliers(html: string): Map<string, { multiplier: number; evidence: string }> {
  const multipliers = new Map<string, { multiplier: number; evidence: string }>();
  const disputed = new Set<string>();
  for (const item of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)) {
    const evidence = text(item[1]!);
    const rule = evidence.match(/^([a-z0-9][a-z0-9._-]*(?:\s*、\s*[a-z0-9][a-z0-9._-]*)*)\s*：\s*cached_token\s*单价为\s*input_token\s*单价的\s*(\d+(?:\.\d+)?)%/u);
    if (!rule) continue;
    const multiplier = Number(rule[2]) / 100;
    if (!(multiplier >= 0 && multiplier <= 1)) continue;
    for (const model of rule[1]!.split('、').map((id) => id.trim())) {
      const old = multipliers.get(model);
      if (old && old.multiplier !== multiplier) disputed.add(model);
      multipliers.set(model, { multiplier, evidence });
    }
  }
  for (const model of disputed) multipliers.delete(model);
  return multipliers;
}

/** 所有计量价目写入相同的目录类型，当前页面的读取时间由目录保存。 */
function meteredTablePrice(model: string, metered: MeteredPrice, basis: string, evidence: object): ModelPrice {
  return { model, currency: 'CNY', perMillion: null, perRequest: null, metered, basis, evidence: JSON.stringify(evidence) };
}
