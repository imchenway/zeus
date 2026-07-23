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

export type CodexDecodedFrame = { type: 'message'; message: CodexWireMessage } | { type: 'protocol_error'; error: { code: 'MALFORMED_JSON' | 'FRAME_TOO_LARGE' | 'INVALID_MESSAGE'; detail: string } };

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

export class CodexJsonLineDecoder {
  private static readonly maxPendingBytes = 4 * 1024 * 1024;
  private pending = Buffer.alloc(0);
  private discardingOversizedFrame = false;

  push(chunk: Buffer): CodexDecodedFrame[] {
    let nextChunk = chunk;
    if (this.discardingOversizedFrame) {
      const lf = nextChunk.indexOf(0x0a);
      if (lf < 0) return [];
      this.discardingOversizedFrame = false;
      nextChunk = nextChunk.subarray(lf + 1);
    }
    this.pending = Buffer.concat([this.pending, nextChunk]);
    const frames: CodexDecodedFrame[] = [];
    for (let lf = this.pending.indexOf(0x0a); lf >= 0; lf = this.pending.indexOf(0x0a)) {
      let line = this.pending.subarray(0, lf);
      this.pending = this.pending.subarray(lf + 1);
      if (line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      if (line.length > CodexJsonLineDecoder.maxPendingBytes) {
        frames.push({ type: 'protocol_error', error: { code: 'FRAME_TOO_LARGE', detail: `${line.length} bytes` } });
        continue;
      }
      try {
        const message = parseWireMessage(JSON.parse(line.toString('utf8')));
        if (message) frames.push({ type: 'message', message });
        else frames.push({ type: 'protocol_error', error: { code: 'INVALID_MESSAGE', detail: 'invalid wire message' } });
      } catch {
        frames.push({
          type: 'protocol_error',
          error: {
            code: 'MALFORMED_JSON',
            detail: 'invalid JSON',
          },
        });
      }
    }
    if (this.pending.length > CodexJsonLineDecoder.maxPendingBytes) {
      frames.push({
        type: 'protocol_error',
        error: { code: 'FRAME_TOO_LARGE', detail: `${this.pending.length} pending bytes` },
      });
      this.pending = Buffer.alloc(0);
      this.discardingOversizedFrame = true;
    }
    return frames;
  }
}

function parseWireMessage(value: unknown): CodexWireMessage | null {
  if (!isRecord(value)) return null;
  const hasId = Object.hasOwn(value, 'id');
  const hasMethod = Object.hasOwn(value, 'method');
  const hasParams = Object.hasOwn(value, 'params');
  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');
  if (hasId && !isWireId(value.id)) return null;

  if (hasMethod) {
    if (typeof value.method !== 'string' || value.method.length === 0 || !hasParams || hasResult || hasError) return null;
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
