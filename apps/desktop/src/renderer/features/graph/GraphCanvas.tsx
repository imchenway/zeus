import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import { toReactFlowElements, toSigmaGraph } from '@zeus/diagram-engine';
import { type AppLanguage } from '../workspace/workspaceCopy.js';
import { ArchitectureGraphCanvas, type ArchitectureLayerModel } from '../../graph/ArchitectureGraphCanvas.js';
import { type AiRuntimeLogEntry, type GraphViewSnapshot, type GraphViewType, type TaskStatus } from '../../apiClient.js';
import { formatGraphEdgeType, formatGraphEdgeWithConfidence, formatGraphNodeType, formatGraphRiskTag, formatGraphRuntimeEdgeLabel } from '../workspace/workspaceFormatters.js';
import { getLanguageCopy } from '../workspace/workspaceSupport.js';
export interface GraphNodeActionMenuItem {
  id: 'inspect-detail' | 'create-task' | 'open-source' | 'ask-node' | 'generate-sequence' | 'generate-flow' | 'expand-one-hop' | 'expand-two-hop' | 'toggle-visibility';
  label: string;
  sourceRef: string;
  lineStart: number | null;
}

export function buildGraphNodeActionMenu(node: GraphViewSnapshot['nodes'][number], hidden = false, appLanguage: AppLanguage = 'zh-CN'): GraphNodeActionMenuItem[] {
  const lineStart = typeof node.metadata.lineStart === 'number' ? node.metadata.lineStart : null;
  const actionCopy = getLanguageCopy(appLanguage).codeMapWorkspace.nodeActions;
  return [
    {
      id: 'inspect-detail',
      label: actionCopy.inspectDetail,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'open-source',
      label: actionCopy.openSource,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'ask-node',
      label: actionCopy.askNode,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'generate-sequence',
      label: actionCopy.generateSequence,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'generate-flow',
      label: actionCopy.generateFlow,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'expand-one-hop',
      label: actionCopy.expandOneHop,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'expand-two-hop',
      label: actionCopy.expandTwoHop,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'create-task',
      label: actionCopy.createTask,
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'toggle-visibility',
      label: hidden ? actionCopy.restoreNode : actionCopy.hideNode,
      sourceRef: node.sourceRef,
      lineStart,
    },
  ];
}

export type AggregatedGraphNode = GraphViewSnapshot['nodes'][number] & {
  isAggregate: true;
  aggregateCount: number;
  nodeIds: string[];
  sourceRefs: string[];
  nodeTypes: string[];
};

export type AggregatedGraphEdge = GraphViewSnapshot['edges'][number] & {
  aggregateCount: number;
  sourceRefs: string[];
  edgeIds: string[];
};

export function buildGraphNeighborhoodSlice(input: { nodes: GraphViewSnapshot['nodes']; edges: GraphViewSnapshot['edges']; centerNodeId: string; depth: 1 | 2 }): {
  nodes: GraphViewSnapshot['nodes'];
  edges: GraphViewSnapshot['edges'];
} {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  if (!nodeIds.has(input.centerNodeId)) return { nodes: input.nodes, edges: input.edges };

  const adjacency = new Map<string, Set<string>>();
  for (const nodeId of nodeIds) adjacency.set(nodeId, new Set());
  for (const edge of input.edges) {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) continue;
    adjacency.get(edge.sourceNodeId)?.add(edge.targetNodeId);
    adjacency.get(edge.targetNodeId)?.add(edge.sourceNodeId);
  }

  const visibleNodeIds = new Set([input.centerNodeId]);
  let frontier = new Set([input.centerNodeId]);
  for (let step = 0; step < input.depth; step += 1) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      for (const neighborId of adjacency.get(nodeId) ?? []) {
        if (!visibleNodeIds.has(neighborId)) next.add(neighborId);
      }
    }
    for (const nodeId of next) visibleNodeIds.add(nodeId);
    frontier = next;
  }

  return {
    nodes: input.nodes.filter((node) => visibleNodeIds.has(node.id)),
    edges: input.edges.filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)),
  };
}

export function buildVisibleGraphSlice(input: {
  nodes: GraphViewSnapshot['nodes'];
  edges: GraphViewSnapshot['edges'];
  hiddenNodeIds: string[];
  maxNodes: number;
  maxEdges: number;
  showLowConfidenceEdges?: boolean;
  minConfidence?: number;
}): {
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  edges: AggregatedGraphEdge[];
  stats: {
    renderedEdgeGroupCount: number;
    representedEdgeCount: number;
    omittedEdgeGroupCount: number;
    omittedRepresentedEdgeCount: number;
  };
} {
  const hiddenNodeIds = new Set(input.hiddenNodeIds);
  const minConfidence = typeof input.minConfidence === 'number' ? normalizeGraphMinConfidence(input.minConfidence, input.showLowConfidenceEdges ? 0 : 1) : input.showLowConfidenceEdges ? 0 : 1;
  const nodes = buildAggregatedGraphNodes(
    input.nodes.filter((node) => !hiddenNodeIds.has(node.id)),
    input.maxNodes,
  );
  const visibleNodeIdBySourceNodeId = new Map<string, string>();
  for (const node of nodes) {
    if (isAggregatedGraphNode(node)) {
      for (const sourceNodeId of node.nodeIds) visibleNodeIdBySourceNodeId.set(sourceNodeId, node.id);
    } else {
      visibleNodeIdBySourceNodeId.set(node.id, node.id);
    }
  }
  const remappedEdges = input.edges.flatMap((edge) => {
    if (edge.confidence < minConfidence) return [];
    const sourceNodeId = visibleNodeIdBySourceNodeId.get(edge.sourceNodeId);
    const targetNodeId = visibleNodeIdBySourceNodeId.get(edge.targetNodeId);
    if (!sourceNodeId || !targetNodeId) return [];
    return [{ ...edge, sourceNodeId, targetNodeId }];
  });
  const allEdgeGroups = buildAggregatedGraphEdges(remappedEdges);
  const edges = allEdgeGroups.slice(0, Math.max(1, input.maxEdges));
  const representedEdgeCount = edges.reduce((count, edge) => count + edge.aggregateCount, 0);
  const totalRepresentedEdgeCount = allEdgeGroups.reduce((count, edge) => count + edge.aggregateCount, 0);
  return {
    nodes,
    edges,
    stats: {
      renderedEdgeGroupCount: edges.length,
      representedEdgeCount,
      omittedEdgeGroupCount: Math.max(0, allEdgeGroups.length - edges.length),
      omittedRepresentedEdgeCount: Math.max(0, totalRepresentedEdgeCount - representedEdgeCount),
    },
  };
}

export function buildGraphQuestionRequest(question: string): {
  question: string;
  canAsk: boolean;
} {
  const normalizedQuestion = question.trim();
  return {
    question: normalizedQuestion,
    canAsk: normalizedQuestion.length > 0,
  };
}

export interface GraphSearchFilterInput {
  query: string;
  nodeType?: string;
  edgeType?: string;
  minConfidence: number;
}

export function buildGraphSearchRequest(input: GraphSearchFilterInput): {
  query: string;
  nodeType?: string;
  edgeType?: string;
  minConfidence: number;
} {
  return {
    query: input.query.trim(),
    nodeType: input.nodeType?.trim() || undefined,
    edgeType: input.edgeType?.trim() || undefined,
    minConfidence: normalizeGraphMinConfidence(input.minConfidence, 1),
  };
}

export function normalizeGraphMinConfidence(value: string | number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return Math.min(1, Math.max(0, fallback));
  return Math.min(1, Math.max(0, Math.round(parsed * 100) / 100));
}

export function isAggregatedGraphNode(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): node is AggregatedGraphNode {
  return 'isAggregate' in node && node.isAggregate === true;
}

export function buildAggregatedGraphNodes(nodes: GraphViewSnapshot['nodes'], maxNodes: number): Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode> {
  const safeMaxNodes = Math.max(1, maxNodes);
  if (nodes.length <= safeMaxNodes) return nodes;
  const aggregateSlotCount = safeMaxNodes < 4 ? 1 : Math.min(4, Math.max(1, Math.floor(safeMaxNodes / 5)));
  const concreteNodeCount = Math.max(0, safeMaxNodes - aggregateSlotCount);
  const concreteNodes = nodes.slice(0, concreteNodeCount);
  const overflowNodes = nodes.slice(concreteNodeCount);
  const groups = new Map<string, { label: string; nodes: GraphViewSnapshot['nodes'] }>();
  for (const node of overflowNodes) {
    const sourceParts = node.sourceRef.split(/[\\/]/u).filter(Boolean);
    const sourceDirectories = sourceParts.slice(0, -1);
    const sourceArea = sourceDirectories.length > 1 ? sourceDirectories.slice(-2).join('/') : sourceDirectories[0] || node.nodeType;
    const key = `${sourceArea}::${node.nodeType}`;
    const group = groups.get(key) ?? { label: `${sourceArea} · ${node.nodeType}`, nodes: [] };
    group.nodes.push(node);
    groups.set(key, group);
  }
  const semanticGroups = [...groups.values()];
  const visibleGroups =
    semanticGroups.length <= aggregateSlotCount
      ? semanticGroups
      : [
          ...semanticGroups.slice(0, Math.max(0, aggregateSlotCount - 1)),
          {
            label: 'other · mixed',
            nodes: semanticGroups.slice(Math.max(0, aggregateSlotCount - 1)).flatMap((group) => group.nodes),
          },
        ];

  const aggregateNodes = visibleGroups.map((group, index): AggregatedGraphNode => {
    const sourceRefs = [...new Set(group.nodes.map((node) => node.sourceRef))];
    const nodeTypes = [...new Set(group.nodes.map((node) => node.nodeType))];
    const nodeIds = group.nodes.map((node) => node.id);
    const firstOverflow = group.nodes[0];
    const aggregateKey = buildGraphAggregateKey(nodeIds);
    // 聚合只压缩当前渲染模型；每个原节点仍保留到 nodeIds，边端点会在下一步同步重映射。
    return {
      id: `aggregate_${index}_${aggregateKey}`,
      nodeType: 'aggregate',
      name: `${group.label} · ${group.nodes.length}`,
      qualifiedName: `aggregate:${group.label}:${aggregateKey}`,
      sourceRef: firstOverflow?.sourceRef ?? '',
      symbolId: `aggregate_symbol_${index}_${aggregateKey}`,
      metadata: {
        aggregateCount: group.nodes.length,
        nodeIds,
        sourceRefs,
        nodeTypes,
      },
      isAggregate: true,
      aggregateCount: group.nodes.length,
      nodeIds,
      sourceRefs,
      nodeTypes,
    };
  });
  return [...concreteNodes, ...aggregateNodes];
}

