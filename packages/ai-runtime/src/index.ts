import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { basename, delimiter, isAbsolute, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { normalizeTerminalChunk } from '@zeus/terminal-core';
import { buildTaskPushPrompt, type TaskPushPromptInput } from '@zeus/shared';
import { expandCliSearchPath } from './cliSearchPath.js';

export * from './codexAppServerManager.js';
export * from './codexAppServerProtocol.js';
export * from './codexRuntimeGenerationManager.js';
export * from './agentRuntimeContracts.js';
export * from './agentRuntimeRegistry.js';
export * from './agentCapabilityCatalog.js';
export * from './piRpcProtocol.js';
export * from './modelConnectionCatalog.js';
export * from './piSdkRuntimeDriver.js';
export { expandCliSearchPath } from './cliSearchPath.js';
export { projectTerminalOutput } from '@zeus/terminal-core';

export interface AiCliDescriptor {
  name: string;
  command: string;
}

export interface AiCliStatus {
  name: string;
  command: string;
  available: boolean;
  reason: string;
}

export interface AiCliAdapterDescriptor extends AiCliDescriptor {
  id: 'codex' | 'claude' | 'gemini' | 'generic';
  displayName: string;
  capabilities: string[];
}

export type NonCodexAiCliAdapterId = Exclude<AiCliAdapterDescriptor['id'], 'codex'>;

export interface AiCliAdapterStatus extends AiCliStatus {
  id: AiCliAdapterDescriptor['id'];
  displayName: string;
  capabilities: string[];
  version: string | null;
  resolvedCommandPath: string | null;
  checkedAt: string;
  compatibility: 'compatible' | 'incompatible' | 'not_checked';
  installationGuideUrl: string | null;
  authStatus: 'unknown' | 'authenticated' | 'unauthenticated';
  modelConfiguration: 'user-configured';
}

export interface AiCliProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CheckAiCliAdapterOptions {
  commandPath?: string;
  findCommand?: (command: string) => Promise<string | null>;
  runCommand?: (commandPath: string, args: string[]) => Promise<AiCliProbeResult>;
  now?: () => string;
}

export type AiRuntimePromptInput = TaskPushPromptInput;

export interface AiCliAdapterInvocation {
  adapterId: NonCodexAiCliAdapterId;
  command: string;
  args: string[];
}

export interface AiCliAdapterInvocationOptions {
  model?: string;
  defaultArgs?: string[];
  commandPath?: string;
}

export type AiRuntimeOutputState = 'running' | 'waiting_input' | 'completed' | 'error';

export interface AiRuntimeOutputStateResult {
  state: AiRuntimeOutputState;
  reason: string;
}

const AI_CLI_ADAPTERS: AiCliAdapterDescriptor[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    displayName: 'OpenAI Codex CLI',
    command: 'codex',
    capabilities: ['detect', 'prompt', 'logs', 'stop'],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    displayName: 'Claude Code CLI',
    command: 'claude',
    capabilities: ['detect', 'prompt', 'logs', 'stop'],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    displayName: 'Gemini CLI',
    command: 'gemini',
    capabilities: ['detect', 'prompt', 'logs', 'stop'],
  },
  {
    id: 'generic',
    name: 'Generic CLI',
    displayName: '通用 CLI Adapter',
    command: 'sh',
    capabilities: ['detect', 'prompt', 'logs', 'stop'],
  },
];
const AI_CLI_ADAPTER_COMMAND_BASENAMES = new Set(AI_CLI_ADAPTERS.map((adapter) => adapter.command));

/** 返回设计书要求的 AI CLI adapter 清单；这里只暴露能力声明，不伪造安装状态。 */
export function listAiCliAdapters(): AiCliAdapterDescriptor[] {
  return AI_CLI_ADAPTERS.map((adapter) => ({
    ...adapter,
    capabilities: [...adapter.capabilities],
  }));
}

/** 构造正式任务首发正文；运行配置和附件必须通过各自通道传递。 */
export function buildAiRuntimePrompt(input: AiRuntimePromptInput): string {
  return buildTaskPushPrompt(input);
}

export function isNonCodexAiCliAdapterId(value: unknown): value is NonCodexAiCliAdapterId {
  return value === 'claude' || value === 'gemini' || value === 'generic';
}

/** 只为明确的非 Codex adapter 生成 CLI 启动命令；Codex 写路径必须使用 native app-server。 */
export function createNonCodexAiCliAdapterInvocation(adapterId: NonCodexAiCliAdapterId, prompt: string, options: AiCliAdapterInvocationOptions = {}): AiCliAdapterInvocation {
  // 该 satisfies 仅是编译期门禁；参数一旦重新包含 Codex，默认 pnpm typecheck 必须失败。
  const runtimeAdapterId: unknown = adapterId satisfies Extract<typeof adapterId, 'codex'> extends never ? typeof adapterId : never;
  if (!isNonCodexAiCliAdapterId(runtimeAdapterId)) {
    if (runtimeAdapterId === 'codex') throw createCodexNativeTransportRequiredError();
    throw new Error(`AI CLI adapter not found: ${String(runtimeAdapterId)}`);
  }
  const adapter = AI_CLI_ADAPTERS.find((candidate) => candidate.id === runtimeAdapterId);
  if (!adapter) throw new Error(`AI CLI adapter not found: ${runtimeAdapterId}`);
  const modelArgs = options.model?.trim() ? ['--model', options.model.trim()] : [];
  const defaultArgs = options.defaultArgs ?? [];
  const argsByAdapter: Record<NonCodexAiCliAdapterId, string[]> = {
    claude: ['-p', ...defaultArgs, prompt, ...modelArgs],
    gemini: ['-p', ...defaultArgs, prompt, ...modelArgs],
    generic: ['-lc', prompt],
  };
  const command = options.commandPath?.trim() || adapter.command;
  const commandBasename = basename(command);
  if (AI_CLI_ADAPTER_COMMAND_BASENAMES.has(commandBasename) && commandBasename !== adapter.command) {
    throw Object.assign(new Error(`AI CLI adapter command identity mismatch: ${runtimeAdapterId} cannot use ${commandBasename}`), {
      code: 'AI_CLI_ADAPTER_COMMAND_IDENTITY_MISMATCH',
    });
  }
  return { adapterId: runtimeAdapterId, command, args: argsByAdapter[runtimeAdapterId] };
}

