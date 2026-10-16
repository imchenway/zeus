/** 交付入口固定到真实任务或会话，不接受客户端提供的绝对目录。 */
export type GitDeliveryScope = { kind: 'task'; taskId: string } | { kind: 'conversation'; conversationId: string };

/** 项目级组合偏好；每次运行保存独立快照。 */
export interface GitDeliverySettings {
  /** 是否提交勾选文件。 */
  commit: boolean;
  /** 提交前按所选文件自动生成说明，默认关闭。 */
  generateCommitMessage: boolean;
  /** 是否执行本入口的合入。 */
  merge: boolean;
  /** 是否推送对应分支。 */
  push: boolean;
  /** 合入冲突是否自动启动 AI。 */
  resolveConflicts: boolean;
  /** AI 使用用户明确选择的现有权限。 */
  permissionMode: 'auto' | 'full-access';
  /** 可选的冲突处理 Skill 身份。 */
  skillId: string | null;
  /** 全部成功后变更的管理状态；普通会话必须为空。 */
  finalTaskStatus: string | null;
}

/** 初次使用只启用三个明确的 Git 步骤。 */
export const defaultGitDeliverySettings: GitDeliverySettings = { commit: true, generateCommitMessage: false, merge: true, push: true, resolveConflicts: false, permissionMode: 'auto', skillId: null, finalTaskStatus: null };

/** 一次运行固定的仓库及相对路径。 */
export interface GitDeliverySelection {
  /** 任务工作区身份或项目、会话仓库身份。 */
  repositoryId: string;
  /** 精确勾选的仓库相对路径。 */
  paths: string[];
  /** 用户审阅时的当前分支。 */
  expectedBranch: string;
  /** 用户审阅时的提交身份；首次提交可以为空。 */
  expectedHeadSha: string;
  /** 任务入口为合入目标；会话入口为要合入的来源分支。 */
  mergeBranch: string;
}

/** 接纳请求冻结本次全部输入，不随页面刷新改变。 */
export interface GitDeliveryInput {
  /** 真实入口归属。 */
  scope: GitDeliveryScope;
  /** 本次操作选择。 */
  settings: GitDeliverySettings;
  /** 现有提交说明。 */
  message: string;
  /** AI 提交使用点击运行时的模型设置；未启用时不读取模型。 */
  commitMessageGeneration?: {
    /** 提交说明的默认语言。 */
    language: 'zh-CN' | 'en';
    /** 复用现有提交入口选择的完整模型身份。 */
    modelRef: string;
    /** 模型目录中已选的推理档位。 */
    effort: string;
    /** 标准速率为空，Fast 使用 priority。 */
    serviceTier: 'priority' | null;
  };
  /** 任务入口支持已有的合入方式。 */
  mode: 'merge' | 'squash';
  /** 显式选择的仓库及文件。 */
  repositories: GitDeliverySelection[];
}

/** AI 是合入的条件处理，任务状态是全局最后一步。 */
export type GitDeliveryAction = 'commit' | 'merge' | 'push' | 'task_status';
/** 未知结果与确定失败分开，不能直接重放。 */
export type GitDeliveryStepState = 'pending' | 'running' | 'waiting' | 'attention' | 'unknown' | 'succeeded';

/** Renderer 只接收显示所需事实，不接收服务端工作目录。 */
export interface GitDeliveryStep {
  /** 持久步骤身份。 */
  id: string;
  /** 任务状态步骤为空，其余为本次选择身份。 */
  repositoryId: string | null;
  /** 可读仓库名。 */
  repositoryName: string;
  /** 固定操作类型。 */
  action: GitDeliveryAction;
  /** 实际执行状态。 */
  state: GitDeliveryStepState;
  /** 真实错误或待处理原因。 */
  message: string | null;
  /** 终态清理需要用户再次确认，保留服务端实际数量。 */
  cleanupConfirmation?: { dirtyWorkspaceCount: number; activeConversationCount: number; activeRuntimeSessionCount: number };
  /** 可打开的冲突会话。 */
  conversationId: string | null;
  /** 可打开的任务冲突现场。 */
  integrationId: string | null;
}

/** 可恢复的后台交付投影。 */
export interface GitDeliveryRun {
  /** 唯一运行身份。 */
  id: string;
  /** 真实项目。 */
  projectId: string;
  /** 固定入口。 */
  scope: GitDeliveryScope;
  /** 固定用户输入。 */
  input: GitDeliveryInput;
  /** 有待处理项时为 attention，有 AI 活动时仍为 running。 */
  state: 'queued' | 'running' | 'attention' | 'succeeded';
  /** 创建时间。 */
  createdAt: string;
  /** 最近变化时间。 */
  updatedAt: string;
  /** 按仓库和步骤排序的实际进度。 */
  steps: GitDeliveryStep[];
}

/** 通知直接引用交付记录，不复制另一份执行状态。 */
export interface GitDeliveryNotification {
  /** 运行身份。 */
  id: string;
  /** 真实项目。 */
  projectId: string;
  /** 真实入口。 */
  scope: GitDeliveryScope;
  /** 用户可读名称。 */
  title: string;
  /** 成功或需要处理。 */
  status: 'succeeded' | 'attention';
  /** 状态变更时间。 */
  occurredAt: string;
}
