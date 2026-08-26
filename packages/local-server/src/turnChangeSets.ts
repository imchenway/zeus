import {createHash, randomUUID} from 'node:crypto';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync
} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {
    historicalTurnChangeUnavailableReason,
    type TurnChangeConflict,
    type TurnChangeFile,
    type TurnChangeFileType,
    type TurnChangeSet,
    type TurnChangeSetOperationRequest,
    type TurnChangeSetOperationResult
} from '@zeus/shared';
import {
    type AuditLogRepository,
    type IdempotencyRequestRepository,
    type ProjectRepository,
    type TurnChangeFileRepository,
    type TurnChangeSetRepository,
    type ZeusConversationItemRecord,
    type ZeusConversationTurnRecord,
    type ZeusConversationWithMessagesRecord,
    type ZeusDatabase,
    type ZeusTurnChangeFileRecord,
    type ZeusTurnChangeSetRecord,
} from '@zeus/storage';

interface ProviderFileUpdateChange {
  path: string;
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path?: string | null };
  diff: string;
}

interface SnapshotState {
  exists: boolean;
  hash: string | null;
  blobRef: string | null;
  mode: number | null;
  unavailableReason: string | null;
}

interface AggregatedChangeFile extends ZeusTurnChangeFileRecord {
  sourceIds: string[];
}

export interface TurnChangeSetCaptureInput {
  conversation: ZeusConversationWithMessagesRecord;
  turn: ZeusConversationTurnRecord;
  providerItemId: string;
  changes: unknown;
  phase: 'pre' | 'post';
  timestamp: string;
}

export interface TurnChangeSetService {
  capture(input: TurnChangeSetCaptureInput): TurnChangeSet | null;
  updateUnifiedDiff(input: { conversation: ZeusConversationWithMessagesRecord; turn: ZeusConversationTurnRecord; diff: string; timestamp: string }): TurnChangeSet;
  seal(input: { conversation: ZeusConversationWithMessagesRecord; turn: ZeusConversationTurnRecord; timestamp: string }): TurnChangeSet | null;
  getById(changeSetId: string): TurnChangeSet | null;
  getByTurn(conversationId: string, turnId: string): TurnChangeSet | null;
  listByConversation(conversationId: string): TurnChangeSet[];
  operate(input: { projectId: string; conversationId: string; turnId: string; action: 'undo' | 'reapply'; request: TurnChangeSetOperationRequest }): Promise<TurnChangeSetOperationResult>;
  recoverInterruptedOperations(): Promise<void>;
}

export interface CreateTurnChangeSetServiceOptions {
  db: ZeusDatabase;
  changeSets: TurnChangeSetRepository;
  files: TurnChangeFileRepository;
  projects: ProjectRepository;
  auditLogs: AuditLogRepository;
  idempotency: IdempotencyRequestRepository;
  recoveryRoot: string;
  getConversationRoot?: (conversationId: string) => string | null;
  broadcast?: (type: string, payload: Record<string, unknown>) => void;
  now?: () => string;
  maxFileBytes?: number;
  maxChangeSetBytes?: number;
  /** 正式副本验证只开放历史读取，不创建 recovery 目录，也不接受任何变更集写操作。 */
  readOnlyValidation?: boolean;
}

const absentDigest = 'sha256:absent';

export function projectHistoricalTurnChangeSet(input: {
  existing: TurnChangeSet | null;
  projectId: string;
  conversationId: string;
  turn: ZeusConversationTurnRecord;
  items: readonly ZeusConversationItemRecord[];
  executionRoot: string | null;
}): TurnChangeSet | null {
  if (input.existing && input.existing.state !== 'capturing') return input.existing;
  if (!input.turn.providerTurnId || !['completed', 'interrupted', 'failed'].includes(input.turn.status) || !input.executionRoot) return input.existing;

  const root = resolve(input.executionRoot);
  const byPath = new Map<string, TurnChangeFile>();
  for (const item of input.items) {
    if (item.turnId !== input.turn.id || item.itemType !== 'fileChange') continue;
    const payload = parseJsonObject(item.payloadJson);
    normalizeProviderChanges(payload.changes).forEach((change) => {
      const paths = historicalChangePaths(change, root);
      if (!paths) return;
      const counts = countDiffLines(change.diff);
      const changeType = isBinaryDiff(change.diff) ? 'binary' : paths.changeType;
      const key = paths.newPath ?? paths.oldPath;
      if (!key) return;
      let existingKey = key;
      let existing = byPath.get(key);
      if (!existing && paths.oldPath) {
        const prior = [...byPath.entries()].find(([, file]) => file.newPath === paths.oldPath);
        existingKey = prior?.[0] ?? key;
        existing = prior?.[1];
      }
      if (existing) {
        if (existing.changeType === 'added' && changeType === 'deleted') {
          byPath.delete(existingKey);
          return;
        }
        if (existingKey !== key) byPath.delete(existingKey);
        byPath.set(key, {
          ...mergeHistoricalFileIdentity(existing, paths, changeType),
          addedLines: existing.addedLines + counts.added,
          deletedLines: existing.deletedLines + counts.deleted,
          unifiedDiff: [existing.unifiedDiff, change.diff].filter(Boolean).join('\n'),
        });
        return;
      }
      const digest = createHash('sha256').update(`${input.turn.id}\0${key}`).digest('hex').slice(0, 20);
      byPath.set(key, {
        id: `historical_turn_change_file_${digest}`,
        oldPath: paths.oldPath,
        newPath: paths.newPath,
        changeType,
        addedLines: counts.added,
        deletedLines: counts.deleted,
        unifiedDiff: change.diff,
        preHash: null,
        postHash: null,
        reversible: false,
        unavailableReason: historicalTurnChangeUnavailableReason,
      });
    });
  }

  const files = [...byPath.values()].sort((left, right) => (left.newPath ?? left.oldPath ?? '').localeCompare(right.newPath ?? right.oldPath ?? ''));
  if (files.length === 0) {
    if (!input.existing?.files.length) return input.existing;
    const unavailableFiles = input.existing.files.map((file) => ({ ...file, reversible: false, unavailableReason: historicalTurnChangeUnavailableReason }));
    return {
      ...input.existing,
      state: 'unavailable',
      files: unavailableFiles,
      fileCount: unavailableFiles.length,
      unavailableReason: historicalTurnChangeUnavailableReason,
    };
  }
  const timestamp = input.turn.completedAt ?? input.existing?.updatedAt ?? input.turn.updatedAt;
  const id = input.existing?.id ?? `historical_turn_change_set_${createHash('sha256').update(`${input.conversationId}\0${input.turn.id}`).digest('hex').slice(0, 20)}`;
  return {
    id,
    projectId: input.projectId,
    conversationId: input.conversationId,
    turnId: input.turn.id,
    providerTurnId: input.turn.providerTurnId,
    state: 'unavailable',
    files,
    unifiedDiff: files
      .map((file) => file.unifiedDiff)
      .filter(Boolean)
      .join('\n'),
    fileCount: files.length,
    addedLines: files.reduce((total, file) => total + file.addedLines, 0),
    deletedLines: files.reduce((total, file) => total + file.deletedLines, 0),
    preImageDigest: null,
    postImageDigest: null,
    unavailableReason: historicalTurnChangeUnavailableReason,
    conflict: null,
    createdAt: input.existing?.createdAt ?? input.turn.createdAt,
    updatedAt: timestamp,
  };
}

