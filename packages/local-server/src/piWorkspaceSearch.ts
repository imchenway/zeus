import { execFile } from 'node:child_process';
import { relative } from 'node:path';
import { promisify } from 'node:util';

/** 使用参数数组执行搜索，用户的表达式和路径不能成为命令选项。 */
const execFileAsync = promisify(execFile);
/** 搜索收集阶段也有界，避免先抓取数 MiB 再裁剪给模型。 */
const maximumSearchBytes = 64 * 1024;

/** 搜索先定位文件；需要内容时显式展开，执行错误不能伪装成没有匹配。 */
export async function searchPiWorkspace(input: { cwd: string; path: string; tool: 'grep' | 'find'; args: Record<string, unknown>; signal?: AbortSignal }): Promise<string> {
  if (typeof input.args.pattern !== 'string') throw new Error('搜索内容必须是字符串。');
  /** 默认仅列文件名，减少搜索阶段不必要的正文。 */
  const mode = input.args.outputMode ?? 'files';
  if (mode !== 'files' && mode !== 'content') throw new Error('搜索输出方式只能是 files 或 content。');
  if (input.args.glob !== undefined && typeof input.args.glob !== 'string') throw new Error('文件筛选必须是字符串。');
  /** 内容模式按每个文件限制命中数，返回说明明确该范围。 */
  const limit = input.args.limit ?? 50;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('每文件匹配上限必须是 1 到 200 的整数。');
  /** 路径已由调用方校验权限，输出使用工作区相对路径，减少重复前缀。 */
  const searchPath = relative(input.cwd, input.path) || '.';
  /** --regexp、--glob 的值和末尾路径都明确与命令选项分隔。 */
  const args =
    input.tool === 'grep'
      ? [
          '--hidden',
          '--color=never',
          '--glob',
          '!.git',
          ...(input.args.glob ? ['--glob', input.args.glob as string] : []),
          ...(mode === 'files' ? ['--files-with-matches'] : ['--line-number', '--with-filename', `--max-count=${limit}`, '--max-columns=300', '--max-columns-preview']),
          '--regexp',
          input.args.pattern,
          '--',
          searchPath,
        ]
      : ['--files', '--glob', input.args.pattern, '--', searchPath];
  /** 成功结果或带有明确截断标记的已收集部分；不重放搜索。 */
  let output: string;
  try {
    output = (await execFileAsync('rg', args, { cwd: input.cwd, timeout: 30_000, maxBuffer: maximumSearchBytes, signal: input.signal })).stdout;
  } catch (error) {
    /** ripgrep 仅退出码 1 表示正常的零匹配；语法错误、超时和路径错误继续上报。 */
    const failure = error as { code?: unknown; stdout?: unknown; message?: unknown };
    if (failure.code === 1) return '没有匹配结果。';
    if (failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || failure.message !== 'stdout maxBuffer length exceeded' || typeof failure.stdout !== 'string') throw error;
    // 收集不完整必须在首屏可见，分页只能恢复已收集的部分。
    output = `[搜索输出达到 64 KiB 收集上限，结果不完整；分页仅能读取已收集部分。请缩小 path、glob 或搜索表达式。]\n${failure.stdout}`;
  }
  /** 正文模式说明逐文件限额与长行预览，避免把截断结果当作全部命中。 */
  const note = input.tool === 'grep' && mode === 'content' ? `[每文件最多 ${limit} 条匹配；长行只展示 300 列预览。]\n` : '';
  return output.trim() ? `${note}${output.trim()}` : '没有匹配结果。';
}
