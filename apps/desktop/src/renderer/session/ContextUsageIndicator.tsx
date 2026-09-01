import { type CSSProperties, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NativeUnifiedUsageSnapshot } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { formatTokenCount } from './tokenUsageFormat.js';

type ContextUsageSeverity = 'unavailable' | 'normal' | 'warning' | 'danger';

export function ContextUsageIndicator(props: { unifiedUsage: NativeUnifiedUsageSnapshot | null; language: SessionUiLanguage }) {
  const tooltipId = `session-context-usage-${useId().replaceAll(':', '')}`;
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  // 上下文规模只认最后一次真实模型请求：totalTokens（提示词 + 本次输出）就是下一次请求要携带的上下文，
  // 与 Pi 运行内核的压缩阈值口径一致。轮次累计用量不是上下文规模，任何情况下都不能当分子。
  const latestRequest = props.unifiedUsage?.latestModelRequest ?? null;
  const used = latestRequest?.totalTokens ?? null;
  const capacity = latestRequest?.contextWindow ?? null;
  const available = used !== null && capacity !== null && capacity > 0;
  const ratio = available ? used / capacity : null;
  const estimate = props.unifiedUsage?.preflightEstimate ?? null;
  const compaction = props.unifiedUsage?.latestContextCompaction ?? null;
  const progress = ratio === null ? 0 : Math.min(100, Math.max(0, ratio * 100));
  const severity = contextUsageSeverity(ratio);
  const copy = contextUsageCopy(props.language, used, capacity, ratio, severity, estimate?.estimatedHeadroomTokens ?? null, compaction?.status ?? null);

  useLayoutEffect(() => {
    if (!tooltipOpen) {
      setTooltipPosition(null);
      return;
    }
    const position = (): void => {
      const indicator = indicatorRef.current;
      const tooltip = tooltipRef.current;
      if (!indicator || !tooltip) return;
      const indicatorRect = indicator.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const margin = 8;
      const gap = 8;
      const left = Math.max(margin, Math.min(indicatorRect.right - tooltipRect.width, window.innerWidth - tooltipRect.width - margin));
      const above = indicatorRect.top - tooltipRect.height - gap;
      const below = indicatorRect.bottom + gap;
      const top = above >= margin ? above : Math.max(margin, Math.min(below, window.innerHeight - tooltipRect.height - margin));
      setTooltipPosition({ left, top });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [capacity, compaction?.status, estimate?.estimatedHeadroomTokens, props.language, tooltipOpen, used]);

  const tooltip = (
    <span ref={tooltipRef} id={tooltipId} className="session-context-usage-tooltip" role="tooltip" style={contextUsageTooltipPositionStyle(tooltipPosition)}>
      <strong aria-hidden="true">{copy.title}</strong>
      {available || copy.estimatedHeadroom || copy.compaction ? (
        <dl>
          {available ? (
            <>
              <div>
                <dt>{copy.percentageLabel}</dt>
                <dd>{copy.percentage}</dd>
              </div>
              <div>
                <dt>{copy.usedLabel}</dt>
                <dd title={copy.usedTitle}>{copy.used}</dd>
              </div>
              <div>
                <dt>{copy.remainingLabel}</dt>
                <dd title={copy.remainingTitle}>{copy.remaining}</dd>
              </div>
            </>
          ) : null}
          {copy.estimatedHeadroom ? (
            <div>
              <dt>{copy.estimatedHeadroomLabel}</dt>
              <dd title={copy.estimatedHeadroomTitle}>{copy.estimatedHeadroom}</dd>
            </div>
          ) : null}
          {copy.compaction ? (
            <div>
              <dt>{copy.compactionLabel}</dt>
              <dd>{copy.compaction}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <span>{copy.empty}</span>
      )}
      {copy.risk ? <small>{copy.risk}</small> : null}
    </span>
  );

  return (
    <span
      ref={indicatorRef}
      className="session-context-usage-indicator"
      data-available={available ? 'true' : 'false'}
      data-severity={severity}
      tabIndex={0}
      role="img"
      aria-label={copy.accessibleLabel}
      aria-describedby={tooltipOpen ? tooltipId : undefined}
      onPointerEnter={() => setTooltipOpen(true)}
      onPointerLeave={(event) => {
        if (document.activeElement !== event.currentTarget) setTooltipOpen(false);
      }}
      onFocus={() => setTooltipOpen(true)}
      onBlur={() => setTooltipOpen(false)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="session-context-usage-track" cx="12" cy="12" r="8.5" />
        <circle className="session-context-usage-value" cx="12" cy="12" r="8.5" pathLength="100" strokeDasharray={`${progress} 100`} />
        <circle className="session-context-usage-core" cx="12" cy="12" r="1.7" />
      </svg>
      {tooltipOpen && typeof document !== 'undefined' && document.body ? createPortal(<span className={contextUsagePortalClassName(indicatorRef.current)}>{tooltip}</span>, document.body) : null}
    </span>
  );
}

function contextUsageTooltipPositionStyle(position: { left: number; top: number } | null): CSSProperties {
  return position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' };
}

function contextUsagePortalClassName(indicator: HTMLElement | null): string {
  const app = indicator?.closest('.session-codex-parity-v1') ?? document.querySelector('.macos-ai-app.zeus-shell');
  const theme = app?.classList.contains('theme-dark') ? 'theme-dark' : app?.classList.contains('theme-light') ? 'theme-light' : 'theme-system';
  return `session-context-usage-tooltip-portal session-codex-parity-v1 ${theme}`;
}

function contextUsageSeverity(ratio: number | null): ContextUsageSeverity {
  if (ratio === null) return 'unavailable';
  if (ratio >= 0.9) return 'danger';
  if (ratio >= 0.75) return 'warning';
  return 'normal';
}

function contextUsageCopy(
  language: SessionUiLanguage,
  used: number | null,
  capacity: number | null,
  ratio: number | null,
  severity: ContextUsageSeverity,
  estimatedHeadroomTokens: number | null,
  compactionStatus: 'in_progress' | 'completed' | 'failed' | null,
) {
  const zh = language === 'zh-CN';
  const title = zh ? '上下文占用' : 'Context usage';
  const estimatedHeadroom = estimatedHeadroomTokens === null ? '' : `${estimatedHeadroomTokens < 0 ? '-' : ''}${formatTokenCount(Math.abs(estimatedHeadroomTokens), language).compact} Token`;
  const estimatedHeadroomExact = estimatedHeadroomTokens === null ? '' : `${new Intl.NumberFormat(language).format(estimatedHeadroomTokens)} Token (${zh ? '估算，不是 Provider 实测' : 'estimate, not Provider-measured'})`;
  const compaction =
    compactionStatus === 'in_progress' ? (zh ? '压缩中' : 'Compacting') : compactionStatus === 'completed' ? (zh ? '最近一次已完成' : 'Latest completed') : compactionStatus === 'failed' ? (zh ? '最近一次失败' : 'Latest failed') : '';
  if (used === null || capacity === null || capacity <= 0 || ratio === null) {
    const empty = zh ? '完成首轮后显示真实上下文占用。' : 'Measured context usage appears after the first turn.';
    const estimateAccessible = estimatedHeadroom ? `；${zh ? '下一请求估算安全余量' : 'Estimated next-request safe headroom'} ${estimatedHeadroomExact}` : '';
    const compactionAccessible = compaction ? `；${zh ? '压缩状态' : 'Compaction status'} ${compaction}` : '';
    return {
      title,
      accessibleLabel: `${title}：${empty}${estimateAccessible}${compactionAccessible}`,
      percentageLabel: '',
      percentage: '',
      usedLabel: '',
      used: '',
      usedTitle: '',
      remainingLabel: '',
      remaining: '',
      remainingTitle: '',
      estimatedHeadroomLabel: zh ? '下一请求安全余量（估算）' : 'Next-request safe headroom (estimate)',
      estimatedHeadroom,
      estimatedHeadroomTitle: estimatedHeadroomExact,
      compactionLabel: zh ? '压缩状态' : 'Compaction status',
      compaction,
      empty,
      risk: estimatedHeadroomTokens !== null && estimatedHeadroomTokens < 0 ? (zh ? '估算已越过安全预算，将在派发前触发原生压缩。' : 'The estimate exceeds the safe budget; native compaction runs before dispatch.') : null,
    };
  }

  const percentage = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, ratio));
  const usedTokens = formatTokenCount(Math.max(0, used), language);
  const capacityTokens = formatTokenCount(Math.max(0, capacity), language);
  const remainingTokens = formatTokenCount(Math.max(0, capacity - used), language);
  const risk =
    estimatedHeadroomTokens !== null && estimatedHeadroomTokens < 0
      ? zh
        ? '下一请求估算已越过安全预算；派发前会先执行原生压缩。'
        : 'The next-request estimate exceeds the safe budget; native compaction runs before dispatch.'
      : severity === 'danger'
        ? zh
          ? '上下文接近上限'
          : 'Context is near its limit'
        : severity === 'warning'
          ? zh
            ? '上下文占用较高'
            : 'Context usage is high'
          : null;
  // 可见文本用 K/M 紧凑单位，精确位数只留在无障碍标签与悬停标题里，避免长数字撑破气泡。
  const usedDetail = `${usedTokens.compact} / ${capacityTokens.compact} Token`;
  const usedDetailExact = `${usedTokens.exact} / ${capacityTokens.exact} Token`;
  const remainingDetail = `${remainingTokens.compact} Token`;
  const remainingDetailExact = `${remainingTokens.exact} Token`;
  const estimateAccessible = estimatedHeadroom ? `；${zh ? '下一请求估算安全余量' : 'Estimated next-request safe headroom'} ${estimatedHeadroomExact}` : '';
  const compactionAccessible = compaction ? `；${zh ? '压缩状态' : 'Compaction status'} ${compaction}` : '';
  const accessibleLabel = `${title}：${percentage}；${zh ? '已用' : 'Used'} ${usedDetailExact}；${zh ? '剩余' : 'Remaining'} ${remainingDetailExact}${estimateAccessible}${compactionAccessible}${risk ? `；${risk}` : ''}`;

  return {
    title,
    accessibleLabel,
    percentageLabel: zh ? '占用' : 'Usage',
    percentage,
    usedLabel: zh ? '已用 / 容量' : 'Used / capacity',
    used: usedDetail,
    usedTitle: usedDetailExact,
    remainingLabel: zh ? '剩余' : 'Remaining',
    remaining: remainingDetail,
    remainingTitle: remainingDetailExact,
    estimatedHeadroomLabel: zh ? '下一请求安全余量（估算）' : 'Next-request safe headroom (estimate)',
    estimatedHeadroom,
    estimatedHeadroomTitle: estimatedHeadroomExact,
    compactionLabel: zh ? '压缩状态' : 'Compaction status',
    compaction,
    empty: '',
    risk,
  };
}