export function createTurnChangeSetService(options: CreateTurnChangeSetServiceOptions): TurnChangeSetService {
  const now = options.now ?? (() => new Date().toISOString());
  const maxFileBytes = options.maxFileBytes ?? 20 * 1024 * 1024;
  const maxChangeSetBytes = options.maxChangeSetBytes ?? 100 * 1024 * 1024;
  const busy = new Set<string>();
  if (!options.readOnlyValidation) mkdirSync(options.recoveryRoot, { recursive: true, mode: 0o700 });

  function assertMutationAllowed(): void {
    if (!options.readOnlyValidation) return;
    throw Object.assign(new Error('正式数据只读验证不允许变更文件或写入变更集。'), {
      code: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
      statusCode: 503,
      recoveryRequired: false,
    });
  }

  function ensureChangeSet(conversation: ZeusConversationWithMessagesRecord, turn: ZeusConversationTurnRecord, timestamp: string): ZeusTurnChangeSetRecord {
    const existing = options.changeSets.getByTurn(conversation.id, turn.id);
    if (existing) return existing;
    if (!turn.providerTurnId) throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_PROVIDER_ID_MISSING', 'The provider turn id is required before capturing file changes.');
    return options.changeSets.upsert({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      turnId: turn.id,
      providerTurnId: turn.providerTurnId,
      state: 'capturing',
      unifiedDiff: '',
      preImageDigest: null,
      postImageDigest: null,
      conflictJson: null,
      unavailableReason: null,
      journalRef: null,
      updatedAt: timestamp,
    });
  }

  function capture(input: TurnChangeSetCaptureInput): TurnChangeSet | null {
    assertMutationAllowed();
    const changes = normalizeProviderChanges(input.changes);
    if (changes.length === 0) return null;
    const project = options.projects.getById(input.conversation.projectId);
    if (!project) throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_PROJECT_MISSING', 'The project for this turn change set no longer exists.');
    const executionRoot = conversationExecutionRoot(input.conversation.id, project.localPath);
    const changeSet = ensureChangeSet(input.conversation, input.turn, input.timestamp);
    let capturedBytes = existingCaptureBytes(changeSet.id);
      const snapshotCandidates = new Set<string>();
      try {
          changes.forEach((change, sourceIndex) => {
              const paths = changePaths(change, executionRoot);
              const existing = options.files.listByChangeSet(changeSet.id).find((candidate) => candidate.sourceItemId === input.providerItemId && candidate.sourceIndex === sourceIndex);
              if (existing?.preBlobRef) snapshotCandidates.add(existing.preBlobRef);
              if (existing?.postBlobRef) snapshotCandidates.add(existing.postBlobRef);
              const snapshotPath = input.phase === 'pre' ? paths.oldAbsolutePath : paths.newAbsolutePath;
              const expectedAbsent = input.phase === 'pre' ? paths.oldPath === null : paths.newPath === null;
              const snapshot = expectedAbsent ? absentSnapshot() : snapshotPath ? captureSnapshot(changeSet.id, input.providerItemId, sourceIndex, input.phase, snapshotPath, capturedBytes) : unavailableSnapshot('Missing authorized file path.');
              if (snapshot.blobRef) {
                  snapshotCandidates.add(snapshot.blobRef);
                  capturedBytes += statSync(snapshot.blobRef).size;
              }
              const counts = countDiffLines(change.diff);
              const binary = isBinaryDiff(change.diff);
              const changeType = binary ? 'binary' : paths.changeType;
              let pre = input.phase === 'pre' ? snapshot : existing ? snapshotFromRecord(existing, 'pre') : unavailableSnapshot('The provider patch was observed after the pre-image capture point.');
              const post = input.phase === 'post' ? snapshot : existing ? snapshotFromRecord(existing, 'post') : unavailableSnapshot('Post-image has not been captured yet.');
              if (input.phase === 'post' && changeType !== 'binary') {
                  pre = reconcileTextPreImage({
                      changeSetId: changeSet.id,
                      providerItemId: input.providerItemId,
                      sourceIndex,
                      change,
                      changeType,
                      pre,
                      post,
                      capturedBytes,
                  });
                  if (pre.blobRef && pre.blobRef !== existing?.preBlobRef) {
                      snapshotCandidates.add(pre.blobRef);
                      capturedBytes += statSync(pre.blobRef).size;
                  }
              }
              if (pre.blobRef) snapshotCandidates.add(pre.blobRef);
              if (post.blobRef) snapshotCandidates.add(post.blobRef);
              const semanticUnavailableReason = input.phase === 'post' ? snapshotSemanticUnavailableReason(changeType, pre, post, change.diff) : null;
              const unavailableReason = input.phase === 'post' ? (pre.unavailableReason ?? post.unavailableReason ?? semanticUnavailableReason) : (pre.unavailableReason ?? post.unavailableReason);
              options.files.upsert({
                  changeSetId: changeSet.id,
                  sourceItemId: input.providerItemId,
                  sourceIndex,
                  oldPath: paths.oldPath,
                  newPath: paths.newPath,
                  changeType,
                  addedLines: counts.added,
                  deletedLines: counts.deleted,
                  preHash: pre.hash,
                  postHash: post.hash,
                  preExists: pre.exists,
                  postExists: post.exists,
                  preMode: pre.mode,
                  postMode: post.mode,
                  unifiedDiff: change.diff,
                  preBlobRef: pre.blobRef,
                  postBlobRef: post.blobRef,
                  reversible: input.phase === 'post' && !unavailableReason,
                  unavailableReason,
                  updatedAt: input.timestamp,
                  replacePreImage: input.phase === 'post',
              });
          });
      } finally {
          pruneSupersededSnapshotCandidates(changeSet.id, snapshotCandidates);
      }
    options.changeSets.upsert({
      ...changeSet,
      state: 'capturing',
      conflictJson: null,
      unavailableReason: null,
      updatedAt: input.timestamp,
    });
    const result = getById(changeSet.id);
    if (result) broadcastChangeSet(result);
    return result;
  }

  function captureSnapshot(changeSetId: string, providerItemId: string, sourceIndex: number, phase: 'pre' | 'post', absolutePath: string, capturedBytes: number): SnapshotState {
    try {
      const pathStat = lstatSync(absolutePath);
      if (pathStat.isSymbolicLink()) return unavailableSnapshot('Symbolic-link targets are not eligible for Undo/Reapply.');
      if (!pathStat.isFile()) return unavailableSnapshot('Only regular files are eligible for Undo/Reapply.');
      const bytes = readFileSync(absolutePath);
      return captureBytesSnapshot(changeSetId, providerItemId, sourceIndex, phase, bytes, pathStat.mode & 0o777, capturedBytes);
    } catch (error) {
      const code = isNodeError(error) ? error.code : null;
      if (code === 'ENOENT') return absentSnapshot();
      return unavailableSnapshot(error instanceof Error ? error.message : 'File snapshot capture failed.');
    }
  }

  function captureBytesSnapshot(changeSetId: string, providerItemId: string, sourceIndex: number, phase: 'pre' | 'post', bytes: Buffer, mode: number, capturedBytes: number): SnapshotState {
    if (bytes.length > maxFileBytes) return unavailableSnapshot('File exceeds the per-file recovery limit.');
    if (capturedBytes + bytes.length > maxChangeSetBytes) return unavailableSnapshot('Turn changes exceed the recovery capacity limit.');
    const directory = join(options.recoveryRoot, changeSetId, 'blobs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const digest = createHash('sha256').update(bytes).digest('hex');
    const name = `${safeSegment(providerItemId)}-${sourceIndex}-${phase}-${digest}.blob`;
    const blobRef = join(directory, name);
    if (!existsSync(blobRef)) writeFileSync(blobRef, bytes, { mode: 0o600, flag: 'wx' });
    return {
      exists: true,
      hash: `sha256:${digest}`,
      blobRef,
      mode,
      unavailableReason: null,
    };
  }

  function reconcileTextPreImage(input: {
    changeSetId: string;
    providerItemId: string;
    sourceIndex: number;
    change: ProviderFileUpdateChange;
    changeType: Exclude<TurnChangeFileType, 'binary'>;
    pre: SnapshotState;
    post: SnapshotState;
    capturedBytes: number;
  }): SnapshotState {
    if (input.changeType === 'added') return absentSnapshot();
    if (snapshotMatchesForwardDiff(input.pre, input.post, input.change.diff)) return input.pre;
    const postBytes = snapshotBytes(input.post);
    if (!postBytes) {
      return unavailableSnapshot('The provider file event arrived after the edit and its pre-image could not be reconstructed.');
    }
    const reconstructed = applyUnifiedDiffBytes(postBytes, input.change.diff, 'reverse');
    if (!reconstructed) {
      return unavailableSnapshot('The provider file event arrived after the edit and its text patch could not reconstruct the pre-image.');
    }
    const verifiedPost = applyUnifiedDiffBytes(reconstructed, input.change.diff, 'forward');
    if (!verifiedPost || !verifiedPost.equals(postBytes)) {
      return unavailableSnapshot('The reconstructed pre-image did not reproduce the provider post-image.');
    }
    const reconstructedMode = input.pre.mode ?? (input.changeType === 'deleted' ? providerPreImageMode(input.change.diff) : input.post.mode);
    if (reconstructedMode === null) {
      return unavailableSnapshot('The deleted file content was reconstructed, but its original permissions were not available for safe recovery.');
    }
    return captureBytesSnapshot(input.changeSetId, input.providerItemId, input.sourceIndex, 'pre', reconstructed, reconstructedMode, input.capturedBytes);
  }

  function updateUnifiedDiff(input: { conversation: ZeusConversationWithMessagesRecord; turn: ZeusConversationTurnRecord; diff: string; timestamp: string }): TurnChangeSet {
    assertMutationAllowed();
    const changeSet = ensureChangeSet(input.conversation, input.turn, input.timestamp);
    const updated = options.changeSets.upsert({
      ...changeSet,
      unifiedDiff: input.diff,
      updatedAt: input.timestamp,
    });
    const result = requirePublicChangeSet(updated.id);
    broadcastChangeSet(result);
    return result;
  }

  function seal(input: { conversation: ZeusConversationWithMessagesRecord; turn: ZeusConversationTurnRecord; timestamp: string }): TurnChangeSet | null {
    assertMutationAllowed();
    const changeSet = options.changeSets.getByTurn(input.conversation.id, input.turn.id);
    if (!changeSet) return null;
    const files = aggregateChangeFiles(options.files.listByChangeSet(changeSet.id));
    if (files.length === 0) return null;
    const incompleteFile = files.find((file) => !file.reversible);
    const unavailableReason = incompleteFile ? (incompleteFile.unavailableReason ?? 'Turn change recovery data is incomplete.') : null;
    const unifiedDiff =
      changeSet.unifiedDiff ||
      files
        .map((file) => file.unifiedDiff)
        .filter(Boolean)
        .join('\n');
    const state = unavailableReason ? 'unavailable' : 'applied';
    options.changeSets.upsert({
      ...changeSet,
      state,
      unifiedDiff,
      preImageDigest: digestFileStates(files, 'pre'),
      postImageDigest: digestFileStates(files, 'post'),
      conflictJson: null,
      unavailableReason,
      journalRef: null,
      updatedAt: input.timestamp,
    });
    const result = requirePublicChangeSet(changeSet.id);
    broadcastChangeSet(result);
    return result;
  }

  function getById(changeSetId: string): TurnChangeSet | null {
    const record = options.changeSets.getById(changeSetId);
    return record ? toPublicChangeSet(record, aggregateChangeFiles(options.files.listByChangeSet(record.id))) : null;
  }

  function getByTurn(conversationId: string, turnId: string): TurnChangeSet | null {
    const record = options.changeSets.getByTurn(conversationId, turnId);
    return record ? toPublicChangeSet(record, aggregateChangeFiles(options.files.listByChangeSet(record.id))) : null;
  }

  function listByConversation(conversationId: string): TurnChangeSet[] {
    return options.changeSets.listByConversation(conversationId).map((record) => toPublicChangeSet(record, aggregateChangeFiles(options.files.listByChangeSet(record.id))));
  }

  async function operate(input: { projectId: string; conversationId: string; turnId: string; action: 'undo' | 'reapply'; request: TurnChangeSetOperationRequest }): Promise<TurnChangeSetOperationResult> {
    assertMutationAllowed();
    const changeSet = options.changeSets.getById(input.request.changeSetId);
    if (!changeSet || changeSet.projectId !== input.projectId || changeSet.conversationId !== input.conversationId || changeSet.turnId !== input.turnId) {
      throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_NOT_FOUND', 'Turn change set not found.');
    }
    const expectedState = input.action === 'undo' ? 'applied' : 'undone';
    if (input.request.expectedState !== expectedState) {
      throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_EXPECTED_STATE_INVALID', `Expected state must be ${expectedState} for ${input.action}.`);
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ changeSetId: changeSet.id, expectedState, action: input.action }))
      .digest('hex');
    const scope = `turn-change-set:${changeSet.id}:${input.action}`;
    const idempotency = options.idempotency.createOrGet({
      scope,
      idempotencyKey: input.request.idempotencyKey,
      requestHash,
      status: 'in_progress',
      resourceId: changeSet.id,
      createdAt: now(),
    });
    if (idempotency.status === 'completed' && idempotency.responseJson) {
      const prior = parseOperationResult(idempotency.responseJson);
      if (prior) return prior;
    }
    if (busy.has(changeSet.id)) {
      throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_BUSY', 'Another Undo/Reapply operation is already running.');
    }
    busy.add(changeSet.id);
    try {
      const result = executeOperation(changeSet, input.action);
      options.idempotency.complete({
        scope,
        idempotencyKey: input.request.idempotencyKey,
        status: 'completed',
        httpStatus: 200,
        response: result,
        resourceId: changeSet.id,
        updatedAt: now(),
      });
      await options.db.save();
      return result;
    } catch (error) {
      options.idempotency.complete({
        scope,
        idempotencyKey: input.request.idempotencyKey,
        status: 'failed',
        httpStatus: changeSetErrorStatus(error),
        response: { error: errorCode(error), message: error instanceof Error ? error.message : String(error) },
        resourceId: changeSet.id,
        updatedAt: now(),
      });
      await options.db.save();
      throw error;
    } finally {
      busy.delete(changeSet.id);
    }
  }

  function executeOperation(changeSet: ZeusTurnChangeSetRecord, action: 'undo' | 'reapply'): TurnChangeSetOperationResult {
    const project = options.projects.getById(changeSet.projectId);
    if (!project) throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_PROJECT_MISSING', 'The project for this turn change set no longer exists.');
    const executionRoot = conversationExecutionRoot(changeSet.conversationId, project.localPath);
    const files = aggregateChangeFiles(options.files.listByChangeSet(changeSet.id));
    if (files.length === 0 || files.some((file) => !file.reversible)) {
      throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_UNAVAILABLE', changeSet.unavailableReason ?? 'This turn does not have complete recovery data.');
    }
    const fromState = action === 'undo' ? 'applied' : 'undone';
    const toState = action === 'undo' ? 'undone' : 'applied';
    if (changeSet.state !== fromState && changeSet.state !== 'conflicted') {
      throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_STATE_CONFLICT', `Turn change set is ${changeSet.state}; expected ${fromState}.`);
    }
    const conflicts = validateOperationPreconditions(executionRoot, files, action);
    if (conflicts.length > 0) {
      const conflict: TurnChangeConflict = {
        code: 'ZEUS_TURN_CHANGE_SET_CONTENT_CONFLICT',
        message: action === 'undo' ? 'Files were modified after this turn and cannot be undone safely.' : 'Files no longer match the undone state and cannot be reapplied safely.',
        paths: conflicts,
      };
      options.changeSets.upsert({
        ...changeSet,
        state: 'conflicted',
        conflictJson: JSON.stringify(conflict),
        updatedAt: now(),
      });
      const publicChangeSet = requirePublicChangeSet(changeSet.id);
      broadcastChangeSet(publicChangeSet);
      throw Object.assign(turnChangeSetError(conflict.code, conflict.message), { paths: conflicts });
    }
    const operationId = randomUUID();
    const journalDirectory = join(options.recoveryRoot, changeSet.id, 'journals', operationId);
    mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
    const journalPath = join(journalDirectory, 'journal.json');
    const journal = {
      version: 1,
      changeSetId: changeSet.id,
      operationId,
      action,
      fromState,
      toState,
      status: 'in_progress',
      createdAt: now(),
    };
    writeJsonAtomic(journalPath, journal);
    options.changeSets.upsert({
      ...changeSet,
      state: action === 'undo' ? 'undoing' : 'reapplying',
      conflictJson: null,
      journalRef: journalPath,
      updatedAt: now(),
    });
    let applied = false;
    try {
      applyFileSnapshots(executionRoot, files, action === 'undo' ? 'pre' : 'post');
      applied = true;
      writeJsonAtomic(journalPath, { ...journal, status: 'completed', completedAt: now() });
    } catch (error) {
      try {
        applyFileSnapshots(executionRoot, files, action === 'undo' ? 'post' : 'pre');
        writeJsonAtomic(journalPath, { ...journal, status: 'rolled_back', rolledBackAt: now() });
        options.changeSets.upsert({
          ...changeSet,
          state: fromState,
          conflictJson: null,
          journalRef: journalPath,
          updatedAt: now(),
        });
        broadcastChangeSet(requirePublicChangeSet(changeSet.id));
      } catch (rollbackError) {
        writeJsonAtomic(journalPath, {
          ...journal,
          status: 'recovery_required',
          failedAt: now(),
          error: error instanceof Error ? error.message : String(error),
          rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
        throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_RECOVERY_REQUIRED', 'Undo/Reapply failed and automatic rollback could not restore every file.');
      }
      throw error;
    }
    if (!applied) throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_OPERATION_FAILED', 'Undo/Reapply did not complete.');
    options.changeSets.upsert({
      ...changeSet,
      state: toState,
      conflictJson: null,
      unavailableReason: null,
      journalRef: journalPath,
      updatedAt: now(),
    });
    const audit = options.auditLogs.append({
      actorType: 'user',
      action: action === 'undo' ? 'conversation.turn.change_set.undo' : 'conversation.turn.change_set.reapply',
      resourceType: 'turn_change_set',
      resourceId: changeSet.id,
      payload: {
        projectId: changeSet.projectId,
        conversationId: changeSet.conversationId,
        turnId: changeSet.turnId,
        fileCount: files.length,
        operationId,
      },
      createdAt: now(),
    });
    const publicChangeSet = requirePublicChangeSet(changeSet.id);
    broadcastChangeSet(publicChangeSet);
    return { changeSet: publicChangeSet, auditEventId: audit.id };
  }

  async function recoverInterruptedOperations(): Promise<void> {
    assertMutationAllowed();
    for (const changeSet of options.changeSets.listInProgress()) {
      const project = options.projects.getById(changeSet.projectId);
      const files = aggregateChangeFiles(options.files.listByChangeSet(changeSet.id));
      const executionRoot = project ? (options.getConversationRoot?.(changeSet.conversationId) ?? (options.getConversationRoot ? null : project.localPath)) : null;
      if (!project || !executionRoot || files.length === 0) {
        options.changeSets.upsert({
          ...changeSet,
          state: 'unavailable',
          unavailableReason: !executionRoot ? 'The conversation execution root is unavailable.' : 'Interrupted operation recovery data is incomplete.',
          updatedAt: now(),
        });
        continue;
      }
      const restore = changeSet.state === 'undoing' ? 'post' : 'pre';
      const restoredState = changeSet.state === 'undoing' ? 'applied' : 'undone';
      try {
        applyFileSnapshots(resolve(executionRoot), files, restore);
        options.changeSets.upsert({ ...changeSet, state: restoredState, updatedAt: now() });
      } catch (error) {
        const conflict: TurnChangeConflict = {
          code: 'ZEUS_TURN_CHANGE_SET_RECOVERY_REQUIRED',
          message: error instanceof Error ? error.message : 'Interrupted Undo/Reapply could not be recovered.',
          paths: files.flatMap((file) => [file.oldPath, file.newPath]).filter((path): path is string => Boolean(path)),
        };
        options.changeSets.upsert({
          ...changeSet,
          state: 'conflicted',
          conflictJson: JSON.stringify(conflict),
          updatedAt: now(),
        });
      }
    }
    await options.db.save();
  }

  function broadcastChangeSet(changeSet: TurnChangeSet): void {
    const realtimeChangeSet = toRealtimeChangeSet(changeSet);
    options.broadcast?.('conversation.turn.change_set.changed', {
      projectId: changeSet.projectId,
      conversationId: changeSet.conversationId,
      turnId: changeSet.providerTurnId,
      changeSetId: changeSet.id,
      entityRevision: changeSet.updatedAt,
      changeSet: realtimeChangeSet,
    });
  }

  function requirePublicChangeSet(changeSetId: string): TurnChangeSet {
    const value = getById(changeSetId);
    if (!value) throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_NOT_FOUND', 'Turn change set not found.');
    return value;
  }

  function conversationExecutionRoot(conversationId: string, projectRoot: string): string {
    const configuredRoot = options.getConversationRoot?.(conversationId) ?? (options.getConversationRoot ? null : projectRoot);
    if (!configuredRoot) {
      throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_ROOT_UNAVAILABLE', 'The conversation execution root is unavailable.');
    }
    return resolve(configuredRoot);
  }

  return {
    capture,
    updateUnifiedDiff,
    seal,
    getById,
    getByTurn,
    listByConversation,
    operate,
    recoverInterruptedOperations,
  };

  function existingCaptureBytes(changeSetId: string): number {
    return options.files.listByChangeSet(changeSetId).reduce((total, file) => {
      const refs = new Set([file.preBlobRef, file.postBlobRef].filter((entry): entry is string => Boolean(entry)));
      for (const ref of refs) {
        try {
          total += statSync(ref).size;
        } catch {
          // Missing historical blobs are surfaced when the change set is sealed.
        }
      }
      return total;
    }, 0);
  }

    /**
     * Provider 会重复更新同一个 fileChange item。数据库只保留当前 pre/post 引用，
     * 捕获阶段产生但最终未被选中的快照若继续留在目录中，会随长会话永久累积。
     * 这里只删除当前变更集目录内、且已不被任何 file row 引用的普通文件。
     */
    function pruneSupersededSnapshotCandidates(changeSetId: string, candidates: ReadonlySet<string>): void {
        if (candidates.size === 0) return;
        let retained: Set<string>;
        try {
            retained = new Set(
                options.files
                    .listByChangeSet(changeSetId)
                    .flatMap((file) => [file.preBlobRef, file.postBlobRef])
                    .filter((entry): entry is string => Boolean(entry))
                    .map((entry) => resolve(entry)),
            );
        } catch {
            return;
        }
        const blobRoot = resolve(options.recoveryRoot, changeSetId, 'blobs');
        for (const candidate of candidates) {
            const path = resolve(candidate);
            if (retained.has(path) || dirname(path) !== blobRoot || !isInsideRoot(path, blobRoot)) continue;
            try {
                const stat = lstatSync(path);
                if (stat.isSymbolicLink() || !stat.isFile()) continue;
                unlinkSync(path);
            } catch (error) {
                if (isNodeError(error) && error.code === 'ENOENT') continue;
                // 快照回收失败不能把已经持久化成功的 Provider 轮次反向标记为失败。
            }
        }
    }
}

function normalizeProviderChanges(value: unknown): ProviderFileUpdateChange[] {
  if (!Array.isArray(value)) return [];
  const changes: ProviderFileUpdateChange[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.path !== 'string' || !candidate.path.trim() || typeof candidate.diff !== 'string' || !isRecord(candidate.kind)) continue;
    const type = candidate.kind.type;
    if (type === 'add' || type === 'delete') {
      changes.push({ path: candidate.path, diff: candidate.diff, kind: { type } });
      continue;
    }
    if (type === 'update' && (candidate.kind.move_path === undefined || candidate.kind.move_path === null || typeof candidate.kind.move_path === 'string')) {
      changes.push({ path: candidate.path, diff: candidate.diff, kind: { type, move_path: candidate.kind.move_path ?? null } });
    }
  }
  return changes;
}

