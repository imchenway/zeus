import type { DigitalTeamNode, DigitalTeamRunRuntimeState, DigitalTeamWorkflowDefinition, DigitalTeamWorkflowValidationIssue } from './digitalTeamWorkflow.js';

/** 流程值使用可持久化 JSON；正文和二进制资料通过固定成果引用交接。 */
export type WorkflowValue = null | boolean | number | string | WorkflowValue[] | { [key: string]: WorkflowValue };

/** 数据绑定不执行脚本，字段路径使用点分隔的自有属性名称。 */
export type WorkflowBinding = ({ source: 'literal'; value: WorkflowValue } | { source: 'task'; path: string } | { source: 'node'; nodeId: string; path: string } | { source: 'artifact'; id: string; sha256: string }) & {
  /** 草稿的解析错误必须修正后才能保存。 */ parseError?: boolean;
};

/** 支持的结构契约，额外字段默认保留，required 明确必填字段。 */
export interface WorkflowValueSchema {
  /** JSON 值类型。 */
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  /** 对象字段契约。 */
  properties?: Record<string, WorkflowValueSchema>;
  /** 对象必填字段。 */
  required?: string[];
  /** 数组元素契约。 */
  items?: WorkflowValueSchema;
  /** 有限枚举值。 */
  enum?: WorkflowValue[];
}

/** 所有能力调用和控制节点共用的输入输出契约。 */
export interface WorkflowDataContract {
  /** 输入字段及来源。 */
  inputs?: Record<string, WorkflowBinding>;
  /** 输出结构；不符合契约的输出不能进入下游。 */
  outputSchema?: WorkflowValueSchema;
}

/** 工具引用同时冻结身份、版本、定义摘要和审批策略。 */
export interface WorkflowToolReference {
  /** 提供工具的现有会话，用其授权与 Plugin 激活配置。 */
  conversationId: string;
  /** 工具目录返回的完整固定身份。 */
  tool: Record<string, WorkflowValue>;
}

/** Invoke 的能力提供者，不为业务动作增设节点类型。 */
export type WorkflowCapability = { kind: 'tool'; reference: WorkflowToolReference } | { kind: 'workflow'; templateId: string; templateRevision: number } | { kind: 'transform' };

/** 原语节点使用与员工节点相同的稳定身份和画布坐标。 */
interface WorkflowPrimitiveBase<TType extends string, TData extends Record<string, unknown>> {
  /** 模板内稳定身份。 */
  id: string;
  /** 基础执行语义。 */
  type: TType;
  /** 画布坐标。 */
  position: { x: number; y: number };
  /** 用户配置。 */
  data: TData & WorkflowDataContract & { title: string };
}

/** 统一调用；员工调用继续复用现有 employee 执行适配器。 */
export type WorkflowInvokeNode = WorkflowPrimitiveBase<'invoke', { capability: WorkflowCapability }>;

/** 等待人工回应、外部事件或指定时刻，不占用模型轮次。 */
export type WorkflowAwaitNode = WorkflowPrimitiveBase<
  'await',
  {
    /** 等待来源。 */
    mode: 'human' | 'event' | 'timer';
    /** 回应必须来自这些真实主体；定时等待不使用。 */
    actorIds: string[];
    /** 外部事件关联身份。 */
    eventKey?: string;
    /** 等待期限，单位毫秒。 */
    timeoutMs: number;
    /** 到期时失败，或返回结构化 timedOut 输出。 */
    onTimeout: 'fail' | 'continue';
  }
>;

