import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { commandConcurrencyPolicies, commandGovernanceStateMachines } from '../packages/shared/src/commandGovernance.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const violations: string[] = [];
const policyIds = new Set(commandConcurrencyPolicies.map((policy) => policy.id));
const machineIds = new Set<string>();

for (const machine of commandGovernanceStateMachines) {
  if (machineIds.has(machine.id)) violations.push(`状态机 ID 重复：${machine.id}`);
  machineIds.add(machine.id);
  const states = [...machine.states];
  const stateSet = new Set(states);
  if (states.length === 0 || stateSet.size !== states.length) violations.push(`${machine.id} 状态集合为空或重复`);
  const transitionKeys = Object.keys(machine.transitions);
  if (!sameStringSet(transitionKeys, states)) violations.push(`${machine.id} transition key 与状态集合不一致`);
  for (const [from, targets] of Object.entries(machine.transitions)) {
    if (new Set(targets).size !== targets.length) violations.push(`${machine.id}.${from} 含重复目标`);
    for (const target of targets) {
      if (!stateSet.has(target)) violations.push(`${machine.id}.${from} 指向未知状态 ${target}`);
    }
  }
  for (const terminal of machine.terminalStates) {
    if (!stateSet.has(terminal)) violations.push(`${machine.id} 终态 ${terminal} 不在状态集合`);
    if ((machine.transitions[terminal] ?? []).length > 0) violations.push(`${machine.id} 终态 ${terminal} 仍有出边`);
  }
  for (const policyId of machine.concurrencyPolicyIds) {
    if (!policyIds.has(policyId)) violations.push(`${machine.id} 引用了未知并发策略 ${policyId}`);
  }
  const sourceStates = await readStringUnion(machine.stateType.file, machine.stateType.exportName);
  if (!sourceStates) violations.push(`${machine.id} 找不到状态联合类型 ${machine.stateType.file}#${machine.stateType.exportName}`);
  else if (!sameStringSet(sourceStates, states)) {
    violations.push(`${machine.id} 注册状态与运行时联合类型漂移：registry=${states.join(',')} source=${sourceStates.join(',')}`);
  }
}

if (machineIds.size !== commandGovernanceStateMachines.length) violations.push('状态机注册表 ID 不是唯一集合');

const seenPolicyIds = new Set<string>();
for (const policy of commandConcurrencyPolicies) {
  if (seenPolicyIds.has(policy.id)) violations.push(`并发策略 ID 重复：${policy.id}`);
  seenPolicyIds.add(policy.id);
  if (policy.sourceFiles.length === 0 || policy.evidenceMarkers.length === 0 || !policy.semantics.trim()) violations.push(`${policy.id} 缺少 source/evidence/semantics`);
  const sources = await Promise.all(
    policy.sourceFiles.map(async (file) => ({
      file,
      content: await readFile(resolve(repositoryRoot, file), 'utf8').catch(() => null),
    })),
  );
  for (const source of sources) {
    if (source.content === null) violations.push(`${policy.id} 找不到证据文件 ${source.file}`);
  }
  const combined = sources.map((source) => source.content ?? '').join('\n');
  for (const marker of policy.evidenceMarkers) {
    if (!combined.includes(marker)) violations.push(`${policy.id} 缺少运行时证据 marker：${marker}`);
  }
}

const categoryCounts = Object.fromEntries((['command', 'provider', 'recovery'] as const).map((category) => [category, commandGovernanceStateMachines.filter((machine) => machine.category === category).length]));

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      status: violations.length === 0 ? 'passed' : 'failed',
      summary: {
        stateMachines: commandGovernanceStateMachines.length,
        concurrencyPolicies: commandConcurrencyPolicies.length,
        categoryCounts,
        exactRuntimeStateTypes: commandGovernanceStateMachines.length - violations.filter((violation) => violation.includes('联合类型')).length,
      },
      scope: {
        included: ['主要 Command/Provider/Recovery 状态词汇与允许转移', '不可变命令身份、revision/updatedAt、Provider generation、handoff CAS、存储重启核验与离线恢复租约'],
        excluded: ['产品自定义任务看板状态', '真实 Provider/文件系统故障时序', '跨系统 exactly-once 保证'],
      },
      violations,
    },
    null,
    2,
  )}\n`,
);

if (violations.length > 0) process.exitCode = 1;

async function readStringUnion(relativePath: string, exportName: string): Promise<string[] | null> {
  const absolutePath = resolve(repositoryRoot, relativePath);
  const sourceText = await readFile(absolutePath, 'utf8').catch(() => null);
  if (sourceText === null) return null;
  const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let result: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === exportName) result = stringLiteralsFromType(node.type);
    if (result === null) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function stringLiteralsFromType(type: ts.TypeNode): string[] | null {
  const nodes = ts.isUnionTypeNode(type) ? type.types : [type];
  const values: string[] = [];
  for (const node of nodes) {
    if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) return null;
    values.push(node.literal.text);
  }
  return values;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
