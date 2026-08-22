export type MemoryScopeKind = 'global' | 'project';
export type MemoryKind = 'preference' | 'safety_boundary' | 'stable_workflow';
export type MemoryEffect = 'advisory' | 'external_state';
export type MemoryConfirmationLevel = 'observed' | 'confirmed' | 'explicit';
export type MemorySourceKind = 'user_explicit' | 'project_instruction' | 'repeated_confirmation' | 'manual_import';

export interface MemoryScope {
  kind: MemoryScopeKind;
  id: string;
}

export interface MemorySource {
  kind: MemorySourceKind;
  reference: string;
  observedAt: string;
  contentSha256?: string | null;
}

export interface MemoryRecord {
  id: string;
  memoryKey: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  contentSha256: string;
  effect: MemoryEffect;
  source: MemorySource;
  confirmationLevel: MemoryConfirmationLevel;
  confidence: number;
  reviewAfter: string;
  supersedesId: string | null;
  tombstone: boolean;
  tombstonedAt: string | null;
  tombstoneReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPageCursor {
  updatedAt: string;
  id: string;
}

export interface MemoryPage {
  items: MemoryRecord[];
  hasMore: boolean;
  nextCursor: MemoryPageCursor | null;
}

export interface MemoryCandidateInput {
  memoryKey: string;
  scope: MemoryScope;
  candidateKind: MemoryKind;
  content: string;
  effect: MemoryEffect;
  source: MemorySource;
  confirmationLevel: MemoryConfirmationLevel;
  confidence: number;
  reviewAfter: string;
}

export type SupersedingMemoryCandidateInput = Omit<MemoryCandidateInput, 'memoryKey' | 'scope'>;

export interface MemoryListQuery {
  scope: MemoryScope;
  includeTombstones: boolean;
  limit?: number;
  before?: MemoryPageCursor;
}

export type MemoryDisplayStatus = 'current' | 'review_due' | 'superseded' | 'tombstone';

export function memoryDisplayStatus(record: MemoryRecord, records: readonly MemoryRecord[], asOf = new Date().toISOString()): MemoryDisplayStatus {
  if (record.tombstone) return 'tombstone';
  if (records.some((candidate) => candidate.supersedesId === record.id)) return 'superseded';
  if (record.reviewAfter.localeCompare(asOf) <= 0) return 'review_due';
  return 'current';
}
