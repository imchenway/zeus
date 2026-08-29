import { createReadStream, lstatSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { extname, isAbsolute } from 'node:path';

export type CodexRolloutRequestUserInputRecovery =
  | {
      status: 'found';
      answers: Record<string, { answers: string[] }>;
      occurredAt: string | null;
    }
  | {
      status: 'unavailable' | 'not_found' | 'ambiguous' | 'invalid';
      reason: 'rollout_path_unavailable' | 'rollout_thread_mismatch' | 'request_call_missing' | 'request_call_ambiguous' | 'answer_output_missing' | 'answer_output_ambiguous' | 'answer_output_invalid';
    };

export interface CodexRolloutRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }> | null;
  isOther: boolean;
  isSecret: boolean;
  multiple: boolean;
}

export interface CodexRolloutRequestUserInputEvidence {
  providerItemId: string;
  callId: string;
  providerTurnId: string;
  questions: CodexRolloutRequestUserInputQuestion[];
  occurredAt: string | null;
  outcome: 'pending' | 'answered' | 'aborted' | 'resolved';
  answers: Record<string, { answers: string[] }> | null;
  resolvedAt: string | null;
}

export type CodexRolloutRequestUserInputInspection = { status: 'found'; requests: CodexRolloutRequestUserInputEvidence[] } | { status: 'unavailable'; reason: 'rollout_path_unavailable' | 'rollout_thread_mismatch' };

interface RequestUserInputCall {
  id: string;
  callId: string;
  turnId: string | null;
  questions: CodexRolloutRequestUserInputQuestion[];
  questionIdentity: string;
  occurredAt: string | null;
}

interface RequestUserInputOutput {
  callId: string;
  turnId: string | null;
  output: unknown;
  occurredAt: string | null;
}

interface RolloutRequestUserInputScan {
  observedThreadId: string | null;
  calls: RequestUserInputCall[];
  outputs: RequestUserInputOutput[];
}

/**
 * 只从会话已经绑定的 rollout 提取 app-server 历史缺失的询问内容事实。
 * 返回值不包含 server-request ID，也不能用于提交回答。
 */
export async function inspectCodexRolloutRequestUserInputEvidence(input: { rolloutPath: string | null; providerThreadId: string; providerTurnIds: readonly string[] }): Promise<CodexRolloutRequestUserInputInspection> {
  const rolloutPath = readableRolloutPath(input.rolloutPath);
  if (!rolloutPath) return { status: 'unavailable', reason: 'rollout_path_unavailable' };
  const scan = await scanRequestUserInputRollout(rolloutPath);
  if (!scan || scan.observedThreadId !== input.providerThreadId) {
    return { status: 'unavailable', reason: scan ? 'rollout_thread_mismatch' : 'rollout_path_unavailable' };
  }
  const eligibleTurnIds = new Set(input.providerTurnIds);
  const requests = scan.calls.flatMap((call): CodexRolloutRequestUserInputEvidence[] => {
    if (!call.turnId || !eligibleTurnIds.has(call.turnId)) return [];
    const outputs = scan.outputs.filter((output) => output.callId === call.callId && (!output.turnId || output.turnId === call.turnId));
    const result = rolloutRequestUserInputResult(outputs);
    return [
      {
        providerItemId: call.id,
        callId: call.callId,
        providerTurnId: call.turnId,
        questions: call.questions,
        occurredAt: call.occurredAt,
        outcome: result.outcome,
        answers: result.answers,
        resolvedAt: result.resolvedAt,
      },
    ];
  });
  return { status: 'found', requests };
}

