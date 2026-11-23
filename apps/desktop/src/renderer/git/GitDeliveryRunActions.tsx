import { useRef, useState } from 'react';
import type { GitDeliveryRun } from '@zeus/shared';
import type { DashboardClient } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { FormDialog } from '../ui/FormDialog.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

/** 卡片和交付窗口复用同一清理确认，继续操作不能绕过工作树删除确认。 */
export function GitDeliveryCleanupConfirmation(props: { run: GitDeliveryRun; zh: boolean; busy: boolean; error: unknown; onClose(): void; onConfirm(): void | Promise<void> }) {
  return (
    <FormDialog
      danger
      title={props.zh ? '确认任务结束清理' : 'Confirm task cleanup'}
      description={props.zh ? '该状态变更需要停止并归档任务会话，并永久移除任务工作树。未提交的修改会被删除。' : 'This status change stops and archives task sessions and permanently removes task worktrees, including uncommitted changes.'}
      zh={props.zh}
      busy={props.busy}
      submitLabel={props.zh ? '确认清理并继续' : 'Confirm cleanup and continue'}
      onClose={props.onClose}
      onSubmit={(event) => {
        event.preventDefault();
        return props.onConfirm();
      }}
    >
      {props.run.steps
        .filter((step) => step.cleanupConfirmation)
        .map((step) => (
          <p key={step.id}>
            {props.zh
              ? `有修改的工作区：${step.cleanupConfirmation!.dirtyWorkspaceCount}；活动会话：${step.cleanupConfirmation!.activeConversationCount}；活动运行：${step.cleanupConfirmation!.activeRuntimeSessionCount}`
              : `${step.cleanupConfirmation!.dirtyWorkspaceCount} modified worktrees; ${step.cleanupConfirmation!.activeConversationCount} active conversations; ${step.cleanupConfirmation!.activeRuntimeSessionCount} active runtimes`}
          </p>
        ))}
      {props.error ? <VisibleApplicationError error={props.error} language={props.zh ? 'zh-CN' : 'en'} /> : null}
    </FormDialog>
  );
}

/** 两个入口共用终止和继续，后端接纳后立即更新原交付记录。 */
export function GitDeliveryRunActions(props: {
  client: Pick<DashboardClient, 'stopGitDeliveryRun' | 'resumeGitDeliveryRun'>;
  run: GitDeliveryRun;
  zh: boolean;
  disabled?: boolean;
  /** 完整交付窗口保留冲突页共用的继续与确认状态。 */
  onResume?: (run: GitDeliveryRun) => Promise<void>;
  onUpdated?: (run: GitDeliveryRun) => void | Promise<void>;
}) {
  /** 同一帧连续点击也只能提交一个控制请求。 */
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  /** 继续只作用于当前运行，后端核对最新身份并重新排队。 */
  async function control(action: 'stop' | 'resume', confirm = false): Promise<void> {
    if (pending.current || props.disabled || props.run.stopping) return;
    if (action === 'resume' && !props.onResume && !confirm && props.run.steps.some((step) => step.state === 'attention' && step.cleanupConfirmation)) {
      setConfirmCleanup(true);
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action === 'resume' && props.onResume) await props.onResume(props.run);
      else {
        const run =
          action === 'stop' ? await props.client.stopGitDeliveryRun(props.run.projectId, props.run.id) : await props.client.resumeGitDeliveryRun(props.run.projectId, props.run.id, confirm ? { confirmWorktreeCleanup: true } : undefined);
        await props.onUpdated?.(run);
      }
      setConfirmCleanup(false);
    } catch (cause) {
      setError(cause);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  if (props.run.state === 'succeeded') return null;
  return (
    <div className="git-delivery-run-actions">
      {props.run.stopping || !props.run.stopped ? (
        <Button size="compact" disabled={busy || props.disabled || props.run.stopping} onClick={() => control('stop')}>
          {props.run.stopping ? (props.zh ? '正在终止…' : 'Stopping…') : props.zh ? '终止' : 'Stop'}
        </Button>
      ) : null}
      {props.run.state === 'attention' && !props.run.stopping ? (
        <Button size="compact" disabled={busy || props.disabled} onClick={() => control('resume')}>
          {props.zh ? '继续交付' : 'Continue delivery'}
        </Button>
      ) : null}
      {error ? (
        <span role="alert">
          <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} />
        </span>
      ) : null}
      {confirmCleanup ? <GitDeliveryCleanupConfirmation run={props.run} zh={props.zh} busy={busy} error={error} onClose={() => setConfirmCleanup(false)} onConfirm={() => control('resume', true)} /> : null}
    </div>
  );
}
