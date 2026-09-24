/** 缺价补算专项探针：临时数据库验证实际记账路径，按需运行，不加入发布门禁。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexUsageLedgerRepository, ConversationRepository, ProjectRepository, SettingRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import { emptyTokenUsageBreakdown, estimateCodexUsage } from '../packages/shared/src/codexUsage.js';
import { createCodexUsageService } from '../packages/local-server/src/codexUsageService.js';
import { parseBuiltInModelPrices, readBuiltInPricingPage } from '../packages/local-server/src/builtInModelPricing.js';
import { readPricingDocument } from '../packages/local-server/src/modelPricingDocument.js';
import { parseNewApiPricing, parseExtractedPrices, createModelPricingService, builtInPricingUrls, validModelPrice } from '../packages/local-server/src/modelPricingService.js';
import { estimateModelPrice, aggregateRequestPrices, sumEstimatedCosts } from '../packages/shared/src/modelPricing.js';
import { estimatePublishedCodexUsage, fetchPublishedCodexPricing, parsePublishedCodexPrices } from '../packages/local-server/src/codexUsagePricing.js';

/** 探针专用模型不会与实际供应商模型或账号关联。 */
const model = 'codex-price-probe';
/** 小型价格原文覆盖普通、快速与长上下文，不依赖外部价格变化。 */
const document = ['Standard', 'Fast']
  .map(
    (tier, index) => `### ${tier} pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ${model} | $${2 + index * 2} | $${0.5 + index * 0.5} | $${2.5 + index * 2.5} | $${8 + index * 8} | $8 | $2 | $10 | $24 |
`,
  )
  .join('\n');
/** 可变时钟只用于验证请求合并与失败后的重试间隔。 */
let now = Date.parse('2026-09-23T00:00:00.000Z');
/** 真实用量中的缓存读取、写入和普通输入分别计价。 */
const usage = { ...emptyTokenUsageBreakdown(), inputTokens: 1_000, cachedInputTokens: 400, cacheWriteInputTokens: 100, outputTokens: 200, totalTokens: 1_200 };
/** 原文验证一次，估算器消费已验证目录。 */
const catalog = { document, fetchedAt: new Date(now).toISOString() };
/** 提取的价格表用于各档位计算检查。 */
const prices = parsePublishedCodexPrices(document);
assert.equal(estimatePublishedCodexUsage({ catalog, prices, model, usage })?.apiEquivalentUsd, 0.00305);
assert.equal(estimatePublishedCodexUsage({ catalog, prices, model, usage, serviceTier: 'fast' })?.apiEquivalentUsd, 0.0061);
assert.equal(estimatePublishedCodexUsage({ catalog, prices, model: `${model}-2026-09-23`, usage }), null);
assert.equal(estimatePublishedCodexUsage({ catalog, prices, model, usage, serviceTier: 'unknown' }), null);
assert.equal(estimateCodexUsage({ model: 'gpt-5.6-terra', usage, serviceTier: 'flex' }).apiEquivalentUsd, null);
assert.equal(estimateCodexUsage({ model: 'gpt-5.6-terra', usage, serviceTier: 'fast' }).apiEquivalentUsd, estimateCodexUsage({ model: 'gpt-5.6-terra', usage, serviceTier: 'priority' }).apiEquivalentUsd);
assert.equal(estimatePublishedCodexUsage({ catalog, prices, model: 'unlisted', usage }), null);
assert.equal(estimatePublishedCodexUsage({ catalog, prices, model, usage: { ...usage, inputTokens: 300_000 } })?.rateSnapshot.usdPerMillion?.input, 8);
assert.throws(() => parsePublishedCodexPrices(document.replace('Short context input', 'Changed heading').replace('### Fast pricing data', '### Batch pricing data')));
assert.throws(() => parsePublishedCodexPrices(document.replace('$2', '$-2')));

/** 所有写入限定在独立临时目录。 */
const root = await mkdtemp(join(tmpdir(), 'zeus-usage-pricing-'));
/** 探针始终恢复系统网络入口。 */
const originalFetch = globalThis.fetch;
/** 实际 SQLite 账本验证幂等更新与缓存重载。 */
const db = await createZeusDatabase(join(root, 'usage.db'));
/** 共用真实仓库入口，不模拟账本存储行为。 */
const ledger = new CodexUsageLedgerRepository(db);
/** 现有设置存储保存官方原文与获取时间。 */
const settings = new SettingRepository(db);
/** 统计外部获取次数，确认有价时离线记账。 */
let downloads = 0;
/** 同一公开页面变更费率，验证新请求和旧快照分离。 */
let servedDocument = document;
/** 故障开关验证网络失败不伪造价格。 */
let unavailable = false;
/** 仅保留生命周期需要的当前服务引用。 */
let service: ReturnType<typeof createCodexUsageService> | null = null;

