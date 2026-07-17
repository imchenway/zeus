import { basename, isAbsolute } from 'node:path';
import { isNonCodexAiCliAdapterId, type NonCodexAiCliAdapterId } from '@zeus/ai-runtime';
import type { ZeusConversationWithMessagesRecord } from '@zeus/storage';

const legacyRuntimeProvenanceSources = new Set(['task_prompt', 'task_runtime_reconnected']);
const canonicalCommands: Readonly<Record<NonCodexAiCliAdapterId, string>> = {
  claude: 'claude',
  gemini: 'gemini',
  generic: 'sh',
};
const knownAdapterCommandBasenames = new Set(['codex', ...Object.values(canonicalCommands)]);

export type NonCodexLegacyCommandPolicy = Readonly<{
  configuredCommands?: Readonly<Partial<Record<NonCodexAiCliAdapterId, string>>>;
}>;

export type WritableNonCodexLegacyConversationContext = Readonly<{
  conversation: ZeusConversationWithMessagesRecord;
  adapterId: NonCodexAiCliAdapterId;
  recordedCommand: string | null;
}>;

/**
 * 将可写 legacy conversation 收窄为明确的非 Codex Runtime 上下文。
 * 任一 transport、adapter 或 command 声明未知/冲突时均 fail-closed。
 */
export function resolveWritableNonCodexLegacyConversation(conversation: ZeusConversationWithMessagesRecord, commandPolicy: NonCodexLegacyCommandPolicy = {}): WritableNonCodexLegacyConversationContext | null {
  if (conversation.transportKind !== 'legacy_cli') return null;

  const adapterIds = new Set<NonCodexAiCliAdapterId>();
  const recordedCommands = new Set<string>();

  if (conversation.providerId !== null) {
    if (!isNonCodexAiCliAdapterId(conversation.providerId)) return null;
    adapterIds.add(conversation.providerId);
  }

  for (const message of conversation.messages) {
    const metadata = parseMetadata(message.metadataJson);
    if (!metadata) return null;

    const hasAdapterId = hasOwn(metadata, 'adapterId');
    const hasAdapterCommand = hasOwn(metadata, 'adapterCommand');
    if (!legacyRuntimeProvenanceSources.has(message.source)) {
      if (hasAdapterId || hasAdapterCommand) return null;
      continue;
    }

    if (hasAdapterId) {
      if (!isNonCodexAiCliAdapterId(metadata.adapterId)) return null;
      adapterIds.add(metadata.adapterId);
    }

    if (hasAdapterCommand) {
      if (typeof metadata.adapterCommand !== 'string' || metadata.adapterCommand.trim().length === 0 || metadata.adapterCommand !== metadata.adapterCommand.trim()) return null;
      recordedCommands.add(metadata.adapterCommand);
    }
  }

  if (adapterIds.size !== 1 || recordedCommands.size > 1) return null;
  const adapterId = adapterIds.values().next().value;
  if (!adapterId) return null;
  const recordedCommand = recordedCommands.values().next().value ?? null;
  if (recordedCommand !== null && !isAllowedRecordedCommand(adapterId, recordedCommand, commandPolicy)) return null;

  return {
    conversation,
    adapterId,
    recordedCommand,
  };
}

function isAllowedRecordedCommand(adapterId: NonCodexAiCliAdapterId, recordedCommand: string, commandPolicy: NonCodexLegacyCommandPolicy): boolean {
  const canonicalCommand = canonicalCommands[adapterId];
  const recordedBasename = basename(recordedCommand);
  if (knownAdapterCommandBasenames.has(recordedBasename) && recordedBasename !== canonicalCommand) return false;
  if (recordedCommand === canonicalCommand) return true;
  if (isAbsolute(recordedCommand) && recordedBasename === canonicalCommand) return true;
  const configuredCommand = commandPolicy.configuredCommands?.[adapterId]?.trim();
  return configuredCommand !== undefined && configuredCommand.length > 0 && recordedCommand === configuredCommand;
}

function parseMetadata(metadataJson: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(metadataJson);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
