import { usePresenceOpen } from '../ui/MotionPresence.js';
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import { buildTaskCommitMessageSuggestion, type TaskWorkspaceConflictRecovery } from '@zeus/shared';
import { type DashboardClient, type TaskRecord, ZeusApiError } from '../apiClient.js';
import type {
  TaskBranchFileChange,
  TaskGitDiffSummary,
  TaskGitFileDiff,
  TaskGitFileStatus,
  TaskIntegrationConflictFile,
  TaskIntegrationConflictPermissionMode,
  TaskIntegrationRecord,
  TaskIntegrationResult,
  TaskWorkspaceIndexCollection,
  TaskWorkspaceIndexSnapshot,
  TaskWorkspaceSnapshot,
} from '../session/sessionTypes.js';
import {
  GitDeliveryWorkspace,
  GitDeliveryActions,
  DeliveryRepositoryFileTree,
  DeliveryFeedbackNotice,
  InitialLoadState,
  repositoryLabel,
  type DiffScope,
  type BusyAction,
  type DeliveryFile,
  type DeliveryFeedback,
  type BatchDeliveryResult,
  type BatchDeliveryStatus,
  type DeliveryRepositoryGroup,
} from '../git/GitDeliveryWorkspace.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { TaskGitConflictWorkspace } from './TaskGitConflictWorkspace.js';
import { loadGitCommitModelOptions } from '../git/gitCommitModels.js';
import { type ConflictDocument, countUnresolvedConflictBlocks, createConflictDocument, serializeConflictForGit } from './taskConflictModel.js';

type DeliveryClient = Pick<
  DashboardClient,
  | 'loadTaskGitWorkspaceIndex'
  | 'loadTaskGitWorkspaceSnapshot'
  | 'loadTaskWorkspaceFileDiff'
  | 'commitTaskWorkspace'
  | 'pushTaskIntegration'
  | 'loadTaskIntegrations'
  | 'startTaskIntegration'
  | 'loadTaskIntegrationConflict'
  | 'startTaskIntegrationConflictAi'
  | 'resolveTaskIntegrationConflict'
  | 'finalizeTaskIntegration'
  | 'loadSkills'
  | 'sendNativeMessage'
  | 'loadGitCommitModels'
  | 'generateGitCommitMessage'
>;

export interface PendingConflictAiStart {
  idempotencyKey: string;
  taskId: string;
  projectId: string;
  integrationId: string;
  path: string;
  content: string;
  fingerprint: string;
  permissionMode: TaskIntegrationConflictPermissionMode;
  skillId?: string;
}

const pendingConflictAiStartPrefix = 'zeus.conflict-ai-start:';

export function persistPendingConflictAiStart(input: PendingConflictAiStart): () => void {
  if (typeof window === 'undefined') throw new Error('冲突处理准备状态需要本机持久存储。');
  const key = `${pendingConflictAiStartPrefix}${encodeURIComponent(input.idempotencyKey)}`;
  window.localStorage.setItem(key, JSON.stringify(input));
  return () => window.localStorage.removeItem(key);
}

export function listPendingConflictAiStarts(): PendingConflictAiStart[] {
  if (typeof window === 'undefined') return [];
  const pending: PendingConflictAiStart[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(pendingConflictAiStartPrefix)) continue;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? '') as Partial<PendingConflictAiStart>;
      if (
        typeof parsed.idempotencyKey === 'string' &&
        typeof parsed.taskId === 'string' &&
        typeof parsed.projectId === 'string' &&
        typeof parsed.integrationId === 'string' &&
        typeof parsed.path === 'string' &&
        typeof parsed.content === 'string' &&
        typeof parsed.fingerprint === 'string' &&
        (parsed.skillId === undefined || (typeof parsed.skillId === 'string' && /^[a-f0-9]{32}$/u.test(parsed.skillId))) &&
        (parsed.permissionMode === 'auto' || parsed.permissionMode === 'full-access')
      ) {
        pending.push(parsed as PendingConflictAiStart);
      }
    } catch {
      // 无法读取的旧信封不参与自动派发，也不影响其他待启动操作。
    }
  }
  return pending;
}

export function clearPendingConflictAiStart(idempotencyKey: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(`${pendingConflictAiStartPrefix}${encodeURIComponent(idempotencyKey)}`);
}

interface ConflictDraft {
  fingerprint: string;
  document: ConflictDocument;
}

interface TaskGitMergeModalProps {
  open: boolean;
  language: 'zh-CN' | 'en-US';
  task: TaskRecord | null;
  projectName?: string;
  currentConversationWorkspaceId?: string | null;
  refreshRevision?: number;
  client: DeliveryClient | null;
  executionReady?: boolean;
  onChanged?: () => void | Promise<void>;
  onQueueConflictAiStart?: (input: PendingConflictAiStart) => () => void;
  onOpenConversation: (taskId: string, conversationId: string) => void | Promise<void>;
  onClose: () => void;
}

type TaskGitMergeModalContentProps = Omit<TaskGitMergeModalProps, 'task'> & { task: TaskRecord };

/** 代码交付统一入口；关闭或切换任务时重建本次交付选择。 */
export function TaskGitMergeModal(props: TaskGitMergeModalProps) {
  if (!props.open || !props.task) return null;
  // 任务身份隔离弹窗状态；关闭时立即取消旧读取，退出结束后卸载，切换任务不复用旧工作区。
  return <TaskGitMergeModalContent key={props.task.id} {...props} task={props.task} />;
}

