import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import type { DigitalTeamWorkflowTemplateRecord } from '@zeus/shared';
import type { NativeConversationChoice } from '../../session/sessionTypes.js';
import { Button } from '../../ui/Button.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { MenuSurface } from '../../ui/MenuSurface.js';
import { MotionPresence } from '../../ui/MotionPresence.js';
import { DigitalEmployeeAvatar } from './DigitalEmployeeAvatar.js';
import type { DigitalEmployeeRecord, TaskWorkItemRecord } from './digitalEmployeeContracts.js';
import type { DigitalTeamRunProjection } from '../digital-teams/digitalTeamApiClient.js';
import { digitalTeamRunStatusLabel, getDigitalTeamRunBlocker } from '../digital-teams/digitalTeamRunPresentation.js';
import { buildTaskConversationNavigation, independentConversationGroupId, isCurrentTaskTeam, taskConversationStatus, type TaskConversationEntry, type TaskConversationEmployeeGroup } from './taskConversationNavigation.js';

/** 导航只选择原会话，正文、草稿和执行状态继续由原控制器提供。 */
export interface TaskConversationPaneProps {
  /** 当前任务原会话。 */
  conversations: NativeConversationChoice[];
  /** 员工目录。 */
  employees: DigitalEmployeeRecord[];
  /** 真实员工工作。 */
  items: TaskWorkItemRecord[];
  /** 完整团队历史。 */
  teams: DigitalTeamRunProjection[];
  /** 团队显示名称。 */
  teamTemplates: DigitalTeamWorkflowTemplateRecord[];
  /** 只读由任务状态决定，团队完成不改变输入权限。 */
  readOnly: boolean;
  /** 已接纳但尚未产生会话的交接。 */
  pendingAssignment?: { employeeId: string; reason?: string } | null;
  /** 列表加载状态。 */
  loading?: boolean;
  /** 列表读取错误。 */
  error?: string | null;
  /** 原控制器会话身份。 */
  activeConversationId?: string | null;
  /** 原会话正文和输入框。 */
  workspace?: ReactNode;
  /** 原新建会话组件。 */
  newWorkspace?: ReactNode;
  /** 待办和交接要求定位的原会话。 */
  conversationRequest?: { conversationId: string; employeeId?: string; groupId?: string } | null;
  /** 当前语言。 */
  language: 'zh-CN' | 'en-US';
  /** 原成果列表及阅读器按所选工作运行提供内容。 */
  renderResults?(entry: TaskConversationEntry, team: DigitalTeamRunProjection | null): ReactNode;
  /** 只切换阅读目标。 */
  onSelect?(conversationId: string): Promise<void>;
  /** 打开同一个会话的独立页面。 */
  onOpen?(conversationId: string): void;
  /** 重读原记录。 */
  onReload?(): void;
  /** 创建和管理团队复用现有入口。 */
  onArrangeTeam?(): void;
  /** 状态处理进入准确团队记录。 */
  onOpenTeamRun?(runId: string): void;
}

