import type { DigitalEmployeeAvatarId } from './index.js';

/** 全局员工统一维护身份、提示词和经验偏好；执行配置不属于员工身份。 */
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
  /** 全局员工通用工作要求。 */
  prompt: string;
  /** 是否读取经过治理的员工经验。 */
  memoryEnabled?: boolean;
}

/** 项目只保留独立的经验偏好，身份与提示词不能再次覆写。 */
export type ProjectEmployeeOverrides = Partial<Pick<EmployeeConfiguration, 'memoryEnabled'>>;

/** 固定可继承字段，防止全局记录的 ID、版本和项目身份覆盖项目绑定。 */
export const employeeConfigurationKeys = ['name', 'description', 'role', 'domain', 'avatarId', 'prompt', 'memoryEnabled'] as const;

/** 在共享边界合并全局配置与项目差异，保留项目绑定身份并追加项目要求。 */
export function resolveEmployeeConfiguration<T extends EmployeeConfiguration>(global: EmployeeConfiguration | undefined, binding: T & { projectOverrides?: ProjectEmployeeOverrides; projectInstructions?: string }): T {
  /** 有效配置只复制通用字段，调用方冻结后再交给执行器。 */
  const result = { ...binding };
  for (const key of employeeConfigurationKeys) {
    /** 项目未覆盖的字段继承员工默认值。 */
    const value = key === 'memoryEnabled' && binding.projectOverrides?.memoryEnabled !== undefined ? binding.projectOverrides.memoryEnabled : global?.[key] !== undefined ? global[key] : binding[key];
    Object.assign(result, { [key]: value });
  }
  if (binding.projectInstructions?.trim()) result.prompt = `${result.prompt}\n\n## 当前项目要求\n${binding.projectInstructions.trim()}`;
  return result;
}
