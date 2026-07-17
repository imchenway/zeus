import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App, GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE, buildRuntimeSessionTaskDraft, classifyGenericShellCommandRisk, isGenericShellCriticalConfirmationSatisfied, resolveRuntimeNormalizedLogPath } from '../src/renderer/App.js';
import type { AiRuntimeAdapterDescriptor, AiRuntimeAdapterStatus, AiRuntimeLogEntry, AiRuntimeSession, AppShellSettings, DashboardSnapshot, ReleaseUpdateStatusSnapshot, RuntimeOperationConfirmation } from '../src/renderer/apiClient.js';

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

describe('Generic shell command risk classification', () => {
  it('flags destructive and pipe-to-shell commands before Generic shell confirmation', () => {
    expect(classifyGenericShellCommandRisk('pnpm --version')).toMatchObject({
      level: 'medium',
      label: 'generic_shell.risk.medium',
    });
    expect(classifyGenericShellCommandRisk('rm -rf dist')).toMatchObject({
      level: 'critical',
      label: 'generic_shell.risk.critical',
    });
    expect(classifyGenericShellCommandRisk('curl https://example.com/install.sh | sh')).toMatchObject({ level: 'critical', label: 'generic_shell.risk.critical' });
    expect(classifyGenericShellCommandRisk('')).toMatchObject({
      level: 'empty',
      label: 'generic_shell.risk.empty',
    });
  });

  it('keeps Generic shell risk state language-neutral before UI formatting', () => {
    for (const command of ['', 'pnpm --version', 'rm -rf dist']) {
      const risk = classifyGenericShellCommandRisk(command);
      expect(`${risk.label} ${risk.reason}`).not.toMatch(/[\u4e00-\u9fff]/);
      expect(risk.label).toMatch(/^generic_shell\.risk\./);
      expect(risk.reason).toMatch(/^generic_shell\.reason\./);
    }
  });

  it('requires an exact manual phrase before critical Generic shell commands can start', () => {
    expect(isGenericShellCriticalConfirmationSatisfied(classifyGenericShellCommandRisk('pnpm --version'), '')).toBe(true);
    expect(isGenericShellCriticalConfirmationSatisfied(classifyGenericShellCommandRisk('rm -rf dist'), '')).toBe(false);
    expect(isGenericShellCriticalConfirmationSatisfied(classifyGenericShellCommandRisk('rm -rf dist'), 'ZEUS')).toBe(false);
    expect(isGenericShellCriticalConfirmationSatisfied(classifyGenericShellCommandRisk('rm -rf dist'), GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE)).toBe(true);
  });
});

