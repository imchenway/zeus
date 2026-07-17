import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

const PINNED_CODEX_VERSION = '0.144.2';
const PINNED_CODEX_COMMIT = 'a6645b6b8a656360fa16fb7e1c6721d0697d3d6a';

interface CodexRuntimeManifest {
  upstreamCommit: string;
  binaryVersion: string;
  arch: string;
  sha256: string;
  patches: string[];
}

export interface ResolveCodexRuntimePathOptions {
  isPackaged: boolean;
  resourcesPath: string;
  projectRoot: string;
  arch: NodeJS.Architecture;
}

export async function resolveCodexRuntimePath(options: ResolveCodexRuntimePathOptions): Promise<string> {
  const directory = options.isPackaged ? join(options.resourcesPath, 'codex') : join(options.projectRoot, '.tmp', 'codex-runtime', runtimeDirectoryName(options.arch));
  const binaryPath = join(directory, 'codex');
  const manifestPath = join(directory, 'manifest.json');
  let bytes: Buffer;
  let manifest: CodexRuntimeManifest;
  try {
    await access(binaryPath, constants.R_OK | constants.X_OK);
    bytes = await readFile(binaryPath);
    manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);
  } catch (error) {
    if (hasRuntimeCode(error)) throw error;
    throw runtimeError('ZEUS_CODEX_RUNTIME_UNAVAILABLE', `Bundled Codex runtime is unavailable at ${binaryPath}.`);
  }
  if (manifest.binaryVersion !== PINNED_CODEX_VERSION || manifest.upstreamCommit !== PINNED_CODEX_COMMIT) {
    throw runtimeError('ZEUS_CODEX_RUNTIME_VERSION_MISMATCH', `Bundled Codex runtime must be ${PINNED_CODEX_VERSION} from ${PINNED_CODEX_COMMIT}.`);
  }
  const expectedTarget = options.arch === 'x64' ? 'x86_64-apple-darwin' : 'aarch64-apple-darwin';
  if (manifest.arch !== expectedTarget) throw runtimeError('ZEUS_CODEX_RUNTIME_ARCH_MISMATCH', `Bundled Codex runtime architecture mismatch: expected ${expectedTarget}.`);
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== manifest.sha256) throw runtimeError('ZEUS_CODEX_RUNTIME_CHECKSUM_MISMATCH', 'Bundled Codex runtime checksum does not match its build manifest.');
  if (!manifest.patches.includes('patches/0001-zeus-legacy-session-source.patch')) {
    throw runtimeError('ZEUS_CODEX_RUNTIME_PATCH_MISMATCH', 'Bundled Codex runtime manifest does not include the Zeus external-agent-home patch.');
  }
  return realpath(binaryPath);
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
    patches: value.patches,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasRuntimeCode(value: unknown): value is { code: string } {
  return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string' && (value as { code: string }).code.startsWith('ZEUS_CODEX_RUNTIME_');
}

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