function historicalChangePaths(
  change: ProviderFileUpdateChange,
  executionRoot: string,
): {
  oldPath: string | null;
  newPath: string | null;
  changeType: Exclude<TurnChangeFileType, 'binary'>;
} | null {
  const sourcePath = historicalRelativePath(change.path, executionRoot);
  if (!sourcePath) return null;
  if (change.kind.type === 'add') return { oldPath: null, newPath: sourcePath, changeType: 'added' };
  if (change.kind.type === 'delete') return { oldPath: sourcePath, newPath: null, changeType: 'deleted' };
  const movePath = change.kind.move_path ? historicalRelativePath(change.kind.move_path, executionRoot) : null;
  if (change.kind.move_path && !movePath) return null;
  return {
    oldPath: sourcePath,
    newPath: movePath ?? sourcePath,
    changeType: movePath ? 'renamed' : 'modified',
  };
}

function mergeHistoricalFileIdentity(
  existing: TurnChangeFile,
  next: { oldPath: string | null; newPath: string | null; changeType: Exclude<TurnChangeFileType, 'binary'> },
  nextType: TurnChangeFileType,
): Pick<TurnChangeFile, 'id' | 'oldPath' | 'newPath' | 'changeType' | 'preHash' | 'postHash' | 'reversible' | 'unavailableReason'> {
  const oldPath = existing.oldPath;
  const newPath = next.newPath;
  const changeType: TurnChangeFileType =
    existing.changeType === 'added' && nextType !== 'deleted'
      ? 'added'
      : nextType === 'deleted'
        ? oldPath === null
          ? 'modified'
          : 'deleted'
        : existing.changeType === 'deleted'
          ? 'modified'
          : existing.changeType === 'renamed'
            ? 'renamed'
            : nextType;
  return {
    id: existing.id,
    oldPath,
    newPath,
    changeType,
    preHash: null,
    postHash: null,
    reversible: false,
    unavailableReason: historicalTurnChangeUnavailableReason,
  };
}

