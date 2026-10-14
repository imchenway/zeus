/** 任务截止时间保留用户选择的日期和时区，时区变化不重新解释既定时刻。 */
export interface TaskDeadline {
  /** 截止日期，格式为 YYYY-MM-DD。 */
  date: string;
  /** 可选的具体时间，格式为 HH:mm；空值表示当天结束。 */
  time: string | null;
  /** 设置时使用的 IANA 时区。 */
  timeZone: string;
  /** 提醒方式：默认提前、截止时或关闭。 */
  reminder: 'advance' | 'at_deadline' | 'off';
}

/** 时间快捷筛选与其他任务条件取交集。 */
export type TaskDeadlineFilter = 'all' | 'overdue' | 'today' | 'next_seven_days' | 'unset';

/** 提醒的稳定身份包含任务和截止配置修订。 */
export interface TaskReminder {
  /** 通知身份。 */
  id: string;
  /** 所属任务。 */
  taskId: string;
  /** 所属项目。 */
  projectId: string;
  /** 项目显示名称。 */
  projectName: string;
  /** 任务显示标题。 */
  title: string;
  /** 当前截止配置。 */
  deadline: TaskDeadline;
  /** 计划提醒时刻。 */
  occurredAt: string;
}

/** 未读列表返回完整计数和稳定分页游标。 */
export interface TaskReminderPage {
  /** 当前页未读提醒。 */
  items: TaskReminder[];
  /** 所有未读提醒数。 */
  unreadCount: number;
  /** 下一页游标。 */
  nextCursor: string | null;
}

/** 时间解析复用格式器；限制数量，避免任意时区请求无限占用内存。 */
const deadlineFormatters = new Map<string, Intl.DateTimeFormat>();

/** 返回时区中的日期和分钟时间，避免依赖宿主系统时区。 */
function localDeadlineParts(instant: number, timeZone: string): { date: string; time: string } {
  /** 相同时区共用格式器。 */
  let formatter = deadlineFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (deadlineFormatters.size >= 32) deadlineFormatters.clear();
    deadlineFormatters.set(timeZone, formatter);
  }
  /** 使用部件而非本地化标点构建存储值。 */
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** 在日历日期上加天，不把夏令时的一天假定为 24 小时。 */
function shiftDeadlineDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** 重复分钟取首次；用户指定的缺失分钟拒绝保存，自动日界线顺延到首个有效分钟。 */
function deadlineInstant(date: string, time: string, timeZone: string, allowGap = false): number {
  /** 此值只用于计算时区偏移，不是最终截止时刻。 */
  const wall = Date.parse(`${date}T${time}:00Z`);
  /** 收集切换前后的偏移，覆盖夏令时重复和跳过的分钟。 */
  const candidates = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    /** 临近时刻的当地时间提供真实偏移。 */
    const sample = wall + hours * 3600000;
    /** 时区转换后的日历部件。 */
    const parts = localDeadlineParts(sample, timeZone);
    candidates.add(wall - (Date.parse(`${parts.date}T${parts.time}:00Z`) - sample));
  }
  /** 反向核对，避免把不存在的时间静默推迟。 */
  const matches = [...candidates].filter((candidate) => {
    /** 转换结果必须与用户输入一致。 */
    const parts = localDeadlineParts(candidate, timeZone);
    return parts.date === date && parts.time === time;
  });
  if (!matches.length && allowGap) {
    /** 零点可能被夏令时跳过，日期任务仍在该日实际结束时截止。 */
    let next = Math.min(
      ...[...candidates].filter((candidate) => {
        /** 使用固定格式比较当地日历部件。 */
        const parts = localDeadlineParts(candidate, timeZone);
        return `${parts.date}T${parts.time}` > `${date}T${time}`;
      }),
    );
    while (Number.isFinite(next)) {
      /** 回退至缺口后的首个分钟，避免把偏移变化量当成日界线。 */
      const previous = localDeadlineParts(next - 60000, timeZone);
      if (`${previous.date}T${previous.time}` < `${date}T${time}`) return next;
      next -= 60000;
    }
  }
  if (!matches.length) throw new Error('该时间在所选时区不存在，请选择其他时间。');
  return Math.min(...matches);
}

