import type { ZeusRealtimeConnectionState, ZeusRealtimeEvent } from './dashboardClientContracts.js';
import type { LocalApiTransport } from './localApiTransport.js';

/**
 * 本机事件流的唯一重连策略。领域 client 只接收事件，不掌握 token、端口刷新或退避时钟。
 */
export function createLocalApiEventSubscription(input: { transport: LocalApiTransport; refreshConnection?: () => Promise<void> }) {
  return (onEvent: (event: ZeusRealtimeEvent) => void, onConnectionState: (state: ZeusRealtimeConnectionState) => void): (() => void) => {
    let active = true;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let connectionGeneration = 0;
    let reconnectAttempt = 0;
    let connectedOnce = false;

    const scheduleReconnect = (): void => {
      if (!active || retryTimer !== undefined) return;
      onConnectionState(connectedOnce ? 'reconnecting' : 'connecting');
      const delay = Math.min(250 * 2 ** Math.min(reconnectAttempt, 4), 4_000);
      reconnectAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void connect(true);
      }, delay);
    };

    const connect = async (refreshConfig: boolean): Promise<void> => {
      const generation = ++connectionGeneration;
      if (refreshConfig && input.refreshConnection) {
        try {
          await input.refreshConnection();
        } catch {
          if (active && generation === connectionGeneration) scheduleReconnect();
          return;
        }
      }
      if (!active || generation !== connectionGeneration) return;
      try {
        const nextSocket = input.transport.connectEvents<ZeusRealtimeEvent>((event) => {
          if (!active || generation !== connectionGeneration || socket !== nextSocket) return;
          if (event.type === 'server.connected') {
            connectedOnce = true;
            reconnectAttempt = 0;
            onConnectionState('connected');
          }
          onEvent(event);
        });
        socket = nextSocket;
        nextSocket.addEventListener(
          'close',
          () => {
            if (!active || generation !== connectionGeneration || socket !== nextSocket) return;
            socket = null;
            scheduleReconnect();
          },
          { once: true },
        );
        nextSocket.addEventListener(
          'error',
          () => {
            if (!active || generation !== connectionGeneration || socket !== nextSocket) return;
            nextSocket.close();
          },
          { once: true },
        );
      } catch {
        if (active && generation === connectionGeneration) scheduleReconnect();
      }
    };

    onConnectionState('connecting');
    void connect(false);

    return () => {
      active = false;
      connectionGeneration += 1;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
      const currentSocket = socket;
      socket = null;
      currentSocket?.close();
    };
  };
}
