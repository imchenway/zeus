#!/usr/bin/env node
/* global console, process */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');

export async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export function renderHomebrewCask({ version, arch, sha256 }) {
  return `cask "zeus" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/imchenway/zeus/releases/download/v#{version}/Zeus-#{version}-${arch}.dmg"
  name "Zeus"
  desc "Local-first macOS AI development workbench"
  homepage "https://github.com/imchenway/zeus"

  app "Zeus.app"

  uninstall launchctl: "dev.hypha.zeus",
            quit:      "dev.hypha.zeus"

  zap trash: [
    "~/Library/Application Support/Zeus",
    "~/Library/Caches/dev.hypha.zeus",
    "~/Library/Logs/Zeus",
    "~/Library/Preferences/dev.hypha.zeus.plist",
  ]
end
`;
}

export async function generateHomebrewCask({ version, arch, dmgPath, outputPath }) {
  const sha256 = await sha256File(dmgPath);
  const cask = renderHomebrewCask({ version, arch, sha256 });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, cask, 'utf8');
  return { outputPath, sha256 };
}

async function main() {
  const version = process.argv[2] ?? JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')).version;
  const arch = process.argv[3] ?? (process.arch === 'x64' ? 'x64' : 'arm64');
  const dmgPath = process.argv[4] ?? join(rootDir, 'dist', `Zeus-${version}-${arch}.dmg`);
  const outputPath = process.argv[5] ?? join(rootDir, 'dist', 'homebrew', 'zeus.rb');
  const result = await generateHomebrewCask({
    version,
    arch,
    dmgPath,
    outputPath,
  });
  console.log(`Zeus Homebrew cask generated: ${result.outputPath}`);
  console.log(`sha256=${result.sha256}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
