import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalServer } from '../src/index';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'zeus-graph-view-api-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('graph view API', () => {
  it('returns the selected project graph view instead of the first cached project with the same view type', async () => {
    const firstRoot = join(tempDir, 'first-project');
    const secondRoot = join(tempDir, 'second-project');
    await mkdir(join(firstRoot, 'src'), { recursive: true });
    await mkdir(join(secondRoot, 'src'), { recursive: true });
    await writeFile(join(firstRoot, 'src', 'first.ts'), 'export function firstProjectOnly() { return 1; }\n', 'utf8');
    await writeFile(join(secondRoot, 'src', 'second.ts'), 'export function secondProjectOnly() { return 2; }\n', 'utf8');
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: firstRoot,
    });
    const firstProjectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'First Graph Project', localPath: firstRoot },
    });
    const secondProjectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Second Graph Project', localPath: secondRoot },
    });
    const firstProject = firstProjectResponse.json() as { id: string };
    const secondProject = secondProjectResponse.json() as { id: string };

    await server.inject({
      method: 'POST',
      url: `/api/projects/${firstProject.id}/scan`,
      headers: { authorization: 'Bearer token' },
    });
    await server.inject({
      method: 'POST',
      url: `/api/projects/${secondProject.id}/scan`,
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/projects/${secondProject.id}/graph/views/architecture`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    expect(view.title).toContain('Second Graph Project');
    expect(JSON.stringify(view)).toContain('secondProjectOnly');
    expect(JSON.stringify(view)).not.toContain('firstProjectOnly');
    await server.close();
  });

  it('keeps project graph caches isolated by project id when two projects share the same display name', async () => {
    const firstRoot = join(tempDir, 'same-name-first-project');
    const secondRoot = join(tempDir, 'same-name-second-project');
    await mkdir(join(firstRoot, 'src'), { recursive: true });
    await mkdir(join(secondRoot, 'src'), { recursive: true });
    await writeFile(join(firstRoot, 'src', 'first.ts'), 'export function firstSameNameProjectOnly() { return 1; }\n', 'utf8');
    await writeFile(join(secondRoot, 'src', 'second.ts'), 'export function secondSameNameProjectOnly() { return 2; }\n', 'utf8');
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: firstRoot,
    });
    const firstProjectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Shared Display Name', localPath: firstRoot },
    });
    const secondProjectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'Shared Display Name', localPath: secondRoot },
    });
    const firstProject = firstProjectResponse.json() as { id: string };
    const secondProject = secondProjectResponse.json() as { id: string };

    await server.inject({
      method: 'POST',
      url: `/api/projects/${firstProject.id}/scan`,
      headers: { authorization: 'Bearer token' },
    });
    await server.inject({
      method: 'POST',
      url: `/api/projects/${secondProject.id}/scan`,
      headers: { authorization: 'Bearer token' },
    });

    const firstViewResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${firstProject.id}/graph/views/architecture`,
      headers: { authorization: 'Bearer token' },
    });
    const secondViewResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${secondProject.id}/graph/views/architecture`,
      headers: { authorization: 'Bearer token' },
    });
    const firstViewBody = firstViewResponse.body;
    const secondViewBody = secondViewResponse.body;

    expect(firstViewResponse.statusCode).toBe(200);
    expect(secondViewResponse.statusCode).toBe(200);
    expect(firstViewBody).toContain('firstSameNameProjectOnly');
    expect(firstViewBody).not.toContain('secondSameNameProjectOnly');
    expect(secondViewBody).toContain('secondSameNameProjectOnly');
    expect(secondViewBody).not.toContain('firstSameNameProjectOnly');
    await server.close();
  });

  it('returns a recoverable 404 for a project graph view before any graph cache table exists', async () => {
    const projectRoot = join(tempDir, 'fresh-unscanned-project');
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, 'src', 'fresh.ts'), 'export function freshOnly() { return 1; }\n', 'utf8');
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: join(tempDir, 'zeus-root'),
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'tc-app-core', localPath: projectRoot },
    });
    const project = projectResponse.json() as { id: string };

    const response = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/graph/views/architecture`,
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: 'ZEUS_GRAPH_VIEW_NOT_FOUND',
      message: 'Graph view not found. Scan the project first.',
    });
    expect(response.body).not.toContain('Internal Server Error');
    await server.close();
  });

  it('does not reuse the global Zeus current-repo graph for an unscanned project alias', async () => {
    const projectRoot = join(tempDir, 'current-root-alias');
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, 'src', 'alias.ts'), 'export function aliasProjectOnly() { return 1; }\n', 'utf8');
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot,
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: { name: 'tc-app-core', localPath: projectRoot },
    });
    const project = projectResponse.json() as { id: string };

    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const viewResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/graph/views/architecture`,
      headers: { authorization: 'Bearer token' },
    });
    const listResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/graph/views`,
      headers: { authorization: 'Bearer token' },
    });

    expect(viewResponse.statusCode).toBe(404);
    expect(viewResponse.json()).toMatchObject({
      error: 'ZEUS_GRAPH_VIEW_NOT_FOUND',
    });
    expect(viewResponse.body).not.toContain('Zeus 系统架构图');
    expect(listResponse.statusCode).toBe(200);
    expect((listResponse.json() as { views: unknown[] }).views).toEqual([]);
    await server.close();
  });

  it('returns a real graph view with sourced nodes and edges after scanning the current repository', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/architecture',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    expect(view.title).toContain('系统架构图');
    expect(view.nodes.length).toBeGreaterThan(0);
    expect(view.edges.length).toBeGreaterThan(0);
    expect(view.nodes[0]).toMatchObject({
      sourceRef: expect.stringContaining('/'),
    });
    expect(view.nodes[0].metadata.lineStart).toEqual(expect.any(Number));
    expect(view.edges[0]).toMatchObject({
      sourceRef: expect.any(String),
      confidence: expect.any(Number),
    });
    expect(view.layout).toMatchObject({
      algorithm: 'hierarchical',
      width: 1440,
      height: 900,
    });
    expect(view.layout.positions.length).toBe(view.nodes.length);
    expect(view.layout.positions[0]).toEqual(
      expect.objectContaining({
        nodeId: view.nodes[0].id,
        x: expect.any(Number),
        y: expect.any(Number),
      }),
    );
    await server.close();
  });

  it('returns real graph view performance metrics only when performance monitoring is enabled', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const defaultResponse = await server.inject({
      method: 'GET',
      url: '/api/graph/views/architecture',
      headers: { authorization: 'Bearer token' },
    });
    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.json().performance).toBeUndefined();

    const settingsResponse = await server.inject({
      method: 'PUT',
      url: '/api/code-map/settings',
      headers: { authorization: 'Bearer token' },
      payload: {
        defaultScanScope: 'project',
        defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
        maxCallChainDepth: 3,
        showLowConfidenceEdges: false,
        layoutAlgorithm: 'hierarchical',
        graphCacheStrategy: 'sqlite',
        tableRelationInference: 'foreign_key_and_name',
        aiSummaryEnabled: false,
        incrementalScanEnabled: true,
        performanceMonitoringEnabled: true,
      },
    });
    expect(settingsResponse.statusCode).toBe(200);

    const measuredResponse = await server.inject({
      method: 'GET',
      url: '/api/graph/views/architecture',
      headers: { authorization: 'Bearer token' },
    });
    const measuredView = measuredResponse.json() as {
      performance?: {
        durationMs?: number;
        nodeCount?: number;
        edgeCount?: number;
      };
    };

    expect(measuredResponse.statusCode).toBe(200);
    expect(measuredView.performance?.durationMs).toEqual(expect.any(Number));
    expect(measuredView.performance?.durationMs).toBeGreaterThanOrEqual(0);
    expect(measuredView.performance?.nodeCount).toBeGreaterThan(0);
    expect(measuredView.performance?.edgeCount).toBeGreaterThan(0);
    await server.close();
  });

  it('serves every design-book code map view type without inventing unsourced graph data', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    for (const viewType of ['module', 'table', 'module_detail', 'api_sequence', 'module_flow', 'method_logic']) {
      const response = await server.inject({
        method: 'GET',
        url: `/api/graph/views/${viewType}`,
        headers: { authorization: 'Bearer token' },
      });
      expect(response.statusCode).toBe(200);
      const view = response.json();
      expect(view.viewType).toBe(viewType);
      expect(Array.isArray(view.nodes)).toBe(true);
      expect(Array.isArray(view.edges)).toBe(true);
      expect(view.nodes.every((node: { sourceRef?: string }) => typeof node.sourceRef === 'string' && node.sourceRef.includes('/'))).toBe(true);
      expect(view.edges.every((edge: { sourceRef?: string; confidence?: number }) => typeof edge.sourceRef === 'string' && typeof edge.confidence === 'number')).toBe(true);
    }
    await server.close();
  });

  it('returns source-backed SQLite table nodes and inferred table relationships in table view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/table',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const projectNode = view.nodes.find((node: { name: string; sourceRef: string }) => node.name === 'projects' && node.sourceRef === '/Users/david/hypha/zeus/packages/storage/src/index.ts');
    const taskNode = view.nodes.find((node: { name: string; sourceRef: string }) => node.name === 'tasks' && node.sourceRef === '/Users/david/hypha/zeus/packages/storage/src/index.ts');
    expect(view.nodes.map((node: { name: string }) => node.name)).toContain('projects');
    expect(view.nodes.map((node: { name: string }) => node.name)).toContain('tasks');
    expect(projectNode.metadata.columnDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'slug',
          dataType: 'TEXT',
          notNull: true,
          unique: true,
        }),
      ]),
    );
    expect(taskNode.metadata.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_tasks_project_status_updated_at',
          columns: ['project_id', 'status', 'updated_at'],
        }),
      ]),
    );
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'references',
          sourceRef: '/Users/david/hypha/zeus/packages/storage/src/index.ts',
          confidence: 0.6,
        }),
      ]),
    );
    await server.close();
  });

  it('honors code map table relation inference settings when generating table views', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const settingsResponse = await server.inject({
      method: 'PUT',
      url: '/api/code-map/settings',
      headers: { authorization: 'Bearer token' },
      payload: {
        defaultScanScope: 'project',
        defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
        maxCallChainDepth: 3,
        showLowConfidenceEdges: false,
        layoutAlgorithm: 'hierarchical',
        graphCacheStrategy: 'sqlite',
        tableRelationInference: 'disabled',
        aiSummaryEnabled: false,
        incrementalScanEnabled: true,
        performanceMonitoringEnabled: false,
      },
    });
    expect(settingsResponse.statusCode).toBe(200);

    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });
    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/table',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    expect(view.nodes.map((node: { name: string }) => node.name)).toContain('projects');
    expect(view.edges.map((edge: { edgeType: string }) => edge.edgeType)).not.toContain('references');
    await server.close();
  });

  it('returns source-backed API route nodes in the API sequence view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/api_sequence',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const dashboardApiNode = view.nodes.find((node: { nodeType: string; name: string }) => node.nodeType === 'api' && node.name === 'GET /api/dashboard');
    const dashboardHandlerNode = view.nodes.find((node: { qualifiedName: string }) => node.qualifiedName === 'packages/local-server/src/index.ts#handler:GET:/api/dashboard');
    expect(view.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeType: 'api',
          name: 'GET /api/dashboard',
          sourceRef: '/Users/david/hypha/zeus/packages/local-server/src/index.ts',
        }),
        expect.objectContaining({
          nodeType: 'function',
          name: 'GET /api/dashboard handler',
          sourceRef: '/Users/david/hypha/zeus/packages/local-server/src/index.ts',
        }),
      ]),
    );
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'exposes_api',
          sourceRef: '/Users/david/hypha/zeus/packages/local-server/src/index.ts',
          confidence: 1,
        }),
        expect.objectContaining({
          edgeType: 'handles_api',
          sourceNodeId: dashboardApiNode.id,
          targetNodeId: dashboardHandlerNode.id,
          confidence: 0.9,
        }),
      ]),
    );
    await server.close();
  });

  it('returns source-backed control-flow nodes in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    expect(view.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeType: 'control_flow',
          metadata: expect.objectContaining({ controlType: 'if' }),
        }),
        expect.objectContaining({
          nodeType: 'control_flow',
          metadata: expect.objectContaining({ controlType: 'return' }),
        }),
      ]),
    );
    expect(view.edges).toEqual(expect.arrayContaining([expect.objectContaining({ edgeType: 'control_flow', confidence: 1 })]));
    await server.close();
  });

  it('returns function-owned control-flow edges in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const createLocalServerNode = view.nodes.find((node: { qualifiedName: string }) => node.qualifiedName === 'packages/local-server/src/index.ts#createLocalServer');
    const ownedControlFlowNode = view.nodes.find((node: { nodeType: string; metadata: { ownerFunction?: string } }) => node.nodeType === 'control_flow' && node.metadata.ownerFunction === 'createLocalServer');

    expect(createLocalServerNode).toBeDefined();
    expect(ownedControlFlowNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'control_flow',
          sourceNodeId: createLocalServerNode.id,
          targetNodeId: ownedControlFlowNode.id,
          confidence: 0.9,
        }),
      ]),
    );
    await server.close();
  });

  it('returns source-order control-flow edges in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const createLocalServerControlNodes = view.nodes
      .filter((node: { nodeType: string; metadata: { ownerFunction?: string; lineStart?: number } }) => node.nodeType === 'control_flow' && node.metadata.ownerFunction === 'createLocalServer')
      .sort((a: { metadata: { lineStart?: number } }, b: { metadata: { lineStart?: number } }) => Number(a.metadata.lineStart) - Number(b.metadata.lineStart));

    expect(createLocalServerControlNodes.length).toBeGreaterThan(1);
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'next_control_flow',
          sourceNodeId: createLocalServerControlNodes[0].id,
          targetNodeId: createLocalServerControlNodes[1].id,
          confidence: 0.75,
        }),
      ]),
    );
    await server.close();
  });

  it('returns loop continue and break edges in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const walkLoopNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerQualifiedName?: string; controlType?: string } }) =>
        node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#walk' && node.metadata.controlType === 'loop',
    );
    const walkContinueNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerQualifiedName?: string; controlType?: string } }) =>
        node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#walk' && node.metadata.controlType === 'continue',
    );
    const collectLoopNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerQualifiedName?: string; controlType?: string } }) =>
        node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#collectSqlStatementSnippet' && node.metadata.controlType === 'loop',
    );
    const collectBreakNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerQualifiedName?: string; controlType?: string } }) =>
        node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#collectSqlStatementSnippet' && node.metadata.controlType === 'break',
    );

    expect(walkLoopNode).toBeDefined();
    expect(walkContinueNode).toBeDefined();
    expect(collectLoopNode).toBeDefined();
    expect(collectBreakNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'loop_continue',
          sourceNodeId: walkContinueNode.id,
          targetNodeId: walkLoopNode.id,
          confidence: 0.64,
        }),
        expect.objectContaining({
          edgeType: 'loop_break',
          sourceNodeId: collectBreakNode.id,
          targetNodeId: collectLoopNode.id,
          confidence: 0.6,
        }),
      ]),
    );
    await server.close();
  });

  it('returns try-to-catch exception branch edges in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const taskStatusTryNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerQualifiedName?: string; controlType?: string } }) =>
        node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/local-server/src/index.ts#handler:PATCH:/api/tasks/:taskId/status' && node.metadata.controlType === 'try',
    );
    const taskStatusCatchNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerQualifiedName?: string; controlType?: string } }) =>
        node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/local-server/src/index.ts#handler:PATCH:/api/tasks/:taskId/status' && node.metadata.controlType === 'catch',
    );

    expect(taskStatusTryNode).toBeDefined();
    expect(taskStatusCatchNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'try_catch',
          sourceNodeId: taskStatusTryNode.id,
          targetNodeId: taskStatusCatchNode.id,
          confidence: 0.62,
        }),
      ]),
    );
    await server.close();
  });

  it('returns try-to-finally cleanup branch edges in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const selectTryNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerQualifiedName?: string; controlType?: string } }) =>
        node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/storage/src/index.ts#ZeusDatabase.select' && node.metadata.controlType === 'try',
    );
    const selectFinallyNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerQualifiedName?: string; controlType?: string } }) =>
        node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/storage/src/index.ts#ZeusDatabase.select' && node.metadata.controlType === 'finally',
    );

    expect(selectTryNode).toBeDefined();
    expect(selectFinallyNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'try_finally',
          sourceNodeId: selectTryNode.id,
          targetNodeId: selectFinallyNode.id,
          confidence: 0.58,
        }),
      ]),
    );
    await server.close();
  });

  it('returns loop back edges in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const loopNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerQualifiedName?: string; controlType?: string } }) =>
        node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#scanProjectSource' && node.metadata.controlType === 'loop',
    );

    expect(loopNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'loop_back',
          sourceNodeId: loopNode.id,
          targetNodeId: loopNode.id,
          confidence: 0.66,
        }),
      ]),
    );
    await server.close();
  });

  it('returns function-owned SQL call nodes and execution edges in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const getJsonNode = view.nodes.find((node: { qualifiedName: string }) => node.qualifiedName === 'packages/storage/src/index.ts#SettingRepository.getJson');
    const getJsonSqlNode = view.nodes.find(
      (node: {
        nodeType: string;
        metadata: {
          ownerFunction?: string;
          operation?: string;
          tableNames?: string[];
        };
      }) => node.nodeType === 'sql_call' && node.metadata.ownerFunction === 'SettingRepository.getJson' && node.metadata.operation === 'SELECT' && Array.isArray(node.metadata.tableNames) && node.metadata.tableNames.includes('settings'),
    );

    expect(getJsonNode).toBeDefined();
    expect(getJsonSqlNode).toBeDefined();
    expect(getJsonSqlNode.metadata).toMatchObject({
      selectedFields: expect.arrayContaining(['key', 'value_json', 'updated_at']),
      whereFields: expect.arrayContaining(['key']),
    });
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'executes_sql',
          sourceNodeId: getJsonNode.id,
          targetNodeId: getJsonSqlNode.id,
          confidence: 0.9,
        }),
      ]),
    );
    await server.close();
  });

  it('returns awaited function calls in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const scanProjectSourceNode = view.nodes.find((node: { qualifiedName: string }) => node.qualifiedName === 'packages/code-indexer/src/index.ts#scanProjectSource');
    const awaitedListSourceFilesCall = view.nodes.find(
      (node: {
        nodeType: string;
        metadata: {
          ownerQualifiedName?: string;
          calleeExpression?: string;
          isAwaited?: boolean;
        };
      }) => node.nodeType === 'function_call' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#scanProjectSource' && node.metadata.calleeExpression === 'listSourceFiles' && node.metadata.isAwaited === true,
    );

    expect(scanProjectSourceNode).toBeDefined();
    expect(awaitedListSourceFilesCall).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'awaits_call',
          sourceNodeId: scanProjectSourceNode.id,
          targetNodeId: awaitedListSourceFilesCall.id,
          confidence: 0.78,
        }),
      ]),
    );
    await server.close();
  });

  it('returns promise catch branch edges in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const mainCallNode = view.nodes.find(
      (node: { nodeType: string; sourceRef: string; metadata: { calleeExpression?: string; promiseChainHandler?: string } }) =>
        node.nodeType === 'function_call' && node.sourceRef === '/Users/david/hypha/zeus/packages/code-indexer/src/cli.ts' && node.metadata.calleeExpression === 'main' && node.metadata.promiseChainHandler === 'catch',
    );
    const promiseCatchNode = view.nodes.find(
      (node: { nodeType: string; sourceRef: string; metadata: { controlType?: string } }) =>
        node.nodeType === 'control_flow' && node.sourceRef === '/Users/david/hypha/zeus/packages/code-indexer/src/cli.ts' && node.metadata.controlType === 'promise_catch',
    );

    expect(mainCallNode).toBeDefined();
    expect(promiseCatchNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'promise_catch',
          sourceNodeId: mainCallNode.id,
          targetNodeId: promiseCatchNode.id,
          confidence: 0.61,
        }),
      ]),
    );
    await server.close();
  });

  it('returns promise then continuation edges in the method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const startupCoordinatorPath = '/Users/david/hypha/zeus/apps/desktop/src/main/startupCoordinator.ts';
    const promiseThenCallNode = view.nodes.find(
      (node: { nodeType: string; sourceRef: string; metadata: { calleeExpression?: string; promiseChainHandler?: string; lineStart?: number } }) =>
        node.nodeType === 'function_call' && node.sourceRef === startupCoordinatorPath && node.metadata.calleeExpression === 'Promise.resolve' && node.metadata.promiseChainHandler === 'then',
    );
    const promiseThenNode = view.nodes.find(
      (node: { nodeType: string; sourceRef: string; metadata: { controlType?: string; lineStart?: number } }) =>
        node.nodeType === 'control_flow' && node.sourceRef === startupCoordinatorPath && node.metadata.controlType === 'promise_then' && node.metadata.lineStart === promiseThenCallNode?.metadata.lineStart,
    );

    expect(promiseThenCallNode).toBeDefined();
    expect(promiseThenNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'promise_then',
          sourceNodeId: promiseThenCallNode.id,
          targetNodeId: promiseThenNode.id,
          confidence: 0.6,
        }),
      ]),
    );
    await server.close();
  });

  it('returns column nodes and SQL field impact edges in method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const projectSearchSqlNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerFunction?: string; operation?: string } }) => node.nodeType === 'sql_call' && node.metadata.ownerFunction === 'ProjectRepository.search' && node.metadata.operation === 'SELECT',
    );
    const slugColumnNode = view.nodes.find((node: { nodeType: string; qualifiedName: string }) => node.nodeType === 'column' && node.qualifiedName === 'packages/storage/src/index.ts#table:projects#column:slug');

    expect(projectSearchSqlNode).toBeDefined();
    expect(slugColumnNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'uses_column',
          sourceNodeId: projectSearchSqlNode.id,
          targetNodeId: slugColumnNode.id,
          confidence: 0.72,
        }),
      ]),
    );
    await server.close();
  });

  it('returns SQL read impact from repository methods to real table nodes in method logic view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/method_logic',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const projectSearchSqlNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerFunction?: string; operation?: string } }) => node.nodeType === 'sql_call' && node.metadata.ownerFunction === 'ProjectRepository.search' && node.metadata.operation === 'SELECT',
    );
    const projectsTableNode = view.nodes.find((node: { nodeType: string; qualifiedName: string }) => node.nodeType === 'table' && node.qualifiedName === 'packages/storage/src/index.ts#table:projects');

    expect(projectSearchSqlNode).toBeDefined();
    expect(projectsTableNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'reads_table',
          sourceNodeId: projectSearchSqlNode.id,
          targetNodeId: projectsTableNode.id,
          confidence: 0.85,
        }),
      ]),
    );
    await server.close();
  });

  it('returns API handler internal function calls in the API sequence view', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/api_sequence',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const projectsHandlerNode = view.nodes.find((node: { qualifiedName: string }) => node.qualifiedName === 'packages/local-server/src/index.ts#handler:GET:/api/projects');
    const projectsSearchCallNode = view.nodes.find((node: { nodeType: string; metadata: { calleeExpression?: string } }) => node.nodeType === 'function_call' && node.metadata.calleeExpression === 'projects.search');

    expect(projectsHandlerNode).toBeDefined();
    expect(projectsSearchCallNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'calls',
          sourceNodeId: projectsHandlerNode.id,
          targetNodeId: projectsSearchCallNode.id,
          confidence: 0.8,
        }),
      ]),
    );
    await server.close();
  });

  it('returns resolved class method targets for API handler calls', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/api_sequence',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const projectsSearchCallNode = view.nodes.find((node: { nodeType: string; metadata: { calleeExpression?: string } }) => node.nodeType === 'function_call' && node.metadata.calleeExpression === 'projects.search');
    const projectRepositorySearchNode = view.nodes.find((node: { qualifiedName: string }) => node.qualifiedName === 'packages/storage/src/index.ts#ProjectRepository.search');

    expect(projectsSearchCallNode).toBeDefined();
    expect(projectRepositorySearchNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'resolves_to',
          sourceNodeId: projectsSearchCallNode.id,
          targetNodeId: projectRepositorySearchNode.id,
          confidence: 0.7,
        }),
      ]),
    );
    await server.close();
  });

  it('returns API sequence SQL table impacts for resolved repository methods', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/api_sequence',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const projectRepositorySearchNode = view.nodes.find((node: { qualifiedName: string }) => node.qualifiedName === 'packages/storage/src/index.ts#ProjectRepository.search');
    const projectSearchSqlNode = view.nodes.find(
      (node: { nodeType: string; metadata: { ownerQualifiedName?: string; operation?: string } }) =>
        node.nodeType === 'sql_call' && node.metadata.ownerQualifiedName === 'packages/storage/src/index.ts#ProjectRepository.search' && node.metadata.operation === 'SELECT',
    );
    const projectsTableNode = view.nodes.find((node: { qualifiedName: string }) => node.qualifiedName === 'packages/storage/src/index.ts#table:projects');

    expect(projectRepositorySearchNode).toBeDefined();
    expect(projectSearchSqlNode).toBeDefined();
    expect(projectsTableNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'executes_sql',
          sourceNodeId: projectRepositorySearchNode.id,
          targetNodeId: projectSearchSqlNode.id,
        }),
        expect.objectContaining({
          edgeType: 'reads_table',
          sourceNodeId: projectSearchSqlNode.id,
          targetNodeId: projectsTableNode.id,
        }),
      ]),
    );
    await server.close();
  });

  it('returns source-backed module dependency edges from real imports', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/graph/views/module',
      headers: { authorization: 'Bearer token' },
    });

    expect(response.statusCode).toBe(200);
    const view = response.json();
    const localServerNode = view.nodes.find((node: { qualifiedName: string }) => node.qualifiedName === 'packages/local-server/src/index.ts');
    const storageNode = view.nodes.find((node: { qualifiedName: string }) => node.qualifiedName === 'packages/storage/src/index.ts');

    expect(localServerNode).toBeDefined();
    expect(storageNode).toBeDefined();
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'module_depends_on',
          sourceNodeId: localServerNode.id,
          targetNodeId: storageNode.id,
          confidence: 0.9,
        }),
      ]),
    );
    await server.close();
  });
});
