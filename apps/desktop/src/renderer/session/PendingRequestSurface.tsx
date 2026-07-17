import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { openExternalHttpsUrlInMain } from '../appShellBridge.js';
import type { NativePendingRequest, NativePermissionMode } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

export interface RequestQuestionOption {
  label: string;
  description: string;
}

export interface RequestQuestion {
  id: string;
  header: string;
  question: string;
  kind: 'single' | 'multiple' | 'freeform';
  secret: boolean;
  allowOther: boolean;
  options: RequestQuestionOption[];
}

export type PendingRequestKind = 'command' | 'file' | 'permissions' | 'request_user_input' | 'mcp' | 'unknown';
export type SupportedRequestDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface PendingRequestSurfaceProps {
  request: NativePendingRequest;
  language: SessionUiLanguage;
  busy?: boolean;
  error?: string | null;
  autoFocus?: boolean;
  onRespond: (requestId: string, response: Record<string, unknown>) => void | Promise<void>;
  permissionMode?: NativePermissionMode;
}

const OTHER_ANSWER = '__other__';
const supportedDecisionOrder: SupportedRequestDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];

const labels = {
  'zh-CN': {
    approval: '需要审批',
    input: '需要你的回答',
    accept: '允许一次',
    acceptForSession: '本会话允许',
    decline: '拒绝',
    cancel: '取消',
    submit: '提交回答',
    other: '其他',
    otherPlaceholder: '输入其他回答',
    loading: '正在读取请求详情，详情完整前不能决策。',
    impact: '影响',
    secret: '敏感回答仅发送给当前本机 app-server，不会显示在会话记录中。',
    responding: '正在提交',
    unsupported: '不支持的请求类型',
    unsupportedHelp: 'Zeus 无法安全识别此请求，因此不会提供允许操作。',
    invalidMcp: 'MCP 响应 JSON 无效',
    invalidMcpHelp: '请求 schema、URL 或响应 JSON 无法安全验证；修复前只提供拒绝或取消。',
    mcpResponse: 'MCP 结构化回答 JSON',
    mcpUrl: '打开 MCP 请求页面',
    mcpUrlOpenFailed: '无法打开 MCP 请求页面，请重试。',
    incompleteApproval: '审批详情不完整',
    incompleteApprovalHelp: 'Zeus 无法确认命令或文件目标，因此只提供拒绝或取消操作。',
    cwd: '工作目录',
    mode: '当前模式',
    required: '必填',
  },
  'en-US': {
    approval: 'Approval required',
    input: 'Input required',
    accept: 'Allow once',
    acceptForSession: 'Allow for session',
    decline: 'Decline',
    cancel: 'Cancel',
    submit: 'Submit answers',
    other: 'Other',
    otherPlaceholder: 'Enter another answer',
    loading: 'Loading request details. Decisions remain unavailable until details are complete.',
    impact: 'Impact',
    secret: 'Secret answers are sent only to the current local app-server and are not shown in the transcript.',
    responding: 'Submitting',
    unsupported: 'Unsupported request type',
    unsupportedHelp: 'Zeus cannot identify this request safely, so no allow action is available.',
    invalidMcp: 'Invalid MCP response payload',
    invalidMcpHelp: 'The request schema, URL, or response JSON cannot be validated safely. Only decline or cancel remains available.',
    mcpResponse: 'MCP structured response JSON',
    mcpUrl: 'Open MCP request page',
    mcpUrlOpenFailed: 'Could not open the MCP request page. Please try again.',
    incompleteApproval: 'Incomplete approval details',
    incompleteApprovalHelp: 'Zeus cannot verify the command or file target, so only decline or cancel actions are available.',
    cwd: 'Working directory',
    mode: 'Current mode',
    required: 'Required',
  },
} as const;

