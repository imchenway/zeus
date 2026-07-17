#!/usr/bin/env node
/* global process */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const defaultLockPath = join(rootDir, 'third_party', 'openai-codex', 'runtime.lock.json');

export function codexTargetForArch(arch) {
  if (arch === 'arm64' || arch === 'aarch64') return 'aarch64-apple-darwin';
  if (arch === 'x64' || arch === 'x86_64') return 'x86_64-apple-darwin';
  throw new Error(`Unsupported Codex runtime architecture: ${arch}`);
}

export function rustToolchainArtifactsForBuild(lock, hostTarget, buildTarget) {
  const components = lock.rustToolchain?.components;
  if (!components) throw new Error('Codex runtime lock is missing rustToolchain.components');
  const requested = [['rustc', hostTarget], ['cargo', hostTarget], ['rustStd', hostTarget], ...(buildTarget === hostTarget ? [] : [['rustStd', buildTarget]])];
  return requested.map(([component, target]) => {
    const artifact = components[component]?.[target];
    if (!artifact) throw new Error(`Codex runtime lock is missing Rust ${component} artifact for ${target}`);
    return { component, target, ...artifact };
  });
}

export function normalizeCargoLockWorkspaceVersions(cargoLock, normalization) {
  const from = `version = "${normalization.fromVersion}"`;
  const to = `version = "${normalization.toVersion}"`;
  const replacements = cargoLock.split(from).length - 1;
  if (replacements !== normalization.replacements) {
    throw new Error(`Cargo.lock workspace version replacement mismatch: expected ${normalization.replacements}, received ${replacements}`);
  }
  return cargoLock.replaceAll(from, to);
}

export async function readCodexRuntimeLock(lockPath = defaultLockPath) {
  return JSON.parse(await readFile(lockPath, 'utf8'));
}

export function assertPinnedSourceCommit(lock, resolvedCommit) {
  if (resolvedCommit !== lock.commit) {
    throw new Error(`Codex upstream commit mismatch: expected ${lock.commit}, received ${resolvedCommit}`);
  }
}

