import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { release } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  faultReportContext,
  faultReportDetails,
  faultReportMaxBytes,
  isFaultReportId,
  normalizeFaultReportInput,
  normalizeFaultReportPacket,
  type FaultReportDiagnostics,
  type FaultReportEvent,
  type FaultReportInput,
  type FaultReportPacket,
  type FaultReportReceipt,
} from '@zeus/shared';

/** 公共上报入口不包含凭据，所有 OSS 与 GitHub 授权留在 FC。 */
const faultReportEndpoint = 'https://zeus-report.hyphatech.cn/reports';

/** 每个进程只计算一次安装包 SHA-256，避免每次上报重复读取整个文件。 */
let archiveFingerprint: Promise<string> | undefined;

/** 对完整 ASAR 原始字节计算指纹，便于维护者匹配同一客户端产物。 */
async function fingerprintArchive(path: string): Promise<string> {
  const fs = createRequire(import.meta.url)('original-fs') as typeof import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** 只读取故障前后五分钟的关联事件，保留私有错误内容而排除其他会话。 */
async function collectFaultEvents(logPath: string, report: FaultReportInput, notes: string[]): Promise<FaultReportEvent[]> {
  const file = await open(logPath, 'r').catch((error: NodeJS.ErrnoException) => {
    notes.push(`host.log: ${error.code ?? 'unavailable'}`);
    return null;
  });
  if (!file) return [];
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - 256 * 1024);
    if (start > 0) notes.push('host.log: 仅扫描末尾 256 KiB；更早的记录可能未覆盖。');
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    let unreadable = 0;
    const events = lines.flatMap((line): FaultReportEvent[] => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (typeof entry.timestamp !== 'string' || Math.abs(Date.parse(entry.timestamp) - Date.parse(report.occurredAt)) > 300000 || !Number.isFinite(Date.parse(entry.timestamp))) return [];
        if (typeof entry.event !== 'string' || !/^[\w.:-]{1,160}$/u.test(entry.event)) return [];
        let detail = entry;
        if (typeof entry.detail === 'string' && ['renderer_runtime_error', 'conversation_delivery'].includes(entry.event)) {
          try {
            const wrapped = JSON.parse(entry.detail) as Record<string, unknown>;
            if (wrapped.kind === 'application_error' || wrapped.kind === 'conversation_delivery') detail = wrapped;
          } catch {
            /* 旧文本日志不推测会话归属。 */
          }
        }
        const context = faultReportContext(detail);
        const scopes = ['conversationId', 'sessionId', 'runId', 'commandId', 'taskId'];
        if (scopes.some((key) => context[key] && report.context[key] && context[key] !== report.context[key])) return [];
        if (scopes.some((key) => context[key]) && !scopes.some((key) => context[key] && context[key] === report.context[key])) return [];
        if (entry.event === 'renderer_runtime_error' && detail.reportId !== report.reportId && !scopes.some((key) => context[key] && context[key] === report.context[key])) return [];
        return [{ timestamp: entry.timestamp, event: entry.event, context, details: faultReportDetails(detail) }];
      } catch {
        unreadable++;
        return [];
      }
    });
    if (unreadable) notes.push(`host.log: ${unreadable} 条记录无法解析。`);
    if (events.length > 60) notes.push('host.log: 仅保留故障窗口内最后 60 条关联事件。');
    if (!events.length) notes.push('host.log: 故障时间窗口内无可用的关联事件。');
    return events.slice(-60);
  } finally {
    await file.close();
  }
}

