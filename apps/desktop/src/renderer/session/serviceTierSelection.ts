import type { CodexTaskPushModelCapability, NativeServiceTierSelection } from './sessionTypes.js';

const standardValue = '__zeus_standard__';

export function serviceTierSelectionValue(selection: NativeServiceTierSelection): string {
  if (selection.type === 'follow') return standardValue;
  if (selection.type === 'standard') return standardValue;
  return selection.id;
}

export function serviceTierSelectionFromValue(value: string): NativeServiceTierSelection {
  if (value === standardValue) return { type: 'standard' };
  return { type: 'catalog', id: value };
}

export function serviceTierWireOverride(selection: NativeServiceTierSelection): { serviceTier?: string | null } {
  if (selection.type === 'follow' || selection.type === 'standard') return { serviceTier: null };
  return { serviceTier: selection.id === 'priority' ? 'priority' : null };
}

export function fastServiceTier(model: CodexTaskPushModelCapability | null | undefined) {
  return model?.serviceTiers.find((tier) => tier.id === 'priority');
}

export function serviceTierOptions(model: CodexTaskPushModelCapability | null | undefined, language: 'zh-CN' | 'en-US') {
  const fast = fastServiceTier(model);
  return [
    { value: standardValue, label: language === 'zh-CN' ? '标准' : 'Standard' },
    {
      value: 'priority',
      label: fast ? 'Fast' : language === 'zh-CN' ? 'Fast（当前模型不支持）' : 'Fast (unsupported by this model)',
      disabled: !fast,
    },
  ];
}

export function normalizeServiceTierSelection(selection: NativeServiceTierSelection, model: CodexTaskPushModelCapability | null | undefined): { selection: NativeServiceTierSelection; downgraded: boolean } {
  if (selection.type === 'follow') return { selection: { type: 'standard' }, downgraded: false };
  if (selection.type === 'standard') return { selection, downgraded: false };
  if (selection.id === 'priority') return { selection, downgraded: !fastServiceTier(model) };
  return { selection: { type: 'standard' }, downgraded: true };
}

export function selectionFromEffectiveServiceTier(serviceTier: string | null | undefined): NativeServiceTierSelection {
  if (!serviceTier || serviceTier === 'default') return { type: 'standard' };
  return serviceTier === 'priority' ? { type: 'catalog', id: 'priority' } : { type: 'standard' };
}
