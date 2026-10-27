import type { NativeCollaborationMode, NativePermissionMode, NativeServiceTierSelection, NativeTurnSettingsSelection } from './sessionTypes.js';
import { selectionFromEffectiveServiceTier } from './serviceTierSelection.js';

/** 项目内某个模型最近使用的执行选项。 */
export interface ProjectModelPreferences {
  /** 供应商与模型的完整身份，避免同名模型混用。 */
  model: string;
  /** 模型目录提供的推理等级。 */
  effort: string;
  /** 模型请求使用的速度档位。 */
  serviceTier: NativeServiceTierSelection;
  /** 上下文容量，单位为 Token；空值表示模型默认。 */
  contextCapacityTokens: number | null;
  /** 对话使用默认模式或规划模式。 */
  workMode: NativeCollaborationMode;
  /** 当前模型最近使用的权限模式。 */
  permissionMode: NativePermissionMode;
  /** 推送和新会话共用的单选 Skill 身份；空串表示不使用。 */
  skillId?: string;
  /** 任务推送选择的直接目录或工作树。 */
  workspaceMode?: 'direct' | 'worktree';
}

/** 每个项目独立保存最近模型和各模型的选择。 */
interface ProjectModelPreferenceRecord {
  /** 项目最近发送或确认推送的模型身份。 */
  lastModel: string;
  /** 同项目内各模型各自的执行选项。 */
  models: ProjectModelPreferences[];
}

/** 项目配置记忆的本地存储前缀。 */
const projectModelPreferenceKey = 'zeus.project-model-preferences:';

/** 已有推送配置的存储键，供首次读取时保留原项目选择。 */
const previousTaskPushPreferenceKey = 'zeus.task-model-push-preferences:v1:';

/** 获取可用的本地偏好存储。 */
export function browserProjectModelPreferenceStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** 校验本地记录并恢复可识别的模型选项。 */
function parsePreferences(value: unknown): ProjectModelPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  /** 可选字段需要逐项校验，不能信任本地存储内容。 */
  const preference = value as Partial<ProjectModelPreferences>;
  if (typeof preference.model !== 'string' || !preference.model || typeof preference.effort !== 'string') return null;
  if (preference.workMode !== 'default' && preference.workMode !== 'plan') return null;
  if (preference.permissionMode !== 'read-only' && preference.permissionMode !== 'auto' && preference.permissionMode !== 'auto-review' && preference.permissionMode !== 'full-access') return null;
  return {
    model: preference.model,
    effort: preference.effort,
    serviceTier: preference.serviceTier?.type === 'catalog' && preference.serviceTier.id === 'priority' ? { type: 'catalog', id: 'priority' } : { type: 'standard' },
    contextCapacityTokens: typeof preference.contextCapacityTokens === 'number' && Number.isSafeInteger(preference.contextCapacityTokens) && preference.contextCapacityTokens > 0 ? preference.contextCapacityTokens : null,
    workMode: preference.workMode,
    permissionMode: preference.permissionMode,
    ...(typeof preference.skillId === 'string' ? { skillId: preference.skillId } : {}),
    ...(preference.workspaceMode === 'direct' || preference.workspaceMode === 'worktree' ? { workspaceMode: preference.workspaceMode } : {}),
  };
}

/** 读取项目记录；尚无新记录时沿用该项目原来的推送选择。 */
function readRecord(storage: Pick<Storage, 'getItem'>, projectId: string): ProjectModelPreferenceRecord | null {
  try {
    /** 项目标识用于区分包括临时会话在内的不同范围。 */
    const suffix = encodeURIComponent(projectId);
    /** 新记录存在时不再借用旧记录，避免覆盖后来确认的选择。 */
    const raw = storage.getItem(`${projectModelPreferenceKey}${suffix}`);
    if (raw !== null) {
      /** 解析结果先保持未知类型，再检查记录结构。 */
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      /** 不完整记录不能决定模型和权限。 */
      const record = value as Partial<ProjectModelPreferenceRecord>;
      if (typeof record.lastModel !== 'string' || !Array.isArray(record.models)) return null;
      return { lastModel: record.lastModel, models: record.models.map(parsePreferences).filter((item): item is ProjectModelPreferences => item !== null) };
    }
    /** 首次读取保留同一项目已有的推送配置。 */
    const previous = parsePreferences(JSON.parse(storage.getItem(`${previousTaskPushPreferenceKey}${suffix}`) ?? 'null'));
    return previous ? { lastModel: previous.model, models: [previous] } : null;
  } catch {
    return null;
  }
}

/** 读取项目最近使用的模型，或读取指定模型的选项。 */
export function readProjectModelPreferences(storage: Pick<Storage, 'getItem'> | undefined, projectId: string, model?: string): ProjectModelPreferences | null {
  if (!storage || !projectId) return null;
  /** 一个项目的记录不参与其他项目的选择。 */
  const record = readRecord(storage, projectId);
  /** 未指定模型时恢复该项目最后使用的模型。 */
  const selectedModel = model ?? record?.lastModel;
  return record?.models.find((item) => item.model === selectedModel) ?? null;
}

/** 更新一个模型的选项，并保留同项目其他模型的记录。 */
export function writeProjectModelPreferences(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, projectId: string, preferences: ProjectModelPreferences): void {
  if (!storage || !projectId || !preferences.model) return;
  /** 写入前读取已有模型，避免覆盖同项目的其他选择。 */
  const record = readRecord(storage, projectId);
  /** 仅替换当前模型，其他模型保留原值。 */
  const models = record?.models.filter((item) => item.model !== preferences.model) ?? [];
  storage.setItem(`${projectModelPreferenceKey}${encodeURIComponent(projectId)}`, JSON.stringify({ lastModel: preferences.model, models: [...models, preferences] }));
}

/** 单个显式 Skill 才能对应推送表单中的单选；多个引用不猜默认项。 */
export function singleConversationSkill(settings: Pick<NativeTurnSettingsSelection, 'skillReferences' | 'pluginReferences'>): string | undefined {
  /** 原生和插件 Skill 使用不同协议，按身份去重后判断是否为单选。 */
  const ids = new Set([...(settings.skillReferences ?? []).map((item) => item.id), ...(settings.pluginReferences ?? []).filter((item) => item.kind === 'skill').map((item) => item.id)]);
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** 会话发送后更新模型设置，保留该模型的推送 Skill 和工作区方式。 */
export function writeProjectConversationPreferences(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  projectId: string,
  settings: Pick<NativeTurnSettingsSelection, 'model' | 'effort' | 'serviceTier' | 'contextCapacityTokens' | 'permissionMode' | 'collaborationMode' | 'skillReferences' | 'pluginReferences'>,
): void {
  /** 未重新选择 Skill 或工作区时保留该模型之前的选择。 */
  const remembered = readProjectModelPreferences(storage, projectId, settings.model);
  /** 一次发送只有一个显式 Skill 时更新默认项。 */
  const skillId = singleConversationSkill(settings) ?? remembered?.skillId;
  writeProjectModelPreferences(storage, projectId, {
    model: settings.model,
    effort: settings.effort ?? '',
    serviceTier: selectionFromEffectiveServiceTier(settings.serviceTier),
    contextCapacityTokens: settings.contextCapacityTokens ?? null,
    workMode: settings.collaborationMode,
    permissionMode: settings.permissionMode,
    ...(skillId !== undefined ? { skillId } : {}),
    ...(remembered?.workspaceMode ? { workspaceMode: remembered.workspaceMode } : {}),
  });
}
