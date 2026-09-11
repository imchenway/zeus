import { useEffect, useState } from 'react';
import { mergeEmployeeWorkSettings, type EmployeeTeamRecipe, EmployeeWorkAssignment, EmployeeWorkSettings, EmployeeWorkStageInput } from '@zeus/shared';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import type { CodexTaskPushModelCapability } from '../../session/sessionTypes.js';
import { AgentExecutionConfigFields, type AgentExecutionConfigValue } from './AgentExecutionConfigFields.js';
import { SkillMultiSelector } from '../skills/SkillSelector.js';
import { DigitalEmployeeAvatar } from './DigitalEmployeeAvatar.js';
import type { DigitalEmployeeApiClient } from './digitalEmployeeApiClient.js';
import type { DigitalEmployeeRecord, TaskWorkPlan } from './digitalEmployeeContracts.js';
import type { TaskDigitalEmployeeManagement, TaskDigitalEmployeeSkillClient } from './TaskDigitalEmployeePanel.js';

/** 安排组件只提交真实阶段、分工和控制命令，执行记录由父级统一读取。 */
export interface TaskWorkPlanPanelProps {
  /** 当前任务与项目构成所有请求的边界。 */
  taskId: string;
  /** 当前项目身份。 */
  projectId: string;
  /** 实际工作服务。 */
  client: DigitalEmployeeApiClient;
  /** 技能目录沿用原有客户端。 */
  skillClient: TaskDigitalEmployeeSkillClient | null;
  /** 权威工作投影与串行操作入口。 */
  management: TaskDigitalEmployeeManagement;
  /** 终态任务仅查看。 */
  readOnly: boolean;
}

/** 默认分工需要清楚目标，未选员工时保留为待领工作。 */
function assignment(title: string, description: string, role = ''): EmployeeWorkAssignment {
  return { title, description, role, employeeId: null, settings: {}, required: true, outputKinds: ['document'] };
}

/** 预设只是可编辑的起点；保存不会启动任何员工。 */
function preset(kind: string): EmployeeWorkStageInput[] {
  /** 三类需求分别从确认目标、调研与排查进入同一工作链路。 */
  const rows =
    kind === 'research'
      ? ([
          [
            '联合调研',
            '从各自专业角度提出可验证的建议，再确认后续范围。',
            [assignment('产品与用户研究', '梳理用户问题、目标和取舍，列出仍需确认的问题。', '产品'), assignment('技术可行性研究', '调查已有实现与技术约束，提交依据、备选方案和风险。', '开发')],
          ],
          ['确认实施方案', '汇总专家意见，明确开发范围与验收标准。', [assignment('形成实施方案', '对照前序研究解决分歧，提交可执行的方案与验收标准。')]],
        ] as const)
      : kind === 'bug'
        ? ([['排查根因', '先复现和定位缺陷，再决定修复范围。', [assignment('复现与定位', '记录触发条件、复现证据与根因，说明修复方向。', '开发')]]] as const)
        : [];
  return [
    ...rows.map(([title, description, assignments]) => ({ title, description, assignments: [...assignments], settings: {}, requiredSkillIds: [], advanceMode: 'manual' as const, acceptanceMode: 'manual' as const })),
    {
      title: kind === 'bug' ? '修复缺陷' : '开发实现',
      description: '按任务说明和已确认的方案完成实现。',
      assignments: [assignment(kind === 'bug' ? '修复并说明影响' : '完成开发', '提交实际变更、完成情况与需要审查的风险。', '开发')],
      settings: {},
      requiredSkillIds: [],
      advanceMode: 'auto',
      acceptanceMode: 'manual',
    },
    {
      title: '代码审查',
      description: '审查实际变更的正确性、边界和维护成本。',
      assignments: [assignment('独立审查', '对照提交的变更给出问题清单、严重程度和明确结论。')],
      settings: { permissionMode: 'read-only' },
      requiredSkillIds: [],
      advanceMode: 'auto',
      acceptanceMode: 'manual',
    },
    {
      title: '验证与交付',
      description: '验证验收标准，整理可审查的成果。',
      assignments: [assignment('验证与交付说明', '执行适用的检查并记录实际结果，说明验证缺口和交付入口。', '测试')],
      settings: {},
      requiredSkillIds: [],
      advanceMode: 'manual',
      acceptanceMode: 'manual',
    },
  ];
}