export function buildGraphAggregateKey(nodeIds: string[]): string {
  let hash = 2166136261;
  for (const nodeId of nodeIds) {
    for (let index = 0; index < nodeId.length; index += 1) {
      hash ^= nodeId.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(36);
}

export function buildAggregatedGraphEdges(edges: GraphViewSnapshot['edges']): AggregatedGraphEdge[] {
  const groups = new Map<string, AggregatedGraphEdge>();
  for (const edge of edges) {
    const key = `${edge.sourceNodeId}::${edge.targetNodeId}::${edge.edgeType}`;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        ...edge,
        aggregateCount: 1,
        sourceRefs: [edge.sourceRef],
        edgeIds: [edge.id],
      });
      continue;
    }
    current.aggregateCount += 1;
    current.edgeIds.push(edge.id);
    if (!current.sourceRefs.includes(edge.sourceRef)) current.sourceRefs.push(edge.sourceRef);
    current.confidence = Math.round(((current.confidence * (current.aggregateCount - 1) + edge.confidence) / current.aggregateCount) * 100) / 100;
  }
  return [...groups.values()];
}

export function RuntimeXtermPane(props: { logs: AiRuntimeLogEntry[]; enabled: boolean; ariaLabel: string }) {
  const terminalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!props.enabled || !terminalRef.current || typeof window === 'undefined') return;
    let disposed = false;
    let terminal: import('@xterm/xterm').Terminal | undefined;
    void import('@xterm/xterm').then(({ Terminal }) => {
      if (disposed || !terminalRef.current) return;
      // xterm 只负责渲染已采集的真实 Runtime 日志；输入、resize、Ctrl-C 仍走后端审计 API。
      terminal = new Terminal({
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        rows: 10,
        cols: 120,
        theme: { background: '#0f172a', foreground: '#dbeafe' },
      });
      terminal.open(terminalRef.current);
      for (const entry of props.logs.slice(-80)) {
        if (entry.stream === 'system') terminal.write(`\r\n${entry.text}\r\n`);
        else terminal.write(entry.text.replace(/\n/gu, '\r\n'));
      }
    });
    return () => {
      disposed = true;
      terminal?.dispose();
    };
  }, [props.enabled, props.logs]);

  if (!props.enabled) return null;
  return <div className="xterm-runtime-pane" aria-label={props.ariaLabel} ref={terminalRef} />;
}

export type SigmaRendererInstance = { kill: () => void };
export type GraphologyGraphInstance = {
  addNode: (key: string, attributes?: Record<string, unknown>) => void;
  addDirectedEdgeWithKey: (key: string, source: string, target: string, attributes?: Record<string, unknown>) => void;
};
export type GraphologyGraphConstructor = new () => GraphologyGraphInstance;
export type SigmaRendererConstructor = new (graph: GraphologyGraphInstance, container: HTMLElement, settings?: Record<string, unknown>) => SigmaRendererInstance;

export interface SigmaRuntimeGraphNode {
  key: string;
  attributes: {
    label: string;
    type: string;
    nodeType: string;
    sourceRef: string;
    x: number;
    y: number;
    size: number;
    color: string;
  };
}

export interface SigmaRuntimeGraph {
  nodes: SigmaRuntimeGraphNode[];
  edges: ReturnType<typeof toSigmaGraph>['edges'];
}

export function buildSigmaRuntimeGraph(input: {
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>;
  layout?: GraphViewSnapshot['layout'];
}): SigmaRuntimeGraph {
  const baseGraph = toSigmaGraph({ nodes: input.nodes, edges: input.edges });
  const width = normalizeGraphCanvasDimension(input.layout?.width, 720, 1440);
  const height = normalizeGraphCanvasDimension(input.layout?.height, 300, 900);
  const layout = buildGraphCanvasLayout(input.nodes, width, height, input.layout);

  return {
    ...baseGraph,
    nodes: baseGraph.nodes.map((node) => {
      const point = layout.get(node.key) ?? {
        x: Math.round(width / 2),
        y: Math.round(height / 2),
      };
      const nodeType = node.attributes.type;
      return {
        ...node,
        attributes: {
          ...node.attributes,
          type: 'circle',
          nodeType,
          // Sigma/WebGL 运行时要求 x/y 是真实数值；这里复用服务端布局或确定性前端布局，不生成演示节点。
          x: point.x,
          y: point.y,
          size: nodeType === 'aggregate' ? 11 : 8,
          color: sigmaNodeColor(nodeType),
        },
      };
    }),
  };
}

export function sigmaNodeColor(nodeType: string): string {
  switch (nodeType) {
    case 'api':
      return '#4f46e5';
    case 'table':
    case 'column':
      return '#0f766e';
    case 'function':
      return '#7c3aed';
    case 'aggregate':
      return '#64748b';
    default:
      return '#2563eb';
  }
}

