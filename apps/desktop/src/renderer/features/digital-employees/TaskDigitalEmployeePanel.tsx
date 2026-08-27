import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { DigitalEmployeeExecutionRecord, DigitalEmployeeRecord } from './digitalEmployeeContracts.js';
import { errorMessage, executionIsActive, executionStatusLabel, formatDateTime, type DigitalEmployeeLanguage } from './digitalEmployeeUiSupport.js';
import './digitalEmployees.css';

export interface TaskDigitalEmployeePanelProps {
  taskId: string;
  projectId: string;
  terminalReadOnly: boolean;
  client: DigitalEmployeeApiClient | null;
  language: DigitalEmployeeLanguage;
}

export function TaskDigitalEmployeePanel(props: TaskDigitalEmployeePanelProps) {
  const zh = props.language === 'zh-CN';
  const [employees, setEmployees] = useState<DigitalEmployeeRecord[]>([]);
  const [executions, setExecutions] = useState<DigitalEmployeeExecutionRecord[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPanel = useCallback(async () => {
    if (!props.client) return;
    setLoadState('loading');
    setError(null);
    try {
      const [nextEmployees, nextExecutions] = await Promise.all([props.client.loadProjectDigitalEmployees(props.projectId), props.client.loadTaskDigitalEmployeeExecutions(props.taskId)]);
      const enabledEmployees = nextEmployees.filter((employee) => employee.enabled);
      setEmployees(enabledEmployees);
      setExecutions(nextExecutions);
      setSelectedEmployeeId((current) => (current && enabledEmployees.some((employee) => employee.id === current) ? current : (enabledEmployees[0]?.id ?? '')));
      setLoadState('ready');
    } catch (cause) {
      setLoadState('failed');
      setError(errorMessage(cause, zh ? '无法读取数字员工指派状态。' : 'Could not load digital employee assignment status.'));
    }
  }, [props.client, props.projectId, props.taskId, zh]);

  const refreshExecutions = useCallback(async () => {
    if (!props.client) return;
    try {
      setExecutions(await props.client.loadTaskDigitalEmployeeExecutions(props.taskId));
    } catch {
      // 保留最后一次可用投影；手动刷新会报告错误。
    }
  }, [props.client, props.taskId]);

  useEffect(() => {
    void loadPanel();
  }, [loadPanel]);

  const activeExecution = useMemo(() => executions.find(executionIsActive) ?? null, [executions]);
  useEffect(() => {
    if (!activeExecution) return;
    const timer = window.setInterval(() => void refreshExecutions(), 4_000);
    return () => window.clearInterval(timer);
  }, [activeExecution, refreshExecutions]);

  async function assign(): Promise<void> {
    if (!props.client || !selectedEmployeeId || activeExecution) return;
    setBusyAction('assign');
    setError(null);
    try {
      const execution = await props.client.assignTaskToDigitalEmployee(props.taskId, selectedEmployeeId);
      setExecutions((current) => [execution, ...current.filter((candidate) => candidate.id !== execution.id)]);
    } catch (cause) {
      setError(errorMessage(cause, zh ? '指派数字员工失败。' : 'Could not assign the digital employee.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function retry(execution: DigitalEmployeeExecutionRecord): Promise<void> {
    if (!props.client) return;
    setBusyAction(`retry:${execution.id}`);
    setError(null);
    try {
      const updated = await props.client.retryDigitalEmployeeExecution(execution.id, props.taskId);
      setExecutions((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
    } catch (cause) {
      setError(errorMessage(cause, zh ? '重试数字员工执行失败。' : 'Could not retry the digital employee execution.'));
    } finally {
      setBusyAction(null);
    }
  }

  async function cancel(execution: DigitalEmployeeExecutionRecord): Promise<void> {
    if (!props.client) return;
    setBusyAction(`cancel:${execution.id}`);
    setError(null);
    try {
      const updated = await props.client.cancelDigitalEmployeeExecution(execution.id, props.taskId);
      setExecutions((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)));
    } catch (cause) {
      setError(errorMessage(cause, zh ? '取消数字员工执行失败。' : 'Could not cancel the digital employee execution.'));
    } finally {
      setBusyAction(null);
    }
  }

  if (!props.client) return null;

  const latestExecution = executions[0] ?? null;
  return (
    <section className="task-detail-block task-digital-employee-panel" aria-label={zh ? '数字员工' : 'Digital employee'}>
      <span className="task-detail-section-heading">
        <span>
          <strong>{zh ? '数字员工' : 'Digital employee'}</strong>
          <small>{activeExecution ? executionStatusLabel(activeExecution.status, props.language) : zh ? '未在自动处理中' : 'Not under automatic processing'}</small>
        </span>
        <Button variant="secondary" size="compact" busy={loadState === 'loading'} onClick={() => void loadPanel()}>
          {zh ? '刷新' : 'Refresh'}
        </Button>
      </span>

      {error ? (
        <p className="digital-employee-feedback is-error" role="alert">
          {error}
        </p>
      ) : null}

      {activeExecution ? (
        <ExecutionSummary execution={activeExecution} language={props.language} busyAction={busyAction} onCancel={cancel} onRetry={retry} />
      ) : (
        <div className="task-digital-employee-assignment">
          <span>
            <strong>{zh ? '指派项目员工' : 'Assign a project employee'}</strong>
            <small>{zh ? '指派后自动创建隔离会话；员工配置与交付授权会固定为本次执行快照。' : 'Assignment creates an isolated conversation and snapshots employee configuration and delivery grants.'}</small>
          </span>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '选择项目数字员工' : 'Choose a project digital employee'}
            value={selectedEmployeeId}
            onChange={setSelectedEmployeeId}
            disabled={employees.length === 0 || props.terminalReadOnly}
            options={employees.map((employee) => ({ value: employee.id, label: `${employee.name} · ${employee.role}`, searchText: `${employee.domain} ${employee.skillIds.join(' ')}` }))}
          />
          <Button variant="primary" size="compact" busy={busyAction === 'assign'} disabled={!selectedEmployeeId || props.terminalReadOnly} onClick={() => void assign()}>
            {zh ? '指派并自动处理' : 'Assign and process'}
          </Button>
        </div>
      )}

      {employees.length === 0 && loadState === 'ready' ? (
        <p className="digital-employee-boundary-note">{zh ? '当前项目没有已启用的数字员工。请先在项目设置中从模板添加员工。' : 'This project has no enabled digital employees. Add one from a template in project settings first.'}</p>
      ) : null}
      {props.terminalReadOnly ? (
        <p className="digital-employee-boundary-note">{zh ? '终态任务不能创建新的数字员工执行；重新打开任务后再指派。' : 'Terminal tasks cannot start a new digital employee execution. Reopen the task first.'}</p>
      ) : null}

      {!activeExecution && latestExecution ? <ExecutionSummary execution={latestExecution} language={props.language} busyAction={busyAction} onCancel={cancel} onRetry={retry} historical /> : null}
      {executions.length > 1 ? (
        <details className="task-digital-employee-history">
          <summary>{zh ? `查看历史执行（${executions.length}）` : `View execution history (${executions.length})`}</summary>
          <ol>
            {executions.map((execution) => (
              <li key={execution.id}>
                <span>
                  <strong>{execution.employeeSnapshot.name}</strong>
                  <small>{formatDateTime(execution.updatedAt, props.language)}</small>
                </span>
                <span>
                  {executionStatusLabel(execution.status, props.language)} · {execution.deliveryStage}
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

function ExecutionSummary(props: {
  execution: DigitalEmployeeExecutionRecord;
  language: DigitalEmployeeLanguage;
  busyAction: string | null;
  historical?: boolean;
  onRetry: (execution: DigitalEmployeeExecutionRecord) => Promise<void>;
  onCancel: (execution: DigitalEmployeeExecutionRecord) => Promise<void>;
}) {
  const zh = props.language === 'zh-CN';
  const retryable = props.execution.deliveryState.retryUnsafe !== true && (props.execution.status === 'failed' || props.execution.status === 'blocked' || props.execution.status === 'cancelled');
  const cancellable = props.execution.status === 'queued';
  return (
    <div className={`task-digital-employee-execution is-${props.execution.status} ${props.historical ? 'is-historical' : ''}`}>
      <span className="digital-employee-status-dot" aria-hidden="true" />
      <span className="task-digital-employee-execution-copy">
        <strong>{props.execution.employeeSnapshot.name}</strong>
        <small>
          {executionStatusLabel(props.execution.status, props.language)} · {zh ? '第' : 'Attempt'} {props.execution.attempt} {zh ? '次' : ''}
        </small>
        <small>
          {zh ? '交付阶段' : 'Delivery stage'} · {props.execution.deliveryStage}
        </small>
      </span>
      <time dateTime={props.execution.updatedAt}>{formatDateTime(props.execution.updatedAt, props.language)}</time>
      {props.execution.errorMessage ? <p role="alert">{props.execution.errorMessage}</p> : null}
      {retryable || cancellable ? (
        <span className="digital-employee-actions">
          {retryable ? (
            <Button variant="secondary" size="compact" busy={props.busyAction === `retry:${props.execution.id}`} onClick={() => void props.onRetry(props.execution)}>
              {zh ? '重试' : 'Retry'}
            </Button>
          ) : null}
          {cancellable ? (
            <Button variant="danger" size="compact" busy={props.busyAction === `cancel:${props.execution.id}`} onClick={() => void props.onCancel(props.execution)}>
              {zh ? '取消排队' : 'Cancel queue'}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
