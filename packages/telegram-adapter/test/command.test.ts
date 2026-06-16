import { describe, expect, it } from 'vitest';
import { getTelegramConfigurationState, parseTelegramCommand } from '../src/index.js';

describe('Telegram adapter', () => {
  it('reports unconfigured state without fake messages', () => {
    expect(getTelegramConfigurationState(undefined)).toEqual({
      enabled: false,
      reason: 'Telegram Bot Token 未配置。',
    });
  });

  it('parses supported commands', () => {
    expect(parseTelegramCommand('/tasks project_1')).toEqual({
      command: 'tasks',
      args: ['project_1'],
    });
    expect(parseTelegramCommand('/cancel confirmation_1')).toEqual({
      command: 'cancel',
      args: ['confirmation_1'],
    });
  });
});
