/** 新规则只触发员工或项目流程；普通会话仅供历史记录读取。 */
export type AutomationActionKind = 'conversation' | 'employee_work' | 'project_task';

/** 冻结到自动化修订中的动作配置。 */
export interface AutomationActionConfig {
  /** 本次执行的业务入口。 */
  kind: AutomationActionKind;
  /** 全局员工或历史项目绑定身份；普通会话不需要员工。 */
  employeeId: string | null;
  /** 旧身份迁移按项目保留原绑定，仅内部迁移写入，普通保存不能指定。 */
  projectEmployeeIds?: Record<string, string>;
  /** 项目任务的目标策略，领取与新建不能相互替代。 */
  taskSelection?: 'specified' | 'event' | 'pool' | 'create';
  /** 指定已有任务，仅指定策略使用。 */
  taskId?: string | null;
  /** 项目任务或员工工作的名称。 */
  title?: string;
  /** 是否优先领取来源事件的任务。 */
  useEventTask?: boolean;
  /** 领取既有任务时使用规则自己的筛选，不读取隐藏员工配置。 */
  taskFilter?: {
    /** 可领取的任务状态。 */
    managementStatuses: string[];
    /** 可领取的任务类型。 */
    taskTypes: string[];
    /** 任务必须同时包含的标签。 */
    requiredTags: string[];
  };
}

/** 一次自动化触发可对应多份真实工作，所有引用终结后才能结算。 */
export interface AutomationExecutionReference {
  /** 真实业务运行的种类。 */
  kind: 'conversation' | 'task_work' | 'workflow' | 'legacy_employee' | 'task_plan';
  /** 真实会话、Task Work run、流程 run 或旧员工执行身份。 */
  id: string;
  /** 旧工作安排的准确代次，不能用后来重新安排的结果结算。 */
  generation?: number;
  /** 当前工作所属任务，普通会话可以没有。 */
  taskId?: string;
  /** 会话身份，用于回执对账和打开结果。 */
  conversationId?: string;
  /** 普通会话的提交身份，禁止用整条会话终态替代。 */
  submissionId?: string;
}

/** 逐目标冻结任务和员工，外部接纳与自动化记账中断时可按原身份对账。 */
export interface AutomationDispatchTarget {
  /** 用户项目或无项目工作的技术归属。 */
  projectId: string;
  /** 准备后冻结的任务，不在恢复时重新选择。 */
  taskId: string | null;
  /** 准备后冻结的项目员工绑定。 */
  employeeId: string | null;
  /** 业务接纳的稳定来源身份。 */
  sourceRef: string;
  /** 已接纳与明确跳过均为已处理，接纳中必须先对账。 */
  status: 'pending' | 'accepting' | 'accepted' | 'skipped';
  /** 该目标的真实执行引用。 */
  reference: AutomationExecutionReference | null;
  /** 无可领取对象或待核对原因。 */
  reason: string | null;
}

/** 运行读取保留暂停和未知状态，不把等待审批判为成功。 */
export interface AutomationExecutionState {
  /** 真实运行当前状态。 */
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
  /** 暂停仍是未结束的工作，不释放自动化串行队列。 */
  paused?: boolean;
  /** 原执行失败码。 */
  errorCode?: string | null;
  /** 原执行失败说明。 */
  errorMessage?: string | null;
}

/** 事件触发使用发生时的事实，不重新读取最新状态来替代。 */
export interface AutomationSourceEvent {
  /** 事件所属项目。 */
  projectId: string;
  /** 事件所属任务。 */
  taskId: string;
  /** 原事件业务类型。 */
  eventType: string;
  /** 原发生时间。 */
  occurredAt: string;
  /** 原事件 payload，包含前后状态与来源。 */
  payload: Record<string, unknown>;
}

/** 所有项目事件消费同一提取规则；只读原事件，不重新读取任务当前状态。 */
export function automationEventStatusId(payload: Record<string, unknown>, before: boolean): string | null {
  /** 新旧事件写入器的字段均表达发生时的状态，不改变事实来源。 */
  const value = before
    ? (payload.before ?? payload.fromStatus ?? payload.from ?? payload.previousStatusId ?? payload.previousManagementStatusId ?? payload.fromStatusId ?? payload.previousStatus)
    : (payload.after ?? payload.toStatus ?? payload.to ?? payload.statusId ?? payload.managementStatusId ?? payload.toStatusId ?? payload.status);
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    /** 某些事件保存状态前后快照，此时仍从原快照提取。 */
    const state = value as Record<string, unknown>;
    /** 优先使用项目管理状态，而非任务运行状态。 */
    const status = state.managementStatus ?? state.managementStatusId ?? state.statusId ?? state.status;
    return typeof status === 'string' ? status : null;
  }
  return null;
}
