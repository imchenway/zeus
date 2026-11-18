import { createHash, createHmac, createSign, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  faultReportMaxBytes,
  faultEvidenceCompressedMaxBytes,
  faultEvidenceMaxBytes,
  faultReportServiceCapabilities,
  isFaultReportId,
  normalizeFaultReportPacket,
  redactFaultReportText,
  type FaultReportPacket,
  type FaultReportReceipt,
} from '../../packages/shared/src/faultReport.js';
import { describeUserFacingError } from '../../packages/shared/src/userFacingError.js';

/** 故障服务只操作专用桶和指定仓库，客户端不能提供资源地址。 */
const bucket = 'imchenway-zeus-diagnostics';
/** OSS 与 FC 同地域，使用内网端点避免诊断包走公网。 */
const region = 'cn-hangzhou';
/** 公开 Issue 只包含定位身份和环境，完整诊断留在私有 OSS。 */
const repository = 'imchenway/zeus';

/** FC 运行角色提供短期凭据，不设置长期 AccessKey。 */
interface FunctionContext {
  credentials: { accessKeyId: string; accessKeySecret: string; securityToken: string };
}

/** 首行保存诊断包，后续行只追加状态；已保存的现场不会被覆盖。 */
interface StoredReport {
  packet: FaultReportPacket;
  state: 'received' | 'creating' | 'submitted';
  issueUrl?: string;
}

/** 追加位置是 OSS 提供的原子写入条件，单位为 UTF-8 字节。 */
interface ReportSnapshot {
  value: StoredReport;
  position: number;
}

/** SHA-256 用于 OSS 签名和匿名限流键，不持久化来源 IP。 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 生成 OSS 签名派生密钥。 */
function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

/** 对固定桶的单对象读写使用 OSS 官方 HMAC-SHA256 签名。 */
async function objectRequest(context: FunctionContext, method: 'GET' | 'POST', key: string, body: string | Uint8Array = '', position = 0): Promise<Response> {
  const credentials = context.credentials;
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, '');
  const date = timestamp.slice(0, 8);
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-oss-date': timestamp,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-security-token': credentials.securityToken,
  };
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]!.trim()}\n`)
    .join('');
  const path = key.split('/').map(encodeURIComponent).join('/');
  const query = method === 'POST' ? `append&position=${position}` : '';
  const canonical = [method, `/${bucket}/${path}`, query, canonicalHeaders, '', 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${date}/${region}/oss/aliyun_v4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`aliyun_v4${credentials.accessKeySecret}`, date), region), 'oss'), 'aliyun_v4_request');
  const signature = hmac(signingKey, `OSS4-HMAC-SHA256\n${timestamp}\n${scope}\n${digest(canonical)}`).toString('hex');
  headers.authorization = `OSS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope},Signature=${signature}`;
  return fetch(`https://${bucket}.oss-${region}-internal.aliyuncs.com/${path}${query ? `?${query}` : ''}`, {
    method,
    headers,
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : new Uint8Array(body).buffer } : {}),
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
  });
}

/** 私有对象不存在才返回空；权限和网络错误不能当成新报告。 */
async function readObject(context: FunctionContext, key: string): Promise<string | null> {
  const response = await objectRequest(context, 'GET', key);
  if (response.status === 404) return null;
  if (!response.ok) throw await storageError(response, 'read');
  return response.text();
}

/** 只记录供应商错误码和说明，不记录可能包含临时凭据的签名回显。 */
async function storageError(response: Response, operation: string): Promise<Error> {
  const xml = await response.text();
  return new Error(`OSS ${operation} ${response.status} ${xml.match(/<Code>([^<]+)</u)?.[1] ?? ''}: ${redactFaultReportText(xml.match(/<Message>([^<]+)</u)?.[1], 300)}`);
}

/** 每次成功追加一个字节就是一次计数，跨实例并发由 OSS 位置校验裁决。 */
async function consumeQuota(context: FunctionContext, key: string, limit: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readObject(context, key);
    const count = current?.length ?? 0;
    if (count >= limit) return false;
    const result = await objectRequest(context, 'POST', key, '1', count);
    if (result.ok) return true;
    if (result.status !== 409) throw await storageError(result, 'quota');
  }
  return false;
}