/** 所有写入边界使用相同校验和字段顺序，等价配置不会产生新提醒。 */
export function normalizeTaskDeadline(value: unknown): TaskDeadline | null {
  if (value === null || value === undefined) return null;
  try {
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error();
    /** 不接受未知结构或自动归一化的无效日期。 */
    const input = value as Partial<TaskDeadline>;
    if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date < '0001-01-01' || input.date > '9998-12-31' || new Date(`${input.date}T00:00:00Z`).toISOString().slice(0, 10) !== input.date) throw new Error();
    if (input.time != null && (typeof input.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time))) throw new Error();
    if (typeof input.timeZone !== 'string' || !input.timeZone || input.timeZone.length > 128) throw new Error();
    if (input.reminder !== undefined && !['advance', 'at_deadline', 'off'].includes(input.reminder)) throw new Error();
    /** 固定时区和提醒方式；只有清空整个配置才移除截止时间。 */
    const deadline: TaskDeadline = { date: input.date, time: input.time ?? null, timeZone: input.timeZone, reminder: input.reminder ?? 'advance' };
    if (!deadline.time && localDeadlineParts(deadlineInstant(deadline.date, '00:00', deadline.timeZone, true), deadline.timeZone).date !== deadline.date) throw new Error('该日期在所选时区不存在，请选择其他日期。');
    taskDeadlineTimes(deadline);
    return deadline;
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error && error.message.includes('时区不存在') ? error.message : '截止日期、时间、时区或提醒方式无效。'), { code: 'ZEUS_TASK_DEADLINE_INVALID', statusCode: 400 });
  }
}

/** 日期任务在下一天零点截止；提醒使用同一时区的当天 09:00。 */
export function taskDeadlineTimes(deadline: TaskDeadline): { dueAt: string; remindAt: string | null } {
  /** 截止边界使用当地日历日，不减一毫秒。 */
  const due = deadlineInstant(deadline.time ? deadline.date : shiftDeadlineDate(deadline.date, 1), deadline.time ?? '00:00', deadline.timeZone, !deadline.time);
  /** 提前提醒仅计算一次，没有每日重复排程。 */
  const reminder = deadline.reminder === 'off' ? null : deadline.reminder === 'at_deadline' ? due : deadline.time ? due - 1800000 : deadlineInstant(deadline.date, '09:00', deadline.timeZone, true);
  return { dueAt: new Date(due).toISOString(), remindAt: reminder === null ? null : new Date(reminder).toISOString() };
}

/** 快捷筛选在服务端分页及界面展示中共用，终态来自项目配置。 */
export function matchesTaskDeadline(task: { deadline?: TaskDeadline | null; managementStatus?: string }, filter: TaskDeadlineFilter, now = Date.now(), terminalStatuses: readonly string[] = ['completed', 'cancelled']): boolean {
  if (filter === 'all') return true;
  if (filter === 'unset') return !task.deadline;
  if (!task.deadline) return false;
  if (filter === 'overdue') return !terminalStatuses.includes(task.managementStatus ?? 'todo') && Date.parse(taskDeadlineTimes(task.deadline).dueAt) <= now;
  /** 今天按任务保存的时区解释，避免旅行后改变日期语义。 */
  const today = localDeadlineParts(now, task.deadline.timeZone).date;
  return filter === 'today' ? task.deadline.date === today : task.deadline.date > today && task.deadline.date <= shiftDeadlineDate(today, 7);
}

/** 接口边界只接受已定义的快捷筛选。 */
export function isTaskDeadlineFilter(value: unknown): value is TaskDeadlineFilter {
  return typeof value === 'string' && ['all', 'overdue', 'today', 'next_seven_days', 'unset'].includes(value);
}

/** 使用已保存时区展示截止信息，兼顾提示文本和可访问名称。 */
export function formatTaskDeadline(deadline: TaskDeadline | null | undefined): string {
  return deadline ? `${deadline.date}${deadline.time ? ` ${deadline.time}` : ''} · ${deadline.timeZone}` : '—';
}