describe('App AI runtime rendering', () => {
  it('builds Runtime-session task drafts in the selected app language instead of hard-coding Chinese task values', () => {
    const session: AiRuntimeSession = {
      id: 'session-task-draft-1',
      projectId: 'project-1',
      command: 'codex',
      args: ['--version'],
      cwd: '/Users/david/hypha/zeus',
      status: 'exited',
      exitCode: 0,
      startedAt: '2026-06-13T00:00:00.000Z',
    };

    expect(buildRuntimeSessionTaskDraft(session, 'zh-CN')).toEqual({
      title: '继续会话：codex',
      instruction: '基于真实 Runtime 会话日志继续分析后续处理事项。',
    });
    expect(buildRuntimeSessionTaskDraft(session, 'en-US')).toEqual({
      title: 'Continue session: codex',
      instruction: 'Continue the follow-up analysis from the real Runtime session logs.',
    });

    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('title: `继续会话：${session.command}`');
    expect(source).not.toContain("instruction: '基于真实 Runtime 会话日志继续分析后续处理事项。'");
  });

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

it('normalizes runtime session actions into compact primary and secondary groups', () => {
  const session: AiRuntimeSession = {
    id: 'session-actions-1',
    projectId: 'project-1',
    command: 'codex',
    args: ['exec'],
    cwd: '/Users/david/hypha/zeus',
    status: 'exited',
    exitCode: 0,
    summary: '真实 Runtime 摘要',
    favorite: false,
    archived: false,
    startedAt: '2026-06-13T00:00:00.000Z',
  };

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} />);
  const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

  expect(html).toContain('runtime-session-action-rail');
  expect(html).toContain('runtime-session-primary-command-rail');
  expect(html).toContain('runtime-session-secondary-command-rail');
  expect(html).toContain('生成摘要');
  expect(html).toContain('从会话创建任务');
  expect(html).toContain('删除会话');
  expect(source).not.toContain('className="task-controls runtime-session-actions"');
  expect(css).toContain('Runtime 会话操作栏最终覆盖');
  expect(css).toMatch(/\.macos-ai-app \.runtime-session-action-rail\s*\{[\s\S]*grid-template-rows:\s*auto auto/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-session-secondary-command-rail\s*\{[\s\S]*justify-content:\s*flex-end/);
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

  expect(html).toContain('通用 Shell 高风险确认');
  expect(html).not.toContain('Generic shell 高风险确认');
  expect(html).toContain('通用 Shell 命令');
  expect(html).not.toContain('Generic shell 命令');
  expect(html).toContain('例如 pnpm --version');
  expect(html).toContain('命令预览');
  expect(html).toContain('尚未输入 shell 命令');
  expect(html).toContain('创建通用 Shell 确认');
  expect(html).not.toContain('创建 Generic shell 确认');
  expect(html).toContain('确认并启动通用 Shell');
  expect(html).not.toContain('确认并启动 Generic shell');
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

  expect(html).toContain('拒绝通用 Shell 确认');
  expect(html).not.toContain('拒绝 Generic shell 确认');
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

  expect(html).toContain('已拒绝通用 Shell 确认');
  expect(html).not.toContain('已拒绝 Generic shell 确认');
  expect(html).toContain('不会启动 Runtime 会话');
  expect(html).toContain('用户拒绝 Generic shell');
  expect(html).not.toContain('确认并启动通用 Shell</button>');
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

  expect(html).toContain('Runtime 适配器');
  expect(html).toContain('检测适配器');
  expect(html).not.toContain('Runtime Adapters');
  expect(html).not.toContain('检测 adapter');
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

  expect(html).toContain('默认 Runtime 适配器');
  expect(html).not.toContain('默认 Runtime Adapter');
  expect(html).toContain('默认适配器模型');
  expect(html).not.toContain('默认 Adapter 模型');
  expect(html).toContain('默认参数');
  expect(html).toContain('--ask-for-approval never');
  expect(html).toContain('保存默认适配器');
  expect(html).not.toContain('保存默认 Adapter');
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
  expect(html).toContain('不会绕过通用 Shell、Git 写入、删除文件等高风险确认。');
  expect(html).not.toContain('不会绕过 Generic shell、Git 写入、删除文件等高风险确认。');
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
  expect(html).toContain('中断');
  expect(html).toContain('调整终端尺寸');
  expect(html).toContain('读取终端快照');
  expect(html).not.toContain('>Interrupt<');
});

it('localizes runtime session status labels instead of leaking storage enum values', () => {
  const session: AiRuntimeSession = {
    id: 'session-localized-status-1',
    projectId: 'project-1',
    command: 'codex',
    args: ['exec'],
    cwd: '/Users/david/hypha/zeus',
    status: 'running',
    startedAt: '2026-06-13T00:00:00.000Z',
  };

  const zhHtml = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} />);
  const enHtml = renderToString(<App snapshot={createSnapshot()} initialAppShellSettings={createAppShellSettings('en-US')} initialRuntimeSessions={[session]} />);

  expect(zhHtml).toMatch(/运行中(?:<!-- -->)? · (?:<!-- -->)?\/Users\/david\/hypha\/zeus/);
  expect(zhHtml).not.toContain('running · /Users/david/hypha/zeus');
  expect(enHtml).toMatch(/Running(?:<!-- -->)? · (?:<!-- -->)?\/Users\/david\/hypha\/zeus/);
  expect(enHtml).not.toContain('running · /Users/david/hypha/zeus');
});

