import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from 'react';
import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { useNativeCloseLayer } from '../ui/nativeCloseLayer.js';
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
    secretAnswer: 'Secret answer submitted',
    redactedAnswer: 'Answer submitted; historical content is redacted',
    region: 'Answered questions',
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
  const [previewAttachment, setPreviewAttachment] = useState<NativeConversationAttachment | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  if (entries.length === 0) return null;
  const heading = entries.length === 1 ? copy.answered : copy.answeredCount(entries.length);

  async function activateAttachment(attachment: NativeConversationAttachment, trigger: HTMLButtonElement): Promise<void> {
    setResourceError(null);
    if (isImageAttachment(attachment)) {
      previewTriggerRef.current = trigger;
      setPreviewAttachment(attachment);
      return;
    }
    const bridge = window.zeus?.openConversationInputResource;
    if (!bridge) {
      setResourceError(copy.openUnavailable);
      return;
    }
    try {
      const result = await bridge({ ...(attachment.localPath ? { localPath: attachment.localPath } : {}), ...(attachment.uploadRef ? { uploadRef: attachment.uploadRef } : {}) });
      if (!result.opened) setResourceError(copy.openFailed);
    } catch {
      setResourceError(copy.openFailed);
    }
  }

  function closeAttachmentPreview(): void {
    setPreviewAttachment(null);
    window.requestAnimationFrame(() => previewTriggerRef.current?.focus());
  }

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
          const visibleSelfAuthoredAnswers = entry.answers?.filter((answer) => !isAttachmentOnlyAnswer(answer)) ?? [];
          const customAnswers = entry.question.options.length > 0 ? visibleSelfAuthoredAnswers.filter((answer) => !optionLabels.has(answer)) : [];
          const selfAuthoredAnswers = entry.question.kind === 'freeform' ? visibleSelfAuthoredAnswers : customAnswers;
          const showSelfAuthoredRow = (!entry.question.secret && selfAuthoredAnswers.length > 0) || entry.attachments.length > 0;
          const showAnswerText = !showSelfAuthoredRow && (entry.question.kind === 'freeform' || entry.question.secret || entry.answers === null);
          return (
            <section key={entry.question.id}>
              <small>{entry.question.header || `${index + 1}`}</small>
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
                      <div className="session-answered-request-custom-status">
                        <span className="session-answered-request-option-marker" aria-hidden="true">
                          <Check weight="bold" />
                        </span>
                        <small>{copy.userChoice}</small>
                        <em>{copy.selected}</em>
                      </div>
                      {entry.attachments.length > 0 ? (
                        <ConversationComposerAttachments
                          attachments={entry.attachments}
                          language={props.language}
                          disabled={false}
                          ariaLabel={copy.answerAttachments}
                          className="session-answered-request-attachments"
                          onActivate={(attachment, trigger) => void activateAttachment(attachment, trigger)}
                        />
                      ) : null}
                      {entry.question.secret ? (
                        <p className="session-answered-request-custom-answer-text">{copy.secretAnswer}</p>
                      ) : selfAuthoredAnswers.length > 0 ? (
                        <p className="session-answered-request-custom-answer-text">{selfAuthoredAnswers.join(copy.separator)}</p>
                      ) : null}
                    </li>
                  ) : null}
                </ul>
              ) : null}
              {showAnswerText ? <p>{answerText(entry, copy.secretAnswer, copy.redactedAnswer, copy.separator, copy.attachmentCount)}</p> : null}
            </section>
          );
        })}
      </div>
      {resourceError ? (
        <p className="session-answered-request-resource-error" role="alert">
          {resourceError}
        </p>
      ) : null}
      {previewAttachment ? <AnsweredAttachmentPreviewDialog attachment={previewAttachment} language={props.language} onClose={closeAttachmentPreview} /> : null}
    </article>
  );
}

function AnsweredAttachmentPreviewDialog(props: { attachment: NativeConversationAttachment; language: SessionUiLanguage; onClose: () => void }) {
  const copy = labels[props.language];
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewId = useId();
  const localPath = props.attachment.localPath;
  const uploadRef = props.attachment.uploadRef;

  useNativeCloseLayer(true, closePreview);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open || typeof dialog.showModal !== 'function') return;
    dialog.showModal();
  }, []);

  useEffect(() => {
    let active = true;
    const bridge = window.zeus?.getConversationResourcePreview;
    setPreviewUrl('');
    setPreviewLoading(true);
    setPreviewFailed(false);
    if (!bridge) {
      setPreviewLoading(false);
      setPreviewFailed(true);
      return () => {
        active = false;
      };
    }
    void bridge({ ...(localPath ? { localPath } : {}), ...(uploadRef ? { uploadRef } : {}) })
      .then((preview) => {
        if (!active) return;
        if (preview?.previewUrl) setPreviewUrl(preview.previewUrl);
        else setPreviewFailed(true);
      })
      .catch(() => {
        if (active) setPreviewFailed(true);
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [localPath, uploadRef]);

  function closePreview(): void {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      dialog.close();
      return;
    }
    props.onClose();
  }

  function handleDialogCancel(event: SyntheticEvent<HTMLDialogElement, Event>): void {
    event.preventDefault();
    closePreview();
  }

  function handleDialogPointerDown(event: ReactMouseEvent<HTMLDialogElement>): void {
    if (event.currentTarget === event.target) closePreview();
  }

  return (
    <dialog
      ref={dialogRef}
      className="session-answered-request-preview-dialog"
      aria-labelledby={`${previewId}-title`}
      aria-describedby={`${previewId}-description`}
      onClose={props.onClose}
      onCancel={handleDialogCancel}
      onPointerDown={handleDialogPointerDown}
    >
      <div className="session-answered-request-preview-sheet">
        <header>
          <span>
            <strong id={`${previewId}-title`}>{props.attachment.name || copy.imagePreview}</strong>
            <small id={`${previewId}-description`}>{copy.imagePreviewDescription}</small>
          </span>
          <button type="button" onClick={closePreview} aria-label={copy.closePreview}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="session-answered-request-preview-stage">
          {previewLoading ? <p role="status">{copy.loadingPreview}</p> : previewUrl && !previewFailed ? <img src={previewUrl} alt={props.attachment.name} onError={() => setPreviewFailed(true)} /> : <p>{copy.previewUnavailable}</p>}
        </div>
      </div>
    </dialog>
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

function isAttachmentOnlyAnswer(answer: string): boolean {
  return answer === '见附件' || answer === 'See attachments';
}

function isImageAttachment(attachment: NativeConversationAttachment): boolean {
  return attachment.kind === 'image' || (!attachment.kind && attachment.mime.startsWith('image/'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
