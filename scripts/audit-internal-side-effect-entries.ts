import {readdir, readFile} from 'node:fs/promises';
import {relative, resolve} from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import {gitMutatingCapabilityNames} from '../packages/git-core/src/index.js';
import {
    coreInternalSideEffectCapabilities,
    gitInternalSideEffectCapabilities,
    internalSideEffectCapabilityRegistry,
    internalSideEffectPolicies,
    processInternalSideEffectCapabilities
} from './internal-side-effect-registry.mjs';

interface RegistryPolicy {
  id: string;
  effectClass: string;
  identityBoundary: string;
  writeBoundary: string;
  recoveryBoundary: string;
  receiptBoundary: string;
  evidence: Array<{ file: string; markers: string[] }>;
}

interface RegistryCapability {
  id: string;
  capability?: string;
  policyId: string;
  selector?: Record<string, string>;
}

interface DiscoveredEntry {
  category: 'git' | 'core' | 'worker' | 'process';
  file: string;
  line: number;
  context: string;
  callee: string;
  capabilityId: string | null;
  policyId: string | null;
  effectClass: string | null;
}

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceRoots = [resolve(repositoryRoot, 'packages/local-server/src'), resolve(repositoryRoot, 'packages/ai-runtime/src')];
const files = (await Promise.all(sourceRoots.map((root) => collectTypeScriptFiles(root)))).flat().sort();
const policies = internalSideEffectPolicies as RegistryPolicy[];
const capabilities = internalSideEffectCapabilityRegistry as RegistryCapability[];
const coreCapabilities = coreInternalSideEffectCapabilities as RegistryCapability[];
const processCapabilities = processInternalSideEffectCapabilities as RegistryCapability[];
const policyById = new Map(policies.map((policy) => [policy.id, policy]));
const capabilityById = new Map(capabilities.map((capability) => [capability.id, capability]));
const managedReceivers = new Set(coreCapabilities.flatMap((entry) => (entry.selector?.kind === 'managed_receiver' && entry.selector.receiver ? [entry.selector.receiver] : [])));
const discovered: DiscoveredEntry[] = [];
const violations: string[] = [];

validateRegistryShape();
await validatePolicyEvidence();
await validateGitCapabilitySource();

