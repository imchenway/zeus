import type { UserFacingErrorCause } from './userFacingError.js';

/** 交付入口固定到真实任务或会话，不接受客户端提供的绝对目录。 */
export type GitDeliveryScope = { kind: 'task'; taskId: string } | { kind: 'conversation'; conversationId: string };

/** 项目级组合偏好；每次运行保存独立快照。 */
export interface GitDeliverySettings {
  /** 是否提交本次交付范围内的文件；全目录入口包含全部仓库文件。 */
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

/** 初次交付默认处理全部仓库的合入冲突，避免停在首个冲突仓库；已保存的用户设置仍优先。 */
export const defaultGitDeliverySettings: GitDeliverySettings = { commit: true, generateCommitMessage: false, merge: true, push: true, resolveConflicts: true, permissionMode: 'auto', skillId: null, finalTaskStatus: null };

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
  /** 本次冻结的仓库与文件；全目录入口不得因文件树取消勾选而漏掉仓库。 */
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
  /** 原命令回执中的脱敏失败详情，不被后续结果核对提示覆盖。 */
  error?: UserFacingErrorCause;
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

/** 全目录交付只依赖工作区身份和来源关系，桌面与服务端共用。 */
export interface GitDeliveryWorkspace {
  /** 当前开发线的稳定身份。 */
  id: string;
  /** 原任务或冲突处理开发线。 */
  kind: 'task' | 'conflict';
  /** 冲突开发线所继承的上游工作区。 */
  baseWorkspaceId: string | null;
  /** 原工作目录的环境身份。 */
  environmentId: string | null;
  /** 无环境的旧记录使用既有任务分支范围。 */
  branchName: string;
  /** 判断已回收的冲突开发线是否仍拥有修改现场。 */
  state: string;
  /** 当前开发线的物理目录，已回收时为空。 */
  worktreePath: string | null;
}

/** 沿显式关系找到原任务开发线，失效或循环关系不能扩大交付范围。 */
export function resolveGitDeliveryRootWorkspace<Workspace extends GitDeliveryWorkspace>(workspaces: Workspace[], workspaceId: string): Workspace | undefined {
  /** 从当前任务返回的记录中核对身份。 */
  let root = workspaces.find((workspace) => workspace.id === workspaceId);
  /** 记录访问身份，拒绝循环关系。 */
  const visited = new Set<string>();
  while (root?.kind === 'conflict') {
    if (visited.has(root.id)) return undefined;
    visited.add(root.id);
    root = workspaces.find((workspace) => workspace.id === root!.baseWorkspaceId);
  }
  return root;
}

/** 卡片和交付文件树沿原任务环境恢复多仓范围，当前仓库保留所选冲突开发线。 */
export function deliveryWorkspacesForConversationBranch<Workspace extends GitDeliveryWorkspace>(workspaces: Workspace[], currentConversationWorkspaceId: string | null | undefined): Workspace[] {
  if (!currentConversationWorkspaceId) return workspaces;
  /** 冲突分支名不能代表原任务的多仓库环境。 */
  const current = workspaces.find((workspace) => workspace.id === currentConversationWorkspaceId);
  if (!current) return [];
  /** 二次冲突仍以原任务工作目录作为交付范围。 */
  const root = resolveGitDeliveryRootWorkspace(workspaces, current.id);
  if (!root) return [];
  /** 已回收的冲突现场不遮住原任务仓库后续产生的新提交。 */
  const replacement = !current.worktreePath && (current.state === 'merged' || current.state === 'reclaimed') ? root : current;
  return workspaces
    .filter((workspace) => workspace.kind !== 'conflict' && (root.environmentId ? workspace.environmentId === root.environmentId : workspace.branchName === root.branchName))
    .map((workspace) => (workspace.id === root.id ? replacement : workspace));
}
