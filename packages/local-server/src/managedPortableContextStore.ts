import { randomUUID } from 'node:crypto';
import type { ArtifactRef, ArtifactStore, ConversationExecutionRepository } from '@zeus/storage';

export const portableContextArtifactGeneration = '2026-08-21-portable-context-artifact-v1';

export interface ManagedPortableContextRecordInput {
  conversationId: string;
  throughModelHistorySequence: number;
  targetExecutionSnapshotId: string;
  status: 'ready' | 'compacting' | 'compacted' | 'failed';
  content: unknown;
  capabilityLosses: unknown;
  estimatedInputTokens: number | null;
  occurredAt: string;
}

export class ManagedPortableContextStore {
  constructor(
    private readonly execution: ConversationExecutionRepository,
    private readonly artifacts: ArtifactStore,
    private readonly inlineByteLimit = 64 * 1024,
  ) {
    if (!Number.isSafeInteger(inlineByteLimit) || inlineByteLimit < 1_024 || inlineByteLimit > 1024 * 1024) throw new Error('Portable context inlineByteLimit 无效。');
  }

  record(input: ManagedPortableContextRecordInput): string {
    const id = `conversation_portable_context_${randomUUID()}`;
    const stored = this.preparePayload({ id, conversationId: input.conversationId, content: input.content, occurredAt: input.occurredAt });
    try {
      return this.execution.recordPortableContext({ ...input, id, content: stored.projection, artifactRef: stored.artifactRef });
    } catch (error) {
      this.compensateNewArtifact(id, stored.artifactRef, input.occurredAt);
      throw error;
    }
  }

  update(input: { id: string; status: ManagedPortableContextRecordInput['status']; content: unknown; updatedAt: string }): void {
    const existing = this.execution.portableContextArtifact(input.id);
    if (!existing) throw new Error(`Portable context 不存在：${input.id}`);
    const stored = this.preparePayload({ id: input.id, conversationId: existing.conversationId, content: input.content, occurredAt: input.updatedAt });
    try {
      this.execution.updatePortableContext({ ...input, content: stored.projection, artifactRef: stored.artifactRef });
    } catch (error) {
      if (stored.artifactRef?.sha256 !== existing.artifactRef?.sha256) this.compensateNewArtifact(input.id, stored.artifactRef, input.updatedAt);
      throw error;
    }
    if (existing.artifactRef && existing.artifactRef.sha256 !== stored.artifactRef?.sha256) {
      const owner = { kind: 'conversation_portable_context', id: input.id };
      this.artifacts.releaseOwnerHolds({ owner, sha256: existing.artifactRef.sha256, releasedAt: input.updatedAt });
      this.artifacts.detachOwner({ sha256: existing.artifactRef.sha256, owner });
    }
  }

  private preparePayload(input: { id: string; conversationId: string; content: unknown; occurredAt: string }): { projection: unknown; artifactRef: ArtifactRef | null } {
    const serialized = JSON.stringify(input.content);
    if (serialized === undefined) throw new Error('Portable context 不能序列化。');
    const contentBytes = Buffer.byteLength(serialized);
    if (contentBytes <= this.inlineByteLimit) return { projection: input.content, artifactRef: null };

    const owner = {
      kind: 'conversation_portable_context',
      id: input.id,
      generationId: portableContextArtifactGeneration,
      conversationId: input.conversationId,
    };
    const artifactRef = this.artifacts.putJsonSync({ value: input.content, owner, compression: 'gzip-v1', createdAt: input.occurredAt });
    this.artifacts.hold({
      sha256: artifactRef.sha256,
      owner,
      ownerClass: 'active_conversation',
      reason: `便携上下文 ${input.id} 仍属于活动会话`,
      createdAt: input.occurredAt,
    });
    return {
      projection: {
        storage: 'artifact_ref',
        generation: portableContextArtifactGeneration,
        sha256: artifactRef.sha256,
        contentSha256: artifactRef.contentSha256,
        contentByteLength: artifactRef.contentByteLength,
        summary: summarizePortableContext(input.content),
      },
      artifactRef,
    };
  }

  private compensateNewArtifact(id: string, artifactRef: ArtifactRef | null, occurredAt: string): void {
    if (!artifactRef) return;
    const owner = { kind: 'conversation_portable_context', id };
    this.artifacts.releaseOwnerHolds({ owner, sha256: artifactRef.sha256, releasedAt: occurredAt });
    this.artifacts.detachOwner({ sha256: artifactRef.sha256, owner });
  }
}

function summarizePortableContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return { valueType: value === null ? 'null' : typeof value };
  if (Array.isArray(value)) return { valueType: 'array', entries: value.length };
  const record = value as Record<string, unknown>;
  const summary: Record<string, unknown> = { valueType: 'object', keys: Object.keys(record).slice(0, 32) };
  for (const key of ['version', 'conversationId', 'throughModelHistorySequence']) {
    const item = record[key];
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) summary[key] = item;
  }
  for (const key of ['history', 'messages', 'entries', 'capabilityLosses']) {
    if (Array.isArray(record[key])) summary[`${key}Count`] = record[key].length;
  }
  return summary;
}
