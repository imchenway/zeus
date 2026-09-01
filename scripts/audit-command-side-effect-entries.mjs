#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const repositoryRoot = resolve(process.cwd());
const sourceRoot = join(repositoryRoot, 'packages/local-server/src');

const slices = [
  slice('conversation', ['--require-conversation-slice', '--require-conversation-command-slice'], ['conversationCommandApplication.ts', 'conversationCommandRoutes.ts'], ['features/conversations/conversationCommandClient.ts']),
  slice('conversation-dispatch', ['--require-conversation-dispatch-command-slice'], ['conversationDispatchCommandApplication.ts', 'conversationDispatchCommandRoutes.ts'], ['features/conversations/conversationDispatchCommandClient.ts']),
  slice('integration', ['--require-integration-command-slice'], ['integrationCommandApplication.ts', 'integrationCommandRoutes.ts'], ['features/integrations/integrationCommandClient.ts']),
  slice('settings', ['--require-settings-command-slice'], ['settingsCommandApplication.ts', 'localServerPlatformRoutes.ts'], ['features/settings/settingsCommandClient.ts']),
  slice('telegram', ['--require-telegram-command-slice'], ['telegramCommandApplication.ts', 'telegramPollingApi.ts'], ['features/telegram/telegramCommandClient.ts']),
  slice('git', ['--require-git-command-slice'], ['gitCommandApplication.ts', 'gitCommandRoutes.ts'], ['features/git/gitCommandClient.ts']),
  slice('workspace-git', ['--require-workspace-git-command-slice'], ['workspaceGitCommandApplication.ts', 'workspaceGitCommandRoutes.ts'], ['features/git/workspaceGitCommandClient.ts']),
  slice('graph-conversation', ['--require-graph-conversation-create-command-slice'], ['graphConversationCommandApplication.ts', 'graphConversationCommandRoutes.ts'], ['features/conversations/graphConversationCommandClient.ts']),
  slice('work-management-task', ['--require-work-management-task-command-slice'], ['workManagementCommandApplication.ts', 'workManagementTaskCommandRoutes.ts'], ['features/work-management/workManagementCommandClient.ts']),
  slice('execution-host-stop', ['--require-execution-host-stop-command-slice'], ['executionHostStopCommandApplication.ts', 'executionHostControlApi.ts'], [], ['apps/desktop/src/main/executionHostStopCommand.ts']),
];

const files = await collectTypeScriptFiles(sourceRoot);
const sources = new Map();
const sourceHash = createHash('sha256');
for (const path of files) {
  const file = relative(repositoryRoot, path).replaceAll('\\', '/');
  const content = await readFile(path, 'utf8');
  sources.set(file, content);
  sourceHash.update(`${file}\0${content}\0`);
}

const routes = files.flatMap((path) => discoverMutatingRoutes(path, sources.get(relative(repositoryRoot, path).replaceAll('\\', '/')) ?? ''));
const violations = [];
const sliceStatus = Object.fromEntries(await Promise.all(slices.map(async (entry) => [entry.id, await verifySlice(entry, violations)])));
const requestedSlices = slices.filter((entry) => entry.flags.some((flag) => process.argv.includes(flag)));
for (const entry of requestedSlices) {
  if (!sliceStatus[entry.id]) violations.push(`${entry.id} 命令切片不完整`);
}

const commandRouteFiles = [...new Set(routes.filter((route) => route.file.endsWith('CommandRoutes.ts')).map((route) => route.file))];
for (const file of commandRouteFiles) {
  const source = sources.get(file) ?? '';
  if (!/(?:CommandApplication|Commands|commandTypes|\.execute\(|\.parse<|parse[A-Za-z]*Command)/u.test(source)) violations.push(`${file} 未引用命令应用或命令解析器`);
}
if (routes.length === 0) violations.push('未发现 Local Server mutation route');

const report = {
  schemaVersion: 2,
  generatedFrom: { root: 'packages/local-server/src', sha256: sourceHash.digest('hex') },
  summary: {
    routes: routes.length,
    commandRoutes: routes.filter((route) => route.classification === 'command').length,
    boundedOperations: routes.filter((route) => route.classification === 'bounded_operation').length,
    files: new Set(routes.map((route) => route.file)).size,
    complete: violations.length === 0,
  },
  slices: sliceStatus,
  violations,
  inventory: Object.entries(
    routes.reduce((counts, route) => {
      const key = `${route.classification}:${route.file}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
  ).map(([key, count]) => ({ key, count })),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if ((process.argv.includes('--require-complete') || requestedSlices.length > 0) && violations.length > 0) process.exitCode = 2;

function slice(id, flags, serverFiles, rendererFiles, extraFiles = []) {
  return { id, flags, serverFiles, rendererFiles, extraFiles };
}

async function verifySlice(entry, violations) {
  let ready = true;
  for (const name of entry.serverFiles) {
    const file = `packages/local-server/src/${name}`;
    const source = sources.get(file);
    if (!source || !/(?:command|Command|Envelope)/u.test(source)) {
      violations.push(`${entry.id} 缺少服务端命令边界：${file}`);
      ready = false;
    }
  }
  for (const name of entry.rendererFiles) {
    const file = `apps/desktop/src/renderer/${name}`;
    const source = await readOptional(file);
    if (!source.includes('commandRequest.js')) {
      violations.push(`${entry.id} Renderer 未复用统一命令构造器：${file}`);
      ready = false;
    }
  }
  for (const file of entry.extraFiles) {
    const source = await readOptional(file);
    if (!/(?:CommandEnvelope|CommandRequest|commandEnvelopeSchemaGeneration)/u.test(source)) {
      violations.push(`${entry.id} 缺少显式 CommandEnvelope：${file}`);
      ready = false;
    }
  }
  return ready;
}

async function readOptional(relativePath) {
  try {
    return await readFile(join(repositoryRoot, relativePath), 'utf8');
  } catch {
    return '';
  }
}

function discoverMutatingRoutes(path, source) {
  const file = relative(repositoryRoot, path).replaceAll('\\', '/');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const entries = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['post', 'put', 'patch', 'delete'].includes(node.expression.name.text)) {
      const route = node.arguments[0];
      if (route && (ts.isStringLiteral(route) || ts.isNoSubstitutionTemplateLiteral(route))) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const command = file.endsWith('CommandRoutes.ts') || /(?:CommandApplication|\.parse<|parse[A-Za-z]*Command)/u.test(source.slice(node.getStart(sourceFile), node.end));
        entries.push({
          file,
          line,
          operation: `${node.expression.name.text.toUpperCase()} ${route.text}`,
          classification: command ? 'command' : 'bounded_operation',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries;
}

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}