function historicalRelativePath(path: string, executionRoot: string): string | null {
  if (!path || path.includes('\0')) return null;
  const root = resolve(executionRoot);
  const absolutePath = resolve(isAbsolute(path) ? path : resolve(root, path));
  if (!isInsideRoot(absolutePath, root) || absolutePath === root) return null;
  const relativePath = relative(root, absolutePath).split(sep).join('/');
  return relativePath && !relativePath.startsWith('../') ? relativePath : null;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function changePaths(
  change: ProviderFileUpdateChange,
  executionRoot: string,
): {
  oldPath: string | null;
  newPath: string | null;
  oldAbsolutePath: string | null;
  newAbsolutePath: string | null;
  changeType: Exclude<TurnChangeFileType, 'binary'>;
} {
  const sourcePath = normalizeProjectRelativePath(change.path, executionRoot);
  if (change.kind.type === 'add') {
    return { oldPath: null, newPath: sourcePath.relativePath, oldAbsolutePath: null, newAbsolutePath: sourcePath.absolutePath, changeType: 'added' };
  }
  if (change.kind.type === 'delete') {
    return { oldPath: sourcePath.relativePath, newPath: null, oldAbsolutePath: sourcePath.absolutePath, newAbsolutePath: null, changeType: 'deleted' };
  }
  const movePath = change.kind.move_path ? normalizeProjectRelativePath(change.kind.move_path, executionRoot) : null;
  return {
    oldPath: sourcePath.relativePath,
    newPath: movePath?.relativePath ?? sourcePath.relativePath,
    oldAbsolutePath: sourcePath.absolutePath,
    newAbsolutePath: movePath?.absolutePath ?? sourcePath.absolutePath,
    changeType: movePath ? 'renamed' : 'modified',
  };
}

function normalizeProjectRelativePath(path: string, executionRoot: string): { absolutePath: string; relativePath: string } {
  if (!path || path.includes('\0')) throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_PATH_INVALID', 'Provider file change path is invalid.');
  const root = resolve(executionRoot);
  const absolutePath = resolve(isAbsolute(path) ? path : resolve(root, path));
  if (!isInsideRoot(absolutePath, root) || absolutePath === root) {
    throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_PATH_FORBIDDEN', 'Provider file change path is outside the conversation execution root.');
  }
  validateExistingAncestor(absolutePath, root);
  return { absolutePath, relativePath: relative(root, absolutePath).split(sep).join('/') };
}

function validateExistingAncestor(path: string, root: string): void {
  const rootRealPath = realpathSync(root);
  let ancestor = path;
  while (true) {
    try {
      const ancestorRealPath = realpathSync(ancestor);
      if (!isInsideRoot(ancestorRealPath, rootRealPath)) {
        throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_PATH_FORBIDDEN', 'Provider file change path resolves outside the conversation execution root.');
      }
      return;
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as Error & { code?: unknown }).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_PATH_FORBIDDEN', 'No trusted ancestor exists for the provider file change path.');
      ancestor = parent;
    }
  }
}

