import type { DigitalTeamEmployeeNode, DigitalTeamWorkflowDefinition } from '@zeus/shared';

/** 默认分工只定义流程需要的工作，不构成当前任务的执行授权。 */
type DigitalTeamMemberDefaults = Pick<DigitalTeamEmployeeNode['data'], 'purpose' | 'executionMode' | 'instructions' | 'acceptanceCriteria' | 'expectedDeliverables' | 'completionStatusId'>;

/** 角色判断只读取真实员工岗位，不使用名称或团队标题猜测职责。 */
interface DigitalTeamMemberRole {
  /** 真实已创建员工身份。 */
  id: string;
  /** 员工配置中保存的岗位。 */
  role: string;
}

/** 非标准岗位沿用通用只读分工，不能默认为用户授权代码修改。 */
const genericMemberDefaults: DigitalTeamMemberDefaults = {
  purpose: 'work',
  executionMode: 'read_only',
  instructions: '根据当前任务目标和数字员工职责完成工作，并提交可核对结果。',
  acceptanceCriteria: ['按工作要求完成并提交可核对结果'],
  expectedDeliverables: ['可核对的工作成果'],
};

/** 标准研发岗位具备明确交付职责，实际写入仍受任务和本次运行授权控制。 */
const standardMemberDefaults = new Map<string, DigitalTeamMemberDefaults>([
  [
    'CTO',
    {
      purpose: 'plan',
      executionMode: 'read_only',
      instructions: '分析当前任务并提交可执行方案，明确开发范围、实现步骤、关键风险与验收要点；本分工只做分析，不修改代码。',
      acceptanceCriteria: ['方案覆盖任务目标、开发范围与验收要点', '提交可供后续开发使用的方案和依据'],
      expectedDeliverables: ['可执行方案与验收要点'],
    },
  ],
  [
    '开发',
    {
      purpose: 'work',
      executionMode: 'isolated_write',
      instructions: '读取上游方案，按当前任务目标实现代码，执行仓库既有检查，修正本分工发现的问题，并在隔离工作区提交可核对的代码结果。',
      acceptanceCriteria: ['代码实现覆盖任务与上游方案，相关检查通过', '提交准确输入版本和本地提交，说明实现与剩余问题'],
      expectedDeliverables: ['代码提交、实现说明与检查证据'],
    },
  ],
  [
    '测试',
    {
      purpose: 'verify',
      executionMode: 'candidate_read_only',
      instructions: '读取上游代码成果，在准确候选上按当前任务要求与仓库既有检查执行真实验收；提交成功命令、被测版本和结果，发现阻塞问题时提交可复现缺陷。',
      acceptanceCriteria: ['验收覆盖任务关键路径和边界条件', '依据真实成功命令与准确候选提交结果，阻塞缺陷如实说明'],
      expectedDeliverables: ['准确候选的验收结论、真实命令证据与缺陷记录'],
    },
  ],
]);

/** 新增分工按明确标准岗位预填要求，自定义岗位继续只读，不推断连接顺序。 */
export function digitalTeamMemberDefaults(role: string | undefined, completedStatusId?: string): DigitalTeamMemberDefaults {
  /** 测试的完成映射来自实际全局完成角色，其他岗位不自动设置任务状态。 */
  const defaults = standardMemberDefaults.get(role?.trim() ?? '') ?? genericMemberDefaults;
  return structuredClone({ ...defaults, ...(role?.trim() === '测试' && completedStatusId ? { completionStatusId: completedStatusId } : {}) });
}

