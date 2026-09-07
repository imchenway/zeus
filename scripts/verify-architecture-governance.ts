import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storageAuxiliaryTableOwnership, storageTableOwnership } from '../packages/storage/src/tableOwnership.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 只检查可从源码推导的边界，不维护行数预算、历史例外或文档副本。
const rendererApiFacade = 'apps/desktop/src/renderer/apiClient.ts';
const failures: string[] = [];

await verifyRendererApiBoundaries();
await verifyImportBoundaries();
await verifyWorkspaceDependencyCycles();
await verifyStorageTableOwnership();

if (failures.length > 0) {
  console.error(`Architecture governance failed with ${failures.length} violation(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture governance passed: ${storageTableOwnership.length} Core tables and ${storageAuxiliaryTableOwnership.length} rebuildable auxiliary tables have one owner; imports and package cycles are within policy.`);
}

async function verifyRendererApiBoundaries(): Promise<void> {
  const facade = await readText(rendererApiFacade);
  for (const forbiddenRuntime of ['fetch(', 'createLocalApiTransport(', 'buildCommand']) {
    if (facade.includes(forbiddenRuntime)) failures.push(`${rendererApiFacade} contains ${forbiddenRuntime}; the compatibility facade may only re-export composition and contracts.`);
  }

  const rendererFeatureClients = (await collectFiles('apps/desktop/src/renderer/features')).filter((path) => path.endsWith('ApiClient.ts'));
  for (const path of rendererFeatureClients) {
    const content = await readText(path);
    for (const specifier of importSpecifiers(content)) {
      if (specifier.endsWith('/apiClient.js')) failures.push(`${path} imports compatibility facade ${specifier}; bounded-context clients must depend on owned contracts and LocalApiTransport.`);
    }
    if (!content.includes('LocalApiTransport')) failures.push(`${path} does not consume LocalApiTransport; bounded-context clients may not implement a second fetch, retry or token stack.`);
    if (/\bfetch\s*\(/u.test(content)) failures.push(`${path} calls fetch directly; only LocalApiTransport owns HTTP execution.`);
  }

  for (const path of (await collectFiles('apps/desktop/src/renderer/transport')).filter((candidate) => candidate.endsWith('.ts'))) {
    for (const specifier of importSpecifiers(await readText(path))) {
      if (specifier.endsWith('/apiClient.js') || specifier === '../apiClient.js') failures.push(`${path} imports the compatibility facade; transport must remain below composition and feature contracts.`);
    }
  }
}

async function verifyImportBoundaries(): Promise<void> {
  const storageFiles = (await collectFiles('packages/storage/src')).filter((path) => path.endsWith('.ts'));
  for (const path of storageFiles) {
    const specifiers = importSpecifiers(await readText(path));
    if (path !== 'packages/storage/src/index.ts' && specifiers.includes('./index.js')) failures.push(`${path} imports storage composition root; depend on databasePort or a public peer module.`);
    for (const specifier of specifiers) {
      if (specifier.startsWith('@zeus/') && specifier !== '@zeus/shared') failures.push(`${path} imports ${specifier}; storage infrastructure may depend only on @zeus/shared among workspace packages.`);
    }
  }
}

async function verifyWorkspaceDependencyCycles(): Promise<void> {
  const packageFiles = [...(await collectFiles('apps')), ...(await collectFiles('packages'))].filter((path) => path.endsWith('/package.json'));
  const packages = new Map<string, { path: string; dependencies: string[] }>();
  for (const path of packageFiles) {
    const manifest = JSON.parse(await readText(path)) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    if (!manifest.name?.startsWith('@zeus/')) continue;
    const dependencies = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})].filter((name) => name.startsWith('@zeus/'));
    packages.set(manifest.name, { path, dependencies });
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string, chain: string[]): void => {
    if (visiting.has(name)) {
      const cycleStart = chain.indexOf(name);
      failures.push(`workspace dependency cycle: ${[...chain.slice(cycleStart), name].join(' -> ')}`);
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    const node = packages.get(name);
    for (const dependency of node?.dependencies ?? []) if (packages.has(dependency)) visit(dependency, [...chain, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of packages.keys()) visit(name, []);
}

async function verifyStorageTableOwnership(): Promise<void> {
  const ownerByTable = new Map<string, (typeof storageTableOwnership)[number]>();
  for (const record of storageTableOwnership) {
    if (ownerByTable.has(record.table)) failures.push(`table ${record.table} has more than one owner record.`);
    ownerByTable.set(record.table, record);
  }

  const schemaSourceFiles = [
    ...(await collectFiles('packages/storage/src')).filter((path) => path.endsWith('.ts') && !path.endsWith('/projectionDatabaseCandidate.ts')),
    ...(await collectFiles('packages/local-server/src')).filter((path) => path.endsWith('.ts')),
  ];
  const schemaTables = new Set<string>();
  for (const path of schemaSourceFiles) for (const table of extractSchemaTables(await readText(path))) schemaTables.add(table);
  for (const table of schemaTables) if (!ownerByTable.has(table)) failures.push(`schema table ${table} has no machine-readable owner.`);
  for (const table of ownerByTable.keys()) if (!schemaTables.has(table)) failures.push(`owner manifest table ${table} is not created by current schema sources.`);

  const auxiliaryTables = extractSchemaTables(await readText('packages/storage/src/projectionDatabaseCandidate.ts'));
  const auxiliaryOwnerByTable = new Map<string, (typeof storageAuxiliaryTableOwnership)[number]>();
  for (const record of storageAuxiliaryTableOwnership) {
    if (auxiliaryOwnerByTable.has(record.table)) failures.push(`auxiliary table ${record.table} has more than one owner record.`);
    auxiliaryOwnerByTable.set(record.table, record);
  }
  for (const table of auxiliaryTables) if (!auxiliaryOwnerByTable.has(table)) failures.push(`auxiliary schema table ${table} has no machine-readable owner.`);
  for (const table of auxiliaryOwnerByTable.keys()) if (!auxiliaryTables.has(table)) failures.push(`auxiliary owner manifest table ${table} is not created by projection candidate schema.`);
}

function extractSchemaTables(content: string): Set<string> {
  const tables = new Set<string>();
  const createTablePattern = /CREATE (?:VIRTUAL )?TABLE(?: IF NOT EXISTS)?\s+([a-z][a-z0-9_]*)/giu;
  for (const match of content.matchAll(createTablePattern)) if (match[1]) tables.add(match[1]);
  return tables;
}

function importSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const pattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s+)?['"]([^'"]+)['"]/gu;
  for (const match of content.matchAll(pattern)) if (match[1]) specifiers.push(match[1]);
  return specifiers;
}

async function collectFiles(relativeDirectory: string): Promise<string[]> {
  const absoluteDirectory = join(repositoryRoot, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'out' && entry.name !== 'build') paths.push(...(await collectFiles(relativePath)));
    else if (entry.isFile()) paths.push(relativePath.split('\\').join('/'));
  }
  return paths;
}

async function readText(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), 'utf8');
}
