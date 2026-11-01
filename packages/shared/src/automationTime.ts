/** 读取规则时区的日历与钟表字段，小时固定使用 00 至 23。 */
export function localParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  /** 显式时区避免依赖 macOS 或 Windows 的系统默认时区。 */
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  /** 格式片段按名称读取，不依赖平台的日期排列顺序。 */
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** 将 UTC 字段承载的当地年月日时分按规则时区换算为实际时刻。 */
export function zonedLocalToUtc(local: Date, timeZone: string): Date {
  /** 候选时刻逐次按规则时区的偏移校正，沿用调度器的转换方式。 */
  let candidate = new Date(local.getTime());
  for (let index = 0; index < 3; index += 1) {
    /** 当前候选时刻在规则时区显示的日历字段。 */
    const parts = localParts(candidate, timeZone);
    /** 用 UTC 字段计算钟表差值，单位为毫秒。 */
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    candidate = new Date(candidate.getTime() + (local.getTime() - represented));
  }
  return candidate;
}

/** 一次性排程必须提供带时区的 ISO 时间，不能依赖服务进程的系统时区。 */
export function parseAutomationOnceAt(at: unknown): Date {
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/iu.test(at) || !Number.isFinite(Date.parse(at))) {
    throw new Error('ZEUS_AUTOMATION_CONFIG_ONCE_AT_INVALID: 请填写有效的一次性执行时间。');
  }
  return new Date(at);
}

/** 将已保存时刻转为规则时区的分钟输入值；无效旧配置留空供用户修正。 */
export function formatAutomationOnceInput(at: unknown, timeZone: string): string {
  try {
    /** 按规则时区读取年月日时分，不能截取 UTC 字符串作为当地时间。 */
    const parts = localParts(parseAutomationOnceAt(at), timeZone);
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

/** 把分钟输入按规则时区转换为 UTC；无效日期、时区或不存在的当地时间返回空值。 */
export function parseAutomationOnceInput(value: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  try {
    /** UTC 只承载输入的日历字段，实际时区在下一步应用。 */
    const local = new Date(`${value}:00.000Z`);
    if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 16) !== value) return null;
    /** 回显必须与输入一致，不能静默把不存在的当地时间移到另一个时刻。 */
    const at = zonedLocalToUtc(local, timeZone).toISOString();
    return formatAutomationOnceInput(at, timeZone) === value ? at : null;
  } catch {
    return null;
  }
}
