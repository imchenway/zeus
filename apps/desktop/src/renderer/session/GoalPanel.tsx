import { useEffect, useId, useState } from 'react';
import { ModalPortal } from '../ui/ModalPortal.js';
import type { NativeGoalCapability, NativeGoalSnapshot, NativeGoalTimelineEvent } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

interface GoalPanelProps {
  open: boolean;
  language: SessionUiLanguage;
  goal: NativeGoalSnapshot | null;
  timeline: NativeGoalTimelineEvent[];
  capability: NativeGoalCapability;
  busy?: boolean;
  error?: string | null;
  initialObjective?: string;
  draftOnly?: boolean;
  onDismiss: () => void;
  onSave: (objective: string) => void | Promise<void>;
  onPause?: () => void | Promise<void>;
  onResume?: () => void | Promise<void>;
  onClear?: (confirmUnfinished: boolean) => void | Promise<void>;
}

const statusLabels: Record<NativeGoalSnapshot['status'], { zh: string; en: string }> = {
  active: { zh: '执行中', en: 'Active' },
  paused: { zh: '已暂停', en: 'Paused' },
  blocked: { zh: '需要处理', en: 'Blocked' },
  usageLimited: { zh: '用量受限', en: 'Usage limited' },
  budgetLimited: { zh: '预算受限', en: 'Budget limited' },
  complete: { zh: '已完成', en: 'Complete' },
};

const eventLabels: Record<NativeGoalTimelineEvent['kind'], { zh: string; en: string }> = {
  created: { zh: '创建目标', en: 'Goal created' },
  edited: { zh: '编辑目标', en: 'Goal edited' },
  paused: { zh: '暂停自动续跑', en: 'Auto-continuation paused' },
  resumed: { zh: '恢复自动续跑', en: 'Auto-continuation resumed' },
  blocked: { zh: '目标受阻', en: 'Goal blocked' },
  usage_limited: { zh: '用量受限', en: 'Usage limited' },
  budget_limited: { zh: '预算受限', en: 'Budget limited' },
  completed: { zh: '目标完成', en: 'Goal completed' },
  cleared: { zh: '清除目标', en: 'Goal cleared' },
};