export function GraphRuntimeCanvas(props: {
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>;
  layout?: GraphViewSnapshot['layout'];
  appLanguage: AppLanguage;
  currentNodeId?: string | null;
  currentEdgeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
  onOpenGraphSource?: (source: { sourceRef: string; lineStart?: number }) => void;
  onCreateTaskFromNode?: (nodeId: string) => void;
}) {
  const copy = getLanguageCopy(props.appLanguage).codeMapWorkspace;
  const sigmaContainerRef = useRef<HTMLDivElement | null>(null);
  const reactFlowContainerRef = useRef<HTMLDivElement | null>(null);
  const sigmaGraph = useMemo(
    () =>
      buildSigmaRuntimeGraph({
        nodes: props.nodes,
        edges: props.edges,
        layout: props.layout,
      }),
    [props.nodes, props.edges, props.layout],
  );
  const reactFlowElements = useMemo(() => toReactFlowElements({ nodes: props.nodes, edges: props.edges }), [props.nodes, props.edges]);

  useEffect(() => {
    if (!sigmaContainerRef.current || props.nodes.length === 0 || typeof window === 'undefined') return undefined;
    let disposed = false;
    let sigmaRenderer: SigmaRendererInstance | undefined;

    void (async () => {
      const [{ default: Graph }, { default: Sigma }] = await Promise.all([
        import('graphology') as unknown as Promise<{
          default: GraphologyGraphConstructor;
        }>,
        import('sigma') as unknown as Promise<{
          default: SigmaRendererConstructor;
        }>,
        // 动态加载 React Flow 运行时，避免服务端静态渲染时访问浏览器 API。
        import('@xyflow/react'),
      ]);
      if (disposed || !sigmaContainerRef.current) return;
      const graph = new Graph();
      for (const node of sigmaGraph.nodes) graph.addNode(node.key, node.attributes);
      for (const edge of sigmaGraph.edges) graph.addDirectedEdgeWithKey(edge.key, edge.source, edge.target, edge.attributes);
      // Sigma/WebGL 只渲染真实转换后的 Graphology 图，不补造空节点或演示边。
      sigmaRenderer = new Sigma(graph, sigmaContainerRef.current, {
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: 12,
        allowInvalidContainer: true,
      });
      if (reactFlowContainerRef.current) reactFlowContainerRef.current.dataset.runtimeReady = 'true';
    })();

    return () => {
      disposed = true;
      sigmaRenderer?.kill();
    };
  }, [props.nodes.length, sigmaGraph]);

  if (props.nodes.length === 0) {
    return (
      <section className="graph-runtime-canvas" aria-label={copy.graphRuntime}>
        <article className="graph-runtime-pane" aria-label={copy.sigmaTitle}>
          <h3>{copy.sigmaTitle}</h3>
          <p>{copy.sigmaEmpty}</p>
        </article>
        <article className="graph-runtime-pane" aria-label={copy.reactFlowTitle}>
          <h3>{copy.reactFlowTitle}</h3>
          <p>{copy.reactFlowEmpty}</p>
        </article>
      </section>
    );
  }

  return (
    <section className="graph-runtime-canvas" aria-label={copy.graphRuntime}>
      <article className="graph-runtime-pane" aria-label={copy.sigmaTitle}>
        <div className="graph-canvas-header">
          <h3>{copy.sigmaTitle}</h3>
          <span>
            {copy.nodeCount(sigmaGraph.nodes.length)} · {copy.edgeCount(sigmaGraph.edges.length)}
          </span>
        </div>
        <div className="graph-runtime-mount" data-runtime="sigma" ref={sigmaContainerRef} />
        <div className="graph-runtime-facts" aria-label={copy.sigmaSourceAria}>
          {sigmaGraph.nodes.slice(0, 4).map((node) => (
            <span key={node.key}>{node.attributes.label}</span>
          ))}
          {sigmaGraph.edges.slice(0, 3).map((edge) => (
            <small key={edge.key}>
              {formatGraphEdgeType(edge.attributes.label, props.appLanguage)} {edge.attributes.confidence.toFixed(2)}
            </small>
          ))}
        </div>
      </article>
      <article className="graph-runtime-pane" aria-label={copy.reactFlowTitle}>
        <div className="graph-canvas-header">
          <h3>{copy.reactFlowTitle}</h3>
          <span>
            {copy.nodeCount(reactFlowElements.nodes.length)} · {copy.edgeCount(reactFlowElements.edges.length)}
          </span>
        </div>
        <div className="graph-runtime-mount" data-runtime="react-flow" ref={reactFlowContainerRef}>
          {reactFlowElements.nodes.slice(0, 5).map((node) => (
            <button
              type="button"
              className={`react-flow-node-summary${props.currentNodeId === String(node.id) ? ' current-graph-runtime-object' : ''}`}
              data-react-flow-node-id={node.id}
              aria-current={props.currentNodeId === String(node.id) ? 'true' : undefined}
              onClick={() => props.onSelectNode?.(String(node.id))}
              key={node.id}
            >
              <strong>{node.data.label}</strong>
              <span>{formatGraphNodeType(String(node.type), props.appLanguage)}</span>
              <small>{node.data.sourceRef}</small>
            </button>
          ))}
        </div>
        <div className="graph-runtime-facts" aria-label={copy.reactFlowEdgesAria}>
          {reactFlowElements.edges.slice(0, 4).map((edge) => (
            <button
              type="button"
              className={`react-flow-edge-summary${props.currentEdgeId === String(edge.id) ? ' current-graph-runtime-object' : ''}`}
              data-react-flow-edge-id={edge.id}
              aria-current={props.currentEdgeId === String(edge.id) ? 'true' : undefined}
              onClick={() => props.onSelectEdge?.(String(edge.id))}
              key={edge.id}
            >
              {formatGraphRuntimeEdgeLabel(String(edge.label ?? ''), props.appLanguage)}
            </button>
          ))}
        </div>
      </article>
    </section>
  );
}
export function GraphCanvas(props: {
  title?: string;
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>;
  layout?: GraphViewSnapshot['layout'];
  viewType?: GraphViewType;
  architectureModel?: ArchitectureLayerModel | null;
  appLanguage: AppLanguage;
  currentNodeId?: string | null;
  currentEdgeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  onSelectEdge?: (edgeId: string) => void;
  onClearSelection?: () => void;
  onOpenGraphSource?: (source: { sourceRef: string; lineStart?: number }) => void;
  onCreateTaskFromNode?: (nodeId: string) => void;
}) {
  const copy = getLanguageCopy(props.appLanguage).codeMapWorkspace;
  const interactionCopy =
    props.appLanguage === 'zh-CN'
      ? {
          zoomOut: '缩小图谱',
          zoomIn: '放大图谱',
          fit: '适配',
          minimap: '图谱小地图',
        }
      : {
          zoomOut: 'Zoom out',
          zoomIn: 'Zoom in',
          fit: 'Fit',
          minimap: 'Graph minimap',
        };
  const isSequenceGraphView = props.viewType === 'api_sequence' || props.viewType === 'method_logic';
  const sourceWidth = normalizeGraphCanvasDimension(props.layout?.width, 720, 1440);
  const sourceHeight = normalizeGraphCanvasDimension(props.layout?.height, 300, 900);
  // 时序图世界坐标随生命线与消息数量增长，视口仍由 viewBox 控制，避免把大型链路压进固定 1440×900 后相互覆盖。
  const width = isSequenceGraphView ? Math.max(sourceWidth, props.nodes.length * 150 + 120) : sourceWidth;
  const height = isSequenceGraphView ? Math.max(sourceHeight, props.edges.length * 42 + 150) : sourceHeight;
  const layout = useMemo(() => buildGraphCanvasLayout(props.nodes, width, height, props.layout), [height, props.layout, props.nodes, width]);
  const visibleEdges = useMemo(() => {
    const visibleNodeIds = new Set(props.nodes.map((node) => node.id));
    return props.edges
      .filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId))
      .map(
        (edge): AggregatedGraphEdge =>
          'aggregateCount' in edge
            ? edge
            : {
                ...edge,
                aggregateCount: 1,
                sourceRefs: [edge.sourceRef],
                edgeIds: [edge.id],
              },
      );
  }, [props.edges, props.nodes]);
  const baseViewport = useMemo(() => buildGraphCanvasViewport(layout, props.nodes.length, width, height, isSequenceGraphView), [height, isSequenceGraphView, layout, props.nodes.length, width]);
  const graphModelKey = useMemo(() => `${props.viewType ?? 'graph'}:${props.nodes.map((node) => node.id).join('|')}:${visibleEdges.map((edge) => edge.id).join('|')}`, [props.nodes, props.viewType, visibleEdges]);
  const [camera, setCamera] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const cameraDragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    panX: number;
    panY: number;
    viewportWidth: number;
    viewportHeight: number;
    elementWidth: number;
    elementHeight: number;
  } | null>(null);
  const canvasLabel = isSequenceGraphView ? copy.sequenceGraphCanvas : copy.graphCanvas;
  const canvasTitle = isSequenceGraphView ? canvasLabel : props.title?.trim() || canvasLabel;
  const cameraViewport = {
    x: baseViewport.x + camera.panX + (baseViewport.width - baseViewport.width / camera.zoom) / 2,
    y: baseViewport.y + camera.panY + (baseViewport.height - baseViewport.height / camera.zoom) / 2,
    width: baseViewport.width / camera.zoom,
    height: baseViewport.height / camera.zoom,
  };

  useEffect(() => {
    setCamera({ zoom: 1, panX: 0, panY: 0 });
    setIsPanning(false);
    cameraDragRef.current = null;
  }, [graphModelKey]);

  const setGraphZoom = (nextZoom: number): void => {
    setCamera((current) => ({
      ...current,
      zoom: Math.min(2.4, Math.max(0.6, Math.round(nextZoom * 10) / 10)),
    }));
  };

  const fitGraphCanvas = (): void => {
    setCamera({ zoom: 1, panX: 0, panY: 0 });
  };

  const handleGraphCanvasPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    props.onClearSelection?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    cameraDragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panX: camera.panX,
      panY: camera.panY,
      viewportWidth: cameraViewport.width,
      viewportHeight: cameraViewport.height,
      elementWidth: Math.max(1, bounds.width),
      elementHeight: Math.max(1, bounds.height),
    };
    setIsPanning(true);
  };

  const handleGraphCanvasPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const drag = cameraDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextPanX = drag.panX - ((event.clientX - drag.clientX) / drag.elementWidth) * drag.viewportWidth;
    const nextPanY = drag.panY - ((event.clientY - drag.clientY) / drag.elementHeight) * drag.viewportHeight;
    setCamera((current) => ({
      ...current,
      panX: Math.max(-baseViewport.width, Math.min(baseViewport.width, nextPanX)),
      panY: Math.max(-baseViewport.height, Math.min(baseViewport.height, nextPanY)),
    }));
  };

  const finishGraphCanvasPan = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (cameraDragRef.current?.pointerId !== event.pointerId) return;
    cameraDragRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleGraphCanvasWheel = (event: ReactWheelEvent<SVGSVGElement>): void => {
    event.preventDefault();
    setGraphZoom(camera.zoom + (event.deltaY < 0 ? 0.1 : -0.1));
  };

  const canvasControls = (
    <nav className="graph-canvas-controls" aria-label={canvasLabel}>
      <button type="button" aria-label={interactionCopy.zoomOut} onClick={() => setGraphZoom(camera.zoom - 0.1)}>
        −
      </button>
      <output aria-live="polite">{Math.round(camera.zoom * 100)}%</output>
      <button type="button" aria-label={interactionCopy.zoomIn} onClick={() => setGraphZoom(camera.zoom + 0.1)}>
        ＋
      </button>
      <button type="button" onClick={fitGraphCanvas}>
        {interactionCopy.fit}
      </button>
    </nav>
  );

  if (props.nodes.length === 0) {
    return (
      <section className="graph-canvas" aria-label={copy.graphCanvas}>
        <div className="graph-canvas-empty">
          <h3>{canvasTitle}</h3>
          <p>{copy.canvasEmpty}</p>
        </div>
      </section>
    );
  }

  if (props.viewType === 'architecture' && props.architectureModel) {
    return (
      <ArchitectureGraphCanvas
        model={props.architectureModel}
        appLanguage={props.appLanguage}
        zoom={camera.zoom}
        controls={canvasControls}
        currentNodeId={props.currentNodeId}
        currentEdgeId={props.currentEdgeId}
        onSelectNode={props.onSelectNode}
        onSelectEdge={props.onSelectEdge}
        onClearSelection={props.onClearSelection}
        onOpenGraphSource={props.onOpenGraphSource}
      />
    );
  }

  // 接口时序图与方法逻辑图都使用同一套交互式时序舞台，避免方法调用链回退成普通节点云。
  if (isSequenceGraphView) {
    const sequenceLayout = buildGraphSequenceCanvasLayout(props.nodes, visibleEdges, width, height, props.appLanguage);
    const handleSequenceNodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, nodeId: string): void => {
      const node = props.nodes.find((item) => item.id === nodeId);
      if (event.key.toLowerCase() === 'o' && node) {
        event.preventDefault();
        openGraphSequenceNodeSource(node);
        return;
      }
      if (event.key.toLowerCase() === 't' && node) {
        event.preventDefault();
        createGraphSequenceNodeTask(node);
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      props.onSelectNode?.(nodeId);
    };
    const handleSequenceEdgeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, edgeId: string): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      props.onSelectEdge?.(edgeId);
    };
    const handleSequenceFragmentKeyDown = (event: ReactKeyboardEvent<SVGGElement>, edgeId: string): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      props.onSelectEdge?.(edgeId);
    };
    const handleSequenceFragmentOperandKeyDown = (event: ReactKeyboardEvent<SVGGElement>, edgeId: string): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      props.onSelectEdge?.(edgeId);
    };
    const openGraphSequenceNodeSource = (node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): void => {
      const sourceRef = resolveGraphSequenceNodeSourceRef(node);
      if (!sourceRef) return;
      const lineStart = resolveGraphSequenceNodeLineStart(node);
      // 时序图节点直接复用 main 进程的安全源码打开通道，不在 renderer 拼绝对路径或绕过项目根目录校验。
      props.onOpenGraphSource?.({
        sourceRef,
        lineStart: typeof lineStart === 'number' ? lineStart : undefined,
      });
    };
    const createGraphSequenceNodeTask = (node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): void => {
      if (isAggregatedGraphNode(node)) return;
      // 时序图节点直接复用图谱节点创建任务能力，让“看懂调用链”后的下一步进入任务列表主路径。
      props.onCreateTaskFromNode?.(node.id);
    };

    return (
      <section className="graph-canvas graph-sequence-stage" aria-label={canvasLabel}>
        <svg
          className={`graph-canvas-svg graph-sequence-svg${isPanning ? ' is-panning' : ''}`}
          role="group"
          aria-label={canvasLabel}
          viewBox={`${cameraViewport.x} ${cameraViewport.y} ${cameraViewport.width} ${cameraViewport.height}`}
          onPointerDown={handleGraphCanvasPointerDown}
          onPointerMove={handleGraphCanvasPointerMove}
          onPointerUp={finishGraphCanvasPan}
          onPointerCancel={finishGraphCanvasPan}
          onWheel={handleGraphCanvasWheel}
        >
          <defs>
            <marker id="graph-sequence-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          </defs>
          {sequenceLayout.fragments.map((fragment) => {
            return (
              <g
                className={`graph-sequence-fragment graph-sequence-fragment-${fragment.kind}${props.currentEdgeId === fragment.edgeIds[0] ? ' current-graph-canvas-object' : ''}`}
                data-sequence-fragment-kind={fragment.kind}
                data-sequence-fragment-guard={fragment.guardText ?? undefined}
                data-sequence-fragment-edge-count={String(fragment.edgeCount)}
                data-sequence-fragment-operand-count={String(fragment.operands.length)}
                data-sequence-fragment-edge-id={fragment.edgeIds[0]}
                data-sequence-fragment-inferred="true"
                key={fragment.id}
                role="button"
                tabIndex={0}
                aria-current={props.currentEdgeId === fragment.edgeIds[0] ? 'true' : undefined}
                aria-keyshortcuts="Enter Space"
                aria-label={`${fragment.label}${fragment.guardText ? ` · ${fragment.guardText}` : ''}`}
                onClick={() => props.onSelectEdge?.(fragment.edgeIds[0])}
                onKeyDown={(event) => handleSequenceFragmentKeyDown(event, fragment.edgeIds[0])}
              >
                <rect x={fragment.x} y={fragment.y} width={fragment.width} height={fragment.height} rx="8" />
                <rect className="graph-sequence-fragment-label-box" x={fragment.x + 8} y={fragment.y + 5} width={fragment.labelWidth} height="22" rx="5" />
                <text className="graph-sequence-fragment-label" x={fragment.x + 16} y={fragment.y + 20}>
                  {fragment.label}
                </text>
                {fragment.guardText ? (
                  <text className="graph-sequence-fragment-guard" x={fragment.x + 22 + fragment.label.length * 9} y={fragment.y + 20}>
                    {fragment.guardText}
                  </text>
                ) : null}
                {renderGraphSequenceFragmentOperands(fragment, props.appLanguage, props.onSelectEdge, handleSequenceFragmentOperandKeyDown)}
              </g>
            );
          })}
          {props.nodes.map((node) => {
            const lane = sequenceLayout.lifelines.get(node.id);
            if (!lane) return null;
            return (
              <g
                className={`graph-sequence-lifeline ${node.nodeType}${props.currentNodeId === node.id ? ' current-graph-canvas-object' : ''}`}
                key={node.id}
                role="button"
                tabIndex={0}
                aria-current={props.currentNodeId === node.id ? 'true' : undefined}
                aria-keyshortcuts={isAggregatedGraphNode(node) ? 'Enter Space' : 'Enter Space O T'}
                data-graph-node-id={node.id}
                data-graph-source-ref={resolveGraphSequenceNodeSourceRef(node)}
                data-graph-source-line={resolveGraphSequenceNodeLineStart(node) ?? undefined}
                aria-label={`${node.name} · ${formatGraphNodeType(node.nodeType, props.appLanguage)}`}
                onClick={() => props.onSelectNode?.(node.id)}
                onDoubleClick={() => openGraphSequenceNodeSource(node)}
                onKeyDown={(event) => handleSequenceNodeKeyDown(event, node.id)}
              >
                <rect className="graph-sequence-node-box" x={lane.x - lane.width / 2} y="22" width={lane.width} height="40" rx="6" />
                <text className="graph-sequence-node-name" x={lane.x} y="43">
                  {node.name}
                </text>
                <line className="graph-sequence-node-line" x1={lane.x} y1="72" x2={lane.x} y2={height - 28} />
                <title>
                  {isAggregatedGraphNode(node)
                    ? `${node.qualifiedName} · ${copy.aggregatedNodeSummary(node.aggregateCount, node.sourceRefs.length)}`
                    : `${node.qualifiedName} · ${resolveGraphSequenceNodeSourceRef(node)} · ${copy.openSourceShortcut} · ${copy.createTaskShortcut}`}
                </title>
              </g>
            );
          })}
          {sequenceLayout.activations.map((activation) => (
            <rect className="graph-sequence-activation" key={`${activation.nodeId}-${activation.y}`} x={activation.x - 5} y={activation.y} width="10" height={activation.height} rx="4" />
          ))}
          {visibleEdges.map((edge, index) => {
            const message = sequenceLayout.messages.get(edge.id);
            if (!message) return null;
            return (
              <g
                className={`graph-sequence-message${message.kind === 'self' ? ' graph-sequence-self-message' : ''}${message.kind === 'return' ? ' graph-sequence-return-message' : ''}${props.currentEdgeId === edge.id ? ' current-graph-canvas-object' : ''}`}
                key={edge.id}
                role="button"
                tabIndex={0}
                aria-current={props.currentEdgeId === edge.id ? 'true' : undefined}
                aria-keyshortcuts="Enter Space"
                data-graph-edge-id={edge.id}
                aria-label={formatGraphEdgeWithConfidence(edge, props.appLanguage)}
                onClick={() => props.onSelectEdge?.(edge.id)}
                onKeyDown={(event) => handleSequenceEdgeKeyDown(event, edge.id)}
              >
                {message.kind === 'self' ? (
                  <path d={`M ${message.sourceX} ${message.y} H ${message.loopX} V ${message.loopBottomY} H ${message.sourceX + 8}`} markerEnd="url(#graph-sequence-arrow)" />
                ) : (
                  <line x1={message.sourceX} y1={message.y} x2={message.targetX} y2={message.y} markerEnd="url(#graph-sequence-arrow)" />
                )}
                <text x={message.kind === 'self' ? (message.sourceX + message.loopX) / 2 : (message.sourceX + message.targetX) / 2} y={message.y - 8}>
                  {`${index + 1}: ${formatGraphEdgeWithConfidence(edge, props.appLanguage)}`}
                  {/* 来源数量是 UI 文案，必须跟随当前语言；真实 sourceRef 路径仍保持原文。 */}
                  {edge.sourceRefs.length > 1 ? ` · ${copy.sourceCount(edge.sourceRefs.length)}` : ''}
                </text>
              </g>
            );
          })}
        </svg>
        {canvasControls}
      </section>
    );
  }

  const handleGraphCanvasNodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): void => {
    if (event.key.toLowerCase() === 'o') {
      event.preventDefault();
      openGraphCanvasNodeSource(node);
      return;
    }
    if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      createGraphCanvasNodeTask(node);
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    props.onSelectNode?.(node.id);
  };
  const openGraphCanvasNodeSource = (node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): void => {
    const sourceRef = resolveGraphCanvasNodeSourceRef(node);
    if (!sourceRef) return;
    const lineStart = resolveGraphCanvasNodeLineStart(node);
    // 普通图谱节点和时序图 lifeline 使用同一条安全源码打开通道，避免用户必须先跳去右侧实体列表才能继续追代码。
    props.onOpenGraphSource?.({
      sourceRef,
      lineStart: typeof lineStart === 'number' ? lineStart : undefined,
    });
  };
  const createGraphCanvasNodeTask = (node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): void => {
    if (isAggregatedGraphNode(node)) return;
    // 方法逻辑图、模块图等普通节点也能直接进入任务主路径，保持“图谱是代码页主角”的交互闭环。
    props.onCreateTaskFromNode?.(node.id);
  };
  return (
    <section className="graph-canvas" aria-label={copy.graphCanvas}>
      <svg
        className={`graph-canvas-svg${isPanning ? ' is-panning' : ''}`}
        role="group"
        aria-label={copy.graphCanvas}
        viewBox={`${cameraViewport.x} ${cameraViewport.y} ${cameraViewport.width} ${cameraViewport.height}`}
        onPointerDown={handleGraphCanvasPointerDown}
        onPointerMove={handleGraphCanvasPointerMove}
        onPointerUp={finishGraphCanvasPan}
        onPointerCancel={finishGraphCanvasPan}
        onWheel={handleGraphCanvasWheel}
      >
        <defs>
          <marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>
        {visibleEdges.map((edge) => {
          const source = layout.get(edge.sourceNodeId);
          const target = layout.get(edge.targetNodeId);
          if (!source || !target) return null;
          const geometry = buildGraphCanvasEdgeGeometry(source, target, edge.sourceNodeId === edge.targetNodeId);
          return (
            <g
              className={`graph-canvas-edge${props.currentEdgeId === edge.id ? ' current-graph-canvas-object' : ''}`}
              key={edge.id}
              role="button"
              tabIndex={0}
              aria-current={props.currentEdgeId === edge.id ? 'true' : undefined}
              aria-keyshortcuts="Enter Space"
              data-graph-edge-id={edge.id}
              aria-label={formatGraphEdgeWithConfidence(edge, props.appLanguage)}
              onClick={(event) => {
                event.stopPropagation();
                props.onSelectEdge?.(edge.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                props.onSelectEdge?.(edge.id);
              }}
            >
              {geometry.kind === 'loop' ? <path d={geometry.path} markerEnd="url(#graph-arrow)" /> : <line x1={geometry.x1} y1={geometry.y1} x2={geometry.x2} y2={geometry.y2} markerEnd="url(#graph-arrow)" />}
              <text x={geometry.labelX} y={geometry.labelY}>
                {formatGraphEdgeWithConfidence(edge, props.appLanguage)}
                {/* 来源数量是 UI 文案，必须跟随当前语言；真实 sourceRef 路径仍保持原文。 */}
                {edge.sourceRefs.length > 1 ? ` · ${copy.sourceCount(edge.sourceRefs.length)}` : ''}
              </text>
            </g>
          );
        })}
        {props.nodes.map((node) => {
          const point = layout.get(node.id);
          if (!point) return null;
          return (
            <g
              className={`graph-canvas-node ${node.nodeType}${props.currentNodeId === node.id ? ' current-graph-canvas-object' : ''}`}
              key={node.id}
              transform={`translate(${point.x} ${point.y})`}
              role="button"
              tabIndex={0}
              aria-current={props.currentNodeId === node.id ? 'true' : undefined}
              aria-keyshortcuts={isAggregatedGraphNode(node) ? 'Enter Space' : 'Enter Space O T'}
              data-graph-node-id={node.id}
              data-graph-source-ref={resolveGraphCanvasNodeSourceRef(node)}
              data-graph-source-line={resolveGraphCanvasNodeLineStart(node) ?? undefined}
              aria-label={`${node.name} · ${formatGraphNodeType(node.nodeType, props.appLanguage)}`}
              onClick={(event) => {
                event.stopPropagation();
                props.onSelectNode?.(node.id);
              }}
              onDoubleClick={() => openGraphCanvasNodeSource(node)}
              onKeyDown={(event) => handleGraphCanvasNodeKeyDown(event, node)}
            >
              <rect className="graph-canvas-node-surface" x="-78" y="-30" width="156" height="60" rx="9" />
              <rect className="graph-canvas-node-kind" x="-78" y="-30" width="5" height="60" rx="3" />
              <text className="graph-canvas-node-name" x="-63" y="-4">
                {node.name.length > 24 ? `${node.name.slice(0, 23)}…` : node.name}
              </text>
              <text className="graph-canvas-node-type" x="-63" y="15">
                {formatGraphNodeType(node.nodeType, props.appLanguage)}
              </text>
              <title>
                {isAggregatedGraphNode(node)
                  ? `${node.qualifiedName} · ${copy.aggregatedNodeSummary(node.aggregateCount, node.sourceRefs.length)}`
                  : `${node.qualifiedName} · ${resolveGraphCanvasNodeSourceRef(node)} · ${copy.openSourceShortcut} · ${copy.createTaskShortcut}`}
              </title>
            </g>
          );
        })}
      </svg>
      {props.nodes.length > 6 ? (
        <button type="button" className="graph-canvas-minimap" aria-label={`${interactionCopy.minimap} · ${interactionCopy.fit}`} onClick={fitGraphCanvas}>
          <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {visibleEdges.map((edge) => {
              const source = layout.get(edge.sourceNodeId);
              const target = layout.get(edge.targetNodeId);
              if (!source || !target) return null;
              return <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} />;
            })}
            {props.nodes.map((node) => {
              const point = layout.get(node.id);
              return point ? <circle key={node.id} cx={point.x} cy={point.y} r={Math.max(7, width / 90)} /> : null;
            })}
            <rect className="graph-canvas-minimap-viewport" x={cameraViewport.x} y={cameraViewport.y} width={cameraViewport.width} height={cameraViewport.height} />
          </svg>
        </button>
      ) : null}
      {canvasControls}
    </section>
  );
}

