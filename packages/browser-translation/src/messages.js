/** Page-runtime messages; the KISS extension settings UI is not included in Zeus. */
const messages = {
  copy: '复制',
  favorite_word_lookup_loading: '正在查询…',
  favorite_word_lookup_unavailable: '当前不支持词典查询。',
  favorite_word_lookup_failed: '词典查询失败。',
};

/** Keep the upstream message contract for its in-page error control. */
export function newI18n() {
  return (key, fallback) => messages[key] ?? fallback ?? key;
}
