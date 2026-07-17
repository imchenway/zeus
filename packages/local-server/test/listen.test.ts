import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerManager } from '@zeus/ai-runtime';
import { createCodexNativeConversationCoordinator } from '../src/codexNativeConversationCoordinator.js';
import { hasCodexFinalizationOwnershipClaim, startZeusLocalServer } from '../src/index.js';

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

  it('marks listen rejection after final coordinator shutdown was attempted without taking an external manager', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-listener-failure-'));
    const unsubscribe = vi.fn();
    const manager = {
      subscribe: vi.fn(() => unsubscribe),
      getState: vi.fn(() => ({ type: 'idle' })),
      prepareForShutdown: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as CodexAppServerManager;
    const listenCause = new Error('port unavailable');
    const listenError = Object.assign(new Error('listen failed', { cause: listenCause }), { code: 'EADDRINUSE' });
    const closeModes: Array<{ mode: 'handoff' | 'final' } | undefined> = [];
    const coordinatorFactory = vi.fn((options: Parameters<typeof createCodexNativeConversationCoordinator>[0]) => {
      const runtime = createCodexNativeConversationCoordinator(options);
      return {
        ...runtime,
        close: vi.fn(async (input?: { mode: 'handoff' | 'final' }) => {
          closeModes.push(input);
          await runtime.close(input);
        }),
      };
    });
    try {
      let running: Awaited<ReturnType<typeof startZeusLocalServer>> | undefined;
      let failure: unknown;
      try {
        running = await startZeusLocalServer(
          {
            dbPath: join(dir, 'zeus.db'),
            apiToken: 'listener-token',
            projectRoot: dir,
            codexNativeEnabled: false,
            codexAppServerManager: manager,
            codexNativeCoordinatorFactory: coordinatorFactory,
          },
          { listen: vi.fn().mockRejectedValue(listenError) },
        );
      } catch (error) {
        failure = error;
      }
      await running?.close();

      expect(failure).toBe(listenError);
      expect(hasCodexFinalizationOwnershipClaim(failure)).toBe(true);
      expect((failure as typeof listenError).code).toBe('EADDRINUSE');
      expect((failure as typeof listenError).cause).toBe(listenCause);
      expect(closeModes).toContainEqual({ mode: 'final' });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(manager.prepareForShutdown).not.toHaveBeenCalled();
      expect(manager.close).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
