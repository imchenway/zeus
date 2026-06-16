import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, buildGitDiffDecisionSummary } from '../src/renderer/App.js';
import type { DashboardSnapshot, GitDiffSummary } from '../src/renderer/apiClient.js';

function createSnapshot(): DashboardSnapshot {
  return {
    app: 'Zeus',
    localServer: { host: '127.0.0.1', port: 49152 },
    projects: [
      {
        id: 'project_real',
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        scanStatus: 'not_scanned',
      },
    ],
    tasks: [],
    runtime: {
      aiCli: { available: false, reason: '未检测到可用 AI CLI。' },
      telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
    },
    git: {
      isRepository: true,
      branch: 'main',
      clean: false,
      changedFiles: ['packages/git-core/src/index.ts'],
      conflictFiles: ['packages/conflict.ts'],
      remoteBranches: ['origin/main'],
      recentCommits: [
        {
          hash: 'abcdef1234567890',
          shortHash: 'abcdef1',
          subject: 'feat: real git status',
          author: 'Zeus Maintainer',
          authoredAt: '2026-06-14T00:00:00.000Z',
        },
      ],
    },
    graph: { nodeCount: 0, edgeCount: 0, viewCount: 0 },
  };
}

function createDiff(): GitDiffSummary {
  return {
    isRepository: true,
    branch: 'main',
    clean: false,
    files: ['apps/desktop/src/renderer/App.tsx'],
    diffText: 'diff --git a/apps/desktop/src/renderer/App.tsx b/apps/desktop/src/renderer/App.tsx\n',
    fileDiffs: [
      {
        oldPath: 'apps/desktop/src/renderer/App.tsx',
        newPath: 'apps/desktop/src/renderer/App.tsx',
        changeType: 'modified',
        addedLines: 2,
        deletedLines: 1,
        hunks: [
          {
            header: '@@ -10,2 +10,3 @@ export function App() {',
            oldStart: 10,
            oldLines: 2,
            newStart: 10,
            newLines: 3,
            lines: [
              {
                type: 'context',
                content: 'const title = "Zeus";',
                oldLineNumber: 10,
                newLineNumber: 10,
              },
              {
                type: 'deletion',
                content: 'const oldLabel = "Diff";',
                oldLineNumber: 11,
                newLineNumber: null,
              },
              {
                type: 'addition',
                content: 'const newLabel = "Git Diff";',
                oldLineNumber: null,
                newLineNumber: 11,
              },
            ],
          },
        ],
      },
    ],
    conflictCount: 0,
    remoteStatus: { ahead: 0, behind: 0, hasUpstream: true },
    generatedAt: '2026-06-16T00:00:00.000Z',
  };
}

