import type { GitApiClient } from '../features/git/gitApiClient.js';

export type GitCommitModelsClient = Pick<GitApiClient, 'loadGitCommitModels'>;

/** 提交入口共用模型偏好，未选择时使用最近记住的提交模型，停止时可取消模型读取。 */
export async function loadGitCommitModelOptions(client: GitCommitModelsClient, projectId: string, signal?: AbortSignal) {
  const models = await client.loadGitCommitModels(projectId, signal);
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(`zeus.git.commit-model.${projectId}`);
  } catch {
    /* 偏好不可用时退回第一个可用模型。 */
  }
  const preferred = models.items.find((model) => model.id === remembered)?.id;
  return { ...models, modelRef: preferred ?? models.items[0]?.id ?? '' };
}
