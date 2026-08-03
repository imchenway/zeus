import {useEffect, useMemo, useState} from 'react';
import {type DashboardClient, type TaskRecord, ZeusApiError} from '../apiClient.js';
import type {
    TaskBranchFileChange,
    TaskGitDiffSummary,
    TaskGitFileDiff,
    TaskGitFileStatus,
    TaskIntegrationConflictFile,
    TaskIntegrationRecord,
    TaskIntegrationResult,
    TaskWorkspaceSnapshot,
    TaskWorkspacesSnapshot,
} from '../session/sessionTypes.js';
import {Button} from '../ui/Button.js';
import {ModalPortal} from '../ui/ModalPortal.js';
import {ZeusSelect} from '../ZeusSelect.js';

type DeliveryClient = Pick<
  DashboardClient,
    | 'loadTaskGitWorkspaces'
    | 'loadTaskWorkspaceFileDiff'
    | 'commitTaskWorkspace'
    | 'pushTaskWorkspace'
    | 'stopTaskWorkspaceSessions'
    | 'loadTaskIntegrations'
    | 'startTaskIntegration'
    | 'loadTaskIntegrationConflict'
    | 'resolveTaskIntegrationConflict'
    | 'assistTaskIntegrationConflict'
    | 'finalizeTaskIntegration'
>;

type DiffScope = 'committed' | 'working';
type BusyAction = 'loading' | 'commit' | 'push' | 'merge' | 'conflict' | null;

interface DeliveryFile {
    path: string;
    label: string;
    additions: number;
    deletions: number;
    workingFile?: TaskGitFileStatus;
}

interface DeliveryFeedback {
    tone: 'success' | 'warning' | 'info';
    text: string;
}

