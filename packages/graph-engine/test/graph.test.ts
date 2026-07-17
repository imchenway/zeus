import { describe, expect, it } from 'vitest';
import { scanProjectSource } from '../../code-indexer/src/index.js';
import { buildProjectGraph, assertNonEmptyGraph } from '../src/index.js';

let realProjectGraphPromise: ReturnType<typeof loadRealProjectGraph> | undefined;

async function loadRealProjectGraph() {
  const scan = await scanProjectSource({
    rootPath: '/Users/david/hypha/zeus',
    projectName: 'Zeus',
  });
  return buildProjectGraph(scan);
}

function getRealProjectGraph() {
  realProjectGraphPromise ??= loadRealProjectGraph();
  return realProjectGraphPromise;
}

type GraphViewSelection = { nodeIds: string[]; edgeIds: string[] };
const visibleNodeIdsByView = new WeakMap<GraphViewSelection, Set<string>>();
const visibleEdgeIdsByView = new WeakMap<GraphViewSelection, Set<string>>();

function viewContainsNode(view: GraphViewSelection | undefined, nodeId: string): boolean {
  if (!view) return false;
  let visibleNodeIds = visibleNodeIdsByView.get(view);
  if (!visibleNodeIds) {
    visibleNodeIds = new Set(view.nodeIds);
    visibleNodeIdsByView.set(view, visibleNodeIds);
  }
  return visibleNodeIds.has(nodeId);
}

function viewContainsEdge(view: GraphViewSelection | undefined, edgeId: string): boolean {
  if (!view) return false;
  let visibleEdgeIds = visibleEdgeIdsByView.get(view);
  if (!visibleEdgeIds) {
    visibleEdgeIds = new Set(view.edgeIds);
    visibleEdgeIdsByView.set(view, visibleEdgeIds);
  }
  return visibleEdgeIds.has(edgeId);
}

