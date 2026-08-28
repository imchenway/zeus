import { createHash } from 'node:crypto';
import type { LongTermMemoryRecord } from '@zeus/storage';

export const contextCompilerSchemaVersion = 'zeus-context-compiler-v1';
export const maximumContextFragmentCount = 2_048;
export const maximumContextCandidateCharacters = 32 * 1024 * 1024;

export type ContextFragmentCategory = 'safety_boundary' | 'task_document' | 'long_term_memory' | 'project_code' | 'conversation_history' | 'runtime_evidence' | 'cold_evidence';
export type ContextFragmentAuthority = 'user_explicit' | 'project_document' | 'zeus_business' | 'provider_native' | 'derived_cold';
export type ContextFragmentStatus = 'current' | 'review_due' | 'stale' | 'missing';
export type ContextPlacement = 'application' | 'untrusted';
export type ContextOperationRisk = 'read_only' | 'local_write' | 'external_state';
export type ContextProvenance = 'zeus_current' | 'provider_native' | 'zeus_portable' | 'derived_cold';
export type ContextSourceTruncationReason = 'source_page_limit';
export type ContextTruncationReason = ContextSourceTruncationReason | 'category_budget' | 'global_budget';

export type ContextTokenCountMode = 'exact' | 'estimate';

/**
 * 同步、无 I/O 的 tokenizer 端口。Provider Adapter 只有在持有真实本地 tokenizer 时才能声明 exact；
 * 远端请求前计数应先在 Adapter 层完成并把确定结果转换成这样的纯计数器，不能在编译器内联网。
 */
export interface ContextTokenCounter {
  id: string;
  mode: ContextTokenCountMode;
  count(content: string): number;
}

export const defaultContextTokenCounter: ContextTokenCounter = {
  id: 'zeus-utf8-quarter-estimate-v1',
  mode: 'estimate',
  count: estimateUtf8Tokens,
};

export interface ContextFragment {
  id: string;
  category: ContextFragmentCategory;
  authority: ContextFragmentAuthority;
  status: ContextFragmentStatus;
  content: string;
  sourceRef: string;
  sourceVersion: string;
  updatedAt: string;
  provenance?: ContextProvenance;
  projectId?: string;
  taskId?: string;
  taskCode?: string;
  providerId?: string;
  nativeSessionId?: string;
  contentSha256?: string;
  dedupeKey?: string;
  /** 只有当前任务最新完整主文档设为 true。 */
  primaryTaskDocument?: boolean;
  /** Memory 到达该时间后必须降为 review_due；其他来源不设置。 */
  reviewAfter?: string;
  externalStateEffect?: boolean;
  confirmationLevel?: 'observed' | 'confirmed' | 'explicit';
  memoryKind?: 'preference' | 'safety_boundary' | 'stable_workflow';
  sourceTruncationReason?: ContextSourceTruncationReason;
}

export type ContextBudget = Record<ContextFragmentCategory, number>;

export interface CompileContextInput {
  asOf: string;
  operationRisk: ContextOperationRisk;
  provider: {
    id: string;
    contextWindowTokens: number;
    reservedOutputTokens: number;
    currentInputTokens: number;
    capabilities?: {
      applicationContext?: boolean;
      untrustedContext?: boolean;
      portableContext?: boolean;
    };
  };
  maximumCompiledTokens?: number;
  budgets?: Partial<ContextBudget>;
  includeColdEvidence?: boolean;
  /** 项目会话没有 task 时仍需明确 scope；与 task.projectId 同时存在时必须一致。 */
  projectId?: string | null;
  task?: { projectId: string; taskId: string; taskCode: string } | null;
  watermarks: Readonly<Record<string, string | number | boolean | null>>;
  fragments: ContextFragment[];
  /** 未提供时使用明确标记为 estimate 的确定性 UTF-8 估算，不会伪装为 Provider 精确 tokenizer。 */
  tokenCounter?: ContextTokenCounter;
}

