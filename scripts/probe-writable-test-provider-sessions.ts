/* eslint-disable @typescript-eslint/no-explicit-any -- 真机验收探针需要保留 Provider 失败响应的原始异构结构。 */
import { randomUUID } from 'node:crypto';
import { graphConversationInputSha256 } from '../packages/local-server/src/graphConversationCommandApplication.js';
import { workManagementInputSha256 } from '../packages/local-server/src/workManagementCommandApplication.js';

const baseUrl = requiredEnvironment('ZEUS_PROBE_BASE_URL').replace(/\/$/u, '');
const apiToken = requiredEnvironment('ZEUS_PROBE_API_TOKEN');
const projectId = requiredEnvironment('ZEUS_PROBE_PROJECT_ID');
const codexModel = process.env.ZEUS_PROBE_CODEX_MODEL?.trim() || 'gpt-5.4-mini';
const codexEffort = process.env.ZEUS_PROBE_CODEX_EFFORT?.trim() || 'low';
const piOnly = process.env.ZEUS_PROBE_PI_ONLY === '1';
const codexOnly = process.env.ZEUS_PROBE_CODEX_ONLY === '1';
const piModelRef = codexOnly ? null : requiredEnvironment('ZEUS_PROBE_PI_MODEL_REF');
const formalCredentialAuthorized = process.env.ZEUS_PROBE_FORMAL_CREDENTIAL_AUTHORIZED === '1';
const taskId = `task_${randomUUID().replaceAll('-', '')}`;
const taskInput = {
  projectId,
  title: 'ZARCH Provider 隔离会话验收',
  description: '只在独立 Zeus Test 根中新建 Codex/Pi 会话，不续接正式线程。',
  taskType: 'requirement',
  allowCodeChanges: false,
  allowTests: false,
  allowGitCommit: false,
};
const taskCreate = await request('/api/tasks', {
  method: 'POST',
  body: commandRequest({ commandType: 'work_management.task.create', scopeKind: 'task', scopeId: taskId, operationIdentity: taskId, input: taskInput, inputSha256: workManagementInputSha256(taskInput) }),
});

const codexInput = {
  mode: 'create',
  agentKind: 'codex',
  content: '只回复 ZARCH-ISOLATED-CODEX-OK，不调用工具。',
  model: codexModel,
  effort: codexEffort,
  permissionMode: 'read-only',
  collaborationMode: 'default',
};
const codex = piOnly
  ? { status: 0, body: { error: 'SKIPPED_BY_PI_ONLY_PROBE' } }
  : await request(`/api/projects/${encodeURIComponent(projectId)}/conversations`, {
      method: 'POST',
      timeoutMs: 60_000,
      body: commandRequest({
        commandType: 'conversation.project.create',
        scopeKind: 'project',
        scopeId: projectId,
        operationIdentity: `provider_codex_${randomUUID().replaceAll('-', '')}`,
        input: codexInput,
        inputSha256: graphConversationInputSha256(codexInput),
      }),
    });

const piInput = {
  mode: 'create',
  agentKind: 'pi',
  content: '只回复 ZARCH-ISOLATED-PI-OK，不调用工具。',
  model: piModelRef ?? '',
  permissionMode: 'read-only',
  collaborationMode: 'default',
};
const pi = codexOnly
  ? { status: 0, body: { error: 'SKIPPED_BY_CODEX_ONLY_PROBE' } }
  : taskCreate.status === 201
  ? await request(`/api/tasks/${encodeURIComponent(taskId)}/conversations`, {
      method: 'POST',
      timeoutMs: 60_000,
      body: commandRequest({
        commandType: 'conversation.task.create',
        scopeKind: 'task',
        scopeId: taskId,
        operationIdentity: `provider_pi_${randomUUID().replaceAll('-', '')}`,
        input: piInput,
        inputSha256: graphConversationInputSha256(piInput),
      }),
    })
  : { status: 0, body: { error: 'TASK_CREATE_FAILED' } };

const piConversationId = resultConversationId(pi);
const codexConversationId = resultConversationId(codex);
const codexCompletion = codex.status >= 200 && codex.status < 300 && codexConversationId ? await waitForCompletion(codexConversationId) : null;
const piCompletion = pi.status >= 200 && pi.status < 300 && piConversationId ? await waitForCompletion(piConversationId) : null;

const health = await request('/api/diagnostics/provider-runtimes');
const projectChoices = await request(`/api/projects/${encodeURIComponent(projectId)}/conversation-choices`);
const taskChoices = taskCreate.status === 201 ? await request(`/api/tasks/${encodeURIComponent(taskId)}/conversation-choices`) : { status: 0, body: {} };

