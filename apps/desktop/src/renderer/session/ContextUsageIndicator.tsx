import { useId } from 'react';
import type { NativeTokenUsageSnapshot } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

type ContextUsageSeverity = 'unavailable' | 'normal' | 'warning' | 'danger';

export function ContextUsageIndicator(props: { usage: NativeTokenUsageSnapshot | null; language: SessionUiLanguage }) {
  const tooltipId = `session-context-usage-${useId().replaceAll(':', '')}`;
  const used = props.usage?.last.inputTokens ?? null;
  const capacity = props.usage?.modelContextWindow ?? null;
  const available = used !== null && capacity !== null && capacity > 0;
  const ratio = available ? used / capacity : null;
  const progress = ratio === null ? 0 : Math.min(100, Math.max(0, ratio * 100));
  const severity = contextUsageSeverity(ratio);
  const copy = contextUsageCopy(props.language, used, capacity, ratio, severity);

  return (
    <span className="session-context-usage-indicator" data-available={available ? 'true' : 'false'} data-severity={severity} tabIndex={0} role="img" aria-label={copy.accessibleLabel}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="session-context-usage-track" cx="12" cy="12" r="8.5" />
        <circle className="session-context-usage-value" cx="12" cy="12" r="8.5" pathLength="100" strokeDasharray={`${progress} 100`} />
      </svg>
      <span id={tooltipId} className="session-context-usage-tooltip" role="tooltip">
        <strong aria-hidden="true">{copy.title}</strong>
        {available ? (
          <dl>
            <div>
              <dt>{copy.percentageLabel}</dt>
              <dd>{copy.percentage}</dd>
            </div>
            <div>
              <dt>{copy.usedLabel}</dt>
              <dd>{copy.used}</dd>
            </div>
            <div>
              <dt>{copy.remainingLabel}</dt>
              <dd>{copy.remaining}</dd>
            </div>
          </dl>
        ) : (
          <span>{copy.empty}</span>
        )}
        {copy.risk ? <small>{copy.risk}</small> : null}
      </span>
    </span>
  );
}

function contextUsageSeverity(ratio: number | null): ContextUsageSeverity {
  if (ratio === null) return 'unavailable';
  if (ratio >= 0.9) return 'danger';
  if (ratio >= 0.75) return 'warning';
  return 'normal';
}

function contextUsageCopy(language: SessionUiLanguage, used: number | null, capacity: number | null, ratio: number | null, severity: ContextUsageSeverity) {
  const zh = language === 'zh-CN';
  const title = zh ? '上下文占用' : 'Context usage';
  if (used === null || capacity === null || capacity <= 0 || ratio === null) {
    const empty = zh ? '完成首轮后显示上下文占用。' : 'Context usage appears after the first turn.';
    return {
      title,
      accessibleLabel: `${title}：${empty}`,
      percentageLabel: '',
      percentage: '',
      usedLabel: '',
      used: '',
      remainingLabel: '',
      remaining: '',
      empty,
      risk: null,
    };
  }

  const percentage = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, ratio));
  const usedTokens = formatExactTokens(used, language);
  const capacityTokens = formatExactTokens(capacity, language);
  const remainingTokens = formatExactTokens(Math.max(0, capacity - used), language);
  const risk = severity === 'danger' ? (zh ? '上下文接近上限' : 'Context is near its limit') : severity === 'warning' ? (zh ? '上下文占用较高' : 'Context usage is high') : null;
  const usedDetail = `${usedTokens} / ${capacityTokens} Token`;
  const remainingDetail = `${remainingTokens} Token`;
  const accessibleLabel = `${title}：${percentage}；${zh ? '已用' : 'Used'} ${usedDetail}；${zh ? '剩余' : 'Remaining'} ${remainingDetail}${risk ? `；${risk}` : ''}`;

  return {
    title,
    accessibleLabel,
    percentageLabel: zh ? '占用' : 'Usage',
    percentage,
    usedLabel: zh ? '已用 / 容量' : 'Used / capacity',
    used: usedDetail,
    remainingLabel: zh ? '剩余' : 'Remaining',
    remaining: remainingDetail,
    empty: '',
    risk,
  };
}

function formatExactTokens(value: number, language: SessionUiLanguage): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(Math.max(0, value));
}
