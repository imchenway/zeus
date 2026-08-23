import type { ReactNode } from 'react';
import type { NativeRuntimeDetailsSnapshot, NativeRuntimeFact } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { formatTokenCount } from './tokenUsageFormat.js';

interface RuntimeDetailsProps {
  runtime: NativeRuntimeDetailsSnapshot;
  language: SessionUiLanguage;
  scope: 'session' | 'subagent';
  mcpStartup?: Record<string, unknown> | null;
}

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
    <details className="session-runtime-details" data-severity={warning ? 'warning' : 'ready'} aria-label={copy.runtimeDetails}>
      <summary>
        <span className="session-runtime-summary-primary">
          <RuntimeSummaryMetric label={tokenScopeLabel} value={formatTokenFact(props.runtime.usage.totalTokens, props.language, true)} />
          <RuntimeSummaryMetric label={copy.contextUsage} value={contextUsage} />
          <RuntimeSummaryMetric label={copy.cacheHitRate} value={formatPercentageFact(props.runtime.usage.cacheHitRate, props.language)} />
          <RuntimeSummaryMetric label={zh ? '最近请求输出速率' : 'Latest output rate'} value={formatOutputRateFact(props.runtime.performance.latestOutputTokensPerSecond, props.language)} />
          <RuntimeSummaryMetric label={zh ? 'API 等价费用（估算）' : 'API-equivalent cost (est.)'} value={formatCostSummary(props.runtime.usage.apiEquivalentUsd, props.runtime.usage.priceCoverage, costComplete, props.language)} />
        </span>
      </summary>
      <div className="session-runtime-detail-groups">
        <RuntimeDetailGroup title={zh ? '使用与费用' : 'Usage and cost'}>
          <RuntimeUsageRow label={zh ? '模型 · 推理强度 · 服务层级' : 'Model · effort · service tier'} value={<ModelRuntimeValue runtime={props.runtime} language={props.language} />} />
          <RuntimeUsageRow label={tokenScopeLabel} value={formatTokenFact(props.runtime.usage.totalTokens, props.language)} />
          <RuntimeUsageRow label={zh ? '累计输入 Token' : 'Input tokens'} value={formatTokenFact(props.runtime.usage.inputTokens, props.language)} />
          <RuntimeUsageRow label={zh ? '累计输出 Token' : 'Output tokens'} value={formatTokenFact(props.runtime.usage.outputTokens, props.language)} />
          <RuntimeUsageRow label={zh ? '累计推理 Token' : 'Reasoning tokens'} value={formatTokenFact(props.runtime.usage.reasoningOutputTokens, props.language)} />
          <RuntimeUsageRow label={copy.contextUsage} value={contextUsage} />
          <RuntimeUsageRow label={copy.cacheHitRate} value={formatPercentageFact(props.runtime.usage.cacheHitRate, props.language)} />
          <RuntimeUsageRow label={zh ? 'API 等价费用（估算）' : 'API-equivalent cost (est.)'} value={formatCoveredCost(props.runtime.usage.apiEquivalentUsd, props.runtime.usage.priceCoverage, props.language)} />
          <RuntimeUsageRow label={zh ? '价格覆盖率' : 'Price coverage'} value={formatPercentageFact(props.runtime.usage.priceCoverage, props.language)} />
          <RuntimeUsageRow label={zh ? '价格目录日期' : 'Price catalog date'} value={factValue(props.runtime.usage.pricingCatalogDate, props.language)} />
          <RuntimeUsageRow label={zh ? '价格来源' : 'Pricing source'} value={<PricingSources fact={props.runtime.usage.pricingSourceUrls} language={props.language} />} />
          <RuntimeUsageRow label={zh ? '费用完整性' : 'Cost completeness'} value={formatHistoryComplete(props.runtime.usage.historyComplete, props.language)} />
        </RuntimeDetailGroup>
        <RuntimeDetailGroup title={zh ? '性能与活动' : 'Performance and activity'}>
          <RuntimeUsageRow label={zh ? '最近输出速率' : 'Latest output rate'} value={formatOutputRateFact(props.runtime.performance.latestOutputTokensPerSecond, props.language)} />
          <RuntimeUsageRow label={zh ? '最近首段可见响应延迟' : 'Latest first visible response'} value={formatDurationFact(props.runtime.performance.latestFirstVisibleResponseMs, props.language)} />
          <RuntimeUsageRow label={zh ? '累计处理耗时' : 'Cumulative processing time'} value={formatDurationFact(props.runtime.performance.cumulativeProcessedDurationMs, props.language)} />
          <RuntimeUsageRow label={zh ? '轮次' : 'Turns'} value={factValue(props.runtime.activity.turnCount, props.language)} />
          <RuntimeUsageRow label={zh ? '模型请求' : 'Model requests'} value={factValue(props.runtime.activity.modelRequestCount, props.language)} />
          <RuntimeUsageRow label={zh ? '工具 / 命令' : 'Tools / commands'} value={factValue(props.runtime.activity.toolOrCommandCount, props.language)} />
          <RuntimeUsageRow label={zh ? '重试' : 'Retries'} value={factValue(props.runtime.activity.retryCount, props.language)} />
          <RuntimeUsageRow label={zh ? '失败轮次' : 'Failed turns'} value={factValue(props.runtime.activity.failedTurnCount, props.language)} />
          <RuntimeUsageRow label={zh ? '代码改动' : 'Code changes'} value={formatChangeSummary(props.runtime.changeSummary, props.language)} />
        </RuntimeDetailGroup>
        <RuntimeDetailGroup title={zh ? '环境' : 'Environment'}>
          <RuntimeUsageRow label={zh ? '工作目录' : 'Working directory'} value={<RuntimeCode fact={props.runtime.environment.cwd} language={props.language} />} />
          <RuntimeUsageRow label={zh ? '分支' : 'Branch'} value={<RuntimeCode fact={props.runtime.environment.branch} language={props.language} />} />
          <RuntimeUsageRow label={zh ? '线程 ID' : 'Thread ID'} value={<RuntimeCode fact={props.runtime.environment.nativeSessionId} language={props.language} />} />
          <RuntimeUsageRow label="JSONL" value={<RuntimeCode fact={props.runtime.environment.nativeSessionPath} language={props.language} />} />
          {props.mcpStartup ? <RuntimeUsageRow label={zh ? 'MCP 启动' : 'MCP startup'} value={runtimeValueSummary(props.mcpStartup)} /> : null}
        </RuntimeDetailGroup>
      </div>
    </details>
  );
}

