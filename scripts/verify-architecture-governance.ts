import {readdir, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {storageAuxiliaryTableOwnership, storageTableOwnership} from '../packages/storage/src/tableOwnership.js';

interface ArchitectureGovernanceConfig {
  schemaVersion: 2;
  defaultMaximumSourceLines: number;
  rendererApiFacade: string;
  rendererApiFacadeMaximumSourceLines: number;
  rendererApiCompositionRoot: string;
  rendererApiCompositionRootMaximumSourceLines: number;
  rendererBoundedContextClientMaximumSourceLines: number;
  grandfatheredSourceFiles: Record<string, number>;
  compositionRoots: string[];
  requiredLocalServerSubpaths: string[];
  requiredLocalServerRegistrations: string[];
  movedLocalServerRoutes: string[];
  ownedStorageTableCount: number;
  ownedAuxiliaryStorageTableCount: number;
  lifecycleMatrix: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readText('docs/architecture/architecture-governance.json')) as ArchitectureGovernanceConfig;
const failures: string[] = [];

await verifySourceFileSizes();
await verifyRendererApiBoundaries();
await verifyImportBoundaries();
await verifyWorkspaceDependencyCycles();
await verifyPublicPorts();
await verifyStorageTableOwnership();
await verifyCompositionRoots();

if (failures.length > 0) {
  console.error(`Architecture governance failed with ${failures.length} violation(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Architecture governance passed: ${storageTableOwnership.length} Core tables and ${storageAuxiliaryTableOwnership.length} rebuildable auxiliary tables have one owner; source size, imports, public ports and package cycles are within policy.`,
  );
}

async function verifySourceFileSizes(): Promise<void> {
  const sourceFiles = [...(await collectFiles('apps')), ...(await collectFiles('packages'))].filter((path) => (path.endsWith('.ts') || path.endsWith('.tsx')) && !path.includes('/dist/'));
  for (const path of sourceFiles) {
    const content = await readText(path);
    const lineCount = countLines(content);
    const maximum = config.grandfatheredSourceFiles[path] ?? config.defaultMaximumSourceLines;
    if (lineCount > maximum) failures.push(`${path} has ${lineCount} lines; maximum is ${maximum}. Split by an owned application boundary before adding more.`);
  }
}

async function verifyRendererApiBoundaries(): Promise<void> {
  const facade = await readText(config.rendererApiFacade);
  const facadeLines = countLines(facade);
  if (facadeLines > config.rendererApiFacadeMaximumSourceLines) {
    failures.push(`${config.rendererApiFacade} has ${facadeLines} lines; stable Renderer API facade maximum is ${config.rendererApiFacadeMaximumSourceLines}. Move contracts and implementation to their bounded context.`);
  }
  for (const forbiddenRuntime of ['fetch(', 'createLocalApiTransport(', 'buildCommand']) {
    if (facade.includes(forbiddenRuntime)) failures.push(`${config.rendererApiFacade} contains ${forbiddenRuntime}; the compatibility facade may only re-export composition and contracts.`);
  }

  const composition = await readText(config.rendererApiCompositionRoot);
  const compositionLines = countLines(composition);
  if (compositionLines > config.rendererApiCompositionRootMaximumSourceLines) {
    failures.push(`${config.rendererApiCompositionRoot} has ${compositionLines} lines; Renderer API composition root maximum is ${config.rendererApiCompositionRootMaximumSourceLines}.`);
  }
  if (!composition.includes('createLocalApiTransport(') || !composition.includes('createDashboardClient(')) {
    failures.push(`${config.rendererApiCompositionRoot} must own the single transport and DashboardClient composition.`);
  }

  const rendererFeatureClients = (await collectFiles('apps/desktop/src/renderer/features')).filter((path) => path.endsWith('ApiClient.ts'));
  for (const path of rendererFeatureClients) {
    const content = await readText(path);
    const lineCount = countLines(content);
    if (lineCount > config.rendererBoundedContextClientMaximumSourceLines) {
      failures.push(`${path} has ${lineCount} lines; bounded-context API client maximum is ${config.rendererBoundedContextClientMaximumSourceLines}. Split by an owned subdomain instead of recreating an API monolith.`);
    }
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

  const modularPolicies: Record<string, string[]> = {
    'packages/local-server/src/conversationSnapshotV2Api.ts': ['fastify', '@zeus/storage', './conversationSnapshotCompatibility.js'],
    'packages/local-server/src/conversationSyncRoutes.ts': ['node:crypto', 'fastify', './conversationSyncProtocol.js'],
    'packages/local-server/src/contextCompiler.ts': ['node:crypto', '@zeus/storage'],
    'packages/local-server/src/contextSourceCatalog.ts': ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path', '@zeus/storage', './contextCompiler.js'],
    'packages/local-server/src/memoryContextApi.ts': ['node:crypto', 'fastify', '@zeus/shared', '@zeus/storage', './contextCompiler.js', './contextSourceCatalog.js'],
    'packages/local-server/src/projectGitQueryApplication.ts': ['node:path', '@zeus/git-core', '@zeus/storage'],
    'packages/local-server/src/projectGitQueryRoutes.ts': ['fastify', './nativeQueryRouteError.js', './projectGitQueryApplication.js'],
      'packages/local-server/src/projectQueryApplication.ts': ['@zeus/git-core', '@zeus/storage', './projectCore.js'],
    'packages/local-server/src/projectQueryRoutes.ts': ['fastify', './nativeQueryRouteError.js', './projectQueryApplication.js'],
    'packages/local-server/src/workManagementQueryApplication.ts': ['@zeus/shared', '@zeus/storage'],
    'packages/local-server/src/workManagementQueryRoutes.ts': ['fastify', './nativeQueryRouteError.js', './workManagementQueryApplication.js'],
    'packages/local-server/src/runtimeQueryApplication.ts': ['@zeus/ai-runtime', '@zeus/storage'],
    'packages/local-server/src/runtimeQueryRoutes.ts': ['fastify', './nativeQueryRouteError.js', './runtimeQueryApplication.js'],
    'packages/local-server/src/codexSubagentQueryApplication.ts': ['@zeus/ai-runtime', '@zeus/storage', './codexSubagentRuntimeProjection.js', './conversationResources.js'],
    'packages/local-server/src/codexSubagentQueryRoutes.ts': ['fastify', './codexSubagentQueryApplication.js'],
    'packages/local-server/src/codexSubagentRuntimeProjection.ts': ['node:fs', 'node:fs/promises', 'node:path', '@zeus/ai-runtime', '@zeus/shared'],
    'packages/local-server/src/conversationCapabilityQueryApplication.ts': ['node:crypto', 'node:path', '@zeus/ai-runtime', '@zeus/git-core', '@zeus/storage'],
    'packages/local-server/src/conversationCapabilityQueryRoutes.ts': ['fastify', './conversationCapabilityQueryApplication.js', './nativeQueryRouteError.js'],
    'packages/local-server/src/nativeQueryRouteError.ts': ['fastify'],
  };
  for (const [path, allowed] of Object.entries(modularPolicies)) {
    const specifiers = importSpecifiers(await readText(path));
    for (const specifier of specifiers) {
      if (!allowed.includes(specifier)) failures.push(`${path} imports ${specifier}; allowed public dependencies are ${allowed.join(', ')}.`);
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

async function verifyPublicPorts(): Promise<void> {
  const manifest = JSON.parse(await readText('packages/local-server/package.json')) as { exports?: Record<string, unknown> };
  for (const subpath of config.requiredLocalServerSubpaths) {
    if (!Object.hasOwn(manifest.exports ?? {}, subpath)) failures.push(`@zeus/local-server is missing required public subpath ${subpath}.`);
  }
}

async function verifyStorageTableOwnership(): Promise<void> {
  if (storageTableOwnership.length !== config.ownedStorageTableCount) failures.push(`table owner manifest has ${storageTableOwnership.length} records; expected ${config.ownedStorageTableCount}.`);
  if (storageAuxiliaryTableOwnership.length !== config.ownedAuxiliaryStorageTableCount) {
    failures.push(`auxiliary table owner manifest has ${storageAuxiliaryTableOwnership.length} records; expected ${config.ownedAuxiliaryStorageTableCount}.`);
  }
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

  const matrix = await readText(config.lifecycleMatrix);
  const documented = new Map<string, string>();
  const rowPattern = /^\| `([a-z][a-z0-9_]*)` \| ([^|]+)\|/gmu;
  for (const match of matrix.matchAll(rowPattern)) if (match[1] && match[2]) documented.set(match[1], match[2].trim());
  for (const record of storageTableOwnership) {
    const documentedOwner = documented.get(record.table);
    if (!documentedOwner) failures.push(`${record.table} is absent from ${config.lifecycleMatrix}.`);
    else if (!documentedOwner.includes(record.documentationOwnerLabel)) {
      failures.push(`${record.table} owner mismatch: manifest=${record.documentationOwnerLabel}, matrix=${documentedOwner}.`);
    }
  }

  const auxiliaryTables = extractSchemaTables(await readText('packages/storage/src/projectionDatabaseCandidate.ts'));
  const auxiliaryOwnerByTable = new Map<string, (typeof storageAuxiliaryTableOwnership)[number]>();
  for (const record of storageAuxiliaryTableOwnership) {
    if (auxiliaryOwnerByTable.has(record.table)) failures.push(`auxiliary table ${record.table} has more than one owner record.`);
    auxiliaryOwnerByTable.set(record.table, record);
  }
  for (const table of auxiliaryTables) if (!auxiliaryOwnerByTable.has(table)) failures.push(`auxiliary schema table ${table} has no machine-readable owner.`);
  for (const table of auxiliaryOwnerByTable.keys()) if (!auxiliaryTables.has(table)) failures.push(`auxiliary owner manifest table ${table} is not created by projection candidate schema.`);
  for (const record of storageAuxiliaryTableOwnership) {
    const documentedOwner = documented.get(record.table);
    if (!documentedOwner) failures.push(`${record.table} is absent from ${config.lifecycleMatrix}.`);
    else if (!documentedOwner.includes(record.documentationOwnerLabel)) {
      failures.push(`${record.table} owner mismatch: manifest=${record.documentationOwnerLabel}, matrix=${documentedOwner}.`);
    }
  }
}

function extractSchemaTables(content: string): Set<string> {
  const tables = new Set<string>();
  const createTablePattern = /CREATE (?:VIRTUAL )?TABLE(?: IF NOT EXISTS)?\s+([a-z][a-z0-9_]*)/giu;
  for (const match of content.matchAll(createTablePattern)) if (match[1]) tables.add(match[1]);
  return tables;
}

async function verifyCompositionRoots(): Promise<void> {
  for (const root of config.compositionRoots) if (!(await fileExists(root))) failures.push(`composition root ${root} does not exist.`);
  const localServerIndex = await readText('packages/local-server/src/index.ts');
  const localServerRouteAssembly = `${localServerIndex}\n${await readText('packages/local-server/src/localServerPlatformRoutes.ts')}`;
  for (const registration of config.requiredLocalServerRegistrations) if (!localServerRouteAssembly.includes(registration)) failures.push(`local-server composition and route assembly are missing ${registration}.`);
  for (const movedRoute of config.movedLocalServerRoutes) {
    if (localServerIndex.includes(movedRoute)) failures.push(`local-server composition root still owns moved route ${movedRoute}.`);
  }
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(join(repositoryRoot, path));
    return true;
  } catch {
    return false;
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const newlineCount = [...content.matchAll(/\n/gu)].length;
  return newlineCount + (content.endsWith('\n') ? 0 : 1);
}