export function buildGraphCanvasEdgeGeometry(
  source: { x: number; y: number },
  target: { x: number; y: number },
  selfLoop: boolean,
): { kind: 'loop'; path: string; labelX: number; labelY: number } | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; labelX: number; labelY: number } {
  if (selfLoop) {
    return {
      kind: 'loop',
      path: `M ${source.x + 78} ${source.y} C ${source.x + 72} ${source.y - 58}, ${source.x + 20} ${source.y - 74}, ${source.x} ${source.y - 30}`,
      labelX: source.x + 38,
      labelY: source.y - 52,
    };
  }
  const deltaX = target.x - source.x;
  const deltaY = target.y - source.y;
  const horizontalIntersection = Math.abs(deltaX) > 0 ? 78 / Math.abs(deltaX) : Number.POSITIVE_INFINITY;
  const verticalIntersection = Math.abs(deltaY) > 0 ? 30 / Math.abs(deltaY) : Number.POSITIVE_INFINITY;
  const intersectionScale = Math.min(0.49, horizontalIntersection, verticalIntersection);
  const x1 = source.x + deltaX * intersectionScale;
  const y1 = source.y + deltaY * intersectionScale;
  const x2 = target.x - deltaX * intersectionScale;
  const y2 = target.y - deltaY * intersectionScale;
  return {
    kind: 'line',
    x1,
    y1,
    x2,
    y2,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2 - 8,
  };
}

