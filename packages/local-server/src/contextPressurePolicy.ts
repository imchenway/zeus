import type { ContextDispatchEnvelope } from './contextDispatchService.js';

export type ContextPressureDecision =
  | { action: 'send'; estimatedHeadroomTokens: number | null; reason: 'accounting_unavailable' | 'safe_headroom' | 'bootstrap_history' }
  | { action: 'compact'; estimatedHeadroomTokens: number; reason: 'estimated_request_exceeds_safe_budget' };

/**
 * 安全余量已经在 request accounting 中预扣；这里只在余量为负时启动有损压缩。
 * 首请求没有可压缩热历史，必须继续走 bootstrap/new-segment 语义。
 */
export function decideContextPressure(envelope: ContextDispatchEnvelope | null): ContextPressureDecision {
  const accounting = envelope?.provider.requestAccounting;
  if (!accounting) return { action: 'send', estimatedHeadroomTokens: null, reason: 'accounting_unavailable' };
  if (accounting.historyBaselineSource === 'provider_bootstrap_known_prefix') {
    return { action: 'send', estimatedHeadroomTokens: accounting.estimatedRequestHeadroomTokens, reason: 'bootstrap_history' };
  }
  if (accounting.estimatedRequestHeadroomTokens < 0) {
    return { action: 'compact', estimatedHeadroomTokens: accounting.estimatedRequestHeadroomTokens, reason: 'estimated_request_exceeds_safe_budget' };
  }
  return { action: 'send', estimatedHeadroomTokens: accounting.estimatedRequestHeadroomTokens, reason: 'safe_headroom' };
}
