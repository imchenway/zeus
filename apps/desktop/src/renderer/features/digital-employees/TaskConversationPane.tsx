import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DigitalTeamWorkflowTemplateRecord } from '@zeus/shared';
import type { NativeConversationChoice } from '../../session/sessionTypes.js';
import { Button } from '../../ui/Button.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { DigitalEmployeeAvatar } from './DigitalEmployeeAvatar.js';
import type { DigitalEmployeeRecord, TaskWorkItemRecord } from './digitalEmployeeContracts.js';
import type { DigitalTeamRunProjection } from '../digital-teams/digitalTeamApiClient.js';
import { digitalTeamRunStatusLabel, getDigitalTeamRunBlocker } from '../digital-teams/digitalTeamRunPresentation.js';
import { buildTaskConversationNavigation, independentConversationGroupId, isCurrentTaskTeam, taskConversationStatus, type TaskConversationEntry } from './taskConversationNavigation.js';

/** 导航只选择原会话，正文和输入继续由唯一控制器提供。 */
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
  conversationRequest?: { conversationId: string } | null;
  /** 当前语言。 */
  language: 'zh-CN' | 'en-US';
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

/** 左栏按团队执行和员工导航，轮询不覆盖手动选择。 */
export function TaskConversationPane(props: TaskConversationPaneProps) {
  /** 文案沿用应用语言。 */
  const zh = props.language === 'zh-CN';
  /** 导航不保存第二份消息或执行状态。 */
  const groups = useMemo(
    () => buildTaskConversationNavigation({ teams: props.teams, templates: props.teamTemplates, employees: props.employees, items: props.items, conversations: props.conversations, language: props.language }),
    [props.teams, props.teamTemplates, props.employees, props.items, props.conversations, props.language],
  );
  /** 所选历史独立于当前实际执行。 */
  const [groupId, setGroupId] = useState<string | null>(null);
  /** undefined 表示尚未选择，null 表示选中了未产生会话的分工。 */
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  /** 未启动员工同样可以选中查看其状态。 */
  const [memberId, setMemberId] = useState<string | null>(null);
  /** 原新建组件保留其草稿。 */
  const [creating, setCreating] = useState(false);
  /** 错误只属于当前读取。 */
  const [error, setError] = useState<unknown>(null);
  /** 重试不创建会话。 */
  const [retry, setRetry] = useState(0);
  /** 自动折叠按实际会话区宽度计算。 */
  const [narrow, setNarrow] = useState(false);
  /** 手动展开优先于自动宽度。 */
  const [navigationOpen, setNavigationOpen] = useState<boolean | null>(null);
  /** 同员工多条记录在名字下展开。 */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 导航的键盘关联身份。 */
  const navigationId = useId();
  /** 观察容器而非整个窗口。 */
  const paneRef = useRef<HTMLElement>(null);
  /** 当前读取回调不参与轮询刷新。 */
  const selectRef = useRef(props.onSelect);
  selectRef.current = props.onSelect;
  /** 外部定位只消费一次。 */
  const handledRequest = useRef<TaskConversationPaneProps['conversationRequest']>(null);
  /** 只有新建成功允许外部活动会话改变当前阅读。 */
  const lastActive = useRef(props.activeConversationId);
  /** 默认当前团队或独立工作，其次最近团队执行，最后普通讨论。 */
  const initialGroup = groups.find((entry) => entry.team && isCurrentTaskTeam(entry.team)) ?? groups.find((entry) => !entry.team && entry.employees.some((member) => member.entries.some((record) => record.current))) ?? groups[0];
  /** 历史选择不被后台新运行覆盖。 */
  const group = groups.find((entry) => entry.id === groupId) ?? initialGroup;
  /** 当前分组的真实记录。 */
  const entries = useMemo(() => group.employees.flatMap((member) => member.entries), [group]);
  /** 有会话时按原身份定位，否则保留未启动员工。 */
  const selectedMember = target ? group.employees.find((member) => member.entries.some((entry) => entry.conversationId === target)) : group.employees.find((member) => member.id === memberId);
  /** 主会话复用时显示其合并后的分工标题。 */
  const selected = target ? entries.find((entry) => entry.conversationId === target) : selectedMember?.entries[0];
  /** 历史标记不修改任务顶部状态。 */
  const historical = Boolean(group.team && (!isCurrentTaskTeam(group.team) || group.id !== initialGroup.id));
  /** 自动和手动收起共用实际状态。 */
  const showNavigation = navigationOpen ?? !narrow;
  /** 团队受阻原因来自当前有效尝试。 */
  const blocker = group.team ? getDigitalTeamRunBlocker(group.team, zh) : null;

  useEffect(() => {
    if (!paneRef.current) return;
    /** 左栏之外保留足够阅读宽度。 */
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 880));
    observer.observe(paneRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!groupId && props.loading) return;
    if (!groupId) setGroupId(group.id);
    if (target !== undefined) return;
    /** 分组首次选择优先当前工作，再用原创建时间。 */
    const next = entries.filter((entry) => entry.conversationId).sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt))[0];
    setTarget(next?.conversationId ?? null);
    if (!next) setMemberId(group.employees[0]?.id ?? null);
  }, [groupId, group, entries, target, props.loading]);
  useEffect(() => {
    if (target !== null || creating) return;
    /** 等待中的分工一旦关联真实会话，就在原位置打开。 */
    const ready = selectedMember?.entries.find((entry) => entry.conversationId);
    if (ready) setTarget(ready.conversationId);
  }, [target, creating, selectedMember]);
  useEffect(() => {
    if (!props.conversationRequest || handledRequest.current === props.conversationRequest) return;
    /** 等待真实关联抵达，不把新执行猜成普通会话。 */
    const requested = groups.find((entry) => entry.employees.some((member) => member.entries.some((record) => record.conversationId === props.conversationRequest!.conversationId)));
    if (!requested) return;
    handledRequest.current = props.conversationRequest;
    setGroupId(requested.id);
    setTarget(props.conversationRequest.conversationId);
    setCreating(false);
  }, [groups, props.conversationRequest]);
  useEffect(() => {
    if (creating && props.activeConversationId && props.activeConversationId !== lastActive.current) {
      setGroupId(independentConversationGroupId);
      setTarget(props.activeConversationId);
      setCreating(false);
    }
    lastActive.current = props.activeConversationId;
  }, [props.activeConversationId, creating]);
  useEffect(() => {
    setError(null);
    if (!target || !selectRef.current || props.activeConversationId === target || creating) return;
    /** 目标变更后丢弃旧读取的错误。 */
    let active = true;
    void selectRef.current(target).catch((cause: unknown) => {
      if (active) setError(cause);
    });
    return () => {
      active = false;
    };
  }, [target, retry, props.activeConversationId, creating]);

  /** 导航点击不调用指派命令。 */
  function selectEntry(entry: TaskConversationEntry, employeeId: string, closeNavigation = true): void {
    setCreating(false);
    setMemberId(employeeId);
    setTarget(entry.conversationId);
    if (narrow && entry.conversationId && closeNavigation) setNavigationOpen(false);
  }
  /** 状态本身携带错误入口，不另加警告行。 */
  function entryStatus(entry: TaskConversationEntry): ReactNode {
    if (!entry.status && !entry.reason) return null;
    return entry.reason ? (
      <VisibleApplicationError error={entry.reason} summary={taskConversationStatus(entry.status, zh)} language={zh ? 'zh-CN' : 'en'} />
    ) : (
      <span data-status={entry.status}>{taskConversationStatus(entry.status, zh)}</span>
    );
  }
  /** 低频操作复用现有键盘菜单。 */
  const menuOptions = [
    ...(props.newWorkspace ? [{ value: creating ? 'back' : 'new', label: creating ? (zh ? '返回会话' : 'Back to conversation') : zh ? '新建会话' : 'New conversation' }] : []),
    ...(group.team && props.onOpenTeamRun ? [{ value: 'run', label: zh ? '团队流程' : 'Team workflow' }] : []),
    ...(props.onArrangeTeam ? [{ value: 'team', label: zh ? '管理数字团队' : 'Manage digital teams' }] : []),
    ...(props.onReload ? [{ value: 'reload', label: zh ? '刷新会话' : 'Reload conversations' }] : []),
  ];
  return (
    <section ref={paneRef} className="task-conversation-pane task-conversation-layout" data-navigation-open={showNavigation} data-narrow={narrow} aria-label={zh ? '任务沟通' : 'Task conversations'}>
      <aside id={navigationId} className="task-conversation-navigation" aria-label={zh ? '团队执行与员工会话' : 'Team executions and employee conversations'} hidden={!showNavigation}>
        <ZeusSelect
          size="compact"
          ariaLabel={zh ? '选择团队执行记录' : 'Choose a team execution'}
          value={group.id}
          options={groups.map((entry) => ({ value: entry.id, label: entry.name, description: entry.description }))}
          triggerLabel={group.name}
          searchable={groups.length > 8}
          onChange={(id) => {
            setGroupId(id);
            setTarget(undefined);
            setMemberId(null);
            setCreating(false);
            setExpanded(null);
          }}
        />
        <div className="task-conversation-execution-caption">
          {group.team ? (
            <>
              <time dateTime={group.team.run.createdAt}>{new Date(group.team.run.createdAt).toLocaleString(props.language, { dateStyle: 'short', timeStyle: 'medium' })}</time>
              {blocker ? <VisibleApplicationError error={blocker.reason} summary={digitalTeamRunStatusLabel(group.team.run, zh)} language={zh ? 'zh-CN' : 'en'} /> : <span>{digitalTeamRunStatusLabel(group.team.run, zh)}</span>}
            </>
          ) : (
            <span>{group.description}</span>
          )}
          {historical ? <strong>{zh ? '历史' : 'History'}</strong> : null}
        </div>
        <h3>{zh ? '数字员工' : 'Digital employees'}</h3>
        <ul className="task-conversation-members">
          {group.employees.map((member) => {
            /** 首条按当前工作和原时间排序。 */
            const first = member.entries[0];
            /** 多条记录只在员工下面展开。 */
            const multiple = member.entries.length > 1;
            /** 展开身份包含团队执行。 */
            const memberKey = group.id + ':' + member.id;
            return (
              <li key={member.id} className="task-conversation-member" data-selected={selectedMember?.id === member.id}>
                <button
                  type="button"
                  className="task-conversation-member-button"
                  aria-expanded={multiple ? expanded === memberKey : undefined}
                  aria-current={selectedMember?.id === member.id ? 'true' : undefined}
                  onClick={() => {
                    if (multiple) setExpanded(expanded === memberKey ? null : memberKey);
                    selectEntry(first, member.id, !multiple);
                  }}
                >
                  {member.employee ? <DigitalEmployeeAvatar {...member.employee} /> : null}
                  <span>
                    <strong>{member.employee?.name ?? (zh ? '任务讨论' : 'Task discussion')}</strong>
                    <small>{first.title}</small>
                    {!first.conversationId ? <small>{zh ? '尚未产生会话' : 'No conversation yet'}</small> : null}
                  </span>
                  {multiple ? <span aria-hidden="true">{expanded === memberKey ? '⌃' : '⌄'}</span> : null}
                </button>
                <div className="task-conversation-member-status">{entryStatus(first)}</div>
                {multiple && expanded === memberKey ? (
                  <ul className="task-conversation-member-records">
                    {member.entries.map((entry, index) => (
                      <li key={entry.conversationId ?? entry.title + ':' + index}>
                        <button type="button" disabled={!entry.conversationId} aria-current={entry.conversationId === target ? 'true' : undefined} onClick={() => selectEntry(entry, member.id)}>
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
          })}
        </ul>
        {!group.employees.length ? <p className="task-conversation-navigation-empty">{props.loading ? (zh ? '正在读取…' : 'Loading…') : zh ? '暂无员工会话' : 'No employee conversations'}</p> : null}
      </aside>
      <div className="task-conversation-main">
        <header className="task-conversation-selector">
          <Button
            variant="secondary"
            size="compact"
            aria-label={showNavigation ? (zh ? '收起员工栏' : 'Hide employees') : zh ? '展开员工栏' : 'Show employees'}
            aria-expanded={showNavigation}
            aria-controls={navigationId}
            onClick={() => setNavigationOpen(!showNavigation)}
          >
            {zh ? '员工' : 'Employees'}
          </Button>
          <div className="task-conversation-current" title={selected?.title}>
            {selectedMember?.employee ? <DigitalEmployeeAvatar {...selectedMember.employee} /> : null}
            <strong>{creating ? (zh ? '新建会话' : 'New conversation') : (selectedMember?.employee?.name ?? (zh ? '任务会话' : 'Task conversation'))}</strong>
            {!creating && selected ? <span>{selected.title}</span> : null}
            {historical && !creating ? <small>{zh ? '历史' : 'History'}</small> : null}
          </div>
          {target && props.onOpen && !creating ? (
            <Button variant="secondary" size="compact" onClick={() => props.onOpen?.(target)}>
              {zh ? '在会话页打开' : 'Open conversation page'}
            </Button>
          ) : null}
          {menuOptions.length ? (
            <ZeusSelect
              size="compact"
              ariaLabel={zh ? '会话更多操作' : 'More conversation actions'}
              value=""
              triggerLabel="…"
              options={menuOptions}
              onChange={(value) => {
                if (value === 'new' || value === 'back') setCreating(value === 'new');
                if (value === 'reload') props.onReload?.();
                if (value === 'team') props.onArrangeTeam?.();
                if (value === 'run' && group.team) props.onOpenTeamRun?.(group.team.run.id);
              }}
            />
          ) : null}
        </header>
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
              'Handing over and waiting for the new employee conversation…'
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
        ) : props.newWorkspace && (creating || (!props.loading && !props.teams.length && !entries.length)) ? (
          <div className="task-conversation-new session-codex-parity-v1">
            <div>
              <strong>{zh ? '开始任务讨论' : 'Start a task discussion'}</strong>
              <p>{zh ? '输入 @ 邀请数字员工参与' : 'Type @ to invite digital employees.'}</p>
            </div>
            {props.newWorkspace}
          </div>
        ) : target && props.onSelect ? (
          props.activeConversationId === target && props.workspace ? (
            <div className="task-conversation-session session-codex-parity-v1">{props.workspace}</div>
          ) : (
            <p className="task-conversation-feedback" role="status">
              {zh ? '正在读取会话…' : 'Loading conversation…'}
            </p>
          )
        ) : (
          <div className="task-conversation-empty">
            <strong>{props.loading ? (zh ? '正在读取任务会话…' : 'Loading conversations…') : zh ? '暂无会话' : 'No conversation yet'}</strong>
            <p>{zh ? '选择左侧员工查看会话，或从更多菜单新建会话。尚未启动的分工会在开始后显示原会话。' : 'Choose an employee or create a conversation from the menu. Work that has not started will show its conversation when available.'}</p>
          </div>
        )}
      </div>
    </section>
  );
}