export interface CompiledContextSection {
  fragmentId: string;
  category: ContextFragmentCategory;
  authority: ContextFragmentAuthority;
  placement: ContextPlacement;
  provenance: ContextProvenance;
  projectId: string | null;
  taskId: string | null;
  taskCode: string | null;
  providerId: string | null;
  nativeSessionId: string | null;
  content: string;
  sourceRef: string;
  sourceVersion: string;
  updatedAt: string;
  contentSha256: string;
  requestedTokens: number;
  includedTokens: number;
  truncated: boolean;
  truncationReason: 'category_budget' | 'global_budget' | null;
  sourceTruncationReason: ContextSourceTruncationReason | null;
  truncationReasons: ContextTruncationReason[];
}

export type ContextCompilationDecisionReason =
  | 'selected'
  | 'truncated_category_budget'
  | 'truncated_global_budget'
  | 'truncated_source_page_limit'
  | 'duplicate'
  | 'review_due'
  | 'stale'
  | 'missing'
  | 'cold_evidence_not_requested'
  | 'external_state_confirmation_required'
  | 'project_context_mismatch'
  | 'task_context_mismatch'
  | 'provider_context_mismatch'
  | 'provider_application_context_unsupported'
  | 'provider_untrusted_context_unsupported'
  | 'provider_portable_context_unsupported'
  | 'category_budget_exhausted'
  | 'global_budget_exhausted';

export interface ContextCompilationDecision {
  fragmentId: string;
  category: ContextFragmentCategory;
  sourceRef: string;
  sourceVersion: string;
  outcome: 'included' | 'truncated' | 'excluded';
  reason: ContextCompilationDecisionReason;
  requestedTokens: number;
  includedTokens: number;
  duplicateOf: string | null;
  truncationReasons: ContextTruncationReason[];
}

export interface CompiledContext {
  schemaVersion: typeof contextCompilerSchemaVersion;
  fingerprint: string;
  asOf: string;
  providerId: string;
  providerCapabilities: Required<NonNullable<CompileContextInput['provider']['capabilities']>>;
  projectId: string | null;
  task: CompileContextInput['task'];
  operationRisk: ContextOperationRisk;
  availableTokens: number;
  usedTokens: number;
  tokenAccounting: {
    counterId: string;
    mode: ContextTokenCountMode;
  };
  budgets: ContextBudget;
  watermarks: Readonly<Record<string, string | number | boolean | null>>;
  applicationSections: CompiledContextSection[];
  untrustedSections: CompiledContextSection[];
  decisions: ContextCompilationDecision[];
  diagnostics: Array<'primary_task_document_missing' | 'primary_task_document_excluded'>;
}

export type ContextCompilerErrorCode = 'ZEUS_CONTEXT_COMPILER_INVALID_ARGUMENT' | 'ZEUS_CONTEXT_COMPILER_SAFETY_BUDGET_EXCEEDED' | 'ZEUS_CONTEXT_COMPILER_SAFETY_CAPABILITY_UNAVAILABLE';

export class ContextCompilerError extends Error {
  readonly name = 'ContextCompilerError';

  constructor(
    readonly code: ContextCompilerErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
  }
}

export const defaultContextBudgets: ContextBudget = {
  safety_boundary: 4_096,
  task_document: 12_288,
  long_term_memory: 2_048,
  project_code: 8_192,
  conversation_history: 12_288,
  runtime_evidence: 2_048,
  cold_evidence: 0,
};

/**
 * 确定性地编译有界上下文。调用方必须显式提供 asOf 和水位；函数不读取文件、数据库或 wall clock。
 */
