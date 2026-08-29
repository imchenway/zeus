import { useRef } from 'react';
import type { ThreadFollowMode } from './sessionTypes.js';

export interface ThreadScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ThreadScrollState {
  mode: ThreadFollowMode;
  suppressBounceUntil: number;
}

export type ThreadScrollEffect = { type: 'none' } | { type: 'scroll_to_bottom' };

export interface ThreadScrollController {
  getState(): ThreadScrollState;
  onUserScroll(metrics: ThreadScrollMetrics): ThreadScrollState;
  onExplicitLatestRequest(): ThreadScrollEffect;
  onDelta(): ThreadScrollEffect;
  onMessageSubmitted(): ThreadScrollEffect;
  onTurnStarted(): ThreadScrollEffect;
}

const FOLLOW_DISTANCE_PX = 24;

export function createThreadScrollController(): ThreadScrollController {
  // 进入会话默认定位到最新内容；只有真实用户滚动离开底部后才切换为 static。
  let state: ThreadScrollState = { mode: 'user_follow', suppressBounceUntil: 0 };

  return {
    getState: () => state,
    onUserScroll(metrics) {
      state = {
        ...state,
        mode: distanceFromBottom(metrics) <= FOLLOW_DISTANCE_PX ? 'user_follow' : 'static',
      };
      return state;
    },
    onExplicitLatestRequest() {
      state = { mode: 'user_follow', suppressBounceUntil: 0 };
      return { type: 'scroll_to_bottom' };
    },
    onDelta() {
      if (state.mode === 'static') return { type: 'none' };
      return { type: 'scroll_to_bottom' };
    },
    onMessageSubmitted() {
      // 明确发送后进入最新内容跟随，不再为尚未出现的回复制造空白占位。
      state = { mode: 'user_follow', suppressBounceUntil: 0 };
      return { type: 'scroll_to_bottom' };
    },
    onTurnStarted() {
      // 新轮次不能按“离底部不远”抢走历史阅读位置；本地提交会先通过
      // onMessageSubmitted 明确恢复跟随，其他轮次只沿用当前状态。
      if (state.mode === 'static') return { type: 'none' };
      return { type: 'scroll_to_bottom' };
    },
  };
}

export function useThreadScrollController(): ThreadScrollController {
  const controller = useRef<ThreadScrollController | null>(null);
  controller.current ??= createThreadScrollController();
  return controller.current;
}

export type SessionEscapeLayer = 'mention' | 'template' | 'approval' | 'terminal';

export interface SessionEscapeInput {
  repeat: boolean;
  openLayers: readonly SessionEscapeLayer[];
  inputFocused: boolean;
  responding: boolean;
  activeTurnId: string | null;
  startedTurnId: string | null;
  now: number;
}

export type SessionEscapeResult =
  | { consumed: false; action: 'none' }
  | { consumed: true; action: 'close_mention' | 'close_template' | 'close_approval' | 'close_terminal' | 'await_turn_started' }
  | { consumed: true; action: 'confirm_interrupt'; confirmUntil: number }
  | { consumed: true; action: 'interrupt'; turnId: string };

export interface SessionEscapeController {
  handleEscape(input: SessionEscapeInput): SessionEscapeResult;
  reset(): void;
}

const INTERRUPT_CONFIRM_MS = 2_000;
const escapeLayerPriority: readonly SessionEscapeLayer[] = ['mention', 'template', 'approval', 'terminal'];

export function createSessionEscapeController(): SessionEscapeController {
  let armed: { turnId: string; until: number } | null = null;

  return {
    handleEscape(input) {
      if (input.repeat) return { consumed: false, action: 'none' };

      const openLayer = escapeLayerPriority.find((layer) => input.openLayers.includes(layer));
      if (openLayer) return { consumed: true, action: `close_${openLayer}` as const };

      if (!input.inputFocused || !input.responding || !input.activeTurnId) {
        armed = null;
        return { consumed: false, action: 'none' };
      }
      if (input.startedTurnId !== input.activeTurnId) return { consumed: true, action: 'await_turn_started' };

      if (armed?.turnId === input.activeTurnId && input.now <= armed.until) {
        const turnId = input.activeTurnId;
        armed = null;
        return { consumed: true, action: 'interrupt', turnId };
      }

      const confirmUntil = input.now + INTERRUPT_CONFIRM_MS;
      armed = { turnId: input.activeTurnId, until: confirmUntil };
      return { consumed: true, action: 'confirm_interrupt', confirmUntil };
    },
    reset() {
      armed = null;
    },
  };
}

function distanceFromBottom(metrics: ThreadScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}
