const navigationTraceLifetimeMs = 60_000;

export interface ConversationNavigationTrace {
  traceId: string;
  startedAtMs: number;
  snapshotSettled: boolean;
  snapshotSucceeded: boolean | null;
  renderReady: boolean;
}

interface ActiveConversationNavigationTrace extends ConversationNavigationTrace {
  snapshotPathname: string;
}

let activeConversationNavigation: ActiveConversationNavigationTrace | null = null;

/** 会话点击只创建关联身份和目标 API 路径，不记录会话标题或正文。 */
export function beginConversationNavigationTrace(projectId: string, conversationId: string): string {
  expireStaleTrace();
  const snapshotPathname = conversationSnapshotPathname(projectId, conversationId);
  if (activeConversationNavigation?.snapshotPathname === snapshotPathname && !activeConversationNavigation.renderReady) return activeConversationNavigation.traceId;
  const traceId = createTraceId();
  activeConversationNavigation = {
    traceId,
    startedAtMs: performance.now(),
    snapshotSettled: false,
    snapshotSucceeded: null,
    renderReady: false,
    snapshotPathname,
  };
  return traceId;
}

/** 只有当前目标的精确 Snapshot V2 请求才能继承点击 trace；并发后台请求使用自己的身份。 */
export function currentConversationNavigationTraceId(requestPath: string): string | null {
  expireStaleTrace();
  if (!activeConversationNavigation || requestPathname(requestPath) !== activeConversationNavigation.snapshotPathname) return null;
  return activeConversationNavigation.traceId;
}

export function markConversationNavigationSnapshotSettled(traceId: string, requestPath: string, succeeded: boolean): void {
  expireStaleTrace();
  if (activeConversationNavigation?.traceId !== traceId || requestPathname(requestPath) !== activeConversationNavigation.snapshotPathname) return;
  activeConversationNavigation = { ...activeConversationNavigation, snapshotSettled: true, snapshotSucceeded: succeeded };
}

/** 水合完成后才允许下一次 React commit 被记作该会话的首帧。 */
export function markConversationNavigationRenderReady(projectId: string, conversationId: string): void {
  expireStaleTrace();
  if (activeConversationNavigation?.snapshotPathname !== conversationSnapshotPathname(projectId, conversationId)) return;
  activeConversationNavigation = { ...activeConversationNavigation, renderReady: true };
}

export function cancelConversationNavigationTrace(projectId: string, conversationId: string): void {
  expireStaleTrace();
  if (activeConversationNavigation?.snapshotPathname === conversationSnapshotPathname(projectId, conversationId)) activeConversationNavigation = null;
}

export function readyConversationNavigationTrace(): ConversationNavigationTrace | null {
  expireStaleTrace();
  return activeConversationNavigation?.snapshotSettled && activeConversationNavigation.renderReady ? publicTrace(activeConversationNavigation) : null;
}

export function completeConversationNavigationTrace(traceId: string): ConversationNavigationTrace | null {
  expireStaleTrace();
  if (activeConversationNavigation?.traceId !== traceId) return null;
  const completed = activeConversationNavigation;
  activeConversationNavigation = null;
  return publicTrace(completed);
}

function expireStaleTrace(): void {
  if (activeConversationNavigation && performance.now() - activeConversationNavigation.startedAtMs > navigationTraceLifetimeMs) activeConversationNavigation = null;
}

function createTraceId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function conversationSnapshotPathname(projectId: string, conversationId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/snapshot-v2`;
}

function requestPathname(requestPath: string): string | null {
  try {
    return new URL(requestPath, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}

function publicTrace(trace: ActiveConversationNavigationTrace): ConversationNavigationTrace {
  return {
    traceId: trace.traceId,
    startedAtMs: trace.startedAtMs,
    snapshotSettled: trace.snapshotSettled,
    snapshotSucceeded: trace.snapshotSucceeded,
    renderReady: trace.renderReady,
  };
}
