/** 缺价补算专项探针：临时数据库验证实际记账路径，按需运行，不加入发布门禁。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexUsageLedgerRepository, ConversationRepository, ProjectRepository, SettingRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import { emptyTokenUsageBreakdown, estimateCodexUsage } from '../packages/shared/src/codexUsage.js';
import { createCodexUsageService } from '../packages/local-server/src/codexUsageService.js';
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
assert.equal(estimatePublishedCodexUsage({ catalog, prices, model: `${model}-2026-09-23`, usage })?.apiEquivalentUsd, 0.00305);
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
    return new Response(document);
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
  seed('not-published', 'codex', 'not-published');
  now = Date.now() + 2 * 60 * 60_000;
  await service.refreshMissingPricing();
  await service.refreshMissingPricing();
  assert.equal(downloads, 2);
  assert.equal(ledger.findByProviderTurn('codex', 'probe', 'not-published')?.estimate.apiEquivalentUsd, null);
  await service.dispose();
  service = createService(false);
  now += 10 * 60_000;
  await service.refreshMissingPricing();
  assert.equal(downloads, 2);
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