export function compileContext(input: CompileContextInput): CompiledContext {
  const asOf = validTimestamp(input.asOf, 'asOf');
  const operationRisk = validOperationRisk(input.operationRisk);
  const providerId = boundedText(input.provider.id, 'provider.id', 1, 256);
  const providerCapabilities = normalizeProviderCapabilities(input.provider.capabilities);
  const task = normalizeTask(input.task);
  const projectId = normalizeProjectId(input.projectId, task);
  const tokenCounter = normalizeTokenCounter(input.tokenCounter);
  const contextWindow = boundedInteger(input.provider.contextWindowTokens, 'provider.contextWindowTokens', 1, Number.MAX_SAFE_INTEGER);
  const reservedOutput = boundedInteger(input.provider.reservedOutputTokens, 'provider.reservedOutputTokens', 0, contextWindow);
  const currentInput = boundedInteger(input.provider.currentInputTokens, 'provider.currentInputTokens', 0, contextWindow);
  const providerAvailable = Math.max(0, contextWindow - reservedOutput - currentInput);
  const requestedMaximum = input.maximumCompiledTokens === undefined ? providerAvailable : boundedInteger(input.maximumCompiledTokens, 'maximumCompiledTokens', 0, contextWindow);
  const availableTokens = Math.min(providerAvailable, requestedMaximum);
  const budgets = normalizeBudgets(input.budgets);
  if (!Array.isArray(input.fragments)) throw invalidArgument('fragments 必须是数组。', { field: 'fragments' });
  boundedInteger(input.fragments.length, 'fragments.length', 0, maximumContextFragmentCount);
  let candidateCharacters = 0;
  for (const fragment of input.fragments) {
    if (!fragment || typeof fragment !== 'object' || typeof fragment.content !== 'string') throw invalidArgument('每个 fragment 必须包含字符串正文。', { field: 'fragments' });
    candidateCharacters += fragment.content.length;
    if (candidateCharacters > maximumContextCandidateCharacters) {
      throw invalidArgument('Context 候选正文总量超过编译上限。', { candidateCharacters, maximum: maximumContextCandidateCharacters });
    }
  }
  const prepared = input.fragments.map((fragment) => prepareFragment(fragment, asOf, tokenCounter));
  prepared.sort(comparePreparedFragments);

  const decisions: ContextCompilationDecision[] = [];
  const included: CompiledContextSection[] = [];
  const seenDedupe = new Map<string, string>();
  const remainingByCategory = new Map<ContextFragmentCategory, number>(Object.entries(budgets) as Array<[ContextFragmentCategory, number]>);
  let remainingGlobal = availableTokens;

  for (const fragment of prepared) {
    const baseDecision = {
      fragmentId: fragment.id,
      category: fragment.category,
      sourceRef: fragment.sourceRef,
      sourceVersion: fragment.sourceVersion,
      requestedTokens: fragment.requestedTokens,
      truncationReasons: [] as ContextTruncationReason[],
    };
    const excludedReason = exclusionReason(fragment, { includeColdEvidence: input.includeColdEvidence === true, operationRisk, providerId, providerCapabilities, projectId, task });
    if (excludedReason) {
      if (fragment.category === 'safety_boundary' && excludedReason === 'provider_application_context_unsupported') {
        throw new ContextCompilerError('ZEUS_CONTEXT_COMPILER_SAFETY_CAPABILITY_UNAVAILABLE', 'Provider 不支持安全边界所需的应用级上下文，已拒绝降级为不可信历史。', {
          fragmentId: fragment.id,
          providerId,
        });
      }
      decisions.push({ ...baseDecision, outcome: 'excluded', reason: excludedReason, includedTokens: 0, duplicateOf: null });
      continue;
    }
    const duplicateOf = seenDedupe.get(fragment.dedupeKey);
    if (duplicateOf) {
      decisions.push({ ...baseDecision, outcome: 'excluded', reason: 'duplicate', includedTokens: 0, duplicateOf });
      continue;
    }

    const categoryRemaining = remainingByCategory.get(fragment.category) ?? 0;
    if (categoryRemaining <= 0) {
      if (fragment.category === 'safety_boundary') throw safetyBudgetError(fragment, availableTokens, categoryRemaining, remainingGlobal);
      decisions.push({ ...baseDecision, outcome: 'excluded', reason: 'category_budget_exhausted', includedTokens: 0, duplicateOf: null });
      continue;
    }
    if (remainingGlobal <= 0) {
      if (fragment.category === 'safety_boundary') throw safetyBudgetError(fragment, availableTokens, categoryRemaining, remainingGlobal);
      decisions.push({ ...baseDecision, outcome: 'excluded', reason: 'global_budget_exhausted', includedTokens: 0, duplicateOf: null });
      continue;
    }

    const fragmentBudget = Math.min(categoryRemaining, remainingGlobal);
    if (fragment.category === 'safety_boundary' && fragment.requestedTokens > fragmentBudget) throw safetyBudgetError(fragment, availableTokens, categoryRemaining, remainingGlobal);
    const truncated = fragment.requestedTokens > fragmentBudget;
    const content = truncated ? truncateToTokenBudget(fragment.content, fragmentBudget, tokenCounter) : fragment.content;
    const includedTokens = countTokens(tokenCounter, content);
    if (includedTokens <= 0) {
      decisions.push({ ...baseDecision, outcome: 'excluded', reason: categoryRemaining <= remainingGlobal ? 'category_budget_exhausted' : 'global_budget_exhausted', includedTokens: 0, duplicateOf: null });
      continue;
    }
    // 只有实际纳入的片段才能占用 dedupe key；预算拒绝不能把后续可用候选伪报为重复项。
    seenDedupe.set(fragment.dedupeKey, fragment.id);
    const truncationReason = truncated ? (categoryRemaining <= remainingGlobal ? 'category_budget' : 'global_budget') : null;
    const sourceTruncationReason = fragment.sourceTruncationReason ?? null;
    const truncationReasons = [...(sourceTruncationReason ? [sourceTruncationReason] : []), ...(truncationReason ? [truncationReason] : [])] as ContextTruncationReason[];
    included.push({
      fragmentId: fragment.id,
      category: fragment.category,
      authority: fragment.authority,
      placement: placementFor(fragment),
      provenance: fragment.provenance,
      projectId: fragment.projectId ?? null,
      taskId: fragment.taskId ?? null,
      taskCode: fragment.taskCode ?? null,
      providerId: fragment.providerId ?? null,
      nativeSessionId: fragment.nativeSessionId ?? null,
      content,
      sourceRef: fragment.sourceRef,
      sourceVersion: fragment.sourceVersion,
      updatedAt: fragment.updatedAt,
      contentSha256: fragment.contentSha256,
      requestedTokens: fragment.requestedTokens,
      includedTokens,
      truncated: truncationReasons.length > 0,
      truncationReason,
      sourceTruncationReason,
      truncationReasons,
    });
    remainingByCategory.set(fragment.category, Math.max(0, categoryRemaining - includedTokens));
    remainingGlobal = Math.max(0, remainingGlobal - includedTokens);
    decisions.push({
      ...baseDecision,
      outcome: truncationReasons.length > 0 ? 'truncated' : 'included',
      reason: truncated ? (truncationReason === 'category_budget' ? 'truncated_category_budget' : 'truncated_global_budget') : sourceTruncationReason ? 'truncated_source_page_limit' : 'selected',
      includedTokens,
      duplicateOf: null,
      truncationReasons,
    });
  }

  const primaryDocuments = prepared.filter((fragment) => fragment.category === 'task_document' && fragment.primaryTaskDocument);
  const includedIds = new Set(included.map((section) => section.fragmentId));
  const diagnostics: CompiledContext['diagnostics'] = [];
  if (task && primaryDocuments.length === 0) diagnostics.push('primary_task_document_missing');
  else if (task && !primaryDocuments.some((fragment) => includedIds.has(fragment.id))) diagnostics.push('primary_task_document_excluded');

  const outputWithoutFingerprint: Omit<CompiledContext, 'fingerprint'> = {
    schemaVersion: contextCompilerSchemaVersion,
    asOf,
    providerId,
    providerCapabilities,
    projectId,
    task,
    operationRisk,
    availableTokens,
    usedTokens: availableTokens - remainingGlobal,
    tokenAccounting: { counterId: tokenCounter.id, mode: tokenCounter.mode },
    budgets,
    watermarks: normalizeWatermarks(input.watermarks),
    applicationSections: included.filter((section) => section.placement === 'application'),
    untrustedSections: included.filter((section) => section.placement === 'untrusted'),
    decisions,
    diagnostics,
  };
  return {
    ...outputWithoutFingerprint,
    fingerprint: createHash('sha256').update(canonicalJson(outputWithoutFingerprint)).digest('hex'),
  };
}

