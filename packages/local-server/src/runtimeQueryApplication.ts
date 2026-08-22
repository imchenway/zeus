import type { AiCliAdapterDescriptor, AiCliAdapterStatus, AiRuntimeLogEntry, AiRuntimeSession, AiRuntimeTerminalSnapshot } from '@zeus/ai-runtime';
import type { RuntimeLogStream, RuntimeSessionRepository, TerminalEventRepository, ZeusRuntimeLogRecord, ZeusRuntimeSessionRecord } from '@zeus/storage';

export type RuntimeAutoConfirmationPolicy = 'never' | 'low_risk_only';

export interface RuntimeSettingsSnapshot {
  defaultAdapterId: AiCliAdapterDescriptor['id'];
  adapterModels: Partial<Record<AiCliAdapterDescriptor['id'], string>>;
  adapterDefaultArgs: Partial<Record<AiCliAdapterDescriptor['id'], string[]>>;
  adapterCliPaths: Partial<Record<AiCliAdapterDescriptor['id'], string>>;
  terminalEnv: Record<string, string>;
  shell: {
    path: string | null;
    login: boolean;
  };
  executionTimeoutSeconds: number;
  logRetentionDays: number;
  autoConfirmationPolicy: RuntimeAutoConfirmationPolicy;
}

export interface ListRuntimeSessionsQuery {
  query?: string;
  projectId?: string;
  taskId?: string;
  archived?: string;
  favoriteOnly?: string;
}

export interface ListRuntimeLogsQuery {
  query?: string;
  stream?: RuntimeLogStream;
  limit?: string;
  offset?: string;
}

export interface ListTerminalEventsQuery {
  limit?: string;
  offset?: string;
}

export interface RuntimeAdapterReadEffectPort {
  /** 返回静态适配器能力清单，不扫描 PATH。 */
  listAdapters(): AiCliAdapterDescriptor[];
  /** 用户显式进入单个 check 路由时才允许探测 CLI；不得启动会话或保存探测结果。 */
  checkAdapter(adapterId: string, configuredCommandPath?: string): Promise<AiCliAdapterStatus>;
}

export interface LiveRuntimeReadPort {
  /** 只观察当前进程已有会话；不得 spawn、恢复或终止进程。 */
  listSessions(): AiRuntimeSession[];
  getSession(sessionId: string): AiRuntimeSession | undefined;
}

interface RuntimeQueryPorts {
  runtimeSessions: Pick<RuntimeSessionRepository, 'list' | 'getById' | 'searchLogs' | 'listRecentLogs'>;
  terminalEvents: Pick<TerminalEventRepository, 'listBySessionPage'>;
  liveRuntime: LiveRuntimeReadPort;
  adapters: RuntimeAdapterReadEffectPort;
  readSettings(): RuntimeSettingsSnapshot;
  now(): Date;
}

/** Runtime 查询拥有者：合并持久投影与既有进程内会话，所有 process effect 都通过显式端口。 */
export class RuntimeQueryApplication {
  constructor(private readonly ports: RuntimeQueryPorts) {}

  listAdapters(): AiCliAdapterDescriptor[] {
    return this.ports.adapters.listAdapters();
  }

  async checkAdapter(adapterId: string): Promise<AiCliAdapterStatus> {
    try {
      const configuredPath = isRuntimeAdapterId(adapterId) ? this.ports.readSettings().adapterCliPaths[adapterId] : undefined;
      return await this.ports.adapters.checkAdapter(adapterId, configuredPath);
    } catch {
      throw queryError('ZEUS_RUNTIME_ADAPTER_NOT_FOUND', 'AI Runtime adapter not found', 404);
    }
  }

  readSettings(): RuntimeSettingsSnapshot {
    return this.ports.readSettings();
  }