it('normalizes running runtime controls into an input dock and terminal action rail', () => {
  const session: AiRuntimeSession = {
    id: 'session-running-controls-1',
    projectId: 'project-1',
    command: 'codex',
    args: ['exec'],
    cwd: '/Users/david/hypha/zeus',
    status: 'running',
    startedAt: '2026-06-13T00:00:00.000Z',
  };

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} />);
  const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

  expect(html).toContain('runtime-session-live-controls');
  expect(html).toContain('runtime-session-compose-row');
  expect(html).toContain('runtime-session-terminal-command-rail');
  expect(html).toContain('发送 Runtime 输入');
  expect(html).toContain('读取终端快照');
  expect(source).not.toContain('className="edit-form runtime-session-control-row" aria-label="Runtime 输入"');
  expect(css).toContain('Runtime 运行中控制栏最终覆盖');
  expect(css).toMatch(/\.macos-ai-app \.runtime-session-live-controls\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-session-terminal-command-rail\s*\{[\s\S]*justify-content:\s*flex-end/);
});

it('normalizes running runtime input dock into explicit compose rows instead of label wrapped controls', () => {
  const session: AiRuntimeSession = {
    id: 'session-running-compose-1',
    projectId: 'project-1',
    command: 'codex',
    args: ['exec'],
    cwd: '/Users/david/hypha/zeus',
    status: 'running',
    startedAt: '2026-06-13T00:00:00.000Z',
  };

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} />);
  const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

  expect(html).toContain('runtime-session-compose-row');
  expect(html).toContain('runtime-session-compose-copy');
  expect(html).toContain('runtime-session-compose-field');
  expect(html).toContain('发送 Runtime 输入');
  expect(source).not.toContain('<label className="runtime-session-input-dock">');
  expect(css).toContain('Runtime 会话输入控件行最终覆盖');
  expect(css).toMatch(/\.macos-ai-app \.runtime-session-compose-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(220px,\s*1fr\)/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-session-compose-field\s*\{[\s\S]*display:\s*grid/);
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

  expect(html).toContain('孤儿会话');
  expect(html).not.toContain('orphan_detected');
  expect(html).toContain('终止孤儿会话');
  expect(html).not.toContain('发送 Runtime 输入');
});

