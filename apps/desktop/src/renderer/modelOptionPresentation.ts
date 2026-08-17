export interface ModelOptionSource {
  id: string;
  model: string;
  displayName?: string;
  sourceName?: string;
  available?: boolean;
  speedLabel?: 'standard' | 'high_speed' | 'flash' | 'turbo';
}

export interface PresentedModelGroup<Model extends ModelOptionSource> {
  providerName: string;
  models: readonly Model[];
}

export interface PresentedModelOption {
  value: string;
  label: string;
  group?: string;
  searchText: string;
}

export interface ModelOptionPresentation<Model extends ModelOptionSource> {
  models: readonly Model[];
  groups: readonly PresentedModelGroup<Model>[];
  options: readonly PresentedModelOption[];
  selectedId: string;
  triggerLabel: string;
  showProviderGroups: boolean;
}

function providerName(model: ModelOptionSource, zh: boolean): string {
  return model.sourceName?.trim() || (zh ? '未命名供应商' : 'Unnamed provider');
}

function modelName(model: ModelOptionSource): string {
  return model.displayName?.trim() || model.model;
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
  const selectedModel = availableModels.find((model) => model.id === resolvedSelectedId);
  const selectedProviderName = selectedModel ? providerName(selectedModel, zh) : null;
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: 'base' });
  const providerModels = new Map<string, Model[]>();

  for (const model of availableModels) {
    const name = providerName(model, zh);
    const current = providerModels.get(name);
    if (current) current.push(model);
    else providerModels.set(name, [model]);
  }

  const providerNames = [...providerModels.keys()].sort((left, right) => {
    if (left === selectedProviderName && right !== selectedProviderName) return -1;
    if (right === selectedProviderName && left !== selectedProviderName) return 1;
    return collator.compare(left, right);
  });
  const showProviderGroups = providerNames.length > 1;
  const groups = providerNames.map((name) => {
    const sortedModels = [...(providerModels.get(name) ?? [])].sort((left, right) => {
      if (left.id === resolvedSelectedId && right.id !== resolvedSelectedId) return -1;
      if (right.id === resolvedSelectedId && left.id !== resolvedSelectedId) return 1;
      const nameOrder = collator.compare(modelName(left), modelName(right));
      if (nameOrder !== 0) return nameOrder;
      const modelOrder = collator.compare(left.model, right.model);
      return modelOrder !== 0 ? modelOrder : collator.compare(left.id, right.id);
    });
    return { providerName: name, models: sortedModels } satisfies PresentedModelGroup<Model>;
  });
  const sortedModels = groups.flatMap((group) => group.models);
  const options = groups.flatMap((group) =>
    group.models.map((model) => {
      const displayName = modelName(model);
      const speed = speedLabel(model, zh);
      return {
        value: model.id,
        label: speed ? `${displayName} · ${speed}` : displayName,
        ...(showProviderGroups ? { group: group.providerName } : {}),
        searchText: `${group.providerName} ${displayName} ${model.model}`,
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
      ? `${providerName(resolvedSelectedModel, zh)} / ${modelName(resolvedSelectedModel)}`
      : resolvedSelectedId
        ? zh
          ? '当前选择不可用'
          : 'Current selection unavailable'
        : zh
          ? '没有可运行模型'
          : 'No runnable models',
    showProviderGroups,
  };
}