export function assertSourceArchiveHash(lock, resolvedSha256) {
  if (resolvedSha256 !== lock.sourceArchive.sha256) {
    throw new Error(`Codex source archive checksum mismatch: expected ${lock.sourceArchive.sha256}, received ${resolvedSha256}`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function preparePinnedSource({ lock, workspaceRoot, sourceDir, runCommand, offline }) {
  const sourceMarkerPath = join(sourceDir, '.zeus-source.json');
  const marker = await readJsonIfExists(sourceMarkerPath);
  if (marker?.upstreamCommit === lock.commit && marker?.sourceArchiveSha256 === lock.sourceArchive.sha256) return marker;

  const archiveDir = join(workspaceRoot, '.tmp', 'openai-codex-archives');
  const archivePath = join(archiveDir, `${lock.commit}.tar.gz`);
  await mkdir(archiveDir, { recursive: true });
  if (!(await pathExists(archivePath))) {
    if (offline) throw new Error(`Pinned Codex source archive is not cached for offline build: ${archivePath}`);
    await runCommand('/usr/bin/curl', ['-fL', '--retry', '3', '--connect-timeout', '15', '--max-time', '300', lock.sourceArchive.url, '-o', archivePath], { inheritOutput: true });
  }
  assertSourceArchiveHash(lock, sha256(await readFile(archivePath)));
  await rm(sourceDir, { recursive: true, force: true });
  await mkdir(sourceDir, { recursive: true });
  await runCommand('/usr/bin/tar', ['-xzf', archivePath, '--strip-components=1', '-C', sourceDir]);
  const cleanMarker = {
    upstreamCommit: lock.commit,
    sourceArchiveSha256: lock.sourceArchive.sha256,
    patches: [],
  };
  await writeFile(sourceMarkerPath, `${JSON.stringify(cleanMarker, null, 2)}\n`, { mode: 0o600 });
  return cleanMarker;
}

async function preparePinnedRustToolchain({ lock, workspaceRoot, hostTarget, buildTarget, runCommand, offline }) {
  const artifacts = rustToolchainArtifactsForBuild(lock, hostTarget, buildTarget);
  const toolchainDir = join(workspaceRoot, '.tmp', 'rust-toolchains', lock.rustToolchain.version, hostTarget);
  const toolchainBinDir = join(toolchainDir, 'bin');
  const markerPath = join(toolchainDir, '.zeus-toolchain.json');
  const expectedMarker = {
    version: lock.rustToolchain.version,
    hostTarget,
    artifacts: artifacts.map(({ component, target, sha256: artifactSha256 }) => ({ component, target, sha256: artifactSha256 })),
  };
  const marker = await readJsonIfExists(markerPath);
  if (JSON.stringify(marker) === JSON.stringify(expectedMarker) && (await pathExists(join(toolchainBinDir, 'cargo'))) && (await pathExists(join(toolchainBinDir, 'rustc')))) {
    return toolchainBinDir;
  }

  await rm(toolchainDir, { recursive: true, force: true });
  await mkdir(toolchainDir, { recursive: true });
  const archiveDir = join(workspaceRoot, '.tmp', 'rust-toolchain-archives');
  const extractRoot = join(workspaceRoot, '.tmp', 'rust-toolchain-extract');
  await mkdir(archiveDir, { recursive: true });
  for (const artifact of artifacts) {
    const archiveName = basename(new URL(artifact.url).pathname);
    const archivePath = join(archiveDir, archiveName);
    if (!(await pathExists(archivePath))) {
      if (offline) throw new Error(`Pinned Rust toolchain archive is not cached for offline build: ${archivePath}`);
      await runCommand('/usr/bin/curl', ['-fL', '--retry', '3', '--connect-timeout', '15', '--max-time', '300', artifact.url, '-o', archivePath], {
        inheritOutput: true,
      });
    }
    const resolvedSha256 = sha256(await readFile(archivePath));
    if (resolvedSha256 !== artifact.sha256) {
      throw new Error(`Rust ${artifact.component} archive checksum mismatch for ${artifact.target}: expected ${artifact.sha256}, received ${resolvedSha256}`);
    }
    const extractDir = join(extractRoot, artifact.sha256);
    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    await runCommand('/usr/bin/tar', ['-xJf', archivePath, '--strip-components=1', '-C', extractDir]);
    await runCommand('/bin/sh', [join(extractDir, 'install.sh'), `--prefix=${toolchainDir}`, '--disable-ldconfig']);
    await rm(extractDir, { recursive: true, force: true });
  }
  const cargoVersion = (await runCommand(join(toolchainBinDir, 'cargo'), ['--version'])).trim();
  const rustcVersion = (await runCommand(join(toolchainBinDir, 'rustc'), ['--version'])).trim();
  if (!cargoVersion.startsWith(`cargo ${lock.rustToolchain.version} `)) {
    throw new Error(`Pinned Cargo version mismatch: expected ${lock.rustToolchain.version}, received ${cargoVersion || 'empty output'}`);
  }
  if (!rustcVersion.startsWith(`rustc ${lock.rustToolchain.version} `)) {
    throw new Error(`Pinned rustc version mismatch: expected ${lock.rustToolchain.version}, received ${rustcVersion || 'empty output'}`);
  }
  await writeFile(markerPath, `${JSON.stringify(expectedMarker)}\n`, { mode: 0o600 });
  return toolchainBinDir;
}

export function createCodexRuntimeManifest({ lock, target, binary, protocolSchema }) {
  return {
    upstreamCommit: lock.commit,
    binaryVersion: lock.binaryVersion,
    rustToolchainVersion: lock.rustToolchain.version,
    normalizedCargoLockSha256: lock.normalizedCargoLock.sha256,
    arch: target,
    sha256: sha256(binary),
    protocolSchemaSha256: sha256(protocolSchema),
    patches: [...lock.patches],
  };
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultRunCommand(command, args, options = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (options.inheritOutput) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (options.inheritOutput) process.stderr.write(chunk);
    });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun(stdout);
        return;
      }
      rejectRun(new Error(`${command} ${args.join(' ')} failed${signal ? ` with signal ${signal}` : ` with code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(root, path)));
    else if (entry.isFile()) files.push({ path: relative(root, path).replaceAll('\\', '/'), content: await readFile(path) });
  }
  return files;
}

export async function normalizedProtocolSchema(schemaDir) {
  const files = await collectFiles(schemaDir);
  return Buffer.concat(files.flatMap((file) => [Buffer.from(`${file.path}\0`), file.content]));
}

function parseCodexVersion(output, expectedVersion) {
  const match = /^codex-cli\s+(\S+)\s*$/u.exec(output.trim());
  const version = match?.[1];
  if (version !== expectedVersion) throw new Error(`Codex binary version mismatch: expected ${expectedVersion}, received ${version ?? 'unparseable output'}`);
}

