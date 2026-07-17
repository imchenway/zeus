import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App.js';
import type { AppShellSettings, DashboardSnapshot, GitDiffSummary, ProjectConfig, SecurityAuditLogEntry } from '../src/renderer/apiClient.js';

function createSnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
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
    ...overrides,
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

describe('Zeus App data rendering', () => {
  it('renders real task data in the conversation workspace without exposing project internals on the first layer', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="tasks" />);

    expect(html).toContain('workspace-view-project-tasks');
    expect(html).toContain('分析当前项目结构');
    expect(html).toContain('任务管理');
    expect(html).toContain('task-table-only-layout');
    expect(html).not.toContain('运行任务');
    expect(html).not.toContain('任务状态变更');
    expect(html).not.toContain('项目详情');
    expect(html).not.toContain('审查工作区');
  });

  it('renders the project preparation workspace and hides duplicate local paths', () => {
    const html = renderToStaticMarkup(
      <App
        initialMainNavTarget="projects"
        snapshot={createSnapshot({
          projects: [
            {
              id: 'project_zeus_a',
              name: 'Zeus E2E',
              localPath: '/Users/david/hypha/zeus',
              description: '真实仓库 A',
              scanStatus: 'completed',
            },
            {
              id: 'project_zeus_b',
              name: 'Zeus E2E duplicate',
              localPath: '/Users/david/hypha/zeus/',
              description: '重复路径',
              scanStatus: 'completed',
            },
            {
              id: 'project_core',
              name: 'tc-app-core',
              localPath: '/Users/david/cckg/tcapp/Back-End/tc-app-core',
              description: '真实后端仓库',
              scanStatus: 'not_scanned',
            },
          ],
          tasks: [],
        })}
      />,
    );

    expect(html).toContain('project-first-sidebar');
    expect(html).toContain('项目列表');
    expect(html).toContain('workspace-view-project-code');
    expect(html).toContain('扫描项目');
    expect(html).toContain('打开图谱');
    expect(html).toContain('查看变更');
    expect(html).toContain('Zeus E2E');
    expect(html).toContain('tc-app-core');
    expect(html).not.toContain('Zeus E2E duplicate');
  });

  it('renders Git diff inside the project drawer instead of a first-level Git page', () => {
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
          hunks: [
            {
              header: '@@ -1 +1 @@',
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [{ type: 'addition', content: '收纳式布局', newLineNumber: 1 }],
            },
          ],
        },
      ],
      conflictCount: 0,
      remoteStatus: { ahead: 0, behind: 0, hasUpstream: true },
      generatedAt: '2026-06-16T00:00:00.000Z',
    };

    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="git-diff" initialGitDiff={diff} />);

    expect(html).toContain('workspace-view-project-code');
    expect(html).toContain('代码变更');
    expect(html).toContain('导出 Patch');
    expect(html).toContain('apps/desktop/src/renderer/App.tsx');
    expect(html).not.toContain('workspace-view-git-diff');
  });

  it('renders Keychain security settings without showing secret values or unrelated setting groups', () => {
    const auditLogs: SecurityAuditLogEntry[] = [
      {
        id: 'audit_real',
        actorType: 'local_api',
        actorRef: null,
        action: 'security.secret.external_api_key.saved',
        resourceType: 'secret',
        resourceId: 'external.apiKey',
        payload: { configured: true, secretValueStored: false },
        createdAt: '2026-06-13T00:00:00.000Z',
      },
    ];

    const html = renderToStaticMarkup(
      <App
        initialSecuritySecrets={{
          telegramBotToken: { configured: false, label: '未配置' },
          externalApiKey: { configured: true, label: '已安全保存' },
        }}
        initialSecurityAuditLogs={auditLogs}
      />,
    );

    expect(html).toContain('workspace-view-settings');
    expect(html).not.toContain('当前分类：安全与钥匙串');
    expect(html).not.toContain('settings-current-category');
    expect(html).toContain('外部接口密钥');
    expect(html).toContain('重置安全设置');
    expect(html).toContain('security.secret.external_api_key.saved');
    expect(html).not.toContain('telegram-token-real');
    expect(html).not.toContain('fake');
    expect(html).not.toContain('当前分类：通用');
  });

  it('renders archived projects only through the project drawer restore flow', () => {
    const html = renderToStaticMarkup(
      <App
        initialArchivedProjects={[
          {
            id: 'project_archived',
            name: 'Zeus Archive',
            localPath: '/Users/david/hypha/zeus-archive',
            scanStatus: 'completed',
          },
        ]}
        snapshot={createSnapshot({ projects: [], tasks: [] })}
      />,
    );

    expect(html).toContain('project-first-sidebar');
    expect(html).toContain('归档项目');
    expect(html).toContain('恢复项目');
    expect(html).toContain('/Users/david/hypha/zeus-archive');
    expect(html).not.toContain('归档任务为空');
  });

  it('normalizes archived project recovery into a compact restore workbench instead of readonly object rows', () => {
    const html = renderToStaticMarkup(
      <App
        initialArchivedProjects={[
          {
            id: 'project_archived',
            name: 'Zeus Archive',
            localPath: '/Users/david/hypha/zeus-archive-with-a-very-long-local-path-for-layout-hardening',
            scanStatus: 'completed',
          },
        ]}
        snapshot={createSnapshot({ projects: [], tasks: [] })}
      />,
    );
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(html).toContain('project-archive-workbench');
    expect(html).toContain('project-archive-row');
    expect(html).toContain('project-archive-copy');
    expect(html).toContain('project-archive-command-rail');
    expect(html).toContain('Zeus Archive');
    expect(html).toContain('zeus-archive-with-a-very-long-local-path-for-layout-hardening');
    expect(source).toContain('function ProjectArchiveWorkbench');
    expect(source).toContain('project-archive-empty-row');
    expect(source).not.toContain('className="object-row readonly" key={project.id}');
    expect(css).toContain('项目归档抽屉最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-archive-workbench\s*\{[\s\S]*gap:\s*0/);
    expect(css).toMatch(/\.macos-ai-app \.project-archive-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  });

  it('renames project archive actions into an explicit restore command rail', () => {
    const html = renderToStaticMarkup(
      <App
        initialArchivedProjects={[
          {
            id: 'project_archived',
            name: 'Zeus Archive',
            localPath: '/Users/david/hypha/zeus-archive',
            scanStatus: 'completed',
          },
        ]}
        snapshot={createSnapshot({ projects: [], tasks: [] })}
      />,
    );
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    expect(source).not.toContain('project-archive-actions');
    expect(css).not.toContain('project-archive-actions');
    expect(html).toContain('project-archive-command-rail');
    expect(source).toContain('project-archive-command-rail');
    expect(css).toContain('项目归档恢复命令 rail 命名最终覆盖');
    expect(css).toMatch(/\.macos-ai-app \.project-archive-command-rail\s*\{[\s\S]*justify-content:\s*flex-end/);
  });

  it('renders task templates from the new conversation menu drawer instead of fake tasks', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot({ tasks: [] })}
        initialTaskTemplates={[
          {
            id: 'task_template_bug_fix',
            name: 'Bug 修复',
            description: '定位真实缺陷并补充回归验证',
            promptTemplate: '请基于 {{project}} 修复 {{bug}}',
            builtIn: true,
          },
          {
            id: 'task_template_code_review',
            name: '代码评审',
            description: '审查真实变更风险',
            promptTemplate: '请审查 {{diff}}',
            builtIn: true,
          },
        ]}
      />,
    );

    expect(html).toContain('workspace-view-project-sessions');
    expect(html).toContain('任务模板');
    expect(html).toContain('Bug 修复');
    expect(html).toContain('代码评审');
    expect(html).not.toContain('任务线程');
  });

  it('renders a real local error panel entry with sensitive fragments redacted', () => {
    const html = renderToStaticMarkup(
      <App
        initialLocalError={{
          action: 'load-runtime',
          message: 'Runtime 请求失败 token=telegram-token-real Bearer sk-real-secret',
          occurredAt: '2026-06-14T00:00:00.000Z',
        }}
      />,
    );

    expect(html).toContain('本地操作失败');
    expect(html).toContain('Runtime 请求失败 token=[REDACTED] Bearer [REDACTED]');
    expect(html).not.toContain('telegram-token-real');
    expect(html).not.toContain('sk-real-secret');

    const enHtml = renderToStaticMarkup(
      <App
        initialAppShellSettings={createAppShellSettings('en-US')}
        initialLocalError={{
          action: 'load-runtime',
          message: 'Runtime failed token=telegram-token-real Bearer sk-real-secret',
          occurredAt: '2026-06-14T00:00:00.000Z',
        }}
      />,
    );
    expect(enHtml).toContain('Local operation failed');
    expect(enHtml).not.toContain('本地操作失败');
    expect(enHtml).toContain('Runtime failed token=[REDACTED] Bearer [REDACTED]');
    expect(enHtml).not.toContain('telegram-token-real');
    expect(enHtml).not.toContain('sk-real-secret');
  });

  it('renders project configuration in the project settings workspace without creating fake runtime data', () => {
    const projectConfig: ProjectConfig = {
      projectId: 'project_real',
      defaultModel: 'gpt-5.1-codex',
      defaultWorkMode: 'develop',
      defaultTaskPrompt: '只基于真实代码和测试证据执行',
      scan: { ignoreDirectories: ['node_modules', 'dist'], indexScope: 'src' },
      language: { primary: 'typescript', additional: ['java'] },
      dependencies: {
        packageManagers: ['pnpm'],
        manifestPaths: ['package.json', 'pnpm-workspace.yaml'],
      },
      vcs: { isGitRepository: true, gitRoot: '/Users/david/hypha/zeus' },
      database: {
        connectionName: 'postgresql://zeus:secret-password@localhost:5432/app',
        schemaPaths: ['packages/local-server/src/storage'],
      },
      telegram: { alias: 'zeus-local' },
      security: { allowShell: true, allowGitWrite: false },
    };

    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot({ tasks: [] })}
        initialMainNavTarget="projects"
        initialProjectConfig={projectConfig}
        initialProjectDatabaseSecret={{
          connectionName: 'local-sqlite',
          password: { configured: true, label: '已安全保存' },
        }}
      />,
    );

    expect(html).toContain('workspace-view-project-settings');
    expect(html).toContain('项目配置');
    expect(html).toContain('默认 AI 模型');
    expect(html).toContain('gpt-5.1-codex');
    expect(html).toContain('扫描忽略规则');
    expect(html).toContain('node_modules, dist');
    expect(html).toContain('postgresql://zeus:***@localhost:5432/app');
    expect(html).toContain('密码状态');
    expect(html).toContain('已安全保存');
    expect(html).toContain('project-config-row-list');
    expect(html).toContain('保存项目配置');
    expect(html).not.toContain('secret-password');
  });

  it('keeps app appearance settings applied to the root shell', () => {
    const darkHtml = renderToStaticMarkup(
      <App
        initialAppShellSettings={{
          appLanguage: 'zh-CN',
          appearance: 'dark',
          webviewDebugEnabled: false,
          multiWindowEnabled: true,
          backgroundModeEnabled: true,
          desktopNotificationsEnabled: true,
          openAtLoginEnabled: false,
          autoUpdateChannel: 'manual',
          defaultProjectId: null,
          pinnedProjectIds: [],
          defaultModel: null,
          defaultTaskTemplateId: null,
          localLogDirectory: '/Users/david/Library/Application Support/Zeus/logs',
          localConfigPath: '/Users/david/Library/Application Support/Zeus/zeus.config.json',
          dataPortability: {
            importSupported: true,
            exportSupported: true,
            redactsSecrets: true,
          },
          cache: { codeIndex: true, graphView: true, layout: true },
          lastCacheClearAt: null,
        }}
      />,
    );

    expect(darkHtml).toContain('data-theme="dark"');
    expect(darkHtml).toContain('theme-dark');
  });
});
