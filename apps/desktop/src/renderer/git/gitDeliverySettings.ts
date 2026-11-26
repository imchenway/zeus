import { createContext, type Dispatch, type SetStateAction } from 'react';
import { defaultGitDeliverySettings, type GitDeliverySettings } from '@zeus/shared';

/** 项目里两个收尾选项的选择值和启用状态。 */
export interface GitDeliveryFollowUpPreferences {
  /** 推送成功后是否执行已选命令。 */
  commands: boolean;
  /** 交付成功后是否设置已选任务状态。 */
  taskStatus: boolean;
  /** 命令 ID 按执行顺序保存。 */
  postPushCommandIds: string[];
  /** 已选择的任务状态 ID，未选择时为空。 */
  finalTaskStatus: string | null;
}

/** 校验本地命令列表的数量、身份格式和唯一性。 */
function isPostPushCommandIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 50 && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256) && new Set(value).size === value.length;
}

/** 已保存的项目组合优先，当前目录首次交付默认生成说明、提交并推送。 */
export function readGitDeliverySettings(projectId: string, currentDirectory = false): GitDeliverySettings {
  /** 当前目录直接推送工作分支，任务和工作树沿用通用默认值。 */
  const defaults = currentDirectory ? { ...defaultGitDeliverySettings, generateCommitMessage: true, merge: false } : { ...defaultGitDeliverySettings };
  try {
    const value = JSON.parse(localStorage.getItem(`zeus.git-delivery.settings:${projectId}`) ?? 'null') as Partial<GitDeliverySettings> | null;
    if (
      !value ||
      ['commit', 'merge', 'push', 'resolveConflicts'].some((key) => typeof value[key as 'commit'] !== 'boolean') ||
      (value.generateCommitMessage !== undefined && typeof value.generateCommitMessage !== 'boolean') ||
      (value.archiveConversation !== undefined && typeof value.archiveConversation !== 'boolean') ||
      (value.postPushCommandIds !== undefined && !isPostPushCommandIds(value.postPushCommandIds)) ||
      !['auto', 'full-access'].includes(value.permissionMode ?? '') ||
      (value.skillId !== null && typeof value.skillId !== 'string') ||
      (value.finalTaskStatus !== null && typeof value.finalTaskStatus !== 'string')
    )
      return defaults;
    return { ...defaultGitDeliverySettings, ...value };
  } catch {
    return defaults;
  }
}

/** 每个项目独立保存收尾选择，供任务和会话交付读取。 */
function followUpPreferencesKey(projectId: string): string {
  return `zeus.git-delivery.follow-ups:${projectId}`;
}

/** 无可用记忆时返回空，由调用方恢复历史选择。 */
function readSavedFollowUpPreferences(projectId: string): GitDeliveryFollowUpPreferences | null {
  try {
    /** 本地记录可能缺失或损坏，只有完整的选值和开关可恢复。 */
    const value = JSON.parse(localStorage.getItem(followUpPreferencesKey(projectId)) ?? 'null') as GitDeliveryFollowUpPreferences | null;
    if (!value || typeof value.commands !== 'boolean' || typeof value.taskStatus !== 'boolean' || !isPostPushCommandIds(value.postPushCommandIds) || (value.finalTaskStatus !== null && typeof value.finalTaskStatus !== 'string')) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** 旧记录用非空选择表示已启用。 */
function followUpsFromSettings(settings: GitDeliverySettings): GitDeliveryFollowUpPreferences {
  return {
    commands: Boolean(settings.postPushCommandIds?.length),
    taskStatus: Boolean(settings.finalTaskStatus),
    postPushCommandIds: settings.postPushCommandIds ?? [],
    finalTaskStatus: settings.finalTaskStatus,
  };
}

/** 优先恢复独立的项目记忆，其次沿用原项目组合里的选择。 */
export function readGitDeliveryFollowUps(projectId: string, settings?: GitDeliverySettings): GitDeliveryFollowUpPreferences {
  return readSavedFollowUpPreferences(projectId) ?? followUpsFromSettings(settings ?? readGitDeliverySettings(projectId));
}

/** 按当前项目合并用户本次修改的字段，保留其它已保存的选择。 */
export function writeGitDeliveryFollowUps(projectId: string, changes: Partial<GitDeliveryFollowUpPreferences>): void {
  localStorage.setItem(followUpPreferencesKey(projectId), JSON.stringify({ ...readGitDeliveryFollowUps(projectId), ...changes }));
}

/** 保存已接纳的组合，首次覆盖前独立保存原记录中的有效收尾选择。 */
export function writeGitDeliverySettings(projectId: string, settings: GitDeliverySettings): void {
  if (!readSavedFollowUpPreferences(projectId)) {
    /** 普通会话提交时没有任务状态，保留原记录中供任务交付使用的选择。 */
    const previous = followUpsFromSettings(readGitDeliverySettings(projectId));
    if (previous.commands || previous.taskStatus) localStorage.setItem(followUpPreferencesKey(projectId), JSON.stringify(previous));
  }
  localStorage.setItem(`zeus.git-delivery.settings:${projectId}`, JSON.stringify(settings));
}

/** 同一操作栏的步骤选择、详细设置与运行按钮共享当前组合。 */
export interface GitDeliveryCombinationState {
  /** 表单中的交付步骤和冲突设置。 */
  settings: GitDeliverySettings;
  /** 更新组合表单的选择。 */
  setSettings: Dispatch<SetStateAction<GitDeliverySettings>>;
  /** 单步合入及组合运行读取已启用的收尾参数。 */
  executionSettings: GitDeliverySettings;
  /** 项目记忆中的命令、任务状态和各自的启用状态。 */
  followUps: GitDeliveryFollowUpPreferences;
  /** 更新当前操作栏的收尾选择。 */
  setFollowUps: Dispatch<SetStateAction<GitDeliveryFollowUpPreferences>>;
  /** 具备有效目标分支时允许更改合入方式。 */
  canMerge: boolean;
  /** 执行期间锁定步骤与 AI 选项。 */
  stepsLocked: boolean;
  /** 窗口标题栏打开本次交付的详细设置。 */
  settingsOpen: boolean;
  /** 关闭弹窗不改变尚未保存的详细设置。 */
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  /** 接纳请求或后台运行期间锁定组合选择。 */
  setRunning: Dispatch<SetStateAction<boolean>>;
  /** 右栏底部承载组合按钮及其浮层。 */
  combinationHost: HTMLElement | null;
}

/** 任务和普通会话共用操作栏的选择、设置与组合入口。 */
export const GitDeliveryCombinationContext = createContext<GitDeliveryCombinationState | null>(null);
