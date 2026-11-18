import { bailianCachePricingUrl, parseBuiltInModelPrices, readBuiltInPricingPage } from './builtInModelPricing.js';
import { createHash } from 'node:crypto';
import { isOfficialBailianBeijingConnection, modelConnectionTemplates, type ModelConnectionRecord } from '@zeus/ai-runtime';
import { estimateModelPrice, isMeteredCatalogPrice, parseModelPricingProfile, type ModelPrice, type ModelPricingCatalog, type TokenUsageBreakdown } from '@zeus/shared';
import type { SettingRepository } from '@zeus/storage';
import { normalizePricingUrl, readPricingDocument } from './modelPricingDocument.js';
import { readMappedPriceDocument, readUnifiedPriceDocument } from './structuredModelPricing.js';
import { isKiloConnection, kiloModelsUrl } from './kiloAccountUsage.js';

/** 内置连接的公开来源，模型列表从页面读取。 */
export const builtInPricingUrls: Record<string, string> = {
  kilo: kiloModelsUrl,
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing/',
  bailian: 'https://help.aliyun.com/zh/model-studio/model-pricing',
  kimi: 'https://platform.kimi.com/docs/pricing/chat',
  zai: 'https://docs.z.ai/guides/overview/pricing',
};

/** 旧目录把部分缺价写入 error，读取时还原为成功的价格目录。 */
const legacyPartialPricingWarning = '部分模型计价条件不明确或价格变化异常，暂不估算。';