function ModelRuntimeValue(props: { runtime: NativeRuntimeDetailsSnapshot; language: SessionUiLanguage }) {
  const parts: ReactNode[] = [
    factValue(props.runtime.model, props.language),
    factValue(props.runtime.effort, props.language),
    props.runtime.serviceTier.state === 'available'
      ? props.runtime.serviceTier.value && props.runtime.serviceTier.value !== 'default'
        ? props.runtime.serviceTier.value
        : props.language === 'zh-CN'
          ? '标准'
          : 'Standard'
      : unavailableValue(props.runtime.serviceTier.reason, props.language),
  ];
  return parts.map((part, index) => (
    <span key={index}>
      {index > 0 ? ' · ' : null}
      {part}
    </span>
  ));
}

function RuntimeSummaryMetric(props: { label: string; value: ReactNode }) {
  return (
    <span className="session-runtime-summary-metric">
      <b>{props.label}</b>
      <span>{props.value}</span>
    </span>
  );
}

function RuntimeDetailGroup(props: { title: string; children: ReactNode }) {
  return (
    <section className="session-runtime-detail-group">
      <h3>{props.title}</h3>
      <dl>{props.children}</dl>
    </section>
  );
}

function RuntimeUsageRow(props: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function RuntimeCode(props: { fact: NativeRuntimeFact<string>; language: SessionUiLanguage }) {
  return props.fact.state === 'available' ? <code title={props.fact.value}>{props.fact.value}</code> : unavailableValue(props.fact.reason, props.language);
}

function PricingSources(props: { fact: NativeRuntimeFact<string[]>; language: SessionUiLanguage }) {
  if (props.fact.state === 'unavailable') return unavailableValue(props.fact.reason, props.language);
  if (props.fact.value.length === 0) return unavailableValue(props.language === 'zh-CN' ? '没有可用的价格来源。' : 'No pricing source is available.', props.language);
  return props.fact.value.map((source, index) => (
    <span key={source}>
      {index > 0 ? ' · ' : null}
      <a href={source} target="_blank" rel="noreferrer">
        {pricingSourceLabel(source, index)}
      </a>
    </span>
  ));
}

function pricingSourceLabel(source: string, index: number): string {
  try {
    return new URL(source).hostname;
  } catch {
    return `source ${index + 1}`;
  }
}

function factValue<T>(fact: NativeRuntimeFact<T>, language: SessionUiLanguage): ReactNode {
  return fact.state === 'available' ? String(fact.value) : unavailableValue(fact.reason, language);
}

function unavailableValue(reason: string, language: SessionUiLanguage): ReactNode {
  return <span title={reason}>{language === 'zh-CN' ? '暂无数据' : 'Unavailable'}</span>;
}

function formatTokenFact(fact: NativeRuntimeFact<number>, language: SessionUiLanguage, compact = false): ReactNode {
  if (fact.state === 'unavailable') return unavailableValue(fact.reason, language);
  const formatted = formatTokenCount(fact.value, language);
  return `${compact ? formatted.compact : formatted.exact} Token`;
}

function formatPercentageFact(fact: NativeRuntimeFact<number>, language: SessionUiLanguage): ReactNode {
  if (fact.state === 'unavailable') return unavailableValue(fact.reason, language);
  return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, fact.value));
}

