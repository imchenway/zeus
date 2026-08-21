import type { AiRuntimeSession } from '../runtime/runtimeContracts.js';

export interface GraphViewNode {
  id: string;
  nodeType: string;
  name: string;
  qualifiedName: string;
  sourceRef: string;
  symbolId: string;
  metadata: Record<string, unknown>;
}

export interface GraphViewEdge {
  id: string;
  edgeType: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
  confidence: number;
}

export type GraphViewType = 'architecture' | 'module' | 'table' | 'module_detail' | 'api_sequence' | 'module_flow' | 'method_logic';

export interface GraphViewSnapshot {
  id: string;
  schemaVersion: number;
  projectId?: string;
  projectName?: string;
  title: string;
  viewType: GraphViewType | string;
  layout?: {
    algorithm: string;
    width: number;
    height: number;
    positions: Array<{ nodeId: string; x: number; y: number }>;
  };
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  performance?: { durationMs: number; nodeCount: number; edgeCount: number };
}

export interface GraphSearchRequest {
  query: string;
  nodeType?: string;
  edgeType?: string;
  minConfidence?: number;
}

export interface GraphSearchResult {
  query: string;
  nodeType: string | null;
  edgeType: string | null;
  minConfidence: number;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

export interface GraphQuestionAnswer {
  projectId: string;
  question: string;
  answer: string;
  sessionId: string | null;
  sources: {
    nodes: GraphViewNode[];
    edges: GraphViewEdge[];
  };
}

export interface AskGraphRequest {
  question: string;
}

export interface GraphConversationMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface GraphConversationHistoryItem {
  id: string;
  projectId: string;
  taskId: string | null;
  sessionId: string | null;
  title: string;
  summary: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  messages: GraphConversationMessage[];
}

export interface SendConversationMessageResult {
  conversation: GraphConversationHistoryItem;
  runtimeSession?: AiRuntimeSession;
  runtimeError?: { message: string };
}

export interface GraphConversationHistoryPage {
  items: GraphConversationHistoryItem[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  archived: boolean;
}

export interface CreateTaskFromGraphConversationRequest {
  idempotencyKey: string;
  intent?: string;
}

export interface LoadGraphConversationsRequest {
  query?: string;
  limit?: number;
  offset?: number;
  archived?: boolean;
}

export interface GraphEdgeDetail extends GraphViewEdge {
  sourceNode: GraphViewNode;
  targetNode: GraphViewNode;
}

export interface GraphNeighborhood {
  centerNode: GraphViewNode;
  depth: number;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

export interface SemanticGraphNodeList {
  projectId: string;
  viewType: string;
  items: GraphViewNode[];
}

export interface SemanticGraphNodeDetail {
  projectId: string;
  node: GraphViewNode;
  relatedEdges: GraphViewEdge[];
}

export interface FocusedSemanticGraphView {
  projectId: string;
  node: GraphViewNode;
  view: Pick<GraphViewSnapshot, 'id' | 'title' | 'viewType'>;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

export interface GraphScanResult {
  projectName: string;
  rootPath: string;
  fileCount: number;
  symbolCount: number;
  nodeCount: number;
  edgeCount: number;
  viewCount: number;
}
