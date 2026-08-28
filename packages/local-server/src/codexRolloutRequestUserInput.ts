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

interface RequestUserInputCall {
  id: string;
  callId: string;
  turnId: string | null;
  questionIdentity: string;
}

interface RequestUserInputOutput {
  callId: string;
  turnId: string | null;
  output: unknown;
  occurredAt: string | null;
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
        const questionIdentity = requestUserInputQuestionIdentity(parseJsonValue(payload.arguments));
        if (!questionIdentity) continue;
        calls.push({ id: payload.id, callId: payload.call_id, turnId, questionIdentity });
      } else if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
        outputs.push({
          callId: payload.call_id,
          turnId,
          output: payload.output,
          occurredAt: typeof entry.timestamp === 'string' && !Number.isNaN(Date.parse(entry.timestamp)) ? new Date(entry.timestamp).toISOString() : null,
        });
      }
    }
  } catch {
    return { status: 'unavailable', reason: 'rollout_path_unavailable' };
  } finally {
    lines.close();
  }

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
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length === 0) return null;
  const questions = value.questions.map((question) => {
    if (!isRecord(question) || typeof question.id !== 'string' || !question.id.trim() || typeof question.question !== 'string' || !question.question.trim()) return null;
    const options = question.options === null || question.options === undefined ? [] : question.options;
    if (!Array.isArray(options)) return null;
    const normalizedOptions = options.map((option) => {
      if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim()) return null;
      return {
        label: option.label,
        description: typeof option.description === 'string' ? option.description : '',
      };
    });
    if (normalizedOptions.some((option) => option === null)) return null;
    return {
      id: question.id,
      header: typeof question.header === 'string' ? question.header : '',
      question: question.question,
      options: normalizedOptions,
    };
  });
  return questions.some((question) => question === null) ? null : JSON.stringify(questions);
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
