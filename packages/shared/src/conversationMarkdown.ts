import type { MarkdownIt } from 'markdown-it-ts';

/** 汉字、假名、韩文及其全角标点可以直接连接加粗边界，不要求用户插入空格。 */
const cjkBoundary = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
/** 同一解析实例只安装一次规则，避免缓存复用时重复包装。 */
const configuredParsers = new WeakSet<object>();

/** 只扩展 CJK 相邻的星号加粗边界；分词、配对、转义和代码仍使用原解析器。 */
export function enableConversationCjkStrong<T extends { inline: { ruler: Pick<MarkdownIt['inline']['ruler'], 'before'> } }>(md: T): T {
  if (configuredParsers.has(md)) return md;
  configuredParsers.add(md);
  /** 包装只作用于当前内联状态，不改原文或全局解析器原型。 */
  const configuredStates = new WeakSet<object>();
  md.inline.ruler.before('emphasis', 'zeus_cjk_strong', (state) => {
    if (configuredStates.has(state)) return false;
    configuredStates.add(state);
    /** 原扫描结果保留 CommonMark 的分隔符长度和非 CJK 判定。 */
    const scanDelimiters = state.scanDelims.bind(state);
    state.scanDelims = (start, canSplitWord) => {
      /** 单星号斜体与下划线规则保持原语义。 */
      const result = scanDelimiters(start, canSplitWord);
      if (!result || state.src.charCodeAt(start) !== 0x2a || result.length < 2) return result;
      /** 以 Unicode 字符读取相邻边界，避免截断扩展汉字的代理对。 */
      const before = Array.from(state.src.slice(Math.max(0, start - 2), start)).at(-1) ?? '';
      const after = Array.from(state.src.slice(start + result.length, Math.min(state.posMax, start + result.length + 2)))[0] ?? '';
      if (cjkBoundary.test(before) || cjkBoundary.test(after)) {
        // 加粗内容内部仍不能以空白开头或结尾，不吞掉原有空格。
        result.can_open ||= Boolean(after) && !/\s/u.test(after);
        result.can_close ||= Boolean(before) && !/\s/u.test(before);
      }
      return result;
    };
    return false;
  });
  return md;
}
