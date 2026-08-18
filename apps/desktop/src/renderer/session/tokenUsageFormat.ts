import type { SessionUiLanguage } from './ThreadItemView.js';

const TOKEN_USAGE_UNITS = [
  { suffix: '', divisor: 1 },
  { suffix: 'K', divisor: 1_000 },
  { suffix: 'M', divisor: 1_000_000 },
  { suffix: 'B', divisor: 1_000_000_000 },
] as const;
const TOKEN_USAGE_SIGNIFICANT_DIGITS = 3;
const TOKEN_USAGE_COMPACT_FORMATTER = new Intl.NumberFormat('en-US', { maximumSignificantDigits: TOKEN_USAGE_SIGNIFICANT_DIGITS, useGrouping: false });
const TOKEN_USAGE_EXACT_FORMATTERS = {
  'zh-CN': new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }),
  'en-US': new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }),
} satisfies Record<SessionUiLanguage, Intl.NumberFormat>;

/** Token 数量同时给出 K/M 紧凑形态与精确形态；紧凑值用于可见文本，精确值留给无障碍标签与悬停标题。 */
export function formatTokenCount(count: number, language: SessionUiLanguage): { compact: string; exact: string } {
  let unitIndex = 0;
  for (let index = 1; index < TOKEN_USAGE_UNITS.length; index += 1) {
    if (count < TOKEN_USAGE_UNITS[index].divisor) break;
    unitIndex = index;
  }

  let unit = TOKEN_USAGE_UNITS[unitIndex];
  let rounded = Number((count / unit.divisor).toPrecision(TOKEN_USAGE_SIGNIFICANT_DIGITS));
  if (rounded >= 1_000 && unitIndex < TOKEN_USAGE_UNITS.length - 1) {
    unitIndex += 1;
    unit = TOKEN_USAGE_UNITS[unitIndex];
    rounded = Number((count / unit.divisor).toPrecision(TOKEN_USAGE_SIGNIFICANT_DIGITS));
  }

  const exact = TOKEN_USAGE_EXACT_FORMATTERS[language].format(count);
  return {
    compact: unitIndex === 0 ? exact : `${TOKEN_USAGE_COMPACT_FORMATTER.format(rounded)}${unit.suffix}`,
    exact,
  };
}
