export interface ZeusRealtimeEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface ZeusSystemNotificationPayload {
  title: string;
  body: string;
}

export interface ZeusSystemNotificationSocket {
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  close(): void;
}

export interface CreateSystemNotificationBridgeOptions {
  baseUrl: string;
  apiToken: string;
  openWebSocket: (url: string, protocol: string) => ZeusSystemNotificationSocket;
  showNotification: (payload: ZeusSystemNotificationPayload) => void;
  onError?: (error: unknown) => void;
}

export interface SystemNotificationBridge {
  close(): void;
}

/**
 * 将本地事件总线里的真实领域事件转换为 macOS 系统通知文案；未映射事件返回 null，避免制造噪音或假通知。
 */
export function buildSystemNotificationFromRealtimeEvent(event: ZeusRealtimeEvent): ZeusSystemNotificationPayload | null {
  const payload = event.payload ?? {};
  if (event.type === 'task.created') {
    return {
      title: 'Zeus 新任务',
      body: joinNotificationParts(readString(payload.title, '真实任务'), readString(payload.projectId)),
    };
  }
  if (event.type === 'task.status.changed') {
    const title = taskStatusNotificationTitle(readString(payload.to));
    if (!title) return null;
    return {
      title,
      body: joinNotificationParts(readString(payload.title, '真实任务'), readString(payload.projectId)),
    };
  }
  if (event.type === 'runtime.confirmation.created' || event.type === 'git.confirmation.created') {
    return {
      title: 'Zeus 等待确认',
      body: joinNotificationParts(readString(payload.operation, '高风险操作'), readString(payload.projectId)),
    };
  }
  if (event.type === 'security.confirmation.approved') {
    return {
      title: 'Zeus 确认已通过',
      body: joinNotificationParts(readString(payload.operation, readString(payload.action, '高风险操作')), readString(payload.riskLevel)),
    };
  }
  if (event.type === 'security.confirmation.rejected') {
    return {
      title: 'Zeus 确认已拒绝',
      body: joinNotificationParts(readString(payload.operation, readString(payload.action, '高风险操作')), readString(payload.riskLevel)),
    };
  }
  if (event.type === 'project.scan.completed') {
    return {
      title: 'Zeus 扫描完成',
      body: joinNotificationParts(readString(payload.projectName, '真实项目'), formatCount(payload.nodeCount, '节点'), formatCount(payload.edgeCount, '边')),
    };
  }
  if (event.type === 'project.scan.failed') {
    return {
      title: 'Zeus 扫描失败',
      body: joinNotificationParts(readString(payload.projectName, '真实项目'), readString(payload.error, '请回到 Zeus 查看详情')),
    };
  }
  if (event.type === 'runtime.session.ended') {
    return {
      title: 'Zeus Runtime 已结束',
      body: joinNotificationParts(readString(payload.sessionId), readString(payload.taskId)),
    };
  }
  if (event.type === 'runtime.session.error') {
    return {
      title: 'Zeus Runtime 出错',
      body: joinNotificationParts(readString(payload.sessionId), readString(payload.error, '请回到 Zeus 查看日志')),
    };
  }
  return null;
}

/**
 * 订阅 Zeus 本地事件流并触发系统通知；只接受本地服务 URL 和 API token，不接触任何业务密钥。
 */
export function createSystemNotificationBridge(options: CreateSystemNotificationBridgeOptions): SystemNotificationBridge {
  const url = `${options.baseUrl.replace(/^http/u, 'ws')}/api/events`;
  const socket = options.openWebSocket(url, buildZeusWebSocketProtocol(options.apiToken));
  socket.addEventListener('message', (message) => {
    try {
      const event = JSON.parse(message.data) as ZeusRealtimeEvent;
      const notification = buildSystemNotificationFromRealtimeEvent(event);
      if (notification) options.showNotification(notification);
    } catch (error) {
      options.onError?.(error);
    }
  });
  return {
    close() {
      socket.close();
    },
  };
}

function buildZeusWebSocketProtocol(apiToken: string): string {
  return `zeus-token.${Buffer.from(apiToken, 'utf8').toString('base64url')}`;
}

function taskStatusNotificationTitle(status: string): string | null {
  const titles: Record<string, string> = {
    running: 'Zeus 任务已开始',
    waiting_confirmation: 'Zeus 任务等待确认',
    completed: 'Zeus 任务已完成',
    failed: 'Zeus 任务失败',
    canceled: 'Zeus 任务已取消',
  };
  return titles[status] ?? null;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function formatCount(value: unknown, label: string): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} ${label}` : '';
}

function joinNotificationParts(...parts: string[]): string {
  return parts.filter(Boolean).join(' · ') || '请回到 Zeus 查看详情';
}
