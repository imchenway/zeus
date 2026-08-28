import type { ProjectModelServiceTierPreference } from '../apiClient.js';
import type { CodexTaskPushModelCapability, NativeServiceTierSelection } from './sessionTypes.js';

export function findProjectModelServiceTierPreference(preferences: readonly ProjectModelServiceTierPreference[] | null | undefined, model: CodexTaskPushModelCapability | null | undefined): ProjectModelServiceTierPreference | null {
  if (!model) return null;
  const modelSourceId = model.sourceId ?? null;
  return preferences?.find((preference) => preference.modelSourceId === modelSourceId && preference.modelId === model.model) ?? null;
}

export function projectModelServiceTierSelection(preferences: readonly ProjectModelServiceTierPreference[] | null | undefined, model: CodexTaskPushModelCapability | null | undefined): NativeServiceTierSelection {
  return findProjectModelServiceTierPreference(preferences, model)?.serviceTier === 'priority' ? { type: 'catalog', id: 'priority' } : { type: 'standard' };
}

export function toProjectModelServiceTierPreference(model: CodexTaskPushModelCapability, selection: NativeServiceTierSelection): ProjectModelServiceTierPreference {
  return {
    modelSourceId: model.sourceId ?? null,
    modelId: model.model,
    serviceTier: selection.type === 'catalog' && selection.id === 'priority' ? 'priority' : 'standard',
  };
}

export function upsertProjectModelServiceTierPreference(preferences: readonly ProjectModelServiceTierPreference[], preference: ProjectModelServiceTierPreference): ProjectModelServiceTierPreference[] {
  return [...preferences.filter((entry) => entry.modelSourceId !== preference.modelSourceId || entry.modelId !== preference.modelId), preference];
}
