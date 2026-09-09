import { CaretUpIcon as CaretUp } from '@phosphor-icons/react/dist/csr/CaretUp';
import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { useEffect, useState, type ReactNode } from 'react';
import type { NativeRuntimeDetailsSnapshot, NativeRuntimeFact } from './sessionTypes.js';
import { copyText, type SessionUiLanguage } from './ThreadItemView.js';
import { formatTokenCount } from './tokenUsageFormat.js';

/** 会话与智能体共用的运行事实；项目名称只作为摘要前缀。 */
interface RuntimeDetailsProps {
  runtime: NativeRuntimeDetailsSnapshot;
  language: SessionUiLanguage;
  scope: 'session' | 'subagent';
  mcpStartup?: Record<string, unknown> | null;
  contextLabel?: string;
}

/** 使用原生折叠面板展示摘要及按用途分组的运行事实。 */
export function RuntimeDetails(props: RuntimeDetailsProps) {
  const zh = props.language === 'zh-CN';
  const copy = runtimeLabels(props.language);
  const warning = runtimeValueNeedsAttention(props.mcpStartup);
  const contextUsage = formatContextUsage(props.runtime.usage.contextTokens, props.runtime.usage.contextWindow, props.language);
  const costComplete =
    props.runtime.usage.apiEquivalentUsd.state === 'available' &&
    props.runtime.usage.priceCoverage.state === 'available' &&
    props.runtime.usage.priceCoverage.value === 1 &&
    props.runtime.usage.historyComplete.state === 'available' &&
    props.runtime.usage.historyComplete.value;
  const tokenScopeLabel = props.scope === 'subagent' ? (zh ? '智能体累计 Token' : 'Agent tokens') : zh ? '会话累计 Token' : 'Session tokens';
  return (
    <details className="session-runtime-details" data-language={props.language} data-severity={warning ? 'warning' : 'ready'} data-scope={props.scope} aria-label={copy.runtimeDetails}>
      <summary>
        <span className="session-runtime-summary-primary">
          {props.contextLabel ? (
            <small className="session-thread-project-name" title={props.contextLabel}>
              {props.contextLabel}
            </small>
          ) : null}
          <RuntimeSummaryMetric label={tokenScopeLabel} value={formatTokenFact(props.runtime.usage.totalTokens, props.language, true)} />
          <RuntimeSummaryMetric label={copy.contextUsage} value={contextUsage} />
          <RuntimeSummaryMetric label={copy.cacheHitRate} value={formatPercentageFact(props.runtime.usage.cacheHitRate, props.language)} />
          <RuntimeSummaryMetric label={zh ? '最近请求输出速率' : 'Latest output rate'} value={formatOutputRateFact(props.runtime.performance.latestOutputTokensPerSecond, props.language)} />
          <RuntimeSummaryMetric label={zh ? 'API 等价费用（估算）' : 'API-equivalent cost (est.)'} value={formatCostSummary(props.runtime.usage.apiEquivalentUsd, props.runtime.usage.priceCoverage, costComplete, props.language)} />
        </span>
      </summary>
      <div className="session-runtime-detail-groups">
        <RuntimeDetailGroup title={zh ? '模型设置' : 'Model settings'} kind="session">
          <RuntimeUsageRow label={zh ? '模型' : 'Model'} value={factValue(props.runtime.model, props.language)} />
          <RuntimeUsageRow label={zh ? '推理强度' : 'Reasoning effort'} value={factValue(props.runtime.effort, props.language)} />
          <RuntimeUsageRow label={zh ? '速率' : 'Speed'} value={<ServiceTierValue fact={props.runtime.serviceTier} language={props.language} />} />
        </RuntimeDetailGroup>
        <RuntimeDetailGroup title={zh ? '用量与性能' : 'Usage & performance'} kind="usage">
          <RuntimeUsageRow label={tokenScopeLabel} value={formatTokenFact(props.runtime.usage.totalTokens, props.language, true)} />
          <RuntimeUsageRow label={zh ? '累计输入' : 'Cumulative input'} value={formatTokenFact(props.runtime.usage.inputTokens, props.language, true)} />
          <RuntimeUsageRow label={zh ? '累计输出' : 'Cumulative output'} value={formatTokenFact(props.runtime.usage.outputTokens, props.language, true)} />
          <RuntimeUsageRow label={copy.contextUsage} value={contextUsage} />
          <RuntimeUsageRow label={copy.cacheHitRate} value={formatPercentageFact(props.runtime.usage.cacheHitRate, props.language)} />
          <RuntimeUsageRow label={zh ? '最近输出速率' : 'Latest output rate'} value={formatOutputRateFact(props.runtime.performance.latestOutputTokensPerSecond, props.language)} />
          <RuntimeUsageRow label={zh ? 'API 等价费用（估算）' : 'API-equivalent cost (est.)'} value={formatCoveredCost(props.runtime.usage.apiEquivalentUsd, props.runtime.usage.priceCoverage, props.language)} />
        </RuntimeDetailGroup>
        <RuntimeDetailGroup title={zh ? '环境' : 'Environment'} kind="environment">
          <RuntimeUsageRow wide label={zh ? '工作目录' : 'Working directory'} value={<RuntimeCode fact={props.runtime.environment.cwd} language={props.language} />} />
          <RuntimeUsageRow label={zh ? '工作分支' : 'Working branch'} value={<RuntimeCode fact={props.runtime.environment.branch} language={props.language} />} />
          <RuntimeUsageRow
            label={zh ? '线程 ID' : 'Thread ID'}
            value={<RuntimeCode fact={props.runtime.environment.nativeSessionId} language={props.language} copyLabel={zh ? '复制线程 ID' : 'Copy thread ID'} copiedLabel={zh ? '线程 ID 已复制' : 'Thread ID copied'} />}
          />
          <RuntimeUsageRow
            wide
            label="JSONL"
            value={<RuntimeCode fact={props.runtime.environment.nativeSessionPath} language={props.language} copyLabel={zh ? '复制 JSONL 路径' : 'Copy JSONL path'} copiedLabel={zh ? 'JSONL 路径已复制' : 'JSONL path copied'} />}
          />
          <RuntimeUsageRow label={zh ? 'MCP 启动' : 'MCP startup'} value={props.mcpStartup ? runtimeValueSummary(props.mcpStartup) : unavailableValue(props.language)} />
        </RuntimeDetailGroup>
      </div>
      <div className="session-runtime-detail-footer">
        <button
          type="button"
          className="session-runtime-collapse-button"
          aria-label={zh ? '收起详情' : 'Collapse details'}
          title={zh ? '收起详情' : 'Collapse details'}
          onClick={(event) => {
            // 原生折叠后将焦点交回摘要，避免键盘焦点留在已隐藏的按钮上。
            const details = event.currentTarget.closest('details');
            if (!details) return;
            details.open = false;
            details.querySelector('summary')?.focus({ preventScroll: true });
          }}
        >
          <CaretUp aria-hidden="true" />
        </button>
      </div>
    </details>
  );
}

