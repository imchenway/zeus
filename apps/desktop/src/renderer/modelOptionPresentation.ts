import { createElement } from 'react';
import { parseModelRef } from '@zeus/shared';
import type { ZeusSelectOption, ZeusSelectPinning } from './ZeusSelect.js';
import { ModelProviderBadge } from './modelProviderAppearance.js';

export interface ModelOptionSource {
  id: string;
  model: string;
  displayName?: string;
  sourceName?: string;
  /** 指向实际供应商连接，同名模型可以来自不同来源。 */
  sourceId?: string;
  /** 接入草稿尚未登记连接时使用模板或上传图标。 */
  templateId?: Parameters<typeof ModelProviderBadge>[0]['templateId'];
  iconDataUrl?: string | null;
  available?: boolean;
  supports1MContext?: boolean;
  speedLabel?: 'standard' | 'high_speed' | 'flash' | 'turbo';
}

export interface PresentedModelGroup<Model extends ModelOptionSource> {
  providerName: string;
  models: readonly Model[];
}

export interface PresentedModelOption extends Pick<ZeusSelectOption<string>, 'icon' | 'showIconInTrigger'> {
  value: string;
  label: string;
  group?: string;
  searchText: string;
  /** 置顶区仍需标明供应商，单供应商目录也保留来源。 */
  description: string;
}

/** 手工构造选项的入口与共享目录使用同一个供应商图标。 */
export function modelProviderOption({ sourceId, sourceName, templateId, iconDataUrl }: Parameters<typeof ModelProviderBadge>[0]): Pick<ZeusSelectOption<string>, 'icon' | 'showIconInTrigger'> {
  return { icon: createElement(ModelProviderBadge, { sourceId, sourceName, templateId, iconDataUrl }), showIconInTrigger: true };
}

/** 目录暂时缺失时，已保存的复合引用仍带有供应商身份。 */
export function modelProviderOptionForRef(reference: string): Pick<ZeusSelectOption<string>, 'icon' | 'showIconInTrigger'> {
  return modelProviderOption({ sourceId: parseModelRef(reference)?.sourceId });
}

export interface ModelOptionPresentation<Model extends ModelOptionSource> {
  models: readonly Model[];
  groups: readonly PresentedModelGroup<Model>[];
  options: readonly PresentedModelOption[];
  selectedId: string;
  triggerLabel: string;
  showProviderGroups: boolean;
  /** 所有运行模型入口共享本机置顶身份。 */
  pinning: ZeusSelectPinning;
}

function providerName(model: ModelOptionSource, zh: boolean): string {
  return model.sourceName?.trim() || (zh ? '未命名供应商' : 'Unnamed provider');
}

function modelName(model: ModelOptionSource): string {
  return model.displayName?.trim() || model.model;
}

/** 固定英文排序避免系统语言改变 A–Z 顺序，忽略大小写及名称分隔符。 */
const modelNameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base', ignorePunctuation: true });

/** 文本按 A–Z，数字段默认降序；点分型号按各段数值比较。 */
export function compareModelNames(left: string, right: string, numericOrder: 'ascending' | 'descending' = 'descending'): number {
  if (numericOrder === 'ascending') return modelNameCollator.compare(left, right);
  /** 连续点分数字作为一个型号段，确保 6.10 在 6.2 和 6 之前。 */
  const leftParts = left.match(/\d+(?:\.\d+)*|[^\d]+/g) ?? [];
  /** 保留文本段以维持同一型号内的名称升序。 */
  const rightParts = right.match(/\d+(?:\.\d+)*|[^\d]+/g) ?? [];
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    /** 只有两侧均为数字段时反转比较方向。 */
    const order = modelNameCollator.compare(leftParts[index]!, rightParts[index]!);
    if (order) return /^\d/.test(leftParts[index]!) && /^\d/.test(rightParts[index]!) ? -order : order;
  }
  return leftParts.length - rightParts.length;
}