/** 按顺序恢复追加日志中的最新回执，原始诊断只保存一份。 */
async function readReport(context: FunctionContext, key: string): Promise<ReportSnapshot | null> {
  const text = await readObject(context, key);
  if (text === null) return null;
  const lines = text.trimEnd().split('\n');
  const value = JSON.parse(lines[0]!) as StoredReport;
  for (const line of lines.slice(1)) Object.assign(value, JSON.parse(line));
  return { value, position: Buffer.byteLength(text) };
}

/** 两个调用读取同一位置时，仅一个调用可以追加状态并获得提交权。 */
async function appendReportState(context: FunctionContext, key: string, stored: ReportSnapshot, change: Pick<StoredReport, 'state' | 'issueUrl'>): Promise<ReportSnapshot | null> {
  const line = `${JSON.stringify(change)}\n`;
  const result = await objectRequest(context, 'POST', key, line, stored.position);
  if (result.status === 409) return null;
  if (!result.ok) throw await storageError(result, 'state');
  return { ...stored, value: { ...stored.value, ...change }, position: stored.position + Buffer.byteLength(line) };
}

/** 按单仓库安装身份签发十分钟内有效的 GitHub App JWT。 */
async function installationToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: process.env.GITHUB_APP_ID })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(process.env.GITHUB_APP_PRIVATE_KEY!, 'base64url')}`;
  const result = await github(`/app/installations/${process.env.GITHUB_INSTALLATION_ID}/access_tokens`, jwt, { method: 'POST', body: JSON.stringify({ repositories: ['zeus'], permissions: { issues: 'write' } }) });
  if (!result.ok) throw new Error(`GitHub token ${result.status}`);
  return ((await result.json()) as { token: string }).token;
}

/** GitHub 请求只发往官方 API，错误日志不记录令牌或响应正文。 */
function github(path: string, token: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'Zeus-Fault-Reports', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(12000),
    redirect: 'error',
  }).catch((error: unknown) => {
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
    throw new Error(`GitHub network ${typeof cause?.code === 'string' ? cause.code : 'unavailable'}`);
  });
}

/** 对外只返回不可猜的报告身份和 Issue 地址。 */
function receipt(report: StoredReport): FaultReportReceipt {
  return { reportId: report.packet.reportId, status: report.state === 'submitted' ? 'submitted' : 'received', ...(report.issueUrl ? { issueUrl: report.issueUrl } : {}) };
}

/** 已发出但结果未知时只查找原 Issue，避免重试生成重复 Issue。 */
async function reconcileIssue(context: FunctionContext, key: string, stored: ReportSnapshot): Promise<FaultReportReceipt> {
  if (stored.value.state !== 'creating') return receipt(stored.value);
  const token = await installationToken();
  const query = encodeURIComponent(`repo:${repository} in:body "${stored.value.packet.reportId}"`);
  const response = await github(`/search/issues?q=${query}&per_page=10`, token);
  if (!response.ok) return receipt(stored.value);
  const marker = `<!-- zeus-report:${stored.value.packet.reportId} -->`;
  // 搜索索引迟到时继续保留待确认状态，不能重新发送创建请求。
  const issue = ((await response.json()) as { items: Array<{ body: string; html_url: string }> }).items.find((item) => item.body?.includes(marker));
  if (issue) {
    const updated = await appendReportState(context, key, stored, { state: 'submitted', issueUrl: issue.html_url });
    return receipt((updated ?? (await readReport(context, key)) ?? stored).value);
  }
  return receipt(stored.value);
}

/** 落盘后再创建 Issue；创建状态用条件写入保证只有一个调用发送请求。 */
async function createIssue(context: FunctionContext, key: string, stored: ReportSnapshot): Promise<FaultReportReceipt> {
  if (stored.value.state !== 'received') return reconcileIssue(context, key, stored);
  const token = await installationToken();
  const claimed = await appendReportState(context, key, stored, { state: 'creating' });
  if (!claimed) return receipt(((await readReport(context, key)) ?? stored).value);
  const packet = stored.value.packet;
  const code = /^[A-Z][A-Z0-9_]{1,159}$/u.test(packet.code) ? packet.code : 'RUNTIME_ERROR';
  const operation = /^[\w.:-]{1,160}$/u.test(packet.operation) ? packet.operation : /^(GET|POST|PUT|PATCH|DELETE) /u.test(packet.operation) ? `HTTP_${packet.operation.split(' ')[0]}` : 'unknown';
  const frames = [...packet.stack.matchAll(/zeus:\/\/dist\/[\w./-]+:\d+(?::\d+)?/gu)].slice(0, 12).map((match) => `at ${match[0]}`);
  const timeline = [...packet.events, ...(packet.diagnostics?.logs ?? [])]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-12)
    .filter((entry) => /^[\w.:-]{1,160}$/u.test(entry.event))
    .map((entry) => {
      const detail = entry.details ?? {};
      const status =
        typeof detail.statusCode === 'number' && detail.statusCode >= 100 && detail.statusCode <= 599
          ? `HTTP ${detail.statusCode}`
          : ['running', 'failed', 'exited', 'completed', 'active', 'interrupted', 'stopped', 'waiting', 'queued'].includes(String(detail.status))
            ? String(detail.status)
            : '';
      return `${entry.timestamp} ${entry.event}${status ? ` (${status})` : ''}`;
    });
  const diagnosticUrl = `https://oss.console.aliyun.com/bucket/oss-${region}/${bucket}/object?path=${encodeURIComponent(key)}`;
  const build = packet.diagnostics?.build;
  const issueBody = [
    `<!-- zeus-report:${packet.reportId} -->`,
    `### 故障摘要\n${describeUserFacingError({ code }, 'zh-CN').message}`,
    '',
    `- 报告 ID：\`${packet.reportId}\``,
    `- 时间：${packet.occurredAt}`,
    `- 错误码：\`${code}\``,
    `- 操作：\`${operation}\``,
    `- Zeus：${packet.appVersion}`,
    `- 系统：${packet.platform} / ${packet.architecture} / ${packet.osVersion}`,
    `- 构建 SHA-256：\`${build?.sha256 && /^[a-f0-9]{64}$/u.test(build.sha256) ? build.sha256 : '未采集'}\``,
    '',
    '### Zeus 调用位置',
    frames.length ? ['```text', ...frames, '```'].join('\n') : '未提供可公开的 Zeus 调用位置。错误原文、堆栈及原因链见私有诊断。',
    '',
    '### 关联事件',
    timeline.length ? ['```text', ...timeline, '```'].join('\n') : '故障时间窗口内未采集到关联宿主事件。',
    '',
    '### 维护者诊断',
    `[读取私有诊断包（需要阿里云维护者权限）](${diagnosticUrl})`,
    `- 对象：\`${key}\`；下载后先核对报告 ID。`,
    `- 采集：${packet.events.length} 条宿主事件、${packet.diagnostics?.logs.length ?? 0} 条运行诊断日志、${Object.keys(packet.diagnostics?.snapshots ?? {}).length + (packet.commandDelivery ? 1 : 0)} 组状态快照。`,
    packet.diagnostics ? `- 采集限制与失败说明：${packet.diagnostics.notes.length} 项，详见包内 \`diagnostics.notes\`。` : '- 此报告来自旧采集器，缺少状态快照和采集完整性说明。',
    ...(packet.diagnostics?.scene?.attachments ?? []).map(
      (attachment) =>
        `- 私有现场附件（上传状态以对象是否存在为准）：[${attachment.name}](https://oss.console.aliyun.com/bucket/oss-${region}/${bucket}/object?path=${encodeURIComponent(`reports/${packet.reportId}/evidence/${attachment.sha256}.gz`)})；SHA-256：\`${attachment.sha256}\`。`,
    ),
    '- 完整脱敏错误、原因链与运行诊断保留在私有包；公开页面不放对话正文、工作区文件或终端输出。',
  ].join('\n');
  const response = await github(`/repos/${repository}/issues`, token, { method: 'POST', body: JSON.stringify({ title: `[Zeus 故障] ${code} · ${packet.appVersion}`.slice(0, 240), body: issueBody }) }).catch(async (error: unknown) => {
    // 连接尚未建立的错误没有发送请求；其他超时仍保留待核对状态。
    if (error instanceof Error && /^GitHub network (ENOTFOUND|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT)$/u.test(error.message)) await appendReportState(context, key, claimed, { state: 'received' });
    throw error;
  });
  if (!response.ok) {
    // 明确拒绝未产生 Issue；服务器错误的结果仍按未知保留，不能盲目重发。
    if (response.status >= 400 && response.status < 500) {
      const reset = await appendReportState(context, key, claimed, { state: 'received' });
      return receipt((reset ?? (await readReport(context, key)) ?? claimed).value);
    }
    return receipt(claimed.value);
  }
  const issue = (await response.json()) as { html_url: string };
  const saved = await appendReportState(context, key, claimed, { state: 'submitted', issueUrl: issue.html_url });
  return receipt((saved ?? (await readReport(context, key)) ?? claimed).value);
}

