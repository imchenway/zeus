import {useEffect, useRef, useState} from 'react';
import type {AiRuntimeSession, AiRuntimeSessionStatus, TaskEventRecord, TaskRecord, TaskStatus} from '../apiClient.js';
import {TaskAttachmentPreviewList} from './TaskAttachmentPreviewList.js';
import {parseTaskAttachments} from './taskAttachments.js';
import {
    findLinkedRuntimeSession,
    formatRuntimeCommandPreview,
    formatRuntimeSessionStatus,
    formatTaskNextAction,
    formatTaskSource,
    formatTaskUpdatedAt,
    type TaskNextActionLabels,
    type TaskSourceLabels
} from './taskWorkspaceModel.js';

export interface TaskDetailPaneCopy {
  requestTitle: string;
  noRequest: string;
  eventsTitle: string;
  noEvents: string;
  runTask: string;
    viewConversation: string;
  retryTask: string;
  markComplete: string;
  cancelTask: string;
  primaryActionsTitle: string;
  secondaryActionsTitle: string;
  dangerActionsTitle: string;
  metadataTitle: string;
  projectLabel: string;
  templateLabel: string;
  aiCliLabel: string;
  aiDetected: string;
  aiNotConfigured: string;
  taskCodeLabel?: string;
  sourceLabel?: string;
  updatedAtLabel?: string;
  runtimeSessionLabel?: string;
  runtimeCommandLabel?: string;
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
  runtimeSessionNotStarted?: string;
  runtimeCommandMissing?: string;
  runtimeSessionStatusLabels?: Partial<Record<AiRuntimeSessionStatus, string>>;
  nextActionLabels?: TaskNextActionLabels;
  sourceLabels?: TaskSourceLabels;
  updatedAtMissing?: string;
  sensitiveCommandArgument?: string;
  cancelConfirm: string;
}

export interface TaskDetailPaneContentProps {
  task: TaskRecord;
  events: TaskEventRecord[];
    copy: TaskDetailPaneCopy;
  statusLabels: Record<TaskStatus | '', string>;
  eventTypeLabels: Record<string, string>;
  runtimeAiAvailable: boolean;
  runtimeSessions?: AiRuntimeSession[];
  busy: boolean;
    hasLinkedConversation?: boolean;
    onViewConversation?: (taskId: string) => void;
  onRuntimeAction: (taskId: string, action: 'run' | 'pause' | 'continue' | 'cancel' | 'retry') => void;
  onMarkComplete: (taskId: string) => void;
  onLoadAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
  controlBusyProps: (busy: boolean) => { 'aria-busy'?: true; 'data-loading'?: 'true' };
}

function shouldShowRun(status: TaskStatus): boolean {
  return status === 'ready' || status === 'draft';
}

