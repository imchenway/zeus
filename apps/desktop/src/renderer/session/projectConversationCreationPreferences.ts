/** 项目新会话的创建方式，独立于模型及单次工作树分支。 */
export interface ProjectConversationCreationPreferences {
  /** 首发时是否同时创建关联任务。 */
  createTask: boolean;
  /** 使用项目目录或为新会话创建工作树。 */
  workspaceMode: 'direct' | 'worktree';
}

/** 新会话创建选项的项目存储键。 */
function preferenceKey(projectId: string): string {
  return `zeus.project-conversation-preferences:${encodeURIComponent(projectId)}`;
}

/** 无记录或记录损坏时沿用关闭自动任务、使用项目目录的默认值。 */
export function readProjectConversationCreationPreferences(storage: Pick<Storage, 'getItem'> | undefined, projectId: string): ProjectConversationCreationPreferences {
  try {
    /** 本地记录必须校验类型，不能把字符串 false 当作开启。 */
    const value: unknown = JSON.parse(storage?.getItem(preferenceKey(projectId)) ?? 'null');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      /** 只恢复当前支持的创建选项。 */
      const preference = value as Partial<ProjectConversationCreationPreferences>;
      return { createTask: preference.createTask === true, workspaceMode: preference.workspaceMode === 'worktree' ? 'worktree' : 'direct' };
    }
  } catch {
    // 不可读的本地偏好不阻止用户创建会话。
  }
  return { createTask: false, workspaceMode: 'direct' };
}

/** 用户选择后立即保存；写入故障由调用方显示，当前选择仍然有效。 */
export function writeProjectConversationCreationPreferences(storage: Pick<Storage, 'setItem'> | undefined, projectId: string, preferences: ProjectConversationCreationPreferences): void {
  if (!storage || !projectId) return;
  storage.setItem(preferenceKey(projectId), JSON.stringify(preferences));
}