/** HTTP 回执禁止缓存，不向匿名调用者暴露配置或诊断内容。 */
function response(statusCode: number, body: unknown): { statusCode: number; headers: Record<string, string>; body: string } {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

/** 用运行角色把报告身份放入同一函数的原生异步队列，不传输完整诊断。 */
async function enqueueReport(context: FunctionContext, reportId: string): Promise<void> {
  const host = '1859603669648286.cn-hangzhou.fc.aliyuncs.com';
  const path = '/2023-03-30/functions/zeus-fault-reports/invocations';
  const query = 'qualifier=LATEST';
  const body = JSON.stringify({ source: 'zeus-fault-report-delivery', reportId });
  const headers: Record<string, string> = {
    host,
    'content-type': 'application/octet-stream',
    'x-acs-action': 'InvokeFunction',
    'x-acs-version': '2023-03-30',
    'x-acs-date': new Date().toISOString().replace(/\.\d{3}/u, ''),
    'x-acs-signature-nonce': randomUUID(),
    'x-acs-content-sha256': digest(body),
    'x-acs-security-token': context.credentials.securityToken,
    'x-fc-invocation-type': 'Async',
  };
  const names = Object.keys(headers).sort();
  const signed = names.join(';');
  const canonical = ['POST', path, query, names.map((name) => `${name}:${headers[name]}\n`).join(''), signed, digest(body)].join('\n');
  const signature = hmac(context.credentials.accessKeySecret, `ACS3-HMAC-SHA256\n${digest(canonical)}`).toString('hex');
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${context.credentials.accessKeyId},SignedHeaders=${signed},Signature=${signature}`;
  const result = await fetch(`https://${host}${path}?${query}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (result.status !== 202) throw new Error(`FC enqueue ${result.status}`);
}

/** HTTP 先保存诊断并回执；队列任务使用 FC 原生异步重试完成建单。 */
export async function handler(event: Buffer, context: FunctionContext): Promise<ReturnType<typeof response>> {
  let asynchronous = false;
  try {
    const request = JSON.parse(event.toString()) as { source?: string; reportId?: string; rawPath?: string; body?: string; isBase64Encoded?: boolean; requestContext?: { http?: { method?: string; path?: string; sourceIp?: string } } };
    if (!request.requestContext && request.source === 'zeus-fault-report-delivery') {
      asynchronous = true;
      if (!isFaultReportId(request.reportId)) throw new Error('Invalid queued report');
      const key = `reports/${request.reportId}.jsonl`;
      const stored = await readReport(context, key);
      if (!stored || (await createIssue(context, key, stored)).status !== 'submitted') throw new Error('GitHub delivery pending');
      return response(200, { status: 'delivered' });
    }
    const method = request.requestContext?.http?.method;
    const path = request.rawPath ?? request.requestContext?.http?.path ?? '';
    if (method === 'GET' && path === '/health') return response(200, { status: 'ok', capabilities: faultReportServiceCapabilities });
    /** 附件只能补充到已接收报告的固定清单中，不能借此写入任意 OSS 对象。 */
    const evidenceRoute = /^\/reports\/([a-f0-9-]{36})\/evidence\/([a-f0-9]{64})$/u.exec(path);
    if (method === 'POST' && evidenceRoute) {
      const [, id, sha256] = evidenceRoute;
      if (!isFaultReportId(id) || typeof request.body !== 'string' || request.body.length > faultEvidenceCompressedMaxBytes * 2) return response(400, { error: 'INVALID_EVIDENCE' });
      const stored = await readReport(context, `reports/${id}.jsonl`);
      const expected = stored?.value.packet.diagnostics?.scene?.attachments.find((entry) => entry.sha256 === sha256);
      if (!expected) return response(404, { error: 'EVIDENCE_NOT_DECLARED' });
      /** 解析与校验失败返回 400，云端存储故障继续使用外层的 503。 */
      let compressed: Buffer;
      try {
        const body = request.isBase64Encoded ? Buffer.from(request.body, 'base64').toString('utf8') : request.body;
        const attachment = JSON.parse(body) as { name?: string; bytes?: number; sha256?: string; gzip?: string };
        if (attachment.name !== expected.name || attachment.bytes !== expected.bytes || attachment.sha256 !== sha256 || typeof attachment.gzip !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(attachment.gzip))
          return response(400, { error: 'INVALID_EVIDENCE' });
        compressed = Buffer.from(attachment.gzip, 'base64');
        if (compressed.length > faultEvidenceCompressedMaxBytes) return response(413, { error: 'EVIDENCE_TOO_LARGE' });
        const raw = gunzipSync(compressed, { maxOutputLength: faultEvidenceMaxBytes });
        if (raw.length !== expected.bytes || createHash('sha256').update(raw).digest('hex') !== sha256) return response(400, { error: 'EVIDENCE_DIGEST_MISMATCH' });
      } catch {
        return response(400, { error: 'INVALID_EVIDENCE' });
      }
      const saved = await objectRequest(context, 'POST', `reports/${id}/evidence/${sha256}.gz`, compressed, 0);
      if (!saved.ok && saved.status !== 409) throw await storageError(saved, 'save evidence');
      return response(200, { reportId: id, sha256 });
    }
    if (method === 'GET' && path.startsWith('/reports/')) {
      const id = path.slice('/reports/'.length).toLowerCase();
      if (!isFaultReportId(id)) return response(400, { error: 'INVALID_REPORT' });
      const stored = await readReport(context, `reports/${id}.jsonl`);
      return stored ? response(200, await reconcileIssue(context, `reports/${id}.jsonl`, stored)) : response(404, { error: 'NOT_FOUND' });
    }
    if (method !== 'POST' || path !== '/reports') return response(404, { error: 'NOT_FOUND' });
    if (typeof request.body !== 'string' || request.body.length > faultReportMaxBytes * 2) return response(413, { error: 'REPORT_TOO_LARGE' });
    const body = request.isBase64Encoded ? Buffer.from(request.body, 'base64').toString('utf8') : request.body;
    if (Buffer.byteLength(body) > faultReportMaxBytes) return response(413, { error: 'REPORT_TOO_LARGE' });
    let packet: FaultReportPacket;
    try {
      packet = normalizeFaultReportPacket(JSON.parse(body));
    } catch {
      return response(400, { error: 'INVALID_REPORT' });
    }
    const key = `reports/${packet.reportId}.jsonl`;
    const existing = await readReport(context, key);
    if (existing?.value.state === 'submitted') return response(200, receipt(existing.value));
    if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY || !process.env.GITHUB_INSTALLATION_ID) return response(503, { error: 'SERVICE_NOT_READY' });
    const day = new Date().toISOString().slice(0, 10);
    const hour = new Date().toISOString().slice(0, 13);
    const ip = createHmac('sha256', process.env.GITHUB_APP_PRIVATE_KEY)
      .update(request.requestContext?.http?.sourceIp ?? 'unknown')
      .digest('hex');
    if (!(await consumeQuota(context, `limits/ip/${hour}/${ip}.count`, 5))) return response(429, { error: 'RATE_LIMITED' });
    if (existing) {
      await enqueueReport(context, packet.reportId);
      return response(200, receipt(existing.value));
    }
    if (!(await consumeQuota(context, `limits/day/${day}.count`, 500))) return response(429, { error: 'RATE_LIMITED' });
    const stored: StoredReport = { packet, state: 'received' };
    const content = `${JSON.stringify(stored)}\n`;
    const saved = await objectRequest(context, 'POST', key, content, 0);
    if (saved.status === 409) return response(200, { reportId: packet.reportId, status: 'received' });
    if (!saved.ok) throw await storageError(saved, 'save');
    await enqueueReport(context, packet.reportId);
    return response(200, receipt(stored));
  } catch (error) {
    console.error('fault_report_failed', error instanceof Error ? redactFaultReportText(error.message, 500) : 'Error');
    if (asynchronous) throw error;
    return response(503, { error: 'REPORT_UNCONFIRMED' });
  }
}