function aggregateChangeFiles(files: ZeusTurnChangeFileRecord[]): AggregatedChangeFile[] {
  const byPath = new Map<string, AggregatedChangeFile>();
  for (const file of files) {
    const key = `${file.oldPath ?? ''}\0${file.newPath ?? ''}`;
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, { ...file, sourceIds: file.sourceItemId ? [file.sourceItemId] : [] });
      continue;
    }
    byPath.set(key, {
      ...existing,
      id: existing.id,
      sourceIndex: Math.min(existing.sourceIndex, file.sourceIndex),
      addedLines: existing.addedLines + file.addedLines,
      deletedLines: existing.deletedLines + file.deletedLines,
      postHash: file.postHash,
      postExists: file.postExists,
      postMode: file.postMode,
      postBlobRef: file.postBlobRef,
      unifiedDiff: [existing.unifiedDiff, file.unifiedDiff].filter(Boolean).join('\n'),
      reversible: existing.reversible && file.reversible,
      unavailableReason: existing.unavailableReason ?? file.unavailableReason,
      updatedAt: file.updatedAt > existing.updatedAt ? file.updatedAt : existing.updatedAt,
      sourceIds: [...existing.sourceIds, ...(file.sourceItemId ? [file.sourceItemId] : [])],
    });
  }
  return [...byPath.values()].filter((file) => !isNetZeroSamePathChange(file)).sort((left, right) => (left.newPath ?? left.oldPath ?? '').localeCompare(right.newPath ?? right.oldPath ?? ''));
}