  listSessions(query: ListRuntimeSessionsQuery): AiRuntimeSession[] {
    const hasFilter = Boolean(query.query || query.projectId || query.taskId || query.archived || query.favoriteOnly);
    if (hasFilter) {
      const persisted = this.ports.runtimeSessions
        .list({
          query: query.query,
          projectId: query.projectId,
          taskId: query.taskId,
          archived: query.archived === 'true',
          favoriteOnly: query.favoriteOnly === 'true',
        })
        .map(toAiRuntimeSession);
      const memory = this.ports.liveRuntime.listSessions().filter((session) => matchesRuntimeSessionFilter(session, query));
      const byId = new Map<string, AiRuntimeSession>();
      for (const session of [...persisted, ...memory]) byId.set(session.id, session);
      return [...byId.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    }
    const memorySessions = this.ports.liveRuntime.listSessions();
    const memoryIds = new Set(memorySessions.map((session) => session.id));
    return [
      ...memorySessions,
      ...this.ports.runtimeSessions
        .list()
        .filter((session) => !memoryIds.has(session.id))
        .map(toAiRuntimeSession),
    ];
  }

  readSession(sessionId: string): AiRuntimeSession {
    return this.requireSession(sessionId);
  }

  readLogs(sessionId: string, query: ListRuntimeLogsQuery): AiRuntimeLogEntry[] | Record<string, unknown> {
    this.assertSessionExists(sessionId);
    const hasLogQuery = Boolean(query.query || query.stream || query.limit || query.offset);
    if (!hasLogQuery) return this.readRendererTail(sessionId).logs;
    const page = this.ports.runtimeSessions.searchLogs(sessionId, {
      query: query.query,
      stream: normalizeRuntimeLogStream(query.stream),
      limit: parseBoundedInteger(query.limit, 200, 1, 1_000),
      offset: parseBoundedInteger(query.offset, 0, 0, 2_147_483_647),
    });
    return {
      sessionId,
      query: page.query,
      stream: page.stream,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      items: page.items.map((entry) => ('sessionId' in entry ? entry : toAiRuntimeLogEntry(entry))),
    };
  }

  readTerminal(sessionId: string): AiRuntimeTerminalSnapshot {
    const session = this.requireSession(sessionId);
    const rendererTail = this.readRendererTail(session.id);
    return {
      sessionId: session.id,
      status: session.status,
      command: [session.command, ...session.args].join(' '),
      cwd: session.cwd,
      logs: rendererTail.logs,
      logsTruncated: rendererTail.truncated,
      capturedAt: this.ports.now().toISOString(),
    };
  }

  readTerminalEvents(sessionId: string, query: ListTerminalEventsQuery): Record<string, unknown> {
    this.assertSessionExists(sessionId);
    const limit = parseBoundedInteger(query.limit, 200, 1, 1_000);
    const offset = parseBoundedInteger(query.offset, 0, 0, 2_147_483_647);
    // terminal_events 是终端回放的审计事实表；分页下推到 SQLite，避免长会话全量读入内存。
    const page = this.ports.terminalEvents.listBySessionPage(sessionId, { limit, offset });
    return {
      sessionId,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      items: page.items,
    };
  }

  private requireSession(sessionId: string): AiRuntimeSession {
    const session = this.ports.liveRuntime.getSession(sessionId) ?? toAiRuntimeSessionOrUndefined(this.ports.runtimeSessions.getById(sessionId));
    if (!session) throw queryError('ZEUS_RUNTIME_SESSION_NOT_FOUND', 'AI Runtime session not found', 404);
    return session;
  }

  private assertSessionExists(sessionId: string): void {
    if (!this.ports.liveRuntime.getSession(sessionId) && !this.ports.runtimeSessions.getById(sessionId)) {
      throw queryError('ZEUS_RUNTIME_SESSION_NOT_FOUND', 'AI Runtime session not found', 404);
    }
  }

  private readRendererTail(sessionId: string): { logs: AiRuntimeLogEntry[]; truncated: boolean } {
    const recentWithSentinel = this.ports.runtimeSessions.listRecentLogs(sessionId, 2_001).map(toAiRuntimeLogEntry);
    const truncatedByStorageProjection = recentWithSentinel.some((entry) => entry.id.startsWith('runtime_log_projection_marker_'));
    const truncatedByCount = recentWithSentinel.length > 2_000;
    const recent = truncatedByCount ? recentWithSentinel.slice(-2_000) : recentWithSentinel;
    const byteBudget = 4 * 1024 * 1024;
    const markerText = '[界面仅显示最近的 Runtime 日志；完整历史请使用分页检索或导出。]\n';
    const markerBytes = Buffer.byteLength(markerText);
    const kept: AiRuntimeLogEntry[] = [];
    let keptBytes = markerBytes;
    let compactedEntry = false;
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const entry = recent[index]!;
      const entryBytes = Buffer.byteLength(entry.text);
      if (keptBytes + entryBytes <= byteBudget) {
        kept.unshift(entry);
        keptBytes += entryBytes;
        continue;
      }
      if (kept.length === 0) {
        kept.unshift({ ...entry, text: compactUtf8Tail(entry.text, byteBudget - markerBytes) });
        compactedEntry = true;
      }
      break;
    }
    const truncated = truncatedByStorageProjection || compactedEntry || truncatedByCount || recent.length > kept.length;
    if (!truncated) return { logs: kept, truncated: false };
    return {
      truncated: true,
      logs: [
        {
          id: `${sessionId}-renderer-tail-marker`,
          sessionId,
          stream: 'system',
          text: markerText,
          createdAt: kept[0]?.createdAt ?? this.ports.now().toISOString(),
        },
        ...kept,
      ],
    };
  }
}

