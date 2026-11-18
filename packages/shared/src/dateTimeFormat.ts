/** 所有显示时间的界面使用 00:00 至 23:59，保留调用方的日期精度与时区。 */
export function formatZeusDateTime(value: Date | number | string, locale?: string, options?: Omit<Intl.DateTimeFormatOptions, 'hour12' | 'hourCycle'>): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString(locale, { ...options, hourCycle: 'h23' });
}
