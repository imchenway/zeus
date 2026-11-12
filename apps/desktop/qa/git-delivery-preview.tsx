import { useContext, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultGitDeliverySettings, type GitDeliveryRun, type GitDeliveryStep } from '@zeus/shared';
import { FolderIcon } from '@phosphor-icons/react/dist/csr/Folder';
import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GithubLogoIcon } from '@phosphor-icons/react/dist/csr/GithubLogo';
import { GlobeSimpleIcon } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import { TerminalWindowIcon } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { GitDeliveryActions } from '../src/renderer/git/GitDeliveryWorkspace.js';
import { GitDeliveryProgress } from '../src/renderer/git/GitDeliveryProgress.js';
import { GitDeliveryCommandSelect } from '../src/renderer/git/GitDeliveryCommandSelect.js';
import { GitDeliveryCombinationContext } from '../src/renderer/git/gitDeliverySettings.js';
import { Button } from '../src/renderer/ui/Button.js';
import { FormDialog } from '../src/renderer/ui/FormDialog.js';
import { ZeusSelect } from '../src/renderer/ZeusSelect.js';
import { installIconTooltips } from '../src/preload/iconTooltip.js';
import '../src/renderer/styles.css';
import '../src/renderer/session/session.css';
import '../src/renderer/agentdesk-theme.css';
import '../src/renderer/ui/primitives.css';
import './git-delivery-preview.css';

/** 展示控件布局，不连接任何 Git 或命令执行接口。 */
function displayAction(): void {}

/** 组合设置预览复用正式页面的选择器、按钮及共享设置状态。 */
function PreviewCompletion() {
  /** 此组件只挂载在正式交付操作栏的共享上下文内。 */
  const combination = useContext(GitDeliveryCombinationContext)!;
  /** 收尾状态只保存在当前预览页面。 */
  const [status, setStatus] = useState('completed');
  /** 演示目录只有名称和身份，不能发起真实命令。 */
  const commands = [
    { id: 'release', title: '一键升级发布 Zeus' },
    { id: 'package', title: '生成桌面安装包' },
    { id: 'changelog', title: '生成更新日志' },
  ];
  /** 多选与排序只修改预览内存，不写入项目设置。 */
  const [selectedCommandIds, setSelectedCommandIds] = useState(['release']);
  return (
    <>
      <section className="git-delivery-command-selection" data-enabled={combination.settings.push}>
        <div className="task-git-delivery-field-row">
          <span>推送后命令</span>
          <GitDeliveryCommandSelect commands={commands} selectedIds={selectedCommandIds} onChange={setSelectedCommandIds} zh disabled={!combination.settings.push} />
        </div>
      </section>
      <section className="git-delivery-completion">
        <div className="task-git-delivery-field-row">
          <span>交付后状态</span>
          <ZeusSelect
            size="compact"
            ariaLabel="交付后任务状态"
            value={status}
            options={[
              { value: 'completed', label: '已完成' },
              { value: 'unchanged', label: '不变更' },
            ]}
            onChange={setStatus}
          />
        </div>
      </section>
      <section className="git-delivery-combination">
        <div className="git-delivery-combination-buttons">
          <Button variant="primary" size="compact" disabled={!combination.settings.commit && !combination.settings.merge && !combination.settings.push} onClick={displayAction}>
            {(['commit', 'merge', 'push'] as const)
              .filter((action) => combination.settings[action])
              .map((action) => ({ commit: '提交', merge: '合入', push: '推送' })[action])
              .concat(selectedCommandIds.length && combination.settings.push ? [`命令（${selectedCommandIds.length}）`] : [])
              .join(' → ') || '执行交付'}
          </Button>
        </div>
      </section>
      {combination.settingsOpen ? (
        <FormDialog
          title="组合操作设置"
          zh
          submitLabel="完成"
          onClose={() => combination.setSettingsOpen(false)}
          onSubmit={(event) => {
            event.preventDefault();
            combination.setSettingsOpen(false);
          }}
        >
          <label>
            <span>AI 冲突处理权限</span>
            <ZeusSelect
              ariaLabel="AI 冲突处理权限"
              value={combination.settings.permissionMode}
              options={[
                { value: 'auto', label: '自动审批' },
                { value: 'full-access', label: '完全访问' },
              ]}
              onChange={(value) => combination.setSettings((current) => ({ ...current, permissionMode: value as 'auto' | 'full-access' }))}
            />
          </label>
        </FormDialog>
      ) : null}
    </>
  );
}

