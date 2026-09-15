/** 服务端数字团队 task_push 策略的不可序列化属性键。 */
const digitalTeamTaskPushPolicyKey = Symbol('digitalTeamTaskPushPolicy');

/** 数字团队节点经冻结授权计算后的 Provider 能力。 */
export interface DigitalTeamTaskPushPolicy {
  /** 节点职责决定是否可能写入。 */
  purpose: 'plan' | 'work' | 'verify' | 'summary';
  /** 是否允许修改源码。 */
  allowCodeChanges: boolean;
  /** 是否允许运行测试。 */
  allowTests: boolean;
  /** 是否允许在隔离工作区本地提交。 */
  allowGitCommit: boolean;
}

/** 给内部 task_push 请求附加客户端 JSON 无法伪造的冻结策略。 */
export function attachDigitalTeamTaskPushPolicy(body: Record<string, unknown>, policy: DigitalTeamTaskPushPolicy): void {
  Object.defineProperty(body, digitalTeamTaskPushPolicyKey, { value: Object.freeze({ ...policy }), enumerable: false, configurable: false, writable: false });
}

/** 从内部请求读取数字团队冻结策略。 */
export function readDigitalTeamTaskPushPolicy(body: object): DigitalTeamTaskPushPolicy | null {
  return (body as { [digitalTeamTaskPushPolicyKey]?: DigitalTeamTaskPushPolicy })[digitalTeamTaskPushPolicyKey] ?? null;
}
