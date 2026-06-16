export interface DiagramGraphNode {
  id: string;
  name: string;
  nodeType: string;
  sourceRef: string;
}

export interface DiagramGraphEdge {
  id: string;
  edgeType: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
  confidence: number;
}

export interface MermaidDiagramExportFile {
  fileName: string;
  mimeType: 'text/vnd.mermaid';
  content: string;
}

export interface ReactFlowDiagramElements {
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    data: { label: string; sourceRef: string };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
    data: { sourceRef: string; confidence: number };
  }>;
}

export interface SigmaGraphElements {
  nodes: Array<{
    key: string;
    attributes: { label: string; type: string; sourceRef: string };
  }>;
  edges: Array<{
    key: string;
    source: string;
    target: string;
    attributes: { label: string; sourceRef: string; confidence: number };
  }>;
}

/**
 * 从真实图谱事实生成 Mermaid 文本；缺少可见端点的边会被跳过，不补造节点。
 */
export function buildMermaidDiagramSource(input: { viewType: string; nodes: DiagramGraphNode[]; edges: DiagramGraphEdge[] }): string {
  const nodeNames = new Map(input.nodes.map((node) => [node.id, sanitizeMermaidLabel(node.name)]));
  if (input.viewType === 'api_sequence') {
    const lines = ['sequenceDiagram'];
    for (const node of input.nodes) lines.push(`  participant ${sanitizeMermaidId(node.id)} as ${sanitizeMermaidLabel(node.name)}`);
    for (const edge of input.edges) {
      if (!nodeNames.has(edge.sourceNodeId) || !nodeNames.has(edge.targetNodeId)) continue;
      lines.push(`  ${sanitizeMermaidId(edge.sourceNodeId)}->>${sanitizeMermaidId(edge.targetNodeId)}: ${sanitizeMermaidLabel(edge.edgeType)} ${edge.confidence.toFixed(2)}`);
      lines.push(`  %% source: ${edge.sourceRef}`);
    }
    return lines.join('\n');
  }
  const lines = ['flowchart LR'];
  for (const node of input.nodes) lines.push(`  ${sanitizeMermaidId(node.id)}["${sanitizeMermaidLabel(node.name)}"]`);
  for (const edge of input.edges) {
    if (!nodeNames.has(edge.sourceNodeId) || !nodeNames.has(edge.targetNodeId)) continue;
    lines.push(`  ${sanitizeMermaidId(edge.sourceNodeId)} -->|${sanitizeMermaidLabel(edge.edgeType)} ${edge.confidence.toFixed(2)}| ${sanitizeMermaidId(edge.targetNodeId)}`);
    lines.push(`  %% source: ${edge.sourceRef}`);
  }
  return lines.join('\n');
}

/**
 * 构造可保存的 Mermaid 文件载荷；只包装已由真实节点/边生成的源码文本。
 */
export function buildMermaidDiagramExport(input: { viewTitle: string; viewType: string; generatedAt: string; source: string }): MermaidDiagramExportFile {
  const timestamp = input.generatedAt.replace(/[:.]/g, '-');
  const safeTitle =
    input.viewTitle
      .trim()
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'graph';
  return {
    fileName: `${input.viewType}-${safeTitle}-${timestamp}.mmd`,
    mimeType: 'text/vnd.mermaid',
    content: ['%% Zeus Mermaid export', `%% view: ${input.viewTitle}`, `%% type: ${input.viewType}`, `%% generatedAt: ${input.generatedAt}`, input.source].join('\n'),
  };
}

/**
 * 转换为 React Flow 兼容元素；坐标是确定性占位布局，真实布局仍由 UI/布局引擎负责。
 */
export function toReactFlowElements(input: { nodes: DiagramGraphNode[]; edges: DiagramGraphEdge[] }): ReactFlowDiagramElements {
  const visibleNodeIds = new Set(input.nodes.map((node) => node.id));
  return {
    nodes: input.nodes.map((node, index) => ({
      id: node.id,
      type: node.nodeType,
      position: { x: index * 240, y: 0 },
      data: { label: node.name, sourceRef: node.sourceRef },
    })),
    edges: input.edges
      .filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId))
      .map((edge) => ({
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        label: `${edge.edgeType} ${edge.confidence.toFixed(2)}`,
        data: { sourceRef: edge.sourceRef, confidence: edge.confidence },
      })),
  };
}

/**
 * 转换为 Sigma/Graphology 风格的轻量数据结构；不引入 WebGL 依赖，不伪造渲染状态。
 */
export function toSigmaGraph(input: { nodes: DiagramGraphNode[]; edges: DiagramGraphEdge[] }): SigmaGraphElements {
  const visibleNodeIds = new Set(input.nodes.map((node) => node.id));
  return {
    nodes: input.nodes.map((node) => ({
      key: node.id,
      attributes: {
        label: node.name,
        type: node.nodeType,
        sourceRef: node.sourceRef,
      },
    })),
    edges: input.edges
      .filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId))
      .map((edge) => ({
        key: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        attributes: {
          label: edge.edgeType,
          sourceRef: edge.sourceRef,
          confidence: edge.confidence,
        },
      })),
  };
}

function sanitizeMermaidId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function sanitizeMermaidLabel(value: string): string {
  return (
    value
      .replaceAll('[', '')
      .replaceAll(']', '')
      .replace(/[{}<>|`]/g, '')
      .trim() || 'unknown'
  );
}
