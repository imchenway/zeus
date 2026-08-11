import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check';
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
    selected: '已选择',
    userChoice: '用户选择',
  },
  'en-US': {
    answered: 'Answered',
    answeredCount: (count: number) => `Answered ${count} questions`,
    secretAnswer: 'Secret answer submitted',
    redactedAnswer: 'Answer submitted; historical content is redacted',
    region: 'Answered questions',
    separator: ', ',
    selected: 'Selected',
    userChoice: 'User choice',
  },
} as const;

export function AnsweredRequestHistory(props: AnsweredRequestHistoryProps) {
  const copy = labels[props.language];
  const entries = answeredQuestions(props.request);
  if (entries.length === 0) return null;
  const heading = entries.length === 1 ? copy.answered : copy.answeredCount(entries.length);

  return (
    <article className="session-answered-request" aria-label={copy.region}>
      <header className="session-answered-request-heading">
        <CheckCircle aria-hidden="true" />
        <strong>{heading}</strong>
      </header>
      <div className="session-answered-request-body">
        {entries.map((entry, index) => {
          const selectedAnswers = new Set(entry.answers ?? []);
          const optionLabels = new Set(entry.question.options.map((option) => option.label));
          const customAnswers = entry.answers?.filter((answer) => !optionLabels.has(answer)) ?? [];
          const showAnswerText = entry.question.kind === 'freeform' || entry.question.secret || entry.answers === null;
          return (
            <section key={entry.question.id}>
              <small>{entry.question.header || `${index + 1}`}</small>
              <strong>{entry.question.question}</strong>
              {entry.question.options.length > 0 ? (
                <ul className="session-answered-request-options">
                  {entry.question.options.map((option) => {
                    const selected = !entry.question.secret && selectedAnswers.has(option.label);
                    return (
                      <li key={option.label} className={selected ? 'is-selected' : undefined}>
                        <span className="session-answered-request-option-marker" aria-hidden="true">
                          {selected ? <Check weight="bold" /> : null}
                        </span>
                        <span>
                          <strong>{option.label}</strong>
                          {option.description ? <small>{option.description}</small> : null}
                        </span>
                        {selected ? <em>{copy.selected}</em> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {showAnswerText ? <p>{answerText(entry, copy.secretAnswer, copy.redactedAnswer, copy.separator)}</p> : null}
              {customAnswers.length > 0 ? (
                <p className="session-answered-request-custom-answer">
                  <small>{copy.userChoice}</small>
                  <span>{customAnswers.join(copy.separator)}</span>
                </p>
              ) : null}
            </section>
          );
        })}
      </div>
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
