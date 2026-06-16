import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App, buildSigmaRuntimeGraph } from '../src/renderer/App.js';
import type { DashboardSnapshot, GraphQuestionAnswer, GraphViewSnapshot } from '../src/renderer/apiClient.js';

function createCodeMapSettings(showLowConfidenceEdges: boolean) {
  return {
    defaultScanScope: 'project' as const,
    defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
    maxCallChainDepth: 3,
    showLowConfidenceEdges,
    layoutAlgorithm: 'hierarchical' as const,
    graphCacheStrategy: 'sqlite' as const,
    tableRelationInference: 'foreign_key_and_name' as const,
    aiSummaryEnabled: false,
    incrementalScanEnabled: true,
    performanceMonitoringEnabled: false,
    moduleFlowManualNotes: '',
  };
}

function createSnapshot(graph: DashboardSnapshot['graph']): DashboardSnapshot {
  return {
    app: 'Zeus',
    localServer: { host: '127.0.0.1', port: 49152 },
    projects: [
      {
        id: 'project_real',
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        scanStatus: 'completed',
      },
    ],
    tasks: [],
    runtime: {
      aiCli: { available: false, reason: '未检测到可用 AI CLI。' },
      telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
    },
    git: { isRepository: true, branch: 'main', changedFiles: [] },
    graph,
  };
}

