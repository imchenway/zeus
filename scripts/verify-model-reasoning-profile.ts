#!/usr/bin/env tsx
/**
 * ZEUS-0699 推理档位清单专项探针（按需运行，不进发布门禁）。
 *
 * 只走公开的模型连接归一化入口，不发网络请求、不读密钥，验证四件事：
 *   1. 判定顺序：官方端点档案 → 内置目录 → 家族预设 → 未识别；
 *   2. 档位清单与喂给 Pi 的档位集合同源（界面能给出来的档位，Pi 一定认识）；
 *   3. 用户词 → Pi 中转词 → 线上取值的换算，认不出时回落默认档而不是报错；
 *   4. 旧形状记录（levels + levelMap）迁移后不再把兜底 off 当成真实档位。
 * 任一条不成立就抛出，方便在排查「推理等级显示 off」这类问题时一键复现。
 */
import assert from 'node:assert/strict';
import {
  createConfiguredModelDefinition,
  listSelectableConnectionModels,
  normalizeModelConnection,
  reasoningLevelMap,
  resolvePiThinkingLevel,
  type ConfiguredModelDefinition,
  type ConfiguredReasoningProfile,
} from '../packages/ai-runtime/src/modelConnectionCatalog.js';

const createdAt = '2026-09-21T00:00:00.000Z';

/** 用真实入口构建一条连接，确保探针覆盖归一化和档位判定两条代码路径。 */
function buildConnection(input: { name: string; templateId: 'custom' | 'deepseek' | 'bailian' | 'kimi' | 'zai'; baseUrl: string; models: ConfiguredModelDefinition[] }) {
  return normalizeModelConnection({ name: input.name, templateId: input.templateId, baseUrl: input.baseUrl, models: input.models }, { id: `probe_${input.name}`, apiKeyConfigured: true, createdAt, updatedAt: createdAt });
}

function profileOf(models: ConfiguredModelDefinition[], id: string): ConfiguredReasoningProfile {
  const model = models.find((candidate) => candidate.id === id);
  assert.ok(model, `连接里应该有模型 ${id}`);
  return model.capability.reasoning;
}

function optionIds(profile: ConfiguredReasoningProfile): string[] {
  return profile.options.map((option) => option.id);
}

// 1. 官方 DeepSeek 端点：按官方文档给 low/high/max，与模型目录无关，也不再有假的 off。
const official = buildConnection({
  name: 'official',
  templateId: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  models: [createConfiguredModelDefinition('deepseek-flash', {}, 'deepseek'), createConfiguredModelDefinition('deepseek-v4-pro', {}, 'deepseek')],
});
for (const id of ['deepseek-flash', 'deepseek-v4-pro']) {
  const profile = profileOf(official.models, id);
  assert.deepEqual(optionIds(profile), ['low', 'high', 'max'], `${id} 应该是 low/high/max`);
  assert.equal(profile.defaultId, 'high', `${id} 默认档应该是 high`);
  assert.equal(profile.basis, 'official_endpoint', `${id} 的依据应该是官方端点声明`);
  assert.equal(profile.state, 'supported');
  // 换算：官方词就是 Pi 词；认不出的旧值（例如历史里的 off）按默认档归一，不抛错。
  assert.equal(resolvePiThinkingLevel(profile, 'low'), 'low');
  assert.equal(resolvePiThinkingLevel(profile, undefined), 'high');
  assert.equal(resolvePiThinkingLevel(profile, 'off'), 'high');
  const levelMap = reasoningLevelMap(profile);
  assert.equal(levelMap.low, 'low');
  assert.equal(levelMap.high, 'high');
  assert.equal(levelMap.max, 'max');
  // 不在清单里的档位必须是 null：Pi 会据此判定该档位不可用。
  assert.equal(levelMap.off, null);
  assert.equal(levelMap.medium, null);
}

// 2. 界面清单与 Pi 档位集合同源：界面给出来的每个档位，Pi 都能用。
const selectable = listSelectableConnectionModels([official]).find((model) => model.model === 'deepseek-flash');
assert.ok(selectable);
assert.deepEqual(selectable.supportedReasoningEfforts, ['low', 'high', 'max']);
assert.equal(selectable.defaultReasoningEffort, 'high');

