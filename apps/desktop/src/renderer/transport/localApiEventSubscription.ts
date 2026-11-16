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
    /** 主动退出期间不建立连接，退出中止后允许恢复订阅。 */
    let quitting = false;

    /** 使在途回调失效，并释放连接及全部连接计时器。 */
    const closeConnection = (): void => {
      connectionGeneration += 1;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (openTimer !== undefined) window.clearTimeout(openTimer);
      retryTimer = undefined;
      openTimer = undefined;
      const currentSocket = socket;
      socket = null;
      currentSocket?.close();
    };

    const scheduleReconnect = (): void => {
      if (!active || quitting || retryTimer !== undefined) return;
      onConnectionState(connectedOnce ? 'reconnecting' : 'connecting');
      const delay = (reconnectAttempt < 5 ? Math.min(250 * 2 ** reconnectAttempt, 4_000) : 30_000) * (0.8 + Math.random() * 0.4);
      reconnectAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void connect(true);
      }, delay);
    };

    const connect = async (refreshConfig: boolean): Promise<void> => {
      if (!active || quitting) return;
      const generation = ++connectionGeneration;
      if (refreshConfig && input.refreshConnection) {
        try {
          await input.refreshConnection();
        } catch {
          if (active && generation === connectionGeneration) scheduleReconnect();
          return;
        }
      }
      if (!active || quitting || generation !== connectionGeneration) return;
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
      if (!active || quitting || retryTimer === undefined) return;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      void connect(true);
    };
    window.addEventListener('online', restoreConnection);
    window.addEventListener('focus', restoreConnection);
    /** 桌面退出信号先关闭订阅，避免服务主动断开被识别为连接故障。 */
    const unsubscribeQuitState = window.zeus?.onQuitStateChanged((state) => {
      if (!active || quitting === state) return;
      quitting = state;
      closeConnection();
      if (quitting) {
        onConnectionState('quitting');
        return;
      }
      reconnectAttempt = 0;
      onConnectionState(connectedOnce ? 'reconnecting' : 'connecting');
      void connect(true);
    });
    if (!quitting) {
      onConnectionState('connecting');
      void connect(false);
    }

    return () => {
      active = false;
      unsubscribeQuitState?.();
      window.removeEventListener('online', restoreConnection);
      window.removeEventListener('focus', restoreConnection);
      closeConnection();
    };
  };
}
