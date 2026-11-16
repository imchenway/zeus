import type { ZeusRealtimeConnectionState, ZeusRealtimeEvent } from './dashboardClientContracts.js';
import type { LocalApiTransport } from './localApiTransport.js';

/**
 * 本机事件流的唯一重连策略。领域 client 只接收事件，不掌握 token、端口刷新或退避时钟。
 */
export function createLocalApiEventSubscription(input: { transport: LocalApiTransport; refreshConnection?: () => Promise<void> }) {
  return (onEvent: (event: ZeusRealtimeEvent) => void, onConnectionState: (state: ZeusRealtimeConnectionState) => void, options?: { path: string }): (() => void) => {
    let active = true;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    /** 等待服务端连接确认的上限，避免半开连接永久占住重连入口。 */
    let openTimer: number | undefined;
    let connectionGeneration = 0;
    let reconnectAttempt = 0;
    let connectedOnce = false;

    const scheduleReconnect = (): void => {
      if (!active || retryTimer !== undefined) return;
      onConnectionState(connectedOnce ? 'reconnecting' : 'connecting');
      const delay = (reconnectAttempt < 5 ? Math.min(250 * 2 ** reconnectAttempt, 4_000) : 30_000) * (0.8 + Math.random() * 0.4);
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
            if (openTimer !== undefined) window.clearTimeout(openTimer);
            openTimer = undefined;
            connectedOnce = true;
            reconnectAttempt = 0;
            onConnectionState('connected');
          }
          onEvent(event);
        }, options);
        socket = nextSocket;
        openTimer = window.setTimeout(() => {
          openTimer = undefined;
          if (active && generation === connectionGeneration && socket === nextSocket) nextSocket.close();
        }, 5_000);
        nextSocket.addEventListener(
          'close',
          () => {
            if (!active || generation !== connectionGeneration || socket !== nextSocket) return;
            if (openTimer !== undefined) window.clearTimeout(openTimer);
            openTimer = undefined;
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

    /** 网络或窗口恢复时提前结束退避，仅重新建立读取订阅。 */
    const restoreConnection = (): void => {
      if (!active || retryTimer === undefined) return;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      void connect(true);
    };
    window.addEventListener('online', restoreConnection);
    window.addEventListener('focus', restoreConnection);
    onConnectionState('connecting');
    void connect(false);

    return () => {
      active = false;
      window.removeEventListener('online', restoreConnection);
      window.removeEventListener('focus', restoreConnection);
      connectionGeneration += 1;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (openTimer !== undefined) window.clearTimeout(openTimer);
      retryTimer = undefined;
      const currentSocket = socket;
      socket = null;
      currentSocket?.close();
    };
  };
}
