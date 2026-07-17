import { describe, expect, it } from 'vitest';
import { createSessionEscapeController, createThreadScrollController } from '../src/renderer/session/useThreadScrollController.js';

const viewport = (distanceFromBottom: number, clientHeight = 600) => ({ scrollTop: 1_000 - clientHeight - distanceFromBottom, scrollHeight: 1_000, clientHeight });

describe('thread scroll controller', () => {
  it('follows only within 24px and never lets later deltas steal a user-scrolled thread', () => {
    const controller = createThreadScrollController();
    controller.onUserScroll(viewport(24));
    expect(controller.getState().mode).toBe('user_follow');
    expect(controller.onDelta(viewport(24), 1_000)).toEqual({ type: 'scroll_to_bottom' });

    controller.onUserScroll(viewport(25));
    expect(controller.getState().mode).toBe('static');
    expect(controller.onDelta(viewport(0), 2_000)).toEqual({ type: 'none' });
  });

  it('positions a new turn only within 300px with a two-thirds spacer and suppresses bounce for 500ms', () => {
    const controller = createThreadScrollController();
    expect(controller.onTurnStarted(viewport(300, 600), 1_000)).toEqual({ type: 'position_new_turn', spacerHeight: 400 });
    expect(controller.getState()).toMatchObject({ mode: 'prework_watch', suppressBounceUntil: 1_500 });
    expect(controller.onDelta(viewport(0, 600), 1_499)).toEqual({ type: 'none' });
    expect(controller.onDelta(viewport(0, 600), 1_500)).toEqual({ type: 'scroll_to_bottom' });
    expect(controller.getState().mode).toBe('prework_follow');

    const compact = createThreadScrollController();
    expect(compact.onTurnStarted(viewport(300, 300), 2_000)).toEqual({ type: 'position_new_turn', spacerHeight: 240 });
    const far = createThreadScrollController();
    expect(far.onTurnStarted(viewport(301), 2_000)).toEqual({ type: 'none' });
    expect(far.getState().mode).toBe('static');
  });
});

describe('session Escape controller', () => {
  it('consumes overlays before the composer interrupt flow and ignores key repeat', () => {
    const controller = createSessionEscapeController();
    expect(controller.handleEscape({ repeat: false, openLayers: ['terminal', 'approval', 'template', 'mention'], inputFocused: true, responding: true, activeTurnId: 'turn-1', startedTurnId: 'turn-1', now: 1_000 })).toEqual({
      consumed: true,
      action: 'close_mention',
    });
    expect(controller.handleEscape({ repeat: true, openLayers: [], inputFocused: true, responding: true, activeTurnId: 'turn-1', startedTurnId: 'turn-1', now: 1_100 })).toEqual({ consumed: false, action: 'none' });
  });

  it('requires matching turn started and a second non-repeat Escape within 2000ms before interrupt', () => {
    const controller = createSessionEscapeController();
    const base = { repeat: false, openLayers: [] as const, inputFocused: true, responding: true, activeTurnId: 'turn-1' };
    expect(controller.handleEscape({ ...base, startedTurnId: null, now: 1_000 })).toEqual({ consumed: true, action: 'await_turn_started' });
    expect(controller.handleEscape({ ...base, startedTurnId: 'turn-1', now: 1_100 })).toEqual({ consumed: true, action: 'confirm_interrupt', confirmUntil: 3_100 });
    expect(controller.handleEscape({ ...base, startedTurnId: 'turn-other', now: 1_200 })).toEqual({ consumed: true, action: 'await_turn_started' });
    expect(controller.handleEscape({ ...base, startedTurnId: 'turn-1', now: 2_000 })).toEqual({ consumed: true, action: 'interrupt', turnId: 'turn-1' });
    expect(controller.handleEscape({ ...base, startedTurnId: 'turn-1', now: 5_000 })).toEqual({ consumed: true, action: 'confirm_interrupt', confirmUntil: 7_000 });
  });
});