for (const absolutePath of files) {
  const sourceText = await readFile(absolutePath, 'utf8');
  const file = normalizedRelativePath(absolutePath);
  const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const gitBindings = new Map<string, string>();
  const heavyWorkerBindings = new Map<string, string>();
  const childProcessBindings = new Map<string, string>();
  const processAliases = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const importClause = statement.importClause;
    if (!importClause || importClause.isTypeOnly || !importClause.namedBindings || !ts.isNamedImports(importClause.namedBindings)) continue;
    const moduleName = statement.moduleSpecifier.text;
    for (const element of importClause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      const local = element.name.text;
      if (moduleName === '@zeus/git-core') gitBindings.set(local, imported);
      if (moduleName === './heavyWorkerPool.js') heavyWorkerBindings.set(local, imported);
      if (moduleName === 'node:child_process') childProcessBindings.set(local, imported);
    }
  }

  const discoverAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = callName(node.initializer.expression);
      const firstArgument = node.initializer.arguments[0];
      if (callee === 'promisify' && firstArgument && ts.isIdentifier(firstArgument) && childProcessBindings.has(firstArgument.text)) processAliases.add(node.name.text);
    }
    ts.forEachChild(node, discoverAliases);
  };
  discoverAliases(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = callName(node.expression);
      const method = lastCalleeSegment(callee);
      const receiver = directReceiverName(node.expression);

      if (ts.isIdentifier(unwrapExpression(node.expression))) {
        const local = (unwrapExpression(node.expression) as ts.Identifier).text;
        const gitCapability = gitBindings.get(local);
        if (gitCapability && (gitMutatingCapabilityNames as readonly string[]).includes(gitCapability)) record('git', node, file, sourceFile, callee, `git:${gitCapability}`);

        const heavyCapability = heavyWorkerBindings.get(local);
        if (heavyCapability && heavyCapability !== 'heavyWorkerPoolSnapshot') record('worker', node, file, sourceFile, callee, `worker:${heavyCapability}`);

        if (childProcessBindings.has(local) || processAliases.has(local)) record('process', node, file, sourceFile, callee, findProcessCapability(file, callee));
      }

      if (method === 'afterCommit' && file.startsWith('packages/local-server/src/')) record('core', node, file, sourceFile, callee, 'core:afterCommit');

      if (receiver && managedReceivers.has(receiver)) {
        // snapshot 是显式只读诊断，不进入内部副作用清单；receiver 上其余新方法仍失败关闭。
        if (!(receiver === 'projectionDatabases' && method === 'snapshot')) record('core', node, file, sourceFile, callee, findManagedReceiverCapability(receiver, method));
      }

      if (callee === 'codexLegacyImportService.recover' || callee === 'codexLegacyImportService.close' || callee === 'codexNativeCoordinator.recover' || callee === 'codexNativeCoordinator.close') {
        record('core', node, file, sourceFile, callee, `core:${callee}`);
      }

      if (file === 'packages/local-server/src/workManagementTaskEffectService.ts' && callee === 'prepared.send') record('core', node, file, sourceFile, callee, 'core:prepared.send');

      if (isPollingCandidate(file, callee, method)) record('core', node, file, sourceFile, callee, findPollingCapability(file, callee, method));

      if (isProcessCandidate(file, callee, method, childProcessBindings)) record('process', node, file, sourceFile, callee, findProcessCapability(file, callee));

      if (file === 'packages/local-server/src/heavyWorkerPool.ts' && method === 'terminate') record('worker', node, file, sourceFile, callee, 'worker:worker.terminate');
      if (file === 'packages/local-server/src/heavyWorkerEntry.ts' && callee === 'parentPort.postMessage') record('worker', node, file, sourceFile, callee, 'worker:parentPort.postMessage');
    }

    if (ts.isNewExpression(node)) {
      const callee = callName(node.expression);
      if (file === 'packages/local-server/src/heavyWorkerPool.ts' && callee === 'Worker') record('worker', node, file, sourceFile, `new ${callee}`, 'worker:new Worker');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

validateDiscoveryCoverage();
await validateHeavyWorkerExports();

const policyCounts = Object.fromEntries(policies.map((policy) => [policy.id, discovered.filter((entry) => entry.policyId === policy.id).length]));
const effectClassCounts = Object.fromEntries([...new Set(policies.map((policy) => policy.effectClass))].map((effectClass) => [effectClass, discovered.filter((entry) => entry.effectClass === effectClass).length]));
const categoryCounts = Object.fromEntries(['git', 'core', 'worker', 'process'].map((category) => [category, discovered.filter((entry) => entry.category === category).length]));
const requireComplete = process.argv.includes('--require-complete');

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      status: violations.length === 0 ? 'passed' : 'failed',
      summary: {
        declaredCapabilities: capabilities.length,
        declaredPolicies: policies.length,
        discoveredCallsites: discovered.length,
        categoryCounts,
        effectClassCounts,
        policyCounts,
        complete: violations.length === 0,
      },
      scope: {
        included: [
          '@zeus/git-core 明确登记的写能力及 Local Server 调用点',
          'Core afterCommit、投影库、任务文件投影、任务外部通知与 Provider recovery 生命周期',
          'Heavy Worker 导出入口、Worker 创建/IPC/terminate',
          'AI Runtime/Provider 的 child process、PTY、IPC、socket 与跨重启进程信号原语',
          'Telegram polling 与 Execution Host handoff 的 timer/轮询接纳边界',
        ],
        excluded: [
          '203 个公共 HTTP/Provider Command 本身（由 audit-command-side-effect-entries.mjs 管理）',
          'Electron Main IPC/OS bridge（由 audit-electron-main-side-effect-entries.mjs 管理）',
          '普通读查询、WebSocket reply.send 与纯内存计算',
          '真实 Provider、正式数据库与云环境时序；本审计不声称 exactly-once',
        ],
      },
      requireComplete,
      entries: discovered,
      violations,
    },
    null,
    2,
  )}\n`,
);

if (violations.length > 0) process.exitCode = 1;

function record(category: DiscoveredEntry['category'], node: ts.Node, file: string, sourceFile: ts.SourceFile, callee: string, capabilityId: string | null): void {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const policyId = capabilityId ? (capabilityById.get(capabilityId)?.policyId ?? null) : null;
  const entry: DiscoveredEntry = {
    category,
    file,
    line: position.line + 1,
    context: enclosingContext(node),
    callee,
    capabilityId,
    policyId,
    effectClass: policyId ? (policyById.get(policyId)?.effectClass ?? null) : null,
  };
  if (!discovered.some((candidate) => candidate.file === entry.file && candidate.line === entry.line && candidate.category === entry.category && candidate.callee === entry.callee)) discovered.push(entry);
}

function validateRegistryShape(): void {
  if (new Set(policies.map((policy) => policy.id)).size !== policies.length) violations.push('内部副作用 policy ID 重复');
  if (new Set(capabilities.map((capability) => capability.id)).size !== capabilities.length) violations.push('内部副作用 capability ID 重复');
  for (const policy of policies) {
    if (!policy.effectClass || !policy.identityBoundary.trim() || !policy.writeBoundary.trim() || !policy.recoveryBoundary.trim() || !policy.receiptBoundary.trim()) violations.push(`policy ${policy.id} 缺少身份/写入/恢复/回执语义`);
    if (!Array.isArray(policy.evidence) || policy.evidence.length === 0) violations.push(`policy ${policy.id} 没有运行时证据`);
  }
  for (const capability of capabilities) {
    if (!policyById.has(capability.policyId)) violations.push(`capability ${capability.id} 引用了未知 policy ${capability.policyId}`);
  }
  const runtimeGit = [...gitMutatingCapabilityNames].sort();
  const declaredGit = (gitInternalSideEffectCapabilities as Array<{ capability: string }>).map((entry) => entry.capability).sort();
  if (!sameStringArray(runtimeGit, declaredGit)) violations.push(`Git 写能力单一来源与内部清单漂移：runtime=${runtimeGit.join(',')} registry=${declaredGit.join(',')}`);
}

async function validatePolicyEvidence(): Promise<void> {
  for (const policy of policies) {
    for (const evidence of policy.evidence) {
      const content = await readFile(resolve(repositoryRoot, evidence.file), 'utf8').catch(() => null);
      if (content === null) {
        violations.push(`policy ${policy.id} 缺少证据文件 ${evidence.file}`);
        continue;
      }
      for (const marker of evidence.markers) if (!content.includes(marker)) violations.push(`policy ${policy.id} 在 ${evidence.file} 缺少 marker ${marker}`);
    }
  }
}

async function validateGitCapabilitySource(): Promise<void> {
  const file = resolve(repositoryRoot, 'packages/git-core/src/index.ts');
  const text = await readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exportedFunctions = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    exportedFunctions.add(statement.name.text);
  }
  for (const capability of gitMutatingCapabilityNames) if (!exportedFunctions.has(capability)) violations.push(`Git 写能力 ${capability} 不再是 @zeus/git-core 的 exported function`);
}

function validateDiscoveryCoverage(): void {
  for (const entry of discovered) {
    if (!entry.capabilityId) violations.push(`未登记内部副作用：${entry.file}:${entry.line} ${entry.callee}`);
    else if (!capabilityById.has(entry.capabilityId)) violations.push(`调用点引用未知 capability：${entry.file}:${entry.line} ${entry.capabilityId}`);
    else if (!entry.policyId || !entry.effectClass) violations.push(`调用点没有完整 policy：${entry.file}:${entry.line} ${entry.capabilityId}`);
  }

  for (const capability of [...coreCapabilities, ...processCapabilities]) {
    if (!discovered.some((entry) => entry.capabilityId === capability.id)) violations.push(`内部副作用 capability 已陈旧或未被动态发现：${capability.id}`);
  }
}

async function validateHeavyWorkerExports(): Promise<void> {
  const file = resolve(repositoryRoot, 'packages/local-server/src/heavyWorkerPool.ts');
  const text = await readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exportedFunctions = sourceFile.statements.flatMap((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ? [statement.name.text] : [],
  );
  for (const name of exportedFunctions) {
    if (name === 'heavyWorkerPoolSnapshot') continue;
    if (!capabilityById.has(`worker:${name}`)) violations.push(`Heavy Worker 新增未登记 runtime export：${name}`);
  }
}

function findManagedReceiverCapability(receiver: string, method: string): string | null {
  return coreCapabilities.find((entry) => entry.selector?.kind === 'managed_receiver' && entry.selector.receiver === receiver && entry.selector.method === method)?.id ?? null;
}

function findPollingCapability(file: string, callee: string, method: string): string | null {
  const matches = coreCapabilities.filter((entry) => {
    const selector = entry.selector;
    if (!selector || selector.file !== file) return false;
    if (selector.kind === 'file_callee') return selector.callee === callee;
    return selector.kind === 'file_method_name' && selector.method === method;
  });
  return matches.length === 1 ? matches[0]!.id : null;
}

function findProcessCapability(file: string, callee: string): string | null {
  const normalized = callee.replace(/^new /u, '');
  return processCapabilities.find((entry) => entry.selector?.file === file && entry.selector.callee === normalized)?.id ?? null;
}

function isPollingCandidate(file: string, callee: string, method: string): boolean {
  if (file !== 'packages/local-server/src/telegramPollingApi.ts' && file !== 'packages/local-server/src/executionHostHandoffApi.ts') return false;
  return callee === 'setInterval' || callee === 'clearInterval' || method === 'start' || method === 'stop' || method === 'pollOnce';
}

function isProcessCandidate(file: string, callee: string, method: string, childProcessBindings: ReadonlyMap<string, string>): boolean {
  const first = callee.split('.')[0] ?? callee;
  if (childProcessBindings.has(first)) return true;
  if (callee === 'process.kill' || callee === 'process.send') return file.startsWith('packages/ai-runtime/src/') || file === 'packages/local-server/src/index.ts' || file === 'packages/local-server/src/runtimeProcessIdentity.ts';
  if (file === 'packages/ai-runtime/src/index.ts') return callee === 'pty.spawn' || method === 'kill';
  if (file === 'packages/ai-runtime/src/codexAppServerManager.ts') return method === 'kill' || callee === 'socket.send' || callee === 'socket.terminate';
    if (file === 'packages/ai-runtime/src/codexRuntimeGenerationManager.ts') return method === 'kill';
  if (file === 'packages/ai-runtime/src/piRuntimeWorkerDriver.ts') return method === 'send' || method === 'kill';
  return false;
}

function callName(expression: ts.Expression): string {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) return `${callName(unwrapped.expression)}.${unwrapped.name.text}`;
  if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression && ts.isStringLiteralLike(unwrapped.argumentExpression)) return `${callName(unwrapped.expression)}.${unwrapped.argumentExpression.text}`;
  return unwrapped.getText();
}

function directReceiverName(expression: ts.Expression): string | null {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) return null;
  const receiver = unwrapExpression(unwrapped.expression);
  return ts.isIdentifier(receiver) ? receiver.text : null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression;
  return current;
}

function lastCalleeSegment(callee: string): string {
  return callee.split('.').at(-1) ?? callee;
}

function enclosingContext(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isPropertyAssignment(current)) return current.name.getText();
    current = current.parent;
  }
  return '<module>';
}

function normalizedRelativePath(absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split('\\').join('/');
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) output.push(path);
  }
  return output;
}
