import { describeUserFacingError, type GitDeliveryInput, type GitDeliveryRun, type GitDeliveryStep } from '@zeus/shared';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { StopIcon } from '@phosphor-icons/react/dist/csr/Stop';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import './gitDeliveryProgress.css';

/** 操作按钮与进度共用步骤名称，执行前可标明压缩合入。 */
export function gitDeliveryActionLabel(action: GitDeliveryStep['action'], zh: boolean, mode?: GitDeliveryInput['mode']): string {
  if (action === 'merge' && mode === 'squash') return zh ? '压缩合入' : 'Squash merge';
  return {
    commit: zh ? '提交' : 'Commit',
    merge: zh ? '合入' : 'Merge',
    push: zh ? '推送' : 'Push',
    command: zh ? '命令' : 'Command',
    task_status: zh ? '任务状态' : 'Task status',
    conversation_archive: zh ? '归档会话' : 'Archive conversation',
  }[action];
}

/** 两个入口共用失败阶段和脱敏后的具体原因。 */
function gitDeliveryStepErrorSummary(step: GitDeliveryStep, zh: boolean): string | undefined {
  if (step.state === 'unknown') {
    if (step.action === 'push') {
      /** 连接错误由 Git 诊断确认，推送结果仍以远端核对为准。 */
      const diagnostic = `${step.message ?? ''}\n${describeUserFacingError(step.error ?? step.message, zh ? 'zh-CN' : 'en').details}`;
      if (diagnostic.includes('SSL_ERROR_SYSCALL')) {
        /** 诊断包含 GitHub 主机时才显示服务名。 */
        const github = diagnostic.includes('in connection to github.com:');
        return zh ? `${github ? '连接 GitHub 失败' : '连接远端仓库失败'}。点击「继续交付」核对推送结果。` : `Could not connect to ${github ? 'GitHub' : 'the remote repository'}. Select Continue delivery to verify the push.`;
      }
      return zh ? '推送结果待核对，点击「继续交付」检查远端分支。' : 'Push result unconfirmed. Select Continue delivery to check the remote branch.';
    }
    return zh ? '这一步的执行结果尚未确认。' : 'The outcome of this step is unconfirmed.';
  }
  if (!step.error && !step.message) return undefined;
  /** 生成阶段失败时，说明本次尚未进入 Git 提交。 */
  const reason = describeUserFacingError(step.error ?? step.message, zh ? 'zh-CN' : 'en').message;
  if (!step.commitMessageFailed) return reason;
  return zh ? `AI 生成提交说明失败 · ${reason}\nGit 提交尚未执行。` : `AI commit message generation failed · ${reason}\nGit commit has not run.`;
}

/** 结果待核对时用业务状态作摘要，原始命令与连接错误留在完整说明中。 */
export function GitDeliveryStepError({ step, zh, summary }: { step: GitDeliveryStep; zh: boolean; summary?: string }) {
  /** 首屏使用当前界面语言，详情保留真实错误链。 */
  const language = zh ? 'zh-CN' : 'en';
  const visibleSummary = summary ?? (step.state === 'unknown' || step.commitMessageFailed ? gitDeliveryStepErrorSummary(step, zh) : (step.message ?? undefined));
  const cause = step.error ?? step.message;
  if (!cause) return visibleSummary;
  /** 持久步骤已确认写入状态未知，底层连接错误不能覆盖这一事实。 */
  const error = step.state === 'unknown' ? { code: 'ZEUS_GIT_DELIVERY_OUTCOME_UNKNOWN', message: visibleSummary, details: describeUserFacingError(cause, language).details } : cause;
  return <VisibleApplicationError error={error} summary={visibleSummary} title={`${step.repositoryName} · ${gitDeliveryActionLabel(step.action, zh)}`} language={language} />;
}

