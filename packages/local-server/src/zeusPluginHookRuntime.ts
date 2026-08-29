import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { PluginHookTrustRecord } from '@zeus/storage';
import type { PluginActivationSnapshot } from './zeusPluginService.js';

export type ZeusPluginHookEventName = 'PermissionRequest' | 'PostToolUse' | 'PostCompact' | 'PreCompact' | 'PreToolUse' | 'SessionEnd' | 'SessionStart' | 'SubagentStart' | 'SubagentStop' | 'UserPromptSubmit' | 'Stop';

export interface ZeusPluginHookEvent {
  event: ZeusPluginHookEventName;
  conversationId: string;
  cwd: string;
  model: string;
  turnId?: string | null;
  transcriptPath?: string | null;
  permissionMode?: string;
  payload?: Record<string, unknown>;
}

export interface ZeusPluginHookRunResult {
  pluginId: string;
  pluginRevisionId: string;
  hookId: string;
  event: ZeusPluginHookEventName;
  state: 'completed' | 'skipped_untrusted' | 'skipped_disabled' | 'skipped_unsupported' | 'background_started' | 'failed' | 'timed_out';
  exitCode: number | null;
  output: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  outputPath: string | null;
  trustedBypass: boolean;
  error: string | null;
}

export interface ZeusPluginHookEventResult {
  event: ZeusPluginHookEventName;
  runs: ZeusPluginHookRunResult[];
  permissionDecision: 'allow' | 'deny' | null;
  permissionDecisionReason: string | null;
  updatedInput: Record<string, unknown> | null;
  additionalContext: string[];
  systemMessages: string[];
  continue: boolean;
  stopReasons: string[];
  continuationPrompts: string[];
  replaceToolResult: string | null;
}

export interface ZeusPluginHookRuntime {
  emit(event: ZeusPluginHookEvent): Promise<ZeusPluginHookEventResult>;
  closeConversation(conversationId: string): Promise<void>;
  close(): Promise<void>;
}

