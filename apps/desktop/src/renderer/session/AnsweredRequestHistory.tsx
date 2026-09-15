import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { normalizeRequestQuestions, type RequestQuestion } from './PendingRequestSurface.js';
import type { NativePendingRequest } from './sessionTypes.js';
import type { NativeConversationAttachment } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { ConversationComposerAttachments } from './ConversationComposerAttachments.js';

export interface AnsweredRequestHistoryProps {
  /** 回显只需要问题和答案，不依赖同步请求的生命周期。 */
  request: Pick<NativePendingRequest, 'payload' | 'response' | 'containsSecret'>;
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
    answerSyncFailed: '答案同步失败',
    answerSyncFailedDetail: '这个问题已在其他设备上处理，Zeus 尚未收到具体回答。',
    secretAnswer: '敏感回答已提交',
    redactedAnswer: '回答已提交，历史内容已脱敏',
    region: '已回答询问',
    syncFailedRegion: '答案同步失败的询问',
    separator: '、',
    selected: '已选择',
    userChoice: '用户选择',
    answerAttachments: '回答附件',
    attachmentCount: (count: number) => `${count} 个附件`,
    imagePreview: '图片预览',
    imagePreviewDescription: '询问回答附件图片预览',
    loadingPreview: '正在加载图片…',
    previewUnavailable: '图片预览不可用。',
    closePreview: '关闭图片预览',
    openUnavailable: '当前应用版本无法安全打开这个附件。',
    openFailed: '无法打开这个附件，请确认原资源仍然可用。',
  },
  'en-US': {
    answered: 'Answered',
    answeredCount: (count: number) => `Answered ${count} questions`,
    answerSyncFailed: 'Answer sync failed',
    answerSyncFailedDetail: 'This question was resolved on another device. Zeus has not received the answer.',
    secretAnswer: 'Secret answer submitted',
    redactedAnswer: 'Answer submitted; historical content is redacted',
    region: 'Answered questions',
    syncFailedRegion: 'Question with an answer sync failure',
    separator: ', ',
    selected: 'Selected',
    userChoice: 'User choice',
    answerAttachments: 'Answer attachments',
    attachmentCount: (count: number) => `${count} attachment${count === 1 ? '' : 's'}`,
    imagePreview: 'Image preview',
    imagePreviewDescription: 'Image preview for a question answer attachment',
    loadingPreview: 'Loading image…',
    previewUnavailable: 'Image preview is unavailable.',
    closePreview: 'Close image preview',
    openUnavailable: 'This app version cannot safely open the attachment.',
    openFailed: 'The attachment could not be opened. Confirm that the original resource is still available.',
  },
} as const;

export function AnsweredRequestHistory(props: AnsweredRequestHistoryProps) {
  const copy = labels[props.language];
  const entries = answeredQuestions(props.request);
  if (entries.length === 0) return null;
  const answerUnavailable = isExternalUserInputResolution(props.request.response);
  const heading = answerUnavailable ? copy.answerSyncFailed : entries.length === 1 ? copy.answered : copy.answeredCount(entries.length);

  return (
    <article className={`session-answered-request${answerUnavailable ? ' is-answer-unavailable' : ''}`} aria-label={answerUnavailable ? copy.syncFailedRegion : copy.region}>
      <header className="session-answered-request-heading">
        {answerUnavailable ? <WarningCircle aria-hidden="true" /> : <CheckCircle aria-hidden="true" />}
        <strong>{heading}</strong>
      </header>
      <div className="session-answered-request-body">
        {answerUnavailable ? (
          <p className="session-answered-request-sync-error" role="status">
            {copy.answerSyncFailedDetail}
          </p>
        ) : null}
        {entries.map((entry, index) => {
          const selectedAnswers = new Set(entry.answers ?? []);
          const optionLabels = new Set(entry.question.options.map((option) => option.label));
          const visibleSelfAuthoredAnswers = entry.answers?.filter((answer) => !isAttachmentOnlyAnswer(answer)) ?? [];
          const customAnswers = entry.question.options.length > 0 ? visibleSelfAuthoredAnswers.filter((answer) => !optionLabels.has(answer)) : [];
          const selfAuthoredAnswers = entry.question.kind === 'freeform' ? visibleSelfAuthoredAnswers : customAnswers;
          const showSelfAuthoredRow = (!entry.question.secret && selfAuthoredAnswers.length > 0) || entry.attachments.length > 0;
          const showAnswerText = !answerUnavailable && !showSelfAuthoredRow && (entry.question.kind === 'freeform' || entry.question.secret || entry.answers === null);
          return (
            <section key={entry.question.id}>
              {/* 标题与问题相同时只保留正文，避免异步题目重复显示。 */}
              {entry.question.header !== entry.question.question ? <small>{entry.question.header || `${index + 1}`}</small> : null}
              <strong>{entry.question.question}</strong>
              {entry.question.options.length > 0 || showSelfAuthoredRow ? (
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
                  {showSelfAuthoredRow ? (
                    <li className="is-selected is-custom-answer">
                      {/* 两侧状态与完整回答内容同排，随正文和附件高度垂直居中。 */}
                      <span className="session-answered-request-option-marker" aria-hidden="true">
                        <Check weight="bold" />
                      </span>
                      <div className="session-answered-request-custom-content">
                        <small>{copy.userChoice}</small>
                        {entry.attachments.length > 0 ? (
                          <ConversationComposerAttachments attachments={entry.attachments} language={props.language} disabled={false} ariaLabel={copy.answerAttachments} className="session-answered-request-attachments" />
                        ) : null}
                        {entry.question.secret ? (
                          <p className="session-answered-request-custom-answer-text">{copy.secretAnswer}</p>
                        ) : selfAuthoredAnswers.length > 0 ? (
                          <p className="session-answered-request-custom-answer-text">{selfAuthoredAnswers.join(copy.separator)}</p>
                        ) : null}
                      </div>
                      <em>{copy.selected}</em>
                    </li>
                  ) : null}
                </ul>
              ) : null}
              {showAnswerText ? <p>{answerText(entry, copy.secretAnswer, copy.redactedAnswer, copy.separator, copy.attachmentCount)}</p> : null}
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

/** 同步询问与异步回答共用选项、自填内容及敏感内容的展示规则。 */
function answeredQuestions(request: AnsweredRequestHistoryProps['request']): AnsweredQuestion[] {
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

function isExternalUserInputResolution(response: Record<string, unknown> | null): boolean {
  return response?.type === 'external_resolution';
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

function isAttachmentOnlyAnswer(answer: string): boolean {
  return answer === '见附件' || answer === 'See attachments';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