export function GoalPanel(props: GoalPanelProps) {
  const zh = props.language === 'zh-CN';
  const titleId = useId();
  const descriptionId = useId();
  const [objective, setObjective] = useState(props.goal?.objective ?? props.initialObjective ?? '');
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setObjective(props.goal?.objective ?? props.initialObjective ?? '');
    setConfirmClear(false);
  }, [props.goal?.objective, props.initialObjective, props.open]);

  if (!props.open) return null;
  const count = [...objective.trim()].length;
  const valid = count > 0 && count <= 4_000;
  const unfinished = Boolean(props.goal && props.goal.status !== 'complete');

  return (
    <ModalPortal rootClassName="session-goal-portal-root" backdropClassName="session-goal-backdrop" dismissDisabled={props.busy} onDismiss={props.onDismiss}>
      <section className="session-goal-panel zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header className="session-goal-panel-header">
          <div>
            <span className="session-goal-eyebrow">{zh ? '持续执行' : 'Continuous work'}</span>
            <h2 id={titleId}>{props.goal ? (zh ? '目标' : 'Goal') : zh ? '创建目标' : 'Create goal'}</h2>
          </div>
          {props.goal ? <span className={`session-goal-status is-${props.goal.status}`}>{statusLabels[props.goal.status][zh ? 'zh' : 'en']}</span> : null}
        </header>
        <p id={descriptionId} className="session-goal-description">
          {zh ? '写清要达成什么、不能改什么、如何验证，以及何时停止。目标独立于普通或 PLAN 协作模式。' : 'Describe the outcome, boundaries, validation, and stopping condition. Goals are independent of collaboration mode.'}
        </p>
        <label className="session-goal-objective-field">
          <span>{zh ? '目标内容' : 'Objective'}</span>
          <textarea autoFocus value={objective} disabled={props.busy || props.goal?.status === 'complete'} onChange={(event) => setObjective(event.currentTarget.value)} />
          <small className={count > 4_000 ? 'is-invalid' : undefined}>{count} / 4000</small>
        </label>
        {props.goal ? (
          <dl className="session-goal-metrics" aria-label={zh ? '目标用量' : 'Goal usage'}>
            <div>
              <dt>{zh ? '运行时间' : 'Time used'}</dt>
              <dd>{formatDuration(props.goal.timeUsedSeconds, zh)}</dd>
            </div>
            <div>
              <dt>{zh ? '已用令牌' : 'Tokens used'}</dt>
              <dd>{new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US').format(props.goal.tokensUsed)}</dd>
            </div>
            <div>
              <dt>{zh ? '令牌预算' : 'Token budget'}</dt>
              <dd>{props.goal.tokenBudget === null ? (zh ? '未设置' : 'Not set') : new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US').format(props.goal.tokenBudget)}</dd>
            </div>
          </dl>
        ) : null}
        {props.error ? (
          <p className="session-goal-error" role="alert">
            {props.error}
          </p>
        ) : null}
        {confirmClear ? (
          <section className="session-goal-clear-confirm" role="alertdialog" aria-label={zh ? '确认清除目标' : 'Confirm goal clear'}>
            <strong>{zh ? '清除后将停止后续自动续跑' : 'Clearing stops future auto-continuation'}</strong>
            <p>{zh ? '当前轮次不会被中断；会话和目标时间线仍会保留，但目标不能直接恢复。' : 'The current turn will continue. Conversation and goal history remain, but the goal cannot be restored directly.'}</p>
            <button type="button" className="is-danger" disabled={props.busy} onClick={() => void props.onClear?.(unfinished)}>
              {zh ? '确认清除' : 'Clear goal'}
            </button>
            <button type="button" disabled={props.busy} onClick={() => setConfirmClear(false)}>
              {zh ? '取消' : 'Cancel'}
            </button>
          </section>
        ) : null}
        {!props.draftOnly && props.timeline.length > 0 ? (
          <section className="session-goal-timeline" aria-label={zh ? '目标时间线' : 'Goal timeline'}>
            <h3>{zh ? '时间线' : 'Timeline'}</h3>
            <ol>
              {[...props.timeline].reverse().map((event) => (
                <li key={event.id}>
                  <span>{eventLabels[event.kind][zh ? 'zh' : 'en']}</span>
                  <time dateTime={event.occurredAt}>{new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(event.occurredAt))}</time>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        <footer className="session-goal-panel-actions">
          <button type="button" onClick={props.onDismiss} disabled={props.busy}>
            {zh ? '关闭' : 'Close'}
          </button>
          {props.goal && props.goal.status === 'active' ? (
            <button type="button" onClick={() => void props.onPause?.()} disabled={props.busy}>
              {zh ? '暂停' : 'Pause'}
            </button>
          ) : null}
          {props.goal && props.goal.status !== 'active' && props.goal.status !== 'complete' ? (
            <button type="button" onClick={() => void props.onResume?.()} disabled={props.busy}>
              {zh ? '恢复' : 'Resume'}
            </button>
          ) : null}
          {props.goal && props.onClear ? (
            <button type="button" className="is-danger-quiet" onClick={() => setConfirmClear(true)} disabled={props.busy}>
              {zh ? '清除' : 'Clear'}
            </button>
          ) : null}
          {props.goal?.status !== 'complete' ? (
            <button type="button" className="is-primary" onClick={() => void props.onSave(objective.trim())} disabled={props.busy || !valid || objective.trim() === props.goal?.objective}>
              {props.busy ? (zh ? '保存中…' : 'Saving…') : props.goal ? (zh ? '保存' : 'Save') : zh ? '创建目标' : 'Create goal'}
            </button>
          ) : null}
        </footer>
      </section>
    </ModalPortal>
  );
}

export function GoalRail(props: { goal: NativeGoalSnapshot; language: SessionUiLanguage; onOpen: () => void }) {
  const zh = props.language === 'zh-CN';
  return (
    <button type="button" className="session-goal-rail" aria-haspopup="dialog" onClick={props.onOpen}>
      <span className={`session-goal-status-dot is-${props.goal.status}`} aria-hidden="true" />
      <span className="session-goal-rail-copy">
        <strong>{statusLabels[props.goal.status][zh ? 'zh' : 'en']}</strong>
        <span>{props.goal.objective}</span>
      </span>
      <span className="session-goal-rail-meta">
        {formatDuration(props.goal.timeUsedSeconds, zh)} · {new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US', { notation: 'compact' }).format(props.goal.tokensUsed)} tokens
      </span>
    </button>
  );
}

function formatDuration(seconds: number, zh: boolean): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (hours > 0) return zh ? `${hours} 小时 ${minutes} 分钟` : `${hours}h ${minutes}m`;
  return zh ? `${minutes} 分钟` : `${minutes}m`;
}
