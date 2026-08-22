import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface TestDataRootIsolationInput {
  requestedRoot: string;
  homeDirectory: string;
  appDataDirectory: string;
}

/**
 * Zeus Test 没有只读 manifest 时仍是可写应用，因此必须先与正式/历史数据根隔离。
 * 对已存在的父路径做 realpath 规范化，防止符号链接绕过文本路径比较。
 */
export function assertTestDataRootIsolation(input: TestDataRootIsolationInput): string {
  if (!isAbsolute(input.requestedRoot)) throw isolationError('Zeus Test 数据根必须是绝对路径。');
  const requested = canonicalizePotentialPath(input.requestedRoot);
  const canonicalHome = canonicalizePotentialPath(input.homeDirectory);
  if (sameOrInside(canonicalHome, requested)) throw isolationError(`Zeus Test 数据根不能是用户主目录或其上级目录：${requested}`);
  const protectedRoots = [join(input.homeDirectory, '.zeus'), join(input.appDataDirectory, '@zeus', 'desktop'), join(input.appDataDirectory, 'Zeus')].map(canonicalizePotentialPath);
  const conflicting = protectedRoots.find((protectedRoot) => pathsOverlap(requested, protectedRoot));
  if (conflicting) {
    throw isolationError(`Zeus Test 数据根与正式或历史数据路径重叠：${requested}`);
  }
  return requested;
}

function canonicalizePotentialPath(value: string): string {
  const normalized = resolve(value);
  let cursor = normalized;
  const missingSegments: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  const existingBase = existsSync(cursor) ? realpathSync.native(cursor) : cursor;
  return resolve(existingBase, ...missingSegments);
}

function pathsOverlap(left: string, right: string): boolean {
  return sameOrInside(left, right) || sameOrInside(right, left);
}

function sameOrInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const nested = relative(root, candidate);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

function isolationError(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'ZEUS_TEST_DATA_ROOT_NOT_ISOLATED' as const,
    failClosed: true as const,
  });
}
