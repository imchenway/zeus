import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createConnection } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { type RawData, WebSocket } from 'ws';
import type { CodexBootstrapAdditionalContext } from '@zeus/shared';
import {
  CodexJsonLineDecoder,
  type CodexWireId,
  type CodexWireMessage,
  type ExternalAgentConfigDetectParams,
  type ExternalAgentConfigDetectResponse,
  type ExternalAgentConfigImportHistory,
  type ExternalAgentConfigImportParams,
  type ExternalAgentConfigImportResponse,
  type ExternalAgentImportNotification,
  parseExternalAgentConfigDetectResponse,
  parseExternalAgentConfigImportHistoriesResponse,
  parseExternalAgentConfigImportResponse,
  parseExternalAgentImportNotification,
} from './codexAppServerProtocol.js';
import { expandCliSearchPath } from './cliSearchPath.js';

export type {
  ExternalAgentConfigDetectParams,
  ExternalAgentConfigDetectResponse,
  ExternalAgentConfigImportHistory,
  ExternalAgentConfigImportParams,
  ExternalAgentConfigImportResponse,
  ExternalAgentImportNotification,
} from './codexAppServerProtocol.js';

export interface CodexAppServerReadable {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  /** Node pipe 支持暂停读取；假实现可省略。只允许在没有未决 RPC 时把投影背压传回 app-server stdout。 */
  pause?(): unknown;
  resume?(): unknown;
}

export interface CodexAppServerProcess {
  readonly pid?: number;
  stdin: { write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean };
  stdout: CodexAppServerReadable;
  stderr: CodexAppServerReadable;
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CodexAppServerSpawnOptions {
  env: NodeJS.ProcessEnv;
}

export type CodexAppServerSpawn = (command: string, args: string[], options?: CodexAppServerSpawnOptions) => CodexAppServerProcess;

export interface CodexModelServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CodexModelCapability {
  id: string;
  model: string;
  displayName?: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  serviceTiers: CodexModelServiceTier[];
  defaultServiceTier?: string | null;
  raw: Record<string, unknown>;
}

export interface CodexCapabilitiesSnapshot {
  generationId: string;
  initializedAt: string;
  /** 来自 initialize 回执或同一真实可执行文件 `--version` 的 Provider 版本；两者都缺失时保持 null。 */
  providerVersion: string | null;
  protocolVersion: 'codex-app-server-v2';
  models: CodexModelCapability[];
  supportedModels: string[];
  preflightTokenCount: {
    state: 'unavailable';
    exact: false;
    reason: string;
  };
  goals: {
    supported: boolean;
    enabled: boolean;
    stage: 'beta' | 'underDevelopment' | 'stable' | 'deprecated' | 'removed' | null;
  };
}

export type CodexThreadGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: CodexThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexAccountSnapshot {
  generationId: string;
  requiresOpenaiAuth: boolean;
  signedIn: boolean;
  accountType: string | null;
  planType: string | null;
  /** 只用于本机用量隔离，不暴露邮箱或认证信息。 */
  accountScopeId: string;
}

export interface CodexRateLimitWindowSnapshot {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitBucketSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindowSnapshot | null;
  secondary: CodexRateLimitWindowSnapshot | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  planType: string | null;
}

export interface CodexAccountRateLimitsSnapshot {
  generationId: string;
  rateLimits: CodexRateLimitBucketSnapshot;
  rateLimitsByLimitId: Record<string, CodexRateLimitBucketSnapshot> | null;
}

export interface CodexAccountUsageSummary {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
}

export interface CodexAccountUsageSnapshot {
  generationId: string;
  summary: CodexAccountUsageSummary;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }> | null;
}

export type CodexSkillScope = 'user' | 'repo' | 'system' | 'admin';

export interface CodexSkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: CodexSkillScope;
  enabled: boolean;
  interface?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
}

export interface CodexSkillsListEntry {
  cwd: string;
  skills: CodexSkillMetadata[];
  errors: Array<Record<string, unknown>>;
}

export interface CodexChatGptLogin {
  generationId: string;
  loginId: string;
  authUrl: string;
}

export type CodexSandboxPolicy = { type: 'readOnly'; networkAccess: false } | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean } | { type: 'dangerFullAccess' };
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

export interface CodexDynamicToolFunctionSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
}

export interface CodexDynamicToolNamespaceSpec {
  type: 'namespace';
  name: string;
  description: string;
  tools: CodexDynamicToolFunctionSpec[];
}

export type CodexDynamicToolSpec = CodexDynamicToolFunctionSpec | CodexDynamicToolNamespaceSpec;

export interface CodexResponsesModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  envKey: string;
  modelContextWindow: number;
}

export interface CodexResponsesRuntime {
  provider: CodexResponsesModelProvider;
  /** 仅注入 app-server 子进程，不进入 thread config、日志或持久化记录。 */
  environment: Record<string, string>;
}

export interface CodexPerformanceTraceContext {
  /** Zeus 内部短期性能身份；不序列化到 Codex app-server params。 */
  traceIdentity?: string | null;
}

export interface CodexThreadStartInput extends CodexPerformanceTraceContext {
  model: string;
  serviceTier?: string | null;
  cwd: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandbox: CodexSandboxPolicy;
  config?: never;
  responsesRuntime?: CodexResponsesRuntime;
  baseInstructions?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  dynamicTools?: CodexDynamicToolSpec[];
}

export interface CodexThreadResumeInput extends CodexPerformanceTraceContext {
  threadId: string;
  cwd?: string;
  responsesRuntime?: CodexResponsesRuntime;
}

export type CodexThreadRuntimeStatus = { type: 'notLoaded' } | { type: 'idle' } | { type: 'systemError'; [key: string]: unknown } | { type: 'active'; activeFlags: string[] };

export interface CodexThreadSnapshot {
  id: string;
  /** app-server 可选返回的真实 JSONL 文件路径；字段不稳定，缺失时不得猜测。 */
  path?: string | null;
  /** thread/read 的权威运行态；旧 Provider 缺失时由上层按未知状态失败关闭。 */
  status?: CodexThreadRuntimeStatus;
  turns?: unknown[];
  providerSettings?: {
    generationId: string;
    sequence: number;
    model: string;
    effort?: string;
    serviceTier?: string | null;
  };
  [key: string]: unknown;
}

export interface CodexTurnStartInput extends CodexPerformanceTraceContext {
  threadId: string;
  clientUserMessageId?: string;
  input: Array<Record<string, unknown>>;
  additionalContext?: CodexBootstrapAdditionalContext;
  /** 仅供适配器确认 JSON-RPC 帧已经成功写入传输层，不进入线协议。 */
  requestWritten?: () => void;
  /** 仅供运行管理器在进程重启后恢复外部 Responses Provider，不进入 turn/start 线协议。 */
  responsesRuntime?: CodexResponsesRuntime;
  collaborationMode?: { mode: 'plan' | 'default'; settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null } };
  model?: string;
  effort?: string;
  serviceTier?: string | null;
  summary?: CodexReasoningSummary;
  cwd?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandboxPolicy?: CodexSandboxPolicy;
}

/** 产品层沿用 Pi 的 `off` 术语；Codex Responses 线协议对应值是 `none`。 */
export function toCodexWireReasoningEffort(effort: string | null | undefined): string | null | undefined {
  return effort === 'off' ? 'none' : effort;
}

export interface CodexTurnSteerInput extends CodexPerformanceTraceContext {
  threadId: string;
  turnId: string;
  clientUserMessageId?: string;
  input: Array<Record<string, unknown>>;
}

export interface CodexTurnSnapshot {
  id: string;
  threadId: string;
  items?: unknown[];
  [key: string]: unknown;
}

export interface CodexThreadTurnsPage {
  data: CodexTurnSnapshot[];
  nextCursor: string | null;
}

export interface CodexThreadsPage {
  data: CodexThreadSnapshot[];
  nextCursor: string | null;
}

export interface CodexThreadListInput {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: 'created_at' | 'updated_at' | null;
  sortDirection?: 'asc' | 'desc' | null;
  sourceKinds?: Array<'cli' | 'vscode' | 'exec' | 'appServer' | 'subAgent' | 'subAgentReview' | 'subAgentCompact' | 'subAgentThreadSpawn' | 'subAgentOther' | 'unknown'> | null;
  useStateDbOnly?: boolean;
  parentThreadId?: string | null;
  ancestorThreadId?: string | null;
}

interface CodexServerResponseBase {
  generationId: string;
  requestId: CodexWireId;
}

export type CodexServerRequestResponse = CodexPerformanceTraceContext &
  (
    | (CodexServerResponseBase & { type: 'command'; decision: CodexCommandApprovalDecision })
    | (CodexServerResponseBase & { type: 'file'; decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' })
    | (CodexServerResponseBase & {
        type: 'permissions';
        permissions: {
          network?: { enabled: boolean | null };
          fileSystem?: { read: string[] | null; write: string[] | null; globScanMaxDepth?: number };
        };
        scope: 'turn' | 'session';
        strictAutoReview?: boolean;
      })
    | (CodexServerResponseBase & { type: 'request_user_input'; answers: Record<string, { answers: string[] }> })
    | (CodexServerResponseBase & { type: 'mcp'; action: 'accept' | 'decline' | 'cancel'; content: JsonValue | null; _meta: JsonValue | null })
    | (CodexServerResponseBase & {
        type: 'dynamic_tool';
        contentItems: Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }>;
        success: boolean;
      })
  );

export type CodexCommandApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] };
    };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CodexAppServerEvent {
  generationId: string;
  sequence: number;
  method: string;
  params: unknown;
  receivedAt: string;
  requestId?: CodexWireId;
}

export interface CodexRpcRetryContext {
  operationIdentity?: string;
  projectId?: string;
  taskId?: string;
  conversationId?: string;
}

export interface CodexRpcRetryProgress extends CodexRpcRetryContext {
  generationId: string;
  method: string;
  retryAttempt: number;
  maxRetries: number;
  delayMs: number;
  occurredAt: string;
}

const codexRpcRetryContext = new AsyncLocalStorage<CodexRpcRetryContext>();

/** 把一次前台产品操作的身份旁路带到内部只读 RPC；不改变 Provider wire payload。 */
export function runWithCodexRpcRetryContext<T>(context: CodexRpcRetryContext, operation: () => T): T {
  return codexRpcRetryContext.run({ ...context }, operation);
}

export type CodexTransportState =
  | { type: 'idle' }
  | { type: 'starting'; generationId: string }
  | { type: 'ready'; generationId: string; capabilities: CodexCapabilitiesSnapshot }
  | { type: 'restarting'; generationId: string; attempt: number }
  | { type: 'closed' };

export interface CodexRuntimeGenerationSnapshot {
  generationId: string;
  commandPath: string;
  state: CodexTransportState['type'];
  active: boolean;
  activeThreadCount: number;
  pendingRequestCount: number;
}

export type CodexRemoteControlConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'errored';

export interface CodexRemoteControlStatus {
  status: CodexRemoteControlConnectionStatus;
  serverName: string;
  installationId: string;
  environmentId: string | null;
}

export interface CodexRemoteControlPairing {
  pairingCode: string;
  manualPairingCode: string | null;
  environmentId: string;
  expiresAt: number;
}

export interface CodexRemoteControlClient {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  lastSeenAt: number | null;
}

export interface CodexRemoteControlClientsPage {
  data: CodexRemoteControlClient[];
  nextCursor: string | null;
}