/** 有工作才显示协作侧栏；导航、结果和轮询都不产生执行命令。 */
export function TaskConversationPane(props: TaskConversationPaneProps) {
  /** 文案沿用应用语言。 */
  const zh = props.language === 'zh-CN';
  /** 导航只派生真实身份，不保存第二份消息。 */
  const groups = useMemo(
    () => buildTaskConversationNavigation({ teams: props.teams, templates: props.teamTemplates, employees: props.employees, items: props.items, conversations: props.conversations, language: props.language }),
    [props.teams, props.teamTemplates, props.employees, props.items, props.conversations, props.language],
  );
  /** 历史选择独立于当前实际执行。 */
  const [groupId, setGroupId] = useState<string | null>(null);
  /** 未选择与等待原会话是两种不同状态。 */
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  /** 同一会话被不同员工复用时仍保留点击的员工身份。 */
  const [memberId, setMemberId] = useState<string | null>(null);
  /** 等待分工通过原节点或工作运行跟随，不跳到同员工的旧会话。 */
  const [waitingFor, setWaitingFor] = useState<TaskConversationEntry | null>(null);
  /** 新讨论继续使用原输入框和草稿。 */
  const [creating, setCreating] = useState(false);
  /** 读取错误只属于当前目标。 */
  const [error, setError] = useState<unknown>(null);
  /** 重试只重读当前会话。 */
  const [retry, setRetry] = useState(0);
  /** 菜单位置只来自当前触发按钮。 */
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  /** 菜单保留在所属模态区域内。 */
  const menuHost = useRef<HTMLElement | null>(null);
  /** 更多菜单与触发按钮的可访问关联。 */
  const menuId = useId();
  /** 轮询更新回调不重复选择当前会话。 */
  const selectRef = useRef(props.onSelect);
  selectRef.current = props.onSelect;
  /** 外部定位请求只消费一次。 */
  const handledRequest = useRef<TaskConversationPaneProps['conversationRequest']>(null);
  /** 新讨论成功后才跟随外部活动会话。 */
  const lastActive = useRef(props.activeConversationId);
  /** 自动显示的新讨论也需要识别首次发送后的真实会话。 */
  const lastShowingNew = useRef(false);
  /** 默认当前团队、独立工作，然后最近团队和普通讨论。 */
  const initialGroup = groups.find((entry) => entry.team && isCurrentTaskTeam(entry.team)) ?? groups.find((entry) => !entry.team && entry.employees.some((member) => member.entries.some((record) => record.current))) ?? groups[0];
  /** 后台新运行不能覆盖已选历史。 */
  const group = groups.find((entry) => entry.id === groupId) ?? initialGroup;
  /** 普通讨论有独立入口，不混进员工名单。 */
  const discussionGroup = groups.find((entry) => entry.id === independentConversationGroupId)!;
  /** 普通讨论保留全部真实会话。 */
  const discussions = discussionGroup.employees.find((member) => !member.employee)?.entries ?? [];
  /** 当前分组用于首次选择和原会话定位。 */
  const entries = useMemo(() => group.employees.flatMap((member) => member.entries), [group]);
  /** 先保留显式员工，再按原会话身份定位。 */
  const selectedMember =
    group.employees.find((member) => member.id === memberId && (!target || member.entries.some((entry) => entry.conversationId === target))) ??
    (target ? group.employees.find((member) => member.entries.some((entry) => entry.conversationId === target)) : undefined);
  /** 等待目标只沿同一原节点或工作运行抵达，不按名字或顺序猜测。 */
  const selected = target
    ? selectedMember?.entries.find((entry) => entry.conversationId === target)
    : waitingFor
      ? (selectedMember?.entries.find((entry) =>
          waitingFor.workRunIds?.length
            ? waitingFor.workRunIds.some((id) => entry.workRunIds?.includes(id))
            : waitingFor.attemptIds?.length
              ? waitingFor.attemptIds.some((id) => entry.attemptIds?.includes(id))
              : waitingFor.workItemIds?.length
                ? waitingFor.workItemIds.some((id) => entry.workItemIds?.includes(id))
                : waitingFor.nodeIds?.some((id) => entry.nodeIds?.includes(id)),
        ) ?? waitingFor)
      : selectedMember?.entries[0];
  /** 只有真实团队或员工工作需要成员侧栏。 */
  const hasWork = Boolean(props.teams.length || props.items.length || props.pendingAssignment);
  /** 历史记录不会修改顶部任务状态。 */
  const historical = Boolean(group.team && (!isCurrentTaskTeam(group.team) || group.id !== initialGroup.id));
  /** 空任务不显示无内容的工具栏。 */
  const emptyTask = !hasWork && !props.conversations.length && !props.loading && !props.error;
  /** 新建与首次讨论复用同一个原输入组件。 */
  const showingNew = !props.readOnly && Boolean(props.newWorkspace) && (creating || emptyTask);
  /** 成果仅属于有真实工作来源的条目。 */
  const canReadResults = Boolean(selected && props.renderResults && (selected.workRunIds?.length || selected.attemptIds?.length));
  /** 受阻原因沿用团队权威展示。 */
  const blocker = group.team ? getDigitalTeamRunBlocker(group.team, zh) : null;

  useEffect(() => {
    if (!groupId && props.loading) return;
    if (!groupId) setGroupId(group.id);
    if (target !== undefined) return;
    /** 正在执行优先，然后按原创建时间选择最近会话。 */
    const next = entries.filter((entry) => entry.conversationId).sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt))[0];
    /** 未启动成员同样有可查看的分工。 */
    const member = group.employees.find((candidate) => candidate.entries.includes(next)) ?? group.employees[0];
    setTarget(next?.conversationId ?? null);
    setMemberId(member?.id ?? null);
    setWaitingFor(next ? null : (member?.entries[0] ?? null));
  }, [groupId, group, entries, target, props.loading]);
  useEffect(() => {
    if (target === null && !creating && selected?.conversationId) setTarget(selected.conversationId);
  }, [target, creating, selected]);
  useEffect(() => {
    /** 明确指定员工与团队时保持其身份，避免共享会话误选其他成员。 */
    const request = props.conversationRequest;
    if (!request || handledRequest.current === request) return;
    /** 等待真实关联抵达，不把新执行猜成普通讨论。 */
    const requested = groups.find(
      (entry) =>
        (!request.groupId || entry.id === request.groupId) && entry.employees.some((member) => (!request.employeeId || member.id === request.employeeId) && member.entries.some((record) => record.conversationId === request.conversationId)),
    );
    if (!requested) return;
    handledRequest.current = request;
    setGroupId(requested.id);
    setMemberId(request.employeeId ?? null);
    setWaitingFor(null);
    setTarget(request.conversationId);
    setCreating(false);
  }, [groups, props.conversationRequest]);
  useEffect(() => {
    if ((creating || lastShowingNew.current) && props.activeConversationId && props.activeConversationId !== lastActive.current) {
      setGroupId(independentConversationGroupId);
      setMemberId(null);
      setTarget(props.activeConversationId);
      setCreating(false);
    }
    lastActive.current = props.activeConversationId;
    lastShowingNew.current = showingNew;
  }, [props.activeConversationId, creating, showingNew]);
  useEffect(() => {
    setError(null);
    if (!target || !selectRef.current || props.activeConversationId === target || creating) return;
    /** 快速切换后丢弃旧目标的失败回执。 */
    let active = true;
    void selectRef.current(target).catch((cause: unknown) => {
      if (active) setError(cause);
    });
    return () => {
      active = false;
    };
  }, [target, retry, props.activeConversationId, creating]);

  /** 点击员工只选择原会话，绝不调用指派或重跑。 */
  function selectEntry(entry: TaskConversationEntry, employeeId: string): void {
    setCreating(false);
    setMemberId(employeeId);
    setWaitingFor(entry.conversationId ? null : entry);
    setTarget(entry.conversationId);
  }
  /** 切换执行历史后从该记录的真实分工定位，不改变执行状态。 */
  function selectGroup(id: string): void {
    setGroupId(id);
    setTarget(undefined);
    setMemberId(null);
    setWaitingFor(null);
    setCreating(false);
  }
  /** 普通讨论入口一直可达，没有讨论时只显示原新建输入框。 */
  function openDiscussion(): void {
    setGroupId(independentConversationGroupId);
    if (discussions[0]) selectEntry(discussions[0], 'discussion');
    else {
      setTarget(null);
      setMemberId(null);
      setWaitingFor(null);
      setCreating(!props.readOnly);
    }
  }
  /** 状态携带原错误入口，不在会话上方堆叠警告卡片。 */
  function entryStatus(entry: TaskConversationEntry): ReactNode {
    if (!entry.status && !entry.reason) return null;
    return entry.reason ? (
      <VisibleApplicationError error={entry.reason} summary={taskConversationStatus(entry.status, zh)} language={zh ? 'zh-CN' : 'en'} />
    ) : (
      <span data-status={entry.status}>{taskConversationStatus(entry.status, zh)}</span>
    );
  }
  /** 员工与团队主会话使用同一层级，多份分工直接列在姓名下。 */
  function renderMember(member: TaskConversationEmployeeGroup): ReactNode {
    /** 当前工作和原创建时间已经在导航派生时排序。 */
    const first = member.entries[0];
    /** 多份分工只增加一层原记录。 */
    const multiple = member.entries.length > 1;
    return (
      <li key={member.id} className="task-conversation-member" data-selected={!creating && selectedMember?.id === member.id}>
        <div className="task-conversation-member-heading">
          <button type="button" className="task-conversation-member-button" aria-current={!creating && selectedMember?.id === member.id ? 'true' : undefined} onClick={() => selectEntry(first, member.id)}>
            {member.employee ? <DigitalEmployeeAvatar {...member.employee} /> : null}
            <span>
              <strong>{member.employee?.name ?? first.title}</strong>
              <small data-icon-tooltip={first.title}>{first.title}</small>
            </span>
          </button>
        </div>
        <div className="task-conversation-member-status">{entryStatus(first)}</div>
        {multiple ? (
          <ul className="task-conversation-member-records">
            {member.entries.map((entry) => (
              <li key={entry.conversationId ?? entry.attemptIds?.[0] ?? entry.workRunIds?.[0] ?? entry.workItemIds?.[0] ?? entry.nodeIds?.[0]}>
                <button type="button" aria-current={entry === selected ? 'true' : undefined} onClick={() => selectEntry(entry, member.id)}>
                  <span>{entry.title}</span>
                  <small>{new Date(entry.createdAt).toLocaleString(props.language, { dateStyle: 'short', timeStyle: 'medium' })}</small>
                </button>
                <div>{entryStatus(entry)}</div>
              </li>
            ))}
          </ul>
        ) : null}
      </li>
    );
  }
  /** 低频动作使用真正的菜单，执行历史和多条讨论直接显示为导航。 */
  const menuOptions = [
    ...(!props.readOnly && props.newWorkspace ? [{ value: creating ? 'back' : 'new', label: creating ? (zh ? '返回会话' : 'Back to conversation') : zh ? '新建会话' : 'New conversation' }] : []),
    ...(group.team && props.onOpenTeamRun ? [{ value: 'run', label: zh ? '查看分工' : 'View assignments' }] : []),
    ...(!props.readOnly && props.onArrangeTeam ? [{ value: 'team', label: zh ? '管理数字团队' : 'Manage digital teams' }] : []),
    ...(props.onReload ? [{ value: 'reload', label: zh ? '刷新会话' : 'Reload conversations' }] : []),
  ];
  return (
    <section className="task-conversation-pane task-conversation-layout" data-has-work={hasWork} data-reading={Boolean(target) && !showingNew} data-empty={emptyTask} aria-label={zh ? '任务沟通' : 'Task conversations'}>
      {hasWork ? (
        <aside className="task-conversation-navigation" aria-label={zh ? '执行人与任务讨论' : 'Employees and task discussions'}>
          <h3>{zh ? '执行人' : 'Employees'}</h3>
          <strong className="task-conversation-team-name">{group.team ? group.name : zh ? '独立工作' : 'Individual work'}</strong>
          <div className="task-conversation-execution-caption">
            {group.team ? (
              <>
                <time dateTime={group.team.run.createdAt}>{new Date(group.team.run.createdAt).toLocaleString(props.language, { dateStyle: 'short', timeStyle: 'short' })}</time>
                {blocker ? <VisibleApplicationError error={blocker.reason} summary={digitalTeamRunStatusLabel(group.team.run, zh)} language={zh ? 'zh-CN' : 'en'} /> : <span>{digitalTeamRunStatusLabel(group.team.run, zh)}</span>}
              </>
            ) : null}
            {historical ? <strong>{zh ? '历史' : 'History'}</strong> : null}
          </div>
          <ul className="task-conversation-members">{group.employees.filter((member) => member.employee || group.team).map(renderMember)}</ul>
          {!group.employees.length && props.loading ? <p className="task-conversation-navigation-empty">{zh ? '正在读取分工…' : 'Loading assignments…'}</p> : null}
          <nav className="task-conversation-navigation-actions" aria-label={zh ? '讨论与执行记录' : 'Discussions and executions'}>
            <button type="button" aria-current={group.id === independentConversationGroupId && !selectedMember?.employee ? 'true' : undefined} onClick={openDiscussion}>
              {zh ? '任务讨论' : 'Task discussion'}
            </button>
            {discussionGroup.employees.some((member) => member.employee) && group.id !== independentConversationGroupId ? (
              <button type="button" onClick={() => selectGroup(independentConversationGroupId)}>
                {zh ? '独立工作' : 'Individual work'}
              </button>
            ) : null}
            {props.teams.length ? (
              <div className="task-conversation-history">
                <h3>{zh ? '执行历史' : 'Execution history'}</h3>
                {groups
                  .filter((entry) => entry.team)
                  .map((entry) => (
                    <button key={entry.id} type="button" aria-current={group.id === entry.id ? 'true' : undefined} onClick={() => selectGroup(entry.id)}>
                      <strong>{entry.name}</strong>
                      <small>{entry.description}</small>
                    </button>
                  ))}
              </div>
            ) : null}
          </nav>
        </aside>
      ) : null}
      <div className="task-conversation-main">
        {!emptyTask ? (
          <header className="task-conversation-selector">
            <div className="task-conversation-current" data-icon-tooltip={selected?.title}>
              {!showingNew && selectedMember?.employee ? <DigitalEmployeeAvatar {...selectedMember.employee} /> : null}
              <div>
                <strong>{showingNew ? (zh ? '新建会话' : 'New conversation') : (selectedMember?.employee?.name ?? (group.team ? group.name : zh ? '任务讨论' : 'Task discussion'))}</strong>
                {!showingNew && selected && (selectedMember?.employee || discussions.length > 1) ? <span>{selected.title}</span> : null}
                {historical && !showingNew ? <small>{zh ? '历史' : 'History'}</small> : null}
                {!showingNew && selected && selectedMember?.employee ? (
                  <div className="task-conversation-work-state">
                    {entryStatus(selected)}
                    {group.team && props.onOpenTeamRun ? (
                      <button type="button" onClick={() => props.onOpenTeamRun?.(group.team!.run.id)}>
                        {zh ? '查看分工' : 'View assignment'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="task-conversation-actions">
              {target && props.onOpen && !showingNew ? (
                <Button variant="secondary" size="compact" onClick={() => props.onOpen?.(target)}>
                  {zh ? '打开会话' : 'Open conversation'}
                </Button>
              ) : null}
              {menuOptions.length ? (
                <Button
                  variant="secondary"
                  size="compact"
                  aria-haspopup="menu"
                  aria-expanded={Boolean(menu)}
                  aria-controls={menu ? menuId : undefined}
                  onClick={(event) => {
                    /** 与现有菜单共用模态门户和窗口边界约束。 */
                    const bounds = event.currentTarget.getBoundingClientRect();
                    menuHost.current = event.currentTarget.closest<HTMLElement>('.zeus-modal-portal-root') ?? event.currentTarget.closest<HTMLElement>('.macos-ai-app') ?? document.body;
                    setMenu(menu ? null : { left: bounds.right - 208, top: bounds.bottom + 6 });
                  }}
                >
                  {zh ? '更多' : 'More'}
                  <CaretDown aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </header>
        ) : null}
        {!showingNew && !selectedMember?.employee && group.id === independentConversationGroupId && discussions.length > 1 ? (
          <nav className="task-conversation-discussions" aria-label={zh ? '任务会话' : 'Task conversations'}>
            {discussions.map((entry) => (
              <button key={entry.conversationId} type="button" aria-current={entry.conversationId === target ? 'true' : undefined} onClick={() => selectEntry(entry, 'discussion')}>
                <strong>{entry.title}</strong>
                <small>{new Date(entry.createdAt).toLocaleString(props.language, { dateStyle: 'short', timeStyle: 'short' })}</small>
              </button>
            ))}
          </nav>
        ) : null}
        <MotionPresence>
          {menu && menuHost.current
            ? createPortal(
                <MenuSurface id={menuId} className="task-conversation-menu" aria-label={zh ? '会话操作' : 'Conversation actions'} style={{ left: menu.left, top: menu.top }} onClose={() => setMenu(null)}>
                  {menuOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        if (option.value === 'new' || option.value === 'back') {
                          setCreating(option.value === 'new');
                        }
                        if (option.value === 'reload') props.onReload?.();
                        if (option.value === 'team') props.onArrangeTeam?.();
                        if (option.value === 'run' && group.team) props.onOpenTeamRun?.(group.team.run.id);
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </MenuSurface>,
                menuHost.current,
              )
            : null}
        </MotionPresence>
        {props.error ? (
          <div className="task-conversation-feedback" role="alert">
            <VisibleApplicationError error={props.error} language={zh ? 'zh-CN' : 'en'} />
            {props.onReload ? (
              <Button variant="secondary" size="compact" onClick={props.onReload}>
                {zh ? '重新读取列表' : 'Reload conversations'}
              </Button>
            ) : null}
          </div>
        ) : null}
        {props.pendingAssignment ? (
          <div className="task-conversation-feedback" role="status">
            {props.pendingAssignment.reason ? (
              <VisibleApplicationError error={props.pendingAssignment.reason} summary={zh ? '交接受阻' : 'Handover blocked'} language={zh ? 'zh-CN' : 'en'} />
            ) : zh ? (
              '正在交接，等待新执行人的会话…'
            ) : (
              'Waiting for the new employee conversation…'
            )}
          </div>
        ) : null}

        {error ? (
          <div className="task-conversation-feedback" role="alert">
            <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
            <Button variant="secondary" size="compact" onClick={() => setRetry((value) => value + 1)}>
              {zh ? '重新打开' : 'Try again'}
            </Button>
          </div>
        ) : null}
        {showingNew ? (
          <div className="task-conversation-new session-codex-parity-v1">
            <div>
              <strong>{zh ? '开始任务讨论' : 'Start a task discussion'}</strong>
              <p>{zh ? '输入 @ 邀请数字员工参与' : 'Type @ to invite digital employees.'}</p>
            </div>
            {props.newWorkspace}
          </div>
        ) : null}
        {!showingNew && target && props.activeConversationId === target && props.workspace ? (
          <div className="task-conversation-content">
            {target && props.activeConversationId === target && props.workspace ? (
              <div className="task-conversation-session session-codex-parity-v1" aria-hidden={Boolean(error)} inert={Boolean(error)}>
                {props.workspace}
              </div>
            ) : null}
          </div>
        ) : null}
        {!showingNew && !error && target && props.activeConversationId !== target ? (
          <p className="task-conversation-feedback" role="status">
            {zh ? '正在读取所选会话…' : 'Loading the selected conversation…'}
          </p>
        ) : null}
        {!showingNew && !error && !target ? (
          <div className="task-conversation-empty">
            <strong>{props.loading ? (zh ? '正在读取任务会话…' : 'Loading conversations…') : selected ? selected.title : zh ? '暂无会话' : 'No conversation yet'}</strong>
            <p>
              {selected
                ? zh
                  ? '该分工尚未产生会话，开始后会在这里显示原会话。'
                  : 'This assignment will show its original conversation when it starts.'
                : props.readOnly
                  ? zh
                    ? '任务已结束，没有可查看的会话。'
                    : 'The task has ended without a conversation.'
                  : zh
                    ? '可从“更多”新建会话，或选择成员查看分工。'
                    : 'Create a conversation from More, or select an employee to view their assignment.'}
            </p>
          </div>
        ) : null}
        {props.readOnly && !showingNew ? <p className="task-conversation-readonly">{zh ? '任务已结束，可查看结果与历史会话' : 'The task has ended. Results and conversation history remain available.'}</p> : null}
      </div>
      {!showingNew && canReadResults && selected ? (
        <section className="task-conversation-results" aria-label={zh ? '所选分工结果' : 'Selected assignment results'}>
          {props.renderResults?.(selected, group.team)}
        </section>
      ) : null}
    </section>
  );
}
