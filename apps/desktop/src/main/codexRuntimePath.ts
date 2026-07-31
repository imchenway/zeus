import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, copyFile, mkdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

interface CodexRuntimeManifest {
  upstreamCommit: string;
  binaryVersion: string;
  arch: string;
  sha256: string;
  codeSha256?: string;
  patches: string[];
}

interface CodexRuntimeLock {
  commit: string;
  binaryVersion: string;
  arches: string[];
  patches: string[];
}

export interface ResolvedCodexRuntime {
  commandPath: string;
  binaryVersion: string;
  upstreamCommit: string;
  artifactSha256: string;
}

export interface ResolveCodexRuntimeOptions {
  isPackaged: boolean;
  resourcesPath: string;
  projectRoot: string;
  arch: NodeJS.Architecture;
}

export async function resolveCodexRuntime(options: ResolveCodexRuntimeOptions): Promise<ResolvedCodexRuntime> {
  const directory = options.isPackaged ? join(options.resourcesPath, 'codex') : join(options.projectRoot, '.tmp', 'codex-runtime', runtimeDirectoryName(options.arch));
  const binaryPath = join(directory, 'codex');
  const manifestPath = join(directory, 'manifest.json');
  const lockPath = options.isPackaged ? join(directory, 'runtime.lock.json') : join(options.projectRoot, 'third_party', 'openai-codex', 'runtime.lock.json');
  let bytes: Buffer;
  let manifest: CodexRuntimeManifest;
  let lock: CodexRuntimeLock;
  try {
    await access(binaryPath, constants.R_OK | constants.X_OK);
    bytes = await readFile(binaryPath);
    manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);
    lock = parseLock(JSON.parse(await readFile(lockPath, 'utf8')) as unknown);
  } catch (error) {
    if (hasRuntimeCode(error)) throw error;
    throw runtimeError('ZEUS_CODEX_RUNTIME_UNAVAILABLE', `Bundled Codex runtime is unavailable at ${binaryPath}.`);
  }
  if (manifest.binaryVersion !== lock.binaryVersion || manifest.upstreamCommit !== lock.commit) {
    throw runtimeError('ZEUS_CODEX_RUNTIME_VERSION_MISMATCH', `Bundled Codex runtime must be ${lock.binaryVersion} from ${lock.commit}.`);
  }
  const expectedTarget = options.arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin';
  if (!lock.arches.includes(expectedTarget)) throw runtimeError('ZEUS_CODEX_RUNTIME_ARCH_UNSUPPORTED', `Pinned Codex runtime does not support architecture: ${expectedTarget}.`);
  if (manifest.arch !== expectedTarget) throw runtimeError('ZEUS_CODEX_RUNTIME_ARCH_MISMATCH', `Bundled Codex runtime architecture mismatch: expected ${expectedTarget}.`);
  const actualSha256 = options.isPackaged ? machoSignatureNeutralSha256(bytes) : createHash('sha256').update(bytes).digest('hex');
  const expectedSha256 = options.isPackaged ? manifest.codeSha256 : manifest.sha256;
  if (typeof expectedSha256 !== 'string') throw runtimeError('ZEUS_CODEX_RUNTIME_MANIFEST_INVALID', 'Bundled Codex runtime manifest is missing its signed-code checksum.');
  if (actualSha256 !== expectedSha256) throw runtimeError('ZEUS_CODEX_RUNTIME_CHECKSUM_MISMATCH', 'Bundled Codex runtime checksum does not match its build manifest.');
  if (manifest.patches.length !== lock.patches.length || manifest.patches.some((patch, index) => patch !== lock.patches[index])) {
    throw runtimeError('ZEUS_CODEX_RUNTIME_PATCH_MISMATCH', 'Bundled Codex runtime patches do not match the pinned runtime lock.');
  }
  return {
    commandPath: await realpath(binaryPath),
    binaryVersion: manifest.binaryVersion,
    upstreamCommit: manifest.upstreamCommit,
    artifactSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * 把已经验签的运行时复制到用户数据目录中的不可变内容地址。
 * 执行宿主只启动该副本，应用包被安装器替换后，旧世代仍能继续运行和按需重启。
 */
export async function materializeCodexRuntime(runtime: ResolvedCodexRuntime, userDataPath: string): Promise<ResolvedCodexRuntime> {
  const runtimeDirectory = join(userDataPath, 'execution-host', 'runtimes', runtime.artifactSha256);
  const targetPath = join(runtimeDirectory, 'codex');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);
  try {
    const existingBytes = await readFile(targetPath);
    if (createHash('sha256').update(existingBytes).digest('hex') !== runtime.artifactSha256) {
      throw runtimeError('ZEUS_CODEX_RUNTIME_MATERIALIZATION_MISMATCH', 'Materialized Codex runtime checksum does not match its verified source.');
    }
    await chmod(targetPath, 0o700);
    return { ...runtime, commandPath: await realpath(targetPath) };
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }

  const temporaryPath = join(runtimeDirectory, `.codex-${randomUUID()}.tmp`);
  try {
    await copyFile(runtime.commandPath, temporaryPath, constants.COPYFILE_EXCL);
    await chmod(temporaryPath, 0o700);
    const copiedBytes = await readFile(temporaryPath);
    if (createHash('sha256').update(copiedBytes).digest('hex') !== runtime.artifactSha256) {
      throw runtimeError('ZEUS_CODEX_RUNTIME_MATERIALIZATION_MISMATCH', 'Copied Codex runtime checksum does not match its verified source.');
    }
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o700);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
  }
  return { ...runtime, commandPath: await realpath(targetPath) };
}

