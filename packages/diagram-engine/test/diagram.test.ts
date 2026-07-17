import { describe, expect, it } from 'vitest';
import { buildMermaidDiagramExport, buildMermaidDiagramSource, buildPlantUmlDiagramExport, buildPlantUmlDiagramSource, toReactFlowElements, toSigmaGraph } from '../src/index.js';

const nodes = [
  {
    id: 'api/node',
    name: 'GET /api/tasks',
    nodeType: 'api',
    sourceRef: 'packages/local-server/src/index.ts',
  },
  {
    id: 'handler.node',
    name: 'TaskHandler',
    nodeType: 'function',
    sourceRef: 'packages/local-server/src/index.ts',
  },
];
const edges = [
  {
    id: 'edge-1',
    edgeType: 'handles_api',
    sourceNodeId: 'api/node',
    targetNodeId: 'handler.node',
    sourceRef: 'packages/local-server/src/index.ts',
    confidence: 0.9,
  },
];

describe('diagram-engine', () => {
  it('builds sourced Mermaid sequence and export payloads from graph facts', () => {
    const source = buildMermaidDiagramSource({
      viewType: 'api_sequence',
      nodes,
      edges,
    });
    const exported = buildMermaidDiagramExport({
      viewTitle: '接口时序图',
      viewType: 'api_sequence',
      generatedAt: '2026-06-14T00:00:00.000Z',
      source,
    });

    expect(source).toContain('sequenceDiagram');
    expect(source).toContain('participant api_node as GET /api/tasks');
    expect(source).toContain('api_node->>handler_node: handles_api 0.90');
    expect(source).toContain('%% source: packages/local-server/src/index.ts');
    expect(exported.fileName).toBe('api_sequence-接口时序图-2026-06-14T00-00-00-000Z.mmd');
    expect(exported.mimeType).toBe('text/vnd.mermaid');
    expect(exported.content).toContain('%% Zeus Mermaid export');
  });

  it('builds sourced PlantUML sequence and export payloads from graph facts for mature UML tooling', () => {
    const source = buildPlantUmlDiagramSource({
      viewType: 'api_sequence',
      nodes,
      edges,
    });
    const exported = buildPlantUmlDiagramExport({
      viewTitle: '接口时序图',
      viewType: 'api_sequence',
      generatedAt: '2026-06-14T00:00:00.000Z',
      source,
    });

    expect(source).toContain('@startuml');
    expect(source).toContain('participant "GET /api/tasks" as api_node');
    expect(source).toContain('api_node -> handler_node : handles_api 0.90');
    expect(source).toContain("' source: packages/local-server/src/index.ts");
    expect(source).toContain('@enduml');
    expect(exported.fileName).toBe('api_sequence-接口时序图-2026-06-14T00-00-00-000Z.puml');
    expect(exported.mimeType).toBe('text/vnd.plantuml');
    expect(exported.content).toContain("' Zeus PlantUML export");
  });

  it('builds method logic exports as sourced sequence diagrams instead of generic flowcharts', () => {
    const source = buildMermaidDiagramSource({
      viewType: 'method_logic',
      nodes,
      edges,
    });
    const plantUml = buildPlantUmlDiagramSource({
      viewType: 'method_logic',
      nodes,
      edges,
    });

    expect(source).toContain('sequenceDiagram');
    expect(source).not.toContain('flowchart LR');
    expect(source).toContain('participant api_node as GET /api/tasks');
    expect(source).toContain('api_node->>handler_node: handles_api 0.90');
    expect(source).toContain('%% source: packages/local-server/src/index.ts');
    expect(plantUml).toContain('participant "GET /api/tasks" as api_node');
    expect(plantUml).toContain('api_node -> handler_node : handles_api 0.90');
    expect(plantUml).not.toContain('left to right direction');
  });

  it('converts sourced graph facts to React Flow and Sigma compatible elements without inventing coordinates', () => {
    expect(toReactFlowElements({ nodes, edges })).toEqual({
      nodes: [
        {
          id: 'api/node',
          type: 'api',
          position: { x: 0, y: 0 },
          data: {
            label: 'GET /api/tasks',
            sourceRef: 'packages/local-server/src/index.ts',
          },
        },
        {
          id: 'handler.node',
          type: 'function',
          position: { x: 240, y: 0 },
          data: {
            label: 'TaskHandler',
            sourceRef: 'packages/local-server/src/index.ts',
          },
        },
      ],
      edges: [
        {
          id: 'edge-1',
          source: 'api/node',
          target: 'handler.node',
          label: 'handles_api 0.90',
          data: {
            sourceRef: 'packages/local-server/src/index.ts',
            confidence: 0.9,
          },
        },
      ],
    });

    expect(toSigmaGraph({ nodes, edges })).toEqual({
      nodes: [
        {
          key: 'api/node',
          attributes: {
            label: 'GET /api/tasks',
            type: 'api',
            sourceRef: 'packages/local-server/src/index.ts',
          },
        },
        {
          key: 'handler.node',
          attributes: {
            label: 'TaskHandler',
            type: 'function',
            sourceRef: 'packages/local-server/src/index.ts',
          },
        },
      ],
      edges: [
        {
          key: 'edge-1',
          source: 'api/node',
          target: 'handler.node',
          attributes: {
            label: 'handles_api',
            sourceRef: 'packages/local-server/src/index.ts',
            confidence: 0.9,
          },
        },
      ],
    });
  });
});
