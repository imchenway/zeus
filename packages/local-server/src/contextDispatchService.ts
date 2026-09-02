import type { AgentPreflightTokenCountCapability, AgentPreflightTokenCountResult } from '@zeus/ai-runtime';
import type { CodexBootstrapAdditionalContext } from '@zeus/shared';
import { LongTermMemoryRepository, type LongTermMemoryResolution } from '@zeus/storage';
import {
  compileContext,
  defaultContextTokenCounter,
  longTermMemoryContextFragment,
  renderCompiledContext,
  type CompiledContext,
  type CompileContextInput,
  type ContextBudget,
  type ContextFragment,
  type ContextOperationRisk,
  type ContextTokenCounter,
} from './contextCompiler.js';
import { ContextSourceCatalog, type ProjectTaskDocumentCandidate } from './contextSourceCatalog.js';

export const contextDispatchSchemaVersion = 'zeus-context-dispatch-v1' as const;

export interface ContextDispatchProject {
  id: string;
  localPath: string;
}

export interface ContextDispatchTask {
  id: string;
  code: string;
}

export interface ContextDispatchProviderSnapshot {
  id: string;
  modelId: string;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  currentInputTokens: number;
  capabilities?: CompileContextInput['provider']['capabilities'];
  /** 只有真实、同步、本地 tokenizer 才能传 exact；当前 Codex/Pi 均不提供。 */
  tokenCounter?: ContextTokenCounter;
  preflightTokenCount: AgentPreflightTokenCountCapability;
  requestAccounting?: ContextDispatchRequestAccountingInput;
}

export interface ContextDispatchRequestAccountingInput {
  historyBaselineTokens: number;
  historyBaselineSource: string;
  fixedInputTokens: number;
  estimateSafetyMarginTokens: number;
}

export interface ContextDispatchRequestAccounting extends ContextDispatchRequestAccountingInput {
  compilerEnvelopeTokens: number;
  estimatedRequestHeadroomTokens: number;
}

export interface CompileDispatchContextInput {
  project: ContextDispatchProject;
  task?: ContextDispatchTask | null;
  provider: ContextDispatchProviderSnapshot;
  operationRisk: ContextOperationRisk;
  asOf?: string;
  maximumCompiledTokens?: number;
  budgets?: Partial<ContextBudget>;
  minimumMemoryConfidence?: number;
  maximumTaskDocumentBytes?: number;
  /** 只接纳上游已精确选择的非权威片段；本服务不会主动扫描代码、会话或 rollout。 */
  selectedFragments?: ContextFragment[];
  sourceWatermarks?: Readonly<Record<string, string | number | boolean | null>>;
  auditIdentity?: {
    actorType: string;
    actorRef?: string | null;
    conversationId?: string | null;
    submissionId?: string | null;
  };
}

export interface ContextDispatchAuditRecord {
  schemaVersion: typeof contextDispatchSchemaVersion;
  compiledAt: string;
  projectId: string;
  taskId: string | null;
  taskCode: string | null;
  providerId: string;
  modelId: string;
  operationRisk: ContextOperationRisk;
  fingerprint: string;
  usedTokens: number;
  availableTokens: number;
  requestAccounting: ContextDispatchRequestAccounting | null;
  tokenAccounting: CompiledContext['tokenAccounting'];
  preflightTokenCount: AgentPreflightTokenCountCapability;
  watermarks: CompiledContext['watermarks'];
  decisions: CompiledContext['decisions'];
  actorType: string;
  actorRef: string | null;
  conversationId: string | null;
  submissionId: string | null;
}

export interface ContextProviderPreflightAuditRecord {
  schemaVersion: typeof contextDispatchSchemaVersion;
  fingerprint: string;
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  result: AgentPreflightTokenCountResult;
  accepted: boolean;
  remainingTokens: number;
}

export interface ContextDispatchAuditPort {
  /** 必须在 Provider 写入前耐久提交；payload 不包含上下文正文。 */
  recordCompilation(record: ContextDispatchAuditRecord): Promise<void>;
  /** 只有 Adapter 提供真实完整请求计数时调用。 */
  recordProviderPreflight?(record: ContextProviderPreflightAuditRecord): Promise<void>;
}