export function TaskDetailPaneContent(props: TaskDetailPaneContentProps) {
    const [moreActionsOpen, setMoreActionsOpen] = useState(false);
    const moreActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
    const moreActionsMenuRef = useRef<HTMLDivElement | null>(null);
  const runtimeDisabled = props.busy;
  const completeDisabled = props.busy || props.task.status === 'completed' || props.task.status === 'cancelled';
  const cancelDisabled = props.busy || props.task.status === 'completed' || props.task.status === 'cancelled';
  const statusLabel = props.statusLabels[props.task.status];
  const nextAction = formatTaskNextAction(props.task, props.copy.nextActionLabels);
  const taskIdentity = props.task.taskCode?.trim() || props.task.id;
  const linkedRuntimeSession = findLinkedRuntimeSession(props.task, props.runtimeSessions);
  const runtimeCommandMissing = props.copy.runtimeCommandMissing ?? '未记录运行命令';
  const runtimeCommand = formatRuntimeCommandPreview(linkedRuntimeSession, runtimeCommandMissing);
  const runtimeStatus = formatRuntimeSessionStatus(linkedRuntimeSession, props.copy.runtimeSessionStatusLabels, props.copy.runtimeSessionNotStarted ?? '未启动 Runtime 会话');
  const statusWithNextAction = `${statusLabel} · ${nextAction}`;
  const latestEvent = props.events.at(-1);
  const latestEvidenceType = latestEvent ? (props.eventTypeLabels[latestEvent.eventType] ?? latestEvent.eventType) : undefined;
  const taskAttachments = parseTaskAttachments(props.task.sourceContextJson);

  const requestCancel = () => {
    if (typeof window !== 'undefined' && !window.confirm(props.copy.cancelConfirm)) return;
      setMoreActionsOpen(false);
    props.onRuntimeAction(props.task.id, 'cancel');
  };

    const hasLinkedConversation = props.hasLinkedConversation === true && Boolean(props.onViewConversation);
    const primaryActions: Array<{ key: string; label: string; action: 'run' | 'retry'; disabled: boolean }> = [];
    if (!hasLinkedConversation && shouldShowRun(props.task.status)) primaryActions.push({
        key: 'run',
        label: props.copy.runTask,
        action: 'run',
        disabled: runtimeDisabled
    });
    if (!hasLinkedConversation && (props.task.status === 'failed' || props.task.status === 'cancelled')) primaryActions.push({
        key: 'retry',
        label: props.copy.retryTask,
        action: 'retry',
        disabled: runtimeDisabled
    });

    useEffect(() => {
        if (!moreActionsOpen) return;
        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (moreActionsTriggerRef.current?.contains(target) || moreActionsMenuRef.current?.contains(target)) return;
            setMoreActionsOpen(false);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
        };
    }, [moreActionsOpen]);

  return (
      <section
          className="product-drawer-pane task-detail-pane-content task-detail-pane-shell"
          aria-label={props.task.title}
          onKeyDown={(event) => {
              if (event.key !== 'Escape' || !moreActionsOpen) return;
              event.preventDefault();
              event.stopPropagation();
              setMoreActionsOpen(false);
              moreActionsTriggerRef.current?.focus();
          }}
      >
          <header className="task-detail-pane-header task-detail-summary-row">
        <span className="task-detail-pane-title">
          <small>
            {props.copy.taskCodeLabel ?? '任务编码'} {taskIdentity}
          </small>
          <strong>{props.task.title}</strong>
        </span>
              <span className="task-detail-pane-status" aria-label={statusWithNextAction}>
          {statusWithNextAction}
        </span>
      </header>

      <section className="task-detail-summary-grid task-detail-ai-facts" aria-label={props.copy.metadataTitle}>
        <span className="task-detail-summary-row">
          <small>{props.copy.aiCliLabel}</small>
          <strong>{props.runtimeAiAvailable ? props.copy.aiDetected : props.copy.aiNotConfigured}</strong>
        </span>
        <span className="task-detail-summary-row">
          <small>{props.copy.runtimeSessionLabel ?? 'Runtime 会话'}</small>
          <strong>{linkedRuntimeSession?.id ?? props.copy.runtimeSessionNotStarted ?? '未启动 Runtime 会话'}</strong>
        </span>
        <span className="task-detail-summary-row">
          <small>{props.copy.runtimeCommandLabel ?? '运行命令 / 状态'}</small>
          <strong>
            {runtimeCommand} · {runtimeStatus}
          </strong>
        </span>
        <span className="task-detail-summary-row">
          <small>{props.copy.sourceLabel ?? '上下文来源'}</small>
          <strong>{formatTaskSource(props.task, props.copy.sourceLabels)}</strong>
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
                <small>
                  {latestEvidenceType} · {formatTaskUpdatedAt(latestEvent.createdAt, props.copy.updatedAtMissing ?? '未记录')}
                </small>
              </>
            ) : (
              (props.copy.noEvidence ?? '暂无执行证据')
            )}
          </strong>
        </span>
      </section>

      <section className="task-detail-block task-detail-request-block" aria-label={props.copy.requestTitle}>
        <span className="task-detail-section-heading">
          <strong>{props.copy.requestTitle}</strong>
        </span>
        <p className="task-detail-request-text">{props.task.description || props.copy.noRequest}</p>
      </section>

      {taskAttachments.length > 0 ? (
        <section className="task-detail-block task-detail-attachments" aria-label={props.copy.attachmentsTitle ?? '图片与附件'}>
          <span className="task-detail-section-heading">
            <strong>{props.copy.attachmentsTitle ?? '图片与附件'}</strong>
            <small>{taskAttachments.length}</small>
          </span>
          <TaskAttachmentPreviewList
            attachments={taskAttachments}
            mode="readonly"
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
            }}
          />
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
                  <small>{props.eventTypeLabels[event.eventType] ?? event.eventType}</small>
                </span>
                <time dateTime={event.createdAt}>{formatTaskUpdatedAt(event.createdAt, props.copy.updatedAtMissing ?? '未记录')}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="task-detail-action-rail" aria-label={props.copy.primaryActionsTitle}>
        <span className="task-detail-action-buttons">
          {hasLinkedConversation ? (
              <button type="button" className="task-detail-primary-action task-detail-view-conversation-action"
                      onClick={() => props.onViewConversation?.(props.task.id)}
                      disabled={props.busy} {...props.controlBusyProps(props.busy)}>
                  {props.copy.viewConversation}
              </button>
          ) : null}
            {primaryActions.map((item) => (
                <button key={item.key} type="button" className="task-detail-primary-action"
                        onClick={() => props.onRuntimeAction(props.task.id, item.action)}
                        disabled={item.disabled} {...props.controlBusyProps(props.busy)}>
                    {item.label}
                </button>
            ))}
            <button type="button" className="task-detail-secondary-action"
                    onClick={() => props.onMarkComplete(props.task.id)}
                    disabled={completeDisabled} {...props.controlBusyProps(props.busy)}>
            {props.copy.markComplete}
          </button>
          <span className="task-detail-more-actions">
            <button
                ref={moreActionsTriggerRef}
                type="button"
                className="task-detail-more-actions-trigger"
                aria-label={props.copy.dangerActionsTitle}
                aria-haspopup="menu"
                aria-expanded={moreActionsOpen}
                onClick={() => setMoreActionsOpen((open) => !open)}
            >
              …
            </button>
            <div ref={moreActionsMenuRef} className="task-detail-more-actions-menu" role="menu"
                 hidden={!moreActionsOpen}>
              <button type="button" role="menuitem" className="task-detail-danger-action danger-action"
                      onClick={requestCancel} disabled={cancelDisabled} {...props.controlBusyProps(props.busy)}>
                {props.copy.cancelTask}
              </button>
              <small>{props.copy.cancelConfirm}</small>
            </div>
          </span>
        </span>
      </section>
    </section>
  );
}
