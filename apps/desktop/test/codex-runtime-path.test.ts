import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCodexRuntimePath } from '../src/main/codexRuntimePath.js';

async function writeRuntime(directory: string, input: { version?: string; sha256?: string; arch?: string } = {}): Promise<string> {
  await mkdir(directory, { recursive: true });
  const binaryPath = join(directory, 'codex');
  const bytes = Buffer.from('#!/bin/sh\necho codex\n');
  await writeFile(binaryPath, bytes);
  await chmod(binaryPath, 0o755);
  await writeFile(
    join(directory, 'manifest.json'),
    `${JSON.stringify({
      upstreamCommit: 'a6645b6b8a656360fa16fb7e1c6721d0697d3d6a',
      binaryVersion: input.version ?? '0.144.2',
      rustToolchainVersion: '1.95.0',
      normalizedCargoLockSha256: 'a'.repeat(64),
      arch: input.arch ?? 'aarch64-apple-darwin',
      sha256: input.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
      protocolSchemaSha256: 'b'.repeat(64),
      patches: ['patches/0001-zeus-legacy-session-source.patch'],
    })}\n`,
  );
  return binaryPath;
}

describe('bundled Codex runtime path', () => {
  it('uses Resources/codex/codex in packaged builds and verifies the pinned manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zeus-packaged-codex-'));
    try {
      const expected = await writeRuntime(join(root, 'codex'));
      await expect(resolveCodexRuntimePath({ isPackaged: true, resourcesPath: root, projectRoot: '/ignored', arch: 'arm64' })).resolves.toBe(await realpath(expected));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses only the explicit development build manifest and rejects missing or mismatched binaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zeus-development-codex-'));
    try {
      const expected = await writeRuntime(join(root, '.tmp', 'codex-runtime', 'arm64'));
      await expect(resolveCodexRuntimePath({ isPackaged: false, resourcesPath: '/ignored', projectRoot: root, arch: 'arm64' })).resolves.toBe(await realpath(expected));

      await writeRuntime(join(root, '.tmp', 'codex-runtime', 'arm64'), { version: '0.145.0' });
      await expect(resolveCodexRuntimePath({ isPackaged: false, resourcesPath: '/ignored', projectRoot: root, arch: 'arm64' })).rejects.toMatchObject({ code: 'ZEUS_CODEX_RUNTIME_VERSION_MISMATCH' });

      await writeRuntime(join(root, '.tmp', 'codex-runtime', 'arm64'), { sha256: '0'.repeat(64) });
      await expect(resolveCodexRuntimePath({ isPackaged: false, resourcesPath: '/ignored', projectRoot: root, arch: 'arm64' })).rejects.toMatchObject({ code: 'ZEUS_CODEX_RUNTIME_CHECKSUM_MISMATCH' });

      await rm(join(root, '.tmp'), { recursive: true, force: true });
      await expect(resolveCodexRuntimePath({ isPackaged: false, resourcesPath: '/ignored', projectRoot: root, arch: 'arm64' })).rejects.toMatchObject({ code: 'ZEUS_CODEX_RUNTIME_UNAVAILABLE' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
