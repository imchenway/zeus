import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskEventFileProjectionRepository, TaskEventRepository, type ZeusDatabase, type ZeusTaskEventRecord } from '@zeus/storage';

type ProjectionFileKind = 'events' | 'timeline';

/**
 * task_events 是唯一事实；正常投影只追加 appliedEventId 后的增量。
 * write_started、两文件游标不一致或上次写出中断时，消费者才分批整体重建。
 */
export class TaskEventFileProjectionService {
  private readonly active = new Map<string, Promise<void>>();
  private readonly queued = new Set<string>();
  private readonly dispatchWaiters = new Set<() => void>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryCounts = new Map<string, number>();
  private recoveryScan: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      outbox: TaskEventFileProjectionRepository;
      events: Pick<TaskEventRepository, 'getProjectionCursor' | 'listProjectionBatch'>;
      localLogDirectory: string;
      sanitizeTaskId(value: string): string;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
      /** 行为 verifier 用于在两文件边界注入崩溃；生产不配置。 */
      onWriteStep?(input: { taskId: string; mode: 'append' | 'rebuild'; step: 'events_synced' | 'events_renamed'; batchCount: number }): void;
      /** 行为 verifier 用于模拟底层 write 返回 0；生产使用 FileHandle.write。 */
      writeChunk?(handle: FileHandle, bytes: Buffer, offset: number, length: number): Promise<number>;
      reportError?(message: string, error: unknown): void;
      projectionBatchSize?: number;
      projectionConcurrency?: number;
    },
  ) {}

  /** 启动扫描按 taskId 分页并主动让出事件循环，不让 >256 backlog 阻塞服务就绪。 */
  recover(limit = 256): void {
    if (this.closed || this.recoveryScan) return;
    const execution = yieldToEventLoop()
      .then(() => this.scanRecoverable(limit))
      .finally(() => {
        if (this.recoveryScan === execution) this.recoveryScan = null;
      });
    this.recoveryScan = execution;
  }

  schedule(taskId: string): void {
    if (this.closed || this.active.has(taskId) || this.queued.has(taskId)) return;
    const retryTimer = this.retryTimers.get(taskId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.retryTimers.delete(taskId);
    }
    this.queued.add(taskId);
    this.pump();
  }

  async drain(): Promise<void> {
    while (this.recoveryScan || this.active.size > 0 || this.queued.size > 0) {
      const work = [...this.active.values()];
      if (this.recoveryScan) work.push(this.recoveryScan);
      if (work.length > 0) await Promise.all(work);
      else await this.waitForDispatchProgress();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queued.clear();
    this.notifyDispatchProgress();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await this.drain();
  }

  private async scanRecoverable(limit: number): Promise<void> {
    let afterTaskId: string | null = null;
    while (!this.closed) {
      const batch = this.options.outbox.listRecoverableAfter(afterTaskId, limit);
      for (const record of batch) this.schedule(record.taskId);
      if (batch.length < limit) return;
      afterTaskId = batch.at(-1)?.taskId ?? null;
      await this.waitForTaskBatch(batch.map((record) => record.taskId));
      await yieldToEventLoop();
    }
  }

  private pump(): void {
    // ZeusDatabase 是单一 WAL writer；claim/receipt 使用同步耐久事务，默认串行派发避免与 save loop 争抢。
    const concurrency = Math.max(1, Math.min(8, this.options.projectionConcurrency ?? 1));
    while (!this.closed && this.active.size < concurrency && this.queued.size > 0) {
      const taskId = this.queued.values().next().value as string;
      this.queued.delete(taskId);
      const execution = Promise.resolve()
        .then(() => this.flushTask(taskId))
        .finally(() => {
          this.active.delete(taskId);
          const pending = this.options.outbox.get(taskId);
          if (!this.closed && pending && pending.appliedRevision < pending.requestedRevision) {
            if (pending.state === 'pending') queueMicrotask(() => this.schedule(taskId));
            else this.scheduleRetry(taskId);
          }
          this.pump();
          this.notifyDispatchProgress();
        });
      this.active.set(taskId, execution);
    }
  }

  private async waitForTaskBatch(taskIds: string[]): Promise<void> {
    const pending = new Set(taskIds);
    while ([...pending].some((taskId) => this.active.has(taskId) || this.queued.has(taskId))) await this.waitForDispatchProgress();
  }

  private waitForDispatchProgress(): Promise<void> {
    return new Promise((resolve) => this.dispatchWaiters.add(resolve));
  }

  private notifyDispatchProgress(): void {
    const waiters = [...this.dispatchWaiters];
    this.dispatchWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private async flushTask(taskId: string): Promise<void> {
    let revision: number | null = null;
    try {
      await this.options.db.save();
      const claim = this.options.outbox.claim(taskId, this.options.now().toISOString());
      if (!claim) return;
      revision = claim.targetRevision;
      const targetCursor = this.options.events.getProjectionCursor(claim.targetEventId);
      if (!targetCursor || targetCursor.taskId !== taskId) throw new Error('任务事件文件投影的目标事件不存在或不属于目标任务。');
      const appliedCursor = claim.record.appliedEventId ? this.options.events.getProjectionCursor(claim.record.appliedEventId) : null;
      const paths = await this.prepareTaskPaths(taskId);
      const rebuild = claim.recoveryNeeded || Boolean(claim.record.appliedEventId && (!appliedCursor || appliedCursor.taskId !== taskId)) || !(await projectionFilesMatchCursor(paths, claim.record.appliedEventId));
      const afterSequence = rebuild ? 0 : (appliedCursor?.sequence ?? 0);
      if (rebuild) await this.rebuildFiles(taskId, paths, afterSequence, targetCursor.sequence, revision);
      else await this.appendFiles(taskId, paths, afterSequence, targetCursor.sequence);
      const accepted = this.options.outbox.markAccepted(taskId, revision, claim.targetEventId, this.options.now().toISOString());
      this.retryCounts.delete(taskId);
      if (accepted.appliedRevision < accepted.requestedRevision) queueMicrotask(() => this.schedule(taskId));
    } catch (error) {
      if (revision !== null) {
        try {
          // 保留 write_started：下次必须重建两份文件，不能在未知尾部继续 append。
          this.options.outbox.markRetryable(taskId, revision, safeError(error, this.options.redactSensitiveText), this.options.now().toISOString());
        } catch (receiptError) {
          this.reportError('任务事件文件投影失败且无法保存 retry receipt。', receiptError);
        }
      }
      this.reportError('任务事件文件投影失败；SQLite 事实保持有效并等待有界重试。', safeError(error, this.options.redactSensitiveText));
    }
  }

  private reportError(message: string, error: unknown): void {
    if (this.options.reportError) this.options.reportError(message, error);
    else console.error(message, error);
  }

  private async appendFiles(taskId: string, paths: TaskProjectionPaths, afterSequence: number, throughSequence: number): Promise<number> {
    const eventsHandle = await openProjectionFileForAppend(paths.events);
    let batchCount = 0;
    try {
      batchCount = await this.writeProjectionBatches(eventsHandle, 'events', taskId, afterSequence, throughSequence);
      await eventsHandle.sync();
      this.options.onWriteStep?.({ taskId, mode: 'append', step: 'events_synced', batchCount });
    } finally {
      await eventsHandle.close();
    }
    const timelineHandle = await openProjectionFileForAppend(paths.timeline);
    try {
      const timelineBatchCount = await this.writeProjectionBatches(timelineHandle, 'timeline', taskId, afterSequence, throughSequence);
      if (timelineBatchCount !== batchCount) throw new Error('任务事件两份文件投影的批次数不一致。');
      await timelineHandle.sync();
    } finally {
      await timelineHandle.close();
    }
    await fsyncDirectory(paths.directory);
    return batchCount;
  }

  private async rebuildFiles(taskId: string, paths: TaskProjectionPaths, afterSequence: number, throughSequence: number, revision: number): Promise<number> {
    await cleanupStaleProjectionTemporaryFiles(paths.directory);
    await assertSafeProjectionTarget(paths.events);
    await assertSafeProjectionTarget(paths.timeline);
    const eventsTemporary = `${paths.events}.projection-${revision}-${process.pid}-${randomUUID()}.tmp`;
    const timelineTemporary = `${paths.timeline}.projection-${revision}-${process.pid}-${randomUUID()}.tmp`;
    let eventsHandle: FileHandle | null = null;
    let timelineHandle: FileHandle | null = null;
    try {
      eventsHandle = await openTemporaryProjectionFile(eventsTemporary);
      const batchCount = await this.writeProjectionBatches(eventsHandle, 'events', taskId, afterSequence, throughSequence);
      await eventsHandle.sync();
      await eventsHandle.close();
      eventsHandle = null;
      this.options.onWriteStep?.({ taskId, mode: 'rebuild', step: 'events_synced', batchCount });

      timelineHandle = await openTemporaryProjectionFile(timelineTemporary);
      const timelineBatchCount = await this.writeProjectionBatches(timelineHandle, 'timeline', taskId, afterSequence, throughSequence);
      if (timelineBatchCount !== batchCount) throw new Error('任务事件两份文件重建的批次数不一致。');
      await timelineHandle.sync();
      await timelineHandle.close();
      timelineHandle = null;

      await assertSafeProjectionTarget(paths.events);
      await assertSafeProjectionTarget(paths.timeline);
      await rename(eventsTemporary, paths.events);
      this.options.onWriteStep?.({ taskId, mode: 'rebuild', step: 'events_renamed', batchCount });
      await rename(timelineTemporary, paths.timeline);
      await fsyncDirectory(paths.directory);
      return batchCount;
    } catch (error) {
      if (eventsHandle !== null) await eventsHandle.close().catch(() => undefined);
      if (timelineHandle !== null) await timelineHandle.close().catch(() => undefined);
      await unlinkIfPresent(eventsTemporary);
      await unlinkIfPresent(timelineTemporary);
      throw error;
    }
  }

  private async writeProjectionBatches(handle: FileHandle, kind: ProjectionFileKind, taskId: string, afterSequence: number, throughSequence: number): Promise<number> {
    const limit = Math.max(1, Math.min(512, this.options.projectionBatchSize ?? 128));
    let cursor = afterSequence;
    let finalEventId: string | null = null;
    let batchCount = 0;
    while (cursor < throughSequence) {
      const batch = this.options.events.listProjectionBatch({ taskId, afterSequence: cursor, throughSequence, limit });
      if (batch.length === 0) break;
      const content = batch.map(({ event }) => formatProjectionLine(kind, event)).join('');
      await writeAll(handle, content, this.options.writeChunk);
      cursor = batch.at(-1)!.sequence;
      finalEventId = batch.at(-1)!.event.id;
      batchCount += 1;
    }
    const target = this.options.events.listProjectionBatch({ taskId, afterSequence: Math.max(0, throughSequence - 1), throughSequence, limit: 1 }).at(0)?.event.id ?? null;
    if (cursor !== throughSequence || finalEventId !== target) throw new Error('任务事件文件投影未抵达声明的目标事件游标。');
    return batchCount;
  }

  private async prepareTaskPaths(taskId: string): Promise<TaskProjectionPaths> {
    const logsRoot = await requireSecureDirectory(this.options.localLogDirectory, false);
    const tasksDirectory = await requireSecureDirectory(join(logsRoot, 'tasks'), true);
    const directory = await requireSecureDirectory(join(tasksDirectory, this.options.sanitizeTaskId(taskId)), true);
    return { directory, events: join(directory, 'events.jsonl'), timeline: join(directory, 'timeline.normalized.log') };
  }

  private scheduleRetry(taskId: string): void {
    if (this.closed || this.retryTimers.has(taskId)) return;
    const attempt = (this.retryCounts.get(taskId) ?? 0) + 1;
    this.retryCounts.set(taskId, attempt);
    const delayMs = Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7));
    const timer = setTimeout(() => {
      this.retryTimers.delete(taskId);
      this.schedule(taskId);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(taskId, timer);
  }
}

interface TaskProjectionPaths {
  directory: string;
  events: string;
  timeline: string;
}

async function projectionFilesMatchCursor(paths: TaskProjectionPaths, expectedEventId: string | null): Promise<boolean> {
  const [eventsCursor, timelineCursor] = await Promise.all([readProjectionCursor(paths.events, 'events'), readProjectionCursor(paths.timeline, 'timeline')]);
  return eventsCursor === expectedEventId && timelineCursor === expectedEventId;
}

async function readProjectionCursor(path: string, kind: ProjectionFileKind): Promise<string | null> {
  const metadata = await safeProjectionFileMetadata(path);
  if (!metadata) return null;
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await assertSafeOpenedProjectionFile(handle, path);
    await handle.chmod(0o600);
    const size = (await handle.stat()).size;
    if (size === 0) return null;
    let contentEnd = size;
    const singleByte = Buffer.allocUnsafe(1);
    while (contentEnd > 0) {
      await handle.read(singleByte, 0, 1, contentEnd - 1);
      if (singleByte[0] !== 10 && singleByte[0] !== 13) break;
      contentEnd -= 1;
    }
    if (contentEnd === 0) return null;
    let lineStart = 0;
    const chunk = Buffer.allocUnsafe(4_096);
    let scanEnd = contentEnd;
    while (scanEnd > 0) {
      const scanStart = Math.max(0, scanEnd - chunk.length);
      const readLength = scanEnd - scanStart;
      await handle.read(chunk, 0, readLength, scanStart);
      for (let index = readLength - 1; index >= 0; index -= 1) {
        if (chunk[index] === 10) {
          lineStart = scanStart + index + 1;
          scanEnd = 0;
          break;
        }
      }
      if (scanEnd > 0) scanEnd = scanStart;
    }
    const prefixLength = Math.min(1_024, contentEnd - lineStart);
    const prefix = Buffer.allocUnsafe(prefixLength);
    await handle.read(prefix, 0, prefixLength, lineStart);
    const text = prefix.toString('utf8');
    const match = kind === 'events' ? /^\{"id":"([^"]+)"/u.exec(text) : /^\S+ \[eventId=([^\]]+)\]/u.exec(text);
    return match?.[1] ?? '__cursor_invalid__';
  } finally {
    await handle.close();
  }
}

