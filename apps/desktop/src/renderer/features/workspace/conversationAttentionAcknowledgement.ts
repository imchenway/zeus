/** 后台同步保留脱敏诊断；不借用明确操作失败的弹窗和失败状态。 */
export function recordConversationBackgroundSynchronizationError(action: string, message: string, code: string | null | undefined, context: Record<string, string | number> = {}): void {
  console.warn('后台同步暂时未完成，已保留当前内容。', {
    action,
    ...context,
    code,
    message,
    occurredAt: new Date().toISOString(),
  });
}

/** 后台提醒确认的一次请求；身份与版本固定到用户已看见的提醒。 */
export interface ConversationAttentionAcknowledgementAttempt {
  /** 项目与会话组成的稳定请求键。 */
  key: string;
  /** 用户实际看见的提醒修订。 */
  revision: number;
  /** 请求开始时已经成功校准的连接代次。 */
  reconciliation: number;
  /** 在途、已确认和等待下次成功校准的请求状态。 */
  status: 'pending' | 'succeeded' | 'failed' | 'rejected';
}

/** 去重后台确认，只在真实快照读取成功后放行失败重试。 */
export function createConversationAttentionAcknowledgementCoordinator() {
  /** 每个会话只保留最近一次确认，避免重复渲染同时提交。 */
  const attempts = new Map<string, ConversationAttentionAcknowledgementAttempt>();
  /** 只有实际读取成功才推进，失败回调本身不推进重试。 */
  let reconciliation = 0;
  return {
    /** 建立固定版本的请求；同版本成功结果和本代次失败均不重复提交。 */
    begin(projectId: string, conversationId: string, revision: number): ConversationAttentionAcknowledgementAttempt | null {
      /** 以结构化身份区分项目和会话，避免分隔符碰撞。 */
      const key = JSON.stringify([projectId, conversationId]);
      /** 已在途的旧版本先完成，新版本随后从当前可见会话读取。 */
      const previous = attempts.get(key);
      if (previous?.status === 'pending') return null;
      if (previous && revision < previous.revision) return null;
      if (previous?.revision === revision && (previous.status !== 'failed' || previous.reconciliation === reconciliation)) return null;
      /** 此次请求在提交期间不随实时事件改写版本。 */
      const attempt: ConversationAttentionAcknowledgementAttempt = { key, revision, reconciliation, status: 'pending' };
      attempts.set(key, attempt);
      return attempt;
    },
    /** 实际校准成功后允许失败请求重试，成功确认和明确拒绝不会自动重发。 */
    reconciled(): boolean {
      reconciliation += 1;
      return [...attempts.values()].some((attempt) => attempt.status === 'failed');
    },
    /** 始终释放在途状态；读取恢复先于失败回执时补触发一次同步。 */
    settle(attempt: ConversationAttentionAcknowledgementAttempt, status: Exclude<ConversationAttentionAcknowledgementAttempt['status'], 'pending'>): boolean {
      if (attempts.get(attempt.key) !== attempt) return false;
      attempt.status = status;
      return status === 'failed' && attempt.reconciliation < reconciliation;
    },
  };
}
