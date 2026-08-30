import { useEffect, useRef } from 'react';

export type ApplicationErrorLanguage = 'zh-CN' | 'en';

export interface ApplicationErrorOptions {
  language?: ApplicationErrorLanguage;
}

const secretPatterns: ReadonlyArray<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已脱敏]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[已脱敏]'],
  [/\b(api[_-]?key|token|password|secret)\s*[:=]\s*([^\s,;]+)/gi, '$1=[已脱敏]'],
  [/([?&](?:access_token|api_key|token|password|secret)=)[^&\s]+/gi, '$1[已脱敏]'],
];

const copyByLanguage = {
  'zh-CN': {
    unavailable: '当前操作未完成，请稍后重试。',
    unknown: '未知错误。',
  },
  en: {
    unavailable: 'The current operation did not complete. Please try again.',
    unknown: 'Unknown error.',
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
};

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

/**
 * 界面只提供稳定、可理解的操作结果；错误码和内部消息不再进入 DOM。
 * 真实诊断信息由 reportApplicationError 写入本机运行日志。
 */
export function formatVisibleApplicationError(error: unknown, language: ApplicationErrorLanguage = 'zh-CN'): string {
  const code = errorCode(error);
  if (code && visibleCopyByCode[code]) return visibleCopyByCode[code][language];
  return copyByLanguage[language].unavailable;
}

export function VisibleApplicationError(props: { error: unknown; language?: ApplicationErrorLanguage; className?: string }) {
  return <span className={props.className}>{formatVisibleApplicationError(props.error, props.language)}</span>;
}

/**
 * 全应用统一错误出口：运行期错误只写入本机运行日志，不再生成弹窗、遮罩或全局错误卡片。
 */
export function reportApplicationError(error: unknown, options: ApplicationErrorOptions = {}): void {
  const language = options.language ?? 'zh-CN';
  const code = errorCode(error);
  const message = errorMessage(error, language).replace(/\s+/gu, ' ').trim() || copyByLanguage[language].unknown;
  const detail = redactDetails(code && message !== code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message);
  console.error('[Zeus runtime]', detail);
  window.zeus?.reportRendererRuntimeError?.(detail);
}

/** 同一个失败值只写入一次运行日志。 */
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

/** 保留旧挂载点以避免业务页批量改动；全局错误弹窗已永久停用。 */
export function ApplicationErrorDialogHost(props: { language: ApplicationErrorLanguage }) {
  void props.language;
  return null;
}