function isNetZeroSamePathChange(file: AggregatedChangeFile): boolean {
  if (!file.oldPath || file.oldPath !== file.newPath || file.preExists !== file.postExists) return false;
  if (!file.reversible || file.unavailableReason) return false;
  if (!file.preExists) return true;
  return file.preHash !== null && file.postHash !== null && file.preMode !== null && file.postMode !== null && file.preHash === file.postHash && file.preMode === file.postMode;
}

function toPublicChangeSet(record: ZeusTurnChangeSetRecord, files: AggregatedChangeFile[]): TurnChangeSet {
  const publicFiles: TurnChangeFile[] = files.map((file) => ({
    id: file.id,
    oldPath: file.oldPath,
    newPath: file.newPath,
    changeType: file.changeType,
    addedLines: file.addedLines,
    deletedLines: file.deletedLines,
    unifiedDiff: file.unifiedDiff,
    preHash: file.preHash,
    postHash: file.postHash,
    reversible: file.reversible,
    unavailableReason: file.unavailableReason,
  }));
  return {
    id: record.id,
    projectId: record.projectId,
    conversationId: record.conversationId,
    turnId: record.turnId,
    providerTurnId: record.providerTurnId,
    state: record.state,
    files: publicFiles,
    unifiedDiff: record.unifiedDiff,
    fileCount: publicFiles.length,
    addedLines: publicFiles.reduce((sum, file) => sum + file.addedLines, 0),
    deletedLines: publicFiles.reduce((sum, file) => sum + file.deletedLines, 0),
    preImageDigest: record.preImageDigest,
    postImageDigest: record.postImageDigest,
    unavailableReason: record.unavailableReason,
    conflict: parseConflict(record.conflictJson),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    contentProjection: 'full',
  };
}

/**
 * 实时事件只负责告诉 Renderer“哪一个变更集的哪个修订发生了变化”。
 * diff 正文已经由 turn_change_sets / turn_change_files 权威保存，继续在每个累计更新里复制
 * 会把一次逐步增长的变更写成近二次存储量。终态 UI 通过既有 change-set API 按需补齐全文。
 */
export function toRealtimeChangeSet(changeSet: TurnChangeSet): TurnChangeSet {
  return {
    ...changeSet,
    files: changeSet.files.map((file) => ({ ...file, unifiedDiff: '' })),
    unifiedDiff: '',
    contentProjection: 'summary',
  };
}

function countDiffLines(diff: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of diff.replace(/\r\n?/gu, '\n').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) deleted += 1;
  }
  return { added, deleted };
}

function isBinaryDiff(diff: string): boolean {
  return /^(?:Binary files |GIT binary patch)/mu.test(diff);
}

