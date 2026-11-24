/** 按持久化模型引用还原连接和模型，保留模型 ID 中原有的冒号等字符。 */
export function parseModelRef(value: string): { sourceId: string; modelId: string } | null {
  const boundary = value.indexOf(':');
  if (boundary <= 0 || boundary >= value.length - 1) return null;
  try {
    const sourceId = decodeURIComponent(value.slice(0, boundary));
    const modelId = decodeURIComponent(value.slice(boundary + 1));
    return sourceId && modelId ? { sourceId, modelId } : null;
  } catch {
    return null;
  }
}
