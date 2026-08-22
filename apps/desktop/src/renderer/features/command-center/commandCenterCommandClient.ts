import { commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';

export const commandCenterClientCommandTypes = {
  definitionCreate: 'command_center.definition.create',
  definitionUpdate: 'command_center.definition.update',
  definitionDelete: 'command_center.definition.delete',
  confirmationCreate: 'command_center.confirmation.create',
  runStart: 'command_center.run.start',
  runStop: 'command_center.run.stop',
} as const;

export type CommandCenterClientCommandType = (typeof commandCenterClientCommandTypes)[keyof typeof commandCenterClientCommandTypes];
type CommandCenterCommandPayload = { operationIdentity: string; inputSha256: string };

/** 构造一次不可变请求体；Local transport 重连只能复用该序列化 Body，不能重新生成命令身份。 */
export async function buildCommandCenterCommandRequest<TInput extends object>(input: {
  commandType: CommandCenterClientCommandType;
  scopeKind: Extract<CommandScopeKind, 'command_definition' | 'command_run'>;
  scopeId(operationIdentity: string): string;
  expectedRevision: number | null;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<CommandCenterCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
  const inputSha256 = await sha256(canonicalJson(input.value));
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_command_center_${randomIdentity()}`,
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zeus-desktop-command-center' },
      scope: { kind: input.scopeKind, id: input.scopeId(operationIdentity) },
      expectedRevision: input.expectedRevision,
      idempotencyKey: `${input.commandType}:${operationIdentity}`,
      issuedAt: new Date().toISOString(),
      payload: { operationIdentity, inputSha256 },
    },
    input: input.value,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Command Center input must contain finite JSON numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry))).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Command Center input must contain JSON data.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomIdentity(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
