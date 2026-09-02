import { type PreparedTaskStatusTelegramEffect, type TaskStatusTelegramEffectInput, WorkManagementCommandApplication } from './workManagementCommandApplication.js';

export interface PreparedTelegramTaskStatusNotification {
  recipientCount: number;
  send(): Promise<void>;
}

/**
 * Task status 的 Telegram 通知消费统一 Command Outbox。prepared 可在重启后安全补派；
 * write_started 没有回执时由通用启动恢复封存为 unknown，绝不自动重发。
 */
export class WorkManagementTaskEffectService {
  private readonly active = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, PreparedTaskStatusTelegramEffect>();
  private readonly waiters = new Set<() => void>();
  private recoveryScan: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly options: {
      application: WorkManagementCommandApplication;
      prepareTelegramNotification(input: TaskStatusTelegramEffectInput): Promise<PreparedTelegramTaskStatusNotification>;
      recordTaskEvent(input: { taskId: string; eventType: string; title: string; payload: Record<string, unknown> }): void;
      redactSensitiveText(value: string): { text: string };
      reportError?(message: string, error: unknown): void;
      concurrency?: number;
    },
  ) {}

  recover(limit = 256): void {
    if (this.closed || this.recoveryScan) return;
    const execution = yieldToEventLoop()
      .then(() => this.scanPrepared(limit))
      .finally(() => {
        if (this.recoveryScan === execution) this.recoveryScan = null;
      });
    this.recoveryScan = execution;
  }

  schedule(effect: PreparedTaskStatusTelegramEffect): void {
    const commandId = effect.parsed.command.commandId;
    if (this.closed || this.active.has(commandId) || this.queued.has(commandId)) return;
    this.queued.set(commandId, effect);
    this.pump();
  }

  async drain(): Promise<void> {
    while (this.recoveryScan || this.active.size > 0 || this.queued.size > 0) {
      const work = [...this.active.values()];
      if (this.recoveryScan) work.push(this.recoveryScan);
      if (work.length > 0) await Promise.all(work);
      else await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queued.clear();
    this.notifyProgress();
    await this.drain();
  }

  private async scanPrepared(limit: number): Promise<void> {
    let afterCommandId: string | null = null;
    while (!this.closed) {
      const batch = this.options.application.listPreparedTaskStatusTelegramEffects(afterCommandId, limit);
      for (const effect of batch) this.schedule(effect);
      if (batch.length < limit) return;
      afterCommandId = batch.at(-1)?.parsed.command.commandId ?? null;
      await this.waitForBatch(batch.map((effect) => effect.parsed.command.commandId));
      await yieldToEventLoop();
    }
  }

  private pump(): void {
    const concurrency = Math.max(1, Math.min(4, this.options.concurrency ?? 1));
    while (!this.closed && this.active.size < concurrency && this.queued.size > 0) {
      const [commandId, effect] = this.queued.entries().next().value as [string, PreparedTaskStatusTelegramEffect];
      this.queued.delete(commandId);
      const execution = this.dispatch(effect)
        .catch((error) => this.reportError('Task status Telegram 外部效果未完成；耐久回执已保留可恢复结论。', error))
        .finally(() => {
          this.active.delete(commandId);
          this.pump();
          this.notifyProgress();
        });
      this.active.set(commandId, execution);
    }
  }

  private async dispatch(effect: PreparedTaskStatusTelegramEffect): Promise<void> {
    let prepared: PreparedTelegramTaskStatusNotification | null = null;
    await this.options.application.dispatchTaskStatusTelegramEffect({
      effect,
      beforeWrite: async () => {
        prepared = await this.options.prepareTelegramNotification(effect.parsed.input);
      },
      invoke: async () => {
        if (!prepared) throw new Error('Telegram task status notification was not prepared before write.');
        await prepared.send();
        return {
          taskId: effect.parsed.input.taskId,
          status: effect.parsed.input.status,
          delivered: true as const,
          recipientCount: prepared.recipientCount,
        };
      },
      mutateAcceptedBusinessState: (result) => {
        this.options.recordTaskEvent({
          taskId: effect.parsed.input.taskId,
          eventType: 'telegram.notification.sent',
          title: 'Telegram 通知已发送',
          payload: {
            status: effect.parsed.input.status,
            recipientCount: result.recipientCount,
            childCommandId: effect.parsed.command.commandId,
          },
        });
        return result;
      },
      mutateFailureBusinessState: (outcome, error) => {
        this.options.recordTaskEvent({
          taskId: effect.parsed.input.taskId,
          eventType: 'telegram.notification.failed',
          title: outcome === 'outcome_unknown_after_write' ? 'Telegram 通知结果未知' : 'Telegram 通知未发送',
          payload: {
            status: effect.parsed.input.status,
            outcome,
            childCommandId: effect.parsed.command.commandId,
            error: safeError(error, this.options.redactSensitiveText),
          },
        });
      },
      isExplicitRejection: isExplicitTelegramRejection,
    });
  }

  private async waitForBatch(commandIds: string[]): Promise<void> {
    const pending = new Set(commandIds);
    while ([...pending].some((commandId) => this.active.has(commandId) || this.queued.has(commandId))) {
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  private notifyProgress(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  private reportError(message: string, error: unknown): void {
    const safe = safeError(error, this.options.redactSensitiveText);
    if (this.options.reportError) this.options.reportError(message, safe);
    else console.error(message, safe);
  }
}

function isExplicitTelegramRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
}

function safeError(error: unknown, redactSensitiveText: (value: string) => { text: string }): { code: string | number | null; name: string; message: string } {
  const candidate = error instanceof Error ? error : new Error(String(error));
  const rawCode = 'code' in candidate ? (candidate as Error & { code?: unknown }).code : null;
  const code = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' ? rawCode.slice(0, 128) : null;
  const redacted = redactSensitiveText(candidate.message).text;
  const bytes = Buffer.from(redacted, 'utf8');
  const message =
    bytes.byteLength <= 2_048
      ? redacted
      : `${bytes
          .subarray(0, 2_045)
          .toString('utf8')
          .replace(/\uFFFD$/u, '')}...`;
  return { code, name: candidate.name.slice(0, 128), message };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
