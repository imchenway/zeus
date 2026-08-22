import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative } from 'node:path';
import { isTaskAttachmentField, type TaskAttachmentField } from '@zeus/shared';
import type { ZeusDatabase } from '@zeus/storage';

export function migrateRuntimeDirectory(legacyPath: string, targetPath: string): string {
  if (!existsSync(targetPath) && existsSync(legacyPath)) {
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    // 旧目录保留作回退依据，复制成功后新运行内核只写入收敛后的目录。
    cpSync(legacyPath, targetPath, { recursive: true, errorOnExist: true, force: false });
  }
  mkdirSync(targetPath, { recursive: true, mode: 0o700 });
  return realpathSync(targetPath);
}

export function ensurePiGlobalAgentProjection(codexHome: string | undefined, piAgentDirectory: string): void {
  if (!codexHome) return;
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const canonicalCodexHome = realpathSync(codexHome);
  const projectionPath = join(piAgentDirectory, 'AGENTS.md');
  try {
    lstatSync(projectionPath);
    return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
  }
  // Pi 只复用纯文本全局指令；Codex 插件、技能和配置格式不在这里伪装成 Pi 原生资源。
  symlinkSync(relative(piAgentDirectory, join(canonicalCodexHome, 'AGENTS.md')), projectionPath);
}