export function TaskGitMergeModal(props: {
  open: boolean;
  language: 'zh-CN' | 'en-US';
  task: TaskRecord | null;
  projectName?: string;
    client: DeliveryClient | null;
  onChanged?: () => void | Promise<void>;
  onClose: () => void;
}) {
  const zh = props.language === 'zh-CN';
  const [workspaces, setWorkspaces] = useState<TaskWorkspacesSnapshot | null>(null);
  const [integrations, setIntegrations] = useState<TaskIntegrationRecord[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
    const [diffScope, setDiffScope] = useState<DiffScope>('committed');
    const [selectedFile, setSelectedFile] = useState('');
    const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
    const [fileDiff, setFileDiff] = useState<TaskGitDiffSummary | null>(null);
    const [diffLoading, setDiffLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [targetBranch, setTargetBranch] = useState('');
  const [mode, setMode] = useState<'merge' | 'squash'>('merge');
  const [integration, setIntegration] = useState<TaskIntegrationRecord | null>(null);
  const [conflictPath, setConflictPath] = useState('');
  const [conflict, setConflict] = useState<TaskIntegrationConflictFile | null>(null);
  const [resultContent, setResultContent] = useState('');
    const [busyAction, setBusyAction] = useState<BusyAction>(null);
    const [snapshotRevision, setSnapshotRevision] = useState(0);
    const [feedback, setFeedback] = useState<DeliveryFeedback | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedWorkspace = workspaces?.items.find((workspace) => workspace.id === workspaceId) ?? null;
    const workingFiles = useMemo(() => collectWorkingFiles(selectedWorkspace), [selectedWorkspace]);
    const committedFiles = useMemo(() => (selectedWorkspace?.branchComparison?.files ?? []).map((file) => toCommittedDeliveryFile(file, zh)), [selectedWorkspace?.branchComparison?.files, zh]);
    const visibleFiles = diffScope === 'committed' ? committedFiles : workingFiles.map((file) => toWorkingDeliveryFile(file, zh));
  const activeConflict = integration?.state === 'conflicted' ? integration : null;
    const busy = busyAction !== null;
    const workspaceClean = selectedWorkspace?.review?.clean ?? selectedWorkspace?.worktreePath === null;
    const commitReady = Boolean(selectedWorkspace && workspaceClean && selectedWorkspace.activeConversationCount === 0 && selectedWorkspace.state !== 'discarded');
    const pushReady = Boolean(selectedWorkspace?.worktreePath && commitReady);
    const mergeReady = Boolean(selectedWorkspace?.branchComparison && commitReady && targetBranch && targetBranch !== selectedWorkspace.branchName);
    const targetOptions = useMemo(() => buildTargetOptions(workspaces, selectedWorkspace, zh), [workspaces, selectedWorkspace, zh]);
    const deliveredIntegration = integrations.find((candidate) => candidate.workspaceId === selectedWorkspace?.id && candidate.targetBranch === targetBranch && candidate.state === 'merged') ?? null;
    const alreadyDelivered = Boolean(deliveredIntegration || (selectedWorkspace?.state === 'merged' && targetBranch === selectedWorkspace.sourceBranch));

  useEffect(() => {
    if (!props.open || !props.task || !props.client) return;
    let cancelled = false;
      setBusyAction('loading');
    setError(null);
      setFeedback(null);
      setMessage(`${props.task.taskCode ?? props.task.id}: ${props.task.title}`);
    void Promise.all([props.client.loadTaskGitWorkspaces(props.task.id), props.client.loadTaskIntegrations(props.task.id)])
      .then(([workspaceSnapshot, integrationSnapshot]) => {
        if (cancelled) return;
        setWorkspaces(workspaceSnapshot);
        setIntegrations(integrationSnapshot.items);
        const conflicted = integrationSnapshot.items.find((candidate) => candidate.state === 'conflicted');
        const firstWorkspace =
          workspaceSnapshot.items.find((workspace) => workspace.id === conflicted?.workspaceId) ??
            workspaceSnapshot.items.find((workspace) => workspace.state !== 'discarded') ??
          workspaceSnapshot.items[0];
        setWorkspaceId(firstWorkspace?.id ?? '');
          setTargetBranch(resolveInitialTargetBranch(workspaceSnapshot, firstWorkspace));
        setIntegration(conflicted ?? null);
        setConflictPath(conflicted?.conflictFiles[0] ?? '');
          setSnapshotRevision((current) => current + 1);
          setBusyAction(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
          setBusyAction(null);
        setError(errorMessage(reason, zh));
      });
    return () => {
      cancelled = true;
    };
  }, [props.open, props.task?.id, props.client, zh]);

    useEffect(() => {
        const nextFiles = diffScope === 'committed' ? committedFiles : workingFiles.map((file) => toWorkingDeliveryFile(file, zh));
        setSelectedFile(nextFiles[0]?.path ?? '');
        setFileDiff(null);
        setSelectedPaths(workingFiles.map((file) => file.path));
    }, [workspaceId, diffScope, committedFiles, workingFiles, zh]);

    useEffect(() => {
        if (!props.open || !props.task || !props.client || !selectedWorkspace || !selectedFile) {
            setFileDiff(null);
            return;
        }
        let cancelled = false;
        setDiffLoading(true);
        void props.client
            .loadTaskWorkspaceFileDiff(props.task.id, selectedWorkspace.id, selectedFile, diffScope)
            .then((result) => {
                if (cancelled) return;
                setFileDiff(result.diff);
                setDiffLoading(false);
            })
            .catch((reason: unknown) => {
                if (cancelled) return;
                setDiffLoading(false);
                setError(errorMessage(reason, zh));
            });
        return () => {
            cancelled = true;
        };
    }, [props.open, props.task?.id, props.client, selectedWorkspace?.id, selectedFile, diffScope, snapshotRevision, zh]);

  useEffect(() => {
    if (!props.task || !props.client || !activeConflict || !conflictPath) {
      setConflict(null);
      setResultContent('');
      return;
    }
    let cancelled = false;
      setBusyAction('conflict');
    void props.client
      .loadTaskIntegrationConflict(props.task.id, activeConflict.id, conflictPath)
      .then((next) => {
        if (cancelled) return;
        setConflict(next);
        setResultContent(next.result);
          setBusyAction(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
          setBusyAction(null);
        setError(errorMessage(reason, zh));
      });
    return () => {
      cancelled = true;
    };
  }, [props.task?.id, props.client, activeConflict?.id, conflictPath, zh]);

  if (!props.open || !props.task) return null;

    async function reload(preferredWorkspaceId = workspaceId): Promise<void> {
    if (!props.task || !props.client) return;
    const [workspaceSnapshot, integrationSnapshot] = await Promise.all([props.client.loadTaskGitWorkspaces(props.task.id), props.client.loadTaskIntegrations(props.task.id)]);
    setWorkspaces(workspaceSnapshot);
    setIntegrations(integrationSnapshot.items);
        setSnapshotRevision((current) => current + 1);
        const nextWorkspace = workspaceSnapshot.items.find((workspace) => workspace.id === preferredWorkspaceId) ?? workspaceSnapshot.items[0] ?? null;
        if (nextWorkspace) {
            setWorkspaceId(nextWorkspace.id);
            setTargetBranch((current) => (workspaceSnapshot.localBranches.includes(current) && current !== nextWorkspace.branchName ? current : resolveInitialTargetBranch(workspaceSnapshot, nextWorkspace)));
        }
    }

    async function commit(): Promise<void> {
        if (!props.task || !props.client || !selectedWorkspace || selectedPaths.length === 0) return;
        setBusyAction('commit');
        setError(null);
        setFeedback(null);
        try {
            const response = await props.client.commitTaskWorkspace(props.task.id, selectedWorkspace.id, {
                message,
                selectedPaths,
                push: false
            });
            await reload(selectedWorkspace.id);
            await props.onChanged?.();
            setDiffScope('committed');
            setFeedback({
                tone: 'success',
                text: zh ? `提交完成 · ${shortSha(response.result.headSha)}` : `Commit created · ${shortSha(response.result.headSha)}`
            });
        } catch (reason) {
            setError(errorMessage(reason, zh));
        } finally {
            setBusyAction(null);
        }
    }

    async function push(): Promise<void> {
        if (!props.task || !props.client || !selectedWorkspace) return;
        setBusyAction('push');
        setError(null);
        setFeedback(null);
        try {
            const response = await props.client.pushTaskWorkspace(props.task.id, selectedWorkspace.id);
            await reload(selectedWorkspace.id);
            await props.onChanged?.();
            setFeedback({
                tone: 'success',
                text: zh ? `任务分支已推送并校验 · ${shortSha(response.result.remoteHeadSha)}` : `Task branch pushed and verified · ${shortSha(response.result.remoteHeadSha)}`
            });
        } catch (reason) {
            setError(errorMessage(reason, zh));
        } finally {
            setBusyAction(null);
        }
    }

    async function stopSessions(): Promise<void> {
        if (!props.task || !props.client || !selectedWorkspace) return;
        setBusyAction('commit');
        setError(null);
        try {
            await props.client.stopTaskWorkspaceSessions(props.task.id, selectedWorkspace.id);
            await reload(selectedWorkspace.id);
            await props.onChanged?.();
            setFeedback({
                tone: 'info',
                text: zh ? '活动会话已停止，可以继续提交或合入。' : 'Active sessions stopped. Commit or merge can continue.'
            });
        } catch (reason) {
            setError(errorMessage(reason, zh));
        } finally {
            setBusyAction(null);
        }
  }

  async function start(): Promise<void> {
      if (!props.task || !props.client || !selectedWorkspace || !mergeReady || alreadyDelivered) return;
      setBusyAction('merge');
    setError(null);
      setFeedback(null);
    try {
        const response = await props.client.startTaskIntegration(props.task.id, selectedWorkspace.id, {
            targetBranch,
            mode
        });
      setIntegration(response.integration);
      setConflictPath(response.integration.conflictFiles[0] ?? '');
        await reload(selectedWorkspace.id);
      await props.onChanged?.();
        if (response.result) setFeedback(deliveryFeedback(response.result, zh));
    } catch (reason) {
      setError(errorMessage(reason, zh));
    } finally {
        setBusyAction(null);
    }
  }

  async function saveResolution(): Promise<void> {
    if (!props.task || !props.client || !activeConflict || !conflictPath) return;
      setBusyAction('conflict');
    setError(null);
    try {
      const response = await props.client.resolveTaskIntegrationConflict(props.task.id, activeConflict.id, conflictPath, resultContent);
      setIntegration(response.integration);
      const nextPath = response.result.remainingConflictFiles[0] ?? '';
      setConflictPath(nextPath);
      if (!nextPath) setConflict(null);
        await reload(activeConflict.workspaceId);
      await props.onChanged?.();
    } catch (reason) {
      setError(errorMessage(reason, zh));
    } finally {
        setBusyAction(null);
    }
  }

  async function askCodex(): Promise<void> {
    if (!props.task || !props.client || !activeConflict || !conflictPath) return;
      setBusyAction('conflict');
    setError(null);
    try {
      const response = await props.client.assistTaskIntegrationConflict(props.task.id, activeConflict.id, conflictPath);
      setResultContent(response.suggestedContent);
    } catch (reason) {
      setError(errorMessage(reason, zh));
    } finally {
        setBusyAction(null);
    }
  }

  async function finalize(): Promise<void> {
    if (!props.task || !props.client || !integration) return;
      setBusyAction('merge');
    setError(null);
    try {
      const response = await props.client.finalizeTaskIntegration(props.task.id, integration.id);
      setIntegration(response.integration);
        await reload(integration.workspaceId);
      await props.onChanged?.();
        setFeedback(deliveryFeedback(response.result, zh));
    } catch (reason) {
      setError(errorMessage(reason, zh));
    } finally {
        setBusyAction(null);
    }
  }

  function selectWorkspace(nextId: string): void {
      const nextWorkspace = workspaces?.items.find((workspace) => workspace.id === nextId) ?? null;
    setWorkspaceId(nextId);
      setDiffScope('committed');
      setTargetBranch(resolveInitialTargetBranch(workspaces, nextWorkspace));
    const conflicted = integrations.find((candidate) => candidate.workspaceId === nextId && candidate.state === 'conflicted');
    setIntegration(conflicted ?? null);
    setConflictPath(conflicted?.conflictFiles[0] ?? '');
      setError(null);
      setFeedback(nextWorkspace ? {
          tone: 'info',
          text: zh ? `已选择 ${nextWorkspace.branchName}` : `Selected ${nextWorkspace.branchName}`
      } : null);
  }

    const integrationResult = deliveredIntegration ?? (selectedWorkspace?.state === 'merged' ? integrations.find((candidate) => candidate.workspaceId === selectedWorkspace.id && candidate.state === 'merged') : null);

  return (
    <ModalPortal rootClassName="task-git-merge-portal-root" backdropClassName="task-git-merge-backdrop" dismissDisabled={busy} onDismiss={props.onClose}>
        <section className={`task-git-merge-modal task-git-delivery-modal${activeConflict ? ' is-conflicted' : ''}`}
                 role="dialog" aria-modal="true" aria-labelledby="task-git-merge-title">
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
            <ConflictWorkspace
                zh={zh}
                busy={busy}
                integration={activeConflict}
                taskBranch={selectedWorkspace?.branchName ?? ''}
                conflictPath={conflictPath}
                conflict={conflict}
                resultContent={resultContent}
                onSelectPath={setConflictPath}
                onResultChange={setResultContent}
                onAskCodex={() => void askCodex()}
            />
        ) : (
            <>
                <DeliveryStepBar workspace={selectedWorkspace}
                                 remoteVerified={selectedWorkspace?.remoteVerified ?? false}
                                 alreadyDelivered={alreadyDelivered} zh={zh}/>
                <div className="task-git-review-layout task-git-delivery-layout">
                    <aside className="task-git-review-workspaces" aria-label={zh ? '任务分支' : 'Task branches'}>
                        <strong>
                            {zh ? '任务分支' : 'Task branches'} <small>{workspaces?.items.length ?? 0}</small>
                        </strong>
                        {workspaces?.items.map((workspace) => (
                            <button type="button" key={workspace.id}
                                    className={workspace.id === workspaceId ? 'is-active' : ''}
                                    onClick={() => selectWorkspace(workspace.id)} disabled={busy}>
                                <span>{workspace.branchName}</span>
                                <small>{workspaceStateLabel(workspace, zh)}</small>
                            </button>
                        ))}
                    </aside>

                    <main className="task-git-review-main">
                        <section className="task-git-review-changes" aria-label={zh ? '代码变化' : 'Code changes'}>
                  <span className="task-git-review-pane-title task-git-delivery-diff-tabs">
                    <span>
                      <button type="button" className={diffScope === 'committed' ? 'is-active' : ''}
                              onClick={() => setDiffScope('committed')} disabled={busy}>
                        {zh ? '已提交成果' : 'Committed result'} <small>{committedFiles.length}</small>
                      </button>
                      <button type="button" className={diffScope === 'working' ? 'is-active' : ''}
                              onClick={() => setDiffScope('working')}
                              disabled={busy || !selectedWorkspace?.worktreePath}>
                        {zh ? '本机未提交' : 'Local uncommitted'} <small>{workingFiles.length}</small>
                      </button>
                    </span>
                  </span>
                            {selectedWorkspace?.comparisonError && diffScope === 'committed' ?
                                <p className="task-git-review-error">{selectedWorkspace.comparisonError}</p> : null}
                            {selectedWorkspace?.reviewError && diffScope === 'working' ?
                                <p className="task-git-review-error">{selectedWorkspace.reviewError}</p> : null}
                            <ol className="task-git-review-file-tree">
                                {visibleFiles.map((file) => (
                                    <li key={file.path} className={selectedFile === file.path ? 'is-active' : ''}>
                                        <label>
                                            {diffScope === 'working' ? (
                                                <input
                                                    type="checkbox"
                                                    checked={selectedPaths.includes(file.path)}
                                                    onChange={(event) => setSelectedPaths((current) => (event.target.checked ? Array.from(new Set([...current, file.path])) : current.filter((path) => path !== file.path)))}
                                                    disabled={busy}
                                                />
                                            ) : null}
                                            <button type="button" onClick={() => setSelectedFile(file.path)}
                                                    disabled={busy}>
                                                <span>{file.path}</span>
                                                <small>
                                                    {file.label}
                                                    {file.additions || file.deletions ? ` · +${file.additions} −${file.deletions}` : ''}
                                                </small>
                                            </button>
                                        </label>
                                    </li>
                                ))}
                            </ol>
                            {visibleFiles.length === 0 ? (
                                <p className="task-git-review-empty">
                                    {diffScope === 'committed'
                                        ? zh
                                            ? '任务分支相对来源分支没有待交付代码。'
                                            : 'The task branch has no code pending against its source branch.'
                                        : zh
                                            ? '工作区没有未提交变化。'
                                            : 'The workspace has no uncommitted changes.'}
                                </p>
                            ) : null}
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
                            {diffLoading ?
                                <p className="task-git-review-empty">{zh ? '正在读取差异…' : 'Loading diff…'}</p> :
                                <SideBySideDiff diff={fileDiff?.fileDiffs[0] ?? null}
                                                hasSelection={Boolean(selectedFile)} zh={zh}/>}
                        </section>
                    </main>

                    <aside className="task-git-review-options task-git-delivery-actions">
                <span>
                  <strong>Git</strong>
                  <small>{selectedWorkspace?.branchName ?? '—'}</small>
                </span>
                        <dl>
                            <div>
                                <dt>{zh ? '来源分支' : 'Source'}</dt>
                                <dd>{selectedWorkspace?.sourceBranch ?? '—'}</dd>
                            </div>
                            <div>
                                <dt>{zh ? '任务分支远端' : 'Task branch remote'}</dt>
                                <dd>{selectedWorkspace?.remoteVerified ? (zh ? '已推送并校验' : 'Pushed and verified') : zh ? '未推送或待更新（可选）' : 'Not pushed or outdated (optional)'}</dd>
                            </div>
                        </dl>

                        {selectedWorkspace && selectedWorkspace.activeConversationCount > 0 ? (
                            <section className="task-git-review-active-sessions">
                                <strong>{zh ? '活动会话仍在写入' : 'Active sessions are still writing'}</strong>
                                <small>{zh ? `${selectedWorkspace.activeConversationCount} 个会话需要先停止。` : `Stop ${selectedWorkspace.activeConversationCount} active session(s) first.`}</small>
                                <Button variant="secondary" size="compact" onClick={() => void stopSessions()}
                                        disabled={busy}>
                                    {zh ? '停止活动会话' : 'Stop active sessions'}
                                </Button>
                            </section>
                        ) : null}

                        <section
                            className={`task-git-delivery-action-step${workingFiles.length === 0 ? ' is-complete' : ''}`}>
                            <strong>{zh ? '② 提交' : '② Commit'}</strong>
                            <small>{workingFiles.length === 0 ? (zh ? '本机变化已全部进入提交。' : 'All local changes are committed.') : zh ? `还有 ${workingFiles.length} 个未提交文件。` : `${workingFiles.length} uncommitted file(s) remain.`}</small>
                            {workingFiles.length > 0 ?
                                <textarea value={message} onChange={(event) => setMessage(event.target.value)}
                                          disabled={busy} aria-label={zh ? '提交说明' : 'Commit message'}/> : null}
                            <Button variant="secondary" size="compact" busy={busyAction === 'commit'}
                                    onClick={() => void commit()}
                                    disabled={busy || !selectedWorkspace?.worktreePath || workingFiles.length === 0 || selectedPaths.length === 0 || selectedWorkspace.activeConversationCount > 0}>
                                {zh ? '提交选中文件' : 'Commit selected files'}
                            </Button>
                        </section>

                        <section
                            className={`task-git-delivery-action-step${selectedWorkspace?.remoteVerified ? ' is-complete' : ''}`}>
                            <strong>{zh ? '③ 推送任务分支（可选）' : '③ Push task branch (optional)'}</strong>
                            <small>{zh ? '用于远端备份或协作，不影响能否合入。' : 'Useful for backup or collaboration; it does not gate merging.'}</small>
                            <Button variant="secondary" size="compact" busy={busyAction === 'push'}
                                    onClick={() => void push()} disabled={busy || !pushReady}>
                                {selectedWorkspace?.remoteVerified ? (zh ? '重新推送' : 'Push again') : zh ? '推送任务分支' : 'Push task branch'}
                            </Button>
                        </section>

                        <section className={`task-git-delivery-action-step${alreadyDelivered ? ' is-complete' : ''}`}>
                            <strong>{zh ? '④ 合入指定分支' : '④ Merge into target'}</strong>
                            <ZeusSelect size="compact" ariaLabel={zh ? '合入目标分支' : 'Merge target branch'}
                                        value={targetBranch} options={targetOptions} onChange={setTargetBranch}
                                        disabled={busy || targetOptions.length === 0}/>
                            <ZeusSelect
                                size="compact"
                                ariaLabel={zh ? '合入方式' : 'Merge method'}
                                value={mode}
                                options={[
                                    {value: 'merge', label: zh ? 'Merge · 保留提交历史' : 'Merge · preserve commits'},
                                    {value: 'squash', label: zh ? 'Squash · 合成一个提交' : 'Squash · one commit'},
                                ]}
                                onChange={setMode}
                                disabled={busy}
                                searchable={false}
                            />
                            <Button variant="primary" size="compact" busy={busyAction === 'merge'}
                                    onClick={() => void start()} disabled={busy || !mergeReady || alreadyDelivered}>
                                {alreadyDelivered ? (zh ? '已合入并推送' : 'Merged and pushed') : zh ? '合入并推送目标分支' : 'Merge and push target'}
                            </Button>
                            {integrationResult?.localSyncStatus === 'pending' ? <small
                                className="task-git-delivery-local-pending">{zh ? '远端已交付；本地目标分支有未提交代码，保持原样并待后续同步。' : 'Remote delivery completed; the dirty local target branch was preserved and is pending sync.'}</small> : null}
                        </section>
                    </aside>
                </div>
            </>
        )}

            {feedback ? <p className={`task-git-delivery-feedback is-${feedback.tone}`}>{feedback.text}</p> : null}
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
                <Button variant="primary" size="regular" busy={busyAction === 'conflict'}
                        onClick={() => void saveResolution()} disabled={!conflict || !resultContent}>
                {zh ? '保存结果并继续' : 'Save result and continue'}
              </Button>
            ) : (
                <Button variant="primary" size="regular" busy={busyAction === 'merge'} onClick={() => void finalize()}>
                {zh ? '完成合入并推送' : 'Finish merge and push'}
              </Button>
            )
          ) : null}
        </footer>
      </section>
    </ModalPortal>
  );
}