function providerPreImageMode(diff: string): number | null {
  const match = /^(?:old mode|deleted file mode) ([0-7]{6})$/mu.exec(diff);
  if (!match) return null;
  const mode = Number.parseInt(match[1], 8) & 0o777;
  return Number.isSafeInteger(mode) ? mode : null;
}

function absentSnapshot(): SnapshotState {
  return { exists: false, hash: null, blobRef: null, mode: null, unavailableReason: null };
}

function unavailableSnapshot(reason: string): SnapshotState {
  return { exists: false, hash: null, blobRef: null, mode: null, unavailableReason: reason };
}

function snapshotFromRecord(file: ZeusTurnChangeFileRecord, phase: 'pre' | 'post'): SnapshotState {
  return phase === 'pre'
    ? {
        exists: file.preExists,
        hash: file.preHash,
        blobRef: file.preBlobRef,
        mode: file.preMode,
        unavailableReason: file.preExists && (!file.preHash || !file.preBlobRef) ? (file.unavailableReason ?? 'Pre-image recovery data is incomplete.') : null,
      }
    : {
        exists: file.postExists,
        hash: file.postHash,
        blobRef: file.postBlobRef,
        mode: file.postMode,
        unavailableReason: file.postExists && (!file.postHash || !file.postBlobRef) ? (file.unavailableReason ?? 'Post-image recovery data is incomplete.') : null,
      };
}

function snapshotSemanticUnavailableReason(changeType: TurnChangeFileType, pre: SnapshotState, post: SnapshotState, diff: string): string | null {
  if (changeType === 'added') {
    if (pre.exists || !post.exists) return 'Added-file recovery snapshots do not match the provider change.';
  } else if (changeType === 'deleted') {
    if (!pre.exists || post.exists) return 'Deleted-file recovery snapshots do not match the provider change.';
  } else if (!pre.exists || !post.exists) {
    return 'Modified-file recovery requires both pre-image and post-image snapshots.';
  }
  if (changeType === 'binary') {
    return pre.exists && post.exists && pre.hash === post.hash ? 'The binary pre-image and post-image are identical, so the provider event arrived too late for safe recovery.' : null;
  }
  const counts = countDiffLines(diff);
  if (counts.added + counts.deleted > 0 && pre.exists && post.exists && pre.hash === post.hash) {
    return 'The pre-image and post-image are identical even though the provider patch changes content.';
  }
  if (diff.trim() && !snapshotMatchesForwardDiff(pre, post, diff)) {
    return 'The captured recovery snapshots do not reproduce the provider patch.';
  }
  return null;
}

function snapshotMatchesForwardDiff(pre: SnapshotState, post: SnapshotState, diff: string): boolean {
  const preBytes = snapshotBytes(pre);
  const postBytes = snapshotBytes(post);
  if (!preBytes || !postBytes) return false;
  if (!diff.trim()) return preBytes.equals(postBytes);
  const patched = applyUnifiedDiffBytes(preBytes, diff, 'forward');
  return Boolean(patched?.equals(postBytes));
}

function snapshotBytes(snapshot: SnapshotState): Buffer | null {
  if (snapshot.unavailableReason) return null;
  if (!snapshot.exists) return Buffer.alloc(0);
  if (!snapshot.blobRef || !existsSync(snapshot.blobRef)) return null;
  return readFileSync(snapshot.blobRef);
}

interface UnifiedDiffLine {
  kind: 'context' | 'remove' | 'add';
  text: string;
  noNewline: boolean;
}

interface UnifiedDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: UnifiedDiffLine[];
}

function applyUnifiedDiffBytes(baseBytes: Buffer, diff: string, direction: 'forward' | 'reverse'): Buffer | null {
  if (baseBytes.includes(0)) return null;
  const decoded = baseBytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(baseBytes)) return null;
  const normalized = normalizePatchText(decoded);
  if (!normalized) return null;
  const patched = applyUnifiedDiffText(normalized.text, diff, direction);
  if (patched === null) return null;
  return Buffer.from(normalized.eol === '\r\n' ? patched.replace(/\n/gu, '\r\n') : patched, 'utf8');
}

function normalizePatchText(value: string): { text: string; eol: '\n' | '\r\n' } | null {
  const hasCrLf = value.includes('\r\n');
  const withoutCrLf = value.replace(/\r\n/gu, '');
  if (withoutCrLf.includes('\r')) return null;
  if (hasCrLf && withoutCrLf.includes('\n')) return null;
  return {
    text: hasCrLf ? value.replace(/\r\n/gu, '\n') : value,
    eol: hasCrLf ? '\r\n' : '\n',
  };
}

function applyUnifiedDiffText(baseText: string, diff: string, direction: 'forward' | 'reverse'): string | null {
  const hunks = parseUnifiedDiffHunks(diff);
  if (!hunks || hunks.length === 0) return null;
  const source = splitPatchLines(baseText);
  const output: string[] = [];
  let sourceCursor = 0;
  let trailingNewline = source.trailingNewline;

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const sourceStart = direction === 'forward' ? hunk.oldStart : hunk.newStart;
    const sourceCount = direction === 'forward' ? hunk.oldCount : hunk.newCount;
    const outputCount = direction === 'forward' ? hunk.newCount : hunk.oldCount;
    const targetIndex = sourceStart === 0 ? 0 : sourceStart - 1;
    if (targetIndex < sourceCursor || targetIndex > source.lines.length) return null;
    output.push(...source.lines.slice(sourceCursor, targetIndex));
    sourceCursor = targetIndex;
    let consumed = 0;
    let emitted = 0;
    let lastEmittedPatchLine: UnifiedDiffLine | null = null;

    for (const line of hunk.lines) {
      const consumes = line.kind === 'context' || (direction === 'forward' ? line.kind === 'remove' : line.kind === 'add');
      const emits = line.kind === 'context' || (direction === 'forward' ? line.kind === 'add' : line.kind === 'remove');
      if (consumes) {
        if (sourceCursor >= source.lines.length || source.lines[sourceCursor] !== line.text) return null;
        sourceCursor += 1;
        consumed += 1;
      }
      if (emits) {
        output.push(line.text);
        emitted += 1;
        lastEmittedPatchLine = line;
      }
    }
    if (consumed !== sourceCount || emitted !== outputCount) return null;

    const isLastHunk = hunkIndex === hunks.length - 1;
    if (isLastHunk && sourceCursor === source.lines.length) {
      trailingNewline = output.length === 0 ? false : lastEmittedPatchLine ? !lastEmittedPatchLine.noNewline : source.trailingNewline;
    }
  }

  output.push(...source.lines.slice(sourceCursor));
  if (sourceCursor < source.lines.length) trailingNewline = source.trailingNewline;
  return joinPatchLines(output, trailingNewline);
}