export function prepareTaskAttachmentRoot(path: string | undefined): string | undefined {
  if (!path) return undefined;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

type ManagedTaskAttachmentRepairResult = {
  repairedAttachmentCount: number;
  repairedTaskCount: number;
  repairedPathCount: number;
  repairedFieldCount: number;
};

export function historicalTaskAttachmentField(taskType: unknown): TaskAttachmentField {
  if (taskType === 'defect') return 'defectCurrentState';
  if (taskType === 'optimization') return 'optimizationCurrentState';
  return 'description';
}

function inspectTaskManagedResource(resourcePath: string): { bytes: number; digest: string } {
  const resource = lstatSync(resourcePath);
  if (resource.isSymbolicLink()) throw new Error('symbolic links are not trusted task attachments');
  if (resource.isFile()) {
    const bytes = readFileSync(resourcePath);
    return { bytes: bytes.byteLength, digest: createHash('sha256').update('file\0').update(bytes).digest('hex') };
  }
  if (!resource.isDirectory()) throw new Error('unsupported task attachment type');
  const digest = createHash('sha256').update('directory\0');
  let bytes = 0;
  for (const entryName of readdirSync(resourcePath).sort()) {
    const entry = inspectTaskManagedResource(join(resourcePath, entryName));
    bytes += entry.bytes;
    digest.update(entryName).update('\0').update(entry.digest).update('\0');
  }
  return { bytes, digest: digest.digest('hex') };
}

export function resolveCurrentManagedTaskAttachmentPath(attachment: Record<string, unknown>, taskAttachmentRoot: string | undefined): string | undefined {
  if (!taskAttachmentRoot) return undefined;
  const storedPath = typeof attachment.path === 'string' ? attachment.path.trim() : '';
  if (!storedPath || !isAbsolute(storedPath)) return undefined;
  try {
    const currentRoot = realpathSync(taskAttachmentRoot);
    const storedRealPath = realpathSync(storedPath);
    if (isPathInsideRoot(storedRealPath, currentRoot) && storedRealPath !== currentRoot) return storedRealPath;
  } catch {
    // 历史绝对路径可能已经不存在；继续尝试当前托管目录中的同一资源标识。
  }
  if (parse(dirname(storedPath)).base !== 'task-attachments') return undefined;
  const managedResourceName = parse(storedPath).base;
  if (!/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-.+/iu.test(managedResourceName)) return undefined;
  try {
    const currentRoot = realpathSync(taskAttachmentRoot);
    const candidatePath = realpathSync(join(currentRoot, managedResourceName));
    if (!isPathInsideRoot(candidatePath, currentRoot) || candidatePath === currentRoot) return undefined;
    const candidate = statSync(candidatePath);
    const storedKind = typeof attachment.kind === 'string' ? attachment.kind : '';
    if ((storedKind === 'directory') !== candidate.isDirectory()) return undefined;
    if (!candidate.isFile() && !candidate.isDirectory()) return undefined;
    const storedSize = typeof attachment.size === 'number' && Number.isFinite(attachment.size) ? attachment.size : undefined;
    if (candidate.isFile() && storedSize !== undefined && candidate.size !== storedSize) return undefined;
    let candidateInspection: ReturnType<typeof inspectTaskManagedResource> | undefined;
    if (candidate.isDirectory() && storedSize !== undefined) {
      candidateInspection = inspectTaskManagedResource(candidatePath);
      if (candidateInspection.bytes !== storedSize) return undefined;
    }

    if (existsSync(storedPath)) {
      const storedRealPath = realpathSync(storedPath);
      if (storedRealPath !== candidatePath) {
        candidateInspection ??= inspectTaskManagedResource(candidatePath);
        if (inspectTaskManagedResource(storedRealPath).digest !== candidateInspection.digest) return undefined;
      }
    } else {
      // 原目录已经清理时，只能依据受信当前目录、稳定资源名、类型和已保存大小恢复。
    }
    return candidatePath;
  } catch {
    return undefined;
  }
}

export function repairTaskAttachmentReferences(db: ZeusDatabase, taskAttachmentRoot: string | undefined): ManagedTaskAttachmentRepairResult {
  let repairedAttachmentCount = 0;
  let repairedTaskCount = 0;
  let repairedPathCount = 0;
  let repairedFieldCount = 0;
  for (const row of db.select<{ id: string; task_type: string; source_context_json: string }>(`SELECT id, task_type, source_context_json
                                                                              FROM tasks
                                                                              WHERE deleted_at IS NULL`)) {
    let sourceContext: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.source_context_json) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      sourceContext = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!Array.isArray(sourceContext.attachments)) continue;
    let taskChanged = false;
    const repairedAttachments = sourceContext.attachments.map((rawAttachment) => {
      if (!rawAttachment || typeof rawAttachment !== 'object' || Array.isArray(rawAttachment)) return rawAttachment;
      const attachment = rawAttachment as Record<string, unknown>;
      const currentPath = resolveCurrentManagedTaskAttachmentPath(attachment, taskAttachmentRoot);
      const field = isTaskAttachmentField(attachment.field) ? attachment.field : historicalTaskAttachmentField(row.task_type);
      const pathChanged = Boolean(currentPath && currentPath !== attachment.path);
      const fieldChanged = field !== attachment.field;
      if (!pathChanged && !fieldChanged) return rawAttachment;
      taskChanged = true;
      repairedAttachmentCount += 1;
      if (pathChanged) repairedPathCount += 1;
      if (fieldChanged) repairedFieldCount += 1;
      return { ...attachment, ...(currentPath ? { path: currentPath } : {}), field };
    });
    const attachmentsByPath = new Map<string, unknown>();
    const attachmentsWithoutPath: unknown[] = [];
    for (const attachment of repairedAttachments) {
      const path = attachment && typeof attachment === 'object' && !Array.isArray(attachment) && typeof (attachment as Record<string, unknown>).path === 'string' ? String((attachment as Record<string, unknown>).path).trim() : '';
      if (path) attachmentsByPath.set(path, attachment);
      else attachmentsWithoutPath.push(attachment);
    }
    const attachments = [...attachmentsByPath.values(), ...attachmentsWithoutPath];
    if (attachments.length !== repairedAttachments.length) {
      taskChanged = true;
      repairedAttachmentCount += repairedAttachments.length - attachments.length;
    }
    if (!taskChanged) continue;
    db.execute(
      `UPDATE tasks
                    SET source_context_json = ?
                    WHERE id = ?`,
      [JSON.stringify({ ...sourceContext, attachments }), row.id],
    );
    repairedTaskCount += 1;
  }
  return { repairedAttachmentCount, repairedTaskCount, repairedPathCount, repairedFieldCount };
}

export function hasTaskImageSignature(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/gif') return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (mime === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mime === 'image/bmp') return bytes.subarray(0, 2).toString('ascii') === 'BM';
  if (mime === 'image/tiff') return bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
  if (mime === 'image/heic' || mime === 'image/heif') {
    const boxType = bytes.subarray(4, 12).toString('ascii');
    return boxType.startsWith('ftyp') && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(bytes.subarray(8, 12).toString('ascii'));
  }
  return false;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
}
