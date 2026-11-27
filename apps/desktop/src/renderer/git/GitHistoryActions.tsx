import { useEffect, useMemo, useState } from 'react';
import type { GitRebasePlanEntry, ProjectGitHistoryAction, ProjectGitLogInfo } from '@zeus/git-core';
import type { ProjectGitRepositoryWorkbenchItem } from '../apiClient.js';
import { FilePreview } from '../code/FilePreview.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { GitLogPathTree, readGitLogInfo } from './GitLogControls.js';

/** Dialog 保存操作打开时的仓库快照，执行器会重新确认当前 HEAD。 */
export interface GitHistoryDialogTarget {
  kind: 'reset' | 'interactive' | 'revision';
  repository: ProjectGitRepositoryWorkbenchItem;
  revision: string;
}

/** 历史动作共用工作台确认和 Git 实际选项。 */
export function GitHistoryDialog(props: { target: GitHistoryDialogTarget; projectId: string; onClose: () => void; onExecute: (action: ProjectGitHistoryAction, title: string) => Promise<boolean> }) {
  const { kind, repository, revision } = props.target;
  const [mode, setMode] = useState<NonNullable<ProjectGitHistoryAction['mode']>>('mixed');
  const [plan, setPlan] = useState<GitRebasePlanEntry[]>([]);
  const [data, setData] = useState<ProjectGitLogInfo>();
  const [file, setFile] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind === 'reset') return;
    let active = true;
    void readGitLogInfo(props.projectId, repository.id, { kind: kind === 'revision' ? 'tree' : 'rebase', ref: revision })
      .then((result) => {
        if (!active) return;
        setData(result);
        setPlan((result.commits ?? []).map((commit) => ({ revision: commit.hash, action: 'pick' })));
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [kind, props.projectId, repository.id, revision]);
  const title = { reset: 'Reset Current Branch to Here', interactive: 'Interactively Rebase from Here', revision: 'Repository at Revision' }[kind];
  /** 计划可覆盖长历史，标题通过 ID 直接定位。 */
  const summaries = useMemo(() => new Map(data?.commits?.map((commit) => [commit.hash, commit.subject])), [data]);
  const incomplete = plan.some((entry) => entry.action === 'reword' && !entry.message?.trim());
  /** 只在选择 Reword 时读取该提交的完整说明。 */
  function chooseAction(revision: string, action: GitRebasePlanEntry['action']): void {
    setPlan((current) => current.map((entry) => (entry.revision === revision ? { ...entry, action } : entry)));
    if (action !== 'reword' || plan.find((entry) => entry.revision === revision)?.message !== undefined) return;
    void readGitLogInfo(props.projectId, repository.id, { kind: 'message', ref: revision })
      .then((result) => {
        setPlan((current) => current.map((entry) => (entry.revision === revision && entry.message === undefined ? { ...entry, message: result.content ?? '' } : entry)));
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }
  /** 只移动已加载计划中的行，Git 仍会验证操作顺序和权限。 */
  function move(index: number, offset: number): void {
    setPlan((previous) => {
      const next = [...previous];
      const moved = next[index]!;
      next[index] = next[index + offset]!;
      next[index + offset] = moved;
      return next;
    });
  }
  /** 在用户确认后提交已选模式或计划。 */
  async function execute(): Promise<void> {
    if (kind === 'revision' || busy) return;
    setBusy(true);
    try {
      const completed = await props.onExecute({ type: 'history_edit', operation: kind, revision, expectedBranch: repository.snapshot.branch, expectedHeadSha: repository.snapshot.headSha, mode, plan }, title);
      if (completed) props.onClose();
      else setError('See the Git workbench for the operation result.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={busy} role="dialog" aria-label={title}>
      <section className={'project-git-reference-dialog git-history-action-dialog' + (kind === 'revision' ? ' is-revision' : '')} data-modal-surface="dialog">
        <header>
          <strong>{title}</strong>
          <small>
            {repository.name} · {revision.slice(0, 12)}
          </small>
        </header>
        <main>
          {kind === 'reset' ? (
            <>
              <label>
                Reset Type
                <select value={mode} onChange={(event) => setMode(event.currentTarget.value as typeof mode)}>
                  <option value="soft">Soft</option>
                  <option value="mixed">Mixed</option>
                  <option value="hard">Hard</option>
                  <option value="keep">Keep</option>
                </select>
              </label>
              <p>
                {
                  {
                    soft: 'Move HEAD and preserve the index and working tree.',
                    mixed: 'Move HEAD and reset the index. Keep working tree changes.',
                    hard: 'Move HEAD and overwrite tracked changes in the index and working tree.',
                    keep: 'Move HEAD and keep local changes when Git can do so.',
                  }[mode]
                }
              </p>
            </>
          ) : null}
          {kind === 'interactive' && data ? (
            <>
              {data.rebaseMerges ? (
                <p className="git-rebase-merge-notice" role="status">
                  Git will replay the individual commits and remove {data.rebaseMerges} {data.rebaseMerges === 1 ? 'merge commit' : 'merge commits'}.
                </p>
              ) : null}
              <div className="git-rebase-plan">
                {plan.map((entry, index) => (
                  <div key={entry.revision}>
                    <select
                      aria-label={'Action for ' + entry.revision.slice(0, 8)}
                      value={entry.action}
                      disabled={busy}
                      onChange={(event) => {
                        const action = event.currentTarget.value as GitRebasePlanEntry['action'];
                        chooseAction(entry.revision, action);
                      }}
                    >
                      {(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'] as const).map((action) => (
                        <option key={action} value={action}>
                          {action[0]!.toUpperCase() + action.slice(1)}
                        </option>
                      ))}
                    </select>
                    <code>{entry.revision.slice(0, 8)}</code>
                    <span data-icon-tooltip={summaries.get(entry.revision)}>{summaries.get(entry.revision)}</span>
                    <Button unstyled type="button" aria-label="Move commit up" disabled={busy || index === 0} onClick={() => move(index, -1)}>
                      ↑
                    </Button>
                    <Button unstyled type="button" aria-label="Move commit down" disabled={busy || index === plan.length - 1} onClick={() => move(index, 1)}>
                      ↓
                    </Button>
                    {entry.action === 'reword' ? (
                      <textarea
                        aria-label={'Commit message for ' + entry.revision.slice(0, 8)}
                        value={entry.message ?? ''}
                        rows={3}
                        maxLength={4096}
                        disabled={busy}
                        onChange={(event) => {
                          const message = event.currentTarget.value;
                          setPlan((current) => current.map((item) => (item.revision === entry.revision ? { ...item, message } : item)));
                        }}
                      />
                    ) : null}
                  </div>
                ))}
                {!plan.length ? <p role="status">No commits after the selected revision</p> : null}
              </div>
            </>
          ) : null}
          {kind === 'revision' && data ? (
            <div className="git-revision-browser">
              <aside>
                <input autoFocus type="search" placeholder="Search paths" aria-label="Search paths" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
                <GitLogPathTree paths={data.paths ?? []} search={search.trim().toLocaleLowerCase()} selected={file ? [file] : []} onChange={() => {}} onOpen={setFile} />
              </aside>
              <div aria-label="File at revision">
                {file && data.revision ? <FilePreview zh={false} request={{ kind: 'project-git', projectId: props.projectId, repositoryId: repository.id, path: file, snapshotRef: data.revision }} /> : <p>Select a file</p>}
              </div>
            </div>
          ) : null}
          {kind !== 'reset' && !data && !error ? <span role="status">Loading...</span> : null}
          {error ? <p role="alert">{error}</p> : null}
        </main>
        <footer>
          {kind === 'interactive' && data ? (
            <Button variant="secondary" disabled={busy} onClick={() => setPlan((data.commits ?? []).map((commit) => ({ revision: commit.hash, action: 'pick' })))}>
              Reset
            </Button>
          ) : null}
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            {kind === 'revision' ? 'Close' : 'Cancel'}
          </Button>
          {kind !== 'revision' ? (
            <Button variant={kind === 'reset' && mode === 'hard' ? 'danger' : 'primary'} busy={busy} disabled={busy || (kind === 'interactive' && (!plan.length || incomplete))} onClick={execute}>
              {kind === 'reset' ? 'Reset' : 'Start Rebase'}
            </Button>
          ) : null}
        </footer>
      </section>
    </ModalPortal>
  );
}
