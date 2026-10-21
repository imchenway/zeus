import type { ConversationInformation, EstimatedMoney } from '@zeus/shared';
import { InfoIcon as Info } from '@phosphor-icons/react/dist/csr/Info';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { PopoverSurface } from '../ui/MotionPresence.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import type { NativeRuntimeDetailsSnapshot, NativeRuntimeFact } from './sessionTypes.js';
import { copyText, type SessionUiLanguage } from './ThreadItemView.js';
import { formatTokenCount } from './tokenUsageFormat.js';

/** 主会话和智能体共用信息浮层，环境字段保留各自已有的入口。 */
interface RuntimeDetailsProps {
  /** 已有实时指标不需要等待浮层补载。 */
  runtime: NativeRuntimeDetailsSnapshot;
  /** 显示语言。 */
  language: SessionUiLanguage;
  /** 决定累计指标名称与智能体环境补充。 */
  scope: 'session' | 'subagent';
  /** 完整费用与使用记录只在打开后读取。 */
  onLoadInformation?: (signal: AbortSignal) => Promise<ConversationInformation>;
  /** 智能体历史已经读取时直接复用其工具事实。 */
  resources?: ConversationInformation['resources'];
}

/** 原生浮层不参与正文排版，关闭、外部点击与 Esc 由浏览器统一处理。 */
export function RuntimeDetails(props: RuntimeDetailsProps) {
  /** 每个工作面的锚点独立，避免抽屉和底层页面互相定位。 */
  const id = useId();
  /** 锚点名称只使用 React 身份，不包含业务路径。 */
  const anchor = `--session-information-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  /** 浮层展开状态控制按需读取与无障碍状态。 */
  const [open, setOpen] = useState(false);
  /** 只保存当前挂载会话的完整明细。 */
  const [information, setInformation] = useState<ConversationInformation | null>(null);
  /** 失败事实由共享错误组件展示。 */
  const [error, setError] = useState<unknown>(null);
  /** 重试只重读浮层，不重建正文。 */
  const [reload, setReload] = useState(0);
  /** 最新读取入口不让每次文本增量重新触发请求。 */
  const loadRef = useRef(props.onLoadInformation);
  useEffect(() => {
    loadRef.current = props.onLoadInformation;
  });
  /** 请求完成或工具数量变化时，已打开的明细重新核对。 */
  const revision = `${numberFact(props.runtime.usage.totalTokens)}:${numberFact(props.runtime.activity.toolOrCommandCount)}`;
  useEffect(() => {
    if (!open || !loadRef.current) return;
    /** 关闭和切换后不让旧结果回写新会话。 */
    const abort = new AbortController();
    // 同一会话刷新期间保留已读明细，避免列表短暂清空和浮层高度跳动。
    setError(null);
    void loadRef
      .current(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setInformation(value);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(cause);
      });
    return () => abort.abort();
  }, [open, revision, reload]);
  /** 所有标签共用同一语言分支。 */
  const zh = props.language === 'zh-CN';
  /** 主入口只显示图标，名称保留给悬浮提示与读屏。 */
  const title = zh ? '会话信息' : 'Conversation information';
  /** 价格合计沿用已有币种与历史完整性口径。 */
  const costs = props.runtime.usage.costs?.length ? props.runtime.usage.costs : props.runtime.usage.apiEquivalentUsd.state === 'available' ? [{ currency: 'USD', amount: props.runtime.usage.apiEquivalentUsd.value }] : [];
  /** 缺价或历史不完整不能被展示为完整账单。 */
  const complete = props.runtime.usage.priceCoverage.state === 'available' && props.runtime.usage.priceCoverage.value === 1 && props.runtime.usage.historyComplete.state === 'available' && props.runtime.usage.historyComplete.value;
  /** 明细区只显示当前会话可确认的使用记录。 */
  const resources = information?.resources ?? props.resources;
  /** 简短提示同时供鼠标和键盘读取。 */
  const tokenHint = `${zh ? '累计输入' : 'Total input'}: ${tokenText(props.runtime.usage.inputTokens, props.language, false)}\n${zh ? '累计输出' : 'Total output'}: ${tokenText(props.runtime.usage.outputTokens, props.language, false)}`;
  /** 未完成读取时不将缺失明细显示成零费用。 */
  const costHint = information
    ? costBreakdownText(information.cost, props.language)
    : zh
      ? error
        ? '费用明细读取失败'
        : props.onLoadInformation
          ? '正在读取费用明细…'
          : '暂无费用明细'
      : error
        ? 'Cost details could not be loaded'
        : props.onLoadInformation
          ? 'Loading cost details…'
          : 'Cost details unavailable';
  return (
    <>
      <button type="button" className="session-information-trigger" aria-label={title} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} data-icon-tooltip={title} popoverTarget={id} style={{ anchorName: anchor }}>
        <Info aria-hidden="true" />
      </button>
      <PopoverSurface
        id={id}
        popover="auto"
        role="dialog"
        aria-labelledby={`${id}-title`}
        className="session-information-popover"
        style={{ positionAnchor: anchor }}
        onToggle={(event) => setOpen(event.currentTarget.matches(':popover-open'))}
      >
        <header>
          <strong id={`${id}-title`}>{title}</strong>
          <button type="button" popoverTarget={id} popoverTargetAction="hide" aria-label={zh ? '关闭会话信息' : 'Close conversation information'} data-icon-tooltip={zh ? '关闭' : 'Close'}>
            <X aria-hidden="true" />
          </button>
        </header>
        <dl className="session-information-metrics">
          <RuntimeUsageRow label={props.scope === 'subagent' ? (zh ? '智能体累计 Token' : 'Agent tokens') : zh ? '累计 Token' : 'Session tokens'} value={tokenText(props.runtime.usage.totalTokens, props.language)} hint={tokenHint} />
          <RuntimeUsageRow label={zh ? '费用' : 'Cost'} value={costs.length ? `${formatRuntimeCosts(costs, props.language)}${complete ? '' : zh ? ' · 部分' : ' · partial'}` : '—'} hint={costHint} />
          <RuntimeUsageRow
            label={zh ? '输出速率' : 'Output rate'}
            value={
              numberFact(props.runtime.performance.latestOutputTokensPerSecond) === null
                ? '—'
                : `${new Intl.NumberFormat(props.language, { maximumFractionDigits: 1 }).format(numberFact(props.runtime.performance.latestOutputTokensPerSecond)!)} tokens / s`
            }
          />
          <RuntimeUsageRow
            label={zh ? '缓存命中率' : 'Cache hit rate'}
            value={numberFact(props.runtime.usage.cacheHitRate) === null ? '—' : new Intl.NumberFormat(props.language, { style: 'percent', maximumFractionDigits: 1 }).format(numberFact(props.runtime.usage.cacheHitRate)!)}
          />
        </dl>
        <dl className="session-information-identities">
          <RuntimeUsageRow
            label={zh ? '线程 ID' : 'Thread ID'}
            value={<RuntimeCode fact={props.runtime.environment.nativeSessionId} language={props.language} copyLabel={zh ? '复制线程 ID' : 'Copy thread ID'} copiedLabel={zh ? '线程 ID 已复制' : 'Thread ID copied'} />}
          />
          <RuntimeUsageRow
            label="JSONL"
            value={<RuntimeCode fact={props.runtime.environment.nativeSessionPath} language={props.language} copyLabel={zh ? '复制 JSONL 路径' : 'Copy JSONL path'} copiedLabel={zh ? 'JSONL 路径已复制' : 'JSONL path copied'} />}
          />
          {props.scope === 'subagent' ? (
            <>
              <RuntimeUsageRow
                label={zh ? '工作目录' : 'Directory'}
                value={<RuntimeCode fact={props.runtime.environment.cwd} language={props.language} copyLabel={zh ? '复制工作目录' : 'Copy directory'} copiedLabel={zh ? '工作目录已复制' : 'Directory copied'} />}
              />
              <RuntimeUsageRow
                label={zh ? '工作分支' : 'Branch'}
                value={<RuntimeCode fact={props.runtime.environment.branch} language={props.language} copyLabel={zh ? '复制工作分支' : 'Copy branch'} copiedLabel={zh ? '工作分支已复制' : 'Branch copied'} />}
              />
            </>
          ) : null}
        </dl>
        <div className="session-information-resources">
          <RuntimeResourceList label={zh ? '已触发 MCP' : 'MCP tools used'} values={resources?.mcp} language={props.language} loading={Boolean(props.onLoadInformation && !information && !error)} />
          <RuntimeResourceList label={zh ? '已使用 Skills' : 'Skills used'} values={resources?.skills} language={props.language} loading={Boolean(props.onLoadInformation && !information && !error)} />
          <p>{zh ? '仅展示会话中已记录的使用。' : 'Only recorded usage in this conversation is shown.'}</p>
          {error ? (
            <div className="session-information-error">
              <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
              <button type="button" onClick={() => setReload((value) => value + 1)}>
                {zh ? '重试' : 'Retry'}
              </button>
            </div>
          ) : null}
        </div>
      </PopoverSurface>
    </>
  );
}

/** 指标提示使用全局悬浮管理器，并支持键盘聚焦读取。 */
function RuntimeUsageRow(props: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>
        <span tabIndex={props.hint ? 0 : undefined} data-icon-tooltip={props.hint}>
          {props.value}
        </span>
      </dd>
    </div>
  );
}

/** 长清单在浮层内展开，不增加正文或环境卡片的高度。 */
function RuntimeResourceList(props: { label: string; values?: string[]; language: SessionUiLanguage; loading: boolean }) {
  return (
    <details>
      <summary>
        {props.label}
        <span>{props.loading ? '…' : (props.values?.length ?? '—')}</span>
      </summary>
      {props.values?.length ? (
        <ul>
          {props.values.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      ) : (
        <p>
          {props.loading
            ? props.language === 'zh-CN'
              ? '读取中…'
              : 'Loading…'
            : props.values
              ? props.language === 'zh-CN'
                ? '暂无已记录的使用'
                : 'No recorded usage'
              : props.language === 'zh-CN'
                ? '使用记录暂不可用'
                : 'Usage records unavailable'}
        </p>
      )}
    </details>
  );
}

/** 无数据保持缺失状态，不将未知值转换为零。 */
function numberFact(fact: NativeRuntimeFact<number>): number | null {
  return fact.state === 'available' ? fact.value : null;
}

/** 指标使用紧凑数字，悬浮明细保留完整数量。 */
function tokenText(fact: NativeRuntimeFact<number>, language: SessionUiLanguage, compact = true): string {
  if (fact.state !== 'available') return '—';
  /** 复用累计用量的统一格式。 */
  const value = formatTokenCount(fact.value, language);
  return compact ? value.compact : value.exact;
}

/** 费用明细保留按次项目及缺价提示，不将无法拆分的费用归给输入。 */
function costBreakdownText(cost: ConversationInformation['cost'], language: SessionUiLanguage): string {
  /** 标签与主浮层保持同一种语言。 */
  const zh = language === 'zh-CN';
  return [
    `${zh ? '输入（含缓存）' : 'Input (including cache)'}: ${cost.input.length ? formatRuntimeCosts(cost.input, language) : '—'}`,
    `${zh ? '输出' : 'Output'}: ${cost.output.length ? formatRuntimeCosts(cost.output, language) : '—'}`,
    ...(cost.perRequest.length ? [`${zh ? '按次费用' : 'Per-request cost'}: ${formatRuntimeCosts(cost.perRequest, language)}`] : []),
    ...(cost.complete ? [] : [zh ? '部分用量缺少价格，明细不完整' : 'Some usage has no price; breakdown is incomplete']),
  ].join('\n');
}

/** 缺失标识保留可访问说明。 */
function unavailableValue(language: SessionUiLanguage): ReactNode {
  return (
    <span className="session-runtime-unavailable" aria-label={language === 'zh-CN' ? '暂无数据' : 'Data unavailable'}>
      —
    </span>
  );
}

/** 长值按首尾两段显示，由容器宽度决定中间省略；提示与复制保留原文。 */
function RuntimeCode(props: { fact: NativeRuntimeFact<string>; language: SessionUiLanguage; copyLabel?: string; copiedLabel?: string }) {
  if (props.fact.state === 'unavailable') return unavailableValue(props.language);
  /** 按完整字符拆分，避免拆开代理对。 */
  const characters = Array.from(props.fact.value);
  /** 首尾均保留内容，溢出时只在两段交界处省略。 */
  const midpoint = Math.ceil(characters.length / 2);
  return (
    <span className="session-runtime-code-value">
      <code data-icon-tooltip={props.fact.value} aria-label={props.fact.value}>
        <span className="session-runtime-code-start" aria-hidden="true">
          {characters.slice(0, midpoint).join('')}
        </span>
        <span className="session-runtime-code-end" aria-hidden="true">
          <span>{characters.slice(midpoint).join('')}</span>
        </span>
      </code>
      {props.copyLabel && props.copiedLabel ? <RuntimeCopyButton text={props.fact.value} label={props.copyLabel} copiedLabel={props.copiedLabel} /> : null}
    </span>
  );
}

/** 运行标识与环境字段共用复制反馈。 */
export function RuntimeCopyButton(props: { text: string; label: string; copiedLabel: string }) {
  /** 复制完成后短暂保留成功反馈。 */
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    /** 反馈到期后恢复复制入口。 */
    const timer = setTimeout(() => setCopied(false), 1_400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="session-runtime-copy-button"
      aria-label={copied ? props.copiedLabel : props.label}
      data-icon-tooltip={copied ? props.copiedLabel : props.label}
      data-copied={copied || undefined}
      onClick={async () => setCopied(await copyText(props.text))}
    >
      {copied ? <Check aria-hidden="true" weight="bold" /> : <Copy aria-hidden="true" weight="regular" />}
    </button>
  );
}

/** 美元估算沿用会话现有的小额展示规则。 */
function formatUsdEstimate(value: number, language: SessionUiLanguage): string {
  /** 会话费用与菜单栏保持一致，固定显示两位小数。 */
  const formatted = new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  /** 非零的小额费用保留“低于一分”的事实，不显示成零。 */
  return value > 0 && value < 0.01 ? '~<$0.01' : `~$${formatted}`;
}

/** 会话费用统一以波浪号表达估算属性；美元使用符号，其他币种保留代码避免歧义。 */
function formatRuntimeCosts(costs: EstimatedMoney[], language: SessionUiLanguage): string {
  return costs
    .map(({ currency, amount }) =>
      currency === 'USD' ? formatUsdEstimate(amount, language) : `~${currency} ${amount > 0 && amount < 0.01 ? '<0.01' : new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`,
    )
    .join(' + ');
}
