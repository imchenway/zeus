import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowsClockwiseIcon as Refresh } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ArrowUpIcon as Push } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { SparkleIcon as Sparkle } from '@phosphor-icons/react/dist/csr/Sparkle';
import { StopIcon as Stop } from '@phosphor-icons/react/dist/csr/Stop';
import { ArchiveIcon as Archive } from '@phosphor-icons/react/dist/csr/Archive';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { TreeStructureIcon as TreeStructure } from '@phosphor-icons/react/dist/csr/TreeStructure';
import { ListBulletsIcon as ListBullets } from '@phosphor-icons/react/dist/csr/ListBullets';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import type { GitApiClient } from '../features/git/gitApiClient.js';
import type { GitDiffSummary, GitFileStatusSummary, ProjectGitAction, ProjectGitRepositoryWorkbenchItem, ProjectGitWorkbenchSnapshot } from '../features/git/gitContracts.js';
import { BranchSwitcher, CheckoutRevisionDialog, NewBranchDialog, PushDialog, StashDialog, UpdateProjectDialog } from '../git/GitRepositoryControls.js';
import type { BusyState, ExecutionOutcome, OperationTone, PushSelection } from '../git/gitWorkbenchTypes.js';
import { notifyProjectGitChanged, projectGitWorkbenchCacheEntry, readCachedProjectGitWorkbench, requestProjectGitWorkbench, subscribeProjectGitRefresh, visibleRepositoryFiles } from '../git/projectGitWorkbenchState.js';
import { useGitCommitDrafts } from '../git/useGitCommitDrafts.js';
import { repositoryColor } from '../git/repositoryColor.js';
import { loadGitCommitModelOptions, type GitCommitModelsClient } from '../git/gitCommitModels.js';
import { Button } from '../ui/Button.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import './sourceGitChanges.css';

export type SourceGitClient = Pick<GitApiClient, 'loadProjectGitWorkbench' | 'executeProjectGitAction' | 'generateGitCommitMessage'> & GitCommitModelsClient;
export interface SourceGitChangePreview {
  path: string;
  repositoryPath: string;
  repositoryId: string;
  diff: GitDiffSummary;
  revision: string;
}
type Selection = Record<string, string[]>;
type ChangeGroup = 'conflicts' | 'changes' | 'untracked';

