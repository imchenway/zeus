import { redactUserFacingErrorDetails } from './userFacingError.js';

/** 单份诊断包最大 128 KiB；客户端和匿名接收入口使用同一上限。 */
export const faultReportMaxBytes = 128 * 1024;

/** 只采集定位所需身份，不包含会话正文、源码或附件。 */
export interface FaultReportInput {
  reportId: string;
  occurredAt: string;
  title: string;
  summary: string;
  code: string;
  operation: string;
  stack: string;
  context: Record<string, string>;
}

/** 运行事件保留时间、关联身份和经白名单投影的私有诊断内容。 */
export interface FaultReportEvent {
  timestamp: string;
  event: string;
  context: Record<string, string>;
  /** 私有诊断中的错误内容和状态；字段经过白名单投影。 */
  details?: Record<string, string | number | boolean | null>;
}

/** 采集结果说明缺失与截断，快照不包含消息、命令参数或工作区文件。 */
export interface FaultReportDiagnostics {
  collectedAt: string;
  build: Record<string, string>;
  snapshots: Record<string, Record<string, string | number | boolean | null>>;
  logs: FaultReportEvent[];
  notes: string[];
}

/** 云端收到的脱敏诊断包；应用版本和系统信息由 Main 填写。 */
export interface FaultReportPacket extends FaultReportInput {
  appVersion: string;
  platform: string;
  architecture: string;
  osVersion: string;
  events: FaultReportEvent[];
  diagnostics?: FaultReportDiagnostics;
}

/** 已落盘不等于 Issue 已创建，回执明确区分两种状态。 */
export interface FaultReportReceipt {
  reportId: string;
  status: 'received' | 'submitted';
  issueUrl?: string;
}

/** 只接受随机 UUID，避免报告身份变成任意文件路径。 */
export function isFaultReportId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

/** 复用现有秘密清理规则，诊断场景保留有界堆栈。 */
export function redactFaultReportText(value: unknown, maxLength = 16000): string {
  const text =
    typeof value === 'string' ? value.slice(0, faultReportMaxBytes).replace(/(?:file:\/\/)?(?:\/[^\n()]*|[A-Za-z]:\\[^\n()]*)[\\/]app\.asar[\\/](dist[\\/][^\s)]+)/gu, (_match, path: string) => `zeus://${path.replace(/\\/gu, '/')}`) : '';
  return redactUserFacingErrorDetails(text, { includeStack: true, maxLength })
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|LTAI[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})\b/gu, '[REDACTED]')
    .replace(/\baccess[_-]?key(?:[_-]?(?:id|secret))?\s*["']?\s*[:=]\s*["']?[^\s,;"']+/giu, 'AccessKey=[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[EMAIL]')
    .replace(/\b1[3-9]\d{9}\b/gu, '[PHONE]');
}

/** 身份采用白名单，拒绝将任意对象序列化到诊断包。 */
export function faultReportContext(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const source = { ...(record.details && typeof record.details === 'object' ? record.details : {}), ...(record.context && typeof record.context === 'object' ? record.context : {}), ...record } as Record<string, unknown>;
  return Object.fromEntries(
    ['projectId', 'taskId', 'conversationId', 'sessionId', 'runId', 'commandId', 'clientUserMessageId', 'turnId', 'providerId', 'providerThreadId', 'providerTurnId', 'requestId', 'traceId', 'view'].flatMap((key) => {
      const item = source[key];
      return typeof item === 'string' && /^[\w.:-]{1,160}$/u.test(item) ? [[key, item]] : [];
    }),
  );
}

/** 诊断只保留错误、关联身份和状态；嵌套原因最多四层，每组最多 8 KiB。 */
export function faultReportDetails(value: unknown, depth = 0): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== 'object' || depth > 4) return {};
  const fields = new Set([
    'id',
    'name',
    'code',
    'errorCode',
    'message',
    'detail',
    'details',
    'reason',
    'stack',
    'operation',
    'status',
    'statusCode',
    'providerStatus',
    'providerId',
    'providerState',
    'providerModel',
    'model',
    'phase',
    'stage',
    'agentKind',
    'transportKind',
    'runtimeKind',
    'state',
    'projectId',
    'taskId',
    'conversationId',
    'sessionId',
    'requestId',
    'traceId',
    'turnId',
    'providerThreadId',
    'providerTurnId',
    'nativeSessionId',
    'submissionId',
    'startedAt',
    'endedAt',
    'completedAt',
    'createdAt',
    'updatedAt',
    'stageUpdatedAt',
    'durationMs',
    'elapsedMs',
    'attempt',
    'pid',
    'exitCode',
    'signal',
    'throughEventSeq',
    'orderEpoch',
    'eventStreamGeneration',
    'hasError',
    'category',
    'truncated',
    'clientUserMessageId',
    'transportState',
    'realtimeSubscribed',
    'snapshotMatches',
    'activeOperation',
    'inFlightCount',
    'unresolvedAdmission',
    'deferredCount',
  ]);
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    const parts = key.split('.');
    if (parts.length <= 5 && fields.has(parts.at(-1)!) && parts.slice(0, -1).every((part) => ['error', 'cause', 'details'].includes(part))) {
      if (typeof item === 'string') result[key] = redactFaultReportText(item, key.endsWith('stack') || key.endsWith('details') ? 4000 : 2000);
      else if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) result[key] = item;
    }
    if (['error', 'cause', 'details'].includes(key) && item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [child, detail] of Object.entries(faultReportDetails(item, depth + 1))) result[`${key}.${child}`] = detail;
    }
    if (key === 'additionalDetails' && Array.isArray(item))
      result.details = redactFaultReportText(
        item
          .filter((entry) => typeof entry === 'string')
          .slice(0, 4)
          .join('\n'),
        4000,
      );
    if (Object.keys(result).length >= 48 || new TextEncoder().encode(JSON.stringify(result)).length > 8192) {
      delete result[key];
      result.truncated = true;
      break;
    }
  }
  const keys = Object.keys(result);
  let trimmed = false;
  while (new TextEncoder().encode(JSON.stringify(result)).length > 8128 && keys.length) {
    delete result[keys.pop()!];
    trimmed = true;
  }
  if (trimmed) result.truncated = true;
  return result;
}