export function PendingRequestSurface(props: PendingRequestSurfaceProps) {
  const copy = labels[props.language];
  const kind = requestKind(props.request);
  const questions = useMemo(() => normalizeRequestQuestions(props.request), [props.request]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [mcpResponseJson, setMcpResponseJson] = useState('{}');
  const [mcpUrlError, setMcpUrlError] = useState<string | null>(null);
  const firstControlRef = useRef<HTMLInputElement | HTMLButtonElement | null>(null);
  const isRui = kind === 'request_user_input';
  const hasDetails = isRui ? questions.length > 0 : Object.keys(props.request.payload).length > 0;
  const decisions = supportedRequestDecisions(props.request);
  const autofocusDecision = defaultAutofocusDecision(decisions);
  const answersComplete = areRequiredRequestAnswersComplete(questions, answers, otherAnswers);

  useEffect(() => {
    if (props.autoFocus === false) return;
    firstControlRef.current?.focus();
  }, [autofocusDecision, hasDetails, props.autoFocus, props.request.id, questions.length]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!hasDetails || props.busy || !answersComplete) return;
    await props.onRespond(props.request.id, buildPendingRequestResponse(props.request, answers, otherAnswers));
  }

  async function openMcpUrl(url: string): Promise<void> {
    setMcpUrlError(null);
    try {
      const result = await openExternalHttpsUrlInMain({ zeus: typeof window === 'undefined' ? undefined : window.zeus, url });
      if (!result.opened) setMcpUrlError(copy.mcpUrlOpenFailed);
    } catch {
      setMcpUrlError(copy.mcpUrlOpenFailed);
    }
  }

  if (kind === 'unknown') {
    return (
      <section className="session-pending-request session-pending-request-unsupported" role="alert">
        <strong>{copy.unsupported}</strong>
        <p>{copy.unsupportedHelp}</p>
        <pre className="session-request-preview">{props.request.type}</pre>
        {props.error ? <p role="alert">{props.error}</p> : null}
      </section>
    );
  }

  if (!hasDetails) {
    return (
      <section className="session-pending-request session-pending-request-loading" role="status" aria-live="polite" aria-label={isRui ? copy.input : copy.approval}>
        <strong>{isRui ? copy.input : copy.approval}</strong>
        <p>{copy.loading}</p>
      </section>
    );
  }

  if (!isRui) {
    const canonicalMcpMode = kind === 'mcp' ? mcpRequestMode(props.request) : null;
    const acceptsMcpJson = canonicalMcpMode === 'form' || canonicalMcpMode === 'openai/form';
    const mcpUrl = canonicalMcpMode === 'url' ? safeMcpUrl(props.request) : null;
    const mcpResponseValid = !acceptsMcpJson || isMcpResponseContentValid(props.request, mcpResponseJson);
    const invalidMcp = kind === 'mcp' && (!hasValidMcpResponsePayload(props.request) || !mcpResponseValid);
    const incompleteApproval = (kind === 'command' || kind === 'file') && !hasCompleteApprovalDetails(props.request);
    return (
      <section className="session-pending-request session-approval-request" aria-busy={props.busy || undefined}>
        <fieldset disabled={props.busy}>
          <legend>{copy.approval}</legend>
          <p className="session-request-impact">
            <strong>{copy.impact}</strong>
            <span>{requestImpact(props.request, props.language)}</span>
          </p>
          <p className="session-request-mode">
            <strong>{copy.mode}</strong>
            <span>{permissionModeLabel(props.permissionMode ?? 'read-only', props.language)}</span>
          </p>
          <pre className="session-request-preview">{requestPreview(props.request, copy.cwd)}</pre>
          {acceptsMcpJson ? (
            <label className="session-mcp-response">
              <span>{copy.mcpResponse}</span>
              <textarea value={mcpResponseJson} onChange={(event) => setMcpResponseJson(event.currentTarget.value)} spellCheck={false} />
            </label>
          ) : null}
          {mcpUrl ? (
            <button type="button" className="session-mcp-url" onClick={() => void openMcpUrl(mcpUrl)}>
              {copy.mcpUrl}
            </button>
          ) : null}
          {mcpUrlError ? <p role="alert">{mcpUrlError}</p> : null}
          {invalidMcp ? (
            <p className="session-request-invalid" role="alert">
              <strong>{copy.invalidMcp}</strong>
              <span>{copy.invalidMcpHelp}</span>
            </p>
          ) : null}
          {incompleteApproval ? (
            <p className="session-request-invalid" role="alert">
              <strong>{copy.incompleteApproval}</strong>
              <span>{copy.incompleteApprovalHelp}</span>
            </p>
          ) : null}
          {props.error ? <p role="alert">{props.error}</p> : null}
          <div className="session-request-actions">
            {decisions.map((decision) => (
              <button
                key={decision}
                ref={decision === autofocusDecision ? (firstControlRef as React.RefObject<HTMLButtonElement>) : undefined}
                type="button"
                disabled={decision === 'accept' && !mcpResponseValid}
                className={decision === 'accept' || decision === 'acceptForSession' ? 'session-request-accept' : 'session-request-decline'}
                onClick={() => void props.onRespond(props.request.id, buildPendingRequestResponse(props.request, { decision: [decision], ...(acceptsMcpJson ? { mcpContent: [mcpResponseJson] } : {}) }))}
              >
                {props.busy ? copy.responding : copy[decision]}
              </button>
            ))}
          </div>
        </fieldset>
      </section>
    );
  }

  return (
    <form className="session-pending-request session-rui-request" onSubmit={(event) => void submit(event)} aria-busy={props.busy || undefined}>
      <fieldset disabled={props.busy}>
        <legend>{copy.input}</legend>
        {questions.map((question, questionIndex) => (
          <fieldset className="session-rui-question" key={question.id}>
            <legend>
              {question.header || question.question} <small>{copy.required}</small>
            </legend>
            {question.header && question.question ? <p>{question.question}</p> : null}
            {question.options.length > 0 ? (
              <div className="session-rui-options">
                {question.options.map((option, optionIndex) => {
                  const checked = answers[question.id]?.includes(option.label) ?? false;
                  return (
                    <label key={option.label}>
                      <input
                        ref={questionIndex === 0 && optionIndex === 0 ? (firstControlRef as React.RefObject<HTMLInputElement>) : undefined}
                        type={question.kind === 'multiple' ? 'checkbox' : 'radio'}
                        name={`request-${props.request.id}-${question.id}`}
                        value={option.label}
                        checked={checked}
                        onChange={(event) => setAnswers((current) => updateQuestionAnswers(current, question, option.label, event.currentTarget.checked))}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        {option.description ? <small>{option.description}</small> : null}
                      </span>
                    </label>
                  );
                })}
                {question.allowOther ? (
                  <label className="session-rui-other-option">
                    <input
                      type={question.kind === 'multiple' ? 'checkbox' : 'radio'}
                      name={`request-${props.request.id}-${question.id}`}
                      value={otherAnswerControlValue(question)}
                      checked={answers[question.id]?.includes(otherAnswerControlValue(question)) ?? false}
                      onChange={(event) => setAnswers((current) => updateQuestionAnswers(current, question, otherAnswerControlValue(question), event.currentTarget.checked))}
                    />
                    <span>
                      <strong>{copy.other}</strong>
                      <input
                        aria-label={`${copy.other}: ${question.header || question.question}`}
                        {...answerInputSecurityAttributes(question.secret)}
                        disabled={!answers[question.id]?.includes(otherAnswerControlValue(question))}
                        value={otherAnswers[question.id] ?? ''}
                        placeholder={copy.otherPlaceholder}
                        onChange={(event) => setOtherAnswers((current) => ({ ...current, [question.id]: event.currentTarget.value }))}
                      />
                    </span>
                  </label>
                ) : null}
              </div>
            ) : (
              <label className="session-rui-freeform">
                <span>{question.question || question.header}</span>
                <input
                  ref={questionIndex === 0 ? (firstControlRef as React.RefObject<HTMLInputElement>) : undefined}
                  {...answerInputSecurityAttributes(question.secret)}
                  required
                  value={answers[question.id]?.[0] ?? ''}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: [event.currentTarget.value] }))}
                />
              </label>
            )}
            {question.secret ? <small className="session-secret-hint">{copy.secret}</small> : null}
          </fieldset>
        ))}
        {props.error ? <p role="alert">{props.error}</p> : null}
        <div className="session-request-actions">
          <button type="submit" disabled={!answersComplete}>
            {props.busy ? copy.responding : copy.submit}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function permissionModeLabel(permissionMode: NativePermissionMode, language: SessionUiLanguage): string {
  const labels: Record<NativePermissionMode, readonly [string, string]> = {
    'read-only': ['只读', 'Read only'],
    auto: ['自动', 'Auto'],
    'full-access': ['完全访问', 'Full access'],
  };
  return labels[permissionMode][language === 'zh-CN' ? 0 : 1];
}