/** 把已通过 Memory Repository 过时治理的记录转换为编译候选；不会读取 Codex Memory 文件。 */
export function longTermMemoryContextFragment(record: LongTermMemoryRecord): ContextFragment {
  const authority: ContextFragmentAuthority = record.source.kind === 'project_instruction' ? 'project_document' : record.source.kind === 'user_explicit' ? 'user_explicit' : 'zeus_business';
  return {
    id: `memory:${record.id}`,
    category: record.kind === 'safety_boundary' ? 'safety_boundary' : 'long_term_memory',
    authority,
    status: record.tombstone ? 'missing' : 'current',
    provenance: 'zeus_current',
    ...(record.scope.kind === 'project' ? { projectId: record.scope.id } : {}),
    content: record.content,
    sourceRef: record.source.reference,
    sourceVersion: `${record.updatedAt}:${record.contentSha256}`,
    updatedAt: record.updatedAt,
    contentSha256: record.contentSha256,
    dedupeKey: `memory:${record.scope.kind}:${record.scope.id}:${record.memoryKey}`,
    reviewAfter: record.reviewAfter,
    externalStateEffect: record.effect === 'external_state',
    confirmationLevel: record.confirmationLevel,
    memoryKind: record.kind,
  };
}

/** 为 Provider Adapter 输出带来源边界的结构，不把 untrusted 历史伪装成应用规则。 */
export function renderCompiledContext(compiled: CompiledContext): { manifest: string; application: string; untrusted: string } {
  const manifest = JSON.stringify(
    {
      schemaVersion: compiled.schemaVersion,
      fingerprint: compiled.fingerprint,
      asOf: compiled.asOf,
      providerId: compiled.providerId,
      operationRisk: compiled.operationRisk,
      usedTokens: compiled.usedTokens,
      availableTokens: compiled.availableTokens,
      tokenAccounting: compiled.tokenAccounting,
      sources: [...compiled.applicationSections, ...compiled.untrustedSections].map((section) => ({
        fragmentId: section.fragmentId,
        category: section.category,
        authority: section.authority,
        placement: section.placement,
        provenance: section.provenance,
        projectId: section.projectId,
        taskId: section.taskId,
        taskCode: section.taskCode,
        providerId: section.providerId,
        nativeSessionId: section.nativeSessionId,
        sourceRef: section.sourceRef,
        sourceVersion: section.sourceVersion,
        contentSha256: section.contentSha256,
        truncated: section.truncated,
        truncationReason: section.truncationReason,
        sourceTruncationReason: section.sourceTruncationReason,
        truncationReasons: section.truncationReasons,
      })),
    },
    null,
    2,
  );
  return {
    manifest,
    application: renderSections(compiled.applicationSections),
    untrusted: renderSections(compiled.untrustedSections),
  };
}

