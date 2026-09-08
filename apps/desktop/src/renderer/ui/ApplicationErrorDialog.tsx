import { describeUserFacingError, redactUserFacingErrorDetails } from '@zeus/shared';
import { useEffect, useRef, useState } from 'react';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { Button } from './Button.js';
import { ModalPortal } from './ModalPortal.js';

/** 全局错误出口请求原地打开模型接入，不切换工作面或销毁草稿。 */
export const modelSetupRequestedEvent = 'zeus:model-setup-requested';

export type ApplicationErrorLanguage = 'zh-CN' | 'en';

export interface ApplicationErrorOptions {
  language?: ApplicationErrorLanguage;
  /** 用户主动查看详情时直接展开，避免再次寻找入口。 */
  showDetails?: boolean;
  /** 显示本次失败的操作与对象，避免用户混淆会话。 */
  title?: string;
  /** 由业务场景提供真实处理入口，错误窗口不猜测恢复操作。 */
  action?: { label: string; onClick: () => void | Promise<void> };
}

interface ApplicationErrorEntry {
  id: number;
  language: ApplicationErrorLanguage;
  title: string;
  summary: string;
  details: string;
  dedupeKey: string;
  /** 保留可操作错误身份，不依赖翻译后的文案识别登录门禁。 */
  code: string | null;
  /** 当前条目是否由查看详情按钮打开。 */
  showDetails: boolean;
  /** 保留当前错误对应的处理动作。 */
  action?: ApplicationErrorOptions['action'];
}

const listeners = new Set<() => void>();
let queue: ApplicationErrorEntry[] = [];
let nextErrorId = 1;

const copyByLanguage = {
  'zh-CN': {
    title: '无法完成操作',
    summary: 'Zeus 尚未识别这次错误的具体原因。请查看错误详情。',
    unavailable: 'Zeus 尚未识别这次错误的具体原因。',
    unknown: '未知错误。',
    details: '查看详情',
    hideDetails: '收起详情',
    close: '关闭',
    detailTitle: '错误详情',
    occurredAt: '发生时间',
    originalMessage: '原始信息',
  },
  en: {
    title: 'Unable to complete this action',
    summary: 'Zeus has not identified the cause of this error. See the error details.',
    unavailable: 'Zeus has not identified the cause of this error.',
    unknown: 'Unknown error.',
    details: 'View Details',
    hideDetails: 'Hide Details',
    close: 'Close',
    detailTitle: 'Error details',
    occurredAt: 'Occurred at',
    originalMessage: 'Original message',
  },
} as const;

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function redactDetails(value: string): string {
  return redactUserFacingErrorDetails(value);
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

/** 只负责解释原因，不改变错误对应操作的可重试性。 */
export function formatVisibleApplicationError(error: unknown, language: ApplicationErrorLanguage = 'zh-CN'): string {
  return describeUserFacingError(error, language).message;
}

/** 行内提示直接说明原因，用户可主动打开已有详情窗口。 */
export function VisibleApplicationError(props: { error: unknown; language?: ApplicationErrorLanguage; className?: string }) {
  const language = props.language ?? 'zh-CN';
  const explanation = describeUserFacingError(props.error, language);
  return (
    <span className={props.className}>
      <span>{explanation.message}</span>
      {explanation.details ? (
        <button type="button" className="application-error-details-link" onClick={() => reportApplicationError(props.error, { language, showDetails: true })}>
          {language === 'zh-CN' ? '错误详情' : 'Error details'}
        </button>
      ) : null}
    </span>
  );
}

/** 全应用统一错误出口：摘要保持稳定，脱敏后的真实错误码和消息进入可展开详情。 */
export function reportApplicationError(error: unknown, options: ApplicationErrorOptions = {}): string {
  const language = options.language ?? 'zh-CN';
  const copy = copyByLanguage[language];
  const code = errorCode(error);
  const message = errorMessage(error, language).replace(/\s+/gu, ' ').trim() || copy.unknown;
  const original = code && message !== code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
  const detailsBody = `${copy.originalMessage}: ${describeUserFacingError(error, language).details || original}`;
  const details = redactDetails(`${copy.occurredAt}: ${new Date().toISOString()}\n${detailsBody}`);
  const entry: ApplicationErrorEntry = {
    id: nextErrorId++,
    language,
    title: options.title ?? copy.title,
    summary: formatVisibleApplicationError(error, language),
    showDetails: options.showDetails === true,
    details,
    dedupeKey: `${options.title ?? copy.title}\n${detailsBody}`,
    code,
    action: options.action,
  };
  const duplicate = queue.some((candidate) => candidate.language === entry.language && candidate.dedupeKey === entry.dedupeKey);
  if (duplicate && options.showDetails) {
    queue = [entry, ...queue.filter((candidate) => candidate.dedupeKey !== entry.dedupeKey)];
    notifyListeners();
  } else if (!duplicate) {
    queue = [...queue, entry];
    notifyListeners();
  }
  console.error('[Zeus runtime]', details);
  window.zeus?.reportRendererRuntimeError?.(details);
  return entry.summary;
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
    // 已格式化的摘要没有原始详情，不重复弹出同一提示。
    if (typeof error === 'string' && !describeUserFacingError(error, language).details) return;
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
  useEffect(() => setDetailsOpen(current?.showDetails ?? false), [current?.id, current?.showDetails]);
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
          {current.code === 'ZEUS_CODEX_LOGIN_REQUIRED' || current.code === 'ZEUS_NEW_PROJECT_MODEL_UNAVAILABLE' ? (
            <Button
              variant="primary"
              size="regular"
              onClick={() => {
                const step = current.code === 'ZEUS_CODEX_LOGIN_REQUIRED' ? 'codex' : 'choose';
                dismissCurrentError();
                window.dispatchEvent(new CustomEvent(modelSetupRequestedEvent, { detail: step }));
              }}
            >
              {current.language === 'zh-CN' ? '连接模型' : 'Connect a model'}
            </Button>
          ) : null}
          {current.action ? (
            <Button
              variant="primary"
              size="regular"
              onClick={() => {
                /** 先关闭当前反馈，避免重复点击；失败继续使用统一错误出口。 */
                const action = current.action;
                dismissCurrentError();
                void Promise.resolve()
                  .then(() => action?.onClick())
                  .catch((error: unknown) => reportApplicationError(error, { language: current.language, title: current.title }));
              }}
            >
              {current.action.label}
            </Button>
          ) : null}
          <Button variant="primary" size="regular" onClick={dismissCurrentError} autoFocus>
            {copy.close}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}
