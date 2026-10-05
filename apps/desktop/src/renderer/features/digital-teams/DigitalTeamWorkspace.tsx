import {
  digitalTeamExecutionDefinition,
  digitalTeamWorkflowSchemaGeneration,
  defaultTaskManagementStatusConfig,
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
  type TaskManagementStatusRoles,
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
import type { DigitalEmployeeRecord, DigitalEmployeeTemplateRecord } from '../digital-employees/digitalEmployeeContracts.js';
import type { ProjectRecord } from '../projects/projectContracts.js';
import { type DigitalTeamApiClient, type DigitalTeamRunProjection, type DigitalTeamTemplateSaveInput } from './digitalTeamApiClient.js';
import { digitalTeamDragMime, isConnectionAllowed, WorkflowCanvas, type DigitalTeamCanvasRuntimeState, type DigitalTeamDragPayload } from './WorkflowCanvas.js';
import './digitalTeams.css';

/** 数字团队页面支持的两个真实数据视图。 */
type DigitalTeamView = 'editor' | 'runs';

/** 任务详情下拉进入数字团队时携带的明确目标。 */
export type DigitalTeamEntrySelection = { kind: 'template'; templateId: string } | { kind: 'run'; runId: string } | { kind: 'manage' };

/** 本地模板草稿只保留服务端允许保存的字段。 */
type TemplateDraft = Pick<DigitalTeamTemplateSaveInput, 'name' | 'description' | 'definition'> & { id: string | null; revision: number | null; projectId: string | null };

/** 团队节点编辑读取全局已创建员工或旧项目员工记录的共同字段。 */
type DigitalTeamMemberRecord = DigitalEmployeeTemplateRecord | DigitalEmployeeRecord;

/** 人工决定弹窗统一覆盖批准、退回和返工。 */
type RunDecision = { kind: 'approve' | 'reject' | 'rework'; nodeId: string; attempt: number };

/** 无项目时使用的选择值。 */
const noProjectValue = '__no_digital_team_project__';

/** 窄窗口统一把节点检查器切换为覆盖抽屉。 */
const compactInspectorQuery = '(max-width: 1180px)';

/** 运行状态的人话标签。 */
const runStatusLabels: Record<string, string> = {
  planning: '负责人规划中',
  awaiting_plan_approval: '等待规划批准',
  executing: '员工执行中',
  integrating: '正在集成候选',
  verifying: '正在核对成果',
  summarizing: '成果汇总中',
  awaiting_final_approval: '等待最终验收',
  completed: '已完成',
  failed: '失败',
  outcome_unknown: '结果待核对',
  cancelled: '已取消',
};

/** 终态运行只允许读取，不再显示派发控制或返工入口。 */
const terminalRunStatuses = new Set<DigitalTeamWorkflowRunRecord['status']>(['completed', 'failed', 'cancelled']);

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
  /** 全局模板与当前项目旧模板的兼容集合。 */
  const [templates, setTemplates] = useState<DigitalTeamWorkflowTemplateRecord[]>([]);
  /** 当前项目流程独立于可复制的全局模板。 */
  const [projectWorkflow, setProjectWorkflow] = useState<DigitalTeamWorkflowTemplateRecord | null>(null);
  /** 状态选择来自项目真实目录，不由节点自行创造状态。 */
  const [projectStatuses, setProjectStatuses] = useState<TaskManagementStatusDefinition[]>(defaultTaskManagementStatusConfig.statuses);
  /** 完成状态按项目角色识别，不能假定固定状态名称。 */
  const [projectStatusRoles, setProjectStatusRoles] = useState(defaultTaskManagementStatusConfig.roles);
  /** 当前运行目标项目的真实员工角色。 */
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  /** 全局团队成员只从已创建的数字员工中选择。 */
  const [employeeTemplates, setEmployeeTemplates] = useState<DigitalEmployeeTemplateRecord[]>([]);
  /** 当前项目的运行历史。 */
  const [runs, setRuns] = useState<DigitalTeamWorkflowRunRecord[]>([]);
  /** 当前显式编辑的模板草稿。 */
  const [draft, setDraft] = useState<TemplateDraft>(() => emptyTemplateDraft());
  /** 无已保存模板时保持创建入口，只有用户明确开始后才展示配置界面。 */
  const [draftOpen, setDraftOpen] = useState(false);
  /** 草稿与最近保存版本不同才阻止内部切换。 */
  const [dirty, setDirty] = useState(false);
  /** 检查器选中的节点。 */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  /** 已保存模板、项目或重开变化时重建画布以恢复持久视口。 */
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  /** 当前运行图。 */
  const [selectedRun, setSelectedRun] = useState<DigitalTeamRunProjection | null>(null);
  /** 页面读取状态。 */
  const [loading, setLoading] = useState(Boolean(api));
  /** 单个写操作期间禁止重复提交。 */
  const [busy, setBusy] = useState(false);
  /** 可见错误不以控制台或模拟成功替代。 */
  const [error, setError] = useState<string | null>(api ? null : zh ? '当前本地服务尚未提供数字团队接口。' : 'The local service does not provide the digital team API.');
  /** 页面级成功与等待状态通过 live region 告知用户。 */
  const [status, setStatus] = useState<string>('');
  /** 删除必须二次确认。 */
  const [pendingDelete, setPendingDelete] = useState<DigitalTeamWorkflowTemplateRecord | null>(null);
  /** 跨项目复制先完成映射并生成本地草稿，取消不产生写操作。 */
  const [projectCopyOpen, setProjectCopyOpen] = useState(false);
  /** 代码执行授权仅适用于当前任务和当前流程。 */
  const [confirmCommittedBaseline, setConfirmCommittedBaseline] = useState(false);
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

  /** 代码动作才需要用户确认现场和本地修改范围。 */
  const usesCode = draft.definition.nodes.some((node) => node.type === 'employee' && node.data.executionMode === 'isolated_write');
  /** 当前选中模板的服务端记录。 */
  const selectedTemplate = templates.find((template) => template.id === draft.id) ?? null;
  /** 旧项目团队沿用原项目员工；全局团队只引用已创建的全局员工。 */
  const memberCatalog: DigitalTeamMemberRecord[] = draft.projectId ? [...employees, ...employeeTemplates] : employeeTemplates;
  /** 员工名称索引供画布卡片与检查器复用。 */
  const employeeNames = useMemo(() => new Map(memberCatalog.map((employee) => [employee.id, employee.name])), [memberCatalog]);
  /** 共享图校验与已创建员工核对共同决定团队能否形成可运行定义。 */
  const validationIssues = useMemo(() => {
    /** 结构问题先由 shared 权威校验器生成。 */
    /** 草稿与保存共用协议默认值，用户只填写实际工作要求和必需验收命令。 */
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
      if (!employee) issues.push({ code: 'ZEUS_DIGITAL_TEAM_EMPLOYEE_TEMPLATE_UNAVAILABLE', message: draft.projectId ? '员工节点绑定的项目数字员工不存在。' : '成员节点必须绑定已创建且仍然存在的全局数字员工。', nodeId: node.id });
      else if ('enabled' in employee && !employee.enabled) issues.push({ code: 'ZEUS_DIGITAL_TEAM_EMPLOYEE_UNAVAILABLE', message: '员工节点绑定的项目数字员工已停用。', nodeId: node.id });
    }
    return issues;
  }, [draft.definition, draft.projectId, memberCatalog, projectId, projectStatuses, projectStatusRoles]);
  /** 当前选中业务节点。 */
  const selectedNode = draft.definition.nodes.find((node) => node.id === selectedNodeId) ?? null;
  /** 当前运行冻结图兼容 Core 投影的两个稳定字段名。 */
  const selectedRunRecord = selectedRun?.run ?? null;
  /** 运行失败直接显示原因，避免成功创建提示掩盖后续派发失败。 */
  const runError = view === 'runs' && typeof selectedRunRecord?.error?.message === 'string' ? selectedRunRecord.error.message : null;
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

  /** 并行读取全局模板和可选运行项目数据，编辑团队不依赖项目存在。 */
  const refreshProject = useCallback(
    async (preferredTemplateId?: string | null, preferredRunId?: string | null, entrySelection?: DigitalTeamEntrySelection): Promise<void> => {
      if (!api) return;
      if (dirty) {
        setError(zh ? '当前流程尚未保存，请先保存或点击“重开”放弃修改。' : 'Save or reopen the current workflow before refreshing.');
        return;
      }
      const revision = ++loadRevisionRef.current;
      setLoading(true);
      setError(null);
      try {
        const [nextTemplates, nextEmployeeTemplates, nextEmployees, nextRuns, nextWorkflow, runtimeSettings] = await Promise.all([
          api.loadDigitalTeamTemplates(projectId || undefined),
          api.loadDigitalEmployeeTemplates(),
          projectId ? api.loadProjectDigitalEmployees(projectId) : Promise.resolve([]),
          projectId ? api.loadDigitalTeamRuns(projectId, props.task?.id) : Promise.resolve([]),
          projectId ? api.loadProjectDigitalTeamWorkflow(projectId) : Promise.resolve(null),
          api.loadAppShellSettings(),
        ]);
        if (revision !== loadRevisionRef.current) return;
        setTemplates(nextTemplates);
        setProjectWorkflow(nextWorkflow);
        /** 状态目录和完成角色同时刷新，防止沿用另一个项目的完成身份。 */
        const statusConfig = normalizeTaskManagementStatusConfig(runtimeSettings.taskManagementStatusByProject?.[projectId] ?? runtimeSettings.taskManagementStatusTemplate);
        setProjectStatuses(statusConfig.statuses);
        setProjectStatusRoles(statusConfig.roles);
        setEmployeeTemplates(nextEmployeeTemplates.filter((employee) => !employee.builtIn));
        setEmployees(nextEmployees);
        /** 任务入口只展示当前任务运行；团队入口仍展示项目记录。 */
        const visibleRuns = props.task ? nextRuns.filter((run) => run.taskId === props.task!.id) : nextRuns;
        setRuns(visibleRuns);
        const nextTemplate = preferredTemplateId ? nextTemplates.find((template) => template.id === preferredTemplateId) : (nextTemplates.find((template) => template.id === draft.id) ?? nextTemplates[0]);
        setDraft(nextTemplate ? templateDraft(nextTemplate) : emptyTemplateDraft());
        setDraftOpen(Boolean(nextTemplate));
        setCanvasGeneration((current) => current + 1);
        setDirty(false);
        const nextRun = visibleRuns.find((run) => run.id === preferredRunId) ?? visibleRuns.find((run) => run.id === selectedRun?.run.id) ?? (props.task ? visibleRuns[0] : null);
        if (entrySelection?.kind === 'template' && nextTemplate?.id === entrySelection.templateId && nextTemplate.ready && !visibleRuns.some((run) => !terminalRunStatuses.has(run.status))) {
          setView('editor');
        } else if (entrySelection?.kind === 'run' && nextRun?.id === entrySelection.runId) setView('runs');
        else if (entrySelection?.kind === 'manage') setView('editor');
        else if (props.task && nextRun) setView('runs');
        /** 刷新选中运行时重新读取尝试历史，不能只替换运行标题行。 */
        const nextProjection = nextRun ? await api.loadDigitalTeamRun(nextRun.id) : null;
        if (revision !== loadRevisionRef.current) return;
        setSelectedRun(nextProjection);
        setSelectedNodeId(null);
      } catch (cause) {
        if (revision === loadRevisionRef.current) setError(applicationError(cause, zh));
      } finally {
        if (revision === loadRevisionRef.current) setLoading(false);
      }
    },
    [api, dirty, draft.id, projectId, selectedRun?.run.id, zh],
  );

  useEffect(() => {
    void refreshProject(props.initialSelection?.kind === 'template' ? props.initialSelection.templateId : undefined, props.initialSelection?.kind === 'run' ? props.initialSelection.runId : undefined, props.initialSelection);
    return () => {
      loadRevisionRef.current += 1;
    };
  }, [projectId]);

  useEffect(() => {
    if (!dirty) return;
    /** 原生窗口关闭至少触发浏览器标准保护；工作区内部切换另由页面主动阻止。 */
    const preventUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [dirty]);

  useEffect(() => {
    /** Main 进程关闭窗口时与页面导航使用同一未保存事实。 */
    window.zeus?.setUnsavedChangeState?.('digital-team-template', dirty);
    return () => window.zeus?.setUnsavedChangeState?.('digital-team-template', false);
  }, [dirty]);

  useEffect(() => {
    /** 工作区导航被未保存草稿拦下时，把原因留在当前页面。 */
    const reportBlockedLeave = (): void => setError(zh ? '当前流程尚未保存，请先保存或点击“重开”放弃修改。' : 'Save the workflow or reopen it to discard changes before leaving.');
    window.addEventListener('zeus:digital-team-unsaved-leave', reportBlockedLeave);
    return () => window.removeEventListener('zeus:digital-team-unsaved-leave', reportBlockedLeave);
  }, [zh]);

  useEffect(() => {
    if (!api || view !== 'runs' || !selectedRun) return;
    /** 多个数字团队事件在一个短窗口内只刷新一次当前运行。 */
    let refreshTimer: number | null = null;
    /** 异步读取完成时页面可能已离开运行视图。 */
    let active = true;
    /** 订阅建立后立即拉取一次，补齐页面隐藏期间已经结束且不再发事件的运行。 */
    const refreshSelectedRun = (): void => {
      void api
        .loadDigitalTeamRun(selectedRun.run.id)
        .then((projection) => {
          if (!active) return;
          setSelectedRun(projection);
          setRuns((current) => current.map((item) => (item.id === projection.run.id ? projection.run : item)));
        })
        .catch((cause) => {
          if (active) setError(applicationError(cause, zh));
        });
    };
    const unsubscribe = api.subscribeEvents(
      (event) => {
        if (!event.type.includes('digital_team')) return;
        if (refreshTimer !== null) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(refreshSelectedRun, 180);
      },
      () => undefined,
    );
    refreshSelectedRun();
    return () => {
      active = false;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [api, selectedRun?.run.id, view, zh]);

  useEffect(() => {
    // 流程、项目或任务事实改变后必须重新确认代码执行范围。
    setConfirmCommittedBaseline(false);
  }, [draft, projectId, props.task?.id, props.task?.updatedAt]);

  /** 所有画布与表单修改共用脏状态。 */
  const changeDefinition = useCallback((definition: DigitalTeamWorkflowDefinition | ((current: DigitalTeamWorkflowDefinition) => DigitalTeamWorkflowDefinition)): void => {
    // 编辑时保留空格和空行，服务端保存边界再归一化，避免输入被打断。
    setDraft((current) => ({ ...current, definition: typeof definition === 'function' ? definition(current.definition) : definition }));
    setDirty(true);
    setStatus('');
  }, []);

  /** 添加节点后立即选中，检查器可以继续完成配置。 */
  const addNode = useCallback(
    (payload: DigitalTeamDragPayload, position?: { x: number; y: number }): void => {
      const resolvedPosition = position ?? nextNodePosition(draft.definition.nodes.length);
      const employee = memberCatalog.find((candidate) => candidate.id === payload.employeeId);
      const node = buildNode(payload, resolvedPosition, employee);
      changeDefinition({ ...draft.definition, nodes: [...draft.definition.nodes, node] });
      setSelectedNodeId(node.id);
    },
    [changeDefinition, draft.definition, memberCatalog],
  );

  /** 模板切换只允许在当前草稿已处理后进行。 */
  const selectTemplate = (templateId: string): void => {
    if (dirty) {
      setError(zh ? '当前流程尚未保存，请先保存或点击“重开”放弃修改。' : 'Save the current workflow or reopen it to discard changes.');
      return;
    }
    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template) return;
    setDraft(templateDraft(template));
    setDraftOpen(true);
    setCanvasGeneration((current) => current + 1);
    setSelectedNodeId(null);
    setError(null);
  };

  /** 新团队从空白草稿开始，员工、分工和依赖均由用户明确配置。 */
  const startNewTemplate = (): void => {
    if (dirty) {
      setError(zh ? '请先处理当前未保存修改。' : 'Resolve the current unsaved changes first.');
      return;
    }
    setDraft(emptyTemplateDraft());
    setDraftOpen(true);
    setCanvasGeneration((current) => current + 1);
    setSelectedNodeId(null);
    setDirty(false);
    setError(null);
  };

  /** 显式保存模板并以服务端回执作为新基线。 */
  const saveTemplate = async (): Promise<void> => {
    if (!api || !draft.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveDigitalTeamTemplate(
        {
          ...(draft.id ? { id: draft.id } : {}),
          expectedRevision: draft.revision,
          name: draft.name.trim(),
          description: draft.description.trim(),
          definition: {
            ...draft.definition,
            // 编辑时保留换行；保存边界统一去除空行，避免点击保存与失焦先后影响结果。
            nodes: draft.definition.nodes.map((node) =>
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
        },
        draft.projectId,
      );
      setTemplates((current) => [saved, ...current.filter((template) => template.id !== saved.id)]);
      setDraft(templateDraft(saved));
      setDirty(false);
      /** 普通保存也刷新项目流程引用，下一次应用使用服务端当前修订。 */
      if (projectId) setProjectWorkflow(await api.loadProjectDigitalTeamWorkflow(projectId));
      setStatus(zh ? '流程模板已保存。' : 'Workflow template saved.');
    } catch (cause) {
      setError(applicationError(cause, zh));
    } finally {
      setBusy(false);
    }
  };

  /** 项目流程复制当前编辑图并独立保存，不修改来源模板。 */
  const saveProjectWorkflow = async (): Promise<void> => {
    if (!api || !projectId || !draft.name.trim() || validationIssues.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      /** 修订取项目当前流程，复制来源的模板修订不能冒充项目修订。 */
      const saved = await api.saveProjectDigitalTeamWorkflow(projectId, { name: draft.name.trim(), description: draft.description.trim(), definition: draft.definition, expectedRevision: projectWorkflow?.revision ?? null });
      setProjectWorkflow(saved);
      setTemplates((current) => [saved, ...current.filter((template) => template.id !== saved.id)]);
      setDraft(templateDraft(saved));
      setDirty(false);
      setStatus(zh ? '已保存为当前项目流程，指派员工将从对应入口执行。' : 'Saved as the current project workflow.');
    } catch (cause) {
      setError(applicationError(cause, zh));
    } finally {
      setBusy(false);
    }
  };

  /** 复制立即创建新模板，避免复制操作只停留在临时画布。 */
  const copyTemplate = async (): Promise<void> => {
    if (!api || !selectedTemplate || dirty) return;
    setBusy(true);
    setError(null);
    try {
      const copy = await api.saveDigitalTeamTemplate(
        {
          expectedRevision: null,
          name: `${selectedTemplate.name}${zh ? ' 副本' : ' copy'}`,
          description: selectedTemplate.description,
          definition: selectedTemplate.definition,
        },
        selectedTemplate.projectId,
      );
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
      await api.deleteDigitalTeamTemplate(pendingDelete.id, pendingDelete.revision, pendingDelete.projectId);
      setPendingDelete(null);
      await refreshProject();
      setStatus(zh ? '模板已删除。' : 'Template deleted.');
    } catch (cause) {
      setError(applicationError(cause, zh));
    } finally {
      setBusy(false);
    }
  };

  /** 重开恢复最近一次服务端保存的完整画布与视口。 */
  const reopenTemplate = (): void => {
    if (!selectedTemplate) {
      setDraft(emptyTemplateDraft());
      setDraftOpen(false);
      setDirty(false);
    } else {
      setDraft(templateDraft(selectedTemplate));
      setDirty(false);
    }
    setSelectedNodeId(null);
    setCanvasGeneration((current) => current + 1);
    setError(null);
    setStatus(zh ? '已恢复最近保存版本。' : 'The last saved version was restored.');
  };

  /** 运行必须基于已保存且共享校验通过的精确模板修订。 */
  const createRun = async (): Promise<void> => {
    if (!api || !props.task || !projectId || !selectedTemplate || dirty || loading || busy || validationIssues.length > 0 || (usesCode && !confirmCommittedBaseline) || runs.some((run) => !terminalRunStatuses.has(run.status))) return;
    setBusy(true);
    setError(null);
    try {
      const projection = await api.createDigitalTeamRun(projectId, {
        taskId: props.task.id,
        expectedTaskUpdatedAt: props.task.updatedAt,
        templateId: selectedTemplate.id,
        templateRevision: selectedTemplate.revision,
        title: props.task.title,
        description: props.task.description ?? '',
        taskFacts: {
          title: props.task.title,
          description: props.task.description ?? '',
          source: 'digital_team',
          confirmCommittedBaseline: confirmCommittedBaseline,
          allowCodeChanges: usesCode && confirmCommittedBaseline,
          allowGitCommit: usesCode && confirmCommittedBaseline,
        },
      });
      setConfirmCommittedBaseline(false);
      setRuns((current) => [projection.run, ...current.filter((item) => item.id !== projection.run.id)]);
      setSelectedRun(projection);
      setSelectedNodeId(null);
      setView('runs');
      setStatus(zh ? '运行已创建，模板、角色、任务事实与基线已冻结。' : 'Run created with frozen workflow, roles, task facts, and baseline.');
    } catch (cause) {
      setError(applicationError(cause, zh));
    } finally {
      setBusy(false);
    }
  };

  /** 加载运行完整投影，运行图始终保持只读。 */
  const selectRun = async (runId: string): Promise<void> => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      setSelectedRun(await api.loadDigitalTeamRun(runId));
      setSelectedNodeId(null);
    } catch (cause) {
      setError(applicationError(cause, zh));
    } finally {
      setLoading(false);
    }
  };

  /** 暂停或继续只控制后续派发，不伪装在途工作已经停止。 */
  const controlRun = async (): Promise<void> => {
    if (!api || !selectedRunRecord) return;
    setBusy(true);
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
      setBusy(false);
    }
  };

  /** 提交人工批准、退回或返工，并使用当前尝试/运行修订。 */
  const submitRunDecision = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!api || !selectedRunRecord || !runDecision) return;
    setBusy(true);
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
    <section
      className="digital-team-workspace"
      aria-labelledby="digital-team-title"
      data-digital-team-dirty={dirty ? 'true' : undefined}
      data-compact-inspector={compactInspector ? 'true' : undefined}
      data-inspector-open={selectedNodeId ? 'true' : undefined}
    >
      <header className="digital-team-header">
        <div>
          {props.task ? (
            <p>
              {props.task.taskCode} · {props.task.title}
            </p>
          ) : null}
          <h1 id="digital-team-title">{zh ? '数字团队' : 'Digital teams'}</h1>
        </div>
        <div className="digital-team-header-actions">
          {props.onBackToTask ? (
            <Button size="compact" disabled={dirty || busy} onClick={props.onBackToTask}>
              返回任务
            </Button>
          ) : null}
          <div className="digital-team-view-switch" aria-label={zh ? '数字团队视图' : 'Digital team view'}>
            <button type="button" aria-pressed={view === 'editor'} onClick={() => setView('editor')}>
              {zh ? '流程设计' : 'Workflow'}
            </button>
            <button type="button" aria-pressed={view === 'runs'} onClick={() => setView('runs')}>
              {zh ? '运行记录' : 'Runs'}
            </button>
          </div>
          <ZeusSelect
            ariaLabel={zh ? '当前项目' : 'Current project'}
            disabled={Boolean(props.task) || busy || loading || dirty}
            value={projectId || noProjectValue}
            options={[
              ...(view === 'editor' ? [{ value: noProjectValue, label: zh ? '全局流程模板' : 'Global workflow templates' }] : []),
              ...props.projects.map((project) => ({ value: project.id, label: project.name, searchText: project.localPath })),
            ]}
            onChange={(value) => setProjectId(value === noProjectValue ? '' : value)}
            size="regular"
            searchable
          />
          {view === 'editor' && projectId ? (
            <Button size="compact" disabled={!api || loading || busy || dirty || !props.projects.some((project) => project.id !== projectId)} onClick={() => setProjectCopyOpen(true)}>
              <Copy aria-hidden="true" />
              {zh ? '从其他项目复制' : 'Copy from another project'}
            </Button>
          ) : null}
          <Button
            className="digital-team-refresh-button"
            size="compact"
            aria-label={zh ? '刷新数字团队数据' : 'Refresh digital team data'}
            title={zh ? '刷新' : 'Refresh'}
            disabled={loading || busy || dirty}
            onClick={() => void refreshProject()}
          >
            <Refresh aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className="digital-team-messages">
        {error || runError ? (
          <p className="digital-team-message is-error" role="alert">
            {error || runError}
          </p>
        ) : null}
        <p className="digital-team-message" role="status" aria-live="polite">
          {loading ? (zh ? '正在读取真实模板、角色和运行…' : 'Loading templates, roles, and runs…') : runError ? '' : status}
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
                ariaLabel={zh ? '选择团队模板' : 'Choose team template'}
                value={draft.id ?? '__new_template__'}
                options={[
                  ...(draft.id ? [] : [{ value: '__new_template__', label: zh ? '未保存的新团队' : 'Unsaved team' }]),
                  ...templates.map((template) => ({
                    value: template.id,
                    label: template.name,
                    description: template.projectId ? `${zh ? '项目团队' : 'Project team'} · ${zh ? '修订' : 'Revision'} ${template.revision}` : `${zh ? '全局团队' : 'Global team'} · ${zh ? '修订' : 'Revision'} ${template.revision}`,
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
                <Button size="compact" onClick={() => void copyTemplate()} disabled={!selectedTemplate || dirty || busy}>
                  <Copy aria-hidden="true" />
                  {zh ? '复制' : 'Copy'}
                </Button>
                <Button size="compact" onClick={() => selectedTemplate && setPendingDelete(selectedTemplate)} disabled={!selectedTemplate || dirty || busy}>
                  <Trash aria-hidden="true" />
                  {zh ? '删除' : 'Delete'}
                </Button>
              </div>
            </div>
            <div className="digital-team-template-toolbar">
              <label>
                <span>{zh ? '模板名称' : 'Template name'}</span>
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
              <label>
                <span>{zh ? '说明' : 'Description'}</span>
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
              <details>
                <summary>{zh ? '缺陷修复规则' : 'Defect repair'}</summary>
                <label>
                  <span>{zh ? '修复员工' : 'Repair employee'}</span>
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
              <details>
                <summary>{zh ? '项目经验规则' : 'Project experience'}</summary>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.definition.projectMemoryPolicy?.autoApplyStableExperience === true}
                    onChange={(event) => changeDefinition({ ...draft.definition, projectMemoryPolicy: { autoApplyStableExperience: event.currentTarget.checked } })}
                  />
                  <span>{zh ? '自动接纳本项目的稳定方法和领域经验；冲突仍待确认' : 'Apply stable project experience automatically; confirm conflicts'}</span>
                </label>
              </details>
              <div className="digital-team-save-actions">
                {projectId && draft.id !== projectWorkflow?.id ? (
                  <Button size="compact" disabled={busy || loading || !draft.name.trim() || validationIssues.length > 0} onClick={() => void saveProjectWorkflow()}>
                    {zh ? '设为项目流程' : 'Use for project'}
                  </Button>
                ) : null}
                <div className="digital-team-member-picker-anchor">
                  <Button size="compact" onClick={() => setMemberPickerOpen((open) => !open)} aria-expanded={memberPickerOpen}>
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
                <Button size="compact" onClick={reopenTemplate} disabled={!dirty || busy}>
                  {zh ? '重开' : 'Reopen'}
                </Button>
                <Button size="compact" variant="primary" busy={busy} disabled={!draft.name.trim() || (!dirty && Boolean(selectedTemplate))} onClick={() => void saveTemplate()}>
                  {zh ? '保存' : 'Save'}
                </Button>
                <Button
                  size="compact"
                  variant="primary"
                  disabled={
                    !selectedTemplate || dirty || validationIssues.length > 0 || loading || busy || (props.task ? (usesCode && !confirmCommittedBaseline) || runs.some((run) => !terminalRunStatuses.has(run.status)) : !props.onCreateTask)
                  }
                  onClick={() => {
                    if (props.task) void createRun();
                    else if (selectedTemplate) props.onCreateTask?.(selectedTemplate.id, selectedTemplate.projectId ?? projectId);
                  }}
                >
                  <Play aria-hidden="true" />
                  {props.task ? (zh ? '开始协作' : 'Start work') : zh ? '创建任务' : 'Create task'}
                </Button>
              </div>
            </div>
            {props.task && usesCode ? (
              <label className="digital-team-baseline-confirmation">
                <input type="checkbox" checked={confirmCommittedBaseline} disabled={busy || loading} onChange={(event) => setConfirmCommittedBaseline(event.currentTarget.checked)} />
                <span>
                  {zh
                    ? '使用当前已提交版本作为基线（不包含未提交修改），允许团队在隔离工作区修改代码并本地提交，不包含推送或发布。'
                    : 'Use the current committed revision (excluding uncommitted changes) and allow code changes and local commits in isolated workspaces, without pushing or publishing.'}
                </span>
              </label>
            ) : null}
            <WorkflowCanvas
              key={`editor-${canvasGeneration}`}
              definition={draft.definition}
              employeeNames={employeeNames}
              selectedNodeId={selectedNodeId}
              issues={validationIssues}
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
                  <small>{runStatusLabel(run)}</small>
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
                    {runStatusLabel(selectedRunRecord)} · {selectedRunRecord.controlState === 'paused' ? (zh ? '已暂停派发' : 'Dispatch paused') : zh ? '允许派发' : 'Dispatch enabled'}
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
        {projectCopyOpen && api ? (
          <ProjectWorkflowCopyDialog
            api={api}
            projects={props.projects}
            projectId={projectId}
            employees={employees}
            globalEmployees={employeeTemplates}
            statuses={projectStatuses}
            statusRoles={projectStatusRoles}
            zh={zh}
            onClose={() => setProjectCopyOpen(false)}
            onCopy={(copied) => {
              setDraft(copied);
              setDraftOpen(true);
              setDirty(true);
              setSelectedNodeId(null);
              setCanvasGeneration((current) => current + 1);
              setProjectCopyOpen(false);
              setError(null);
              setStatus(zh ? '已复制为当前项目草稿，请保存或设为项目流程。' : 'Copied to a draft for this project. Save it or use it as the project workflow.');
            }}
          />
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {pendingDelete ? (
          <FormDialog
            title={zh ? '删除流程模板' : 'Delete workflow template'}
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
                <small>
                  {employee.role} · {employee.model ?? '运行时选择模型'}
                </small>
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
        <h2>{node.type === 'employee' ? '数字员工配置' : '节点配置'}</h2>
        <span>{nodeTypeLabel(node.type)}</span>
      </div>
      {node.type === 'employee' ? (
        <EmployeeNodeFields
          key={`${node.id}:${employee?.id ?? 'missing'}:${employee?.revision ?? 0}`}
          node={node}
          employees={props.employees}
          employee={employee}
          statuses={props.statuses}
          hasStatusIssue={props.issues.some((issue) => issue.code.includes('STATUS'))}
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
      <Button variant="danger" onClick={() => props.onDelete(node.id)}>
        <Trash aria-hidden="true" />
        删除节点
      </Button>
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
    <section className="digital-team-connection-editor" aria-label="节点依赖">
      <h3>上游依赖</h3>
      {candidates.length > 0 ? (
        <div className="digital-team-connection-add">
          <ZeusSelect
            ariaLabel="选择上游节点"
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
            添加连线
          </Button>
        </div>
      ) : (
        <p>没有可添加的上游节点。</p>
      )}
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
              <Button size="compact" aria-label="删除上游连线" onClick={() => props.onDisconnect(edge.id)}>
                删除
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
  /** 状态校验失败时直接展开对应设置。 */ hasStatusIssue: boolean;
  onChange(node: DigitalTeamNode): void;
}) {
  /** 节点工作说明属于流程，员工默认职责仍由员工配置统一管理。 */
  const update = (data: Partial<DigitalTeamEmployeeNode['data']>): void => props.onChange({ ...props.node, data: { ...props.node.data, ...data } });
  /** 编辑时保留换行，正式保存再剔除空项。 */
  const lines = (value: string): string[] => value.split('\n');
  return (
    <>
      <label>
        <span>团队成员</span>
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
                executionMode: employee.permissionMode === 'read-only' ? 'read_only' : props.node.data.executionMode,
                settings: undefined,
              },
            });
          }}
          searchable
          size="regular"
        />
      </label>
      <label>
        <span>工作职责</span>
        <ZeusSelect
          size="regular"
          ariaLabel="工作职责"
          value={props.node.data.purpose}
          options={[
            { value: 'plan', label: '规划' },
            { value: 'work', label: '执行' },
            { value: 'verify', label: '验收' },
            { value: 'summary', label: '交付汇总' },
          ]}
          onChange={(value) => {
            /** 验收读取被测候选，规划与汇总保持只读。 */ const purpose = value as DigitalTeamEmployeeNode['data']['purpose'];
            update({ purpose, executionMode: purpose === 'verify' ? 'candidate_read_only' : purpose === 'work' ? props.node.data.executionMode : 'read_only' });
          }}
        />
      </label>
      {props.node.data.purpose === 'work' ? (
        <label>
          <span>执行方式</span>
          <ZeusSelect
            size="regular"
            ariaLabel="执行方式"
            value={props.node.data.executionMode}
            options={[
              { value: 'read_only', label: '只读工作' },
              { value: 'isolated_write', label: '隔离工作区修改' },
            ]}
            onChange={(value) => update({ executionMode: value as DigitalTeamEmployeeNode['data']['executionMode'] })}
          />
        </label>
      ) : null}
      <label>
        <span>工作要求</span>
        <textarea placeholder="默认按任务目标与员工职责执行" value={props.node.data.instructions} maxLength={12000} onChange={(event) => update({ instructions: event.currentTarget.value })} />
      </label>

      {props.node.data.purpose === 'verify' ? (
        <label>
          <span>必须通过的验收命令（每行一项）</span>
          <textarea
            autoFocus={!props.node.data.verificationCommands?.some((command) => command.trim())}
            aria-invalid={!props.node.data.verificationCommands?.some((command) => command.trim())}
            placeholder="例如 pnpm lint、pnpm typecheck（每行一条）"
            value={(props.node.data.verificationCommands ?? []).join('\n')}
            onChange={(event) => update({ verificationCommands: lines(event.currentTarget.value) })}
          />
          {!props.node.data.verificationCommands?.some((command) => command.trim()) ? <small className="digital-team-field-error">请填写需要实际执行的验收命令。</small> : null}
        </label>
      ) : null}
      <details className="digital-team-advanced-settings" open={props.hasStatusIssue}>
        <summary>完成标准与状态设置</summary>
        <label>
          <span>完成标准（每行一项）</span>
          <textarea value={(props.node.data.acceptanceCriteria ?? []).join('\n')} onChange={(event) => update({ acceptanceCriteria: lines(event.currentTarget.value) })} />
        </label>{' '}
        <label>
          <input type="checkbox" checked={props.node.data.assignmentEntry ?? false} onChange={(event) => update({ assignmentEntry: event.currentTarget.checked })} />
          <span>作为该员工的指派入口</span>
        </label>
        {(['triggerStatusId', 'startStatusId', 'completionStatusId'] as const).map((key, index) => (
          <label key={key}>
            <span>{['状态触发', '开始状态', '完成状态'][index]}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={['状态触发', '开始状态', '完成状态'][index]!}
              value={props.node.data[key] ?? ''}
              options={[{ value: '', label: '不配置' }, ...props.statuses.map((status) => ({ value: status.id, label: status.label ?? status.id }))]}
              onChange={(value) => update({ [key]: value || undefined })}
            />
          </label>
        ))}
      </details>
      {props.employee ? (
        <p className="digital-employee-boundary-note">{props.employee.description || `${props.employee.role} · ${props.employee.domain}`}</p>
      ) : (
        <p className="digital-team-message is-error" role="alert">
          当前节点绑定的数字员工模板不存在。
        </p>
      )}
    </>
  );
}

/** 有问题时展示简短原因和节点定位入口，不占用正常流程的空间。 */
function ValidationPanel(props: { issues: Array<{ code: string; message: string; nodeId?: string }>; onSelectNode(nodeId: string): void }) {
  if (!props.issues.length) return null;
  return (
    <section className="digital-team-validation has-issues" aria-live="polite">
      <strong>还需处理 {props.issues.length} 项</strong>
      <ul>
        {props.issues.map((issue, index) => (
          <li key={`${issue.code}_${issue.nodeId ?? ''}_${index}`}>
            <span>{issue.message}</span>
            {issue.nodeId ? (
              <button type="button" onClick={() => props.onSelectNode(issue.nodeId!)}>
                定位
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
  /** 在途工作阻止返工；未知结果通过明确确认弃用，保留历史后创建新尝试。 */
  const reworkAvailable =
    !terminalRunStatuses.has(props.run.status) &&
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
          <dd>{runStatusLabel(props.run)}</dd>
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

/** 跨项目复制只读来源目录，明确映射后返回独立草稿。 */
function ProjectWorkflowCopyDialog(props: {
  /** 已组合的员工、项目状态和流程客户端。 */
  api: DashboardClient & DigitalTeamApiClient;
  /** 可选的来源项目。 */
  projects: ProjectRecord[];
  /** 当前复制目标项目。 */
  projectId: string;
  /** 目标项目已有员工。 */
  employees: DigitalEmployeeRecord[];
  /** 已创建的全局员工身份。 */
  globalEmployees: DigitalEmployeeTemplateRecord[];
  /** 目标项目真实状态。 */
  statuses: TaskManagementStatusDefinition[];
  /** 目标项目的明确状态角色，用于自动匹配默认状态。 */
  statusRoles: TaskManagementStatusRoles;
  /** 当前界面语言。 */
  zh: boolean;
  /** 取消时只关闭本地弹窗。 */
  onClose(): void;
  /** 映射完成后由原有保存入口接纳草稿。 */
  onCopy(draft: TemplateDraft): void;
}) {
  /** 默认选择第一个其他项目，不改变当前目标。 */
  const [sourceProjectId, setSourceProjectId] = useState(props.projects.find((project) => project.id !== props.projectId)?.id ?? '');
  /** 来源项目可复制的流程，包含当前项目流程。 */
  const [sources, setSources] = useState<DigitalTeamWorkflowTemplateRecord[]>([]);
  /** 来源员工仅用于确认稳定身份，不按同名推断关系。 */
  const [sourceEmployees, setSourceEmployees] = useState<DigitalEmployeeRecord[]>([]);
  /** 来源状态用于给映射项提供原有名称。 */
  const [sourceStatuses, setSourceStatuses] = useState<TaskManagementStatusDefinition[]>([]);
  /** 来源状态角色提供稳定语义，不按显示名称猜测。 */
  const [sourceStatusRoles, setSourceStatusRoles] = useState(defaultTaskManagementStatusConfig.roles);
  /** 当前选择的来源流程身份。 */
  const [sourceId, setSourceId] = useState('');
  /** 显式员工映射按来源身份保存。 */
  const [employeeMapping, setEmployeeMapping] = useState<Record<string, string>>({});
  /** 显式状态映射按来源状态身份保存。 */
  const [statusMapping, setStatusMapping] = useState<Record<string, string>>({});
  /** 来源加载中不能提交旧选择。 */
  const [loading, setLoading] = useState(true);
  /** 读取失败保留在弹窗中。 */
  const [error, setError] = useState<string | null>(null);
  /** 当前来源记录只从本次成功加载的目录读取。 */
  const source = sources.find((template) => template.id === sourceId);
  /** 同一个员工多节点引用只要求映射一次，修复员工也在范围内。 */
  const employeeIds = [
    ...new Set([
      ...(source?.definition.nodes.flatMap((node) => (node.type === 'employee' ? [node.data.employeeId, ...(node.data.settings?.delegation?.employeeIds ?? [])] : [])) ?? []),
      ...(source?.definition.repairEmployeeId ? [source.definition.repairEmployeeId] : []),
    ]),
  ];
  /** 状态映射同时覆盖触发、开始和完成。 */
  const statusIds = [
    ...new Set(source?.definition.nodes.flatMap((node) => (node.type === 'employee' ? [node.data.triggerStatusId, node.data.startStatusId, node.data.completionStatusId].filter((id): id is string => Boolean(id)) : [])) ?? []),
  ];
  /** 全局身份只从已有关系解析，旧项目员工必须手工选目标项目员工。 */
  const resolveEmployee = (id: string): string | null => {
    /** 已创建的全局员工可以直接作为流程引用。 */
    const globalId = props.globalEmployees.some((employee) => employee.id === id) ? id : (sourceEmployees.find((employee) => employee.id === id)?.globalEmployeeId ?? sourceEmployees.find((employee) => employee.id === id)?.templateId);
    return globalId && props.globalEmployees.some((employee) => employee.id === globalId) ? globalId : null;
  };
  /** 新绑定由保存边界建立；已有目标绑定保留其项目补充配置。 */
  const targetEmployee = (id: string): string => {
    /** 用户已明确重选的目标优先。 */
    if (id in employeeMapping) return employeeMapping[id]!;
    /** 只使用确认的全局身份建立对应关系。 */
    const globalId = resolveEmployee(id);
    return globalId ? (props.employees.find((employee) => employee.enabled && employee.globalEmployeeId === globalId)?.id ?? globalId) : '';
  };
  /** 同一状态身份存在时可以保留，否则必须明确选择目标状态。 */
  const targetStatus = (id: string): string => {
    if (id in statusMapping) return statusMapping[id]!;
    if (props.statuses.some((status) => status.id === id)) return id;
    /** 一个来源状态兼任多个角色时，只有目标唯一一致才自动映射。 */
    const targets = [
      ...new Set(
        (Object.keys(sourceStatusRoles) as Array<keyof TaskManagementStatusRoles>)
          .filter((role) => sourceStatusRoles[role] === id)
          .map((role) => props.statusRoles[role])
          .filter((target) => props.statuses.some((status) => status.id === target)),
      ),
    ];
    return targets.length === 1 ? targets[0]! : '';
  };
  /** 已经明确匹配的项只作摘要，缺失项保留就地必选控件。 */
  const missingEmployees = employeeIds.filter((id) => !targetEmployee(id));
  /** 不按同名猜测项目自定义状态。 */
  const missingStatuses = statusIds.filter((id) => !targetStatus(id));

  useEffect(() => {
    /** 项目切换后的迟到响应不能覆盖新来源目录。 */
    let active = true;
    setLoading(true);
    setError(null);
    setSources([]);
    setSourceId('');
    setEmployeeMapping({});
    setStatusMapping({});
    void Promise.all([props.api.loadDigitalTeamTemplates(sourceProjectId), props.api.loadProjectDigitalTeamWorkflow(sourceProjectId), props.api.loadProjectDigitalEmployees(sourceProjectId), props.api.loadAppShellSettings()])
      .then(([templates, workflow, employees, settings]) => {
        if (!active) return;
        /** 项目当前流程优先展示，重复模板只保留一个身份。 */
        const available = [...new Map([...(workflow ? [workflow] : []), ...templates.filter((template) => template.projectId === sourceProjectId)].map((template) => [template.id, template])).values()];
        setSources(available);
        setSourceId(available[0]?.id ?? '');
        setSourceEmployees(employees);
        /** 状态目录和角色一起归一化，与项目保存边界一致。 */
        const statusConfig = normalizeTaskManagementStatusConfig(settings.taskManagementStatusByProject?.[sourceProjectId] ?? settings.taskManagementStatusTemplate);
        setSourceStatuses(statusConfig.statuses);
        setSourceStatusRoles(statusConfig.roles);
      })
      .catch((cause: unknown) => {
        if (active) setError(applicationError(cause, props.zh));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.api, props.zh, sourceProjectId]);

  /** 只复制明确配置，源运行、授权、成果和经验不会进入草稿。 */
  const copyDraft = (event: FormEvent): void => {
    event.preventDefault();
    if (!source || loading || employeeIds.some((id) => !targetEmployee(id)) || statusIds.some((id) => !targetStatus(id))) return;
    /** 深复制之后修改映射，来源模板对象保持不变。 */
    const definition = structuredClone(source.definition);
    for (const node of definition.nodes) {
      if (node.type !== 'employee') continue;
      node.data.employeeId = targetEmployee(node.data.employeeId);
      /** 规划分工授权也使用目标员工身份，避免保留来源项目引用。 */
      if (node.data.settings?.delegation) node.data.settings.delegation.employeeIds = [...new Set(node.data.settings.delegation.employeeIds.map(targetEmployee))];
      for (const key of ['triggerStatusId', 'startStatusId', 'completionStatusId'] as const) if (node.data[key]) node.data[key] = targetStatus(node.data[key]!);
    }
    if (definition.repairEmployeeId) definition.repairEmployeeId = targetEmployee(definition.repairEmployeeId);
    props.onCopy({ id: null, revision: null, projectId: props.projectId, name: `${source.name}${props.zh ? ' 副本' : ' copy'}`, description: source.description, definition });
  };

  /** 员工映射保留全文可访问名称，选项只显示实际员工。 */
  const renderEmployeeMapping = (id: string) => (
    <label key={id}>
      <span>
        {props.zh ? '员工' : 'Employee'} · {sourceEmployees.find((employee) => employee.id === id)?.name ?? props.globalEmployees.find((employee) => employee.id === id)?.name ?? id}
      </span>
      <ZeusSelect
        size="regular"
        ariaLabel={`${props.zh ? '映射员工' : 'Map employee'} ${id}`}
        value={targetEmployee(id)}
        options={[
          { value: '', label: props.zh ? '选择目标项目员工' : 'Select target employee' },
          ...props.employees.filter((employee) => employee.enabled).map((employee) => ({ value: employee.id, label: employee.name })),
          ...(resolveEmployee(id)
            ? props.globalEmployees.filter((employee) => employee.id === resolveEmployee(id)).map((employee) => ({ value: employee.id, label: `${employee.name} · ${props.zh ? '保存时绑定当前项目' : 'Bind to this project when saved'}` }))
            : []),
        ]}
        onChange={(value) => setEmployeeMapping((current) => ({ ...current, [id]: value }))}
      />
    </label>
  );
  /** 缺失状态直接补选；已匹配状态可按需调整。 */
  const renderStatusMapping = (id: string) => (
    <label key={id}>
      <span>
        {props.zh ? '状态' : 'Status'} · {sourceStatuses.find((status) => status.id === id)?.label ?? id}
      </span>
      <ZeusSelect
        size="regular"
        ariaLabel={`${props.zh ? '映射状态' : 'Map status'} ${id}`}
        value={targetStatus(id)}
        options={[{ value: '', label: props.zh ? '选择目标项目状态' : 'Select target status' }, ...props.statuses.map((status) => ({ value: status.id, label: status.label ?? status.id }))]}
        onChange={(value) => setStatusMapping((current) => ({ ...current, [id]: value }))}
      />
    </label>
  );

  return (
    <FormDialog
      className="digital-team-copy-dialog"
      title={props.zh ? '从其他项目复制流程' : 'Copy workflow from another project'}
      description={props.zh ? '复制到当前项目，保存后独立维护。' : 'Map employees and statuses to create a draft for this project.'}
      zh={props.zh}
      busy={false}
      submitLabel={props.zh ? '复制为草稿' : 'Copy to draft'}
      submitDisabled={loading || !source || employeeIds.some((id) => !targetEmployee(id)) || statusIds.some((id) => !targetStatus(id))}
      onClose={props.onClose}
      onSubmit={copyDraft}
    >
      <label>
        <span>{props.zh ? '来源项目' : 'Source project'}</span>
        <ZeusSelect
          size="regular"
          ariaLabel={props.zh ? '来源项目' : 'Source project'}
          value={sourceProjectId}
          options={props.projects.filter((project) => project.id !== props.projectId).map((project) => ({ value: project.id, label: project.name }))}
          onChange={setSourceProjectId}
        />
      </label>
      <label>
        <span>{props.zh ? '来源流程' : 'Source workflow'}</span>
        <ZeusSelect
          size="regular"
          ariaLabel={props.zh ? '来源流程' : 'Source workflow'}
          disabled={loading}
          value={sourceId}
          options={sources.map((template) => ({ value: template.id, label: template.name }))}
          onChange={(id) => {
            setSourceId(id);
            setEmployeeMapping({});
            setStatusMapping({});
          }}
        />
      </label>
      {loading ? <p role="status">{props.zh ? '正在读取来源流程…' : 'Loading source workflows…'}</p> : !sources.length ? <p role="status">{props.zh ? '来源项目没有可复制的流程。' : 'This project has no workflows to copy.'}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!loading && source ? (
        <>
          <p className="digital-team-copy-summary">
            {props.zh
              ? `已匹配 ${employeeIds.length - missingEmployees.length} 位员工、${statusIds.length - missingStatuses.length} 个状态。`
              : `Matched ${employeeIds.length - missingEmployees.length} employees and ${statusIds.length - missingStatuses.length} statuses.`}
          </p>
          {missingEmployees.length + missingStatuses.length > 0 ? <p role="status">{props.zh ? '补齐以下映射即可复制。' : 'Complete these mappings to copy.'}</p> : null}
          {missingEmployees.map(renderEmployeeMapping)}
          {missingStatuses.map(renderStatusMapping)}
          <details className="digital-team-advanced-settings">
            <summary>{props.zh ? '调整已匹配项' : 'Adjust matched mappings'}</summary>
            {employeeIds.filter((id) => targetEmployee(id)).map(renderEmployeeMapping)}
            {statusIds.filter((id) => targetStatus(id)).map(renderStatusMapping)}
          </details>
        </>
      ) : null}
    </FormDialog>
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
  return { id: null, revision: null, projectId: null, name: '', description: '', definition: { schemaGeneration: digitalTeamWorkflowSchemaGeneration, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0.8 } } };
}

/** 已保存模板复制为可编辑草稿，不混入运行状态。 */
function templateDraft(template: DigitalTeamWorkflowTemplateRecord): TemplateDraft {
  return { id: template.id, revision: template.revision, projectId: template.projectId, name: template.name, description: template.description, definition: structuredClone(template.definition) };
}

/** 添加按钮使用可预期的阶梯位置，拖放仍使用准确视口坐标。 */
function nextNodePosition(index: number): { x: number; y: number } {
  return { x: 80 + (index % 4) * 240, y: 80 + Math.floor(index / 4) * 150 };
}

/** 构造新的员工分工节点，不自动猜测依赖关系。 */
function buildNode(payload: DigitalTeamDragPayload, position: { x: number; y: number }, employee: DigitalTeamMemberRecord | undefined): DigitalTeamNode {
  const id = `node_${crypto.randomUUID()}`;
  return {
    id,
    type: 'employee',
    position,
    data: {
      title: employee?.name ?? '员工分工',
      employeeId: payload.employeeId,
      purpose: 'work',
      executionMode: 'read_only',
      instructions: '',
      acceptanceCriteria: [],
      expectedDeliverables: [],
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

/** 节点确定失败时优先展示人工下一步，避免仍显示原执行阶段。 */
function runStatusLabel(run: DigitalTeamWorkflowRunRecord): string {
  if (run.error?.code === 'ZEUS_DIGITAL_TEAM_NODE_FAILED') return '等待返工';
  return runStatusLabels[run.status] ?? run.status;
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
