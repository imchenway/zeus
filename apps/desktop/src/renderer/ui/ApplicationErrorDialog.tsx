import { useEffect, useRef, useState } from 'react';
import { Button } from './Button.js';
import { ModalPortal } from './ModalPortal.js';

export type ApplicationErrorLanguage = 'zh-CN' | 'en';

export interface ApplicationErrorOptions {
  language?: ApplicationErrorLanguage;
  primaryAction?: {
    label: string;
    run: () => void;
  };
}

interface ApplicationErrorEntry {
  language: ApplicationErrorLanguage;
  visibleText: string;
  primaryAction?: ApplicationErrorOptions['primaryAction'];
}

const listeners = new Set<() => void>();
let queue: ApplicationErrorEntry[] = [];

const secretPatterns: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已脱敏]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[已脱敏]'],
  [/\b(api[_-]?key|token|password|secret)\s*[:=]\s*([^\s,;]+)/gi, '$1=[已脱敏]'],
  [/([?&](?:access_token|api_key|token|password|secret)=)[^&\s]+/gi, '$1[已脱敏]'],
];

const copyByLanguage = {
  'zh-CN': {
    close: '关闭',
    unknown: '未知错误。',
  },
  en: {
    close: 'Close',
    unknown: 'Unknown error.',
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

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { code?: unknown; error?: unknown };
  const apiErrorCode = typeof value.error === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(value.error.trim()) ? value.error : null;
  const candidate = typeof value.code === 'string' ? value.code : apiErrorCode;
  return candidate?.trim() || null;
}

/** 全应用唯一的可见错误格式：错误码与原始消息合成一行，堆栈和诊断元数据不进入 DOM。 */
export function formatVisibleApplicationError(error: unknown, language: ApplicationErrorLanguage = 'zh-CN'): string {
  const code = errorCode(error);
  const message = errorMessage(error, language).replace(/\s+/gu, ' ').trim() || copyByLanguage[language].unknown;
  const text = code && message !== code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
  return redactDetails(text);
}

export function VisibleApplicationError(props: { error: unknown; language?: ApplicationErrorLanguage; className?: string }) {
  return (
    <code className={props.className} data-zeus-selectable="text">
      {formatVisibleApplicationError(props.error, props.language)}
    </code>
  );
}

/**
 * 全应用统一错误出口：业务组件只上报失败事实，不再自行决定错误卡片、横条或提示位置。
 */
export function reportApplicationError(error: unknown, options: ApplicationErrorOptions = {}): void {
  const language = options.language ?? 'zh-CN';
  const entry: ApplicationErrorEntry = {
    language,
    visibleText: formatVisibleApplicationError(error, language),
    ...(options.primaryAction ? { primaryAction: options.primaryAction } : {}),
  };

  const duplicate = queue.some((candidate) => candidate.visibleText === entry.visibleText);
  if (duplicate) return;
  queue = [...queue, entry];
  notifyListeners();
}

/** 同一个失败值只上报一次；清空后再次出现同样的错误仍会重新弹窗。 */
export function useApplicationErrorDialog(error: unknown, options: ApplicationErrorOptions = {}): void {
  const previousErrorRef = useRef<unknown>(undefined);
  const language = options.language;
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
      ...(primaryAction ? { primaryAction } : {}),
    });
  }, [error, language, primaryAction]);
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
  const current = queue[0];

  useEffect(() => subscribe(() => forceRender((value) => value + 1)), []);

  if (!current) return null;
  const copy = copyByLanguage[current.language ?? props.language];

  function runPrimaryAction(): void {
    const action = current?.primaryAction;
    dismissCurrentError();
    action?.run();
  }

  return (
    <ModalPortal rootClassName="application-error-dialog-portal-root" backdropClassName="application-error-dialog-backdrop" onDismiss={dismissCurrentError}>
      <section className="application-error-dialog zeus-solid-form-surface" role="alertdialog" aria-modal="true" aria-labelledby="application-error-dialog-message">
        <div className="application-error-dialog-content">
          <code id="application-error-dialog-message" data-zeus-selectable="text">
            {current.visibleText}
          </code>
        </div>
        <footer>
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
