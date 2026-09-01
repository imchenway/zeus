#!/usr/bin/env node
/* global console, process */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {sha256File} from './release-script-utils.mjs';

export {sha256File} from './release-script-utils.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');

function normalizeCaskArchitecture(arch) {
  if (arch === 'arm64') {
    return { artifact: 'arm64', homebrew: ':arm64' };
  }
  if (arch === 'x64') {
    return { artifact: 'x64', homebrew: ':x86_64' };
  }
  throw new Error(`Zeus Homebrew cask 不支持架构：${arch}`);
}

export function renderHomebrewCask({ version, arch, sha256 }) {
  const normalizedArch = normalizeCaskArchitecture(arch);
  return `cask "zeus" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/imchenway/zeus/releases/download/v#{version}/Zeus-#{version}-${normalizedArch.artifact}.dmg"
  name "Zeus"
  desc "Local-first AI development workbench"
  homepage "https://github.com/imchenway/zeus"

  depends_on :macos
  depends_on arch: ${normalizedArch.homebrew}

  app "Zeus.app"

  uninstall quit: "dev.hypha.zeus"

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