function updateQuestionAnswers(current: Record<string, string[]>, question: RequestQuestion, value: string, checked: boolean): Record<string, string[]> {
  if (question.kind !== 'multiple') return { ...current, [question.id]: checked ? [value] : [] };
  const currentValues = current[question.id] ?? [];
  return { ...current, [question.id]: checked ? [...new Set([...currentValues, value])] : currentValues.filter((entry) => entry !== value) };
}

export function normalizeRequestQuestions(request: NativePendingRequest): RequestQuestion[] {
  const envelopeKeys = ['threadId', 'turnId', 'itemId', 'questions', 'autoResolutionMs'];
  if (Object.keys(request.payload).length !== envelopeKeys.length || !hasOnlyKeys(request.payload, envelopeKeys)) return [];
  if (!nonEmptyString(request.payload.threadId) || !nonEmptyString(request.payload.turnId) || !nonEmptyString(request.payload.itemId)) return [];
  if (request.payload.autoResolutionMs !== null && (typeof request.payload.autoResolutionMs !== 'number' || !Number.isFinite(request.payload.autoResolutionMs) || request.payload.autoResolutionMs < 0)) return [];
  const rawQuestions = Array.isArray(request.payload.questions) ? request.payload.questions : [];
  if (rawQuestions.length === 0) return [];
  const normalized: RequestQuestion[] = [];
  const questionIds = new Set<string>();
  for (const entry of rawQuestions) {
    if (!isRecord(entry)) return [];
    const id = nonEmptyString(entry.id);
    const header = nonEmptyString(entry.header);
    const question = nonEmptyString(entry.question);
    if (!id || !header || !question || questionIds.has(id) || typeof entry.isSecret !== 'boolean' || typeof entry.isOther !== 'boolean') return [];
    if (entry.multiple !== undefined && typeof entry.multiple !== 'boolean') return [];

    let options: RequestQuestionOption[];
    if (entry.options === null) {
      options = [];
    } else if (Array.isArray(entry.options) && entry.options.length > 0) {
      options = [];
      const optionLabels = new Set<string>();
      for (const option of entry.options) {
        if (!isRecord(option)) return [];
        const label = nonEmptyString(option.label);
        if (!label || typeof option.description !== 'string' || optionLabels.has(label)) return [];
        optionLabels.add(label);
        options.push({ label, description: option.description });
      }
    } else {
      return [];
    }
    const multiple = entry.multiple === true;
    if (options.length === 0 && (entry.isOther || multiple)) return [];
    questionIds.add(id);
    normalized.push({ id, header, question, kind: options.length > 0 ? (multiple ? 'multiple' : 'single') : 'freeform', secret: entry.isSecret, allowOther: entry.isOther, options });
  }
  return normalized;
}

