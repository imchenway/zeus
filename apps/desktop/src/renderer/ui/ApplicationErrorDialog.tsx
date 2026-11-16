import { MotionPresence } from './MotionPresence.js';
import { Collapsible } from './Collapsible.js';
import { describeUserFacingError, faultReportContext, faultReportDetails, normalizeFaultReportInput, redactUserFacingErrorDetails, type FaultReportInput, type FaultReportReceipt } from '@zeus/shared';
import { useEffect, useRef, useState } from 'react';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { Button } from './Button.js';
import { ModalPortal } from './ModalPortal.js';

/** 全局错误出口请求原地打开模型接入，不切换工作面或销毁草稿。 */
export const modelSetupRequestedEvent = 'zeus:model-setup-requested';

export type ApplicationErrorLanguage = 'zh-CN' | 'en';

export interface ApplicationErrorOptions {
  language?: ApplicationErrorLanguage;
  /** 业务已确认的简短状态，完整原文仍保留在诊断详情中。 */
  summary?: string;
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
  /** 采集发生错误时的现场，重试不能改为后续选中的会话。 */
  report: FaultReportInput;
  /** 每个队列条目独立保留异步上报状态。 */
  reporting?: boolean;
  receipt?: FaultReportReceipt;
  reportError?: string;
}

/** 当前窗口的业务身份，只在错误入队时拍快照。 */
let applicationErrorContext: Record<string, string> = {};

/** 工作面切换更新身份，旧工作面卸载不能清空新工作面的身份。 */
export function setApplicationErrorContext(context: Record<string, unknown>): () => void {
  const value = faultReportContext(context);
  applicationErrorContext = value;
  return () => { if (applicationErrorContext === value) applicationErrorContext = {}; };
}

const listeners = new Set<() => void>();
let queue: ApplicationErrorEntry[] = [];
let nextErrorId = 1;

