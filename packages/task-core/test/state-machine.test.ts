import { describe, expect, it } from 'vitest';
import { canTransitionTaskStatus, getNextTaskStatus } from '../src/index.js';

describe('Task state machine', () => {
  it('allows the normal ready to running to completed flow', () => {
    expect(canTransitionTaskStatus('ready', 'running')).toBe(true);
    expect(canTransitionTaskStatus('running', 'completed')).toBe(true);
  });

  it('blocks restarting a completed task without creating a retry transition', () => {
    expect(canTransitionTaskStatus('completed', 'running')).toBe(false);
  });

  it('returns the target status for valid transitions and throws for invalid transitions', () => {
    expect(getNextTaskStatus('running', 'paused')).toBe('paused');
    expect(() => getNextTaskStatus('completed', 'running')).toThrow('Invalid Zeus task transition');
  });
});
