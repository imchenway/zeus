import { MotionPresence } from '../toolPageHost.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../toolPageHost.js';
import { temporaryWorkspaceId } from '../toolPageHost.js';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowClockwiseIcon as Refresh } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ClockCountdownIcon as Clock } from '@phosphor-icons/react/dist/csr/ClockCountdown';
import { TrayIcon as Inbox } from '@phosphor-icons/react/dist/csr/Tray';
import { PauseIcon as Pause } from '@phosphor-icons/react/dist/csr/Pause';
import { PlayIcon as Play } from '@phosphor-icons/react/dist/csr/Play';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import type { DashboardClient, ProjectRecord } from '../toolPageHost.js';
import { Button } from '../toolPageHost.js';
import { FormDialog } from '../toolPageHost.js';
import { ZeusSelect } from '../toolPageHost.js';
import type { AutomationBlockStrategy, AutomationExecutionReference, AutomationExecutionTarget, AutomationPermissionMode, AutomationRunRecord, AutomationTaskInput, AutomationTaskRecord, AutomationTriggerKind } from '../toolPageHost.js';
import type { DigitalEmployeeTemplateRecord, AutomationActionKind } from '../toolPageHost.js';

type Draft = Omit<AutomationTaskInput, 'pluginIds'> & { pluginIds: string[]; maxRunsPerDayText: string; maxTokensPerDayText: string; taskStatusesText: string; taskTypesText: string; requiredTagsText: string };
type View = 'tasks' | 'inbox';
const allProjectsValue = '__all_projects__';
/** 无项目选项只改变用户目标范围，运行时目录由服务端托管。 */
const noProjectValue = '__no_project__';

