import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

type EffectClass = 'git' | 'process' | 'worker' | 'after_commit' | 'projection' | 'polling';

interface EffectEntry {
  effectClass: EffectClass;
  file: string;
  line: number;
  callee: string;
}

const repositoryRoot = resolve(import.meta.dirname, '..');
const roots = [resolve(repositoryRoot, 'packages/local-server/src'), resolve(repositoryRoot, 'packages/ai-runtime/src')];
const files = (await Promise.all(roots.map(collectTypeScriptFiles))).flat().sort();
const entries: EffectEntry[] = [];
const sourceHash = createHash('sha256');

for (const path of files) {
  const source = await readFile(path, 'utf8');
  const file = relative(repositoryRoot, path).replaceAll('\\', '/');
  sourceHash.update(`${file}\0${source}\0`);
  discoverEffects(path, file, source);
}

const violations: string[] = [];
if (entries.length === 0) violations.push('未发现任何内部副作用调用，扫描范围或分类规则可能失效');
for (const file of files.filter((path) => path.includes('/renderer/'))) violations.push(`内部副作用扫描范围越过 Renderer：${file}`);

const grouped = Object.entries(
  entries.reduce<Record<string, number>>((counts, entry) => {
    const key = `${entry.effectClass}:${entry.file}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {}),
).map(([key, count]) => ({ key, count }));

console.log(
  JSON.stringify(
    {
      schemaVersion: 2,
      status: violations.length === 0 ? 'passed' : 'failed',
      generatedFrom: {
        roots: ['packages/local-server/src', 'packages/ai-runtime/src'],
        sha256: sourceHash.digest('hex'),
      },
      summary: {
        discoveredCallsites: entries.length,
        byClass: Object.fromEntries((['git', 'process', 'worker', 'after_commit', 'projection', 'polling'] as const).map((effectClass) => [effectClass, entries.filter((entry) => entry.effectClass === effectClass).length])),
        complete: violations.length === 0,
      },
      inventory: grouped,
      violations,
    },
    null,
    2,
  ),
);

if (process.argv.includes('--require-complete') && violations.length > 0) process.exitCode = 1;

function discoverEffects(path: string, file: string, source: string): void {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const gitMethods = new Set([
    'fetchGitRemote',
    'commitTaskWorkspace',
    'pushTaskWorkspace',
    'pushLocalBranch',
    'executeHighRiskGitOperation',
    'executeProjectGitAction',
    'prepareTaskWorktree',
    'cleanupPreparedTaskWorktree',
    'reclaimTaskWorktree',
    'reclaimDeliveredTaskWorktree',
    'removeTaskWorktreeForTerminalStatus',
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = callName(node.expression);
      const method = callee.split('.').at(-1) ?? callee;
      let effectClass: EffectClass | null = null;
      if (gitMethods.has(method)) effectClass = 'git';
      else if (method === 'afterCommit') effectClass = 'after_commit';
      else if (['enqueueIndexWrite', 'closeHeavyWorkerJobs'].includes(method)) effectClass = method === 'closeHeavyWorkerJobs' ? 'worker' : 'projection';
      else if (['setInterval', 'clearInterval', 'pollOnce'].includes(method)) effectClass = 'polling';
      else if (['fork', 'spawn', 'spawnSync', 'execFileAsync'].includes(method)) effectClass = file.includes('Worker') || callee.includes('worker') ? 'worker' : 'process';
      else if (['kill', 'terminate'].includes(method) && /(?:^|\.)(?:process|child|current|spawned|handle|socket|terminal)\.(?:kill|terminate)$/u.test(callee)) {
        effectClass = file.includes('Worker') || callee.includes('worker') ? 'worker' : 'process';
      } else if (method === 'send' && /(?:^|\.)(?:process|child|socket|prepared)\.send$/u.test(callee)) {
        effectClass = file.includes('Worker') || callee.includes('worker') ? 'worker' : 'process';
      }
      if (effectClass) {
        entries.push({
          effectClass,
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          callee,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function callName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression as ts.LeftHandSideExpression)}.${expression.name.text}`;
  if (ts.isElementAccessExpression(expression)) return callName(expression.expression as ts.LeftHandSideExpression);
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return callName(expression.expression as ts.LeftHandSideExpression);
  return expression.getText();
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const directoryEntries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of directoryEntries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(path);
  }
  return result;
}
