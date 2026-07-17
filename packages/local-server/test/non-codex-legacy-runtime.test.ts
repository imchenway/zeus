import { describe, expect, it } from 'vitest';
import type { ZeusConversationMessageRecord, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import { resolveWritableNonCodexLegacyConversation } from '../src/nonCodexLegacyRuntime.js';

const timestamp = '2026-07-13T00:00:00.000Z';

function createMessage(id: string, metadata: Record<string, unknown>, source = 'task_prompt'): ZeusConversationMessageRecord {
  return {
    id,
    conversationId: 'conversation-1',
    role: 'user',
    content: '真实 legacy Runtime 消息',
    source,
    metadataJson: JSON.stringify(metadata),
    createdAt: timestamp,
    providerThreadId: null,
    providerTurnId: null,
    providerItemId: null,
    clientMessageId: null,
  };
}

function createConversation(overrides: Partial<ZeusConversationWithMessagesRecord> = {}): ZeusConversationWithMessagesRecord {
  return {
    id: 'conversation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    sessionId: 'ai-session-1',
    title: '非 Codex legacy conversation',
    summary: null,
    status: 'running',
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    transportKind: 'legacy_cli',
    providerId: 'claude',
    providerThreadId: null,
    providerThreadPath: null,
    providerModel: null,
    providerState: 'unbound',
    providerProtocolVersion: null,
    providerBinaryVersion: null,
    legacySourceConversationId: null,
    providerSettingsJson: '{}',
    providerTokenUsageJson: '{}',
    messages: [createMessage('message-1', { adapterId: 'claude', adapterCommand: 'claude' })],
    ...overrides,
  };
}

describe('resolveWritableNonCodexLegacyConversation', () => {
  it.each([
    ['claude', 'claude'],
    ['gemini', 'gemini'],
    ['generic', 'sh'],
  ] as const)('accepts an internally consistent %s legacy conversation', (adapterId, adapterCommand) => {
    const conversation = createConversation({
      providerId: adapterId,
      messages: [createMessage('message-1', { adapterId, adapterCommand })],
    });

    expect(resolveWritableNonCodexLegacyConversation(conversation)).toEqual({
      conversation,
      adapterId,
      recordedCommand: adapterCommand,
    });
  });

  it('accepts migrated legacy data with no provider id when every message declaration agrees', () => {
    const conversation = createConversation({
      providerId: null,
      messages: [createMessage('message-1', { adapterId: 'claude', adapterCommand: '/opt/homebrew/bin/claude' }), createMessage('message-2', { adapterId: 'claude', adapterCommand: '/opt/homebrew/bin/claude' }, 'task_runtime_reconnected')],
    });

    expect(resolveWritableNonCodexLegacyConversation(conversation)).toEqual({
      conversation,
      adapterId: 'claude',
      recordedCommand: '/opt/homebrew/bin/claude',
    });
  });

  it('does not let a non-provenance message establish adapter identity', () => {
    const conversation = createConversation({
      providerId: null,
      messages: [createMessage('message-1', { adapterId: 'claude', adapterCommand: 'claude' }, 'user_followup')],
    });

    expect(resolveWritableNonCodexLegacyConversation(conversation)).toBeNull();
  });

  it('fails closed when a non-provenance message repeats adapter metadata', () => {
    const conversation = createConversation({
      messages: [createMessage('message-1', { adapterId: 'claude', adapterCommand: 'claude' }), createMessage('message-2', { adapterId: 'claude' }, 'user_followup')],
    });

    expect(resolveWritableNonCodexLegacyConversation(conversation)).toBeNull();
  });

  it.each([
    ['native transport', createConversation({ transportKind: 'codex_native' })],
    ['Codex provider', createConversation({ providerId: 'codex' })],
    ['unknown provider', createConversation({ providerId: 'unknown-provider' })],
    [
      'Codex message declaration',
      createConversation({
        providerId: null,
        messages: [createMessage('message-1', { adapterId: 'codex', adapterCommand: 'codex' })],
      }),
    ],
    [
      'unknown message declaration',
      createConversation({
        providerId: null,
        messages: [createMessage('message-1', { adapterId: 'unknown-provider' })],
      }),
    ],
    ['missing adapter declarations', createConversation({ providerId: null, messages: [createMessage('message-1', { projectId: 'project-1' })] })],
  ])('rejects %s', (_name, conversation) => {
    expect(resolveWritableNonCodexLegacyConversation(conversation)).toBeNull();
  });

  it('rejects conflicting provider and message adapter declarations', () => {
    const conversation = createConversation({
      providerId: 'claude',
      messages: [createMessage('message-1', { adapterId: 'gemini', adapterCommand: 'gemini' })],
    });

    expect(resolveWritableNonCodexLegacyConversation(conversation)).toBeNull();
  });

  it('rejects conflicts across all message adapter declarations instead of trusting the first one', () => {
    const conversation = createConversation({
      providerId: null,
      messages: [createMessage('message-1', { adapterId: 'claude', adapterCommand: 'claude' }), createMessage('message-2', { adapterId: 'gemini', adapterCommand: 'gemini' }, 'task_runtime_reconnected')],
    });

    expect(resolveWritableNonCodexLegacyConversation(conversation)).toBeNull();
  });

  it('rejects conflicting recorded commands for an otherwise consistent adapter', () => {
    const conversation = createConversation({
      messages: [createMessage('message-1', { adapterId: 'claude', adapterCommand: 'claude' }), createMessage('message-2', { adapterId: 'claude', adapterCommand: '/opt/homebrew/bin/claude' }, 'task_runtime_reconnected')],
    });

    expect(resolveWritableNonCodexLegacyConversation(conversation)).toBeNull();
  });

  it.each([
    ['claude', 'codex'],
    ['claude', 'gemini'],
    ['gemini', 'sh'],
  ] as const)('rejects a %s provenance command recorded for another adapter (%s)', (adapterId, adapterCommand) => {
    const conversation = createConversation({
      providerId: adapterId,
      messages: [createMessage('message-1', { adapterId, adapterCommand })],
    });

    expect(resolveWritableNonCodexLegacyConversation(conversation)).toBeNull();
  });

  it('does not let configured-command policy relabel the Codex executable as Claude', () => {
    const conversation = createConversation({
      messages: [createMessage('message-1', { adapterId: 'claude', adapterCommand: 'codex' })],
    });

    expect(
      resolveWritableNonCodexLegacyConversation(conversation, {
        configuredCommands: { claude: 'codex' },
      }),
    ).toBeNull();
  });

  it.each([
    ['claude', '/opt/homebrew/bin/claude'],
    ['gemini', '/usr/local/bin/gemini'],
    ['generic', '/bin/sh'],
  ] as const)('accepts a %s canonical absolute command path', (adapterId, adapterCommand) => {
    const conversation = createConversation({
      providerId: adapterId,
      messages: [createMessage('message-1', { adapterId, adapterCommand })],
    });

    expect(resolveWritableNonCodexLegacyConversation(conversation)).toMatchObject({
      adapterId,
      recordedCommand: adapterCommand,
    });
  });

  it('accepts only an explicitly configured non-canonical command for the resolved adapter', () => {
    const adapterCommand = '/Applications/ClaudeCustom/bin/acme-ai';
    const conversation = createConversation({
      messages: [createMessage('message-1', { adapterId: 'claude', adapterCommand })],
    });

    expect(resolveWritableNonCodexLegacyConversation(conversation)).toBeNull();
    expect(
      resolveWritableNonCodexLegacyConversation(conversation, {
        configuredCommands: { claude: adapterCommand },
      }),
    ).toMatchObject({
      adapterId: 'claude',
      recordedCommand: adapterCommand,
    });
  });

  it('fails closed when message metadata is malformed or contains an invalid declaration shape', () => {
    const malformed = createConversation({
      messages: [{ ...createMessage('message-1', {}), metadataJson: '{not-json' }],
    });
    const invalidShape = createConversation({
      messages: [createMessage('message-1', { adapterId: 42, adapterCommand: [] })],
    });

    expect(resolveWritableNonCodexLegacyConversation(malformed)).toBeNull();
    expect(resolveWritableNonCodexLegacyConversation(invalidShape)).toBeNull();
  });
});