/** 编辑中的提交选择独立于 Git index，只有提交动作才暂存所选文件。 */
export function SourceGitChanges(props: {
  projectId: string;
  zh: boolean;
  client?: SourceGitClient;
  onConflict(path: string): void;
  onOpen(preview: SourceGitChangePreview): void;
  onOpenFile(path: string): void;
  onBeforeCommit(): Promise<boolean>;
  onSnapshot(snapshot: ProjectGitWorkbenchSnapshot): void;
}) {
  const { client, projectId, zh } = props;
  const [snapshot, setSnapshot] = useState(() => (client ? readCachedProjectGitWorkbench(client, projectId) : null));
  const [loading, setLoading] = useState(!snapshot);
  const [loadError, setLoadError] = useState('');
  const snapshotRef = useRef(snapshot);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [tab, setTab] = useState<'commit' | 'stash'>('commit');
  const [query, setQuery] = useState('');
  const [fileView, setFileView] = useState<'tree' | 'flat'>(() => {
    try {
      return localStorage.getItem('zeus.source.git.file-view.v1') === 'flat' ? 'flat' : 'tree';
    } catch {
      return 'tree';
    }
  });
  const [selection, setSelection] = useState<Selection>({});
  const [activeRepositoryId, setActiveRepositoryId] = useState('');
  const [activeFile, setActiveFile] = useState('');
  const [busy, setBusy] = useState<BusyState>(null);
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generatedText, setGeneratedText] = useState<string | null>(null);
  const generationController = useRef<AbortController | null>(null);
  const actionLock = useRef(false);
  const commitLock = useRef(false);
  const requestVersion = useRef(0);
  const latest = useRef(props);
  latest.current = props;
  const [drafts, setDrafts] = useGitCommitDrafts(projectId);
  const message = drafts['source-selection'] ?? '';
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [dialog, setDialog] = useState<'branch' | 'revision' | 'update' | 'push' | 'stash' | null>(null);
  const [baseRef, setBaseRef] = useState('');
  const [operationErrors, setOperationErrors] = useState<Record<string, string>>({});
  const [pushResults, setPushResults] = useState<Array<{ repositoryId: string; repositoryName: string; tone: OperationTone; message: string }>>([]);
  const repositories = snapshot?.repositories ?? [];
  const repository = repositories.find((item) => item.id === activeRepositoryId) ?? repositories[0] ?? null;
  const locked = submitting || busy !== null || generating;
  const selectedCount = Object.values(selection).reduce((count, paths) => count + paths.length, 0);
  const selectedRepositories = repositories.filter((item) => selection[item.id]?.length);
  const selectionKey = JSON.stringify(selectedRepositories.map((item) => [item.id, item.snapshot.headSha, item.snapshot.branch, selection[item.id]]));
  useEffect(() => () => generationController.current?.abort(), [projectId, client, selectionKey]);
  const conflicts = repositories.reduce((count, item) => count + item.snapshot.conflictFiles.length, 0);
  const filteredQuery = query.trim().toLocaleLowerCase();
  const acceptSnapshot = useCallback((next: ProjectGitWorkbenchSnapshot) => {
    const previous = snapshotRef.current;
    snapshotRef.current = next;
    setSnapshot(next);
    setSelection((current) =>
      Object.fromEntries(
        next.repositories.map((item) => {
          const valid = new Set(item.snapshot.fileStatuses.filter((file) => !item.snapshot.conflictFiles.includes(file.path)).map((file) => file.path));
          const old = previous?.repositories.find((repository) => repository.id === item.id);
          const changedBranch = old && (old.snapshot.branch !== item.snapshot.branch || old.snapshot.headSha !== item.snapshot.headSha);
          return [item.id, changedBranch ? [] : (current[item.id] ?? []).filter((path) => valid.has(path))];
        }),
      ),
    );
    latest.current.onSnapshot(next);
  }, []);
  const refresh = useCallback(async () => {
    if (!client || actionLock.current || commitLock.current) return;
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const next = await requestProjectGitWorkbench(client, projectId);
      if (version !== requestVersion.current) return;
      acceptSnapshot(next);
      setLoadError('');
    } catch (reason) {
      if (version === requestVersion.current) setLoadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [client, projectId, acceptSnapshot]);
  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeProjectGitRefresh(projectId, () => void refresh());
    return () => {
      requestVersion.current += 1;
      unsubscribe();
    };
  }, [projectId, refresh]);

  async function execute(target: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string): Promise<ExecutionOutcome> {
    if (!client || actionLock.current) return null;
    actionLock.current = true;
    requestVersion.current += 1;
    projectGitWorkbenchCacheEntry(client, projectId).request = null;
    setBusy({ repositoryId: target.id, action: action.type });
    setError('');
    setFeedback('');
    setOperationErrors((current) => {
      const next = { ...current };
      delete next[target.id];
      return next;
    });
    try {
      if (['checkout', 'checkout_revision', 'create_branch', 'merge', 'rebase', 'pull', 'stash', 'apply_stash', 'update'].includes(action.type) && !(await latest.current.onBeforeCommit())) {
        setError(zh ? '文件未能保存，操作已取消。' : 'Save the edited files before continuing.');
        return null;
      }
      const result = await client.executeProjectGitAction(projectId, target.id, action);
      const current = snapshotRef.current;
      if (current) {
        const next = { ...current, refreshedAt: new Date().toISOString(), repositories: current.repositories.map((item) => (item.id === target.id ? { ...item, snapshot: result.snapshot } : item)) };
        projectGitWorkbenchCacheEntry(client, projectId).snapshot = next;
        acceptSnapshot(next);
      }
      notifyProjectGitChanged(projectId);
      if (result.result.outcome === 'conflict') {
        setTab('commit');
        setFeedback(zh ? '操作产生冲突，请打开冲突文件处理。' : 'Resolve the conflicted files to continue.');
      }
      return result.result.outcome;
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason);
      setError(`${label}：${text}`);
      setOperationErrors((current) => ({ ...current, [target.id]: text }));
      return null;
    } finally {
      actionLock.current = false;
      setBusy(null);
      setLoading(false);
      if (!commitLock.current) void refresh();
    }
  }

  async function commitSelection(pushAfter: boolean) {
    if (!selectedCount || !message.trim() || locked || commitLock.current) return;
    const targets = selectedRepositories.map((item) => ({ repository: item, paths: [...selection[item.id]] }));
    commitLock.current = true;
    setSubmitting(true);
    setFeedback('');
    let completed = 0;
    try {
      if (!(await props.onBeforeCommit())) {
        setError(zh ? '文件未能保存，提交已取消。' : 'Save the files before committing.');
        return;
      }
      for (const target of targets) {
        const result = await execute(
          target.repository,
          { type: 'commit', paths: target.paths, message: message.trim(), expectedHeadSha: target.repository.snapshot.headSha, expectedBranch: target.repository.snapshot.branch },
          zh ? '提交所选文件' : 'Commit selected files',
        );
        if (result !== 'completed') {
          setFeedback(zh ? `已完成 ${completed}/${targets.length} 个仓库，剩余选择和提交说明已保留。` : `${completed}/${targets.length} repositories completed. Remaining selections and message are retained.`);
          return;
        }
        completed += 1;
        setSelection((current) => ({ ...current, [target.repository.id]: [] }));
      }
      setDrafts((current) => ({ ...current, 'source-selection': '' }));
      setFeedback(zh ? `已提交 ${selectedCount} 个文件 · ${completed} 个仓库` : `Committed ${selectedCount} files across ${completed} repositories`);
      if (pushAfter) {
        setPushResults([]);
        setDialog('push');
      }
    } finally {
      commitLock.current = false;
      setSubmitting(false);
      void refresh();
    }
  }

  async function generateCommitMessage() {
    if (!client || locked || !selectedCount || generationController.current) return;
    const controller = new AbortController();
    generationController.current = controller;
    const selected = selectedRepositories.map((item) => ({ repositoryId: item.id, relativePath: item.relativePath, paths: [...selection[item.id]] }));
    setGenerating(true);
    setGeneratedText(null);
    setError('');
    setFeedback(zh ? '正在生成提交说明…' : 'Generating commit message…');
    try {
      if (!(await latest.current.onBeforeCommit())) throw new Error(zh ? '文件未能保存，生成已取消。' : 'Save the files before generating.');
      controller.signal.throwIfAborted();
      const models = await loadGitCommitModelOptions(client, projectId);
      controller.signal.throwIfAborted();
      if (!models.modelRef) throw new Error(models.warning || (zh ? '暂无可用模型，请在设置中配置模型连接后重试。' : 'No models available. Configure a model connection in Settings, then retry.'));
      const first = selected[0]!;
      const result = await client.generateGitCommitMessage(
        projectId,
        { repositoryId: first.repositoryId, relativePath: first.relativePath, selection: selected, language: zh ? 'zh-CN' : 'en', modelRef: models.modelRef },
        (text) => {
          if (!controller.signal.aborted) setGeneratedText(text);
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setDrafts((current) => ({ ...current, 'source-selection': result.message }));
      setFeedback(
        (zh ? `已由 ${result.model} 生成，请检查后提交。` : `Generated by ${result.model}. Review before committing.`) +
          (result.truncated ? (zh ? ' 部分文件已省略或截断，请核对完整性。' : ' Some files were summarized; check completeness.') : ''),
      );
    } catch (reason) {
      if (controller.signal.aborted) setFeedback(zh ? '已停止生成，已保留提交说明。' : 'Generation stopped. Your commit message is retained.');
      else {
        setFeedback('');
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (generationController.current === controller) {
        generationController.current = null;
        setGenerating(false);
        setGeneratedText(null);
      }
    }
  }

  function toggle(target: ProjectGitRepositoryWorkbenchItem, paths: string[], checked: boolean) {
    setSelection((current) => ({ ...current, [target.id]: checked ? [...new Set([...(current[target.id] ?? []), ...paths])] : (current[target.id] ?? []).filter((path) => !paths.includes(path)) }));
  }
  function openFile(target: ProjectGitRepositoryWorkbenchItem, file: GitFileStatusSummary) {
    setActiveRepositoryId(target.id);
    setActiveFile(`${target.id}:${file.path}`);
    const path = projectPath(target, file.path);
    if (target.snapshot.conflictFiles.includes(file.path)) props.onConflict(path);
    else props.onOpen({ path, repositoryPath: file.path, repositoryId: target.id, diff: fileDiff(target, file.path), revision: snapshot?.refreshedAt ?? '' });
  }
  const canCommit = selectedCount > 0 && Boolean(message.trim()) && !locked && selectedRepositories.every((item) => !item.snapshot.integrationState && !item.snapshot.conflictFiles.length);
  const fileCount = repositories.reduce((count, item) => count + visibleRepositoryFiles(item, repositories).length, 0);
  const groupLabels = { conflicts: zh ? '冲突' : 'Conflicts', changes: zh ? '更改' : 'Changes', untracked: zh ? '未版本控制的文件' : 'Unversioned Files' };
  return (
    <details className="project-source-module project-source-changes source-git-module" open>
      <summary>
        {zh ? '更改' : 'Changes'}
        <span className="source-git-total">{fileCount}</span>
      </summary>
      <div className="source-git-body">
        <div className="source-git-tabs" role="tablist" aria-label={zh ? '更改工具窗口' : 'Changes tool window'}>
          <button type="button" role="tab" aria-selected={tab === 'commit'} onClick={() => setTab('commit')}>
            {zh ? '提交' : 'Commit'}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'stash'} onClick={() => setTab('stash')}>
            {zh ? '贮藏' : 'Stash'}
            <small>{repositories.reduce((count, item) => count + item.snapshot.stashes.length, 0)}</small>
          </button>
          <button type="button" className="source-git-icon" aria-label={zh ? '刷新更改' : 'Refresh changes'} title={zh ? '刷新更改' : 'Refresh changes'} disabled={locked || loading} onClick={() => void refresh()}>
            <Refresh className={loading ? 'is-spinning' : ''} />
          </button>
        </div>
        {repository ? (
          <div className="source-git-actions">
            <BranchSwitcher
              cascadeRepositories
              zh={zh}
              repositories={repositories}
              selectedRepository={repository}
              busy={locked ? (busy ?? { repositoryId: repository.id, action: 'commit' }) : null}
              onSelectRepository={setActiveRepositoryId}
              onExecute={execute}
              onOpenDiff={(target, filePath, options) => {
                void window.zeus?.openProjectGitDiffWindow?.({ projectId, repositoryId: target.id, filePath, stage: 'combined', ...options });
              }}
              onOpenUpdate={() => setDialog('update')}
              onOpenCommit={() => {
                setTab('commit');
                messageRef.current?.focus();
              }}
              onOpenPush={() => {
                setPushResults([]);
                setDialog('push');
              }}
              onOpenNewBranch={(ref) => {
                setBaseRef(ref ?? '');
                setDialog('branch');
              }}
              onOpenRevision={() => setDialog('revision')}
            />
            <button
              type="button"
              className="source-git-icon"
              disabled={locked || repository.snapshot.clean || repository.snapshot.conflictFiles.length > 0}
              aria-label={zh ? '贮藏当前仓库更改' : 'Stash repository changes'}
              title={zh ? '贮藏当前仓库更改' : 'Stash repository changes'}
              onClick={() => setDialog('stash')}
            >
              <Archive />
            </button>
            <button
              type="button"
              className="source-git-icon"
              disabled={locked || !repository.snapshot.remotes.length}
              aria-label={zh ? '推送…' : 'Push…'}
              title={zh ? '推送…' : 'Push…'}
              onClick={() => {
                setPushResults([]);
                setDialog('push');
              }}
            >
              <Push />
            </button>
          </div>
        ) : null}
        {error || loadError ? (
          <p className="source-git-error" role="alert">
            {error || loadError}
          </p>
        ) : null}
        {!client ? <p className="source-git-empty">{zh ? 'Git 服务尚未连接。' : 'Git is not connected.'}</p> : !snapshot && loading ? <p className="source-git-empty">{zh ? '正在读取更改…' : 'Loading changes…'}</p> : null}
        {tab === 'commit' ? (
          <>
            <div className="source-git-file-tools">
              <label className="source-git-search">
                <Search />
                <input aria-label={zh ? '筛选更改文件' : 'Filter changed files'} placeholder={zh ? '筛选文件…' : 'Filter files…'} value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
              </label>
              <span className="project-git-file-view-control" title={fileView === 'flat' ? (zh ? '平铺结构' : 'Flat view') : zh ? '树状结构' : 'Tree view'}>
                {fileView === 'flat' ? <ListBullets aria-hidden="true" /> : <TreeStructure aria-hidden="true" />}
                <CaretDown aria-hidden="true" />
                <select
                  className="project-git-file-view-select"
                  aria-label={zh ? `更改文件显示方式：${fileView === 'flat' ? '平铺结构' : '树状结构'}` : `Changed file view: ${fileView === 'flat' ? 'Flat view' : 'Tree view'}`}
                  value={fileView}
                  onChange={(event) => {
                    const next = event.currentTarget.value === 'flat' ? 'flat' : 'tree';
                    setFileView(next);
                    try {
                      localStorage.setItem('zeus.source.git.file-view.v1', next);
                    } catch {
                      /* 存储不可用时保留当前会话选择。 */
                    }
                  }}
                >
                  <option value="tree">{zh ? '树状结构' : 'Tree view'}</option>
                  <option value="flat">{zh ? '平铺结构' : 'Flat view'}</option>
                </select>
              </span>
            </div>
            <div className="source-git-files" aria-busy={loading}>
              {(['conflicts', 'changes', 'untracked'] as const).map((group: ChangeGroup) => {
                const groups = repositories
                  .map((item) => ({
                    repository: item,
                    files: visibleRepositoryFiles(item, repositories).filter((file) => {
                      const conflict = item.snapshot.conflictFiles.includes(file.path);
                      const kind = conflict ? 'conflicts' : file.indexStatus === '?' ? 'untracked' : 'changes';
                      return kind === group && (!filteredQuery || `${item.name}/${file.path}`.toLocaleLowerCase().includes(filteredQuery));
                    }),
                  }))
                  .filter((item) => item.files.length);
                if (!groups.length) return null;
                return (
                  <details key={group} className="source-git-group" open>
                    <summary>
                      <strong>{groupLabels[group]}</strong>
                      <small>{groups.reduce((count, item) => count + item.files.length, 0)}</small>
                    </summary>
                    {groups.map(({ repository: item, files }) => (
                      <details key={item.id} className="source-git-repository" open>
                        <summary onClick={() => setActiveRepositoryId(item.id)}>
                          {group !== 'conflicts' ? (
                            <SelectionCheckbox
                              label={(zh ? '选择仓库文件 ' : 'Select files in ') + item.name}
                              paths={files.map((file) => file.path)}
                              selected={selection[item.id] ?? []}
                              disabled={locked}
                              onChange={(checked) =>
                                toggle(
                                  item,
                                  files.map((file) => file.path),
                                  checked,
                                )
                              }
                            />
                          ) : null}
                          <span className="source-git-repository-color" style={{ '--repository-color': repositoryColor(item.id) } as CSSProperties} />
                          <strong>{item.name}</strong>
                          <small title={item.snapshot.branch}>{item.snapshot.branch}</small>
                        </summary>
                        <SourceChangeTree
                          view={fileView}
                          files={files}
                          selected={selection[item.id] ?? []}
                          selectedPath={activeFile.startsWith(`${item.id}:`) ? activeFile.slice(item.id.length + 1) : ''}
                          zh={zh}
                          disabled={locked}
                          selectable={group !== 'conflicts'}
                          onToggle={(paths, checked) => toggle(item, paths, checked)}
                          onOpen={(file) => openFile(item, file)}
                          onOpenFile={(file) => props.onOpenFile(projectPath(item, file.path))}
                        />
                      </details>
                    ))}
                  </details>
                );
              })}
              {snapshot && !fileCount ? <p className="source-git-empty">{!repositories.length ? (zh ? '项目中没有 Git 仓库' : 'No Git repositories in this project') : zh ? '工作区干净' : 'Working tree clean'}</p> : null}
              {snapshot && fileCount > 0 && filteredQuery && !repositories.some((item) => visibleRepositoryFiles(item, repositories).some((file) => `${item.name}/${file.path}`.toLocaleLowerCase().includes(filteredQuery))) ? (
                <p className="source-git-empty">{zh ? '没有匹配的更改文件' : 'No matching changes'}</p>
              ) : null}
            </div>
            <div className="source-git-commit">
              <div className="source-git-message">
                <textarea
                  ref={messageRef}
                  aria-label={zh ? '提交说明' : 'Commit message'}
                  placeholder={zh ? '提交说明' : 'Commit message'}
                  rows={3}
                  value={generatedText ?? message}
                  disabled={submitting || busy !== null}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    generationController.current?.abort();
                    setGeneratedText(null);
                    setDrafts((current) => ({ ...current, 'source-selection': value }));
                  }}
                />
                <button
                  type="button"
                  className="source-git-icon source-git-generate"
                  aria-label={generating ? (zh ? '停止生成提交说明' : 'Stop generating commit message') : zh ? 'AI 生成提交说明' : 'Generate commit message with AI'}
                  title={
                    generating ? (zh ? '停止生成' : 'Stop generating') : !selectedCount ? (zh ? '请先勾选要提交的文件' : 'Select files to commit first') : zh ? '根据勾选文件生成提交说明' : 'Generate a commit message from selected files'
                  }
                  disabled={!generating && (!client || locked || !selectedCount)}
                  data-generating={generating}
                  onClick={() => {
                    if (generating) generationController.current?.abort();
                    else void generateCommitMessage();
                  }}
                >
                  {generating ? <Stop aria-hidden="true" weight="fill" /> : <Sparkle aria-hidden="true" />}
                </button>
              </div>
              <div className="source-git-selection-count">
                {zh ? `已选择 ${selectedCount} 个文件` : `${selectedCount} files selected`}
                {selectedRepositories.length > 1 ? ` · ${selectedRepositories.length} ${zh ? '个仓库' : 'repositories'}` : ''}
              </div>
              {conflicts ? <small>{zh ? '有冲突的仓库需先解决冲突。' : 'Resolve repository conflicts before committing.'}</small> : null}
              <div className="source-git-commit-buttons">
                <Button size="compact" variant="primary" busy={submitting} disabled={!canCommit} onClick={() => void commitSelection(false)}>
                  {zh ? '提交' : 'Commit'}
                </Button>
                <Button size="compact" variant="secondary" disabled={!canCommit} onClick={() => void commitSelection(true)}>
                  {zh ? '提交并推送…' : 'Commit and Push…'}
                </Button>
              </div>
              {feedback ? (
                <p className="source-git-feedback" role="status">
                  {feedback}
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="source-git-files source-git-stashes">
            {repositories
              .filter((item) => item.snapshot.stashes.length)
              .map((item) => (
                <details key={item.id} open>
                  <summary>
                    {item.name}
                    <small>{item.snapshot.stashes.length}</small>
                  </summary>
                  {item.snapshot.stashes.map((stash) => (
                    <div key={stash.ref} className="source-git-stash">
                      <button
                        type="button"
                        title={stash.subject}
                        onClick={() => {
                          void window.zeus?.openProjectGitDiffWindow?.({ projectId, repositoryId: item.id, filePath: '', stage: 'combined', commitHash: stash.ref });
                        }}
                      >
                        <Archive />
                        <span>
                          {stash.subject}
                          <small>{stash.ref}</small>
                        </span>
                      </button>
                      <button type="button" disabled={locked} onClick={() => void execute(item, { type: 'apply_stash', stashRef: stash.ref }, zh ? '应用贮藏' : 'Apply stash')}>
                        {zh ? '应用' : 'Apply'}
                      </button>
                    </div>
                  ))}
                </details>
              ))}
            {!repositories.some((item) => item.snapshot.stashes.length) ? <p className="source-git-empty">{zh ? '没有贮藏的更改' : 'No stashed changes'}</p> : null}
          </div>
        )}
      </div>
      <MotionPresence>
        {dialog === 'branch' ? <NewBranchDialog open zh={zh} repositories={repositories} selectedRepository={repository} baseRef={baseRef} busy={busy} onClose={() => setDialog(null)} onExecute={execute} /> : null}
        {dialog === 'revision' ? <CheckoutRevisionDialog open zh={zh} repositories={repositories} selectedRepository={repository} busy={busy} onClose={() => setDialog(null)} onExecute={execute} /> : null}
        {dialog === 'update' ? <UpdateProjectDialog open projectId={projectId} zh={zh} repositories={repositories} busy={busy} errorsByRepository={operationErrors} onClose={() => setDialog(null)} onExecute={execute} /> : null}
        {dialog === 'stash' && repository ? <StashDialog repository={repository} zh={zh} busy={busy} onClose={() => setDialog(null)} onExecute={execute} /> : null}
        {dialog === 'push' ? (
          <PushDialog
            open
            zh={zh}
            repositories={repositories}
            selectedRepository={repository}
            busy={busy}
            results={pushResults}
            onClose={() => setDialog(null)}
            onPush={async (selections: PushSelection[], forceWithLease, pushTags) => {
              const results: typeof pushResults = [];
              for (const selected of selections) {
                const target = repositories.find((item) => item.id === selected.repositoryId);
                if (!target) continue;
                const outcome = await execute(
                  target,
                  { type: 'push', remote: selected.remote, sourceBranch: selected.sourceBranch, targetBranch: selected.targetBranch, setUpstream: selected.setUpstream, forceWithLease, pushTags },
                  zh ? '推送' : 'Push',
                );
                results.push({
                  repositoryId: target.id,
                  repositoryName: target.name,
                  tone: outcome === 'completed' ? 'success' : 'error',
                  message: outcome === 'completed' ? (zh ? '推送完成' : 'Push completed') : zh ? '推送未完成，请查看错误详情。' : 'Push failed. See the error details.',
                });
                setPushResults([...results]);
                if (outcome !== 'completed') break;
              }
            }}
          />
        ) : null}
      </MotionPresence>
    </details>
  );
}

function SelectionCheckbox(props: { label: string; paths: string[]; selected: string[]; disabled: boolean; onChange(checked: boolean): void }) {
  const count = props.paths.filter((path) => props.selected.includes(path)).length;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = count > 0 && count < props.paths.length;
  }, [count, props.paths.length]);
  return (
    <input
      ref={input}
      type="checkbox"
      aria-label={props.label}
      disabled={props.disabled}
      checked={props.paths.length > 0 && count === props.paths.length}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => props.onChange(event.currentTarget.checked)}
    />
  );
}

