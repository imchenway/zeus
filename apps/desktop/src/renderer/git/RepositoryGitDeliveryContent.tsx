import { GitDeliveryRunControl, type GitDeliveryClient } from './GitDeliveryRunControl.js';
import { useGitCommitDrafts } from './useGitCommitDrafts.js';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DashboardClient, GitDiffSummary, ProjectGitAction, ProjectGitRepositoryWorkbenchItem, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import { usePresenceOpen } from '../ui/MotionPresence.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { Button } from '../ui/Button.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { loadGitCommitModelOptions } from './gitCommitModels.js';
import { notifyProjectGitChanged, subscribeProjectGitRefresh, requestProjectGitWorkbench, visibleRepositoryFiles } from './projectGitWorkbenchState.js';
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
} from './GitDeliveryWorkspace.js';

/** 项目与会话仓库共用交付读取和写入能力，不要求项目伪造会话身份。 */
export type RepositoryGitDeliveryClient = Pick<DashboardClient, 'loadProjectGitWorkbench' | 'loadProjectGitComparisonDiff' | 'executeProjectGitAction' | 'generateGitCommitMessage' | 'loadGitCommitModels'>;

/** 展示范围与操作权限来自入口已有的项目、仓库或会话。 */
interface RepositoryGitDeliveryContentProps {
  /** 已经限定目录权限的客户端。 */
  client: RepositoryGitDeliveryClient;
  /** 当前真实项目。 */
  project: ProjectRecord;
  /** 界面文案语言。 */
  language: 'zh-CN' | 'en-US';
  /** 仅单仓入口限制仓库；项目和会话入口展示各自范围内的全部仓库。 */
  repositoryId?: string;
  /** 子树入口只筛选该目录内的文件。 */
  pathPrefix?: string;
  /** 用户可以回到当前仓库的全部文件。 */
  onClearPathPrefix?(): void;
  /** 后台组合只接受真实会话范围及其客户端。 */
  conversation?: { id: string; title: string; client: GitDeliveryClient };
  /** 项目与会话交付弹窗共用关闭生命周期。 */
  onClose?(): void;
}