interface PreparedContextFragment extends ContextFragment {
  contentSha256: string;
  dedupeKey: string;
  provenance: ContextProvenance;
  requestedTokens: number;
}

function prepareFragment(fragment: ContextFragment, asOf: string, tokenCounter: ContextTokenCounter): PreparedContextFragment {
  const content = boundedText(fragment.content, 'fragment.content', 1, 4 * 1024 * 1024);
  const contentSha256 = createHash('sha256').update(content).digest('hex');
  if (fragment.contentSha256 && fragment.contentSha256 !== contentSha256) {
    throw invalidArgument('fragment.contentSha256 与真实正文不一致。', { fragmentId: fragment.id });
  }
  const reviewAfter = fragment.reviewAfter ? validTimestamp(fragment.reviewAfter, 'fragment.reviewAfter') : undefined;
  const category = validCategory(fragment.category);
  const authority = validAuthority(fragment.authority);
  const status = validStatus(fragment.status);
  const provenance = validProvenance(fragment.provenance ?? defaultProvenance(authority));
  const projectId = optionalIdentity(fragment.projectId, 'fragment.projectId', 512);
  const taskId = optionalIdentity(fragment.taskId, 'fragment.taskId', 512);
  const taskCode = optionalIdentity(fragment.taskCode, 'fragment.taskCode', 160);
  const fragmentProviderId = optionalIdentity(fragment.providerId, 'fragment.providerId', 256);
  const nativeSessionId = optionalIdentity(fragment.nativeSessionId, 'fragment.nativeSessionId', 512);
  if (fragment.primaryTaskDocument && category !== 'task_document') throw invalidArgument('只有 task_document 可以标记为当前任务主文档。', { fragmentId: fragment.id });
  if (provenance !== 'zeus_current' && (category === 'safety_boundary' || category === 'task_document' || category === 'long_term_memory')) {
    throw invalidArgument('Provider 原生、便携或派生证据不能伪装成应用级安全、任务文档或长期记忆。', { fragmentId: fragment.id, provenance, category });
  }
  if ((category === 'safety_boundary' || category === 'task_document' || category === 'long_term_memory') && (authority === 'provider_native' || authority === 'derived_cold')) {
    throw invalidArgument('不可信来源不能升格为应用级上下文分类。', { fragmentId: fragment.id, authority, category });
  }
  if (fragment.sourceTruncationReason !== undefined && fragment.sourceTruncationReason !== 'source_page_limit') throw invalidArgument('未知来源截断原因。', { fragmentId: fragment.id });
  return {
    ...fragment,
    id: boundedText(fragment.id, 'fragment.id', 1, 512),
    content,
    sourceRef: boundedText(fragment.sourceRef, 'fragment.sourceRef', 1, 4_096),
    sourceVersion: boundedText(fragment.sourceVersion, 'fragment.sourceVersion', 1, 512),
    updatedAt: validTimestamp(fragment.updatedAt, 'fragment.updatedAt'),
    category,
    authority,
    status,
    provenance,
    ...(projectId ? { projectId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(taskCode ? { taskCode } : {}),
    ...(fragmentProviderId ? { providerId: fragmentProviderId } : {}),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    contentSha256,
    dedupeKey: fragment.dedupeKey ? boundedText(fragment.dedupeKey, 'fragment.dedupeKey', 1, 512) : `sha256:${contentSha256}`,
    requestedTokens: countTokens(tokenCounter, content),
    ...(reviewAfter ? { reviewAfter, status: reviewAfter.localeCompare(asOf) <= 0 ? 'review_due' : status } : {}),
  };
}

function exclusionReason(
  fragment: PreparedContextFragment,
  input: {
    includeColdEvidence: boolean;
    operationRisk: ContextOperationRisk;
    providerId: string;
    providerCapabilities: Required<NonNullable<CompileContextInput['provider']['capabilities']>>;
    projectId: string | null;
    task: CompileContextInput['task'];
  },
): ContextCompilationDecisionReason | null {
  if (fragment.status === 'review_due') return 'review_due';
  if (fragment.status === 'stale') return 'stale';
  if (fragment.status === 'missing') return 'missing';
  if (fragment.projectId && fragment.projectId !== input.projectId) return 'project_context_mismatch';
  if ((fragment.taskId && fragment.taskId !== input.task?.taskId) || (fragment.taskCode && fragment.taskCode !== input.task?.taskCode)) return 'task_context_mismatch';
  if (fragment.providerId && fragment.providerId !== input.providerId) return 'provider_context_mismatch';
  if (fragment.category === 'cold_evidence' && !input.includeColdEvidence) return 'cold_evidence_not_requested';
  if (input.operationRisk === 'external_state' && fragment.externalStateEffect && fragment.confirmationLevel !== 'explicit') return 'external_state_confirmation_required';
  const placement = placementFor(fragment);
  if (placement === 'application' && !input.providerCapabilities.applicationContext) return 'provider_application_context_unsupported';
  if (placement === 'untrusted' && !input.providerCapabilities.untrustedContext) return 'provider_untrusted_context_unsupported';
  if (fragment.provenance === 'zeus_portable' && !input.providerCapabilities.portableContext) return 'provider_portable_context_unsupported';
  return null;
}

function comparePreparedFragments(left: PreparedContextFragment, right: PreparedContextFragment): number {
  return (
    categoryPriority(left) - categoryPriority(right) ||
    Number(Boolean(right.primaryTaskDocument)) - Number(Boolean(left.primaryTaskDocument)) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.sourceRef.localeCompare(right.sourceRef) ||
    left.id.localeCompare(right.id)
  );
}

function categoryPriority(fragment: PreparedContextFragment): number {
  const base: Record<ContextFragmentCategory, number> = {
    safety_boundary: 0,
    task_document: 100,
    long_term_memory: 200,
    project_code: 300,
    conversation_history: 400,
    runtime_evidence: 500,
    cold_evidence: 600,
  };
  if (fragment.category !== 'long_term_memory') return base[fragment.category];
  return base.long_term_memory + (fragment.memoryKind === 'stable_workflow' ? 0 : 10);
}

function placementFor(fragment: ContextFragment): ContextPlacement {
  if (fragment.provenance !== 'zeus_current') return 'untrusted';
  return fragment.category === 'safety_boundary' || fragment.category === 'task_document' || fragment.category === 'long_term_memory' ? 'application' : 'untrusted';
}

function normalizeBudgets(overrides: Partial<ContextBudget> | undefined): ContextBudget {
  return Object.fromEntries(
    (Object.keys(defaultContextBudgets) as ContextFragmentCategory[]).map((category) => [category, boundedInteger(overrides?.[category] ?? defaultContextBudgets[category], `budgets.${category}`, 0, Number.MAX_SAFE_INTEGER)]),
  ) as ContextBudget;
}

function normalizeWatermarks(watermarks: CompileContextInput['watermarks']): CompileContextInput['watermarks'] {
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(watermarks).sort()) {
    if (!/^[a-z][a-zA-Z0-9_.:-]{0,159}$/u.test(key)) throw invalidArgument('watermark key 不合法。', { key });
    const value = watermarks[key];
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw invalidArgument('watermark value 必须是标量。', { key });
    if (typeof value === 'number' && !Number.isFinite(value)) throw invalidArgument('watermark number 必须是有限值。', { key });
    normalized[key] = value;
  }
  return normalized;
}

function truncateToTokenBudget(content: string, tokenBudget: number, tokenCounter: ContextTokenCounter): string {
  if (tokenBudget <= 0) return '';
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const safeMiddle = avoidSplitSurrogate(content, middle);
    if (countTokens(tokenCounter, content.slice(0, safeMiddle)) <= tokenBudget) low = middle;
    else high = middle - 1;
  }
  return content.slice(0, avoidSplitSurrogate(content, low)).trimEnd();
}

