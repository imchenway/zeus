import { parse, resolve } from 'node:path';

const unsafeCodeMapScanRootMessage = 'Refusing to scan filesystem root. Choose a real project directory before generating the code graph.';

export class UnsafeCodeMapScanRootError extends Error {
  constructor() {
    super(unsafeCodeMapScanRootMessage);
    this.name = 'UnsafeCodeMapScanRootError';
  }
}

/** 防止 packaged App 以文件系统根目录为 cwd 时递归扫描整台机器。 */
export function isUnsafeCodeMapScanRoot(rootPath: string): boolean {
  const normalizedRoot = resolve(rootPath);
  return normalizedRoot === parse(normalizedRoot).root;
}

export function isUnsafeCodeMapScanRootError(error: unknown): error is UnsafeCodeMapScanRootError {
  return error instanceof UnsafeCodeMapScanRootError;
}
