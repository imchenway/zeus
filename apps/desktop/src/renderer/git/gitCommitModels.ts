import type { GitApiClient } from '../features/git/gitApiClient.js';

export type GitCommitModelsClient = Pick<GitApiClient, 'loadGitCommitModels'>;

/** 两个提交入口共用模型偏好，未选择时使用最近一次记住的提交模型。 */
export async function loadGitCommitModelOptions(client: GitCommitModelsClient, projectId: string) {
  const models = await client.loadGitCommitModels(projectId);
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(`zeus.git.commit-model.${projectId}`);
  } catch {
    /* 偏好不可用时退回第一个可用模型。 */
  }
  const preferred = models.items.find((model) => model.id === remembered)?.id;
  return { ...models, modelRef: preferred ?? models.items[0]?.id ?? '' };
}
