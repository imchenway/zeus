/** 员工默认与任务安排共用的可选配置；省略表示继承，空技能集合表示明确清空。 */
export interface EmployeeWorkSettings {
  /** 有原生目标能力时持续推进到该目标完成；空值关闭本层目标。 */
  autonomyObjective?: string | null;
  /** 允许当前工作拆分给明确成员，子工作不能扩大此范围。 */
  delegation?: { employeeIds: string[]; maxDepth: number; maxWorkItems: number };
  /** 本层显式选择的模型；空值回到项目默认。 */
  modelOverride?: string | null;
  /** 推理强度；空值使用模型默认。 */
  reasoningEffort?: string | null;
  /** 服务速率；空值使用标准档。 */
  serviceTier?: string | null;
  /** 本次推理工作方式。 */
  workMode?: 'default' | 'plan';
  /** 偏好权限，实际动作仍受当前授权约束。 */
  permissionMode?: 'read-only' | 'auto' | 'full-access';
  /** 明确启用的技能身份，不携带凭据。 */
  skillIds?: string[];
  /** 针对本层的工作方法补充。 */
  promptOverride?: string | null;
}

/** 分工的预期成果类型，用于提交及阶段检查。 */
export type EmployeeWorkOutputKind = 'document' | 'code' | 'verification' | 'deployment';

/** 流程中的职责分工；没有员工时保留待领取安排。 */
export interface EmployeeWorkAssignment {
  /** 该份分工的明确目标。 */
  title: string;
  /** 工作边界及完成标准。 */
  description: string;
  /** 稳定的项目员工身份。 */
  employeeId: string | null;
  /** 待领取时用来匹配员工职责。 */
  role: string;
  /** 本工作后续执行的配置覆盖。 */
  settings: EmployeeWorkSettings;
  /** 是否参与阶段完成条件。 */
  required: boolean;
  /** 需要提交的真实成果种类。 */
  outputKinds: EmployeeWorkOutputKind[];
}

/** 有序阶段组织明确分工，阶段之间等待前序成果通过。 */
export interface EmployeeWorkStageInput {
  /** 用户可自定义的阶段名称。 */
  title: string;
  /** 阶段目标及验收条件。 */
  description: string;
  /** 本阶段后续工作的配置覆盖。 */
  settings: EmployeeWorkSettings;
  /** 所有分工必须具备的技能。 */
  requiredSkillIds: string[];
  /** 通过后自动准备下一阶段，或等待用户继续。 */
  advanceMode: 'auto' | 'manual';
  /** 通过需要用户审查，或通过结构与未决问题检查后自动接纳。 */
  /** 自动接纳时必须逐条具有明确成功记录的命令。 */
  verificationCommands?: string[];
  acceptanceMode: 'manual' | 'checked';
  /** 同阶段并行分工，每份工作只执行一次。 */
  assignments: EmployeeWorkAssignment[];
}

/** 可重复使用的团队安排只是配方，不创建第二种员工身份。 */
export interface EmployeeTeamRecipe {
  /** 项目内稳定配方身份。 */
  id: string;
  /** 配方所属项目。 */
  projectId: string;
  /** 用户可识别的用途。 */
  name: string;
  /** 拷贝到任务后可独立调整的阶段安排。 */
  stages: EmployeeWorkStageInput[];
  /** 乐观并发控制修订。 */
  revision: number;
}

/** 按层叠加显式值；不会把模板或权限批准混入运行默认。 */
export function mergeEmployeeWorkSettings(...layers: Array<EmployeeWorkSettings | null | undefined>): EmployeeWorkSettings {
  /** 每层只覆盖实际提供的字段，数组生成独立副本。 */
  const result: EmployeeWorkSettings = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of ['autonomyObjective', 'delegation', 'modelOverride', 'reasoningEffort', 'serviceTier', 'workMode', 'permissionMode', 'skillIds', 'promptOverride'] as const) {
      if (layer[key] !== undefined) Object.assign(result, { [key]: structuredClone(layer[key]) });
    }
  }
  return result;
}