export interface CodexAppServerManager {
  ensureReady(input: {
    commandPath: string;
    externalAgentHome?: string;
    remoteControl?: boolean;
    providerEnvironment?: Record<string, string>;
    /** 世代管理器用于在进程启动前安装外部 Responses Provider；底层管理器不把它写入 RPC。 */
    responsesProvider?: CodexResponsesModelProvider | null;
  }): Promise<CodexCapabilitiesSnapshot>;
  /** 在运行身份不变时也激活新世代；多世代管理器保留旧活动轮次并让其自然排空。 */
  activateFreshGeneration?(input: { commandPath: string; externalAgentHome?: string; remoteControl?: boolean; providerEnvironment?: Record<string, string> }): Promise<CodexCapabilitiesSnapshot>;
  readAccount(input?: { refreshToken?: boolean; allowCachedOnTransportFailure?: boolean; preferCached?: boolean; cachedOnly?: boolean }): Promise<CodexAccountSnapshot>;
  readAccountRateLimits(): Promise<CodexAccountRateLimitsSnapshot>;
  readAccountUsage(): Promise<CodexAccountUsageSnapshot>;
  startChatGptLogin(): Promise<CodexChatGptLogin>;
  cancelChatGptLogin(input: { loginId: string }): Promise<void>;
  startThread(input: CodexThreadStartInput): Promise<CodexThreadSnapshot>;
  resumeThread(input: CodexThreadResumeInput): Promise<CodexThreadSnapshot>;
  archiveThread(input: { threadId: string } & CodexPerformanceTraceContext): Promise<void>;
  unarchiveThread(input: { threadId: string } & CodexPerformanceTraceContext): Promise<CodexThreadSnapshot>;
  readThread(input: { threadId: string; includeTurns?: boolean; priority?: 'control' }): Promise<CodexThreadSnapshot>;
  listThreads(input: CodexThreadListInput): Promise<CodexThreadsPage>;
  readThreadGoal(input: { threadId: string }): Promise<CodexThreadGoal | null>;
  setThreadGoal(input: { threadId: string; objective?: string; status?: CodexThreadGoalStatus; tokenBudget?: number | null } & CodexPerformanceTraceContext): Promise<CodexThreadGoal>;
  clearThreadGoal(input: { threadId: string } & CodexPerformanceTraceContext): Promise<{ cleared: boolean }>;
  listThreadTurns(input: {
    threadId: string;
    cursor?: string | null;
    limit?: number | null;
    sortDirection?: 'asc' | 'desc' | null;
    itemsView?: 'notLoaded' | 'summary' | 'full' | null;
    /** 派发门禁读取不得被同一进程的过程事件投影背压阻塞。 */
    priority?: 'control';
  }): Promise<CodexThreadTurnsPage>;
  listSkills(input: { cwds?: string[]; forceReload?: boolean }): Promise<CodexSkillsListEntry[]>;
  startTurn(input: CodexTurnStartInput): Promise<CodexTurnSnapshot>;
  steerTurn(input: CodexTurnSteerInput): Promise<{ turnId: string }>;
  interruptTurn(input: { threadId: string; turnId: string } & CodexPerformanceTraceContext): Promise<void>;
  respondToServerRequest(input: CodexServerRequestResponse): Promise<void>;
  readRemoteControlStatus(): Promise<CodexRemoteControlStatus>;
  enableRemoteControl(input?: { ephemeral?: boolean }): Promise<CodexRemoteControlStatus>;
  disableRemoteControl(input?: { ephemeral?: boolean }): Promise<CodexRemoteControlStatus>;
  startRemoteControlPairing(input?: { manualCode?: boolean }): Promise<CodexRemoteControlPairing>;
  readRemoteControlPairingStatus(input: { pairingCode?: string | null; manualPairingCode?: string | null }): Promise<{ claimed: boolean }>;
  listRemoteControlClients(input: { environmentId: string; cursor?: string | null; limit?: number | null; order?: 'asc' | 'desc' | null }): Promise<CodexRemoteControlClientsPage>;
  revokeRemoteControlClient(input: { environmentId: string; clientId: string }): Promise<void>;
  detectExternalAgentConfig(input?: ExternalAgentConfigDetectParams): Promise<ExternalAgentConfigDetectResponse>;
  startExternalAgentImport(input: ExternalAgentConfigImportParams): Promise<ExternalAgentConfigImportResponse>;
  readExternalAgentImportHistories(): Promise<ExternalAgentConfigImportHistory[]>;
  subscribeExternalAgentImport(listener: (event: ExternalAgentImportEvent) => void): () => void;
  subscribeRpcRetries(listener: (event: CodexRpcRetryProgress) => void): () => void;
  subscribe(listener: (event: CodexAppServerEvent) => void | Promise<void>): () => void;
  getState(): CodexTransportState;
  hasGeneration(generationId: string): boolean;
  generationForThread(threadId: string): string | null;
  listRuntimeGenerations(): CodexRuntimeGenerationSnapshot[];
  prepareForShutdown(): Promise<void>;
  close(): Promise<void>;
}

export type ExternalAgentImportEvent = ExternalAgentImportNotification & { generationId: string };

type PendingRequest = {
  generationId: string;
  method: string;
  traceIdentity: string | null;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

interface CreateCodexAppServerManagerOptions {
  spawn?: CodexAppServerSpawn;
  /** Codex 自己的持久目录；桌面内嵌运行时不能依赖父进程偶然继承的环境变量。 */
  codexHome?: string;
  now?: () => string;
  generationId?: () => string;
  requestTimeoutMs?: number;
  appServerFlags?: readonly string[];
  onRestartScheduled?: (delayMs: number, attempt: number) => void;
  onDiagnostic?: (entry: { generationId: string; sequence: number; stderrSummary: string }) => void;
  eventReplayLimit?: number;
  shutdownTimeoutMs?: number;
  accountFingerprintSalt?: string;
  runtimeEnvironment?: Record<string, string>;
  /** initialize 不再报告版本时，仅接纳同一可执行文件的只读版本探测结果。 */
  providerVersionFallback?: string | null;
}

type ProcessExitTracker = { promise: Promise<void>; resolve: () => void; exited: boolean };

type ServerRequestRecord = {
  generationId: string;
  method: string;
  params: unknown;
  paramsIdentity: string;
  state: 'pending' | 'responded' | 'unsupported' | 'conflicted';
};

const RESTART_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const ACCOUNT_SNAPSHOT_TTL_MS = 30_000;
const ACCOUNT_USAGE_SNAPSHOT_TTL_MS = 15_000;
const SAFE_READ_RPC_METHODS = new Set([
  'model/list',
  'experimentalFeature/list',
  'account/read',
  'account/rateLimits/read',
  'account/usage/read',
  'thread/read',
  'thread/list',
  'thread/goal/get',
  'thread/turns/list',
  'skills/list',
  'remoteControl/status/read',
  'remoteControl/pairing/status',
  'remoteControl/client/list',
  'externalAgentConfig/detect',
  'externalAgentConfig/import/readHistories',
]);
const SAFE_READ_RPC_MAX_RETRIES = 5;
const SAFE_READ_RPC_ATTEMPT_TIMEOUT_MS = 4_000;
const SAFE_READ_RPC_DEADLINE_MS = 30_000;
const SAFE_READ_RPC_INITIAL_DELAY_MS = 200;

type TimedGenerationSnapshot<T extends { generationId: string }> = {
  value: T;
  cachedAt: number;
};

function resolveBeforeTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolve(false);
    }, timeoutMs);
    void promise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

