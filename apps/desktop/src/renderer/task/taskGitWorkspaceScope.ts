/** 卡片统计与交付文件树使用同一任务分支范围；失效身份不能扩大到历史分支。 */
export function deliveryWorkspacesForConversationBranch<Workspace extends { id: string; branchName: string }>(workspaces: Workspace[], currentConversationWorkspaceId: string | null | undefined): Workspace[] {
  if (!currentConversationWorkspaceId) return workspaces;
  /** 分支只从服务端返回的确切工作区记录读取。 */
  const currentBranch = workspaces.find((workspace) => workspace.id === currentConversationWorkspaceId)?.branchName;
  return currentBranch ? workspaces.filter((workspace) => workspace.branchName === currentBranch) : [];
}