/** 分支只比较结构化输入，按配置顺序选择第一个匹配出口。 */
export type WorkflowRouteNode = WorkflowPrimitiveBase<
  'route',
  {
    /** 分支规则。 */
    cases: { field: string; operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'; value?: WorkflowValue; targetId: string; parseError?: boolean }[];
    /** 未匹配时的出口；空值表示明确失败。 */
    defaultTargetId?: string;
  }
>;

/** 显式汇合与普通多前驱连线使用相同的全部已选分支规则。 */
export type WorkflowJoinNode = WorkflowPrimitiveBase<'join', Record<string, unknown>>;

/** 可配置的流程控制原语。 */
export type WorkflowPrimitiveNode = WorkflowInvokeNode | WorkflowAwaitNode | WorkflowRouteNode | WorkflowJoinNode;

/** 本次准确尝试的绑定、输出、等待和父子关系快照。 */
export interface WorkflowExecution {
  /** 已解析且冻结的输入。 */
  input: Record<string, WorkflowValue>;
  /** 验证后的结构化输出。 */
  output?: WorkflowValue;
  /** 路由选中的直接后继。 */
  selectedTargets?: string[];
  /** 等待的准确关联和到期时间。 */
  wait?: { id: string; deadline: string; eventKey?: string; kind?: 'tool_approval'; respondedBy?: string; responseCommandId?: string };
  /** 固定子流程运行身份。 */
  childRunId?: string;
}

/** 新内核的耐久控制状态，不与员工事实或原始工具输出混存。 */
export interface WorkflowGraphRuntimeState {
  /** 父运行接纳时固定的逐节点子流程。 */
  subflows?: Record<string, WorkflowFrozenSubflow>;
  /** LangGraph 的有界序列化检查点及待提交写入。 */
  checkpoint?: string;
  /** 图决定等待时所见的业务事实摘要，用于跳过空扫描。 */
  observedDigest?: string;
  /** 创建根运行的真实主体，默认人工回应者。 */
  ownerActorId?: string;
  /** 调用当前子流程的父运行身份。 */
  parentRunId?: string;
  /** 创建当前子流程的准确父尝试。 */
  parentAttemptId?: string;
  /** 从根运行开始的嵌套层数，最多四层。 */
  depth?: number;
  /** 根运行与子流程共享的最大尝试次数，缺省五百一十二次。 */
  maxNodeAttempts?: number;
}

/** 接纳父运行时固定子流程图和员工配置，模板后来变化不会替换已批准内容。 */
export interface WorkflowFrozenSubflow {
  /** 来源模板身份。 */
  templateId: string;
  /** 接纳时的准确修订。 */
  templateRevision: number;
  /** 已校验的完整定义。 */
  definition: DigitalTeamWorkflowDefinition;
  /** 已解析的执行配置及更深层子流程。 */
  runtimeState?: DigitalTeamRunRuntimeState;
  /** 员工配置变化时明确拒绝，避免使用后来改变的职责或授权。 */
  employeeConfigurations?: Record<string, string>;
}

/** 展开已固定的能力图，只用于权限和仓库需求计算，不另行调度节点。 */
export function workflowSubflowNodes(subflows: Record<string, WorkflowFrozenSubflow> | undefined): DigitalTeamNode[] {
  return Object.values(subflows ?? {}).flatMap((subflow) => [...subflow.definition.nodes, ...workflowSubflowNodes(subflow.runtimeState?.graph?.subflows)]);
}

/** 读取安全字段路径；禁止原型属性和任意表达式。 */
export function workflowField(value: unknown, path: string): WorkflowValue | undefined {
  if (!path) return value as WorkflowValue;
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (!/^[A-Za-z0-9_-]+$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key) || current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as WorkflowValue;
}

/** 按有限 JSON 契约核对值，错误定位到实际字段。 */
export function workflowValueIssue(value: unknown, schema: WorkflowValueSchema, path = 'output', depth = 0): string | null {
  if (depth > 16) return `${path} 的结构超过十六层。`;
  const valid =
    schema.type === 'null'
      ? value === null
      : schema.type === 'array'
        ? Array.isArray(value)
        : schema.type === 'object'
          ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : schema.type === 'integer'
            ? Number.isSafeInteger(value)
            : typeof value === schema.type && (schema.type !== 'number' || Number.isFinite(value));
  if (!valid) return `${path} 必须是 ${schema.type}。`;
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) return `${path} 不在允许的枚举中。`;
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value as object, key)) return `${path}.${key} 为必填字段。`;
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value as object, key)) continue;
      const issue = workflowValueIssue((value as Record<string, unknown>)[key], child, `${path}.${key}`, depth + 1);
      if (issue) return issue;
    }
  }
  if (schema.type === 'array' && schema.items)
    for (const [index, item] of (value as unknown[]).entries()) {
      const issue = workflowValueIssue(item, schema.items, `${path}.${index}`, depth + 1);
      if (issue) return issue;
    }
  return null;
}