/** 供应商公开清单共用缓存、刷新和未知状态；不持有会话内容。 */
export function createModelPricingService(options: {
  /** 复用现有设置存储。 */
  settings: SettingRepository;
  /** 同步读取连接身份。 */
  connections(): ModelConnectionRecord[];
  /** 持久化现有数据库。 */
  save(): Promise<void>;
  /** 只读取已经绑定到此价目地址的独立凭据。 */
  readPricingToken?(id: string): Promise<string | null | undefined>;
  /** 可替换时钟供现有专项探针使用。 */
  now(): string;
  /** 成功读取目录后补齐同连接的历史缺价。 */
  onCatalogUpdated?: (connection: ModelConnectionRecord, catalog: ModelPricingCatalog) => Promise<void>;
}) {
  /** 同一连接的手工与后台读取合并为一次请求。 */
  const active = new Map<string, Promise<ModelPricingCatalog>>();
  /** 失败后五分钟、成功后一小时再自动尝试。 */
  const nextAttempt = new Map<string, number>();
  /** 新模型缺价最多每个连接五分钟主动补读一次。 */
  const missingAttempt = new Map<string, number>();
  /** 服务退出取消未完成的价格读取。 */
  const controller = new AbortController();

  /** 来源必须绑定当前连接配置，换页面后不继续套用旧站价格。 */
  function source(connection: ModelConnectionRecord): string | null {
    if (connection.pricingUrl) return connection.pricingUrl;
    if (isKiloConnection(connection)) return kiloModelsUrl;
    if (isOfficialBailianBeijingConnection(connection)) return builtInPricingUrls.bailian ?? null;
    if (connection.templateId === 'custom') return null;
    return new URL(connection.baseUrl).origin === new URL(modelConnectionTemplates[connection.templateId].baseUrl).origin ? (builtInPricingUrls[connection.templateId] ?? null) : null;
  }

  /** 已核对的缓存只适用于同一份价格配置和认证范围。 */
  function sourceRevision(connection: ModelConnectionRecord): string | undefined {
    return connection.pricingProfile || connection.pricingCredentialId
      ? createHash('sha256')
          .update(JSON.stringify([connection.pricingProfile, connection.pricingCredentialId]))
          .digest('hex')
      : undefined;
  }

  /** 已保存目录只读；配置来源变更会自然失效。 */
  function read(connection: ModelConnectionRecord): ModelPricingCatalog | null {
    const saved = options.settings.getJson<ModelPricingCatalog>(`models.pricing.${connection.id}`);
    if (!saved || saved.url !== source(connection) || saved.sourceRevision !== sourceRevision(connection) || !Array.isArray(saved.prices) || !saved.prices.every(validModelPrice)) return null;
    return saved.retrievedAt && saved.error === legacyPartialPricingWarning ? { ...saved, error: null } : saved;
  }

  /** 首次与变更时识别整张清单，未知条目不会阻断其他已验证模型。 */
  function refresh(connection: ModelConnectionRecord): Promise<ModelPricingCatalog> {
    const url = source(connection);
    if (!url) return Promise.reject(new Error('请补充价格清单页面。'));
    const revision = sourceRevision(connection);
    const refreshKey = JSON.stringify([connection.id, url, revision]);
    const pending = active.get(refreshKey);
    if (pending) return pending;
    const previous = read(connection);
    const job = (async () => {
      let catalog: ModelPricingCatalog = {
        url,
        ...(revision ? { sourceRevision: revision } : {}),
        retrievedAt: previous?.retrievedAt ?? null,
        observedAt: previous?.observedAt ?? previous?.retrievedAt ?? undefined,
        checkedAt: options.now(),
        documentHash: previous?.documentHash ?? '',
        prices: previous?.prices ?? [],
        unavailableModels: previous?.unavailableModels ?? [],
        error: null,
      };
      try {
        normalizePricingUrl(url);
        const profile = connection.pricingProfile ? parseModelPricingProfile(connection.pricingProfile) : undefined;
        const mapped = profile?.source;
        const configured = profile?.prices ?? [];
        let recognized: { prices: ModelPrice[]; unavailableModels: string[] } | null = null;
        let document = '';
        if (mapped) {
          const token = mapped.bearer && connection.pricingCredentialId ? await options.readPricingToken?.(connection.pricingCredentialId) : undefined;
          if (mapped.bearer && !token) throw new Error('此价格源需要单独的价格令牌。');
          recognized = await readMappedPriceDocument(url, mapped, controller.signal, token ?? undefined);
          document = JSON.stringify(recognized);
        } else {
          const kilo = isKiloConnection(connection) && url === kiloModelsUrl;
          const builtIn = !kilo && url === builtInPricingUrls[connection.templateId];
          if (configured.length && !builtIn && !kilo) {
            /** 已核对的本地价目配置可直接使用，配置的 URL 保留原始依据。 */
            recognized = { prices: [], unavailableModels: [] };
          } else {
            const [mainDocument, cacheDocument] = await Promise.all([
              builtIn ? readBuiltInPricingPage(connection.templateId === 'kimi' ? url + '.md' : url, controller.signal) : readPricingDocument(url, controller.signal),
              builtIn && connection.templateId === 'bailian' ? readBuiltInPricingPage(bailianCachePricingUrl, controller.signal).catch(() => '') : '',
            ]);
            document = mainDocument;
            let json: unknown;
            try {
              json = JSON.parse(document);
            } catch {
              /* HTML 交给已有协议判定。 */
            }
            const standardPrices = readUnifiedPriceDocument(json);
            recognized = standardPrices ? { prices: standardPrices, unavailableModels: [] } : kilo ? parseKiloPricing(json) : builtIn ? parseBuiltInModelPrices(connection.templateId, document, cacheDocument) : parseNewApiPricing(json);
            if (builtIn && connection.templateId === 'bailian' && recognized) document = JSON.stringify(recognized);
            if (!recognized && /new[ -]?api|\/static\/js\/|\/assets\//iu.test(document)) {
              try {
                const data = await readPricingDocument(new URL('/api/pricing', url).href, controller.signal);
                recognized = parseNewApiPricing(JSON.parse(data));
                if (recognized) document = data;
              } catch {
                // 无法确认公开目录时保留价格未知。
              }
            }
          }
        }
        if (!recognized) throw new Error('价格源没有可校验的结构化价目。');
        if (configured.length) {
          const models = new Set(configured.map((price) => price.model));
          recognized = { prices: [...recognized.prices.filter((price) => !models.has(price.model)), ...configured], unavailableModels: recognized.unavailableModels.filter((model) => !models.has(model)) };
        }
        const hash = createHash('sha256').update(document).update(JSON.stringify(configured)).digest('hex');
        if (hash === previous?.documentHash && previous.retrievedAt) catalog = { ...catalog, retrievedAt: options.now() };
        else {
          if (!recognized.prices.length && !recognized.unavailableModels.length) throw new Error('页面没有可确定币种、单位及适用条件的价格。');
          /** 币种、计费方式改变或数量级突变时暂停受影响条目，其他模型照常更新。 */
          recognized.prices = recognized.prices.filter((price) => {
            if (price.metered) return true;
            const old = previous?.prices.find((entry) => entry.model === price.model && !entry.metered);
            if (!old) return true;
            const before = old.perMillion?.input ?? old.perRequest;
            const after = price.perMillion?.input ?? price.perRequest;
            const changed = old.currency !== price.currency || Boolean(old.perMillion) !== Boolean(price.perMillion) || (before !== null && after !== null && before > 0 && (after / before > 10 || after / before < 0.1));
            if (changed) recognized!.unavailableModels.push(price.model);
            return !changed;
          });
          const retrievedAt = options.now();
          catalog = { ...catalog, retrievedAt, observedAt: retrievedAt, documentHash: hash, ...recognized };
        }
        /** 成功读取后按常规间隔更新，缺价继续记录在 unavailableModels。 */
        nextAttempt.set(connection.id, Date.parse(options.now()) + 60 * 60_000);
      } catch (error) {
        catalog.error = error instanceof Error ? error.message : '价格页面读取失败。';
        nextAttempt.set(connection.id, Date.parse(options.now()) + 5 * 60_000);
      }
      /** 联网期间删除连接或更换来源后丢弃旧结果。 */
      if (!controller.signal.aborted && options.connections().some((current) => current.id === connection.id && source(current) === url && sourceRevision(current) === revision)) {
        options.settings.setJson(`models.pricing.${connection.id}`, catalog);
        await options.save();
        if (catalog.retrievedAt && !catalog.error) await options.onCatalogUpdated?.(connection, catalog);
      }
      return catalog;
    })().finally(() => active.delete(refreshKey));
    active.set(refreshKey, job);
    return job;
  }

  /** 周期刷新也覆盖已有价格，价格更新只作用于后续请求。 */
  async function refreshDue(): Promise<void> {
    for (const connection of options.connections()) {
      if (controller.signal.aborted) return;
      const catalog = read(connection);
      const due = catalog ? (nextAttempt.get(connection.id) ?? Date.parse(catalog.checkedAt) + (catalog.error ? 5 * 60_000 : 60 * 60_000)) : 0;
      if (connection.enabled && source(connection) && Date.parse(options.now()) >= due) await refresh(connection);
    }
  }

  return {
    source,
    read,
    refresh,
    refreshDue,
    /** 新模型不必等待常规小时刷新，同时避免每次请求重复读取页面。 */
    async refreshForModel(connection: ModelConnectionRecord, model: string): Promise<void> {
      if (!source(connection)) return;
      const missing = !read(connection)?.prices.some((price) => price.model === model);
      const now = Date.parse(options.now());
      if (missing && now >= (missingAttempt.get(connection.id) ?? 0)) {
        missingAttempt.set(connection.id, now + 5 * 60_000);
        await refresh(connection);
      } else await refreshDue();
    },
    /** 调用方可传入请求开始时捕获的目录，结束时不读取新价格。 */
    estimate(connection: ModelConnectionRecord, model: string, usage: TokenUsageBreakdown, catalog = read(connection)) {
      return estimateModelPrice(model, usage, catalog);
    },
    /** 退出等待所有本实例操作完成，避免关闭后写入。 */
    async dispose() {
      controller.abort();
      await Promise.allSettled(active.values());
    },
  };
}

