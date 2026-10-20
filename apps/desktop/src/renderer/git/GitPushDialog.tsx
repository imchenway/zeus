import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { FolderIcon } from '@phosphor-icons/react/dist/csr/Folder';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import type { DashboardClient, GitDiffSummary, GitFileDiff, ProjectGitPushPreview, ProjectGitRepositoryWorkbenchItem } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
import { fileStatusLabel } from '../code/fileStatus.js';
import { groupDirectoryFiles } from '../code/groupDirectoryFiles.js';
import { GitPaneSeparator } from './GitPaneSeparator.js';
import { defaultPushTarget } from './GitRepositoryControls.js';
import { repositoryColor } from './repositoryColor.js';
import type { BusyState, OperationTone, PushSelection } from './gitWorkbenchTypes.js';
import './gitPushDialog.css';

/** 勾选决定推送范围，当前查看项与勾选状态相互独立。 */
type PushEntry = PushSelection & { checked: boolean };
/** 同一预览身份保留加载、分页和失败反馈。 */
type PreviewState = { data?: ProjectGitPushPreview; error?: unknown; loading?: boolean };
/** 推送弹窗复用原操作入口，仅增加只读预览能力。 */
interface PushDialogProps {
  /** 弹窗可见状态。 */
  open: boolean;
  /** 中文显示开关。 */
  zh: boolean;
  /** 重复点击入口时唤回原窗口，保留文件树与勾选。 */
  activation?: number;
  /** 当前可信项目身份。 */
  projectId: string;
  /** 外部刷新后废弃旧的远程跟踪快照。 */
  revision: string;
  /** 现有只读查询客户端。 */
  client: Pick<DashboardClient, 'loadProjectGitPushPreview' | 'loadProjectGitCommit'>;
  /** 当前项目内可操作的仓库。 */
  repositories: ProjectGitRepositoryWorkbenchItem[];
  /** 打开弹窗时的当前仓库。 */
  selectedRepository: ProjectGitRepositoryWorkbenchItem | null;
  /** 与工作区操作共享忙碌锁。 */
  busy: BusyState;
  /** 原推送执行器返回的逐分支结果。 */
  results: Array<{ repositoryId: string; repositoryName: string; tone: OperationTone; message: string }>;
  /** 关闭时由父级清理操作结果。 */
  onClose: () => void;
  /** 只在用户点击主按钮后调用既有推送命令。 */
  onPush: (selections: PushSelection[], forceWithLease: boolean, pushTags: boolean) => Promise<void>;
}

/** 分支身份不随远端编辑变化，保证焦点和勾选状态稳定。 */
function entryKey(entry: PushSelection): string {
  return JSON.stringify([entry.repositoryId, entry.sourceBranch]);
}

/** 查询身份包含完整目标，防止切换目标后复用另一范围的提交。 */
function previewKey(entry: PushSelection, revision: string): string {
  return JSON.stringify([entry.repositoryId, entry.sourceBranch, entry.remote, entry.targetBranch.trim(), revision]);
}

/** 创建分支行时优先使用该分支的上游，缺省保持同名目标。 */
function createEntry(repository: ProjectGitRepositoryWorkbenchItem, sourceBranch: string, checked: boolean): PushEntry {
  /** 每个分支独立解析上游，不借用当前检出分支的目标。 */
  const upstream = repository.snapshot.branchUpstreams?.[sourceBranch];
  /** 最长前缀优先，兼容远端名称本身包含斜杠的配置。 */
  const remote = [...repository.snapshot.remotes].sort((left, right) => right.length - left.length).find((name) => upstream?.startsWith(`${name}/`)) ?? defaultPushTarget(repository).remote;
  return { repositoryId: repository.id, sourceBranch, remote, targetBranch: upstream?.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : sourceBranch, setUpstream: true, checked };
}

