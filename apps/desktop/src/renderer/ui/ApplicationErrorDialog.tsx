import { useEffect, useRef, useState } from 'react';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { Button } from './Button.js';
import { ModalPortal } from './ModalPortal.js';

export type ApplicationErrorLanguage = 'zh-CN' | 'en';

export interface ApplicationErrorOptions {
  language?: ApplicationErrorLanguage;
  title?: string;
  summary?: string;
  source?: string;
  details?: string;
  occurredAt?: string;
  primaryAction?: {
    label: string;
    run: () => void;
  };
}

interface ApplicationErrorEntry {
  id: number;
  language: ApplicationErrorLanguage;
  title: string;
  summary: string;
  details: string;
  primaryAction?: ApplicationErrorOptions['primaryAction'];
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
    summary: 'Zeus 没有完成这项操作。请查看详情后重试，或关闭弹窗返回当前工作面。',
    details: '查看详情',
    hideDetails: '收起详情',
    close: '关闭',
    detailTitle: '错误详情',
    occurredAt: '发生时间',
    source: '错误来源',
    originalMessage: '原始信息',
    unknown: '没有可用的错误详情。',
  },
  en: {
    title: 'Operation not completed',
    summary: 'Zeus could not complete this operation. Review the details and try again, or close this dialog to return to your work.',
    details: 'View Details',
    hideDetails: 'Hide Details',
    close: 'Close',
    detailTitle: 'Error details',
    occurredAt: 'Occurred at',
    source: 'Source',
    originalMessage: 'Original message',
    unknown: 'No error details are available.',
  },
} as const;

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

function detailText(error: unknown, options: ApplicationErrorOptions, language: ApplicationErrorLanguage): string {
  const copy = copyByLanguage[language];
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const originalMessage = options.details?.trim() || errorMessage(error, language);
  return redactDetails([`${copy.occurredAt}: ${occurredAt}`, options.source?.trim() ? `${copy.source}: ${options.source.trim()}` : '', `${copy.originalMessage}: ${originalMessage}`].filter(Boolean).join('\n'));
}

/**
 * 全应用统一错误出口：业务组件只上报失败事实，不再自行决定错误卡片、横条或提示位置。
 */
export function reportApplicationError(error: unknown, options: ApplicationErrorOptions = {}): void {
  const language = options.language ?? 'zh-CN';
  const copy = copyByLanguage[language];
  const details = detailText(error, options, language);
  const entry: ApplicationErrorEntry = {
    id: nextErrorId,
    language,
    title: options.title?.trim() || copy.title,
    summary: options.summary?.trim() || copy.summary,
    details,
    ...(options.primaryAction ? { primaryAction: options.primaryAction } : {}),
  };
  nextErrorId += 1;

  const duplicate = queue.some((candidate) => candidate.title === entry.title && candidate.details === entry.details);
  if (duplicate) return;
  queue = [...queue, entry];
  notifyListeners();
}

/** 同一个失败值只上报一次；清空后再次出现同样的错误仍会重新弹窗。 */
export function useApplicationErrorDialog(error: unknown, options: ApplicationErrorOptions = {}): void {
  const previousErrorRef = useRef<unknown>(undefined);
  const language = options.language;
  const title = options.title;
  const summary = options.summary;
  const source = options.source;
  const details = options.details;
  const occurredAt = options.occurredAt;
  const primaryAction = options.primaryAction;

  useEffect(() => {
    if (error === null || error === undefined || error === '') {
      previousErrorRef.current = error;
      return;
    }
    if (Object.is(previousErrorRef.current, error)) return;
    previousErrorRef.current = error;
    reportApplicationError(error, {
      ...(language ? { language } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(source ? { source } : {}),
      ...(details ? { details } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      ...(primaryAction ? { primaryAction } : {}),
    });
  }, [details, error, language, occurredAt, primaryAction, source, summary, title]);
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

  function runPrimaryAction(): void {
    const action = current?.primaryAction;
    dismissCurrentError();
    action?.run();
  }

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
          {current.primaryAction ? (
            <>
              <Button variant="secondary" size="regular" onClick={dismissCurrentError}>
                {copy.close}
              </Button>
              <Button variant="primary" size="regular" onClick={runPrimaryAction}>
                {current.primaryAction.label}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="regular" onClick={dismissCurrentError} autoFocus>
              {copy.close}
            </Button>
          )}
        </footer>
      </section>
    </ModalPortal>
  );
}