/** 展示名称相同时按模型名和完整身份确定顺序，不改变选择或可用性。 */
export function compareModelOptions(left: ModelOptionSource, right: ModelOptionSource): number {
  return compareModelNames(modelName(left), modelName(right)) || compareModelNames(left.model, right.model) || compareModelNames(left.id, right.id);
}

function speedLabel(model: ModelOptionSource, zh: boolean): string | null {
  if (!model.speedLabel || model.speedLabel === 'standard') return null;
  if (model.speedLabel === 'high_speed') return zh ? '高速' : 'High-speed';
  if (model.speedLabel === 'flash') return 'Flash';
  return 'Turbo';
}

function resolveSelectedId<Model extends ModelOptionSource>(models: readonly Model[], selectedId: string, preserveMissingSelection: boolean): string {
  if (models.some((model) => model.id === selectedId)) return selectedId;
  const legacyMatches = models.filter((model) => model.model === selectedId);
  if (legacyMatches.length === 1) return legacyMatches[0]!.id;
  if (preserveMissingSelection && selectedId) return selectedId;
  return models[0]?.id ?? '';
}

/**
 * 所有模型选择入口共用这套排序和文案，避免供应商、连接或 Agent 语义在不同页面漂移。
 */
export function presentModelOptions<Model extends ModelOptionSource>(
  models: readonly Model[],
  selectedId: string,
  language: 'zh-CN' | 'en-US',
  presentationOptions: { preserveMissingSelection?: boolean } = {},
): ModelOptionPresentation<Model> {
  const zh = language === 'zh-CN';
  const availableModels = models.filter((model) => model.available !== false);
  const resolvedSelectedId = resolveSelectedId(availableModels, selectedId, presentationOptions.preserveMissingSelection === true);
  const providerModels = new Map<string, Model[]>();

  for (const model of availableModels) {
    const name = providerName(model, zh);
    const current = providerModels.get(name);
    if (current) current.push(model);
    else providerModels.set(name, [model]);
  }

  const providerNames = [...providerModels.keys()].sort(compareModelNames);
  const showProviderGroups = providerNames.length > 1;
  const groups = providerNames.map((name) => {
    const sortedModels = [...(providerModels.get(name) ?? [])].sort(compareModelOptions);
    return { providerName: name, models: sortedModels } satisfies PresentedModelGroup<Model>;
  });
  const sortedModels = groups.flatMap((group) => group.models);
  const options = groups.flatMap((group) =>
    group.models.map((model) => {
      const displayName = modelName(model);
      const speed = speedLabel(model, zh);
      const contextBadge = model.supports1MContext ? '1M' : null;
      const badges = [speed, contextBadge].filter((item): item is string => Boolean(item));
      return {
        value: model.id,
        ...modelProviderOption(model),
        label: badges.length > 0 ? `${displayName} · ${badges.join(' · ')}` : displayName,
        ...(showProviderGroups ? { group: group.providerName } : {}),
        searchText: `${group.providerName} ${displayName} ${model.model}${contextBadge ? ' 1M' : ''}`,
        description: group.providerName,
      } satisfies PresentedModelOption;
    }),
  );
  const resolvedSelectedModel = sortedModels.find((model) => model.id === resolvedSelectedId);

  return {
    models: sortedModels,
    groups,
    options,
    selectedId: resolvedSelectedId,
    triggerLabel: resolvedSelectedModel
      ? `${providerName(resolvedSelectedModel, zh)} / ${modelName(resolvedSelectedModel)}${resolvedSelectedModel.supports1MContext ? ' · 1M' : ''}`
      : resolvedSelectedId
        ? zh
          ? '当前选择不可用'
          : 'Current selection unavailable'
        : zh
          ? '没有可运行模型'
          : 'No runnable models',
    showProviderGroups,
    pinning: {
      storageKey: 'zeus.model-pins',
      groupLabel: zh ? '已置顶' : 'Pinned',
      pinLabel: zh ? '置顶' : 'Pin',
      unpinLabel: zh ? '取消置顶' : 'Unpin',
      saveErrorLabel: zh ? '无法保存置顶设置，请重试。' : 'Could not save pins. Please try again.',
    },
  };
}
