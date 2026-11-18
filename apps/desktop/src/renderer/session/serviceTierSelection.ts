import { codexAcceleratedServiceTiers, isCodexAcceleratedServiceTier, type CodexAcceleratedServiceTier } from '@zeus/shared';
import type { CodexTaskPushModelCapability, NativeServiceTierSelection } from './sessionTypes.js';

/** 标准速度的选择器值，和 Codex 目录中的档位 ID 区分。 */
const standardValue = '__zeus_standard__';

/** 将已保存的档位转换为选择器值。 */
export function serviceTierSelectionValue(selection: NativeServiceTierSelection): string {
  return selection.type === 'catalog' ? selection.id : standardValue;
}

/** 已确认的连接目录决定是否展示超快选择。 */
export function supportsUltrafast(model: Pick<CodexTaskPushModelCapability, 'serviceTiers'> | null | undefined): boolean {
  return model?.serviceTiers.some((tier) => tier.id === 'ultrafast') ?? false;
}

/** 本次会按标准运行时，选择器显示标准并保留原配置。 */
export function serviceTierPickerValue(selection: NativeServiceTierSelection, model: Pick<CodexTaskPushModelCapability, 'serviceTiers'> | null | undefined): string {
  /** 保存的超快档位在当前目录不可用时没有对应的菜单项。 */
  const value = serviceTierSelectionValue(selection);
  return value === 'ultrafast' && !supportsUltrafast(model) ? standardValue : value;
}

/** 空值显式请求标准速度，可覆盖线程之前的加速设置。 */
export function serviceTierWireOverride(selection: NativeServiceTierSelection): { serviceTier: CodexAcceleratedServiceTier | null } {
  return { serviceTier: selection.type === 'catalog' && isCodexAcceleratedServiceTier(selection.id) ? selection.id : null };
}

/** 会话、任务和独立生成共用加速档位的显示名称。 */
export function codexAcceleratedServiceTierLabel(tier: CodexAcceleratedServiceTier, language: 'zh-CN' | 'en-US'): string {
  return tier === 'ultrafast' ? (language === 'zh-CN' ? '超快' : 'Ultrafast') : language === 'zh-CN' ? '快速' : 'Fast';
}

/** 选择器只启用当前连接公布的模型速度档位。 */
export function serviceTierOptions(model: Pick<CodexTaskPushModelCapability, 'serviceTiers'> | null | undefined, language: 'zh-CN' | 'en-US') {
  /** 中文和英文使用同一套档位及能力规则。 */
  const zh = language === 'zh-CN';
  return [
    { value: standardValue, label: zh ? '标准' : 'Standard', description: zh ? '默认速度' : 'Default speed', disabled: false },
    ...codexAcceleratedServiceTiers
      .filter((tier) => tier !== 'ultrafast' || supportsUltrafast(model))
      .map((tier) => {
        /** 未声明该档位时保留选项名称和不可选原因。 */
        const supported = model?.serviceTiers.some((entry) => entry.id === tier);
        return {
          value: tier,
          label: codexAcceleratedServiceTierLabel(tier, language),
          description: !supported
            ? zh
              ? '当前连接未开放此档位'
              : 'Unavailable on this connection'
            : tier === 'ultrafast'
              ? zh
                ? '最快响应，消耗更高'
                : 'Fastest responses, higher usage'
              : zh
                ? '响应更快，消耗更多'
                : 'Faster responses, higher usage',
          disabled: !supported,
        };
      }),
  ];
}

/** 保留已记住的加速档位，由服务端根据当前能力实际派发。 */
export function normalizeServiceTierSelection(selection: NativeServiceTierSelection, model: CodexTaskPushModelCapability | null | undefined): { selection: NativeServiceTierSelection; downgraded: boolean } {
  if (selection.type !== 'catalog') return { selection: { type: 'standard' }, downgraded: false };
  if (!isCodexAcceleratedServiceTier(selection.id)) return { selection: { type: 'standard' }, downgraded: true };
  return { selection, downgraded: !model?.serviceTiers.some((tier) => tier.id === selection.id) };
}

/** 将目录档位或选择器值恢复为会话速度选项。 */
export function selectionFromEffectiveServiceTier(serviceTier: string | null | undefined): NativeServiceTierSelection {
  return isCodexAcceleratedServiceTier(serviceTier) ? { type: 'catalog', id: serviceTier } : { type: 'standard' };
}
