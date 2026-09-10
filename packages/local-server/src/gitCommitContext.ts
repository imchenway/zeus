import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { discoverGitRepositories } from '@zeus/git-core';

const execute = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execute('git', args, { cwd, timeout: 15_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;

/** 只解析项目内已发现的仓库，不接受客户端任意工作目录。 */
export async function resolveCommitRepository(project: { id: string; localPath: string }, repositoryId: string) {
  const repositories = await discoverGitRepositories(project.localPath);
  const repository = repositories.find((item) => `project_git_repository_${createHash('sha256').update(`${project.id}\0${item.relativePath}`).digest('hex').slice(0, 24)}` === repositoryId);
  if (!repository) throw new Error('当前仓库已不可用。');
  return repository;
}

export async function readCommitFingerprint(cwd: string): Promise<string> {
  // 完整补丁包含二进制内容；不写 index/tree，对未提交的新仓库同样有效。
  const diff = await git(cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color']);
  return createHash('sha256').update(diff).digest('hex');
}

export async function readGitCommitContext(cwd: string) {
  const fingerprint = await readCommitFingerprint(cwd);
  const [names, stat, diff, history] = await Promise.all([
    git(cwd, ['diff', '--cached', '--name-only', '-z']),
    git(cwd, ['diff', '--cached', '--stat', '--no-ext-diff', '--no-textconv']),
    git(cwd, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3']),
    git(cwd, ['log', '-20', '--no-merges', '--format=%B%x00']).catch(async (error: unknown) => {
      // 仅未诞生的 HEAD 可以没有历史，其他错误不伪装成空历史。
      try {
        await git(cwd, ['rev-parse', '--verify', 'HEAD']);
      } catch {
        return '';
      }
      throw error;
    }),
  ]);
  const files = names.split('\0').filter(Boolean);
  if (!files.length) throw new Error('请先暂存需要提交的改动。');
  if (files.length > 2000 || names.length > 100_000) throw new Error('暂存文件过多，请缩小提交范围。');
  if (fingerprint !== (await readCommitFingerprint(cwd))) throw new Error('读取期间暂存内容已变化，请重新生成。');
  const sections = diff.split(/(?=^diff --git )/mu).filter(Boolean);
  const budget = 40_000;
  const perFile = Math.max(256, Math.min(8_000, Math.floor(budget / Math.max(1, sections.length))));
  let remaining = budget;
  let truncated = false;
  const stagedDiff = sections
    .map((section) => {
      const generated = /^diff --git .*\/(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|[^/\n]+\.(?:min\.js|map))(?=[ "\n])/u.test(section);
    const limit = generated ? 200 : Math.min(diff.length <= budget ? section.length : perFile, remaining);
      const text = section.slice(0, Math.max(0, limit));
      remaining = Math.max(0, remaining - text.length);
      if (text.length < section.length) truncated = true;
      return text.length < section.length ? `${text}\n[此文件逐行内容已省略或截断，参见文件列表和统计]\n` : text;
    })
    .join('');
  return {
    fingerprint,
    files,
    stagedDiff,
    diffStat: stat.slice(0, 20_000),
    truncated,
    recentCommits: history
      .split('\0')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((entry) => entry.slice(0, 1500)),
  };
}
