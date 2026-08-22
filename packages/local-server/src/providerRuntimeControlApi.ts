import type { AgentRuntimeHealthSnapshot } from '@zeus/ai-runtime';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ProviderRuntimeRecoveryApplicationPort } from './providerRuntimeRecoveryService.js';

export interface ProviderRuntimeControlPorts {
  server: FastifyInstance;
  readCodexHealth(): AgentRuntimeHealthSnapshot;
  readPiHealth(): AgentRuntimeHealthSnapshot;
  recovery: ProviderRuntimeRecoveryApplicationPort;
}

/**
 * Provider 运行态与显式恢复产品入口。恢复只切换 Pi Worker generation 并续接已知原生身份，
 * 不消费会话队列、不重发上一条命令，也不把 Codex 的自动监督器伪装成手动恢复。
 */
export function registerProviderRuntimeControlApi(ports: ProviderRuntimeControlPorts): void {
  ports.server.get('/api/diagnostics/provider-runtimes', async () => ({
    items: [ports.readCodexHealth(), ports.readPiHealth()],
  }));

  ports.server.post(
    '/api/provider-runtimes/pi/recover',
    async (
      request: FastifyRequest<{
        Body: unknown;
      }>,
      reply,
    ) => {
      try {
        return await ports.recovery.execute(request.body);
      } catch (error) {
        return reply.code(readErrorStatus(error)).send({
          error: readErrorCode(error) ?? 'ZEUS_PROVIDER_RECOVERY_FAILED',
          message: error instanceof Error ? error.message : 'Pi Worker 恢复失败。',
          replayedCommandCount: 0,
          details: readErrorDetails(error),
          health: ports.readPiHealth(),
        });
      }
    },
  );
}

function readErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function readErrorStatus(error: unknown): number {
  if (error && typeof error === 'object' && 'statusCode' in error && (error.statusCode === 400 || error.statusCode === 409 || error.statusCode === 503)) return error.statusCode;
  const code = readErrorCode(error);
  return code === 'ZEUS_COMMAND_ENVELOPE_INVALID' || code === 'ZEUS_COMMAND_ENVELOPE_SCHEMA_MISMATCH' ? 400 : 409;
}

function readErrorDetails(error: unknown): Record<string, unknown> {
  return error && typeof error === 'object' && 'details' in error && error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? (error.details as Record<string, unknown>) : {};
}
