import { execFile } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

/** 使用标准进程接口读取终端环境，程序参数始终单独传递。 */
const executeFile = promisify(execFile);

/**
 * Electron 从 Finder 启动时通常拿不到用户 shell 的 PATH；补齐 macOS 与用户级
 * 常见 CLI 目录，同时保留调用方已有顺序并去重。
 */
export function expandCliSearchPath(pathValue = process.env.PATH ?? ''): string {
  const home = homedir();
  const commonLocalBinaryDirectories = ['/opt/homebrew/bin', '/usr/local/bin', resolve(home, '.local/bin'), resolve(home, 'bin')];
  const entries = [...pathValue.split(delimiter).filter(Boolean), ...commonLocalBinaryDirectories];
  return Array.from(new Set(entries)).join(delimiter);
}

/** 首次启动读取用户终端的搜索目录，让检测、版本查询和实际运行使用同一环境。 */
export async function resolveCliSearchPath(pathValue = process.env.PATH ?? ''): Promise<string> {
  /** 终端不可用时仍沿用既有环境和常见安装目录。 */
  const fallbackPath = expandCliSearchPath(pathValue);
  try {
    /** 图形界面可能没有 SHELL，使用系统登记的用户终端补齐。 */
    const shellPath = process.env.SHELL?.trim() || userInfo().shell;
    if (!shellPath || !isAbsolute(shellPath)) return fallbackPath;
    /** 空字符分隔真实 PATH，隔离欢迎语；不读取或合并终端中的其他环境变量。 */
    const { stdout } = await executeFile(shellPath, ['-lic', 'printf "\\0%s\\0" "$PATH"'], {
      env: { ...process.env, PATH: fallbackPath },
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    });
    /** 仅接纳绝对目录，避免终端中的相对路径把工作目录当成程序来源。 */
    const shellDirectories = (stdout.split('\0').at(-2) ?? '').split(delimiter).filter(isAbsolute);
    return expandCliSearchPath([pathValue, ...shellDirectories].join(delimiter));
  } catch {
    // 终端配置错误或读取超时不能阻塞已有程序；实际启动仍会返回准确错误。
    return fallbackPath;
  }
}