function SourceChangeTree(props: {
  view: 'tree' | 'flat';
  files: GitFileStatusSummary[];
  selected: string[];
  selectedPath: string;
  zh: boolean;
  disabled: boolean;
  selectable: boolean;
  onToggle(paths: string[], checked: boolean): void;
  onOpen(file: GitFileStatusSummary): void;
  onOpenFile(file: GitFileStatusSummary): void;
  prefix?: string;
}) {
  const prefix = props.prefix ?? '';
  const folders = new Map<string, GitFileStatusSummary[]>();
  const files: GitFileStatusSummary[] = [];
  for (const file of props.files) {
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (props.view === 'tree' && slash >= 0 && slash < rest.length - 1) {
      const folder = rest.slice(0, slash + 1);
      folders.set(folder, [...(folders.get(folder) ?? []), file]);
    } else files.push(file);
  }
  return (
    <div className="source-git-tree" data-view={props.view}>
      {[...folders]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([folder, children]) => (
          <details key={folder} open>
            <summary>
              {props.selectable ? (
                <SelectionCheckbox
                  label={(props.zh ? '选择目录 ' : 'Select directory ') + prefix + folder}
                  paths={children.map((file) => file.path)}
                  selected={props.selected}
                  disabled={props.disabled}
                  onChange={(checked) =>
                    props.onToggle(
                      children.map((file) => file.path),
                      checked,
                    )
                  }
                />
              ) : null}
              <Folder />
              <span>{folder.slice(0, -1)}</span>
              <small>{children.length}</small>
            </summary>
            <SourceChangeTree {...props} files={children} prefix={prefix + folder} />
          </details>
        ))}
      {files
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => (
          <div key={file.path} className="source-git-file" data-selected={props.selectedPath === file.path} data-status={file.category}>
            {props.selectable ? (
              <SelectionCheckbox
                label={(props.zh ? '选择提交文件 ' : 'Select file for commit ') + file.path}
                paths={[file.path]}
                selected={props.selected}
                disabled={props.disabled}
                onChange={(checked) => props.onToggle([file.path], checked)}
              />
            ) : null}
            <button type="button" title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path} onClick={() => props.onOpen(file)} onDoubleClick={() => props.onOpenFile(file)}>
              <File />
              <span className="source-git-file-name">{props.view === 'flat' ? file.path.slice(file.path.lastIndexOf('/') + 1) : file.path.slice(prefix.length)}</span>
              {props.view === 'flat' && file.path.includes('/') ? <span className="source-git-file-directory">{file.path.slice(0, file.path.lastIndexOf('/'))}</span> : null}
              <small>{file.indexStatus.trim() || file.workingTreeStatus.trim()}</small>
            </button>
          </div>
        ))}
    </div>
  );
}

function projectPath(repository: ProjectGitRepositoryWorkbenchItem, path: string): string {
  return [repository.relativePath === '.' ? '' : repository.relativePath, path].filter(Boolean).join('/');
}
export function fileDiff(repository: ProjectGitRepositoryWorkbenchItem, path: string): GitDiffSummary {
  const diff = repository.snapshot.diff;
  return { ...diff, files: [path], fileDiffs: diff.fileDiffs.filter((file) => file.newPath === path || file.oldPath === path) };
}