/** 推送确认以仓库和提交为中心，文件树只负责审阅，不改变推送范围。 */
export function PushDialog(props: PushDialogProps) {
  /** 默认只勾选入口对应的仓库，避免扩大原有推送范围。 */
  const [entries, setEntries] = useState<PushEntry[]>(() =>
    props.repositories.map((repository) =>
      createEntry(
        repository,
        repository.snapshot.detached ? '' : repository.snapshot.branch,
        repository.id === (props.selectedRepository?.id ?? props.repositories[0]?.id) && !repository.snapshot.detached && !!repository.snapshot.remotes.length && repository.snapshot.localBranches.includes(repository.snapshot.branch),
      ),
    ),
  );
  /** 当前行决定右侧预览，与其他仓库的勾选无关。 */
  const [activeKey, setActiveKey] = useState(() => (entries.length ? entryKey(entries.find((entry) => entry.checked) ?? entries[0]!) : ''));
  /** 初始只展开当前仓库，其他仓库可通过展开或勾选按需加载。 */
  const [expanded, setExpanded] = useState(() => new Set([activeKey]));
  /** 本次弹窗内缓存完整范围的读取，重复展开不重复请求。 */
  const requests = useRef(new Map<string, Promise<ProjectGitPushPreview>>());
  /** 查询结果按完整范围保存，异步完成不会覆盖另一个仓库。 */
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  /** 手动刷新只重读本地记录，不执行 fetch。 */
  const [refresh, setRefresh] = useState(0);
  /** 提交选择为空时展示整个分支的净差异。 */
  const [commitHash, setCommitHash] = useState('');
  /** 单提交差异同样携带范围身份，避免快速切换时闪回旧内容。 */
  const [commitDetail, setCommitDetail] = useState<{ key: string; diff?: GitDiffSummary; error?: unknown } | null>(null);
  /** 单击仅选中文件，打开系统差异窗口时保留文件树与原位置。 */
  const [selectedFilePath, setSelectedFilePath] = useState('');
  /** 目标编辑使用共用模态焦点管理。 */
  const [editingTargets, setEditingTargets] = useState(false);
  /** 推送标签保留原有显式开关。 */
  const [pushTags, setPushTags] = useState(false);
  /** 本地锁覆盖命令接纳前的瞬间，防止重复点击。 */
  const [submitting, setSubmitting] = useState(false);
  /** 推送执行或系统窗口打开失败时保留文件树与用户选择。 */
  const [operationError, setOperationError] = useState<unknown>(null);
  /** 数据刷新和手动刷新共同构成预览代次。 */
  const revision = `${props.revision}:${refresh}`;
  /** 当前仓库不受其他异步状态更新影响。 */
  const active = entries.find((entry) => entryKey(entry) === activeKey) ?? entries[0];
  /** 预览请求只包含展开项和当前查看项。 */
  const queryEntries = JSON.stringify(
    entries
      .filter((entry) => entry.sourceBranch && entry.remote && entry.targetBranch.trim() && (expanded.has(entryKey(entry)) || entryKey(entry) === activeKey))
      .map(({ repositoryId, remote, sourceBranch, targetBranch, setUpstream }) => ({ repositoryId, remote, sourceBranch, targetBranch, setUpstream })),
  );
  /** 结果页与提交期间都锁定范围。 */
  const locked = submitting || props.busy !== null;
  /** 逐仓执行后的结果不自动清除，也不自动重试。 */
  const resultMode = props.results.length > 0;

  useEffect(() => {
    /** 失效请求仍可完成缓存，但不能改变已切换页面的可见状态。 */
    let cancelled = false;
    /** 目标输入采用短延迟，避免每个字符都启动 Git 子进程。 */
    const timer = window.setTimeout(() => {
      for (const entry of JSON.parse(queryEntries) as PushSelection[]) {
        /** 完整目标与代次唯一标识请求。 */
        const key = previewKey(entry, revision);
        /** 复用同一目标已发出的读取。 */
        let request = requests.current.get(key);
        if (!request) {
          request = props.client.loadProjectGitPushPreview(props.projectId, entry.repositoryId, { ...entry, targetBranch: entry.targetBranch.trim() });
          requests.current.set(key, request);
        }
        setPreviews((current) => ({ ...current, [key]: current[key]?.data ? current[key]! : { loading: true } }));
        void request.then(
          (data) => {
            if (!cancelled) setPreviews((current) => ({ ...current, [key]: current[key]?.data ? current[key]! : { data } }));
          },
          (error: unknown) => {
            if (!cancelled) setPreviews((current) => ({ ...current, [key]: { error } }));
          },
        );
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [props.client, props.projectId, queryEntries, revision]);

  /** 当前预览身份在目标编辑后立即改变，旧数据不进入右侧。 */
  const activePreviewKey = active ? previewKey(active, revision) : '';
  /** 提交详情必须同时匹配当前行和提交。 */
  const detailKey = `${activePreviewKey}:${commitHash}`;
  useEffect(() => {
    if (!active || !commitHash) return;
    /** 关闭或换选后丢弃延迟到达的提交内容。 */
    let cancelled = false;
    void props.client.loadProjectGitCommit(props.projectId, active.repositoryId, commitHash).then(
      (detail) => {
        if (!cancelled) setCommitDetail({ key: detailKey, diff: detail.diff });
      },
      (error: unknown) => {
        if (!cancelled) setCommitDetail({ key: detailKey, error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.client, props.projectId, active?.repositoryId, commitHash, detailKey]);

  /** 切换查看对象时关闭旧文件，勾选范围保持不变。 */
  function inspect(entry: PushEntry, hash = ''): void {
    setActiveKey(entryKey(entry));
    setCommitHash(hash);
    setSelectedFilePath('');
  }

  /** 勾选分支同时展开其提交，取消勾选不丢弃审阅位置。 */
  function toggleEntry(entry: PushEntry, checked: boolean): void {
    setEntries((current) => current.map((item) => (entryKey(item) === entryKey(entry) ? { ...item, checked } : item)));
    if (checked) setExpanded((current) => new Set([...current, entryKey(entry)]));
    inspect(entry);
  }

  /** 下一页只扩展提交列表；分支移动时要求刷新，禁止拼接不同快照。 */
  async function loadMore(entry: PushEntry): Promise<void> {
    /** 固定读取时的范围身份。 */
    const key = previewKey(entry, revision);
    /** 已加载页是分页基线。 */
    const previous = previews[key]?.data;
    if (!previous || previews[key]?.loading) return;
    setPreviews((current) => ({ ...current, [key]: { data: previous, loading: true } }));
    try {
      /** 沿用同一个分支与目标，只增加偏移。 */
      const next = await props.client.loadProjectGitPushPreview(props.projectId, entry.repositoryId, { ...entry, targetBranch: entry.targetBranch.trim(), offset: previous.commits.length });
      if (next.sourceHeadSha !== previous.sourceHeadSha || next.targetHeadSha !== previous.targetHeadSha) throw new Error(props.zh ? '分支记录已变化，请刷新预览。' : 'Branch refs changed. Refresh the preview.');
      setPreviews((current) => ({ ...current, [key]: { data: { ...next, diff: previous.diff, commits: [...previous.commits, ...next.commits] } } }));
    } catch (error) {
      setPreviews((current) => ({ ...current, [key]: { data: previous, error } }));
    }
  }

  /** 普通推送和菜单强推共用校验；强推沿用 force-with-lease 保护。 */
  async function submit(forceWithLease: boolean): Promise<void> {
    if (pushDisabled) return;
    setSubmitting(true);
    setOperationError(null);
    try {
      await props.onPush(
        entries.filter((entry) => entry.checked).map(({ repositoryId, remote, sourceBranch, targetBranch, setUpstream }) => ({ repositoryId, remote, sourceBranch, targetBranch: targetBranch.trim(), setUpstream })),
        forceWithLease,
        pushTags,
      );
    } catch (error) {
      setOperationError(error);
    } finally {
      setSubmitting(false);
    }
  }

  /** 双击文件只传递当前比较范围的补丁，系统窗口不重读默认工作区。 */
  async function openFileDiff(path: string): Promise<void> {
    if (!active || !diff) return;
    setSelectedFilePath(path);
    setOperationError(null);
    try {
      /** 复用桌面系统窗口桥接，缺失时明确报错，不退回页内弹层。 */
      const openWindow = window.zeus?.openProjectGitDiffWindow;
      if (!openWindow || !window.zeus?.loadProjectGitDiffSnapshot) throw new Error(props.zh ? '系统差异窗口尚未就绪，请使用已更新并重启的 Zeus 桌面端。' : 'The system diff window is not ready. Update and restart the Zeus desktop app.');
      await openWindow({ projectId: props.projectId, repositoryId: active.repositoryId, filePath: path, stage: 'combined', diffText: diff.diffText });
    } catch (error) {
      setOperationError(error);
    }
  }

  if (!props.open || !active) return null;
  /** 仅勾选项参与推送和重复目标检查。 */
  const selected = entries.filter((entry) => entry.checked);
  /** 多个来源不能在同一次操作中覆盖同一远端目标。 */
  const duplicateTarget = new Set(selected.map((entry) => JSON.stringify([entry.repositoryId, entry.remote, entry.targetBranch.trim()]))).size !== selected.length;
  /** 外部刷新删除仓库、分支或远端时停止提交，不静默缩小用户选择。 */
  const unavailableSelection = selected.some((entry) => !props.repositories.some((item) => item.id === entry.repositoryId && item.snapshot.localBranches.includes(entry.sourceBranch) && item.snapshot.remotes.includes(entry.remote)));
  /** 两种推送动作使用相同的范围校验和执行锁。 */
  const pushDisabled = locked || !selected.length || duplicateTarget || unavailableSelection || selected.some((entry) => !entry.sourceBranch || !entry.remote || !entry.targetBranch.trim());
  /** 当前行对应的读取状态。 */
  const preview = previews[activePreviewKey];
  /** 整体范围和单提交范围共用文件树。 */
  const diff = commitHash ? (commitDetail?.key === detailKey ? commitDetail.diff : undefined) : preview?.data?.diff;
  /** 只展示当前身份的错误。 */
  const previewError = commitHash ? (commitDetail?.key === detailKey ? commitDetail.error : undefined) : preview?.error;
  /** 文件列表由补丁解析结果生成，覆盖删除、重命名和二进制文件。 */
  const files = diff?.fileDiffs.map((file) => ({ path: file.newPath || file.oldPath, file })) ?? [];
  /** 当前仓库名称来自已登记结果。 */
  const repository = props.repositories.find((item) => item.id === active.repositoryId);

  return (
    <ModalPortal
      systemWindow="git-push"
      windowActivation={props.activation}
      windowTitle={resultMode ? (props.zh ? '推送结果' : 'Push results') : props.zh ? '推送提交' : 'Push Commits'}
      rootClassName="project-git-modal-root"
      backdropClassName="project-git-modal-backdrop"
      dismissDisabled={locked}
      onDismiss={props.onClose}
      role="dialog"
      aria-label={props.zh ? '推送提交' : 'Push Commits'}
    >
      <section className="git-push-dialog" data-modal-surface="dialog">
        <header className="git-push-heading">
          <strong>{resultMode ? (props.zh ? '推送结果' : 'Push results') : props.zh ? '推送提交' : 'Push Commits'}</strong>
          <button type="button" aria-label={props.zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={locked}>
            <XIcon aria-hidden="true" />
          </button>
        </header>
        {resultMode ? (
          <main className="git-push-results" aria-live="polite">
            {props.results.map((result, index) => (
              <section key={`${result.repositoryId}:${index}`} data-tone={result.tone}>
                <strong>{result.repositoryName}</strong>
                {result.tone === 'error' ? <VisibleApplicationError error={result.message} language={props.zh ? 'zh-CN' : 'en'} /> : <p>{result.message}</p>}
              </section>
            ))}
          </main>
        ) : (
          <main className="git-push-layout">
            <section className="git-push-repositories" aria-label={props.zh ? '仓库与待推送提交' : 'Repositories and outgoing commits'}>
              <div className="git-push-scroll">
                {entries.map((entry) => {
                  /** 每一行独立保留查看、勾选与展开状态。 */
                  const key = entryKey(entry);
                  /** 仓库身份来自父级受信列表。 */
                  const owner = props.repositories.find((item) => item.id === entry.repositoryId);
                  if (!owner)
                    return (
                      <p className="git-push-alert" key={key} role="alert">
                        {props.zh ? '仓库列表已变化，请关闭后重新打开推送窗口。' : 'The repository list changed. Close and reopen Push.'}
                      </p>
                    );
                  /** 预览严格匹配本行的来源与目标。 */
                  const state = previews[previewKey(entry, revision)];
                  /** 无远端、无提交或分离 HEAD 时保留可解释的灰色行。 */
                  const available = owner.snapshot.remotes.includes(entry.remote) && owner.snapshot.localBranches.includes(entry.sourceBranch);
                  return (
                    <section className="git-push-repository" key={key}>
                      <div className="git-push-repository-row" data-active={activeKey === key && !commitHash} data-unavailable={!available}>
                        <button
                          className="git-push-disclosure"
                          type="button"
                          aria-expanded={expanded.has(key)}
                          aria-label={`${expanded.has(key) ? (props.zh ? '收起' : 'Collapse') : props.zh ? '展开' : 'Expand'} ${owner.name}`}
                          disabled={!available || locked}
                          onClick={() =>
                            setExpanded((current) => {
                              /** 只切换本行展开状态。 */
                              const next = new Set(current);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        >
                          {expanded.has(key) ? <CaretDownIcon /> : <CaretRightIcon />}
                        </button>
                        <input
                          type="checkbox"
                          aria-label={`${props.zh ? '推送' : 'Push'} ${owner.name} ${entry.sourceBranch}`}
                          checked={entry.checked}
                          disabled={locked || !available}
                          onChange={(event) => toggleEntry(entry, event.currentTarget.checked)}
                        />
                        <button type="button" className="git-push-branch" onClick={() => inspect(entry)} disabled={locked} title={`${owner.name} · ${entry.sourceBranch}`}>
                          <i style={{ background: repositoryColor(owner.id) }} aria-hidden="true" />
                          <strong>{owner.name}</strong>
                          <span>{entry.sourceBranch || (props.zh ? '未检出分支' : 'No checked-out branch')}</span>
                        </button>
                        <ArrowRightIcon className="git-push-arrow" aria-hidden="true" />
                        <button
                          type="button"
                          className="git-push-target"
                          disabled={locked}
                          onClick={() => {
                            inspect(entry);
                            setEditingTargets(true);
                          }}
                          title={`${entry.remote} : ${entry.targetBranch}`}
                        >
                          {entry.remote ? `${entry.remote} : ${entry.targetBranch}` : props.zh ? '未配置远端' : 'No remote'}
                        </button>
                        {state?.data ? <small className="git-push-count">{state.data.total}</small> : null}
                      </div>
                      {expanded.has(key) && available ? (
                        <div className="git-push-commits">
                          {state?.error ? <VisibleApplicationError error={state.error} language={props.zh ? 'zh-CN' : 'en'} /> : null}
                          {!state?.data && !state?.error ? <p role="status">{props.zh ? '正在读取待推送提交…' : 'Loading outgoing commits…'}</p> : null}
                          {state?.data?.commits.map((commit) => (
                            <button
                              key={commit.hash}
                              type="button"
                              className="git-push-commit"
                              data-active={activeKey === key && commitHash === commit.hash}
                              disabled={locked}
                              title={`${commit.subject}\n${commit.shortHash} · ${commit.author}`}
                              onClick={() => inspect(entry, commit.hash)}
                            >
                              <span>{commit.subject}</span>
                              <small>{commit.shortHash}</small>
                            </button>
                          ))}
                          {state?.data?.total === 0 ? <p>{props.zh ? '没有待推送提交' : 'No outgoing commits'}</p> : null}
                          {state?.data?.hasMore ? (
                            <button className="git-push-link" type="button" disabled={locked || state.loading} onClick={() => void loadMore(entry)}>
                              {state.loading ? (props.zh ? '正在读取…' : 'Loading…') : props.zh ? '加载更多提交' : 'Load more commits'}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
              <div className="git-push-repository-footer">
                <button
                  type="button"
                  className="git-push-link"
                  disabled={locked}
                  onClick={() => {
                    requests.current.clear();
                    setCommitHash('');
                    setSelectedFilePath('');
                    setRefresh((value) => value + 1);
                  }}
                >
                  {props.zh ? '刷新预览' : 'Refresh preview'}
                </button>
                <button type="button" className="git-push-link" disabled={locked} onClick={() => setEditingTargets(true)}>
                  {props.zh ? '编辑所有目标' : 'Edit all targets'}
                </button>
              </div>
            </section>
            <GitPaneSeparator name="push-sidebar" label={props.zh ? '调整仓库与文件面板宽度' : 'Resize repository and file panels'} initial={54} min={30} max={72} />
            <section className="git-push-files" aria-label={props.zh ? '推送文件' : 'Push files'} aria-busy={!diff && !previewError && !!active.sourceBranch && !!active.remote}>
              <header>
                <strong>{repository?.name ?? active.repositoryId}</strong>
                <small>
                  {commitHash ? commitHash.slice(0, 8) : props.zh ? '全部待推送提交' : 'All outgoing commits'}
                  {diff ? ` · ${files.length} ${props.zh ? '个文件' : 'files'}` : ''}
                </small>
              </header>
              <div className="git-push-file-content">
                {previewError ? (
                  <VisibleApplicationError error={previewError} language={props.zh ? 'zh-CN' : 'en'} />
                ) : !active.remote || !active.sourceBranch ? (
                  <p className="git-push-empty">{props.zh ? '请选择已配置远端的本地分支。' : 'Choose a local branch with a configured remote.'}</p>
                ) : !diff ? (
                  <p className="git-push-empty" role="status">
                    {props.zh ? '正在读取文件变化…' : 'Loading file changes…'}
                  </p>
                ) : files.length ? (
                  <PushFileTree files={files} prefix="" zh={props.zh} selectedPath={selectedFilePath} onSelect={setSelectedFilePath} onOpen={(path) => void openFileDiff(path)} />
                ) : (
                  <p className="git-push-empty">{props.zh ? '此范围没有文件净变化。' : 'No net file changes in this range.'}</p>
                )}
              </div>
              <p className="git-push-preview-note">
                {preview?.data?.targetHeadSha === null
                  ? props.zh
                    ? '本地没有此远程分支记录；当前显示来源分支全部历史与文件。'
                    : 'No local record of this remote branch. Showing the source branch history and files.'
                  : props.zh
                    ? '预览基于本地远程跟踪记录，未提交修改不在推送范围内。'
                    : 'Preview uses local remote-tracking refs. Uncommitted changes are excluded.'}
                {preview?.data?.behind ? (props.zh ? ` 目标另有 ${preview.data.behind} 条提交，普通推送可能被拒绝。` : ` The target has ${preview.data.behind} other commits; a normal push may be rejected.`) : ''}
              </p>
            </section>
          </main>
        )}
        {duplicateTarget && !resultMode ? (
          <p className="git-push-alert" role="alert">
            {props.zh ? '多个本地分支不能推送到同一远程目标，请编辑目标。' : 'Multiple local branches cannot share a remote target. Edit the targets.'}
          </p>
        ) : null}
        {operationError ? (
          <div className="git-push-alert">
            <VisibleApplicationError error={operationError} language={props.zh ? 'zh-CN' : 'en'} />
          </div>
        ) : null}
        <footer className="git-push-footer">
          {!resultMode ? (
            <>
              <label>
                <input type="checkbox" checked={pushTags} disabled={locked} onChange={(event) => setPushTags(event.currentTarget.checked)} />
                {props.zh ? '推送所有标签' : 'Push all tags'}
              </label>
              <small>
                {props.zh ? `已选 ${new Set(selected.map((entry) => entry.repositoryId)).size} 个仓库 · ${selected.length} 个分支` : `${new Set(selected.map((entry) => entry.repositoryId)).size} repositories · ${selected.length} branches`}
              </small>
            </>
          ) : null}
          <span className="git-push-footer-actions">
            <Button disabled={locked} onClick={props.onClose}>
              {resultMode ? (props.zh ? '关闭' : 'Close') : props.zh ? '取消' : 'Cancel'}
            </Button>
            {!resultMode ? (
              <span className="git-push-split-button">
                <Button variant="primary" busy={submitting} disabled={pushDisabled} onClick={() => void submit(false)}>
                  {props.zh ? '推送' : 'Push'}
                </Button>
                <details
                  className="git-push-more"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && event.currentTarget.open) {
                      event.preventDefault();
                      event.stopPropagation();
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector('summary')?.focus();
                    }
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
                  }}
                >
                  <summary
                    aria-label={props.zh ? '更多推送选项' : 'More push options'}
                    aria-disabled={locked}
                    onClick={(event) => {
                      if (locked) event.preventDefault();
                    }}
                  >
                    <CaretDownIcon aria-hidden="true" />
                  </summary>
                  <div>
                    <Button
                      className="git-push-force-action"
                      disabled={pushDisabled}
                      onClick={(event) => {
                        event.currentTarget.closest('details')?.querySelector('summary')?.focus();
                        event.currentTarget.closest('details')?.removeAttribute('open');
                        void submit(true);
                      }}
                    >
                      {props.zh ? '强制推送' : 'Force push'}
                    </Button>
                    <small>{props.zh ? '仅当远端仍与本地记录一致时覆盖目标。' : 'Replace the target only if it still matches the local tracking ref.'}</small>
                  </div>
                </details>
              </span>
            ) : null}
          </span>
        </footer>
      </section>
      {editingTargets ? (
        <PushTargetsEditor
          entries={entries}
          repositories={props.repositories}
          zh={props.zh}
          onClose={() => setEditingTargets(false)}
          onChange={(next) => {
            setEntries(next);
            setCommitHash('');
            setSelectedFilePath('');
          }}
          onAdd={(entry) => {
            setEntries((current) => [...current.filter((item) => item.repositoryId !== entry.repositoryId || item.sourceBranch), entry]);
            setExpanded((current) => new Set([...current, entryKey(entry)]));
            inspect(entry);
          }}
        />
      ) : null}
    </ModalPortal>
  );
}

/** 文件树复用目录压缩与文件图标；原生 details 提供键盘展开和收起。 */
function PushFileTree(props: { files: Array<{ path: string; file: GitFileDiff }>; prefix: string; zh: boolean; selectedPath: string; onSelect: (path: string) => void; onOpen: (path: string) => void }) {
  return (
    <ul className="git-push-file-tree">
      {groupDirectoryFiles(props.files, props.prefix).map(([name, children]) =>
        name.endsWith('/') ? (
          <li key={name}>
            <details open>
              <summary>
                <FolderIcon aria-hidden="true" />
                <span>{name.slice(0, -1)}</span>
                <small>{children.length}</small>
              </summary>
              <PushFileTree {...props} files={children} prefix={props.prefix + name} />
            </details>
          </li>
        ) : (
          <li key={name}>
            <button
              type="button"
              data-active={props.selectedPath === children[0]!.path}
              aria-pressed={props.selectedPath === children[0]!.path}
              data-icon-tooltip={`${children[0]!.path} · ${fileStatusLabel(children[0]!.file.changeType, props.zh)}`}
              aria-label={`${children[0]!.path} · ${fileStatusLabel(children[0]!.file.changeType, props.zh)}`}
              onClick={() => props.onSelect(children[0]!.path)}
              onDoubleClick={() => props.onOpen(children[0]!.path)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  props.onOpen(children[0]!.path);
                }
              }}
            >
              <FileTypeIcon name={name} />
              <span data-file-status={children[0]!.file.changeType}>{name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

/** 编辑所有分支目标，不将仅用于查看的文件转换成推送选择。 */
function PushTargetsEditor(props: { entries: PushEntry[]; repositories: ProjectGitRepositoryWorkbenchItem[]; zh: boolean; onChange: (entries: PushEntry[]) => void; onAdd: (entry: PushEntry) => void; onClose: () => void }) {
  /** 每个目标输入使用独立建议列表，避免跨仓串用分支。 */
  const id = useId();
  /** 更新单行配置，其勾选状态保持不变。 */
  function update(index: number, values: Partial<PushEntry>): void {
    props.onChange(props.entries.map((entry, current) => (current === index ? { ...entry, ...values } : entry)));
  }
  /** 保留原有当前仓库全选能力，已编辑目标不被默认值覆盖。 */
  function selectRepositoryBranches(repository: ProjectGitRepositoryWorkbenchItem, checked: boolean): void {
    if (!checked) {
      props.onChange(props.entries.map((entry) => (entry.repositoryId === repository.id ? { ...entry, checked: false } : entry)));
      return;
    }
    /** 为尚未列出的分支建立默认目标，已有分支继续使用用户配置。 */
    const branches = repository.snapshot.localBranches.map((branch) => ({ ...(props.entries.find((entry) => entry.repositoryId === repository.id && entry.sourceBranch === branch) ?? createEntry(repository, branch, true)), checked: true }));
    props.onChange([...props.entries.filter((entry) => entry.repositoryId !== repository.id), ...branches]);
  }
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} role="dialog" aria-label={props.zh ? '编辑推送目标' : 'Edit push targets'}>
      <section className="git-push-targets-editor" data-modal-surface="dialog">
        <header>
          <strong>{props.zh ? '编辑所有目标' : 'Edit all targets'}</strong>
          <Button size="compact" onClick={props.onClose}>
            {props.zh ? '完成' : 'Done'}
          </Button>
        </header>
        <main>
          {props.repositories.map((repository) => (
            <section key={repository.id}>
              <h3>{repository.name}</h3>
              <label className="git-push-track">
                <input
                  type="checkbox"
                  disabled={!repository.snapshot.remotes.length || !repository.snapshot.localBranches.length}
                  checked={
                    repository.snapshot.localBranches.length > 0 && repository.snapshot.localBranches.every((branch) => props.entries.some((entry) => entry.repositoryId === repository.id && entry.sourceBranch === branch && entry.checked))
                  }
                  onChange={(event) => selectRepositoryBranches(repository, event.currentTarget.checked)}
                />
                {props.zh ? '全选当前仓库分支' : 'Select all branches in this repository'}
              </label>
              {props.entries.map((entry, index) =>
                entry.repositoryId !== repository.id || !entry.sourceBranch ? null : (
                  <fieldset key={entryKey(entry)}>
                    <legend>{entry.sourceBranch}</legend>
                    <label>
                      <span>{props.zh ? '远端' : 'Remote'}</span>
                      <ZeusSelect
                        size="compact"
                        ariaLabel={`${repository.name} ${entry.sourceBranch} ${props.zh ? '远端' : 'remote'}`}
                        value={entry.remote}
                        options={repository.snapshot.remotes.map((remote) => ({ value: remote, label: remote }))}
                        disabled={!repository.snapshot.remotes.length}
                        searchable={false}
                        onChange={(remote) => update(index, { remote })}
                      />
                    </label>
                    <label>
                      <span>{props.zh ? '目标分支' : 'Target branch'}</span>
                      <input value={entry.targetBranch} list={`${id}-${index}`} onChange={(event) => update(index, { targetBranch: event.currentTarget.value })} />
                    </label>
                    <datalist id={`${id}-${index}`}>
                      {repository.snapshot.remoteBranches
                        .filter((branch) => branch.startsWith(`${entry.remote}/`) && !branch.endsWith('/HEAD'))
                        .map((branch) => (
                          <option key={branch} value={branch.slice(entry.remote.length + 1)} />
                        ))}
                    </datalist>
                    <label className="git-push-track">
                      <input type="checkbox" checked={entry.setUpstream} onChange={(event) => update(index, { setUpstream: event.currentTarget.checked })} />
                      {props.zh ? '设置上游跟踪' : 'Set upstream tracking'}
                    </label>
                    <small>{repository.snapshot.remoteDetails?.find((remote) => remote.name === entry.remote)?.pushUrl}</small>
                  </fieldset>
                ),
              )}
              <ZeusSelect
                size="compact"
                ariaLabel={`${repository.name} ${props.zh ? '添加分支' : 'add branch'}`}
                value=""
                triggerLabel={props.zh ? '添加其他本地分支…' : 'Add another local branch…'}
                options={repository.snapshot.localBranches.filter((branch) => !props.entries.some((entry) => entry.repositoryId === repository.id && entry.sourceBranch === branch)).map((branch) => ({ value: branch, label: branch }))}
                disabled={!repository.snapshot.remotes.length}
                emptyLabel={props.zh ? '所有本地分支均已列出' : 'All local branches are listed'}
                onChange={(branch) => props.onAdd(createEntry(repository, branch, true))}
              />
              {!repository.snapshot.remotes.length ? <p>{props.zh ? '此仓库尚未配置远端。' : 'This repository has no configured remote.'}</p> : null}
            </section>
          ))}
        </main>
      </section>
    </ModalPortal>
  );
}
