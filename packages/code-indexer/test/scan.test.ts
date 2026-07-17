import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProjectSource } from '../src/index.js';

describe('real project scanner', () => {
  it('uses configured ignore directories when scanning real files without inventing graph facts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scan-ignore-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, 'generated-real'), { recursive: true });
      await writeFile(join(dir, 'src', 'kept.ts'), 'export function keptRealSource() { return 1; }');
      await writeFile(join(dir, 'generated-real', 'ignored.ts'), 'export function ignoredRealSource() { return 2; }');

      const result = await scanProjectSource({
        rootPath: dir,
        projectName: 'Ignore Fixture',
        ignoreDirectories: ['generated-real'],
      });

      expect(result.files.map((file) => file.relativePath)).toEqual(['src/kept.ts']);
      expect(result.symbols.map((symbol) => symbol.name)).toContain('keptRealSource');
      expect(result.symbols.map((symbol) => symbol.name)).not.toContain('ignoredRealSource');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips generated Java and IDE directories by default so project scans do not ingest build output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scan-java-generated-ignore-'));
    try {
      await mkdir(join(dir, 'src', 'main', 'java'), { recursive: true });
      await mkdir(join(dir, 'target', 'generated-sources'), { recursive: true });
      await mkdir(join(dir, 'build', 'generated'), { recursive: true });
      await mkdir(join(dir, '.gradle', 'cache'), { recursive: true });
      await mkdir(join(dir, '.idea'), { recursive: true });
      await writeFile(join(dir, 'src', 'main', 'java', 'RealService.java'), 'class RealService { void run() {} }');
      await writeFile(join(dir, 'target', 'generated-sources', 'GeneratedTarget.java'), 'class GeneratedTarget { void run() {} }');
      await writeFile(join(dir, 'build', 'generated', 'GeneratedBuild.java'), 'class GeneratedBuild { void run() {} }');
      await writeFile(join(dir, '.gradle', 'cache', 'GeneratedGradle.java'), 'class GeneratedGradle { void run() {} }');
      await writeFile(join(dir, '.idea', 'workspace.xml'), '<project><component name="GeneratedIdea"/></project>');

      const result = await scanProjectSource({
        rootPath: dir,
        projectName: 'Java Generated Ignore Fixture',
      });

      expect(result.files.map((file) => file.relativePath)).toEqual(['src/main/java/RealService.java']);
      expect(result.symbols.map((symbol) => symbol.name)).toContain('RealService');
      expect(result.symbols.map((symbol) => symbol.name)).not.toContain('GeneratedTarget');
      expect(result.symbols.map((symbol) => symbol.name)).not.toContain('GeneratedBuild');
      expect(result.symbols.map((symbol) => symbol.name)).not.toContain('GeneratedGradle');
      expect(result.symbols.map((symbol) => symbol.name)).not.toContain('GeneratedIdea');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('precomputes Java import targets once instead of rebuilding the Java file set for every source file', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    expect(source).toContain('const knownRelativePaths = buildKnownRelativePathSet(files);');
    expect(source).toContain('extractSymbols(input.rootPath, file, content, knownRelativePaths, importTargets, javaImportTargets)');
    expect(source).toContain('const javaImportTargets = buildJavaImportTargetMap(files);');
    expect(source).toContain('extractJavaImportSymbols(file, content, language, javaImportTargets)');
    expect(source).not.toContain('function extractImportExportSymbols(file: ScannedFile, content: string, language: string, allFiles: ScannedFile[]');
    expect(source).not.toContain("new Set(allFiles.filter((item) => item.extension === '.java')");
  });

  it('reads source files once through a bounded concurrent content loader instead of blocking scan on serial double reads', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    expect(source).toContain('const fileContents = await readScannedFilesWithContent(fileCandidates);');
    expect(source).toContain('async function readScannedFilesWithContent');
    expect(source).toContain('SCAN_FILE_READ_CONCURRENCY');
    expect(source).not.toContain("const content = await readFile(file.absolutePath, 'utf8');");
  });

  it('uses line-bounded Java method extraction so DTO classes do not trigger catastrophic regex backtracking', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    expect(source).toContain('function extractJavaMethodMatches');
    expect(source).toContain('const signatureMatch = line.match(javaMethodSignaturePattern);');
    expect(source).not.toContain('classBody.matchAll(/((?:@\\w+(?:\\([^)]*\\))?\\s*)*)\\bpublic\\s+(?:[\\w<>?,\\s]+\\s+)+');
  });

  it('scans the current Zeus repository and returns source-backed symbols', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    expect(result.rootPath).toBe('/Users/david/hypha/zeus');
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.symbols.every((symbol) => symbol.filePath.startsWith('/Users/david/hypha/zeus/'))).toBe(true);
    expect(result.symbols.every((symbol) => symbol.sourceHash.length > 0)).toBe(true);
  });

  it('extracts real SQLite table facts from storage CREATE TABLE statements', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const tableSymbols = result.symbols.filter((symbol) => symbol.symbolType === 'table');
    const taskTable = tableSymbols.find((symbol) => symbol.name === 'tasks' && symbol.filePath === '/Users/david/hypha/zeus/packages/storage/src/index.ts');

    expect(tableSymbols.map((symbol) => symbol.name)).toContain('projects');
    expect(taskTable).toBeDefined();
    expect(taskTable?.filePath).toBe('/Users/david/hypha/zeus/packages/storage/src/index.ts');
    expect(taskTable?.metadata.columns).toContain('project_id');
  });

  it('extracts SQLite column details and index facts from real storage DDL', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const projectTable = result.symbols.find((symbol) => symbol.symbolType === 'table' && symbol.name === 'projects' && symbol.filePath === '/Users/david/hypha/zeus/packages/storage/src/index.ts');
    const taskTable = result.symbols.find((symbol) => symbol.symbolType === 'table' && symbol.name === 'tasks' && symbol.filePath === '/Users/david/hypha/zeus/packages/storage/src/index.ts');

    expect(projectTable?.metadata.columnDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          dataType: 'TEXT',
          primaryKey: true,
        }),
        expect.objectContaining({
          name: 'slug',
          dataType: 'TEXT',
          notNull: true,
          unique: true,
        }),
        expect.objectContaining({
          name: 'archived',
          dataType: 'INTEGER',
          notNull: true,
          defaultValue: '0',
        }),
      ]),
    );
    expect(projectTable?.metadata.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_projects_slug',
          columns: ['slug'],
          unique: false,
        }),
      ]),
    );
    expect(taskTable?.metadata.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_tasks_project_status_updated_at',
          columns: ['project_id', 'status', 'updated_at'],
          unique: false,
        }),
      ]),
    );
  });

  it('extracts schema name, version cache, and real foreign key facts from imported DDL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-schema-facts-'));
    try {
      await writeFile(
        join(dir, 'schema.sql'),
        ['CREATE TABLE app.users (', '  id TEXT PRIMARY KEY', ');', 'CREATE TABLE app.orders (', '  id TEXT PRIMARY KEY,', '  user_id TEXT NOT NULL,', '  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES app.users(id)', ');'].join(
          '\n',
        ),
      );

      const result = await scanProjectSource({
        rootPath: dir,
        projectName: 'Schema Facts',
      });
      const ordersTable = result.symbols.find((symbol) => symbol.symbolType === 'table' && symbol.name === 'orders');

      expect(ordersTable?.metadata).toMatchObject({
        schemaName: 'app',
        schemaVersionCache: {
          sourceHash: ordersTable?.sourceHash,
          lineStart: 4,
          lineEnd: 8,
        },
        foreignKeys: [
          {
            name: 'fk_orders_user',
            columns: ['user_id'],
            referencedSchema: 'app',
            referencedTable: 'users',
            referencedColumns: ['id'],
          },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts real SQLite column facts as source-backed symbols', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const projectSlugColumn = result.symbols.find((symbol) => symbol.symbolType === 'column' && symbol.qualifiedName === 'packages/storage/src/index.ts#table:projects#column:slug');

    expect(projectSlugColumn).toEqual(
      expect.objectContaining({
        name: 'projects.slug',
        filePath: '/Users/david/hypha/zeus/packages/storage/src/index.ts',
        metadata: expect.objectContaining({
          tableName: 'projects',
          columnName: 'slug',
          dataType: 'TEXT',
          notNull: true,
          unique: true,
          tableQualifiedName: 'packages/storage/src/index.ts#table:projects',
          sourceKind: 'embedded_sql_column',
        }),
      }),
    );
  });

  it('extracts real Fastify API route facts from the local server source', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const apiSymbols = result.symbols.filter((symbol) => symbol.symbolType === 'api');
    const dashboardApi = apiSymbols.find((symbol) => symbol.name === 'GET /api/dashboard');
    const dashboardHandler = result.symbols.find((symbol) => symbol.qualifiedName === 'packages/local-server/src/index.ts#handler:GET:/api/dashboard');

    expect(dashboardApi).toBeDefined();
    expect(dashboardApi?.filePath).toBe('/Users/david/hypha/zeus/packages/local-server/src/index.ts');
    expect(dashboardApi?.metadata).toMatchObject({
      method: 'GET',
      path: '/api/dashboard',
      framework: 'fastify',
      handlerKind: 'inline_async_handler',
      handlerQualifiedName: 'packages/local-server/src/index.ts#handler:GET:/api/dashboard',
      handlerLineStart: expect.any(Number),
      handlerLineEnd: expect.any(Number),
    });
    expect(dashboardHandler).toEqual(
      expect.objectContaining({
        symbolType: 'function',
        name: 'GET /api/dashboard handler',
        metadata: expect.objectContaining({
          sourceKind: 'fastify_route_handler',
          method: 'GET',
          path: '/api/dashboard',
        }),
      }),
    );
  });

  it('extracts real method control-flow facts from TypeScript source', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const controlFlowSymbols = result.symbols.filter((symbol) => symbol.symbolType === 'control_flow' && symbol.filePath === '/Users/david/hypha/zeus/packages/local-server/src/index.ts');

    expect(controlFlowSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringContaining('if'),
          metadata: expect.objectContaining({ controlType: 'if' }),
        }),
        expect.objectContaining({
          name: expect.stringContaining('return'),
          metadata: expect.objectContaining({ controlType: 'return' }),
        }),
        expect.objectContaining({
          name: expect.stringContaining('try'),
          metadata: expect.objectContaining({ controlType: 'try' }),
        }),
        expect.objectContaining({
          name: expect.stringContaining('catch'),
          metadata: expect.objectContaining({ controlType: 'catch' }),
        }),
      ]),
    );
  });

  it('extracts finally control-flow facts and attributes them to the owning method', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const storageFinallySymbols = result.symbols.filter((symbol) => symbol.symbolType === 'control_flow' && symbol.filePath === '/Users/david/hypha/zeus/packages/storage/src/index.ts' && symbol.metadata.controlType === 'finally');

    expect(storageFinallySymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            controlType: 'finally',
            ownerFunction: 'ZeusDatabase.select',
            ownerQualifiedName: 'packages/storage/src/index.ts#ZeusDatabase.select',
            sourceKind: 'typescript_control_flow',
          }),
        }),
      ]),
    );
  });

  it('extracts real else loop and throw method logic facts from TypeScript source', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const controlFlowSymbols = result.symbols.filter((symbol) => symbol.symbolType === 'control_flow');

    expect(controlFlowSymbols.map((symbol) => symbol.metadata.controlType)).toEqual(expect.arrayContaining(['else', 'loop', 'throw']));
    expect(controlFlowSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            controlType: 'loop',
            loopKind: expect.stringMatching(/for|forEach|while/u),
          }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            controlType: 'throw',
            sourceKind: 'typescript_control_flow',
          }),
        }),
      ]),
    );
  });

  it('extracts break and continue control-flow facts from TypeScript source', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const controlFlowSymbols = result.symbols.filter((symbol) => symbol.symbolType === 'control_flow');

    expect(controlFlowSymbols.map((symbol) => symbol.metadata.controlType)).toEqual(expect.arrayContaining(['break', 'continue']));
    expect(controlFlowSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: '/Users/david/hypha/zeus/packages/code-indexer/src/index.ts',
          metadata: expect.objectContaining({
            controlType: 'break',
            ownerFunction: 'collectSqlStatementSnippet',
            sourceKind: 'typescript_control_flow',
          }),
        }),
        expect.objectContaining({
          filePath: '/Users/david/hypha/zeus/packages/code-indexer/src/index.ts',
          metadata: expect.objectContaining({
            controlType: 'continue',
            ownerFunction: 'walk',
            sourceKind: 'typescript_control_flow',
          }),
        }),
      ]),
    );
  });

  it('marks awaited function calls for method logic async flow', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const awaitedCalls = result.symbols.filter((symbol) => symbol.symbolType === 'function_call' && symbol.metadata.isAwaited === true);

    expect(awaitedCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: '/Users/david/hypha/zeus/packages/code-indexer/src/index.ts',
          metadata: expect.objectContaining({
            calleeExpression: 'listSourceFiles',
            ownerFunction: 'scanProjectSource',
            awaitKind: 'direct_await',
          }),
        }),
      ]),
    );
  });

  it('marks promise catch chains for method logic async exception flow', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const promiseCatchControls = result.symbols.filter((symbol) => symbol.symbolType === 'control_flow' && symbol.filePath === '/Users/david/hypha/zeus/packages/code-indexer/src/cli.ts' && symbol.metadata.controlType === 'promise_catch');
    const promiseCatchCalls = result.symbols.filter((symbol) => symbol.symbolType === 'function_call' && symbol.filePath === '/Users/david/hypha/zeus/packages/code-indexer/src/cli.ts' && symbol.metadata.promiseChainHandler === 'catch');

    expect(promiseCatchControls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            controlType: 'promise_catch',
            promiseChainHandler: 'catch',
            sourceKind: 'typescript_promise_chain_control_flow',
          }),
        }),
      ]),
    );
    expect(promiseCatchCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            calleeExpression: 'main',
            promiseChainHandler: 'catch',
            targetQualifiedName: 'packages/code-indexer/src/cli.ts#main',
          }),
        }),
      ]),
    );
  });

  it('marks promise then chains for method logic async continuation flow', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const startupCoordinatorPath = '/Users/david/hypha/zeus/apps/desktop/src/main/startupCoordinator.ts';
    const promiseThenControls = result.symbols.filter((symbol) => symbol.symbolType === 'control_flow' && symbol.filePath === startupCoordinatorPath && symbol.metadata.controlType === 'promise_then');
    const promiseThenCalls = result.symbols.filter((symbol) => symbol.symbolType === 'function_call' && symbol.filePath === startupCoordinatorPath && symbol.metadata.promiseChainHandler === 'then');

    expect(promiseThenControls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            controlType: 'promise_then',
            promiseChainHandler: 'then',
            sourceKind: 'typescript_promise_chain_control_flow',
          }),
        }),
      ]),
    );
    expect(promiseThenCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            calleeExpression: 'Promise.resolve',
            promiseChainHandler: 'then',
            isPromiseChainRoot: true,
          }),
        }),
      ]),
    );
  });

  it('attributes real method control-flow facts to their owning function', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const createLocalServerControls = result.symbols.filter(
      (symbol) => symbol.symbolType === 'control_flow' && symbol.filePath === '/Users/david/hypha/zeus/packages/local-server/src/index.ts' && symbol.metadata.ownerFunction === 'createLocalServer',
    );

    expect(createLocalServerControls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            ownerQualifiedName: 'packages/local-server/src/index.ts#createLocalServer',
            ownerLineStart: expect.any(Number),
            ownerLineEnd: expect.any(Number),
          }),
        }),
      ]),
    );
    expect(createLocalServerControls.every((symbol) => Number(symbol.metadata.ownerLineEnd) > Number(symbol.metadata.ownerLineStart))).toBe(true);
  });

  it('extracts real SQL call facts and attributes them to the owning method', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const storageSqlCalls = result.symbols.filter((symbol) => symbol.symbolType === 'sql_call' && symbol.filePath === '/Users/david/hypha/zeus/packages/storage/src/index.ts');

    expect(storageSqlCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            operation: 'SELECT',
            tableNames: expect.arrayContaining(['settings']),
            sourceKind: 'embedded_sql_call',
            ownerFunction: 'SettingRepository.getJson',
            ownerQualifiedName: 'packages/storage/src/index.ts#SettingRepository.getJson',
          }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            operation: 'INSERT',
            tableNames: expect.arrayContaining(['settings']),
          }),
        }),
      ]),
    );
  });

  it('extracts multi-line SQL table impact facts for repository methods', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const projectSearchSqlCall = result.symbols.find(
      (symbol) => symbol.symbolType === 'sql_call' && symbol.filePath === '/Users/david/hypha/zeus/packages/storage/src/index.ts' && symbol.metadata.ownerFunction === 'ProjectRepository.search' && symbol.metadata.operation === 'SELECT',
    );

    expect(projectSearchSqlCall).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          tableNames: expect.arrayContaining(['projects']),
          tableQualifiedNames: expect.arrayContaining(['packages/storage/src/index.ts#table:projects']),
          accessMode: 'read',
        }),
      }),
    );
  });

  it('extracts SQL selected where and order fields from real repository statements', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const projectSearchSqlCall = result.symbols.find(
      (symbol) => symbol.symbolType === 'sql_call' && symbol.filePath === '/Users/david/hypha/zeus/packages/storage/src/index.ts' && symbol.metadata.ownerFunction === 'ProjectRepository.search' && symbol.metadata.operation === 'SELECT',
    );

    expect(projectSearchSqlCall?.metadata).toMatchObject({
      selectedFields: expect.arrayContaining(['id', 'name', 'slug', 'local_path']),
      whereFields: expect.arrayContaining(['archived', 'deleted_at']),
      orderByFields: expect.arrayContaining(['created_at']),
    });
  });

  it('extracts real function call facts inside API handlers', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const projectSearchCall = result.symbols.find(
      (symbol) => symbol.symbolType === 'function_call' && symbol.filePath === '/Users/david/hypha/zeus/packages/local-server/src/index.ts' && symbol.metadata.calleeExpression === 'projects.search',
    );

    expect(projectSearchCall).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          calleeExpression: 'projects.search',
          sourceKind: 'typescript_function_call',
          ownerFunction: 'GET /api/projects handler',
          ownerQualifiedName: 'packages/local-server/src/index.ts#handler:GET:/api/projects',
        }),
      }),
    );
  });

  it('resolves repository function calls to real class method targets', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const projectSearchCall = result.symbols.find(
      (symbol) => symbol.symbolType === 'function_call' && symbol.filePath === '/Users/david/hypha/zeus/packages/local-server/src/index.ts' && symbol.metadata.calleeExpression === 'projects.search',
    );

    expect(projectSearchCall?.metadata).toMatchObject({
      targetClass: 'ProjectRepository',
      targetMethod: 'search',
      targetQualifiedName: 'packages/storage/src/index.ts#ProjectRepository.search',
      targetResolutionKind: 'constructor_variable',
    });
  });

  it('extracts real TypeScript import and export facts for module dependency analysis', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const appApiImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === '/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx' && symbol.metadata.importSource === './apiClient.js');
    const localServerStorageImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === '/Users/david/hypha/zeus/packages/local-server/src/index.ts' && symbol.metadata.importSource === '@zeus/storage');
    const appExport = result.symbols.find((symbol) => symbol.symbolType === 'export' && symbol.filePath === '/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx' && symbol.name === 'App');

    expect(appApiImport?.metadata).toMatchObject({
      importedNames: expect.arrayContaining(['createEmptyDashboardSnapshot']),
      resolvedRelativePath: 'apps/desktop/src/renderer/apiClient.ts',
      sourceKind: 'typescript_import',
    });
    expect(localServerStorageImport?.metadata).toMatchObject({
      importedNames: expect.arrayContaining(['ProjectRepository']),
      packageName: '@zeus/storage',
      resolvedRelativePath: 'packages/storage/src/index.ts',
      sourceKind: 'typescript_import',
    });
    expect(appExport).toEqual(
      expect.objectContaining({
        symbolType: 'export',
        qualifiedName: 'apps/desktop/src/renderer/App.tsx#export:App',
        metadata: expect.objectContaining({ sourceKind: 'typescript_export' }),
      }),
    );
  });

  it('extracts re-export imports and resolves workspace aliases from tsconfig paths', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const taskCoreSharedReExport = result.symbols.find(
      (symbol) => symbol.symbolType === 'import' && symbol.filePath === '/Users/david/hypha/zeus/packages/task-core/src/index.ts' && symbol.metadata.importSource === '@zeus/shared' && symbol.metadata.importKind === 're_export',
    );
    const taskCoreExport = result.symbols.find((symbol) => symbol.symbolType === 'export' && symbol.filePath === '/Users/david/hypha/zeus/packages/task-core/src/index.ts' && symbol.name === 'TaskStatus');

    expect(taskCoreSharedReExport?.metadata).toMatchObject({
      importedNames: expect.arrayContaining(['TaskStatus']),
      packageName: '@zeus/shared',
      resolvedRelativePath: 'packages/shared/src/index.ts',
      resolutionKind: 'tsconfig_paths',
      sourceKind: 'typescript_re_export',
    });
    expect(taskCoreExport?.metadata).toMatchObject({
      exportKind: 're_export',
      exportSource: '@zeus/shared',
      sourceKind: 'typescript_export',
    });
  });

  it('extracts real import type reference facts without inventing internal modules', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const sqlJsTypeReference = result.symbols.find(
      (symbol) => symbol.symbolType === 'import' && symbol.filePath === '/Users/david/hypha/zeus/packages/local-server/src/index.ts' && symbol.metadata.importSource === 'sql.js' && symbol.metadata.importKind === 'type_reference',
    );

    expect(sqlJsTypeReference?.metadata).toMatchObject({
      importedNames: [],
      external: true,
      resolutionKind: 'external',
      sourceKind: 'typescript_type_reference_import',
    });
    expect(sqlJsTypeReference?.metadata).not.toHaveProperty('resolvedRelativePath');
  });

  it('extracts export star re-export dependencies from source-backed TypeScript files', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-export-star-'));
    try {
      await mkdir(join(rootPath, 'src'), { recursive: true });
      await writeFile(join(rootPath, 'src', 'domain.ts'), 'export const domainValue = 1;\\n', 'utf8');
      await writeFile(join(rootPath, 'src', 'index.ts'), "export * from './domain.js';\\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'ExportStarFixture',
      });
      const exportStarImport = result.symbols.find(
        (symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'src', 'index.ts') && symbol.metadata.importSource === './domain.js' && symbol.metadata.importKind === 'export_star',
      );

      expect(exportStarImport?.metadata).toMatchObject({
        importedNames: ['*'],
        resolvedRelativePath: 'src/domain.ts',
        resolutionKind: 'relative',
        sourceKind: 'typescript_export_star',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('extracts export namespace re-export dependencies from source-backed TypeScript files', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-export-namespace-'));
    try {
      await mkdir(join(rootPath, 'src'), { recursive: true });
      await writeFile(join(rootPath, 'src', 'domain.ts'), 'export const domainValue = 1;\\n', 'utf8');
      await writeFile(join(rootPath, 'src', 'index.ts'), "export * as Domain from './domain.js';\\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'ExportNamespaceFixture',
      });
      const exportNamespaceImport = result.symbols.find(
        (symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'src', 'index.ts') && symbol.metadata.importSource === './domain.js' && symbol.metadata.importKind === 'export_namespace',
      );
      const exportNamespaceSymbol = result.symbols.find((symbol) => symbol.symbolType === 'export' && symbol.filePath === join(rootPath, 'src', 'index.ts') && symbol.name === 'Domain');

      expect(exportNamespaceImport?.metadata).toMatchObject({
        importedNames: ['Domain'],
        resolvedRelativePath: 'src/domain.ts',
        resolutionKind: 'relative',
        sourceKind: 'typescript_export_namespace',
      });
      expect(exportNamespaceSymbol?.metadata).toMatchObject({
        exportKind: 'namespace_re_export',
        exportSource: './domain.js',
        sourceKind: 'typescript_export',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('distinguishes runtime dynamic imports from type reference imports', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-dynamic-import-'));
    try {
      await mkdir(join(rootPath, 'src'), { recursive: true });
      await writeFile(join(rootPath, 'src', 'feature.ts'), 'export const featureValue = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'src', 'index.ts'), "export async function loadFeature() {\n  return await import('./feature.js');\n}\ntype FeatureModule = import('./feature.js');\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'DynamicImportFixture',
      });
      const dynamicImport = result.symbols.find(
        (symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'src', 'index.ts') && symbol.metadata.importSource === './feature.js' && symbol.metadata.importKind === 'dynamic',
      );
      const typeReferenceImport = result.symbols.find(
        (symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'src', 'index.ts') && symbol.metadata.importSource === './feature.js' && symbol.metadata.importKind === 'type_reference',
      );

      expect(dynamicImport?.metadata).toMatchObject({
        importedNames: [],
        resolvedRelativePath: 'src/feature.ts',
        resolutionKind: 'relative',
        sourceKind: 'typescript_dynamic_import',
      });
      expect(typeReferenceImport?.metadata).toMatchObject({
        importedNames: [],
        resolvedRelativePath: 'src/feature.ts',
        resolutionKind: 'relative',
        sourceKind: 'typescript_type_reference_import',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('resolves workspace package exports import targets', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-package-exports-'));
    try {
      await mkdir(join(rootPath, 'packages', 'lib', 'src'), {
        recursive: true,
      });
      await mkdir(join(rootPath, 'apps', 'consumer', 'src'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'packages', 'lib', 'package.json'),
        JSON.stringify({
          name: '@fixture/lib',
          exports: {
            '.': './src/index.ts',
            './feature': './src/feature.ts',
          },
        }),
        'utf8',
      );
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'index.ts'), 'export const rootValue = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'feature.ts'), 'export const featureValue = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'apps', 'consumer', 'src', 'index.ts'), "import { featureValue } from '@fixture/lib/feature';\nexport const consumed = featureValue;\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'PackageExportsFixture',
      });
      const packageExportImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'consumer', 'src', 'index.ts') && symbol.metadata.importSource === '@fixture/lib/feature');

      expect(packageExportImport?.metadata).toMatchObject({
        importedNames: ['featureValue'],
        packageName: '@fixture/lib',
        resolvedRelativePath: 'packages/lib/src/feature.ts',
        resolutionKind: 'package_exports',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('resolves root package exports condition maps', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-package-exports-conditions-'));
    try {
      await mkdir(join(rootPath, 'packages', 'lib', 'src'), {
        recursive: true,
      });
      await mkdir(join(rootPath, 'apps', 'consumer', 'src'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'packages', 'lib', 'package.json'),
        JSON.stringify({
          name: '@fixture/condition-lib',
          exports: {
            types: './src/index.d.ts',
            import: {
              node: './src/node.ts',
              default: './src/index.ts',
            },
            require: './src/index.cjs',
          },
        }),
        'utf8',
      );
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'index.ts'), 'export const conditionValue = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'node.ts'), 'export const nodeValue = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'apps', 'consumer', 'src', 'index.ts'), "import { conditionValue } from '@fixture/condition-lib';\nexport const consumed = conditionValue;\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'PackageExportsConditionFixture',
      });
      const packageExportImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'consumer', 'src', 'index.ts') && symbol.metadata.importSource === '@fixture/condition-lib');

      expect(packageExportImport?.metadata).toMatchObject({
        importedNames: ['conditionValue'],
        packageName: '@fixture/condition-lib',
        resolvedRelativePath: 'packages/lib/src/index.ts',
        resolutionKind: 'package_exports',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('resolves browser and development package exports conditions before generic defaults', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-package-exports-env-conditions-'));
    try {
      await mkdir(join(rootPath, 'packages', 'lib', 'src'), {
        recursive: true,
      });
      await mkdir(join(rootPath, 'apps', 'consumer', 'src'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'packages', 'lib', 'package.json'),
        JSON.stringify({
          name: '@fixture/env-lib',
          exports: {
            '.': {
              browser: './src/browser.ts',
              import: './src/index.ts',
              default: './src/index.ts',
            },
            './feature': {
              import: {
                development: './src/feature.dev.ts',
                default: './src/feature.ts',
              },
            },
          },
        }),
        'utf8',
      );
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'browser.ts'), 'export const browserValue = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'feature.dev.ts'), 'export const featureValue = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'index.ts'), 'export const defaultValue = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'feature.ts'), 'export const featureValue = 0;\n', 'utf8');
      await writeFile(
        join(rootPath, 'apps', 'consumer', 'src', 'index.ts'),
        "import { browserValue } from '@fixture/env-lib';\nimport { featureValue } from '@fixture/env-lib/feature';\nexport const consumed = browserValue + featureValue;\n",
        'utf8',
      );

      const result = await scanProjectSource({
        rootPath,
        projectName: 'PackageExportsEnvConditionFixture',
      });
      const rootImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'consumer', 'src', 'index.ts') && symbol.metadata.importSource === '@fixture/env-lib');
      const featureImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'consumer', 'src', 'index.ts') && symbol.metadata.importSource === '@fixture/env-lib/feature');

      expect(rootImport?.metadata).toMatchObject({
        importedNames: ['browserValue'],
        packageName: '@fixture/env-lib',
        resolvedRelativePath: 'packages/lib/src/browser.ts',
        resolutionKind: 'package_exports',
      });
      expect(featureImport?.metadata).toMatchObject({
        importedNames: ['featureValue'],
        packageName: '@fixture/env-lib',
        resolvedRelativePath: 'packages/lib/src/feature.dev.ts',
        resolutionKind: 'package_exports',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('resolves package exports conditions by importer runtime environment', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-package-exports-runtime-conditions-'));
    try {
      await mkdir(join(rootPath, 'packages', 'lib', 'src'), {
        recursive: true,
      });
      await mkdir(join(rootPath, 'apps', 'desktop', 'src', 'renderer'), {
        recursive: true,
      });
      await mkdir(join(rootPath, 'apps', 'desktop', 'src', 'main'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'packages', 'lib', 'package.json'),
        JSON.stringify({
          name: '@fixture/runtime-lib',
          exports: {
            '.': {
              browser: './src/browser.ts',
              node: './src/node.ts',
              default: './src/index.ts',
            },
          },
        }),
        'utf8',
      );
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'browser.ts'), 'export const runtimeValue = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'node.ts'), 'export const runtimeValue = 2;\n', 'utf8');
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'index.ts'), 'export const runtimeValue = 0;\n', 'utf8');
      await writeFile(join(rootPath, 'apps', 'desktop', 'src', 'renderer', 'index.ts'), "import { runtimeValue } from '@fixture/runtime-lib';\nexport const rendererValue = runtimeValue;\n", 'utf8');
      await writeFile(join(rootPath, 'apps', 'desktop', 'src', 'main', 'index.ts'), "import { runtimeValue } from '@fixture/runtime-lib';\nexport const mainValue = runtimeValue;\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'PackageExportsRuntimeConditionFixture',
      });
      const rendererImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'desktop', 'src', 'renderer', 'index.ts') && symbol.metadata.importSource === '@fixture/runtime-lib');
      const mainImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'desktop', 'src', 'main', 'index.ts') && symbol.metadata.importSource === '@fixture/runtime-lib');

      expect(rendererImport?.metadata).toMatchObject({
        packageName: '@fixture/runtime-lib',
        resolvedRelativePath: 'packages/lib/src/browser.ts',
        resolutionKind: 'package_exports',
        runtimeEnvironment: 'browser',
        matchedExportConditions: ['browser'],
        availableExportConditions: expect.arrayContaining(['browser', 'node', 'default']),
      });
      expect(mainImport?.metadata).toMatchObject({
        packageName: '@fixture/runtime-lib',
        resolvedRelativePath: 'packages/lib/src/node.ts',
        resolutionKind: 'package_exports',
        runtimeEnvironment: 'node',
        matchedExportConditions: ['node'],
        availableExportConditions: expect.arrayContaining(['browser', 'node', 'default']),
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('resolves workspace package exports patterns with array fallback targets', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-package-exports-pattern-'));
    try {
      await mkdir(join(rootPath, 'packages', 'lib', 'src', 'features'), {
        recursive: true,
      });
      await mkdir(join(rootPath, 'apps', 'consumer', 'src'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'packages', 'lib', 'package.json'),
        JSON.stringify({
          name: '@fixture/pattern-lib',
          exports: {
            './features/*': ['./missing/features/*.ts', './src/features/*.ts'],
          },
        }),
        'utf8',
      );
      await writeFile(join(rootPath, 'packages', 'lib', 'src', 'features', 'alpha.ts'), 'export const alpha = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'apps', 'consumer', 'src', 'index.ts'), "import { alpha } from '@fixture/pattern-lib/features/alpha';\nexport const consumed = alpha;\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'PackageExportsPatternFixture',
      });
      const patternImport = result.symbols.find(
        (symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'consumer', 'src', 'index.ts') && symbol.metadata.importSource === '@fixture/pattern-lib/features/alpha',
      );

      expect(patternImport?.metadata).toMatchObject({
        importedNames: ['alpha'],
        packageName: '@fixture/pattern-lib',
        resolvedRelativePath: 'packages/lib/src/features/alpha.ts',
        resolutionKind: 'package_exports',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('resolves import aliases from nested project tsconfig paths', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-nested-tsconfig-'));
    try {
      await mkdir(join(rootPath, 'apps', 'web', 'src', 'lib'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'apps', 'web', 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@local/*': ['./src/lib/*'],
            },
          },
        }),
        'utf8',
      );
      await writeFile(join(rootPath, 'apps', 'web', 'src', 'lib', 'tool.ts'), 'export const tool = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'apps', 'web', 'src', 'index.ts'), "import { tool } from '@local/tool';\nexport const value = tool;\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'NestedTsconfigFixture',
      });
      const nestedTsconfigImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'web', 'src', 'index.ts') && symbol.metadata.importSource === '@local/tool');

      expect(nestedTsconfigImport?.metadata).toMatchObject({
        importedNames: ['tool'],
        resolvedRelativePath: 'apps/web/src/lib/tool.ts',
        resolutionKind: 'tsconfig_paths',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('merges nested project tsconfig paths from extends chains', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-tsconfig-extends-'));
    try {
      await mkdir(join(rootPath, 'apps', 'web', 'src', 'shared'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'apps', 'web', 'tsconfig.paths.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@shared/*': ['./src/shared/*'],
            },
          },
        }),
        'utf8',
      );
      await writeFile(
        join(rootPath, 'apps', 'web', 'tsconfig.json'),
        JSON.stringify({
          extends: './tsconfig.paths.json',
          compilerOptions: {
            strict: true,
          },
        }),
        'utf8',
      );
      await writeFile(join(rootPath, 'apps', 'web', 'src', 'shared', 'thing.ts'), 'export const thing = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'apps', 'web', 'src', 'index.ts'), "import { thing } from '@shared/thing';\nexport const value = thing;\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'TsconfigExtendsFixture',
      });
      const inheritedAliasImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'web', 'src', 'index.ts') && symbol.metadata.importSource === '@shared/thing');

      expect(inheritedAliasImport?.metadata).toMatchObject({
        importedNames: ['thing'],
        resolvedRelativePath: 'apps/web/src/shared/thing.ts',
        resolutionKind: 'tsconfig_paths',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('resolves import aliases from JSONC tsconfig files with comments and trailing commas', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-jsonc-tsconfig-'));
    try {
      await mkdir(join(rootPath, 'apps', 'web', 'src', 'jsonc'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'apps', 'web', 'tsconfig.json'),
        `{
        // Zeus 必须兼容 TypeScript 常见的 JSONC 配置。
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@jsonc/*": ["./src/jsonc/*"],
          },
        },
      }`,
        'utf8',
      );
      await writeFile(join(rootPath, 'apps', 'web', 'src', 'jsonc', 'tool.ts'), 'export const jsoncTool = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'apps', 'web', 'src', 'index.ts'), "import { jsoncTool } from '@jsonc/tool';\nexport const value = jsoncTool;\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'JsoncTsconfigFixture',
      });
      const jsoncAliasImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'web', 'src', 'index.ts') && symbol.metadata.importSource === '@jsonc/tool');

      expect(jsoncAliasImport?.metadata).toMatchObject({
        importedNames: ['jsoncTool'],
        resolvedRelativePath: 'apps/web/src/jsonc/tool.ts',
        resolutionKind: 'tsconfig_paths',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('merges tsconfig paths from npm package extends', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-npm-tsconfig-extends-'));
    try {
      await mkdir(join(rootPath, 'apps', 'web', 'src', 'pkg'), {
        recursive: true,
      });
      await mkdir(join(rootPath, 'node_modules', '@fixture', 'tsconfig'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'node_modules', '@fixture', 'tsconfig', 'package.json'),
        JSON.stringify({
          name: '@fixture/tsconfig',
          main: 'base.json',
        }),
        'utf8',
      );
      await writeFile(
        join(rootPath, 'node_modules', '@fixture', 'tsconfig', 'base.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '../../../apps/web',
            paths: {
              '@pkg/*': ['./src/pkg/*'],
            },
          },
        }),
        'utf8',
      );
      await writeFile(
        join(rootPath, 'apps', 'web', 'tsconfig.json'),
        JSON.stringify({
          extends: '@fixture/tsconfig',
          compilerOptions: {
            strict: true,
          },
        }),
        'utf8',
      );
      await writeFile(join(rootPath, 'apps', 'web', 'src', 'pkg', 'tool.ts'), 'export const pkgTool = 1;\n', 'utf8');
      await writeFile(join(rootPath, 'apps', 'web', 'src', 'index.ts'), "import { pkgTool } from '@pkg/tool';\nexport const value = pkgTool;\n", 'utf8');

      const result = await scanProjectSource({
        rootPath,
        projectName: 'NpmTsconfigExtendsFixture',
      });
      const inheritedPackageAliasImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.filePath === join(rootPath, 'apps', 'web', 'src', 'index.ts') && symbol.metadata.importSource === '@pkg/tool');

      expect(inheritedPackageAliasImport?.metadata).toMatchObject({
        importedNames: ['pkgTool'],
        resolvedRelativePath: 'apps/web/src/pkg/tool.ts',
        resolutionKind: 'tsconfig_paths',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('resolves same-file direct function calls from API handlers', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const searchGraphCall = result.symbols.find(
      (symbol) =>
        symbol.symbolType === 'function_call' &&
        symbol.filePath === '/Users/david/hypha/zeus/packages/local-server/src/index.ts' &&
        symbol.metadata.calleeExpression === 'searchCurrentGraphNodes' &&
        symbol.metadata.ownerQualifiedName === 'packages/local-server/src/index.ts#handler:GET:/api/graph/search',
    );

    expect(searchGraphCall?.metadata).toMatchObject({
      sourceKind: 'typescript_function_call',
      targetFunction: 'searchCurrentGraphNodes',
      targetQualifiedName: 'packages/local-server/src/index.ts#searchCurrentGraphNodes',
      targetResolutionKind: 'same_file_function',
    });
  });

  it('resolves imported bare function calls to workspace function targets', async () => {
    const result = await scanProjectSource({
      rootPath: '/Users/david/hypha/zeus',
      projectName: 'Zeus',
    });
    const statusTransitionCall = result.symbols.find(
      (symbol) =>
        symbol.symbolType === 'function_call' &&
        symbol.filePath === '/Users/david/hypha/zeus/packages/local-server/src/index.ts' &&
        symbol.metadata.calleeExpression === 'getNextTaskStatus' &&
        symbol.metadata.ownerQualifiedName === 'packages/local-server/src/index.ts#handler:PATCH:/api/tasks/:taskId/status',
    );

    expect(statusTransitionCall?.metadata).toMatchObject({
      sourceKind: 'typescript_function_call',
      targetFunction: 'getNextTaskStatus',
      targetQualifiedName: 'packages/task-core/src/index.ts#getNextTaskStatus',
      targetResolutionKind: 'imported_function',
      targetImportSource: '@zeus/task-core',
    });
  });

  it('extracts Java Spring controller, service, repository, and method facts from real sample files', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-java-scan-'));
    try {
      await mkdir(join(rootPath, 'src/main/java/com/example/demo'), {
        recursive: true,
      });
      await mkdir(join(rootPath, 'src/main/java/com/example/shared'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'src/main/java/com/example/demo/UserController.java'),
        `package com.example.demo;

import com.example.shared.UserDto;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/users")
public class UserController {
  private final UserService userService;

  public UserController(UserService userService) {
    this.userService = userService;
  }

  @GetMapping("/{id}")
  public UserDto getUser(Long id) {
    return userService.findUser(id);
  }
}
`,
      );
      await writeFile(
        join(rootPath, 'src/main/java/com/example/demo/UserService.java'),
        `package com.example.demo;

import org.springframework.scheduling.annotation.Async;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.example.shared.UserDto;

@Service
public class UserService {
  private final UserMapper userMapper;

  public UserService(UserMapper userMapper) {
    this.userMapper = userMapper;
  }

  @Transactional(readOnly = true)
  @Async
  public UserDto findUser(Long id) {
    logger.info("find user {}", id);
    String normalized = UserUtil.normalize(id);
    UserDto user = userMapper.selectUser(id);
    user.getName();
    user.setName(normalized);
    return user;
  }

  @Scheduled(cron = "0 */5 * * * *")
  public void refreshUserCache() {
    userMapper.selectUser(1L);
  }
}
`,
      );
      await writeFile(
        join(rootPath, 'src/main/java/com/example/demo/UserChangedConsumer.java'),
        `package com.example.demo;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class UserChangedConsumer {
  @KafkaListener(topics = "user.changed")
  public void onUserChanged(String payload) {
    System.out.println(payload);
  }
}
`,
      );
      await writeFile(
        join(rootPath, 'src/main/java/com/example/demo/BillingClient.java'),
        `package com.example.demo;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import com.example.shared.BillingDto;

@FeignClient(name = "billing-service", url = "\${billing.url}")
public interface BillingClient {
  @GetMapping("/api/billing/{id}")
  BillingDto getBilling(Long id);
}
`,
      );
      await writeFile(
        join(rootPath, 'src/main/java/com/example/demo/UserMapper.java'),
        `package com.example.demo;

import org.apache.ibatis.annotations.Mapper;
import com.example.shared.UserDto;

@Mapper
public interface UserMapper {
  UserDto selectUser(Long id);
}
`,
      );
      await writeFile(
        join(rootPath, 'src/main/java/com/example/shared/UserDto.java'),
        `package com.example.shared;

public class UserDto {
  private String name;
}
`,
      );
      await writeFile(
        join(rootPath, 'src/main/java/com/example/shared/BillingDto.java'),
        `package com.example.shared;

public class BillingDto {
}
`,
      );

      const result = await scanProjectSource({
        rootPath,
        projectName: 'JavaSample',
      });
      const api = result.symbols.find((symbol) => symbol.symbolType === 'api' && symbol.name === 'GET /api/users/{id}');
      const serviceClass = result.symbols.find((symbol) => symbol.qualifiedName.endsWith('#UserService'));
      const mapperClass = result.symbols.find((symbol) => symbol.qualifiedName.endsWith('#UserMapper'));
      const remoteClient = result.symbols.find((symbol) => symbol.qualifiedName.endsWith('#BillingClient'));
      const controllerMethod = result.symbols.find((symbol) => symbol.qualifiedName.endsWith('#UserController.getUser'));
      const serviceMethod = result.symbols.find((symbol) => symbol.qualifiedName.endsWith('#UserService.findUser'));
      const scheduledJob = result.symbols.find((symbol) => symbol.qualifiedName.endsWith('#UserService.refreshUserCache'));
      const mqConsumer = result.symbols.find((symbol) => symbol.qualifiedName.endsWith('#UserChangedConsumer.onUserChanged'));
      const serviceCall = result.symbols.find(
        (symbol) => symbol.symbolType === 'function_call' && symbol.metadata.calleeExpression === 'userService.findUser' && symbol.metadata.ownerQualifiedName?.toString().endsWith('#UserController.getUser'),
      );
      const serviceMethodCalls = result.symbols.filter((symbol) => symbol.symbolType === 'function_call' && symbol.metadata.ownerQualifiedName?.toString().endsWith('#UserService.findUser'));
      const localJavaImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.metadata.importSource === 'com.example.shared.UserDto' && symbol.filePath.endsWith('UserController.java'));
      const externalJavaImport = result.symbols.find((symbol) => symbol.symbolType === 'import' && symbol.metadata.importSource === 'org.springframework.web.bind.annotation.GetMapping' && symbol.filePath.endsWith('UserController.java'));

      expect(api).toEqual(
        expect.objectContaining({
          filePath: join(rootPath, 'src/main/java/com/example/demo/UserController.java'),
          metadata: expect.objectContaining({
            framework: 'spring',
            method: 'GET',
            path: '/api/users/{id}',
            className: 'UserController',
            handlerQualifiedName: expect.stringContaining('#UserController.getUser'),
          }),
        }),
      );
      expect(serviceClass?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'java_class',
          stereotype: 'service',
        }),
      );
      expect(mapperClass?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'java_interface',
          stereotype: 'mybatis_mapper',
        }),
      );
      expect(remoteClient?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'java_interface',
          stereotype: 'remote_client',
          remoteClientName: 'billing-service',
        }),
      );
      expect(controllerMethod?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'java_method',
          className: 'UserController',
        }),
      );
      expect(serviceMethod?.metadata).toEqual(expect.objectContaining({ transactional: true, async: true }));
      expect(scheduledJob?.metadata).toEqual(
        expect.objectContaining({
          entryPoint: 'job',
          schedule: '0 */5 * * * *',
        }),
      );
      expect(mqConsumer?.metadata).toEqual(
        expect.objectContaining({
          entryPoint: 'mq_consumer',
          topics: ['user.changed'],
        }),
      );
      expect(localJavaImport?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'java_import',
          external: false,
          resolvedRelativePath: 'src/main/java/com/example/shared/UserDto.java',
          importedNames: ['UserDto'],
        }),
      );
      expect(externalJavaImport?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'java_import',
          external: true,
          packageName: 'org.springframework',
        }),
      );
      expect(serviceMethodCalls.map((symbol) => symbol.metadata.calleeExpression)).toEqual(['userMapper.selectUser']);
      expect(serviceCall?.metadata).toEqual(expect.objectContaining({ targetHint: 'findUser' }));
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('extracts MyBatis XML SQL statements, result maps, tables, and columns from real mapper XML', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-mybatis-scan-'));
    try {
      await mkdir(join(rootPath, 'src/main/resources/mapper'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'src/main/resources/mapper/UserMapper.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.demo.UserMapper">
  <resultMap id="UserResult" type="com.example.demo.UserDto">
    <id column="id" property="id"/>
    <result column="user_name" property="name"/>
  </resultMap>
  <select id="selectUser" resultMap="UserResult">
    SELECT u.id, u.user_name, o.id AS order_id
    FROM users u
    JOIN orders o ON u.id = o.user_id
    WHERE u.id = #{id}
  </select>
  <update id="renameUser">
    UPDATE users SET user_name = #{name} WHERE id = #{id}
  </update>
</mapper>
`,
      );

      const result = await scanProjectSource({
        rootPath,
        projectName: 'MyBatisSample',
      });
      const selectSql = result.symbols.find((symbol) => symbol.symbolType === 'sql_call' && symbol.name.includes('SELECT users'));
      const updateSql = result.symbols.find((symbol) => symbol.symbolType === 'sql_call' && symbol.name.includes('UPDATE users'));
      const usersTable = result.symbols.find((symbol) => symbol.symbolType === 'table' && symbol.name === 'users');
      const ordersTable = result.symbols.find((symbol) => symbol.symbolType === 'table' && symbol.name === 'orders');
      const userNameColumn = result.symbols.find((symbol) => symbol.symbolType === 'column' && symbol.name === 'users.user_name');

      expect(selectSql?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'mybatis_xml_statement',
          mapperNamespace: 'com.example.demo.UserMapper',
          statementId: 'selectUser',
          operation: 'SELECT',
          tableNames: ['users', 'orders'],
          readColumns: expect.arrayContaining(['id', 'user_name']),
          joinColumns: expect.arrayContaining(['id', 'user_id']),
          joinRelations: [
            expect.objectContaining({
              leftTable: 'users',
              leftColumn: 'id',
              rightTable: 'orders',
              rightColumn: 'user_id',
            }),
          ],
          whereColumns: ['id'],
        }),
      );
      expect(updateSql?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'mybatis_xml_statement',
          statementId: 'renameUser',
          operation: 'UPDATE',
          writeColumns: ['user_name'],
          whereColumns: ['id'],
        }),
      );
      expect(usersTable?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'mybatis_xml_table',
          mapperNamespace: 'com.example.demo.UserMapper',
        }),
      );
      expect(ordersTable?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'mybatis_xml_table',
          mapperNamespace: 'com.example.demo.UserMapper',
        }),
      );
      expect(userNameColumn?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'mybatis_xml_column',
          tableName: 'users',
          columnName: 'user_name',
        }),
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('extracts Maven, Gradle, and Spring Boot configuration facts from real build files', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'zeus-java-build-scan-'));
    try {
      await mkdir(join(rootPath, 'src/main/java/com/example/demo'), {
        recursive: true,
      });
      await writeFile(
        join(rootPath, 'pom.xml'),
        `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo-parent</artifactId>
  <version>1.0.0</version>
  <modules>
    <module>demo-service</module>
  </modules>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.3.0</version>
    </dependency>
  </dependencies>
</project>
`,
      );
      await writeFile(
        join(rootPath, 'build.gradle'),
        `plugins {
  id 'java'
  id 'org.springframework.boot' version '3.3.0'
}

dependencies {
  implementation 'org.mybatis.spring.boot:mybatis-spring-boot-starter:3.0.3'
}
`,
      );
      await writeFile(
        join(rootPath, 'src/main/java/com/example/demo/DemoApplication.java'),
        `package com.example.demo;

import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {
}
`,
      );

      const result = await scanProjectSource({
        rootPath,
        projectName: 'JavaBuildSample',
      });
      const mavenModule = result.symbols.find((symbol) => symbol.symbolType === 'config' && symbol.name === 'Maven module demo-service');
      const mavenDependency = result.symbols.find((symbol) => symbol.symbolType === 'dependency' && symbol.name === 'org.springframework.boot:spring-boot-starter-web');
      const gradlePlugin = result.symbols.find((symbol) => symbol.symbolType === 'config' && symbol.name === 'Gradle plugin org.springframework.boot');
      const gradleDependency = result.symbols.find((symbol) => symbol.symbolType === 'dependency' && symbol.name === 'org.mybatis.spring.boot:mybatis-spring-boot-starter');
      const bootApp = result.symbols.find((symbol) => symbol.qualifiedName.endsWith('#DemoApplication'));

      expect(mavenModule?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'maven_module',
          modulePath: 'demo-service',
        }),
      );
      expect(mavenDependency?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'maven_dependency',
          groupId: 'org.springframework.boot',
          artifactId: 'spring-boot-starter-web',
          version: '3.3.0',
        }),
      );
      expect(gradlePlugin?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'gradle_plugin',
          pluginId: 'org.springframework.boot',
          version: '3.3.0',
        }),
      );
      expect(gradleDependency?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'gradle_dependency',
          configuration: 'implementation',
          groupId: 'org.mybatis.spring.boot',
          artifactId: 'mybatis-spring-boot-starter',
          version: '3.0.3',
        }),
      );
      expect(bootApp?.metadata).toEqual(
        expect.objectContaining({
          sourceKind: 'java_class',
          stereotype: 'spring_boot_application',
        }),
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
