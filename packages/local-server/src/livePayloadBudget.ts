/**
 * 实时事件载荷预算：耐久会话事件有 1 MiB 协议上限（conversationSyncProtocol），
 * 完整内容一律留在本地存储，实时推送只带可渲染的摘要。
 * 任何要发布「可能很大」的载荷的调用方都必须先过这里，禁止直接把 Provider 原文塞进事件。
 */

/** 实时处理项载荷的字节预算；远低于 1 MiB 协议上限，为队列快照和 transcript 留出空间。 */
export const maximumLivePayloadBytes = 256 * 1024;

/** 单个字符串在实时载荷里的保留长度；完整内容仍在处理项存储中。 */
export const maximumLivePayloadStringLength = 8 * 1024;

/** 实时载荷里的数组长度上限，超出部分以占位项说明省略数量。 */
export const maximumLivePayloadArrayItems = 200;

/** 递归裁剪实时载荷：超长字符串与超长数组降级为带说明的摘要，保证事件不顶到协议上限。 */
export function boundLiveValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > maximumLivePayloadStringLength ? `${value.slice(0, maximumLivePayloadStringLength)}\n…[内容过长已截断，完整明细见本地存储]` : value;
  }
  if (Array.isArray(value)) {
    if (value.length > maximumLivePayloadArrayItems) {
      return [...value.slice(0, maximumLivePayloadArrayItems).map((entry) => boundLiveValue(entry, depth + 1)), `…[已省略 ${value.length - maximumLivePayloadArrayItems} 项]`];
    }
    return value.map((entry) => boundLiveValue(entry, depth + 1));
  }
  // 深度上限防止异常结构递归过深；Provider JSON 事件本身不可能有环。
  if (value && typeof value === 'object' && depth < 8) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, boundLiveValue(entry, depth + 1)]));
  }
  return value;
}

/** 只约束实时事件里的处理项载荷；超预算时连原始 Provider 报文一起降级，绝不把整条事件顶到上限。 */
export function boundLiveProcessPayload(itemPayload: Record<string, unknown>): { itemPayload: Record<string, unknown>; truncated: boolean } {
  const bounded = boundLiveValue(itemPayload) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= maximumLivePayloadBytes) return { itemPayload: bounded, truncated: false };
  const detail = bounded.detail && typeof bounded.detail === 'object' && !Array.isArray(bounded.detail) ? (bounded.detail as Record<string, unknown>) : {};
  return { itemPayload: { ...bounded, detail: { ...detail, payload: null, truncated: true } }, truncated: true };
}
