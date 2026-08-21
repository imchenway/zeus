/** 为一次 Renderer 会话操作生成不携带正文的稳定关联身份。 */
export function createSessionOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