function ServiceTierValue(props: { fact: NativeRuntimeFact<string | null>; language: SessionUiLanguage }) {
  if (props.fact.state === 'unavailable') return unavailableValue(props.language);
  if (props.fact.value === 'priority' || props.fact.value?.toLowerCase() === 'fast') return props.language === 'zh-CN' ? '快速' : 'Fast';
  return props.fact.value && props.fact.value !== 'default' ? props.fact.value : props.language === 'zh-CN' ? '标准' : 'Standard';
}

function RuntimeSummaryMetric(props: { label: string; value: ReactNode }) {
  return (
    <span className="session-runtime-summary-metric">
      <b>{props.label}</b>
      <span>{props.value}</span>
    </span>
  );
}

/** 每组只保留一份描述列表，由可用宽度决定字段列数。 */
function RuntimeDetailGroup(props: { title: string; kind: 'session' | 'usage' | 'environment'; children: ReactNode }) {
  return (
    <section className="session-runtime-detail-group" data-group={props.kind}>
      <h3>{props.title}</h3>
      <dl className="session-runtime-detail-body">{props.children}</dl>
    </section>
  );
}

/** 长路径独占一行，其余事实共享自适应网格。 */
function RuntimeUsageRow(props: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <div data-wide={props.wide || undefined}>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function RuntimeCode(props: { fact: NativeRuntimeFact<string>; language: SessionUiLanguage; copyLabel?: string; copiedLabel?: string }) {
  if (props.fact.state === 'unavailable') return unavailableValue(props.language);
  return (
    <span className="session-runtime-code-value">
      <code title={props.fact.value}>{props.fact.value}</code>
      {props.copyLabel && props.copiedLabel ? <RuntimeCopyButton text={props.fact.value} label={props.copyLabel} copiedLabel={props.copiedLabel} /> : null}
    </span>
  );
}

function RuntimeCopyButton(props: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="session-runtime-copy-button"
      aria-label={copied ? props.copiedLabel : props.label}
      title={copied ? props.copiedLabel : props.label}
      data-copied={copied || undefined}
      onClick={async () => setCopied(await copyText(props.text))}
    >
      {copied ? <Check aria-hidden="true" weight="bold" /> : <Copy aria-hidden="true" weight="regular" />}
    </button>
  );
}

function factValue<T>(fact: NativeRuntimeFact<T>, language: SessionUiLanguage): ReactNode {
  return fact.state === 'available' ? String(fact.value) : unavailableValue(language);
}

