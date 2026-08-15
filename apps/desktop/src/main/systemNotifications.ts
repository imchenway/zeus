export interface ZeusRealtimeEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface ZeusSystemNotificationPayload {
  title: string;
  body: string;
  projectId?: string;
  conversationId?: string;
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
  shouldNotify?: () => boolean;
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
  if (event.type === 'conversation.attention.changed') {
    return conversationNotification(payload, 'Zeus 有新回复', '模型已回复，请回到会话查看。');
  }
  if (event.type === 'conversation.request.created') {
    if (payload.notificationEligible === false) return null;
    const userInput = readString(payload.requestKind) === 'request_user_input';
    return conversationNotification(payload, userInput ? 'Zeus 等待你的回答' : 'Zeus 等待审批', userInput ? '会话需要你补充信息。' : '会话需要你确认后才能继续。');
  }
  if (event.type === 'conversation.turn.completed') {
    if (payload.notificationEligible !== true) return null;
    const status = readString(payload.status);
    if (status === 'failed' && payload.severity === 'warning') {
      return conversationNotification(payload, 'Zeus 模型请求未完成', '本轮请求未完成，会话可以继续。');
    }
    if (status === 'failed') return conversationNotification(payload, 'Zeus 会话失败', '本轮执行失败，请回到会话查看详情。');
    if (status === 'interrupted') return conversationNotification(payload, 'Zeus 会话已中断', '本轮执行已中断。');
    if (status === 'completed') return conversationNotification(payload, 'Zeus 会话已完成', '本轮执行已经完成。');
  }
  if (event.type === 'conversation.goal.updated') {
    if (payload.notificationEligible !== true) return null;
    const goal = isRecord(payload.goal) ? payload.goal : {};
    const status = readString(goal.status);
    if (status === 'complete') return conversationNotification(payload, 'Zeus 目标已完成', '目标已经达到停止条件。');
    if (status === 'blocked') return conversationNotification(payload, 'Zeus 目标需要处理', '目标遇到阻塞，需要你处理。');
    if (status === 'usageLimited') return conversationNotification(payload, 'Zeus 目标用量受限', '目标因账户用量限制暂停。');
    if (status === 'budgetLimited') return conversationNotification(payload, 'Zeus 目标预算受限', '目标因令牌预算限制暂停。');
  }
  return null;
}

/**
 * 订阅 Zeus 本地事件流并触发系统通知；只接受本地服务 URL 和 API token，不接触任何业务密钥。
 */
export function createSystemNotificationBridge(options: CreateSystemNotificationBridgeOptions): SystemNotificationBridge {
  const url = `${options.baseUrl.replace(/^http/u, 'ws')}/api/events`;
  const socket = options.openWebSocket(url, buildZeusWebSocketProtocol(options.apiToken));
  const notifiedOrdinaryTurns = new Set<string>();
  const deliveredKeys = new Set<string>();
  socket.addEventListener('message', (message) => {
    try {
      const event = JSON.parse(message.data) as ZeusRealtimeEvent;
      if (options.shouldNotify && !options.shouldNotify()) return;
      const notificationKey = conversationNotificationKey(event);
      if (notificationKey?.suppressBecauseOrdinary && notifiedOrdinaryTurns.has(notificationKey.turnKey)) return;
      if (notificationKey && deliveredKeys.has(notificationKey.key)) return;
      const notification = buildSystemNotificationFromRealtimeEvent(event);
      if (notification) {
        if (notificationKey) {
          deliveredKeys.add(notificationKey.key);
          if (notificationKey.ordinary) notifiedOrdinaryTurns.add(notificationKey.turnKey);
        }
        options.showNotification(notification);
      }
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

function conversationNotification(payload: Record<string, unknown>, title: string, fallbackBody: string): ZeusSystemNotificationPayload {
  return {
    title,
    body: readString(payload.conversationTitle, fallbackBody),
    ...(typeof payload.projectId === 'string' ? { projectId: payload.projectId } : {}),
    ...(typeof payload.conversationId === 'string' ? { conversationId: payload.conversationId } : {}),
  };
}

function conversationNotificationKey(event: ZeusRealtimeEvent): { key: string; turnKey: string; ordinary: boolean; suppressBecauseOrdinary: boolean } | null {
  const payload = event.payload ?? {};
  const conversationId = readString(payload.conversationId);
  if (!conversationId) return null;
  const turnId = readString(payload.turnId, readString(payload.providerTurnId, 'conversation'));
  const turnKey = `${conversationId}:${turnId}`;
  if (event.type === 'conversation.attention.changed') return { key: `ordinary:${turnKey}`, turnKey, ordinary: true, suppressBecauseOrdinary: false };
  if (event.type === 'conversation.request.created') {
    if (payload.notificationEligible === false) return null;
    const requestId = readString(payload.requestId, turnId);
    return { key: `request:${conversationId}:${requestId}`, turnKey, ordinary: false, suppressBecauseOrdinary: false };
  }
  if (event.type === 'conversation.turn.completed') {
    const status = readString(payload.status);
    return { key: `terminal:${turnKey}:${status}`, turnKey, ordinary: false, suppressBecauseOrdinary: status === 'completed' };
  }
  if (event.type === 'conversation.goal.updated') {
    if (payload.notificationEligible !== true) return null;
    const goal = isRecord(payload.goal) ? payload.goal : {};
    const updatedAt = typeof goal.providerUpdatedAt === 'number' ? goal.providerUpdatedAt : readString(payload.updatedAt, 'current');
    return { key: `goal:${conversationId}:${readString(goal.status)}:${String(updatedAt)}`, turnKey, ordinary: false, suppressBecauseOrdinary: false };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
