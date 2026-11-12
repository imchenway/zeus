import { describeUserFacingError, type GitDeliveryRun, type GitDeliveryStep } from '@zeus/shared';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import './gitDeliveryProgress.css';

/** 固定步骤名称同时用于操作按钮与执行进度。 */
export function gitDeliveryActionLabel(action: GitDeliveryStep['action'], zh: boolean): string {
  return {
    commit: zh ? '提交' : 'Commit',
    merge: zh ? '合入' : 'Merge',
    push: zh ? '推送' : 'Push',
    command: zh ? '命令' : 'Command',
    task_status: zh ? '任务状态' : 'Task status',
    conversation_archive: zh ? '归档会话' : 'Archive conversation',
  }[action];
}

/** 两个入口显示同一已完成步数，等待和异常不虚增进度。 */
export function GitDeliveryProgress({ run, zh }: { run: GitDeliveryRun; zh: boolean }) {
  /** 待处理原因优先于其他仓库正在执行的步骤。 */
  const step = run.steps.find((item) => item.state === 'attention' || item.state === 'unknown') ?? run.steps.find((item) => item.state === 'running' || item.state === 'waiting') ?? run.steps.find((item) => item.state === 'pending');
  /** 进度以已成功的持久步骤为单位。 */
  const completed = run.steps.filter((item) => item.state === 'succeeded').length;
  /** 待核对与失败均停止活动动画，保留实际完成比例。 */
  const attention = run.state === 'attention' || step?.state === 'attention' || step?.state === 'unknown';
  /** 当前动作与仓库名就近显示，任务收尾无需仓库前缀。 */
  const action = step ? gitDeliveryActionLabel(step.action, zh) : '';
  /** 文案依据真实运行状态，不以进度条推测完成。 */
  const label =
    step?.state === 'unknown'
      ? zh
        ? '结果待核对'
        : 'Outcome unknown'
      : attention
        ? zh
          ? '需要处理'
          : 'Needs attention'
        : run.state === 'queued'
          ? zh
            ? '等待执行'
            : 'Queued'
          : run.state === 'succeeded'
            ? zh
              ? '已完成'
              : 'Completed'
            : step?.state === 'waiting'
              ? step.action === 'command'
                ? zh
                  ? '命令运行中'
                  : 'Command running'
                : zh
                  ? 'AI 处理中'
                  : 'AI running'
              : zh
                ? '执行中'
                : 'Running';
  /** 命令名称由步骤快照提供，多仓交付保留当前仓库名称。 */
  const detail = step?.repositoryName && step.action !== 'task_status' && step.action !== 'conversation_archive' ? `${action} · ${step.repositoryName}` : action;
  /** 时间线摘要向辅助技术提供实际完成数量和当前动作。 */
  const progressAttributes = {
    role: 'progressbar' as const,
    'aria-label': zh ? '代码交付进度' : 'Code delivery progress',
    'aria-valuemin': 0,
    'aria-valuemax': Math.max(1, run.steps.length),
    'aria-valuenow': completed,
    'aria-valuetext': [label, detail, `${completed}/${run.steps.length}`].filter(Boolean).join(' · '),
  };
  /** 同类动作按首次出现顺序汇总，多仓步骤全部成功后才显示完成勾选。 */
  const groups = [...new Set(run.steps.map((item) => item.action))].map((action) => {
    /** 当前动作包含的仓库或命令步骤。 */
    const steps = run.steps.filter((item) => item.action === action);
    /** 分组计数与总进度采用相同的成功状态口径。 */
    const completed = steps.filter((item) => item.state === 'succeeded').length;
    /** 异常优先于活动状态，部分完成不等同于整组完成。 */
    const state = steps.some((item) => item.state === 'attention' || item.state === 'unknown')
      ? 'attention'
      : completed === steps.length
        ? 'succeeded'
        : steps.some((item) => item.state === 'running' || item.state === 'waiting')
          ? 'running'
          : completed
            ? 'partial'
            : 'pending';
    /** 异常原因沿用共享错误解释器，多仓问题逐行保留所属对象。 */
    const errorSummary = steps
      .filter((item) => item.state === 'attention' || item.state === 'unknown')
      .map((item) => {
        /** 无原因时保留实际状态，不把待核对结果写成执行失败。 */
        const reason = item.error || item.message ? describeUserFacingError(item.error ?? item.message, zh ? 'zh-CN' : 'en').message : item.state === 'unknown' ? (zh ? '结果待核对' : 'Outcome unknown') : zh ? '需要处理' : 'Needs attention';
        return [item.repositoryName, reason].filter(Boolean).join(' · ');
      })
      .join('\n');
    return { action, completed, total: steps.length, state, errorSummary };
  });
  return (
    <span className="git-delivery-progress" data-delivery-state={attention ? 'attention' : run.state}>
      <span className="git-delivery-progress-heading" {...progressAttributes}>
        <span className="git-delivery-progress-caption" title={[label, detail].filter(Boolean).join(' · ')}>
          <span>{label}</span>
        </span>
        <span className="git-delivery-progress-count">
          {completed}/{run.steps.length}
        </span>
      </span>
      {groups.length > 0 ? (
        <span className="git-delivery-progress-steps" role="list" aria-label={zh ? '交付步骤' : 'Delivery steps'}>
          {groups.map((group) => (
            <span
              className="git-delivery-progress-step"
              role="listitem"
              data-step-state={group.state}
              aria-current={group.action === step?.action && run.state !== 'queued' ? 'step' : undefined}
              key={group.action}
              data-icon-tooltip={group.errorSummary || undefined}
              tabIndex={group.errorSummary ? 0 : undefined}
              title={group.errorSummary ? undefined : `${gitDeliveryActionLabel(group.action, zh)} · ${group.completed}/${group.total}`}
            >
              <span className="git-delivery-progress-step-marker" aria-hidden="true">
                {group.state === 'succeeded' ? (
                  <CheckIcon weight="bold" />
                ) : group.state === 'attention' ? (
                  <WarningCircleIcon />
                ) : group.state === 'running' ? (
                  <CircleNotchIcon className="git-delivery-progress-spinner" />
                ) : (
                  <span className="git-delivery-progress-step-dot" />
                )}
              </span>
              <span>{group.action === step?.action ? detail : gitDeliveryActionLabel(group.action, zh)}</span>
              {group.total > 1 ? (
                <span className="git-delivery-progress-step-count">
                  {group.completed}/{group.total}
                </span>
              ) : null}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
