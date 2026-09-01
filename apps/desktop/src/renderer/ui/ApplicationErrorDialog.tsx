import { useEffect, useRef, useState } from 'react';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { Button } from './Button.js';
import { ModalPortal } from './ModalPortal.js';

export type ApplicationErrorLanguage = 'zh-CN' | 'en';

export interface ApplicationErrorOptions {
  language?: ApplicationErrorLanguage;
}

interface ApplicationErrorEntry {
  id: number;
  language: ApplicationErrorLanguage;
  title: string;
  summary: string;
  details: string;
  dedupeKey: string;
}

const listeners = new Set<() => void>();
let queue: ApplicationErrorEntry[] = [];
let nextErrorId = 1;

const secretPatterns: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已脱敏]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[已脱敏]'],
  [/\b(api[_-]?key|token|password|secret)\s*[:=]\s*([^\s,;]+)/gi, '$1=[已脱敏]'],
  [/([?&](?:access_token|api_key|token|password|secret)=)[^&\s]+/gi, '$1[已脱敏]'],
];

const copyByLanguage = {
  'zh-CN': {
    title: '操作未完成',
    summary: 'Zeus 没有完成这项操作。可查看详情确认真实原因，关闭后当前工作面会保留。',
    unavailable: '当前操作未完成，请稍后重试。',
    unknown: '未知错误。',
    details: '查看详情',
    hideDetails: '收起详情',
    close: '关闭',
    detailTitle: '错误详情',
    occurredAt: '发生时间',
    originalMessage: '原始信息',
  },
  en: {
    title: 'Operation not completed',
    summary: 'Zeus did not complete this operation. Review the actual cause in Details; closing keeps the current workspace intact.',
    unavailable: 'The current operation did not complete. Please try again.',
    unknown: 'Unknown error.',
    details: 'View Details',
    hideDetails: 'Hide Details',
    close: 'Close',
    detailTitle: 'Error details',
    occurredAt: 'Occurred at',
    originalMessage: 'Original message',
  },
} as const;

const visibleCopyByCode: Readonly<Record<string, Readonly<Record<ApplicationErrorLanguage, string>>>> = {
  ZEUS_CODEX_LOGIN_REQUIRED: {
    'zh-CN': 'Zeus 专属 Codex 尚未登录。请先前往“设置 > AI CLI / Runtime”完成登录，再重试。',
    en: 'The dedicated Codex runtime for Zeus is not signed in. Sign in under Settings > AI CLI / Runtime, then try again.',
  },
  ZEUS_UNIFIED_QUEUE_HEAD_FAILED: {
    'zh-CN': '消息已保存，但后台派发未完成。请点击“重新恢复”进行权威核对；不要重复发送同一消息。',
    en: 'Your message was saved, but background dispatch did not complete. Select Restore again to reconcile the authoritative state; do not send the same message again.',
  },
  ZEUS_UNIFIED_QUEUE_SCHEDULER_FAILED: {
    'zh-CN': '消息已保存，但队列调度未完成。请点击“重新恢复”进行权威核对；不要重复发送同一消息。',
    en: 'Your message was saved, but queue scheduling did not complete. Select Restore again to reconcile the authoritative state; do not send the same message again.',
  },
  ZEUS_CONTEXT_MODEL_WINDOW_UNAVAILABLE: {
    'zh-CN': 'Codex 模型能力尚未就绪，消息尚未发送。请重新连接 Codex，再逐条重试；系统不会自动重发。',
    en: 'Codex model capabilities are not ready, so the message was not sent. Reconnect Codex, then retry messages individually; Zeus will not resend them automatically.',
  },
};

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function redactDetails(value: string): string {
  return secretPatterns.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), value).trim();
}

function errorMessage(error: unknown, language: ApplicationErrorLanguage): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return copyByLanguage[language].unknown;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { code?: unknown; error?: unknown };
  const apiErrorCode = typeof value.error === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(value.error.trim()) ? value.error : null;
  const candidate = typeof value.code === 'string' ? value.code : apiErrorCode;
  return candidate?.trim() || null;
}

