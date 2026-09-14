import { Button } from '../ui/Button.js';
import { Collapsible } from '../ui/Collapsible.js';
import { useEffect, useId, useState } from 'react';
import { ModalPortal } from '../ui/ModalPortal.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import type { NativeGoalCapability, NativeGoalSnapshot, NativeGoalTimelineEvent } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

/** 目标详情的状态与操作由会话统一提供。 */
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
  onSave?: (objective: string) => void | boolean | Promise<void | boolean>;
  onPause?: () => void | boolean | Promise<void | boolean>;
  onResume?: () => void | boolean | Promise<void | boolean>;
  onClear?: (confirmUnfinished: boolean) => void | boolean | Promise<void | boolean>;
}

/** 目标状态使用一致的中英文文案。 */
const statusLabels: Record<NativeGoalSnapshot['status'], { zh: string; en: string }> = {
  active: { zh: '执行中', en: 'Active' },
  paused: { zh: '已暂停', en: 'Paused' },
  blocked: { zh: '需要处理', en: 'Blocked' },
  usageLimited: { zh: '用量受限', en: 'Usage limited' },
  budgetLimited: { zh: '预算受限', en: 'Budget limited' },
  complete: { zh: '已完成', en: 'Complete' },
};

/** 时间线事件使用面向用户的操作名称。 */
const eventLabels: Record<NativeGoalTimelineEvent['kind'], { zh: string; en: string }> = {
  created: { zh: '创建目标', en: 'Goal created' },
  edited: { zh: '编辑目标', en: 'Goal edited' },
  paused: { zh: '暂停后续自动执行', en: 'Pause further automatic work' },
  resumed: { zh: '继续自动执行', en: 'Resume automatic work' },
  blocked: { zh: '目标受阻', en: 'Goal blocked' },
  usage_limited: { zh: '用量受限', en: 'Usage limited' },
  budget_limited: { zh: '预算受限', en: 'Budget limited' },
  completed: { zh: '目标完成', en: 'Goal completed' },
  cleared: { zh: '清除目标', en: 'Goal cleared' },
};