function parseUnifiedDiffHunks(diff: string): UnifiedDiffHunk[] | null {
  const lines = diff.replace(/\r\n?/gu, '\n').split('\n');
  const hunks: UnifiedDiffHunk[] = [];
  let current: UnifiedDiffHunk | null = null;
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header) {
      current = {
        oldStart: Number.parseInt(header[1], 10),
        oldCount: header[2] === undefined ? 1 : Number.parseInt(header[2], 10),
        newStart: Number.parseInt(header[3], 10),
        newCount: header[4] === undefined ? 1 : Number.parseInt(header[4], 10),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line === '\\ No newline at end of file') {
      const previous = current.lines.at(-1);
      if (!previous) return null;
      previous.noNewline = true;
      continue;
    }
    const prefix = line[0];
    if (prefix === ' ' || prefix === '-' || prefix === '+') {
      current.lines.push({
        kind: prefix === ' ' ? 'context' : prefix === '-' ? 'remove' : 'add',
        text: line.slice(1),
        noNewline: false,
      });
    }
  }
  for (const hunk of hunks) {
    const oldCount = hunk.lines.filter((line) => line.kind === 'context' || line.kind === 'remove').length;
    const newCount = hunk.lines.filter((line) => line.kind === 'context' || line.kind === 'add').length;
    if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) return null;
  }
  return hunks;
}

function splitPatchLines(value: string): { lines: string[]; trailingNewline: boolean } {
  if (value === '') return { lines: [], trailingNewline: false };
  const trailingNewline = value.endsWith('\n');
  const body = trailingNewline ? value.slice(0, -1) : value;
  return { lines: body.split('\n'), trailingNewline };
}

function joinPatchLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
}

function digestFileStates(files: AggregatedChangeFile[], phase: 'pre' | 'post'): string {
  const hash = createHash('sha256');
  for (const file of files) {
    const path = phase === 'pre' ? file.oldPath : file.newPath;
    const exists = phase === 'pre' ? file.preExists : file.postExists;
    const digest = phase === 'pre' ? file.preHash : file.postHash;
    hash.update(`${path ?? ''}\0${exists ? (digest ?? 'missing') : absentDigest}\0`);
  }
  return `sha256:${hash.digest('hex')}`;
}

function validateOperationPreconditions(projectRoot: string, files: AggregatedChangeFile[], action: 'undo' | 'reapply'): string[] {
  const phase = action === 'undo' ? 'post' : 'pre';
  const conflicts = new Set<string>();
  for (const file of files) {
    const primaryPath = phase === 'pre' ? file.oldPath : file.newPath;
    const expectedExists = phase === 'pre' ? file.preExists : file.postExists;
    const expectedHash = phase === 'pre' ? file.preHash : file.postHash;
    if (primaryPath) {
      const absolutePath = normalizeProjectRelativePath(primaryPath, projectRoot).absolutePath;
      const current = currentFileState(absolutePath);
      if (current.exists !== expectedExists || (expectedExists && current.hash !== expectedHash)) conflicts.add(primaryPath);
    }
    if (file.oldPath && file.newPath && file.oldPath !== file.newPath) {
      const secondaryPath = phase === 'pre' ? file.newPath : file.oldPath;
      const secondary = currentFileState(normalizeProjectRelativePath(secondaryPath, projectRoot).absolutePath);
      if (secondary.exists) conflicts.add(secondaryPath);
    }
  }
  return [...conflicts];
}

function applyFileSnapshots(projectRoot: string, files: AggregatedChangeFile[], phase: 'pre' | 'post'): void {
  const writes: Array<{ path: string; blobRef: string; mode: number | null }> = [];
  const removals = new Set<string>();
  for (const file of files) {
    const primaryRelativePath = phase === 'pre' ? file.oldPath : file.newPath;
    const otherRelativePath = phase === 'pre' ? file.newPath : file.oldPath;
    const exists = phase === 'pre' ? file.preExists : file.postExists;
    const blobRef = phase === 'pre' ? file.preBlobRef : file.postBlobRef;
    const mode = phase === 'pre' ? file.preMode : file.postMode;
    if (otherRelativePath && otherRelativePath !== primaryRelativePath) {
      removals.add(normalizeProjectRelativePath(otherRelativePath, projectRoot).absolutePath);
    }
    if (!primaryRelativePath) continue;
    const absolutePath = normalizeProjectRelativePath(primaryRelativePath, projectRoot).absolutePath;
    if (!exists) {
      removals.add(absolutePath);
      continue;
    }
    if (!blobRef || !existsSync(blobRef)) {
      throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_BLOB_MISSING', `Recovery data is missing for ${primaryRelativePath}.`);
    }
    writes.push({ path: absolutePath, blobRef, mode });
  }
  for (const path of removals) removeRegularFileIfPresent(path);
  for (const write of writes) writeFileAtomically(write.path, readFileSync(write.blobRef), write.mode);
}

function removeRegularFileIfPresent(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw turnChangeSetError('ZEUS_TURN_CHANGE_SET_PATH_TYPE_CONFLICT', 'Undo/Reapply refuses to replace a symbolic link or directory.');
    }
    unlinkSync(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

function writeFileAtomically(path: string, bytes: Buffer, mode: number | null): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.zeus-${randomUUID()}`);
  try {
    writeFileSync(temporaryPath, bytes, { mode: mode ?? 0o644, flag: 'wx' });
    if (mode !== null) chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // 临时文件不存在或清理失败时保留原错误。
    }
    throw error;
  }
}

function currentFileState(path: string): { exists: boolean; hash: string | null } {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return { exists: true, hash: 'unsupported' };
    return { exists: true, hash: hashBytes(readFileSync(path)) };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { exists: false, hash: null };
    throw error;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporaryPath, path);
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

function safeSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function parseConflict(value: string | null): TurnChangeConflict | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || typeof parsed.code !== 'string' || typeof parsed.message !== 'string' || !Array.isArray(parsed.paths) || !parsed.paths.every((path) => typeof path === 'string')) return null;
    return { code: parsed.code, message: parsed.message, paths: parsed.paths };
  } catch {
    return null;
  }
}

function parseOperationResult(value: string): TurnChangeSetOperationResult | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.changeSet) || typeof parsed.changeSet.id !== 'string') return null;
    return parsed as unknown as TurnChangeSetOperationResult;
  } catch {
    return null;
  }
}

function turnChangeSetError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function changeSetErrorStatus(error: unknown): number {
  const code = errorCode(error);
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code.includes('FORBIDDEN')) return 403;
  if (code.includes('INVALID')) return 400;
  if (code.includes('CONFLICT') || code.includes('STATE') || code.includes('BUSY')) return 409;
  if (code.includes('UNAVAILABLE') || code.includes('MISSING')) return 422;
  return 500;
}

export function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof (error as Error & { code?: unknown }).code === 'string' ? String((error as Error & { code: string }).code) : 'ZEUS_TURN_CHANGE_SET_OPERATION_FAILED';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
