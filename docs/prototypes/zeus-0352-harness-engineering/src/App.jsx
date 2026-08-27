import { useEffect, useMemo, useState } from 'react';
import {
  IconActivity,
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconBolt,
  IconBrandGithub,
  IconBriefcase,
  IconBuildingStore,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCode,
  IconCopy,
  IconDots,
  IconFileDescription,
  IconGitBranch,
  IconGitMerge,
  IconLayoutSidebarRightCollapse,
  IconListCheck,
  IconLock,
  IconMessageCircle,
  IconPackageExport,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconRocket,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconSparkles,
  IconUsers,
  IconX,
} from '@tabler/icons-react';

const Icon = ({ component: Component, size = 17, stroke = 1.8 }) => (
  <Component size={size} stroke={stroke} aria-hidden="true" />
);

const employees = [
  { id: 'product', name: '产品经理', avatar: '产', role: '产品', domain: '通用', builtIn: true, runtime: 'Codex', skills: ['requirement-analysis', 'stage-delivery'], tone: 'blue' },
  { id: 'frontend', name: '前端开发', avatar: '前', role: '开发', domain: 'Web / Electron', builtIn: true, runtime: 'Codex', skills: ['react-best-practices', 'repo-inspector'], tone: 'violet' },
  { id: 'reviewer', name: '代码审查员', avatar: '审', role: '审查', domain: '工程质量', builtIn: true, runtime: 'Codex', skills: ['code-review', 'security-check'], tone: 'teal' },
  { id: 'css-qa', name: 'CSS 测试员工', avatar: '测', role: '测试', domain: 'CSS 客服', builtIn: false, runtime: 'Pi', skills: ['css-regression', 'mis-sandbox'], tone: 'amber' },
  { id: 'pim-product', name: 'PIM 产品员工', avatar: 'P', role: '产品', domain: 'PIM 商品', builtIn: false, runtime: 'Codex', skills: ['pim-domain', 'requirement-analysis'], tone: 'rose' },
  { id: 'release', name: '部署员工', avatar: '部', role: '部署', domain: 'Zeus Desktop', builtIn: true, runtime: 'Codex', skills: ['release-check', 'artifact-signing'], tone: 'slate' },
];

const stageSeed = [
  { id: 'plan', no: '01', name: '计划', description: '需求拆解与实施计划', status: 'accepted', employee: '产品经理', skill: 'requirement-analysis', output: '实施计划 v2' },
  { id: 'implement', no: '02', name: '实施', description: '代码变更与自检', status: 'accepted', employee: '前端开发', skill: 'react-best-practices', output: '变更集 v4' },
  { id: 'review', no: '03', name: '代码审查', description: '基线与工作区审查', status: 'reviewing', employee: '代码审查员', skill: 'code-review', output: '审查报告 v1' },
  { id: 'test', no: '04', name: '测试', description: '关键路径与边界验证', status: 'locked', employee: 'CSS 测试员工', skill: 'css-regression', output: '验证记录' },
  { id: 'deploy', no: '05', name: '部署', description: '审批后执行交付动作', status: 'locked', employee: '部署员工', skill: 'release-check', output: '发布回执' },
];

const stageCopy = {
  accepted: ['已验收', 'success'],
  reviewing: ['待审查', 'warning'],
  ready: ['可开始', 'info'],
  locked: ['等待上游', 'neutral'],
  running: ['执行中', 'running'],
};

function Button({ children, icon, variant = 'secondary', onClick, disabled = false, className = '' }) {
  return (
    <button className={`button button-${variant} ${className}`} type="button" onClick={onClick} disabled={disabled}>
      {icon ? <Icon component={icon} size={16} /> : null}
      <span>{children}</span>
    </button>
  );
}

function Badge({ children, tone = 'neutral', dot = false }) {
  return <span className={`badge badge-${tone}`}>{dot ? <i /> : null}{children}</span>;
}

function SelectBox({ children }) {
  return (
    <button className="select-box" type="button">
      <strong>{children}</strong>
      <Icon component={IconChevronDown} size={15} />
    </button>
  );
}

function Avatar({ employee, small = false }) {
  return <span className={`avatar avatar-${employee.tone} ${small ? 'avatar-small' : ''}`}>{employee.avatar}</span>;
}

function Toast({ message, onClose }) {
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <Icon component={IconCircleCheck} size={18} />
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示"><Icon component={IconX} size={15} /></button>
    </div>
  );
}

