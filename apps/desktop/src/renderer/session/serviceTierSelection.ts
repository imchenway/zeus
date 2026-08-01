import type { CodexTaskPushModelCapability, NativeServiceTierSelection } from './sessionTypes.js';

const followValue = '__zeus_follow_codex__';
const standardValue = '__zeus_standard__';
const preferenceKeyPrefix = 'zeus.project-service-tier-preference:';

export function serviceTierSelectionValue(selection: NativeServiceTierSelection): string {
  if (selection.type === 'follow') return followValue;
  if (selection.type === 'standard') return standardValue;
  return selection.id;
}

export function serviceTierSelectionFromValue(value: string): NativeServiceTierSelection {
  if (value === followValue) return { type: 'follow' };
  if (value === standardValue) return { type: 'standard' };
  return { type: 'catalog', id: value };
}

export function serviceTierWireOverride(selection: NativeServiceTierSelection): { serviceTier?: string | null } {
  if (selection.type === 'follow') return {};
  if (selection.type === 'standard') return { serviceTier: null };
  return { serviceTier: selection.id };
}

export function serviceTierOptions(model: CodexTaskPushModelCapability | null | undefined, language: 'zh-CN' | 'en-US', includeFollow: boolean) {
  return [
    ...(includeFollow ? [{ value: followValue, label: language === 'zh-CN' ? '跟随 Codex' : 'Follow Codex' }] : []),
    { value: standardValue, label: language === 'zh-CN' ? '标准' : 'Standard' },
    ...(model?.serviceTiers ?? []).map((tier) => ({ value: tier.id, label: tier.name })),
  ];
}

export function normalizeServiceTierSelection(selection: NativeServiceTierSelection, model: CodexTaskPushModelCapability | null | undefined): { selection: NativeServiceTierSelection; downgraded: boolean } {
  if (selection.type !== 'catalog' || model?.serviceTiers.some((tier) => tier.id === selection.id)) return { selection, downgraded: false };
  return { selection: { type: 'standard' }, downgraded: true };
}

export function serviceTierDescription(selection: NativeServiceTierSelection, model: CodexTaskPushModelCapability | null | undefined, language: 'zh-CN' | 'en-US'): string {
  if (selection.type === 'follow') return language === 'zh-CN' ? '不覆盖 Codex 本机配置，实际档位以 Runtime 返回为准。' : 'Uses the local Codex setting; the Runtime response remains authoritative.';
  if (selection.type === 'standard') return language === 'zh-CN' ? '使用常规处理速度和用量。' : 'Uses standard processing speed and usage.';
  return model?.serviceTiers.find((tier) => tier.id === selection.id)?.description ?? selection.id;
}

export function selectionFromEffectiveServiceTier(serviceTier: string | null | undefined, model: CodexTaskPushModelCapability | null | undefined): NativeServiceTierSelection {
  if (!serviceTier || serviceTier === 'default') return { type: 'standard' };
  return model?.serviceTiers.some((tier) => tier.id === serviceTier) ? { type: 'catalog', id: serviceTier } : { type: 'standard' };
}

export function readProjectServiceTierPreference(storage: Pick<Storage, 'getItem'> | undefined, projectId: string): NativeServiceTierSelection {
  if (!storage) return { type: 'follow' };
  try {
    const value = JSON.parse(storage.getItem(`${preferenceKeyPrefix}${encodeURIComponent(projectId)}`) ?? 'null') as Partial<NativeServiceTierSelection> | null;
    if (value?.type === 'standard') return { type: 'standard' };
    if (value?.type === 'catalog' && typeof value.id === 'string' && value.id) return { type: 'catalog', id: value.id };
  } catch {
    // 偏好损坏时回退到跟随 Codex，禁止猜测 Fast。
  }
  return { type: 'follow' };
}

export function writeProjectServiceTierPreference(storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined, projectId: string, selection: NativeServiceTierSelection): void {
  if (!storage) return;
  const key = `${preferenceKeyPrefix}${encodeURIComponent(projectId)}`;
  if (selection.type === 'follow') {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify(selection));
}
