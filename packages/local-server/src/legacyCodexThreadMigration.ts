import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { CodexAppServerManager, CodexThreadSnapshot } from '@zeus/ai-runtime';
import type {
  ConversationItemPhase,
  ConversationItemRepository,
  ConversationItemStatus,
  ConversationItemType,
  ConversationRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  ConversationTurnStatus,
  ProjectRepository,
  RuntimeSessionRepository,
  TaskEventRepository,
  TaskRepository,
  ZeusConversationWithMessagesRecord,
  ZeusDatabase,
  ZeusRuntimeSessionRecord,
  ZeusTaskRecord,
} from '@zeus/storage';

const CODEX_THREAD_ID_PATTERN = /\bsession\s+id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/giu;

export interface LegacyCodexThreadMigrationInput {
  db: ZeusDatabase;
  projects: ProjectRepository;
  tasks: TaskRepository;
  taskEvents: TaskEventRepository;
  runtimeSessions: RuntimeSessionRepository;
  conversations: ConversationRepository;
  turns: ConversationTurnRepository;
  items: ConversationItemRepository;
  submissions: ConversationSubmissionRepository;
  manager: CodexAppServerManager;
  commandPath: string;
  externalAgentHome?: string;
}

export interface LegacyCodexThreadMigrationEntry {
  sourceConversationId: string;
  runtimeSessionId: string;
  conversationId: string;
  providerThreadId: string;
}

export interface LegacyCodexThreadMigrationSkip {
  sourceConversationId: string;
  runtimeSessionId: string | null;
  reason:
    | 'no_linked_runtime'
    | 'runtime_not_found'
    | 'runtime_ownership_conflict'
    | 'invalid_runtime_transport'
    | 'missing_provider_thread_id'
    | 'ambiguous_provider_thread_id'
    | 'missing_provider_model'
    | 'provider_resume_failed'
    | 'provider_thread_mismatch'
    | 'provider_thread_not_idle'
    | 'provider_thread_ownership_conflict'
    | 'provider_snapshot_import_failed';
}

export interface LegacyCodexThreadMigrationReport {
  imported: LegacyCodexThreadMigrationEntry[];
  existing: LegacyCodexThreadMigrationEntry[];
  skipped: LegacyCodexThreadMigrationSkip[];
  archivedSourceConversationIds: string[];
}

interface LegacyRuntimeLink {
  source: ZeusConversationWithMessagesRecord;
  runtimeSessionId: string;
}

interface VerifiedThreadCandidate extends LegacyRuntimeLink {
  runtime: ZeusRuntimeSessionRecord;
  providerThreadId: string;
  providerModel: string;
  providerBinaryVersion: string | null;
  snapshot: CodexThreadSnapshot;
}