/** 兼容旧调用点；Codex 在运行时继续 fail-closed，非 Codex 委托给严格 builder。 */
export function createAiCliAdapterInvocation(adapterId: AiCliAdapterDescriptor['id'], prompt: string, options: AiCliAdapterInvocationOptions = {}): AiCliAdapterInvocation {
  if (adapterId === 'codex') throw createCodexNativeTransportRequiredError();
  if (!isNonCodexAiCliAdapterId(adapterId)) throw new Error(`AI CLI adapter not found: ${String(adapterId)}`);
  return createNonCodexAiCliAdapterInvocation(adapterId, prompt, options);
}

function createCodexNativeTransportRequiredError(): Error & { code: string } {
  return Object.assign(new Error('Codex requires the native app-server transport.'), {
    code: 'CODEX_NATIVE_APP_SERVER_REQUIRED',
  });
}

/** 从真实 CLI 输出中识别粗粒度状态，供 UI/通知层提示，不把解析结果当作 AI 结论。 */
export function parseAiRuntimeOutputState(text: string): AiRuntimeOutputStateResult {
  const normalized = text.toLowerCase();
  const waitingPattern = new RegExp('(do you want to proceed|\\(y/n\\)|\\[y/n\\]|需要.*确认|等待.*输入|press enter|continue\\?)', 'i');
  if (waitingPattern.test(text)) {
    return {
      state: 'waiting_input',
      reason: '检测到等待用户输入或确认的输出。',
    };
  }
  if (/(error|failed|exception|traceback|fatal|command failed)/.test(normalized)) {
    return { state: 'error', reason: '检测到错误或失败输出。' };
  }
  if (/(completed|successfully|done|任务完成|已完成)/.test(normalized)) {
    return { state: 'completed', reason: '检测到完成输出。' };
  }
  return { state: 'running', reason: '未检测到等待、完成或错误信号。' };
}

/** 检测单个 adapter 的真实命令可用性、版本输出与显式登录缺失提示；不伪造成功登录。 */
export async function checkAiCliAdapter(adapterId: string, options: CheckAiCliAdapterOptions = {}): Promise<AiCliAdapterStatus> {
  const adapter = AI_CLI_ADAPTERS.find((candidate) => candidate.id === adapterId);
  if (!adapter) throw new Error(`AI CLI adapter not found: ${adapterId}`);
  const checkedAt = options.now?.() ?? new Date().toISOString();
  const findCommand = options.findCommand ?? findCommandOnPath;
  const configuredCommandPath = options.commandPath?.trim();
  const commandPath = configuredCommandPath ? await resolveConfiguredCommandPath(configuredCommandPath, adapter.command) : await findCommand(adapter.command);
  const status: AiCliStatus = commandPath
    ? {
        ...adapter,
        available: true,
        reason: `检测到 ${adapter.name}: ${commandPath}`,
      }
    : {
        ...adapter,
        available: false,
        reason: adapter.id === 'codex' ? codexInstallationGuidance(`未检测到 ${adapter.name}`) : `未检测到 ${adapter.name}，请在 Zeus 设置中配置。`,
      };
  if (!commandPath) {
    return {
      ...status,
      id: adapter.id,
      displayName: adapter.displayName,
      capabilities: [...adapter.capabilities],
      version: null,
      resolvedCommandPath: null,
      checkedAt,
      compatibility: 'not_checked',
      installationGuideUrl: adapter.id === 'codex' ? 'https://chatgpt.com/codex/install.sh' : null,
      authStatus: 'unknown',
      modelConfiguration: 'user-configured',
    };
  }
  const probe = await runAdapterVersionProbe(commandPath, options.runCommand ?? runCommandOnce);
  const version = extractVersion(probe.stdout || probe.stderr);
  const authStatus = detectAuthStatus(`${probe.stdout}\n${probe.stderr}`);
  const capabilityProbe = adapter.id === 'codex' && probe.exitCode === 0 ? await runAdapterCapabilityProbe(commandPath, options.runCommand ?? runCommandOnce) : null;
  const compatible = probe.exitCode === 0 && (adapter.id !== 'codex' || capabilityProbe?.exitCode === 0);
  return {
    ...status,
    available: compatible,
    reason: compatible
      ? buildAdapterProbeReason(adapter, status.reason, version, authStatus)
      : adapter.id === 'codex'
        ? codexInstallationGuidance(`检测到 Codex CLI，但版本探针或 app-server 能力不可用：${commandPath}`)
        : `${status.reason}；版本探针失败，退出码 ${probe.exitCode}。`,
    id: adapter.id,
    displayName: adapter.displayName,
    capabilities: [...adapter.capabilities],
    version,
    resolvedCommandPath: commandPath,
    checkedAt,
    compatibility: compatible ? 'compatible' : 'incompatible',
    installationGuideUrl: adapter.id === 'codex' ? 'https://chatgpt.com/codex/install.sh' : null,
    authStatus,
    modelConfiguration: 'user-configured',
  };
}

export type AiRuntimeSessionStatus = 'running' | 'exited' | 'failed' | 'stopped' | 'orphan_detected' | 'lost';
export type AiRuntimeLogStream = 'system' | 'stdout' | 'stderr';

export interface AiRuntimeLogEntry {
  id: string;
  sessionId: string;
  stream: AiRuntimeLogStream;
  text: string;
  createdAt: string;
}

export interface AiRuntimeSession {
  id: string;
  projectId: string;
  taskId?: string;
  command: string;
  args: string[];
  cwd: string;
  status: AiRuntimeSessionStatus;
  pid?: number;
  exitCode?: number | null;
  summary?: string | null;
  favorite?: boolean;
  archived?: boolean;
  deletedAt?: string | null;
  startedAt: string;
  endedAt?: string;
}

export interface StartAiRuntimeSessionInput {
  projectId: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 只保存在当前进程内，用于在任何日志回调前抹除声明式敏感参数值。 */
  redactValues?: string[];
}

export interface AiRuntimeSpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface AiRuntimeProcessHandle {
  pid?: number;
  on(event: 'stdout' | 'stderr' | 'exit' | 'close' | 'error', callback: (value: unknown) => void): AiRuntimeProcessHandle;
  kill(signal?: NodeJS.Signals): void;
  write?(input: string): void;
  resize?(cols: number, rows: number): void;
}

export type AiRuntimeSpawn = (command: string, args: string[], options: AiRuntimeSpawnOptions) => AiRuntimeProcessHandle;

