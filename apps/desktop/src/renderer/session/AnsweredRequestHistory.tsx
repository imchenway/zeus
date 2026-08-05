import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { normalizeRequestQuestions, type RequestQuestion } from './PendingRequestSurface.js';
import type { NativePendingRequest } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

export interface AnsweredRequestHistoryProps {
  request: NativePendingRequest;
  language: SessionUiLanguage;
}

interface AnsweredQuestion {
  question: RequestQuestion;
  answers: string[] | null;
}

const labels = {
  'zh-CN': {
    answered: '已回答',
    answeredCount: (count: number) => `已回答 ${count} 个问题`,
    secretAnswer: '敏感回答已提交',
    redactedAnswer: '回答已提交，历史内容已脱敏',
    region: '已回答询问',
    separator: '、',
  },
  'en-US': {
    answered: 'Answered',
    answeredCount: (count: number) => `Answered ${count} questions`,
    secretAnswer: 'Secret answer submitted',
    redactedAnswer: 'Answer submitted; historical content is redacted',
    region: 'Answered questions',
    separator: ', ',
  },
} as const;

export function AnsweredRequestHistory(props: AnsweredRequestHistoryProps) {
  const copy = labels[props.language];
  const entries = answeredQuestions(props.request);
  if (entries.length === 0) return null;
  const first = entries[0]!;
  const summaryAnswer = answerText(first, copy.secretAnswer, copy.redactedAnswer, copy.separator);
  const summaryPrefix = entries.length === 1 ? copy.answered : copy.answeredCount(entries.length);

  return (
    <article className="session-answered-request" aria-label={copy.region}>
      <details>
        <summary>
          <CheckCircle aria-hidden="true" />
          <span className="session-answered-request-summary">
            <span>{summaryPrefix}</span>
            <strong>{first.question.question}</strong>
            <span>{summaryAnswer}</span>
          </span>
          <CaretDown className="session-answered-request-caret" aria-hidden="true" />
        </summary>
        <div className="session-answered-request-body">
          {entries.map((entry, index) => (
            <section key={entry.question.id}>
              <small>{entry.question.header || `${index + 1}`}</small>
              <strong>{entry.question.question}</strong>
              <p>{answerText(entry, copy.secretAnswer, copy.redactedAnswer, copy.separator)}</p>
            </section>
          ))}
        </div>
      </details>
    </article>
  );
}

export function isAnsweredUserInputRequest(request: NativePendingRequest): boolean {
  return request.status === 'resolved' && request.response !== null && (request.type === 'userInput' || request.type === 'request_user_input') && normalizeRequestQuestions(request).length > 0;
}

function answeredQuestions(request: NativePendingRequest): AnsweredQuestion[] {
  const questions = normalizeRequestQuestions(request);
  const visibleAnswers = request.containsSecret ? nonSecretAnswers(request.response) : canonicalAnswers(request.response);
  return questions.map((question) => ({
    question,
    answers: question.secret ? null : (visibleAnswers[question.id] ?? null),
  }));
}

function canonicalAnswers(response: Record<string, unknown> | null): Record<string, string[]> {
  if (!response || !isRecord(response.answers)) return {};
  return answerMap(response.answers);
}

function nonSecretAnswers(response: Record<string, unknown> | null): Record<string, string[]> {
  if (!response || !isRecord(response.publicAnswers)) return {};
  return Object.fromEntries(Object.entries(response.publicAnswers).flatMap(([questionId, value]) => (Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [[questionId, value]] : [])));
}

function answerMap(value: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([questionId, answer]) => {
      if (!isRecord(answer) || !Array.isArray(answer.answers) || !answer.answers.every((entry) => typeof entry === 'string')) return [];
      return [[questionId, answer.answers]];
    }),
  );
}

function answerText(entry: AnsweredQuestion, secretAnswer: string, redactedAnswer: string, separator: string): string {
  if (entry.question.secret) return secretAnswer;
  return entry.answers?.length ? entry.answers.join(separator) : redactedAnswer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
