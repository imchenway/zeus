import { DigitalEmployeeAvatar } from './DigitalEmployeeAvatar.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import type { CommandDefinition } from '@zeus/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardClient } from '../../dashboardClient.js';
import type { CodexConversationCapabilities } from '../../session/sessionTypes.js';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
import { codexCapabilitiesChangedEvent } from '../codex/codexApiClient.js';
import { AgentExecutionConfigFields } from './AgentExecutionConfigFields.js';
import type { DigitalEmployeeAutomationRecord, DigitalEmployeeExecutionRecord, DigitalEmployeeRecord, DigitalEmployeeTemplateRecord } from './digitalEmployeeContracts.js';
import {
  actionLabel,
  automationActionConfig,
  automationTriggerConfig,
  emptyAutomationDraft,
  employeeDraft,
  employeeInput,
  errorMessage,
  executionIsActive,
  executionStatusLabel,
  formatDateTime,
  triggerLabel,
  type DigitalEmployeeAutomationDraft,
  type DigitalEmployeeDraft,
  type DigitalEmployeeLanguage,
} from './digitalEmployeeUiSupport.js';
import './digitalEmployees.css';

export interface ProjectDigitalEmployeesPanelProps {
  projectId: string;
  projectName: string;
  client: DashboardClient | null;
  skillClient: Pick<NativeConversationAppClient, 'loadSkills' | 'loadCodexConversationCapabilities'> | null;
  language: DigitalEmployeeLanguage;
}

type ProjectPanelSection = 'employees' | 'automations' | 'executions';

