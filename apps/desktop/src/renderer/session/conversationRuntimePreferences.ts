import type { NativeCollaborationMode, NativePermissionMode, NativeServiceTierSelection, SessionConversationOwner } from './sessionTypes.js';

export type ConversationRuntimePreferenceKind = 'task_development' | 'conflict_resolution' | 'code_review' | 'project';

export interface ConversationRuntimePreferences {
  model?: string;
  effort?: string;
  serviceTier: NativeServiceTierSelection;
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  workspaceMode?: 'direct' | 'worktree';
}

const preferenceKeyPrefix = 'zeus.conversation-runtime-preference:';

export function conversationRuntimePreferenceKind(owner: SessionConversationOwner | undefined, title = ''): ConversationRuntimePreferenceKind {
  if (owner?.kind === 'project') return 'project';
  const normalizedTitle = title.trim().toLowerCase();
  if (normalizedTitle.startsWith('代码审查：') || normalizedTitle.startsWith('代码审查:') || normalizedTitle.startsWith('code review:')) return 'code_review';
  if (normalizedTitle.startsWith('冲突处理：') || normalizedTitle.startsWith('冲突处理:') || normalizedTitle.startsWith('conflict resolution:')) return 'conflict_resolution';
  return 'task_development';
}

export function readConversationRuntimePreferences(storage: Pick<Storage, 'getItem'> | undefined, projectId: string, kind: ConversationRuntimePreferenceKind): ConversationRuntimePreferences | null {
  if (!storage || !projectId) return null;
  try {
    const parsed = JSON.parse(storage.getItem(preferenceKey(projectId, kind)) ?? 'null') as Partial<ConversationRuntimePreferences> | null;
    if (!parsed || (parsed.model !== undefined && typeof parsed.model !== 'string')) return null;
    if (parsed.effort !== undefined && typeof parsed.effort !== 'string') return null;
    if (!isPermissionMode(parsed.permissionMode) || !isCollaborationMode(parsed.collaborationMode)) return null;
    return {
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.effort ? { effort: parsed.effort } : {}),
      // 旧记录无法证明速度是否由用户显式选择，因此不把它迁移为项目模型偏好。
      serviceTier: { type: 'standard' },
      permissionMode: parsed.permissionMode,
      collaborationMode: parsed.collaborationMode,
      ...(parsed.workspaceMode === 'direct' || parsed.workspaceMode === 'worktree' ? { workspaceMode: parsed.workspaceMode } : {}),
    };
  } catch {
    return null;
  }
}

export function writeConversationRuntimePreferences(storage: Pick<Storage, 'setItem'> | undefined, projectId: string, kind: ConversationRuntimePreferenceKind, preferences: ConversationRuntimePreferences): void {
  if (!storage || !projectId) return;
  storage.setItem(
    preferenceKey(projectId, kind),
    JSON.stringify({
      ...(preferences.model ? { model: preferences.model } : {}),
      ...(preferences.effort ? { effort: preferences.effort } : {}),
      permissionMode: preferences.permissionMode,
      collaborationMode: preferences.collaborationMode,
      ...(preferences.workspaceMode ? { workspaceMode: preferences.workspaceMode } : {}),
    }),
  );
}

function preferenceKey(projectId: string, kind: ConversationRuntimePreferenceKind): string {
  return `${preferenceKeyPrefix}${encodeURIComponent(projectId)}:${kind}`;
}

function isPermissionMode(value: unknown): value is NativePermissionMode {
  return value === 'read-only' || value === 'auto' || value === 'full-access';
}

function isCollaborationMode(value: unknown): value is NativeCollaborationMode {
  return value === 'default' || value === 'plan';
}
