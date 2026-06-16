import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { startZeusLocalServer } from '../src/index.js';

describe('Zeus graph scan API', () => {
  it('scans a real project through project-scoped scan, status, and overview APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-project-scan-api-'));
    const serviceRoot = join(dir, 'service-root');
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(serviceRoot, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      await writeFile(join(projectRoot, 'project-entry.ts'), 'export function projectScopedScanRealSource() { return 42; }');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot: serviceRoot,
      });
      const projectResponse = await fetch(`${running.baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Scoped Scan Project',
          localPath: projectRoot,
        }),
      });
      const project = (await projectResponse.json()) as { id: string };

      const scanResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/scan`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      const scan = await scanResponse.json();
      const statusResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/scan-status`, {
        headers: { authorization: 'Bearer scan-token' },
      });
      const overviewResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/overview`, {
        headers: { authorization: 'Bearer scan-token' },
      });
      const status = await statusResponse.json();
      const overview = await overviewResponse.json();

      expect(scanResponse.status).toBe(200);
      expect(statusResponse.status).toBe(200);
      expect(overviewResponse.status).toBe(200);
      expect(scan.rootPath).toBe(projectRoot);
      expect(scan.fileCount).toBe(1);
      expect(status).toMatchObject({
        projectId: project.id,
        scanStatus: 'completed',
      });
      expect(overview.project).toMatchObject({
        id: project.id,
        scanStatus: 'completed',
      });
      expect(overview.graph.nodeCount).toBe(scan.nodeCount);
      expect(overview.graph.edgeCount).toBe(scan.edgeCount);
      expect(overview.git.isRepository).toBe(false);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists code map settings and applies configured ignore directories to real scans', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scan-settings-'));
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await mkdir(join(projectRoot, 'generated-real'), { recursive: true });
      await writeFile(join(projectRoot, 'src', 'kept.ts'), 'export function keptRealSource() { return 1; }');
      await writeFile(join(projectRoot, 'generated-real', 'ignored.ts'), 'export function ignoredRealSource() { return 2; }');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot,
      });

      const saveResponse = await fetch(`${running.baseUrl}/api/code-map/settings`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          defaultScanScope: 'project',
          defaultIgnoreDirectories: ['generated-real'],
          maxCallChainDepth: 4,
          showLowConfidenceEdges: false,
          layoutAlgorithm: 'hierarchical',
          graphCacheStrategy: 'sqlite',
          tableRelationInference: 'foreign_key_and_name',
          aiSummaryEnabled: false,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: true,
        }),
      });
      expect(saveResponse.status).toBe(200);
      expect(await saveResponse.json()).toMatchObject({
        defaultIgnoreDirectories: ['generated-real'],
        maxCallChainDepth: 4,
        layoutAlgorithm: 'hierarchical',
      });

      const scanResponse = await fetch(`${running.baseUrl}/api/graph/scan-current`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      const scan = await scanResponse.json();
      const settingsResponse = await fetch(`${running.baseUrl}/api/code-map/settings`, {
        headers: { authorization: 'Bearer scan-token' },
      });

      expect(scanResponse.status).toBe(200);
      expect(scan.fileCount).toBe(1);
      expect(await settingsResponse.json()).toMatchObject({
        defaultIgnoreDirectories: ['generated-real'],
      });
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('honors src scan scope by scanning the real src directory instead of the project root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scan-scope-'));
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await writeFile(join(projectRoot, 'root-only.ts'), 'export function rootOnlyRealSource() { return 1; }');
      await writeFile(join(projectRoot, 'src', 'src-only.ts'), 'export function srcOnlyRealSource() { return 2; }');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot,
      });

      const saveResponse = await fetch(`${running.baseUrl}/api/code-map/settings`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          defaultScanScope: 'src',
          defaultIgnoreDirectories: [],
          maxCallChainDepth: 3,
          showLowConfidenceEdges: false,
          layoutAlgorithm: 'hierarchical',
          graphCacheStrategy: 'sqlite',
          tableRelationInference: 'foreign_key_and_name',
          aiSummaryEnabled: false,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: false,
        }),
      });
      expect(saveResponse.status).toBe(200);

      const scanResponse = await fetch(`${running.baseUrl}/api/graph/scan-current`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      const scan = await scanResponse.json();

      expect(scanResponse.status).toBe(200);
      expect(scan.fileCount).toBe(1);
      expect(scan.rootPath).toBe(join(projectRoot, 'src'));
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('includes user-configured DDL schema paths when src scan scope would otherwise skip them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scan-imported-ddl-'));
    const serviceRoot = join(dir, 'service-root');
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(serviceRoot, { recursive: true });
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await mkdir(join(projectRoot, 'schema'), { recursive: true });
      await writeFile(join(projectRoot, 'src', 'index.ts'), 'export function appEntryRealSource() { return 1; }');
      await writeFile(join(projectRoot, 'schema', 'tenant.sql'), ['CREATE TABLE tenant_accounts (', '  id TEXT PRIMARY KEY,', '  display_name TEXT NOT NULL', ');'].join('\n'));
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot: serviceRoot,
      });
      const projectResponse = await fetch(`${running.baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Imported DDL Project',
          localPath: projectRoot,
        }),
      });
      const project = (await projectResponse.json()) as { id: string };

      await fetch(`${running.baseUrl}/api/code-map/settings`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          defaultScanScope: 'src',
          defaultIgnoreDirectories: [],
          maxCallChainDepth: 3,
          showLowConfidenceEdges: false,
          layoutAlgorithm: 'hierarchical',
          graphCacheStrategy: 'sqlite',
          tableRelationInference: 'foreign_key_and_name',
          aiSummaryEnabled: false,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: false,
        }),
      });
      const configResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/config`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          database: {
            connectionName: 'imported-ddl',
            schemaPaths: ['schema/tenant.sql'],
          },
        }),
      });
      expect(configResponse.status).toBe(200);

      const scanResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/scan`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      const scan = await scanResponse.json();
      const tablesResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/tables`, {
        headers: { authorization: 'Bearer scan-token' },
      });
      const tables = (await tablesResponse.json()) as {
        items: Array<{ name: string; sourceRef: string }>;
      };

      expect(scanResponse.status).toBe(200);
      expect(scan.fileCount).toBe(2);
      expect(tables.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'tenant_accounts',
            sourceRef: expect.stringContaining('schema/tenant.sql'),
          }),
        ]),
      );
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('introspects a user-configured local SQLite database connection during project scan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scan-sqlite-introspection-'));
    const serviceRoot = join(dir, 'service-root');
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(serviceRoot, { recursive: true });
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await mkdir(join(projectRoot, 'db'), { recursive: true });
      await writeFile(join(projectRoot, 'src', 'index.ts'), 'export function sqliteBackedRealSource() { return 1; }');
      const SQL = await initSqlJs();
      const sqlite = new SQL.Database();
      sqlite.run(
        [
          'CREATE TABLE app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);',
          'CREATE TABLE app_orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_users(id));',
          'CREATE INDEX idx_app_orders_user_id ON app_orders(user_id);',
        ].join('\n'),
      );
      await writeFile(join(projectRoot, 'db', 'app.sqlite'), Buffer.from(sqlite.export()));

      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot: serviceRoot,
      });
      const projectResponse = await fetch(`${running.baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'SQLite Introspection Project',
          localPath: projectRoot,
        }),
      });
      const project = (await projectResponse.json()) as { id: string };

      await fetch(`${running.baseUrl}/api/code-map/settings`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          defaultScanScope: 'src',
          defaultIgnoreDirectories: [],
          maxCallChainDepth: 3,
          showLowConfidenceEdges: false,
          layoutAlgorithm: 'hierarchical',
          graphCacheStrategy: 'sqlite',
          tableRelationInference: 'foreign_key_and_name',
          aiSummaryEnabled: false,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: false,
        }),
      });
      const configResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/config`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          database: {
            connectionName: 'sqlite:db/app.sqlite',
            schemaPaths: [],
          },
        }),
      });
      expect(configResponse.status).toBe(200);

      const scanResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/scan`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      const scan = await scanResponse.json();
      const tablesResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/tables`, {
        headers: { authorization: 'Bearer scan-token' },
      });
      const tables = (await tablesResponse.json()) as {
        items: Array<{
          name: string;
          sourceRef: string;
          metadata: Record<string, unknown>;
        }>;
      };
      const orders = tables.items.find((item) => item.name === 'app_orders');

      expect(scanResponse.status).toBe(200);
      expect(scan.fileCount).toBe(2);
      expect(orders).toMatchObject({
        name: 'app_orders',
        sourceRef: expect.stringContaining('schema-introspection/db_app.sqlite/schema.sql'),
        metadata: expect.objectContaining({
          sourceKind: 'database_introspection',
        }),
      });
      expect(orders?.metadata.foreignKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            referencedTable: 'app_users',
            columns: ['user_id'],
            referencedColumns: ['id'],
          }),
        ]),
      );
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails project scan clearly when configured SQLite database path is invalid instead of silently skipping schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scan-invalid-sqlite-'));
    const serviceRoot = join(dir, 'service-root');
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(serviceRoot, { recursive: true });
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await writeFile(join(projectRoot, 'src', 'index.ts'), 'export function invalidSqliteConfigRealSource() { return 1; }');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot: serviceRoot,
      });
      const projectResponse = await fetch(`${running.baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Invalid SQLite Project',
          localPath: projectRoot,
        }),
      });
      const project = (await projectResponse.json()) as { id: string };
      await fetch(`${running.baseUrl}/api/code-map/settings`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          defaultScanScope: 'src',
          defaultIgnoreDirectories: [],
          maxCallChainDepth: 3,
          showLowConfidenceEdges: false,
          layoutAlgorithm: 'hierarchical',
          graphCacheStrategy: 'sqlite',
          tableRelationInference: 'foreign_key_and_name',
          aiSummaryEnabled: false,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: false,
        }),
      });
      await fetch(`${running.baseUrl}/api/projects/${project.id}/config`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          database: {
            connectionName: 'sqlite:db/missing.sqlite',
            schemaPaths: [],
          },
        }),
      });

      const scanResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/scan`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      const scan = (await scanResponse.json()) as {
        error: string;
        message: string;
      };
      const statusResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/scan-status`, {
        headers: { authorization: 'Bearer scan-token' },
      });

      expect(scanResponse.status).toBe(500);
      expect(scan).toMatchObject({
        error: 'ZEUS_GRAPH_SCAN_FAILED',
        message: expect.stringContaining('SQLite database file is not accessible'),
      });
      expect(scan.message).toContain('db/missing.sqlite');
      expect(scan.message).not.toContain(projectRoot);
      expect(statusResponse.status).toBe(200);
      expect((await statusResponse.json()).scanStatus).toBe('failed');
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails project scan clearly when configured Postgres connection requires an unavailable driver instead of silently skipping schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scan-postgres-driver-missing-'));
    const serviceRoot = join(dir, 'service-root');
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(serviceRoot, { recursive: true });
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await writeFile(join(projectRoot, 'src', 'index.ts'), 'export function postgresConfigRealSource() { return 1; }');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot: serviceRoot,
      });
      const projectResponse = await fetch(`${running.baseUrl}/api/projects`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Postgres Driver Missing Project',
          localPath: projectRoot,
        }),
      });
      const project = (await projectResponse.json()) as { id: string };
      await fetch(`${running.baseUrl}/api/code-map/settings`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          defaultScanScope: 'src',
          defaultIgnoreDirectories: [],
          maxCallChainDepth: 3,
          showLowConfidenceEdges: false,
          layoutAlgorithm: 'hierarchical',
          graphCacheStrategy: 'sqlite',
          tableRelationInference: 'foreign_key_and_name',
          aiSummaryEnabled: false,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: false,
        }),
      });
      const configResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/config`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          database: {
            connectionName: 'postgresql://zeus@localhost:5432/app',
            schemaPaths: [],
          },
        }),
      });
      expect(configResponse.status).toBe(200);

      const scanResponse = await fetch(`${running.baseUrl}/api/projects/${project.id}/scan`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      const scan = (await scanResponse.json()) as {
        error: string;
        message: string;
      };

      expect(scanResponse.status).toBe(500);
      expect(scan).toMatchObject({
        error: 'ZEUS_GRAPH_SCAN_FAILED',
        message: expect.stringContaining('Postgres database introspection driver is not installed'),
      });
      expect(scan.message).toContain('postgresql');
      expect(scan.message).not.toContain('secret-password');
      expect(scan.message).not.toContain(projectRoot);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns real scan performance metrics only when performance monitoring is enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scan-performance-'));
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await writeFile(join(projectRoot, 'src', 'measured.ts'), 'export function measuredRealSource() { return 1; }');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot,
      });

      const defaultScanResponse = await fetch(`${running.baseUrl}/api/graph/scan-current`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      const defaultScan = (await defaultScanResponse.json()) as {
        performance?: { durationMs?: number };
      };
      expect(defaultScanResponse.status).toBe(200);
      expect(defaultScan.performance).toBeUndefined();

      const saveResponse = await fetch(`${running.baseUrl}/api/code-map/settings`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          defaultScanScope: 'project',
          defaultIgnoreDirectories: [],
          maxCallChainDepth: 3,
          showLowConfidenceEdges: false,
          layoutAlgorithm: 'hierarchical',
          graphCacheStrategy: 'sqlite',
          tableRelationInference: 'foreign_key_and_name',
          aiSummaryEnabled: false,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: true,
        }),
      });
      expect(saveResponse.status).toBe(200);

      const scanResponse = await fetch(`${running.baseUrl}/api/graph/scan-current`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      const scan = (await scanResponse.json()) as {
        performance?: { durationMs?: number };
      };

      expect(scanResponse.status).toBe(200);
      expect(scan.performance?.durationMs).toEqual(expect.any(Number));
      expect(scan.performance?.durationMs).toBeGreaterThanOrEqual(0);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clears persisted graph views when graph cache strategy is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-graph-cache-disabled-'));
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await writeFile(join(projectRoot, 'src', 'cached.ts'), 'export function cachedRealSource() { return 1; }');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot,
      });

      const firstScanResponse = await fetch(`${running.baseUrl}/api/graph/scan-current`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      expect(firstScanResponse.status).toBe(200);
      const cachedViewResponse = await fetch(`${running.baseUrl}/api/graph/views/architecture`, {
        headers: { authorization: 'Bearer scan-token' },
      });
      expect(cachedViewResponse.status).toBe(200);

      const saveResponse = await fetch(`${running.baseUrl}/api/code-map/settings`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          defaultScanScope: 'project',
          defaultIgnoreDirectories: [],
          maxCallChainDepth: 3,
          showLowConfidenceEdges: false,
          layoutAlgorithm: 'hierarchical',
          graphCacheStrategy: 'disabled',
          tableRelationInference: 'foreign_key_and_name',
          aiSummaryEnabled: false,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: false,
        }),
      });
      expect(saveResponse.status).toBe(200);

      const disabledScanResponse = await fetch(`${running.baseUrl}/api/graph/scan-current`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      const disabledScan = (await disabledScanResponse.json()) as {
        nodeCount: number;
        viewCount: number;
      };
      expect(disabledScanResponse.status).toBe(200);
      expect(disabledScan.nodeCount).toBeGreaterThan(0);
      expect(disabledScan.viewCount).toBeGreaterThan(0);

      const staleViewResponse = await fetch(`${running.baseUrl}/api/graph/views/architecture`, {
        headers: { authorization: 'Bearer scan-token' },
      });
      expect(staleViewResponse.status).toBe(404);
      const dashboardResponse = await fetch(`${running.baseUrl}/api/dashboard`, {
        headers: { authorization: 'Bearer scan-token' },
      });
      const dashboard = (await dashboardResponse.json()) as {
        graph: { nodeCount: number; edgeCount: number; viewCount: number };
      };
      expect(dashboard.graph).toMatchObject({
        nodeCount: 0,
        edgeCount: 0,
        viewCount: 0,
      });
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serves graph views from memory without persisting SQLite graph cache when graph cache strategy is memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-graph-cache-memory-'));
    const projectRoot = join(dir, 'project-root');
    try {
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      await writeFile(join(projectRoot, 'src', 'memory.ts'), 'export function memoryRealSource() { return 1; }');
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot,
      });

      const saveResponse = await fetch(`${running.baseUrl}/api/code-map/settings`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer scan-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          defaultScanScope: 'project',
          defaultIgnoreDirectories: [],
          maxCallChainDepth: 3,
          showLowConfidenceEdges: false,
          layoutAlgorithm: 'hierarchical',
          graphCacheStrategy: 'memory',
          tableRelationInference: 'foreign_key_and_name',
          aiSummaryEnabled: false,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: false,
        }),
      });
      expect(saveResponse.status).toBe(200);

      const scanResponse = await fetch(`${running.baseUrl}/api/graph/scan-current`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      expect(scanResponse.status).toBe(200);
      const viewResponse = await fetch(`${running.baseUrl}/api/graph/views/architecture`, {
        headers: { authorization: 'Bearer scan-token' },
      });
      expect(viewResponse.status).toBe(200);
      const view = (await viewResponse.json()) as {
        nodes: unknown[];
        edges: unknown[];
      };
      expect(view.nodes.length).toBeGreaterThan(0);
      expect(view.edges.length).toBeGreaterThan(0);

      await running.close();
      const restarted = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot,
      });
      const staleViewResponse = await fetch(`${restarted.baseUrl}/api/graph/views/architecture`, {
        headers: { authorization: 'Bearer scan-token' },
      });
      expect(staleViewResponse.status).toBe(404);
      await restarted.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scans the real current repository, persists graph counts, and exposes them on dashboard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scan-api-'));
    try {
      const running = await startZeusLocalServer({
        dbPath: join(dir, 'zeus.db'),
        apiToken: 'scan-token',
        projectRoot: '/Users/david/hypha/zeus',
      });
      const scanResponse = await fetch(`${running.baseUrl}/api/graph/scan-current`, {
        method: 'POST',
        headers: { authorization: 'Bearer scan-token' },
      });
      expect(scanResponse.status).toBe(200);
      const scan = await scanResponse.json();
      expect(scan.projectName).toBe('Zeus');
      expect(scan.fileCount).toBeGreaterThan(0);
      expect(scan.symbolCount).toBeGreaterThan(0);
      expect(scan.nodeCount).toBeGreaterThan(0);
      expect(scan.edgeCount).toBeGreaterThan(0);

      const dashboardResponse = await fetch(`${running.baseUrl}/api/dashboard`, {
        headers: { authorization: 'Bearer scan-token' },
      });
      const dashboard = await dashboardResponse.json();
      expect(dashboard.graph.nodeCount).toBe(scan.nodeCount);
      expect(dashboard.graph.edgeCount).toBe(scan.edgeCount);
      await running.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
