import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import { buildTaskCommitMessageSuggestion } from '@zeus/shared';
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
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { TaskGitConflictWorkspace } from './TaskGitConflictWorkspace.js';
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
>;

type DiffScope = 'committed' | 'working';
type BusyAction = 'loading' | 'commit' | 'push' | 'merge' | 'conflict' | 'ai' | null;

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
  actionLabel?: string;
  onAction?: () => void;
}

type BatchDeliveryStatus = 'succeeded' | 'skipped' | 'attention' | 'failed';

interface BatchDeliveryResult {
  workspaceId: string;
  repositoryName: string;
  status: BatchDeliveryStatus;
  message: string;
}

interface DeliveryRepositoryGroup {
  workspace: TaskWorkspaceIndexSnapshot;
  detail: TaskWorkspaceSnapshot | undefined;
  files: DeliveryFile[];
}

export interface PendingConflictAiStart {
  idempotencyKey: string;
  taskId: string;
  projectId: string;
  integrationId: string;
  path: string;
  content: string;
  fingerprint: string;
  permissionMode: TaskIntegrationConflictPermissionMode;
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

export function TaskGitMergeModal(props: TaskGitMergeModalProps) {
  if (!props.open || !props.task) return null;
  // 任务身份同时决定弹窗内全部瞬态状态；关闭或切换任务时必须卸载旧实例，禁止把旧工作区带入新任务请求。
  return <TaskGitMergeModalContent key={props.task.id} {...props} task={props.task} />;
}

function TaskGitMergeModalContent(props: TaskGitMergeModalContentProps) {
  const zh = props.language === 'zh-CN';
  const standaloneWindow = typeof document !== 'undefined' && document.body.dataset.surface === 'task-git-delivery';
  const initialConversationWorkspaceIdRef = useRef(props.currentConversationWorkspaceId);
  const [workspaceIndex, setWorkspaceIndex] = useState<TaskWorkspaceIndexCollection | null>(null);
  const [workspaceDetails, setWorkspaceDetails] = useState<Record<string, TaskWorkspaceSnapshot>>({});
  const [detailStates, setDetailStates] = useState<Record<string, 'loading' | 'error'>>({});
  const [integrations, setIntegrations] = useState<TaskIntegrationRecord[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [diffScope, setDiffScope] = useState<DiffScope>('working');
  const [selectedFile, setSelectedFile] = useState('');
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([]);
  const [selectedPathsByWorkspace, setSelectedPathsByWorkspace] = useState<Record<string, string[]>>({});
  const [fileDiff, setFileDiff] = useState<TaskGitDiffSummary | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [message, setMessage] = useState('');
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
  const [feedback, setFeedback] = useState<DeliveryFeedback | null>(null);
  const [batchResults, setBatchResults] = useState<BatchDeliveryResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const selectionInitializedRef = useRef(false);

  const selectedWorkspace = workspaceDetails[workspaceId] ?? null;
  const workspaceError = selectedWorkspace?.comparisonError ?? selectedWorkspace?.reviewError ?? null;
  useApplicationErrorDialog(error ?? workspaceError, {
    language: zh ? 'zh-CN' : 'en',
    title: zh ? '代码交付操作失败' : 'Code delivery operation failed',
    source: 'TaskGitMergeModal',
  });
  const targetBranch = selectedWorkspace?.sourceBranch ?? '';
  const workingFiles = useMemo(() => collectWorkingFiles(selectedWorkspace), [selectedWorkspace]);
  const committedFiles = useMemo(() => (selectedWorkspace?.branchComparison?.files ?? []).map((file) => toCommittedDeliveryFile(file, zh)), [selectedWorkspace?.branchComparison?.files, zh]);
  const repositoryGroups = useMemo<DeliveryRepositoryGroup[]>(
    () =>
      (workspaceIndex?.items ?? []).map((workspace) => {
        const detail = workspaceDetails[workspace.id];
        return {
          workspace,
          detail,
          files: diffScope === 'committed' ? (detail?.branchComparison?.files ?? []).map((file) => toCommittedDeliveryFile(file, zh)) : collectWorkingFiles(detail).map((file) => toWorkingDeliveryFile(file, zh)),
        };
      }),
    [workspaceIndex?.items, workspaceDetails, diffScope, zh],
  );
  const totalWorkingFiles = useMemo(() => Object.values(workspaceDetails).reduce((total, workspace) => total + collectWorkingFiles(workspace).length, 0), [workspaceDetails]);
  const totalCommittedFiles = useMemo(() => Object.values(workspaceDetails).reduce((total, workspace) => total + (workspace.branchComparison?.files.length ?? 0), 0), [workspaceDetails]);
  const selectedWorkspaceIdSet = useMemo(() => new Set(selectedWorkspaceIds), [selectedWorkspaceIds]);
  const selectedCommitFileCount = useMemo(() => selectedWorkspaceIds.reduce((total, selectedId) => total + (selectedPathsByWorkspace[selectedId]?.length ?? 0), 0), [selectedWorkspaceIds, selectedPathsByWorkspace]);
  const selectedMergeCandidateCount = useMemo(() => selectedWorkspaceIds.filter((selectedId) => mergeWorkspaceAction(workspaceDetails[selectedId], integrations) !== null).length, [selectedWorkspaceIds, workspaceDetails, integrations]);
  const selectedPushCandidateCount = useMemo(
    () => selectedWorkspaceIds.filter((selectedId) => Boolean(workspaceDetails[selectedId]?.remoteName && findDeliveredIntegration(workspaceDetails[selectedId], integrations))).length,
    [selectedWorkspaceIds, workspaceDetails, integrations],
  );
  const activeConflict = integration?.state === 'conflicted' ? integration : null;
  const unresolvedConflict = conflictWorkspaceOpen && activeConflict && activeConflict.conflictFiles.length > 0 ? activeConflict : null;
  const conflictReadyToFinalize = Boolean(conflictWorkspaceOpen && activeConflict && activeConflict.conflictFiles.length === 0);
  const pendingLocalSync = integration?.state === 'pending_local_sync' ? integration : null;
  const busy = busyAction !== null;
  const loading = busyAction === 'loading' && workspaceIndex === null;
  const dismissDisabled = busyAction !== null && busyAction !== 'loading';
  const deliveredIntegration = selectedWorkspace ? findDeliveredIntegration(selectedWorkspace, integrations) : null;
  const unresolvedConflictBlocks = useMemo(() => countUnresolvedConflictBlocks(conflictDocument), [conflictDocument]);

  useEffect(() => {
    if (!props.open || !props.task || !props.client) return;
    const client = props.client;
    const taskId = props.task.id;
    let cancelled = false;
    setBusyAction('loading');
    setError(null);
    setFeedback(null);
    setBatchResults([]);
    setConflictWorkspaceOpen(false);
    conflictDraftsRef.current = {};
    selectionInitializedRef.current = false;
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
          initializeDeliverySelection(details, workspaceSnapshot.items, setSelectedWorkspaceIds, setSelectedPathsByWorkspace);
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
  }, [props.open, props.task?.id, props.client, zh, loadRevision]);

  useEffect(() => {
    const nextFiles = diffScope === 'committed' ? committedFiles : workingFiles.map((file) => toWorkingDeliveryFile(file, zh));
    setSelectedFile((current) => (nextFiles.some((file) => file.path === current) ? current : (nextFiles[0]?.path ?? '')));
    setFileDiff(null);
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
            text: zh ? '来源分支更新后已按最新提交重建；相同冲突的草稿已回填，请重新确认并保存。' : 'The source advanced and the candidate was rebuilt. A matching draft was restored; review and save it again.',
          });
        } else {
          setConflictDocument(createConflictDocument(next));
          if (savedDraft) {
            setFeedback({
              tone: 'warning',
              text: zh ? '来源分支更新后冲突内容已经变化，旧草稿未自动套用，请重新处理。' : 'The conflict changed after rebuilding from the source branch, so the previous draft was not applied.',
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
  }, [props.task?.id, props.client, activeConflict?.id, conflictPath, zh]);

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
    preserveDeliverySelection(details, workspaceSnapshot.items, selectionInitializedRef.current, setSelectedWorkspaceIds, setSelectedPathsByWorkspace);
    selectionInitializedRef.current = true;
    const recoverable = integrationSnapshot.items.find((candidate) => candidate.workspaceId === preferredWorkspaceId && (candidate.state === 'conflicted' || candidate.state === 'pending_local_sync'));
    setIntegration(recoverable ?? null);
    setSnapshotRevision((current) => current + 1);
    const nextWorkspace = workspaceSnapshot.items.find((workspace) => workspace.id === preferredWorkspaceId) ?? workspaceSnapshot.items[0] ?? null;
    if (nextWorkspace) {
      setWorkspaceId(nextWorkspace.id);
    }
  }

  useEffect(() => {
    if (!props.refreshRevision || !props.task || !props.client) return;
    void reload(workspaceId).catch((reason: unknown) => setError(errorMessage(reason, zh)));
  }, [props.refreshRevision]);

  async function commitSelected(): Promise<void> {
    if (!props.task || !props.client || selectedCommitFileCount === 0) return;
    const client = props.client;
    const taskId = props.task.id;
    setBusyAction('commit');
    setError(null);
    setFeedback(null);
    setBatchResults([]);
    try {
      const targets = selectedWorkspaceIds
        .map((selectedId) => ({ workspace: workspaceDetails[selectedId], selectedPaths: selectedPathsByWorkspace[selectedId] ?? [] }))
        .filter((target): target is { workspace: TaskWorkspaceSnapshot; selectedPaths: string[] } => Boolean(target.workspace && target.selectedPaths.length > 0));
      const results = await Promise.all(
        targets.map(async ({ workspace, selectedPaths }): Promise<BatchDeliveryResult> => {
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
            return { workspaceId: workspace.id, repositoryName: repositoryLabel(workspace, zh), status: 'failed', message: errorMessage(reason, zh) };
          }
        }),
      );
      setBatchResults(results);
      await reload(workspaceId);
      await props.onChanged?.();
      setFeedback(batchDeliveryFeedback('commit', results, zh));
    } finally {
      setBusyAction(null);
    }
  }

  async function pushSelected(): Promise<void> {
    if (!props.task || !props.client || selectedWorkspaceIds.length === 0) return;
    const client = props.client;
    const taskId = props.task.id;
    setBusyAction('push');
    setError(null);
    setFeedback(null);
    setBatchResults([]);
    try {
      const results = await Promise.all(
        selectedWorkspaceIds.map(async (selectedId): Promise<BatchDeliveryResult> => {
          const workspace = workspaceDetails[selectedId];
          if (!workspace) return { workspaceId: selectedId, repositoryName: selectedId, status: 'skipped', message: zh ? '仓库详情尚未读取。' : 'Repository details are not loaded.' };
          if (!workspace.remoteName) return { workspaceId: workspace.id, repositoryName: repositoryLabel(workspace, zh), status: 'skipped', message: zh ? '仓库未配置远端。' : 'No remote is configured.' };
          const delivered = findDeliveredIntegration(workspace, integrations);
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
      setBatchResults(results);
      await reload(workspaceId);
      await props.onChanged?.();
      setFeedback(batchDeliveryFeedback('push', results, zh));
    } finally {
      setBusyAction(null);
    }
  }

  async function mergeSelected(): Promise<void> {
    if (!props.task || !props.client || selectedWorkspaceIds.length === 0) return;
    const client = props.client;
    const taskId = props.task.id;
    const activeConversationCount = selectedWorkspaceIds.reduce((total, selectedId) => total + (workspaceDetails[selectedId]?.activeConversationCount ?? 0), 0);
    if (activeConversationCount > 0 && !confirmBatchActiveSessionRisk(activeConversationCount, zh)) return;
    setBusyAction('merge');
    setError(null);
    setFeedback(null);
    setBatchResults([]);
    try {
      const outcomes = await Promise.all(
        selectedWorkspaceIds.map(async (selectedId): Promise<{ result: BatchDeliveryResult; integration?: TaskIntegrationRecord }> => {
          const workspace = workspaceDetails[selectedId];
          if (!workspace) return { result: { workspaceId: selectedId, repositoryName: selectedId, status: 'skipped', message: zh ? '仓库详情尚未读取。' : 'Repository details are not loaded.' } };
          const label = repositoryLabel(workspace, zh);
          const action = mergeWorkspaceAction(workspace, integrations);
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
              return { result: { workspaceId: workspace.id, repositoryName: label, status: 'failed', message: errorMessage(reason, zh) } };
            }
          }
          if (!action) {
            if (collectWorkingFiles(workspace).length > 0) return { result: { workspaceId: workspace.id, repositoryName: label, status: 'skipped', message: zh ? '仍有未提交文件。' : 'Uncommitted files remain.' } };
            if (findDeliveredIntegration(workspace, integrations))
              return { result: { workspaceId: workspace.id, repositoryName: label, status: 'skipped', message: zh ? '当前任务提交已经合入。' : 'The current task commit is already merged.' } };
            return { result: { workspaceId: workspace.id, repositoryName: label, status: 'skipped', message: zh ? '没有可合入的任务分支成果。' : 'No task branch result is ready to merge.' } };
          }
          try {
            const response = await client.startTaskIntegration(taskId, workspace.id, { targetBranch: workspace.sourceBranch, mode });
            if (response.integration.state === 'conflicted') {
              return {
                integration: response.integration,
                result: {
                  workspaceId: workspace.id,
                  repositoryName: label,
                  status: 'attention',
                  message: zh ? `已保留 ${response.integration.conflictFiles.length} 个冲突文件，需继续处理。` : `${response.integration.conflictFiles.length} conflict file(s) need attention.`,
                },
              };
            }
            return {
              integration: response.integration,
              result: { workspaceId: workspace.id, repositoryName: label, status: 'succeeded', message: response.result ? deliveryFeedback(response.result, zh).text : zh ? '已准备合入结果。' : 'Merge result prepared.' },
            };
          } catch (reason) {
            return { result: { workspaceId: workspace.id, repositoryName: label, status: 'failed', message: errorMessage(reason, zh) } };
          }
        }),
      );
      const results = outcomes.map((outcome) => outcome.result);
      setBatchResults(results);
      const firstAttention = outcomes.find((outcome) => outcome.result.status === 'attention' && outcome.integration);
      await reload(firstAttention?.result.workspaceId ?? workspaceId);
      if (firstAttention?.integration) {
        setWorkspaceId(firstAttention.result.workspaceId);
        setIntegration(firstAttention.integration);
        setConflictPath(firstAttention.integration.conflictFiles[0] ?? '');
        setConflictWorkspaceOpen(firstAttention.integration.state === 'conflicted');
      }
      await props.onChanged?.();
      setFeedback(batchDeliveryFeedback('merge', results, zh));
    } finally {
      setBusyAction(null);
    }
  }

  async function saveResolution(): Promise<void> {
    if (!props.task || !props.client || !activeConflict || !conflictPath) return;
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

  async function startAiConflictSession(content: string, fingerprint: string, permissionMode: TaskIntegrationConflictPermissionMode): Promise<void> {
    if (!props.task || !props.client || !activeConflict || !conflictPath) throw new Error(zh ? '当前没有可处理的冲突。' : 'No conflict is available.');
    setBusyAction('ai');
    setError(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      if (props.executionReady === false) {
        if (!props.onQueueConflictAiStart) throw new Error(zh ? '当前操作暂时无法进入准备队列。' : 'This operation cannot be queued yet.');
        const cancel = props.onQueueConflictAiStart({ idempotencyKey, taskId: props.task.id, projectId: props.task.projectId, integrationId: activeConflict.id, path: conflictPath, content, fingerprint, permissionMode });
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
      const operation = await props.client.startTaskIntegrationConflictAi(props.task.id, activeConflict.id, conflictPath, content, fingerprint, permissionMode, idempotencyKey);
      await props.onOpenConversation(props.task.id, operation.conversationId);
      props.onClose();
    } catch (reason) {
      setError(errorMessage(reason, zh));
      throw reason;
    } finally {
      setBusyAction(null);
    }
  }

  async function finalize(): Promise<void> {
    if (!props.task || !props.client || !integration) return;
    if (selectedWorkspace && integration.targetBranch === selectedWorkspace.sourceBranch && selectedWorkspace.activeConversationCount > 0 && !confirmActiveSessionRisk(selectedWorkspace.activeConversationCount, zh)) return;
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

  async function rebuildStaleIntegration(workspace: TaskWorkspaceSnapshot, drafts: Record<string, ConflictDraft>): Promise<void> {
    if (!props.task || !props.client) return;
    conflictDraftsRef.current = drafts;
    const response = await props.client.startTaskIntegration(props.task.id, workspace.id, {
      targetBranch,
      mode,
      prepareOnly: Object.keys(drafts).length > 0,
    });
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
                  ? '来源分支已更新，合入候选已从最新本地提交重建；已有草稿会按冲突指纹逐项核对。'
                  : 'The source advanced. The candidate was rebuilt from the latest local commit, and saved drafts will be checked by conflict fingerprint.'
                : zh
                  ? '来源分支已更新，合入候选已自动从最新本地提交重建。'
                  : 'The source advanced. The candidate was automatically rebuilt from the latest local commit.',
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

  function toggleFileSelection(nextId: string, path: string, selected: boolean): void {
    setSelectedPathsByWorkspace((current) => {
      const currentPaths = current[nextId] ?? [];
      const nextPaths = selected ? Array.from(new Set([...currentPaths, path])) : currentPaths.filter((candidate) => candidate !== path);
      return { ...current, [nextId]: nextPaths };
    });
    if (selected) setSelectedWorkspaceIds((current) => Array.from(new Set([...current, nextId])));
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

  const integrationResult = deliveredIntegration ?? (selectedWorkspace?.state === 'merged' ? integrations.find((candidate) => candidate.workspaceId === selectedWorkspace.id && candidate.state === 'merged') : null);

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
    <ModalPortal rootClassName="task-git-merge-portal-root" backdropClassName="task-git-merge-backdrop" dismissDisabled={dismissDisabled} onDismiss={props.onClose}>
      <section className={`task-git-merge-modal task-git-delivery-modal${conflictWorkspaceOpen && activeConflict ? ' is-conflicted' : ''}`} role="dialog" aria-modal="true" aria-labelledby="task-git-merge-title">
        <header className="task-git-merge-header">
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
          {!standaloneWindow ? (
            <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={dismissDisabled}>
              ×
            </button>
          ) : null}
        </header>

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
            />
          ) : conflictReadyToFinalize && activeConflict ? (
            <ConflictCompletion zh={zh} targetBranch={activeConflict.targetBranch} taskBranch={selectedWorkspace?.branchName ?? ''} />
          ) : (
            <div className="task-git-delivery-content">
              <DeliveryScopeBar selectedRepositories={selectedWorkspaceIds.length} totalRepositories={workspaceIndex.items.length} selectedFiles={selectedCommitFileCount} zh={zh} />
              <div className="task-git-review-layout task-git-delivery-layout">
                <DeliveryRepositoryFileTree
                  groups={repositoryGroups}
                  integrations={integrations}
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
                  onToggleFile={toggleFileSelection}
                  onCopyBranch={copyBranchName}
                />

                <main className="task-git-review-main task-git-delivery-diff-main">
                  <section className="task-git-review-diff" aria-label={zh ? '差异对比' : 'Diff'}>
                    <span className="task-git-review-pane-title">
                      <strong>
                        {selectedWorkspace ? `${repositoryLabel(selectedWorkspace, zh)} / ${selectedFile || (zh ? '选择文件查看差异' : 'Select a file to view its diff')}` : zh ? '选择文件查看差异' : 'Select a file to view its diff'}
                      </strong>
                      {fileDiff?.fileDiffs[0] ? (
                        <small>
                          +{fileDiff.fileDiffs[0].addedLines} −{fileDiff.fileDiffs[0].deletedLines}
                        </small>
                      ) : null}
                    </span>
                    {diffLoading ? <p className="task-git-review-empty">{zh ? '正在读取差异…' : 'Loading diff…'}</p> : <SideBySideDiff diff={fileDiff?.fileDiffs[0] ?? null} hasSelection={Boolean(selectedFile)} zh={zh} />}
                  </section>
                </main>

                <aside className="task-git-review-options task-git-delivery-actions">
                  <span>
                    <strong>{zh ? `已选 ${selectedWorkspaceIds.length} 个仓库` : `${selectedWorkspaceIds.length} repositories selected`}</strong>
                    <small>{zh ? '文件决定提交范围，仓库决定合入与推送范围。' : 'Files scope commits; repositories scope merges and pushes.'}</small>
                  </span>
                  <dl>
                    <div>
                      <dt>{zh ? '来源分支' : 'Source'}</dt>
                      <dd>{selectedWorkspace?.sourceBranch ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '来源分支远端' : 'Source branch remote'}</dt>
                      <dd>
                        {!selectedWorkspace?.remoteName
                          ? zh
                            ? '纯本地模式'
                            : 'Local-only mode'
                          : selectedWorkspace.remoteRefreshError
                            ? zh
                              ? '远端信息暂不可用'
                              : 'Remote information unavailable'
                            : selectedWorkspace.sourceRemoteVerified
                              ? zh
                                ? '本机记录显示已推送'
                                : 'Locally recorded as pushed'
                              : zh
                                ? '合入后可选推送'
                                : 'Optional push after merge'}
                      </dd>
                    </div>
                  </dl>

                  {selectedWorkspace && selectedWorkspace.activeConversationCount > 0 ? (
                    <section className="task-git-review-active-sessions">
                      <strong>{zh ? '活动会话不阻止代码交付' : 'Active sessions do not block delivery'}</strong>
                      <small>
                        {zh
                          ? `系统检测到 ${selectedWorkspace.activeConversationCount} 个会话仍可能写入此分支。该状态只作提示，不参与提交或推送门禁；只有可能回收 worktree 的合入操作需要额外确认。`
                          : `The system detected ${selectedWorkspace.activeConversationCount} session(s) that may still write to this branch. This is informational only and never gates commit or push; only a merge that may reclaim the worktree asks for extra confirmation.`}
                      </small>
                    </section>
                  ) : null}

                  <section className={`task-git-delivery-action-step${selectedCommitFileCount === 0 ? ' is-complete' : ''}`}>
                    <strong>{zh ? '② 提交' : '② Commit'}</strong>
                    <small>
                      {selectedCommitFileCount === 0
                        ? zh
                          ? '当前没有勾选待提交文件。'
                          : 'No uncommitted files are selected.'
                        : zh
                          ? `将按仓库提交 ${selectedCommitFileCount} 个勾选文件。`
                          : `Commit ${selectedCommitFileCount} selected file(s), grouped by repository.`}
                    </small>
                    {selectedCommitFileCount > 0 ? <textarea value={message} onChange={(event) => setMessage(event.target.value)} disabled={busy} aria-label={zh ? '提交说明' : 'Commit message'} /> : null}
                    <Button variant="secondary" size="compact" busy={busyAction === 'commit'} onClick={() => void commitSelected()} disabled={busy || selectedCommitFileCount === 0}>
                      {zh ? `提交所选文件（${selectedCommitFileCount}）` : `Commit selected files (${selectedCommitFileCount})`}
                    </Button>
                  </section>

                  <section className="task-git-delivery-action-step">
                    <strong>{zh ? '③ 合入来源分支' : '③ Merge into source branch'}</strong>
                    <small>
                      {zh
                        ? `对 ${selectedMergeCandidateCount} 个已选仓库新建或继续本地合入；待同步和待确认现场也从这里继续。`
                        : `Start or continue local merges for ${selectedMergeCandidateCount} selected repositories, including pending sync and confirmation states.`}
                    </small>
                    <ZeusSelect
                      size="compact"
                      ariaLabel={zh ? '合入方式' : 'Merge method'}
                      value={mode}
                      options={[
                        { value: 'merge', label: zh ? 'Merge · 保留提交历史' : 'Merge · preserve commits' },
                        { value: 'squash', label: zh ? 'Squash · 合成一个提交' : 'Squash · one commit' },
                      ]}
                      onChange={setMode}
                      disabled={busy}
                      searchable={false}
                    />
                    <Button variant="primary" size="compact" busy={busyAction === 'merge'} onClick={() => void mergeSelected()} disabled={busy || selectedMergeCandidateCount === 0}>
                      {zh ? `合入所选仓库（${selectedMergeCandidateCount}）` : `Merge selected repositories (${selectedMergeCandidateCount})`}
                    </Button>
                    {activeConflict ? (
                      <>
                        <small className="task-git-delivery-local-pending">
                          {activeConflict.conflictFiles.length > 0
                            ? zh
                              ? `上次合入保留了 ${activeConflict.conflictFiles.length} 个冲突文件。可先查看其他分支，处理时再进入冲突编辑器。`
                              : `The previous merge preserved ${activeConflict.conflictFiles.length} conflicted file(s). You can review other branches before resuming.`
                            : zh
                              ? '上次合入的冲突已经处理完，正在等待确认完成。'
                              : 'The previous merge conflicts are resolved and waiting for final confirmation.'}
                        </small>
                        <Button variant="primary" size="compact" onClick={openConflictWorkspace} disabled={busy}>
                          {activeConflict.conflictFiles.length > 0 ? (zh ? '继续处理冲突' : 'Resume conflict resolution') : zh ? '确认完成合入' : 'Confirm merge completion'}
                        </Button>
                      </>
                    ) : null}
                    {pendingLocalSync ? (
                      <small className="task-git-delivery-local-pending">
                        {zh ? '合入结果已保留；来源分支存在未提交改动。处理原目录后，再点“合入所选仓库”继续。' : 'The integration result is preserved. Clean the source worktree, then use “Merge selected repositories” again.'}
                      </small>
                    ) : null}
                    {integrationResult?.localSyncStatus === 'pending' ? (
                      <small className="task-git-delivery-local-pending">
                        {zh
                          ? '来源分支工作区有未提交代码，合入结果已保留；处理后再点“合入所选仓库”继续。'
                          : 'The source worktree has uncommitted changes. The merge result is preserved; clean it, then use “Merge selected repositories” again.'}
                      </small>
                    ) : null}
                  </section>

                  <section className="task-git-delivery-action-step">
                    <strong>{zh ? '④ 推送来源分支（可选）' : '④ Push source branch (optional)'}</strong>
                    <small>
                      {zh
                        ? `对 ${selectedPushCandidateCount} 个已选、已合入且配置远端的仓库推送来源分支。失败不会撤销提交或合入。`
                        : `Push source branches for ${selectedPushCandidateCount} selected repositories that are merged and have remotes. Failures never roll back commits or merges.`}
                    </small>
                    <Button variant="secondary" size="compact" busy={busyAction === 'push'} onClick={() => void pushSelected()} disabled={busy || selectedPushCandidateCount === 0}>
                      {zh ? `推送所选仓库（${selectedPushCandidateCount}）` : `Push selected repositories (${selectedPushCandidateCount})`}
                    </Button>
                  </section>
                </aside>
              </div>
            </div>
          )}
        </div>

        <div className="task-git-merge-status" aria-live="polite">
          {batchResults.length > 0 ? <BatchDeliveryResults results={batchResults} zh={zh} /> : null}
          {feedback ? (
            <div className={`task-git-delivery-feedback is-${feedback.tone}`}>
              <span>{feedback.text}</span>
              {feedback.actionLabel && feedback.onAction ? (
                <button type="button" onClick={feedback.onAction}>
                  {feedback.actionLabel}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

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
                {zh ? '完成合入来源分支' : 'Finish merging into source branch'}
              </Button>
            )
          ) : null}
        </footer>
      </section>
    </ModalPortal>
  );
}

function InitialLoadState(props: { zh: boolean; error?: string | null; onRetry?: () => void }) {
  return (
    <section className="task-git-delivery-load-state" role="status">
      <strong>{props.error ? (props.zh ? '当前没有可显示的交付信息' : 'No delivery information is available') : props.zh ? '正在读取本机 Git 信息…' : 'Loading local Git information…'}</strong>
      <small>{props.zh ? '这里只读取本机分支、提交和工作区，不会连接远端仓库。' : 'This reads local branches, commits, and worktrees without contacting a remote repository.'}</small>
      {props.onRetry ? (
        <Button variant="secondary" size="compact" onClick={props.onRetry}>
          {props.zh ? '重新读取' : 'Retry'}
        </Button>
      ) : null}
    </section>
  );
}

function DeliveryScopeBar(props: { selectedRepositories: number; totalRepositories: number; selectedFiles: number; zh: boolean }) {
  return (
    <section className="task-git-delivery-scopebar" aria-label={props.zh ? '当前交付选择' : 'Current delivery selection'}>
      <strong>{props.zh ? '按文件审查，按仓库交付' : 'Review by file, deliver by repository'}</strong>
      <span>
        {props.zh
          ? `已选 ${props.selectedRepositories}/${props.totalRepositories} 个仓库 · ${props.selectedFiles} 个待提交文件`
          : `${props.selectedRepositories}/${props.totalRepositories} repositories · ${props.selectedFiles} uncommitted files selected`}
      </span>
    </section>
  );
}

function DeliveryRepositoryFileTree(props: {
  groups: DeliveryRepositoryGroup[];
  integrations: TaskIntegrationRecord[];
  detailStates: Record<string, 'loading' | 'error'>;
  diffScope: DiffScope;
  totalWorkingFiles: number;
  totalCommittedFiles: number;
  focusedWorkspaceId: string;
  selectedFile: string;
  selectedWorkspaceIds: Set<string>;
  selectedPathsByWorkspace: Record<string, string[]>;
  currentConversationWorkspaceId?: string | null;
  zh: boolean;
  disabled: boolean;
  onScopeChange: (scope: DiffScope) => void;
  onSelectFile: (workspaceId: string, path: string) => void;
  onToggleWorkspace: (workspaceId: string, selected: boolean) => void;
  onToggleBranch: (workspaceIds: string[], selected: boolean) => void;
  onToggleFile: (workspaceId: string, path: string, selected: boolean) => void;
  onCopyBranch: (branchName: string) => void | Promise<void>;
}) {
  const branchGroups = groupDeliveryRepositoriesByBranch(props.groups);
  return (
    <aside className="task-git-delivery-file-browser" aria-label={props.zh ? '按仓库分组的交付文件' : 'Delivery files grouped by repository'}>
      <header className="task-git-review-pane-title task-git-delivery-diff-tabs">
        <span>
          <button type="button" className={props.diffScope === 'working' ? 'is-active' : ''} onClick={() => props.onScopeChange('working')} disabled={props.disabled}>
            {props.zh ? '本机未提交' : 'Local uncommitted'} <small>{props.totalWorkingFiles}</small>
          </button>
          <button type="button" className={props.diffScope === 'committed' ? 'is-active' : ''} onClick={() => props.onScopeChange('committed')} disabled={props.disabled}>
            {props.zh ? '已提交成果' : 'Committed result'} <small>{props.totalCommittedFiles}</small>
          </button>
        </span>
      </header>
      <div className="task-git-delivery-file-tree">
        {branchGroups.map((branchGroup) => {
          const workspaceIds = branchGroup.repositories.map((group) => group.workspace.id);
          const selectedCount = workspaceIds.filter((workspaceId) => props.selectedWorkspaceIds.has(workspaceId)).length;
          const allSelected = workspaceIds.length > 0 && selectedCount === workspaceIds.length;
          const currentConversation = workspaceIds.includes(props.currentConversationWorkspaceId ?? '');
          return (
            <section key={branchGroup.branchName} className={`task-git-delivery-branch${currentConversation ? ' is-current-conversation' : ''}`}>
              <header>
                <label>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    aria-checked={selectedCount > 0 && !allSelected ? 'mixed' : allSelected}
                    onChange={(event) => props.onToggleBranch(workspaceIds, event.target.checked)}
                    disabled={props.disabled}
                  />
                  <strong>{branchGroup.branchName}</strong>
                </label>
                <span>
                  {currentConversation ? <small className="task-git-current-conversation-badge">{props.zh ? '当前会话' : 'Current session'}</small> : null}
                  <button type="button" onClick={() => void props.onCopyBranch(branchGroup.branchName)} disabled={props.disabled}>
                    {props.zh ? '复制' : 'Copy'}
                  </button>
                </span>
              </header>
              {branchGroup.repositories.map((group) => {
                const workspaceId = group.workspace.id;
                const workspaceSelected = props.selectedWorkspaceIds.has(workspaceId);
                const selectedPaths = new Set(props.selectedPathsByWorkspace[workspaceId] ?? []);
                return (
                  <section key={workspaceId} className={`task-git-delivery-repository${props.focusedWorkspaceId === workspaceId ? ' is-focused' : ''}`}>
                    <header>
                      <label>
                        <input type="checkbox" checked={workspaceSelected} onChange={(event) => props.onToggleWorkspace(workspaceId, event.target.checked)} disabled={props.disabled || group.workspace.state === 'discarded'} />
                        <span>
                          <strong>{repositoryLabel(group.workspace, props.zh)}</strong>
                          <small>{workspaceStateLabel(group.workspace, group.detail, props.detailStates[workspaceId], props.zh, findRecoverableIntegration(props.integrations, workspaceId))}</small>
                        </span>
                      </label>
                    </header>
                    {props.detailStates[workspaceId] === 'loading' ? <small className="task-git-delivery-repository-state">{props.zh ? '正在读取文件…' : 'Loading files…'}</small> : null}
                    {props.detailStates[workspaceId] === 'error' ? (
                      <small className="task-git-delivery-repository-state is-error">{props.zh ? '读取失败，其他仓库仍可继续。' : 'Load failed; other repositories remain available.'}</small>
                    ) : null}
                    {group.files.length > 0 ? (
                      <ol>
                        {group.files.map((file) => (
                          <li key={file.path} className={props.focusedWorkspaceId === workspaceId && props.selectedFile === file.path ? 'is-active' : ''}>
                            <div className="task-git-delivery-file-row">
                              {props.diffScope === 'working' ? (
                                <input
                                  type="checkbox"
                                  checked={selectedPaths.has(file.path)}
                                  onChange={(event) => props.onToggleFile(workspaceId, file.path, event.target.checked)}
                                  disabled={props.disabled || !workspaceSelected}
                                  aria-label={props.zh ? `选择文件 ${file.path}` : `Select file ${file.path}`}
                                />
                              ) : null}
                              <button type="button" onClick={() => props.onSelectFile(workspaceId, file.path)} disabled={props.disabled}>
                                <span>{file.path}</span>
                                <small>
                                  {file.label}
                                  {file.additions || file.deletions ? ` · +${file.additions} −${file.deletions}` : ''}
                                </small>
                              </button>
                            </div>
                          </li>
                        ))}
                      </ol>
                    ) : group.detail && !props.detailStates[workspaceId] ? (
                      <small className="task-git-delivery-repository-state">{props.diffScope === 'working' ? (props.zh ? '没有未提交文件' : 'No uncommitted files') : props.zh ? '没有已提交成果' : 'No committed result'}</small>
                    ) : null}
                  </section>
                );
              })}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function BatchDeliveryResults(props: { results: BatchDeliveryResult[]; zh: boolean }) {
  const succeeded = props.results.filter((result) => result.status === 'succeeded').length;
  const skipped = props.results.filter((result) => result.status === 'skipped').length;
  const attention = props.results.filter((result) => result.status === 'attention').length;
  const failed = props.results.filter((result) => result.status === 'failed').length;
  return (
    <section className="task-git-delivery-batch-result">
      <strong>{props.zh ? `逐仓结果：成功 ${succeeded}，跳过 ${skipped}，待处理 ${attention}，失败 ${failed}` : `Per-repository results: ${succeeded} succeeded, ${skipped} skipped, ${attention} need attention, ${failed} failed`}</strong>
      <ol>
        {props.results.map((result) => (
          <li key={result.workspaceId} data-status={result.status}>
            <span>{result.repositoryName}</span>
            <small>{result.message}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ConflictCompletion(props: { zh: boolean; targetBranch: string; taskBranch: string }) {
  return (
    <section className="task-git-conflict-completion" aria-label={props.zh ? '冲突收尾确认' : 'Conflict completion confirmation'}>
      <span aria-hidden="true">✓</span>
      <strong>{props.zh ? '冲突已全部处理' : 'All conflicts are resolved'}</strong>
      <p>
        {props.zh
          ? '合入结果已经准备好。确认后将生成合入提交，并同步到本地来源分支；远端推送仍由独立按钮按需执行。'
          : 'The merge result is ready. Confirm to create the merge commit and sync the local source branch. Remote push remains an optional separate action.'}
      </p>
      <dl>
        <div>
          <dt>{props.zh ? '来源分支' : 'Source branch'}</dt>
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

function initializeDeliverySelection(
  details: Record<string, TaskWorkspaceSnapshot>,
  workspaces: TaskWorkspaceIndexSnapshot[],
  setSelectedWorkspaceIds: Dispatch<SetStateAction<string[]>>,
  setSelectedPathsByWorkspace: Dispatch<SetStateAction<Record<string, string[]>>>,
): void {
  const selectedIds = workspaces.filter((workspace) => isDeliverableWorkspace(details[workspace.id])).map((workspace) => workspace.id);
  const selectedPaths = Object.fromEntries(selectedIds.map((workspaceId) => [workspaceId, collectWorkingFiles(details[workspaceId]).map((file) => file.path)]));
  setSelectedWorkspaceIds(selectedIds);
  setSelectedPathsByWorkspace(selectedPaths);
}

function preserveDeliverySelection(
  details: Record<string, TaskWorkspaceSnapshot>,
  workspaces: TaskWorkspaceIndexSnapshot[],
  initialized: boolean,
  setSelectedWorkspaceIds: Dispatch<SetStateAction<string[]>>,
  setSelectedPathsByWorkspace: Dispatch<SetStateAction<Record<string, string[]>>>,
): void {
  if (!initialized) {
    initializeDeliverySelection(details, workspaces, setSelectedWorkspaceIds, setSelectedPathsByWorkspace);
    return;
  }
  const availableIds = new Set(workspaces.map((workspace) => workspace.id));
  setSelectedWorkspaceIds((current) => current.filter((workspaceId) => availableIds.has(workspaceId) && isDeliverableWorkspace(details[workspaceId])));
  setSelectedPathsByWorkspace((current) => {
    const next: Record<string, string[]> = {};
    for (const workspace of workspaces) {
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

function groupDeliveryRepositoriesByBranch(groups: DeliveryRepositoryGroup[]): Array<{ branchName: string; repositories: DeliveryRepositoryGroup[] }> {
  const byBranch = new Map<string, DeliveryRepositoryGroup[]>();
  for (const group of groups) {
    const existing = byBranch.get(group.workspace.branchName);
    if (existing) existing.push(group);
    else byBranch.set(group.workspace.branchName, [group]);
  }
  return [...byBranch].map(([branchName, repositories]) => ({ branchName, repositories }));
}

function repositoryLabel(workspace: Pick<TaskWorkspaceIndexSnapshot, 'repositoryName' | 'repositoryRelativePath'>, zh: boolean): string {
  return workspace.repositoryName || workspace.repositoryRelativePath || (zh ? '项目仓库' : 'Project repository');
}

function findDeliveredIntegration(workspace: TaskWorkspaceSnapshot | undefined, integrations: TaskIntegrationRecord[]): TaskIntegrationRecord | null {
  if (!workspace) return null;
  const currentTaskHeadSha = workspace.branchComparison?.taskHeadSha ?? workspace.review?.headSha ?? workspace.headSha ?? null;
  const workspaceHeadMatchesCurrentBranch = Boolean(workspace.state === 'merged' && workspace.headSha && workspace.headSha === currentTaskHeadSha);
  return (
    integrations.find(
      (candidate) =>
        candidate.workspaceId === workspace.id &&
        candidate.targetBranch === workspace.sourceBranch &&
        candidate.state === 'merged' &&
        (candidate.taskHeadSha ? candidate.taskHeadSha === currentTaskHeadSha : workspaceHeadMatchesCurrentBranch),
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

function workspaceStateLabel(workspace: TaskWorkspaceIndexSnapshot, detail: TaskWorkspaceSnapshot | undefined, loadState: 'loading' | 'error' | undefined, zh: boolean, recovery?: TaskIntegrationRecord): string {
  const activeSuffix = workspace.activeConversationCount > 0 ? (zh ? ` · ${workspace.activeConversationCount} 个会话活动` : ` · ${workspace.activeConversationCount} active session(s)`) : '';
  if (recovery?.state === 'conflicted') {
    const status = recovery.conflictFiles.length > 0 ? (zh ? `${recovery.conflictFiles.length} 个冲突待处理` : `${recovery.conflictFiles.length} conflict(s) pending`) : zh ? '冲突已处理 · 待确认' : 'Conflicts resolved · confirm';
    return `${status}${activeSuffix}`;
  }
  if (recovery?.state === 'pending_local_sync') return `${zh ? '合入完成 · 待同步' : 'Merged · sync pending'}${activeSuffix}`;
  if (workspace.state === 'merged') {
    if (!workspace.remoteName) return `${zh ? '已合入 · 无远端' : 'Merged · no remote'}${activeSuffix}`;
    if (!detail) return `${zh ? '已合入 · 远端待读取' : 'Merged · remote not loaded'}${activeSuffix}`;
    return `${detail.sourceRemoteVerified ? (zh ? '已合入 · 已推送' : 'Merged · pushed') : zh ? '已合入 · 推送可选' : 'Merged · push optional'}${activeSuffix}`;
  }
  if (workspace.state === 'discarded') return zh ? '已放弃' : 'Discarded';
  if (loadState === 'loading') return `${zh ? '正在读取…' : 'Loading…'}${activeSuffix}`;
  if (loadState === 'error') return `${zh ? '读取失败' : 'Load failed'}${activeSuffix}`;
  if (!detail) return `${zh ? '尚未读取' : 'Not loaded'}${activeSuffix}`;
  const workingCount = collectWorkingFiles(detail).length;
  if (workingCount > 0) return `${zh ? `${workingCount} 个未提交文件` : `${workingCount} uncommitted file(s)`}${activeSuffix}`;
  return `${zh ? '已提交 · 可合入' : 'Committed · merge ready'}${activeSuffix}`;
}

function findRecoverableIntegration(integrations: TaskIntegrationRecord[], workspaceId?: string): TaskIntegrationRecord | undefined {
  if (!workspaceId) return undefined;
  return integrations.find((candidate) => candidate.workspaceId === workspaceId && (candidate.state === 'conflicted' || candidate.state === 'pending_local_sync'));
}

type MergeWorkspaceAction = { type: 'start' } | { type: 'resolve_conflict' | 'finalize'; integration: TaskIntegrationRecord };

function mergeWorkspaceAction(workspace: TaskWorkspaceSnapshot | undefined, integrations: TaskIntegrationRecord[]): MergeWorkspaceAction | null {
  if (!workspace || collectWorkingFiles(workspace).length > 0) return null;
  const recoverable = findRecoverableIntegration(integrations, workspace.id);
  if (recoverable) {
    if (recoverable.state === 'pending_local_sync' || recoverable.conflictFiles.length === 0) return { type: 'finalize', integration: recoverable };
    return { type: 'resolve_conflict', integration: recoverable };
  }
  if (!workspace.branchComparison || !workspace.sourceBranch || workspace.sourceBranch === workspace.branchName || findDeliveredIntegration(workspace, integrations)) return null;
  return { type: 'start' };
}

function confirmActiveSessionRisk(activeConversationCount: number, zh: boolean): boolean {
  return window.confirm(
    zh
      ? `当前仍有 ${activeConversationCount} 个活动会话可能写入此分支。合入来源分支成功后可能回收任务 worktree，后续写入可能失败或丢失工作区现场。确定继续吗？`
      : `${activeConversationCount} active conversation(s) may still write to this branch. Merging into the source branch may reclaim the task worktree, which can interrupt later writes or remove the worktree. Continue?`,
  );
}

function confirmBatchActiveSessionRisk(activeConversationCount: number, zh: boolean): boolean {
  return window.confirm(
    zh
      ? `已选仓库中仍有 ${activeConversationCount} 个活动会话可能继续写入。批量合入成功后可能回收对应 worktree，后续写入可能失败或丢失工作区现场。确定继续吗？`
      : `${activeConversationCount} active conversation(s) may still write to selected repositories. Successful merges may reclaim their worktrees and interrupt later writes. Continue?`,
  );
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

function SideBySideDiff(props: { diff: TaskGitFileDiff | null; hasSelection: boolean; zh: boolean }) {
  if (!props.diff)
    return (
      <p className="task-git-review-empty">{props.hasSelection ? (props.zh ? '该文件暂无可显示的文本差异。' : 'No text diff is available for this file.') : props.zh ? '请选择文件查看代码差异。' : 'Select a file to view its code diff.'}</p>
    );
  if (props.diff.hunks.length === 0)
    return <p className="task-git-review-empty">{props.zh ? '文件已经变化，但没有可显示的文本内容，可能是二进制文件或仅文件属性变化。' : 'The file changed, but no text content is available; it may be binary or metadata-only.'}</p>;
  const rows = props.diff.hunks.flatMap((hunk) => [
    {
      key: `${hunk.header}-header`,
      kind: 'header' as const,
      leftNumber: '',
      left: hunk.header,
      rightNumber: '',
      right: hunk.header,
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
        text: zh ? '合入结果已保存在隔离工作区；来源分支有未提交改动，处理后请重新同步。' : 'The integration result is preserved because the source branch has uncommitted changes. Clean it, then retry sync.',
      }
    : {
        tone: 'success',
        text: zh ? `已合入来源分支 ${result.targetBranch} · ${shortSha(result.resultHeadSha)}` : `Merged into source branch ${result.targetBranch} · ${shortSha(result.resultHeadSha)}`,
      };
}

function batchDeliveryFeedback(action: 'commit' | 'merge' | 'push', results: BatchDeliveryResult[], zh: boolean): DeliveryFeedback {
  const succeeded = results.filter((result) => result.status === 'succeeded').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const attention = results.filter((result) => result.status === 'attention').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const actionLabel = zh ? { commit: '提交', merge: '合入', push: '推送' }[action] : { commit: 'Commit', merge: 'Merge', push: 'Push' }[action];
  return {
    tone: failed > 0 || attention > 0 ? 'warning' : 'success',
    text: zh
      ? `${actionLabel}完成：成功 ${succeeded}，跳过 ${skipped}，待处理 ${attention}，失败 ${failed}。各仓库结果彼此独立。`
      : `${actionLabel} finished: ${succeeded} succeeded, ${skipped} skipped, ${attention} need attention, ${failed} failed. Repository results are independent.`,
  };
}

function shortSha(value: string): string {
  return value.slice(0, 8);
}

function isTargetHeadChanged(error: unknown): boolean {
  return error instanceof ZeusApiError && error.error === 'ZEUS_TARGET_HEAD_CHANGED';
}

function errorMessage(error: unknown, zh: boolean): string {
  if (zh && error instanceof ZeusApiError) {
    const localizedMessages: Record<string, string> = {
      ZEUS_TASK_WORKSPACE_NOT_FOUND: '当前任务工作区已不存在，请关闭后重新打开该任务的代码交付。',
      ZEUS_TASK_WORKSPACE_CONFLICTED: '任务工作区存在未解决冲突，请先完成冲突处理。',
      ZEUS_TASK_WORKSPACE_DIRTY: '任务分支还有未提交代码，请先完成提交再合入。',
      ZEUS_TASK_WORKTREE_UNAVAILABLE: '任务 worktree 当前不可用，不能执行提交或任务分支推送。',
      ZEUS_TARGET_BRANCH_UNAVAILABLE: '来源分支当前不可用，请确认本地分支状态。',
      ZEUS_TARGET_HEAD_CHANGED: '来源分支在合入期间发生变化，正在从最新本地提交安全重建。',
      ZEUS_TASK_HEAD_CHANGED: '任务分支在合入候选创建后发生变化，请确认后重新合入。',
      ZEUS_TASK_REMOTE_DIVERGED: '远端来源分支包含本地没有的提交，已停止普通推送；请先人工处理分支差异。',
      ZEUS_GIT_REMOTE_REFRESH_FAILED: '推送前刷新远端失败；本地提交和合入结果不受影响，请检查网络或仓库凭据。',
      ZEUS_TASK_REMOTE_VERIFICATION_FAILED: '远端提交校验失败，请检查网络和远端分支状态后重试。',
      ZEUS_GIT_COMMAND_FAILED: 'Git 操作失败，请检查分支和远端状态后重试。',
    };
    if (error.error && localizedMessages[error.error]) return localizedMessages[error.error];
  }
  return error instanceof Error ? error.message : String(error);
}
