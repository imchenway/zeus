import type { AutomationDefinitionSnapshot, AutomationRunRecord, AutomationRunRepository, AutomationTaskRecord, AutomationTaskRepository, ConversationRepository, ZeusProjectRecord } from '@zeus/storage';

export interface AutomationDispatchResult {
  conversationId: string;
  submissionId: string;
}

export interface AutomationSchedulerOptions {
  tasks: AutomationTaskRepository;
  runs: AutomationRunRepository;
  conversations: ConversationRepository;
  getProject(projectId: string): ZeusProjectRecord | undefined;
  dispatch(input: { run: AutomationRunRecord; snapshot: AutomationDefinitionSnapshot; project: ZeusProjectRecord }): Promise<AutomationDispatchResult>;
  save(): Promise<void>;
  now(): string;
  publish(type: string, payload: Record<string, unknown>): void;
}

export interface AutomationScheduler {
  kick(): void;
  close(): Promise<void>;
}

const terminalConversationStages = new Set(['completed', 'failed', 'waiting_user', 'waiting_approval', 'paused', 'archived']);

export function createAutomationScheduler(options: AutomationSchedulerOptions): AutomationScheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickPromise: Promise<void> | null = null;
  let closed = false;

  async function tick(): Promise<void> {
    const now = options.now();
    acceptDue(now);
    reconcileRunning();
    for (const candidate of options.runs.listDispatchable(8)) await dispatch(candidate);
    await options.save();
  }

  function acceptDue(now: string): void {
    for (const task of options.tasks.listDue(now)) {
      for (const target of options.tasks.listTargets(task.id).filter((entry) => entry.enabled)) {
        const scheduledAt = task.nextRunAt ?? now;
        options.runs.enqueue({
          automationId: task.id,
          projectId: target.projectId,
          triggerKind: task.triggerKind,
          triggerIdentity: `schedule:${scheduledAt}`,
          scheduledAt,
        });
      }
      options.tasks.setNextRun(task.id, computeNextRun(task, new Date(now)), now);
    }
  }

  function reconcileRunning(): void {
    for (const task of options.tasks.list()) {
      for (const run of options.runs.listByAutomation(task.id, 200)) {
        if (run.status !== 'running' || !run.conversationId) continue;
        const conversation = options.conversations.getById(run.conversationId);
        if (!conversation || !terminalConversationStages.has(conversation.stage)) continue;
        if (conversation.stage === 'completed') {
          settle(run, 'succeeded');
        } else if (conversation.stage === 'failed') {
          settle(run, 'failed', 'ZEUS_AUTOMATION_DISPATCH_PROVIDER_FAILED', '模型运行失败。');
        } else {
          settle(run, 'blocked', 'ZEUS_AUTOMATION_DISPATCH_INTERACTION_REQUIRED', '自动化运行需要用户处理审批、问题或恢复边界。');
        }
      }
    }
  }

  function settle(run: AutomationRunRecord, status: 'succeeded' | 'failed' | 'blocked', errorCode: string | null = null, errorMessage: string | null = null): void {
    const updated = options.runs.setTerminal(run.id, status, errorCode, errorMessage);
    options.publish('automation.run.terminal', { automationId: updated.automationId, runId: updated.id, projectId: updated.projectId, status: updated.status, unread: true });
  }

  async function dispatch(candidate: AutomationRunRecord): Promise<void> {
    const running = options.runs.markDispatching(candidate.id);
    const revision = options.tasks.getRevision(running.automationRevisionId);
    const project = options.getProject(running.projectId);
    if (!revision || !project) {
      options.runs.setTerminal(running.id, 'blocked', 'ZEUS_AUTOMATION_CONFIG_TARGET_UNAVAILABLE', !revision ? '运行修订已不可用。' : '目标项目已不可用。');
      return;
    }
    try {
      const accepted = await options.dispatch({ run: running, snapshot: revision.snapshot, project });
      const updated = options.runs.markRunning(running.id, accepted.conversationId, accepted.submissionId);
      options.publish('automation.run.started', { automationId: updated.automationId, runId: updated.id, projectId: updated.projectId, conversationId: updated.conversationId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.runs.setTerminal(running.id, 'failed', errorCode(error), message.slice(0, 2_000));
    }
  }

  function kick(): void {
    if (closed || tickPromise) return;
    tickPromise = tick()
      .catch(() => undefined)
      .finally(() => {
        tickPromise = null;
      });
  }

  timer = setInterval(kick, 10_000);
  timer.unref?.();
  kick();

  return {
    kick,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await tickPromise;
    },
  };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\b(ZEUS_[A-Z0-9_]+)\b/u.exec(message);
  return match?.[1] ?? 'ZEUS_AUTOMATION_DISPATCH_FAILED';
}

