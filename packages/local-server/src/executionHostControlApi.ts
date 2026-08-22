import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AiRuntimeSessionManager, CodexAppServerManager } from '@zeus/ai-runtime';
import type { ExecutionHostStopActiveCommandRequest, ExecutionHostStopActiveFailure, ExecutionHostStopActiveResult } from '@zeus/shared';
import { ConversationGoalRepository, ConversationRepository, ConversationServerRequestRepository, ConversationSubmissionRepository, ConversationTurnRepository, ExecutionHostWorkRepository, type ZeusConversationRecord } from '@zeus/storage';
import type { CommandCenterController } from './commandCenter.js';
import { ExecutionHostStopCommandApplication, executionHostStopCommandHttpError, executionHostStopCommandPolicy, type ParsedExecutionHostStopActiveCommand } from './executionHostStopCommandApplication.js';

export interface ExecutionHostWorkStatusSnapshot {
  instanceId: string | null;
  protocolVersion: number;
  mode: 'embedded' | 'detached';
  pid: number;
  startedAt: string | null;
  transport: { state: 'idle' | 'starting' | 'ready' | 'restarting' | 'closed'; generationId: string | null };
  runtimeGenerations: Array<{
    generationId: string;
    state: 'idle' | 'starting' | 'ready' | 'restarting' | 'closed';
    active: boolean;
    activeThreadCount: number;
    pendingRequestCount: number;
  }>;
  activeTurnCount: number;
  effectfulTurnCount: number;
  waitingRequestCount: number;
  activeRuntimeCount: number;
  activeCommandRunCount: number;
  hasActiveWork: boolean;
  /** 只读验收副本里的历史活动行仅供诊断，绝不能被宿主监督当作当前进程所有权。 */
  copiedHistoryWork?: {
    activeTurnCount: number;
    effectfulTurnCount: number;
    waitingRequestCount: number;
    activeRuntimeCount: number;
    activeCommandRunCount: number;
    hasActiveWork: boolean;
  };
  observedAt: string;
}

interface ExecutionHostControlApiOptions {
  server: FastifyInstance;
  host?: { instanceId: string; protocolVersion: number; mode: 'embedded' | 'detached'; startedAt: string };
  work: ExecutionHostWorkRepository;
  codexManager: CodexAppServerManager;
  codexCoordinator: { pauseGoal(input: { conversationId: string }): Promise<unknown> };
  piCoordinator: { interruptTurn(input: { conversation: ZeusConversationRecord; providerTurnId: string }): Promise<unknown> };
  goals: ConversationGoalRepository;
  conversations: ConversationRepository;
  turns: ConversationTurnRepository;
  submissions: ConversationSubmissionRepository;
  requests: ConversationServerRequestRepository;
  commandCenter: Pick<CommandCenterController, 'stopActiveRuns'>;
  runtimeManager: Pick<AiRuntimeSessionManager, 'listSessions' | 'stopSession' | 'killSession'>;
  stopCommands: ExecutionHostStopCommandApplication;
  redactSensitiveText(value: string): { text: string };
  publish(type: string, payload: Record<string, unknown>): void;
  save(): Promise<void>;
  now(): Date;
  readOnlyValidation?: boolean;
}