/** 自动化目录与收件箱使用全局控件，编辑及删除复用表单弹窗。 */
export function AutomationsWorkspace(props: {
  client: DashboardClient | null;
  projects: ProjectRecord[];
  language: 'zh-CN' | 'en-US';
  onOpenConversation: (run: AutomationRunRecord) => Promise<void>;
  onOpenExecution: (run: AutomationRunRecord, reference: AutomationExecutionReference, target: AutomationExecutionTarget) => Promise<void>;
}) {
  const zh = props.language === 'zh-CN';
  /** 临时会话是技术工作区，不得作为用户项目出现在目标列表。 */
  const userProjects = props.projects.filter((project) => project.id !== temporaryWorkspaceId);
  const [view, setView] = useState<View>('tasks');
  const [tasks, setTasks] = useState<AutomationTaskRecord[]>([]);
  const [inbox, setInbox] = useState<AutomationRunRecord[]>([]);
  /** 多项目运行逐份选择实际引用，保持查看入口数量固定。 */
  const [selectedExecutions, setSelectedExecutions] = useState<Record<string, string>>({});
  /** 员工选择只展示已创建的全局身份，内置模板不会成为执行成员。 */
  const [employees, setEmployees] = useState<DigitalEmployeeTemplateRecord[]>([]);
  /** 指定已有任务只读取用户明确选择的一个项目。 */
  const [projectTasks, setProjectTasks] = useState<Array<{ id: string; taskCode?: string; title: string }>>([]);
  /** 任务目录加载期间不能保存旧项目任务引用。 */
  const [projectTasksLoading, setProjectTasksLoading] = useState(false);
  /** 指定任务读取失败时在表单说明原因。 */
  const [projectTasksError, setProjectTasksError] = useState<string | null>(null);
  /** 待核对的迁移规则必须实际重选策略，普通名称编辑不能代替确认。 */
  const [taskSelectionConfirmed, setTaskSelectionConfirmed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(props.projects));
  const [fullAccessAcknowledged, setFullAccessAcknowledged] = useState(false);
  /** 删除前保留任务，只有确认成功才关闭弹窗。 */
  const [pendingDelete, setPendingDelete] = useState<AutomationTaskRecord | null>(null);
  async function refresh(): Promise<void> {
    if (!props.client) return;
    setLoading(true);
    setError(null);
    try {
      const [nextTasks, nextInbox, nextEmployees] = await Promise.all([props.client.loadAutomations(), props.client.loadAutomationInbox(), props.client.loadGlobalDigitalEmployees()]);
      setTasks(nextTasks);
      setInbox(nextInbox);
      setEmployees(nextEmployees);
    } catch (cause) {
      setError(formatVisibleApplicationError(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // 首次进入并行读取规则、收件箱和员工；后续由用户显式刷新，避免打断编辑。
  }, [props.client]);

  /** 编辑旧规则时沿用保存的领取方式，未选择策略的新规则才使用原有默认。 */
  const taskSelection = draft.action?.taskSelection ?? (draft.action?.taskId ? 'specified' : draft.action?.useEventTask ? 'event' : 'create');
  /** 指定同一任务不能跨项目复用其身份。 */
  const taskProjectId = draft.projectIds.length === 1 ? draft.projectIds[0] : null;
  useEffect(() => {
    setProjectTasks([]);
    setProjectTasksError(null);
    if (!props.client || !editingId || draft.action?.kind !== 'project_task' || taskSelection !== 'specified' || !taskProjectId) {
      setProjectTasksLoading(false);
      return;
    }
    /** 切换目标后丢弃旧请求，防止任务目录交叉回写。 */
    let active = true;
    setProjectTasksLoading(true);
    void props.client
      .loadTasks({ projectId: taskProjectId })
      .then((items) => {
        if (active) setProjectTasks(items);
      })
      .catch((cause: unknown) => {
        if (active) setProjectTasksError(formatVisibleApplicationError(cause, zh ? 'zh-CN' : 'en'));
      })
      .finally(() => {
        if (active) setProjectTasksLoading(false);
      });
    return () => {
      active = false;
    };
  }, [draft.action?.kind, editingId, props.client, taskProjectId, taskSelection, zh]);
  const unreadCount = inbox.filter((run) => run.unread).length;
  const allProjectsSelected = userProjects.length > 0 && userProjects.every((project) => draft.projectIds.includes(project.id));
  const projectOptions = [
    { value: noProjectValue, label: zh ? '不使用任何项目' : 'Work without a project', group: zh ? '工作范围' : 'Work scope' },
    ...(userProjects.length > 0 ? [{ value: allProjectsValue, label: zh ? `全选项目（${userProjects.length}）` : `Select all projects (${userProjects.length})`, group: zh ? '批量选择' : 'Bulk selection' }] : []),
    ...userProjects.map((project) => ({ value: project.id, label: project.name, group: zh ? '项目' : 'Projects', searchText: project.localPath })),
  ];
  const projectSelectionValues = draft.projectIds.length === 0 ? [noProjectValue] : allProjectsSelected ? [allProjectsValue, ...draft.projectIds] : draft.projectIds;
  const selectedProjectNames = draft.projectIds.map((id) => userProjects.find((project) => project.id === id)?.name ?? id);
  const projectTriggerLabel = allProjectsSelected
    ? zh
      ? `全部 ${userProjects.length} 个项目`
      : `All ${userProjects.length} projects`
    : selectedProjectNames.length === 0
      ? zh
        ? '不使用任何项目'
        : 'Work without a project'
      : selectedProjectNames.length === 1
        ? selectedProjectNames[0]
        : zh
          ? `已选择 ${selectedProjectNames.length} 个项目`
          : `${selectedProjectNames.length} projects selected`;
  /** 员工动作必须有员工，项目任务必须有业务项目。 */
  const actionValid =
    draft.action?.kind !== 'conversation' &&
    Boolean(draft.action?.employeeId) &&
    (draft.action?.kind !== 'project_task' ||
      (draft.projectIds.length > 0 &&
        taskSelectionConfirmed &&
        (taskSelection !== 'specified' || (Boolean(taskProjectId) && !projectTasksLoading && projectTasks.some((task) => task.id === draft.action?.taskId))) &&
        (taskSelection !== 'event' || draft.triggerKind === 'event')));

  /** 创建时重置草稿，弹窗负责初始焦点。 */
  function startCreate(): void {
    setEditingId('new');
    setDraft(emptyDraft(props.projects));
    setFullAccessAcknowledged(false);
    setError(null);
    setTaskSelectionConfirmed(true);
  }

  /** 编辑沿用已保存配置，不改变运行状态。 */
  function startEdit(task: AutomationTaskRecord): void {
    setTaskSelectionConfirmed(!task.migrationIssue);
    setEditingId(task.id);
    setDraft({
      taskStatusesText: (task.action.taskFilter?.managementStatuses ?? []).join(', '),
      taskTypesText: (task.action.taskFilter?.taskTypes ?? []).join(', '),
      requiredTagsText: (task.action.taskFilter?.requiredTags ?? []).join(', '),
      name: task.name,
      description: task.description,
      prompt: task.prompt,
      projectIds: task.projectIds,
      action: task.action.kind === 'conversation' ? { kind: 'employee_work', employeeId: null } : task.action,
      triggerKind: task.triggerKind,
      triggerConfig: task.triggerConfig,
      timezone: task.timezone,
      conversationMode: task.conversationMode,
      originalConversationId: task.originalConversationId,
      permissionMode: task.permissionMode,
      modelSourceId: task.modelSourceId,
      modelId: task.modelId,
      reasoningEffort: task.reasoningEffort,
      serviceTier: task.serviceTier,
      fastMode: task.fastMode,
      skillId: task.skillId,
      pluginIds: task.pluginIds,
      blockStrategy: task.blockStrategy,
      queueCapacity: task.queueCapacity,
      maxRunsPerDay: task.maxRunsPerDay,
      maxRunsPerDayText: task.maxRunsPerDay?.toString() ?? '',
      maxTokensPerDay: task.maxTokensPerDay,
      maxTokensPerDayText: task.maxTokensPerDay?.toString() ?? '',
      retentionDays: task.retentionDays,
      notifications: task.notifications,
    });
    setFullAccessAcknowledged(false);
    setError(null);
  }

  /** 保存期间锁定表单，权限确认仍按既有服务流程执行。 */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!props.client || !editingId || busyId || !actionValid) return;
    setBusyId(editingId);
    setError(null);
    try {
      const input = normalizeDraft(draft);
      const saved = editingId === 'new' ? await props.client.createAutomation(input) : await props.client.updateAutomation(editingId, tasks.find((task) => task.id === editingId)!.revision, input);
      if (saved.permissionMode === 'full-access' && fullAccessAcknowledged) await props.client.setAutomationFullAccessGrant(saved.id, saved.revision, true);
      setEditingId(null);
      await refresh();
    } catch (cause) {
      setError(formatVisibleApplicationError(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      setBusyId(null);
    }
  }

  /** 所有列表操作共用等待状态，避免同时提交后互相覆盖反馈。 */
  async function mutate(id: string, operation: () => Promise<unknown>): Promise<boolean> {
    if (busyId) return false;
    setBusyId(id);
    setError(null);
    try {
      await operation();
      await refresh();
      return true;
    } catch (cause) {
      setError(formatVisibleApplicationError(cause, zh ? 'zh-CN' : 'en'));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  if (!props.client) {
    return (
      <section className="automations-workspace">
        <p role="alert">{zh ? '自动化服务尚未连接。' : 'Automation service is not connected.'}</p>
      </section>
    );
  }

  return (
    <section className="automations-workspace" aria-labelledby="automations-title">
      <header className="automations-header">
        <div>
          <h1 id="automations-title">{zh ? '自动化' : 'Automations'}</h1>
          <p>{zh ? '按设定时间处理所选项目，并查看每次工作的结果。' : 'Process selected projects on a schedule, and view each work result.'}</p>
        </div>
        <div className="automations-header-actions">
          <Button aria-label={zh ? '刷新自动化' : 'Refresh automations'} onClick={() => void refresh()} busy={loading} disabled={loading || Boolean(busyId)}>
            <Refresh aria-hidden="true" />
            {zh ? '刷新' : 'Refresh'}
          </Button>
          <Button variant="primary" onClick={startCreate} disabled={loading || Boolean(busyId)}>
            <Plus aria-hidden="true" />
            {zh ? '新建自动化' : 'New automation'}
          </Button>
        </div>
      </header>

      <nav className="automations-tabs" aria-label={zh ? '自动化视图' : 'Automation views'}>
        <button type="button" aria-current={view === 'tasks' ? 'page' : undefined} onClick={() => setView('tasks')}>
          <Clock aria-hidden="true" />
          {zh ? '任务' : 'Tasks'}
          <span>{tasks.length}</span>
        </button>
        <button type="button" aria-current={view === 'inbox' ? 'page' : undefined} onClick={() => setView('inbox')}>
          <Inbox aria-hidden="true" />
          {zh ? '收件箱' : 'Inbox'}
          {unreadCount ? <span className="automations-unread-count">{unreadCount}</span> : null}
        </button>
      </nav>

      {error && !editingId && !pendingDelete ? (
        <p className="automations-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="automations-layout">
        <div className="automations-list" aria-busy={loading}>
          {view === 'tasks' ? (
            loading && !tasks.length ? (
              <div className="automations-empty" role="status">
                {zh ? '正在读取自动化…' : 'Loading automations…'}
              </div>
            ) : tasks.length ? (
              tasks.map((task) => (
                <article className="automation-row" key={task.id} data-status={task.status}>
                  <button type="button" className="automation-row-main" disabled={Boolean(busyId)} onClick={() => startEdit(task)}>
                    <span className="automation-status-dot" aria-hidden="true" />
                    <span>
                      <strong>{task.name}</strong>
                      <small>
                        {projectNames(task.projectIds, props.projects, zh)} · {zh ? '统一执行默认' : 'Shared execution defaults'}
                      </small>
                      {task.migrationIssue ? <small className="automation-warning">{task.migrationIssue}</small> : null}
                    </span>
                    <span className="automation-row-schedule">{scheduleLabel(task, zh)}</span>
                  </button>
                  <div className="automation-row-actions">
                    {task.status === 'active' ? (
                      <Button
                        className="automation-icon-action"
                        title={zh ? '立即运行' : 'Run now'}
                        aria-label={`${zh ? '立即运行' : 'Run'} ${task.name}`}
                        busy={busyId === `run:${task.id}`}
                        disabled={Boolean(busyId)}
                        onClick={() => void mutate(`run:${task.id}`, () => props.client!.runAutomation(task.id))}
                      >
                        <Play aria-hidden="true" />
                      </Button>
                    ) : null}
                    <Button
                      className="automation-icon-action"
                      title={task.status === 'active' ? (zh ? '暂停' : 'Pause') : zh ? '继续' : 'Resume'}
                      aria-label={`${task.status === 'active' ? (zh ? '暂停' : 'Pause') : zh ? '继续' : 'Resume'} ${task.name}`}
                      busy={busyId === `status:${task.id}`}
                      disabled={Boolean(busyId)}
                      onClick={() => void mutate(`status:${task.id}`, () => props.client!.setAutomationStatus(task.id, task.status === 'active' ? 'paused' : 'active'))}
                    >
                      {task.status === 'active' ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                    </Button>
                    <Button className="automation-icon-action" variant="danger" title={zh ? '删除' : 'Delete'} aria-label={`${zh ? '删除' : 'Delete'} ${task.name}`} disabled={Boolean(busyId)} onClick={() => setPendingDelete(task)}>
                      <Trash aria-hidden="true" />
                    </Button>
                  </div>
                </article>
              ))
            ) : (
              <EmptyState title={zh ? '还没有自动化' : 'No automations yet'} body={zh ? '创建自动化，让重复工作按时执行。' : 'Create an automation to run recurring work on a schedule.'} />
            )
          ) : inbox.length ? (
            inbox.map((run) => {
              const task = tasks.find((candidate) => candidate.id === run.automationId);
              /** 冻结引用的身份不会随项目顺序或刷新变化。 */
              const reference = run.executionReferences.find((item) => executionReferenceKey(item) === selectedExecutions[run.id]) ?? run.executionReferences[0];
              return (
                <article className="automation-inbox-row" key={run.id} data-unread={run.unread ? 'true' : 'false'}>
                  <span className={`automation-run-status status-${run.status}`}>{runStatusLabel(run.status, zh)}</span>
                  <div>
                    <strong>{task?.name ?? run.automationId}</strong>
                    <small>
                      {projectNames(run.projectIds, props.projects, zh)} · {formatDate(run.completedAt ?? run.createdAt)}
                    </small>
                    {run.dispatchTargets.length > 0 ? (
                      <>
                        <p>
                          {zh
                            ? `已接纳 ${run.dispatchTargets.filter((target) => target.status === 'accepted').length} / ${run.dispatchTargets.length} · 未接纳 ${run.dispatchTargets.filter((target) => target.status === 'pending' || target.status === 'accepting').length} · 跳过 ${run.dispatchTargets.filter((target) => target.status === 'skipped').length}`
                            : `Accepted ${run.dispatchTargets.filter((target) => target.status === 'accepted').length} / ${run.dispatchTargets.length} · Pending ${run.dispatchTargets.filter((target) => target.status === 'pending' || target.status === 'accepting').length} · Skipped ${run.dispatchTargets.filter((target) => target.status === 'skipped').length}`}
                        </p>
                        <ul>
                          {run.dispatchTargets.map((target) => (
                            <li key={target.projectId}>
                              {target.projectId === temporaryWorkspaceId ? (zh ? '无项目工作' : 'Work without a project') : (props.projects.find((project) => project.id === target.projectId)?.name ?? target.projectId)}
                              {' · '}
                              {{ pending: zh ? '尚未接纳' : 'Pending', accepting: zh ? '接纳结果待核对' : 'Reconciling acceptance', accepted: zh ? '已接纳' : 'Accepted', skipped: zh ? '未执行工作' : 'No work executed' }[target.status]}
                              {target.reason ? ` · ${target.reason}` : ''}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {run.errorMessage ? (
                      <p>
                        <VisibleApplicationError error={{ code: run.errorCode, message: run.errorMessage }} language={zh ? 'zh-CN' : 'en'} />
                      </p>
                    ) : null}
                    {run.mayOverlapPrevious ? <p className="automation-warning">{zh ? '可能与旧运行重叠' : 'May overlap a previous run'}</p> : null}
                    {run.dispatchReconciliation ? <p className="automation-warning">{run.dispatchReconciliation.reason}</p> : null}
                  </div>
                  <div className="automation-inbox-actions">
                    {run.executionReferences.length > 1 ? (
                      <ZeusSelect
                        size="compact"
                        ariaLabel={zh ? '选择实际执行工作' : 'Choose execution'}
                        value={reference ? executionReferenceKey(reference) : ''}
                        options={run.executionReferences.map((item, index) => ({
                          value: executionReferenceKey(item),
                          label:
                            props.projects.find((project) => project.id === run.dispatchTargets.find((target) => target.reference && executionReferenceKey(target.reference) === executionReferenceKey(item))?.projectId)?.name ??
                            (zh ? `工作 ${index + 1}` : `Work ${index + 1}`),
                        }))}
                        onChange={(value) => setSelectedExecutions((current) => ({ ...current, [run.id]: value }))}
                        disabled={Boolean(busyId)}
                      />
                    ) : null}
                    {reference?.kind === 'workflow' || reference?.kind === 'task_work' || reference?.conversationId ? (
                      <Button
                        disabled={Boolean(busyId)}
                        onClick={() => void props.onOpenExecution(run, reference, reference.kind === 'workflow' ? 'workflow' : 'conversation').catch((cause: unknown) => setError(formatVisibleApplicationError(cause, zh ? 'zh-CN' : 'en')))}
                      >
                        {reference.kind === 'workflow' ? (zh ? '查看流程' : 'Open workflow') : zh ? '打开工作会话' : 'Open work conversation'}
                      </Button>
                    ) : null}
                    {reference?.taskId ? (
                      <Button disabled={Boolean(busyId)} onClick={() => void props.onOpenExecution(run, reference, 'task').catch((cause: unknown) => setError(formatVisibleApplicationError(cause, zh ? 'zh-CN' : 'en')))}>
                        {zh ? '查看任务与成果' : 'Open task and deliverables'}
                      </Button>
                    ) : null}
                    {run.conversationId ? (
                      <Button disabled={Boolean(busyId)} onClick={() => void props.onOpenConversation(run).catch((cause: unknown) => setError(formatVisibleApplicationError(cause, zh ? 'zh-CN' : 'en')))}>
                        {zh ? '打开会话' : 'Open conversation'}
                      </Button>
                    ) : null}
                    {run.unread ? (
                      <Button busy={busyId === `read:${run.id}`} disabled={Boolean(busyId)} onClick={() => void mutate(`read:${run.id}`, () => props.client!.acknowledgeAutomationRun(run.id))}>
                        {zh ? '标为已读' : 'Mark read'}
                      </Button>
                    ) : null}
                    {(run.status === 'blocked' || run.status === 'outcome_unknown') && !run.dispatchCompletedAt && run.dispatchTargets.some((target) => target.status === 'pending' || target.status === 'accepting') ? (
                      <Button busy={busyId === `resume:${run.id}`} disabled={Boolean(busyId)} onClick={() => void mutate(`resume:${run.id}`, () => props.client!.resumeAutomationRun(run.id))}>
                        {zh ? '继续剩余项目' : 'Resume remaining projects'}
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })
          ) : (
            <EmptyState title={zh ? '收件箱很安静' : 'Inbox is quiet'} body={zh ? '自动化的运行结果和需要你处理的问题会显示在这里。' : 'Automation results and requests for your attention appear here.'} />
          )}
        </div>
      </div>
      <MotionPresence>
        {editingId ? (
          <FormDialog
            className="automation-editor"
            title={editingId === 'new' ? (zh ? '新建自动化' : 'New automation') : zh ? '编辑自动化' : 'Edit automation'}
            zh={zh}
            busy={Boolean(busyId)}
            submitLabel={editingId === 'new' ? (zh ? '创建并启用' : 'Create and enable') : zh ? '保存更改' : 'Save changes'}
            submitDisabled={!draft.name.trim() || !draft.prompt.trim() || !actionValid || (draft.permissionMode === 'full-access' && !fullAccessAcknowledged)}
            onClose={() => setEditingId(null)}
            onSubmit={(event) => void submit(event)}
          >
            {error ? (
              <p className="automations-error" role="alert">
                {error}
              </p>
            ) : null}
            <fieldset className="automation-form-section">
              <legend>{zh ? '执行内容' : 'Instructions and projects'}</legend>
              <label>
                <span>{zh ? '名称' : 'Name'}</span>
                <input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
              </label>
              <label>
                <span>{zh ? '指令' : 'Instruction'}</span>
                <textarea required rows={7} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })} />
              </label>
              <div className="automation-form-field">
                <span>{zh ? '目标项目' : 'Target projects'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '选择目标项目' : 'Choose target projects'}
                  value=""
                  selectedValues={projectSelectionValues}
                  options={projectOptions}
                  onChange={(value) => {
                    if (value === noProjectValue) {
                      setDraft({ ...draft, projectIds: [] });
                      return;
                    }
                    if (value === allProjectsValue) {
                      setDraft({ ...draft, projectIds: allProjectsSelected ? [] : userProjects.map((project) => project.id) });
                      return;
                    }
                    setDraft({ ...draft, projectIds: draft.projectIds.includes(value) ? draft.projectIds.filter((id) => id !== value) : [...draft.projectIds, value] });
                  }}
                  triggerLabel={projectTriggerLabel}
                  searchable={userProjects.length > 8}
                  searchPlaceholder={zh ? '搜索项目' : 'Search projects'}
                  emptyLabel={zh ? '没有匹配的项目' : 'No matching projects'}
                />
                {draft.projectIds.length === 0 ? <small>{zh ? '本次运行不会读取或修改任何用户项目，仅使用 Zeus 临时工作区。' : 'This run cannot read or modify user projects and only uses the Zeus temporary workspace.'}</small> : null}
              </div>
            </fieldset>
            <fieldset className="automation-form-section">
              <legend>{zh ? '执行动作' : 'Action'}</legend>
              {tasks.find((task) => task.id === editingId)?.migrationIssue ? <p role="status">{tasks.find((task) => task.id === editingId)!.migrationIssue}</p> : null}
              <SelectField
                label={zh ? '动作' : 'Action'}
                value={draft.action?.kind ?? 'employee_work'}
                options={[
                  ['employee_work', zh ? '员工工作' : 'Employee work'],
                  ['project_task', zh ? '处理项目任务' : 'Process project tasks'],
                ]}
                onChange={(value) => {
                  setDraft({
                    ...draft,
                    action: { ...draft.action, kind: value as AutomationActionKind, employeeId: draft.action?.employeeId ?? null },
                    conversationMode: 'independent',
                    originalConversationId: null,
                  });
                  setFullAccessAcknowledged(false);
                }}
              />
              {draft.action?.kind !== 'conversation' && draft.action?.kind ? (
                <SelectField
                  label={zh ? '员工' : 'Employee'}
                  value={draft.action.employeeId ?? ''}
                  options={[['', zh ? '选择员工' : 'Select employee'], ...employees.map((employee): [string, string] => [employee.id, employee.name])]}
                  onChange={(value) => setDraft({ ...draft, action: { ...draft.action!, employeeId: value || null } })}
                />
              ) : null}
              {draft.action?.kind === 'project_task' ? (
                <>
                  <SelectField
                    label={zh ? '任务选择' : 'Task selection'}
                    value={taskSelectionConfirmed ? taskSelection : ''}
                    options={[
                      ...(!taskSelectionConfirmed ? [['', zh ? '请核对并重选任务方式' : 'Confirm the task selection'] as [string, string]] : []),
                      ['specified', zh ? '指定已有任务' : 'Specified existing task'],
                      ['event', zh ? '使用事件任务' : 'Event task'],
                      ['pool', zh ? '领取任务池任务' : 'Claim from task pool'],
                      ['create', zh ? '创建新任务' : 'Create new task'],
                    ]}
                    onChange={(value) => {
                      if (!value) return;
                      setTaskSelectionConfirmed(true);
                      setDraft({
                        ...draft,
                        ...(value === 'event' ? { triggerKind: 'event' } : {}),
                        action: {
                          ...draft.action!,
                          taskSelection: value as NonNullable<AutomationTaskInput['action']>['taskSelection'],
                          taskId: value === 'specified' ? (draft.action?.taskId ?? null) : null,
                          useEventTask: value === 'event',
                        },
                      });
                    }}
                  />
                  {taskSelection === 'specified' ? (
                    <label>
                      <span>{zh ? '已有任务' : 'Existing task'}</span>
                      <ZeusSelect
                        size="regular"
                        ariaLabel={zh ? '指定已有任务' : 'Select an existing task'}
                        value={draft.action.taskId ?? ''}
                        disabled={!taskProjectId || projectTasksLoading}
                        options={[
                          { value: '', label: zh ? '选择任务' : 'Select task' },
                          ...projectTasks.map((task) => ({ value: task.id, label: `${task.taskCode ?? task.id} · ${task.title}` })),
                          ...(draft.action.taskId && !projectTasks.some((task) => task.id === draft.action?.taskId)
                            ? [{ value: draft.action.taskId, label: zh ? '原任务当前不可用，请重新选择' : 'The saved task is unavailable; select again', disabled: true }]
                            : []),
                        ]}
                        onChange={(taskId) => setDraft({ ...draft, action: { ...draft.action!, taskId: taskId || null } })}
                        searchable
                      />
                      {!taskProjectId ? <small>{zh ? '指定已有任务需要只选择一个目标项目。' : 'Choose one target project for a specified task.'}</small> : null}
                      {projectTasksLoading ? <small role="status">{zh ? '正在读取任务…' : 'Loading tasks…'}</small> : null}
                      {projectTasksError ? <small role="alert">{projectTasksError}</small> : null}
                    </label>
                  ) : null}
                  {taskSelection !== 'create' ? (
                    <div className="automation-form-grid">
                      {(
                        [
                          ['taskStatusesText', zh ? '任务状态（逗号分隔，空为不限）' : 'Task statuses (comma separated)'],
                          ['taskTypesText', zh ? '任务类型（逗号分隔，空为不限）' : 'Task types (comma separated)'],
                          ['requiredTagsText', zh ? '必须包含的标签（逗号分隔）' : 'Required tags (comma separated)'],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key}>
                          <span>{label}</span>
                          <input value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.currentTarget.value })} />
                        </label>
                      ))}
                    </div>
                  ) : null}
                  {taskSelection === 'pool' ? <small>{zh ? '没有符合规则筛选的任务时跳过该项目，不创建替代任务。' : 'Skip a project with no eligible tasks; no substitute task is created.'}</small> : null}
                  {taskSelection === 'event' ? <small>{zh ? '只处理本次事件所属的任务，需要使用事件触发。' : 'Process the task belonging to the source event; requires an event trigger.'}</small> : null}
                </>
              ) : null}
              {!actionValid ? (
                <small role="status">
                  {zh
                    ? !draft.action?.employeeId
                      ? '请选择员工。'
                      : !draft.projectIds.length && draft.action?.kind === 'project_task'
                        ? '请选择目标项目。'
                        : !taskSelectionConfirmed
                          ? '请核对并重选任务方式。'
                          : taskSelection === 'specified'
                            ? '请选择当前项目的已有任务。'
                            : '事件任务需要使用事件触发。'
                    : 'Complete the employee, target project, or task selection above.'}
                </small>
              ) : null}
            </fieldset>
            <fieldset className="automation-form-section">
              <legend>{zh ? '运行安排' : 'Schedule'}</legend>
              <div className="automation-form-grid">
                <SelectField label={zh ? '触发方式' : 'Trigger'} value={draft.triggerKind ?? 'manual'} options={triggerOptions(zh)} onChange={(value) => setDraft({ ...draft, triggerKind: value as AutomationTriggerKind })} />
                <SelectField
                  label={zh ? '重复触发时' : 'Overlapping triggers'}
                  value={draft.blockStrategy ?? 'serial'}
                  options={[
                    ['serial', zh ? '依次执行' : 'Queue'],
                    ['discard', zh ? '跳过新触发' : 'Discard new'],
                    ['cover', zh ? '替换待执行项' : 'Replace queued'],
                  ]}
                  onChange={(value) => setDraft({ ...draft, blockStrategy: value as AutomationBlockStrategy })}
                />
              </div>
              <TriggerFields draft={draft} setDraft={setDraft} zh={zh} />
              <small>{zh ? `按 ${draft.timezone || 'UTC'} 时间运行` : `Runs in ${draft.timezone || 'UTC'}`}</small>
            </fieldset>
            <fieldset className="automation-form-section">
              <legend>{zh ? '执行权限' : 'Permissions'}</legend>
              <p>{zh ? '使用统一执行默认；以下权限限制本次自动化。' : 'Uses shared execution defaults; these permissions limit this automation.'}</p>
              <div className="automation-form-grid">
                <SelectField
                  label={zh ? '权限' : 'Permission'}
                  value={draft.permissionMode ?? 'read-only'}
                  options={[
                    ['read-only', zh ? '只读' : 'Read only'],
                    ['auto', zh ? '需审批写入' : 'Approve writes'],
                    ['full-access', zh ? '完全访问' : 'Full access'],
                  ]}
                  onChange={(value) => {
                    setDraft({ ...draft, permissionMode: value as AutomationPermissionMode });
                    setFullAccessAcknowledged(false);
                  }}
                />
              </div>
              {draft.permissionMode === 'full-access' ? (
                <label className="automation-risk-ack">
                  <input type="checkbox" checked={fullAccessAcknowledged} onChange={(event) => setFullAccessAcknowledged(event.currentTarget.checked)} />
                  <span>
                    {draft.action?.kind === 'project_task'
                      ? zh
                        ? '我允许此自动化持续修改代码、执行验证和创建本地 Git 提交，直到我修改或撤销授权；推送、合并和部署需另行授权。'
                        : 'I allow this automation to change code, run verification, and create local Git commits until I change or revoke this grant. Pushing, merging, and deployment require separate authorization.'
                      : zh
                        ? '我允许此自动化持续使用以上权限，直到我修改或撤销授权；执行的操作可能无法撤销。'
                        : 'I allow this automation to keep using these permissions until I change or revoke them. Its actions may be irreversible.'}
                  </span>
                </label>
              ) : null}
            </fieldset>

            <details className="automation-advanced-settings">
              <summary>{zh ? '高级设置' : 'Advanced settings'}</summary>
              <label>
                <span>{zh ? '时区（如 Asia/Shanghai）' : 'Time zone (for example, Asia/Shanghai)'}</span>
                <input value={draft.timezone ?? ''} onChange={(event) => setDraft({ ...draft, timezone: event.currentTarget.value })} />
              </label>
              <div className="automation-form-grid">
                <label>
                  <span>{zh ? '每日运行上限' : 'Runs per day'}</span>
                  <input type="number" min="1" value={draft.maxRunsPerDayText} placeholder={zh ? '不限' : 'Unlimited'} onChange={(event) => setDraft({ ...draft, maxRunsPerDayText: event.currentTarget.value })} />
                </label>
                <label>
                  <span>{zh ? '每日用量上限（Token）' : 'Daily usage limit (tokens)'}</span>
                  <input type="number" min="1" value={draft.maxTokensPerDayText} placeholder={zh ? '不限' : 'Unlimited'} onChange={(event) => setDraft({ ...draft, maxTokensPerDayText: event.currentTarget.value })} />
                </label>
              </div>
            </details>
          </FormDialog>
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {pendingDelete ? (
          <FormDialog
            title={zh ? `删除“${pendingDelete.name}”？` : `Delete “${pendingDelete.name}”?`}
            description={zh ? '此自动化将不再接受新的运行，历史运行记录会保留。' : 'This automation will no longer accept new runs. Run history is kept.'}
            zh={zh}
            busy={Boolean(busyId)}
            danger
            submitLabel={zh ? '删除自动化' : 'Delete automation'}
            onClose={() => setPendingDelete(null)}
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(`delete:${pendingDelete.id}`, () => props.client!.deleteAutomation(pendingDelete.id)).then((deleted) => {
                if (deleted) setPendingDelete(null);
              });
            }}
          >
            {error ? (
              <p className="automations-error" role="alert">
                {error}
              </p>
            ) : null}
          </FormDialog>
        ) : null}
      </MotionPresence>
    </section>
  );
}

/** 同一运行内不同执行种类与身份共同组成稳定选择值。 */
function executionReferenceKey(reference: AutomationExecutionReference): string {
  return `${reference.kind}:${reference.id}`;
}

function EmptyState(props: { title: string; body: string }) {
  return (
    <section className="automations-empty">
      <Clock aria-hidden="true" />
      <strong>{props.title}</strong>
      <p>{props.body}</p>
    </section>
  );
}

function SelectField(props: { label: string; value: string; options: Array<[string, string]>; onChange(value: string): void }) {
  return (
    <label>
      <span>{props.label}</span>
      <ZeusSelect size="regular" ariaLabel={props.label} value={props.value} options={props.options.map(([value, label]) => ({ value, label }))} onChange={props.onChange} searchable={false} />
    </label>
  );
}

function TriggerFields(props: { draft: Draft; setDraft(value: Draft): void; zh: boolean }) {
  const { draft } = props;
  if (draft.triggerKind === 'interval')
    return (
      <label>
        <span>{props.zh ? '间隔分钟' : 'Interval minutes'}</span>
        <input type="number" min="1" value={draft.triggerConfig?.everyMinutes ?? 60} onChange={(event) => props.setDraft({ ...draft, triggerConfig: { ...draft.triggerConfig, everyMinutes: event.currentTarget.valueAsNumber } })} />
      </label>
    );
  if (draft.triggerKind === 'once')
    return (
      <label>
        <span>{props.zh ? '执行时间' : 'Run at'}</span>
        <input
          type="datetime-local"
          value={draft.triggerConfig?.at?.slice(0, 16) ?? ''}
          onChange={(event) => props.setDraft({ ...draft, triggerConfig: { ...draft.triggerConfig, at: event.currentTarget.value ? new Date(event.currentTarget.value).toISOString() : undefined } })}
        />
      </label>
    );
  if (draft.triggerKind === 'daily' || draft.triggerKind === 'weekly')
    return (
      <label>
        <span>{props.zh ? '当地时间' : 'Local time'}</span>
        <input type="time" value={draft.triggerConfig?.localTime ?? '09:00'} onChange={(event) => props.setDraft({ ...draft, triggerConfig: { ...draft.triggerConfig, localTime: event.currentTarget.value } })} />
      </label>
    );
  if (draft.triggerKind === 'rrule')
    return (
      <label>
        <span>RFC 5545 RRULE</span>
        <input placeholder="FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9" value={draft.triggerConfig?.rrule ?? ''} onChange={(event) => props.setDraft({ ...draft, triggerConfig: { ...draft.triggerConfig, rrule: event.currentTarget.value } })} />
      </label>
    );
  if (draft.triggerKind === 'event') {
    /** 任务事件和代码事件使用独立流，选择代码时明确替换原流。 */
    const eventOptions = [
      { value: 'task_created', label: props.zh ? '任务创建' : 'Task created' },
      { value: 'task_updated', label: props.zh ? '任务更新' : 'Task updated' },
      { value: 'task_status_changed', label: props.zh ? '任务状态改变' : 'Task status changed' },
      { value: 'code_changed', label: props.zh ? '代码变化' : 'Code changed' },
    ];
    /** 保存过的精确筛选不能在简化界面时被丢弃。 */
    const selected = draft.triggerConfig?.eventKinds ?? [];
    return (
      <label>
        <span>{props.zh ? '触发事件' : 'Trigger events'}</span>
        <ZeusSelect
          size="regular"
          ariaLabel={props.zh ? '选择触发事件' : 'Choose trigger events'}
          value=""
          selectedValues={selected}
          options={[{ value: '', label: props.zh ? '全部任务事件' : 'All task events' }, ...eventOptions, ...selected.filter((value) => !eventOptions.some((option) => option.value === value)).map((value) => ({ value, label: value }))]}
          triggerLabel={selected.length ? selected.map((value) => eventOptions.find((option) => option.value === value)?.label ?? value).join('、') : props.zh ? '全部任务事件' : 'All task events'}
          onChange={(value) => {
            /** 只改用户明确选择的筛选，不改变任务选择策略。 */
            const taskEvents = selected.filter((kind) => kind !== 'code_changed');
            const eventKinds = !value ? [] : value === 'code_changed' ? ['code_changed'] : taskEvents.includes(value) ? taskEvents.filter((kind) => kind !== value) : [...taskEvents, value];
            props.setDraft({ ...draft, triggerConfig: { ...draft.triggerConfig, eventKinds } });
          }}
        />
      </label>
    );
  }
  return null;
}

/** 新建规则只选择员工动作，执行配置由统一默认提供。 */
function emptyDraft(projects: ProjectRecord[]): Draft {
  /** 新建时仍沿用首个真实项目；用户可显式切换为无项目。 */
  const firstProject = projects.find((project) => project.id !== temporaryWorkspaceId);
  return {
    action: { kind: 'employee_work', employeeId: null },
    taskStatusesText: '',
    taskTypesText: '',
    requiredTagsText: '',
    name: '',
    description: '',
    prompt: '',
    projectIds: firstProject ? [firstProject.id] : [],
    triggerKind: 'manual',
    triggerConfig: {},
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    conversationMode: 'independent',
    originalConversationId: null,
    permissionMode: 'read-only',
    modelSourceId: 'inherit',
    modelId: 'inherit',
    reasoningEffort: null,
    serviceTier: null,
    fastMode: false,
    skillId: null,
    pluginIds: [],
    blockStrategy: 'serial',
    queueCapacity: 10,
    maxRunsPerDay: null,
    maxRunsPerDayText: '',
    maxTokensPerDay: null,
    maxTokensPerDayText: '',
    retentionDays: 30,
    notifications: { success: true, failure: true, blocked: true },
  };
}

/** 只提交业务触发配置，执行参数由统一默认决定。 */
function normalizeDraft(draft: Draft): AutomationTaskInput {
  return {
    name: draft.name,
    description: draft.description,
    prompt: draft.prompt,
    projectIds: draft.projectIds,
    action:
      draft.action?.kind === 'project_task'
        ? {
            ...draft.action,
            taskSelection: draft.action.taskSelection ?? (draft.action.taskId ? 'specified' : draft.action.useEventTask ? 'event' : 'create'),
            taskFilter: { managementStatuses: splitFilterValues(draft.taskStatusesText), taskTypes: splitFilterValues(draft.taskTypesText), requiredTags: splitFilterValues(draft.requiredTagsText) },
          }
        : draft.action,
    triggerKind: draft.triggerKind,
    triggerConfig: draft.triggerConfig,
    timezone: draft.timezone,
    permissionMode: draft.permissionMode,
    blockStrategy: draft.blockStrategy,
    notifications: draft.notifications,
    maxRunsPerDay: draft.maxRunsPerDayText ? Number(draft.maxRunsPerDayText) : null,
    maxTokensPerDay: draft.maxTokensPerDayText ? Number(draft.maxTokensPerDayText) : null,
  };
}

/** 保存时解析筛选，输入过程中保留分隔符。 */
function splitFilterValues(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,，]/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function triggerOptions(zh: boolean): Array<[string, string]> {
  return [
    ['manual', zh ? '仅手动' : 'Manual only'],
    ['once', zh ? '单次' : 'Once'],
    ['interval', zh ? '固定间隔' : 'Interval'],
    ['daily', zh ? '每日' : 'Daily'],
    ['weekly', zh ? '每周' : 'Weekly'],
    ['rrule', zh ? '自定义重复规则（RRULE）' : 'Custom recurrence rule (RRULE)'],
    ['event', zh ? '事件触发' : 'Event'],
  ];
}

/** 把空目标明确展示成无项目，避免空白被误解为加载失败。 */
function projectNames(ids: string[], projects: ProjectRecord[], zh: boolean): string {
  return ids.length === 0 ? (zh ? '无项目' : 'No project') : ids.map((id) => projects.find((project) => project.id === id)?.name ?? id).join(', ');
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function scheduleLabel(task: AutomationTaskRecord, zh: boolean): string {
  if (task.status === 'paused') return zh ? '已暂停' : 'Paused';
  if (task.triggerKind === 'manual') return zh ? '手动触发' : 'Manual';
  return task.nextRunAt ? formatDate(task.nextRunAt) : zh ? '等待计算' : 'Awaiting schedule';
}
function runStatusLabel(status: AutomationRunRecord['status'], zh: boolean): string {
  const labels = zh
    ? { queued: '排队', dispatching: '正在启动', running: '运行中', succeeded: '成功', failed: '失败', blocked: '等待处理', cancelled: '已取消', outcome_unknown: '结果未知' }
    : { queued: 'Queued', dispatching: 'Starting', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', blocked: 'Needs attention', cancelled: 'Cancelled', outcome_unknown: 'Unknown' };
  return labels[status];
}
