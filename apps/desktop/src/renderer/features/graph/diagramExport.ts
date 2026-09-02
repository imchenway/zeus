export interface DiagramGraphNode {
  id: string;
  name: string;
  sourceRef: string;
}

export interface DiagramGraphEdge {
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

const sequenceView = (viewType: string) => viewType === 'api_sequence' || viewType === 'method_logic';
const mermaidId = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, '_');
const mermaidLabel = (value: string) =>
  value
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replace(/[{}<>|`]/g, '')
    .trim() || 'unknown';
const plantUmlLabel = (value: string) =>
  value
    .replace(/["\\]/g, '')
    .replace(/[\r\n]/g, ' ')
    .trim() || 'unknown';
const plantUmlId = (value: string) => {
  const sanitized = mermaidId(value);
  return /^[a-zA-Z_]/.test(sanitized) ? sanitized : `node_${sanitized}`;
};
const exportName = (title: string) =>
  title
    .trim()
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'graph';

export function buildMermaidDiagramSource(input: { viewType: string; nodes: DiagramGraphNode[]; edges: DiagramGraphEdge[] }): string {
  const visible = new Set(input.nodes.map((node) => node.id));
  const lines = [sequenceView(input.viewType) ? 'sequenceDiagram' : 'flowchart LR'];
  for (const node of input.nodes) {
    lines.push(sequenceView(input.viewType) ? `  participant ${mermaidId(node.id)} as ${mermaidLabel(node.name)}` : `  ${mermaidId(node.id)}["${mermaidLabel(node.name)}"]`);
  }
  for (const edge of input.edges) {
    if (!visible.has(edge.sourceNodeId) || !visible.has(edge.targetNodeId)) continue;
    const label = `${mermaidLabel(edge.edgeType)} ${edge.confidence.toFixed(2)}`;
    lines.push(sequenceView(input.viewType) ? `  ${mermaidId(edge.sourceNodeId)}->>${mermaidId(edge.targetNodeId)}: ${label}` : `  ${mermaidId(edge.sourceNodeId)} -->|${label}| ${mermaidId(edge.targetNodeId)}`);
    lines.push(`  %% source: ${edge.sourceRef}`);
  }
  return lines.join('\n');
}

export function buildMermaidDiagramExport(input: { viewTitle: string; viewType: string; generatedAt: string; source: string }): MermaidDiagramExportFile {
  return {
    fileName: `${input.viewType}-${exportName(input.viewTitle)}-${input.generatedAt.replace(/[:.]/g, '-')}.mmd`,
    mimeType: 'text/vnd.mermaid',
    content: ['%% Zeus Mermaid export', `%% view: ${input.viewTitle}`, `%% type: ${input.viewType}`, `%% generatedAt: ${input.generatedAt}`, input.source].join('\n'),
  };
}

export function buildPlantUmlDiagramSource(input: { viewType: string; nodes: DiagramGraphNode[]; edges: DiagramGraphEdge[] }): string {
  const visible = new Set(input.nodes.map((node) => node.id));
  const lines = ['@startuml', ...(sequenceView(input.viewType) ? [] : ['left to right direction'])];
  for (const node of input.nodes) {
    lines.push(`${sequenceView(input.viewType) ? 'participant' : 'rectangle'} "${plantUmlLabel(node.name)}" as ${plantUmlId(node.id)}`, `' source: ${node.sourceRef}`);
  }
  for (const edge of input.edges) {
    if (!visible.has(edge.sourceNodeId) || !visible.has(edge.targetNodeId)) continue;
    lines.push(`${plantUmlId(edge.sourceNodeId)} ${sequenceView(input.viewType) ? '->' : '-->'} ${plantUmlId(edge.targetNodeId)} : ${plantUmlLabel(edge.edgeType)} ${edge.confidence.toFixed(2)}`, `' source: ${edge.sourceRef}`);
  }
  lines.push('@enduml');
  return lines.join('\n');
}

export function buildPlantUmlDiagramExport(input: { viewTitle: string; viewType: string; generatedAt: string; source: string }): PlantUmlDiagramExportFile {
  return {
    fileName: `${input.viewType}-${exportName(input.viewTitle)}-${input.generatedAt.replace(/[:.]/g, '-')}.puml`,
    mimeType: 'text/vnd.plantuml',
    content: ["' Zeus PlantUML export", `' view: ${input.viewTitle}`, `' type: ${input.viewType}`, `' generatedAt: ${input.generatedAt}`, input.source].join('\n'),
  };
}