export function areRequiredRequestAnswersComplete(questions: readonly RequestQuestion[], answers: Record<string, string[]>, otherAnswers: Record<string, string> = {}): boolean {
  return validateRendererRequestAnswers(questions, answers, otherAnswers) === null;
}

export function buildPendingRequestResponse(request: NativePendingRequest, answers: Record<string, string[]>, otherAnswers: Record<string, string> = {}): Record<string, unknown> {
  const kind = requestKind(request);
  if (kind === 'request_user_input') {
    const questions = normalizeRequestQuestions(request);
    if (questions.length === 0) throw new Error('The pending request does not contain a complete canonical question set.');
    const validationError = validateRendererRequestAnswers(questions, answers, otherAnswers);
    if (validationError) throw new Error(validationError);
    const normalizedAnswers = Object.fromEntries(questions.map((question) => [question.id, { answers: answers[question.id]!.map((value) => (value === otherAnswerControlValue(question) ? otherAnswers[question.id]!.trim() : value)) }]));
    return { type: 'userInput', answers: normalizedAnswers };
  }
  if (kind === 'unknown') throw new Error('Unsupported pending request type.');
  const requestedDecision = answers.decision?.[0];
  if (kind === 'permissions') {
    if (requestedDecision !== 'decline') throw new Error('Only a fail-closed permissions decision is available.');
    return { type: 'permissions', permissions: {}, scope: 'turn' };
  }
  if (kind === 'mcp' && requestedDecision === 'acceptForSession') throw new Error('acceptForSession is not available for MCP requests.');
  if (!isSupportedRequestDecision(requestedDecision) || !supportedRequestDecisions(request).includes(requestedDecision)) throw new Error('The requested decision is not safely available.');
  const decision = requestedDecision;
  if (kind === 'mcp') {
    if (decision !== 'accept') return { type: 'MCP', action: decision, content: null, _meta: null };
    const mode = mcpRequestMode(request);
    if (mode === 'form' || mode === 'openai/form') {
      const raw = answers.mcpContent?.[0];
      if (!raw || !isMcpResponseContentValid(request, raw)) throw new Error('MCP response content is invalid.');
      return { type: 'MCP', action: decision, content: JSON.parse(raw) as unknown, _meta: null };
    }
    if (mode === 'url') return { type: 'MCP', action: decision, content: null, _meta: null };
    return { type: 'MCP', action: decision, content: jsonValueOrNull(request.payload.content), _meta: jsonValueOrNull(request.payload._meta) };
  }
  return { type: kind, decision };
}

function validateRendererRequestAnswers(questions: readonly RequestQuestion[], answers: Record<string, string[]>, otherAnswers: Record<string, string>): string | null {
  if (questions.length === 0) return 'Answers must cover the complete canonical question set.';
  const answerIds = Object.keys(answers);
  const questionIds = questions.map((question) => question.id);
  if (answerIds.length < questionIds.length || questionIds.some((id) => !(id in answers))) return 'Answers must cover the complete canonical question set.';
  if (answerIds.length !== questionIds.length || answerIds.some((id) => !questionIds.includes(id))) return 'Answer ids must exactly match the canonical question ids.';

  for (const question of questions) {
    const values = answers[question.id];
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || !value.trim())) return `Question ${question.id} requires a non-empty answer.`;
    if (new Set(values).size !== values.length) return `Question ${question.id} answers must be unique.`;
    if (question.kind !== 'multiple' && values.length !== 1) return `Question ${question.id} requires a single answer.`;
    if (question.kind === 'freeform') continue;
    const optionLabels = new Set(question.options.map((option) => option.label));
    for (const value of values) {
      if (optionLabels.has(value)) continue;
      if (value !== otherAnswerControlValue(question) || !question.allowOther) {
        return question.allowOther ? `Question ${question.id} Other answer must use the Other control.` : `Question ${question.id} answer must be an advertised option.`;
      }
      if (!otherAnswers[question.id]?.trim()) return `Question ${question.id} requires a non-empty Other answer.`;
    }
  }
  return null;
}

function otherAnswerControlValue(question: RequestQuestion): string {
  const optionLabels = new Set(question.options.map((option) => option.label));
  let value = OTHER_ANSWER;
  while (optionLabels.has(value)) value += '_';
  return value;
}

