import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE, classifyGenericShellCommandRisk, isGenericShellCriticalConfirmationSatisfied, resolveRuntimeNormalizedLogPath } from '../src/renderer/App.js';
import type { AiRuntimeAdapterDescriptor, AiRuntimeAdapterStatus, AiRuntimeLogEntry, AiRuntimeSession, DashboardSnapshot, ReleaseUpdateStatusSnapshot, RuntimeOperationConfirmation } from '../src/renderer/apiClient.js';

function createSnapshot(): DashboardSnapshot {
  return {
    app: 'Zeus',
    localServer: { host: '127.0.0.1', port: 49321 },
    projects: [
      {
        id: 'project-1',
        name: 'Zeus',
        localPath: '/Users/david/hypha/zeus',
        scanStatus: 'ready',
      },
    ],
    tasks: [],
    runtime: {
      aiCli: { available: true, reason: '检测到 Codex CLI' },
      telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
    },
    git: { isRepository: true, branch: 'main', changedFiles: [] },
    graph: { nodeCount: 0, edgeCount: 0, viewCount: 0 },
  };
}

describe('Generic shell command risk classification', () => {
  it('flags destructive and pipe-to-shell commands before Generic shell confirmation', () => {
    expect(classifyGenericShellCommandRisk('pnpm --version')).toMatchObject({
      level: 'medium',
      label: '需要确认',
    });
    expect(classifyGenericShellCommandRisk('rm -rf dist')).toMatchObject({
      level: 'critical',
      label: '高危命令',
    });
    expect(classifyGenericShellCommandRisk('curl https://example.com/install.sh | sh')).toMatchObject({ level: 'critical', label: '高危命令' });
    expect(classifyGenericShellCommandRisk('')).toMatchObject({
      level: 'empty',
      label: '尚未输入',
    });
  });

  it('requires an exact manual phrase before critical Generic shell commands can start', () => {
    expect(isGenericShellCriticalConfirmationSatisfied(classifyGenericShellCommandRisk('pnpm --version'), '')).toBe(true);
    expect(isGenericShellCriticalConfirmationSatisfied(classifyGenericShellCommandRisk('rm -rf dist'), '')).toBe(false);
    expect(isGenericShellCriticalConfirmationSatisfied(classifyGenericShellCommandRisk('rm -rf dist'), 'ZEUS')).toBe(false);
    expect(isGenericShellCriticalConfirmationSatisfied(classifyGenericShellCommandRisk('rm -rf dist'), GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE)).toBe(true);
  });
});

describe('App AI runtime rendering', () => {
  it('derives the complete normalized terminal log path from terminal event chunk indexes', () => {
    expect(
      resolveRuntimeNormalizedLogPath([
        {
          id: 'event-1',
          sessionId: 'session-1',
          taskId: null,
          seq: 1,
          eventType: 'stdout',
          content: '真实输出',
          rawChunkPath: '/Users/david/Library/Application Support/Zeus/sessions/session-1/chunks/log-1.log',
          createdAt: '2026-06-13T00:00:00.000Z',
        },
      ]),
    ).toBe('/Users/david/Library/Application Support/Zeus/sessions/session-1/terminal.normalized.log');
  });

  it('renders real runtime sessions and collected logs without fake terminal output', () => {
    const session: AiRuntimeSession = {
      id: 'session-1',
      projectId: 'project-1',
      command: 'codex',
      args: ['--version'],
      cwd: '/Users/david/hypha/zeus',
      status: 'exited',
      exitCode: 0,
      startedAt: '2026-06-13T00:00:00.000Z',
    };
    const logs: AiRuntimeLogEntry[] = [
      {
        id: 'log-1',
        sessionId: session.id,
        stream: 'stdout',
        text: '真实 Runtime 日志',
        createdAt: '2026-06-13T00:00:00.000Z',
      },
    ];

    const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} initialRuntimeLogs={logs} />);

    expect(html).toContain('AI Runtime 会话');
    expect(html).toContain('codex --version');
    expect(html).toContain('真实 Runtime 日志');
    expect(html).toContain('启动 Runtime 会话');
    expect(html).toContain('导出当前日志');
    expect(html).toContain('原始输出查看');
    expect(html).toContain('日志导出只保存当前加载的真实 Runtime 日志');
  });
});