function DeliveryStepBar(props: {
    workspace: TaskWorkspaceSnapshot | null;
    remoteVerified: boolean;
    alreadyDelivered: boolean;
    zh: boolean
}) {
    const workingCount = collectWorkingFiles(props.workspace).length;
    const steps = [
        {
            label: props.zh ? '① 查看代码' : '① Review code',
            state: props.workspace?.branchComparison ? 'done' : 'current'
        },
        {label: props.zh ? '② 提交' : '② Commit', state: workingCount === 0 ? 'done' : 'current'},
        {label: props.zh ? '③ 可选推送' : '③ Optional push', state: props.remoteVerified ? 'done' : 'optional'},
        {
            label: props.zh ? '④ 合入' : '④ Merge',
            state: props.alreadyDelivered ? 'done' : workingCount === 0 ? 'current' : 'locked'
        },
    ];
    return (
        <nav className="task-git-delivery-stepbar" aria-label={props.zh ? '代码交付步骤' : 'Code delivery steps'}>
            {steps.map((step) => (
                <span key={step.label} className={`is-${step.state}`}>
          {step.label}
        </span>
            ))}
        </nav>
    );
}

function ConflictWorkspace(props: {
    zh: boolean;
    busy: boolean;
    integration: TaskIntegrationRecord;
    taskBranch: string;
    conflictPath: string;
    conflict: TaskIntegrationConflictFile | null;
    resultContent: string;
    onSelectPath: (path: string) => void;
    onResultChange: (content: string) => void;
    onAskCodex: () => void;
}) {
    return (
        <div className="task-git-conflict-layout">
            <aside className="task-git-conflict-files">
                <strong>
                    {props.zh ? '冲突文件' : 'Conflicted files'} <small>{props.integration.conflictFiles.length}</small>
                </strong>
                {props.integration.conflictFiles.map((path) => (
                    <button key={path} type="button" className={path === props.conflictPath ? 'is-active' : ''}
                            onClick={() => props.onSelectPath(path)}>
                        {path}
                    </button>
                ))}
            </aside>
            <main className="task-git-conflict-editor">
                <div className="task-git-conflict-toolbar">
          <span>
            <strong>{props.conflictPath}</strong>
            <small>{props.zh ? `左：${props.integration.targetBranch} · 右：${props.taskBranch}` : `Left: ${props.integration.targetBranch} · Right: ${props.taskBranch}`}</small>
          </span>
                    <span>
            <Button variant="secondary" size="compact"
                    onClick={() => props.conflict && props.onResultChange(props.conflict.source)}
                    disabled={!props.conflict || props.busy}>
              {props.zh ? '采用来源' : 'Accept source'}
            </Button>
            <Button variant="secondary" size="compact"
                    onClick={() => props.conflict && props.onResultChange(props.conflict.task)}
                    disabled={!props.conflict || props.busy}>
              {props.zh ? '采用任务' : 'Accept task'}
            </Button>
            <Button
                variant="secondary"
                size="compact"
                onClick={() => props.conflict && props.onResultChange(`${props.conflict.source}${props.conflict.source.endsWith('\n') ? '' : '\n'}${props.conflict.task}`)}
                disabled={!props.conflict || props.busy}
            >
              {props.zh ? '两者都采用' : 'Accept both'}
            </Button>
            <Button variant="secondary" size="compact" onClick={props.onAskCodex}
                    disabled={!props.conflict || props.busy}>
              {props.zh ? '请 Codex 协助' : 'Ask Codex'}
            </Button>
          </span>
                </div>
                <div className="task-git-conflict-columns">
                    <ConflictCodePane title={props.zh ? '目标分支' : 'Target branch'}
                                      content={props.conflict?.source ?? ''}/>
                    <label>
                        <strong>{props.zh ? '合并结果' : 'Merge result'}</strong>
                        <textarea value={props.resultContent}
                                  onChange={(event) => props.onResultChange(event.target.value)}
                                  disabled={!props.conflict || props.busy} spellCheck={false}/>
                    </label>
                    <ConflictCodePane title={props.zh ? '任务分支' : 'Task branch'}
                                      content={props.conflict?.task ?? ''}/>
                </div>
            </main>
        </div>
    );
}

