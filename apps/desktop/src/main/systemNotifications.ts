import { describeUserFacingError, type UserFacingErrorLanguage } from '@zeus/shared';

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
  /** 每次通知读取当前应用语言，启动阶段默认中文。 */
  language?: () => UserFacingErrorLanguage;
  onError?: (error: unknown) => void;
}

export interface SystemNotificationBridge {
  close(): void;
}

/**
 * 将本地事件总线里的真实领域事件转换为 macOS 系统通知文案；未映射事件返回 null，避免制造噪音或假通知。
 */
export function buildSystemNotificationFromRealtimeEvent(event: ZeusRealtimeEvent, language: UserFacingErrorLanguage = 'zh-CN'): ZeusSystemNotificationPayload | null {
  // 通知与桌面界面使用同一种语言。
  const zh = language === 'zh-CN';
  const payload = event.payload ?? {};
  if (event.type === 'task.created') {
    return {
      title: zh ? 'Zeus 新任务' : 'Zeus new task',
      body: joinNotificationParts(readString(payload.title, zh ? '新任务' : 'New task'), readString(payload.projectId)),
    };
  }
  if (event.type === 'task.status.changed') {
    const title = taskStatusNotificationTitle(readString(payload.to), language);
    if (!title) return null;
    return {
      title,
      body: joinNotificationParts(readString(payload.title, zh ? '新任务' : 'New task'), readString(payload.projectId)),
    };
  }
  if (event.type === 'runtime.confirmation.created' || event.type === 'git.confirmation.created') {
    return {
      title: zh ? 'Zeus 等待你的授权' : 'Zeus needs your approval',
      body: joinNotificationParts(zh ? '请打开 Zeus 查看请求的操作和影响。' : 'Open Zeus to review the requested action and its effects.'),
    };
  }
  if (event.type === 'security.confirmation.approved') {
    return {
      title: zh ? 'Zeus 操作已获允许' : 'Zeus action approved',
      body: joinNotificationParts(zh ? '请打开 Zeus 查看操作进展。' : 'Open Zeus to check the action’s progress.'),
    };
  }
  if (event.type === 'security.confirmation.rejected') {
    return {
      title: zh ? 'Zeus 操作已被拒绝' : 'Zeus action declined',
      body: joinNotificationParts(zh ? '请打开 Zeus 查看操作进展。' : 'Open Zeus to check the action’s progress.'),
    };
  }
  if (event.type === 'project.scan.completed') {
    return {
      title: zh ? 'Zeus 项目扫描完成' : 'Zeus project scan complete',
      body: joinNotificationParts(readString(payload.projectName, zh ? '项目' : 'Project'), formatCount(payload.nodeCount, zh ? '个项目内容' : 'items'), formatCount(payload.edgeCount, zh ? '个关联' : 'relationships')),
    };
  }
  if (event.type === 'project.scan.failed') {
    return {
      title: zh ? 'Zeus 无法完成项目扫描' : 'Zeus project scan failed',
      body: joinNotificationParts(readString(payload.projectName, zh ? '项目' : 'Project'), describeUserFacingError(payload.error, language).message),
    };
  }
  if (event.type === 'runtime.session.ended') {
    return {
      title: zh ? 'Zeus 运行已结束' : 'Zeus run ended',
      body: joinNotificationParts(readString(payload.sessionId), readString(payload.taskId)),
    };
  }
  if (event.type === 'runtime.session.error') {
    return {
      title: zh ? 'Zeus 运行出错' : 'Zeus run failed',
      body: joinNotificationParts(readString(payload.sessionId), describeUserFacingError(payload.error, language).message),
    };
  }
  if (event.type === 'conversation.attention.changed') {
    return conversationNotification(payload, zh ? 'Zeus 有新回复' : 'Zeus has a new reply', zh ? 'AI 已回复，请打开对话查看。' : 'The AI has replied. Open the conversation to read it.');
  }
  if (event.type === 'conversation.request.created') {
    if (payload.notificationEligible === false) return null;
    const userInput = readString(payload.requestKind) === 'request_user_input';
    return conversationNotification(
      payload,
      userInput ? (zh ? 'Zeus 等待你的回答' : 'Zeus needs your answer') : zh ? 'Zeus 等待你的授权' : 'Zeus needs your approval',
      userInput ? (zh ? '请打开对话回答问题。' : 'Open the conversation to answer the question.') : zh ? '请打开对话允许或拒绝 AI 的操作请求。' : 'Open the conversation to approve or decline the AI’s action request.',
    );
  }
  if (event.type === 'conversation.turn.completed') {
    if (payload.notificationEligible !== true) return null;
    const status = readString(payload.status);
    if (status === 'failed' && payload.severity === 'warning') {
      return conversationNotification(
        payload,
        zh ? 'Zeus 模型请求出错' : 'Zeus model request failed',
        zh ? 'AI 服务未能完成回复，请打开对话查看原因。' : 'The AI service could not finish its response. Open the conversation to see the cause.',
      );
    }
    if (status === 'failed') return conversationNotification(payload, zh ? 'Zeus 对话处理失败' : 'Zeus conversation failed', zh ? '这次处理失败，请打开对话查看原因。' : 'This request failed. Open the conversation to see the cause.');
    if (status === 'interrupted') return conversationNotification(payload, zh ? 'Zeus 已停止处理' : 'Zeus stopped processing', zh ? '当前处理已停止。' : 'The current work has stopped.');
    if (status === 'completed') return conversationNotification(payload, zh ? 'Zeus 已完成处理' : 'Zeus finished processing', zh ? '请打开对话查看结果。' : 'Open the conversation to view the result.');
  }
  if (event.type === 'conversation.goal.updated') {
    if (payload.notificationEligible !== true) return null;
    const goal = isRecord(payload.goal) ? payload.goal : {};
    const status = readString(goal.status);
    if (status === 'complete') return conversationNotification(payload, zh ? 'Zeus 目标已完成' : 'Zeus goal complete', zh ? '目标已完成，自动执行已停止。' : 'The goal is complete and automatic work has stopped.');
    if (status === 'blocked')
      return conversationNotification(
        payload,
        zh ? 'Zeus 目标需要你处理' : 'Zeus goal needs attention',
        zh ? '目标暂时无法继续，请打开对话查看需要你处理的问题。' : 'Work toward the goal cannot continue. Open the conversation to see what needs your attention.',
      );
    if (status === 'usageLimited')
      return conversationNotification(payload, zh ? 'Zeus 目标因用量限制暂停' : 'Zeus goal paused by usage limit', zh ? '账户用量已达上限，目标已暂停。' : 'The account usage limit was reached, so work toward the goal is paused.');
    if (status === 'budgetLimited')
      return conversationNotification(
        payload,
        zh ? 'Zeus 目标已达到设定用量' : 'Zeus goal reached its usage budget',
        zh ? '已达到此目标设定的用量上限（Token），自动执行已暂停。' : 'The goal’s token budget was reached, so automatic work is paused.',
      );
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
      const notification = buildSystemNotificationFromRealtimeEvent(event, options.language?.());
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
    body: joinNotificationParts(readString(payload.conversationTitle), fallbackBody),
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

function taskStatusNotificationTitle(status: string, language: UserFacingErrorLanguage): string | null {
  const zh = language === 'zh-CN';
  const titles: Record<string, string> = {
    running: zh ? 'Zeus 任务已开始' : 'Zeus task started',
    waiting_confirmation: zh ? 'Zeus 任务等待确认' : 'Zeus task needs confirmation',
    completed: zh ? 'Zeus 任务已完成' : 'Zeus task complete',
    failed: zh ? 'Zeus 任务失败' : 'Zeus task failed',
    canceled: zh ? 'Zeus 任务已取消' : 'Zeus task cancelled',
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
  return parts.filter(Boolean).join(' · ');
}
