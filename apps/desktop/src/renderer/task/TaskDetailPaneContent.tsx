import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { isTaskPriority, type TaskAttachmentReference } from '@zeus/shared';
import { ZeusApiError, type TaskEventRecord, type TaskManagementStatus, type TaskPriority, type TaskRecord, type UpdateTaskRelationshipsRequest, type UpdateTaskRequest } from '../apiClient.js';
import type { TaskEventRecord, TaskManagementStatus, TaskPriority, TaskRecord, TaskType, UpdateTaskRequest } from '../apiClient.js';
import type { NativeConversationChoice } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { TaskAttachmentPreviewList } from './TaskAttachmentPreviewList.js';
import { mergeTaskAttachments, parseTaskAttachments, toPersistedTaskAttachment, type TaskAttachmentView } from './taskAttachments.js';
import { formatTaskSource, formatTaskType, formatTaskUpdatedAt, resolveTaskManagementStatus, taskManagementStatuses, taskTypes, type TaskSourceLabels } from './taskWorkspaceModel.js';

export interface TaskDetailPaneCopy {
  requestTitle: string;
  noRequest: string;
  eventsTitle: string;
  noEvents: string;
  pushNewConversation: string;
  conversationsTitle: string;
  conversationEmptyTitle: string;
  conversationEmptyHelp: string;
  conversationLoading: string;
  conversationError: string;
  openConversation: string;
  retryConversationLoad: string;
  detailStatusSelectAria: string;
  primaryActionsTitle: string;
  metadataTitle: string;
  taskCodeLabel?: string;
  priorityLabel?: string;
  sourceLabel?: string;
  updatedAtLabel?: string;
  latestEvidenceLabel?: string;
  noEvidence?: string;
  attachmentsTitle?: string;
  imageAttachmentLabel?: string;
  fileAttachmentLabel?: string;
  openFileAttachmentLabel?: string;
  previewAttachmentLabel?: string;
  previewCloseLabel?: string;
  previewUnavailableLabel?: string;
  localPathLabel?: string;
  sourceLabels?: TaskSourceLabels;
  updatedAtMissing?: string;
}

export interface TaskDetailPaneContentProps {
  language: 'zh-CN' | 'en-US';
  task: TaskRecord;
  allTasks: TaskRecord[];
  events: TaskEventRecord[];
  copy: TaskDetailPaneCopy;
  statusLabels: Record<TaskManagementStatus | '', string>;
  priorityOptions: ReadonlyArray<{ value: TaskPriority; label: string }>;
  busy: boolean;
  conversations?: NativeConversationChoice[];
  conversationsLoading?: boolean;
  conversationsError?: string | null;
  modelPushOperation?: { status: 'submitting' | 'failed' | 'accepted'; error: string | null; conversationId?: string };
  onOpenConversation: (taskId: string, conversationId: string) => void;
  onPushNewConversation: (taskId: string) => void;
  onRetryModelPush?: (taskId: string) => void;
  onOpenCodeDelivery?: (taskId: string) => void;
  onCommitCode?: (taskId: string) => void;
  onPushCode?: (taskId: string) => void;
  onUpdateTaskContent: (taskId: string, input: UpdateTaskRequest) => Promise<TaskEditResult>;
  onUpdateRelationships: (taskId: string, input: UpdateTaskRelationshipsRequest) => Promise<TaskEditResult>;
  onCreateChild: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onManagementStatusChange: (taskId: string, status: TaskManagementStatus, expectedUpdatedAt: string) => Promise<TaskEditResult | undefined>;
  onChooseAttachments?: () => Promise<TaskAttachmentView[]>;
  onReloadConversations?: (taskId: string) => void;
  onLoadAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
}

export type TaskEditResult = { kind: 'updated'; task: TaskRecord } | { kind: 'conflict'; latest: TaskRecord };

type TaskFieldSaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string } | { kind: 'conflict'; latest: TaskRecord };

type TaskEditCopy = {
  editTitle: string;
  editDescription: string;
  editTags: string;
  titleRequired: string;
  noTags: string;
  addAttachment: string;
  removeAttachment: string;
  undoAttachment: string;
  retry: string;
  loadLatest: string;
  saveFailed: string;
  conflict: string;
};

type TaskTypedContentField = {
  key: string;
  label: string;
  value: string;
  buildPatch: (value: string) => Omit<UpdateTaskRequest, 'expectedUpdatedAt'>;
  valueFromTask: (task: TaskRecord) => string;
};

const taskEditCopies: Record<'zh-CN' | 'en-US', TaskEditCopy> = {
  'zh-CN': {
    editTitle: '编辑任务标题',
    editDescription: '编辑任务说明',
    editTags: '编辑任务标签',
    titleRequired: '标题不能为空。',
    noTags: '暂无标签，点击添加',
    addAttachment: '添加附件',
    removeAttachment: '移除附件关联',
    undoAttachment: '撤销移除',
    retry: '重试',
    loadLatest: '载入最新值',
    saveFailed: '保存失败',
    conflict: '任务已在其他位置更新。请选择保留本地内容重试，或载入最新值。',
  },
  'en-US': {
    editTitle: 'Edit task title',
    editDescription: 'Edit task description',
    editTags: 'Edit task tags',
    titleRequired: 'Title cannot be empty.',
    noTags: 'No tags. Click to add',
    addAttachment: 'Add attachment',
    removeAttachment: 'Remove attachment link',
    undoAttachment: 'Undo removal',
    retry: 'Retry',
    loadLatest: 'Load latest value',
    saveFailed: 'Save failed',
    conflict: 'This task changed elsewhere. Retry with the local value or load the latest value.',
  },
};

function taskEditErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function normalizeTaskTagsInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,，\n]+/u)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

function taskTagsDraft(tags: string[] | undefined): string {
  return (tags ?? []).join(', ');
}

