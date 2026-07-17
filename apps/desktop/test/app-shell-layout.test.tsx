import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as RendererAppModule from '../src/renderer/App.js';
import {
  App,
  PROJECT_SIDEBAR_DEFAULT_WIDTH,
  PROJECT_SIDEBAR_MAX_WIDTH,
  PROJECT_SIDEBAR_MIN_WIDTH,
  SessionMobileSourceTrigger,
  adjustProjectSidebarWidthForKeyboard,
  beginNativeConversationChoiceTaskLoad,
  clampProjectSidebarWidth,
  completeNativeConversationChoiceTaskLoad,
  createNativeConversationChoiceLoadCoordinator,
  createNativeProjectConversationChoiceLoadCoordinator,
  failNativeConversationChoiceTaskLoad,
  readProjectSidebarPreferredWidth,
  resolveSelectedNativeConversationForProject,
  resolveSessionDrawerInitialFocusTarget,
  scheduleSessionDrawerInitialFocus,
  shouldRefreshConversationForRuntimeEvent,
} from '../src/renderer/App.js';
import type {
  AiRuntimeAdapterDescriptor,
  AiRuntimeLogEntry,
  AiRuntimeSession,
  AppShellSettings,
  DashboardSnapshot,
  GitDiffSummary,
  GitOperationConfirmation,
  GraphViewSnapshot,
  ProjectConfig,
  ReleaseStatusSnapshot,
  ReleaseUpdateStatusSnapshot,
  RuntimeSettings,
  RuntimeStatusSnapshot,
  SecuritySecretsSnapshot,
} from '../src/renderer/apiClient.js';
import type { NativeConversationChoice } from '../src/renderer/session/sessionTypes.js';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function zeusSelectOptionPattern(value: string, label: string): RegExp {
  return new RegExp(`role="option"[^>]*data-value="${escapeRegex(value)}"[^>]*>[\\s\\S]*?${escapeRegex(label)}[\\s\\S]*?<\\/button>`, 'u');
}

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
    defaultModel: 'gpt-5-codex',
    defaultWorkMode: 'develop',
    defaultTaskPrompt: '先读 docs 再改代码',
    scan: { ignoreDirectories: ['node_modules', 'dist'], indexScope: 'project' },
    language: { primary: 'typescript', additional: ['javascript'] },
    dependencies: { packageManagers: ['pnpm'], manifestPaths: ['package.json'] },
    vcs: { isGitRepository: true, gitRoot: '/Users/david/hypha/zeus' },
    database: { connectionName: 'local-sqlite', schemaPaths: ['packages/storage/src/schema.sql'] },
    telegram: { alias: 'zeus-dev' },
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
    dataPortability: {
      importSupported: true,
      exportSupported: true,
      redactsSecrets: true,
    },
    cache: { codeIndex: true, graphView: true, layout: true },
    lastCacheClearAt: null,
  };
}

function createRuntimeSettings(): RuntimeSettings {
  return {
    defaultAdapterId: 'codex',
    adapterModels: { codex: 'gpt-real' },
    adapterDefaultArgs: { codex: ['--ask-for-approval', 'never'] },
    adapterCliPaths: { codex: '/opt/homebrew/bin/codex' },
    terminalEnv: { ZEUS_REAL_TASK: 'enabled' },
    shell: { path: '/bin/zsh', login: true },
    concurrency: { maxPerProject: 1, maxGlobal: 2 },
    executionTimeoutSeconds: 900,
    logRetentionDays: 14,
    autoConfirmationPolicy: 'low_risk_only',
  };
}

function createRuntimeAdapters(): AiRuntimeAdapterDescriptor[] {
  return [
    {
      id: 'codex',
      name: 'Codex CLI',
      displayName: 'OpenAI Codex CLI',
      command: 'codex',
      capabilities: ['detect'],
    },
    {
      id: 'generic',
      name: 'Generic shell',
      displayName: 'Generic shell',
      command: 'sh',
      capabilities: ['shell'],
    },
  ];
}

function createRuntimeStatus(): RuntimeStatusSnapshot {
  return {
    aiCli: {
      name: 'Codex CLI',
      command: 'codex',
      available: false,
      reason: 'Waiting for local CLI configuration.',
    },
    telegram: { enabled: false, reason: 'Telegram is not configured.' },
    terminal: {
      provider: 'child_process',
      pty: { available: false, reason: 'PTY is not enabled.' },
    },
  };
}

function createSecuritySecrets(): SecuritySecretsSnapshot {
  return {
    telegramBotToken: { configured: true, label: 'Configured' },
    externalApiKey: { configured: false, label: 'External API key not configured' },
  };
}

function createSecurityOnlySecrets(): SecuritySecretsSnapshot {
  return {
    telegramBotToken: { configured: false, label: 'Telegram token not configured' },
    externalApiKey: { configured: true, label: 'External API key configured' },
  };
}

function createGitSettingsConfirmation(): GitOperationConfirmation {
  return {
    id: 'git-confirm-settings',
    operation: 'branch',
    cwd: '/Users/david/hypha/zeus',
    reason: 'Create branch from settings test',
    status: 'pending',
    riskLevel: 'high',
    confirmationText: 'Confirm branch creation',
    createdAt: '2026-06-18T00:00:00.000Z',
    expiresAt: '2026-06-18T00:10:00.000Z',
  };
}

function createGraphView(): GraphViewSnapshot {
  return {
    id: 'view_i18n_filters',
    title: 'Zeus 系统架构图',
    viewType: 'architecture',
    nodes: [
      {
        id: 'node_file',
        nodeType: 'file',
        name: 'App.tsx',
        qualifiedName: 'apps/desktop/src/renderer/App.tsx',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        symbolId: 'symbol_file',
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'edge_declares',
        edgeType: 'declares',
        sourceNodeId: 'node_file',
        targetNodeId: 'node_file',
        sourceRef: 'apps/desktop/src/renderer/App.tsx',
        confidence: 1,
      },
    ],
  };
}

function createReleaseStatus(): ReleaseStatusSnapshot {
  return {
    signing: { configured: false, label: '等待签名证书' },
    notarization: { configured: false, label: '等待公证凭据' },
    homebrewCask: { configured: true, label: '本地 cask 已生成' },
    releaseWorkflow: { configured: true, label: 'GitHub Release workflow 已配置' },
    readiness: {
      canBuildUnsignedArtifacts: true,
      canSign: false,
      canNotarize: false,
      waitingFor: ['Apple signing certificate', 'Apple notarization credentials'],
    },
    autoUpdate: {
      currentVersion: '0.1.0',
      channel: 'manual',
      checkMode: 'manual',
      updateFeedConfigured: false,
      changelogPath: 'docs/release.md',
      waitingFor: ['signed and notarized artifacts'],
      label: '手动更新 · 0.1.0',
    },
  };
}

function createReleaseUpdateStatus(): ReleaseUpdateStatusSnapshot {
  return {
    status: 'available',
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    channel: 'stable',
    releasePageUrl: 'https://github.com/imchenway/zeus/releases/tag/v0.2.0',
    artifact: {
      arch: 'arm64',
      kind: 'dmg',
      fileName: 'Zeus-0.2.0-arm64.dmg',
      sha256: 'real_sha256',
      sizeBytes: 42,
      downloadUrl: 'https://github.com/imchenway/zeus/releases/download/v0.2.0/Zeus-0.2.0-arm64.dmg',
    },
    automaticInstallEnabled: false,
    recommendedAction: 'open_download_page',
    label: '发现新版本',
    reason: '下载安装需要签名与公证。',
    checkedAt: '2026-06-18T00:00:00.000Z',
  };
}

