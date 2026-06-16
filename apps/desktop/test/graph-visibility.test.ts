import { describe, expect, it } from 'vitest';
import {
  buildAggregatedGraphEdges,
  buildAggregatedGraphNodes,
  buildGraphNodeActionMenu,
  buildGraphQuestionRequest,
  buildGraphSearchRequest,
  buildMermaidDiagramExport,
  buildMermaidDiagramSource,
  buildVisibleGraphSlice,
} from '../src/renderer/App.js';
import type { GraphViewSnapshot } from '../src/renderer/apiClient.js';

describe('Code Map node visibility filtering', () => {
  it('hides selected nodes and removes edges connected to them without changing graph facts', () => {
    const nodes: GraphViewSnapshot['nodes'] = [
      {
        id: 'node_a',
        nodeType: 'file',
        name: 'A.ts',
        qualifiedName: 'src/A.ts',
        sourceRef: 'src/A.ts',
        symbolId: 'symbol_a',
        metadata: { lineStart: 1 },
      },
      {
        id: 'node_b',
        nodeType: 'function',
        name: 'buildB',
        qualifiedName: 'src/B.ts#buildB',
        sourceRef: 'src/B.ts',
        symbolId: 'symbol_b',
        metadata: { lineStart: 5 },
      },
      {
        id: 'node_c',
        nodeType: 'function',
        name: 'buildC',
        qualifiedName: 'src/C.ts#buildC',
        sourceRef: 'src/C.ts',
        symbolId: 'symbol_c',
        metadata: { lineStart: 8 },
      },
    ];
    const edges: GraphViewSnapshot['edges'] = [
      {
        id: 'edge_ab',
        edgeType: 'declares',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'src/A.ts',
        confidence: 1,
      },
      {
        id: 'edge_bc',
        edgeType: 'calls',
        sourceNodeId: 'node_b',
        targetNodeId: 'node_c',
        sourceRef: 'src/B.ts',
        confidence: 0.9,
      },
    ];

    const visible = buildVisibleGraphSlice({
      nodes,
      edges,
      hiddenNodeIds: ['node_b'],
      maxNodes: 8,
      maxEdges: 5,
    });

    expect(visible.nodes.map((node) => node.id)).toEqual(['node_a', 'node_c']);
    expect(visible.edges).toEqual([]);
    expect(nodes.map((node) => node.id)).toEqual(['node_a', 'node_b', 'node_c']);
  });

  it('builds a source-backed node action menu without fake graph actions', () => {
    const node: GraphViewSnapshot['nodes'][number] = {
      id: 'node_real',
      nodeType: 'file',
      name: 'App.tsx',
      qualifiedName: 'apps/desktop/src/renderer/App.tsx',
      sourceRef: 'apps/desktop/src/renderer/App.tsx',
      symbolId: 'symbol_real',
      metadata: { lineStart: 12 },
    };

    expect(buildGraphNodeActionMenu(node)).toEqual([
      {
        id: 'inspect-detail',
        label: '查看详情',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        lineStart: 12,
      },
      {
        id: 'open-source',
        label: '打开源码',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        lineStart: 12,
      },
      {
        id: 'ask-node',
        label: '提问此节点',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        lineStart: 12,
      },
      {
        id: 'generate-sequence',
        label: '生成时序图',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        lineStart: 12,
      },
      {
        id: 'generate-flow',
        label: '生成流程图',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        lineStart: 12,
      },
      {
        id: 'expand-one-hop',
        label: '展开一跳',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        lineStart: 12,
      },
      {
        id: 'expand-two-hop',
        label: '展开二跳',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        lineStart: 12,
      },
      {
        id: 'create-task',
        label: '从节点创建任务',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        lineStart: 12,
      },
      {
        id: 'toggle-visibility',
        label: '隐藏节点',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        lineStart: 12,
      },
    ]);
  });

  it('aggregates duplicate visible edges without losing real source references', () => {
    const edges: GraphViewSnapshot['edges'] = [
      {
        id: 'edge_a',
        edgeType: 'module_depends_on',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'packages/a/src/index.ts',
        confidence: 0.8,
      },
      {
        id: 'edge_b',
        edgeType: 'module_depends_on',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'packages/a/src/reexport.ts',
        confidence: 1,
      },
      {
        id: 'edge_c',
        edgeType: 'declares',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'packages/a/src/index.ts',
        confidence: 1,
      },
    ];

    expect(buildAggregatedGraphEdges(edges)).toEqual([
      {
        id: 'edge_a',
        edgeType: 'module_depends_on',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'packages/a/src/index.ts',
        confidence: 0.9,
        aggregateCount: 2,
        sourceRefs: ['packages/a/src/index.ts', 'packages/a/src/reexport.ts'],
        edgeIds: ['edge_a', 'edge_b'],
      },
      {
        id: 'edge_c',
        edgeType: 'declares',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'packages/a/src/index.ts',
        confidence: 1,
        aggregateCount: 1,
        sourceRefs: ['packages/a/src/index.ts'],
        edgeIds: ['edge_c'],
      },
    ]);
  });

  it('aggregates overflow visible nodes without losing source references', () => {
    const nodes: GraphViewSnapshot['nodes'] = [
      {
        id: 'node_a',
        nodeType: 'file',
        name: 'A.ts',
        qualifiedName: 'src/A.ts',
        sourceRef: 'src/A.ts',
        symbolId: 'symbol_a',
        metadata: { lineStart: 1 },
      },
      {
        id: 'node_b',
        nodeType: 'function',
        name: 'buildB',
        qualifiedName: 'src/B.ts#buildB',
        sourceRef: 'src/B.ts',
        symbolId: 'symbol_b',
        metadata: { lineStart: 5 },
      },
      {
        id: 'node_c',
        nodeType: 'function',
        name: 'buildC',
        qualifiedName: 'src/C.ts#buildC',
        sourceRef: 'src/C.ts',
        symbolId: 'symbol_c',
        metadata: { lineStart: 8 },
      },
      {
        id: 'node_d',
        nodeType: 'table',
        name: 'tasks',
        qualifiedName: 'storage.tasks',
        sourceRef: 'packages/storage/src/index.ts',
        symbolId: 'symbol_d',
        metadata: { lineStart: 42 },
      },
    ];

    const aggregated = buildAggregatedGraphNodes(nodes, 3);

    expect(aggregated.map((node) => node.id)).toEqual(['node_a', 'node_b', 'aggregate_nodes_node_c_node_d']);
    expect(aggregated[2]).toMatchObject({
      id: 'aggregate_nodes_node_c_node_d',
      nodeType: 'aggregate',
      name: '聚合 2 个节点',
      qualifiedName: '聚合节点：node_c,node_d',
      sourceRef: 'src/C.ts',
      aggregateCount: 2,
      nodeIds: ['node_c', 'node_d'],
      sourceRefs: ['src/C.ts', 'packages/storage/src/index.ts'],
      nodeTypes: ['function', 'table'],
    });
  });

  it('hides low-confidence edges by default and keeps them when explicitly enabled', () => {
    const nodes: GraphViewSnapshot['nodes'] = [
      {
        id: 'node_a',
        nodeType: 'file',
        name: 'A.ts',
        qualifiedName: 'src/A.ts',
        sourceRef: 'src/A.ts',
        symbolId: 'symbol_a',
        metadata: { lineStart: 1 },
      },
      {
        id: 'node_b',
        nodeType: 'function',
        name: 'buildB',
        qualifiedName: 'src/B.ts#buildB',
        sourceRef: 'src/B.ts',
        symbolId: 'symbol_b',
        metadata: { lineStart: 5 },
      },
    ];
    const edges: GraphViewSnapshot['edges'] = [
      {
        id: 'edge_high',
        edgeType: 'declares',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'src/A.ts',
        confidence: 1,
      },
      {
        id: 'edge_low',
        edgeType: 'calls',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'src/A.ts',
        confidence: 0.72,
      },
    ];

    expect(
      buildVisibleGraphSlice({
        nodes,
        edges,
        hiddenNodeIds: [],
        maxNodes: 8,
        maxEdges: 5,
        showLowConfidenceEdges: false,
      }).edges.map((edge) => edge.id),
    ).toEqual(['edge_high']);
    expect(
      buildVisibleGraphSlice({
        nodes,
        edges,
        hiddenNodeIds: [],
        maxNodes: 8,
        maxEdges: 5,
        showLowConfidenceEdges: true,
      }).edges.map((edge) => edge.id),
    ).toEqual(['edge_high', 'edge_low']);
  });

  it('applies an explicit minimum confidence threshold when low-confidence edges are visible', () => {
    const nodes: GraphViewSnapshot['nodes'] = [
      {
        id: 'node_a',
        nodeType: 'file',
        name: 'A.ts',
        qualifiedName: 'src/A.ts',
        sourceRef: 'src/A.ts',
        symbolId: 'symbol_a',
        metadata: { lineStart: 1 },
      },
      {
        id: 'node_b',
        nodeType: 'function',
        name: 'buildB',
        qualifiedName: 'src/B.ts#buildB',
        sourceRef: 'src/B.ts',
        symbolId: 'symbol_b',
        metadata: { lineStart: 5 },
      },
    ];
    const edges: GraphViewSnapshot['edges'] = [
      {
        id: 'edge_high',
        edgeType: 'declares',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'src/A.ts',
        confidence: 1,
      },
      {
        id: 'edge_mid',
        edgeType: 'calls',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'src/A.ts',
        confidence: 0.86,
      },
      {
        id: 'edge_low',
        edgeType: 'reads_table',
        sourceNodeId: 'node_a',
        targetNodeId: 'node_b',
        sourceRef: 'src/A.ts',
        confidence: 0.72,
      },
    ];

    expect(
      buildVisibleGraphSlice({
        nodes,
        edges,
        hiddenNodeIds: [],
        maxNodes: 8,
        maxEdges: 5,
        showLowConfidenceEdges: true,
        minConfidence: 0.8,
      }).edges.map((edge) => edge.id),
    ).toEqual(['edge_high', 'edge_mid']);
  });

  it('builds graph search requests from user-controlled filters instead of fixed examples', () => {
    expect(
      buildGraphSearchRequest({
        query: 'runtime session',
        nodeType: 'function',
        edgeType: 'calls',
        minConfidence: 0.82,
      }),
    ).toEqual({
      query: 'runtime session',
      nodeType: 'function',
      edgeType: 'calls',
      minConfidence: 0.82,
    });

    expect(
      buildGraphSearchRequest({
        query: '   ',
        nodeType: '',
        edgeType: '',
        minConfidence: 1.4,
      }),
    ).toEqual({
      query: '',
      nodeType: undefined,
      edgeType: undefined,
      minConfidence: 1,
    });
  });

  it('builds graph question requests from the user question instead of a fixed prompt', () => {
    expect(buildGraphQuestionRequest('  哪些 API 会写 tasks 表？  ')).toEqual({
      question: '哪些 API 会写 tasks 表？',
      canAsk: true,
    });

    expect(buildGraphQuestionRequest('   ')).toEqual({
      question: '',
      canAsk: false,
    });
  });

  it('builds a source-backed Mermaid diagram from visible graph facts', () => {
    const nodes: GraphViewSnapshot['nodes'] = [
      {
        id: 'node_api',
        nodeType: 'api',
        name: 'GET /api/tasks',
        qualifiedName: 'GET /api/tasks',
        sourceRef: 'packages/local-server/src/index.ts',
        symbolId: 'symbol_api',
        metadata: { lineStart: 10 },
      },
      {
        id: 'node_handler',
        nodeType: 'function',
        name: 'listTasks',
        qualifiedName: 'packages/local-server/src/index.ts#listTasks',
        sourceRef: 'packages/local-server/src/index.ts',
        symbolId: 'symbol_handler',
        metadata: { lineStart: 20 },
      },
    ];
    const edges: GraphViewSnapshot['edges'] = [
      {
        id: 'edge_handle',
        edgeType: 'handles_api',
        sourceNodeId: 'node_api',
        targetNodeId: 'node_handler',
        sourceRef: 'packages/local-server/src/index.ts',
        confidence: 0.9,
      },
    ];

    expect(buildMermaidDiagramSource({ viewType: 'api_sequence', nodes, edges })).toBe(
      ['sequenceDiagram', '  participant node_api as GET /api/tasks', '  participant node_handler as listTasks', '  node_api->>node_handler: handles_api 0.90', '  %% source: packages/local-server/src/index.ts'].join('\n'),
    );
  });

  it('builds a deterministic Mermaid export file from sourced diagram text', () => {
    const exportFile = buildMermaidDiagramExport({
      viewTitle: '接口 时序图',
      viewType: 'api_sequence',
      generatedAt: '2026-06-14T03:11:00.000Z',
      source: 'sequenceDiagram\n  A->>B: calls 1.00\n  %% source: src/api.ts',
    });

    expect(exportFile).toEqual({
      fileName: 'api_sequence-接口-时序图-2026-06-14T03-11-00-000Z.mmd',
      mimeType: 'text/vnd.mermaid',
      content: ['%% Zeus Mermaid export', '%% view: 接口 时序图', '%% type: api_sequence', '%% generatedAt: 2026-06-14T03:11:00.000Z', 'sequenceDiagram', '  A->>B: calls 1.00', '  %% source: src/api.ts'].join('\n'),
    });
  });
});
