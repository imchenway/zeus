import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { normalizeRequestQuestions, type RequestQuestion } from './PendingRequestSurface.js';
import type { NativePendingRequest } from './sessionTypes.js';
import type { NativeConversationAttachment } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { ConversationComposerAttachments } from './ConversationComposerAttachments.js';

export interface AnsweredRequestHistoryProps {
  request: NativePendingRequest;
  language: SessionUiLanguage;
}

interface AnsweredQuestion {
  question: RequestQuestion;
  answers: string[] | null;
  attachments: NativeConversationAttachment[];
}

const labels = {
  'zh-CN': {
    answered: '已回答',
    answeredCount: (count: number) => `已回答 ${count} 个问题`,
    secretAnswer: '敏感回答已提交',
    redactedAnswer: '回答已提交，历史内容已脱敏',
    region: '已回答询问',
    separator: '、',
    attachmentCount: (count: number) => `${count} 个附件`,
  },
  'en-US': {
    answered: 'Answered',
    answeredCount: (count: number) => `Answered ${count} questions`,
    secretAnswer: 'Secret answer submitted',
    redactedAnswer: 'Answer submitted; historical content is redacted',
    region: 'Answered questions',
    separator: ', ',
    attachmentCount: (count: number) => `${count} attachment${count === 1 ? '' : 's'}`,
  },
} as const;

export function AnsweredRequestHistory(props: AnsweredRequestHistoryProps) {
  const copy = labels[props.language];
  const entries = answeredQuestions(props.request);
  if (entries.length === 0) return null;
  const first = entries[0]!;
  const summaryAnswer = answerText(first, copy.secretAnswer, copy.redactedAnswer, copy.separator, copy.attachmentCount);
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
              <p>{answerText(entry, copy.secretAnswer, copy.redactedAnswer, copy.separator, copy.attachmentCount)}</p>
              {entry.attachments.length ? <ConversationComposerAttachments attachments={entry.attachments} language={props.language} disabled={false} className="session-answered-request-attachments" /> : null}
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
  const visibleAttachments = request.containsSecret ? {} : canonicalAnswerAttachments(request.response);
  return questions.map((question) => ({
    question,
    answers: question.secret ? null : (visibleAnswers[question.id] ?? null),
    attachments: question.secret ? [] : (visibleAttachments[question.id] ?? []),
  }));
}

function canonicalAnswerAttachments(response: Record<string, unknown> | null): Record<string, NativeConversationAttachment[]> {
  if (!response || !isRecord(response.answerAttachments)) return {};
  return Object.fromEntries(
    Object.entries(response.answerAttachments).flatMap(([questionId, value]) => {
      if (!Array.isArray(value)) return [];
      const attachments = value.flatMap((entry) => normalizeAnswerAttachment(entry));
      return attachments.length > 0 ? [[questionId, attachments]] : [];
    }),
  );
}

function normalizeAnswerAttachment(value: unknown): NativeConversationAttachment[] {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.mime !== 'string' || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) return [];
  const identity = typeof value.localPath === 'string' && value.localPath ? { localPath: value.localPath } : typeof value.uploadRef === 'string' && value.uploadRef ? { uploadRef: value.uploadRef } : null;
  if (!identity) return [];
  const kind = value.kind === 'image' || value.kind === 'file' || value.kind === 'directory' || value.kind === 'pasted_text' ? value.kind : undefined;
  const source = value.source === 'picker' || value.source === 'paste' || value.source === 'drop' ? value.source : undefined;
  const characterCount = typeof value.characterCount === 'number' && Number.isSafeInteger(value.characterCount) && value.characterCount >= 0 ? value.characterCount : undefined;
  return [{ name: value.name, mime: value.mime, size: value.size, ...identity, ...(kind ? { kind } : {}), ...(source ? { source } : {}), ...(characterCount !== undefined ? { characterCount } : {}) }];
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

function answerText(entry: AnsweredQuestion, secretAnswer: string, redactedAnswer: string, separator: string, attachmentCount: (count: number) => string): string {
  if (entry.question.secret) return secretAnswer;
  if (entry.attachments.length > 0 && (!entry.answers?.length || (entry.answers.length === 1 && (entry.answers[0] === '见附件' || entry.answers[0] === 'See attachments')))) return attachmentCount(entry.attachments.length);
  return entry.answers?.length ? entry.answers.join(separator) : redactedAnswer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