describe('Zeus App code map rendering', () => {
  it('keeps code map configuration out of the first-level settings surface', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot({ nodeCount: 0, edgeCount: 0, viewCount: 0 })}
        initialMainNavTarget="settings"
        initialCodeMapSettings={{
          defaultScanScope: 'project',
          defaultIgnoreDirectories: ['node_modules', 'dist', 'generated-real'],
          maxCallChainDepth: 5,
          showLowConfidenceEdges: true,
          layoutAlgorithm: 'hierarchical',
          graphCacheStrategy: 'sqlite',
          tableRelationInference: 'foreign_key_and_name',
          aiSummaryEnabled: false,
          incrementalScanEnabled: true,
          performanceMonitoringEnabled: true,
          moduleFlowManualNotes: '订单创建流程：API 聚合后由人工确认库存与支付节点。',
        }}
      />,
    );

    expect(html).toContain('workspace-view-settings');
    expect(html).toContain('settings-category-list');
    expect(html).toContain('当前分类：通用');
    expect(html).not.toContain('代码地图设置');
    expect(html).not.toContain('默认忽略目录');
    expect(html).not.toContain('显示低置信边');
    expect(html).not.toContain('模块流程人工编辑草稿');
  });

  it('renders graph renderer runtime only inside the collected project graph drawer', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_empty_runtime',
      title: '空图谱运行时',
      viewType: 'architecture',
      nodes: [],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 0, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(false)} />);

    expect(html).toContain('workspace-view-projects');
    expect(html).toContain('图谱运行时');
    expect(html).not.toContain('Sigma/WebGL 未安装');
    expect(html).not.toContain('React Flow 未安装');
  });

  it('renders runtime graph panes backed by real graph nodes and edges', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_runtime',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'index.ts',
          qualifiedName: 'packages/local-server/src/index.ts',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1 },
        },
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'GET /api/tasks',
          qualifiedName: 'GET /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 2700 },
        },
      ],
      edges: [
        {
          id: 'edge_api',
          edgeType: 'exposes_api',
          sourceNodeId: 'node_file',
          targetNodeId: 'node_api',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 0.91,
        },
      ],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);

    expect(html).toContain('Sigma WebGL 大图');
    expect(html).toContain('React Flow 局部图');
    expect(html).toContain('2 nodes · 1 edges');
    expect(html).toContain('index.ts');
    expect(html).toContain('GET /api/tasks');
    expect(html).toContain('exposes_api 0.91');
  });

  it('adds deterministic numeric coordinates before handing real graph nodes to Sigma WebGL', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_sigma_layout',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      layout: {
        algorithm: 'hierarchical',
        width: 1440,
        height: 900,
        positions: [
          { nodeId: 'node_file', x: 111, y: 222 },
          { nodeId: 'node_api', x: 333, y: 444 },
        ],
      },
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'index.ts',
          qualifiedName: 'packages/local-server/src/index.ts',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1 },
        },
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'GET /api/tasks',
          qualifiedName: 'GET /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 2700 },
        },
      ],
      edges: [
        {
          id: 'edge_api',
          edgeType: 'exposes_api',
          sourceNodeId: 'node_file',
          targetNodeId: 'node_api',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 0.91,
        },
      ],
    };

    const sigmaGraph = buildSigmaRuntimeGraph({
      nodes: graphView.nodes,
      edges: graphView.edges,
      layout: graphView.layout,
    });

    expect(sigmaGraph.nodes.map((node) => [node.attributes.x, node.attributes.y])).toEqual([
      [111, 222],
      [333, 444],
    ]);
    expect(sigmaGraph.nodes.every((node) => Number.isFinite(node.attributes.x) && Number.isFinite(node.attributes.y))).toBe(true);
    expect(sigmaGraph.nodes.every((node) => node.attributes.type === 'circle')).toBe(true);
    expect(sigmaGraph.nodes.map((node) => node.attributes.nodeType)).toEqual(['file', 'api']);
    expect(sigmaGraph.edges[0]).toMatchObject({
      source: 'node_file',
      target: 'node_api',
    });
  });

  it('compresses oversized server graph layouts before rendering macOS Code Map canvas', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_large_layout',
      title: 'Zeus 超大真实图谱',
      viewType: 'architecture',
      layout: {
        algorithm: 'hierarchical',
        width: 48000,
        height: 62000,
        positions: [
          { nodeId: 'node_file', x: 47000, y: 61000 },
          { nodeId: 'node_api', x: 1800, y: 2800 },
        ],
      },
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'index.ts',
          qualifiedName: 'packages/local-server/src/index.ts',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1 },
        },
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'GET /api/tasks',
          qualifiedName: 'GET /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 2700 },
        },
      ],
      edges: [
        {
          id: 'edge_api',
          edgeType: 'exposes_api',
          sourceNodeId: 'node_file',
          targetNodeId: 'node_api',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 0.91,
        },
      ],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} initialMainNavTarget="code-map" />);
    const sigmaGraph = buildSigmaRuntimeGraph({
      nodes: graphView.nodes,
      edges: graphView.edges,
      layout: graphView.layout,
    });

    expect(html).toContain('服务端布局 hierarchical');
    expect(html).toContain('viewBox="0 0 1440 900"');
    expect(html).not.toContain('viewBox="0 0 48000 62000"');
    expect(sigmaGraph.nodes.every((node) => node.attributes.x >= 0 && node.attributes.x <= 1440)).toBe(true);
    expect(sigmaGraph.nodes.every((node) => node.attributes.y >= 0 && node.attributes.y <= 900)).toBe(true);
  });

  it('keeps Sigma WebGL inputs memoized so ordinary UI rerenders do not leak contexts', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('useMemo');
    expect(source).toMatch(/const\s+sigmaGraph\s*=\s*useMemo\(\s*\(\)\s*=>\s*buildSigmaRuntimeGraph/u);
    expect(source).toMatch(/const\s+reactFlowElements\s*=\s*useMemo\(\s*\(\)\s*=>\s*toReactFlowElements/u);
    expect(source).toContain('renderEdgeLabels: false');
    expect(source).toContain('labelRenderedSizeThreshold: 12');
    expect(source).not.toContain('[props.nodes, props.edges, sigmaGraph.nodes, sigmaGraph.edges]');
  });

  it('keeps WebGL graph runtime unmounted while Code Map is hidden in the macOS workspace', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain("isActive={projectPanel === 'graph'}");
    expect(source).toMatch(/const\s+shouldRenderRuntimeGraph\s*=\s*props\.isActive\s*\|\|\s*typeof window === 'undefined';/u);
    expect(source).toContain('{shouldRenderRuntimeGraph ? <GraphRuntimeCanvas');
  });

  it('keeps Code Map usable without horizontal overflow in portrait and compact macOS windows', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Zeus macOS 窄窗口适配');
    expect(css).toMatch(/@media \(max-width: 1180px\)[\s\S]*\.graph-runtime-canvas\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 1180px\)[\s\S]*\.graph-search-bar\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.react-flow-node-summary,[\s\S]*\.graph-runtime-facts small[\s\S]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.code-map-view,[\s\S]*\.graph-runtime-mount[\s\S]*min-width:\s*0/);
    expect(css).toMatch(/\.graph-mermaid-preview pre[\s\S]*white-space:\s*pre-wrap/);
    expect(css).toMatch(/\.graph-mermaid-preview pre[\s\S]*max-height:\s*240px/);
    expect(css).toMatch(/\.graph-view-switcher,[\s\S]*\.graph-mermaid-preview[\s\S]*min-width:\s*0/);
  });

  it('renders Code Map as a Spatial Graph Studio instead of a web card panel', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_spatial_studio',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'index.ts',
          qualifiedName: 'packages/local-server/src/index.ts',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
      performance: { durationMs: 8, nodeCount: 1, edgeCount: 0 },
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} initialMainNavTarget="code-map" />);

    expect(html).toContain('Spatial Graph Studio');
    expect(html).toContain('Graph Stage');
    expect(html).toContain('Node Focus');
    expect(html).toContain('Source Trail');
    expect(html).toContain('class="spatial-graph-stage"');
    expect(html).not.toContain('class="empty-state data-panel"');
  });

  it('renders graph view performance metrics only when the server returns real measurements', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_real',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'index.ts',
          qualifiedName: 'packages/local-server/src/index.ts',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1, sourceHash: 'real_hash' },
        },
      ],
      edges: [],
      performance: { durationMs: 12, nodeCount: 1, edgeCount: 0 },
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);

    expect(html).toContain('图谱视图读取 12ms');
    expect(html).toContain('真实节点 1');
    expect(html).toContain('真实边 0');
  });

  it('renders real graph nodes, edges, and node source details', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_real',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      layout: {
        algorithm: 'hierarchical',
        width: 1440,
        height: 900,
        positions: [
          { nodeId: 'node_file', x: 111, y: 222 },
          { nodeId: 'node_route', x: 333, y: 444 },
        ],
      },
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'index.ts',
          qualifiedName: 'packages/local-server/src/index.ts',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_file',
          metadata: {
            lineStart: 1,
            lineEnd: 220,
            language: 'typescript',
            sourceHash: 'real_hash',
            recentTasks: [
              {
                taskId: 'task_real',
                title: '分析图谱节点：index.ts',
                status: 'completed',
              },
            ],
            riskTags: ['task_completed'],
            aiSummary: '真实 AI 摘要：local-server 入口负责本机 API 编排。',
          },
        },
        {
          id: 'node_route',
          nodeType: 'function',
          name: 'createLocalServer',
          qualifiedName: 'packages/local-server/src/index.ts#createLocalServer',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_route',
          metadata: {
            lineStart: 72,
            lineEnd: 252,
            language: 'typescript',
            sourceHash: 'real_hash',
          },
        },
      ],
      edges: [
        {
          id: 'edge_real',
          edgeType: 'declares',
          sourceNodeId: 'node_file',
          targetNodeId: 'node_route',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
        },
        {
          id: 'edge_reexport',
          edgeType: 'declares',
          sourceNodeId: 'node_file',
          targetNodeId: 'node_route',
          sourceRef: 'packages/local-server/src/reexport.ts',
          confidence: 0.8,
        },
      ],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);

    expect(html).toContain('Spatial Graph Studio');
    expect(html).toContain('viewBox="0 0 1440 900"');
    expect(html).toContain('translate(111 222)');
    expect(html).toContain('服务端布局 hierarchical');
    expect(html).toContain('index.ts');
    expect(html).toContain('packages/local-server/src/index.ts');
    expect(html).toContain('declares');
    expect(html).toContain('聚合 2 条真实边');
    expect(html).toContain('2 sources');
    expect(html).toContain('边详情');
    expect(html).toContain('一跳邻居');
    expect(html).toContain('从节点创建任务');
    expect(html).toContain('打开源码');
    expect(html).toContain('隐藏节点');
    expect(html).toContain('节点操作菜单');
    expect(html).toContain('打开节点菜单');
    expect(html).toContain('已隐藏 0 个节点');
    expect(html).toContain('恢复全部节点');
    expect(html).toContain('搜索节点/字段');
    expect(html).toContain('筛选类型');
    expect(html).toContain('column');
    expect(html).toContain('边类型');
    expect(html).toContain('最低置信度');
    expect(html).toContain('最近任务');
    expect(html).toContain('分析图谱节点：index.ts');
    expect(html).toContain('task_completed');
    expect(html).toContain('AI 摘要');
    expect(html).toContain('真实 AI 摘要：local-server 入口负责本机 API 编排。');
  });

  it('renders a default aggregate node when the visible graph exceeds the node limit', () => {
    const nodes: GraphViewSnapshot['nodes'] = Array.from({ length: 9 }, (_, index) => ({
      id: `node_${index + 1}`,
      nodeType: index % 2 === 0 ? 'function' : 'file',
      name: `Node${index + 1}`,
      qualifiedName: `src/node-${index + 1}.ts#Node${index + 1}`,
      sourceRef: `src/node-${index + 1}.ts`,
      symbolId: `symbol_${index + 1}`,
      metadata: { lineStart: index + 1, sourceHash: `hash_${index + 1}` },
    }));
    const graphView: GraphViewSnapshot = {
      id: 'view_node_aggregation',
      title: 'Zeus 节点聚合图',
      viewType: 'architecture',
      nodes,
      edges: [],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 9, edgeCount: 0, viewCount: 1 })} initialGraphView={graphView} />);

    expect(html).toContain('聚合 2 个节点');
    expect(html).toContain('聚合 2 个真实节点 · 2 sources');
    expect(html).toContain('Node1');
    expect(html).not.toContain('Node9</strong><span>function</span><small>src/node-9.ts');
  });

  it('renders design-book graph view choices with the current view highlighted', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_module',
      title: 'Zeus 模块图',
      viewType: 'module',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'index.ts',
          qualifiedName: 'packages/local-server/src/index.ts',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1, lineEnd: 220, sourceHash: 'real_hash' },
        },
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 7 })} initialGraphView={graphView} />);

    expect(html).toContain('系统架构图');
    expect(html).toContain('模块图');
    expect(html).toContain('表关系图');
    expect(html).toContain('模块详情图');
    expect(html).toContain('接口时序图');
    expect(html).toContain('模块流程图');
    expect(html).toContain('方法逻辑图');
    expect(html).toContain('aria-pressed="true"');
  });

  it('renders a source-backed SVG graph canvas for visible nodes and edges', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_canvas',
      title: 'Zeus 真实代码图谱',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_app',
          nodeType: 'file',
          name: 'App.tsx',
          qualifiedName: 'apps/desktop/src/renderer/App.tsx',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_app',
          metadata: { lineStart: 1, lineEnd: 180, sourceHash: 'hash_app' },
        },
        {
          id: 'node_scan',
          nodeType: 'function',
          name: 'scanProject',
          qualifiedName: 'packages/scanner/src/index.ts#scanProject',
          sourceRef: 'packages/scanner/src/index.ts',
          symbolId: 'symbol_scan',
          metadata: { lineStart: 30, lineEnd: 96, sourceHash: 'hash_scan' },
        },
        {
          id: 'node_graph',
          nodeType: 'function',
          name: 'buildGraph',
          qualifiedName: 'packages/graph/src/index.ts#buildGraph',
          sourceRef: 'packages/graph/src/index.ts',
          symbolId: 'symbol_graph',
          metadata: { lineStart: 20, lineEnd: 120, sourceHash: 'hash_graph' },
        },
      ],
      edges: [
        {
          id: 'edge_app_scan',
          edgeType: 'calls',
          sourceNodeId: 'node_app',
          targetNodeId: 'node_scan',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          confidence: 0.92,
        },
        {
          id: 'edge_scan_graph',
          edgeType: 'emits',
          sourceNodeId: 'node_scan',
          targetNodeId: 'node_graph',
          sourceRef: 'packages/scanner/src/index.ts',
          confidence: 0.88,
        },
      ],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);

    expect(html).toContain('代码图谱画布');
    expect(html).toContain('Mermaid 预览');
    expect(html).toContain('生成 Mermaid 预览');
    expect(html).toContain('导出 Mermaid 源码');
    expect(html).toContain('基于当前真实可见节点和边生成 Mermaid 文本');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="代码图谱画布"');
    expect(html).toContain('App.tsx');
    expect(html).toContain('scanProject');
    expect(html).toContain('buildGraph');
    expect(html).toContain('calls 0.92');
    expect(html).toContain('emits 0.88');
    expect(html).toContain('apps/desktop/src/renderer/App.tsx');
  });

  it('hides low-confidence graph edges in Code Map by default', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_low_confidence',
      title: 'Zeus 低置信边过滤图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_a',
          nodeType: 'file',
          name: 'A.ts',
          qualifiedName: 'src/A.ts',
          sourceRef: 'src/A.ts',
          symbolId: 'symbol_a',
          metadata: { lineStart: 1, lineEnd: 10, sourceHash: 'hash_a' },
        },
        {
          id: 'node_b',
          nodeType: 'function',
          name: 'buildB',
          qualifiedName: 'src/B.ts#buildB',
          sourceRef: 'src/B.ts',
          symbolId: 'symbol_b',
          metadata: { lineStart: 2, lineEnd: 9, sourceHash: 'hash_b' },
        },
      ],
      edges: [
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
      ],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 2, viewCount: 1 })} initialGraphView={graphView} />);

    expect(html).toContain('declares 1.00');
    expect(html).not.toContain('calls 0.72');

    const settingsHtml = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 2, viewCount: 1 })} initialMainNavTarget="settings" initialGraphView={graphView} />);
    expect(settingsHtml).not.toContain('显示低置信边');
  });

  it('offers opening Code Map when graph counts exist but graph view is not loaded yet', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} />);

    expect(html).toContain('打开图谱');
  });

  it('renders graph question conversation history without fake examples', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_real_history',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'index.ts',
          qualifiedName: 'packages/local-server/src/index.ts',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1, lineEnd: 220, sourceHash: 'real_hash' },
        },
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })}
        initialGraphView={graphView}
        initialGraphConversations={[
          {
            id: 'conversation_real',
            projectId: 'project_real',
            taskId: null,
            sessionId: 'ai-session-real',
            title: '图谱问答：local-server',
            summary: 'AI 图谱回答：local-server 来源已核验',
            status: 'closed',
            createdAt: '2026-06-13T00:00:00.000Z',
            updatedAt: '2026-06-13T00:00:01.000Z',
            archived: false,
            messages: [
              {
                id: 'message_user',
                conversationId: 'conversation_real',
                role: 'user',
                content: 'local-server',
                source: 'graph_question',
                metadata: { projectId: 'project_real' },
                createdAt: '2026-06-13T00:00:00.000Z',
              },
              {
                id: 'message_assistant',
                conversationId: 'conversation_real',
                role: 'assistant',
                content: 'AI 图谱回答：local-server 来源已核验',
                source: 'graph_answer',
                metadata: { sourceNodeIds: ['node_file'] },
                createdAt: '2026-06-13T00:00:01.000Z',
              },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain('问答历史');
    expect(html).toContain('搜索历史');
    expect(html).toContain('1 条真实问答');
    expect(html).toContain('图谱问答详情');
    expect(html).toContain('图谱问答：local-server');
    expect(html).toContain('AI 图谱回答：local-server 来源已核验');
    expect(html).toContain('归档历史');
    expect(html).toContain('从问答创建任务');
    expect(html).toContain('第 1-1 条');
    expect(html).not.toContain('示例');
  });

  it('renders graph question answer controls and sourced AI answer', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_ask',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'index.ts',
          qualifiedName: 'packages/local-server/src/index.ts',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1, lineEnd: 220, sourceHash: 'real_hash' },
        },
      ],
      edges: [],
    };
    const graphAnswer: GraphQuestionAnswer = {
      projectId: 'project_real',
      question: 'local-server',
      answer: 'AI 图谱回答：local-server 来源已核验',
      sessionId: 'ai-session-real',
      sources: { nodes: graphView.nodes, edges: [] },
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialGraphView={graphView} initialGraphAnswer={graphAnswer} />);

    expect(html).toContain('图谱问答');
    expect(html).toContain('向图谱提问');
    expect(html).toContain('AI 图谱回答：local-server 来源已核验');
    expect(html).toContain('Runtime 会话 ai-session-real');
    expect(html).toContain('packages/local-server/src/index.ts');
  });

  it('renders two-hop impact scope from real graph edges', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_real_two_hop',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_a',
          nodeType: 'file',
          name: 'A.ts',
          qualifiedName: 'src/A.ts',
          sourceRef: 'src/A.ts',
          symbolId: 'symbol_a',
          metadata: { lineStart: 1, lineEnd: 20, sourceHash: 'hash_a' },
        },
        {
          id: 'node_b',
          nodeType: 'function',
          name: 'buildB',
          qualifiedName: 'src/B.ts#buildB',
          sourceRef: 'src/B.ts',
          symbolId: 'symbol_b',
          metadata: { lineStart: 5, lineEnd: 15, sourceHash: 'hash_b' },
        },
        {
          id: 'node_c',
          nodeType: 'function',
          name: 'buildC',
          qualifiedName: 'src/C.ts#buildC',
          sourceRef: 'src/C.ts',
          symbolId: 'symbol_c',
          metadata: { lineStart: 8, lineEnd: 18, sourceHash: 'hash_c' },
        },
      ],
      edges: [
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
          confidence: 1,
        },
      ],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);

    expect(html).toContain('二跳影响范围');
    expect(html).toContain('buildC · function');
  });
});
