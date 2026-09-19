import type { GitApiClient } from '../features/git/gitApiClient.js';
import type { IntegrationApiClient } from '../features/integrations/integrationApiClient.js';

export type GitCommitModelsClient = Pick<GitApiClient, 'loadGitCommitModels'> & Pick<IntegrationApiClient, 'loadProjectModelSelection'>;

/** 两个提交入口共用模型偏好，未选择时使用项目默认模型。 */
export async function loadGitCommitModelOptions(client: GitCommitModelsClient, projectId: string) {
  const [models, selection] = await Promise.all([client.loadGitCommitModels(projectId), client.loadProjectModelSelection(projectId)]);
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(`zeus.git.commit-model.${projectId}`);
  } catch {
    /* 偏好不可用时使用项目默认模型。 */
  }
  const preferred = [remembered, selection.defaultModelRef].find((ref) => models.items.some((model) => model.id === ref));
  return { ...models, modelRef: preferred ?? models.items[0]?.id ?? '' };
}