/** 仅为显式草稿动作补唯一标准开发负责人，保留已配置负责人和修复轮数，不授予任务权限。 */
export function withDigitalTeamDefaultRepairEmployee(definition: DigitalTeamWorkflowDefinition, employees: readonly DigitalTeamMemberRole[]): DigitalTeamWorkflowDefinition {
  if (definition.repairEmployeeId !== undefined) return definition;
  /** 开发身份只来自当前真实员工岗位，同一员工的多个分工只计一次。 */
  const developerIds = new Set(employees.filter((employee) => employee.role.trim() === '开发').map((employee) => employee.id));
  /** 多个开发员工没有唯一负责人，保持未配置并交由团队设置选择。 */
  const assignedDeveloperIds = [...new Set(definition.nodes.flatMap((node) => (node.type === 'employee' && developerIds.has(node.data.employeeId) ? [node.data.employeeId] : [])))];
  return assignedDeveloperIds.length === 1 ? { ...definition, repairEmployeeId: assignedDeveloperIds[0] } : definition;
}

/** 未编辑的旧默认研发图按真实岗位补齐分工；只改变草稿，保存和启动仍由用户操作。 */
export function buildDigitalTeamDevelopmentDraft(definition: DigitalTeamWorkflowDefinition, employees: readonly DigitalTeamMemberRole[], completedStatusId?: string): DigitalTeamWorkflowDefinition | null {
  if (definition.nodes.length !== 3 || definition.nodes.some((node) => node.type !== 'employee' || node.data.purpose !== 'work' || node.data.executionMode !== 'read_only')) return null;
  /** 只有历史生成的通用要求可补默认值；明确配置的只读流程保持原意。 */
  if (definition.nodes.some((node) => node.type !== 'employee' || !isDefaultDevelopmentMember(node))) return null;
  /** 岗位来源绑定当前真实员工身份，不用节点历史标题反推。 */
  const rolesByEmployeeId = new Map(employees.map((employee) => [employee.id, employee.role.trim()]));
  /** 每个节点必须对应明确标准岗位，额外自定义岗位不参与批量转换。 */
  const roles = definition.nodes.map((node) => (node.type === 'employee' ? rolesByEmployeeId.get(node.data.employeeId) : undefined));
  if (roles.some((role) => !role || !standardMemberDefaults.has(role)) || !['CTO', '开发', '测试'].every((role) => roles.includes(role))) return null;
  return withDigitalTeamDefaultRepairEmployee(
    {
      ...definition,
      nodes: definition.nodes.map((node) => {
        if (node.type !== 'employee') return node;
        /** 明确岗位默认值只替换旧通用职责和缺省工作协议。 */
        const defaults = digitalTeamMemberDefaults(rolesByEmployeeId.get(node.data.employeeId), completedStatusId);
        return {
          ...node,
          data: {
            ...node.data,
            purpose: defaults.purpose,
            executionMode: defaults.executionMode,
            ...(node.data.completionStatusId === undefined && defaults.completionStatusId ? { completionStatusId: defaults.completionStatusId } : {}),
            instructions: !node.data.instructions.trim() || node.data.instructions === genericMemberDefaults.instructions ? defaults.instructions : node.data.instructions,
            acceptanceCriteria: defaults.acceptanceCriteria,
            expectedDeliverables: defaults.expectedDeliverables,
          },
        };
      }),
    },
    employees,
  );
}

/** 精确识别早期界面生成的通用职责，不按用户的员工名称推断执行授权。 */
function isDefaultDevelopmentMember(node: DigitalTeamEmployeeNode): boolean {
  /** 两种历史默认完成标准均由旧界面生成，自定义内容不参与补齐。 */
  const criteria = node.data.acceptanceCriteria ?? [];
  /** 空值与通用产物描述都是旧默认状态。 */
  const deliverables = node.data.expectedDeliverables ?? [];
  return (
    (!node.data.instructions.trim() || node.data.instructions === genericMemberDefaults.instructions) &&
    (criteria.length === 0 || (criteria.length === 1 && (criteria[0] === genericMemberDefaults.acceptanceCriteria?.[0] || criteria[0] === `完成“${node.data.title}”并提交可核对结果`))) &&
    (deliverables.length === 0 || (deliverables.length === 1 && deliverables[0] === genericMemberDefaults.expectedDeliverables?.[0]))
  );
}