function AppSidebar({ view, setView }) {
  return (
    <aside className="app-sidebar">
      <div className="window-controls" aria-hidden="true"><i /><i /><i /></div>
      <nav className="global-nav" aria-label="全局导航">
        <button type="button"><Icon component={IconPlus} /><strong>新对话</strong></button>
        <button type="button"><Icon component={IconSearch} /><strong>搜索</strong></button>
      </nav>
      <div className="sidebar-section-label"><span>项目</span><Icon component={IconAdjustmentsHorizontal} size={15} /></div>
      <button className="project-switch" type="button">
        <Icon component={IconBriefcase} />
        <strong>ZEUS-0352 Harness</strong>
        <Icon component={IconChevronDown} size={14} />
      </button>
      <nav className="project-nav" aria-label="项目导航">
        <button className={view === 'task' ? 'is-active' : ''} type="button" onClick={() => setView('task')}><Icon component={IconListCheck} /><span>任务</span><em>4</em></button>
        <button type="button"><Icon component={IconMessageCircle} /><span>会话</span><em>7</em></button>
        <button type="button"><Icon component={IconCode} /><span>代码</span></button>
        <button type="button"><Icon component={IconGitBranch} /><span>Git</span></button>
      </nav>
      <div className="sidebar-section-label sidebar-harness-label"><span>Harness</span><Badge tone="blue">NEW</Badge></div>
      <nav className="project-nav" aria-label="Harness 导航">
        <button className={view === 'employees' ? 'is-active' : ''} type="button" onClick={() => setView('employees')}><Icon component={IconRobot} /><span>数字员工</span><em>6</em></button>
        <button className={view === 'automations' ? 'is-active' : ''} type="button" onClick={() => setView('automations')}><Icon component={IconBolt} /><span>自动化</span><em>3</em></button>
        <button type="button"><Icon component={IconActivity} /><span>运行记录</span></button>
      </nav>
      <div className="sidebar-recent">
        <span>进行中的任务</span>
        <button className="recent-task" type="button" onClick={() => setView('task')}><i className="status-ring" /><span>数字员工 × Skill × 阶段交付</span></button>
        <button className="recent-task" type="button"><i className="status-dot-success" /><span>Skill 配置中心</span></button>
        <button className="recent-task" type="button"><i className="status-dot-warning" /><span>任务审批与交付授权</span></button>
      </div>
      <button className="sidebar-settings" type="button" onClick={() => setView('employees')}><Icon component={IconSettings} /><span>设置</span></button>
    </aside>
  );
}

function TopBar({ view, setView }) {
  const title = view === 'employees' ? '数字员工中心' : view === 'automations' ? '项目自动化' : '任务执行';
  return (
    <header className="topbar">
      <div className="crumbs"><strong>ZEUS-0352 Harness</strong><Icon component={IconChevronRight} size={14} /><span>{title}</span></div>
      <div className="prototype-nav" aria-label="原型页面切换">
        <button className={view === 'employees' ? 'is-active' : ''} type="button" onClick={() => setView('employees')}>员工中心</button>
        <button className={view === 'automations' ? 'is-active' : ''} type="button" onClick={() => setView('automations')}>项目编排</button>
        <button className={view === 'task' ? 'is-active' : ''} type="button" onClick={() => setView('task')}>任务 Harness</button>
      </div>
      <div className="topbar-actions"><Button icon={IconRefresh}>同步</Button><button className="icon-button" type="button"><Icon component={IconDots} /></button></div>
    </header>
  );
}

