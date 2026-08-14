import { type FormEvent, type KeyboardEvent, memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageCheckIcon, MessageEditIcon, MessageExpandIcon, MessageRemoteDeviceIcon, MessageThumbIcon } from './SessionMessageIcons.js';
import type { NativeConversationAttachment, NativeSessionItemBuffer } from './sessionTypes.js';
import { autosizeTextarea } from './textareaAutosize.js';
import type { ConversationContextDraft, ConversationFileLocation, ConversationOpenTarget, ConversationResource, ConversationResourcePreview, TaskPushMessageLayout } from '@zeus/shared';
import type { ConversationResponseAnnotation, ConversationResponseTextAnchor } from '@zeus/shared';
import { ConversationGeneratedImage, ConversationInlineResource, ConversationMarkdownImage, ConversationPendingAttachmentImages, ConversationResourceCards, isImageResource, isPendingImageAttachment } from './ConversationResources.js';
import { ResponseSelectionActions } from './ResponseSelectionActions.js';

export type SessionUiLanguage = 'zh-CN' | 'en-US';
export type ThreadItemRole = 'user' | 'assistant' | 'commentary' | 'tool' | 'file' | 'image' | 'request' | 'error' | 'unknown';
export const MAX_MARKDOWN_CHARACTERS = 200_000;
export const MAX_MARKDOWN_BLOCK_CHARACTERS = 50_000;
export const MAX_MARKDOWN_BLOCKS = 512;
export const MAX_MARKDOWN_NODES = 4_096;
const STREAM_IDLE_FLUSH_MS = 120;
const STREAM_MAX_FLUSH_MS = 180;
const STREAM_MIN_BATCH_CHARACTERS = 12;
const STREAM_IMMEDIATE_CHUNK_CHARACTERS = 48;
const STREAM_CATCH_UP_CHARACTERS = 96;
const STREAM_STRUCTURED_IDLE_FLUSH_MS = 1_200;

const copy = {
  'zh-CN': {
    user: '你',
    assistant: 'Codex',
    commentary: 'Codex',
    tool: '工具调用',
    file: '文件变更',
    request: '等待操作',
    error: '本轮错误',
    unknown: '未知 provider 项',
    thinking: '正在思考',
    expand: '展开完整消息',
    collapse: '收起消息',
    copy: '复制消息',
    copied: '已复制',
    copyCommand: '复制命令',
    copyCode: '复制代码',
    edit: '编辑并重新发送',
    editInput: '在原消息中编辑',
    cancelEdit: '取消',
    sendEdit: '发送编辑内容',
    editFailed: '发送失败，编辑内容已保留。',
    good: '好的回答',
    bad: '不好的回答',
    expandMessage: '展开消息',
    collapseMessage: '收起消息',
    image: '生成的图片',
    conversationImage: '会话图片',
    attachments: '附件',
    details: '技术详情',
    complexityTruncated: '内容过于复杂，已截断',
    queued: '排队中',
    sendFailed: '发送失败',
    sendUnconfirmed: '发送结果待确认',
    steering: '引导中',
    steerUnconfirmed: '引导结果待确认',
    remoteDevice: '由远程设备发送',
  },
  'en-US': {
    user: 'You',
    assistant: 'Codex',
    commentary: 'Codex',
    tool: 'Tool call',
    file: 'File change',
    request: 'Action pending',
    error: 'Turn error',
    unknown: 'Unknown provider item',
    thinking: 'Thinking',
    expand: 'Expand full message',
    collapse: 'Collapse message',
    copy: 'Copy message',
    copied: 'Copied',
    copyCommand: 'Copy command',
    copyCode: 'Copy code',
    edit: 'Edit and resend',
    editInput: 'Edit in the original message',
    cancelEdit: 'Cancel',
    sendEdit: 'Send edited message',
    editFailed: 'Send failed. Your edited message is preserved.',
    good: 'Good response',
    bad: 'Bad response',
    expandMessage: 'Expand message',
    collapseMessage: 'Collapse message',
    image: 'Generated image',
    conversationImage: 'Conversation image',
    attachments: 'Attachments',
    details: 'Technical details',
    complexityTruncated: 'Content complexity truncated',
    queued: 'Queued',
    sendFailed: 'Send failed',
    sendUnconfirmed: 'Send outcome unconfirmed',
    steering: 'Steering',
    steerUnconfirmed: 'Steer outcome unconfirmed',
    remoteDevice: 'Sent from a remote device',
  },
} as const;

export interface ThreadItemViewProps {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  isLatest?: boolean;
  animateEntrance?: boolean;
  showAssistantActions?: boolean;
  isLatestUser?: boolean;
  onEdit?: (item: NativeSessionItemBuffer, content: string) => void | Promise<void>;
  onRetry?: (item: NativeSessionItemBuffer) => void;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  onVisibleContentChange?: () => void;
  responseAnnotations?: ConversationResponseAnnotation[];
  onAddResponseAnnotation?: (anchor: ConversationResponseTextAnchor) => string;
  onUpdateResponseAnnotation?: (id: string, note: string) => void;
  onRemoveResponseAnnotation?: (id: string) => void;
  onOpenSideChat?: (selectedText: string) => void;
}

function taskPushMessageLayout(value: unknown): TaskPushMessageLayout | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TaskPushMessageLayout>;
  return candidate.kind === 'task_push' && Array.isArray(candidate.blocks) && typeof candidate.supplementalInfo === 'string' && (candidate.supplementalAttachments === undefined || Array.isArray(candidate.supplementalAttachments))
    ? ({ ...candidate, supplementalAttachments: candidate.supplementalAttachments ?? [] } as TaskPushMessageLayout)
    : null;
}

function resourceTaskPushAttachmentKey(resource: ConversationResource): string | null {
  return 'taskPushAttachmentKey' in resource && typeof resource.taskPushAttachmentKey === 'string' ? resource.taskPushAttachmentKey : null;
}

