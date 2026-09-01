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

export interface PlantUmlDiagramExportFile {
  fileName: string;
  mimeType: 'text/vnd.plantuml';
  content: string;
}

/**
 * 从真实图谱事实生成 Mermaid 文本；缺少可见端点的边会被跳过，不补造节点。
 */
export function buildMermaidDiagramSource(input: { viewType: string; nodes: DiagramGraphNode[]; edges: DiagramGraphEdge[] }): string {
  const nodeNames = new Map(input.nodes.map((node) => [node.id, sanitizeMermaidLabel(node.name)]));
  if (isSequenceDiagramView(input.viewType)) {
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
 * 从真实图谱事实生成 PlantUML 文本；用于对接成熟 UML 工具链，不新增本地渲染依赖。
 */
export function buildPlantUmlDiagramSource(input: { viewType: string; nodes: DiagramGraphNode[]; edges: DiagramGraphEdge[] }): string {
  const visibleNodeIds = new Set(input.nodes.map((node) => node.id));
  const lines = ['@startuml'];
  if (!isSequenceDiagramView(input.viewType)) {
    lines.push('left to right direction');
  }
  for (const node of input.nodes) {
    const nodeId = sanitizePlantUmlId(node.id);
    const label = sanitizePlantUmlLabel(node.name);
    if (isSequenceDiagramView(input.viewType)) {
      lines.push(`participant "${label}" as ${nodeId}`);
    } else {
      lines.push(`rectangle "${label}" as ${nodeId}`);
    }
    lines.push(`' source: ${node.sourceRef}`);
  }
  for (const edge of input.edges) {
    if (!visibleNodeIds.has(edge.sourceNodeId) || !visibleNodeIds.has(edge.targetNodeId)) continue;
    const sourceId = sanitizePlantUmlId(edge.sourceNodeId);
    const targetId = sanitizePlantUmlId(edge.targetNodeId);
    const label = `${sanitizePlantUmlLabel(edge.edgeType)} ${edge.confidence.toFixed(2)}`;
    lines.push(isSequenceDiagramView(input.viewType) ? `${sourceId} -> ${targetId} : ${label}` : `${sourceId} --> ${targetId} : ${label}`);
    lines.push(`' source: ${edge.sourceRef}`);
  }
  lines.push('@enduml');
  return lines.join('\n');
}

/**
 * 构造可保存的 PlantUML 文件载荷；只包装已由真实节点/边生成的源码文本。
 */
export function buildPlantUmlDiagramExport(input: { viewTitle: string; viewType: string; generatedAt: string; source: string }): PlantUmlDiagramExportFile {
  const timestamp = input.generatedAt.replace(/[:.]/g, '-');
  const safeTitle =
    input.viewTitle
      .trim()
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'graph';
  return {
    fileName: `${input.viewType}-${safeTitle}-${timestamp}.puml`,
    mimeType: 'text/vnd.plantuml',
    content: ["' Zeus PlantUML export", `' view: ${input.viewTitle}`, `' type: ${input.viewType}`, `' generatedAt: ${input.generatedAt}`, input.source].join('\n'),
  };
}

function isSequenceDiagramView(viewType: string): boolean {
  // 接口时序图与方法逻辑图都描述调用/控制的时间顺序；默认导出应对齐 Mermaid/PlantUML 的 sequence diagram，而不是普通流程图。
  return viewType === 'api_sequence' || viewType === 'method_logic';
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

function sanitizePlantUmlId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z_]/.test(sanitized) ? sanitized : `node_${sanitized}`;
}

function sanitizePlantUmlLabel(value: string): string {
  return (
    value
      .replace(/["\\]/g, '')
      .replace(/[\r\n]/g, ' ')
      .trim() || 'unknown'
  );
}
