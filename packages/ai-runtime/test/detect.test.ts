import { describe, expect, it } from 'vitest';
import { detectAiCli } from '../src/index.js';

describe('AI CLI detection', () => {
  it('reports unavailable for missing commands instead of faking runtime output', async () => {
    const status = await detectAiCli({
      name: 'missing',
      command: 'zeus-definitely-missing-cli',
    });
    expect(status.available).toBe(false);
    expect(status.reason).toContain('未检测到');
  });
});