export function resolveGraphCanvasNodeSourceRef(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): string {
  if (isAggregatedGraphNode(node)) return '';
  return node.sourceRef;
}

export function resolveGraphCanvasNodeLineStart(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): number | null {
  if (isAggregatedGraphNode(node)) return null;
  return typeof node.metadata?.lineStart === 'number' ? node.metadata.lineStart : null;
}

export type GraphSequenceLane = { x: number; width: number };
export type GraphSequenceMessage =
  | { kind: 'call'; sourceX: number; targetX: number; y: number }
  | { kind: 'return'; sourceX: number; targetX: number; y: number }
  | { kind: 'self'; sourceX: number; targetX: number; y: number; loopX: number; loopBottomY: number };
export type GraphSequenceActivation = { nodeId: string; x: number; y: number; height: number };
export type GraphSequenceFragmentKind = 'alt' | 'loop' | 'catch' | 'finally' | 'branch';
export type GraphSequenceFragmentOperand = { guardText: string; y: number; edgeId: string };
export type GraphSequenceFragment = {
  id: string;
  kind: GraphSequenceFragmentKind;
  label: string;
  guardText: string | null;
  operands: GraphSequenceFragmentOperand[];
  edgeIds: string[];
  edgeCount: number;
  labelWidth: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export function resolveGraphSequenceNodeSourceRef(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): string {
  if (isAggregatedGraphNode(node)) return '';
  return node.sourceRef;
}

export function resolveGraphSequenceNodeLineStart(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): number | null {
  if (isAggregatedGraphNode(node)) return null;
  const lineStart = node.metadata.lineStart;
  return typeof lineStart === 'number' ? lineStart : null;
}

export function renderGraphSequenceFragmentOperands(
  fragment: GraphSequenceFragment,
  appLanguage: AppLanguage,
  onSelectEdge: ((edgeId: string) => void) | undefined,
  onOperandKeyDown: (event: ReactKeyboardEvent<SVGGElement>, edgeId: string) => void,
): ReactNode {
  if (fragment.kind !== 'alt' || fragment.operands.length < 2) return null;

  return fragment.operands.map((operand, index) => (
    <g
      className="graph-sequence-fragment-operand"
      data-sequence-fragment-operand={operand.guardText}
      data-sequence-fragment-operand-edge-id={operand.edgeId}
      key={`${fragment.id}-operand-${index}`}
      role="button"
      tabIndex={0}
      aria-label={formatGraphSequenceOperandAriaLabel(fragment.label, operand.guardText, appLanguage)}
      onClick={(event) => {
        event.stopPropagation();
        onSelectEdge?.(operand.edgeId);
      }}
      onKeyDown={(event) => onOperandKeyDown(event, operand.edgeId)}
    >
      {index > 0 ? <line className="graph-sequence-fragment-operand-line" x1={fragment.x + 8} x2={fragment.x + fragment.width - 8} y1={Math.max(fragment.y + 36, operand.y - 28)} y2={Math.max(fragment.y + 36, operand.y - 28)} /> : null}
      {/* 聚合 alt frame 内继续保留每个 guard 分支标签，避免多分支被压成一个不可读标题。 */}
      <text className="graph-sequence-fragment-operand-label" x={fragment.x + 16} y={operand.y}>
        {operand.guardText}
      </text>
    </g>
  ));
}

export function formatGraphSequenceOperandAriaLabel(label: string, guardText: string, appLanguage: AppLanguage): string {
  return appLanguage === 'zh-CN' ? `${label} 分支 · ${guardText}` : `${label} operand · ${guardText}`;
}

export function buildGraphSequenceCanvasLayout(nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>, edges: AggregatedGraphEdge[], width: number, height: number, appLanguage: AppLanguage) {
  const lifelines = new Map<string, GraphSequenceLane>();
  const messages = new Map<string, GraphSequenceMessage>();
  const activations: GraphSequenceActivation[] = [];
  const horizontalInset = Math.min(84, Math.max(42, width * 0.08));
  const usableWidth = Math.max(1, width - horizontalInset * 2);
  const laneStep = nodes.length <= 1 ? 0 : usableWidth / (nodes.length - 1);

  nodes.forEach((node, index) => {
    lifelines.set(node.id, {
      x: Math.round(horizontalInset + laneStep * index),
      width: Math.min(168, Math.max(92, Math.round(usableWidth / Math.max(2, nodes.length)))),
    });
  });

  const messageStartY = 92;
  const messageStep = Math.max(34, Math.min(58, Math.floor((height - 140) / Math.max(1, edges.length))));
  edges.forEach((edge, index) => {
    const source = lifelines.get(edge.sourceNodeId);
    const target = lifelines.get(edge.targetNodeId);
    if (!source || !target) return;
    const y = Math.min(height - 44, messageStartY + index * messageStep);
    if (edge.sourceNodeId === edge.targetNodeId) {
      const loopX = Math.min(width - 24, source.x + Math.min(96, Math.max(54, source.width * 0.56)));
      messages.set(edge.id, {
        kind: 'self',
        sourceX: source.x,
        targetX: target.x,
        y,
        loopX,
        loopBottomY: Math.min(height - 36, y + Math.max(26, Math.min(42, messageStep * 0.72))),
      });
    } else if (isGraphSequenceReturnEdge(edge)) {
      messages.set(edge.id, {
        kind: 'return',
        sourceX: source.x,
        targetX: target.x,
        y,
      });
    } else {
      messages.set(edge.id, {
        kind: 'call',
        sourceX: source.x,
        targetX: target.x,
        y,
      });
    }
    // 激活条表达“此 lifeline 正在处理调用”，让 API 时序图从平面连线升级为接近 IDEA SequenceDiagram 的执行语义。
    activations.push({
      nodeId: edge.targetNodeId,
      x: target.x,
      y: Math.max(62, y - 12),
      height: Math.max(28, Math.min(46, messageStep + 8)),
    });
  });

  const fragments = buildGraphSequenceFragments(edges, lifelines, messages, new Map(nodes.map((node) => [node.id, node])), width, height, appLanguage);

  return { lifelines, messages, activations, fragments };
}

export function buildGraphSequenceFragments(
  edges: AggregatedGraphEdge[],
  lifelines: Map<string, GraphSequenceLane>,
  messages: Map<string, GraphSequenceMessage>,
  nodesById: Map<string, GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>,
  width: number,
  height: number,
  appLanguage: AppLanguage,
): GraphSequenceFragment[] {
  const fragments = edges.flatMap((edge) => {
    if (!isGraphSequenceBranchEdge(edge, nodesById)) return [];
    const source = lifelines.get(edge.sourceNodeId);
    const target = lifelines.get(edge.targetNodeId);
    const message = messages.get(edge.id);
    if (!source || !target || !message) return [];
    const left = Math.max(18, Math.min(source.x, target.x) - 26);
    const right = Math.min(width - 18, Math.max(source.x, target.x) + 26);
    const top = Math.max(64, message.y - 28);
    const bottom = Math.min(height - 30, message.y + 46);

    const kind = resolveGraphSequenceFragmentKind(edge, nodesById);
    const fragmentKindLabel = formatGraphSequenceFragmentLabel(kind, appLanguage);
    // 当前 fragment 来自静态节点/关系名称推导，直接写入可见标签，不能冒充运行时或显式语法事实。
    const label = appLanguage === 'zh-CN' ? `${fragmentKindLabel} · 静态推导` : `${fragmentKindLabel} · inferred`;
    const guardText = formatGraphSequenceFragmentGuard(kind, edge, nodesById);

    return [
      {
        id: `${edge.id}-fragment`,
        kind,
        label,
        guardText,
        operands: guardText ? [{ guardText, y: Math.min(bottom - 12, message.y + 16), edgeId: edge.id }] : [],
        edgeIds: [edge.id],
        edgeCount: 1,
        labelWidth: Math.max(34, label.length * 9 + 18 + (guardText ? guardText.length * 7 + 8 : 0)),
        x: left,
        y: top,
        width: Math.max(92, right - left),
        height: Math.max(50, bottom - top),
      },
    ];
  });

  return mergeGraphSequenceFragments(fragments);
}

export function mergeGraphSequenceFragments(fragments: GraphSequenceFragment[]): GraphSequenceFragment[] {
  const merged: GraphSequenceFragment[] = [];
  for (const fragment of fragments) {
    const previous = merged.at(-1);
    if (!previous || previous.kind !== fragment.kind) {
      merged.push({ ...fragment });
      continue;
    }
    const x = Math.min(previous.x, fragment.x);
    const y = Math.min(previous.y, fragment.y);
    const right = Math.max(previous.x + previous.width, fragment.x + fragment.width);
    const bottom = Math.max(previous.y + previous.height, fragment.y + fragment.height);
    const guards = [previous.guardText, fragment.guardText].filter((item): item is string => Boolean(item));
    const guardText = Array.from(new Set(guards)).join(' · ') || null;
    const operands = [...previous.operands, ...fragment.operands];
    const edgeIds = Array.from(new Set([...previous.edgeIds, ...fragment.edgeIds]));
    // 相邻同类 fragment 聚合成一个 SequenceDiagram frame，避免多条 guard 边把画布切成碎框。
    merged[merged.length - 1] = {
      ...previous,
      id: `${previous.id}+${fragment.id}`,
      guardText,
      operands,
      edgeIds,
      edgeCount: previous.edgeCount + fragment.edgeCount,
      labelWidth: Math.max(34, previous.label.length * 9 + 18 + (guardText ? guardText.length * 7 + 8 : 0)),
      x,
      y,
      width: Math.max(92, right - x),
      height: Math.max(50, bottom - y),
    };
  }
  return merged;
}

export function isGraphSequenceBranchEdge(edge: AggregatedGraphEdge, nodesById: Map<string, GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>): boolean {
  if (/\b(call|calls|executes|executes_sql|reads_table|writes_table|uses_column|references|contains|declares)\b/iu.test(edge.edgeType)) return false;
  const source = nodesById.get(edge.sourceNodeId);
  const target = nodesById.get(edge.targetNodeId);
  const searchableText = [edge.edgeType, source?.nodeType, target?.nodeType, source?.name, target?.name, source?.qualifiedName, target?.qualifiedName].filter(Boolean).join(' ');

  return /\b(branch|branches|condition|conditional|guard|if|else|switch|case|try|catch|finally|cleanup|loop)\b/iu.test(searchableText);
}

export function resolveGraphSequenceFragmentKind(edge: AggregatedGraphEdge, nodesById: Map<string, GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>): GraphSequenceFragmentKind {
  const source = nodesById.get(edge.sourceNodeId);
  const target = nodesById.get(edge.targetNodeId);
  const searchableText = [edge.edgeType, source?.nodeType, target?.nodeType, source?.name, target?.name, source?.qualifiedName, target?.qualifiedName].filter(Boolean).join(' ');
  // SequenceDiagram fragment operator 采用 UML 约定词，避免中文/英文切换时把 alt、loop、finally 这类图形语义翻译散。
  if (/\b(try_finally|finally|cleanup)\b/iu.test(searchableText)) return 'finally';
  if (/\b(loop|loop_back|loop_break|loop_continue|while|for|foreach)\b/iu.test(searchableText)) return 'loop';
  if (/\b(try_catch|catch|promise_catch)\b/iu.test(searchableText)) return 'catch';
  if (/\b(branch|branches|condition|conditional|guard|if|else|switch|case|control_flow)\b/iu.test(searchableText)) return 'alt';
  return 'branch';
}

export function formatGraphSequenceFragmentLabel(kind: GraphSequenceFragmentKind, appLanguage: AppLanguage): string {
  if (kind === 'branch') return appLanguage === 'en-US' ? 'branch' : '分支';
  return kind;
}

export function formatGraphSequenceFragmentGuard(kind: GraphSequenceFragmentKind, edge: AggregatedGraphEdge, nodesById: Map<string, GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>): string | null {
  if (kind === 'branch') return null;
  const target = nodesById.get(edge.targetNodeId);
  const source = nodesById.get(edge.sourceNodeId);
  const rawGuard = normalizeGraphSequenceGuardText(kind, target?.name || target?.qualifiedName || source?.name || '');
  return rawGuard ? `[${rawGuard}]` : null;
}

export function normalizeGraphSequenceGuardText(kind: GraphSequenceFragmentKind, value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (kind === 'alt') return text.replace(/^(?:if|else if|guard|condition)\s+/iu, '').trim();
  if (kind === 'loop') return text.replace(/^(?:loop)\s+/iu, '').trim();
  if (kind === 'finally') return text.replace(/^finally\s+/iu, '').trim();
  if (kind === 'catch') return text.replace(/^(?:catch|promise catch)\s+/iu, '').trim();
  return text;
}

export function isGraphSequenceReturnEdge(edge: AggregatedGraphEdge): boolean {
  // SequenceDiagram 里 return / finally / promise continuation 语义应以虚线消息表达，避免被误读成新的同步调用。
  return /\b(return|returns|returned|try_finally|finally|cleanup|promise_then|then|promise_catch|catch)\b/iu.test(edge.edgeType);
}

export function buildGraphCanvasLayout(nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>, width: number, height: number, serverLayout?: GraphViewSnapshot['layout']) {
  const layout = new Map<string, { x: number; y: number }>();
  const serverPositions = new Map((serverLayout?.positions ?? []).map((position) => [position.nodeId, { x: position.x, y: position.y }]));
  const centerX = width / 2;
  const centerY = height / 2;
  const radiusX = Math.max(190, width / 2 - 96);
  const radiusY = Math.max(72, height / 2 - 64);

  nodes.forEach((node, index) => {
    const serverPosition = serverPositions.get(node.id);
    if (serverPosition) {
      // 服务端在超大图谱下会给出真实全局坐标；桌面画布只消费压缩后的视窗坐标，避免 macOS 窗口被几万像素的 SVG/WebGL 画布撑开。
      layout.set(node.id, normalizeServerGraphPosition(serverPosition, serverLayout, width, height));
      return;
    }
    // 使用确定性椭圆布局，避免服务端渲染与前端渲染产生随机差异。
    const angle = nodes.length === 1 ? -Math.PI / 2 : -Math.PI / 2 + (index / nodes.length) * Math.PI * 2;
    layout.set(node.id, {
      x: Math.round(centerX + Math.cos(angle) * radiusX),
      y: Math.round(centerY + Math.sin(angle) * radiusY),
    });
  });

  return compactSmallGraphCanvasLayout(layout, nodes.length, width, height, Boolean(serverLayout));
}

export function buildGraphNeighborhoodLayout(
  centerNodeId: string,
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>,
  edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>,
): NonNullable<GraphViewSnapshot['layout']> {
  const width = 900;
  const height = 720;
  const center = { x: width / 2, y: Math.round(height * 0.56) };
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const oneHopIds = new Set<string>();

  for (const edge of edges) {
    if (edge.sourceNodeId === centerNodeId && visibleNodeIds.has(edge.targetNodeId)) oneHopIds.add(edge.targetNodeId);
    if (edge.targetNodeId === centerNodeId && visibleNodeIds.has(edge.sourceNodeId)) oneHopIds.add(edge.sourceNodeId);
  }

  const innerNodes = nodes.filter((node) => node.id !== centerNodeId && oneHopIds.has(node.id));
  const outerNodes = nodes.filter((node) => node.id !== centerNodeId && !oneHopIds.has(node.id));
  // 一跳节点过多时拆成双环，避免 156px 节点卡片在中心周围互相覆盖。
  if (outerNodes.length === 0 && innerNodes.length > 10) outerNodes.push(...innerNodes.splice(10));

  const positions: NonNullable<GraphViewSnapshot['layout']>['positions'] = [];
  if (visibleNodeIds.has(centerNodeId)) positions.push({ nodeId: centerNodeId, ...center });

  const placeRing = (ringNodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>, radiusX: number, radiusY: number, angleOffset: number): void => {
    ringNodes.forEach((node, index) => {
      const angle = angleOffset + (index / Math.max(1, ringNodes.length)) * Math.PI * 2;
      positions.push({
        nodeId: node.id,
        x: Math.round(center.x + Math.cos(angle) * radiusX),
        y: Math.round(center.y + Math.sin(angle) * radiusY),
      });
    });
  };

  placeRing(innerNodes, 230, 160, -Math.PI / 2);
  placeRing(outerNodes, 350, 230, -Math.PI / 2 + Math.PI / Math.max(2, outerNodes.length));

  return {
    algorithm: 'radial-neighborhood',
    width,
    height,
    positions,
  };
}

export function buildGraphCanvasViewport(layout: Map<string, { x: number; y: number }>, nodeCount: number, width: number, height: number, isSequenceGraphView: boolean): { x: number; y: number; width: number; height: number } {
  if (isSequenceGraphView || nodeCount <= 0 || nodeCount > 8 || layout.size === 0) {
    return { x: 0, y: 0, width, height };
  }
  const points = Array.from(layout.values());
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const sourceWidth = Math.max(1, maxX - minX);
  const sourceHeight = Math.max(1, maxY - minY);
  const minViewportWidth = Math.min(width, Math.max(520, nodeCount * 130));
  const minViewportHeight = Math.min(height, Math.max(320, nodeCount * 72));
  const viewportWidth = Math.min(width, Math.max(minViewportWidth, sourceWidth + 280));
  const viewportHeight = Math.min(height, Math.max(minViewportHeight, sourceHeight + 220));
  const centerX = minX + sourceWidth / 2;
  const centerY = minY + sourceHeight / 2;
  // 小型普通图谱使用内容感知 viewBox，避免真实节点集中在中心时仍被整张服务端画布缩成截图里的小点。
  const x = Math.max(0, Math.min(width - viewportWidth, centerX - viewportWidth / 2));
  const y = Math.max(0, Math.min(height - viewportHeight, centerY - viewportHeight / 2));

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(viewportWidth),
    height: Math.round(viewportHeight),
  };
}

