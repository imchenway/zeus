import {
  digitalTeamExecutionDefinition,
  digitalTeamWorkflowSchemaGeneration,
  defaultTaskManagementStatusConfig,
  defaultTaskManagementStatusLabels,
  normalizeTaskManagementStatusConfig,
  normalizeDigitalTeamWorkflowDefinition,
  validateDigitalTeamWorkflowDefinition,
  validateDigitalTeamProjectWorkflowStatuses,
  type DigitalTeamEmployeeNode,
  type DigitalTeamNode,
  type DigitalTeamNodeAttemptRecord,
  type DigitalTeamNodeType,
  type DigitalTeamWorkflowDefinition,
  type DigitalTeamWorkflowRunRecord,
  type DigitalTeamWorkflowTemplateRecord,
  type DigitalTeamWorkflowValidationIssue,
  type TaskManagementStatusDefinition,
} from '@zeus/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent } from 'react';
import { ArrowClockwiseIcon as Refresh } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { PauseIcon as Pause } from '@phosphor-icons/react/dist/csr/Pause';
import { PlayIcon as Play } from '@phosphor-icons/react/dist/csr/Play';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import type { DashboardClient } from '../../dashboardClient.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { formatVisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { Button } from '../../ui/Button.js';
import { FormDialog } from '../../ui/FormDialog.js';
import { MotionPresence } from '../../ui/MotionPresence.js';
import type { TaskRecord } from '../tasks/taskContracts.js';
import { DigitalEmployeeAvatar } from '../digital-employees/DigitalEmployeeAvatar.js';
import type { DigitalEmployeeTemplateRecord } from '../digital-employees/digitalEmployeeContracts.js';
import type { ProjectRecord } from '../projects/projectContracts.js';
import { type DigitalTeamApiClient, type DigitalTeamRunProjection } from './digitalTeamApiClient.js';
import { forgetDigitalTeamDraft, readDigitalTeamDraft, readDigitalTeamDraftSelection, rememberDigitalTeamDraft, rememberDigitalTeamDraftSelection, type DigitalTeamTemplateDraft } from './digitalTeamDraftStorage.js';
import { buildDigitalTeamDevelopmentDraft, digitalTeamMemberDefaults, withDigitalTeamDefaultRepairEmployee } from './digitalTeamMemberDefaults.js';
import { digitalTeamRunReadOnlyDescription, digitalTeamRunStatusLabel, getDigitalTeamRunBlocker } from './digitalTeamRunPresentation.js';
import { digitalTeamDragMime, digitalTeamWorkModeLabels, isConnectionAllowed, WorkflowCanvas, type DigitalTeamCanvasRuntimeState, type DigitalTeamDragPayload } from './WorkflowCanvas.js';
import './digitalTeams.css';

/** 数字团队页面支持的两个真实数据视图。 */
type DigitalTeamView = 'editor' | 'runs';

/** 任务详情下拉进入数字团队时携带的明确目标。 */
export type DigitalTeamEntrySelection = { kind: 'template'; templateId: string } | { kind: 'run'; runId: string } | { kind: 'manage' };

/** 页面编辑与本地恢复共用准确的草稿协议。 */
type TemplateDraft = DigitalTeamTemplateDraft;

/** 团队节点编辑只读取已创建的全局员工。 */
type DigitalTeamMemberRecord = DigitalEmployeeTemplateRecord;

/** 人工决定弹窗统一覆盖批准、退回和返工。 */
type RunDecision = { kind: 'approve' | 'reject' | 'rework'; nodeId: string; attempt: number };

/** 无项目时使用的选择值。 */
const noProjectValue = '__no_digital_team_project__';

/** 历史流程明确未分配员工的占位身份，不作为真实员工显示。 */
const unassignedEmployeeId = '__unassigned_digital_team_employee__';

/** 待分配属于正常草稿配置，仍阻止创建运行但不展示红色错误。 */
const unassignedEmployeeIssueCode = 'ZEUS_DIGITAL_TEAM_EMPLOYEE_UNASSIGNED';

/** 保存回执只在本窗口传递，让离开后返回的编辑器安全接纳准确新基线。 */
const draftSavedEvent = 'zeus:digital-team-draft-saved';

/** 提交原值与真实保存结果必须一起传递，不能仅凭团队身份覆盖新输入。 */
interface DraftSavedDetail {
  /** 用户点击保存时的完整草稿。 */
  submittedDraft: TemplateDraft;
  /** 正常 API 返回的已保存团队。 */
  savedTemplate: DigitalTeamWorkflowTemplateRecord;
}

/** 窄窗口统一把节点检查器切换为覆盖抽屉。 */
const compactInspectorQuery = '(max-width: 1180px)';

/** 终态运行只允许读取，不再显示派发控制或返工入口。 */
const terminalRunStatuses = new Set<DigitalTeamWorkflowRunRecord['status']>(['completed', 'failed', 'cancelled']);

/** 活动运行定期核对真实投影，补齐断线期间未送达的状态事件。 */
const runReconciliationIntervalMs = 10_000;

/** 数字团队页面属性只依赖统一客户端与项目事实。 */
export interface DigitalTeamWorkspaceProps {
  /** 当前 Renderer 统一客户端。 */
  client: DashboardClient | null;
  /** 可选择的真实项目。 */
  projects: ProjectRecord[];
  /** 从当前工作区继承的项目。 */
  initialProjectId?: string;
  /** 从任务详情进入时，运行直接绑定该任务。 */
  task?: TaskRecord;
  /** 从任务详情下拉选择的工作流、运行或管理入口。 */
  initialSelection?: DigitalTeamEntrySelection;
  /** 全局团队通过现有任务创建入口发起工作。 */
  onCreateTask?(templateId: string, projectId: string): void;
  /** 返回原任务详情。 */
  onBackToTask?(): void;
  /** 应用语言。 */
  language: 'zh-CN' | 'en-US';
  /** 从节点详情打开已绑定的真实会话。 */
  onOpenConversation?(projectId: string, conversationId: string): Promise<void>;
}

