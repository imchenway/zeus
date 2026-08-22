import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { buildMermaidDiagramExport, buildMermaidDiagramSource, buildPlantUmlDiagramExport, buildPlantUmlDiagramSource, type MermaidDiagramExportFile, type PlantUmlDiagramExportFile } from '@zeus/diagram-engine';
import { type AppLanguage } from '../workspace/workspaceCopy.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { buildArchitectureLayerModel, canRenderArchitectureLayerModel } from '../../graph/ArchitectureGraphCanvas.js';
import { type CodeMapSettings, type GraphConversationHistoryItem, type GraphConversationHistoryPage, type GraphNeighborhood, type GraphQuestionAnswer, type GraphSearchResult, type GraphViewSnapshot, type GraphViewType } from '../../apiClient.js';
import { formatGraphConversationStatus, formatGraphEdgeType, formatGraphLayoutAlgorithm, formatGraphMessageSource, formatGraphNodeType, formatGraphNodeTypeList } from '../workspace/workspaceFormatters.js';
import { buildGraphNeighborhoodLayout, buildGraphNeighborhoodSlice, buildGraphNodeActionMenu, buildGraphQuestionRequest, buildGraphSearchRequest, buildVisibleGraphSlice, GraphCanvas, GraphEdgeDetailPanel, type GraphNodeActionMenuItem, GraphNodeDetail, GraphRuntimeCanvas, handleInlineRailKeyboardNavigation, isAggregatedGraphNode, normalizeGraphMinConfidence, resolveGraphCanvasNodeLineStart, resolveGraphCanvasNodeSourceRef } from './GraphCanvas.js';
import { type CodeMapToolPanel, codeMapToolPanels, type DiagramExportFormat, getLanguageCopy, graphEdgeTypeFilterValues, type GraphNodeTaskFeedback, graphNodeTypeFilterValues, type GraphSourceOpenFeedback, graphViewOptions } from '../workspace/workspaceSupport.js';
export function CodeMapView(props: {
  isActive?: boolean;
  graphView: GraphViewSnapshot;
  searchResult?: GraphSearchResult;
  graphAnswer?: GraphQuestionAnswer;
  graphConversations?: GraphConversationHistoryItem[];
  graphConversationPage?: Pick<GraphConversationHistoryPage, 'total' | 'limit' | 'offset' | 'query' | 'archived'>;
  selectedGraphConversation?: GraphConversationHistoryItem;
  graphConversationSearch?: string;
  graphNodeTaskFeedback?: GraphNodeTaskFeedback;
  graphNodeTaskTargetId?: string;
  graphSourceOpenFeedback?: GraphSourceOpenFeedback;
  scanState?: 'idle' | 'scanning' | 'failed';
  onGraphConversationSearchChange?: (query: string) => void;
  onLoadGraphConversations?: (input?: { query?: string; offset?: number; archived?: boolean }) => void;
  onLoadGraphConversation?: (conversationId: string) => void;
  onArchiveGraphConversation?: (conversationId: string) => void;
  onRestoreGraphConversation?: (conversationId: string) => void;
  onCreateTaskFromGraphConversation?: (conversationId: string) => void;
  onLoadView?: (viewType: GraphViewType) => Promise<void>;
  onLoadGraphNeighborhood?: (nodeId: string, depth?: 1 | 2) => Promise<GraphNeighborhood>;
  onSearchGraph?: (query: string, nodeType?: string, edgeType?: string, minConfidence?: number) => void;
  onAskGraph?: (question: string) => void;
  onCreateTaskFromNode?: (nodeId: string) => void;
  onOpenGraphSource?: (source: { sourceRef: string; lineStart?: number }) => void;
  onScanGraph?: () => void;
  onOpenChanges?: () => void;
  onExportMermaidDiagramFile?: (payload: MermaidDiagramExportFile) => Promise<{ saved: boolean; filePath: string | null }>;
  onExportPlantUmlDiagramFile?: (payload: PlantUmlDiagramExportFile) => Promise<{ saved: boolean; filePath: string | null }>;
  codeMapSettings: CodeMapSettings;
  appLanguage: AppLanguage;
}) {
  const uiCopy = getLanguageCopy(props.appLanguage);
  const codeMapCopy = uiCopy.codeMapWorkspace;
  const graphWorkbenchCopy =
    props.appLanguage === 'zh-CN'
      ? {
          viewPicker: '选择图谱视图',
          quickSearch: '搜索节点或关系',
          ask: '询问',
          tools: '图谱工具',
          close: '关闭图谱面板',
          allGraphs: '全部图谱',
          structure: '真实结构',
          scanIdle: '图谱已就绪',
          scanBusy: '正在读取或更新图谱',
          scanFailed: '图谱读取或更新失败',
          currentVisible: '当前可见',
          loadedTotal: '已加载总量',
          relationUnit: '条关系',
          relationGroupUnit: '个关系组',
          nodeUnit: '个节点',
          representedRelations: (count: number) => `表达 ${count} 条原始关系`,
          omittedRelations: (groups: number, relations: number) => `另有 ${groups} 个关系组 / ${relations} 条原始关系未渲染`,
          restoreHidden: '恢复隐藏节点',
          inspectNode: '节点详情',
          inspectEdge: '关系详情',
          focusAll: '全部',
          focusOne: '一跳',
          focusTwo: '两跳',
          focusLabel: '聚焦关系',
          drilldownBack: '返回系统架构图',
          drilldownLoading: (name: string) => `正在生成 ${name} 的节点关系图`,
          drilldownFailed: '节点关系图生成失败，请重试',
          drilldownDepth: '邻域深度',
          drilldownOne: '一跳图',
          drilldownTwo: '两跳图',
          drilldownGraph: '节点关系图',
          openSource: '打开源码',
          askNode: '询问节点',
          createTask: '创建任务',
          hideNode: '隐藏节点',
          rescan: '重新扫描',
          viewChanges: '查看变更',
          toolMenu: '图谱工具菜单',
          canvasHint: '拖动空白处平移，使用控制按钮缩放',
          searchNoMatch: '当前视图没有匹配项，画布已保留原图',
          staticStructure: '静态扫描结构 · 非运行时轨迹',
        }
      : {
          viewPicker: 'Select graph view',
          quickSearch: 'Search nodes or relations',
          ask: 'Ask',
          tools: 'Graph tools',
          close: 'Close graph panel',
          allGraphs: 'All graphs',
          structure: 'Real structure',
          scanIdle: 'Graph ready',
          scanBusy: 'Loading or updating graph',
          scanFailed: 'Graph load or update failed',
          currentVisible: 'Visible',
          loadedTotal: 'Loaded total',
          relationUnit: 'relations',
          relationGroupUnit: 'relation groups',
          nodeUnit: 'nodes',
          representedRelations: (count: number) => `representing ${count} original relation${count === 1 ? '' : 's'}`,
          omittedRelations: (groups: number, relations: number) => `${groups} relation group${groups === 1 ? '' : 's'} / ${relations} original relation${relations === 1 ? '' : 's'} not rendered`,
          restoreHidden: 'Restore hidden nodes',
          inspectNode: 'Node details',
          inspectEdge: 'Relation details',
          focusAll: 'All',
          focusOne: '1 hop',
          focusTwo: '2 hops',
          focusLabel: 'Focus relations',
          drilldownBack: 'Back to system architecture',
          drilldownLoading: (name: string) => `Building the graph around ${name}`,
          drilldownFailed: 'Failed to build the node graph. Try again.',
          drilldownDepth: 'Neighborhood depth',
          drilldownOne: '1-hop graph',
          drilldownTwo: '2-hop graph',
          drilldownGraph: 'Node graph',
          openSource: 'Open source',
          askNode: 'Ask about node',
          createTask: 'Create task',
          hideNode: 'Hide node',
          rescan: 'Rescan',
          viewChanges: 'View changes',
          toolMenu: 'Graph tools menu',
          canvasHint: 'Drag empty canvas to pan and use the controls to zoom',
          searchNoMatch: 'No match in this view; the original graph remains visible',
          staticStructure: 'Static scan structure · not a runtime trace',
        };
  const selectSearchPlaceholder = props.appLanguage === 'zh-CN' ? '搜索选项' : 'Search options';
  const selectNoResults = props.appLanguage === 'zh-CN' ? '没有匹配选项' : 'No matching options';
  const [hiddenNodeIds, setHiddenNodeIds] = useState<string[]>([]);
  const [activeNodeMenuId, setActiveNodeMenuId] = useState<string | null>(null);
  const graphNodeMenuCloseAnimationMs = 120;
  const [closingNodeMenuId, setClosingNodeMenuId] = useState<string | null>(null);
  const graphNodeMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [selectedGraphEdgeId, setSelectedGraphEdgeId] = useState<string | null>(null);
  const [selectedGraphSubject, setSelectedGraphSubject] = useState<'node' | 'edge'>('node');
  const [selectedGraphHopDepth, setSelectedGraphHopDepth] = useState<0 | 1 | 2>(0);
  const [graphDrilldown, setGraphDrilldown] = useState<(GraphNeighborhood & { label: string }) | null>(null);
  const [graphDrilldownStatus, setGraphDrilldownStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [graphDrilldownPendingLabel, setGraphDrilldownPendingLabel] = useState('');
  const [graphDrilldownPendingTarget, setGraphDrilldownPendingTarget] = useState<{ nodeId: string; depth: 1 | 2; label: string } | null>(null);
  const graphDrilldownRequestVersionRef = useRef(0);
  const [showMermaidPreview, setShowMermaidPreview] = useState(false);
  const [diagramExportFormat, setDiagramExportFormat] = useState<'mermaid' | 'plantuml'>('mermaid');
  const [lastMermaidExport, setLastMermaidExport] = useState<ReturnType<typeof buildMermaidDiagramExport> | ReturnType<typeof buildPlantUmlDiagramExport> | null>(null);
  const [mermaidExportStatus, setMermaidExportStatus] = useState<string | null>(null);
  const [graphSearchQuery, setGraphSearchQuery] = useState('');
  const [graphQuestionInput, setGraphQuestionInput] = useState('');
  const [graphNodeTypeFilter, setGraphNodeTypeFilter] = useState('');
  const [graphEdgeTypeFilter, setGraphEdgeTypeFilter] = useState('');
  const [activeGraphTool, setActiveGraphTool] = useState<CodeMapToolPanel | null>(null);
  const [graphToolMenuOpen, setGraphToolMenuOpen] = useState(false);
  const [graphMinConfidence, setGraphMinConfidence] = useState(props.codeMapSettings.showLowConfidenceEdges ? 0 : 1);
  const [isCompactGraphWorkbench, setIsCompactGraphWorkbench] = useState(false);
  const codeMapWorkbenchRef = useRef<HTMLElement | null>(null);
  const graphQuickSearchRef = useRef<HTMLInputElement | null>(null);
  const graphToolMenuRef = useRef<HTMLDivElement | null>(null);
  const graphOverlayRef = useRef<HTMLElement | null>(null);
  const graphOverlayCloseRef = useRef<HTMLButtonElement | null>(null);
  const graphToolTriggerRef = useRef<HTMLButtonElement | null>(null);
  const graphOverlayReturnFocusRef = useRef<HTMLElement | SVGElement | null>(null);
  const graphNodeTaskStatusText =
    props.graphNodeTaskFeedback === 'creating'
      ? codeMapCopy.graphNodeTaskCreating
      : props.graphNodeTaskFeedback === 'created'
        ? codeMapCopy.graphNodeTaskCreated
        : props.graphNodeTaskFeedback === 'failed'
          ? codeMapCopy.graphNodeTaskCreateFailed
          : null;
  const graphSourceOpenStatusText =
    props.graphSourceOpenFeedback === 'opening'
      ? codeMapCopy.graphSourceOpenOpening
      : props.graphSourceOpenFeedback === 'opened'
        ? codeMapCopy.graphSourceOpenOpened
        : props.graphSourceOpenFeedback === 'failed'
          ? codeMapCopy.graphSourceOpenFailed
          : null;

  function retryGraphNodeTask(): void {
    if (!props.graphNodeTaskTargetId) return;
    props.onCreateTaskFromNode?.(props.graphNodeTaskTargetId);
  }

  const filteredGraph = useMemo(() => {
    const hiddenIds = new Set(hiddenNodeIds);
    const minConfidence = normalizeGraphMinConfidence(graphMinConfidence, props.codeMapSettings.showLowConfidenceEdges ? 0 : 1);
    const nodes = props.graphView.nodes.filter((node) => !hiddenIds.has(node.id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = props.graphView.edges.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId) && edge.confidence >= minConfidence);
    return { nodes, edges };
  }, [graphMinConfidence, hiddenNodeIds, props.codeMapSettings.showLowConfidenceEdges, props.graphView.edges, props.graphView.nodes]);
  const searchedGraph = useMemo(() => {
    if (!props.searchResult) return { ...filteredGraph, hasMatches: true };
    const resultNodeIds = new Set(props.searchResult.nodes.map((node) => node.id));
    const resultEdgeIds = new Set(props.searchResult.edges.map((edge) => edge.id));
    const edges = filteredGraph.edges.filter((edge) => resultEdgeIds.has(edge.id));
    const matchedNodeIds = new Set(resultNodeIds);
    for (const edge of edges) {
      matchedNodeIds.add(edge.sourceNodeId);
      matchedNodeIds.add(edge.targetNodeId);
    }
    const nodes = filteredGraph.nodes.filter((node) => matchedNodeIds.has(node.id));
    const hasMatches = nodes.length > 0 || edges.length > 0;
    // 项目级搜索结果必须先和当前视图求交；零命中时保留原图，并在画布上下文明确反馈。
    return hasMatches ? { nodes, edges, hasMatches } : { ...filteredGraph, hasMatches };
  }, [filteredGraph, props.searchResult]);
  const drilldownFilteredGraph = useMemo(() => {
    if (!graphDrilldown) return null;
    const hiddenIds = new Set(hiddenNodeIds);
    const minConfidence = normalizeGraphMinConfidence(graphMinConfidence, props.codeMapSettings.showLowConfidenceEdges ? 0 : 1);
    const nodes = graphDrilldown.nodes.filter((node) => !hiddenIds.has(node.id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = graphDrilldown.edges.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId) && edge.confidence >= minConfidence);
    return { nodes, edges };
  }, [graphDrilldown, graphMinConfidence, hiddenNodeIds, props.codeMapSettings.showLowConfidenceEdges]);
  const searchResultHasCurrentMatches = graphDrilldown || !props.searchResult ? true : searchedGraph.hasMatches;
  const activeGraphScope = drilldownFilteredGraph ?? filteredGraph;
  const defaultVisibleGraph = drilldownFilteredGraph ?? { nodes: searchedGraph.nodes, edges: searchedGraph.edges };
  const focusedGraph = useMemo(
    () =>
      selectedGraphNodeId && selectedGraphHopDepth > 0
        ? buildGraphNeighborhoodSlice({
            nodes: activeGraphScope.nodes,
            edges: activeGraphScope.edges,
            centerNodeId: selectedGraphNodeId,
            depth: selectedGraphHopDepth as 1 | 2,
          })
        : defaultVisibleGraph,
    [activeGraphScope.edges, activeGraphScope.nodes, defaultVisibleGraph, selectedGraphHopDepth, selectedGraphNodeId],
  );
  const visibleGraph = useMemo(
    () =>
      buildVisibleGraphSlice({
        nodes: focusedGraph.nodes,
        edges: focusedGraph.edges,
        hiddenNodeIds: [],
        maxNodes: graphDrilldown ? 18 : 24,
        maxEdges: 80,
        showLowConfidenceEdges: true,
        minConfidence: 0,
      }),
    [focusedGraph.edges, focusedGraph.nodes, graphDrilldown],
  );
  const { nodes: visibleNodes, edges: visibleEdges, stats: visibleGraphStats } = visibleGraph;
  const architectureLayerModel = useMemo(
    () => (!graphDrilldown && props.graphView.viewType === 'architecture' ? buildArchitectureLayerModel(visibleNodes, visibleEdges, props.graphView.title) : null),
    [graphDrilldown, props.graphView.title, props.graphView.viewType, visibleEdges, visibleNodes],
  );
  const visibleArchitectureModel = architectureLayerModel && canRenderArchitectureLayerModel(architectureLayerModel) ? architectureLayerModel : null;
  const graphDrilldownLayout = useMemo(() => (graphDrilldown ? buildGraphNeighborhoodLayout(graphDrilldown.centerNode.id, visibleNodes, visibleEdges) : undefined), [graphDrilldown, visibleEdges, visibleNodes]);
  const inspectorGraphView = useMemo(
    () => ({
      ...props.graphView,
      title: graphDrilldown ? `${graphDrilldown.label} · ${graphWorkbenchCopy.drilldownGraph}` : props.graphView.title,
      viewType: graphDrilldown ? 'module_detail' : props.graphView.viewType,
      layout: graphDrilldownLayout ?? props.graphView.layout,
      nodes: activeGraphScope.nodes,
      edges: activeGraphScope.edges,
    }),
    [activeGraphScope.edges, activeGraphScope.nodes, graphDrilldown, graphDrilldownLayout, graphWorkbenchCopy.drilldownGraph, props.graphView],
  );
  const selectedGraphNode = visibleNodes.find((node) => node.id === selectedGraphNodeId);
  const selectedGraphEdge = visibleEdges.find((edge) => edge.id === selectedGraphEdgeId);
  const selectedGraphEdgeSource = selectedGraphEdge ? visibleNodes.find((node) => node.id === selectedGraphEdge.sourceNodeId) : null;
  const selectedGraphEdgeTarget = selectedGraphEdge ? visibleNodes.find((node) => node.id === selectedGraphEdge.targetNodeId) : null;
  const selectedGraphCurrentTarget =
    selectedGraphSubject === 'edge' && selectedGraphEdge ? `${selectedGraphEdgeSource?.name ?? selectedGraphEdge.sourceNodeId} → ${selectedGraphEdgeTarget?.name ?? selectedGraphEdge.targetNodeId}` : (selectedGraphNode?.name ?? '');

  useEffect(() => {
    graphDrilldownRequestVersionRef.current += 1;
    setGraphDrilldown(null);
    setGraphDrilldownStatus('idle');
    setGraphDrilldownPendingLabel('');
    setGraphDrilldownPendingTarget(null);
    setSelectedGraphNodeId(null);
    setSelectedGraphEdgeId(null);
    setSelectedGraphHopDepth(0);
  }, [props.graphView.id, props.graphView.viewType]);

  const conversationPage = props.graphConversationPage ?? {
    total: props.graphConversations?.length ?? 0,
    limit: 5,
    offset: 0,
    query: null,
    archived: false,
  };
  const nextOffset = conversationPage.offset + conversationPage.limit;
  const previousOffset = Math.max(0, conversationPage.offset - conversationPage.limit);
  const selectedConversation = props.selectedGraphConversation ?? props.graphConversations?.[0];
  const isSequenceDiagramExportView = props.graphView.viewType === 'api_sequence' || props.graphView.viewType === 'method_logic';
  const shouldRenderRuntimeGraph = activeGraphTool === 'runtime' && (props.isActive || typeof window === 'undefined') && !isSequenceDiagramExportView;
  const graphQaModeItems = [
    {
      label: codeMapCopy.currentView,
      value: graphDrilldown ? `${graphDrilldown.label} · ${graphWorkbenchCopy.drilldownGraph}` : (uiCopy.graphViewTypes[props.graphView.viewType as GraphViewType] ?? props.graphView.viewType),
    },
    {
      label: codeMapCopy.realNodes,
      value: `${visibleNodes.length} / ${activeGraphScope.nodes.length}`,
    },
    {
      label: codeMapCopy.realEdges,
      value: `${visibleGraphStats.representedEdgeCount} / ${activeGraphScope.edges.length}`,
    },
    {
      label: codeMapCopy.runtimeSessionLabel,
      value: props.graphAnswer?.sessionId ?? codeMapCopy.insufficientRuntimeSession,
    },
  ];

  const diagramExportFormatLabel = diagramExportFormat === 'plantuml' ? 'PlantUML' : 'Mermaid';
  const diagramPreviewTitle = isSequenceDiagramExportView
    ? diagramExportFormat === 'plantuml'
      ? codeMapCopy.plantUmlSequencePreviewTitle
      : codeMapCopy.mermaidSequencePreviewTitle
    : diagramExportFormat === 'plantuml'
      ? codeMapCopy.plantUmlPreviewTitle
      : codeMapCopy.mermaidPreviewTitle;
  const buildVisibleDiagramSource = (format: DiagramExportFormat): string => {
    const input = {
      viewType: graphDrilldown ? 'module_detail' : props.graphView.viewType,
      nodes: visibleNodes,
      edges: visibleEdges,
    };
    // PlantUML 走成熟 UML 工具链源码格式；Mermaid 保留轻量文本预览，两者都只使用当前真实可见节点和边。
    return format === 'plantuml' ? buildPlantUmlDiagramSource(input) : buildMermaidDiagramSource(input);
  };
  function buildVisibleDiagramExport(format: 'plantuml'): PlantUmlDiagramExportFile;
  function buildVisibleDiagramExport(format: 'mermaid'): MermaidDiagramExportFile;
  function buildVisibleDiagramExport(format: DiagramExportFormat): MermaidDiagramExportFile | PlantUmlDiagramExportFile {
    const source = buildVisibleDiagramSource(format);
    const input = {
      viewTitle: graphDrilldown ? `${graphDrilldown.label} · ${graphWorkbenchCopy.drilldownGraph}` : props.graphView.title,
      viewType: graphDrilldown ? 'module_detail' : props.graphView.viewType,
      generatedAt: new Date().toISOString(),
      source,
    };
    return format === 'plantuml' ? buildPlantUmlDiagramExport(input) : buildMermaidDiagramExport(input);
  }

  function toggleNodeVisibility(nodeId: string): void {
    setHiddenNodeIds((current) => (current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId]));
  }

  function findGraphObjectElement(kind: 'node' | 'edge', id: string | null): HTMLElement | SVGElement | null {
    if (!id) return null;
    const attribute = `data-graph-${kind}-id`;
    const candidates = codeMapWorkbenchRef.current?.querySelectorAll<HTMLElement | SVGElement>(`[${attribute}]`) ?? [];
    return Array.from(candidates).find((candidate) => candidate.getAttribute(attribute) === id) ?? null;
  }

  function restoreGraphObjectFocus(kind: 'node' | 'edge', id: string | null): void {
    const target = findGraphObjectElement(kind, id);
    window.requestAnimationFrame(() => target?.focus());
  }

  function closeGraphInspector(options?: { restoreFocus?: boolean }): void {
    const nodeId = selectedGraphNodeId;
    const edgeId = selectedGraphEdgeId;
    const subject = selectedGraphSubject;
    setSelectedGraphNodeId(null);
    setSelectedGraphEdgeId(null);
    setSelectedGraphHopDepth(0);
    if (options?.restoreFocus) restoreGraphObjectFocus(subject, subject === 'node' ? nodeId : edgeId);
  }

  function leaveGraphDrilldown(): void {
    graphDrilldownRequestVersionRef.current += 1;
    setGraphDrilldown(null);
    setGraphDrilldownStatus('idle');
    setGraphDrilldownPendingLabel('');
    setGraphDrilldownPendingTarget(null);
    closeGraphInspector();
  }

  async function openGraphDrilldown(nodeId: string, depth: 1 | 2, label: string): Promise<void> {
    if (!props.onLoadGraphNeighborhood) {
      selectGraphNode(nodeId);
      return;
    }
    const requestVersion = ++graphDrilldownRequestVersionRef.current;
    closeGraphInspector();
    setActiveGraphTool(null);
    setGraphToolMenuOpen(false);
    setGraphDrilldownPendingLabel(label);
    setGraphDrilldownPendingTarget({ nodeId, depth, label });
    setGraphDrilldownStatus('loading');
    try {
      const neighborhood = await props.onLoadGraphNeighborhood(nodeId, depth);
      if (requestVersion !== graphDrilldownRequestVersionRef.current) return;
      setGraphDrilldown({
        ...neighborhood,
        depth,
        label,
      });
      setGraphDrilldownStatus('idle');
      setGraphDrilldownPendingTarget(null);
    } catch {
      if (requestVersion !== graphDrilldownRequestVersionRef.current) return;
      setGraphDrilldownStatus('failed');
    }
  }

  function closeGraphTool(options?: { restoreFocus?: boolean }): void {
    setActiveGraphTool(null);
    if (options?.restoreFocus) {
      const target = graphOverlayReturnFocusRef.current;
      window.requestAnimationFrame(() => target?.focus());
    }
  }

  function openGraphTool(tool: CodeMapToolPanel, trigger?: HTMLElement | SVGElement | null): void {
    if (trigger) graphOverlayReturnFocusRef.current = trigger;
    else if (!graphOverlayReturnFocusRef.current && graphToolTriggerRef.current) graphOverlayReturnFocusRef.current = graphToolTriggerRef.current;
    closeGraphInspector();
    setGraphToolMenuOpen(false);
    setActiveGraphTool(tool);
  }

  function toggleGraphToolMenu(trigger: HTMLButtonElement): void {
    graphOverlayReturnFocusRef.current = trigger;
    setGraphToolMenuOpen((current) => !current);
  }

  function runQuickGraphSearch(): void {
    leaveGraphDrilldown();
    closeGraphInspector();
    const request = buildGraphSearchRequest({
      query: graphSearchQuery,
      nodeType: graphNodeTypeFilter,
      edgeType: graphEdgeTypeFilter,
      minConfidence: graphMinConfidence,
    });
    props.onSearchGraph?.(request.query, request.nodeType, request.edgeType, request.minConfidence);
  }

  const selectGraphNode = (nodeId: string): void => {
    // 节点与边详情互斥，默认不保留过期对象，保证详情面板只解释当前主动选择。
    setActiveGraphTool(null);
    setGraphToolMenuOpen(false);
    setSelectedGraphNodeId(nodeId);
    setSelectedGraphEdgeId(null);
    setSelectedGraphSubject('node');
    setSelectedGraphHopDepth(0);
  };

  const selectPrimaryGraphNode = (nodeId: string): void => {
    if (props.graphView.viewType !== 'architecture' || graphDrilldown) {
      selectGraphNode(nodeId);
      return;
    }
    const workload = visibleArchitectureModel?.workloads.find((item) => item.primaryNode.id === nodeId || item.module?.id === nodeId || item.application?.id === nodeId);
    const selectedNode = visibleNodes.find((node) => node.id === nodeId);
    // 架构卡片把模块与启动入口合并展示；下钻以模块为中心，才能得到包含父级、入口和依赖的真实邻域，而不是只剩一条 contains 关系。
    const centerNodeId = workload?.module?.id ?? nodeId;
    const label = workload?.application?.name ?? workload?.label ?? selectedNode?.name ?? nodeId;
    void openGraphDrilldown(centerNodeId, 2, label);
  };

  const selectGraphEdge = (edgeId: string): void => {
    setActiveGraphTool(null);
    setGraphToolMenuOpen(false);
    setSelectedGraphNodeId(null);
    setSelectedGraphEdgeId(edgeId);
    setSelectedGraphSubject('edge');
    setSelectedGraphHopDepth(0);
  };

  function clearGraphNodeMenuCloseTimer(): void {
    if (!graphNodeMenuCloseTimerRef.current) return;
    clearTimeout(graphNodeMenuCloseTimerRef.current);
    graphNodeMenuCloseTimerRef.current = null;
  }

  function openGraphNodeMenu(nodeId: string): void {
    clearGraphNodeMenuCloseTimer();
    setClosingNodeMenuId(null);
    setActiveNodeMenuId(nodeId);
  }

  const closeGraphNodeMenu = () => setActiveNodeMenuId(null);
  function closeGraphNodeMenuWithMotion(): void {
    if (!activeNodeMenuId) return;
    const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    clearGraphNodeMenuCloseTimer();
    if (prefersReducedMotion) {
      setClosingNodeMenuId(null);
      closeGraphNodeMenu();
      return;
    }
    // 图谱节点菜单属于轻量 popover，关闭时保留一小段退出动画，避免菜单像异常消失一样闪断。
    setClosingNodeMenuId(activeNodeMenuId);
    closeGraphNodeMenu();
    graphNodeMenuCloseTimerRef.current = setTimeout(() => {
      setClosingNodeMenuId(null);
      graphNodeMenuCloseTimerRef.current = null;
    }, graphNodeMenuCloseAnimationMs);
  }

  function toggleGraphNodeMenu(nodeId: string): void {
    if (activeNodeMenuId === nodeId) {
      closeGraphNodeMenuWithMotion();
      return;
    }
    openGraphNodeMenu(nodeId);
  }

  const handleGraphNodeMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeGraphNodeMenuWithMotion();
  };
  useEffect(
    () => () => {
      clearGraphNodeMenuCloseTimer();
    },
    [],
  );
  useEffect(() => {
    const closeGraphNodeMenuOnOutsidePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.graph-node-row')) return;
      closeGraphNodeMenuWithMotion();
    };
    document.addEventListener('pointerdown', closeGraphNodeMenuOnOutsidePointerDown, true);
    return () => document.removeEventListener('pointerdown', closeGraphNodeMenuOnOutsidePointerDown, true);
  }, [activeNodeMenuId]);
  useEffect(() => {
    const compactQuery = window.matchMedia('(max-width: 760px)');
    const syncCompactState = () => setIsCompactGraphWorkbench(compactQuery.matches);
    syncCompactState();
    compactQuery.addEventListener('change', syncCompactState);
    return () => compactQuery.removeEventListener('change', syncCompactState);
  }, []);
  useEffect(() => {
    closeGraphInspector();
    setHiddenNodeIds([]);
    setGraphSearchQuery('');
    setGraphNodeTypeFilter('');
    setGraphEdgeTypeFilter('');
    setActiveGraphTool(null);
    setGraphToolMenuOpen(false);
    setActiveNodeMenuId(null);
  }, [props.graphView.viewType]);
  useEffect(() => {
    if (!props.isActive) return undefined;
    const focusGraphSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      if (isCompactGraphWorkbench) {
        const returnTarget = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : graphToolTriggerRef.current;
        openGraphTool('search', returnTarget);
        return;
      }
      graphQuickSearchRef.current?.focus();
      graphQuickSearchRef.current?.select();
    };
    document.addEventListener('keydown', focusGraphSearch);
    return () => document.removeEventListener('keydown', focusGraphSearch);
  }, [isCompactGraphWorkbench, props.isActive]);
  useEffect(() => {
    if (!graphToolMenuOpen) return undefined;
    const focusFrame = window.requestAnimationFrame(() => {
      graphToolMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [graphToolMenuOpen]);
  useEffect(() => {
    if (!activeGraphTool && !selectedGraphNode && !selectedGraphEdge) return;
    const focusOverlay = window.requestAnimationFrame(() => {
      if (isCompactGraphWorkbench) {
        if (activeGraphTool === 'search') {
          graphOverlayRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
          return;
        }
        graphOverlayCloseRef.current?.focus();
        return;
      }
      if (activeGraphTool) {
        graphOverlayRef.current?.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])')?.focus();
      }
    });
    return () => window.cancelAnimationFrame(focusOverlay);
  }, [activeGraphTool, isCompactGraphWorkbench, selectedGraphEdge, selectedGraphNode]);

  const handleGraphWorkbenchKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      if (graphToolMenuOpen) {
        event.preventDefault();
        setGraphToolMenuOpen(false);
        graphToolTriggerRef.current?.focus();
        return;
      }
      if (activeGraphTool) {
        event.preventDefault();
        closeGraphTool({ restoreFocus: true });
        return;
      }
      if (selectedGraphNode || selectedGraphEdge) {
        event.preventDefault();
        closeGraphInspector({ restoreFocus: true });
      }
      return;
    }
  };

  const handleGraphWorkbenchPointerDownCapture = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!graphToolMenuOpen || !(event.target instanceof Node)) return;
    if (graphToolMenuRef.current?.contains(event.target) || graphToolTriggerRef.current?.contains(event.target)) return;
    // 点击工作台其他区域时关闭菜单，并把焦点留给用户刚刚点击的目标。
    setGraphToolMenuOpen(false);
  };

  const handleGraphToolMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setGraphToolMenuOpen(false);
      graphToolTriggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (items.length === 0) return;
    const currentIndex = Math.max(
      0,
      items.findIndex((item) => item === document.activeElement),
    );
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (currentIndex + 1) % items.length : (currentIndex - 1 + items.length) % items.length;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  function runNodeAction(node: GraphViewSnapshot['nodes'][number], action: GraphNodeActionMenuItem): void {
    if (action.id === 'inspect-detail') {
      selectGraphNode(node.id);
      setSelectedGraphHopDepth(0);
    }
    if (action.id === 'create-task') props.onCreateTaskFromNode?.(node.id);
    if (action.id === 'open-source')
      props.onOpenGraphSource?.({
        sourceRef: action.sourceRef,
        lineStart: action.lineStart ?? undefined,
      });
    if (action.id === 'ask-node') {
      const request = buildGraphQuestionRequest(codeMapCopy.explainNodeQuestion(node.qualifiedName, node.sourceRef));
      if (request.canAsk) props.onAskGraph?.(request.question);
    }
    if (action.id === 'generate-sequence' || action.id === 'generate-flow') {
      selectGraphNode(node.id);
      setShowMermaidPreview(true);
    }
    if (action.id === 'expand-one-hop') {
      selectGraphNode(node.id);
      setSelectedGraphHopDepth(1);
    }
    if (action.id === 'expand-two-hop') {
      selectGraphNode(node.id);
      setSelectedGraphHopDepth(2);
    }
    if (action.id === 'toggle-visibility') toggleNodeVisibility(node.id);
    closeGraphNodeMenuWithMotion();
  }

  const scanStatusCopy = props.scanState === 'scanning' ? graphWorkbenchCopy.scanBusy : props.scanState === 'failed' ? graphWorkbenchCopy.scanFailed : graphWorkbenchCopy.scanIdle;
  const inspectorOpen = Boolean(selectedGraphNode || selectedGraphEdge);

  return (
    <section
      ref={codeMapWorkbenchRef}
      className="code-map-view code-map-workbench code-map-graph-first"
      aria-label={codeMapCopy.viewAria}
      onKeyDown={handleGraphWorkbenchKeyDown}
      onPointerDownCapture={handleGraphWorkbenchPointerDownCapture}
    >
      <header className="code-map-command-bar" aria-label={codeMapCopy.viewSwitcherAria}>
        <ZeusSelect<GraphViewType>
          size="compact"
          className="code-map-view-picker"
          ariaLabel={graphWorkbenchCopy.viewPicker}
          value={props.graphView.viewType as GraphViewType}
          onChange={(viewType) => {
            setGraphToolMenuOpen(false);
            leaveGraphDrilldown();
            void props.onLoadView?.(viewType);
          }}
          searchable={false}
          searchPlaceholder={selectSearchPlaceholder}
          emptyLabel={selectNoResults}
          options={graphViewOptions.map((option) => ({
            value: option.type,
            label: uiCopy.graphViewTypes[option.type],
          }))}
        />
        <label className="code-map-quick-search">
          <MagnifyingGlass aria-hidden="true" weight="regular" />
          <input
            ref={graphQuickSearchRef}
            type="search"
            aria-label={graphWorkbenchCopy.quickSearch}
            placeholder={`${graphWorkbenchCopy.quickSearch}…`}
            value={graphSearchQuery}
            disabled={props.scanState === 'scanning'}
            onChange={(event) => setGraphSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              runQuickGraphSearch();
            }}
          />
          <kbd>⌘F</kbd>
        </label>
        <span className={`code-map-scan-state ${props.scanState ?? 'idle'}`} role="status" aria-live="polite">
          <i aria-hidden="true" />
          {scanStatusCopy}
        </span>
        <span className="code-map-command-actions">
          <button
            type="button"
            disabled={props.scanState === 'scanning'}
            onClick={(event) => {
              graphOverlayReturnFocusRef.current = event.currentTarget;
              openGraphTool('qa', event.currentTarget);
            }}
          >
            {graphWorkbenchCopy.ask}
          </button>
          <button
            ref={graphToolTriggerRef}
            type="button"
            aria-expanded={graphToolMenuOpen}
            aria-haspopup="menu"
            onClick={(event) => {
              // 统一走 click，避免辅助技术同时合成 pointer 与 click 时把菜单连续开关两次。
              toggleGraphToolMenu(event.currentTarget);
            }}
          >
            {graphWorkbenchCopy.tools}
          </button>
        </span>
        {graphToolMenuOpen ? (
          <div ref={graphToolMenuRef} className="code-map-tool-menu" role="menu" aria-label={graphWorkbenchCopy.toolMenu} onKeyDown={handleGraphToolMenuKeyDown}>
            {codeMapToolPanels.map((tool) => (
              <button key={tool.id} type="button" role="menuitem" onClick={() => openGraphTool(tool.id, graphToolTriggerRef.current)}>
                <strong>{codeMapCopy.tools[tool.id].label}</strong>
                <small>{codeMapCopy.tools[tool.id].description}</small>
              </button>
            ))}
            <span className="code-map-tool-menu-separator" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              disabled={!props.onScanGraph || props.scanState === 'scanning'}
              onClick={() => {
                setGraphToolMenuOpen(false);
                props.onScanGraph?.();
              }}
            >
              <strong>{graphWorkbenchCopy.rescan}</strong>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!props.onOpenChanges}
              onClick={() => {
                setGraphToolMenuOpen(false);
                props.onOpenChanges?.();
              }}
            >
              <strong>{graphWorkbenchCopy.viewChanges}</strong>
            </button>
          </div>
        ) : null}
      </header>

      <div className="code-map-primary-grid" aria-label={codeMapCopy.primaryGridAria} data-overlay-open={inspectorOpen || Boolean(activeGraphTool) ? 'true' : 'false'}>
        <section className="code-map-stage-surface" aria-label={codeMapCopy.stageAria}>
          <header className="code-map-canvas-context">
            <span>
              {graphDrilldown ? (
                <>
                  <button type="button" className="code-map-breadcrumb-button" onClick={leaveGraphDrilldown}>
                    {uiCopy.graphViewTypes.architecture}
                  </button>
                  <i aria-hidden="true">/</i>
                  <strong>{graphDrilldown.label}</strong>
                </>
              ) : (
                <>
                  <strong>{graphWorkbenchCopy.allGraphs}</strong>
                  <i aria-hidden="true">/</i>
                  <span>{uiCopy.graphViewTypes[props.graphView.viewType as GraphViewType] ?? props.graphView.title}</span>
                </>
              )}
            </span>
            <span>
              {graphDrilldown ? (
                <span className="code-map-drilldown-depth" aria-label={graphWorkbenchCopy.drilldownDepth}>
                  {([1, 2] as const).map((depth) => (
                    <button
                      key={depth}
                      type="button"
                      aria-pressed={graphDrilldown.depth === depth}
                      disabled={graphDrilldownStatus === 'loading'}
                      onClick={() => void openGraphDrilldown(graphDrilldown.centerNode.id, depth, graphDrilldown.label)}
                    >
                      {depth === 1 ? graphWorkbenchCopy.drilldownOne : graphWorkbenchCopy.drilldownTwo}
                    </button>
                  ))}
                </span>
              ) : null}
              {props.searchResult && !searchResultHasCurrentMatches ? (
                <em className="code-map-search-feedback" role="status">
                  {graphWorkbenchCopy.searchNoMatch}
                </em>
              ) : null}
              {visibleArchitectureModel ? (
                <>
                  {graphWorkbenchCopy.currentVisible} {visibleArchitectureModel.objectCount} {props.appLanguage === 'zh-CN' ? '个架构对象' : 'architecture objects'} · {visibleArchitectureModel.dependencyEdges.length}{' '}
                  {props.appLanguage === 'zh-CN' ? '条依赖' : 'dependencies'}
                </>
              ) : (
                <>
                  {graphWorkbenchCopy.currentVisible} {visibleNodes.length} {graphWorkbenchCopy.nodeUnit} · {visibleEdges.length} {graphWorkbenchCopy.relationGroupUnit} ·{' '}
                  {graphWorkbenchCopy.representedRelations(visibleGraphStats.representedEdgeCount)}
                </>
              )}
              {hiddenNodeIds.length > 0 ? (
                <button type="button" onClick={() => setHiddenNodeIds([])}>
                  {graphWorkbenchCopy.restoreHidden} ({hiddenNodeIds.length})
                </button>
              ) : null}
            </span>
          </header>
          {graphDrilldownStatus !== 'idle' ? (
            <section className={`code-map-drilldown-status ${graphDrilldownStatus}`} role="status" aria-live="polite">
              <span>{graphDrilldownStatus === 'loading' ? graphWorkbenchCopy.drilldownLoading(graphDrilldownPendingLabel) : graphWorkbenchCopy.drilldownFailed}</span>
              {graphDrilldownStatus === 'failed' ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!graphDrilldownPendingTarget) return;
                    void openGraphDrilldown(graphDrilldownPendingTarget.nodeId, graphDrilldownPendingTarget.depth, graphDrilldownPendingTarget.label);
                  }}
                >
                  {props.appLanguage === 'zh-CN' ? '重试' : 'Retry'}
                </button>
              ) : null}
            </section>
          ) : null}
          {graphNodeTaskStatusText ? (
            <section className={`graph-node-task-status-row ${props.graphNodeTaskFeedback}`} role="status" aria-live="polite" aria-label={codeMapCopy.graphNodeTaskStatusAria}>
              <span>{graphNodeTaskStatusText}</span>
              {props.graphNodeTaskFeedback === 'failed' && props.graphNodeTaskTargetId ? (
                <button type="button" className="graph-node-task-retry-button" aria-label={codeMapCopy.graphNodeTaskRetryAria} onClick={retryGraphNodeTask}>
                  {codeMapCopy.graphNodeTaskRetry}
                </button>
              ) : null}
            </section>
          ) : null}
          {graphSourceOpenStatusText ? (
            <section className={`graph-source-open-status-row ${props.graphSourceOpenFeedback}`} role="status" aria-live="polite" aria-label={codeMapCopy.graphSourceOpenStatusAria}>
              <span>{graphSourceOpenStatusText}</span>
            </section>
          ) : null}
          <GraphCanvas
            title={graphDrilldown ? `${graphDrilldown.label} · ${graphWorkbenchCopy.drilldownGraph}` : props.graphView.title}
            nodes={visibleNodes}
            edges={visibleEdges}
            layout={graphDrilldownLayout ?? props.graphView.layout}
            viewType={graphDrilldown ? 'module_detail' : (props.graphView.viewType as GraphViewType)}
            architectureModel={visibleArchitectureModel}
            appLanguage={props.appLanguage}
            currentNodeId={selectedGraphSubject === 'node' ? (selectedGraphNode?.id ?? graphDrilldown?.centerNode.id) : graphDrilldown?.centerNode.id}
            currentEdgeId={selectedGraphSubject === 'edge' ? selectedGraphEdge?.id : null}
            onSelectNode={selectPrimaryGraphNode}
            onSelectEdge={selectGraphEdge}
            onClearSelection={() => closeGraphInspector()}
            onOpenGraphSource={props.onOpenGraphSource}
            onCreateTaskFromNode={props.onCreateTaskFromNode}
          />

          {inspectorOpen ? (
            <aside ref={graphOverlayRef} className="code-map-inspector-pane code-map-floating-surface" aria-label={codeMapCopy.inspectorAria} role={isCompactGraphWorkbench ? 'dialog' : undefined}>
              <header className="code-map-floating-header">
                <span>
                  <small>{selectedGraphSubject === 'edge' ? graphWorkbenchCopy.inspectEdge : graphWorkbenchCopy.inspectNode}</small>
                  <strong>{selectedGraphCurrentTarget}</strong>
                </span>
                <button ref={graphOverlayCloseRef} type="button" aria-label={graphWorkbenchCopy.close} onClick={() => closeGraphInspector({ restoreFocus: true })}>
                  <X aria-hidden="true" weight="regular" />
                </button>
              </header>
              {selectedGraphNode ? (
                <>
                  <div className="graph-focus-toolbar" aria-label={graphWorkbenchCopy.focusLabel}>
                    {([0, 1, 2] as const).map((depth) => (
                      <button key={depth} type="button" aria-pressed={selectedGraphHopDepth === depth} disabled={isAggregatedGraphNode(selectedGraphNode) && depth > 0} onClick={() => setSelectedGraphHopDepth(depth)}>
                        {depth === 0 ? graphWorkbenchCopy.focusAll : depth === 1 ? graphWorkbenchCopy.focusOne : graphWorkbenchCopy.focusTwo}
                      </button>
                    ))}
                  </div>
                  <GraphNodeDetail node={selectedGraphNode} graphView={inspectorGraphView} expandedHopDepth={selectedGraphHopDepth || undefined} appLanguage={props.appLanguage} isCurrent />
                  <div className="graph-inspector-actions">
                    <button
                      type="button"
                      disabled={!resolveGraphCanvasNodeSourceRef(selectedGraphNode)}
                      onClick={() =>
                        props.onOpenGraphSource?.({
                          sourceRef: resolveGraphCanvasNodeSourceRef(selectedGraphNode),
                          lineStart: resolveGraphCanvasNodeLineStart(selectedGraphNode) ?? undefined,
                        })
                      }
                    >
                      {graphWorkbenchCopy.openSource}
                    </button>
                    <button
                      type="button"
                      disabled={isAggregatedGraphNode(selectedGraphNode) || props.scanState === 'scanning'}
                      onClick={() => {
                        if (isAggregatedGraphNode(selectedGraphNode)) return;
                        const question = codeMapCopy.explainNodeQuestion(selectedGraphNode.qualifiedName, resolveGraphCanvasNodeSourceRef(selectedGraphNode));
                        setGraphQuestionInput(question);
                        openGraphTool('qa', findGraphObjectElement('node', selectedGraphNode.id));
                      }}
                    >
                      {graphWorkbenchCopy.askNode}
                    </button>
                    <button type="button" disabled={isAggregatedGraphNode(selectedGraphNode)} onClick={() => props.onCreateTaskFromNode?.(selectedGraphNode.id)}>
                      {graphWorkbenchCopy.createTask}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (isAggregatedGraphNode(selectedGraphNode)) {
                          setHiddenNodeIds((current) => [...new Set([...current, ...selectedGraphNode.nodeIds])]);
                        } else {
                          toggleNodeVisibility(selectedGraphNode.id);
                        }
                        closeGraphInspector();
                      }}
                    >
                      {graphWorkbenchCopy.hideNode}
                    </button>
                  </div>
                </>
              ) : null}
              {selectedGraphEdge ? <GraphEdgeDetailPanel edge={selectedGraphEdge} nodes={visibleNodes} graphView={inspectorGraphView} appLanguage={props.appLanguage} isCurrent /> : null}
            </aside>
          ) : null}

          {activeGraphTool ? (
            <aside ref={graphOverlayRef} className="code-map-tool-surface code-map-floating-surface" aria-label={codeMapCopy.tools[activeGraphTool].label} role={isCompactGraphWorkbench ? 'dialog' : undefined}>
              <header className="code-map-floating-header">
                <span>
                  <small>{graphWorkbenchCopy.tools}</small>
                  <strong>{codeMapCopy.tools[activeGraphTool].label}</strong>
                </span>
                <button ref={graphOverlayCloseRef} type="button" aria-label={graphWorkbenchCopy.close} onClick={() => closeGraphTool({ restoreFocus: true })}>
                  <X aria-hidden="true" weight="regular" />
                </button>
              </header>
              <section className="code-map-secondary-tools code-map-secondary-inspector" aria-label={codeMapCopy.secondaryToolsAria}>
                <section className={`code-map-tool-pane ${activeGraphTool === 'runtime' ? 'code-map-tool-pane-active' : ''}`} aria-label={codeMapCopy.graphRuntime} hidden={activeGraphTool !== 'runtime'}>
                  {shouldRenderRuntimeGraph ? (
                    <GraphRuntimeCanvas
                      nodes={visibleNodes}
                      edges={visibleEdges}
                      layout={graphDrilldownLayout ?? props.graphView.layout}
                      appLanguage={props.appLanguage}
                      currentNodeId={selectedGraphSubject === 'node' ? selectedGraphNode?.id : null}
                      currentEdgeId={selectedGraphSubject === 'edge' ? selectedGraphEdge?.id : null}
                      onSelectNode={selectGraphNode}
                      onSelectEdge={selectGraphEdge}
                    />
                  ) : (
                    <section className="graph-runtime-unavailable-row" aria-label={codeMapCopy.graphRuntime}>
                      {/* 运行时预览只能按需出现；默认状态必须明确它被收纳而不是悄悄抢占主画布。 */}
                      <span className="graph-qa-copy">
                        <strong>{codeMapCopy.graphRuntime}</strong>
                        <span>{isSequenceDiagramExportView ? codeMapCopy.sequenceRuntimeHidden : codeMapCopy.runtimeToolCollapsed}</span>
                      </span>
                    </section>
                  )}
                </section>

                <section className={`code-map-tool-pane ${activeGraphTool === 'search' ? 'code-map-tool-pane-active' : ''}`} aria-label={codeMapCopy.searchPanelAria} hidden={activeGraphTool !== 'search'}>
                  <div className="graph-search-control-grid" aria-label={codeMapCopy.searchFilterAria}>
                    <section className="graph-search-control-row" aria-label={codeMapCopy.nodeSearchAria}>
                      {/* 图谱筛选控件必须保留来源语境：说明列讲清筛选含义，控件列只负责输入。 */}
                      <span className="graph-search-control-copy">
                        <strong>{codeMapCopy.nodeSearchTitle}</strong>
                        <small>{codeMapCopy.nodeSearchHelp}</small>
                      </span>
                      <span className="graph-search-control-field">
                        <input type="search" aria-label={codeMapCopy.nodeSearchAria} value={graphSearchQuery} onChange={(event) => setGraphSearchQuery(event.currentTarget.value)} />
                      </span>
                    </section>
                    <section className="graph-search-control-row" aria-label={codeMapCopy.nodeTypeAria}>
                      <span className="graph-search-control-copy">
                        <strong>{codeMapCopy.nodeTypeTitle}</strong>
                        <small>{codeMapCopy.nodeTypeHelp}</small>
                      </span>
                      <span className="graph-search-control-field">
                        <ZeusSelect
                          size="regular"
                          ariaLabel={codeMapCopy.nodeTypeAria}
                          value={graphNodeTypeFilter}
                          onChange={setGraphNodeTypeFilter}
                          searchPlaceholder={selectSearchPlaceholder}
                          emptyLabel={selectNoResults}
                          options={graphNodeTypeFilterValues.map((nodeType) => ({
                            value: nodeType,
                            label: uiCopy.graphNodeTypes[nodeType],
                          }))}
                        />
                      </span>
                    </section>
                    <section className="graph-search-control-row" aria-label={codeMapCopy.edgeTypeAria}>
                      <span className="graph-search-control-copy">
                        <strong>{codeMapCopy.edgeTypeTitle}</strong>
                        <small>{codeMapCopy.edgeTypeHelp}</small>
                      </span>
                      <span className="graph-search-control-field">
                        <ZeusSelect
                          size="regular"
                          ariaLabel={codeMapCopy.edgeTypeAria}
                          value={graphEdgeTypeFilter}
                          onChange={setGraphEdgeTypeFilter}
                          searchPlaceholder={selectSearchPlaceholder}
                          emptyLabel={selectNoResults}
                          options={graphEdgeTypeFilterValues.map((edgeType) => ({
                            value: edgeType,
                            label: uiCopy.graphEdgeTypes[edgeType],
                          }))}
                        />
                      </span>
                    </section>
                    <section className="graph-search-control-row" aria-label={codeMapCopy.minConfidenceAria}>
                      <span className="graph-search-control-copy">
                        <strong>{codeMapCopy.minConfidenceTitle}</strong>
                        <small>{codeMapCopy.minConfidenceHelp}</small>
                      </span>
                      <span className="graph-search-control-field">
                        <input
                          aria-label={codeMapCopy.minConfidenceAria}
                          type="number"
                          min="0"
                          max="1"
                          step="0.1"
                          value={graphMinConfidence}
                          onChange={(event) => setGraphMinConfidence(normalizeGraphMinConfidence(event.currentTarget.value, graphMinConfidence))}
                        />
                      </span>
                    </section>
                    <button type="button" disabled={props.scanState === 'scanning'} onClick={runQuickGraphSearch}>
                      {codeMapCopy.searchAction}
                    </button>
                    {props.searchResult ? <span>{codeMapCopy.resultCount(props.searchResult.nodes.length + props.searchResult.edges.length)}</span> : null}
                    {props.searchResult && !searchResultHasCurrentMatches ? (
                      <span className="code-map-search-feedback" role="status">
                        {graphWorkbenchCopy.searchNoMatch}
                      </span>
                    ) : null}
                  </div>
                </section>

                <section className={`code-map-tool-pane ${activeGraphTool === 'qa' ? 'code-map-tool-pane-active' : ''}`} aria-label={codeMapCopy.qaPanelAria} hidden={activeGraphTool !== 'qa'}>
                  <section className="graph-qa-workbench" aria-label={codeMapCopy.qaPanelAria}>
                    {/* 图谱问答必须绑定真实图谱来源，提问、回答、历史和详情按连续行组织，避免回到表单和时间线堆叠。 */}
                    <section className="graph-qa-compose-row zeus-composer-dock" aria-label={codeMapCopy.qaComposeAria}>
                      <span className="graph-qa-copy">
                        <strong>{codeMapCopy.askGraphTitle}</strong>
                        <small>{codeMapCopy.askGraphHelp}</small>
                      </span>
                      <section className="graph-qa-question-row" aria-label={codeMapCopy.questionAria}>
                        <span className="graph-qa-question-copy">
                          <strong>{codeMapCopy.questionTitle}</strong>
                          <small>{codeMapCopy.questionHelp}</small>
                        </span>
                        <span className="graph-qa-question-field">
                          <input aria-label={codeMapCopy.askGraphAction} value={graphQuestionInput} onChange={(event) => setGraphQuestionInput(event.currentTarget.value)} />
                        </span>
                      </section>
                      <span className="graph-qa-decision-rail zeus-decision-rail" data-inline-rail-keyboard="horizontal" onKeyDown={handleInlineRailKeyboardNavigation}>
                        <button
                          type="button"
                          className="graph-qa-ask-button zeus-decision-rail-button"
                          data-inline-rail-item="true"
                          disabled={props.scanState === 'scanning' || !buildGraphQuestionRequest(graphQuestionInput).canAsk}
                          onClick={() => {
                            const request = buildGraphQuestionRequest(graphQuestionInput);
                            if (request.canAsk) props.onAskGraph?.(request.question);
                          }}
                        >
                          {codeMapCopy.askGraphAction}
                        </button>
                      </span>
                      <section className="graph-qa-mode-rail zeus-mode-rail" aria-label={codeMapCopy.qaModeRailAria}>
                        {graphQaModeItems.map((item) => (
                          <span className="graph-qa-mode-rail-item zeus-mode-rail-item" key={item.label}>
                            <small>{item.label}</small>
                            <strong>{item.value}</strong>
                          </span>
                        ))}
                      </section>
                    </section>
                    {props.graphAnswer ? (
                      <section className="graph-qa-answer-row" aria-label={codeMapCopy.graphAnswerAria}>
                        <span className="graph-qa-copy">
                          <strong>{props.graphAnswer.answer}</strong>
                          <span>{props.graphAnswer.sessionId ? `${codeMapCopy.runtimeSessionLabel} ${props.graphAnswer.sessionId}` : codeMapCopy.insufficientRuntimeSession}</span>
                          {props.graphAnswer.sources.nodes.slice(0, 3).map((node) => (
                            <small key={node.id}>{node.sourceRef}</small>
                          ))}
                        </span>
                      </section>
                    ) : null}
                    <section className="graph-qa-history" aria-label={codeMapCopy.qaHistoryAria}>
                      <div className="graph-qa-history-toolbar" aria-label={codeMapCopy.qaHistoryToolbarAria}>
                        <section className="graph-qa-history-search-row" aria-label={codeMapCopy.qaHistorySearchAria}>
                          <span className="graph-qa-history-search-copy">
                            <strong>{codeMapCopy.searchHistoryTitle}</strong>
                            <small>{codeMapCopy.searchHistoryHelp}</small>
                          </span>
                          <span className="graph-qa-history-search-field">
                            <input type="search" aria-label={codeMapCopy.qaHistorySearchAria} value={props.graphConversationSearch ?? ''} onChange={(event) => props.onGraphConversationSearchChange?.(event.target.value)} />
                          </span>
                        </section>
                        <span className="graph-qa-toolbar-command-rail">
                          <button
                            type="button"
                            onClick={() =>
                              props.onLoadGraphConversations?.({
                                query: props.graphConversationSearch?.trim() || undefined,
                                offset: 0,
                                archived: conversationPage.archived,
                              })
                            }
                          >
                            {codeMapCopy.searchHistoryAction}
                          </button>
                          <button
                            type="button"
                            aria-pressed={conversationPage.archived}
                            onClick={() =>
                              props.onLoadGraphConversations?.({
                                query: conversationPage.query ?? undefined,
                                offset: 0,
                                archived: !conversationPage.archived,
                              })
                            }
                          >
                            {conversationPage.archived ? codeMapCopy.viewActiveHistory : codeMapCopy.viewArchivedHistory}
                          </button>
                        </span>
                        <span className="graph-qa-count">{codeMapCopy.realQaCount(conversationPage.total)}</span>
                      </div>
                      {(props.graphConversations ?? []).length === 0 ? (
                        <div className="graph-qa-empty-row" aria-label={codeMapCopy.qaHistoryEmptyAria}>
                          <span className="graph-qa-copy">
                            <strong>{codeMapCopy.noRealQaHistory}</strong>
                            <span>{conversationPage.query ? codeMapCopy.noMatchingQaHistory : codeMapCopy.qaHistoryEmptyHelp}</span>
                          </span>
                        </div>
                      ) : (
                        props.graphConversations?.slice(0, 5).map((conversation) => {
                          const assistantMessage = conversation.messages.find((message) => message.role === 'assistant');
                          return (
                            <article className="graph-qa-history-row" key={conversation.id}>
                              <span className="graph-qa-copy">
                                <strong>{conversation.title}</strong>
                                <span>{assistantMessage?.content ?? conversation.summary ?? codeMapCopy.answerNotGenerated}</span>
                                <small>{conversation.sessionId ? `${codeMapCopy.runtimeSessionLabel} ${conversation.sessionId}` : codeMapCopy.insufficientRuntimeSession}</small>
                              </span>
                              <span className="graph-qa-history-command-rail">
                                <button type="button" className="graph-qa-detail-button" onClick={() => props.onLoadGraphConversation?.(conversation.id)}>
                                  {codeMapCopy.viewDetail}
                                </button>
                                <button type="button" className="graph-qa-task-button" onClick={() => props.onCreateTaskFromGraphConversation?.(conversation.id)}>
                                  {codeMapCopy.createTaskFromQa}
                                </button>
                                {conversation.archived ? (
                                  <button type="button" className="graph-qa-archive-button" onClick={() => props.onRestoreGraphConversation?.(conversation.id)}>
                                    {codeMapCopy.restoreHistory}
                                  </button>
                                ) : (
                                  <button type="button" className="graph-qa-archive-button" onClick={() => props.onArchiveGraphConversation?.(conversation.id)}>
                                    {codeMapCopy.archiveHistory}
                                  </button>
                                )}
                              </span>
                            </article>
                          );
                        })
                      )}
                      <div className="graph-qa-pagination-row" aria-label={codeMapCopy.qaPaginationAria}>
                        <button
                          type="button"
                          disabled={conversationPage.offset <= 0}
                          onClick={() =>
                            props.onLoadGraphConversations?.({
                              query: conversationPage.query ?? undefined,
                              offset: previousOffset,
                              archived: conversationPage.archived,
                            })
                          }
                        >
                          {codeMapCopy.previousPage}
                        </button>
                        <span>{conversationPage.total === 0 ? codeMapCopy.pageRangeEmpty : codeMapCopy.pageRange(conversationPage.offset + 1, Math.min(conversationPage.total, conversationPage.offset + conversationPage.limit))}</span>
                        <button
                          type="button"
                          disabled={nextOffset >= conversationPage.total}
                          onClick={() =>
                            props.onLoadGraphConversations?.({
                              query: conversationPage.query ?? undefined,
                              offset: nextOffset,
                              archived: conversationPage.archived,
                            })
                          }
                        >
                          {codeMapCopy.nextPage}
                        </button>
                      </div>
                      {selectedConversation ? (
                        <aside className="graph-qa-detail-pane graph-qa-detail-inspector" aria-label={codeMapCopy.qaDetailAria}>
                          <header className="graph-qa-detail-header">
                            <span className="graph-qa-detail-title-copy">
                              <strong>{selectedConversation.title}</strong>
                              <small>{selectedConversation.summary || selectedConversation.projectId}</small>
                            </span>
                            <small>
                              {selectedConversation.archived ? codeMapCopy.archivedStatus : codeMapCopy.activeStatus} · {formatGraphConversationStatus(selectedConversation.status, props.appLanguage)}
                            </small>
                          </header>
                          <section className="graph-qa-detail-meta-row" aria-label={codeMapCopy.qaDetailStatusAria}>
                            <span className="graph-qa-detail-message-copy">
                              {/* Runtime 会话来自真实历史记录；缺失时明确展示未启动，避免伪造会话来源。 */}
                              <strong>{selectedConversation.sessionId ? `${codeMapCopy.runtimeSessionLabel} ${selectedConversation.sessionId}` : codeMapCopy.insufficientRuntimeSession}</strong>
                              <small>{selectedConversation.updatedAt}</small>
                            </span>
                            <span>{codeMapCopy.messageCount(selectedConversation.messages.length)}</span>
                          </section>
                          <section className="graph-qa-detail-message-list" aria-label={codeMapCopy.qaMessagesAria}>
                            {selectedConversation.messages.map((message) => (
                              <div className="graph-qa-message-row" key={message.id}>
                                <span className="graph-qa-detail-message-copy graph-qa-copy">
                                  <strong>{message.role === 'assistant' ? codeMapCopy.assistantAnswer : codeMapCopy.userQuestion}</strong>
                                  <span>{message.content}</span>
                                  <small>{formatGraphMessageSource(message.source, props.appLanguage)}</small>
                                </span>
                              </div>
                            ))}
                          </section>
                        </aside>
                      ) : null}
                    </section>
                  </section>
                </section>

                <section className={`code-map-tool-pane ${activeGraphTool === 'mermaid' ? 'code-map-tool-pane-active' : ''}`} aria-label={codeMapCopy.mermaidPanelAria} hidden={activeGraphTool !== 'mermaid'}>
                  <section className="graph-mermaid-preview graph-mermaid-workbench" aria-label={codeMapCopy.mermaidPreviewAria}>
                    {/* 图表源码导出只展示真实可见节点和边；PlantUML 用于对接成熟 UML 工具链，Mermaid 保留轻量预览。 */}
                    <div className="graph-mermaid-command-row" aria-label={codeMapCopy.mermaidExportCommandsAria}>
                      <span className="graph-mermaid-copy">
                        <strong>{diagramPreviewTitle}</strong>
                        <small>{codeMapCopy.mermaidPreviewHelp}</small>
                      </span>
                      <span className="graph-mermaid-command-rail">
                        <span className="graph-diagram-format-switch" aria-label={codeMapCopy.diagramFormatAria}>
                          {(['mermaid', 'plantuml'] as const).map((format) => (
                            <button key={format} type="button" aria-pressed={diagramExportFormat === format} onClick={() => setDiagramExportFormat(format)}>
                              {format === 'plantuml' ? 'PlantUML' : 'Mermaid'}
                            </button>
                          ))}
                        </span>
                        <button type="button" onClick={() => setShowMermaidPreview((current) => !current)}>
                          {showMermaidPreview ? codeMapCopy.hideMermaidSource : codeMapCopy.generateMermaidPreview}
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              if (diagramExportFormat === 'plantuml') {
                                const exportFile = buildVisibleDiagramExport('plantuml');
                                setLastMermaidExport(exportFile);
                                const saved = props.onExportPlantUmlDiagramFile ? await props.onExportPlantUmlDiagramFile(exportFile) : { saved: false, filePath: null };
                                setMermaidExportStatus(saved.saved && saved.filePath ? codeMapCopy.mermaidSavedStatus(saved.filePath) : codeMapCopy.mermaidGeneratedStatus(exportFile.fileName));
                              } else {
                                const exportFile = buildVisibleDiagramExport('mermaid');
                                setLastMermaidExport(exportFile);
                                const saved = props.onExportMermaidDiagramFile ? await props.onExportMermaidDiagramFile(exportFile) : { saved: false, filePath: null };
                                setMermaidExportStatus(saved.saved && saved.filePath ? codeMapCopy.mermaidSavedStatus(saved.filePath) : codeMapCopy.mermaidGeneratedStatus(exportFile.fileName));
                              }
                            } catch {
                              setMermaidExportStatus(codeMapCopy.mermaidSaveFailedStatus);
                            }
                            setShowMermaidPreview(true);
                          }}
                        >
                          {codeMapCopy.exportMermaidSource}
                        </button>
                      </span>
                    </div>
                    {showMermaidPreview ? (
                      <div className="graph-mermaid-source-row" aria-label={codeMapCopy.mermaidSourceAria}>
                        <small>{diagramExportFormatLabel}</small>
                        <pre className="graph-mermaid-source-preview">{buildVisibleDiagramSource(diagramExportFormat)}</pre>
                      </div>
                    ) : (
                      <div className="graph-mermaid-empty-row" aria-label={codeMapCopy.mermaidEmptyAria}>
                        <span className="graph-mermaid-copy">
                          <strong>{codeMapCopy.mermaidEmptyTitle}</strong>
                          <span>{codeMapCopy.mermaidEmptyHelp}</span>
                        </span>
                      </div>
                    )}
                    {lastMermaidExport || mermaidExportStatus ? (
                      <div className="graph-mermaid-status-row" aria-label={codeMapCopy.mermaidStatusAria}>
                        {lastMermaidExport ? <small>{codeMapCopy.mermaidGeneratedFile(lastMermaidExport.fileName, lastMermaidExport.mimeType)}</small> : null}
                        {mermaidExportStatus ? <small>{mermaidExportStatus}</small> : null}
                      </div>
                    ) : null}
                  </section>
                </section>

                <section className={`code-map-tool-pane ${activeGraphTool === 'entities' ? 'code-map-tool-pane-active' : ''}`} aria-label={codeMapCopy.entityPanelAria} hidden={activeGraphTool !== 'entities'}>
                  <section className="graph-entity-workbench" aria-label={codeMapCopy.entityWorkbenchAria}>
                    {/* 节点和边列表只表达真实来源与常用动作，操作列和信息列分离，避免节点卡片继续按钮平铺。 */}
                    <section className="graph-entity-section" aria-label={codeMapCopy.graphNodesAria}>
                      <div className="graph-entity-section-header">
                        <strong>{codeMapCopy.graphNodesTitle}</strong>
                        <span>{codeMapCopy.realNodeCount(visibleNodes.length)}</span>
                      </div>
                      <div className="graph-node-list" aria-label={codeMapCopy.graphNodesAria}>
                        {visibleNodes.map((node) => {
                          if (isAggregatedGraphNode(node)) {
                            return (
                              <article className="graph-node-row aggregate" key={node.id}>
                                <span className="graph-node-copy">
                                  <strong>{node.name}</strong>
                                  <span>{formatGraphNodeTypeList(node.nodeTypes, props.appLanguage)}</span>
                                  <small>{codeMapCopy.aggregatedNodeSummary(node.aggregateCount, node.sourceRefs.length)}</small>
                                </span>
                                <span className="graph-node-command-rail">
                                  <small>{codeMapCopy.aggregateNodeLabel}</small>
                                </span>
                              </article>
                            );
                          }
                          const isHidden = hiddenNodeIds.includes(node.id);
                          const isMenuOpen = activeNodeMenuId === node.id;
                          const isMenuClosing = closingNodeMenuId === node.id;
                          const isMenuVisible = isMenuOpen || isMenuClosing;
                          const isCurrentGraphNodeEntity = selectedGraphSubject === 'node' && selectedGraphNode?.id === node.id;
                          const nodeActions = buildGraphNodeActionMenu(node, isHidden, props.appLanguage);
                          return (
                            <article
                              className={`graph-node-row${isCurrentGraphNodeEntity ? ' current-graph-entity-row' : ''}`}
                              aria-current={isCurrentGraphNodeEntity ? 'true' : undefined}
                              key={node.id}
                              onKeyDown={handleGraphNodeMenuKeyDown}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                openGraphNodeMenu(node.id);
                              }}
                            >
                              <button type="button" className="graph-node-copy" onClick={() => selectGraphNode(node.id)}>
                                <strong>{node.name}</strong>
                                <span>{formatGraphNodeType(node.nodeType, props.appLanguage)}</span>
                                <small>
                                  {node.sourceRef}:{String(node.metadata.lineStart ?? '?')}
                                </small>
                              </button>
                              <span className="graph-node-command-rail">
                                <button type="button" onClick={() => props.onCreateTaskFromNode?.(node.id)}>
                                  {codeMapCopy.createTaskFromNode}
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    props.onOpenGraphSource?.({
                                      sourceRef: node.sourceRef,
                                      lineStart: typeof node.metadata.lineStart === 'number' ? node.metadata.lineStart : undefined,
                                    })
                                  }
                                >
                                  {codeMapCopy.openSource}
                                </button>
                                <button type="button" aria-pressed={isHidden} onClick={() => toggleNodeVisibility(node.id)}>
                                  {isHidden ? codeMapCopy.restoreNode : codeMapCopy.hideNode}
                                </button>
                                <button type="button" aria-expanded={isMenuOpen} onClick={() => toggleGraphNodeMenu(node.id)}>
                                  {codeMapCopy.openNodeMenu}
                                </button>
                              </span>
                              <div
                                className="graph-node-menu-row"
                                role="menu"
                                aria-label={codeMapCopy.nodeActionMenuAria}
                                hidden={!isMenuVisible}
                                data-motion-surface="popover"
                                data-motion-state={isMenuClosing ? 'closing' : isMenuOpen ? 'open' : undefined}
                              >
                                {nodeActions.map((action) => (
                                  <button key={action.id} type="button" role="menuitem" onClick={() => runNodeAction(node, action)}>
                                    {action.label}
                                  </button>
                                ))}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                    <section className="graph-entity-section" aria-label={codeMapCopy.graphEdgesAria}>
                      <div className="graph-entity-section-header">
                        <strong>{codeMapCopy.graphEdgesTitle}</strong>
                        <span>{codeMapCopy.realEdgeCount(visibleEdges.length)}</span>
                      </div>
                      <div className="graph-edge-list" aria-label={codeMapCopy.graphEdgesAria}>
                        {visibleEdges.map((edge) => {
                          const isCurrentGraphEdgeEntity = selectedGraphSubject === 'edge' && selectedGraphEdge?.id === edge.id;
                          return (
                            <div className={`graph-edge-row${isCurrentGraphEdgeEntity ? ' current-graph-entity-row' : ''}`} aria-current={isCurrentGraphEdgeEntity ? 'true' : undefined} key={edge.id}>
                              <button type="button" className="graph-edge-copy" onClick={() => selectGraphEdge(edge.id)}>
                                <strong>{formatGraphEdgeType(edge.edgeType, props.appLanguage)}</strong>
                                <span>{edge.sourceRef}</span>
                                {'aggregateCount' in edge && edge.aggregateCount > 1 ? <small>{codeMapCopy.aggregatedEdgeSummary(edge.aggregateCount, edge.sourceRefs.length)}</small> : null}
                              </button>
                              <span className="graph-edge-meta-rail">{typeof edge.confidence === 'number' ? <small>{codeMapCopy.confidenceValue(edge.confidence.toFixed(2))}</small> : <small>{codeMapCopy.confidenceUnknown}</small>}</span>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  </section>
                </section>
              </section>
            </aside>
          ) : null}
        </section>
        <footer className="code-map-status-bar" aria-label={codeMapCopy.performanceAria}>
          <span>
            <strong>{graphDrilldown ? `${graphDrilldown.label} · ${graphWorkbenchCopy.drilldownGraph}` : (uiCopy.graphViewTypes[props.graphView.viewType as GraphViewType] ?? props.graphView.title)}</strong>
            <span>
              {visibleArchitectureModel ? (
                <>
                  {graphWorkbenchCopy.currentVisible} {visibleArchitectureModel.objectCount} {props.appLanguage === 'zh-CN' ? '个架构对象' : 'architecture objects'} / {visibleArchitectureModel.dependencyEdges.length}{' '}
                  {props.appLanguage === 'zh-CN' ? '条依赖' : 'dependencies'}
                </>
              ) : (
                <>
                  {graphWorkbenchCopy.currentVisible} {visibleNodes.length} {graphWorkbenchCopy.nodeUnit} / {visibleEdges.length} {graphWorkbenchCopy.relationGroupUnit} ·{' '}
                  {graphWorkbenchCopy.representedRelations(visibleGraphStats.representedEdgeCount)}
                </>
              )}
            </span>
            <span>
              {graphWorkbenchCopy.loadedTotal} {activeGraphScope.nodes.length} {graphWorkbenchCopy.nodeUnit} / {activeGraphScope.edges.length} {graphWorkbenchCopy.relationUnit}
            </span>
            {visibleGraphStats.omittedEdgeGroupCount > 0 ? <span>{graphWorkbenchCopy.omittedRelations(visibleGraphStats.omittedEdgeGroupCount, visibleGraphStats.omittedRepresentedEdgeCount)}</span> : null}
            <span>{graphWorkbenchCopy.staticStructure}</span>
            {graphDrilldownLayout || props.graphView.layout ? <span>{formatGraphLayoutAlgorithm((graphDrilldownLayout ?? props.graphView.layout)!.algorithm, props.appLanguage)}</span> : null}
            {props.graphView.performance ? <span>{Math.round(props.graphView.performance.durationMs)}ms</span> : null}
          </span>
          <span className={props.scanState ?? 'idle'}>
            <i aria-hidden="true" />
            {scanStatusCopy}
          </span>
        </footer>
      </div>
    </section>
  );
}