export function createZeusPluginHookRuntime(options: {
  runtimeRoot: string;
  dataRoot: string;
  getActivations(conversationId: string): Promise<PluginActivationSnapshot[]>;
  executeMcpTool?(input: { conversationId: string; pluginId: string; serverId: string; toolName: string; args: Record<string, unknown>; signal: AbortSignal }): Promise<unknown>;
  dangerouslyBypassTrust?: boolean;
  publish?: (type: string, payload: Record<string, unknown>) => void;
}): ZeusPluginHookRuntime {
  if (!isAbsolute(options.runtimeRoot) || !isAbsolute(options.dataRoot)) throw new Error('Plugin Hook runtimeRoot/dataRoot 必须是绝对路径。');
  const backgroundByConversation = new Map<string, Set<BackgroundRun>>();
  const backgroundOutputByConversation = new Map<string, ZeusPluginHookRunResult[]>();

  async function emit(event: ZeusPluginHookEvent): Promise<ZeusPluginHookEventResult> {
    validateEvent(event);
    const activations = await options.getActivations(event.conversationId);
    const pending = backgroundOutputByConversation.get(event.conversationId)?.splice(0) ?? [];
    const candidates = matchingHookCandidates(activations, event);
    const foreground: Array<Promise<ZeusPluginHookRunResult>> = [];
    const immediate: ZeusPluginHookRunResult[] = [...pending];
    for (const candidate of candidates) {
      if (!candidate.trust.enabled) {
        immediate.push(skippedRun(candidate, event.event, 'skipped_disabled', false));
        continue;
      }
      const trusted = candidate.trust.trustedDefinitionSha256 === candidate.hook.definitionSha256;
      if (!trusted && !options.dangerouslyBypassTrust) {
        immediate.push(skippedRun(candidate, event.event, 'skipped_untrusted', false));
        continue;
      }
      const handler = hookHandler(candidate.hook.definition);
      if (handler.type === 'prompt' || handler.type === 'agent') {
        immediate.push(skippedRun(candidate, event.event, 'skipped_unsupported', !trusted));
        continue;
      }
      if (handler.type === 'command' && handler.async === true && event.event !== 'SessionEnd') {
        const activeBackgroundCount = backgroundByConversation.get(event.conversationId)?.size ?? 0;
        if (activeBackgroundCount >= 8) {
          immediate.push({
            ...skippedRun(candidate, event.event, 'failed', !trusted),
            error: '当前会话已有 8 个异步 Hook 正在运行。',
          });
          continue;
        }
        immediate.push(scheduleBackground(candidate, event, !trusted));
        continue;
      }
      foreground.push(executeCandidate(candidate, event, !trusted));
    }
    const runs = [...immediate, ...(await Promise.all(foreground))];
    const result = aggregateHookResults(event.event, runs);
    options.publish?.('plugin.hook.completed', {
      conversationId: event.conversationId,
      event: event.event,
      runCount: runs.length,
      failedCount: runs.filter((run) => run.state === 'failed' || run.state === 'timed_out').length,
      denied: result.permissionDecision === 'deny',
    });
    return result;
  }

  function scheduleBackground(candidate: HookCandidate, event: ZeusPluginHookEvent, trustedBypass: boolean): ZeusPluginHookRunResult {
    const controller = new AbortController();
    const run: BackgroundRun = { controller, promise: Promise.resolve(null as unknown as ZeusPluginHookRunResult) };
    const set = backgroundByConversation.get(event.conversationId) ?? new Set<BackgroundRun>();
    backgroundByConversation.set(event.conversationId, set);
    set.add(run);
    run.promise = executeCandidate(candidate, event, trustedBypass, controller.signal)
      .then((result) => {
        const informational = sanitizeBackgroundResult(result);
        const outputs = backgroundOutputByConversation.get(event.conversationId) ?? [];
        outputs.push(informational);
        backgroundOutputByConversation.set(event.conversationId, outputs);
        return informational;
      })
      .finally(() => {
        set.delete(run);
        if (set.size === 0) backgroundByConversation.delete(event.conversationId);
      });
    return {
      ...skippedRun(candidate, event.event, 'background_started', trustedBypass),
      error: null,
    };
  }

  async function executeCandidate(candidate: HookCandidate, event: ZeusPluginHookEvent, trustedBypass: boolean, externalSignal?: AbortSignal): Promise<ZeusPluginHookRunResult> {
    const handler = hookHandler(candidate.hook.definition);
    const timeoutSeconds = hookTimeout(handler, event.event);
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutSeconds * 1_000);
    timer.unref?.();
    try {
      const input = hookInput(event);
      if (handler.type === 'command') {
        return await executeCommandHook({ candidate, event, handler, input, signal: controller.signal, trustedBypass });
      }
      if (handler.type === 'mcp_tool') {
        return await executeMcpHook({ candidate, event, handler, input, signal: controller.signal, trustedBypass });
      }
      return skippedRun(candidate, event.event, 'skipped_unsupported', trustedBypass);
    } catch (error) {
      const timedOut = controller.signal.aborted && !externalSignal?.aborted;
      return {
        pluginId: candidate.activation.pluginId,
        pluginRevisionId: candidate.activation.pluginRevisionId,
        hookId: candidate.hook.id,
        event: event.event,
        state: timedOut ? 'timed_out' : 'failed',
        exitCode: null,
        output: null,
        stdout: '',
        stderr: '',
        outputPath: null,
        trustedBypass,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  async function executeCommandHook(input: {
    candidate: HookCandidate;
    event: ZeusPluginHookEvent;
    handler: Record<string, unknown> & { type: 'command'; command: string };
    input: Record<string, unknown>;
    signal: AbortSignal;
    trustedBypass: boolean;
  }): Promise<ZeusPluginHookRunResult> {
    await mkdir(join(options.dataRoot, input.candidate.activation.pluginId), { recursive: true, mode: 0o700 });
    const child = spawn('/bin/zsh', ['-lc', input.handler.command], {
      cwd: input.event.cwd,
      env: {
        ...process.env,
        PLUGIN_ROOT: input.candidate.activation.installPath,
        PLUGIN_DATA: join(options.dataRoot, input.candidate.activation.pluginId),
        CLAUDE_PLUGIN_ROOT: input.candidate.activation.installPath,
        CLAUDE_PLUGIN_DATA: join(options.dataRoot, input.candidate.activation.pluginId),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    const abort = () => terminateChild(child);
    input.signal.addEventListener('abort', abort, { once: true });
    const output = collectChildOutput(child);
    child.stdin.end(JSON.stringify(input.input));
    try {
      const { exitCode, stdout, stderr } = await output;
      if (input.signal.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error('Hook 已取消。');
      return finishHookOutput({ candidate: input.candidate, event: input.event.event, exitCode, stdout, stderr, trustedBypass: input.trustedBypass });
    } finally {
      input.signal.removeEventListener('abort', abort);
    }
  }

  async function executeMcpHook(input: {
    candidate: HookCandidate;
    event: ZeusPluginHookEvent;
    handler: Record<string, unknown> & { type: 'mcp_tool'; server: string; tool: string; input?: Record<string, unknown> };
    input: Record<string, unknown>;
    signal: AbortSignal;
    trustedBypass: boolean;
  }): Promise<ZeusPluginHookRunResult> {
    if (!options.executeMcpTool) throw new Error('Plugin MCP Broker 尚未启用。');
    const args = expandHookTemplates(input.handler.input ?? {}, input.input);
    const result = await options.executeMcpTool({
      conversationId: input.event.conversationId,
      pluginId: input.candidate.activation.pluginId,
      serverId: input.handler.server,
      toolName: input.handler.tool,
      args,
      signal: input.signal,
    });
    const stdout = typeof result === 'string' ? result : JSON.stringify(result);
    return finishHookOutput({ candidate: input.candidate, event: input.event.event, exitCode: 0, stdout, stderr: '', trustedBypass: input.trustedBypass });
  }

  async function finishHookOutput(input: { candidate: HookCandidate; event: ZeusPluginHookEventName; exitCode: number; stdout: string; stderr: string; trustedBypass: boolean }): Promise<ZeusPluginHookRunResult> {
    const spilled = await spillLargeOutput(input.candidate.activation, input.stdout, input.stderr);
    let output: Record<string, unknown> | null = null;
    const trimmed = input.stdout.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!isRecord(parsed)) throw new Error('Hook 输出必须是对象。');
        output = parsed;
      } catch (error) {
        return {
          pluginId: input.candidate.activation.pluginId,
          pluginRevisionId: input.candidate.activation.pluginRevisionId,
          hookId: input.candidate.hook.id,
          event: input.event,
          state: 'failed',
          exitCode: input.exitCode,
          output: null,
          stdout: spilled.stdout,
          stderr: spilled.stderr,
          outputPath: spilled.outputPath,
          trustedBypass: input.trustedBypass,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const outputError = validateHookOutput(input.event, input.exitCode, trimmed, output);
    if (outputError) {
      return {
        pluginId: input.candidate.activation.pluginId,
        pluginRevisionId: input.candidate.activation.pluginRevisionId,
        hookId: input.candidate.hook.id,
        event: input.event,
        state: 'failed',
        exitCode: input.exitCode,
        output,
        stdout: spilled.stdout,
        stderr: spilled.stderr,
        outputPath: spilled.outputPath,
        trustedBypass: input.trustedBypass,
        error: outputError,
      };
    }
    return {
      pluginId: input.candidate.activation.pluginId,
      pluginRevisionId: input.candidate.activation.pluginRevisionId,
      hookId: input.candidate.hook.id,
      event: input.event,
      state: input.exitCode === 0 || input.exitCode === 2 ? 'completed' : 'failed',
      exitCode: input.exitCode,
      output,
      stdout: spilled.stdout,
      stderr: spilled.stderr,
      outputPath: spilled.outputPath,
      trustedBypass: input.trustedBypass,
      error: input.exitCode === 0 || input.exitCode === 2 ? null : `Hook 进程退出码 ${input.exitCode}。`,
    };
  }

  async function spillLargeOutput(activation: PluginActivationSnapshot, stdout: string, stderr: string): Promise<{ stdout: string; stderr: string; outputPath: string | null }> {
    const combinedBytes = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');
    if (combinedBytes <= 256 * 1024) return { stdout, stderr, outputPath: null };
    const directory = join(options.runtimeRoot, 'hook_outputs', safePathSegment(activation.pluginId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const outputPath = join(directory, `${randomUUID()}.txt`);
    await writeFile(outputPath, `STDOUT\n${stdout}\nSTDERR\n${stderr}`, { mode: 0o600, flag: 'wx' });
    return { stdout: preview(stdout), stderr: preview(stderr), outputPath };
  }

  async function closeConversation(conversationId: string): Promise<void> {
    const runs = backgroundByConversation.get(conversationId);
    if (!runs) return;
    for (const run of runs) run.controller.abort(new Error('会话已结束。'));
    await Promise.allSettled([...runs].map((run) => run.promise));
    backgroundByConversation.delete(conversationId);
    backgroundOutputByConversation.delete(conversationId);
  }

  async function close(): Promise<void> {
    await Promise.all([...backgroundByConversation.keys()].map(closeConversation));
  }

  return { emit, closeConversation, close };
}

interface HookCandidate {
  activation: PluginActivationSnapshot;
  hook: PluginActivationSnapshot['components']['hooks'][number];
  trust: PluginHookTrustRecord;
}

interface BackgroundRun {
  controller: AbortController;
  promise: Promise<ZeusPluginHookRunResult>;
}

function matchingHookCandidates(activations: PluginActivationSnapshot[], event: ZeusPluginHookEvent): HookCandidate[] {
  const result: HookCandidate[] = [];
  for (const activation of activations) {
    for (const hook of activation.components.hooks) {
      if (hook.event !== event.event || !matcherMatches(event, hook.matcher)) continue;
      const trust = activation.hooks.find((candidate) => candidate.hookId === hook.id && candidate.definitionSha256 === hook.definitionSha256);
      if (!trust) continue;
      result.push({ activation, hook, trust });
    }
  }
  return result;
}

function matcherMatches(event: ZeusPluginHookEvent, matcher: string | null): boolean {
  if (!matcher || matcher === '*' || event.event === 'UserPromptSubmit' || event.event === 'Stop') return true;
  const payload = event.payload ?? {};
  const value =
    event.event === 'PreToolUse' || event.event === 'PostToolUse' || event.event === 'PermissionRequest'
      ? payload.tool_name
      : event.event === 'PreCompact' || event.event === 'PostCompact'
        ? payload.trigger
        : event.event === 'SessionStart'
          ? payload.source
          : event.event === 'SessionEnd'
            ? payload.reason
            : event.event === 'SubagentStart' || event.event === 'SubagentStop'
              ? payload.agent_type
              : '';
  return typeof value === 'string' && new RegExp(matcher).test(value);
}

function hookInput(event: ZeusPluginHookEvent): Record<string, unknown> {
  return {
    session_id: event.conversationId,
    transcript_path: event.transcriptPath ?? null,
    cwd: event.cwd,
    hook_event_name: event.event,
    model: event.model,
    ...(event.turnId ? { turn_id: event.turnId } : {}),
    ...(event.permissionMode ? { permission_mode: event.permissionMode } : {}),
    ...(event.payload ?? {}),
  };
}

function aggregateHookResults(event: ZeusPluginHookEventName, runs: ZeusPluginHookRunResult[]): ZeusPluginHookEventResult {
  let permissionDecision: 'allow' | 'deny' | null = null;
  let permissionDecisionReason: string | null = null;
  let updatedInput: Record<string, unknown> | null = null;
  let shouldContinue = true;
  let replaceToolResult: string | null = null;
  const additionalContext: string[] = [];
  const systemMessages: string[] = [];
  const stopReasons: string[] = [];
  const continuationPrompts: string[] = [];
  for (const run of runs) {
    if (run.state !== 'completed') continue;
    const output = run.output;
    const stderrBlock = run.exitCode === 2 ? run.stderr.trim() || 'Hook 已阻断操作。' : null;
    if (stderrBlock) applyBlock(event, stderrBlock);
    if (!output) {
      if ((event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'SubagentStart') && run.stdout.trim()) additionalContext.push(run.stdout.trim());
      continue;
    }
    if (event === 'SessionEnd') continue;
    if (typeof output.systemMessage === 'string' && output.systemMessage.trim()) systemMessages.push(output.systemMessage.trim());
    const specific = isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput : null;
    if (specific && typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) additionalContext.push(specific.additionalContext.trim());
    if (event === 'PreToolUse') {
      const decision = specific?.permissionDecision;
      if (decision === 'deny') applyPermission('deny', typeof specific?.permissionDecisionReason === 'string' ? specific.permissionDecisionReason : 'Plugin Hook 已阻断工具。');
      else if (decision === 'allow') {
        applyPermission('allow', null);
        if (isRecord(specific?.updatedInput)) updatedInput = specific.updatedInput;
      } else if (output.decision === 'block') applyPermission('deny', typeof output.reason === 'string' ? output.reason : 'Plugin Hook 已阻断工具。');
    } else if (event === 'PermissionRequest') {
      const decision = isRecord(specific?.decision) ? specific.decision : null;
      if (decision?.behavior === 'deny') applyPermission('deny', typeof decision.message === 'string' ? decision.message : 'Plugin Hook 拒绝审批。');
      else if (decision?.behavior === 'allow') applyPermission('allow', null);
    } else if (event === 'PostToolUse' && (output.decision === 'block' || output.continue === false)) {
      const reason = typeof output.reason === 'string' ? output.reason : typeof output.stopReason === 'string' ? output.stopReason : 'Plugin Hook 替换了工具结果。';
      replaceToolResult = reason;
      if (output.continue === false) shouldContinue = false;
    } else if ((event === 'UserPromptSubmit' || event === 'PreCompact' || event === 'PostCompact') && (output.decision === 'block' || output.continue === false)) {
      shouldContinue = false;
      const reason = typeof output.reason === 'string' ? output.reason : typeof output.stopReason === 'string' ? output.stopReason : 'Plugin Hook 已停止本次操作。';
      stopReasons.push(reason);
    } else if (event === 'Stop' || event === 'SubagentStop') {
      if (output.continue === false) {
        shouldContinue = false;
        if (typeof output.stopReason === 'string') stopReasons.push(output.stopReason);
      } else if (output.decision === 'block' && typeof output.reason === 'string') continuationPrompts.push(output.reason);
    } else if (output.continue === false && event !== 'SubagentStart') {
      shouldContinue = false;
      if (typeof output.stopReason === 'string') stopReasons.push(output.stopReason);
    }
  }
  return { event, runs, permissionDecision, permissionDecisionReason, updatedInput, additionalContext, systemMessages, continue: shouldContinue, stopReasons, continuationPrompts, replaceToolResult };

  function applyBlock(blockEvent: ZeusPluginHookEventName, reason: string): void {
    if (blockEvent === 'PreToolUse' || blockEvent === 'PermissionRequest') applyPermission('deny', reason);
    else if (blockEvent === 'PostToolUse') replaceToolResult = reason;
    else if (blockEvent === 'Stop' || blockEvent === 'SubagentStop') continuationPrompts.push(reason);
    else {
      shouldContinue = false;
      stopReasons.push(reason);
    }
  }

  function applyPermission(decision: 'allow' | 'deny', reason: string | null): void {
    if (permissionDecision === 'deny') return;
    permissionDecision = decision;
    if (decision === 'deny') permissionDecisionReason = reason;
  }
}

function validateHookOutput(event: ZeusPluginHookEventName, exitCode: number, stdout: string, output: Record<string, unknown> | null): string | null {
  if ((event === 'Stop' || event === 'SubagentStop') && exitCode === 0 && stdout && !output) return `${event} Hook 退出码为 0 时必须输出 JSON 对象。`;
  if (!output) return null;
  const specific = isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput : null;
  if (specific && typeof specific.hookEventName === 'string' && specific.hookEventName !== event) return `Hook 输出事件 ${specific.hookEventName} 与当前事件 ${event} 不一致。`;
  if (Object.prototype.hasOwnProperty.call(output, 'suppressOutput')) return `${event} Hook 的 suppressOutput 尚未受支持。`;
  if (event === 'PreToolUse') {
    if (specific?.permissionDecision === 'ask' || output.decision === 'approve' || output.continue === false || Object.prototype.hasOwnProperty.call(output, 'stopReason')) {
      return 'PreToolUse Hook 返回了 Codex 当前仅解析但不支持的控制字段。';
    }
    if (Object.prototype.hasOwnProperty.call(specific ?? {}, 'updatedInput') && specific?.permissionDecision !== 'allow') return 'PreToolUse updatedInput 只能与 permissionDecision=allow 一起返回。';
  }
  if (event === 'PermissionRequest' && ['updatedInput', 'updatedPermissions', 'interrupt'].some((key) => Object.prototype.hasOwnProperty.call(specific ?? {}, key))) {
    return 'PermissionRequest Hook 返回了保留字段，Zeus 已拒绝采用该决策。';
  }
  if (event === 'PostToolUse' && Object.prototype.hasOwnProperty.call(output, 'updatedMCPToolOutput')) return 'PostToolUse Hook 的 updatedMCPToolOutput 尚未受支持。';
  return null;
}

function hookHandler(
  definition: Record<string, unknown>,
): Record<string, unknown> & ({ type: 'command'; command: string; async?: boolean } | { type: 'mcp_tool'; server: string; tool: string; input?: Record<string, unknown> } | { type: 'prompt' | 'agent' }) {
  if (!isRecord(definition.handler) || typeof definition.handler.type !== 'string') throw new Error('Plugin Hook 定义损坏。');
  return definition.handler as ReturnType<typeof hookHandler>;
}

function hookTimeout(handler: Record<string, unknown>, event: ZeusPluginHookEventName): number {
  if (typeof handler.timeout === 'number' && Number.isFinite(handler.timeout) && handler.timeout > 0) return event === 'SessionEnd' ? Math.min(3, handler.timeout) : Math.min(600, handler.timeout);
  return event === 'SessionEnd' ? 1 : 600;
}

function collectChildOutput(child: ChildProcessWithoutNullStreams): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveOutput, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        terminateChild(child);
        reject(new Error('Plugin Hook 输出超过 8 MiB。'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', (code) => resolveOutput({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
  timer.unref?.();
}

function expandHookTemplates(value: Record<string, unknown>, event: Record<string, unknown>): Record<string, unknown> {
  return expandValue(value, event) as Record<string, unknown>;
}

function expandValue(value: unknown, event: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => expandValue(entry, event));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandValue(entry, event)]));
  if (typeof value !== 'string') return value;
  const exact = /^\$\{([a-zA-Z0-9_.]+)\}$/u.exec(value);
  if (exact) return readDotted(event, exact[1]!);
  return value.replaceAll(/\$\{([a-zA-Z0-9_.]+)\}/gu, (_match, path: string) => stringifyTemplateValue(readDotted(event, path)));
}

function readDotted(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  return current ?? null;
}

function stringifyTemplateValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function skippedRun(candidate: HookCandidate, event: ZeusPluginHookEventName, state: ZeusPluginHookRunResult['state'], trustedBypass: boolean): ZeusPluginHookRunResult {
  return {
    pluginId: candidate.activation.pluginId,
    pluginRevisionId: candidate.activation.pluginRevisionId,
    hookId: candidate.hook.id,
    event,
    state,
    exitCode: null,
    output: null,
    stdout: '',
    stderr: '',
    outputPath: null,
    trustedBypass,
    error: null,
  };
}

function sanitizeBackgroundResult(result: ZeusPluginHookRunResult): ZeusPluginHookRunResult {
  if (!result.output) return result;
  const output = { ...result.output };
  delete output.decision;
  delete output.continue;
  delete output.stopReason;
  if (isRecord(output.hookSpecificOutput)) {
    const specific = { ...output.hookSpecificOutput };
    delete specific.permissionDecision;
    delete specific.permissionDecisionReason;
    delete specific.updatedInput;
    delete specific.decision;
    output.hookSpecificOutput = specific;
  }
  return { ...result, output };
}

function validateEvent(event: ZeusPluginHookEvent): void {
  if (!event.conversationId.trim() || !isAbsolute(event.cwd) || !event.model.trim()) throw new Error('Plugin Hook 事件缺少稳定会话、cwd 或模型身份。');
}

function safePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new Error('Plugin Hook 路径身份无效。');
  return value;
}

function preview(value: string): string {
  if (value.length <= 32_000) return value;
  return `${value.slice(0, 16_000)}\n…[完整 Hook 输出已写入受管临时文件]…\n${value.slice(-16_000)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
