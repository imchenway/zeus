import { createHash } from 'node:crypto';
import type { CodexAppServerManager, CodexThreadGoal } from '@zeus/ai-runtime';
import type { ConversationGoalRepository, ZeusConversationGoalRecord } from '@zeus/storage';
import type { CodexProviderCommandApplicationService } from './codexProviderCommandApplication.js';

interface CodexGoalApplicationOptions {
  manager: Pick<CodexAppServerManager, 'clearThreadGoal' | 'generationForThread' | 'readThreadGoal' | 'setThreadGoal'>;
  goals: ConversationGoalRepository;
  providerCommands: CodexProviderCommandApplicationService;
  prepareConversation(conversationId: string): Promise<{ threadId: string }>;
  projectGoal(conversationId: string, goal: CodexThreadGoal, providerTurnId: string | null, occurredAt: string): ZeusConversationGoalRecord;
  persist(): Promise<void>;
  broadcast(event: string, payload: unknown): void;
  now(): string;
}

/** Codex 原生目标命令的应用边界；读取保持只读，写入统一形成 provider_session 回执。 */
export function createCodexGoalApplication(options: CodexGoalApplicationOptions) {
  const execute = <T>(input: {
    operation: 'goal_set' | 'goal_clear';
    conversationId: string;
    threadId: string;
    commandKey: string;
    requestIdentity: unknown;
    invoke(traceIdentity: string | null): Promise<T>;
    mutateBusinessState?(result: T): void;
  }) =>
    options.providerCommands.executeSession({
      ...input,
      scope: { kind: 'product_conversation', id: input.conversationId },
      idempotencyKey: input.commandKey,
      issuedAt: options.now(),
      resourceId: input.conversationId,
      providerGenerationId: options.manager.generationForThread(input.threadId),
      nativeSessionId: () => input.threadId,
    });

  async function setGoal(input: { conversationId: string; objective: string }) {
    const objective = input.objective.trim();
    if (!objective || [...objective].length > 4_000) throw goalError('ZEUS_CODEX_GOAL_OBJECTIVE_INVALID', '目标必须为 1 到 4000 个字符。');
    const { threadId } = await options.prepareConversation(input.conversationId);
    const current = options.goals.get(input.conversationId) ?? (await options.manager.readThreadGoal({ threadId }).then((goal) => (goal ? options.projectGoal(input.conversationId, goal, null, options.now()) : undefined)));
    let objectiveBaseRevision = current?.providerUpdatedAt ?? null;
    if (current?.status === 'active' && current.objective !== objective) {
      const paused = await execute({
        operation: 'goal_set',
        conversationId: input.conversationId,
        threadId,
        commandKey: `goal-pause-before-objective:${current.providerUpdatedAt}`,
        requestIdentity: { status: 'paused' },
        invoke: (traceIdentity) => options.manager.setThreadGoal({ threadId, status: 'paused', traceIdentity }),
      });
      options.projectGoal(input.conversationId, paused, null, options.now());
      objectiveBaseRevision = paused.updatedAt;
    }
    const goal = await execute({
      operation: 'goal_set',
      conversationId: input.conversationId,
      threadId,
      commandKey: `goal-objective:${sha256(JSON.stringify([objective, objectiveBaseRevision]))}`,
      requestIdentity: { objective, ...(current ? {} : { status: 'active' as const }) },
      invoke: (traceIdentity) => options.manager.setThreadGoal({ threadId, objective, ...(current ? {} : { status: 'active' as const }), traceIdentity }),
    });
    const projected = options.projectGoal(input.conversationId, goal, null, options.now());
    await options.persist();
    return projected;
  }

  async function readGoal(input: { conversationId: string }) {
    const { threadId } = await options.prepareConversation(input.conversationId);
    const goal = await options.manager.readThreadGoal({ threadId });
    if (!goal) {
      options.goals.clear({ conversationId: input.conversationId, providerThreadId: threadId, occurredAt: options.now() });
      await options.persist();
      return null;
    }
    const projected = options.projectGoal(input.conversationId, goal, null, options.now());
    await options.persist();
    return projected;
  }

  async function pauseGoal(input: { conversationId: string }) {
    return updateStatus(input.conversationId, 'paused');
  }

  async function resumeGoal(input: { conversationId: string }) {
    return updateStatus(input.conversationId, 'active');
  }

  async function updateStatus(conversationId: string, status: 'active' | 'paused') {
    const { threadId } = await options.prepareConversation(conversationId);
    const goal = await execute({
      operation: 'goal_set',
      conversationId,
      threadId,
      commandKey: `goal-${status === 'active' ? 'resume' : 'pause'}:${options.goals.get(conversationId)?.providerUpdatedAt ?? 'none'}`,
      requestIdentity: { status },
      invoke: (traceIdentity) => options.manager.setThreadGoal({ threadId, status, traceIdentity }),
    });
    const projected = options.projectGoal(conversationId, goal, null, options.now());
    await options.persist();
    return projected;
  }

  async function clearGoal(input: { conversationId: string }) {
    const { threadId } = await options.prepareConversation(input.conversationId);
    const result = await execute({
      operation: 'goal_clear',
      conversationId: input.conversationId,
      threadId,
      commandKey: `goal-clear:${options.goals.get(input.conversationId)?.providerUpdatedAt ?? 'none'}`,
      requestIdentity: { clear: true },
      invoke: (traceIdentity) => options.manager.clearThreadGoal({ threadId, traceIdentity }),
    });
    if (result.cleared) options.goals.clear({ conversationId: input.conversationId, providerThreadId: threadId, occurredAt: options.now() });
    await options.persist();
    options.broadcast('conversation.goal.cleared', { conversationId: input.conversationId, cleared: result.cleared, timeline: options.goals.listEvents(input.conversationId) });
    return result;
  }

  return { setGoal, readGoal, pauseGoal, resumeGoal, clearGoal };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function goalError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
