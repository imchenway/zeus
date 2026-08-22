#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceRoots = ['apps', 'packages'];
const forbidden = [
  /\brecoveryBackupCloudPair\b/iu,
  /\bchooseRecoveryBackupCloud/iu,
  /\b(?:icloud|google)[_-](?:drive|cloud)\b/iu,
  /\bproviderKind\s*:\s*['"](?:icloud|google_drive)/iu,
  /\bNSUbiquitousKeyValueStore\b/u,
  /\bubiquityIdentityToken\b/u,
  /\bCloudKit\b/u,
  /\bCKContainer\b/u,
  /\bGTLRDrive\b/u,
  /\bdrive\.files\.(?:create|update|delete)\b/u,
  /www\.googleapis\.com\/drive/iu,
];
const findings = [];

for (const root of sourceRoots) {
  for (const path of await collectSourceFiles(join(repositoryRoot, root))) {
    const content = await readFile(path, 'utf8');
    for (const pattern of forbidden) {
      const match = pattern.exec(content);
      if (!match) continue;
      findings.push({ file: relative(repositoryRoot, path).split('\\').join('/'), line: lineNumber(content, match.index), pattern: pattern.source });
    }
  }
}

const negativeBoundaryFiles = ['apps/desktop/src/main/recoveryBackupDestinationPort.ts', 'packages/storage/src/recoveryBackupReplication.ts'];
const negativeBoundaries = [];
for (const file of negativeBoundaryFiles) {
  const content = await readFile(join(repositoryRoot, file), 'utf8');
  negativeBoundaries.push({
    file,
    explicitlyUserSelected: /用户选择|请选择/u.test(content),
    refusesAutomaticCloudBinding: /禁止猜测|不会自动查找或绑定/u.test(content) && /iCloud/u.test(content) && /Google Drive/u.test(content),
  });
}

const passed = findings.length === 0 && negativeBoundaries.every((boundary) => boundary.explicitlyUserSelected && boundary.refusesAutomaticCloudBinding);
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      status: passed ? 'passed' : 'failed',
      scope: 'runtime source only; docs may record the deferred product requirement',
      findings,
      negativeBoundaries,
      conclusion: 'ZARCH-063 multi-device sync remains deferred; generic recovery destinations have no cloud provider semantics.',
    },
    null,
    2,
  )}\n`,
);
if (!passed) process.exitCode = 1;

async function collectSourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'out') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collectSourceFiles(path)));
    else if (entry.isFile() && /\.(?:ts|tsx|cts|mts|js|mjs|cjs)$/u.test(entry.name)) result.push(path);
  }
  return result;
}

function lineNumber(content, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (content.charCodeAt(index) === 10) line += 1;
  return line;
}