function TaskPushMessageContent(
  props: Pick<ThreadItemViewProps, 'language' | 'onOpenResource' | 'onLoadResourcePreview' | 'onVisibleContentChange'> & {
    layout: TaskPushMessageLayout;
    resources: ConversationResource[];
    pendingAttachments: NativeConversationAttachment[];
  },
) {
  const resourcesByKey = new Map(
    props.resources.flatMap((resource) => {
      const key = resourceTaskPushAttachmentKey(resource);
      return key ? [[key, resource] as const] : [];
    }),
  );
  const pendingImagesByKey = new Map(props.pendingAttachments.flatMap((attachment) => (attachment.taskPushAttachmentKey && isPendingImageAttachment(attachment) ? [[attachment.taskPushAttachmentKey, attachment] as const] : [])));
  const supplementalAttachments = props.layout.supplementalAttachments ?? [];
  return (
    <div className="session-task-push-layout">
      {props.layout.blocks.map((block) => (
        <section key={`${block.contextKind}:${block.taskId ?? 'current'}`} className="session-task-push-block">
          <header>
            <strong>{block.contextKind === 'current' ? block.taskTitle : `${block.contextKind === 'parent' ? '父任务' : '关联任务'}：${block.taskCode ?? block.taskId} · ${block.taskTitle}`}</strong>
          </header>
          {block.fields.map((field) => {
            const resources = field.attachmentKeys.flatMap((key) => {
              const resource = resourcesByKey.get(key);
              return resource ? [resource] : [];
            });
            const attachmentNames = new Map(block.attachments.map((attachment) => [attachment.key, attachment.name]));
            const pendingImages = field.attachmentKeys.flatMap((key) => {
              const attachment = pendingImagesByKey.get(key);
              return attachment ? [attachment] : [];
            });
            const missingAttachmentKeys = field.attachmentKeys.filter((key) => !resourcesByKey.has(key) && !pendingImagesByKey.has(key));
            return (
              <section key={field.field} className="session-task-push-field">
                <strong>{field.label}：</strong>
                <ConversationResourceCards resources={resources} language={props.language} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
                <ConversationPendingAttachmentImages attachments={pendingImages} language={props.language} onVisibleContentChange={props.onVisibleContentChange} />
                {missingAttachmentKeys.map((key) => (
                  <span key={key} className="session-task-push-resource-placeholder">
                    附件 · {attachmentNames.get(key) ?? key}
                  </span>
                ))}
                {field.text ? <SafeMarkdown text={field.text} language={props.language} resources={resources} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} /> : null}
              </section>
            );
          })}
          {block.conversationPaths.length > 0 ? (
            <section className="session-task-push-field">
              <strong>{block.contextKind === 'current' ? '当前任务历史会话信息：' : '会话文件路径：'}</strong>
              {block.conversationPaths.map((path) => (
                <code key={path}>{path}</code>
              ))}
            </section>
          ) : null}
        </section>
      ))}
      {props.layout.supplementalInfo || supplementalAttachments.length > 0 ? (
        <section className="session-task-push-field">
          <strong>补充信息：</strong>
          <ConversationResourceCards
            resources={supplementalAttachments.flatMap((attachment) => {
              const resource = resourcesByKey.get(attachment.key);
              return resource ? [resource] : [];
            })}
            language={props.language}
            onOpenResource={props.onOpenResource}
            onLoadResourcePreview={props.onLoadResourcePreview}
          />
          <ConversationPendingAttachmentImages
            attachments={supplementalAttachments.flatMap((attachment) => {
              const pending = pendingImagesByKey.get(attachment.key);
              return pending ? [pending] : [];
            })}
            language={props.language}
            onVisibleContentChange={props.onVisibleContentChange}
          />
          {supplementalAttachments
            .filter((attachment) => !resourcesByKey.has(attachment.key) && !pendingImagesByKey.has(attachment.key))
            .map((attachment) => (
              <span key={attachment.key} className="session-task-push-resource-placeholder">
                附件 · {attachment.name}
              </span>
            ))}
          {props.layout.supplementalInfo ? (
            <SafeMarkdown
              text={props.layout.supplementalInfo}
              language={props.language}
              resources={supplementalAttachments.flatMap((attachment) => {
                const resource = resourcesByKey.get(attachment.key);
                return resource ? [resource] : [];
              })}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function optimisticDeliveryStatus(item: NativeSessionItemBuffer, labels: (typeof copy)[SessionUiLanguage]): string | null {
  const delivery = primitiveText(item.payload.delivery);
  if (item.status === 'failed') return labels.sendFailed;
  if (delivery === 'steer_now') {
    const unconfirmed = item.status === 'paused' || item.status === 'unconfirmed' || primitiveText(item.payload.pausedReason) === 'recovery_required';
    return unconfirmed ? labels.steerUnconfirmed : labels.steering;
  }
  if (item.status === 'paused' || item.status === 'unconfirmed' || primitiveText(item.payload.pausedReason) === 'recovery_required') return labels.sendUnconfirmed;
  return item.status === 'queued' ? labels.queued : null;
}

export const ThreadItemView = memo(function ThreadItemView(props: ThreadItemViewProps) {
  const labels = copy[props.language];
  const [expanded, setExpanded] = useState(false);
  const [messageExpanded, setMessageExpanded] = useState(false);
  const [feedback, setFeedback] = useState<'good' | 'bad' | null>(null);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const role = itemRole(props.item);
  const taskPushLayout = role === 'user' ? taskPushMessageLayout(props.item.payload.taskPushLayout) : null;
  const pendingAttachments = role === 'user' ? nativeConversationAttachments(props.item.payload.attachments) : [];
  const conversationContext = role === 'user' ? conversationContextDraft(props.item.payload.conversationContext) : null;
  const hasAuthoritativeAttachmentResources = props.item.resources.some((resource) => resource.kind === 'attachment' && resource.presentation === 'card');
  const pendingImageAttachments = !taskPushLayout && !hasAuthoritativeAttachmentResources ? pendingAttachments.filter(isPendingImageAttachment) : [];
  const showUserMessageAttachmentGroup = role === 'user' && !taskPushLayout;
  const taskPushAttachmentKeys = new Set([...(taskPushLayout?.blocks.flatMap((block) => block.attachments.map((attachment) => attachment.key)) ?? []), ...(taskPushLayout?.supplementalAttachments ?? []).map((attachment) => attachment.key)]);
  const unplacedResources = taskPushLayout
    ? props.item.resources.filter((resource) => {
        const key = resourceTaskPushAttachmentKey(resource);
        return !key || !taskPushAttachmentKeys.has(key);
      })
    : props.item.resources;
  const itemText = transcriptItemText(props.item);
  const commentary = role === 'commentary';
  const naturalLanguageStream = role === 'assistant' || commentary;
  const streamActive = naturalLanguageStream && props.item.status !== 'completed' && props.item.status !== 'failed';
  const adaptiveText = useAdaptiveTranscriptText(itemText, streamActive);
  const presentedItemText = naturalLanguageStream ? adaptiveText.text : itemText;
  const longUserMessage = role === 'user' && itemText.length > 640;
  const visibleText = longUserMessage && !expanded ? `${itemText.slice(0, 620).trimEnd()}…` : presentedItemText;
  const label = roleLabel(role, labels);
  const command = normalizeType(props.item.type) === 'commandexecution' || normalizeType(props.item.type) === 'command';
  const accessibleLabel = command ? (props.language === 'zh-CN' ? '命令执行' : 'Command execution') : label;
  const showVisibleRoleLabel = role !== 'user' && role !== 'assistant' && role !== 'commentary';
  // 任务首发消息已经是工作面的稳定内容，内部创建进度只在底部统一呈现。
  const optimisticStatus = props.item.optimistic && !taskPushLayout ? optimisticDeliveryStatus(props.item, labels) : null;
  const showMeta = !command && (showVisibleRoleLabel || Boolean(optimisticStatus));
  const messageTimestamp = formatMessageTimestamp(props.item, props.language);
  const timestampSource = props.item.updatedAt ?? primitiveText(props.item.payload.createdAt);
  const canEdit = role === 'user' && props.isLatestUser && Boolean(props.onEdit) && !props.item.optimistic;
  const showRoleActions = role === 'user' || (role === 'assistant' && Boolean(props.showAssistantActions ?? props.isLatest));
  const remoteDeviceInput = role === 'user' && props.item.payload.inputOrigin === 'remote_device';
  const hasActions = !editing && showRoleActions && (Boolean(visibleText) || longUserMessage || Boolean(messageTimestamp) || canEdit);

  useEffect(() => {
    if (!editing) return;
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [editing]);

  useLayoutEffect(() => {
    if (!editing || !editTextareaRef.current) return;
    autosizeTextarea(editTextareaRef.current, 72, 0.48);
  }, [editDraft, editing]);

  useLayoutEffect(() => {
    if (adaptiveText.revision === 0) return;
    // 自适应流式文本在子组件内提交，通知会话容器重新检查底部跟随状态。
    props.onVisibleContentChange?.();
  }, [adaptiveText.revision, props.onVisibleContentChange]);

  useLayoutEffect(() => {
    if (!naturalLanguageStream || adaptiveText.revision === 0 || prefersReducedMotion()) return;
    const latestBlock = articleRef.current?.querySelector<HTMLElement>('.session-markdown > :last-child');
    const animation = latestBlock?.animate(
      [
        { opacity: 0.68, transform: 'translateY(2px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 140, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    return () => animation?.cancel();
  }, [adaptiveText.revision, naturalLanguageStream]);

  async function submitEditedMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!props.onEdit || !editDraft.trim() || submittingEdit) return;
    setEditError(null);
    setSubmittingEdit(true);
    try {
      await props.onEdit(props.item, editDraft);
      setEditing(false);
    } catch {
      setEditError(labels.editFailed);
    } finally {
      setSubmittingEdit(false);
    }
  }

  function cancelEditing(): void {
    setEditing(false);
    setEditError(null);
    setEditDraft('');
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEditing();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <article
      ref={articleRef}
      className={`session-thread-item session-thread-item-${role}${props.isLatest ? ' is-latest' : ''}${props.animateEntrance ? ' is-entering' : ''}${messageExpanded ? ' is-message-expanded' : ''}${hasActions ? ' has-message-actions' : ''}${editing ? ' is-editing' : ''}`}
      data-item-status={props.item.status}
      data-item-phase={props.item.phase}
      data-item-type={props.item.type}
      data-motion-block="markdown"
      aria-label={accessibleLabel}
    >
      {showMeta ? (
        <header className="session-thread-item-meta">
          {showVisibleRoleLabel ? <strong>{label}</strong> : null}
          {optimisticStatus ? (
            <span className="session-item-state" role="status" aria-live="polite" aria-atomic="true">
              {optimisticStatus}
            </span>
          ) : null}
        </header>
      ) : null}
      {showUserMessageAttachmentGroup ? (
        <div className="session-user-message-attachments">
          <ItemAttachments item={props.item} label={labels.attachments} hideImages={pendingImageAttachments.length > 0} />
          <ConversationPendingAttachmentImages attachments={pendingImageAttachments} language={props.language} onVisibleContentChange={props.onVisibleContentChange} />
          <ConversationResourceCards resources={unplacedResources} language={props.language} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
          <ItemImages item={props.item} label={labels.conversationImage} />
        </div>
      ) : null}
      {editing ? (
        <form className="session-user-message-editor" onSubmit={(event) => void submitEditedMessage(event)}>
          <label className="session-sr-only" htmlFor={`session-edit-${props.item.itemId}`}>
            {labels.editInput}
          </label>
          <textarea
            id={`session-edit-${props.item.itemId}`}
            ref={editTextareaRef}
            aria-keyshortcuts="Meta+Enter Control+Enter Escape"
            value={editDraft}
            disabled={submittingEdit}
            onChange={(event) => setEditDraft(event.currentTarget.value)}
            onKeyDown={handleEditKeyDown}
          />
          <footer>
            {editError ? <small role="alert">{editError}</small> : <span />}
            <button type="button" onClick={cancelEditing} disabled={submittingEdit}>
              {labels.cancelEdit}
            </button>
            <button type="submit" className="session-user-message-editor-submit" disabled={!editDraft.trim() || submittingEdit}>
              {labels.sendEdit}
            </button>
          </footer>
        </form>
      ) : role === 'image' ? (
        <GeneratedImageItem item={props.item} language={props.language} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} onVisibleContentChange={props.onVisibleContentChange} />
      ) : command ? (
        <CommandExecutionItem item={props.item} language={props.language} />
      ) : commentary && (visibleText || (streamActive && itemText)) ? (
        <div className="session-commentary-flow" data-streaming={(props.item.status !== 'completed' && props.item.status !== 'failed') || undefined}>
          <TranscriptMarkdown
            text={visibleText}
            sourceText={itemText}
            streaming={streamActive}
            language={props.language}
            resources={props.item.resources}
            onOpenResource={props.onOpenResource}
            onLoadResourcePreview={props.onLoadResourcePreview}
          />
        </div>
      ) : role === 'user' && taskPushLayout ? (
        <TaskPushMessageContent
          layout={taskPushLayout}
          resources={props.item.resources}
          pendingAttachments={hasAuthoritativeAttachmentResources ? [] : pendingAttachments}
          language={props.language}
          onOpenResource={props.onOpenResource}
          onLoadResourcePreview={props.onLoadResourcePreview}
          onVisibleContentChange={props.onVisibleContentChange}
        />
      ) : role === 'user' && visibleText ? (
        <SafeMarkdown text={visibleText} language={props.language} resources={props.item.resources} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
      ) : naturalLanguageStream && (visibleText || (streamActive && itemText)) ? (
        <TranscriptMarkdown
          text={visibleText}
          sourceText={itemText}
          streaming={streamActive}
          language={props.language}
          resources={props.item.resources}
          onOpenResource={props.onOpenResource}
          onLoadResourcePreview={props.onLoadResourcePreview}
        />
      ) : role === 'assistant' && props.item.status !== 'completed' ? (
        <span className="session-thinking-indicator">{labels.thinking}</span>
      ) : null}
      {!command ? <TypedItemFacts item={props.item} role={role} language={props.language} /> : null}
      {conversationContext ? <UserConversationContextSummary draft={conversationContext} language={props.language} /> : null}
      {!showUserMessageAttachmentGroup && !taskPushLayout ? <ItemAttachments item={props.item} label={labels.attachments} hideImages={pendingImageAttachments.length > 0} /> : null}
      {!showUserMessageAttachmentGroup ? <ConversationPendingAttachmentImages attachments={pendingImageAttachments} language={props.language} onVisibleContentChange={props.onVisibleContentChange} /> : null}
      {!showUserMessageAttachmentGroup && role !== 'image' ? (
        <ConversationResourceCards resources={unplacedResources} language={props.language} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
      ) : null}
      {!showUserMessageAttachmentGroup && !taskPushLayout ? <ItemImages item={props.item} label={labels.conversationImage} /> : null}
      {remoteDeviceInput ? (
        <span className="session-message-remote-origin" aria-label={labels.remoteDevice} title={labels.remoteDevice}>
          <MessageRemoteDeviceIcon />
        </span>
      ) : null}
      <ResponseSelectionActions
        articleRef={articleRef}
        itemId={props.item.itemId}
        enabled={role === 'assistant' && props.item.status === 'completed' && Boolean(visibleText) && Boolean(props.onAddResponseAnnotation || props.onOpenSideChat)}
        language={props.language}
        annotations={props.responseAnnotations ?? []}
        onAddAnnotation={props.onAddResponseAnnotation}
        onUpdateAnnotation={props.onUpdateResponseAnnotation}
        onRemoveAnnotation={props.onRemoveResponseAnnotation}
        onOpenSideChat={props.onOpenSideChat}
      />
      {hasActions ? (
        <footer className="session-thread-item-actions" data-message-actions={role}>
          {role === 'user' && messageTimestamp && timestampSource ? <MessageTimestamp dateTime={timestampSource} value={messageTimestamp} /> : null}
          {visibleText ? <CopyIconButton label={labels.copy} copiedLabel={labels.copied} text={itemText} /> : null}
          {role === 'assistant' ? (
            <>
              <MessageIconButton label={labels.good} pressed={feedback === 'good'} onClick={() => setFeedback((current) => (current === 'good' ? null : 'good'))}>
                <MessageThumbIcon direction="up" selected={feedback === 'good'} />
              </MessageIconButton>
              <MessageIconButton label={labels.bad} pressed={feedback === 'bad'} onClick={() => setFeedback((current) => (current === 'bad' ? null : 'bad'))}>
                <MessageThumbIcon direction="down" selected={feedback === 'bad'} />
              </MessageIconButton>
              <MessageIconButton label={messageExpanded ? labels.collapseMessage : labels.expandMessage} expanded={messageExpanded} onClick={() => setMessageExpanded((current) => !current)}>
                <MessageExpandIcon collapsed={messageExpanded} />
              </MessageIconButton>
              {messageTimestamp && timestampSource ? <MessageTimestamp dateTime={timestampSource} value={messageTimestamp} /> : null}
            </>
          ) : null}
          {role === 'user' && longUserMessage ? (
            <MessageIconButton label={expanded ? labels.collapse : labels.expand} expanded={expanded} onClick={() => setExpanded((current) => !current)}>
              <MessageExpandIcon collapsed={expanded} />
            </MessageIconButton>
          ) : null}
          {canEdit ? (
            <MessageIconButton
              label={labels.edit}
              onClick={() => {
                setEditDraft(itemText);
                setEditError(null);
                setEditing(true);
              }}
            >
              <MessageEditIcon />
            </MessageIconButton>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
});

interface TranscriptMarkdownProps {
  text: string;
  sourceText: string;
  streaming: boolean;
  language: SessionUiLanguage;
  resources?: ConversationResource[];
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
}

const TranscriptMarkdown = memo(function TranscriptMarkdown(props: TranscriptMarkdownProps) {
  const projection = useMemo(() => splitStreamingMarkdown(props.text, props.streaming), [props.streaming, props.text]);
  const streamKind = useMemo(() => markdownStreamKind(props.sourceText), [props.sourceText]);
  if (!props.streaming) {
    return <SafeMarkdown text={props.text} language={props.language} resources={props.resources} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />;
  }
  if (!props.text.trim()) {
    return <StreamingMarkdownPlaceholder kind={streamKind} language={props.language} />;
  }
  return (
    <div className="session-streaming-markdown">
      {projection.stableBlocks.map((block, index) => (
        <SafeMarkdown key={`stable-${index}`} text={block} language={props.language} resources={props.resources} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
      ))}
      {projection.tail ? (
        projection.tailKind === 'table' || projection.tailKind === 'fence' ? (
          <StreamingMarkdownPlaceholder kind={projection.tailKind} language={props.language} />
        ) : (
          <SafeMarkdown key={`tail-${projection.stableBlocks.length}`} text={projection.tail} language={props.language} resources={props.resources} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
        )
      ) : null}
    </div>
  );
});

function StreamingMarkdownPlaceholder(props: { kind: 'plain' | 'table' | 'fence'; language: SessionUiLanguage }): ReactNode {
  const label =
    props.language === 'zh-CN'
      ? props.kind === 'table'
        ? '正在整理表格'
        : props.kind === 'fence'
          ? '正在整理代码块'
          : '正在整理内容'
      : props.kind === 'table'
        ? 'Preparing table'
        : props.kind === 'fence'
          ? 'Preparing code block'
          : 'Preparing content';
  return (
    <div className={`session-streaming-markdown-placeholder is-${props.kind}`} role="status" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  );
}

interface StreamingMarkdownProjection {
  stableBlocks: string[];
  tail: string;
  tailKind: 'plain' | 'table' | 'fence';
}

function splitStreamingMarkdown(text: string, streaming: boolean): StreamingMarkdownProjection {
  if (!streaming) return { stableBlocks: [], tail: text, tailKind: markdownStreamKind(text) };
  const normalized = text.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  const blocks: string[] = [];
  let blockStart = 0;
  let fenceMarker: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = line.match(/^\s*(`{3,}|~{3,})/u)?.[1] ?? null;
    if (fenceMarker) {
      if (fence && fence[0] === fenceMarker[0] && fence.length >= fenceMarker.length) {
        fenceMarker = null;
        blocks.push(lines.slice(blockStart, index + 1).join('\n'));
        blockStart = index + 1;
      }
      continue;
    }
    if (fence) {
      fenceMarker = fence;
      continue;
    }
    if (!line.trim() && index > blockStart) {
      blocks.push(lines.slice(blockStart, index).join('\n'));
      blockStart = index + 1;
    }
  }
  const tail = lines.slice(blockStart).join('\n').trim();
  const stableBlocks = blocks.map((block) => block.trim()).filter(Boolean);
  return { stableBlocks, tail, tailKind: markdownStreamKind(tail) };
}

function markdownStreamKind(text: string): 'plain' | 'table' | 'fence' {
  if (!text.trim()) return 'plain';
  const lines = text.trim().split('\n');
  const fenceCount = lines.filter((line) => /^\s*(`{3,}|~{3,})/u.test(line)).length;
  if (fenceCount % 2 === 1) return 'fence';
  if (lines.length >= 2 && /\|/u.test(lines[0] ?? '') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(lines[1] ?? '')) return 'table';
  return 'plain';
}

export const SafeMarkdown = memo(function SafeMarkdown(props: {
  text: string;
  language?: SessionUiLanguage;
  resources?: ConversationResource[];
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
}) {
  const bounded = boundedMarkdownText(props.text);
  const labels = copy[props.language ?? 'en-US'];
  const resources = props.resources ?? emptyConversationResources;
  const language = props.language ?? 'en-US';
  const components = useMemo<Components>(
    () => ({
      a({ children, href }) {
        const label = markdownNodeText(children);
        const resource = matchingInlineResource(resources, label, href ?? '');
        if (resource) {
          return <ConversationInlineResource resource={resource} label={label || resource.displayName} language={language} onOpenResource={props.onOpenResource} />;
        }
        if (href?.startsWith('#')) return <a href={href}>{children}</a>;
        return (
          <span className="session-markdown-unavailable-resource" title={href}>
            {children}
          </span>
        );
      },
      img({ alt, src, title }) {
        const label = alt?.trim() || title?.trim() || (language === 'zh-CN' ? '图片' : 'Image');
        const resource = matchingInlineResource(resources, label, src ?? '');
        if (!resource || !isImageResource(resource)) {
          return (
            <span className="session-markdown-image-unavailable" role="img" aria-label={label}>
              {language === 'zh-CN' ? `图片不可用：${label}` : `Image unavailable: ${label}`}
            </span>
          );
        }
        return <ConversationMarkdownImage resource={resource} label={label} language={language} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />;
      },
      pre({ children }) {
        const code = markdownNodeText(children);
        return (
          <div className="session-code-block">
            <CopyIconButton label={labels.copyCode} copiedLabel={labels.copied} text={code} />
            <pre>{children}</pre>
          </div>
        );
      },
    }),
    [labels.copied, labels.copyCode, language, props.onLoadResourcePreview, props.onOpenResource, resources],
  );
  return (
    <div className="session-markdown zeus-fidelity-markdown" data-truncated={bounded.truncated || undefined}>
      <Markdown components={components} remarkPlugins={[remarkGfm, [limitMarkdownComplexity, { label: labels.complexityTruncated }]]} urlTransform={(url) => url}>
        {boundMarkdownCodeBlocks(bounded.text)}
      </Markdown>
    </div>
  );
});

const emptyConversationResources: ConversationResource[] = [];

export function boundedMarkdownText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MARKDOWN_CHARACTERS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_MARKDOWN_CHARACTERS)}\n\n[content truncated]`, truncated: true };
}

export function boundedMarkdownBlockText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MARKDOWN_BLOCK_CHARACTERS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_MARKDOWN_BLOCK_CHARACTERS)}\n[block truncated]`, truncated: true };
}

interface MarkdownAstNode {
  type: string;
  children?: MarkdownAstNode[];
}

function limitMarkdownComplexity(options?: { label?: string }) {
  return (tree: MarkdownAstNode): void => {
    const rootChildren = tree.children ?? [];
    let truncated = rootChildren.length > MAX_MARKDOWN_BLOCKS;
    let remainingNodes = MAX_MARKDOWN_NODES;

    function limitNode(node: MarkdownAstNode): boolean {
      if (remainingNodes <= 0) return false;
      remainingNodes -= 1;
      if (!node.children) return true;
      const limitedChildren: MarkdownAstNode[] = [];
      for (const child of node.children) {
        if (!limitNode(child)) {
          truncated = true;
          break;
        }
        limitedChildren.push(child);
      }
      if (limitedChildren.length !== node.children.length) truncated = true;
      node.children = limitedChildren;
      return true;
    }

    tree.children = rootChildren.slice(0, MAX_MARKDOWN_BLOCKS).filter(limitNode);
    if (tree.children.length !== rootChildren.length) truncated = true;
    if (truncated) {
      tree.children.push({
        type: 'paragraph',
        children: [{ type: 'text', value: options?.label ?? 'Content complexity truncated' } as MarkdownAstNode],
        data: { hProperties: { className: ['session-markdown-complexity-truncated'], role: 'status' } },
      } as MarkdownAstNode);
    }
  };
}

function boundMarkdownCodeBlocks(text: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const output: string[] = [];
  let fence: string | null = null;
  let codeCharacters = 0;
  let blockTruncated = false;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1] ?? null;
    if (!fence && marker) {
      fence = marker;
      codeCharacters = 0;
      blockTruncated = false;
      output.push(line);
      continue;
    }
    if (fence && marker?.startsWith(fence[0]!) && marker.length >= fence.length) {
      if (blockTruncated) output.push('[code block truncated]');
      output.push(line);
      fence = null;
      continue;
    }
    if (!fence) {
      output.push(line);
      continue;
    }
    const remaining = MAX_MARKDOWN_BLOCK_CHARACTERS - codeCharacters;
    if (remaining > 0) output.push(line.slice(0, remaining));
    codeCharacters += line.length + 1;
    if (codeCharacters > MAX_MARKDOWN_BLOCK_CHARACTERS) blockTruncated = true;
  }
  if (fence && blockTruncated) output.push('[code block truncated]');
  return output.join('\n');
}

function markdownNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(markdownNodeText).join('');
  if (!node || typeof node !== 'object' || !('props' in node)) return '';
  return markdownNodeText((node as { props?: { children?: ReactNode } }).props?.children);
}

function matchingInlineResource(resources: ConversationResource[], label: string, href: string): ConversationResource | null {
  return resources.find((resource) => resource.presentation === 'inline' && inlineResourceMatches(resource, label, href)) ?? null;
}

function inlineResourceMatches(resource: ConversationResource, label: string, href: string): boolean {
  if (resource.kind === 'website') {
    try {
      return new URL(href).href === resource.url;
    } catch {
      return resource.displayName === label;
    }
  }
  if (resource.kind === 'attachment') return resource.displayName === label;
  const reference = decodeReferencePath(href);
  return (
    resource.displayName === label ||
    reference.endsWith(resource.projectRelativePath) ||
    reference.endsWith(`/${resource.projectRelativePath}`) ||
    reference
      .split('/')
      .pop()
      ?.replace(/(?::\d+(?::\d+)?)|(?:#L\d+(?:-L?\d+)?)$/u, '') === resource.projectRelativePath.split('/').pop()
  );
}

function decodeReferencePath(href: string): string {
  let value = href
    .replace(/^file:\/\//iu, '')
    .replace(/#L\d+(?:-L?\d+)?$/iu, '')
    .replace(/:\d+(?::\d+)?$/u, '');
  try {
    value = decodeURIComponent(value);
  } catch {
    // 保留原始 href 参与末尾匹配；非法编码不会得到打开权限。
  }
  return value;
}

export function itemRole(item: NativeSessionItemBuffer): ThreadItemRole {
  const type = normalizeType(item.type);
  if (type === 'usermessage' || type === 'user') return 'user';
  if (type === 'agentmessage' || type === 'assistantmessage' || type === 'assistant' || type === 'message') return 'assistant';
  if (type === 'reasoning' || type === 'plan' || type === 'commentary' || type === 'analysis') return 'commentary';
  if (type === 'filechange' || type === 'file') return 'file';
  if (type === 'imagegeneration') return item.status === 'failed' ? 'error' : 'image';
  if (['commandexecution', 'command', 'mcptoolcall', 'dynamictoolcall', 'websearch', 'imageview', 'toolcall', 'tool'].includes(type)) return 'tool';
  if (type.includes('request') || type.includes('approval')) return 'request';
  if (type === 'error' || type.endsWith('error') || item.status === 'failed') return 'error';
  return 'unknown';
}

export function transcriptItemText(item: NativeSessionItemBuffer): string {
  if (typeof item.payload.displayText === 'string' && item.payload.displayText.trim()) return item.payload.displayText;
  if (normalizeType(item.type) === 'reasoning') {
    if (item.text.trim()) return item.text;
    return transcriptTextFragments(item.payload.summary).join('\n\n');
  }
  if (item.text.trim()) return item.text;
  if (itemRole(item) !== 'commentary') return item.text;
  return transcriptTextFragments([item.payload.summary, item.payload.content]).join('\n\n');
}

type AdaptiveFlushMode = 'semantic' | 'chunk' | 'catch_up' | 'idle' | 'max_wait';

function useAdaptiveTranscriptText(text: string, enabled: boolean): { text: string; revision: number } {
  const [visible, setVisible] = useState(() => ({ text, revision: 0 }));
  const visibleTextRef = useRef(text);
  const targetTextRef = useRef(text);
  const previousTargetTextRef = useRef(text);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const structuredIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearShortTimers(): void {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    idleTimerRef.current = null;
    maxTimerRef.current = null;
  }

  function clearTimers(): void {
    clearShortTimers();
    if (structuredIdleTimerRef.current) clearTimeout(structuredIdleTimerRef.current);
    structuredIdleTimerRef.current = null;
  }

  function commitVisibleText(next: string): void {
    if (next === visibleTextRef.current) return;
    clearShortTimers();
    if (next === targetTextRef.current && structuredIdleTimerRef.current) {
      clearTimeout(structuredIdleTimerRef.current);
      structuredIdleTimerRef.current = null;
    }
    visibleTextRef.current = next;
    setVisible((current) => ({ text: next, revision: current.revision + 1 }));
  }

  function commitTarget(mode: AdaptiveFlushMode): boolean {
    const target = targetTextRef.current;
    const current = visibleTextRef.current;
    if (!target.startsWith(current)) {
      commitVisibleText(target);
      return true;
    }
    const safeEnd = structuredTailStart(target, current.length) ?? target.length;
    if (safeEnd <= current.length) return false;
    const safePending = target.slice(current.length, safeEnd);
    const commitLength = adaptiveCommitLength(safePending, mode);
    if (commitLength <= 0) return false;
    commitVisibleText(target.slice(0, current.length + commitLength));
    return true;
  }

  useEffect(() => {
    const previousTarget = previousTargetTextRef.current;
    previousTargetTextRef.current = text;
    targetTextRef.current = text;
    if (structuredIdleTimerRef.current) {
      clearTimeout(structuredIdleTimerRef.current);
      structuredIdleTimerRef.current = null;
    }
    const prefixCompatible = text.startsWith(visibleTextRef.current);
    if (!enabled || !prefixCompatible) {
      clearTimers();
      commitVisibleText(text);
      return;
    }
    if (text === visibleTextRef.current) {
      clearTimers();
      return;
    }
    const addedCharacters = text.startsWith(previousTarget) ? text.length - previousTarget.length : text.length - visibleTextRef.current.length;
    commitTarget('semantic');
    if (text === visibleTextRef.current) return;
    if (addedCharacters >= STREAM_IMMEDIATE_CHUNK_CHARACTERS) commitTarget('chunk');
    if (text === visibleTextRef.current) return;
    const pendingText = text.slice(visibleTextRef.current.length);
    if (pendingText.length >= STREAM_CATCH_UP_CHARACTERS) commitTarget('catch_up');
    if (text === visibleTextRef.current) return;
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      commitTarget('idle');
    }, STREAM_IDLE_FLUSH_MS);
    maxTimerRef.current ??= setTimeout(() => {
      maxTimerRef.current = null;
      commitTarget('max_wait');
    }, STREAM_MAX_FLUSH_MS);
    if (structuredTailStart(text, visibleTextRef.current.length) !== null) {
      structuredIdleTimerRef.current = setTimeout(() => {
        structuredIdleTimerRef.current = null;
        commitVisibleText(targetTextRef.current);
      }, STREAM_STRUCTURED_IDLE_FLUSH_MS);
    }
  }, [enabled, text]);

  useEffect(() => () => clearTimers(), []);

  return visible;
}

function adaptiveCommitLength(value: string, mode: AdaptiveFlushMode): number {
  if (!value) return 0;
  if (mode === 'chunk') return value.length;
  const semanticBoundary = lastSemanticFlushBoundary(value);
  if (semanticBoundary > 0) return semanticBoundary;
  if (mode === 'semantic') return 0;
  if ((mode === 'idle' || mode === 'max_wait') && value.length < STREAM_MIN_BATCH_CHARACTERS) return 0;
  if (mode === 'catch_up' && value.length < STREAM_CATCH_UP_CHARACTERS) return 0;
  return readableBatchBoundary(value);
}

function lastSemanticFlushBoundary(value: string): number {
  const matches = value.matchAll(/(?:\n|[。！？；!?;](?:\s|$)|\.(?:\s|$))/gu);
  let boundary = 0;
  for (const match of matches) boundary = (match.index ?? 0) + match[0].length;
  return boundary;
}

function readableBatchBoundary(value: string): number {
  for (let index = value.length - 1; index >= STREAM_MIN_BATCH_CHARACTERS; index -= 1) {
    if (/\s/u.test(value[index] ?? '')) return index + 1;
  }
  return value.length;
}

function structuredTailStart(value: string, visibleLength: number): number | null {
  const lineStart = Math.max(visibleLength, value.lastIndexOf('\n') + 1);
  const tail = value.slice(lineStart);
  const candidates: number[] = [];
  const markdownLinkTarget = tail.lastIndexOf('](');
  if (markdownLinkTarget >= 0 && tail.indexOf(')', markdownLinkTarget + 2) < 0) {
    const labelStart = tail.lastIndexOf('[', markdownLinkTarget);
    candidates.push(lineStart + (labelStart >= 0 ? labelStart : markdownLinkTarget));
  }
  const bracketStart = tail.lastIndexOf('[');
  if (bracketStart > tail.lastIndexOf(']')) candidates.push(lineStart + Math.max(0, bracketStart - (tail[bracketStart - 1] === '!' ? 1 : 0)));
  const inlineCodeTicks = [...tail.matchAll(/(?<!`)`(?!`)/gu)];
  if (inlineCodeTicks.length % 2 === 1) candidates.push(lineStart + (inlineCodeTicks.at(-1)?.index ?? 0));
  const pathMatch = tail.match(/(?:^|[\s[(<{])((?:file:\/\/|https?:\/\/|~\/|\.{1,2}\/|\/(?:[^/\s)]+\/)+|[A-Za-z]:[\\/])[^\s)]*)$/u);
  if (pathMatch?.index !== undefined) candidates.push(lineStart + pathMatch.index + pathMatch[0].length - pathMatch[1].length);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function transcriptTextFragments(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => transcriptTextFragments(entry, depth + 1));
  if (!isRecord(value)) return [];
  return ['text', 'value', 'content', 'summary'].flatMap((key) => transcriptTextFragments(value[key], depth + 1));
}

function normalizeType(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_\-/]+/g, '');
}
function roleLabel(role: ThreadItemRole, labels: (typeof copy)[SessionUiLanguage]): string {
  return labels[role];
}

function TypedItemFacts(props: { item: NativeSessionItemBuffer; role: ThreadItemRole; language: SessionUiLanguage }) {
  if (props.role === 'user' || props.role === 'assistant' || props.role === 'commentary' || props.role === 'image') return null;
  const facts = itemFacts(props.item, props.role);
  if (facts.length === 0 && props.role !== 'unknown') return null;
  return (
    <details className="session-item-facts">
      <summary>{copy[props.language].details}</summary>
      {facts.length > 0 ? (
        <dl>
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {props.role === 'unknown' || props.role === 'error' ? <pre>{safePayloadJson(props.item.payload)}</pre> : null}
    </details>
  );
}

function GeneratedImageItem(props: {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  onVisibleContentChange?: () => void;
}) {
  if (props.item.status !== 'completed') {
    return (
      <div className="session-generated-image-progress" role="status">
        <span className="session-thinking-indicator">{props.language === 'zh-CN' ? '正在生成图片' : 'Generating image'}</span>
      </div>
    );
  }
  const images = props.item.resources.filter(isImageResource);
  if (images.length === 0) {
    return (
      <div className="session-generated-image-unavailable" role="status">
        {props.language === 'zh-CN' ? '生成图片文件不可用' : 'Generated image file unavailable'}
      </div>
    );
  }
  return (
    <div className="session-generated-image-list">
      {images.map((resource, index) => (
        <ConversationGeneratedImage
          key={resource.id}
          resource={resource}
          label={images.length > 1 ? `${copy[props.language].image} ${index + 1}` : copy[props.language].image}
          language={props.language}
          onOpenResource={props.onOpenResource}
          onLoadResourcePreview={props.onLoadResourcePreview}
          onVisibleContentChange={props.onVisibleContentChange}
        />
      ))}
    </div>
  );
}

function CommandExecutionItem(props: { item: NativeSessionItemBuffer; language: SessionUiLanguage }) {
  const payload = props.item.payload;
  const command = commandText(payload.command) ?? (props.item.text.trim() || null);
  const cwd = primitiveText(payload.cwd);
  const status = primitiveText(payload.status) ?? props.item.status;
  const exitCode = primitiveText(payload.exitCode);
  const duration = typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs) ? `${Math.max(0, Math.round(payload.durationMs))} ms` : null;
  const output = primitiveText(payload.aggregatedOutput ?? payload.output ?? payload.stdout ?? payload.stderr);
  const copyLabel = copy[props.language].copyCommand;
  const outputLabel = props.language === 'zh-CN' ? '命令输出' : 'Command output';
  const cwdLabel = props.language === 'zh-CN' ? '工作目录' : 'Working directory';

  return (
    <section className="session-command-item" aria-label={props.language === 'zh-CN' ? '命令执行' : 'Command execution'}>
      <details className="session-command-disclosure">
        <summary className="session-command-summary">
          <span className="session-command-terminal-icon" aria-hidden="true">
            <TerminalWindow weight="regular" />
          </span>
          <span className="session-command-summary-copy">
            <strong>{props.language === 'zh-CN' ? '命令执行' : 'Command execution'}</strong>
            {command ? <code>{command}</code> : null}
          </span>
          <span className="session-command-status" data-status={status}>
            {status}
          </span>
        </summary>
        <div className="session-command-body">
          {command ? <code className="session-command-line">{command}</code> : null}
          <dl className="session-command-meta">
            {cwd ? (
              <div>
                <dt>{cwdLabel}</dt>
                <dd>{cwd}</dd>
              </div>
            ) : null}
            <div>
              <dt>{props.language === 'zh-CN' ? '状态' : 'Status'}</dt>
              <dd>{status}</dd>
            </div>
            {duration ? (
              <div>
                <dt>{props.language === 'zh-CN' ? '耗时' : 'Duration'}</dt>
                <dd>{duration}</dd>
              </div>
            ) : null}
            {exitCode ? (
              <div>
                <dt>{props.language === 'zh-CN' ? '退出码' : 'Exit code'}</dt>
                <dd>{exitCode}</dd>
              </div>
            ) : null}
          </dl>
          {output ? (
            <section className="session-command-output" aria-label={outputLabel}>
              <strong>{outputLabel}</strong>
              <pre>{output}</pre>
            </section>
          ) : null}
        </div>
      </details>
      {command ? <CopyIconButton label={copyLabel} copiedLabel={copy[props.language].copied} text={command} /> : null}
    </section>
  );
}

function CopyIconButton(props: { label: string; copiedLabel: string; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="session-copy-button"
      aria-label={copied ? props.copiedLabel : props.label}
      title={copied ? props.copiedLabel : props.label}
      data-copied={copied || undefined}
      onClick={async () => setCopied(await copyText(props.text))}
    >
      {copied ? <MessageCheckIcon /> : <Copy aria-hidden="true" weight="regular" />}
    </button>
  );
}

function MessageIconButton(props: { label: string; pressed?: boolean; expanded?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="session-message-action-button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      aria-expanded={props.expanded === undefined ? undefined : props.expanded}
      data-selected={props.pressed || undefined}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function MessageTimestamp(props: { dateTime: string; value: string }) {
  return (
    <time className="session-message-timestamp" dateTime={props.dateTime}>
      {props.value}
    </time>
  );
}

function formatMessageTimestamp(item: NativeSessionItemBuffer, language: SessionUiLanguage): string | null {
  const source = item.updatedAt ?? primitiveText(item.payload.createdAt);
  if (!source) return null;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function commandText(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string' && Boolean(part.trim()));
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return primitiveText(value);
}

function itemFacts(item: NativeSessionItemBuffer, role: ThreadItemRole): Array<[string, string]> {
  const payload = item.payload;
  const pairs: Array<[string, unknown]> =
    role === 'file'
      ? [
          ['Path', payload.path ?? payload.filePath],
          ['Action', payload.action ?? payload.changeType],
          ['Status', payload.status ?? item.status],
        ]
      : role === 'tool'
        ? [
            ['Tool', payload.toolName ?? payload.name ?? payload.server],
            ['Command', Array.isArray(payload.command) ? payload.command.join(' ') : payload.command],
            ['Working directory', payload.cwd],
            ['Path', payload.path ?? payload.filePath ?? payload.imagePath],
            ['Query', payload.query],
            ['URL', payload.url],
            ['Status', payload.status ?? item.status],
          ]
        : role === 'error'
          ? [
              ['Code', payload.code],
              ['Message', payload.message ?? item.text],
              ['Status', item.status],
            ]
          : role === 'request'
            ? [
                ['Request', payload.requestType ?? payload.type ?? item.type],
                ['Status', item.status],
              ]
            : [
                ['Provider type', item.type],
                ['Status', item.status],
              ];
  return pairs.flatMap(([label, value]) => (primitiveText(value) ? [[label, primitiveText(value)!]] : []));
}

function ItemAttachments(props: { item: NativeSessionItemBuffer; label: string; hideImages?: boolean }) {
  if (props.item.resources.some((resource) => resource.kind === 'attachment' && resource.presentation === 'card')) return null;
  const raw = Array.isArray(props.item.payload.attachments) ? props.item.payload.attachments : [];
  const attachments = raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const mime = primitiveText(entry.mime ?? entry.mimeType);
    const kind = primitiveText(entry.kind);
    if (props.hideImages && (kind === 'image' || mime?.startsWith('image/'))) return [];
    const name = primitiveText(entry.name ?? entry.path ?? entry.filePath);
    if (!name) return [];
    return [{ name, meta: [mime, primitiveText(entry.status)].filter(Boolean).join(' · ') }];
  });
  return attachments.length ? (
    <section className="session-item-attachments" aria-label={props.label}>
      <ul>
        {attachments.map((entry, index) => (
          <li key={`${entry.name}-${index}`}>
            <span>{entry.name}</span>
            {entry.meta ? <small>{entry.meta}</small> : null}
          </li>
        ))}
      </ul>
    </section>
  ) : null;
}

function nativeConversationAttachments(value: unknown): NativeConversationAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = typeof entry.name === 'string' ? entry.name : '';
    const mime = typeof entry.mime === 'string' ? entry.mime : '';
    const size = typeof entry.size === 'number' ? entry.size : NaN;
    const localPath = typeof entry.localPath === 'string' && entry.localPath ? entry.localPath : undefined;
    const uploadRef = typeof entry.uploadRef === 'string' && entry.uploadRef ? entry.uploadRef : undefined;
    if (!name || !mime || !Number.isSafeInteger(size) || size < 0 || (localPath ? 1 : 0) + (uploadRef ? 1 : 0) !== 1) return [];
    const kind = entry.kind === 'image' || entry.kind === 'file' || entry.kind === 'directory' || entry.kind === 'pasted_text' ? entry.kind : undefined;
    const taskPushAttachmentKey = typeof entry.taskPushAttachmentKey === 'string' && entry.taskPushAttachmentKey ? entry.taskPushAttachmentKey : undefined;
    return [
      {
        name,
        mime,
        size,
        ...(kind ? { kind } : {}),
        ...(taskPushAttachmentKey ? { taskPushAttachmentKey } : {}),
        ...(localPath ? { localPath } : { uploadRef: uploadRef! }),
      } as NativeConversationAttachment,
    ];
  });
}

function ItemImages(props: { item: NativeSessionItemBuffer; label: string }) {
  const images = Array.isArray(props.item.payload.images) ? props.item.payload.images : [];
  const safeImages = images.filter((value): value is string => typeof value === 'string' && (value.startsWith('data:image/') || value.startsWith('file://')));
  return safeImages.length > 0 ? (
    <div className="session-item-images">
      {safeImages.map((source) => (
        <img key={source} src={source} alt={props.label} loading="lazy" />
      ))}
    </div>
  ) : null;
}

function safePayloadJson(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2).slice(0, 20_000);
  } catch {
    return '[unavailable]';
  }
}

function conversationContextDraft(value: unknown): ConversationContextDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.responseAnnotations) || !Array.isArray(record.codeComments)) return null;
  return record as unknown as ConversationContextDraft;
}

function UserConversationContextSummary(props: { draft: ConversationContextDraft; language: SessionUiLanguage }) {
  const annotations = props.draft.responseAnnotations.length;
  const comments = props.draft.codeComments.length;
  if (!annotations && !comments) return null;
  const zh = props.language === 'zh-CN';
  const label = zh
    ? [comments ? `${comments} 个评论` : '', annotations ? `${annotations} 条注释` : ''].filter(Boolean).join('、')
    : [comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : '', annotations ? `${annotations} ${annotations === 1 ? 'annotation' : 'annotations'}` : ''].filter(Boolean).join(', ');
  return <span className="session-message-context-summary">{label}</span>;
}
function primitiveText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export async function copyText(
  text: string,
  services: {
    writeNative?: (value: string) => Promise<{ written: boolean } | undefined>;
    writeWeb?: (value: string) => Promise<void>;
    writeLegacy?: (value: string) => boolean;
  } = {},
): Promise<boolean> {
  const writeNative = services.writeNative ?? ((value: string) => globalThis.window?.zeus?.writeClipboardText?.(value));
  try {
    const result = await writeNative(text);
    if (result?.written) return true;
  } catch {
    // 原生桥不可用时继续尝试浏览器与选区兜底。
  }
  const writeWeb = services.writeWeb ?? globalThis.navigator?.clipboard?.writeText?.bind(globalThis.navigator.clipboard);
  try {
    if (writeWeb) {
      await writeWeb(text);
      return true;
    }
  } catch {
    // file:// 页面通常没有 Clipboard API 权限，继续使用同步选区兜底。
  }
  return (services.writeLegacy ?? copyTextWithSelection)(text);
}

function copyTextWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false;
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.inset = '0 auto auto -10000px';
  textarea.style.opacity = '0';
  textarea.style.position = 'fixed';
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
  return copied;
}
