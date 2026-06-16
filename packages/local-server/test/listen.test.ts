import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startZeusLocalServer } from '../src/index.js';

describe('Zeus local server listener', () => {
  it('listens on 127.0.0.1 with an ephemeral port and exposes dashboard facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-listener-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'listener-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      expect(running.host).toBe('127.0.0.1');
      expect(running.port).toBeGreaterThan(0);

      const response = await fetch(`${running.baseUrl}/api/dashboard`, {
        headers: { authorization: 'Bearer listener-token' },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.app).toBe('Zeus');
      expect(body.projects).toEqual([]);
      expect(typeof body.runtime.aiCli.available).toBe('boolean');
      expect(body.runtime.aiCli.reason.length).toBeGreaterThan(0);
      expect(body.git.isRepository).toBe(true);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