function avoidSplitSurrogate(content: string, index: number): number {
  if (index <= 0 || index >= content.length) return index;
  const previous = content.charCodeAt(index - 1);
  const next = content.charCodeAt(index);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? index - 1 : index;
}

function estimateUtf8Tokens(content: string): number {
  return content.length === 0 ? 0 : Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4));
}

function normalizeTokenCounter(counter: ContextTokenCounter | undefined): ContextTokenCounter {
  const candidate = counter ?? defaultContextTokenCounter;
  const id = boundedText(candidate.id, 'tokenCounter.id', 1, 160);
  if (candidate.mode !== 'exact' && candidate.mode !== 'estimate') throw invalidArgument('tokenCounter.mode 必须是 exact 或 estimate。', { field: 'tokenCounter.mode' });
  if (typeof candidate.count !== 'function') throw invalidArgument('tokenCounter.count 必须是同步计数函数。', { field: 'tokenCounter.count' });
  return { id, mode: candidate.mode, count: candidate.count };
}

function countTokens(counter: ContextTokenCounter, content: string): number {
  let value: number;
  try {
    value = counter.count(content);
  } catch {
    throw invalidArgument('tokenCounter.count 执行失败。', { counterId: counter.id });
  }
  if (!Number.isSafeInteger(value) || value < 0 || (content.length > 0 && value === 0)) {
    throw invalidArgument('tokenCounter.count 必须为非空正文返回正安全整数。', { counterId: counter.id, value: Number.isFinite(value) ? value : null });
  }
  return value;
}

