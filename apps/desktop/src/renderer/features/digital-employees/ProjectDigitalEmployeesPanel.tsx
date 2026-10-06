import { EmployeeMemoryProposals } from './EmployeeMemoryProposals.js';
import { MemorySettingsPane } from '../memory/MemorySettingsPane.js';
import { DigitalEmployeeAvatar } from './DigitalEmployeeAvatar.js';
import { VisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardClient } from '../../dashboardClient.js';
import { Button } from '../../ui/Button.js';
import type { DigitalEmployeeExecutionRecord, DigitalEmployeeRecord } from './digitalEmployeeContracts.js';
import { employeeDraft, employeeInput, errorMessage, executionIsActive, executionStatusLabel, formatDateTime, type DigitalEmployeeDraft, type DigitalEmployeeLanguage } from './digitalEmployeeUiSupport.js';
import './digitalEmployees.css';

export interface ProjectDigitalEmployeesPanelProps {
  projectId: string;
  projectName: string;
  client: DashboardClient | null;
  language: DigitalEmployeeLanguage;
  /** 使用全局自动化页面，项目页不维护另一份调度配置。 */
  onOpenAutomations(): void;
}

type ProjectPanelSection = 'employees' | 'automations' | 'executions';

export function ProjectDigitalEmployeesPanel(props: ProjectDigitalEmployeesPanelProps) {
  const zh = props.language === 'zh-CN';
  /** 候选接纳后刷新当前员工经验，不覆盖配置草稿。 */
  const [memoryRevision, setMemoryRevision] = useState<number | undefined>(undefined);
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  const [executions, setExecutions] = useState<DigitalEmployeeExecutionRecord[]>([]);
  const [section, setSection] = useState<ProjectPanelSection>('employees');
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
      const [nextEmployees, nextExecutions] = await Promise.all([props.client.loadProjectDigitalEmployees(props.projectId), props.client.loadProjectDigitalEmployeeExecutions(props.projectId)]);
      if (revision !== configurationRevision.current) return;
      setEmployees(nextEmployees);
      setExecutions(nextExecutions);
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
          <p>{zh ? '在任务中直接选择数字员工即可开始工作。这里仅调整当前项目的补充要求和 memory。' : 'Choose a digital employee directly in a task. Use this page only for project instructions and memory preferences.'}</p>
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
          <div className="digital-employee-master-detail is-project">
            <section className="digital-employee-list-pane" aria-label={zh ? '项目员工列表' : 'Project employee list'}>
              {employees.length === 0 ? (
                <p className="digital-employee-empty">
                  {loadState === 'loading' ? (zh ? '正在读取员工…' : 'Loading employees…') : zh ? '在任务中选择数字员工后，会自动显示在这里。' : 'Employees appear here after you select them in a task.'}
                </p>
              ) : null}
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
                <DigitalEmployeeEditor draft={employeeDraftState} language={props.language} onChange={editEmployee} />
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