export interface ContextDispatchApplicationServiceOptions {
  memory: LongTermMemoryRepository;
  now(): Date;
  audit?: ContextDispatchAuditPort;
}

export interface ContextDispatchEnvelope {
  schemaVersion: typeof contextDispatchSchemaVersion;
  compiled: CompiledContext;
  rendered: ReturnType<typeof renderCompiledContext>;
  codexAdditionalContext: CodexBootstrapAdditionalContext;
  provider: {
    id: string;
    modelId: string;
    preflightTokenCount: AgentPreflightTokenCountCapability;
    requestAccounting: ContextDispatchRequestAccounting | null;
  };
  taskDocument: {
    selected: ProjectTaskDocumentCandidate | null;
    candidates: ProjectTaskDocumentCandidate[];
    truncatedDirectory: boolean;
    nextByteOffset: number | null;
  };
  memory: {
    selectedIds: string[];
    reviewRequiredIds: string[];
    exclusions: Array<{ id: string; reason: LongTermMemoryResolution['excluded'][number]['reason'] }>;
  };
}

export interface ProviderDispatchContextCompilerInput {
  provider: 'codex' | 'pi';
  conversationId: string;
  submissionId: string;
  projectId: string;
  projectLocalPath: string;
  taskId: string | null;
  modelId: string;
  modelSourceId: string | null;
  operationRisk: 'read_only' | 'local_write';
  fixedRequestUtf8Bytes: number;
  providerBootstrapUtf8Bytes: number;
  providerHistoryMode: 'latest' | 'bootstrap';
  providerHistoryOverride?: { tokens: number; source: string };
  providerGenerationId: string | null;
}

export type ProviderDispatchContextCompiler = (input: ProviderDispatchContextCompilerInput) => Promise<ContextDispatchEnvelope>;

/**
 * 真实派发的 Context Application Service。
 *
 * 它只读取当前项目 `/docs` 主文档和 Zeus 自己治理的 Memory；代码、已证实历史、运行证据与
 * 冷证据必须由各自 owner 有界选择后显式传入，构造服务和普通派发都不会扫描 rollout/history。
 */
export class ContextDispatchApplicationService {
  constructor(private readonly options: ContextDispatchApplicationServiceOptions) {}

  async preview(input: CompileDispatchContextInput): Promise<ContextDispatchEnvelope> {
    return this.compile(input, false);
  }

  async compileForDispatch(input: CompileDispatchContextInput): Promise<ContextDispatchEnvelope> {
    if (!this.options.audit) throw dispatchError('ZEUS_CONTEXT_AUDIT_UNAVAILABLE', '真实派发必须配置可耐久提交的 Context 审计端口。');
    return this.compile(input, true);
  }

