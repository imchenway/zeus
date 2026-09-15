import { asyncMessageQuestions } from '@zeus/shared';
import type {
  ConversationGoalRepository,
  ConversationGoalStatus,
  ConversationPlanActionRepository,
  ConversationProviderItemRepository,
  ConversationRepository,
  ConversationRuntimeRepository,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  ZeusDatabase,
} from '@zeus/storage';

/** Pi 使用 Zeus 的目标与提交记录，模型回合结束只触发检查，不代表目标完成。 */
export function createPiGoalApplication(options: {
  db: ZeusDatabase;
  goals: ConversationGoalRepository;
  controls: ConversationRuntimeRepository;
  conversations: ConversationRepository;
  submissions: ConversationSubmissionRepository;
  turns: ConversationTurnRepository;
  requests: ConversationServerRequestRepository;
  plans: ConversationPlanActionRepository;
  items: ConversationProviderItemRepository;
  enqueue(input: { conversationId: string; sourceTurnId: string | null; prompt: string; source: 'goal' }): Promise<void>;
  publish(conversationId: string): void;
  now(): string;
}) {
  /** 所有入口只接受当前 Pi 会话，交接状态不能隐式取得控制权。 */
  function requireConversation(conversationId: string) {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation || conversation.agentKind !== 'pi' || conversation.archived || !conversation.nativeSessionId) throw new Error('当前 Pi 会话未就绪或已归档。');
    return conversation;
  }

  /** 保留已知用量合计，缺失时另外标记，不冒充精确消耗。 */
  async function readGoal(input: { conversationId: string }) {
    const goal = options.goals.get(input.conversationId);
    return goal ? { ...goal, usageComplete: options.controls.getGoalControl(input.conversationId)?.usageComplete ?? false } : null;
  }

  /** 只由显式目标操作调用；普通提交不会建立目标。 */
  async function setGoal(input: { conversationId: string; objective: string; tokenBudget?: number }) {
    const conversation = requireConversation(input.conversationId);
    const objective = input.objective.trim();
    if (!objective || [...objective].length > 4000) throw new Error('目标必须为 1 到 4000 个字符。');
    if (input.tokenBudget !== undefined && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)) throw new Error('目标预算必须是正整数。');
    const previous = options.goals.get(conversation.id);
    /** 已完成目标之后建立新目标，重新计量；编辑未完成目标保留已有消耗。 */
    const continuing = previous && previous.status !== 'complete' ? previous : null;
    const now = options.now();
    const ticks = Date.parse(now) / 1000;
    const goal = options.goals.upsert(
      {
        conversationId: conversation.id,
        providerThreadId: conversation.nativeSessionId!,
        objective,
        status: 'active',
        tokenBudget: input.tokenBudget ?? continuing?.tokenBudget ?? null,
        tokensUsed: continuing?.tokensUsed ?? 0,
        timeUsedSeconds: continuing?.timeUsedSeconds ?? 0,
        providerCreatedAt: continuing?.providerCreatedAt ?? ticks,
        providerUpdatedAt: Math.max(ticks, previous?.providerUpdatedAt ?? 0),
      },
      { eventKind: previous ? 'edited' : 'created', occurredAt: now },
    );
    options.controls.setGoalControl({
      conversationId: conversation.id,
      source: 'pi',
      nativeSessionId: conversation.nativeSessionId!,
      resumeAfterSwitch: false,
      usageComplete: continuing ? (options.controls.getGoalControl(conversation.id)?.usageComplete ?? false) : true,
      accountedTurnId: options.controls.getGoalControl(conversation.id)?.accountedTurnId ?? null,
    });
    await options.db.save();
    options.publish(conversation.id);
    return goal;
  }

  /** 暂停时取消尚未发送的目标续跑，已经接纳的原轮次不被重放。 */
  async function updateStatus(conversationId: string, status: ConversationGoalStatus) {
    requireConversation(conversationId);
    const goal = options.goals.get(conversationId);
    if (!goal) throw new Error('此会话尚未建立目标。');
    const timestamp = options.now();
    const updated = options.goals.upsert(
      { ...goal, status, providerUpdatedAt: Math.max(Date.parse(timestamp) / 1000, goal.providerUpdatedAt) },
      {
        eventKind: status === 'active' ? 'resumed' : status === 'complete' ? 'completed' : status === 'blocked' ? 'blocked' : status === 'budgetLimited' ? 'budget_limited' : status === 'usageLimited' ? 'usage_limited' : 'paused',
        occurredAt: timestamp,
      },
    );
    if (status !== 'active') {
      for (const submission of options.submissions.listQueueByConversation(conversationId)) {
        if (submission.idempotencyKey.startsWith('goal-continuation-') && !submission.providerTurnId && submission.status === 'queued')
          options.submissions.updateStatus(submission.id, 'cancelled', { resolvedAt: timestamp, updatedAt: timestamp });
      }
    }
    await options.db.save();
    options.publish(conversationId);
    return updated;
  }

  /** 只有当前控制权、没有未答问题或审批、且没有其他排队输入时才自动续跑。 */
  async function advance(conversationId: string, sourceTurnId: string | null): Promise<void> {
    const conversation = options.conversations.getById(conversationId);
    const goal = options.goals.get(conversationId);
    const control = options.controls.getGoalControl(conversationId);
    if (!conversation || conversation.archived || conversation.agentKind !== 'pi' || goal?.status !== 'active' || control?.source !== 'pi' || control.nativeSessionId !== conversation.nativeSessionId) return;
    if (options.turns.getLatestActiveByConversation(conversationId)) return;
    const submissions = options.submissions.listByConversation(conversationId);
    const answered = new Set(
      submissions
        .filter((submission) => !['deleted', 'cancelled', 'failed'].includes(submission.status))
        .flatMap((submission) => {
          const input = JSON.parse(submission.inputJson);
          return input.questionAnswer?.providerItemId ? [input.questionAnswer.providerItemId] : [];
        }),
    );
    const unanswered = options.items.listByConversation(conversationId).some((item) => item.itemType === 'agentMessage' && asyncMessageQuestions(JSON.parse(item.payloadJson)).length > 0 && !answered.has(item.providerItemId));
    if (unanswered || options.requests.listPendingByConversation(conversationId).length || options.plans.getLatestPending(conversationId)) {
      await updateStatus(conversationId, 'paused');
      return;
    }
    if (goal.tokenBudget !== null && !control.usageComplete) {
      await updateStatus(conversationId, 'usageLimited');
      return;
    }
    if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
      await updateStatus(conversationId, 'budgetLimited');
      return;
    }
    if (submissions.some((submission) => ['queued', 'dispatching', 'active', 'paused'].includes(submission.status))) return;
    await options.enqueue({
      conversationId,
      sourceTurnId,
      source: 'goal',
      prompt: `继续推进用户明确建立的目标：${goal.objective}\n当前目标仍为 active；一次回复结束不代表目标完成。完成后用 update_goal 明确提交完成；遇到需要用户回答、审批或明确阻塞时暂停。${goal.tokenBudget === null ? '' : `\n目标 Token 预算 ${goal.tokenBudget}，已知消耗 ${goal.tokensUsed}。`}`,
    });
  }

  /** 每个真实轮次只核算一次，缺失用量绝不填造精确值。 */
  async function settle(input: { conversationId: string; turnId: string; providerTurnId: string; tokensUsed: number; usageComplete: boolean; failed: boolean; interrupted: boolean; seconds: number }) {
    const goal = options.goals.get(input.conversationId);
    const control = options.controls.getGoalControl(input.conversationId);
    if (!goal || control?.source !== 'pi' || control.accountedTurnId === input.turnId) return;
    const timestamp = options.now();
    options.goals.upsert(
      { ...goal, tokensUsed: goal.tokensUsed + input.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, input.seconds), providerUpdatedAt: Math.max(Date.parse(timestamp) / 1000, goal.providerUpdatedAt) },
      { providerTurnId: input.providerTurnId, occurredAt: timestamp },
    );
    options.controls.setGoalControl({ ...control, accountedTurnId: input.turnId, usageComplete: control.usageComplete && input.usageComplete });
    await options.db.save();
    options.publish(input.conversationId);
    if (goal.status !== 'active') return;
    if (input.failed || input.interrupted) {
      await updateStatus(input.conversationId, 'paused');
      return;
    }
    await advance(input.conversationId, input.providerTurnId);
  }

  /** 新原生会话接管已确认交接的目标；普通恢复沿用原控制权。 */
  async function bind(conversationId: string, nativeSessionId: string): Promise<void> {
    const goal = options.goals.get(conversationId);
    const control = options.controls.getGoalControl(conversationId);
    if (!goal || control?.source !== 'handoff') return;
    const timestamp = options.now();
    options.goals.upsert(
      { ...goal, providerThreadId: nativeSessionId, status: control.resumeAfterSwitch ? 'active' : goal.status, providerUpdatedAt: Math.max(Date.parse(timestamp) / 1000, goal.providerUpdatedAt) },
      { occurredAt: timestamp },
    );
    options.controls.setGoalControl({ ...control, source: 'pi', nativeSessionId, resumeAfterSwitch: false });
    await options.db.save();
    options.publish(conversationId);
  }

  /** 清除目标仍保留既有时间线，不影响普通会话历史。 */
  async function clearGoal(input: { conversationId: string }) {
    const conversation = requireConversation(input.conversationId);
    if (options.goals.get(conversation.id)) await updateStatus(conversation.id, 'paused');
    const cleared = options.goals.clear({ conversationId: conversation.id, providerThreadId: conversation.nativeSessionId!, occurredAt: options.now() });
    await options.db.save();
    options.publish(conversation.id);
    return { cleared };
  }

  /** 宿主恢复时先核对上一轮；未知结果暂停，有完整空闲记录才继续推进。 */
  async function recover(): Promise<void> {
    for (const goal of options.goals.listActive()) {
      const conversation = options.conversations.getById(goal.conversationId);
      if (conversation?.agentKind !== 'pi' || conversation.archived) continue;
      if (options.turns.getLatestActiveByConversation(conversation.id) || options.submissions.listQueueByConversation(conversation.id).some((submission) => submission.status === 'paused')) await updateStatus(conversation.id, 'paused');
      else await advance(conversation.id, `recovery:${goal.providerUpdatedAt}`);
    }
  }

  return {
    recover,
    readGoal,
    setGoal,
    clearGoal,
    advance,
    settle,
    bind,
    updateStatus,
    pauseGoal: (input: { conversationId: string }) => updateStatus(input.conversationId, 'paused'),
    resumeGoal: async (input: { conversationId: string }) => {
      const goal = await updateStatus(input.conversationId, 'active');
      await advance(input.conversationId, `resume:${goal.providerUpdatedAt}`);
      // 预算或待答问题可能使恢复立即再次暂停，返回最新持久状态。
      return options.goals.get(input.conversationId) ?? goal;
    },
  };
}
