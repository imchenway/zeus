import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App.js';
import type { DashboardSnapshot } from '../src/renderer/apiClient.js';

function createSnapshot(): DashboardSnapshot {
  return {
    app: 'Zeus',
    localServer: { host: '127.0.0.1', port: 48123 },
    projects: [
      {
        id: 'project_real',
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        scanStatus: 'completed',
      },
    ],
    tasks: [
      {
        id: 'task_real',
        projectId: 'project_real',
        title: '分析当前项目结构',
        description: '真实任务',
        status: 'ready',
      },
    ],
    runtime: {
      aiCli: { available: false, reason: '未检测到可用 AI CLI。' },
      telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
    },
    git: {
      isRepository: true,
      branch: 'main',
      changedFiles: ['apps/desktop/src/renderer/App.tsx'],
    },
    graph: { nodeCount: 10, edgeCount: 8, viewCount: 1 },
  };
}

describe('Zeus desktop renderer', () => {
  it('renders first-run project preparation instead of fake projects, tasks or graph data', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('正在连接本地服务');
    expect(html).toContain('选择真实本地代码库');
    expect(html).toContain('workspace-view-projects');
    expect(html).not.toContain('Activity Stream');
    expect(html).not.toContain('Context Rail');
    expect(html).not.toContain('Mock');
    expect(html).not.toContain('Demo');
  });

  it('renders a focused AI native shell instead of a feature menu or card dashboard', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);

    expect(html).toContain('class="zeus-shell ai-native-shell');
    expect(html).toContain('macos-ai-app');
    expect(html).toContain('codex-thread-workbench');
    expect(sidebar).toContain('href="#projects"');
    expect(sidebar).toContain('href="#conversations"');
    expect(sidebar).toContain('href="#settings"');
    for (const oldTarget of ['dashboard', 'tasks', 'code-map', 'runtime', 'git-diff', 'telegram']) {
      expect(sidebar).not.toContain(`href="#${oldTarget}"`);
    }
    for (const oldCopy of ['任务</strong>', '本地 CLI 对话', 'Local AI Workbench', 'Zeus Workspaces', 'Preferences']) {
      expect(sidebar).not.toContain(oldCopy);
    }
  });

  it('keeps macOS hidden-titlebar top gutters draggable while controls remain non-drag', () => {
    const html = renderToStaticMarkup(<App />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(html).toContain('class="window-drag-strip"');
    expect(css).toContain('Codex macOS 隐藏标题栏手动拖拽区');
    expect(css).toMatch(/\.macos-ai-app \.window-drag-strip\s*\{[^}]*position:\s*fixed[^}]*height:\s*56px/s);
    expect(css).not.toMatch(/\.macos-ai-app \.window-drag-strip\s*\{[^}]*-webkit-app-region:\s*drag/s);
    expect(css).toMatch(/\.macos-ai-app :where\(button,\s*a,\s*input,\s*select,\s*textarea,\s*summary,\s*label\)[\s\S]*-webkit-app-region:\s*no-drag/s);
    expect(source).toContain('handleWindowDragPointerDown');
    expect(source).toContain('beginWindowDrag');
    expect(source).toContain('moveWindowDrag');
    expect(source).toContain('endWindowDrag');
  });

  it('removes decorative global labels, brand subtitles and repeated context headings from rendered pages', () => {
    const html = [renderToStaticMarkup(<App />), renderToStaticMarkup(<App initialMainNavTarget="projects" />), renderToStaticMarkup(<App initialMainNavTarget="tasks" />), renderToStaticMarkup(<App initialMainNavTarget="settings" />)].join(
      '\n',
    );

    for (const removedCopy of ['Live Workspace', 'LIVE WORKSPACE', 'Context Inspector · Context Rail', 'Local AI Workbench', 'ZEUS WORKSPACES', 'PREFERENCES', '当前上下文', '外部配置等待项']) {
      expect(html).not.toContain(removedCopy);
    }
  });

  it('treats legacy targets as collected subviews rather than standalone first-level pages', () => {
    expect(renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />)).toContain('workspace-view-conversations');
    expect(renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="runtime" />)).toContain('workspace-view-conversations');
    expect(renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />)).toContain('workspace-view-projects');
    expect(renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="git-diff" />)).toContain('workspace-view-projects');
  });

  it('keeps action buttons disabled before the desktop local client is hydrated', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('正在连接本地服务');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>连接本地服务中<\/button>/);
    expect(html).not.toContain('按钮会在连接完成后启用');
  });

  it('enables the repository picker once the real desktop client callback is available', () => {
    const html = renderToStaticMarkup(
      <App
        localClientStatus="ready"
        onCreateCurrentProject={async () => ({
          app: 'Zeus',
          localServer: { host: '127.0.0.1', port: 1 },
          projects: [],
          tasks: [],
          runtime: {
            aiCli: { available: false, reason: '等待配置' },
            telegram: { enabled: false, reason: '等待 Token' },
          },
          git: { isRepository: false, branch: '', changedFiles: [] },
          graph: { nodeCount: 0, edgeCount: 0, viewCount: 0 },
        })}
      />,
    );

    expect(html).toContain('选择真实本地代码库');
    expect(html).not.toContain('正在连接本地服务');
    expect(html).toMatch(/<button type="button"[^>]*>选择真实本地代码库<\/button>/);
  });

  it('keeps the hydrated desktop snapshot from being stuck on the first connecting render', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('同步 Electron hydration 后传入的真实 snapshot');
    expect(source).toContain('setSnapshot(props.snapshot);');
    expect(source).toContain('syncRecordFromSnapshot');
    expect(source).toContain('setProjectEditForm');
    expect(source).toContain('setTaskEditForm');
  });

  it('does not leave project actions stuck in creating state after a local failure', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const projectActionNames = [
      'searchProjects',
      'loadProjectDetail',
      'loadProjectConfig',
      'loadProjectDatabaseSecret',
      'saveProjectDatabasePassword',
      'clearProjectDatabasePassword',
      'saveProjectConfig',
      'updateProject',
      'deleteProject',
      'createProjectArchiveConfirmation',
      'createCurrentProject',
      'archiveProject',
      'restoreProject',
    ];

    for (const actionName of projectActionNames) {
      const start = source.indexOf(`async function ${actionName}`);
      const end = source.indexOf('\n  async function ', start + 1);
      const actionBlock = source.slice(start, end === -1 ? undefined : end);
      if (!actionBlock.includes("setActionState('creating-project')")) continue;

      expect(actionBlock, `${actionName} should record the failure`).toContain("recordLocalError('renderer-action', error);");
      expect(actionBlock, `${actionName} should unlock the project action state`).toContain("setActionState('failed');");
    }
  });

  it('keeps panes scrollable without native hash jump', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('event.preventDefault();');
    expect(source).toContain('window.history.replaceState');
    expect(source).toContain('workspaceScrollRef.current?.scrollTo');
    expect(css).toMatch(/body\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.macos-ai-app\s*\{[^}]*height:\s*100vh/s);
    expect(css).toMatch(/\.macos-ai-app \.workspace-list-pane,[\s\S]*\.macos-ai-app \.settings-category-list\s*\{[\s\S]*overflow:\s*auto/s);
    expect(css).toMatch(/\.macos-ai-app \.workspace-detail-pane,[\s\S]*\.macos-ai-app \.settings-detail-pane\s*\{[\s\S]*overflow:\s*auto/s);
  });

  it('renders settings as one visible category at a time', () => {
    const html = renderToStaticMarkup(<App initialMainNavTarget="settings" />);

    expect(html).toContain('settings-category-list');
    expect(html).toContain('settings-detail-pane');
    for (const label of ['通用', 'AI CLI / Runtime', 'Telegram', '安全与 Keychain', 'Git 确认', '发布与更新', '缓存与数据']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('当前分类：通用');
    expect(html).not.toContain('settings-section-nav');
    expect(html).not.toContain('安全审计');
    expect(html).not.toContain('轮询与消息日志');
  });

  it('keeps scan graph and diff review reachable inside the project workspace', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialMainNavTarget="projects"
        localClientStatus="ready"
        onScanCurrentGraph={async () => createSnapshot()}
        onLoadGitDiff={async () => ({
          isRepository: true,
          branch: 'main',
          clean: false,
          files: ['apps/desktop/src/renderer/App.tsx'],
          fileDiffs: [],
          conflictCount: 0,
          remoteStatus: { ahead: 0, behind: 0, hasUpstream: true },
          generatedAt: new Date(0).toISOString(),
        })}
      />,
    );

    expect(html).toContain('workspace-view-projects');
    expect(html).toContain('扫描项目');
    expect(html).toContain('打开图谱');
    expect(html).toContain('查看变更');

    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain("setProjectPanel('graph')");
    expect(source).not.toContain("handleMainNavigate('code-map')");
  });

  it('uses an Apple white flat control system for buttons, selects, inputs and textareas', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Codex 全局控件统一风格');
    expect(css).toContain('Apple 白色扁平控件体系');
    expect(css).toContain('Codex macOS 设置组件对齐');
    expect(css).toContain('--zeus-native-surface');
    expect(css).toContain('--zeus-native-row-separator');
    expect(css).toMatch(/\.macos-ai-app \.native-settings-card\s*\{[^}]*border-radius:\s*14px/s);
    expect(css).toMatch(/\.macos-ai-app \.native-control-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.macos-ai-app \.native-list-card\s*\{[^}]*border-radius:\s*14px/s);
    expect(css).toMatch(/\.macos-ai-app \.native-switch-input::before\s*\{[^}]*border-radius:\s*999px/s);
    expect(css).toMatch(/button,\nselect,\ninput,\ntextarea\s*\{[^}]*border-radius:\s*10px/s);
    expect(css).toMatch(/button\s*\{[^}]*background:\s*oklch\(99\.6% 0\.003 255\)/s);
    expect(css).toMatch(/\.macos-ai-app \.primary-action-row button:first-child\s*\{[^}]*background:\s*oklch\(99\.6% 0\.003 255\)/s);
    expect(css).toMatch(/input,\ntextarea,\nselect\s*\{[^}]*box-shadow:\s*inset 0 1px 2px/s);
    expect(css).toContain('appearance: none;');
    expect(css).toContain('box-shadow: 0 0 0 3px oklch(62% 0.16 252 / 0.18);');
    expect(css).not.toContain('#f4f4f5');
    expect(css).not.toContain('oklch(58% 0.16 274)');
  });

  it('keeps packaged repository creation portable when the native directory picker is cancelled', () => {
    const source = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');

    expect(source).toContain('resolveProjectDirectoryForCreation');
    expect(source).toContain('用户取消选择，已保留当前项目列表');
    expect(source).not.toContain('/Users/david/hypha/zeus');
    expect(source).not.toContain('当前 Zeus 代码库');
  });
});
