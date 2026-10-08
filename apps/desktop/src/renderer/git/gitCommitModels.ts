import type { GitApiClient, GitCommitModelOption } from '../features/git/gitApiClient.js';

/** 所有提交入口共用模型目录读取能力。 */
export type GitCommitModelsClient = Pick<GitApiClient, 'loadGitCommitModels'>;

/** 项目设置优先于全局默认，保存范围不进入模型请求。 */
export type GitCommitSettingsScope = 'project' | 'global';

/** 已选模型与实际生成参数一并保存。 */
export interface GitCommitGenerationSettings {
  /** 完整模型身份区分供应商和订阅目录。 */
  modelRef: string;
  /** 空值表示模型没有可选推理档位。 */
  effort: string;
  /** 仅启用模型支持的 Fast，空值明确使用标准速率。 */
  serviceTier: 'priority' | null;
}

/** 本机存储不可用时，设置仍对当前运行中的生成入口有效。 */
const currentSettings = new Map<string, GitCommitGenerationSettings | null>();

/** 全局组合一次写入，避免模型和档位分别保存后出现不完整默认值。 */
const globalSettingsKey = 'zeus.git.commit-global-settings';

/** 未保存项目模型时使用全局默认；空覆盖值表示本次运行已改用全局。 */
function readProjectModelRef(projectId: string): string | null {
  /** 沿用既有模型选择器的项目身份键。 */
  const key = `zeus.git.commit-model.${projectId}`;
  if (currentSettings.has(key)) return currentSettings.get(key)?.modelRef ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 设置读取失败不阻断生成，保存失败的当前运行参数优先。 */
function readSavedSettings(key: string): Partial<GitCommitGenerationSettings> | null {
  /** 不信任本机 JSON 的类型，只读取后续能力校验需要的字段。 */
  let saved: unknown = currentSettings.get(key);
  if (!currentSettings.has(key)) {
    try {
      saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  }
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Partial<GitCommitGenerationSettings>) : null;
}

/** 全局和项目组合都按当前模型能力校验，避免混用其他模型的档位。 */
function normalizeSettings(model: GitCommitModelOption, saved: Partial<GitCommitGenerationSettings> | null): GitCommitGenerationSettings {
  /** 无效或缺失的档位保持原提交生成的低档位，再退回模型目录默认值。 */
  const effort =
    model.supportedReasoningEfforts.find((item) => item === saved?.effort) ??
    model.supportedReasoningEfforts.find((item) => ['low', 'minimal', 'none', 'off'].includes(item)) ??
    model.defaultReasoningEffort ??
    model.supportedReasoningEfforts[0] ??
    '';
  return { modelRef: model.id, effort, serviceTier: saved?.serviceTier === 'priority' && model.serviceTiers.some((tier) => tier.id === 'priority') ? 'priority' : null };
}

/** 项目按模型保留档位；全局只应用其中保存的模型组合。 */
export function readGitCommitGenerationSettings(projectId: string, model: GitCommitModelOption, scope: GitCommitSettingsScope = readProjectModelRef(projectId) ? 'project' : 'global'): GitCommitGenerationSettings {
  /** 项目没有此模型的档位时，继承同一模型的全局组合。 */
  const projectSettings = scope === 'project' ? readSavedSettings(`zeus.git.commit-settings.${projectId}.${model.id}`) : null;
  /** 全局只作用于其中保存的模型，不把档位套到其他模型上。 */
  const globalSettings = readSavedSettings(globalSettingsKey);
  return normalizeSettings(model, projectSettings ?? (globalSettings?.modelRef === model.id ? globalSettings : null));
}

/** 与原模型选择器共用模型键；返回值说明是否已保存到本机。 */
export function saveGitCommitGenerationSettings(projectId: string, settings: GitCommitGenerationSettings, scope: GitCommitSettingsScope = 'project'): boolean {
  /** 项目模型绑定决定是否覆盖全局默认。 */
  const modelKey = `zeus.git.commit-model.${projectId}`;
  /** 项目保留逐模型档位，全局保存当前完整组合。 */
  const settingsKey = scope === 'global' ? globalSettingsKey : `zeus.git.commit-settings.${projectId}.${settings.modelRef}`;
  try {
    localStorage.setItem(settingsKey, JSON.stringify(settings));
    if (scope === 'global') localStorage.removeItem(modelKey);
    else localStorage.setItem(modelKey, settings.modelRef);
    currentSettings.delete(modelKey);
    currentSettings.delete(settingsKey);
    return true;
  } catch {
    // 仅保存失败才保留当前运行的覆盖值，正常读取能看到其他窗口的新偏好。
    currentSettings.set(modelKey, scope === 'global' ? null : settings);
    currentSettings.set(settingsKey, settings);
    return false;
  }
}

/** 提交入口共用项目覆盖与全局默认，停止时可取消模型读取。 */
export async function loadGitCommitModelOptions(client: GitCommitModelsClient, projectId: string, signal?: AbortSignal) {
  /** 每次生成重新读取真实目录，不把旧设置当作仍受支持的能力。 */
  const models = await client.loadGitCommitModels(projectId, signal);
  /** 现有项目模型优先，全局设置只作为未单独设置项目的默认。 */
  const projectModel = readProjectModelRef(projectId);
  /** 模型与档位从同一全局快照读取，避免拼接不同时间的组合。 */
  const globalSettings = readSavedSettings(globalSettingsKey);
  /** 没有任何已保存设置时，沿用仅保存当前项目的默认范围。 */
  const settingsScope: GitCommitSettingsScope = projectModel ? 'project' : globalSettings?.modelRef ? 'global' : 'project';
  /** 模型身份必须在当前可用目录中。 */
  const remembered = projectModel ?? globalSettings?.modelRef;
  /** 找不到已选模型时沿用既有的可用模型回退规则。 */
  const preferred = models.items.find((model) => model.id === remembered)?.id;
  /** 参数由同一模型能力归一化，防止跨模型混用档位。 */
  const selected = models.items.find((model) => model.id === preferred) ?? models.items[0];
  return {
    ...models,
    modelRef: selected?.id ?? '',
    settingsScope,
    settings: selected
      ? settingsScope === 'global'
        ? normalizeSettings(selected, globalSettings?.modelRef === selected.id ? globalSettings : null)
        : readGitCommitGenerationSettings(projectId, selected, 'project')
      : { modelRef: '', effort: '', serviceTier: null },
  };
}
