import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export interface ConversationSnapshotRemovalEvidence {
  rendererMigrated: boolean;
  maximumHistoryCopyAccepted: boolean;
  explicitReleaseApproval: boolean;
  requiredQuietDays?: number;
}

interface CallerUsage {
  caller: string;
  v1Calls: number;
  v2Calls: number;
  firstCalledAt: string;
  lastCalledAt: string;
}

const maximumTrackedCallers = 64;
const explicitCallerPattern = /^[A-Za-z0-9._/-]{1,80}$/u;

/**
 * V1/V2 调用者的有界内存计数器。
 *
 * 不保存 URL、请求体、授权头或原始 User-Agent；重启后清空，因此它只能作为移除门禁的现场证据，
 * 不能替代跨版本验收记录。默认门禁保持关闭，必须同时提交 Renderer、最大历史副本和发布批准证据。
 */
export class ConversationSnapshotCompatibilityTracker {
  private readonly startedAt: string;
  private readonly callers = new Map<string, CallerUsage>();
  private v1Calls = 0;
  private v2Calls = 0;
  private lastV1CallAt: string | null = null;
  private lastV2CallAt: string | null = null;

  constructor(
    private readonly evidence: ConversationSnapshotRemovalEvidence,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.startedAt = this.now().toISOString();
  }

  recordV1(request: FastifyRequest): void {
    this.record('v1', request);
  }

  recordV2(request: FastifyRequest): void {
    this.record('v2', request);
  }

  snapshot(): {
    startedAt: string;
    generatedAt: string;
    runtimeOnly: true;
    totals: { v1Calls: number; v2Calls: number; lastV1CallAt: string | null; lastV2CallAt: string | null };
    callers: CallerUsage[];
    removalGate: {
      eligible: boolean;
      requiredQuietDays: number;
      checks: Array<{ id: string; passed: boolean; evidence: string }>;
    };
  } {
    const now = this.now();
    const requiredQuietDays = normalizeQuietDays(this.evidence.requiredQuietDays ?? 30);
    const quietWindowMs = requiredQuietDays * 24 * 60 * 60 * 1_000;
    const observedForMs = Math.max(0, now.getTime() - Date.parse(this.startedAt));
    const lastV1Time = this.lastV1CallAt ? Date.parse(this.lastV1CallAt) : null;
    const quietWindowPassed = observedForMs >= quietWindowMs && (lastV1Time === null || now.getTime() - lastV1Time >= quietWindowMs);
    const checks = [
      {
        id: 'renderer_migrated',
        passed: this.evidence.rendererMigrated,
        evidence: this.evidence.rendererMigrated ? 'Renderer 已切换 Snapshot V2。' : 'Renderer 仍保留 Snapshot V1 调用。',
      },
      {
        id: 'maximum_history_copy_accepted',
        passed: this.evidence.maximumHistoryCopyAccepted,
        evidence: this.evidence.maximumHistoryCopyAccepted ? '最大历史候选副本已完成 V2 验收。' : '最大历史候选副本尚未完成 V2 验收。',
      },
      {
        id: 'v2_observed',
        passed: this.v2Calls > 0,
        evidence: this.v2Calls > 0 ? `本次运行已观察到 ${this.v2Calls} 次 V2 snapshot 调用。` : '本次运行尚未观察到 V2 snapshot 调用。',
      },
      {
        id: 'v1_quiet_window',
        passed: quietWindowPassed,
        evidence: quietWindowPassed ? `已连续观察至少 ${requiredQuietDays} 天且窗口内无 V1 调用。` : `必须连续观察至少 ${requiredQuietDays} 天且窗口内无 V1 调用。`,
      },
      {
        id: 'explicit_release_approval',
        passed: this.evidence.explicitReleaseApproval,
        evidence: this.evidence.explicitReleaseApproval ? '发布批准已显式记录。' : '尚未显式批准移除 V1。',
      },
    ];
    return {
      startedAt: this.startedAt,
      generatedAt: now.toISOString(),
      runtimeOnly: true,
      totals: {
        v1Calls: this.v1Calls,
        v2Calls: this.v2Calls,
        lastV1CallAt: this.lastV1CallAt,
        lastV2CallAt: this.lastV2CallAt,
      },
      callers: [...this.callers.values()].sort((left, right) => right.lastCalledAt.localeCompare(left.lastCalledAt) || left.caller.localeCompare(right.caller)),
      removalGate: {
        eligible: checks.every((check) => check.passed),
        requiredQuietDays,
        checks,
      },
    };
  }

  private record(version: 'v1' | 'v2', request: FastifyRequest): void {
    const timestamp = this.now().toISOString();
    const caller = snapshotCaller(request);
    if (version === 'v1') {
      this.v1Calls += 1;
      this.lastV1CallAt = timestamp;
    } else {
      this.v2Calls += 1;
      this.lastV2CallAt = timestamp;
    }
    const existing = this.callers.get(caller);
    if (existing) {
      existing[version === 'v1' ? 'v1Calls' : 'v2Calls'] += 1;
      existing.lastCalledAt = timestamp;
      return;
    }
    const key = this.callers.size < maximumTrackedCallers ? caller : 'overflow';
    const overflow = this.callers.get(key);
    if (overflow) {
      overflow[version === 'v1' ? 'v1Calls' : 'v2Calls'] += 1;
      overflow.lastCalledAt = timestamp;
      return;
    }
    this.callers.set(key, {
      caller: key,
      v1Calls: version === 'v1' ? 1 : 0,
      v2Calls: version === 'v2' ? 1 : 0,
      firstCalledAt: timestamp,
      lastCalledAt: timestamp,
    });
  }
}

function snapshotCaller(request: FastifyRequest): string {
  const explicit = firstHeader(request.headers['x-zeus-snapshot-caller']);
  if (explicit && explicitCallerPattern.test(explicit)) return `declared:${explicit}`;
  const userAgent = firstHeader(request.headers['user-agent']) ?? '';
  const zeusVersion = userAgent.match(/\bZeus\/([0-9][0-9A-Za-z.-]{0,31})\b/u)?.[1];
  if (zeusVersion) return `zeus-app/${zeusVersion}`;
  if (/\bElectron\//u.test(userAgent)) return 'electron-renderer';
  if (!userAgent) return 'unknown';
  return `user-agent-sha256:${createHash('sha256').update(userAgent).digest('hex').slice(0, 16)}`;
}

function firstHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function normalizeQuietDays(value: number): number {
  return Number.isSafeInteger(value) && value >= 7 && value <= 180 ? value : 30;
}