/** 组织多仓库审查、目标分支选择及逐仓交付结果。 */
function TaskGitMergeModalContent(props: TaskGitMergeModalContentProps) {
  /** 退出立即取消旧读取，快速重开时重新加载当前任务。 */
  const interactionOpen = usePresenceOpen() && props.open;
  const zh = props.language === 'zh-CN';
  const standaloneWindow = typeof document !== 'undefined' && document.body.dataset.surface === 'task-git-delivery';
  const initialConversationWorkspaceIdRef = useRef(props.currentConversationWorkspaceId);
  /** 异步详情读取与窗口复用始终使用最新会话上下文。 */
  useEffect(() => {
    initialConversationWorkspaceIdRef.current = props.currentConversationWorkspaceId;
  }, [props.currentConversationWorkspaceId]);
  const [workspaceIndex, setWorkspaceIndex] = useState<TaskWorkspaceIndexCollection | null>(null);
  const [workspaceDetails, setWorkspaceDetails] = useState<Record<string, TaskWorkspaceSnapshot>>({});
  const [detailStates, setDetailStates] = useState<Record<string, 'loading' | 'error'>>({});
  const [integrations, setIntegrations] = useState<TaskIntegrationRecord[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [diffScope, setDiffScope] = useState<DiffScope>('working');
  const [selectedFile, setSelectedFile] = useState('');
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([]);
  const [selectedPathsByWorkspace, setSelectedPathsByWorkspace] = useState<Record<string, string[]>>({});
  /** 一次选择作用于所有勾选仓库；空值表示各自检出来源，刷新时保留本次选择。 */
  const [selectedTargetBranch, setSelectedTargetBranch] = useState('');
  const [fileDiff, setFileDiff] = useState<TaskGitDiffSummary | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [message, setMessage] = useState('');
  /** 流式结果只作预览，生成失败、停止或手动编辑时保留已有提交说明。 */
  const [generatedMessage, setGeneratedMessage] = useState<string | null>(null);
  /** 提交信息生成结果与提交、合入、推送的反馈分别显示。 */
  const [commitGenerationFeedback, setCommitGenerationFeedback] = useState('');
  /** 请求控制器同时防重复点击，并在关闭或选择变化时取消旧生成。 */
  const commitGenerationController = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<'merge' | 'squash'>('merge');
  const [integration, setIntegration] = useState<TaskIntegrationRecord | null>(null);
  const [conflictWorkspaceOpen, setConflictWorkspaceOpen] = useState(false);
  const [conflictPath, setConflictPath] = useState('');
  const [conflict, setConflict] = useState<TaskIntegrationConflictFile | null>(null);
  const [conflictDocument, setConflictDocument] = useState<ConflictDocument | null>(null);
  const conflictDraftsRef = useRef<Record<string, ConflictDraft>>({});
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  /** React 状态刷新前也阻止重复点击；跨窗口重复请求仍由既有消息身份保护。 */
  const continuingConflictRef = useRef(false);
  const [feedback, setFeedback] = useState<DeliveryFeedback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectionInitializedRef = useRef(false);
  /** 已应用到展示与默认焦点的会话工作区，避免详情刷新覆盖用户在同一分支内的选择。 */
  const appliedConversationWorkspaceIdRef = useRef<string | null | undefined>(undefined);

  const selectedWorkspace = workspaceDetails[workspaceId] ?? null;
  const workspaceError = selectedWorkspace?.comparisonError ?? selectedWorkspace?.reviewError ?? null;
  /** 当前差异标题保留仓库与完整路径，合并工具栏后仍能识别文件来源。 */
  const selectedDiffTitle = selectedWorkspace ? `${repositoryLabel(selectedWorkspace, zh)} / ${selectedFile}` : zh ? '差异对比' : 'Diff';
  /** 会话入口只投影当前工作区所在分支；任务入口仍展示全部分支。 */
  const visibleWorkspaceItems = useMemo(() => deliveryWorkspacesForConversationBranch(workspaceIndex?.items ?? [], props.currentConversationWorkspaceId), [workspaceIndex?.items, props.currentConversationWorkspaceId]);
  /** 显式目标统一应用到全部仓库，不存在时也不回退为来源或其他待办目标。 */
  const targetBranchesByWorkspace = useMemo(() => Object.fromEntries((workspaceIndex?.items ?? []).map((workspace) => [workspace.id, selectedTargetBranch || workspace.sourceBranch])), [workspaceIndex?.items, selectedTargetBranch]);
  /** 汇总勾选仓库已有的本地分支；增减仓库时保留已选目标，缺失情况单独提示。 */
  const targetBranchOptions = useMemo(() => {
    /** 来源名称相同时直接显示分支名，不同时说明按各仓库来源交付。 */
    const sources = [...new Set(selectedWorkspaceIds.flatMap((id) => (workspaceDetails[id]?.sourceBranch ? [workspaceDetails[id].sourceBranch] : [])))];
    /** 候选取所有勾选仓库的分支合集，允许选中部分仓库才有的目标。 */
    const branches = [...new Set([selectedTargetBranch, ...selectedWorkspaceIds.flatMap((id) => workspaceDetails[id]?.targetBranches.filter((branch) => branch !== workspaceDetails[id].branchName) ?? [])])].filter(Boolean).sort();
    return [
      { value: '', label: sources.length === 1 ? `${sources[0]} · ${zh ? '检出来源（默认）' : 'checkout source (default)'}` : zh ? '各仓库检出来源分支（默认）' : 'Each repository’s checkout source (default)' },
      ...branches.map((branch) => ({ value: branch, label: branch })),
    ];
  }, [selectedWorkspaceIds, workspaceDetails, selectedTargetBranch, zh]);
  /** 提前列出不能使用统一目标的仓库，并在实际批量操作中复用同一跳过原因。 */
  const targetIssues = useMemo<BatchDeliveryResult[]>(
    () =>
      selectedWorkspaceIds.flatMap((selectedId) => {
        /** 详情未读取时沿用既有加载和逐仓跳过提示。 */
        const workspace = workspaceDetails[selectedId];
        if (!workspace) return [];
        /** 校验显式目标，禁止续办另一个目标的旧合入。 */
        const targetBranch = targetBranchesByWorkspace[selectedId];
        /** 未完成合入继续保留其真实目标，与当前统一选择分别展示。 */
        const recovery = findRecoverableIntegration(integrations, selectedId);
        /** 用户可见原因也作为批量结果，避免按钮计数和执行反馈采用不同口径。 */
        const message =
          targetBranch === workspace.branchName
            ? zh
              ? `任务分支不能合入自身：${targetBranch}。`
              : `The task branch cannot merge into itself: ${targetBranch}.`
            : !workspace.targetBranches.includes(targetBranch)
              ? zh
                ? `本地没有目标分支 ${targetBranch}。`
                : `Local target branch ${targetBranch} is missing.`
              : recovery && recovery.targetBranch !== targetBranch
                ? zh
                  ? `上次合入 ${recovery.targetBranch} 尚未完成，请先处理原合入。`
                  : `The previous merge into ${recovery.targetBranch} is unfinished. Resolve it first.`
                : '';
        return message ? [{ workspaceId: selectedId, repositoryName: repositoryLabel(workspace, zh), status: 'skipped' as const, message }] : [];
      }),
    [selectedWorkspaceIds, workspaceDetails, targetBranchesByWorkspace, integrations, zh],
  );
  const workingFiles = useMemo(() => collectWorkingFiles(selectedWorkspace), [selectedWorkspace]);
  const committedFiles = useMemo(() => (selectedWorkspace?.branchComparison?.files ?? []).map((file) => toCommittedDeliveryFile(file, zh)), [selectedWorkspace?.branchComparison?.files, zh]);
  const repositoryGroups = useMemo<DeliveryRepositoryGroup[]>(
    () =>
      visibleWorkspaceItems.map((workspace) => {
        const detail = workspaceDetails[workspace.id];
        return {
          workspace,
          detail,
          statusLabel: workspaceStateLabel(workspace, detail, detailStates[workspace.id], zh, integrations, targetBranchesByWorkspace[workspace.id]),
          files: diffScope === 'committed' ? (detail?.branchComparison?.files ?? []).map((file) => toCommittedDeliveryFile(file, zh)) : collectWorkingFiles(detail).map((file) => toWorkingDeliveryFile(file, zh)),
        };
      }),
    [visibleWorkspaceItems, workspaceDetails, diffScope, zh, detailStates, integrations, targetBranchesByWorkspace],
  );
  const totalWorkingFiles = useMemo(() => visibleWorkspaceItems.reduce((total, workspace) => total + collectWorkingFiles(workspaceDetails[workspace.id]).length, 0), [visibleWorkspaceItems, workspaceDetails]);
  const totalCommittedFiles = useMemo(() => visibleWorkspaceItems.reduce((total, workspace) => total + (workspaceDetails[workspace.id]?.branchComparison?.files.length ?? 0), 0), [visibleWorkspaceItems, workspaceDetails]);
  const selectedWorkspaceIdSet = useMemo(() => new Set(selectedWorkspaceIds), [selectedWorkspaceIds]);
  const selectedCommitFileCount = useMemo(() => selectedWorkspaceIds.reduce((total, selectedId) => total + (selectedPathsByWorkspace[selectedId]?.length ?? 0), 0), [selectedWorkspaceIds, selectedPathsByWorkspace]);
  /** 多仓提交仅排除仍有冲突的仓库，其余仓库照常交付。 */
  const committableFileCount = selectedWorkspaceIds.reduce((total, selectedId) => total + (workspaceDetails[selectedId]?.review?.conflictFiles.length ? 0 : (selectedPathsByWorkspace[selectedId]?.length ?? 0)), 0);
  /** 仅向模型发送本次真正可提交的勾选文件，冲突仓库沿用提交入口的排除规则。 */
  const commitGenerationSelection = selectedWorkspaceIds.flatMap((selectedId) => {
    /** 已读取详情的仓库才有可验证的任务身份与文件范围。 */
    const workspace = workspaceDetails[selectedId];
    /** 复制选择快照，生成过程中不引用可变的交付范围。 */
    const paths = selectedPathsByWorkspace[selectedId] ?? [];
    return workspace && paths.length && !workspace.review?.conflictFiles.length ? [{ repositoryId: workspace.id, relativePath: '.', paths: [...paths] }] : [];
  });
  /** 分支、HEAD 与文件范围变化时取消生成，避免复用旧现场结果。 */
  const commitGenerationSelectionKey = JSON.stringify(commitGenerationSelection.map((item) => [item, workspaceDetails[item.repositoryId]?.branchName, workspaceDetails[item.repositoryId]?.review?.headSha]));
  useEffect(() => () => commitGenerationController.current?.abort(), [interactionOpen, props.task.id, props.client, props.currentConversationWorkspaceId, commitGenerationSelectionKey]);
  /** 聚焦仓库和勾选仓库均呈现续办入口，避免多仓反馈遗漏需要处理的现场。 */
  const conflictingWorkspaces = Object.values(workspaceDetails).filter((workspace) => (workspace.id === workspaceId || selectedWorkspaceIds.includes(workspace.id)) && Boolean(workspace.review?.conflictFiles.length));
  const selectedMergeCandidateCount = useMemo(
    () => selectedWorkspaceIds.filter((selectedId) => mergeWorkspaceAction(workspaceDetails[selectedId], integrations, targetBranchesByWorkspace[selectedId]) !== null).length,
    [selectedWorkspaceIds, workspaceDetails, integrations, targetBranchesByWorkspace],
  );
  const selectedPushCandidateCount = useMemo(
    () => selectedWorkspaceIds.filter((selectedId) => Boolean(workspaceDetails[selectedId]?.remoteName && findDeliveredIntegration(workspaceDetails[selectedId], integrations, targetBranchesByWorkspace[selectedId]))).length,
    [selectedWorkspaceIds, workspaceDetails, integrations, targetBranchesByWorkspace],
  );
  const activeConflict = integration?.state === 'conflicted' ? integration : null;
  const unresolvedConflict = conflictWorkspaceOpen && activeConflict && activeConflict.conflictFiles.length > 0 ? activeConflict : null;
  const conflictReadyToFinalize = Boolean(conflictWorkspaceOpen && activeConflict && activeConflict.conflictFiles.length === 0);
  /** 多仓结果并入冲突页标题栏，操作按钮与其他提示仍在原位置可见。 */
  const headerFeedback = conflictWorkspaceOpen && Boolean(feedback?.results?.length) && !feedback?.onAction;
  const pendingLocalSync = integration?.state === 'pending_local_sync' ? integration : null;
  const busy = busyAction !== null;
  const loading = busyAction === 'loading' && workspaceIndex === null;
  const dismissDisabled = busyAction !== null && busyAction !== 'loading' && busyAction !== 'commit-message';
  const unresolvedConflictBlocks = useMemo(() => countUnresolvedConflictBlocks(conflictDocument), [conflictDocument]);

  /** 关闭后快速重开也从当前任务重新读取，刷新过程仍保留已选目标。 */
  useEffect(() => {
    if (!interactionOpen) return;
    initialConversationWorkspaceIdRef.current = props.currentConversationWorkspaceId;
    setWorkspaceIndex(null);
    setWorkspaceDetails({});
    setDetailStates({});
    setSelectedWorkspaceIds([]);
    setSelectedPathsByWorkspace({});
    setSelectedTargetBranch('');
    setDiffScope('working');
    setSelectedFile('');
    setFileDiff(null);
  }, [interactionOpen]);

  useEffect(() => {
    if (!interactionOpen || !props.task || !props.client) return;
    const client = props.client;
    const taskId = props.task.id;
    let cancelled = false;
    setBusyAction('loading');
    setError(null);
    setFeedback(null);
    setConflictWorkspaceOpen(false);
    conflictDraftsRef.current = {};
    selectionInitializedRef.current = false;
    appliedConversationWorkspaceIdRef.current = undefined;
    setMessage(
      buildTaskCommitMessageSuggestion({
        taskType: props.task.taskType,
        taskCode: props.task.taskCode ?? props.task.id,
        taskTitle: props.task.title,
      }),
    );
    void Promise.all([client.loadTaskGitWorkspaceIndex(taskId), client.loadTaskIntegrations(taskId)])
      .then(([workspaceSnapshot, integrationSnapshot]) => {
        if (cancelled) return;
        setWorkspaceIndex(workspaceSnapshot);
        setWorkspaceDetails({});
        setDetailStates(Object.fromEntries(workspaceSnapshot.items.map((workspace) => [workspace.id, 'loading' as const])));
        setIntegrations(integrationSnapshot.items);
        const preferredWorkspace = workspaceSnapshot.items.find((workspace) => workspace.id === initialConversationWorkspaceIdRef.current && workspace.state !== 'discarded');
        const firstWorkspace = preferredWorkspace ?? workspaceSnapshot.items.find((workspace) => workspace.state !== 'discarded') ?? workspaceSnapshot.items[0];
        const recoverable = findRecoverableIntegration(integrationSnapshot.items, firstWorkspace?.id);
        setWorkspaceId(firstWorkspace?.id ?? '');
        setIntegration(recoverable ?? null);
        setMode(recoverable?.mode ?? 'merge');
        setConflictPath('');
        setSnapshotRevision((current) => current + 1);
        setBusyAction(null);
        void loadWorkspaceDetailCollection(client, taskId, workspaceSnapshot.items).then(({ details, states }) => {
          if (cancelled) return;
          setWorkspaceDetails(details);
          setDetailStates(states);
          initializeDeliverySelection(details, workspaceSnapshot.items, initialConversationWorkspaceIdRef.current, setSelectedWorkspaceIds, setSelectedPathsByWorkspace);
          /** 会话 workspace 没有修改时，聚焦同分支首个真正有未提交文件的仓库。 */
          setWorkspaceId(initialDeliveryReviewWorkspaceId(details, workspaceSnapshot.items, initialConversationWorkspaceIdRef.current, firstWorkspace?.id ?? ''));
          appliedConversationWorkspaceIdRef.current = initialConversationWorkspaceIdRef.current;
          selectionInitializedRef.current = true;
          setSnapshotRevision((current) => current + 1);
        });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setBusyAction(null);
        setError(errorMessage(reason, zh));
      });
    return () => {
      cancelled = true;
    };
  }, [interactionOpen, props.task?.id, props.client, zh, loadRevision]);

  /** 独立交付窗口复用后跟随新的当前会话，重新限定分支并选择首个修改文件。 */
  useEffect(() => {
    if (!interactionOpen || !workspaceIndex || Object.keys(workspaceDetails).length === 0 || appliedConversationWorkspaceIdRef.current === props.currentConversationWorkspaceId) return;
    appliedConversationWorkspaceIdRef.current = props.currentConversationWorkspaceId;
    initialConversationWorkspaceIdRef.current = props.currentConversationWorkspaceId;
    initializeDeliverySelection(workspaceDetails, workspaceIndex.items, props.currentConversationWorkspaceId, setSelectedWorkspaceIds, setSelectedPathsByWorkspace);
    setDiffScope('working');
    setWorkspaceId(initialDeliveryReviewWorkspaceId(workspaceDetails, workspaceIndex.items, props.currentConversationWorkspaceId, props.currentConversationWorkspaceId ?? ''));
  }, [interactionOpen, props.currentConversationWorkspaceId, workspaceIndex, workspaceDetails]);

  useEffect(() => {
    const nextFiles = diffScope === 'committed' ? committedFiles : workingFiles.map((file) => toWorkingDeliveryFile(file, zh));
    setSelectedFile((current) => (nextFiles.some((file) => file.path === current) ? current : (nextFiles[0]?.path ?? '')));
    setFileDiff(null);
  }, [workspaceId, diffScope, committedFiles, workingFiles, zh]);

  useEffect(() => {
    if (!interactionOpen || !props.task || !props.client || !selectedWorkspace || !selectedFile) {
      setFileDiff(null);
      // 文件在提交后消失时，取消中的旧请求不能让空白审查区永远显示加载。
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setFileDiff(null);
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
  }, [interactionOpen, props.task?.id, props.client, selectedWorkspace?.id, selectedFile, diffScope, snapshotRevision, zh]);

  useEffect(() => {
    if (!interactionOpen || !props.task || !props.client || !activeConflict || !conflictPath) {
      setConflict(null);
      setConflictDocument(null);
      return;
    }
    let cancelled = false;
    setBusyAction('conflict');
    void props.client
      .loadTaskIntegrationConflict(props.task.id, activeConflict.id, conflictPath)
      .then((next) => {
        if (cancelled) return;
        setConflict(next);
        const savedDraft = conflictDraftsRef.current[next.path];
        if (savedDraft?.fingerprint === next.fingerprint) {
          setConflictDocument(savedDraft.document);
          setFeedback({
            tone: 'warning',
            text: zh ? '目标分支更新后已按最新提交重建；相同冲突的草稿已回填，请重新确认并保存。' : 'The target advanced and the candidate was rebuilt. A matching draft was restored; review and save it again.',
          });
        } else {
          setConflictDocument(createConflictDocument(next));
          if (savedDraft) {
            setFeedback({
              tone: 'warning',
              text: zh ? '目标分支更新后冲突内容已经变化，旧草稿未自动套用，请重新处理。' : 'The conflict changed after rebuilding from the target branch, so the previous draft was not applied.',
            });
          }
        }
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
  }, [interactionOpen, props.task?.id, props.client, activeConflict?.id, conflictPath, zh]);

  async function reload(preferredWorkspaceId = workspaceId): Promise<void> {
    if (!props.task || !props.client) return;
    setDiffScope('working');
    const [workspaceSnapshot, integrationSnapshot] = await Promise.all([props.client.loadTaskGitWorkspaceIndex(props.task.id), props.client.loadTaskIntegrations(props.task.id)]);
    setDetailStates(Object.fromEntries(workspaceSnapshot.items.map((workspace) => [workspace.id, 'loading' as const])));
    const { details, states } = await loadWorkspaceDetailCollection(props.client, props.task.id, workspaceSnapshot.items);
    setWorkspaceIndex(workspaceSnapshot);
    setWorkspaceDetails(details);
    setDetailStates(states);
    setIntegrations(integrationSnapshot.items);
    preserveDeliverySelection(details, workspaceSnapshot.items, initialConversationWorkspaceIdRef.current, selectionInitializedRef.current, setSelectedWorkspaceIds, setSelectedPathsByWorkspace);
    selectionInitializedRef.current = true;
    const recoverable = integrationSnapshot.items.find((candidate) => candidate.workspaceId === preferredWorkspaceId && (candidate.state === 'conflicted' || candidate.state === 'pending_local_sync'));
    setIntegration(recoverable ?? null);
    setSnapshotRevision((current) => current + 1);
    /** 同分支内刷新保留用户审阅焦点，失效时才选择首个修改仓库。 */
    const visibleWorkspaces = deliveryWorkspacesForConversationBranch(workspaceSnapshot.items, initialConversationWorkspaceIdRef.current);
    setWorkspaceId(visibleWorkspaces.find((workspace) => workspace.id === preferredWorkspaceId)?.id ?? initialDeliveryReviewWorkspaceId(details, workspaceSnapshot.items, initialConversationWorkspaceIdRef.current, preferredWorkspaceId));
  }

  useEffect(() => {
    if (!props.refreshRevision || !props.task || !props.client) return;
    void reload(workspaceId).catch((reason: unknown) => setError(errorMessage(reason, zh)));
  }, [props.refreshRevision]);

  /** 复用提交模型偏好与生成服务，结果确认成功后才替换原提交说明。 */
  async function generateCommitMessage(): Promise<void> {
    if (!interactionOpen || !props.client || busy || !commitGenerationSelection.length || commitGenerationController.current) return;
    /** 每次生成拥有独立取消身份，不能让旧请求覆盖新的编辑。 */
    const controller = new AbortController();
    commitGenerationController.current = controller;
    setBusyAction('commit-message');
    setGeneratedMessage(null);
    setCommitGenerationFeedback(zh ? '正在生成…' : 'Generating…');
    setError(null);
    try {
      /** 与源码提交入口共用最近选用的模型，不额外增加模型设置。 */
      const models = await loadGitCommitModelOptions(props.client, props.task.projectId, controller.signal);
      controller.signal.throwIfAborted();
      if (!models.modelRef) throw new Error(models.warning || (zh ? '暂无可用模型，请在设置中配置模型连接后重试。' : 'No models available. Configure a model connection in Settings, then retry.'));
      /** 请求包含明确任务身份；服务端根据记录定位每个 Worktree。 */
      const result = await props.client.generateGitCommitMessage(
        props.task.projectId,
        { repositoryId: commitGenerationSelection[0]!.repositoryId, taskId: props.task.id, selection: commitGenerationSelection, language: zh ? 'zh-CN' : 'en', modelRef: models.modelRef },
        (text) => {
          if (!controller.signal.aborted) setGeneratedMessage(text);
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setMessage(result.message);
      setCommitGenerationFeedback(result.truncated ? (zh ? '已生成；部分改动省略，请核对。' : 'Generated; some changes omitted. Please review.') : zh ? '已生成，请检查。' : 'Generated. Please review.');
    } catch (reason) {
      setCommitGenerationFeedback(controller.signal.aborted ? (zh ? '已停止生成' : 'Generation stopped') : errorMessage(reason, zh));
    } finally {
      if (commitGenerationController.current === controller) {
        commitGenerationController.current = null;
        setBusyAction((current) => (current === 'commit-message' ? null : current));
        setGeneratedMessage(null);
      }
    }
  }

  /** 仅提交各仓库勾选文件，先呈现结果再刷新审查数据。 */
  async function commitSelected(): Promise<void> {
    if (!interactionOpen || !props.task || !props.client || selectedCommitFileCount === 0) return;
    const client = props.client;
    const taskId = props.task.id;
    setBusyAction('commit');
    setError(null);
    setFeedback(null);
    try {
      const targets = selectedWorkspaceIds
        .map((selectedId) => ({ workspace: workspaceDetails[selectedId], selectedPaths: selectedPathsByWorkspace[selectedId] ?? [] }))
        .filter((target): target is { workspace: TaskWorkspaceSnapshot; selectedPaths: string[] } => Boolean(target.workspace && target.selectedPaths.length > 0));
      const results = await Promise.all(
        targets.map(async ({ workspace, selectedPaths }): Promise<BatchDeliveryResult> => {
          if (workspace.review?.conflictFiles.length) {
            return {
              workspaceId: workspace.id,
              repositoryName: repositoryLabel(workspace, zh),
              status: 'attention',
              message: zh ? '仍有冲突，已跳过提交；请先继续处理。' : 'Conflicts remain. Commit skipped; continue resolving them first.',
            };
          }
          try {
            const response = await client.commitTaskWorkspace(taskId, workspace.id, { message, selectedPaths });
            const formattedCount = response.result.formattedPaths.length;
            return {
              workspaceId: workspace.id,
              repositoryName: repositoryLabel(workspace, zh),
              status: 'succeeded',
              message: zh
                ? `已提交 ${selectedPaths.length} 个文件 · ${shortSha(response.result.headSha)}${formattedCount > 0 ? ` · 格式化 ${formattedCount} 个` : ''}`
                : `Committed ${selectedPaths.length} file(s) · ${shortSha(response.result.headSha)}`,
            };
          } catch (reason) {
            return {
              workspaceId: workspace.id,
              repositoryName: repositoryLabel(workspace, zh),
              status: reason instanceof ZeusApiError && reason.error === 'ZEUS_TASK_WORKSPACE_CONFLICTED' ? 'attention' : 'failed',
              message: errorMessage(reason, zh),
            };
          }
        }),
      );
      setFeedback(batchDeliveryFeedback('commit', results, zh));
      await reload(workspaceId);
      await props.onChanged?.();
    } catch (reason) {
      setError(errorMessage(reason, zh));
    } finally {
      setBusyAction(null);
    }
  }

  /** 逐仓推送与当前目标和任务提交匹配的已合入记录。 */
  async function pushSelected(): Promise<void> {
    if (!interactionOpen || !props.task || !props.client || selectedWorkspaceIds.length === 0) return;
    const client = props.client;
    const taskId = props.task.id;
    setBusyAction('push');
    setError(null);
    setFeedback(null);
    try {
      const results = await Promise.all(
        selectedWorkspaceIds.map(async (selectedId): Promise<BatchDeliveryResult> => {
          const workspace = workspaceDetails[selectedId];
          if (!workspace) return { workspaceId: selectedId, repositoryName: selectedId, status: 'skipped', message: zh ? '仓库详情尚未读取。' : 'Repository details are not loaded.' };
          if (!workspace.remoteName) return { workspaceId: workspace.id, repositoryName: repositoryLabel(workspace, zh), status: 'skipped', message: zh ? '仓库未配置远端。' : 'No remote is configured.' };
          const delivered = findDeliveredIntegration(workspace, integrations, targetBranchesByWorkspace[selectedId]);
          if (!delivered) return { workspaceId: workspace.id, repositoryName: repositoryLabel(workspace, zh), status: 'skipped', message: zh ? '请先完成本地合入。' : 'Complete the local merge first.' };
          try {
            const response = await client.pushTaskIntegration(taskId, delivered.id);
            return {
              workspaceId: workspace.id,
              repositoryName: repositoryLabel(workspace, zh),
              status: 'succeeded',
              message: zh
                ? `已推送 ${response.result.remoteName}/${response.result.remoteBranch} · ${shortSha(response.result.remoteHeadSha)}`
                : `Pushed ${response.result.remoteName}/${response.result.remoteBranch} · ${shortSha(response.result.remoteHeadSha)}`,
            };
          } catch (reason) {
            return { workspaceId: workspace.id, repositoryName: repositoryLabel(workspace, zh), status: 'failed', message: errorMessage(reason, zh) };
          }
        }),
      );
      setFeedback(batchDeliveryFeedback('push', results, zh));
      await reload(workspaceId);
      await props.onChanged?.();
    } catch (reason) {
      setError(errorMessage(reason, zh));
    } finally {
      setBusyAction(null);
    }
  }

  /** 统一选择一次目标后批量合入；缺少目标的仓库明确跳过，成功结果独立保留。 */
  async function mergeSelected(): Promise<void> {
    if (!interactionOpen || !props.task || !props.client || selectedWorkspaceIds.length === 0) return;
    const client = props.client;
    const taskId = props.task.id;
    setBusyAction('merge');
    setError(null);
    setFeedback(null);
    try {
      let mergeBlockingError: string | null = null;
      const outcomes = await Promise.all(
        selectedWorkspaceIds.map(async (selectedId): Promise<{ result: BatchDeliveryResult; integration?: TaskIntegrationRecord; conflictRecovery?: TaskWorkspaceConflictRecovery | null }> => {
          const workspace = workspaceDetails[selectedId];
          if (!workspace) return { result: { workspaceId: selectedId, repositoryName: selectedId, status: 'skipped', message: zh ? '仓库详情尚未读取。' : 'Repository details are not loaded.' } };
          const label = repositoryLabel(workspace, zh);
          /** 同一次批量操作的资格判断与请求使用相同目标。 */
          const targetBranch = targetBranchesByWorkspace[selectedId];
          /** 已提示不能合入的仓库不发起请求，更不能偷偷改用来源分支。 */
          const targetIssue = targetIssues.find((issue) => issue.workspaceId === selectedId);
          if (targetIssue) return { result: targetIssue };

          const action = mergeWorkspaceAction(workspace, integrations, targetBranch);
          /** 过期候选重建时沿用用户首次确认的合入方式，普通新合入使用当前选择。 */
          const integrationMode = action?.type === 'finalize' ? action.integration.mode : mode;
          /** 建立最新候选并统一映射逐仓结果，供首次合入与过期恢复共用。 */
          const startLatestIntegration = async () => {
            try {
              const response = await client.startTaskIntegration(taskId, workspace.id, { targetBranch, mode: integrationMode });
              if ('conflictRecovery' in response) {
                return {
                  conflictRecovery: response.conflictRecovery,
                  result: { workspaceId: workspace.id, repositoryName: label, status: 'attention' as const, message: workspaceConflictMessage(response.conflictRecovery, zh) },
                };
              }
              if (response.integration.state === 'conflicted') {
                return {
                  integration: response.integration,
                  result: {
                    workspaceId: workspace.id,
                    repositoryName: label,
                    status: 'attention' as const,
                    message: zh ? `已保留 ${response.integration.conflictFiles.length} 个冲突文件，需继续处理。` : `${response.integration.conflictFiles.length} conflict file(s) need attention.`,
                  },
                };
              }
              return {
                integration: response.integration,
                result: {
                  workspaceId: workspace.id,
                  repositoryName: label,
                  status: response.integration.state === 'merged' ? ('succeeded' as const) : ('attention' as const),
                  message: response.result ? deliveryFeedback(response.result, zh).text : zh ? '已准备合入结果。' : 'Merge result prepared.',
                },
              };
            } catch (reason) {
              const message = errorMessage(reason, zh);
              if (isTargetBranchDirty(reason)) mergeBlockingError = mergeBlockingError ?? message;
              return { result: { workspaceId: workspace.id, repositoryName: label, status: 'failed' as const, message } };
            }
          };
          if (action?.type === 'resolve_conflict')
            return {
              integration: action.integration,
              result: {
                workspaceId: workspace.id,
                repositoryName: label,
                status: 'attention',
                message: zh ? `已有 ${action.integration.conflictFiles.length} 个合入冲突，已进入原处理现场。` : `${action.integration.conflictFiles.length} merge conflict(s) remain. The existing workspace was opened.`,
              },
            };
          if (action?.type === 'finalize') {
            try {
              const response = await client.finalizeTaskIntegration(taskId, action.integration.id);
              const resultFeedback = deliveryFeedback(response.result, zh);
              return {
                integration: response.integration,
                result: {
                  workspaceId: workspace.id,
                  repositoryName: label,
                  status: response.integration.state === 'merged' ? 'succeeded' : 'attention',
                  message: resultFeedback.text,
                },
              };
            } catch (reason) {
              /** 服务端已关闭过期候选；本次用户动作直接基于最新目标重建并继续。 */
              if (isTargetHeadChanged(reason)) return startLatestIntegration();
              const message = errorMessage(reason, zh);
              if (isTargetBranchDirty(reason)) mergeBlockingError = mergeBlockingError ?? message;
              return { result: { workspaceId: workspace.id, repositoryName: label, status: 'failed', message } };
            }
          }
          if (!action) {
            if (collectWorkingFiles(workspace).length > 0) return { result: { workspaceId: workspace.id, repositoryName: label, status: 'skipped', message: zh ? '仍有未提交文件。' : 'Uncommitted files remain.' } };
            if (findDeliveredIntegration(workspace, integrations, targetBranch))
              return { result: { workspaceId: workspace.id, repositoryName: label, status: 'skipped', message: zh ? '当前任务提交已经合入。' : 'The current task commit is already merged.' } };
            return { result: { workspaceId: workspace.id, repositoryName: label, status: 'skipped', message: zh ? '没有可合入的任务分支成果。' : 'No task branch result is ready to merge.' } };
          }
          return startLatestIntegration();
        }),
      );
      const results = outcomes.map((outcome) => outcome.result);
      setFeedback(batchDeliveryFeedback('merge', results, zh));
      if (mergeBlockingError) setError(mergeBlockingError);
      const firstAttention = outcomes.find((outcome) => outcome.result.status === 'attention' && (outcome.integration || outcome.conflictRecovery));
      await reload(firstAttention?.result.workspaceId ?? workspaceId);
      if (firstAttention?.integration) {
        setWorkspaceId(firstAttention.result.workspaceId);
        setIntegration(firstAttention.integration);
        setConflictPath(firstAttention.integration.conflictFiles[0] ?? '');
        setConflictWorkspaceOpen(firstAttention.integration.state === 'conflicted');
      }
      await props.onChanged?.();
    } catch (reason) {
      setError(errorMessage(reason, zh));
    } finally {
      setBusyAction(null);
    }
  }

  /** 用户明确点击后在原会话继续；发送回执与导航分别确认，未知结果不重发。 */
  async function continueWorkspaceConflict(workspace: TaskWorkspaceSnapshot): Promise<void> {
    if (!interactionOpen || !props.client || continuingConflictRef.current) return;
    continuingConflictRef.current = true;
    setBusyAction('ai');
    setError(null);
    try {
      /** 点击时重新读取，不能对已解决或已换代的页面快照继续派发。 */
      const latest = (await props.client.loadTaskGitWorkspaceSnapshot(props.task.id, workspace.id)).workspace;
      setWorkspaceDetails((current) => ({ ...current, [workspace.id]: latest }));
      /** 使用服务端核对过归属与可用性的原会话信息。 */
      const recovery = latest.conflictRecovery;
      if (!recovery) {
        setFeedback({ tone: 'info', text: zh ? '冲突状态已变化，已刷新当前仓库。' : 'The conflict state changed. The repository has been refreshed.' });
        return;
      }
      if (recovery.unavailableReason || !recovery.conversationId) throw new Error(recovery.unavailableReason ?? (zh ? '原冲突处理会话不可用。' : 'The original conflict conversation is unavailable.'));
      /** 跨窗口和重开仍识别已发送或结果待核对的同一次处理指令。 */
      const key = `zeus.conflict-ai-continue:${recovery.recoveryKey}`;
      /** 已发送和待核对状态都只允许导航，不再次写入消息。 */
      const previous = window.localStorage.getItem(key);
      if (!previous) {
        /** 写入前先留下待核对标记，断线或关窗不能导致盲目重发。 */
        window.localStorage.setItem(key, 'sending');
        try {
          await props.client.sendNativeMessage(props.task.projectId, recovery.conversationId, {
            content:
              '代码交付同步最新分支后产生了新的冲突。请在本会话当前命名分支和原工作目录中，读取真实 Git 状态，处理当前仓库全部冲突并用 git add 暂存所有已解决文件，保留两边互不冲突的有效修改。结束前确认 git diff --name-only --diff-filter=U 和 git ls-files -u 均无输出；无法安全处理时保留现场并说明原因。保留当前合并状态和 MERGE_HEAD，不要自行提交、切换分支、reset、rebase、更新目标分支或推送。处理完成后仍由用户通过代码交付提交并合入。',
            attachments: [],
            delivery: 'queue',
            collaborationMode: recovery.collaborationMode,
            idempotencyKey: `conflict-continue-${recovery.recoveryKey}`,
            clientUserMessageId: `conflict_continue_${recovery.recoveryKey}`,
          });
          window.localStorage.setItem(key, 'accepted');
        } catch (reason) {
          setFeedback({
            tone: 'warning',
            text: zh ? '继续处理指令的结果尚未确认，请进入原会话核对；再次点击只打开会话，不重复发送。' : 'The continuation is unconfirmed. Open the original conversation to check; another click only opens it without resending.',
            actionLabel: zh ? '打开原会话核对' : 'Open conversation to check',
            onAction: () => void openOriginalConflictConversation(recovery.conversationId!),
          });
          throw reason;
        }
      }
      await openOriginalConflictConversation(recovery.conversationId);
    } catch (reason) {
      setError(errorMessage(reason, zh));
    } finally {
      continuingConflictRef.current = false;
      setBusyAction(null);
    }
  }

  /** 导航单独续办，即使 AI 已解决冲突也不需要重新发送处理指令。 */
  async function openOriginalConflictConversation(conversationId: string): Promise<void> {
    try {
      await props.onOpenConversation(props.task.id, conversationId);
      props.onClose();
    } catch (reason) {
      setFeedback({
        tone: 'warning',
        text: zh ? '未能打开原会话。再次点击只重试打开，不重复发送处理指令。' : 'The original conversation could not be opened. Another click retries navigation without resending.',
        actionLabel: zh ? '重新打开原会话' : 'Retry opening conversation',
        onAction: () => void openOriginalConflictConversation(conversationId),
      });
      setError(errorMessage(reason, zh));
    }
  }

  async function saveResolution(): Promise<void> {
    if (!interactionOpen || !props.task || !props.client || !activeConflict || !conflictPath) return;
    setBusyAction('conflict');
    setError(null);
    const nextDrafts =
      conflict && conflictDocument
        ? {
            ...conflictDraftsRef.current,
            [conflictPath]: { fingerprint: conflict.fingerprint, document: conflictDocument },
          }
        : conflictDraftsRef.current;
    conflictDraftsRef.current = nextDrafts;
    try {
      if (!conflictDocument) return;
      const response = await props.client.resolveTaskIntegrationConflict(props.task.id, activeConflict.id, conflictPath, serializeConflictForGit(conflictDocument));
      setIntegration(response.integration);
      const nextPath = response.result.remainingConflictFiles[0] ?? '';
      setConflictPath(nextPath);
      if (!nextPath) setConflict(null);
      await reload(activeConflict.workspaceId);
      await props.onChanged?.();
    } catch (reason) {
      if (isTargetHeadChanged(reason) && selectedWorkspace) {
        try {
          await rebuildStaleIntegration(selectedWorkspace, nextDrafts);
        } catch (rebuildReason) {
          setError(errorMessage(rebuildReason, zh));
        }
      } else {
        setError(errorMessage(reason, zh));
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function startAiConflictSession(content: string, fingerprint: string, permissionMode: TaskIntegrationConflictPermissionMode, skillId?: string): Promise<void> {
    if (!interactionOpen || !props.task || !props.client || !activeConflict || !conflictPath) throw new Error(zh ? '当前没有可处理的冲突。' : 'No conflict is available.');
    setBusyAction('ai');
    setError(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      if (props.executionReady === false) {
        if (!props.onQueueConflictAiStart) throw new Error(zh ? '当前操作暂时无法进入准备队列。' : 'This operation cannot be queued yet.');
        const cancel = props.onQueueConflictAiStart({
          idempotencyKey,
          taskId: props.task.id,
          projectId: props.task.projectId,
          integrationId: activeConflict.id,
          path: conflictPath,
          content,
          fingerprint,
          permissionMode,
          ...(skillId ? { skillId } : {}),
        });
        setFeedback({
          tone: 'info',
          text: zh ? '正在准备，完成后自动开始。' : 'Preparing. This will start automatically when ready.',
          actionLabel: zh ? '取消' : 'Cancel',
          onAction: () => {
            cancel();
            setFeedback(null);
          },
        });
        return;
      }
      const operation = await props.client.startTaskIntegrationConflictAi(props.task.id, activeConflict.id, conflictPath, content, fingerprint, permissionMode, idempotencyKey, skillId);
      await props.onOpenConversation(props.task.id, operation.conversationId);
      props.onClose();
    } catch (reason) {
      setError(errorMessage(reason, zh));
      throw reason;
    } finally {
      setBusyAction(null);
    }
  }

  /** 完成已解决冲突的合入；关联会话不需要额外确认目录回收。 */
  async function finalize(): Promise<void> {
    if (!interactionOpen || !props.task || !props.client || !integration) return;
    setBusyAction('merge');
    setError(null);
    try {
      const response = await props.client.finalizeTaskIntegration(props.task.id, integration.id);
      setIntegration(response.integration);
      setConflictWorkspaceOpen(false);
      await reload(integration.workspaceId);
      await props.onChanged?.();
      setFeedback(deliveryFeedback(response.result, zh));
    } catch (reason) {
      if (isTargetHeadChanged(reason) && selectedWorkspace) {
        try {
          await rebuildStaleIntegration(selectedWorkspace, conflictDraftsRef.current);
        } catch (rebuildReason) {
          setError(errorMessage(rebuildReason, zh));
        }
      } else {
        setError(errorMessage(reason, zh));
      }
    } finally {
      setBusyAction(null);
    }
  }

  /** 并发更新后按原合入目标与方式重建，不改回检出来源。 */
  async function rebuildStaleIntegration(workspace: TaskWorkspaceSnapshot, drafts: Record<string, ConflictDraft>): Promise<void> {
    if (!props.task || !props.client) return;
    conflictDraftsRef.current = drafts;
    const response = await props.client.startTaskIntegration(props.task.id, workspace.id, {
      targetBranch: integration?.targetBranch ?? targetBranchesByWorkspace[workspace.id],
      mode: integration?.mode ?? mode,
      prepareOnly: Object.keys(drafts).length > 0,
    });
    if ('conflictRecovery' in response) {
      setConflictWorkspaceOpen(false);
      await reload(workspace.id);
      setFeedback({ tone: 'warning', text: workspaceConflictMessage(response.conflictRecovery, zh) });
      await props.onChanged?.();
      return;
    }
    setIntegration(response.integration);
    setConflictPath(response.integration.conflictFiles[0] ?? '');
    setConflictWorkspaceOpen(response.integration.state === 'conflicted');
    await reload(workspace.id);
    await props.onChanged?.();
    setFeedback(
      response.result
        ? deliveryFeedback(response.result, zh)
        : {
            tone: 'warning',
            text:
              Object.keys(drafts).length > 0
                ? zh
                  ? '目标分支已更新，合入候选已从最新本地提交重建；已有草稿会按冲突指纹逐项核对。'
                  : 'The target advanced. The candidate was rebuilt from the latest local commit, and saved drafts will be checked by conflict fingerprint.'
                : zh
                  ? '目标分支已更新，合入候选已自动从最新本地提交重建。'
                  : 'The target advanced. The candidate was automatically rebuilt from the latest local commit.',
          },
    );
  }

  function rememberConflictDraft(): void {
    if (!conflict || !conflictDocument || !conflictPath) return;
    conflictDraftsRef.current = {
      ...conflictDraftsRef.current,
      [conflictPath]: { fingerprint: conflict.fingerprint, document: conflictDocument },
    };
  }

  function selectConflictPath(nextPath: string): void {
    if (nextPath === conflictPath) return;
    rememberConflictDraft();
    setConflictPath(nextPath);
  }

  function selectWorkspace(nextId: string, nextScope: DiffScope = diffScope, nextFile?: string): void {
    rememberConflictDraft();
    setWorkspaceId(nextId);
    setDiffScope(nextScope);
    if (nextFile) setSelectedFile(nextFile);
    const recoverable = findRecoverableIntegration(integrations, nextId);
    setIntegration(recoverable ?? null);
    setMode(recoverable?.mode ?? 'merge');
    setConflictWorkspaceOpen(false);
    setConflictPath('');
    setError(null);
  }

  function toggleWorkspaceSelection(nextId: string, selected: boolean): void {
    setSelectedWorkspaceIds((current) => (selected ? Array.from(new Set([...current, nextId])) : current.filter((candidate) => candidate !== nextId)));
    if (selected && diffScope === 'working') {
      const paths = collectWorkingFiles(workspaceDetails[nextId]).map((file) => file.path);
      setSelectedPathsByWorkspace((current) => ({ ...current, [nextId]: paths }));
    }
  }

  function toggleBranchSelection(workspaceIds: string[], selected: boolean): void {
    const workspaceIdSet = new Set(workspaceIds);
    setSelectedWorkspaceIds((current) => (selected ? Array.from(new Set([...current, ...workspaceIds])) : current.filter((candidate) => !workspaceIdSet.has(candidate))));
    if (selected && diffScope === 'working') {
      setSelectedPathsByWorkspace((current) => {
        const next = { ...current };
        for (const selectedId of workspaceIds) next[selectedId] = collectWorkingFiles(workspaceDetails[selectedId]).map((file) => file.path);
        return next;
      });
    }
  }

  /** 文件与目录共用一次选择更新；勾选文件会同时启用所属仓库。 */
  function toggleFileSelection(nextId: string, paths: string[], selected: boolean): void {
    setSelectedPathsByWorkspace((current) => {
      // 仓库未勾选时旧选择不参与提交，重新勾选目录只纳入该目录。
      const currentPaths = selectedWorkspaceIdSet.has(nextId) ? (current[nextId] ?? []) : [];
      const nextPaths = selected ? Array.from(new Set([...currentPaths, ...paths])) : currentPaths.filter((candidate) => !paths.includes(candidate));
      return { ...current, [nextId]: nextPaths };
    });
    if (selected) setSelectedWorkspaceIds((current) => Array.from(new Set([...current, nextId])));
  }

  /** 独立窗口直接携带任务工作区身份，不能用项目默认仓库代替任务分支。 */
  async function openFileDiff(nextWorkspaceId: string, path: string): Promise<void> {
    try {
      if (!window.zeus?.openTaskGitDiffWindow) throw new Error(zh ? '独立差异窗口需要桌面应用。' : 'A separate diff window requires the desktop app.');
      await window.zeus.openTaskGitDiffWindow({ kind: 'task-git', taskId: props.task.id, workspaceId: nextWorkspaceId, path, scope: diffScope });
    } catch (reason) {
      setError(errorMessage(reason, zh));
    }
  }

  function openConflictWorkspace(): void {
    if (!activeConflict) return;
    setConflictPath((current) => current || activeConflict.conflictFiles[0] || '');
    setConflictWorkspaceOpen(true);
    setError(null);
    setFeedback(null);
  }

  function returnToDelivery(): void {
    rememberConflictDraft();
    setConflictWorkspaceOpen(false);
    setError(null);
    setFeedback({
      tone: 'info',
      text: zh ? '合入候选仍保留，可继续查看其他任务分支；未保存草稿仅在本次窗口内保留。' : 'The integration candidate is preserved. You can review other task branches; unsaved drafts remain available only in this window.',
    });
  }

  async function copyBranchName(branchName: string): Promise<void> {
    try {
      if (window.zeus?.writeClipboardText) await window.zeus.writeClipboardText(branchName);
      else await navigator.clipboard.writeText(branchName);
      setFeedback({ tone: 'info', text: zh ? `已复制分支名：${branchName}` : `Copied branch name: ${branchName}` });
    } catch {
      setError(zh ? '复制分支名失败，请稍后重试。' : 'The branch name could not be copied. Try again.');
    }
  }

  return (
    <ModalPortal rootClassName="task-git-merge-portal-root" backdropClassName="task-git-merge-backdrop" dismissDisabled={dismissDisabled} onDismiss={props.onClose} role="dialog" aria-labelledby="task-git-merge-title">
      <section className={`task-git-merge-modal task-git-delivery-modal${conflictWorkspaceOpen && activeConflict ? ' is-conflicted' : ''}`} data-modal-surface="dialog">
        <header className={`task-git-merge-header${headerFeedback ? ' has-results' : ''}`}>
          <span>
            <strong id="task-git-merge-title">
              {unresolvedConflict ? (zh ? '解决合入冲突' : 'Resolve Merge Conflicts') : conflictReadyToFinalize ? (zh ? '确认完成合入' : 'Confirm Merge Completion') : zh ? '代码交付' : 'Code Delivery'}
            </strong>
            <small>
              {unresolvedConflict
                ? `${selectedWorkspace?.branchName ?? props.task.taskCode ?? props.task.id} → ${unresolvedConflict.targetBranch} · ${zh ? '本地合入' : 'local merge'}`
                : `${props.projectName ? `${props.projectName} · ` : ''}${props.task.taskCode ?? props.task.id} · ${props.task.title}`}
            </small>
          </span>
          {headerFeedback && feedback ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} compactResults /> : null}
          {!standaloneWindow ? (
            <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={dismissDisabled}>
              ×
            </button>
          ) : null}
        </header>

        <div className={`task-git-merge-status${feedback ? ` is-${feedback.tone}` : ''}`}>{!headerFeedback && feedback && (!feedback.action || conflictWorkspaceOpen) ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} /> : null}</div>

        {workspaceIndex && (error || workspaceError) ? (
          <div className="task-git-merge-status is-error" role="alert">
            <VisibleApplicationError error={error ?? workspaceError} language={zh ? 'zh-CN' : 'en'} />
          </div>
        ) : null}

        <div className="task-git-merge-content">
          {loading ? (
            <InitialLoadState zh={zh} />
          ) : !workspaceIndex ? (
            <InitialLoadState zh={zh} error={error} onRetry={() => setLoadRevision((current) => current + 1)} />
          ) : unresolvedConflict ? (
            <TaskGitConflictWorkspace
              zh={zh}
              busy={busy}
              aiBusy={busyAction === 'ai'}
              integration={unresolvedConflict}
              taskBranch={selectedWorkspace?.branchName ?? ''}
              conflictPath={conflictPath}
              onSelectPath={selectConflictPath}
              conflict={conflictDocument}
              onDocumentChange={setConflictDocument}
              onAskAi={startAiConflictSession}
              skillClient={props.client}
              projectId={props.task.projectId}
            />
          ) : conflictReadyToFinalize && activeConflict ? (
            <ConflictCompletion zh={zh} targetBranch={activeConflict.targetBranch} taskBranch={selectedWorkspace?.branchName ?? ''} />
          ) : (
            <GitDeliveryWorkspace
              zh={zh}
              selectedRepositories={selectedWorkspaceIds.length}
              totalRepositories={visibleWorkspaceItems.length}
              selectedFiles={selectedCommitFileCount}
              fileBrowser={
                <DeliveryRepositoryFileTree
                  groups={repositoryGroups}
                  detailStates={detailStates}
                  diffScope={diffScope}
                  totalWorkingFiles={totalWorkingFiles}
                  totalCommittedFiles={totalCommittedFiles}
                  focusedWorkspaceId={workspaceId}
                  selectedFile={selectedFile}
                  selectedWorkspaceIds={selectedWorkspaceIdSet}
                  selectedPathsByWorkspace={selectedPathsByWorkspace}
                  currentConversationWorkspaceId={props.currentConversationWorkspaceId}
                  zh={zh}
                  disabled={busy}
                  onScopeChange={setDiffScope}
                  onSelectFile={(nextWorkspaceId, path) => selectWorkspace(nextWorkspaceId, diffScope, path)}
                  onToggleWorkspace={toggleWorkspaceSelection}
                  onToggleBranch={toggleBranchSelection}
                  onToggleFiles={toggleFileSelection}
                  onOpenFile={(nextWorkspaceId, path) => void openFileDiff(nextWorkspaceId, path)}
                  onCopyBranch={copyBranchName}
                />
              }
              actions={
                <GitDeliveryActions
                  zh={zh}
                  busyAction={busyAction}
                  clientAvailable={Boolean(props.client)}
                  canGenerate={Boolean(commitGenerationSelection.length)}
                  onGenerate={() => {
                    if (busyAction === 'commit-message') commitGenerationController.current?.abort();
                    else void generateCommitMessage();
                  }}
                  message={generatedMessage ?? message}
                  onMessageChange={(value) => {
                    commitGenerationController.current?.abort();
                    setGeneratedMessage(null);
                    setMessage(value);
                    setCommitGenerationFeedback('');
                  }}
                  generationFeedback={commitGenerationFeedback}
                  commitCount={committableFileCount}
                  onCommit={() => void commitSelected()}
                  commitFeedback={feedback?.action === 'commit' ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} /> : null}
                  beforeCommit={
                    <>
                      {selectedWorkspace && selectedWorkspace.activeConversationCount > 0 ? (
                        <small
                          className="task-git-review-active-sessions"
                          title={zh ? '合入只包含已提交内容；关联会话未归档时保留工作目录。' : 'Only committed changes are merged. The working folder is preserved while linked conversations remain unarchived.'}
                        >
                          {zh ? `${selectedWorkspace.activeConversationCount} 个会话运行中` : `${selectedWorkspace.activeConversationCount} active conversations`}
                        </small>
                      ) : null}
                      {conflictingWorkspaces.map((workspace) => (
                        <section key={workspace.id} className="task-git-delivery-target-issues" role="status" aria-label={zh ? `${repositoryLabel(workspace, zh)} 的冲突` : `Conflicts in ${repositoryLabel(workspace, zh)}`}>
                          <details>
                            <summary>
                              {repositoryLabel(workspace, zh)} · {zh ? `${workspace.review!.conflictFiles.length} 个冲突` : `${workspace.review!.conflictFiles.length} conflicts`}
                            </summary>
                            <small>{workspace.conflictRecovery ? workspaceConflictMessage(workspace.conflictRecovery, zh) : zh ? '请先解决冲突，再提交。' : 'Resolve conflicts before committing.'}</small>
                            <ul>
                              {workspace.review!.conflictFiles.map((path) => (
                                <li key={path}>
                                  <span>{path}</span>
                                </li>
                              ))}
                            </ul>
                            {workspace.conflictRecovery?.unavailableReason ? <small>{workspace.conflictRecovery.unavailableReason}</small> : null}
                          </details>
                          {workspace.conflictRecovery ? (
                            <>
                              <Button
                                variant="primary"
                                size="compact"
                                busy={busyAction === 'ai'}
                                onClick={() => void continueWorkspaceConflict(workspace)}
                                disabled={busy || Boolean(workspace.conflictRecovery.unavailableReason) || !workspace.conflictRecovery.conversationId}
                                title={workspace.conflictRecovery.unavailableReason ?? undefined}
                              >
                                {zh ? '继续 AI 处理' : 'Continue with AI'}
                              </Button>
                            </>
                          ) : null}
                        </section>
                      ))}
                    </>
                  }
                  mergeTarget={selectedTargetBranch}
                  mergeOptions={targetBranchOptions}
                  onMergeTargetChange={setSelectedTargetBranch}
                  mergeDisabled={selectedWorkspaceIds.length === 0}
                  mode={mode}
                  onModeChange={setMode}
                  mergeCount={selectedMergeCandidateCount}
                  onMerge={() => void mergeSelected()}
                  mergeIssues={
                    <>
                      {targetIssues.length > 0 ? (
                        <details className="task-git-delivery-target-issues" role="status">
                          <summary>{zh ? `${targetIssues.length} 个仓库无法合入` : `${targetIssues.length} repositories cannot merge`}</summary>
                          <ul>
                            {targetIssues.map((issue) => (
                              <li key={issue.workspaceId}>
                                <b>{issue.repositoryName}</b>
                                <span>{issue.message}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </>
                  }
                  mergeFeedback={
                    <>
                      {feedback?.action === 'merge' ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} /> : null}
                      {activeConflict ? (
                        <>
                          <small className="task-git-delivery-local-pending">
                            {activeConflict.conflictFiles.length > 0
                              ? zh
                                ? `上次合入 ${activeConflict.targetBranch} 保留了 ${activeConflict.conflictFiles.length} 个冲突文件。`
                                : `The previous merge into ${activeConflict.targetBranch} preserved ${activeConflict.conflictFiles.length} conflicted file(s).`
                              : zh
                                ? `上次合入 ${activeConflict.targetBranch} 的冲突已经处理完，等待确认完成。`
                                : `The previous merge into ${activeConflict.targetBranch} is resolved and waiting for final confirmation.`}
                          </small>
                          <Button variant="primary" size="compact" onClick={openConflictWorkspace} disabled={busy}>
                            {activeConflict.conflictFiles.length > 0 ? (zh ? '继续处理冲突' : 'Resume conflict resolution') : zh ? '确认完成合入' : 'Confirm merge completion'}
                          </Button>
                        </>
                      ) : null}
                      {pendingLocalSync ? (
                        <small className="task-git-delivery-local-pending">
                          {zh
                            ? `上次合入 ${pendingLocalSync.targetBranch} 尚未同步，处理目标目录中的阻碍后，选择该目标再继续合入。`
                            : `The previous merge into ${pendingLocalSync.targetBranch} has not synced. Resolve the blocker, then select that target to continue.`}
                        </small>
                      ) : null}
                    </>
                  }
                  pushCount={selectedPushCandidateCount}
                  onPush={() => void pushSelected()}
                  pushFeedback={feedback?.action === 'push' ? <DeliveryFeedbackNotice feedback={feedback} zh={zh} /> : null}
                />
              }
              selectedFile={selectedFile}
              diffTitle={selectedDiffTitle}
              diffLoading={diffLoading}
              diff={fileDiff}
              revision={snapshotRevision}
              previewRequest={selectedWorkspace ? { kind: 'task-git', taskId: props.task.id, workspaceId: selectedWorkspace.id, path: selectedFile, scope: diffScope } : undefined}
              onShowCommitted={diffScope === 'working' && totalCommittedFiles > 0 ? () => setDiffScope('committed') : undefined}
              busy={busy}
            />
          )}
        </div>

        {/* 独立系统窗口使用原生关闭；仅嵌入式弹窗或冲突工作流保留底部操作。 */}
        {!standaloneWindow || conflictWorkspaceOpen ? (
          <footer className="task-git-merge-footer">
            <Button variant="secondary" size="regular" onClick={conflictWorkspaceOpen ? returnToDelivery : props.onClose} disabled={dismissDisabled}>
              {conflictWorkspaceOpen ? (zh ? '返回代码交付' : 'Back to code delivery') : zh ? '关闭' : 'Close'}
            </Button>
            {conflictWorkspaceOpen && activeConflict ? (
              activeConflict.conflictFiles.length > 0 ? (
                <Button variant="primary" size="regular" busy={busyAction === 'conflict'} onClick={() => void saveResolution()} disabled={!conflict || unresolvedConflictBlocks > 0}>
                  {unresolvedConflictBlocks > 0 ? (zh ? `还有 ${unresolvedConflictBlocks} 个冲突未处理` : `${unresolvedConflictBlocks} conflict(s) unresolved`) : zh ? '保存该文件并继续' : 'Save file and continue'}
                </Button>
              ) : (
                <Button variant="primary" size="regular" busy={busyAction === 'merge'} onClick={() => void finalize()}>
                  {zh ? `完成合入 ${activeConflict.targetBranch}` : `Finish merging into ${activeConflict.targetBranch}`}
                </Button>
              )
            ) : null}
          </footer>
        ) : null}
      </section>
    </ModalPortal>
  );
}

function ConflictCompletion(props: { zh: boolean; targetBranch: string; taskBranch: string }) {
  return (
    <section className="task-git-conflict-completion" aria-label={props.zh ? '冲突收尾确认' : 'Conflict completion confirmation'}>
      <span aria-hidden="true">✓</span>
      <strong>{props.zh ? '冲突已全部处理' : 'All conflicts are resolved'}</strong>
      <p>
        {props.zh
          ? '合入结果已经准备好。确认后将生成合入提交，并同步到所选本地目标分支；远端推送仍由独立按钮按需执行。'
          : 'The merge result is ready. Confirm to create the merge commit and sync the selected local target branch. Remote push remains an optional separate action.'}
      </p>
      <dl>
        <div>
          <dt>{props.zh ? '目标分支' : 'Target branch'}</dt>
          <dd>{props.targetBranch}</dd>
        </div>
        <div>
          <dt>{props.zh ? '任务分支' : 'Task branch'}</dt>
          <dd>{props.taskBranch || '—'}</dd>
        </div>
      </dl>
    </section>
  );
}

async function loadWorkspaceDetailCollection(client: DeliveryClient, taskId: string, workspaces: TaskWorkspaceIndexSnapshot[]): Promise<{ details: Record<string, TaskWorkspaceSnapshot>; states: Record<string, 'error'> }> {
  const snapshots = await Promise.allSettled(workspaces.map((workspace) => client.loadTaskGitWorkspaceSnapshot(taskId, workspace.id)));
  const details: Record<string, TaskWorkspaceSnapshot> = {};
  const states: Record<string, 'error'> = {};
  snapshots.forEach((snapshot, index) => {
    const workspaceId = workspaces[index]?.id;
    if (!workspaceId) return;
    if (snapshot.status === 'fulfilled') details[workspaceId] = snapshot.value.workspace;
    else states[workspaceId] = 'error';
  });
  return { details, states };
}

/** 会话入口返回当前 workspace 所在分支的全部仓库；无会话上下文时保持任务全量视图。 */
function deliveryWorkspacesForConversationBranch(workspaces: TaskWorkspaceIndexSnapshot[], currentConversationWorkspaceId: string | null | undefined): TaskWorkspaceIndexSnapshot[] {
  if (!currentConversationWorkspaceId) return workspaces;
  /** 当前分支只能由确切 workspace 身份解析，身份失效时不扩大到其他历史分支。 */
  const currentBranch = workspaces.find((workspace) => workspace.id === currentConversationWorkspaceId)?.branchName;
  return currentBranch ? workspaces.filter((workspace) => workspace.branchName === currentBranch) : [];
}

/** 默认聚焦当前可见分支首个有未提交文件的仓库，由既有文件 effect 选择其第一个文件。 */
function initialDeliveryReviewWorkspaceId(details: Record<string, TaskWorkspaceSnapshot>, workspaces: TaskWorkspaceIndexSnapshot[], currentConversationWorkspaceId: string | null | undefined, fallbackWorkspaceId: string): string {
  /** 与文件树共用同一分支投影，避免聚焦到已隐藏的历史 workspace。 */
  const visibleWorkspaces = deliveryWorkspacesForConversationBranch(workspaces, currentConversationWorkspaceId);
  /** 未提交文件优先；没有修改时保留当前会话仓库或该分支首仓库。 */
  return visibleWorkspaces.find((workspace) => collectWorkingFiles(details[workspace.id]).length > 0)?.id ?? visibleWorkspaces.find((workspace) => workspace.id === fallbackWorkspaceId)?.id ?? visibleWorkspaces[0]?.id ?? '';
}

/** 会话入口只默认勾选所在分支的可交付仓库；无会话上下文的任务入口保留整体选择。 */
function initializeDeliverySelection(
  details: Record<string, TaskWorkspaceSnapshot>,
  workspaces: TaskWorkspaceIndexSnapshot[],
  currentConversationWorkspaceId: string | null | undefined,
  setSelectedWorkspaceIds: Dispatch<SetStateAction<string[]>>,
  setSelectedPathsByWorkspace: Dispatch<SetStateAction<Record<string, string[]>>>,
): void {
  /** 与文件树共用分支投影，覆盖同分支的多个仓库；工作区缺失时不扩大范围。 */
  const visibleWorkspaces = deliveryWorkspacesForConversationBranch(workspaces, currentConversationWorkspaceId);
  /** 仅为默认选中的仓库初始化文件勾选。 */
  const selectedIds = visibleWorkspaces.filter((workspace) => isDeliverableWorkspace(details[workspace.id])).map((workspace) => workspace.id);
  /** 仓库选择与文件选择使用同一范围。 */
  const selectedPaths = Object.fromEntries(selectedIds.map((workspaceId) => [workspaceId, collectWorkingFiles(details[workspaceId]).map((file) => file.path)]));
  setSelectedWorkspaceIds(selectedIds);
  setSelectedPathsByWorkspace(selectedPaths);
}

/** 刷新保留用户的勾选；首次加载失败后的重试仍使用原会话分支。 */
function preserveDeliverySelection(
  details: Record<string, TaskWorkspaceSnapshot>,
  workspaces: TaskWorkspaceIndexSnapshot[],
  currentConversationWorkspaceId: string | null | undefined,
  initialized: boolean,
  setSelectedWorkspaceIds: Dispatch<SetStateAction<string[]>>,
  setSelectedPathsByWorkspace: Dispatch<SetStateAction<Record<string, string[]>>>,
): void {
  if (!initialized) {
    initializeDeliverySelection(details, workspaces, currentConversationWorkspaceId, setSelectedWorkspaceIds, setSelectedPathsByWorkspace);
    return;
  }
  /** 保留勾选时仍限定当前分支，防止隐藏仓库继续参与交付。 */
  const visibleWorkspaces = deliveryWorkspacesForConversationBranch(workspaces, currentConversationWorkspaceId);
  const availableIds = new Set(visibleWorkspaces.map((workspace) => workspace.id));
  setSelectedWorkspaceIds((current) => current.filter((workspaceId) => availableIds.has(workspaceId) && isDeliverableWorkspace(details[workspaceId])));
  setSelectedPathsByWorkspace((current) => {
    const next: Record<string, string[]> = {};
    for (const workspace of visibleWorkspaces) {
      const availablePaths = new Set(collectWorkingFiles(details[workspace.id]).map((file) => file.path));
      next[workspace.id] = (current[workspace.id] ?? []).filter((path) => availablePaths.has(path));
    }
    return next;
  });
}

function isDeliverableWorkspace(workspace: TaskWorkspaceSnapshot | undefined): boolean {
  if (!workspace || workspace.state === 'discarded') return false;
  return collectWorkingFiles(workspace).length > 0 || (workspace.branchComparison?.files.length ?? 0) > 0 || workspace.state === 'merged';
}

/** 按仓库、所选目标和当前任务提交判断是否交付，其他目标的结果不能复用。 */
function findDeliveredIntegration(workspace: TaskWorkspaceSnapshot | undefined, integrations: TaskIntegrationRecord[], targetBranch: string): TaskIntegrationRecord | null {
  if (!workspace) return null;
  const currentTaskHeadSha = workspace.branchComparison?.taskHeadSha ?? workspace.review?.headSha ?? workspace.headSha ?? null;
  const workspaceHeadMatchesCurrentBranch = Boolean(workspace.state === 'merged' && workspace.headSha && workspace.headSha === currentTaskHeadSha);
  return (
    integrations.find(
      (candidate) =>
        candidate.workspaceId === workspace.id && candidate.targetBranch === targetBranch && candidate.state === 'merged' && (candidate.taskHeadSha ? candidate.taskHeadSha === currentTaskHeadSha : workspaceHeadMatchesCurrentBranch),
    ) ?? null
  );
}

function collectWorkingFiles(workspace: TaskWorkspaceSnapshot | null | undefined): TaskGitFileStatus[] {
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
    deletions: file.deletions,
  };
}

function toWorkingDeliveryFile(file: TaskGitFileStatus, zh: boolean): DeliveryFile {
  return { path: file.path, label: workingFileLabel(file, zh), additions: 0, deletions: 0, workingFile: file };
}

/** 仓库列表呈现当前目标的交付状态，远端确认仅使用与该目标对应的证据。 */
function workspaceStateLabel(workspace: TaskWorkspaceIndexSnapshot, detail: TaskWorkspaceSnapshot | undefined, loadState: 'loading' | 'error' | undefined, zh: boolean, integrations: TaskIntegrationRecord[], targetBranch: string): string {
  /** 未结束的合入优先显示续办状态。 */
  const recovery = findRecoverableIntegration(integrations, workspace.id);
  /** 已合入状态必须匹配所选目标与当前提交。 */
  const delivered = findDeliveredIntegration(detail, integrations, targetBranch);
  const activeSuffix = workspace.activeConversationCount > 0 ? (zh ? ` · ${workspace.activeConversationCount} 个会话活动` : ` · ${workspace.activeConversationCount} active session(s)`) : '';
  if (detail?.review?.conflictFiles.length) return `${zh ? `${detail.review.conflictFiles.length} 个冲突待处理` : `${detail.review.conflictFiles.length} conflict(s) pending`}${activeSuffix}`;
  if (recovery?.state === 'conflicted') {
    const status = recovery.conflictFiles.length > 0 ? (zh ? `${recovery.conflictFiles.length} 个冲突待处理` : `${recovery.conflictFiles.length} conflict(s) pending`) : zh ? '冲突已处理 · 待确认' : 'Conflicts resolved · confirm';
    return `${status}${activeSuffix}`;
  }
  if (recovery?.state === 'pending_local_sync') return `${zh ? '目标分支待同步' : 'Target sync pending'}${activeSuffix}`;
  if (delivered) {
    if (!workspace.remoteName) return `${zh ? '已合入 · 无远端' : 'Merged · no remote'}${activeSuffix}`;
    if (!detail) return `${zh ? '已合入 · 远端待读取' : 'Merged · remote not loaded'}${activeSuffix}`;
    return `${targetBranch === workspace.sourceBranch && detail.sourceRemoteVerified ? (zh ? '已合入 · 已推送' : 'Merged · pushed') : zh ? '已合入 · 推送可选' : 'Merged · push optional'}${activeSuffix}`;
  }
  if (workspace.state === 'discarded') return zh ? '已放弃' : 'Discarded';
  if (loadState === 'loading') return `${zh ? '正在读取…' : 'Loading…'}${activeSuffix}`;
  if (loadState === 'error') return `${zh ? '读取失败' : 'Could not load'}${activeSuffix}`;
  if (!detail) return `${zh ? '尚未读取' : 'Not loaded'}${activeSuffix}`;
  const workingCount = collectWorkingFiles(detail).length;
  if (workingCount > 0) return `${zh ? `${workingCount} 个未提交文件` : `${workingCount} uncommitted file(s)`}${activeSuffix}`;
  if (!detail.targetBranches.includes(targetBranch)) return zh ? '目标分支不可用' : 'Target branch unavailable';
  return `${zh ? '已提交 · 可合入' : 'Committed · merge ready'}${activeSuffix}`;
}

/** 区分已保存的提交和仍未完成的合入，不把同步冲突描述成提交失败。 */
function workspaceConflictMessage(recovery: TaskWorkspaceConflictRecovery | null, zh: boolean): string {
  if (!recovery) return zh ? '工作区状态已变化，请查看刷新后的代码交付。' : 'The workspace state changed. Review the refreshed code delivery.';
  return zh
    ? `当前提交 ${shortSha(recovery.headSha)} 已保存，同步${recovery.updatedBranch ? ` ${recovery.updatedBranch} ` : '分支'}后仍有 ${recovery.conflictFiles.length} 个冲突文件，尚未完成合入。`
    : `Commit ${shortSha(recovery.headSha)} is saved. ${recovery.conflictFiles.length} conflict file(s) remain after syncing ${recovery.updatedBranch ?? 'branches'}; the merge is unfinished.`;
}

function findRecoverableIntegration(integrations: TaskIntegrationRecord[], workspaceId?: string): TaskIntegrationRecord | undefined {
  if (!workspaceId) return undefined;
  return integrations.find((candidate) => candidate.workspaceId === workspaceId && (candidate.state === 'conflicted' || candidate.state === 'pending_local_sync'));
}

type MergeWorkspaceAction = { type: 'start' } | { type: 'resolve_conflict' | 'finalize'; integration: TaskIntegrationRecord };

/** 合入资格与执行共用同一目标，未完成现场只允许继续原分支。 */
function mergeWorkspaceAction(workspace: TaskWorkspaceSnapshot | undefined, integrations: TaskIntegrationRecord[], targetBranch: string): MergeWorkspaceAction | null {
  if (!workspace || workspace.state === 'discarded' || collectWorkingFiles(workspace).length > 0 || !workspace.targetBranches.includes(targetBranch) || targetBranch === workspace.branchName) return null;
  const recoverable = findRecoverableIntegration(integrations, workspace.id);
  if (recoverable) {
    if (recoverable.targetBranch !== targetBranch) return null;
    if (recoverable.state === 'pending_local_sync' || recoverable.conflictFiles.length === 0) return { type: 'finalize', integration: recoverable };
    return { type: 'resolve_conflict', integration: recoverable };
  }
  if (findDeliveredIntegration(workspace, integrations, targetBranch)) return null;
  return { type: 'start' };
}

function committedFileLabel(changeType: TaskGitFileDiff['changeType'], zh: boolean): string {
  const labels = zh ? { added: '新增', deleted: '删除', modified: '修改', renamed: '重命名', copied: '复制' } : { added: 'Added', deleted: 'Deleted', modified: 'Modified', renamed: 'Renamed', copied: 'Copied' };
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
        other: '变化',
      }
    : {
        added: 'Added',
        modified: 'Modified',
        deleted: 'Deleted',
        renamed: 'Renamed',
        untracked: 'Untracked',
        conflict: 'Conflict',
        other: 'Changed',
      };
  return labels[file.category];
}

/** 使用实际合入目标说明完成或待同步状态。 */
function deliveryFeedback(result: TaskIntegrationResult, zh: boolean): DeliveryFeedback {
  return result.localSyncStatus === 'pending'
    ? {
        action: 'merge',
        tone: 'warning',
        summary: zh ? '合入：待处理' : 'Merge: needs attention',
        text: zh ? '合入结果已保存在隔离工作区；目标分支尚未同步，处理目标目录中的阻碍后请重试。' : 'The integration result is preserved until the target worktree can be synced. Resolve the blocker, then retry sync.',
      }
    : {
        action: 'merge',
        tone: 'success',
        summary: zh ? '合入：成功' : 'Merge: succeeded',
        text: zh ? `已合入 ${result.targetBranch} · ${shortSha(result.resultHeadSha)}` : `Merged into ${result.targetBranch} · ${shortSha(result.resultHeadSha)}`,
      };
}

/** 单仓和多仓统一汇总非零状态，完整结果保留在详情浮层中。 */
function batchDeliveryFeedback(action: 'commit' | 'merge' | 'push', results: BatchDeliveryResult[], zh: boolean): DeliveryFeedback {
  /** 异常数量排在成功之前，窄窗口省略尾部时仍能发现失败和待处理。 */
  const labels = zh ? { failed: '失败', attention: '待处理', skipped: '跳过', succeeded: '成功' } : { failed: 'failed', attention: 'need attention', skipped: 'skipped', succeeded: 'succeeded' };
  /** 只列出本次实际出现的状态，避免零值占据提示空间。 */
  const summary = (Object.keys(labels) as BatchDeliveryStatus[])
    .map((status) => {
      /** 每种状态对应的仓库数。 */
      const count = results.filter((result) => result.status === status).length;
      return count > 0 ? (zh ? `${labels[status]} ${count}` : `${count} ${labels[status]}`) : '';
    })
    .filter(Boolean)
    .join(' · ');
  /** 操作名称用于多仓汇总和无结果提示。 */
  const actionLabel = zh ? { commit: '提交', merge: '合入', push: '推送' }[action] : { commit: 'Commit', merge: 'Merge', push: 'Push' }[action];
  return {
    action,
    results,
    tone: results.some((result) => result.status === 'failed' || result.status === 'attention') ? 'warning' : results.some((result) => result.status === 'succeeded') ? 'success' : 'info',
    text: summary ? `${actionLabel}：${summary}` : zh ? `没有可${actionLabel}的仓库` : `No repositories to ${actionLabel.toLowerCase()}`,
  };
}

function shortSha(value: string): string {
  return value.slice(0, 8);
}

function isTargetHeadChanged(error: unknown): boolean {
  return error instanceof ZeusApiError && error.error === 'ZEUS_TARGET_HEAD_CHANGED';
}

function errorMessage(error: unknown, zh: boolean): string {
  return formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en');
}

function isTargetBranchDirty(error: unknown): boolean {
  return error instanceof ZeusApiError && error.error === 'ZEUS_TARGET_BRANCH_DIRTY';
}
