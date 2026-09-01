import type { CodexAppServerManager, CodexResponsesRuntime } from '@zeus/ai-runtime';
import type {
  CommandDeliveryRepository,
  ConversationExecutionRepository,
  ConversationGoalRepository,
  ConversationPlanActionRepository,
  ConversationProviderItemRepository,
  ConversationProviderSyncCheckpointRepository,
  ConversationRepository,
  ConversationResourceRepository,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  ProviderEventReceiptRepository,
  SettingRepository,
  ZeusDatabase,
} from '@zeus/storage';
import type { BrowserAutomationPort } from './browserAutomation.js';
import type { ZeusToolAuditEvent } from './zeusToolRegistry.js';
import type { CodexUsageService } from './codexUsageService.js';
import type { ProviderDispatchContextCompiler } from './contextDispatchService.js';
import type { ManagedConversationToolResultStore } from './conversationPortableContext.js';
import type { ConversationEventFlowControl } from './eventFlowControl.js';
import type { TurnChangeSetService } from './turnChangeSets.js';
import type { ZeusConversationPluginRuntime } from './zeusConversationPluginRuntime.js';

export interface CreateCodexNativeConversationCoordinatorOptions {
  manager: CodexAppServerManager;
  enabled?: boolean;
  commandPath: string | (() => string);
  externalAgentHome?: string;
  db: ZeusDatabase;
  conversations: ConversationRepository;
  turns: ConversationTurnRepository;
  providerItems: ConversationProviderItemRepository;
  resources?: ConversationResourceRepository;
  changeSets?: TurnChangeSetService;
  submissions: ConversationSubmissionRepository;
  requests: ConversationServerRequestRepository;
  planActions?: ConversationPlanActionRepository;
  goals?: ConversationGoalRepository;
  receipts?: ProviderEventReceiptRepository;
  syncCheckpoints?: ConversationProviderSyncCheckpointRepository;
  settings: SettingRepository;
  usage?: CodexUsageService;
  execution: ConversationExecutionRepository;
  commandDeliveries: CommandDeliveryRepository;
  toolResults: ManagedConversationToolResultStore;
  eventFlow?: ConversationEventFlowControl;
  broadcast: (type: string, payload: Record<string, unknown>) => void;
  now?: () => string;
  operationId?: () => string;
  turnResultTimeoutMs?: number;
  browserAutomation?: BrowserAutomationPort;
  plugins?: ZeusConversationPluginRuntime;
  auditNativeTool?: (event: ZeusToolAuditEvent) => void | Promise<void>;
  trustedAttachmentRoots?: string[];
  generatedImageRoot?: string;
  getProjectRoot?: (projectId: string) => string | null;
  ensureExecutionContext?: (input: {
    conversationId: string;
    mode: 'reconcile' | 'submit' | 'dispatch' | 'recover_queue' | 'restore';
  }) => Promise<{ projectLocalPath: string; writableRoots?: string[]; executionWorkspaceMode?: 'direct' | 'worktree' } | null>;
  resolveResponsesRuntime?: (input: { modelSourceId: string | null; model: string }) => Promise<CodexResponsesRuntime | null>;
  compileDispatchContext?: ProviderDispatchContextCompiler;
  preflightCodexModelBudget?: (input: { modelId: string; modelSourceId: string | null; providerGenerationId: string | null }) => void;
}