function renderSections(sections: CompiledContextSection[]): string {
  return sections
    .map(
      (section) =>
        `--- ${section.fragmentId}\nsource: ${section.sourceRef}\nversion: ${section.sourceVersion}\nauthority: ${section.authority}\nprovenance: ${section.provenance}\ncategory: ${section.category}\ntruncated: ${String(section.truncated)}\ntruncation_reasons: ${section.truncationReasons.join(',') || 'none'}\n\n${section.content}`,
    )
    .join('\n\n');
}

function normalizeTask(task: CompileContextInput['task']): CompileContextInput['task'] {
  if (task === null) return null;
  if (!task || typeof task !== 'object') throw invalidArgument('task 必须是明确任务身份或 null。', { field: 'task' });
  return {
    projectId: boundedText(task.projectId, 'task.projectId', 1, 512),
    taskId: boundedText(task.taskId, 'task.taskId', 1, 512),
    taskCode: boundedText(task.taskCode, 'task.taskCode', 1, 160),
  };
}

function normalizeProjectId(projectId: string | null | undefined, task: CompileContextInput['task']): string | null {
  const normalized = projectId === undefined || projectId === null ? null : boundedText(projectId, 'projectId', 1, 512);
  if (normalized && task && normalized !== task.projectId) throw invalidArgument('projectId 与 task.projectId 不一致。', { projectId: normalized, taskProjectId: task.projectId });
  return normalized ?? task?.projectId ?? null;
}