export function createCodexAppServerManager(options: CreateCodexAppServerManagerOptions = {}): CodexAppServerManager {
  const spawn = options.spawn ?? spawnNodeCodexAppServer;
  const now = options.now ?? (() => new Date().toISOString());
  const makeGenerationId = options.generationId ?? randomUUID;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const eventReplayLimit = options.eventReplayLimit ?? 1_024;
  const shutdownTimeoutMs = Math.max(0, options.shutdownTimeoutMs ?? 5_000);
  const accountFingerprintSalt = options.accountFingerprintSalt?.trim() || 'zeus-local-account-scope';
  const runtimeEnvironment = { ...options.runtimeEnvironment };
  const codexHome = options.codexHome?.trim() || null;
  const providerVersionFallback = normalizeProviderVersion(options.providerVersionFallback);
  if (codexHome !== null && !isAbsolute(codexHome)) throw managerError('ZEUS_CODEX_HOME_INVALID', 'Codex home must be an absolute path.');
  const listeners = new Set<(event: CodexAppServerEvent) => void | Promise<void>>();
  const externalAgentImportListeners = new Set<(event: ExternalAgentImportEvent) => void>();
  const rpcRetryListeners = new Set<(event: CodexRpcRetryProgress) => void>();
  const eventReplayBuffer: CodexAppServerEvent[] = [];
  const pendingRequests = new Map<string, PendingRequest>();
  const serverRequests = new Map<string, ServerRequestRecord>();
  const processExitTrackers = new Map<CodexAppServerProcess, ProcessExitTracker>();
  const pendingInterrupts = new Set<string>();
  const startedTurns = new Set<string>();
  const threadModels = new Map<string, string>();
  const threadResponsesProviders = new Map<string, CodexResponsesModelProvider>();
  let state: CodexTransportState = { type: 'idle' };
  let child: CodexAppServerProcess | null = null;
  let commandPath: string | null = null;
  let externalAgentHome: string | null = null;
  let remoteControlTransport = false;
  let providerEnvironment: Record<string, string> = {};
  let readyPromise: Promise<CodexCapabilitiesSnapshot> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectScheduledRestart: ((error: Error) => void) | null = null;
  let restartAttempt = 0;
  let requestSequence = 0;
  let eventSequence = 0;
  let diagnosticSequence = 0;
  let remoteControlEnabled = false;
  let lastAccountSnapshot: TimedGenerationSnapshot<CodexAccountSnapshot> | null = null;
  let lastAccountRateLimitsSnapshot: TimedGenerationSnapshot<CodexAccountRateLimitsSnapshot> | null = null;
  let lastAccountUsageSnapshot: TimedGenerationSnapshot<CodexAccountUsageSnapshot> | null = null;
  let preparingForShutdown = false;
  let closePromise: Promise<void> | null = null;
  const pendingEventDeliveryCounts = new WeakMap<CodexAppServerProcess, number>();
  const pendingRpcReadCounts = new WeakMap<CodexAppServerProcess, number>();
  const accountReadInFlight = new Map<string, Promise<CodexAccountSnapshot>>();
  const accountRateLimitsReadInFlight = new Map<string, Promise<CodexAccountRateLimitsSnapshot>>();
  const accountUsageReadInFlight = new Map<string, Promise<CodexAccountUsageSnapshot>>();

  function currentGenerationId(): string {
    if (state.type === 'idle' || state.type === 'closed') throw managerError('ZEUS_CODEX_NOT_READY', 'Codex app-server is not ready.');
    return state.generationId;
  }

  function start(command: string): Promise<CodexCapabilitiesSnapshot> {
    const generationId = makeGenerationId();
    requestSequence = 0;
    eventSequence = 0;
    diagnosticSequence = 0;
    eventReplayBuffer.length = 0;
    pendingInterrupts.clear();
    startedTurns.clear();
    state = { type: 'starting', generationId };
    const decoder = new CodexJsonLineDecoder();
    const env = {
      ...process.env,
      ...providerEnvironment,
      ...runtimeEnvironment,
      PATH: expandCliSearchPath(),
      ...(codexHome === null ? {} : { CODEX_HOME: codexHome }),
      ...(externalAgentHome === null ? {} : { ZEUS_CODEX_EXTERNAL_AGENT_HOME: externalAgentHome }),
    };
    // `-c/--config` 是 Codex 根命令参数，必须位于 app-server 子命令之前。
    const spawned = remoteControlTransport ? spawnRemoteControlCodexAppServer(command, { env }) : spawn(command, [...(options.appServerFlags ?? []), 'app-server', '--listen', 'stdio://'], { env });
    trackProcessExit(spawned);
    child = spawned;
    spawned.stdout.on('data', (chunk) => {
      if (child !== spawned || state.type === 'closed') return;
      for (const frame of decoder.push(toBuffer(chunk))) {
        if (frame.type === 'protocol_error') {
          emitEvent(generationId, 'transport/protocol_error', frame.error);
        } else {
          handleWireMessage(generationId, frame.message);
        }
      }
    });
    spawned.stderr.on('data', (chunk) => {
      if (child !== spawned || state.type === 'closed') return;
      options.onDiagnostic?.({
        generationId,
        sequence: ++diagnosticSequence,
        stderrSummary: summarizeStderr(toBuffer(chunk).toString('utf8')),
      });
    });
    spawned.on('error', (error) => {
      const failure = error instanceof Error ? error : new Error('Codex app-server process error.');
      // A failed spawn has no OS process to await. A pid-bearing ChildProcess error does not prove exit.
      if (spawned.pid === undefined) {
        markProcessExited(spawned);
        handleProcessExit(spawned, generationId, failure);
        return;
      }
      if (child === spawned && state.type !== 'closed') {
        emitEvent(generationId, 'transport/process_error', { message: 'Codex app-server process reported an error before exit.' });
      }
    });
    spawned.on('exit', (code, signal) => {
      markProcessExited(spawned);
      handleProcessExit(spawned, generationId, managerError('ZEUS_CODEX_GENERATION_EXITED', `Codex app-server generation exited (${String(code ?? signal ?? 'unknown')}).`));
    });

    const handshake = (async () => {
      const initializeResponse = await rpc(generationId, 'initialize', {
        clientInfo: { name: 'zeus', title: 'Zeus', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      write({ method: 'initialized' });
      const modelList = await retryableReadRpc(generationId, 'model/list', {});
      const models = parseModels(modelList);
      const goals = await readGoalCapability(generationId);
      if (remoteControlEnabled || remoteControlTransport) await rpc(generationId, 'remoteControl/enable', {});
      const capabilities: CodexCapabilitiesSnapshot = {
        generationId,
        initializedAt: now(),
        providerVersion: providerVersionFromInitialize(initializeResponse) ?? providerVersionFallback,
        protocolVersion: 'codex-app-server-v2',
        models,
        supportedModels: models.map((model) => model.model),
        preflightTokenCount: {
          state: 'unavailable',
          exact: false,
          reason: '当前 app-server 协议没有请求前 token-count RPC；仅提供请求后的真实 usage 通知。',
        },
        goals,
      };
      if (child !== spawned) throw managerError('ZEUS_CODEX_GENERATION_EXITED', 'Codex app-server generation changed during initialization.');
      state = { type: 'ready', generationId, capabilities };
      restartAttempt = 0;
      return capabilities;
    })();
    return handshake.catch((error: unknown) => {
      const failure = asError(error);
      if (child === spawned) {
        spawned.kill('SIGTERM');
      }
      const unavailableReason = remoteControlTransport ? `Zeus 无法启动会话远程接管所需的 Codex Remote Control（${command}）：${failure.message}` : `用户本机 Codex CLI 无法启动兼容的 app-server（${command}）：${failure.message}`;
      const recoveryGuidance = remoteControlTransport
        ? codexRemoteControlRecoveryGuidance(env)
        : '请运行官方安装命令 curl -fsSL https://chatgpt.com/codex/install.sh | sh，完成登录后在 Zeus 设置中重新检测；Zeus 不会自动安装或使用内置回退。';
      throw managerError('ZEUS_CODEX_DEPENDENCY_UNAVAILABLE', `${unavailableReason}。${recoveryGuidance}`);
    });
  }

  function trackProcessExit(process: CodexAppServerProcess): void {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    processExitTrackers.set(process, { promise, resolve, exited: false });
  }

  function markProcessExited(process: CodexAppServerProcess): void {
    const tracker = processExitTrackers.get(process);
    if (!tracker || tracker.exited) return;
    tracker.exited = true;
    tracker.resolve();
    processExitTrackers.delete(process);
  }

  async function terminateProcess(process: CodexAppServerProcess): Promise<void> {
    const tracker = processExitTrackers.get(process);
    if (!tracker || tracker.exited) return;
    process.kill('SIGTERM');
    if (await resolveBeforeTimeout(tracker.promise, shutdownTimeoutMs)) return;
    if (!tracker.exited) process.kill('SIGKILL');
    await tracker.promise;
  }

  function handleProcessExit(process: CodexAppServerProcess, generationId: string, error: Error): void {
    if (child !== process) return;
    child = null;
    rejectGeneration(generationId, error);
    for (const [key, request] of serverRequests) {
      if (request.generationId === generationId) serverRequests.delete(key);
    }
    if (preparingForShutdown || state.type === 'closed') return;
    scheduleRestart(generationId);
  }

  function scheduleRestart(generationId: string): void {
    restartAttempt += 1;
    const delay = RESTART_DELAYS_MS[Math.min(restartAttempt - 1, RESTART_DELAYS_MS.length - 1)];
    state = { type: 'restarting', generationId, attempt: restartAttempt };
    options.onRestartScheduled?.(delay, restartAttempt);
    readyPromise = new Promise<CodexCapabilitiesSnapshot>((resolve, reject) => {
      rejectScheduledRestart = reject;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        rejectScheduledRestart = null;
        if (preparingForShutdown || state.type === 'closed' || commandPath === null) {
          reject(managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager is closing.'));
          return;
        }
        start(commandPath).then(resolve, reject);
      }, delay);
    });
    void readyPromise.catch(() => undefined);
  }

  function write(message: unknown, completed?: (error?: Error) => void): void {
    if (child === null) throw managerError('ZEUS_CODEX_NOT_READY', 'Codex app-server process is unavailable.');
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      completed?.(error ?? undefined);
    });
  }

  function rpc(generationId: string, method: string, params: unknown, input: { requestWritten?: () => void; traceIdentity?: string | null; timeoutMs?: number } = {}): Promise<unknown> {
    if (preparingForShutdown || state.type === 'closed') return Promise.reject(managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager is closing.'));
    if (generationId !== currentGenerationId()) return Promise.reject(managerError('ZEUS_CODEX_STALE_GENERATION', 'Codex app-server generation is stale.'));
    const id = `${generationId}:${++requestSequence}`;
    return new Promise((resolve, reject) => {
      // 官方 stdio 协议把 RPC 回包与过程通知复用在同一条 JSONL stdout 上。
      // 任何已写出的 RPC 都必须保持读取窗口，否则事件投影的异步背压会把回包一起堵住。
      const finishRpcRead = beginRpcRead(generationId, method === 'turn/interrupt' ? 2_000 : 0);
      const timeout = setTimeout(
        () => {
          const key = pendingKey(generationId, id);
          const pending = pendingRequests.get(key);
          pendingRequests.delete(key);
          if (pending) pending.reject(managerError('ZEUS_CODEX_RPC_TIMEOUT', `Codex app-server request timed out: ${method}`));
        },
        Math.max(1, input.timeoutMs ?? requestTimeoutMs),
      );
      pendingRequests.set(pendingKey(generationId, id), {
        generationId,
        method,
        traceIdentity: input.traceIdentity ?? null,
        resolve(value) {
          finishRpcRead();
          resolve(value);
        },
        reject(error) {
          finishRpcRead();
          reject(error);
        },
        timeout,
      });
      try {
        write({ id, method, params }, (error) => {
          if (!error) {
            input.requestWritten?.();
            return;
          }
          const key = pendingKey(generationId, id);
          const pending = pendingRequests.get(key);
          if (!pending) return;
          clearTimeout(pending.timeout);
          pendingRequests.delete(key);
          pending.reject(error);
        });
      } catch (error) {
        clearTimeout(timeout);
        const key = pendingKey(generationId, id);
        const pending = pendingRequests.get(key);
        pendingRequests.delete(key);
        if (pending) pending.reject(asError(error));
      }
    });
  }

  async function retryableReadRpc(generationId: string, method: string, params: unknown, input: { traceIdentity?: string | null; timeoutMs?: number } = {}): Promise<unknown> {
    const approved = SAFE_READ_RPC_METHODS.has(method) && (method !== 'account/read' || (isRecord(params) && params.refreshToken !== true));
    if (!approved) throw managerError('ZEUS_CODEX_RPC_RETRY_METHOD_UNSAFE', `Codex RPC is not approved for automatic retry: ${method}`);
    const deadline = Date.now() + SAFE_READ_RPC_DEADLINE_MS;
    let lastTimeout: unknown;
    for (let attempt = 0; attempt <= SAFE_READ_RPC_MAX_RETRIES; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 && lastTimeout) throw lastTimeout;
      const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? requestTimeoutMs, SAFE_READ_RPC_ATTEMPT_TIMEOUT_MS, Math.max(1, remainingMs)));
      try {
        return await rpc(generationId, method, params, { ...input, timeoutMs });
      } catch (error) {
        if (!isCodexRpcTimeout(error) || attempt >= SAFE_READ_RPC_MAX_RETRIES) throw error;
        lastTimeout = error;
        const retryAttempt = attempt + 1;
        const nominalDelayMs = SAFE_READ_RPC_INITIAL_DELAY_MS * 2 ** attempt;
        const jitteredDelayMs = Math.max(0, Math.round(nominalDelayMs * (0.9 + Math.random() * 0.2)));
        const remainingAfterAttemptMs = Math.max(0, deadline - Date.now());
        const remainingAttempts = SAFE_READ_RPC_MAX_RETRIES - retryAttempt + 1;
        const delayMs = Math.min(jitteredDelayMs, Math.max(0, remainingAfterAttemptMs - remainingAttempts));
        emitRpcRetry({
          generationId,
          method,
          retryAttempt,
          maxRetries: SAFE_READ_RPC_MAX_RETRIES,
          delayMs,
          occurredAt: now(),
          ...(codexRpcRetryContext.getStore() ?? {}),
        });
        if (delayMs > 0) await waitFor(delayMs);
      }
    }
    throw lastTimeout;
  }

  function emitRpcRetry(event: CodexRpcRetryProgress): void {
    for (const listener of rpcRetryListeners) {
      try {
        listener(event);
      } catch {
        // 重试进度只用于诊断和临时 UI，消费者失败不能改变真实 RPC 生命周期。
      }
    }
  }

  async function readGoalCapability(generationId: string): Promise<CodexCapabilitiesSnapshot['goals']> {
    try {
      const response = asRecord(await retryableReadRpc(generationId, 'experimentalFeature/list', { limit: 200 }));
      if (!Array.isArray(response.data)) return { supported: false, enabled: false, stage: null };
      const goal = response.data.find((entry) => isRecord(entry) && entry.name === 'goals');
      if (!isRecord(goal)) return { supported: false, enabled: false, stage: null };
      const stage = goal.stage === 'beta' || goal.stage === 'underDevelopment' || goal.stage === 'stable' || goal.stage === 'deprecated' || goal.stage === 'removed' ? goal.stage : null;
      return {
        supported: stage !== null && stage !== 'removed',
        enabled: goal.enabled === true,
        stage,
      };
    } catch {
      // 旧版 app-server 没有实验能力目录时，目标入口保持隐藏。
      return { supported: false, enabled: false, stage: null };
    }
  }

  function handleWireMessage(generationId: string, message: CodexWireMessage): void {
    if ('id' in message && !('method' in message)) {
      const key = pendingKey(generationId, message.id);
      const pending = pendingRequests.get(key);
      if (!pending) return;
      pendingRequests.delete(key);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          Object.assign(new Error(message.error.message), {
            code: message.error.code,
            data: message.error.data,
            dispatchDisposition: 'runtime_rejected' as const,
          }),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!('method' in message)) return;
    const requestId = 'id' in message ? message.id : undefined;
    const requestKey = requestId === undefined ? null : serverRequestKey(generationId, requestId);
    const existingRequest = requestKey === null ? undefined : serverRequests.get(requestKey);
    const paramsIdentity = requestId === undefined ? null : canonicalJson(message.params);
    if (requestId !== undefined && existingRequest && (existingRequest.method !== message.method || existingRequest.paramsIdentity !== paramsIdentity)) {
      existingRequest.state = 'conflicted';
      write({ id: requestId, error: { code: -32600, message: 'Conflicting Codex server request identity.' } });
      const originalParams = isRecord(existingRequest.params) ? existingRequest.params : {};
      const receivedParams = isRecord(message.params) ? message.params : {};
      emitEvent(
        generationId,
        'transport/server_request_identity_conflict',
        {
          originalMethod: existingRequest.method,
          receivedMethod: message.method,
          ...(typeof originalParams.threadId === 'string' ? { threadId: originalParams.threadId } : typeof receivedParams.threadId === 'string' ? { threadId: receivedParams.threadId } : {}),
          ...(typeof originalParams.turnId === 'string' ? { turnId: originalParams.turnId } : typeof receivedParams.turnId === 'string' ? { turnId: receivedParams.turnId } : {}),
        },
        requestId,
      );
      return;
    }
    if (requestId !== undefined && existingRequest?.state === 'conflicted') {
      write({ id: requestId, error: { code: -32600, message: 'Conflicting Codex server request identity.' } });
      return;
    }
    if (requestId !== undefined && !supportedServerRequestMethods.has(message.method)) {
      if (!existingRequest && requestKey !== null && paramsIdentity !== null) {
        serverRequests.set(requestKey, { generationId, method: message.method, params: message.params, paramsIdentity, state: 'unsupported' });
      }
      write({ id: requestId, error: { code: -32601, message: 'Unsupported Codex server request method.' } });
      const params = isRecord(message.params) ? message.params : {};
      emitEvent(generationId, 'transport/unsupported_server_request', {
        method: message.method,
        ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
        ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
      });
      return;
    }
    if (requestId !== undefined && requestKey !== null && paramsIdentity !== null) {
      if (existingRequest?.state === 'pending') return;
      if (existingRequest) {
        existingRequest.state = 'pending';
      } else {
        serverRequests.set(requestKey, { generationId, method: message.method, params: message.params, paramsIdentity, state: 'pending' });
      }
    }
    if (message.method === 'serverRequest/resolved') {
      const params = isRecord(message.params) ? message.params : {};
      const resolvedRequestId = typeof params.requestId === 'string' || typeof params.requestId === 'number' ? params.requestId : null;
      if (resolvedRequestId !== null) serverRequests.delete(serverRequestKey(generationId, resolvedRequestId));
    }
    if (message.method === 'account/updated') {
      lastAccountSnapshot = null;
      lastAccountRateLimitsSnapshot = null;
      lastAccountUsageSnapshot = null;
    } else if (message.method === 'account/rateLimits/updated') {
      lastAccountRateLimitsSnapshot = null;
    }
    emitEvent(generationId, message.method, message.params, requestId);
    if (message.method === 'externalAgentConfig/import/progress' || message.method === 'externalAgentConfig/import/completed') {
      try {
        const parsed = parseExternalAgentImportNotification(message.method, message.params);
        const event = { ...parsed, generationId };
        for (const listener of externalAgentImportListeners) {
          try {
            listener(event);
          } catch {
            // Consumer failures are isolated from the app-server transport and other listeners.
          }
        }
      } catch (error) {
        emitEvent(generationId, 'transport/protocol_error', {
          code: 'INVALID_EXTERNAL_AGENT_IMPORT_NOTIFICATION',
          detail: asError(error).message,
        });
      }
    }
    if (message.method === 'turn/started') observeTurnStarted(generationId, message.params);
  }

  function emitEvent(generationId: string, method: string, params: unknown, requestId?: CodexWireId): void {
    const event: CodexAppServerEvent = {
      generationId,
      sequence: ++eventSequence,
      method,
      params,
      receivedAt: now(),
      ...(requestId === undefined ? {} : { requestId }),
    };
    if (eventReplayLimit > 0) {
      eventReplayBuffer.push(event);
      if (eventReplayBuffer.length > eventReplayLimit) eventReplayBuffer.splice(0, eventReplayBuffer.length - eventReplayLimit);
    }
    const pendingDeliveries: Promise<void>[] = [];
    for (const listener of listeners) {
      try {
        const delivery = listener(event);
        if (delivery && typeof delivery.then === 'function') pendingDeliveries.push(delivery);
      } catch {
        // Consumer failures must not break decoding, request settlement, or other listeners.
      }
    }
    if (pendingDeliveries.length > 0) applyEventDeliveryBackpressure(generationId, pendingDeliveries);
  }

  function applyEventDeliveryBackpressure(generationId: string, deliveries: Promise<void>[]): void {
    const source = child;
    if (!source) return;
    pendingEventDeliveryCounts.set(source, (pendingEventDeliveryCounts.get(source) ?? 0) + 1);
    if ((pendingRpcReadCounts.get(source) ?? 0) === 0) source.stdout.pause?.();
    void Promise.allSettled(deliveries).then(() => {
      const remaining = Math.max(0, (pendingEventDeliveryCounts.get(source) ?? 1) - 1);
      if (remaining > 0) {
        pendingEventDeliveryCounts.set(source, remaining);
        return;
      }
      pendingEventDeliveryCounts.delete(source);
      if (child !== source || state.type === 'closed') return;
      if (state.type !== 'idle' && state.generationId !== generationId) return;
      source.stdout.resume?.();
    });
  }

  function beginRpcRead(generationId: string, releaseDelayMs: number): () => void {
    const source = child;
    if (!source) return () => undefined;
    pendingRpcReadCounts.set(source, (pendingRpcReadCounts.get(source) ?? 0) + 1);
    source.stdout.resume?.();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      // 中断响应和终态通知需要短暂全双工窗口；纯控制读取只需让响应本身越过
      // 过程投影背压，下一轮事件循环就恢复普通背压。
      const timer = setTimeout(() => {
        const remaining = Math.max(0, (pendingRpcReadCounts.get(source) ?? 1) - 1);
        if (remaining > 0) {
          pendingRpcReadCounts.set(source, remaining);
          return;
        }
        pendingRpcReadCounts.delete(source);
        if (child !== source || state.type === 'closed') return;
        if (state.type !== 'idle' && state.generationId !== generationId) return;
        if ((pendingEventDeliveryCounts.get(source) ?? 0) > 0) source.stdout.pause?.();
      }, releaseDelayMs);
      timer.unref?.();
    };
  }

  function observeTurnStarted(generationId: string, params: unknown): void {
    const record = isRecord(params) ? params : {};
    const threadId = typeof record.threadId === 'string' ? record.threadId : null;
    const turn = isRecord(record.turn) ? record.turn : {};
    const turnId = typeof turn.id === 'string' ? turn.id : typeof record.turnId === 'string' ? record.turnId : null;
    if (!threadId || !turnId) return;
    const key = turnKey(threadId, turnId);
    startedTurns.add(key);
    if (!pendingInterrupts.delete(key)) return;
    void rpc(generationId, 'turn/interrupt', { threadId, turnId }).catch(() => undefined);
  }

  function rejectGeneration(generationId: string, error: Error): void {
    for (const [key, pending] of pendingRequests) {
      if (pending.generationId !== generationId) continue;
      clearTimeout(pending.timeout);
      pendingRequests.delete(key);
      pending.reject(error);
    }
  }

  async function awaitCapabilities(): Promise<CodexCapabilitiesSnapshot> {
    if (state.type === 'ready') return state.capabilities;
    if (readyPromise) return readyPromise;
    throw managerError('ZEUS_CODEX_NOT_READY', 'Call ensureReady before using Codex app-server.');
  }

  function requireModel(capabilities: CodexCapabilitiesSnapshot, modelName: string): CodexModelCapability {
    const model = capabilities.models.find((candidate) => candidate.model === modelName || candidate.id === modelName);
    if (!model) {
      throw Object.assign(new Error(`Configured Codex model is unavailable: ${modelName}`), {
        code: 'ZEUS_CODEX_MODEL_UNAVAILABLE',
        supportedModels: [...capabilities.supportedModels],
      });
    }
    return model;
  }

  return {
    ensureReady(input) {
      if (state.type === 'closed' || preparingForShutdown) return Promise.reject(managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager is closing.'));
      if (commandPath !== null && commandPath !== input.commandPath) {
        return Promise.reject(managerError('ZEUS_CODEX_COMMAND_PATH_CHANGED', 'Codex command path cannot change while the manager is active.'));
      }
      const requestedExternalAgentHome = input.externalAgentHome ?? null;
      if (requestedExternalAgentHome !== null && !isAbsolute(requestedExternalAgentHome)) {
        return Promise.reject(managerError('ZEUS_CODEX_EXTERNAL_AGENT_HOME_INVALID', 'Codex external-agent home must be an absolute path.'));
      }
      if (commandPath !== null && externalAgentHome !== requestedExternalAgentHome) {
        return Promise.reject(managerError('ZEUS_CODEX_EXTERNAL_AGENT_HOME_CHANGED', 'Codex external-agent home cannot change while the manager is active.'));
      }
      const requestedRemoteControlTransport = input.remoteControl === true;
      if (commandPath !== null && remoteControlTransport !== requestedRemoteControlTransport) {
        return Promise.reject(managerError('ZEUS_CODEX_REMOTE_CONTROL_TRANSPORT_CHANGED', 'Codex remote-control transport cannot change while the manager is active.'));
      }
      const requestedProviderEnvironment = input.providerEnvironment === undefined ? providerEnvironment : normalizeProviderEnvironment(input.providerEnvironment);
      if (commandPath !== null && !sameStringRecord(providerEnvironment, requestedProviderEnvironment)) {
        return Promise.reject(managerError('ZEUS_CODEX_PROVIDER_ENVIRONMENT_CHANGED', 'Codex provider environment cannot change while the manager is active.'));
      }
      commandPath = input.commandPath;
      externalAgentHome = requestedExternalAgentHome;
      remoteControlTransport = requestedRemoteControlTransport;
      providerEnvironment = requestedProviderEnvironment;
      if (remoteControlTransport) remoteControlEnabled = true;
      if (state.type === 'ready') return Promise.resolve(state.capabilities);
      if (readyPromise) return readyPromise;
      readyPromise = start(input.commandPath);
      void readyPromise.catch(() => undefined);
      return readyPromise;
    },
    async readAccount(input = {}) {
      const capabilities = await awaitCapabilities();
      const refreshToken = input.refreshToken === true;
      const cached = lastAccountSnapshot?.value.generationId === capabilities.generationId ? lastAccountSnapshot : null;
      if (input.cachedOnly === true) {
        if (cached) return cached.value;
        throw managerError('ZEUS_CODEX_ACCOUNT_SNAPSHOT_UNAVAILABLE', '当前 app-server 世代还没有可复用的账号快照。');
      }
      const preferCached = input.preferCached ?? !refreshToken;
      if (preferCached && cached && Date.now() - cached.cachedAt < ACCOUNT_SNAPSHOT_TTL_MS) return cached.value;
      const flightKey = `${capabilities.generationId}:${refreshToken ? 'refresh' : 'local'}`;
      let request = accountReadInFlight.get(flightKey);
      if (!request) {
        request = (async () => {
          const accountRead = refreshToken ? rpc : retryableReadRpc;
          const snapshot = parseAccountSnapshot(
            await accountRead(capabilities.generationId, 'account/read', { refreshToken }, { ...(refreshToken ? {} : { timeoutMs: Math.min(requestTimeoutMs, 8_000) }) }),
            capabilities.generationId,
            accountFingerprintSalt,
          );
          lastAccountSnapshot = { value: snapshot, cachedAt: Date.now() };
          return snapshot;
        })();
        accountReadInFlight.set(flightKey, request);
        const clearFlight = () => {
          if (accountReadInFlight.get(flightKey) === request) accountReadInFlight.delete(flightKey);
        };
        void request.then(clearFlight, clearFlight);
      }
      try {
        return await request;
      } catch (error) {
        const allowCached = input.allowCachedOnTransportFailure ?? !refreshToken;
        if (allowCached && cached && isAccountReadTransportFailure(error)) return cached.value;
        throw error;
      }
    },
    async readAccountRateLimits() {
      const capabilities = await awaitCapabilities();
      const cached = lastAccountRateLimitsSnapshot;
      if (cached?.value.generationId === capabilities.generationId && Date.now() - cached.cachedAt < ACCOUNT_USAGE_SNAPSHOT_TTL_MS) return cached.value;
      const existing = accountRateLimitsReadInFlight.get(capabilities.generationId);
      if (existing) return existing;
      const request: Promise<CodexAccountRateLimitsSnapshot> = (async () => {
        const snapshot = parseAccountRateLimitsSnapshot(await retryableReadRpc(capabilities.generationId, 'account/rateLimits/read', {}, { timeoutMs: Math.min(requestTimeoutMs, 8_000) }), capabilities.generationId);
        lastAccountRateLimitsSnapshot = { value: snapshot, cachedAt: Date.now() };
        return snapshot;
      })().finally(() => {
        if (accountRateLimitsReadInFlight.get(capabilities.generationId) === request) accountRateLimitsReadInFlight.delete(capabilities.generationId);
      });
      accountRateLimitsReadInFlight.set(capabilities.generationId, request);
      return request;
    },
    async readAccountUsage() {
      const capabilities = await awaitCapabilities();
      const cached = lastAccountUsageSnapshot;
      if (cached?.value.generationId === capabilities.generationId && Date.now() - cached.cachedAt < ACCOUNT_USAGE_SNAPSHOT_TTL_MS) return cached.value;
      const existing = accountUsageReadInFlight.get(capabilities.generationId);
      if (existing) return existing;
      const request: Promise<CodexAccountUsageSnapshot> = (async () => {
        const snapshot = parseAccountUsageSnapshot(await retryableReadRpc(capabilities.generationId, 'account/usage/read', {}, { timeoutMs: Math.min(requestTimeoutMs, 8_000) }), capabilities.generationId);
        lastAccountUsageSnapshot = { value: snapshot, cachedAt: Date.now() };
        return snapshot;
      })().finally(() => {
        if (accountUsageReadInFlight.get(capabilities.generationId) === request) accountUsageReadInFlight.delete(capabilities.generationId);
      });
      accountUsageReadInFlight.set(capabilities.generationId, request);
      return request;
    },
    async startChatGptLogin() {
      const capabilities = await awaitCapabilities();
      return parseChatGptLogin(
        await rpc(capabilities.generationId, 'account/login/start', {
          type: 'chatgpt',
          // Zeus 自己轮询权威登录状态并回到原窗口；不让托管成功页把本次流程收口到 ChatGPT。
          useHostedLoginSuccessPage: false,
          appBrand: 'chatgpt',
        }),
        capabilities.generationId,
      );
    },
    async cancelChatGptLogin(input) {
      const capabilities = await awaitCapabilities();
      if (!input.loginId.trim()) throw managerError('ZEUS_CODEX_LOGIN_ID_INVALID', 'Codex login id is required.');
      await rpc(capabilities.generationId, 'account/login/cancel', { loginId: input.loginId });
    },
    async startThread(input) {
      const capabilities = await awaitCapabilities();
      const responsesProvider = input.responsesRuntime ? normalizeResponsesProvider(input.responsesRuntime.provider) : null;
      if (responsesProvider) {
        if (!providerEnvironment[responsesProvider.envKey]) throw managerError('ZEUS_CODEX_PROVIDER_CREDENTIAL_UNAVAILABLE', 'Responses 自定义 Provider 的进程凭据不可用。');
        if (input.serviceTier !== undefined && input.serviceTier !== null) throw managerError('ZEUS_CODEX_SERVICE_TIER_UNAVAILABLE', 'Responses 自定义 Provider 不支持 Codex service tier。');
      } else {
        const model = requireModel(capabilities, input.model);
        validateServiceTier(model, input.serviceTier);
      }
      if (input.config !== undefined) throw managerError('ZEUS_CODEX_CONFIG_UNAVAILABLE', 'Raw Codex thread config overrides are not supported.');
      const sandbox = normalizeThreadSandbox(input.sandbox);
      const response = asRecord(
        await rpc(
          capabilities.generationId,
          'thread/start',
          compactObject({
            model: input.model,
            modelProvider: responsesProvider?.id,
            serviceTier: input.serviceTier,
            cwd: input.cwd,
            approvalPolicy: input.approvalPolicy,
            approvalsReviewer: input.approvalsReviewer,
            sandbox: sandbox.mode,
            runtimeWorkspaceRoots: sandbox.runtimeWorkspaceRoots,
            baseInstructions: input.baseInstructions,
            developerInstructions: input.developerInstructions,
            ephemeral: input.ephemeral,
            dynamicTools: input.dynamicTools,
            config: responsesProvider ? responsesProviderConfig(responsesProvider) : undefined,
          }),
          { traceIdentity: input.traceIdentity },
        ),
      );
      const thread = parseThread(response.thread);
      const responseModel = typeof response.model === 'string' ? response.model : input.model;
      threadModels.set(thread.id, responseModel);
      if (responsesProvider) threadResponsesProviders.set(thread.id, responsesProvider);
      return attachThreadProviderSettings(thread, capabilities.generationId, response, responseModel);
    },
    async resumeThread(input) {
      const capabilities = await awaitCapabilities();
      const responsesProvider = input.responsesRuntime ? normalizeResponsesProvider(input.responsesRuntime.provider) : threadResponsesProviders.get(input.threadId);
      const response = asRecord(
        await rpc(
          capabilities.generationId,
          'thread/resume',
          compactObject({
            threadId: input.threadId,
            cwd: input.cwd,
            modelProvider: responsesProvider?.id,
            config: responsesProvider ? responsesProviderConfig(responsesProvider) : undefined,
          }),
        ),
      );
      const thread = parseThread(response.thread);
      const responseModel = typeof response.model === 'string' ? response.model : threadModels.get(thread.id);
      if (responseModel) threadModels.set(thread.id, responseModel);
      if (responsesProvider) threadResponsesProviders.set(thread.id, responsesProvider);
      return responseModel ? attachThreadProviderSettings(thread, capabilities.generationId, response, responseModel) : thread;
    },
    async archiveThread(input) {
      const capabilities = await awaitCapabilities();
      await rpc(capabilities.generationId, 'thread/archive', { threadId: input.threadId }, { traceIdentity: input.traceIdentity });
      threadModels.delete(input.threadId);
      threadResponsesProviders.delete(input.threadId);
    },
    async unarchiveThread(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(await rpc(capabilities.generationId, 'thread/unarchive', { threadId: input.threadId }, { traceIdentity: input.traceIdentity }));
      return parseThread(response.thread);
    },
    async readThread(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(await retryableReadRpc(capabilities.generationId, 'thread/read', { threadId: input.threadId, includeTurns: input.includeTurns ?? false }));
      return parseThread(response.thread);
    },
    async listThreads(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(await retryableReadRpc(capabilities.generationId, 'thread/list', compactObject({ ...input })));
      if (!Array.isArray(response.data) || (response.nextCursor !== null && typeof response.nextCursor !== 'string')) {
        throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex thread/list returned an invalid page.');
      }
      return {
        data: response.data.map(parseThread),
        nextCursor: response.nextCursor,
      };
    },
    async readThreadGoal(input) {
      const capabilities = await awaitCapabilities();
      assertGoalsEnabled(capabilities);
      const response = asRecord(await retryableReadRpc(capabilities.generationId, 'thread/goal/get', input));
      return response.goal === null ? null : parseThreadGoal(response.goal);
    },
    async setThreadGoal(input) {
      const capabilities = await awaitCapabilities();
      assertGoalsEnabled(capabilities);
      if (input.objective !== undefined) validateGoalObjective(input.objective);
      const response = asRecord(
        await rpc(capabilities.generationId, 'thread/goal/set', compactObject({ threadId: input.threadId, objective: input.objective, status: input.status, tokenBudget: input.tokenBudget }), { traceIdentity: input.traceIdentity }),
      );
      return parseThreadGoal(response.goal);
    },
    async clearThreadGoal(input) {
      const capabilities = await awaitCapabilities();
      assertGoalsEnabled(capabilities);
      const response = asRecord(await rpc(capabilities.generationId, 'thread/goal/clear', { threadId: input.threadId }, { traceIdentity: input.traceIdentity }));
      if (typeof response.cleared !== 'boolean') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex thread/goal/clear response omitted cleared.');
      return { cleared: response.cleared };
    },
    async listThreadTurns(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(
        await retryableReadRpc(
          capabilities.generationId,
          'thread/turns/list',
          compactObject({
            threadId: input.threadId,
            cursor: input.cursor,
            limit: input.limit,
            sortDirection: input.sortDirection,
            itemsView: input.itemsView,
          }),
        ),
      );
      if (!Array.isArray(response.data) || (response.nextCursor !== null && typeof response.nextCursor !== 'string')) {
        throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex thread/turns/list returned an invalid page.');
      }
      return {
        data: response.data.map((turn) => parseTurn(turn, input.threadId)),
        nextCursor: response.nextCursor,
      };
    },
    async listSkills(input) {
      const capabilities = await awaitCapabilities();
      return parseSkillsList(await retryableReadRpc(capabilities.generationId, 'skills/list', compactObject(input)));
    },
    async startTurn(input) {
      const capabilities = await awaitCapabilities();
      const modelName = input.model ?? threadModels.get(input.threadId);
      const responsesProvider = input.responsesRuntime ? normalizeResponsesProvider(input.responsesRuntime.provider) : threadResponsesProviders.get(input.threadId);
      if (responsesProvider) threadResponsesProviders.set(input.threadId, responsesProvider);
      const model = !responsesProvider && modelName ? requireModel(capabilities, modelName) : null;
      const wireEffort = toCodexWireReasoningEffort(input.effort);
      const wireCollaborationMode = input.collaborationMode
        ? {
            ...input.collaborationMode,
            settings: {
              ...input.collaborationMode.settings,
              reasoning_effort: toCodexWireReasoningEffort(input.collaborationMode.settings.reasoning_effort) ?? null,
            },
          }
        : undefined;
      if (typeof wireEffort === 'string' && !responsesProvider) {
        const supportedEfforts = model?.supportedReasoningEfforts ?? [];
        if (!model || !supportedEfforts.includes(wireEffort)) {
          throw Object.assign(new Error(`Configured Codex effort is unavailable: ${wireEffort}`), {
            code: 'ZEUS_CODEX_EFFORT_UNAVAILABLE',
            supportedEfforts: [...supportedEfforts],
          });
        }
      }
      if (input.serviceTier !== undefined && !responsesProvider) {
        if (!model) throw managerError('ZEUS_CODEX_MODEL_UNAVAILABLE', 'Codex service tier validation requires a known model.');
        validateServiceTier(model, input.serviceTier);
      }
      if (wireCollaborationMode && !responsesProvider) {
        const collaborationModel = requireModel(capabilities, wireCollaborationMode.settings.model);
        const collaborationEffort = wireCollaborationMode.settings.reasoning_effort;
        if (collaborationEffort !== null && !collaborationModel.supportedReasoningEfforts.includes(collaborationEffort)) {
          throw Object.assign(new Error(`Configured Codex effort is unavailable: ${collaborationEffort}`), {
            code: 'ZEUS_CODEX_EFFORT_UNAVAILABLE',
            supportedEfforts: [...collaborationModel.supportedReasoningEfforts],
          });
        }
      }
      const sandboxPolicy = input.sandboxPolicy === undefined ? undefined : normalizeTurnSandbox(input.sandboxPolicy);
      const response = asRecord(
        await rpc(
          capabilities.generationId,
          'turn/start',
          compactObject({
            threadId: input.threadId,
            clientUserMessageId: input.clientUserMessageId,
            input: input.input,
            additionalContext: input.additionalContext,
            collaborationMode: wireCollaborationMode,
            model: input.model,
            effort: wireEffort,
            serviceTier: input.serviceTier,
            summary: input.summary,
            cwd: input.cwd,
            approvalPolicy: input.approvalPolicy,
            approvalsReviewer: input.approvalsReviewer,
            sandboxPolicy,
          }),
          { requestWritten: input.requestWritten, traceIdentity: input.traceIdentity },
        ),
      );
      const turn = parseTurn(response.turn, input.threadId);
      if (input.model) threadModels.set(input.threadId, input.model);
      return turn;
    },
    async steerTurn(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(
        await rpc(
          capabilities.generationId,
          'turn/steer',
          {
            threadId: input.threadId,
            expectedTurnId: input.turnId,
            clientUserMessageId: input.clientUserMessageId,
            input: input.input,
          },
          { traceIdentity: input.traceIdentity },
        ),
      );
      if (typeof response.turnId !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex turn/steer response omitted turnId.');
      return { turnId: response.turnId };
    },
    async interruptTurn(input) {
      const capabilities = await awaitCapabilities();
      const key = turnKey(input.threadId, input.turnId);
      if (!startedTurns.has(key)) {
        pendingInterrupts.add(key);
        return;
      }
      await rpc(capabilities.generationId, 'turn/interrupt', { threadId: input.threadId, turnId: input.turnId }, { traceIdentity: input.traceIdentity });
    },
    async respondToServerRequest(input) {
      const generationId = currentGenerationId();
      if (input.generationId !== generationId) throw managerError('ZEUS_CODEX_STALE_GENERATION', 'Cannot respond to a server request from another generation.');
      const key = serverRequestKey(generationId, input.requestId);
      const request = serverRequests.get(key);
      if (!request) throw managerError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request is not pending.');
      if (request.state === 'conflicted') throw managerError('ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT', 'Codex server request identity is conflicted.');
      if (request.state !== 'pending') throw managerError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request is not pending.');
      const expectedMethod = serverMethodForResponse(input.type);
      if (request.method !== expectedMethod) throw managerError('ZEUS_CODEX_SERVER_REQUEST_TYPE_MISMATCH', `Expected ${request.method}, received ${input.type}.`);
      validateServerResponse(input);
      let result: Record<string, unknown>;
      switch (input.type) {
        case 'command':
        case 'file':
          result = { decision: input.decision };
          break;
        case 'permissions':
          result = compactObject({ permissions: input.permissions, scope: input.scope, strictAutoReview: input.strictAutoReview });
          break;
        case 'request_user_input':
          result = { answers: input.answers };
          break;
        case 'mcp':
          result = { action: input.action, content: input.content, _meta: input._meta };
          break;
        case 'dynamic_tool':
          result = { contentItems: input.contentItems, success: input.success };
          break;
      }
      write({ id: input.requestId, result });
      request.state = 'responded';
    },
    async readRemoteControlStatus() {
      const capabilities = await awaitCapabilities();
      return parseRemoteControlStatus(await retryableReadRpc(capabilities.generationId, 'remoteControl/status/read', undefined));
    },
    async enableRemoteControl(input = {}) {
      const capabilities = await awaitCapabilities();
      const status = parseRemoteControlStatus(await rpc(capabilities.generationId, 'remoteControl/enable', compactObject({ ephemeral: input.ephemeral })));
      remoteControlEnabled = true;
      return status;
    },
    async disableRemoteControl(input = {}) {
      const capabilities = await awaitCapabilities();
      const status = parseRemoteControlStatus(await rpc(capabilities.generationId, 'remoteControl/disable', compactObject({ ephemeral: input.ephemeral })));
      remoteControlEnabled = false;
      return status;
    },
    async startRemoteControlPairing(input = {}) {
      const capabilities = await awaitCapabilities();
      return parseRemoteControlPairing(await rpc(capabilities.generationId, 'remoteControl/pairing/start', compactObject({ manualCode: input.manualCode })));
    },
    async readRemoteControlPairingStatus(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(await retryableReadRpc(capabilities.generationId, 'remoteControl/pairing/status', compactObject(input)));
      if (typeof response.claimed !== 'boolean') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote pairing status omitted claimed.');
      return { claimed: response.claimed };
    },
    async listRemoteControlClients(input) {
      const capabilities = await awaitCapabilities();
      return parseRemoteControlClients(await retryableReadRpc(capabilities.generationId, 'remoteControl/client/list', compactObject(input)));
    },
    async revokeRemoteControlClient(input) {
      const capabilities = await awaitCapabilities();
      await rpc(capabilities.generationId, 'remoteControl/client/revoke', input);
    },
    async detectExternalAgentConfig(input = {}) {
      const capabilities = await awaitCapabilities();
      return parseExternalAgentConfigDetectResponse(
        await retryableReadRpc(
          capabilities.generationId,
          'externalAgentConfig/detect',
          compactObject({
            includeHome: input.includeHome,
            cwds: input.cwds,
            source: input.source,
            migrationSource: input.migrationSource,
          }),
        ),
      );
    },
    async startExternalAgentImport(input) {
      const capabilities = await awaitCapabilities();
      return parseExternalAgentConfigImportResponse(await rpc(capabilities.generationId, 'externalAgentConfig/import', input));
    },
    async readExternalAgentImportHistories() {
      const capabilities = await awaitCapabilities();
      return parseExternalAgentConfigImportHistoriesResponse(await retryableReadRpc(capabilities.generationId, 'externalAgentConfig/import/readHistories', {})).data;
    },
    subscribeExternalAgentImport(listener) {
      externalAgentImportListeners.add(listener);
      return () => externalAgentImportListeners.delete(listener);
    },
    subscribeRpcRetries(listener) {
      rpcRetryListeners.add(listener);
      return () => rpcRetryListeners.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      for (const event of eventReplayBuffer) {
        try {
          const delivery = listener(event);
          if (delivery && typeof delivery.then === 'function') applyEventDeliveryBackpressure(event.generationId, [delivery]);
        } catch {
          // 回放消费者异常与实时消费者一样隔离。
        }
      }
      return () => listeners.delete(listener);
    },
    getState() {
      return state;
    },
    hasGeneration(generationId) {
      return state.type !== 'idle' && state.type !== 'closed' && state.generationId === generationId;
    },
    generationForThread() {
      return state.type === 'idle' || state.type === 'closed' ? null : state.generationId;
    },
    listRuntimeGenerations() {
      if (state.type === 'idle' || state.type === 'closed' || commandPath === null) return [];
      return [
        {
          generationId: state.generationId,
          commandPath,
          state: state.type,
          active: true,
          activeThreadCount: 0,
          pendingRequestCount: serverRequests.size,
        },
      ];
    },
    async prepareForShutdown() {
      preparingForShutdown = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      rejectScheduledRestart?.(managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager is closing.'));
      rejectScheduledRestart = null;
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        preparingForShutdown = true;
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
        rejectScheduledRestart?.(managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager closed.'));
        rejectScheduledRestart = null;
        const process = child;
        const previousGeneration = state.type === 'idle' || state.type === 'closed' ? null : state.generationId;
        state = { type: 'closed' };
        if (previousGeneration) rejectGeneration(previousGeneration, managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager closed.'));
        if (process) await terminateProcess(process);
        if (child === process) child = null;
        listeners.clear();
        externalAgentImportListeners.clear();
        rpcRetryListeners.clear();
        eventReplayBuffer.length = 0;
        serverRequests.clear();
        pendingInterrupts.clear();
        startedTurns.clear();
        accountReadInFlight.clear();
        accountRateLimitsReadInFlight.clear();
        accountUsageReadInFlight.clear();
        lastAccountSnapshot = null;
        lastAccountRateLimitsSnapshot = null;
        lastAccountUsageSnapshot = null;
      })();
      return closePromise;
    },
  };
}

function spawnNodeCodexAppServer(command: string, args: string[], options?: CodexAppServerSpawnOptions): CodexAppServerProcess {
  const child = nodeSpawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: options?.env });
  return child as unknown as CodexAppServerProcess;
}