export function compactSmallGraphCanvasLayout(layout: Map<string, { x: number; y: number }>, nodeCount: number, width: number, height: number, fromServerLayout: boolean): Map<string, { x: number; y: number }> {
  if (!fromServerLayout || nodeCount < 3 || nodeCount > 8 || layout.size < 3) return layout;
  const points = Array.from(layout.values());
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const sourceWidth = Math.max(1, maxX - minX);
  const sourceHeight = Math.max(1, maxY - minY);
  const targetWidth = Math.min(Math.max(320, nodeCount * 170), Math.max(320, width - 220));
  const targetHeight = Math.min(Math.max(140, nodeCount * 70), Math.max(140, height - 280));
  const scale = Math.min(1, targetWidth / sourceWidth, targetHeight / sourceHeight);
  const sourceCenterX = minX + sourceWidth / 2;
  const sourceCenterY = minY + sourceHeight / 2;
  const targetCenterX = width / 2;
  const targetCenterY = height / 2;
  const minInsetX = Math.min(96, Math.max(40, width * 0.07));
  const minInsetY = Math.min(96, Math.max(72, height * 0.14));
  const compacted = new Map<string, { x: number; y: number }>();

  layout.forEach((point, nodeId) => {
    // 小型真实图谱如果完全照搬服务端大画布坐标，会在代码页产生大面积空白；这里只做等比例收束，不改变节点相对结构。
    const x = Math.round(targetCenterX + (point.x - sourceCenterX) * scale);
    const y = Math.round(targetCenterY + (point.y - sourceCenterY) * scale);
    compacted.set(nodeId, {
      x: Math.min(width - minInsetX, Math.max(minInsetX, x)),
      y: Math.min(height - minInsetY, Math.max(minInsetY, y)),
    });
  });

  return compacted;
}

