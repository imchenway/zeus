import { describe, expect, it } from 'vitest';
import { isTerminalTaskStatus, taskStatusOrder, ZeusEventKind } from '../src/index.js';

describe('Zeus shared contracts', () => {
  it('defines ordered task statuses without fake business records', () => {
    expect(taskStatusOrder).toEqual(['draft', 'ready', 'running', 'paused', 'waiting_confirmation', 'completed', 'failed', 'cancelled']);
  });

  it('classifies terminal task statuses', () => {
    expect(isTerminalTaskStatus('completed')).toBe(true);
    expect(isTerminalTaskStatus('failed')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isTerminalTaskStatus('running')).toBe(false);
  });

  it('names event kinds under the Zeus namespace', () => {
    expect(ZeusEventKind.TaskUpdated).toBe('zeus.task.updated');
    expect(ZeusEventKind.GraphGenerated).toBe('zeus.graph.generated');
  });
});
