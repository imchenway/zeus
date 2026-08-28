import type { ConversationTurnRepository } from '@zeus/storage';

/** 恢复无法确认 Provider 状态时，把本机仍标记为活动的旧回合统一收口为中断。 */
export function interruptUnconfirmedConversationTurns(input: { conversationId: string; cause: unknown; interruptedAt: string; turns: ConversationTurnRepository }): void {
  const failure = {
    code: 'ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED',
    message: 'Zeus 重启后无法确认上一轮仍在运行，已将本地状态收口为中断。',
    cause: input.cause,
  };
  for (const turn of input.turns.listInProgress()) {
    if (turn.conversationId !== input.conversationId || (turn.status !== 'dispatching' && turn.status !== 'running' && turn.status !== 'waiting')) continue;
    input.turns.upsert({
      ...turn,
      status: 'interrupted',
      error: failure,
      completedAt: input.interruptedAt,
      updatedAt: input.interruptedAt,
    });
  }
}
