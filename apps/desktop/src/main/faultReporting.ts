import { copyFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { publishFile } from '@zeus/storage/platform-security';
import { basename, dirname, join } from 'node:path';
import { release } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  faultReportContext,
  faultReportDetails,
  faultReportMaxBytes,
  faultEvidenceCompressedMaxBytes,
  faultReportServiceCapabilities,
  isFaultReportId,
  normalizeFaultReportInput,
  normalizeFaultReportPacket,
  redactFaultReportText,
  type FaultReportDiagnostics,
  type FaultReportEvent,
  type FaultReportInput,
  type FaultReportPacket,
  type FaultReportReceipt,
} from '@zeus/shared';

/** 既有错误弹窗和独立守护进程使用同一个采集与保存契约。 */
export interface FaultReportOptions {
  directory: string;
  hostLog: string;
  appVersion: string;
  archivePath?: string;
  core?: { baseUrl: string; apiToken: string };
}

/** 异步压缩避免较大的转储阻塞恢复窗口和重启按钮。 */
const compressEvidence = promisify(gzip);

/** 完整刷新临时内容后原子发布，已有报告不覆盖，Windows 沿用写穿透移动。 */
export async function writeFrozenFaultPacket(path: string, content: string): Promise<string> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await publishFile(temporary, path, { replace: false }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return readFile(path, 'utf8');
}

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
  /** 诊断中只显示固定日志文件名，不泄露本机数据根路径。 */
  const logName = basename(logPath);
  const file = await open(logPath, 'r').catch((error: NodeJS.ErrnoException) => {
    notes.push(`${logName}: ${error.code ?? 'unavailable'}`);
    return null;
  });
  if (!file) return [];
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - 256 * 1024);
    if (start > 0) notes.push(`${logName}: 仅扫描末尾 256 KiB；更早的记录可能未覆盖。`);
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
        if (entry.event === 'execution_host.uncaught' && Array.isArray(entry.frames))
          detail = {
            ...entry,
            stack: entry.frames
              .filter((frame) => typeof frame === 'string')
              .slice(0, 12)
              .join('\n'),
          };
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
    if (unreadable) notes.push(`${logName}: ${unreadable} 条记录无法解析。`);
    if (events.length > 60) notes.push(`${logName}: 仅保留故障窗口内最后 60 条关联事件。`);
    if (!events.length) notes.push(`${logName}: 故障时间窗口内无可用的关联事件。`);
    return events.slice(-60);
  } finally {
    await file.close();
  }
}

