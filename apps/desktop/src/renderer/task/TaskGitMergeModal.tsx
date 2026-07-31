import { useEffect, useMemo, useState } from 'react';
import type { DashboardClient, TaskRecord } from '../apiClient.js';
import type { TaskIntegrationConflictFile, TaskIntegrationRecord, TaskWorkspacesSnapshot } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { ZeusSelect } from '../ZeusSelect.js';

type MergeClient = Pick<
  DashboardClient,
  'loadTaskGitWorkspaces' | 'loadTaskIntegrations' | 'startTaskIntegration' | 'loadTaskIntegrationConflict' | 'resolveTaskIntegrationConflict' | 'assistTaskIntegrationConflict' | 'finalizeTaskIntegration'
>;

export function TaskGitMergeModal(props: { open: boolean; language: 'zh-CN' | 'en-US'; task: TaskRecord | null; projectName?: string; client: MergeClient | null; onChanged?: () => void | Promise<void>; onClose: () => void }) {
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
  const eligibleWorkspaces = workspaces?.items.filter((workspace) => workspace.state === 'reclaimed' || workspace.state === 'merged') ?? [];
  const activeConflict = integration?.state === 'conflicted' ? integration : null;
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
        const firstWorkspace = workspaceSnapshot.items.find((workspace) => workspace.id === conflicted?.workspaceId) ?? workspaceSnapshot.items.find((workspace) => workspace.state === 'reclaimed') ?? workspaceSnapshot.items[0];
        setWorkspaceId(firstWorkspace?.id ?? '');
        setIntegration(conflicted ?? null);
        setConflictPath(conflicted?.conflictFiles[0] ?? '');
        setBusy(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setBusy(false);
        setError(errorMessage(reason));
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
        setError(errorMessage(reason));
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
    if (!props.task || !props.client || !selectedWorkspace) return;
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
      setError(errorMessage(reason));
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
      setError(errorMessage(reason));
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
      setError(errorMessage(reason));
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
      setError(errorMessage(reason));
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
                <strong>{alreadyDelivered ? (zh ? '已交付' : 'Delivered') : zh ? '合入并推送' : 'Merge and push'}</strong>
              </span>
            </section>

            <section className="task-git-merge-config">
              <label>
                <span>{zh ? '任务分支' : 'Task branch'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '任务分支' : 'Task branch'}
                  value={workspaceId}
                  options={eligibleWorkspaces.map((workspace) => ({ value: workspace.id, label: workspace.branchName }))}
                  onChange={selectWorkspace}
                  disabled={busy}
                />
              </label>
              <label>
                <span>{zh ? '合入到' : 'Merge into'}</span>
                <ZeusSelect size="regular" ariaLabel={zh ? '合入目标' : 'Merge target'} value={target} options={targetOptions} onChange={setTarget} disabled={busy} searchable={false} />
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
                  disabled={busy}
                  searchable={false}
                />
              </label>
            </section>

            <section className="task-git-merge-preflight">
              <strong>{zh ? '一键合入会执行' : 'One-click delivery will'}</strong>
              <ol>
                <li>{zh ? '在隔离 integration worktree 中准备合入' : 'Prepare the merge in an isolated integration worktree'}</li>
                <li>{zh ? '无冲突时重新校验主工作区分支、HEAD 与干净状态' : 'Revalidate the primary branch, HEAD, and clean state'}</li>
                <li>{zh ? '快进目标分支，推送并校验远端提交' : 'Fast-forward the target, push, and verify the remote commit'}</li>
              </ol>
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
          ) : (
            <Button variant="primary" size="regular" busy={busy} onClick={() => void start()} disabled={!selectedWorkspace || alreadyDelivered}>
              {alreadyDelivered ? (zh ? `已交付到 ${selectedTargetBranch}` : `Delivered to ${selectedTargetBranch}`) : zh ? '合入并推送' : 'Merge and Push'}
            </Button>
          )}
        </footer>
      </section>
    </ModalPortal>
  );
}

function ConflictCodePane(props: { title: string; content: string }) {
  return (
    <section>
      <strong>{props.title}</strong>
      <pre>{props.content}</pre>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
