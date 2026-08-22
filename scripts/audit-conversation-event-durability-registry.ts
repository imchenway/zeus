import { readFile, readdir } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { classifyConversationEventDurability, conversationEventDurabilityRegistry, conversationEventTypeRegistry, type ConversationEventDurabilityLevel } from '../packages/local-server/src/eventFlowControl.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(repositoryRoot, 'packages/local-server/src');
const files = (await collectTypeScriptFiles(sourceRoot)).sort();
const discovered = new Map<string, Array<{ file: string; line: number; kind: string }>>();
const violations: string[] = [];

for (const absolutePath of files) {
  const sourceText = await readFile(absolutePath, 'utf8');
  const file = relative(repositoryRoot, absolutePath).split('\\').join('/');
  const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) discoverCallEvent(node, sourceFile, file);
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'type' && ts.isStringLiteralLike(node.initializer) && isConversationEventType(node.initializer.text) && /(?:Coordinator|index)\.ts$/u.test(basename(file))) {
      record(node.initializer.text, sourceFile, node, file, 'event_object_type');
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'publishNativeConversationEvent' && node.body) {
      const withinPublisher = (child: ts.Node): void => {
        if (ts.isStringLiteralLike(child) && isConversationEventType(child.text)) record(child.text, sourceFile, child, file, 'publisher_mapping');
        ts.forEachChild(child, withinPublisher);
      };
      withinPublisher(node.body);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const registryEntries = Object.entries(conversationEventTypeRegistry) as Array<[ConversationEventDurabilityLevel, readonly string[]]>;
const registeredTypes = registryEntries.flatMap(([, types]) => [...types]);
if (new Set(registeredTypes).size !== registeredTypes.length) violations.push('事件类型在多个耐久级别重复登记');
for (const [level, types] of registryEntries) {
  for (const type of types) {
    if (!isConversationEventType(type)) violations.push(`${level} 含非法事件类型：${type}`);
    if (conversationEventDurabilityRegistry[type] !== level || classifyConversationEventDurability(type) !== level) violations.push(`${type} 的 registry 与运行时分类不一致`);
  }
}
for (const [type, evidence] of discovered) {
  if (!(type in conversationEventDurabilityRegistry)) violations.push(`源码事件未精确登记：${type} (${evidence[0]?.file}:${evidence[0]?.line})`);
}

const eventFlowSource = await readFile(resolve(sourceRoot, 'eventFlowControl.ts'), 'utf8');
if (eventFlowSource.includes("type.startsWith('conversation.ui.')") || eventFlowSource.includes("type.endsWith('.progress')") || eventFlowSource.includes("type.endsWith('.delta')")) {
  violations.push('运行时仍使用前缀/后缀隐式降低事件耐久等级');
}
if (classifyConversationEventDurability('conversation.future.unregistered') !== 'critical_fact') violations.push('动态未知事件没有失败安全地提升为 critical_fact');

const byLevel = Object.fromEntries(registryEntries.map(([level, types]) => [level, types.length]));
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      status: violations.length === 0 ? 'passed' : 'failed',
      summary: {
        discoveredLiteralEventTypes: discovered.size,
        registeredEventTypes: registeredTypes.length,
        byLevel,
        unknownRuntimeFallback: 'critical_fact',
        implicitPrefixOrSuffixClassification: false,
      },
      scope: {
        included: ['Coordinator publish/broadcast 字面量', 'Pi publish 字面量', 'publishNativeConversationEvent 映射输入与输出', 'Coordinator 事件对象 type 字面量'],
        excluded: ['非会话 realtime 事件', 'Provider 将来版本在运行时传入的动态字符串；它们保守按 critical_fact 处理'],
      },
      discovered: [...discovered.entries()].map(([type, evidence]) => ({ type, durability: conversationEventDurabilityRegistry[type] ?? null, evidence })),
      violations,
    },
    null,
    2,
  )}\n`,
);

if (violations.length > 0) process.exitCode = 1;

function discoverCallEvent(node: ts.CallExpression, sourceFile: ts.SourceFile, file: string): void {
  const first = node.arguments[0];
  if (!first || !ts.isStringLiteralLike(first) || !isConversationEventType(first.text)) return;
  const callee = callName(node.expression);
  const supported = callee === 'publish' || callee === 'publishNativeConversationEvent' || callee.endsWith('.publish') || callee.endsWith('.broadcast');
  if (supported) record(first.text, sourceFile, node, file, `call:${callee}`);
}

function record(type: string, sourceFile: ts.SourceFile, node: ts.Node, file: string, kind: string): void {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const entries = discovered.get(type) ?? [];
  if (!entries.some((entry) => entry.file === file && entry.line === line && entry.kind === kind)) entries.push({ file, line, kind });
  discovered.set(type, entries);
}

function callName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`;
  return expression.getText();
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function isConversationEventType(value: string): boolean {
  return /^conversation\.[a-zA-Z0-9_.-]+$/u.test(value);
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
