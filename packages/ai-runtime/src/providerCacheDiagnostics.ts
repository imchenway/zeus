import { createHash } from 'node:crypto';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentProviderPayloadDiagnostic, AgentProviderPayloadFingerprint, AgentProviderPayloadMessageFingerprint } from './agentRuntimeContracts.js';

/**
 * 只保留最终 Provider 请求的长度、结构和 SHA-256，不把提示正文或缓存键写入证据库。
 */
export function buildProviderCacheDiagnostic(model: Model<Api>, payload: unknown): AgentProviderPayloadDiagnostic {
  const request = asRecord(payload);
  const messages = arrayValue(request.messages ?? request.input);
  const system = request.system;
  const tools = request.tools;
  const cacheBreakpoints = collectCacheBreakpoints(payload);
  const promptCacheKey = request.prompt_cache_key;
  return {
    schemaVersion: 1,
    api: model.api,
    modelId: model.id,
    request: fingerprint(payload),
    sections: {
      system: system === undefined ? null : fingerprint(system),
      tools: tools === undefined ? null : { ...fingerprint(tools), count: arrayValue(tools).length },
      messages: {
        ...fingerprint(messages),
        count: messages.length,
        entries: messages.map((message, index) => messageFingerprint(message, index)),
      },
    },
    cache: {
      promptCacheKey: promptCacheKey === undefined ? { present: false, fingerprint: null, byteLength: null } : { present: true, ...fingerprint(promptCacheKey) },
      retention: safeCacheOption(request.prompt_cache_retention),
      explicitMode: safeCacheOption(asRecord(request.prompt_cache_options).mode),
      explicitTtl: safeCacheOption(asRecord(request.prompt_cache_options).ttl),
      breakpointCount: cacheBreakpoints.length,
      breakpointPaths: cacheBreakpoints,
    },
  };
}

function messageFingerprint(value: unknown, index: number): AgentProviderPayloadMessageFingerprint {
  const message = asRecord(value);
  return {
    index,
    role: safeRole(message.role ?? message.type),
    ...fingerprint(value),
    contentFingerprint: fingerprint(withoutCacheControl(value)).fingerprint,
    cacheBreakpointCount: collectCacheBreakpoints(value).length,
  };
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, entry]) => [key, withoutCacheControl(entry)]),
  );
}

function fingerprint(value: unknown): AgentProviderPayloadFingerprint {
  const serialized = stableSerialize(value);
  return {
    fingerprint: createHash('sha256').update(serialized).digest('hex'),
    byteLength: Buffer.byteLength(serialized),
  };
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? 'null';
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value === undefined ? null : value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function collectCacheBreakpoints(value: unknown, path = '$', result: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectCacheBreakpoints(entry, `${path}[${index}]`, result));
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = `${path}.${key}`;
    if (key === 'cache_control') result.push(nextPath);
    collectCacheBreakpoints(entry, nextPath, result);
  }
  return result;
}

function safeCacheOption(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length <= 24 && /^[a-zA-Z0-9_-]+$/u.test(value) ? value : 'present';
}

function safeRole(value: unknown): string {
  return typeof value === 'string' && ['system', 'developer', 'user', 'assistant', 'tool', 'function', 'message', 'item_reference'].includes(value) ? value : 'unknown';
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