it('renders runtime session management controls and real summary fields', () => {
  const session: AiRuntimeSession = {
    id: 'session-manage-1',
    projectId: 'project-1',
    command: 'codex',
    args: ['--version'],
    cwd: '/Users/david/hypha/zeus',
    status: 'exited',
    exitCode: 0,
    summary: '真实 Runtime 摘要',
    favorite: true,
    archived: false,
    startedAt: '2026-06-13T00:00:00.000Z',
  };

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} />);

  expect(html).toContain('搜索会话');
  expect(html).toContain('真实 Runtime 摘要');
  expect(html).toContain('取消收藏');
  expect(html).toContain('生成摘要');
  expect(html).toContain('归档会话');
  expect(html).toContain('删除会话');
});

it('renders runtime restore and follow-up task actions for archived session view', () => {
  const session: AiRuntimeSession = {
    id: 'session-archived-1',
    projectId: 'project-1',
    command: 'codex',
    args: ['--version'],
    cwd: '/Users/david/hypha/zeus',
    status: 'exited',
    archived: true,
    startedAt: '2026-06-13T00:00:00.000Z',
  };

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} />);

  expect(html).toContain('恢复会话');
  expect(html).toContain('从会话创建任务');
});

it('renders Generic shell runtime high-risk confirmation controls without making it the default path', () => {
  const adapters: AiRuntimeAdapterDescriptor[] = [
    {
      id: 'codex',
      name: 'Codex CLI',
      displayName: 'OpenAI Codex CLI',
      command: 'codex',
      capabilities: ['detect'],
    },
    {
      id: 'generic',
      name: 'Generic CLI',
      displayName: '通用 CLI Adapter',
      command: 'sh',
      capabilities: ['detect'],
    },
  ];

  const html = renderToString(
    <App
      snapshot={createSnapshot()}
      initialRuntimeAdapters={adapters}
      onCreateRuntimeConfirmation={async () => ({
        id: 'runtime-confirm-1',
        action: 'start_generic_session',
        status: 'pending',
        riskLevel: 'high',
        reason: '用户确认 Generic shell',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'echo zeus-generic-runtime'],
          cwd: '/Users/david/hypha/zeus',
        },
        createdAt: '2026-06-14T00:00:00.000Z',
        confirmedAt: null,
        consumedAt: null,
      })}
      onConfirmRuntimeOperation={async () => ({
        id: 'runtime-confirm-1',
        action: 'start_generic_session',
        status: 'confirmed',
        riskLevel: 'high',
        reason: '用户确认 Generic shell',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'echo zeus-generic-runtime'],
          cwd: '/Users/david/hypha/zeus',
        },
        createdAt: '2026-06-14T00:00:00.000Z',
        confirmedAt: '2026-06-14T00:01:00.000Z',
        consumedAt: null,
      })}
    />,
  );

  expect(html).toContain('Generic shell 高风险确认');
  expect(html).toContain('Generic shell 命令');
  expect(html).toContain('例如 pnpm --version');
  expect(html).toContain('命令预览');
  expect(html).toContain('尚未输入 shell 命令');
  expect(html).toContain('创建 Generic shell 确认');
  expect(html).toContain('确认并启动 Generic shell');
  expect(html).toContain('确认只绑定本次 sh -lc');
});