function collectWorkingFiles(workspace: TaskWorkspaceSnapshot | null): TaskGitFileStatus[] {
    if (!workspace?.review) return [];
    const byPath = new Map<string, TaskGitFileStatus>();
    for (const file of [...workspace.review.stagedFiles, ...workspace.review.unstagedFiles, ...workspace.review.untrackedFiles]) byPath.set(file.path, file);
    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function toCommittedDeliveryFile(file: TaskBranchFileChange, zh: boolean): DeliveryFile {
    return {
        path: file.path,
        label: committedFileLabel(file.changeType, zh),
        additions: file.additions,
        deletions: file.deletions
    };
}

function toWorkingDeliveryFile(file: TaskGitFileStatus, zh: boolean): DeliveryFile {
    return {path: file.path, label: workingFileLabel(file, zh), additions: 0, deletions: 0, workingFile: file};
}

function buildTargetOptions(workspaces: TaskWorkspacesSnapshot | null, workspace: TaskWorkspaceSnapshot | null, zh: boolean): Array<{
    value: string;
    label: string
}> {
    if (!workspaces || !workspace) return [];
    return workspaces.localBranches
        .filter((branch) => branch !== workspace.branchName)
        .sort((left, right) => (left === workspace.sourceBranch ? -1 : right === workspace.sourceBranch ? 1 : left.localeCompare(right)))
        .map((branch) => ({
            value: branch,
            label: branch === workspace.sourceBranch ? (zh ? `${branch} · 来源分支` : `${branch} · source branch`) : branch
        }));
}

function resolveInitialTargetBranch(workspaces: TaskWorkspacesSnapshot | null, workspace: TaskWorkspaceSnapshot | null | undefined): string {
    if (!workspaces || !workspace) return '';
    if (workspaces.localBranches.includes(workspace.sourceBranch)) return workspace.sourceBranch;
    return workspaces.localBranches.find((branch) => branch !== workspace.branchName) ?? '';
}

function workspaceStateLabel(workspace: TaskWorkspaceSnapshot, zh: boolean): string {
    if (workspace.state === 'merged') return zh ? '已交付' : 'Delivered';
    if (workspace.state === 'discarded') return zh ? '已放弃' : 'Discarded';
    if (workspace.activeConversationCount > 0) return zh ? '会话写入中' : 'Session writing';
    const workingCount = collectWorkingFiles(workspace).length;
    if (workingCount > 0) return zh ? `${workingCount} 个未提交文件` : `${workingCount} uncommitted file(s)`;
    if (workspace.remoteVerified) return zh ? '已提交 · 已推送' : 'Committed · pushed';
    return zh ? '已提交 · 可合入' : 'Committed · merge ready';
}

function committedFileLabel(changeType: TaskGitFileDiff['changeType'], zh: boolean): string {
  const labels = zh
      ? {added: '新增', deleted: '删除', modified: '修改', renamed: '重命名', copied: '复制'}
      : {added: 'Added', deleted: 'Deleted', modified: 'Modified', renamed: 'Renamed', copied: 'Copied'};
    return labels[changeType];
}

function workingFileLabel(file: TaskGitFileStatus, zh: boolean): string {
    const labels = zh
        ? {
            added: '新增',
            modified: '修改',
            deleted: '删除',
            renamed: '重命名',
            untracked: '未跟踪',
            conflict: '冲突',
            other: '变化'
        }
        : {
            added: 'Added',
            modified: 'Modified',
            deleted: 'Deleted',
            renamed: 'Renamed',
            untracked: 'Untracked',
            conflict: 'Conflict',
            other: 'Changed'
        };
    return labels[file.category];
}

function SideBySideDiff(props: { diff: TaskGitFileDiff | null; hasSelection: boolean; zh: boolean }) {
    if (!props.diff) return <p
        className="task-git-review-empty">{props.hasSelection ? (props.zh ? '该文件暂无可显示的文本差异。' : 'No text diff is available for this file.') : props.zh ? '请选择文件查看代码差异。' : 'Select a file to view its code diff.'}</p>;
    if (props.diff.hunks.length === 0) return <p
        className="task-git-review-empty">{props.zh ? '文件已经变化，但没有可显示的文本内容，可能是二进制文件或仅文件属性变化。' : 'The file changed, but no text content is available; it may be binary or metadata-only.'}</p>;
    const rows = props.diff.hunks.flatMap((hunk) => [
        {
            key: `${hunk.header}-header`,
            kind: 'header' as const,
            leftNumber: '',
            left: hunk.header,
            rightNumber: '',
            right: hunk.header
        },
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

function deliveryFeedback(result: TaskIntegrationResult, zh: boolean): DeliveryFeedback {
    return result.localSyncStatus === 'pending'
        ? {
            tone: 'warning',
            text: zh ? `远端 ${result.remoteName}/${result.targetBranch} 已交付并校验；本地目标分支保持原样，待处理完未提交代码后再同步。` : `Remote ${result.remoteName}/${result.targetBranch} was delivered and verified; the local target remains unchanged and pending sync.`,
        }
        : {
            tone: 'success',
            text: zh ? `已合入并推送 ${result.targetBranch} · ${shortSha(result.resultHeadSha)}` : `Merged and pushed ${result.targetBranch} · ${shortSha(result.resultHeadSha)}`
        };
}

function shortSha(value: string): string {
    return value.slice(0, 8);
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
      ZEUS_TASK_WORKSPACE_BUSY: '仍有会话可能写入当前任务分支，请先停止活动会话。',
        ZEUS_TASK_WORKSPACE_CONFLICTED: '任务工作区存在未解决冲突，请先完成冲突处理。',
        ZEUS_TASK_WORKSPACE_DIRTY: '任务分支还有未提交代码，请先完成提交再合入。',
        ZEUS_TASK_WORKTREE_UNAVAILABLE: '任务 worktree 当前不可用，不能执行提交或任务分支推送。',
        ZEUS_TARGET_BRANCH_UNAVAILABLE: '请选择一个可用的本地目标分支。',
        ZEUS_TARGET_HEAD_CHANGED: '目标分支在合入期间发生变化，为避免覆盖新代码，本次操作已经安全停止。',
        ZEUS_TASK_REMOTE_VERIFICATION_FAILED: '远端提交校验失败，请检查网络和远端分支状态后重试。',
        ZEUS_GIT_COMMAND_FAILED: 'Git 操作失败，请检查分支和远端状态后重试。',
    };
    if (error.error && localizedMessages[error.error]) return localizedMessages[error.error];
  }
  return error instanceof Error ? error.message : String(error);
}
