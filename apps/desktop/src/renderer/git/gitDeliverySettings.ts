import { createContext, type Dispatch, type SetStateAction } from 'react';
import { defaultGitDeliverySettings, type GitDeliverySettings } from '@zeus/shared';

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
      (value.postPushCommandIds !== undefined &&
        (!Array.isArray(value.postPushCommandIds) ||
          value.postPushCommandIds.length > 50 ||
          value.postPushCommandIds.some((id) => typeof id !== 'string' || !id || id.length > 256) ||
          new Set(value.postPushCommandIds).size !== value.postPushCommandIds.length)) ||
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

/** 同一操作栏的步骤选择、详细设置与运行按钮共享当前组合。 */
export interface GitDeliveryCombinationState {
  /** 表单保留未启用的命令和状态选择，供本窗口内重新启用。 */
  settings: GitDeliverySettings;
  /** 更新组合表单的选择。 */
  setSettings: Dispatch<SetStateAction<GitDeliverySettings>>;
  /** 单步合入及组合运行读取已启用的收尾参数。 */
  executionSettings: GitDeliverySettings;
  /** 命令与任务状态分别启用，当前值不会因取消勾选而清除。 */
  followUps: { commands: boolean; taskStatus: boolean };
  /** 切换命令或任务状态的启用状态。 */
  setFollowUps: Dispatch<SetStateAction<GitDeliveryCombinationState['followUps']>>;
  /** 具备有效目标分支时允许更改合入方式。 */
  canMerge: boolean;
  /** 窗口标题栏打开本次交付的详细设置。 */
  settingsOpen: boolean;
  /** 关闭弹窗不改变尚未保存的详细设置。 */
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  /** 接纳请求或后台运行期间锁定组合选择。 */
  setRunning: Dispatch<SetStateAction<boolean>>;
  /** 组合执行按钮留在滚动区外的操作栏底部。 */
  footerHost: HTMLElement | null;
}

/** 任务和普通会话复用同一操作栏状态，不依赖跨组件 DOM 定位。 */
export const GitDeliveryCombinationContext = createContext<GitDeliveryCombinationState | null>(null);