/**
 * 连接官方 Remote Control 守护进程，并把 WebSocket 文本帧适配为现有 JSONL 传输。
 * 守护进程由官方 CLI 管理；Zeus 退出只断开自己的控制连接，不擅自停止用户已启用的远程宿主。
 */
function spawnRemoteControlCodexAppServer(command: string, options: CodexAppServerSpawnOptions): CodexAppServerProcess {
  const stdout = new EventEmitter() as CodexAppServerReadable;
  const stderr = new EventEmitter() as CodexAppServerReadable;
  const lifecycle = new EventEmitter();
  const pendingMessages: string[] = [];
  let inputBuffer = '';
  let socket: WebSocket | null = null;
  let deliveryPaused = false;
  let stopping = false;
  let exited = false;

  stdout.pause = () => {
    deliveryPaused = true;
    socket?.pause();
  };
  stdout.resume = () => {
    deliveryPaused = false;
    socket?.resume();
  };

  function finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (exited) return;
    exited = true;
    lifecycle.emit('exit', code, signal);
  }

  function fail(error: Error): void {
    if (stopping || exited) return;
    (stderr as EventEmitter).emit('data', error.message);
    lifecycle.emit('error', error);
    finishExit(1, null);
  }

  function sendMessage(message: string): void {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(message);
      return;
    }
    pendingMessages.push(message);
  }

  const processAdapter: CodexAppServerProcess = {
    // 守护进程由官方 CLI 管理，Zeus 只持有 WebSocket，不能把自身 PID 伪装成 Codex 子进程。
    stdin: {
      write(chunk) {
        inputBuffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        const lines = inputBuffer.split('\n');
        inputBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) sendMessage(line);
        }
        return true;
      },
    },
    stdout,
    stderr,
    on(event, listener) {
      lifecycle.on(event, listener);
      return this;
    },
    kill(signal = 'SIGTERM') {
      if (stopping || exited) return false;
      stopping = true;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close(1000, 'Zeus transport closed');
        const forceClose = setTimeout(() => socket?.terminate(), 500);
        forceClose.unref();
      } else {
        socket?.terminate();
        finishExit(null, signal);
      }
      return true;
    },
  };

  void (async () => {
    const daemon = await startRemoteControlDaemon(command, options.env, (chunk) => (stderr as EventEmitter).emit('data', chunk));
    if (stopping || exited) return;
    socket = new WebSocket('ws://localhost/rpc', {
      createConnection: () => createConnection({ path: daemon.socketPath }),
      perMessageDeflate: false,
    });
    socket.on('open', () => {
      if (deliveryPaused) socket?.pause();
      for (const message of pendingMessages.splice(0)) socket?.send(message);
    });
    socket.on('message', (data: RawData) => {
      const text = rawWebSocketText(data);
      if (text !== null) (stdout as EventEmitter).emit('data', Buffer.from(`${text}\n`, 'utf8'));
    });
    socket.on('error', (error) => fail(error instanceof Error ? error : new Error('Codex Remote Control WebSocket failed.')));
    socket.on('close', () => finishExit(stopping ? null : 1, stopping ? 'SIGTERM' : null));
  })().catch((error: unknown) => fail(asError(error)));

  return processAdapter;
}