  private async compile(input: CompileDispatchContextInput, persistAudit: boolean): Promise<ContextDispatchEnvelope> {
    const asOf = input.asOf ?? this.options.now().toISOString();
    const project = normalizeProject(input.project);
    const task = normalizeTask(input.task);
    const selectedFragments = normalizeSelectedFragments(input.selectedFragments);
    const memory = this.options.memory.resolveForContext({ projectId: project.id, asOf, minimumConfidence: input.minimumMemoryConfidence });
    const rootId = `project:${project.id}`;
    const catalog = new ContextSourceCatalog([{ id: rootId, path: project.localPath }]);
    const taskDocument = task
      ? await catalog.primaryTaskDocumentFragment({
          rootId,
          projectId: project.id,
          taskId: task.id,
          taskCode: task.code,
          maximumBytes: input.maximumTaskDocumentBytes,
        })
      : { fragment: null, selection: { primary: null, candidates: [], truncatedDirectory: false }, page: null };
    const fragments = [taskDocument.fragment, ...memory.selected.map(longTermMemoryContextFragment), ...selectedFragments].filter((fragment): fragment is ContextFragment => fragment !== null);
    const requestAccountingInput = normalizeRequestAccounting(input.provider.requestAccounting);
    const compile = (currentInputTokens: number) =>
      compileContext({
        asOf,
        operationRisk: input.operationRisk,
        provider: {
          id: input.provider.id,
          contextWindowTokens: input.provider.contextWindowTokens,
          reservedOutputTokens: input.provider.reservedOutputTokens,
          currentInputTokens,
          capabilities: input.provider.capabilities,
        },
        projectId: project.id,
        task: task ? { projectId: project.id, taskId: task.id, taskCode: task.code } : null,
        maximumCompiledTokens: input.maximumCompiledTokens,
        budgets: input.budgets,
        watermarks: {
          ...(input.sourceWatermarks ?? {}),
          'docs.primary': taskDocument.fragment?.sourceVersion ?? (task ? 'missing' : 'not_applicable'),
          'memory.latest': latestMemoryWatermark(memory.selected.map((record) => record.updatedAt)),
          'provider.preflight_token_count': preflightWatermark(input.provider.preflightTokenCount),
        },
        fragments,
        tokenCounter: input.provider.tokenCounter,
      });
    let compiled = compile(input.provider.currentInputTokens);
    let requestAccounting: ContextDispatchRequestAccounting | null = null;
    if (requestAccountingInput) {
      const counter = input.provider.tokenCounter ?? defaultContextTokenCounter;
      const firstRendered = renderCompiledContext(compiled);
      const renderedTokens = counter.count(JSON.stringify(firstRendered));
      const compilerEnvelopeTokens = Math.max(256, renderedTokens - compiled.usedTokens + 256);
      const requestBudgetTokens = input.provider.contextWindowTokens - input.provider.reservedOutputTokens;
      const fixedRequestTokens = requestAccountingInput.historyBaselineTokens + requestAccountingInput.fixedInputTokens + requestAccountingInput.estimateSafetyMarginTokens + compilerEnvelopeTokens;
      const compilerCurrentInputTokens = Math.min(requestBudgetTokens, fixedRequestTokens);
      if (compilerCurrentInputTokens !== input.provider.currentInputTokens) compiled = compile(compilerCurrentInputTokens);
      requestAccounting = {
        ...requestAccountingInput,
        compilerEnvelopeTokens,
        estimatedRequestHeadroomTokens: requestBudgetTokens - fixedRequestTokens - compiled.usedTokens,
      };
    }
    const rendered = renderCompiledContext(compiled, requestAccounting ?? undefined);
    const envelope: ContextDispatchEnvelope = {
      schemaVersion: contextDispatchSchemaVersion,
      compiled,
      rendered,
      codexAdditionalContext: toCodexAdditionalContext(rendered),
      provider: {
        id: input.provider.id,
        modelId: input.provider.modelId,
        preflightTokenCount: { ...input.provider.preflightTokenCount },
        requestAccounting,
      },
      taskDocument: {
        selected: taskDocument.selection.primary,
        candidates: taskDocument.selection.candidates,
        truncatedDirectory: taskDocument.selection.truncatedDirectory,
        nextByteOffset: taskDocument.page?.nextByteOffset ?? null,
      },
      memory: {
        selectedIds: memory.selected.map((record) => record.id),
        reviewRequiredIds: memory.reviewRequired.map((record) => record.id),
        exclusions: memory.excluded.map(({ record, reason }) => ({ id: record.id, reason })),
      },
    };
    if (persistAudit) {
      const identity = input.auditIdentity;
      await this.options.audit!.recordCompilation({
        schemaVersion: contextDispatchSchemaVersion,
        compiledAt: asOf,
        projectId: project.id,
        taskId: task?.id ?? null,
        taskCode: task?.code ?? null,
        providerId: input.provider.id,
        modelId: input.provider.modelId,
        operationRisk: input.operationRisk,
        fingerprint: compiled.fingerprint,
        usedTokens: compiled.usedTokens,
        availableTokens: compiled.availableTokens,
        requestAccounting,
        tokenAccounting: compiled.tokenAccounting,
        preflightTokenCount: { ...input.provider.preflightTokenCount },
        watermarks: compiled.watermarks,
        decisions: compiled.decisions,
        actorType: identity?.actorType ?? 'zeus_context_compiler',
        actorRef: identity?.actorRef ?? null,
        conversationId: identity?.conversationId ?? null,
        submissionId: identity?.submissionId ?? null,
      });
    }
    return envelope;
  }
}

