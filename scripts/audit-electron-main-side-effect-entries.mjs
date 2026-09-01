#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const repositoryRoot = resolve(process.cwd());
const sourceRoot = join(repositoryRoot, 'apps/desktop/src/main');
const files = await collectTypeScriptFiles(sourceRoot);
const registrations = [];
const sourceHash = createHash('sha256');
const sources = new Map();

for (const path of files) {
    const file = relative(repositoryRoot, path).replaceAll('\\', '/');
    const source = await readFile(path, 'utf8');
    sources.set(file, source);
    sourceHash.update(`${file}\0${source}\0`);
    registrations.push(...discoverRegistrations(path, source));
}

const violations = [];
const duplicates = registrations.filter((entry, index) => registrations.findIndex((candidate) => candidate.channel === entry.channel && candidate.kind === entry.kind) !== index);
for (const entry of duplicates) violations.push(`IPC 重复注册：${entry.kind} ${entry.channel}`);

const mainSource = sources.get('apps/desktop/src/main/main.ts') ?? '';
const fenceSource = sources.get('apps/desktop/src/main/readOnlyValidationIpcFence.ts') ?? '';
if (!mainSource.includes('installReadOnlyValidationIpcFence')) violations.push('main.ts 未安装统一 IPC read-only validation fence');
for (const marker of ['ipcMain.handle =', 'ipcMain.on =', 'wrapEventListener']) {
    if (!fenceSource.includes(marker)) violations.push(`IPC fence 缺少 ${marker}`);
}
if (registrations.length === 0) violations.push('未发现 Electron Main IPC 注册');

const classified = registrations.map((entry) => ({
    ...entry,
    classification: entry.handler.includes('MainCommandRequest') ? 'command' : isReadChannel(entry.channel) ? 'read' : 'platform',
}));
const counts = Object.fromEntries(['command', 'read', 'platform'].map((kind) => [kind, classified.filter((entry) => entry.classification === kind).length]));
const report = {
  schemaVersion: 2,
    generatedFrom: {root: 'apps/desktop/src/main', sha256: sourceHash.digest('hex')},
    summary: {total: classified.length, byClassification: counts, complete: violations.length === 0},
    fence: {
        installed: mainSource.includes('installReadOnlyValidationIpcFence'),
        coversInvokeAndEvent: violations.every((item) => !item.startsWith('IPC fence'))
    },
    violations,
    inventory: Object.entries(
        classified.reduce((result, entry) => {
            const key = `${entry.classification}:${entry.file}`;
            result[key] = (result[key] ?? 0) + 1;
            return result;
        }, {}),
    ).map(([key, count]) => ({key, count})),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if ((process.argv.includes('--require-complete') || process.argv.length === 2) && violations.length > 0) process.exitCode = 2;

function discoverRegistrations(path, source) {
    const file = relative(repositoryRoot, path).replaceAll('\\', '/');
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found = [];
  const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['handle', 'handleOnce', 'on', 'once'].includes(node.expression.name.text)) {
          const receiver = node.expression.expression.getText(sourceFile);
          const channel = node.arguments[0];
          const handler = node.arguments[1];
          if (receiver === 'ipcMain' && channel && (ts.isStringLiteral(channel) || ts.isNoSubstitutionTemplateLiteral(channel))) {
              found.push({
                  kind: node.expression.name.text,
                  channel: channel.text,
                  file,
                  line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
                  handler: handler?.getText(sourceFile) ?? '',
              });
          }
      }
      ts.forEachChild(node, visit);
  };
    visit(sourceFile);
    return found;
}

function isReadChannel(channel) {
    return /(?:^|:)(?:get|list|load|read|search|status|preview|parse|current|config)(?:-|:|$)/u.test(channel);
}

async function collectTypeScriptFiles(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
    for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
    return files.sort();
}
