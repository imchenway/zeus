import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { httpReadEffectPolicy } from './http-read-effect-policy.mjs';

const repositoryRoot = resolve(process.cwd());
const sourceRoot = join(repositoryRoot, 'packages/local-server/src');
const requireClean = process.argv.includes('--require-clean');
const files = (await collectTypeScriptFiles(sourceRoot)).sort();
const configPath = join(repositoryRoot, 'packages/local-server/tsconfig.json');
const configRead = ts.readConfigFile(configPath, ts.sys.readFile);
if (configRead.error) throw new Error(ts.flattenDiagnosticMessageText(configRead.error.messageText, '\n'));
const parsedConfig = ts.parseJsonConfigFileContent(configRead.config, ts.sys, dirname(configPath), {}, configPath);
const program = ts.createProgram({ rootNames: parsedConfig.fileNames, options: parsedConfig.options, projectReferences: parsedConfig.projectReferences });
const checker = program.getTypeChecker();
const sourceHash = createHash('sha256');
const entries = [];
const sources = new Map();
const sourceFiles = new Map();
const imports = new Map();
const compiledCallRules = httpReadEffectPolicy.callRules.map((rule) => ({ ...rule, patterns: rule.calleePatterns.map((pattern) => new RegExp(pattern, 'u')) }));
const compiledRouteRules = httpReadEffectPolicy.routeRules.map((rule) => ({ ...rule, patterns: rule.operationPatterns.map((pattern) => new RegExp(pattern, 'u')) }));
const compiledPureCalls = httpReadEffectPolicy.pureCallPatterns.map((pattern) => new RegExp(pattern, 'u'));

const directMutationFunctions = new Set(['appendAuditLog', 'persistReadonlyGitDiffSnapshot', 'publishGitDiffUpdatedEvent', 'publishRealtimeEvent']);
const mutationMethodNames = new Set(['append', 'archive', 'clear', 'create', 'delete', 'enqueue', 'ensureReady', 'fail', 'prepare', 'recover', 'refresh', 'remove', 'restore', 'save', 'setJson', 'start', 'stop', 'update', 'write']);
const safeReceiverRoots = new Set(['Array', 'Boolean', 'Buffer', 'Date', 'JSON', 'Math', 'Number', 'Object', 'Promise', 'Reflect', 'String', 'URL', 'console', 'reply', 'request']);
const riskyPackageEffects = new Map([
  ['@zeus/ai-runtime', 'process_runtime'],
  ['@zeus/git-core', 'git'],
  ['@zeus/security-core', 'keychain'],
  ['@zeus/telegram-adapter', 'provider_network'],
  ['@zeus/release-core', 'provider_network'],
  ['node:child_process', 'process_runtime'],
  ['node:fs', 'filesystem_workspace'],
  ['node:fs/promises', 'filesystem_workspace'],
  ['node:http', 'provider_network'],
  ['node:https', 'provider_network'],
  ['node:net', 'provider_network'],
]);

for (const absolutePath of files) {
  const content = await readFile(absolutePath, 'utf8');
  const file = normalizePath(relative(repositoryRoot, absolutePath));
  const sourceFile = program.getSourceFile(absolutePath);
  if (!sourceFile) throw new Error(`TypeScript Program did not include ${file}`);
  sources.set(file, content);
  sourceFiles.set(file, sourceFile);
  sourceHash.update(`${file}\0${content}\0`);
  collectImports(sourceFile, file);
}

const policySource = await readFile(join(repositoryRoot, 'scripts/http-read-effect-policy.mjs'), 'utf8');
sourceHash.update(`scripts/http-read-effect-policy.mjs\0${policySource}\0`);

for (const [file, sourceFile] of sourceFiles) visitRoutes(sourceFile, sourceFile, file);

entries.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.operation.localeCompare(right.operation));
const evidence = await inspectValidationEvidence();
const requiredOperationValidation = validateRequiredOperations(evidence);
const globalPolicyIssues = requiredOperationValidation.policyIssues;
const globalEvidenceIssues = requiredOperationValidation.evidenceIssues;
for (const entry of entries) applyRoutePolicy(entry, evidence);

