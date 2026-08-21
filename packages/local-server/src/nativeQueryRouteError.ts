import type { FastifyReply } from 'fastify';

/** 保持历史 Native 查询接口的错误码与 HTTP 映射，不让各领域路由重复猜测状态码。 */
export function sendNativeQueryRouteError(reply: FastifyReply, error: unknown): unknown {
  const candidate = isRecord(error) ? error : null;
  const code = typeof candidate?.code === 'string' ? candidate.code : 'ZEUS_NATIVE_CONVERSATION_API_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  const explicitStatusCode = typeof candidate?.statusCode === 'number' && candidate.statusCode >= 400 && candidate.statusCode <= 599 ? candidate.statusCode : null;
  const statusCode =
    explicitStatusCode ??
    (code.endsWith('_NOT_FOUND')
      ? 404
      : code.includes('CONFLICT') ||
          code.includes('LOGIN_REQUIRED') ||
          code.includes('CHOICE_REQUIRED') ||
          code.includes('READ_ONLY') ||
          code.includes('NOT_EDITABLE') ||
          code.includes('NOT_QUEUED') ||
          code.includes('NOT_ACTIVE') ||
          code.includes('NOT_INTERRUPTED') ||
          code.includes('IN_PROGRESS') ||
          code.includes('MISMATCH') ||
          code.includes('EXCEEDS_POLICY') ||
          code.includes('EXCEEDS_REQUEST') ||
          code.includes('ATTACHMENT_UNAVAILABLE') ||
          code.includes('CONTEXT_CHANGED') ||
          code.includes('NATIVE_DISABLED') ||
          code.includes('NOT_AVAILABLE') ||
          code.includes('STALE')
        ? 409
        : code.startsWith('ZEUS_INVALID_') || code.endsWith('_INVALID') || code.endsWith('_REQUIRED') || code.includes('_UNSUPPORTED')
          ? 400
          : 500);
  return reply.code(statusCode).send({ error: code, message, ...(code.includes('STALE') || code.includes('RECOVERY_REQUIRED') ? { recoveryRequired: true } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