/** 只使用当前宿主身份读取既有查询接口，异常不会阻止本机诊断落盘。 */
async function collectCoreDiagnostics(report: FaultReportInput, core: { baseUrl: string; apiToken: string } | undefined, diagnostic: FaultReportDiagnostics, signal: AbortSignal): Promise<void> {
  if (!core) {
    diagnostic.notes.push('Core: 当前宿主不可用，未取得运行状态。');
    return;
  }
  const origin = new URL(core.baseUrl);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)) throw new Error('Invalid local diagnostic origin');
  /** 接口均为只读查询；认证头不会进入诊断包。 */
  const read = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${core.baseUrl}${path}`, { headers: { authorization: `Bearer ${core.apiToken}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('response exceeds 1 MiB');
    return JSON.parse(text) as Record<string, unknown>;
  };
  const { projectId, conversationId, sessionId } = report.context;
  await Promise.all([
    (async () => {
      if (!report.context.traceId) {
        diagnostic.notes.push('request: 报告未记录请求 trace ID，未采集关联请求日志。');
        return;
      }
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

/** 主包大小有界；省略旧记录时保留明确缺口，用户补充材料不能让上传永久失败。 */
function serializeFaultPacket(packet: FaultReportPacket): string {
  let omitted = 0;
  let snapshotsOmitted = 0;
  const snapshots = ['recentTurn3', 'recentTurn2', 'recentTurn1', 'runtimeSession', 'openSegment', 'conversation', 'request', 'activeTurn'];
  while (Buffer.byteLength(JSON.stringify(packet)) > faultReportMaxBytes - 1024) {
    if (packet.events.length) {
      packet.events.shift();
      omitted++;
    } else if (packet.diagnostics?.logs.length) {
      packet.diagnostics.logs.shift();
      omitted++;
    } else if (packet.diagnostics?.scene?.breadcrumbs.length) {
      packet.diagnostics.scene.breadcrumbs.shift();
      omitted++;
    } else {
      const key = snapshots.shift();
      if (!key) break;
      if (packet.diagnostics?.snapshots[key]) {
        delete packet.diagnostics.snapshots[key];
        snapshotsOmitted++;
      }
    }
  }
  if ((omitted || snapshotsOmitted) && packet.diagnostics) {
    packet.diagnostics.notes = packet.diagnostics.notes.slice(0, 15);
    packet.diagnostics.notes.push(`budget: 128 KiB 上限省略了 ${omitted} 条较早日志和 ${snapshotsOmitted} 组状态快照。`);
  }
  const content = JSON.stringify(packet);
  if (Buffer.byteLength(content) > faultReportMaxBytes) throw new Error('诊断包超过大小限制。');
  return content;
}

/** 最多采集五秒并冻结到本机；后续重试只读取同一现场，不重新采集。 */
export async function saveFaultReport(input: unknown, options: FaultReportOptions, scene?: FaultReportDiagnostics['scene'], notes: string[] = []): Promise<FaultReportPacket> {
  const report = normalizeFaultReportInput(input);
  const packetPath = join(options.directory, `${report.reportId}.json`);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const existing = await readFile(packetPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) return normalizeFaultReportPacket(JSON.parse(existing));
  const diagnostic: FaultReportDiagnostics = {
    collectedAt: new Date().toISOString(),
    build: { mode: options.archivePath ? 'packaged' : 'development', electron: process.versions.electron ?? 'unknown', node: process.versions.node, chrome: process.versions.chrome ?? 'unknown' },
    snapshots: {},
    logs: [],
    notes: [...notes],
    ...(scene ? { scene } : {}),
  };
  /** 故障时 Core 或安装盘也可能无响应，整个采集阶段共用期限。 */
  const controller = new AbortController();
  /** 已完成的日志读取独立保留，其他采集超时不能抹掉它。 */
  let events: FaultReportEvent[] = [];
  /** 期限到达后不等待仍未结束的文件读取或构建哈希。 */
  let collectionTimer: ReturnType<typeof setTimeout>;
  await Promise.race([
    Promise.all([
      Promise.all(
        [options.hostLog, join(dirname(options.hostLog), 'host-error.log')].map((path) =>
          collectFaultEvents(path, report, diagnostic.notes).catch((error: NodeJS.ErrnoException) => {
            diagnostic.notes.push(`${basename(path)}: ${error.code ?? 'unavailable'}`);
            return [];
          }),
        ),
      )
        .then((values) =>
          values
            .flat()
            .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
            .slice(-60),
        )
        .catch((error: unknown) => {
          diagnostic.notes.push(`host.log: ${error instanceof Error ? error.message : 'unavailable'}`);
          return [];
        })
        .then((value) => {
          events = value;
        }),
      collectCoreDiagnostics(report, options.core, diagnostic, controller.signal).catch((error: unknown) => {
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
    ]),
    new Promise<void>((resolveDeadline) => {
      collectionTimer = setTimeout(() => {
        diagnostic.notes.push('collection: 达到五秒采集期限；尚未取得的证据未包含在本次现场。');
        controller.abort();
        resolveDeadline();
      }, 5_000);
    }),
  ]).finally(() => clearTimeout(collectionTimer));
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
  const serialized = serializeFaultPacket(packet);
  return normalizeFaultReportPacket(JSON.parse(await writeFrozenFaultPacket(packetPath, serialized)));
}

/** 将用户补充和原始现场合成固定提交副本，保存本身不会联网。 */
export async function prepareFaultSubmission(reportId: string, directory: string, reproduction?: string): Promise<{ content: string; packet: FaultReportPacket }> {
  if (!isFaultReportId(reportId)) throw new Error('Invalid fault report identity');
  let content = await readFile(join(directory, `${reportId}.json`), 'utf8');
  let packet = normalizeFaultReportPacket(JSON.parse(content));
  if (packet.reportId !== reportId) throw new Error('Fault report identity mismatch');
  /** 首次上报冻结补充文字；重试使用同一提交内容，不覆盖原始采集现场。 */
  const submissionPath = join(directory, `${reportId}.submission.json`);
  const existing = await readFile(submissionPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) content = existing;
  else {
    if (packet.diagnostics && reproduction) packet.diagnostics.reproduction = redactFaultReportText(reproduction, 4000);
    content = serializeFaultPacket(packet);
    content = await writeFrozenFaultPacket(submissionPath, content);
  }
  packet = normalizeFaultReportPacket(JSON.parse(content));
  if (packet.reportId !== reportId) throw new Error('Fault submission identity mismatch');
  return { content, packet };
}

/** 点击上报才上传已保存的现场；主包和全部附件共用同一个网络期限。 */
export async function uploadSavedFaultReport(reportId: string, directory: string, timeoutMs = 45_000, cancellation?: AbortSignal, reproduction?: string): Promise<FaultReportReceipt> {
  const { content, packet } = await prepareFaultSubmission(reportId, directory, reproduction);
  /** 用户选择立即重启时取消上传，不删除本机已保存的报告。 */
  const signal = cancellation ? AbortSignal.any([cancellation, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  /** 主包接收和附件接收分开记录，不能把部分完成显示成完整上报。 */
  let accepted = false;
  /** 出错阶段只写本机诊断，不记录认证头或附件内容。 */
  let stage = packet.diagnostics?.scene ? 'capabilities' : 'report';
  try {
    if (packet.diagnostics?.scene) {
      const health = await fetch(new URL('/health', faultReportEndpoint), { signal, redirect: 'error' });
      const capabilities = health.ok ? ((await health.json()) as { capabilities?: unknown }).capabilities : null;
      if (!Array.isArray(capabilities) || !faultReportServiceCapabilities.every((capability) => capabilities.includes(capability))) throw new Error('Fault evidence service is not ready');
    }
    stage = 'report';
    const response = await fetch(faultReportEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: content,
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const receipt = (await response.json()) as FaultReportReceipt;
    if (receipt.reportId !== reportId || !['received', 'submitted'].includes(receipt.status)) throw new Error('Invalid receipt');
    if (receipt.status === 'submitted' && !/^https:\/\/github\.com\/imchenway\/zeus\/issues\/\d+$/u.test(receipt.issueUrl ?? '')) throw new Error('Invalid issue URL');
    accepted = true;
    stage = 'evidence';
    for (const attachment of packet.diagnostics?.scene?.attachments ?? []) {
      const bytes = await readFile(join(directory, `${reportId}.evidence`, attachment.name));
      if (bytes.length !== attachment.bytes || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) throw new Error('Fault evidence identity mismatch');
      const compressed = await compressEvidence(bytes);
      if (compressed.length > faultEvidenceCompressedMaxBytes) throw new Error('Fault evidence exceeds upload limit');
      signal.throwIfAborted();
      const evidenceResponse = await fetch(`${faultReportEndpoint}/${reportId}/evidence/${attachment.sha256}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        redirect: 'error',
        body: JSON.stringify({ name: attachment.name, bytes: attachment.bytes, sha256: attachment.sha256, gzip: compressed.toString('base64') }),
      });
      if (!evidenceResponse.ok) throw new Error(`Evidence HTTP ${evidenceResponse.status}`);
      const evidenceReceipt = (await evidenceResponse.json()) as { reportId?: string; sha256?: string };
      if (evidenceReceipt.reportId !== reportId || evidenceReceipt.sha256 !== attachment.sha256) throw new Error('Invalid evidence receipt');
    }
    stage = 'receipt';
    await writeFrozenFaultPacket(join(directory, `${reportId}.receipt.json`), JSON.stringify(receipt));
    await rm(join(directory, `${reportId}.pending.json`), { force: true });
    return receipt;
  } catch (error) {
    void writeFile(join(directory, `${reportId}.delivery.json`), JSON.stringify({ failedAt: new Date().toISOString(), stage, accepted, detail: redactFaultReportText(error instanceof Error ? error.message : String(error), 1000) }), {
      mode: 0o600,
    }).catch(() => undefined);
    throw new Error(
      stage === 'receipt'
        ? '故障报告已接收，但本机回执保存失败；请保留本机报告并稍后核对。'
        : accepted
          ? '故障摘要已接收，现场附件尚未完整确认；本机报告已保留，可稍后重试。'
          : stage === 'capabilities'
            ? '当前无法确认上报服务支持故障现场；报告已保存在本机，可稍后重试。'
            : '暂时无法确认上报结果，请稍后重试。',
      { cause: error },
    );
  }
}

/** 普通错误弹窗保留原入口，保存成功后才开始联网。 */
export async function submitFaultReport(input: unknown, options: FaultReportOptions): Promise<FaultReportReceipt> {
  const packet = await saveFaultReport(input, options);
  return uploadSavedFaultReport(packet.reportId, options.directory);
}

/** 只允许导出已采集的报告，不接受 Renderer 提供文件路径。 */
export async function exportFaultReport(reportId: unknown, directory: string, target: string): Promise<void> {
  if (!isFaultReportId(reportId)) throw new Error('Invalid fault report identity');
  await copyFile(join(directory, `${reportId.toLowerCase()}.json`), target);
}
