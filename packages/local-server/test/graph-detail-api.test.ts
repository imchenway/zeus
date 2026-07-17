import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalServer } from '../src/index';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'zeus-graph-detail-api-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('graph detail API', () => {
  it('preserves SQL JOIN edge metadata across graph view, edge detail, and neighborhood APIs', async () => {
    const projectRoot = join(tempDir, 'join-project');
    const mapperDir = join(projectRoot, 'src/main/resources/mapper');
    await mkdir(mapperDir, { recursive: true });
    await writeFile(
      join(mapperDir, 'UserMapper.xml'),
      `
<mapper namespace="com.example.UserMapper">
  <select id="selectUserOrders">
    SELECT u.id, o.user_id
    FROM users u
    JOIN orders o ON u.id = o.user_id
  </select>
</mapper>
`,
      'utf8',
    );

    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot,
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });

    const viewResponse = await server.inject({
      method: 'GET',
      url: '/api/graph/views/table',
      headers: { authorization: 'Bearer token' },
    });
    expect(viewResponse.statusCode).toBe(200);
    const joinEdge = viewResponse.json().edges.find((edge: { edgeType: string; confidence: number; metadata?: Record<string, unknown> }) => edge.edgeType === 'references' && edge.confidence === 0.6);
    expect(joinEdge?.metadata).toMatchObject({
      relationSource: 'sql_join',
      leftTable: 'users',
      leftColumn: 'id',
      rightTable: 'orders',
      rightColumn: 'user_id',
    });

    const edgeResponse = await server.inject({
      method: 'GET',
      url: `/api/graph/edges/${joinEdge.id}`,
      headers: { authorization: 'Bearer token' },
    });
    expect(edgeResponse.statusCode).toBe(200);
    expect(edgeResponse.json().metadata).toMatchObject({
      relationSource: 'sql_join',
    });

    const neighborhoodResponse = await server.inject({
      method: 'GET',
      url: `/api/graph/nodes/${joinEdge.sourceNodeId}/neighborhood?depth=1`,
      headers: { authorization: 'Bearer token' },
    });
    expect(neighborhoodResponse.statusCode).toBe(200);
    expect(neighborhoodResponse.json().edges.find((edge: { id: string }) => edge.id === joinEdge.id)?.metadata).toMatchObject({ relationSource: 'sql_join' });
    await server.close();
  });

  it('serves project-scoped semantic Code Map APIs for APIs, modules, tables, and method logic', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: {
        name: 'Semantic Code Map',
        localPath: '/Users/david/hypha/zeus',
      },
    });
    const project = projectResponse.json() as { id: string };
    await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/scan`,
      headers: { authorization: 'Bearer token' },
    });

    const apisResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/apis`,
      headers: { authorization: 'Bearer token' },
    });
    expect(apisResponse.statusCode).toBe(200);
    const api = apisResponse.json().items.find((item: { name: string }) => item.name === 'GET /api/dashboard');
    expect(api).toBeTruthy();
    const apiDetailResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/apis/${api.id}`,
      headers: { authorization: 'Bearer token' },
    });
    const apiSequenceResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/apis/${api.id}/sequence`,
      headers: { authorization: 'Bearer token' },
    });

    const modulesResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/modules`,
      headers: { authorization: 'Bearer token' },
    });
    expect(modulesResponse.statusCode).toBe(200);
    const moduleNode = modulesResponse.json().items.find((item: { nodeType: string; sourceRef: string }) => item.nodeType === 'file' && item.sourceRef.endsWith('/packages/local-server/src/index.ts'));
    expect(moduleNode).toBeTruthy();
    const moduleDetailResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/modules/${moduleNode.id}`,
      headers: { authorization: 'Bearer token' },
    });
    const moduleFlowResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/modules/${moduleNode.id}/flow`,
      headers: { authorization: 'Bearer token' },
    });

    const tablesResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/tables`,
      headers: { authorization: 'Bearer token' },
    });
    expect(tablesResponse.statusCode).toBe(200);
    const table = tablesResponse.json().items.find((item: { name: string }) => item.name === 'tasks');
    expect(table).toBeTruthy();
    const fieldSearchResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/tables/columns/search?query=slug`,
      headers: { authorization: 'Bearer token' },
    });
    const tableDetailResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/tables/${table.id}`,
      headers: { authorization: 'Bearer token' },
    });
    const tableImpactResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/tables/${table.id}/impact`,
      headers: { authorization: 'Bearer token' },
    });

    const methodViewResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/graph/views/method_logic`,
      headers: { authorization: 'Bearer token' },
    });
    const methodNode = methodViewResponse.json().nodes.find((item: { nodeType: string }) => item.nodeType === 'function');
    expect(methodNode).toBeTruthy();
    const methodLogicResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/methods/${methodNode.id}/logic`,
      headers: { authorization: 'Bearer token' },
    });

    expect(apiDetailResponse.statusCode).toBe(200);
    expect(apiDetailResponse.json().node).toMatchObject({
      id: api.id,
      nodeType: 'api',
    });
    expect(apiSequenceResponse.statusCode).toBe(200);
    expect(apiSequenceResponse.json().view.viewType).toBe('api_sequence');
    expect(apiSequenceResponse.json().nodes.some((item: { id: string }) => item.id === api.id)).toBe(true);

    expect(moduleDetailResponse.statusCode).toBe(200);
    expect(moduleDetailResponse.json().node).toMatchObject({
      id: moduleNode.id,
      nodeType: 'file',
    });
    expect(moduleFlowResponse.statusCode).toBe(200);
    expect(moduleFlowResponse.json().view.viewType).toBe('module_flow');

    expect(tableDetailResponse.statusCode).toBe(200);
    expect(tableDetailResponse.json().node).toMatchObject({
      id: table.id,
      nodeType: 'table',
    });
    expect(fieldSearchResponse.statusCode).toBe(200);
    expect(fieldSearchResponse.json()).toMatchObject({
      projectId: project.id,
      query: 'slug',
      viewType: 'table',
    });
    expect(fieldSearchResponse.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeType: 'column',
          name: 'projects.slug',
          sourceRef: expect.stringContaining('packages/storage/src/index.ts'),
        }),
      ]),
    );
    expect(tableImpactResponse.statusCode).toBe(200);
    expect(tableImpactResponse.json().nodes.some((item: { id: string }) => item.id === table.id)).toBe(true);

    expect(methodLogicResponse.statusCode).toBe(200);
    expect(methodLogicResponse.json().view.viewType).toBe('method_logic');
    expect(methodLogicResponse.json().nodes.some((item: { id: string }) => item.id === methodNode.id)).toBe(true);
    await server.close();
  });

  it('serves project-scoped graph view, search, node, and neighborhood aliases from real graph data', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: 'Bearer token' },
      payload: {
        name: 'Project Graph Alias',
        localPath: '/Users/david/hypha/zeus',
      },
    });
    const project = projectResponse.json() as { id: string };
    await server.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/scan`,
      headers: { authorization: 'Bearer token' },
    });

    const viewResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/graph/views/architecture`,
      headers: { authorization: 'Bearer token' },
    });
    expect(viewResponse.statusCode).toBe(200);
    const view = viewResponse.json();
    const node = view.nodes[0];
    const searchResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/graph/search?query=${encodeURIComponent(node.name)}`,
      headers: { authorization: 'Bearer token' },
    });
    const nodeResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/graph/nodes/${node.id}`,
      headers: { authorization: 'Bearer token' },
    });
    const neighborhoodResponse = await server.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/graph/nodes/${node.id}/neighborhood?depth=1`,
      headers: { authorization: 'Bearer token' },
    });

    expect(view.viewType).toBe('architecture');
    expect(view.projectId).toBe(project.id);
    expect(view.projectName).toBe('Project Graph Alias');
    expect(searchResponse.statusCode).toBe(200);
    expect(searchResponse.json().nodes.some((item: { id: string }) => item.id === node.id)).toBe(true);
    expect(nodeResponse.statusCode).toBe(200);
    expect(nodeResponse.json()).toMatchObject({
      id: node.id,
      sourceRef: node.sourceRef,
    });
    expect(neighborhoodResponse.statusCode).toBe(200);
    expect(neighborhoodResponse.json().centerNode.id).toBe(node.id);
    await server.close();
  });

  it('returns real edge detail and one-hop node neighborhood after scanning', async () => {
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
    const view = await server.inject({
      method: 'GET',
      url: '/api/graph/views/architecture',
      headers: { authorization: 'Bearer token' },
    });
    const edge = view.json().edges[0];

    const edgeResponse = await server.inject({
      method: 'GET',
      url: `/api/graph/edges/${edge.id}`,
      headers: { authorization: 'Bearer token' },
    });
    expect(edgeResponse.statusCode).toBe(200);
    expect(edgeResponse.json()).toMatchObject({
      id: edge.id,
      sourceRef: edge.sourceRef,
      sourceNode: expect.any(Object),
      targetNode: expect.any(Object),
    });

    const neighborhoodResponse = await server.inject({
      method: 'GET',
      url: `/api/graph/nodes/${edge.sourceNodeId}/neighborhood?depth=1`,
      headers: { authorization: 'Bearer token' },
    });
    expect(neighborhoodResponse.statusCode).toBe(200);
    const neighborhood = neighborhoodResponse.json();
    expect(neighborhood.depth).toBe(1);
    expect(neighborhood.centerNode.id).toBe(edge.sourceNodeId);
    expect(neighborhood.edges.some((item: { id: string }) => item.id === edge.id)).toBe(true);
    expect(neighborhood.nodes.length).toBeGreaterThan(0);
    await server.close();
  });

  it('returns edge detail and node neighborhood from memory graph cache without SQLite graph facts', async () => {
    const server = await createLocalServer({
      dbPath: join(tempDir, 'zeus.db'),
      apiToken: 'token',
      projectRoot: '/Users/david/hypha/zeus',
    });
    await server.inject({
      method: 'PUT',
      url: '/api/code-map/settings',
      headers: { authorization: 'Bearer token' },
      payload: {
        defaultScanScope: 'project',
        defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
        maxCallChainDepth: 3,
        showLowConfidenceEdges: false,
        layoutAlgorithm: 'hierarchical',
        graphCacheStrategy: 'memory',
        tableRelationInference: 'foreign_key_and_name',
        aiSummaryEnabled: false,
        incrementalScanEnabled: true,
        performanceMonitoringEnabled: false,
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/graph/scan-current',
      headers: { authorization: 'Bearer token' },
    });
    const view = await server.inject({
      method: 'GET',
      url: '/api/graph/views/architecture',
      headers: { authorization: 'Bearer token' },
    });
    const edge = view.json().edges[0];

    const edgeResponse = await server.inject({
      method: 'GET',
      url: `/api/graph/edges/${edge.id}`,
      headers: { authorization: 'Bearer token' },
    });
    expect(edgeResponse.statusCode).toBe(200);
    expect(edgeResponse.json()).toMatchObject({
      id: edge.id,
      sourceRef: edge.sourceRef,
      sourceNode: expect.any(Object),
      targetNode: expect.any(Object),
    });

    const neighborhoodResponse = await server.inject({
      method: 'GET',
      url: `/api/graph/nodes/${edge.sourceNodeId}/neighborhood?depth=1`,
      headers: { authorization: 'Bearer token' },
    });
    expect(neighborhoodResponse.statusCode).toBe(200);
    const neighborhood = neighborhoodResponse.json();
    expect(neighborhood.depth).toBe(1);
    expect(neighborhood.centerNode.id).toBe(edge.sourceNodeId);
    expect(neighborhood.edges.some((item: { id: string }) => item.id === edge.id)).toBe(true);
    expect(neighborhood.nodes.length).toBeGreaterThan(0);
    await server.close();
  });
});
