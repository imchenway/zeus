import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Codex Rust runtime supply', () => {
  it('pins the exact Codex App compatible upstream release and commit', () => {
    const lockPath = join(process.cwd(), 'third_party', 'openai-codex', 'runtime.lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      repository: string;
      tag: string;
      tagObject: string;
      commit: string;
      sourceArchive: { url: string; sha256: string };
      rustToolchain: {
        version: string;
        components: Record<string, Record<string, { url: string; sha256: string }>>;
      };
      normalizedCargoLock: { fromVersion: string; toVersion: string; replacements: number; sha256: string };
      binaryVersion: string;
      arches: string[];
      patches: string[];
      license: string;
    };

    expect(lock).toEqual({
      repository: 'https://github.com/openai/codex.git',
      tag: 'rust-v0.144.2',
      tagObject: '06eee5f70addf0b8cf331d5c6721f0414e7d2ae6',
      commit: 'a6645b6b8a656360fa16fb7e1c6721d0697d3d6a',
      sourceArchive: {
        url: 'https://codeload.github.com/openai/codex/tar.gz/a6645b6b8a656360fa16fb7e1c6721d0697d3d6a',
        sha256: 'a18d8d1ab77fa7dab9636ce679f812f884dfaddfad9a3ee830bf9ff64a4594e7',
      },
      rustToolchain: {
        version: '1.95.0',
        components: {
          rustc: {
            'aarch64-apple-darwin': {
              url: 'https://static.rust-lang.org/dist/rustc-1.95.0-aarch64-apple-darwin.tar.xz',
              sha256: '149e85a285b6eba58eb6c8bdf7deb1b93763890598e62cb635a712e3a8454f04',
            },
            'x86_64-apple-darwin': {
              url: 'https://static.rust-lang.org/dist/rustc-1.95.0-x86_64-apple-darwin.tar.xz',
              sha256: '33db457715446a69ed6f69f78f5fbb9ca8e17a16585d1d7a0060479bfe4c7afc',
            },
          },
          cargo: {
            'aarch64-apple-darwin': {
              url: 'https://static.rust-lang.org/dist/cargo-1.95.0-aarch64-apple-darwin.tar.xz',
              sha256: '6c2ffed8e1ac9cf4dc9e80f282a869a6b237a153e7c55cca039d33de29d80aaf',
            },
            'x86_64-apple-darwin': {
              url: 'https://static.rust-lang.org/dist/cargo-1.95.0-x86_64-apple-darwin.tar.xz',
              sha256: 'e2e1131ade2dddc0d779e0ab3a6a990085c7a654951235742823c3a1ce0f190f',
            },
          },
          rustStd: {
            'aarch64-apple-darwin': {
              url: 'https://static.rust-lang.org/dist/rust-std-1.95.0-aarch64-apple-darwin.tar.xz',
              sha256: '9b30089b0f767cb91b2190ffec55a9beeb2a21a1405d8da0f664d7e09d08e6d8',
            },
            'x86_64-apple-darwin': {
              url: 'https://static.rust-lang.org/dist/rust-std-1.95.0-x86_64-apple-darwin.tar.xz',
              sha256: '2be13c14122b8d4d09b7f7c434fca9ae7215ec72049944189c88c4d9128ce504',
            },
          },
        },
      },
      normalizedCargoLock: {
        fromVersion: '0.0.0',
        toVersion: '0.144.2',
        replacements: 132,
        sha256: '947f356f56fb96a6beb5029c0d70fe7a31825d7cc9123991f1a1fd4fe69a04e7',
      },
      binaryVersion: '0.144.2',
      arches: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
      patches: ['patches/0001-zeus-legacy-session-source.patch'],
      license: 'Apache-2.0',
    });
  });

  it('maps supported macOS architectures to pinned Rust targets', async () => {
    const { codexTargetForArch } = await import('./build-codex-runtime.mjs');

    expect(codexTargetForArch('arm64')).toBe('aarch64-apple-darwin');
    expect(codexTargetForArch('aarch64')).toBe('aarch64-apple-darwin');
    expect(codexTargetForArch('x64')).toBe('x86_64-apple-darwin');
    expect(codexTargetForArch('x86_64')).toBe('x86_64-apple-darwin');
    expect(() => codexTargetForArch('riscv64')).toThrow('Unsupported Codex runtime architecture: riscv64');
  });

  it('selects pinned host compiler components and adds cross-target std only once', async () => {
    const { readCodexRuntimeLock, rustToolchainArtifactsForBuild } = await import('./build-codex-runtime.mjs');
    const lock = await readCodexRuntimeLock();

    expect(rustToolchainArtifactsForBuild(lock, 'aarch64-apple-darwin', 'aarch64-apple-darwin').map((item: { component: string; target: string }) => `${item.component}:${item.target}`)).toEqual([
      'rustc:aarch64-apple-darwin',
      'cargo:aarch64-apple-darwin',
      'rustStd:aarch64-apple-darwin',
    ]);
    expect(rustToolchainArtifactsForBuild(lock, 'aarch64-apple-darwin', 'x86_64-apple-darwin').map((item: { component: string; target: string }) => `${item.component}:${item.target}`)).toEqual([
      'rustc:aarch64-apple-darwin',
      'cargo:aarch64-apple-darwin',
      'rustStd:aarch64-apple-darwin',
      'rustStd:x86_64-apple-darwin',
    ]);
  });

  it('normalizes only the pinned number of workspace package versions', async () => {
    const { normalizeCargoLockWorkspaceVersions } = await import('./build-codex-runtime.mjs');
    const input = '[[package]]\nname = "one"\nversion = "0.0.0"\n\n[[package]]\nname = "two"\nversion = "0.0.0"\n';

    expect(
      normalizeCargoLockWorkspaceVersions(input, {
        fromVersion: '0.0.0',
        toVersion: '0.144.2',
        replacements: 2,
      }),
    ).toBe(input.replaceAll('version = "0.0.0"', 'version = "0.144.2"'));
    expect(() =>
      normalizeCargoLockWorkspaceVersions(input, {
        fromVersion: '0.0.0',
        toVersion: '0.144.2',
        replacements: 3,
      }),
    ).toThrow('Cargo.lock workspace version replacement mismatch: expected 3, received 2');
  });

  it('fails closed when the resolved source commit differs from the lock', async () => {
    const { assertPinnedSourceCommit, readCodexRuntimeLock } = await import('./build-codex-runtime.mjs');
    const lock = await readCodexRuntimeLock();

    expect(() => assertPinnedSourceCommit(lock, lock.commit)).not.toThrow();
    expect(() => assertPinnedSourceCommit(lock, '0000000000000000000000000000000000000000')).toThrow('Codex upstream commit mismatch: expected a6645b6b8a656360fa16fb7e1c6721d0697d3d6a, received 0000000000000000000000000000000000000000');
  });

  it('fails closed when the downloaded source archive checksum differs from the lock', async () => {
    const { assertSourceArchiveHash, readCodexRuntimeLock } = await import('./build-codex-runtime.mjs');
    const lock = await readCodexRuntimeLock();

    expect(() => assertSourceArchiveHash(lock, lock.sourceArchive.sha256)).not.toThrow();
    expect(() => assertSourceArchiveHash(lock, 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')).toThrow(
      `Codex source archive checksum mismatch: expected ${lock.sourceArchive.sha256}, received ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`,
    );
  });

  it('builds an integrity manifest from real binary and normalized schema bytes', async () => {
    const { createCodexRuntimeManifest, readCodexRuntimeLock } = await import('./build-codex-runtime.mjs');
    const lock = await readCodexRuntimeLock();
    const manifest = createCodexRuntimeManifest({
      lock,
      target: 'aarch64-apple-darwin',
      binary: Buffer.from('codex-binary'),
      protocolSchema: Buffer.from('ClientRequest.ts\0thread/start\n'),
    });

    expect(manifest).toEqual({
      upstreamCommit: lock.commit,
      binaryVersion: '0.144.2',
      rustToolchainVersion: '1.95.0',
      normalizedCargoLockSha256: '947f356f56fb96a6beb5029c0d70fe7a31825d7cc9123991f1a1fd4fe69a04e7',
      arch: 'aarch64-apple-darwin',
      sha256: '9801aa2d60173c67a0ff098ef82726580e0f0167e22f6c5ad353a7438a619d10',
      protocolSchemaSha256: 'bce349f876b8c05676b5d0e893270ada37168544875dfb385f0c12d9faae5168',
      patches: ['patches/0001-zeus-legacy-session-source.patch'],
    });
  });

  it('checks out, patches, builds, probes and manifests the pinned runtime in a private workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zeus-codex-runtime-'));
    try {
      const lockDir = join(root, 'third_party', 'openai-codex');
      const sourceDir = join(root, '.tmp', 'openai-codex', 'a6645b6b8a656360fa16fb7e1c6721d0697d3d6a');
      const target = 'aarch64-apple-darwin';
      const cargoBinary = join(root, '.tmp', 'cargo-target', 'a6645b6b8a656360fa16fb7e1c6721d0697d3d6a', target, 'release', 'codex');
      const lock = {
        repository: 'https://github.com/openai/codex.git',
        tag: 'rust-v0.144.2',
        tagObject: '06eee5f70addf0b8cf331d5c6721f0414e7d2ae6',
        commit: 'a6645b6b8a656360fa16fb7e1c6721d0697d3d6a',
        sourceArchive: {
          url: 'https://codeload.github.com/openai/codex/tar.gz/a6645b6b8a656360fa16fb7e1c6721d0697d3d6a',
          sha256: 'a18d8d1ab77fa7dab9636ce679f812f884dfaddfad9a3ee830bf9ff64a4594e7',
        },
        rustToolchain: {
          version: '1.95.0',
          components: {},
        },
        normalizedCargoLock: {
          fromVersion: '0.0.0',
          toVersion: '0.144.2',
          replacements: 1,
          sha256: '2627c08bfcb6b7317a4bb830a0185649cbb217ef52b0f2465b24b3fe18716553',
        },
        binaryVersion: '0.144.2',
        arches: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
        patches: ['patches/0001-zeus-legacy-session-source.patch'],
        license: 'Apache-2.0',
      };
      await mkdir(join(lockDir, 'patches'), { recursive: true });
      await mkdir(join(sourceDir, 'codex-rs'), { recursive: true });
      await writeFile(join(lockDir, 'runtime.lock.json'), JSON.stringify(lock));
      await writeFile(join(lockDir, 'patches', '0001-zeus-legacy-session-source.patch'), 'patch');
      await writeFile(join(sourceDir, 'codex-rs', 'Cargo.lock'), 'version = "0.0.0"\n');
      await writeFile(
        join(sourceDir, '.zeus-source.json'),
        JSON.stringify({
          upstreamCommit: lock.commit,
          sourceArchiveSha256: lock.sourceArchive.sha256,
        }),
      );
      const commands: string[] = [];
      const toolchainBinDir = join(root, '.tmp', 'rust-toolchain', 'bin');
      let cargoBuildEnv: NodeJS.ProcessEnv | undefined;
      const runCommand = async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        commands.push([command, ...args].join(' '));
        if (command === 'git' && args.at(-1) === 'HEAD') return `${lock.commit}\n`;
        if (command === 'cargo' || command.endsWith('/cargo')) {
          cargoBuildEnv = options?.env;
          await mkdir(join(cargoBinary, '..'), { recursive: true });
          await writeFile(cargoBinary, 'codex-binary');
          return '';
        }
        if (command.endsWith('/codex') && args[0] === '--version') return 'codex-cli 0.144.2\n';
        if (command.endsWith('/codex') && args[0] === 'app-server') {
          const outIndex = args.indexOf('--out');
          const schemaDir = args[outIndex + 1]!;
          await mkdir(schemaDir, { recursive: true });
          await writeFile(join(schemaDir, 'ClientRequest.ts'), 'thread/start\n');
          return '';
        }
        return '';
      };
      const { buildCodexRuntime } = await import('./build-codex-runtime.mjs');

      const manifest = await buildCodexRuntime({
        arch: 'arm64',
        workspaceRoot: root,
        lockPath: join(lockDir, 'runtime.lock.json'),
        runCommand,
        toolchainBinDir,
      });

      expect(manifest.upstreamCommit).toBe(lock.commit);
      expect(manifest.binaryVersion).toBe('0.144.2');
      expect(manifest.rustToolchainVersion).toBe('1.95.0');
      expect(manifest.normalizedCargoLockSha256).toBe(lock.normalizedCargoLock.sha256);
      expect(manifest.arch).toBe(target);
      expect(commands).toContain(`/usr/bin/patch --batch --forward --dry-run -p1 -d ${sourceDir} -i ${join(lockDir, 'patches', '0001-zeus-legacy-session-source.patch')}`);
      expect(commands).toContain(`/usr/bin/patch --batch --forward -p1 -d ${sourceDir} -i ${join(lockDir, 'patches', '0001-zeus-legacy-session-source.patch')}`);
      expect(commands.some((command) => command.startsWith('git '))).toBe(false);
      expect(commands).toContain(`${join(toolchainBinDir, 'cargo')} build --locked --release --bin codex --target ${target} --manifest-path ${join(sourceDir, 'codex-rs', 'Cargo.toml')}`);
      const rustcWrapper = join(root, '.tmp', 'rustc-wrapper', 'rustc-wrapper.sh');
      expect(cargoBuildEnv?.RUSTC_WRAPPER).toBe(rustcWrapper);
      expect(cargoBuildEnv?.ZEUS_RUST_SYSROOT).toBe(join(toolchainBinDir, '..'));
      expect(await readFile(rustcWrapper, 'utf8')).toBe('#!/bin/sh\nset -eu\nrustc="$1"\nshift\nexec "$rustc" --sysroot "$ZEUS_RUST_SYSROOT" "$@"\n');
      expect(await readFile(join(sourceDir, 'codex-rs', 'Cargo.lock'), 'utf8')).toBe('version = "0.144.2"\n');
      const persisted = JSON.parse(await readFile(join(root, '.tmp', 'codex-runtime', 'arm64', 'manifest.json'), 'utf8')) as typeof manifest;
      expect(persisted).toEqual(manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
