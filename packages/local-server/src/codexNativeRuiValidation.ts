export interface CanonicalRequestUserInputOption {
  label: string;
  description: string;
}

export interface CanonicalRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: CanonicalRequestUserInputOption[] | null;
  isOther: boolean;
  isSecret: boolean;
  multiple: boolean;
}

export type CanonicalRequestUserInputQuestionsResult = { ok: true; questions: CanonicalRequestUserInputQuestion[] } | { ok: false; message: string };

/**
 * 只接受 Codex 0.144 app-server request_user_input 的完整 canonical envelope。
 * `multiple` 是 Zeus 明确支持的可选扩展；其余别名不会被升级为权威字段。
 */
export function parseCanonicalRequestUserInputQuestions(payload: unknown): CanonicalRequestUserInputQuestionsResult {
  const envelopeKeys = ['threadId', 'turnId', 'itemId', 'questions', 'autoResolutionMs'];
  if (!isRecord(payload) || Object.keys(payload).length !== envelopeKeys.length || Object.keys(payload).some((key) => !envelopeKeys.includes(key))) {
    return invalidQuestions('The pending request does not contain the exact canonical request_user_input envelope.');
  }
  if (!nonEmptyString(payload.threadId) || !nonEmptyString(payload.turnId) || !nonEmptyString(payload.itemId)) {
    return invalidQuestions('The canonical request_user_input envelope requires non-empty threadId, turnId, and itemId fields.');
  }
  if (payload.autoResolutionMs !== null && (typeof payload.autoResolutionMs !== 'number' || !Number.isFinite(payload.autoResolutionMs) || payload.autoResolutionMs < 0)) {
    return invalidQuestions('The canonical request_user_input autoResolutionMs must be null or a finite nonnegative number.');
  }
  if (!Array.isArray(payload.questions) || payload.questions.length === 0) {
    return invalidQuestions('The pending request does not contain a complete canonical question set.');
  }

  const questions: CanonicalRequestUserInputQuestion[] = [];
  const questionIds = new Set<string>();
  for (const rawQuestion of payload.questions) {
    if (!isRecord(rawQuestion)) return invalidQuestions('Every request_user_input question must be an object.');
    const id = nonEmptyString(rawQuestion.id);
    const header = nonEmptyString(rawQuestion.header);
    const question = nonEmptyString(rawQuestion.question);
    if (!id || !header || !question) return invalidQuestions('Every request_user_input question requires non-empty id, header, and question fields.');
    if (questionIds.has(id)) return invalidQuestions('request_user_input question ids must be unique.');
    if (typeof rawQuestion.isOther !== 'boolean' || typeof rawQuestion.isSecret !== 'boolean') {
      return invalidQuestions('Every request_user_input question requires boolean isOther and isSecret fields.');
    }
    if (rawQuestion.multiple !== undefined && typeof rawQuestion.multiple !== 'boolean') {
      return invalidQuestions('The optional request_user_input multiple field must be boolean.');
    }

    let options: CanonicalRequestUserInputOption[] | null;
    if (rawQuestion.options === null) {
      options = null;
    } else if (Array.isArray(rawQuestion.options) && rawQuestion.options.length > 0) {
      options = [];
      const optionLabels = new Set<string>();
      for (const rawOption of rawQuestion.options) {
        if (!isRecord(rawOption)) return invalidQuestions(`Question ${id} contains an invalid option.`);
        const label = nonEmptyString(rawOption.label);
        if (!label || typeof rawOption.description !== 'string') return invalidQuestions(`Question ${id} contains an invalid option label or description.`);
        if (optionLabels.has(label)) return invalidQuestions(`Question ${id} option labels must be unique.`);
        optionLabels.add(label);
        options.push({ label, description: rawOption.description });
      }
    } else {
      return invalidQuestions(`Question ${id} options must be null or a non-empty canonical option array.`);
    }

    const multiple = rawQuestion.multiple === true;
    if (options === null && (rawQuestion.isOther || multiple)) {
      return invalidQuestions(`Freeform question ${id} cannot enable Other or multiple selection.`);
    }
    questionIds.add(id);
    questions.push({ id, header, question, options, isOther: rawQuestion.isOther, isSecret: rawQuestion.isSecret, multiple });
  }
  return { ok: true, questions };
}

export function validateCanonicalRequestUserInputAnswers(payload: unknown, answers: unknown): string | null {
  const parsed = parseCanonicalRequestUserInputQuestions(payload);
  if (!parsed.ok) return parsed.message;
  if (!isRecord(answers)) return 'request_user_input answers must be an object.';

  const answerIds = Object.keys(answers);
    // Codex App 将关闭、Escape、跳过和自动解决统一编码为空 answers；非空回答仍必须完整。
    if (answerIds.length === 0) return null;
  const questionIds = parsed.questions.map((question) => question.id);
  if (answerIds.length !== questionIds.length || answerIds.some((id) => !questionIds.includes(id))) {
    return 'request_user_input answer ids must exactly match the canonical question ids.';
  }

  for (const question of parsed.questions) {
    const rawAnswer = answers[question.id];
    if (!isRecord(rawAnswer) || !Array.isArray(rawAnswer.answers) || rawAnswer.answers.length === 0 || rawAnswer.answers.some((value) => typeof value !== 'string' || !value.trim())) {
      return `Question ${question.id} requires at least one non-empty answer.`;
    }
    const values = rawAnswer.answers as string[];
    if (new Set(values).size !== values.length) return `Question ${question.id} answers must be unique.`;
    if ((!question.multiple || question.options === null) && values.length !== 1) return `Question ${question.id} requires a single answer.`;
    if (question.options === null) continue;

    const optionLabels = new Set(question.options.map((option) => option.label));
    const otherValues = values.filter((value) => !optionLabels.has(value));
    if (!question.isOther && otherValues.length > 0) return `Question ${question.id} answer must be an advertised option.`;
    if (question.isOther && otherValues.length > 1) return `Question ${question.id} may contain at most one custom Other answer.`;
  }
  return null;
}

function invalidQuestions(message: string): CanonicalRequestUserInputQuestionsResult {
  return { ok: false, message };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
