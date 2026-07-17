import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App, buildDefaultTaskDraft, buildGraphNodeTaskIntent, buildProjectDirectoryResolution, buildTemplateTaskDraft } from '../src/renderer/App.js';
import type { AppShellSettings, DashboardSnapshot, ProjectConfig } from '../src/renderer/apiClient.js';
import type { NativeConversationChoice, NativeConversationChoicesSnapshot } from '../src/renderer/session/sessionTypes.js';

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

function createProjectConfig(): ProjectConfig {
  return {
    projectId: 'project_real',
    defaultModel: null,
    defaultWorkMode: 'plan',
    defaultTaskPrompt: '',
    scan: { ignoreDirectories: ['node_modules'], indexScope: 'project' },
    language: { primary: 'typescript', additional: ['javascript'] },
    dependencies: { packageManagers: ['pnpm'], manifestPaths: ['package.json'] },
    vcs: { isGitRepository: true, gitRoot: '/Users/david/hypha/zeus' },
    database: { connectionName: null, schemaPaths: [] },
    telegram: { alias: null },
    security: { allowShell: false, allowGitWrite: false },
  };
}

function createAppShellSettings(appLanguage: AppShellSettings['appLanguage']): AppShellSettings {
  return {
    appLanguage,
    appearance: 'system',
    webviewDebugEnabled: false,
    developerModeEnabled: false,
    multiWindowEnabled: true,
    backgroundModeEnabled: true,
    desktopNotificationsEnabled: true,
    openAtLoginEnabled: false,
    autoUpdateChannel: 'manual',
    defaultProjectId: null,
    pinnedProjectIds: [],
    defaultModel: 'gpt-5-codex',
    defaultTaskTemplateId: null,
    localLogDirectory: 'Zeus/logs',
    localConfigPath: 'Zeus/zeus.config.json',
    dataPortability: { importSupported: true, exportSupported: true, redactsSecrets: true },
    cache: { codeIndex: true, graphView: true, layout: true },
    lastCacheClearAt: null,
  };
}

function readSessionCss(): string {
  return readFileSync(new URL('../src/renderer/session/session.css', import.meta.url), 'utf8');
}

function readSessionSource(...files: string[]): string {
  return files.map((file) => readFileSync(new URL(`../src/renderer/session/${file}`, import.meta.url), 'utf8')).join('\n');
}

function createNativeConversationChoice(overrides: Partial<NativeConversationChoice> = {}): NativeConversationChoice {
  return {
    id: 'conversation_native',
    projectId: 'project_real',
    taskId: 'task_real',
    title: 'Bug 会话排查',
    summary: '检查真实 app-server 连续对话',
    status: 'active',
    transportKind: 'codex_native',
    providerId: 'codex',
    providerThreadId: 'thread_real',
    providerModel: 'gpt-5-codex',
    providerState: 'ready',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:01:00.000Z',
    archived: false,
    resumable: true,
    readOnly: false,
    ...overrides,
  };
}

function createNativeConversationChoicesSnapshot(choice: NativeConversationChoice): NativeConversationChoicesSnapshot {
  return {
    taskId: 'task_real',
    projectId: 'project_real',
    hasHistory: true,
    requiresChoice: true,
    choices: [choice],
    items: [choice],
  };
}

