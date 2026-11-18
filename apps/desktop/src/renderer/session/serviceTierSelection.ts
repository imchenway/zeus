import { isCodexServiceTierId, normalizeCodexPricingServiceTier } from '@zeus/shared';
import type { CodexTaskPushModelCapability, NativeServiceTierSelection } from './sessionTypes.js';

/** 标准速度的选择器值，与供应商档位 ID 区分。 */
const standardValue = '__zeus_standard__';

/** 速度选择与费用估算共用档位 ID，标准速度通过单独选项表达。 */
type ServiceTierModel = Pick<CodexTaskPushModelCapability, 'serviceTiers'>;

/** 将已保存的档位转换为选择器值。 */
export function serviceTierSelectionValue(selection: NativeServiceTierSelection): string {
  return selection.type === 'catalog' ? selection.id : standardValue;
}

/** 目录已撤下的档位在表单中显示当前实际可用的标准速度。 */
export function serviceTierPickerValue(selection: NativeServiceTierSelection, model: ServiceTierModel | null | undefined): string {
  const value = serviceTierSelectionValue(selection);
  return model?.serviceTiers.some((tier) => tier.id === value) ? value : standardValue;
}

/** 保留目录原始 ID，派发时由服务端核对模型能力。 */
export function serviceTierWireOverride(selection: NativeServiceTierSelection): { serviceTier: string | null } {
  return { serviceTier: selection.type === 'catalog' && isCodexServiceTierId(selection.id) ? selection.id : null };
}

/** 已有档位保留本地化名称，新档位使用目录的名称。 */
export function codexServiceTierLabel(tier: ServiceTierModel['serviceTiers'][number], language: 'zh-CN' | 'en-US'): string {
  if (language === 'zh-CN' && tier.id === 'ultrafast') return '超快';
  if (language === 'zh-CN' && normalizeCodexPricingServiceTier(tier.id) === 'priority') return '快速';
  return tier.name || tier.id;
}

/** 标准速度和官方目录当前开放的其他档位共用同一选择器。 */
export function serviceTierOptions(model: ServiceTierModel | null | undefined, language: 'zh-CN' | 'en-US') {
  const zh = language === 'zh-CN';
  return [
    { value: standardValue, label: zh ? '标准' : 'Standard', description: zh ? '默认速度' : 'Default speed', disabled: false },
    ...(model?.serviceTiers ?? [])
      .filter((tier) => isCodexServiceTierId(tier.id) && normalizeCodexPricingServiceTier(tier.id) !== 'default')
      .map((tier) => ({ value: tier.id, label: codexServiceTierLabel(tier, language), description: tier.description, disabled: false })),
  ];
}

/** 记住合法的目录 ID，模型能力变化时仍可恢复历史选择。 */
export function normalizeServiceTierSelection(selection: NativeServiceTierSelection, model: ServiceTierModel | null | undefined): { selection: NativeServiceTierSelection; downgraded: boolean } {
  if (selection.type !== 'catalog') return { selection: { type: 'standard' }, downgraded: false };
  if (!isCodexServiceTierId(selection.id) || normalizeCodexPricingServiceTier(selection.id) === 'default') return { selection: { type: 'standard' }, downgraded: false };
  return { selection, downgraded: !model?.serviceTiers.some((tier) => tier.id === selection.id) };
}

/** 将已生效的目录 ID 恢复为选择器状态。 */
export function selectionFromEffectiveServiceTier(serviceTier: string | null | undefined): NativeServiceTierSelection {
  return isCodexServiceTierId(serviceTier) && normalizeCodexPricingServiceTier(serviceTier) !== 'default' ? { type: 'catalog', id: serviceTier } : { type: 'standard' };
}