/** 写入完整账本事实；无外键设计允许独立验证费用，无需创建伪造会话。 */
function seed(turn: string, providerId = 'codex', pricedModel = model): void {
  ledger.upsert({
    providerId,
    accountScopeId: 'probe',
    projectId: 'probe',
    conversationId: 'probe',
    providerThreadId: 'probe',
    providerTurnId: turn,
    model: pricedModel,
    serviceTier: 'default',
    usage,
    usageComplete: true,
    estimate: estimateCodexUsage({ model: pricedModel, usage }),
    occurredAt: new Date(now - 86_400_000).toISOString(),
  });
}

/** 只替代账号读取与公网响应，其余均使用真实生产服务。 */
function createService(automaticPricing = true) {
  return createCodexUsageService({
    manager: { readAccount: async () => ({ accountScopeId: 'probe' }) } as unknown as Parameters<typeof createCodexUsageService>[0]['manager'],
    ledger,
    settings,
    conversations: new ConversationRepository(db),
    projects: new ProjectRepository(db),
    broadcast: () => undefined,
    persist: () => db.save(),
    now: () => new Date(now).toISOString(),
    automaticPricing,
  });
}

try {
  globalThis.fetch = async () => {
    downloads += 1;
    if (unavailable) throw new Error('探针模拟断网');
    return new Response(servedDocument);
  };
  seed('missing');
  seed('known', 'codex', 'gpt-5.6-terra');
  seed('reseller', 'api:reseller');
  /** 已知价格记录必须保持原样。 */
  const known = ledger.findByProviderTurn('codex', 'probe', 'known');
  service = createService();
  await Promise.all([service.refreshMissingPricing(), service.refreshMissingPricing()]);
  assert.equal(downloads, 1);
  assert.equal(ledger.findByProviderTurn('codex', 'probe', 'missing')?.estimate.apiEquivalentUsd, 0.00305);
  assert.ok(ledger.findByProviderTurn('codex', 'probe', 'missing')?.estimate.rateSnapshot.backfilledAt);
  assert.deepEqual(ledger.findByProviderTurn('codex', 'probe', 'known'), known);
  assert.equal(ledger.findByProviderTurn('api:reseller', 'probe', 'reseller')?.estimate.apiEquivalentUsd, null);
  await service.dispose();
  unavailable = true;
  seed('offline');
  service = createService();
  await service.refreshMissingPricing();
  assert.equal(downloads, 1);
  assert.equal(ledger.findByProviderTurn('codex', 'probe', 'offline')?.estimate.apiEquivalentUsd, 0.00305);
  await service.recordRequest({ projectId: 'probe', conversationId: 'current', providerThreadId: 'current', providerTurnId: 'current', requestId: 'first', model, usage, occurredAt: new Date(now).toISOString() });
  await service.recordRequest({ projectId: 'probe', conversationId: 'current', providerThreadId: 'current', providerTurnId: 'current', requestId: 'first', model, usage, occurredAt: new Date(now).toISOString() });
  await service.recordTurn({
    generationId: 'probe',
    sequence: 1,
    projectId: 'probe',
    conversationId: 'current',
    providerThreadId: 'current',
    providerTurnId: 'current',
    model,
    total: usage,
    last: usage,
    modelContextWindow: 1_000_000,
    occurredAt: new Date(now).toISOString(),
  });
  assert.equal(ledger.findByProviderTurn('codex', 'current', 'current')?.estimate.apiEquivalentUsd, 0.00305);
  assert.equal(ledger.findByProviderTurn('codex', 'current', 'current')?.estimate.rateSnapshot.backfilledAt, undefined);
  assert.equal(downloads, 1);
  assert.equal(ledger.findByProviderTurn('codex', 'current', 'current')?.estimate.requests?.length, 1);
  seed('not-published', 'codex', 'not-published');
  now = Date.now() + 2 * 60 * 60_000;
  await service.refreshMissingPricing();
  await service.refreshMissingPricing();
  assert.equal(downloads, 2);
  assert.equal(ledger.findByProviderTurn('codex', 'probe', 'not-published')?.estimate.apiEquivalentUsd, null);
  unavailable = false;
  servedDocument = document.replaceAll('$2 |', '$4 |');
  now += 10 * 60_000;
  await service.refreshMissingPricing();
  const nextRequest = await service.recordRequest({ projectId: 'probe', conversationId: 'current', providerThreadId: 'current', providerTurnId: 'current', requestId: 'second', model, usage, occurredAt: new Date(now).toISOString() });
  const updated = ledger.findByProviderTurn('codex', 'current', 'current')!;
  assert.equal(updated.estimate.requests?.[0]?.estimate.apiEquivalentUsd, 0.00305);
  assert.ok(nextRequest.apiEquivalentUsd! > 0.00305);
  assert.equal(updated.estimate.requests?.length, 2);
  assert.equal(updated.estimate.apiEquivalentUsd, 0.00305 + nextRequest.apiEquivalentUsd!);
  await service.dispose();
  service = createService(false);
  now += 10 * 60_000;
  await service.refreshMissingPricing();
  assert.equal(downloads, 3);
  console.log('通过：公开表解析、金额与档位、并发合并、历史补价标记、已知价格保留、离线缓存、新轮次计价、失败冷却、第三方隔离、只读禁写。');
} finally {
  globalThis.fetch = originalFetch;
  await service?.dispose();
  await db.close();
  await rm(root, { recursive: true, force: true });
}

