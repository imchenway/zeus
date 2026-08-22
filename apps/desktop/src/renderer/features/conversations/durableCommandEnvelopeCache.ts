import { type CommandEnvelope, type CommandScopeKind, parseCommandEnvelope } from '@zeus/shared';

export type DurableConversationCommandPayload = Record<string, unknown> & {
  operationIdentity: string;
  inputSha256: string;
};

interface PersistedCommandEnvelope {
  version: 1;
  stableIdentity: string;
  inputSha256: string;
  command: CommandEnvelope<DurableConversationCommandPayload>;
}

const storagePrefix = 'zeus.conversation-command-envelope:v1:';
const inMemoryCommands = new Map<string, Promise<CommandEnvelope<DurableConversationCommandPayload>>>();

/**
 * 业务请求已经把 reconnect identity 落盘时，外层 Command Envelope 也必须逐字节稳定。
 * 缓存不保存 input 正文；调用方每次仍按 canonical input hash 验证当前正文。
 */
export async function durableConversationCommandEnvelope(input: {
  namespace: string;
  stableIdentity: string;
  inputSha256: string;
  commandType: string;
  scopeKind: CommandScopeKind;
  scopeId: string;
  create: () => CommandEnvelope<DurableConversationCommandPayload> | Promise<CommandEnvelope<DurableConversationCommandPayload>>;
}): Promise<CommandEnvelope<DurableConversationCommandPayload>> {
  const identity = stableCacheIdentity(input.namespace, input.stableIdentity);
  const existing = inMemoryCommands.get(identity);
  if (existing) return validateCommand(await existing, input);

  const created = loadOrCreateCommand(identity, input);
  inMemoryCommands.set(identity, created);
  try {
    return await created;
  } catch (error) {
    if (inMemoryCommands.get(identity) === created) inMemoryCommands.delete(identity);
    throw error;
  }
}

export function forgetDurableConversationCommandEnvelope(namespace: string, stableIdentity: string): void {
  const identity = stableCacheIdentity(namespace, stableIdentity);
  inMemoryCommands.delete(identity);
  const storage = browserLocalStorage();
  if (!storage) return;
  void storageKey(identity).then((key) => {
    try {
      storage.removeItem(key);
    } catch {
      // 业务 acceptance 已经耐久；残留的无正文信封只会在同一 identity 下安全复用。
    }
  });
}

async function loadOrCreateCommand(identity: string, input: Parameters<typeof durableConversationCommandEnvelope>[0]): Promise<CommandEnvelope<DurableConversationCommandPayload>> {
  const storage = browserLocalStorage();
  if (storage) {
    const key = await storageKey(identity);
    const raw = storage.getItem(key);
    if (raw) return validatePersistedCommand(raw, input);

    const command = validateCommand(await input.create(), input);
    const record: PersistedCommandEnvelope = {
      version: 1,
      stableIdentity: input.stableIdentity,
      inputSha256: input.inputSha256,
      command,
    };
    try {
      storage.setItem(key, JSON.stringify(record));
    } catch (error) {
      throw new Error(`Unable to persist the conversation command envelope before dispatch: ${error instanceof Error ? error.message : String(error)}`);
    }
    return command;
  }
  return validateCommand(await input.create(), input);
}

function validatePersistedCommand(raw: string, input: Parameters<typeof durableConversationCommandEnvelope>[0]): CommandEnvelope<DurableConversationCommandPayload> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('The durable conversation command envelope is not valid JSON.');
  }
  if (!isRecord(value) || value.version !== 1 || value.stableIdentity !== input.stableIdentity || value.inputSha256 !== input.inputSha256) {
    throw new Error('A reconnect identity cannot be reused with a different or invalid durable conversation command envelope.');
  }
  return validateCommand(parseCommandEnvelope<DurableConversationCommandPayload>(value.command), input);
}

function validateCommand(command: CommandEnvelope<DurableConversationCommandPayload>, input: Parameters<typeof durableConversationCommandEnvelope>[0]): CommandEnvelope<DurableConversationCommandPayload> {
  if (
    command.commandType !== input.commandType ||
    command.scope.kind !== input.scopeKind ||
    command.scope.id !== input.scopeId ||
    command.payload.inputSha256 !== input.inputSha256 ||
    typeof command.payload.operationIdentity !== 'string' ||
    !command.payload.operationIdentity
  ) {
    throw new Error('The durable conversation command envelope does not match the current command input.');
  }
  return command;
}

function browserLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch (error) {
    throw new Error(`Conversation command recovery requires durable local storage: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function storageKey(identity: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `${storagePrefix}${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function stableCacheIdentity(namespace: string, stableIdentity: string): string {
  return `${namespace}\0${stableIdentity}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
