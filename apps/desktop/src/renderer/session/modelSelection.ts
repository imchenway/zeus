import type { CodexConversationCapabilities } from './sessionTypes.js';

/** 会话和任务推送共用接入判断；未登录或未就绪的 Codex 目录不能当作可用模型。 */
export function hasAvailableConversationModel(capabilities: CodexConversationCapabilities): boolean {
  /** 占位账号不代表免登录；自定义供应商独立判断可用性。 */
  const codexReady = capabilities.codexAccount.generationId !== 'codex-unavailable' && (!capabilities.codexAccount.requiresOpenaiAuth || capabilities.codexAccount.signedIn);
  return capabilities.models.some((model) => model.available !== false && (model.agentKind === 'pi' || model.sourceId !== 'codex' || codexReady));
}

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
