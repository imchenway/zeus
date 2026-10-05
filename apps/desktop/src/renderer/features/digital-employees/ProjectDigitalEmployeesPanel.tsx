import { EmployeeMemoryProposals } from './EmployeeMemoryProposals.js';
import { MemorySettingsPane } from '../memory/MemorySettingsPane.js';
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
import type { DigitalEmployeeExecutionRecord, DigitalEmployeeRecord, DigitalEmployeeTemplateRecord } from './digitalEmployeeContracts.js';
import { employeeDraft, employeeInput, errorMessage, executionIsActive, executionStatusLabel, formatDateTime, type DigitalEmployeeDraft, type DigitalEmployeeLanguage } from './digitalEmployeeUiSupport.js';
import './digitalEmployees.css';

export interface ProjectDigitalEmployeesPanelProps {
  projectId: string;
  projectName: string;
  client: DashboardClient | null;
  skillClient: Pick<NativeConversationAppClient, 'loadSkills' | 'loadCodexConversationCapabilities'> | null;
  language: DigitalEmployeeLanguage;
  /** 使用全局自动化页面，项目页不维护另一份调度配置。 */
  onOpenAutomations(): void;
}

type ProjectPanelSection = 'employees' | 'automations' | 'executions';

export function ProjectDigitalEmployeesPanel(props: ProjectDigitalEmployeesPanelProps) {
  const zh = props.language === 'zh-CN';
  /** 候选接纳后刷新当前员工经验，不覆盖配置草稿。 */
  const [memoryRevision, setMemoryRevision] = useState<number | undefined>(undefined);
  const [templates, setTemplates] = useState<DigitalEmployeeTemplateRecord[]>([]);
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  const [executions, setExecutions] = useState<DigitalEmployeeExecutionRecord[]>([]);
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [capabilities, setCapabilities] = useState<CodexConversationCapabilities | null>(null);
  const [section, setSection] = useState<ProjectPanelSection>('employees');
  const [templateId, setTemplateId] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [employeeDraftState, setEmployeeDraftState] = useState<DigitalEmployeeDraft | null>(null);
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
      const [nextTemplates, nextEmployees, nextExecutions, nextCommands, nextCapabilities] = await Promise.all([
        props.client.loadDigitalEmployeeTemplates(),
        props.client.loadProjectDigitalEmployees(props.projectId),
        props.client.loadProjectDigitalEmployeeExecutions(props.projectId),
        props.client.loadProjectCommands(props.projectId),
        capabilitiesPromise,
      ]);
      if (revision !== configurationRevision.current) return;
      /** 项目员工只能从用户已经创建的数字员工开始，内置模板不能绕过全局新增流程。 */
      const nextEmployeeSources = nextTemplates.filter((template) => !template.builtIn);
      setTemplates(nextTemplates);
      setEmployees(nextEmployees);
      setExecutions(nextExecutions);
      setCommands(nextCommands);
      if (modelRevision === capabilitiesRevision.current) setCapabilities(nextCapabilities);
      setTemplateId((current) => (current && nextEmployeeSources.some((template) => template.id === current) ? current : (nextEmployeeSources[0]?.id ?? '')));
      setSelectedEmployeeId((current) => {
        const selected = current ? nextEmployees.find((employee) => employee.id === current) : undefined;
        setEmployeeDraftState(selected ? (employeeDrafts.current.get(selected.id)?.draft ?? employeeDraft(selected)) : null);
        return selected?.id ?? null;
      });
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
  /** 项目只能添加用户创建的数字员工，内置模板仅在全局新增弹窗中出现。 */
  const employeeSources = useMemo(() => templates.filter((template) => !template.builtIn), [templates]);

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
      const record = await props.client.createProjectDigitalEmployee(props.projectId, { globalEmployeeId: templateId });
      if (scope !== configurationRevision.current) return;
      setEmployees((current) => [...current.filter((employee) => employee.id !== record.id), record].sort((left, right) => left.name.localeCompare(right.name)));
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

  /** 恢复全局默认或将历史项目员工明确绑定到已创建的全局员工。 */
  async function inheritGlobalEmployee(globalEmployeeId: string): Promise<void> {
    if (!props.client || !selectedEmployeeId || !globalEmployeeId || busyAction || loadState !== 'ready') return;
    /** 使用当前绑定版本，避免覆盖其他窗口的项目配置。 */
    const current = employees.find((employee) => employee.id === selectedEmployeeId);
    if (!current) return;
    /** 迟到的写入结果不能进入其他项目。 */
    const scope = configurationRevision.current;
    setBusyAction('inherit-employee');
    setErrorSection('employees');
    setError(null);
    try {
      /** 项目补充要求独立保存，恢复继承只清空通用字段覆盖。 */
      const record = await props.client.updateProjectDigitalEmployee(props.projectId, current.id, current.revision, { globalEmployeeId, projectOverrides: {} });
      if (scope !== configurationRevision.current) return;
      setEmployees((items) => items.map((employee) => (employee.id === record.id ? record : employee)));
      employeeDrafts.current.delete(record.id);
      setEmployeeDraftState(employeeDraft(record));
    } catch (cause) {
      if (scope === configurationRevision.current) setError(errorMessage(cause, zh ? 'zh-CN' : 'en'));
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
    if (!window.confirm(zh ? `从项目移除数字员工“${record.name}”？` : `Remove “${record.name}” from this project?`)) return;
    setBusyAction(`employee-delete:${record.id}`);
    setError(null);
    const scope = configurationRevision.current;
    try {
      await props.client.deleteProjectDigitalEmployee(props.projectId, record.id, record.revision);
      if (scope !== configurationRevision.current) return;
      employeeDrafts.current.delete(record.id);
      setEmployees((items) => items.filter((employee) => employee.id !== record.id));
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
        <SectionTab selected={section === 'automations'} onClick={() => setSection('automations')} label={zh ? '自动化' : 'Automations'} />
        <SectionTab selected={section === 'executions'} onClick={() => setSection('executions')} label={zh ? `执行记录 ${executions.length}` : `Executions ${executions.length}`} />
      </nav>

      {section === 'employees' ? (
        <div className="digital-employee-project-section" inert={busyAction !== null || loadState !== 'ready'} aria-busy={busyAction !== null}>
          <section className="digital-employee-assignment-strip" aria-label={zh ? '从数字员工添加到项目' : 'Add a digital employee to the project'}>
            <span>
              <strong>{zh ? '添加已有数字员工' : 'Add an existing digital employee'}</strong>
              <small>
                {employeeSources.length === 0
                  ? zh
                    ? '请先在设置中创建数字员工。'
                    : 'Create a digital employee in Settings first.'
                  : zh
                    ? '复用全局员工，当前项目只保存明确设置的差异。'
                    : 'Reuses the global employee and stores only explicit project differences.'}
              </small>
            </span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择已有数字员工' : 'Choose an existing digital employee'}
              value={templateId}
              onChange={setTemplateId}
              options={employeeSources.map((template) => ({ value: template.id, label: `${template.name} · ${template.role}` }))}
              disabled={employeeSources.length === 0}
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
                <>
                  <section className="digital-employee-form-section">
                    <header>
                      <strong>{zh ? '全局员工与项目差异' : 'Global employee and project overrides'}</strong>
                      <small>{zh ? '未覆盖的配置跟随全局员工更新；项目补充要求独立保留。' : 'Inherited fields follow global updates. Project instructions remain separate.'}</small>
                    </header>
                    {employees.find((employee) => employee.id === selectedEmployeeId)?.globalEmployeeId ? (
                      <Button
                        variant="secondary"
                        size="compact"
                        busy={busyAction === 'inherit-employee'}
                        disabled={Boolean(busyAction)}
                        onClick={() => void inheritGlobalEmployee(employees.find((employee) => employee.id === selectedEmployeeId)!.globalEmployeeId!)}
                      >
                        {zh ? '恢复全局配置' : 'Restore global defaults'}
                      </Button>
                    ) : (
                      <ZeusSelect
                        size="regular"
                        ariaLabel={zh ? '为历史项目员工绑定全局员工' : 'Bind the legacy project employee'}
                        value=""
                        onChange={(value) => void inheritGlobalEmployee(value)}
                        options={[
                          { value: '', label: zh ? '仅项目员工，选择全局员工绑定' : 'Project employee, choose global identity' },
                          ...employeeSources.map((employee) => ({ value: employee.id, label: `${employee.name} · ${employee.role}` })),
                        ]}
                        disabled={Boolean(busyAction) || employeeSources.length === 0}
                      />
                    )}
                  </section>
                  <DigitalEmployeeEditor
                    draft={employeeDraftState}
                    projectId={props.projectId}
                    skillClient={props.skillClient}
                    language={props.language}
                    deployCommands={deployCommands}
                    capabilities={capabilities}
                    onChange={editEmployee}
                    inheritsGlobal={Boolean(employees.find((employee) => employee.id === selectedEmployeeId)?.globalEmployeeId)}
                  />
                </>
              ) : (
                <div className="digital-employee-empty-state">
                  <strong>{zh ? '选择员工查看项目配置' : 'Select an employee to configure'}</strong>
                  <span>{zh ? '在此设置员工的岗位、技能、工作要求、任务选择方式和交付权限。设置只用于当前项目。' : 'Set the employee’s role, skills, instructions, task selection, and delivery permissions for this project.'}</span>
                </div>
              )}
              {selectedEmployeeId && props.client && employees.some((employee) => employee.id === selectedEmployeeId) ? (
                <details className="employee-memory-section">
                  <summary>{zh ? '经验与记忆' : 'Experience and memory'}</summary>
                  <EmployeeMemoryProposals key={`proposals:${selectedEmployeeId}`} projectId={props.projectId} employeeId={selectedEmployeeId} client={props.client} onAccepted={() => setMemoryRevision((value) => (value ?? 0) + 1)} />
                  <MemorySettingsPane
                    refreshRevision={memoryRevision}
                    key={selectedEmployeeId}
                    client={props.client.employeeMemory}
                    language={props.language}
                    projects={[]}
                    fixedScope={{ kind: 'employee', id: selectedEmployeeId }}
                    scopeLabel={zh ? '员工个人经验' : 'Employee experience'}
                  />
                </details>
              ) : null}
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
        <section className="digital-employee-project-section">
          <p>{zh ? '员工自动化已统一到自动化页面，原规则、执行记录和排程会保留。' : 'Employee automations are managed on the Automations page. Existing rules, runs, and schedules are retained.'}</p>
          <Button variant="primary" size="compact" onClick={props.onOpenAutomations}>
            {zh ? '前往自动化' : 'Open automations'}
          </Button>
        </section>
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

/** 数字员工所有入口共用同一份项目级配置表单，避免节点维护覆盖副本。 */
export function DigitalEmployeeEditor(props: {
  draft: DigitalEmployeeDraft;
  projectId: string;
  skillClient: Pick<NativeConversationAppClient, 'loadSkills'> | null;
  language: DigitalEmployeeLanguage;
  deployCommands: CommandDefinition[];
  capabilities: Pick<CodexConversationCapabilities, 'models'> | null;
  onChange: (draft: DigitalEmployeeDraft) => void;
  /** 已绑定全局员工时保留默认配置，项目差异按需编辑。 */
  inheritsGlobal?: boolean;
}) {
  const zh = props.language === 'zh-CN';
  /** 必填身份缺失时展开差异区，补全后保留用户当前展开状态。 */
  const identityDetails = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if ((!props.draft.name.trim() || !props.draft.role.trim()) && identityDetails.current) identityDetails.current.open = true;
  }, [props.draft.name, props.draft.role]);
  const patch = (value: Partial<DigitalEmployeeDraft>) => props.onChange({ ...props.draft, ...value });
  const patchGrant = (key: 'allowCommit' | 'allowPush' | 'allowMerge' | 'allowDeploy' | 'allowComplete', checked: boolean) => {
    patch({ [key]: checked });
  };
  return (
    <div className="digital-employee-form digital-employee-project-form">
      <details className="digital-employee-advanced-settings" ref={identityDetails} open={!props.inheritsGlobal}>
        <summary>{zh ? '项目身份差异' : 'Project identity overrides'}</summary>
        <div className="digital-employee-form-grid">
          <label>
            <span>{zh ? '员工名称' : 'Employee name'}</span>
            <input aria-invalid={!props.draft.name.trim()} value={props.draft.name} onChange={(event) => patch({ name: event.currentTarget.value })} maxLength={120} />
            {!props.draft.name.trim() ? <small className="is-error">{zh ? '请填写员工名称。' : 'Enter the employee name.'}</small> : null}
          </label>
          <label>
            <span>{zh ? '岗位' : 'Role'}</span>
            <input aria-invalid={!props.draft.role.trim()} value={props.draft.role} onChange={(event) => patch({ role: event.currentTarget.value })} maxLength={120} />
            {!props.draft.role.trim() ? <small className="is-error">{zh ? '请填写岗位。' : 'Enter the role.'}</small> : null}
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
      </details>

      <section className="digital-employee-form-section">
        <header>
          <strong>{zh ? '基础配置' : 'Agent configuration'}</strong>
          <small>{zh ? '默认继承员工配置，修改只用于当前项目。' : 'Employees work through AI conversations and follow your permissions when running commands.'}</small>
        </header>
        <AgentExecutionConfigFields
          value={props.draft}
          models={props.capabilities?.models ?? []}
          skillClient={props.skillClient}
          projectId={props.projectId}
          language={props.language}
          allowProjectDefaultModel
          inheritedPrompt={props.inheritsGlobal}
          onChange={patch}
        />
        <label>
          <span>{zh ? '项目补充要求' : 'Project instructions'}</span>
          <textarea
            rows={4}
            value={props.draft.projectInstructions}
            onChange={(event) => patch({ projectInstructions: event.currentTarget.value })}
            maxLength={20000}
            placeholder={zh ? '当前项目的开发标准、流程或业务要求' : 'Standards, workflow, or domain requirements for this project'}
          />
        </label>
      </section>

      <section className="digital-employee-form-section digital-employee-grants-section">
        <header>
          <strong>{zh ? '权限工具' : 'Authority and tools'}</strong>
          <small>{zh ? '管理动作分别授权，执行仍需遵循本次任务权限。' : 'These are employee defaults. A run may choose another permission mode, and completion never triggers hidden commit, deploy, or completion steps.'}</small>
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
        <details className="digital-employee-advanced-settings">
          <summary>
            {zh ? '管理动作授权' : 'Management action grants'}
            <small>
              {[props.draft.allowCommit, props.draft.allowPush, props.draft.allowMerge, props.draft.allowDeploy, props.draft.allowComplete].filter(Boolean).length} {zh ? '项已开启' : 'enabled'}
            </small>
          </summary>
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
        </details>
      </section>

      <details className="digital-employee-advanced-settings">
        <summary>
          {zh ? '自动领取与经验' : 'Auto claim and experience'}
          <small>{props.draft.autoClaim ? (zh ? '已开启任务池领取' : 'Task pool enabled') : ''}</small>
        </summary>
        <div className="digital-employee-policy-grid">
          <CheckboxRow
            checked={props.draft.autoClaim}
            onChange={(autoClaim) => patch({ autoClaim })}
            title={zh ? '自动从任务池创建工作项' : 'Create work items from task pool'}
            description={zh ? '只处理符合筛选条件的未完成任务。' : 'Only handles unfinished tasks matching these filters.'}
          />
          <CheckboxRow
            checked={props.draft.memoryEnabled !== false}
            onChange={(memoryEnabled) => patch({ memoryEnabled })}
            title={zh ? '使用个人经验' : 'Use employee experience'}
            description={zh ? '新工作读取经过确认且未过期的个人经验。关闭后经验记录仍保留。' : 'New work reads confirmed, current experience. Turning this off preserves the records.'}
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
      </details>
    </div>
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