export interface NodePtyRuntimeProcess {
  pid?: number;
  onData(callback: (chunk: string) => void): void;
  onExit(callback: (event: { exitCode?: number; signal?: number | string }) => void): void;
  write(input: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface NodePtyRuntimeModule {
  spawn(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env?: NodeJS.ProcessEnv;
      name: string;
      cols: number;
      rows: number;
    },
  ): NodePtyRuntimeProcess;
}

export interface CreateNodePtyRuntimeSpawnOptions {
  cols?: number;
  rows?: number;
  terminalName?: string;
}

export function createNodePtyRuntimeSpawn(pty: NodePtyRuntimeModule, options: CreateNodePtyRuntimeSpawnOptions = {}): AiRuntimeSpawn {
  return (command, args, spawnOptions) => {
    const child = pty.spawn(command, args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env ?? process.env,
      name: options.terminalName ?? 'xterm-256color',
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
    });
    return {
      pid: child.pid,
      on(event, callback) {
        if (event === 'stdout') child.onData((chunk) => callback(chunk));
        if (event === 'exit' || event === 'close') child.onExit((exit) => callback(typeof exit.exitCode === 'number' ? exit.exitCode : null));
        return this;
      },
      kill(signal) {
        child.kill(signal);
      },
      write(input) {
        child.write(input);
      },
      resize(cols, rows) {
        child.resize(cols, rows);
      },
    };
  };
}

export interface OptionalNodePtyRuntimeSpawnResult {
  available: boolean;
  reason: string;
  spawn?: AiRuntimeSpawn;
}

export interface CreateOptionalNodePtyRuntimeSpawnOptions extends CreateNodePtyRuntimeSpawnOptions {
  loadNodePty?: () => NodePtyRuntimeModule | null;
}

/**
 * 尝试加载真实 node-pty；依赖未安装时只返回等待状态，不回退伪 PTY。
 */
export function createOptionalNodePtyRuntimeSpawn(options: CreateOptionalNodePtyRuntimeSpawnOptions = {}): OptionalNodePtyRuntimeSpawnResult {
  const pty = (options.loadNodePty ?? loadNodePtyModule)();
  if (!pty) {
    return {
      available: false,
      reason: 'node-pty 依赖未安装，当前使用 child_process 日志终端；完整交互式 PTY 需要用户确认新增原生依赖后启用。',
    };
  }
  return {
    available: true,
    reason: 'node-pty 已可用，Runtime 可使用真实 PTY 后端。',
    spawn: createNodePtyRuntimeSpawn(pty, options),
  };
}

function loadNodePtyModule(): NodePtyRuntimeModule | null {
  try {
    const require = createRequire(import.meta.url);
    const loaded = require('node-pty') as unknown;
    if (isNodePtyRuntimeModule(loaded)) return loaded;
    return null;
  } catch {
    return null;
  }
}

function isNodePtyRuntimeModule(value: unknown): value is NodePtyRuntimeModule {
  return Boolean(value && typeof value === 'object' && typeof (value as { spawn?: unknown }).spawn === 'function');
}

export interface AiRuntimeTerminalSnapshot {
  sessionId: string;
  status: AiRuntimeSessionStatus;
  command: string;
  cwd: string;
  logs: AiRuntimeLogEntry[];
  logsTruncated: boolean;
  capturedAt: string;
}

export interface AiRuntimeSessionManager {
  startSession(input: StartAiRuntimeSessionInput): Promise<AiRuntimeSession>;
  getSession(sessionId: string): AiRuntimeSession | undefined;
  listSessions(): AiRuntimeSession[];
  getLogs(sessionId: string): AiRuntimeLogEntry[];
  inputSession(sessionId: string, input: string): AiRuntimeSession;
  interruptSession(sessionId: string): AiRuntimeSession;
  resizeSession(sessionId: string, cols: number, rows: number): AiRuntimeSession;
  getTerminalSnapshot(sessionId: string): AiRuntimeTerminalSnapshot;
  waitForSessionCompletion(sessionId: string, timeoutMs: number): Promise<boolean>;
  stopSession(sessionId: string): AiRuntimeSession;
  killSession(sessionId: string, signal: NodeJS.Signals): AiRuntimeSession;
  close(): Promise<void>;
}

export interface CreateAiRuntimeSessionManagerOptions {
  allowedRoot: string;
  allowedRoots?: readonly string[] | (() => readonly string[]);
  spawn?: AiRuntimeSpawn;
  now?: () => string;
  onSessionChange?: (session: AiRuntimeSession) => void;
  /** 仅供持久层保存跨重启进程身份；不得进入可序列化会话或对外 API。 */
  onProcessIdentity?: (identity: { sessionId: string; token: string }) => void | Promise<void>;
  /** spawn 后立即持久化真实 PID；回调完成前 Runtime 不会向调用方报告启动成功。 */
  onProcessStarted?: (process: { sessionId: string; pid: number }) => void | Promise<void>;
  onLog?: (log: AiRuntimeLogEntry) => void;
}

const MAX_IN_MEMORY_RUNTIME_LOG_ENTRIES = 2_000;
const MAX_IN_MEMORY_RUNTIME_LOG_BYTES = 4 * 1024 * 1024;
const MAX_IN_MEMORY_RUNTIME_LOG_SESSIONS = 8;
const MAX_IN_MEMORY_RUNTIME_SESSIONS = 64;
const RUNTIME_PROCESS_IDENTITY_ENV = 'ZEUS_RUNTIME_PROCESS_IDENTITY_TOKEN';
const RUNTIME_STOP_TERM_GRACE_MS = 500;
const RUNTIME_STOP_KILL_WAIT_MS = 5_000;

/** 检测 AI CLI 是否存在；只报告真实可用性，不伪造执行输出。 */
export async function detectAiCli(descriptor: AiCliDescriptor): Promise<AiCliStatus> {
  const candidate = await findCommandOnPath(descriptor.command);
  if (candidate)
    return {
      ...descriptor,
      available: true,
      reason: `检测到 ${descriptor.name}: ${candidate}`,
    };
  return {
    ...descriptor,
    available: false,
    reason: `未检测到 ${descriptor.name} CLI，请在 Zeus 设置中配置。`,
  };
}

async function findCommandOnPath(command: string): Promise<string | null> {
  const pathEntries = expandCliSearchPath().split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = resolve(entry, command);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // 继续检查 PATH 中下一个目录。
    }
  }
  return findCommandFromLoginShell(command);
}

async function resolveConfiguredCommandPath(commandPath: string, expectedCommand: string, requireExpectedBasename = false): Promise<string | null> {
  if (!isAbsolute(commandPath) || (requireExpectedBasename && basename(commandPath) !== expectedCommand)) return null;
  try {
    await access(commandPath, constants.X_OK);
    return await realpath(commandPath);
  } catch {
    return null;
  }
}