const pending = entries.filter((entry) => entry.status === 'pending_hidden_side_effect' || entry.status === 'pending_read_policy');
const statusCounts = countBy(entries, (entry) => entry.status);
const effectCounts = Object.fromEntries(Object.keys(httpReadEffectPolicy.effects).map((effect) => [effect, entries.filter((entry) => entry.effectPorts.includes(effect)).length]));
const externalEntries = entries.filter((entry) => entry.externalEffectPorts.length > 0);
const policyComplete = entries.every((entry) => entry.policyIssues.length === 0) && globalPolicyIssues.length === 0;
const evidenceComplete = entries.every((entry) => entry.evidenceIssues.length === 0) && globalEvidenceIssues.length === 0 && evidence.requiredMarkersPresent && evidence.ordinaryPurityMarkersPresent;
const policyEvidenceComplete = policyComplete && evidenceComplete;
const inventory = {
  schemaVersion: 2,
  generatedFrom: { root: 'packages/local-server/src', policy: 'scripts/http-read-effect-policy.mjs', sha256: sourceHash.digest('hex') },
  scope: {
    included: [
      'Local Server GET/HEAD registrations including identifier handlers',
      'same-file and relative-import helper call graph',
      'declared cross-package and dependency-injected effect ports',
      'read_only_validation fence regex plus behavior-verifier evidence',
    ],
    excluded: ['dynamic calls whose concrete target cannot be resolved; these are emitted as unknown_external and fail --require-clean'],
  },
  summary: {
    total: entries.length,
    byStatus: statusCounts,
    byEffect: effectCounts,
    externalTotal: externalEntries.length,
    unknownExternalTotal: entries.filter((entry) => entry.effectPorts.includes('unknown_external')).length,
    policyComplete,
    evidenceComplete,
    policyEvidenceComplete,
    complete: pending.length === 0 && globalPolicyIssues.length === 0 && globalEvidenceIssues.length === 0,
  },
  semantics: {
    effects: httpReadEffectPolicy.effects,
    pending_hidden_side_effect: 'GET/HEAD 内存在直接或传递 mutation；必须迁为 Command、移到启动恢复或删除写入。',
    pending_read_policy: '存在未知 external callee，或非 copied_db 外部读取缺少可机读 fail-closed policy/fence/行为证据。',
    read_only_external_fail_closed: '普通模式执行只读外部端口；read_only_validation 在 handler/record/path 解析前失败关闭。',
  },
  validationEvidence: {
    fenceFunction: httpReadEffectPolicy.validationEvidence.fenceFunction,
    blockedPatternCount: evidence.fencePatterns.length,
    verifierPathCount: evidence.verifierPaths.size,
    requiredMarkersPresent: evidence.requiredMarkersPresent,
    ordinaryPurityVerifier: httpReadEffectPolicy.ordinaryPurityEvidence.verifierFile,
    ordinaryPurityMarkersPresent: evidence.ordinaryPurityMarkersPresent,
  },
  policyIssues: globalPolicyIssues,
  evidenceIssues: globalEvidenceIssues,
  entries,
};

process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
if (requireClean && !inventory.summary.complete) {
  process.stderr.write(
    `HTTP read effect-port gate failed closed: ${pending.length} route issue(s), ${globalPolicyIssues.length} global policy issue(s), ${globalEvidenceIssues.length} global evidence issue(s), ${inventory.summary.unknownExternalTotal} unknown external callee route(s).\n`,
  );
  process.exitCode = 2;
}

function collectImports(sourceFile, file) {
  const fileImports = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) fileImports.set(clause.name.text, { module, imported: 'default', targetFile: resolveRelativeImport(file, module) });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        fileImports.set(element.name.text, { module, imported: element.propertyName?.text ?? element.name.text, targetFile: resolveRelativeImport(file, module) });
      }
    }
  }
  imports.set(file, fileImports);
}

function visitRoutes(node, sourceFile, file) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const receiver = node.expression.expression.getText(sourceFile);
    if ((method === 'get' || method === 'head') && ['server', 'options.server', 'ports.server'].includes(receiver)) {
      const route = routeText(node.arguments[0], sourceFile);
      const handlerExpression = [...node.arguments].reverse().find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument) || ts.isIdentifier(argument));
      entries.push(classifyHandler({ file, method, route, handlerExpression, sourceFile, registration: node }));
    }
  }
  ts.forEachChild(node, (child) => visitRoutes(child, sourceFile, file));
}