console.log(
  JSON.stringify(
    {
      status:
        (piOnly ||
          (codex.status >= 200 && codex.status < 300 && codexCompletion?.terminalStatus === 'completed' && codexCompletion.assistantReply === 'ZARCH-ISOLATED-CODEX-OK')) &&
        (codexOnly || (pi.status >= 200 && pi.status < 300 && piCompletion?.terminalStatus === 'completed' && piCompletion.assistantReply === 'ZARCH-ISOLATED-PI-OK'))
          ? 'passed'
          : 'blocked',
      isolatedOnly: true,
      formalThreadResumed: false,
      formalCredentialUse: {
        authorized: formalCredentialAuthorized,
        copiedToIsolatedTestIdentity: formalCredentialAuthorized,
        plaintextExposed: false,
      },
      taskCreate: summary(taskCreate),
      codex: summary(codex),
      codexCompletion,
      pi: summary(pi),
      piCompletion,
      providerHealth: health.body,
      projectConversationCount: projectChoices.body.choices?.length ?? null,
      taskConversationCount: taskChoices.body.choices?.length ?? null,
    },
    null,
    2,
  ),
);

function commandRequest(input: {
  commandType: string;
  scopeKind: 'project' | 'task';
  scopeId: string;
  operationIdentity: string;
  input: Record<string, unknown>;
  inputSha256: string;
}): Record<string, unknown> {
  return {
    command: {
      schemaGeneration: 'zeus-command-envelope-v1',
      commandId: randomUUID(),
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zarch-isolated-provider-acceptance' },
      scope: { kind: input.scopeKind, id: input.scopeId },
      expectedRevision: null,
      idempotencyKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      payload: { operationIdentity: input.operationIdentity, inputSha256: input.inputSha256 },
    },
    input: input.input,
  };
}

async function request(
  path: string,
  input: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: input.method ?? 'GET',
      headers: { Authorization: `Bearer ${apiToken}`, ...(input.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  } catch (error) {
    return { status: 0, body: { error: error instanceof Error ? error.name : 'UNKNOWN', message: error instanceof Error ? error.message : String(error) } };
  }
}

function summary(result: { status: number; body: Record<string, any> }): Record<string, unknown> {
  return {
    status: result.status,
    error: result.body.error ?? result.body.code ?? null,
    message: typeof result.body.message === 'string' ? result.body.message.slice(0, 1_000) : null,
    conversationId: result.body.conversation?.id ?? result.body.conversationId ?? result.body.result?.conversationId ?? null,
    submissionId: result.body.submission?.id ?? result.body.submissionId ?? result.body.result?.submissionId ?? null,
  };
}

function resultConversationId(result: { body: Record<string, any> }): string | null {
  const value = result.body.conversation?.id ?? result.body.conversationId ?? result.body.result?.conversationId;
  return typeof value === 'string' && value ? value : null;
}

async function waitForCompletion(conversationId: string): Promise<Record<string, unknown>> {
  const timeoutMs = 120_000;
  const startedAt = Date.now();
  let snapshot: Record<string, any> | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const result = await request(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/snapshot-v2`);
    if (result.status === 200) {
      snapshot = result.body;
      if (!snapshot.activeTurn && Array.isArray(snapshot.recentClosedTurns) && snapshot.recentClosedTurns.length > 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const terminal = Array.isArray(snapshot?.recentClosedTurns) ? snapshot.recentClosedTurns[0] : null;
  const history = await request(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/model-history?direction=tail&limit=100&byteLimit=1048576`);
  const assistantReply = Array.isArray(history.body.items)
    ? history.body.items
        .filter((item: Record<string, any>) => item.role === 'assistant')
        .map((item: Record<string, any>) => previewText(item.content?.preview))
        .filter((value: string | null): value is string => Boolean(value))
        .at(-1) ?? null
    : null;
  const process = terminal?.status === 'failed' && typeof terminal.id === 'string'
    ? await request(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(terminal.id)}/process?limit=100&byteLimit=1048576`)
    : null;
  return {
    terminalStatus: typeof terminal?.status === 'string' ? terminal.status : 'timeout',
    providerTurnId: typeof terminal?.providerTurnId === 'string' ? terminal.providerTurnId : null,
    assistantReply,
    modelHistoryCount: Array.isArray(history.body.items) ? history.body.items.length : null,
    processWarnings:
      process && Array.isArray(process.body.items)
        ? process.body.items.map((item: Record<string, any>) => ({ status: item.status ?? null, detail: previewText(item.detail?.preview) }))
        : [],
    elapsedMs: Date.now() - startedAt,
  };
}

function previewText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : value;
  } catch {
    return value;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}