export function toAiRuntimeSessionOrUndefined(record: ZeusRuntimeSessionRecord | undefined): AiRuntimeSession | undefined {
  return record ? toAiRuntimeSession(record) : undefined;
}

export function toAiRuntimeSession(record: ZeusRuntimeSessionRecord): AiRuntimeSession {
  return {
    id: record.id,
    projectId: record.projectId,
    taskId: record.taskId ?? undefined,
    command: record.command,
    args: parseRuntimeArgs(record.argsJson),
    cwd: record.cwd,
    status: record.status,
    pid: record.pid ?? undefined,
    exitCode: record.exitCode,
    summary: record.summary,
    favorite: record.favorite,
    archived: record.archived,
    deletedAt: record.deletedAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? undefined,
  };
}

export function runtimeSessionIsConfirmedTerminal(session: { status: string; endedAt?: string | null }): boolean {
  return (session.status === 'exited' || session.status === 'failed' || session.status === 'stopped' || session.status === 'lost') && Boolean(session.endedAt);
}

export function toAiRuntimeLogEntry(record: ZeusRuntimeLogRecord): AiRuntimeLogEntry {
  return {
    id: record.id,
    sessionId: record.sessionId,
    stream: record.stream,
    text: record.text,
    createdAt: record.createdAt,
  };
}

export function parseRuntimeArgs(argsJson: string): string[] {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function compactUtf8Tail(text: string, byteBudget: number): string {
  const encoded = Buffer.from(text);
  if (encoded.byteLength <= byteBudget) return text;
  let start = Math.max(0, encoded.byteLength - byteBudget);
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
}

function matchesRuntimeSessionFilter(session: AiRuntimeSession, query: ListRuntimeSessionsQuery): boolean {
  if (query.projectId && session.projectId !== query.projectId) return false;
  if (query.taskId && session.taskId !== query.taskId) return false;
  if (query.archived === 'true' || query.favoriteOnly === 'true') return false;
  if (query.query) {
    const haystack = `${session.command}\n${session.cwd}\n${session.summary ?? ''}`.toLowerCase();
    if (!haystack.includes(query.query.toLowerCase())) return false;
  }
  return true;
}

function normalizeRuntimeLogStream(stream: RuntimeLogStream | undefined): RuntimeLogStream | undefined {
  return stream === 'system' || stream === 'stdout' || stream === 'stderr' ? stream : undefined;
}

function parseBoundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRuntimeAdapterId(value: string): value is AiCliAdapterDescriptor['id'] {
  return value === 'codex' || value === 'claude' || value === 'gemini' || value === 'generic';
}

function queryError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}
