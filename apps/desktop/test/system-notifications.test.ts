import { describe, expect, it, vi } from 'vitest';
import { buildSystemNotificationFromRealtimeEvent, createSystemNotificationBridge } from '../src/main/systemNotifications.js';

describe('Electron main system notifications', () => {
  it('maps real task and runtime events to native notification copy without fake data', () => {
    expect(
      buildSystemNotificationFromRealtimeEvent({
        type: 'task.status.changed',
        payload: { title: '真实任务', to: 'completed', projectId: 'project-1' },
      }),
    ).toEqual({ title: 'Zeus 任务已完成', body: '真实任务 · project-1' });

    expect(
      buildSystemNotificationFromRealtimeEvent({
        type: 'task.status.changed',
        payload: { title: '失败任务', to: 'failed', projectId: 'project-1' },
      }),
    ).toEqual({ title: 'Zeus 任务失败', body: '失败任务 · project-1' });

    expect(
      buildSystemNotificationFromRealtimeEvent({
        type: 'runtime.confirmation.created',
        payload: { operation: 'generic_shell', projectId: 'project-1' },
      }),
    ).toEqual({ title: 'Zeus 等待确认', body: 'generic_shell · project-1' });

    expect(
      buildSystemNotificationFromRealtimeEvent({
        type: 'security.confirmation.approved',
        payload: { operation: 'commit', riskLevel: 'high' },
      }),
    ).toEqual({ title: 'Zeus 确认已通过', body: 'commit · high' });

    expect(
      buildSystemNotificationFromRealtimeEvent({
        type: 'security.confirmation.rejected',
        payload: { operation: 'stash', riskLevel: 'high' },
      }),
    ).toEqual({ title: 'Zeus 确认已拒绝', body: 'stash · high' });

    expect(
      buildSystemNotificationFromRealtimeEvent({
        type: 'project.scan.progress',
        payload: { stage: 'index_source' },
      }),
    ).toBeNull();
  });

  it('subscribes to the local event stream and only shows notifications for mapped events', () => {
    const shown: Array<{ title: string; body: string }> = [];
    const socket = createFakeSocket();
    const openWebSocket = vi.fn(() => socket);

    const bridge = createSystemNotificationBridge({
      baseUrl: 'http://127.0.0.1:49152',
      apiToken: 'renderer-token',
      openWebSocket,
      showNotification: (payload) => shown.push(payload),
    });

    expect(openWebSocket).toHaveBeenCalledWith('ws://127.0.0.1:49152/api/events', 'zeus-token.cmVuZGVyZXItdG9rZW4');

    socket.emit({
      type: 'project.scan.progress',
      payload: { stage: 'index_source' },
    });
    socket.emit({
      type: 'task.status.changed',
      payload: { title: '真实任务', to: 'completed', projectId: 'project-1' },
    });
    socket.emitRaw('not-json');

    expect(shown).toEqual([{ title: 'Zeus 任务已完成', body: '真实任务 · project-1' }]);

    bridge.close();
    expect(socket.closed).toBe(true);
  });
});

function createFakeSocket(): {
  closed: boolean;
  addEventListener: (type: string, listener: (event: { data: string }) => void) => void;
  close: () => void;
  emit: (event: unknown) => void;
  emitRaw: (data: string) => void;
} {
  const listeners: Array<(event: { data: string }) => void> = [];
  return {
    closed: false,
    addEventListener: (type, listener) => {
      if (type === 'message') listeners.push(listener);
    },
    close() {
      this.closed = true;
    },
    emit(event) {
      this.emitRaw(JSON.stringify(event));
    },
    emitRaw(data) {
      for (const listener of listeners) listener({ data });
    },
  };
}
