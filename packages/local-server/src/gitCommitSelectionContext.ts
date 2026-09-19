import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseGitPorcelainStatus } from '@zeus/git-core';

const execute = promisify(execFile);
async function git(cwd: string, args: string[], index?: string, allowDiff = false) {
  try {
    return (await execute('git', args, { cwd, timeout: 15_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) } })).stdout;
  } catch (error) {
    if (allowDiff && (error as { code?: unknown }).code === 1 && typeof (error as { stdout?: unknown }).stdout === 'string') return (error as { stdout: string }).stdout;
    throw error;
  }
}
async function optionalRef(cwd: string, args: string[]) {
  try {
    return (await git(cwd, args)).trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return '';
    throw error;
  }
}

async function resolveSelection(cwd: string, selected: string[]) {
  if (
    !selected.length ||
    selected.length > 2000 ||
    selected.join('\0').length > 100_000 ||
    selected.some((path) => !path || isAbsolute(path) || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..'))
  ) {
    throw new Error('所选文件路径无效或过多，请重新选择。');
  }
  const status = parseGitPorcelainStatus(await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']));
  if (status.conflictFiles.length) throw new Error('请先解决仓库冲突，再生成提交说明。');
  const paths = [...new Set(selected)];
  for (const path of selected) {
    const file = status.fileStatuses.find((item) => item.path === path);
    if (!file || file.path.endsWith('/')) throw new Error('所选文件已变化或包含嵌套仓库，请刷新后重新选择。');
    if (file.category === 'renamed' && file.originalPath && !paths.includes(file.originalPath)) {
      const restored = await lstat(resolve(cwd, file.originalPath)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (restored) throw new Error('重命名来源又出现文件，请同时选择该文件或先处理其更改。');
      paths.push(file.originalPath);
    }
  }
  return paths.sort();
}

async function fingerprint(cwd: string, paths: string[]) {
  const [head, branch] = await Promise.all([optionalRef(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']), optionalRef(cwd, ['symbolic-ref', '-q', 'HEAD'])]);
  const hash = createHash('sha256').update(head).update('\0').update(branch);
  for (const path of paths) {
    hash.update('\0').update(path).update('\0');
    const target = resolve(cwd, path);
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) hash.update('deleted');
    else if (info.isSymbolicLink()) hash.update('symlink:').update(await readlink(target));
    else if (info.isFile()) {
      hash.update(String(info.mode & 0o111)).update('\0');
      for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
    } else if (info.isDirectory()) {
      // 已跟踪子模块只记录 Git 指针与脏状态，不读取其内部文件内容。
      hash.update(await git(target, ['rev-parse', '--verify', 'HEAD'])).update(await git(target, ['status', '--porcelain', '-z']));
    } else throw new Error('所选路径不是可提交的文件。');
  }
  return { head, fingerprint: hash.digest('hex') };
}

export async function readSelectedCommitFingerprint(cwd: string, selected: string[]) {
  return (await fingerprint(cwd, await resolveSelection(cwd, selected))).fingerprint;
}

/** 临时索引仅载入 HEAD；不暂存文件，不写对象，也不触碰用户的真实 index。 */
export async function readSelectedGitCommitChanges(cwd: string, selected: string[]) {
  const paths = await resolveSelection(cwd, selected);
  const before = await fingerprint(cwd, paths);
  const directory = await mkdtemp(join(tmpdir(), 'zeus-commit-context-'));
  const index = join(directory, 'index');
  try {
    await git(cwd, ['read-tree', ...(before.head ? [before.head] : ['--empty'])], index);
    const tracked = new Set((await git(cwd, ['--literal-pathspecs', 'ls-files', '-z', '--', ...paths], index)).split('\0').filter(Boolean));
    const trackedPaths = paths.filter((path) => tracked.has(path));
    const common = ['--no-ext-diff', '--no-textconv', '--no-color'];
    const [trackedDiff, trackedStat] = trackedPaths.length
      ? await Promise.all([git(cwd, ['--literal-pathspecs', 'diff', ...common, '--unified=3', '--', ...trackedPaths], index), git(cwd, ['--literal-pathspecs', 'diff', ...common, '--numstat', '--', ...trackedPaths], index)])
      : ['', ''];
    const diffs = [trackedDiff];
    const stats = [trackedStat];
    for (const path of paths.filter((file) => !tracked.has(file))) {
      const exists = await lstat(resolve(cwd, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!exists) continue;
      if (!exists.isFile() && !exists.isSymbolicLink()) throw new Error('嵌套仓库需在各自仓库中选择文件。');
      const [diff, stat] = await Promise.all([
        git(cwd, ['diff', '--no-index', ...common, '--unified=3', '--', '/dev/null', path], undefined, true),
        git(cwd, ['diff', '--no-index', ...common, '--numstat', '--', '/dev/null', path], undefined, true),
      ]);
      diffs.push(diff);
      stats.push(stat);
    }
    if (before.fingerprint !== (await fingerprint(cwd, paths)).fingerprint) throw new Error('读取期间所选内容已变化，请重新生成。');
    const diff = diffs.filter(Boolean).join('\n');
    if (!diff.trim()) throw new Error('所选文件没有可提交的改动，请刷新后重新选择。');
    return { files: paths, diff, stat: stats.filter(Boolean).join('\n'), fingerprint: before.fingerprint };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