// 可选联网检查实际官网结构；仅访问公开页面，不读取账号或产生模型调用费用。
if (process.argv.includes('--live')) {
  /** 超时与来源限制沿用生产下载入口。 */
  const live = await fetchPublishedCodexPricing(new AbortController().signal);
  /** 真实文档必须解析出交互价格，不以 HTTP 成功代替价格解析成功。 */
  const livePrices = parsePublishedCodexPrices(live.document);
  assert.ok(livePrices.length > 0);
  console.log(`官网读取通过：${livePrices.length} 个模型与服务档位组合；获取时间 ${live.fetchedAt}。`);
}

/** 动态新模型、分组限制和缺失缓存费率通过同一生产解析器验证。 */
const publicRows = {
  success: true,
  auto_groups: ['default'],
  group_ratio: { default: 1 },
  data: [
    { model_name: 'new/model_name', enable_groups: ['default'], quota_type: 0, model_ratio: 1, completion_ratio: 4, cache_ratio: 0.1 },
    { model_name: 'private-image', enable_groups: ['vip'], quota_type: 1, model_price: 0.1 },
  ],
};
const parsed = parseNewApiPricing(publicRows)!;
assert.equal(parsed.prices[0]?.model, 'new/model_name');
assert.deepEqual(parsed.unavailableModels, ['private-image']);
const baseCatalog = { url: 'https://example.com/pricing', retrievedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), documentHash: 'probe', ...parsed, error: null };
const requestUsage = { ...usage, cacheWriteInputTokens: 0 };
const firstPrice = estimateModelPrice('new/model_name', requestUsage, baseCatalog);
const changedCatalog = { ...baseCatalog, prices: baseCatalog.prices.map((price) => ({ ...price, currency: 'CNY', perMillion: { ...price.perMillion!, input: 3, output: 12 } })) };
const nextPrice = estimateModelPrice('new/model_name', requestUsage, changedCatalog);
assert.equal(nextPrice.apiEquivalentUsd, null);
assert.ok(nextPrice.costs?.[0]?.amount);
const combined = aggregateRequestPrices([
  { id: 'a', occurredAt: baseCatalog.checkedAt, usage: requestUsage, estimate: firstPrice },
  { id: 'b', occurredAt: baseCatalog.checkedAt, usage: requestUsage, estimate: nextPrice },
]);
assert.equal(sumEstimatedCosts([combined]).length, 2);
assert.equal(firstPrice.rateSnapshot.price?.perMillion?.input, 2);
assert.equal(estimateModelPrice('new/model_name', usage, baseCatalog).costs, undefined);
assert.equal(estimateModelPrice('unknown-model', requestUsage, baseCatalog).apiEquivalentUsd, null);
assert.deepEqual(
  parseExtractedPrices('[{"model":"invented","currency":"USD","unit":1000000,"input":1,"output":2,"cachedInput":null,"cacheWrite":null,"unconditional":true,"evidence":"invented USD million 1 2"}]', 'unrelated page').prices,
  [],
);
await assert.rejects(readPricingDocument('http://127.0.0.1/pricing'));
await assert.rejects(readPricingDocument('http://[::1]/pricing'));
console.log('通过：动态模型标识、分组隔离、请求费率保留、币种分开汇总、未知缓存与未知模型、原文证据和内网读取限制。');

