import { describe, expect, it } from 'vitest';
import { delimiter } from 'node:path';
import { expandCliSearchPath, detectAiCli } from '../src/index.js';

describe('AI CLI detection', () => {
  it('reports unavailable for missing commands instead of faking runtime output', async () => {
    const status = await detectAiCli({
      name: 'missing',
      command: 'zeus-definitely-missing-cli',
    });
    expect(status.available).toBe(false);
    expect(status.reason).toContain('未检测到');
  });

  it('adds common macOS user binary directories when Finder launches the app with a restricted PATH', () => {
    const expanded = expandCliSearchPath(['/usr/bin', '/bin', '/opt/homebrew/bin'].join(delimiter));
    const entries = expanded.split(delimiter);

    expect(entries).toContain('/usr/bin');
    expect(entries).toContain('/opt/homebrew/bin');
    expect(entries).toContain('/usr/local/bin');
    expect(entries.filter((entry) => entry === '/opt/homebrew/bin')).toHaveLength(1);
  });
});