async function startRemoteControlDaemon(command: string, env: NodeJS.ProcessEnv, onStderr: (chunk: Buffer | string) => void): Promise<{ socketPath: string }> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, ['remote-control', 'start', '--json'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(managerError('ZEUS_CODEX_REMOTE_CONTROL_START_TIMEOUT', 'Codex Remote Control 守护进程启动超时。'));
    }, 30_000);
    timeout.unref();
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += toBuffer(chunk).toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += toBuffer(chunk).toString('utf8');
      onStderr(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const diagnostic = summarizeStderr(stderr);
        reject(managerError('ZEUS_CODEX_REMOTE_CONTROL_START_FAILED', `官方 Codex Remote Control 守护进程启动失败（${String(code ?? signal ?? 'unknown')}）：${diagnostic || '没有返回诊断信息'}。请确认 Zeus 使用官方独立安装版 Codex CLI。`));
        return;
      }
      try {
        const result = parseLastJsonObject(stdout);
        const daemon = asRecord(result.daemon);
        const socketPath = typeof daemon.socketPath === 'string' ? daemon.socketPath : null;
        if (!socketPath || !isAbsolute(socketPath)) throw new Error('启动结果没有返回绝对控制套接字路径。');
        resolve({ socketPath });
      } catch (error) {
        reject(managerError('ZEUS_CODEX_REMOTE_CONTROL_START_INVALID', `无法读取 Codex Remote Control 启动结果：${asError(error).message}`));
      }
    });
  });
}