function normalizeRequestAccounting(value: ContextDispatchRequestAccountingInput | undefined): ContextDispatchRequestAccountingInput | null {
  if (!value) return null;
  return {
    historyBaselineTokens: nonNegativeSafeInteger(value.historyBaselineTokens, 'requestAccounting.historyBaselineTokens'),
    historyBaselineSource: boundedAuditText(value.historyBaselineSource, 'requestAccounting.historyBaselineSource'),
    fixedInputTokens: nonNegativeSafeInteger(value.fixedInputTokens, 'requestAccounting.fixedInputTokens'),
    estimateSafetyMarginTokens: nonNegativeSafeInteger(value.estimateSafetyMarginTokens, 'requestAccounting.estimateSafetyMarginTokens'),
  };
}

function boundedAuditText(value: string, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('\0')) throw dispatchError('ZEUS_CONTEXT_INVALID_ARGUMENT', `${field} 无效。`);
  return value;
}

function toCodexAdditionalContext(rendered: ReturnType<typeof renderCompiledContext>): CodexBootstrapAdditionalContext {
  const result: CodexBootstrapAdditionalContext = {
    zeus_context_manifest: { kind: 'application', value: rendered.manifest },
  };
  if (rendered.application) result.zeus_application_context = { kind: 'application', value: rendered.application };
  if (rendered.untrusted) result.zeus_untrusted_context = { kind: 'untrusted', value: rendered.untrusted };
  return result;
}

function normalizeProject(project: ContextDispatchProject): ContextDispatchProject {
  if (!project || typeof project !== 'object') throw dispatchError('ZEUS_CONTEXT_INVALID_ARGUMENT', 'project is required.');
  const id = boundedText(project.id, 'project.id', 512);
  const localPath = boundedText(project.localPath, 'project.localPath', 16_384);
  return { id, localPath };
}

function normalizeTask(task: ContextDispatchTask | null | undefined): ContextDispatchTask | null {
  if (task === undefined || task === null) return null;
  return { id: boundedText(task.id, 'task.id', 512), code: boundedText(task.code, 'task.code', 160).toUpperCase() };
}

function normalizeSelectedFragments(fragments: ContextFragment[] | undefined): ContextFragment[] {
  if (fragments === undefined) return [];
  if (!Array.isArray(fragments)) throw dispatchError('ZEUS_CONTEXT_INVALID_ARGUMENT', 'selectedFragments 必须是数组。');
  for (const fragment of fragments) {
    if (fragment.category === 'safety_boundary' || fragment.category === 'task_document' || fragment.category === 'long_term_memory') {
      throw dispatchError('ZEUS_CONTEXT_AUTHORITY_SPOOFING', 'selectedFragments 不能覆盖安全边界、任务主文档或长期记忆；这些来源只能由其 owner 组装。');
    }
  }
  return fragments;
}

function latestMemoryWatermark(values: string[]): string {
  return [...values].sort().at(-1) ?? 'none';
}

function preflightWatermark(capability: AgentPreflightTokenCountCapability): string {
  return capability.state === 'available' ? `available:${capability.source}:${capability.checkedAt}` : `unavailable:${capability.checkedAt ?? 'unknown'}`;
}

function boundedText(value: string, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw dispatchError('ZEUS_CONTEXT_INVALID_ARGUMENT', `${field} 必须是 1 到 ${maximum} 个字符且不含 NUL 的字符串。`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw dispatchError('ZEUS_CONTEXT_INVALID_ARGUMENT', `${field} 必须是非负安全整数。`);
  return value;
}

function dispatchError(code: 'ZEUS_CONTEXT_INVALID_ARGUMENT' | 'ZEUS_CONTEXT_AUTHORITY_SPOOFING' | 'ZEUS_CONTEXT_AUDIT_UNAVAILABLE', message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