describe('real project graph engine', () => {
  it('builds non-empty graph nodes and edges from real scan facts', async () => {
    const graph = await getRealProjectGraph();
    assertNonEmptyGraph(graph);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.nodes.every((node) => node.sourceRef.startsWith('/Users/david/hypha/zeus/'))).toBe(true);
  });

  it('generates all design-book code map views from sourced graph facts only', async () => {
    const graph = await getRealProjectGraph();
    const viewTypes = graph.views.map((view) => view.viewType);

    expect(viewTypes).toEqual(['architecture', 'module', 'table', 'module_detail', 'api_sequence', 'module_flow', 'method_logic']);

    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const edgeIds = new Set(graph.edges.map((edge) => edge.id));
    for (const view of graph.views) {
      expect(view.nodeIds.every((nodeId) => nodeIds.has(nodeId))).toBe(true);
      expect(view.edgeIds.every((edgeId) => edgeIds.has(edgeId))).toBe(true);
    }
  });

  it('filters architecture view edges to visible nodes so large project scans cannot crash graph renderers', () => {
    const sourceRef = '/real/large/src/index.ts';
    const scan = {
      projectName: 'Large Project',
      rootPath: '/real/large',
      symbols: [graphTestSymbol('file', 'index.ts', 'src/index.ts', sourceRef, {}), ...Array.from({ length: 300 }, (_, index) => graphTestSymbol('function', `handler${index}`, `src/index.ts#handler${index}`, sourceRef, {}))],
    };

    const graph = buildProjectGraph(scan);
    const architectureView = graph.views.find((view) => view.viewType === 'architecture');
    const visibleNodeIds = new Set(architectureView?.nodeIds ?? []);
    const visibleEdges = graph.edges.filter((edge) => viewContainsEdge(architectureView, edge.id));

    expect(architectureView?.nodeIds.length).toBe(250);
    expect(visibleEdges.length).toBeGreaterThan(0);
    expect(visibleEdges.every((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId))).toBe(true);
  });

  it('filters every capped graph view edge to visible nodes so project scans cannot crash graph renderers', () => {
    const sourceRef = '/real/large/src/index.ts';
    const scan = {
      projectName: 'Large Project',
      rootPath: '/real/large',
      symbols: [
        graphTestSymbol('file', 'index.ts', 'src/index.ts', sourceRef, {}),
        ...Array.from({ length: 900 }, (_, index) => graphTestSymbol('function', `handler${index}`, `src/index.ts#handler${index}`, sourceRef, {})),
        ...Array.from({ length: 900 }, (_, index) =>
          graphTestSymbol('control_flow', `if branch ${index}`, `src/index.ts#handler${index}:if:${index}`, sourceRef, {
            ownerQualifiedName: `src/index.ts#handler${index}`,
            controlKind: 'if',
          }),
        ),
      ],
    };

    const graph = buildProjectGraph(scan);
    const cappedViews = graph.views.filter((view) => ['module_detail', 'module_flow', 'method_logic'].includes(view.viewType));

    for (const view of cappedViews) {
      const visibleNodeIds = new Set(view.nodeIds);
      const visibleEdges = graph.edges.filter((edge) => viewContainsEdge(view, edge.id));

      expect(
        visibleEdges.every((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)),
        `${view.viewType} contains edges that point outside its visible node set`,
      ).toBe(true);
    }
  });

  it('caps module and table graph views before they reach the renderer so large project scans cannot freeze the app', () => {
    const sourceRef = '/real/large/src/index.ts';
    const scan = {
      projectName: 'Large Project',
      rootPath: '/real/large',
      symbols: [
        ...Array.from({ length: 1800 }, (_, index) => graphTestSymbol('file', `File${index}.ts`, `src/File${index}.ts`, `/real/large/src/File${index}.ts`, {})),
        ...Array.from({ length: 1400 }, (_, index) => graphTestSymbol('table', `table_${index}`, `schema.sql#table:table_${index}`, sourceRef, {})),
        ...Array.from({ length: 1400 }, (_, index) => graphTestSymbol('column', `column_${index}`, `schema.sql#table:table_${index}#column:column_${index}`, sourceRef, {})),
      ],
    };

    const graph = buildProjectGraph(scan);
    const moduleView = graph.views.find((view) => view.viewType === 'module');
    const tableView = graph.views.find((view) => view.viewType === 'table');

    expect(moduleView?.nodeIds.length).toBeLessThanOrEqual(1200);
    expect(tableView?.nodeIds.length).toBeLessThanOrEqual(1200);
    for (const view of [moduleView, tableView]) {
      const visibleNodeIds = new Set(view?.nodeIds ?? []);
      const visibleEdges = graph.edges.filter((edge) => viewContainsEdge(view, edge.id));
      expect(
        visibleEdges.every((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)),
        `${view?.viewType} contains edges that point outside its capped node set`,
      ).toBe(true);
    }
  });

  it('caps the default method logic view after priority evidence nodes so large scans do not ship the full control-flow payload', () => {
    const sourceRef = '/real/large/src/service.ts';
    const scan = {
      projectName: 'Large Method Logic',
      rootPath: '/real/large',
      symbols: [
        graphTestSymbol('file', 'service.ts', 'src/service.ts', sourceRef, {}),
        ...Array.from({ length: 7200 }, (_, index) =>
          graphTestSymbol('control_flow', `if branch ${index}`, `src/service.ts#handler${index}:if:${index}`, sourceRef, {
            ownerQualifiedName: `src/service.ts#handler${index}`,
            controlType: 'if',
          }),
        ),
        ...Array.from({ length: 80 }, (_, index) =>
          graphTestSymbol('sql_call', `SELECT order_${index}`, `src/service.ts#sql_call:SELECT:${index}`, sourceRef, {
            ownerQualifiedName: `src/service.ts#handler${index}`,
            tableQualifiedNames: [`schema.sql#table:orders_${index}`],
          }),
        ),
      ],
    };

    const graph = buildProjectGraph(scan);
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const visibleNodeIds = new Set(methodLogicView?.nodeIds ?? []);
    const visibleEdges = graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id));
    const visibleNodes = graph.nodes.filter((node) => visibleNodeIds.has(node.id));

    expect(methodLogicView?.nodeIds.length).toBeLessThanOrEqual(6000);
    expect(visibleNodes.some((node) => node.nodeType === 'sql_call')).toBe(true);
    expect(
      visibleEdges.every((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)),
      'method_logic contains edges that point outside its capped node set',
    ).toBe(true);
  });

  it('keeps complete exception evidence in a capped method logic view after unrelated control-flow growth', () => {
    const sourceRef = '/real/large/src/service.ts';
    const scan = {
      projectName: 'Large Exception Evidence',
      rootPath: '/real/large',
      symbols: [
        graphTestSymbol('file', 'service.ts', 'src/service.ts', sourceRef, {}),
        ...Array.from({ length: 6200 }, (_, index) =>
          graphTestSymbol('control_flow', `noise ${index}`, `src/service.ts#noise${index}:if`, sourceRef, {
            ownerQualifiedName: `src/service.ts#noise${index}`,
            controlType: 'if',
            lineStart: index + 1,
          }),
        ),
        graphTestSymbol('control_flow', 'try import', 'src/service.ts#import:try', sourceRef, {
          ownerQualifiedName: 'src/service.ts#import',
          controlType: 'try',
          lineStart: 7001,
        }),
        graphTestSymbol('control_flow', 'catch import', 'src/service.ts#import:catch', sourceRef, {
          ownerQualifiedName: 'src/service.ts#import',
          controlType: 'catch',
          lineStart: 7002,
        }),
      ],
    };

    const graph = buildProjectGraph(scan);
    const view = graph.views.find((candidate) => candidate.viewType === 'method_logic');
    const tryNode = graph.nodes.find((node) => node.qualifiedName === 'src/service.ts#import:try');
    const catchNode = graph.nodes.find((node) => node.qualifiedName === 'src/service.ts#import:catch');
    const edge = graph.edges.find((candidate) => candidate.edgeType === 'try_catch' && candidate.sourceNodeId === tryNode?.id && candidate.targetNodeId === catchNode?.id);

    expect(view?.nodeIds.length).toBeLessThanOrEqual(6000);
    expect(view?.nodeIds).toEqual(expect.arrayContaining([tryNode?.id, catchNode?.id]));
    expect(view?.edgeIds).toContain(edge?.id);
  });

  it('prioritizes module structure nodes over declarations before applying the module view cap', () => {
    const sourceRef = '/real/large/src/noise.ts';
    const scan = {
      projectName: 'Large Module Structure',
      rootPath: '/real/large',
      symbols: [
        ...Array.from({ length: 1200 }, (_, index) => graphTestSymbol('class', `Noise${index}`, `src/noise.ts#Noise${index}`, sourceRef, {})),
        graphTestSymbol('file', 'critical.ts', 'src/critical.ts', '/real/large/src/critical.ts', {}),
      ],
    };

    const graph = buildProjectGraph(scan);
    const view = graph.views.find((candidate) => candidate.viewType === 'module');
    const criticalFile = graph.nodes.find((node) => node.qualifiedName === 'src/critical.ts');

    expect(view?.nodeIds.length).toBeLessThanOrEqual(1200);
    expect(view?.nodeIds).toContain(criticalFile?.id);
  });

  it('prioritizes direct API handler calls over transitive expansion before applying the API sequence cap', () => {
    const sourceRef = '/real/large/src/api.ts';
    const scan = {
      projectName: 'Large API Sequence',
      rootPath: '/real/large',
      symbols: [
        graphTestSymbol('file', 'api.ts', 'src/api.ts', sourceRef, {}),
        graphTestSymbol('api', 'GET /items', 'src/api.ts#api:GET:/items', sourceRef, { handlerQualifiedName: 'src/api.ts#handler' }),
        graphTestSymbol('function', 'handler', 'src/api.ts#handler', sourceRef, {}),
        graphTestSymbol('function', 'target', 'src/api.ts#target', sourceRef, {}),
        graphTestSymbol('function_call', 'target()', 'src/api.ts#handler:call:target', sourceRef, {
          ownerQualifiedName: 'src/api.ts#handler',
          calleeExpression: 'target',
          targetQualifiedName: 'src/api.ts#target',
        }),
        ...Array.from({ length: 2100 }, (_, index) =>
          graphTestSymbol('function_call', `expanded${index}()`, `src/api.ts#target:call:expanded${index}`, sourceRef, {
            ownerQualifiedName: 'src/api.ts#target',
            calleeExpression: `expanded${index}`,
          }),
        ),
      ],
    };

    const graph = buildProjectGraph(scan);
    const view = graph.views.find((candidate) => candidate.viewType === 'api_sequence');
    const directCall = graph.nodes.find((node) => node.qualifiedName === 'src/api.ts#handler:call:target');
    const target = graph.nodes.find((node) => node.qualifiedName === 'src/api.ts#target');

    expect(view?.nodeIds.length).toBeLessThanOrEqual(2000);
    expect(view?.nodeIds).toEqual(expect.arrayContaining([directCall?.id, target?.id]));
  });

  it('precomputes deterministic layout coordinates for every cached graph view', async () => {
    const graph = await getRealProjectGraph();
    const architectureView = graph.views.find((view) => view.viewType === 'architecture');

    expect(architectureView?.layout).toMatchObject({
      algorithm: 'hierarchical',
      width: 1440,
      height: 900,
    });
    expect(architectureView?.layout.positions.length).toBe(architectureView?.nodeIds.length);
    expect(architectureView?.layout.positions[0]).toMatchObject({
      nodeId: architectureView?.nodeIds[0],
      x: expect.any(Number),
      y: expect.any(Number),
    });
  });

  it('adds real table nodes and inferred table relationship edges to the table view', async () => {
    const graph = await getRealProjectGraph();
    const tableView = graph.views.find((view) => view.viewType === 'table');
    const tableNodes = graph.nodes.filter((node) => viewContainsNode(tableView, node.id));
    const tableEdges = graph.edges.filter((edge) => viewContainsEdge(tableView, edge.id));

    expect(tableNodes.map((node) => node.name)).toContain('projects');
    expect(tableNodes.map((node) => node.name)).toContain('tasks');
    const storageProjectTable = tableNodes.find((node) => node.name === 'projects' && node.sourceRef === '/Users/david/hypha/zeus/packages/storage/src/index.ts');
    const storageTaskTable = tableNodes.find((node) => node.name === 'tasks' && node.sourceRef === '/Users/david/hypha/zeus/packages/storage/src/index.ts');

    expect(storageProjectTable?.metadata.columnDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'slug',
          dataType: 'TEXT',
          notNull: true,
          unique: true,
        }),
      ]),
    );
    expect(storageTaskTable?.metadata.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'idx_tasks_project_status_updated_at',
          columns: ['project_id', 'status', 'updated_at'],
        }),
      ]),
    );
    expect(tableEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'references',
          sourceRef: '/Users/david/hypha/zeus/packages/storage/src/index.ts',
          confidence: 0.6,
        }),
      ]),
    );
  });

  it('connects table nodes through source-declared foreign keys with full confidence', () => {
    const sourceRef = '/real/schema.sql';
    const scan = {
      projectName: 'Foreign Key Graph',
      rootPath: '/real',
      symbols: [
        graphTestSymbol('file', 'schema.sql', 'schema.sql', sourceRef, {}),
        graphTestSymbol('table', 'users', 'schema.sql#table:users', sourceRef, {
          schemaName: 'app',
          columns: ['id'],
        }),
        graphTestSymbol('table', 'orders', 'schema.sql#table:orders', sourceRef, {
          schemaName: 'app',
          columns: ['id', 'user_id'],
          foreignKeys: [
            {
              name: 'fk_orders_user',
              columns: ['user_id'],
              referencedSchema: 'app',
              referencedTable: 'users',
              referencedColumns: ['id'],
            },
          ],
        }),
      ],
    };

    const graph = buildProjectGraph(scan);
    const users = graph.nodes.find((node) => node.name === 'users');
    const orders = graph.nodes.find((node) => node.name === 'orders');

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'references',
          sourceNodeId: orders?.id,
          targetNodeId: users?.id,
          sourceRef,
          confidence: 1,
        }),
      ]),
    );
  });

  it('connects table nodes through source-backed SQL JOIN relations with inferred confidence', () => {
    const sourceRef = '/real/mapper/UserMapper.xml';
    const scan = {
      projectName: 'Join Relation Graph',
      rootPath: '/real',
      symbols: [
        graphTestSymbol('file', 'UserMapper.xml', 'mapper/UserMapper.xml', sourceRef, {}),
        graphTestSymbol('table', 'users', 'mapper/UserMapper.xml#table:users', sourceRef, {
          columns: ['id'],
        }),
        graphTestSymbol('table', 'orders', 'mapper/UserMapper.xml#table:orders', sourceRef, {
          columns: ['id', 'user_id'],
        }),
        graphTestSymbol('sql_call', 'SELECT users, orders L1', 'mapper/UserMapper.xml#mybatis:selectUser', sourceRef, {
          sourceKind: 'mybatis_xml_statement',
          tableNames: ['users', 'orders'],
          joinRelations: [
            {
              leftTable: 'users',
              leftColumn: 'id',
              rightTable: 'orders',
              rightColumn: 'user_id',
            },
          ],
        }),
      ],
    };

    const graph = buildProjectGraph(scan);
    const tableView = graph.views.find((view) => view.viewType === 'table');
    const users = graph.nodes.find((node) => node.name === 'users');
    const orders = graph.nodes.find((node) => node.name === 'orders');
    const tableEdges = graph.edges.filter((edge) => viewContainsEdge(tableView, edge.id));

    expect(tableEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'references',
          sourceNodeId: orders?.id,
          targetNodeId: users?.id,
          sourceRef,
          confidence: 0.6,
          metadata: expect.objectContaining({
            relationSource: 'sql_join',
            leftColumn: 'id',
            rightColumn: 'user_id',
          }),
        }),
      ]),
    );
  });

  it('adds real API route nodes and exposes_api edges to the API sequence view', async () => {
    const graph = await getRealProjectGraph();
    const apiSequenceView = graph.views.find((view) => view.viewType === 'api_sequence');
    const apiNodes = graph.nodes.filter((node) => viewContainsNode(apiSequenceView, node.id) && node.nodeType === 'api');
    const apiEdges = graph.edges.filter((edge) => viewContainsEdge(apiSequenceView, edge.id));
    const dashboardApiNode = apiNodes.find((node) => node.name === 'GET /api/dashboard');
    const dashboardHandlerNode = graph.nodes.find((node) => node.qualifiedName === 'packages/local-server/src/index.ts#handler:GET:/api/dashboard');

    expect(apiNodes.map((node) => node.name)).toContain('GET /api/dashboard');
    expect(apiNodes.find((node) => node.name === 'GET /api/dashboard')?.metadata).toMatchObject({ method: 'GET', path: '/api/dashboard' });
    expect(dashboardHandlerNode).toBeDefined();
    expect(apiEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'exposes_api',
          sourceRef: '/Users/david/hypha/zeus/packages/local-server/src/index.ts',
          confidence: 1,
        }),
        expect.objectContaining({
          edgeType: 'handles_api',
          sourceNodeId: dashboardApiNode?.id,
          targetNodeId: dashboardHandlerNode?.id,
          confidence: 0.9,
        }),
      ]),
    );
  });

  it('adds real control-flow nodes and edges to the method logic view', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const controlFlowNodes = graph.nodes.filter((node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow');
    const controlFlowEdges = graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id));

    expect(controlFlowNodes.map((node) => node.metadata.controlType)).toEqual(expect.arrayContaining(['if', 'return', 'try']));
    expect(controlFlowEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'control_flow',
          sourceRef: '/Users/david/hypha/zeus/packages/local-server/src/index.ts',
          confidence: 1,
        }),
      ]),
    );
  });

  it('adds else loop and throw nodes to the method logic view', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const controlFlowNodes = graph.nodes.filter((node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow');

    expect(controlFlowNodes.map((node) => node.metadata.controlType)).toEqual(expect.arrayContaining(['else', 'loop', 'throw']));
    expect(controlFlowNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            controlType: 'loop',
            loopKind: expect.any(String),
          }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({ controlType: 'throw' }),
        }),
      ]),
    );
  });

  it('connects method logic control-flow nodes to their owning function', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const createLocalServerNode = graph.nodes.find((node) => node.qualifiedName === 'packages/local-server/src/index.ts#createLocalServer');
    const ownedControlFlowNodes = graph.nodes.filter((node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerFunction === 'createLocalServer');
    const ownedControlFlowNodeIds = new Set(ownedControlFlowNodes.map((node) => node.id));
    const functionControlFlowEdges = graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id) && edge.sourceNodeId === createLocalServerNode?.id && ownedControlFlowNodeIds.has(edge.targetNodeId));

    expect(createLocalServerNode).toBeDefined();
    expect(ownedControlFlowNodes.length).toBeGreaterThan(0);
    expect(functionControlFlowEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'control_flow',
          sourceRef: '/Users/david/hypha/zeus/packages/local-server/src/index.ts',
          confidence: 0.9,
        }),
      ]),
    );
  });

  it('connects control-flow nodes in source order inside the same function', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const createLocalServerControlNodes = graph.nodes
      .filter((node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerFunction === 'createLocalServer')
      .sort((a, b) => Number(a.metadata.lineStart) - Number(b.metadata.lineStart));

    expect(createLocalServerControlNodes.length).toBeGreaterThan(1);
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'next_control_flow',
          sourceNodeId: createLocalServerControlNodes[0]?.id,
          targetNodeId: createLocalServerControlNodes[1]?.id,
          confidence: 0.75,
        }),
      ]),
    );
  });

  it('adds loop continue and break edges for loop control-flow nodes in method logic views', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const walkLoopNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#walk' && node.metadata.controlType === 'loop',
    );
    const walkContinueNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#walk' && node.metadata.controlType === 'continue',
    );
    const collectLoopNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#collectSqlStatementSnippet' && node.metadata.controlType === 'loop',
    );
    const collectBreakNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#collectSqlStatementSnippet' && node.metadata.controlType === 'break',
    );

    expect(walkLoopNode).toBeDefined();
    expect(walkContinueNode).toBeDefined();
    expect(collectLoopNode).toBeDefined();
    expect(collectBreakNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'loop_continue',
          sourceNodeId: walkContinueNode?.id,
          targetNodeId: walkLoopNode?.id,
          confidence: 0.64,
        }),
        expect.objectContaining({
          edgeType: 'loop_break',
          sourceNodeId: collectBreakNode?.id,
          targetNodeId: collectLoopNode?.id,
          confidence: 0.6,
        }),
      ]),
    );
  });

  it('adds try-to-catch exception branch edges in method logic views', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const taskStatusTryNode = graph.nodes.find(
      (node) =>
        viewContainsNode(methodLogicView, node.id) &&
        node.nodeType === 'control_flow' &&
        node.metadata.ownerQualifiedName === 'packages/local-server/src/index.ts#handler:PATCH:/api/tasks/:taskId/status' &&
        node.metadata.controlType === 'try',
    );
    const taskStatusCatchNode = graph.nodes.find(
      (node) =>
        viewContainsNode(methodLogicView, node.id) &&
        node.nodeType === 'control_flow' &&
        node.metadata.ownerQualifiedName === 'packages/local-server/src/index.ts#handler:PATCH:/api/tasks/:taskId/status' &&
        node.metadata.controlType === 'catch',
    );

    expect(taskStatusTryNode).toBeDefined();
    expect(taskStatusCatchNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'try_catch',
          sourceNodeId: taskStatusTryNode?.id,
          targetNodeId: taskStatusCatchNode?.id,
          confidence: 0.62,
        }),
      ]),
    );
  });

  it('adds try-to-finally cleanup branch edges in method logic views', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const selectTryNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/storage/src/index.ts#ZeusDatabase.select' && node.metadata.controlType === 'try',
    );
    const selectFinallyNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/storage/src/index.ts#ZeusDatabase.select' && node.metadata.controlType === 'finally',
    );

    expect(selectTryNode).toBeDefined();
    expect(selectFinallyNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'try_finally',
          sourceNodeId: selectTryNode?.id,
          targetNodeId: selectFinallyNode?.id,
          confidence: 0.58,
        }),
      ]),
    );
  });

  it('adds loop back edges for loop control-flow nodes in method logic views', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const scanProjectLoopNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#scanProjectSource' && node.metadata.controlType === 'loop',
    );

    expect(scanProjectLoopNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'loop_back',
          sourceNodeId: scanProjectLoopNode?.id,
          targetNodeId: scanProjectLoopNode?.id,
          confidence: 0.66,
        }),
      ]),
    );
  });

  it('adds true and false branch edges for guard-style if statements in method logic views', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const taskStatusIfNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/task-core/src/index.ts#getNextTaskStatus' && node.metadata.controlType === 'if',
    );
    const taskStatusThrowNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/task-core/src/index.ts#getNextTaskStatus' && node.metadata.controlType === 'throw',
    );
    const taskStatusReturnNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.metadata.ownerQualifiedName === 'packages/task-core/src/index.ts#getNextTaskStatus' && node.metadata.controlType === 'return',
    );

    expect(taskStatusIfNode).toBeDefined();
    expect(taskStatusThrowNode).toBeDefined();
    expect(taskStatusReturnNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'branch_true',
          sourceNodeId: taskStatusIfNode?.id,
          targetNodeId: taskStatusThrowNode?.id,
          confidence: 0.72,
        }),
        expect.objectContaining({
          edgeType: 'branch_false',
          sourceNodeId: taskStatusIfNode?.id,
          targetNodeId: taskStatusReturnNode?.id,
          confidence: 0.68,
        }),
      ]),
    );
  });

  it('adds SQL call nodes and function execution edges to the method logic view', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const getJsonNode = graph.nodes.find((node) => node.qualifiedName === 'packages/storage/src/index.ts#SettingRepository.getJson');
    const getJsonSqlNodes = graph.nodes.filter((node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'sql_call' && node.metadata.ownerFunction === 'SettingRepository.getJson');
    const getJsonSqlNodeIds = new Set(getJsonSqlNodes.map((node) => node.id));
    const sqlEdges = graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id) && edge.sourceNodeId === getJsonNode?.id && getJsonSqlNodeIds.has(edge.targetNodeId));

    expect(getJsonNode).toBeDefined();
    expect(getJsonSqlNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            operation: 'SELECT',
            tableNames: expect.arrayContaining(['settings']),
            selectedFields: expect.arrayContaining(['key', 'value_json', 'updated_at']),
            whereFields: expect.arrayContaining(['key']),
          }),
        }),
      ]),
    );
    expect(sqlEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'executes_sql',
          sourceRef: '/Users/david/hypha/zeus/packages/storage/src/index.ts',
          confidence: 0.9,
        }),
      ]),
    );
  });

  it('adds awaited function calls to method logic views', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const scanProjectSourceNode = graph.nodes.find((node) => node.qualifiedName === 'packages/code-indexer/src/index.ts#scanProjectSource');
    const awaitedListSourceFilesCall = graph.nodes.find(
      (node) =>
        viewContainsNode(methodLogicView, node.id) &&
        node.nodeType === 'function_call' &&
        node.metadata.ownerQualifiedName === 'packages/code-indexer/src/index.ts#scanProjectSource' &&
        node.metadata.calleeExpression === 'listSourceFiles' &&
        node.metadata.isAwaited === true,
    );

    expect(scanProjectSourceNode).toBeDefined();
    expect(awaitedListSourceFilesCall).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'awaits_call',
          sourceNodeId: scanProjectSourceNode?.id,
          targetNodeId: awaitedListSourceFilesCall?.id,
          confidence: 0.78,
        }),
      ]),
    );
  });

  it('adds promise catch branch edges to method logic views', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const mainCallNode = graph.nodes.find(
      (node) =>
        viewContainsNode(methodLogicView, node.id) &&
        node.nodeType === 'function_call' &&
        node.sourceRef === '/Users/david/hypha/zeus/packages/code-indexer/src/cli.ts' &&
        node.metadata.calleeExpression === 'main' &&
        node.metadata.promiseChainHandler === 'catch',
    );
    const promiseCatchNode = graph.nodes.find(
      (node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'control_flow' && node.sourceRef === '/Users/david/hypha/zeus/packages/code-indexer/src/cli.ts' && node.metadata.controlType === 'promise_catch',
    );

    expect(mainCallNode).toBeDefined();
    expect(promiseCatchNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'promise_catch',
          sourceNodeId: mainCallNode?.id,
          targetNodeId: promiseCatchNode?.id,
          confidence: 0.61,
        }),
      ]),
    );
  });

  it('adds promise then continuation edges to method logic views', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const startupCoordinatorPath = '/Users/david/hypha/zeus/apps/desktop/src/main/startupCoordinator.ts';
    const promiseThenCallNode = graph.nodes.find(
      (node) =>
        viewContainsNode(methodLogicView, node.id) && node.nodeType === 'function_call' && node.sourceRef === startupCoordinatorPath && node.metadata.calleeExpression === 'Promise.resolve' && node.metadata.promiseChainHandler === 'then',
    );
    const promiseThenNode = graph.nodes.find(
      (node) =>
        viewContainsNode(methodLogicView, node.id) &&
        node.nodeType === 'control_flow' &&
        node.sourceRef === startupCoordinatorPath &&
        node.metadata.controlType === 'promise_then' &&
        node.metadata.lineStart === promiseThenCallNode?.metadata.lineStart,
    );

    expect(promiseThenCallNode).toBeDefined();
    expect(promiseThenNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'promise_then',
          sourceNodeId: promiseThenCallNode?.id,
          targetNodeId: promiseThenNode?.id,
          confidence: 0.6,
        }),
      ]),
    );
  });

  it('adds column nodes and SQL field impact edges to method logic views', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const projectSearchSqlNode = graph.nodes.find((node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'sql_call' && node.metadata.ownerFunction === 'ProjectRepository.search' && node.metadata.operation === 'SELECT');
    const slugColumnNode = graph.nodes.find((node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'column' && node.qualifiedName === 'packages/storage/src/index.ts#table:projects#column:slug');

    expect(projectSearchSqlNode).toBeDefined();
    expect(slugColumnNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'uses_column',
          sourceNodeId: projectSearchSqlNode?.id,
          targetNodeId: slugColumnNode?.id,
          confidence: 0.72,
        }),
      ]),
    );
  });

  it('connects repository SQL calls to the tables they read in the method logic view', async () => {
    const graph = await getRealProjectGraph();
    const methodLogicView = graph.views.find((view) => view.viewType === 'method_logic');
    const projectSearchSqlNode = graph.nodes.find((node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'sql_call' && node.metadata.ownerFunction === 'ProjectRepository.search' && node.metadata.operation === 'SELECT');
    const projectsTableNode = graph.nodes.find((node) => viewContainsNode(methodLogicView, node.id) && node.nodeType === 'table' && node.qualifiedName === 'packages/storage/src/index.ts#table:projects');

    expect(projectSearchSqlNode).toBeDefined();
    expect(projectsTableNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(methodLogicView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'reads_table',
          sourceNodeId: projectSearchSqlNode?.id,
          targetNodeId: projectsTableNode?.id,
          confidence: 0.85,
        }),
      ]),
    );
  });

  it('connects API handlers to their real internal function calls', async () => {
    const graph = await getRealProjectGraph();
    const apiSequenceView = graph.views.find((view) => view.viewType === 'api_sequence');
    const projectsHandlerNode = graph.nodes.find((node) => node.qualifiedName === 'packages/local-server/src/index.ts#handler:GET:/api/projects');
    const projectsSearchCallNode = graph.nodes.find((node) => viewContainsNode(apiSequenceView, node.id) && node.nodeType === 'function_call' && node.metadata.calleeExpression === 'projects.search');

    expect(projectsHandlerNode).toBeDefined();
    expect(projectsSearchCallNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(apiSequenceView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'calls',
          sourceNodeId: projectsHandlerNode?.id,
          targetNodeId: projectsSearchCallNode?.id,
          confidence: 0.8,
        }),
      ]),
    );
  });

  it('connects function call nodes to resolved class method targets', async () => {
    const graph = await getRealProjectGraph();
    const apiSequenceView = graph.views.find((view) => view.viewType === 'api_sequence');
    const projectsSearchCallNode = graph.nodes.find((node) => viewContainsNode(apiSequenceView, node.id) && node.nodeType === 'function_call' && node.metadata.calleeExpression === 'projects.search');
    const projectRepositorySearchNode = graph.nodes.find((node) => node.qualifiedName === 'packages/storage/src/index.ts#ProjectRepository.search');

    expect(projectsSearchCallNode).toBeDefined();
    expect(projectRepositorySearchNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(apiSequenceView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'resolves_to',
          sourceNodeId: projectsSearchCallNode?.id,
          targetNodeId: projectRepositorySearchNode?.id,
          confidence: 0.7,
        }),
      ]),
    );
  });

  it('extends API sequence views from resolved repository methods to SQL table impacts', async () => {
    const graph = await getRealProjectGraph();
    const apiSequenceView = graph.views.find((view) => view.viewType === 'api_sequence');
    const projectRepositorySearchNode = graph.nodes.find((node) => viewContainsNode(apiSequenceView, node.id) && node.qualifiedName === 'packages/storage/src/index.ts#ProjectRepository.search');
    const projectSearchSqlNode = graph.nodes.find(
      (node) => viewContainsNode(apiSequenceView, node.id) && node.nodeType === 'sql_call' && node.metadata.ownerQualifiedName === 'packages/storage/src/index.ts#ProjectRepository.search' && node.metadata.operation === 'SELECT',
    );
    const projectsTableNode = graph.nodes.find((node) => viewContainsNode(apiSequenceView, node.id) && node.qualifiedName === 'packages/storage/src/index.ts#table:projects');

    expect(projectRepositorySearchNode).toBeDefined();
    expect(projectSearchSqlNode).toBeDefined();
    expect(projectsTableNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(apiSequenceView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'executes_sql',
          sourceNodeId: projectRepositorySearchNode?.id,
          targetNodeId: projectSearchSqlNode?.id,
        }),
        expect.objectContaining({
          edgeType: 'reads_table',
          sourceNodeId: projectSearchSqlNode?.id,
          targetNodeId: projectsTableNode?.id,
        }),
      ]),
    );
  });

  it('connects files through real import dependency edges in the module view', async () => {
    const graph = await getRealProjectGraph();
    const moduleView = graph.views.find((view) => view.viewType === 'module');
    const appNode = graph.nodes.find((node) => node.qualifiedName === 'apps/desktop/src/renderer/App.tsx');
    const apiClientNode = graph.nodes.find((node) => node.qualifiedName === 'apps/desktop/src/renderer/apiClient.ts');

    expect(appNode).toBeDefined();
    expect(apiClientNode).toBeDefined();
    expect(moduleView?.nodeIds).toContain(appNode?.id);
    expect(moduleView?.nodeIds).toContain(apiClientNode?.id);
    expect(graph.edges.filter((edge) => viewContainsEdge(moduleView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'module_depends_on',
          sourceNodeId: appNode?.id,
          targetNodeId: apiClientNode?.id,
          confidence: 0.9,
        }),
      ]),
    );
  });

  it('connects modules through re-export dependencies resolved from tsconfig paths', async () => {
    const graph = await getRealProjectGraph();
    const moduleView = graph.views.find((view) => view.viewType === 'module');
    const taskCoreNode = graph.nodes.find((node) => node.qualifiedName === 'packages/task-core/src/index.ts');
    const sharedNode = graph.nodes.find((node) => node.qualifiedName === 'packages/shared/src/index.ts');

    expect(taskCoreNode).toBeDefined();
    expect(sharedNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(moduleView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'module_depends_on',
          sourceNodeId: taskCoreNode?.id,
          targetNodeId: sharedNode?.id,
          confidence: 0.9,
        }),
      ]),
    );
  });

  it('connects same-file direct function calls to their resolved targets in API sequence views', async () => {
    const graph = await getRealProjectGraph();
    const apiSequenceView = graph.views.find((view) => view.viewType === 'api_sequence');
    const searchGraphCallNode = graph.nodes.find(
      (node) =>
        viewContainsNode(apiSequenceView, node.id) &&
        node.nodeType === 'function_call' &&
        node.metadata.calleeExpression === 'searchCurrentGraphNodes' &&
        node.metadata.ownerQualifiedName === 'packages/local-server/src/index.ts#handler:GET:/api/graph/search',
    );
    const searchGraphFunctionNode = graph.nodes.find((node) => viewContainsNode(apiSequenceView, node.id) && node.qualifiedName === 'packages/local-server/src/index.ts#searchCurrentGraphNodes');

    expect(searchGraphCallNode).toBeDefined();
    expect(searchGraphFunctionNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(apiSequenceView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'resolves_to',
          sourceNodeId: searchGraphCallNode?.id,
          targetNodeId: searchGraphFunctionNode?.id,
          confidence: 0.7,
        }),
      ]),
    );
  });

  it('connects API handlers to imported bare function targets in sequence views', async () => {
    const graph = await getRealProjectGraph();
    const apiSequenceView = graph.views.find((view) => view.viewType === 'api_sequence');
    const statusCallNode = graph.nodes.find(
      (node) =>
        viewContainsNode(apiSequenceView, node.id) &&
        node.nodeType === 'function_call' &&
        node.metadata.calleeExpression === 'getNextTaskStatus' &&
        node.metadata.ownerQualifiedName === 'packages/local-server/src/index.ts#handler:PATCH:/api/tasks/:taskId/status',
    );
    const targetFunctionNode = graph.nodes.find((node) => viewContainsNode(apiSequenceView, node.id) && node.qualifiedName === 'packages/task-core/src/index.ts#getNextTaskStatus');

    expect(statusCallNode).toBeDefined();
    expect(targetFunctionNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(apiSequenceView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'resolves_to',
          sourceNodeId: statusCallNode?.id,
          targetNodeId: targetFunctionNode?.id,
          confidence: 0.7,
        }),
      ]),
    );
  });

  it('expands API sequence views one hop beyond imported function targets', async () => {
    const graph = await getRealProjectGraph();
    const apiSequenceView = graph.views.find((view) => view.viewType === 'api_sequence');
    const getNextTaskStatusNode = graph.nodes.find((node) => viewContainsNode(apiSequenceView, node.id) && node.qualifiedName === 'packages/task-core/src/index.ts#getNextTaskStatus');
    const canTransitionCallNode = graph.nodes.find(
      (node) =>
        viewContainsNode(apiSequenceView, node.id) &&
        node.nodeType === 'function_call' &&
        node.metadata.calleeExpression === 'canTransitionTaskStatus' &&
        node.metadata.ownerQualifiedName === 'packages/task-core/src/index.ts#getNextTaskStatus',
    );
    const canTransitionTargetNode = graph.nodes.find((node) => viewContainsNode(apiSequenceView, node.id) && node.qualifiedName === 'packages/task-core/src/index.ts#canTransitionTaskStatus');

    expect(getNextTaskStatusNode).toBeDefined();
    expect(canTransitionCallNode).toBeDefined();
    expect(canTransitionTargetNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(apiSequenceView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'calls',
          sourceNodeId: getNextTaskStatusNode?.id,
          targetNodeId: canTransitionCallNode?.id,
        }),
        expect.objectContaining({
          edgeType: 'resolves_to',
          sourceNodeId: canTransitionCallNode?.id,
          targetNodeId: canTransitionTargetNode?.id,
        }),
      ]),
    );
  });

  it('expands API sequence views recursively up to the design-book depth limit', () => {
    const sourceRef = '/Users/david/hypha/zeus/packages/example/src/api.ts';
    const scan = {
      projectName: 'RecursiveApiFixture',
      rootPath: '/Users/david/hypha/zeus',
      symbols: [
        graphTestSymbol('file', 'api.ts', 'packages/example/src/api.ts', sourceRef, {}),
        graphTestSymbol('api', 'GET /api/recursive', 'packages/example/src/api.ts#api:GET:/api/recursive', sourceRef, {
          handlerQualifiedName: 'packages/example/src/api.ts#handler',
        }),
        graphTestSymbol('function', 'handler', 'packages/example/src/api.ts#handler', sourceRef, {}),
        graphTestSymbol('function', 'first', 'packages/example/src/api.ts#first', sourceRef, {}),
        graphTestSymbol('function', 'second', 'packages/example/src/api.ts#second', sourceRef, {}),
        graphTestSymbol('function', 'third', 'packages/example/src/api.ts#third', sourceRef, {}),
        graphTestSymbol('function_call', 'first L10', 'packages/example/src/api.ts#call:first:L10:2', sourceRef, {
          calleeExpression: 'first',
          ownerQualifiedName: 'packages/example/src/api.ts#handler',
          targetQualifiedName: 'packages/example/src/api.ts#first',
        }),
        graphTestSymbol('function_call', 'second L20', 'packages/example/src/api.ts#call:second:L20:2', sourceRef, {
          calleeExpression: 'second',
          ownerQualifiedName: 'packages/example/src/api.ts#first',
          targetQualifiedName: 'packages/example/src/api.ts#second',
        }),
        graphTestSymbol('function_call', 'third L30', 'packages/example/src/api.ts#call:third:L30:2', sourceRef, {
          calleeExpression: 'third',
          ownerQualifiedName: 'packages/example/src/api.ts#second',
          targetQualifiedName: 'packages/example/src/api.ts#third',
        }),
      ],
    };

    const graph = buildProjectGraph(scan);
    const apiSequenceView = graph.views.find((view) => view.viewType === 'api_sequence');
    const thirdCallNode = graph.nodes.find((node) => viewContainsNode(apiSequenceView, node.id) && node.nodeType === 'function_call' && node.metadata.calleeExpression === 'third');
    const thirdFunctionNode = graph.nodes.find((node) => viewContainsNode(apiSequenceView, node.id) && node.qualifiedName === 'packages/example/src/api.ts#third');

    expect(thirdCallNode).toBeDefined();
    expect(thirdFunctionNode).toBeDefined();
    expect(graph.edges.filter((edge) => viewContainsEdge(apiSequenceView, edge.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'calls',
          sourceNodeId: graph.nodes.find((node) => node.qualifiedName === 'packages/example/src/api.ts#second')?.id,
          targetNodeId: thirdCallNode?.id,
        }),
        expect.objectContaining({
          edgeType: 'resolves_to',
          sourceNodeId: thirdCallNode?.id,
          targetNodeId: thirdFunctionNode?.id,
        }),
      ]),
    );
  });
});

function graphTestSymbol(symbolType: string, name: string, qualifiedName: string, filePath: string, metadata: Record<string, unknown>) {
  return {
    id: `test:${qualifiedName}`,
    symbolType,
    name,
    qualifiedName,
    filePath,
    lineStart: 1,
    lineEnd: 1,
    language: 'typescript',
    sourceHash: 'test-source-hash',
    metadata,
  };
}