/** 同一交付内容承载项目 Git 与普通会话，任务交付继续复用其下层视图。 */
export function RepositoryGitDeliveryContent(props: RepositoryGitDeliveryContentProps) {
  /** 退出立即停止订阅，未完成的旧读取不回写新会话。 */
  const open = usePresenceOpen();
  /** 文案与错误沿用当前语言。 */
  const zh = props.language === 'zh-CN';
  /** 普通会话仅挂载到既有独立交付窗口，沿用其系统标题栏与全窗口布局。 */
  const standaloneWindow = document.body.dataset.surface === 'task-git-delivery';
  /** 每个弹窗拥有独立可访问标题。 */
  const titleId = useId();
  /** 工作区和上游比较使用相同目录边界，文件计数与树节点保持一致。 */
  function fileInScope(path: string): boolean {
    return !props.pathPrefix || path === props.pathPrefix || path.startsWith(`${props.pathPrefix}/`);
  }
  /** 先在完整快照中排除嵌套占位，再限定入口仓库，避免子仓库被重复计算。 */
  function scopedSnapshot(value: ProjectGitWorkbenchSnapshot): ProjectGitWorkbenchSnapshot {
    return {
      ...value,
      repositories: value.repositories
        .filter((repository) => !props.repositoryId || repository.id === props.repositoryId)
        .map((repository) => ({
          ...repository,
          snapshot: { ...repository.snapshot, fileStatuses: visibleRepositoryFiles(repository, value.repositories).filter((file) => fileInScope(file.path)) },
        })),
    };
  }
  /** 仓库快照在原生交付窗口内读取，包含当前分支、文件和提交事实。 */
  const [snapshot, setSnapshot] = useState<ProjectGitWorkbenchSnapshot | null>(null);
  /** 已提交变化只比较真实上游，未配置上游时不伪造来源分支。 */
  const [committed, setCommitted] = useState<Record<string, GitDiffSummary>>({});
  /** 上游比较完成前保留仓库加载状态。 */
  const [comparisonLoading, setComparisonLoading] = useState(false);
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
  const [drafts, setDrafts] = useGitCommitDrafts(props.conversation ? `${props.project.id}:conversation:${props.conversation.id}` : props.project.id);
  /** 项目全量、单仓和会话分别保存草稿，避免不同提交范围互相覆盖。 */
  const draftKey = props.repositoryId ?? (props.conversation ? `conversation:${props.conversation.id}` : 'project');
  /** 读取现有草稿，不随工作台收起或切换页签丢失。 */
  const message = drafts[draftKey] ?? '';
  /** 手动输入和生成结果都通过同一草稿存储。 */
  function setMessage(value: string): void {
    setDrafts((current) => ({ ...current, [draftKey]: value }));
  }
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
      const complete = await requestProjectGitWorkbench(props.client, props.project.id);
      if (revision !== readRevision.current) return;
      /** 写入与展示仅使用入口限定后的真实仓库。 */
      const next = scopedSnapshot(complete);
      setSnapshot(next);
      setCommitted({});
      setComparisonLoading(true);
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
      setComparisonLoading(false);
      setCommitted(
        Object.fromEntries(
          comparisons.flatMap((result, index) =>
            result.status === 'fulfilled' && result.value
              ? [[next.repositories[index]!.id, { ...result.value, files: result.value.files.filter(fileInScope), fileDiffs: result.value.fileDiffs.filter((file) => fileInScope(file.newPath || file.oldPath)) }]]
              : [],
          ),
        ),
      );
      setComparisonErrors(Object.fromEntries(comparisons.flatMap((result, index) => (result.status === 'rejected' ? [[next.repositories[index]!.id, formatVisibleApplicationError(result.reason, zh ? 'zh-CN' : 'en')]] : []))));
    } catch (reason) {
      if (revision !== readRevision.current) return;
      setComparisonLoading(false);
      setError(formatVisibleApplicationError(reason, zh ? 'zh-CN' : 'en'));
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
  }, [open, props.client, props.project.id, props.repositoryId, props.pathPrefix]);

  /** 同一仓库文件树用于文件选择、计数和差异定位。 */
  const groups = useMemo<DeliveryRepositoryGroup[]>(
    () =>
      (snapshot?.repositories ?? []).map((repository) => {
        /** 已提交与未提交范围分别来自上游比较及本机快照。 */
        const files =
          scope === 'committed'
            ? (committed[repository.id]?.fileDiffs ?? []).map((file) => ({ path: file.newPath || file.oldPath, status: file.changeType, additions: file.addedLines, deletions: file.deletedLines }))
            : visibleRepositoryFiles(repository, snapshot!.repositories).map((file) => ({ path: file.path, status: file.category, additions: 0, deletions: 0 }));
        return {
          workspace: { id: repository.id, branchName: repository.snapshot.branch, state: 'ready', repositoryName: repository.name, repositoryRelativePath: repository.relativePath },
          detail: undefined,
          files,
          loadState: scope === 'committed' ? (comparisonErrors[repository.id] ? 'error' : comparisonLoading ? 'loading' : undefined) : undefined,
          statusLabel: repository.snapshot.conflictFiles.length
            ? zh
              ? `${repository.snapshot.conflictFiles.length} 个冲突待处理`
              : 'Conflicts pending'
            : ((scope === 'committed' ? comparisonErrors[repository.id] : undefined) ?? (repository.snapshot.clean ? (zh ? '工作目录干净' : 'Clean worktree') : zh ? '有未提交修改' : 'Uncommitted changes')),
        };
      }),
    [snapshot, scope, committed, comparisonErrors, comparisonLoading, zh],
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
    { value: '', label: zh ? '选择来源分支' : 'Select source branch' },
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
      if (action === 'commit' && results.every((result) => result.status === 'succeeded')) setMessage('');
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
        { repositoryId: commitSelection[0]!.repositoryId, selection: commitSelection, language: zh ? 'zh-CN' : 'en', ...models.settings },
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

  /** 项目内嵌与会话弹窗使用同一树、操作栏和 Diff 正文。 */
  const content = (
    <>
      {props.pathPrefix ? (
        <div className="git-delivery-folder-filter">
          <span>{props.pathPrefix}</span>
          <Button variant="secondary" size="compact" onClick={props.onClearPathPrefix} disabled={Boolean(busyAction)}>
            {zh ? '清除目录筛选' : 'Clear folder filter'}
          </Button>
        </div>
      ) : null}
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
            busy={Boolean(busyAction)}
            fileStatus={groups.find((group) => group.workspace.id === focus.repositoryId)?.files.find((file) => file.path === focus.path)?.status}
            selectedFile={focus.path}
            diffTitle={focusedRepository ? `${focusedRepository.name} / ${focus.path}` : zh ? '差异对比' : 'Diff'}
            diffLoading={false}
            diff={diff}
            revision={snapshot.refreshedAt}
            onFileSaved={() => refresh()}
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
                    return true;
                  } catch (reason) {
                    setError(formatVisibleApplicationError(reason, zh ? 'zh-CN' : 'en'));
                    return false;
                  }
                }}
              />
            }
            actions={
              <GitDeliveryActions
                zh={zh}
                busyAction={busyAction}
                generationClient={props.client}
                projectId={props.project.id}
                canGenerate={Boolean(commitCount)}
                onGenerate={() => void generateMessage()}
                message={generated ?? message}
                onMessageChange={(value) => {
                  generation.current?.abort();
                  setGenerated(null);
                  setMessage(value);
                }}
                generationFeedback={generationFeedback}
                beforeCommit={
                  commitSelection.some((item) =>
                    snapshot.repositories
                      .find((repository) => repository.id === item.repositoryId)
                      ?.snapshot.fileStatuses.some((file) => item.paths.includes(file.path) && file.indexStatus !== ' ' && file.indexStatus !== '?' && file.workingTreeStatus !== ' '),
                  ) ? (
                    <small>{zh ? '将包含所选文件的未暂存修改。' : 'Unstaged edits in selected files will be included.'}</small>
                  ) : undefined
                }
                commitCount={commitCount}
                onCommit={() =>
                  void execute(
                    'commit',
                    selected.filter((repository) => commitSelection.some((item) => item.repositoryId === repository.id)),
                  )
                }
                commitFeedback={feedback?.action === 'commit' ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} /> : null}
                mergeLabel={zh ? '合入来源分支' : 'Source branch'}
                mergeTarget={mergeBranch}
                mergeOptions={mergeOptions}
                onMergeTargetChange={setMergeBranch}
                mergeDisabled={!selectedIds.length}
                mode="merge"
                mergeCount={mergeCandidates.length}
                onMerge={() => void execute('merge', mergeCandidates)}
                mergeFeedback={feedback?.action === 'merge' ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} /> : null}
                combination={
                  props.conversation ? (
                    <GitDeliveryRunControl
                      client={props.conversation.client}
                      projectId={props.project.id}
                      zh={zh}
                      disabled={Boolean(busyAction)}
                      onAccepted={() => props.onClose?.()}
                      input={{
                        scope: { kind: 'conversation', conversationId: props.conversation.id },
                        message,
                        mode: 'merge',
                        repositories: selected.map((repository) => ({
                          repositoryId: repository.id,
                          paths: selection[repository.id] ?? [],
                          expectedBranch: repository.snapshot.branch,
                          expectedHeadSha: repository.snapshot.headSha,
                          mergeBranch,
                        })),
                      }}
                    />
                  ) : undefined
                }
                pushCount={pushCandidates.length}
                onPush={() => void execute('push', pushCandidates)}
                pushFeedback={feedback?.action === 'push' ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} /> : null}
              />
            }
          />
        )}
      </div>
    </>
  );
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
              {props.project.name}
              {props.conversation ? ` · ${props.conversation.title}` : ''}
            </small>
          </span>
          {!standaloneWindow ? (
            <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={Boolean(busyAction && busyAction !== 'loading' && busyAction !== 'commit-message')}>
              ×
            </button>
          ) : null}
        </header>
        {content}
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