function classifyHandler(input) {
  const operation = `${input.method.toUpperCase()} ${input.route}`;
  const location = input.sourceFile.getLineAndCharacterOfPosition(input.registration.getStart(input.sourceFile));
  const state = { effects: new Map(), mutations: new Set(), unknownExternalCalls: new Set(), traversedCallables: new Set() };
  const handler = resolveCallableExpression(input.file, input.handlerExpression);
  if (handler) inspectCallable(handler.node, handler.file, state, [`handler:${operation}`], new Set());
  else state.unknownExternalCalls.add(input.handlerExpression?.getText(input.sourceFile) ?? '<missing handler>');

  if (operation === 'GET /api/events') {
    state.mutations.delete('ports.subscribers.add');
    state.mutations.delete('ports.subscribers.delete');
  }
  const effectPorts = [...state.effects.keys()].sort();
  return {
    id: createHash('sha256').update(`${input.file}\0${operation}`).digest('hex').slice(0, 20),
    file: input.file,
    line: location.line + 1,
    operation,
    status: state.mutations.size > 0 ? 'pending_hidden_side_effect' : 'read_only',
    effectPorts,
    externalEffectPorts: [],
    effectEvidence: [...state.effects.entries()]
      .flatMap(([effect, values]) => [...values.values()].map((value) => ({ effect, ...value })))
      .sort((left, right) => left.effect.localeCompare(right.effect) || left.callee.localeCompare(right.callee)),
    mutationCalls: [...state.mutations].sort(),
    unknownExternalCalls: [...state.unknownExternalCalls].sort(),
    traversedCallables: [...state.traversedCallables].sort(),
    policyIds: [],
    policyIssues: [],
    evidenceIssues: [],
  };
}

function inspectCallable(node, file, state, callPath, visiting) {
  const visitKey = `${file}:${node.pos}:${node.end}`;
  if (visiting.has(visitKey)) return;
  const nextVisiting = new Set(visiting).add(visitKey);
  state.traversedCallables.add(visitKey);
  const sourceFile = sourceFiles.get(file);
  if (!sourceFile) return;
  const body = node.body ?? node;

  const walk = (current) => {
    if (current !== body && isFunctionLike(current)) return;
    if (ts.isCallExpression(current)) {
      inspectCall(current, file, sourceFile, state, callPath, nextVisiting);
      for (const argument of current.arguments) {
        if (isFunctionLike(argument)) inspectCallable(argument, file, state, [...callPath, 'inline-callback'], nextVisiting);
        else walk(argument);
      }
      walk(current.expression);
      return;
    }
    ts.forEachChild(current, walk);
  };
  walk(body);
}

function inspectCall(node, file, sourceFile, state, callPath, visiting) {
  const callee = node.expression.getText(sourceFile).replace(/\s+/gu, '');
  let classified = false;
  let terminalDeclaration = false;
  for (const rule of compiledCallRules) {
    if (!rule.patterns.some((pattern) => pattern.test(callee))) continue;
    classified = true;
    terminalDeclaration ||= rule.terminal === true;
    addEffect(state, rule.effect, { callee, ruleId: rule.id, callPath: callPath.join(' -> ') });
  }
  const importedEffect = effectForImportedCall(file, node.expression, callee);
  if (importedEffect) {
    classified = true;
    addEffect(state, importedEffect.effect, { callee, ruleId: importedEffect.ruleId, callPath: callPath.join(' -> ') });
  }

  if (directMutationFunctions.has(callee) || (ts.isIdentifier(node.expression) && /^(?:persist|publish|recover|schedule|start|stop|write)/u.test(callee))) {
    state.mutations.add(callee);
  } else if (ts.isPropertyAccessExpression(node.expression) && mutationMethodNames.has(node.expression.name.text) && !isAllowedResponseWrite(callee)) {
    state.mutations.add(callee);
  }

  const target = resolveCallTarget(node.expression);
  if (target && !terminalDeclaration) {
    inspectCallable(target.node, target.file, state, [...callPath, `${target.file}:${target.name}`], visiting);
    return;
  }
  if (isPotentialUnknownExternalCall(file, node.expression, callee) && !classified) {
    state.unknownExternalCalls.add(callee);
    addEffect(state, 'unknown_external', { callee, ruleId: 'unresolved-external-callee', callPath: callPath.join(' -> ') });
  }
}