function rawWebSocketText(data: RawData): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return null;
}

function parseLastJsonObject(value: string): Record<string, unknown> {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return asRecord(JSON.parse(lines[index]!));
    } catch {
      // 官方 CLI 可能在 JSON 前输出升级提示，只取最后一个有效 JSON 对象。
    }
  }
  throw new Error('Codex CLI 没有返回 JSON 启动结果。');
}

function codexRemoteControlRecoveryGuidance(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim();
  if (!codexHome || !isAbsolute(codexHome)) {
    return '请运行官方安装命令 curl -fsSL https://chatgpt.com/codex/install.sh | sh，完成登录后在 Zeus 设置中重新检测；Zeus 不会自动安装或使用内置回退。';
  }
  const installDirectory = join(codexHome, 'bin');
  const installCommand = `curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_HOME=${quotePosixShellArgument(codexHome)} CODEX_INSTALL_DIR=${quotePosixShellArgument(installDirectory)} sh`;
  return `默认安装到其他 CODEX_HOME 不能修复 Zeus 的独立运行目录。请运行 ${installCommand}，完成 Zeus 专属 Codex 登录后在设置中重新检测；Zeus 不会自动安装或使用内置回退。`;
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseModels(value: unknown): CodexModelCapability[] {
  const response = asRecord(value);
  if (!Array.isArray(response.data)) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex model/list response omitted data.');
  return response.data.map((entry) => {
    const model = asRecord(entry);
    if (typeof model.id !== 'string' || typeof model.model !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex model/list returned an invalid model.');
    const effortEntries = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
    const supportedReasoningEfforts = effortEntries.map((effort) => (isRecord(effort) && typeof effort.reasoningEffort === 'string' ? effort.reasoningEffort : null)).filter((effort): effort is string => effort !== null);
    const serviceTierEntries = model.serviceTiers === undefined ? [] : model.serviceTiers;
    if (!Array.isArray(serviceTierEntries)) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex model/list returned invalid service tiers.');
    const serviceTiers = serviceTierEntries.map((entry) => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string' || !entry.name || typeof entry.description !== 'string') {
        throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex model/list returned an invalid service tier.');
      }
      return { id: entry.id, name: entry.name, description: entry.description };
    });
    return {
      id: model.id,
      model: model.model,
      ...(typeof model.displayName === 'string' ? { displayName: model.displayName } : {}),
      supportedReasoningEfforts,
      ...(typeof model.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      serviceTiers,
      ...(typeof model.defaultServiceTier === 'string' || model.defaultServiceTier === null ? { defaultServiceTier: model.defaultServiceTier } : {}),
      raw: model,
    };
  });
}

function parseSkillsList(value: unknown): CodexSkillsListEntry[] {
  const response = asRecord(value);
  if (!Array.isArray(response.data)) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex skills/list response omitted data.');
  return response.data.map((rawEntry) => {
    const entry = asRecord(rawEntry);
    if (typeof entry.cwd !== 'string' || !Array.isArray(entry.skills) || !Array.isArray(entry.errors)) {
      throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex skills/list returned an invalid entry.');
    }
    const skills = entry.skills.map((rawSkill) => {
      const skill = asRecord(rawSkill);
      if (
        typeof skill.name !== 'string' ||
        typeof skill.description !== 'string' ||
        typeof skill.path !== 'string' ||
        !isAbsolute(skill.path) ||
        (skill.scope !== 'user' && skill.scope !== 'repo' && skill.scope !== 'system' && skill.scope !== 'admin') ||
        typeof skill.enabled !== 'boolean'
      ) {
        throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex skills/list returned invalid skill metadata.');
      }
      const scope: CodexSkillScope = skill.scope;
      return {
        name: skill.name,
        description: skill.description,
        ...(typeof skill.shortDescription === 'string' ? { shortDescription: skill.shortDescription } : {}),
        path: skill.path,
        scope,
        enabled: skill.enabled,
        ...(isRecord(skill.interface) ? { interface: skill.interface } : {}),
        ...(isRecord(skill.dependencies) ? { dependencies: skill.dependencies } : {}),
      };
    });
    const errors = entry.errors.map((error) => asRecord(error));
    return { cwd: entry.cwd, skills, errors };
  });
}

function validateServiceTier(model: CodexModelCapability, serviceTier: string | null | undefined): void {
  if (serviceTier === undefined || serviceTier === null) return;
  if (model.serviceTiers.some((tier) => tier.id === serviceTier)) return;
  throw Object.assign(new Error(`Configured Codex service tier is unavailable: ${serviceTier}`), {
    code: 'ZEUS_CODEX_SERVICE_TIER_UNAVAILABLE',
    supportedServiceTiers: model.serviceTiers.map((tier) => tier.id),
  });
}

function normalizeResponsesProvider(provider: CodexResponsesModelProvider): CodexResponsesModelProvider {
  const id = provider.id.trim();
  const name = provider.name.trim();
  const envKey = provider.envKey.trim();
  if (!/^[a-z0-9_-]{1,100}$/iu.test(id) || !name || name.length > 100) throw managerError('ZEUS_CODEX_PROVIDER_INVALID', 'Responses 自定义 Provider 身份无效。');
  if (!/^ZEUS_MODEL_CONNECTION_[A-Z0-9_]+_API_KEY$/u.test(envKey)) throw managerError('ZEUS_CODEX_PROVIDER_INVALID', 'Responses 自定义 Provider 环境变量名无效。');
  let url: URL;
  try {
    url = new URL(provider.baseUrl);
  } catch {
    throw managerError('ZEUS_CODEX_PROVIDER_INVALID', 'Responses 自定义 Provider 地址无效。');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw managerError('ZEUS_CODEX_PROVIDER_INVALID', 'Responses 自定义 Provider 必须使用无凭据的 HTTPS 地址。');
  if (!Number.isSafeInteger(provider.modelContextWindow) || provider.modelContextWindow < 1_000 || provider.modelContextWindow > 10_000_000) {
    throw managerError('ZEUS_CODEX_PROVIDER_INVALID', 'Responses 自定义 Provider 上下文窗口无效。');
  }
  return { id, name, baseUrl: url.toString().replace(/\/+$/u, ''), envKey, modelContextWindow: provider.modelContextWindow };
}

function responsesProviderConfig(provider: CodexResponsesModelProvider): Record<string, JsonValue> {
  return {
    model_provider: provider.id,
    model_context_window: provider.modelContextWindow,
    model_providers: {
      [provider.id]: {
        name: provider.name,
        base_url: provider.baseUrl,
        env_key: provider.envKey,
        wire_api: 'responses',
        requires_openai_auth: false,
      },
    },
  };
}

function normalizeProviderEnvironment(value: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, secret] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^ZEUS_MODEL_CONNECTION_[A-Z0-9_]+_API_KEY$/u.test(key) || typeof secret !== 'string' || !secret.trim()) {
      throw managerError('ZEUS_CODEX_PROVIDER_ENVIRONMENT_INVALID', 'Codex provider environment contains an invalid entry.');
    }
    normalized[key] = secret;
  }
  return normalized;
}

function sameStringRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function attachThreadProviderSettings(thread: CodexThreadSnapshot, generationId: string, response: Record<string, unknown>, model: string): CodexThreadSnapshot {
  const effort = typeof response.effort === 'string' ? response.effort : typeof response.reasoningEffort === 'string' ? response.reasoningEffort : undefined;
  const hasServiceTier = Object.prototype.hasOwnProperty.call(response, 'serviceTier');
  const serviceTier = typeof response.serviceTier === 'string' || response.serviceTier === null ? response.serviceTier : undefined;
  return {
    ...thread,
    providerSettings: {
      generationId,
      sequence: 0,
      model,
      ...(effort ? { effort } : {}),
      ...(hasServiceTier && serviceTier !== undefined ? { serviceTier } : {}),
    },
  };
}

function parseThread(value: unknown): CodexThreadSnapshot {
  const thread = asRecord(value);
  if (typeof thread.id !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex thread response omitted id.');
  const status = parseThreadRuntimeStatus(thread.status);
  return { ...thread, id: thread.id, ...(status ? { status } : {}) };
}

function parseThreadRuntimeStatus(value: unknown): CodexThreadRuntimeStatus | undefined {
  if (value === undefined) return undefined;
  const status = asRecord(value);
  if (status.type === 'notLoaded' || status.type === 'idle') return { type: status.type };
  if (status.type === 'systemError') return { ...status, type: 'systemError' };
  if (status.type === 'active' && Array.isArray(status.activeFlags) && status.activeFlags.every((flag) => typeof flag === 'string')) {
    return { type: 'active', activeFlags: [...status.activeFlags] };
  }
  throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex thread response returned an unknown runtime status.');
}

function parseTurn(value: unknown, threadId: string): CodexTurnSnapshot {
  const turn = asRecord(value);
  if (typeof turn.id !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex turn response omitted id.');
  return { ...turn, id: turn.id, threadId };
}

function assertGoalsEnabled(capabilities: CodexCapabilitiesSnapshot): void {
  if (capabilities.goals.supported && capabilities.goals.enabled) return;
  throw managerError('ZEUS_CODEX_GOALS_UNAVAILABLE', '当前 Codex app-server 未启用原生目标能力。');
}

function validateGoalObjective(objective: string): void {
  const normalized = objective.trim();
  if (!normalized || [...normalized].length > 4_000) {
    throw managerError('ZEUS_CODEX_GOAL_OBJECTIVE_INVALID', '目标必须为 1 到 4000 个字符。');
  }
}

function parseThreadGoal(value: unknown): CodexThreadGoal {
  const goal = asRecord(value);
  const statuses: readonly CodexThreadGoalStatus[] = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'];
  if (
    typeof goal.threadId !== 'string' ||
    typeof goal.objective !== 'string' ||
    !statuses.includes(goal.status as CodexThreadGoalStatus) ||
    (goal.tokenBudget !== null && (!Number.isSafeInteger(goal.tokenBudget) || Number(goal.tokenBudget) <= 0)) ||
    !Number.isSafeInteger(goal.tokensUsed) ||
    Number(goal.tokensUsed) < 0 ||
    typeof goal.timeUsedSeconds !== 'number' ||
    !Number.isFinite(goal.timeUsedSeconds) ||
    Number(goal.timeUsedSeconds) < 0 ||
    typeof goal.createdAt !== 'number' ||
    typeof goal.updatedAt !== 'number'
  ) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex thread goal response is invalid.');
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status as CodexThreadGoalStatus,
    tokenBudget: goal.tokenBudget === null ? null : Number(goal.tokenBudget),
    tokensUsed: Number(goal.tokensUsed),
    timeUsedSeconds: Number(goal.timeUsedSeconds),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function parseAccountSnapshot(value: unknown, generationId: string, accountFingerprintSalt: string): CodexAccountSnapshot {
  const response = asRecord(value);
  if (typeof response.requiresOpenaiAuth !== 'boolean') {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex account/read response omitted requiresOpenaiAuth.');
  }
  if (response.account !== null && !isRecord(response.account)) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex account/read returned an invalid account.');
  }
  const account = isRecord(response.account) ? response.account : null;
  const accountType = account && typeof account.type === 'string' ? account.type : null;
  const planType = account && typeof account.planType === 'string' ? account.planType : null;
  const identity = accountType === 'chatgpt' && account && typeof account.email === 'string' ? account.email.trim().toLowerCase() : (accountType ?? 'signed-out');
  return {
    generationId,
    requiresOpenaiAuth: response.requiresOpenaiAuth,
    signedIn: account !== null,
    accountType,
    planType,
    accountScopeId: createHash('sha256').update(`zeus:codex:account:${accountFingerprintSalt}:${identity}`).digest('hex'),
  };
}

function parseAccountRateLimitsSnapshot(value: unknown, generationId: string): CodexAccountRateLimitsSnapshot {
  const response = asRecord(value);
  const rateLimits = parseRateLimitBucket(response.rateLimits);
  let rateLimitsByLimitId: Record<string, CodexRateLimitBucketSnapshot> | null = null;
  if (response.rateLimitsByLimitId !== null && response.rateLimitsByLimitId !== undefined) {
    const buckets = asRecord(response.rateLimitsByLimitId);
    rateLimitsByLimitId = Object.fromEntries(Object.entries(buckets).map(([limitId, bucket]) => [limitId, parseRateLimitBucket(bucket)]));
  }
  return { generationId, rateLimits, rateLimitsByLimitId };
}

function parseRateLimitBucket(value: unknown): CodexRateLimitBucketSnapshot {
  const bucket = asRecord(value);
  return {
    limitId: nullableString(bucket.limitId),
    limitName: nullableString(bucket.limitName),
    primary: parseRateLimitWindow(bucket.primary),
    secondary: parseRateLimitWindow(bucket.secondary),
    credits: parseRateLimitCredits(bucket.credits),
    planType: nullableString(bucket.planType),
  };
}

function parseRateLimitWindow(value: unknown): CodexRateLimitWindowSnapshot | null {
  if (value === null || value === undefined) return null;
  const window = asRecord(value);
  return {
    usedPercent: nonNegativeNumber(window.usedPercent, 'rate limit usedPercent'),
    windowDurationMins: nullableNonNegativeNumber(window.windowDurationMins, 'rate limit windowDurationMins'),
    resetsAt: nullableNonNegativeNumber(window.resetsAt, 'rate limit resetsAt'),
  };
}

function parseRateLimitCredits(value: unknown): CodexRateLimitBucketSnapshot['credits'] {
  if (value === null || value === undefined) return null;
  const credits = asRecord(value);
  if (typeof credits.hasCredits !== 'boolean' || typeof credits.unlimited !== 'boolean' || (credits.balance !== null && typeof credits.balance !== 'string')) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex rate limits returned invalid credits.');
  }
  return { hasCredits: credits.hasCredits, unlimited: credits.unlimited, balance: credits.balance };
}

function parseAccountUsageSnapshot(value: unknown, generationId: string): CodexAccountUsageSnapshot {
  const response = asRecord(value);
  const summary = asRecord(response.summary);
  let dailyUsageBuckets: CodexAccountUsageSnapshot['dailyUsageBuckets'] = null;
  if (response.dailyUsageBuckets !== null && response.dailyUsageBuckets !== undefined) {
    if (!Array.isArray(response.dailyUsageBuckets)) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex account usage returned invalid daily buckets.');
    dailyUsageBuckets = response.dailyUsageBuckets.map((entry) => {
      const bucket = asRecord(entry);
      if (typeof bucket.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(bucket.startDate)) {
        throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex account usage returned an invalid bucket date.');
      }
      return { startDate: bucket.startDate, tokens: nonNegativeSafeInteger(bucket.tokens, 'daily usage tokens') };
    });
  }
  return {
    generationId,
    summary: {
      lifetimeTokens: nullableNonNegativeSafeInteger(summary.lifetimeTokens, 'lifetime tokens'),
      peakDailyTokens: nullableNonNegativeSafeInteger(summary.peakDailyTokens, 'peak daily tokens'),
      longestRunningTurnSec: nullableNonNegativeSafeInteger(summary.longestRunningTurnSec, 'longest running turn'),
      currentStreakDays: nullableNonNegativeSafeInteger(summary.currentStreakDays, 'current streak'),
      longestStreakDays: nullableNonNegativeSafeInteger(summary.longestStreakDays, 'longest streak'),
    },
    dailyUsageBuckets,
  };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex response returned an invalid string field.');
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', `Codex response returned invalid ${label}.`);
  return value;
}

function nullableNonNegativeNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeNumber(value, label);
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', `Codex response returned invalid ${label}.`);
  return value;
}

function nullableNonNegativeSafeInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeSafeInteger(value, label);
}

function parseChatGptLogin(value: unknown, generationId: string): CodexChatGptLogin {
  const response = asRecord(value);
  if (response.type !== 'chatgpt' || typeof response.loginId !== 'string' || !response.loginId || typeof response.authUrl !== 'string') {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex account/login/start returned an invalid account login.');
  }
  let authUrl: URL;
  try {
    authUrl = new URL(response.authUrl);
  } catch {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex account/login/start returned an invalid login URL.');
  }
  if (authUrl.protocol !== 'https:') {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex account/login/start returned a non-HTTPS login URL.');
  }
  return {
    generationId,
    loginId: response.loginId,
    authUrl: authUrl.href,
  };
}

function parseRemoteControlStatus(value: unknown): CodexRemoteControlStatus {
  const response = asRecord(value);
  if (!['disabled', 'connecting', 'connected', 'errored'].includes(String(response.status))) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned an invalid status.');
  }
  if (typeof response.serverName !== 'string' || typeof response.installationId !== 'string' || (response.environmentId !== null && typeof response.environmentId !== 'string')) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned an invalid identity.');
  }
  return {
    status: response.status as CodexRemoteControlConnectionStatus,
    serverName: response.serverName,
    installationId: response.installationId,
    environmentId: response.environmentId,
  };
}

function parseRemoteControlPairing(value: unknown): CodexRemoteControlPairing {
  const response = asRecord(value);
  if (
    typeof response.pairingCode !== 'string' ||
    (response.manualPairingCode !== null && typeof response.manualPairingCode !== 'string') ||
    typeof response.environmentId !== 'string' ||
    typeof response.expiresAt !== 'number' ||
    !Number.isSafeInteger(response.expiresAt)
  ) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned invalid pairing data.');
  }
  return {
    pairingCode: response.pairingCode,
    manualPairingCode: response.manualPairingCode,
    environmentId: response.environmentId,
    expiresAt: response.expiresAt,
  };
}

function parseRemoteControlClients(value: unknown): CodexRemoteControlClientsPage {
  const response = asRecord(value);
  if (!Array.isArray(response.data) || (response.nextCursor !== null && typeof response.nextCursor !== 'string')) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned an invalid client list.');
  }
  return {
    data: response.data.map((value) => {
      const client = asRecord(value);
      if (typeof client.clientId !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned an invalid client.');
      for (const key of ['displayName', 'deviceType', 'platform', 'osVersion', 'deviceModel', 'appVersion'] as const) {
        if (client[key] !== null && typeof client[key] !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned invalid client metadata.');
      }
      if (client.lastSeenAt !== null && (typeof client.lastSeenAt !== 'number' || !Number.isSafeInteger(client.lastSeenAt))) {
        throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned an invalid client timestamp.');
      }
      return {
        clientId: client.clientId,
        displayName: client.displayName as string | null,
        deviceType: client.deviceType as string | null,
        platform: client.platform as string | null,
        osVersion: client.osVersion as string | null,
        deviceModel: client.deviceModel as string | null,
        appVersion: client.appVersion as string | null,
        lastSeenAt: client.lastSeenAt,
      };
    }),
    nextCursor: response.nextCursor,
  };
}

function normalizeThreadSandbox(sandbox: CodexSandboxPolicy): { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; runtimeWorkspaceRoots?: string[] } {
  if (!isRecord(sandbox)) throw managerError('ZEUS_CODEX_SANDBOX_UNAVAILABLE', 'Codex sandbox is invalid.');
  if (sandbox.type === 'readOnly' && sandbox.networkAccess === false) return { mode: 'read-only' };
  if (sandbox.type === 'dangerFullAccess' && Object.keys(sandbox).length === 1) return { mode: 'danger-full-access' };
  if (sandbox.type === 'workspaceWrite' && sandbox.networkAccess === false && validWritableRoots(sandbox.writableRoots)) {
    return { mode: 'workspace-write', runtimeWorkspaceRoots: [...sandbox.writableRoots] };
  }
  throw managerError('ZEUS_CODEX_SANDBOX_UNAVAILABLE', 'Codex sandbox must be read-only, workspace-write, or danger-full-access.');
}

function normalizeTurnSandbox(sandbox: CodexSandboxPolicy): Record<string, unknown> {
  if (!isRecord(sandbox)) throw managerError('ZEUS_CODEX_SANDBOX_UNAVAILABLE', 'Codex sandbox is invalid.');
  if (sandbox.type === 'readOnly' && sandbox.networkAccess === false) return { type: 'readOnly', networkAccess: false };
  if (sandbox.type === 'dangerFullAccess' && Object.keys(sandbox).length === 1) return { type: 'dangerFullAccess' };
  if (sandbox.type === 'workspaceWrite' && sandbox.networkAccess === false && validWritableRoots(sandbox.writableRoots)) {
    return {
      type: 'workspaceWrite',
      writableRoots: [...sandbox.writableRoots],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  throw managerError('ZEUS_CODEX_SANDBOX_UNAVAILABLE', 'Codex sandbox must be read-only, workspace-write, or danger-full-access.');
}

function validWritableRoots(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((root) => typeof root === 'string' && isAbsolute(root));
}

function validateServerResponse(input: CodexServerRequestResponse): void {
  if (input.type === 'command') {
    if (!isCommandApprovalDecision(input.decision)) throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex command approval decision is invalid.');
    return;
  }
  if (input.type === 'file') {
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(input.decision)) throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex file approval decision is invalid.');
    return;
  }
  if (input.type === 'permissions') {
    if ((input.scope !== 'turn' && input.scope !== 'session') || !isPermissionProfile(input.permissions) || (input.strictAutoReview !== undefined && typeof input.strictAutoReview !== 'boolean')) {
      throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex permissions response is invalid.');
    }
    return;
  }
  if (input.type === 'request_user_input') {
    if (!isRecord(input.answers) || !Object.values(input.answers).every((answer) => isRecord(answer) && Array.isArray(answer.answers) && answer.answers.every((entry) => typeof entry === 'string'))) {
      throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex request_user_input response is invalid.');
    }
    return;
  }
  if (input.type === 'dynamic_tool') {
    if (
      typeof input.success !== 'boolean' ||
      !Array.isArray(input.contentItems) ||
      !input.contentItems.every((item) => (item.type === 'inputText' && typeof item.text === 'string') || (item.type === 'inputImage' && typeof item.imageUrl === 'string' && item.imageUrl.startsWith('data:image/')))
    ) {
      throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex dynamic tool response is invalid.');
    }
    return;
  }
  if (!['accept', 'decline', 'cancel'].includes(input.action) || !isJsonValue(input.content) || !isJsonValue(input._meta)) {
    throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex MCP response is invalid.');
  }
}

function isCommandApprovalDecision(value: unknown): value is CodexCommandApprovalDecision {
  if (typeof value === 'string') return ['accept', 'acceptForSession', 'decline', 'cancel'].includes(value);
  if (!isRecord(value) || !hasOnlyKeys(value, ['acceptWithExecpolicyAmendment'])) return false;
  const amendment = value.acceptWithExecpolicyAmendment;
  return (
    isRecord(amendment) &&
    hasOnlyKeys(amendment, ['execpolicy_amendment']) &&
    Array.isArray(amendment.execpolicy_amendment) &&
    amendment.execpolicy_amendment.length > 0 &&
    amendment.execpolicy_amendment.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

function isPermissionProfile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['network', 'fileSystem'])) return false;
  if (value.network !== undefined && (!isRecord(value.network) || !hasOnlyKeys(value.network, ['enabled']))) return false;
  if (value.network !== undefined && (!isRecord(value.network) || (value.network.enabled !== null && typeof value.network.enabled !== 'boolean'))) return false;
  if (value.fileSystem !== undefined) {
    if (!isRecord(value.fileSystem)) return false;
    if (!hasOnlyKeys(value.fileSystem, ['read', 'write', 'globScanMaxDepth'])) return false;
    for (const field of ['read', 'write'] as const) {
      const entries = value.fileSystem[field];
      if (entries !== null && (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string' && isAbsolute(entry)))) return false;
    }
    if (value.fileSystem.globScanMaxDepth !== undefined && (!Number.isInteger(value.fileSystem.globScanMaxDepth) || Number(value.fileSystem.globScanMaxDepth) < 0)) return false;
  }
  return true;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function serverMethodForResponse(type: CodexServerRequestResponse['type']): string {
  return {
    command: 'item/commandExecution/requestApproval',
    file: 'item/fileChange/requestApproval',
    permissions: 'item/permissions/requestApproval',
    request_user_input: 'item/tool/requestUserInput',
    mcp: 'mcpServer/elicitation/request',
    dynamic_tool: 'item/tool/call',
  }[type];
}

const supportedServerRequestMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/tool/call',
]);

function pendingKey(generationId: string, id: CodexWireId): string {
  return `${generationId}\u0000${typeof id}:${String(id)}`;
}

function providerVersionFromInitialize(value: unknown): string | null {
  const response = asRecord(value);
  // 新版 app-server 的 initialize 响应可能只返回 userAgent/codexHome/platform，
  // 不再保证携带旧版 serverInfo。版本字段缺失不能使已成功的握手失败。
  const serverInfo = isRecord(response.serverInfo) ? response.serverInfo : {};
  for (const candidate of [serverInfo.version, response.version]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 120);
  }
  if (typeof response.userAgent === 'string') {
    const match = response.userAgent.match(/(?:^|\s|\/)(?:codex|codex-cli|codex\s+desktop)[/@]([A-Za-z0-9_.+-]{1,120})/iu);
    if (match?.[1]) return match[1];
  }
  return null;
}

function normalizeProviderVersion(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
}

function serverRequestKey(generationId: string, id: CodexWireId): string {
  return pendingKey(generationId, id);
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex app-server returned an invalid object.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBuffer(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function summarizeStderr(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu, '[REDACTED]')
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s]+/giu, 'Authorization: Bearer [REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/\b([A-Z0-9_.-]*(?:token|api[_-]?key|password|secret)[A-Z0-9_.-]*)\s*[:=]\s*([^\s,;]+)/giu, '$1=[REDACTED]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 512);
}

function managerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function isCodexRpcTimeout(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ZEUS_CODEX_RPC_TIMEOUT';
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isAccountReadTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = error.code;
  return (
    code === 'ZEUS_CODEX_RPC_TIMEOUT' ||
    code === 'ZEUS_CODEX_NOT_READY' ||
    code === 'ZEUS_CODEX_STALE_GENERATION' ||
    code === 'ZEUS_CODEX_GENERATION_EXITED' ||
    code === 'EPIPE' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT'
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