function TaskEditFeedback(props: { state: TaskFieldSaveState; copy: TaskEditCopy; statusId: string; onRetry?: () => void; onLoadLatest?: () => void }) {
  if (props.state.kind !== 'error' && props.state.kind !== 'conflict') return null;
  const message = props.state.kind === 'conflict' ? props.copy.conflict : `${props.copy.saveFailed}：${props.state.message}`;
  return (
    <span className="task-inline-edit-feedback is-error">
      <small id={props.statusId} role="status" aria-live="polite">
        {message}
      </small>
      {props.state.kind === 'error' && props.onRetry ? (
        <Button variant="secondary" size="compact" onClick={props.onRetry}>
          {props.copy.retry}
        </Button>
      ) : null}
      {props.state.kind === 'conflict' ? (
        <span className="task-inline-edit-conflict-actions">
          {props.onRetry ? (
            <Button variant="secondary" size="compact" onClick={props.onRetry}>
              {props.copy.retry}
            </Button>
          ) : null}
          {props.onLoadLatest ? (
            <Button variant="secondary" size="compact" onClick={props.onLoadLatest}>
              {props.copy.loadLatest}
            </Button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

function TaskSaveSpinner() {
  return <span className="task-save-spinner" aria-hidden="true" />;
}

function InlineTaskTextField(props: {
  task: TaskRecord;
  label: string;
  value: string;
  display: ReactNode;
  multiline?: boolean;
  enterSeparates?: boolean;
  required?: boolean;
  copy: TaskEditCopy;
  className?: string;
  disabled?: boolean;
  buildPatch: (value: string) => Omit<UpdateTaskRequest, 'expectedUpdatedAt'>;
  valueFromTask: (task: TaskRecord) => string;
  onSave: (input: UpdateTaskRequest) => Promise<TaskEditResult>;
}) {
  const statusId = `${useId()}-status`;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const baseUpdatedAtRef = useRef(props.task.updatedAt ?? '');
  const composingRef = useRef(false);
  const suppressBlurRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);
  const [saveState, setSaveState] = useState<TaskFieldSaveState>({ kind: 'idle' });

  useEffect(() => {
    if (editing) return;
    setDraft(props.value);
    baseUpdatedAtRef.current = props.task.updatedAt ?? '';
  }, [editing, props.task.id, props.task.updatedAt, props.value]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    if (inputRef.current instanceof HTMLInputElement) inputRef.current.select();
  }, [editing]);

  function beginEditing(): void {
    if (props.disabled) return;
    setDraft(props.value);
    baseUpdatedAtRef.current = props.task.updatedAt ?? '';
    setSaveState({ kind: 'idle' });
    setEditing(true);
  }

  function cancelEditing(): void {
    suppressBlurRef.current = true;
    setDraft(props.value);
    setSaveState({ kind: 'idle' });
    setEditing(false);
  }

  async function commitDraft(expectedUpdatedAt = baseUpdatedAtRef.current): Promise<void> {
    if (saveState.kind === 'saving') return;
    const nextValue = props.required ? draft.trim() : draft;
    if (props.required && !nextValue) {
      setSaveState({ kind: 'error', message: props.copy.titleRequired });
      return;
    }
    if (nextValue === props.value) {
      setSaveState({ kind: 'idle' });
      setEditing(false);
      return;
    }
    if (!expectedUpdatedAt) {
      setSaveState({ kind: 'error', message: props.copy.saveFailed });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const result = await props.onSave({ ...props.buildPatch(nextValue), expectedUpdatedAt });
      if (result.kind === 'conflict') {
        setSaveState({ kind: 'conflict', latest: result.latest });
        return;
      }
      setDraft(props.valueFromTask(result.task));
      baseUpdatedAtRef.current = result.task.updatedAt ?? expectedUpdatedAt;
      setSaveState({ kind: 'saved' });
      setEditing(false);
    } catch (error) {
      setSaveState({ kind: 'error', message: taskEditErrorMessage(error, props.copy.saveFailed) });
    }
  }

  function handleBlur(): void {
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    void commitDraft();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEditing();
      return;
    }
    if (event.key === 'Enter' && props.enterSeparates && !composingRef.current && !event.nativeEvent.isComposing) {
      event.preventDefault();
      setDraft((current) => {
        const trimmed = current.trimEnd();
        return trimmed ? `${trimmed.replace(/[,，]$/u, '')}, ` : current;
      });
      return;
    }
    if (!props.multiline && event.key === 'Enter' && !composingRef.current && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  function retrySave(): void {
    suppressBlurRef.current = false;
    const expectedUpdatedAt = saveState.kind === 'conflict' ? (saveState.latest.updatedAt ?? '') : baseUpdatedAtRef.current;
    void commitDraft(expectedUpdatedAt);
  }

  function loadLatestValue(): void {
    if (saveState.kind !== 'conflict') return;
    setDraft(props.valueFromTask(saveState.latest));
    baseUpdatedAtRef.current = saveState.latest.updatedAt ?? '';
    setSaveState({ kind: 'idle' });
    setEditing(false);
  }

  const editorProps = {
    'aria-label': props.label,
    'aria-describedby': saveState.kind === 'error' || saveState.kind === 'conflict' ? statusId : undefined,
    'aria-busy': saveState.kind === 'saving' || undefined,
    'aria-invalid': saveState.kind === 'error' || saveState.kind === 'conflict' ? true : undefined,
    className: 'task-inline-edit-control',
    disabled: props.disabled || saveState.kind === 'saving',
    value: draft,
    onBlur: handleBlur,
    onChange: (event: { currentTarget: { value: string } }) => setDraft(event.currentTarget.value),
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: () => {
      composingRef.current = false;
    },
    onKeyDown: handleKeyDown,
  };

  return (
    <span className={['task-inline-edit', props.className].filter(Boolean).join(' ')} data-state={saveState.kind}>
      {editing ? (
        <span className="task-inline-edit-control-shell" aria-busy={saveState.kind === 'saving' || undefined}>
          {props.multiline ? (
            <textarea
              {...editorProps}
              ref={(node) => {
                inputRef.current = node;
              }}
              rows={4}
            />
          ) : (
            <input
              {...editorProps}
              ref={(node) => {
                inputRef.current = node;
              }}
            />
          )}
          {saveState.kind === 'saving' ? <TaskSaveSpinner /> : null}
        </span>
      ) : (
        <button type="button" className="task-inline-edit-trigger" onClick={beginEditing} disabled={props.disabled} aria-label={props.label}>
          {props.display}
        </button>
      )}
      <TaskEditFeedback state={saveState} copy={props.copy} statusId={statusId} onRetry={retrySave} onLoadLatest={loadLatestValue} />
    </span>
  );
}

function TaskImmediateSelect<T extends string>(props: {
  task: TaskRecord;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  ariaLabel: string;
  copy: TaskEditCopy;
  disabled?: boolean;
  className?: string;
  onSave: (value: T, expectedUpdatedAt: string) => Promise<TaskEditResult | undefined>;
}) {
  const statusId = `${useId()}-status`;
  const desiredValueRef = useRef<T | null>(null);
  const [displayValue, setDisplayValue] = useState(props.value);
  const [saveState, setSaveState] = useState<TaskFieldSaveState>({ kind: 'idle' });

  useEffect(() => {
    if (saveState.kind === 'saving' || saveState.kind === 'error' || saveState.kind === 'conflict') return;
    setDisplayValue(props.value);
  }, [props.value, saveState.kind]);

  async function saveValue(value: T, expectedUpdatedAt: string): Promise<void> {
    desiredValueRef.current = value;
    setDisplayValue(value);
    setSaveState({ kind: 'saving' });
    try {
      const result = await props.onSave(value, expectedUpdatedAt);
      if (!result) {
        desiredValueRef.current = null;
        setDisplayValue(props.value);
        setSaveState({ kind: 'idle' });
        return;
      }
      if (result.kind === 'conflict') {
        setSaveState({ kind: 'conflict', latest: result.latest });
        return;
      }
      desiredValueRef.current = null;
      setSaveState({ kind: 'saved' });
    } catch (error) {
      setSaveState({ kind: 'error', message: taskEditErrorMessage(error, props.copy.saveFailed) });
    }
  }

  function retrySave(): void {
    const desiredValue = desiredValueRef.current;
    if (!desiredValue) return;
    const expectedUpdatedAt = saveState.kind === 'conflict' ? (saveState.latest.updatedAt ?? '') : (props.task.updatedAt ?? '');
    if (!expectedUpdatedAt) return;
    void saveValue(desiredValue, expectedUpdatedAt);
  }

  function loadLatestValue(): void {
    desiredValueRef.current = null;
    setDisplayValue(props.value);
    setSaveState({ kind: 'idle' });
  }

  return (
    <span
      className={['task-immediate-select', saveState.kind === 'saving' ? 'is-saving' : '', props.className].filter(Boolean).join(' ')}
      aria-busy={saveState.kind === 'saving' || undefined}
      aria-describedby={saveState.kind === 'error' || saveState.kind === 'conflict' ? statusId : undefined}
    >
      <ZeusSelect
        size="compact"
        ariaLabel={props.ariaLabel}
        value={displayValue}
        options={props.options}
        onChange={(value) => {
          const expectedUpdatedAt = props.task.updatedAt ?? '';
          if (value === props.value) return;
          if (!expectedUpdatedAt) {
            desiredValueRef.current = value;
            setDisplayValue(value);
            setSaveState({ kind: 'error', message: props.copy.saveFailed });
            return;
          }
          void saveValue(value, expectedUpdatedAt);
        }}
        disabled={props.disabled || saveState.kind === 'saving'}
        searchable={false}
      />
      {saveState.kind === 'saving' ? <TaskSaveSpinner /> : null}
      <TaskEditFeedback state={saveState} copy={props.copy} statusId={statusId} onRetry={retrySave} onLoadLatest={loadLatestValue} />
    </span>
  );
}

export function TaskDetailPaneContent(props: TaskDetailPaneContentProps) {
  const zh = props.language === 'zh-CN';
  const editCopy = taskEditCopies[props.language];
  const managementStatus = resolveTaskManagementStatus(props.task);
  const taskIdentity = props.task.taskCode?.trim() || props.task.id;
  const latestEvent = props.events.at(-1);
  const taskAttachments = parseTaskAttachments(props.task.sourceContextJson);
  const modelPushCreating = props.modelPushOperation?.status === 'submitting';
  const modelPushFailed = props.modelPushOperation?.status === 'failed';
  const attachmentStatusId = `${useId()}-status`;
  const desiredAttachmentsRef = useRef<TaskAttachmentReference[]>([]);
  const undoTimerRef = useRef<number | null>(null);
  const [attachmentSaveState, setAttachmentSaveState] = useState<TaskFieldSaveState>({ kind: 'idle' });
  const [undoAttachment, setUndoAttachment] = useState<TaskAttachmentView | null>(null);
  const [relationshipSaveState, setRelationshipSaveState] = useState<TaskFieldSaveState>({ kind: 'idle' });
  const [relatedTaskCandidateId, setRelatedTaskCandidateId] = useState('');
  useEffect(() => {
    setAttachmentSaveState({ kind: 'idle' });
    setUndoAttachment(null);
    setRelationshipSaveState({ kind: 'idle' });
    setRelatedTaskCandidateId('');
    desiredAttachmentsRef.current = [];
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
  }, [props.task.id]);
  useEffect(
    () => () => {
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    },
    [],
  );
  const conversations = [...(props.conversations ?? [])].filter((conversation) => !conversation.archived).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const taskWorkspaces = Array.from(
    new Map(
      conversations
        .map((conversation) => conversation.workspace)
        .filter((workspace): workspace is NonNullable<NativeConversationChoice['workspace']> => Boolean(workspace))
        .map((workspace) => [workspace.id, workspace]),
    ).values(),
  );
  const hasWritableTaskWorkspace = taskWorkspaces.some((workspace) => (workspace.state === 'ready' || workspace.state === 'failed') && Boolean(workspace.worktreePath));
  const taskById = new Map(props.allTasks.map((task) => [task.id, task]));
  const directChildren = props.allTasks.filter((task) => task.parentTaskId === props.task.id).sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
  const relatedTasks = (props.task.relatedTaskIds ?? [])
    .map((taskId) => taskById.get(taskId))
    .filter((task): task is TaskRecord => Boolean(task))
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
  const relatedCandidateTasks = props.allTasks.filter((task) => task.id !== props.task.id && !(props.task.relatedTaskIds ?? []).includes(task.id));
  const currentBranchTaskIds = new Set<string>([props.task.id]);
  let branchChanged = true;
  while (branchChanged) {
    branchChanged = false;
    for (const task of props.allTasks) {
      if (task.parentTaskId && currentBranchTaskIds.has(task.parentTaskId) && !currentBranchTaskIds.has(task.id)) {
        currentBranchTaskIds.add(task.id);
        branchChanged = true;
      }
    }
  }
  function hierarchyDepth(task: TaskRecord): number {
    let depth = 1;
    let parentTaskId = task.parentTaskId ?? null;
    const visited = new Set<string>();
    while (parentTaskId && !visited.has(parentTaskId)) {
      visited.add(parentTaskId);
      depth += 1;
      parentTaskId = taskById.get(parentTaskId)?.parentTaskId ?? null;
    }
    return depth;
  }
  function subtreeHeight(taskId: string): number {
    const children = props.allTasks.filter((task) => task.parentTaskId === taskId);
    return children.length === 0 ? 1 : 1 + Math.max(...children.map((task) => subtreeHeight(task.id)));
  }
  const currentSubtreeHeight = subtreeHeight(props.task.id);
  const validParentTasks = props.allTasks.filter((task) => !currentBranchTaskIds.has(task.id) && hierarchyDepth(task) + currentSubtreeHeight <= 3);
  let currentTaskDepth = 1;
  let currentParentTaskId = props.task.parentTaskId ?? null;
  const visitedParentTaskIds = new Set<string>();
  while (currentParentTaskId && !visitedParentTaskIds.has(currentParentTaskId)) {
    visitedParentTaskIds.add(currentParentTaskId);
    currentTaskDepth += 1;
    currentParentTaskId = taskById.get(currentParentTaskId)?.parentTaskId ?? null;
  }

  async function saveRelationships(input: Omit<UpdateTaskRelationshipsRequest, 'expectedUpdatedAt'>): Promise<void> {
    const expectedUpdatedAt = props.task.updatedAt ?? '';
    if (!expectedUpdatedAt) {
      setRelationshipSaveState({ kind: 'error', message: editCopy.saveFailed });
      return;
    }
    setRelationshipSaveState({ kind: 'saving' });
    try {
      const result = await props.onUpdateRelationships(props.task.id, { ...input, expectedUpdatedAt });
      setRelationshipSaveState(result.kind === 'conflict' ? { kind: 'conflict', latest: result.latest } : { kind: 'saved' });
      if (result.kind === 'updated') setRelatedTaskCandidateId('');
    } catch (error) {
      const relationshipMessage =
        error instanceof ZeusApiError && error.error === 'ZEUS_TASK_HIERARCHY_DEPTH_EXCEEDED'
          ? zh
            ? '调整后会超过三级任务层级，无法保存。请先调整当前任务下面的结构，或选择更高层级的父任务。'
            : 'This change would exceed the three-level task hierarchy and cannot be saved.'
          : error instanceof ZeusApiError && error.error === 'ZEUS_TASK_PARENT_CYCLE'
            ? zh
              ? '不能把当前任务移动到它自己下面。'
              : 'A task cannot be moved below itself.'
            : taskEditErrorMessage(error, editCopy.saveFailed);
      setRelationshipSaveState({ kind: 'error', message: relationshipMessage });
    }
  }

  async function saveAttachmentReferences(attachments: TaskAttachmentReference[], expectedUpdatedAt: string): Promise<TaskEditResult | null> {
    if (!expectedUpdatedAt) {
      setAttachmentSaveState({ kind: 'error', message: editCopy.saveFailed });
      return null;
    }
    desiredAttachmentsRef.current = attachments;
    setAttachmentSaveState({ kind: 'saving' });
    try {
      const result = await props.onUpdateTaskContent(props.task.id, { expectedUpdatedAt, attachments });
      if (result.kind === 'conflict') {
        setAttachmentSaveState({ kind: 'conflict', latest: result.latest });
        return result;
      }
      setAttachmentSaveState({ kind: 'saved' });
      return result;
    } catch (error) {
      setAttachmentSaveState({ kind: 'error', message: taskEditErrorMessage(error, editCopy.saveFailed) });
      return null;
    }
  }

  async function chooseAttachments(): Promise<void> {
    if (!props.onChooseAttachments) return;
    try {
      const additions = await props.onChooseAttachments();
      if (additions.length === 0) return;
      const nextAttachments = mergeTaskAttachments(taskAttachments, additions);
      await saveAttachmentReferences(nextAttachments, props.task.updatedAt ?? '');
    } catch (error) {
      setAttachmentSaveState({ kind: 'error', message: taskEditErrorMessage(error, editCopy.saveFailed) });
    }
  }

  async function removeAttachment(path: string): Promise<void> {
    const removed = taskAttachments.find((attachment) => attachment.path === path);
    if (!removed) return;
    const nextAttachments = taskAttachments.filter((attachment) => attachment.path !== path).map(toPersistedTaskAttachment);
    const result = await saveAttachmentReferences(nextAttachments, props.task.updatedAt ?? '');
    if (result?.kind !== 'updated') return;
    setUndoAttachment(removed);
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = window.setTimeout(() => setUndoAttachment(null), 8000);
  }

  async function restoreRemovedAttachment(): Promise<void> {
    if (!undoAttachment) return;
    const nextAttachments = mergeTaskAttachments(taskAttachments, [undoAttachment]);
    const result = await saveAttachmentReferences(nextAttachments, props.task.updatedAt ?? '');
    if (result?.kind !== 'updated') return;
    setUndoAttachment(null);
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
  }

  function retryAttachmentSave(): void {
    const expectedUpdatedAt = attachmentSaveState.kind === 'conflict' ? (attachmentSaveState.latest.updatedAt ?? '') : (props.task.updatedAt ?? '');
    void saveAttachmentReferences(desiredAttachmentsRef.current, expectedUpdatedAt);
  }

  function loadLatestAttachments(): void {
    desiredAttachmentsRef.current = [];
    setAttachmentSaveState({ kind: 'idle' });
  }

  const taskPriority = props.task.priority ?? 'p3';
  const priorityOptions: ReadonlyArray<{ value: string; label: string; disabled?: boolean }> = isTaskPriority(taskPriority)
    ? props.priorityOptions
    : [{ value: taskPriority, label: `${taskPriority.toUpperCase()} (${zh ? '历史值' : 'legacy'})`, disabled: true }, ...props.priorityOptions];
  const taskTypeOptions: ReadonlyArray<{ value: TaskType; label: string }> = taskTypes.map((taskType) => ({ value: taskType, label: formatTaskType(taskType, props.language) }));
  const typedContentFields: TaskTypedContentField[] =
    props.task.taskType === 'defect'
      ? [
          {
            key: 'defect-current-state',
            label: zh ? '现状' : 'Current state',
            value: props.task.defectCurrentState ?? '',
            buildPatch: (defectCurrentState) => ({ defectCurrentState }),
            valueFromTask: (task) => task.defectCurrentState ?? '',
          },
          {
            key: 'defect-expected-outcome',
            label: zh ? '预期' : 'Expected outcome',
            value: props.task.defectExpectedOutcome ?? '',
            buildPatch: (defectExpectedOutcome) => ({ defectExpectedOutcome }),
            valueFromTask: (task) => task.defectExpectedOutcome ?? '',
          },
          {
            key: 'defect-reproduction-steps',
            label: zh ? '复现步骤' : 'Reproduction steps',
            value: props.task.defectReproductionSteps ?? '',
            buildPatch: (defectReproductionSteps) => ({ defectReproductionSteps }),
            valueFromTask: (task) => task.defectReproductionSteps ?? '',
          },
        ]
      : props.task.taskType === 'optimization'
        ? [
            {
              key: 'optimization-current-state',
              label: zh ? '现状' : 'Current state',
              value: props.task.optimizationCurrentState ?? '',
              buildPatch: (optimizationCurrentState) => ({ optimizationCurrentState }),
              valueFromTask: (task) => task.optimizationCurrentState ?? '',
            },
            {
              key: 'optimization-expected-outcome',
              label: zh ? '预期' : 'Expected outcome',
              value: props.task.optimizationExpectedOutcome ?? '',
              buildPatch: (optimizationExpectedOutcome) => ({ optimizationExpectedOutcome }),
              valueFromTask: (task) => task.optimizationExpectedOutcome ?? '',
            },
          ]
        : [
            {
              key: 'requirement-description',
              label: zh ? '需求描述' : 'Requirement description',
              value: props.task.description ?? '',
              buildPatch: (description) => ({ description }),
              valueFromTask: (task) => task.description ?? '',
            },
          ];

  return (
    <section className="product-drawer-pane task-detail-pane-content task-detail-pane-shell" aria-label={props.task.title}>
      <header className="task-detail-pane-header task-detail-summary-row">
        <span className="task-detail-pane-title">
          <small>
            {props.copy.taskCodeLabel ?? '任务编码'} {taskIdentity}
          </small>
          <InlineTaskTextField
            task={props.task}
            label={editCopy.editTitle}
            value={props.task.title}
            display={<strong>{props.task.title}</strong>}
            required
            copy={editCopy}
            disabled={props.busy}
            buildPatch={(title) => ({ title: title.trim() })}
            valueFromTask={(task) => task.title}
            onSave={(input) => props.onUpdateTaskContent(props.task.id, input)}
          />
        </span>
        <span className="task-detail-pane-status-control">
          <TaskImmediateSelect
            task={props.task}
            value={managementStatus}
            options={taskManagementStatuses.map((status) => ({
              value: status,
              label: props.statusLabels[status],
            }))}
            ariaLabel={props.copy.detailStatusSelectAria}
            copy={editCopy}
            disabled={props.busy}
            onSave={(status, expectedUpdatedAt) => props.onManagementStatusChange(props.task.id, status, expectedUpdatedAt)}
          />
        </span>
      </header>

      <section className="task-detail-summary-grid task-detail-task-facts" aria-label={props.copy.metadataTitle}>
        <span className="task-detail-summary-row">
          <small>{zh ? '类型' : 'Type'}</small>
          <TaskImmediateSelect
            task={props.task}
            value={props.task.taskType}
            options={taskTypeOptions}
            ariaLabel={zh ? '修改任务类型' : 'Change task type'}
            copy={editCopy}
            disabled={props.busy}
            onSave={(taskType, expectedUpdatedAt) => props.onUpdateTaskContent(props.task.id, { expectedUpdatedAt, taskType })}
          />
        </span>
        <span className="task-detail-summary-row">
          <small>{props.copy.sourceLabel ?? '上下文来源'}</small>
          <strong>{formatTaskSource(props.task, props.copy.sourceLabels)}</strong>
        </span>
        <span className="task-detail-summary-row">
          <small>{props.copy.priorityLabel ?? '优先级'}</small>
          <TaskImmediateSelect
            task={props.task}
            value={taskPriority}
            options={priorityOptions}
            ariaLabel={zh ? '修改任务优先级' : 'Change task priority'}
            copy={editCopy}
            disabled={props.busy}
            onSave={(priority, expectedUpdatedAt) => (isTaskPriority(priority) ? props.onUpdateTaskContent(props.task.id, { expectedUpdatedAt, priority }) : Promise.reject(new Error(zh ? '无效的任务优先级。' : 'Invalid task priority.')))}
          />
        </span>
        <span className="task-detail-summary-row">
          <small>{props.copy.updatedAtLabel ?? '更新时间'}</small>
          <strong>{formatTaskUpdatedAt(props.task.updatedAt, props.copy.updatedAtMissing ?? '未记录')}</strong>
        </span>
        <span className="task-detail-summary-row task-detail-evidence-row">
          <small>{props.copy.latestEvidenceLabel ?? '最近事件'}</small>
          <strong>
            {latestEvent ? (
              <>
                {latestEvent.title}
                <small>{formatTaskUpdatedAt(latestEvent.createdAt, props.copy.updatedAtMissing ?? '未记录')}</small>
              </>
            ) : (
              (props.copy.noEvidence ?? '暂无执行证据')
            )}
          </strong>
        </span>
      </section>

      {typedContentFields.map((field) => (
        <section key={field.key} className="task-detail-block task-detail-request-block" aria-label={field.label}>
          <span className="task-detail-section-heading">
            <strong>{field.label}</strong>
          </span>
          <InlineTaskTextField
            task={props.task}
            label={`${zh ? '编辑' : 'Edit'}${zh ? '' : ' '}${field.label}`}
            value={field.value}
            display={<span className="task-detail-request-text zeus-fidelity-text">{field.value || props.copy.noRequest}</span>}
            multiline
            copy={editCopy}
            disabled={props.busy}
            buildPatch={field.buildPatch}
            valueFromTask={field.valueFromTask}
            onSave={(input) => props.onUpdateTaskContent(props.task.id, input)}
          />
        </section>
      ))}

      <section className="task-detail-block task-detail-tags" aria-label={zh ? '任务标签' : 'Task tags'}>
        <span className="task-detail-section-heading">
          <strong>{zh ? '标签' : 'Tags'}</strong>
          <small>{props.task.tags?.length ?? 0}</small>
        </span>
        <InlineTaskTextField
          task={props.task}
          label={editCopy.editTags}
          value={taskTagsDraft(props.task.tags)}
          display={
            props.task.tags && props.task.tags.length > 0 ? (
              <span className="task-detail-tag-list">
                {props.task.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </span>
            ) : (
              <span className="task-inline-edit-empty">{editCopy.noTags}</span>
            )
          }
          copy={editCopy}
          disabled={props.busy}
          enterSeparates
          buildPatch={(tags) => ({ tags: normalizeTaskTagsInput(tags) })}
          valueFromTask={(task) => taskTagsDraft(task.tags)}
          onSave={(input) => props.onUpdateTaskContent(props.task.id, input)}
        />
      </section>

      <section className="task-detail-block task-detail-relationships" aria-label={zh ? '任务关系' : 'Task relationships'}>
        <span className="task-detail-section-heading">
          <span>
            <strong>{zh ? '父子关系' : 'Hierarchy'}</strong>
            <small>{zh ? `当前第 ${currentTaskDepth} 级，最多三级` : `Level ${currentTaskDepth} of 3`}</small>
          </span>
          <Button variant="secondary" size="compact" onClick={() => props.onCreateChild(props.task.id)} disabled={props.busy || currentTaskDepth >= 3}>
            {zh ? '新增子任务' : 'Add child task'}
          </Button>
        </span>
        <label className="task-detail-relationship-control">
          <small>{zh ? '父任务' : 'Parent task'}</small>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '更换父任务' : 'Change parent task'}
            value={props.task.parentTaskId ?? ''}
            options={[{ value: '', label: zh ? '无父任务（根任务）' : 'No parent (root task)' }, ...validParentTasks.map((task) => ({ value: task.id, label: `${task.taskCode ?? task.id} · ${task.title}` }))]}
            onChange={(parentTaskId) => void saveRelationships({ parentTaskId: parentTaskId || null })}
            disabled={props.busy || relationshipSaveState.kind === 'saving'}
          />
        </label>
        {directChildren.length > 0 ? (
          <div className="task-detail-relationship-list">
            <small>{zh ? `直接子任务 ${directChildren.length} 个` : `${directChildren.length} direct children`}</small>
            {directChildren.map((task) => (
              <span key={task.id} className="task-detail-relationship-row">
                <strong>{task.title}</strong>
                <small>{task.taskCode ?? task.id}</small>
              </span>
            ))}
          </div>
        ) : null}

        <span className="task-detail-section-heading task-detail-related-heading">
          <span>
            <strong>{zh ? '关联任务' : 'Related tasks'}</strong>
            <small>{relatedTasks.length}</small>
          </span>
        </span>
        <div className="task-detail-related-add">
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择要关联的任务' : 'Choose a related task'}
            value={relatedTaskCandidateId}
            options={relatedCandidateTasks.map((task) => ({ value: task.id, label: `${task.taskCode ?? task.id} · ${task.title}` }))}
            onChange={setRelatedTaskCandidateId}
            disabled={props.busy || relationshipSaveState.kind === 'saving' || relatedCandidateTasks.length === 0}
          />
          <Button
            variant="secondary"
            size="compact"
            disabled={!relatedTaskCandidateId || props.busy || relationshipSaveState.kind === 'saving'}
            onClick={() => void saveRelationships({ relatedTaskIds: [...(props.task.relatedTaskIds ?? []), relatedTaskCandidateId] })}
          >
            {zh ? '添加关联' : 'Add relation'}
          </Button>
        </div>
        <div className="task-detail-relationship-list" role="list">
          {relatedTasks.map((task) => (
            <span key={task.id} className="task-detail-relationship-row" role="listitem">
              <span>
                <strong>{task.title}</strong>
                <small>{task.taskCode ?? task.id}</small>
              </span>
              <Button
                variant="secondary"
                size="compact"
                onClick={() => void saveRelationships({ relatedTaskIds: (props.task.relatedTaskIds ?? []).filter((taskId) => taskId !== task.id) })}
                disabled={props.busy || relationshipSaveState.kind === 'saving'}
              >
                {zh ? '移除' : 'Remove'}
              </Button>
            </span>
          ))}
        </div>
        <TaskEditFeedback state={relationshipSaveState} copy={editCopy} statusId={`${attachmentStatusId}-relationships`} />
      </section>

      <section className="task-detail-block task-detail-attachments" aria-label={props.copy.attachmentsTitle ?? '图片与附件'} aria-busy={attachmentSaveState.kind === 'saving' || undefined}>
        <span className="task-detail-section-heading">
          <span>
            <strong>{props.copy.attachmentsTitle ?? '图片与附件'}</strong>
            <small>{taskAttachments.length}</small>
          </span>
          {props.onChooseAttachments ? (
            <Button variant="secondary" size="compact" onClick={() => void chooseAttachments()} busy={attachmentSaveState.kind === 'saving'} disabled={props.busy}>
              {editCopy.addAttachment}
            </Button>
          ) : null}
          {attachmentSaveState.kind === 'saving' ? <TaskSaveSpinner /> : null}
        </span>
        {taskAttachments.length > 0 ? (
          <TaskAttachmentPreviewList
            attachments={taskAttachments}
            mode="editable"
            disabled={props.busy || attachmentSaveState.kind === 'saving'}
            onRemove={(path) => void removeAttachment(path)}
            onLoadPreview={props.onLoadAttachmentPreview}
            onOpenAttachment={props.onOpenAttachment}
            copy={{
              imageLabel: props.copy.imageAttachmentLabel ?? '图片',
              fileLabel: props.copy.fileAttachmentLabel ?? '文件',
              openFileLabel: props.copy.openFileAttachmentLabel ?? '打开附件',
              openPreviewLabel: props.copy.previewAttachmentLabel ?? '放大预览附件',
              closePreviewLabel: props.copy.previewCloseLabel ?? '关闭附件预览',
              previewUnavailable: props.copy.previewUnavailableLabel ?? '无法预览，本机路径已保存',
              localPathLabel: props.copy.localPathLabel ?? '本机路径',
              removeLabel: editCopy.removeAttachment,
            }}
          />
        ) : (
          <p className="task-detail-attachment-empty">{zh ? '暂无附件，可以添加本机图片或文件。' : 'No attachments. Add a local image or file.'}</p>
        )}
        {undoAttachment ? (
          <span className="task-detail-attachment-undo">
            <small role="status" aria-live="polite">
              {zh ? `已解除 ${undoAttachment.name} 的任务关联。` : `Removed ${undoAttachment.name} from this task.`}
            </small>
            <Button variant="secondary" size="compact" onClick={() => void restoreRemovedAttachment()}>
              {editCopy.undoAttachment}
            </Button>
          </span>
        ) : null}
        <TaskEditFeedback state={attachmentSaveState} copy={editCopy} statusId={attachmentStatusId} onRetry={retryAttachmentSave} onLoadLatest={loadLatestAttachments} />
      </section>

      <section className="task-detail-block task-detail-conversations" aria-label={props.copy.conversationsTitle}>
        <span className="task-detail-section-heading">
          <strong>{props.copy.conversationsTitle}</strong>
          <small>{conversations.length}</small>
        </span>
        {props.conversationsLoading && conversations.length === 0 ? (
          <p className="task-detail-conversation-state" role="status">
            {props.copy.conversationLoading}
          </p>
        ) : props.conversationsError && conversations.length === 0 ? (
          <span className="task-detail-conversation-state task-detail-conversation-error" role="alert">
            <strong>{props.copy.conversationError}</strong>
            <small>{props.conversationsError}</small>
            {props.onReloadConversations ? (
              <Button variant="secondary" size="compact" onClick={() => props.onReloadConversations?.(props.task.id)}>
                {props.copy.retryConversationLoad}
              </Button>
            ) : null}
          </span>
        ) : conversations.length === 0 ? (
          <span className="task-detail-conversation-state task-detail-conversation-empty">
            <strong>{props.copy.conversationEmptyTitle}</strong>
            <small>{props.copy.conversationEmptyHelp}</small>
          </span>
        ) : (
          <>
            {props.conversationsError ? (
              <p className="task-detail-conversation-refresh-warning" role="status">
                {props.copy.conversationError}
              </p>
            ) : null}
            <ol className="task-detail-conversation-list">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button type="button" className="task-detail-conversation-row" aria-label={`${props.copy.openConversation}：${conversation.title}`} onClick={() => props.onOpenConversation(props.task.id, conversation.id)}>
                    <span>
                      <strong>{conversation.title}</strong>
                      <small>{conversation.providerModel ?? conversation.summary ?? conversation.status}</small>
                    </span>
                    <span className="task-detail-conversation-row-meta">
                      <time dateTime={conversation.updatedAt}>{formatTaskUpdatedAt(conversation.updatedAt, props.copy.updatedAtMissing ?? '未记录')}</time>
                      <small>{props.copy.openConversation}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      {taskWorkspaces.length > 0 ? (
        <section className="task-detail-block task-detail-code-delivery" aria-label={zh ? '代码交付' : 'Code delivery'}>
          <span className="task-detail-section-heading">
            <strong>{zh ? '代码交付' : 'Code delivery'}</strong>
            <small>{taskWorkspaces.length}</small>
          </span>
          <ol className="task-detail-delivery-list">
            {taskWorkspaces.map((workspace) => (
              <li key={workspace.id}>
                <span>
                  <strong>{workspace.repositoryName || workspace.repositoryRelativePath || workspace.branchName}</strong>
                  <small>{workspace.repositoryRelativePath ? `${workspace.repositoryRelativePath} · ${workspace.branchName}` : workspace.branchName}</small>
                  <small>{zh ? `来源 ${workspace.sourceBranch}` : `Source ${workspace.sourceBranch}`}</small>
                </span>
                <small>{taskWorkspaceDeliveryLabel(workspace.state, zh)}</small>
              </li>
            ))}
          </ol>
          {props.onOpenCodeDelivery ? (
            <span className="task-detail-git-actions">
              {props.onCommitCode ? (
                <Button variant="secondary" size="compact" onClick={() => props.onCommitCode?.(props.task.id)} disabled={!hasWritableTaskWorkspace}>
                  {zh ? '提交代码…' : 'Commit code…'}
                </Button>
              ) : null}
              {props.onPushCode ? (
                <Button variant="secondary" size="compact" onClick={() => props.onPushCode?.(props.task.id)} disabled={!hasWritableTaskWorkspace}>
                  {zh ? '推送代码…' : 'Push code…'}
                </Button>
              ) : null}
              <Button variant="secondary" size="compact" onClick={() => props.onOpenCodeDelivery?.(props.task.id)}>
                {zh ? '打开代码交付…' : 'Open code delivery…'}
              </Button>
            </span>
          ) : null}
          {!hasWritableTaskWorkspace ? <small className="task-detail-git-action-help">{zh ? '当前没有可提交或推送的任务工作区。' : 'No task workspace is currently available to commit or push.'}</small> : null}
        </section>
      ) : null}

      <section className="task-detail-block task-detail-events" aria-label={props.copy.eventsTitle}>
        <span className="task-detail-section-heading">
          <strong>{props.copy.eventsTitle}</strong>
          <small>{props.events.length}</small>
        </span>
        {props.events.length === 0 ? (
          <p>{props.copy.noEvents}</p>
        ) : (
          <ol className="task-detail-event-list">
            {props.events.slice(-8).map((event) => (
              <li className="task-detail-event-row" key={event.id}>
                <span>
                  <strong>{event.title}</strong>
                </span>
                <time dateTime={event.createdAt}>{formatTaskUpdatedAt(event.createdAt, props.copy.updatedAtMissing ?? '未记录')}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="task-detail-action-rail" aria-label={props.copy.primaryActionsTitle}>
        {props.modelPushOperation ? (
          <span className={`task-detail-model-push-feedback is-${props.modelPushOperation.status}`} role={modelPushFailed ? 'alert' : 'status'} aria-live={modelPushFailed ? 'assertive' : 'polite'} aria-atomic="true">
            <span>
              {modelPushCreating ? <TaskSaveSpinner /> : null}
              <strong>
                {modelPushCreating ? (zh ? '正在后台创建会话' : 'Creating conversation in the background') : modelPushFailed ? (zh ? '会话创建失败' : 'Conversation creation failed') : zh ? '会话已创建' : 'Conversation created'}
              </strong>
              {modelPushFailed && props.modelPushOperation.error ? <small>{props.modelPushOperation.error}</small> : null}
            </span>
            {modelPushFailed && props.onRetryModelPush ? (
              <Button variant="secondary" size="compact" onClick={() => props.onRetryModelPush?.(props.task.id)}>
                {zh ? '重试创建' : 'Retry creation'}
              </Button>
            ) : props.modelPushOperation.status === 'accepted' && props.modelPushOperation.conversationId ? (
              <Button variant="secondary" size="compact" onClick={() => props.onOpenConversation(props.task.id, props.modelPushOperation?.conversationId ?? '')}>
                {zh ? '打开会话' : 'Open conversation'}
              </Button>
            ) : null}
          </span>
        ) : null}
        <span className="task-detail-action-buttons">
          <Button variant="primary" size="regular" className="task-detail-primary-action" onClick={() => props.onPushNewConversation(props.task.id)} busy={props.busy || modelPushCreating} disabled={modelPushFailed}>
            {modelPushCreating ? (zh ? '正在创建会话…' : 'Creating conversation…') : props.copy.pushNewConversation}
          </Button>
          {props.onOpenCodeDelivery ? (
            <Button variant="secondary" size="regular" className="task-detail-secondary-action" onClick={() => props.onOpenCodeDelivery?.(props.task.id)} busy={props.busy}>
              {zh ? '代码交付…' : 'Code delivery…'}
            </Button>
          ) : null}
          <Button variant="danger" size="regular" onClick={() => props.onDeleteTask(props.task.id)} disabled={props.busy}>
            {zh ? '删除任务…' : 'Delete task…'}
          </Button>
        </span>
      </section>
    </section>
  );
}

function taskWorkspaceDeliveryLabel(state: NonNullable<NativeConversationChoice['workspace']>['state'], zh: boolean): string {
  const labels = zh
    ? { ready: '开发中', reclaimed: '已推送，待合入', merged: '已合入来源分支', discarded: '已放弃', failed: '需要处理' }
    : { ready: 'In development', reclaimed: 'Pushed, awaiting merge', merged: 'Merged into source', discarded: 'Discarded', failed: 'Action required' };
  return labels[state];
}