export async function recoverRequestUserInputAnswersFromCodexRollout(input: {
  rolloutPath: string | null;
  providerThreadId: string;
  providerTurnId: string | null;
  providerItemId: string | null;
  requestPayload: unknown;
}): Promise<CodexRolloutRequestUserInputRecovery> {
  const rolloutPath = readableRolloutPath(input.rolloutPath);
  if (!rolloutPath) return { status: 'unavailable', reason: 'rollout_path_unavailable' };
  const expectedQuestionIdentity = requestUserInputQuestionIdentity(input.requestPayload);
  if (!expectedQuestionIdentity) return { status: 'invalid', reason: 'answer_output_invalid' };
  const scan = await scanRequestUserInputRollout(rolloutPath);
  if (!scan) return { status: 'unavailable', reason: 'rollout_path_unavailable' };
  const { calls, outputs, observedThreadId } = scan;

  if (observedThreadId !== input.providerThreadId) return { status: 'unavailable', reason: 'rollout_thread_mismatch' };
  const identityMatches = calls.filter((call) => call.questionIdentity === expectedQuestionIdentity && (!input.providerTurnId || call.turnId === input.providerTurnId));
  const exactItemMatches = input.providerItemId ? identityMatches.filter((call) => call.id === input.providerItemId || call.callId === input.providerItemId) : [];
  const matchedCalls = input.providerItemId ? exactItemMatches : identityMatches;
  if (matchedCalls.length === 0) return { status: 'not_found', reason: 'request_call_missing' };
  if (matchedCalls.length > 1) return { status: 'ambiguous', reason: 'request_call_ambiguous' };

  const call = matchedCalls[0]!;
  const matchedOutputs = outputs.filter((output) => output.callId === call.callId && (!call.turnId || output.turnId === call.turnId));
  if (matchedOutputs.length === 0) return { status: 'not_found', reason: 'answer_output_missing' };
  const parsedOutputs = matchedOutputs.map((output) => ({ ...output, answers: requestUserInputAnswers(output.output) }));
  if (parsedOutputs.some((output) => output.answers === null)) return { status: 'invalid', reason: 'answer_output_invalid' };
  const answerIdentities = new Set(parsedOutputs.map((output) => JSON.stringify(output.answers)));
  if (answerIdentities.size !== 1) return { status: 'ambiguous', reason: 'answer_output_ambiguous' };
  const recovered = parsedOutputs.at(-1)!;
  return { status: 'found', answers: recovered.answers!, occurredAt: recovered.occurredAt };
}

async function scanRequestUserInputRollout(rolloutPath: string): Promise<RolloutRequestUserInputScan | null> {
  let observedThreadId: string | null = null;
  const calls: RequestUserInputCall[] = [];
  const outputs: RequestUserInputOutput[] = [];
  const lines = createInterface({ input: createReadStream(rolloutPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // 活动 rollout 的最后一行可能仍在追加；不让无关的半行阻断已完整写入的答案恢复。
        continue;
      }
      if (!isRecord(entry) || !isRecord(entry.payload)) continue;
      if (entry.type === 'session_meta' && typeof entry.payload.id === 'string' && entry.payload.id.trim()) {
        observedThreadId = entry.payload.id;
        continue;
      }
      if (entry.type !== 'response_item') continue;
      const payload = entry.payload;
      const turnId = responseItemTurnId(payload);
      if (payload.type === 'function_call' && payload.name === 'request_user_input' && typeof payload.id === 'string' && typeof payload.call_id === 'string') {
        const requestPayload = parseJsonValue(payload.arguments);
        const questions = requestUserInputQuestions(requestPayload);
        const questionIdentity = requestUserInputQuestionIdentity(requestPayload);
        if (!questions || !questionIdentity) continue;
        calls.push({
          id: payload.id,
          callId: payload.call_id,
          turnId,
          questions,
          questionIdentity,
          occurredAt: normalizedTimestamp(entry.timestamp),
        });
      } else if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
        outputs.push({
          callId: payload.call_id,
          turnId,
          output: payload.output,
          occurredAt: normalizedTimestamp(entry.timestamp),
        });
      }
    }
  } catch {
    return null;
  } finally {
    lines.close();
  }
  return { observedThreadId, calls, outputs };
}

function readableRolloutPath(candidate: string | null): string | null {
  const storedPath = candidate?.trim() ?? '';
  if (!storedPath || !isAbsolute(storedPath) || extname(storedPath).toLowerCase() !== '.jsonl') return null;
  try {
    if (lstatSync(storedPath).isSymbolicLink()) return null;
    const canonicalPath = realpathSync(storedPath);
    return statSync(canonicalPath).isFile() ? canonicalPath : null;
  } catch {
    return null;
  }
}

function requestUserInputQuestionIdentity(value: unknown): string | null {
  const questions = requestUserInputQuestions(value);
  if (!questions) return null;
  return JSON.stringify(questions.map((question) => ({ id: question.id, header: question.header, question: question.question, options: question.options ?? [] })));
}