describe('Zeus App git confirmation rendering', () => {
  it('keeps high-risk git actions collected inside the project change drawer', () => {
    const firstLayerHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} />);
    const drawerHtml = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="git-diff" />);

    expect(firstLayerHtml).toContain('查看变更');
    expect(firstLayerHtml).not.toContain('请求暂存确认');
    expect(drawerHtml).toContain('workspace-view-projects');
    expect(drawerHtml).toContain('Git 高风险确认');
    expect(drawerHtml).toContain('请求暂存确认');
    expect(drawerHtml).toContain('请求提交确认');
  });

  it('renders git confirmation expiration and reject path in the collected drawer', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialGitConfirmation={{
          id: 'git-confirm-1',
          operation: 'stash',
          cwd: '/Users/david/hypha/zeus',
          reason: '用户请求暂存当前变更',
          status: 'pending',
          riskLevel: 'high',
          confirmationText: '确认执行 Git stash',
          createdAt: '2026-06-14T00:00:00.000Z',
          expiresAt: '2026-06-14T00:10:00.000Z',
        }}
      />,
    );

    expect(html).toContain('确认有效期');
    expect(html).toContain('2026-06-14 00:10:00 UTC');
    expect(html).toContain('拒绝 Git 确认');
    expect(html).toContain('拒绝后不会执行任何 Git 写操作');
  });

  it('renders rejected high-risk git confirmations as a terminal safe state', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialGitConfirmation={{
          id: 'git-confirm-rejected',
          operation: 'stash',
          cwd: '/Users/david/hypha/zeus',
          reason: '用户请求暂存当前变更',
          status: 'rejected',
          riskLevel: 'high',
          confirmationText: '确认执行 Git stash',
          createdAt: '2026-06-14T00:00:00.000Z',
          expiresAt: '2026-06-14T00:10:00.000Z',
          rejectedAt: '2026-06-14T00:01:00.000Z',
          rejectedReason: '用户取消本次暂存',
        }}
      />,
    );

    expect(html).toContain('已拒绝 Git 确认');
    expect(html).toContain('不会执行 Git 写操作');
    expect(html).toContain('用户取消本次暂存');
    expect(html).not.toContain('执行已确认暂存');
  });

  it('renders readonly git status and parsed diff details without making Git a first-level page', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialGitDiff={createDiff()} />);

    expect(html).toContain('workspace-view-projects');
    expect(html).toContain('Git 工作区状态');
    expect(html).toContain('有 1 个变更');
    expect(html).toContain('冲突 1');
    expect(html).toContain('远程分支 1');
    expect(html).toContain('最近提交 abcdef1');
    expect(html).toContain('文件级 Diff');
    expect(html).toContain('+2 / -1');
    expect(html).toContain('@@ -10,2 +10,3 @@');
    expect(html).toContain('const newLabel = &quot;Git Diff&quot;');
    expect(html).not.toContain('workspace-view-git-diff');
  });

  it('renders explicit execution controls only after confirmation is confirmed', () => {
    const html = renderToStaticMarkup(
      <App
        snapshot={createSnapshot()}
        initialGitConfirmation={{
          id: 'git-confirm-confirmed',
          operation: 'stash',
          cwd: '/Users/david/hypha/zeus',
          reason: '用户请求暂存当前变更',
          status: 'confirmed',
          riskLevel: 'high',
          confirmationText: '确认执行 Git stash',
          createdAt: '2026-06-14T00:00:00.000Z',
          expiresAt: '2026-06-14T00:10:00.000Z',
          confirmedAt: '2026-06-14T00:01:00.000Z',
        }}
      />,
    );

    expect(html).toContain('执行已确认暂存');
    expect(html).toContain('只执行白名单 Git 命令');
    expect(html).toContain('尚未执行 Git 写操作');
  });

  it('renders commit message and dedicated high-risk git parameters in the drawer', () => {
    const html = renderToStaticMarkup(<App snapshot={createSnapshot()} initialMainNavTarget="git-diff" />);

    expect(html).toContain('提交说明');
    expect(html).toContain('用于已确认 Git commit；为空时不会执行提交');
    expect(html).toContain('Git 高风险参数');
    expect(html).toContain('新分支名称');
    expect(html).toContain('切换已有分支');
    expect(html).toContain('Stash 引用');
    expect(html).toContain('远端名称');
    expect(html).toContain('目标引用');
    expect(html).toContain('回滚目标');
  });

  it('summarizes accepted rejected and pending Git Diff hunk decisions without applying changes', () => {
    const diff = createDiff();
    diff.fileDiffs[0].hunks.push({
      header: '@@ -20 +20 @@',
      oldStart: 20,
      oldLines: 1,
      newStart: 20,
      newLines: 1,
      lines: [],
    });

    expect(
      buildGitDiffDecisionSummary(diff, {
        'apps/desktop/src/renderer/App.tsx->apps/desktop/src/renderer/App.tsx:@@ -10,2 +10,3 @@ export function App() {': 'accepted',
      }),
    ).toBe('审查决策：已接受 1 · 已拒绝 0 · 待审查 1 · 不执行 git apply');
  });
});