export async function migrateLegacyCodexThreads(input: LegacyCodexThreadMigrationInput): Promise<LegacyCodexThreadMigrationReport> {
  const report: LegacyCodexThreadMigrationReport = { imported: [], existing: [], skipped: [], archivedSourceConversationIds: [] };
  const sources = listLegacySources(input.projects, input.conversations);
  let managerReady = false;

  for (const source of sources) {
    const links = linkedRuntimeSessions(source, input.taskEvents);
    if (links.length === 0) {
      report.skipped.push({ sourceConversationId: source.id, runtimeSessionId: null, reason: 'no_linked_runtime' });
      continue;
    }

    let sourceComplete = true;
    for (const link of links) {
      const runtime = input.runtimeSessions.getById(link.runtimeSessionId);
      if (!runtime) {
        sourceComplete = false;
        report.skipped.push({ sourceConversationId: source.id, runtimeSessionId: link.runtimeSessionId, reason: 'runtime_not_found' });
        continue;
      }
      if (runtime.projectId !== source.projectId || runtime.taskId !== source.taskId) {
        sourceComplete = false;
        report.skipped.push({ sourceConversationId: source.id, runtimeSessionId: runtime.id, reason: 'runtime_ownership_conflict' });
        continue;
      }
      if (!isCodexExecRuntime(runtime)) {
        sourceComplete = false;
        report.skipped.push({ sourceConversationId: source.id, runtimeSessionId: runtime.id, reason: 'invalid_runtime_transport' });
        continue;
      }
      const logText = input.runtimeSessions
        .listLogs(runtime.id)
        .map((log) => log.text)
        .join('\n');
      const threadIds = extractProviderThreadIds(logText);
      if (threadIds.length !== 1) {
        sourceComplete = false;
        report.skipped.push({
          sourceConversationId: source.id,
          runtimeSessionId: runtime.id,
          reason: threadIds.length === 0 ? 'missing_provider_thread_id' : 'ambiguous_provider_thread_id',
        });
        continue;
      }

      const providerThreadId = threadIds[0]!;
      const providerModel = firstMatch(logText, /^model:\s*(\S+)/imu);
      if (!providerModel) {
        sourceComplete = false;
        report.skipped.push({ sourceConversationId: source.id, runtimeSessionId: runtime.id, reason: 'missing_provider_model' });
        continue;
      }
      let candidate: VerifiedThreadCandidate;
      try {
        if (!managerReady) {
          await input.manager.ensureReady({ commandPath: input.commandPath, ...(input.externalAgentHome ? { externalAgentHome: input.externalAgentHome } : {}) });
          managerReady = true;
        }
        const resumed = await input.manager.resumeThread({ threadId: providerThreadId, cwd: runtime.cwd });
        const snapshot = await input.manager.readThread({ threadId: providerThreadId });
        if (resumed.id !== providerThreadId || snapshot.id !== providerThreadId) {
          sourceComplete = false;
          report.skipped.push({ sourceConversationId: source.id, runtimeSessionId: runtime.id, reason: 'provider_thread_mismatch' });
          continue;
        }
        if (!isIdleThread(snapshot)) {
          sourceComplete = false;
          report.skipped.push({ sourceConversationId: source.id, runtimeSessionId: runtime.id, reason: 'provider_thread_not_idle' });
          continue;
        }
        candidate = {
          ...link,
          runtime,
          providerThreadId,
          providerModel,
          providerBinaryVersion: firstMatch(logText, /^OpenAI Codex v(\S+)/imu),
          snapshot,
        };
      } catch {
        sourceComplete = false;
        report.skipped.push({ sourceConversationId: source.id, runtimeSessionId: runtime.id, reason: 'provider_resume_failed' });
        continue;
      }

      const existing = input.conversations.getByProviderThreadId(providerThreadId);
      if (existing && !isOwnedImport(existing, candidate)) {
        sourceComplete = false;
        report.skipped.push({ sourceConversationId: source.id, runtimeSessionId: runtime.id, reason: 'provider_thread_ownership_conflict' });
        continue;
      }

      try {
        input.db.execute('BEGIN');
        const conversation = existing ?? createImportedConversation(input, candidate);
        importProviderSnapshot(input, candidate, conversation);
        input.db.execute('COMMIT');
        const entry = { sourceConversationId: source.id, runtimeSessionId: runtime.id, conversationId: conversation.id, providerThreadId };
        if (existing) report.existing.push(entry);
        else report.imported.push(entry);
      } catch {
        try {
          input.db.execute('ROLLBACK');
        } catch {
          // 原始失败仍是迁移诊断依据；回滚失败不得继续归档来源。
        }
        sourceComplete = false;
        report.skipped.push({ sourceConversationId: source.id, runtimeSessionId: runtime.id, reason: 'provider_snapshot_import_failed' });
      }
    }

    if (sourceComplete) {
      input.conversations.archive(source.id);
      report.archivedSourceConversationIds.push(source.id);
    }
  }

  if (report.imported.length > 0 || report.existing.length > 0 || report.archivedSourceConversationIds.length > 0) await input.db.save();
  return report;
}

