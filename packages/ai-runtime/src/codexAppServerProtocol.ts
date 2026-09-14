export type CodexWireId = string | number;

export type CodexWireResponse = {
  id: CodexWireId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type CodexWireNotification = {
  method: string;
  params: unknown;
};

export type CodexWireServerRequest = {
  id: CodexWireId;
  method: string;
  params: unknown;
};

export type CodexWireMessage = CodexWireResponse | CodexWireNotification | CodexWireServerRequest;

/** 传输帧独立于界面预览和事件队列预算，与 WebSocket 的默认帧上限一致。 */
export const codexMaximumFrameBytes = 100 * 1024 * 1024;

/** 解码失败只携带结构诊断，不保留可能包含凭据或消息正文的原始帧。 */
export type CodexDecodedFrame = { type: 'message'; message: CodexWireMessage } | { type: 'protocol_error'; error: { code: 'MALFORMED_JSON' | 'FRAME_TOO_LARGE' | 'INVALID_MESSAGE'; detail: string; byteLength: number } };

export type ExternalAgentConfigMigrationItemType = 'AGENTS_MD' | 'CONFIG' | 'SKILLS' | 'PLUGINS' | 'MCP_SERVER_CONFIG' | 'SUBAGENTS' | 'HOOKS' | 'COMMANDS' | 'SESSIONS' | (string & {});

export interface ExternalAgentSessionMigration {
  path: string;
  cwd: string | null;
  title: string | null;
}

export interface ExternalAgentMigrationDetails {
  sessions?: ExternalAgentSessionMigration[];
  [key: string]: unknown;
}

export interface ExternalAgentConfigMigrationItem {
  itemType: ExternalAgentConfigMigrationItemType;
  description: string;
  cwd: string | null;
  details: ExternalAgentMigrationDetails | null;
}

export interface ExternalAgentConfigDetectParams {
  includeHome?: boolean;
  cwds?: string[] | null;
  source?: string | null;
  migrationSource?: string | null;
}

export interface ExternalAgentConfigDetectResponse {
  items: ExternalAgentConfigMigrationItem[];
}

export interface ExternalAgentConfigImportParams {
  migrationItems: ExternalAgentConfigMigrationItem[];
  source?: string | null;
  migrationSource?: string | null;
}

export interface ExternalAgentConfigImportResponse {
  importId: string;
}

export interface ExternalAgentImportSuccess {
  itemType: ExternalAgentConfigMigrationItemType;
  cwd: string | null;
  source: string;
  target: string;
}

export interface ExternalAgentImportFailure {
  itemType: ExternalAgentConfigMigrationItemType;
  errorType: string;
  failureStage: string;
  message: string;
  cwd: string | null;
  source: string;
}

export interface ExternalAgentImportItemTypeResult {
  itemType: ExternalAgentConfigMigrationItemType;
  successes: ExternalAgentImportSuccess[];
  failures: ExternalAgentImportFailure[];
}

export type ExternalAgentImportNotification = {
  type: 'progress' | 'completed';
  importId: string;
  itemTypeResults: ExternalAgentImportItemTypeResult[];
};

export interface ExternalAgentConfigImportHistory {
  importId: string;
  completedAtMs: bigint;
  successes: ExternalAgentImportSuccess[];
  failures: ExternalAgentImportFailure[];
}

export interface ExternalAgentConfigImportHistoriesResponse {
  data: ExternalAgentConfigImportHistory[];
}

export function parseExternalAgentConfigDetectResponse(value: unknown): ExternalAgentConfigDetectResponse {
  const response = protocolRecord(value, 'externalAgentConfig/detect response');
  if (!Array.isArray(response.items)) throw protocolShapeError('externalAgentConfig/detect response omitted items.');
  return { items: response.items.map(parseMigrationItem) };
}

export function parseExternalAgentConfigImportResponse(value: unknown): ExternalAgentConfigImportResponse {
  const response = protocolRecord(value, 'externalAgentConfig/import response');
  return { importId: protocolNonBlankString(response.importId, 'externalAgentConfig/import importId') };
}

export function parseExternalAgentImportNotification(method: string, value: unknown): ExternalAgentImportNotification {
  const type = method === 'externalAgentConfig/import/progress' ? 'progress' : method === 'externalAgentConfig/import/completed' ? 'completed' : null;
  if (type === null) throw protocolShapeError(`Unsupported external-agent import notification: ${method}`);
  const params = protocolRecord(value, `${method} params`);
  if (!Array.isArray(params.itemTypeResults)) throw protocolShapeError(`${method} omitted itemTypeResults.`);
  return {
    type,
    importId: protocolNonBlankString(params.importId, `${method} importId`),
    itemTypeResults: params.itemTypeResults.map(parseImportItemTypeResult),
  };
}

export function parseExternalAgentConfigImportHistoriesResponse(value: unknown): ExternalAgentConfigImportHistoriesResponse {
  const response = protocolRecord(value, 'externalAgentConfig/import/readHistories response');
  if (!Array.isArray(response.data)) throw protocolShapeError('externalAgentConfig/import/readHistories response omitted data.');
  return {
    data: response.data.map((entry) => {
      const history = protocolRecord(entry, 'external-agent import history');
      if (!Array.isArray(history.successes) || !Array.isArray(history.failures)) throw protocolShapeError('External-agent import history omitted results.');
      return {
        importId: protocolNonBlankString(history.importId, 'external-agent import history importId'),
        completedAtMs: protocolBigInt(history.completedAtMs, 'external-agent import history completedAtMs'),
        successes: history.successes.map((success) => parseImportSuccess(success, null)),
        failures: history.failures.map(parseImportFailure),
      };
    }),
  };
}

/** 按换行消费完整帧；跨块内容只在帧结束时合并一次。 */
export class CodexJsonLineDecoder {
  /** 未结束帧的独立分块，避免持有同一大输入块中的其他完整帧。 */
  private pending: Buffer[] = [];
  /** 累计原始字节数，中文跨块时仍按字节限制内存。 */
  private pendingBytes = 0;
  /** 超限后只丢弃当前帧，下一行仍可正常解码。 */
  private discardingOversizedFrame = false;

  /** 读取每个分块一次，坏帧不吞掉同一输入块中的后续合法帧。 */
  push(chunk: Buffer): CodexDecodedFrame[] {
    /** 本次读取产出的完整消息和诊断。 */
    const frames: CodexDecodedFrame[] = [];
    for (let offset = 0; offset < chunk.length; ) {
      /** 在当前分块中寻找帧边界，无换行时只保存剩余片段。 */
      const lf = chunk.indexOf(0x0a, offset);
      /** 同一帧的本次片段。 */
      const part = chunk.subarray(offset, lf < 0 ? chunk.length : lf);
      offset = lf < 0 ? chunk.length : lf + 1;
      if (this.discardingOversizedFrame) {
        if (lf >= 0) this.discardingOversizedFrame = false;
        continue;
      }
      this.pendingBytes += part.length;
      if (this.pendingBytes > codexMaximumFrameBytes) {
        frames.push({ type: 'protocol_error', error: { code: 'FRAME_TOO_LARGE', detail: 'frame exceeded transport limit', byteLength: this.pendingBytes } });
        this.pending = [];
        this.pendingBytes = 0;
        this.discardingOversizedFrame = lf < 0;
        continue;
      }
      if (lf < 0) {
        this.pending.push(Buffer.from(part));
        continue;
      }
      /** 完整帧无需复制；只有跨分块帧才一次性合并。 */
      let line = this.pending.length ? Buffer.concat([...this.pending, part], this.pendingBytes) : part;
      this.pending = [];
      this.pendingBytes = 0;
      if (line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      try {
        /** 字节帧完整后才解码 UTF-8，避免拆坏中文字符。 */
        const message = parseWireMessage(JSON.parse(line.toString('utf8')));
        if (message) frames.push({ type: 'message', message });
        else frames.push({ type: 'protocol_error', error: { code: 'INVALID_MESSAGE', detail: 'invalid wire message', byteLength: line.length } });
      } catch {
        frames.push({
          type: 'protocol_error',
          error: {
            code: 'MALFORMED_JSON',
            detail: 'invalid JSON',
            byteLength: line.length,
          },
        });
      }
    }
    return frames;
  }
}

function parseWireMessage(value: unknown): CodexWireMessage | null {
  if (!isRecord(value)) return null;
  const hasId = Object.hasOwn(value, 'id');
  const hasMethod = Object.hasOwn(value, 'method');
  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');
  if (hasId && !isWireId(value.id)) return null;

  if (hasMethod) {
    if (typeof value.method !== 'string' || value.method.length === 0 || hasResult || hasError) return null;
    return hasId ? { id: value.id as CodexWireId, method: value.method, params: value.params } : { method: value.method, params: value.params };
  }

  if (!hasId || hasResult === hasError) return null;
  if (hasError) {
    if (!isRecord(value.error) || typeof value.error.code !== 'number' || !Number.isFinite(value.error.code) || typeof value.error.message !== 'string') return null;
    return {
      id: value.id as CodexWireId,
      error: {
        code: value.error.code,
        message: value.error.message,
        ...(Object.hasOwn(value.error, 'data') ? { data: value.error.data } : {}),
      },
    };
  }
  return { id: value.id as CodexWireId, result: value.result };
}

function isWireId(value: unknown): value is CodexWireId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMigrationItem(value: unknown): ExternalAgentConfigMigrationItem {
  const item = protocolRecord(value, 'external-agent migration item');
  const details = item.details === null ? null : parseMigrationDetails(item.details);
  return {
    itemType: protocolNonBlankString(item.itemType, 'external-agent migration itemType'),
    description: protocolString(item.description, 'external-agent migration description'),
    cwd: protocolNullableString(item.cwd, 'external-agent migration cwd'),
    details,
  };
}

function parseMigrationDetails(value: unknown): ExternalAgentMigrationDetails {
  const details = protocolRecord(value, 'external-agent migration details');
  if (!Object.hasOwn(details, 'sessions')) return { ...details };
  if (!Array.isArray(details.sessions)) throw protocolShapeError('External-agent migration sessions must be an array.');
  return {
    ...details,
    sessions: details.sessions.map((entry) => {
      const session = protocolRecord(entry, 'external-agent session migration');
      return {
        path: protocolNonBlankString(session.path, 'external-agent session path'),
        cwd: protocolNullableString(session.cwd, 'external-agent session cwd'),
        title: protocolNullableString(session.title, 'external-agent session title'),
      };
    }),
  };
}

function parseImportItemTypeResult(value: unknown): ExternalAgentImportItemTypeResult {
  const result = protocolRecord(value, 'external-agent import item result');
  const itemType = protocolNonBlankString(result.itemType, 'external-agent import result itemType');
  if (!Array.isArray(result.successes) || !Array.isArray(result.failures)) throw protocolShapeError('External-agent import item result omitted successes or failures.');
  return {
    itemType,
    successes: result.successes.map((entry) => parseImportSuccess(entry, itemType)),
    failures: result.failures.map(parseImportFailure),
  };
}

function parseImportSuccess(value: unknown, parentItemType: string | null): ExternalAgentImportSuccess {
  const success = protocolRecord(value, 'external-agent import success');
  const itemType = protocolNonBlankString(success.itemType, 'external-agent import success itemType');
  const target = protocolString(success.target, 'external-agent import success target');
  if ((parentItemType === 'SESSIONS' || itemType === 'SESSIONS') && target.trim().length === 0) {
    throw protocolShapeError('External-agent SESSIONS import success requires a nonblank target.');
  }
  return {
    itemType,
    cwd: protocolNullableString(success.cwd, 'external-agent import success cwd'),
    source: protocolString(success.source, 'external-agent import success source'),
    target,
  };
}

function parseImportFailure(value: unknown): ExternalAgentImportFailure {
  const failure = protocolRecord(value, 'external-agent import failure');
  return {
    itemType: protocolNonBlankString(failure.itemType, 'external-agent import failure itemType'),
    errorType: protocolString(failure.errorType, 'external-agent import failure errorType'),
    failureStage: protocolString(failure.failureStage, 'external-agent import failure failureStage'),
    message: protocolString(failure.message, 'external-agent import failure message'),
    cwd: protocolNullableString(failure.cwd, 'external-agent import failure cwd'),
    source: protocolString(failure.source, 'external-agent import failure source'),
  };
}

function protocolRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw protocolShapeError(`${label} must be an object.`);
  return value;
}

function protocolString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw protocolShapeError(`${label} must be a string.`);
  return value;
}

function protocolNonBlankString(value: unknown, label: string): string {
  const result = protocolString(value, label);
  if (result.trim().length === 0) throw protocolShapeError(`${label} must be nonblank.`);
  return result;
}

function protocolNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return protocolString(value, label);
}

function protocolBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw protocolShapeError(`${label} must be an exact integer.`);
}

function protocolShapeError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'ZEUS_CODEX_INVALID_RESPONSE' });
}