/** 无数据时无需重复提示内部采集过程；字段名称已说明缺少哪项数据。 */
function unavailableValue(language: SessionUiLanguage): ReactNode {
  return (
    <span className="session-runtime-unavailable" aria-label={language === 'zh-CN' ? '暂无数据' : 'Data unavailable'}>
      —
    </span>
  );
}

function formatTokenFact(fact: NativeRuntimeFact<number>, language: SessionUiLanguage, compact = false): ReactNode {
  if (fact.state === 'unavailable') return unavailableValue(language);
  const formatted = formatTokenCount(fact.value, language);
  return (
    <span title={`${formatted.exact} Token`} aria-label={`${formatted.exact} Token`}>
      {compact ? formatted.compact : formatted.exact}
    </span>
  );
}

function formatPercentageFact(fact: NativeRuntimeFact<number>, language: SessionUiLanguage): ReactNode {
  if (fact.state === 'unavailable') return unavailableValue(language);
  return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, fact.value));
}

function formatContextUsage(tokens: NativeRuntimeFact<number>, window: NativeRuntimeFact<number>, language: SessionUiLanguage): ReactNode {
  if (tokens.state === 'unavailable') return unavailableValue(language);
  if (window.state === 'unavailable') return unavailableValue(language);
  if (window.value <= 0) return unavailableValue(language);
  const percentage = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, tokens.value / window.value));
  const used = formatTokenCount(tokens.value, language);
  const total = formatTokenCount(window.value, language);
  return (
    <span title={`${percentage} · ${used.exact} / ${total.exact} Token`} aria-label={`${percentage}, ${used.exact} / ${total.exact} Token`}>
      {percentage} {used.compact} / {total.compact}
    </span>
  );
}

function formatUsdEstimate(value: number, language: SessionUiLanguage): string {
  const formatted = new Intl.NumberFormat(language, { minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: 6 }).format(value);
  return `~$${formatted}`;
}

function formatCostSummary(value: NativeRuntimeFact<number>, coverage: NativeRuntimeFact<number>, complete: boolean, language: SessionUiLanguage): ReactNode {
  if (complete && value.state === 'available') return formatUsdEstimate(value.value, language);
  if (value.state === 'available' && coverage.state === 'available' && coverage.value > 0) return language === 'zh-CN' ? '估算不完整' : 'Estimate incomplete';
  return value.state === 'unavailable' ? unavailableValue(language) : unavailableValue(language);
}

function formatCoveredCost(value: NativeRuntimeFact<number>, coverage: NativeRuntimeFact<number>, language: SessionUiLanguage): ReactNode {
  if (value.state === 'unavailable') return unavailableValue(language);
  const amount = formatUsdEstimate(value.value, language);
  if (coverage.state === 'available' && coverage.value < 1) return `${amount} · ${language === 'zh-CN' ? '已覆盖部分' : 'covered portion'}`;
  return amount;
}

function formatOutputRateFact(fact: NativeRuntimeFact<number>, language: SessionUiLanguage): ReactNode {
  if (fact.state === 'unavailable') return unavailableValue(language);
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: fact.value < 100 ? 1 : 0 }).format(fact.value)} tokens / s`;
}

function runtimeValueNeedsAttention(value: unknown, key = ''): boolean {
  if (typeof value === 'number') return /remaining|available|balance/i.test(key) && value <= 0;
  if (typeof value === 'string') return /^(error|failed|degraded|unavailable|blocked|exhausted)$/i.test(value.trim());
  if (Array.isArray(value)) return value.some((entry) => runtimeValueNeedsAttention(entry, key));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([entryKey, entryValue]) => runtimeValueNeedsAttention(entryValue, entryKey));
}

function runtimeValueSummary(value: Record<string, unknown>): string {
  return runtimeValueFragments(value).join(' · ');
}

function runtimeValueFragments(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => runtimeValueFragments(entry, [...path, String(index + 1)]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => runtimeValueFragments(entry, [...path, key]));
  if (value === null || value === undefined) return [];
  const rawLabel = path.map(humanizeRuntimeKey).join(' ');
  const label = rawLabel ? `${rawLabel.charAt(0).toUpperCase()}${rawLabel.slice(1)}` : 'Value';
  return [`${label}: ${String(value)}`];
}

function humanizeRuntimeKey(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

function runtimeLabels(language: SessionUiLanguage) {
  return language === 'zh-CN' ? { runtimeDetails: '运行详情', contextUsage: '上下文占用', cacheHitRate: '缓存命中率' } : { runtimeDetails: 'Runtime details', contextUsage: 'Context usage', cacheHitRate: 'Cache hit rate' };
}