export function requestKind(request: NativePendingRequest): PendingRequestKind {
  switch (request.type) {
    case 'command':
      return 'command';
    case 'file':
      return 'file';
    case 'permissions':
      return 'permissions';
    case 'request_user_input':
    case 'userInput':
      return 'request_user_input';
    case 'mcp':
    case 'MCP':
      return 'mcp';
    default:
      return 'unknown';
  }
}

export function supportedRequestDecisions(request: NativePendingRequest): SupportedRequestDecision[] {
  const kind = requestKind(request);
  if (kind === 'unknown' || kind === 'request_user_input') return [];
  if (kind === 'permissions') return ['decline'];
  const raw = Array.isArray(request.payload.availableDecisions) ? request.payload.availableDecisions : [];
  const advertised = raw.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (!isRecord(entry)) return [];
    return [stringValue(entry.decision) ?? stringValue(entry.id) ?? stringValue(entry.value) ?? stringValue(entry.name)].filter((value): value is string => Boolean(value));
  });
  let decisions = supportedDecisionOrder.filter((decision) => advertised.includes(decision));
  if (kind === 'mcp') {
    const requestValid = hasValidMcpResponsePayload(request);
    decisions = decisions.length > 0 ? decisions.filter((decision) => decision !== 'acceptForSession' && (requestValid || decision !== 'accept')) : requestValid ? ['accept', 'decline', 'cancel'] : ['decline', 'cancel'];
    return ensureFailClosedDecisions(decisions);
  }
  if (kind === 'file') {
    decisions = decisions.filter((decision) => decision !== 'acceptForSession');
    if (request.payload.grantRoot !== undefined && request.payload.grantRoot !== null) decisions = decisions.filter((decision) => decision !== 'accept');
  }
  if (kind === 'file' && decisions.length === 0 && advertised.length === 0 && hasCanonicalLinkedFileApprovalDetails(request)) decisions = ['accept', 'decline', 'cancel'];
  if (decisions.length === 0) decisions = ['decline', 'cancel'];
  if (!hasCompleteApprovalDetails(request)) return ensureFailClosedDecisions(decisions.filter(isFailClosedDecision));
  return ensureFailClosedDecisions(decisions);
}

export function defaultAutofocusDecision(decisions: readonly SupportedRequestDecision[]): SupportedRequestDecision | null {
  return decisions.find(isFailClosedDecision) ?? null;
}

export function answerInputSecurityAttributes(secret: boolean): { type: 'password'; autoComplete: 'off' } | { type: 'text' } {
  return secret ? { type: 'password', autoComplete: 'off' } : { type: 'text' };
}

export function hasValidMcpResponsePayload(request: NativePendingRequest): boolean {
  if (requestKind(request) !== 'mcp') return false;
  const mode = mcpRequestMode(request);
  if (mode === 'form') return hasCanonicalMcpEnvelope(request.payload, ['requestedSchema']) && isSupportedCanonicalMcpFormSchema(request.payload.requestedSchema);
  if (mode === 'openai/form') return hasCanonicalMcpEnvelope(request.payload, ['requestedSchema']) && isSupportedJsonSchema(request.payload.requestedSchema);
  if (mode === 'url') return hasCanonicalMcpEnvelope(request.payload, ['url', 'elicitationId']) && Boolean(safeMcpUrl(request)) && Boolean(stringValue(request.payload.elicitationId));
  return false;
}

export function isMcpResponseContentValid(request: NativePendingRequest, raw: string): boolean {
  const mode = mcpRequestMode(request);
  if (mode !== 'form' && mode !== 'openai/form') return false;
  try {
    const content = JSON.parse(raw) as unknown;
    if (!isJsonValue(content)) return false;
    if (mode === 'form') return isSupportedCanonicalMcpFormSchema(request.payload.requestedSchema) && matchesCanonicalMcpForm(content, request.payload.requestedSchema);
    return isSupportedJsonSchema(request.payload.requestedSchema) && matchesJsonSchema(content, request.payload.requestedSchema);
  } catch {
    return false;
  }
}

function isSupportedRequestDecision(value: unknown): value is SupportedRequestDecision {
  return typeof value === 'string' && supportedDecisionOrder.includes(value as SupportedRequestDecision);
}

function isFailClosedDecision(decision: SupportedRequestDecision): boolean {
  return decision === 'decline' || decision === 'cancel';
}

function ensureFailClosedDecisions(decisions: readonly SupportedRequestDecision[]): SupportedRequestDecision[] {
  const allowed = new Set(decisions);
  allowed.add('decline');
  allowed.add('cancel');
  return supportedDecisionOrder.filter((decision) => allowed.has(decision));
}

