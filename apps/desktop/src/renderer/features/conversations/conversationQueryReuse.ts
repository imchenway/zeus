/** 会话目录和状态仅包含 JSON 数据；按字段复用未变化的对象，保留数组顺序与缺项语义。 */
export function reuseConversationQueryValue<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (previous === null || next === null || typeof previous !== 'object' || typeof next !== 'object' || Array.isArray(previous) !== Array.isArray(next)) return next;
  /** 字段顺序不参与相等判断，缺项与显式 undefined 仍有区别。 */
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  /** 只有值变化时才复制集合，未变化的子项继续使用原引用。 */
  let unchanged = previousKeys.length === nextKeys.length;
  let result: T = next;
  for (const key of nextKeys) {
    const oldValue = (previous as Record<string, unknown>)[key];
    const nextValue = (next as Record<string, unknown>)[key];
    const value = reuseConversationQueryValue(oldValue, nextValue);
    if (!Object.is(value, nextValue)) {
      if (result === next) result = (Array.isArray(next) ? [...next] : { ...next }) as T;
      (result as Record<string, unknown>)[key] = value;
    }
    if (!Object.hasOwn(previous, key) || !Object.is(oldValue, value)) unchanged = false;
  }
  return unchanged ? previous : result;
}