function formatContextUsage(tokens: NativeRuntimeFact<number>, window: NativeRuntimeFact<number>, language: SessionUiLanguage): ReactNode {
  if (tokens.state === 'unavailable') return unavailableValue(tokens.reason, language);
  if (window.state === 'unavailable') return unavailableValue(window.reason, language);
  if (window.value <= 0) return unavailableValue(language === 'zh-CN' ? '上下文窗口为 0，无法计算占用率。' : 'Context window is zero.', language);
  const percentage = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, tokens.value / window.value));
  return `${percentage} · ${formatTokenCount(tokens.value, language).compact} / ${formatTokenCount(window.value, language).compact} Token`;
}

function formatUsdEstimate(value: number, language: SessionUiLanguage): string {
  const formatted = new Intl.NumberFormat(language, { minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: 6 }).format(value);
  return `~$${formatted}`;
}

function formatCostSummary(value: NativeRuntimeFact<number>, coverage: NativeRuntimeFact<number>, complete: boolean, language: SessionUiLanguage): ReactNode {
  if (complete && value.state === 'available') return formatUsdEstimate(value.value, language);
  if (value.state === 'available' && coverage.state === 'available' && coverage.value > 0) return language === 'zh-CN' ? '估算不完整' : 'Estimate incomplete';
  return value.state === 'unavailable' ? unavailableValue(value.reason, language) : unavailableValue(language === 'zh-CN' ? '费用覆盖率不可确认。' : 'Cost coverage is unavailable.', language);
}

function formatCoveredCost(value: NativeRuntimeFact<number>, coverage: NativeRuntimeFact<number>, language: SessionUiLanguage): ReactNode {
  if (value.state === 'unavailable') return unavailableValue(value.reason, language);
  const amount = formatUsdEstimate(value.value, language);
  if (coverage.state === 'available' && coverage.value < 1) return `${amount} · ${language === 'zh-CN' ? '已覆盖部分' : 'covered portion'}`;
  return amount;
}

function formatOutputRateFact(fact: NativeRuntimeFact<number>, language: SessionUiLanguage): ReactNode {
  if (fact.state === 'unavailable') return unavailableValue(fact.reason, language);
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: fact.value < 100 ? 1 : 0 }).format(fact.value)} tokens/s`;
}

function formatDurationFact(fact: NativeRuntimeFact<number>, language: SessionUiLanguage): ReactNode {
  if (fact.state === 'unavailable') return unavailableValue(fact.reason, language);
  const value = fact.value;
  if (value < 1_000) return `${Math.round(value)} ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${new Intl.NumberFormat(language, { maximumFractionDigits: seconds < 10 ? 1 : 0 }).format(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} min ${remainingSeconds} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function formatChangeSummary(fact: NativeRuntimeDetailsSnapshot['changeSummary'], language: SessionUiLanguage): ReactNode {
  if (fact.state === 'unavailable') return unavailableValue(fact.reason, language);
  const { fileCount, addedLines, deletedLines, complete } = fact.value;
  const value = `${fileCount} ${language === 'zh-CN' ? '个文件' : fileCount === 1 ? 'file' : 'files'} · +${addedLines} / -${deletedLines}`;
  return complete ? value : `${value} · ${language === 'zh-CN' ? '部分统计' : 'partial'}`;
}

function formatHistoryComplete(fact: NativeRuntimeFact<boolean>, language: SessionUiLanguage): ReactNode {
  if (fact.state === 'unavailable') return unavailableValue(fact.reason, language);
  return fact.value ? (language === 'zh-CN' ? '完整' : 'Complete') : language === 'zh-CN' ? '估算不完整' : 'Estimate incomplete';
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
