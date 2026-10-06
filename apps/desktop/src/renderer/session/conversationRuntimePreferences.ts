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

/** 跨项目读取同一类会话的全局偏好，不读取旧项目覆盖。 */
export function readConversationRuntimePreferences(storage: Pick<Storage, 'getItem'> | undefined, _projectId: string, kind: ConversationRuntimePreferenceKind): ConversationRuntimePreferences | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(preferenceKey(kind)) ?? 'null') as Partial<ConversationRuntimePreferences> | null;
    if (!parsed || (parsed.model !== undefined && typeof parsed.model !== 'string')) return null;
    if (parsed.effort !== undefined && typeof parsed.effort !== 'string') return null;
    if (!isPermissionMode(parsed.permissionMode) || !isCollaborationMode(parsed.collaborationMode)) return null;
    return {
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.effort ? { effort: parsed.effort } : {}),
      // 历史记录不含显式速度选择，新会话统一使用标准档位。
      serviceTier: { type: 'standard' },
      permissionMode: parsed.permissionMode,
      collaborationMode: parsed.collaborationMode,
      ...(parsed.workspaceMode === 'direct' || parsed.workspaceMode === 'worktree' ? { workspaceMode: parsed.workspaceMode } : {}),
    };
  } catch {
    return null;
  }
}

/** 保存全局偏好，当前任务的授权仍需独立确认。 */
export function writeConversationRuntimePreferences(storage: Pick<Storage, 'setItem'> | undefined, _projectId: string, kind: ConversationRuntimePreferenceKind, preferences: ConversationRuntimePreferences): void {
  if (!storage) return;
  storage.setItem(
    preferenceKey(kind),
    JSON.stringify({
      ...(preferences.model ? { model: preferences.model } : {}),
      ...(preferences.effort ? { effort: preferences.effort } : {}),
      permissionMode: preferences.permissionMode,
      collaborationMode: preferences.collaborationMode,
      ...(preferences.workspaceMode ? { workspaceMode: preferences.workspaceMode } : {}),
    }),
  );
}

/** 偏好仅按操作类型区分，不再按项目分组。 */
function preferenceKey(kind: ConversationRuntimePreferenceKind): string {
  return `${preferenceKeyPrefix}global:${kind}`;
}

function isPermissionMode(value: unknown): value is NativePermissionMode {
  return value === 'read-only' || value === 'auto' || value === 'auto-review' || value === 'full-access';
}

function isCollaborationMode(value: unknown): value is NativeCollaborationMode {
  return value === 'default' || value === 'plan';
}