export async function buildCodexRuntime(options) {
  const workspaceRoot = resolve(options.workspaceRoot ?? rootDir);
  const lockPath = resolve(options.lockPath ?? join(workspaceRoot, 'third_party', 'openai-codex', 'runtime.lock.json'));
  const lockDir = dirname(lockPath);
  const lock = await readCodexRuntimeLock(lockPath);
  const target = codexTargetForArch(options.arch);
  const hostTarget = codexTargetForArch(options.hostArch ?? process.arch);
  if (!lock.arches.includes(target)) throw new Error(`Codex runtime lock does not allow target: ${target}`);
  const runCommand = options.runCommand ?? defaultRunCommand;
  const sourceDir = join(workspaceRoot, '.tmp', 'openai-codex', lock.commit);
  const cargoTargetDir = join(workspaceRoot, '.tmp', 'cargo-target', lock.commit);
  const outputDir = resolve(options.outputDir ?? join(workspaceRoot, '.tmp', 'codex-runtime', options.arch));
  const schemaDir = join(outputDir, 'protocol-schema');
  const toolchainBinDir = options.toolchainBinDir ?? (await preparePinnedRustToolchain({ lock, workspaceRoot, hostTarget, buildTarget: target, runCommand, offline: Boolean(options.offline) }));

  const sourceMarker = await preparePinnedSource({ lock, workspaceRoot, sourceDir, runCommand, offline: Boolean(options.offline) });
  const resolvedPatchHashes = [];
  for (const patch of lock.patches) {
    const patchPath = join(lockDir, patch);
    if (!(await pathExists(patchPath))) throw new Error(`Codex runtime patch is missing: ${patchPath}`);
    resolvedPatchHashes.push({ path: patch, sha256: sha256(await readFile(patchPath)) });
  }
  const patchesAlreadyApplied = JSON.stringify(sourceMarker.patches ?? []) === JSON.stringify(resolvedPatchHashes);
  if (!patchesAlreadyApplied) {
    if ((sourceMarker.patches ?? []).length > 0) {
      await rm(join(sourceDir, '.zeus-source.json'), { force: true });
      return await buildCodexRuntime(options);
    }
    for (const patch of lock.patches) {
      const patchPath = join(lockDir, patch);
      await runCommand('/usr/bin/patch', ['--batch', '--forward', '--dry-run', '-p1', '-d', sourceDir, '-i', patchPath]);
      await runCommand('/usr/bin/patch', ['--batch', '--forward', '-p1', '-d', sourceDir, '-i', patchPath]);
    }
    await writeFile(join(sourceDir, '.zeus-source.json'), `${JSON.stringify({ upstreamCommit: lock.commit, sourceArchiveSha256: lock.sourceArchive.sha256, patches: resolvedPatchHashes }, null, 2)}\n`, { mode: 0o600 });
  }

  const manifestPath = join(sourceDir, 'codex-rs', 'Cargo.toml');
  const cargoLockPath = join(sourceDir, 'codex-rs', 'Cargo.lock');
  const cargoLock = await readFile(cargoLockPath, 'utf8');
  if (sha256(cargoLock) !== lock.normalizedCargoLock.sha256) {
    const normalizedCargoLock = normalizeCargoLockWorkspaceVersions(cargoLock, lock.normalizedCargoLock);
    const normalizedSha256 = sha256(normalizedCargoLock);
    if (normalizedSha256 !== lock.normalizedCargoLock.sha256) {
      throw new Error(`Normalized Cargo.lock checksum mismatch: expected ${lock.normalizedCargoLock.sha256}, received ${normalizedSha256}`);
    }
    await writeFile(cargoLockPath, normalizedCargoLock);
  }
  const rustcWrapper = join(workspaceRoot, '.tmp', 'rustc-wrapper', 'rustc-wrapper.sh');
  await mkdir(dirname(rustcWrapper), { recursive: true });
  await writeFile(rustcWrapper, '#!/bin/sh\nset -eu\nrustc="$1"\nshift\nexec "$rustc" --sysroot "$ZEUS_RUST_SYSROOT" "$@"\n', { mode: 0o755 });
  await chmod(rustcWrapper, 0o755);
  await runCommand(join(toolchainBinDir, 'cargo'), ['build', '--locked', '--release', '--bin', 'codex', '--target', target, '--manifest-path', manifestPath], {
    cwd: join(sourceDir, 'codex-rs'),
    env: {
      ...process.env,
      CARGO_TARGET_DIR: cargoTargetDir,
      RUSTC: join(toolchainBinDir, 'rustc'),
      RUSTC_WRAPPER: rustcWrapper,
      ZEUS_RUST_SYSROOT: dirname(toolchainBinDir),
      PATH: `${toolchainBinDir}${delimiter}${process.env.PATH ?? ''}`,
    },
    inheritOutput: true,
  });
  const builtBinary = join(cargoTargetDir, target, 'release', 'codex');
  if (!(await pathExists(builtBinary))) throw new Error(`Codex build completed without the expected binary: ${builtBinary}`);

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const outputBinary = join(outputDir, 'codex');
  await copyFile(builtBinary, outputBinary);
  await chmod(outputBinary, 0o755);
  parseCodexVersion(await runCommand(outputBinary, ['--version']), lock.binaryVersion);
  await runCommand(outputBinary, ['app-server', 'generate-ts', '--out', schemaDir]);
  const binary = await readFile(outputBinary);
  const protocolSchema = await normalizedProtocolSchema(schemaDir);
  const manifest = createCodexRuntimeManifest({ lock, target, binary, protocolSchema });
  const manifestPathOutput = join(outputDir, 'manifest.json');
  const manifestTempPath = `${manifestPathOutput}.tmp`;
  await writeFile(manifestTempPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(manifestTempPath, manifestPathOutput);
  return manifest;
}

async function runCli() {
  const args = process.argv.slice(2);
  const archIndex = args.indexOf('--arch');
  const arch = archIndex >= 0 ? args[archIndex + 1] : process.arch;
  if (!arch) throw new Error('--arch requires a value');
  const manifest = await buildCodexRuntime({ arch, offline: args.includes('--offline') });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
