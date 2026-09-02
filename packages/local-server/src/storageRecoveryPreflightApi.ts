import type { FastifyInstance } from 'fastify';
import type { ArtifactStore, ZeusDatabase } from '@zeus/storage';

/**
 * 存储故障期间 Command WAL 本身可能不可写，因此恢复预检不能伪装成普通 Command。
 * 它只执行可重复的 SQLite/Artifact staging 探针并返回是否可重启，不创建业务事实；
 * 真正恢复仍由用户显式重启 Core 完成。
 */
export function registerStorageRecoveryPreflightApi(options: { server: FastifyInstance; db: ZeusDatabase; artifacts: ArtifactStore }): void {
  options.server.post('/api/diagnostics/storage/recovery-preflight', async (_request, reply) => {
    try {
      const database = options.db.runWriteRecoveryPreflight();
      const artifacts = await options.artifacts.runRecoveryPreflight();
      return {
        ...database,
        eligibleForCoreRestart: database.eligibleForCoreRestart && artifacts.eligibleForCoreRestart,
        artifacts,
      };
    } catch (error) {
      return reply.code(409).send({
        error: 'ZEUS_STORAGE_RECOVERY_PREFLIGHT_UNAVAILABLE',
        message: error instanceof Error ? error.message : '当前无法执行存储恢复预检。',
      });
    }
  });
}
