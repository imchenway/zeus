#!/usr/bin/env node
/* global console, process */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const defaultRepository = 'imchenway/zeus';

async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function normalizeVersion(version) {
  const trimmed = String(version ?? '')
    .trim()
    .replace(/^v/u, '');
  return trimmed || '0.0.0';
}

function normalizeRepository(repository) {
  const trimmed = String(repository ?? '')
    .trim()
    .replace(/^https:\/\/github\.com\//u, '')
    .replace(/\.git$/u, '');
  return trimmed || defaultRepository;
}

export function renderReleaseManifest(input) {
  const version = normalizeVersion(input.version);
  const repository = normalizeRepository(input.repository);
  const tag = `v${version}`;
  const releaseBaseUrl = `https://github.com/${repository}/releases`;
  const releaseDownloadBaseUrl = `${releaseBaseUrl}/download/${tag}`;
  const manifest = {
    app: 'Zeus',
    schemaVersion: 1,
    version,
    channel: input.channel ?? 'stable',
    repository,
    releasePageUrl: `${releaseBaseUrl}/tag/${tag}`,
    latestReleaseUrl: `${releaseBaseUrl}/latest`,
    releaseNotesUrl: `${releaseBaseUrl}/tag/${tag}`,
    installScriptUrl: `${releaseBaseUrl}/latest/download/install.sh`,
    publishedAt: input.publishedAt ?? new Date(0).toISOString(),
    signed: Boolean(input.signed),
    notarized: Boolean(input.notarized),
    minimumSystemVersion: input.minimumSystemVersion ?? '13.0',
    // 只写入真实产物名、hash 和下载地址，不包含任何本机 dist 绝对路径。
    artifacts: (input.artifacts ?? []).map((artifact) => ({
      arch: artifact.arch,
      kind: artifact.kind,
      fileName: artifact.fileName,
      sha256: artifact.sha256,
      sizeBytes: typeof artifact.sizeBytes === 'number' ? artifact.sizeBytes : null,
      downloadUrl: artifact.downloadUrl ?? `${releaseDownloadBaseUrl}/${encodeURIComponent(artifact.fileName)}`,
    })),
    homebrew: {
      tap: repository,
      cask: 'zeus',
      installCommand: `brew install --cask ${repository}/zeus`,
      upgradeCommand: 'brew upgrade --cask zeus',
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function discoverArtifacts({ distDir, version, repository }) {
  const files = await readdir(distDir).catch(() => []);
  const artifacts = [];
  for (const fileName of files) {
    const match = fileName.match(new RegExp(`^Zeus-${version}-(arm64|x64)\\.(dmg|zip)$`, 'u'));
    if (!match) continue;
    const filePath = join(distDir, fileName);
    const fileStat = await stat(filePath);
    artifacts.push({
      arch: match[1],
      kind: match[2],
      fileName,
      sha256: await sha256File(filePath),
      sizeBytes: fileStat.size,
      downloadUrl: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(fileName)}`,
    });
  }
  return artifacts.sort((left, right) => `${left.arch}-${left.kind}`.localeCompare(`${right.arch}-${right.kind}`));
}

export async function generateReleaseManifest({ version, channel = 'stable', repository = defaultRepository, outputPath, distDir = join(rootDir, 'dist'), signed = false, notarized = false }) {
  const normalizedVersion = normalizeVersion(version);
  const normalizedRepository = normalizeRepository(repository);
  const artifacts = await discoverArtifacts({
    distDir,
    version: normalizedVersion,
    repository: normalizedRepository,
  });
  const content = renderReleaseManifest({
    version: normalizedVersion,
    channel,
    repository: normalizedRepository,
    signed,
    notarized,
    publishedAt: new Date().toISOString(),
    artifacts,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
  return { outputPath, artifactCount: artifacts.length };
}

async function main() {
  const version = process.argv[2] ?? JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')).version;
  const channel = process.argv[3] ?? 'stable';
  const repository = process.argv[4] ?? defaultRepository;
  const outputPath = process.argv[5] ?? join(rootDir, 'dist', 'zeus-release-manifest.json');
  const result = await generateReleaseManifest({
    version,
    channel,
    repository,
    outputPath,
  });
  console.log(`Zeus release manifest generated: ${result.outputPath}; artifacts=${result.artifactCount}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