export function ProjectDigitalEmployeesPanel(props: ProjectDigitalEmployeesPanelProps) {
  const zh = props.language === 'zh-CN';
  const [templates, setTemplates] = useState<DigitalEmployeeTemplateRecord[]>([]);
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  const [automations, setAutomations] = useState<DigitalEmployeeAutomationRecord[]>([]);
  const [executions, setExecutions] = useState<DigitalEmployeeExecutionRecord[]>([]);
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [capabilities, setCapabilities] = useState<CodexConversationCapabilities | null>(null);
  const [section, setSection] = useState<ProjectPanelSection>('employees');
  const [templateId, setTemplateId] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [employeeDraftState, setEmployeeDraftState] = useState<DigitalEmployeeDraft | null>(null);
  const [automationDraft, setAutomationDraft] = useState<DigitalEmployeeAutomationDraft>({ ...emptyAutomationDraft });
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorSection, setErrorSection] = useState<ProjectPanelSection | null>(null);

  const employeeDrafts = useRef(new Map<string, { draft: DigitalEmployeeDraft; revision: number }>());
  const configurationRevision = useRef(0);
  const executionRevision = useRef(0);
  /** 模型目录独立更新，迟到的页面初始化不能覆盖它。 */
  const capabilitiesRevision = useRef(0);

  useEffect(() => {
    /** 只刷新模型能力，保留员工及自动化编辑草稿。 */
    const load = props.skillClient?.loadCodexConversationCapabilities;
    if (!load) return;
    let disposed = false;
    const refresh = (): void => {
      const revision = ++capabilitiesRevision.current;
      void load(props.projectId)
        .then((nextCapabilities) => {
          if (!disposed && revision === capabilitiesRevision.current) setCapabilities(nextCapabilities);
        })
        .catch(() => {
          // 暂时断网时保留最近的模型，后续目录通知会再次读取。
        });
    };
    window.addEventListener(codexCapabilitiesChangedEvent, refresh);
    return () => {
      disposed = true;
      capabilitiesRevision.current += 1;
      window.removeEventListener(codexCapabilitiesChangedEvent, refresh);
    };
  }, [props.projectId, props.skillClient]);

  const loadProjectConfiguration = useCallback(async () => {
    const revision = ++configurationRevision.current;
    /** 与目录独立刷新共用递增标识，避免旧结果回写。 */
    const modelRevision = ++capabilitiesRevision.current;
    executionRevision.current += 1;
    if (!props.client) {
      setLoadState('failed');
      return;
    }
    setLoadState('loading');
    setErrorSection(null);
    setError(null);
    try {
      const capabilitiesPromise = props.skillClient?.loadCodexConversationCapabilities?.(props.projectId).catch(() => null) ?? Promise.resolve(null);
      const [nextTemplates, nextEmployees, nextAutomations, nextExecutions, nextCommands, nextCapabilities] = await Promise.all([
        props.client.loadDigitalEmployeeTemplates(),
        props.client.loadProjectDigitalEmployees(props.projectId),
        props.client.loadDigitalEmployeeAutomations(props.projectId),
        props.client.loadProjectDigitalEmployeeExecutions(props.projectId),
        props.client.loadProjectCommands(props.projectId),
        capabilitiesPromise,
      ]);
      if (revision !== configurationRevision.current) return;
      setTemplates(nextTemplates);
      setEmployees(nextEmployees);
      setAutomations(nextAutomations);
      setExecutions(nextExecutions);
      setCommands(nextCommands);
      if (modelRevision === capabilitiesRevision.current) setCapabilities(nextCapabilities);
      setTemplateId((current) => (current && nextTemplates.some((template) => template.id === current) ? current : (nextTemplates[0]?.id ?? '')));
      setSelectedEmployeeId((current) => {
        const selected = current ? nextEmployees.find((employee) => employee.id === current) : undefined;
        setEmployeeDraftState(selected ? (employeeDrafts.current.get(selected.id)?.draft ?? employeeDraft(selected)) : null);
        return selected?.id ?? null;
      });
      setAutomationDraft((current) => ({ ...current, employeeId: current.employeeId && nextEmployees.some((employee) => employee.id === current.employeeId) ? current.employeeId : (nextEmployees[0]?.id ?? '') }));
      setLoadState('ready');
    } catch (cause) {
      if (revision !== configurationRevision.current) return;
      setLoadState('failed');
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    }
  }, [props.client, props.projectId, props.skillClient, zh]);

  const refreshExecutions = useCallback(async () => {
    if (!props.client) return;
    const revision = ++executionRevision.current;
    const configuration = configurationRevision.current;
    try {
      const next = await props.client.loadProjectDigitalEmployeeExecutions(props.projectId);
      if (revision !== executionRevision.current || configuration !== configurationRevision.current) return;
      setExecutions(next);
    } catch {
      // 轮询失败不覆盖用户正在编辑的配置；手动刷新会显示完整错误。
    }
  }, [props.client, props.projectId]);

  useEffect(() => {
    employeeDrafts.current.clear();
    setBusyAction(null);
    setSelectedEmployeeId(null);
    setEmployeeDraftState(null);
    setAutomationDraft({ ...emptyAutomationDraft });
    void loadProjectConfiguration();
    return () => {
      configurationRevision.current += 1;
    };
  }, [loadProjectConfiguration]);

  const hasActiveExecutions = executions.some(executionIsActive);
  useEffect(() => {
    if (!hasActiveExecutions || loadState !== 'ready') return;
    const timer = window.setInterval(() => void refreshExecutions(), 5_000);
    return () => {
      window.clearInterval(timer);
      executionRevision.current += 1;
    };
  }, [hasActiveExecutions, loadState, refreshExecutions]);

  const deployCommands = useMemo(() => commands.filter((command) => command.enabled), [commands]);

  function selectEmployee(record: DigitalEmployeeRecord): void {
    setSelectedEmployeeId(record.id);
    setEmployeeDraftState(employeeDrafts.current.get(record.id)?.draft ?? employeeDraft(record));
    setError(null);
  }

  function editEmployee(draft: DigitalEmployeeDraft): void {
    if (!selectedEmployeeId || busyAction || loadState !== 'ready') return;
    const record = employees.find((employee) => employee.id === selectedEmployeeId);
    if (!record) return;
    const previous = employeeDrafts.current.get(record.id);
    employeeDrafts.current.set(record.id, { draft, revision: previous?.revision ?? record.revision });
    setEmployeeDraftState(draft);
  }

  function discardEmployeeDraft(): void {
    if (!selectedEmployeeId || busyAction || loadState !== 'ready') return;
    const record = employees.find((employee) => employee.id === selectedEmployeeId);
    if (!record) return;
    employeeDrafts.current.delete(record.id);
    setEmployeeDraftState(employeeDraft(record));
    setError(null);
  }

  async function addEmployee(): Promise<void> {
    if (!props.client || !templateId || busyAction || loadState !== 'ready') return;
    setErrorSection('employees');
    setBusyAction('add-employee');
    setError(null);
    const scope = configurationRevision.current;
    try {
      const record = await props.client.createProjectDigitalEmployee(props.projectId, { templateId });
      if (scope !== configurationRevision.current) return;
      setEmployees((current) => [...current, record].sort((left, right) => left.name.localeCompare(right.name)));
      selectEmployee(record);
    } catch (cause) {
      if (scope !== configurationRevision.current) return;
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      if (scope === configurationRevision.current) setBusyAction(null);
    }
  }

  async function saveEmployee(): Promise<void> {
    if (!props.client || !selectedEmployeeId || !employeeDraftState || busyAction || loadState !== 'ready') return;
    setErrorSection('employees');
    const current = employees.find((employee) => employee.id === selectedEmployeeId);
    if (!current) return;
    if (!employeeDraftState.name.trim() || !employeeDraftState.role.trim()) {
      setError(zh ? '员工名称和岗位不能为空。' : 'Employee name and role are required.');
      return;
    }
    if (!employeeDraftState.prompt.trim()) {
      setError(zh ? '员工提示词不能为空。' : 'The employee prompt is required.');
      return;
    }
    setBusyAction('save-employee');
    setError(null);
    const scope = configurationRevision.current;
    try {
      const record = await props.client.updateProjectDigitalEmployee(props.projectId, current.id, employeeDrafts.current.get(current.id)?.revision ?? current.revision, employeeInput(employeeDraftState));
      if (scope !== configurationRevision.current) return;
      setEmployees((items) => items.map((employee) => (employee.id === record.id ? record : employee)));
      employeeDrafts.current.delete(record.id);
      setEmployeeDraftState(employeeDraft(record));
    } catch (cause) {
      if (scope !== configurationRevision.current) return;
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      if (scope === configurationRevision.current) setBusyAction(null);
    }
  }

  async function toggleEmployee(record: DigitalEmployeeRecord): Promise<void> {
    if (!props.client || busyAction || loadState !== 'ready') return;
    setErrorSection('employees');
    setBusyAction(`employee-toggle:${record.id}`);
    setError(null);
    const scope = configurationRevision.current;
    try {
      const updated = await props.client.updateProjectDigitalEmployee(props.projectId, record.id, employeeDrafts.current.get(record.id)?.revision ?? record.revision, { enabled: !record.enabled });
      if (scope !== configurationRevision.current) return;
      setEmployees((items) => items.map((employee) => (employee.id === updated.id ? updated : employee)));
      const draft = employeeDrafts.current.get(updated.id);
      if (draft) {
        draft.draft = { ...draft.draft, enabled: updated.enabled };
        draft.revision = updated.revision;
      }
      if (selectedEmployeeId === updated.id) setEmployeeDraftState(draft?.draft ?? employeeDraft(updated));
    } catch (cause) {
      if (scope !== configurationRevision.current) return;
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      if (scope === configurationRevision.current) setBusyAction(null);
    }
  }

  async function deleteEmployee(record: DigitalEmployeeRecord): Promise<void> {
    if (!props.client || busyAction || loadState !== 'ready') return;
    setErrorSection('employees');
    if (!window.confirm(zh ? `从项目移除数字员工“${record.name}”？它的自动化规则也会停用。` : `Remove “${record.name}” from this project? Its automations will also be disabled.`)) return;
    setBusyAction(`employee-delete:${record.id}`);
    setError(null);
    const scope = configurationRevision.current;
    try {
      await props.client.deleteProjectDigitalEmployee(props.projectId, record.id, record.revision);
      if (scope !== configurationRevision.current) return;
      employeeDrafts.current.delete(record.id);
      setEmployees((items) => items.filter((employee) => employee.id !== record.id));
      setAutomations((items) => items.filter((automation) => automation.employeeId !== record.id));
      setAutomationDraft((draft) => (draft.employeeId === record.id ? { ...draft, employeeId: '' } : draft));
      if (selectedEmployeeId === record.id) {
        setSelectedEmployeeId(null);
        setEmployeeDraftState(null);
      }
    } catch (cause) {
      if (scope !== configurationRevision.current) return;
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      if (scope === configurationRevision.current) setBusyAction(null);
    }
  }

  async function createAutomation(): Promise<void> {
    if (!props.client || !automationDraft.employeeId || busyAction || loadState !== 'ready') return;
    setErrorSection('automations');
    if (!automationDraft.name.trim()) {
      setError(zh ? '自动化名称不能为空。' : 'Automation name is required.');
      return;
    }
    if ((automationDraft.triggerKind === 'daily' || automationDraft.triggerKind === 'weekly') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(automationDraft.time)) {
      setError(zh ? '请填写有效的本机时间。' : 'Enter a valid local time.');
      return;
    }
    if (automationDraft.triggerKind === 'interval') {
      const minutes = Number(automationDraft.intervalMinutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200) {
        setError(zh ? '间隔分钟必须是 1–43200 的整数。' : 'Interval minutes must be an integer from 1 to 43200.');
        return;
      }
    }
    if (automationDraft.triggerKind === 'once' && !automationDraft.runAt) {
      setError(zh ? '请选择一次性自动化的执行时间。' : 'Choose when the one-time automation should run.');
      return;
    }
    if (automationDraft.actionKind === 'create_and_assign_task' && (!automationDraft.taskTitle.trim() || !automationDraft.taskDescription.trim())) {
      setError(zh ? '创建任务时，任务标题和描述不能为空。' : 'Task title and description are required for task creation.');
      return;
    }
    const employee = employees.find((candidate) => candidate.id === automationDraft.employeeId);
    if (!employee?.enabled) {
      setError(zh ? '请选择已启用的项目员工。' : 'Select an enabled project employee.');
      return;
    }
    if (automationDraft.actionKind === 'explore_project' && employee && !employee.autonomousExploration) {
      setError(zh ? '请先在员工配置中开启“允许只读自主探索”。' : 'Enable read-only autonomous exploration on this employee first.');
      return;
    }
    setBusyAction('create-automation');
    setError(null);
    const scope = configurationRevision.current;
    try {
      const record = await props.client.createDigitalEmployeeAutomation(props.projectId, {
        employeeId: automationDraft.employeeId,
        name: automationDraft.name.trim(),
        triggerKind: automationDraft.triggerKind,
        triggerConfig: automationTriggerConfig(automationDraft),
        actionKind: automationDraft.actionKind,
        actionConfig: automationActionConfig(automationDraft),
      });
      if (scope !== configurationRevision.current) return;
      setAutomations((current) => [record, ...current]);
      setAutomationDraft((current) => ({ ...emptyAutomationDraft, employeeId: current.employeeId }));
    } catch (cause) {
      if (scope !== configurationRevision.current) return;
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      if (scope === configurationRevision.current) setBusyAction(null);
    }
  }

  async function toggleAutomation(record: DigitalEmployeeAutomationRecord): Promise<void> {
    if (!props.client || busyAction || loadState !== 'ready') return;
    setErrorSection('automations');
    setBusyAction(`automation-toggle:${record.id}`);
    setError(null);
    const scope = configurationRevision.current;
    try {
      const updated = await props.client.updateDigitalEmployeeAutomation(props.projectId, record.id, record.revision, { enabled: !record.enabled });
      if (scope !== configurationRevision.current) return;
      setAutomations((items) => items.map((automation) => (automation.id === updated.id ? updated : automation)));
    } catch (cause) {
      if (scope !== configurationRevision.current) return;
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      if (scope === configurationRevision.current) setBusyAction(null);
    }
  }

  async function runAutomation(record: DigitalEmployeeAutomationRecord): Promise<void> {
    if (!props.client || busyAction || loadState !== 'ready') return;
    setErrorSection('automations');
    setBusyAction(`automation-run:${record.id}`);
    setError(null);
    const scope = configurationRevision.current;
    try {
      const updated = await props.client.runDigitalEmployeeAutomation(props.projectId, record.id);
      if (scope !== configurationRevision.current) return;
      setAutomations((items) => items.map((automation) => (automation.id === updated.id ? updated : automation)));
      window.setTimeout(() => {
        if (scope === configurationRevision.current) void refreshExecutions();
      }, 1_500);
    } catch (cause) {
      if (scope !== configurationRevision.current) return;
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      if (scope === configurationRevision.current) setBusyAction(null);
    }
  }

  async function deleteAutomation(record: DigitalEmployeeAutomationRecord): Promise<void> {
    if (!props.client || busyAction || loadState !== 'ready') return;
    setErrorSection('automations');
    if (!window.confirm(zh ? `删除自动化规则“${record.name}”？` : `Delete automation “${record.name}”?`)) return;
    setBusyAction(`automation-delete:${record.id}`);
    setError(null);
    const scope = configurationRevision.current;
    try {
      await props.client.deleteDigitalEmployeeAutomation(props.projectId, record.id, record.revision);
      if (scope !== configurationRevision.current) return;
      setAutomations((items) => items.filter((automation) => automation.id !== record.id));
    } catch (cause) {
      if (scope !== configurationRevision.current) return;
      setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
    } finally {
      if (scope === configurationRevision.current) setBusyAction(null);
    }
  }

  if (!props.client) return null;

  return (
    <section className="project-digital-employees" aria-label={zh ? `${props.projectName} 数字员工` : `${props.projectName} digital employees`}>
      <header className="digital-employee-page-heading">
        <span>
          <h2>{zh ? '数字员工' : 'Digital employees'}</h2>
          <p>
            {zh
              ? '员工在当前项目中工作。修改配置只影响之后启动的工作，正在执行的工作继续使用原配置和权限。'
              : 'Employees work in this project. Settings changes apply to new work; ongoing work keeps its original configuration and permissions.'}
          </p>
        </span>
        <Button variant="secondary" size="compact" busy={loadState === 'loading'} disabled={busyAction !== null} onClick={() => void loadProjectConfiguration()}>
          {zh ? '刷新' : 'Refresh'}
        </Button>
      </header>

      {error && (errorSection === null || errorSection === section) ? (
        <p className="digital-employee-feedback is-error" role="alert">
          {error}
        </p>
      ) : null}

      <nav className="digital-employee-section-tabs" role="tablist" aria-label={zh ? '数字员工配置分段' : 'Digital employee configuration sections'}>
        <SectionTab selected={section === 'employees'} onClick={() => setSection('employees')} label={zh ? `项目员工 ${employees.length}` : `Employees ${employees.length}`} />
        <SectionTab selected={section === 'automations'} onClick={() => setSection('automations')} label={zh ? `自动化 ${automations.length}` : `Automations ${automations.length}`} />
        <SectionTab selected={section === 'executions'} onClick={() => setSection('executions')} label={zh ? `执行记录 ${executions.length}` : `Executions ${executions.length}`} />
      </nav>

      {section === 'employees' ? (
        <div className="digital-employee-project-section" inert={busyAction !== null || loadState !== 'ready'} aria-busy={busyAction !== null}>
          <section className="digital-employee-assignment-strip" aria-label={zh ? '从模板添加员工' : 'Add employee from template'}>
            <span>
              <strong>{zh ? '从全局模板添加' : 'Add from a global template'}</strong>
              <small>{zh ? '添加后生成项目独立副本，权限默认关闭。' : 'Creates a project-owned copy with delivery grants off by default.'}</small>
            </span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择数字员工模板' : 'Choose a digital employee template'}
              value={templateId}
              onChange={setTemplateId}
              options={templates.map((template) => ({ value: template.id, label: `${template.name} · ${template.role}`, group: template.builtIn ? (zh ? '内置' : 'Built-in') : zh ? '自定义' : 'Custom' }))}
              disabled={templates.length === 0}
            />
            <Button variant="primary" size="compact" busy={busyAction === 'add-employee'} disabled={!templateId} onClick={() => void addEmployee()}>
              {zh ? '添加到项目' : 'Add to project'}
            </Button>
          </section>

          <div className="digital-employee-master-detail is-project">
            <section className="digital-employee-list-pane" aria-label={zh ? '项目员工列表' : 'Project employee list'}>
              {employees.length === 0 ? <p className="digital-employee-empty">{loadState === 'loading' ? (zh ? '正在读取员工…' : 'Loading employees…') : zh ? '尚未添加项目员工。' : 'No project employees yet.'}</p> : null}
              {employees.map((employee) => (
                <button
                  key={employee.id}
                  type="button"
                  className={`digital-employee-list-row ${selectedEmployeeId === employee.id ? 'is-selected' : ''} ${employee.enabled ? '' : 'is-disabled'}`}
                  aria-pressed={selectedEmployeeId === employee.id}
                  onClick={() => selectEmployee(employee)}
                >
                  <DigitalEmployeeAvatar {...employee} />
                  <span>
                    <strong>{employee.name}</strong>
                    <small>
                      {employee.role} · {employee.domain || (zh ? '通用' : 'General')}
                    </small>
                  </span>
                  <em>{employee.enabled ? (zh ? '启用' : 'Enabled') : zh ? '停用' : 'Disabled'}</em>
                </button>
              ))}
            </section>
            <section className="digital-employee-editor-pane" aria-label={zh ? '项目员工配置' : 'Project employee configuration'}>
              {selectedEmployeeId && employeeDraftState ? (
                <EmployeeEditor draft={employeeDraftState} projectId={props.projectId} skillClient={props.skillClient} language={props.language} deployCommands={deployCommands} capabilities={capabilities} onChange={editEmployee} />
              ) : (
                <div className="digital-employee-empty-state">
                  <strong>{zh ? '选择员工查看项目配置' : 'Select an employee to configure'}</strong>
                  <span>{zh ? '在此设置员工的岗位、技能、工作要求、任务选择方式和交付权限。设置只用于当前项目。' : 'Set the employee’s role, skills, instructions, task selection, and delivery permissions for this project.'}</span>
                </div>
              )}
              {selectedEmployeeId && employeeDraftState ? (
                <footer className="digital-employee-editor-actions">
                  <small>{zh ? '提交、推送、合入、部署、结束任务是五项独立授权。' : 'Commit, push, merge, deploy, and task completion are five independent grants.'}</small>
                  <span className="digital-employee-actions">
                    {employees.find((employee) => employee.id === selectedEmployeeId) ? (
                      <>
                        <Button variant="secondary" size="compact" busy={busyAction === `employee-toggle:${selectedEmployeeId}`} onClick={() => void toggleEmployee(employees.find((employee) => employee.id === selectedEmployeeId)!)}>
                          {employees.find((employee) => employee.id === selectedEmployeeId)?.enabled ? (zh ? '停用' : 'Disable') : zh ? '启用' : 'Enable'}
                        </Button>
                        <Button variant="danger" size="compact" busy={busyAction === `employee-delete:${selectedEmployeeId}`} onClick={() => void deleteEmployee(employees.find((employee) => employee.id === selectedEmployeeId)!)}>
                          {zh ? '移除' : 'Remove'}
                        </Button>
                      </>
                    ) : null}
                    {employeeDrafts.current.has(selectedEmployeeId) ? (
                      <Button variant="secondary" size="compact" onClick={discardEmployeeDraft}>
                        {zh ? '放弃修改' : 'Discard changes'}
                      </Button>
                    ) : null}
                    <Button variant="primary" size="compact" busy={busyAction === 'save-employee'} onClick={() => void saveEmployee()}>
                      {zh ? '保存员工配置' : 'Save employee'}
                    </Button>
                  </span>
                </footer>
              ) : null}
            </section>
          </div>
        </div>
      ) : null}

      {section === 'automations' ? (
        <div className="digital-employee-project-section digital-employee-automation-layout" inert={busyAction !== null || loadState !== 'ready'} aria-busy={busyAction !== null}>
          <AutomationEditor draft={automationDraft} employees={employees} language={props.language} onChange={setAutomationDraft} onCreate={() => void createAutomation()} busy={busyAction === 'create-automation'} />
          <section className="digital-employee-automation-list" aria-label={zh ? '自动化规则' : 'Automation rules'}>
            {automations.length === 0 ? <p className="digital-employee-empty">{zh ? '尚未创建自动化规则。' : 'No automation rules yet.'}</p> : null}
            {automations.map((automation) => {
              const employee = employees.find((candidate) => candidate.id === automation.employeeId);
              return (
                <article key={automation.id} className={`digital-employee-automation-row ${automation.enabled ? '' : 'is-disabled'}`}>
                  <span className="digital-employee-automation-copy">
                    <strong>{automation.name}</strong>
                    <small>
                      {employee?.name ?? automation.employeeId} · {triggerLabel(automation.triggerKind, props.language)} → {actionLabel(automation.actionKind, props.language)}
                    </small>
                    <small>{automation.nextRunAt ? `${zh ? '下次' : 'Next'} ${formatDateTime(automation.nextRunAt, props.language)}` : zh ? '等待事件或手动运行' : 'Waiting for an event or manual run'}</small>
                  </span>
                  <span className="digital-employee-actions">
                    <Button variant="secondary" size="compact" busy={busyAction === `automation-run:${automation.id}`} disabled={!automation.enabled} onClick={() => void runAutomation(automation)}>
                      {zh ? '立即运行' : 'Run now'}
                    </Button>
                    <Button variant="secondary" size="compact" busy={busyAction === `automation-toggle:${automation.id}`} onClick={() => void toggleAutomation(automation)}>
                      {automation.enabled ? (zh ? '停用' : 'Disable') : zh ? '启用' : 'Enable'}
                    </Button>
                    <Button variant="danger" size="compact" busy={busyAction === `automation-delete:${automation.id}`} onClick={() => void deleteAutomation(automation)}>
                      {zh ? '删除' : 'Delete'}
                    </Button>
                  </span>
                </article>
              );
            })}
          </section>
        </div>
      ) : null}

      {section === 'executions' ? (
        <section className="digital-employee-execution-list" aria-label={zh ? '数字员工执行记录' : 'Digital employee executions'}>
          <header>
            <span>
              <strong>{zh ? '最近执行' : 'Recent executions'}</strong>
              <small>{zh ? '查看员工每次工作的进展和交付结果。' : 'View progress and deliverables from each employee run.'}</small>
            </span>
            <Button variant="secondary" size="compact" onClick={() => void refreshExecutions()}>
              {zh ? '刷新记录' : 'Refresh executions'}
            </Button>
          </header>
          {executions.length === 0 ? <p className="digital-employee-empty">{zh ? '暂无执行记录。' : 'No execution records.'}</p> : null}
          {executions.map((execution) => (
            <article key={execution.id} className={`digital-employee-execution-row is-${execution.status}`}>
              <span className="digital-employee-status-dot" aria-hidden="true" />
              <span>
                <strong>{execution.employeeSnapshot.name}</strong>
                <small>
                  {zh ? '任务' : 'Task'} {execution.taskId}
                </small>
              </span>
              <span>
                <strong>{executionStatusLabel(execution.status, props.language)}</strong>
                <small>
                  {zh ? '交付阶段' : 'Delivery stage'} · {execution.deliveryStage}
                </small>
              </span>
              <time dateTime={execution.updatedAt}>{formatDateTime(execution.updatedAt, props.language)}</time>
              {execution.errorMessage ? (
                <p role="alert">
                  <VisibleApplicationError error={{ code: execution.errorCode, message: execution.errorMessage }} language={zh ? 'zh-CN' : 'en'} />
                </p>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
    </section>
  );
}

function SectionTab(props: { selected: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" role="tab" aria-selected={props.selected} className={props.selected ? 'is-selected' : ''} onClick={props.onClick}>
      {props.label}
    </button>
  );
}

function EmployeeEditor(props: {
  draft: DigitalEmployeeDraft;
  projectId: string;
  skillClient: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  language: DigitalEmployeeLanguage;
  deployCommands: CommandDefinition[];
  capabilities: CodexConversationCapabilities | null;
  onChange: (draft: DigitalEmployeeDraft) => void;
}) {
  const zh = props.language === 'zh-CN';
  const patch = (value: Partial<DigitalEmployeeDraft>) => props.onChange({ ...props.draft, ...value });
  const patchGrant = (key: 'allowCommit' | 'allowPush' | 'allowMerge' | 'allowDeploy' | 'allowComplete', checked: boolean) => {
    patch({ [key]: checked });
  };
  return (
    <div className="digital-employee-form digital-employee-project-form">
      <section className="digital-employee-form-section">
        <header>
          <strong>{zh ? '身份说明' : 'Identity'}</strong>
          <small>{zh ? '说明这个员工是谁、负责什么；项目配置不会回写全局模板。' : 'Describe who this employee is and what it owns. Project settings do not change the global template.'}</small>
        </header>
        <div className="digital-employee-form-grid">
          <label>
            <span>{zh ? '员工名称' : 'Employee name'}</span>
            <input value={props.draft.name} onChange={(event) => patch({ name: event.currentTarget.value })} maxLength={120} />
          </label>
          <label>
            <span>{zh ? '岗位' : 'Role'}</span>
            <input value={props.draft.role} onChange={(event) => patch({ role: event.currentTarget.value })} maxLength={120} />
          </label>
          <label>
            <span>{zh ? '业务领域' : 'Business domain'}</span>
            <input value={props.draft.domain} onChange={(event) => patch({ domain: event.currentTarget.value })} maxLength={120} />
          </label>
        </div>
        <label>
          <span>{zh ? '身份说明' : 'Identity description'}</span>
          <textarea rows={3} value={props.draft.description} onChange={(event) => patch({ description: event.currentTarget.value })} maxLength={2000} />
        </label>
      </section>

      <section className="digital-employee-form-section">
        <header>
          <strong>{zh ? '基础配置' : 'Agent configuration'}</strong>
          <small>{zh ? '员工通过 AI 对话完成工作，执行命令时遵循你设置的权限。' : 'Employees work through AI conversations and follow your permissions when running commands.'}</small>
        </header>
        <AgentExecutionConfigFields value={props.draft} models={props.capabilities?.models ?? []} skillClient={props.skillClient} projectId={props.projectId} language={props.language} allowProjectDefaultModel onChange={patch} />
      </section>

      <section className="digital-employee-form-section digital-employee-grants-section">
        <header>
          <strong>{zh ? '权限工具' : 'Authority and tools'}</strong>
          <small>
            {zh
              ? '这些是员工默认能力；单次运行可另选权限模式，会话完成后也不会自动触发提交、部署或完结。'
              : 'These are employee defaults. A run may choose another permission mode, and completion never triggers hidden commit, deploy, or completion steps.'}
          </small>
        </header>
        <div className="digital-employee-policy-grid">
          <CheckboxRow
            checked={props.draft.allowCodeChanges}
            onChange={(allowCodeChanges) => patch({ allowCodeChanges })}
            title={zh ? '允许修改代码' : 'Allow code changes'}
            description={zh ? '只影响任务执行；不等于允许提交或推送。' : 'Applies to task execution and does not imply commit or push.'}
          />
          <CheckboxRow
            checked={props.draft.allowTests}
            onChange={(allowTests) => patch({ allowTests })}
            title={zh ? '允许执行验证' : 'Allow verification'}
            description={zh ? '允许员工运行项目已有的检查。' : 'Allow the employee to run the project’s existing checks.'}
          />
        </div>
        <p className="digital-employee-boundary-note">{zh ? '能否执行命令、修改哪些文件，取决于上方权限设置和操作时的授权。' : 'Command execution and file access depend on the permissions above and approvals granted during work.'}</p>
        <div className="digital-employee-grant-flow" aria-label={zh ? '管理动作授权' : 'Management action grants'}>
          <CheckboxRow
            checked={props.draft.allowCommit}
            onChange={(checked) => patchGrant('allowCommit', checked)}
            title={zh ? '提交' : 'Commit'}
            description={zh ? '允许在你发起提交操作时创建 Git 提交。' : 'Allow Git commits when you request a commit action.'}
          />
          <CheckboxRow
            checked={props.draft.allowPush}
            onChange={(checked) => patchGrant('allowPush', checked)}
            title={zh ? '推送' : 'Push'}
            description={zh ? '允许在你发起推送操作时上传已提交代码。' : 'Allow committed code to be uploaded when you request a push action.'}
          />
          <CheckboxRow
            checked={props.draft.allowMerge}
            onChange={(checked) => patchGrant('allowMerge', checked)}
            title={zh ? '合入' : 'Merge'}
            description={zh ? '允许在你发起合入操作时合并代码，遇到冲突会停止。' : 'Allow code merges when you request them. Merging stops if there are conflicts.'}
          />
          <CheckboxRow
            checked={props.draft.allowDeploy}
            onChange={(checked) => patchGrant('allowDeploy', checked)}
            title={zh ? '部署' : 'Deploy'}
            description={zh ? '允许在你发起部署操作时部署项目，员工完成工作不会自动部署。' : 'Allow deployment when you request it. Finishing the employee’s work does not deploy automatically.'}
          />
          <CheckboxRow
            checked={props.draft.allowComplete}
            onChange={(checked) => patchGrant('allowComplete', checked)}
            title={zh ? '结束任务' : 'Complete task'}
            description={zh ? '允许执行结束任务的操作，交付物仍需由你验收。' : 'Allow task completion actions. Deliverables still require your acceptance.'}
          />
        </div>
        {props.draft.allowDeploy ? (
          <label>
            <span>{zh ? '部署命令能力' : 'Deployment command capability'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择允许调用的部署命令' : 'Choose the allowed deployment command'}
              value={props.draft.deployCommandId}
              onChange={(deployCommandId) => patch({ deployCommandId })}
              options={[
                { value: '', label: zh ? '未指定固定部署命令' : 'No fixed deployment command' },
                ...props.deployCommands.map((command) => ({ value: command.id, label: command.title, searchText: `${command.name} ${command.description}` })),
              ]}
            />
            <small>{zh ? '此命令可供员工在获得授权后使用，不会因保存配置而执行。' : 'The employee can use this command after approval. Saving these settings does not run it.'}</small>
          </label>
        ) : null}
      </section>

      <section className="digital-employee-form-section">
        <header>
          <strong>{zh ? '自动化' : 'Automation'}</strong>
          <small>{zh ? '自动化按规则为员工安排工作，仍需遵守员工权限和部署授权。' : 'Automations assign work according to rules and still follow the employee’s permissions and deployment approvals.'}</small>
        </header>
        <div className="digital-employee-policy-grid">
          <CheckboxRow
            checked={props.draft.enabled}
            onChange={(enabled) => patch({ enabled })}
            title={zh ? '启用员工' : 'Enable employee'}
            description={zh ? '停用后不接收新工作，已有运行不被删除。' : 'Stops new work without deleting existing runs.'}
          />
          <CheckboxRow
            checked={props.draft.autoClaim}
            onChange={(autoClaim) => patch({ autoClaim })}
            title={zh ? '自动从任务池创建工作项' : 'Create work items from task pool'}
            description={zh ? '只处理符合筛选条件的未完成任务。' : 'Only handles unfinished tasks matching these filters.'}
          />
          <CheckboxRow
            checked={props.draft.autonomousExploration}
            onChange={(autonomousExploration) => patch({ autonomousExploration })}
            title={zh ? '允许只读自主探索' : 'Allow read-only exploration'}
            description={zh ? '仍需自动化规则触发，不会无限循环。' : 'Still requires an automation trigger and never loops indefinitely.'}
          />
        </div>
        <div className="digital-employee-form-grid">
          <label>
            <span>{zh ? '管理状态筛选' : 'Management status filter'}</span>
            <input value={props.draft.managementStatuses} onChange={(event) => patch({ managementStatuses: event.currentTarget.value })} placeholder={zh ? '空值表示不限' : 'Empty means any'} />
          </label>
          <label>
            <span>{zh ? '任务类型筛选' : 'Task type filter'}</span>
            <input value={props.draft.taskTypes} onChange={(event) => patch({ taskTypes: event.currentTarget.value })} placeholder="requirement, defect" />
          </label>
          <label>
            <span>{zh ? '必须包含的标签' : 'Required tags'}</span>
            <input value={props.draft.requiredTags} onChange={(event) => patch({ requiredTags: event.currentTarget.value })} placeholder={zh ? '逗号分隔' : 'Comma separated'} />
          </label>
        </div>
      </section>
    </div>
  );
}

function AutomationEditor(props: {
  draft: DigitalEmployeeAutomationDraft;
  employees: DigitalEmployeeRecord[];
  language: DigitalEmployeeLanguage;
  busy: boolean;
  onChange: (draft: DigitalEmployeeAutomationDraft) => void;
  onCreate: () => void;
}) {
  const zh = props.language === 'zh-CN';
  const patch = (value: Partial<DigitalEmployeeAutomationDraft>) => props.onChange({ ...props.draft, ...value });
  const eventTrigger = ['task_created', 'task_updated', 'task_status_changed', 'code_changed'].includes(props.draft.triggerKind);
  return (
    <section className="digital-employee-automation-editor" aria-label={zh ? '新建自动化规则' : 'Create automation rule'}>
      <header>
        <strong>{zh ? '新建自动化规则' : 'Create automation rule'}</strong>
        <small>{zh ? '每条规则可单独启用或停用，同一事件不会重复触发工作。' : 'Enable or disable each rule separately. The same event will not trigger duplicate work.'}</small>
      </header>
      <div className="digital-employee-form">
        <label>
          <span>{zh ? '规则名称' : 'Rule name'}</span>
          <input value={props.draft.name} onChange={(event) => patch({ name: event.currentTarget.value })} maxLength={120} />
        </label>
        <div className="digital-employee-form-grid">
          <label>
            <span>{zh ? '数字员工' : 'Digital employee'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择数字员工' : 'Choose digital employee'}
              value={props.employees.some((employee) => employee.id === props.draft.employeeId) ? props.draft.employeeId : ''}
              triggerLabel={!props.employees.some((employee) => employee.id === props.draft.employeeId) ? (zh ? '请先选择项目员工' : 'Select a project employee') : undefined}
              onChange={(employeeId) => patch({ employeeId })}
              options={props.employees.map((employee) => ({ value: employee.id, label: employee.name, disabled: !employee.enabled }))}
              disabled={props.employees.length === 0}
            />
          </label>
          <label>
            <span>{zh ? '触发方式' : 'Trigger'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择触发方式' : 'Choose trigger'}
              value={props.draft.triggerKind}
              onChange={(triggerKind) => patch({ triggerKind })}
              options={(['immediate', 'once', 'daily', 'weekly', 'interval', 'task_created', 'task_updated', 'task_status_changed', 'code_changed'] as const).map((trigger) => ({
                value: trigger,
                label: triggerLabel(trigger, props.language),
              }))}
            />
          </label>
          <label>
            <span>{zh ? '执行动作' : 'Action'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择执行动作' : 'Choose action'}
              value={props.draft.actionKind}
              onChange={(actionKind) => patch({ actionKind })}
              options={(['assign_task', 'create_and_assign_task', 'explore_project'] as const).map((action) => ({ value: action, label: actionLabel(action, props.language) }))}
            />
          </label>
          {props.draft.triggerKind === 'once' ? (
            <label>
              <span>{zh ? '执行时间' : 'Run at'}</span>
              <input type="datetime-local" value={props.draft.runAt} onChange={(event) => patch({ runAt: event.currentTarget.value })} />
            </label>
          ) : null}
          {props.draft.triggerKind === 'daily' || props.draft.triggerKind === 'weekly' ? (
            <label>
              <span>{zh ? '本机时间' : 'Local time'}</span>
              <input type="time" value={props.draft.time} onChange={(event) => patch({ time: event.currentTarget.value })} />
            </label>
          ) : null}
          {props.draft.triggerKind === 'weekly' ? (
            <label>
              <span>{zh ? '星期' : 'Weekday'}</span>
              <ZeusSelect size="regular" ariaLabel={zh ? '选择星期' : 'Choose weekday'} value={props.draft.weekday} onChange={(weekday) => patch({ weekday })} searchable={false} options={weekdayOptions(props.language)} />
            </label>
          ) : null}
          {props.draft.triggerKind === 'interval' ? (
            <label>
              <span>{zh ? '间隔分钟' : 'Interval minutes'}</span>
              <input type="number" min={1} max={43200} value={props.draft.intervalMinutes} onChange={(event) => patch({ intervalMinutes: event.currentTarget.value })} />
            </label>
          ) : null}
        </div>

        {props.draft.actionKind === 'assign_task' ? (
          <label>
            <span>{zh ? '指定任务 ID（可选）' : 'Specific task ID (optional)'}</span>
            <input
              value={props.draft.taskId}
              onChange={(event) => patch({ taskId: event.currentTarget.value })}
              placeholder={eventTrigger ? (zh ? '空值表示使用触发事件的任务' : 'Empty uses the event task') : zh ? '空值表示从任务池选择' : 'Empty selects from the task pool'}
            />
          </label>
        ) : null}

        {props.draft.actionKind === 'create_and_assign_task' ? (
          <div className="digital-employee-automation-task-fields">
            <label>
              <span>{zh ? '任务标题' : 'Task title'}</span>
              <input value={props.draft.taskTitle} onChange={(event) => patch({ taskTitle: event.currentTarget.value })} maxLength={200} />
            </label>
            <label>
              <span>{zh ? '任务描述' : 'Task description'}</span>
              <textarea rows={4} value={props.draft.taskDescription} onChange={(event) => patch({ taskDescription: event.currentTarget.value })} maxLength={20000} />
            </label>
            <div className="digital-employee-form-grid">
              <label>
                <span>{zh ? '任务类型' : 'Task type'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '选择任务类型' : 'Choose task type'}
                  value={props.draft.taskType}
                  onChange={(taskType) => patch({ taskType })}
                  searchable={false}
                  options={[
                    { value: 'requirement', label: zh ? '需求' : 'Requirement' },
                    { value: 'defect', label: zh ? '缺陷' : 'Defect' },
                    { value: 'optimization', label: zh ? '优化' : 'Optimization' },
                  ]}
                />
              </label>
              <label>
                <span>{zh ? '标签' : 'Tags'}</span>
                <input value={props.draft.tags} onChange={(event) => patch({ tags: event.currentTarget.value })} />
              </label>
            </div>
          </div>
        ) : null}

        {props.draft.actionKind === 'explore_project' ? (
          <p className="digital-employee-boundary-note">
            {zh ? '探索执行固定只读，只检查当前项目的任务、代码和文档，并以任务/会话保存候选发现。' : 'Exploration is always read-only, limited to project tasks, code, and docs, with findings retained in a task conversation.'}
          </p>
        ) : null}
        <Button variant="primary" size="compact" busy={props.busy} disabled={!props.employees.some((employee) => employee.id === props.draft.employeeId && employee.enabled)} onClick={props.onCreate}>
          {zh ? '创建规则' : 'Create rule'}
        </Button>
      </div>
    </section>
  );
}

function CheckboxRow(props: { checked: boolean; title: string; description: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="digital-employee-checkbox-row">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.currentTarget.checked)} />
      <span className="digital-employee-checkbox-visual" aria-hidden="true" />
      <span>
        <strong>{props.title}</strong>
        <small>{props.description}</small>
      </span>
    </label>
  );
}

function weekdayOptions(language: DigitalEmployeeLanguage) {
  const labels = language === 'zh-CN' ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return labels.map((label, index) => ({ value: String(index), label }));
}
