import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AuditLogRepository, RuntimeSessionRepository } from '@zeus/storage';

interface RuntimeLogRetentionManifest {
  kind: 'runtime-log-retention';
  status: 'pending' | 'committed';
  transactionId: string;
  createdAt: string;
  cutoff: string;
  sessionIds: string[];
  movedSessionIds: string[];
  runtimeLogCount: number;
  terminalEventCount: number;
}

export interface RuntimeLogRetentionResult {
  quarantinedSessionCount: number;
  manifestPath: string | null;
  manifest: RuntimeLogRetentionManifest | null;
}

const runtimeLogRetentionQuarantineName = '.retention-quarantine';
const runtimeLogRetentionGraceMs = 7 * 24 * 60 * 60 * 1_000;

/** Runtime 日志到期后先隔离七天；崩溃时恢复 pending 事务，禁止直接物理删除活动证据。 */
export function applyRuntimeLogRetention(input: { runtimeSessions: RuntimeSessionRepository; auditLogs: AuditLogRepository; sessionRoot: string; retentionDays: number; now: Date }): RuntimeLogRetentionResult {
  const quarantineRoot = join(input.sessionRoot, runtimeLogRetentionQuarantineName);
  mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  recoverAndCollectRuntimeLogQuarantine(input.sessionRoot, quarantineRoot, input.now.getTime());
  const cutoff = new Date(input.now.getTime() - input.retentionDays * 24 * 60 * 60 * 1_000).toISOString();
  const candidates = input.runtimeSessions.listLogRetentionCandidates(cutoff);
  if (candidates.length === 0) return { quarantinedSessionCount: 0, manifestPath: null, manifest: null };

  const transactionId = `${input.now.toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
  const transactionRoot = join(quarantineRoot, transactionId);
  mkdirSync(transactionRoot, { recursive: false, mode: 0o700 });
  const manifestPath = join(transactionRoot, 'manifest.json');
  const manifest: RuntimeLogRetentionManifest = {
    kind: 'runtime-log-retention',
    status: 'pending',
    transactionId,
    createdAt: input.now.toISOString(),
    cutoff,
    sessionIds: candidates.map((session) => session.id),
    movedSessionIds: [],
    runtimeLogCount: 0,
    terminalEventCount: 0,
  };
  writeRuntimeLogRetentionManifest(manifestPath, manifest);

  for (const session of candidates) {
    if (basename(session.id) !== session.id || session.id === '.' || session.id === '..') throw new Error('Runtime 日志保留候选包含非法会话标识。');
    const source = join(input.sessionRoot, session.id);
    if (existsSync(source)) {
      const sourceStat = lstatSync(source);
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Runtime 日志保留候选不是受管目录。');
      renameSync(source, join(transactionRoot, session.id));
      manifest.movedSessionIds.push(session.id);
      writeRuntimeLogRetentionManifest(manifestPath, manifest);
    }
    const purged = input.runtimeSessions.purgeRetainedLogs(session.id);
    manifest.runtimeLogCount += purged.runtimeLogCount;
    manifest.terminalEventCount += purged.terminalEventCount;
  }
  writeRuntimeLogRetentionManifest(manifestPath, manifest);
  input.auditLogs.append({
    actorType: 'system',
    action: 'runtime.logs.retention_quarantined',
    resourceType: 'runtime_log',
    resourceId: transactionId,
    payload: {
      retentionDays: input.retentionDays,
      cutoff,
      sessionCount: candidates.length,
      movedSessionCount: manifest.movedSessionIds.length,
      runtimeLogCount: manifest.runtimeLogCount,
      terminalEventCount: manifest.terminalEventCount,
      graceDays: runtimeLogRetentionGraceMs / (24 * 60 * 60 * 1_000),
    },
    createdAt: input.now.toISOString(),
  });
  return { quarantinedSessionCount: candidates.length, manifestPath, manifest };
}

export function markRuntimeLogRetentionCommitted(result: RuntimeLogRetentionResult): void {
  if (!result.manifestPath || !result.manifest) return;
  writeRuntimeLogRetentionManifest(result.manifestPath, { ...result.manifest, status: 'committed' });
}

function recoverAndCollectRuntimeLogQuarantine(sessionRoot: string, quarantineRoot: string, nowMs: number): void {
  for (const transactionName of readdirSync(quarantineRoot)) {
    const transactionRoot = join(quarantineRoot, transactionName);
    const transactionStat = lstatSync(transactionRoot);
    if (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()) continue;
    const manifestPath = join(transactionRoot, 'manifest.json');
    let manifest: RuntimeLogRetentionManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeLogRetentionManifest;
    } catch {
      continue;
    }
    if (manifest.kind !== 'runtime-log-retention' || !Array.isArray(manifest.movedSessionIds)) continue;
    if (manifest.status === 'committed') {
      const createdAt = Date.parse(manifest.createdAt);
      if (Number.isFinite(createdAt) && nowMs - createdAt >= runtimeLogRetentionGraceMs) rmSync(transactionRoot, { recursive: true, force: true });
      continue;
    }
    for (const sessionId of manifest.movedSessionIds) {
      if (basename(sessionId) !== sessionId || sessionId === '.' || sessionId === '..') continue;
      const quarantined = join(transactionRoot, sessionId);
      const destination = join(sessionRoot, sessionId);
      if (existsSync(quarantined) && !existsSync(destination)) renameSync(quarantined, destination);
    }
    const remaining = readdirSync(transactionRoot).filter((name) => name !== 'manifest.json');
    if (remaining.length === 0) rmSync(transactionRoot, { recursive: true, force: true });
  }
}

function writeRuntimeLogRetentionManifest(path: string, manifest: RuntimeLogRetentionManifest): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

export function sanitizeRuntimeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, '_');
}
