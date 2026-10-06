import { useState } from 'react';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { DigitalEmployeeAvatar } from './DigitalEmployeeAvatar.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { DigitalEmployeeRecord, TaskWorkPlan } from './digitalEmployeeContracts.js';
import type { TaskDigitalEmployeeManagement } from './TaskDigitalEmployeePanel.js';

/** 旧安排保留执行与人员指派，新流程统一进入数字团队。 */
export interface TaskWorkPlanPanelProps {
  /** 打开当前项目数字团队。 */
  onArrangeTeam?(): void;
  /** 当前任务构成所有控制请求的边界。 */
  taskId: string;
  /** 实际工作服务。 */
  client: DigitalEmployeeApiClient;
  /** 权威工作投影与串行操作入口。 */
  management: TaskDigitalEmployeeManagement;
  /** 终态任务仅查看。 */
  readOnly: boolean;
}

/** 展示历史安排与进行中工作，不再维护另一套流程编辑器。 */
export function TaskWorkPlanPanel(props: TaskWorkPlanPanelProps) {
  /** 计划和人员始终读取最新权威投影。 */
  const plan = props.management.projection?.plan;
  /** 结束安排前显示对已开始工作的影响。 */
  const [stopOpen, setStopOpen] = useState(false);
  /** 保留既有串行操作与可指派员工范围。 */
  const busy = props.management.busy !== null;
  /** 历史展示保留原成员身份，新指派另用可执行员工目录。 */
  const employees = props.management.employees;
  /** 控制携带实际修订，不重建已开始的工作。 */
  async function control(state: 'running' | 'paused' | 'cancelled'): Promise<void> {
    if (!plan) return;
    if (await props.management.act(`plan:${state}`, () => props.client.controlTaskWorkPlan(props.taskId, plan.revision, state))) setStopOpen(false);
  }

  return (
    <section className="task-team-plan" aria-label="团队工作安排">
      <header>
        <div>
          <h3>{plan ? '工作安排' : '让团队接力完成任务'}</h3>
          <p>{plan ? planStateLabel(plan.state, props.readOnly) : '安排阶段、分工和负责人，让调研、开发与审查围绕同一个任务推进。'}</p>
        </div>
        <div className="digital-employee-actions">
          {!props.readOnly && (!plan || ['draft', 'completed', 'cancelled'].includes(plan.state)) ? (
            <Button size="compact" variant={plan ? 'secondary' : 'primary'} onClick={props.onArrangeTeam} disabled={!props.onArrangeTeam}>
              {plan ? '使用数字团队安排工作' : '安排团队协作'}
            </Button>
          ) : null}
          {!props.readOnly && plan && plan.state === 'paused' ? (
            <Button size="compact" disabled={busy} busy={props.management.busy === 'plan:running'} onClick={() => void control('running')}>
              继续执行
            </Button>
          ) : null}
          {!props.readOnly && plan?.state === 'running' ? (
            <Button size="compact" variant="secondary" disabled={busy} onClick={() => void control('paused')}>
              暂停后续工作
            </Button>
          ) : null}
        </div>
      </header>
      {plan ? (
        <ol className="task-plan-stages">
          {plan.stages.map((stage, index) => (
            <li className="task-plan-stage" key={stage.id} data-state={stage.status}>
              <header>
                <span className="task-plan-step">{stage.status === 'accepted' ? '✓' : index + 1}</span>
                <div>
                  <h4>{stage.title}</h4>
                  <p>{stage.description}</p>
                </div>
                <span className="task-plan-stage-status">{plan.state === 'cancelled' && !['accepted', 'skipped'].includes(stage.status) ? '本阶段已结束' : stageStateLabel(stage.status)}</span>
              </header>
              <ul className="task-plan-work-list">
                {stage.items.map((item) => {
                  /** 人员显示使用项目原记录，已删除员工保留明确缺失提示。 */
                  const employee = employees.find((candidate) => candidate.id === item.employeeId);
                  return (
                    <li key={item.id}>
                      <div>
                        <strong>{item.title}</strong>
                        <p>{item.description}</p>
                        {item.arrangement?.parentWorkItemId ? <small>由「{stage.items.find((parent) => parent.id === item.arrangement?.parentWorkItemId)?.title ?? '原工作'}」委派</small> : null}
                        {item.arrangement?.dependencyIds.length ? <small>等待前项通过：{item.arrangement.dependencyIds.map((id) => stage.items.find((dependency) => dependency.id === id)?.title ?? id).join('、')}</small> : null}
                        {stage.items.some((child) => child.arrangement?.parentWorkItemId === item.id && child.status !== 'completed') ? <small>子工作尚未全部通过，之后会继续汇总</small> : null}
                        {item.arrangement?.blockedReason ? <p className="digital-employee-feedback is-error">{item.arrangement.blockedReason}</p> : null}
                      </div>
                      <div className="task-plan-person">
                        {!props.readOnly && !item.currentRunId && item.status === 'queued' && !['completed', 'cancelled'].includes(plan.state) ? (
                          <EmployeePicker
                            employeeId={item.employeeId}
                            employees={props.management.assignableEmployees}
                            disabled={busy}
                            allowUnassigned={false}
                            onChange={(employeeId) => {
                              if (employeeId) void props.management.act(`assign:${item.id}`, () => props.client.assignPlannedTaskWork(props.taskId, item.id, item.revision, employeeId));
                            }}
                          />
                        ) : employee ? (
                          <span>
                            <DigitalEmployeeAvatar {...employee} />
                            {employee.name}
                          </span>
                        ) : (
                          <span>{item.employeeId ? '员工已不可用' : '待指派'}</span>
                        )}
                        <small>
                          {item.arrangement?.cancellationRequested && item.status !== 'cancelled'
                            ? '正在核对停止结果'
                            : item.currentRunId || item.status !== 'queued'
                              ? workStateLabel(item.status)
                              : item.employeeId
                                ? '等待阶段执行'
                                : item.arrangement?.role
                                  ? `等待 ${item.arrangement.role} 领取`
                                  : '等待指派或自动领取'}
                        </small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      ) : null}
      {plan?.state === 'paused' ? <p className="task-plan-note">后续分工暂停启动，已开始的工作继续运行。需要停止某份工作时，请在下方运行记录中操作。</p> : null}
      {plan?.state === 'running' && plan.stages.some((stage) => stage.items.some((item) => item.arrangement?.blockedReason && !item.currentRunId)) && !props.readOnly ? (
        <Button variant="secondary" size="compact" disabled={busy} onClick={() => void control('running')}>
          重新检查等待中的工作
        </Button>
      ) : null}
      {plan && !props.readOnly && !['completed', 'cancelled'].includes(plan.state) ? (
        <details className="task-plan-more" open={stopOpen} onToggle={(event) => setStopOpen(event.currentTarget.open)}>
          <summary>结束本轮安排</summary>
          <p>不再启动后续分工，并请求停止已开始的工作。历史会话和成果仍保留；停止结果不确定时会保留原因。</p>
          <Button variant="danger" size="compact" disabled={busy} onClick={() => void control('cancelled')}>
            结束安排并停止工作
          </Button>
        </details>
      ) : null}
    </section>
  );
}

/** 员工选项包含头像，不把职位或模型当成员工身份。 */
function EmployeePicker(props: { employeeId: string | null; employees: DigitalEmployeeRecord[]; disabled?: boolean; allowUnassigned?: boolean; onChange(id: string | null): void }) {
  /** 保留历史已选项名称，同时禁止重新指派停用员工。 */
  const selected = props.employees.find((employee) => employee.id === props.employeeId);
  return (
    <ZeusSelect
      size="regular"
      ariaLabel="分工执行人"
      value={props.employeeId ?? ''}
      triggerLabel={selected?.name ?? (props.employeeId ? '员工已不可用' : '选择执行人')}
      triggerIcon={selected ? <DigitalEmployeeAvatar {...selected} /> : undefined}
      disabled={props.disabled}
      options={[
        ...(props.allowUnassigned ? [{ value: '', label: '暂不指派 · 等待领取' }] : []),
        ...props.employees
          .filter((employee) => employee.enabled || employee.id === props.employeeId)
          .map((employee) => ({ value: employee.id, label: `${employee.name} · ${employee.role}`, icon: <DigitalEmployeeAvatar {...employee} />, disabled: !employee.enabled })),
      ]}
      onChange={(id) => props.onChange(id || null)}
    />
  );
}

/** 控制状态只描述安排，不冒充外部运行结果。 */
function planStateLabel(state: TaskWorkPlan['state'], readOnly: boolean): string {
  /** 操作入口受限时同步说明，不承诺当前无法执行的调整。 */
  if (state === 'draft' && readOnly) return '尚未启动 · 当前仅可查看安排';
  return { draft: '尚未启动 · 后续安排使用数字团队', running: '按阶段推进 · 成果通过后继续', paused: '后续工作已暂停', completed: '全部必要分工已通过审查', cancelled: '本轮安排已结束 · 停止异常请查看工作记录' }[state];
}
/** 阶段显示来自工作投影。 */
function stageStateLabel(state: string): string {
  return ({ pending: '等待前序阶段', ready: '等待执行', running: '执行中', awaiting_acceptance: '等待审查', accepted: '已通过', failed: '需要处理', skipped: '已跳过' } as Record<string, string>)[state] ?? state;
}
/** 分工状态与原工作管理保持一致。 */
function workStateLabel(state: string): string {
  return ({ queued: '准备执行', active: '执行中', waiting_manager: '等待处理', completed: '已完成', failed: '执行失败', cancelled: '已取消' } as Record<string, string>)[state] ?? state;
}