it('renders adapter version, authentication state, and model configuration as explicit detection facts', () => {
  const adapters: AiRuntimeAdapterDescriptor[] = [
    {
      id: 'codex',
      name: 'Codex CLI',
      displayName: 'OpenAI Codex CLI',
      command: 'codex',
      capabilities: ['detect', 'prompt'],
    },
  ];
  const checks: Record<string, AiRuntimeAdapterStatus> = {
    codex: {
      ...adapters[0],
      available: true,
      reason: '检测到 Codex CLI: /opt/homebrew/bin/codex；版本 1.2.3。',
      version: '1.2.3',
      authStatus: 'authenticated',
      modelConfiguration: 'user-configured',
    },
  };

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeAdapters={adapters} initialRuntimeAdapterChecks={checks} />);

  expect(html).toContain('版本：1.2.3');
  expect(html).toContain('登录状态：已认证');
  expect(html).toContain('模型配置：用户配置');
  expect(html).toContain('能力：detect / prompt');
});

it('renders pending Generic shell runtime confirmation with an explicit reject action', () => {
  const adapters: AiRuntimeAdapterDescriptor[] = [
    {
      id: 'generic',
      name: 'Generic CLI',
      displayName: '通用 CLI Adapter',
      command: 'sh',
      capabilities: ['detect'],
    },
  ];
  const confirmation: RuntimeOperationConfirmation = {
    id: 'runtime-confirm-pending-1',
    action: 'start_generic_session',
    status: 'pending',
    riskLevel: 'high',
    reason: '用户确认 Generic shell',
    session: {
      projectId: 'project-1',
      command: 'sh',
      args: ['-lc', 'pnpm --version'],
      cwd: '/Users/david/hypha/zeus',
    },
    createdAt: '2026-06-14T00:00:00.000Z',
    confirmedAt: null,
    consumedAt: null,
  };

  const html = renderToString(
    <App
      snapshot={createSnapshot()}
      initialRuntimeAdapters={adapters}
      initialRuntimeGenericShellCommand="pnpm --version"
      initialRuntimeConfirmation={confirmation}
      onRejectRuntimeOperation={async () => ({
        ...confirmation,
        status: 'rejected',
        rejectedAt: '2026-06-14T00:02:00.000Z',
        rejectedReason: '用户拒绝 Generic shell',
      })}
    />,
  );

  expect(html).toContain('拒绝 Generic shell 确认');
  expect(html).toContain('拒绝后不会启动 Runtime 会话');
  expect(html).toContain('确认只绑定本次 sh -lc');
});

it('renders rejected Generic shell runtime confirmation as a terminal safe state', () => {
  const adapters: AiRuntimeAdapterDescriptor[] = [
    {
      id: 'generic',
      name: 'Generic CLI',
      displayName: '通用 CLI Adapter',
      command: 'sh',
      capabilities: ['detect'],
    },
  ];
  const confirmation: RuntimeOperationConfirmation = {
    id: 'runtime-confirm-rejected-1',
    action: 'start_generic_session',
    status: 'rejected',
    riskLevel: 'high',
    reason: '用户确认 Generic shell',
    session: {
      projectId: 'project-1',
      command: 'sh',
      args: ['-lc', 'pnpm --version'],
      cwd: '/Users/david/hypha/zeus',
    },
    createdAt: '2026-06-14T00:00:00.000Z',
    confirmedAt: null,
    consumedAt: null,
    rejectedAt: '2026-06-14T00:02:00.000Z',
    rejectedReason: '用户拒绝 Generic shell',
  };

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeAdapters={adapters} initialRuntimeGenericShellCommand="pnpm --version" initialRuntimeConfirmation={confirmation} />);

  expect(html).toContain('已拒绝 Generic shell 确认');
  expect(html).toContain('不会启动 Runtime 会话');
  expect(html).toContain('用户拒绝 Generic shell');
  expect(html).not.toContain('确认并启动 Generic shell</button>');
});

