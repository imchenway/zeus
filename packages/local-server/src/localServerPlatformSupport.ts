import { listAiCliAdapters, type AiCliAdapterDescriptor } from '@zeus/ai-runtime';
import { type CommandEnvelope, commandEnvelopeSchemaGeneration } from '@zeus/shared';
import type { FastifyReply } from 'fastify';
import { relative, resolve } from 'node:path';
import { stableIdentity } from './imTelegramService.js';

/** 将 IM 平台输入封装为可审计的内部命令。 */
export function imInternalCommandRequest<TInput extends object>(input: {
  commandType: string;
  scopeKind: 'project' | 'task' | 'product_conversation' | 'turn' | 'approval';
  scopeId: string;
  operationIdentity: string;
  input: TInput;
  inputSha256: string;
  expectedRevision?: number | null;
}): { command: CommandEnvelope<{ operationIdentity: string; inputSha256: string }>; input: TInput } {
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: stableIdentity('command_im_bridge', `${input.commandType}:${input.operationIdentity}`),
      commandType: input.commandType,
      actor: { kind: 'system', id: 'telegram-im-bridge' },
      scope: { kind: input.scopeKind, id: input.scopeId },
      expectedRevision: input.expectedRevision ?? null,
      idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
      issuedAt: '2000-01-01T00:00:00.000Z',
      payload: { operationIdentity: input.operationIdentity, inputSha256: input.inputSha256 },
    },
    input: input.input,
  };
}

/** 判断本地 API 请求来源是否属于 Electron 或本机开发环境。 */
export function isAllowedLocalAppOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'file:' || parsed.protocol === 'app:') return true;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** 写入本地 API 的跨域响应头，保持凭据不随跨域请求发送。 */
export function applyLocalCorsHeaders(reply: FastifyReply, origin: string | undefined): void {
  if (!origin || origin === 'null') return;
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Access-Control-Allow-Credentials', 'false');
  reply.header('Access-Control-Allow-Headers', 'authorization,content-type,x-zeus-snapshot-caller,x-zeus-trace-id');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  reply.header('Access-Control-Expose-Headers', 'deprecation,link,server-timing,x-zeus-conversation-snapshot-generation,x-zeus-trace-id');
  reply.header('Vary', 'Origin');
}

/** 将 Fastify 的单值或多值请求头归一为首个字符串值。 */
export function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Runtime 只能启动已登记的 AI CLI adapter 命令，避免本地 API 退化成任意 shell 执行入口。 */
export function resolveRegisteredRuntimeAdapter(command: string): AiCliAdapterDescriptor | null {
  const trimmed = command.trim();
  if (trimmed !== command || trimmed.length === 0 || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) return null;
  return listAiCliAdapters().find((adapter) => adapter.command === trimmed) ?? null;
}

/** 判断 Runtime cwd 是否仍位于项目根目录内；相等也允许，避免本地 API 变成项目外 shell 入口。 */
export function isPathInsideProjectRoot(candidatePath: string, projectRoot: string): boolean {
  const relativePath = relative(resolve(projectRoot), resolve(candidatePath));
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('/') && !relativePath.startsWith('\\'));
}