export function normalizeGraphCanvasDimension(value: number | undefined, fallback: number, maxDesktopSize: number) {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  const rounded = Math.round(value);
  return rounded > maxDesktopSize * 2 ? maxDesktopSize : Math.max(fallback, rounded);
}

export function normalizeServerGraphPosition(position: { x: number; y: number }, serverLayout: GraphViewSnapshot['layout'] | undefined, width: number, height: number) {
  if (!serverLayout || (serverLayout.width === width && serverLayout.height === height)) return position;
  const serverWidth = Number.isFinite(serverLayout.width) && serverLayout.width > 0 ? serverLayout.width : width;
  const serverHeight = Number.isFinite(serverLayout.height) && serverLayout.height > 0 ? serverLayout.height : height;
  const insetX = Math.min(72, Math.max(24, width * 0.06));
  const insetY = Math.min(64, Math.max(24, height * 0.07));
  const usableWidth = Math.max(1, width - insetX * 2);
  const usableHeight = Math.max(1, height - insetY * 2);
  const x = Math.min(serverWidth, Math.max(0, position.x));
  const y = Math.min(serverHeight, Math.max(0, position.y));

  return {
    x: Math.round(insetX + (x / serverWidth) * usableWidth),
    y: Math.round(insetY + (y / serverHeight) * usableHeight),
  };
}

export const handleSourceListKeyboardNavigation = (event: ReactKeyboardEvent<HTMLElement>) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;

  const sourceListItems = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-source-list-item="true"]:not([disabled])'));
  if (sourceListItems.length === 0) return;

  // source-list 使用 roving focus：当前选中行保留 tabIndex=0，方向键只在列表内部移动焦点，不触发页面级滚动。
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activeIndex = activeElement ? sourceListItems.findIndex((item) => item === activeElement || item.contains(activeElement)) : -1;
  const rovingIndex = sourceListItems.findIndex((item) => item.getAttribute('tabindex') === '0');
  const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(rovingIndex, 0);
  let nextIndex = currentIndex;

  if (event.key === 'ArrowDown') nextIndex = Math.min(currentIndex + 1, sourceListItems.length - 1);
  if (event.key === 'ArrowUp') nextIndex = Math.max(currentIndex - 1, 0);
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = sourceListItems.length - 1;

  event.preventDefault();
  sourceListItems[nextIndex]?.focus();
};

export const handleInlineRailKeyboardNavigation = (event: ReactKeyboardEvent<HTMLElement>) => {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;

  const inlineRailItems = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-inline-rail-item="true"]:not([disabled])'));
  if (inlineRailItems.length === 0) return;

  // Decision rail 与二级菜单按 macOS toolbar 语义处理：Tab 进入，左右键在同一组动作内移动焦点。
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activeIndex = activeElement ? inlineRailItems.findIndex((item) => item === activeElement || item.contains(activeElement)) : -1;
  const currentIndex = activeIndex >= 0 ? activeIndex : 0;
  let nextIndex = currentIndex;

  if (event.key === 'ArrowRight') nextIndex = Math.min(currentIndex + 1, inlineRailItems.length - 1);
  if (event.key === 'ArrowLeft') nextIndex = Math.max(currentIndex - 1, 0);
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = inlineRailItems.length - 1;

  event.preventDefault();
  inlineRailItems[nextIndex]?.focus();
};