async function findCommandFromLoginShell(command: string): Promise<string | null> {
  if (!AI_CLI_ADAPTER_COMMAND_BASENAMES.has(command)) return null;
  const shellPath = process.env.SHELL?.trim();
  if (!shellPath || !isAbsolute(shellPath)) return null;
  try {
    await access(shellPath, constants.X_OK);
  } catch {
    return null;
  }
  const result = await runCommandOnce(shellPath, ['-lic', `command -v ${command}`]);
  if (result.exitCode !== 0) return null;
  const candidates = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => isAbsolute(line));
  const candidate = candidates.at(-1);
  return candidate ? resolveConfiguredCommandPath(candidate, command, true) : null;
}

async function runAdapterVersionProbe(commandPath: string, runCommand: (commandPath: string, args: string[]) => Promise<AiCliProbeResult>): Promise<AiCliProbeResult> {
  try {
    return await runCommand(commandPath, ['--version']);
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

async function runAdapterCapabilityProbe(commandPath: string, runCommand: (commandPath: string, args: string[]) => Promise<AiCliProbeResult>): Promise<AiCliProbeResult> {
  try {
    return await runCommand(commandPath, ['app-server', '--help']);
  } catch (error) {
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

function runCommandOnce(commandPath: string, args: string[]): Promise<AiCliProbeResult> {
  return new Promise((resolveProbe) => {
    const child = nodeSpawn(commandPath, args, { shell: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolveProbe({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8') || '版本检测超时',
        exitCode: 124,
      });
    }, 5_000);
    child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolveProbe({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: error.message,
        exitCode: 1,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolveProbe({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: typeof code === 'number' ? code : 0,
      });
    });
  });
}

function extractVersion(text: string): string | null {
  const match = text.match(/(?:v|version\s*)?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/i);
  return match?.[1] ?? null;
}

function detectAuthStatus(text: string): AiCliAdapterStatus['authStatus'] {
  if (/(not logged in|please login|login required|unauthenticated|authentication required|未登录|需要登录)/i.test(text)) {
    return 'unauthenticated';
  }
  return 'unknown';
}

function buildAdapterProbeReason(adapter: AiCliAdapterDescriptor, baseReason: string, version: string | null, authStatus: AiCliAdapterStatus['authStatus']): string {
  if (authStatus === 'unauthenticated') return `${baseReason}；${adapter.name} 需要登录后才能执行任务。`;
  if (version) return `${baseReason}；版本 ${version}。`;
  return `${baseReason}；未能从 --version 输出读取版本。`;
}

function codexInstallationGuidance(reason: string): string {
  return `${reason}。请由用户在终端运行官方安装命令 curl -fsSL https://chatgpt.com/codex/install.sh | sh，完成登录后回到 Zeus 重新检测。Zeus 不会自动安装或回退到内置版本。`;
}

/** 创建 AI Runtime 会话管理器；默认使用真实子进程，不伪造 AI 输出。 */
export function createAiRuntimeSessionManager(options: CreateAiRuntimeSessionManagerOptions): AiRuntimeSessionManager {
  const sessions = new Map<string, AiRuntimeSession>();
  const logs = new Map<string, AiRuntimeLogEntry[]>();
  const logSequences = new Map<string, number>();
  const logBytes = new Map<string, number>();
  const truncatedLogSessions = new Set<string>();
  const handles = new Map<string, AiRuntimeProcessHandle>();
  const closedProcessHandles = new WeakSet<AiRuntimeProcessHandle>();
  const stopRequestedSessions = new Set<string>();
  const completionPromises = new Map<string, Promise<void>>();
  const completionResolvers = new Map<string, () => void>();
  const pendingProcessStarted = new Map<string, Promise<void>>();
  const processStartedResolvers = new Map<string, () => void>();
  const processStartedFailureSessions = new Set<string>();
  const closeFinalizers = new Map<string, Promise<void>>();
  const stopEscalations = new Map<string, Promise<void>>();
  const orphanFinalizers = new Map<string, Promise<void>>();
  const redactedValues = new Map<string, string[]>();
  const runtimeLifecycleErrors: unknown[] = [];
  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const spawn = options.spawn ?? spawnWithNodeChildProcess;
  const now = options.now ?? (() => new Date().toISOString());

  function resolveAllowedRoots(): readonly string[] {
    const dynamicAllowedRoots = typeof options.allowedRoots === 'function' ? options.allowedRoots() : (options.allowedRoots ?? []);
    return [options.allowedRoot, ...dynamicAllowedRoots];
  }

  function appendLog(sessionId: string, stream: AiRuntimeLogStream, text: string): void {
    if (closed) return;
    const entries = logs.get(sessionId) ?? [];
    const exactValues = redactedValues.get(sessionId) ?? [];
    const sequence = (logSequences.get(sessionId) ?? 0) + 1;
    logSequences.set(sessionId, sequence);
    const entry = {
      id: `${sessionId}-log-${sequence}`,
      sessionId,
      stream,
      text: redactExactValues(redactSensitiveText(text), exactValues),
      createdAt: now(),
    };
    const cachedEntry = compactRuntimeLogForMemory(entry);
    if (cachedEntry !== entry) truncatedLogSessions.add(sessionId);
    entries.push(cachedEntry);
    let cachedBytes = (logBytes.get(sessionId) ?? 0) + Buffer.byteLength(cachedEntry.text);
    while (entries.length > 1 && (entries.length > MAX_IN_MEMORY_RUNTIME_LOG_ENTRIES || cachedBytes > MAX_IN_MEMORY_RUNTIME_LOG_BYTES)) {
      const removed = entries.shift();
      if (removed) {
        cachedBytes -= Buffer.byteLength(removed.text);
        truncatedLogSessions.add(sessionId);
      }
    }
    logs.set(sessionId, entries);
    logBytes.set(sessionId, cachedBytes);
    pruneRuntimeLogCaches(sessionId);
    options.onLog?.(entry);
  }

  function pruneRuntimeLogCaches(currentSessionId: string): void {
    if (logs.size <= MAX_IN_MEMORY_RUNTIME_LOG_SESSIONS) return;
    for (const cachedSessionId of logs.keys()) {
      if (logs.size <= MAX_IN_MEMORY_RUNTIME_LOG_SESSIONS) break;
      if (cachedSessionId === currentSessionId || sessions.get(cachedSessionId)?.status === 'running') continue;
      logs.delete(cachedSessionId);
      logBytes.delete(cachedSessionId);
      truncatedLogSessions.add(cachedSessionId);
    }
  }

  function pruneCompletedRuntimeSessions(): void {
    if (sessions.size < MAX_IN_MEMORY_RUNTIME_SESSIONS) return;
    for (const [sessionId, session] of sessions) {
      if (sessions.size < MAX_IN_MEMORY_RUNTIME_SESSIONS) break;
      if (session.status === 'running' || handles.has(sessionId)) continue;
      sessions.delete(sessionId);
      logs.delete(sessionId);
      logSequences.delete(sessionId);
      logBytes.delete(sessionId);
      truncatedLogSessions.delete(sessionId);
    }
  }

  function appendProcessOutput(sessionId: string, stream: 'stdout' | 'stderr', value: unknown): void {
    if (closed) return;
    const text = normalizeProcessChunk(value);
    appendLog(sessionId, stream, text);
  }

  function runtimeSignalErrorCode(error: unknown): string | null {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
  }

  function signalRuntimeHandle(handle: AiRuntimeProcessHandle, signal: NodeJS.Signals): void {
    if (process.platform !== 'win32' && typeof handle.pid === 'number' && Number.isSafeInteger(handle.pid) && handle.pid > 0) {
      try {
        // 两种 POSIX spawn adapter 都以 child PID 建立独立进程组；禁止回退正 PID，避免退出后 PID 复用误杀。
        process.kill(-handle.pid, signal);
        return;
      } catch (error) {
        if (runtimeSignalErrorCode(error) === 'ESRCH') return;
        throw error;
      }
    }
    handle.kill(signal);
  }

  function runtimeProcessTreeIsAlive(handle: AiRuntimeProcessHandle): boolean {
    // 无 PID 时只有真实 close 事件能够证明进程已退出；不能把“无法探测”误当成“不存活”。
    if (typeof handle.pid !== 'number' || !Number.isSafeInteger(handle.pid) || handle.pid <= 0) return !closedProcessHandles.has(handle);
    if (process.platform !== 'win32') {
      try {
        process.kill(-handle.pid, 0);
        return true;
      } catch (error) {
        return runtimeSignalErrorCode(error) !== 'ESRCH';
      }
    }
    try {
      process.kill(handle.pid, 0);
      return true;
    } catch (error) {
      return runtimeSignalErrorCode(error) !== 'ESRCH';
    }
  }

  async function waitForRuntimeProcessTrees(targets: readonly AiRuntimeProcessHandle[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (targets.some(runtimeProcessTreeIsAlive)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    return true;
  }

  async function finalizeRuntimeSessionClose(sessionId: string, handle: AiRuntimeProcessHandle, value: unknown): Promise<void> {
    await pendingProcessStarted.get(sessionId);
    if (closed || handles.get(sessionId) !== handle) return;
    let processTreeExited = !runtimeProcessTreeIsAlive(handle);
    if (!processTreeExited) {
      try {
        signalRuntimeHandle(handle, 'SIGTERM');
        processTreeExited = await waitForRuntimeProcessTrees([handle], 500);
        if (!processTreeExited) {
          signalRuntimeHandle(handle, 'SIGKILL');
          processTreeExited = await waitForRuntimeProcessTrees([handle], 5_000);
        }
      } catch (error) {
        runtimeLifecycleErrors.push(error);
      }
    }
    const current = sessions.get(sessionId);
    if (current) {
      if (processTreeExited && processStartedFailureSessions.has(sessionId)) current.status = 'failed';
      else if (processTreeExited && current.status === 'running') current.status = stopRequestedSessions.has(sessionId) ? 'stopped' : 'exited';
      if (!processTreeExited) current.status = 'orphan_detected';
      current.exitCode = typeof value === 'number' ? value : null;
      current.endedAt = processTreeExited ? now() : undefined;
      try {
        appendLog(sessionId, 'system', processTreeExited ? `AI Runtime 会话已退出：${current.exitCode ?? 'unknown'}` : 'AI Runtime 主进程已退出，但进程组未能确认清理完成。');
      } catch (error) {
        runtimeLifecycleErrors.push(error);
      }
      try {
        options.onSessionChange?.(current);
      } catch (error) {
        runtimeLifecycleErrors.push(error);
      }
    }
    if (!processTreeExited) {
      stopRequestedSessions.add(sessionId);
      runtimeLifecycleErrors.push(new Error(`AI Runtime 主进程 ${handle.pid ?? sessionId} 已退出，但进程组仍存活。`));
      return;
    }
    handles.delete(sessionId);
    stopRequestedSessions.delete(sessionId);
    redactedValues.delete(sessionId);
    completionResolvers.get(sessionId)?.();
    completionResolvers.delete(sessionId);
    completionPromises.delete(sessionId);
    processStartedFailureSessions.delete(sessionId);
  }

  function settleProcessStarted(sessionId: string): void {
    processStartedResolvers.get(sessionId)?.();
    processStartedResolvers.delete(sessionId);
    pendingProcessStarted.delete(sessionId);
  }

  function scheduleRuntimeSessionCloseFinalization(sessionId: string, handle: AiRuntimeProcessHandle, value: unknown): Promise<void> {
    const existing = closeFinalizers.get(sessionId);
    if (existing) return existing;
    const finalizer = finalizeRuntimeSessionClose(sessionId, handle, value).finally(() => {
      if (closeFinalizers.get(sessionId) === finalizer) closeFinalizers.delete(sessionId);
    });
    closeFinalizers.set(sessionId, finalizer);
    return finalizer;
  }

  function scheduleRuntimeStopEscalation(sessionId: string, handle: AiRuntimeProcessHandle): void {
    if (stopEscalations.has(sessionId)) return;
    const escalation = (async () => {
      let processTreeExited = await waitForRuntimeProcessTrees([handle], RUNTIME_STOP_TERM_GRACE_MS);
      if (closed || handles.get(sessionId) !== handle) return;
      if (!processTreeExited) {
        try {
          signalRuntimeHandle(handle, 'SIGKILL');
          appendLog(sessionId, 'system', 'AI Runtime 会话未在宽限期内退出，已升级为强制终止进程组');
        } catch (error) {
          runtimeLifecycleErrors.push(error);
        }
        const completion = completionPromises.get(sessionId);
        const [treeExitedAfterKill, closeCompleted] = await Promise.all([
          waitForRuntimeProcessTrees([handle], RUNTIME_STOP_KILL_WAIT_MS),
          completion ? waitForRuntimeCompletions([completion], RUNTIME_STOP_KILL_WAIT_MS) : Promise.resolve(handles.get(sessionId) !== handle),
        ]);
        processTreeExited = treeExitedAfterKill;
        if (closed || handles.get(sessionId) !== handle) return;
        if (!processTreeExited && !closeCompleted) {
          const current = sessions.get(sessionId);
          if (current) {
            current.status = 'orphan_detected';
            current.endedAt = undefined;
            try {
              appendLog(sessionId, 'system', 'AI Runtime 强制终止后仍未确认进程树退出，已保留 handle 供再次停止。');
            } catch (error) {
              runtimeLifecycleErrors.push(error);
            }
            if (!closing) {
              try {
                options.onSessionChange?.(current);
              } catch (error) {
                runtimeLifecycleErrors.push(error);
              }
            }
          }
          return;
        }
      } else {
        const completion = completionPromises.get(sessionId);
        if (completion && !(await waitForRuntimeCompletions([completion], RUNTIME_STOP_TERM_GRACE_MS)) && handles.get(sessionId) === handle) {
          // 进程树已退出但 adapter 未及时发布 close 时，仍走同一个终态 finalizer。
          await scheduleRuntimeSessionCloseFinalization(sessionId, handle, null);
        }
        return;
      }
      if (processTreeExited && handles.get(sessionId) === handle) await scheduleRuntimeSessionCloseFinalization(sessionId, handle, null);
    })()
      .catch((error) => {
        runtimeLifecycleErrors.push(error);
      })
      .finally(() => {
        if (stopEscalations.get(sessionId) === escalation) stopEscalations.delete(sessionId);
      });
    stopEscalations.set(sessionId, escalation);
  }

  async function terminateRuntimeAfterProcessStartedFailure(session: AiRuntimeSession, handle: AiRuntimeProcessHandle, completion: Promise<void>, error: unknown): Promise<void> {
    const alreadyFinalized = handles.get(session.id) !== handle;
    try {
      appendLog(session.id, 'system', error instanceof Error ? error.message : String(error));
    } catch (logError) {
      runtimeLifecycleErrors.push(logError);
    }

    if (alreadyFinalized) {
      // close 可能在异步持久化期间先完成；此时补写 failed，不能再向已退出且可能复用的 PID 发信号。
      if (!closing && !closed) {
        try {
          options.onSessionChange?.(session);
        } catch (persistenceError) {
          runtimeLifecycleErrors.push(persistenceError);
        }
      }
      return;
    }

    try {
      // PID 未持久化成功时不能允许进程继续运行；POSIX 路径会优先终止整个进程组。
      signalRuntimeHandle(handle, 'SIGKILL');
    } catch (signalError) {
      runtimeLifecycleErrors.push(signalError);
    }
    try {
      const [processTreeExited, closeCompleted] = await Promise.all([waitForRuntimeProcessTrees([handle], 5_000), waitForRuntimeCompletions([completion], 5_000)]);
      if (processTreeExited && !closeCompleted && handles.get(session.id) === handle) {
        // 极端 adapter 没有发布 close 时，以已确认消失的进程树作为终态屏障，仍由统一 finalizer 清理 handle。
        await scheduleRuntimeSessionCloseFinalization(session.id, handle, null);
      }
      if (!processTreeExited && !closeCompleted) {
        // 不删除 handle；manager close/后续 close 仍可继续收口，避免把存活进程变成不可追踪后台任务。
        session.status = 'orphan_detected';
        session.endedAt = undefined;
        try {
          options.onSessionChange?.(session);
        } catch (persistenceError) {
          runtimeLifecycleErrors.push(persistenceError);
        }
        scheduleOrphanRuntimeFinalization(session.id, handle);
        runtimeLifecycleErrors.push(new Error(`AI Runtime 进程 ${handle.pid ?? session.id} 在 PID 持久化失败并发送 SIGKILL 后仍未确认退出。`));
      }
    } catch (finalizationError) {
      // 清理错误另行汇总；startSession 必须把 PID 持久化的原始错误交还调用方。
      runtimeLifecycleErrors.push(finalizationError);
    }
  }

  function scheduleOrphanRuntimeFinalization(sessionId: string, handle: AiRuntimeProcessHandle): void {
    if (orphanFinalizers.has(sessionId)) return;
    const finalizer = (async () => {
      if (!(await waitForRuntimeProcessTrees([handle], 5_000))) {
        runtimeLifecycleErrors.push(new Error(`AI Runtime 孤儿进程组 ${handle.pid ?? sessionId} 在 SIGKILL 后仍存活。`));
        return;
      }
      if (closed || handles.get(sessionId) !== handle) return;
      const current = sessions.get(sessionId);
      if (current) {
        current.status = processStartedFailureSessions.has(sessionId) ? 'failed' : stopRequestedSessions.has(sessionId) ? 'stopped' : 'failed';
        current.endedAt = now();
        try {
          appendLog(sessionId, 'system', 'AI Runtime 孤儿进程组已确认终止。');
        } catch (error) {
          runtimeLifecycleErrors.push(error);
        }
        try {
          options.onSessionChange?.(current);
        } catch (error) {
          runtimeLifecycleErrors.push(error);
        }
      }
      handles.delete(sessionId);
      stopRequestedSessions.delete(sessionId);
      redactedValues.delete(sessionId);
      completionResolvers.get(sessionId)?.();
      completionResolvers.delete(sessionId);
      completionPromises.delete(sessionId);
      processStartedFailureSessions.delete(sessionId);
    })().finally(() => orphanFinalizers.delete(sessionId));
    orphanFinalizers.set(sessionId, finalizer);
  }

  return {
    async startSession(input) {
      if (closing || closed) throw new Error('AI Runtime 正在关闭，不能启动新会话。');
      assertCwdInsideAllowedRoots(input.cwd, resolveAllowedRoots());
      pruneCompletedRuntimeSessions();
      const session: AiRuntimeSession = {
        id: `ai-session-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        projectId: input.projectId,
        taskId: input.taskId,
        command: input.command,
        args: input.args ?? [],
        cwd: input.cwd,
        status: 'running',
        startedAt: now(),
      };
      const processIdentityToken = randomUUID();
      sessions.set(session.id, session);
      const completion = new Promise<void>((resolveCompletion) => {
        completionResolvers.set(session.id, resolveCompletion);
      });
      completionPromises.set(session.id, completion);
      const processStarted = new Promise<void>((resolveProcessStarted) => {
        processStartedResolvers.set(session.id, resolveProcessStarted);
      });
      pendingProcessStarted.set(session.id, processStarted);
      redactedValues.set(session.id, [...(input.redactValues ?? []).filter((value) => value.length > 0), processIdentityToken]);
      let handle: AiRuntimeProcessHandle;
      try {
        options.onSessionChange?.(session);
        // 先等待身份落盘，再启动进程；持久化失败时不能留下无法安全识别的后台进程。
        await options.onProcessIdentity?.({ sessionId: session.id, token: processIdentityToken });
        if (closing || closed) throw new Error('AI Runtime 正在关闭，不能继续启动新会话。');
        if (stopRequestedSessions.has(session.id)) throw new Error('AI Runtime 会话在 spawn 前已收到停止请求，已取消启动。');
        appendLog(session.id, 'system', `启动 AI Runtime 会话：${[input.command, ...(input.args ?? [])].join(' ')}`);
        handle = spawn(input.command, input.args ?? [], {
          cwd: input.cwd,
          env: {
            ...(input.env ?? process.env),
            [RUNTIME_PROCESS_IDENTITY_ENV]: processIdentityToken,
          },
        });
      } catch (error) {
        session.status = 'failed';
        session.endedAt = now();
        settleProcessStarted(session.id);
        try {
          appendLog(session.id, 'system', error instanceof Error ? error.message : String(error));
        } catch (logError) {
          runtimeLifecycleErrors.push(logError);
        }
        redactedValues.delete(session.id);
        if (!closing && !closed) {
          try {
            options.onSessionChange?.(session);
          } catch (persistenceError) {
            runtimeLifecycleErrors.push(persistenceError);
          }
        }
        completionResolvers.get(session.id)?.();
        completionResolvers.delete(session.id);
        completionPromises.delete(session.id);
        stopRequestedSessions.delete(session.id);
        throw error;
      }
      session.pid = handle.pid;
      handles.set(session.id, handle);
      try {
        handle
          .on('stdout', (value) => appendProcessOutput(session.id, 'stdout', value))
          .on('stderr', (value) => appendProcessOutput(session.id, 'stderr', value))
          .on('error', (value) => {
            if (closed) return;
            const current = sessions.get(session.id);
            if (!current) return;
            current.status = 'failed';
            appendLog(session.id, 'system', value instanceof Error ? value.message : String(value));
          })
          // close 在 stdout/stderr 都关闭后触发，作为日志已排空的终态屏障；exit 可能早于最后一批输出。
          .on('close', (value) => {
            closedProcessHandles.add(handle);
            void scheduleRuntimeSessionCloseFinalization(session.id, handle, value);
          });
        if (options.onProcessStarted) {
          if (typeof handle.pid !== 'number' || !Number.isSafeInteger(handle.pid) || handle.pid <= 0) throw new Error('AI Runtime spawn 后未返回可持久化的进程 PID。');
          await options.onProcessStarted({ sessionId: session.id, pid: handle.pid });
        }
        if (closing || closed) throw new Error('AI Runtime 在进程 PID 持久化期间开始关闭，已取消本次启动。');
        settleProcessStarted(session.id);
        // PID 已持久化后再发布带 PID 的运行态；若进程已在 callback 期间退出，close 已负责发布真实终态。
        if (!closing && !closed && handles.get(session.id) === handle && session.status === 'running') options.onSessionChange?.(session);
      } catch (error) {
        session.status = 'failed';
        processStartedFailureSessions.add(session.id);
        settleProcessStarted(session.id);
        await terminateRuntimeAfterProcessStartedFailure(session, handle, completion, error);
        throw error;
      }
      return session;
    },
    getSession(sessionId) {
      return sessions.get(sessionId);
    },
    listSessions() {
      return [...sessions.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    },
    getLogs(sessionId) {
      return logs.get(sessionId) ?? [];
    },
    inputSession(sessionId, input) {
      const session = requireRuntimeSession(sessions, sessionId);
      const handle = handles.get(sessionId);
      if (!handle?.write) throw new Error('AI Runtime 当前会话不支持输入。');
      handle.write(input);
      appendLog(sessionId, 'system', '已发送输入到 AI Runtime 会话');
      return session;
    },
    interruptSession(sessionId) {
      const session = requireRuntimeSession(sessions, sessionId);
      const handle = handles.get(sessionId);
      if (!handle) throw new Error('AI Runtime session not found');
      signalRuntimeHandle(handle, 'SIGINT');
      appendLog(sessionId, 'system', '已发送 interrupt 到 AI Runtime 会话');
      return session;
    },
    resizeSession(sessionId, cols, rows) {
      const session = requireRuntimeSession(sessions, sessionId);
      const handle = handles.get(sessionId);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) throw new Error('Runtime 终端尺寸无效。');
      if (!handle?.resize) throw new Error('AI Runtime 当前会话不支持 resize。');
      handle.resize(cols, rows);
      appendLog(sessionId, 'system', `已调整 Runtime 终端尺寸：${cols}x${rows}`);
      return session;
    },
    getTerminalSnapshot(sessionId) {
      const session = requireRuntimeSession(sessions, sessionId);
      return {
        sessionId,
        status: session.status,
        command: [session.command, ...session.args].join(' '),
        cwd: session.cwd,
        logs: logs.get(sessionId) ?? [],
        logsTruncated: truncatedLogSessions.has(sessionId),
        capturedAt: now(),
      };
    },
    async waitForSessionCompletion(sessionId, timeoutMs) {
      const completion = completionPromises.get(sessionId);
      if (!completion) return sessions.get(sessionId)?.status !== 'running';
      return waitForRuntimeCompletions([completion], timeoutMs);
    },
    stopSession(sessionId) {
      const session = requireRuntimeSession(sessions, sessionId);
      const handle = handles.get(sessionId);
      if (session.status === 'orphan_detected' && handle) {
        if (stopEscalations.has(sessionId) || orphanFinalizers.has(sessionId)) return session;
        stopRequestedSessions.add(sessionId);
        signalRuntimeHandle(handle, 'SIGKILL');
        scheduleOrphanRuntimeFinalization(sessionId, handle);
        appendLog(sessionId, 'system', '已重新强制终止 AI Runtime 孤儿进程组');
        return session;
      }
      if (session.status === 'running' && !stopRequestedSessions.has(sessionId)) {
        stopRequestedSessions.add(sessionId);
        try {
          if (handle) signalRuntimeHandle(handle, 'SIGTERM');
        } catch (error) {
          stopRequestedSessions.delete(sessionId);
          throw error;
        }
        if (handle) scheduleRuntimeStopEscalation(sessionId, handle);
        appendLog(sessionId, 'system', 'AI Runtime 会话已请求停止');
      }
      return session;
    },
    killSession(sessionId, signal) {
      const session = requireRuntimeSession(sessions, sessionId);
      const handle = handles.get(sessionId);
      if (handle) signalRuntimeHandle(handle, signal);
      appendLog(sessionId, 'system', `已向 AI Runtime 会话发送 ${signal}`);
      if (session.status === 'orphan_detected' && handle && signal === 'SIGKILL') scheduleOrphanRuntimeFinalization(sessionId, handle);
      return session;
    },
    close() {
      closePromise ??= closeRuntimeManager().catch((error) => {
        // 未确认清理完成时保留 manager 与 handle，可由调用方再次 stop/close，不能把失败 close 固化为假成功。
        if (!closed) closePromise = undefined;
        throw error;
      });
      return closePromise;
    },
  };

  async function closeRuntimeManager(): Promise<void> {
    closing = true;
    const pending = [...completionPromises.values(), ...pendingProcessStarted.values(), ...stopEscalations.values()];
    const terminationErrors: unknown[] = runtimeLifecycleErrors.splice(0);
    for (const [sessionId, handle] of handles) {
      stopRequestedSessions.add(sessionId);
      try {
        signalRuntimeHandle(handle, 'SIGTERM');
      } catch (error) {
        terminationErrors.push(error);
      }
    }
    let drained = pending.length === 0 || (await waitForRuntimeCompletions(pending, 5_000));
    if (!drained || handles.size > 0) {
      for (const handle of handles.values()) {
        try {
          signalRuntimeHandle(handle, 'SIGKILL');
        } catch (error) {
          terminationErrors.push(error);
        }
      }
      if (!drained) drained = await waitForRuntimeCompletions(pending, 5_000);
    }
    const confirmedExitedWithoutClose = [...handles.entries()].filter(([sessionId, handle]) => !pendingProcessStarted.has(sessionId) && !runtimeProcessTreeIsAlive(handle));
    await Promise.all(confirmedExitedWithoutClose.map(([sessionId, handle]) => scheduleRuntimeSessionCloseFinalization(sessionId, handle, null)));
    if (!drained) drained = await waitForRuntimeCompletions(pending, 1_000);
    if (!drained || handles.size > 0) {
      // 未确认退出时保持 orphan + handle；调用方必须处理 close 失败，不能继续关闭数据库或制造假终态。
      for (const [sessionId] of handles) {
        const session = sessions.get(sessionId);
        if (session) {
          session.status = 'orphan_detected';
          session.endedAt = undefined;
          try {
            appendLog(sessionId, 'system', 'AI Runtime 强制关闭后仍未确认进程树退出，已保留 handle 等待继续终止。');
          } catch (error) {
            terminationErrors.push(error);
          }
          try {
            options.onSessionChange?.(session);
          } catch (error) {
            terminationErrors.push(error);
          }
        }
      }
      terminationErrors.push(new Error(`AI Runtime 关闭超时，仍保留未确认终止的启动回调或进程 handle；drained=${drained} handles=${handles.size}。`));
      if (terminationErrors.length === 1) throw terminationErrors[0];
      throw new AggregateError(terminationErrors, 'AI Runtime 关闭时存在多个进程终结错误。');
    }
    closed = true;
    terminationErrors.push(...runtimeLifecycleErrors.splice(0));
    if (terminationErrors.length === 1) throw terminationErrors[0];
    if (terminationErrors.length > 1) throw new AggregateError(terminationErrors, 'AI Runtime 关闭时存在多个进程终结错误。');
  }
}

function compactRuntimeLogForMemory(entry: AiRuntimeLogEntry): AiRuntimeLogEntry {
  const encoded = Buffer.from(entry.text);
  if (encoded.byteLength <= MAX_IN_MEMORY_RUNTIME_LOG_BYTES) return entry;
  const marker = '[内存仅保留该超大日志块的末尾，完整内容已写入持久化日志]\n';
  const markerBytes = Buffer.byteLength(marker);
  let suffixStart = encoded.byteLength - (MAX_IN_MEMORY_RUNTIME_LOG_BYTES - markerBytes);
  while (suffixStart < encoded.byteLength && (encoded[suffixStart]! & 0xc0) === 0x80) suffixStart += 1;
  const suffix = encoded.subarray(suffixStart).toString('utf8');
  return { ...entry, text: `${marker}${suffix}` };
}

async function waitForRuntimeCompletions(completions: readonly Promise<void>[], timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all(completions).then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function spawnWithNodeChildProcess(command: string, args: string[], options: AiRuntimeSpawnOptions): AiRuntimeProcessHandle {
  const useProcessGroup = process.platform !== 'win32';
  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    // POSIX 下为每个 Runtime 建立独立进程组，停止/超时时才能连同 shell 的子进程一起终止。
    detached: useProcessGroup,
  });
  return {
    pid: child.pid,
    on(event, callback) {
      if (event === 'stdout') child.stdout?.on('data', callback);
      if (event === 'stderr') child.stderr?.on('data', callback);
      if (event === 'exit') child.on('exit', callback);
      if (event === 'close') child.on('close', callback);
      if (event === 'error') child.on('error', callback);
      return this;
    },
    kill(signal) {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // 进程组可能已退出；回退到直接信号以覆盖 spawn/exit 的竞争窗口。
        }
      }
      child.kill(signal);
    },
  };
}

function assertCwdInsideAllowedRoots(cwd: string, allowedRoots: readonly string[]): void {
  const resolvedCwd = resolve(cwd);
  for (const allowedRoot of allowedRoots) {
    const resolvedRoot = resolve(allowedRoot);
    const relativePath = relative(resolvedRoot, resolvedCwd);
    if (!relativePath.startsWith('..') && relativePath !== '..' && resolve(resolvedCwd) === resolvedCwd) {
      return;
    }
  }
  throw new Error('AI Runtime 工作目录必须位于允许的项目目录内。');
}

function normalizeProcessChunk(value: unknown): string {
  return normalizeTerminalChunk(value);
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu, '[REDACTED SSH PRIVATE KEY]')
    .replace(/\b(authorization)\s*:\s*Bearer\s+[^\s]+/giu, '$1: Bearer [REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(cookie)\s*:\s*[^\n\r]+/giu, '$1: [REDACTED]')
    .replace(/\b([A-Z0-9_.-]*(?:token|api[_-]?key|password|secret)[A-Z0-9_.-]*)\s*[:=]\s*("[^"\n\r]*"|'[^'\n\r]*'|[^\s,;]+)/giu, '$1=[REDACTED]');
}

function redactExactValues(text: string, values: string[]): string {
  let redacted = text;
  for (const value of values) {
    if (!value) continue;
    redacted = redacted.split(value).join('[REDACTED]');
  }
  return redacted;
}

function requireRuntimeSession(sessions: Map<string, AiRuntimeSession>, sessionId: string): AiRuntimeSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`AI Runtime session not found: ${sessionId}`);
  return session;
}
