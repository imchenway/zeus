import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App, GraphRuntimeCanvas, buildGraphCanvasLayout, buildGraphCanvasViewport, buildGraphConversationTaskIntent, buildSigmaRuntimeGraph, isProjectGraphViewForProject } from '../src/renderer/App.js';
import type { AppShellSettings, DashboardSnapshot, GraphQuestionAnswer, GraphViewSnapshot } from '../src/renderer/apiClient.js';

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

function createMultiProjectSnapshot(graph: DashboardSnapshot['graph']): DashboardSnapshot {
  return {
    ...createSnapshot(graph),
    projects: [
      {
        id: 'project_tc_app_core',
        name: 'tc-app-core',
        localPath: '/Users/david/cckg/tcapp/Back-End/tc-app-core',
        scanStatus: 'completed',
      },
      {
        id: 'project_zeus',
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        scanStatus: 'completed',
      },
    ],
  };
}

function createAppShellSettings(appLanguage: AppShellSettings['appLanguage']): AppShellSettings {
  return {
    appLanguage,
    appearance: 'system',
    webviewDebugEnabled: false,
    developerModeEnabled: false,
    multiWindowEnabled: true,
    backgroundModeEnabled: true,
    desktopNotificationsEnabled: true,
    openAtLoginEnabled: false,
    autoUpdateChannel: 'manual',
    defaultProjectId: null,
    pinnedProjectIds: [],
    defaultModel: 'gpt-5-codex',
    defaultTaskTemplateId: null,
    localLogDirectory: 'Zeus/logs',
    localConfigPath: 'Zeus/zeus.config.json',
    dataPortability: {
      importSupported: true,
      exportSupported: true,
      redactsSecrets: true,
    },
    cache: { codeIndex: true, graphView: true, layout: true },
    lastCacheClearAt: null,
  };
}