it('renders the extra typed phrase gate for critical Generic shell commands', () => {
  const adapters: AiRuntimeAdapterDescriptor[] = [
    {
      id: 'generic',
      name: 'Generic CLI',
      displayName: '通用 CLI Adapter',
      command: 'sh',
      capabilities: ['detect'],
    },
  ];

  const html = renderToString(
    <App
      snapshot={createSnapshot()}
      initialRuntimeAdapters={adapters}
      initialRuntimeGenericShellCommand="rm -rf dist"
      onCreateRuntimeConfirmation={async () => ({
        id: 'runtime-confirm-critical-1',
        action: 'start_generic_session',
        status: 'pending',
        riskLevel: 'high',
        reason: '用户确认 Generic shell',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'rm -rf dist'],
          cwd: '/Users/david/hypha/zeus',
        },
        createdAt: '2026-06-14T00:00:00.000Z',
        confirmedAt: null,
        consumedAt: null,
      })}
      onConfirmRuntimeOperation={async () => ({
        id: 'runtime-confirm-critical-1',
        action: 'start_generic_session',
        status: 'confirmed',
        riskLevel: 'high',
        reason: '用户确认 Generic shell',
        session: {
          projectId: 'project-1',
          command: 'sh',
          args: ['-lc', 'rm -rf dist'],
          cwd: '/Users/david/hypha/zeus',
        },
        createdAt: '2026-06-14T00:00:00.000Z',
        confirmedAt: '2026-06-14T00:01:00.000Z',
        consumedAt: null,
      })}
    />,
  );

  expect(html).toContain('高危命令确认短语');
  expect(html).toContain(GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE);
  expect(html).toContain('检测到高危命令，启动前必须完整输入');
});

it('renders runtime adapter registry without claiming unavailable tools are configured', () => {
  const adapters: AiRuntimeAdapterDescriptor[] = [
    {
      id: 'codex',
      name: 'Codex CLI',
      displayName: 'OpenAI Codex CLI',
      command: 'codex',
      capabilities: ['detect'],
    },
    {
      id: 'claude',
      name: 'Claude Code',
      displayName: 'Claude Code CLI',
      command: 'claude',
      capabilities: ['detect'],
    },
    {
      id: 'gemini',
      name: 'Gemini',
      displayName: 'Gemini CLI',
      command: 'gemini',
      capabilities: ['detect'],
    },
    {
      id: 'generic',
      name: 'Generic CLI',
      displayName: '通用 CLI Adapter',
      command: 'sh',
      capabilities: ['detect'],
    },
  ];

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeAdapters={adapters} />);

  expect(html).toContain('Runtime Adapters');
  expect(html).toContain('OpenAI Codex CLI');
  expect(html).toContain('Claude Code CLI');
  expect(html).toContain('Gemini CLI');
  expect(html).toContain('通用 CLI Adapter');
});

it('renders the persisted default runtime adapter setting without claiming availability', () => {
  const adapters: AiRuntimeAdapterDescriptor[] = [
    {
      id: 'codex',
      name: 'Codex CLI',
      displayName: 'OpenAI Codex CLI',
      command: 'codex',
      capabilities: ['detect'],
    },
    {
      id: 'claude',
      name: 'Claude Code',
      displayName: 'Claude Code CLI',
      command: 'claude',
      capabilities: ['detect'],
    },
  ];

  const html = renderToString(
    <App
      snapshot={createSnapshot()}
      initialMainNavTarget="settings"
      initialRuntimeAdapters={adapters}
      initialRuntimeSettings={{
        defaultAdapterId: 'claude',
        adapterModels: { claude: 'claude-sonnet-real' },
      }}
    />,
  );

  expect(html).toContain('默认 Runtime Adapter');
  expect(html).toContain('默认 Adapter 模型');
  expect(html).toContain('默认参数');
  expect(html).toContain('--ask-for-approval never');
  expect(html).toContain('保存默认 Adapter');
  expect(html).toContain('当前默认：Claude Code CLI');
  expect(html).toContain('claude-sonnet-real');
});

