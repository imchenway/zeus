import { useEffect, useMemo, useState } from 'react';
import { ZeusApiError, type DashboardClient, type TaskRecord } from '../apiClient.js';
import type { TaskIntegrationConflictFile, TaskIntegrationRecord, TaskWorkspaceSnapshot, TaskWorkspacesSnapshot } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { ZeusSelect } from '../ZeusSelect.js';

type MergeClient = Pick<
  DashboardClient,
  'loadTaskGitWorkspaces' | 'loadTaskIntegrations' | 'startTaskIntegration' | 'loadTaskIntegrationConflict' | 'resolveTaskIntegrationConflict' | 'assistTaskIntegrationConflict' | 'finalizeTaskIntegration'
>;

export function TaskGitMergeModal(props: {
  open: boolean;
  language: 'zh-CN' | 'en-US';
  task: TaskRecord | null;
  projectName?: string;
  client: MergeClient | null;
  onChanged?: () => void | Promise<void>;
  onPrepareWorkspace?: (taskId: string, workspaceId: string) => void;
  onClose: () => void;
}) {
  const zh = props.language === 'zh-CN';
  const [workspaces, setWorkspaces] = useState<TaskWorkspacesSnapshot | null>(null);
  const [integrations, setIntegrations] = useState<TaskIntegrationRecord[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [target, setTarget] = useState<'source' | 'current'>('source');
  const [mode, setMode] = useState<'merge' | 'squash'>('merge');
  const [integration, setIntegration] = useState<TaskIntegrationRecord | null>(null);
  const [conflictPath, setConflictPath] = useState('');
  const [conflict, setConflict] = useState<TaskIntegrationConflictFile | null>(null);
  const [resultContent, setResultContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedWorkspace = workspaces?.items.find((workspace) => workspace.id === workspaceId) ?? null;
  const activeConflict = integration?.state === 'conflicted' ? integration : null;
  const needsPreparation = selectedWorkspace?.state === 'ready' || selectedWorkspace?.state === 'failed';
  const canIntegrate = selectedWorkspace?.state === 'reclaimed' || selectedWorkspace?.state === 'merged';
  const discarded = selectedWorkspace?.state === 'discarded';
  const workspaceOptions = useMemo(
    () =>
      workspaces?.items.map((workspace) => ({
        value: workspace.id,
        label: `${workspace.branchName} · ${workspaceStateLabel(workspace, zh)}`,
      })) ?? [],
    [workspaces?.items, zh],
  );
  const targetOptions = useMemo(() => {
    if (!selectedWorkspace) return [];
    const values: Array<{ value: 'source' | 'current'; label: string }> = [{ value: 'source', label: zh ? `来源分支 · ${selectedWorkspace.sourceBranch}` : `Source branch · ${selectedWorkspace.sourceBranch}` }];
    if (workspaces?.primaryBranch && workspaces.primaryBranch !== selectedWorkspace.sourceBranch) {
      values.push({ value: 'current', label: zh ? `主工作区当前分支 · ${workspaces.primaryBranch}` : `Primary current branch · ${workspaces.primaryBranch}` });
    }
    return values;
  }, [selectedWorkspace, workspaces?.primaryBranch, zh]);

  useEffect(() => {
    if (!props.open || !props.task || !props.client) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    void Promise.all([props.client.loadTaskGitWorkspaces(props.task.id), props.client.loadTaskIntegrations(props.task.id)])
      .then(([workspaceSnapshot, integrationSnapshot]) => {
        if (cancelled) return;
        setWorkspaces(workspaceSnapshot);
        setIntegrations(integrationSnapshot.items);
        const conflicted = integrationSnapshot.items.find((candidate) => candidate.state === 'conflicted');
        const firstWorkspace =
          workspaceSnapshot.items.find((workspace) => workspace.id === conflicted?.workspaceId) ??
          workspaceSnapshot.items.find((workspace) => workspace.state === 'ready' || workspace.state === 'failed') ??
          workspaceSnapshot.items.find((workspace) => workspace.state === 'reclaimed') ??
          workspaceSnapshot.items[0];
        setWorkspaceId(firstWorkspace?.id ?? '');
        setIntegration(conflicted ?? null);
        setConflictPath(conflicted?.conflictFiles[0] ?? '');
        setBusy(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setBusy(false);
        setError(errorMessage(reason, zh));
      });
    return () => {
      cancelled = true;
    };
  }, [props.open, props.task?.id, props.client]);

  useEffect(() => {
    if (!props.task || !props.client || !activeConflict || !conflictPath) {
      setConflict(null);
      setResultContent('');
      return;
    }
    let cancelled = false;
    setBusy(true);
    void props.client
      .loadTaskIntegrationConflict(props.task.id, activeConflict.id, conflictPath)
      .then((next) => {
        if (cancelled) return;
        setConflict(next);
        setResultContent(next.result);
        setBusy(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setBusy(false);
        setError(errorMessage(reason, zh));
      });
    return () => {
      cancelled = true;
    };
  }, [props.task?.id, props.client, activeConflict?.id, conflictPath]);

  if (!props.open || !props.task) return null;

  async function reload(): Promise<void> {
    if (!props.task || !props.client) return;
    const [workspaceSnapshot, integrationSnapshot] = await Promise.all([props.client.loadTaskGitWorkspaces(props.task.id), props.client.loadTaskIntegrations(props.task.id)]);
    setWorkspaces(workspaceSnapshot);
    setIntegrations(integrationSnapshot.items);
  }

  async function start(): Promise<void> {
    if (!props.task || !props.client || !selectedWorkspace || !canIntegrate) return;
    setBusy(true);
    setError(null);
    try {
      const response = await props.client.startTaskIntegration(props.task.id, selectedWorkspace.id, { target, mode });
      setIntegration(response.integration);
      setConflictPath(response.integration.conflictFiles[0] ?? '');
      await reload();
      await props.onChanged?.();
      setBusy(false);
    } catch (reason) {
      setBusy(false);
      setError(errorMessage(reason, zh));
    }
  }

  async function saveResolution(): Promise<void> {
    if (!props.task || !props.client || !activeConflict || !conflictPath) return;
    setBusy(true);
    setError(null);
    try {
      const response = await props.client.resolveTaskIntegrationConflict(props.task.id, activeConflict.id, conflictPath, resultContent);
      setIntegration(response.integration);
      const nextPath = response.result.remainingConflictFiles[0] ?? '';
      setConflictPath(nextPath);
      if (!nextPath) setConflict(null);
      await reload();
      await props.onChanged?.();
      setBusy(false);
    } catch (reason) {
      setBusy(false);
      setError(errorMessage(reason, zh));
    }
  }

  async function askCodex(): Promise<void> {
    if (!props.task || !props.client || !activeConflict || !conflictPath) return;
    setBusy(true);
    setError(null);
    try {
      const response = await props.client.assistTaskIntegrationConflict(props.task.id, activeConflict.id, conflictPath);
      setResultContent(response.suggestedContent);
      setBusy(false);
    } catch (reason) {
      setBusy(false);
      setError(errorMessage(reason, zh));
    }
  }

  async function finalize(): Promise<void> {
    if (!props.task || !props.client || !integration) return;
    setBusy(true);
    setError(null);
    try {
      const response = await props.client.finalizeTaskIntegration(props.task.id, integration.id);
      setIntegration(response.integration);
      await reload();
      await props.onChanged?.();
      setBusy(false);
    } catch (reason) {
      setBusy(false);
      setError(errorMessage(reason, zh));
    }
  }

  function selectWorkspace(nextId: string): void {
    setWorkspaceId(nextId);
    const conflicted = integrations.find((candidate) => candidate.workspaceId === nextId && candidate.state === 'conflicted');
    setIntegration(conflicted ?? null);
    setConflictPath(conflicted?.conflictFiles[0] ?? '');
    setTarget('source');
  }

  const selectedTargetBranch = target === 'current' ? workspaces?.primaryBranch : selectedWorkspace?.sourceBranch;
  const alreadyDelivered =
    Boolean(selectedWorkspace && selectedTargetBranch) &&
    (target === 'source' ? selectedWorkspace?.state === 'merged' : integrations.some((candidate) => candidate.workspaceId === selectedWorkspace?.id && candidate.targetBranch === selectedTargetBranch && candidate.state === 'merged'));
  const resultLabel = deliveryResultLabel({ workspace: selectedWorkspace, alreadyDelivered, zh });
  const preparationSteps = deliveryPreparationSteps(selectedWorkspace, zh);

  return (
    <ModalPortal rootClassName="task-git-merge-portal-root" backdropClassName="task-git-merge-backdrop" dismissDisabled={busy} onDismiss={props.onClose}>
      <section className={`task-git-merge-modal${activeConflict ? ' is-conflicted' : ''}`} role="dialog" aria-modal="true" aria-labelledby="task-git-merge-title">
        <header className="task-git-merge-header">
          <span>
            <strong id="task-git-merge-title">{activeConflict ? (zh ? '解决合入冲突' : 'Resolve Merge Conflicts') : zh ? '代码交付' : 'Code Delivery'}</strong>
            <small>
              {props.projectName ? `${props.projectName} · ` : ''}
              {props.task.taskCode ?? props.task.id} · {props.task.title}
            </small>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={busy}>
            ×
          </button>
        </header>

        {activeConflict ? (
          <div className="task-git-conflict-layout">
            <aside className="task-git-conflict-files">
              <strong>
                {zh ? '冲突文件' : 'Conflicted files'} <small>{activeConflict.conflictFiles.length}</small>
              </strong>
              {activeConflict.conflictFiles.map((path) => (
                <button key={path} type="button" className={path === conflictPath ? 'is-active' : ''} onClick={() => setConflictPath(path)}>
                  {path}
                </button>
              ))}
            </aside>
            <main className="task-git-conflict-editor">
              <div className="task-git-conflict-toolbar">
                <span>
                  <strong>{conflictPath}</strong>
                  <small>{zh ? `左：${activeConflict.targetBranch} · 右：${selectedWorkspace?.branchName ?? ''}` : `Left: ${activeConflict.targetBranch} · Right: ${selectedWorkspace?.branchName ?? ''}`}</small>
                </span>
                <span>
                  <Button variant="secondary" size="compact" onClick={() => conflict && setResultContent(conflict.source)} disabled={!conflict || busy}>
                    {zh ? '采用来源' : 'Accept source'}
                  </Button>
                  <Button variant="secondary" size="compact" onClick={() => conflict && setResultContent(conflict.task)} disabled={!conflict || busy}>
                    {zh ? '采用任务' : 'Accept task'}
                  </Button>
                  <Button variant="secondary" size="compact" onClick={() => conflict && setResultContent(`${conflict.source}${conflict.source.endsWith('\n') ? '' : '\n'}${conflict.task}`)} disabled={!conflict || busy}>
                    {zh ? '两者都采用' : 'Accept both'}
                  </Button>
                  <Button variant="secondary" size="compact" onClick={() => void askCodex()} disabled={!conflict || busy}>
                    {zh ? '请 Codex 协助' : 'Ask Codex'}
                  </Button>
                </span>
              </div>
              <div className="task-git-conflict-columns">
                <ConflictCodePane title={zh ? '来源分支' : 'Source branch'} content={conflict?.source ?? ''} />
                <label>
                  <strong>{zh ? '合并结果' : 'Merge result'}</strong>
                  <textarea value={resultContent} onChange={(event) => setResultContent(event.target.value)} disabled={!conflict || busy} spellCheck={false} />
                </label>
                <ConflictCodePane title={zh ? '任务分支' : 'Task branch'} content={conflict?.task ?? ''} />
              </div>
            </main>
          </div>
        ) : (
          <div className="task-git-merge-body">
            <section className="task-git-merge-flow">
              <span>
                <small>{zh ? '任务分支' : 'Task branch'}</small>
                <strong>{selectedWorkspace?.branchName ?? '—'}</strong>
              </span>
              <b>→</b>
              <span>
                <small>{zh ? '目标分支' : 'Target branch'}</small>
                <strong>{target === 'current' ? workspaces?.primaryBranch : (selectedWorkspace?.sourceBranch ?? '—')}</strong>
              </span>
              <b>→</b>
              <span>
                <small>{zh ? '结果' : 'Result'}</small>
                <strong>{resultLabel}</strong>
              </span>
            </section>

            <section className="task-git-merge-config">
              <label>
                <span>{zh ? '任务分支' : 'Task branch'}</span>
                <ZeusSelect size="regular" ariaLabel={zh ? '任务分支' : 'Task branch'} value={workspaceId} options={workspaceOptions} onChange={selectWorkspace} disabled={busy || workspaceOptions.length === 0} />
              </label>
              <label>
                <span>{zh ? '合入到' : 'Merge into'}</span>
                <ZeusSelect size="regular" ariaLabel={zh ? '合入目标' : 'Merge target'} value={target} options={targetOptions} onChange={setTarget} disabled={busy || !canIntegrate} searchable={false} />
              </label>
              <label>
                <span>{zh ? '方式' : 'Method'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '合入方式' : 'Merge method'}
                  value={mode}
                  options={[
                    { value: 'merge', label: zh ? 'Merge · 保留任务提交历史' : 'Merge · preserve task commits' },
                    { value: 'squash', label: zh ? 'Squash · 合并为一个提交' : 'Squash · one target commit' },
                  ]}
                  onChange={setMode}
                  disabled={busy || !canIntegrate}
                  searchable={false}
                />
              </label>
            </section>

            <section className="task-git-merge-preflight">
              <strong>{deliveryStageTitle(selectedWorkspace, zh)}</strong>
              <ol>
                {preparationSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {selectedWorkspace?.lastError ? <small className="task-git-merge-stage-error">{selectedWorkspace.lastError}</small> : null}
            </section>
          </div>
        )}

        {error ? (
          <p className="task-git-merge-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="task-git-merge-footer">
          <Button variant="secondary" size="regular" onClick={props.onClose} disabled={busy}>
            {zh ? '关闭' : 'Close'}
          </Button>
          {activeConflict ? (
            activeConflict.conflictFiles.length > 0 ? (
              <Button variant="primary" size="regular" busy={busy} onClick={() => void saveResolution()} disabled={!conflict || !resultContent}>
                {zh ? '保存结果并继续' : 'Save result and continue'}
              </Button>
            ) : (
              <Button variant="primary" size="regular" busy={busy} onClick={() => void finalize()}>
                {zh ? '完成合入并推送' : 'Finish merge and push'}
              </Button>
            )
          ) : needsPreparation ? (
            <Button variant="primary" size="regular" onClick={() => selectedWorkspace && props.task && props.onPrepareWorkspace?.(props.task.id, selectedWorkspace.id)} disabled={busy || !selectedWorkspace || !props.onPrepareWorkspace}>
              {zh ? '审查并准备交付…' : 'Review and prepare delivery…'}
            </Button>
          ) : discarded ? (
            <Button variant="primary" size="regular" disabled>
              {zh ? '分支已放弃' : 'Branch discarded'}
            </Button>
          ) : (
            <Button variant="primary" size="regular" busy={busy} onClick={() => void start()} disabled={!selectedWorkspace || !canIntegrate || alreadyDelivered}>
              {alreadyDelivered ? (zh ? `已交付到 ${selectedTargetBranch}` : `Delivered to ${selectedTargetBranch}`) : zh ? '合入并推送' : 'Merge and Push'}
            </Button>
          )}
        </footer>
      </section>
    </ModalPortal>
  );
}

function workspaceStateLabel(workspace: TaskWorkspaceSnapshot, zh: boolean): string {
  const labels = zh
    ? { ready: '待准备', reclaimed: '待合入', merged: '已交付', discarded: '已放弃', failed: '需要处理' }
    : { ready: 'Preparation required', reclaimed: 'Ready to merge', merged: 'Delivered', discarded: 'Discarded', failed: 'Action required' };
  return labels[workspace.state];
}

function deliveryResultLabel(input: { workspace: TaskWorkspaceSnapshot | null; alreadyDelivered: boolean; zh: boolean }): string {
  if (!input.workspace) return '—';
  if (input.alreadyDelivered) return input.zh ? '已交付' : 'Delivered';
  if (input.workspace.state === 'ready' || input.workspace.state === 'failed') return input.zh ? '提交、推送并回收' : 'Commit, push, and reclaim';
  if (input.workspace.state === 'discarded') return input.zh ? '不可交付' : 'Unavailable';
  return input.zh ? '合入并推送' : 'Merge and push';
}

function deliveryStageTitle(workspace: TaskWorkspaceSnapshot | null, zh: boolean): string {
  if (!workspace) return zh ? '正在读取任务分支' : 'Loading task branch';
  if (workspace.state === 'ready') return zh ? '当前分支需要先准备代码交付' : 'Prepare this branch for code delivery first';
  if (workspace.state === 'failed') return zh ? '上次分支操作失败，请重新审查' : 'The previous branch operation failed; review it again';
  if (workspace.state === 'discarded') return zh ? '当前分支已经放弃' : 'This branch was discarded';
  if (workspace.state === 'merged') return zh ? '当前分支已有交付记录' : 'This branch has a delivery record';
  return zh ? '当前分支已准备完成，可以合入' : 'This branch is prepared and ready to merge';
}

function deliveryPreparationSteps(workspace: TaskWorkspaceSnapshot | null, zh: boolean): string[] {
  if (!workspace) return [zh ? '等待任务工作区状态返回。' : 'Wait for the task workspace state.'];
  if (workspace.state === 'ready' || workspace.state === 'failed') {
    return zh
      ? ['审查当前 worktree 的全部变更与活动会话。', '提交并推送任务分支，校验远端提交与本地 HEAD 一致。', '回收 worktree 后返回代码交付，继续合入目标分支。']
      : ['Review all worktree changes and active conversations.', 'Commit and push the task branch, then verify the remote matches local HEAD.', 'Reclaim the worktree, return to code delivery, and merge into the target branch.'];
  }
  if (workspace.state === 'discarded') {
    return [zh ? '本地任务分支已明确放弃，不能继续合入；远端分支如存在仍保持不变。' : 'The local task branch was explicitly discarded and cannot be merged; any remote branch remains unchanged.'];
  }
  return zh
    ? ['在隔离 integration worktree 中准备合入。', '无冲突时重新校验主工作区分支、HEAD 与干净状态。', '快进目标分支，推送并校验远端提交。']
    : ['Prepare the merge in an isolated integration worktree.', 'Revalidate the primary branch, HEAD, and clean state when there is no conflict.', 'Fast-forward the target, push, and verify the remote commit.'];
}

function ConflictCodePane(props: { title: string; content: string }) {
  return (
    <section>
      <strong>{props.title}</strong>
      <pre>{props.content}</pre>
    </section>
  );
}

function errorMessage(error: unknown, zh: boolean): string {
  if (zh && error instanceof ZeusApiError) {
    const localizedMessages: Record<string, string> = {
      ZEUS_TASK_BRANCH_NOT_REMOTE_BACKED: '请先审查任务分支，完成提交、推送、远端校验和 worktree 回收。',
      ZEUS_TARGET_BRANCH_UNAVAILABLE: '主工作区必须检出一个本地命名分支后才能开始合入。',
      ZEUS_TARGET_BRANCH_CHANGED: '主工作区已经不在选定的目标分支，请切换回目标分支后重试。',
      ZEUS_TARGET_WORKSPACE_DIRTY: '主工作区存在未提交变更，请先处理这些变更后再合入。',
      ZEUS_TASK_WORKSPACE_BUSY: '仍有会话可能写入当前任务分支，请先停止活动会话。',
      ZEUS_TASK_REMOTE_VERIFICATION_FAILED: '远端任务分支与本地 HEAD 不一致，请重新推送并完成校验。',
    };
    if (error.error && localizedMessages[error.error]) return localizedMessages[error.error];
  }
  return error instanceof Error ? error.message : String(error);
}