function addEffect(state, effect, evidence) {
  const values = state.effects.get(effect) ?? new Map();
  values.set(`${evidence.callee}\0${evidence.ruleId}\0${evidence.callPath}`, evidence);
  state.effects.set(effect, values);
}

function resolveCallableExpression(file, expression) {
  if (!expression) return null;
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return { file, name: '<inline>', node: expression };
  if (ts.isIdentifier(expression)) return resolveSymbolCallable(expression);
  return null;
}

function resolveCallTarget(expression) {
  if (ts.isIdentifier(expression)) return resolveSymbolCallable(expression);
  if (ts.isPropertyAccessExpression(expression)) return resolvePropertyCallable(expression);
  return null;
}

function resolvePropertyCallable(expression) {
  let symbol = checker.getSymbolAtLocation(expression.name);
  if (!symbol) return null;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  for (const declaration of symbol.declarations ?? []) {
    let node = null;
    if (ts.isMethodDeclaration(declaration) && declaration.body) node = declaration;
    if (ts.isPropertyDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) node = declaration.initializer;
    if (!node) continue;
    const absolutePath = declaration.getSourceFile().fileName;
    const file = normalizePath(relative(repositoryRoot, absolutePath));
    if (!file.startsWith('packages/local-server/src/')) continue;
    return { file, name: symbol.name, node };
  }
  return null;
}

function resolveSymbolCallable(expression) {
  let symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) return null;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  for (const declaration of symbol.declarations ?? []) {
    let node = null;
    if (ts.isFunctionDeclaration(declaration) && declaration.body) node = declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) node = declaration.initializer;
    if (!node) continue;
    const absolutePath = declaration.getSourceFile().fileName;
    const file = normalizePath(relative(repositoryRoot, absolutePath));
    if (!file.startsWith('packages/local-server/src/')) continue;
    return { file, name: symbol.name, node };
  }
  return null;
}

