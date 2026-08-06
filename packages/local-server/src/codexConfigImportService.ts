import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const importEntries = ['config.toml', 'AGENTS.md', 'rules', 'prompts', 'skills', 'plugins'] as const;
const sensitiveAssignment = /\b[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|credential)[A-Za-z0-9_.-]*\s*=\s*/iu;
const maximumImportedNodes = 20_000;

export interface CodexConfigImportEntry {
  path: string;
  kind: 'file' | 'directory';
  nodeCount: number;
}

export interface CodexConfigImportSkippedEntry {
  path: string;
  reason: 'missing' | 'symbolic_link' | 'unsupported_type' | 'contains_sensitive_assignment' | 'too_large';
}

export interface CodexConfigImportPreview {
  available: boolean;
  sourceRoot: string;
  targetRoot: string;
  entries: CodexConfigImportEntry[];
  skipped: CodexConfigImportSkippedEntry[];
}

export interface CodexConfigImportResult extends CodexConfigImportPreview {
  imported: string[];
  backupRoot: string | null;
  importedAt: string;
  restartRequired: boolean;
}

export interface CodexConfigImportService {
  inspect(): Promise<CodexConfigImportPreview>;
  import(): Promise<CodexConfigImportResult>;
}

export function createCodexConfigImportService(options: { sourceRoot: string; targetRoot: string; backupRoot: string; now?: () => Date }): CodexConfigImportService {
  const sourceRoot = resolveAbsolute(options.sourceRoot, 'Codex 配置来源目录');
  const targetRoot = resolveAbsolute(options.targetRoot, 'Zeus Codex 目录');
  const backupRoot = resolveAbsolute(options.backupRoot, 'Codex 配置导入备份目录');
  if (sourceRoot === targetRoot || isInside(sourceRoot, targetRoot) || isInside(targetRoot, sourceRoot)) {
    throw new Error('Codex 配置来源目录与 Zeus Codex 目录不能相同或互相包含。');
  }

  async function inspect(): Promise<CodexConfigImportPreview> {
    const entries: CodexConfigImportEntry[] = [];
    const skipped: CodexConfigImportSkippedEntry[] = [];
    let sourceAvailable = true;
    try {
      const sourceStat = await lstat(sourceRoot);
      sourceAvailable = sourceStat.isDirectory() && !sourceStat.isSymbolicLink();
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) sourceAvailable = false;
      else throw error;
    }
    if (!sourceAvailable) return { available: false, sourceRoot, targetRoot, entries, skipped };

    for (const entryName of importEntries) {
      const source = join(sourceRoot, entryName);
      try {
        const stat = await lstat(source);
        if (stat.isSymbolicLink()) {
          skipped.push({ path: entryName, reason: 'symbolic_link' });
          continue;
        }
        if (!stat.isFile() && !stat.isDirectory()) {
          skipped.push({ path: entryName, reason: 'unsupported_type' });
          continue;
        }
        if (entryName === 'config.toml' && sensitiveAssignment.test(await readFile(source, 'utf8'))) {
          skipped.push({ path: entryName, reason: 'contains_sensitive_assignment' });
          continue;
        }
        const nodeCount = await countSafeNodes(source, sourceRoot, new Set<string>());
        if (nodeCount > maximumImportedNodes) {
          skipped.push({ path: entryName, reason: 'too_large' });
          continue;
        }
        entries.push({ path: entryName, kind: stat.isDirectory() ? 'directory' : 'file', nodeCount });
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) skipped.push({ path: entryName, reason: 'missing' });
        else if (error instanceof UnsafeSymbolicLinkError) skipped.push({ path: entryName, reason: 'symbolic_link' });
        else throw error;
      }
    }
    return { available: entries.length > 0, sourceRoot, targetRoot, entries, skipped };
  }

  async function importConfiguration(): Promise<CodexConfigImportResult> {
    const preview = await inspect();
    const importedAt = (options.now?.() ?? new Date()).toISOString();
    if (!preview.available) return { ...preview, imported: [], backupRoot: null, importedAt, restartRequired: false };

    const transactionId = `${importedAt.replace(/[:.]/gu, '-')}-${randomUUID()}`;
    const stagingRoot = join(dirname(targetRoot), `.codex-import-${transactionId}`);
    const transactionBackupRoot = join(backupRoot, transactionId);
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    const imported: string[] = [];
    const backedUp: string[] = [];
    let wroteBackup = false;
    try {
      for (const entry of preview.entries) {
        await cp(join(sourceRoot, entry.path), join(stagingRoot, entry.path), {
          recursive: entry.kind === 'directory',
          dereference: true,
          errorOnExist: true,
          force: false,
        });
      }
      if (preview.entries.some((entry) => entry.path === 'config.toml')) {
        const stagedConfigPath = join(stagingRoot, 'config.toml');
        const stagedConfig = await readFile(stagedConfigPath, 'utf8');
        const rewrittenConfig = stagedConfig.split(sourceRoot).join(targetRoot).split('~/.codex').join(targetRoot);
        if (rewrittenConfig !== stagedConfig) await writeFile(stagedConfigPath, rewrittenConfig, { encoding: 'utf8', mode: 0o600 });
      }
      for (const entry of preview.entries) {
        const target = join(targetRoot, entry.path);
        try {
          await lstat(target);
          await mkdir(transactionBackupRoot, { recursive: true, mode: 0o700 });
          await rename(target, join(transactionBackupRoot, entry.path));
          backedUp.push(entry.path);
          wroteBackup = true;
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error;
        }
        await rename(join(stagingRoot, entry.path), target);
        imported.push(entry.path);
      }
      return {
        ...preview,
        imported,
        backupRoot: wroteBackup ? transactionBackupRoot : null,
        importedAt,
        restartRequired: imported.length > 0,
      };
    } catch (error) {
      for (const entryName of [...imported].reverse()) {
        await rm(join(targetRoot, entryName), { recursive: true, force: true });
      }
      for (const entryName of [...backedUp].reverse()) {
        const backup = join(transactionBackupRoot, entryName);
        try {
          await rename(backup, join(targetRoot, entryName));
        } catch {
          // 回滚失败时保留备份目录，错误继续向上暴露，避免用不完整结果冒充成功。
        }
      }
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  return { inspect, import: importConfiguration };
}

async function countSafeNodes(path: string, sourceRoot: string, visited: Set<string>): Promise<number> {
  const entryStat = await lstat(path);
  const canonicalPath = entryStat.isSymbolicLink() ? await realpath(path) : resolve(path);
  if (entryStat.isSymbolicLink() && canonicalPath !== sourceRoot && !isInside(sourceRoot, canonicalPath)) throw new UnsafeSymbolicLinkError(path);
  if (visited.has(canonicalPath)) return 0;
  visited.add(canonicalPath);
  const canonicalStat = entryStat.isSymbolicLink() ? await stat(canonicalPath) : entryStat;
  if (!canonicalStat.isDirectory()) return 1;
  let count = 1;
  for (const name of await readdir(canonicalPath)) {
    count += await countSafeNodes(join(canonicalPath, name), sourceRoot, visited);
    if (count > maximumImportedNodes) return count;
  }
  return count;
}

class UnsafeSymbolicLinkError extends Error {}

function resolveAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label}必须是绝对路径。`);
  return resolve(path);
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
