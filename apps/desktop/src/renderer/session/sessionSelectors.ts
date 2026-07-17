import type { NativeSessionState } from './sessionTypes.js';

export interface SessionStatusSemantics {
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
  label: string;
}

export type SessionComposerAction = 'send' | 'stop' | 'queue' | 'respond' | 'retry' | 'readonly' | 'disabled';

export function selectSessionStatusSemantics(state: NativeSessionState): SessionStatusSemantics {
  if (state.error?.recoveryRequired) return { role: 'alert', ariaLive: 'assertive', label: state.error.message };
  switch (state.conversationState) {
    case 'legacy_readonly':
      return { role: 'status', ariaLive: 'polite', label: '此历史会话为只读' };
    case 'native_loading':
      return { role: 'status', ariaLive: 'polite', label: '正在加载会话' };
    case 'native_idle':
      return state.transportState === 'reconnecting' ? { role: 'status', ariaLive: 'polite', label: '正在重新连接 Codex' } : { role: 'status', ariaLive: 'polite', label: 'Codex 已就绪' };
    case 'starting_turn':
      return { role: 'status', ariaLive: 'polite', label: '正在开始新一轮对话' };
    case 'active_prework':
    case 'active_final_answer':
      return { role: 'status', ariaLive: 'polite', label: 'Codex 正在处理' };
    case 'waiting_approval':
      return { role: 'status', ariaLive: 'polite', label: 'Codex 正在等待审批' };
    case 'waiting_user_input':
      return { role: 'status', ariaLive: 'polite', label: 'Codex 正在等待你的回答' };
    case 'interrupt_confirm':
      return { role: 'status', ariaLive: 'polite', label: '再次按下 Escape 可停止当前响应' };
    case 'interrupting':
      return { role: 'status', ariaLive: 'polite', label: '正在停止当前响应' };
    case 'turn_failed':
      return { role: 'alert', ariaLive: 'assertive', label: state.error?.message ?? '本轮对话失败' };
  }
}

export function selectSessionComposerAction(state: NativeSessionState): SessionComposerAction {
  if (state.error?.recoveryRequired) return 'disabled';
  if (state.transportState === 'connecting' || state.transportState === 'hydrating' || state.transportState === 'failed') return 'disabled';
  switch (state.conversationState) {
    case 'legacy_readonly':
      return 'readonly';
    case 'native_loading':
    case 'starting_turn':
    case 'interrupt_confirm':
    case 'interrupting':
      return 'disabled';
    case 'active_prework':
    case 'active_final_answer':
      return state.draft.trim() || state.attachments.length > 0 ? 'queue' : 'stop';
    case 'waiting_approval':
    case 'waiting_user_input':
      return 'respond';
    case 'turn_failed':
      return state.error?.retryable ? 'retry' : 'disabled';
    case 'native_idle':
      return state.draft.trim() || state.attachments.length > 0 ? 'send' : 'disabled';
  }
}

export function selectSessionCapabilities(state: NativeSessionState): {
  canEditDraft: boolean;
  canSend: boolean;
  canInterrupt: boolean;
  canRespondToRequest: boolean;
  canManageQueue: boolean;
} {
  const native = state.snapshot?.transportKind === 'codex_native';
  const active = state.conversationState === 'active_prework' || state.conversationState === 'active_final_answer';
  return {
    canEditDraft: native && state.transportState !== 'failed' && state.conversationState !== 'legacy_readonly',
    canSend: native && state.transportState === 'ready' && (state.conversationState === 'native_idle' || active),
    canInterrupt: native && active && state.startedTurnId !== null && state.startedTurnId === state.activeTurnId,
    canRespondToRequest: native && (state.conversationState === 'waiting_approval' || state.conversationState === 'waiting_user_input'),
    canManageQueue: native && Boolean(state.queue?.submissions.length),
  };
}
