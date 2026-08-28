/* eslint-disable @typescript-eslint/no-explicit-any -- 真机验收探针需要读取多种异构 HTTP JSON 响应。 */
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { memoryHeadCommandScopeId } from '../packages/local-server/src/memoryContextApi.js';
import { workManagementInputSha256 } from '../packages/local-server/src/workManagementCommandApplication.js';

const baseUrl = requiredEnvironment('ZEUS_PROBE_BASE_URL').replace(/\/$/u, '');
const apiToken = requiredEnvironment('ZEUS_PROBE_API_TOKEN');
const projectRoot = resolve(requiredEnvironment('ZEUS_PROBE_PROJECT_ROOT'));
const projectId = `project_${randomUUID().replaceAll('-', '')}`;
const projectInput = {
  name: 'ZARCH 隔离验收',
  localPath: projectRoot,
  description: '仅用于独立 Zeus Test 根的 Memory、Context 与 Provider 验收。',
};

const projectCreate = await request('/api/projects', {
  method: 'POST',
  body: workManagementRequest({ commandType: 'work_management.project.create', scopeId: projectId, operationIdentity: projectId, input: projectInput, inputSha256: workManagementInputSha256(projectInput) }),
});
if (projectCreate.status !== 201) throw new Error(`创建隔离项目失败：${projectCreate.status} ${JSON.stringify(projectCreate.body)}`);

const observedAt = new Date().toISOString();
const memoryInput = {
  memoryKey: 'zarch.isolated_acceptance_boundary',
  scope: { kind: 'project', id: projectId },
  candidateKind: 'safety_boundary',
  content: 'ZARCH 真机验收必须使用独立 Zeus Test 数据根，禁止续接正式 Provider 线程或复制正式凭据。',
  effect: 'external_state',
  source: { kind: 'user_explicit', reference: 'ZARCH-001～ZARCH-063 已确认计划', observedAt },
  confirmationLevel: 'explicit',
  confidence: 1,
  reviewAfter: '2027-08-21T00:00:00.000Z',
};
const memoryOperationIdentity = `memory_${randomUUID().replaceAll('-', '')}`;
const memoryCreate = await request('/api/memory/candidates', {
  method: 'POST',
  body: {
    command: commandEnvelope({
      commandType: 'memory.candidate.record',
      scopeKind: 'memory',
      scopeId: memoryHeadCommandScopeId(memoryInput),
      operationIdentity: memoryOperationIdentity,
      inputSha256: sha256(canonicalJson(memoryInput)),
    }),
    input: memoryInput,
  },
});
if (memoryCreate.status !== 201) throw new Error(`记录隔离 Memory 失败：${memoryCreate.status} ${JSON.stringify(memoryCreate.body)}`);

const memoryList = await request(`/api/memory?scopeKind=project&scopeId=${encodeURIComponent(projectId)}&limit=100`);
const memoryResolved = await request(`/api/memory/resolved?projectId=${encodeURIComponent(projectId)}`);
const contextPreview = await request(`/api/projects/${encodeURIComponent(projectId)}/tasks/task_zarch_acceptance/context/preview`, {
  method: 'POST',
  body: {
    taskCode: 'TASK_20260820_001',
    operationRisk: 'external_state',
    provider: {
      id: 'codex',
      contextWindowTokens: 128_000,
      reservedOutputTokens: 8_192,
      currentInputTokens: 0,
      capabilities: { applicationContext: true, untrustedContext: true, portableContext: true },
    },
    minimumMemoryConfidence: 0.5,
    maximumCompiledTokens: 32_000,
  },
});
if (contextPreview.status !== 200) throw new Error(`Context 编译预览失败：${contextPreview.status} ${JSON.stringify(contextPreview.body)}`);

console.log(
  JSON.stringify(
    {
      status: 'passed',
      projectId,
      projectCreate: { status: projectCreate.status, replayed: projectCreate.body.replayed ?? null },
      memoryCreate: {
        status: memoryCreate.status,
        replayed: memoryCreate.body.replayed ?? null,
        recordId: memoryCreate.body.record?.id ?? null,
        confirmationLevel: memoryCreate.body.record?.confirmationLevel ?? null,
        effect: memoryCreate.body.record?.effect ?? null,
      },
      memoryList: {
        status: memoryList.status,
        count: memoryList.body.items?.length ?? 0,
        hasMore: memoryList.body.hasMore ?? null,
      },
      memoryResolved: {
        status: memoryResolved.status,
        selectedCount: memoryResolved.body.selected?.length ?? 0,
        reviewRequiredCount: memoryResolved.body.reviewRequired?.length ?? 0,
      },
      contextPreview: {
        status: contextPreview.status,
        coverage: contextPreview.body.coverage ?? null,
        selectedMemoryIds: contextPreview.body.memory?.selectedIds ?? [],
        taskDocument: contextPreview.body.taskDocument ?? null,
        compiled: contextPreview.body.compiled
          ? {
              operationRisk: contextPreview.body.compiled.operationRisk,
              includedFragmentCount: contextPreview.body.compiled.included?.length ?? contextPreview.body.compiled.sections?.length ?? null,
              tokenCount: contextPreview.body.compiled.tokenCount ?? contextPreview.body.compiled.totalTokens ?? null,
            }
          : null,
      },
    },
    null,
    2,
  ),
);

function workManagementRequest(input: { commandType: string; scopeId: string; operationIdentity: string; input: Record<string, unknown>; inputSha256: string }): Record<string, unknown> {
  return {
    command: commandEnvelope({ commandType: input.commandType, scopeKind: 'project', scopeId: input.scopeId, operationIdentity: input.operationIdentity, inputSha256: input.inputSha256 }),
    input: input.input,
  };
}

function commandEnvelope(input: { commandType: string; scopeKind: 'project' | 'memory'; scopeId: string; operationIdentity: string; inputSha256: string }): Record<string, unknown> {
  return {
    schemaGeneration: 'zeus-command-envelope-v1',
    commandId: randomUUID(),
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'zarch-isolated-acceptance' },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: null,
    idempotencyKey: randomUUID(),
    issuedAt: new Date().toISOString(),
    payload: { operationIdentity: input.operationIdentity, inputSha256: input.inputSha256 },
  };
}

async function request(path: string, input: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: { Authorization: `Bearer ${apiToken}`, ...(input.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Memory input 不是 JSON 数据。');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}