/** 解析明确来源；缺失字段与 null、false、零、空字符串严格区分。 */
export function bindWorkflowInputs(bindings: Record<string, WorkflowBinding> | undefined, task: unknown, outputs: ReadonlyMap<string, WorkflowValue>): Record<string, WorkflowValue> {
  const result: Record<string, WorkflowValue> = {};
  for (const [key, binding] of Object.entries(bindings ?? {})) {
    const value =
      binding.source === 'literal'
        ? binding.value
        : binding.source === 'artifact'
          ? { id: binding.id, sha256: binding.sha256 }
          : binding.source === 'task'
            ? workflowField(task, binding.path)
            : workflowField(outputs.get(binding.nodeId), binding.path);
    if (value === undefined) throw new Error(`输入 ${key} 的来源字段不存在。`);
    Object.defineProperty(result, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

/** 返回首个匹配出口，非数值字段不能参与数值比较。 */
export function routeWorkflowInput(node: WorkflowRouteNode, input: Record<string, WorkflowValue>): string {
  for (const rule of node.data.cases) {
    const actual = workflowField(input, rule.field);
    if (actual === undefined && rule.operator !== 'exists') throw new Error(`分支字段 ${rule.field} 不存在。`);
    const equal = JSON.stringify(actual) === JSON.stringify(rule.value);
    const match =
      rule.operator === 'exists'
        ? actual !== undefined
        : rule.operator === 'eq'
          ? equal
          : rule.operator === 'neq'
            ? !equal
            : typeof actual === 'number' && typeof rule.value === 'number'
              ? rule.operator === 'gt'
                ? actual > rule.value
                : rule.operator === 'gte'
                  ? actual >= rule.value
                  : rule.operator === 'lt'
                    ? actual < rule.value
                    : actual <= rule.value
              : false;
    if (match) return rule.targetId;
    if (['gt', 'gte', 'lt', 'lte'].includes(rule.operator) && (typeof actual !== 'number' || typeof rule.value !== 'number')) throw new Error(`分支字段 ${rule.field} 必须是数值。`);
  }
  if (node.data.defaultTargetId) return node.data.defaultTargetId;
  throw new Error('没有匹配的分支，也未设置默认出口。');
}

/** 检查原语配置和绑定依赖，保存与运行共用此边界。 */
export function validateWorkflowPrimitives(definition: DigitalTeamWorkflowDefinition): DigitalTeamWorkflowValidationIssue[] {
  const issues: DigitalTeamWorkflowValidationIssue[] = [];
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const edge of definition.edges.filter((edge) => edge.target === id))
      if (!seen.has(edge.source)) {
        seen.add(edge.source);
        ancestors(edge.source, seen);
      }
    return seen;
  };
  const schemaValid = (schema: unknown, depth = 0): boolean => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 16) return false;
    const s = schema as WorkflowValueSchema;
    return (
      Object.keys(s).every((key) => ['type', 'properties', 'required', 'items', 'enum'].includes(key)) &&
      ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(s.type) &&
      (!s.required || (Array.isArray(s.required) && s.required.every((key) => typeof key === 'string'))) &&
      (!s.properties || (typeof s.properties === 'object' && !Array.isArray(s.properties) && Object.values(s.properties).every((child) => schemaValid(child, depth + 1)))) &&
      (!s.items || schemaValid(s.items, depth + 1)) &&
      (!s.enum || Array.isArray(s.enum))
    );
  };
  /** 已声明输出契约中的字段必须能在保存时定位，运行时仍核对实际值。 */
  const schemaField = (schema: WorkflowValueSchema, path: string): WorkflowValueSchema | undefined => {
    let current: WorkflowValueSchema | undefined = schema;
    for (const key of path ? path.split('.') : []) current = current?.type === 'array' && /^\d+$/.test(key) ? current.items : current?.properties?.[key];
    return current;
  };
  for (const node of definition.nodes) {
    const add = (message: string): void => {
      issues.push({ code: 'ZEUS_WORKFLOW_CONFIGURATION_INVALID', nodeId: node.id, message });
    };
    const data = node.data as WorkflowDataContract;
    if (data.outputSchema && !schemaValid(data.outputSchema)) add('输出契约包含不受支持的类型或结构。');
    if (data.inputs && (typeof data.inputs !== 'object' || Array.isArray(data.inputs) || Object.keys(data.inputs).length > 64)) {
      add('输入绑定最多支持六十四个字段。');
      continue;
    }
    for (const [key, binding] of Object.entries(data.inputs ?? {})) {
      if (!key || ['__proto__', 'constructor', 'prototype'].includes(key) || !binding || !['literal', 'task', 'node', 'artifact'].includes(binding.source)) {
        add(`输入 ${key} 的绑定无效。`);
        continue;
      }
      if (binding.parseError) add(`输入 ${key} 的 JSON 格式无效。`);
      if (binding.source === 'literal' && (!Object.hasOwn(binding, 'value') || binding.value === undefined)) add(`输入 ${key} 缺少常量值。`);
      if (binding.source === 'node' && !ancestors(node.id).has(binding.nodeId)) add(`输入 ${key} 必须引用实际的上游节点。`);
      if (binding.source === 'node') {
        const sourceSchema = (definition.nodes.find((source) => source.id === binding.nodeId)?.data as WorkflowDataContract | undefined)?.outputSchema;
        if (sourceSchema && schemaValid(sourceSchema) && !schemaField(sourceSchema, binding.path)) add(`输入 ${key} 的字段未在上游输出契约中声明。`);
      }
      if (
        (binding.source === 'task' || binding.source === 'node') &&
        (typeof binding.path !== 'string' || binding.path.split('.').some((part) => part && (!/^[A-Za-z0-9_-]+$/.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))))
      )
        add(`输入 ${key} 的字段路径无效。`);
      if (binding.source === 'artifact' && (!binding.id || !/^[a-f0-9]{64}$/.test(binding.sha256))) add(`输入 ${key} 的成果引用缺少固定身份或摘要。`);
    }
    if (node.type === 'invoke') {
      const cap = node.data.capability;
      if (!cap || !['tool', 'workflow', 'transform'].includes(cap.kind)) add('请选择可调用能力。');
      else if (cap.kind === 'workflow' && (!cap.templateId || !Number.isSafeInteger(cap.templateRevision) || cap.templateRevision < 1)) add('子流程需要固定模板及修订。');
      else if (cap.kind === 'tool' && (!cap.reference?.conversationId || !cap.reference.tool || !cap.reference.tool.name || !cap.reference.tool.definitionSha256 || !cap.reference.tool.pluginRevisionId))
        add('工具需要来自当前目录的完整身份、修订和定义摘要。');
    }
    if (
      node.type === 'await' &&
      (!['human', 'event', 'timer'].includes(node.data.mode) ||
        !Number.isSafeInteger(node.data.timeoutMs) ||
        node.data.timeoutMs < 1 ||
        node.data.timeoutMs > 31_536_000_000 ||
        !['fail', 'continue'].includes(node.data.onTimeout) ||
        !Array.isArray(node.data.actorIds) ||
        (node.data.mode !== 'timer' && !node.data.actorIds.length) ||
        node.data.actorIds.some((id) => typeof id !== 'string' || !id.trim()) ||
        (node.data.mode === 'event' && !node.data.eventKey))
    )
      add('等待需要明确来源、授权回应者、关联身份和有效期限。');
    if (node.type === 'route') {
      const targets = new Set(definition.edges.filter((edge) => edge.source === node.id).map((edge) => edge.target));
      if (!Array.isArray(node.data.cases) || node.data.cases.length > 32 || (!node.data.cases.length && !node.data.defaultTargetId)) add('请配置分支规则或默认出口。');
      else
        for (const rule of node.data.cases)
          if (
            !rule ||
            typeof rule !== 'object' ||
            rule.parseError ||
            typeof rule.field !== 'string' ||
            !rule.field ||
            !['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists'].includes(rule.operator) ||
            !targets.has(rule.targetId) ||
            (rule.operator !== 'exists' && !Object.hasOwn(rule, 'value')) ||
            (['gt', 'gte', 'lt', 'lte'].includes(rule.operator) && typeof rule.value !== 'number')
          )
            add('每条分支规则必须使用结构化字段并连接到实际出口。');
      if (node.data.defaultTargetId && !targets.has(node.data.defaultTargetId)) add('默认出口必须连接到实际下游。');
    }
  }
  return issues;
}

/** 判断本次冻结图是否由 LangGraph 推进，旧运行继续使用原协调器。 */
export function usesWorkflowPrimitives(definition: DigitalTeamWorkflowDefinition): boolean {
  return definition.engine === 'langgraph' || definition.nodes.some((node: DigitalTeamNode) => ['invoke', 'await', 'route', 'join'].includes(node.type));
}