/** Execution Host 状态与显式终止入口；常规升级 handoff 不经过 stop-active。 */
export function registerExecutionHostControlApi(options: ExecutionHostControlApiOptions): { readStatus(): ExecutionHostWorkStatusSnapshot } {
  const readStatus = (): ExecutionHostWorkStatusSnapshot => {
    const transport = options.codexManager.getState();
    // 正式历史副本可能尚未经历当前索引迁移；validation 世代不能写 schema，
    // 因此只在该明确边界使用无 index hint 的兼容读取。普通世代仍对缺索引失败关闭。
    const counts = options.readOnlyValidation ? options.work.readCountsForReadOnlyCompatibility() : options.work.readCounts();
    const copiedHistoryHasActiveWork = counts.activeSubmissionCount > 0 || counts.effectfulTurnCount > 0 || counts.pendingRequestCount > 0 || counts.activeRuntimeCount > 0 || counts.activeCommandRunCount > 0;
    const effectiveCounts = options.readOnlyValidation ? { activeSubmissionCount: 0, effectfulTurnCount: 0, pendingRequestCount: 0, activeRuntimeCount: 0, activeCommandRunCount: 0 } : counts;
    return {
      instanceId: options.host?.instanceId ?? null,
      protocolVersion: options.host?.protocolVersion ?? 1,
      mode: options.host?.mode ?? 'embedded',
      startedAt: options.host?.startedAt ?? null,
      pid: process.pid,
      transport: {
        state: transport.type,
        generationId: transport.type === 'idle' || transport.type === 'closed' ? null : transport.generationId,
      },
      runtimeGenerations: options.codexManager.listRuntimeGenerations().map((generation) => ({
        generationId: generation.generationId,
        state: generation.state,
        active: generation.active,
        activeThreadCount: generation.activeThreadCount,
        pendingRequestCount: generation.pendingRequestCount,
      })),
      activeTurnCount: effectiveCounts.activeSubmissionCount,
      effectfulTurnCount: effectiveCounts.effectfulTurnCount,
      waitingRequestCount: effectiveCounts.pendingRequestCount,
      activeRuntimeCount: effectiveCounts.activeRuntimeCount,
      activeCommandRunCount: effectiveCounts.activeCommandRunCount,
      hasActiveWork: effectiveCounts.activeSubmissionCount > 0 || effectiveCounts.effectfulTurnCount > 0 || effectiveCounts.pendingRequestCount > 0 || effectiveCounts.activeRuntimeCount > 0 || effectiveCounts.activeCommandRunCount > 0,
      ...(options.readOnlyValidation
        ? {
            copiedHistoryWork: {
              activeTurnCount: counts.activeSubmissionCount,
              effectfulTurnCount: counts.effectfulTurnCount,
              waitingRequestCount: counts.pendingRequestCount,
              activeRuntimeCount: counts.activeRuntimeCount,
              activeCommandRunCount: counts.activeCommandRunCount,
              hasActiveWork: copiedHistoryHasActiveWork,
            },
          }
        : {}),
      observedAt: options.now().toISOString(),
    };
  };

  options.server.get('/api/execution-host/status', async () => readStatus());
  options.server.post('/api/execution-host/stop-active', async (request: FastifyRequest<{ Body: ExecutionHostStopActiveCommandRequest }>, reply) => executeStopCommand(options, request.body, reply));
  return { readStatus };
}

async function executeStopCommand(options: ExecutionHostControlApiOptions, request: ExecutionHostStopActiveCommandRequest, reply: FastifyReply) {
  try {
    const parsed = options.stopCommands.parse(request);
    let plan: StopActiveWorkPlan | undefined;
    return await options.stopCommands.execute({
      parsed,
      beforeWrite: async () => {
        plan = prepareStopActiveWork(options, parsed);
      },
      invoke: () => stopActiveWork(options, requirePreparedPlan(plan)),
    });
  } catch (error) {
    const failure = executionHostStopCommandHttpError(error);
    if (!failure) throw error;
    return reply.code(failure.statusCode).send(failure.payload);
  }
}

interface StopActiveWorkPlan {
  parsed: ParsedExecutionHostStopActiveCommand;
  activeGoals: ReturnType<ConversationGoalRepository['listActive']>;
  recoverableSubmissions: ReturnType<ConversationSubmissionRepository['listRecoverable']>;
  inProgressTurns: ReturnType<ConversationTurnRepository['listInProgress']>;
  pendingRequests: ReturnType<ConversationServerRequestRepository['listPending']>;
  activeRuntimeSessions: ReturnType<AiRuntimeSessionManager['listSessions']>;
  providerInterrupts: Array<{
    conversationId: string;
    providerTurnId: string;
    invoke(): Promise<unknown>;
  }>;
}

function prepareStopActiveWork(options: ExecutionHostControlApiOptions, parsed: ParsedExecutionHostStopActiveCommand): StopActiveWorkPlan {
  const recoverableSubmissions = options.submissions.listRecoverable();
  const requestedTurns = new Set<string>();
  const providerInterrupts: StopActiveWorkPlan['providerInterrupts'] = [];
  for (const submission of recoverableSubmissions) {
    if ((submission.status !== 'dispatching' && submission.status !== 'active') || !submission.providerTurnId) continue;
    const providerTurnId = submission.providerTurnId;
    const identity = `${submission.conversationId}\0${providerTurnId}`;
    if (requestedTurns.has(identity)) continue;
    requestedTurns.add(identity);
    const conversation = options.conversations.getById(submission.conversationId);
    providerInterrupts.push({
      conversationId: submission.conversationId,
      providerTurnId,
      invoke: () => {
        if (!conversation) return Promise.reject(new Error('活动轮次缺少本机会话身份。'));
        if (conversation.agentKind === 'pi') return options.piCoordinator.interruptTurn({ conversation, providerTurnId });
        if (!conversation.providerThreadId) return Promise.reject(new Error('活动轮次缺少 Provider 会话身份。'));
        return options.codexManager.interruptTurn({ threadId: conversation.providerThreadId, turnId: providerTurnId });
      },
    });
  }
  return {
    parsed,
    activeGoals: options.goals.listActive(),
    recoverableSubmissions,
    inProgressTurns: options.turns.listInProgress(),
    pendingRequests: options.requests.listPending(),
    activeRuntimeSessions: options.runtimeManager.listSessions().filter((session) => session.status === 'running'),
    providerInterrupts,
  };
}

