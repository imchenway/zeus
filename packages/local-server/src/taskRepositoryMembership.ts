import { resolve } from 'node:path';
import type { ZeusProjectRepositoryRecord, ZeusTaskWorkspaceRecord } from '@zeus/storage';

/** 项目清单与任务环境按真实来源路径比对，登记身份变化也不会重复补入同一仓库。 */
export function missingTaskRepositories(repositories: ZeusProjectRepositoryRecord[], workspaces: ZeusTaskWorkspaceRecord[]): ZeusProjectRepositoryRecord[] {
  /** 冲突处理分支不能代替正常任务仓库成员。 */
  const paths = new Set(workspaces.filter((workspace) => workspace.kind !== 'conflict' && workspace.repositoryPath).map((workspace) => resolve(workspace.repositoryPath)));
  return repositories.filter((repository) => !paths.has(resolve(repository.localPath)));
}