function formatProjectionLine(kind: ProjectionFileKind, event: ZeusTaskEventRecord): string {
  if (kind === 'events') return `${JSON.stringify(event)}\n`;
  return `${event.createdAt} [eventId=${event.id}] [${singleLineProjectionField(event.eventType, 512)}] ${singleLineProjectionField(event.title, 2 * 1024)} taskId=${singleLineProjectionField(event.taskId, 512)} payload=${event.payloadJson}\n`;
}

async function requireSecureDirectory(path: string, create: boolean): Promise<string> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`任务事件投影目录不是受控普通目录：${path}`);
  await chmod(path, 0o700);
  return path;
}

async function safeProjectionFileMetadata(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) throw new Error(`任务事件投影目标不是受控单链接普通文件：${path}`);
    return metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertSafeProjectionTarget(path: string): Promise<void> {
  const metadata = await safeProjectionFileMetadata(path);
  if (metadata) await chmod(path, 0o600);
}

async function openProjectionFileForAppend(path: string): Promise<FileHandle> {
  await assertSafeProjectionTarget(path);
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await assertSafeOpenedProjectionFile(handle, path);
    await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function openTemporaryProjectionFile(path: string): Promise<FileHandle> {
  return open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
}

async function assertSafeOpenedProjectionFile(handle: FileHandle, path: string): Promise<void> {
  const metadata = await handle.stat();
  if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`任务事件投影已打开目标不是受控单链接普通文件：${path}`);
}