/** 目标详情复用公共弹窗和按钮，暂停后直接提供继续执行入口。 */
export function GoalPanel(props: GoalPanelProps) {
  /** 当前界面语言。 */
  const zh = props.language === 'zh-CN';
  /** 弹窗标题的无障碍关联标识。 */
  const titleId = useId();
  /** 弹窗说明的无障碍关联标识。 */
  const descriptionId = useId();
  /** 保留尚未提交的目标编辑内容。 */
  const [objective, setObjective] = useState(props.goal?.objective ?? props.initialObjective ?? '');
  /** 清除目标前显示已有确认区域。 */
  const [confirmClear, setConfirmClear] = useState(false);
  useApplicationErrorDialog(props.error, {
    language: zh ? 'zh-CN' : 'en',
  });

  useEffect(() => {
    if (!props.open) return;
    setObjective(props.goal?.objective ?? props.initialObjective ?? '');
    setConfirmClear(false);
  }, [props.goal?.objective, props.initialObjective, props.open]);

  if (!props.open) return null;
  /** 按 Unicode 字符计算目标长度。 */
  const count = [...objective.trim()].length;
  /** 提交沿用目标长度限制。 */
  const valid = count > 0 && count <= 4_000;
  /** 未完成目标清除时需要确认。 */
  const unfinished = Boolean(props.goal && props.goal.status !== 'complete');

  /** 恢复入口只在当前状态允许且存在实际操作时显示。 */
  const canResume = Boolean(props.goal && props.goal.status !== 'active' && props.goal.status !== 'complete' && props.onResume);
  /** 编辑内容未保存时保留保存作为主操作，避免继续执行旧目标。 */
  const dirty = objective.trim() !== (props.goal?.objective ?? '');
  /** 能力或操作缺失时只展示详情，不渲染空回调按钮。 */
  const readOnly = !props.capability.supported || !props.capability.enabled || !(props.onSave || props.onPause || props.onResume || props.onClear);

  return (
    <ModalPortal rootClassName="session-goal-portal-root" backdropClassName="session-goal-backdrop" dismissDisabled={props.busy} onDismiss={props.onDismiss} role="dialog" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <section className="session-goal-panel zeus-solid-form-surface" data-modal-surface="dialog">
        <header className="session-goal-panel-header">
          <div>
            <h2 id={titleId}>{props.goal ? (zh ? '目标' : 'Goal') : zh ? '创建目标' : 'Create goal'}</h2>
          </div>
          {props.goal ? <span className={`session-goal-status is-${props.goal.status}`}>{statusLabels[props.goal.status][zh ? 'zh' : 'en']}</span> : null}
        </header>
        <p id={descriptionId} className="session-goal-description">
          {readOnly
            ? zh
              ? '当前会话仅可查看目标。'
              : 'This conversation allows viewing the goal only.'
            : props.goal?.status === 'paused'
              ? zh
                ? '后续自动执行已暂停，点击继续执行可恢复。'
                : 'Automatic work is paused. Resume to continue.'
              : props.goal?.status === 'blocked'
                ? zh
                  ? '自动执行遇到阻碍，请查看会话中的原因，处理后继续执行。'
                  : 'Automatic work is blocked. Check the conversation, resolve the issue, then resume.'
                : props.goal
                  ? zh
                    ? '查看执行状态，或调整目标内容。'
                    : 'Review progress or edit the objective.'
                  : zh
                    ? '写清要达成什么、不能改什么、如何验证，以及何时停止。'
                    : 'Describe the goal, constraints, verification, and when to stop.'}
        </p>
        <label className="session-goal-objective-field">
          <span>{zh ? '目标内容' : 'Objective'}</span>
          <textarea autoFocus={!props.goal} value={objective} readOnly={readOnly || !props.onSave || props.goal?.status === 'complete'} disabled={props.busy} onChange={(event) => setObjective(event.currentTarget.value)} />
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
        <Collapsible open={confirmClear}>
          <section className="session-goal-clear-confirm" role="alertdialog" aria-label={zh ? '确认清除目标' : 'Confirm goal clear'}>
            <strong>{zh ? '清除后将不再自动继续执行此目标' : 'Clearing the goal stops further automatic work toward it'}</strong>
            <p>{zh ? '当前轮次不会被中断；会话和目标时间线仍会保留，但目标不能直接恢复。' : 'The current turn will continue. Conversation and goal history remain, but the goal cannot be restored directly.'}</p>
            <Button variant="danger" disabled={props.busy} onClick={() => void props.onClear?.(unfinished)}>
              {zh ? '确认清除' : 'Clear goal'}
            </Button>
            <Button disabled={props.busy} onClick={() => setConfirmClear(false)}>
              {zh ? '取消' : 'Cancel'}
            </Button>
          </section>
        </Collapsible>
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
        {canResume && dirty ? <p className="session-goal-description">{zh ? '请先保存修改，再继续执行。' : 'Save your changes before resuming.'}</p> : null}
        {props.busy ? (
          <p className="session-goal-description" role="status">
            {zh ? '正在更新目标…' : 'Updating goal…'}
          </p>
        ) : null}
        <footer className="session-goal-panel-actions" aria-busy={props.busy || undefined}>
          {!readOnly && props.goal && props.onClear ? (
            <Button size="compact" variant="danger" className="session-goal-clear-action" onClick={() => setConfirmClear(true)} disabled={props.busy}>
              {zh ? '清除' : 'Clear'}
            </Button>
          ) : null}
          <Button size="compact" onClick={props.onDismiss} disabled={props.busy}>
            {zh ? '关闭' : 'Close'}
          </Button>
          {!readOnly && props.goal && props.goal.status === 'active' && props.onPause ? (
            <Button size="compact" onClick={() => void props.onPause?.()} disabled={props.busy}>
              {zh ? '暂停执行' : 'Pause'}
            </Button>
          ) : null}
          {!readOnly && canResume ? (
            <Button size="compact" variant={dirty ? 'secondary' : 'primary'} onClick={() => void props.onResume?.()} disabled={props.busy || dirty}>
              {zh ? '继续执行' : 'Resume'}
            </Button>
          ) : null}
          {!readOnly && props.onSave && props.goal?.status !== 'complete' && (!props.goal || dirty) ? (
            <Button size="compact" variant="primary" onClick={() => void props.onSave?.(objective.trim())} disabled={props.busy || !valid || objective.trim() === props.goal?.objective}>
              {props.goal ? (zh ? '保存修改' : 'Save changes') : zh ? '创建目标' : 'Create goal'}
            </Button>
          ) : null}
        </footer>
      </section>
    </ModalPortal>
  );
}

/** 目标摘要与输入框共用宽度约束，点击进入详情。 */
export function GoalRail(props: { goal: NativeGoalSnapshot; language: SessionUiLanguage; onOpen: () => void }) {
  /** 当前界面语言。 */
  const zh = props.language === 'zh-CN';
  return (
    <button type="button" className="session-goal-rail" aria-haspopup="dialog" onClick={props.onOpen}>
      <span className={`session-goal-status-dot is-${props.goal.status}`} aria-hidden="true" />
      <span className="session-goal-rail-copy">
        <strong>{statusLabels[props.goal.status][zh ? 'zh' : 'en']}</strong>
        <span title={props.goal.objective}>{props.goal.objective}</span>
      </span>
      <span className="session-goal-rail-meta">
        {formatDuration(props.goal.timeUsedSeconds, zh)} · {new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US', { notation: 'compact' }).format(props.goal.tokensUsed)} {zh ? '令牌' : 'tokens'}
      </span>
    </button>
  );
}

/** 运行时长按分钟展示，保持摘要与详情一致。 */
function formatDuration(seconds: number, zh: boolean): string {
  /** 负时长归零后按整秒计算。 */
  const total = Math.max(0, Math.floor(seconds));
  /** 已运行的完整小时数。 */
  const hours = Math.floor(total / 3_600);
  /** 不足一小时的分钟数。 */
  const minutes = Math.floor((total % 3_600) / 60);
  if (hours > 0) return zh ? `${hours} 小时 ${minutes} 分钟` : `${hours}h ${minutes}m`;
  return zh ? `${minutes} 分钟` : `${minutes}m`;
}
