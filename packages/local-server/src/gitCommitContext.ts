import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { discoverGitRepositories } from '@zeus/git-core';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

const execute = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execute('git', args, { cwd, timeout: 15_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;

/** 只解析项目内已发现的仓库，不接受客户端任意工作目录。 */
export async function resolveCommitRepository(project: { id: string; localPath: string }, repositoryId: string, relativePath?: string) {
  if (relativePath !== undefined) {
    if (!relativePath || isAbsolute(relativePath) || relativePath.split('/').includes('..')) throw new Error('仓库路径无效。');
    const root = await realpath(project.localPath);
    const localPath = await realpath(resolve(root, relativePath));
    const actual = relative(root, localPath);
    if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw new Error('仓库不在当前项目内。');
    const normalized = actual.split(sep).join('/') || '.';
    const expectedId = `project_git_repository_${createHash('sha256').update(`${project.id}\0${normalized}`).digest('hex').slice(0, 24)}`;
    if (repositoryId !== expectedId || (await realpath((await git(localPath, ['rev-parse', '--show-toplevel'])).trim())) !== localPath) throw new Error('当前仓库标识或路径已变化，请刷新工作台。');
    return { localPath, name: basename(localPath) };
  }
  const repositories = await discoverGitRepositories(project.localPath);
  const repository = repositories.find((item) => `project_git_repository_${createHash('sha256').update(`${project.id}\0${item.relativePath}`).digest('hex').slice(0, 24)}` === repositoryId);
  if (!repository) throw new Error('当前仓库已不可用。');
  return repository;
}

export async function readCommitFingerprint(cwd: string): Promise<string> {
  // 对象ID覆盖二进制内容，stage和mode覆盖冲突与权限变化；不重复生成完整补丁。
  const [index, head] = await Promise.all([git(cwd, ['ls-files', '--stage', '-z']), readHead(cwd)]);
  return createHash('sha256').update(head).update('\0').update(index).digest('hex');
}

async function readHead(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return '';
    throw error;
  }
}

const historyCache = new Map<string, { head: string; messages: string[] }>();
async function readCommitStyle(cwd: string): Promise<string[]> {
  const head = await readHead(cwd);
  if (!head) return [];
  const cached = historyCache.get(cwd);
  if (cached?.head === head) return cached.messages;
  const raw = await git(cwd, ['log', '-20', '--no-merges', '--format=%s%x1f%b%x00']);
  const messages = raw
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [title = '', body = ''] = entry.split('\x1f');
      return title.slice(0, 180) + (index < 3 && body.trim() ? `\n${body.trim().slice(0, 450)}` : '');
    });
  if (historyCache.size >= 32) historyCache.delete(historyCache.keys().next().value!);
  historyCache.set(cwd, { head, messages });
  return messages;
}

export async function readGitCommitContext(cwd: string) {
  const fingerprint = await readCommitFingerprint(cwd);
  const [names, stat, diff, history] = await Promise.all([
    git(cwd, ['diff', '--cached', '--name-only', '-z']),
    git(cwd, ['diff', '--cached', '--numstat', '--no-ext-diff', '--no-textconv']),
    git(cwd, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', '.', ...['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', '*.min.js', '*.map'].map((pattern) => `:(exclude,glob)**/${pattern}`)]),
    readCommitStyle(cwd),
  ]);
  const files = names.split('\0').filter(Boolean);
  if (!files.length) throw new Error('请先暂存需要提交的改动。');
  if (files.length > 2000 || names.length > 100_000) throw new Error('暂存文件过多，请缩小提交范围。');
  if (fingerprint !== (await readCommitFingerprint(cwd))) throw new Error('读取期间暂存内容已变化，请重新生成。');
  const sections = diff.split(/(?=^diff --git )/mu).filter(Boolean);
  const budget = 40_000;
  const perFile = Math.max(256, Math.min(8_000, Math.floor(budget / Math.max(1, sections.length))));
  let remaining = budget;
  let truncated = files.some((file) => /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|[^/]+\.(?:min\.js|map))$/u.test(file));
  const stagedDiff = sections
    .map((section) => {
      const generated = /^diff --git .*\/(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|[^/\n]+\.(?:min\.js|map))(?=[ "\n])/u.test(section);
      const limit = generated ? 200 : Math.min(diff.length <= budget ? section.length : perFile, remaining);
      // 优先保留完整代码块；单块过大才按完整行截断，避免半行代码误导摘要。
      let text = '';
      for (const hunk of section.split(/(?=^@@ )/mu)) {
        if (text.length + hunk.length <= limit) {
          text += hunk;
          continue;
        }
        if (!text.includes('@@ ')) {
          const partial = hunk.slice(0, Math.max(0, limit - text.length));
          text += partial.slice(0, Math.max(0, partial.lastIndexOf('\n') + 1));
        }
        break;
      }
      remaining = Math.max(0, remaining - text.length);
      if (text.length < section.length) truncated = true;
      return text.length < section.length ? `${text}\n[此文件逐行内容已省略或截断，参见文件列表和统计]\n` : text;
    })
    .join('');
  return {
    fingerprint,
    files,
    stagedDiff: stagedDiff || '[逐行内容已省略，请仅根据文件列表和变更统计生成描述。]',
    diffStat: stat.slice(0, 20_000),
    truncated,
    recentCommits: history,
  };
}
