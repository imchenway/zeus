import { canonicalCommandInputJson, type CommandEnvelope, commandEnvelopeSchemaGeneration, type CommandScopeKind } from '@zeus/shared';

export type RendererCommandPayload = { operationIdentity: string; inputSha256: string };

interface RendererCommandEnvelopeInput {
  commandType: string;
  commandIdPrefix: string;
  actorId: string;
  scopeKind: CommandScopeKind;
  scopeId: string;
  operationIdentity: string;
  inputSha256: string;
  expectedRevision?: number | null;
}

export async function buildRendererCommandRequest<TInput extends object>(
  input: Omit<RendererCommandEnvelopeInput, 'inputSha256'> & {
    value: TInput;
  },
): Promise<{ command: CommandEnvelope<RendererCommandPayload>; input: TInput }> {
  return {
    command: createRendererCommandEnvelope({ ...input, inputSha256: await commandInputSha256(input.value) }),
    input: input.value,
  };
}

export function createRendererCommandEnvelope(input: RendererCommandEnvelopeInput): CommandEnvelope<RendererCommandPayload> {
  return {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId: `${input.commandIdPrefix}${randomIdentity()}`,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: input.actorId },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: input.expectedRevision ?? null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: new Date().toISOString(),
    payload: { operationIdentity: input.operationIdentity, inputSha256: input.inputSha256 },
  };
}

export function commandInputSha256(value: unknown): Promise<string> {
  return sha256(canonicalCommandInputJson(value));
}

export async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomIdentity(compact = false): string {
  const value = typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID() : Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return compact ? value.replaceAll('-', '') : value;
}