function isPotentialUnknownExternalCall(file, expression, callee) {
  if (compiledPureCalls.some((pattern) => pattern.test(callee))) return false;
  if (ts.isIdentifier(expression)) {
    const imported = imports.get(file)?.get(expression.text);
    if (imported && riskyPackageEffects.has(imported.module)) return true;
    return /^(?:check|connect|fetch|load|probe|read|request|resolve|scan|status)/u.test(expression.text) && Boolean(imported);
  }
  if (!ts.isPropertyAccessExpression(expression)) return false;
  if (isTypeScriptLibraryProperty(expression.name)) return false;
  const sourceFile = sourceFiles.get(file);
  if (!sourceFile) return true;
  const receiver = expression.expression.getText(sourceFile);
  const root = receiver.split(/[.[]/u, 1)[0] ?? receiver;
  if (safeReceiverRoots.has(root)) return false;
  if (/^(?:options|ports)(?:\.|$)/u.test(receiver)) return true;
  return /(?:adapter|client|git|keychain|manager|network|process|provider|runtime|secret|service|worker)/iu.test(receiver);
}

function effectForImportedCall(file, expression, callee) {
  if (!ts.isIdentifier(expression) || compiledPureCalls.some((pattern) => pattern.test(callee))) return null;
  const imported = imports.get(file)?.get(expression.text);
  const effect = imported ? riskyPackageEffects.get(imported.module) : undefined;
  return effect ? { effect, ruleId: `package-effect:${imported.module}` } : null;
}

function isTypeScriptLibraryProperty(name) {
  let symbol = checker.getSymbolAtLocation(name);
  if (!symbol) return false;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return (symbol.declarations ?? []).some((declaration) => /(?:^|\/)typescript\/lib\/lib\.[^/]+\.d\.ts$/u.test(normalizePath(declaration.getSourceFile().fileName)));
}

function applyRoutePolicy(entry, evidence) {
  const matchingRules = compiledRouteRules.filter((rule) => rule.patterns.some((pattern) => pattern.test(entry.operation)));
  entry.policyIds = matchingRules.map((rule) => rule.id).sort();
  for (const rule of matchingRules) {
    for (const effect of rule.effects) {
      if (!entry.effectPorts.includes(effect)) {
        entry.effectPorts.push(effect);
        entry.effectEvidence.push({ effect, callee: `<route:${entry.operation}>`, ruleId: rule.id, callPath: 'declarative-route-policy' });
      }
    }
  }
  entry.effectPorts.sort();
  entry.effectEvidence.sort((left, right) => left.effect.localeCompare(right.effect) || left.callee.localeCompare(right.callee));

  for (const effect of entry.effectPorts) {
    const definition = httpReadEffectPolicy.effects[effect];
    if (!definition) {
      entry.policyIssues.push(`unknown effect kind: ${effect}`);
      continue;
    }
    const matchingEffectRules = matchingRules.filter((rule) => rule.effects.includes(effect));
    const external = definition.externalInValidation && (matchingEffectRules.length === 0 || matchingEffectRules.some((rule) => rule.externalInValidation === true));
    if (external) {
      entry.externalEffectPorts.push(effect);
      const failClosedRules = matchingEffectRules.filter((rule) => rule.externalInValidation === true && rule.validation?.disposition === 'fail_closed');
      if (failClosedRules.length === 0) {
        entry.policyIssues.push(`${effect}: missing fail_closed route policy`);
        continue;
      }
      for (const rule of failClosedRules) entry.evidenceIssues.push(...validationEvidenceIssues(rule, evidence));
      continue;
    }
    if (!definition.externalInValidation) continue;
    const guardedRules = matchingEffectRules.filter((rule) => rule.externalInValidation === false && rule.validation?.disposition !== undefined);
    if (guardedRules.length === 0) {
      entry.policyIssues.push(`${effect}: missing validation-safe projection policy`);
      continue;
    }
    for (const rule of guardedRules) entry.evidenceIssues.push(...validationEvidenceIssues(rule, evidence));
  }
  entry.externalEffectPorts = [...new Set(entry.externalEffectPorts)].sort();
  entry.policyIssues = [...new Set(entry.policyIssues)].sort();
  entry.evidenceIssues = [...new Set(entry.evidenceIssues)].sort();
  if (entry.status !== 'pending_hidden_side_effect' && (entry.unknownExternalCalls.length > 0 || entry.policyIssues.length > 0 || entry.evidenceIssues.length > 0)) entry.status = 'pending_read_policy';
  else if (entry.status !== 'pending_hidden_side_effect' && entry.externalEffectPorts.length > 0) entry.status = 'read_only_external_fail_closed';
  else if (entry.status !== 'pending_hidden_side_effect' && entry.effectPorts.includes('subscription')) entry.status = 'subscription_capability';
  else if (entry.status !== 'pending_hidden_side_effect' && entry.effectPorts.includes('bounded_observability')) entry.status = 'bounded_observability';
}

function validationEvidenceIssues(rule, evidence) {
  const issues = [];
  const validation = rule.validation;
  if (validation?.disposition === 'fail_closed') {
    if (!evidence.requiredMarkersPresent) issues.push(`${rule.id}: verifier required marker missing`);
    for (const path of validation.representativePaths ?? []) {
      if (!evidence.fencePatterns.some((pattern) => pattern.test(path))) issues.push(`${rule.id}: fence does not block ${path}`);
      if (!evidence.verifierPaths.has(path)) issues.push(`${rule.id}: behavior verifier does not exercise ${path}`);
    }
  }
  for (const marker of validation?.sourceMarkers ?? []) {
    if (![...sources.values()].some((source) => source.includes(marker))) issues.push(`${rule.id}: source evidence marker missing: ${marker}`);
  }
  for (const marker of validation?.verifierMarkers ?? []) {
    if (!evidence.verifierSource.includes(marker)) issues.push(`${rule.id}: behavior verifier marker missing: ${marker}`);
  }
  return issues;
}

async function inspectValidationEvidence() {
  const descriptor = httpReadEffectPolicy.validationEvidence;
  const fenceSource = sources.get(descriptor.fenceSourceFile) ?? (await readFile(join(repositoryRoot, descriptor.fenceSourceFile), 'utf8'));
  const fenceAst = sourceFiles.get(descriptor.fenceSourceFile) ?? ts.createSourceFile(descriptor.fenceSourceFile, fenceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fenceFunction = findFunction(fenceAst, descriptor.fenceFunction);
  const fencePatterns = [];
  if (fenceFunction) {
    const collect = (node) => {
      if (ts.isRegularExpressionLiteral(node)) {
        const parsed = parseRegexLiteral(node.text);
        if (parsed) fencePatterns.push(parsed);
      }
      ts.forEachChild(node, collect);
    };
    collect(fenceFunction);
  }

  const verifierSource = await readFile(join(repositoryRoot, descriptor.verifierFile), 'utf8');
  const verifierAst = ts.createSourceFile(descriptor.verifierFile, verifierSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const verifierPaths = new Set();
  const collectPaths = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === descriptor.verifierPathVariable && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) {
        if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) verifierPaths.add(element.text);
      }
    }
    ts.forEachChild(node, collectPaths);
  };
  collectPaths(verifierAst);
  const ordinaryPuritySource = await readFile(join(repositoryRoot, httpReadEffectPolicy.ordinaryPurityEvidence.verifierFile), 'utf8');
  return {
    fencePatterns,
    verifierPaths,
    verifierSource,
    requiredMarkersPresent: descriptor.requiredVerifierMarkers.every((marker) => verifierSource.includes(marker)),
    ordinaryPurityMarkersPresent: httpReadEffectPolicy.ordinaryPurityEvidence.requiredMarkers.every((marker) => ordinaryPuritySource.includes(marker)),
  };
}

