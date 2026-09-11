import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

/** Git 只执行文件枚举和独立文件比较，不修改用户索引或历史。 */
const runGit = promisify(execFile);

/** 本轮开始或结束时实际读取到的文件内容；超限文件只保留身份并禁止恢复。 */
export interface TurnWorkspaceFile {
  exists: boolean;
  bytes: Buffer | null;
  hash: string | null;
  mode: number | null;
  unavailableReason: string | null;
}

/** 单文件和整轮内容的读取上限沿用变更恢复服务配置。 */
export interface TurnWorkspaceLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
}

/** 清除可能把 Git 定向到另一仓库的环境变量。 */
function workspaceGitEnvironment(): NodeJS.ProcessEnv {
  /** 子进程只读，不获取可选的索引写锁。 */
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  return env;
}

/** 读取本执行目录内受 Git 管理及未忽略的新文件；不扫描依赖、产物或目录外内容。 */
export async function readTurnWorkspaceSnapshot(root: string, limits: TurnWorkspaceLimits): Promise<Map<string, TurnWorkspaceFile>> {
  /** 真实根目录用于拒绝符号链接逃逸。 */
  const canonicalRoot = await realpath(root);
  /** NUL 分隔保留空格、换行及非 ASCII 文件名。 */
  const listed = await runGit('git', ['-C', canonicalRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], {
    env: workspaceGitEnvironment(),
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  /** 排序去重让索引冲突和多阶段记录不会重复计数。 */
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort();
  // ponytail: 单轮最多扫描两万个 Git 文件；超大仓库需分块快照后再提高上限。
  if (paths.length > 20_000) throw new Error('工作目录文件过多，无法完整记录本轮变化。');
  /** 快照内容总量受恢复容量约束。 */
  let retainedBytes = 0;
  /** 快照包含缺失的已跟踪文件，便于识别重新创建。 */
  const files = new Map<string, TurnWorkspaceFile>();
  for (const path of paths) {
    /** 枚举结果也必须通过目录边界校验。 */
    const absolute = resolve(canonicalRoot, path);
    /** 相对路径不能回到根目录外或指向 Git 元数据。 */
    const local = relative(canonicalRoot, absolute);
    if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || local.split(sep).includes('.git')) throw new Error('文件快照路径超出执行目录。');
    try {
      /** 拒绝跟随非普通文件及符号链接。 */
      const stat = await lstat(absolute);
      if (!stat.isFile()) throw new Error('非普通文件暂不支持本轮快照。');
      /** 已跟踪目录被替换成符号链接时也不能读取目录外内容。 */
      const target = relative(canonicalRoot, await realpath(absolute));
      if (isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`)) throw new Error('文件快照路径解析到执行目录外。');
      if (stat.size > limits.maxFileBytes) {
        files.set(path, { exists: true, bytes: null, hash: `unavailable:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, mode: stat.mode & 0o777, unavailableReason: '文件超过本轮快照大小上限，不能安全恢复。' });
        continue;
      }
      /** 内容哈希用于识别真实变化；超过总容量后不再保留恢复正文。 */
      const bytes = await readFile(absolute);
      /** 大小可能在读取期间变化，保存前再次检查上限。 */
      const retain = bytes.length <= limits.maxFileBytes && retainedBytes + bytes.length <= limits.maxTotalBytes;
      files.set(path, { exists: true, bytes: retain ? bytes : null, hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, mode: stat.mode & 0o777, unavailableReason: retain ? null : '本轮快照超过恢复容量，不能安全恢复。' });
      if (retain) retainedBytes += bytes.length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') files.set(path, { exists: false, bytes: null, hash: null, mode: null, unavailableReason: null });
      else throw error;
    }
  }
  return files;
}

/** 使用 Git 自身的文本差异算法，保留准确行数与无末尾换行语义。 */
export async function diffTurnWorkspaceFile(path: string, before: TurnWorkspaceFile, after: TurnWorkspaceFile): Promise<string> {
  /** 路径始终引用执行目录，不泄露临时快照目录。 */
  const oldName = JSON.stringify(`a/${path}`);
  /** 新路径与旧路径分开表示新增、删除。 */
  const newName = JSON.stringify(`b/${path}`);
  /** 文件模式使用 Git 的标准表示。 */
  const mode = (value: number | null): string => `100${(value ?? 0o644).toString(8)}`;
  /** 元信息独立于临时文件权限。 */
  const header = `diff --git ${oldName} ${newName}\n${!before.exists ? `new file mode ${mode(after.mode)}\n` : !after.exists ? `deleted file mode ${mode(before.mode)}\n` : before.mode !== after.mode ? `old mode ${mode(before.mode)}\nnew mode ${mode(after.mode)}\n` : ''}`;
  if (before.hash === after.hash) return header;
  if ((before.exists && !before.bytes) || (after.exists && !after.bytes)) return header;
  /** 空文件同时代表新增前和删除后的缺失状态。 */
  const pre = before.bytes ?? Buffer.alloc(0);
  /** 仅 UTF-8 文本生成可审阅文本差异。 */
  const post = after.bytes ?? Buffer.alloc(0);
  if (!isUtf8(pre) || !isUtf8(post) || pre.includes(0) || post.includes(0)) return `${header}Binary files ${oldName} and ${newName} differ\n`;
  /** 临时文件仅服务一次比较，结束后必须移除。 */
  const directory = await mkdtemp(join(tmpdir(), 'zeus-turn-diff-'));
  try {
    await Promise.all([writeFile(join(directory, 'before'), pre, { mode: 0o600 }), writeFile(join(directory, 'after'), post, { mode: 0o600 })]);
    /** Git 差异返回 1 表示发现变化，不是执行失败。 */
    const result = await runGit('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--', 'before', 'after'], {
      cwd: directory,
      env: workspaceGitEnvironment(),
      timeout: 10_000,
      maxBuffer: 48 * 1024 * 1024,
    }).catch((error) => {
      if (error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout };
      throw error;
    });
    /** 只替换路径头，保留 Git 生成的原始差异块。 */
    const hunkStart = result.stdout.indexOf('@@ ');
    return hunkStart < 0 ? header : `${header}--- ${before.exists ? oldName : '/dev/null'}\n+++ ${after.exists ? newName : '/dev/null'}\n${result.stdout.slice(hunkStart)}`;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
