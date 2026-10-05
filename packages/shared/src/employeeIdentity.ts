import type { DigitalEmployeeAvatarId } from './index.js';

/** 全局员工与项目覆盖共用的工作配置；项目运行状态不属于员工身份。 */
export interface EmployeeConfiguration {
  /** 员工显示名称。 */
  name: string;
  /** 员工职责说明。 */
  description: string;
  /** 员工岗位。 */
  role: string;
  /** 通用业务领域。 */
  domain: string;
  /** 预置头像身份。 */
  avatarId?: DigitalEmployeeAvatarId | null;
  /** 每次工作冻结的 Skill 身份。 */
  skillIds: string[];
  /** 通用工作要求。 */
  prompt: string;
  /** 提供独立会话的模型来源。 */
  agentKind: 'codex' | 'pi';
  /** 空值表示使用项目默认模型。 */
  model: string | null;
  /** 模型思考强度。 */
  reasoningEffort: string | null;
  /** 模型服务等级。 */
  serviceTier: string | null;
  /** 执行权限模式。 */
  permissionMode: 'read-only' | 'auto' | 'full-access';
  /** 员工默认工作模式。 */
  workMode: 'default' | 'plan';
  /** 是否读取经过治理的员工经验。 */
  memoryEnabled?: boolean;
  /** 是否默认允许修改源码。 */
  allowCodeChanges?: boolean;
  /** 是否默认允许执行已有检查。 */
  allowTests?: boolean;
  /** 提交、推送、合并、部署和关单分别授权。 */
  deliveryGrants?: {
    /** 允许本地提交。 */
    allowCommit: boolean;
    /** 允许推送。 */
    allowPush: boolean;
    /** 允许合并。 */
    allowMerge: boolean;
    /** 允许部署。 */
    allowDeploy: boolean;
    /** 允许完成任务。 */
    allowComplete: boolean;
  };
}

/** 只保存明确设置的项目差异，未设置的字段随全局员工更新。 */
export type ProjectEmployeeOverrides = Partial<EmployeeConfiguration>;

/** 固定可继承字段，防止全局记录的 ID、版本和项目身份覆盖项目绑定。 */
export const employeeConfigurationKeys = [
  'name',
  'description',
  'role',
  'domain',
  'avatarId',
  'skillIds',
  'prompt',
  'agentKind',
  'model',
  'reasoningEffort',
  'serviceTier',
  'permissionMode',
  'workMode',
  'memoryEnabled',
  'allowCodeChanges',
  'allowTests',
  'deliveryGrants',
] as const;

/** 在共享边界合并全局配置与项目差异，保留项目绑定身份并追加项目要求。 */
export function resolveEmployeeConfiguration<T extends EmployeeConfiguration>(global: EmployeeConfiguration | undefined, binding: T & { projectOverrides?: ProjectEmployeeOverrides; projectInstructions?: string }): T {
  /** 有效配置只复制通用字段，调用方冻结后再交给执行器。 */
  const result = { ...binding };
  for (const key of employeeConfigurationKeys) {
    /** 项目未覆盖的字段继承员工默认值。 */
    const value = binding.projectOverrides && Object.hasOwn(binding.projectOverrides, key) ? binding.projectOverrides[key] : global?.[key] !== undefined ? global[key] : binding[key];
    Object.assign(result, { [key]: value });
  }
  result.skillIds = [...result.skillIds];
  if (result.deliveryGrants) result.deliveryGrants = { ...result.deliveryGrants };
  if (binding.projectInstructions?.trim()) result.prompt = `${result.prompt}\n\n## 当前项目要求\n${binding.projectInstructions.trim()}`;
  return result;
}
