import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeFaultReportInput, redactFaultReportText, isFaultReportId, faultReportMaxBytes } from '../packages/shared/src/faultReport.ts';
import { handler } from '../infrastructure/fault-report/index.ts';

/** 诊断保留堆栈，同时清除凭据和本地路径。 */
const cleaned = redactFaultReportText('Error: failed\n    at start (/Users/example/private/source.ts:10:2)\nAuthorization: Bearer secret-value\napi_key=private-key-value');
assert.match(cleaned, /at start/u);
assert.doesNotMatch(cleaned, /secret-value|private-key-value|example\/private/u);
/** 报告投影不允许正文、路径和附件混入身份信息。 */
const id = randomUUID();
const normalized = normalizeFaultReportInput({ reportId: id, occurredAt: new Date().toISOString(), title: '故障', context: { conversationId: 'conversation-123', content: 'private text' }, attachments: ['private.png'] });
assert.deepEqual(normalized.context, { conversationId: 'conversation-123' });
assert.equal('attachments' in normalized, false);
assert.equal(isFaultReportId('../secret'), false);
/** 边界拒绝在访问云存储之前完成，不使用替身网络或真实凭据。 */
const invoke = (method, path, body = '') => handler(Buffer.from(JSON.stringify({ requestContext: { http: { method, path } }, body })), {});
assert.equal((await invoke('GET', '/health')).statusCode, 200);
assert.equal((await invoke('DELETE', '/reports')).statusCode, 404);
assert.equal((await invoke('POST', '/reports', '{')).statusCode, 400);
assert.equal((await invoke('POST', '/reports', 'x'.repeat(faultReportMaxBytes + 1))).statusCode, 413);
console.log('fault report boundary check passed');