/** 只使用当前宿主身份读取既有查询接口，异常不会阻止本机诊断落盘。 */
async function collectCoreDiagnostics(report: FaultReportInput, core: { baseUrl: string; apiToken: string } | undefined, diagnostic: FaultReportDiagnostics): Promise<void> {
  if (!core) {
    diagnostic.notes.push('Core: 当前宿主不可用，未取得运行状态。');
    return;
  }
  const origin = new URL(core.baseUrl);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)) throw new Error('Invalid local diagnostic origin');
  /** 接口均为只读查询；认证头不会进入诊断包。 */
  const read = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${core.baseUrl}${path}`, { headers: { authorization: `Bearer ${core.apiToken}` }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('response exceeds 1 MiB');
    return JSON.parse(text) as Record<string, unknown>;
  };
  const { projectId, conversationId, sessionId } = report.context;
  await Promise.all([
    (async () => {
      if (!report.context.traceId) return;
      try {
        const performance = await read('/api/diagnostics/performance?recentLimit=100');
        const api = performance.api as Record<string, unknown> | undefined;
        const sample = Array.isArray(api?.recent)
          ? (api.recent.find((entry: unknown) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).traceId === report.context.traceId) as Record<string, unknown> | undefined)
          : undefined;
        if (!sample) {
          diagnostic.notes.push('request: 最近 100 条服务端记录中没有找到同一 trace ID。');
          return;
        }
        const details = faultReportDetails({ ...sample, operation: `${sample.method} ${sample.route}` });
        diagnostic.snapshots.request = details;
        if (typeof sample.completedAt === 'string') diagnostic.logs.push({ timestamp: sample.completedAt, event: 'local_api.request', context: { traceId: report.context.traceId }, details });
      } catch (error) {
        diagnostic.notes.push(`request: ${error instanceof Error ? error.message : 'unavailable'}`);
      }
    })(),
    (async () => {
      if (!projectId || !conversationId) {
        diagnostic.notes.push('conversation: 无关联会话，未读取会话快照。');
        return;
      }
      try {
        const snapshot = await read(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/snapshot-v2?closedTurns=3&byteLimit=65536&includeMetrics=false`);
        const conversation = snapshot.conversation as Record<string, unknown> | undefined;
        if (conversation?.id !== conversationId || conversation.projectId !== projectId) throw new Error('scope mismatch');
        diagnostic.snapshots.conversation = faultReportDetails(conversation);
        if (snapshot.openSegment) diagnostic.snapshots.openSegment = faultReportDetails(snapshot.openSegment);
        if (snapshot.activeTurn) diagnostic.snapshots.activeTurn = faultReportDetails(snapshot.activeTurn);
        if (Array.isArray(snapshot.recentClosedTurns))
          snapshot.recentClosedTurns.slice(0, 3).forEach((turn, index) => {
            diagnostic.snapshots[`recentTurn${index + 1}`] = faultReportDetails(turn);
          });
        diagnostic.notes.push('conversation: 快照为上报时刻状态；未采集消息正文、计划、工具输出和工作区文件。');
      } catch (error) {
        diagnostic.notes.push(`conversation: ${error instanceof Error ? error.message : 'unavailable'}`);
      }
    })(),
    (async () => {
      if (!sessionId) {
        diagnostic.notes.push('runtime: 无关联终端会话；未采集终端日志。');
        return;
      }
      try {
        const session = await read(`/api/runtime/sessions/${encodeURIComponent(sessionId)}`);
        if (session.id !== sessionId || (projectId && session.projectId !== projectId)) throw new Error('scope mismatch');
        diagnostic.snapshots.runtimeSession = faultReportDetails(session);
        const count = await read(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/logs?stream=system&limit=1`);
        const total = typeof count.total === 'number' && Number.isSafeInteger(count.total) && count.total >= 0 ? count.total : 0;
        const page = await read(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/logs?stream=system&limit=50&offset=${Math.max(0, total - 50)}`);
        if (total > 50) diagnostic.notes.push('runtime.system: 仅采集最后 50 条系统日志。');
        if (Array.isArray(page.items))
          for (const entry of page.items) {
            if (!entry || typeof entry !== 'object') continue;
            const log = entry as Record<string, unknown>;
            if (log.stream !== 'system' || typeof log.text !== 'string' || typeof log.createdAt !== 'string' || Math.abs(Date.parse(log.createdAt) - Date.parse(report.occurredAt)) > 300000) continue;
            const message = log.text.startsWith('启动 AI Runtime 会话：') ? '启动 AI Runtime 会话（命令与参数未采集）' : log.text;
            diagnostic.logs.push({ timestamp: log.createdAt, event: 'runtime.system', context: { sessionId }, details: faultReportDetails({ message }) });
          }
        diagnostic.notes.push('runtime: 仅采集系统诊断，未采集命令正文、stdout 和 stderr。');
      } catch (error) {
        diagnostic.notes.push(`runtime: ${error instanceof Error ? error.message : 'unavailable'}`);
      }
    })(),
  ]);
}