function requirePreparedPlan(plan: StopActiveWorkPlan | undefined): StopActiveWorkPlan {
  if (!plan) throw new Error('Execution Host stop command reached write phase without a prepared plan.');
  return plan;
}

async function stopActiveWork(options: ExecutionHostControlApiOptions, plan: StopActiveWorkPlan): Promise<ExecutionHostStopActiveResult> {
  const requestedAt = options.now().toISOString();
  const [goalPauseResults, interruptResults] = await Promise.all([
    Promise.allSettled(plan.activeGoals.map((goal) => options.codexCoordinator.pauseGoal({ conversationId: goal.conversationId }))),
    Promise.allSettled(plan.providerInterrupts.map((interrupt) => interrupt.invoke())),
  ]);

  let failedGoalPauseCount = 0;
  goalPauseResults.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    failedGoalPauseCount += 1;
    const goal = plan.activeGoals[index]!;
    options.publish('conversation.goal.pause_failed', {
      conversationId: goal.conversationId,
      message: boundedPublicMessage(result.reason, options.redactSensitiveText, 512),
    });
  });

  let providerInterruptFailureCount = 0;
  const failedTurns: ExecutionHostStopActiveFailure[] = [];
  interruptResults.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    providerInterruptFailureCount += 1;
    const interrupt = plan.providerInterrupts[index]!;
    if (failedTurns.length < executionHostStopCommandPolicy.failedTurnMaximumEntries) {
      failedTurns.push({
        conversationId: interrupt.conversationId,
        providerTurnId: interrupt.providerTurnId,
        message: boundedPublicMessage(result.reason, options.redactSensitiveText, executionHostStopCommandPolicy.failedTurnMessageMaximumBytes),
      });
    }
    options.publish('execution_host.stop_interrupt_failed', {
      conversationId: interrupt.conversationId,
      providerTurnId: interrupt.providerTurnId,
      message: boundedPublicMessage(result.reason, options.redactSensitiveText, 512),
    });
  });

  const forcedExitError = {
    code: 'ZEUS_FORCED_QUIT_INTERRUPTED',
    message: '用户停止活动工作并退出 Zeus。',
    providerOutcomeUnconfirmed: true,
    stopCommandId: plan.parsed.command.commandId,
  };
  const interruptedConversationIds = new Set<string>();
  for (const turn of plan.inProgressTurns) {
    options.turns.upsert({ ...turn, status: 'interrupted', error: forcedExitError, completedAt: requestedAt, updatedAt: requestedAt });
    interruptedConversationIds.add(turn.conversationId);
  }
  for (const submission of plan.recoverableSubmissions) {
    options.submissions.updateStatus(submission.id, 'cancelled', {
      providerTurnId: submission.providerTurnId,
      error: forcedExitError,
      resolvedAt: requestedAt,
      updatedAt: requestedAt,
    });
    interruptedConversationIds.add(submission.conversationId);
  }
  for (const request of plan.pendingRequests) options.requests.fail(request.id, { error: forcedExitError, resolvedAt: requestedAt });
  for (const conversationId of interruptedConversationIds) options.conversations.updateAgentRuntime(conversationId, { providerState: 'ready', status: 'open' });

  const stoppedCommandRunCount = options.commandCenter.stopActiveRuns('用户停止活动工作并退出 Zeus');
  for (const session of plan.activeRuntimeSessions) {
    options.runtimeManager.stopSession(session.id);
    options.runtimeManager.killSession(session.id, 'SIGKILL');
  }
  await options.save();
  return {
    requestedTurnCount: plan.providerInterrupts.length,
    providerInterruptFailureCount,
    closedSubmissionCount: plan.recoverableSubmissions.length,
    failedRequestCount: plan.pendingRequests.length,
    stoppedRuntimeCount: plan.activeRuntimeSessions.length,
    stoppedCommandRunCount,
    failedGoalPauseCount,
    failedTurns,
    providerOutcomeUnconfirmed: true,
    requestedAt,
  };
}

function boundedPublicMessage(error: unknown, redactSensitiveText: (value: string) => { text: string }, maximumBytes: number): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactSensitiveText(raw).text;
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= maximumBytes) return redacted;
  return `${bytes
    .subarray(0, Math.max(0, maximumBytes - 3))
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}