/** 真实自定义页面仅由显式参数指定，不把某家供应商写死在生产代码中。 */
const sourceIndex = process.argv.indexOf('--pricing-url');
if (sourceIndex >= 0) {
  const url = process.argv[sourceIndex + 1];
  assert.ok(url);
  const liveRoot = await mkdtemp(join(tmpdir(), 'zeus-pricing-page-'));
  const liveDb = await createZeusDatabase(join(liveRoot, 'pricing.db'));
  const connection = { id: 'pricing-live-probe', pricingUrl: url, enabled: true, templateId: 'custom', models: [] } as unknown as import('@zeus/ai-runtime').ModelConnectionRecord;
  const pricing = createModelPricingService({
    settings: new SettingRepository(liveDb),
    connections: () => [connection],
    save: () => liveDb.save(),
    now: () => new Date().toISOString(),
    extract: async () => {
      throw new Error('此探针不发送付费识别请求。');
    },
  });
  try {
    const result = await pricing.refresh(connection);
    assert.ok(result.prices.length > 0, result.error ?? '没有识别到价格');
    assert.ok(pricing.read(connection)?.retrievedAt);
    console.log(
      JSON.stringify({
        url,
        recognized: result.prices.map((price) => ({ model: price.model, currency: price.currency, perMillion: price.perMillion, perRequest: price.perRequest })),
        unavailable: result.unavailableModels,
        retrievedAt: result.retrievedAt,
      }),
    );
  } finally {
    await pricing.dispose();
    await liveDb.close();
    await rm(liveRoot, { recursive: true, force: true });
  }
}

/** 内置表格的模型名是数据；新增命名不要求更新程序。 */
const zaiTable =
  '<p>Prices per 1M tokens.</p><table><tr><th>Model</th><th>Input</th><th>Cached Input</th><th>Cached Input Storage</th><th>Output</th></tr><tr><td>NEW-MODEL_2027</td><td>$2</td><td>$0.2</td><td>Free</td><td>$8</td></tr></table>';
assert.equal(parseBuiltInModelPrices('zai', zaiTable).prices[0]?.model, 'new-model_2027');
assert.equal(parseBuiltInModelPrices('zai', zaiTable.replace('Input</th>', 'Changed</th>')).prices.length, 0);
/** 上下文上限之外未知，时段无法确定时也不借用另一个费率。 */
const conditionalCatalog = { ...baseCatalog, prices: [{ ...parsed.prices[0]!, inputRange: { minExclusive: 0, maxInclusive: 100 }, excludedUtcWindows: [{ weekdays: [1], startMinute: 60, endMinute: 240 }] }] };
assert.equal(estimateModelPrice('new/model_name', requestUsage, conditionalCatalog).apiEquivalentUsd, null);
assert.equal(estimateModelPrice('new/model_name', { ...requestUsage, inputTokens: 50, cachedInputTokens: 0 }, conditionalCatalog, '2026-09-21T02:00:00Z').apiEquivalentUsd, null);
console.log('通过：官方表头变化保护、新模型名称、请求输入档位与时段边界。');

/** 可选联网检查直接使用生产固定来源读取器与解析器，不携带任何账号凭据。 */
if (process.argv.includes('--built-in-pages')) {
  for (const [template, url] of Object.entries(builtInPricingUrls)) {
    const source = template === 'kimi' ? `${url}.md` : url;
    const page = await readBuiltInPricingPage(source, new AbortController().signal);
    const result = parseBuiltInModelPrices(template, page);
    assert.ok(result.prices.length > 0, `${template} 未识别价格`);
    assert.ok(result.prices.every(validModelPrice), `${template} 出现无效计价条件`);
    console.log(JSON.stringify({ template, url, priceRows: result.prices.length, models: new Set(result.prices.map((price) => price.model)).size, unavailable: result.unavailableModels.length }));
  }
}
/** 金额边界与条件边界拒绝损坏数据。 */
assert.equal(validModelPrice({ ...parsed.prices[0], inputRange: { minExclusive: 100, maxInclusive: 1 } }), false);
assert.equal(estimateModelPrice('new/model_name', { ...requestUsage, cachedInputTokens: requestUsage.inputTokens + 1 }, baseCatalog).apiEquivalentUsd, null);