describe('Zeus 收纳式壳层布局', () => {
  it('renders a project-first sidebar like the reference instead of Projects, Conversations and Settings as top-level tabs', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(html).toContain('project-first-sidebar');
    expect(html).toContain('项目列表');
    expect(html).toContain('Zeus');
    expect(html).toContain('project-section-menu');
    expect(html).toContain('任务');
    expect(html).toContain('代码');
    expect(html).toContain('会话');
    expect(html).toContain('project-global-settings');

    for (const removedTarget of ['dashboard', 'projects', 'conversations', 'tasks', 'runtime', 'code-map', 'git-diff', 'telegram']) {
      expect(html).not.toContain(`href="#${removedTarget}"`);
    }
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);
    for (const removedCopy of ['本地 CLI 对话', 'Code Map', 'Git Diff', 'Runtime', 'Telegram', 'ZEUS WORKSPACES', 'PREFERENCES', 'Local AI Workbench']) {
      expect(sidebar).not.toContain(removedCopy);
    }
    expect(source).not.toContain('const navItems');
    expect(source).not.toContain('MainNavItem');
    expect(source).not.toContain('mainNavTargets');
    expect(source).not.toContain('mainNavTargetForItem');
  });

  it('does not render the repository picker inside the project heading once real projects exist', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const headingStart = html.indexOf('class="project-sidebar-heading"');
    const firstProjectStart = html.indexOf('class="project-sidebar-item', headingStart);
    const headingHtml = html.slice(headingStart, firstProjectStart);

    expect(headingHtml).toContain('项目');
    expect(headingHtml).not.toContain('选择真实本地代码库');
    expect(headingHtml).not.toContain('<button');
  });

  it('keeps projects directly below the real quick actions without placeholder plugin or automation entries', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);
    const quickActionsIndex = sidebar.indexOf('project-quick-actions');
    const projectListIndex = sidebar.indexOf('project-sidebar-list');

    expect(quickActionsIndex).toBeGreaterThanOrEqual(0);
    expect(projectListIndex).toBeGreaterThan(quickActionsIndex);
    expect(sidebar.slice(quickActionsIndex, projectListIndex)).toContain('新对话');
    expect(sidebar.slice(quickActionsIndex, projectListIndex)).toContain('搜索');
    expect(sidebar).not.toContain('插件');
    expect(sidebar).not.toContain('自动化');
    expect(sidebar).not.toContain('插件等待真实能力');
    expect(sidebar).not.toContain('自动化等待真实能力');
  });

  it('locks the sidebar quick actions to the Codex reference baseline instead of a centered title block', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('codex-source-list-quick-actions');
    expect(source).toContain('className="project-quick-action"');
    expect(source).toContain('project-quick-action-label');
    expect(css).toContain('Codex source-list 快捷入口硬边界最终覆盖');
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions\s*\{[\s\S]*align-self:\s*stretch/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[\s\S]*justify-items:\s*start/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[\s\S]*font-size:\s*13px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[\s\S]*text-align:\s*left/);
    expect(css).toContain('Codex 参考快捷入口像素基线最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.ai-sidebar nav\.project-quick-actions\s*\{[\s\S]*inline-size:\s*100%/);
    expect(css).toMatch(/\.macos-ai-app \.ai-sidebar nav\.project-quick-actions\s*\{[\s\S]*justify-items:\s*stretch/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[\s\S]*inline-size:\s*100%/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[\s\S]*grid-template-columns:\s*22px minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[\s\S]*min-block-size:\s*28px/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[\s\S]*padding:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[\s\S]*font-weight:\s*540/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-action-label\s*\{[\s\S]*justify-self:\s*start/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-action-icon svg\s*\{[\s\S]*stroke-width:\s*1\.45/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[^}]*box-shadow:\s*(?!none)/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[^}]*text-align:\s*center/);
  });

  it('aligns quick actions like the Codex source list instead of centered oversized buttons', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Codex 侧栏快捷入口最终覆盖');
    expect(css).toContain('Codex 快捷入口 nav 特异性最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.ai-sidebar nav\.project-quick-actions\s*\{[\s\S]*block-size:\s*auto/);
    expect(css).toMatch(/\.macos-ai-app \.ai-sidebar nav\.project-quick-actions\s*\{[\s\S]*display:\s*grid/);
    expect(css).toMatch(/\.macos-ai-app \.ai-sidebar nav\.project-quick-actions\s*\{[\s\S]*flex:\s*0 0 auto/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions\s*\{[\s\S]*align-items:\s*stretch/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[\s\S]*grid-template-columns:\s*22px minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[\s\S]*justify-content:\s*start/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[\s\S]*font-size:\s*14px/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions button > span\[aria-hidden=['"]true['"]\]\s*\{[\s\S]*inline-size:\s*22px/);
    expect(css).toMatch(/\.macos-ai-app \.project-quick-actions button > span\[aria-hidden=['"]true['"]\]\s*\{[\s\S]*font-size:\s*17px/);
    expect(css).not.toMatch(/\.macos-ai-app \.ai-sidebar nav\.project-quick-actions\s*\{[^}]*block-size:\s*100%/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[^}]*justify-content:\s*center/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[^}]*font-size:\s*28px/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[^}]*min-block-size:\s*38px/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[^}]*padding:\s*0 10px/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-quick-actions button\s*\{[^}]*font-weight:\s*560/);
  });

  it('overrides the old full-height nav rule so the project list is not pushed to the bottom', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.macos-ai-app \.project-first-sidebar \.project-quick-actions\s*{[^}]*block-size:\s*auto/s);
    expect(css).toMatch(/\.macos-ai-app \.project-first-sidebar \.project-sidebar-list\s*{[^}]*flex:\s*1 1 auto/s);
  });

  it('keeps project rows compact instead of letting the sidebar list grid stretch them apart', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.macos-ai-app \.project-first-sidebar \.project-sidebar-list\s*{[^}]*display:\s*flex/s);
    expect(css).toMatch(/\.macos-ai-app \.project-first-sidebar \.project-sidebar-list\s*{[^}]*flex-direction:\s*column/s);
    expect(css).not.toMatch(/\.macos-ai-app \.project-first-sidebar \.project-sidebar-list,\s*\n\.macos-ai-app \.project-first-sidebar \.project-global-settings\s*{[^}]*display:\s*grid/s);
  });

  it('wires the global project source list to vertical keyboard navigation instead of static aria only', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const snapshot = createSnapshot();
    snapshot.tasks[0] = { ...snapshot.tasks[0], title: 'Bug 分析当前项目结构', tags: ['backend'] };
    const html = renderToStaticMarkup(<App snapshot={snapshot} />);
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);

    expect(source).toContain('const handleSourceListKeyboardNavigation = (event: ReactKeyboardEvent<HTMLElement>) => {');
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(source).toContain(`event.key === '${key}'`);
    }
    expect(sidebar).toContain('class="project-sidebar-list zeus-source-list" role="navigation" data-source-list-keyboard="vertical"');
    expect(sidebar).toContain('class="project-row-main" tabindex="0" data-source-list-item="true"');
    expect(sidebar).not.toContain('class="project-row-main" aria-current="page"');
  });

  it('wires secondary menus and decision rails to horizontal keyboard navigation instead of click-only button rows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const snapshot = createSnapshot();
    const sessionHtml = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="conversations" />);
    const taskHtml = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="tasks" />);
    const settingsHtml = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="settings" />);
    const sidebar = sessionHtml.slice(sessionHtml.indexOf('<aside class="zeus-sidebar'), sessionHtml.indexOf('</aside>') + '</aside>'.length);

    expect(source).toContain('const handleInlineRailKeyboardNavigation = (event: ReactKeyboardEvent<HTMLElement>) => {');
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      expect(source).toContain(`event.key === '${key}'`);
    }
    expect(source).toContain(`querySelectorAll<HTMLElement>('[data-inline-rail-item="true"]:not([disabled])')`);
    expect(sidebar).toContain('class="project-section-menu animated-project-menu" data-inline-rail-keyboard="horizontal"');
    expect(sidebar).toContain('class="project-section-menu-item active" aria-current="page" tabindex="0" data-inline-rail-item="true"');
    expect(sidebar).toContain('class="project-section-menu-item " tabindex="-1" data-inline-rail-item="true"');
    expect(taskHtml).not.toContain('class="task-filter-command-rail task-filter-action-rail"');
    expect(taskHtml).toContain('class="task-table-new-task-button"');
    expect(taskHtml).not.toContain('class="task-management-command-rail zeus-decision-rail" data-inline-rail-keyboard="horizontal"');
    expect(sessionHtml).toContain('session-codex-parity-v1');
    expect(sessionHtml).not.toContain('task-detail-console');
    expect(sessionHtml).not.toContain('task-detail-command-rail');
    expect(sessionHtml).not.toContain('task-detail-primary-action');
    expect(sessionHtml).not.toContain('task-detail-secondary-action');
    expect(source).toContain('className="graph-qa-decision-rail zeus-decision-rail" data-inline-rail-keyboard="horizontal"');
    expect(source).toContain('className="graph-qa-ask-button zeus-decision-rail-button"');
    expect(settingsHtml).toContain('class="settings-section-nav settings-sidebar-nav" aria-label="设置分段" role="tablist" aria-orientation="vertical" data-inline-rail-keyboard="vertical"');
    expect(settingsHtml).toContain('class="settings-section-button selected" role="tab" aria-selected="true" tabindex="0" data-inline-rail-item="true"');
    expect(settingsHtml).toContain('<span class="settings-section-label">AI CLI / Runtime</span>');
    expect(source).toContain('className="settings-section-nav settings-sidebar-nav"');
    expect(source).toContain('onKeyDown={handleInlineRailKeyboardNavigation}');
  });

  it('highlights only the current child menu item instead of the parent project row or same menu in other expanded projects', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);

    expect(sidebar).not.toContain('project-sidebar-item selected');
    expect(sidebar).not.toContain('class="project-row-main" aria-current="page"');
    expect(sidebar).toContain('class="project-section-menu-item active" aria-current="page" tabindex="0" data-inline-rail-item="true"');
    expect(source).toContain("const isActiveProject = project.id === props.activeProjectId && props.activeNavTarget !== 'settings';");
    expect(source).toContain('const current = isActiveProject && props.activeProjectSection === item.id;');
    expect(source).not.toContain('const current = props.activeProjectSection === item.id;');
  });

  it('adds native source-list accessibility semantics to the global project list instead of anonymous button stacks', () => {
    const snapshot = createSnapshot();
    snapshot.tasks[0] = { ...snapshot.tasks[0], title: 'Bug 分析当前项目结构', tags: ['backend'] };
    const html = renderToStaticMarkup(<App snapshot={snapshot} />);
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);

    expect(sidebar).toContain('class="project-sidebar-list zeus-source-list" role="navigation"');
    expect(sidebar).toContain('class="project-row-main" tabindex="0" data-source-list-item="true"');
    expect(sidebar).not.toContain('class="project-row-main" aria-current="page"');
    expect(sidebar).toContain('class="project-section-menu-item active" aria-current="page" tabindex="0" data-inline-rail-item="true"');
  });

  it('normalizes project sidebar rows into fixed source-list slots instead of loose button clusters', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const className of ['project-sidebar-item', 'project-sidebar-row', 'project-settings-button', 'project-row-main', 'project-expand-button', 'project-row-actions', 'native-folder-icon']) {
      expect(source).toContain(className);
    }
    expect(css).toContain('项目侧栏行最终覆盖');
    for (const token of ['--zeus-project-row-bg', '--zeus-project-row-selected-bg', '--zeus-project-row-line', '--zeus-project-row-text', '--zeus-project-row-muted', '--zeus-project-row-action-bg']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.project-first-sidebar \.project-sidebar-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) 22px 22px 24px/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-sidebar-item\.selected \.project-sidebar-row\s*\{/);
    expect(css).toMatch(/\.macos-ai-app \.project-sidebar-row:where\(:hover,\s*:focus-within\)\s*\{[\s\S]*background:\s*var\(--zeus-native-row-hover\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-row-main\s*\{[\s\S]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.native-folder-icon\s*\{[\s\S]*inline-size:\s*16px/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-first-sidebar \.project-sidebar-row\s*\{[^}]*padding:\s*12px/);
  });

  it('locks the project list to the compact macOS source-list typography instead of oversized rows', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('项目列表参考图密度最终覆盖');
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-sidebar-heading\s*\{[\s\S]*font-size:\s*14px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-sidebar-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) 22px 22px 24px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-sidebar-row\s*\{[\s\S]*min-block-size:\s*28px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-row-main\s*\{[\s\S]*font-size:\s*14px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-row-main strong\s*\{[\s\S]*font-weight:\s*520/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.native-folder-icon\s*\{[\s\S]*inline-size:\s*18px/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-row-main\s*\{[^}]*font-size:\s*(?:18|20|22|24|28)px/);
  });

  it('keeps the source-list quick actions below the hidden macOS traffic lights with the sidebar inset itself', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('macOS traffic-light sidebar inset final cover');
    expect(css).toMatch(/--zeus-hidden-titlebar-safe-top:\s*44px/);
    expect(css).toMatch(/--zeus-traffic-light-no-content-zone:\s*44px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar,\n\.macos-ai-app\.zeus-shell\.ai-native-shell \.project-first-sidebar\s*\{[\s\S]*padding-block-start:\s*var\(--zeus-hidden-titlebar-safe-top,\s*44px\)/);
    expect(css).toMatch(
      /\.project-first-sidebar\.zeus-sidebar\.ai-sidebar\.zeus-titlebar-protected-source-list\s*\{[\s\S]*padding-block-start:\s*var\(--zeus-hidden-titlebar-safe-top,\s*44px\) !important[\s\S]*padding-top:\s*var\(--zeus-hidden-titlebar-safe-top,\s*44px\) !important/,
    );
    expect(css).toMatch(/\.project-first-sidebar \.project-window-control-reserved-space\s*\{[\s\S]*display:\s*none/);
    expect(css).not.toContain('--zeus-window-control-sidebar-padding-top');
    expect(css).not.toContain('--zeus-window-control-flow-spacer');
    expect(css).not.toMatch(/padding-block-start:\s*var\(--zeus-window-control-sidebar-padding-top/);
    expect(css).not.toMatch(/padding-top:\s*var\(--zeus-window-control-sidebar-padding-top/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar,\n\.macos-ai-app\.zeus-shell\.ai-native-shell \.project-first-sidebar\s*\{[\s\S]*overflow:\s*hidden/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar,\n\.macos-ai-app\.zeus-shell\.ai-native-shell \.project-first-sidebar\s*\{[\s\S]*overflow-y:\s*hidden/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions\s*\{[\s\S]*position:\s*relative/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions\s*\{[\s\S]*z-index:\s*1/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar,\n\.macos-ai-app\.zeus-shell\.ai-native-shell \.project-first-sidebar\s*\{[^}]*padding-block-start:\s*0/);
    expect(css).not.toMatch(/\.project-first-sidebar\.zeus-sidebar\.ai-sidebar\s*\{[\s\S]*padding-top:\s*8px !important/);
    expect(css).not.toContain('padding: 44px 10px 10px;');
    expect(css).not.toContain('padding: 58px 10px 10px;');
    expect(css).not.toContain('padding: 58px 12px 18px;');
    expect(css).not.toContain('padding: 88px 10px 10px;');
    expect(css).not.toMatch(/--zeus-hidden-titlebar-safe-top:\s*10px/);
    expect(css).not.toMatch(/--zeus-hidden-titlebar-safe-top:\s*22px/);
    expect(css).not.toMatch(/--zeus-hidden-titlebar-safe-top:\s*72px/);
    expect(css).not.toMatch(/--zeus-hidden-titlebar-safe-top:\s*58px/);
    expect(css).not.toMatch(/--zeus-hidden-titlebar-safe-top:\s*84px/);
    expect(css).not.toMatch(/--zeus-hidden-titlebar-safe-top:\s*104px/);
  });

  it('keeps the legacy source-list spacer collapsed so the real sidebar inset is the only traffic-light guard', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);
    const reservedSpaceIndex = sidebar.indexOf('project-window-control-reserved-space');
    const quickActionsIndex = sidebar.indexOf('codex-source-list-quick-actions');

    expect(reservedSpaceIndex).toBeGreaterThan(-1);
    expect(quickActionsIndex).toBeGreaterThan(reservedSpaceIndex);
    expect(css).toContain('macOS traffic-light sidebar inset final cover');
    expect(css).toMatch(/\.project-first-sidebar \.project-window-control-reserved-space\s*\{[\s\S]*display:\s*none/);
    expect(css).toMatch(/\.project-first-sidebar \.project-window-control-reserved-space\s*\{[\s\S]*block-size:\s*0/);
    expect(css).toMatch(/\.project-first-sidebar\.zeus-sidebar\.ai-sidebar\s*\{[\s\S]*padding-top:\s*var\(--zeus-hidden-titlebar-safe-top,\s*44px\) !important/);
    expect(css).not.toMatch(/\.project-first-sidebar\.zeus-sidebar\.ai-sidebar\s*\{[\s\S]*padding-top:\s*(?:8|10|16|22|58|72)px !important/);
  });

  it('keeps the macOS traffic-light inset active even when the packaged shell class is not an ancestor yet', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('macOS traffic-light inset root fallback');
    expect(css).toMatch(/\.project-first-sidebar\.zeus-sidebar\.ai-sidebar\s*\{[\s\S]*padding-top:\s*var\(--zeus-hidden-titlebar-safe-top,\s*44px\) !important/);
  });

  it('hardens the real project source list with a dedicated titlebar protected class so traffic lights cannot cover quick actions', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);

    expect(sidebar).toContain('zeus-titlebar-protected-source-list');
    expect(css).toContain('macOS traffic-light source-list protected class final cover');
    expect(css).toMatch(
      /\.project-first-sidebar\.zeus-sidebar\.ai-sidebar\.zeus-titlebar-protected-source-list\s*\{[\s\S]*padding-block-start:\s*var\(--zeus-hidden-titlebar-safe-top,\s*44px\) !important[\s\S]*padding-top:\s*var\(--zeus-hidden-titlebar-safe-top,\s*44px\) !important/,
    );
  });

  it('keeps the project source-list top inset on the DOM itself so the packaged app cannot start under traffic lights', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);

    expect(sidebar).toContain('zeus-titlebar-protected-source-list');
    expect(sidebar).toContain('--zeus-hidden-titlebar-safe-top:44px');
    expect(sidebar).toContain('padding-block-start:var(--zeus-hidden-titlebar-safe-top, 44px)');
    expect(sidebar).toContain('padding-top:var(--zeus-hidden-titlebar-safe-top, 44px)');
    expect(sidebar).not.toContain('--zeus-window-control-sidebar-padding-top');
    expect(sidebar).not.toContain('--zeus-window-control-flow-spacer');
    expect(sidebar).not.toContain('padding-top:10px');
    expect(sidebar).not.toContain('padding-top:16px');
    expect(sidebar).not.toContain('padding-top:22px');
    expect(sidebar).not.toContain('padding-top:72px');
    expect(sidebar).not.toContain('padding-top:58px');
    expect(sidebar).not.toContain('padding-top:84px');
  });

  it('matches the Codex sidebar scale with compact quick actions and a fixed bottom settings row', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('project-global-settings');
    expect(html).toContain('设置');
    expect(css).toContain('Codex 参考整体侧栏密度最终覆盖');
    expect(css).toContain('Codex source-list 像素缩放最终覆盖');
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar\s*\{[\s\S]*padding-block-start:\s*var\(--zeus-hidden-titlebar-safe-top\)/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions\s*\{[\s\S]*gap:\s*4px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions\s*\{[\s\S]*margin-block:\s*0 2px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar\s*\{[\s\S]*padding-block-start:\s*var\(--zeus-hidden-titlebar-safe-top\)/);
    expect(css).not.toContain('padding: 16px 10px 10px;');
    expect(css).not.toContain('padding: 64px 10px 10px;');
    expect(css).not.toMatch(/--zeus-hidden-titlebar-safe-top:\s*92px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[\s\S]*font-size:\s*13px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[\s\S]*font-weight:\s*520/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[\s\S]*grid-template-columns:\s*22px minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[\s\S]*min-block-size:\s*28px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action-icon svg\s*\{[\s\S]*inline-size:\s*16px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-sidebar-heading\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-sidebar-heading button\s*\{/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-sidebar-row\s*\{[\s\S]*min-block-size:\s*28px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-row-main strong\s*\{[\s\S]*font-size:\s*13px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-global-settings\s*\{[\s\S]*flex:\s*0 0 auto/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-global-settings button\s*\{[\s\S]*font-size:\s*13px/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell\.ai-native-shell \.project-first-sidebar \.project-sidebar-heading > button\s*\{/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-global-settings button\s*\{[\s\S]*grid-template-columns:\s*22px minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[^}]*font-size:\s*(?:16|20|22|24|28|32)px/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[^}]*font-weight:\s*560/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[^}]*padding:\s*0 8px/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action-icon svg\s*\{[^}]*inline-size:\s*18px/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action-icon svg\s*\{[^}]*stroke-width:\s*1\.55/);
    // left-sidebar whitespace stale guard
    expect(css).not.toContain('padding: 44px 18px 16px;');
    expect(css).not.toContain('padding: 38px 18px 14px;');
    expect(css).not.toContain('padding: 28px 18px 12px;');
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions\s*\{[^}]*gap:\s*6px/s);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions\s*\{[^}]*margin-block:\s*0 6px/s);
    expect(css).not.toContain('padding: 34px 18px 12px;');
    expect(css).not.toContain('padding: 22px 14px 10px;');
    expect(css).not.toContain('padding: 18px 12px 10px;');
    expect(css).not.toContain('padding: 16px 10px 10px;');
    expect(css).not.toContain('padding: 64px 10px 10px;');
    expect(css).not.toMatch(/--zeus-hidden-titlebar-safe-top:\s*92px/);
    expect(css).not.toContain('margin-block: 0 4px;');
    expect(css).not.toContain('margin-block: 0 3px;');
    expect(css).not.toContain('margin-block: 0 24px;');
    expect(css).not.toContain('margin-block: 0 14px;');
    expect(css).not.toContain('margin-block: 0 10px;');
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-global-settings\s*\{[^}]*display:\s*none/);
  });

  it('keeps the sidebar search action as a real local search instead of jumping to the first project tasks', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);

    expect(html).toContain('class="project-quick-action-label">搜索</span>');
    expect(source).toContain('const [projectSearchOpen, setProjectSearchOpen]');
    expect(source).toContain('const [projectSearchQuery, setProjectSearchQuery]');
    expect(source).toContain('const visibleProjects = projectSearchQuery.trim()');
    expect(source).toContain('className="project-sidebar-search-row"');
    expect(source).toContain('const toggleProjectSearch = () => {');
    expect(source).toContain('onClick={toggleProjectSearch}');
    expect(source).not.toContain("const project = props.projects[0];\n            if (project) props.onOpenProjectSection(project, 'tasks');");
  });

  it('makes the sidebar search field keyboard dismissible and clears stale filters on collapse', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const closeProjectSearch = () => {');
    expect(source).toContain('setProjectSearchOpen(false);');
    expect(source).toContain("setProjectSearchQuery('');");
    expect(source).toContain('const handleProjectSearchKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {');
    expect(source).toContain("if (event.key !== 'Escape') return;");
    expect(source).toContain('onKeyDown={handleProjectSearchKeyDown}');
    expect(source).toContain('closeProjectSearch();');
  });

  it('hard-locks the sidebar to the Codex screenshot proportions instead of relying on stale large button rules', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Codex 截图比例硬锁最终覆盖');
    expect(css).toMatch(/--zeus-source-sidebar:\s*oklch\(99\.2% 0\.0005 255\)/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar\s*\{[\s\S]*padding-block-start:\s*var\(--zeus-hidden-titlebar-safe-top\)/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[\s\S]*font-size:\s*13px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action\s*\{[\s\S]*font-weight:\s*520/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions \.project-quick-action-icon svg\s*\{[\s\S]*inline-size:\s*16px/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-sidebar-heading button\s*\{/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-row-main strong\s*\{[\s\S]*font-size:\s*13px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-global-settings button\s*\{[\s\S]*font-size:\s*13px/);
    expect(css).not.toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-sidebar-heading button\s*\{[^}]*display:\s*(?:inline-flex|grid|flex|block)/);
  });

  it('normalizes expanded project section menu into indented source-list rows instead of large loose buttons', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const className of ['project-section-menu-item', 'project-section-menu-icon', 'project-section-menu-label', 'project-section-menu-state']) {
      expect(source).toContain(className);
      expect(html).toContain(className);
    }
    expect(html).toContain('aria-current="page"');
    expect(css).toContain('项目二级菜单最终覆盖');
    for (const token of ['--zeus-project-menu-bg', '--zeus-project-menu-selected-bg', '--zeus-project-menu-line', '--zeus-project-menu-text', '--zeus-project-menu-muted']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.macos-ai-app \.project-first-sidebar \.project-section-menu\s*\{[\s\S]*margin-inline-start:\s*31px/);
    expect(css).toMatch(/\.macos-ai-app \.project-section-menu-item\s*\{[\s\S]*grid-template-columns:\s*16px minmax\(0,\s*1fr\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.project-section-menu-item\.active\s*\{[\s\S]*background:\s*var\(--zeus-project-menu-selected-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-section-menu-icon\s*\{[\s\S]*inline-size:\s*16px/);
    expect(html).toContain('animated-project-menu');
    expect(css).toContain('项目二级菜单展开动效最终覆盖');
    expect(css).toContain('@keyframes zeus-project-menu-enter');
    expect(css).toMatch(/\.macos-ai-app \.animated-project-menu\s*\{[\s\S]*animation:\s*zeus-project-menu-enter 160ms var\(--zeus-motion-ease-out\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-expand-chevron\s*\{[\s\S]*transition:\s*transform 160ms var\(--zeus-motion-ease-out\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.macos-ai-app \.animated-project-menu,[\s\S]*\.macos-ai-app \.project-expand-chevron[\s\S]*animation:\s*none/);
    expect(css).not.toMatch(/\.macos-ai-app \.animated-project-menu\s*\{[^}]*transition:\s*(?:width|height|top|left|right|bottom|margin)/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-first-sidebar \.project-section-menu button\s*\{[^}]*padding:\s*12px/);
  });

  it('uses an accessible conversation glyph instead of a hollow unicode circle for project sessions', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const projectMenuSource = source.slice(source.indexOf("{ id: 'tasks'"), source.indexOf(').map((item)'));

    expect(projectMenuSource).not.toContain("icon: '◌'");
    expect(html).toContain('data-project-section-icon="sessions"');
    expect(html).toMatch(/data-project-section-icon="sessions"[^>]*aria-hidden="true"[^>]*focusable="false"/);
    expect(css).toMatch(/\.macos-ai-app \.project-section-menu-icon svg\s*\{[^}]*inline-size:\s*13px/);
    expect(css).toMatch(/\.macos-ai-app \.project-section-menu-icon svg\s*\{[^}]*stroke-width:\s*1\.35/);
  });

  it('clamps, restores, and keyboard-adjusts the persisted project sidebar width', () => {
    const storage = (value: string | null) => ({ getItem: () => value });

    expect(PROJECT_SIDEBAR_DEFAULT_WIDTH).toBe(248);
    expect(PROJECT_SIDEBAR_MIN_WIDTH).toBe(200);
    expect(PROJECT_SIDEBAR_MAX_WIDTH).toBe(420);
    expect(clampProjectSidebarWidth(120, 1440)).toBe(200);
    expect(clampProjectSidebarWidth(500, 1440)).toBe(420);
    expect(clampProjectSidebarWidth(420, 800)).toBe(279);
    expect(clampProjectSidebarWidth(248, 760)).toBe(239);
    expect(readProjectSidebarPreferredWidth(storage('312'))).toBe(312);
    expect(readProjectSidebarPreferredWidth(storage('999'))).toBe(248);
    expect(readProjectSidebarPreferredWidth(storage('broken'))).toBe(248);
    expect(readProjectSidebarPreferredWidth(undefined)).toBe(248);
    expect(adjustProjectSidebarWidthForKeyboard(248, 'ArrowRight', false, 1440)).toBe(256);
    expect(adjustProjectSidebarWidthForKeyboard(248, 'ArrowLeft', true, 1440)).toBe(216);
    expect(adjustProjectSidebarWidthForKeyboard(248, 'Home', false, 1440)).toBe(200);
    expect(adjustProjectSidebarWidthForKeyboard(248, 'End', false, 1440)).toBe(420);
    expect(adjustProjectSidebarWidthForKeyboard(248, 'Enter', false, 1440)).toBeNull();
  });

  it('keeps preferred width separate from viewport clamping and only commits a real drag', () => {
    type DragResult = { preferredWidth: number; persist: boolean };
    type ResolveDrag = (startPreferredWidth: number, startRenderedWidth: number, startClientX: number, endClientX: number, viewportWidth: number, commit: boolean) => DragResult;
    const resolveDrag = (RendererAppModule as unknown as Record<string, unknown>).resolveProjectSidebarDragResult;

    expect(resolveDrag).toBeTypeOf('function');
    if (typeof resolveDrag !== 'function') return;
    const resolve = resolveDrag as ResolveDrag;
    expect(resolve(420, 279, 100, 100, 800, true)).toEqual({ preferredWidth: 420, persist: false });
    expect(resolve(420, 279, 100, 130, 800, false)).toEqual({ preferredWidth: 420, persist: false });
    expect(resolve(420, 279, 100, 130, 800, true)).toEqual({ preferredWidth: 420, persist: false });
    expect(resolve(420, 279, 100, 70, 800, true)).toEqual({ preferredWidth: 249, persist: true });
    expect(resolve(248, 248, 100, 140, 1440, true)).toEqual({ preferredWidth: 288, persist: true });
  });

  it('persists a normalized local sidebar preference without coupling it to the viewport', () => {
    type WritePreference = (storage: { setItem(key: string, value: string): void } | undefined, width: number) => boolean;
    const writePreference = (RendererAppModule as unknown as Record<string, unknown>).writeProjectSidebarPreferredWidth;
    const writes: Array<[string, string]> = [];

    expect(writePreference).toBeTypeOf('function');
    if (typeof writePreference !== 'function') return;
    const write = writePreference as WritePreference;
    expect(write({ setItem: (key, value) => writes.push([key, value]) }, 248)).toBe(true);
    expect(writes).toEqual([['zeus.shell.project-sidebar-width:v1', '248']]);
    expect(write({ setItem: (key, value) => writes.push([key, value]) }, 999)).toBe(true);
    expect(writes.at(-1)).toEqual(['zeus.shell.project-sidebar-width:v1', '420']);
    expect(write(undefined, 248)).toBe(false);
    expect(
      write(
        {
          setItem: () => {
            throw new Error('quota');
          },
        },
        248,
      ),
    ).toBe(false);
  });

  it('models one active pointer and restores the committed preference across cancel and re-entry', () => {
    type DragState = { pointerId: number; startPreferredWidth: number; startRenderedWidth: number; startClientX: number; lastClientX: number };
    type DragEvent = { type: 'move'; pointerId: number; clientX: number } | { type: 'finish'; pointerId: number; clientX: number; viewportWidth: number } | { type: 'cancel'; pointerId?: number };
    type Transition = (state: DragState, event: DragEvent) => { state: DragState | null; accepted: boolean; result: { preferredWidth: number; persist: boolean } | null };
    const transition = (RendererAppModule as unknown as Record<string, unknown>).transitionProjectSidebarDrag;
    const start: DragState = { pointerId: 7, startPreferredWidth: 420, startRenderedWidth: 279, startClientX: 100, lastClientX: 100 };

    expect(transition).toBeTypeOf('function');
    if (typeof transition !== 'function') return;
    const apply = transition as Transition;
    expect(apply(start, { type: 'move', pointerId: 8, clientX: 40 })).toEqual({ state: start, accepted: false, result: null });
    const moved = apply(start, { type: 'move', pointerId: 7, clientX: 70 });
    expect(moved).toEqual({ state: { ...start, lastClientX: 70 }, accepted: true, result: null });
    expect(apply(moved.state as DragState, { type: 'finish', pointerId: 8, clientX: 40, viewportWidth: 800 })).toEqual({ state: moved.state, accepted: false, result: null });
    expect(apply(moved.state as DragState, { type: 'cancel', pointerId: 8 })).toEqual({ state: moved.state, accepted: false, result: null });
    expect(apply(moved.state as DragState, { type: 'cancel' })).toEqual({ state: null, accepted: true, result: { preferredWidth: 420, persist: false } });
    expect(apply(moved.state as DragState, { type: 'finish', pointerId: 7, clientX: 70, viewportWidth: 800 })).toEqual({
      state: null,
      accepted: true,
      result: { preferredWidth: 249, persist: true },
    });
  });

  it('renders a native project sidebar separator only when the project source list is present', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const settingsHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('class="project-sidebar-resizer"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-valuemin="200"');
    expect(html).toContain('aria-valuemax="420"');
    expect(html).toContain('aria-valuenow="248"');
    expect(html).toContain('--zeus-project-sidebar-width:248px');
    expect(settingsHtml).not.toContain('project-sidebar-resizer');
    expect(source).toContain("if (event.key === 'Home' || event.key === 'End' || event.key === 'ArrowLeft' || event.key === 'ArrowRight')");
    expect(source).toContain('onDoubleClick={resetProjectSidebarWidth}');
    expect(source).toContain('setProjectSidebarPreferredWidth(PROJECT_SIDEBAR_DEFAULT_WIDTH);');
    expect(source).toContain('persistProjectSidebarPreferredWidth(PROJECT_SIDEBAR_DEFAULT_WIDTH);');
    expect(source).toContain("target.addEventListener('lostpointercapture', cancelProjectSidebarResize);");
    expect(source).toContain("window.addEventListener('blur', cancelProjectSidebarResize);");
    expect(source).toContain('projectSidebarCommittedWidthRef.current');
    expect(source).toContain('if (nextWidth !== null && nextWidth !== projectSidebarWidth)');
    expect(source).toContain('setProjectSidebarResizing(false);');
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell\.ai-native-shell\s*\{[^}]*grid-template-columns:\s*var\(--zeus-project-sidebar-width\) 1px minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-sidebar-resizer\s*\{[^}]*cursor:\s*col-resize/);
    expect(css).toMatch(/@media \(max-width:\s*759px\)\s*\{[\s\S]*\.macos-ai-app \.project-sidebar-resizer\s*\{[^}]*display:\s*none/);
  });

  it('keeps project rows like a native source list with right-side controls and click-only menus', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);

    const firstProjectRow = source.slice(source.indexOf('className="project-sidebar-row"'), source.indexOf('className={`project-row-actions'));
    expect(firstProjectRow.indexOf('project-row-main')).toBeGreaterThanOrEqual(0);
    expect(firstProjectRow.indexOf('project-expand-button')).toBeGreaterThan(firstProjectRow.indexOf('project-row-main'));
    expect(firstProjectRow.indexOf('project-settings-button')).toBeGreaterThan(firstProjectRow.indexOf('project-expand-button'));
    expect(source).toContain('expandedProjectIds');
    expect(source).toContain('toggleExpandedProject');
    expect(source).toContain('aria-expanded={expanded}');
    expect(source).toContain('project-expand-chevron');
    expect(source).toContain('expanded ?');
    expect(source).not.toContain('const [openProjectMenuId, setOpenProjectMenuId]');
    expect(source).not.toContain('copy.deleteProjectHint}</small>');
    expect(html).toContain('project-expand-chevron');

    expect(css).toContain('项目行原生 source-list 交互最终覆盖');
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar\s*\{[\s\S]*padding-block-start:\s*var\(--zeus-hidden-titlebar-safe-top\)/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.codex-source-list-quick-actions\s*\{[\s\S]*margin-block:\s*0 2px/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-sidebar-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) 22px 22px 24px/);
    expect(css).toMatch(/\.macos-ai-app \.project-sidebar-row :where\(\.project-expand-button, \.project-settings-button, \.project-more-button\)\s*\{[\s\S]*opacity:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.project-sidebar-row:where\(:hover, :focus-within\) :where\(\.project-expand-button, \.project-settings-button, \.project-more-button\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-expand-button\[aria-expanded='true'\] \.project-expand-chevron\s*\{[\s\S]*transform:\s*rotate\(90deg\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover\s*\{[\s\S]*min-inline-size:\s*128px/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover button\s*\{[\s\S]*min-block-size:\s*24px/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-row-actions:where\(:hover, :focus-within\) \.project-more-popover/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-more-popover small\s*\{/);
    expect(css).not.toMatch(/\.macos-ai-app \.native-folder-icon::before/);
  });

  it('defaults to the selected project session workspace and removes the standalone dashboard', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);

    expect(html).toContain('workspace-view-project-sessions');
    expect(html).toContain('分析当前项目结构');
    expect(html).toContain('session-codex-parity-v1');
    expect(html).not.toContain('aria-label="AI 工作台"');
    expect(html).not.toContain('Activity Stream');
    expect(html).not.toContain('Context Rail');
  });

  it('opens the project code workspace from legacy project and code-map targets', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />);

    expect(html).toContain('workspace-view-project-code');
    expect(html).toContain('当前项目状态');
    expect(html).toContain('扫描项目');
    expect(html).toContain('打开图谱');
    expect(html).toContain('查看变更');
    expect(html).toContain('更多项目操作');
    expect(html).not.toContain('归档项目为空');
    expect(html).not.toContain('探索工作区');
    expect(html).not.toContain('审查工作区');
  });

  it('keeps the conversation page focused on the session list and native thread canvas without an environment card', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" />);

    expect(html).toContain('workspace-view-project-sessions');
    expect(html).toContain('session-codex-parity-v1');
    expect(html).toContain('当前对话');
    expect(html).toContain('session-list-pane');
    expect(html).not.toContain('环境信息');
    expect(html).not.toContain('AI CLI 未配置');
    expect(html).not.toContain('Telegram 未启用');
    expect(html).not.toContain('运行环境');
    expect(html).not.toContain('上下文');
    expect(html).not.toContain('代码变更');
    expect(html).not.toContain('Runtime Adapters');
    expect(html).not.toContain('Runtime 终端日志');
    expect(html).not.toContain('任务模板</');
    expect(html).not.toContain('归档任务为空');
  });

  it('routes task integration labels through the task workspace copy instead of hard-coding AI CLI and Telegram', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('aiCliLabel');
    expect(source).toContain('telegramLabel');
    expect(source).not.toContain("label: 'AI CLI',");
    expect(source).not.toContain("label: 'Telegram',");
    expect(source).not.toContain('<strong>AI CLI</strong>');
    expect(source).not.toContain('<strong>Telegram</strong>');
  });

  it('renders project tasks as a task management workbench instead of reusing the conversation chat shell', () => {
    const taskHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);
    const sessionHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(taskHtml).toContain('workspace-view-project-tasks');
    expect(taskHtml).toContain('task-management-detail-pane');
    expect(taskHtml).toContain('task-management-codex-layout task-table-only-layout task-table-layout');
    expect(taskHtml).toContain('task-table-workbench');
    expect(taskHtml).toContain('task-table-header');
    expect(taskHtml).toContain('task-filter-workbench');
    expect(taskHtml).toContain('task-list-workbench');
    expect(taskHtml).toContain('task-management-navigation');
    expect(taskHtml).toContain('task-table-primary-toolbar');
    expect(taskHtml).toContain('task-table-view-toolbar');
    expect(taskHtml).toContain('task-table-context-meta');
    expect(taskHtml).not.toContain('task-detail-status-row');
    expect(taskHtml).not.toContain('zeus-object-toolbar');
    expect(taskHtml).not.toContain('task-filter-submit');
    expect(taskHtml).not.toContain('task-management-workbench');
    expect(taskHtml).not.toContain('task-table-inspector');
    expect(taskHtml).not.toContain('task-management-status-board');
    expect(taskHtml).not.toContain('task-management-command-dock');
    expect(taskHtml).not.toContain('task-list-pane');
    expect(taskHtml).not.toContain('workspace-list-pane conversation-list-pane');
    expect(taskHtml).not.toContain('conversation-thread-shell');
    expect(taskHtml).not.toContain('conversation-message-list');
    expect(sessionHtml).toContain('workspace-view-project-sessions');
    expect(sessionHtml).toContain('session-codex-parity-v1');
    expect(sessionHtml).toContain('session-list-pane');
    expect(sessionHtml).not.toContain('conversation-thread-shell');
    expect(sessionHtml).not.toContain('task-management-workbench');
    expect(source).toContain('workspace-list-pane session-list-pane');
    expect(source).not.toContain('workspace-view-projects');
    expect(source).not.toContain('workspace-view-conversations');
    expect(css).not.toMatch(/(^|[\s,{>])\.workspace-list-pane(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.workspace-view-projects(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.workspace-view-conversations(?![\w-])/);
    expect(css).toContain('.session-list-pane');
    expect(source).toContain('任务页首屏只保留任务表格');
    expect(source).toContain('点击任务行打开详情抽屉');
    expect(css).toContain('任务菜单独立任务管理布局最终覆盖');
    expect(css).toContain('任务页纯表格导航最终覆盖');
    expect(css).toContain('任务页纯表格首屏最终覆盖');
    expect(css).toContain('任务页去 HERO 化紧凑工具栏最终覆盖');
    expect(css).toContain('任务页表格不留半屏空白最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.workspace-view-project-tasks\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    // 任务/代码页不能先进入“左列表 + 右详情”的两列规则再靠后续 CSS 覆盖；会话页单独保留会话中栏。
    expect(css).not.toMatch(/\.macos-ai-app \.workspace-view-project-tasks,[^{}]*\.macos-ai-app \.workspace-view-project-code,[^{}]*\{[^}]*grid-template-columns:\s*minmax\(248px,\s*280px\) minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/@media \(max-width:\s*1180px\)\s*\{[\s\S]*:where\([^)]*\.workspace-view-project-tasks[^)]*\.workspace-view-project-code[^)]*\)\s*\{[^}]*grid-template-columns:\s*minmax\(220px,\s*280px\) minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.workspace-view-project-tasks > \.task-list-pane\s*\{/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-layout,[\s\S]*\.macos-ai-app \.task-table-only-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.task-table-inspector\s*\{[\s\S]*max-block-size:\s*min\(34vh,\s*360px\)/);
  });

  it('makes the project task list the task page protagonist instead of a capped navigation strip', () => {
    const snapshot = createSnapshot();
    snapshot.tasks = [
      { ...snapshot.tasks[0], title: 'Bug 分析当前项目结构', tags: ['backend'] },
      {
        ...snapshot.tasks[0],
        id: 'task_second',
        title: 'Bug 修复侧栏结构',
        description: '跟进任务列表键盘状态',
        tags: ['backend'],
      },
    ];
    const taskHtml = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="tasks" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(taskHtml).toContain('task-list-workbench task-list-protagonist');
    expect(taskHtml).toContain('class="task-list-workbench task-list-protagonist zeus-source-list" role="rowgroup" data-source-list-keyboard="vertical"');
    expect(taskHtml).not.toContain('task-list-row selected task-table-row');
    expect(taskHtml).toMatch(/class="task-list-row task-table-row" role="row" style="[^"]+" aria-selected="false" aria-label="打开任务详情：Bug 修复侧栏结构" tabindex="0" data-source-list-item="true" data-task-row-action="open-detail"/);
    expect(taskHtml).toMatch(
      /class="task-list-row task-table-row" role="row" style="[^"]+" aria-selected="false" aria-label="打开任务详情：Bug 分析当前项目结构" tabindex="-1" data-source-list-item="true" data-task-row-action="open-detail"/,
    );
    const navigationHtml = taskHtml.slice(taskHtml.indexOf('task-management-navigation'), taskHtml.indexOf('</section></section></section></section></section></main>'));
    expect(navigationHtml.indexOf('task-list-workbench task-list-protagonist')).toBeGreaterThanOrEqual(0);
    expect(navigationHtml.indexOf('task-table-toolbar')).toBeLessThan(navigationHtml.indexOf('task-list-workbench task-list-protagonist'));
    expect(navigationHtml.indexOf('task-filter-workbench')).toBeLessThan(navigationHtml.indexOf('task-list-workbench task-list-protagonist'));
    expect(navigationHtml.indexOf('task-table-header')).toBeGreaterThan(navigationHtml.indexOf('task-list-workbench task-list-protagonist'));
    expect(source).toContain('任务列表是任务页布局主角');
    expect(css).toContain('任务页纯表格首屏最终覆盖');
    expect(css).toContain('任务页表格不留半屏空白最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-workbench\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-workbench > \.task-list-workbench\.task-list-protagonist\s*\{[\s\S]*inline-size:\s*100%/);
    expect(css).not.toContain('筛选和归档退为右侧辅助区');
    expect(css).not.toMatch(/\.macos-ai-app \.task-management-navigation > \.task-list-workbench\.task-list-protagonist\s*\{[\s\S]*grid-column:\s*1/);
    expect(css).not.toMatch(/\.macos-ai-app \.task-management-navigation > \.task-filter-workbench\s*\{[\s\S]*grid-column:\s*2/);
    expect(css).not.toMatch(/\.macos-ai-app \.task-management-navigation:has\(\.task-list-empty\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(320px,\s*420px\) minmax\(0,\s*720px\)/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.macos-ai-app \.workspace-view-project-tasks\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('opens the task page as a table-only list with every detail surface collapsed out of the first view', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('task-management-codex-layout task-table-only-layout');
    expect(html).toContain('task-table-workbench');
    expect(html).toContain('task-table-header');
    expect(html).toContain('task-list-workbench task-list-protagonist zeus-source-list');
    expect(html).not.toContain('task-table-inspector');
    expect(html).not.toContain('task-management-main-flow');
    expect(html).not.toContain('task-request-section');
    expect(html).not.toContain('task-event-stream');
    expect(source).toContain('任务页首屏只保留任务表格');
    expect(css).toContain('任务页纯表格首屏最终覆盖');
    const taskOnlyRule = css.slice(css.indexOf('.macos-ai-app .task-table-layout,'), css.indexOf('.macos-ai-app .task-table-workbench'));
    expect(taskOnlyRule).toContain('grid-template-rows: minmax(0, 1fr);');
    expect(taskOnlyRule).not.toContain('grid-template-rows: minmax(0, 1fr) auto;');
  });

  it('does not reserve a split-detail parking lot when the task table is empty', () => {
    const snapshot = createSnapshot();
    snapshot.tasks = [];
    const html = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="tasks" />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('task-list-workbench task-list-protagonist zeus-source-list task-list-empty');
    expect(html).toContain('task-list-empty-row');
    expect(html).toContain('task-table-workbench');
    expect(css).toContain('任务页表格不留半屏空白最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-workbench:has\(\.task-list-empty\)\s*\{[\s\S]*min-block-size:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-workbench:has\(\.task-list-empty\) > \.task-list-workbench\.task-list-protagonist\.task-list-empty\s*\{[\s\S]*block-size:\s*auto/);
    expect(css).not.toMatch(/\.macos-ai-app \.task-management-navigation:has\(\.task-list-empty\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(320px,\s*420px\) minmax\(0,\s*720px\)/);
    expect(html).not.toContain('task-table-inspector');
  });

  it('redesigns the task workspace around a polished table-first task list instead of a side detail split', () => {
    const snapshot = createSnapshot();
    snapshot.tasks = [
      { ...snapshot.tasks[0], title: 'Bug 分析当前项目结构', tags: ['backend', 'bug'] },
      {
        ...snapshot.tasks[0],
        id: 'task_second',
        title: '重构任务表格布局',
        description: '让任务列表成为主舞台',
        status: 'running',
        tags: ['ui', 'table'],
      },
    ];
    const html = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="tasks" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('task-management-codex-layout task-table-only-layout task-table-layout');
    expect(html).toContain('task-table-workbench');
    expect(html).toContain('role="grid"');
    expect(html).toContain('task-table-toolbar');
    expect(html).toContain('task-table-header');
    expect(html).not.toContain('task-list-row selected task-table-row');
    expect(html).toMatch(/class="task-list-row task-table-row" role="row" style="[^"]+" aria-selected="false" aria-label="打开任务详情：Bug 分析当前项目结构" tabindex="0"/);
    expect(html).toContain('task-table-cell task-table-code-cell');
    expect(html).toContain('task-table-cell task-table-title-cell task-list-copy task-table-intent-cell');
    expect(html).toContain('task-table-cell task-table-status-cell task-list-meta task-table-nextAction-cell');
    expect(html).toContain('task-table-cell task-table-runtime-cell task-table-aiExecution-cell');
    expect(html).toContain('task-table-cell task-table-source-cell');
    expect(html).not.toContain('task-table-inspector');
    expect(source).toContain('任务页首屏只保留任务表格');
    expect(css).toContain('任务页纯表格首屏最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-layout,[\s\S]*\.macos-ai-app \.task-table-only-layout\s*\{[\s\S]*grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-workbench\s*\{[\s\S]*overflow:\s*hidden/);
    expect(html).toMatch(/style="--task-table-grid-template:minmax\(32px, 32px\) minmax\(88px, 0\.42fr\) minmax\(168px, 1\.1fr\)[^"]*grid-template-columns:var\(--task-table-grid-template\);min-width:min\(100%, 880px\)"/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-header,[\s\S]*\.macos-ai-app \.task-table-row\s*\{[\s\S]*display:\s*grid/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-row\s*\{[\s\S]*transition:[\s\S]*box-shadow 160ms var\(--zeus-motion-ease-out\)/);
    expect(css).not.toContain('transform: translateY(-1px);');
    expect(css).not.toMatch(/\.macos-ai-app \.task-table-layout\s*\{[^}]*grid-template-columns:\s*minmax\(420px,\s*0\.58fr\) minmax\(360px,\s*0\.42fr\)/);
  });

  it('keeps task bulk actions selection-scoped and removes the old row button table structure', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).not.toContain('task-table-bulk-action-bar');
    expect(taskSource).not.toContain('<button\n                  key={task.id}');
    expect(taskSource).toContain('onToggleTaskSelection');
    expect(css).toContain('任务表格选择列与轨道对齐最终覆盖');
    expect(css).toContain('任务批量操作栏最终覆盖');
  });

  it('normalizes task request and event content into flat flow rows instead of summary panels', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).not.toContain('task-management-main-flow');
    expect(html).not.toContain('task-request-section');
    expect(html).not.toContain('task-event-stream');
    expect(source).toContain('任务页首屏只保留任务表格');
    expect(css).toContain('任务页纯表格首屏最终覆盖');
    expect(source).not.toContain('task-management-summary-panel');
    expect(source).not.toContain('task-management-event-panel');
    expect(css).not.toContain('task-management-summary-panel');
    expect(css).not.toContain('task-management-event-panel');
    expect(css).not.toMatch(/\.macos-ai-app \.task-request-section,[\s\S]*\.macos-ai-app \.task-event-stream\s*\{/);
    expect(css).not.toMatch(/\.macos-ai-app \.task-event-row\s*\{/);
  });

  it('uses a table-first task management stage instead of a side detail split', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('task-management-codex-layout task-table-only-layout task-table-layout');
    expect(source).toContain('任务页首屏只保留任务表格');
    expect(css).toContain('任务页纯表格首屏最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-layout,[\s\S]*\.macos-ai-app \.task-table-only-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-layout,[\s\S]*\.macos-ai-app \.task-table-only-layout\s*\{[\s\S]*grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.task-table-workbench\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
    expect(html).not.toContain('task-table-inspector');
    expect(css).not.toMatch(/\.macos-ai-app \.task-table-layout\s*\{[^}]*grid-template-columns:\s*minmax\(420px,\s*0\.58fr\) minmax\(360px,\s*0\.42fr\)/);
  });

  it('keeps the project code graph in a scrollable stage with an independent inspector instead of compressing the canvas', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={createGraphView()} />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('project-code-map-stage');
    expect(html).toContain('code-map-inspector-pane');
    expect(css).toContain('代码图谱可滚动主舞台最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-code-map-stage \.code-map-primary-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(720px,\s*1fr\) minmax\(320px,\s*360px\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-map-stage \.code-map-stage-surface\s*\{[\s\S]*overflow:\s*auto[\s\S]*overscroll-behavior:\s*contain/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-map-stage \.graph-canvas-svg\s*\{[\s\S]*inline-size:\s*max\(1180px,\s*100%\)[\s\S]*block-size:\s*max\(620px,\s*70vh\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-map-stage \.code-map-inspector-pane\s*\{[\s\S]*max-block-size:\s*calc\(100vh - 220px\)[\s\S]*overflow:\s*auto/);
  });

  it('renders the code workspace as a single repository workbench without an inner project list sidebar', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('workspace-view-project-code');
    expect(html).toContain('project-repository-workbench');
    expect(html).not.toContain('project-list-pane');
    expect(html).not.toContain('project-source-list');
    expect(css).toContain('任务代码单工作区布局最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.workspace-view-project-code\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.workspace-view-project-code > \.project-list-pane\s*\{/);
    expect(css).toMatch(/\.macos-ai-app \.workspace-view-project-sessions\s*\{[^}]*grid-template-columns:\s*minmax\(236px,\s*280px\) minmax\(0,\s*1fr\)/);
  });

  it('renders the loaded project code map as the code page protagonist instead of hiding it in a drawer', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot({ nodeCount: 1, edgeCount: 1, viewCount: 1 })} initialMainNavTarget="code-map" initialGraphView={createGraphView()} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const codePrimaryStart = html.indexOf('project-code-primary');
    const codeMapStart = html.indexOf('code-map-workbench');
    const drawerStart = html.indexOf('workspace-drawer-portal-root');

    expect(html).toContain('workspace-view-project-code');
    expect(html).toContain('project-code-map-stage');
    expect(html).toContain('code-map-workbench');
    expect(html).toContain('code-map-primary-grid');
    expect(html).toContain('code-map-stage-surface');
    expect(codePrimaryStart).toBeGreaterThanOrEqual(0);
    expect(codeMapStart).toBeGreaterThan(codePrimaryStart);
    expect(drawerStart === -1 || codeMapStart < drawerStart).toBe(true);
    expect(html).not.toContain('workspace-drawer project-drawer');
    expect(source).toContain('代码逻辑图是代码页主角');
    expect(css).toContain('代码页图谱主舞台最终覆盖');
  });

  it('does not attach an old unscoped startup graph to a different selected project', () => {
    const staleGlobalGraph: GraphViewSnapshot = {
      ...createGraphView(),
      title: '系统架构图',
    };
    const snapshot = createSnapshot();
    snapshot.projects = [
      {
        id: 'project_tc_core',
        name: 'tc-app-core',
        localPath: '/Users/david/cckg/tcapp/Back-End/tc-app-core',
        scanStatus: 'completed',
      },
    ];

    const html = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="code-map" initialGraphView={staleGlobalGraph} initialGraphProjectId="project_tc_core" />);

    expect(html).toContain('tc-app-core');
    expect(html).toContain('等待真实扫描');
    expect(html).not.toContain('code-map-workbench');
    expect(html).not.toContain('系统架构图</h3>');
  });

  it('keeps project scan actions recoverable when the selected project has a stale persisted scanning status', () => {
    const scanningSnapshot = createSnapshot({ nodeCount: 0, edgeCount: 0, viewCount: 0 });
    scanningSnapshot.projects = scanningSnapshot.projects.map((project) => ({
      ...project,
      scanStatus: 'scanning',
    }));

    const html = renderToStaticMarkup(<App snapshot={scanningSnapshot} initialMainNavTarget="code-map" onScanProjectGraph={async () => scanningSnapshot} onLoadProjectGraphView={async () => createGraphView()} />);

    expect(html).not.toContain('aria-busy="true"');
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>\s*扫描项目\s*<\/button>/);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>\s*打开图谱\s*<\/button>/);
  });

  it('removes ZeusObjectToolbar from code workspaces while keeping it for project settings context', () => {
    const taskHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);
    const codeHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />);
    const settingsHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" initialProjectConfig={createProjectConfig()} />);
    const sessionHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const html of [settingsHtml]) {
      expect(html).toContain('zeus-object-toolbar');
      expect(html).toContain('zeus-object-toolbar-avatar');
      expect(html).toContain('zeus-object-toolbar-copy');
      expect(html).toContain('zeus-object-toolbar-status');
    }

    expect(settingsHtml).toContain('project-repository-status-row zeus-object-toolbar');
    expect(settingsHtml).toContain('project-repository-workbench project-settings-workbench');
    expect(codeHtml).toContain('project-repository-workbench project-code-workbench');
    expect(codeHtml).not.toContain('project-repository-status-row zeus-object-toolbar');
    expect(codeHtml).not.toContain('zeus-object-toolbar');
    expect(taskHtml).not.toContain('integration-state-row task-detail-status-row zeus-object-toolbar');
    expect(taskHtml).not.toContain('zeus-object-toolbar');
    expect(taskHtml).toContain('task-table-workbench');
    expect(taskHtml).toContain('task-table-primary-toolbar');
    expect(taskHtml).toContain('task-table-view-toolbar');
    expect(sessionHtml).not.toContain('integration-state-row task-detail-status-row zeus-object-toolbar');
    expect(sessionHtml).not.toContain('zeus-object-toolbar-copy"><strong>外部集成状态');
    expect(source).not.toContain("integrationAria: '外部集成状态'");
    expect(source).not.toContain("integrationAria: 'External integrations'");
    expect(taskHtml).not.toContain('task-management-workbench');
    expect(taskHtml).not.toContain('workspace-list-pane conversation-list-pane');
    expect(codeHtml).toContain('workspace-view-project-code');
    expect(codeHtml).not.toContain('project-source-list');
    expect(sessionHtml).toContain('session-codex-parity-v1');
    expect(sessionHtml).toContain('session-list-pane');
    expect(sessionHtml).not.toContain('conversation-thread-shell');
    expect(sessionHtml).not.toContain('conversation-environment-panel');

    expect(css).toContain('ZeusObjectToolbar 组件壳层最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.zeus-object-toolbar\s*\{[\s\S]*background:\s*var\(--zeus-toolbar-bg\)/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-object-toolbar\s*\{[\s\S]*border-block-end:\s*1px solid var\(--zeus-toolbar-line\)/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-object-toolbar-copy\s*\{[\s\S]*min-inline-size:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-object-toolbar-status\s*\{[\s\S]*justify-self:\s*end/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-workbench\s*\{[\s\S]*grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-code-workbench\s*\{[\s\S]*gap:\s*0/);
    expect(css).not.toContain('object-toolbar-card');
  });

  it('keeps the project settings object status as quiet metadata instead of a project state pill', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" initialProjectConfig={createProjectConfig()} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const marker = '代码对象栏状态低噪音最终覆盖';
    const start = css.indexOf(marker);

    expect(html).toContain('project-state-meta zeus-object-toolbar-status');
    expect(html).not.toContain('project-state-pill zeus-object-toolbar-status');
    expect(source).toContain('project-state-meta zeus-object-toolbar-status');
    expect(source).not.toContain('project-state-pill zeus-object-toolbar-status');
    expect(start).toBeGreaterThanOrEqual(0);

    const finalCss = css.slice(start);
    const metaBlock = finalCss.match(/\.macos-ai-app \.project-state-meta\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(metaBlock).toContain('background: transparent');
    expect(metaBlock).toContain('border: 0');
    expect(metaBlock).toContain('border-radius: 0');
    expect(metaBlock).toContain('padding: 0');
    expect(metaBlock).not.toContain('999px');
    expect(metaBlock).not.toContain('--zeus-status-pill-bg');
  });

  it('keeps new chat and session shortcuts from creating official tasks', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('onCreateTask={openTaskCreateModal}');
    expect(source).toContain('submitTaskCreateModal');
    expect(source).toContain('createProjectTaskFromDraft');
    expect(source).not.toContain('onCreateTask={createTaskFromTaskToolbar}');
    expect(source).toContain('onCreateConversation={prepareNewConversationDraft}');
    expect(source).toContain('prepareNativeConversationForTask(taskId);');
    expect(source).not.toContain('async function createDefaultTask');
    expect(source).not.toContain('async function createTaskFromTaskToolbar');
    expect(source).not.toContain('onCreateConversation={createDefaultTask}');
    expect(source).not.toContain('onClick={createDefaultTask}');
    expect(source).toContain('setTaskDetail(undefined)');
    expect(source).toContain('client.startProjectConversation(acceptedProjectId, request)');
    expect(source).toContain('activeProjectIdRef.current !== projectId');
    expect(source).toContain("key={`new-conversation-${nativeSessionOwner?.kind ?? 'none'}-");
    const projectStart = source.slice(source.indexOf('async function startProjectConversation'), source.indexOf('const prepareNewConversationDraft'));
    expect(projectStart).not.toContain('createProjectTaskFromDraft');
    expect(projectStart).not.toContain('client.startNativeConversation');
    const nativeTaskSelection = source.slice(source.indexOf('const nativeSessionTaskRecord'), source.indexOf('const nativeSessionTask:'));
    expect(nativeTaskSelection).not.toContain('currentProjectTasks[0]');
  });

  it('leaves the accepted start form immediately and treats history refresh as best effort', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const workspaceSource = readFileSync(new URL('../src/renderer/session/SessionWorkspace.tsx', import.meta.url), 'utf8');
    const start = source.slice(source.indexOf('async function startNativeConversation'), source.indexOf('const prepareNewConversationDraft'));
    const durableHelper = workspaceSource.slice(workspaceSource.indexOf('export async function startNativeConversationWithDurableAcceptance'), workspaceSource.indexOf('function isRecord'));
    expect(durableHelper.indexOf('clearAccepted(options.input, request, acceptance)')).toBeLessThan(durableHelper.indexOf('await options.onAccepted(choice)'));
    expect(durableHelper.indexOf('await options.onAccepted(choice)')).toBeLessThan(durableHelper.indexOf('await options.refresh(options.input.task.id)'));
    expect(start.indexOf('setSelectedNativeConversationId(choice.id)')).toBeLessThan(start.indexOf('refresh: refreshNativeConversationChoices'));
    expect(start).toContain("recordLocalError('native-conversation-choice-refresh', refreshError)");
  });

  it('keeps a durable accepted conversation selected across stale and out-of-order choice loads', () => {
    const coordinator = createNativeConversationChoiceLoadCoordinator();
    const staleSnapshot = {
      taskId: 'task_real',
      projectId: 'project_real',
      hasHistory: false,
      requiresChoice: false,
      choices: [],
      items: [],
    };
    const accepted = {
      id: 'accepted-conversation',
      projectId: 'project_real',
      taskId: 'task_real',
      title: 'Accepted conversation',
      summary: null,
      status: 'active',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerThreadId: 'thread-accepted',
      providerModel: 'gpt-5.4',
      providerState: 'ready',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      archived: false,
      resumable: true,
      readOnly: false,
    };

    const oldGlobalLoad = coordinator.begin('task_real');
    coordinator.preserveAccepted(accepted);
    const postAcceptanceLoad = coordinator.begin('task_real');

    expect(coordinator.commit('task_real', oldGlobalLoad, staleSnapshot)).toBeNull();
    expect(coordinator.commit('task_real', postAcceptanceLoad, staleSnapshot)?.choices).toEqual([accepted]);
  });

  it('keeps a taskless durable acceptance across stale and out-of-order project choice loads', () => {
    const coordinator = createNativeProjectConversationChoiceLoadCoordinator();
    const accepted: NativeConversationChoice = {
      id: 'project-accepted-conversation',
      projectId: 'project_real',
      taskId: null,
      title: 'Project conversation',
      summary: 'Project scoped',
      status: 'active',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerThreadId: 'thread-project',
      providerModel: 'gpt-5.4',
      providerState: 'ready',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      archived: false,
      resumable: true,
      readOnly: false,
    };
    const oldLoad = coordinator.begin('project_real');
    coordinator.preserveAccepted(accepted);
    const currentLoad = coordinator.begin('project_real');
    const staleSnapshot = { projectId: 'project_real', choices: [], items: [] };

    expect(coordinator.commit('project_real', oldLoad, staleSnapshot)).toBeNull();
    expect(coordinator.commit('project_real', currentLoad, staleSnapshot)?.choices).toEqual([accepted]);
    expect(coordinator.commit('another-project', currentLoad, staleSnapshot)).toBeNull();
  });

  it('keeps choice knowledge fail-closed per task when a parallel task load fails', () => {
    const taskOneLoading = beginNativeConversationChoiceTaskLoad(undefined);
    const taskTwoLoading = beginNativeConversationChoiceTaskLoad(undefined);
    const taskOneReady = completeNativeConversationChoiceTaskLoad(taskOneLoading);
    const taskTwoFailed = failNativeConversationChoiceTaskLoad(taskTwoLoading, 'Task two choices are unavailable.');

    expect(taskOneReady).toEqual({ status: 'ready', choicesKnown: true, error: null });
    expect(taskTwoFailed).toEqual({ status: 'error', choicesKnown: false, error: 'Task two choices are unavailable.' });
  });

  it('routes the task page new task action through a native modal draft instead of direct default creation', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const mainSource = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');

    expect(source).toContain('type TaskCreateAttachment = TaskAttachmentView;');
    expect(source).toContain("from './task/taskAttachments.js';");
    expect(source).toContain('onChooseTaskAttachments?: () => Promise<TaskCreateAttachment[]>;');
    expect(source).toContain('onCreateTaskDraft?: (projectId: string, draft: TaskCreateDraft) => Promise<DashboardSnapshot>;');
    expect(source).toContain('onCreateTaskDraft(activeProjectId, draft)');
    expect(source).toContain('buildTaskCreateInitialForm');
    expect(source).toContain('normalizeTaskCreateDraft');
    expect(source).toContain('taskCreateReturnFocusRef');
    expect(source).toContain('chooseTaskCreateAttachments');
    expect(mainSource).toContain('onCreateTaskDraft={async (projectId, draft) => {');
    expect(mainSource).toContain('onChooseTaskAttachments={() => window.zeus?.chooseTaskAttachments?.() ?? Promise.resolve([])}');
    expect(mainSource).toContain('await client.createTask({');
    expect(mainSource).toContain('tags: draft.tags');
    expect(mainSource).toContain('attachments: draft.attachments');
    expect(mainSource).toContain('sourceContext: {');
  });

  it('renders one scoped native session canvas with a dedicated session list beside it', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" />);

    expect(html.match(/session-codex-parity-v1/g)).toHaveLength(1);
    expect(html.match(/<aside class="zeus-sidebar/g)).toHaveLength(1);
    expect(html).toContain('workspace-view-project-sessions');
    expect(html).toContain('session-list-pane');
    expect(html).not.toMatch(/conversation-list-pane|conversation-environment-panel|conversation-thread-shell/);
    expect(html).not.toMatch(/AI CLI 未配置|Telegram 未启用|voice|microphone/i);
    expect(html).toContain('session-mobile-source-trigger');
    expect(html).toContain('aria-controls="session-project-conversation-list"');
  });

  it('keeps project navigation separate from the session list and restores the session list beside the current conversation', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" />);
    const sidebarStart = html.indexOf('<aside class="zeus-sidebar');
    const workspaceStart = html.indexOf('<section class="workspace ai-workspace"');
    const sessionViewStart = html.indexOf('workspace-view-project-sessions');
    const sidebarHtml = html.slice(sidebarStart, workspaceStart);
    const sessionViewHtml = html.slice(sessionViewStart);

    expect(sidebarStart).toBeGreaterThanOrEqual(0);
    expect(workspaceStart).toBeGreaterThan(sidebarStart);
    expect(sessionViewStart).toBeGreaterThan(workspaceStart);
    expect(sidebarHtml).not.toContain('session-project-conversation-tree');
    expect(sessionViewHtml).toContain('session-list-pane');
    expect(sessionViewHtml).toContain('id="session-project-conversation-list"');
    expect(sessionViewHtml).toContain('session-project-conversation-tree');
    expect(sessionViewHtml.indexOf('session-list-pane')).toBeLessThan(sessionViewHtml.indexOf('conversation-detail-pane'));
  });

  it('lays out the session list as a desktop middle column and only turns that column into the compact drawer', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.macos-ai-app \.workspace-view-project-sessions\s*\{[^}]*grid-template-columns:\s*minmax\(236px,\s*280px\) minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.session-list-pane\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/session-codex-parity-v1\[data-session-source-rail=['"]open['"]\] \.session-list-pane\s*\{[^}]*transform:\s*translateX\(0\)/);
    expect(css).not.toContain("[data-session-source-rail='open'] .project-first-sidebar");
  });

  it('turns the session source rail into a focus-managed mobile drawer instead of a 42vh top list', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(source).toContain("if (event.key === 'Escape')");
    expect(source).toContain("if (event.key !== 'Tab') return");
    expect(source).toContain('aria-hidden={compactSessionViewport && !sessionSourceRailOpen ? true : undefined}');
    expect(source).toContain('inert={compactSessionViewport && !sessionSourceRailOpen ? true : undefined}');
    expect(source).toContain("role={compactSessionViewport && sessionSourceRailOpen ? 'dialog' : undefined}");
    expect(source).toContain('aria-hidden={sessionSourceRailOpen ? undefined : true}');
    expect(source).toContain('tabIndex={sessionSourceRailOpen ? 0 : -1}');
    expect(css).toMatch(/session-codex-parity-v1[\s\S]*session-list-pane[\s\S]*position:\s*fixed[\s\S]*transform:\s*translateX\(-105%\)/);
    expect(css).toContain("[data-session-source-rail='open'] .session-list-pane");
    expect(css).not.toContain("[data-session-source-rail='open'] .project-first-sidebar");
  });

  it('executes the real mobile source trigger click and keeps it above the window drag hit layer', () => {
    let open = false;
    const closedTrigger = SessionMobileSourceTrigger({
      language: 'zh-CN',
      open,
      onOpen: () => {
        open = true;
      },
    });

    expect(closedTrigger.props['aria-expanded']).toBe(false);
    closedTrigger.props.onClick();
    expect(open).toBe(true);
    expect(SessionMobileSourceTrigger({ language: 'zh-CN', open, onOpen: () => undefined }).props['aria-expanded']).toBe(true);

    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const triggerRule = css.match(/\.session-mobile-source-trigger\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
    expect(triggerRule).toMatch(/z-index:\s*(?:3[1-9]|[4-9]\d|\d{3,})/);
  });

  it('keeps the narrow session header clear of the persistent mobile drawer trigger', () => {
    const css = readFileSync(new URL('../src/renderer/session/session.css', import.meta.url), 'utf8');
    const narrowRule = css.match(/@media \(max-width:\s*559px\)\s*\{([\s\S]*?)(?=\n\})/)?.[1] ?? '';
    const headerRule = narrowRule.match(/\.session-codex-parity-v1 \.session-thread-header\s*\{([\s\S]*?)\}/)?.[1] ?? '';

    expect(headerRule).toMatch(/padding-inline:\s*126px\s+16px/);
    expect(headerRule).not.toMatch(/padding-inline:\s*16px\s*;/);
  });

  it('wraps approval decisions instead of overflowing the narrow mobile session canvas', () => {
    const css = readFileSync(new URL('../src/renderer/session/session.css', import.meta.url), 'utf8');
    const actionRule = css.match(/\.session-codex-parity-v1 \.session-request-actions\s*\{([\s\S]*?)\}/)?.[1] ?? '';

    expect(actionRule).toMatch(/flex-wrap:\s*wrap/);
  });

  it('defers drawer autofocus until after the trigger click default focus has settled', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('const SESSION_DRAWER_FOCUS_DELAY_MS = 40;');
    expect(source).toContain('window.setTimeout(() => callback(Date.now()), SESSION_DRAWER_FOCUS_DELAY_MS)');
    expect(source).toContain('window.clearTimeout(frameId)');

    let scheduled: FrameRequestCallback | null = null;
    let focused = false;
    const cancelled: number[] = [];
    const cancel = scheduleSessionDrawerInitialFocus(
      { focus: () => (focused = true) },
      (callback) => {
        scheduled = callback;
        return 17;
      },
      (frameId) => cancelled.push(frameId),
    );

    expect(focused).toBe(false);
    scheduled?.(0);
    expect(focused).toBe(true);
    cancel();
    expect(cancelled).toEqual([17]);
  });

  it('falls back to the empty mobile session drawer as the initial focus target', () => {
    const emptyDrawer = {
      focus: () => undefined,
      querySelector: () => null,
    } as unknown as HTMLElement;
    const firstConversation = { focus: () => undefined } as unknown as HTMLElement;
    const populatedDrawer = {
      focus: () => undefined,
      querySelector: () => firstConversation,
    } as unknown as HTMLElement;

    expect(resolveSessionDrawerInitialFocusTarget(emptyDrawer)).toBe(emptyDrawer);
    expect(resolveSessionDrawerInitialFocusTarget(populatedDrawer)).toBe(firstConversation);

    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" />);
    expect(html).toMatch(/id="session-project-conversation-list"[^>]*tabindex="-1"/);
  });

  it('fails closed when the selected conversation belongs to another project', () => {
    const selectedConversation: NativeConversationChoice = {
      id: 'conversation-project-a',
      projectId: 'project-a',
      taskId: 'task-a',
      title: 'Project A conversation',
      summary: null,
      status: 'active',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerThreadId: 'thread-a',
      providerModel: 'gpt-5.4',
      providerState: 'ready',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      archived: false,
      resumable: true,
      readOnly: false,
    };

    expect(resolveSelectedNativeConversationForProject([selectedConversation], selectedConversation.id, 'project-a')).toBe(selectedConversation);
    expect(resolveSelectedNativeConversationForProject([selectedConversation], selectedConversation.id, 'project-b')).toBeNull();
    expect(resolveSelectedNativeConversationForProject([selectedConversation], null, 'project-a')).toBeNull();
  });

  it('keeps the native session canvas inside the selected dark shell theme', () => {
    const settings = { ...createAppShellSettings('en-US'), appearance: 'dark' as const };
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" initialAppShellSettings={settings} />);
    const css = readFileSync(new URL('../src/renderer/session/session.css', import.meta.url), 'utf8');
    const sessionRootRule = css.match(/^\.session-codex-parity-v1\s*\{([\s\S]*?)\n\}/m)?.[1] ?? '';

    expect(html).toContain('theme-dark');
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('session-codex-parity-v1');
    expect(sessionRootRule).toContain('--zeus-product-text: var(--session-text)');
    expect(sessionRootRule).toContain('--zeus-product-muted: var(--session-text-muted)');
    expect(sessionRootRule).toContain('--zeus-project-menu-selected-bg: var(--session-selected)');
    expect(sessionRootRule).toContain('--zeus-product-line: var(--session-line)');
  });

  it('keeps the session source rail vertically scrollable without a horizontal scrollbar', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const sidebarListRule = css.match(/\.macos-ai-app \.session-list-pane\s*\{([\s\S]*?)\}/)?.[1] ?? '';

    expect(sidebarListRule).toMatch(/overflow-x:\s*hidden/);
    expect(sidebarListRule).toMatch(/overflow-y:\s*auto/);
  });

  it('renders multiple real conversations for one task inside the session middle column', () => {
    const snapshot = createSnapshot();
    const projectId = snapshot.projects[0]!.id;
    const taskId = snapshot.tasks[0]!.id;
    const base = {
      projectId,
      taskId,
      summary: null,
      status: 'active',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerModel: 'gpt-5.4',
      providerState: 'ready',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      archived: false,
      resumable: true,
      readOnly: false,
    } as const;
    const choices = [
      { ...base, id: 'native-1', title: 'First native thread', providerThreadId: 'thread-1' },
      { ...base, id: 'native-2', title: 'Second native thread', providerThreadId: 'thread-2' },
    ];
    const html = renderToStaticMarkup(
      <App
        snapshot={snapshot}
        initialMainNavTarget="conversations"
        initialNativeConversationChoices={[{ taskId, projectId, hasHistory: true, requiresChoice: true, choices, items: choices }]}
        initialSelectedNativeConversationId="native-2"
      />,
    );

    expect(html.match(/data-conversation-tree-item="true"/g)).toHaveLength(2);
    expect(html).toContain('First native thread');
    expect(html).toContain('Second native thread');
    expect(html).toMatch(/session-conversation-tree-row is-current[^>]*aria-current="page"/);
  });

  it('opens global new chat as a project conversation composer and fails closed for orphan legacy choices', () => {
    const snapshot = createSnapshot();
    const projectId = snapshot.projects[0]!.id;
    const firstTask = snapshot.tasks[0]!;
    snapshot.tasks.push({ ...firstTask, id: 'task-second', title: 'Second explicit task' });
    const newChatHtml = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="conversations" initialAppShellSettings={createAppShellSettings('en-US')} />);
    expect(newChatHtml).toContain('aria-label="Conversation workspace"');
    expect(newChatHtml).toContain('session-new-conversation-composer');
    expect(newChatHtml).not.toContain('Select a real task first');
    expect(newChatHtml).not.toContain('Select the task to bind');
    expect(newChatHtml).not.toContain('native app-server');
    expect(newChatHtml).not.toContain('name="session-start-mode" checked=""');

    const orphan = {
      id: 'legacy-orphan',
      projectId,
      taskId: null,
      title: 'Orphan legacy transcript',
      summary: null,
      status: 'closed',
      transportKind: 'legacy_cli',
      providerId: 'codex',
      providerThreadId: null,
      providerModel: null,
      providerState: 'closed',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      archived: false,
      resumable: false,
      readOnly: true,
    } as const;
    const orphanHtml = renderToStaticMarkup(
      <App
        snapshot={snapshot}
        initialMainNavTarget="conversations"
        initialNativeConversationChoices={[{ taskId: firstTask.id, projectId, hasHistory: true, requiresChoice: true, choices: [orphan], items: [orphan] }]}
        initialSelectedNativeConversationId={orphan.id}
        initialAppShellSettings={createAppShellSettings('en-US')}
      />,
    );
    expect(orphanHtml).toContain('Orphan legacy transcript');
    expect(orphanHtml).not.toContain('Reference in a new native thread');
  });

  it('keeps the bottom project composer available when the project has no official tasks', () => {
    const snapshot = createSnapshot();
    snapshot.tasks = [];
    const html = renderToStaticMarkup(<App snapshot={snapshot} initialMainNavTarget="conversations" initialAppShellSettings={createAppShellSettings('en-US')} />);

    expect(html).toContain('session-new-conversation-composer');
    expect(html).toContain('Type a message. Enter to send, Shift+Enter for a newline.');
    expect(html).not.toContain('Select a real task first');
    expect(html).not.toContain('Select the task to bind');
  });

  it('renders taskless project conversations directly in the project session tree', () => {
    const snapshot = createSnapshot();
    const projectId = snapshot.projects[0]!.id;
    const projectConversation: NativeConversationChoice = {
      id: 'project-conversation-real',
      projectId,
      taskId: null,
      title: '自由输入的项目对话',
      summary: '没有伪造任务分组',
      status: 'active',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerThreadId: 'thread-project-real',
      providerModel: 'gpt-5.4',
      providerState: 'ready',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      archived: false,
      resumable: true,
      readOnly: false,
    };
    const html = renderToStaticMarkup(
      <App
        snapshot={snapshot}
        initialMainNavTarget="conversations"
        initialNativeProjectConversationChoices={[{ projectId, choices: [projectConversation], items: [projectConversation] }]}
        initialSelectedNativeConversationId={projectConversation.id}
      />,
    );

    expect(html).toContain('自由输入的项目对话');
    expect(html).toContain('session-conversation-project-items');
    expect(html).not.toMatch(/session-conversation-task-group[^>]*aria-label="自由输入的项目对话"/);
  });

  it('keeps thread visuals scoped while the shell stylesheet owns the restored session-list layout', () => {
    const shellCss = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const sessionCss = readFileSync(new URL('../src/renderer/session/session.css', import.meta.url), 'utf8');

    expect(shellCss).toContain('.session-list-pane');
    expect(shellCss).not.toMatch(/conversation-codex-surface|conversation-thread-shell|conversation-session-field-row/);
    expect(shellCss).not.toContain('Codex 会话工作台最终覆盖');
    expect(shellCss).not.toContain('真实打包窗口会话布局返修');
    expect(shellCss).toMatch(/\.workspace-view-project-sessions\s*\{[^}]*grid-template-columns:\s*minmax\(236px,\s*280px\) minmax\(0,\s*1fr\)/);
    expect(sessionCss).toContain('.session-codex-parity-v1');
    expect(sessionCss).toContain('--session-thread-max: 48rem');
    expect(sessionCss).toContain('--session-markdown-max: 40rem');
    expect(sessionCss).toContain('--session-composer-max: 650px');
    expect(sessionCss).toContain('.theme-dark .session-codex-parity-v1');
    expect(shellCss).toContain('@media (min-width: 760px) and (max-width: 1023px)');
    expect(shellCss).toContain('grid-template-columns: clamp(236px, 28vw, 248px) minmax(0, 1fr)');
    expect(sessionCss).toContain('cubic-bezier(0.19, 1, 0.22, 1)');
    expect(sessionCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(sessionCss).not.toContain('transform: none !important');
    expect(sessionCss).not.toMatch(/margin:\s*-132px/);
  });

  it('refreshes the selected app-server conversation when Runtime output arrives after the send response', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const mainSource = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
    const selectedConversation = {
      id: 'conversation_task_real',
      projectId: 'project_real',
      taskId: 'task_real',
      sessionId: 'ai-session-real',
      title: '分析当前项目结构',
      summary: '真实任务',
      status: 'running',
      createdAt: '2026-07-09T09:00:00.000Z',
      updatedAt: '2026-07-09T09:00:00.000Z',
      archived: false,
      messages: [],
    };

    expect(
      shouldRefreshConversationForRuntimeEvent(
        {
          id: 'event-runtime-output',
          type: 'runtime.session.output',
          payload: { sessionId: 'ai-session-real', logId: 'log-1' },
          createdAt: '2026-07-09T09:00:01.000Z',
        },
        selectedConversation,
      ),
    ).toBe(true);
    expect(
      shouldRefreshConversationForRuntimeEvent(
        {
          id: 'event-other-output',
          type: 'runtime.session.output',
          payload: { sessionId: 'ai-session-other', logId: 'log-2' },
          createdAt: '2026-07-09T09:00:01.000Z',
        },
        selectedConversation,
      ),
    ).toBe(false);
    expect(appSource).toContain('props.onSubscribeRealtimeEvents');
    expect(appSource).toContain('shouldRefreshConversationForRuntimeEvent(event, selectedTaskConversationRef.current)');
    expect(appSource).toMatch(/loadGraphConversation\(projectId,\s*conversation\.id\)/);
    expect(mainSource).toContain('onSubscribeRealtimeEvents={(onEvent) => {');
    expect(mainSource).toContain('const socket = client.connectEvents(onEvent);');
  });

  it('removes browser textarea resize handles from all Zeus product inputs instead of leaving web form chrome', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('ZeusTextarea macOS 固定输入框最终覆盖');
    expect(css).not.toContain('resize: vertical');
    expect(css).toMatch(/\.macos-ai-app textarea\s*\{[\s\S]*resize:\s*none/);
    expect(css).not.toContain('.task-management-compose-field textarea');
    expect(css).toMatch(/> textarea\s*\{[\s\S]*resize:\s*none/);
  });

  it('flattens the ZeusModeRail into a Codex-style inline metadata row instead of pill chips', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Codex ModeRail 行内元信息最终覆盖');
    const flatModeRailBlock = css.slice(css.indexOf('Codex ModeRail 行内元信息最终覆盖'));
    expect(flatModeRailBlock).toContain('.macos-ai-app .zeus-mode-rail');
    expect(flatModeRailBlock).toContain('.macos-ai-app .zeus-mode-rail-item');
    expect(flatModeRailBlock).toMatch(/\.macos-ai-app \.zeus-mode-rail\s*\{[\s\S]*background:\s*transparent/);
    expect(flatModeRailBlock).toMatch(/\.macos-ai-app \.zeus-mode-rail\s*\{[\s\S]*border-block-start:\s*0/);
    expect(flatModeRailBlock).toMatch(/\.macos-ai-app \.zeus-mode-rail-item\s*\{[\s\S]*background:\s*transparent/);
    expect(flatModeRailBlock).toMatch(/\.macos-ai-app \.zeus-mode-rail-item\s*\{[\s\S]*border:\s*0/);
    expect(flatModeRailBlock).toMatch(/\.macos-ai-app \.zeus-mode-rail-item\s*\{[\s\S]*border-radius:\s*0/);
    expect(flatModeRailBlock).toMatch(/\.macos-ai-app \.zeus-mode-rail-item\s*\{[\s\S]*padding:\s*0/);
    expect(flatModeRailBlock).toMatch(/\.macos-ai-app \.zeus-mode-rail-item\.active strong\s*\{[\s\S]*color:\s*var\(--zeus-product-text\)/);
    expect(flatModeRailBlock).toMatch(/\.macos-ai-app \.zeus-mode-rail-item\.muted strong\s*\{[\s\S]*color:\s*var\(--zeus-product-muted\)/);
  });

  it('removes stale ZeusModeRail pill-chip base styles so the Codex metadata row cannot regress', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('ZeusModeRail 基础样式扁平化最终覆盖');
    expect(css).not.toMatch(/\.macos-ai-app \.zeus-mode-rail-item\s*\{[^}]*background:\s*var\(--zeus-product-panel\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.zeus-mode-rail-item\s*\{[^}]*border:\s*1px solid var\(--zeus-product-line-soft\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.zeus-mode-rail-item\s*\{[^}]*border-radius:\s*999px/);
    expect(css).not.toMatch(/\.macos-ai-app \.zeus-mode-rail\s*\{[^}]*background:\s*var\(--zeus-product-panel-muted\)/);
  });

  it('keeps task detail progression collapsed out of the task page first view instead of showing a command dock', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);

    for (const className of ['task-management-command-dock', 'task-management-command-rail', 'task-management-primary-action', 'task-management-secondary-action', 'task-management-compose-row', 'task-management-context-rail']) {
      expect(source).not.toContain(className);
      expect(html).not.toContain(className);
    }
    expect(source).toContain('任务页首屏只保留任务表格');
    expect(css).toContain('任务页纯表格首屏最终覆盖');
    expect(html).toContain('task-table-workbench');
    expect(html).not.toContain('conversation-input-dock');
    expect(source).not.toContain('task-management-action-strip');
    expect(css).not.toContain('.task-management-action-strip');
    expect(source).not.toContain('task-detail-action-strip');
    expect(css).not.toContain('.task-detail-action-strip');
  });

  it('removes stale generic composer style families from every workspace page', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const currentClass of ['zeus-mode-rail', 'zeus-decision-rail', 'graph-qa-compose-row', 'graph-mermaid-command-rail', 'project-inline-recovery-row', 'project-inline-recovery-command-rail']) {
      expect(source).toContain(currentClass);
      expect(css).toContain(`.${currentClass}`);
    }

    for (const migratedSessionClass of ['conversation-input-dock', 'conversation-compose-row', 'conversation-send-command-rail']) {
      expect(source).not.toContain(migratedSessionClass);
      expect(css).not.toContain(`.${migratedSessionClass}`);
    }

    expect(css).toContain('旧 composer 样式族清理最终覆盖');
    for (const staleClass of ['command-composer', 'codex-composer-dock', 'composer-input', 'composer-copy', 'composer-actions']) {
      expect(source).not.toContain(staleClass);
      expect(css).not.toMatch(new RegExp(`(^|[\\s,{>])\\.${staleClass}(?![\\w-])`));
    }
    expect(source).not.toContain('className="composer-dock"');
    expect(css).not.toMatch(/(^|[\s,{>])\.composer-dock(?![\w-])/);
  });

  it('removes stale admin header and generic action row style families from the renderer stylesheet', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const currentClass of ['project-first-sidebar', 'project-sidebar-list', 'workspace-view', 'code-repository-primary-rail', 'graph-qa-decision-rail', 'settings-section-nav']) {
      expect(source).toContain(currentClass);
      expect(css).toContain(`.${currentClass}`);
    }
    for (const removedInnerProjectListClass of ['project-list', 'project-source-list']) {
      expect(source).not.toContain(removedInnerProjectListClass);
      expect(css).not.toMatch(new RegExp(`(^|[\\s,{>])\\.${removedInnerProjectListClass}(?![\\w-])`));
    }

    // settings-row-actions stale guard
    expect(source).not.toContain('settings-row-actions');
    expect(css).not.toContain('.settings-row-actions');

    expect(css).toContain('旧后台页头与通用动作行清理最终覆盖');
    for (const staleClass of [
      'brand-block',
      'brand-mark',
      'sidebar-context',
      'sidebar-waiting',
      'nav-group',
      'nav-group-main',
      'nav-group-bottom',
      'topbar',
      'workspace-header',
      'workspace-quick-actions',
      'primary-action-row',
      'secondary-action-row',
      'object-summary',
      'thread-action-row',
      'thread-evidence-list',
      'thread-summary',
      'codex-section',
      'codex-section-header',
      'status-list',
    ]) {
      expect(source).not.toContain(staleClass);
      expect(css).not.toMatch(new RegExp(`(^|[\\s,{>])\\.${staleClass}(?![\\w-])`));
    }
    expect(css).not.toMatch(/(^|\n)nav\s*\{/);
    expect(css).not.toMatch(/(^|[\s,{>])nav a(?=[:\s,{])/);
  });

  it('removes stale git terminal settings card families from the renderer stylesheet', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const currentClass of ['git-diff-drawer-workbench', 'git-confirmation-row-list', 'runtime-log-workbench', 'runtime-log-toolbar', 'runtime-log-stream', 'settings-section-nav']) {
      expect(source).toContain(currentClass);
      expect(css).toContain(`.${currentClass}`);
    }
    expect(source).not.toContain('project-source-list');
    expect(css).not.toMatch(/(^|[\s,{>])\.project-source-list(?![\w-])/);

    expect(css).toContain('旧 Git 终端设置卡片族清理最终覆盖');
    for (const staleClass of ['git-commit-message', 'git-advanced-operations', 'terminal-log', 'runtime-log-actions', 'settings-search', 'project-browser']) {
      expect(source).not.toContain(staleClass);
      expect(css).not.toMatch(new RegExp(`(^|[\\s,{>])\\.${staleClass}(?![\\w-])`));
    }
  });

  it('removes stale sidebar thread and project hint shell leftovers from the renderer stylesheet', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const currentClass of ['project-first-sidebar', 'project-quick-actions', 'project-sidebar-list', 'project-section-menu']) {
      expect(source).toContain(currentClass);
      expect(css).toContain(`.${currentClass}`);
    }

    expect(source).not.toMatch(/conversation-thread-shell|conversation-message-list/);
    expect(css).not.toMatch(/conversation-thread-shell|conversation-message-list/);

    expect(css).toContain('旧侧栏线程与项目提示壳层清理最终覆盖');
    for (const staleClass of ['codex-thread-setup', 'project-uniqueness-note', 'sidebar-product-mark', 'thread-body']) {
      expect(source).not.toContain(staleClass);
      expect(css).not.toMatch(new RegExp(`(^|[\\s,{>])\\.${staleClass}(?![\\w-])`));
    }
  });

  it('normalizes graph conversations in the conversation context drawer into compact source rows', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialMainNavTarget="conversations"
        initialGraphConversations={[
          {
            id: 'conversation_real',
            projectId: 'project_real',
            taskId: 'task_real',
            sessionId: 'ai-session-real',
            title: '图谱问答：local-server',
            summary: 'AI 图谱回答：local-server 来源已核验',
            status: 'closed',
            createdAt: '2026-06-13T00:00:00.000Z',
            updatedAt: '2026-06-13T00:00:01.000Z',
            archived: false,
            messages: [],
          },
        ]}
      />,
    );
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('conversation-context-graph-list');
    expect(html).toContain('conversation-context-graph-row');
    expect(html).toContain('conversation-context-graph-copy');
    expect(html).toContain('conversation-context-graph-meta');
    expect(html).toContain('图谱问答：local-server');
    expect(html).toContain('已关闭');
    expect(html).not.toContain('closed');
    expect(source).not.toContain('className="object-row" key={conversation.id} onClick={() => loadGraphConversationDetail(conversation.id)}');
    expect(css).toContain('对话上下文图谱会话最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.conversation-context-graph-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  });

  it('localizes graph conversation statuses in English instead of leaking raw storage values', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialMainNavTarget="conversations"
        initialAppShellSettings={createAppShellSettings('en-US')}
        initialGraphConversations={[
          {
            id: 'conversation_real',
            projectId: 'project_real',
            taskId: 'task_real',
            sessionId: 'ai-session-real',
            title: 'Graph Q&A: local-server',
            summary: 'AI graph answer: local-server source verified',
            status: 'closed',
            createdAt: '2026-06-13T00:00:00.000Z',
            updatedAt: '2026-06-13T00:00:01.000Z',
            archived: false,
            messages: [],
          },
        ]}
      />,
    );

    expect(html).toContain('Closed');
    expect(html).not.toContain('closed');
  });

  it('normalizes conversation context and change drawers into compact inspector rows instead of loose spans and code blocks', () => {
    const diff: GitDiffSummary = {
      isRepository: true,
      branch: 'main',
      clean: false,
      files: ['apps/desktop/src/renderer/App.tsx'],
      fileDiffs: [
        {
          oldPath: 'apps/desktop/src/renderer/App.tsx',
          newPath: 'apps/desktop/src/renderer/App.tsx',
          addedLines: 12,
          deletedLines: 4,
          hunks: [],
        },
      ],
    };
    const contextHtml = renderToStaticMarkup(
      <App
        snapshot={createSnapshot({ nodeCount: 3, edgeCount: 2, viewCount: 1 })}
        initialMainNavTarget="conversations"
        initialGraphConversations={[
          {
            id: 'conversation_real',
            projectId: 'project_real',
            taskId: 'task_real',
            sessionId: 'ai-session-real',
            title: '图谱问答：local-server',
            summary: 'AI 图谱回答：local-server 来源已核验',
            status: 'closed',
            createdAt: '2026-06-13T00:00:00.000Z',
            updatedAt: '2026-06-13T00:00:01.000Z',
            archived: false,
            messages: [],
          },
        ]}
      />,
    );
    const changesHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" initialGitDiff={diff} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const className of [
      'conversation-context-workbench',
      'conversation-context-scope-row',
      'conversation-context-answer-row',
      'conversation-change-workbench',
      'conversation-change-file-list',
      'conversation-change-file-row',
      'conversation-change-file-copy',
    ]) {
      expect(source).toContain(className);
    }
    expect(contextHtml).toContain('conversation-context-workbench');
    expect(contextHtml).toContain('conversation-context-scope-row');
    expect(contextHtml).not.toContain('conversation-context-summary-row');
    expect(contextHtml).toContain('conversation-context-graph-list');
    expect(changesHtml).toContain('conversation-change-workbench');
    expect(changesHtml).toContain('conversation-change-file-row');
    expect(changesHtml).toContain('apps/desktop/src/renderer/App.tsx');
    expect(source).not.toContain('className="drawer-section" aria-label="上下文"');
    expect(source).not.toContain('className="drawer-section" aria-label="代码变更"');
    expect(css).toContain('会话上下文与变更抽屉 Inspector 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.conversation-context-workbench,\s*\n\.macos-ai-app \.conversation-change-workbench\s*\{[\s\S]*gap:\s*0/);
    expect(css).toContain('.conversation-context-scope-row');
    expect(css).not.toContain('.conversation-context-summary-row');
    expect(css).toMatch(/\.macos-ai-app \.conversation-context-scope-row,[\s\S]*\.conversation-change-file-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(css).not.toMatch(/\.macos-ai-app \.conversation-change-workbench\s+code\s*\{/);
  });

  it('shows one settings section at a time inside the approved reference settings shell', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('settings-reference-shell');
    expect(html).toContain('settings-sidebar-shell');
    expect(html).toContain('settings-section-nav');
    expect(html).toContain('settings-detail-pane');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('通用');
    expect(html).toContain('AI CLI / Runtime');
    expect(html).toContain('Telegram');
    expect(html).toContain('安全与钥匙串');
    expect(html).toContain('返回应用');
    expect(html).not.toContain('settings-category-list');
    expect(html).not.toContain('<aside class="settings-category-list"');
    expect(css).toContain('Settings reference shell 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell\s*\{[\s\S]*grid-template-columns:\s*minmax\(210px,\s*236px\) minmax\(0,\s*1fr\)/);
    expect(css).not.toMatch(/\.macos-ai-app \.settings-reference-shell\s*\{[\s\S]*grid-template-columns:\s*(?:220px|240px|260px|280px) minmax\(0,\s*1fr\)/);
    expect(html).not.toContain('当前分类');
    expect(html).not.toContain('settings-current-category');
    expect(html).not.toContain('安全审计');
    expect(html).not.toContain('消息日志');
    expect(html).not.toContain('发布与签名');
  });

  it('renders global settings as a dedicated preferences page instead of nesting it beside the project source list', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);

    expect(html).toContain('settings-dedicated-shell');
    expect(html).toContain('settings-reference-shell');
    expect(html).toContain('settings-sidebar-shell');
    expect(html).toContain('settings-content-column');
    expect(html).not.toContain('project-first-sidebar');
    expect(html).not.toContain('zeus-titlebar-protected-source-list');
  });

  it('keeps deep settings rows readable instead of squeezing Chinese titles into vertical text columns', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Settings deep row readability 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell \.settings-content-column:has\(\.deep-settings-pane\)\s*\{[\s\S]*max-inline-size:\s*780px/);
    expect(css).toMatch(
      /\.macos-ai-app\s+\.settings-reference-shell\s+\.deep-settings-pane\s*>\s*:where\([\s\S]*\.settings-data-portability-row\s*\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(220px,\s*0\.42fr\) minmax\(280px,\s*1fr\) minmax\(120px,\s*max-content\)/,
    );
    expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell \.settings-row-copy > :where\(strong,\s*span,\s*small\)\s*\{[\s\S]*word-break:\s*keep-all/);
    expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell \.settings-row-action-rail\s*\{[\s\S]*flex-wrap:\s*nowrap/);
  });

  it('uses a polished settings control vocabulary so copy, inputs and buttons do not overlap', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('Settings row control polish 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell \.native-control-copy\s*\{[\s\S]*display:\s*grid[\s\S]*gap:\s*2px[\s\S]*align-content:\s*center/);
    expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell \.native-control-description\s*\{[\s\S]*display:\s*block[\s\S]*line-height:\s*16px/);
    expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell :where\(input,\s*select\)\s*\{[\s\S]*box-sizing:\s*border-box[\s\S]*block-size:\s*28px[\s\S]*line-height:\s*16px/);
    expect(css).toMatch(
      /\.macos-ai-app \.settings-reference-shell :where\(\.zeus-select-trigger,\s*\.settings-row-action-rail > button,\s*\.release-update-command-rail > :where\(button,\s*a\),\s*\.native-control-slot > button\)\s*\{[\s\S]*box-sizing:\s*border-box[\s\S]*block-size:\s*28px/,
    );
    const settingsReferenceActionBlock =
      css.match(
        /\.macos-ai-app \.settings-reference-shell :where\(\.settings-row-action-rail > button,\s*\.release-update-command-rail > :where\(button,\s*a\),\s*\.native-control-slot > button,\s*\.native-settings-pane > button\)\s*\{[\s\S]*?\}/,
      )?.[0] ?? '';
    expect(settingsReferenceActionBlock).toContain('background: var(--zeus-control-bg');
    expect(settingsReferenceActionBlock).toContain('box-shadow: none');
    expect(settingsReferenceActionBlock).not.toContain('linear-gradient');
    expect(settingsReferenceActionBlock).not.toContain('inset 0 1px');
  });

  it('keeps release update, Git confirmation, and deep settings action rows away from row borders so button edges render fully', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" initialGitConfirmation={createGitSettingsConfirmation()} />);

    expect(css).toContain('Settings release row polish 最终覆盖');
    expect(css).toMatch(
      /\.macos-ai-app \.settings-reference-shell :where\(\.release-update-command-row,\s*\.release-update-version-row,\s*\.release-update-artifact-row\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(220px,\s*0\.42fr\) minmax\(280px,\s*1fr\) minmax\(120px,\s*max-content\)/,
    );
    expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell :where\(\.settings-row-action-rail,\s*\.release-update-command-rail\)\s*\{[\s\S]*align-items:\s*center[\s\S]*padding:\s*0[\s\S]*min-block-size:\s*28px/);
    const settingsActionTopEdgeBlock = css.match(/\.macos-ai-app \.settings-reference-shell :where\(\.settings-row-action-rail > button,\s*\.release-update-command-rail > :where\(button,\s*a\)\)\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(settingsActionTopEdgeBlock).toContain('position: relative');
    expect(settingsActionTopEdgeBlock).toContain('z-index: 1');
    expect(settingsActionTopEdgeBlock).toContain('background-clip: border-box');
    expect(settingsActionTopEdgeBlock).toContain('overflow: visible');
    expect(settingsActionTopEdgeBlock).not.toContain('background-clip: padding-box');
    expect(html).toContain('native-settings-pane deep-settings-pane git-settings-pane');
    expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell \.git-settings-pane > \.git-confirmation-risk-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(220px,\s*0\.42fr\) minmax\(280px,\s*1fr\) minmax\(120px,\s*max-content\)/);
  });

  it('aligns settings controls to the Codex macOS flat row vocabulary', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);

    expect(html).toContain('settings-product-pane');
    expect(html).toContain('native-settings-pane');
    expect(html).toContain('native-control-row');
    expect(html).toContain('native-control-copy');
    expect(html).toContain('native-control-slot');
    expect(html).toContain('native-switch-input');
    expect(html).toContain('选择 Zeus 使用的界面语言');
    expect(html).toContain('跟随系统');
  });

  it('removes settings card semantics so global settings cannot regress into stacked cards', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);

    expect(source).toContain('function NativeSettingsPane');
    expect(source).toContain('native-settings-pane');
    expect(source).toContain('deep-settings-pane');
    expect(css).toContain('设置 flat pane 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.native-settings-pane\s*\{[\s\S]*box-shadow:\s*none/);
    expect(css).toContain('全局设置开放画布最终覆盖');
    const settingsCanvasBlock = css.split('全局设置开放画布最终覆盖')[1]?.split('项目设置单工作区最终覆盖')[0] ?? '';
    expect(settingsCanvasBlock).toContain('.settings-detail-pane');
    expect(settingsCanvasBlock).toContain('.native-settings-pane');
    expect(settingsCanvasBlock).toContain('background: transparent');
    expect(settingsCanvasBlock).toContain('border: 0');
    expect(settingsCanvasBlock).toContain('border-radius: 0');
    expect(settingsCanvasBlock).toContain('box-shadow: none');
    expect(css).toMatch(/\.macos-ai-app\s+\.deep-settings-pane\s*>\s*:where\(\s*\.settings-config-row,[^)]*\.settings-data-portability-row\s*\)/);
    for (const staleToken of ['NativeSettingsCard', 'native-settings-card', 'deep-settings-card', 'runtime-settings-card', 'telegram-settings-card', 'security-settings-card', 'release-settings-card', 'data-settings-card']) {
      expect(source).not.toContain(staleToken);
      expect(css).not.toContain(staleToken);
      expect(html).not.toContain(staleToken);
    }
  });

  it('keeps settings copy keys aligned with flat pane semantics instead of card labels', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('generalPaneTitle');
    expect(source).toContain('paneTitle:');
    expect(source).not.toContain('generalCard');
    expect(source).not.toMatch(/settingsWorkspaceCopy\.(runtime|telegram|security|git|release|data)\.card/);
    expect(source).not.toMatch(/\n\s*card:\s*['"][^'"]+['"],/);
    expect(source).not.toMatch(/\n\s*card:\s*string;/);
  });

  it('removes remaining list and Git review card shell semantics in favor of flat panes', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('native-list-pane');
    expect(css).not.toContain('.native-list-pane');
    expect(source).toContain('git-file-review-workbench');
    expect(css).toContain('Git review flat workbench 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.git-file-review-workbench\s*\{[\s\S]*box-shadow:\s*none/);
    for (const staleToken of ['native-list-card', 'git-file-review-card']) {
      expect(source).not.toContain(staleToken);
      expect(css).not.toContain(staleToken);
    }
  });

  it('renames settings category panels away from form and stack shells into product panes', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);

    expect(source).not.toContain('settings-form');
    expect(source).not.toContain('native-settings-stack');
    expect(css).not.toContain('.settings-form');
    expect(css).not.toContain('native-settings-stack');
    expect(source).toContain('settings-product-pane');
    expect(html).toContain('settings-product-pane');
    expect(source).not.toContain('settings-category-pane');
    expect(html).not.toContain('settings-category-pane');
    expect(css).not.toContain('.settings-category-pane');
    expect(css).toContain('全局设置产品 pane 最终覆盖');
    expect(css).toContain('Settings reference shell 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.settings-content-column\s*\{[\s\S]*max-inline-size:\s*680px/);
  });

  it('renames global settings navigation away from stale category class names into section tabs', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);

    expect(html).toContain('class="settings-section-button selected" role="tab"');
    expect(html).toContain('class="settings-section-button " role="tab"');
    expect(source).not.toContain('settings-category-button');
    expect(html).not.toContain('settings-category-button');
    expect(css).not.toContain('settings-category-button');
    expect(css).not.toContain('settings-category-list');
  });

  it('renders global settings as a reference-style settings shell with grouped sidebar and centered content', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('settings-reference-shell');
    expect(html).toContain('settings-sidebar-shell');
    expect(html).toContain('settings-query-control');
    expect(html).toContain('settings-content-column');
    expect(html).toContain('settings-mode-card');
    expect(html).toContain('settings-permission-pane');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('data-inline-rail-keyboard="vertical"');
    expect(html).toContain('返回应用');
    expect(html).toContain('工作模式');
    expect(html).toContain('权限');
    expect(css).toContain('Settings reference shell 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.settings-reference-shell\s*\{[\s\S]*grid-template-columns:\s*minmax\(210px,\s*236px\) minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app \.settings-content-column\s*\{[\s\S]*max-inline-size:\s*680px/);
  });

  it('aligns project rows to the same rounded source-list row vocabulary as settings rows', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" />);

    expect(html).toContain('project-sidebar-list');
    expect(html).toContain('project-sidebar-row');
    expect(html).toContain('native-folder-icon');
    expect(html).toContain('project-row-main');
    expect(html).toContain('project-row-actions');
    expect(html).toContain('/Users/david/hypha/zeus');
  });

  it('exposes per-project settings and more actions without mixing them into global settings', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);

    expect(sidebar).toContain('aria-label="项目设置：Zeus"');
    expect(sidebar).toContain('aria-label="更多项目操作：Zeus"');
    expect(sidebar).toContain('置顶该项目');
    expect(sidebar).toContain('删除项目');
    expect(sidebar).not.toContain('只删除 Zeus 项目记录，不删除本地目录');
  });

  it('normalizes project more actions into an explicit button popover instead of details summary chrome', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('<details');
    expect(source).not.toContain('<summary');
    expect(css).not.toContain('project-row-actions > summary');
    expect(css).not.toContain('::-webkit-details-marker');
    for (const className of ['project-row-actions', 'project-more-button', 'project-more-popover']) {
      expect(source).toContain(className);
      expect(html).toContain(className);
    }
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(css).toContain('项目更多按钮最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-row-actions\s*\{[\s\S]*position:\s*relative/);
    expect(css).toMatch(/\.macos-ai-app \.project-row-actions\.open \.project-more-popover\s*\{[\s\S]*opacity:\s*1/);
    expect(css).not.toMatch(/\.macos-ai-app \.project-row-actions:where\(:hover, :focus-within\) \.project-more-popover/);
  });

  it('makes project overflow popovers keyboard dismissible as explicit motion surfaces', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const closeProjectMoreMenu = (projectId: string) => {');
    expect(source).toContain('const handleProjectMoreMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, projectId: string) => {');
    expect(source).toContain("if (event.key !== 'Escape') return;");
    expect(source).toContain('closeProjectMoreMenu(projectId);');
    expect(source).toContain('onKeyDown={(event) => handleProjectMoreMenuKeyDown(event, project.id)}');
    expect(html).toContain('data-motion-surface="popover"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('role="menu"');
  });

  it('keeps project overflow popovers in a closing motion state before hiding them', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('const projectPopoverCloseAnimationMs = 120;');
    expect(source).toContain('const [closingProjectMenuIds, setClosingProjectMenuIds] = useState<Set<string>>(() => new Set());');
    expect(source).toContain('const projectMenuCloseTimerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());');
    expect(source).toContain('const closeProjectMoreMenuWithMotion = (projectId: string) => {');
    expect(source).toContain('setClosingProjectMenuIds((current) => new Set(current).add(projectId));');
    expect(source).toContain('setTimeout(() => {');
    expect(source).toContain('projectPopoverCloseAnimationMs');
    expect(source).toContain('const menuVisible = menuOpen || menuClosing;');
    expect(source).toContain("data-motion-state={menuClosing ? 'closing' : menuOpen ? 'open' : undefined}");
    expect(source).toContain('hidden={!menuVisible}');
    expect(source).toContain('closeProjectMoreMenuWithMotion(project.id);');
    expect(source).toContain('closeOpenProjectMoreMenusWithMotion();');
    expect(css).toContain('@keyframes zeus-popover-exit');
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover\[data-motion-state='closing'\]\s*\{[\s\S]*animation:\s*zeus-popover-exit 120ms var\(--zeus-motion-ease-out\) forwards/);
    expect(css).toMatch(/\.macos-ai-app \.project-more-popover\[data-motion-state='closing'\]\s*\{[\s\S]*pointer-events:\s*none/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.macos-ai-app \[data-motion-state='closing'\]/);
  });

  it('closes project overflow popovers on outside pointer down without collapsing other project rows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const closeProjectMoreMenusOnOutsidePointerDown = (event: PointerEvent) => {');
    expect(source).toContain('if (!(event.target instanceof Element)) return;');
    expect(source).toContain("if (event.target.closest('.project-row-actions')) return;");
    expect(source).toContain('current.size === 0 ? current : new Set()');
    expect(source).toContain("document.addEventListener('pointerdown', closeProjectMoreMenusOnOutsidePointerDown, true);");
    expect(source).toContain("document.removeEventListener('pointerdown', closeProjectMoreMenusOnOutsidePointerDown, true);");
    expect(source).not.toContain('setExpandedProjectIds(new Set())');
  });

  it('removes the generic DataPanel stacking contract from the renderer source', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).not.toContain('function DataPanel');
    expect(source).not.toContain('<DataPanel');
    expect(source).not.toContain('ContextRail model=');
  });

  it('removes stale CSS that can revive the old flat admin shell', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const removedSelector of [
      '.settings-workbench',
      '.projects-workbench',
      '.project-inspector',
      '.workspace-view-tasks',
      '.workspace-view-runtime',
      '.workspace-view-git-diff',
      '.workspace-view-code-map',
      '.workspace-view-telegram',
      '.context-inspector',
    ]) {
      expect(css).not.toContain(removedSelector);
    }

    expect(css).not.toContain('grid-template-columns: 236px minmax(620px, 1fr) 292px');
    expect(css).not.toContain('grid-template-columns: 228px minmax(680px, 1fr) 300px');
  });

  it('removes obsolete edit form and legacy dashboard css selectors from the renderer stylesheet', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const staleSourceClass of ['edit-form', 'data-panel', 'status-grid', 'dashboard-recent', 'first-run-guide', 'launch-readiness', 'empty-layout']) {
      expect(source).not.toContain(staleSourceClass);
    }

    for (const staleCssSelector of ['.edit-form', '.data-panel', '.status-grid', '.dashboard-recent', '.first-run-guide', '.launch-readiness', '.empty-layout', '.settings-group > label', '.graph-history-toolbar label']) {
      expect(css).not.toContain(staleCssSelector);
    }

    expect(css).toContain('旧后台布局样式清理最终覆盖');
  });

  it('removes the unused evidence-row selector family from renderer css', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('evidence-row');
    expect(css).toContain('通用 evidence-row CSS 清理最终覆盖');
    expect(css).not.toMatch(/(^|[\s,{>])\.evidence-row\b/);
  });

  it('removes unused legacy dashboard selector families from renderer css', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const staleSourceClass of ['activity-stream', 'stream-item', 'status-panel', 'timeline-event', 'settings-group', 'data-grid', 'data-list']) {
      expect(source).not.toContain(staleSourceClass);
    }
    expect(css).toContain('旧面板死样式清理最终覆盖');
    for (const staleCssSelector of ['.activity-stream', '.stream-item', '.status-panel', '.timeline-event', '.settings-group', '.data-grid', '.data-list']) {
      expect(css).not.toContain(staleCssSelector);
    }
    expect(css).not.toMatch(/(^|[\s,{>])\.timeline(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-detail(?![\w-])/);
    expect(css).toContain('.graph-detail-workbench');
    expect(css).toContain('.graph-detail-context-row');
    expect(css).not.toMatch(/(^|[\s,{>])\.empty-state(?![\w-])/);
  });

  it('removes legacy prompt notice guide and launch selector families from renderer css', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={{ ...createSnapshot(), projects: [] }} />);

    expect(html).toContain('project-inline-recovery-row');
    expect(html).toContain('project-inline-recovery-copy');
    expect(html).toContain('project-inline-recovery-command-rail');
    expect(html).toContain('选择真实本地代码库');
    expect(source).not.toContain('empty-prompt');
    expect(source).not.toContain('prompt-actions');
    expect(css).toContain('项目行内恢复提示命名最终覆盖');
    for (const staleCssSelector of ['.empty-prompt', '.prompt-actions', '.inline-notice', '.inspector-section', '.stream-header', '.launch-copy', '.launch-checks', '.guide-summary', '.guide-steps', '.guide-actions', '.fact-strip']) {
      expect(css).not.toContain(staleCssSelector);
    }
    expect(css).toContain('.project-inline-recovery-row');
    expect(css).toContain('.project-inline-recovery-command-rail');
  });

  it('renames project empty action rows into guidance rows and command rails', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={{ ...createSnapshot(), projects: [] }} />);

    expect(source).not.toContain('project-empty-action-row');
    expect(source).not.toContain('project-empty-actions');
    expect(css).not.toContain('project-empty-action-row');
    expect(css).not.toContain('project-empty-actions');
    expect(html).toContain('project-inline-recovery-row');
    expect(html).toContain('project-inline-recovery-command-rail');
    expect(css).toContain('项目行内恢复提示命名最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-inline-recovery-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  });

  it('keeps the no-project sidebar recovery row readable instead of letting the picker badge truncate the repository action', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={{ ...createSnapshot(), projects: [] }} />);
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);

    expect(sidebar).toContain('选择真实本地代码库');
    expect(sidebar).toContain('project-inline-recovery-command-rail');
    expect(css).toContain('2026-06-23 no-project source-list recovery readable final cover');
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-inline-recovery-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-inline-recovery-copy > strong\s*\{[\s\S]*white-space:\s*normal/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-inline-recovery-command-rail\s*\{[\s\S]*justify-content:\s*flex-start/);
    expect(css).toMatch(/\.macos-ai-app\.zeus-shell \.project-first-sidebar \.project-inline-recovery-command-rail button\s*\{[\s\S]*inline-size:\s*100%/);
  });

  it('removes the generic task-controls and dead graph history toolbar selector families', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const requiredClass of ['git-confirmation-command-rail', 'runtime-row-command-rail', 'runtime-generic-shell-command-rail', 'project-inline-recovery-command-rail']) {
      expect(source).toContain(requiredClass);
      expect(css).toContain(`.${requiredClass}`);
    }
    expect(css).toContain('通用 task-controls 与图谱历史工具栏清理最终覆盖');
    expect(source).not.toContain('task-controls');
    expect(source).not.toContain('graph-history-toolbar');
    expect(css).not.toMatch(/(^|[\s,{>])\.task-controls(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.graph-history-toolbar(?![\w-])/);
  });

  it('removes the inner project source list from project settings so the left source-list remains the only project list', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const codeHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />);
    const settingsHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" initialProjectConfig={createProjectConfig()} />);

    expect(source).not.toContain('project-source-list');
    expect(source).not.toContain('project-source-row');
    expect(source).not.toContain('project-source-main');
    expect(source).not.toContain('project-source-trailing');
    expect(codeHtml).not.toContain('project-source-list');
    expect(codeHtml).not.toContain('project-source-row');
    expect(settingsHtml).not.toContain('project-source-list');
    expect(settingsHtml).not.toContain('project-source-row');
    expect(settingsHtml).not.toContain('workspace-list-pane project-list-pane');
    expect(settingsHtml).toContain('workspace-view-project-settings');
    expect(settingsHtml).toContain('workspace-detail-pane project-detail-pane');
    expect(source).not.toContain('object-row');
    expect(css).not.toContain('.object-row');
    expect(css).toContain('项目设置单工作区最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.workspace-view-project-settings\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('does not flatten project edit, project config or all settings sections into first-level pages', () => {
    const projectHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" />);
    const settingsHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);

    for (const tuckedProjectCopy of ['项目编辑表单', '项目配置', '数据库连接配置', '保存项目配置', '确认删除项目']) {
      expect(projectHtml).not.toContain(tuckedProjectCopy);
    }

    for (const tuckedSettingsCopy of ['Runtime 执行设置', 'Telegram Bot Token', '发布与签名', '泄露风险', '导出设置']) {
      expect(settingsHtml).not.toContain(tuckedSettingsCopy);
    }
  });

  it('opens collected project and conversation content as modal drawers instead of in-page expansion blocks', () => {
    const projectHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="git-diff" />);
    const conversationHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="runtime" />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const html of [projectHtml, conversationHtml]) {
      expect(html).toContain('class="workspace-drawer-backdrop"');
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain('class="workspace-drawer-content"');
    }

    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer-backdrop\s*{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\s*{[^}]*position:\s*fixed/s);
    expect(css).not.toContain('.macos-ai-app .workspace-drawer {\n  margin-block-start: 16px;');
  });

  it('portals workspace drawers to the app root so detail panes cannot clip them visually', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain("import { createPortal } from 'react-dom';");
    expect(source).toContain('const drawerSurface = (');
    expect(source).toContain('createPortal(drawerSurface, document.body)');
    expect(css).toContain('抽屉根层可见性最终覆盖');
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer-backdrop\s*\{[\s\S]*position:\s*fixed/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app\s*\{[\s\S]*--zeus-drawer-backdrop-inset-block:\s*56px 0/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app\s*\{[\s\S]*--zeus-drawer-backdrop-inset-inline:\s*236px 0/);
  });

  it('makes modal workspace drawers keyboard dismissible with a focusable motion surface', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="git-diff" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const workspaceDrawerRef = useRef<HTMLElement | null>(null)');
    expect(source).toContain('const previousFocusedElementRef = useRef<HTMLElement | null>(null)');
    expect(source).toContain('previousFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null');
    expect(source).toContain('workspaceDrawerRef.current?.focus()');
    expect(source).toContain('const previousFocusedElement = previousFocusedElementRef.current');
    expect(source).toContain('previousFocusedElement?.isConnected');
    expect(source).toContain('previousFocusedElement.focus()');
    expect(source).toContain('ref={workspaceDrawerRef}');
    expect(source).toContain('const handleWorkspaceDrawerKeyDown');
    expect(source).toContain("event.key !== 'Escape'");
    expect(source).toContain('event.stopPropagation()');
    expect(source).toContain('props.onClose()');
    expect(source).toContain('onKeyDown={handleWorkspaceDrawerKeyDown}');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('data-motion-surface="drawer"');
  });

  it('keeps workspace drawers mounted long enough to play a closing animation instead of disappearing immediately', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="git-diff" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('const workspaceDrawerCloseAnimationMs = 180');
    expect(source).toContain('const [isClosing, setIsClosing] = useState(false)');
    expect(source).toContain('const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)');
    expect(source).toContain('const requestWorkspaceDrawerClose = () => {');
    expect(source).toContain('setIsClosing(true)');
    expect(source).toContain('closeTimerRef.current = setTimeout(props.onClose, workspaceDrawerCloseAnimationMs)');
    expect(source).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(source).toContain('onClick={requestWorkspaceDrawerClose}');
    expect(source).toContain("data-motion-state={isClosing ? 'closing' : 'open'}");
    expect(html).toContain('data-motion-state="open"');
    expect(css).toContain('抽屉关闭动效最终覆盖');
    expect(css).toContain('@keyframes zeus-drawer-exit');
    expect(css).toContain('@keyframes zeus-drawer-backdrop-exit');
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\[data-motion-state=['"]closing['"]\]\s*\{[\s\S]*animation:\s*zeus-drawer-exit 160ms var\(--zeus-motion-ease-out\) forwards/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer-backdrop\[data-motion-state=['"]closing['"]\]\s*\{[\s\S]*animation:\s*zeus-drawer-backdrop-exit 140ms var\(--zeus-motion-ease-out\) forwards/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\[data-motion-state=['"]closing['"]\]\s*\{[\s\S]*animation:\s*none/);
  });

  it('requires every workspace drawer to receive localized backdrop and close labels instead of composing Chinese fallbacks', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(source).toContain('function WorkspaceDrawer(props: { label: string; backdropLabel: string; closeLabel: string;');
    expect(source).toContain('aria-label={props.backdropLabel}');
    expect(source).toContain('{props.closeLabel}');
    expect(source).not.toContain('`${props.label}背景`');
    expect(source).not.toContain('`关闭${props.label}`');
    expect(source).not.toContain('backdropLabel?: string');
    expect(source).not.toContain('closeLabel?: string');
  });

  it('normalizes conversation secondary drawers into a dedicated animated shell with localized chrome', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="runtime" initialAppShellSettings={createAppShellSettings('en-US')} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('workspace-view-project-sessions');
    expect(html).toContain('session-codex-parity-v1');
    expect(html).toContain('session-list-pane');
    expect(html).not.toContain('conversation-thread-shell');
    expect(html).toContain('workspace-drawer conversation-drawer conversation-drawer-shell conversation-drawer-sheet-runtime');
    expect(html).toContain('aria-label="Conversation drawer"');
    expect(html).toContain('aria-label="Conversation drawer backdrop"');
    expect(html).toContain('Close conversation drawer');
    expect(html).not.toContain('对话二级面板');
    expect(html).not.toContain('关闭对话二级面板');
    expect(html).not.toContain('对话二级面板背景');
    expect(html).not.toContain('Conversation details panel');
    expect(html).not.toContain('Conversation panel backdrop');
    expect(html).not.toContain('Close conversation panel');
    expect(source).toContain('conversation-drawer-sheet conversation-drawer-sheet-runtime');
    expect(source).toContain('secondaryDrawerLabel');
    expect(source).toContain('backdropLabel={sessionWorkspaceCopy.secondaryDrawerBackdrop}');
    expect(source).toContain('closeLabel={sessionWorkspaceCopy.secondaryDrawerClose}');
    for (const staleToken of ['conversation-drawer-panel', 'conversation-drawer-panel-runtime', 'conversation-drawer-panel-context', 'conversation-drawer-panel-changes', 'conversation-drawer-panel-templates']) {
      expect(html).not.toContain(staleToken);
      expect(source).not.toContain(staleToken);
      expect(css).not.toContain(staleToken);
    }
    expect(css).toContain('会话二级抽屉 Sheet 最终覆盖');
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell\s*\{[\s\S]*animation:\s*zeus-conversation-drawer-enter 180ms var\(--zeus-motion-ease-out\)/);
    expect(css).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell\s*\{[\s\S]*inline-size:\s*var\(--zeus-conversation-drawer-inline-size\)/);
    expect(css).toMatch(/@keyframes zeus-conversation-drawer-enter\s*\{[\s\S]*translate3d\(10px,\s*0,\s*0\)/);
    expect(css).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell\s*\{[\s\S]*inline-size:\s*100vw/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell\s*\{[\s\S]*animation:\s*none/);
  });

  it('keeps the mobile conversation drawer opaque and readable instead of letting the underlying workspace bleed through', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('移动端会话抽屉可读性最终覆盖');
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.workspace-drawer-portal-root\.macos-ai-app:has\(\.conversation-drawer-shell\) \.workspace-drawer-backdrop\s*\{[\s\S]*background:\s*var\(--zeus-drawer-surface-bg\)/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell\s*\{[\s\S]*background:\s*var\(--zeus-drawer-surface-bg\)/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell \.workspace-drawer-content\s*\{[\s\S]*color:\s*var\(--zeus-product-text\)/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell\s*\{[\s\S]*border-inline-start:\s*0/);
  });

  it('keeps the mobile runtime conversation drawer readable as separated rows instead of a translucent dense stack', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(css).toContain('移动端 Runtime 抽屉行式可读性最终覆盖');
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell \.runtime-workbench\s*\{[\s\S]*gap:\s*10px/);
    expect(css).toMatch(
      /@media \(max-width:\s*760px\)\s*\{[\s\S]*\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell \.runtime-workbench > :where\(\.drawer-header-row,\s*\.runtime-status-row-list,[^)]*\.runtime-log-workbench\)\s*\{[\s\S]*background:\s*var\(--zeus-product-panel\)/,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*760px\)\s*\{[\s\S]*\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell \.runtime-status-row-list > \.runtime-capability-state-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(css).toMatch(/@media \(max-width:\s*760px\)\s*\{[\s\S]*\.workspace-drawer-portal-root\.macos-ai-app \.conversation-drawer-shell \.runtime-session-filter-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('renders runtime drawer controls in the selected language without translating real runtime facts', () => {
    const runtimeSession: AiRuntimeSession = {
      id: 'runtime-session-real',
      projectId: 'project_real',
      command: 'codex',
      args: ['--version'],
      cwd: '/Users/david/hypha/zeus',
      status: 'exited',
      exitCode: 0,
      startedAt: '2026-06-18T00:00:00.000Z',
    };
    const runtimeLogs: AiRuntimeLogEntry[] = [
      {
        id: 'runtime-log-real',
        sessionId: runtimeSession.id,
        stream: 'stdout',
        text: '真实 Runtime 输出保持原文',
        createdAt: '2026-06-18T00:00:01.000Z',
      },
    ];
    const runningRuntimeSession: AiRuntimeSession = {
      ...runtimeSession,
      id: 'runtime-session-running',
      status: 'running',
      exitCode: null,
    };
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialMainNavTarget="runtime"
        initialAppShellSettings={createAppShellSettings('en-US')}
        initialRuntimeGenericShellCommand="pnpm --version"
        initialRuntimeAdapters={createRuntimeAdapters()}
        initialRuntimeStatus={{ ...createRuntimeStatus(), terminal: { provider: 'node-pty', pty: { available: true } } }}
        initialRuntimeSessions={[runtimeSession]}
        initialRuntimeLogs={runtimeLogs}
      />,
    );
    const zhRuntimeHtml = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialMainNavTarget="runtime"
        initialAppShellSettings={createAppShellSettings('zh-CN')}
        initialRuntimeGenericShellCommand="pnpm --version"
        initialRuntimeAdapters={createRuntimeAdapters()}
        initialRuntimeStatus={{ ...createRuntimeStatus(), terminal: { provider: 'node-pty', pty: { available: true } } }}
        initialRuntimeSessions={[runningRuntimeSession]}
        initialRuntimeLogs={runtimeLogs}
      />,
    );
    const fallbackHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="runtime" initialAppShellSettings={createAppShellSettings('en-US')} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(html).toContain('Runtime environment');
    expect(html).toContain('Refresh');
    expect(html).toContain('Runtime status');
    expect(html).toContain('Waiting for codex');
    expect(html).toContain('Terminal backend');
    expect(html).toContain('AI Runtime sessions');
    expect(html).toContain('Start Runtime session');
    expect(html).toContain('Search sessions');
    expect(html).toContain('Command, path, or summary');
    expect(html).toContain('Favorites only');
    expect(html).toContain('Show archived');
    expect(html).toContain('Apply filters');
    expect(html).toContain('No Runtime log export yet');
    expect(html).toContain('No Runtime log copy yet');
    expect(html).toContain('No Generic shell confirmation yet');
    expect(html).toContain('For example pnpm --version');
    expect(html).toContain('sh -lc pnpm --version');
    expect(html).toContain('真实 Runtime 输出保持原文');
    expect(html).toContain('aria-label="xterm Runtime terminal"');
    expect(fallbackHtml).toContain('node-pty status is pending.');
    expect(fallbackHtml).not.toContain('node-pty 状态等待读取');
    expect(zhRuntimeHtml).toContain('中断');
    expect(zhRuntimeHtml).toContain('调整终端尺寸');
    expect(zhRuntimeHtml).toContain('读取终端快照');
    expect(zhRuntimeHtml).toContain('停止会话');
    expect(zhRuntimeHtml).not.toContain('>Interrupt<');
    for (const leakedCopy of [
      '运行环境',
      '刷新',
      'Runtime 状态',
      '等待配置',
      '终端后端',
      'AI Runtime 会话',
      '启动 Runtime 会话',
      '搜索会话',
      '按命令、路径或摘要过滤',
      '只看收藏',
      '显示归档',
      '应用会话筛选',
      '暂无真实 Runtime 会话',
      '尚未导出 Runtime 日志',
      '尚未复制 Runtime 日志',
      '尚未创建 Generic shell 确认',
      'Generic shell 高风险确认',
      'Generic shell 命令',
      '创建 Generic shell 确认',
      '确认并启动 Generic shell',
      '尚未创建',
    ]) {
      expect(html).not.toContain(leakedCopy);
    }
    expect(source).toContain('runtimeDrawer: {');
    expect(source).toContain('runtimeEnvironment');
    expect(source).toContain('waitingForCommand');
    expect(source).toContain('emptyRuntimeSessions');
    expect(source).toContain('runtimeInputTitle');
    expect(source).toContain('logSearchTitle');
    expect(source).toContain('formatRuntimeAdapterDetectionFacts(adapter, checked, appShellSettings.appLanguage)');
    expect(source).toContain('formatRuntimeLogExportStatus(runtimeLogExportStatus, sessionWorkspaceCopy.runtimeDrawer)');
    expect(source).toContain('formatRuntimeLogCopyStatus(runtimeLogCopyStatus, sessionWorkspaceCopy.runtimeDrawer)');
    expect(source).toContain('formatRuntimeConfirmationStatus(runtimeConfirmationStatus, sessionWorkspaceCopy.runtimeDrawer)');
    expect(source).not.toContain("useState('尚未导出 Runtime 日志')");
    expect(source).not.toContain("useState('尚未复制 Runtime 日志')");
    expect(source).not.toContain('`尚未${sessionWorkspaceCopy.runtimeDrawer.createGenericShellConfirmation}`');
    expect(source).not.toContain('<span>日志已折叠，点击展开日志查看。</span>');
    expect(source).not.toContain('aria-label="xterm Runtime 终端"');
    expect(source).not.toContain("setRuntimeConfirmationStatus('Generic shell 确认创建失败')");
    expect(source).not.toContain("setRuntimeConfirmationStatus('Generic shell 确认拒绝失败')");
    expect(source).not.toContain("setRuntimeConfirmationStatus('Generic shell 确认或启动失败')");
    for (const hardcodedRuntimeCopy of ['aria-label="Runtime 输入"', 'aria-label="搜索日志"', '>生成摘要<', '>从会话创建任务<', '>复制当前日志<', '>导出当前日志<', '>停止会话<', '>检测 adapter<']) {
      expect(source).not.toContain(hardcodedRuntimeCopy);
    }
  });

  it('renders runtime drawer adapter chrome in Simplified Chinese without leaking English Adapter controls', () => {
    const html = renderToStaticMarkup(
      <App snapshot={createSnapshot()} initialMainNavTarget="runtime" initialRuntimeAdapters={createRuntimeAdapters()} initialRuntimeStatus={{ ...createRuntimeStatus(), terminal: { provider: 'node-pty', pty: { available: true } } }} />,
    );
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(html).toContain('Runtime 适配器');
    expect(html).toContain('检测适配器');
    expect(html).toContain('<strong>通用 Shell</strong>');
    expect(html).toContain('通用 Shell 高风险确认');
    expect(html).toContain('通用 Shell 命令');
    expect(html).toContain('尚未创建通用 Shell 确认');
    expect(html).toContain('创建通用 Shell 确认');
    expect(html).toContain('确认并启动通用 Shell');
    expect(html).not.toContain('<strong>Generic shell</strong>');
    expect(html).not.toContain('Runtime Adapters');
    expect(html).not.toContain('检测 adapter');
    expect(html).not.toContain('Generic shell 高风险确认');
    expect(html).not.toContain('Generic shell 命令');
    expect(html).not.toContain('尚未创建 Generic shell 确认');
    expect(html).not.toContain('创建 Generic shell 确认');
    expect(html).not.toContain('确认并启动 Generic shell');
    expect(source).toContain("runtimeAdaptersTitle: 'Runtime 适配器'");
    expect(source).toContain("checkAdapter: '检测适配器'");
    expect(source).toContain("genericShellRiskTitle: '通用 Shell 高风险确认'");
    expect(source).toContain("genericShellCommandTitle: '通用 Shell 命令'");
    expect(source).toContain("createGenericShellConfirmation: '创建通用 Shell 确认'");
    expect(source).toContain("confirmAndStartGenericShell: '确认并启动通用 Shell'");
    expect(source).not.toContain("runtimeAdaptersTitle: 'Runtime Adapters'");
    expect(source).not.toContain("checkAdapter: '检测 adapter'");
    expect(source).not.toContain("genericShellRiskTitle: 'Generic shell 高风险确认'");
    expect(source).not.toContain("genericShellCommandTitle: 'Generic shell 命令'");
    expect(source).not.toContain("createGenericShellConfirmation: '创建 Generic shell 确认'");
    expect(source).not.toContain("confirmAndStartGenericShell: '确认并启动 Generic shell'");
  });

  it('renders conversation context changes and template drawers in the selected language without Chinese control leakage', () => {
    const diff: GitDiffSummary = {
      isRepository: true,
      branch: 'main',
      clean: false,
      files: ['apps/desktop/src/renderer/App.tsx'],
      fileDiffs: [
        {
          oldPath: 'apps/desktop/src/renderer/App.tsx',
          newPath: 'apps/desktop/src/renderer/App.tsx',
          addedLines: 12,
          deletedLines: 4,
          hunks: [],
        },
      ],
    };
    const graphView = { ...createGraphView(), title: 'Zeus architecture' };
    const contextHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" initialGraphView={graphView} initialAppShellSettings={createAppShellSettings('en-US')} />);
    const changesHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" initialGitDiff={diff} initialAppShellSettings={createAppShellSettings('en-US')} />);
    const templatesHtml = renderToStaticMarkup(
      <App
        snapshot={createSnapshot({ tasks: [] })}
        initialAppShellSettings={createAppShellSettings('en-US')}
        initialTaskTemplates={[
          {
            id: 'task_template_bug_fix',
            name: 'Bug fix',
            description: '',
            promptTemplate: 'Fix {{bug}} in {{project}}',
            builtIn: true,
          },
        ]}
      />,
    );

    for (const expectedCopy of ['Context', 'Open graph', 'Graph context', 'Real graph scope for the current project']) {
      expect(contextHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of ['上下文', '打开图谱', '图谱上下文', '当前项目真实图谱规模']) {
      expect(contextHtml).not.toContain(leakedCopy);
    }

    for (const expectedCopy of ['Code changes', 'Load Diff', 'Real Git diff file', 'Loaded']) {
      expect(changesHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of ['代码变更', '读取 Diff', '真实 Git diff 文件', '已读取']) {
      expect(changesHtml).not.toContain(leakedCopy);
    }

    for (const expectedCopy of ['Task templates', 'Load templates', 'Built-in task template', 'Apply template']) {
      expect(templatesHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of ['任务模板', '读取模板', '内置任务模板', '内置模板', '套用模板']) {
      expect(templatesHtml).not.toContain(leakedCopy);
    }
  });

  it('renders Simplified Chinese conversation drawer controls without leaking template expressions', () => {
    const emptyChangesSnapshot = createSnapshot();
    emptyChangesSnapshot.git.changedFiles = [];
    const changesHtml = renderToStaticMarkup(<App snapshot={emptyChangesSnapshot} initialMainNavTarget="conversations" initialGitConfirmation={createGitSettingsConfirmation()} />);
    const templatesHtml = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialTaskTemplates={[
          {
            id: 'task_template_bug_fix',
            name: '缺陷修复',
            description: '',
            promptTemplate: '修复 {{bug}}',
            builtIn: true,
          },
        ]}
      />,
    );
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(changesHtml).toContain('代码变更');
    expect(changesHtml).toContain('读取 Diff');
    expect(changesHtml).toContain('读取 Diff 后会按真实文件路径展示。');
    expect(changesHtml).not.toContain('{loadingDiffBusy ? secondaryDrawerCopy.loadingDiff : secondaryDrawerCopy.loadDiff}');

    expect(templatesHtml).toContain('任务模板');
    expect(templatesHtml).toContain('套用模板');
    expect(templatesHtml).not.toContain('{secondaryDrawerCopy.applyTemplate}');
    expect(source).not.toContain("loadDiff: '{loadingDiffBusy ? secondaryDrawerCopy.loadingDiff : secondaryDrawerCopy.loadDiff}'");
    expect(source).not.toContain("applyTemplate: '{secondaryDrawerCopy.applyTemplate}'");
  });

  it('normalizes deep global settings controls into compact native rows instead of loose form stacks', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('<span>Runtime 执行设置</span>');
    expect(source).not.toContain('<span>发布与签名</span>');
    expect(css).toContain('设置 flat pane 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.native-settings-pane\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(
      /\.macos-ai-app \.native-settings-pane > :where\([\s\S]*\.native-control-row[\s\S]*\.settings-config-row[\s\S]*\.release-update-workbench[\s\S]*\)\s*\{[\s\S]*border-block-start:\s*1px solid var\(--zeus-product-line-soft\)/,
    );
    expect(css).not.toContain('.native-settings-pane > label');
    expect(css).not.toContain('.native-settings-pane > .task-controls');
  });

  it('normalizes global settings deep categories into explicit compact rows instead of disclosure and action piles', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    for (const requiredClass of [
      'deep-settings-pane',
      'runtime-advanced-row',
      'telegram-secret-row',
      'telegram-chat-row',
      'telegram-polling-row',
      'security-secret-row',
      'security-whitelist-row',
      'security-danger-row',
      'security-audit-row',
      'release-detail-row',
      'settings-data-portability-row',
      'settings-row-copy',
      'settings-row-field',
      'settings-row-action-rail',
    ]) {
      expect(source).toContain(requiredClass);
    }
    expect(source).not.toContain('<summary>高级 Runtime 参数</summary>');
    expect(source).not.toContain('<summary>轮询与消息日志</summary>');
    expect(source).not.toContain('<summary>安全审计</summary>');
    expect(source).not.toContain('<summary>发布详情</summary>');
    expect(css).toContain('全局深层设置最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app \.deep-settings-pane > :where\(\s*\.settings-config-row,[^)]*\.settings-data-portability-row\s*\) \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*380px\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.settings-row-field\s*\{[\s\S]*display:\s*grid/);
  });

  it('normalizes release update into compact action and artifact rows instead of a loose mixed panel', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialReleaseStatus={createReleaseStatus()} initialReleaseUpdateStatus={createReleaseUpdateStatus()} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const className of ['release-update-workbench', 'release-update-command-row', 'release-update-version-row', 'release-update-artifact-row', 'release-update-copy', 'release-update-field', 'release-update-command-rail']) {
      expect(source).toContain(className);
      expect(html).toContain(className);
    }
    expect(html).toContain('Zeus-0.2.0-arm64.dmg');
    expect(html).toContain('real_sha256');
    expect(source).not.toContain('className="release-update-heading"');
    expect(source).not.toContain('<div className="release-update-summary">');
    expect(source).not.toContain('<code>\n                          {releaseUpdateStatus.artifact.fileName}');
    expect(css).toContain('发布更新 workbench 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.release-update-workbench\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.release-update-command-row,[\s\S]*\.macos-ai-app \.release-update-artifact-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(css).toContain('发布更新 workbench 窄屏防漂移最终覆盖');
    expect(css).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.macos-ai-app :where\(\s*\.release-update-command-row,[\s\S]*\.release-update-artifact-row\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.macos-ai-app \.release-update-command-rail\s*\{[\s\S]*justify-content:\s*flex-start/);
    expect(css).toMatch(/\.macos-ai-app \.release-update-field\s*\{[\s\S]*display:\s*grid/);
    expect(source).not.toContain('release-update-actions');
    expect(css).not.toContain('.release-update-actions');
  });

  it('normalizes Git confirmation danger actions into compact risk rows instead of generic danger-zone piles', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const className of ['git-confirmation-risk-row', 'git-confirmation-risk-copy', 'git-confirmation-risk-meta', 'git-confirmation-risk-rail']) {
      expect(source).toContain(className);
    }
    expect(source).not.toContain('<section className="danger-zone">');
    expect(css).toContain('高风险确认列表最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.git-confirmation-risk-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*380px\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.git-confirmation-risk-rail\s*\{[\s\S]*justify-content:\s*flex-end/);
    expect(css).not.toContain('.macos-ai-app .danger-zone');
    expect(css).not.toContain('.danger-zone > button');
  });

  it('removes generic danger-zone class from Git and Runtime high-risk sections', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('danger-zone');
    expect(css).not.toContain('danger-zone');
    expect(source).toContain('git-confirmation-risk-list git-confirmation-row-list');
    expect(source).toContain('runtime-generic-shell-risk-list runtime-generic-shell-row-list');
    expect(css).toContain('高风险确认列表最终覆盖');
  });

  it('removes evidence-row from global settings runtime and release summary rows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    for (const requiredClass of [
      'settings-runtime-cli-state-row',
      'settings-runtime-default-state-row',
      'settings-runtime-concurrency-state-row',
      'settings-runtime-timeout-state-row',
      'settings-runtime-confirmation-policy-row',
      'settings-release-signing-state-row',
      'settings-release-notarization-state-row',
      'settings-release-cask-state-row',
    ]) {
      expect(source).toContain(requiredClass);
    }
    expect(source).not.toContain('<NativeSettingsPane label="Runtime 执行设置" className="deep-settings-pane runtime-settings-pane">\n                    <div className="evidence-row">');
    expect(source).not.toContain('<NativeSettingsPane label="发布与签名" className="deep-settings-pane release-settings-pane">\n                    <div className="evidence-row">');
    expect(css).toContain('全局设置摘要行去 evidence-row 最终覆盖');
    expect(compactCss).toMatch(/\.macos-ai-app \.deep-settings-pane > :where\(\s*\.settings-config-row,[^)]*\.settings-runtime-confirmation-policy-row,[^)]*\.settings-release-cask-state-row,[^)]*\.settings-data-portability-row\s*\)/);
    expect(css).not.toContain('.native-settings-pane > .evidence-row');
    expect(css).not.toContain('.native-settings-pane > :where(.native-control-row, .settings-config-row, .evidence-row');
  });

  it('removes the remaining label wrapped controls from runtime filters and global settings rows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const labelLines = source.split('\n').filter((line) => line.includes('<label'));

    expect(labelLines).toEqual([]);
    for (const requiredClass of ['runtime-session-filter-control-row', 'runtime-session-filter-toggle-row', 'settings-config-row', 'settings-inline-field', 'settings-sensitive-field', 'git-settings-field-row']) {
      expect(source).toContain(requiredClass);
    }
    expect(source).not.toContain('<label className="native-switch"');
    expect(source).not.toContain('<label className="settings-row-field">');
    expect(source).not.toContain('<label>\n                      默认 Adapter');
    expect(source).not.toContain('<label>\n                      分支名');
    expect(css).toContain('Runtime 会话筛选控件行最终覆盖');
    expect(css).toContain('全局设置 label 清理最终覆盖');
    expect(css).not.toContain('.runtime-session-filter-row label');
    expect(css).not.toContain('.settings-row-field label');
    expect(css).not.toContain('.settings-row-field:where(label)');
  });

  it('removes stacked field shells from runtime advanced settings so inputs stay in explicit product rows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('settings-stacked-fields');
    expect(css).not.toContain('settings-stacked-fields');
    for (const className of ['settings-runtime-advanced-field-list', 'settings-runtime-shell-field', 'settings-runtime-env-field']) {
      expect(source).toContain(className);
    }
    expect(css).toContain('Runtime 高级参数双字段行最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.settings-runtime-advanced-field-list\s*\{[\s\S]*grid-template-columns:\s*minmax\(160px,\s*1fr\) minmax\(220px,\s*1\.35fr\)/);
    expect(css).toContain('Runtime 高级参数窄屏防漂移最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.settings-runtime-advanced-field-list > small\s*\{[\s\S]*grid-column:\s*1 \/\s*-1/);
    expect(css).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*\.macos-ai-app \.settings-runtime-advanced-field-list\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('normalizes the general desktop notification switch into an explicit control instead of a label wrapper', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const className of ['settings-switch-control', 'settings-switch-copy', 'settings-switch-state', 'native-switch-input', 'native-switch-track']) {
      expect(source).toContain(className);
      expect(html).toContain(className);
    }
    expect(html).toContain('已启用');
    expect(source).not.toContain('<label className="native-switch"');
    expect(css).toContain('通用设置开关最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.settings-switch-control\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.settings-switch-state\s*\{[\s\S]*border-radius:\s*999px/);
  });

  it('renders project configuration drawer as a complete compact row list instead of a partial loose form', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialProjectConfig={createProjectConfig()}
        initialProjectDatabaseSecret={{
          connectionName: 'local-sqlite',
          password: { configured: true, label: 'Saved securely' },
        }}
      />,
    );
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('project-config-row-list');
    for (const label of [
      '默认 AI 模型',
      '默认工作模式',
      '默认任务提示',
      '扫描忽略规则',
      '索引范围',
      '主语言',
      '附加语言',
      '包管理器',
      '清单路径',
      '数据库连接名',
      '结构定义路径',
      'Telegram 别名',
      '允许 Shell',
      '允许 Git 写操作',
      '保存项目配置',
    ]) {
      expect(html).toContain(label);
    }
    for (const leakedCopy of ['Schema 路径', '未设置 Schema 路径', '本机 Keychain', '保存到 Keychain', '远程 schema']) {
      expect(html).not.toContain(leakedCopy);
    }
    expect(html).toContain('密码已安全保存');
    expect(html).not.toContain('Saved securely');
    expect(html).toContain('密码仍走本机钥匙串');
    expect(html).toContain('密码只保存在本机钥匙串');
    expect(html).not.toContain('数据库连接配置</span>');
    expect(html).not.toContain('安全策略：允许 Shell');
    expect(css).toContain('项目配置抽屉最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-config-row-list\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.project-config-setting-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*360px\)/);
  });

  it('adapts the project configuration drawer by drawer width instead of stretching a desktop form', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialProjectConfig={{
          ...createProjectConfig(),
          defaultTaskPrompt: '这是一段非常长的项目默认任务提示，用于证明项目设置抽屉不能在普通窗口宽度下把文本域和输入框裁切到右侧屏幕外。',
          scan: { ignoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage', 'very-long-generated-directory-name'], indexScope: 'project' },
          dependencies: {
            packageManagers: ['pnpm'],
            manifestPaths: ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.json', 'apps/desktop/package.json'],
          },
        }}
      />,
    );
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const compactCss = css.replace(/\s+/g, ' ');

    expect(html).toContain('class="workspace-drawer project-drawer"');
    expect(html).toContain('project-config-row-list');
    expect(css).toContain('项目设置抽屉响应式返修最终覆盖');
    expect(compactCss).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app:has\(\.project-drawer\)\s*\{[^}]*--zeus-drawer-inline-size:\s*min\(760px,\s*calc\(100vw - 236px - 24px\)\)/);
    expect(compactCss).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.workspace-drawer\.project-drawer\s*\{[^}]*container-name:\s*zeus-project-drawer[^}]*container-type:\s*inline-size/);
    expect(compactCss).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.project-drawer \.workspace-drawer-chrome strong\s*\{[^}]*clip-path:\s*inset\(50%\)/);
    expect(compactCss).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.project-drawer \.workspace-drawer-close-button\s*\{[^}]*font-size:\s*0/);
    expect(compactCss).toMatch(/\.workspace-drawer-portal-root\.macos-ai-app \.project-drawer \.project-config-setting-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(240px,\s*320px\)/);
    expect(compactCss).toMatch(/@container zeus-project-drawer \(max-width:\s*680px\)\s*\{[^@]*\.project-drawer \.project-config-setting-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(compactCss).toMatch(/@container zeus-project-drawer \(max-width:\s*680px\)\s*\{[^@]*\.project-drawer \.project-config-setting-field > :where\(input,\s*select,\s*textarea,\s*\.zeus-select\)\s*\{[^}]*inline-size:\s*100%/);
  });

  it('renders the project settings workspace and config drawer in the selected app language', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialMainNavTarget="projects"
        initialAppShellSettings={createAppShellSettings('en-US')}
        initialProjectConfig={createProjectConfig()}
        initialProjectDatabaseSecret={{
          connectionName: 'local-sqlite',
          password: { configured: true, label: '已安全保存' },
        }}
      />,
    );
    const projectSettingsStart = html.indexOf('workspace-view-project-settings');
    const projectSettingsHtml = html.slice(projectSettingsStart);

    expect(projectSettingsStart).toBeGreaterThanOrEqual(0);
    for (const expectedCopy of [
      'Project settings',
      'Project configuration',
      'Current configuration',
      'Default AI model',
      'The real AI Runtime model used by new tasks. Zeus does not fake availability.',
      'Default work mode',
      'Controls whether new tasks start in plan, develop, review, or debug.',
      'Default task prompt',
      'Scan ignore rules',
      'Index scope',
      'Whole project',
      'src only',
      'Custom',
      'Primary language',
      'Additional languages',
      'Package managers',
      'Manifest paths',
      'Database connection name',
      'Only stores the connection label. Passwords stay in the local Keychain.',
      'Schema paths',
      'Telegram alias',
      'Allow Shell',
      'Allow Git writes',
      'Database',
      'Password status',
      'Saved securely',
      'Passwords stay in the local Keychain and are never shown in the UI.',
      'Save project configuration',
    ]) {
      expect(projectSettingsHtml).toContain(expectedCopy);
    }
    for (const removedInnerProjectListCopy of ['Project list', 'Project search and create', 'Search projects', 'Name or local path']) {
      expect(projectSettingsHtml).not.toContain(removedInnerProjectListCopy);
    }
    for (const leakedCopy of [
      '项目设置',
      '项目列表',
      '项目搜索与创建',
      '搜索项目',
      '名称或本地路径',
      '项目配置',
      '当前配置',
      '待读取',
      '默认 AI 模型',
      '新任务默认使用的真实 AI Runtime 模型',
      '默认工作模式',
      '控制新任务进入 plan',
      '默认任务提示',
      '扫描忽略规则',
      '索引范围',
      '整个项目',
      '仅 src',
      '自定义',
      '主语言',
      '附加语言',
      '已安全保存',
      '包管理器',
      '清单路径',
      '数据库连接名',
      '仅保存连接标识',
      '结构定义路径',
      'Telegram 别名',
      '允许 Shell',
      '允许 Git 写操作',
      '密码状态',
      '密码只保存在本机钥匙串',
      '保存项目配置',
    ]) {
      expect(projectSettingsHtml).not.toContain(leakedCopy);
    }
  });

  it('normalizes project config fields into explicit setting rows instead of direct label stacks', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialProjectConfig={createProjectConfig()} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('project-config-setting-row');
    expect(html).toContain('project-config-setting-copy');
    expect(html).toContain('project-config-setting-field');
    for (const label of ['默认 AI 模型', '默认工作模式', '默认任务提示', '扫描忽略规则', '索引范围', '允许 Shell', '允许 Git 写操作']) {
      expect(html).toContain(label);
    }
    expect(source).not.toContain('className="drawer-section edit-form project-config-row-list"');
    expect(source).not.toContain('<label className="project-config-toggle-row">');
    expect(source).not.toContain('<span>默认 AI 模型</span>');
    expect(css).toContain('项目配置字段行最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-config-setting-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*360px\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-config-setting-field\s*\{[\s\S]*display:\s*grid/);
  });

  it('normalizes project edit drawer actions and delete confirmation into a compact row list', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('project-edit-row-list');
    expect(source).toContain('project-edit-command-rail');
    expect(source).toContain('project-edit-danger-row');
    expect(source).toContain('projectEditCopy.deleteHelp');
    expect(source).not.toContain('className="drawer-section edit-form" aria-label="项目编辑表单"');
    expect(css).toContain('项目编辑抽屉最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-edit-row-list\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.project-edit-setting-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*360px\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-edit-danger-row\s*\{[\s\S]*background:\s*var\(--zeus-product-danger-bg\)/);
  });

  it('normalizes project edit fields into explicit setting rows instead of edit-form label stacks', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('project-edit-setting-row');
    expect(source).toContain('project-edit-setting-copy');
    expect(source).toContain('project-edit-setting-field');
    for (const copyKey of ['nameTitle', 'pathTitle', 'descriptionTitle', 'save', 'deleteTitle', 'confirmDelete']) {
      expect(source).toContain(`projectEditCopy.${copyKey}`);
    }
    expect(source).toContain('{projectEditCopy.deleteTitle}');
    expect(source).not.toContain('className="drawer-section edit-form project-edit-row-list"');
    expect(source).not.toMatch(/>\s*删除项目\s*<\/button>/);
    for (const hardcodedProjectEditCopy of [
      'aria-label="项目编辑表单"',
      'aria-label="当前项目"',
      'aria-label="项目名称"',
      'aria-label="项目路径"',
      'aria-label="项目描述"',
      'aria-label="保存项目编辑"',
      'aria-label="删除项目"',
      '>当前项目<',
      '>项目名称<',
      '>项目路径<',
      '>项目描述<',
      '>保存项目变更<',
      '>删除项目<',
      '>确认删除项目<',
    ]) {
      expect(source).not.toContain(hardcodedProjectEditCopy);
    }
    expect(css).toContain('项目编辑字段行最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-edit-setting-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*360px\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-edit-setting-field\s*\{[\s\S]*display:\s*grid/);
  });

  it('removes evidence-row from project edit and config drawer summary rows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('project-edit-identity-row');
    expect(source).toContain('project-config-state-row');
    expect(source).not.toContain('evidence-row project-edit-summary-row');
    expect(source).not.toContain('evidence-row project-config-summary-row');
    expect(css).toContain('项目编辑与配置摘要行去 evidence-row 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-config-row-list > :where\(\s*\.project-config-setting-row,\s*\.project-config-state-row,\s*\.project-config-command-rail\)/);
    expect(css).toMatch(/\.macos-ai-app \.project-edit-row-list > :where\(\s*\.project-edit-setting-row,\s*\.project-edit-identity-row,\s*\.project-edit-command-rail,\s*\.project-edit-danger-row\)/);
    expect(css).not.toContain('.project-config-row-list > :where(.project-config-setting-row, .evidence-row');
    expect(css).not.toContain('.project-edit-row-list > :where(.project-edit-setting-row, .evidence-row');
    // project drawer actions stale guard
    expect(source).not.toContain('project-config-actions');
    expect(source).not.toContain('project-edit-actions');
    expect(source).not.toContain('project-edit-danger-actions');
    expect(css).not.toContain('.project-config-actions');
    expect(css).not.toContain('.project-edit-actions');
    expect(css).not.toContain('.project-edit-danger-actions');
  });

  it('normalizes git diff drawer hunks and high-risk inputs into compact review rows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('git-diff-drawer-workbench');
    expect(source).toContain('git-file-change-list');
    expect(source).toContain('git-hunk-review-row');
    expect(source).toContain('git-risk-row-list');
    expect(source).toContain('git-confirmation-row-list');
    expect(source).not.toContain('className="edit-form" aria-label="Git 高风险参数"');
    expect(css).toContain('Git Diff 抽屉最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.git-diff-drawer-workbench\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.git-hunk-review-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.git-risk-input-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*360px\)/);
  });

  it('normalizes git risk and confirmation inputs into explicit review rows instead of label stacks', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('git-risk-input-row');
    expect(source).toContain('git-risk-input-copy');
    expect(source).toContain('git-risk-input-field');
    expect(source).toContain('git-confirmation-message-row');
    expect(source).toContain('git-confirmation-state-row');
    expect(source).not.toContain('className="edit-form git-risk-row-list"');
    expect(source).not.toContain('<span>新分支名称</span>');
    expect(source).not.toContain('<span>提交说明</span>');
    expect(css).toContain('Git 高风险字段行最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.git-risk-input-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*360px\)/);
    expect(css).toMatch(/\.macos-ai-app \.git-risk-input-field\s*\{[\s\S]*display:\s*grid/);
    expect(css).toMatch(/\.macos-ai-app \.git-confirmation-state-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  });

  it('removes evidence-row from git diff worktree and rejected confirmation states', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('git-worktree-state-row');
    expect(source).toContain('git-confirmation-rejected-row');
    expect(source).not.toContain('className="evidence-row" aria-label="Git 工作区状态"');
    expect(source).not.toContain('<div className="evidence-row">\n                                <strong>已拒绝 Git 确认</strong>');
    expect(css).toContain('Git Diff 状态行去 evidence-row 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.git-diff-drawer-workbench > :where\(\s*\.drawer-header-row,\s*\.git-worktree-state-row,\s*\.git-file-change-list/);
    expect(css).toMatch(/\.macos-ai-app \.git-confirmation-row-list > :where\(\s*\.git-risk-input-row,\s*\.git-confirmation-state-row,\s*\.git-confirmation-rejected-row/);
    expect(css).not.toContain('.git-diff-drawer-workbench > :where(.drawer-header-row, .evidence-row');
    expect(css).not.toContain('.git-confirmation-row-list > :where(.git-risk-input-row, .git-confirmation-state-row, .task-controls, .evidence-row');
    expect(css).not.toContain('.git-confirmation-row-list > .evidence-row');
    // git actions stale guard
    expect(source).not.toContain('git-hunk-actions');
    expect(source).not.toContain('git-confirmation-actions');
    expect(source).not.toContain('git-confirmation-risk-actions');
    expect(css).not.toContain('.git-hunk-actions');
    expect(css).not.toContain('.git-confirmation-actions');
    expect(css).not.toContain('.git-confirmation-risk-actions');
  });

  it('normalizes runtime drawer status adapters sessions logs and shell confirmation into compact rows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('runtime-status-row-list');
    expect(source).toContain('runtime-adapter-list');
    expect(source).toContain('runtime-generic-shell-row-list');
    expect(source).toContain('runtime-session-list');
    expect(source).toContain('runtime-session-row');
    expect(source).toContain('runtime-log-workbench');
    expect(source).not.toContain('runtime-log-panel');
    expect(css).not.toContain('runtime-log-panel');
    expect(source).not.toContain('className="edit-form danger-zone" aria-label="Generic shell 高风险确认"');
    expect(css).toContain('Runtime 抽屉最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.runtime-workbench\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.runtime-session-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
    expect(css).toMatch(/\.macos-ai-app \.runtime-generic-shell-input-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*360px\)/);
  });

  it('normalizes runtime generic shell confirmation into explicit risk rows instead of label stacks', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('runtime-generic-shell-input-row');
    expect(source).toContain('runtime-generic-shell-copy');
    expect(source).toContain('runtime-generic-shell-field');
    expect(source).toContain('runtime-generic-shell-state-row');
    expect(source).not.toContain('className="edit-form danger-zone runtime-generic-shell-row-list"');
    expect(source).not.toContain('<span>Generic shell 命令</span>');
    expect(source).not.toContain('<span>高危命令确认短语</span>');
    expect(css).not.toContain('.runtime-generic-shell-row-list > label');
    expect(css).toContain('Runtime Generic shell 字段行最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.runtime-generic-shell-input-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*360px\)/);
    expect(css).toMatch(/\.macos-ai-app \.runtime-generic-shell-field\s*\{[\s\S]*display:\s*grid/);
    expect(css).toMatch(/\.macos-ai-app \.runtime-generic-shell-state-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  });

  it('removes evidence-row from runtime status and generic shell state rows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('runtime-capability-state-row');
    expect(source).toContain('runtime-shell-preview-row');
    expect(source).toContain('runtime-generic-shell-rejected-row');
    expect(source).not.toContain('evidence-row runtime-status-row');
    expect(source).not.toContain('<div className="evidence-row">\n                            <strong>命令预览</strong>');
    expect(source).not.toContain('<div className="evidence-row">\n                              <strong>已拒绝 Generic shell 确认</strong>');
    expect(css).toContain('Runtime 状态行去 evidence-row 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.runtime-status-row-list > \.runtime-capability-state-row\s*\{/);
    expect(css).toMatch(
      /\.macos-ai-app \.runtime-generic-shell-row-list > :where\(strong,\s*\.runtime-generic-shell-input-row,\s*\.runtime-generic-shell-state-row,\s*\.runtime-shell-preview-row,\s*\.runtime-generic-shell-rejected-row,\s*\.runtime-generic-shell-command-rail\)/,
    );
    expect(css).not.toContain('.runtime-generic-shell-row-list > .evidence-row');
    expect(css).not.toContain('.runtime-generic-shell-row-list > :where(strong, .runtime-generic-shell-input-row, .runtime-generic-shell-state-row, .evidence-row');
  });

  it('removes timeline styling from runtime adapters and sessions in favor of compact runtime rows', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('runtime-adapter-row-list');
    expect(source).toContain('runtime-adapter-row');
    expect(source).toContain('runtime-session-row-list');
    expect(source).toContain('runtime-session-empty-row');
    expect(source).not.toContain('className="timeline runtime-adapter-list"');
    expect(source).not.toContain('className="timeline runtime-session-list"');
    expect(source).not.toContain('className="timeline-event runtime-adapter-row"');
    expect(source).not.toContain('className="timeline-event runtime-session-row"');
    expect(css).toContain('Runtime 列表去时间线最终覆盖');
    expect(css).not.toContain('.runtime-adapter-list.timeline');
    expect(css).not.toContain('.runtime-session-list.timeline');
    expect(css).toMatch(/\.macos-ai-app \.runtime-adapter-row-list\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.runtime-session-row-list\s*\{[\s\S]*gap:\s*0/);
  });

  it('renames runtime log action rows into an explicit command rail instead of generic action-row', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('runtime-log-action-row');
    expect(css).not.toContain('runtime-log-action-row');
    expect(source).toContain('runtime-log-command-rail');
    expect(css).toContain('Runtime 日志命令 rail 最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.runtime-log-command-rail\s*\{[\s\S]*justify-content:\s*flex-end/);
  });

  it('normalizes task template drawer into a compact template picker instead of plain object buttons', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).toContain('task-template-workbench');
    expect(source).toContain('task-template-list');
    expect(source).toContain('task-template-row');
    expect(source).toContain('task-template-copy');
    expect(source).toContain('task-template-command-rail');
    expect(source).toContain('task-template-empty-row');
    expect(source).not.toContain('task-template-actions');
    expect(css).not.toContain('.task-template-actions');
    expect(source).not.toContain('className="drawer-section" aria-label="任务模板"');
    expect(css).toContain('任务模板抽屉最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-template-workbench\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.task-template-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  });

  it('renames generic drawer sections into product drawer panes so drawers do not regress into card-like web sections', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" initialRuntimeStatus={createRuntimeStatus()} />);

    expect(source).toContain('product-drawer-pane');
    expect(css).toContain('.product-drawer-pane');
    expect(html).toContain('product-drawer-pane');
    expect(source).not.toContain('drawer-section');
    expect(css).not.toContain('drawer-section');
    expect(css).toMatch(/\.macos-ai-app \.product-drawer-pane\s*\{[\s\S]*display:\s*grid/);
  });

  it('removes compact-field naming from task filters so the task toolbar stays as explicit product rows', () => {
    const source = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('compact-field');
    expect(css).not.toContain('compact-field');
    expect(source).not.toContain('task-table-compact-toolbar');
    expect(source).toContain('task-table-primary-toolbar');
    expect(source).toContain('task-table-view-toolbar');
    expect(source).toContain('task-toolbar-search');
    expect(source).not.toContain('task-toolbar-select');
    expect(source).not.toContain('task-toolbar-tags');
    expect(source).not.toContain('task-table-more-menu-input');
    expect(source).not.toContain('task-table-more-menu-select');
    expect(source).not.toContain('props.copy.tagFilterAria');
    expect(source).not.toContain('props.copy.sortSelectAria');
    expect(css).not.toContain('task-toolbar-select');
    expect(css).not.toContain('task-toolbar-tags');
    expect(css).toContain('任务页多场景原型高还原最终覆盖');
  });

  it('renders archived project drawer copy and scan status in the selected app language', () => {
    const archivedProjects = [
      {
        id: 'project_archived_real',
        name: 'Archived Zeus',
        localPath: '/Users/david/hypha/archived-zeus',
        scanStatus: 'completed',
      },
    ];
    const enHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialArchivedProjects={archivedProjects} initialAppShellSettings={createAppShellSettings('en-US')} />);
    const zhHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialArchivedProjects={archivedProjects} initialAppShellSettings={createAppShellSettings('zh-CN')} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(enHtml).toContain('Archived projects');
    expect(enHtml).toContain('1 project can be restored');
    expect(enHtml).toContain('Restore project');
    expect(enHtml).toContain('Completed');
    expect(enHtml).not.toContain('归档项目');
    expect(enHtml).not.toContain('恢复项目');
    expect(enHtml).not.toContain('暂无可恢复项目');
    expect(enHtml).not.toContain('关闭Project panel');
    expect(enHtml).not.toContain('Project panel背景');
    expect(enHtml).not.toContain('>completed<');

    expect(zhHtml).toContain('归档项目');
    expect(zhHtml).toContain('1 个项目可恢复');
    expect(zhHtml).toContain('恢复项目');
    expect(zhHtml).toContain('已完成');
    expect(zhHtml).not.toContain('>completed<');

    expect(source).toContain('projectArchive: {');
    expect(source).toContain('formatProjectScanStatus');
    expect(source).toContain('copy={codeWorkspaceCopy.projectArchive}');
    expect(source).not.toContain('aria-label="归档项目"');
    expect(source).not.toContain('<strong>归档项目</strong>');
    expect(source).not.toContain('恢复项目</button>');
  });

  it('names project secondary surfaces as drawers instead of generic panels in both languages', () => {
    const enHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialProjectConfig={createProjectConfig()} initialAppShellSettings={createAppShellSettings('en-US')} />);
    const zhHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialProjectConfig={createProjectConfig()} initialAppShellSettings={createAppShellSettings('zh-CN')} />);

    expect(enHtml).toContain('aria-label="Project drawer"');
    expect(enHtml).toContain('aria-label="Project drawer backdrop"');
    expect(enHtml).toContain('Close project drawer');
    expect(enHtml).not.toContain('Project panel');
    expect(enHtml).not.toContain('Project panel backdrop');
    expect(enHtml).not.toContain('Close project panel');

    expect(zhHtml).toContain('aria-label="项目抽屉"');
    expect(zhHtml).toContain('aria-label="项目抽屉背景"');
    expect(zhHtml).toContain('关闭项目抽屉');
    expect(zhHtml).not.toContain('项目二级面板');
  });

  it('aligns shell language metadata and core dropdown labels with the selected app language', () => {
    const enSessionSnapshot = createSnapshot();
    enSessionSnapshot.tasks[0] = { ...enSessionSnapshot.tasks[0], title: 'Bug conversation', tags: ['backend'] };
    const zhHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);
    const enHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" initialAppShellSettings={createAppShellSettings('en-US')} />);
    const enSessionHtml = renderToStaticMarkup(<App snapshot={enSessionSnapshot} initialMainNavTarget="conversations" initialAppShellSettings={createAppShellSettings('en-US')} />);
    const enCodeHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" initialAppShellSettings={createAppShellSettings('en-US')} />);
    const enSettingsHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" initialAppShellSettings={createAppShellSettings('en-US')} />);
    const zhProjectConfigHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" initialProjectConfig={createProjectConfig()} />);
    const enProjectConfigHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" initialProjectConfig={createProjectConfig()} initialAppShellSettings={createAppShellSettings('en-US')} />);
    const zhGraphHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" initialGraphView={createGraphView()} />);
    const enGraphView = { ...createGraphView(), title: 'Zeus architecture' };
    const enGraphHtml = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialMainNavTarget="code-map"
        initialGraphView={enGraphView}
        initialGraphAnswer={{
          projectId: 'project_real',
          question: 'Where is the local server initialized?',
          answer: 'The local server starts from the renderer bridge.',
          sessionId: 'ai-session-real',
          sources: { nodes: enGraphView.nodes, edges: enGraphView.edges },
        }}
        initialGraphConversations={[
          {
            id: 'conversation_en_graph',
            projectId: 'project_real',
            taskId: null,
            sessionId: 'ai-session-real',
            title: 'Graph Q&A: local server',
            summary: 'Runtime answer from sourced graph facts',
            status: 'closed',
            createdAt: '2026-06-18T00:00:00.000Z',
            updatedAt: '2026-06-18T00:00:01.000Z',
            archived: false,
            messages: [
              {
                id: 'message_user_en',
                conversationId: 'conversation_en_graph',
                role: 'user',
                content: 'Where is the local server initialized?',
                source: 'graph_question',
                metadata: { projectId: 'project_real' },
                createdAt: '2026-06-18T00:00:00.000Z',
              },
              {
                id: 'message_assistant_en',
                conversationId: 'conversation_en_graph',
                role: 'assistant',
                content: 'The local server starts from the renderer bridge.',
                source: 'graph_answer',
                metadata: { sourceNodeIds: ['node_file'] },
                createdAt: '2026-06-18T00:00:01.000Z',
              },
            ],
          },
        ]}
        initialAppShellSettings={createAppShellSettings('en-US')}
      />,
    );

    expect(zhHtml).toContain('lang="zh-CN"');
    expect(zhHtml).toContain('data-language="zh-CN"');
    expect(zhHtml).toContain('task-table-status-segments');
    expect(zhHtml).toMatch(/task-table-status-segment[\s\S]*aria-pressed="true"[\s\S]*>全部<\/button>/);
    expect(zhHtml).toMatch(/task-table-status-segment[\s\S]*>待开始<\/button>/);
    expect(zhHtml).toMatch(/task-table-status-segment[\s\S]*>运行中<\/button>/);
    expect(zhHtml).toContain('：排序 标题 · 标签 全部');
    expect(zhHtml).toContain('task-table-more-settings-trigger');
    expect(zhHtml).not.toContain('aria-label="任务排序"');
    expect(zhHtml).not.toContain('aria-label="任务标签筛选"');
    expect(zhProjectConfigHtml).toMatch(zeusSelectOptionPattern('plan', '规划'));
    expect(zhProjectConfigHtml).toMatch(zeusSelectOptionPattern('develop', '开发'));
    expect(zhProjectConfigHtml).toMatch(zeusSelectOptionPattern('project', '整个项目'));
    expect(zhProjectConfigHtml).toMatch(zeusSelectOptionPattern('src', '仅 src'));
    expect(zhProjectConfigHtml).toMatch(zeusSelectOptionPattern('custom', '自定义'));
    expect(zhProjectConfigHtml).toMatch(/project-config-state-row[\s\S]*<span>开发<\/span>/);
    expect(zhGraphHtml).toMatch(zeusSelectOptionPattern('file', '文件'));
    expect(zhGraphHtml).toMatch(zeusSelectOptionPattern('declares', '声明'));
    expect(zhProjectConfigHtml).not.toContain('<option value="plan">plan</option>');
    expect(zhProjectConfigHtml).not.toContain('<option value="project">project</option>');
    expect(zhProjectConfigHtml).not.toContain('<option value="src">src</option>');
    expect(zhProjectConfigHtml).not.toContain('<option value="custom">custom</option>');
    expect(zhHtml).not.toContain('<button type="button" class="task-table-status-segment" aria-pressed="true">All</button>');
    expect(zhHtml).not.toContain('<button type="button" class="task-table-status-segment" aria-pressed="false">ready</button>');
    expect(zhHtml).not.toContain('<option value="title">Title</option>');
    expect(zhHtml).not.toContain('<option value="status">Status</option>');
    expect(zhHtml).not.toContain('<option value="updatedAt">Updated</option>');
    expect(zhGraphHtml).not.toContain('<option value="file">file</option>');
    expect(zhGraphHtml).not.toContain('<option value="declares">declares</option>');

    expect(enHtml).toContain('lang="en"');
    expect(enHtml).toContain('data-language="en-US"');
    expect(enHtml).toContain('task-table-status-segments');
    expect(enHtml).toMatch(/task-table-status-segment[\s\S]*aria-pressed="true"[\s\S]*>All<\/button>/);
    expect(enHtml).toMatch(/task-table-status-segment[\s\S]*>Ready<\/button>/);
    expect(enHtml).toMatch(/task-table-status-segment[\s\S]*>Running<\/button>/);
    expect(enHtml).toContain('View controls');
    expect(enHtml).toContain(': Sort Title · Tags All');
    expect(enHtml).toContain('task-table-more-settings-trigger');
    expect(enHtml).not.toContain('aria-label="Task sort"');
    expect(enHtml).not.toContain('aria-label="Task tag filter"');
    expect(enProjectConfigHtml).toMatch(zeusSelectOptionPattern('plan', 'Plan'));
    expect(enProjectConfigHtml).toMatch(zeusSelectOptionPattern('develop', 'Develop'));
    expect(enProjectConfigHtml).toMatch(zeusSelectOptionPattern('project', 'Whole project'));
    expect(enProjectConfigHtml).toMatch(zeusSelectOptionPattern('src', 'src only'));
    expect(enProjectConfigHtml).toMatch(zeusSelectOptionPattern('custom', 'Custom'));
    expect(enProjectConfigHtml).toMatch(/project-config-state-row[\s\S]*<span>Develop<\/span>/);
    expect(enGraphHtml).toMatch(zeusSelectOptionPattern('file', 'File'));
    expect(enGraphHtml).toMatch(zeusSelectOptionPattern('declares', 'Declares'));
    expect(enSettingsHtml).toMatch(zeusSelectOptionPattern('zh-CN', 'Simplified Chinese'));
    expect(enSettingsHtml).toMatch(zeusSelectOptionPattern('system', 'Follow system'));

    const enSidebarHtml = enHtml.slice(enHtml.indexOf('<aside class="zeus-sidebar'), enHtml.indexOf('</aside>') + '</aside>'.length);
    for (const expectedCopy of ['New chat', 'Search', 'Projects', 'Tasks', 'Code', 'Sessions', 'Current', 'Settings']) {
      expect(enSidebarHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of ['新对话', '搜索', '项目', '任务', '代码', '会话', '当前', '设置']) {
      expect(enSidebarHtml).not.toContain(leakedCopy);
    }

    const enTaskFilterHtml = enHtml.slice(enHtml.indexOf('task-filter-workbench'), enHtml.indexOf('task-list-workbench'));
    for (const expectedCopy of ['Search tasks', 'Task status', 'All', 'Ready', 'Running', 'View controls', 'Sort', 'Title', 'Tags', 'More', 'New task']) {
      expect(enTaskFilterHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of ['搜索任务', '标题或描述', '只看某类进度', '任务排序', '标签筛选', '筛选', '新对话']) {
      expect(enTaskFilterHtml).not.toContain(leakedCopy);
    }
    expect(enTaskFilterHtml).not.toContain('aria-label="Task sort"');
    expect(enTaskFilterHtml).not.toContain('aria-label="Task tag filter"');
    expect(enTaskFilterHtml).not.toMatch(zeusSelectOptionPattern('status', 'Status'));
    expect(enTaskFilterHtml).not.toMatch(zeusSelectOptionPattern('updatedAt', 'Updated'));
    expect(enTaskFilterHtml).not.toContain('<option value="">全部</option>');
    expect(enTaskFilterHtml).not.toContain('<option value="title">标题</option>');
    expect(enTaskFilterHtml).not.toContain('<option value="updatedAt">更新时间</option>');

    for (const expectedCopy of ['Task management', 'Search tasks', 'Status', 'Tags', 'AI execution', 'New task']) {
      expect(enHtml).toContain(expectedCopy);
    }
    for (const collapsedCopy of ['Current status', 'Task request', 'Task events', 'Create app-server session', 'Mark complete', 'Cancel task', 'Request follow-up', 'Save request', 'Code changes']) {
      expect(enHtml).not.toContain(collapsedCopy);
    }
    for (const leakedCopy of ['任务管理', '当前状态', '任务要求', '任务事件', '创建 app-server 会话', '标记完成', '取消任务', '要求后续变更', '保存要求']) {
      expect(enHtml).not.toContain(leakedCopy);
    }

    for (const expectedCopy of ['Conversation workspace', 'Send a message', 'Permission mode', 'Bug conversation']) {
      expect(enSessionHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of [
      'Environment',
      'AI CLI not configured',
      'Telegram disabled',
      'Voice input not enabled',
      '外部集成状态',
      'AI CLI 未配置',
      'Telegram 未启用',
      '当前对话',
      '任务事件与对话消息',
      '用户要求',
      '等待下一步',
      '推送到 CLI 对话',
      'Send to conversation',
      '要求后续变更',
      '发送',
      '运行环境',
      '上下文',
      '代码变更',
      '模板',
    ]) {
      expect(enSessionHtml).not.toContain(leakedCopy);
    }

    const enCodeWorkbenchHtml = enCodeHtml.slice(enCodeHtml.indexOf('project-repository-workbench'), enCodeHtml.indexOf('workspace-drawer-portal-root'));
    for (const expectedCopy of ['Repository status', 'Local path', 'Scan', 'Git', 'Graph', 'Code graph', 'Scan project', 'Open graph', 'View changes', 'More project actions', 'Edit', 'Configure']) {
      expect(enCodeWorkbenchHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of ['当前项目状态', '当前仓库', '仓库状态', '本地路径', '代码图谱', '等待真实扫描', '扫描项目', '打开图谱', '查看变更', '更多项目操作', '编辑', '配置']) {
      expect(enCodeWorkbenchHtml).not.toContain(leakedCopy);
    }

    const enGraphDrawerStart = enGraphHtml.indexOf('code-map-workbench');
    const enGraphDrawerEnd = enGraphHtml.indexOf('workspace-drawer-portal-root', enGraphDrawerStart);
    const enGraphDrawerHtml = enGraphHtml.slice(enGraphDrawerStart, enGraphDrawerEnd > enGraphDrawerStart ? enGraphDrawerEnd : undefined);
    for (const expectedCopy of [
      'Code graph view',
      'Code graph',
      'Real source',
      'Current view',
      'Architecture',
      'Module',
      'Table relationships',
      'Module detail',
      'API sequence',
      'Module flow',
      'Method logic',
      'Search and filters',
      'Locate nodes first',
      'Graph Q&amp;A',
      'Ask from sources',
      'Nodes and edges',
      'Review source list',
      'Search node or field',
      'Node name, field, or source path',
      'Node type',
      'Edge type',
      'Minimum confidence',
      'Search',
      'Ask the graph',
      'Question',
      'Graph answer',
      'Runtime session ai-session-real',
      'Q&amp;A history',
      'Search history',
      'Real Q&amp;A records only',
      'View archived',
      '1 real Q&amp;A',
      'View detail',
      'Create task from Q&amp;A',
      'Archive history',
      'Previous page',
      'Next page',
      'Active',
      '2 messages',
      'Assistant answer',
      'User question',
      'Source: graph answer',
      'Source: graph question',
      'Mermaid export',
      'Mermaid export commands',
      'Mermaid preview',
      'Generate Mermaid preview',
      'Export Mermaid source',
      'Preview not generated',
      'Graph entities',
      'Graph nodes',
      '1 real node',
      'Create task from node',
      'Open source',
      'Hide node',
      'Open node menu',
      'Node action menu',
      'Inspect detail',
      'Ask this node',
      'Generate sequence',
      'Generate flow',
      'Expand one hop',
      'Expand two hops',
      'Graph edges',
      '1 real edge',
    ]) {
      expect(enGraphDrawerHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of [
      '代码图谱视图',
      '代码图谱',
      '真实来源',
      '当前视图',
      '系统架构图',
      '模块图',
      '表关系图',
      '模块详情图',
      '接口时序图',
      '模块流程图',
      '方法逻辑图',
      '搜索与筛选',
      '先定位节点',
      '图谱问答',
      '基于来源提问',
      '节点与边',
      '查看来源清单',
      '搜索节点/字段',
      '按节点名、字段或来源路径定位',
      '筛选类型',
      '边类型',
      '最低置信度',
      '向图谱提问',
      '围绕当前真实图谱提问',
      '图谱问答回答',
      '来源不足，未启动 Runtime 会话',
      '图谱问答历史',
      '搜索历史',
      '只查真实问答记录',
      '查看归档',
      '条真实问答',
      '查看详情',
      '从问答创建任务',
      '归档历史',
      '上一页',
      '下一页',
      '未归档',
      '条消息',
      'AI 回答',
      '用户问题',
      'graph_answer',
      'graph_question',
      'Mermaid 导出',
      'Mermaid 导出命令',
      'Mermaid 预览',
      '生成 Mermaid 预览',
      '导出 Mermaid 源码',
      '预览未生成',
      '节点与边列表',
      '图谱节点与边来源',
      '图谱节点',
      '个真实节点',
      '从节点创建任务',
      '打开源码',
      '隐藏节点',
      '打开节点菜单',
      '节点操作菜单',
      '查看详情',
      '提问此节点',
      '生成时序图',
      '生成流程图',
      '展开一跳',
      '展开二跳',
      '图谱边',
      '条真实边',
    ]) {
      expect(enGraphDrawerHtml).not.toContain(leakedCopy);
    }
  });

  it('renders ZeusSelect bottom listboxes instead of native select popups or web gradient arrows', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const zeusSelectSource = readFileSync(new URL('../src/renderer/ZeusSelect.tsx', import.meta.url), 'utf8');
    const baseSelectBlock = css.match(/\.macos-ai-app select\s*\{[\s\S]*?\}/)?.[0] ?? '';
    const contextualSelectBlock = css.match(/\.macos-ai-app \.graph-search-control-grid select,[\s\S]*?\.macos-ai-app \.settings-row-field select\s*\{[\s\S]*?\}/)?.[0] ?? '';

    expect(`${appSource}\n${taskSource}`).not.toContain('<select');
    expect(`${appSource}\n${taskSource}`).toContain('<ZeusSelect');
    expect(zeusSelectSource).toContain('data-zeus-select-placement="bottom"');
    expect(zeusSelectSource).toContain('role="combobox"');
    expect(zeusSelectSource).toContain('role="listbox"');
    expect(zeusSelectSource).toContain('role="option"');
    expect(css).toContain('ZeusSelect macOS 无灰色右侧 rail 最终覆盖');
    expect(css).toContain('ZeusSelect 下方弹层最终覆盖');
    expect(css).toContain('--zeus-select-caret-icon: url("data:image/svg+xml');
    expect(baseSelectBlock).toMatch(/background-image:\s*var\(--zeus-select-caret-icon\)/);
    expect(baseSelectBlock).not.toContain('linear-gradient(135deg');
    expect(baseSelectBlock).not.toContain('linear-gradient(225deg');
    expect(baseSelectBlock).not.toContain('linear-gradient(var(--zeus-select-caret-rail)');
    expect(baseSelectBlock).not.toContain('var(--zeus-select-caret-rail)');
    expect(baseSelectBlock).toContain('background-position: right 13px center');
    expect(contextualSelectBlock).toMatch(/background-image:\s*var\(--zeus-select-caret-icon\)/);
    expect(contextualSelectBlock).not.toContain('linear-gradient(135deg');
    expect(contextualSelectBlock).not.toContain('linear-gradient(225deg');
    expect(contextualSelectBlock).not.toContain('linear-gradient(var(--zeus-select-caret-rail)');
    expect(contextualSelectBlock).not.toContain('var(--zeus-select-caret-rail)');
    expect(zeusSelectSource).toContain('zeus-select-search-input');
    expect(zeusSelectSource).toContain('zeus-select-option-check');
    expect(css).toContain('ZeusSelect Codex 式浮层最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-popover\s*\{[\s\S]*inset-block-start:\s*calc\(100% \+ 6px\)/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-popover\s*\{[\s\S]*transform-origin:\s*top center/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-popover\s*\{[\s\S]*box-shadow:\s*0 24px 70px/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-search-row\s*\{[\s\S]*min-block-size:\s*32px/);
    expect(css).toMatch(/\.macos-ai-app \.zeus-select-option-check\s*\{[\s\S]*opacity:\s*0/);
  });

  it('renders the global general settings page in the selected app language without Chinese leakage', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" initialAppShellSettings={createAppShellSettings('en-US')} />);
    const settingsStart = html.indexOf('workspace-view-settings');
    const settingsHtml = html.slice(settingsStart);

    expect(settingsStart).toBeGreaterThanOrEqual(0);
    for (const expectedCopy of [
      'Settings',
      'Settings sections',
      'Back to app',
      'Search settings...',
      'Personal',
      'Work mode',
      'Choose how many technical details Zeus shows by default',
      'Permissions',
      'General',
      'AI CLI / Runtime',
      'Telegram',
      'Security &amp; Keychain',
      'Git confirmation',
      'Release &amp; updates',
      'Cache &amp; data',
      'General settings',
      'App language',
      'Choose the interface language Zeus uses',
      'Appearance',
      'Follow system, light, or dark',
      'Desktop notifications',
      'Local task, Runtime, and Telegram status changes can notify you',
      'Enabled',
      'Notifications appear locally',
      'Save settings',
      'Only saves local interface preferences. Projects and Runtime sessions are unchanged.',
      'Save',
    ]) {
      expect(settingsHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of [
      'Current category',
      '设置分类',
      '当前分类',
      '返回应用',
      '个人',
      '工作模式',
      '权限',
      '通用',
      '安全与钥匙串',
      'Git 确认',
      '发布与更新',
      '缓存与数据',
      '通用设置',
      '应用语言',
      '选择 Zeus 使用的界面语言',
      '深色/浅色模式',
      '界面跟随系统',
      '桌面通知',
      '本机任务',
      '已启用',
      '已关闭',
      '不会主动打扰',
      '保存设置',
      '只保存当前分类',
    ]) {
      expect(settingsHtml).not.toContain(leakedCopy);
    }
  });

  it('renders the global runtime settings page in the selected app language without Chinese control leakage', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialMainNavTarget="settings"
        initialAppShellSettings={createAppShellSettings('en-US')}
        initialRuntimeAdapters={createRuntimeAdapters()}
        initialRuntimeSettings={createRuntimeSettings()}
        initialRuntimeStatus={createRuntimeStatus()}
      />,
    );
    const runtimeStart = html.indexOf('settings-product-pane" aria-label="AI CLI / Runtime');
    const runtimeHtml = html.slice(runtimeStart);

    expect(runtimeStart).toBeGreaterThanOrEqual(0);
    for (const expectedCopy of [
      'Runtime execution settings',
      'Runtime CLI status',
      'Waiting for configuration',
      'Default Runtime Adapter',
      'Used first when starting a new Runtime session.',
      'Current default',
      'Current default: OpenAI Codex CLI',
      'Default Adapter model',
      'Only writes local Runtime configuration. It does not claim the external CLI is signed in.',
      'Default arguments',
      'Parsed as real CLI arguments separated by spaces.',
      'CLI path',
      'Optional local executable path. Leave empty to detect from the system PATH.',
      'Project concurrency limit',
      'Global concurrency limit: 2',
      'Execution timeout',
      '900 seconds',
      'Log retention: keep 14 days',
      'Auto-confirm policy',
      'Low risk only',
      'Does not bypass high-risk confirmations such as Generic shell, Git writes, or file deletion.',
      'Execution timeout seconds',
      'Advanced Runtime arguments',
      'Shell path',
      'Terminal environment variables',
      'Environment variables enter the real child process. Zeus does not verify the CLI is installed or signed in.',
      'Start as login shell',
      'Save default Adapter',
    ]) {
      expect(runtimeHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of [
      'Current category',
      '当前分类',
      'Runtime 执行设置',
      'Runtime CLI 检测状态',
      '等待配置',
      '默认 Adapter',
      '默认 Runtime Adapter',
      '启动新 Runtime 会话时优先使用',
      '当前默认',
      '默认 Adapter 模型',
      '仅写入本机 Runtime 配置',
      '默认参数',
      '按空格解析为真实 CLI 参数',
      'CLI 路径',
      '可选本机可执行文件路径',
      '项目并发上限',
      '全局并发上限',
      '执行超时',
      '日志保留策略',
      '自动确认策略',
      '仅低风险',
      '不会绕过 Generic shell',
      '执行超时秒数',
      '高级 Runtime 参数',
      'Shell 路径',
      '终端环境变量',
      '环境变量会进入真实子进程',
      '作为 login shell 启动',
      '保存默认 Adapter',
    ]) {
      expect(runtimeHtml).not.toContain(leakedCopy);
    }
  });

  it('localizes the runtime adapter fallback option and action meta in Chinese settings instead of leaking raw adapter ids', () => {
    const zhHtml = renderToStaticMarkup(
      <App snapshot={createSnapshot()} initialMainNavTarget="settings" initialRuntimeAdapters={createRuntimeAdapters()} initialRuntimeSettings={createRuntimeSettings()} initialRuntimeStatus={createRuntimeStatus()} />,
    );
    const runtimeStart = zhHtml.indexOf('runtime-settings-pane');
    const runtimeEnd = zhHtml.indexOf('telegram-settings-pane', runtimeStart);
    const runtimeSettingsHtml = zhHtml.slice(runtimeStart, runtimeEnd > runtimeStart ? runtimeEnd : undefined);

    expect(runtimeStart).toBeGreaterThanOrEqual(0);
    expect(runtimeSettingsHtml).toMatch(zeusSelectOptionPattern('codex', 'OpenAI Codex CLI'));
    expect(runtimeSettingsHtml).toMatch(zeusSelectOptionPattern('generic', '通用 Shell'));
    expect(runtimeSettingsHtml).toContain('运行适配器');
    expect(runtimeSettingsHtml).toContain('当前默认：OpenAI Codex CLI');
    expect(runtimeSettingsHtml).not.toContain('<option value="codex">codex</option>');
    expect(runtimeSettingsHtml).not.toContain('<option value="generic">generic</option>');
    expect(runtimeSettingsHtml).not.toContain('Generic shell</option>');
    expect(runtimeSettingsHtml).not.toContain('>Adapter<');
    expect(runtimeSettingsHtml).not.toContain('当前默认：codex');
  });

  it('renders the global Telegram settings page in the selected app language without Chinese control leakage', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="telegram" initialAppShellSettings={createAppShellSettings('en-US')} initialSecuritySecrets={createSecuritySecrets()} />);
    const telegramStart = html.indexOf('settings-product-pane" aria-label="Telegram');
    const telegramHtml = html.slice(telegramStart);

    expect(telegramStart).toBeGreaterThanOrEqual(0);
    for (const expectedCopy of [
      'Telegram settings',
      'Telegram Bot Token',
      'Configured · Token is stored in macOS Keychain. The UI never reveals the secret.',
      'Token',
      'Save to Keychain',
      'Clear token',
      'Notification Chat ID',
      'Not tested yet',
      'Chat ID',
      'Save notification settings',
      'Test connection',
      'Polling and message logs',
      'Only shows real polling updates. Zeus does not generate fake Telegram messages.',
      'Stopped · offset 0',
      'No real Telegram polling logs yet.',
      'Latest 5',
    ]) {
      expect(telegramHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of [
      'Current category',
      '当前分类',
      'Telegram 设置',
      '只保存到 macOS 钥匙串',
      '界面不回显明文',
      '保存到钥匙串',
      '清理令牌',
      '通知会话 ID',
      '尚未测试连接',
      '保存通知设置',
      '测试连接',
      '轮询与消息日志',
      '只展示真实 polling update',
      '不生成假 Telegram 消息',
      '运行中',
      '已停止',
      '暂无真实 Telegram 轮询日志',
      '最近 5 条',
    ]) {
      expect(telegramHtml).not.toContain(leakedCopy);
    }
  });

  it('renders Telegram and Security sensitive field labels in Simplified Chinese when the app language is Chinese', () => {
    const telegramHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="telegram" initialAppShellSettings={createAppShellSettings('zh-CN')} initialSecuritySecrets={createSecuritySecrets()} />);
    const securityHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" initialAppShellSettings={createAppShellSettings('zh-CN')} initialSecuritySecrets={createSecurityOnlySecrets()} />);

    for (const expectedCopy of ['Telegram 机器人令牌', '令牌', '保存到钥匙串', '清理令牌', '通知会话 ID', '已配置']) {
      expect(telegramHtml).toContain(expectedCopy);
    }
    for (const expectedCopy of ['外部接口密钥', '接口密钥', '保存接口密钥', '清理接口密钥', '允许用户 ID', '外部接口密钥已配置']) {
      expect(securityHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of [
      'Bot Token',
      '>Token<',
      '保存到 Keychain',
      '清理 Token',
      '通知 Chat ID',
      '>Chat ID<',
      '外部 API Key',
      '保存 API Key',
      '清理 API Key',
      '>API Key<',
      '>Allowed User ID<',
      'Configured',
      'External API key configured',
      'External API key not configured',
      'Telegram token not configured',
    ]) {
      expect(telegramHtml).not.toContain(leakedCopy);
      expect(securityHtml).not.toContain(leakedCopy);
    }
    expect(securityHtml).not.toContain('aria-label="Allowed User ID"');
  });

  it('renders the global Git confirmation settings page in the selected app language without Chinese control leakage', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" initialAppShellSettings={createAppShellSettings('en-US')} initialGitConfirmation={createGitSettingsConfirmation()} />);
    const gitStart = html.indexOf('settings-product-pane" aria-label="Git confirmation');
    const gitHtml = html.slice(gitStart);

    expect(gitStart).toBeGreaterThanOrEqual(0);
    expect(gitHtml).toContain('native-settings-pane deep-settings-pane git-settings-pane');
    for (const expectedCopy of [
      'Git confirmation settings',
      'Branch name',
      'Only used to create a Git write confirmation. It does not execute immediately.',
      'Git branch name',
      'Remote',
      'Only used for push confirmations. The real push still requires a second confirmation.',
      'Git remote',
      'Git write confirmation',
      'Dangerous operations require confirmation',
      'Only creates a local confirmation request. It never executes a Git write directly.',
      'Target branch not filled',
      'Remote: origin · target: main',
      'Request branch confirmation',
      'Request push confirmation',
    ]) {
      expect(gitHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of [
      'Current category',
      '当前分类',
      'Git 确认设置',
      '分支名',
      '只用于创建 Git 写操作确认',
      'Git 分支名',
      '远端',
      '只用于推送确认',
      'Git 远端',
      'Git 写操作确认',
      '危险操作必须确认',
      '这里只生成本机确认请求',
      '目标分支未填写',
      '远端：origin',
      '请求创建分支确认',
      '请求推送确认',
    ]) {
      expect(gitHtml).not.toContain(leakedCopy);
    }
  });

  it('renders the global Release settings page in Simplified Chinese without English release waiting-state leakage', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" initialReleaseStatus={createReleaseStatus()} initialReleaseUpdateStatus={createReleaseUpdateStatus()} />);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const feedReleaseStatus: ReleaseStatusSnapshot = {
      ...createReleaseStatus(),
      autoUpdate: {
        ...createReleaseStatus().autoUpdate,
        channel: 'stable' as unknown as ReleaseStatusSnapshot['autoUpdate']['channel'],
        updateFeedConfigured: true,
      },
    };
    const feedHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" initialReleaseStatus={feedReleaseStatus} initialReleaseUpdateStatus={createReleaseUpdateStatus()} />);
    const releaseStart = html.indexOf('发布与签名');
    const releaseHtml = html.slice(releaseStart);
    const feedReleaseStart = feedHtml.indexOf('发布与签名');
    const feedReleaseHtml = feedHtml.slice(feedReleaseStart);

    expect(releaseStart).toBeGreaterThanOrEqual(0);
    expect(feedReleaseStart).toBeGreaterThanOrEqual(0);
    for (const expectedCopy of [
      '公证状态',
      '不会伪造签名或公证成功',
      '只允许未签名验证',
      '未签名构建可用',
      '等待 Apple 签名证书',
      '等待 Apple 公证凭据',
      '需要已签名和公证的发布产物',
      '手动更新 · 0.1.0',
      '发现新版本：0.2.0',
      '稳定频道',
      'arm64 · DMG 安装包',
    ]) {
      expect(releaseHtml).toContain(expectedCopy);
    }
    expect(source).toContain("current: '当前版本已不低于发布清单中的最新版本。'");
    expect(source).toContain("'GitHub Release workflow': '等待 GitHub Release 工作流'");
    expect(feedReleaseHtml).toContain('稳定频道更新 · 0.1.0');
    expect(feedReleaseHtml).not.toContain('Stable 更新');
    expect(source).toContain("label: '等待 GitHub Release 工作流'");
    expect(source).toContain("reason: '点击检查更新后读取 GitHub Release 发布清单；未签名或未公证的产物只允许手动安装。'");
    expect(source).not.toContain("label: '等待 GitHub Release workflow'");
    expect(source).not.toContain("reason: '点击检查更新后读取 GitHub Release manifest；未签名或未公证的产物只允许手动安装。'");
    for (const leakedCopy of [
      'Apple signing certificate',
      'Apple notarization credentials',
      'signed and notarized artifacts',
      'Manual update',
      'New version available',
      'notarization 状态',
      '不会伪造签名或 notarization 成功',
      'unsigned 构建可用',
      'Release manifest',
      'GitHub Release workflow',
      '>stable<',
      'arm64 · dmg',
    ]) {
      expect(releaseHtml).not.toContain(leakedCopy);
    }
    expect(source).not.toContain('notarization 状态');
    expect(source).not.toContain('不会伪造签名或 notarization 成功');
    expect(source).not.toContain('unsigned 构建可用');
    expect(source).not.toContain('当前版本已不低于 Release manifest 中的最新版本。');
    expect(source).not.toContain("'GitHub Release workflow': '等待 GitHub Release workflow'");
  });

  it('renders the global Release settings page in the selected app language without Chinese control leakage', () => {
    const html = renderToStaticMarkup(
      <App snapshot={createSnapshot()} initialMainNavTarget="settings" initialAppShellSettings={createAppShellSettings('en-US')} initialReleaseStatus={createReleaseStatus()} initialReleaseUpdateStatus={createReleaseUpdateStatus()} />,
    );
    const releaseStart = html.indexOf('settings-product-pane" aria-label="Release &amp; updates');
    const releaseHtml = html.slice(releaseStart);

    expect(releaseStart).toBeGreaterThanOrEqual(0);
    for (const expectedCopy of [
      'Release and signing',
      'macOS signing',
      'Certificates are read only from release environment variables.',
      'notarization',
      'Zeus does not fake signing or notarization success. Without Apple credentials, only unsigned verification is allowed.',
      'Homebrew cask',
      'Waiting for signing certificate',
      'Waiting for notarization credentials',
      'Local cask generated',
      'Unsigned build available',
      'Release details',
      'Unsigned or non-notarized artifacts are never presented as a production release.',
      'Auto-update reserved',
      'Real release status',
      'Manual update · 0.1.0',
      'Software update',
      'New version available: 0.2.0',
      'Release artifacts are not both signed and notarized. Zeus only opens GitHub Release for manual installation.',
      'Installation requires signing and notarization. Currently opens GitHub Release for manual install.',
      'Check updates',
      'Version',
      'Checked at 2026-06-18T00:00:00.000Z',
      'Current version: 0.1.0',
      'Latest version: 0.2.0',
      'Stable',
      'Installer',
      'arm64 · DMG',
      'Zeus-0.2.0-arm64.dmg',
    ]) {
      expect(releaseHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of [
      'Current category',
      '当前分类',
      '发布与签名',
      'macOS 签名状态',
      '证书只通过发布环境变量读取',
      'notarization 状态',
      '不会伪造签名或 notarization 成功',
      '没有 Apple 凭据时只允许 unsigned 验证',
      'Homebrew cask 状态',
      '等待签名证书',
      '等待公证凭据',
      '本地 cask 已生成',
      'unsigned 构建可用',
      '发布详情',
      '不把未签名、未公证产物伪装成正式发布',
      '自动更新预留',
      '真实发布状态',
      '软件更新',
      '手动更新',
      '发现新版本',
      '下载安装需要签名与公证',
      '已签名与公证，可下载后安装',
      '当前只打开 GitHub Release 手动安装',
      '检查中',
      '检查更新',
      '软件更新版本',
      '检查时间',
      '尚未完成远端检查',
      '当前版本',
      '最新版本',
      '软件更新安装包',
      '安装包',
      '等待匹配本机架构',
      '暂无匹配本机架构的安装包',
      '更新检查失败，请稍后重试',
    ]) {
      expect(releaseHtml).not.toContain(leakedCopy);
    }
  });

  it('renders the global Data settings page in the selected app language without Chinese control leakage', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget={'settings-data' as never} initialAppShellSettings={createAppShellSettings('en-US')} />);
    const dataStart = html.indexOf('settings-product-pane" aria-label="Cache &amp; data');
    const dataHtml = html.slice(dataStart);

    expect(dataStart).toBeGreaterThanOrEqual(0);
    for (const expectedCopy of [
      'Cache and data settings',
      'Local log directory',
      'Exports are saved locally with secrets redacted. Zeus does not upload business data.',
      'Zeus/logs',
      'Not imported or exported yet',
      'Export settings',
      'Import settings',
      'Clear cache',
    ]) {
      expect(dataHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of ['当前分类', '缓存与数据设置', '本地日志目录', '导出会在本机脱敏保存', '不上传业务数据', '尚未导入/导出', '导出设置', '导入设置', '清理缓存']) {
      expect(dataHtml).not.toContain(leakedCopy);
    }
  });

  it('renders the global Security settings page in the selected app language without Chinese control leakage', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" initialAppShellSettings={createAppShellSettings('en-US')} initialSecuritySecrets={createSecurityOnlySecrets()} />);
    const securityStart = html.indexOf('settings-product-pane" aria-label="Security &amp; Keychain');
    const securityHtml = html.slice(securityStart);

    expect(securityStart).toBeGreaterThanOrEqual(0);
    for (const expectedCopy of [
      'Security &amp; Keychain settings',
      'External API Key',
      'External API key configured · Stored only in macOS Keychain. Zeus does not claim the external AI service is available.',
      'API Key',
      'Save API Key',
      'Clear API Key',
      'Telegram allowlist',
      'Only allowed real Telegram users can trigger remote operations.',
      'Allowed User ID',
      'Save allowlist',
      'Exposure risk',
      'Clears locally stored Token, API Key, and remote-control allowlist state.',
      'External credentials must be configured again after reset.',
      'Reset security settings',
      'Security audit',
      'Only shows real local security audit records.',
      'No real security audit records yet.',
      'Latest 6',
    ]) {
      expect(securityHtml).toContain(expectedCopy);
    }
    for (const leakedCopy of [
      'Current category',
      '当前分类',
      '安全与钥匙串设置',
      '外部接口密钥',
      '只保存到 macOS 钥匙串',
      '不会声明外部 AI 服务已可用',
      '保存接口密钥',
      '清理接口密钥',
      'Telegram 白名单',
      '只有允许的真实 Telegram 用户可远程触发操作',
      '保存白名单',
      '泄露风险',
      '清理本机保存的令牌',
      '重置后需要重新配置外部凭据',
      '重置安全设置',
      '安全审计',
      '只展示真实本机安全审计记录',
      '暂无真实安全审计记录',
      '最近 6 条',
    ]) {
      expect(securityHtml).not.toContain(leakedCopy);
    }
  });

  it('normalizes task filters into explicit filter rows instead of label wrapped inputs and selects', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);

    expect(html).toContain('task-filter-control-row');
    expect(html).toContain('task-table-context-meta');
    expect(html).toContain('task-table-new-task-button');
    expect(html).not.toContain('task-filter-control-copy');
    expect(html).not.toContain('task-filter-control-field');
    expect(source).not.toContain('<label className="task-filter-search">');
    expect(source).not.toContain('<label className="task-filter-field">');
    expect(source).not.toContain('<label className="task-filter-field task-filter-tags">');
    expect(css).toContain('任务页多场景原型高还原最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-primary-toolbar \.task-filter-control-row,\n\.macos-ai-app \.task-table-view-toolbar \.task-filter-control-row\s*\{[\s\S]*display:\s*block/);
  });

  it('compresses the project task filters into a compact toolbar instead of four stacked form cards', () => {
    const source = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);

    for (const className of ['task-filter-toolbar', 'task-table-primary-toolbar', 'task-table-view-toolbar', 'task-toolbar-search']) {
      expect(source).toContain(className);
      expect(html).toContain(className);
    }
    expect(source).not.toContain('task-toolbar-select');
    expect(source).not.toContain('task-toolbar-tags');
    expect(html).not.toContain('task-toolbar-select');
    expect(html).not.toContain('task-toolbar-tags');
    expect(css).not.toContain('task-toolbar-select');
    expect(css).not.toContain('task-toolbar-tags');
    expect(source).not.toContain('task-table-compact-toolbar');
    expect(html).not.toContain('task-table-compact-toolbar');
    expect(html).not.toContain('task-filter-primary-row');
    expect(html).not.toContain('task-filter-secondary-row');
    expect(html).not.toContain('task-filter-action-rail');
    expect(css).toContain('任务页多场景原型高还原最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.task-table-primary-toolbar\s*\{[\s\S]*grid-template-columns:\s*max-content minmax\(260px,\s*1fr\) auto auto/);
    expect(css).not.toMatch(/\.macos-ai-app \.task-filter-workbench\.task-filter-toolbar\s*\{[^}]*grid-template-rows:\s*auto auto auto auto/);
  });

  it('wires real loading actions to aria busy and data loading instead of only disabling buttons', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const taskSource = readFileSync(new URL('../src/renderer/task/TaskWorkspace.tsx', import.meta.url), 'utf8');

    expect(source).toContain('function controlBusyProps');
    expect(source).toContain('busy?: boolean;');
    expect(source).toContain('controlBusyProps(action.busy === true)');
    expect(taskSource).toContain('props.controlBusyProps(props.creatingTaskBusy)');
    for (const busyFlag of [
      'creatingProjectBusy',
      'loadingDiffBusy',
      'loadingRuntimeBusy',
      'loadingTemplatesBusy',
      'creatingGitConfirmationBusy',
      'confirmingGitOperationBusy',
      'executingGitOperationBusy',
      'scanBusy',
      'releaseUpdateBusy',
    ]) {
      expect(source).toContain(`controlBusyProps(${busyFlag})`);
    }
    for (const state of [
      "actionState === 'creating-project'",
      "actionState === 'creating-task'",
      "actionState === 'updating-task'",
      "actionState === 'loading-diff'",
      "actionState === 'loading-runtime'",
      "actionState === 'loading-templates'",
      "actionState === 'creating-git-confirmation'",
      "actionState === 'confirming-git-operation'",
      "actionState === 'executing-git-operation'",
      "scanState === 'scanning'",
      "releaseUpdateCheckState === 'loading'",
    ]) {
      expect(source).toContain(state);
    }
  });
});