async function cleanupStaleProjectionTemporaryFiles(directory: string): Promise<void> {
  const maximumEntries = 1_024;
  const maximumRemovals = 64;
  const temporaryName = /^(?:events\.jsonl|timeline\.normalized\.log)\.projection-[1-9][0-9]*-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
  const entries = await opendir(directory);
  let inspected = 0;
  let removed = 0;
  try {
    for await (const entry of entries) {
      inspected += 1;
      if (inspected > maximumEntries) throw new Error('任务事件投影目录超过有界临时文件扫描容量。');
      if (!temporaryName.test(entry.name)) continue;
      if (removed >= maximumRemovals) throw new Error('任务事件投影目录超过单轮有界临时文件清理容量。');
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) throw new Error(`任务事件投影遗留临时目标不是受控单链接普通文件：${path}`);
      await unlink(path);
      removed += 1;
    }
  } finally {
    await entries.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  if (removed > 0) await fsyncDirectory(directory);
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, content: string, writeChunk?: (handle: FileHandle, bytes: Buffer, offset: number, length: number) => Promise<number>): Promise<void> {
  const bytes = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < bytes.byteLength) {
    const bytesWritten = writeChunk ? await writeChunk(handle, bytes, offset, bytes.byteLength - offset) : (await handle.write(bytes, offset, bytes.byteLength - offset)).bytesWritten;
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) throw new Error('任务事件文件投影底层写入没有取得正向进展。');
    offset += bytesWritten;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function singleLineProjectionField(value: string, maximumBytes: number): string {
  const escaped = Array.from(value, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || (point >= 127 && point <= 159) ? `\\u${point.toString(16).padStart(4, '0')}` : character;
  }).join('');
  const bytes = Buffer.from(escaped, 'utf8');
  if (bytes.byteLength <= maximumBytes) return escaped;
  return `${bytes
    .subarray(0, Math.max(0, maximumBytes - 3))
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}

function safeError(error: unknown, redactSensitiveText: (value: string) => { text: string }): { code: string | number | null; name: string; message: string } {
  const name = error instanceof Error ? error.name.slice(0, 128) : typeof error;
  const code = error && typeof error === 'object' && 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : null;
  const redacted = redactSensitiveText(error instanceof Error ? error.message : String(error)).text;
  const bytes = Buffer.from(redacted, 'utf8');
  const message =
    bytes.byteLength <= 2_048
      ? redacted
      : `${bytes
          .subarray(0, 2_045)
          .toString('utf8')
          .replace(/\uFFFD$/u, '')}...`;
  return { code: typeof code === 'string' ? code.slice(0, 128) : code, name, message };
}