function hasCompleteApprovalDetails(request: NativePendingRequest): boolean {
  const kind = requestKind(request);
  if (kind === 'command') {
    const command = request.payload.command;
    return typeof command === 'string' ? Boolean(command.trim()) : Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === 'string' && Boolean(part.trim()));
  }
  if (kind === 'file') return Boolean(stringValue(request.payload.path) ?? stringValue(request.payload.filePath) ?? stringValue(request.payload.grantRoot)) || hasCanonicalLinkedFileApprovalDetails(request);
  return true;
}

function hasCanonicalLinkedFileApprovalDetails(request: NativePendingRequest): boolean {
  if (requestKind(request) !== 'file' || !hasOnlyKeys(request.payload, ['threadId', 'turnId', 'itemId', 'startedAtMs', 'reason', 'grantRoot', 'availableDecisions'])) return false;
  return (
    Boolean(stringValue(request.payload.threadId)) &&
    Boolean(stringValue(request.payload.turnId)) &&
    Boolean(stringValue(request.payload.itemId)) &&
    typeof request.payload.startedAtMs === 'number' &&
    Number.isFinite(request.payload.startedAtMs) &&
    request.payload.startedAtMs >= 0 &&
    (request.payload.reason === undefined || request.payload.reason === null || typeof request.payload.reason === 'string') &&
    (request.payload.grantRoot === undefined || request.payload.grantRoot === null)
  );
}

function requestImpact(request: NativePendingRequest, language: SessionUiLanguage): string {
  const explicit = stringValue(request.payload.reason) ?? stringValue(request.payload.description);
  if (explicit) return explicit;
  const kind = requestKind(request);
  if (language === 'zh-CN') {
    if (kind === 'file') return '允许本轮修改工作区文件。';
    if (kind === 'permissions') return '该权限结构尚未受支持，Zeus 不会发送允许响应。';
    if (kind === 'mcp') return '向 MCP server 发送所示 JSON 响应。';
    return '允许本轮执行所列命令。';
  }
  if (kind === 'file') return 'Allows this turn to modify workspace files.';
  if (kind === 'permissions') return 'This permission schema is unsupported; Zeus will not send an allow response.';
  if (kind === 'mcp') return 'Sends the shown JSON response to the MCP server.';
  return 'Allows this turn to execute the listed command.';
}

function requestPreview(request: NativePendingRequest, cwdLabel: string): string {
  const command = request.payload.command;
  const commandText = Array.isArray(command) ? command.filter((value): value is string => typeof value === 'string').join(' ') : typeof command === 'string' ? command : '';
  const cwd = stringValue(request.payload.cwd) ?? stringValue(request.payload.workingDirectory);
  if (commandText) return cwd ? `${commandText}\n${cwdLabel}: ${cwd}` : commandText;
  const filePath = stringValue(request.payload.path) ?? stringValue(request.payload.filePath);
  if (filePath) return filePath;
  if (requestKind(request) === 'mcp') {
    const mode = mcpRequestMode(request);
    if (mode) return JSON.stringify({ mode, message: request.payload.message, requestedSchema: request.payload.requestedSchema, url: mode === 'url' ? mcpUrlPreview(request) : undefined }, null, 2);
    return JSON.stringify({ content: request.payload.content, _meta: request.payload._meta }, null, 2);
  }
  return request.type;
}

function mcpUrlPreview(request: NativePendingRequest): string | undefined {
  if (typeof request.payload.url !== 'string') return undefined;
  try {
    const url = new URL(request.payload.url);
    if (url.username || url.password) return `[credentials hidden] (${url.protocol}//${url.host})`;
    if (request.containsSecret) return '[sensitive URL hidden]';
    if (url.protocol !== 'https:') return '[invalid URL hidden]';
    return url.search || url.hash ? `${url.origin}${url.pathname} [query hidden]` : url.href;
  } catch {
    return '[invalid URL hidden]';
  }
}

function mcpRequestMode(request: NativePendingRequest): 'form' | 'openai/form' | 'url' | null {
  const mode = request.payload.mode;
  return mode === 'form' || mode === 'openai/form' || mode === 'url' ? mode : null;
}