/** 本机保存脱敏副本后再发送；重试保持报告身份和原始采集时间。 */
export async function submitFaultReport(input: unknown, options: { directory: string; hostLog: string; appVersion: string; archivePath?: string; core?: { baseUrl: string; apiToken: string } }): Promise<FaultReportReceipt> {
  const report = normalizeFaultReportInput(input);
  const packetPath = join(options.directory, `${report.reportId}.json`);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const diagnostic: FaultReportDiagnostics = {
    collectedAt: new Date().toISOString(),
    build: { mode: options.archivePath ? 'packaged' : 'development', electron: process.versions.electron ?? 'unknown', node: process.versions.node, chrome: process.versions.chrome ?? 'unknown' },
    snapshots: {},
    logs: [],
    notes: [],
  };
  const [events] = await Promise.all([
    collectFaultEvents(options.hostLog, report, diagnostic.notes).catch((error: unknown) => {
      diagnostic.notes.push(`host.log: ${error instanceof Error ? error.message : 'unavailable'}`);
      return [];
    }),
    collectCoreDiagnostics(report, options.core, diagnostic).catch((error: unknown) => {
      diagnostic.notes.push(`Core: ${error instanceof Error ? error.message : 'unavailable'}`);
    }),
    options.archivePath
      ? (archiveFingerprint ??= fingerprintArchive(options.archivePath))
          .then((sha256) => {
            diagnostic.build.sha256 = sha256;
          })
          .catch(() => {
            diagnostic.notes.push('build: 无法计算安装包 SHA-256。');
          })
      : Promise.resolve(),
  ]);
  if (process.env.ZEUS_DEV_SERVER_URL) diagnostic.notes.push('Renderer 使用开发服务器；构建指纹仅标识已打包客户端。');
  const packet: FaultReportPacket = normalizeFaultReportPacket({
    ...report,
    appVersion: options.appVersion,
    platform: process.platform,
    architecture: process.arch,
    osVersion: release(),
    events,
    diagnostics: diagnostic,
  });
  let omitted = 0;
  while (Buffer.byteLength(JSON.stringify(packet)) > faultReportMaxBytes - 1024 && (packet.events.length || packet.diagnostics!.logs.length)) {
    if (packet.events.length) packet.events.shift();
    else packet.diagnostics!.logs.shift();
    omitted++;
  }
  if (omitted) packet.diagnostics!.notes.push(`budget: 128 KiB 上限省略了 ${omitted} 条较早日志。`);
  const serialized = JSON.stringify(packet);
  if (Buffer.byteLength(serialized) > faultReportMaxBytes) throw new Error('诊断包超过大小限制。');
  await writeFile(packetPath, serialized, { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const content = await readFile(packetPath, 'utf8');
  try {
    const response = await fetch(faultReportEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: content,
      signal: AbortSignal.timeout(45000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const receipt = (await response.json()) as FaultReportReceipt;
    if (receipt.reportId !== report.reportId || !['received', 'submitted'].includes(receipt.status)) throw new Error('Invalid receipt');
    if (receipt.status === 'submitted' && !/^https:\/\/github\.com\/imchenway\/zeus\/issues\/\d+$/u.test(receipt.issueUrl ?? '')) throw new Error('Invalid issue URL');
    return receipt;
  } catch {
    throw new Error('暂时无法确认上报结果，请稍后重试。');
  }
}

/** 只允许导出已采集的报告，不接受 Renderer 提供文件路径。 */
export async function exportFaultReport(reportId: unknown, directory: string, target: string): Promise<void> {
  if (!isFaultReportId(reportId)) throw new Error('Invalid fault report identity');
  await copyFile(join(directory, `${reportId.toLowerCase()}.json`), target);
}