it('renders runtime execution settings for concurrency, shell, and terminal environment without claiming CLI availability', () => {
  const adapters: AiRuntimeAdapterDescriptor[] = [
    {
      id: 'codex',
      name: 'Codex CLI',
      displayName: 'OpenAI Codex CLI',
      command: 'codex',
      capabilities: ['detect'],
    },
  ];

  const html = renderToString(
    <App
      snapshot={createSnapshot()}
      initialMainNavTarget="settings"
      initialRuntimeAdapters={adapters}
      initialRuntimeSettings={{
        defaultAdapterId: 'codex',
        adapterModels: { codex: 'gpt-real' },
        adapterDefaultArgs: { codex: ['--ask-for-approval', 'never'] },
        adapterCliPaths: { codex: '/opt/homebrew/bin/codex' },
        autoConfirmationPolicy: 'low_risk_only',
        terminalEnv: { ZEUS_REAL_TASK: 'enabled' },
        shell: { path: '/bin/zsh', login: true },
        concurrency: { maxPerProject: 1, maxGlobal: 2 },
        executionTimeoutSeconds: 900,
        logRetentionDays: 14,
      }}
    />,
  );

  expect(html).toContain('Runtime 执行设置');
  expect(html).toContain('CLI 路径');
  expect(html).toContain('/opt/homebrew/bin/codex');
  expect(html).toContain('项目并发上限');
  expect(html).toContain('全局并发上限');
  expect(html).toContain('执行超时');
  expect(html).toContain('900 秒');
  expect(html).toContain('日志保留策略');
  expect(html).toContain('保留 14 天');
  expect(html).toContain('自动确认策略');
  expect(html).toContain('仅低风险');
  expect(html).toContain('不会绕过 Generic shell、Git 写入、删除文件等高风险确认。');
  expect(html).toContain('Shell 路径');
  expect(html).toContain('/bin/zsh');
  expect(html).toContain('作为 login shell 启动');
  expect(html).toContain('终端环境变量');
  expect(html).toContain('ZEUS_REAL_TASK=enabled');
  expect(html).toContain('环境变量会进入真实子进程；不会验证 CLI 已安装或已登录。');
});

it('renders runtime terminal control actions for a running session', () => {
  const session: AiRuntimeSession = {
    id: 'session-running-1',
    projectId: 'project-1',
    command: 'codex',
    args: [],
    cwd: '/Users/david/hypha/zeus',
    status: 'running',
    startedAt: '2026-06-13T00:00:00.000Z',
  };

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} />);

  expect(html).toContain('Runtime 输入');
  expect(html).toContain('发送 Runtime 输入');
  expect(html).toContain('Interrupt');
  expect(html).toContain('调整终端尺寸');
  expect(html).toContain('读取终端快照');
});

it('renders a terminate action for orphan detected runtime sessions without showing input controls', () => {
  const session: AiRuntimeSession = {
    id: 'session-orphan-1',
    projectId: 'project-1',
    command: 'codex',
    args: ['run'],
    cwd: '/Users/david/hypha/zeus',
    status: 'orphan_detected',
    pid: 444,
    startedAt: '2026-06-13T00:00:00.000Z',
  };

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} />);

  expect(html).toContain('orphan_detected');
  expect(html).toContain('终止孤儿会话');
  expect(html).not.toContain('发送 Runtime 输入');
});

it('renders runtime log search collapse copy and semantic highlights for collected logs', () => {
  const session: AiRuntimeSession = {
    id: 'session-log-tools-1',
    projectId: 'project-1',
    command: 'codex',
    args: ['run'],
    cwd: '/Users/david/hypha/zeus',
    status: 'exited',
    exitCode: 0,
    startedAt: '2026-06-13T00:00:00.000Z',
  };
  const logs: AiRuntimeLogEntry[] = [
    {
      id: 'log-command',
      sessionId: session.id,
      stream: 'system',
      text: '$ pnpm test',
      createdAt: '2026-06-13T00:00:00.000Z',
    },
    {
      id: 'log-ai',
      sessionId: session.id,
      stream: 'stdout',
      text: 'AI: 已完成真实分析',
      createdAt: '2026-06-13T00:00:01.000Z',
    },
    {
      id: 'log-error',
      sessionId: session.id,
      stream: 'stderr',
      text: 'Error: 真实失败',
      createdAt: '2026-06-13T00:00:02.000Z',
    },
  ];

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} initialRuntimeLogs={logs} />);

  expect(html).toContain('搜索日志');
  expect(html).toContain('复制当前日志');
  expect(html).toContain('折叠日志');
  expect(html).toContain('展开日志');
  expect(html).toContain('错误高亮');
  expect(html).toContain('命令高亮');
  expect(html).toContain('AI 回复高亮');
  expect(html).toContain('runtime-log-line error');
  expect(html).toContain('runtime-log-line command');
  expect(html).toContain('runtime-log-line ai');
});

