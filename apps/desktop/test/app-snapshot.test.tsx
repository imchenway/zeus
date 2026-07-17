import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App.js';
import type { DashboardSnapshot } from '../src/renderer/apiClient.js';

describe('Zeus App snapshot rendering', () => {
  it('renders a real empty snapshot as project preparation without exposing local server internals', () => {
    const snapshot: DashboardSnapshot = {
      app: 'Zeus',
      localServer: { host: '127.0.0.1', port: 49152 },
      projects: [],
      tasks: [],
      runtime: {
        aiCli: { available: false, reason: '未检测到 Codex CLI。' },
        telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
      },
      git: { isRepository: true, branch: 'main', changedFiles: [] },
      graph: { nodeCount: 0, edgeCount: 0, viewCount: 0 },
    };
    const html = renderToStaticMarkup(<App snapshot={snapshot} />);

    expect(html).toContain('project-first-sidebar');
    expect(html).toContain('选择真实本地代码库');
    expect(html).not.toContain('真实工作流时间线');
    expect(html).not.toContain('127.0.0.1:49152');
  });
});
