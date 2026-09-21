import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash';
import { retainInputFocus } from '../ui/retainInputFocus.js';
import type { UserFacingErrorCause } from '@zeus/shared';
import { type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { isTaskPriority, type TaskAttachmentField, type TaskAttachmentReference, type TaskManagementStatusDefinition } from '@zeus/shared';
import { type ProjectRecord, type TaskEventRecord, type TaskManagementStatus, type TaskPriority, type TaskRecord, type TaskType, type UpdateTaskRelationshipsRequest, type UpdateTaskRequest, ZeusApiError } from '../apiClient.js';
import type { NativeConversationChoice } from '../session/sessionTypes.js';
import type { CodexTaskPushCapabilities } from '../session/sessionTypes.js';
import { compareConversationCreatedAsc } from '../session/conversationOrdering.js';
import { Button } from '../ui/Button.js';
import { reportApplicationError, useApplicationErrorDialog, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { PENDING_RESOURCE_LONG_TEXT_THRESHOLD } from '../ui/pendingResourcePolicy.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { TaskAttachmentPreviewList } from './TaskAttachmentPreviewList.js';
import { TaskDigitalEmployeeExecutor, TaskDigitalEmployeePanel, useTaskDigitalEmployeeManagement, type TaskDigitalEmployeeSkillClient } from '../features/digital-employees/TaskDigitalEmployeePanel.js';
import type { DigitalEmployeeApiClient } from '../features/digital-employees/digitalEmployeeApiClient.js';
import type { TaskWorkflowClient } from './TaskWorkflowSection.js';
import type { TaskStageRecord } from '../features/tasks/taskContracts.js';
import {
  mergeTaskAttachments,
  parseTaskAttachments,
  type TaskAttachmentCandidate,
  taskAttachmentsForField,
  type TaskAttachmentView,
  type TaskResourceAuthorizationResult,
  type TaskResourcePayload,
  toPersistedTaskAttachment,
} from './taskAttachments.js';
import { formatTaskEventTitle, formatTaskSource, formatTaskType, formatTaskUpdatedAt, resolveTaskManagementStatus, type TaskSourceLabels, taskTypes } from './taskWorkspaceModel.js';

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
  archivedConversation: string;
  terminalConversationHelp: string;
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
  previewLoadingLabel?: string;
  previewUnavailableLabel?: string;
  previewLoadFailedLabel?: string;
  previewRetryLabel?: string;
  localPathLabel?: string;
  sourceLabels?: TaskSourceLabels;
  updatedAtMissing?: string;
}

export interface TaskDetailPaneContentProps {
  /** 可选择的项目来自当前工作区快照。 */
  projects: ProjectRecord[];
  /** 复制先打开可编辑草稿，提交后才创建独立任务。 */
  onCopyTask: (task: TaskRecord) => void;
  language: 'zh-CN' | 'en-US';
  task: TaskRecord;
  allTasks: TaskRecord[];
  events: TaskEventRecord[];
  copy: TaskDetailPaneCopy;
  statusLabels: Record<TaskManagementStatus | '', string>;
  statusDefinitions: readonly TaskManagementStatusDefinition[];
  priorityOptions: ReadonlyArray<{ value: TaskPriority; label: string }>;
  busy: boolean;
  terminalReadOnly: boolean;
  digitalEmployeeClient?: DigitalEmployeeApiClient | null;
  digitalEmployeeSkillClient?: TaskDigitalEmployeeSkillClient | null;
  conversations?: NativeConversationChoice[];
  conversationsLoading?: boolean;
  conversationsError?: string | null;
  modelPushOperation?: { errorCause?: UserFacingErrorCause; canRetry?: boolean; status: 'submitting' | 'failed' | 'accepted'; error: string | null; conversationId?: string };
  /** 接入检查保留在原推送按钮，读取失败可按原任务阶段重查。 */
  modelPushEntry?: { checking: boolean; error: string | null; onRetry: () => void };
  onOpenConversation: (taskId: string, conversationId: string) => void;
  /** 选择原会话时保留任务详情。 */
  onSelectConversation?(taskId: string, conversationId: string): Promise<void>;
  /** 当前唯一会话控制器身份。 */
  activeConversationId?: string | null;
  /** 同源会话阅读和发送组件。 */
  conversationWorkspace?: ReactNode;
  /** 首次讨论复用原新建会话输入与耐久接纳。 */
  newConversationWorkspace?: ReactNode;
  /** 从任务详情选择已保存的团队流程。 */
  onUseDigitalTeam?(): void;
  /** 打开当前项目员工管理，补齐可指派员工。 */
  onManageEmployees?(): void;
  onPushNewConversation: (taskId: string) => void;
  onRetryModelPush?: (taskId: string) => void;
  onOpenCodeDelivery?: (taskId: string) => void;
  onCommitCode?: (taskId: string) => void;
  onPushCode?: (taskId: string) => void;
  onUpdateTaskContent: (taskId: string, input: UpdateTaskRequest) => Promise<TaskEditResult>;
  onUpdateRelationships: (taskId: string, input: UpdateTaskRelationshipsRequest) => Promise<TaskEditResult>;
  onCreateChild: (taskId: string) => void;
  /** 父子和关联任务复用当前任务详情入口。 */
  onOpenRelatedTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onManagementStatusChange: (taskId: string, status: TaskManagementStatus, expectedUpdatedAt: string) => Promise<TaskEditResult | undefined>;
  onAuthorizeFiles?: (files: File[], source: 'paste') => Promise<TaskResourceAuthorizationResult>;
  onMaterializeResources?: (resources: TaskResourcePayload[]) => Promise<TaskAttachmentCandidate[]>;
  onReadClipboardResources?: () => Promise<{ resources: TaskAttachmentCandidate[]; text: string }>;
  onReloadConversations?: (taskId: string) => void;
  onLoadAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
  workflowClient?: TaskWorkflowClient;
  onLoadWorkflowCapabilities?: () => Promise<CodexTaskPushCapabilities>;
  onStartTaskStage?: (stage: TaskStageRecord) => Promise<void>;
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
  field: TaskAttachmentField;
  label: string;
  value: string;
  buildPatch: (value: string) => Omit<UpdateTaskRequest, 'expectedUpdatedAt'>;
  valueFromTask: (task: TaskRecord) => string;
};

type TaskAttachmentPasteRequest = {
  files: File[];
  plainText: string;
  readNativeClipboard: boolean;
};

type TaskAttachmentPasteResult = {
  insertText?: string;
  updatedAt?: string;
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

function taskEditErrorMessage(error: unknown, fallback: string, language: 'zh-CN' | 'en'): string {
  return error === null || error === undefined || error === '' ? fallback : reportApplicationError(error, { language: language });
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

function readTaskClipboardText(clipboardData: DataTransfer): string {
  try {
    return clipboardData.getData('text/plain');
  } catch {
    return '';
  }
}

function taskClipboardFiles(clipboardData: DataTransfer): File[] {
  const candidates = [
    ...Array.from(clipboardData.files),
    ...Array.from(clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null),
  ];
  const seen = new Set<string>();
  return candidates.filter((file) => {
    const fingerprint = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function TaskEditFeedback(props: { state: TaskFieldSaveState; copy: TaskEditCopy; statusId: string; onRetry?: () => void; onLoadLatest?: () => void }) {
  if (props.state.kind !== 'error' && props.state.kind !== 'conflict') return null;
  const message = props.state.kind === 'conflict' ? props.copy.conflict : props.state.message;
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

function TaskDetailFieldAttachments(props: {
  /** 附件文案缺省值也跟随页面语言。 */
  zh: boolean;
  field: TaskAttachmentField;
  attachments: TaskAttachmentView[];
  copy: TaskDetailPaneCopy;
  editCopy: TaskEditCopy;
  disabled: boolean;
  onRemove: (path: string) => void;
  onLoadPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
}) {
  const attachments = taskAttachmentsForField(props.attachments, props.field);
  if (attachments.length === 0) return null;
  return (
    <div className="task-detail-field-attachments">
      <TaskAttachmentPreviewList
        attachments={attachments}
        mode="editable"
        disabled={props.disabled}
        onRemove={props.onRemove}
        onLoadPreview={props.onLoadPreview}
        onOpenAttachment={props.onOpenAttachment}
        copy={{
          imageLabel: props.copy.imageAttachmentLabel ?? (props.zh ? '图片' : 'Image'),
          fileLabel: props.copy.fileAttachmentLabel ?? (props.zh ? '文件' : 'File'),
          openFileLabel: props.copy.openFileAttachmentLabel ?? (props.zh ? '打开附件' : 'Open attachment'),
          openPreviewLabel: props.copy.previewAttachmentLabel ?? (props.zh ? '放大预览附件' : 'Enlarge attachment preview'),
          closePreviewLabel: props.copy.previewCloseLabel ?? (props.zh ? '关闭附件预览' : 'Close attachment preview'),
          previewLoading: props.copy.previewLoadingLabel ?? (props.zh ? '正在加载图片预览…' : 'Loading image preview…'),
          previewUnavailable:
            props.copy.previewUnavailableLabel ?? (props.zh ? '无法显示这张图片的预览，具体原因尚未确定。可尝试在外部应用中打开文件。' : 'The preview cannot be displayed, and the cause is unknown. Try opening the file in another app.'),
          previewLoadFailed: props.copy.previewLoadFailedLabel ?? (props.zh ? '无法读取这张图片，具体原因尚未确定。' : 'The image cannot be read, and the cause is unknown.'),
          retryPreviewLabel: props.copy.previewRetryLabel ?? (props.zh ? '重试预览' : 'Reload preview'),
          localPathLabel: props.copy.localPathLabel ?? (props.zh ? '本机路径' : 'Local path'),
          removeLabel: props.editCopy.removeAttachment,
        }}
      />
    </div>
  );
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
  onPasteResources?: (request: TaskAttachmentPasteRequest) => Promise<TaskAttachmentPasteResult>;
}) {
  const statusId = `${useId()}-status`;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const baseUpdatedAtRef = useRef(props.task.updatedAt ?? '');
  const composingRef = useRef(false);
  const suppressBlurRef = useRef(false);
  const pasteShortcutFallbackTokenRef = useRef(0);
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

  useEffect(
    () => () => {
      pasteShortcutFallbackTokenRef.current += 1;
    },
    [],
  );

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
      setSaveState({ kind: 'error', message: taskEditErrorMessage(error, props.copy.saveFailed, props.copy === taskEditCopies['zh-CN'] ? 'zh-CN' : 'en') });
    }
  }

  function handleBlur(event: { relatedTarget: EventTarget | null; currentTarget: HTMLInputElement | HTMLTextAreaElement }): void {
    // 在文本与保存、取消按钮之间移动焦点时，等待用户明确操作。
    if (event.relatedTarget instanceof Node && event.currentTarget.closest('.task-inline-edit')?.contains(event.relatedTarget)) return;
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    void commitDraft();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void {
    handlePasteShortcutFallback(event);
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

  function insertPastedText(control: HTMLInputElement | HTMLTextAreaElement, text: string, selectionStart: number, selectionEnd: number): void {
    if (!text) return;
    const nextCaretPosition = selectionStart + text.length;
    setDraft((current) => `${current.slice(0, selectionStart)}${text}${current.slice(selectionEnd)}`);
    window.requestAnimationFrame(() => {
      if (document.activeElement !== control) return;
      control.setSelectionRange(nextCaretPosition, nextCaretPosition);
    });
  }

  async function applyPasteRequest(control: HTMLInputElement | HTMLTextAreaElement, request: TaskAttachmentPasteRequest, selectionStart: number, selectionEnd: number): Promise<void> {
    if (!props.onPasteResources) {
      insertPastedText(control, request.plainText, selectionStart, selectionEnd);
      return;
    }
    /** 保存附件和更新任务后保留当前编辑位置，主动切换字段时不抢焦点。 */
    const restoreFocus = retainInputFocus(control);
    try {
      const result = await props.onPasteResources(request);
      if (result.updatedAt) baseUpdatedAtRef.current = result.updatedAt;
      if (result.insertText) insertPastedText(control, result.insertText, selectionStart, selectionEnd);
    } finally {
      restoreFocus();
    }
  }

  function handlePasteShortcutFallback(event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void {
    if (!props.onPasteResources || saveState.kind === 'saving' || typeof window === 'undefined') return;
    if (event.key.toLowerCase() !== 'v' || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
    const control = event.currentTarget;
    const selectionStart = control.selectionStart ?? control.value.length;
    const selectionEnd = control.selectionEnd ?? selectionStart;
    const fallbackToken = pasteShortcutFallbackTokenRef.current + 1;
    pasteShortcutFallbackTokenRef.current = fallbackToken;
    // Finder 与 Paste.app 有时只触发粘贴快捷键；正常 paste 到达时会取消这次原生兜底。
    window.setTimeout(() => {
      if (pasteShortcutFallbackTokenRef.current !== fallbackToken) return;
      void applyPasteRequest(control, { files: [], plainText: '', readNativeClipboard: true }, selectionStart, selectionEnd)
        .catch(() => undefined)
        .finally(() => {
          if (pasteShortcutFallbackTokenRef.current === fallbackToken) pasteShortcutFallbackTokenRef.current += 1;
        });
    }, 120);
  }

  function handlePaste(event: ReactClipboardEvent<HTMLInputElement | HTMLTextAreaElement>): void {
    if (!props.onPasteResources || saveState.kind === 'saving') return;
    pasteShortcutFallbackTokenRef.current += 1;
    const control = event.currentTarget;
    const selectionStart = control.selectionStart ?? control.value.length;
    const selectionEnd = control.selectionEnd ?? selectionStart;
    const request: TaskAttachmentPasteRequest = {
      files: taskClipboardFiles(event.clipboardData),
      plainText: readTaskClipboardText(event.clipboardData),
      readNativeClipboard: true,
    };
    event.preventDefault();
    void applyPasteRequest(control, request, selectionStart, selectionEnd).catch(() => {
      if (request.files.length === 0) insertPastedText(control, request.plainText, selectionStart, selectionEnd);
    });
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
    disabled: saveState.kind === 'saving',
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
    onPaste: handlePaste,
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
          {props.multiline ? (
            <span className="task-inline-edit-actions">
              <Button variant="secondary" size="compact" disabled={saveState.kind === 'saving'} onPointerDown={(event) => event.preventDefault()} onClick={cancelEditing}>
                {props.copy === taskEditCopies['zh-CN'] ? '取消' : 'Cancel'}
              </Button>
              <Button variant="primary" size="compact" busy={saveState.kind === 'saving'} onPointerDown={(event) => event.preventDefault()} onClick={() => void commitDraft()}>
                {props.copy === taskEditCopies['zh-CN'] ? '保存' : 'Save'}
              </Button>
            </span>
          ) : null}
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
  options: ReadonlyArray<{ value: T; label: string; color?: string; disabled?: boolean }>;
  ariaLabel: string;
  copy: TaskEditCopy;
  disabled?: boolean;
  className?: string;
  colorized?: boolean;
  /** 状态切换静默保存，其他属性仍沿用加载动效。 */
  showSaveSpinner?: boolean;
  onSave: (value: T, expectedUpdatedAt: string) => Promise<TaskEditResult | undefined>;
}) {
  const statusId = `${useId()}-status`;
  const desiredValueRef = useRef<T | null>(null);
  const [displayValue, setDisplayValue] = useState(props.value);
  const [saveState, setSaveState] = useState<TaskFieldSaveState>({ kind: 'idle' });

  /** 加载动效与保存保护分开，静默保存时保留下拉箭头。 */
  const showSaveSpinner = saveState.kind === 'saving' && props.showSaveSpinner !== false;

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
      setSaveState({ kind: 'error', message: taskEditErrorMessage(error, props.copy.saveFailed, props.copy === taskEditCopies['zh-CN'] ? 'zh-CN' : 'en') });
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
      className={['task-immediate-select', showSaveSpinner ? 'is-saving' : '', props.className].filter(Boolean).join(' ')}
      aria-busy={saveState.kind === 'saving' || undefined}
      aria-describedby={saveState.kind === 'error' || saveState.kind === 'conflict' ? statusId : undefined}
    >
      <ZeusSelect
        size="compact"
        ariaLabel={props.ariaLabel}
        value={displayValue}
        options={props.options}
        className={props.colorized ? 'task-status-select task-status-custom' : undefined}
        style={props.colorized ? ({ '--task-status-tone': props.options.find((option) => option.value === displayValue)?.color ?? '#6b7280' } as CSSProperties) : undefined}
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
      {showSaveSpinner ? <TaskSaveSpinner /> : null}
      <TaskEditFeedback state={saveState} copy={props.copy} statusId={statusId} onRetry={retrySave} onLoadLatest={loadLatestValue} />
    </span>
  );
}

/** 低频项目操作默认折叠；修改需明确提交，失败保留目标便于调整。 */
function TaskProjectActions(props: Pick<TaskDetailPaneContentProps, 'task' | 'projects' | 'language' | 'busy' | 'onUpdateTaskContent' | 'onCopyTask'>) {
  /** 默认保持当前项目，仅按钮提交时执行修改。 */
  const [projectId, setProjectId] = useState(props.task.projectId);
  /** 防止重复点击和复制尚未完成的移动。 */
  const [saving, setSaving] = useState(false);
  /** 具体失败原因在当前操作下展示。 */
  const [error, setError] = useState('');
  /** 跟随应用的语言设置。 */
  const zh = props.language === 'zh-CN';
  /** 折叠时展示实际归属，不把尚未提交的目标当成当前项目。 */
  const currentProjectName = props.projects.find((project) => project.id === props.task.projectId)?.name ?? props.task.projectId;

  /** 保存经过现有串行编辑队列，冲突时提示用户检查最新任务。 */
  async function moveTask(): Promise<void> {
    if (saving || props.busy || projectId === props.task.projectId) return;
    setSaving(true);
    setError('');
    try {
      /** 服务端会在同一事务内完成编号、关系和归属修改。 */
      const result = await props.onUpdateTaskContent(props.task.id, { projectId, expectedUpdatedAt: props.task.updatedAt ?? '' });
      if (result.kind === 'conflict') setError(zh ? '任务已被修改，请检查最新内容后重新移动。' : 'The task changed. Review the latest content before moving again.');
    } catch (cause) {
      setError(
        cause instanceof ZeusApiError && cause.error === 'ZEUS_TASK_PROJECT_CHANGE_UNAVAILABLE'
          ? zh
            ? '此任务已有会话或执行资源，无法直接修改项目。请使用“复制到其他项目”保留原任务的执行历史。'
            : 'This task has conversations or execution resources. Copy it to another project to preserve its history.'
          : taskEditErrorMessage(cause, zh ? '修改项目失败，请重试。' : 'Could not change the project. Try again.', zh ? 'zh-CN' : 'en'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="task-detail-block task-detail-project-settings">
      <summary>
        <span>{zh ? '项目设置' : 'Project settings'}</span>
        <small title={currentProjectName}>{currentProjectName}</small>
      </summary>
      <div className="task-detail-project-settings-content">
        <ZeusSelect
          size="compact"
          ariaLabel={zh ? '选择目标项目' : 'Choose target project'}
          value={projectId}
          options={props.projects.map((project) => ({ value: project.id, label: project.name }))}
          searchPlaceholder={zh ? '搜索项目' : 'Search projects'}
          emptyLabel={zh ? '没有匹配的项目' : 'No matching projects'}
          onChange={(value) => {
            setProjectId(value);
            setError('');
          }}
          disabled={props.busy || saving}
        />
        {projectId !== props.task.projectId ? (
          <p className="task-flow-context">
            {zh
              ? '移动后使用目标项目的新编号与初始状态，解除原项目内的父子和关联关系。子任务留在原项目。'
              : 'Moving assigns a new project number and initial status, and removes parent, child and related-task links. Child tasks stay in the original project.'}
          </p>
        ) : null}
        <div className="task-detail-project-actions">
          <Button variant="secondary" size="compact" busy={saving} disabled={props.busy || projectId === props.task.projectId} onClick={() => void moveTask()}>
            {saving ? (zh ? '正在移动…' : 'Moving…') : zh ? '移动到此项目' : 'Move to project'}
          </Button>
          <Button variant="secondary" size="compact" disabled={props.busy || saving} onClick={() => props.onCopyTask(props.task)}>
            {zh ? '复制到其他项目' : 'Copy to another project'}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="task-inline-edit-feedback is-error">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}

/** 展示任务详情及其内容、项目和执行操作。 */
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
  /** 原生弹出层自动处理点击外部和 Escape，标识在多个详情入口间保持独立。 */
  const moreActionsId = useId();
  /** 进入原有交付或删除流程前先关闭低频操作弹出层。 */
  const moreActionsRef = useRef<HTMLElement | null>(null);
  const desiredAttachmentsRef = useRef<TaskAttachmentReference[]>(taskAttachments.map(toPersistedTaskAttachment));
  const attachmentPasteRetryRef = useRef<(() => Promise<void>) | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const [attachmentSaveState, setAttachmentSaveState] = useState<TaskFieldSaveState>({ kind: 'idle' });
  const [undoAttachment, setUndoAttachment] = useState<TaskAttachmentView | null>(null);
  const [relationshipSaveState, setRelationshipSaveState] = useState<TaskFieldSaveState>({ kind: 'idle' });
  /** 关系操作的前置条件提示，不冒充保存失败。 */
  const [relationshipHint, setRelationshipHint] = useState('');
  /** 提示归属对应操作，避免长列表把反馈推离按钮。 */
  const [relationshipHintTarget, setRelationshipHintTarget] = useState<'child' | 'relation'>('child');
  const [relatedTaskCandidateId, setRelatedTaskCandidateId] = useState('');
  const digitalEmployeeManagement = useTaskDigitalEmployeeManagement({ taskId: props.task.id, projectId: props.task.projectId, client: props.digitalEmployeeClient ?? null, language: props.language });
  /** Escape 优先关闭当前操作层，避免外层任务弹窗同时关闭。 */
  function closeMoreActionsOnEscape(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape' || !moreActionsRef.current?.matches(':popover-open')) return;
    event.preventDefault();
    event.stopPropagation();
    moreActionsRef.current.hidePopover();
  }
  useApplicationErrorDialog(props.conversationsError, {
    language: zh ? 'zh-CN' : 'en',
  });
  useEffect(() => {
    setAttachmentSaveState({ kind: 'idle' });
    setUndoAttachment(null);
    setRelationshipSaveState({ kind: 'idle' });
    setRelationshipHint('');
    setRelatedTaskCandidateId('');
    moreActionsRef.current?.hidePopover();
    attachmentPasteRetryRef.current = null;
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
  }, [props.task.id]);
  useEffect(() => {
    if (attachmentSaveState.kind === 'saving' || attachmentSaveState.kind === 'error' || attachmentSaveState.kind === 'conflict') return;
    desiredAttachmentsRef.current = parseTaskAttachments(props.task.sourceContextJson).map(toPersistedTaskAttachment);
  }, [attachmentSaveState.kind, props.task.id, props.task.sourceContextJson]);
  useEffect(
    () => () => {
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    },
    [],
  );
  const conversations = [...(props.conversations ?? [])].sort(compareConversationCreatedAsc);
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
            : taskEditErrorMessage(error, editCopy.saveFailed, zh ? 'zh-CN' : 'en');
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
      setAttachmentSaveState({ kind: 'error', message: taskEditErrorMessage(error, editCopy.saveFailed, zh ? 'zh-CN' : 'en') });
      return null;
    }
  }

  function taskPasteErrorMessage(failedCount?: number): string {
    if (failedCount && failedCount > 0) {
      return zh ? `${failedCount} 个粘贴资源读取失败，请重试。` : `${failedCount} pasted resource(s) could not be read. Try again.`;
    }
    return zh ? '无法添加粘贴的附件。请使用“添加附件”选择文件。' : 'The pasted attachment could not be added. Use Add attachment to select the file.';
  }

  async function pasteTaskDetailResources(field: TaskAttachmentField, request: TaskAttachmentPasteRequest): Promise<TaskAttachmentPasteResult> {
    const retryOperation = async () => {
      await pasteTaskDetailResources(field, request);
    };
    let additions: TaskAttachmentCandidate[] = [];
    let failedCount = 0;
    let text = request.plainText;
    let nativeReadFailed = false;

    setAttachmentSaveState({ kind: 'saving' });
    try {
      if (request.readNativeClipboard && props.onReadClipboardResources) {
        try {
          const nativeResult = await props.onReadClipboardResources();
          additions = nativeResult.resources;
          // 剪贴板正文已经被附件消费时，只补回剩余说明文字；没有附件才回填整段粘贴原文。
          text = additions.length > 0 ? nativeResult.text : nativeResult.text || text;
        } catch {
          nativeReadFailed = true;
        }
      }

      if (additions.length === 0 && request.files.length > 0) {
        if (!props.onAuthorizeFiles) throw new Error('Task attachment authorization is unavailable.');
        const result = await props.onAuthorizeFiles(request.files, 'paste');
        additions = result.resources;
        failedCount = result.failedCount;
      }

      if (additions.length === 0 && text.length >= PENDING_RESOURCE_LONG_TEXT_THRESHOLD) {
        if (!props.onMaterializeResources) throw new Error('Task attachment materialization is unavailable.');
        additions = await props.onMaterializeResources([{ name: 'Pasted text.txt', type: 'text/plain', text, kind: 'pasted_text' }]);
        if (additions.length === 0) throw new Error('Task attachment materialization returned no resource.');
      }

      if (additions.length === 0) {
        if (failedCount > 0 || request.files.length > 0 || (nativeReadFailed && !text)) {
          attachmentPasteRetryRef.current = retryOperation;
          setAttachmentSaveState({ kind: 'error', message: taskPasteErrorMessage(failedCount || request.files.length) });
          return {};
        }
        attachmentPasteRetryRef.current = null;
        setAttachmentSaveState({ kind: 'idle' });
        return { insertText: text };
      }

      const nextAttachments = mergeTaskAttachments(
        desiredAttachmentsRef.current,
        additions.map((attachment) => ({ ...attachment, field })),
      );
      const result = await saveAttachmentReferences(nextAttachments, props.task.updatedAt ?? '');
      if (!result) {
        attachmentPasteRetryRef.current = null;
        return {};
      }
      if (result.kind === 'conflict') {
        attachmentPasteRetryRef.current = null;
        return { updatedAt: result.latest.updatedAt };
      }

      if (failedCount > 0) {
        attachmentPasteRetryRef.current = retryOperation;
        setAttachmentSaveState({ kind: 'error', message: taskPasteErrorMessage(failedCount) });
      } else {
        attachmentPasteRetryRef.current = null;
      }
      /** 有待重试的失败项时先不写回正文，重试成功后再插入，避免同一段文字进入两次。 */
      return { updatedAt: result.task.updatedAt, ...(failedCount === 0 && text ? { insertText: text } : {}) };
    } catch {
      const resourceLikePaste = request.files.length > 0 || text.length >= PENDING_RESOURCE_LONG_TEXT_THRESHOLD;
      if (!resourceLikePaste && request.plainText) {
        attachmentPasteRetryRef.current = null;
        setAttachmentSaveState({ kind: 'idle' });
        return { insertText: request.plainText };
      }
      attachmentPasteRetryRef.current = retryOperation;
      setAttachmentSaveState({ kind: 'error', message: taskPasteErrorMessage() });
      return {};
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
    if (attachmentPasteRetryRef.current) {
      void attachmentPasteRetryRef.current();
      return;
    }
    const expectedUpdatedAt = attachmentSaveState.kind === 'conflict' ? (attachmentSaveState.latest.updatedAt ?? '') : (props.task.updatedAt ?? '');
    void saveAttachmentReferences(desiredAttachmentsRef.current, expectedUpdatedAt);
  }

  function loadLatestAttachments(): void {
    desiredAttachmentsRef.current = taskAttachments.map(toPersistedTaskAttachment);
    attachmentPasteRetryRef.current = null;
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
            field: 'defectCurrentState',
            label: zh ? '现状' : 'Current state',
            value: props.task.defectCurrentState ?? '',
            buildPatch: (defectCurrentState) => ({ defectCurrentState }),
            valueFromTask: (task) => task.defectCurrentState ?? '',
          },
          {
            key: 'defect-expected-outcome',
            field: 'defectExpectedOutcome',
            label: zh ? '预期' : 'Expected outcome',
            value: props.task.defectExpectedOutcome ?? '',
            buildPatch: (defectExpectedOutcome) => ({ defectExpectedOutcome }),
            valueFromTask: (task) => task.defectExpectedOutcome ?? '',
          },
          {
            key: 'defect-reproduction-steps',
            field: 'defectReproductionSteps',
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
              field: 'optimizationCurrentState',
              label: zh ? '现状' : 'Current state',
              value: props.task.optimizationCurrentState ?? '',
              buildPatch: (optimizationCurrentState) => ({ optimizationCurrentState }),
              valueFromTask: (task) => task.optimizationCurrentState ?? '',
            },
            {
              key: 'optimization-expected-outcome',
              field: 'optimizationExpectedOutcome',
              label: zh ? '预期' : 'Expected outcome',
              value: props.task.optimizationExpectedOutcome ?? '',
              buildPatch: (optimizationExpectedOutcome) => ({ optimizationExpectedOutcome }),
              valueFromTask: (task) => task.optimizationExpectedOutcome ?? '',
            },
          ]
        : [
            {
              key: 'requirement-description',
              field: 'description',
              label: zh ? '需求描述' : 'Requirement description',
              value: props.task.description ?? '',
              buildPatch: (description) => ({ description }),
              valueFromTask: (task) => task.description ?? '',
            },
          ];

  /** 任务正文与历史归入概览，复用原有编辑和操作入口。 */
  const taskOverview = (
    <div className="task-detail-overview">
      {typedContentFields.map((field) => (
        <section key={field.key} className="task-detail-block task-detail-request-block" aria-label={field.label}>
          <span className="task-detail-section-heading">
            <strong>{field.label}</strong>
          </span>
          <TaskDetailFieldAttachments
            zh={zh}
            field={field.field}
            attachments={taskAttachments}
            copy={props.copy}
            editCopy={editCopy}
            disabled={props.busy || attachmentSaveState.kind === 'saving'}
            onRemove={(path) => void removeAttachment(path)}
            onLoadPreview={props.onLoadAttachmentPreview}
            onOpenAttachment={props.onOpenAttachment}
          />
          <InlineTaskTextField
            task={props.task}
            label={`${zh ? '编辑' : 'Edit'}${zh ? '' : ' '}${field.label}`}
            value={field.value}
            display={<span className={`task-detail-request-text zeus-fidelity-text${field.value ? '' : ' task-inline-edit-empty'}`}>{field.value || (zh ? '点击补充' : 'Click to add details')}</span>}
            multiline
            copy={editCopy}
            disabled={props.busy}
            buildPatch={field.buildPatch}
            valueFromTask={field.valueFromTask}
            onSave={(input) => props.onUpdateTaskContent(props.task.id, input)}
            onPasteResources={(request) => pasteTaskDetailResources(field.field, request)}
          />
        </section>
      ))}

      <details className="task-detail-block task-detail-events" aria-label={props.copy.eventsTitle}>
        <summary className="task-detail-section-heading">
          <strong>{props.copy.eventsTitle}</strong>
          <small>{props.events.length}</small>
        </summary>
        {props.events.length === 0 ? (
          <p>{props.copy.noEvents}</p>
        ) : (
          <ol className="task-detail-event-list">
            {/* 展开后展示已加载的完整历史，数量必须与标题计数一致。 */}
            {props.events.map((event) => (
              <li className="task-detail-event-row" key={event.id}>
                <span>
                  <strong>{formatTaskEventTitle(event, props.language)}</strong>
                </span>
                <time dateTime={event.createdAt}>{formatTaskUpdatedAt(event.createdAt, props.copy.updatedAtMissing ?? (zh ? '未记录' : 'Not recorded'))}</time>
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );

  return (
    <section className="product-drawer-pane task-detail-pane-content task-detail-pane-shell" aria-label={props.task.title}>
      <header className="task-detail-pane-header task-detail-summary-row">
        <span className="task-detail-pane-title">
          <small>
            {props.copy.taskCodeLabel ?? (zh ? '任务编码' : 'Task code')} {taskIdentity}
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
        <div className="task-detail-header-actions" aria-label={props.copy.primaryActionsTitle} onKeyDown={closeMoreActionsOnEscape}>
          {props.terminalReadOnly ? (
            <span className="task-detail-closed-note">{zh ? '调整任务状态后可继续协作' : 'Change task status to resume collaboration'}</span>
          ) : (
            <Button
              variant="primary"
              size="regular"
              className="task-detail-primary-action"
              onClick={() => (props.modelPushEntry?.error ? props.modelPushEntry.onRetry() : props.onPushNewConversation(props.task.id))}
              busy={props.busy || modelPushCreating || props.modelPushEntry?.checking}
            >
              {props.modelPushEntry?.checking
                ? zh
                  ? '正在检查模型…'
                  : 'Checking models…'
                : props.modelPushEntry?.error
                  ? zh
                    ? '重新检查'
                    : 'Check again'
                  : modelPushCreating
                    ? zh
                      ? '正在创建会话…'
                      : 'Creating conversation…'
                    : props.copy.pushNewConversation}
            </Button>
          )}
          <Button variant="secondary" size="regular" className="task-detail-more-trigger" popoverTarget={moreActionsId} aria-label={zh ? '更多任务操作' : 'More task actions'} title={zh ? '更多操作' : 'More actions'}>
            <DotsThreeIcon size={20} weight="bold" aria-hidden="true" />
          </Button>
          <section
            ref={moreActionsRef}
            id={moreActionsId}
            popover="auto"
            className="task-detail-more-popover"
            aria-label={zh ? '更多任务操作' : 'More task actions'}
            onToggle={(event) => {
              // 展开后从首个可用操作开始键盘导航，收起时由原生弹出层恢复焦点。
              if (event.newState === 'open') moreActionsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
            }}
          >
            {props.onOpenCodeDelivery ? (
              <Button
                variant="secondary"
                size="regular"
                onClick={() => {
                  moreActionsRef.current?.hidePopover();
                  props.onOpenCodeDelivery?.(props.task.id);
                }}
                busy={props.busy}
              >
                <GitBranchIcon size={16} aria-hidden="true" />
                {zh ? '代码交付…' : 'Code delivery…'}
              </Button>
            ) : null}
            <Button
              variant="danger"
              size="regular"
              onClick={() => {
                moreActionsRef.current?.hidePopover();
                props.onDeleteTask(props.task.id);
              }}
              disabled={props.busy}
            >
              <TrashIcon size={16} aria-hidden="true" />
              {zh ? '删除任务…' : 'Delete task…'}
            </Button>
          </section>
        </div>
      </header>

      {props.modelPushEntry?.error || props.modelPushOperation ? (
        <section className="task-detail-feedback-rail" aria-label={zh ? '创建会话进度' : 'Conversation creation status'}>
          {props.modelPushEntry?.error ? (
            <span className="task-detail-model-push-feedback is-failed" role="status">
              <VisibleApplicationError error={props.modelPushEntry.error} language={zh ? 'zh-CN' : 'en'} />
            </span>
          ) : null}
          {props.modelPushOperation ? (
            <span className={`task-detail-model-push-feedback is-${props.modelPushOperation.status}`} role={modelPushFailed ? 'alert' : 'status'} aria-live={modelPushFailed ? 'assertive' : 'polite'} aria-atomic="true">
              <span>
                {modelPushCreating ? <TaskSaveSpinner /> : null}
                <strong>
                  {modelPushCreating ? (
                    zh ? (
                      '正在后台创建会话'
                    ) : (
                      'Creating conversation in the background'
                    )
                  ) : modelPushFailed ? (
                    <VisibleApplicationError error={props.modelPushOperation.errorCause ?? props.modelPushOperation.error} language={zh ? 'zh-CN' : 'en'} />
                  ) : zh ? (
                    '会话已创建'
                  ) : (
                    'Conversation created'
                  )}
                </strong>
              </span>
              {modelPushFailed && props.modelPushOperation.canRetry && props.onRetryModelPush ? (
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
        </section>
      ) : null}

      <div className="task-detail-arrangement" aria-label={zh ? '状态与执行人' : 'Status and employees'}>
        <span className="task-detail-summary-row">
          <small>{zh ? '状态' : 'Status'}</small>
          <TaskImmediateSelect
            task={props.task}
            value={managementStatus}
            options={props.statusDefinitions.map((status) => ({
              value: status.id,
              label: props.statusLabels[status.id] ?? status.id,
              color: status.color,
            }))}
            colorized
            showSaveSpinner={false}
            ariaLabel={props.copy.detailStatusSelectAria}
            copy={editCopy}
            disabled={props.busy}
            onSave={(status, expectedUpdatedAt) => props.onManagementStatusChange(props.task.id, status, expectedUpdatedAt)}
          />
        </span>
        <span className="task-detail-summary-row task-detail-executor-row">
          <small>{zh ? '执行人' : 'Assigned to'}</small>
          <TaskDigitalEmployeeExecutor
            taskId={props.task.id}
            projectId={props.task.projectId}
            terminalReadOnly={props.terminalReadOnly}
            client={props.digitalEmployeeClient ?? null}
            skillClient={props.digitalEmployeeSkillClient ?? null}
            language={props.language}
            management={digitalEmployeeManagement}
            onManageEmployees={props.onManageEmployees}
            onLoadCapabilities={props.onLoadWorkflowCapabilities}
          />
        </span>
      </div>
      {props.onUseDigitalTeam ? (
        <div className="task-detail-arrangement">
          <span className="task-detail-summary-row">
            <small>{zh ? '数字团队' : 'Digital team'}</small>
            <Button size="compact" onClick={props.onUseDigitalTeam}>
              {zh ? '选择工作流 / 查看运行' : 'Choose workflow / view runs'}
            </Button>
          </span>
        </div>
      ) : null}
      <div className="task-detail-workspace">
        <aside className="task-detail-sidebar" aria-label={zh ? '任务说明与属性' : 'Requirements and properties'}>
          {taskOverview}
          <details className="task-detail-properties">
            <summary>{zh ? '任务属性' : 'Task properties'}</summary>
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
                <small>{props.copy.priorityLabel ?? (zh ? '优先级' : 'Priority')}</small>
                <TaskImmediateSelect
                  task={props.task}
                  value={taskPriority}
                  options={priorityOptions}
                  ariaLabel={zh ? '修改任务优先级' : 'Change task priority'}
                  copy={editCopy}
                  disabled={props.busy}
                  onSave={(priority, expectedUpdatedAt) =>
                    isTaskPriority(priority) ? props.onUpdateTaskContent(props.task.id, { expectedUpdatedAt, priority }) : Promise.reject(new Error(zh ? '无效的任务优先级。' : 'Invalid task priority.'))
                  }
                />
              </span>
              <span className="task-detail-summary-row">
                <small>{props.copy.sourceLabel ?? (zh ? '上下文来源' : 'Context source')}</small>
                <strong>{formatTaskSource(props.task, props.copy.sourceLabels)}</strong>
              </span>
              <span className="task-detail-summary-row">
                <small>{props.copy.updatedAtLabel ?? (zh ? '更新时间' : 'Updated')}</small>
                <strong>{formatTaskUpdatedAt(props.task.updatedAt, props.copy.updatedAtMissing ?? (zh ? '未记录' : 'Not recorded'))}</strong>
              </span>
              <span className="task-detail-summary-row task-detail-evidence-row">
                <small>{props.copy.latestEvidenceLabel ?? (zh ? '最近事件' : 'Latest event')}</small>
                <strong>
                  {latestEvent ? (
                    <>
                      {formatTaskEventTitle(latestEvent, props.language)}
                      <small>{formatTaskUpdatedAt(latestEvent.createdAt, props.copy.updatedAtMissing ?? (zh ? '未记录' : 'Not recorded'))}</small>
                    </>
                  ) : (
                    (props.copy.noEvidence ?? (zh ? '暂无执行证据' : 'No task events yet'))
                  )}
                </strong>
              </span>
            </section>

            <section className="task-detail-block task-detail-tags" aria-label={zh ? '任务标签' : 'Task tags'}>
              <span className="task-detail-section-heading">
                <strong>{zh ? '标签' : 'Tags'}</strong>
                <small>{props.task.tags?.length ?? 0}</small>
              </span>
              <TaskDetailFieldAttachments
                zh={zh}
                field="tags"
                attachments={taskAttachments}
                copy={props.copy}
                editCopy={editCopy}
                disabled={props.busy || attachmentSaveState.kind === 'saving'}
                onRemove={(path) => void removeAttachment(path)}
                onLoadPreview={props.onLoadAttachmentPreview}
                onOpenAttachment={props.onOpenAttachment}
              />
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
                onPasteResources={(request) => pasteTaskDetailResources('tags', request)}
              />
            </section>

            <details className="task-detail-block task-detail-relationships task-detail-project-settings" aria-label={zh ? '任务关系' : 'Task relationships'}>
              <summary>
                <span>{zh ? '任务关系' : 'Task relationships'}</span>
                <small>{zh ? '父子与关联' : 'Hierarchy and links'}</small>
              </summary>
              <div className="task-detail-relationships-content">
                <span className="task-detail-section-heading">
                  <span>
                    <strong>{zh ? '父子关系' : 'Hierarchy'}</strong>
                    <small>{zh ? `当前第 ${currentTaskDepth} 级，最多三级` : `Level ${currentTaskDepth} of 3`}</small>
                  </span>
                  <Button
                    variant="secondary"
                    size="compact"
                    onClick={() => {
                      // 达到层级上限时解释可行路径，不创建第四级任务。
                      if (currentTaskDepth >= 3) {
                        setRelationshipHintTarget('child');
                        setRelationshipHint(zh ? '任务最多三级。请打开父任务，在父任务下新增同级任务。' : 'Tasks support three levels. Open the parent to add a sibling task.');
                        return;
                      }
                      setRelationshipHint('');
                      props.onCreateChild(props.task.id);
                    }}
                    disabled={props.busy}
                  >
                    {zh ? '新增子任务' : 'Add child task'}
                  </Button>
                </span>
                {relationshipHint && relationshipHintTarget === 'child' ? <p role="status">{relationshipHint}</p> : null}
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
                        <button type="button" className="task-detail-relationship-link" onClick={() => props.onOpenRelatedTask(task.id)} aria-label={zh ? `打开任务详情：${task.title}` : `Open task details: ${task.title}`}>
                          <strong>{task.title}</strong>
                          <small>{task.taskCode ?? task.id}</small>
                        </button>
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
                    options={[{ value: '', label: zh ? '请选择要关联的任务' : 'Select a task to relate', disabled: true }, ...relatedCandidateTasks.map((task) => ({ value: task.id, label: `${task.taskCode ?? task.id} · ${task.title}` }))]}
                    onChange={(taskId) => {
                      setRelatedTaskCandidateId(taskId);
                      setRelationshipHint('');
                    }}
                    disabled={props.busy || relationshipSaveState.kind === 'saving' || relatedCandidateTasks.length === 0}
                  />
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={props.busy || relationshipSaveState.kind === 'saving'}
                    onClick={() => {
                      // 必选条件通过反馈说明，空目标不得进入持久化请求。
                      if (!relatedTaskCandidateId) {
                        setRelationshipHintTarget('relation');
                        setRelationshipHint(
                          relatedCandidateTasks.length === 0
                            ? zh
                              ? '当前没有可关联的任务。请先在本项目创建其他任务。'
                              : 'No tasks are available to link. Create another task in this project first.'
                            : zh
                              ? '请先从上方下拉框选择要关联的任务。'
                              : 'Choose a task from the dropdown above first.',
                        );
                        return;
                      }
                      setRelationshipHint('');
                      void saveRelationships({ relatedTaskIds: [...(props.task.relatedTaskIds ?? []), relatedTaskCandidateId] });
                    }}
                  >
                    {zh ? '添加关联' : 'Add relation'}
                  </Button>
                </div>
                {relationshipHint && relationshipHintTarget === 'relation' ? <p role="status">{relationshipHint}</p> : null}
                <div className="task-detail-relationship-list" role="list">
                  {relatedTasks.map((task) => (
                    <span key={task.id} className="task-detail-relationship-row" role="listitem">
                      <button type="button" className="task-detail-relationship-link" onClick={() => props.onOpenRelatedTask(task.id)} aria-label={zh ? `打开任务详情：${task.title}` : `Open task details: ${task.title}`}>
                        <strong>{task.title}</strong>
                        <small>{task.taskCode ?? task.id}</small>
                      </button>
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
              </div>
            </details>

            <TaskProjectActions
              key={`${props.task.id}:${props.task.projectId}`}
              task={props.task}
              projects={props.projects}
              language={props.language}
              busy={props.busy}
              onUpdateTaskContent={props.onUpdateTaskContent}
              onCopyTask={props.onCopyTask}
            />
          </details>
        </aside>
        <div className="task-detail-main">
          <TaskDigitalEmployeePanel
            skillClient={props.digitalEmployeeSkillClient ?? null}
            key={props.task.id}
            taskId={props.task.id}
            projectId={props.task.projectId}
            terminalReadOnly={props.terminalReadOnly}
            client={props.digitalEmployeeClient ?? null}
            management={digitalEmployeeManagement}
            language={props.language}
            conversations={conversations}
            conversationsLoading={props.conversationsLoading}
            conversationsError={props.conversationsError}
            activeConversationId={props.activeConversationId}
            conversationWorkspace={props.conversationWorkspace}
            newConversationWorkspace={props.terminalReadOnly ? null : props.newConversationWorkspace}
            onSelectConversation={props.onSelectConversation ? (conversationId) => props.onSelectConversation!(props.task.id, conversationId) : undefined}
            onReloadConversations={props.onReloadConversations ? () => props.onReloadConversations!(props.task.id) : undefined}
            onOpenConversation={(conversationId) => props.onOpenConversation(props.task.id, conversationId)}
          />
        </div>
      </div>
      {undoAttachment || attachmentSaveState.kind === 'saving' || attachmentSaveState.kind === 'error' || attachmentSaveState.kind === 'conflict' ? (
        <section className="task-detail-attachment-feedback" aria-live="polite" aria-busy={attachmentSaveState.kind === 'saving' || undefined}>
          {attachmentSaveState.kind === 'saving' ? <TaskSaveSpinner /> : null}
          {undoAttachment ? (
            <span className="task-detail-attachment-undo">
              <small role="status">{zh ? `已解除 ${undoAttachment.name} 的任务关联。` : `Removed ${undoAttachment.name} from this task.`}</small>
              <Button variant="secondary" size="compact" onClick={() => void restoreRemovedAttachment()}>
                {editCopy.undoAttachment}
              </Button>
            </span>
          ) : null}
          <TaskEditFeedback state={attachmentSaveState} copy={editCopy} statusId={attachmentStatusId} onRetry={retryAttachmentSave} onLoadLatest={loadLatestAttachments} />
        </section>
      ) : null}
    </section>
  );
}
