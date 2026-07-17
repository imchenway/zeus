import { homedir } from 'node:os';
import { delimiter, resolve } from 'node:path';

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
