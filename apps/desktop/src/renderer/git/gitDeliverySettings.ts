import { createContext, type Dispatch, type SetStateAction } from 'react';
import { defaultGitDeliverySettings, type GitDeliverySettings } from '@zeus/shared';

/** 本机项目偏好只保存操作选择，不保存文件或分支。 */
export function readGitDeliverySettings(projectId: string): GitDeliverySettings {
  try {
    const value = JSON.parse(localStorage.getItem(`zeus.git-delivery.settings:${projectId}`) ?? 'null') as Partial<GitDeliverySettings> | null;
    if (
      !value ||
      ['commit', 'merge', 'push', 'resolveConflicts'].some((key) => typeof value[key as 'commit'] !== 'boolean') ||
      (value.generateCommitMessage !== undefined && typeof value.generateCommitMessage !== 'boolean') ||
      !['auto', 'full-access'].includes(value.permissionMode ?? '') ||
      (value.skillId !== null && typeof value.skillId !== 'string') ||
      (value.finalTaskStatus !== null && typeof value.finalTaskStatus !== 'string')
    )
      return { ...defaultGitDeliverySettings };
    return { ...defaultGitDeliverySettings, ...value };
  } catch {
    return { ...defaultGitDeliverySettings };
  }
}

/** 同一操作栏的步骤选择、详细设置与运行按钮共享当前组合。 */
export interface GitDeliveryCombinationState {
  /** 当前勾选只在运行被接纳后保存为项目偏好。 */
  settings: GitDeliverySettings;
  /** 功能旁的复选框直接更新本次运行输入。 */
  setSettings: Dispatch<SetStateAction<GitDeliverySettings>>;
  /** 详细设置从功能区打开，底部只保留运行按钮。 */
  settingsOpen: boolean;
  /** 关闭弹窗不改变尚未保存的详细设置。 */
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  /** 接纳请求或后台运行期间锁定组合选择。 */
  setRunning: Dispatch<SetStateAction<boolean>>;
}

/** 任务和普通会话复用同一操作栏状态，不依赖跨组件 DOM 定位。 */
export const GitDeliveryCombinationContext = createContext<GitDeliveryCombinationState | null>(null);