/** Kilo 官方价格以美元/Token 返回；缓存缺价保持未知，绝不套用其他供应商同名模型单价。 */
function parseKiloPricing(value: unknown): { prices: ModelPrice[]; unavailableModels: string[] } {
  const data = record(value).data;
  if (!Array.isArray(data)) throw new Error('Kilo 模型价格目录缺少 data 数组。');
  const prices: ModelPrice[] = [];
  const unavailableModels: string[] = [];
  /** 官方单价是十进制字符串；空值、负值和非法数值不转换成免费。 */
  const rate = (value: unknown): number | null => {
    if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) return null;
    const result = Number(value) * 1_000_000;
    return Number.isFinite(result) && result >= 0 ? result : null;
  };
  for (const entry of data) {
    const model = record(entry);
    if (typeof model.id !== 'string' || !model.id.trim()) continue;
    const pricing = record(model.pricing);
    const input = rate(pricing.prompt);
    const output = rate(pricing.completion);
    // 混合按次、图片或独立推理计费超出现有 Token 账本能力，不能显示为完整估算。
    const extraCharge = ['request', 'image', 'internal_reasoning'].some((field) => pricing[field] != null && rate(pricing[field]) !== 0);
    if (input === null || output === null || extraCharge || (pricing.discount != null && pricing.discount !== 0)) {
      unavailableModels.push(model.id);
      continue;
    }
    prices.push({
      model: model.id,
      currency: 'USD',
      perMillion: { input, output, cachedInput: rate(pricing.input_cache_read), cacheWrite: rate(pricing.input_cache_write) },
      perRequest: null,
      basis: 'Kilo 官方 Token 单价；不含搜索等额外服务费用。',
      evidence: JSON.stringify({ model: model.id, pricing, unit: 'USD/token' }),
    });
  }
  return { prices, unavailableModels };
}

