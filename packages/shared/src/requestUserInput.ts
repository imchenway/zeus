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

export type CanonicalRequestUserInputQuestionsResult =
  | { ok: true; questions: CanonicalRequestUserInputQuestion[] }
  | {
      ok: false;
      message: string;
    };

/**
 * 只读取提交回答所必需的问题结构；信封元数据由运行内核自行演进，不能成为界面显示门槛。
 * 未识别字段一律忽略，避免 Provider 增加元数据后把已经落库的问题藏掉。
 */
export function parseCanonicalRequestUserInputQuestions(payload: unknown): CanonicalRequestUserInputQuestionsResult {
    if (!isRecord(payload) || !Array.isArray(payload.questions) || payload.questions.length === 0) {
    return invalidQuestions('The pending request does not contain a complete canonical question set.');
  }

  const questions: CanonicalRequestUserInputQuestion[] = [];
  const questionIds = new Set<string>();
  for (const rawQuestion of payload.questions) {
    if (!isRecord(rawQuestion)) return invalidQuestions('Every request_user_input question must be an object.');
    const id = nonEmptyString(rawQuestion.id);
    const question = nonEmptyString(rawQuestion.question);
      if (!id || !question) return invalidQuestions('Every request_user_input question requires non-empty id and question fields.');
    if (questionIds.has(id)) return invalidQuestions('request_user_input question ids must be unique.');
      if (typeof rawQuestion.isSecret !== 'boolean') return invalidQuestions('Every request_user_input question requires a boolean isSecret field.');
      const header = nonEmptyString(rawQuestion.header) ?? question;

    let options: CanonicalRequestUserInputOption[] | null;
    if (rawQuestion.options === null) {
      options = null;
    } else if (Array.isArray(rawQuestion.options) && rawQuestion.options.length > 0) {
      options = [];
      const optionLabels = new Set<string>();
      for (const rawOption of rawQuestion.options) {
        if (!isRecord(rawOption)) return invalidQuestions(`Question ${id} contains an invalid option.`);
        const label = nonEmptyString(rawOption.label);
          if (!label) return invalidQuestions(`Question ${id} contains an invalid option label.`);
        if (optionLabels.has(label)) return invalidQuestions(`Question ${id} option labels must be unique.`);
        optionLabels.add(label);
          options.push({label, description: typeof rawOption.description === 'string' ? rawOption.description : ''});
      }
    } else {
      return invalidQuestions(`Question ${id} options must be null or a non-empty canonical option array.`);
    }

      const isOther = rawQuestion.isOther === true;
    const multiple = rawQuestion.multiple === true;
      if (options === null && (isOther || multiple)) {
      return invalidQuestions(`Freeform question ${id} cannot enable Other or multiple selection.`);
    }
    questionIds.add(id);
    questions.push({
      id,
      header,
      question,
      options,
        isOther,
      isSecret: rawQuestion.isSecret,
      multiple,
    });
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
