import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

/**
 * 将数据根统一到真实绝对路径，同时保留对“数据根本身是符号链接”的拒绝。
 * 允许父路径使用 macOS `/tmp` 这类系统别名；尚不存在的尾部路径会拼回真实父目录。
 */
export function canonicalizeZeusDataRootPath(rootPath: string): string {
  if (!isAbsolute(rootPath)) throw dataRootPathError('ZEUS_DATA_ROOT_PATH_DRIFT', 'Zeus 数据根必须是绝对路径。');
  /** 先消除 `.`、`..` 和多余分隔符，再判断最终目录项本身是否为符号链接。 */
  const normalized = resolve(rootPath);
  try {
    if (lstatSync(normalized).isSymbolicLink()) {
      throw dataRootPathError('ZEUS_DATA_ROOT_PATH_UNSAFE', `Zeus 数据根本身不能是符号链接：${normalized}`);
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }

  /** 从最深的已存在父路径开始取真实路径，兼容尚未创建的数据根。 */
  let existingAncestor = normalized;
  /** 保存不存在的尾部路径，待父路径规范化后原序拼回。 */
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  /** 已存在祖先可能经过 `/tmp` 等系统符号链接，真实路径才是后续唯一身份。 */
  const canonicalAncestor = existsSync(existingAncestor) ? realpathSync.native(existingAncestor) : existingAncestor;
  return resolve(canonicalAncestor, ...missingSegments);
}

/** 创建可跨 Electron IPC 保留错误码的数据根路径错误。 */
function dataRootPathError(code: 'ZEUS_DATA_ROOT_PATH_DRIFT' | 'ZEUS_DATA_ROOT_PATH_UNSAFE', message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code, failClosed: true as const });
}
