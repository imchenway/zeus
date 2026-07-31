import { useEffect, useMemo, useState } from 'react';
import type { DashboardClient, TaskManagementStatus, TaskRecord } from '../apiClient.js';
import type { TaskGitDiffSummary, TaskGitFileDiff, TaskGitFileStatus, TaskWorkspaceSnapshot, TaskWorkspacesSnapshot } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';

type ReviewMode = 'commit' | 'completed' | 'cancelled';
type ReviewStatus = 'loading' | 'ready' | 'submitting' | 'error';
const closedWorkspaceStates = new Set(['reclaimed', 'merged', 'discarded']);

export function TaskGitReviewModal(props: {
  open: boolean;
  language: 'zh-CN' | 'en-US';
  task: TaskRecord | null;
  projectName?: string;
  client: Pick<DashboardClient, 'loadTaskGitWorkspaces' | 'loadTaskWorkspaceFileDiff' | 'commitTaskWorkspace' | 'reclaimTaskWorkspace' | 'discardTaskWorkspace' | 'stopTaskWorkspaceSessions'> | null;
  mode: ReviewMode;
  preferredWorkspaceId?: string | null;
  onClose: () => void;
  onReadyToCloseTask: (status: Extract<TaskManagementStatus, 'completed' | 'cancelled'>) => Promise<void>;
}) {
  const zh = props.language === 'zh-CN';
  const [snapshot, setSnapshot] = useState<TaskWorkspacesSnapshot | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [fileDiff, setFileDiff] = useState<TaskGitDiffSummary | null>(null);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<ReviewStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardConfirmation, setDiscardConfirmation] = useState('');

  const activeWorkspace = snapshot?.items.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const files = useMemo(() => collectReviewFiles(activeWorkspace), [activeWorkspace]);
  const pendingWorkspaces = snapshot?.items.filter((workspace) => !closedWorkspaceStates.has(workspace.state)) ?? [];

  useEffect(() => {
    if (!props.open || !props.task || !props.client) return;
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setMessage(`${props.task.taskCode ?? props.task.id}: ${props.task.title}`);
    void props.client
      .loadTaskGitWorkspaces(props.task.id)
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        if (props.mode !== 'commit' && next.items.every((workspace) => closedWorkspaceStates.has(workspace.state))) {
          void props
            .onReadyToCloseTask(props.mode)
            .then(() => {
              if (!cancelled) props.onClose();
            })
            .catch((reason: unknown) => {
              if (cancelled) return;
              setStatus('error');
              setError(errorMessage(reason));
            });
          return;
        }
        const preferred = next.items.find((workspace) => workspace.id === props.preferredWorkspaceId && (props.mode === 'commit' || !closedWorkspaceStates.has(workspace.state)));
        const first = preferred ?? next.items.find((workspace) => !closedWorkspaceStates.has(workspace.state)) ?? next.items[0];
        setActiveWorkspaceId(first?.id ?? '');
        setStatus('ready');
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [props.open, props.task?.id, props.client, props.mode, props.preferredWorkspaceId]);

  useEffect(() => {
    const current = snapshot?.items.find((workspace) => workspace.id === activeWorkspaceId);
    const nextFiles = collectReviewFiles(current ?? null);
    setSelectedPaths(nextFiles.map((file) => file.path));
    setSelectedFile(nextFiles[0]?.path ?? '');
    setFileDiff(null);
    setDiscardOpen(false);
    setDiscardConfirmation('');
  }, [snapshot, activeWorkspaceId]);

  useEffect(() => {
    if (!props.task || !props.client || !activeWorkspace || !selectedFile || !activeWorkspace.review) {
      setFileDiff(null);
      return;
    }
    let cancelled = false;
    void props.client
      .loadTaskWorkspaceFileDiff(props.task.id, activeWorkspace.id, selectedFile)
      .then((result) => {
        if (!cancelled) setFileDiff(result.diff);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [props.task?.id, props.client, activeWorkspace?.id, selectedFile]);

  if (!props.open || !props.task) return null;

  async function reload(preferredWorkspaceId?: string): Promise<TaskWorkspacesSnapshot> {
    if (!props.task || !props.client) throw new Error('Task Git client is unavailable.');
    const next = await props.client.loadTaskGitWorkspaces(props.task.id);
    setSnapshot(next);
    const preferred = preferredWorkspaceId ? next.items.find((workspace) => workspace.id === preferredWorkspaceId && !closedWorkspaceStates.has(workspace.state)) : undefined;
    const firstPending = preferred ?? next.items.find((workspace) => !closedWorkspaceStates.has(workspace.state));
    setActiveWorkspaceId(firstPending?.id ?? next.items[0]?.id ?? '');
    return next;
  }

  async function commit(push: boolean): Promise<void> {
    if (!props.task || !props.client || !activeWorkspace) return;
    setStatus('submitting');
    setError(null);
    try {
      const result = await props.client.commitTaskWorkspace(props.task.id, activeWorkspace.id, {
        message,
        selectedPaths,
        push,
      });
      if (props.mode === 'commit') {
        await reload(activeWorkspace.id);
        setStatus('ready');
        return;
      }
      if (!result.review.clean) {
        await reload(activeWorkspace.id);
        setStatus('error');
        setError(zh ? '仍有未选中的变更。请全部审查并提交后再完成任务。' : 'Unselected changes remain. Review and commit them before closing the task.');
        return;
      }
      await props.client.reclaimTaskWorkspace(props.task.id, activeWorkspace.id);
      const next = await reload();
      if (next.items.every((workspace) => closedWorkspaceStates.has(workspace.state))) {
        await props.onReadyToCloseTask(props.mode);
        props.onClose();
        return;
      }
      setStatus('ready');
    } catch (reason) {
      setStatus('error');
      setError(errorMessage(reason));
      await reload(activeWorkspace.id).catch(() => undefined);
    }
  }

  async function reclaimWithoutCommit(): Promise<void> {
    if (!props.task || !props.client || !activeWorkspace || props.mode === 'commit') return;
    setStatus('submitting');
    setError(null);
    try {
      await props.client.reclaimTaskWorkspace(props.task.id, activeWorkspace.id);
      const next = await reload();
      if (next.items.every((workspace) => closedWorkspaceStates.has(workspace.state))) {
        await props.onReadyToCloseTask(props.mode);
        props.onClose();
        return;
      }
      setStatus('ready');
    } catch (reason) {
      setStatus('error');
      setError(errorMessage(reason));
    }
  }

  async function discard(): Promise<void> {
    if (!props.task || !props.client || !activeWorkspace || props.mode === 'commit') return;
    setStatus('submitting');
    setError(null);
    try {
      await props.client.discardTaskWorkspace(props.task.id, activeWorkspace.id, discardConfirmation);
      const next = await reload();
      if (next.items.every((workspace) => closedWorkspaceStates.has(workspace.state))) {
        await props.onReadyToCloseTask(props.mode);
        props.onClose();
        return;
      }
      setStatus('ready');
    } catch (reason) {
      setStatus('error');
      setError(errorMessage(reason));
    }
  }

  async function stopSessions(): Promise<void> {
    if (!props.task || !props.client || !activeWorkspace) return;
    setStatus('submitting');
    setError(null);
    try {
      await props.client.stopTaskWorkspaceSessions(props.task.id, activeWorkspace.id);
      await reload(activeWorkspace.id);
      setStatus('ready');
    } catch (reason) {
      setStatus('error');
      setError(errorMessage(reason));
    }
  }

  const busy = status === 'submitting';
  const activeReview = activeWorkspace?.review;
  const canReclaimUnchanged = props.mode !== 'commit' && activeReview?.clean === true && activeReview.headSha === activeWorkspace?.sourceHeadSha;

  return (
    <ModalPortal rootClassName="task-git-review-portal-root" backdropClassName="task-git-review-backdrop" dismissDisabled={busy} onDismiss={props.onClose}>
      <section className="task-git-review-modal" role="dialog" aria-modal="true" aria-labelledby="task-git-review-title">
        <header className="task-git-review-header">
          <span>
            <strong id="task-git-review-title">{props.mode === 'commit' ? (zh ? '提交变更' : 'Commit Changes') : zh ? '审查并交付任务分支' : 'Review and deliver task branches'}</strong>
            <small>
              {props.projectName ? `${props.projectName} · ` : ''}
              {props.task.taskCode ?? props.task.id} · {props.task.title}
            </small>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={busy}>
            ×
          </button>
        </header>

        <div className="task-git-review-layout">
          <aside className="task-git-review-workspaces" aria-label={zh ? '任务分支' : 'Task branches'}>
            <strong>
              {zh ? '任务分支' : 'Task branches'} <small>{pendingWorkspaces.length}</small>
            </strong>
            {snapshot?.items.map((workspace) => (
              <button type="button" key={workspace.id} className={workspace.id === activeWorkspaceId ? 'is-active' : ''} onClick={() => setActiveWorkspaceId(workspace.id)}>
                <span>{workspace.branchName}</span>
                <small>{workspaceStateLabel(workspace, zh)}</small>
              </button>
            ))}
          </aside>

          <main className="task-git-review-main">
            <section className="task-git-review-changes" aria-label={zh ? '变更文件' : 'Changed files'}>
              <span className="task-git-review-pane-title">
                <strong>{zh ? '变更' : 'Changes'}</strong>
                <small>{files.length}</small>
              </span>
              {status === 'loading' ? <p>{zh ? '正在读取 Git 状态…' : 'Loading Git status…'}</p> : null}
              {activeWorkspace?.reviewError ? <p className="task-git-review-error">{activeWorkspace.reviewError}</p> : null}
              {activeReview?.conflictFiles.length ? (
                <p className="task-git-review-error">{zh ? `存在 ${activeReview.conflictFiles.length} 个冲突文件，请先进入冲突处理。` : `${activeReview.conflictFiles.length} conflicted files require resolution.`}</p>
              ) : null}
              <ol className="task-git-review-file-tree">
                {files.map((file) => (
                  <li key={file.path} className={selectedFile === file.path ? 'is-active' : ''}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedPaths.includes(file.path)}
                        onChange={(event) => setSelectedPaths((current) => (event.target.checked ? Array.from(new Set([...current, file.path])) : current.filter((path) => path !== file.path)))}
                        disabled={busy}
                      />
                      <button type="button" onClick={() => setSelectedFile(file.path)}>
                        <span>{file.path}</span>
                        <small>{fileStatusLabel(file, zh)}</small>
                      </button>
                    </label>
                  </li>
                ))}
              </ol>
              {files.length === 0 ? <p className="task-git-review-empty">{zh ? '工作区没有未提交变更。' : 'The workspace has no uncommitted changes.'}</p> : null}
            </section>

            <section className="task-git-review-diff" aria-label={zh ? '差异对比' : 'Diff'}>
              <span className="task-git-review-pane-title">
                <strong>{selectedFile || (zh ? '选择文件查看差异' : 'Select a file to view its diff')}</strong>
                {fileDiff?.fileDiffs[0] ? (
                  <small>
                    +{fileDiff.fileDiffs[0].addedLines} −{fileDiff.fileDiffs[0].deletedLines}
                  </small>
                ) : null}
              </span>
              <SideBySideDiff diff={fileDiff?.fileDiffs[0] ?? null} zh={zh} />
            </section>
          </main>

          <aside className="task-git-review-options">
            <span>
              <strong>Git</strong>
              <small>{activeWorkspace?.branchName ?? '—'}</small>
            </span>
            <dl>
              <div>
                <dt>{zh ? '来源分支' : 'Source'}</dt>
                <dd>{activeWorkspace?.sourceBranch ?? '—'}</dd>
              </div>
              <div>
                <dt>{zh ? '远端' : 'Remote'}</dt>
                <dd>{activeWorkspace ? `${activeWorkspace.remoteName}/${activeWorkspace.remoteBranch}` : '—'}</dd>
              </div>
              <div>
                <dt>{zh ? '领先 / 落后' : 'Ahead / behind'}</dt>
                <dd>{activeReview ? `${activeReview.ahead} / ${activeReview.behind}` : '—'}</dd>
              </div>
            </dl>
            <section>
              <strong>{zh ? '提交检查' : 'Commit checks'}</strong>
              <small>{zh ? '项目未配置额外提交前检查。' : 'No additional project commit checks are configured.'}</small>
            </section>
            {activeWorkspace && activeWorkspace.activeConversationCount > 0 ? (
              <section className="task-git-review-active-sessions">
                <strong>{zh ? '活动会话' : 'Active sessions'}</strong>
                <small>
                  {zh
                    ? `${activeWorkspace.activeConversationCount} 个会话仍可能写入此分支。停止后才能提交或回收。`
                    : `${activeWorkspace.activeConversationCount} conversations may still write to this branch. Stop them before commit or reclaim.`}
                </small>
                <Button variant="secondary" size="compact" onClick={() => void stopSessions()} disabled={busy}>
                  {zh ? '停止活动会话' : 'Stop active sessions'}
                </Button>
              </section>
            ) : null}
          </aside>
        </div>

        <label className="task-git-review-message">
          <span>{zh ? '提交说明' : 'Commit message'}</span>
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} disabled={busy} />
        </label>

        {discardOpen && activeWorkspace ? (
          <section className="task-git-review-discard">
            <strong>{zh ? '放弃本地任务分支' : 'Discard local task branch'}</strong>
            <small>{zh ? `输入 ${activeWorkspace.branchName} 确认。远端分支不会被删除。` : `Type ${activeWorkspace.branchName} to confirm. The remote branch is preserved.`}</small>
            <input value={discardConfirmation} onChange={(event) => setDiscardConfirmation(event.target.value)} disabled={busy} />
            <Button variant="danger" size="compact" onClick={() => void discard()} disabled={discardConfirmation !== activeWorkspace.branchName || busy}>
              {zh ? '确认放弃' : 'Discard branch'}
            </Button>
          </section>
        ) : null}

        {error ? (
          <p className="task-git-review-global-error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="task-git-review-footer">
          <span>
            {props.mode !== 'commit' && activeWorkspace && !closedWorkspaceStates.has(activeWorkspace.state) ? (
              <Button variant="secondary" size="regular" onClick={() => setDiscardOpen((current) => !current)} disabled={busy}>
                {zh ? '放弃分支…' : 'Discard branch…'}
              </Button>
            ) : null}
          </span>
          <span>
            <Button variant="secondary" size="regular" onClick={props.onClose} disabled={busy}>
              {zh ? '取消' : 'Cancel'}
            </Button>
            {props.mode === 'commit' ? (
              <>
                <Button variant="secondary" size="regular" onClick={() => void commit(true)} disabled={busy || !activeWorkspace || activeWorkspace.activeConversationCount > 0 || activeReview?.conflictFiles.length !== 0}>
                  {zh ? '提交并推送' : 'Commit and Push'}
                </Button>
                <Button
                  variant="primary"
                  size="regular"
                  busy={busy}
                  onClick={() => void commit(false)}
                  disabled={busy || !activeWorkspace || activeWorkspace.activeConversationCount > 0 || files.length === 0 || selectedPaths.length === 0 || activeReview?.conflictFiles.length !== 0}
                >
                  {zh ? '提交' : 'Commit'}
                </Button>
              </>
            ) : canReclaimUnchanged ? (
              <Button variant="primary" size="regular" busy={busy} onClick={() => void reclaimWithoutCommit()} disabled={busy || activeWorkspace.activeConversationCount > 0}>
                {zh ? '确认无变更并回收' : 'Confirm unchanged and reclaim'}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="regular"
                busy={busy}
                onClick={() => void commit(true)}
                disabled={busy || !activeWorkspace || activeWorkspace.activeConversationCount > 0 || activeReview?.conflictFiles.length !== 0 || (files.length > 0 && selectedPaths.length === 0)}
              >
                {zh ? '提交并推送' : 'Commit and Push'}
              </Button>
            )}
          </span>
        </footer>
      </section>
    </ModalPortal>
  );
}

function collectReviewFiles(workspace: TaskWorkspaceSnapshot | null): TaskGitFileStatus[] {
  if (!workspace?.review) return [];
  const byPath = new Map<string, TaskGitFileStatus>();
  for (const file of [...workspace.review.stagedFiles, ...workspace.review.unstagedFiles, ...workspace.review.untrackedFiles]) {
    byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function fileStatusLabel(file: TaskGitFileStatus, zh: boolean): string {
  const labels = zh
    ? { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名', untracked: '未跟踪', conflict: '冲突', other: '变更' }
    : { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', untracked: 'Untracked', conflict: 'Conflict', other: 'Changed' };
  return labels[file.category];
}

function workspaceStateLabel(workspace: TaskWorkspaceSnapshot, zh: boolean): string {
  if (workspace.state === 'reclaimed') return zh ? '已推送 · worktree 已回收' : 'Pushed · worktree reclaimed';
  if (workspace.state === 'merged') return zh ? '已合入' : 'Merged';
  if (workspace.state === 'discarded') return zh ? '已放弃' : 'Discarded';
  if (workspace.review?.conflictFiles.length) return zh ? '存在冲突' : 'Conflicted';
  if (workspace.review?.clean) return zh ? '工作区干净' : 'Clean';
  return zh ? '待审查' : 'Review required';
}

function SideBySideDiff(props: { diff: TaskGitFileDiff | null; zh: boolean }) {
  if (!props.diff) return <p className="task-git-review-empty">{props.zh ? '暂无可显示的文本差异。' : 'No text diff to display.'}</p>;
  const rows = props.diff.hunks.flatMap((hunk) => [
    { key: `${hunk.header}-header`, kind: 'header' as const, leftNumber: '', left: hunk.header, rightNumber: '', right: hunk.header },
    ...hunk.lines.map((line, index) => ({
      key: `${hunk.header}-${index}`,
      kind: line.type,
      leftNumber: line.oldLineNumber ?? '',
      left: line.type === 'addition' ? '' : line.content,
      rightNumber: line.newLineNumber ?? '',
      right: line.type === 'deletion' ? '' : line.content,
    })),
  ]);
  return (
    <div className="task-git-review-diff-table" role="table">
      {rows.map((row) => (
        <div key={row.key} className={`task-git-review-diff-row is-${row.kind}`} role="row">
          <span className="line-number">{row.leftNumber}</span>
          <code>{row.left}</code>
          <span className="line-number">{row.rightNumber}</span>
          <code>{row.right}</code>
        </div>
      ))}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