function EmployeeCenter({ showToast }) {
  const [selectedId, setSelectedId] = useState('reviewer');
  const [query, setQuery] = useState('');
  const [skillOpen, setSkillOpen] = useState(false);
  const selected = employees.find((employee) => employee.id === selectedId) ?? employees[0];
  const visible = employees.filter((employee) => `${employee.name}${employee.role}${employee.domain}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <main className="screen employee-screen">
      <section className="screen-heading">
        <div><div className="eyebrow"><Icon component={IconUsers} size={15} />组织能力</div><h1>数字员工中心</h1><p>把岗位、领域知识、Skill、提示词和权限封装为可复用的员工模板。</p></div>
        <Button variant="primary" icon={IconPlus} onClick={() => { setSelectedId('pim-product'); showToast('已创建“PIM 产品员工”草稿'); }}>新建数字员工</Button>
      </section>
      <section className="master-detail-shell">
        <aside className="employee-master">
          <div className="list-toolbar"><label className="search-field"><Icon component={IconSearch} size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索员工、岗位或领域" /></label><button type="button" className="icon-button"><Icon component={IconAdjustmentsHorizontal} /></button></div>
          <div className="filter-row"><button className="is-active" type="button">全部 <span>{employees.length}</span></button><button type="button">内置</button><button type="button">自定义</button></div>
          <div className="employee-list">
            {visible.map((employee) => (
              <button className={`employee-row ${selected.id === employee.id ? 'is-selected' : ''}`} type="button" key={employee.id} onClick={() => setSelectedId(employee.id)}>
                <Avatar employee={employee} /><span><strong>{employee.name}</strong><small>{employee.role} · {employee.domain}</small></span><em>{employee.builtIn ? '内置' : '自定义'}</em>
              </button>
            ))}
          </div>
        </aside>
        <article className="employee-detail">
          <header className="employee-detail-header">
            <div className="employee-identity"><Avatar employee={selected} /><span><div><h2>{selected.name}</h2><Badge tone={selected.builtIn ? 'neutral' : 'violet'}>{selected.builtIn ? '内置基线' : '自定义模板'}</Badge></div><p>{selected.role} · {selected.domain} · {selected.runtime}</p></span></div>
            <div className="header-actions"><Button icon={IconCopy} onClick={() => showToast(`已复制“${selected.name}”为自定义模板`)}>复制模板</Button><Button variant="primary" onClick={() => showToast('员工模板已保存；现有项目副本不会被静默覆盖')}>保存模板</Button></div>
          </header>
          <div className="detail-scroll">
            <section className="form-section">
              <div className="section-title"><span><strong>岗位身份</strong><small>决定员工处理问题的视角和默认工作边界。</small></span></div>
              <div className="field-grid three"><label><span>模板名称</span><input defaultValue={selected.name} /></label><label><span>岗位</span><input defaultValue={selected.role} /></label><label><span>业务领域</span><input defaultValue={selected.domain} /></label></div>
              <label className="wide-field"><span>系统提示词</span><textarea defaultValue={`你是 Zeus 中的${selected.name}。先读取任务上下文和已验收阶段产物，只在授权范围内行动；遇到高风险写操作或信息不足时必须暂停并请求审批。`} /></label>
            </section>
            <section className="form-section">
              <div className="section-title"><span><strong>Skill 能力包</strong><small>员工获得的是 Skill 快照；任务阶段可继续覆盖。</small></span><Button icon={IconPlus} onClick={() => setSkillOpen(!skillOpen)}>添加 Skill</Button></div>
              <div className="skill-stack">
                {selected.skills.map((skill, index) => <div className="skill-row" key={skill}><span className="skill-icon"><Icon component={index ? IconShieldCheck : IconSparkles} /></span><span><strong>{skill}</strong><small>{index ? '边界检查与证据输出' : '执行主流程与产物规范'}</small></span><Badge tone={index ? 'neutral' : 'blue'}>{index ? '辅助' : '默认'}</Badge><button type="button" className="icon-button"><Icon component={IconDots} /></button></div>)}
                {skillOpen ? <div className="skill-picker"><strong>从 Skill 中心添加</strong><button type="button" onClick={() => { setSkillOpen(false); showToast('已添加 stage-delivery Skill'); }}><Icon component={IconPlus} size={15} />stage-delivery <small>阶段交付物规范</small></button><button type="button" onClick={() => { setSkillOpen(false); showToast('已添加 release-safety Skill'); }}><Icon component={IconPlus} size={15} />release-safety <small>高风险交付门禁</small></button></div> : null}
              </div>
            </section>
            <section className="form-section">
              <div className="section-title"><span><strong>运行与权限</strong><small>默认最小权限；具体项目可收窄，不可静默放大。</small></span><Badge tone="success" dot>安全基线通过</Badge></div>
              <div className="field-grid three"><label><span>运行时</span><SelectBox>Codex · gpt-5.6</SelectBox></label><label><span>推理强度</span><SelectBox>高</SelectBox></label><label><span>并发上限</span><SelectBox>1 个任务</SelectBox></label></div>
              <div className="permission-list"><PermissionRow title="读取项目文件与任务上下文" description="项目工作区内只读访问" enabled locked /><PermissionRow title="修改工作区文件" description="只允许 apply_patch；保留变更审计" enabled /><PermissionRow title="执行 shell 命令" description="按命令策略逐项授权" enabled /><PermissionRow title="Commit / Push / Merge / Deploy" description="默认关闭；每次交付必须由人审批" /></div>
            </section>
          </div>
        </article>
      </section>
    </main>
  );
}

function PermissionRow({ title, description, enabled = false, locked = false }) {
  const [checked, setChecked] = useState(enabled);
  return <div className="permission-row"><span className="permission-icon"><Icon component={locked ? IconLock : IconShieldCheck} /></span><span><strong>{title}</strong><small>{description}</small></span><button className={`switch ${checked ? 'is-on' : ''}`} type="button" onClick={() => !locked && setChecked(!checked)} aria-pressed={checked} disabled={locked}><i /></button></div>;
}

function Automations({ showToast, openRuleEditor }) {
  const [tab, setTab] = useState('employees');
  const projectEmployees = [employees[1], employees[2], employees[3], employees[5]];
  return (
    <main className="screen project-screen">
      <section className="screen-heading project-heading"><div><div className="eyebrow"><Icon component={IconBuildingStore} size={15} />项目配置</div><h1>ZEUS-0352 Harness</h1><p>项目员工从模板复制后独立演进；所有自动执行都固定员工与 Skill 快照。</p></div><div className="project-stats"><span><strong>4</strong><small>项目员工</small></span><span><strong>3</strong><small>自动化</small></span><span><strong>2</strong><small>正在执行</small></span></div></section>
      <div className="subtabs"><button className={tab === 'employees' ? 'is-active' : ''} type="button" onClick={() => setTab('employees')}>项目员工</button><button className={tab === 'automations' ? 'is-active' : ''} type="button" onClick={() => setTab('automations')}>自动化规则</button><button className={tab === 'executions' ? 'is-active' : ''} type="button" onClick={() => setTab('executions')}>执行记录</button></div>
      {tab === 'employees' ? <ProjectEmployeeTable employees={projectEmployees} showToast={showToast} /> : null}
      {tab === 'automations' ? <AutomationTable openRuleEditor={openRuleEditor} showToast={showToast} /> : null}
      {tab === 'executions' ? <ExecutionTable /> : null}
    </main>
  );
}

function ProjectEmployeeTable({ employees: projectEmployees, showToast }) {
  return <section className="data-panel"><header className="data-toolbar"><label className="search-field"><Icon component={IconSearch} size={16} /><input placeholder="搜索项目员工" /></label><div><Button icon={IconAdjustmentsHorizontal}>筛选</Button><Button variant="primary" icon={IconPlus} onClick={() => showToast('已打开员工模板选择器')}>从模板添加</Button></div></header><div className="table-header employee-columns"><span>员工</span><span>业务领域</span><span>Skill 快照</span><span>权限</span><span>状态</span><span /></div><div className="table-body">{projectEmployees.map((employee, index) => <ProjectEmployeeRow employee={employee} index={index} key={employee.id} showToast={showToast} />)}</div><footer className="panel-note"><Icon component={IconShieldCheck} size={16} /><span>项目员工是独立配置。模板更新只会提示差异，不会覆盖项目内已验证的提示词、Skill 或权限。</span></footer></section>;
}

function ProjectEmployeeRow({ employee, index, showToast }) {
  const [enabled, setEnabled] = useState(true);
  return <div className="table-row employee-columns"><span className="cell-identity"><Avatar employee={employee} small /><span><strong>{employee.name}</strong><small>{employee.role} · rev.{index + 3}</small></span></span><span><Badge tone="neutral">{employee.domain}</Badge></span><span className="skill-cell"><strong>{employee.skills[0]}</strong><small>+{employee.skills.length - 1} 个</small></span><span><Badge tone={index === 3 ? 'warning' : 'success'}>{index === 3 ? '等待交付审批' : '最小权限'}</Badge></span><span><button className={`switch ${enabled ? 'is-on' : ''}`} type="button" onClick={() => setEnabled(!enabled)} aria-pressed={enabled}><i /></button></span><span><button type="button" className="icon-button" onClick={() => showToast(`已打开“${employee.name}”项目覆盖配置`)}><Icon component={IconChevronRight} /></button></span></div>;
}

function AutomationTable({ openRuleEditor, showToast }) {
  const rules = [
    { name: '新任务自动探索', trigger: '任务创建', employee: employees[0], action: '探索并提交计划', runs: '今日 6 次', active: true },
    { name: '代码变更自动审查', trigger: '实施产物提交', employee: employees[2], action: '结构化代码审查', runs: '今日 3 次', active: true },
    { name: '等待任务自动捞取', trigger: '每 30 分钟', employee: employees[1], action: '捞取待开发任务', runs: '2 小时前', active: false },
  ];
  return <section className="data-panel"><header className="data-toolbar"><div><strong>自动化规则</strong><small>探索、捞取、执行和交付都先进入统一的幂等运行队列。</small></div><Button variant="primary" icon={IconPlus} onClick={openRuleEditor}>新建规则</Button></header><div className="table-header automation-columns"><span>规则</span><span>触发器</span><span>执行员工</span><span>动作</span><span>最近运行</span><span>状态</span></div><div className="table-body">{rules.map((rule) => <AutomationRow rule={rule} key={rule.name} showToast={showToast} />)}</div><div className="automation-boundary"><Icon component={IconShieldCheck} /><span><strong>自动化边界</strong><small>Commit、Push、Merge、Deploy、任务完成等高风险动作永远停在审批关卡。</small></span><Button onClick={() => showToast('已打开项目交付授权策略')}>查看策略</Button></div></section>;
}

function AutomationRow({ rule, showToast }) {
  const [active, setActive] = useState(rule.active);
  return <div className="table-row automation-columns"><span><strong>{rule.name}</strong><small>并发 1 · 失败重试 1 次</small></span><span><Badge tone="blue">{rule.trigger}</Badge></span><span className="cell-identity"><Avatar employee={rule.employee} small /><strong>{rule.employee.name}</strong></span><span>{rule.action}</span><span>{rule.runs}</span><span className="status-actions"><button className={`switch ${active ? 'is-on' : ''}`} type="button" onClick={() => { setActive(!active); showToast(`规则已${active ? '停用' : '启用'}`); }} aria-pressed={active}><i /></button><button className="icon-button" type="button"><Icon component={IconDots} /></button></span></div>;
}

function ExecutionTable() {
  const rows = [['run-8F42', '代码变更自动审查', '代码审查员', '等待人工审查', '4 分 12 秒', 'warning'], ['run-8F41', '新任务自动探索', '产品经理', '已交付计划', '2 分 08 秒', 'success'], ['run-8F39', '等待任务自动捞取', '前端开发', '结果未知，待对账', '12 分 31 秒', 'danger']];
  return <section className="data-panel"><header className="data-toolbar"><div><strong>最近执行</strong><small>每次运行保留员工、Skill、输入、权限和产物的完整快照。</small></div><Button icon={IconRefresh}>刷新</Button></header><div className="table-header execution-columns"><span>运行 ID</span><span>来源</span><span>数字员工</span><span>结果</span><span>耗时</span><span /></div><div className="table-body">{rows.map((row) => <div className="table-row execution-columns" key={row[0]}><span className="mono">{row[0]}</span><span>{row[1]}</span><span>{row[2]}</span><span><Badge tone={row[5]} dot>{row[3]}</Badge></span><span>{row[4]}</span><span><button className="icon-button" type="button"><Icon component={IconChevronRight} /></button></span></div>)}</div></section>;
}

function RuleEditor({ onClose, onSave }) {
  const [trigger, setTrigger] = useState('阶段产物已提交');
  return <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal-card rule-modal" role="dialog" aria-modal="true" aria-labelledby="rule-title"><header><span><Badge tone="blue"><Icon component={IconBolt} size={13} />自动化</Badge><h2 id="rule-title">新建项目自动化</h2><p>让数字员工自动探索、捞取或执行任务，交付动作仍受审批门禁控制。</p></span><button className="icon-button" type="button" onClick={onClose}><Icon component={IconX} /></button></header><div className="modal-body"><label className="wide-field"><span>规则名称</span><input defaultValue="代码变更自动审查" /></label><div className="field-grid two"><label><span>触发器</span><SelectBox>{trigger}</SelectBox></label><label><span>执行员工</span><SelectBox>代码审查员</SelectBox></label></div><div className="trigger-options"><button className={trigger === '任务进入待处理' ? 'is-active' : ''} type="button" onClick={() => setTrigger('任务进入待处理')}><Icon component={IconListCheck} /><span><strong>捞取</strong><small>任务进入待处理</small></span></button><button className={trigger === '阶段产物已提交' ? 'is-active' : ''} type="button" onClick={() => setTrigger('阶段产物已提交')}><Icon component={IconPackageExport} /><span><strong>接力</strong><small>阶段产物已提交</small></span></button><button className={trigger === '按计划探索' ? 'is-active' : ''} type="button" onClick={() => setTrigger('按计划探索')}><Icon component={IconSearch} /><span><strong>探索</strong><small>按计划扫描项目</small></span></button></div><label className="wide-field"><span>任务筛选条件</span><textarea defaultValue={'状态 = “开发完成”\nAND 标签包含 “需要审查”\nAND 当前没有进行中的审查运行'} /></label><div className="field-grid three"><label><span>运行 Skill</span><SelectBox>code-review</SelectBox></label><label><span>并发上限</span><SelectBox>1</SelectBox></label><label><span>失败重试</span><SelectBox>1 次</SelectBox></label></div><div className="approval-note"><Icon component={IconLock} /><span><strong>自动化无法绕过交付审批</strong><small>发现 Commit、Push、Merge、Deploy 或“完成任务”动作时，运行会暂停并生成审批单。</small></span></div></div><footer><Button onClick={onClose}>取消</Button><Button variant="primary" icon={IconBolt} onClick={onSave}>保存并启用</Button></footer></section></div>;
}

function TaskHarness({ showToast }) {
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const [stages, setStages] = useState(stageSeed);
  const [activeStageId, setActiveStageId] = useState(initialParams.get('stage') || 'review');
  const [configOpen, setConfigOpen] = useState(initialParams.get('config') === '1');
  const [artifactOpen, setArtifactOpen] = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(initialParams.get('recovery') === '1');
  const [reconciled, setReconciled] = useState(false);
  const activeStage = stages.find((stage) => stage.id === activeStageId) ?? stages[0];
  const accepted = stages.filter((stage) => stage.status === 'accepted').length;
  function acceptReview() {
    setStages((current) => current.map((stage) => stage.id === 'review' ? { ...stage, status: 'accepted' } : stage.id === 'test' ? { ...stage, status: 'ready' } : stage));
    showToast('审查报告已验收；“测试”阶段现已解锁');
  }
  return (
    <main className="task-screen">
      <section className="task-titlebar"><div><span className="task-code">ZEUS-0352</span><h1>引入数字员工与 Harness Engineering</h1><Badge tone="running" dot>进行中</Badge></div><div><Button icon={IconCopy}>复制链接</Button><Button icon={IconDots}>更多</Button></div></section>
      <section className="task-summary-strip"><div><small>执行员工</small><span className="inline-employee"><Avatar employee={employees[2]} small /><strong>代码审查员</strong><Badge tone="violet">Skill 快照</Badge></span></div><div><small>工作流进度</small><strong>{accepted} / {stages.length} 阶段已验收</strong></div><div><small>当前运行</small><strong className="mono">run-8F42 · attempt 1</strong></div><div><small>交付授权</small><Badge tone="warning"><Icon component={IconLock} size={13} />高风险动作待审批</Badge></div><div className="summary-actions"><Button icon={IconAdjustmentsHorizontal} onClick={() => setConfigOpen(true)}>配置阶段</Button><Button variant="primary" icon={IconLayoutSidebarRightCollapse} onClick={() => setArtifactOpen(!artifactOpen)}>{artifactOpen ? '收起产物' : '查看产物'}</Button></div></section>
      {recoveryMode ? <div className={`recovery-banner ${reconciled ? 'is-resolved' : ''}`}><Icon component={reconciled ? IconCircleCheck : IconAlertTriangle} /><span><strong>{reconciled ? '对账完成：远端未产生重复交付' : '交付结果未知，需要对账'}</strong><small>{reconciled ? '本地执行已恢复为“等待审批”，可以安全继续。' : '网络中断发生在提交请求之后；为避免重复 Push，系统已禁止直接重试。'}</small></span>{reconciled ? <Button onClick={() => { setRecoveryMode(false); setReconciled(false); }}>返回审批</Button> : <Button variant="primary" icon={IconRefresh} onClick={() => { setReconciled(true); showToast('已完成 Git 远端、任务状态和交付回执三方对账'); }}>立即对账</Button>}</div> : null}
      <div className={`task-workspace ${artifactOpen ? 'has-artifact' : ''}`}>
        <aside className="stage-rail"><header><span><strong>阶段工作流</strong><small>按已验收产物接力</small></span><button className="icon-button" type="button" onClick={() => setConfigOpen(true)}><Icon component={IconSettings} /></button></header><ol>{stages.map((stage) => { const [status, tone] = stageCopy[stage.status]; return <li key={stage.id}><button className={`${activeStage.id === stage.id ? 'is-active' : ''} is-${stage.status}`} type="button" onClick={() => setActiveStageId(stage.id)}><span className="stage-index">{stage.status === 'accepted' ? <Icon component={IconCheck} size={15} /> : stage.no}</span><span><strong>{stage.name}</strong><small>{stage.description}</small><span className="stage-meta"><Badge tone={tone}>{status}</Badge><em>{stage.employee}</em></span></span></button>{stage.id !== stages.at(-1).id ? <i className="stage-line" /> : null}</li>; })}</ol><footer><Icon component={IconShieldCheck} /><span><strong>阶段隔离</strong><small>独立会话 · 固定快照 · 产物接力</small></span></footer></aside>
        <section className="stage-content"><header className="stage-content-header"><div><span className="stage-kicker">阶段 {activeStage.no}</span><h2>{activeStage.name}</h2><p>{activeStage.description}</p></div><Badge tone={stageCopy[activeStage.status][1]} dot>{stageCopy[activeStage.status][0]}</Badge></header><div className="stage-run-card"><div className="run-employee"><Avatar employee={employees.find((employee) => employee.name === activeStage.employee) ?? employees[0]} /><span><small>本阶段执行员工</small><strong>{activeStage.employee}</strong><p>{activeStage.skill} · Codex gpt-5.6 · 高推理</p></span></div><div className="run-metrics"><span><small>运行时长</small><strong>{activeStage.status === 'locked' ? '—' : '04:12'}</strong></span><span><small>上下文</small><strong>{activeStage.status === 'locked' ? '—' : '41%'}</strong></span><span><small>尝试</small><strong>{activeStage.status === 'locked' ? '0' : '1'}</strong></span></div><Button icon={IconMessageCircle} disabled={activeStage.status === 'locked'} onClick={() => showToast('已打开本阶段隔离会话')}>打开会话</Button></div>{activeStage.id === 'review' ? <ReviewPanel acceptReview={acceptReview} showToast={showToast} /> : null}{activeStage.id === 'deploy' ? <DeliveryPanel recovery={() => { setRecoveryMode(true); setReconciled(false); }} showToast={showToast} /> : null}{activeStage.id !== 'review' && activeStage.id !== 'deploy' ? <GenericStagePanel stage={activeStage} showToast={showToast} /> : null}</section>
        {artifactOpen ? <ArtifactPanel stage={activeStage} onClose={() => setArtifactOpen(false)} showToast={showToast} /> : null}
      </div>
      {configOpen ? <StageConfig stage={activeStage} onClose={() => setConfigOpen(false)} onSave={() => { setConfigOpen(false); showToast(`${activeStage.name}阶段配置已保存为新快照`); }} /> : null}
    </main>
  );
}

function ReviewPanel({ acceptReview, showToast }) {
  const [filter, setFilter] = useState('全部');
  const findings = [{ severity: 'P1', tone: 'danger', title: '自动化交付授权没有绑定审批版本', file: 'digitalEmployeeOrchestrator.ts:418', detail: '审批后配置仍可能变化，执行动作应固定 delivery_authority_revision。' }, { severity: 'P2', tone: 'warning', title: '阶段 Skill 覆盖缺少来源标识', file: 'TaskWorkflowSection.tsx:286', detail: '用户无法区分员工默认 Skill 与阶段覆盖，影响审计解释。' }, { severity: 'P3', tone: 'neutral', title: '运行记录中的快照摘要可进一步降噪', file: 'ProjectDigitalEmployeesPanel.tsx:512', detail: '将完整提示词折叠为哈希和版本，详情内再展开。' }];
  const visible = filter === '全部' ? findings : findings.filter((finding) => finding.severity === filter);
  return <section className="review-panel"><header><span><strong>结构化代码审查</strong><small>审查冻结基线、暂存、未暂存和未跟踪文件；共 3 条发现。</small></span><div className="review-summary"><Badge tone="danger">1 P1</Badge><Badge tone="warning">1 P2</Badge><Badge tone="neutral">1 P3</Badge></div></header><div className="review-filters">{['全部', 'P1', 'P2', 'P3'].map((item) => <button key={item} className={filter === item ? 'is-active' : ''} type="button" onClick={() => setFilter(item)}>{item}</button>)}<span /><button type="button"><Icon component={IconFileDescription} size={15} />仅看变更文件</button></div><div className="finding-list">{visible.map((finding) => <article className="finding" key={finding.title}><Badge tone={finding.tone}>{finding.severity}</Badge><span><strong>{finding.title}</strong><button type="button" onClick={() => showToast(`已复制 ${finding.file}`)}><Icon component={IconCode} size={14} />{finding.file}</button><p>{finding.detail}</p></span><button className="icon-button" type="button"><Icon component={IconChevronRight} /></button></article>)}</div><footer className="review-actions"><Button variant="danger" onClick={() => showToast('已退回“实施”阶段并携带 2 条必须修复项')}>要求修改</Button><span><small>验收后将解锁“测试”阶段</small><Button variant="primary" icon={IconCheck} onClick={acceptReview}>验收审查报告</Button></span></footer></section>;
}

function GenericStagePanel({ stage, showToast }) {
  const isLocked = stage.status === 'locked';
  return <section className="generic-stage-panel"><div className="generic-state"><span className={`state-illustration is-${stage.status}`}><Icon component={isLocked ? IconLock : stage.status === 'accepted' ? IconCircleCheck : IconPlayerPlay} size={28} /></span><span><h3>{isLocked ? '等待上游阶段验收' : stage.status === 'accepted' ? `${stage.name}阶段已验收` : `${stage.name}阶段可以开始`}</h3><p>{isLocked ? '上游产物验收后，系统会编译为本阶段的受控上下文。' : stage.status === 'accepted' ? `正式产物“${stage.output}”已经进入任务审计链。` : '员工、Skill、提示词和权限快照已经就绪。'}</p></span></div><div className="input-contract"><header><strong>输入契约</strong><Badge tone="success">上下文已编译</Badge></header><div><span><Icon component={IconFileDescription} /><strong>上游已验收产物</strong><small>计划/实施结果只读挂载</small></span><span><Icon component={IconShieldCheck} /><strong>执行边界</strong><small>项目路径内最小权限</small></span><span><Icon component={IconSparkles} /><strong>Skill 快照</strong><small>{stage.skill}</small></span></div></div><footer><Button icon={IconSettings} onClick={() => showToast('已打开阶段配置')}>调整配置</Button><Button variant="primary" icon={IconPlayerPlay} disabled={isLocked} onClick={() => showToast(`${stage.name}阶段已进入执行队列`)}>开始执行</Button></footer></section>;
}

function DeliveryPanel({ recovery, showToast }) {
  const [approved, setApproved] = useState(false);
  const [actions, setActions] = useState({ commit: true, push: true, merge: false, deploy: false, complete: true });
  function toggle(key) { setActions((current) => ({ ...current, [key]: !current[key] })); }
  const selected = Object.values(actions).filter(Boolean).length;
  return <section className="delivery-panel"><div className="approval-hero"><span className="approval-lock"><Icon component={IconLock} size={23} /></span><span><Badge tone="warning">人工审批关卡</Badge><h3>准备执行 {selected} 个高风险交付动作</h3><p>系统已冻结变更集、目标分支、产物哈希与员工配置。审批只对本次快照有效。</p></span></div><div className="delivery-actions-list"><DeliveryAction icon={IconBrandGithub} title="Commit" description="提交当前已暂存变更" checked={actions.commit} onToggle={() => toggle('commit')} /><DeliveryAction icon={IconGitBranch} title="Push" description="推送 zeus/ZEUS-0352-task-02" checked={actions.push} onToggle={() => toggle('push')} /><DeliveryAction icon={IconGitMerge} title="Merge" description="合入目标分支；当前未授权" checked={actions.merge} onToggle={() => toggle('merge')} /><DeliveryAction icon={IconRocket} title="Deploy" description="发布 Zeus Test.app" checked={actions.deploy} onToggle={() => toggle('deploy')} /><DeliveryAction icon={IconCircleCheck} title="完成任务" description="写入交付回执并更新任务状态" checked={actions.complete} onToggle={() => toggle('complete')} /></div><label className="approval-check"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /><span><strong>我已核对目标分支、变更范围和交付动作</strong><small>授权对象：本次运行快照 run-8F42 · 有效期 10 分钟</small></span></label><footer><Button icon={IconAlertTriangle} onClick={recovery}>预览异常恢复</Button><span><Button onClick={() => showToast('审批已驳回，任务保持进行中')}>驳回</Button><Button variant="primary" icon={IconRocket} disabled={!approved || selected === 0} onClick={() => showToast('交付动作已进入串行执行；每一步都会生成独立回执')}>批准并执行</Button></span></footer></section>;
}

function DeliveryAction({ icon, title, description, checked, onToggle }) {
  return <button className={`delivery-action ${checked ? 'is-selected' : ''}`} type="button" onClick={onToggle}><span className="action-check">{checked ? <Icon component={IconCheck} size={14} /> : null}</span><Icon component={icon} /><span><strong>{title}</strong><small>{description}</small></span></button>;
}

function ArtifactPanel({ stage, onClose, showToast }) {
  return <aside className="artifact-panel"><header><span><small>正式交付物</small><strong>{stage.output}</strong></span><button className="icon-button" type="button" onClick={onClose}><Icon component={IconX} /></button></header><div className="artifact-meta"><span><small>状态</small><Badge tone={stage.status === 'accepted' ? 'success' : 'warning'}>{stage.status === 'accepted' ? '已验收' : '已提交'}</Badge></span><span><small>版本</small><strong>v{stage.id === 'implement' ? '4' : stage.id === 'plan' ? '2' : '1'}</strong></span><span><small>生成者</small><strong>{stage.employee}</strong></span></div><div className="artifact-tabs"><button className="is-active" type="button">预览</button><button type="button">证据</button><button type="button">版本</button></div><div className="artifact-content"><h3>{stage.id === 'review' ? '代码审查报告' : stage.output}</h3><p className="artifact-lead">本产物由阶段隔离会话生成，已关联输入快照、Skill 版本与完整执行证据。</p><h4>结论</h4><p>{stage.id === 'review' ? '当前实现方向正确，但存在 1 个交付授权边界问题和 1 个审计解释问题，建议修改后进入测试。' : '阶段目标已经完成，输出满足下一阶段输入契约。'}</p><h4>覆盖范围</h4><ul><li>数字员工配置与项目副本</li><li>Skill 快照与阶段覆盖</li><li>阶段产物、审查和审批门禁</li></ul><div className="artifact-hash"><span><Icon component={IconShieldCheck} /><small>SHA-256</small></span><code>9e48c6…7a21</code><button className="icon-button" type="button" onClick={() => showToast('产物哈希已复制')}><Icon component={IconCopy} /></button></div></div><footer><Button icon={IconMessageCircle} onClick={() => showToast('已打开产物关联会话')}>查看来源会话</Button><Button variant="primary" icon={IconPackageExport} onClick={() => showToast('已导出当前版本交付物')}>导出</Button></footer></aside>;
}

function StageConfig({ stage, onClose, onSave }) {
  const [inheritSkill, setInheritSkill] = useState(true);
  return <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="config-drawer" role="dialog" aria-modal="true" aria-labelledby="config-title"><header><span><small>阶段 {stage.no}</small><h2 id="config-title">配置“{stage.name}”</h2><p>变更只影响下一次执行，并形成新的阶段快照。</p></span><button className="icon-button" type="button" onClick={onClose}><Icon component={IconX} /></button></header><div className="drawer-scroll"><section><h3>执行员工</h3><label className="wide-field"><span>项目数字员工</span><SelectBox>{stage.employee}</SelectBox></label><div className="snapshot-note"><Avatar employee={employees.find((employee) => employee.name === stage.employee) ?? employees[0]} small /><span><strong>项目副本 rev.4</strong><small>提示词、权限和运行时将在启动时冻结。</small></span><Badge tone="success">已启用</Badge></div></section><section><h3>Skill 策略</h3><label className="radio-card"><input type="radio" checked={inheritSkill} onChange={() => setInheritSkill(true)} /><span><strong>继承员工 Skill（推荐）</strong><small>{stage.skill} + 安全边界 Skill</small></span></label><label className="radio-card"><input type="radio" checked={!inheritSkill} onChange={() => setInheritSkill(false)} /><span><strong>覆盖本阶段 Skill</strong><small>选择独立 Skill 组合并记录覆盖来源</small></span></label>{!inheritSkill ? <label className="wide-field nested"><span>阶段 Skill</span><SelectBox>code-review + release-safety</SelectBox></label> : null}</section><section><h3>模型与预算</h3><div className="field-grid two"><label><span>模型</span><SelectBox>gpt-5.6 · Codex</SelectBox></label><label><span>推理强度</span><SelectBox>高</SelectBox></label><label><span>Token 预算</span><input defaultValue="120,000" /></label><label><span>最长运行</span><SelectBox>45 分钟</SelectBox></label></div></section><section><h3>输出契约</h3><label className="wide-field"><span>正式产物</span><input defaultValue={stage.output} /></label><label className="wide-field"><span>验收标准</span><textarea defaultValue="必须列出按严重程度排序的问题；每条包含文件、行号、证据、影响和修复建议。" /></label></section><section><h3>接力与失败策略</h3><PermissionRow title="上游验收后自动开始" description="仅当员工、模型、Skill 和权限快照均可用" enabled /><PermissionRow title="失败后自动重试一次" description="有副作用或结果未知时禁止自动重试" /></section></div><footer><Button onClick={onClose}>取消</Button><Button variant="primary" onClick={onSave}>保存阶段配置</Button></footer></aside></div>;
}

export function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [view, setView] = useState(params.get('view') || 'task');
  const [toast, setToast] = useState('');
  const [ruleEditorOpen, setRuleEditorOpen] = useState(params.get('newRule') === '1');
  const toastKey = useMemo(() => toast, [toast]);
  useEffect(() => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('view', view);
    window.history.replaceState({}, '', nextUrl);
  }, [view]);
  function showToast(message) {
    setToast('');
    window.setTimeout(() => setToast(message), 0);
    window.setTimeout(() => setToast((current) => current === message ? '' : current), 3600);
  }
  return <div className="zeus-prototype"><AppSidebar view={view} setView={setView} /><div className="app-content"><TopBar view={view} setView={setView} />{view === 'employees' ? <EmployeeCenter showToast={showToast} /> : null}{view === 'automations' ? <Automations showToast={showToast} openRuleEditor={() => setRuleEditorOpen(true)} /> : null}{view === 'task' ? <TaskHarness showToast={showToast} /> : null}</div>{ruleEditorOpen ? <RuleEditor onClose={() => setRuleEditorOpen(false)} onSave={() => { setRuleEditorOpen(false); showToast('自动化规则已保存并启用'); }} /> : null}<Toast key={toastKey} message={toast} onClose={() => setToast('')} /></div>;
}