/** 提供模板编辑、真实角色库和只读运行投影。 */
export function DigitalTeamWorkspace(props: DigitalTeamWorkspaceProps) {
  /** 页面交互保持中文产品语义，英文环境提供对应文案。 */
  const zh = props.language === 'zh-CN';
  /** DashboardClient 完成组合后才开放真实操作。 */
  const api = hasDigitalTeamApi(props.client) ? props.client : null;
  /** 初始项目优先沿用当前工作区。 */
  const [projectId, setProjectId] = useState(() => validInitialProjectId(props.projects, props.task?.projectId ?? props.initialProjectId));
  /** 运行记录入口直接进入运行视图，其余入口从流程视图继续。 */
  const [view, setView] = useState<DigitalTeamView>(() => (props.initialSelection?.kind === 'run' ? 'runs' : 'editor'));
  /** 团队定义来自唯一全局目录，运行项目不决定编辑作用域。 */
  const [templates, setTemplates] = useState<DigitalTeamWorkflowTemplateRecord[]>([]);
  /** 状态选择来自全局任务目录，不由节点自行创造状态。 */
  const [projectStatuses, setProjectStatuses] = useState<TaskManagementStatusDefinition[]>(defaultTaskManagementStatusConfig.statuses);
  /** 完成状态按全局角色识别，不能假定固定状态名称。 */
  const [projectStatusRoles, setProjectStatusRoles] = useState(defaultTaskManagementStatusConfig.roles);
  /** 全局团队成员只从已创建的数字员工中选择。 */
  const [employeeTemplates, setEmployeeTemplates] = useState<DigitalEmployeeTemplateRecord[]>([]);
  /** 当前项目的运行历史。 */
  const [runs, setRuns] = useState<DigitalTeamWorkflowRunRecord[]>([]);
  /** 周期对账读取当前列表，不因每次状态变化重建订阅。 */
  const runsRef = useRef(runs);
  runsRef.current = runs;
  /** 本地恢复只读取一次，不在每次输入时重复解析草稿。 */
  const [initialDraft] = useState(() => readDigitalTeamDraft(props.initialSelection?.kind === 'template' ? props.initialSelection.templateId : (readDigitalTeamDraftSelection() ?? null)));
  /** 当前显式编辑的模板草稿。 */
  const [draft, setDraft] = useState<TemplateDraft>(() => initialDraft ?? emptyTemplateDraft());
  /** 无已保存模板时保持创建入口，只有用户明确开始后才展示配置界面。 */
  const [draftOpen, setDraftOpen] = useState(Boolean(initialDraft));
  /** 未保存修改只影响使用团队，不再阻止页面切换。 */
  const [dirty, setDirty] = useState(Boolean(initialDraft));
  /** 成功暂存后关闭窗口无需系统弹窗；失败时明确保留关闭保护。 */
  const [draftPersisted, setDraftPersisted] = useState(!initialDraft);
  /** 离开或异步刷新时读取最新草稿，避免闭包把新输入覆盖成旧版本。 */
  const draftStateRef = useRef({ draft, dirty });
  draftStateRef.current = { draft, dirty };
  /** 检查器选中的节点。 */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  /** 已保存模板、项目或重开变化时重建画布以恢复持久视口。 */
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  /** 当前运行图。 */
  const [selectedRun, setSelectedRun] = useState<DigitalTeamRunProjection | null>(null);
  /** 异步读取不能覆盖人工操作刚接纳的更新修订。 */
  const selectedRunRef = useRef(selectedRun);
  selectedRunRef.current = selectedRun;
  /** 页面读取状态。 */
  const [loading, setLoading] = useState(Boolean(api));
  /** 单个写操作期间禁止重复提交。 */
  const [busy, setBusy] = useState(false);
  /** 可见错误不以控制台或模拟成功替代。 */
  const [error, setError] = useState<string | null>(api ? null : zh ? '当前本地服务尚未提供数字团队接口。' : 'The local service does not provide the digital team API.');
  /** 后台读取错误独立于业务拒绝，恢复成功只能清掉读取错误。 */
  const [reconciliationError, setReconciliationError] = useState<string | null>(null);
  /** 页面级成功与等待状态通过 live region 告知用户。 */
  const [status, setStatus] = useState<string>('');
  /** 删除必须二次确认。 */
  const [pendingDelete, setPendingDelete] = useState<DigitalTeamWorkflowTemplateRecord | null>(null);
  /** 员工选择器按需展开，不长期占用画布列。 */
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  /** 当前人工操作弹窗。 */
  const [runDecision, setRunDecision] = useState<RunDecision | null>(null);
  /** 人工决定必须保存明确原因。 */
  const [decisionReason, setDecisionReason] = useState('');
  /** 媒体查询决定检查器是固定栏还是焦点受控抽屉。 */
  const compactInspector = useCompactInspector();
  /** 项目切换代次防止迟到读取覆盖当前页面。 */
  const loadRevisionRef = useRef(0);
  /** 当前操作改变运行时使此前后台读取失效，不让旧列表覆盖新接纳。 */
  const runReadEpochRef = useRef(0);
  /** 卸载后的旧写入回执不再改当前页面状态。 */
  const mountedRef = useRef(false);

  /** 代码动作才需要用户确认现场和本地修改范围。 */
  const usesCode = draft.definition.nodes.some((node) => node.type === 'employee' && node.data.executionMode === 'isolated_write');
  /** 只有全部员工都实际只读时，才提示当前团队仅做分析。 */
  const analysisOnly = draft.definition.nodes.some((node) => node.type === 'employee') && draft.definition.nodes.every((node) => node.type !== 'employee' || node.data.executionMode === 'read_only');
  /** 当前选中模板的服务端记录。 */
  const selectedTemplate = templates.find((template) => template.id === draft.id) ?? null;
  /** 用户编辑与默认职责补齐都需保存；浏览视口变化不触发保存，也不伪装成用户编辑。 */
  const templateNeedsSave = dirty || !selectedTemplate || JSON.stringify({ ...draft.definition, viewport: selectedTemplate.definition.viewport }) !== JSON.stringify(selectedTemplate.definition);
  /** 团队统一引用已创建的全局员工，项目只决定任务运行位置。 */
  const memberCatalog: DigitalTeamMemberRecord[] = employeeTemplates;
  /** 员工名称索引供画布卡片与检查器复用。 */
  const employeeNames = useMemo(() => new Map(memberCatalog.map((employee) => [employee.id, employee.name])), [memberCatalog]);
  /** 共享图校验与已创建员工核对共同决定团队能否形成可运行定义。 */
  const validationIssues = useMemo(() => {
    /** 旧定义无法安全绘制时展示原校验，不让空画布冒充已经修好的团队。 */
    if (draft.sourceIssues?.length) return draft.sourceIssues;
    /** 结构问题先由 shared 权威校验器生成。 */
    /** 草稿与保存共用协议默认值，通用分工只需工作要求，研发验收按需配置。 */
    const effectiveDefinition = normalizeDigitalTeamWorkflowDefinition(draft.definition);
    const issues: DigitalTeamWorkflowValidationIssue[] = [
      ...validateDigitalTeamWorkflowDefinition(effectiveDefinition),
      ...(projectId ? validateDigitalTeamProjectWorkflowStatuses(effectiveDefinition, { hasStatus: (id) => projectStatuses.some((status) => status.id === id), isCompletedStatus: (id) => id === projectStatusRoles.completedStatusId }) : []),
    ];
    /** 新团队引用全局已创建员工；旧项目团队仍核对原项目员工实例。 */
    const employeeById = new Map(memberCatalog.map((employee) => [employee.id, employee]));
    for (const node of draft.definition.nodes) {
      if (node.type !== 'employee') continue;
      /** 未创建或已删除的员工不能继续作为新运行的成员定义。 */
      const employee = employeeById.get(node.data.employeeId);
      if (!employee)
        issues.push({
          code: node.data.employeeId === unassignedEmployeeId ? unassignedEmployeeIssueCode : 'ZEUS_DIGITAL_TEAM_EMPLOYEE_TEMPLATE_UNAVAILABLE',
          message: node.data.employeeId === unassignedEmployeeId ? '分工尚未选择执行员工。' : '执行员工已不可用，请重新选择。',
          nodeId: node.id,
        });
      else if ('enabled' in employee && !employee.enabled) issues.push({ code: 'ZEUS_DIGITAL_TEAM_EMPLOYEE_UNAVAILABLE', message: '员工节点绑定的项目数字员工已停用。', nodeId: node.id });
    }
    return issues;
  }, [draft.definition, draft.sourceIssues, memberCatalog, projectId, projectStatuses, projectStatusRoles]);
  /** 当前选中业务节点。 */
  const selectedNode = draft.definition.nodes.find((node) => node.id === selectedNodeId) ?? null;
  /** 当前运行冻结图兼容 Core 投影的两个稳定字段名。 */
  const selectedRunRecord = selectedRun?.run ?? null;
  /** 受阻原因只来自准确运行的当前尝试，不使用历史失败推测现状。 */
  const runBlocker = selectedRun ? getDigitalTeamRunBlocker(selectedRun, zh) : null;
  /** 运行失败直接显示原因，避免成功创建提示掩盖后续派发失败。 */
  const runError = view === 'runs' && !runBlocker && typeof selectedRunRecord?.error?.message === 'string' ? selectedRunRecord.error.message : null;
  /** 运行提示使用创建时冻结的实际员工工作方式。 */
  const runReadOnlyDescription = selectedRunRecord ? digitalTeamRunReadOnlyDescription(selectedRunRecord, zh) : null;
  /** 运行图严格使用创建时冻结的定义。 */
  const runDefinition = selectedRunRecord ? digitalTeamExecutionDefinition(selectedRunRecord) : null;
  /** 当前运行尝试按节点建立展示索引。 */
  const runStateByNodeId = useMemo(() => buildRunStateIndex(selectedRun?.currentAttempts ?? []), [selectedRun?.currentAttempts]);
  /** 历史运行使用创建时冻结的角色名称，不受当前员工改名或停用影响。 */
  const runEmployeeNames = useMemo(
    () => new Map((selectedRunRecord?.roleSnapshots ?? []).map((snapshot) => [snapshot.employeeId, typeof snapshot.configuration.name === 'string' ? snapshot.configuration.name : snapshot.employeeId])),
    [selectedRunRecord?.roleSnapshots],
  );
  /** 运行图当前选中节点。 */
  const selectedRunNode = runDefinition?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  /** 当前运行节点最新尝试。 */
  const selectedAttempt = selectedRunNode ? latestAttempt(selectedRun?.currentAttempts ?? [], selectedRunNode.id) : null;

  useEffect(() => {
    if (view === 'runs' && runBlocker) setSelectedNodeId((current) => current ?? runBlocker.nodeId);
  }, [runBlocker?.nodeId, view]);

  /** 并行读取全局模板和可选运行项目数据，编辑团队不依赖项目存在。 */
  const refreshProject = useCallback(
    async (preferredTemplateId?: string | null, preferredRunId?: string | null, entrySelection?: DigitalTeamEntrySelection): Promise<void> => {
      if (!api) return;
      runReadEpochRef.current += 1;
      /** 读取目录和切换项目不覆盖正在编辑的全局草稿。 */
      const currentDraft = draftStateRef.current;
      if (currentDraft.dirty) rememberDigitalTeamDraft(currentDraft.draft);
      const revision = ++loadRevisionRef.current;
      setLoading(true);
      setError(null);
      try {
        const [nextTemplates, nextEmployeeTemplates, nextRuns, runtimeSettings] = await Promise.all([
          api.loadDigitalTeamTemplates(),
          api.loadDigitalEmployeeTemplates(),
          projectId ? api.loadDigitalTeamRuns(projectId, props.task?.id) : Promise.resolve([]),
          api.loadAppShellSettings(),
        ]);
        if (!mountedRef.current || revision !== loadRevisionRef.current) return;
        setTemplates(nextTemplates);
        /** 状态目录和完成角色同时刷新，防止沿用另一个项目的完成身份。 */
        const statusConfig = normalizeTaskManagementStatusConfig(runtimeSettings.taskManagementStatusTemplate);
        setProjectStatuses(statusConfig.statuses);
        setProjectStatusRoles(statusConfig.roles);
        setEmployeeTemplates(nextEmployeeTemplates.filter((employee) => !employee.builtIn));
        /** 任务入口只展示当前任务运行；团队入口仍展示项目记录。 */
        const visibleRuns = props.task ? nextRuns.filter((run) => run.taskId === props.task!.id) : nextRuns;
        setRuns(visibleRuns);
        /** 明确入口优先；普通返回恢复最近编辑的团队。 */
        const desiredTemplateId = preferredTemplateId ?? currentDraft.draft.id ?? readDigitalTeamDraftSelection();
        const nextTemplate = nextTemplates.find((template) => template.id === desiredTemplateId) ?? nextTemplates[0];
        /** 保留开始编辑时的修订，服务端有并发修改时仍由保存门禁核对。 */
        const restoredDraft = currentDraft.dirty && (!preferredTemplateId || preferredTemplateId === currentDraft.draft.id) ? currentDraft.draft : readDigitalTeamDraft(nextTemplate?.id ?? null);
        /** 旧默认三人研发图直接补齐草稿职责，避免要求用户手动修正系统生成的只读配置。 */
        const loadedDraft = restoredDraft ?? (nextTemplate ? templateDraft(nextTemplate) : emptyTemplateDraft());
        /** 员工与完成角色都来自本次实际读取，不能沿用上一次刷新目录。 */
        const preparedDraft = prepareDevelopmentTemplateDraft(
          loadedDraft,
          nextEmployeeTemplates.filter((employee) => !employee.builtIn),
          statusConfig.roles.completedStatusId,
        );
        /** 默认补齐不冒充用户修改，也不把旧修订暂存成需要手动恢复的草稿。 */
        const nextDirty = Boolean(restoredDraft);
        draftStateRef.current = { draft: preparedDraft, dirty: nextDirty };
        setDraft(preparedDraft);
        setDraftOpen(Boolean(restoredDraft || nextTemplate));
        rememberDigitalTeamDraftSelection(restoredDraft?.id ?? nextTemplate?.id ?? null);
        setCanvasGeneration((current) => current + 1);
        setDirty(nextDirty);
        const nextRun = visibleRuns.find((run) => run.id === preferredRunId) ?? visibleRuns.find((run) => run.id === selectedRun?.run.id) ?? (props.task ? visibleRuns[0] : null);
        if (entrySelection?.kind === 'template' && nextTemplate?.id === entrySelection.templateId && nextTemplate.ready && !visibleRuns.some((run) => !terminalRunStatuses.has(run.status))) {
          setView('editor');
        } else if (entrySelection?.kind === 'run' && nextRun?.id === entrySelection.runId) setView('runs');
        else if (entrySelection?.kind === 'manage') setView('editor');
        /** 刷新选中运行时重新读取尝试历史，不能只替换运行标题行。 */
        const nextProjection = nextRun ? await api.loadDigitalTeamRun(nextRun.id) : null;
        if (!mountedRef.current || revision !== loadRevisionRef.current) return;
        setSelectedRun((current) => (nextProjection && current?.run.id === nextProjection.run.id && current.run.revision > nextProjection.run.revision ? current : nextProjection));
        setSelectedNodeId(null);
      } catch (cause) {
        if (revision === loadRevisionRef.current) setError(applicationError(cause, zh));
      } finally {
        if (revision === loadRevisionRef.current) setLoading(false);
      }
    },
    [api, projectId, selectedRun?.run.id, zh],
  );

  useEffect(() => {
    void refreshProject(props.initialSelection?.kind === 'template' ? props.initialSelection.templateId : undefined, props.initialSelection?.kind === 'run' ? props.initialSelection.runId : undefined, props.initialSelection);
    return () => {
      loadRevisionRef.current += 1;
    };
  }, [projectId]);

  useEffect(() => {
    if (!dirty) return;
    setDraftPersisted(rememberDigitalTeamDraft(draft));
  }, [draft, dirty]);

  useEffect(() => {
    /** 只有输入仍与此次提交完全一致的编辑器才接纳保存回执。 */
    const receiveSavedDraft = (event: Event): void => {
      /** 回执由实际 API 成功后发出，不从模板变更通知猜测提交内容。 */
      const detail = (event as CustomEvent<DraftSavedDetail>).detail;
      if (!detail) return;
      /** 最新引用覆盖快速离开并返回期间的输入。 */
      const current = draftStateRef.current;
      if (JSON.stringify(current.draft) !== JSON.stringify(detail.submittedDraft)) return;
      /** 先同步基线，再刷新目录，使此前读取代次失效。 */
      const savedDraft = templateDraft(detail.savedTemplate);
      draftStateRef.current = { draft: savedDraft, dirty: false };
      setDraft(savedDraft);
      setDirty(false);
      setError(null);
      setStatus(zh ? '团队已保存。' : 'Team saved.');
      /** 保存回执已包含准确记录，无需再读取旧列表覆盖随后的新运行。 */
      setTemplates((currentTemplates) => [detail.savedTemplate, ...currentTemplates.filter((template) => template.id !== detail.savedTemplate.id)]);
      rememberDigitalTeamDraftSelection(detail.savedTemplate.id);
    };
    window.addEventListener(draftSavedEvent, receiveSavedDraft);
    return () => window.removeEventListener(draftSavedEvent, receiveSavedDraft);
  }, [zh]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      /** 卸载前同步暂存，导航不依赖异步保存或 effect 执行时机。 */
      const current = draftStateRef.current;
      if (current.dirty) rememberDigitalTeamDraft(current.draft);
    };
  }, []);

  useEffect(() => {
    /** 窗口真正卸载前写入最新输入，存储失败时才使用标准关闭保护。 */
    const preventUnload = (event: BeforeUnloadEvent): void => {
      /** 关闭保护只判断尚未持久暂存的真实编辑。 */
      const current = draftStateRef.current;
      if (current.dirty && !rememberDigitalTeamDraft(current.draft)) event.preventDefault();
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, []);

  useEffect(() => {
    /** 草稿已经持久暂存时不再让窗口关闭依赖服务端流程保存。 */
    window.zeus?.setUnsavedChangeState?.('digital-team-template', dirty && !draftPersisted);
    return () => window.zeus?.setUnsavedChangeState?.('digital-team-template', false);
  }, [dirty, draftPersisted]);

  useEffect(() => {
    setReconciliationError(null);
    if (!api || !projectId) return;
    /** 当前项目与任务共同限定只读对账范围，旧项目运行不参与新项目刷新。 */
    const taskId = props.task?.id;
    /** 当前选中运行必须属于本轮项目与任务。 */
    const runId = selectedRun?.run.projectId === projectId && (!taskId || selectedRun.run.taskId === taskId) ? selectedRun.run.id : null;
    /** 多个状态事件在一个短窗口内共用一次读取。 */
    let refreshTimer: number | null = null;
    /** 切换项目、运行或卸载后，旧回执不再进入页面。 */
    let active = true;
    /** 对账去重，慢读取期间的新事件只补排一次后续读取。 */
    let reading = false;
    /** 标记读取期间发生的真实状态通知，不能把旧读取当作该通知后的结果。 */
    let refreshAgain = false;
    /** 当前项目列表与准确运行并行只读核对，不触发保存或派发。 */
    const refreshCurrentRun = async (): Promise<void> => {
      if (!active) return;
      if (reading) {
        refreshAgain = true;
        return;
      }
      reading = true;
      /** 本轮读取以开始时的用户操作代次为准，保存与切换之后的旧结果会被忽略。 */
      const readEpoch = runReadEpochRef.current;
      try {
        /** 两个读取互不依赖，避免列表延迟阻塞选中运行的获取。 */
        const [nextRuns, nextProjection] = await Promise.all([api.loadDigitalTeamRuns(projectId, taskId), runId ? api.loadDigitalTeamRun(runId) : Promise.resolve(null)]);
        if (!active || readEpoch !== runReadEpochRef.current) return;
        setReconciliationError(null);
        setRuns((current) => {
          /** 当前列表以修订号保护已接纳的更新，旧网络回执不能将状态倒退。 */
          const currentById = new Map(current.map((run) => [run.id, run]));
          return nextRuns
            .filter((run) => run.projectId === projectId && (!taskId || run.taskId === taskId))
            .map((run) => {
              /** 并行详情可能先读到更新修订，列表行同时采用同一准确运行事实。 */
              const latestRead = nextProjection?.run.id === run.id && nextProjection.run.projectId === projectId && nextProjection.run.revision > run.revision ? nextProjection.run : run;
              /** 同一运行只接纳不早于页面当前事实的投影。 */
              const previous = currentById.get(run.id);
              return previous && previous.revision > latestRead.revision ? previous : latestRead;
            });
        });
        if (nextProjection && nextProjection.run.id === runId && nextProjection.run.projectId === projectId && (!taskId || nextProjection.run.taskId === taskId)) {
          setSelectedRun((current) => (current?.run.id === runId && current.run.revision <= nextProjection.run.revision ? nextProjection : current));
        }
      } catch (cause) {
        if (active && readEpoch === runReadEpochRef.current) setReconciliationError(applicationError(cause, zh));
      } finally {
        reading = false;
        if (active && refreshAgain) {
          refreshAgain = false;
          scheduleRefresh(0);
        }
      }
    };
    /** 事件与连接恢复共用延迟队列，页面切换时统一清理。 */
    const scheduleRefresh = (delayMs = 180): void => {
      if (!active) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshCurrentRun();
      }, delayMs);
    };
    /** 同一订阅同时接收真实团队事件和连接恢复通知。 */
    const unsubscribe = api.subscribeEvents(
      (event) => {
        if (!event.type.includes('digital_team')) return;
        if (typeof event.payload.projectId === 'string' && event.payload.projectId !== projectId) return;
        scheduleRefresh();
      },
      (connectionState) => {
        if (connectionState === 'connected') scheduleRefresh(0);
      },
    );
    /** 活动运行无需依赖事件完整送达；已结束运行停止周期请求。 */
    const reconciliationTimer = window.setInterval(() => {
      /** 当前活动运行必须仍属于本轮项目和任务。 */
      const hasActiveRun = runsRef.current.some((run) => run.projectId === projectId && (!taskId || run.taskId === taskId) && !terminalRunStatuses.has(run.status));
      /** 精确选中运行可能先于列表接纳，仍按它的真实状态对账。 */
      const currentRun = selectedRunRef.current?.run;
      if (hasActiveRun || (currentRun?.id === runId && !terminalRunStatuses.has(currentRun.status))) void refreshCurrentRun();
    }, runReconciliationIntervalMs);
    void refreshCurrentRun();
    return () => {
      active = false;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.clearInterval(reconciliationTimer);
      unsubscribe();
    };
  }, [api, projectId, props.task?.id, selectedRun?.run.id, view, zh]);

  /** 所有画布与表单修改共用脏状态。 */
  const changeDefinition = useCallback((definition: DigitalTeamWorkflowDefinition | ((current: DigitalTeamWorkflowDefinition) => DigitalTeamWorkflowDefinition)): void => {
    /** 同一手势中的节点和视口回调都基于最新草稿合并。 */
    const current = draftStateRef.current;
    /** 编辑保留输入原值，保存边界再做归一化。 */
    const nextDefinition = typeof definition === 'function' ? definition(current.draft.definition) : definition;
    if (JSON.stringify(nextDefinition) === JSON.stringify(current.draft.definition)) return;
    /** 浏览视口和初始化测量不代表用户修改了分工或依赖。 */
    const nextDirty = current.dirty || JSON.stringify({ ...current.draft.definition, viewport: nextDefinition.viewport }) !== JSON.stringify(nextDefinition);
    /** 更新引用后再提交状态，避免连续画布事件读取上一次坐标。 */
    const nextDraft = { ...current.draft, definition: nextDefinition };
    draftStateRef.current = { draft: nextDraft, dirty: nextDirty };
    setDraft(nextDraft);
    setDirty(nextDirty);
    setStatus('');
  }, []);

  /** 添加节点后立即选中，检查器可以继续完成配置。 */
  const addNode = useCallback(
    (payload: DigitalTeamDragPayload, position?: { x: number; y: number }): void => {
      const resolvedPosition = position ?? nextNodePosition(draft.definition.nodes.length);
      const employee = memberCatalog.find((candidate) => candidate.id === payload.employeeId);
      const node = buildNode(payload, resolvedPosition, employee, projectStatusRoles.completedStatusId);
      changeDefinition((definition) => {
        /** 新增标准开发是明确编辑动作，只在修复配置完全缺省时预选唯一实际开发身份。 */
        const nextDefinition = { ...definition, nodes: [...definition.nodes, node] };
        return employee?.role.trim() === '开发' && definition.repairEmployeeId === undefined && definition.maxRepairRounds === undefined ? withDigitalTeamDefaultRepairEmployee(nextDefinition, memberCatalog) : nextDefinition;
      });
      setSelectedNodeId(node.id);
    },
    [changeDefinition, draft.definition, memberCatalog, projectStatusRoles.completedStatusId],
  );

  /** 切换团队同步暂存当前修改，回到该团队时继续原草稿。 */
  const selectTemplate = (templateId: string): void => {
    if (dirty) rememberDigitalTeamDraft(draft);
    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template) return;
    /** 每个团队恢复各自的编辑内容。 */
    const cached = readDigitalTeamDraft(template.id);
    /** 只补齐旧默认值，显式只读要求及本地编辑不被覆盖。 */
    const loadedDraft = cached ?? templateDraft(template);
    /** 岗位与任务完成角色来自当前已读取目录。 */
    const preparedDraft = prepareDevelopmentTemplateDraft(loadedDraft, memberCatalog, projectStatusRoles.completedStatusId);
    /** 切换后同步引用，后续画布回调不能重新带回旧团队。 */
    const nextDirty = Boolean(cached);
    draftStateRef.current = { draft: preparedDraft, dirty: nextDirty };
    setDraft(preparedDraft);
    setDirty(nextDirty);
    rememberDigitalTeamDraftSelection(template.id);
    setDraftOpen(true);
    setCanvasGeneration((current) => current + 1);
    setSelectedNodeId(null);
    setError(null);
  };

  /** 新团队从空白草稿开始，员工、分工和依赖均由用户明确配置。 */
  const startNewTemplate = (): void => {
    if (dirty) rememberDigitalTeamDraft(draft);
    /** 新团队的旧草稿也能继续填写，不丢弃前一次创建内容。 */
    const cached = readDigitalTeamDraft(null);
    setDraft(cached ?? emptyTemplateDraft());
    setDraftOpen(true);
    setCanvasGeneration((current) => current + 1);
    setSelectedNodeId(null);
    setDirty(Boolean(cached));
    rememberDigitalTeamDraftSelection(null);
    setError(null);
  };

  /** 保存和开始协作共用同一提交边界，以实际保存修订创建运行。 */
  const persistTemplateDraft = async (submittedDraft: TemplateDraft): Promise<DigitalTeamWorkflowTemplateRecord> => {
    if (!api) throw new Error(zh ? '数字团队接口尚未就绪。' : 'The digital team API is not ready.');
    /** 编辑期间保留原输入，正式提交只清除完成标准和产物列表中的空行。 */
    const saved = await api.saveDigitalTeamTemplate({
      ...(submittedDraft.id ? { id: submittedDraft.id } : {}),
      expectedRevision: submittedDraft.revision,
      name: submittedDraft.name.trim(),
      description: submittedDraft.description.trim(),
      definition: {
        ...submittedDraft.definition,
        nodes: submittedDraft.definition.nodes.map((node) =>
          node.type === 'employee'
            ? {
                ...node,
                data: {
                  ...node.data,
                  acceptanceCriteria: (node.data.acceptanceCriteria ?? []).map((item) => item.trim()).filter(Boolean),
                  expectedDeliverables: (node.data.expectedDeliverables ?? []).map((item) => item.trim()).filter(Boolean),
                },
              }
            : node,
        ),
      },
    });
    forgetDigitalTeamDraft(submittedDraft.id, submittedDraft);
    window.dispatchEvent(new CustomEvent<DraftSavedDetail>(draftSavedEvent, { detail: { submittedDraft, savedTemplate: saved } }));
    return saved;
  };

  /** 显式保存模板并以服务端回执作为新基线。 */
  const saveTemplate = async (): Promise<void> => {
    if (!api || !draft.name.trim() || draft.sourceIssues?.length) return;
    /** 提交快照独立于返回页面后可能继续输入的草稿。 */
    const submittedDraft = structuredClone(draft);
    setBusy(true);
    setError(null);
    try {
      await persistTemplateDraft(submittedDraft);
    } catch (cause) {
      if (mountedRef.current) setError(applicationError(cause, zh));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  /** 复制立即创建新模板，避免复制操作只停留在临时画布。 */
  const copyTemplate = async (): Promise<void> => {
    if (!api || !selectedTemplate || dirty) return;
    setBusy(true);
    setError(null);
    try {
      const copy = await api.saveDigitalTeamTemplate({
        expectedRevision: null,
        name: `${selectedTemplate.name}${zh ? ' 副本' : ' copy'}`,
        description: selectedTemplate.description,
        definition: selectedTemplate.definition,
      });
      await refreshProject(copy.id);
      setStatus(zh ? '模板副本已创建。' : 'Template copy created.');
    } catch (cause) {
      setError(applicationError(cause, zh));
    } finally {
      setBusy(false);
    }
  };

  /** 删除只在服务端确认后移除当前模板。 */
  const deleteTemplate = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!api || !pendingDelete) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteDigitalTeamTemplate(pendingDelete.id, pendingDelete.revision);
      forgetDigitalTeamDraft(pendingDelete.id);
      setPendingDelete(null);
      await refreshProject();
      setStatus(zh ? '团队已删除。' : 'Team deleted.');
    } catch (cause) {
      setError(applicationError(cause, zh));
    } finally {
      setBusy(false);
    }
  };

  /** 重开恢复最近一次服务端保存的完整画布与视口。 */
  const reopenTemplate = (): void => {
    forgetDigitalTeamDraft(draft.id);
    if (!selectedTemplate) {
      setDraft(emptyTemplateDraft());
      setDraftOpen(false);
      setDirty(false);
    } else {
      /** 恢复服务端输入后仍补旧系统默认值，自定义改动可以正常放弃。 */
      const savedDraft = templateDraft(selectedTemplate);
      /** 补齐默认研发职责不会形成自动运行。 */
      const preparedDraft = prepareDevelopmentTemplateDraft(savedDraft, memberCatalog, projectStatusRoles.completedStatusId);
      draftStateRef.current = { draft: preparedDraft, dirty: false };
      setDraft(preparedDraft);
      setDirty(false);
    }
    setSelectedNodeId(null);
    setCanvasGeneration((current) => current + 1);
    setError(null);
    setStatus(zh ? '已恢复最近保存版本。' : 'The last saved version was restored.');
  };

  /** 开始研发就是本任务的明确开发动作；先保存草稿，再冻结真实回执修订。 */
  const createRun = async (): Promise<void> => {
    if (!api || !props.task || !projectId || !draft.name.trim() || loading || busy || validationIssues.length > 0 || runs.some((run) => !terminalRunStatuses.has(run.status))) return;
    /** 用户点击时的分工和执行范围固定，不受保存期间继续输入的影响。 */
    const submittedDraft = structuredClone(draft);
    setBusy(true);
    runReadEpochRef.current += 1;
    setError(null);
    try {
      /** 保存失败或修订冲突直接停止，不能使用旧只读模板启动另一轮。 */
      const savedTemplate = templateNeedsSave ? await persistTemplateDraft(submittedDraft) : selectedTemplate!;
      const projection = await api.createDigitalTeamRun(projectId, {
        taskId: props.task.id,
        expectedTaskUpdatedAt: props.task.updatedAt,
        templateId: savedTemplate.id,
        templateRevision: savedTemplate.revision,
        title: props.task.title,
        description: props.task.description ?? '',
        /** 只有实际点击开始研发才授权三项本地动作；读取目录和补默认值不能授权。 */
        ...(usesCode ? { grantTaskCodeAuthority: true } : {}),
        taskFacts: {
          title: props.task.title,
          description: props.task.description ?? '',
          source: 'digital_team',
          confirmCommittedBaseline: usesCode,
          allowCodeChanges: usesCode,
          allowTests: usesCode,
          allowGitCommit: usesCode,
        },
      });
      if (!mountedRef.current) return;
      setRuns((current) => [projection.run, ...current.filter((item) => item.id !== projection.run.id)]);
      setSelectedRun(projection);
      setSelectedNodeId(null);
      setView('runs');
      setStatus(zh ? '团队已开始协作，本次分工与任务范围已保存。' : 'Team work started with the current assignments and task scope saved.');
    } catch (cause) {
      if (mountedRef.current) setError(applicationError(cause, zh));
    } finally {
      runReadEpochRef.current += 1;
      if (mountedRef.current) setBusy(false);
    }
  };

  /** 全局创建任务同样先保存当前分工，实际运行由任务创建入口的明确提交发起。 */
  const createTaskWithTeam = async (): Promise<void> => {
    if (!api || !props.onCreateTask || !projectId || !draft.name.trim() || loading || busy || validationIssues.length > 0) return;
    /** 创建入口使用点击时的准确草稿，不要求先做另一次保存。 */
    const submittedDraft = structuredClone(draft);
    setBusy(true);
    setError(null);
    try {
      /** 只有真实保存成功的修订才能进入后续任务创建。 */
      const saved = templateNeedsSave ? await persistTemplateDraft(submittedDraft) : selectedTemplate!;
      props.onCreateTask(saved.id, projectId);
    } catch (cause) {
      if (mountedRef.current) setError(applicationError(cause, zh));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  /** 加载运行完整投影，运行图始终保持只读。 */
  const selectRun = async (runId: string): Promise<void> => {
    if (!api) return;
    /** 后一次运行选择与项目刷新使先前读取回执失效。 */
    const revision = ++loadRevisionRef.current;
    runReadEpochRef.current += 1;
    setLoading(true);
    setError(null);
    try {
      /** 只打开当前项目和任务真实所属的准确运行。 */
      const projection = await api.loadDigitalTeamRun(runId);
      if (!mountedRef.current || revision !== loadRevisionRef.current || projection.run.projectId !== projectId || (props.task && projection.run.taskId !== props.task.id)) return;
      setSelectedRun((current) => (current?.run.id === projection.run.id && current.run.revision > projection.run.revision ? current : projection));
      setSelectedNodeId(getDigitalTeamRunBlocker(projection, zh)?.nodeId ?? null);
    } catch (cause) {
      if (mountedRef.current && revision === loadRevisionRef.current) setError(applicationError(cause, zh));
    } finally {
      if (mountedRef.current && revision === loadRevisionRef.current) setLoading(false);
    }
  };

  /** 暂停或继续只控制后续派发，不伪装在途工作已经停止。 */
  const controlRun = async (): Promise<void> => {
    if (!api || !selectedRunRecord) return;
    setBusy(true);
    runReadEpochRef.current += 1;
    setError(null);
    try {
      const state = selectedRunRecord.controlState === 'paused' ? 'running' : 'paused';
      const projection = await api.controlDigitalTeamRun(selectedRunRecord.id, { state, expectedRevision: selectedRunRecord.revision });
      setSelectedRun(projection);
      setRuns((current) => current.map((item) => (item.id === projection.run.id ? projection.run : item)));
      setStatus(state === 'paused' ? (zh ? '已停止新节点派发，正在核对在途工作。' : 'New dispatch is paused while in-flight work is checked.') : zh ? '已继续后续派发。' : 'Dispatch resumed.');
    } catch (cause) {
      setError(applicationError(cause, zh));
    } finally {
      runReadEpochRef.current += 1;
      setBusy(false);
    }
  };

  /** 提交人工批准、退回或返工，并使用当前尝试/运行修订。 */
  const submitRunDecision = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!api || !selectedRunRecord || !runDecision) return;
    setBusy(true);
    runReadEpochRef.current += 1;
    setError(null);
    try {
      const projection =
        runDecision.kind === 'rework'
          ? await api.requestDigitalTeamRework(selectedRunRecord.id, runDecision.nodeId, { reason: decisionReason.trim(), expectedRevision: selectedRunRecord.revision })
          : await api.decideDigitalTeamApproval(selectedRunRecord.id, runDecision.nodeId, runDecision.attempt, {
              approved: runDecision.kind === 'approve',
              reason: decisionReason.trim(),
              expectedRevision: selectedRunRecord.revision,
            });
      setSelectedRun(projection);
      setRuns((current) => current.map((item) => (item.id === projection.run.id ? projection.run : item)));
      setRunDecision(null);
      setDecisionReason('');
      setStatus(zh ? '人工决定已记录，后续推进以 Core 回执为准。' : 'Decision recorded; subsequent progress follows the Core projection.');
    } catch (cause) {
      setError(applicationError(cause, zh));
    } finally {
      runReadEpochRef.current += 1;
      setBusy(false);
    }
  };

  /** 当前检查器在编辑图和运行图之间复用业务节点。 */
  const inspector =
    view === 'editor' ? (
      <NodeInspector
        key={selectedNodeId}
        node={selectedNode}
        definition={draft.definition}
        employees={memberCatalog}
        employeeNames={employeeNames}
        statuses={projectStatuses}
        language={props.language}
        issues={validationIssues.filter((issue) => issue.nodeId === selectedNode?.id)}
        onChange={(node) => replaceNode(draft.definition, node, changeDefinition)}
        onConnect={(source, target) => changeDefinition({ ...draft.definition, edges: [...draft.definition.edges, { id: `edge_${crypto.randomUUID()}`, source, target }] })}
        onDisconnect={(edgeId) => changeDefinition({ ...draft.definition, edges: draft.definition.edges.filter((edge) => edge.id !== edgeId) })}
        onDelete={(nodeId) => removeNode(draft.definition, nodeId, changeDefinition, setSelectedNodeId)}
      />
    ) : (
      <RunInspector
        run={selectedRunRecord}
        node={selectedRunNode}
        attempt={selectedAttempt}
        attempts={selectedRun?.currentAttempts ?? []}
        history={selectedRun?.nodeAttempts ?? []}
        onOpenConversation={props.onOpenConversation ? (conversationId) => props.onOpenConversation!(selectedRunRecord!.projectId, conversationId) : undefined}
        onApprove={(kind) => openRunDecision(kind, selectedRunNode, selectedAttempt, setRunDecision, setDecisionReason)}
        onRework={() => openRunDecision('rework', selectedRunNode, selectedAttempt, setRunDecision, setDecisionReason)}
      />
    );

  return (
    <section className="digital-team-workspace" aria-labelledby="digital-team-title" data-compact-inspector={compactInspector ? 'true' : undefined} data-inspector-open={selectedNodeId ? 'true' : undefined}>
      <header className="digital-team-header">
        <div>
          {props.task ? (
            <p>
              {props.task.taskCode} · {props.task.title}
            </p>
          ) : null}
          <h1 id="digital-team-title">{zh ? '数字团队' : 'Digital teams'}</h1>
          {!props.task ? <p>{zh ? '安排员工分工和先后顺序，用团队流程创建任务。' : 'Arrange responsibilities and work order, then create a task with the team.'}</p> : null}
        </div>
        <div className="digital-team-header-actions">
          {props.onBackToTask ? (
            <Button size="compact" disabled={busy} onClick={props.onBackToTask}>
              返回任务
            </Button>
          ) : null}
          <div className="digital-team-view-switch" aria-label={zh ? '数字团队视图' : 'Digital team view'}>
            <button type="button" aria-pressed={view === 'editor'} onClick={() => setView('editor')}>
              {zh ? '团队流程' : 'Workflow'}
            </button>
            <button type="button" aria-pressed={view === 'runs'} onClick={() => setView('runs')}>
              {zh ? '执行记录' : 'Runs'}
            </button>
          </div>
          <ZeusSelect
            ariaLabel={zh ? '任务运行项目' : 'Task project'}
            disabled={Boolean(props.task) || busy || loading}
            value={projectId || noProjectValue}
            options={[
              ...(view === 'editor' ? [{ value: noProjectValue, label: zh ? '选择任务运行项目' : 'Choose a task project' }] : []),
              ...props.projects.map((project) => ({ value: project.id, label: project.name, searchText: project.localPath })),
            ]}
            onChange={(value) => setProjectId(value === noProjectValue ? '' : value)}
            size="regular"
            searchable
          />
          <Button className="digital-team-refresh-button" size="compact" aria-label={zh ? '刷新数字团队数据' : 'Refresh digital team data'} title={zh ? '刷新' : 'Refresh'} disabled={loading || busy} onClick={() => void refreshProject()}>
            <Refresh aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className="digital-team-messages">
        {error || reconciliationError || runError ? (
          <p className="digital-team-message is-error" role="alert">
            {error || reconciliationError || runError}
          </p>
        ) : null}
        {view === 'runs' && runBlocker ? (
          <div className="digital-team-message is-error" role="alert">
            <strong>{runBlocker.nodeName}</strong>
            <span> · {runBlocker.reason} </span>
            <Button size="compact" onClick={() => setSelectedNodeId(runBlocker.nodeId)}>
              {zh ? '查看受阻分工' : 'View blocked step'}
            </Button>
          </div>
        ) : null}
        {view === 'runs' && runReadOnlyDescription ? <p className="digital-team-message">{runReadOnlyDescription}</p> : null}
        {view === 'editor' && props.task && draftOpen && !loading && analysisOnly ? (
          <p className="digital-team-message">
            {zh ? '当前团队只做只读分析，不会修改代码。需要开发时，请明确调整开发分工的工作方式。' : 'This team only analyzes and does not modify code. To develop, explicitly change the development step’s work mode.'}
          </p>
        ) : null}
        <p className="digital-team-message" role="status" aria-live="polite">
          {loading
            ? zh
              ? '正在读取团队与执行记录…'
              : 'Loading teams and runs…'
            : runError || (view === 'runs' && runBlocker)
              ? ''
              : status ||
                (dirty
                  ? draftPersisted
                    ? zh
                      ? '修改已暂存，可随时切换页面。保存后用于任务。'
                      : 'Draft kept locally. Save it to use it in tasks.'
                    : zh
                      ? '无法持久暂存，请保存流程；当前窗口仍保留修改。'
                      : 'The draft could not be persisted. Save the workflow; this window still retains your changes.'
                  : '')}
        </p>
      </div>
      {view === 'editor' && loading ? (
        <div className="digital-team-page-loading" role="status">
          {zh ? '正在读取数字团队…' : 'Loading digital teams…'}
        </div>
      ) : view === 'editor' && !draftOpen ? (
        <div className="digital-team-empty">
          <h2>{zh ? '还没有数字团队' : 'No digital teams yet'}</h2>
          <p>{zh ? '创建团队后，再添加数字员工并配置分工与依赖关系。' : 'Create a team, then add digital employees and configure responsibilities and dependencies.'}</p>
          <Button variant="primary" size="regular" disabled={!api || busy} onClick={startNewTemplate}>
            <Plus aria-hidden="true" />
            {zh ? '创建团队' : 'Create team'}
          </Button>
        </div>
      ) : view === 'editor' ? (
        <div className="digital-team-editor-layout" inert={busy || loading}>
          <main className="digital-team-canvas-column">
            <div className="digital-team-template-browser">
              <ZeusSelect
                ariaLabel={zh ? '选择团队' : 'Choose team'}
                value={draft.id ?? '__new_template__'}
                options={[
                  ...(draft.id ? [] : [{ value: '__new_template__', label: zh ? '未保存的新团队' : 'Unsaved team' }]),
                  ...templates.map((template) => ({
                    value: template.id,
                    label: template.name,
                  })),
                ]}
                onChange={selectTemplate}
                size="regular"
                searchable
              />
              <div className="digital-team-template-actions">
                <Button size="compact" onClick={startNewTemplate}>
                  <Plus aria-hidden="true" />
                  {zh ? '新建团队' : 'New team'}
                </Button>
              </div>
            </div>
            {draft.sourceIssues?.length ? (
              <div className="digital-team-message is-error" role="alert">
                <span>{zh ? '这份旧草稿的结构不完整，原内容已保留。重新配置成员后可以保存。' : 'This draft has an incomplete structure. Its original content is preserved until you rebuild and save it.'}</span>
                <Button
                  size="compact"
                  disabled={busy || loading}
                  onClick={() => {
                    /** 只有明确重新配置才允许将安全视图保存为新的团队定义。 */
                    setDraft((current) => ({ ...current, sourceIssues: undefined }));
                    setDirty(true);
                  }}
                >
                  {zh ? '重新配置成员' : 'Rebuild members'}
                </Button>
              </div>
            ) : null}
            <div className="digital-team-template-toolbar">
              <label>
                <span>{zh ? '团队名称' : 'Team name'}</span>
                <input
                  value={draft.name}
                  maxLength={120}
                  onChange={(event) => {
                    /** 先读取输入，避免延迟更新时事件目标已失效。 */
                    const name = event.currentTarget.value;
                    setDraft((current) => ({ ...current, name }));
                    setDirty(true);
                  }}
                />
              </label>
              <details className="digital-team-settings">
                <summary>{zh ? '团队设置' : 'Team settings'}</summary>
                <div className="digital-team-settings-content">
                  <label>
                    <span>{zh ? '团队说明' : 'Description'}</span>
                    <input
                      value={draft.description}
                      maxLength={500}
                      onChange={(event) => {
                        /** 说明与名称共用安全的值更新方式。 */
                        const description = event.currentTarget.value;
                        setDraft((current) => ({ ...current, description }));
                        setDirty(true);
                      }}
                    />
                  </label>
                  <details className="digital-team-advanced-settings">
                    <summary>{zh ? '研发流程设置（可选）' : 'Development workflow (optional)'}</summary>
                    <label>
                      <span>{zh ? '缺陷修复员工' : 'Defect repair employee'}</span>
                      <ZeusSelect
                        size="regular"
                        ariaLabel="选择缺陷修复员工"
                        value={draft.definition.repairEmployeeId ?? ''}
                        options={[{ value: '', label: '未配置，发现正式缺陷时等待安排' }, ...memberCatalog.map((employee) => ({ value: employee.id, label: employee.name }))]}
                        onChange={(repairEmployeeId) => changeDefinition({ ...draft.definition, repairEmployeeId: repairEmployeeId || undefined })}
                      />
                    </label>
                    <label>
                      <span>{zh ? '最多自动修复轮次' : 'Maximum repair rounds'}</span>
                      <input
                        type="number"
                        min={0}
                        max={20}
                        value={draft.definition.maxRepairRounds ?? 3}
                        onChange={(event) => {
                          /** 仅提交整数，空输入保持既有轮数。 */ const maxRepairRounds = Number(event.currentTarget.value);
                          if (Number.isInteger(maxRepairRounds) && maxRepairRounds >= 0 && maxRepairRounds <= 20) changeDefinition({ ...draft.definition, maxRepairRounds });
                        }}
                      />
                    </label>
                  </details>
                  <div className="digital-team-template-actions">
                    <Button size="compact" onClick={() => void copyTemplate()} disabled={!selectedTemplate || dirty || busy}>
                      <Copy aria-hidden="true" />
                      {zh ? '复制团队' : 'Copy team'}
                    </Button>
                    <Button variant="danger" size="compact" onClick={() => selectedTemplate && setPendingDelete(selectedTemplate)} disabled={!selectedTemplate || dirty || busy}>
                      <Trash aria-hidden="true" />
                      {zh ? '删除团队' : 'Delete team'}
                    </Button>
                  </div>
                </div>
              </details>
              <div className="digital-team-save-actions">
                <div className="digital-team-member-picker-anchor">
                  <Button size="compact" onClick={() => setMemberPickerOpen((open) => !open)} aria-expanded={memberPickerOpen} disabled={Boolean(draft.sourceIssues?.length)}>
                    <Plus aria-hidden="true" />
                    {zh ? '添加成员' : 'Add member'}
                  </Button>
                  {memberPickerOpen ? (
                    <div className="digital-team-member-picker" role="dialog" aria-label={zh ? '添加数字员工' : 'Add digital employee'}>
                      <RolePalette
                        employees={memberCatalog}
                        onAdd={(payload) => {
                          addNode(payload);
                          setMemberPickerOpen(false);
                        }}
                      />
                    </div>
                  ) : null}
                </div>
                <Button size="compact" variant="primary" busy={busy} disabled={!draft.name.trim() || Boolean(draft.sourceIssues?.length) || !templateNeedsSave} onClick={() => void saveTemplate()}>
                  {zh ? '保存' : 'Save'}
                </Button>
                {dirty ? (
                  <Button size="compact" onClick={reopenTemplate} disabled={busy}>
                    {zh ? '放弃修改' : 'Discard changes'}
                  </Button>
                ) : null}
                <Button
                  size="compact"
                  variant="primary"
                  disabled={!draft.name.trim() || validationIssues.length > 0 || loading || busy || (props.task ? runs.some((run) => !terminalRunStatuses.has(run.status)) : !props.onCreateTask || !projectId)}
                  onClick={() => {
                    if (props.task) void createRun();
                    else void createTaskWithTeam();
                  }}
                >
                  <Play aria-hidden="true" />
                  {props.task ? (usesCode ? (zh ? '开始研发' : 'Start development') : zh ? '开始协作' : 'Start work') : zh ? '用此团队创建任务' : 'Create task with this team'}
                </Button>
              </div>
            </div>
            {props.task && usesCode ? (
              <p className="digital-team-start-description">
                {zh
                  ? '点击开始研发，将按流程自动接续，在隔离工作区修改代码、运行检查并本地提交。从当前已提交版本开始，未提交修改不带入。'
                  : 'Start development to follow the workflow automatically, edit code, run checks, and commit locally in isolated workspaces. Start from the committed revision, excluding uncommitted changes.'}
              </p>
            ) : null}
            <WorkflowCanvas
              key={`editor-${canvasGeneration}`}
              definition={draft.definition}
              readOnly={Boolean(draft.sourceIssues?.length)}
              employeeNames={employeeNames}
              selectedNodeId={selectedNodeId}
              issues={validationIssues.filter((issue) => issue.code !== unassignedEmployeeIssueCode)}
              onChange={changeDefinition}
              onSelectNode={setSelectedNodeId}
              onAdd={addNode}
            />
            <ValidationPanel issues={validationIssues} onSelectNode={setSelectedNodeId} />
          </main>
          {selectedNodeId ? (
            <aside className="digital-team-inspector">
              {compactInspector ? (
                <Button size="compact" onClick={() => setSelectedNodeId(null)}>
                  关闭节点配置
                </Button>
              ) : null}
              {inspector}
            </aside>
          ) : null}
        </div>
      ) : (
        <div className="digital-team-run-layout">
          <aside className="digital-team-run-list" aria-label={zh ? '运行记录' : 'Run history'}>
            <div className="digital-team-section-heading">
              <h2>{zh ? '运行记录' : 'Runs'}</h2>
              <span>{runs.length}</span>
            </div>
            {runs.length === 0 ? (
              <p>{zh ? '尚未创建运行。' : 'No runs yet.'}</p>
            ) : (
              runs.map((run) => (
                <button key={run.id} type="button" className={run.id === selectedRunRecord?.id ? 'is-active' : ''} aria-current={run.id === selectedRunRecord?.id ? 'true' : undefined} onClick={() => void selectRun(run.id)}>
                  <strong>{runTitle(run)}</strong>
                  <small>{digitalTeamRunStatusLabel(run, zh)}</small>
                </button>
              ))
            )}
          </aside>
          <main className="digital-team-canvas-column">
            <div className="digital-team-run-toolbar">
              <div>
                <strong>{selectedRunRecord ? runTitle(selectedRunRecord) : zh ? '选择一个运行' : 'Choose a run'}</strong>
                {selectedRunRecord ? (
                  <span>
                    {digitalTeamRunStatusLabel(selectedRunRecord, zh)}
                    {!terminalRunStatuses.has(selectedRunRecord.status) ? ` · ${selectedRunRecord.controlState === 'paused' ? (zh ? '已暂停派发' : 'Dispatch paused') : zh ? '允许派发' : 'Dispatch enabled'}` : ''}
                  </span>
                ) : null}
              </div>
              {selectedRunRecord && !terminalRunStatuses.has(selectedRunRecord.status) ? (
                <Button size="compact" busy={busy} onClick={() => void controlRun()}>
                  {selectedRunRecord.controlState === 'paused' ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
                  {selectedRunRecord.controlState === 'paused' ? (zh ? '继续' : 'Resume') : zh ? '暂停' : 'Pause'}
                </Button>
              ) : null}
            </div>
            {selectedRunRecord && runDefinition ? (
              <WorkflowCanvas
                key={selectedRunRecord.id}
                definition={runDefinition}
                employeeNames={runEmployeeNames}
                selectedNodeId={selectedNodeId}
                issues={[]}
                runtimeStateByNodeId={runStateByNodeId}
                readOnly
                onChange={() => undefined}
                onSelectNode={setSelectedNodeId}
                onAdd={() => undefined}
              />
            ) : (
              <div className="digital-team-run-empty" role="status">
                {zh ? '从左侧选择运行，查看冻结流程和真实节点状态。' : 'Select a run to view its frozen workflow and node states.'}
              </div>
            )}
          </main>
          {selectedNodeId ? (
            <aside className="digital-team-inspector">
              {compactInspector ? (
                <Button size="compact" onClick={() => setSelectedNodeId(null)}>
                  关闭节点配置
                </Button>
              ) : null}
              {inspector}
            </aside>
          ) : null}
        </div>
      )}

      <MotionPresence>
        {pendingDelete ? (
          <FormDialog
            title={zh ? '删除团队' : 'Delete team'}
            description={zh ? `将删除“${pendingDelete.name}”。已有运行快照不会改变。` : `Delete “${pendingDelete.name}”. Existing run snapshots will not change.`}
            zh={zh}
            busy={busy}
            submitLabel={zh ? '确认删除' : 'Delete'}
            danger
            onClose={() => setPendingDelete(null)}
            onSubmit={(event) => void deleteTemplate(event)}
          />
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {runDecision ? (
          <FormDialog
            title={decisionTitle(runDecision.kind, zh)}
            description={decisionDescription(runDecision.kind, zh, selectedRunNode)}
            zh={zh}
            busy={busy}
            submitLabel={decisionSubmitLabel(runDecision.kind, zh)}
            submitDisabled={runDecision.kind !== 'approve' && !decisionReason.trim()}
            danger={runDecision.kind !== 'approve'}
            onClose={() => {
              setRunDecision(null);
              setDecisionReason('');
            }}
            onSubmit={(event) => void submitRunDecision(event)}
          >
            <label>
              <span>{zh ? '决定原因' : 'Decision reason'}</span>
              <textarea autoFocus rows={5} required={runDecision.kind !== 'approve'} maxLength={4000} value={decisionReason} onChange={(event) => setDecisionReason(event.currentTarget.value)} />
            </label>
          </FormDialog>
        ) : null}
      </MotionPresence>
    </section>
  );
}

/** 按需展开的成员选择器使用当前模板作用域的员工目录，不占用永久侧栏。 */
function RolePalette(props: { employees: DigitalTeamMemberRecord[]; onAdd(payload: DigitalTeamDragPayload): void }) {
  return (
    <section>
      <div className="digital-team-section-heading">
        <h2>数字员工</h2>
        <span>{props.employees.length}</span>
      </div>
      <p className="digital-team-help">选择已创建的数字员工加入团队。同一数字员工可承担多个分工。</p>
      <div className="digital-team-palette-list">
        {props.employees.length === 0 ? (
          <p role="status">还没有可用的数字员工，请先在“数字员工”页面创建。</p>
        ) : (
          props.employees.map((employee) => (
            <article key={employee.id} className="digital-team-palette-card" draggable onDragStart={(event) => writeDragPayload(event, { kind: 'employee', employeeId: employee.id })}>
              <DigitalEmployeeAvatar avatarId={employee.avatarId} role={employee.role} />
              <span>
                <strong>{employee.name}</strong>
                <small>{employee.role}</small>
              </span>
              <Button size="compact" aria-label={`添加员工节点 ${employee.name}`} onClick={() => props.onAdd({ kind: 'employee', employeeId: employee.id })}>
                添加
              </Button>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

/** 节点检查器按判别联合展示且只更新当前节点允许的字段。 */
function NodeInspector(props: {
  /** 团队成员只引用已创建的全局数字员工。 */
  node: DigitalTeamNode | null;
  definition: DigitalTeamWorkflowDefinition;
  employees: DigitalTeamMemberRecord[];
  employeeNames: ReadonlyMap<string, string>;
  /** 项目状态目录供员工节点的触发与推进使用。 */
  statuses: TaskManagementStatusDefinition[];
  /** 内置状态空文案按当前应用语言显示，不修改保存的状态身份。 */
  language: 'zh-CN' | 'en-US';
  issues: DigitalTeamWorkflowValidationIssue[];
  onChange(node: DigitalTeamNode): void;
  onConnect(source: string, target: string): void;
  onDisconnect(edgeId: string): void;
  onDelete(nodeId: string): void;
}) {
  if (!props.node)
    return (
      <div className="digital-team-inspector-empty">
        <h2>节点配置</h2>
        <p>选择一个节点以查看和修改配置。</p>
      </div>
    );
  /** 当前节点供各分支使用。 */
  const node = props.node;
  /** 新团队读取全局员工模板，旧项目模板继续读取原项目员工。 */
  const employee = node.type === 'employee' ? props.employees.find((candidate) => candidate.id === node.data.employeeId) : undefined;
  return (
    <div className="digital-team-inspector-content">
      <div className="digital-team-section-heading">
        <h2>{node.type === 'employee' ? '成员分工' : '节点配置'}</h2>
        {node.type !== 'employee' ? <span>{nodeTypeLabel(node.type)}</span> : null}
      </div>
      {node.type === 'employee' ? (
        <EmployeeNodeFields
          key={`${node.id}:${employee?.id ?? 'missing'}:${employee?.revision ?? 0}`}
          node={node}
          employees={props.employees}
          employee={employee}
          statuses={props.statuses}
          language={props.language}
          hasStatusIssue={props.issues.some((issue) => issue.code.includes('STATUS'))}
          hasDevelopmentIssue={props.issues.some((issue) => issue.code.includes('VERIFY') || issue.code.includes('EXECUTION'))}
          onChange={props.onChange}
        />
      ) : (
        <label>
          <span>名称</span>
          <input value={node.data.title} maxLength={120} onChange={(event) => props.onChange({ ...node, data: { ...node.data, title: event.currentTarget.value } } as DigitalTeamNode)} />
        </label>
      )}
      <KeyboardConnectionEditor definition={props.definition} employeeNames={props.employeeNames} node={node} onConnect={props.onConnect} onDisconnect={props.onDisconnect} />
      {props.issues.length ? (
        <ul className="digital-team-node-issues">
          {props.issues.map((issue, index) => (
            <li key={`${index}_${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
      <details className="digital-team-advanced-settings">
        <summary>移除分工</summary>
        <Button variant="danger" onClick={() => props.onDelete(node.id)}>
          <Trash aria-hidden="true" />
          移除这份分工
        </Button>
      </details>
    </div>
  );
}

/** 键盘用户通过检查器添加或删除上游依赖，不依赖画布拖线手势。 */
function KeyboardConnectionEditor(props: {
  definition: DigitalTeamWorkflowDefinition;
  employeeNames: ReadonlyMap<string, string>;
  node: DigitalTeamNode;
  onConnect(source: string, target: string): void;
  onDisconnect(edgeId: string): void;
}) {
  /** 可选上游排除自身、重复边和会形成环路的员工节点。 */
  const candidates = props.definition.nodes.filter((candidate) => isConnectionAllowed(props.definition, candidate.id, props.node.id));
  /** 当前选择随候选变化自动回到第一个合法节点。 */
  const [sourceId, setSourceId] = useState(candidates[0]?.id ?? '');
  /** 当前节点已保存的直接上游连线。 */
  const incoming = props.definition.edges.filter((edge) => edge.target === props.node.id);
  /** 选择失效时使用首个合法候选，避免按钮提交旧节点。 */
  const selectedSourceId = candidates.some((candidate) => candidate.id === sourceId) ? sourceId : (candidates[0]?.id ?? '');
  return (
    <section className="digital-team-connection-editor" aria-label="前置分工">
      <h3>先完成的分工</h3>
      {candidates.length > 0 ? (
        <div className="digital-team-connection-add">
          <ZeusSelect
            ariaLabel="选择需要先完成的分工"
            value={selectedSourceId}
            options={candidates.map((candidate) => ({
              value: candidate.id,
              label: candidate.type === 'employee' ? (props.employeeNames.get(candidate.data.employeeId) ?? candidate.data.title) : candidate.data.title,
              description: nodeTypeLabel(candidate.type),
            }))}
            onChange={setSourceId}
            searchable
            size="regular"
          />
          <Button size="compact" onClick={() => selectedSourceId && props.onConnect(selectedSourceId, props.node.id)} disabled={!selectedSourceId}>
            添加
          </Button>
        </div>
      ) : incoming.length === 0 ? (
        <p>无需等待其他分工。</p>
      ) : null}
      {incoming.length > 0 ? (
        <ul>
          {incoming.map((edge) => (
            <li key={edge.id}>
              <span>
                {nodeDisplayName(
                  props.definition.nodes.find((node) => node.id === edge.source),
                  props.employeeNames,
                  edge.source,
                )}
              </span>
              <Button size="compact" aria-label="移除前置分工" onClick={() => props.onDisconnect(edge.id)}>
                移除
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** 员工节点只在流程里选择一次；运行时由存储边界解析并冻结项目执行实例。 */
function EmployeeNodeFields(props: {
  node: DigitalTeamEmployeeNode;
  employees: DigitalTeamMemberRecord[];
  employee: DigitalTeamMemberRecord | undefined;
  statuses: TaskManagementStatusDefinition[];
  /** 用户自定义状态文案优先，内置缺省文案使用当前语言。 */
  language: 'zh-CN' | 'en-US';
  /** 状态校验失败时直接展开对应设置。 */ hasStatusIssue: boolean;
  /** 执行模式校验失败时直接展开研发设置。 */ hasDevelopmentIssue: boolean;
  onChange(node: DigitalTeamNode): void;
}) {
  /** 节点工作说明属于流程，员工默认职责仍由员工配置统一管理。 */
  const update = (data: Partial<DigitalTeamEmployeeNode['data']>): void => props.onChange({ ...props.node, data: { ...props.node.data, ...data } });
  /** 编辑时保留换行，正式保存再剔除空项。 */
  const lines = (value: string): string[] => value.split('\n');
  /** 折叠状态仍明确展示研发职责和实际执行范围。 */
  const developmentPurpose = { plan: '规划', work: '执行', verify: '代码验收', summary: '交付汇总' }[props.node.data.purpose];
  /** 任务联动已有值只作摘要，不强迫用户展开空配置。 */
  const statusConfigured = props.node.data.assignmentEntry || props.node.data.triggerStatusId || props.node.data.startStatusId || props.node.data.completionStatusId;
  /** 展开状态只属于当前节点和员工，沿用检查器现有 key 在切换时重置。 */
  const [statusSettingsOpen, setStatusSettingsOpen] = useState(props.hasStatusIssue);
  /** 必需配置错误出现时展开，错误消失后仍允许用户继续填写。 */
  const [developmentSettingsOpen, setDevelopmentSettingsOpen] = useState(props.hasDevelopmentIssue);
  useEffect(() => {
    /** 只响应新出现的状态错误，不随修正结果自动关闭。 */
    if (props.hasStatusIssue) setStatusSettingsOpen(true);
  }, [props.hasStatusIssue]);
  useEffect(() => {
    /** 只响应新出现的研发错误，保留用户手动收起或展开的选择。 */
    if (props.hasDevelopmentIssue) setDevelopmentSettingsOpen(true);
  }, [props.hasDevelopmentIssue]);
  return (
    <>
      <label>
        <span>执行员工</span>
        <ZeusSelect
          ariaLabel="选择执行员工"
          value={props.node.data.employeeId}
          options={props.employees.map((employee) => ({ value: employee.id, label: employee.name, description: employee.role }))}
          onChange={(employeeId) => {
            const employee = props.employees.find((candidate) => candidate.id === employeeId);
            if (!employee) return;
            props.onChange({
              ...props.node,
              data: {
                ...props.node.data,
                title: employee.name,
                employeeId,
                settings: undefined,
              },
            });
          }}
          searchable
          size="regular"
        />
      </label>
      <label>
        <span>工作方式</span>
        <ZeusSelect
          size="regular"
          ariaLabel="工作方式"
          value={props.node.data.executionMode}
          disabled={props.node.data.purpose !== 'work'}
          options={
            props.node.data.purpose === 'work'
              ? [
                  { value: 'read_only', label: digitalTeamWorkModeLabels.read_only },
                  { value: 'isolated_write', label: digitalTeamWorkModeLabels.isolated_write },
                ]
              : [{ value: props.node.data.executionMode, label: digitalTeamWorkModeLabels[props.node.data.executionMode] }]
          }
          onChange={(value) => update({ executionMode: value as DigitalTeamEmployeeNode['data']['executionMode'] })}
        />
        <small>{props.node.data.purpose === 'work' ? '修改代码在隔离工作区进行，仍需本次任务授权。' : props.node.data.purpose === 'verify' ? '代码验收只核对候选，不修改源码。' : '规划与汇总只做分析；需要开发时，请使用执行职责。'}</small>
      </label>
      <label>
        <span>工作要求</span>
        <textarea placeholder="默认按任务目标与员工职责执行" value={props.node.data.instructions} maxLength={12000} onChange={(event) => update({ instructions: event.currentTarget.value })} />
      </label>
      <label>
        <span>完成标准</span>
        <textarea rows={3} placeholder="默认按工作要求完成并提交可核对结果，每行一项" value={(props.node.data.acceptanceCriteria ?? []).join('\n')} onChange={(event) => update({ acceptanceCriteria: lines(event.currentTarget.value) })} />
      </label>
      <p className="digital-team-work-permission">
        {props.node.data.executionMode === 'isolated_write' ? '工作权限：隔离工作区修改代码，仍需本次任务授权。' : props.node.data.executionMode === 'candidate_read_only' ? '工作权限：只读验收代码候选。' : '工作权限：只读。'}
      </p>
      <details
        className="digital-team-advanced-settings"
        open={statusSettingsOpen}
        onToggle={(event) => {
          /** 原生展开操作同步到节点本地状态。 */
          setStatusSettingsOpen(event.currentTarget.open);
        }}
      >
        <summary>任务状态联动{statusConfigured ? <small>已配置</small> : null}</summary>
        <label className="digital-team-checkbox">
          <input type="checkbox" checked={props.node.data.assignmentEntry ?? false} onChange={(event) => update({ assignmentEntry: event.currentTarget.checked })} />
          <span>指派该员工时，从这份分工开始</span>
        </label>
        {(['triggerStatusId', 'startStatusId', 'completionStatusId'] as const).map((key, index) => (
          <label key={key}>
            <span>{['状态触发', '开始状态', '完成状态'][index]}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={['状态触发', '开始状态', '完成状态'][index]!}
              value={props.node.data[key] ?? ''}
              options={[{ value: '', label: '不配置' }, ...props.statuses.map((status) => ({ value: status.id, label: status.label ?? defaultTaskManagementStatusLabels[props.language][status.id] ?? status.id }))]}
              onChange={(value) => update({ [key]: value || undefined })}
            />
          </label>
        ))}
      </details>
      <details
        className="digital-team-advanced-settings"
        open={developmentSettingsOpen}
        onToggle={(event) => {
          /** 编辑和校验刷新不会覆盖用户保留的展开状态。 */
          setDevelopmentSettingsOpen(event.currentTarget.open);
        }}
      >
        <summary>
          研发设置<small>{developmentPurpose}</small>
        </summary>
        <label>
          <span>研发职责</span>
          <ZeusSelect
            size="regular"
            ariaLabel="研发职责"
            value={props.node.data.purpose}
            options={[
              { value: 'plan', label: '规划' },
              { value: 'work', label: '执行' },
              { value: 'verify', label: '代码验收' },
              { value: 'summary', label: '交付汇总' },
            ]}
            onChange={(value) => {
              /** 候选只读只属于代码验收，切回普通分工不会自动授权代码修改。 */
              const purpose = value as DigitalTeamEmployeeNode['data']['purpose'];
              update({ purpose, executionMode: purpose === 'verify' ? 'candidate_read_only' : purpose === 'work' && props.node.data.executionMode === 'isolated_write' ? 'isolated_write' : 'read_only' });
            }}
          />
        </label>
        {props.node.data.purpose === 'verify' ? (
          <label>
            <span>固定验收命令（可选，每行一项）</span>
            <small>留空时按当前任务与仓库既有检查验收，结果仍须提供真实成功命令证据。</small>
            <textarea placeholder="填写当前仓库实际使用的检查命令" value={(props.node.data.verificationCommands ?? []).join('\n')} onChange={(event) => update({ verificationCommands: lines(event.currentTarget.value) })} />
          </label>
        ) : null}
      </details>
      {!props.employee ? (
        <p className="digital-team-message is-error" role="alert">
          当前节点绑定的数字员工模板不存在。
        </p>
      ) : null}
    </>
  );
}

/** 有问题时展示简短原因和节点定位入口，不占用正常流程的空间。 */
function ValidationPanel(props: { issues: Array<{ code: string; message: string; nodeId?: string }>; onSelectNode(nodeId: string): void }) {
  if (!props.issues.length) return null;
  /** 相同配置问题合并计数，避免每个分工重复一段技术错误。 */
  const groups = new Map<string, { code: string; message: string; nodeIds: string[]; count: number }>();
  for (const issue of props.issues) {
    /** 同类问题保留第一个可配置节点作为直接入口。 */
    const key = `${issue.code}:${issue.message}`;
    /** 当前分组同时保留准确节点身份。 */
    const group = groups.get(key) ?? { code: issue.code, message: issue.message, nodeIds: [], count: 0 };
    group.count += 1;
    if (issue.nodeId) group.nodeIds.push(issue.nodeId);
    groups.set(key, group);
  }
  /** 未分配员工是正常草稿状态，不作为页面错误告警。 */
  const onlyAssignments = props.issues.every((issue) => issue.code === unassignedEmployeeIssueCode);
  return (
    <section className={`digital-team-validation${onlyAssignments ? '' : ' has-issues'}`} aria-live="polite">
      <strong>{onlyAssignments ? `还有 ${props.issues.length} 个分工待分配员工` : `还需处理 ${groups.size} 类问题`}</strong>
      <ul>
        {[...groups.entries()].map(([key, issue]) => (
          <li key={key}>
            <span>{issue.code === unassignedEmployeeIssueCode ? '选择执行员工后即可使用团队。' : `${issue.message}${issue.count > 1 ? `（${issue.count} 处）` : ''}`}</span>
            {issue.nodeIds.length ? (
              <button type="button" onClick={() => props.onSelectNode(issue.nodeIds[0])}>
                {issue.code === unassignedEmployeeIssueCode ? '配置员工' : '定位'}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 运行检查器只显示 Core 投影，并提供当前人工动作。 */
function RunInspector(props: {
  run: DigitalTeamWorkflowRunRecord | null;
  node: DigitalTeamNode | null;
  attempt: DigitalTeamNodeAttemptRecord | null;
  attempts: DigitalTeamNodeAttemptRecord[];
  history: DigitalTeamNodeAttemptRecord[];
  onOpenConversation?(conversationId: string): Promise<void>;
  onApprove(kind: 'approve' | 'reject'): void;
  onRework(): void;
}) {
  if (!props.run)
    return (
      <div className="digital-team-inspector-empty">
        <h2>运行详情</h2>
        <p>选择运行以查看冻结图。</p>
      </div>
    );
  if (!props.node)
    return (
      <div className="digital-team-inspector-empty">
        <h2>运行详情</h2>
        <p>选择节点以查看当前尝试、会话和错误。</p>
      </div>
    );
  /** 人工节点只有等待批准的当前尝试才能决定。 */
  const approvalAvailable = props.node.type === 'human_confirmation' && props.attempt?.status === 'awaiting_approval';
  /** 返工影响范围只按冻结图计算一次。 */
  const reworkNodeIds = relatedNodeIds(props.run, props.node.id, 'downstream');
  /** 失败运行允许显式返工；完成、取消或影响范围内在途工作阻止返工，其他活动运行由 Core 再核对。 */
  const reworkAvailable =
    !['completed', 'cancelled'].includes(props.run.status) &&
    (props.node.type === 'employee' || props.node.type === 'code_integration') &&
    Boolean(props.attempt) &&
    !props.attempts.some((attempt) => reworkNodeIds.has(attempt.nodeId) && ['dispatching', 'active'].includes(attempt.status));
  return (
    <div className="digital-team-inspector-content">
      <div className="digital-team-section-heading">
        <h2>{props.node.data.title}</h2>
        <span>{nodeTypeLabel(props.node.type)}</span>
      </div>
      <dl>
        <div>
          <dt>运行状态</dt>
          <dd>{digitalTeamRunStatusLabel(props.run)}</dd>
        </div>
        <div>
          <dt>节点尝试</dt>
          <dd>{props.attempt ? `第 ${props.attempt.attempt} 次 · ${props.attempt.status}` : '尚未准备'}</dd>
        </div>
        <div>
          <dt>会话</dt>
          <dd>
            {props.attempt?.conversationId && props.onOpenConversation ? (
              <Button size="compact" onClick={() => void props.onOpenConversation!(props.attempt!.conversationId!)}>
                打开会话
              </Button>
            ) : (
              (props.attempt?.conversationId ?? '—')
            )}
          </dd>
        </div>
        <div>
          <dt>工作区</dt>
          <dd>{props.attempt?.workspaceId ?? '—'}</dd>
        </div>
      </dl>
      {attemptErrorMessage(props.attempt) ? (
        <p className="digital-team-message is-error" role="alert">
          {attemptErrorMessage(props.attempt)}
        </p>
      ) : null}
      {props.node.type === 'human_confirmation' && props.node.data.purpose === 'plan_approval' ? <PlanApprovalEvidence run={props.run} /> : null}
      {props.node.type === 'human_confirmation' && props.node.data.purpose === 'final_acceptance' ? <FinalApprovalEvidence run={props.run} nodeId={props.node.id} attempts={props.attempts} /> : null}
      <AttemptHistory attempts={props.history.filter((attempt) => attempt.nodeId === props.node!.id)} />
      {approvalAvailable ? (
        <div className="digital-team-inspector-actions">
          <Button variant="primary" onClick={() => props.onApprove('approve')}>
            批准
          </Button>
          <Button variant="danger" onClick={() => props.onApprove('reject')}>
            退回
          </Button>
        </div>
      ) : null}
      {reworkAvailable ? <Button onClick={props.onRework}>从此节点返工</Button> : null}
    </div>
  );
}

/** 展示选中节点不可覆盖的全部尝试，返工前后结果均可追溯。 */
function AttemptHistory(props: { attempts: DigitalTeamNodeAttemptRecord[] }) {
  if (props.attempts.length === 0) return null;
  return (
    <details className="digital-team-attempt-history">
      <summary>历史尝试（{props.attempts.length}）</summary>
      <ol>
        {[...props.attempts]
          .sort((left, right) => right.attempt - left.attempt)
          .map((attempt) => (
            <li key={attempt.id}>
              <strong>
                第 {attempt.attempt} 次 · {attempt.status}
              </strong>
              <span>{attempt.result?.summary ?? attempt.invalidationReason ?? attemptErrorMessage(attempt) ?? '无结果摘要'}</span>
              <small>
                {attempt.conversationId ? `会话 ${attempt.conversationId}` : '无会话'} · {attempt.workspaceId ? `工作区 ${attempt.workspaceId}` : '无工作区'}
              </small>
            </li>
          ))}
      </ol>
    </details>
  );
}

/** 按实际依赖查找上游成果或下游返工范围，包含目标自身。 */
function relatedNodeIds(run: DigitalTeamWorkflowRunRecord, nodeId: string, direction: 'upstream' | 'downstream'): Set<string> {
  /** 仅从冻结定义和当前计划派生依赖关系。 */
  const definition = digitalTeamExecutionDefinition(run);
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of definition.edges) outgoing.get(direction === 'upstream' ? edge.target : edge.source)?.push(direction === 'upstream' ? edge.source : edge.target);
  /** 待访问节点从当前目标自身开始。 */
  const pending = [nodeId];
  /** 结果同时用于去重。 */
  const result = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  return result;
}

/** 规划批准前展示真实分工与本次确认的范围。 */
function PlanApprovalEvidence(props: { run: DigitalTeamWorkflowRunRecord }) {
  return (
    <section className="digital-team-approval-evidence" aria-label="待确认工作计划">
      <h3>待确认工作计划</h3>
      <p>{props.run.plan?.summary ?? '负责人尚未提交可批准的结构化计划。'}</p>
      <ol>
        {(props.run.plan?.assignments ?? []).map((assignment) => (
          <li key={assignment.nodeId}>
            <strong>{assignment.nodeId}</strong>
            <span>{assignment.objective}</span>
            <small>范围：{assignment.scope.join('；')}</small>
            <small>不做：{assignment.excludedScope.join('；') || '无'}</small>
            <small>验收：{assignment.acceptanceCriteria.join('；')}</small>
            <small>交付：{assignment.expectedDeliverables.join('；')}</small>
          </li>
        ))}
      </ol>
      <p className="digital-team-approval-boundary">确认后按工作依赖执行当前分工，行动权限以本次任务授权为准。</p>
    </section>
  );
}

/** 人工确认展示本步骤实际收到的成果，代码分支再展示当前候选。 */
function FinalApprovalEvidence(props: { run: DigitalTeamWorkflowRunRecord; nodeId: string; attempts: DigitalTeamNodeAttemptRecord[] }) {
  /** 只展示当前确认的上游，不混入无依赖的其他分支。 */
  const sourceIds = relatedNodeIds(props.run, props.nodeId, 'upstream');
  sourceIds.delete(props.nodeId);
  /** 冻结图提供可读名称与代码集成范围。 */
  const definition = digitalTeamExecutionDefinition(props.run);
  /** 失效、失败和旧尝试不能冒充本次待确认成果。 */
  const sources = props.attempts.filter((attempt) => sourceIds.has(attempt.nodeId) && attempt.status === 'succeeded' && (attempt.result || attempt.artifactRef || attempt.approval));
  /** 普通报告确认无需代码候选，独立代码分支也不会混入。 */
  const hasCandidate = definition.nodes.some((node) => node.type === 'code_integration' && sourceIds.has(node.id));
  return (
    <section className="digital-team-approval-evidence" aria-label="待确认成果">
      <h3>待确认成果</h3>
      {sources.length ? (
        <ul>
          {sources.map((attempt) => (
            <li key={attempt.id}>
              <strong>{definition.nodes.find((node) => node.id === attempt.nodeId)?.data.title ?? attempt.nodeId}</strong>
              <span>{attempt.result?.summary ?? attempt.approval?.reason ?? '已保存产物。'}</span>
              {attempt.result ? (
                <small>
                  证据 {attempt.result.evidence.length} 项；剩余问题：{attempt.result.remainingIssues.join('；') || '无'}
                </small>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>尚无已完成的上游成果。</p>
      )}
      {hasCandidate ? (
        <>
          <h3>当前代码候选</h3>
          <ul>
            {props.run.candidateRevisions.map((candidate) => (
              <li key={candidate.repositoryId}>
                <strong>{candidate.repositoryId}</strong>
                <span>{candidate.headSha}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="digital-team-approval-boundary">确认只针对当前步骤收到的成果，后续工作按依赖继续。</p>
    </section>
  );
}

/** 确认 DashboardClient 已组合数字团队与员工真实接口。 */
function hasDigitalTeamApi(client: DashboardClient | null): client is DashboardClient & DigitalTeamApiClient {
  return Boolean(client && 'loadDigitalTeamTemplates' in client && typeof client.loadDigitalTeamTemplates === 'function' && 'createDigitalTeamRun' in client && typeof client.createDigitalTeamRun === 'function');
}

/** 当前项目仍存在时沿用，否则选第一个真实项目。 */
function validInitialProjectId(projects: ProjectRecord[], initialProjectId?: string): string {
  return projects.some((project) => project.id === initialProjectId) ? initialProjectId! : (projects[0]?.id ?? '');
}

/** 新模板以空画布和稳定视口开始，允许保存不完整草稿。 */
function emptyTemplateDraft(): TemplateDraft {
  return { id: null, revision: null, name: '', description: '', definition: { schemaGeneration: digitalTeamWorkflowSchemaGeneration, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0.8 } } };
}

/** 已保存模板复制为可编辑草稿，不混入运行状态。 */
function templateDraft(template: DigitalTeamWorkflowTemplateRecord): TemplateDraft {
  /** 只隔离无法绘制的结构；缺少分工、状态或员工的普通草稿仍能直接编辑。 */
  const issues = validateDigitalTeamWorkflowDefinition(template.definition);
  /** 非法节点和边不能交给画布 map，也不能把安全空视图直接写回原定义。 */
  const sourceIssues = issues.some((issue) => ['ZEUS_DIGITAL_TEAM_WORKFLOW_SHAPE_INVALID', 'ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_INVALID', 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_INVALID'].includes(issue.code)) ? issues : undefined;
  return { id: template.id, revision: template.revision, name: template.name, description: template.description, definition: sourceIssues ? emptyTemplateDraft().definition : structuredClone(template.definition), sourceIssues };
}

/** 旧系统默认三人流程直接呈现研发分工，正式保存仍沿用原模板身份和修订校验。 */
function prepareDevelopmentTemplateDraft(draft: TemplateDraft, employees: readonly DigitalTeamMemberRecord[], completedStatusId?: string): TemplateDraft {
  if (draft.sourceIssues?.length) return draft;
  /** 自定义要求与其他只读流程不会匹配默认补齐条件。 */
  const definition = buildDigitalTeamDevelopmentDraft(draft.definition, employees, completedStatusId);
  return definition ? { ...draft, definition } : draft;
}

/** 添加按钮使用可预期的阶梯位置，拖放仍使用准确视口坐标。 */
function nextNodePosition(index: number): { x: number; y: number } {
  return { x: 80 + (index % 4) * 240, y: 80 + Math.floor(index / 4) * 150 };
}

/** 构造新的员工分工节点，不自动猜测依赖关系。 */
function buildNode(payload: DigitalTeamDragPayload, position: { x: number; y: number }, employee: DigitalTeamMemberRecord | undefined, completedStatusId?: string): DigitalTeamNode {
  /** 节点身份只用于当前草稿，岗位默认值不授予任务执行权限。 */
  const id = `node_${crypto.randomUUID()}`;
  return {
    id,
    type: 'employee',
    position,
    data: {
      title: employee?.name ?? '员工分工',
      employeeId: payload.employeeId,
      ...digitalTeamMemberDefaults(employee?.role, completedStatusId),
    },
  };
}

/** 替换单个节点而不改变边和视口。 */
function replaceNode(definition: DigitalTeamWorkflowDefinition, node: DigitalTeamNode, onChange: (definition: DigitalTeamWorkflowDefinition) => void): void {
  onChange({ ...definition, nodes: definition.nodes.map((candidate) => (candidate.id === node.id ? node : candidate)) });
}

/** 删除节点时同步删除相连边，避免留下幽灵依赖。 */
function removeNode(definition: DigitalTeamWorkflowDefinition, nodeId: string, onChange: (definition: DigitalTeamWorkflowDefinition) => void, onSelect: (nodeId: string | null) => void): void {
  onChange({ ...definition, nodes: definition.nodes.filter((node) => node.id !== nodeId), edges: definition.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId) });
  onSelect(null);
}

/** 写入受限拖放负载，画布会在信任边界重新校验。 */
function writeDragPayload(event: ReactDragEvent<HTMLElement>, payload: DigitalTeamDragPayload): void {
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(digitalTeamDragMime, JSON.stringify(payload));
}

/** 节点名称优先读取当前成员目录，其他节点继续使用流程内名称。 */
function nodeDisplayName(node: DigitalTeamNode | undefined, employeeNames: ReadonlyMap<string, string>, fallback: string): string {
  if (!node) return fallback;
  return node.type === 'employee' ? (employeeNames.get(node.data.employeeId) ?? node.data.title) : node.data.title;
}

/** 五类节点的人话标签。 */
function nodeTypeLabel(type: DigitalTeamNodeType): string {
  if (type === 'start') return '开始';
  if (type === 'employee') return '员工';
  if (type === 'human_confirmation') return '人工确认';
  if (type === 'code_integration') return '代码集成';
  return '结束';
}

/** 运行标题来自创建时冻结的任务事实，不从可变模板反推。 */
function runTitle(run: DigitalTeamWorkflowRunRecord): string {
  return typeof run.taskFacts.title === 'string' && run.taskFacts.title.trim() ? run.taskFacts.title : run.taskId;
}

/** 尝试错误优先展示结构化 message，未知结构保留通用提示。 */
function attemptErrorMessage(attempt: DigitalTeamNodeAttemptRecord | null): string | null {
  if (!attempt?.error) return null;
  return typeof attempt.error.message === 'string' ? attempt.error.message : '当前尝试包含需要核对的错误。';
}

/** 每个节点只展示 attempt 最大的当前结果，旧尝试仍由 Core 保留。 */
function latestAttempt(attempts: DigitalTeamNodeAttemptRecord[], nodeId: string): DigitalTeamNodeAttemptRecord | null {
  let result: DigitalTeamNodeAttemptRecord | null = null;
  for (const attempt of attempts) if (attempt.nodeId === nodeId && (!result || attempt.attempt > result.attempt)) result = attempt;
  return result;
}

/** 为运行图建立一次状态索引。 */
function buildRunStateIndex(attempts: DigitalTeamNodeAttemptRecord[]): ReadonlyMap<string, DigitalTeamCanvasRuntimeState> {
  const result = new Map<string, DigitalTeamCanvasRuntimeState>();
  for (const attempt of attempts) {
    const current = result.get(attempt.nodeId);
    if (!current || (current.attempt ?? 0) <= attempt.attempt) result.set(attempt.nodeId, { status: attempt.status, attempt: attempt.attempt });
  }
  return result;
}

/** 打开人工决定前绑定当前节点和尝试，避免迟到选择污染其他节点。 */
function openRunDecision(kind: RunDecision['kind'], node: DigitalTeamNode | null, attempt: DigitalTeamNodeAttemptRecord | null, setDecision: (decision: RunDecision) => void, setReason: (reason: string) => void): void {
  if (!node || !attempt) return;
  setReason('');
  setDecision({ kind, nodeId: node.id, attempt: attempt.attempt });
}

/** 人工决定弹窗标题。 */
function decisionTitle(kind: RunDecision['kind'], zh: boolean): string {
  if (kind === 'approve') return zh ? '批准当前节点' : 'Approve node';
  if (kind === 'reject') return zh ? '退回当前节点' : 'Reject node';
  return zh ? '确认返工范围' : 'Confirm rework';
}

/** 人工决定说明明确失效规则。 */
function decisionDescription(kind: RunDecision['kind'], zh: boolean, node: DigitalTeamNode | null): string {
  if (kind === 'rework')
    return zh
      ? '确认后弃用目标节点及其全部后继的当前结果（包括结果未知的尝试），保留历史并重新执行；未受影响的并行分支继续保留。'
      : 'Confirm to discard current results, including unknown outcomes, for this node and all descendants. History and unaffected parallel branches are retained before a new attempt starts.';
  if (kind === 'approve' && node?.type === 'human_confirmation' && node.data.purpose === 'plan_approval') {
    return zh
      ? '批准当前计划，并继续本次已授权的工作；这次确认不会扩大任务权限。'
      : 'Approval freezes this plan and authorizes task-local worktrees, branches, commits, and candidate integration. It does not authorize push, target-branch merge, or release.';
  }
  if (kind === 'approve' && node?.type === 'human_confirmation' && node.data.purpose === 'final_acceptance') {
    return zh ? '验收绑定当前上游成果，并允许依赖它的工作继续；不会执行推送或发布。' : 'Acceptance completes this workflow run only; it does not push, merge the target branch, or release.';
  }
  return zh ? '决定会绑定当前节点尝试和运行修订，重复或迟到提交不会推进其他尝试。' : 'The decision is bound to the current node attempt and run revision.';
}

/** 人工决定提交按钮文案。 */
function decisionSubmitLabel(kind: RunDecision['kind'], zh: boolean): string {
  if (kind === 'approve') return zh ? '确认批准' : 'Approve';
  if (kind === 'reject') return zh ? '确认退回' : 'Reject';
  return zh ? '确认返工' : 'Request rework';
}

/** 媒体查询只订阅一个全局监听，组件卸载时释放。 */
function useCompactInspector(): boolean {
  const [compact, setCompact] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(compactInspectorQuery).matches));
  useEffect(() => {
    const query = window.matchMedia(compactInspectorQuery);
    const sync = (): void => setCompact(query.matches);
    query.addEventListener('change', sync);
    sync();
    return () => query.removeEventListener('change', sync);
  }, []);
  return compact;
}

/** 将未知错误交给统一产品错误映射。 */
function applicationError(cause: unknown, zh: boolean): string {
  return formatVisibleApplicationError(cause, zh ? 'zh-CN' : 'en');
}