describe('Zeus desktop renderer', () => {
  it('renders first-run project preparation instead of fake projects, tasks or graph data', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).not.toContain('正在连接本地服务');
    expect(html).toContain('选择真实本地代码库');
    expect(html).toContain('project-first-sidebar');
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
    expect(sidebar).toContain('project-first-sidebar');
    expect(sidebar).toContain('项目列表');
    expect(sidebar).toContain('Zeus');
    expect(sidebar).toContain('project-global-settings');
    for (const oldTarget of ['dashboard', 'projects', 'conversations', 'tasks', 'code-map', 'runtime', 'git-diff', 'telegram']) {
      expect(sidebar).not.toContain(`href="#${oldTarget}"`);
    }
    for (const oldCopy of ['本地 CLI 对话', 'Local AI Workbench', 'Zeus Workspaces', 'Preferences']) {
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
    expect(css).toMatch(/\.macos-ai-app :where\(button,\s*a,\s*input,\s*select,\s*textarea,\s*label\)[\s\S]*-webkit-app-region:\s*no-drag/s);
    expect(source).toContain('handleWindowDragPointerDown');
    expect(source).toContain('beginWindowDrag');
    expect(source).toContain('moveWindowDrag');
    expect(source).toContain('endWindowDrag');
  });

  it('keeps top workspace drawers and buttons above the hidden-titlebar drag layer on every page', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const codeHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />);
    const sessionsHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="runtime" />);
    const settingsHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);
    const projectSettingsHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" initialProjectConfig={createProjectConfig()} />);
    const start = css.indexOf('全页面顶部交互命中区最终覆盖');
    const end = css.indexOf('/* 2026-06-16: 一屏式产品工作区', start);
    const topHitboxCss = css.slice(start, end);

    expect(codeHtml).not.toContain('zeus-object-toolbar');
    expect(codeHtml).toContain('project-code-context-rail');
    expect(projectSettingsHtml).toContain('zeus-object-toolbar');
    expect(sessionsHtml).toContain('session-mobile-source-trigger');
    expect(sessionsHtml).toContain('session-project-conversation-tree');
    expect(sessionsHtml).toContain('session-workspace-root');
    expect(settingsHtml).toContain('settings-section-nav');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const topSurface of ['.zeus-object-toolbar', '.project-code-context-rail', '.settings-section-nav', '.task-table-primary-toolbar', '.task-table-view-toolbar']) {
      expect(topHitboxCss).toContain(topSurface);
    }
    expect(topHitboxCss).toContain('-webkit-app-region: no-drag');
    expect(topHitboxCss).toContain('pointer-events: auto');
    expect(topHitboxCss).toContain('position: relative');
    expect(topHitboxCss).toContain('z-index: 31');
    expect(topHitboxCss).toMatch(/:where\(button,\s*a,\s*input,\s*select,\s*textarea,\s*label\)\s*\{[\s\S]*pointer-events:\s*auto/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app\s*\{[\s\S]*z-index:\s*70/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\s*\{[\s\S]*z-index:\s*72/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.session-mobile-source-trigger\s*\{[\s\S]*position:\s*fixed[\s\S]*z-index:\s*31/);
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
    expect(renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />)).toContain('workspace-view-project-tasks');
    expect(renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="runtime" />)).toContain('workspace-view-project-sessions');
    expect(renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />)).toContain('workspace-view-project-code');
    expect(renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="git-diff" />)).toContain('workspace-view-project-code');
  });

  it('keeps repository actions honest without exposing startup infrastructure state', () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>选择真实本地代码库<\/button>/);
    for (const forbidden of ['正在连接本地服务', '本地服务连接失败', '本机 API 暂不可用', 'Connecting local service', 'Local service unavailable', 'Local API temporarily unavailable']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('removes the retired local-client notice model from source, styles, and both languages', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const rendered = [renderToStaticMarkup(<App />), renderToStaticMarkup(<App initialAppShellSettings={createAppShellSettings('en-US')} />)].join('\n');

    expect(source).not.toContain('LocalClientStatus');
    expect(source).not.toContain('LocalClientNotice');
    expect(source).not.toContain('localClientNotice');
    expect(source).not.toContain('localClientStatus');
    expect(css).not.toContain('local-client-notice');
    for (const forbidden of ['正在连接本地服务', '本地服务连接失败', '本机 API 暂不可用', 'Connecting local service', 'Local service unavailable', 'Local API temporarily unavailable']) {
      expect(`${source}\n${rendered}`).not.toContain(forbidden);
    }
  });

  it('enables the repository picker once the real desktop client callback is available', () => {
    const html = renderToStaticMarkup(
      <App
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
    const sessionCss = readSessionCss();

    expect(source).toContain('event.preventDefault();');
    expect(source).toContain('window.history.replaceState');
    expect(source).toContain('workspaceScrollRef.current?.scrollTo');
    expect(css).toMatch(/body\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).not.toMatch(/\.macos-ai-app\s*\{[^}]*height:\s*100vh/s);
    expect(css).toMatch(/\.macos-ai-app \.ai-workspace\s*\{[\s\S]*height:\s*100vh/s);
    expect(sessionCss).toMatch(/\.session-codex-parity-v1 \.session-transcript\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.macos-ai-app \.workspace-detail-pane,[\s\S]*\.macos-ai-app \.settings-detail-pane\s*\{[\s\S]*overflow:\s*auto/s);
  });

  it('renders settings as one visible section at a time without an inner sidebar', () => {
    const html = renderToStaticMarkup(<App initialMainNavTarget="settings" />);

    expect(html).toContain('settings-section-nav');
    expect(html).toContain('settings-detail-pane');
    for (const label of ['通用', 'AI CLI / Runtime', 'Telegram', '安全与钥匙串', 'Git 确认', '发布与更新', '缓存与数据']) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain('settings-category-list');
    expect(html).not.toContain('当前分类：通用');
    expect(html).not.toContain('settings-current-category');
    expect(html).not.toContain('安全审计');
    expect(html).not.toContain('轮询与消息日志');
  });

  it('normalizes the global settings section navigation into the reference settings sidebar instead of the project source-list', () => {
    const html = renderToStaticMarkup(<App initialMainNavTarget="settings" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('class="settings-section-nav settings-sidebar-nav"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('settings-sidebar-shell');
    expect(html).not.toContain('project-first-sidebar');
    expect(source).toContain('settings-section-button');
    expect(source).not.toContain('settings-category-button');
    expect(css).toContain('Settings reference shell 最终覆盖');
    for (const token of ['--zeus-settings-rail-bg', '--zeus-settings-tab-hover-bg', '--zeus-settings-tab-selected-bg', '--zeus-settings-tab-text', '--zeus-settings-tab-selected-text']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.settings-sidebar-nav\.settings-section-nav\s*\{[\s\S]*display:\s*grid/);
    expect(css).toMatch(/\.macos-ai-app \.settings-section-button\s*\{[\s\S]*color:\s*var\(--zeus-settings-tab-text\)/);
    expect(css).toMatch(/\.macos-ai-app \.settings-section-button:hover:not\(:disabled\),[\s\S]*\.macos-ai-app \.settings-section-button:focus-visible\s*\{[\s\S]*background:\s*var\(--zeus-settings-tab-hover-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.settings-section-button\[aria-selected=['"]true['"]\]\s*\{[\s\S]*background:\s*var\(--zeus-settings-tab-selected-bg\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.settings-category-list button:hover,\s*\n\.macos-ai-app \.settings-category-list button\.selected\s*\{[\s\S]*background:\s*oklch/);
  });

  it('normalizes global settings row actions into a compact action rail instead of loose text and buttons', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('settings-action-meta');
    for (const looseAction of [
      '<span className="settings-row-action-rail">Adapter</span>',
      '<span className="settings-row-action-rail">模型</span>',
      '<span className="settings-row-action-rail">最近 5 条</span>',
      '<span className="settings-row-action-rail">真实发布状态</span>',
    ]) {
      expect(source).not.toContain(looseAction);
    }
    expect(css).toContain('设置行操作区最终覆盖');
    for (const token of ['--zeus-settings-action-rail-bg', '--zeus-settings-action-rail-line', '--zeus-settings-action-meta-bg', '--zeus-settings-action-meta-text']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.settings-row-action-rail\s*\{[\s\S]*background:\s*var\(--zeus-settings-action-rail-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.settings-row-action-rail\s*\{[\s\S]*border:\s*1px solid var\(--zeus-settings-action-rail-line\)/);
    expect(css).toMatch(/\.macos-ai-app \.settings-action-meta\s*\{[\s\S]*background:\s*var\(--zeus-settings-action-meta-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.settings-action-meta\s*\{[\s\S]*color:\s*var\(--zeus-settings-action-meta-text\)/);
  });

  it('keeps scan graph and diff review reachable inside the project workspace', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialMainNavTarget="projects"
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

    expect(html).toContain('workspace-view-project-code');
    expect(html).toContain('扫描项目');
    expect(html).toContain('打开图谱');
    expect(html).toContain('查看变更');

    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain("setActiveProjectSection('code')");
    expect(source).not.toContain("setProjectPanel('graph')");
    expect(source).not.toContain("handleMainNavigate('code-map')");
  });

  it('uses a compact macOS source-list control system instead of large white card buttons', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Source List 最终覆盖');
    expect(css).toContain('--zeus-native-surface');
    expect(css).toContain('--zeus-source-sidebar');
    expect(css).toContain('--zeus-native-row-separator');
    expect(css).toMatch(/\.macos-ai-app \.project-first-sidebar button\s*\{[^}]*box-shadow:\s*none/s);
    expect(css).toMatch(/\.macos-ai-app \.project-first-sidebar button\s*\{[^}]*min-block-size:\s*28px/s);
    expect(css).toMatch(/\.macos-ai-app \.project-first-sidebar \.project-sidebar-row\s*\{[^}]*min-block-size:\s*28px/s);
    expect(css).toMatch(/\.macos-ai-app \.project-first-sidebar \.project-section-menu button\s*\{[^}]*min-block-size:\s*24px/s);
    expect(css).toMatch(/\.macos-ai-app \.session-conversation-tree-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto[^}]*min-block-size:\s*34px[^}]*padding:\s*4px 6px/s);
    expect(css).toMatch(/\.macos-ai-app \.native-settings-pane\s*\{[\s\S]*box-shadow:\s*none/s);
    expect(css).not.toContain('.native-list-pane');
    expect(css).toMatch(/\.macos-ai-app \.native-control-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.macos-ai-app \.native-switch-input::before\s*\{[^}]*border-radius:\s*999px/s);
    expect(css).toMatch(/\.macos-ai-app :where\(input,\s*textarea,\s*select\)\s*\{[^}]*box-shadow:\s*inset 0 1px 1px/s);
    expect(css).toContain('appearance: none;');
    expect(css).not.toContain('linear-gradient(45deg, transparent 50%, var(--zeus-control-muted) 50%)');
    expect(css).not.toContain('calc(100% - 13px) 50%');
    expect(css).not.toContain('padding-inline-end: 28px;');
    expect(css).toContain('box-shadow: 0 0 0 3px oklch(62% 0.16 252 / 0.18);');
    expect(css).not.toContain('#f4f4f5');
    expect(css).not.toContain('oklch(58% 0.16 274)');
  });

  it('uses one restrained product surface across project, task, session, code map and settings pages', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const sessionCss = readSessionCss();

    expect(css).toContain('全页面产品视觉最终覆盖');
    for (const token of ['--zeus-product-canvas', '--zeus-product-panel', '--zeus-product-line', '--zeus-product-text', '--zeus-product-accent']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.workspace-view-project-tasks,[\s\S]*\.macos-ai-app \.workspace-view-settings\s*\{[\s\S]*background:\s*var\(--zeus-product-canvas\)/);
    expect(css).toMatch(/\.macos-ai-app \.workspace-view-project-tasks,[^{}]*\.macos-ai-app \.workspace-view-project-code,[^{}]*\.macos-ai-app \.workspace-view-project-settings\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.workspace-view-project-sessions\s*\{[^}]*grid-template-columns:\s*minmax\(236px,\s*280px\) minmax\(0,\s*1fr\)/);
    expect(css).toContain('.session-list-pane .session-project-conversation-tree');
    expect(css).not.toContain('.project-first-sidebar .session-project-conversation-tree');
    expect(css).toMatch(/\.macos-ai-app \.session-conversation-tree-row\s*\{[^}]*display:\s*grid/s);
    expect(sessionCss).toMatch(/\.session-codex-parity-v1 \.session-workspace-root\s*\{[^}]*background:\s*var\(--session-canvas\)[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.macos-ai-app \.workspace-view-settings\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.workspace-view-project-tasks,[^{}]*\.macos-ai-app \.workspace-view-settings\s*\{[^}]*grid-template-columns:\s*minmax\(248px,\s*280px\) minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.pane-toolbar,[\s\S]*\.macos-ai-app \.integration-state-row\s*\{[\s\S]*min-block-size:\s*40px/);
    expect(css).toMatch(/\.macos-ai-app \.pane-toolbar,[\s\S]*\.macos-ai-app \.integration-state-row\s*\{[\s\S]*border-block-end:\s*1px solid var\(--zeus-product-line\)/);
    expect(css).toMatch(/\.macos-ai-app \.native-settings-pane,[\s\S]*\.macos-ai-app \.git-review-workbench\s*\{[\s\S]*box-shadow:\s*none/);
    expect(css).not.toContain('settings-current-category');
    expect(css).toContain('代码图谱上下文条产品化最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.code-map-context-strip\s*\{[\s\S]*min-block-size:\s*40px/);
    expect(css).not.toContain('.code-map-status-summary');
    expect(css).toMatch(/\.macos-ai-app \.integration-state-row\s*\{[\s\S]*margin-block-end:\s*14px/);
    expect(css).not.toContain('.integration-state-strip');
    expect(css).not.toMatch(/(^|[\s,{>])\.spatial-graph-stage(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-stage-command(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-stage-lanes(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.code-map-drawer-stage(?![\w-])/);
    expect(css).toMatch(/\.macos-ai-app \.code-map-primary-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) 320px/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\s*\{[\s\S]*box-shadow:\s*none/);
  });

  it('keeps the compact app shell single-column so 360px windows do not show only the source list', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('360px compact app shell single-column final cover');
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app\.zeus-shell\.ai-native-shell\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app\.zeus-shell\.ai-native-shell \.project-first-sidebar\s*\{[\s\S]*max-block-size:\s*42vh[\s\S]*overflow:\s*auto/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app\.zeus-shell\.ai-native-shell \.ai-workspace\s*\{[\s\S]*min-block-size:\s*58vh[\s\S]*overflow:\s*auto/);
  });

  it('keeps compact settings readable instead of wrapping tabs and rows into vertical stacks', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('360px settings preferences readability final cover');
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app \.settings-section-nav\s*\{[\s\S]*overflow-x:\s*auto[\s\S]*white-space:\s*nowrap/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app \.settings-section-button\s*\{[\s\S]*flex:\s*0 0 auto[\s\S]*white-space:\s*nowrap/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app \.native-control-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app \.settings-row-field\s*\{[\s\S]*justify-self:\s*start/);
  });

  it('keeps project workspaces responsive across compact widths without pane drift', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const sessionCss = readSessionCss();

    expect(css).toContain('全分辨率工作区响应式最终覆盖');
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.workspace-view-project-tasks,[\s\S]*\.workspace-view-settings\)\s*\{[\s\S]*overflow:\s*hidden/);
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.task-table-workbench,[\s\S]*\.code-map-primary-grid\)\s*\{[\s\S]*max-inline-size:\s*100%/);
    expect(css).toMatch(/@media \(max-width:\s*1180px\)\s*\{[\s\S]*\.macos-ai-app :where\(\.workspace-view-project-sessions\)\s*\{[^}]*grid-template-columns:\s*minmax\(220px,\s*260px\) minmax\(0,\s*1fr\)/);
    expect(css).toMatch(
      /@media \(max-width:\s*1180px\)\s*\{[\s\S]*\.macos-ai-app :where\(\.workspace-view-project-tasks,\s*\.workspace-view-project-code,\s*\.workspace-view-project-settings\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(css).toMatch(/@media \(max-width:\s*1180px\)\s*\{[\s\S]*\.macos-ai-app :where\(\s*\.code-map-primary-grid,[\s\S]*\.task-table-workbench\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.macos-ai-app \.workspace-view-settings\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.session-codex-parity-v1 \.session-list-pane\s*\{[^}]*position:\s*fixed[^}]*transform:\s*translateX\(-105%\)/);
    expect(css).toMatch(/\.session-codex-parity-v1\[data-session-source-rail=['"]open['"]\] \.session-list-pane\s*\{[^}]*transform:\s*translateX\(0\)/);
    expect(sessionCss).toMatch(/@media \(max-width:\s*759px\)\s*\{[\s\S]*--session-gutter:\s*16px/);
    expect(css).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.macos-ai-app \.settings-section-nav\s*\{[\s\S]*inline-size:\s*calc\(100% - 24px\)/);
    expect(css).toContain('代码图谱小窗口高度收缩最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.code-map-primary-grid\s*\{[\s\S]*min-block-size:\s*min\(460px,\s*70vh\)/);
    expect(css).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.macos-ai-app \.code-map-primary-grid\s*\{[\s\S]*min-block-size:\s*0/);
    expect(css).not.toMatch(/grid-template-columns:\s*repeat\(3,\s*1fr\)/);
  });

  it('keeps the app root responsive instead of forcing a desktop minimum viewport', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('窗口根层响应式最终覆盖');
    expect(css).not.toMatch(/body\s*\{[\s\S]*min-width:\s*980px/);
    expect(css).not.toMatch(/body\s*\{[\s\S]*min-height:\s*720px/);
    expect(css).toMatch(/body\s*\{[\s\S]*inline-size:\s*100%[\s\S]*max-inline-size:\s*100vw[\s\S]*min-inline-size:\s*0/);
    expect(css).toMatch(/body\s*\{[\s\S]*min-block-size:\s*100vh[\s\S]*overflow:\s*hidden/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell\s*\{[\s\S]*inline-size:\s*100%[\s\S]*max-inline-size:\s*100vw[\s\S]*min-inline-size:\s*0/);
    const unqualifiedAppRootBlocks = [...css.matchAll(/(?:^|\n)\.macos-ai-app\s*\{[\s\S]*?\n\}/g)].map((match) => match[0]);
    expect(unqualifiedAppRootBlocks.length).toBeGreaterThan(0);
    for (const block of unqualifiedAppRootBlocks) {
      expect(block).not.toMatch(/grid-template-columns|height:\s*100vh|overflow:\s*hidden/);
    }
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app\.zeus-shell\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app :where\(\s*\.ai-sidebar\)\s*\{[\s\S]*height:\s*auto[\s\S]*max-block-size:\s*min\(42vh,\s*320px\)/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app :where\(\s*\.ai-workspace\)\s*\{[\s\S]*height:\s*auto[\s\S]*overflow:\s*auto/);
    expect(css).not.toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.macos-ai-app \.ai-sidebar\s*\{/);
    expect(css).not.toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.macos-ai-app \.ai-workspace\s*\{/);
  });

  it('removes stale page choreography keyframes and empty legacy motion blocks', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('旧页面编排动效清理最终覆盖');
    expect(css).not.toContain('@keyframes zeusThreadEnter');
    expect(css).not.toContain('@keyframes zeusGraphFocus');
    expect(css).not.toContain('@keyframes zeusInspectorReveal');
    expect(css).not.toContain('animation: zeusGraphFocus');
    expect(css).not.toMatch(/\.graph-search-control-grid button:hover:not\(:disabled\),[\s\S]*?\.git-hunk-decision button:hover:not\(:disabled\)\s*\{\s*\}/);
    expect(css).not.toMatch(/\.graph-search-control-grid button:active:not\(:disabled\),[\s\S]*?\.git-hunk-decision button:active:not\(:disabled\)\s*\{\s*\}/);
  });

  it('keeps ordinary product panels flat without legacy heavy shadows', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('普通产品面板厚阴影清理最终覆盖');
    expect(css).not.toContain('0 18px 48px');
    expect(css).not.toContain('0 18px 60px');
    expect(css).not.toContain('-18px 0 48px');
    expect(css).not.toContain('0 14px 34px');
    expect(css).not.toContain('0 12px 28px');
  });

  it('keeps product controls quiet without hover lift or active scale motion', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('全控件安静动效最终覆盖');
    expect(css).not.toContain('transform 120ms ease-out');
    expect(css).not.toContain('transform: translateY(-1px);');
    expect(css).not.toContain('transform: translateY(-0.5px);');
    expect(css).not.toContain('transform: translateY(0) scale(0.985);');
  });

  it('scopes graph runtime and git legacy selectors to the macOS app root', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('旧领域选择器作用域收口最终覆盖');
    const selectorScanCss = css.replace(/:where\([\s\S]*?\)/g, ':where(...)');
    const leakedSelectors = selectorScanCss
      .split('\n')
      .map((line, index) => ({ index: index + 1, line: line.trim() }))
      .filter(
        ({ line }) =>
          /^(\.graph-|\.code-map-|\.git-|\.runtime-|\.xterm-|\.log-|\.workspace\b|\.ai-sidebar\b|\.ai-workspace\b)/.test(line) && !line.includes('macos-ai-app') && !line.startsWith('.zeus-shell') && !line.startsWith('.renderer-crash'),
      );

    expect(leakedSelectors).toEqual([]);
  });

  it('uses OKLCH product colors instead of legacy hex color tokens in renderer CSS', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('旧 hex 色值清理最终覆盖');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('uses a whiter Apple-like neutral gray palette instead of yellow-tinted app-wide surfaces', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Apple 中性灰色板最终覆盖');
    expect(css).toContain('Apple 参考页偏白中性灰二次校准');
    for (const expectedNeutral of [
      'background: oklch(99.7% 0.001 255);',
      '--zeus-product-canvas: oklch(99.6% 0.001 255);',
      '--zeus-product-panel: oklch(99.8% 0.001 255);',
      '--zeus-product-panel-muted: oklch(98.4% 0.001 255);',
      '--zeus-source-sidebar: oklch(99.2% 0.0005 255);',
      '--zeus-product-selected: oklch(92.8% 0.0012 255);',
      '--zeus-project-row-selected-bg: var(--zeus-product-selected);',
      '--zeus-project-menu-selected-bg: oklch(94.3% 0.001 255);',
    ]) {
      expect(css).toContain(expectedNeutral);
    }
    // left-sidebar whitespace stale guard
    expect(css).not.toContain('padding: 44px 18px 16px;');
    expect(css).not.toContain('padding: 38px 18px 14px;');
    expect(css).not.toContain('padding: 34px 18px 12px;');
    expect(css).not.toContain('margin-block: 0 24px;');
    expect(css).not.toContain('margin-block: 0 14px;');
    expect(css).not.toContain('margin-block: 0 10px;');
    expect(css).not.toContain('--zeus-source-sidebar: oklch(98.8% 0.001 255);');
    expect(css).not.toContain('--zeus-product-selected: oklch(93.2% 0.002 255);');
    for (const cyanSurface of [
      'background: oklch(96.8% 0.006 265);',
      'background: oklch(94.8% 0.009 268);',
      '--zeus-product-selected: oklch(91.8% 0.033 252);',
      '--zeus-project-row-selected-bg: oklch(91.8% 0.033 252);',
      '--zeus-project-menu-selected-bg: oklch(93.4% 0.02 252);',
      'background: oklch(97.2% 0.003 95);',
      '--zeus-product-canvas: oklch(98.8% 0.002 95);',
    ]) {
      expect(css).not.toContain(cyanSurface);
    }
  });

  it('keeps high-traffic controls on the Apple neutral palette instead of blue-cyan chrome', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const expectedNeutralToken of [
      '--zeus-control-bg: var(--zeus-product-panel);',
      '--zeus-control-bg-hover: var(--zeus-native-row-hover);',
      '--zeus-control-bg-active: var(--zeus-product-selected);',
      '--zeus-control-border: var(--zeus-product-line);',
      '--zeus-select-bg: var(--zeus-product-panel);',
      '--zeus-select-line: oklch(82% 0.002 255);',
      '--zeus-row-action-bg: oklch(97.3% 0.001 255);',
      '--zeus-toolbar-action-bg: oklch(97.2% 0.001 255);',
      '--zeus-task-filter-toolbar-bg: oklch(98% 0.001 255);',
      '--zeus-status-pill-bg: oklch(97.4% 0.001 255);',
      '--zeus-graph-canvas-bg: oklch(99% 0.001 255);',
      '--zeus-log-command-bg: oklch(97.1% 0.001 255);',
    ]) {
      expect(css).toContain(expectedNeutralToken);
    }
    for (const cyanChromeToken of [
      '--zeus-control-bg: oklch(98.8% 0.003 255);',
      '--zeus-control-bg-active: oklch(91.6% 0.018 252);',
      '--zeus-select-line: oklch(78.5% 0.025 252);',
      '--zeus-row-action-bg: oklch(96.3% 0.006 255);',
      '--zeus-toolbar-action-bg: oklch(96% 0.006 255);',
      '--zeus-task-filter-toolbar-bg: oklch(97.2% 0.005 255);',
      '--zeus-status-pill-bg: oklch(96.4% 0.006 255);',
      '--zeus-graph-canvas-bg: oklch(98.6% 0.004 255);',
      '--zeus-log-command-bg: oklch(96.2% 0.014 252);',
      '--zeus-select-line: oklch(78% 0.004 95);',
      '--zeus-toolbar-action-bg: oklch(96% 0.003 95);',
    ]) {
      expect(css).not.toContain(cyanChromeToken);
    }
  });

  it('exposes the Zeus Component Spec token bridge for source lists messages decision rails composer mode rail and avatars', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Zeus Component Spec 冷中性组件 token bridge');
    for (const expectedSpecToken of [
      '--zeus-surface-window: oklch(99.2% 0.002 255);',
      '--zeus-surface-sidebar: oklch(96.4% 0.003 255);',
      '--zeus-surface-workspace: oklch(98.4% 0.002 255);',
      '--zeus-line-subtle: oklch(88.5% 0.004 255);',
      '--zeus-source-list-bg: transparent;',
      '--zeus-source-list-hover: oklch(94.8% 0.003 255);',
      '--zeus-source-list-selected: oklch(91.8% 0.004 255);',
      '--zeus-source-list-selected-strong: oklch(62% 0.15 252);',
      '--zeus-sidebar-separator: oklch(87% 0.004 255);',
      '--zeus-avatar-green: oklch(72% 0.15 145);',
      '--zeus-avatar-blue: oklch(66% 0.14 252);',
      '--zeus-avatar-violet: oklch(67% 0.13 292);',
      '--zeus-avatar-orange: oklch(76% 0.14 55);',
      '--zeus-avatar-red: oklch(66% 0.16 25);',
      '--zeus-avatar-cyan: oklch(74% 0.12 195);',
      '--zeus-toolbar-bg: oklch(98.8% 0.002 255);',
      '--zeus-toolbar-line: oklch(88.8% 0.004 255);',
      '--zeus-message-text: oklch(23% 0.006 255);',
      '--zeus-message-meta: oklch(60% 0.004 255);',
      '--zeus-message-source-bg: oklch(95.2% 0.003 255);',
      '--zeus-decision-rail-bg: oklch(91.5% 0.004 255);',
      '--zeus-decision-rail-separator: oklch(82% 0.005 255);',
      '--zeus-decision-button-hover: oklch(94.5% 0.003 255);',
      '--zeus-decision-button-active: oklch(88.5% 0.005 255);',
      '--zeus-composer-bg: oklch(98.8% 0.002 255);',
      '--zeus-composer-input-bg: oklch(96% 0.003 255);',
      '--zeus-composer-focus-ring: oklch(70% 0.11 252);',
      '--zeus-mode-rail-bg: oklch(92.5% 0.004 255);',
      '--zeus-mode-rail-active: oklch(88.8% 0.006 255);',
      '--zeus-popover-shadow: 0 18px 44px color-mix(in oklch, oklch(40% 0.006 255) 16%, transparent);',
      '--zeus-danger-text: oklch(54% 0.14 25);',
      '--zeus-accent-blue: oklch(61% 0.15 252);',
    ]) {
      expect(css).toContain(expectedSpecToken);
    }

    const specTokenBlock = css.slice(css.indexOf('Zeus Component Spec 冷中性组件 token bridge'), css.indexOf('/* 2026-06-17 全控件产品控件最终覆盖'));
    expect(specTokenBlock).not.toMatch(/oklch\([^)]*\s95\)/);
  });

  it('keeps Zeus Design Contract v2 component tokens aligned with renderer CSS tokens', () => {
    const design = readFileSync(new URL('../../../DESIGN.md', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    // 这组映射把 DESIGN.md v2 的组件契约锁到真实 renderer token，避免文档与 CSS 后续漂移。
    const componentTokenContract: Record<string, string[]> = {
      'source-list': ['--zeus-source-list-bg', '--zeus-source-list-hover', '--zeus-source-list-selected', '--zeus-hidden-titlebar-safe-top'],
      'object-toolbar': ['--zeus-toolbar-bg', '--zeus-toolbar-line', '--zeus-toolbar-action-bg', '--zeus-toolbar-action-line'],
      controls: ['--zeus-control-height', '--zeus-control-radius', '--zeus-control-bg', '--zeus-control-border', '--zeus-control-focus'],
      composer: ['--zeus-composer-bg', '--zeus-composer-input-bg', '--zeus-composer-focus-ring', '--zeus-conversation-compose-line'],
      'decision-rail': ['--zeus-decision-rail-bg', '--zeus-decision-rail-separator', '--zeus-decision-button-hover', '--zeus-decision-button-active'],
      'mode-rail': ['--zeus-mode-rail-bg', '--zeus-mode-rail-active'],
      'graph-canvas': ['--zeus-graph-canvas-bg', '--zeus-graph-canvas-line', '--zeus-graph-canvas-source-bg', '--zeus-graph-canvas-source-text'],
      popover: ['--zeus-popover-bg', '--zeus-popover-line', '--zeus-popover-radius', '--zeus-popover-item-hover-bg'],
      drawer: ['--zeus-drawer-backdrop-bg', '--zeus-drawer-surface-bg', '--zeus-drawer-line', '--zeus-drawer-chrome-bg'],
    };

    expect(design).toContain('## Zeus Design Contract v2');
    expect(design).toContain('version: "zeus-design-contract-v2"');
    expect(design).toContain('quality_gates:');
    expect(design).toContain('must_have_accessibility: ["focus-visible", "keyboard-navigation", "aria-current-or-selected", "reduced-motion"]');

    for (const [componentName, tokens] of Object.entries(componentTokenContract)) {
      expect(design).toContain(`  ${componentName}:`);
      for (const token of tokens) {
        expect(design).toContain(token);
        expect(css).toMatch(new RegExp(`${token.replaceAll('-', '\\-')}\\s*:`));
      }
    }

    for (const forbiddenExternalToken of ['Geist Sans', 'background-100', 'gray-1000', '#000000', '#ffffff']) {
      expect(design).not.toContain(forbiddenExternalToken);
    }
  });

  it('defines every product CSS token that buttons inputs selects drawers and rows consume', () => {
    // App.tsx 同时导入全局样式与 native session 作用域；token 完整性必须按真实级联整体校验。
    const css = `${readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8')}\n${readSessionCss()}`;

    expect(css).toContain('全页面产品状态 token 最终覆盖');

    const usedTokens = Array.from(css.matchAll(/var\((--[A-Za-z0-9_-]+)/g), ([, token]) => token);
    const definedTokens = new Set(Array.from(css.matchAll(/(?<![\w-])(--[A-Za-z0-9_-]+)\s*:/g), ([, token]) => token));
    const missingTokens = [...new Set(usedTokens.filter((token) => !definedTokens.has(token)))].sort();

    expect(missingTokens).toEqual([]);
    for (const stateToken of ['--zeus-product-selected', '--zeus-product-danger-bg', '--zeus-product-danger-line']) {
      expect(definedTokens.has(stateToken)).toBe(true);
    }
  });

  it('removes stale summary control selectors now that navigation and menus use explicit buttons', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(source).not.toContain('<summary');
    expect(css).toContain('原生 summary 控件选择器清理最终覆盖');
    expect(cssWithoutComments).not.toMatch(/:where\([^)]*(?:^|[\s,])summary(?=[\s,)])/);
    expect(cssWithoutComments).not.toMatch(/(^|[\s,{>])summary(?=[\s,):])/);
  });

  it('removes stale native details disclosure CSS now that pages no longer use disclosure controls', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('<details');
    expect(source).not.toContain('<summary');
    const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

    expect(css).toContain('原生 details disclosure 样式清理最终覆盖');
    expect(cssWithoutComments).not.toMatch(/:where\(details\)/);
    expect(cssWithoutComments).not.toContain('> details');
    expect(cssWithoutComments).not.toMatch(/(^|[\s,{>])details\b/);
  });

  it('keeps renderer CSS blocks balanced so the packaged Vite build can parse styles', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const stack: number[] = [];

    for (const [index, character] of Array.from(css).entries()) {
      if (character === '{') {
        stack.push(index);
      }
      if (character === '}') {
        stack.pop();
      }
    }

    expect(
      stack.map((index) => ({
        index,
        line: css.slice(0, index).split('\n').length,
      })),
    ).toEqual([]);
  });

  it('removes rgba and dangling settings selector fragments from the renderer style layer', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('旧 rgba 与设置选择器碎片清理最终覆盖');
    expect(css).not.toContain('rgba(');

    const selectorScanCss = css.replace(/:where\([\s\S]*?\)/g, ':where(...)');
    const danglingSettingsSelectors = selectorScanCss
      .split('\n')
      .map((line, index) => ({ index: index + 1, line: line.trim() }))
      .filter(({ line }) => /^\.settings-/.test(line) && !line.includes('macos-ai-app'));

    expect(danglingSettingsSelectors).toEqual([]);
  });

  it('removes obsolete Codex and Apple duplicate override layers from renderer CSS', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('旧 Codex Apple 重复覆盖层清理最终覆盖');
    for (const legacyComment of ['Codex 纯白 Apple 风格覆盖层', 'Codex 全局控件统一风格', 'Apple 白色扁平控件体系', 'Codex App 返修最终覆盖', 'Code Map 抽屉返修']) {
      expect(css).not.toContain(legacyComment);
    }
  });

  it('removes impossible nested macOS app selectors from renderer CSS', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('不可能命中的嵌套 app 选择器清理最终覆盖');
    const impossibleNestedAppSelectors = css
      .split('\n')
      .map((line, index) => ({ index: index + 1, line: line.trim() }))
      .filter(({ line }) => line.includes('.macos-ai-app') && line.indexOf('.macos-ai-app') !== line.lastIndexOf('.macos-ai-app'));

    expect(impossibleNestedAppSelectors).toEqual([]);
    expect(css).not.toContain('.project-more-popover .macos-ai-app');
  });

  it('scopes root shell and theme selectors to the macOS app root', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('旧根壳层选择器作用域清理最终覆盖');
    const leakedRootShellSelectors = css
      .split('\n')
      .map((line, index) => ({ index: index + 1, line: line.trim() }))
      .filter(({ line }) => !line.startsWith('/*') && /^(\.zeus-shell|\.ai-native-shell|\.zeus-sidebar)\b/.test(line));

    expect(leakedRootShellSelectors).toEqual([]);
    expect(css).not.toMatch(/,\n\.ai-native-shell\s*\{/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell\s*\{/);
    expect(css).toMatch(/\.macos-ai-app\.ai-native-shell\s*\{/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell\.theme-dark \.zeus-sidebar\s*\{/);
  });

  it('collapses duplicate sidebar and workspace base shell blocks into one product contract', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('重复基础壳层块清理最终覆盖');
    const selectorCounts = new Map<string, number>();
    for (const line of css.split('\n').map((item) => item.trim())) {
      if (line === '.macos-ai-app .ai-sidebar {' || line === '.macos-ai-app .ai-workspace {' || line === '.macos-ai-app .workspace {') {
        selectorCounts.set(line, (selectorCounts.get(line) ?? 0) + 1);
      }
    }

    expect(selectorCounts.get('.macos-ai-app .ai-sidebar {')).toBe(1);
    expect(selectorCounts.get('.macos-ai-app .ai-workspace {')).toBe(1);
    expect(selectorCounts.get('.macos-ai-app .workspace {') ?? 0).toBe(0);
    expect(css).not.toContain('padding: 30px 34px;');
    expect(css).toMatch(/\.macos-ai-app \.ai-sidebar\s*\{[\s\S]*padding-block:\s*var\(--zeus-hidden-titlebar-safe-top,\s*44px\) 18px/);
    expect(css).toMatch(/\.macos-ai-app \.ai-sidebar\s*\{[\s\S]*padding-inline:\s*12px/);
    expect(css).not.toContain('padding: 58px 12px 18px;');
    expect(css).toMatch(/\.macos-ai-app \.ai-workspace\s*\{[\s\S]*padding:\s*0/);
  });

  it('ports workspace drawers through one portal-scoped shell instead of stacked in-page drawer rules', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('重复抽屉基础块清理最终覆盖');
    const genericDrawerSelectors = css
      .split('\n')
      .map((line, index) => ({ index: index + 1, line: line.trim() }))
      .filter(({ line }) => /^\.macos-ai-app \.workspace-drawer(?:-|\s*\{)/.test(line));

    expect(genericDrawerSelectors).toEqual([]);
    for (const selector of [
      '.workspace-drawer-portal-root.macos-ai-app .workspace-drawer-backdrop {',
      '.workspace-drawer-portal-root.macos-ai-app .workspace-drawer {',
      '.workspace-drawer-portal-root.macos-ai-app .workspace-drawer-chrome {',
      '.workspace-drawer-portal-root.macos-ai-app .workspace-drawer-content {',
    ]) {
      expect(css.split('\n').filter((line) => line.trim() === selector)).toHaveLength(1);
    }
    expect(css).not.toContain('inline-size: min(820px, calc(100vw - 236px));');
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app\s*\{[\s\S]*--zeus-drawer-inline-size:\s*min\(980px, calc\(100vw - 236px\)\)/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\s*\{[\s\S]*inline-size:\s*var\(--zeus-drawer-inline-size\)/);
  });

  it('normalizes workspace drawer shell chrome into product drawer tokens instead of hard-coded overlay colors', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('抽屉壳层视觉 token 最终覆盖');
    ['--zeus-drawer-backdrop-bg', '--zeus-drawer-surface-bg', '--zeus-drawer-line', '--zeus-drawer-chrome-bg', '--zeus-drawer-content-bg'].forEach((token) => {
      expect(css).toContain(token);
    });
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer-backdrop\s*\{[\s\S]*background:\s*var\(--zeus-drawer-backdrop-bg\)/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\s*\{[\s\S]*background:\s*var\(--zeus-drawer-surface-bg\)/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\s*\{[\s\S]*border-inline-start:\s*1px solid var\(--zeus-drawer-line\)/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer-chrome\s*\{[\s\S]*background:\s*var\(--zeus-drawer-chrome-bg\)/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer-chrome\s*\{[\s\S]*border-block-end:\s*1px solid var\(--zeus-drawer-line\)/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer-content\s*\{[\s\S]*background:\s*var\(--zeus-drawer-content-bg\)/);
    expect(css).not.toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer-backdrop\s*\{[\s\S]*background:\s*oklch\(18% 0\.015 255 \/ 0\.22\)/);
  });

  it('scopes form and button chrome to the macOS app instead of leaking global web controls', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('表单控件作用域收口最终覆盖');
    expect(css).not.toMatch(/^button,\nselect,\ninput,\ntextarea\s*\{/m);
    expect(css).not.toMatch(/^button\s*\{/m);
    expect(css).not.toMatch(/^input,\ntextarea,\nselect\s*\{/m);
    expect(css).not.toMatch(/^textarea\s*\{/m);
    expect(css).not.toMatch(/^select\s*\{/m);
    expect(css).not.toMatch(/^button:hover:not\(:disabled\)\s*\{/m);
    expect(css).not.toMatch(/^button:active:not\(:disabled\)\s*\{/m);
    expect(css).not.toMatch(/^button:focus-visible,/m);
    expect(css).not.toMatch(/^button:disabled,/m);
  });

  it('separates dangerous actions and project overflow menus from ordinary controls', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" />);

    expect(html).toContain('project-row-actions');
    expect(html).toContain('project-more-popover');
    expect(source).toContain('className="danger-action"');
    expect(css).toContain('危险与菜单按钮最终覆盖');
    for (const token of ['--zeus-control-danger-bg', '--zeus-control-danger-line', '--zeus-control-danger-text', '--zeus-control-danger-bg-hover']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.danger-action,[\s\S]*\.settings-danger-row button[\s\S]*\)\s*\{[\s\S]*background:\s*var\(--zeus-control-danger-bg\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.danger-action,[\s\S]*\.settings-danger-row button[\s\S]*\)\s*\{[\s\S]*border-color:\s*var\(--zeus-control-danger-line\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.danger-action,[\s\S]*\.settings-danger-row button[\s\S]*\)\s*\{[\s\S]*color:\s*var\(--zeus-control-danger-text\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-button\s*\{[\s\S]*inline-size:\s*28px/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover\s*\{[\s\S]*min-inline-size:\s*128px/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover button\s*\{[\s\S]*justify-content:\s*flex-start/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover \.danger-action\s*\{[\s\S]*background:\s*var\(--zeus-control-danger-bg\)/);
  });

  it('normalizes project overflow popovers into compact menu tokens instead of plain floating panels', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" />);

    expect(html).toContain('role="menu"');
    expect(html).toContain('role="menuitem"');
    expect(source).toContain('className="project-more-popover zeus-quiet-more-menu"');
    expect(source).toContain('role="menu"');
    expect(source).not.toContain('<details');
    expect(source).not.toContain('<summary');
    expect(css).not.toContain('project-row-actions > summary');
    expect(css).toContain('项目更多按钮最终覆盖');
    for (const token of ['--zeus-popover-bg', '--zeus-popover-line', '--zeus-popover-radius', '--zeus-popover-item-hover-bg']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover\s*\{[\s\S]*background:\s*var\(--zeus-popover-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover\s*\{[\s\S]*border:\s*1px solid var\(--zeus-popover-line\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover\s*\{[\s\S]*border-radius:\s*var\(--zeus-popover-radius\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover button:hover:not\(:disabled\),[\s\S]*\.macos-ai-app \.project-more-popover button:focus-visible\s*\{[\s\S]*background:\s*var\(--zeus-popover-item-hover-bg\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-more-popover small\s*\{/);
    expect(source).not.toContain('copy.deleteProjectHint}</small>');
    expect(css).not.toMatch(/\.macos-ai-app \.project-more-popover\s*\{[^}]*background:\s*var\(--zeus-product-panel\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-more-popover\s*\{[^}]*border-radius:\s*10px/);
  });

  it('adds restrained reveal motion to drawers and project popovers without layout animation', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('抽屉弹窗动效最终覆盖');
    expect(css).toContain('--zeus-motion-ease-out');
    expect(css).toContain('@keyframes zeus-drawer-enter');
    expect(css).toContain('@keyframes zeus-drawer-backdrop-enter');
    expect(css).toContain('@keyframes zeus-popover-enter');
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\s*\{[\s\S]*animation:\s*zeus-drawer-enter 180ms var\(--zeus-motion-ease-out\)/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer-backdrop\s*\{[\s\S]*animation:\s*zeus-drawer-backdrop-enter 160ms var\(--zeus-motion-ease-out\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover\s*\{[\s\S]*animation:\s*zeus-popover-enter 140ms var\(--zeus-motion-ease-out\)/);
    expect(css).toMatch(/\.macos-ai-app \.graph-node-row \.graph-node-menu-row:not\(\[hidden\]\)\s*\{[\s\S]*animation:\s*zeus-popover-enter 140ms var\(--zeus-motion-ease-out\)/);
    expect(source).toContain('className="workspace-drawer-backdrop"');
    expect(source).toContain('data-motion-surface="backdrop"');
    expect(css).toMatch(/\.macos-ai-app \[data-motion-surface=['"]backdrop['"]\]\s*\{[\s\S]*will-change:\s*opacity/);
    expect(css).toMatch(/\.macos-ai-app \[data-motion-surface=['"]drawer['"]\]\s*\{[\s\S]*will-change:\s*opacity, transform/);
    expect(css).toMatch(/\.macos-ai-app \[data-motion-surface=['"]popover['"]\]:not\(\[hidden\]\)\s*\{[\s\S]*will-change:\s*opacity, transform/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.macos-ai-app \[data-motion-surface\][\s\S]*animation:\s*none[\s\S]*transition:\s*none[\s\S]*transform:\s*none[\s\S]*will-change:\s*auto/);
    expect(css).not.toMatch(/transition:\s*(?:width|height|top|left|right|bottom|margin)/);
  });

  it('renders ordinary checkboxes with a macOS glyph instead of border-drawn web ticks', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const checkboxBlock = css.match(/\.macos-ai-app input\[type=['"]checkbox['"]\]:not\(\.native-switch-input\)\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const tickBlock = css.match(/\.macos-ai-app input\[type=['"]checkbox['"]\]:not\(\.native-switch-input\)::before\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(css).toContain('ZeusCheckbox macOS 勾选图标最终覆盖');
    expect(css).toContain('--zeus-checkbox-check-icon: url("data:image/svg+xml');
    expect(checkboxBlock).toContain('border-radius: 5px');
    expect(checkboxBlock).toContain('transition:');
    expect(tickBlock).toContain('background-image: var(--zeus-checkbox-check-icon)');
    expect(tickBlock).not.toContain('border-block-end');
    expect(tickBlock).not.toContain('border-inline-end');
    expect(tickBlock).not.toContain('rotate(40deg)');
  });

  it('renders number inputs as macOS fields without browser spinner chrome', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const numberBlock = css.match(/\.macos-ai-app input\[type=['"]number['"]\]\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const webkitSpinnerBlock = css.match(/\.macos-ai-app input\[type=['"]number['"]\]::-webkit-outer-spin-button,[\s\S]*?\.macos-ai-app input\[type=['"]number['"]\]::-webkit-inner-spin-button\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(source).toContain('type="number"');
    expect(css).toContain('ZeusNumberInput macOS 数字输入最终覆盖');
    expect(numberBlock).toContain('appearance: textfield');
    expect(numberBlock).toContain('-moz-appearance: textfield');
    expect(numberBlock).toContain('font-variant-numeric: tabular-nums');
    expect(numberBlock).toContain('padding-inline-end: var(--zeus-space-4)');
    expect(webkitSpinnerBlock).toContain('-webkit-appearance: none');
    expect(webkitSpinnerBlock).toContain('margin: 0');
  });

  it('renders search fields with real search semantics while suppressing browser search chrome', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const source = `${appSource}
${taskSource}`;
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const searchBlock = css.match(/\.macos-ai-app input\[type=['"]search['"]\]\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const webkitSearchBlock = css.match(/\.macos-ai-app input\[type=['"]search['"]\]::-webkit-search-decoration,[\s\S]*?\.macos-ai-app input\[type=['"]search['"]\]::-webkit-search-results-decoration\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(appSource).toContain('<input type="search" aria-label={copy.search}');
    expect(taskSource).toContain('aria-label={props.copy.searchAria}');
    expect(source).toContain('aria-label={sessionWorkspaceCopy.runtimeDrawer.searchSessions}');
    expect(source).toContain('aria-label={sessionWorkspaceCopy.runtimeDrawer.logSearchTitle}');
    expect(source).toContain('aria-label={codeMapCopy.nodeSearchAria}');
    expect(source).toContain('aria-label={codeMapCopy.qaHistorySearchAria}');
    expect((source.match(/type="search"/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(css).toContain('ZeusSearchInput macOS 搜索输入最终覆盖');
    expect(searchBlock).toContain('appearance: textfield');
    expect(searchBlock).toContain('-webkit-appearance: textfield');
    expect(searchBlock).toContain('padding-inline-end: var(--zeus-space-4)');
    expect(webkitSearchBlock).toContain('-webkit-appearance: none');
    expect(webkitSearchBlock).toContain('display: none');
  });

  it('gives every ZeusSelect trigger a single chevron without a gray rail or visual-anchor drift', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const zeusSelectSource = readFileSync(new URL('../src/renderer/ZeusSelect.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const selectBlock = css.match(/\.macos-ai-app select\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    const scopedSelectBlock = css.match(/\.macos-ai-app \.graph-search-control-grid select,[\s\S]*?\.macos-ai-app \.settings-row-field select\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    const disabledSelectBlock = css.match(/\.macos-ai-app select:disabled\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(`${source}\n${taskSource}`).not.toContain('<select');
    expect(`${source}\n${taskSource}`).toContain('<ZeusSelect');
    expect(zeusSelectSource).toContain('zeus-select-chevron');
    expect(css).toContain('ZeusSelect macOS 无灰色右侧 rail 最终覆盖');
    for (const token of ['--zeus-select-bg', '--zeus-select-line', '--zeus-select-caret-icon']) {
      expect(css).toContain(token);
    }
    expect(css).not.toContain('--zeus-select-caret-rail');
    expect(css).not.toContain('--zeus-select-caret-surface');
    expect(selectBlock).toContain('-webkit-appearance: none');
    expect(selectBlock).toContain('background-image: var(--zeus-select-caret-icon)');
    expect(selectBlock).not.toContain('linear-gradient');
    expect(selectBlock).not.toContain('var(--zeus-select-caret-rail)');
    expect(selectBlock).toContain('background-position: right 13px center');
    expect(selectBlock).toContain('background-size: 12px 12px');
    expect(selectBlock).toContain('padding-inline-end: 32px');
    expect(scopedSelectBlock).toContain('background-image: var(--zeus-select-caret-icon)');
    expect(scopedSelectBlock).not.toContain('linear-gradient');
    expect(disabledSelectBlock).toContain('background-image: var(--zeus-select-caret-icon)');
    expect(disabledSelectBlock).not.toContain('linear-gradient');
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-chevron\s*\{[\s\S]*background-image:\s*var\(--zeus-select-caret-icon\)/);
    expect(css).toMatch(/\.macos-ai-app select:hover:not\(:disabled\)\s*\{[\s\S]*border-color:\s*var\(--zeus-select-line\)/);
    expect(css).toMatch(/\.macos-ai-app select:focus-visible\s*\{[\s\S]*box-shadow:\s*var\(--zeus-control-focus\)/);
    expect(css).toMatch(/\.macos-ai-app select option\s*\{[\s\S]*background:\s*var\(--zeus-product-panel\)/);
  });

  it('renders Zeus dropdowns as controlled bottom listbox popovers instead of native select menus', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const zeusSelectUrl = new URL('../src/renderer/ZeusSelect.tsx', import.meta.url);
    const zeusSelectSource = existsSync(zeusSelectUrl) ? readFileSync(zeusSelectUrl, 'utf8') : '';
    const source = `${appSource}
${taskSource}`;

    expect(zeusSelectSource).toContain('data-zeus-select-placement="bottom"');
    expect(zeusSelectSource).toContain('role="combobox"');
    expect(zeusSelectSource).toContain('aria-haspopup="listbox"');
    expect(zeusSelectSource).toContain('role="listbox"');
    expect(zeusSelectSource).toContain('role="option"');
    expect(source).toContain('<ZeusSelect');
    expect(source).not.toContain('<select');
    expect(css).toContain('ZeusSelect 下方弹层最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-popover\s*\{[\s\S]*position:\s*absolute/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-popover\s*\{[\s\S]*inset-block-start:\s*calc\(100% \+ 6px\)/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-popover\s*\{[\s\S]*transform-origin:\s*top center/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-popover\[hidden\]\s*\{[\s\S]*display:\s*none/);
  });

  it('renders Zeus dropdowns with the Codex-like search row, selected checkmark, and soft macOS popover surface', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const zeusSelectSource = readFileSync(new URL('../src/renderer/ZeusSelect.tsx', import.meta.url), 'utf8');
    const selectSource = `${appSource}
${taskSource}`;

    expect(zeusSelectSource).toContain('searchPlaceholder');
    expect(zeusSelectSource).toContain('zeus-select-search-row');
    expect(zeusSelectSource).toContain('zeus-select-search-input');
    expect(zeusSelectSource).toContain('zeus-select-option-check');
    expect(zeusSelectSource).toContain('zeus-select-empty');
    expect(selectSource).toContain('selectSearchPlaceholder');
    expect(selectSource).toContain('selectNoResults');
    expect(css).toContain('ZeusSelect Codex 式浮层最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-trigger\s*\{[\s\S]*background:\s*var\(--zeus-select-trigger-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-popover\s*\{[\s\S]*border-radius:\s*14px/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-popover::before\s*\{[\s\S]*transform:\s*rotate\(45deg\)/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-search-row\s*\{[\s\S]*grid-template-columns:\s*14px minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-search-input\s*\{[\s\S]*appearance:\s*textfield/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-option\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 16px/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-option\[aria-selected='true'\]\s*\{[\s\S]*background:\s*transparent/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-option-check\s*\{[\s\S]*color:\s*var\(--zeus-select-check\)/);
  });

  it('keeps Zeus dropdown typography and option density aligned with the task table instead of oversized menu rows', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('ZeusSelect 密度返修最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-trigger\s*\{[\s\S]*background:\s*var\(--zeus-select-trigger-bg\)/);
    expect(css).toMatch(/--zeus-select-trigger-bg:\s*oklch\(98\.6% 0\.001 255\)/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-search-row\s*\{[\s\S]*grid-template-columns:\s*14px minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-search-row\s*\{[\s\S]*min-block-size:\s*32px/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-search-input\s*\{[\s\S]*font-size:\s*13px/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-option\s*\{[\s\S]*font-size:\s*13px/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-option\s*\{[\s\S]*min-block-size:\s*30px/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-option-check\s*\{[\s\S]*font-size:\s*15px/);
  });

  it('normalizes filter and pagination toolbar buttons into one compact toolbar action rail', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const className of ['graph-search-control-grid', 'runtime-session-filter-grid', 'graph-qa-toolbar-command-rail', 'graph-qa-pagination-row']) {
      expect(source).toContain(className);
    }
    expect(css).toContain('筛选分页工具栏按钮最终覆盖');
    for (const token of ['--zeus-toolbar-action-bg', '--zeus-toolbar-action-line', '--zeus-toolbar-action-button-bg', '--zeus-toolbar-action-button-text']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.graph-search-control-grid,[\s\S]*\.graph-qa-pagination-row\)\s*\{[\s\S]*background:\s*var\(--zeus-toolbar-action-bg\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.graph-search-control-grid,[\s\S]*\.graph-qa-pagination-row\) button\s*\{[\s\S]*background:\s*var\(--zeus-toolbar-action-button-bg\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.graph-search-control-grid,[\s\S]*\.graph-qa-pagination-row\) button:first-of-type\s*\{[\s\S]*background:\s*var\(--zeus-product-accent-soft\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.graph-search-control-grid button,\s*\.macos-ai-app \.runtime-session-filter-grid button\s*\{[\s\S]*?oklch\(92% 0\.05 274\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.task-filter-submit\s*\{[\s\S]*?oklch\(82% 0\.045 252\)/);
    expect(source).not.toContain('release-update-actions');
    expect(css).not.toContain('.release-update-actions');
    expect(source).not.toContain('task-template-actions');
    expect(css).not.toContain('.task-template-actions');
    expect(source).not.toContain('task-management-action-strip');
    expect(css).not.toContain('.task-management-action-strip');
    expect(source).not.toContain('task-detail-action-strip');
    expect(css).not.toContain('.task-detail-action-strip');
    expect(source).toContain('statusRowAria');
    expect(source).toContain('statusRowTitle');
    expect(source).not.toContain('statusStripAria');
    expect(source).not.toContain('statusStripTitle');
    expect(source).not.toContain('graph-qa-toolbar-actions');
    expect(source).not.toContain('graph-qa-history-actions');
    expect(css).not.toContain('.graph-qa-toolbar-actions');
    expect(css).not.toContain('.graph-qa-history-actions');
  });

  it('normalizes dense row action buttons into one compact product action rail', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('graph-node-command-rail');
    expect(source).toContain('graph-edge-meta-rail');
    expect(source).toContain('git-hunk-command-rail');
    expect(source).toContain('task-template-command-rail');
    expect(source).toContain('project-inline-recovery-command-rail');
    expect(css).toContain('行内操作按钮最终覆盖');
    for (const token of ['--zeus-row-action-bg', '--zeus-row-action-line', '--zeus-row-action-button-bg', '--zeus-row-action-button-text']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.graph-node-command-rail,[\s\S]*\.project-inline-recovery-command-rail\)\s*\{[\s\S]*background:\s*var\(--zeus-row-action-bg\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.graph-node-command-rail,[\s\S]*\.project-inline-recovery-command-rail\) button\s*\{[\s\S]*background:\s*var\(--zeus-row-action-button-bg\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.graph-node-command-rail,[\s\S]*\.project-inline-recovery-command-rail\) :where\(small,\s*code\)\s*\{[\s\S]*color:\s*var\(--zeus-product-muted\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.graph-node-row button\s*\{[\s\S]*?oklch\(95\.5% 0\.018 274\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.git-hunk-decision button\s*\{[\s\S]*?oklch\(93% 0\.035 274\)/);
  });

  it('normalizes status pills and small semantic badges into one quiet product contract', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const sessionSource = readSessionSource('SessionWorkspace.tsx', 'ProjectConversationTree.tsx');
    const source = `${appSource}\n${sessionSource}`;
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const sessionCss = readSessionCss();

    for (const className of ['session-thread-status', 'session-conversation-tree-state', 'graph-detail-type-pill', 'graph-qa-count']) {
      expect(source).toContain(className);
    }
    expect(css).toContain('状态徽标最终覆盖');
    for (const token of ['--zeus-status-pill-bg', '--zeus-status-pill-line', '--zeus-status-pill-text', '--zeus-status-text']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app :where\(\.graph-detail-type-pill, \.graph-detail-context-list > span\)\s*\{[\s\S]*background:\s*var\(--zeus-status-pill-bg\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(\.graph-detail-type-pill, \.graph-detail-context-list > span\)\s*\{[\s\S]*color:\s*var\(--zeus-status-pill-text\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(\s*\.graph-qa-count,[\s\S]*\.code-map-context-facts span\)\s*\{[\s\S]*color:\s*var\(--zeus-status-text\)/);
    expect(sessionCss).toMatch(/\.session-codex-parity-v1 \.session-thread-status\s*\{[^}]*color:\s*var\(--session-text-muted\)/s);
    expect(sessionSource).toContain("role={displayedHeader.status.kind === 'error' ? 'alert' : 'status'}");
    expect(source).not.toContain('project-state-pill');
    expect(css).not.toContain('.project-state-pill');
    expect(source).not.toContain('conversation-thread-status');
    expect(css).not.toContain('.conversation-thread-status');
  });

  it('applies one product control contract to every button, input, select, textarea and link', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const sessionCss = readSessionCss();
    const compactCss = css.replace(/\s+/g, ' ');

    expect(css).toContain('全控件产品控件最终覆盖');
    for (const token of ['--zeus-control-height', '--zeus-control-radius', '--zeus-control-focus', '--zeus-control-bg', '--zeus-control-bg-hover']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(
      /\.macos-ai-app :where\(\.workspace-detail-pane,\s*\.settings-detail-pane,\s*\.settings-section-nav,\s*\.workspace-drawer-content\) :where\(button,\s*input,\s*select,\s*textarea,\s*a\)\s*\{[^}]*min-block-size:\s*var\(--zeus-control-height,\s*30px\)/s,
    );
    expect(sessionCss).toMatch(/\.session-codex-parity-v1 button\s*\{[^}]*min-block-size:\s*28px/s);
    expect(sessionCss).toMatch(/\.session-codex-parity-v1 button:focus-visible,[\s\S]*outline:\s*2px solid var\(--session-focus-outline\)/s);
    expect(css).toMatch(/\.macos-ai-app :where\(input,\s*select,\s*textarea\)\s*\{[\s\S]*inline-size:\s*100%/);
    expect(css).toMatch(/\.macos-ai-app select\s*\{[\s\S]*background-image:\s*var\(--zeus-select-caret-icon\)/);
    expect(css).toMatch(/\.macos-ai-app input\[type=['"]checkbox['"]\]:not\(\.native-switch-input\)\s*\{[\s\S]*inline-size:\s*16px/);
    expect(css).toMatch(/\.macos-ai-app :where\(button,\s*a\):focus-visible\s*\{[\s\S]*box-shadow:\s*var\(--zeus-control-focus\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(button,\s*input,\s*select,\s*textarea,\s*a\):disabled\s*\{[\s\S]*cursor:\s*not-allowed/);
    expect(css).toContain('全控件禁用只读状态最终覆盖');
    for (const token of ['--zeus-control-disabled-bg', '--zeus-control-disabled-line', '--zeus-control-disabled-text']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app :where\(button,\s*input,\s*select,\s*textarea,\s*a\):where\(:disabled,\s*\[aria-disabled=['"]true['"]\]\)\s*\{[\s\S]*background:\s*var\(--zeus-control-disabled-bg\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(button,\s*input,\s*select,\s*textarea,\s*a\):where\(:disabled,\s*\[aria-disabled=['"]true['"]\]\)\s*\{[\s\S]*pointer-events:\s*none/);
    expect(css).toMatch(/\.macos-ai-app :where\(input,\s*textarea\):read-only\s*\{[\s\S]*background:\s*var\(--zeus-control-disabled-bg\)/);
    expect(css).toContain('全控件错误状态最终覆盖');
    for (const token of ['--zeus-control-error-bg', '--zeus-control-error-line', '--zeus-control-error-text', '--zeus-control-error-focus']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app :where\(input,\s*select,\s*textarea\):where\(\[aria-invalid=['"]true['"]\],\s*:user-invalid\)\s*\{[\s\S]*background:\s*var\(--zeus-control-error-bg\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(input,\s*select,\s*textarea\):where\(\[aria-invalid=['"]true['"]\],\s*:user-invalid\)\s*\{[\s\S]*border-color:\s*var\(--zeus-control-error-line\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(input,\s*select,\s*textarea\):where\(\[aria-invalid=['"]true['"]\],\s*:user-invalid\)\s*\{[\s\S]*color:\s*var\(--zeus-control-error-text\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(input,\s*select,\s*textarea\):where\(\[aria-invalid=['"]true['"]\],\s*:user-invalid\):focus-visible\s*\{[\s\S]*box-shadow:\s*var\(--zeus-control-error-focus\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(input,\s*select,\s*textarea\):where\(\[aria-invalid=['"]true['"]\],\s*:user-invalid\)::placeholder\s*\{[\s\S]*color:\s*var\(--zeus-control-error-text\)/);
    expect(css).toContain('全动作入口加载状态最终覆盖');
    for (const token of ['--zeus-control-loading-bg', '--zeus-control-loading-line', '--zeus-control-loading-text', '--zeus-control-loading-dot']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app :where\(button,\s*a\):where\(\[aria-busy=['"]true['"]\],\s*\[data-loading=['"]true['"]\]\)\s*\{[\s\S]*background:\s*var\(--zeus-control-loading-bg\)/);
    expect(css).toMatch(/\.macos-ai-app :where\(button,\s*a\):where\(\[aria-busy=['"]true['"]\],\s*\[data-loading=['"]true['"]\]\)\s*\{[\s\S]*cursor:\s*progress/);
    expect(css).toMatch(/\.macos-ai-app :where\(button,\s*a\):where\(\[aria-busy=['"]true['"]\],\s*\[data-loading=['"]true['"]\]\)::after\s*\{[\s\S]*background:\s*var\(--zeus-control-loading-dot\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.macos-ai-app :where\(button,\s*a\):where\(\[aria-busy=['"]true['"]\],\s*\[data-loading=['"]true['"]\]\)::after\s*\{[\s\S]*animation:\s*none/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.git-confirmation-command-rail,[^)]*\.drawer-header-row\s*\) \{[^}]*gap:\s*var\(--zeus-space-2\)/);
    const finalControlLayer = css.slice(css.indexOf('全控件产品控件最终覆盖'));
    expect(finalControlLayer).not.toContain('#fff');
    expect(finalControlLayer).not.toContain('#000');
    expect(finalControlLayer).not.toContain('rgba(');
  });

  it('keeps command rails and project menus compact instead of loose button piles', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    for (const className of [
      'code-repository-primary-rail',
      'project-config-command-rail',
      'project-edit-command-rail',
      'git-confirmation-command-rail',
      'runtime-session-primary-command-rail',
      'settings-row-action-rail',
      'release-update-command-rail',
      'graph-mermaid-command-rail',
      'project-more-popover',
    ]) {
      expect(source).toContain(className);
    }
    // runtime actions stale guard
    expect(source).not.toContain('runtime-row-actions');
    expect(source).not.toContain('runtime-generic-shell-actions');
    expect(source).not.toContain('runtime-session-primary-actions');
    expect(source).not.toContain('runtime-session-secondary-actions');
    expect(source).not.toContain('runtime-session-terminal-actions');
    expect(source).not.toContain('runtime-session-orphan-actions');
    expect(css).not.toContain('.runtime-row-actions');
    expect(css).not.toContain('.runtime-generic-shell-actions');
    expect(css).not.toContain('.runtime-session-primary-actions');
    expect(css).not.toContain('.runtime-session-secondary-actions');
    expect(css).not.toContain('.runtime-session-terminal-actions');
    expect(css).not.toContain('.runtime-session-orphan-actions');
    // git actions stale guard
    expect(source).not.toContain('git-hunk-actions');
    expect(source).not.toContain('git-confirmation-actions');
    expect(source).not.toContain('git-confirmation-risk-actions');
    expect(css).not.toContain('.git-hunk-actions');
    expect(css).not.toContain('.git-confirmation-actions');
    expect(css).not.toContain('.git-confirmation-risk-actions');
    // project drawer actions stale guard
    expect(source).not.toContain('project-config-actions');
    expect(source).not.toContain('project-edit-actions');
    expect(source).not.toContain('project-edit-danger-actions');
    expect(css).not.toContain('.project-config-actions');
    expect(css).not.toContain('.project-edit-actions');
    expect(css).not.toContain('.project-edit-danger-actions');
    // settings-row-actions stale guard
    expect(source).not.toContain('settings-row-actions');
    expect(css).not.toContain('.settings-row-actions');
    expect(source).not.toContain('task-filter-command-rail');
    expect(css).not.toContain('.task-filter-command-rail');
    expect(css).not.toContain('.task-detail-status-row');
    expect(source).not.toContain('repository-primary-actions');
    expect(source).not.toContain('repository-secondary-actions');
    expect(css).not.toContain('.repository-primary-actions');
    expect(css).not.toContain('.repository-secondary-actions');
    expect(css).toContain('按钮菜单命令 rail 触感最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.code-repository-primary-rail,[^)]*\.graph-mermaid-command-rail\s*\) \{[^}]*max-inline-size:\s*100%/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.code-repository-primary-rail,[^)]*\.graph-mermaid-command-rail\s*\) > button \{(?=[^}]*min-block-size:\s*26px)(?=[^}]*white-space:\s*nowrap)(?=[^}]*text-overflow:\s*ellipsis)/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.code-repository-primary-rail,[^)]*\.graph-mermaid-command-rail\s*\) > button:disabled \{[^}]*cursor:\s*default[^}]*opacity:\s*0\.58/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.code-repository-primary-rail,[^)]*\.graph-mermaid-command-rail\s*\) > button:focus-visible \{[^}]*box-shadow:\s*var\(--zeus-control-focus\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover button\s*\{[\s\S]*inline-size:\s*100%[\s\S]*text-align:\s*start/);
    const finalActionLayer = css.slice(css.indexOf('按钮菜单命令 rail 触感最终覆盖'), css.indexOf('空态错误态密度最终覆盖'));
    expect(finalActionLayer).not.toMatch(/transition:\s*[^;]*(?:width|height|top|left|right|bottom|margin|transform)/);
  });

  it('keeps empty error and waiting states compact instead of hero placeholders', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const sessionSource = readSessionSource('SessionWorkspace.tsx');
    const source = `${appSource}\n${sessionSource}`;
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const sessionCss = readSessionCss();
    const compactCss = css.replace(/\s+/g, ' ');

    for (const className of [
      'inline-status failed',
      'session-transport-failure',
      'runtime-session-empty-row',
      'conversation-change-empty-row',
      'task-template-empty-row',
      'graph-qa-empty-row',
      'graph-mermaid-empty-row',
      'project-archive-empty-row',
      'project-inline-recovery-row',
    ]) {
      expect(source).toContain(className);
    }
    expect(css).toContain('空态错误态密度最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.runtime-session-empty-row,[^)]*\.inline-status\.failed\s*\) \{(?=[^}]*background:\s*var\(--zeus-empty-state-bg\))(?=[^}]*max-inline-size:\s*100%)(?=[^}]*min-inline-size:\s*0)/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.runtime-session-empty-row,[^)]*\.inline-status\.failed\s*\) :where\(strong, span, small, p, code\s*\) \{[^}]*overflow-wrap:\s*anywhere/);
    expect(sessionCss).toMatch(
      /\.session-codex-parity-v1 \.session-loading,[\s\S]*\.session-codex-parity-v1 \.session-transport-failure\s*\{[^}]*inline-size:\s*min\(var\(--session-thread-max\),\s*calc\(100% - \(2 \* var\(--session-gutter\)\)\)\)/s,
    );
    expect(source).toContain('session-new-conversation');
    expect(source).not.toContain('session-start-empty');
    expect(sessionCss).toMatch(/\.session-codex-parity-v1 \.session-new-conversation\s*\{[^}]*inline-size:\s*100%[^}]*min-inline-size:\s*0[^}]*overflow:\s*hidden/);
    expect(source).not.toContain('project-empty-guidance-row');
    expect(source).not.toContain('project-empty-command-rail');
    expect(css).not.toContain('project-empty-guidance-row');
    expect(css).not.toContain('project-empty-command-rail');
    expect(css).toMatch(/\.macos-ai-app \.project-inline-recovery-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(compactCss).toMatch(/@media \(max-width:\s*860px\) \{[^@]*\.macos-ai-app \.project-inline-recovery-row \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/(^|[\s,{>])\.empty-state(?![\w-])/);
    expect(`${css}\n${sessionCss}`).not.toMatch(/hero-placeholder|placeholder-hero|empty-hero/);
  });

  it('keeps graph drawers and detail panels dense without overflowing compact windows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    for (const className of [
      'code-map-inspector-pane',
      'graph-detail-workbench',
      'graph-detail-source-row',
      'graph-detail-context-list',
      'graph-node-row',
      'graph-edge-row',
      'graph-node-menu-row',
      'graph-canvas-sources',
      'graph-mermaid-source-row',
    ]) {
      expect(source).toContain(className);
    }
    expect(css).toContain('图谱抽屉详情密度最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.code-map-inspector-pane,[^)]*\.graph-mermaid-source-row\s*\) \{[^}]*max-inline-size:\s*100%[^}]*min-inline-size:\s*0[^}]*overflow-wrap:\s*anywhere/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.graph-detail-context-list,[^)]*\.graph-canvas-sources\s*\) \{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*gap:\s*var\(--zeus-space-1\)/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.graph-detail-context-list > span,[^)]*\.graph-canvas-sources span\s*\) \{[^}]*max-inline-size:\s*min\(100%,\s*260px\)[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.macos-ai-app :where\(\s*\.code-map-inspector-pane,[\s\S]*\.graph-node-menu-row\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.graph-detail-context-list\s*\{[\s\S]*inline-size:\s*max-content/);
  });

  it('keeps global DecisionRail responsive while native app-server requests use scoped decision actions', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const sessionSource = readSessionSource('PendingRequestSurface.tsx', 'ConversationComposer.tsx');
    const source = `${appSource}\n${sessionSource}`;
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const sessionCss = readSessionCss();
    const compactCss = css.replace(/\s+/g, ' ');

    for (const className of ['zeus-decision-rail', 'zeus-decision-rail-button', 'graph-qa-decision-rail', 'session-request-actions', 'session-request-accept', 'session-request-decline']) {
      expect(source).toContain(className);
    }
    expect(css).toContain('DecisionRail compact responsive final cover');
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\.zeus-decision-rail, \.graph-qa-decision-rail\) \{[^}]*max-inline-size:\s*100%[^}]*min-inline-size:\s*0[^}]*overflow:\s*hidden/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\.zeus-decision-rail-button, \.graph-qa-ask-button\) \{[^}]*min-inline-size:\s*0[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
    expect(compactCss).toMatch(/@media \(max-width:\s*860px\) \{[^@]*\.macos-ai-app :where\(\.zeus-decision-rail, \.graph-qa-decision-rail\) \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(compactCss).toMatch(/@media \(max-width:\s*860px\) \{[^@]*\.macos-ai-app :where\(\.zeus-decision-rail-button, \.graph-qa-ask-button\) \{[^}]*inline-size:\s*100%/);
    expect(sessionCss).toMatch(/\.session-codex-parity-v1 \.session-pending-request\s*\{[^}]*inline-size:\s*min\(var\(--session-thread-max\),\s*100%\)/s);
    expect(sessionCss).toMatch(/\.session-codex-parity-v1 \.session-request-actions\s*\{[^}]*display:\s*flex[^}]*gap:\s*8px[^}]*justify-content:\s*flex-end/s);
    expect(css).not.toMatch(/\.macos-ai-app \.zeus-decision-rail\s*\{[\s\S]*inline-size:\s*max-content/);
  });

  it('keeps input select and textarea rows from stretching drawers or compact workspaces', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const source = `${appSource}
${taskSource}`;
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    for (const className of ['project-config-setting-row', 'project-edit-setting-row', 'git-risk-input-row', 'runtime-generic-shell-input-row', 'settings-config-row', 'task-filter-control-row']) {
      expect(source).toContain(className);
    }
    expect(css).toContain('输入下拉文本域防漂移最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.project-config-setting-row,[^)]*\.task-filter-control-row\s*\) \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(180px,\s*0\.9fr\)/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.project-config-setting-field,[^)]*\.settings-row-field\s*\) \{[^}]*min-inline-size:\s*0/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.project-config-setting-field,[^)]*\.settings-row-field\s*\) > :where\(input, select, textarea\s*\) \{[^}]*max-inline-size:\s*100%/);
    expect(compactCss).toMatch(/\.macos-ai-app :where\(\s*\.project-config-setting-field,[^)]*\.settings-row-field\s*\) > textarea \{[^}]*max-block-size:\s*min\(38vh,\s*220px\)/);
    expect(compactCss).toMatch(/@media \(max-width:\s*860px\) \{[^@]*\.macos-ai-app :where\(\s*\.project-config-setting-row,[^)]*\.task-filter-control-row\s*\) \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/\.macos-ai-app :where\(\s*\.project-config-setting-row,[\s\S]*\.task-filter-control-row\)\s*\{[\s\S]*min-inline-size:\s*fit-content/);
  });

  it('renders project sessions in a dedicated middle column instead of the global project sidebar or a filter dashboard', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" />);

    expect(html).toContain('session-project-conversation-tree');
    expect(html).toContain('aria-label="项目会话"');
    expect(html).toContain('session-conversation-task-group');
    expect(html).toContain('暂无真实会话');
    expect(html).toContain('session-mobile-source-trigger');
    expect(html).toContain('workspace-view-project-sessions');
    expect(html).toContain('session-workspace-root');
    const sidebarStart = html.indexOf('<aside class="zeus-sidebar');
    const workspaceStart = html.indexOf('<section class="workspace ai-workspace"');
    expect(html.slice(sidebarStart, workspaceStart)).not.toContain('session-project-conversation-tree');
    expect(html).toContain('session-list-pane');
    expect(html).not.toContain('class="list-pane-title"');
    expect(html).not.toContain('对话搜索');
    expect(html).not.toContain('任务状态筛选');
    expect(html).not.toContain('任务标签筛选');
    expect(html).not.toContain('任务排序');
  });

  it('renders native app-server choices as compact selectable rows with provider runtime state', () => {
    const snapshot = createSnapshot();
    snapshot.tasks[0] = { ...snapshot.tasks[0], title: 'Bug 会话排查', tags: ['backend'] };
    const choice = createNativeConversationChoice();
    const html = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="conversations" initialNativeConversationChoices={[createNativeConversationChoicesSnapshot(choice)]} initialSelectedNativeConversationId={choice.id} />);
    const source = readSessionSource('ProjectConversationTree.tsx', 'SessionWorkspace.tsx');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('session-conversation-tree-row is-current');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-conversation-runtime-state="ready"');
    expect(html).toContain('session-conversation-tree-copy');
    expect(html).toContain('session-conversation-tree-state');
    expect(html).toContain('检查真实 app-server 连续对话');
    expect(html).toContain('session-thread-header');
    expect(html).toContain('session-thread-status');
    expect(html).not.toContain('续接此会话');
    expect(html).not.toContain('引用旧会话');
    expect(html).not.toContain('task-list-row');
    expect(source).toContain('data-conversation-runtime-state={runtimeState}');
    expect(source).toContain('createSessionHeaderSnapshot');
    expect(css).toMatch(/\.macos-ai-app \.session-conversation-tree-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.macos-ai-app \.session-conversation-tree-copy > :where\(strong, small\)\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  });

  it('keeps legacy conversations explicitly read-only and links to Settings import instead of a reference-mode rail', () => {
    const legacyChoice = createNativeConversationChoice({
      id: 'conversation_legacy',
      title: '旧 CLI 会话',
      transportKind: 'cli_legacy',
      providerThreadId: null,
      providerState: null,
      legacySourceConversationId: 'graph_conversation_legacy',
      resumable: false,
      readOnly: true,
    });
    const html = renderToStaticMarkup(
      <App snapshot={createSnapshot()} initialMainNavTarget="conversations" initialNativeConversationChoices={[createNativeConversationChoicesSnapshot(legacyChoice)]} initialSelectedNativeConversationId={legacyChoice.id} />,
    );
    const source = readSessionSource('ProjectConversationTree.tsx', 'SessionWorkspace.tsx', 'LegacyConversationBanner.tsx');
    const css = `${readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8')}\n${readSessionCss()}`;

    expect(source).not.toContain('conversation-archive-actions');
    expect(css).not.toContain('conversation-archive-actions');
    expect(source).not.toContain('conversation-archive-command-rail');
    expect(css).not.toContain('conversation-archive-command-rail');
    expect(html).toContain('data-conversation-runtime-state="legacy_readonly"');
    expect(html).toContain('session-legacy-banner');
    expect(html).toContain('旧会话记录为只读');
    expect(html).toContain('前往设置导入');
    expect(html).not.toContain('在新的 native 会话中引用');
    expect(source).toContain("transportKind !== 'codex_native'");
    expect(css).toMatch(/\.session-codex-parity-v1 \.session-legacy-banner\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/s);
  });

  it('renders project code and settings as a dense repository workbench instead of a sparse action strip', () => {
    const codeHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />);
    const settingsHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialProjectConfig={createProjectConfig()} />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const html of [codeHtml, settingsHtml]) {
      expect(html).toContain('project-repository-workbench');
      expect(html).toContain('project-code-primary');
      expect(html).toContain('project-code-context-rail');
      expect(html).toContain('code-repository-facts');
      expect(html).toContain('code-graph-status-strip');
      expect(html).toContain('code-repository-primary-rail');
      expect(html).toContain('code-repository-secondary-rail');
    }
    expect(codeHtml).not.toContain('project-repository-status-row');
    expect(settingsHtml).toContain('project-repository-status-row');

    expect(codeHtml).not.toContain('repository-primary-actions');
    expect(codeHtml).not.toContain('repository-secondary-actions');
    expect(settingsHtml).not.toContain('repository-primary-actions');
    expect(settingsHtml).not.toContain('repository-secondary-actions');
    expect(css).not.toContain('.repository-primary-actions');
    expect(css).not.toContain('.repository-secondary-actions');
    expect(codeHtml).not.toContain('project-repository-strip');
    expect(settingsHtml).not.toContain('project-repository-strip');
    expect(css).not.toContain('.project-repository-strip');
    expect(css).toContain('项目仓库工作台最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-repository-workbench\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-primary\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.workspace-drawer\s*\{[\s\S]*z-index:\s*72/);
  });

  it('renames project code repository chrome into a code context rail instead of summary or command-center shells', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const currentClass of ['project-code-context-rail', 'code-repository-facts', 'code-graph-status-strip', 'code-repository-primary-rail', 'code-repository-secondary-rail']) {
      expect(html).toContain(currentClass);
      expect(source).toContain(currentClass);
      expect(css).toContain(currentClass);
    }

    for (const staleClass of ['project-repository-command-center', 'repository-health-list', 'repository-graph-summary', 'repository-primary-command-rail', 'repository-secondary-command-rail']) {
      expect(html).not.toContain(staleClass);
      expect(source).not.toContain(staleClass);
      expect(css).not.toContain(staleClass);
    }

    expect(source).not.toContain("? 'code-context-rail'");
    expect(source).not.toContain("'code-context-rail' : ''");
  });

  it('normalizes the project code overview into a code context rail instead of stacked status and action cards', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('project-code-context-rail');
    expect(html).toContain('code-repository-fact-row');
    expect(html).toContain('code-repository-primary-rail');
    expect(html).toContain('code-repository-secondary-rail');
    expect(source).not.toContain('repository-primary-actions');
    expect(source).not.toContain('repository-secondary-actions');
    expect(source).not.toContain('object-summary project-status-panel');
    expect(source).not.toContain('project-operations-panel');
    expect(css).toContain('代码库上下文 rail 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-code-context-rail\s*\{[\s\S]*grid-template-areas:\s*['"]health graph['"] ['"]primary secondary['"]/);
    expect(css).toMatch(/\.macos-ai-app \.code-repository-fact-row\s*\{[\s\S]*grid-template-columns:\s*96px minmax\(0,\s*1fr\)/);
  });

  it('keeps semantic text visible in graph drawers instead of globally hiding p, em and small tags', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).not.toMatch(/\.macos-ai-app p,\s*\.macos-ai-app em,\s*\.macos-ai-app small,[\s\S]*display:\s*none\s*!important/s);
    expect(css).toContain('图谱抽屉文本与来源信息必须可见');
    expect(css).toMatch(/\.macos-ai-app \.code-map-view :where\(p,\s*em,\s*small\)\s*\{[^}]*display:\s*revert/s);
  });

  it('mounts the product App only after hydration succeeds and reports bootstrap failures to Main', () => {
    const source = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
    const settingsLoadedAt = source.indexOf('await client.loadAppShellSettings()');
    const rendererRootResolvedAt = source.indexOf("const root = document.getElementById('root')");
    const rootCreatedAt = source.indexOf('const reactRoot = createRoot(root)');
    const renderCalledAt = source.indexOf('reactRoot.render(');
    const readyReportedAt = source.indexOf('window.zeus?.reportRendererBootstrapReady?.()');
    const hydrationCatchSource = source.slice(source.indexOf('hydrateDashboard().catch'), source.indexOf('function reportRendererFatalFailure'));

    expect(settingsLoadedAt).toBeGreaterThan(-1);
    expect(rendererRootResolvedAt).toBeGreaterThan(source.indexOf('async function renderWithClient'));
    expect(rootCreatedAt).toBeGreaterThan(settingsLoadedAt);
    expect(readyReportedAt).toBeGreaterThan(renderCalledAt);
    expect(source.match(/createRoot\(root\)/g)).toHaveLength(1);
    expect(source).toContain('window.zeus?.reportRendererFatalFailure?.(formatHydrationError(error))');
    expect(source).not.toContain('<App localClientStatus="connecting"');
    expect(source).not.toContain('<App localClientStatus="failed"');
    expect(source).not.toContain('localClientStatus=');
    expect(hydrationCatchSource).not.toContain('createRoot(');
    expect(hydrationCatchSource).not.toContain('reactRoot.render(');
    expect(hydrationCatchSource).not.toContain('<App');
  });

  it('keeps the static startup shell text-free, unfocusable, and reduced-motion safe', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

    expect(html).toContain('<div class="zeus-startup-loader" aria-hidden="true">');
    expect(html).toContain('src="./assets/icon.svg"');
    expect(html).toContain('alt=""');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    expect(html).toMatch(/prefers-reduced-motion:[\s\S]*\.zeus-startup-icon[\s\S]*animation:\s*none/);
    for (const forbidden of ['正在启动本地服务', '本地服务连接失败', '本机 API 暂不可用', 'Connecting local service', 'Local service unavailable', 'Local API temporarily unavailable']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('builds default and template task action payloads from the selected app language instead of hard-coding Chinese in the renderer entry', () => {
    const source = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');

    expect(buildProjectDirectoryResolution('/tmp/demo', 'zh-CN')).toEqual({ path: '/tmp/demo', description: '用户选择的真实本地仓库' });
    expect(buildProjectDirectoryResolution(null, 'en-US')).toEqual({ path: null, description: 'User cancelled selection; existing projects are unchanged' });
    expect(buildGraphNodeTaskIntent('zh-CN')).toBe('分析该图谱节点的实现风险、影响范围和建议测试范围');
    expect(buildGraphNodeTaskIntent('en-US')).toBe('Analyze this graph node for implementation risk, impact scope, and recommended test coverage');
    expect(buildTemplateTaskDraft('zh-CN').title).toBe('从模板创建的任务');
    expect(buildTemplateTaskDraft('en-US').variables.goal).toBe('Fill in the real task goal from the selected template');
    expect(buildDefaultTaskDraft('zh-CN').title).toBe('分析当前项目结构');
    expect(buildDefaultTaskDraft('en-US').description).toBe('Analyze the current project from real scans and Git status');

    for (const requiredHelper of [
      'buildProjectDirectoryResolution(selectedPath, appLanguage)',
      'resolveProjectDirectoryForCreation(selectedPath, appShellSettings.appLanguage)',
      'buildGraphNodeTaskIntent(appShellSettings.appLanguage)',
      'buildTemplateTaskDraft(appShellSettings.appLanguage)',
    ]) {
      expect(source).toContain(requiredHelper);
    }
    expect(source).not.toContain('buildDefaultTaskDraft(appShellSettings.appLanguage)');
    for (const staleHardcodedPayload of [
      "description: '用户选择的真实本地仓库'",
      "intent: '分析该图谱节点的实现风险、影响范围和建议测试范围'",
      "title: '从模板创建的任务'",
      "goal: '基于模板补充真实任务目标'",
      "title: '分析当前项目结构'",
      "description: '基于真实扫描和 Git 状态分析当前 Zeus 仓库'",
    ]) {
      expect(source).not.toContain(staleHardcodedPayload);
    }
  });

  it('keeps packaged repository creation portable when the native directory picker is cancelled', () => {
    const source = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');

    expect(source).toContain('resolveProjectDirectoryForCreation');
    expect(buildProjectDirectoryResolution(null, 'zh-CN')).toEqual({ path: null, description: '用户取消选择，已保留当前项目列表' });
    expect(buildProjectDirectoryResolution(null, 'en-US')).toEqual({ path: null, description: 'User cancelled selection; existing projects are unchanged' });
    expect(source).toContain('resolveProjectDirectoryForCreation(selectedPath, appShellSettings.appLanguage)');
    expect(source).not.toContain('/Users/david/hypha/zeus');
    expect(source).not.toContain('当前 Zeus 代码库');
  });
});