function listLegacySources(projects: ProjectRepository, conversations: ConversationRepository): ZeusConversationWithMessagesRecord[] {
  const sources: ZeusConversationWithMessagesRecord[] = [];
  for (const project of projects.list()) {
    let offset = 0;
    while (true) {
      const page = conversations.listByProject(project.id, { limit: 100, offset });
      sources.push(...page.items.filter((conversation) => conversation.transportKind === 'legacy_cli' && conversation.taskId));
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
  }
  return sources.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function linkedRuntimeSessions(source: ZeusConversationWithMessagesRecord, taskEvents: TaskEventRepository): LegacyRuntimeLink[] {
  if (!source.taskId) return [];
  const runtimeIds = new Set<string>();
  for (const event of taskEvents.listByTask(source.taskId)) {
    const payload = parseRecord(event.payloadJson);
    if (payload.conversationId !== source.id || typeof payload.runtimeSessionId !== 'string' || !payload.runtimeSessionId) continue;
    if (payload.adapterId !== undefined && payload.adapterId !== 'codex') continue;
    runtimeIds.add(payload.runtimeSessionId);
  }
  return [...runtimeIds].map((runtimeSessionId) => ({ source, runtimeSessionId }));
}

function extractProviderThreadIds(logText: string): string[] {
  const ids = new Set<string>();
  for (const match of logText.matchAll(CODEX_THREAD_ID_PATTERN)) ids.add(match[1]!.toLowerCase());
  return [...ids];
}

function isCodexExecRuntime(runtime: ZeusRuntimeSessionRecord): boolean {
  if (basename(runtime.command).toLowerCase() !== 'codex') return false;
  try {
    const args = JSON.parse(runtime.argsJson) as unknown;
    return Array.isArray(args) && args[0] === 'exec';
  } catch {
    return false;
  }
}

function isIdleThread(snapshot: CodexThreadSnapshot): boolean {
  const status = isRecord(snapshot.status) ? snapshot.status : null;
  return status?.type === 'idle';
}

function isOwnedImport(conversation: ZeusConversationWithMessagesRecord, candidate: VerifiedThreadCandidate): boolean {
  return (
    conversation.transportKind === 'codex_native' &&
    conversation.projectId === candidate.source.projectId &&
    conversation.taskId === candidate.source.taskId &&
    conversation.legacySourceConversationId === candidate.source.id &&
    conversation.providerThreadId === candidate.providerThreadId
  );
}

function createImportedConversation(input: LegacyCodexThreadMigrationInput, candidate: VerifiedThreadCandidate): ZeusConversationWithMessagesRecord {
  const conversation = input.conversations.create({
    id: stableId('conversation_imported_codex', candidate.providerThreadId),
    projectId: candidate.source.projectId,
    taskId: candidate.source.taskId ?? undefined,
    sessionId: candidate.runtime.id,
    title: candidate.source.title,
    summary: typeof candidate.snapshot.preview === 'string' && candidate.snapshot.preview.trim() ? candidate.snapshot.preview.trim().slice(0, 240) : (candidate.source.summary ?? undefined),
    status: 'open',
    transportKind: 'codex_native',
    providerId: 'codex',
    providerThreadId: candidate.providerThreadId,
    providerThreadPath: typeof candidate.snapshot.path === 'string' ? candidate.snapshot.path : undefined,
    providerModel: candidate.providerModel,
    providerState: 'ready',
    providerBinaryVersion: candidate.providerBinaryVersion ?? undefined,
    legacySourceConversationId: candidate.source.id,
  });
  const created = input.conversations.getById(conversation.id);
  if (!created) throw new Error(`Imported conversation was not persisted: ${conversation.id}`);
  return created;
}

function importProviderSnapshot(input: LegacyCodexThreadMigrationInput, candidate: VerifiedThreadCandidate, conversation: ZeusConversationWithMessagesRecord): void {
  const task = candidate.source.taskId ? input.tasks.getById(candidate.source.taskId) : undefined;
  if (!task) throw new Error(`Imported Codex thread task was not found: ${String(candidate.source.taskId)}`);
  const providerTurns = Array.isArray(candidate.snapshot.turns) ? candidate.snapshot.turns.filter(isRecord) : [];
  for (const [turnIndex, providerTurn] of providerTurns.entries()) {
    const providerTurnId = typeof providerTurn.id === 'string' && providerTurn.id ? providerTurn.id : stableId('provider_turn', `${candidate.providerThreadId}:${turnIndex}`);
    const providerItems = Array.isArray(providerTurn.items) ? providerTurn.items.filter(isRecord) : [];
    const userItem = providerItems.find((item) => item.type === 'userMessage');
    const userText = userItem ? itemText(userItem) : '';
    if (!userText.trim()) throw new Error(`Provider turn has no user message text: ${providerTurnId}`);
    const timestamp = epochToIso(providerTurn.startedAt) ?? epochToIso(candidate.snapshot.createdAt) ?? candidate.runtime.startedAt;
    const completedAt = epochToIso(providerTurn.completedAt) ?? (terminalTurnStatus(providerTurn) === 'completed' ? epochToIso(candidate.snapshot.updatedAt) : null);
    const context = submissionContext(candidate, task);
    const submissionPayload = { text: userText, context, importedFromProvider: true };
    const clientMessageId = userItem && typeof userItem.clientId === 'string' && userItem.clientId ? userItem.clientId : stableId('imported_client_message', providerTurnId);
    const submission = input.submissions.createOrGet({
      id: stableId('conversation_submission_imported', providerTurnId),
      conversationId: conversation.id,
      idempotencyKey: `legacy-codex-import:${providerTurnId}`,
      requestHash: createHash('sha256').update(JSON.stringify(submissionPayload)).digest('hex'),
      clientMessageId,
      kind: 'message',
      requestedDelivery: 'queue',
      status: submissionStatus(providerTurn),
      input: submissionPayload,
      providerTurnId,
      createdAt: timestamp,
      dispatchedAt: timestamp,
      resolvedAt: completedAt ?? timestamp,
    });
    const turn = input.turns.upsert({
      conversationId: conversation.id,
      providerThreadId: candidate.providerThreadId,
      providerTurnId,
      clientSubmissionId: submission.id,
      status: terminalTurnStatus(providerTurn),
      error: providerTurn.error ?? undefined,
      startedAt: timestamp,
      completedAt,
      createdAt: timestamp,
      updatedAt: completedAt ?? timestamp,
    });
    for (const [itemIndex, providerItem] of providerItems.entries()) {
      const providerItemId = typeof providerItem.id === 'string' && providerItem.id ? providerItem.id : stableId('provider_item', `${providerTurnId}:${itemIndex}`);
      const textContent = itemText(providerItem);
      const itemTimestamp = epochToIso(providerItem.startedAt) ?? addMilliseconds(timestamp, itemIndex);
      const itemCompletedAt = epochToIso(providerItem.completedAt) ?? (completedAt ? addMilliseconds(completedAt, itemIndex) : itemTimestamp);
      input.items.upsertCompleted({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: candidate.providerThreadId,
        providerTurnId,
        providerItemId,
        itemType: itemType(providerItem.type),
        status: itemStatus(providerItem),
        phase: itemPhase(providerItem),
        textContent,
        payload: providerItem,
        startedAt: itemTimestamp,
        completedAt: itemCompletedAt,
        updatedAt: itemCompletedAt,
      });
      if (providerItem.type === 'userMessage') {
        input.conversations.appendMessage({
          conversationId: conversation.id,
          role: 'user',
          content: textContent,
          source: 'codex_native_import',
          metadata: { importedFromLegacyRuntimeSessionId: candidate.runtime.id },
          createdAt: itemTimestamp,
          providerThreadId: candidate.providerThreadId,
          providerTurnId,
          providerItemId,
          clientMessageId,
        });
      }
    }
  }
}

function submissionContext(candidate: VerifiedThreadCandidate, task: ZeusTaskRecord) {
  return {
    projectId: candidate.source.projectId,
    projectLocalPath: candidate.runtime.cwd,
    taskId: task.id,
    model: candidate.providerModel,
    allowCodeChanges: task.allowCodeChanges,
    allowTests: task.allowTests,
    allowGitCommit: task.allowGitCommit,
  };
}

function terminalTurnStatus(turn: Record<string, unknown>): ConversationTurnStatus {
  const status = typeof turn.status === 'string' ? turn.status.toLowerCase() : '';
  if (status === 'completed') return 'completed';
  if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') return 'interrupted';
  if (status === 'failed' || status === 'error') return 'failed';
  return 'failed';
}

function submissionStatus(turn: Record<string, unknown>): 'completed' | 'failed' {
  return terminalTurnStatus(turn) === 'failed' ? 'failed' : 'completed';
}

function itemType(value: unknown): ConversationItemType {
  const allowed: ConversationItemType[] = ['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'plan', 'imageView', 'webSearch', 'error'];
  return typeof value === 'string' && allowed.includes(value as ConversationItemType) ? (value as ConversationItemType) : 'error';
}

function itemStatus(item: Record<string, unknown>): ConversationItemStatus {
  return item.status === 'failed' ? 'failed' : 'completed';
}

function itemPhase(item: Record<string, unknown>): ConversationItemPhase {
  return item.phase === 'final_answer' || item.phase === 'finalAnswer' || item.type === 'agentMessage' ? 'final_answer' : 'prework';
}

function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return '';
  return item.content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
}

function epochToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const millis = value < 10_000_000_000 ? value * 1_000 : value;
  return new Date(millis).toISOString();
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function firstMatch(value: string, pattern: RegExp): string | null {
  return value.match(pattern)?.[1]?.trim() || null;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
