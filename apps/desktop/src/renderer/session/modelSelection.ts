export interface ModelSelectionIdentity {
  id: string;
  model: string;
}

/** 复合身份优先；裸模型名只兼容唯一命中的旧数据，撞名时不猜供应源。 */
export function resolveModelCapability<T extends ModelSelectionIdentity>(models: readonly T[] | null | undefined, identity: string | null | undefined): T | null {
  const normalized = identity?.trim();
  if (!normalized || !models?.length) return null;
  const exact = models.find((candidate) => candidate.id === normalized);
  if (exact) return exact;
  const legacyMatches = models.filter((candidate) => candidate.model === normalized);
  return legacyMatches.length === 1 ? legacyMatches[0]! : null;
}