/** JSON 边界统一拒绝非对象。 */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
/** 金额必须有限且非负，空字符串不能被转换成零。 */
function amount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** 存储和提取结果共用金额约束，拒绝缺字段与混合计价。 */
export function validModelPrice(value: unknown): value is ModelPrice {
  const price = record(value);
  if (price.metered !== undefined) return isMeteredCatalogPrice(value);
  const rates = record(price.perMillion);
  /** 条件字段也属于不可信存储边界，不能绕过金额校验。 */
  const range = record(price.inputRange);
  const rangeValid = price.inputRange === undefined || (amount(range.minExclusive) && amount(range.maxInclusive) && range.maxInclusive > range.minExclusive);
  const windowsValid =
    price.excludedUtcWindows === undefined ||
    (Array.isArray(price.excludedUtcWindows) &&
      price.excludedUtcWindows.every((value) => {
        const window = record(value);
        return (
          Array.isArray(window.weekdays) &&
          window.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
          amount(window.startMinute) &&
          amount(window.endMinute) &&
          Number.isInteger(window.startMinute) &&
          Number.isInteger(window.endMinute) &&
          window.startMinute < window.endMinute &&
          window.endMinute <= 1440
        );
      }));
  return (
    rangeValid &&
    windowsValid &&
    typeof price.model === 'string' &&
    price.model.length > 0 &&
    price.model.length <= 256 &&
    typeof price.currency === 'string' &&
    /^[A-Z]{3}$/u.test(price.currency) &&
    typeof price.basis === 'string' &&
    typeof price.evidence === 'string' &&
    (price.perMillion === null
      ? amount(price.perRequest)
      : price.perRequest === null && amount(rates.input) && amount(rates.output) && (rates.cachedInput === null || amount(rates.cachedInput)) && (rates.cacheWrite === null || amount(rates.cacheWrite)))
  );
}

