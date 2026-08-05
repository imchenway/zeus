import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { basename, delimiter, isAbsolute, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { normalizeTerminalChunk } from '@zeus/terminal-core';
import { expandCliSearchPath } from './cliSearchPath.js';

export * from './codexAppServerManager.js';
export * from './codexAppServerProtocol.js';
export * from './codexRuntimeGenerationManager.js';
export * from './agentRuntimeContracts.js';
export * from './agentRuntimeRegistry.js';
export * from './agentCapabilityCatalog.js';
export * from './piRpcProtocol.js';
export { expandCliSearchPath } from './cliSearchPath.js';

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

export interface AiRuntimePromptInput {
  taskTitle: string;
  taskType: 'requirement' | 'defect' | 'optimization';
  taskDescription?: string;
  defectCurrentState?: string;
  defectExpectedOutcome?: string;
  defectReproductionSteps?: string;
  optimizationCurrentState?: string;
  optimizationExpectedOutcome?: string;
  supplementalInfo?: string;
}

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
  const lines = [`任务标题：${input.taskTitle.trim()}`];
  if (input.taskType === 'defect') {
    lines.push('任务类型：缺陷', `现状：${input.defectCurrentState?.trim() || '未提供'}`, `预期：${input.defectExpectedOutcome?.trim() || '未提供'}`, `复现步骤：${input.defectReproductionSteps?.trim() || '未提供'}`);
  } else if (input.taskType === 'optimization') {
    lines.push('任务类型：优化', `现状：${input.optimizationCurrentState?.trim() || '未提供'}`, `预期：${input.optimizationExpectedOutcome?.trim() || '未提供'}`);
  } else {
    lines.push('任务类型：需求', `需求描述：${input.taskDescription?.trim() || '未提供'}`);
  }
  if (input.supplementalInfo?.trim()) lines.push(`补充信息：${input.supplementalInfo.trim()}`);
  return lines.join('\n');
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
  on(event: 'stdout' | 'stderr' | 'exit' | 'error', callback: (value: unknown) => void): AiRuntimeProcessHandle;
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
        if (event === 'exit') child.onExit((exit) => callback(typeof exit.exitCode === 'number' ? exit.exitCode : null));
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
  stopSession(sessionId: string): AiRuntimeSession;
  killSession(sessionId: string, signal: NodeJS.Signals): AiRuntimeSession;
}

export interface CreateAiRuntimeSessionManagerOptions {
  allowedRoot: string;
  allowedRoots?: readonly string[] | (() => readonly string[]);
  spawn?: AiRuntimeSpawn;
  now?: () => string;
  onSessionChange?: (session: AiRuntimeSession) => void;
  onLog?: (log: AiRuntimeLogEntry) => void;
}

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
    child.on('exit', (code) => {
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
  const handles = new Map<string, AiRuntimeProcessHandle>();
  const redactedValues = new Map<string, string[]>();
  const spawn = options.spawn ?? spawnWithNodeChildProcess;
  const now = options.now ?? (() => new Date().toISOString());

  function resolveAllowedRoots(): readonly string[] {
    const dynamicAllowedRoots = typeof options.allowedRoots === 'function' ? options.allowedRoots() : (options.allowedRoots ?? []);
    return [options.allowedRoot, ...dynamicAllowedRoots];
  }

  function appendLog(sessionId: string, stream: AiRuntimeLogStream, text: string): void {
    const entries = logs.get(sessionId) ?? [];
    const exactValues = redactedValues.get(sessionId) ?? [];
    const entry = {
      id: `${sessionId}-log-${entries.length + 1}`,
      sessionId,
      stream,
      text: redactExactValues(redactSensitiveText(text), exactValues),
      createdAt: now(),
    };
    entries.push(entry);
    logs.set(sessionId, entries);
    options.onLog?.(entry);
  }

  function appendProcessOutput(sessionId: string, stream: 'stdout' | 'stderr', value: unknown): void {
    const text = normalizeProcessChunk(value);
    appendLog(sessionId, stream, text);
    const parsed = parseAiRuntimeOutputState(text);
    if (parsed.state !== 'running') {
      // 解析只提供状态提示，不能替代真实 CLI 输出或任务结论。
      appendLog(sessionId, 'system', `AI Runtime 输出状态：${parsed.state} · ${parsed.reason}`);
    }
  }

  return {
    async startSession(input) {
      assertCwdInsideAllowedRoots(input.cwd, resolveAllowedRoots());
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
      sessions.set(session.id, session);
      redactedValues.set(
        session.id,
        (input.redactValues ?? []).filter((value) => value.length > 0),
      );
      options.onSessionChange?.(session);
      appendLog(session.id, 'system', `启动 AI Runtime 会话：${[input.command, ...(input.args ?? [])].join(' ')}`);
      const handle = spawn(input.command, input.args ?? [], {
        cwd: input.cwd,
        env: input.env,
      });
      session.pid = handle.pid;
      handles.set(session.id, handle);
      // 子进程 PID 只有 spawn 后才可得，需再次通知持久化层，保证重启恢复能基于真实 PID 判断 orphan/lost。
      options.onSessionChange?.(session);
      handle
        .on('stdout', (value) => appendProcessOutput(session.id, 'stdout', value))
        .on('stderr', (value) => appendProcessOutput(session.id, 'stderr', value))
        .on('error', (value) => {
          const current = sessions.get(session.id);
          if (!current) return;
          current.status = 'failed';
          current.endedAt = now();
          appendLog(session.id, 'system', value instanceof Error ? value.message : String(value));
          handles.delete(session.id);
          redactedValues.delete(session.id);
          options.onSessionChange?.(current);
        })
        .on('exit', (value) => {
          const current = sessions.get(session.id);
          if (!current) return;
          if (current.status === 'running') current.status = 'exited';
          current.exitCode = typeof value === 'number' ? value : null;
          current.endedAt = now();
          appendLog(session.id, 'system', `AI Runtime 会话已退出：${current.exitCode ?? 'unknown'}`);
          handles.delete(session.id);
          redactedValues.delete(session.id);
          options.onSessionChange?.(current);
        });
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
      handle.kill('SIGINT');
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
        capturedAt: now(),
      };
    },
    stopSession(sessionId) {
      const session = requireRuntimeSession(sessions, sessionId);
      const handle = handles.get(sessionId);
      if (session.status === 'running') {
        handle?.kill('SIGTERM');
        session.status = 'stopped';
        session.endedAt = now();
        options.onSessionChange?.(session);
        appendLog(sessionId, 'system', 'AI Runtime 会话已请求停止');
      }
      return session;
    },
    killSession(sessionId, signal) {
      const session = requireRuntimeSession(sessions, sessionId);
      handles.get(sessionId)?.kill(signal);
      appendLog(sessionId, 'system', `已向 AI Runtime 会话发送 ${signal}`);
      return session;
    },
  };
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