describe('Zeus App code map rendering', () => {
  it('guards the rendered project code page with the graph project id so stale Zeus graphs cannot be shown after switching projects', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('isProjectGraphViewForProject(graphView, selectedProject, { requireProjectIdentity: orderedProjects.length > 1 })');
    expect(source).not.toContain('const activeGraphView = graphProjectId === activeProjectId ? graphView : undefined;');
    expect(source).toContain('if (!activeGraphView) return null;');
    expect(source).toContain('graphView={activeGraphView}');
    expect(source).toContain("selectedProject?.scanStatus === 'completed' && !activeGraphView");
  });

  it('does not attach an initial Zeus graph view to the first project when multiple projects exist', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_zeus_global',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_zeus',
          nodeType: 'file',
          name: 'App.tsx',
          qualifiedName: 'apps/desktop/src/renderer/App.tsx',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_zeus',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(<App snapshot={createMultiProjectSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);

    expect(html).toContain('tc-app-core');
    expect(html).not.toContain('Zeus 系统架构图');
  });

  it('does not attach a restored Zeus graph view to a single non-Zeus project after switching project context', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_zeus_restored_after_project_switch',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_zeus_restored',
          nodeType: 'file',
          name: 'ZeusOnly.ts',
          qualifiedName: 'apps/desktop/src/renderer/ZeusOnly.ts',
          sourceRef: 'apps/desktop/src/renderer/ZeusOnly.ts',
          symbolId: 'symbol_zeus_restored',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };
    const snapshot = {
      ...createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 }),
      projects: [
        {
          id: 'project_tc_app_core',
          name: 'tc-app-core',
          localPath: '/Users/david/cckg/tcapp/Back-End/tc-app-core',
          scanStatus: 'completed' as const,
        },
      ],
    };

    const html = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="code-map" initialGraphView={graphView} />);

    expect(html).toContain('tc-app-core');
    expect(html).not.toContain('Zeus 系统架构图');
    expect(html).not.toContain('ZeusOnly.ts');
  });

  it('rejects a graph view whose metadata belongs to Zeus even when a stale project id points at the selected project', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_zeus_with_stale_project_id',
      projectId: 'project_tc_app_core',
      projectName: 'Zeus',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_zeus_only',
          nodeType: 'file',
          name: 'ZeusOnly.ts',
          qualifiedName: 'apps/desktop/src/renderer/ZeusOnly.ts',
          sourceRef: 'apps/desktop/src/renderer/ZeusOnly.ts',
          symbolId: 'symbol_zeus_only',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(<App snapshot={createMultiProjectSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphProjectId="project_tc_app_core" initialGraphView={graphView} />);

    expect(html).toContain('tc-app-core');
    expect(html).not.toContain('Zeus 系统架构图');
    expect(html).not.toContain('ZeusOnly.ts');
  });

  it('rejects a stale Zeus-titled graph even when stale metadata is stamped with the selected project id', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_zeus_title_with_tc_metadata',
      projectId: 'project_tc_app_core',
      projectName: 'tc-app-core',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_zeus_title_only',
          nodeType: 'file',
          name: 'ZeusOnly.ts',
          qualifiedName: 'apps/desktop/src/renderer/ZeusOnly.ts',
          sourceRef: 'apps/desktop/src/renderer/ZeusOnly.ts',
          symbolId: 'symbol_zeus_title_only',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(<App snapshot={createMultiProjectSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphProjectId="project_tc_app_core" initialGraphView={graphView} />);

    expect(isProjectGraphViewForProject(graphView, { id: 'project_tc_app_core', name: 'tc-app-core' })).toBe(false);
    expect(html).toContain('tc-app-core');
    expect(html).not.toContain('Zeus 系统架构图');
    expect(html).not.toContain('ZeusOnly.ts');
  });

  it('rejects any graph title that belongs to another project even when stale metadata is stamped with the selected project id', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_other_project_title_with_tc_metadata',
      projectId: 'project_tc_app_core',
      projectName: 'tc-app-core',
      title: 'tc-app-core2 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_other_project_title_only',
          nodeType: 'file',
          name: 'OtherProjectOnly.ts',
          qualifiedName: 'apps/desktop/src/renderer/OtherProjectOnly.ts',
          sourceRef: 'apps/desktop/src/renderer/OtherProjectOnly.ts',
          symbolId: 'symbol_other_project_title_only',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(<App snapshot={createMultiProjectSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphProjectId="project_tc_app_core" initialGraphView={graphView} />);

    expect(isProjectGraphViewForProject(graphView, { id: 'project_tc_app_core', name: 'tc-app-core' })).toBe(false);
    expect(html).toContain('tc-app-core');
    expect(html).not.toContain('tc-app-core2 系统架构图');
    expect(html).not.toContain('OtherProjectOnly.ts');
  });

  it('does not render a metadata-less stale Zeus graph when a multi-project workspace points the graph id at another project', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_legacy_global_without_project_identity',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_legacy_zeus',
          nodeType: 'file',
          name: 'ZeusOnly.ts',
          qualifiedName: 'apps/desktop/src/renderer/ZeusOnly.ts',
          sourceRef: 'apps/desktop/src/renderer/ZeusOnly.ts',
          symbolId: 'symbol_legacy_zeus',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(<App snapshot={createMultiProjectSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphProjectId="project_tc_app_core" initialGraphView={graphView} />);

    expect(html).toContain('tc-app-core');
    expect(html).not.toContain('Zeus 系统架构图');
    expect(html).not.toContain('ZeusOnly.ts');
  });

  it('ignores late graph view responses when the user has already switched to another project', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const activeProjectIdRef = useRef<string | undefined>');
    expect(source).toContain('activeProjectIdRef.current = activeProjectId;');
    expect(source).toContain('if (activeProjectIdRef.current !== projectId) {');
    expect(source).toContain('return loadedGraphView;');
  });

  it('rejects project graph views whose response metadata belongs to another project', () => {
    const zeusGraphView: GraphViewSnapshot = {
      id: 'view_zeus',
      projectId: 'project_zeus',
      projectName: 'Zeus',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [],
      edges: [],
    };

    expect(isProjectGraphViewForProject(zeusGraphView, { id: 'project_tc_app_core', name: 'tc-app-core' })).toBe(false);
    expect(isProjectGraphViewForProject({ ...zeusGraphView, projectId: 'project_tc_app_core', projectName: 'tc-app-core', title: 'tc-app-core 系统架构图' }, { id: 'project_tc_app_core', name: 'tc-app-core' })).toBe(true);
    expect(isProjectGraphViewForProject({ ...zeusGraphView, projectId: undefined, projectName: undefined }, { id: 'project_tc_app_core', name: 'tc-app-core' }, { requireProjectIdentity: true })).toBe(false);
  });

  it('resets project graph workspace state when the active project changes so stale Zeus graphs cannot bleed into another project', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const [graphProjectId, setGraphProjectId] = useState<string | undefined>');
    expect(source).toContain('if (graphProjectId === activeProjectId) return;');
    expect(source).toContain('setGraphView(undefined);');
    expect(source).toContain('setGraphSearchResult(undefined);');
    expect(source).toContain('setGraphAnswer(undefined);');
    expect(source).toContain('setGraphConversations([]);');
    expect(source).toContain('setSelectedGraphConversation(undefined);');
  });

  it('routes every loaded project graph view through one guarded state writer before rendering it', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('function acceptLoadedProjectGraphView(');
    expect(source.match(/acceptLoadedProjectGraphView\(projectId, loadedGraphView, expectedProject\)/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(source.match(/setGraphView\(loadedGraphView\);/gu)?.length).toBe(1);
  });

  it('keeps project graph actions recoverable when persisted scan status is stale from a crashed scan', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const scanBusy = scanActionBusy;');
    expect(source).not.toContain("selectedProject?.scanStatus === 'scanning'");
  });

  it('does not show global Zeus graph summary on another project code page before that project graph is loaded', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createMultiProjectSnapshot({
          nodeCount: 243,
          edgeCount: 97,
          viewCount: 7,
        })}
        initialMainNavTarget="code-map"
      />,
    );

    expect(html).toContain('tc-app-core');
    expect(html).not.toContain('243 个节点');
    expect(html).not.toContain('243 nodes');
    expect(html).not.toContain('7 个视图');
    expect(html).toContain('等待真实扫描');
  });

  it('opens project graph search with all node and edge types instead of pre-filtering to file declares', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).not.toContain("const [graphNodeTypeFilter, setGraphNodeTypeFilter] = useState('file');");
    expect(source).not.toContain("const [graphEdgeTypeFilter, setGraphEdgeTypeFilter] = useState('declares');");
    expect(source).toContain("const [graphNodeTypeFilter, setGraphNodeTypeFilter] = useState('');");
    expect(source).toContain("const [graphEdgeTypeFilter, setGraphEdgeTypeFilter] = useState('');");
  });

  it('keeps project code graph tools free of Zeus-specific local-server default values', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).not.toContain("const [graphConversationSearch, setGraphConversationSearch] = useState('local-server');");
    expect(source).not.toContain("const [graphSearchQuery, setGraphSearchQuery] = useState('local-server');");
    expect(source).not.toContain("const [graphQuestionInput, setGraphQuestionInput] = useState('local-server');");
    expect(source).toContain("const [graphConversationSearch, setGraphConversationSearch] = useState('');");
    expect(source).toContain("const [graphSearchQuery, setGraphSearchQuery] = useState('');");
    expect(source).toContain("const [graphQuestionInput, setGraphQuestionInput] = useState('');");
  });

  it('falls back to a real project scan when opening a completed project graph finds no project cache', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain("const loadedGraphView = await openProjectGraphView(activeProjectId, 'architecture');");
    expect(source).toContain('if (!loadedGraphView) await scanActiveProjectGraph();');
    expect(source).not.toContain("await openProjectGraphView(activeProjectId, 'architecture');\n      return;");
  });

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
    expect(html).toContain('settings-section-nav');
    expect(html).not.toContain('settings-category-list');
    expect(html).not.toContain('当前分类：通用');
    expect(html).not.toContain('settings-current-category');
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

    expect(html).toContain('workspace-view-project-code');
    expect(html).toContain('图谱运行时');
    expect(html).not.toContain('Sigma/WebGL 未安装');
    expect(html).not.toContain('React Flow 未安装');
  });

  it('localizes every supported graph filter dropdown value instead of exposing raw graph enum options', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_filter_i18n',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 8, edgeCount: 20, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    for (const label of ['控制流', '聚合', '模块依赖', '最终清理', 'Promise 异常', '使用字段']) {
      expect(html).toContain(label);
    }
    for (const rawEnum of ['>module_depends_on<', '>try_finally<', '>promise_catch<', '>uses_column<']) {
      expect(html).not.toContain(rawEnum);
    }
    for (const supportedFilterValue of ['control_flow', 'aggregate', 'module_depends_on', 'next_control_flow', 'promise_catch', 'promise_then', 'try_catch', 'try_finally', 'uses_column']) {
      expect(source).toContain(`'${supportedFilterValue}'`);
    }
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
          metadata: {
            lineStart: 1,
            lineEnd: 120,
          },
        },
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'GET /api/tasks',
          qualifiedName: 'GET /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: {
            lineStart: 2700,
            lineEnd: 2790,
          },
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

    const html = renderToStaticMarkup(<GraphRuntimeCanvas nodes={graphView.nodes} edges={graphView.edges} layout={graphView.layout} appLanguage="zh-CN" />);

    expect(html).toContain('Sigma WebGL 大图');
    expect(html).toContain('React Flow 局部图');
    expect(html).toContain('2 个节点 · 1 条边');
    expect(html).not.toContain('2 nodes · 1 edges');
    expect(html).toContain('index.ts');
    expect(html).toContain('GET /api/tasks');
    expect(html).toContain('暴露接口 0.91');
    expect(html).not.toContain('exposes_api 0.91');
  });

  it('mirrors the current graph object into the React Flow runtime preview instead of leaving mature graph runtime passive', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_runtime_current',
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
          metadata: {
            lineStart: 1,
            lineEnd: 120,
          },
        },
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'GET /api/tasks',
          qualifiedName: 'GET /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: {
            lineStart: 2700,
            lineEnd: 2790,
          },
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

    const html = renderToStaticMarkup(<GraphRuntimeCanvas nodes={graphView.nodes} edges={graphView.edges} layout={graphView.layout} appLanguage="zh-CN" currentNodeId="node_file" currentEdgeId={null} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('react-flow-node-summary current-graph-runtime-object');
    expect(html).toContain('data-react-flow-node-id="node_file"');
    expect(html).toContain('data-react-flow-edge-id="edge_api"');
    expect(html).not.toContain('react-flow-edge-summary current-graph-runtime-object');
    expect(source).toContain("currentNodeId={selectedGraphSubject === 'node' ? selectedGraphNode?.id : null}");
    expect(source).toContain("currentEdgeId={selectedGraphSubject === 'edge' ? selectedGraphEdge?.id : null}");
    expect(source).toContain('onSelectNode={selectGraphNode}');
    expect(source).toContain('onSelectEdge={selectGraphEdge}');
    expect(source).toContain("className={`react-flow-node-summary${props.currentNodeId === String(node.id) ? ' current-graph-runtime-object' : ''}`}");
    expect(source).toContain("className={`react-flow-edge-summary${props.currentEdgeId === String(edge.id) ? ' current-graph-runtime-object' : ''}`}");
    expect(css).toContain('React Flow 运行时当前对象语义最终覆盖');
    expect(css).toMatch(/\.macos-ai-app :where\(\.react-flow-node-summary,\s*\.react-flow-edge-summary\)\.current-graph-runtime-object\s*\{[\s\S]*background:\s*var\(--zeus-source-list-selected\)/);
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

    expect(html).toContain('服务端布局：层级布局');
    expect(html).not.toContain('服务端布局 hierarchical');
    expect(html).toContain('2 个节点 · 1 条聚合边');
    expect(html).not.toContain('2 nodes · 1 聚合边');
    expect(html).toMatch(/viewBox="\d+ \d+ \d+ \d+"/);
    expect(html).not.toContain('viewBox="0 0 48000 62000"');
    expect(sigmaGraph.nodes.every((node) => node.attributes.x >= 0 && node.attributes.x <= 1440)).toBe(true);
    expect(sigmaGraph.nodes.every((node) => node.attributes.y >= 0 && node.attributes.y <= 900)).toBe(true);
  });

  it('compacts tiny server graph layouts so the code page does not waste most of the canvas on blank space', () => {
    const nodes: GraphViewSnapshot['nodes'] = [
      {
        id: 'node_app',
        nodeType: 'file',
        name: 'App.tsx',
        qualifiedName: 'apps/desktop/src/renderer/App.tsx',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        symbolId: 'symbol_app',
        metadata: {},
      },
      {
        id: 'node_server',
        nodeType: 'file',
        name: 'local-server',
        qualifiedName: 'packages/local-server/src/index.ts',
        sourceRef: 'packages/local-server/src/index.ts',
        symbolId: 'symbol_server',
        metadata: {},
      },
      {
        id: 'node_graph',
        nodeType: 'package',
        name: 'graph-engine',
        qualifiedName: 'packages/graph-engine/src/index.ts',
        sourceRef: 'packages/graph-engine/src/index.ts',
        symbolId: 'symbol_graph',
        metadata: {},
      },
    ];
    const layout = buildGraphCanvasLayout(nodes, 1180, 620, {
      algorithm: 'layered',
      width: 1180,
      height: 620,
      positions: [
        { nodeId: 'node_app', x: 590, y: 210 },
        { nodeId: 'node_server', x: 1040, y: 560 },
        { nodeId: 'node_graph', x: 160, y: 560 },
      ],
    });
    const points = nodes.map((node) => layout.get(node.id)).filter((point): point is { x: number; y: number } => Boolean(point));
    const xRange = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
    const yRange = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));

    expect(xRange).toBeLessThanOrEqual(760);
    expect(yRange).toBeLessThanOrEqual(240);
    expect(Math.min(...points.map((point) => point.y))).toBeGreaterThanOrEqual(170);
    expect(Math.max(...points.map((point) => point.y))).toBeLessThanOrEqual(450);
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

  it('keeps WebGL graph runtime mounted only when the code page graph stage is active', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain("isActive={activeProjectSection === 'code'}");
    expect(source).toContain("const isSequenceDiagramExportView = props.graphView.viewType === 'api_sequence' || props.graphView.viewType === 'method_logic';");
    expect(source).toContain("const shouldRenderRuntimeGraph = activeGraphTool === 'runtime' && (props.isActive || typeof window === 'undefined') && !isSequenceDiagramExportView;");
    expect(source).toContain('const [activeGraphTool, setActiveGraphTool] = useState<CodeMapToolPanel | null>(null);');
    expect(source).toContain('{shouldRenderRuntimeGraph ? (');
    expect(source).toContain('<GraphRuntimeCanvas');
    expect(source).toContain("currentNodeId={selectedGraphSubject === 'node' ? selectedGraphNode?.id : null}");
    expect(source).toContain("currentEdgeId={selectedGraphSubject === 'edge' ? selectedGraphEdge?.id : null}");
  });

  it('keeps Code Map usable without horizontal overflow in portrait and compact macOS windows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Zeus macOS 窄窗口适配');
    expect(css).toMatch(/@media \(max-width: 1180px\)[\s\S]*\.graph-runtime-canvas\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(source).toContain('graph-view-selector-row');
    expect(source).toContain('graph-search-control-grid');
    expect(source).not.toContain('graph-view-switcher');
    expect(source).not.toContain('graph-search-bar');
    expect(css).toContain('图谱搜索与视图切换旧通用栏清理最终覆盖');
    expect(css).toMatch(/@media \(max-width: 1180px\)[\s\S]*\.graph-search-control-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.react-flow-node-summary,[\s\S]*\.graph-runtime-facts small[\s\S]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.code-map-view,[\s\S]*\.graph-runtime-mount[\s\S]*min-width:\s*0/);
    expect(css).toMatch(/\.graph-mermaid-preview pre[\s\S]*white-space:\s*pre-wrap/);
    expect(css).toMatch(/\.graph-mermaid-preview pre[\s\S]*max-height:\s*240px/);
    expect(css).toMatch(/\.graph-view-selector-row,[\s\S]*\.graph-mermaid-preview[\s\S]*min-width:\s*0/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-search-bar(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-view-switcher(?![\w-])/);
  });

  it('removes the redundant Code Map top status strip while keeping the view switcher and real graph title', () => {
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

    const viewSwitcherIndex = html.indexOf('class="graph-view-selector-row');
    const graphCanvasIndex = html.indexOf('class="graph-canvas');

    expect(html).toContain('真实来源');
    expect(html).toContain('真实来源 · 1 个节点 · 0 条聚合边');
    expect(html).not.toContain('1 nodes · 0 edges');
    expect(html).toContain('class="graph-view-selector-row graph-view-selector-inline"');
    expect(viewSwitcherIndex).toBeGreaterThanOrEqual(0);
    expect(graphCanvasIndex).toBeGreaterThanOrEqual(0);
    expect(viewSwitcherIndex).toBeLessThan(graphCanvasIndex);
    expect(html).toContain('<h3>Zeus 系统架构图</h3>');
    expect(html).not.toContain('class="code-map-context-strip"');
    expect(html).not.toContain('class="code-map-context-facts"');
    expect(html).not.toContain('class="code-map-status-summary"');
    expect(html).not.toContain('class="code-map-status-metrics"');
    expect(html).not.toContain('class="code-map-status-row"');
    expect(html).not.toContain('code-map-status-strip');
    expect(html).not.toContain('graph-performance-strip');
    expect(html).not.toContain('Spatial Graph Studio');
    expect(html).not.toContain('Graph Stage');
    expect(html).not.toContain('Node Focus');
    expect(html).not.toContain('Source Trail');
    expect(html).not.toContain('class="spatial-graph-stage"');
    expect(html).not.toContain('code-map-drawer-stage');
    expect(html).not.toContain('spatial-graph-studio');
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

    expect(html).toContain('代码图谱');
    expect(html).toMatch(/viewBox="\d+ \d+ \d+ \d+"/);
    expect(html).toContain('translate(111 222)');
    expect(html).toContain('服务端布局：层级布局');
    expect(html).not.toContain('服务端布局 hierarchical');
    expect(html).toContain('2 个节点 · 1 条聚合边');
    expect(html).not.toContain('2 nodes · 1 聚合边');
    expect(html).toContain('index.ts');
    expect(html).toContain('packages/local-server/src/index.ts');
    expect(html).toContain('declares');
    expect(html).toContain('聚合 2 条真实边');
    expect(html).toContain('2 个来源');
    expect(html).not.toContain('2 sources');
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
    expect(html).toContain('分析图谱节点：index.ts · 已完成');
    expect(html).not.toContain('分析图谱节点：index.ts · completed');
    expect(html).toContain('<span class="graph-detail-row-label">风险标签</span><span class="graph-detail-context-list"><span>任务完成</span></span>');
    expect(html).not.toContain('<span>task_completed</span>');
    expect(html).not.toContain('task_completed');
    expect(html).toContain('AI 摘要');
    expect(html).toContain('真实 AI 摘要：local-server 入口负责本机 API 编排。');
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('formatGraphRiskTag(tag, props.appLanguage)');
    expect(source).not.toContain('<span key={tag}>{tag}</span>');
  });

  it('makes graph node menus keyboard dismissible and closes them on outside pointer down', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_node_menu_motion',
      title: 'Zeus 节点菜单',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'index.ts',
          qualifiedName: 'packages/local-server/src/index.ts',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1, lineEnd: 40 },
        },
      ],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const closeGraphNodeMenu = () => setActiveNodeMenuId(null);');
    expect(source).toContain('const handleGraphNodeMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {');
    expect(source).toContain("if (event.key !== 'Escape') return;");
    expect(source).toContain('closeGraphNodeMenu();');
    expect(source).toContain('const closeGraphNodeMenuOnOutsidePointerDown = (event: PointerEvent) => {');
    expect(source).toContain("if (event.target.closest('.graph-node-row')) return;");
    expect(source).toContain("document.addEventListener('pointerdown', closeGraphNodeMenuOnOutsidePointerDown, true);");
    expect(source).toContain("document.removeEventListener('pointerdown', closeGraphNodeMenuOnOutsidePointerDown, true);");
    expect(source).toContain('onKeyDown={handleGraphNodeMenuKeyDown}');
    expect(html).toContain('data-motion-surface="popover"');
    expect(html).toContain('role="menu"');
    expect(html).toContain('role="menuitem"');
    expect(source).not.toContain('setHiddenNodeIds([]);');
  });

  it('keeps graph node popovers mounted for a short closing animation instead of disappearing instantly', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('const graphNodeMenuCloseAnimationMs = 120;');
    expect(source).toContain('const [closingNodeMenuId, setClosingNodeMenuId] = useState<string | null>(null);');
    expect(source).toContain('const graphNodeMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);');
    expect(source).toContain('function closeGraphNodeMenuWithMotion(): void');
    expect(source).toContain('setClosingNodeMenuId(activeNodeMenuId);');
    expect(source).toContain('data-motion-state={isMenuClosing ?');
    expect(source).toContain('hidden={!isMenuVisible}');
    expect(css).toMatch(/\.macos-ai-app \.graph-node-row \.graph-node-menu-row\[data-motion-state='closing'\]\s*\{[\s\S]*animation:\s*zeus-popover-exit 120ms var\(--zeus-motion-ease-out\) forwards/);
    expect(css).toMatch(/\.macos-ai-app \.graph-node-row \.graph-node-menu-row\[data-motion-state='closing'\]\s*\{[\s\S]*pointer-events:\s*none/);
  });

  it('normalizes graph node and edge details into compact inspector rows instead of loose detail cards', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_detail_rows',
      title: 'Zeus 详情检查器',
      viewType: 'architecture',
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
            lineEnd: 40,
            aiSummary: '真实 AI 摘要',
            riskTags: ['source_verified'],
          },
        },
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'GET /api/tasks',
          qualifiedName: 'GET /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: {
            lineStart: 2700,
            lineEnd: 2790,
          },
        },
      ],
      edges: [
        {
          id: 'edge_api',
          edgeType: 'exposes_api',
          sourceNodeId: 'node_file',
          targetNodeId: 'node_api',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 0.92,
        },
      ],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('graph-detail-workbench');
    expect(html).toContain('graph-node-detail-workbench');
    expect(html).toContain('graph-edge-detail-workbench');
    expect(html).toContain('graph-detail-header');
    expect(html).toContain('graph-detail-source-row');
    expect(html).toContain('graph-detail-context-row');
    expect(html).toContain('置信度 0.92');
    expect(html).not.toContain('confidence 0.92');
    expect(source).not.toContain('<aside className="graph-detail" aria-label="节点详情">');
    expect(source).not.toContain('<aside className="graph-edge-detail" aria-label="边详情">');
    expect(source).not.toContain('graph-detail-evidence-row');
    expect(css).not.toContain('graph-detail-evidence-row');
    expect(css).toContain('图谱详情检查器最终覆盖');
    expect(css).toContain('图谱详情 evidence-row 命名清理最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-detail-workbench\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.graph-detail-header\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.graph-detail-source-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-detail-context-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(96px,\s*0\.28fr\) minmax\(0,\s*1fr\)/);
  });

  it('localizes graph edge confidence labels in both code map lists and detail inspectors', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_edge_confidence_i18n',
      title: '边置信度双语',
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
          confidence: 0.92,
        },
      ],
    };

    const zhHtml = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);
    const enHtml = renderToStaticMarkup(
      <App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} initialAppShellSettings={createAppShellSettings('en-US')} />,
    );

    expect(zhHtml).toContain('置信度 0.92');
    expect(zhHtml).not.toContain('confidence 0.92');
    expect(zhHtml).not.toContain('confidence unknown');
    expect(enHtml).toContain('Confidence 0.92');
  });

  it('removes legacy graph detail drawer card selector families in favor of sourced detail rows', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_real_detail_rows',
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
          metadata: {
            lineStart: 1,
            lineEnd: 20,
            aiSummary: '真实入口文件摘要',
            recentTasks: [{ taskId: 'task_real', title: '追踪图谱抽屉', status: 'ready' }],
            riskTags: ['高扇出'],
          },
        },
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'GET /api/tasks',
          qualifiedName: 'GET /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 2700, lineEnd: 2790 },
        },
        {
          id: 'node_storage',
          nodeType: 'table',
          name: 'tasks',
          qualifiedName: 'tasks',
          sourceRef: 'packages/storage/src/schema.ts',
          symbolId: 'symbol_table',
          metadata: { lineStart: 40, lineEnd: 80 },
        },
      ],
      edges: [
        {
          id: 'edge_api',
          edgeType: 'exposes_api',
          sourceNodeId: 'node_file',
          targetNodeId: 'node_api',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 0.92,
        },
        {
          id: 'edge_storage',
          edgeType: 'reads_table',
          sourceNodeId: 'node_api',
          targetNodeId: 'node_storage',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 0.88,
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('graph-detail-neighborhood-row');
    expect(html).toContain('graph-detail-risk-row');
    expect(html).toContain('graph-detail-task-row');
    expect(html).toContain('graph-detail-summary-row');
    expect(html).toContain('一跳邻居');
    expect(html).toContain('二跳影响范围');
    expect(html).toContain('追踪图谱抽屉 · 待开始');
    expect(html).not.toContain('追踪图谱抽屉 · ready');
    expect(source).not.toContain('className="graph-detail-context-row graph-neighborhood"');
    expect(source).not.toContain('graph-conversation-detail');
    expect(source).not.toContain('graph-ai-summary');
    expect(source).not.toContain('graph-recent-tasks');
    expect(source).not.toContain('graph-risk-tags');
    expect(css).toContain('图谱详情旧卡片选择器清理最终覆盖');
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-edge-detail(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-neighborhood(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-conversation-detail(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-ai-summary(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-recent-tasks(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-risk-tags(?![\w-])/);
    expect(css).toMatch(/\.macos-ai-app \.graph-detail-neighborhood-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(96px,\s*0\.28fr\) minmax\(0,\s*1fr\)/);
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
    expect(html).toContain('聚合 2 个真实节点 · 2 个来源');
    expect(html).not.toContain('聚合 2 个真实节点 · 2 sources');
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

  it('normalizes graph view choices and code map tool tabs into restrained segmented controls', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_segmented_controls',
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
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 7 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('class="graph-view-selector-row graph-view-selector-inline" role="tablist" aria-orientation="horizontal" data-inline-rail-keyboard="horizontal"');
    expect(html).toContain('class="graph-view-selector-tab" type="button" role="tab" aria-selected="true" aria-pressed="true" tabindex="0" data-inline-rail-item="true"');
    expect(html).toContain('class="graph-view-selector-tab" type="button" role="tab" aria-selected="false" aria-pressed="false" tabindex="-1" data-inline-rail-item="true"');
    expect(html).toContain('class="code-map-tool-tabs code-map-tool-launcher" aria-label="图谱工具切换" role="tablist" aria-orientation="horizontal" data-inline-rail-keyboard="horizontal"');
    expect(html).toContain('type="button" class="code-map-tool-tab" role="tab" aria-selected="false" aria-pressed="false" tabindex="0" data-inline-rail-item="true"');
    expect(html).toContain('type="button" class="code-map-tool-tab" role="tab" aria-selected="false" aria-pressed="false" tabindex="-1" data-inline-rail-item="true"');
    expect(css).toContain('分段选择控件最终覆盖');
    for (const token of ['--zeus-segment-bg', '--zeus-segment-line', '--zeus-segment-selected-bg', '--zeus-segment-selected-text']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.graph-view-selector-row\s*\{[\s\S]*background:\s*var\(--zeus-segment-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-view-selector-row\s*\{[\s\S]*border:\s*1px solid var\(--zeus-segment-line\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-view-selector-row button\s*\{[\s\S]*border-radius:\s*7px/);
    expect(css).toMatch(/\.macos-ai-app \.graph-view-selector-row button\[aria-pressed=['"]true['"]\]\s*\{[\s\S]*background:\s*var\(--zeus-segment-selected-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.code-map-tool-tabs\s*\{[\s\S]*background:\s*var\(--zeus-segment-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.code-map-tool-tab\[aria-pressed=['"]true['"]\]\s*\{[\s\S]*background:\s*var\(--zeus-segment-selected-bg\)/);
    expect(css).not.toContain('border-radius: 999px;\n  background: oklch(98% 0.006 265)');
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
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="代码图谱画布"');
    expect(html).toContain('App.tsx');
    expect(html).toContain('scanProject');
    expect(html).toContain('buildGraph');
    expect(html).toContain('调用 0.92');
    expect(html).not.toContain('calls 0.92');
    expect(html).toContain('发出事件 0.88');
    expect(html).not.toContain('emits 0.88');
    expect(html).toContain('apps/desktop/src/renderer/App.tsx');
  });

  it('lets ordinary code graph nodes open source and create tasks directly from the graph stage', () => {
    const graphView: GraphViewSnapshot = {
      id: 'module_direct_node_actions',
      title: '模块图',
      viewType: 'module',
      nodes: [
        {
          id: 'node_guard',
          nodeType: 'control_flow',
          name: 'if stale batch',
          qualifiedName: 'repairBatch#if stale batch',
          sourceRef: 'packages/inventory/src/repair.ts',
          symbolId: 'symbol_guard',
          metadata: { lineStart: 42, lineEnd: 48, sourceHash: 'hash_guard' },
        },
        {
          id: 'node_repo',
          nodeType: 'function',
          name: 'deleteAllStw',
          qualifiedName: 'RedisRepository.deleteAllStw',
          sourceRef: 'packages/inventory/src/redis.ts',
          symbolId: 'symbol_repo',
          metadata: { lineStart: 88, lineEnd: 120, sourceHash: 'hash_repo' },
        },
      ],
      edges: [
        {
          id: 'edge_guard_repo',
          edgeType: 'calls',
          sourceNodeId: 'node_guard',
          targetNodeId: 'node_repo',
          sourceRef: 'packages/inventory/src/repair.ts',
          confidence: 0.96,
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-canvas-node control_flow');
    expect(stageHtml).toContain('data-graph-source-ref="packages/inventory/src/repair.ts"');
    expect(stageHtml).toContain('data-graph-source-line="42"');
    expect(stageHtml).toContain('按 O 打开源码');
    expect(stageHtml).toContain('按 T 创建任务');
    expect(source).toContain('openGraphCanvasNodeSource');
    expect(source).toContain('createGraphCanvasNodeTask');
    expect(source).toContain('onDoubleClick={() => openGraphCanvasNodeSource(node)}');
    expect(source).toContain("event.key.toLowerCase() === 'o'");
    expect(source).toContain("event.key.toLowerCase() === 't'");
  });

  it('treats ordinary and sequence graph canvases as interactive groups instead of static images', () => {
    const ordinaryGraphView: GraphViewSnapshot = {
      id: 'interactive_module_graph',
      title: '模块图',
      viewType: 'module',
      nodes: [
        {
          id: 'node_api',
          nodeType: 'function',
          name: 'handleRequest',
          qualifiedName: 'ApiController.handleRequest',
          sourceRef: 'apps/api.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 12 },
        },
        {
          id: 'node_service',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'RepairService.repair',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_service',
          metadata: { lineStart: 42 },
        },
      ],
      edges: [
        {
          id: 'edge_api_service',
          edgeType: 'calls',
          sourceNodeId: 'node_api',
          targetNodeId: 'node_service',
          sourceRef: 'apps/api.ts',
          confidence: 1,
        },
      ],
    };
    const sequenceGraphView: GraphViewSnapshot = {
      ...ordinaryGraphView,
      id: 'interactive_sequence_graph',
      title: '接口时序图',
      viewType: 'api_sequence',
    };
    const ordinaryHtml = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={ordinaryGraphView} />);
    const sequenceHtml = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={sequenceGraphView} />);
    const ordinaryStageHtml = ordinaryHtml.slice(ordinaryHtml.indexOf('project-code-map-stage'), ordinaryHtml.indexOf('code-map-secondary-tools'));
    const sequenceStageHtml = sequenceHtml.slice(sequenceHtml.indexOf('project-code-map-stage'), sequenceHtml.indexOf('code-map-secondary-tools'));

    expect(ordinaryStageHtml).toContain('class="graph-canvas-svg" role="group"');
    expect(sequenceStageHtml).toContain('class="graph-canvas-svg graph-sequence-svg" role="group"');
    expect(ordinaryStageHtml).not.toContain('class="graph-canvas-svg" role="img"');
    expect(sequenceStageHtml).not.toContain('class="graph-canvas-svg graph-sequence-svg" role="img"');
    expect(ordinaryStageHtml).toContain('data-graph-node-id="node_api"');
    expect(sequenceStageHtml).toContain('data-graph-node-id="node_api"');
    expect(ordinaryStageHtml).toContain('role="button"');
    expect(sequenceStageHtml).toContain('role="button"');
  });

  it('makes graph node inline source and task affordances keyboard focusable buttons', () => {
    const graphView: GraphViewSnapshot = {
      id: 'inline_node_affordance_buttons',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_api',
          nodeType: 'function',
          name: 'handleRequest',
          qualifiedName: 'ApiController.handleRequest',
          sourceRef: 'apps/api.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 12 },
        },
        {
          id: 'node_service',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'RepairService.repair',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_service',
          metadata: { lineStart: 42 },
        },
      ],
      edges: [
        {
          id: 'edge_api_service',
          edgeType: 'calls',
          sourceNodeId: 'node_api',
          targetNodeId: 'node_service',
          sourceRef: 'apps/api.ts',
          confidence: 1,
        },
      ],
    };
    const ordinaryGraphView: GraphViewSnapshot = { ...graphView, id: 'inline_node_affordance_buttons_module', title: '模块图', viewType: 'module' };
    const sequenceHtml = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const ordinaryHtml = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={ordinaryGraphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const sequenceStageHtml = sequenceHtml.slice(sequenceHtml.indexOf('project-code-map-stage'), sequenceHtml.indexOf('code-map-secondary-tools'));
    const ordinaryStageHtml = ordinaryHtml.slice(ordinaryHtml.indexOf('project-code-map-stage'), ordinaryHtml.indexOf('code-map-secondary-tools'));

    expect(sequenceStageHtml).toContain('class="graph-sequence-source-link" role="button" tabindex="0"');
    expect(sequenceStageHtml).toContain('class="graph-sequence-task-link" role="button" tabindex="0"');
    expect(ordinaryStageHtml).toContain('class="graph-canvas-node-affordance graph-canvas-node-source-link" role="button" tabindex="0"');
    expect(ordinaryStageHtml).toContain('class="graph-canvas-node-affordance graph-canvas-node-task-link" role="button" tabindex="0"');
    expect(sequenceStageHtml).toContain('aria-keyshortcuts="Enter Space O T"');
    expect(ordinaryStageHtml).toContain('aria-keyshortcuts="Enter Space O T"');
    expect(sequenceStageHtml).toContain('aria-keyshortcuts="Enter Space"');
    expect(ordinaryStageHtml).toContain('aria-keyshortcuts="Enter Space"');
    expect(source).toContain('handleGraphNodeInlineAffordanceKeyDown');
    expect(source).toContain("event.key !== 'Enter' && event.key !== ' '");
  });

  it('gives graph node inline affordance buttons their own visible focus state', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('图谱节点内联动作焦点态最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-canvas-node-affordance:focus-visible\s*\{[\s\S]*opacity:\s*1[\s\S]*fill:\s*var\(--zeus-product-accent\)[\s\S]*text-decoration:\s*underline/);
    expect(css).toMatch(/\.macos-ai-app :where\(\.graph-sequence-source-link,\s*\.graph-sequence-task-link\):focus-visible\s*\{[\s\S]*opacity:\s*1[\s\S]*fill:\s*var\(--zeus-product-accent\)[\s\S]*text-decoration:\s*underline/);
  });

  it('shows ordinary graph node source and task affordances only on hover focus or current state', () => {
    const graphView: GraphViewSnapshot = {
      id: 'module_node_affordances',
      title: '模块图',
      viewType: 'module',
      nodes: [
        {
          id: 'node_guard',
          nodeType: 'control_flow',
          name: 'if stale batch',
          qualifiedName: 'repairBatch#if stale batch',
          sourceRef: 'packages/inventory/src/repair.ts',
          symbolId: 'symbol_guard',
          metadata: { lineStart: 42, lineEnd: 48, sourceHash: 'hash_guard' },
        },
      ],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-canvas-node-source-link');
    expect(stageHtml).toContain('graph-canvas-node-task-link');
    expect(stageHtml).toContain('打开源码');
    expect(stageHtml).toContain('创建任务');
    expect(css).toContain('普通图谱节点轻量交互提示最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-canvas-node-affordance\s*\{[\s\S]*opacity:\s*0/);
    expect(css).toMatch(
      /\.macos-ai-app \.graph-canvas-node:where\(:hover,\s*:focus-visible\) \.graph-canvas-node-affordance,\s*\.macos-ai-app \.graph-canvas-node\.current-graph-canvas-object \.graph-canvas-node-affordance\s*\{[\s\S]*opacity:\s*1/,
    );
    expect(css).toMatch(/\.macos-ai-app \.graph-canvas-node-affordance\s*\{[\s\S]*transition:\s*opacity 160ms var\(--zeus-motion-ease-out\)/);
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

    expect(html).toContain('声明 1.00');
    expect(html).not.toContain('declares 1.00');
    expect(html).not.toContain('calls 0.72');

    const settingsHtml = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 2, viewCount: 1 })} initialMainNavTarget="settings" initialGraphView={graphView} />);
    expect(settingsHtml).not.toContain('显示低置信边');
  });

  it('offers opening the code graph in Chinese without leaving stale Code Map button copy', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(html).toContain('打开图谱');
    expect(source).toContain("openCodeMap: '打开代码图谱'");
    expect(source).not.toContain("openCodeMap: '打开 Code Map'");
  });

  it('builds graph-conversation task intent from the selected app language instead of hard-coding Chinese in the renderer entry', () => {
    const mainSource = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');

    expect(buildGraphConversationTaskIntent('zh-CN')).toBe('基于这次图谱问答创建可执行跟进任务');
    expect(buildGraphConversationTaskIntent('en-US')).toBe('Create an actionable follow-up task from this code-map Q&A');
    expect(mainSource).toContain('buildGraphConversationTaskIntent(appShellSettings.appLanguage)');
    expect(mainSource).not.toContain("intent: '基于这次图谱问答创建可执行跟进任务'");
  });

  it('routes project drawer graph actions through project-scoped callbacks instead of the global current-repo graph', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const mainSource = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');

    expect(appSource).toContain('onScanProjectGraph?: (projectId: string) => Promise<DashboardSnapshot>');
    expect(appSource).toContain('onLoadProjectGraphView?: (projectId: string, viewType?: GraphViewType) => Promise<GraphViewSnapshot>');
    expect(appSource).toContain('onSearchProjectGraph?: (projectId: string, query: string, nodeType?: string, edgeType?: string, minConfidence?: number) => Promise<GraphSearchResult>');
    expect(appSource).toContain('const activeProjectId = selectedProject?.id ?? firstProjectId;');
    expect(appSource).toContain('const projectId = activeProjectId;');
    expect(appSource).toContain('onScanProjectGraph(projectId)');
    expect(appSource).toContain("onLoadProjectGraphView(projectId, 'architecture')");
    expect(appSource).not.toContain("setProjectPanel('graph');\n                        void scanCurrentGraph();");
    expect(mainSource).toContain('onScanProjectGraph');
    expect(mainSource).toContain('client.scanProject(projectId)');
    expect(mainSource).toContain('client.loadProjectGraphView(projectId, viewType ??');
    expect(mainSource).toContain('client.searchProjectGraph(projectId');
  });

  it('structures the graph drawer around a primary stage and collected secondary tools instead of one long feature stack', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_drawer_stage',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'App.tsx',
          qualifiedName: 'apps/desktop/src/renderer/App.tsx',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);

    expect(html).toContain('code-map-workbench');
    expect(html).toContain('code-map-primary-grid');
    expect(html).not.toContain('code-map-drawer-stage');
    expect(html).toContain('code-map-inspector-pane');
    expect(html).toContain('code-map-secondary-tools');
    expect(html).toContain('code-map-tool-pane');
    expect(html).not.toContain('图谱功能长列表');
  });

  it('normalizes code map secondary tools into a tabbed inspector instead of stacked details panels', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_tool_tabs',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'App.tsx',
          qualifiedName: 'apps/desktop/src/renderer/App.tsx',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('code-map-tool-tabs');
    expect(html).toContain('code-map-tool-launcher');
    expect(html).toContain('code-map-tool-tab');
    expect(html).not.toContain('code-map-tool-pane-active');
    for (const label of ['运行时预览', '搜索与筛选', '图谱问答', 'Mermaid', '节点与边']) {
      expect(html).toContain(label);
    }
    expect(source).toContain('type CodeMapToolPanel');
    expect(source).toContain('activeGraphTool');
    expect(source).not.toContain('<details className="code-map-tool-pane"');
    expect(source).not.toContain('<summary>搜索与筛选</summary>');
    expect(css).toContain('代码图谱工具标签最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.code-map-secondary-tools\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.code-map-tool-pane\s*\{[\s\S]*overflow:\s*auto/);
  });

  it('renames code map inspector and tool shells away from panel semantics into panes', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_tool_panes',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'App.tsx',
          qualifiedName: 'apps/desktop/src/renderer/App.tsx',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('code-map-inspector-pane');
    expect(html).toContain('code-map-tool-pane');
    expect(source).toContain('code-map-tool-pane-active');
    expect(html).not.toContain('code-map-tool-pane-active');
    expect(source).toContain('代码图谱 inspector pane');
    expect(css).toContain('代码图谱 inspector pane 命名最终覆盖');
    for (const staleClass of ['code-map-inspector-panel', 'code-map-tool-panel', 'code-map-tool-panel-active', 'graph-qa-detail-panel']) {
      expect(source).not.toContain(staleClass);
      expect(css).not.toContain(staleClass);
      expect(html).not.toContain(staleClass);
    }
  });

  it('compresses code map secondary tools into a compact inspector without stale details chrome or fixed blank height', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_tool_inspector_compact',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'App.tsx',
          qualifiedName: 'apps/desktop/src/renderer/App.tsx',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('code-map-secondary-inspector');
    expect(html).toContain('code-map-secondary-inspector');
    expect(source).toContain('code-map-tool-tab-copy');
    expect(html).toContain('code-map-tool-tab-copy');
    expect(css).toContain('代码图谱二级 Inspector 紧凑化最终覆盖');
    for (const token of ['--zeus-code-map-inspector-bg', '--zeus-code-map-inspector-line', '--zeus-code-map-inspector-tab-bg', '--zeus-code-map-inspector-active-bg']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.code-map-secondary-tools\.code-map-secondary-inspector\s*\{[\s\S]*background:\s*var\(--zeus-code-map-inspector-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.code-map-secondary-tools\.code-map-secondary-inspector\s*\{[\s\S]*min-block-size:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.code-map-secondary-inspector \.code-map-tool-tabs\s*\{[\s\S]*min-block-size:\s*34px/);
    expect(css).not.toMatch(/\.macos-ai-app \.code-map-tool-pane\s*>\s*summary/);
    expect(css).not.toMatch(/\.macos-ai-app \.code-map-tool-pane\s*\{[^}]*min-block-size:\s*260px/);
  });

  it('flattens the project code inspector into a side pane instead of another card wrapper', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const marker = '代码图谱检查器侧栏扁平化最终覆盖';
    const finalCss = css.slice(css.indexOf(marker));
    const inspectorBlock = finalCss.match(/\.macos-ai-app \.project-code-map-stage \.code-map-inspector-pane\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const secondaryBlock = finalCss.match(/\.macos-ai-app \.code-map-secondary-tools\.code-map-secondary-inspector\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(css).toContain(marker);
    expect(inspectorBlock).toContain('background: transparent');
    expect(inspectorBlock).toContain('border: 0');
    expect(inspectorBlock).toContain('border-inline-start: 1px solid var(--zeus-product-line-soft)');
    expect(inspectorBlock).toContain('border-radius: 0');
    expect(inspectorBlock).toContain('box-shadow: none');
    expect(secondaryBlock).toContain('background: transparent');
    expect(secondaryBlock).toContain('border: 0');
    expect(secondaryBlock).toContain('border-block-start: 1px solid var(--zeus-product-line-soft)');
    expect(secondaryBlock).toContain('border-radius: 0');
    expect(secondaryBlock).toContain('box-shadow: none');
    expect(inspectorBlock).not.toContain('var(--zeus-product-panel)');
    expect(secondaryBlock).not.toContain('var(--zeus-code-map-inspector-bg)');
  });

  it('normalizes graph search filters into explicit control rows instead of label wrapped inputs and selects', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_graph_search_filters',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_file',
          nodeType: 'file',
          name: 'App.tsx',
          qualifiedName: 'apps/desktop/src/renderer/App.tsx',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_file',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('graph-search-control-row');
    expect(html).toContain('graph-search-control-copy');
    expect(html).toContain('graph-search-control-field');
    expect(source).not.toContain('<label>\n              搜索节点/字段');
    expect(source).not.toContain('<label>\n              筛选类型');
    expect(source).not.toContain('<label>\n              边类型');
    expect(source).not.toContain('<label>\n              最低置信度');
    expect(source).not.toMatch(/className="graph-search-control-field">\s*<span className="graph-search-control-field"/);
    expect(css).toContain('图谱搜索筛选控件行最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-search-control-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(160px,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-search-control-field\s*\{[\s\S]*display:\s*grid/);
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
    expect(html).toContain('未归档 · 已关闭');
    expect(html).not.toContain('未归档 · closed');
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

  it('normalizes graph question and history into compact sourced rows instead of edit form timelines', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('graph-qa-workbench');
    expect(source).toContain('graph-qa-compose-row');
    expect(source).toContain('graph-qa-answer-row');
    expect(source).toContain('graph-qa-history');
    expect(source).toContain('graph-qa-history-row');
    expect(source).toContain('graph-qa-empty-row');
    expect(source).toContain('graph-qa-pagination-row');
    expect(source).toContain('graph-qa-detail-pane');
    expect(source).toContain('graph-qa-message-row');
    expect(source).not.toContain('className="edit-form" aria-label="图谱问答"');
    expect(css).toContain('图谱问答与历史最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-workbench\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-history-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  });

  it('normalizes graph question detail into a compact inspector with meta and message list rows', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_graph_qa_detail_inspector',
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
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const className of ['graph-qa-detail-inspector', 'graph-qa-detail-title-copy', 'graph-qa-detail-meta-row', 'graph-qa-detail-message-list', 'graph-qa-detail-message-copy']) {
      expect(source).toContain(className);
      expect(html).toContain(className);
    }
    expect(html).toContain('Runtime 会话 ai-session-real');
    expect(html).toContain('2 条消息');
    expect(html).toContain('未归档 · 已关闭');
    expect(html).not.toContain('未归档 · closed');
    expect(css).toContain('图谱问答详情 Inspector 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-detail-pane\.graph-qa-detail-inspector\s*\{[\s\S]*background:\s*var\(--zeus-product-panel\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-detail-meta-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-detail-message-list\s*\{[\s\S]*display:\s*grid/);
    expect(css).not.toMatch(/\.macos-ai-app \.graph-qa-detail-pane\s*>\s*\.graph-qa-message-row/);
  });

  it('normalizes graph question input into an explicit compose control row instead of a label wrapped input', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_graph_question_input',
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
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('graph-qa-question-row');
    expect(html).toContain('graph-qa-question-copy');
    expect(html).toContain('graph-qa-question-field');
    expect(html).toContain('graph-qa-history-search-row');
    expect(html).toContain('graph-qa-history-search-copy');
    expect(html).toContain('graph-qa-history-search-field');
    expect(source).not.toContain('<label className="graph-qa-input">');
    expect(source).not.toContain('<label>\n                    <span>搜索历史</span>');
    expect(css).toContain('图谱问答输入控件行最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-question-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-question-field\s*\{[\s\S]*display:\s*grid/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-history-search-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(180px,\s*1fr\)/);
  });

  it('lands graph question composer into Zeus ComposerDock ModeRail and DecisionRail without turning code page into a session layout', () => {
    const graphView: GraphViewSnapshot = {
      viewType: 'architecture',
      generatedAt: '2026-06-18T00:00:00.000Z',
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
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('graph-qa-compose-row zeus-composer-dock');
    expect(html).toContain('graph-qa-decision-rail zeus-decision-rail');
    expect(html).toContain('graph-qa-ask-button zeus-decision-rail-button');
    expect(html).toContain('graph-qa-mode-rail zeus-mode-rail');
    expect(html).toContain('graph-qa-mode-rail-item zeus-mode-rail-item');
    expect(html).toContain('系统架构图');
    expect(html).toContain('1 / 1');
    expect(html).toContain('0 / 0');
    expect(source).toContain('qaModeRailAria');
    expect(css).toContain('图谱问答 ModeRail 与 DecisionRail 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-compose-row\.zeus-composer-dock\s*\{[\s\S]*grid-template-areas:\s*['"]copy question actions['"] ['"]mode mode mode['"]/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-mode-rail\s*\{[\s\S]*grid-area:\s*mode/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-decision-rail\.zeus-decision-rail\s*\{[\s\S]*grid-area:\s*actions/);
    expect(css).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.macos-ai-app \.graph-qa-compose-row\.zeus-composer-dock\s*\{[\s\S]*grid-template-areas:\s*['"]copy['"] ['"]question['"] ['"]actions['"] ['"]mode['"]/);
    expect(css).not.toMatch(/\.macos-ai-app \.workspace-view-project-code\s*\{[^}]*grid-template-columns:\s*minmax\(248px,\s*280px\) minmax\(0,\s*1fr\)/);
  });

  it('normalizes graph question composer controls into dedicated QA tokens instead of ordinary toolbar actions', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('graph-qa-ask-button');
    expect(source).toContain('graph-qa-task-button');
    expect(css).toContain('图谱问答 Composer 控件最终覆盖');
    for (const token of ['--zeus-graph-qa-compose-bg', '--zeus-graph-qa-compose-line', '--zeus-graph-qa-action-bg', '--zeus-graph-qa-ask-bg', '--zeus-graph-qa-ask-text']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-compose-row\s*\{[\s\S]*background:\s*var\(--zeus-graph-qa-compose-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-compose-row\s*\{[\s\S]*border:\s*1px solid var\(--zeus-graph-qa-compose-line\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-ask-button\s*\{[\s\S]*background:\s*var\(--zeus-graph-qa-ask-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-ask-button\s*\{[\s\S]*color:\s*var\(--zeus-graph-qa-ask-text\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.graph-qa-compose-row\s*\{[^}]*background:\s*var\(--zeus-product-panel\)/);
  });

  it('normalizes graph question history controls into command rails instead of first-button toolbar emphasis', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('graph-qa-toolbar-command-rail');
    expect(source).toContain('graph-qa-history-command-rail');
    expect(source).toContain('graph-qa-detail-button');
    expect(source).toContain('graph-qa-archive-button');
    expect(css).toContain('图谱问答历史 command rail 最终覆盖');
    for (const token of ['--zeus-graph-qa-history-action-bg', '--zeus-graph-qa-history-action-line', '--zeus-graph-qa-history-button-bg', '--zeus-graph-qa-history-button-text', '--zeus-graph-qa-history-primary-bg']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-history-command-rail\s*\{[\s\S]*background:\s*var\(--zeus-graph-qa-history-action-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-history-command-rail button\s*\{[\s\S]*background:\s*var\(--zeus-graph-qa-history-button-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-qa-detail-button\s*\{[\s\S]*background:\s*var\(--zeus-graph-qa-history-primary-bg\)/);
    expect(source).not.toContain('graph-qa-actions');
    expect(css).not.toContain('graph-qa-actions');
    expect(source).not.toContain('graph-qa-toolbar-actions');
    expect(source).not.toContain('graph-qa-history-actions');
    expect(css).not.toContain('.graph-qa-toolbar-actions');
    expect(css).not.toContain('.graph-qa-history-actions');
    expect(css).not.toMatch(/\.macos-ai-app :where\([^)]*\.graph-qa-decision-rail[^)]*\) button:first-of-type/);
  });

  it('normalizes graph node and edge lists into compact source rows instead of loose action cards', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('graph-entity-workbench');
    expect(source).toContain('graph-entity-section');
    expect(source).toContain('graph-entity-section-header');
    expect(source).toContain('graph-node-row');
    expect(source).toContain('graph-node-copy');
    expect(source).toContain('graph-node-command-rail');
    expect(source).toContain('graph-node-menu-row');
    expect(source).toContain('graph-edge-row');
    expect(source).toContain('graph-edge-copy');
    expect(source).toContain('graph-edge-meta-rail');
    expect(source).not.toContain('graph-node-actions');
    expect(source).not.toContain('graph-edge-actions');
    expect(css).not.toContain('graph-node-actions');
    expect(css).not.toContain('graph-edge-actions');
    expect(source).not.toContain('className="graph-node"');
    expect(source).not.toContain('className="graph-node graph-node-row');
    expect(source).not.toContain('className="graph-edge"');
    expect(source).not.toContain('className="graph-edge graph-edge-row');
    expect(css).toContain('图谱节点与边列表最终覆盖');
    expect(css).toContain('图谱节点边旧通用卡片选择器清理最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-entity-workbench\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.graph-node-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.graph-edge-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-node(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-edge(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-node-menu(?![\w-])/);
  });

  it('normalizes graph canvas chrome into a flat sourced canvas instead of a decorative gradient stage', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('代码图谱画布产品面最终覆盖');
    for (const token of ['--zeus-graph-canvas-bg', '--zeus-graph-canvas-line', '--zeus-graph-canvas-source-bg', '--zeus-graph-canvas-source-text']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.graph-canvas\s*\{[\s\S]*background:\s*var\(--zeus-graph-canvas-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-canvas-svg\s*\{[\s\S]*background:\s*var\(--zeus-graph-canvas-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-canvas-sources span\s*\{[\s\S]*background:\s*var\(--zeus-graph-canvas-source-bg\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.graph-canvas-svg\s*\{[^}]*?(?:radial-gradient|linear-gradient)/);
    expect(css).not.toMatch(/\.macos-ai-app \.code-map-context-strip\s*\{[^}]*?(?:radial-gradient|linear-gradient)/);
    expect(css).not.toContain('.code-map-status-summary');
    expect(css).not.toContain('.code-map-status-metrics');
    expect(css).not.toContain('background-size: 28px 28px;');
    expect(css).not.toContain('background-size: 26px 26px, auto;');
  });

  it('does not rely on the removed code map context facts strip to orient the logic graph', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const marker = '代码图谱顶部冗余状态条移除最终覆盖';

    expect(source).not.toContain('className="code-map-status-row"');
    expect(source).not.toContain('className="code-map-context-strip"');
    expect(source).not.toContain('className="code-map-context-facts"');
    expect(source).toContain('className="graph-view-selector-row graph-view-selector-inline"');
    expect(css).toContain(marker);
    expect(css).toMatch(/\.macos-ai-app \.project-code-map-stage \.graph-view-selector-row\.graph-view-selector-inline\s*\{[\s\S]*margin-block-end:\s*8px/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-map-stage \.code-map-status-row\s*\{[\s\S]*display:\s*none/);
  });

  it('keeps ordinary code graphs as the dominant code-page stage before runtime previews', () => {
    const graphView: GraphViewSnapshot = {
      id: 'module_stage',
      title: '模块图',
      viewType: 'module',
      nodes: [
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'scanProjectGraph',
          qualifiedName: 'scanProjectGraph',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 4187 },
        },
        {
          id: 'node_flow',
          nodeType: 'control_flow',
          name: 'await scan',
          qualifiedName: 'scanProjectGraph.awaitScan',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_flow',
          metadata: { lineStart: 4192 },
        },
      ],
      edges: [
        {
          id: 'edge_flow',
          edgeType: 'executes',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_flow',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-canvas');
    expect(stageHtml).not.toContain('graph-runtime-canvas');
    expect(html).toContain('code-map-tool-launcher');
    expect(html).toContain('运行时预览');
    expect(css).toContain('代码图谱一屏工作台返修最终覆盖');
    expect(css.lastIndexOf('代码图谱一屏工作台返修最终覆盖')).toBeGreaterThan(css.lastIndexOf('代码图谱运行时预览辅助带扁平化最终覆盖'));
    expect(css).toMatch(/\.macos-ai-app \.project-code-map-stage \.code-map-stage-surface\s*\{[\s\S]*display:\s*block/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-map-stage \.code-map-primary-grid\s*\{[\s\S]*min-block-size:\s*clamp\(540px,\s*calc\(100vh - 210px\),\s*780px\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-map-stage \.graph-canvas-svg\s*\{[\s\S]*block-size:\s*clamp\(520px,\s*calc\(100vh - 260px\),\s*760px\)/);
    expect(css).toMatch(/\.macos-ai-app \.code-map-secondary-inspector \.code-map-tool-tabs\.code-map-tool-launcher\s*\{[\s\S]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.macos-ai-app \.project-code-primary:has\(\.project-code-map-stage\)\s*\{[\s\S]*grid-template-rows:\s*minmax\(clamp\(420px,\s*64vh,\s*560px\),\s*1fr\) auto/);
  });

  it('keeps runtime previews out of the default code graph stage until the user opens that tool', () => {
    const graphView: GraphViewSnapshot = {
      id: 'module_stage_runtime_collapsed',
      title: '模块图',
      viewType: 'module',
      nodes: [
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'scanProjectGraph',
          qualifiedName: 'scanProjectGraph',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 4187 },
        },
        {
          id: 'node_flow',
          nodeType: 'control_flow',
          name: 'await scan',
          qualifiedName: 'scanProjectGraph.awaitScan',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_flow',
          metadata: { lineStart: 4192 },
        },
      ],
      edges: [
        {
          id: 'edge_flow',
          edgeType: 'executes',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_flow',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('workspace-drawer-portal-root'));

    expect(stageHtml).toContain('graph-canvas');
    expect(stageHtml).not.toContain('graph-runtime-canvas');
    expect(stageHtml).toContain('code-map-tool-launcher');
    expect(stageHtml).toContain('运行时预览');
  });

  it('keeps secondary graph tools inside the inspector instead of stacking them under the canvas', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_tools_inside_inspector',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_app',
          nodeType: 'file',
          name: 'App.tsx',
          qualifiedName: 'apps/desktop/src/renderer/App.tsx',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_app',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const primaryGridHtml = html.slice(html.indexOf('code-map-primary-grid'), html.indexOf('project-code-context-rail'));
    const beforeToolsHtml = primaryGridHtml.slice(0, primaryGridHtml.indexOf('code-map-secondary-tools'));

    expect(primaryGridHtml).toContain('code-map-inspector-pane');
    expect(primaryGridHtml).toContain('code-map-secondary-tools');
    expect(beforeToolsHtml).not.toContain('</aside></div>');
  });

  it('builds a focused SVG viewport for small ordinary graphs instead of scaling them against the whole canvas', () => {
    const nodes: GraphViewSnapshot['nodes'] = [
      {
        id: 'node_a',
        nodeType: 'file',
        name: 'App.tsx',
        qualifiedName: 'apps/desktop/src/renderer/App.tsx',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        symbolId: 'symbol_a',
        metadata: { lineStart: 1 },
      },
      {
        id: 'node_b',
        nodeType: 'heading',
        name: '现象',
        qualifiedName: 'docs/TASK.md#现象',
        sourceRef: 'docs/TASK.md',
        symbolId: 'symbol_b',
        metadata: { lineStart: 12 },
      },
      {
        id: 'node_c',
        nodeType: 'heading',
        name: '影响',
        qualifiedName: 'docs/TASK.md#影响',
        sourceRef: 'docs/TASK.md',
        symbolId: 'symbol_c',
        metadata: { lineStart: 18 },
      },
    ];
    const layout = buildGraphCanvasLayout(nodes, 1440, 900, {
      algorithm: 'hierarchical',
      width: 1440,
      height: 900,
      positions: [
        { nodeId: 'node_a', x: 620, y: 420 },
        { nodeId: 'node_b', x: 740, y: 420 },
        { nodeId: 'node_c', x: 680, y: 510 },
      ],
    });
    const viewport = buildGraphCanvasViewport(layout, nodes.length, 1440, 900, false);

    expect(viewport.width).toBeLessThan(1440);
    expect(viewport.height).toBeLessThan(900);
    expect(viewport.width).toBeGreaterThanOrEqual(520);
    expect(viewport.height).toBeGreaterThanOrEqual(320);
    for (const point of layout.values()) {
      expect(point.x).toBeGreaterThanOrEqual(viewport.x);
      expect(point.x).toBeLessThanOrEqual(viewport.x + viewport.width);
      expect(point.y).toBeGreaterThanOrEqual(viewport.y);
      expect(point.y).toBeLessThanOrEqual(viewport.y + viewport.height);
    }
  });

  it('compresses repository status into a slim context rail when a real code graph is already the protagonist', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_code_graph_context_rail',
      projectId: 'project_real',
      projectName: 'Zeus',
      title: 'Zeus 系统架构图',
      viewType: 'architecture',
      nodes: [
        {
          id: 'node_app',
          nodeType: 'file',
          name: 'App.tsx',
          qualifiedName: 'apps/desktop/src/renderer/App.tsx',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_app',
          metadata: { lineStart: 1 },
        },
      ],
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const codePrimaryHtml = html.slice(html.indexOf('project-code-primary'), html.indexOf('workspace-drawer-portal-root'));

    expect(codePrimaryHtml.indexOf('project-code-map-stage')).toBeGreaterThanOrEqual(0);
    expect(codePrimaryHtml.indexOf('project-code-context-rail is-condensed')).toBeGreaterThanOrEqual(0);
    expect(codePrimaryHtml.indexOf('project-code-map-stage')).toBeLessThan(codePrimaryHtml.indexOf('project-code-context-rail is-condensed'));
    expect(css).toContain('代码图谱下方仓库上下文窄栏最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-code-primary:has\(\.project-code-map-stage\) \.project-code-context-rail\.is-condensed\s*\{[\s\S]*grid-template-areas:\s*['"]health primary secondary['"]/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-primary:has\(\.project-code-map-stage\) \.project-code-context-rail\.is-condensed \.code-graph-status-strip\s*\{[\s\S]*display:\s*none/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-primary:has\(\.project-code-map-stage\) \.project-code-context-rail\.is-condensed \.code-repository-facts dl\s*\{[\s\S]*display:\s*flex/);
  });

  it('keeps graph runtime preview as a flat auxiliary rail instead of cards under the code graph', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const marker = '代码图谱运行时预览辅助带扁平化最终覆盖';
    const finalCss = css.slice(css.indexOf(marker));
    const canvasBlock = finalCss.match(/\.macos-ai-app \.project-code-map-stage \.graph-runtime-canvas\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const paneBlock = finalCss.match(/\.macos-ai-app \.project-code-map-stage \.graph-runtime-pane\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const mountBlock = finalCss.match(/\.macos-ai-app \.project-code-map-stage \.graph-runtime-mount\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(css).toContain(marker);
    expect(canvasBlock).toContain('border-block-start: 1px solid var(--zeus-product-line-soft)');
    expect(canvasBlock).toContain('padding-block-start: 8px');
    expect(paneBlock).toContain('background: transparent');
    expect(paneBlock).toContain('border: 0');
    expect(paneBlock).toContain('border-radius: 0');
    expect(paneBlock).toContain('box-shadow: none');
    expect(mountBlock).toContain('background: transparent');
    expect(mountBlock).toContain('border: 0');
    expect(mountBlock).toContain('border-radius: 0');
    expect(mountBlock).toContain('padding: 0');
    expect(paneBlock).not.toContain('oklch(98.4%');
    expect(mountBlock).not.toContain('oklch(99%');
  });

  it('keeps the project code graph stage as an open canvas instead of another card wrapper', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const marker = '代码图谱开放舞台最终覆盖';
    const stageBlock = css.slice(css.indexOf(marker)).match(/\.macos-ai-app \.project-code-map-stage \.code-map-stage-surface\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(css).toContain(marker);
    expect(stageBlock).toContain('background: transparent');
    expect(stageBlock).toContain('border: 0');
    expect(stageBlock).toContain('border-radius: 0');
    expect(stageBlock).toContain('box-shadow: none');
    expect(stageBlock).toContain('overflow: visible');
    expect(stageBlock).not.toContain('var(--zeus-product-panel)');
    expect(stageBlock).not.toContain('1px solid var(--zeus-product-line)');
  });

  it('renders API sequence views as an interactive sequence diagram stage instead of a generic node cloud', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_stage',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'POST /api/tasks',
          qualifiedName: 'POST /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 120 },
        },
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'createTaskHandler',
          qualifiedName: 'createTaskHandler',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 140 },
        },
        {
          id: 'node_repo',
          nodeType: 'function',
          name: 'insertTask',
          qualifiedName: 'TaskRepository.insertTask',
          sourceRef: 'packages/storage/src/index.ts',
          symbolId: 'symbol_repo',
          metadata: { lineStart: 240 },
        },
      ],
      edges: [
        {
          id: 'edge_api_handler',
          edgeType: 'handles',
          sourceNodeId: 'node_api',
          targetNodeId: 'node_handler',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_handler_repo',
          edgeType: 'calls',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_repo',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-sequence-stage');
    expect(stageHtml).toContain('3 条生命线 · 2 条聚合边');
    expect(stageHtml).not.toContain('3 lifelines · 2 聚合边');
    expect(stageHtml).toContain('graph-sequence-svg');
    expect(stageHtml).toContain('graph-sequence-lifeline');
    expect(stageHtml).toContain('graph-sequence-message');
    expect(stageHtml).toContain('role="button"');
    expect(stageHtml).toContain('tabindex="0"');
    expect(stageHtml).toContain('data-graph-node-id="node_api"');
    expect(stageHtml).not.toContain('graph-canvas-node api');
    expect(source).toContain('viewType={props.graphView.viewType as GraphViewType}');
    expect(source).toContain('onSelectNode={selectGraphNode}');
    expect(css).toContain('API 时序图舞台最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-lifeline\s*\{[\s\S]*cursor:\s*pointer/);
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-lifeline:focus-visible\s*\{[\s\S]*outline:\s*none/);
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-message line\s*\{[\s\S]*stroke-dasharray:\s*none/);
  });

  it('renders method logic views as an interactive sequence diagram stage instead of a generic node cloud', () => {
    const graphView: GraphViewSnapshot = {
      id: 'method_logic_sequence_stage',
      title: '方法逻辑图',
      viewType: 'method_logic',
      nodes: [
        {
          id: 'node_method',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'InventoryRepairService.repair',
          sourceRef: 'packages/inventory/src/repair.ts',
          symbolId: 'symbol_method',
          metadata: { lineStart: 10 },
        },
        {
          id: 'node_guard',
          nodeType: 'control_flow',
          name: 'shouldClearRedis',
          qualifiedName: 'InventoryRepairService.repair#shouldClearRedis',
          sourceRef: 'packages/inventory/src/repair.ts',
          symbolId: 'symbol_guard',
          metadata: { lineStart: 28 },
        },
        {
          id: 'node_sql',
          nodeType: 'sql_call',
          name: 'DELETE stale cache',
          qualifiedName: 'InventoryRepairService.repair#deleteStaleCache',
          sourceRef: 'packages/inventory/src/repair.ts',
          symbolId: 'symbol_sql',
          metadata: { lineStart: 35 },
        },
      ],
      edges: [
        {
          id: 'edge_method_guard',
          edgeType: 'executes',
          sourceNodeId: 'node_method',
          targetNodeId: 'node_guard',
          sourceRef: 'packages/inventory/src/repair.ts',
          confidence: 1,
          metadata: { branchKind: 'if', conditionText: 'shouldClearRedis' },
        },
        {
          id: 'edge_guard_sql',
          edgeType: 'executes_sql',
          sourceNodeId: 'node_guard',
          targetNodeId: 'node_sql',
          sourceRef: 'packages/inventory/src/repair.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-sequence-stage');
    expect(stageHtml).toContain('3 条生命线 · 2 条聚合边');
    expect(stageHtml).toContain('graph-sequence-lifeline function');
    expect(stageHtml).toContain('graph-sequence-lifeline control_flow');
    expect(stageHtml).toContain('graph-sequence-lifeline sql_call');
    expect(stageHtml).toContain('graph-sequence-message');
    expect(stageHtml).toContain('data-graph-node-id="node_method"');
    expect(stageHtml).toContain('data-graph-source-ref="packages/inventory/src/repair.ts"');
    expect(stageHtml).toContain('data-graph-source-line="10"');
    expect(stageHtml).toContain('按 O 打开源码');
    expect(stageHtml).toContain('按 T 创建任务');
    expect(stageHtml).not.toContain('graph-canvas-node function');
    expect(source).toContain("const isSequenceGraphView = props.viewType === 'api_sequence' || props.viewType === 'method_logic';");
  });

  it('labels method and API sequence stages as sequence diagrams in both supported languages', () => {
    const graphView: GraphViewSnapshot = {
      id: 'method_logic_sequence_canvas_copy',
      title: '方法逻辑图',
      viewType: 'method_logic',
      nodes: [
        {
          id: 'node_method',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'InventoryRepairService.repair',
          sourceRef: 'packages/inventory/src/repair.ts',
          symbolId: 'symbol_method',
          metadata: { lineStart: 10 },
        },
      ],
      edges: [],
    };
    const zhHtml = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const enHtml = renderToStaticMarkup(
      <App
        snapshot={createSnapshot({ nodeCount: 1, edgeCount: 0, viewCount: 1 })}
        initialMainNavTarget="code-map"
        initialGraphView={{ ...graphView, title: 'Method logic diagram' }}
        initialAppShellSettings={createAppShellSettings('en-US')}
      />,
    );
    const zhStageHtml = zhHtml.slice(zhHtml.indexOf('graph-sequence-stage'), zhHtml.indexOf('graph-canvas-sources'));
    const enStageHtml = enHtml.slice(enHtml.indexOf('graph-sequence-stage'), enHtml.indexOf('graph-canvas-sources'));

    expect(zhStageHtml).toContain('aria-label="时序图画布"');
    expect(zhStageHtml).toContain('<h3>时序图画布</h3>');
    expect(zhStageHtml).not.toContain('代码图谱画布');
    expect(enStageHtml).toContain('aria-label="Sequence diagram canvas"');
    expect(enStageHtml).toContain('<h3>Sequence diagram canvas</h3>');
    expect(enStageHtml).not.toContain('Code graph canvas');
  });

  it('keeps method logic sequence diagrams as a single protagonist stage without runtime preview clutter', () => {
    const graphView: GraphViewSnapshot = {
      id: 'method_logic_sequence_without_runtime_preview',
      title: '方法逻辑图',
      viewType: 'method_logic',
      nodes: [
        {
          id: 'node_method',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'InventoryRepairService.repair',
          sourceRef: 'packages/inventory/src/repair.ts',
          symbolId: 'symbol_method',
          metadata: { lineStart: 10 },
        },
        {
          id: 'node_guard',
          nodeType: 'control_flow',
          name: 'shouldClearRedis',
          qualifiedName: 'InventoryRepairService.repair#shouldClearRedis',
          sourceRef: 'packages/inventory/src/repair.ts',
          symbolId: 'symbol_guard',
          metadata: { lineStart: 28 },
        },
      ],
      edges: [
        {
          id: 'edge_method_guard',
          edgeType: 'executes',
          sourceNodeId: 'node_method',
          targetNodeId: 'node_guard',
          sourceRef: 'packages/inventory/src/repair.ts',
          confidence: 1,
          metadata: { branchKind: 'if', conditionText: 'shouldClearRedis' },
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-sequence-stage');
    expect(stageHtml).not.toContain('graph-runtime-canvas');
    expect(stageHtml).not.toContain('Sigma WebGL');
    expect(stageHtml).not.toContain('React Flow');
  });

  it('lets API sequence lifeline nodes open their real source location without leaving the diagram stage', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_source_open',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'createTaskHandler',
          qualifiedName: 'createTaskHandler',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 140 },
        },
        {
          id: 'node_repo',
          nodeType: 'function',
          name: 'insertTask',
          qualifiedName: 'TaskRepository.insertTask',
          sourceRef: 'packages/storage/src/index.ts',
          symbolId: 'symbol_repo',
          metadata: { lineStart: 240 },
        },
      ],
      edges: [
        {
          id: 'edge_handler_repo',
          edgeType: 'calls',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_repo',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('data-graph-source-ref="packages/local-server/src/index.ts"');
    expect(stageHtml).toContain('data-graph-source-line="140"');
    expect(stageHtml).toContain('graph-sequence-source-link');
    expect(stageHtml).toContain('打开源码');
    expect(stageHtml).toContain('按 O 打开源码');
    expect(source).toContain('openGraphSequenceNodeSource');
    expect(source).toContain('onOpenGraphSource={props.onOpenGraphSource}');
    expect(source).toContain('onDoubleClick={() => openGraphSequenceNodeSource(node)}');
    expect(source).toContain("event.key.toLowerCase() === 'o'");
    expect(css).toContain('API 时序图 lifeline 源码入口最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-source-link\s*\{[\s\S]*font-size:\s*9px/);
  });

  it('does not show a fake task action for aggregated API sequence lifelines', () => {
    const nodes: GraphViewSnapshot['nodes'] = Array.from({ length: 9 }, (_, index) => ({
      id: `node_${index + 1}`,
      nodeType: 'function',
      name: `step${index + 1}`,
      qualifiedName: `Flow.step${index + 1}`,
      sourceRef: `packages/local-server/src/step${index + 1}.ts`,
      symbolId: `symbol_${index + 1}`,
      metadata: { lineStart: 100 + index },
    }));
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_aggregate_no_fake_task',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes,
      edges: [],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 9, edgeCount: 0, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));
    const aggregateLifelineHtml = stageHtml.match(/聚合 2 个节点[\s\S]*?graph-sequence-node-line/)?.[0] ?? '';

    expect(stageHtml).toContain('聚合 2 个节点');
    expect(aggregateLifelineHtml).toContain('graph-sequence-source-link');
    expect(aggregateLifelineHtml).not.toContain('graph-sequence-task-link');
    expect(source).toContain('!isAggregatedGraphNode(node) ? (');
  });

  it('lets API sequence lifeline nodes create sourced tasks from the diagram instead of forcing users into the entity list', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_task_from_lifeline',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'createTaskHandler',
          qualifiedName: 'createTaskHandler',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 140 },
        },
        {
          id: 'node_repo',
          nodeType: 'function',
          name: 'insertTask',
          qualifiedName: 'TaskRepository.insertTask',
          sourceRef: 'packages/storage/src/index.ts',
          symbolId: 'symbol_repo',
          metadata: { lineStart: 240 },
        },
      ],
      edges: [
        {
          id: 'edge_handler_repo',
          edgeType: 'calls',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_repo',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-sequence-task-link');
    expect(stageHtml).toContain('从节点创建任务');
    expect(stageHtml).toContain('按 T 创建任务');
    expect(source).toContain('createGraphSequenceNodeTask');
    expect(source).toContain('onCreateTaskFromNode={props.onCreateTaskFromNode}');
    expect(source).toContain("event.key.toLowerCase() === 't'");
    expect(css).toContain('API 时序图 lifeline 任务入口最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-task-link\s*\{[\s\S]*font-size:\s*9px/);
  });

  it('routes graph-node task creation back to the task list and selects the created task', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('selectCreatedGraphNodeTask');
    expect(source).toContain("setActiveProjectSection('tasks')");
    expect(source).toContain('setTaskDetail(createdTask)');
    expect(source).toContain('setTaskSearchQuery');
    expect(source).toContain('setTaskStatusFilter');
    expect(source).toContain('setTaskTagFilter');
    expect(source).toMatch(/const previousTaskIds = new Set\(snapshot\.tasks\.map\(\(task\) => task\.id\)\)/);
    expect(source).toMatch(/const createdTask = selectCreatedGraphNodeTask\(nextSnapshot,\s*previousTaskIds,\s*activeProjectId\)/);
    expect(source).toMatch(/setTaskEditForm\(\{\s*title: createdTask\.title,/);
  });

  it('keeps graph-node task creation failures visible inside the code graph instead of failing silently', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('graphNodeTaskFeedback');
    expect(source).toContain("setGraphNodeTaskFeedback('creating')");
    expect(source).toContain("setGraphNodeTaskFeedback('failed')");
    expect(source).toContain("setGraphNodeTaskFeedback('created')");
    expect(source).toContain('graphNodeTaskStatusAria');
    expect(source).toContain('graphNodeTaskCreateFailed');
    expect(source).toContain('graph-node-task-status-row');
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(css).toContain('图谱节点任务创建状态最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-node-task-status-row\s*\{[\s\S]*border:\s*1px solid/);
  });

  it('lets users retry the failed graph-node task creation without leaving the graph context', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('lastGraphNodeTaskId');
    expect(source).toContain('setLastGraphNodeTaskId(nodeId)');
    expect(source).toContain('graphNodeTaskTargetId');
    expect(source).toContain('graphNodeTaskRetry');
    expect(source).toContain('graphNodeTaskRetryAria');
    expect(source).toContain('graph-node-task-retry-button');
    expect(source).toMatch(/props\.graphNodeTaskFeedback === 'failed'[\s\S]*props\.graphNodeTaskTargetId/);
    expect(source).toContain('function retryGraphNodeTask');
    expect(source).toContain('if (!props.graphNodeTaskTargetId) return;');
    expect(source).toContain('props.onCreateTaskFromNode?.(props.graphNodeTaskTargetId)');
    expect(source).toContain('onClick={retryGraphNodeTask}');
    expect(css).toContain('图谱节点任务重试入口最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-node-task-retry-button\s*\{[\s\S]*border:\s*1px solid/);
  });

  it('keeps graph source open feedback inside the graph stage instead of failing silently', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('type GraphSourceOpenFeedback');
    expect(source).toContain('graphSourceOpenFeedback');
    expect(source).toContain('openGraphSourceFromCodeMap');
    expect(source).toContain("setGraphSourceOpenFeedback('opening')");
    expect(source).toContain("setGraphSourceOpenFeedback('opened')");
    expect(source).toContain("setGraphSourceOpenFeedback('failed')");
    expect(source).toContain('graphSourceOpenStatusAria');
    expect(source).toContain('graphSourceOpenFailed');
    expect(source).toContain('graph-source-open-status-row');
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('onOpenGraphSource={openGraphSourceFromCodeMap}');
    expect(source).toContain('projectRoot: selectedProject?.localPath');
    expect(source).toContain('props.onOpenGraphSource({ ...source, projectRoot: selectedProject?.localPath })');
    expect(css).toContain('图谱源码打开状态最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-source-open-status-row\s*\{[\s\S]*border:\s*1px solid/);
  });

  it('auto-dismisses graph source open feedback after it settles without hiding the opening state', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('GRAPH_SOURCE_OPEN_FEEDBACK_DISMISS_MS');
    expect(source).toContain('const clearGraphSourceOpenFeedback = window.setTimeout');
    expect(source).toContain("graphSourceOpenFeedback === 'opening'");
    expect(source).toContain("setGraphSourceOpenFeedback('idle')");
    expect(source).toContain('window.clearTimeout(clearGraphSourceOpenFeedback)');
    expect(source).toContain('[graphSourceOpenFeedback]');
  });

  it('auto-dismisses graph-node task success feedback while keeping failed retries visible', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('GRAPH_NODE_TASK_SUCCESS_DISMISS_MS');
    expect(source).toContain('const clearGraphNodeTaskSuccessFeedback = window.setTimeout');
    expect(source).toContain("graphNodeTaskFeedback !== 'created'");
    expect(source).toContain("setGraphNodeTaskFeedback('idle')");
    expect(source).toContain('window.clearTimeout(clearGraphNodeTaskSuccessFeedback)');
    expect(source).toContain('[graphNodeTaskFeedback]');
    expect(source).not.toContain("graphNodeTaskFeedback === 'failed' || graphNodeTaskFeedback === 'created'");
  });

  it('adds activation bars and branch fragments to API sequence diagrams instead of flat message-only lines', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_activation_stage',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'POST /api/tasks',
          qualifiedName: 'POST /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 120 },
        },
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'createTaskHandler',
          qualifiedName: 'createTaskHandler',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 140 },
        },
        {
          id: 'node_guard',
          nodeType: 'control_flow',
          name: 'if payload invalid',
          qualifiedName: 'createTaskHandler.guard',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_guard',
          metadata: { lineStart: 152 },
        },
        {
          id: 'node_repo',
          nodeType: 'function',
          name: 'insertTask',
          qualifiedName: 'TaskRepository.insertTask',
          sourceRef: 'packages/storage/src/index.ts',
          symbolId: 'symbol_repo',
          metadata: { lineStart: 240 },
        },
      ],
      edges: [
        {
          id: 'edge_api_handler',
          edgeType: 'handles',
          sourceNodeId: 'node_api',
          targetNodeId: 'node_handler',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_handler_guard',
          edgeType: 'branches',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_guard',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_handler_repo',
          edgeType: 'calls',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_repo',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const zhHtml = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 4, edgeCount: 3, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const enHtml = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 4, edgeCount: 3, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} initialAppShellSettings={createAppShellSettings('en-US')} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(zhHtml).toContain('graph-sequence-activation');
    expect(zhHtml).toContain('graph-sequence-fragment');
    expect(zhHtml).toContain('graph-sequence-fragment-label');
    expect(zhHtml).toContain('>alt<');
    expect(enHtml).toContain('>alt<');
    expect(source).toContain('buildGraphSequenceFragments');
    expect(css).toContain('API 时序图激活条与分支框最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-activation\s*\{[\s\S]*fill:\s*var\(--zeus-graph-canvas-source-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-fragment\s*\{[\s\S]*stroke-dasharray:\s*6 5/);
  });

  it('renders API sequence fragments with SequenceDiagram-style alt loop and finally semantics instead of one generic branch label', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_semantic_fragments',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_service',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'RepairService.repair',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_service',
          metadata: { lineStart: 88 },
        },
        {
          id: 'node_guard',
          nodeType: 'control_flow',
          name: 'if result == null',
          qualifiedName: 'RepairService.repair.ifResultNull',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_guard',
          metadata: { lineStart: 112 },
        },
        {
          id: 'node_loop',
          nodeType: 'control_flow',
          name: 'while stale batches remain',
          qualifiedName: 'RepairService.repair.loop',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_loop',
          metadata: { lineStart: 130 },
        },
        {
          id: 'node_finally',
          nodeType: 'control_flow',
          name: 'finally release locks',
          qualifiedName: 'RepairService.repair.finally',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_finally',
          metadata: { lineStart: 156 },
        },
      ],
      edges: [
        {
          id: 'edge_alt',
          edgeType: 'branch_false',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_guard',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_loop',
          edgeType: 'loop_back',
          sourceNodeId: 'node_guard',
          targetNodeId: 'node_loop',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_finally',
          edgeType: 'try_finally',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_finally',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 4, edgeCount: 3, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('data-sequence-fragment-kind="alt"');
    expect(stageHtml).toContain('data-sequence-fragment-kind="loop"');
    expect(stageHtml).toContain('data-sequence-fragment-kind="finally"');
    expect(stageHtml).toContain('>alt<');
    expect(stageHtml).toContain('>loop<');
    expect(stageHtml).toContain('>finally<');
    expect(stageHtml).not.toContain('>分支<');
    expect(source).toContain('resolveGraphSequenceFragmentKind');
    expect(source).toContain('formatGraphSequenceFragmentLabel');
    expect(css).toContain('API 时序图语义 fragment 标签最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-fragment-label-box\s*\{[\s\S]*fill:\s*var\(--zeus-graph-canvas-bg\)/);
  });

  it('renders API sequence fragment guard conditions beside UML operators instead of losing branch context', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_fragment_guards',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_service',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'RepairService.repair',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_service',
          metadata: { lineStart: 88 },
        },
        {
          id: 'node_guard',
          nodeType: 'control_flow',
          name: 'if result == null',
          qualifiedName: 'RepairService.repair.ifResultNull',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_guard',
          metadata: { lineStart: 112 },
        },
        {
          id: 'node_loop',
          nodeType: 'control_flow',
          name: 'while stale batches remain',
          qualifiedName: 'RepairService.repair.loop',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_loop',
          metadata: { lineStart: 130 },
        },
      ],
      edges: [
        {
          id: 'edge_alt_guard',
          edgeType: 'branch_true',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_guard',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_loop_guard',
          edgeType: 'loop_back',
          sourceNodeId: 'node_guard',
          targetNodeId: 'node_loop',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('data-sequence-fragment-guard="[result == null]"');
    expect(stageHtml).toContain('data-sequence-fragment-guard="[while stale batches remain]"');
    expect(stageHtml).toContain('graph-sequence-fragment-guard');
    expect(stageHtml).toContain('>[result == null]<');
    expect(stageHtml).toContain('>[while stale batches remain]<');
    expect(source).toContain('formatGraphSequenceFragmentGuard');
    expect(source).toContain('normalizeGraphSequenceGuardText');
    expect(css).toContain('API 时序图 fragment guard 条件最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-fragment-guard\s*\{[\s\S]*fill:\s*var\(--zeus-product-muted\)/);
  });

  it('merges adjacent API sequence alt fragments into one grouped SequenceDiagram frame instead of drawing stacked micro boxes', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_grouped_fragments',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_service',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'RepairService.repair',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_service',
          metadata: { lineStart: 88 },
        },
        {
          id: 'node_null_guard',
          nodeType: 'control_flow',
          name: 'if result == null',
          qualifiedName: 'RepairService.repair.ifResultNull',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_null_guard',
          metadata: { lineStart: 112 },
        },
        {
          id: 'node_clear_guard',
          nodeType: 'control_flow',
          name: 'if clearRedis',
          qualifiedName: 'RepairService.repair.ifClearRedis',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_clear_guard',
          metadata: { lineStart: 132 },
        },
        {
          id: 'node_repo',
          nodeType: 'function',
          name: 'deleteAllStw',
          qualifiedName: 'InvStockChangeRedisRepository.deleteAllStw',
          sourceRef: 'repositories/redis.ts',
          symbolId: 'symbol_repo',
          metadata: { lineStart: 48 },
        },
      ],
      edges: [
        {
          id: 'edge_alt_null',
          edgeType: 'branch_true',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_null_guard',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_alt_clear',
          edgeType: 'branch_false',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_clear_guard',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_call_repo',
          edgeType: 'calls',
          sourceNodeId: 'node_clear_guard',
          targetNodeId: 'node_repo',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 4, edgeCount: 3, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml.match(/data-sequence-fragment-kind="alt"/g)).toHaveLength(1);
    expect(stageHtml).toContain('data-sequence-fragment-edge-count="2"');
    expect(stageHtml).toContain('data-sequence-fragment-guard="[result == null] · [clearRedis]"');
    expect(stageHtml).toContain('>[result == null] · [clearRedis]<');
    expect(source).toContain('mergeGraphSequenceFragments');
    expect(source).toContain('data-sequence-fragment-edge-count');
    expect(css).toContain('API 时序图聚合 fragment 最终覆盖');
  });

  it('renders grouped API sequence alt fragments with operand dividers for each guard branch', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_alt_operands',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_service',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'RepairService.repair',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_service',
          metadata: { lineStart: 88 },
        },
        {
          id: 'node_null_guard',
          nodeType: 'control_flow',
          name: 'if result == null',
          qualifiedName: 'RepairService.repair.ifResultNull',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_null_guard',
          metadata: { lineStart: 112 },
        },
        {
          id: 'node_clear_guard',
          nodeType: 'control_flow',
          name: 'if clearRedis',
          qualifiedName: 'RepairService.repair.ifClearRedis',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_clear_guard',
          metadata: { lineStart: 132 },
        },
      ],
      edges: [
        {
          id: 'edge_alt_null',
          edgeType: 'branch_true',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_null_guard',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_alt_clear',
          edgeType: 'branch_false',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_clear_guard',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-sequence-fragment-operand');
    expect(stageHtml).toContain('data-sequence-fragment-operand-count="2"');
    expect(stageHtml).toContain('data-sequence-fragment-operand="[result == null]"');
    expect(stageHtml).toContain('data-sequence-fragment-operand="[clearRedis]"');
    expect(stageHtml).toContain('>[result == null]<');
    expect(stageHtml).toContain('>[clearRedis]<');
    expect(source).toContain('GraphSequenceFragmentOperand');
    expect(source).toContain('renderGraphSequenceFragmentOperands');
    expect(css).toContain('API 时序图 alt operand 分隔线最终覆盖');
  });

  it('makes each API sequence alt operand keyboard focusable and tied to its own edge inspector target', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_alt_operand_interaction',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_service',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'RepairService.repair',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_service',
          metadata: { lineStart: 88 },
        },
        {
          id: 'node_null_guard',
          nodeType: 'control_flow',
          name: 'if result == null',
          qualifiedName: 'RepairService.repair.ifResultNull',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_null_guard',
          metadata: { lineStart: 112 },
        },
        {
          id: 'node_clear_guard',
          nodeType: 'control_flow',
          name: 'if clearRedis',
          qualifiedName: 'RepairService.repair.ifClearRedis',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_clear_guard',
          metadata: { lineStart: 132 },
        },
      ],
      edges: [
        {
          id: 'edge_alt_null',
          edgeType: 'branch_true',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_null_guard',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_alt_clear',
          edgeType: 'branch_false',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_clear_guard',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('data-sequence-fragment-operand-edge-id="edge_alt_null"');
    expect(stageHtml).toContain('data-sequence-fragment-operand-edge-id="edge_alt_clear"');
    expect(stageHtml).toContain('aria-label="alt 分支 · [result == null]"');
    expect(stageHtml).toContain('aria-label="alt 分支 · [clearRedis]"');
    expect(stageHtml.match(/class="graph-sequence-fragment-operand"/g)).toHaveLength(2);
    expect(stageHtml.match(/role="button"/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(stageHtml.match(/tabindex="0"/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(source).toContain('edgeId: edge.id');
    expect(source).toContain('handleSequenceFragmentOperandKeyDown');
    expect(source).toContain('onSelectEdge?.(operand.edgeId)');
    expect(css).toContain('API 时序图 operand 交互最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-fragment-operand\s*\{[\s\S]*cursor:\s*pointer/);
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-fragment-operand:focus-visible \.graph-sequence-fragment-operand-label\s*\{[\s\S]*fill:\s*var\(--zeus-product-accent\)/);
  });

  it('renders API sequence self calls as folded self-message arrows instead of zero-length lines', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_self_call',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'InvStockChangeStaleBatchStockRepairServiceImpl.repair',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 88 },
        },
        {
          id: 'node_repo',
          nodeType: 'function',
          name: 'setAllStw',
          qualifiedName: 'InvStockChangeRedisRepository.setAllStw',
          sourceRef: 'repositories/redis.ts',
          symbolId: 'symbol_repo',
          metadata: { lineStart: 42 },
        },
      ],
      edges: [
        {
          id: 'edge_self_normalize',
          edgeType: 'calls',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_handler',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_handler_repo',
          edgeType: 'calls',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_repo',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 2, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-sequence-self-message');
    expect(stageHtml).toContain('data-graph-edge-id="edge_self_normalize"');
    expect(stageHtml).toContain('<path');
    expect(stageHtml).not.toContain('x1="84" y1="92" x2="84" y2="92"');
    expect(source).toContain("kind: 'self'");
    expect(css).toContain('API 时序图自调用折返箭头最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-self-message path\s*\{[\s\S]*stroke-dasharray:\s*none/);
  });

  it('renders API sequence return and cleanup messages as dashed return arrows instead of ordinary solid calls', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_return_message',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_service',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'RepairService.repair',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_service',
          metadata: { lineStart: 88 },
        },
        {
          id: 'node_result',
          nodeType: 'function',
          name: 'RepairExecutionResult',
          qualifiedName: 'RepairExecutionResult.empty',
          sourceRef: 'services/result.ts',
          symbolId: 'symbol_result',
          metadata: { lineStart: 12 },
        },
        {
          id: 'node_cleanup',
          nodeType: 'control_flow',
          name: 'finally cleanup',
          qualifiedName: 'RepairService.repair.finally',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_cleanup',
          metadata: { lineStart: 156 },
        },
      ],
      edges: [
        {
          id: 'edge_service_result',
          edgeType: 'calls',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_result',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_result_return',
          edgeType: 'returns',
          sourceNodeId: 'node_result',
          targetNodeId: 'node_service',
          sourceRef: 'services/result.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_service_cleanup',
          edgeType: 'try_finally',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_cleanup',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 3, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-sequence-return-message');
    expect(stageHtml).toContain('data-graph-edge-id="edge_result_return"');
    expect(stageHtml).toContain('data-graph-edge-id="edge_service_cleanup"');
    expect(source).toContain("kind: 'return'");
    expect(source).toContain('isGraphSequenceReturnEdge');
    expect(css).toContain('API 时序图返回虚线消息最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-return-message line\s*\{[\s\S]*stroke-dasharray:\s*7 5/);
  });

  it('makes API sequence message arrows keyboard focusable and tied to the edge inspector', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_edge_interaction',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'POST /api/tasks',
          qualifiedName: 'POST /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 120 },
        },
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'createTaskHandler',
          qualifiedName: 'createTaskHandler',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 140 },
        },
        {
          id: 'node_repo',
          nodeType: 'function',
          name: 'insertTask',
          qualifiedName: 'TaskRepository.insertTask',
          sourceRef: 'packages/storage/src/index.ts',
          symbolId: 'symbol_repo',
          metadata: { lineStart: 240 },
        },
      ],
      edges: [
        {
          id: 'edge_api_handler',
          edgeType: 'handles',
          sourceNodeId: 'node_api',
          targetNodeId: 'node_handler',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
        {
          id: 'edge_handler_repo',
          edgeType: 'calls',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_repo',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('data-graph-edge-id="edge_handler_repo"');
    expect(stageHtml).toContain('aria-label="调用 1.00"');
    expect(stageHtml).toContain('tabindex="0"');
    expect(source).toContain('onSelectEdge={selectGraphEdge}');
    expect(source).toContain('const selectedGraphEdge = visibleEdges.find((edge) => edge.id === selectedGraphEdgeId) ?? visibleEdges[0]');
    expect(css).toContain('API 时序图消息边交互最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-message\s*\{[\s\S]*cursor:\s*pointer/);
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-message:focus-visible line,[\s\S]*\.macos-ai-app \.graph-sequence-self-message:focus-visible path\s*\{[\s\S]*stroke:\s*var\(--zeus-product-accent\)/);
  });

  it('makes API sequence branch fragments keyboard focusable and tied to the edge inspector', () => {
    const graphView: GraphViewSnapshot = {
      id: 'api_sequence_fragment_interaction',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_service',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'RepairService.repair',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_service',
          metadata: { lineStart: 88 },
        },
        {
          id: 'node_guard',
          nodeType: 'control_flow',
          name: 'if clearRedis',
          qualifiedName: 'RepairService.repair.ifClearRedis',
          sourceRef: 'services/repair.ts',
          symbolId: 'symbol_guard',
          metadata: { lineStart: 132 },
        },
      ],
      edges: [
        {
          id: 'edge_alt_clear',
          edgeType: 'branch_true',
          sourceNodeId: 'node_service',
          targetNodeId: 'node_guard',
          sourceRef: 'services/repair.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('data-sequence-fragment-edge-id="edge_alt_clear"');
    expect(stageHtml).toContain('role="button"');
    expect(stageHtml).toContain('tabindex="0"');
    expect(stageHtml).toContain('aria-label="alt · [clearRedis]"');
    expect(source).toContain('edgeIds: [edge.id]');
    expect(source).toContain('handleSequenceFragmentKeyDown');
    expect(source).toContain('props.onSelectEdge?.(fragment.edgeIds[0])');
    expect(css).toContain('API 时序图 fragment 交互最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-fragment\s*\{[\s\S]*cursor:\s*pointer/);
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-fragment:focus-visible rect:first-child\s*\{[\s\S]*stroke:\s*var\(--zeus-product-accent\)/);
  });

  it('marks the current graph inspector object so node and edge details do not look equally active', () => {
    const graphView: GraphViewSnapshot = {
      id: 'graph_current_selection',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'POST /api/tasks',
          qualifiedName: 'POST /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 120 },
        },
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'createTaskHandler',
          qualifiedName: 'createTaskHandler',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 140 },
        },
      ],
      edges: [
        {
          id: 'edge_api_handler',
          edgeType: 'handles',
          sourceNodeId: 'node_api',
          targetNodeId: 'node_handler',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('graph-current-selection-row');
    expect(html).toContain('当前对象');
    expect(html).toContain('current-graph-detail');
    expect(source).toContain("const [selectedGraphSubject, setSelectedGraphSubject] = useState<'node' | 'edge'>('node');");
    expect(source).toContain('const selectGraphNode = (nodeId: string): void => {');
    expect(source).toContain('const selectGraphEdge = (edgeId: string): void => {');
    expect(source).toContain('onSelectNode={selectGraphNode}');
    expect(source).toContain('onSelectEdge={selectGraphEdge}');
    expect(css).toContain('图谱 inspector 当前对象语义最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-detail-workbench\.current-graph-detail\s*\{[\s\S]*border-color:\s*var\(--zeus-product-accent\)/);
  });

  it('mirrors the current graph object onto the canvas instead of making inspector state invisible', () => {
    const graphView: GraphViewSnapshot = {
      id: 'graph_canvas_current_selection',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'POST /api/tasks',
          qualifiedName: 'POST /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 120 },
        },
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'createTaskHandler',
          qualifiedName: 'createTaskHandler',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 140 },
        },
      ],
      edges: [
        {
          id: 'edge_api_handler',
          edgeType: 'handles',
          sourceNodeId: 'node_api',
          targetNodeId: 'node_handler',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stageHtml = html.slice(html.indexOf('project-code-map-stage'), html.indexOf('code-map-secondary-tools'));

    expect(stageHtml).toContain('graph-sequence-lifeline api current-graph-canvas-object');
    expect(stageHtml).not.toContain('graph-sequence-message current-graph-canvas-object');
    expect(source).toContain("currentNodeId={selectedGraphSubject === 'node' ? selectedGraphNode?.id : null}");
    expect(source).toContain("currentEdgeId={selectedGraphSubject === 'edge' ? selectedGraphEdge?.id : null}");
    expect(source).toContain("className={`graph-sequence-lifeline ${node.nodeType}${props.currentNodeId === node.id ? ' current-graph-canvas-object' : ''}`}");
    expect(source).toContain("message.kind === 'self' ? ' graph-sequence-self-message' : ''");
    expect(source).toContain("message.kind === 'return' ? ' graph-sequence-return-message' : ''");
    expect(source).toContain("props.currentEdgeId === edge.id ? ' current-graph-canvas-object' : ''");
    expect(source).toContain("className={`graph-canvas-edge${props.currentEdgeId === edge.id ? ' current-graph-canvas-object' : ''}`}");
    expect(source).toContain("className={`graph-canvas-node ${node.nodeType}${props.currentNodeId === node.id ? ' current-graph-canvas-object' : ''}`}");
    expect(css).toContain('图谱画布当前对象语义最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-lifeline\.current-graph-canvas-object \.graph-sequence-node-box\s*\{[\s\S]*stroke:\s*var\(--zeus-product-accent\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-sequence-message\.current-graph-canvas-object line\s*\{[\s\S]*stroke:\s*var\(--zeus-product-accent\)/);
  });

  it('mirrors the current graph object onto the node and edge source rows instead of leaving lists passive', () => {
    const graphView: GraphViewSnapshot = {
      id: 'graph_entity_current_selection',
      title: '接口时序图',
      viewType: 'api_sequence',
      nodes: [
        {
          id: 'node_api',
          nodeType: 'api',
          name: 'POST /api/tasks',
          qualifiedName: 'POST /api/tasks',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_api',
          metadata: { lineStart: 120 },
        },
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'createTaskHandler',
          qualifiedName: 'createTaskHandler',
          sourceRef: 'packages/local-server/src/index.ts',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 140 },
        },
      ],
      edges: [
        {
          id: 'edge_api_handler',
          edgeType: 'handles',
          sourceNodeId: 'node_api',
          targetNodeId: 'node_handler',
          sourceRef: 'packages/local-server/src/index.ts',
          confidence: 1,
          metadata: {},
        },
      ],
    };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('graph-node-row current-graph-entity-row');
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain('graph-edge-row current-graph-entity-row');
    expect(source).toContain("const isCurrentGraphNodeEntity = selectedGraphSubject === 'node' && selectedGraphNode?.id === node.id;");
    expect(source).toContain("const isCurrentGraphEdgeEntity = selectedGraphSubject === 'edge' && selectedGraphEdge?.id === edge.id;");
    expect(source).toContain("className={`graph-node-row${isCurrentGraphNodeEntity ? ' current-graph-entity-row' : ''}`}");
    expect(source).toContain("className={`graph-edge-row${isCurrentGraphEdgeEntity ? ' current-graph-entity-row' : ''}`}");
    expect(source).toContain("aria-current={isCurrentGraphNodeEntity ? 'true' : undefined}");
    expect(source).toContain("aria-current={isCurrentGraphEdgeEntity ? 'true' : undefined}");
    expect(source).toContain('className="graph-node-copy"');
    expect(source).toContain('className="graph-edge-copy"');
    expect(source).toContain('onClick={() => selectGraphNode(node.id)}');
    expect(source).toContain('onClick={() => selectGraphEdge(edge.id)}');
    expect(css).toContain('图谱来源列表当前对象语义最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-node-row\.current-graph-entity-row,\s*\.macos-ai-app \.graph-edge-row\.current-graph-entity-row\s*\{[\s\S]*background:\s*var\(--zeus-source-list-selected\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(\.graph-node-copy,\s*\.graph-edge-copy\):focus-visible\s*\{[\s\S]*outline:\s*2px solid var\(--zeus-product-accent\)/);
  });

  it('localizes graph node and edge type labels in the Chinese code map instead of leaking raw graph enums', () => {
    const graphView: GraphViewSnapshot = {
      id: 'view_i18n_graph_types',
      title: '方法逻辑图',
      viewType: 'method_logic',
      nodes: [
        {
          id: 'node_handler',
          nodeType: 'function',
          name: 'scanProjectGraph',
          qualifiedName: 'scanProjectGraph',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_handler',
          metadata: { lineStart: 4187 },
        },
        {
          id: 'node_flow',
          nodeType: 'control_flow',
          name: 'await scan',
          qualifiedName: 'scanProjectGraph.awaitScan',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          symbolId: 'symbol_flow',
          metadata: { lineStart: 4192 },
        },
      ],
      edges: [
        {
          id: 'edge_flow',
          edgeType: 'executes',
          sourceNodeId: 'node_handler',
          targetNodeId: 'node_flow',
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          confidence: 1,
          metadata: {},
        },
      ],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={graphView} />);

    expect(html).toContain('scanProjectGraph</strong><span>函数</span>');
    expect(html).toContain('await scan</strong><span>控制流</span>');
    expect(html).toContain('执行 1.00');
    expect(html).toContain('<span>执行</span>');
    expect(html).toContain('await scan · 控制流');
    expect(html).not.toContain('scanProjectGraph</strong><span>function</span>');
    expect(html).not.toContain('await scan</strong><span>control_flow</span>');
    expect(html).not.toContain('executes 1.00');
    expect(html).not.toContain('<span>executes</span>');
    expect(html).not.toContain('await scan · control_flow');
  });

  it('labels method logic diagram export as a sequence preview instead of a generic Mermaid preview', () => {
    const graphView: GraphViewSnapshot = {
      id: 'method_logic_sequence_export_title',
      title: 'Zeus 方法逻辑图',
      viewType: 'method_logic',
      nodes: [
        {
          id: 'node_method',
          nodeType: 'function',
          name: 'repair',
          qualifiedName: 'InventoryRepairService.repair',
          sourceRef: 'packages/inventory/src/repair.ts',
          symbolId: 'symbol_method',
          metadata: { lineStart: 10, lineEnd: 80, sourceHash: 'hash_method' },
        },
        {
          id: 'node_sql',
          nodeType: 'sql_call',
          name: 'SELECT inventory',
          qualifiedName: 'InventoryRepairService.repair#sql',
          sourceRef: 'packages/inventory/src/repair.ts',
          symbolId: 'symbol_sql',
          metadata: { lineStart: 35, lineEnd: 42, sourceHash: 'hash_sql' },
        },
      ],
      edges: [
        {
          id: 'edge_method_sql',
          edgeType: 'executes_sql',
          sourceNodeId: 'node_method',
          targetNodeId: 'node_sql',
          sourceRef: 'packages/inventory/src/repair.ts',
          confidence: 0.92,
        },
      ],
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 2, edgeCount: 1, viewCount: 1 })} initialGraphView={graphView} initialCodeMapSettings={createCodeMapSettings(true)} />);

    expect(html).toContain('Mermaid 时序图预览');
    expect(html).not.toContain('<strong>Mermaid 预览</strong>');
  });

  it('exposes PlantUML as the mature UML source export beside Mermaid', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
    const bridge = readFileSync(new URL('../src/renderer/global.d.ts', import.meta.url), 'utf8');

    expect(source).toContain('buildPlantUmlDiagramSource');
    expect(source).toContain('buildPlantUmlDiagramExport');
    expect(source).toContain('PlantUmlDiagramExportFile');
    expect(source).toContain("useState<'mermaid' | 'plantuml'>('mermaid')");
    expect(source).toContain('graph-diagram-format-switch');
    expect(source).toContain('onExportPlantUmlDiagramFile');
    expect(source).toContain("diagramExportFormat === 'plantuml'");
    expect(main).toContain('exportPlantUmlDiagramToFile');
    expect(bridge).toContain("mimeType: 'text/vnd.plantuml'");
  });

  it('normalizes Mermaid export into a compact source workbench instead of a loose preview card', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('graph-mermaid-workbench');
    expect(source).toContain('graph-mermaid-command-row');
    expect(source).toContain('graph-mermaid-copy');
    expect(source).toContain('graph-mermaid-command-rail');
    expect(source).not.toContain('graph-mermaid-actions');
    expect(css).not.toContain('graph-mermaid-actions');
    expect(source).toContain('graph-mermaid-empty-row');
    expect(source).toContain('graph-mermaid-source-row');
    expect(source).toContain('graph-mermaid-source-preview');
    expect(source).toContain('graph-mermaid-status-row');
    expect(source).not.toContain('<div className="graph-canvas-header">\n              <h3>Mermaid 预览</h3>');
    expect(css).toContain('Mermaid 导出最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.graph-mermaid-command-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.graph-mermaid-source-preview\s*\{[\s\S]*max-block-size:\s*280px/);
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
    expect(html).toContain('buildC · 函数');
    expect(html).not.toContain('buildC · function');
  });
});
