import {
  digitalTeamExecutionDefinition,
  digitalTeamWorkflowSchemaGeneration,
  validateDigitalTeamWorkflowDefinition,
  normalizeDigitalTeamWorkflowDefinition,
  type CommandDefinition,
  type DigitalTeamEmployeeNode,
  type DigitalTeamNode,
  type DigitalTeamNodeAttemptRecord,
  type DigitalTeamNodeType,
  type DigitalTeamWorkflowDefinition,
  type DigitalTeamWorkflowRunRecord,
  type DigitalTeamWorkflowTemplateRecord,
  type DigitalTeamWorkflowValidationIssue,
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
import { DigitalEmployeeEditor } from '../digital-employees/ProjectDigitalEmployeesPanel.js';
import type { DigitalEmployeeCapabilitiesSnapshot, DigitalEmployeeRecord } from '../digital-employees/digitalEmployeeContracts.js';
import { employeeDraft, employeeInput, type DigitalEmployeeDraft } from '../digital-employees/digitalEmployeeUiSupport.js';
import type { ProjectRecord } from '../projects/projectContracts.js';
import { type DigitalTeamApiClient, type DigitalTeamRunProjection, type DigitalTeamTemplateSaveInput } from './digitalTeamApiClient.js';
import { digitalTeamDragMime, isConnectionAllowed, WorkflowCanvas, type DigitalTeamCanvasRuntimeState, type DigitalTeamDragPayload } from './WorkflowCanvas.js';
import './digitalTeams.css';

/** 数字团队页面支持的两个真实数据视图。 */
type DigitalTeamView = 'editor' | 'runs';

/** 任务详情下拉进入数字团队时携带的明确目标。 */
export type DigitalTeamEntrySelection = { kind: 'template'; templateId: string } | { kind: 'run'; runId: string } | { kind: 'manage' };

/** 本地模板草稿只保留服务端允许保存的字段。 */
type TemplateDraft = Pick<DigitalTeamTemplateSaveInput, 'name' | 'description' | 'definition'> & { id: string | null; revision: number | null };

/** 新运行表单不会直接修改任务或模板，并要求明确选择已提交基线。 */
type RunDraft = { title: string; description: string; confirmCommittedBaseline: boolean };

/** 人工决定弹窗统一覆盖批准、退回和返工。 */
type RunDecision = { kind: 'approve' | 'reject' | 'rework'; nodeId: string; attempt: number };

/** 无项目时使用的选择值。 */
const noProjectValue = '__no_digital_team_project__';

/** 扣除项目侧栏后统一切换双列与详情抽屉，样式直接复用此状态。 */
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
  /** 返回原任务详情。 */
  onBackToTask?(): void;
  /** 打开当前项目的角色权限配置。 */
  onManageEmployees?(projectId: string): void;
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
  /** 当前项目的已保存模板。 */
  const [templates, setTemplates] = useState<DigitalTeamWorkflowTemplateRecord[]>([]);
  /** 当前项目的真实员工角色。 */
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  /** 数字员工配置复用项目已启用的部署命令。 */
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  /** 员工和团队共用实时模型与技能目录。 */
  const [capabilities, setCapabilities] = useState<DigitalEmployeeCapabilitiesSnapshot | null>(null);
  /** 当前项目的运行历史。 */
  const [runs, setRuns] = useState<DigitalTeamWorkflowRunRecord[]>([]);
  /** 当前显式编辑的模板草稿。 */
  const [draft, setDraft] = useState<TemplateDraft>(() => emptyTemplateDraft());
  /** 草稿与最近保存版本不同才阻止内部切换。 */
  const [dirty, setDirty] = useState(false);
  /** 检查器选中的节点。 */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  /** 已保存模板、项目或重开变化时重建画布以恢复持久视口。 */
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  /** 当前运行图。 */
  const [selectedRun, setSelectedRun] = useState<DigitalTeamRunProjection | null>(null);
  /** 页面读取状态。 */
  const [loading, setLoading] = useState(Boolean(api && projectId));
  /** 单个写操作期间禁止重复提交。 */
  const [busy, setBusy] = useState(false);
  /** 可见错误不以控制台或模拟成功替代。 */
  const [error, setError] = useState<string | null>(api ? null : zh ? '当前本地服务尚未提供数字团队接口。' : 'The local service does not provide the digital team API.');
  /** 页面级成功与等待状态通过 live region 告知用户。 */
  const [status, setStatus] = useState<string>('');
  /** 删除必须二次确认。 */
  const [pendingDelete, setPendingDelete] = useState<DigitalTeamWorkflowTemplateRecord | null>(null);
  /** 创建运行前收集真实任务标题和说明。 */
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  /** 新运行表单草稿。 */
  const [runDraft, setRunDraft] = useState<RunDraft>({ title: '', description: '', confirmCommittedBaseline: false });
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

  /** 员工名称索引供画布卡片与检查器复用。 */
  const employeeNames = useMemo(() => new Map(employees.map((employee) => [employee.id, employee.name])), [employees]);
  /** 角色库只允许新增启用中的员工，已停用员工仍保留在既有节点中供重新配置。 */
  const enabledEmployees = useMemo(() => employees.filter((employee) => employee.enabled), [employees]);
  /** 共享图校验与当前项目角色核对共同决定模板能否启动。 */
  const validationIssues = useMemo(() => {
    /** 结构问题先由 shared 权威校验器生成。 */
    const issues: DigitalTeamWorkflowValidationIssue[] = validateDigitalTeamWorkflowDefinition(draft.definition);
    /** 当前角色集合只接受本项目仍启用的员工身份。 */
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
    for (const node of draft.definition.nodes) {
      if (node.type !== 'employee') continue;
      /** 运行要求当前角色既存在又已经完成 Agent 配置。 */
      const employee = employeeById.get(node.data.employeeId);
      if (!employee?.enabled) {
        issues.push({ code: 'ZEUS_DIGITAL_TEAM_EMPLOYEE_UNAVAILABLE', message: '员工节点必须绑定当前项目中已启用的真实数字员工。', nodeId: node.id });
      } else if (employee.entrypoint?.kind !== 'agent' || employee.entrypointMigrationState !== 'ready') {
        issues.push({ code: 'ZEUS_DIGITAL_TEAM_EMPLOYEE_NOT_READY', message: '员工节点绑定的角色尚未完成 Agent 配置，不能启动运行。', nodeId: node.id });
      } else if (node.data.executionMode === 'isolated_write' && employee.entrypoint.authorityPolicy.permissionMode === 'read-only') {
        issues.push({ code: 'ZEUS_DIGITAL_TEAM_EMPLOYEE_AUTHORITY_INCOMPATIBLE', message: '请在数字员工配置中允许执行代码工作。', nodeId: node.id });
      }
    }
    return issues;
  }, [draft.definition, employees]);
  /** 当前选中模板的服务端记录。 */
  const selectedTemplate = templates.find((template) => template.id === draft.id) ?? null;
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

  /** 并行读取模板、员工和运行，避免串行等待。 */
  const refreshProject = useCallback(
    async (preferredTemplateId?: string | null, preferredRunId?: string | null, entrySelection?: DigitalTeamEntrySelection): Promise<void> => {
      if (!api || !projectId) return;
      if (dirty) {
        setError(zh ? '当前流程尚未保存，请先保存或点击“重开”放弃修改。' : 'Save or reopen the current workflow before refreshing.');
        return;
      }
      const revision = ++loadRevisionRef.current;
      setLoading(true);
      setError(null);
      try {
        const [nextTemplates, nextEmployees, nextRuns, nextCapabilities, nextCommands] = await Promise.all([
          api.loadDigitalTeamTemplates(projectId),
          api.loadProjectDigitalEmployees(projectId),
          api.loadDigitalTeamRuns(projectId, props.task?.id),
          api.loadDigitalEmployeeCapabilities(),
          api.loadProjectCommands(projectId),
        ]);
        if (revision !== loadRevisionRef.current) return;
        setTemplates(nextTemplates);
        setCapabilities(nextCapabilities);
        setEmployees(nextEmployees);
        setCommands(nextCommands.filter((command) => command.enabled));
        /** 任务入口只展示当前任务运行；团队入口仍展示项目记录。 */
        const visibleRuns = props.task ? nextRuns.filter((run) => run.taskId === props.task!.id) : nextRuns;
        setRuns(visibleRuns);
        const nextTemplate = nextTemplates.find((template) => template.id === preferredTemplateId) ?? nextTemplates.find((template) => template.id === draft.id) ?? nextTemplates[0];
        setDraft(nextTemplate ? templateDraft(nextTemplate) : standardTemplateDraft(nextEmployees.filter((employee) => employee.enabled)));
        setCanvasGeneration((current) => current + 1);
        setDirty(false);
        const nextRun = visibleRuns.find((run) => run.id === preferredRunId) ?? visibleRuns.find((run) => run.id === selectedRun?.run.id) ?? (props.task ? visibleRuns[0] : null);
        if (entrySelection?.kind === 'template' && nextTemplate?.id === entrySelection.templateId && nextTemplate.ready && !visibleRuns.some((run) => !terminalRunStatuses.has(run.status))) {
          setView('editor');
          setRunDraft({ title: props.task?.title ?? nextTemplate.name, description: props.task?.description ?? nextTemplate.description, confirmCommittedBaseline: false });
          setRunDialogOpen(true);
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

  /** 所有画布与表单修改共用脏状态。 */
  const changeDefinition = useCallback((definition: DigitalTeamWorkflowDefinition | ((current: DigitalTeamWorkflowDefinition) => DigitalTeamWorkflowDefinition)): void => {
    setDraft((current) => ({ ...current, definition: normalizeDigitalTeamWorkflowDefinition(typeof definition === 'function' ? definition(current.definition) : definition) }));
    setDirty(true);
    setStatus('');
  }, []);

  /** 添加节点后立即选中，检查器可以继续完成配置。 */
  const addNode = useCallback(
    (payload: DigitalTeamDragPayload, position?: { x: number; y: number }): void => {
      const resolvedPosition = position ?? nextNodePosition(draft.definition.nodes.length);
      const employee = employees.find((candidate) => candidate.id === payload.employeeId);
      const node = buildNode(payload, resolvedPosition, employee);
      changeDefinition({ ...draft.definition, nodes: [...draft.definition.nodes, node] });
      setSelectedNodeId(node.id);
    },
    [changeDefinition, draft.definition, employees],
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
    setCanvasGeneration((current) => current + 1);
    setSelectedNodeId(null);
    setError(null);
  };

  /** 新模板从一个真实员工开始，后续员工和依赖均由用户按需添加。 */
  const startNewTemplate = (): void => {
    if (dirty) {
      setError(zh ? '请先处理当前未保存修改。' : 'Resolve the current unsaved changes first.');
      return;
    }
    setDraft(standardTemplateDraft(enabledEmployees));
    setCanvasGeneration((current) => current + 1);
    setSelectedNodeId(null);
    setDirty(true);
    setError(null);
  };

  /** 显式保存模板并以服务端回执作为新基线。 */
  const saveTemplate = async (): Promise<void> => {
    if (!api || !projectId || !draft.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveDigitalTeamTemplate(projectId, {
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
      });
      setTemplates((current) => [saved, ...current.filter((template) => template.id !== saved.id)]);
      setDraft(templateDraft(saved));
      setDirty(false);
      setStatus(zh ? '流程模板已保存。' : 'Workflow template saved.');
    } catch (cause) {
      setError(applicationError(cause, zh));
    } finally {
      setBusy(false);
    }
  };

  /** 复制立即创建新模板，避免复制操作只停留在临时画布。 */
  const copyTemplate = async (): Promise<void> => {
    if (!api || !projectId || !selectedTemplate || dirty) return;
    setBusy(true);
    setError(null);
    try {
      const copy = await api.saveDigitalTeamTemplate(projectId, {
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
    if (!api || !projectId || !pendingDelete) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteDigitalTeamTemplate(projectId, pendingDelete.id, pendingDelete.revision);
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
      setDraft(standardTemplateDraft(enabledEmployees));
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
  const createRun = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!api || !projectId || !selectedTemplate || dirty || validationIssues.length > 0 || !runDraft.title.trim() || (usesCode && !runDraft.confirmCommittedBaseline)) return;
    setBusy(true);
    setError(null);
    try {
      const projection = await api.createDigitalTeamRun(projectId, {
        ...(props.task ? { taskId: props.task.id, expectedTaskUpdatedAt: props.task.updatedAt } : {}),
        templateId: selectedTemplate.id,
        templateRevision: selectedTemplate.revision,
        title: runDraft.title.trim(),
        description: runDraft.description.trim(),
        taskFacts: {
          title: runDraft.title.trim(),
          description: runDraft.description.trim(),
          source: 'digital_team',
          confirmCommittedBaseline: runDraft.confirmCommittedBaseline,
          allowCodeChanges: usesCode && runDraft.confirmCommittedBaseline,
          allowGitCommit: usesCode && runDraft.confirmCommittedBaseline,
        },
      });
      setRunDialogOpen(false);
      setRunDraft({ title: '', description: '', confirmCommittedBaseline: false });
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
        employees={employees}
        employeeNames={employeeNames}
        commands={commands}
        client={props.client}
        capabilities={capabilities}
        projectId={projectId}
        language={props.language}
        issues={validationIssues.filter((issue) => issue.nodeId === selectedNode?.id)}
        onChange={(node) => replaceNode(draft.definition, node, changeDefinition)}
        onConnect={(source, target) => changeDefinition({ ...draft.definition, edges: [...draft.definition.edges, { id: `edge_${crypto.randomUUID()}`, source, target }] })}
        onDisconnect={(edgeId) => changeDefinition({ ...draft.definition, edges: draft.definition.edges.filter((edge) => edge.id !== edgeId) })}
        onDelete={(nodeId) => removeNode(draft.definition, nodeId, changeDefinition, setSelectedNodeId)}
        onEmployeeSaved={(employee) => {
          setEmployees((current) => current.map((candidate) => (candidate.id === employee.id ? employee : candidate)));
          setStatus(zh ? `数字员工“${employee.name}”已保存。` : `Digital employee “${employee.name}” saved.`);
        }}
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

  if (props.projects.length === 0) {
    return (
      <section className="digital-team-empty" role="status">
        <h1>{zh ? '数字团队' : 'Digital teams'}</h1>
        <p>{zh ? '请先创建或打开一个真实项目，再配置团队流程。' : 'Create or open a project before configuring a team workflow.'}</p>
      </section>
    );
  }

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
            ariaLabel={zh ? '选择数字团队项目' : 'Choose digital team project'}
            disabled={Boolean(props.task)}
            value={projectId || noProjectValue}
            options={props.projects.map((project) => ({ value: project.id, label: project.name, searchText: project.localPath }))}
            onChange={(value) => {
              if (dirty) {
                setError(zh ? '当前流程尚未保存，不能切换项目。' : 'Save or reopen the current workflow before switching projects.');
                return;
              }
              setProjectId(value);
            }}
            size="regular"
            searchable
          />
          <Button size="compact" aria-label={zh ? '刷新数字团队数据' : 'Refresh digital team data'} title={zh ? '刷新' : 'Refresh'} disabled={loading || busy || dirty} onClick={() => void refreshProject()}>
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
      {view === 'editor' ? (
        <div className="digital-team-editor-layout" inert={busy || loading}>
          <aside className="digital-team-library" aria-label={zh ? '模板与角色库' : 'Templates and role library'}>
            <section>
              <div className="digital-team-section-heading">
                <h2>{zh ? '流程模板' : 'Templates'}</h2>
                <span>{templates.length}</span>
              </div>
              <ZeusSelect
                ariaLabel={zh ? '选择流程模板' : 'Choose workflow template'}
                value={draft.id ?? '__new_template__'}
                options={[
                  ...(draft.id ? [] : [{ value: '__new_template__', label: zh ? '未保存的新模板' : 'Unsaved template' }]),
                  ...templates.map((template) => ({ value: template.id, label: template.name, description: `${zh ? '修订' : 'Revision'} ${template.revision}` })),
                ]}
                onChange={selectTemplate}
                size="regular"
                searchable
              />
              <div className="digital-team-template-actions">
                <Button size="compact" onClick={startNewTemplate}>
                  <Plus aria-hidden="true" />
                  {zh ? '新建' : 'New'}
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
            </section>
            {props.onManageEmployees ? (
              <Button size="compact" disabled={dirty || busy} title={dirty ? '请先保存流程，再管理角色权限' : undefined} onClick={() => props.onManageEmployees!(projectId)}>
                管理角色与权限
              </Button>
            ) : null}
            <RolePalette employees={enabledEmployees} onAdd={(payload) => addNode(payload)} />
          </aside>

          <main className="digital-team-canvas-column">
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
              <div className="digital-team-save-actions">
                <Button size="compact" onClick={reopenTemplate} disabled={!dirty || busy}>
                  {zh ? '重开' : 'Reopen'}
                </Button>
                <Button size="compact" variant="primary" busy={busy} disabled={!draft.name.trim() || (!dirty && Boolean(selectedTemplate))} onClick={() => void saveTemplate()}>
                  {zh ? '保存' : 'Save'}
                </Button>
                <Button
                  size="compact"
                  variant="primary"
                  disabled={!selectedTemplate || dirty || validationIssues.length > 0 || busy || runs.some((run) => props.task && !terminalRunStatuses.has(run.status))}
                  onClick={() => {
                    setRunDraft({ title: props.task?.title ?? draft.name, description: props.task?.description ?? draft.description, confirmCommittedBaseline: false });
                    setRunDialogOpen(true);
                  }}
                >
                  <Play aria-hidden="true" />
                  {props.task ? (zh ? '用于当前任务' : 'Use for this task') : zh ? '创建运行' : 'Create run'}
                </Button>
              </div>
            </div>
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
        {runDialogOpen ? (
          <FormDialog
            title={zh ? '创建数字团队运行' : 'Create digital team run'}
            description={
              zh
                ? props.task
                  ? '使用所选流程执行当前任务，保留任务身份和说明。开始前固定本次分工、员工配置和交付要求。'
                  : '开始前固定当前安排、员工配置和交付要求。'
                : 'This freezes the template revision, role settings, task facts, and project baseline.'
            }
            zh={zh}
            busy={busy}
            submitLabel={zh ? '开始协作' : 'Start work'}
            submitDisabled={!runDraft.title.trim() || (usesCode && !runDraft.confirmCommittedBaseline)}
            onClose={() => setRunDialogOpen(false)}
            onSubmit={(event) => void createRun(event)}
          >
            <p>
              本次参与员工：
              {[...new Set(draft.definition.nodes.flatMap((node) => (node.type === 'employee' ? [node.data.employeeId, ...(node.data.purpose === 'plan' ? (node.data.settings?.delegation?.employeeIds ?? []) : [])] : [])))]
                .map((id) => employeeNames.get(id) ?? '待配置员工')
                .join('、')}
            </p>
            <label>
              <span>{zh ? '任务标题' : 'Task title'}</span>
              <input
                required
                readOnly={Boolean(props.task)}
                maxLength={160}
                value={runDraft.title}
                onChange={(event) => {
                  const title = event.currentTarget.value;
                  setRunDraft((current) => ({ ...current, title }));
                }}
              />
            </label>
            <label>
              <span>{zh ? '需求与验收事实' : 'Requirements and acceptance facts'}</span>
              <textarea
                required={!props.task}
                readOnly={Boolean(props.task)}
                rows={7}
                maxLength={20000}
                value={runDraft.description}
                onChange={(event) => {
                  const description = event.currentTarget.value;
                  setRunDraft((current) => ({ ...current, description }));
                }}
              />
            </label>
            {usesCode ? (
              <label className="digital-team-baseline-confirmation">
                <input
                  type="checkbox"
                  checked={runDraft.confirmCommittedBaseline}
                  onChange={(event) => {
                    const confirmCommittedBaseline = event.currentTarget.checked;
                    setRunDraft((current) => ({ ...current, confirmCommittedBaseline }));
                  }}
                />
                <span>
                  {zh
                    ? '我确认本次基线只包含当前已提交版本；工作目录中的未提交修改不会进入数字团队运行；允许本流程在隔离工作区修改代码并本地提交，不包含推送或发布。'
                    : 'I confirm this run uses the current committed revision only; uncommitted working-tree changes are excluded.'}
                </span>
              </label>
            ) : null}
          </FormDialog>
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

/** 左侧角色库只展示当前项目启用的真实员工，并提供拖拽的按钮替代。 */
function RolePalette(props: { employees: DigitalEmployeeRecord[]; onAdd(payload: DigitalTeamDragPayload): void }) {
  return (
    <section>
      <div className="digital-team-section-heading">
        <h2>数字员工</h2>
        <span>{props.employees.length}</span>
      </div>
      <p className="digital-team-help">拖入画布，或使用“添加”按钮。同一员工可出现在多个协作节点。</p>
      <div className="digital-team-palette-list">
        {props.employees.length === 0 ? (
          <p role="status">当前项目没有已启用的数字员工。</p>
        ) : (
          props.employees.map((employee) => (
            <article key={employee.id} className="digital-team-palette-card" draggable onDragStart={(event) => writeDragPayload(event, { kind: 'employee', employeeId: employee.id })}>
              <DigitalEmployeeAvatar avatarId={employee.avatarId} role={employee.role} />
              <span>
                <strong>{employee.name}</strong>
                <small>
                  {employee.role} · {employee.model ?? '项目默认模型'}
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
  /** 本次配置复用员工目录与编辑器。 */
  client: DashboardClient | null;
  capabilities: DigitalEmployeeCapabilitiesSnapshot | null;
  commands: CommandDefinition[];
  projectId: string;
  language: 'zh-CN' | 'en-US';
  node: DigitalTeamNode | null;
  definition: DigitalTeamWorkflowDefinition;
  employees: DigitalEmployeeRecord[];
  employeeNames: ReadonlyMap<string, string>;
  issues: Array<{ message: string }>;
  onChange(node: DigitalTeamNode): void;
  onConnect(source: string, target: string): void;
  onDisconnect(edgeId: string): void;
  onDelete(nodeId: string): void;
  onEmployeeSaved(employee: DigitalEmployeeRecord): void;
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
  /** 员工节点直接读取项目数字员工，不形成节点级配置副本。 */
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
          commands={props.commands}
          onChange={props.onChange}
          onEmployeeSaved={props.onEmployeeSaved}
          client={props.client}
          capabilities={props.capabilities}
          projectId={props.projectId}
          language={props.language}
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

/** 员工节点只选择项目数字员工，并直接展示该员工的权威配置。 */
function EmployeeNodeFields(props: {
  client: DashboardClient | null;
  capabilities: DigitalEmployeeCapabilitiesSnapshot | null;
  commands: CommandDefinition[];
  projectId: string;
  language: 'zh-CN' | 'en-US';
  node: DigitalTeamEmployeeNode;
  employees: DigitalEmployeeRecord[];
  employee: DigitalEmployeeRecord | undefined;
  onChange(node: DigitalTeamNode): void;
  onEmployeeSaved(employee: DigitalEmployeeRecord): void;
}) {
  return (
    <>
      <label>
        <span>执行员工</span>
        <ZeusSelect
          ariaLabel="选择执行员工"
          value={props.node.data.employeeId}
          options={props.employees.map((employee) => ({ value: employee.id, label: employee.name, description: employee.enabled ? employee.role : `${employee.role} · 已停用`, disabled: !employee.enabled }))}
          onChange={(employeeId) => {
            const employee = props.employees.find((candidate) => candidate.id === employeeId);
            if (!employee) return;
            props.onChange({
              ...props.node,
              data: {
                ...props.node.data,
                title: employee.name,
                employeeId,
                executionMode: employee.allowCodeChanges ? 'isolated_write' : 'read_only',
                settings: undefined,
              },
            });
          }}
          searchable
          size="regular"
        />
      </label>
      {props.employee ? (
        <DigitalEmployeeNodeEditor employee={props.employee} commands={props.commands} client={props.client} capabilities={props.capabilities} projectId={props.projectId} language={props.language} onSaved={props.onEmployeeSaved} />
      ) : (
        <p className="digital-team-message is-error" role="alert">
          当前节点绑定的数字员工不存在。
        </p>
      )}
    </>
  );
}

/** 节点检查器复用数字员工编辑器，并把保存直接写回项目数字员工。 */
function DigitalEmployeeNodeEditor(props: {
  employee: DigitalEmployeeRecord;
  commands: CommandDefinition[];
  client: DashboardClient | null;
  capabilities: DigitalEmployeeCapabilitiesSnapshot | null;
  projectId: string;
  language: 'zh-CN' | 'en-US';
  onSaved(employee: DigitalEmployeeRecord): void;
}) {
  /** 节点内的临时编辑草稿不进入团队模板。 */
  const [draft, setDraft] = useState<DigitalEmployeeDraft>(() => employeeDraft(props.employee));
  /** 只有真实改动才开放放弃和保存。 */
  const [changed, setChanged] = useState(false);
  /** 员工保存与模板保存使用独立忙碌状态。 */
  const [saving, setSaving] = useState(false);
  /** 配置错误就地显示，不污染团队模板校验。 */
  const [employeeError, setEmployeeError] = useState<string | null>(null);
  /** 当前语言决定复用表单和错误文案。 */
  const zh = props.language === 'zh-CN';

  /** 保存直接更新权威数字员工，节点不接收任何覆盖字段。 */
  const saveEmployee = async (): Promise<void> => {
    if (!props.client || saving || !changed) return;
    if (!draft.name.trim() || !draft.role.trim()) {
      setEmployeeError(zh ? '员工名称和岗位不能为空。' : 'Employee name and role are required.');
      return;
    }
    if (!draft.prompt.trim()) {
      setEmployeeError(zh ? '员工提示词不能为空。' : 'The employee prompt is required.');
      return;
    }
    setSaving(true);
    setEmployeeError(null);
    try {
      const employee = await props.client.updateProjectDigitalEmployee(props.projectId, props.employee.id, props.employee.revision, employeeInput(draft));
      props.onSaved(employee);
    } catch (cause) {
      setEmployeeError(applicationError(cause, zh));
    } finally {
      setSaving(false);
    }
  };

  /** 放弃只恢复员工当前已保存配置，不改变节点和连线。 */
  const discardEmployee = (): void => {
    setDraft(employeeDraft(props.employee));
    setChanged(false);
    setEmployeeError(null);
  };

  return (
    <section className="digital-team-employee-editor" aria-label={zh ? '数字员工配置内容' : 'Digital employee configuration'}>
      <p className="digital-employee-boundary-note">
        {zh
          ? '这里直接编辑项目数字员工；保存后其他入口立即读取同一份配置，团队节点不会创建覆盖副本。'
          : 'This edits the project employee directly. Every entry point reads the same saved configuration, and the team node creates no override.'}
      </p>
      <DigitalEmployeeEditor
        draft={draft}
        projectId={props.projectId}
        skillClient={props.client}
        language={props.language}
        deployCommands={props.commands}
        capabilities={props.capabilities}
        onChange={(next) => {
          setDraft(next);
          setChanged(true);
          setEmployeeError(null);
        }}
      />
      {employeeError ? (
        <p className="digital-team-message is-error" role="alert">
          {employeeError}
        </p>
      ) : null}
      <div className="digital-team-inspector-actions">
        <Button size="compact" disabled={!changed || saving} onClick={discardEmployee}>
          {zh ? '放弃员工修改' : 'Discard employee changes'}
        </Button>
        <Button variant="primary" size="compact" busy={saving} disabled={!props.client || !changed} onClick={() => void saveEmployee()}>
          {zh ? '保存数字员工' : 'Save employee'}
        </Button>
      </div>
    </section>
  );
}

/** 共享校验问题保留节点定位信息，草稿可保存但不能启动。 */
function ValidationPanel(props: { issues: Array<{ code: string; message: string; nodeId?: string }>; onSelectNode(nodeId: string): void }) {
  return (
    <section className={`digital-team-validation${props.issues.length ? ' has-issues' : ' is-ready'}`} aria-live="polite">
      <strong>{props.issues.length ? `还需处理 ${props.issues.length} 项` : '流程可以创建运行'}</strong>
      {props.issues.length ? (
        <ul>
          {props.issues.map((issue, index) => (
            <li key={`${issue.code}_${issue.nodeId ?? ''}_${index}`}>
              {issue.nodeId ? (
                <button type="button" onClick={() => props.onSelectNode(issue.nodeId!)}>
                  {issue.message}
                </button>
              ) : (
                issue.message
              )}
            </li>
          ))}
        </ul>
      ) : (
        <span>保存后即可按当前协作关系开始运行。</span>
      )}
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
  return { id: null, revision: null, name: '新协作流程', description: '', definition: { schemaGeneration: digitalTeamWorkflowSchemaGeneration, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0.8 } } };
}

/** 普通协作只预置一位真实员工，不替用户猜测额外角色或依赖。 */
function standardTemplateDraft(employees: DigitalEmployeeRecord[]): TemplateDraft {
  /** 没有可用员工时保留空草稿；草稿可保存，但运行门禁会阻止启动。 */
  const employee = employees[0];
  const nodes: DigitalTeamNode[] = employee
    ? [
        {
          id: 'work',
          type: 'employee',
          position: { x: 300, y: 200 },
          data: {
            title: '完成任务',
            employeeId: employee.id,
            purpose: 'work',
            executionMode: 'read_only',
            instructions: '根据原始任务目标完成当前分工，并提交可核对的成果。',
            acceptanceCriteria: ['完成分工并说明未解决问题'],
            expectedDeliverables: ['可核对的工作成果'],
          },
        },
      ]
    : [];
  return {
    id: null,
    revision: null,
    name: '团队协作',
    description: '',
    definition: normalizeDigitalTeamWorkflowDefinition({
      schemaGeneration: digitalTeamWorkflowSchemaGeneration,
      viewport: { x: 24, y: 80, zoom: 0.8 },
      nodes,
      edges: [],
    }),
  };
}

/** 已保存模板复制为可编辑草稿，不混入运行状态。 */
function templateDraft(template: DigitalTeamWorkflowTemplateRecord): TemplateDraft {
  return { id: template.id, revision: template.revision, name: template.name, description: template.description, definition: structuredClone(template.definition) };
}

/** 添加按钮使用可预期的阶梯位置，拖放仍使用准确视口坐标。 */
function nextNodePosition(index: number): { x: number; y: number } {
  return { x: 80 + (index % 4) * 240, y: 80 + Math.floor(index / 4) * 150 };
}

/** 构造新的员工分工节点，不自动猜测依赖关系。 */
function buildNode(payload: DigitalTeamDragPayload, position: { x: number; y: number }, employee: DigitalEmployeeRecord | undefined): DigitalTeamNode {
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

/** 节点名称始终优先读取项目数字员工，其他节点继续使用流程内名称。 */
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