export function formatVisibleApplicationError(error: unknown, language: ApplicationErrorLanguage = 'zh-CN'): string {
  const code = errorCode(error);
  if (code && visibleCopyByCode[code]) return visibleCopyByCode[code][language];
  return copyByLanguage[language].unavailable;
}

export function VisibleApplicationError(props: { error: unknown; language?: ApplicationErrorLanguage; className?: string }) {
  return <span className={props.className}>{formatVisibleApplicationError(props.error, props.language)}</span>;
}

/** 全应用统一错误出口：摘要保持稳定，脱敏后的真实错误码和消息进入可展开详情。 */
export function reportApplicationError(error: unknown, options: ApplicationErrorOptions = {}): void {
  const language = options.language ?? 'zh-CN';
  const copy = copyByLanguage[language];
  const code = errorCode(error);
  const message = errorMessage(error, language).replace(/\s+/gu, ' ').trim() || copy.unknown;
  const original = code && message !== code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
  const detailsBody = `${copy.originalMessage}: ${original}`;
  const details = redactDetails(`${copy.occurredAt}: ${new Date().toISOString()}\n${detailsBody}`);
  const entry: ApplicationErrorEntry = {
    id: nextErrorId++,
    language,
    title: copy.title,
    summary: code && visibleCopyByCode[code] ? visibleCopyByCode[code][language] : copy.summary,
    details,
    dedupeKey: redactDetails(original),
  };
  const duplicate = queue.some((candidate) => candidate.language === entry.language && candidate.dedupeKey === entry.dedupeKey);
  if (!duplicate) {
    queue = [...queue, entry];
    notifyListeners();
  }
  console.error('[Zeus runtime]', details);
  window.zeus?.reportRendererRuntimeError?.(details);
}

/** 同一个失败值只上报一次；清空后再次出现同样的错误仍会重新弹窗。 */
export function useApplicationErrorDialog(error: unknown, options: ApplicationErrorOptions = {}): void {
  const previousErrorRef = useRef<unknown>(undefined);
  const language = options.language;
  useEffect(() => {
    if (error === null || error === undefined || error === '') {
      previousErrorRef.current = error;
      return;
    }
    if (Object.is(previousErrorRef.current, error)) return;
    previousErrorRef.current = error;
    reportApplicationError(error, language ? { language } : {});
  }, [error, language]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function dismissCurrentError(): void {
  if (queue.length === 0) return;
  queue = queue.slice(1);
  notifyListeners();
}

export function ApplicationErrorDialogHost(props: { language: ApplicationErrorLanguage }) {
  const [, forceRender] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const current = queue[0];
  useEffect(() => subscribe(() => forceRender((value) => value + 1)), []);
  useEffect(() => setDetailsOpen(false), [current?.id]);
  if (!current) return null;
  const copy = copyByLanguage[current.language ?? props.language];
  return (
    <ModalPortal rootClassName="application-error-dialog-portal-root" backdropClassName="application-error-dialog-backdrop" onDismiss={dismissCurrentError}>
      <section className="application-error-dialog zeus-solid-form-surface" role="alertdialog" aria-modal="true" aria-labelledby="application-error-dialog-title" aria-describedby="application-error-dialog-summary">
        <div className="application-error-dialog-icon" aria-hidden="true">
          <WarningCircle weight="fill" />
        </div>
        <div className="application-error-dialog-content">
          <header>
            <strong id="application-error-dialog-title">{current.title}</strong>
            <p id="application-error-dialog-summary">{current.summary}</p>
          </header>
          {detailsOpen ? (
            <section className="application-error-dialog-details" aria-labelledby="application-error-dialog-details-title">
              <strong id="application-error-dialog-details-title">{copy.detailTitle}</strong>
              <pre data-zeus-selectable="text">{current.details}</pre>
            </section>
          ) : null}
        </div>
        <footer>
          <Button variant="secondary" size="regular" onClick={() => setDetailsOpen((open) => !open)} aria-expanded={detailsOpen} aria-controls="application-error-dialog-details-title">
            {detailsOpen ? copy.hideDetails : copy.details}
          </Button>
          <Button variant="primary" size="regular" onClick={dismissCurrentError} autoFocus>
            {copy.close}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}