/** 客户端与 FC 对完整诊断包使用相同投影，不让新字段在云端静默丢失。 */
export function normalizeFaultReportPacket(value: unknown): FaultReportPacket {
  const raw = value as Record<string, unknown>;
  const input = normalizeFaultReportInput(raw);
  const metadata = (key: string): string => {
    const item = redactFaultReportText(raw[key], 100);
    return /^[\w.+() -]{1,100}$/u.test(item) ? item : 'unknown';
  };
  const events = (entries: unknown): FaultReportEvent[] =>
    Array.isArray(entries)
      ? entries.slice(-100).flatMap((entry: unknown) => {
          if (!entry || typeof entry !== 'object') return [];
          const item = entry as Record<string, unknown>;
          return typeof item.timestamp === 'string' && Number.isFinite(Date.parse(item.timestamp)) && typeof item.event === 'string' && /^[\w.:-]{1,160}$/u.test(item.event)
            ? [{ timestamp: item.timestamp, event: redactFaultReportText(item.event, 160), context: faultReportContext(item.context), details: faultReportDetails(item.details) }]
            : [];
        })
      : [];
  const packet: FaultReportPacket = { ...input, appVersion: metadata('appVersion'), platform: metadata('platform'), architecture: metadata('architecture'), osVersion: metadata('osVersion'), events: events(raw.events) };
  if (raw.diagnostics && typeof raw.diagnostics === 'object') {
    const diagnostic = raw.diagnostics as Record<string, unknown>;
    const build = diagnostic.build && typeof diagnostic.build === 'object' ? (diagnostic.build as Record<string, unknown>) : {};
    const snapshots = diagnostic.snapshots && typeof diagnostic.snapshots === 'object' ? (diagnostic.snapshots as Record<string, unknown>) : {};
    packet.diagnostics = {
      collectedAt: typeof diagnostic.collectedAt === 'string' && Number.isFinite(Date.parse(diagnostic.collectedAt)) ? diagnostic.collectedAt : input.occurredAt,
      build: Object.fromEntries(['sha256', 'mode', 'electron', 'node', 'chrome'].flatMap((key) => (typeof build[key] === 'string' && /^[\w.+ -]{1,100}$/u.test(build[key] as string) ? [[key, build[key] as string]] : []))),
      snapshots: Object.fromEntries(
        ['request', 'conversation', 'openSegment', 'activeTurn', 'recentTurn1', 'recentTurn2', 'recentTurn3', 'runtimeSession'].flatMap((key) => (snapshots[key] ? [[key, faultReportDetails(snapshots[key])]] : [])),
      ),
      logs: events(diagnostic.logs),
      notes: Array.isArray(diagnostic.notes) ? diagnostic.notes.slice(0, 16).map((entry) => redactFaultReportText(entry, 400)) : [],
    };
  }
  return packet;
}

/** IPC 和 HTTP 边界使用同一严格字段投影。 */
export function normalizeFaultReportInput(value: unknown): FaultReportInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid fault report');
  const input = value as Record<string, unknown>;
  if (!isFaultReportId(input.reportId) || typeof input.occurredAt !== 'string' || !Number.isFinite(Date.parse(input.occurredAt))) throw new Error('Invalid fault report identity');
  return {
    reportId: input.reportId.toLowerCase(),
    occurredAt: new Date(input.occurredAt).toISOString(),
    title: redactFaultReportText(input.title, 200),
    summary: redactFaultReportText(input.summary, 2000),
    code: redactFaultReportText(input.code, 160),
    operation: redactFaultReportText(input.operation, 200),
    stack: redactFaultReportText(input.stack),
    context: faultReportContext(input.context),
  };
}
