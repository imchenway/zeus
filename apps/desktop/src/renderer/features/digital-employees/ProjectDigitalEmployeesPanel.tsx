import { EmployeeMemoryProposals } from './EmployeeMemoryProposals.js';
import { MemorySettingsPane } from '../memory/MemorySettingsPane.js';
import { DigitalEmployeeAvatar } from './DigitalEmployeeAvatar.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardClient } from '../../dashboardClient.js';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
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

/** 旧员工配置只读展示使用面向用户的身份字段名称。 */
const legacyEmployeeFieldLabels: Record<string, [string, string]> = {
  name: ['员工名称', 'Employee name'],
  description: ['说明', 'Description'],
  role: ['岗位', 'Role'],
  domain: ['业务领域', 'Business domain'],
  avatarId: ['头像', 'Avatar'],
  prompt: ['提示词', 'Prompt'],
};

export function ProjectDigitalEmployeesPanel(props: ProjectDigitalEmployeesPanelProps) {
  const zh = props.language === 'zh-CN';
  /** 候选接纳后刷新当前员工经验，不覆盖配置草稿。 */
  const [memoryRevision, setMemoryRevision] = useState<number | undefined>(undefined);
  const [templates, setTemplates] = useState<DigitalEmployeeTemplateRecord[]>([]);
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  const [executions, setExecutions] = useState<DigitalEmployeeExecutionRecord[]>([]);
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
  const loadProjectConfiguration = useCallback(async () => {
    const revision = ++configurationRevision.current;
    executionRevision.current += 1;
    if (!props.client) {
      setLoadState('failed');
      return;
    }
    setLoadState('loading');
    setErrorSection(null);
    setError(null);
    try {
      const [nextTemplates, nextEmployees, nextExecutions] = await Promise.all([
        props.client.loadDigitalEmployeeTemplates(),
        props.client.loadProjectDigitalEmployees(props.projectId),
        props.client.loadProjectDigitalEmployeeExecutions(props.projectId),
      ]);
      if (revision !== configurationRevision.current) return;
      /** 项目员工只能从用户已经创建的数字员工开始，内置模板不能绕过全局新增流程。 */
      const nextEmployeeSources = nextTemplates.filter((template) => !template.builtIn);
      setTemplates(nextTemplates);
      setEmployees(nextEmployees);
      setExecutions(nextExecutions);
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
  }, [props.client, props.projectId, zh]);

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
    if (
      current.legacyConfiguration &&
      !window.confirm(
        zh
          ? '确认使用所选全局员工的身份和提示词？旧项目差异将被替代；项目补充要求和经验记录保持不变。'
          : 'Use the selected global employee’s identity and prompt? This replaces legacy project overrides while preserving project instructions and experience.',
      )
    )
      return;
    setBusyAction('inherit-employee');
    setErrorSection('employees');
    setError(null);
    try {
      /** 项目补充要求独立保存，恢复继承只清空通用字段覆盖。 */
      const record = await props.client.updateProjectDigitalEmployee(props.projectId, current.id, current.revision, { globalEmployeeId, projectOverrides: { memoryEnabled: current.memoryEnabled !== false } });
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
                      <strong>{zh ? '项目成员' : 'Project member'}</strong>
                      <small>{zh ? '身份与提示词统一使用全局员工，当前项目只补充工作要求。' : 'Identity and prompt come from the global employee. This project only adds instructions.'}</small>
                    </header>
                    {employees.find((employee) => employee.id === selectedEmployeeId)?.legacyConfiguration ? (
                      <ZeusSelect
                        size="regular"
                        ariaLabel={zh ? '选择全局员工并确认替代旧配置' : 'Choose a global employee to replace legacy settings'}
                        value=""
                        onChange={(value) => {
                          if (value) void inheritGlobalEmployee(value);
                        }}
                        options={[
                          { value: '', label: zh ? '选择要使用的全局员工配置' : 'Choose the global employee settings to use' },
                          ...employeeSources.map((employee) => ({ value: employee.id, label: `${employee.name} · ${employee.role}` })),
                        ]}
                        disabled={Boolean(busyAction) || employeeSources.length === 0}
                      />
                    ) : null}
                  </section>
                  {employees.find((employee) => employee.id === selectedEmployeeId)?.legacyConfiguration ? (
                    <section className="digital-employee-form-section" role="status">
                      <strong>{zh ? '旧项目配置需要确认，确认前暂停新工作' : 'Review legacy project settings before starting new work'}</strong>
                      <p>
                        {zh
                          ? '旧身份和提示词保留在下方。需要保留独立职责时，请先据此创建全局员工；确认改用全局配置会替代这些旧差异，项目补充要求和经验记录继续保留。'
                          : 'The previous identity and prompt are preserved below. Create a separate global employee if these responsibilities must remain distinct. Confirming global settings replaces these overrides while keeping project instructions and experience.'}
                      </p>
                      <dl>
                        {Object.entries(employees.find((employee) => employee.id === selectedEmployeeId)!.legacyConfiguration!).map(([key, value]) => (
                          <div key={key}>
                            <dt>{legacyEmployeeFieldLabels[key]?.[zh ? 0 : 1] ?? key}</dt>
                            <dd style={{ whiteSpace: 'pre-wrap' }}>{value ?? (zh ? '未设置' : 'Not set')}</dd>
                          </div>
                        ))}
                      </dl>
                    </section>
                  ) : null}
                  <DigitalEmployeeEditor draft={employeeDraftState} language={props.language} onChange={editEmployee} />
                </>
              ) : (
                <div className="digital-employee-empty-state">
                  <strong>{zh ? '选择员工查看项目配置' : 'Select an employee to configure'}</strong>
                  <span>{zh ? '在此补充项目工作要求、设置经验偏好，或管理项目成员。' : 'Add project instructions, set memory preferences, or manage project members.'}</span>
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

/** 项目成员只编辑补充要求与个人经验，不复制全局员工配置。 */
export function DigitalEmployeeEditor(props: {
  /** 当前项目配置草稿。 */
  draft: DigitalEmployeeDraft;
  /** 当前界面语言。 */
  language: DigitalEmployeeLanguage;
  /** 保存当前项目草稿。 */
  onChange: (draft: DigitalEmployeeDraft) => void;
}) {
  /** 当前界面是否使用简体中文。 */
  const zh = props.language === 'zh-CN';
  return (
    <div className="digital-employee-form digital-employee-project-form">
      <label>
        <span>{zh ? '项目补充要求' : 'Project instructions'}</span>
        <textarea
          rows={6}
          value={props.draft.projectInstructions}
          onChange={(event) => props.onChange({ ...props.draft, projectInstructions: event.currentTarget.value })}
          maxLength={20000}
          placeholder={zh ? '当前项目的开发标准、流程或业务要求' : 'Standards, workflow, or domain requirements for this project'}
        />
      </label>
      <CheckboxRow
        checked={props.draft.memoryEnabled}
        onChange={(memoryEnabled) => props.onChange({ ...props.draft, memoryEnabled })}
        title={zh ? '使用个人经验' : 'Use employee experience'}
        description={zh ? '新工作读取已确认且未过期的员工经验。关闭后保留经验记录。' : 'New work reads approved, current employee experience. Turning this off keeps existing records.'}
      />
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