function safeMcpUrl(request: NativePendingRequest): string | null {
  if (mcpRequestMode(request) !== 'url' || typeof request.payload.url !== 'string') return null;
  try {
    const url = new URL(request.payload.url);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function hasCanonicalMcpEnvelope(payload: Record<string, unknown>, modeKeys: readonly string[]): boolean {
  const commonKeys = ['threadId', 'turnId', 'serverName', 'mode', '_meta', 'message'];
  if (!hasOnlyKeys(payload, [...commonKeys, ...modeKeys])) return false;
  if (!stringValue(payload.threadId) || !(payload.turnId === null || Boolean(stringValue(payload.turnId))) || !stringValue(payload.serverName) || !stringValue(payload.message)) return false;
  return Object.prototype.hasOwnProperty.call(payload, '_meta') && isJsonValue(payload._meta);
}

function isSupportedCanonicalMcpFormSchema(schema: unknown): schema is Record<string, unknown> {
  if (!isRecord(schema) || !hasOnlyKeys(schema, ['$schema', 'type', 'properties', 'required'])) return false;
  if (schema.$schema !== undefined && typeof schema.$schema !== 'string') return false;
  if (schema.type !== 'object' || !isRecord(schema.properties)) return false;
  if (!Object.values(schema.properties).every(isSupportedCanonicalMcpPrimitiveSchema)) return false;
  if (schema.required === undefined) return true;
  if (!Array.isArray(schema.required) || !schema.required.every((entry) => typeof entry === 'string')) return false;
  const required = schema.required as string[];
  return new Set(required).size === required.length && required.every((key) => Object.prototype.hasOwnProperty.call(schema.properties, key));
}

function isSupportedCanonicalMcpPrimitiveSchema(schema: unknown): schema is Record<string, unknown> {
  if (!isRecord(schema) || !hasOptionalText(schema, 'title') || !hasOptionalText(schema, 'description')) return false;
  if (schema.type === 'string') return isSupportedCanonicalStringSchema(schema);
  if (schema.type === 'number' || schema.type === 'integer') return isSupportedCanonicalNumberSchema(schema);
  if (schema.type === 'boolean') return isSupportedCanonicalBooleanSchema(schema);
  if (schema.type === 'array') return isSupportedCanonicalMultiSelectSchema(schema);
  return false;
}

function isSupportedCanonicalStringSchema(schema: Record<string, unknown>): boolean {
  const hasEnum = Object.prototype.hasOwnProperty.call(schema, 'enum');
  const hasOneOf = Object.prototype.hasOwnProperty.call(schema, 'oneOf');
  if (hasEnum && hasOneOf) return false;
  if (hasOneOf) {
    if (!hasOnlyKeys(schema, ['type', 'title', 'description', 'oneOf', 'default']) || !isConstOptionArray(schema.oneOf)) return false;
    const values = (schema.oneOf as Record<string, unknown>[]).map((option) => option.const as string);
    return schema.default === undefined || (typeof schema.default === 'string' && values.includes(schema.default));
  }
  if (hasEnum) {
    if (!hasOnlyKeys(schema, ['type', 'title', 'description', 'enum', 'enumNames', 'default']) || !isUniqueStringArray(schema.enum)) return false;
    const values = schema.enum as string[];
    if (schema.enumNames !== undefined && (!Array.isArray(schema.enumNames) || !schema.enumNames.every((entry) => typeof entry === 'string') || schema.enumNames.length !== values.length)) return false;
    return schema.default === undefined || (typeof schema.default === 'string' && values.includes(schema.default));
  }
  if (!hasOnlyKeys(schema, ['type', 'title', 'description', 'minLength', 'maxLength', 'format', 'default'])) return false;
  if (!isOptionalNonNegativeInteger(schema.minLength) || !isOptionalNonNegativeInteger(schema.maxLength)) return false;
  if (typeof schema.minLength === 'number' && typeof schema.maxLength === 'number' && schema.minLength > schema.maxLength) return false;
  if (schema.format !== undefined && (typeof schema.format !== 'string' || !['email', 'uri', 'date', 'date-time'].includes(schema.format))) return false;
  return schema.default === undefined || (typeof schema.default === 'string' && matchesCanonicalString(schema.default, schema));
}

function isSupportedCanonicalNumberSchema(schema: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(schema, ['type', 'title', 'description', 'minimum', 'maximum', 'default'])) return false;
  if (!isOptionalFiniteNumber(schema.minimum) || !isOptionalFiniteNumber(schema.maximum)) return false;
  if (typeof schema.minimum === 'number' && typeof schema.maximum === 'number' && schema.minimum > schema.maximum) return false;
  return schema.default === undefined || matchesCanonicalNumber(schema.default, schema);
}

function isSupportedCanonicalBooleanSchema(schema: Record<string, unknown>): boolean {
  return hasOnlyKeys(schema, ['type', 'title', 'description', 'default']) && (schema.default === undefined || typeof schema.default === 'boolean');
}

function isSupportedCanonicalMultiSelectSchema(schema: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(schema, ['type', 'title', 'description', 'minItems', 'maxItems', 'items', 'default'])) return false;
  if (!isOptionalNonNegativeInteger(schema.minItems) || !isOptionalNonNegativeInteger(schema.maxItems)) return false;
  if (typeof schema.minItems === 'number' && typeof schema.maxItems === 'number' && schema.minItems > schema.maxItems) return false;
  const choices = canonicalMultiSelectChoices(schema.items);
  if (!choices) return false;
  if (typeof schema.minItems === 'number' && schema.minItems > choices.length) return false;
  return schema.default === undefined || matchesCanonicalMultiSelect(schema.default, schema, choices);
}

function canonicalMultiSelectChoices(items: unknown): string[] | null {
  if (!isRecord(items)) return null;
  if (hasOnlyKeys(items, ['type', 'enum']) && items.type === 'string' && isUniqueStringArray(items.enum)) return items.enum as string[];
  if (hasOnlyKeys(items, ['anyOf']) && isConstOptionArray(items.anyOf)) return (items.anyOf as Record<string, unknown>[]).map((option) => option.const as string);
  return null;
}