it('renders release configuration status without claiming signing or notarization success', () => {
  const releaseUpdateStatus: ReleaseUpdateStatusSnapshot = {
    status: 'available',
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    channel: 'stable',
    releasePageUrl: 'https://github.com/imchenway/zeus/releases/tag/v0.2.0',
    artifact: {
      arch: 'arm64',
      kind: 'dmg',
      fileName: 'Zeus-0.2.0-arm64.dmg',
      sha256: 'arm-dmg-sha',
      sizeBytes: null,
      downloadUrl: 'https://github.com/imchenway/zeus/releases/download/v0.2.0/Zeus-0.2.0-arm64.dmg',
    },
    automaticInstallEnabled: false,
    recommendedAction: 'open_download_page',
    label: '发现新版本 · 0.2.0',
    reason: '发现新版本，但当前产物未同时签名和公证，只允许打开 GitHub Release 手动安装。',
    checkedAt: '2026-06-16T01:00:00.000Z',
  };
  const html = renderToString(
    <App
      snapshot={createSnapshot()}
      initialReleaseStatus={{
        signing: { configured: false, label: '等待 Apple 签名证书' },
        notarization: { configured: false, label: '等待 Apple 公证凭据' },
        homebrewCask: { configured: true, label: '已检测到 Casks/zeus.rb' },
        releaseWorkflow: {
          configured: true,
          label: '已检测到 GitHub Release workflow',
        },
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
      }}
      initialReleaseUpdateStatus={releaseUpdateStatus}
      onCheckReleaseUpdate={async () => releaseUpdateStatus}
    />,
  );

  expect(html).toContain('发布与签名');
  expect(html).toContain('等待 Apple 签名证书');
  expect(html).toContain('等待 Apple 公证凭据');
  expect(html).toContain('已检测到 Casks/zeus.rb');
  expect(html).toContain('不会伪造签名或 notarization 成功');
  expect(html).toContain('unsigned 构建可用');
  expect(html).toContain('Apple signing certificate');
  expect(html).toContain('Apple notarization credentials');
  expect(html).toContain('自动更新预留');
  expect(html).toContain('手动更新 · 0.1.0');
  expect(html).toContain('docs/release.md');
  expect(html).toContain('signed and notarized artifacts');
  expect(html).toContain('检查更新');
  expect(html).toContain('当前版本：0.1.0');
  expect(html).toContain('最新版本：0.2.0');
  expect(html).toContain('GitHub Release');
  expect(html).toContain('下载安装需要签名与公证');
  expect(html).toContain('Zeus-0.2.0-arm64.dmg');
});

it('renders active PTY terminal dependency status when node-pty and xterm are available', () => {
  const html = renderToString(
    <App
      snapshot={createSnapshot()}
      initialRuntimeStatus={{
        aiCli: {
          name: 'Codex CLI',
          command: 'codex',
          available: true,
          reason: '检测到 Codex CLI',
        },
        telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
        terminal: {
          provider: 'node-pty',
          pty: {
            available: true,
            reason: 'node-pty 已可用，xterm 终端已启用。',
          },
        },
      }}
    />,
  );

  expect(html).toContain('终端后端');
  expect(html).toContain('node-pty');
  expect(html).toContain('xterm 终端已启用');
  expect(html).not.toContain('node-pty 依赖未安装');
});
