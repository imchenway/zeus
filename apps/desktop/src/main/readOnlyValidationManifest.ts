import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectReadOnlyValidationManifest, verifyReadOnlyValidationDescriptor } from '@zeus/local-server';
import type { ReadOnlyValidationDescriptor } from '@zeus/shared';

export const readOnlyValidationManifestEnvironmentName = 'ZEUS_READ_ONLY_VALIDATION_MANIFEST';

export function loadDesktopReadOnlyValidationDescriptor(input: {
  manifestPath: string | undefined;
  packaged: boolean;
  executablePath: string;
  /** 行为探针可显式提供隔离基座；生产启动固定由当前 Zeus Test 可执行文件派生。 */
  testIsolationBasePath?: string;
  /** 复制编排已知来源树时同步加入拒绝集合；manifest 自身不携带或证明该信任事实。 */
  sourceDataRoots?: readonly string[];
}): ReadOnlyValidationDescriptor | undefined {
  const configured = input.manifestPath?.trim();
  if (!configured) return undefined;
  const executablePath = resolve(input.executablePath);
  const executableName = basename(executablePath, extname(executablePath));
  const bundleId = readMacOSBundleIdentifier(executablePath, input.packaged);
  const descriptor = inspectReadOnlyValidationManifest(resolve(configured), {
    packaged: input.packaged,
    executableName,
    bundleId,
  });
  return assertDesktopReadOnlyValidationTrustBoundary(descriptor, {
    testIsolationBasePath: input.testIsolationBasePath ?? resolveDesktopTestDataRoot(executablePath),
    sourceDataRoots: input.sourceDataRoots,
  });
}

export function resolveDesktopTestDataRoot(executablePathInput: string, homeDirectory = homedir()): string {
  const executablePath = resolve(executablePathInput);
  const identityHash = createHash('sha256').update(executablePath).digest('hex').slice(0, 16);
  return join(resolve(homeDirectory), '.zeus-test', `instance-${identityHash}`);
}

/**
 * Electron profile 选址前的同步信任边界：只接受当前 Test 实例基座下、以 manifest runId
 * 命名的专用验证根。自签 manifest 仅检测误操作与竞态，不提供同用户攻击信任。
 */
export function assertDesktopReadOnlyValidationTrustBoundary(
  descriptor: ReadOnlyValidationDescriptor,
  input: {
    testIsolationBasePath: string;
    sourceDataRoots?: readonly string[];
    homeDirectory?: string;
    additionalForbiddenDataRoots?: readonly string[];
  },
): ReadOnlyValidationDescriptor {
  const homeDirectory = resolve(input.homeDirectory ?? homedir());
  const testIsolationBase = requireCanonicalPrivateDirectory(input.testIsolationBasePath, 'Zeus Test 隔离基座');
  const readOnlyValidationBase = requireCanonicalPrivateDirectory(join(testIsolationBase, 'read-only-validation'), '只读验证隔离基座');
  const expectedValidationRoot = join(readOnlyValidationBase, descriptor.runId);
  const validationRoot = requireCanonicalPrivateDirectory(descriptor.validationRoot, '只读 validationRoot');
  if (validationRoot !== expectedValidationRoot) {
    throw validationTrustError('validationRoot 必须严格位于当前 Zeus Test 隔离基座的 read-only-validation/<runId>。');
  }

  const productionAndLegacyRoots = [
    join(homeDirectory, '.zeus'),
    join(homeDirectory, '.zeus-development'),
    join(homeDirectory, 'Library', 'Application Support', '@zeus', 'desktop'),
    join(homeDirectory, 'Library', 'Application Support', 'Zeus'),
    descriptor.source.inferredDataRoot,
    dirname(descriptor.source.path),
    ...(input.additionalForbiddenDataRoots ?? []),
    ...(input.sourceDataRoots ?? []),
  ];
  for (const candidate of productionAndLegacyRoots) {
    const forbiddenRoot = canonicalizeExistingOrLexical(candidate);
    if (pathsOverlap(validationRoot, forbiddenRoot) || pathsOverlap(testIsolationBase, forbiddenRoot)) {
      throw validationTrustError(`只读验证隔离根与禁止的数据树重叠：${forbiddenRoot}`);
    }
  }
  return descriptor;
}

/** BrowserHost、Keychain、Provider 或 Detached Core 创建前再次做全库摘要与 schema 核验。 */
export async function verifyDesktopReadOnlyValidationDescriptor(descriptor: ReadOnlyValidationDescriptor): Promise<ReadOnlyValidationDescriptor> {
  return verifyReadOnlyValidationDescriptor(descriptor);
}

function readMacOSBundleIdentifier(executablePath: string, packaged: boolean): string {
  if (!packaged || process.platform !== 'darwin') throw validationApplicationError('只读验证只允许 macOS 打包 Zeus Test。');
  const bundlePath = findApplicationBundle(executablePath);
  const informationPropertyListPath = join(bundlePath, 'Contents', 'Info.plist');
  try {
    const value = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', informationPropertyListPath], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!value || value.length > 255) throw new Error('bundle id invalid');
    return value;
  } catch (error) {
    throw validationApplicationError('无法核验当前 Zeus Test 的 bundle ID。', error);
  }
}

function findApplicationBundle(executablePath: string): string {
  let candidate = dirname(executablePath);
  while (dirname(candidate) !== candidate) {
    if (candidate.endsWith('.app')) return candidate;
    candidate = dirname(candidate);
  }
  throw validationApplicationError('当前可执行文件不属于 macOS App bundle。');
}

function validationApplicationError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: 'ZEUS_READ_ONLY_VALIDATION_APPLICATION_MISMATCH',
    failClosed: true as const,
  });
}

function requireCanonicalPrivateDirectory(pathInput: string, label: string): string {
  if (!isAbsolute(pathInput) || resolve(pathInput) !== pathInput) throw validationTrustError(`${label} 必须是规范绝对路径。`);
  const stats = lstatSync(pathInput, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw validationTrustError(`${label} 必须是普通目录且不能是符号链接。`);
  if ((stats.mode & 0o077n) !== 0n) throw validationTrustError(`${label} 权限范围过宽。`);
  if (typeof process.getuid === 'function' && stats.uid !== BigInt(process.getuid())) throw validationTrustError(`${label} 不属于当前用户。`);
  const canonical = realpathSync(pathInput);
  if (canonical !== pathInput) throw validationTrustError(`${label} 不是规范真实路径。`);
  return canonical;
}

function canonicalizeExistingOrLexical(pathInput: string): string {
  const canonicalInput = resolve(pathInput);
  return existsSync(canonicalInput) ? realpathSync(canonicalInput) : canonicalInput;
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function containsPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function validationTrustError(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'ZEUS_READ_ONLY_VALIDATION_TRUST_ROOT_MISMATCH' as const,
    failClosed: true as const,
  });
}