function matchesCanonicalMcpForm(value: unknown, schema: Record<string, unknown>): boolean {
  if (!isRecord(value) || !isRecord(schema.properties)) return false;
  const properties = schema.properties;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
  if (Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) return false;
  return Object.entries(value).every(([key, child]) => isSupportedCanonicalMcpPrimitiveSchema(properties[key]) && matchesCanonicalMcpPrimitive(child, properties[key]));
}

function matchesCanonicalMcpPrimitive(value: unknown, schema: Record<string, unknown>): boolean {
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    if (Array.isArray(schema.enum)) return (schema.enum as unknown[]).includes(value);
    if (Array.isArray(schema.oneOf)) return (schema.oneOf as Record<string, unknown>[]).some((option) => option.const === value);
    return matchesCanonicalString(value, schema);
  }
  if (schema.type === 'number' || schema.type === 'integer') return matchesCanonicalNumber(value, schema);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return matchesCanonicalMultiSelect(value, schema, canonicalMultiSelectChoices(schema.items) ?? []);
  return false;
}

function matchesCanonicalString(value: string, schema: Record<string, unknown>): boolean {
  const length = Array.from(value).length;
  if (typeof schema.minLength === 'number' && length < schema.minLength) return false;
  if (typeof schema.maxLength === 'number' && length > schema.maxLength) return false;
  if (schema.format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (schema.format === 'uri') {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  if (schema.format === 'date') return isValidCanonicalDate(value);
  if (schema.format === 'date-time') return isValidCanonicalDateTime(value);
  return true;
}

function matchesCanonicalNumber(value: unknown, schema: Record<string, unknown>): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (schema.type === 'integer' && !Number.isInteger(value)) return false;
  if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
  return typeof schema.maximum !== 'number' || value <= schema.maximum;
}

function matchesCanonicalMultiSelect(value: unknown, schema: Record<string, unknown>, choices: readonly string[]): boolean {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string') || new Set(value).size !== value.length) return false;
  if (!value.every((entry) => choices.includes(entry))) return false;
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
  return typeof schema.maxItems !== 'number' || value.length <= schema.maxItems;
}

function isConstOptionArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every((entry) => isRecord(entry) && hasOnlyKeys(entry, ['const', 'title']) && typeof entry.const === 'string' && typeof entry.title === 'string')) return false;
  return new Set(value.map((entry) => (entry as Record<string, unknown>).const)).size === value.length;
}

function isUniqueStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string') && new Set(value).size === value.length;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasOptionalText(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'string';
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isValidCanonicalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidCanonicalDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match || !isValidCanonicalDate(`${match[1]}-${match[2]}-${match[3]}`)) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59 && Number.isFinite(Date.parse(value));
}

function matchesJsonSchema(value: unknown, schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonValuesEqual(candidate, value))) return false;
  const type = typeof schema.type === 'string' ? schema.type : null;
  if (type === 'object') {
    if (!isRecord(value)) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) && schema.required.every((entry) => typeof entry === 'string') ? (schema.required as string[]) : [];
    if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) return false;
    return Object.entries(properties).every(([key, child]) => !Object.prototype.hasOwnProperty.call(value, key) || matchesJsonSchema(value[key], child));
  }
  if (type === 'array') return Array.isArray(value) && (schema.items === undefined || value.every((entry) => matchesJsonSchema(entry, schema.items)));
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return type === null && isJsonValue(value);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && jsonValuesEqual(left[key], right[key]));
}

function isSupportedJsonSchema(schema: unknown): schema is Record<string, unknown> {
  if (!isRecord(schema)) return false;
  const allowedKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'title', 'description', 'default']);
  if (Object.keys(schema).some((key) => !allowedKeys.has(key))) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.every(isJsonValue))) return false;
  if (schema.title !== undefined && typeof schema.title !== 'string') return false;
  if (schema.description !== undefined && typeof schema.description !== 'string') return false;
  if (schema.default !== undefined && !isJsonValue(schema.default)) return false;
  const type = schema.type;
  if (type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(type))) return false;
  if (type === 'object') {
    if (schema.properties !== undefined && (!isRecord(schema.properties) || !Object.values(schema.properties).every(isSupportedJsonSchema))) return false;
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((entry) => typeof entry === 'string'))) return false;
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') return false;
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    return false;
  }
  if (type === 'array') {
    if (schema.items !== undefined && !isSupportedJsonSchema(schema.items)) return false;
  } else if (schema.items !== undefined) {
    return false;
  }
  return true;
}

function jsonValueOrNull(value: unknown): null | boolean | number | string | unknown[] | Record<string, unknown> {
  return isJsonValue(value) ? (value as null | boolean | number | string | unknown[] | Record<string, unknown>) : null;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
