import {createHash, randomUUID} from 'node:crypto';
import {constants as fsConstants, createReadStream} from 'node:fs';
import {chmod, copyFile, link, lstat, mkdir, open, realpath, stat, unlink} from 'node:fs/promises';
import {basename, dirname, extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import type {ConversationRepository, ZeusConversationRecord, ZeusDatabase} from '@zeus/storage';

const sessionMetadataReadLimit = 1024 * 1024;

export type MisplacedCodexThreadMigrationSkipReason =
    | 'source_missing'
    | 'source_symlink'
    | 'source_not_regular'
    | 'source_outside_allowed_root'
    | 'source_extension_invalid'
    | 'source_identity_unreadable'
    | 'source_thread_mismatch'
    | 'source_changed_during_copy'
    | 'target_directory_unsafe'
    | 'target_symlink'
    | 'target_not_regular'
    | 'target_identity_unreadable'
    | 'target_thread_mismatch'
    | 'target_aliases_source'
    | 'target_content_conflict'
    | 'migration_io_failed';

export interface MisplacedCodexThreadMigrationEntry {
    conversationId: string;
    providerThreadId: string;
    sourcePath: string;
    targetPath: string;
    sha256: string;
    result: 'copied' | 'existing';
}

export interface MisplacedCodexThreadMigrationSkip {
    conversationId: string;
    providerThreadId: string;
    sourcePath: string;
    targetPath: string | null;
    reason: MisplacedCodexThreadMigrationSkipReason;
}

export interface MisplacedCodexThreadMigrationReport {
    candidateCount: number;
    copied: MisplacedCodexThreadMigrationEntry[];
    existing: MisplacedCodexThreadMigrationEntry[];
    skipped: MisplacedCodexThreadMigrationSkip[];
}

export interface MisplacedCodexThreadMigrationInput {
    db: ZeusDatabase;
    conversations: ConversationRepository;
    sourceCodexHome: string;
    targetCodexHome: string;
}

class ThreadMigrationSkipError extends Error {
    constructor(readonly reason: MisplacedCodexThreadMigrationSkipReason) {
        super(reason);
    }
}

/**
 * 旧运行时曾把 Zeus 会话写入默认 Codex Home。这里只迁移数据库已经持久化的精确文件，
 * 不扫描目录猜测线程，也不移动或删除源文件。
 */
export async function migrateMisplacedCodexThreadRollouts(input: MisplacedCodexThreadMigrationInput): Promise<MisplacedCodexThreadMigrationReport> {
    const report: MisplacedCodexThreadMigrationReport = {candidateCount: 0, copied: [], existing: [], skipped: []};
    if (!isAbsolute(input.sourceCodexHome) || !isAbsolute(input.targetCodexHome)) return report;

    const configuredSourceSessions = resolve(input.sourceCodexHome, 'sessions');
    const records = input.conversations.listProviderThreadPathCandidates();
    let sourceSessions: string;
    try {
        sourceSessions = await realpath(configuredSourceSessions);
    } catch (error) {
        const candidates = records.filter((conversation) => isStoredSourceCandidate(conversation, configuredSourceSessions));
        report.candidateCount = candidates.length;
        const reason = errorCode(error) === 'ENOENT' ? 'source_missing' : 'migration_io_failed';
        report.skipped.push(...candidates.map((conversation) => skippedBeforeTarget(conversation, reason)));
        return report;
    }

    const candidates = records.filter((conversation) => isStoredSourceCandidate(conversation, configuredSourceSessions) || isStoredSourceCandidate(conversation, sourceSessions));
    report.candidateCount = candidates.length;

    let targetSessions: string;
    try {
        await mkdir(join(input.targetCodexHome, 'sessions'), {recursive: true, mode: 0o700});
        targetSessions = await realpath(join(input.targetCodexHome, 'sessions'));
    } catch {
        report.skipped.push(...candidates.map((conversation) => skippedBeforeTarget(conversation, 'target_directory_unsafe')));
        return report;
    }
    if (sourceSessions === targetSessions) {
        report.candidateCount = 0;
        return report;
    }

    for (const conversation of candidates) {
        const sourcePath = conversation.providerThreadPath!;
        let targetPath: string | null = null;
        try {
            const source = await verifySourceFile(sourcePath, sourceSessions, conversation.providerThreadId!);
            const relativePath = relative(sourceSessions, source.path);
            targetPath = join(targetSessions, relativePath);
            const targetDirectory = await prepareTargetDirectory(targetPath, targetSessions);
            targetPath = join(targetDirectory, basename(targetPath));
            const migrated = await copyOrAdoptThreadFile({
                sourcePath: source.path,
                sourceSnapshot: source.snapshot,
                targetPath,
                providerThreadId: conversation.providerThreadId!,
            });
            const entry: MisplacedCodexThreadMigrationEntry = {
                conversationId: conversation.id,
                providerThreadId: conversation.providerThreadId!,
                sourcePath: source.path,
                targetPath,
                sha256: migrated.sha256,
                result: migrated.result,
            };
            if (migrated.result === 'copied') report.copied.push(entry);
            else report.existing.push(entry);
        } catch (error) {
            report.skipped.push({
                conversationId: conversation.id,
                providerThreadId: conversation.providerThreadId!,
                sourcePath,
                targetPath,
                reason: error instanceof ThreadMigrationSkipError ? error.reason : 'migration_io_failed',
            });
        }
    }

    const migrated = [...report.copied, ...report.existing];
    if (migrated.length > 0) {
        input.db.transaction(() => {
            for (const entry of migrated) {
                input.conversations.updateProviderThreadPathRecord(entry.conversationId, {
                    providerThreadId: entry.providerThreadId,
                    providerThreadPath: entry.targetPath,
                });
            }
        });
        await input.db.save();
    }
    return report;
}

function skippedBeforeTarget(conversation: ZeusConversationRecord, reason: 'source_missing' | 'target_directory_unsafe' | 'migration_io_failed'): MisplacedCodexThreadMigrationSkip {
    return {
        conversationId: conversation.id,
        providerThreadId: conversation.providerThreadId!,
        sourcePath: conversation.providerThreadPath!,
        targetPath: null,
        reason,
    };
}

function isStoredSourceCandidate(conversation: ZeusConversationRecord, sourceSessions: string): boolean {
    if (!conversation.providerThreadId || !conversation.providerThreadPath || !isAbsolute(conversation.providerThreadPath)) return false;
    return isPathInsideRoot(resolve(conversation.providerThreadPath), sourceSessions) && resolve(conversation.providerThreadPath) !== sourceSessions;
}

async function verifySourceFile(storedPath: string, sourceSessions: string, providerThreadId: string): Promise<{
    path: string;
    snapshot: FileSnapshot
}> {
    let storedStatus;
    try {
        storedStatus = await lstat(storedPath);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') throw new ThreadMigrationSkipError('source_missing');
        throw error;
    }
    if (storedStatus.isSymbolicLink()) throw new ThreadMigrationSkipError('source_symlink');
    if (!storedStatus.isFile()) throw new ThreadMigrationSkipError('source_not_regular');
    if (extname(storedPath).toLocaleLowerCase() !== '.jsonl') throw new ThreadMigrationSkipError('source_extension_invalid');

    const sourcePath = await realpath(storedPath);
    if (!isPathInsideRoot(sourcePath, sourceSessions) || sourcePath === sourceSessions) {
        throw new ThreadMigrationSkipError('source_outside_allowed_root');
    }
    await verifyThreadIdentity(sourcePath, providerThreadId, 'source');
    return {path: sourcePath, snapshot: await fileSnapshot(sourcePath)};
}

async function prepareTargetDirectory(targetPath: string, targetSessions: string): Promise<string> {
    const targetDirectory = dirname(targetPath);
    if (!isPathInsideRoot(targetDirectory, targetSessions)) throw new ThreadMigrationSkipError('target_directory_unsafe');
    await mkdir(targetDirectory, {recursive: true, mode: 0o700});
    const canonicalDirectory = await realpath(targetDirectory);
    if (!isPathInsideRoot(canonicalDirectory, targetSessions)) throw new ThreadMigrationSkipError('target_directory_unsafe');
    return canonicalDirectory;
}

async function copyOrAdoptThreadFile(input: {
    sourcePath: string;
    sourceSnapshot: FileSnapshot;
    targetPath: string;
    providerThreadId: string
}): Promise<{ result: 'copied' | 'existing'; sha256: string }> {
    if (await pathExists(input.targetPath)) return verifyExistingTarget(input);

    const temporaryPath = join(dirname(input.targetPath), `.${basename(input.targetPath)}.${randomUUID()}.tmp`);
    try {
        await copyFile(input.sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL);
        await chmod(temporaryPath, 0o600);
        await verifyThreadIdentity(temporaryPath, input.providerThreadId, 'target');
        const [sourceSha256, temporarySha256] = await Promise.all([sha256File(input.sourcePath), sha256File(temporaryPath)]);
        if (!(await matchesFileSnapshot(input.sourcePath, input.sourceSnapshot))) {
            throw new ThreadMigrationSkipError('source_changed_during_copy');
        }
        if (sourceSha256 !== temporarySha256) throw new ThreadMigrationSkipError('target_content_conflict');
        await syncFile(temporaryPath);
        if (!(await matchesFileSnapshot(input.sourcePath, input.sourceSnapshot))) {
            throw new ThreadMigrationSkipError('source_changed_during_copy');
        }
        try {
            // 硬链接发布不会覆盖并发创建的目标；临时文件随后删除，目标仍是完整独立入口。
            await link(temporaryPath, input.targetPath);
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
            return await verifyExistingTarget(input);
        }
        await syncDirectory(dirname(input.targetPath));
        return {result: 'copied', sha256: sourceSha256};
    } finally {
        await unlink(temporaryPath).catch((error: unknown) => {
            if (errorCode(error) !== 'ENOENT') throw error;
        });
    }
}

async function verifyExistingTarget(input: {
    sourcePath: string;
    sourceSnapshot: FileSnapshot;
    targetPath: string;
    providerThreadId: string
}): Promise<{ result: 'existing'; sha256: string }> {
    const status = await lstat(input.targetPath);
    if (status.isSymbolicLink()) throw new ThreadMigrationSkipError('target_symlink');
    if (!status.isFile()) throw new ThreadMigrationSkipError('target_not_regular');
    if (status.dev === input.sourceSnapshot.device && status.ino === input.sourceSnapshot.inode) {
        throw new ThreadMigrationSkipError('target_aliases_source');
    }
    await verifyThreadIdentity(input.targetPath, input.providerThreadId, 'target');
    const [sourceSha256, targetSha256] = await Promise.all([sha256File(input.sourcePath), sha256File(input.targetPath)]);
    if (!(await matchesFileSnapshot(input.sourcePath, input.sourceSnapshot))) {
        throw new ThreadMigrationSkipError('source_changed_during_copy');
    }
    if (sourceSha256 !== targetSha256) throw new ThreadMigrationSkipError('target_content_conflict');
    return {result: 'existing', sha256: sourceSha256};
}

async function verifyThreadIdentity(path: string, providerThreadId: string, kind: 'source' | 'target'): Promise<void> {
    let handle;
    try {
        handle = await open(path, 'r');
        const buffer = Buffer.alloc(sessionMetadataReadLimit);
        const {bytesRead} = await handle.read(buffer, 0, buffer.byteLength, 0);
        const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/u)[0]?.trim();
        if (!firstLine) throw new Error('missing session metadata');
        const event = JSON.parse(firstLine) as { type?: unknown; payload?: { id?: unknown } };
        if (event.type !== 'session_meta' || typeof event.payload?.id !== 'string') throw new Error('invalid session metadata');
        if (event.payload.id.toLocaleLowerCase() !== providerThreadId.toLocaleLowerCase()) {
            throw new ThreadMigrationSkipError(kind === 'source' ? 'source_thread_mismatch' : 'target_thread_mismatch');
        }
    } catch (error) {
        if (error instanceof ThreadMigrationSkipError) throw error;
        throw new ThreadMigrationSkipError(kind === 'source' ? 'source_identity_unreadable' : 'target_identity_unreadable');
    } finally {
        await handle?.close();
    }
}

interface FileSnapshot {
    device: number;
    inode: number;
    size: number;
    modifiedAt: number;
    changedAt: number;
}

async function fileSnapshot(path: string): Promise<FileSnapshot> {
    const status = await stat(path);
    return {
        device: status.dev,
        inode: status.ino,
        size: status.size,
        modifiedAt: status.mtimeMs,
        changedAt: status.ctimeMs,
    };
}

async function matchesFileSnapshot(path: string, expected: FileSnapshot): Promise<boolean> {
    const current = await fileSnapshot(path);
    return current.device === expected.device && current.inode === expected.inode && current.size === expected.size && current.modifiedAt === expected.modifiedAt && current.changedAt === expected.changedAt;
}

async function sha256File(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

async function syncFile(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
    }
}

function isPathInsideRoot(candidate: string, root: string): boolean {
    const delta = relative(root, candidate);
    return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

function errorCode(error: unknown): string | null {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;
}