/** 两个入口显示同一已完成步数，等待和异常不虚增进度。 */
export function GitDeliveryProgress({ run, zh, showErrorSummaries = false }: { run: GitDeliveryRun; zh: boolean; showErrorSummaries?: boolean }) {
  /** 待处理原因优先于其他仓库正在执行的步骤。 */
  const step = run.steps.find((item) => item.state === 'attention' || item.state === 'unknown') ?? run.steps.find((item) => item.state === 'running' || item.state === 'waiting') ?? run.steps.find((item) => item.state === 'pending');
  /** 进度以已成功的持久步骤为单位。 */
  const completed = run.steps.filter((item) => item.state === 'succeeded').length;
  /** 待核对与失败均停止活动动画，保留实际完成比例。 */
  const attention = run.state === 'attention' || step?.state === 'attention' || step?.state === 'unknown';
  /** 结果未知优先提示核对，明确停止时把步数标成已完成进度。 */
  const stopped = run.stopped && !run.stopping && step?.state !== 'unknown';
  const count = `${completed}/${run.steps.length}`;
  const countLabel = stopped ? (zh ? `已完成 ${count}` : `${count} completed`) : count;
  /** 当前动作与仓库名就近显示，任务收尾无需仓库前缀。 */
  const action = step ? gitDeliveryActionLabel(step.action, zh) : '';
  /** 文案依据真实运行状态，不以进度条推测完成。 */
  const label = run.stopping
    ? zh
      ? '正在终止'
      : 'Stopping'
    : run.state === 'queued'
      ? zh
        ? '排队中'
        : 'Queued'
      : step?.state === 'unknown'
        ? zh
          ? '结果待核对'
          : 'Outcome unknown'
        : stopped
          ? zh
            ? '已终止'
            : 'Stopped'
          : attention
            ? zh
              ? '需要处理'
              : 'Needs attention'
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
    'aria-valuetext': [label, detail, countLabel].filter(Boolean).join(' · '),
  };
  /** 同类动作按首次出现顺序汇总，多仓步骤全部成功后才显示完成勾选。 */
  const groups = [...new Set(run.steps.map((item) => item.action))].map((action) => {
    /** 当前动作包含的仓库或命令步骤。 */
    const steps = run.steps.filter((item) => item.action === action);
    /** 分组计数与总进度采用相同的成功状态口径。 */
    const completed = steps.filter((item) => item.state === 'succeeded').length;
    /** 异常优先于活动状态，部分完成不等同于整组完成。 */
    const state = steps.some((item) => item.state === 'unknown' || (item.state === 'attention' && !item.stopped))
      ? 'attention'
      : steps.some((item) => item.stopped)
        ? 'stopped'
        : completed === steps.length
          ? 'succeeded'
          : steps.some((item) => item.state === 'running' || item.state === 'waiting')
            ? 'running'
            : completed
              ? 'partial'
              : 'pending';
    /** 单仓主步骤的名称已在行首显示，多仓原因保留各自的仓库名。 */
    const errors = steps
      .filter((item) => item.state === 'attention' || item.state === 'unknown')
      .flatMap((item) => {
        const reason = gitDeliveryStepErrorSummary(item, zh);
        return reason ? [{ step: item, summary: steps.length > 1 || action !== step?.action ? `${item.repositoryName} · ${reason}` : reason }] : [];
      });
    return { action, completed, total: steps.length, state, errors };
  });
  return (
    <span className="git-delivery-progress" data-delivery-state={stopped ? 'stopped' : attention ? 'attention' : run.state}>
      <span className="git-delivery-progress-heading" {...progressAttributes}>
        <span className="git-delivery-progress-caption" title={[label, detail].filter(Boolean).join(' · ')}>
          <span>{label}</span>
        </span>
        <span className="git-delivery-progress-count">{countLabel}</span>
      </span>
      {groups.length > 0 ? (
        <span className="git-delivery-progress-steps" role="list" aria-label={zh ? '交付步骤' : 'Delivery steps'}>
          {groups.map((group) => (
            <span
              className="git-delivery-progress-step"
              role="listitem"
              data-step-state={group.state}
              aria-current={group.action === step?.action && run.state !== 'queued' && !stopped ? 'step' : undefined}
              key={group.action}
              data-icon-tooltip={!showErrorSummaries && group.errors.length ? group.errors.map((error) => error.summary).join('\n') : undefined}
              tabIndex={!showErrorSummaries && group.errors.length ? 0 : undefined}
              title={group.errors.length ? undefined : `${gitDeliveryActionLabel(group.action, zh)} · ${group.completed}/${group.total}`}
            >
              <span className="git-delivery-progress-step-marker" aria-hidden="true">
                {group.state === 'succeeded' ? (
                  <CheckIcon weight="bold" />
                ) : group.state === 'attention' ? (
                  <WarningCircleIcon />
                ) : group.state === 'stopped' ? (
                  <StopIcon weight="fill" />
                ) : group.state === 'running' ? (
                  <CircleNotchIcon className="git-delivery-progress-spinner" />
                ) : (
                  <span className="git-delivery-progress-step-dot" />
                )}
              </span>
              <span>
                {group.action === step?.action ? detail : gitDeliveryActionLabel(group.action, zh)}
                {showErrorSummaries
                  ? group.errors.map(({ step, summary }) => (
                      <span key={step.id} className="git-delivery-progress-step-error">
                        {step.state === 'unknown' ? <GitDeliveryStepError step={step} zh={zh} summary={summary} /> : summary}
                      </span>
                    ))
                  : null}
              </span>
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
