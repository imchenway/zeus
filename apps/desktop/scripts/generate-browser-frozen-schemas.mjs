import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import ts from 'typescript';

const [apiPath, outputPath] = process.argv.slice(2);
if (!apiPath || !outputPath) {
  throw new Error('Usage: node generate-browser-frozen-schemas.mjs <public-api.json> <output.ts>');
}

const sourceBytes = await readFile(apiPath);
const api = JSON.parse(sourceBytes.toString('utf8'));
const declarations = new Map();

for (const entry of Object.values(api.types || {})) {
  const file = ts.createSourceFile('type.ts', String(entry.text || ''), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const declaration of file.statements) {
    if (declaration.name && ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
  }
}

function typeSchema(node, seen = new Set()) {
  if (!node) return {};
  if (ts.isParenthesizedTypeNode(node)) return typeSchema(node.type, seen);
  if (node.kind === ts.SyntaxKind.StringKeyword) return { type: 'string' };
  if (node.kind === ts.SyntaxKind.NumberKeyword) return { type: 'number' };
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return { type: 'boolean' };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { type: 'null' };
  if (ts.isLiteralTypeNode(node)) {
    if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { type: 'null' };
    if (ts.isStringLiteral(node.literal)) return { type: 'string', enum: [node.literal.text] };
    if (ts.isNumericLiteral(node.literal)) return { type: 'number', enum: [Number(node.literal.text)] };
    if (node.literal.kind === ts.SyntaxKind.TrueKeyword || node.literal.kind === ts.SyntaxKind.FalseKeyword) return { type: 'boolean', enum: [node.literal.kind === ts.SyntaxKind.TrueKeyword] };
    return {};
  }
  if (ts.isArrayTypeNode(node)) return { type: 'array', items: typeSchema(node.elementType, seen) };
  if (ts.isTupleTypeNode(node)) return { type: 'array', prefixItems: node.elements.map((entry) => typeSchema(entry, seen)), minItems: node.elements.length, maxItems: node.elements.length };
  if (ts.isUnionTypeNode(node)) {
    const choices = node.types.map((entry) => typeSchema(entry, seen));
    const enums = choices.every((choice) => Array.isArray(choice.enum)) ? choices.flatMap((choice) => choice.enum) : null;
    const types = new Set(choices.map((choice) => choice.type).filter(Boolean));
    if (enums && types.size === 1) return { type: [...types][0], enum: [...new Set(enums)] };
    return { anyOf: choices };
  }
  if (ts.isFunctionTypeNode(node)) return { type: 'object', additionalProperties: true, description: 'Zeus frozen action descriptor.' };
  if (ts.isTypeLiteralNode(node)) return membersSchema(node.members, seen);
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    if (name === 'Array' || name === 'ReadonlyArray') return { type: 'array', items: typeSchema(node.typeArguments?.[0], seen) };
    if (name === 'Promise') return typeSchema(node.typeArguments?.[0], seen);
    if (name === 'Record') return { type: 'object', additionalProperties: typeSchema(node.typeArguments?.[1], seen) };
    if (name === 'Uint8Array') return { type: 'string', contentEncoding: 'base64' };
    if (name === 'PlaywrightLocator') return { type: 'string', description: 'Current-turn Zeus Browser handle.' };
    if (seen.has(name)) return { type: 'object', additionalProperties: true };
    const declaration = declarations.get(name);
    if (!declaration) return {};
    const nextSeen = new Set(seen).add(name);
    if (ts.isTypeAliasDeclaration(declaration)) return typeSchema(declaration.type, nextSeen);
    if (ts.isInterfaceDeclaration(declaration)) return membersSchema(declaration.members, nextSeen);
    return {};
  }
  return {};
}

function membersSchema(members, seen) {
  const properties = {};
  const required = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name = member.name.getText().replace(/^['"]|['"]$/gu, '');
    properties[name] = typeSchema(member.type, seen);
    if (!member.questionToken) required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function mergeProperty(left, right) {
  if (!left) return right;
  if (JSON.stringify(left) === JSON.stringify(right)) return left;
  if (left.type === right.type && Array.isArray(left.enum) && Array.isArray(right.enum)) return { type: left.type, enum: [...new Set([...left.enum, ...right.enum])] };
  const choices = [...(Array.isArray(left.anyOf) ? left.anyOf : [left]), ...(Array.isArray(right.anyOf) ? right.anyOf : [right])];
  return { anyOf: choices.filter((choice, index) => choices.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(choice)) === index) };
}

function methodSchema(interfaceName, memberName, declarationsList) {
  const overloads = declarationsList.map((entry) => {
    const declarationText = String(entry.text || '').replace(/\s*\/\/.*$/gu, '');
    const file = ts.createSourceFile('interface.ts', `interface ${interfaceName} { ${declarationText} }`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = file.statements[0]?.members?.[0];
    if (!declaration || !ts.isMethodSignature(declaration)) return [];
    return declaration.parameters.map((parameter) => ({
      name: parameter.name.getText(),
      optional: Boolean(parameter.questionToken || parameter.initializer),
      schema: typeSchema(parameter.type),
    }));
  });
  const properties = {};
  for (const overload of overloads) for (const parameter of overload) properties[parameter.name] = mergeProperty(properties[parameter.name], parameter.schema);
  const required = Object.keys(properties).filter((name) => overloads.length > 0 && overloads.every((overload) => overload.some((parameter) => parameter.name === name && !parameter.optional)));
  if (`${interfaceName}.${memberName}` === 'PlaywrightAPI.expectNavigation')
    properties.action = { type: 'object', properties: { path: { type: 'string' }, handle: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['path'], additionalProperties: false };
  return { type: 'object', properties, required, additionalProperties: false };
}

const schemas = {};
const unsupportedSurfaces = {};
for (const [interfaceName, members] of Object.entries(api.interfaces || {})) {
  for (const [memberName, member] of Object.entries(members)) {
    const path = `${interfaceName}.${memberName}`;
    schemas[path] = methodSchema(interfaceName, memberName, member.declarations || []);
    if (Array.isArray(member.unsupportedByDefaultIn)) unsupportedSurfaces[path] = member.unsupportedByDefaultIn;
  }
}

const digest = createHash('sha256').update(sourceBytes).digest('hex');
const body = `/* 由冻结版本公开 api.json 机械生成；仅包含方法参数结构，不包含插件代码、文档正文或资产。 */\nimport type { BrowserFrozenArgumentSchema } from './browserFrozenContract.js';\n\nexport const browserFrozenPublicApiSha256 = '${digest}' as const;\n\nexport const browserFrozenUnsupportedSurfaces: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(unsupportedSurfaces, null, 2)};\n\nexport const browserFrozenPublicArgumentSchemas: Readonly<Record<string, BrowserFrozenArgumentSchema>> = ${JSON.stringify(schemas, null, 2)};\n`;
await writeFile(outputPath, body);
