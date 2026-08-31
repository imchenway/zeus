import { isZeusNativeSkillId, isZeusPluginSkillId } from '@zeus/shared';
import type { PluginSkillReference } from '../../session/sessionTypes.js';

export type SkillWorkflowId = 'task_push' | 'code_review' | 'conflict_resolution';

export const skillWorkflowDefinitions: Array<{ id: SkillWorkflowId; zh: string; en: string }> = [
  { id: 'task_push', zh: '推送任务', en: 'Task push' },
  { id: 'code_review', zh: '代码审查', en: 'Code review' },
  { id: 'conflict_resolution', zh: '代码冲突', en: 'Conflict resolution' },
];

const storageKey = 'zeus.skill-workflow-defaults:v1';
export const skillWorkflowPreferenceEvent = 'zeus:skill-workflow-preferences-changed';

export type SkillWorkflowPreferences = Partial<Record<SkillWorkflowId, string>>;

export function readSkillWorkflowPreferences(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): SkillWorkflowPreferences {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? '{}');
    if (!isRecord(parsed)) return {};
    const preferences: SkillWorkflowPreferences = {};
    for (const workflow of skillWorkflowDefinitions) {
      const value = parsed[workflow.id];
      if (typeof value === 'string' && isWorkflowSkillId(workflow.id, value)) preferences[workflow.id] = value;
    }
    return preferences;
  } catch {
    return {};
  }
}

export function readSkillWorkflowDefault(workflow: SkillWorkflowId, storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): string {
  return readSkillWorkflowPreferences(storage)[workflow] ?? '';
}

export function writeSkillWorkflowDefault(workflow: SkillWorkflowId, skillId: string, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = browserStorage()): void {
  if (!storage) return;
  const next = readSkillWorkflowPreferences(storage);
  if (skillId) next[workflow] = skillId;
  else delete next[workflow];
  storage.setItem(storageKey, JSON.stringify(next));
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(skillWorkflowPreferenceEvent, { detail: { workflow, skillId } }));
}

export function workflowSkillSelectionRequest(skillId: string): { skillId?: string; pluginReferences?: PluginSkillReference[] } {
  if (!skillId) return {};
  if (isZeusNativeSkillId(skillId)) return { skillId };
  if (isZeusPluginSkillId(skillId)) return { pluginReferences: [{ kind: 'skill', id: skillId }] };
  throw new Error('Skill 选择无效，请重新选择。');
}

function browserStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkflowSkillId(workflow: SkillWorkflowId, value: string): boolean {
  return isZeusNativeSkillId(value) || (workflow === 'task_push' && isZeusPluginSkillId(value));
}