export function GraphNodeDetail(props: { node: GraphViewSnapshot['nodes'][number]; graphView: GraphViewSnapshot; expandedHopDepth?: 1 | 2; appLanguage: AppLanguage; isCurrent?: boolean }) {
  const copy = getLanguageCopy(props.appLanguage).codeMapWorkspace;
  const aggregateNode = isAggregatedGraphNode(props.node) ? props.node : null;
  const recentTasks = Array.isArray(props.node.metadata.recentTasks) ? props.node.metadata.recentTasks : [];
  const riskTags = Array.isArray(props.node.metadata.riskTags) ? props.node.metadata.riskTags.filter((tag): tag is string => typeof tag === 'string') : [];
  const aiSummary = typeof props.node.metadata.aiSummary === 'string' && props.node.metadata.aiSummary.trim() ? props.node.metadata.aiSummary.trim() : null;
  const lineRange = `${String(props.node.metadata.lineStart ?? '?')}-${String(props.node.metadata.lineEnd ?? '?')}`;
  const oneHopEdges = props.graphView.edges.filter((edge) => edge.sourceNodeId === props.node.id || edge.targetNodeId === props.node.id);
  const oneHopNodeIds = Array.from(new Set(oneHopEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]).filter((id) => id !== props.node.id)));
  const oneHopNodes = oneHopNodeIds.map((id) => props.graphView.nodes.find((node) => node.id === id)).filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
  const twoHopNodeIds = Array.from(
    new Set(
      props.graphView.edges
        .filter((edge) => oneHopNodeIds.includes(edge.sourceNodeId) || oneHopNodeIds.includes(edge.targetNodeId))
        .flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId])
        .filter((id) => id !== props.node.id && !oneHopNodeIds.includes(id)),
    ),
  );
  const twoHopNodes = twoHopNodeIds.map((id) => props.graphView.nodes.find((node) => node.id === id)).filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
  return (
    <aside className={`graph-detail-workbench graph-node-detail-workbench${props.isCurrent ? ' current-graph-detail' : ''}`} aria-label={copy.nodeDetail} aria-current={props.isCurrent ? 'true' : undefined}>
      <header className="graph-detail-header">
        <span className="graph-detail-title-copy">
          <strong>{copy.nodeDetail}</strong>
          <span>{props.node.qualifiedName}</span>
        </span>
        <span className="graph-detail-type-pill">{formatGraphNodeType(props.node.nodeType, props.appLanguage)}</span>
      </header>
      <section className="graph-detail-source-row" aria-label={copy.nodeSource}>
        <span className="graph-detail-source-copy">
          {aggregateNode ? (
            <>
              <strong>{copy.aggregatedNodeSummary(aggregateNode.aggregateCount, aggregateNode.sourceRefs.length)}</strong>
              {aggregateNode.sourceRefs.slice(0, 6).map((sourceRef) => (
                <small key={sourceRef}>{sourceRef}</small>
              ))}
              {aggregateNode.sourceRefs.length > 6 ? <small>+{aggregateNode.sourceRefs.length - 6}</small> : null}
            </>
          ) : (
            <>
              <strong>{props.node.sourceRef}</strong>
              <small>
                {copy.lineLabel} {lineRange} · {props.node.symbolId ?? copy.missingSymbol}
              </small>
            </>
          )}
        </span>
      </section>
      {aiSummary ? (
        <section className="graph-detail-context-row graph-detail-summary-row" aria-label={copy.aiSummary}>
          <span className="graph-detail-source-copy">
            <strong>{copy.aiSummary}</strong>
            <span>{aiSummary}</span>
          </span>
        </section>
      ) : null}
      {recentTasks.length > 0 ? (
        <section className="graph-detail-context-row graph-detail-task-row" aria-label={copy.recentTasks}>
          <span className="graph-detail-row-label">{copy.recentTasks}</span>
          <span className="graph-detail-context-list">
            {recentTasks.slice(0, 3).map((task, index) => {
              const taskRecord = task as {
                taskId?: string;
                title?: string;
                status?: string;
              };
              const taskStatusLabel = taskRecord.status ? (getLanguageCopy(props.appLanguage).taskStatuses[taskRecord.status as TaskStatus] ?? copy.unknownTaskStatus) : copy.unknownTaskStatus;
              return (
                <span key={taskRecord.taskId ?? index}>
                  {taskRecord.title ?? copy.unnamedTask} · {taskStatusLabel}
                </span>
              );
            })}
          </span>
        </section>
      ) : null}
      {oneHopNodes.length > 0 ? (
        <section className="graph-detail-context-row graph-detail-neighborhood-row" aria-label={copy.oneHopNeighbors}>
          <span className="graph-detail-row-label">{copy.oneHopNeighbors}</span>
          <span className="graph-detail-context-list">
            {oneHopNodes.slice(0, 4).map((node) => (
              <span key={node.id}>
                {node.name} · {formatGraphNodeType(node.nodeType, props.appLanguage)}
              </span>
            ))}
          </span>
        </section>
      ) : null}
      {twoHopNodes.length > 0 ? (
        <section className="graph-detail-context-row graph-detail-neighborhood-row" aria-label={copy.twoHopImpact} hidden={(props.expandedHopDepth ?? 1) < 2}>
          <span className="graph-detail-row-label">{copy.twoHopImpact}</span>
          <span className="graph-detail-context-list">
            {twoHopNodes.slice(0, 4).map((node) => (
              <span key={node.id}>
                {node.name} · {formatGraphNodeType(node.nodeType, props.appLanguage)}
              </span>
            ))}
          </span>
        </section>
      ) : null}
      {riskTags.length > 0 ? (
        <section className="graph-detail-context-row graph-detail-risk-row" aria-label={copy.riskTags}>
          <span className="graph-detail-row-label">{copy.riskTags}</span>
          <span className="graph-detail-context-list">
            {riskTags.map((tag) => (
              <span key={tag}>{formatGraphRiskTag(tag, props.appLanguage)}</span>
            ))}
          </span>
        </section>
      ) : null}
    </aside>
  );
}

export function GraphEdgeDetailPanel(props: {
  edge: GraphViewSnapshot['edges'][number] | AggregatedGraphEdge;
  nodes?: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  graphView: GraphViewSnapshot;
  appLanguage: AppLanguage;
  isCurrent?: boolean;
}) {
  const copy = getLanguageCopy(props.appLanguage).codeMapWorkspace;
  const detailCopy =
    props.appLanguage === 'zh-CN'
      ? {
          originalEdges: '原始边标识',
          moreSources: (count: number) => `另有 ${count} 个来源`,
          moreEdges: (count: number) => `另有 ${count} 条原始边`,
        }
      : {
          originalEdges: 'Original edge IDs',
          moreSources: (count: number) => `${count} more source${count === 1 ? '' : 's'}`,
          moreEdges: (count: number) => `${count} more original edge${count === 1 ? '' : 's'}`,
        };
  const currentNodes = props.nodes ?? props.graphView.nodes;
  const source = currentNodes.find((node) => node.id === props.edge.sourceNodeId) ?? props.graphView.nodes.find((node) => node.id === props.edge.sourceNodeId);
  const target = currentNodes.find((node) => node.id === props.edge.targetNodeId) ?? props.graphView.nodes.find((node) => node.id === props.edge.targetNodeId);
  const sourceRefs = 'sourceRefs' in props.edge ? props.edge.sourceRefs : [props.edge.sourceRef];
  const edgeIds = 'edgeIds' in props.edge ? props.edge.edgeIds : [props.edge.id];
  const aggregateCount = 'aggregateCount' in props.edge ? props.edge.aggregateCount : 1;
  return (
    <aside className={`graph-detail-workbench graph-edge-detail-workbench${props.isCurrent ? ' current-graph-detail' : ''}`} aria-label={copy.edgeDetail} aria-current={props.isCurrent ? 'true' : undefined}>
      <header className="graph-detail-header">
        <span className="graph-detail-title-copy">
          <strong>{copy.edgeDetail}</strong>
          <span>{formatGraphEdgeType(props.edge.edgeType, props.appLanguage)}</span>
        </span>
        <span className="graph-detail-type-pill">{copy.confidenceValue(props.edge.confidence.toFixed(2))}</span>
      </header>
      <section className="graph-detail-source-row" aria-label={copy.edgeSource}>
        <span className="graph-detail-source-copy">
          <strong>
            {source?.name ?? props.edge.sourceNodeId} → {target?.name ?? props.edge.targetNodeId}
          </strong>
          {aggregateCount > 1 ? <small>{copy.aggregatedEdgeSummary(aggregateCount, sourceRefs.length)}</small> : null}
          {sourceRefs.slice(0, 8).map((sourceRef) => (
            <small key={sourceRef}>{sourceRef}</small>
          ))}
          {sourceRefs.length > 8 ? <small>{detailCopy.moreSources(sourceRefs.length - 8)}</small> : null}
        </span>
      </section>
      <section className="graph-detail-context-row" aria-label={detailCopy.originalEdges}>
        <span className="graph-detail-source-copy">
          <strong>{detailCopy.originalEdges}</strong>
          {edgeIds.slice(0, 8).map((edgeId) => (
            <small key={edgeId}>{edgeId}</small>
          ))}
          {edgeIds.length > 8 ? <small>{detailCopy.moreEdges(edgeIds.length - 8)}</small> : null}
        </span>
      </section>
    </aside>
  );
}
