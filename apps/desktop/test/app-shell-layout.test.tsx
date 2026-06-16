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

describe('Zeus 收纳式壳层布局', () => {
  it('only exposes Projects, Conversations and bottom Settings in the sidebar', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);

    expect(html).toContain('href="#projects"');
    expect(html).toContain('href="#conversations"');
    expect(html).toContain('href="#settings"');
    expect(html).toContain('class="nav-group nav-group-bottom"');

    for (const removedTarget of ['dashboard', 'tasks', 'runtime', 'code-map', 'git-diff', 'telegram']) {
      expect(html).not.toContain(`href="#${removedTarget}"`);
    }
    const sidebar = html.slice(html.indexOf('<aside class="zeus-sidebar'), html.indexOf('</aside>') + '</aside>'.length);
    for (const removedCopy of ['任务</strong>', '本地 CLI 对话', 'Code Map', 'Git Diff', 'Runtime', 'Telegram', 'ZEUS WORKSPACES', 'PREFERENCES', 'Local AI Workbench']) {
      expect(sidebar).not.toContain(removedCopy);
    }
  });

  it('defaults to the conversation workspace and removes the standalone dashboard', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} />);

    expect(html).toContain('workspace-view-conversations');
    expect(html).toContain('分析当前项目结构');
    expect(html).toContain('要求后续变更');
    expect(html).not.toContain('aria-label="AI 工作台"');
    expect(html).not.toContain('Activity Stream');
    expect(html).not.toContain('Context Rail');
  });

  it('keeps project page focused on current project preparation and tucks graph, diff and archive behind actions', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" />);

    expect(html).toContain('workspace-view-projects');
    expect(html).toContain('当前项目状态');
    expect(html).toContain('扫描项目');
    expect(html).toContain('打开图谱');
    expect(html).toContain('查看变更');
    expect(html).toContain('更多项目操作');
    expect(html).not.toContain('归档项目为空');
    expect(html).not.toContain('探索工作区');
    expect(html).not.toContain('审查工作区');
  });

  it('keeps conversation page focused on the current thread and moves runtime, graph and diff into drawers', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="conversations" />);

    expect(html).toContain('workspace-view-conversations');
    expect(html).toContain('对话列表');
    expect(html).toContain('当前对话');
    expect(html).toContain('运行环境');
    expect(html).toContain('上下文');
    expect(html).toContain('代码变更');
    expect(html).not.toContain('Runtime Adapters');
    expect(html).not.toContain('Runtime 终端日志');
    expect(html).not.toContain('任务模板</');
    expect(html).not.toContain('归档任务为空');
  });

  it('shows one settings category at a time instead of expanding every settings group', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);

    expect(html).toContain('settings-category-list');
    expect(html).toContain('settings-detail-pane');
    expect(html).toContain('通用');
    expect(html).toContain('AI CLI / Runtime');
    expect(html).toContain('Telegram');
    expect(html).toContain('安全与 Keychain');
    expect(html).toContain('当前分类');
    expect(html).not.toContain('settings-section-nav');
    expect(html).not.toContain('安全审计');
    expect(html).not.toContain('消息日志');
    expect(html).not.toContain('发布与签名');
  });

  it('aligns settings controls to the Codex macOS row-card vocabulary', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="settings" />);

    expect(html).toContain('native-settings-stack');
    expect(html).toContain('native-settings-card');
    expect(html).toContain('native-control-row');
    expect(html).toContain('native-control-copy');
    expect(html).toContain('native-control-slot');
    expect(html).toContain('native-switch-input');
    expect(html).toContain('选择 Zeus 使用的界面语言');
    expect(html).toContain('跟随系统');
  });

  it('aligns project rows to the same rounded list-card vocabulary as settings rows', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="projects" />);

    expect(html).toContain('native-list-card');
    expect(html).toContain('native-list-row');
    expect(html).toContain('native-folder-icon');
    expect(html).toContain('native-list-main');
    expect(html).toContain('native-list-trailing');
    expect(html).toContain('/Users/david/hypha/zeus');
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
      '.settings-section-nav',
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
    const projectHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="code-map" />);
    const conversationHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="runtime" />);
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

    for (const html of [projectHtml, conversationHtml]) {
      expect(html).toContain('class="workspace-drawer-backdrop"');
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain('class="workspace-drawer-content"');
    }

    expect(css).toMatch(/\.macos-ai-app \.workspace-drawer-backdrop\s*{[^}]*position:\s*fixed/s);
    expect(css).toMatch(/\.macos-ai-app \.workspace-drawer\s*{[^}]*position:\s*fixed/s);
    expect(css).not.toContain('.macos-ai-app .workspace-drawer {\n  margin-block-start: 16px;');
  });
});