function runtimeDirectoryName(arch: NodeJS.Architecture): 'arm64' | 'x64' {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'x64';
  throw runtimeError('ZEUS_CODEX_RUNTIME_ARCH_UNSUPPORTED', `Unsupported Codex runtime architecture: ${arch}.`);
}

function parseManifest(value: unknown): CodexRuntimeManifest {
  if (
    !isRecord(value) ||
    typeof value.upstreamCommit !== 'string' ||
    typeof value.binaryVersion !== 'string' ||
    typeof value.arch !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !Array.isArray(value.patches) ||
    !value.patches.every((patch) => typeof patch === 'string')
  ) {
    throw runtimeError('ZEUS_CODEX_RUNTIME_MANIFEST_INVALID', 'Bundled Codex runtime manifest is invalid.');
  }
  return {
    upstreamCommit: value.upstreamCommit,
    binaryVersion: value.binaryVersion,
    arch: value.arch,
    sha256: value.sha256,
    codeSha256: typeof value.codeSha256 === 'string' ? value.codeSha256 : undefined,
    patches: value.patches,
  };
}

/**
 * 计算不受 macOS 重签名影响的 Mach-O 内容摘要。
 * 摘要保留签名区之前的全部代码与链接数据，只归零签名会改写的 __LINKEDIT 大小和签名命令字段。
 */
function machoSignatureNeutralSha256(binary: Buffer): string {
  const headerSize = 32;
  if (binary.length < headerSize || binary.readUInt32LE(0) !== 0xfeedfacf) {
    throw runtimeError('ZEUS_CODEX_RUNTIME_CHECKSUM_MISMATCH', 'Bundled Codex runtime is not a supported 64-bit little-endian Mach-O file.');
  }

  const commandCount = binary.readUInt32LE(16);
  const commandEnd = headerSize + binary.readUInt32LE(20);
  if (commandEnd > binary.length) throw runtimeError('ZEUS_CODEX_RUNTIME_CHECKSUM_MISMATCH', 'Bundled Codex runtime contains invalid Mach-O load commands.');

  let commandOffset = headerSize;
  let codeSignatureOffset: number | undefined;
  let codeSignatureDataOffset: number | undefined;
  let linkEditOffset: number | undefined;
  for (let index = 0; index < commandCount; index += 1) {
    if (commandOffset + 8 > commandEnd) throw runtimeError('ZEUS_CODEX_RUNTIME_CHECKSUM_MISMATCH', 'Bundled Codex runtime contains incomplete Mach-O load commands.');
    const command = binary.readUInt32LE(commandOffset);
    const commandSize = binary.readUInt32LE(commandOffset + 4);
    if (commandSize < 8 || commandOffset + commandSize > commandEnd) {
      throw runtimeError('ZEUS_CODEX_RUNTIME_CHECKSUM_MISMATCH', 'Bundled Codex runtime contains an invalid Mach-O load command.');
    }
    if (command === 0x19 && commandSize >= 72) {
      const segmentName = binary
        .subarray(commandOffset + 8, commandOffset + 24)
        .toString('ascii')
        .replace(/\0.*$/u, '');
      if (segmentName === '__LINKEDIT') linkEditOffset = commandOffset;
    }
    if (command === 0x1d && commandSize >= 16) {
      codeSignatureOffset = commandOffset;
      codeSignatureDataOffset = binary.readUInt32LE(commandOffset + 8);
    }
    commandOffset += commandSize;
  }

  if (linkEditOffset === undefined || codeSignatureOffset === undefined || codeSignatureDataOffset === undefined || codeSignatureDataOffset < commandEnd || codeSignatureDataOffset > binary.length) {
    throw runtimeError('ZEUS_CODEX_RUNTIME_CHECKSUM_MISMATCH', 'Bundled Codex runtime is missing a valid Mach-O signature structure.');
  }

  const normalized = Buffer.from(binary.subarray(0, codeSignatureDataOffset));
  normalized.fill(0, linkEditOffset + 32, linkEditOffset + 40);
  normalized.fill(0, linkEditOffset + 48, linkEditOffset + 56);
  normalized.fill(0, codeSignatureOffset + 8, codeSignatureOffset + 16);
  return createHash('sha256').update(normalized).digest('hex');
}

function parseLock(value: unknown): CodexRuntimeLock {
  if (
    !isRecord(value) ||
    typeof value.commit !== 'string' ||
    typeof value.binaryVersion !== 'string' ||
    !Array.isArray(value.arches) ||
    !value.arches.every((arch) => typeof arch === 'string') ||
    !Array.isArray(value.patches) ||
    !value.patches.every((patch) => typeof patch === 'string')
  ) {
    throw runtimeError('ZEUS_CODEX_RUNTIME_LOCK_INVALID', 'Pinned Codex runtime lock is invalid.');
  }
  return {
    commit: value.commit,
    binaryVersion: value.binaryVersion,
    arches: value.arches,
    patches: value.patches,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasRuntimeCode(value: unknown): value is { code: string } {
  return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string' && (value as { code: string }).code.startsWith('ZEUS_CODEX_RUNTIME_');
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && (value as NodeJS.ErrnoException).code === code;
}

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