function normalizeProviderCapabilities(capabilities: CompileContextInput['provider']['capabilities']): Required<NonNullable<CompileContextInput['provider']['capabilities']>> {
  const normalized = {
    applicationContext: capabilities?.applicationContext ?? true,
    untrustedContext: capabilities?.untrustedContext ?? true,
    portableContext: capabilities?.portableContext ?? true,
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (typeof value !== 'boolean') throw invalidArgument(`provider.capabilities.${key} 必须是布尔值。`, { field: `provider.capabilities.${key}` });
  }
  return normalized;
}

function validOperationRisk(value: ContextOperationRisk): ContextOperationRisk {
  if (value !== 'read_only' && value !== 'local_write' && value !== 'external_state') throw invalidArgument('operationRisk 不合法。', { value: String(value) });
  return value;
}

function validCategory(value: ContextFragmentCategory): ContextFragmentCategory {
  if (!Object.hasOwn(defaultContextBudgets, value)) throw invalidArgument('未知上下文分类。', { value: String(value) });
  return value;
}

function validAuthority(value: ContextFragmentAuthority): ContextFragmentAuthority {
  if (value !== 'user_explicit' && value !== 'project_document' && value !== 'zeus_business' && value !== 'provider_native' && value !== 'derived_cold') {
    throw invalidArgument('未知上下文权威来源。', { value: String(value) });
  }
  return value;
}

function validStatus(value: ContextFragmentStatus): ContextFragmentStatus {
  if (value !== 'current' && value !== 'review_due' && value !== 'stale' && value !== 'missing') throw invalidArgument('未知上下文状态。', { value: String(value) });
  return value;
}

function defaultProvenance(authority: ContextFragmentAuthority): ContextProvenance {
  if (authority === 'provider_native') return 'provider_native';
  if (authority === 'derived_cold') return 'derived_cold';
  return 'zeus_current';
}

function validProvenance(value: ContextProvenance): ContextProvenance {
  if (value !== 'zeus_current' && value !== 'provider_native' && value !== 'zeus_portable' && value !== 'derived_cold') throw invalidArgument('未知上下文 provenance。', { value: String(value) });
  return value;
}

function optionalIdentity(value: string | undefined, field: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, field, 1, maximum);
}

function safetyBudgetError(fragment: PreparedContextFragment, availableTokens: number, categoryRemaining: number, globalRemaining: number): ContextCompilerError {
  return new ContextCompilerError('ZEUS_CONTEXT_COMPILER_SAFETY_BUDGET_EXCEEDED', '安全边界无法完整放入上下文预算，已拒绝截断或继续编译。', {
    fragmentId: fragment.id,
    requestedTokens: fragment.requestedTokens,
    availableTokens,
    categoryRemaining,
    globalRemaining,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw invalidArgument('上下文指纹包含不可序列化值。', { valueType: typeof value });
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function validTimestamp(value: string, field: string): string {
  const timestamp = boundedText(value, field, 1, 64);
  const epoch = Date.parse(timestamp);
  if (Number.isNaN(epoch)) throw invalidArgument(`${field} 必须是有效时间字符串。`, { field });
  return new Date(epoch).toISOString();
}

function boundedText(value: string, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    throw invalidArgument(`${field} 必须是 ${minimum} 到 ${maximum} 个字符且不含 NUL 的字符串。`, { field, minimum, maximum });
  }
  return value;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidArgument(`${field} 必须是 ${minimum} 到 ${maximum} 之间的安全整数。`, { field, minimum, maximum });
  return value;
}

function invalidArgument(message: string, details: Readonly<Record<string, string | number | boolean | null>>): ContextCompilerError {
  return new ContextCompilerError('ZEUS_CONTEXT_COMPILER_INVALID_ARGUMENT', message, details);
}