/** 使用正式操作栏和进度组件展示布局，示例状态由页首控件选择。 */
function DeliveryPreview() {
  /** 主题切换仅影响预览。 */
  const [theme, setTheme] = useState('light');
  /** 窄栏只调整预览容器，用于查看正式组件的自适应布局。 */
  const [narrow, setNarrow] = useState(false);
  /** 步骤序号按用户截图展示为 3/4，待处理停在合入步骤。 */
  const [phase, setPhase] = useState('running');
  /** 用户可查看正式选择器和文本框的编辑、换行及焦点样式。 */
  const [message, setMessage] = useState('style: 优化环境卡片和代码交付布局');
  /** 目标分支只在预览的内存中切换。 */
  const [branch, setBranch] = useState('main');
  /** 合入方式复用正式参数类型。 */
  const [mode, setMode] = useState<'merge' | 'squash'>('merge');
  /** 演示步骤不写入持久运行记录。 */
  const steps: GitDeliveryStep[] = (['commit', 'merge', 'push', 'task_status'] as const).map((action, index) => ({
    id: `preview-${action}`,
    action,
    repositoryId: action === 'task_status' ? null : 'zeus',
    repositoryName: action === 'task_status' ? '' : 'Zeus',
    state: phase === 'succeeded' ? 'succeeded' : phase === 'queued' ? 'pending' : phase === 'attention' ? (index === 0 ? 'succeeded' : index === 1 ? 'attention' : 'pending') : index < 3 ? 'succeeded' : 'running',
    message: phase === 'attention' && index === 1 ? '目标分支存在冲突，请先处理冲突后继续交付。' : null,
    conversationId: null,
    integrationId: null,
  }));
  /** 固定示例只供正式进度组件读取，不启动后台执行器。 */
  const run: GitDeliveryRun = {
    id: 'layout-preview',
    projectId: 'layout-preview',
    scope: { kind: 'task', taskId: 'ZEUS-1037' },
    input: { scope: { kind: 'task', taskId: 'ZEUS-1037' }, settings: defaultGitDeliverySettings, message, mode, repositories: [] },
    state: phase === 'attention' ? 'attention' : phase === 'succeeded' ? 'succeeded' : phase === 'queued' ? 'queued' : 'running',
    createdAt: '',
    updatedAt: '',
    steps,
  };
  return (
    <main className={`preview-app macos-ai-app zeus-shell session-codex-parity-v1 theme-${theme}`} data-narrow={narrow}>
      <header className="preview-toolbar">
        <div>
          <h1>环境卡片与代码交付</h1>
          <p>样式预览 · 演示数据</p>
        </div>
        <nav aria-label="预览设置">
          <ZeusSelect
            size="compact"
            ariaLabel="预览状态"
            value={phase}
            onChange={setPhase}
            options={[
              { value: 'queued', label: '等待执行 · 0/4' },
              { value: 'running', label: '执行中 · 3/4' },
              { value: 'attention', label: '需要处理 · 1/4' },
              { value: 'succeeded', label: '已完成 · 4/4' },
            ]}
          />
          <Button size="compact" onClick={() => setTheme((value) => (value === 'light' ? 'dark' : 'light'))}>
            {theme === 'light' ? '深色' : '浅色'}
          </Button>
          <Button size="compact" aria-pressed={narrow} onClick={() => setNarrow((value) => !value)}>
            {narrow ? '标准宽度' : '窄栏'}
          </Button>
        </nav>
      </header>
      <div className="preview-columns">
        <div>
          <p className="preview-caption">环境卡片</p>
          <section className="session-quick-actions-card preview-environment">
            <header>
              <strong>环境</strong>
              <span>ZEUS-1037</span>
            </header>
            <div className="session-quick-actions-list">
              <div className="session-quick-actions-row is-static">
                <FolderIcon aria-hidden="true" />
                <span className="session-quick-actions-copy">
                  <strong>工作目录</strong>
                  <small>…/ZEUS-1037</small>
                </span>
              </div>
              <div className="session-quick-actions-row is-static">
                <GitBranchIcon aria-hidden="true" />
                <span className="session-quick-actions-copy">
                  <strong>zeus/ZEUS-1037</strong>
                  <small>来源分支 main</small>
                </span>
              </div>
              <button className="session-quick-actions-row">
                <GlobeSimpleIcon aria-hidden="true" />
                <span className="session-quick-actions-copy">
                  <strong>浏览器</strong>
                </span>
              </button>
              <button className="session-quick-actions-row">
                <TerminalWindowIcon aria-hidden="true" />
                <span className="session-quick-actions-copy">
                  <strong>会话终端</strong>
                </span>
              </button>
              <button className="session-quick-actions-row">
                <FileCodeIcon aria-hidden="true" />
                <span className="session-quick-actions-copy">
                  <strong>代码审查</strong>
                </span>
              </button>
              <div className="session-quick-actions-delivery">
                <button className="session-quick-actions-row">
                  <GithubLogoIcon aria-hidden="true" />
                  <span className="session-quick-actions-copy">
                    <strong>代码交付</strong>
                  </span>
                  {phase === 'succeeded' ? <CheckCircleIcon className="session-quick-actions-delivery-status" data-state="clean" aria-label="工作区干净" /> : null}
                </button>
                {phase === 'succeeded' ? null : (
                  <div className="session-quick-actions-delivery-progress">
                    <GitDeliveryProgress run={run} zh />
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
        <div>
          <p className="preview-caption">代码交付 · 配置布局</p>
          <section className="preview-delivery-window">
            <header>
              <GithubLogoIcon aria-hidden="true" />
              <strong>代码交付</strong>
            </header>
            <GitDeliveryActions
              zh
              busyAction={null}
              generationClient={null}
              projectId="zeus-1037-layout-preview"
              canGenerate={false}
              onGenerate={displayAction}
              message={message}
              onMessageChange={setMessage}
              generationFeedback=""
              commitCount={1}
              onCommit={displayAction}
              mergeTargets={[{ repositoryId: 'zeus', label: 'Zeus', value: branch, branches: ['main', 'develop'] }]}
              onMergeTargetChange={(_id, value) => setBranch(value)}
              mergeDisabled={false}
              mode={mode}
              onModeChange={setMode}
              mergeCount={1}
              mergeAll
              onMerge={displayAction}
              pushCount={1}
              onPush={displayAction}
              combination={<PreviewCompletion />}
            />
          </section>
        </div>
      </div>
    </main>
  );
}

/** 预览沿用正式窗口的悬浮提示，并随页面关闭释放监听。 */
const disposeIconTooltips = installIconTooltips(document);
window.addEventListener('pagehide', disposeIconTooltips, { once: true });

/** 独立预览入口不加载桌面桥接或业务请求。 */
createRoot(document.getElementById('root')!).render(<DeliveryPreview />);
