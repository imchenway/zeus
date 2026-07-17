import { createHash } from 'node:crypto';
import { chmod, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { CodexAppServerManager, ExternalAgentConfigMigrationItem, ExternalAgentImportEvent, ExternalAgentImportFailure, ExternalAgentImportSuccess } from '@zeus/ai-runtime';
import type { CodexLegacyImportRepository, ConversationRepository, ZeusCodexLegacyImportRecord, ZeusConversationWithMessagesRecord, ZeusDatabase } from '@zeus/storage';

export interface CodexLegacyImportEligibleSession {
  sourceConversationId: string;
  title: string;
  cwd: string;
  snapshotPath: string;
  snapshotSha256: string;
}

export interface CodexLegacyImportSnapshot {
  eligible: CodexLegacyImportEligibleSession[];
  runs: ZeusCodexLegacyImportRecord[];
}

export interface CodexLegacyImportStartResult {
  importId: string;
  status: 'waiting' | 'completed' | 'failed';
  runs: ZeusCodexLegacyImportRecord[];
}

export interface CreateCodexLegacyImportServiceOptions {
  manager: CodexAppServerManager;
  db: ZeusDatabase;
  conversations: ConversationRepository;
  imports: CodexLegacyImportRepository;
  sourceRoot: string;
  allowedProjectRoots: string[] | (() => string[]);
  commandPath: string;
  providerBinaryVersion: string;
  onUpdated?: (snapshot: { importId: string; status: CodexLegacyImportStartResult['status']; completedCount: number; failedCount: number; waitingCount: number }) => void;
}

export interface CodexLegacyImportService {
  detect(): Promise<CodexLegacyImportSnapshot>;
  start(input: { sourceConversationIds: string[] }): Promise<CodexLegacyImportStartResult>;
  get(importId: string): CodexLegacyImportStartResult;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export function createCodexLegacyImportService(options: CreateCodexLegacyImportServiceOptions): CodexLegacyImportService {
  if (!isAbsolute(options.sourceRoot)) throw importError('ZEUS_CODEX_LEGACY_SOURCE_ROOT_INVALID', 'Codex legacy import root must be absolute.');
  let eventChain = Promise.resolve();
  let closed = false;
  const unsubscribe = options.manager.subscribeExternalAgentImport((event) => {
    eventChain = eventChain.then(() => handleImportEvent(event)).catch(() => undefined);
  });

  async function ready(): Promise<string> {
    await mkdir(options.sourceRoot, { recursive: true, mode: 0o700 });
    const canonicalSourceRoot = await realpath(options.sourceRoot);
    await options.manager.ensureReady({ commandPath: options.commandPath, externalAgentHome: canonicalSourceRoot });
    return canonicalSourceRoot;
  }

  async function detect(): Promise<CodexLegacyImportSnapshot> {
    assertOpen();
    const canonicalSourceRoot = await ready();
    const allowedRoots = await canonicalAllowedRoots(typeof options.allowedProjectRoots === 'function' ? options.allowedProjectRoots() : options.allowedProjectRoots);
    const candidates = options.db.select<{ id: string; local_path: string }>(
      `SELECT conversations.id, projects.local_path
       FROM conversations JOIN projects ON projects.id = conversations.project_id
       WHERE conversations.archived = 0 AND conversations.transport_kind = 'legacy_cli'
         AND conversations.provider_thread_id IS NULL
       ORDER BY conversations.created_at, conversations.id`,
    );
    const eligible: CodexLegacyImportEligibleSession[] = [];
    for (const candidate of candidates) {
      const conversation = options.conversations.getById(candidate.id);
      if (!conversation || !conversation.messages.some((message) => message.role === 'user' && message.content.trim().length > 0)) continue;
      const cwd = await canonicalEligibleProjectRoot(candidate.local_path, allowedRoots);
      if (!cwd) continue;
      const snapshot = await writeConversationSnapshot(canonicalSourceRoot, cwd, conversation);
      eligible.push({ sourceConversationId: conversation.id, title: conversation.title, cwd, ...snapshot });
    }
    const cwds = [...new Set(eligible.map((entry) => entry.cwd))].sort();
    await options.manager.detectExternalAgentConfig({ includeHome: true, cwds });
    return {
      eligible,
      runs: options.imports.listRecent(),
    };
  }

  async function start(input: { sourceConversationIds: string[] }): Promise<CodexLegacyImportStartResult> {
    assertOpen();
    const sourceConversationIds = [...new Set(input.sourceConversationIds)];
    if (sourceConversationIds.length === 0 || sourceConversationIds.length !== input.sourceConversationIds.length) {
      throw importError('ZEUS_CODEX_LEGACY_IMPORT_SELECTION_INVALID', 'Codex legacy import requires unique source conversation ids.');
    }
    const snapshot = await detect();
    const eligibleById = new Map(snapshot.eligible.map((entry) => [entry.sourceConversationId, entry]));
    const historical = sourceConversationIds.flatMap((id) => options.imports.listBySourceConversation(id));
    const latestHistorical = historical.filter((run) => run.providerImportId !== null && (run.status === 'waiting' || run.status === 'completed'));
    if (sourceConversationIds.every((id) => !eligibleById.has(id))) {
      const providerImportIds = [...new Set(latestHistorical.map((run) => run.providerImportId!))];
      if (providerImportIds.length === 1) return buildResult(providerImportIds[0]!);
      throw importError('ZEUS_CODEX_LEGACY_IMPORT_SOURCE_INELIGIBLE', 'Selected legacy conversations are not eligible for import.');
    }
    if (sourceConversationIds.some((id) => !eligibleById.has(id))) {
      throw importError('ZEUS_CODEX_LEGACY_IMPORT_SOURCE_INELIGIBLE', 'Every selected legacy conversation must be eligible for import.');
    }
    const runs = sourceConversationIds.map((id) => {
      const eligible = eligibleById.get(id)!;
      const run = options.imports.createRun({
        sourceConversationId: id,
        snapshotPath: eligible.snapshotPath,
        snapshotSha256: eligible.snapshotSha256,
        providerBinaryVersion: options.providerBinaryVersion,
      });
      return run.status === 'failed' ? options.imports.retryFailed(run.id) : run;
    });
    const alreadyStartedIds = [...new Set(runs.flatMap((run) => (run.providerImportId ? [run.providerImportId] : [])))];
    if (alreadyStartedIds.length === 1 && runs.every((run) => run.status !== 'prepared')) return buildResult(alreadyStartedIds[0]!);
    if (runs.some((run) => run.status !== 'prepared')) throw importError('ZEUS_CODEX_LEGACY_IMPORT_STATE_CONFLICT', 'Selected legacy imports are not in one recoverable state.');
    const sessions = sourceConversationIds.map((id) => {
      const eligible = eligibleById.get(id)!;
      return { path: eligible.snapshotPath, cwd: eligible.cwd, title: eligible.title || null };
    });
    const migrationItems: ExternalAgentConfigMigrationItem[] = [
      {
        itemType: 'SESSIONS',
        description: `${sessions.length} Zeus legacy session${sessions.length === 1 ? '' : 's'}`,
        cwd: sessions.length === 1 ? sessions[0]!.cwd : null,
        details: { sessions },
      },
    ];
    const response = await options.manager.startExternalAgentImport({ source: 'zeus-legacy', migrationItems });
    for (const run of runs) options.imports.markStarted(run.id, response.importId);
    await options.db.save();
    const result = buildResult(response.importId);
    notifyUpdated(result);
    return result;
  }

  function get(importId: string): CodexLegacyImportStartResult {
    return buildResult(importId);
  }

  async function recover(): Promise<void> {
    assertOpen();
    await ready();
    const histories = await options.manager.readExternalAgentImportHistories();
    for (const history of histories) {
      if (options.imports.getByImportId(history.importId).every((run) => run.status !== 'waiting')) continue;
      await applyImportResults(history.importId, history.successes, history.failures);
    }
    await options.db.save();
    for (const importId of new Set(histories.map((history) => history.importId))) {
      const runs = options.imports.getByImportId(importId);
      if (runs.length > 0) notifyUpdated(buildResult(importId));
    }
  }

  async function handleImportEvent(event: ExternalAgentImportEvent): Promise<void> {
    if (closed || event.type !== 'completed') return;
    const successes = event.itemTypeResults.flatMap((result) => result.successes);
    const failures = event.itemTypeResults.flatMap((result) => result.failures);
    await applyImportResults(event.importId, successes, failures);
    await options.db.save();
    const runs = options.imports.getByImportId(event.importId);
    if (runs.length > 0) notifyUpdated(buildResult(event.importId));
  }

  async function applyImportResults(importId: string, successes: ExternalAgentImportSuccess[], failures: ExternalAgentImportFailure[]): Promise<void> {
    const runs = options.imports.getByImportId(importId).filter((run) => run.status === 'waiting');
    for (const run of runs) {
      const success = successes.find((entry) => entry.itemType === 'SESSIONS' && samePath(entry.source, run.snapshotPath));
      if (success) {
        if (!success.target.trim()) {
          options.imports.markFailed(run.id, { stage: 'provider_result', message: 'Provider did not return an imported thread id.' });
          continue;
        }
        try {
          const thread = await options.manager.readThread({ threadId: success.target });
          if (thread.id !== success.target) throw new Error('Provider returned a different thread identity.');
        } catch {
          options.imports.markFailed(run.id, { stage: 'thread_read', message: 'Provider thread could not be read after import.' });
          continue;
        }
        try {
          options.imports.bindThreadAndArchiveSource({ id: run.id, targetThreadId: success.target, providerBinaryVersion: options.providerBinaryVersion });
        } catch {
          options.imports.markFailed(run.id, { stage: 'database_bind', message: 'Imported thread could not be bound to the local conversation.' });
        }
        continue;
      }
      const failure = failures.find((entry) => entry.itemType === 'SESSIONS' && samePath(entry.source, run.snapshotPath));
      if (failure) options.imports.markFailed(run.id, { stage: failure.failureStage || 'provider_import', message: sanitizeProviderMessage(failure.message) });
    }
  }

  function buildResult(importId: string): CodexLegacyImportStartResult {
    const runs = options.imports.getByImportId(importId);
    if (runs.length === 0) throw importError('ZEUS_CODEX_LEGACY_IMPORT_NOT_FOUND', `Codex legacy import not found: ${importId}`);
    const status = runs.every((run) => run.status === 'completed') ? 'completed' : runs.some((run) => run.status === 'waiting' || run.status === 'prepared') ? 'waiting' : 'failed';
    return { importId, status, runs };
  }

  function assertOpen(): void {
    if (closed) throw importError('ZEUS_CODEX_LEGACY_IMPORT_CLOSED', 'Codex legacy import service is closed.');
  }

  function notifyUpdated(result: CodexLegacyImportStartResult): void {
    options.onUpdated?.({
      importId: result.importId,
      status: result.status,
      completedCount: result.runs.filter((run) => run.status === 'completed').length,
      failedCount: result.runs.filter((run) => run.status === 'failed').length,
      waitingCount: result.runs.filter((run) => run.status === 'waiting' || run.status === 'prepared').length,
    });
  }

  return {
    detect,
    start,
    get,
    recover,
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      await eventChain;
    },
  };
}

async function writeConversationSnapshot(sourceRoot: string, cwd: string, conversation: ZeusConversationWithMessagesRecord): Promise<{ snapshotPath: string; snapshotSha256: string }> {
  const projectDirectory = join(sourceRoot, 'projects', `project-${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`);
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  const fileName = `${safeFileName(conversation.id)}.jsonl`;
  const finalPath = join(projectDirectory, fileName);
  const temporaryPath = join(projectDirectory, `.${fileName}.${process.pid}.tmp`);
  const records: Record<string, unknown>[] = [{ type: 'custom-title', customTitle: conversation.title }];
  for (const message of conversation.messages) {
    if ((message.role !== 'user' && message.role !== 'assistant') || !message.content.trim()) continue;
    records.push({ type: message.role, cwd, timestamp: message.createdAt, message: { content: message.content } });
  }
  const bytes = Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, finalPath);
  const snapshotPath = await realpath(finalPath);
  return { snapshotPath, snapshotSha256: createHash('sha256').update(bytes).digest('hex') };
}

async function canonicalAllowedRoots(roots: string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    try {
      canonical.push(await realpath(root));
    } catch {
      // Missing project roots are not eligible.
    }
  }
  return [...new Set(canonical)];
}

async function canonicalEligibleProjectRoot(projectPath: string, allowedRoots: string[]): Promise<string | null> {
  if (!isAbsolute(projectPath)) return null;
  try {
    const canonical = await realpath(projectPath);
    return allowedRoots.some((root) => isInside(canonical, root)) ? canonical : null;
  } catch {
    return null;
  }
}

function isInside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function safeFileName(value: string): string {
  const sanitized = basename(value)
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return sanitized || createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/(?:token|password|secret)[-_a-z0-9]*\s*[:=]?\s*\S+/giu, '[redacted]')
    .slice(0, 500);
}

function importError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