// 2.1 第三方渠道上的同族模型必须和官方端点给同一份档位表：
// 目录把 DeepSeek 的 low 标成不可用，那是过期的第三方数据，厂商文档说了算。
const thirdParty = buildConnection({
  name: 'thirdparty',
  templateId: 'custom',
  baseUrl: 'https://relay.invalid/v1',
  models: [createConfiguredModelDefinition('deepseek-v4-pro', {}, 'openai'), createConfiguredModelDefinition('deepseek-v4-flash', {}, 'openai')],
});
for (const id of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
  const profile = profileOf(thirdParty.models, id);
  assert.deepEqual(optionIds(profile), ['low', 'high', 'max'], `${id} 在中转上也应该是 low/high/max`);
  assert.equal(profile.basis, 'vendor_docs', `${id} 的依据应标成厂商文档，不能冒充官方端点`);
  assert.equal(reasoningLevelMap(profile).low, 'low');
}

// 3. 认不出的模型不编造档位：空清单 = 界面不给下拉、请求不发档位字段。
const unknown = buildConnection({
  name: 'unknown',
  templateId: 'custom',
  baseUrl: 'https://example.invalid/v1',
  models: [createConfiguredModelDefinition('seedance-9-5-internal-preview', {}, 'openai')],
});
const unknownProfile = profileOf(unknown.models, 'seedance-9-5-internal-preview');
assert.deepEqual(optionIds(unknownProfile), []);
assert.equal(unknownProfile.defaultId, null);
assert.equal(unknownProfile.basis, 'unidentified');
assert.equal(resolvePiThinkingLevel(unknownProfile, 'off'), null);
assert.deepEqual(listSelectableConnectionModels([unknown])[0].supportedReasoningEfforts, []);

// 4. 家族预设：模型 ID 认得出家族但目录没登记时按家族清单给档位，并标明是推断。
const inferred = buildConnection({
  name: 'inferred',
  templateId: 'custom',
  baseUrl: 'https://example.invalid/v1',
  models: [createConfiguredModelDefinition('claude-opus-9-preview-zzz', {}, 'openai')],
});
const inferredProfile = profileOf(inferred.models, 'claude-opus-9-preview-zzz');
assert.equal(inferredProfile.basis, 'model_name');
assert.deepEqual(optionIds(inferredProfile), ['minimal', 'low', 'medium', 'high']);

// 4.1 图像/视频这类模型不许按厂商关键字硬套推理档位。
const nonChat = buildConnection({
  name: 'nonchat',
  templateId: 'custom',
  baseUrl: 'https://example.invalid/v1',
  models: [createConfiguredModelDefinition('grok-imagine-image', {}, 'openai')],
});
const nonChatProfile = profileOf(nonChat.models, 'grok-imagine-image');
assert.deepEqual(optionIds(nonChatProfile), [], '图像模型必须判未识别，不能给档位');
assert.equal(nonChatProfile.basis, 'unidentified');

// 5. 旧形状迁移：老记录里的 levels/levelMap 不再被当成事实，重算后由清单说了算。
const legacyProfile = {
  state: 'supported',
  levels: ['off'],
  defaultLevel: 'off',
  thinkingFormat: 'deepseek',
  levelMap: { off: null },
  source: 'probe',
  checkedAt: '2026-09-20T00:00:00.000Z',
  reason: '已在 off 档位观测到真实思考输出；其余档位仍来自上游目录声明。',
} as unknown as ConfiguredModelDefinition['capability']['reasoning'];
const legacy = buildConnection({
  name: 'legacy',
  templateId: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  models: [{ ...createConfiguredModelDefinition('deepseek-flash', {}, 'deepseek'), capability: { ...createConfiguredModelDefinition('deepseek-flash', {}, 'deepseek').capability, reasoning: legacyProfile } }],
});
const legacyResolved = profileOf(legacy.models, 'deepseek-flash');
assert.deepEqual(optionIds(legacyResolved), ['low', 'high', 'max'], '旧记录必须按新档案重算，不能沿用兜底 off');
// 观测时间属于事实，重算档位时不能被抹掉。
assert.equal(legacyResolved.checkedAt, '2026-09-20T00:00:00.000Z');

// 6. 用户词与 Pi 词不同名的换算（例如厂商叫 ultra，Pi 只有 max）。
const aliased: ConfiguredReasoningProfile = {
  state: 'supported',
  options: [
    { id: 'low', label: '低', piLevel: 'low', wire: 'low' },
    { id: 'ultra', label: '最高', piLevel: 'max', wire: 'ultra' },
  ],
  defaultId: 'low',
  thinkingFormat: 'openai',
  basis: 'user',
  checkedAt: null,
};
assert.equal(resolvePiThinkingLevel(aliased, 'ultra'), 'max');
assert.equal(resolvePiThinkingLevel(aliased, 'high'), 'low', '不认识的值回落默认档');
assert.equal(reasoningLevelMap(aliased).max, 'ultra', '线上取值必须是厂商的词');

console.log('推理档位清单探针通过：官方档案 / 目录 / 家族推断 / 未识别 / 旧数据迁移 / 用户词换算');