function validateRequiredOperations(evidence) {
  const policyIssues = [];
  const evidenceIssues = [];
  if (!evidence.ordinaryPurityMarkersPresent) evidenceIssues.push('ordinary GET purity behavior verifier markers are incomplete');
  for (const operation of httpReadEffectPolicy.requiredExactOperations) {
    const entry = entries.find((candidate) => candidate.operation === operation);
    if (!entry) {
      policyIssues.push(`required GET/HEAD operation missing: ${operation}`);
      continue;
    }
    const rules = compiledRouteRules.filter((rule) => rule.patterns.some((pattern) => pattern.test(operation)));
    if (!rules.some((rule) => rule.externalInValidation && rule.validation?.disposition === 'fail_closed')) policyIssues.push(`required operation lacks fail_closed policy: ${operation}`);
    for (const rule of rules.filter((candidate) => candidate.externalInValidation)) evidenceIssues.push(...validationEvidenceIssues(rule, evidence));
  }
  return { policyIssues: [...new Set(policyIssues)].sort(), evidenceIssues: [...new Set(evidenceIssues)].sort() };
}

function findFunction(sourceFile, name) {
  let result = null;
  const visit = (node) => {
    if (!result && ts.isFunctionDeclaration(node) && node.name?.text === name) result = node;
    if (!result) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function parseRegexLiteral(text) {
  const match = /^\/(.*)\/([a-z]*)$/su.exec(text);
  if (!match) return null;
  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return null;
  }
}

function resolveRelativeImport(file, module) {
  if (!module.startsWith('.')) return null;
  const candidate = normalizePath(join(dirname(file), module));
  const tsCandidate = candidate.replace(/\.js$/u, '.ts');
  if (sourceFiles.has(tsCandidate) || files.some((absolute) => normalizePath(relative(repositoryRoot, absolute)) === tsCandidate)) return tsCandidate;
  const indexCandidate = normalizePath(join(candidate, 'index.ts'));
  return files.some((absolute) => normalizePath(relative(repositoryRoot, absolute)) === indexCandidate) ? indexCandidate : null;
}

function isFunctionLike(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);
}

function isAllowedResponseWrite(callee) {
  return (
    callee === 'reply.header' ||
    callee === 'reply.code' ||
    callee === 'reply.send' ||
    callee === 'reply.raw.write' ||
    callee === 'projector.write' ||
    /^digest(?:\.update\([^)]*\))*\.update$/u.test(callee) ||
    /createHash\([^)]*\)(?:\.update\([^)]*\))*\.update$/u.test(callee) ||
    callee.startsWith('socket.')
  );
}

function routeText(node, sourceFile) {
  if (!node) return '<missing>';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.getText(sourceFile).replace(/\s+/gu, ' ').trim();
}

function countBy(values, key) {
  return Object.fromEntries([...new Set(values.map(key))].sort().map((value) => [value, values.filter((item) => key(item) === value).length]));
}

function normalizePath(value) {
  return value.split('\\').join('/');
}

async function collectTypeScriptFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collectTypeScriptFiles(absolutePath)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(absolutePath);
  }
  return result;
}