function requestUserInputQuestions(value: unknown): CodexRolloutRequestUserInputQuestion[] | null {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length === 0 || value.questions.length > 3) return null;
  const questionIds = new Set<string>();
  const questions: CodexRolloutRequestUserInputQuestion[] = [];
  for (const rawQuestion of value.questions) {
    if (
      !isRecord(rawQuestion) ||
      typeof rawQuestion.id !== 'string' ||
      !rawQuestion.id.trim() ||
      rawQuestion.id.length > 256 ||
      typeof rawQuestion.question !== 'string' ||
      !rawQuestion.question.trim() ||
      rawQuestion.question.length > 8_000 ||
      (typeof rawQuestion.header === 'string' && rawQuestion.header.length > 512)
    )
      return null;
    if (questionIds.has(rawQuestion.id)) return null;
    const rawOptions = rawQuestion.options;
    let options: Array<{ label: string; description: string }> | null = null;
    if (rawOptions !== null && rawOptions !== undefined) {
      if (!Array.isArray(rawOptions) || rawOptions.length === 0 || rawOptions.length > 10) return null;
      const optionLabels = new Set<string>();
      options = [];
      for (const rawOption of rawOptions) {
        if (
          !isRecord(rawOption) ||
          typeof rawOption.label !== 'string' ||
          !rawOption.label.trim() ||
          rawOption.label.length > 2_000 ||
          (typeof rawOption.description === 'string' && rawOption.description.length > 8_000) ||
          optionLabels.has(rawOption.label)
        )
          return null;
        optionLabels.add(rawOption.label);
        options.push({ label: rawOption.label, description: typeof rawOption.description === 'string' ? rawOption.description : '' });
      }
    }
    questionIds.add(rawQuestion.id);
    questions.push({
      id: rawQuestion.id,
      header: typeof rawQuestion.header === 'string' && rawQuestion.header.trim() ? rawQuestion.header : rawQuestion.question,
      question: rawQuestion.question,
      options,
      isOther: options !== null && rawQuestion.isOther === true,
      isSecret: rawQuestion.isSecret === true,
      multiple: options !== null && rawQuestion.multiple === true,
    });
  }
  return questions;
}

function rolloutRequestUserInputResult(outputs: readonly RequestUserInputOutput[]): Pick<CodexRolloutRequestUserInputEvidence, 'outcome' | 'answers' | 'resolvedAt'> {
  if (outputs.length === 0) return { outcome: 'pending', answers: null, resolvedAt: null };
  const latest = outputs.at(-1)!;
  const parsedAnswers = outputs.map((output) => requestUserInputAnswers(output.output));
  if (parsedAnswers.every((answers) => answers !== null) && new Set(parsedAnswers.map((answers) => JSON.stringify(answers))).size === 1) {
    return { outcome: 'answered', answers: parsedAnswers.at(-1)!, resolvedAt: latest.occurredAt };
  }
  if (outputs.some((output) => typeof output.output === 'string' && /aborted by user/iu.test(output.output))) {
    return { outcome: 'aborted', answers: null, resolvedAt: latest.occurredAt };
  }
  return { outcome: 'resolved', answers: null, resolvedAt: latest.occurredAt };
}

function normalizedTimestamp(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function requestUserInputAnswers(value: unknown): Record<string, { answers: string[] }> | null {
  const parsed = parseJsonValue(value);
  if (!isRecord(parsed) || !isRecord(parsed.answers)) return null;
  const answers = Object.entries(parsed.answers).map(([questionId, answer]) => {
    if (!isRecord(answer) || !Array.isArray(answer.answers) || !answer.answers.every((entry) => typeof entry === 'string')) return null;
    return [questionId, { answers: answer.answers as string[] }] as const;
  });
  return answers.some((answer) => answer === null) ? null : Object.fromEntries(answers as Array<readonly [string, { answers: string[] }]>);
}

function responseItemTurnId(payload: Record<string, unknown>): string | null {
  const metadata = isRecord(payload.internal_chat_message_metadata_passthrough) ? payload.internal_chat_message_metadata_passthrough : null;
  return metadata && typeof metadata.turn_id === 'string' ? metadata.turn_id : null;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
