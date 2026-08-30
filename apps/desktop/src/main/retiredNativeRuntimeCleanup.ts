import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ZeusRetiredNativeRuntimeState } from '@zeus/shared';

const retiredEntries = ['computer-use/Codex Computer Use.app', 'plugins/cache/openai-bundled/browser', 'plugins/cache/openai-bundled/chrome', 'plugins/cache/openai-bundled/computer-use'] as const;

interface RetiredRuntimeManifest {
  kind: 'zeus-retired-native-runtime-backup';
  sourceRoot: string;
  backupRoot: string;
  entries: string[];
  archivedAt: string;
  restoredAt?: string;
}

export class RetiredNativeRuntimeCleanup {
  private readonly sourceRoot: string;
  private readonly backupRoot: string;

  constructor(
    sourceRoot: string,
    backupRoot: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.sourceRoot = requireAbsolute(sourceRoot, '旧 Codex runtime 根目录');
    this.backupRoot = requireAbsolute(backupRoot, '旧 runtime 备份目录');
    if (this.sourceRoot === this.backupRoot || isInside(this.sourceRoot, this.backupRoot) || isInside(this.backupRoot, this.sourceRoot)) throw new Error('旧 runtime 来源与备份目录必须隔离。');
  }

  async inspect(): Promise<ZeusRetiredNativeRuntimeState> {
    const entries = await this.existingSourceEntries();
    const latest = await this.latestManifest();
    return {
      sourceRoot: this.sourceRoot,
      entries,
      latestBackupRoot: latest?.backupRoot ?? null,
      ...(latest?.archivedAt ? { archivedAt: latest.archivedAt } : {}),
      ...(latest?.restoredAt ? { restoredAt: latest.restoredAt } : {}),
    };
  }

  async archive(): Promise<ZeusRetiredNativeRuntimeState> {
    const entries = await this.existingSourceEntries();
    if (entries.length === 0) return this.inspect();
    const archivedAt = this.now();
    const transactionRoot = join(this.backupRoot, `${archivedAt.replace(/[:.]/gu, '-')}-${randomUUID()}`);
    await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
    const moved: string[] = [];
    try {
      for (const entry of entries) {
        const target = join(transactionRoot, entry);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await rename(join(this.sourceRoot, entry), target);
        moved.push(entry);
      }
      const manifest: RetiredRuntimeManifest = { kind: 'zeus-retired-native-runtime-backup', sourceRoot: this.sourceRoot, backupRoot: transactionRoot, entries: moved, archivedAt };
      await writeFile(join(transactionRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      for (const entry of [...moved].reverse()) {
        await mkdir(dirname(join(this.sourceRoot, entry)), { recursive: true, mode: 0o700 });
        await rename(join(transactionRoot, entry), join(this.sourceRoot, entry)).catch(() => undefined);
      }
      throw error;
    }
    return this.inspect();
  }

  async restoreLatest(): Promise<ZeusRetiredNativeRuntimeState> {
    const manifest = await this.latestManifest();
    if (!manifest || manifest.restoredAt) return this.inspect();
    for (const entry of manifest.entries) {
      if (await exists(join(this.sourceRoot, entry))) throw Object.assign(new Error(`无法恢复旧 runtime，目标已存在：${entry}`), { code: 'ZEUS_RETIRED_RUNTIME_RESTORE_CONFLICT' });
      if (!(await exists(join(manifest.backupRoot, entry)))) throw Object.assign(new Error(`旧 runtime 备份不完整：${entry}`), { code: 'ZEUS_RETIRED_RUNTIME_BACKUP_INCOMPLETE' });
    }
    const restored: string[] = [];
    try {
      for (const entry of manifest.entries) {
        await mkdir(dirname(join(this.sourceRoot, entry)), { recursive: true, mode: 0o700 });
        await rename(join(manifest.backupRoot, entry), join(this.sourceRoot, entry));
        restored.push(entry);
      }
      manifest.restoredAt = this.now();
      await writeFile(join(manifest.backupRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      for (const entry of [...restored].reverse()) {
        await mkdir(dirname(join(manifest.backupRoot, entry)), { recursive: true, mode: 0o700 });
        await rename(join(this.sourceRoot, entry), join(manifest.backupRoot, entry)).catch(() => undefined);
      }
      throw error;
    }
    return this.inspect();
  }

  private async existingSourceEntries(): Promise<string[]> {
    const entries: string[] = [];
    for (const entry of retiredEntries) {
      const path = join(this.sourceRoot, entry);
      const candidate = await lstat(path).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      if (!candidate) continue;
      if (candidate.isSymbolicLink()) throw Object.assign(new Error(`拒绝归档符号链接旧 runtime：${entry}`), { code: 'ZEUS_RETIRED_RUNTIME_SYMLINK_BLOCKED' });
      entries.push(entry);
    }
    return entries;
  }

  private async latestManifest(): Promise<RetiredRuntimeManifest | null> {
    const names = await readdir(this.backupRoot).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? [] : Promise.reject(error)));
    for (const name of names.sort().reverse()) {
      const root = join(this.backupRoot, name);
      try {
        const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as RetiredRuntimeManifest;
        if (manifest.kind !== 'zeus-retired-native-runtime-backup' || resolve(manifest.backupRoot) !== resolve(root) || resolve(manifest.sourceRoot) !== this.sourceRoot) continue;
        if (!Array.isArray(manifest.entries) || manifest.entries.some((entry) => !retiredEntries.includes(entry as (typeof retiredEntries)[number]))) continue;
        return manifest;
      } catch {
        // 非本服务创建或未完成的目录不参与恢复候选。
      }
    }
    return null;
  }
}

function requireAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label}必须是绝对路径。`);
  return resolve(path);
}

function isInside(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error))));
}
