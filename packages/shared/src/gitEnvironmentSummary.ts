/** 环境卡片的只读范围；所有目录均由服务端按身份解析。 */
export interface GitEnvironmentScope {
  /** 任务工作树所属任务，普通项目目录不传。 */
  taskId?: string;
  /** 当前任务工作树，包括冲突处理工作树。 */
  workspaceId?: string;
  /** 独立普通会话身份，与任务范围互斥。 */
  conversationId?: string;
}

/** 卡片和代码审查入口所需的最小任务工作区身份。 */
export interface GitEnvironmentWorkspace {
  /** 持久工作区身份。 */
  id: string;
  /** 原任务环境，旧冲突工作区可为空。 */
  environmentId: string | null;
  /** 当前生命周期状态。 */
  state: string;
  /** 尚未回收的工作目录。 */
  worktreePath: string | null;
  /** 代码审查弹窗显示的仓库名称。 */
  repositoryName: string;
  /** 未配置仓库名时显示项目内相对路径。 */
  repositoryRelativePath: string;
}

/** 共享 Git 摘要不包含完整 patch、提交日志、标签或远端请求。 */
export interface GitEnvironmentSummary {
  /** 已核验的项目身份。 */
  projectId: string;
  /** 当前实际读取的工作目录。 */
  cwd: string;
  /** 当前工作树分支，多仓普通目录由界面显示仓库数量。 */
  branch: string | null;
  /** 任务创建时的来源分支。 */
  sourceBranch: string | null;
  /** 当前任务工作区，普通目录为空。 */
  workspace: GitEnvironmentWorkspace | null;
  /** 本次范围中的仓库数，包括已正常完成的仓库。 */
  repositoryCount: number;
  /** 单仓普通会话在代码审查弹窗中使用的名称。 */
  repositoryName?: string;
  /** 不同仓库内的同名文件分别计数。 */
  files: number;
  /** 已暂存、未暂存和新文件的新增行数。 */
  additions: number;
  /** 已暂存与未暂存的删除行数。 */
  deletions: number;
}
