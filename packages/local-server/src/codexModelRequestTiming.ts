export interface CodexModelRequestTimingSnapshot {
  firstVisibleOutputAt: string | null;
  firstTextOutputAt: string | null;
  hasNonTextOutput: boolean;
}

export interface CodexModelRequestTimingTracker {
  observe(conversationId: string, turnId: string, timestamp: string, kind: 'visible_text' | 'visible_non_text' | 'non_text'): void;
  complete(conversationId: string, turnId: string): CodexModelRequestTimingSnapshot;
  clear(conversationId: string, turnId: string): void;
}

/** 首段正文到达时可同步记录诊断，已有持久用量口径保持独立。 */
export function createCodexModelRequestTimingTracker(onFirstText?: (conversationId: string, turnId: string, timestamp: string) => void): CodexModelRequestTimingTracker {
  const timings = new Map<string, CodexModelRequestTimingSnapshot>();
  const keyOf = (conversationId: string, turnId: string) => `${conversationId}\0${turnId}`;
  const empty = (): CodexModelRequestTimingSnapshot => ({ firstVisibleOutputAt: null, firstTextOutputAt: null, hasNonTextOutput: false });
  return {
    observe(conversationId, turnId, timestamp, kind) {
      const key = keyOf(conversationId, turnId);
      const current = timings.get(key) ?? empty();
      if (kind !== 'non_text' && current.firstVisibleOutputAt === null) current.firstVisibleOutputAt = timestamp;
      if (kind === 'visible_text' && current.firstTextOutputAt === null) {
        current.firstTextOutputAt = timestamp;
        onFirstText?.(conversationId, turnId, timestamp);
      }
      if (kind === 'non_text') current.hasNonTextOutput = true;
      timings.set(key, current);
    },
    complete(conversationId, turnId) {
      const key = keyOf(conversationId, turnId);
      const current = timings.get(key) ?? empty();
      timings.delete(key);
      return current;
    },
    clear(conversationId, turnId) {
      timings.delete(keyOf(conversationId, turnId));
    },
  };
}
