import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { type AnimationEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import { ArchiveIcon as Archive } from '@phosphor-icons/react/dist/csr/Archive';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { ClockIcon as Clock } from '@phosphor-icons/react/dist/csr/Clock';
import { EyeSlashIcon as EyeSlash } from '@phosphor-icons/react/dist/csr/EyeSlash';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { PauseCircleIcon as PauseCircle } from '@phosphor-icons/react/dist/csr/PauseCircle';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { WarningIcon as Warning } from '@phosphor-icons/react/dist/csr/Warning';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { NativeConversationChoice, NativeSessionState } from './sessionTypes.js';
import { compareConversationWorkStartedDesc, parseModelRef } from '@zeus/shared';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { conversationDisplayTitle } from './conversationDisplayTitle.js';
import { hasPendingAsyncQuestion } from './AsyncQuestionMessage.js';
import { useListReorderMotion } from '../ui/useListReorderMotion.js';
import { useNewItemMotionIds } from '../ui/useNewItemMotion.js';
import type { TaskAgentRunStatus } from '../apiClient.js';
import { taskAgentRunStatusLabels } from '../task/TaskRunStatusChip.js';
import { beginConversationNavigationTrace } from '../performanceTraceContext.js';
import { ConversationContextMenu, type ConversationContextMenuLanguage } from './ConversationContextMenu.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { Button } from '../ui/Button.js';
import { builtinModelProviderName, ModelProviderBadge, useModelProviderAppearances } from '../modelProviderAppearance.js';

export interface ProjectConversationTaskGroup {
  taskId: string;
  taskCode: string;
  taskTitle: string;
  managementStatus: string;
  /** 只有尚未结束的任务可以从会话行标记完成。 */
  canComplete?: boolean;
  conversations: NativeConversationChoice[];
}

export interface ProjectConversationStatusDefinition {
  id: string;
  label: string;
}

export interface ProjectConversationGroup {
  projectId: string;
  projectName: string;
  conversations?: NativeConversationChoice[];
  taskStatuses: ProjectConversationStatusDefinition[];
  tasks: ProjectConversationTaskGroup[];
}

export type ConversationTreeRuntimeState = 'connecting' | 'reconnecting' | 'paused' | 'queued' | 'ready' | 'streaming' | 'pending_approval' | 'pending_user_input' | 'error' | 'legacy_readonly';

export interface ProjectConversationTreeProps {
  groups: ProjectConversationGroup[];
  selectedConversationId?: string | null;
  conversationStates?: Record<string, ConversationTreeRuntimeState>;
  onSelectConversation: (conversation: NativeConversationChoice) => void;
  /** 悬停和键盘焦点可提高目标会话的预取优先级。 */
  onPrepareConversation?: (conversationId: string) => void;
  onStartConversation?: (taskId: string) => void;
  onArchiveConversation?: (conversation: NativeConversationChoice) => Promise<void> | void;
  /** 请求把关联任务移到其配置的完成状态。 */
  onCompleteTask?: (taskId: string) => Promise<void>;
  /** 重命名会话 */
  onRenameConversation?: (conversation: NativeConversationChoice, newTitle: string) => Promise<void> | void;
  language: SessionUiLanguage;
  compactProjectLabel?: boolean;
  query?: string;
  showEmptyState?: boolean;
  /** 普通会话的展示数量，进行中的会话不占用此额度。 */
  visibleConversationCount?: number;
  onShowMore?: () => void;
}

/** 会话树标题、运行状态和快捷操作的界面文案。 */
const labels = {
  'zh-CN': {
    aria: '项目会话',
    empty: '暂无会话',
    newThread: '新建会话',
    selectTask: '选择任务',
    ready: '会话就绪',
    /** 工作区图标的提示与读屏文案。 */
    workspaceMode: { worktree: '工作树', direct: '项目目录' },
    connecting: '正在连接',
    reconnecting: '正在重连',
    paused: '处理已暂停',
    queued: '待发送',
    streaming: '正在响应',
    pending_approval: '等待批准',
    pending_user_input: '需要用户输入',
    error: '会话错误',
    legacy_readonly: '旧会话，只读',
    archive: '归档会话',
    archiveLegacyUnavailable: '旧版只读会话无法与 Codex 线程同步归档',
    archiving: '正在归档',
    completeTask: '将任务标记为已完成',
    completingTask: '正在完成任务',
    showMore: '展开更多',
  },
  'en-US': {
    aria: 'Project conversations',
    empty: 'No conversations yet',
    newThread: 'New conversation',
    selectTask: 'Choose task',
    ready: 'Thread ready',
    /** 工作区图标的提示与读屏文案。 */
    workspaceMode: { worktree: 'Worktree', direct: 'Project folder' },
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    paused: 'Processing paused',
    queued: 'Queued',
    streaming: 'Responding',
    pending_approval: 'Approval required',
    pending_user_input: 'User input required',
    error: 'Thread error',
    legacy_readonly: 'Legacy, read-only',
    archive: 'Archive conversation',
    archiveLegacyUnavailable: 'Legacy read-only conversations cannot be archived together with their Codex thread',
    archiving: 'Archiving',
    completeTask: 'Mark task as completed',
    completingTask: 'Completing task',
    showMore: 'Show more',
  },
} as const;

interface FlattenedConversation {
  conversation: NativeConversationChoice;
  displayTitle: string;
  /** 平铺后保留关联任务是否可以完成。 */
  canCompleteTask?: boolean;
}

/** 按会话更新时间平铺项目内容，键盘导航只包含当前可见项。 */
export function ProjectConversationTree(props: ProjectConversationTreeProps) {
  const copy = labels[props.language];
  const providerAppearances = useModelProviderAppearances();
  /** 行末共用位置只显示当前动作的进度。 */
  const [pendingRowAction, setPendingRowAction] = useState<{ conversationId: string; label: string } | null>(null);
  /** 失败提示归属于触发操作的会话行。 */
  const [rowActionError, setRowActionError] = useState<{ conversationId: string; error: unknown } | null>(null);
  /** 在绘制禁用态之前也阻止重复点击。 */
  const rowActionRequestRef = useRef(false);
  /** 右键菜单状态 */
  const [contextMenuState, setContextMenuState] = useState<{
    conversation: NativeConversationChoice;
    position: { x: number; y: number };
  } | null>(null);
  const normalizedQuery = props.query?.trim().toLocaleLowerCase() ?? '';
  /** 搜索命中全部展示；数量限制只折叠普通会话，进行中的会话始终保留。 */
  const flattenedGroups = props.groups.map((project) => {
    /** 过滤后的完整列表同时作为“展开更多”的计数依据。 */
    const conversations = flattenProjectConversations(project, normalizedQuery, props.language);
    /** 每个项目单独计算普通会话额度，展开更多仍追加相同数量的普通会话。 */
    let ordinaryConversationCount = 0;
    return {
      project,
      conversations,
      visibleConversations:
        normalizedQuery || props.visibleConversationCount === undefined
          ? conversations
          : conversations.filter(({ conversation }) => {
              /** 与侧栏运行图标一致，执行、排队及连接阶段都不能被数量限制隐藏。 */
              const runStatus = taskRunStatusFromConversationTreeState(resolveConversationTreeRuntimeState(conversation, props.conversationStates));
              if (runStatus === 'running' || runStatus === 'connecting' || runStatus === 'reconnecting') return true;
              return ordinaryConversationCount++ < Math.max(0, props.visibleConversationCount!);
            }),
    };
  });
  /** 焦点和上下键导航沿用实际展示的顺序。 */
  const visibleConversations = flattenedGroups.flatMap((group) => group.visibleConversations);
  const conversationIds = visibleConversations.map((entry) => conversationNavigationId(entry.conversation));
  /** 仅在可见成员或顺序变化时平移原有行，状态图标刷新不重启动效。 */
  const conversationListRef = useListReorderMotion<HTMLElement>(JSON.stringify(conversationIds));
  const allConversationIds = props.groups.flatMap((project) => flattenProjectConversations(project, '', props.language).map((entry) => conversationNavigationId(entry.conversation)));
  const enteringConversationIds = useNewItemMotionIds(allConversationIds);
  const fallbackTabStopId = props.selectedConversationId && conversationIds.includes(props.selectedConversationId) ? null : (conversationIds[0] ?? null);

  /** 归档和完成任务共用行内进度与错误反馈。 */
  async function runRowAction(conversationId: string, label: string, run: () => Promise<void> | void): Promise<void> {
    if (rowActionRequestRef.current) return;
    rowActionRequestRef.current = true;
    setPendingRowAction({ conversationId, label });
    setRowActionError(null);
    try {
      await run();
    } catch (error) {
      setRowActionError({ conversationId, error });
    } finally {
      rowActionRequestRef.current = false;
      setPendingRowAction(null);
    }
  }

  /** 右键菜单与行末归档按钮调用同一个会话操作。 */
  function archiveConversation(conversation: NativeConversationChoice): Promise<void> | undefined {
    /** 客户端就绪后才有持久化归档入口。 */
    const archive = props.onArchiveConversation;
    if (archive) return runRowAction(conversation.id, copy.archiving, () => archive(conversation));
  }

  /** 右键菜单处理 */
  function handleContextMenu(event: ReactMouseEvent<HTMLButtonElement>, conversation: NativeConversationChoice): void {
    event.preventDefault();
    event.stopPropagation();
    if (conversation.taskPushCreating) return;
    event.currentTarget.focus({ preventScroll: true });
    /** 菜单放在当前行右侧，和项目菜单保持相同间隙。 */
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenuState({
      conversation,
      position: { x: rect.right + 6, y: rect.top },
    });
  }

  function handleCloseContextMenu(): void {
    setContextMenuState(null);
  }

  /** 渲染平铺会话及其运行状态和快捷入口。 */
  function renderConversationItems(conversations: FlattenedConversation[]) {
    return conversations.map(({ conversation, displayTitle, canCompleteTask }) => {
      const navigationId = conversationNavigationId(conversation);
      const current = navigationId === props.selectedConversationId;
      /** 历史缓存缺少展示身份时，仍可使用已有的持久型号。 */
      const model = conversation.displayModel ?? conversation.model;
      const legacyRef = !conversation.displayModel && !model?.sourceId ? parseModelRef(model?.id ?? conversation.providerModel ?? '') : null;
      const sourceId = model?.sourceId ?? legacyRef?.sourceId ?? (builtinModelProviderName(conversation.agent?.kind ?? conversation.providerId) ? (conversation.agent?.kind ?? conversation.providerId) : null);
      const modelId = legacyRef?.modelId ?? model?.id ?? conversation.providerModel;
      const sourceName = providerAppearances.get(sourceId ?? '')?.name ?? builtinModelProviderName(sourceId);
      const modelTooltip = [sourceName, modelId].filter(Boolean).join(' / ');
      /** 工作区类型未取得时先保留图标位置，避免把工作树暂时显示为目录。 */
      const workspaceMode = conversation.workspaceId || conversation.environmentId ? 'worktree' : conversation.workspaceMode;
      const workspaceLabel = workspaceMode ? copy.workspaceMode[workspaceMode] : undefined;
      /** 与运行状态筛选和数量限制共用实时状态，缺失时回退到目录快照。 */
      const runtimeState = resolveConversationTreeRuntimeState(conversation, props.conversationStates);
      /** 快捷操作跟随持久会话的任务归属。 */
      const taskId = conversation.taskId;
      const completeTask = props.onCompleteTask;
      /** 只有空闲且可写的会话可执行快捷操作，已结束的任务不再提交完成。 */
      const showAction = runtimeState === 'ready' && !conversation.archived && !conversation.readOnly && !conversation.taskPushCreating && (taskId ? canCompleteTask === true && Boolean(completeTask) : Boolean(props.onArchiveConversation));
      /** 当前会话的入口显示等待进度，其他会话保留原有状态。 */
      const pendingLabel = pendingRowAction?.conversationId === conversation.id ? pendingRowAction.label : undefined;
      const actionLabel = pendingLabel ?? (taskId ? copy.completeTask : copy.archive);
      /** 只给尚未打开的持久会话安排后台读取。 */
      const prepareConversation = () => {
        if (!current && conversation.transportKind === 'codex_native' && !conversation.taskPushCreating) props.onPrepareConversation?.(conversation.id);
      };
      return (
        <li className="session-conversation-tree-item" key={navigationId} data-list-motion-id={navigationId} data-motion-surface="list-item" data-motion-state={enteringConversationIds.has(navigationId) ? 'entering' : undefined}>
          <Button
            data-busy-behavior="background"
            unstyled
            type="button"
            className={`session-conversation-tree-row${current ? ' is-current' : ''}`}
            aria-current={current ? 'page' : undefined}
            aria-haspopup={conversation.taskPushCreating ? undefined : 'menu'}
            aria-expanded={contextMenuState?.conversation.id === conversation.id}
            aria-busy={Boolean(pendingLabel)}
            disabled={Boolean(pendingLabel)}
            tabIndex={current || navigationId === fallbackTabStopId ? 0 : -1}
            data-conversation-tree-item="true"
            data-conversation-runtime-state={runtimeState}
            data-icon-tooltip={modelTooltip ? `${displayTitle} · ${modelTooltip}` : displayTitle}
            data-icon-tooltip-provider={Boolean(modelTooltip) || undefined}
            onPointerEnter={prepareConversation}
            onFocus={prepareConversation}
            onClick={() => {
              if (!current && conversation.transportKind === 'codex_native' && !conversation.taskPushCreating) {
                beginConversationNavigationTrace(conversation.projectId, conversation.id);
              }
              return props.onSelectConversation(conversation);
            }}
            onContextMenu={(event) => handleContextMenu(event, conversation)}
            onKeyDown={(event) => {
              // 菜单键与 Shift+F10 提供右键操作的键盘入口。
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
              if (conversation.taskPushCreating) return;
              event.preventDefault();
              event.stopPropagation();
              /** 键盘与右键在同一位置打开，窗口边界由共用菜单处理。 */
              const rect = event.currentTarget.getBoundingClientRect();
              setContextMenuState({ conversation, position: { x: rect.right + 6, y: rect.top } });
            }}
          >
            <ModelProviderBadge sourceId={sourceId} sourceName={sourceName} />
            <span
              className="session-conversation-workspace-icon"
              data-workspace-mode={workspaceMode ?? undefined}
              role={workspaceLabel ? 'img' : undefined}
              aria-label={workspaceLabel}
              data-icon-tooltip={workspaceLabel ? [workspaceLabel, conversation.executionPath].filter(Boolean).join(' · ') : undefined}
            >
              {workspaceMode === 'worktree' ? <GitBranch aria-hidden="true" /> : workspaceMode === 'direct' ? <Folder aria-hidden="true" /> : null}
            </span>
            <span className="session-conversation-title" data-icon-tooltip={displayTitle}>
              {displayTitle}
            </span>
            {!pendingLabel ? <ConversationRowState conversation={conversation} runtimeState={runtimeState} language={props.language} /> : !showAction ? <ConversationStatusIcon status="running" label={pendingLabel} /> : null}
          </Button>
          {showAction ? (
            <Button
              unstyled
              type="button"
              className="session-conversation-row-action"
              aria-label={`${actionLabel} · ${displayTitle}`}
              aria-busy={Boolean(pendingLabel)}
              aria-disabled={Boolean(pendingRowAction) || undefined}
              data-icon-tooltip={actionLabel}
              onContextMenu={(event) => handleContextMenu(event, conversation)}
              onClick={() => {
                // 保留当前按钮焦点，清理确认取消后仍可回到原处。
                if (taskId && completeTask) void runRowAction(conversation.id, copy.completingTask, () => completeTask(taskId));
                else void archiveConversation(conversation);
              }}
            >
              {pendingLabel ? <ConversationStatusIcon status="running" label={pendingLabel} /> : taskId ? <CheckCircle aria-hidden="true" /> : <Archive aria-hidden="true" />}
            </Button>
          ) : null}
          {rowActionError?.conversationId === conversation.id ? (
            <span className="session-conversation-row-error" role="alert">
              <VisibleApplicationError error={rowActionError.error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
            </span>
          ) : null}
        </li>
      );
    });
  }

  return (
    <>
      <nav ref={conversationListRef} className="session-project-conversation-tree" aria-label={copy.aria} onKeyDown={handleTreeKeyDown}>
        {flattenedGroups.map(({ project, conversations, visibleConversations }) => (
          <section className="session-conversation-project-group" key={project.projectId} aria-label={project.projectName}>
            {!props.compactProjectLabel && props.onStartConversation ? <ProjectConversationHeader project={project} language={props.language} onStartConversation={props.onStartConversation} /> : null}
            <ul className="session-conversation-project-items">{renderConversationItems(visibleConversations)}</ul>
            {visibleConversations.length === 0 && props.showEmptyState !== false ? <p className="session-conversation-project-empty">{copy.empty}</p> : null}
            {!normalizedQuery && props.onShowMore && visibleConversations.length < conversations.length ? (
              <Button unstyled type="button" className="session-conversation-show-more" onClick={props.onShowMore}>
                {copy.showMore}
              </Button>
            ) : null}
          </section>
        ))}
      </nav>
      {/* 右键菜单 */}
      <ConversationContextMenu
        conversation={contextMenuState?.conversation ?? ({} as NativeConversationChoice)}
        open={contextMenuState !== null}
        position={contextMenuState?.position ?? { x: 0, y: 0 }}
        onClose={handleCloseContextMenu}
        language={props.language as ConversationContextMenuLanguage}
        onArchive={props.onArchiveConversation && contextMenuState && resolveConversationTreeRuntimeState(contextMenuState.conversation, props.conversationStates) !== 'legacy_readonly' ? archiveConversation : undefined}
        onRename={props.onRenameConversation}
      />
    </>
  );
}

function conversationNavigationId(conversation: NativeConversationChoice): string {
  return conversation.navigationId ?? conversation.id;
}

function ProjectConversationHeader(props: { project: ProjectConversationGroup; language: SessionUiLanguage; onStartConversation: (taskId: string) => void }) {
  const copy = labels[props.language];
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [menuOpen]);

  function openMenu(): void {
    setMenuOpen(true);
    window.requestAnimationFrame(() => itemRefs.current[0]?.focus());
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenuOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') items[0]?.focus();
    else if (event.key === 'End') items.at(-1)?.focus();
    else {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(current + delta + items.length) % items.length]?.focus();
    }
  }

  return (
    <header className="session-conversation-project-header">
      <span className="session-conversation-project-label">
        <Folder aria-hidden="true" />
        <strong>{props.project.projectName}</strong>
      </span>
      <div ref={rootRef} className="session-conversation-create-control">
        <Button
          unstyled
          ref={triggerRef}
          type="button"
          aria-label={`${copy.newThread}: ${props.project.projectName}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={props.project.tasks.length === 0}
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
        >
          <Plus aria-hidden="true" />
        </Button>
        <div className="session-conversation-task-menu" role="menu" inert={!menuOpen} aria-hidden={!menuOpen} aria-label={copy.selectTask} hidden={!menuOpen} onKeyDown={handleMenuKeyDown}>
          {props.project.tasks.map((task, index) => (
            <Button
              unstyled
              key={task.taskId}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                return props.onStartConversation(task.taskId);
              }}
            >
              <strong>{task.taskCode}</strong>
              <span>{task.taskTitle}</span>
            </Button>
          ))}
        </div>
      </div>
    </header>
  );
}

function ConversationRowState(props: { conversation: NativeConversationChoice; runtimeState: ConversationTreeRuntimeState; language: SessionUiLanguage }) {
  const presentation = conversationStatusPresentation(props.conversation, props.runtimeState, props.language);
  return presentation ? <ConversationStatusIcon {...presentation} /> : null;
}

/** 会话行和项目汇总使用相同的运行态、未读提示及文案。 */
function conversationStatusPresentation(conversation: NativeConversationChoice, runtimeState: ConversationTreeRuntimeState, language: SessionUiLanguage): { status: ConversationStatusIconKind; label: string } | null {
  const runStatus = taskRunStatusFromConversationTreeState(runtimeState);
  if (runStatus !== 'idle') {
    return { status: runStatus, label: taskAgentRunStatusLabels[language][runStatus] };
  }
  if (conversation.hasUnreadAttention) {
    if (conversation.attentionKind === 'failed') return { status: 'failed', label: taskAgentRunStatusLabels[language].failed };
    if (conversation.attentionKind === 'interrupted') return { status: 'interrupted', label: language === 'zh-CN' ? '本轮已中断' : 'Turn interrupted' };
    if (conversation.attentionKind === 'completed') return { status: 'completed', label: language === 'zh-CN' ? '已完成' : 'Completed' };
    return { status: 'unread', label: language === 'zh-CN' ? '有未读回复' : 'Unread reply' };
  }
  return null;
}

type ConversationStatusIconKind = TaskAgentRunStatus | 'completed' | 'interrupted' | 'unread';

/** 需要处理的状态优先于执行中，其余状态通过悬停摘要保留。 */
const projectConversationStatusPriority: ConversationStatusIconKind[] = ['waiting_approval', 'waiting_user', 'failed', 'running', 'reconnecting', 'connecting', 'paused', 'interrupted', 'completed', 'unread', 'legacy_readonly'];

/** 汇总完整项目会话，包含任务会话，不受侧栏搜索和折叠数量影响。 */
export function summarizeProjectConversationStatuses(
  groups: ProjectConversationGroup[],
  conversationStates: Record<string, ConversationTreeRuntimeState> | undefined,
  language: SessionUiLanguage,
): Map<string, { status: ConversationStatusIconKind; label: string }> {
  const result = new Map<string, { status: ConversationStatusIconKind; label: string }>();
  for (const group of groups) {
    const counts = new Map<ConversationStatusIconKind, { count: number; label: string }>();
    const seen = new Set<string>();
    for (const conversation of [...(group.conversations ?? []), ...group.tasks.flatMap((task) => task.conversations)]) {
      const id = conversationNavigationId(conversation);
      if (conversation.archived || seen.has(id)) continue;
      seen.add(id);
      const presentation = conversationStatusPresentation(conversation, resolveConversationTreeRuntimeState(conversation, conversationStates), language);
      if (!presentation) continue;
      const count = counts.get(presentation.status)?.count ?? 0;
      counts.set(presentation.status, { count: count + 1, label: presentation.label });
    }
    const statuses = projectConversationStatusPriority.filter((status) => counts.has(status));
    const status = statuses[0];
    if (!status) continue;
    const label = statuses
      .map((kind) => {
        const entry = counts.get(kind)!;
        return `${entry.label} ${entry.count}`;
      })
      .join(' · ');
    result.set(group.projectId, { status, label });
  }
  return result;
}

/** 将旋转起点固定到文档时钟，使晚挂载、重新显示的图标保持同一角度。 */
function synchronizeConversationSpinner(element: SVGSVGElement | null): void {
  // 只对齐浏览器已有的动画；减少动态效果时没有动画，不额外启动计时器。
  for (const animation of element?.getAnimations() ?? []) {
    animation.startTime = 0;
  }
}

/** 会话行与项目汇总共用状态图标，旋转状态统一使用文档时钟。 */
export function ConversationStatusIcon(props: { status: ConversationStatusIconKind; label: string }) {
  /** 按运行状态选择图标，并保留统一的无障碍说明。 */
  let icon = null;
  if (props.status === 'connecting' || props.status === 'reconnecting' || props.status === 'running') {
    icon = (
      <CircleNotch ref={synchronizeConversationSpinner} onAnimationStart={(event: AnimationEvent<SVGSVGElement>) => synchronizeConversationSpinner(event.currentTarget)} className="session-conversation-state-spinner" aria-hidden="true" />
    );
  } else if (props.status === 'waiting_user') {
    icon = <ChatCircle aria-hidden="true" />;
  } else if (props.status === 'waiting_approval') {
    icon = <ShieldCheck aria-hidden="true" />;
  } else if (props.status === 'paused') {
    icon = <PauseCircle aria-hidden="true" />;
  } else if (props.status === 'failed') {
    icon = <Warning aria-hidden="true" />;
  } else if (props.status === 'interrupted') {
    icon = <WarningCircle aria-hidden="true" />;
  } else if (props.status === 'completed') {
    icon = <CheckCircle aria-hidden="true" />;
  } else if (props.status === 'legacy_readonly') {
    icon = <EyeSlash aria-hidden="true" />;
  } else if (props.status === 'not_started' || props.status === 'idle') {
    icon = <Clock aria-hidden="true" />;
  }

  return (
    <span className={`session-conversation-status-icon is-${props.status}`} role="img" aria-label={props.label} data-icon-tooltip={props.label}>
      {icon}
    </span>
  );
}

/** 会话图标与筛选共用运行状态映射，排队沿用运行中。 */
export function taskRunStatusFromConversationTreeState(runtimeState: ConversationTreeRuntimeState): TaskAgentRunStatus {
  if (runtimeState === 'connecting') return 'connecting';
  if (runtimeState === 'reconnecting') return 'reconnecting';
  if (runtimeState === 'streaming' || runtimeState === 'queued') return 'running';
  if (runtimeState === 'pending_user_input') return 'waiting_user';
  if (runtimeState === 'pending_approval') return 'waiting_approval';
  if (runtimeState === 'paused') return 'paused';
  if (runtimeState === 'error') return 'failed';
  if (runtimeState === 'legacy_readonly') return 'legacy_readonly';
  return 'idle';
}

/** 图标与筛选按同一顺序读取实时状态，缺失时回退到会话列表投影。 */
export function resolveConversationTreeRuntimeState(conversation: NativeConversationChoice, conversationStates?: Record<string, ConversationTreeRuntimeState>): ConversationTreeRuntimeState {
  /** 运行状态仍采用实时投影；异步待回复独立保留，避免历史分页或后台刷新漏掉原题。 */
  const runtimeState = conversationStates?.[conversationNavigationId(conversation)] ?? conversationStates?.[conversation.id] ?? conversationTreeRuntimeStateFromConversation(conversation);
  if (conversation.hasPendingAsyncQuestion && runtimeState !== 'pending_approval') return 'pending_user_input';
  return conversation.operationAgentRunning && runtimeState === 'ready' ? 'streaming' : runtimeState;
}

/** 合并项目直属与任务会话，按显示标题搜索，再按最近创建或主动输入时间排序。 */
function flattenProjectConversations(project: ProjectConversationGroup, normalizedQuery: string, language: 'zh-CN' | 'en-US'): FlattenedConversation[] {
  return [
    ...(project.conversations ?? []).map((conversation) => ({ conversation, displayTitle: conversationDisplayTitle(conversation.title) })),
    ...project.tasks.flatMap((task) => task.conversations.map((conversation) => ({ conversation, displayTitle: conversationDisplayTitle(conversation.title, task.taskTitle, language), canCompleteTask: task.canComplete }))),
  ]
    .filter((entry) => !normalizedQuery || entry.displayTitle.toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => compareConversationWorkStartedDesc(left.conversation, right.conversation));
}

/** 将当前已连接 controller 的权威状态映射为全局 source tree 的可读状态。 */
export function conversationTreeRuntimeStateFromSession(state: NativeSessionState): ConversationTreeRuntimeState {
  if (state.conversationState === 'turn_failed') return 'error';
  // 侧栏表达会话本身的运行态，不表达当前窗口读取本地快照或建立实时订阅的短暂状态。
  // 读取、连接、重连失败都属于当前窗口的瞬时 transport，不再污染全局会话树状态。
  if (state.snapshot?.providerState === 'archived' || (state.queue?.state.type === 'paused' && state.queue.state.reason === 'provider_archived')) {
    return (state.queue?.submissions.length ?? 0) > 0 ? 'queued' : 'ready';
  }
  if (state.queue?.state.type === 'paused' && state.queue.state.reason === 'recovery_required') return 'paused';
  if (state.planImplementationRequests.some((request) => request.status === 'pending')) return 'pending_user_input';
  const pendingRequest = state.pendingRequests.find((request) => request.status === 'pending');
  if (pendingRequest?.type === 'request_user_input' || pendingRequest?.type === 'userInput' || state.conversationState === 'waiting_user_input') return 'pending_user_input';
  if (pendingRequest || state.conversationState === 'waiting_approval') return 'pending_approval';
  if (hasPendingAsyncQuestion(state)) return 'pending_user_input';
  if (state.queue?.state.type === 'paused') return 'paused';
  if (
    state.conversationState === 'starting_turn' ||
    state.conversationState === 'active_prework' ||
    state.conversationState === 'active_final_answer' ||
    state.conversationState === 'interrupt_confirm' ||
    state.conversationState === 'interrupting'
  )
    return 'streaming';
  // 已入队但尚未开始轮次的提交仍会执行，侧栏继续显示进行中。
  if (state.queue?.submissions.some((submission) => submission.status === 'queued')) return 'queued';
  return 'ready';
}

export function conversationTreeRuntimeStateFromConversation(
  conversation: Pick<NativeConversationChoice, 'status' | 'stage' | 'transportKind' | 'providerState' | 'pendingRequestKind' | 'listRuntimeState'> & { readOnly?: boolean },
): ConversationTreeRuntimeState {
  if (conversation.listRuntimeState) return conversation.listRuntimeState;
  if (conversation.transportKind !== 'codex_native') return 'legacy_readonly';
  const providerState = `${conversation.providerState ?? ''}`.toLocaleLowerCase();
  const recordState = conversation.status.toLocaleLowerCase();
  if (providerState.includes('failed') || providerState.includes('error') || recordState.includes('failed') || recordState.includes('error')) return 'error';
  if (conversation.stage === 'waiting_user') return 'pending_user_input';
  if (conversation.stage === 'waiting_approval') return 'pending_approval';
  if (providerState.includes('paused') || recordState.includes('paused')) return 'paused';
  if (conversation.pendingRequestKind === 'user_input') return 'pending_user_input';
  if (conversation.pendingRequestKind === 'approval') return 'pending_approval';
  if (providerState.includes('user_input')) return 'pending_user_input';
  if (providerState.includes('waiting')) return 'pending_approval';
  return 'ready';
}

function handleTreeKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-conversation-tree-item="true"]:not(:disabled)'));
  if (items.length === 0) return;
  /** 主按钮与快捷按钮共享同一行的导航位置。 */
  const focusedRow = (event.target as HTMLElement).closest('.session-conversation-tree-item')?.querySelector<HTMLButtonElement>('[data-conversation-tree-item="true"]');
  const currentIndex = focusedRow ? items.indexOf(focusedRow) : -1;
  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? Math.min(items.length - 1, Math.max(0, currentIndex + 1)) : Math.max(0, currentIndex < 0 ? 0 : currentIndex - 1);
  event.preventDefault();
  event.stopPropagation();
  const next = items[nextIndex];
  if (!next) return;
  items.forEach((item) => {
    item.tabIndex = item === next ? 0 : -1;
  });
  next.focus();
}