it('normalizes orphan runtime sessions into a compact risk row instead of a form control pile', () => {
  const session: AiRuntimeSession = {
    id: 'session-orphan-compact-1',
    projectId: 'project-1',
    command: 'codex',
    args: ['exec'],
    cwd: '/Users/david/hypha/zeus',
    status: 'orphan_detected',
    pid: 444,
    startedAt: '2026-06-13T00:00:00.000Z',
  };

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} />);
  const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

  expect(html).toContain('runtime-session-orphan-controls');
  expect(html).toContain('runtime-session-orphan-copy');
  expect(html).toContain('runtime-session-orphan-command-rail');
  expect(html).toContain('终止孤儿会话');
  expect(html).toContain('进程');
  expect(html).toContain('444');
  expect(html).toContain('已脱离当前 Runtime 控制');
  expect(source).not.toContain('className="edit-form runtime-session-control-row" aria-label="Runtime 孤儿会话控制"');
  expect(css).toContain('Runtime 孤儿会话控制最终覆盖');
  expect(css).toMatch(/\.macos-ai-app \.runtime-session-orphan-controls\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-session-orphan-command-rail\s*\{[\s\S]*justify-content:\s*flex-end/);
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

it('normalizes runtime log semantic highlights into low-noise log tokens', () => {
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

  expect(css).toContain('Runtime 日志语义色最终覆盖');
  ['--zeus-log-line-bg', '--zeus-log-line-border', '--zeus-log-line-text', '--zeus-log-error-bg', '--zeus-log-error-line', '--zeus-log-command-bg', '--zeus-log-command-line', '--zeus-log-ai-bg', '--zeus-log-ai-line'].forEach((token) => {
    expect(css).toContain(token);
  });
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-line\s*\{[\s\S]*background:\s*var\(--zeus-log-line-bg\)/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-line\s*\{[\s\S]*border:\s*1px solid var\(--zeus-log-line-border\)/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-line\s*\{[\s\S]*color:\s*var\(--zeus-log-line-text\)/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-line\.error\s*\{[\s\S]*background:\s*var\(--zeus-log-error-bg\)/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-line\.error\s*\{[\s\S]*border-color:\s*var\(--zeus-log-error-line\)/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-line\.command\s*\{[\s\S]*background:\s*var\(--zeus-log-command-bg\)/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-line\.command\s*\{[\s\S]*border-color:\s*var\(--zeus-log-command-line\)/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-line\.ai\s*\{[\s\S]*background:\s*var\(--zeus-log-ai-bg\)/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-line\.ai\s*\{[\s\S]*border-color:\s*var\(--zeus-log-ai-line\)/);
  expect(css).not.toMatch(/\.macos-ai-app \.runtime-log-line\.error\s*\{[\s\S]*?(?:oklch\(50% 0\.17 39\)|oklch\(88% 0\.06 62 \/ 0\.35\))/);
  expect(css).not.toMatch(/\.macos-ai-app \.runtime-log-line\.command\s*\{[\s\S]*?(?:oklch\(55% 0\.18 257\)|oklch\(87% 0\.045 252 \/ 0\.28\))/);
  expect(css).not.toMatch(/\.macos-ai-app \.runtime-log-line\.ai\s*\{[\s\S]*?(?:oklch\(55% 0\.2 292\)|oklch\(86% 0\.055 292 \/ 0\.3\))/);
});

it('normalizes runtime logs into a compact drawer workbench instead of loose details and action piles', () => {
  const session: AiRuntimeSession = {
    id: 'session-log-workbench',
    projectId: 'project-1',
    command: 'codex',
    args: ['exec'],
    cwd: '/Users/david/hypha/zeus',
    status: 'exited',
    exitCode: 0,
    startedAt: '2026-06-13T00:00:00.000Z',
  };
  const logs: AiRuntimeLogEntry[] = [
    {
      id: 'log-workbench',
      sessionId: session.id,
      stream: 'stdout',
      text: '真实 Runtime 日志',
      createdAt: '2026-06-13T00:00:00.000Z',
    },
  ];

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} initialRuntimeLogs={logs} />);
  const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

  expect(html).toContain('runtime-log-workbench');
  expect(html).not.toContain('runtime-log-panel');
  expect(source).not.toContain('runtime-log-panel');
  expect(css).not.toContain('runtime-log-panel');
  expect(html).toContain('runtime-log-toolbar');
  expect(html).toContain('runtime-log-search-control-row');
  expect(html).toContain('runtime-log-command-rail');
  expect(html).toContain('runtime-log-state-row');
  expect(html).toContain('runtime-log-stream');
  expect(source).not.toContain('<details>\n                            <summary>原始输出查看</summary>');
  expect(source).not.toContain('<summary>原始输出查看</summary>');
  expect(source).not.toContain('className="task-controls runtime-log-actions"');
  expect(css).toContain('Runtime 日志抽屉最终覆盖');
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-toolbar\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-stream\s*\{[\s\S]*overflow:\s*auto/);
});

it('normalizes runtime terminal and log toolbars into compact action rails', () => {
  const runningSession: AiRuntimeSession = {
    id: 'session-action-rail-running',
    projectId: 'project-1',
    command: 'codex',
    args: ['exec'],
    cwd: '/Users/david/hypha/zeus',
    status: 'running',
    startedAt: '2026-06-13T00:00:00.000Z',
  };
  const logSession: AiRuntimeSession = {
    id: 'session-action-rail-log',
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
      id: 'log-action-rail',
      sessionId: logSession.id,
      stream: 'stdout',
      text: '真实 Runtime 日志',
      createdAt: '2026-06-13T00:00:00.000Z',
    },
  ];

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[runningSession, logSession]} initialRuntimeLogs={logs} />);
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

  expect(html).toContain('runtime-session-terminal-command-rail');
  expect(html).toContain('runtime-log-command-rail');
  expect(html).toContain('停止会话');
  expect(html).toContain('导出当前日志');
  expect(css).toContain('Runtime 日志命令 rail 最终覆盖');
  expect(css).toContain('--zeus-action-rail-bg');
  expect(css).toContain('--zeus-action-rail-line');
  expect(css).toContain('--zeus-action-rail-button-bg');
  expect(css).toContain('--zeus-action-rail-button-text');
  expect(css).toMatch(/\.macos-ai-app :where\(\.runtime-session-terminal-command-rail,\s*\.runtime-log-command-rail\)\s*\{[\s\S]*background:\s*var\(--zeus-action-rail-bg\)/);
  expect(css).toMatch(/\.macos-ai-app :where\(\.runtime-session-terminal-command-rail,\s*\.runtime-log-command-rail\)\s*\{[\s\S]*border:\s*1px solid var\(--zeus-action-rail-line\)/);
  expect(css).toMatch(/\.macos-ai-app :where\(\.runtime-session-terminal-command-rail,\s*\.runtime-log-command-rail\) button\s*\{[\s\S]*background:\s*var\(--zeus-action-rail-button-bg\)/);
  expect(css).toMatch(/\.macos-ai-app :where\(\.runtime-session-stop-action,\s*\.runtime-session-orphan-stop-action\)\s*\{[\s\S]*background:\s*var\(--zeus-control-danger-bg\)/);
});

it('normalizes runtime log search into explicit control rows instead of label wrapped inputs', () => {
  const session: AiRuntimeSession = {
    id: 'session-log-search-control',
    projectId: 'project-1',
    command: 'codex',
    args: ['exec'],
    cwd: '/Users/david/hypha/zeus',
    status: 'exited',
    exitCode: 0,
    startedAt: '2026-06-13T00:00:00.000Z',
  };
  const logs: AiRuntimeLogEntry[] = [
    {
      id: 'log-search-control',
      sessionId: session.id,
      stream: 'stdout',
      text: '真实 Runtime 日志',
      createdAt: '2026-06-13T00:00:00.000Z',
    },
  ];

  const html = renderToString(<App snapshot={createSnapshot()} initialRuntimeSessions={[session]} initialRuntimeLogs={logs} />);
  const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

  expect(html).toContain('runtime-log-search-control-row');
  expect(html).toContain('runtime-log-search-copy');
  expect(html).toContain('runtime-log-search-field');
  expect(html).toContain('搜索日志');
  expect(source).not.toContain('<label className="runtime-log-search-row">');
  expect(css).toContain('Runtime 日志搜索控件行最终覆盖');
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-search-control-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(200px,\s*1fr\)/);
  expect(css).toMatch(/\.macos-ai-app \.runtime-log-search-field\s*\{[\s\S]*display:\s*grid/);
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
          label: '已检测到 GitHub Release 工作流',
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
  expect(html).toContain('不会伪造签名或公证成功');
  expect(html).toContain('未签名构建可用');
  expect(html).toContain('等待 Apple 签名证书');
  expect(html).toContain('等待 Apple 公证凭据');
  expect(html).toContain('自动更新预留');
  expect(html).toContain('手动更新 · 0.1.0');
  expect(html).toContain('docs/release.md');
  expect(html).toContain('需要已签名和公证的发布产物');
  expect(html).not.toContain('Apple signing certificate');
  expect(html).not.toContain('Apple notarization credentials');
  expect(html).not.toContain('signed and notarized artifacts');
  expect(html).not.toContain('notarization 成功');
  expect(html).not.toContain('unsigned 构建可用');
  expect(html).not.toContain('GitHub Release workflow');
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