export function computeNextRun(task: AutomationTaskRecord, from: Date): string | null {
  if (task.triggerKind === 'manual' || task.triggerKind === 'event') return null;
  if (task.triggerKind === 'once') {
    const at = task.triggerConfig.at ? new Date(task.triggerConfig.at) : null;
    return at && Number.isFinite(at.getTime()) && at > from ? at.toISOString() : null;
  }
  if (task.triggerKind === 'interval') {
    const minutes = Number(task.triggerConfig.everyMinutes ?? 60);
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error('ZEUS_AUTOMATION_CONFIG_INTERVAL_INVALID: 间隔必须至少一分钟。');
    return new Date(from.getTime() + Math.trunc(minutes) * 60_000).toISOString();
  }
  const parts = localParts(from, task.timezone);
  const [hour, minute] = parseLocalTime(task.triggerConfig.localTime ?? '09:00');
  if (task.triggerKind === 'daily' || task.triggerKind === 'weekly') {
    const allowed = task.triggerKind === 'weekly' ? new Set(task.triggerConfig.weekdays ?? [1]) : null;
    for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
      const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, hour, minute));
      if (allowed && !allowed.has(localDate.getUTCDay())) continue;
      const candidate = zonedLocalToUtc(localDate, task.timezone);
      if (candidate > from) return candidate.toISOString();
    }
    return null;
  }
  if (task.triggerKind === 'rrule') return nextRrule(task, from);
  return null;
}

function nextRrule(task: AutomationTaskRecord, from: Date): string | null {
  const source = task.triggerConfig.rrule?.trim().replace(/^RRULE:/iu, '');
  if (!source) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_REQUIRED: 高级调度必须提供 RRULE。');
  const values = Object.fromEntries(source.split(';').map((part) => part.split('=', 2).map((value) => value.trim().toUpperCase()))) as Record<string, string>;
  const frequency = values.FREQ;
  const interval = Math.max(1, Number.parseInt(values.INTERVAL ?? '1', 10));
  if (!['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY'].includes(frequency ?? '') || !Number.isFinite(interval)) throw new Error('ZEUS_AUTOMATION_CONFIG_RRULE_UNSUPPORTED: 当前支持 MINUTELY、HOURLY、DAILY 和 WEEKLY。');
  if (frequency === 'MINUTELY') return new Date(from.getTime() + interval * 60_000).toISOString();
  if (frequency === 'HOURLY') return new Date(from.getTime() + interval * 3_600_000).toISOString();
  const parts = localParts(from, task.timezone);
  const hour = Number.parseInt(values.BYHOUR ?? '9', 10);
  const minute = Number.parseInt(values.BYMINUTE ?? '0', 10);
  const weekdayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const weekdays = values.BYDAY
    ? new Set(
        values.BYDAY.split(',')
          .map((value) => weekdayMap[value])
          .filter((value): value is number => value !== undefined),
      )
    : null;
  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    if (dayOffset % interval !== 0 && frequency === 'DAILY') continue;
    const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, hour, minute));
    if (frequency === 'WEEKLY' && Math.floor(dayOffset / 7) % interval !== 0) continue;
    if (weekdays && !weekdays.has(localDate.getUTCDay())) continue;
    const candidate = zonedLocalToUtc(localDate, task.timezone);
    if (candidate > from) return candidate.toISOString();
  }
  return null;
}

function parseLocalTime(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('ZEUS_AUTOMATION_CONFIG_LOCAL_TIME_INVALID: 时间必须为 HH:mm。');
  return [hour, minute];
}

function localParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function zonedLocalToUtc(local: Date, timeZone: string): Date {
  let candidate = new Date(local.getTime());
  for (let index = 0; index < 3; index += 1) {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    candidate = new Date(candidate.getTime() + (local.getTime() - represented));
  }
  return candidate;
}