const copyByLanguage = {
  'zh-CN': {
    title: '无法完成操作',
    unknown: '未知错误。',
    details: '查看详情',
    hideDetails: '收起详情',
    close: '关闭',
    detailTitle: '错误日志',
    occurredAt: '时间',
    severity: '级别',
    operation: '操作',
    errorCode: '错误码',
    errorType: '异常类型',
    visibleMessage: '错误提示',
    diagnosticContext: '诊断记录',
  },
  en: {
    title: 'Unable to complete this action',
    unknown: 'Unknown error.',
    details: 'View Details',
    hideDetails: 'Hide Details',
    close: 'Close',
    detailTitle: 'Error log',
    occurredAt: 'Time',
    severity: 'Level',
    operation: 'Operation',
    errorCode: 'Error code',
    errorType: 'Error type',
    visibleMessage: 'Message',
    diagnosticContext: 'Diagnostic record',
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

function errorType(error: unknown): string | null {
  if (error instanceof Error) return error.name.trim() || null;
  if (!error || typeof error !== 'object' || !('name' in error) || typeof error.name !== 'string') return null;
  return error.name.trim() || null;
}

function errorOperation(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { operation?: unknown; action?: unknown; source?: unknown };
  const candidate = typeof value.operation === 'string' ? value.operation : typeof value.action === 'string' ? value.action : typeof value.source === 'string' ? value.source : null;
  return candidate?.trim() || null;
}

function errorOccurredAt(error: unknown): string {
  if (error && typeof error === 'object' && 'occurredAt' in error && typeof error.occurredAt === 'string' && Number.isFinite(Date.parse(error.occurredAt))) {
    return new Date(error.occurredAt).toISOString();
  }
  return new Date().toISOString();
}

/** 只取错误字段和最多四层原因，保留服务端详情并排除业务正文。 */
function diagnosticErrorStack(error: unknown, depth = 0): string {
  if (depth >= 4 || !error || typeof error !== 'object') return typeof error === 'string' ? error : '';
  const value = error as Record<string, unknown>;
  const parts = [value.name, value.code].filter((item) => typeof item === 'string') as string[];
  if (typeof value.message === 'string') parts.push(value.message);
  const metadata = faultReportDetails(value);
  delete metadata.stack;
  delete metadata.message;
  if (Object.keys(metadata).length) parts.push(JSON.stringify(metadata));
  if (value.cause) parts.push(`Caused by:\n${diagnosticErrorStack(value.cause, depth + 1)}`);
  if (typeof value.stack === 'string') parts.push(value.stack);
  return parts.join('\n').slice(0, 32000);
}

/** 只负责解释原因，不改变错误对应操作的可重试性。 */
export function formatVisibleApplicationError(error: unknown, language: ApplicationErrorLanguage = 'zh-CN'): string {
  return describeUserFacingError(error, language).message;
}

/** 各页面共用紧凑摘要；完整说明按需打开，处理动作只使用业务提供的入口。 */
export function VisibleApplicationError(props: {
  /** 原始错误或受阻说明，不因折叠而丢失诊断。 */
  error: unknown;
  /** 展示文字沿用界面语言。 */
  language?: ApplicationErrorLanguage;
  /** 保留调用方布局钩子。 */
  className?: string;
  /** 已确认的业务摘要，避免把内部节点与长日志铺到页面上。 */
  summary?: string;
  /** 详情窗口标明发生问题的对象。 */
  title?: string;
  /** 显式处理入口，不自动重试或重发。 */
  action?: ApplicationErrorOptions['action'];
}) {
  /** 原始说明与当前语言一并交给已有错误解释器。 */
  const language = props.language ?? 'zh-CN';
  /** 摘要仅影响首屏，详情窗口始终保留原始错误。 */
  const explanation = describeUserFacingError(props.error, language);
  /** 说明按钮使用可读名称，图标不代替键盘与读屏入口。 */
  const detailsLabel = language === 'zh-CN' ? '查看完整说明' : 'View full explanation';
  return (
    <span className={`application-error-inline${props.className ? ` ${props.className}` : ''}`}>
      <span className="application-error-inline-summary" data-zeus-selectable="text">
        {props.summary ?? explanation.message}
      </span>
      <button
        type="button"
        className="application-error-details-link"
        aria-label={detailsLabel}
        data-icon-tooltip={detailsLabel}
        onClick={() => reportApplicationError(props.error, { language, summary: props.summary, title: props.title, action: props.action, showDetails: true })}
      >
        <WarningCircle aria-hidden="true" />
      </button>
      {props.action ? (
        <Button
          size="compact"
          className="application-error-inline-action"
          onClick={() => {
            void Promise.resolve()
              .then(() => props.action?.onClick())
              .catch((error: unknown) => reportApplicationError(error, { language, title: props.title }));
          }}
        >
          {props.action.label}
        </Button>
      ) : null}
    </span>
  );
}

/** 全应用统一错误出口：主区域直接显示具体原因，展开区只承载可复制的诊断日志。 */
export function reportApplicationError(error: unknown, options: ApplicationErrorOptions = {}): string {
  const language = options.language ?? 'zh-CN';
  const copy = copyByLanguage[language];
  const code = errorCode(error);
  const type = errorType(error);
  const operation = errorOperation(error);
  const explanation = describeUserFacingError(error, language);
  const message = errorMessage(error, language).replace(/\s+/gu, ' ').trim() || copy.unknown;
  const original = code && message !== code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
  const diagnosticContext = explanation.details || original;
  const detailsBody = [
    `${copy.severity}: ERROR`,
    diagnosticContext.trim() !== (options.summary ?? explanation.message).trim() ? `${copy.visibleMessage}: ${options.summary ?? explanation.message}` : '',
    code ? `${copy.errorCode}: ${code}` : '',
    type ? `${copy.errorType}: ${type}` : '',
    operation ? `${copy.operation}: ${operation}` : '',
    `${copy.diagnosticContext}:\n${diagnosticContext}`,
  ]
    .filter(Boolean)
    .join('\n');
  const details = redactDetails(`${copy.occurredAt}: ${errorOccurredAt(error)}\n${detailsBody}`);
  const entry: ApplicationErrorEntry = {
    id: nextErrorId++,
    language,
    title: options.title ?? copy.title,
    summary: options.summary ?? explanation.message,
    showDetails: options.showDetails === true,
    details,
    dedupeKey: `${options.title ?? copy.title}\n${options.summary ?? explanation.message}\n${detailsBody}`,
    code,
    action: options.action,
    report: normalizeFaultReportInput({
      reportId: crypto.randomUUID(),
      occurredAt: errorOccurredAt(error),
      title: options.title ?? copy.title,
      summary: options.summary ?? explanation.message,
      code: code ?? '',
      operation: operation ?? '',
      stack: diagnosticErrorStack(error) || original,
      context: { ...applicationErrorContext, ...faultReportContext(error) },
    }),
  };
  /** 重新查看同一故障时保留报告身份和回执，不再次创建 Issue。 */
  entry.dedupeKey += `\n${JSON.stringify(entry.report.context)}`;
  const duplicate = queue.find((candidate) => candidate.language === entry.language && candidate.dedupeKey === entry.dedupeKey);
  if (options.showDetails) {
    const visible = duplicate ?? entry;
    visible.showDetails = true;
    queue = [visible, ...queue.filter((candidate) => candidate !== visible && candidate.dedupeKey !== entry.dedupeKey)];
    notifyListeners();
  } else if (!duplicate) {
    queue = [...queue, entry];
    notifyListeners();
  }
  console.error('[Zeus runtime]', details);
  window.zeus?.reportRendererRuntimeError?.(JSON.stringify({ kind: 'application_error', reportId: entry.report.reportId, detail: details, context: entry.report.context }));
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

/** 上报失败留在当前窗口，避免错误出口再次弹出自身的故障。 */
async function submitCurrentFault(entry: ApplicationErrorEntry): Promise<void> {
  if (entry.reporting || entry.receipt) return;
  entry.reporting = true;
  entry.reportError = undefined;
  notifyListeners();
  try {
    if (!window.zeus?.submitFaultReport) throw new Error('当前窗口无法上报，请使用桌面应用。');
    entry.receipt = await window.zeus.submitFaultReport(entry.report);
  } catch (error) {
    entry.reportError = describeUserFacingError(error, entry.language).message;
  } finally {
    entry.reporting = false;
    notifyListeners();
  }
}

export function ApplicationErrorDialogHost(props: { language: ApplicationErrorLanguage }) {
  const [, forceRender] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** 上报按钮移除后，键盘焦点可回到仍可操作的关闭入口。 */
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const current = queue[0];
  useEffect(() => subscribe(() => forceRender((value) => value + 1)), []);
  useEffect(() => setDetailsOpen(current?.showDetails ?? false), [current?.id, current?.showDetails]);
  useEffect(() => {
    if (current?.receipt && document.activeElement === document.body) closeButtonRef.current?.focus();
  }, [current?.receipt]);
  const copy = copyByLanguage[current?.language ?? props.language];
  return (
    <MotionPresence>
      {current ? (
        <ModalPortal
          rootClassName="application-error-dialog-portal-root"
          backdropClassName="application-error-dialog-backdrop"
          onDismiss={dismissCurrentError}
          role="alertdialog"
          aria-labelledby="application-error-dialog-title"
          aria-describedby="application-error-dialog-summary"
        >
          <section className="application-error-dialog zeus-solid-form-surface" data-modal-surface="alertdialog">
            <div className="application-error-dialog-icon" aria-hidden="true">
              <WarningCircle weight="fill" />
            </div>
            <div className="application-error-dialog-content">
              <header>
                <strong id="application-error-dialog-title" data-zeus-selectable="text">
                  {current.title}
                </strong>
                <p id="application-error-dialog-summary" data-zeus-selectable="text">
                  {current.summary}
                </p>
              </header>
              <Collapsible open={detailsOpen}>
                <section className="application-error-dialog-details" aria-labelledby="application-error-dialog-details-title">
                  <strong id="application-error-dialog-details-title">{copy.detailTitle}</strong>
                  <pre data-zeus-selectable="text">{current.details}</pre>
                </section>
              </Collapsible>
              {current.receipt || current.reportError ? (
                <p className="application-error-report-status" role="status" aria-live="polite">
                  {current.reportError || (current.language === 'zh-CN' ? '已上报' : 'Reported')}
                </p>
              ) : null}
            </div>
            <footer>
              <Button variant="secondary" size="regular" onClick={() => setDetailsOpen((open) => !open)} aria-expanded={detailsOpen} aria-controls="application-error-dialog-details-title">
                {detailsOpen ? copy.hideDetails : copy.details}
              </Button>
              {!current.receipt ? (
                <Button size="regular" busy={current.reporting} onClick={() => void submitCurrentFault(current)}
                  data-icon-tooltip={current.language === 'zh-CN' ? '发送脱敏错误、环境和运行事件，不含对话正文、源码或截图' : 'Send redacted errors, environment and runtime events; excludes conversations, source and screenshots'}>
                  {current.reporting ? (current.language === 'zh-CN' ? '上报中…' : 'Reporting…') : current.reportError ? (current.language === 'zh-CN' ? '重试上报' : 'Retry report') : (current.language === 'zh-CN' ? '上报故障' : 'Report issue')}
                </Button>
              ) : null}
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
              <Button ref={closeButtonRef} variant={current.action ? 'secondary' : 'primary'} size="regular" onClick={dismissCurrentError} autoFocus>
                {copy.close}
              </Button>
            </footer>
          </section>
        </ModalPortal>
      ) : null}
    </MotionPresence>
  );
}
