import type { CodexBootstrapAdditionalContext } from '@zeus/shared';
import { coordinatorError, isRecord } from './codexNativeConversationPolicy.js';

export function readCodexAdditionalContext(value: unknown): CodexBootstrapAdditionalContext | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  const normalized: CodexBootstrapAdditionalContext = {};
  for (const [key, entry] of entries) {
    if (!key || !isRecord(entry) || (entry.kind !== 'application' && entry.kind !== 'untrusted') || typeof entry.value !== 'string') {
      throw coordinatorError('ZEUS_CODEX_ADDITIONAL_CONTEXT_INVALID', '持久化的 Codex additionalContext 不符合 app-server v2 线协议。');
    }
    normalized[key] = { kind: entry.kind, value: entry.value };
  }
  return normalized;
}

export function mergeCodexAdditionalContext(...sources: Array<CodexBootstrapAdditionalContext | null | undefined>): CodexBootstrapAdditionalContext | undefined {
  const merged: CodexBootstrapAdditionalContext = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, entry] of Object.entries(source)) {
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        throw coordinatorError('ZEUS_CODEX_ADDITIONAL_CONTEXT_KEY_CONFLICT', `Codex additionalContext 键名冲突：${key}`);
      }
      merged[key] = entry;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

const compilerReservedAdditionalContextKeys = new Set(['zeus_context_manifest', 'zeus_application_context', 'zeus_untrusted_context']);

export function assertCallerDoesNotOverrideCompiledContext(source: CodexBootstrapAdditionalContext | null | undefined): void {
  if (!source) return;
  const conflicting = Object.keys(source).find((key) => compilerReservedAdditionalContextKeys.has(key));
  if (conflicting) throw coordinatorError('ZEUS_CODEX_ADDITIONAL_CONTEXT_KEY_CONFLICT', `调用方不得覆盖 Context Compiler 保留键：${conflicting}`);
}
