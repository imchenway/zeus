import type { TaskEventRecord, TaskManagementStatus, TaskRecord } from '../apiClient.js';
import type { NativeConversationChoice } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { TaskAttachmentPreviewList } from './TaskAttachmentPreviewList.js';
import { parseTaskAttachments } from './taskAttachments.js';
import { formatTaskSource, formatTaskUpdatedAt, resolveTaskManagementStatus, taskManagementStatuses, type TaskSourceLabels } from './taskWorkspaceModel.js';

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
  events: TaskEventRecord[];
  copy: TaskDetailPaneCopy;
  statusLabels: Record<TaskManagementStatus | '', string>;
  eventTypeLabels: Record<string, string>;
  busy: boolean;
  conversations?: NativeConversationChoice[];
  conversationsLoading?: boolean;
  conversationsError?: string | null;
  onOpenConversation: (taskId: string, conversationId: string) => void;
  onPushNewConversation: (taskId: string) => void;
  onOpenCodeDelivery?: (taskId: string) => void;
  onManagementStatusChange: (taskId: string, status: TaskManagementStatus) => void;
  onReloadConversations?: (taskId: string) => void;
  onLoadAttachmentPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }>;
}

export function TaskDetailPaneContent(props: TaskDetailPaneContentProps) {
  const zh = props.language === 'zh-CN';
  const managementStatus = resolveTaskManagementStatus(props.task);
  const taskIdentity = props.task.taskCode?.trim() || props.task.id;
  const latestEvent = props.events.at(-1);
  const latestEvidenceType = latestEvent ? (props.eventTypeLabels[latestEvent.eventType] ?? latestEvent.eventType) : undefined;
  const taskAttachments = parseTaskAttachments(props.task.sourceContextJson);
  const conversations = [...(props.conversations ?? [])].filter((conversation) => !conversation.archived).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const taskWorkspaces = Array.from(
    new Map(
      conversations
        .map((conversation) => conversation.workspace)
        .filter((workspace): workspace is NonNullable<NativeConversationChoice['workspace']> => Boolean(workspace))
        .map((workspace) => [workspace.id, workspace]),
    ).values(),
  );

  return (
    <section className="product-drawer-pane task-detail-pane-content task-detail-pane-shell" aria-label={props.task.title}>
      <header className="task-detail-pane-header task-detail-summary-row">
        <span className="task-detail-pane-title">
          <small>
            {props.copy.taskCodeLabel ?? '任务编码'} {taskIdentity}
          </small>
          <strong>{props.task.title}</strong>
        </span>
        <span className="task-detail-pane-status-control">
          <ZeusSelect
            size="compact"
            ariaLabel={props.copy.detailStatusSelectAria}
            value={managementStatus}
            options={taskManagementStatuses.map((status) => ({
              value: status,
              label: props.statusLabels[status],
            }))}
            onChange={(status) => props.onManagementStatusChange(props.task.id, status)}
            disabled={props.busy}
            searchable={false}
          />
        </span>
      </header>

      <section className="task-detail-summary-grid task-detail-task-facts" aria-label={props.copy.metadataTitle}>
        <span className="task-detail-summary-row">
          <small>{props.copy.sourceLabel ?? '上下文来源'}</small>
          <strong>{formatTaskSource(props.task, props.copy.sourceLabels)}</strong>
        </span>
        <span className="task-detail-summary-row">
          <small>{props.copy.priorityLabel ?? '优先级'}</small>
          <strong>{props.task.priority?.toUpperCase() ?? '未设置'}</strong>
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
                  <strong>{workspace.branchName}</strong>
                  <small>{zh ? `来源 ${workspace.sourceBranch}` : `Source ${workspace.sourceBranch}`}</small>
                </span>
                <small>{taskWorkspaceDeliveryLabel(workspace.state, zh)}</small>
              </li>
            ))}
          </ol>
          {props.onOpenCodeDelivery ? (
            <Button variant="secondary" size="compact" onClick={() => props.onOpenCodeDelivery?.(props.task.id)}>
              {zh ? '打开代码交付…' : 'Open code delivery…'}
            </Button>
          ) : null}
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
          <Button variant="primary" size="regular" className="task-detail-primary-action" onClick={() => props.onPushNewConversation(props.task.id)} busy={props.busy}>
            {props.copy.pushNewConversation}
          </Button>
          {props.onOpenCodeDelivery ? (
            <Button variant="secondary" size="regular" className="task-detail-secondary-action" onClick={() => props.onOpenCodeDelivery?.(props.task.id)} busy={props.busy}>
              {zh ? '代码交付…' : 'Code delivery…'}
            </Button>
          ) : null}
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
