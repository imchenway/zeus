export type PortableHistoryRole = 'user' | 'assistant' | 'tool';

export interface PortableHistoryEntry {
  sequence: number;
  role: PortableHistoryRole;
  content: unknown;
  sourceSegmentId: string;
  sourceRuntime: 'codex' | 'pi';
  toolPairId?: string;
  convertedReasoning?: boolean;
}

export interface PortableConversationContext {
  conversationId: string;
  throughModelHistorySequence: number;
  entries: PortableHistoryEntry[];
  capabilityLosses: Array<{
    sequence: number;
    kind: 'hidden_reasoning_omitted' | 'reasoning_signature_omitted' | 'media_omitted' | 'dangling_tool_closed';
    detail: string;
  }>;
}

/** app-server v2 additionalContext 的单个命名条目。 */
export interface CodexAdditionalContextEntry {
  kind: 'application' | 'untrusted';
  value: string;
}

/** Codex bootstrap 的可信清单与不可信正文必须使用 app-server 的精确线协议。 */
export type CodexBootstrapAdditionalContext = Record<string, CodexAdditionalContextEntry>;