/** 将保存的安排复制成编辑草稿，已有运行身份不会带入模板。 */
function planDraft(plan: TaskWorkPlan): EmployeeWorkStageInput[] {
  return plan.stages.map((stage) => ({
    title: stage.title,
    description: stage.description,
    settings: stage.settings,
    requiredSkillIds: stage.requiredSkillIds,
    advanceMode: stage.advanceMode,
    acceptanceMode: stage.acceptanceMode,
    verificationCommands: stage.verificationCommands,
    assignments: stage.items.map((item) => ({
      title: item.title,
      description: item.description,
      employeeId: item.employeeId,
      role: item.arrangement?.role ?? '',
      settings: item.arrangement?.settings ?? {},
      required: item.arrangement?.required !== false,
      outputKinds: item.arrangement?.outputKinds ?? ['document'],
    })),
  }));
}

/** 清楚呈现阶段与人员关系，安排草稿和真实执行保持不同操作。 */
export function TaskWorkPlanPanel(props: TaskWorkPlanPanelProps) {
  /** 计划随权威投影刷新，编辑草稿不被轮询覆盖。 */
  const plan = props.management.projection?.plan;
  /** 草稿只在显式开始编辑时建立。 */
  const [draft, setDraft] = useState<EmployeeWorkStageInput[] | null>(null);
  /** 保存时使用打开编辑器时的修订。 */
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  /** 任务级覆盖不写回员工。 */
  const [settings, setSettings] = useState<EmployeeWorkSettings>({});
  /** 可复用的项目团队安排。 */
  const [recipes, setRecipes] = useState<EmployeeTeamRecipe[]>([]);
  /** 配方名称在明确提交前仅保留本地。 */
  const [recipeName, setRecipeName] = useState('');
  /** 当前真实可用的模型目录。 */
  const [models, setModels] = useState<CodexTaskPushModelCapability[]>([]);
  /** 仅能力目录明确支持时提供自主目标编辑。 */
  const [goalsAvailable, setGoalsAvailable] = useState(false);
  /** 目录失败独立可见，不阻断只安排职责。 */
  const [catalogError, setCatalogError] = useState<string | null>(null);
  /** 配置展开才读取能力，避免每个分工重复请求。 */
  const [catalogRevision, setCatalogRevision] = useState(0);
  /** 终止安排采用行内确认，说明对已开始工作的影响。 */
  const [stopOpen, setStopOpen] = useState(false);
  /** 编辑快照携带原修订，后台启动或改派时不会覆盖新配置。 */
  const [pendingSettings, setPendingSettings] = useState<{ id: string; revision: number; value: EmployeeWorkSettings } | null>(null);
  /** 防止保存中的编辑和重复操作。 */
  const busy = props.management.busy !== null;
  /** 仅提供当前项目可执行员工，同时保留已选的历史名称。 */
  const employees = props.management.employees;

  useEffect(() => {
    if (!draft && !pendingSettings) return;
    /** 退出编辑器后旧目录响应不再改变页面。 */
    let active = true;
    void Promise.all([props.client.loadEmployeeTeamRecipes(props.projectId), props.client.loadDigitalEmployeeCapabilities()])
      .then(([nextRecipes, capabilities]) => {
        if (!active) return;
        setRecipes(nextRecipes);
        setModels(capabilities.models);
        setGoalsAvailable(capabilities.goals?.enabled === true);
        setCatalogError(null);
      })
      .catch((cause: unknown) => {
        if (active) setCatalogError(cause instanceof Error ? cause.message : '读取配置目录失败。');
      });
    return () => {
      active = false;
    };
  }, [Boolean(draft || pendingSettings), props.client, props.projectId, catalogRevision]);

  /** 打开安排只复制现有配置，不产生运行。 */
  function edit(): void {
    setDraft(plan ? planDraft(plan) : preset('development'));
    setSettings(plan?.settings ?? {});
    setBaseRevision(plan?.revision ?? null);
  }
  /** 阶段改动只替换当前草稿位置。 */
  function updateStage(index: number, patch: Partial<EmployeeWorkStageInput>): void {
    setDraft((current) => current?.map((stage, position) => (position === index ? { ...stage, ...patch } : stage)) ?? null);
  }
  /** 保存成功才关闭草稿；冲突和失败保留用户输入。 */
  async function save(): Promise<void> {
    if (!draft) return;
    if (await props.management.act('plan:save', () => props.client.saveTaskWorkPlan(props.taskId, { expectedRevision: baseRevision, stages: draft, settings }))) setDraft(null);
  }
  /** 每次控制携带页面读取的真实修订。 */
  async function control(state: 'running' | 'paused' | 'cancelled'): Promise<void> {
    if (!plan) return;
    if (await props.management.act(`plan:${state}`, () => props.client.controlTaskWorkPlan(props.taskId, plan.revision, state))) setStopOpen(false);
  }

  if (draft)
    return (
      <section className="task-team-plan is-editing" aria-label="安排团队工作">
        <header>
          <div>
            <h3>{plan && plan.state !== 'draft' ? '安排新一轮工作' : '安排团队工作'}</h3>
            <p>每个阶段明确目标与负责人，通过成果审查后再继续。</p>
          </div>
          <Button variant="secondary" size="compact" disabled={busy} onClick={() => setDraft(null)}>
            取消编辑
          </Button>
        </header>
        <fieldset disabled={busy}>
          <div className="task-plan-starting-points">
            <span>从常用安排开始</span>
            <ZeusSelect
              size="regular"
              ariaLabel="选择安排起点"
              value=""
              onChange={(value) => {
                if (value.startsWith('recipe:')) {
                  const recipe = recipes.find((candidate) => `recipe:${candidate.id}` === value);
                  if (recipe) setDraft(structuredClone(recipe.stages));
                } else setDraft(preset(value));
              }}
              triggerLabel="选择起点…"
              options={[
                { value: 'development', label: '明确需求 · 开发到交付' },
                { value: 'research', label: '先调研 · 专家讨论后实施' },
                { value: 'bug', label: '缺陷 · 先排查再修复' },
                ...recipes.map((recipe) => ({ value: `recipe:${recipe.id}`, label: recipe.name, group: '项目配方' })),
              ]}
            />
          </div>
          <SettingsEditor employees={employees} value={settings} onChange={setSettings} models={models} goalsAvailable={goalsAvailable} skillClient={props.skillClient} projectId={props.projectId} label="任务默认配置" />
          {catalogError ? (
            <p className="digital-employee-feedback is-error" role="alert">
              {catalogError}{' '}
              <Button size="compact" variant="secondary" onClick={() => setCatalogRevision((value) => value + 1)}>
                重新读取
              </Button>
            </p>
          ) : null}
          <ol className="task-plan-stages">
            {draft.map((stage, index) => (
              <li key={index} className="task-plan-stage">
                <header>
                  <span className="task-plan-step">{index + 1}</span>
                  <label>
                    <span className="sr-only">阶段名称</span>
                    <input aria-label={`阶段 ${index + 1} 名称`} value={stage.title} maxLength={240} onChange={(event) => updateStage(index, { title: event.target.value })} />
                  </label>
                  <div className="digital-employee-actions">
                    {index > 0 ? (
                      <Button
                        variant="secondary"
                        size="compact"
                        onClick={() =>
                          setDraft((current) => {
                            if (!current) return current;
                            const next = [...current];
                            [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                            return next;
                          })
                        }
                      >
                        上移
                      </Button>
                    ) : null}
                    {draft.length > 1 ? (
                      <Button variant="secondary" size="compact" onClick={() => setDraft((current) => current?.filter((_, position) => position !== index) ?? null)}>
                        移除阶段
                      </Button>
                    ) : null}
                  </div>
                </header>
                <label className="task-plan-goal">
                  <span>阶段目标</span>
                  <textarea rows={2} value={stage.description} onChange={(event) => updateStage(index, { description: event.target.value })} />
                </label>
                <div className="task-plan-assignments">
                  {stage.assignments.map((item, itemIndex) => (
                    <AssignmentEditor
                      key={itemIndex}
                      item={item}
                      inherited={mergeEmployeeWorkSettings(settings, stage.settings)}
                      employees={employees}
                      models={models}
                      goalsAvailable={goalsAvailable}
                      skillClient={props.skillClient}
                      projectId={props.projectId}
                      onChange={(patch) => updateStage(index, { assignments: stage.assignments.map((candidate, position) => (position === itemIndex ? { ...candidate, ...patch } : candidate)) })}
                      onRemove={stage.assignments.length > 1 ? () => updateStage(index, { assignments: stage.assignments.filter((_, position) => position !== itemIndex) }) : undefined}
                    />
                  ))}
                </div>
                <div className="task-plan-stage-controls">
                  <Button variant="secondary" size="compact" onClick={() => updateStage(index, { assignments: [...stage.assignments, assignment('新增分工', '')] })}>
                    添加并行分工
                  </Button>
                  <label>
                    <span>本阶段通过后</span>
                    <ZeusSelect
                      size="regular"
                      ariaLabel={`${stage.title}通过后的动作`}
                      searchable={false}
                      value={stage.advanceMode}
                      onChange={(advanceMode) => updateStage(index, { advanceMode })}
                      options={[
                        { value: 'auto', label: '自动进入下一阶段' },
                        { value: 'manual', label: '等我确认后继续' },
                      ]}
                    />
                  </label>
                </div>
                <details className="task-plan-settings">
                  <summary>成果如何通过 · {stage.acceptanceMode === 'checked' ? '按指定命令检查' : '人工审查'}</summary>
                  <ZeusSelect
                    size="regular"
                    value={stage.acceptanceMode}
                    ariaLabel="成果接纳方式"
                    options={[
                      { value: 'manual', label: '由我审查并接纳' },
                      { value: 'checked', label: '指定验证命令全部通过后接纳' },
                    ]}
                    onChange={(acceptanceMode) => updateStage(index, { acceptanceMode })}
                  />
                  {stage.acceptanceMode === 'checked' ? (
                    <label>
                      <span>必须通过的命令（每行一条，精确匹配执行记录）</span>
                      <textarea rows={3} value={(stage.verificationCommands ?? []).join('\n')} onChange={(event) => updateStage(index, { verificationCommands: event.target.value.split('\n') })} />
                      <small>仅核对所列命令的明确成功记录、所需成果和阻塞意见。产品判断、代码审查或部署确认建议保留人工审查；证据缺失时会等待处理。</small>
                    </label>
                  ) : null}
                </details>
                <StageRequiredSkills value={stage.requiredSkillIds} onChange={(requiredSkillIds) => updateStage(index, { requiredSkillIds })} projectId={props.projectId} client={props.skillClient} />
                <SettingsEditor
                  employees={employees}
                  inherited={settings}
                  value={stage.settings}
                  onChange={(next) => updateStage(index, { settings: next })}
                  models={models}
                  goalsAvailable={goalsAvailable}
                  skillClient={props.skillClient}
                  projectId={props.projectId}
                  label="阶段配置"
                />
              </li>
            ))}
          </ol>
          {draft.length < 12 ? (
            <Button
              variant="secondary"
              size="compact"
              onClick={() =>
                setDraft((current) => [...(current ?? []), { title: '新增阶段', description: '', settings: {}, requiredSkillIds: [], advanceMode: 'manual', acceptanceMode: 'manual', assignments: [assignment('新增分工', '')] }])
              }
            >
              添加阶段
            </Button>
          ) : null}
          <details className="task-plan-recipe">
            <summary>保存为项目团队配方</summary>
            <div>
              <label>
                <span>配方名称</span>
                <input value={recipeName} maxLength={120} onChange={(event) => setRecipeName(event.target.value)} />
              </label>
              <Button
                size="compact"
                variant="secondary"
                disabled={!recipeName.trim() || draft.some((stage) => !stage.title.trim() || stage.assignments.some((item) => !item.title.trim() || !item.description.trim()))}
                onClick={() =>
                  void props.management.act('recipe:save', async () => {
                    await props.client.saveEmployeeTeamRecipe({ id: `employee_team_recipe_${crypto.randomUUID()}`, projectId: props.projectId, name: recipeName, stages: draft, revision: 0 });
                    setRecipeName('');
                    setCatalogRevision((value) => value + 1);
                  })
                }
              >
                保存配方
              </Button>
            </div>
          </details>
        </fieldset>
        <footer>
          <p>保存后仍是草稿。未指定员工的分工可稍后指派，或由开启自动领取的员工承接。</p>
          <Button busy={props.management.busy === 'plan:save'} disabled={busy || draft.some((stage) => !stage.title.trim() || stage.assignments.some((item) => !item.title.trim() || !item.description.trim()))} onClick={() => void save()}>
            保存安排
          </Button>
        </footer>
      </section>
    );

  return (
    <section className="task-team-plan" aria-label="团队工作安排">
      <header>
        <div>
          <h3>{plan ? '工作安排' : '让团队接力完成任务'}</h3>
          <p>{plan ? planStateLabel(plan.state) : '安排阶段、分工和负责人，让调研、开发与审查围绕同一个任务推进。'}</p>
        </div>
        <div className="digital-employee-actions">
          {!props.readOnly && (!plan || ['draft', 'completed', 'cancelled'].includes(plan.state)) ? (
            <Button size="compact" variant={plan ? 'secondary' : 'primary'} onClick={edit}>
              {plan ? (plan.state === 'draft' ? '编辑安排' : '安排新一轮工作') : '安排工作'}
            </Button>
          ) : null}
          {!props.readOnly && plan && ['draft', 'paused'].includes(plan.state) ? (
            <Button size="compact" disabled={busy} busy={props.management.busy === 'plan:running'} onClick={() => void control('running')}>
              {plan.state === 'draft' ? '开始执行' : '继续执行'}
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
                            employees={employees}
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
                      {!props.readOnly && !item.currentRunId && item.status === 'queued' && !['completed', 'cancelled'].includes(plan.state) ? (
                        <div className="task-plan-work-settings">
                          {pendingSettings?.id === item.id ? (
                            <>
                              <SettingsEditor
                                value={pendingSettings.value}
                                inherited={mergeEmployeeWorkSettings(plan.settings, stage.settings)}
                                employee={employee}
                                employees={employees}
                                models={models}
                                goalsAvailable={goalsAvailable}
                                skillClient={props.skillClient}
                                projectId={props.projectId}
                                label="本分工配置"
                                onChange={(value) => setPendingSettings({ ...pendingSettings, value })}
                              />
                              <Button
                                size="compact"
                                disabled={busy}
                                onClick={() =>
                                  void props.management
                                    .act(`settings:${item.id}`, () => props.client.updatePlannedTaskWorkSettings(props.taskId, item.id, pendingSettings.revision, pendingSettings.value))
                                    .then((saved) => {
                                      if (saved) setPendingSettings(null);
                                    })
                                }
                              >
                                保存配置
                              </Button>
                              <Button size="compact" variant="secondary" disabled={busy} onClick={() => setPendingSettings(null)}>
                                取消
                              </Button>
                            </>
                          ) : (
                            <Button variant="secondary" size="compact" disabled={busy} onClick={() => setPendingSettings({ id: item.id, revision: item.revision, value: structuredClone(item.arrangement?.settings ?? {}) })}>
                              调整本分工配置
                            </Button>
                          )}
                          {catalogError && pendingSettings?.id === item.id ? (
                            <p role="alert">
                              {catalogError}
                              <Button size="compact" variant="secondary" onClick={() => setCatalogRevision((value) => value + 1)}>
                                重新读取
                              </Button>
                            </p>
                          ) : null}
                        </div>
                      ) : null}
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

/** 编辑一份有边界的目标，额外配置保持折叠。 */
function AssignmentEditor(props: {
  item: EmployeeWorkAssignment;
  /** 上层只作有效值展示，不写入当前覆盖。 */
  inherited?: EmployeeWorkSettings;
  employees: DigitalEmployeeRecord[];
  /** 原生自主目标可用性来自实际能力目录。 */
  goalsAvailable?: boolean;
  models: CodexTaskPushModelCapability[];
  skillClient: TaskDigitalEmployeeSkillClient | null;
  projectId: string;
  onChange(patch: Partial<EmployeeWorkAssignment>): void;
  onRemove?(): void;
}) {
  return (
    <div className="task-plan-assignment-editor">
      <div className="task-plan-assignment-heading">
        <label>
          <span>分工目标</span>
          <input value={props.item.title} maxLength={240} onChange={(event) => props.onChange({ title: event.target.value })} />
        </label>
        <label>
          <span>执行人</span>
          <EmployeePicker employees={props.employees} employeeId={props.item.employeeId} allowUnassigned onChange={(employeeId) => props.onChange({ employeeId })} />
        </label>
        {props.onRemove ? (
          <Button variant="secondary" size="compact" onClick={props.onRemove}>
            移除分工
          </Button>
        ) : null}
      </div>
      <label>
        <span>工作边界与完成标准</span>
        <textarea rows={2} value={props.item.description} onChange={(event) => props.onChange({ description: event.target.value })} />
      </label>
      <details className="task-plan-settings">
        <summary>需要的成果</summary>
        {(['document', 'code', 'verification', 'deployment'] as const).map((kind) => (
          <label key={kind}>
            <input
              type="checkbox"
              checked={props.item.outputKinds.includes(kind)}
              onChange={(event) => props.onChange({ outputKinds: event.target.checked ? [...props.item.outputKinds, kind] : props.item.outputKinds.filter((value) => value !== kind) })}
            />
            {{ document: '成果说明', code: '实际代码差异', verification: '运行验证记录', deployment: '部署及后续验证凭证' }[kind]}
          </label>
        ))}
      </details>
      {!props.item.employeeId ? (
        <label className="task-plan-claim-role">
          <span>自动领取的职责</span>
          <input value={props.item.role} placeholder="不限制职责" onChange={(event) => props.onChange({ role: event.target.value })} />
        </label>
      ) : null}
      <SettingsEditor
        employees={props.employees}
        inherited={props.inherited}
        value={props.item.settings}
        onChange={(settings) => props.onChange({ settings })}
        models={props.models}
        goalsAvailable={props.goalsAvailable}
        skillClient={props.skillClient}
        projectId={props.projectId}
        label="本分工配置"
        employee={props.employees.find((employee) => employee.id === props.item.employeeId)}
      />
    </div>
  );
}

/** 单次改变只覆盖选中的字段；其他配置继续继承上层与员工默认。 */
export function SettingsEditor(props: {
  value: EmployeeWorkSettings;
  /** 委派成员与继承配置均来自当前项目。 */
  employees: DigitalEmployeeRecord[];
  /** 讨论本轮不出现工作委派控件。 */
  allowDelegation?: boolean;
  inherited?: EmployeeWorkSettings;
  onChange(value: EmployeeWorkSettings): void;
  /** 原生自主目标可用性来自实际能力目录。 */
  goalsAvailable?: boolean;
  models: CodexTaskPushModelCapability[];
  skillClient: TaskDigitalEmployeeSkillClient | null;
  projectId: string;
  label: string;
  employee?: DigitalEmployeeRecord;
}) {
  /** 折叠配置不会挂载技能读取器。 */
  const [open, setOpen] = useState(false);
  /** 展示每层有效值，不自动写成当前层覆盖。 */
  const effective = mergeEmployeeWorkSettings(props.inherited, props.value);
  const value: AgentExecutionConfigValue = {
    agentKind: props.employee?.agentKind ?? 'codex',
    model: effective.modelOverride === null ? '' : (effective.modelOverride ?? props.employee?.model ?? ''),
    reasoningEffort: effective.reasoningEffort === null ? '' : (effective.reasoningEffort ?? props.employee?.reasoningEffort ?? ''),
    serviceTier: effective.serviceTier === null ? '' : (effective.serviceTier ?? props.employee?.serviceTier ?? ''),
    workMode: effective.workMode ?? props.employee?.workMode ?? 'default',
    permissionMode: effective.permissionMode ?? props.employee?.permissionMode ?? 'auto',
    skillIds: effective.skillIds ?? props.employee?.skillIds ?? [],
    prompt: effective.promptOverride ?? '',
  };
  /** 共用配置字段返回的实际变更映射到当前覆盖层。 */
  function change(patch: Partial<AgentExecutionConfigValue>): void {
    /** 原对象复制后只补充明确改动的设置。 */
    const next = { ...props.value };
    if ('model' in patch) next.modelOverride = patch.model || null;
    if ('reasoningEffort' in patch) next.reasoningEffort = patch.reasoningEffort || null;
    if ('serviceTier' in patch) next.serviceTier = patch.serviceTier || null;
    if ('workMode' in patch) next.workMode = patch.workMode;
    if ('permissionMode' in patch) next.permissionMode = patch.permissionMode;
    if ('skillIds' in patch) next.skillIds = patch.skillIds;
    if ('prompt' in patch) next.promptOverride = patch.prompt;
    props.onChange(next);
  }
  return (
    <details className="task-plan-settings" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {props.label}
        <small>{Object.keys(props.value).length ? '已调整' : '继承默认'}</small>
      </summary>
      {open ? (
        <div>
          <p>未调整的字段按任务、阶段、分工逐层继承，最终采用员工和项目默认。</p>
          {props.models.length ? (
            <AgentExecutionConfigFields value={value} onChange={change} models={props.models} skillClient={props.skillClient} language="zh-CN" projectId={props.projectId} allowProjectDefaultModel compact />
          ) : (
            <p>当前没有可用模型。可先保存工作安排，在员工与模型配置完成后执行。</p>
          )}
          {props.allowDelegation !== false && (props.goalsAvailable || effective.autonomyObjective) ? (
            <label className="task-plan-goal">
              <span>自主推进的完成目标</span>
              <textarea
                rows={3}
                maxLength={4000}
                value={effective.autonomyObjective ?? ''}
                placeholder="留空则按普通工作运行；填写后由原会话持续推进，直到目标完成或明确暂停。"
                onChange={(event) => props.onChange({ ...props.value, autonomyObjective: event.target.value || null })}
              />
              <small>
                {props.goalsAvailable
                  ? '仅支持原生目标的模型可以执行。暂停、恢复与消耗情况在原会话查看；目标完成后仍按本阶段的成果要求审查。委派时暂停自身目标，等待子成果通过后汇总。'
                  : '当前模型服务不支持自主目标。请清空此目标，或接入支持的模型后再执行。'}
              </small>
            </label>
          ) : null}
          {props.allowDelegation !== false ? (
            <fieldset className="task-plan-delegation">
              <legend>允许安排团队成员</legend>
              <p>仅下面选中的员工可以接收此工作拆出的子分工；子成果通过审查后再汇总。</p>
              {props.employees
                .filter((employee) => employee.enabled)
                .map((employee) => (
                  <label key={employee.id}>
                    <input
                      type="checkbox"
                      checked={effective.delegation?.employeeIds.includes(employee.id) ?? false}
                      onChange={(event) =>
                        props.onChange({
                          ...props.value,
                          delegation: {
                            maxDepth: effective.delegation?.maxDepth ?? 1,
                            maxWorkItems: effective.delegation?.maxWorkItems ?? 8,
                            employeeIds: event.target.checked ? [...(effective.delegation?.employeeIds ?? []), employee.id] : (effective.delegation?.employeeIds ?? []).filter((id) => id !== employee.id),
                          },
                        })
                      }
                    />
                    <DigitalEmployeeAvatar {...employee} />
                    <span>
                      {employee.name} · {employee.role}
                    </span>
                  </label>
                ))}
              {effective.delegation?.employeeIds.length ? (
                <div className="task-plan-delegation-budget">
                  <label>
                    最多拆分层级
                    <input type="number" min={1} max={4} value={effective.delegation.maxDepth} onChange={(event) => props.onChange({ ...props.value, delegation: { ...effective.delegation!, maxDepth: Number(event.target.value) } })} />
                  </label>
                  <label>
                    本轮最多子工作
                    <input
                      type="number"
                      min={1}
                      max={48}
                      value={effective.delegation.maxWorkItems}
                      onChange={(event) => props.onChange({ ...props.value, delegation: { ...effective.delegation!, maxWorkItems: Number(event.target.value) } })}
                    />
                  </label>
                </div>
              ) : null}
            </fieldset>
          ) : null}
          {Object.keys(props.value).length ? (
            <Button variant="secondary" size="compact" onClick={() => props.onChange({})}>
              恢复继承
            </Button>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

/** 控制状态只描述安排，不冒充外部运行结果。 */
function planStateLabel(state: TaskWorkPlan['state']): string {
  return { draft: '尚未启动 · 可以继续调整', running: '按阶段推进 · 成果通过后继续', paused: '后续工作已暂停', completed: '全部必要分工已通过审查', cancelled: '本轮安排已结束 · 停止异常请查看工作记录' }[state];
}
/** 阶段显示来自工作投影。 */
function stageStateLabel(state: string): string {
  return ({ pending: '等待前序阶段', ready: '等待执行', running: '执行中', awaiting_acceptance: '等待审查', accepted: '已通过', failed: '需要处理', skipped: '已跳过' } as Record<string, string>)[state] ?? state;
}
/** 分工状态与原工作管理保持一致。 */
function workStateLabel(state: string): string {
  return ({ queued: '准备执行', active: '执行中', waiting_manager: '等待处理', completed: '已完成', failed: '执行失败', cancelled: '已取消' } as Record<string, string>)[state] ?? state;
}

/** 阶段必须加载的工作方法与可覆盖默认分开；折叠时不读取目录。 */
function StageRequiredSkills(props: {
  /** 本阶段要求的技能身份。 */
  value: string[];
  /** 保存到阶段草稿。 */
  onChange(value: string[]): void;
  /** 技能查询的项目范围。 */
  projectId: string;
  /** 复用实际技能目录。 */
  client: TaskDigitalEmployeeSkillClient | null;
}) {
  /** 展开后才加载目录。 */
  const [open, setOpen] = useState(false);
  return (
    <details className="task-plan-settings" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>阶段必需技能 · {props.value.length ? `${props.value.length} 项` : '未指定'}</summary>
      {open ? (
        <>
          <p>这些技能在本阶段每份分工中加载，个人覆盖不会移除。失效时先提示处理，不带缺失方法继续执行。</p>
          <SkillMultiSelector client={props.client} projectId={props.projectId} value={props.value} onChange={props.onChange} language="zh-CN" ariaLabel="选择阶段必需技能" />
        </>
      ) : null}
    </details>
  );
}