/** New API 标准美元公开价：输入倍率乘二得到每百万 Token 单价，分组取公开默认组。 */
export function parseNewApiPricing(value: unknown): { prices: ModelPrice[]; unavailableModels: string[] } | null {
  const payload = record(value);
  if (payload.success !== true || !Array.isArray(payload.data) || !Array.isArray(payload.auto_groups) || !payload.auto_groups.includes('default') || !amount(record(payload.group_ratio).default)) return null;
  const multiplier = record(payload.group_ratio).default as number;
  const prices: ModelPrice[] = [];
  const unavailableModels: string[] = [];
  for (const item of payload.data) {
    const row = record(item);
    const model = row.model_name;
    if (typeof model !== 'string' || !model || model.length > 256) continue;
    if (!Array.isArray(row.enable_groups) || !row.enable_groups.includes('default') || row.billing_expr || (row.billing_mode && row.billing_mode !== 'tokens')) {
      unavailableModels.push(model);
      continue;
    }
    const base = amount(row.model_ratio) ? row.model_ratio * 2 * multiplier : null;
    const price: ModelPrice = { model, currency: 'USD', basis: 'New API 标准美元公开价；默认分组，不含充值折扣及私人优惠', evidence: JSON.stringify({ row, group: 'default', groupRatio: multiplier }), perMillion: null, perRequest: null };
    if (row.quota_type === 0 && base !== null && amount(row.completion_ratio))
      price.perMillion = { input: base, output: base * row.completion_ratio, cachedInput: amount(row.cache_ratio) ? base * row.cache_ratio : null, cacheWrite: amount(row.create_cache_ratio) ? base * row.create_cache_ratio : null };
    else if (row.quota_type === 1 && amount(row.model_price)) price.perRequest = row.model_price * multiplier;
    if (validModelPrice(price) && !prices.some((existing) => existing.model === model)) prices.push(price);
    else unavailableModels.push(model);
  }
  return { prices: prices.filter((price) => !unavailableModels.includes(price.model)), unavailableModels: [...new Set(unavailableModels)] };
}

/** 原文逐条核对金额与单位，模型输出不能直接成为账本规则。 */
export function parseExtractedPrices(json: string, document: string): { prices: ModelPrice[]; unavailableModels: string[] } {
  const rows: unknown = JSON.parse(json.replace(/^```(?:json)?\s*|\s*```$/gu, ''));
  if (!Array.isArray(rows) || rows.length > 200) throw new Error('价格识别结果格式不完整。');
  const prices: ModelPrice[] = [];
  const unavailableModels: string[] = [];
  for (const value of rows) {
    const row = record(value);
    const evidence = typeof row.evidence === 'string' ? row.evidence : '';
    const model = typeof row.model === 'string' ? row.model : '';
    const currency = typeof row.currency === 'string' ? row.currency : '';
    const unit = row.unit;
    const matches =
      evidence && document.includes(evidence) && evidence.includes(model) && evidence.includes(currency) && (unit === 1_000_000 ? /million|百万|1,?000,?000/iu.test(evidence) : unit === 1000 && /thousand|千|1,?000/iu.test(evidence));
    const values = [row.input, row.output, row.cachedInput, row.cacheWrite];
    if (
      !matches ||
      row.unconditional !== true ||
      !amount(row.input) ||
      !amount(row.output) ||
      !values.every((value) => value === null || (amount(value) && new RegExp(`(^|[^\\d.])${String(value).replace('.', '\\.')}([^\\d.]|$)`, 'u').test(evidence)))
    ) {
      if (model) unavailableModels.push(model);
      continue;
    }
    const scale = 1_000_000 / (unit as number);
    const price: ModelPrice = {
      model,
      currency,
      perMillion: { input: row.input * scale, output: row.output * scale, cachedInput: amount(row.cachedInput) ? row.cachedInput * scale : null, cacheWrite: amount(row.cacheWrite) ? row.cacheWrite * scale : null },
      perRequest: null,
      basis: '页面标准公开价；自动识别，不含私人优惠',
      evidence,
    };
    if (validModelPrice(price) && !prices.some((existing) => existing.model === model)) prices.push(price);
    else unavailableModels.push(model);
  }
  return { prices: prices.filter((price) => !unavailableModels.includes(price.model)), unavailableModels: [...new Set(unavailableModels)] };
}
