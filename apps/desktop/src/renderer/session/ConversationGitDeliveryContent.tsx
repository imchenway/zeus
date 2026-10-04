import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DashboardClient, GitDiffSummary, ProjectGitAction, ProjectGitRepositoryWorkbenchItem, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import type { NativeConversationChoice } from './sessionTypes.js';
import { usePresenceOpen } from '../ui/MotionPresence.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { Button } from '../ui/Button.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { loadGitCommitModelOptions } from '../git/gitCommitModels.js';
import { notifyProjectGitChanged, subscribeProjectGitRefresh, visibleRepositoryFiles } from '../git/projectGitWorkbenchState.js';
import {
  DeliveryFeedbackNotice,
  DeliveryRepositoryFileTree,
  GitDeliveryActions,
  GitDeliveryWorkspace,
  InitialLoadState,
  type BatchDeliveryResult,
  type BusyAction,
  type DeliveryFeedback,
  type DeliveryRepositoryGroup,
  type DiffScope,
} from '../git/GitDeliveryWorkspace.js';

/** 会话目录只提供真实项目或会话仓库，不生成任务记录来套用交付界面。 */
export function ConversationGitDeliveryContent(props: { client: DashboardClient; project: ProjectRecord; conversation: NativeConversationChoice; language: 'zh-CN' | 'en-US'; onClose: () => void }) {
  /** 退出立即停止订阅，未完成的旧读取不回写新会话。 */
  const open = usePresenceOpen();
  /** 文案与错误沿用当前语言。 */
  const zh = props.language === 'zh-CN';
  /** 普通会话仅挂载到既有独立交付窗口，沿用其系统标题栏与全窗口布局。 */
  const standaloneWindow = document.body.dataset.surface === 'task-git-delivery';
  /** 每个弹窗拥有独立可访问标题。 */
  const titleId = useId();
  /** 仓库快照拥有当前分支、文件和提交事实。 */
  const [snapshot, setSnapshot] = useState<ProjectGitWorkbenchSnapshot | null>(null);
  /** 已提交变化只比较真实上游，未配置上游时不伪造来源分支。 */
  const [committed, setCommitted] = useState<Record<string, GitDiffSummary>>({});
  /** 比较失败保留仓库级原因，其余仓库继续显示。 */
  const [comparisonErrors, setComparisonErrors] = useState<Record<string, string>>({});
  /** 本次选择不与其他会话共用。 */
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  /** 仓库选择控制合入和推送，文件选择仅控制提交。 */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 审阅焦点独立于提交勾选。 */
  const [focus, setFocus] = useState({ repositoryId: '', path: '' });
  /** 两种入口采用相同文件范围。 */
  const [scope, setScope] = useState<DiffScope>('working');
  /** 普通目录的合入仍使用现有当前分支合入命令。 */
  const [mergeBranch, setMergeBranch] = useState('');
  /** 手动编辑和生成失败均保留提交说明。 */
  const [message, setMessage] = useState('');
  /** 生成期间只显示预览，确认完成后更新说明。 */
  const [generated, setGenerated] = useState<string | null>(null);
  /** 模型生成反馈与 Git 操作反馈独立。 */
  const [generationFeedback, setGenerationFeedback] = useState('');
  /** 操作状态同步锁定共用页面。 */
  const [busyAction, setBusyAction] = useState<BusyAction>('loading');
  /** 同步防止 React 更新前重复操作。 */
  const busyRef = useRef<BusyAction>('loading');
  /** 每次读取使用递增身份，防止旧分支结果覆盖新状态。 */
  const readRevision = useRef(0);
  /** 生成取消后不允许旧结果覆盖手动编辑。 */
  const generation = useRef<AbortController | null>(null);
  /** 页面错误保留真实失败原因和重试入口。 */
  const [error, setError] = useState<string | null>(null);
  /** 操作反馈使用任务交付页共用的逐仓明细。 */
  const [feedback, setFeedback] = useState<DeliveryFeedback | null>(null);
  /** 刷新时保留原有选择，首次加载默认勾选变化。 */
  const initialized = useRef(false);

  /** 仓库及文件读取完成后一次发布，差异直接来自同一快照。 */
  async function refresh(): Promise<void> {
    /** 本轮身份在任何 await 之前固定。 */
    const revision = ++readRevision.current;
    try {
      /** 只使用传入的范围客户端；普通项目与绑定会话不会互相回退。 */
      const next = await props.client.loadProjectGitWorkbench(props.project.id);
      if (revision !== readRevision.current) return;
      setSnapshot(next);
      setCommitted({});
      setComparisonErrors({});
      if (busyRef.current === 'loading') {
        busyRef.current = null;
        setBusyAction(null);
      }
      /** 固定刷新前的选择策略，不能让延后的 React 更新读到已经变化的引用。 */
      const preserveSelection = initialized.current;
      setSelectedIds((current) => (preserveSelection ? current.filter((id) => next.repositories.some((repository) => repository.id === id)) : next.repositories.map((repository) => repository.id)));
      setSelection((current) =>
        Object.fromEntries(
          next.repositories.map((repository) => {
            /** 已识别嵌套仓库不作为父仓库的目录占位文件。 */
            const paths = visibleRepositoryFiles(repository, next.repositories).map((file) => file.path);
            return [repository.id, preserveSelection ? (current[repository.id] ?? []).filter((path) => paths.includes(path)) : paths];
          }),
        ),
      );
      initialized.current = true;
      setError(null);
      /** 上游比较独立加载，不阻塞本机文件和差异的首屏。 */
      const comparisons = await Promise.allSettled(
        next.repositories.map((repository) => (repository.snapshot.upstream ? props.client.loadProjectGitComparisonDiff(props.project.id, repository.id, repository.snapshot.upstream, 'current') : Promise.resolve(null))),
      );
      if (revision !== readRevision.current) return;
      setCommitted(Object.fromEntries(comparisons.flatMap((result, index) => (result.status === 'fulfilled' && result.value ? [[next.repositories[index]!.id, result.value]] : []))));
      setComparisonErrors(Object.fromEntries(comparisons.flatMap((result, index) => (result.status === 'rejected' ? [[next.repositories[index]!.id, formatVisibleApplicationError(result.reason, zh ? 'zh-CN' : 'en')]] : []))));
    } catch (reason) {
      if (revision === readRevision.current) setError(formatVisibleApplicationError(reason, zh ? 'zh-CN' : 'en'));
    } finally {
      if (revision === readRevision.current && busyRef.current === 'loading') {
        busyRef.current = null;
        setBusyAction(null);
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    void refresh();
    /** 外部变化只在没有本页操作时刷新，避免提交前覆盖所选快照。 */
    const unsubscribe = subscribeProjectGitRefresh(props.project.id, () => {
      if (!busyRef.current) void refresh();
    });
    return () => {
      unsubscribe();
      ++readRevision.current;
      generation.current?.abort();
    };
  }, [open, props.client, props.project.id]);

  /** 同一仓库文件树用于文件选择、计数和差异定位。 */
  const groups = useMemo<DeliveryRepositoryGroup[]>(
    () =>
      (snapshot?.repositories ?? []).map((repository) => {
        /** 已提交与未提交范围分别来自上游比较及本机快照。 */
        const files =
          scope === 'committed'
            ? (committed[repository.id]?.fileDiffs ?? []).map((file) => ({ path: file.newPath || file.oldPath, label: zh ? '已提交' : 'Committed', additions: file.addedLines, deletions: file.deletedLines }))
            : visibleRepositoryFiles(repository, snapshot!.repositories).map((file) => ({ path: file.path, label: zh ? '未提交' : 'Uncommitted', additions: 0, deletions: 0 }));
        return {
          workspace: { id: repository.id, branchName: repository.snapshot.branch, state: 'ready', repositoryName: repository.name, repositoryRelativePath: repository.relativePath },
          detail: undefined,
          files,
          statusLabel: repository.snapshot.conflictFiles.length
            ? zh
              ? `${repository.snapshot.conflictFiles.length} 个冲突待处理`
              : 'Conflicts pending'
            : (comparisonErrors[repository.id] ?? (repository.snapshot.clean ? (zh ? '工作目录干净' : 'Clean worktree') : zh ? '有未提交修改' : 'Uncommitted changes')),
        };
      }),
    [snapshot, scope, committed, comparisonErrors, zh],
  );

  useEffect(() => {
    /** 保留有效焦点，首次打开选中真实变化，切范围后不留下旧文件。 */
    const group = groups.find((item) => item.workspace.id === focus.repositoryId && item.files.some((file) => file.path === focus.path));
    if (group) return;
    /** 没有文件时清空差异，不能停留在无限读取。 */
    const first = groups.find((item) => item.files.length);
    setFocus({ repositoryId: first?.workspace.id ?? '', path: first?.files[0]?.path ?? '' });
  }, [groups, focus.repositoryId, focus.path]);

  /** 当前可见文件直接过滤已读取补丁，不发起会随渲染重复启动的请求。 */
  const focusedRepository = snapshot?.repositories.find((repository) => repository.id === focus.repositoryId);
  /** 差异来源与文件树使用同一仓库身份。 */
  const diffSource = scope === 'working' ? focusedRepository?.snapshot.diff : committed[focus.repositoryId];
  /** 保留补丁信息，同时只呈现当前文件。 */
  const diff = diffSource ? { ...diffSource, files: [focus.path], fileDiffs: diffSource.fileDiffs.filter((file) => file.newPath === focus.path || file.oldPath === focus.path) } : null;
  /** 合入与推送仅使用勾选仓库。 */
  const selected = snapshot?.repositories.filter((repository) => selectedIds.includes(repository.id)) ?? [];
  /** 冲突仓库不能提交，其余仓库仍可交付。 */
  const commitSelection = selected
    .filter((repository) => !repository.snapshot.conflictFiles.length)
    .map((repository) => ({ repositoryId: repository.id, relativePath: repository.relativePath, paths: selection[repository.id] ?? [] }))
    .filter((item) => item.paths.length);
  /** 提交数量来自可执行的文件范围。 */
  const commitCount = commitSelection.reduce((count, item) => count + item.paths.length, 0);
  /** 合入现有分支保持当前检出，禁止在脏目录或未结束冲突中开始新合入。 */
  const mergeCandidates = selected.filter(
    (repository) =>
      mergeBranch &&
      repository.snapshot.clean &&
      !repository.snapshot.detached &&
      !repository.snapshot.integrationState &&
      !repository.snapshot.conflictFiles.length &&
      repository.snapshot.branch !== mergeBranch &&
      repository.snapshot.localBranches.includes(mergeBranch),
  );
  /** 未配置远端或没有待推送提交时，界面不能宣称可以推送。 */
  const pushCandidates = selected.filter(
    (repository) =>
      !repository.snapshot.detached && !repository.snapshot.integrationState && !repository.snapshot.conflictFiles.length && repository.snapshot.remotes.length && (!repository.snapshot.upstream || repository.snapshot.ahead > 0),
  );
  /** 可选分支仅来自所选仓库。 */
  const mergeOptions = [
    { value: '', label: zh ? '选择要合入的本地分支' : 'Select a local branch to merge' },
    ...[...new Set(selected.flatMap((repository) => repository.snapshot.localBranches.filter((branch) => branch !== repository.snapshot.branch)))].sort().map((branch) => ({ value: branch, label: branch })),
  ];
  /** 生成所选文件变化时同时固定分支和 HEAD。 */
  const generationKey = JSON.stringify(
    commitSelection.map((item) => {
      /** 分支可能变化而 HEAD 不变，生成身份必须同时包含两者。 */
      const repository = snapshot?.repositories.find((candidate) => candidate.id === item.repositoryId);
      return [item, repository?.snapshot.branch, repository?.snapshot.headSha];
    }),
  );
  useEffect(() => () => generation.current?.abort(), [generationKey]);

  /** 仓库与目录批量勾选复用同一入口，不改变审阅焦点。 */
  function toggleRepositories(ids: string[], checked: boolean): void {
    setSelectedIds((current) => (checked ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id))));
  }

  /** 文件只决定提交范围，重新选文件时同步选中所属仓库。 */
  function toggleFiles(id: string, paths: string[], checked: boolean): void {
    if (checked) toggleRepositories([id], true);
    setSelection((current) => ({ ...current, [id]: checked ? [...new Set([...(current[id] ?? []), ...paths])] : (current[id] ?? []).filter((path) => !paths.includes(path)) }));
  }

  /** 批量操作复用现有命令入口，分别显示成功、冲突和失败。 */
  async function execute(action: 'commit' | 'merge' | 'push', repositories: ProjectGitRepositoryWorkbenchItem[]): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = action;
    setBusyAction(action);
    setFeedback(null);
    try {
      /** 仓库相互独立，单仓失败不撤销其他仓库的成功。 */
      const results = await Promise.all(
        repositories.map(async (repository): Promise<BatchDeliveryResult> => {
          try {
            /** 提交带 HEAD 和分支约束，避免读取后分支切换导致提交错位。 */
            const input: ProjectGitAction =
              action === 'commit'
                ? { type: 'commit', message, paths: selection[repository.id] ?? [], expectedBranch: repository.snapshot.branch, expectedHeadSha: repository.snapshot.headSha }
                : action === 'merge'
                  ? { type: 'merge', branchName: mergeBranch }
                  : {
                      type: 'push',
                      remote: repository.snapshot.upstream?.split('/')[0] ?? repository.snapshot.remotes[0],
                      sourceBranch: repository.snapshot.branch,
                      targetBranch: repository.snapshot.upstream?.split('/').slice(1).join('/') || repository.snapshot.branch,
                      setUpstream: !repository.snapshot.upstream,
                    };
            /** 接口继续验证真实仓库范围及已有命令幂等身份。 */
            const response = await props.client.executeProjectGitAction(props.project.id, repository.id, input);
            return {
              workspaceId: repository.id,
              repositoryName: repository.name,
              status: response.result.outcome === 'conflict' ? 'attention' : 'succeeded',
              message: response.result.outcome === 'conflict' ? (zh ? `${response.result.conflictFiles.length} 个冲突待处理` : 'Conflicts require attention') : `${response.result.branch} · ${response.result.headSha.slice(0, 8)}`,
            };
          } catch (reason) {
            return { workspaceId: repository.id, repositoryName: repository.name, status: 'failed', message: formatVisibleApplicationError(reason, zh ? 'zh-CN' : 'en') };
          }
        }),
      );
      if (!open) return;
      setFeedback({
        action,
        results,
        tone: results.every((result) => result.status === 'succeeded') ? 'success' : 'warning',
        summary: zh ? `${results.filter((result) => result.status === 'succeeded').length}/${results.length} 个仓库成功` : `${results.filter((result) => result.status === 'succeeded').length}/${results.length} repositories succeeded`,
        text: results.map((result) => `${result.repositoryName}: ${result.message}`).join('\n'),
      });
      await refresh();
      notifyProjectGitChanged(props.project.id);
    } finally {
      busyRef.current = null;
      setBusyAction(null);
    }
  }

  /** 复用现有模型入口，只有完成的生成结果才覆盖草稿。 */
  async function generateMessage(): Promise<void> {
    if (generation.current) {
      generation.current.abort();
      return;
    }
    if (busyRef.current || !commitCount) return;
    /** 取消令牌绑定当前提交范围。 */
    const controller = new AbortController();
    generation.current = controller;
    busyRef.current = 'commit-message';
    setBusyAction('commit-message');
    setGenerationFeedback(zh ? '正在生成…' : 'Generating…');
    try {
      /** 与正常交付共用模型选项和流式生成。 */
      const models = await loadGitCommitModelOptions(props.client, props.project.id, controller.signal);
      controller.signal.throwIfAborted();
      if (!models.modelRef) throw new Error(models.warning || (zh ? '暂无可用模型。' : 'No model is available.'));
      /** 无任务目录不传 taskId，使用服务端验证过的仓库身份。 */
      const result = await props.client.generateGitCommitMessage(
        props.project.id,
        { repositoryId: commitSelection[0]!.repositoryId, selection: commitSelection, language: zh ? 'zh-CN' : 'en', modelRef: models.modelRef },
        (text) => {
          if (!controller.signal.aborted) setGenerated(text);
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setMessage(result.message);
      setGenerationFeedback(zh ? '已生成，请检查。' : 'Generated. Please review.');
    } catch (reason) {
      setGenerationFeedback(controller.signal.aborted ? (zh ? '已停止生成' : 'Generation stopped') : formatVisibleApplicationError(reason, zh ? 'zh-CN' : 'en'));
    } finally {
      generation.current = null;
      setGenerated(null);
      busyRef.current = null;
      setBusyAction(null);
    }
  }

  return (
    <ModalPortal
      rootClassName="task-git-merge-portal-root"
      backdropClassName="task-git-merge-backdrop"
      dismissDisabled={Boolean(busyAction && busyAction !== 'loading' && busyAction !== 'commit-message')}
      onDismiss={props.onClose}
      role="dialog"
      aria-labelledby={titleId}
    >
      <section className="task-git-merge-modal task-git-delivery-modal" data-modal-surface="dialog">
        <header className="task-git-merge-header">
          <span>
            <strong id={titleId}>{zh ? '代码交付' : 'Code Delivery'}</strong>
            <small>
              {props.project.name} · {props.conversation.title}
            </small>
          </span>
          {!standaloneWindow ? (
            <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={Boolean(busyAction && busyAction !== 'loading' && busyAction !== 'commit-message')}>
              ×
            </button>
          ) : null}
        </header>
        {snapshot && error ? (
          <div className="task-git-merge-status is-error" role="alert">
            <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
            <Button variant="secondary" size="compact" onClick={() => void refresh()} disabled={Boolean(busyAction)}>
              {zh ? '重新读取' : 'Retry'}
            </Button>
          </div>
        ) : null}
        <div className="task-git-merge-content">
          {!snapshot ? (
            <InitialLoadState zh={zh} error={error} onRetry={error ? () => void refresh() : undefined} />
          ) : (
            <GitDeliveryWorkspace
              zh={zh}
              selectedRepositories={selectedIds.length}
              totalRepositories={groups.length}
              selectedFiles={commitCount}
              busy={Boolean(busyAction)}
              selectedFile={focus.path}
              diffTitle={focusedRepository ? `${focusedRepository.name} / ${focus.path}` : zh ? '差异对比' : 'Diff'}
              diffLoading={false}
              diff={diff}
              revision={snapshot.refreshedAt}
              previewRequest={
                focusedRepository
                  ? {
                      kind: 'project-git',
                      projectId: props.project.id,
                      repositoryId: focusedRepository.id,
                      path: focus.path,
                      ...(scope === 'committed' ? { comparisonRef: focusedRepository.snapshot.upstream ?? undefined, comparisonMode: 'current' } : {}),
                    }
                  : undefined
              }
              onShowCommitted={scope === 'working' && Object.values(committed).some((value) => value.files.length) ? () => setScope('committed') : undefined}
              fileBrowser={
                <DeliveryRepositoryFileTree
                  groups={groups}
                  detailStates={{}}
                  diffScope={scope}
                  totalWorkingFiles={snapshot.repositories.reduce((count, repository) => count + visibleRepositoryFiles(repository, snapshot.repositories).length, 0)}
                  totalCommittedFiles={Object.values(committed).reduce((count, value) => count + value.files.length, 0)}
                  focusedWorkspaceId={focus.repositoryId}
                  selectedFile={focus.path}
                  selectedWorkspaceIds={new Set(selectedIds)}
                  selectedPathsByWorkspace={selection}
                  zh={zh}
                  disabled={Boolean(busyAction)}
                  onScopeChange={setScope}
                  onSelectFile={(repositoryId, path) => setFocus({ repositoryId, path })}
                  onToggleWorkspace={(id, checked) => toggleRepositories([id], checked)}
                  onToggleBranch={toggleRepositories}
                  onToggleFiles={toggleFiles}
                  onOpenFile={(repositoryId, path) => {
                    void window.zeus
                      ?.openProjectGitDiffWindow?.({
                        projectId: props.project.id,
                        repositoryId,
                        filePath: path,
                        stage: 'combined',
                        ...(scope === 'committed' ? { comparisonRef: snapshot.repositories.find((repository) => repository.id === repositoryId)?.snapshot.upstream ?? undefined, comparisonMode: 'current' } : {}),
                      })
                      .catch((reason) => setError(formatVisibleApplicationError(reason, zh ? 'zh-CN' : 'en')));
                  }}
                  onCopyBranch={async (branch) => {
                    try {
                      await navigator.clipboard.writeText(branch);
                    } catch (reason) {
                      setError(formatVisibleApplicationError(reason, zh ? 'zh-CN' : 'en'));
                    }
                  }}
                />
              }
              actions={
                <GitDeliveryActions
                  zh={zh}
                  busyAction={busyAction}
                  clientAvailable
                  canGenerate={Boolean(commitCount)}
                  onGenerate={() => void generateMessage()}
                  message={generated ?? message}
                  onMessageChange={(value) => {
                    generation.current?.abort();
                    setGenerated(null);
                    setMessage(value);
                  }}
                  generationFeedback={generationFeedback}
                  commitCount={commitCount}
                  onCommit={() =>
                    void execute(
                      'commit',
                      selected.filter((repository) => commitSelection.some((item) => item.repositoryId === repository.id)),
                    )
                  }
                  commitFeedback={feedback?.action === 'commit' ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} /> : null}
                  mergeTitle={zh ? '2. 合入当前分支' : '2. Merge into current branch'}
                  mergeDescription={zh ? '将所选本地分支合入各仓库当前分支；当前分支上的提交可直接推送。' : 'Merge the selected local branch into each repository’s current branch. Current commits can be pushed directly.'}
                  mergeTarget={mergeBranch}
                  mergeOptions={mergeOptions}
                  onMergeTargetChange={setMergeBranch}
                  mergeDisabled={!selectedIds.length}
                  mode="merge"
                  mergeCount={mergeCandidates.length}
                  onMerge={() => void execute('merge', mergeCandidates)}
                  mergeFeedback={feedback?.action === 'merge' ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} /> : null}
                  pushCount={pushCandidates.length}
                  onPush={() => void execute('push', pushCandidates)}
                  pushFeedback={feedback?.action === 'push' ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} /> : null}
                />
              }
            />
          )}
        </div>
        {!standaloneWindow ? (
          <footer className="task-git-merge-footer">
            <Button variant="secondary" size="regular" onClick={props.onClose} disabled={Boolean(busyAction && busyAction !== 'loading' && busyAction !== 'commit-message')}>
              {zh ? '关闭' : 'Close'}
            </Button>
          </footer>
        ) : null}
      </section>
    </ModalPortal>
  );
}
