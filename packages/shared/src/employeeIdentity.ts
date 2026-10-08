import type { DigitalEmployeeAvatarId } from './index.js';

/** 全局员工统一维护身份、提示词、经验偏好及默认执行参数。 */
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
  /** 默认执行后端。 */
  agentKind?: 'codex' | 'pi';
  /** 稳定模型身份；空值继承项目默认。 */
  model?: string | null;
  /** 默认推理级别；空值使用模型默认。 */
  reasoningEffort?: string | null;
  /** 默认上下文容量；空值使用模型默认。 */
  contextCapacityTokens?: number | null;
  /** 默认服务速率。 */
  serviceTier?: string | null;
  /** 默认工作模式。 */
  workMode?: 'default' | 'plan';
  /** 复用会话权限选择，不代表额外交付授权。 */
  permissionMode?: 'read-only' | 'auto' | 'auto-review' | 'full-access';
  /** 默认技能身份，空数组表示不使用。 */
  skillIds?: string[];
}

/** 固定可继承字段，防止全局记录的 ID、版本和项目身份覆盖项目绑定。 */
export const employeeConfigurationKeys = [
  'name',
  'description',
  'role',
  'domain',
  'avatarId',
  'prompt',
  'memoryEnabled',
  'agentKind',
  'model',
  'reasoningEffort',
  'contextCapacityTokens',
  'serviceTier',
  'workMode',
  'permissionMode',
  'skillIds',
] as const;

/** 员工配置只来自全局身份，项目绑定仅保留工作关联。 */
export function resolveEmployeeConfiguration<T extends EmployeeConfiguration>(global: EmployeeConfiguration | undefined, binding: T): T {
  /** 有效配置只复制通用字段，调用方冻结后再交给执行器。 */
  const result = { ...binding };
  for (const key of employeeConfigurationKeys) {
    /** 原项目差异不再进入新工作，旧运行仍读取自己的冻结快照。 */
    const value = global?.[key] !== undefined ? global[key] : binding[key];
    Object.assign(result, { [key]: value });
  }
  return result;
}
