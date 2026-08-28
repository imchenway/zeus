import type { CommandDefinition } from '@zeus/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardClient } from '../../dashboardClient.js';
import { presentModelOptions } from '../../modelOptionPresentation.js';
import { resolveModelCapability } from '../../session/modelSelection.js';
import type { CodexConversationCapabilities } from '../../session/sessionTypes.js';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { SkillSelector } from '../skills/SkillSelector.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
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

  const loadProjectConfiguration = useCallback(async () => {
    if (!props.client) return;
    setLoadState('loading');
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
      setTemplates(nextTemplates);
      setEmployees(nextEmployees);
      setAutomations(nextAutomations);
      setExecutions(nextExecutions);
      setCommands(nextCommands);
      setCapabilities(nextCapabilities);
      setTemplateId((current) => (current && nextTemplates.some((template) => template.id === current) ? current : (nextTemplates[0]?.id ?? '')));
      setSelectedEmployeeId((current) => {
        const selected = current ? nextEmployees.find((employee) => employee.id === current) : undefined;
        setEmployeeDraftState(selected ? employeeDraft(selected) : null);
        return selected?.id ?? null;
      });
      setAutomationDraft((current) => ({ ...current, employeeId: current.employeeId && nextEmployees.some((employee) => employee.id === current.employeeId) ? current.employeeId : (nextEmployees[0]?.id ?? '') }));
      setLoadState('ready');
    } catch (cause) {
      setLoadState('failed');
      setError(errorMessage(cause, zh ? '无法读取项目数字员工配置。' : 'Could not load project digital employee configuration.'));
    }
  }, [props.client, props.projectId, props.skillClient, zh]);

  const refreshExecutions = useCallback(async () => {
    if (!props.client) return;
    try {
      setExecutions(await props.client.loadProjectDigitalEmployeeExecutions(props.projectId));
    } catch {
      // 轮询失败不覆盖用户正在编辑的配置；手动刷新会显示完整错误。
    }
  }, [props.client, props.projectId]);

  useEffect(() => {
    setSelectedEmployeeId(null);
    setEmployeeDraftState(null);
    setAutomationDraft({ ...emptyAutomationDraft });
    void loadProjectConfiguration();
  }, [loadProjectConfiguration]);

  const hasActiveExecutions = executions.some(executionIsActive);
  useEffect(() => {
    if (!hasActiveExecutions) return;
    const timer = window.setInterval(() => void refreshExecutions(), 5_000);
    return () => window.clearInterval(timer);
  }, [hasActiveExecutions, refreshExecutions]);

  const deployCommands = useMemo(() => commands.filter((command) => command.enabled), [commands]);

  function selectEmployee(record: DigitalEmployeeRecord): void {
    setSelectedEmployeeId(record.id);
    setEmployeeDraftState(employeeDraft(record));
    setError(null);
  }

  async function addEmployee(): Promise<void> {
    if (!props.client || !templateId) return;
    setBusyAction('add-employee');
    setError(null);
    try {
      const record = await props.client.createProjectDigitalEmployee(props.projectId, { templateId });
      setEmployees((current) => [...current, record].sort((left, right) => left.name.localeCompare(right.name)));
      selectEmployee(record);
    } catch (cause) {
      setError(errorMessage(cause, zh ? '无法把模板分配到项目。' : 'Could not assign the template to this project.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function saveEmployee(): Promise<void> {
    if (!props.client || !selectedEmployeeId || !employeeDraftState) return;
    const current = employees.find((employee) => employee.id === selectedEmployeeId);
    if (!current) return;
    if (!employeeDraftState.name.trim() || !employeeDraftState.role.trim() || !employeeDraftState.prompt.trim()) {
      setError(zh ? '员工名称、岗位和提示词不能为空。' : 'Employee name, role, and prompt are required.');
      return;
    }
    const maxConcurrency = Number.parseInt(employeeDraftState.maxConcurrency, 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 20) {
      setError(zh ? '并发上限必须是 1 到 20 的整数。' : 'Concurrency must be an integer from 1 to 20.');
      return;
    }
    if (employeeDraftState.allowDeploy && !employeeDraftState.deployCommandId) {
      setError(zh ? '开启自动部署前必须选择一个无需临时参数的命令中心命令。' : 'Choose a command that needs no runtime parameters before enabling automatic deployment.');
      return;
    }
    setBusyAction('save-employee');
    setError(null);
    try {
      const record = await props.client.updateProjectDigitalEmployee(props.projectId, current.id, current.revision, employeeInput(employeeDraftState));
      setEmployees((items) => items.map((employee) => (employee.id === record.id ? record : employee)));
      setEmployeeDraftState(employeeDraft(record));
    } catch (cause) {
      setError(errorMessage(cause, zh ? '保存项目数字员工失败。' : 'Could not save the project digital employee.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function toggleEmployee(record: DigitalEmployeeRecord): Promise<void> {
    if (!props.client) return;
    setBusyAction(`employee-toggle:${record.id}`);
    setError(null);
    try {
      const updated = await props.client.updateProjectDigitalEmployee(props.projectId, record.id, record.revision, { enabled: !record.enabled });
      setEmployees((items) => items.map((employee) => (employee.id === updated.id ? updated : employee)));
      if (selectedEmployeeId === updated.id) setEmployeeDraftState(employeeDraft(updated));
    } catch (cause) {
      setError(errorMessage(cause, zh ? '修改员工状态失败。' : 'Could not change employee status.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteEmployee(record: DigitalEmployeeRecord): Promise<void> {
    if (!props.client) return;
    if (!window.confirm(zh ? `从项目移除数字员工“${record.name}”？它的自动化规则也会停用。` : `Remove “${record.name}” from this project? Its automations will also be disabled.`)) return;
    setBusyAction(`employee-delete:${record.id}`);
    setError(null);
    try {
      await props.client.deleteProjectDigitalEmployee(props.projectId, record.id, record.revision);
      setEmployees((items) => items.filter((employee) => employee.id !== record.id));
      setAutomations((items) => items.filter((automation) => automation.employeeId !== record.id));
      if (selectedEmployeeId === record.id) {
        setSelectedEmployeeId(null);
        setEmployeeDraftState(null);
      }
    } catch (cause) {
      setError(errorMessage(cause, zh ? '移除数字员工失败。' : 'Could not remove the digital employee.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function createAutomation(): Promise<void> {
    if (!props.client || !automationDraft.employeeId) return;
    if (!automationDraft.name.trim()) {
      setError(zh ? '自动化名称不能为空。' : 'Automation name is required.');
      return;
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
    if (automationDraft.actionKind === 'explore_project' && employee && !employee.autonomousExploration) {
      setError(zh ? '请先在员工配置中开启“允许只读自主探索”。' : 'Enable read-only autonomous exploration on this employee first.');
      return;
    }
    setBusyAction('create-automation');
    setError(null);
    try {
      const record = await props.client.createDigitalEmployeeAutomation(props.projectId, {
        employeeId: automationDraft.employeeId,
        name: automationDraft.name.trim(),
        triggerKind: automationDraft.triggerKind,
        triggerConfig: automationTriggerConfig(automationDraft),
        actionKind: automationDraft.actionKind,
        actionConfig: automationActionConfig(automationDraft),
      });
      setAutomations((current) => [record, ...current]);
      setAutomationDraft((current) => ({ ...emptyAutomationDraft, employeeId: current.employeeId }));
    } catch (cause) {
      setError(errorMessage(cause, zh ? '创建自动化规则失败。' : 'Could not create the automation rule.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function toggleAutomation(record: DigitalEmployeeAutomationRecord): Promise<void> {
    if (!props.client) return;
    setBusyAction(`automation-toggle:${record.id}`);
    setError(null);
    try {
      const updated = await props.client.updateDigitalEmployeeAutomation(props.projectId, record.id, record.revision, { enabled: !record.enabled });
      setAutomations((items) => items.map((automation) => (automation.id === updated.id ? updated : automation)));
    } catch (cause) {
      setError(errorMessage(cause, zh ? '修改自动化状态失败。' : 'Could not change automation status.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function runAutomation(record: DigitalEmployeeAutomationRecord): Promise<void> {
    if (!props.client) return;
    setBusyAction(`automation-run:${record.id}`);
    setError(null);
    try {
      const updated = await props.client.runDigitalEmployeeAutomation(props.projectId, record.id);
      setAutomations((items) => items.map((automation) => (automation.id === updated.id ? updated : automation)));
      window.setTimeout(() => void refreshExecutions(), 1_500);
    } catch (cause) {
      setError(errorMessage(cause, zh ? '请求立即运行失败。' : 'Could not request an immediate run.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteAutomation(record: DigitalEmployeeAutomationRecord): Promise<void> {
    if (!props.client) return;
    if (!window.confirm(zh ? `删除自动化规则“${record.name}”？` : `Delete automation “${record.name}”?`)) return;
    setBusyAction(`automation-delete:${record.id}`);
    setError(null);
    try {
      await props.client.deleteDigitalEmployeeAutomation(props.projectId, record.id, record.revision);
      setAutomations((items) => items.filter((automation) => automation.id !== record.id));
    } catch (cause) {
      setError(errorMessage(cause, zh ? '删除自动化规则失败。' : 'Could not delete the automation rule.'));
    } finally {
      setBusyAction(null);
    }
  }

  if (!props.client) return null;

  return (
    <section className="project-digital-employees" aria-label={zh ? `${props.projectName} 数字员工` : `${props.projectName} digital employees`}>
      <header className="digital-employee-page-heading">
        <span>
          <h2>{zh ? '数字员工' : 'Digital employees'}</h2>
          <p>{zh ? '员工只在当前项目内工作。配置变更不会影响已经开始的执行；每次执行固定员工与授权快照。' : 'Employees work only in this project. Running executions keep an immutable employee and grant snapshot.'}</p>
        </span>
        <Button variant="secondary" size="compact" busy={loadState === 'loading'} onClick={() => void loadProjectConfiguration()}>
          {zh ? '刷新' : 'Refresh'}
        </Button>
      </header>

      {error ? (
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
        <div className="digital-employee-project-section">
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
                  <span className="digital-employee-avatar" aria-hidden="true">
                    {employee.role.slice(0, 1)}
                  </span>
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
                <EmployeeEditor draft={employeeDraftState} projectId={props.projectId} skillClient={props.skillClient} language={props.language} deployCommands={deployCommands} capabilities={capabilities} onChange={setEmployeeDraftState} />
              ) : (
                <div className="digital-employee-empty-state">
                  <strong>{zh ? '选择员工查看项目配置' : 'Select an employee to configure'}</strong>
                  <span>{zh ? '岗位、领域、Skill、提示词、找活策略和交付权限都属于项目副本。' : 'Role, domain, skills, prompt, work policy, and delivery grants belong to the project copy.'}</span>
                </div>
              )}
              {selectedEmployeeId && employeeDraftState ? (
                <footer className="digital-employee-editor-actions">
                  <small>{zh ? '提交、推送、合入、部署、结束任务是五项独立授权。' : 'Commit, push, merge, deploy, and task completion are five independent grants.'}</small>
                  <span className="digital-employee-actions">
                    {employees.find((employee) => employee.id === selectedEmployeeId) ? (
                      <>
                        <Button variant="secondary" size="compact" busy={busyAction === `employee-toggle:${selectedEmployeeId}`} onClick={() => void toggleEmployee(employees.find((employee) => employee.id === selectedEmployeeId)!)}>
                          {employeeDraftState.enabled ? (zh ? '停用' : 'Disable') : zh ? '启用' : 'Enable'}
                        </Button>
                        <Button variant="danger" size="compact" busy={busyAction === `employee-delete:${selectedEmployeeId}`} onClick={() => void deleteEmployee(employees.find((employee) => employee.id === selectedEmployeeId)!)}>
                          {zh ? '移除' : 'Remove'}
                        </Button>
                      </>
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
        <div className="digital-employee-project-section digital-employee-automation-layout">
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
              <small>{zh ? '排队、会话、等待与交付保持独立状态。' : 'Queueing, conversation work, waiting, and delivery remain separate states.'}</small>
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
              {execution.errorMessage ? <p role="alert">{execution.errorMessage}</p> : null}
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
  const runtimeModels = useMemo(() => (props.capabilities?.models ?? []).filter((model) => model.available !== false && (model.agentKind ?? 'codex') === props.draft.agentKind), [props.capabilities?.models, props.draft.agentKind]);
  const modelPresentation = useMemo(() => presentModelOptions(runtimeModels, props.draft.model, props.language, { preserveMissingSelection: true }), [props.draft.model, props.language, runtimeModels]);
  const selectedModel = resolveModelCapability(runtimeModels, props.draft.model);
  const modelOptions = useMemo(() => [{ value: '', label: zh ? '跟随项目默认' : 'Use project default', searchText: zh ? '项目默认 不指定' : 'project default unspecified' }, ...modelPresentation.options], [modelPresentation.options, zh]);
  const reasoningEffortOptions = useMemo(
    () => capabilityValueOptions(props.draft.reasoningEffort, selectedModel?.supportedReasoningEfforts ?? [], zh ? '跟随模型默认' : 'Use model default', zh ? '当前值不受此模型支持' : 'Current value is unsupported by this model'),
    [props.draft.reasoningEffort, selectedModel?.supportedReasoningEfforts, zh],
  );
  const serviceTierOptions = useMemo(
    () =>
      capabilityValueOptions(
        props.draft.serviceTier,
        selectedModel?.serviceTiers.map((tier) => ({ value: tier.id, label: tier.name || tier.id })) ?? [],
        zh ? '跟随模型默认' : 'Use model default',
        zh ? '当前值不受此模型支持' : 'Current value is unsupported by this model',
      ),
    [props.draft.serviceTier, selectedModel?.serviceTiers, zh],
  );
  const selectModel = (model: string) => {
    patch({ model, reasoningEffort: '', serviceTier: '' });
  };
  const patchGrant = (key: 'allowCommit' | 'allowPush' | 'allowMerge' | 'allowDeploy' | 'allowComplete', checked: boolean) => {
    if (key === 'allowCommit' && !checked) {
      patch({ allowCommit: false, allowPush: false, allowMerge: false });
      return;
    }
    if ((key === 'allowPush' || key === 'allowMerge') && checked) {
      patch({ [key]: true, allowCommit: true });
      return;
    }
    patch({ [key]: checked });
  };
  return (
    <div className="digital-employee-form digital-employee-project-form">
      <section className="digital-employee-form-section">
        <header>
          <strong>{zh ? '身份与能力' : 'Identity and capabilities'}</strong>
          <small>{zh ? '项目覆盖不会回写全局模板。' : 'Project overrides never write back to the global template.'}</small>
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
          <label>
            <span>{zh ? '运行时' : 'Runtime'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择员工运行时' : 'Choose employee runtime'}
              value={props.draft.agentKind}
              onChange={(agentKind) => patch({ agentKind, model: '', reasoningEffort: '', serviceTier: '' })}
              searchable={false}
              options={[
                { value: 'codex', label: 'Codex' },
                { value: 'pi', label: 'Pi' },
              ]}
            />
          </label>
          <label>
            <span>{zh ? '模型（可选）' : 'Model (optional)'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择员工模型' : 'Choose employee model'}
              value={selectedModel?.id ?? props.draft.model}
              onChange={selectModel}
              options={modelOptions}
              triggerLabel={props.draft.model ? modelPresentation.triggerLabel : zh ? '跟随项目默认' : 'Use project default'}
              searchPlaceholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
              emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
            />
          </label>
          <label>
            <span>{zh ? '推理强度（可选）' : 'Reasoning effort (optional)'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择员工推理强度' : 'Choose employee reasoning effort'}
              value={props.draft.reasoningEffort}
              onChange={(reasoningEffort) => patch({ reasoningEffort })}
              options={reasoningEffortOptions}
              disabled={!selectedModel}
              searchable={false}
            />
          </label>
          <label>
            <span>{zh ? '服务层级（可选）' : 'Service tier (optional)'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择员工服务层级' : 'Choose employee service tier'}
              value={props.draft.serviceTier}
              onChange={(serviceTier) => patch({ serviceTier })}
              options={serviceTierOptions}
              disabled={!selectedModel}
              searchable={false}
            />
          </label>
          <label>
            <span>{zh ? '工作模式' : 'Work mode'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择员工工作模式' : 'Choose employee work mode'}
              value={props.draft.workMode}
              onChange={(workMode) => patch({ workMode })}
              searchable={false}
              options={[
                { value: 'default', label: zh ? '默认' : 'Default' },
                { value: 'plan', label: zh ? '规划' : 'Plan' },
              ]}
            />
          </label>
          <label>
            <span>{zh ? '权限模式' : 'Permission mode'}</span>
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '选择权限模式' : 'Choose permission mode'}
              value={props.draft.permissionMode}
              onChange={(permissionMode) => patch({ permissionMode })}
              searchable={false}
              options={[
                { value: 'read-only', label: zh ? '只读' : 'Read-only' },
                { value: 'auto', label: zh ? '自动' : 'Auto' },
                { value: 'full-access', label: zh ? '完全访问' : 'Full access' },
              ]}
            />
          </label>
        </div>
        <label>
          <span>{zh ? '默认 Skill（可选）' : 'Default skill (optional)'}</span>
          <SkillSelector
            client={props.skillClient}
            projectId={props.projectId}
            value={props.draft.skillId}
            onChange={(skillId) => patch({ skillId })}
            language={props.language}
            ariaLabel={zh ? '选择项目员工默认 Skill' : 'Choose project employee default skill'}
          />
          <small>{zh ? '派发时会在项目及最终工作区复验并冻结该 Skill；Skill 不会扩大员工权限。' : 'Resolved again in the project and final workspace at dispatch; the skill cannot expand employee permissions.'}</small>
        </label>
        <label>
          <span>{zh ? '员工提示词' : 'Employee prompt'}</span>
          <textarea rows={5} value={props.draft.prompt} onChange={(event) => patch({ prompt: event.currentTarget.value })} maxLength={20000} />
        </label>
      </section>

      <section className="digital-employee-form-section">
        <header>
          <strong>{zh ? '找活与执行策略' : 'Work sourcing and execution'}</strong>
          <small>{zh ? '范围固定为当前项目；自主探索始终只读。' : 'Scope is fixed to this project; autonomous exploration is always read-only.'}</small>
        </header>
        <div className="digital-employee-policy-grid">
          <CheckboxRow
            checked={props.draft.enabled}
            onChange={(enabled) => patch({ enabled })}
            title={zh ? '启用员工' : 'Enable employee'}
            description={zh ? '停用后不接收新工作，已有执行不被删除。' : 'Stops accepting new work without deleting current executions.'}
          />
          <CheckboxRow
            checked={props.draft.autoClaim}
            onChange={(autoClaim) => patch({ autoClaim })}
            title={zh ? '自动从任务池认领' : 'Auto-claim from task pool'}
            description={zh ? '仅认领符合下面筛选条件的未完成任务。' : 'Claims only unfinished tasks matching the filters below.'}
          />
          <CheckboxRow
            checked={props.draft.autonomousExploration}
            onChange={(autonomousExploration) => patch({ autonomousExploration })}
            title={zh ? '允许只读自主探索' : 'Allow read-only exploration'}
            description={zh ? '仍需创建自动化规则决定何时触发，不会无限循环。' : 'Still requires an automation trigger and never runs as an infinite loop.'}
          />
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
            description={zh ? '允许执行项目已具备的检查；不会创建单元测试体系。' : 'Allows existing project checks without creating a unit-test system.'}
          />
        </div>
        <div className="digital-employee-form-grid">
          <label>
            <span>{zh ? '最大并发' : 'Maximum concurrency'}</span>
            <input type="number" min={1} max={20} value={props.draft.maxConcurrency} onChange={(event) => patch({ maxConcurrency: event.currentTarget.value })} />
          </label>
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

      <section className="digital-employee-form-section digital-employee-grants-section">
        <header>
          <strong>{zh ? '自动交付授权' : 'Automatic delivery grants'}</strong>
          <small>{zh ? '默认全部关闭；每次执行固定当前授权快照。' : 'All grants default off and are snapshotted for each execution.'}</small>
        </header>
        <div className="digital-employee-grant-flow" aria-label={zh ? '自动交付授权链' : 'Automatic delivery grant chain'}>
          <CheckboxRow
            checked={props.draft.allowCommit}
            onChange={(checked) => patchGrant('allowCommit', checked)}
            title={zh ? '提交' : 'Commit'}
            description={zh ? '只提交本次隔离任务工作区的精确变更。' : 'Commits exact changes from this isolated task workspace.'}
          />
          <CheckboxRow
            checked={props.draft.allowPush}
            onChange={(checked) => patchGrant('allowPush', checked)}
            title={zh ? '推送' : 'Push'}
            description={zh ? '自动推送任务分支；合入后也推送来源分支。' : 'Pushes the task branch and the merged source branch.'}
          />
          <CheckboxRow
            checked={props.draft.allowMerge}
            onChange={(checked) => patchGrant('allowMerge', checked)}
            title={zh ? '合入' : 'Merge'}
            description={zh ? '只合入会话创建时记录的来源分支；冲突即停止。' : 'Merges only into the recorded source branch and stops on conflicts.'}
          />
          <CheckboxRow
            checked={props.draft.allowDeploy}
            onChange={(checked) => patchGrant('allowDeploy', checked)}
            title={zh ? '部署' : 'Deploy'}
            description={zh ? '仅运行下方明确选择的命令中心命令。' : 'Runs only the explicitly selected Command Center command.'}
          />
          <CheckboxRow
            checked={props.draft.allowComplete}
            onChange={(checked) => patchGrant('allowComplete', checked)}
            title={zh ? '结束任务' : 'Complete task'}
            description={zh ? '所有前置授权动作完成后修改任务管理状态。' : 'Changes task management status after all prior granted actions finish.'}
          />
        </div>
        <label className="digital-employee-deploy-command">
          <span>{zh ? '部署命令' : 'Deployment command'}</span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择自动部署命令' : 'Choose automatic deployment command'}
            value={props.draft.deployCommandId}
            onChange={(deployCommandId) => patch({ deployCommandId })}
            disabled={!props.draft.allowDeploy}
            options={[
              { value: '', label: zh ? '未选择' : 'Not selected' },
              ...props.deployCommands.map((command) => ({
                value: command.id,
                label: command.title,
                disabled: command.parameters.some((parameter) => parameter.required && parameter.defaultValue === undefined),
                searchText: `${command.name} ${command.description}`,
              })),
            ]}
          />
          <small>{zh ? '需要临时必填参数的命令不可用于无人值守部署。' : 'Commands with unresolved required parameters cannot be used for unattended deployment.'}</small>
        </label>
      </section>
    </div>
  );
}

function capabilityValueOptions(
  currentValue: string,
  values: readonly string[] | ReadonlyArray<{ value: string; label: string }>,
  defaultLabel: string,
  unsupportedLabel: string,
): Array<{ value: string; label: string; disabled?: boolean }> {
  const normalized = values.map((entry) => (typeof entry === 'string' ? { value: entry, label: entry } : entry));
  const options: Array<{ value: string; label: string; disabled?: boolean }> = [{ value: '', label: defaultLabel }, ...normalized];
  if (currentValue && !normalized.some((entry) => entry.value === currentValue)) options.push({ value: currentValue, label: `${currentValue} · ${unsupportedLabel}`, disabled: true });
  return options;
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
        <small>{zh ? '每条规则独立启停、去重并受员工并发上限约束。' : 'Each rule is independently enabled, deduplicated, and bounded by employee concurrency.'}</small>
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
              value={props.draft.employeeId}
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
        <Button variant="primary" size="compact" busy={props.busy} disabled={props.employees.length === 0} onClick={props.onCreate}>
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
