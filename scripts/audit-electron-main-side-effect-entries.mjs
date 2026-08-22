import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const repositoryRoot = resolve(process.cwd());
const mainSourceRoot = join(repositoryRoot, 'apps/desktop/src/main');
const requireComplete = process.argv.includes('--require-complete');
const ipcDeclarations = createIpcDeclarations();
const nativeActionDeclarations = createNativeActionDeclarations();
const sources = new Map();
const sourceHash = createHash('sha256');
const startupEvidenceFiles = [
  'apps/desktop/src/main/beforeQuitCleanup.ts',
  'apps/desktop/src/main/browserHost.ts',
  'apps/desktop/src/main/executionHost.ts',
  'apps/desktop/src/main/executionHostProtocol.ts',
  'apps/desktop/src/main/localServerRuntime.ts',
  'apps/desktop/src/main/main.ts',
  'apps/desktop/src/main/readOnlyValidationCodexManager.ts',
  'apps/desktop/src/main/readOnlyValidationIpcFence.ts',
  'apps/desktop/src/main/readOnlyValidationManifest.ts',
  'packages/local-server/src/commandCenter.ts',
  'packages/local-server/src/heavyWorkerPool.ts',
  'packages/local-server/src/index.ts',
  'packages/local-server/src/gitIntegrationOperations.ts',
  'packages/local-server/src/localServerPlatformRoutes.ts',
  'packages/local-server/src/localServerSupportOperations.ts',
  'packages/local-server/src/taskRuntimeOperations.ts',
  'packages/local-server/src/readOnlyValidation.ts',
  'packages/local-server/src/telegramPollingApi.ts',
  'packages/shared/src/readOnlyValidation.ts',
  'packages/storage/src/index.ts',
  'scripts/create-zeus-test-database-copy.ts',
  'scripts/verify-read-only-validation-bootstrap-security.ts',
  'scripts/verify-read-only-validation-fence.ts',
  'scripts/verify-read-only-validation-ipc-fence.ts',
  'scripts/verify-main-command-ledger-behavior.ts',
];

for (const absolutePath of (await collectTypeScriptFiles(mainSourceRoot)).sort()) {
  const file = relative(repositoryRoot, absolutePath).split('\\').join('/');
  const content = await readFile(absolutePath, 'utf8');
  sources.set(file, content);
  sourceHash.update(`${file}\0${content}\0`);
}

const startupSources = new Map(sources);
const startupSourceHash = createHash('sha256');
for (const file of startupEvidenceFiles) {
  const content = startupSources.get(file) ?? (await readFile(join(repositoryRoot, file), 'utf8'));
  startupSources.set(file, content);
  startupSourceHash.update(`${file}\0${content}\0`);
}

const ipcRegistrations = discoverIpcRegistrations(sources);
const nativeActions = discoverNativeMenuActions(sources);
const declarationErrors = [];
const entries = [];
const nonMutatingEntries = [];

for (const registration of ipcRegistrations) {
  const declaration = ipcDeclarations.get(registration.channel);
  if (!declaration) {
    declarationErrors.push(`IPC ${registration.channel} at ${registration.file}:${registration.line} has no exact declaration.`);
    continue;
  }
  if (declaration.file !== registration.file) {
    declarationErrors.push(`IPC ${registration.channel} moved from declared ${declaration.file} to ${registration.file}:${registration.line}.`);
  }
  const missingMarkers = declaration.requiredMarkers.filter((marker) => !registration.handlerText.includes(marker));
  if (missingMarkers.length > 0) {
    declarationErrors.push(`IPC ${registration.channel} is missing evidence marker(s): ${missingMarkers.join(', ')}.`);
  }
  const base = {
    id: stableEntryId('ipc', registration.file, registration.channel),
    boundaryKind: `ipc_${registration.registrationKind}`,
    file: registration.file,
    line: registration.line,
    operation: `${registration.registrationKind} ${registration.channel}`,
    channel: registration.channel,
    effect: declaration.effect,
    reason: declaration.reason,
    confirmationSemantics: declaration.confirmation,
    idempotencySemantics: declaration.idempotency,
  };
  if (declaration.effect === 'non_mutating') {
    nonMutatingEntries.push(base);
  } else {
    entries.push({
      ...base,
      classification: declaration.classification,
      commandBoundary: declaration.commandBoundary,
    });
  }
}

for (const channel of ipcDeclarations.keys()) {
  if (!ipcRegistrations.some((entry) => entry.channel === channel)) declarationErrors.push(`Declared IPC ${channel} no longer exists.`);
}

for (const action of nativeActions) {
  const declaration = nativeActionDeclarations.get(action.action);
  if (!declaration) {
    declarationErrors.push(`Native menu/tray action ${action.action} has no exact declaration.`);
    continue;
  }
  const mainSource = sources.get('apps/desktop/src/main/main.ts') ?? '';
  const missingMarkers = declaration.requiredMainMarkers.filter((marker) => !mainSource.includes(marker));
  if (missingMarkers.length > 0) declarationErrors.push(`Native action ${action.action} is missing Main evidence marker(s): ${missingMarkers.join(', ')}.`);
  entries.push({
    id: stableEntryId('native_action', action.file, action.action),
    boundaryKind: 'native_menu_or_tray',
    file: action.file,
    line: action.line,
    operation: `native action ${action.action}`,
    channel: null,
    effect: declaration.effect,
    classification: declaration.classification,
    reason: declaration.reason,
    confirmationSemantics: declaration.confirmation,
    idempotencySemantics: declaration.idempotency,
    commandBoundary: declaration.commandBoundary,
  });
}

for (const action of nativeActionDeclarations.keys()) {
  if (!nativeActions.some((entry) => entry.action === action)) declarationErrors.push(`Declared native action ${action} no longer exists.`);
}

const primitiveVerification = verifySensitivePrimitives(sources, entries, nonMutatingEntries);
for (const [name, passed] of Object.entries(primitiveVerification)) {
  if (!passed) declarationErrors.push(`Sensitive primitive verification failed: ${name}.`);
}

const isolatedCopyStartupRisks = createIsolatedCopyStartupRisks();
for (const entry of isolatedCopyStartupRisks) {
  for (const evidence of entry.evidence) {
    const content = startupSources.get(evidence.file);
    if (!content) {
      declarationErrors.push(`Startup risk ${entry.id} refers to unread evidence file ${evidence.file}.`);
      continue;
    }
    const missingMarkers = evidence.requiredMarkers.filter((marker) => !content.includes(marker));
    if (missingMarkers.length > 0) {
      declarationErrors.push(`Startup risk ${entry.id} is missing evidence marker(s) in ${evidence.file}: ${missingMarkers.join(', ')}.`);
    }
  }
}
const startupTopologyVerification = verifyStartupTopology(startupSources);
for (const [name, passed] of Object.entries(startupTopologyVerification.guards)) {
  if (!passed) declarationErrors.push(`Isolated-copy startup topology verification failed: ${name}.`);
}
if (startupTopologyVerification.observations.readOnlyFenceIntegrated) {
  for (const entry of isolatedCopyStartupRisks) entry.readOnlyFenceStatus = 'integrated';
}

entries.sort(compareEntries);
nonMutatingEntries.sort(compareEntries);
const counts = countBy(entries, (entry) => entry.classification);
const pendingCount = counts.pending ?? 0;
const startupBehaviorCounts = countBy(isolatedCopyStartupRisks, (entry) => entry.startupBehavior);
const inventoryComplete = declarationErrors.length === 0;
const migrationComplete = inventoryComplete && pendingCount === 0;

const report = {
  schemaVersion: 2,
  generatedFrom: {
    root: 'apps/desktop/src/main',
    sha256: sourceHash.digest('hex'),
    isolatedCopyStartupEvidenceFiles: startupEvidenceFiles,
    isolatedCopyStartupEvidenceSha256: startupSourceHash.digest('hex'),
  },
  scope: {
    included: [
      'all literal ipcMain.handle/on registrations below apps/desktop/src/main',
      'all native app-menu/tray actions declared by appShellPolicy.ts',
      'public shell, filesystem, Git, update, clipboard and keychain mutation primitives reachable from those boundaries',
      'isolated Zeus Test startup paths that can consume copied durable state and reach Git/worktree, Provider, Telegram, Runtime, Command Center, Heavy Worker, release/update or Browser capabilities',
    ],
    excluded: [
      'crash logging and release-installer internals not reachable from a public Main boundary or one of the explicitly listed isolated-copy startup paths',
      'Local Server HTTP mutations audited by audit-command-side-effect-entries.mjs',
      'Renderer-only browser tool transport that does not register an Electron Main boundary',
    ],
  },
  summary: {
    discoveredIpcRegistrations: ipcRegistrations.length,
    discoveredNativeActions: nativeActions.length,
    nonMutatingRegistrations: nonMutatingEntries.length,
    sideEffectBoundaries: entries.length,
    byClassification: {
      integrated: counts.integrated ?? 0,
      platform_capability_excluded: counts.platform_capability_excluded ?? 0,
      pending: pendingCount,
    },
    inventoryComplete,
    migrationComplete,
    isolatedCopyStartupRisks: {
      total: isolatedCopyStartupRisks.length,
      byBehavior: startupBehaviorCounts,
      readOnlyFenceIntegrated: isolatedCopyStartupRisks.filter((entry) => entry.readOnlyFenceStatus === 'integrated').length,
      readOnlyFencePending: isolatedCopyStartupRisks.filter((entry) => entry.readOnlyFenceStatus === 'pending').length,
    },
  },
  classificationSemantics: {
    integrated: 'The exact Main boundary consumes a Command Envelope and has durable Inbox/Outbox/receipt evidence.',
    platform_capability_excluded: 'The exact boundary only projects or invokes a user-confirmed OS/UI capability; its confirmation and retry semantics are declared per entry.',
    pending: 'The boundary can mutate durable files, Core/runtime state, Git, browser workflow state or an external update operation without a complete Command ledger.',
  },
  primitiveVerification,
  startupTopologyVerification,
  declarationErrors,
  nonMutatingEntries,
  entries,
  isolatedCopyStartupRisks,
  proposedTestReadOnlyValidationFence: createProposedTestReadOnlyValidationFence(startupTopologyVerification.observations.readOnlyFenceIntegrated),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!inventoryComplete) process.exitCode = 1;
else if (requireComplete && !migrationComplete) process.exitCode = 2;

function createIsolatedCopyStartupRisks() {
  return [
    startupRisk({
      id: 'core_database_startup_reconciliation',
      domain: 'Core/SQLite',
      startupBehavior: 'automatic_local_copy_mutation',
      consequence: '打开副本后会执行 schema/附件/投影/Command 写出封存、handoff 与扫描恢复，并至少提交一次 SQLite；因此当前启动不是只读投影启动。',
      evidence: [
        startupEvidence('packages/local-server/src/index.ts', [
          'const db = await createZeusDatabase(options.dbPath, { readOnlyValidation: options.readOnlyValidation });',
          'const attachmentRepair = readOnlyValidation ?',
          'await projectionDatabases.start();',
          'commandDeliveries.sealUnreceiptedProviderWritesAsUnknown(',
          'executionHostHandoffs.recoverPrepared({',
          'projects.recoverInterruptedScans()',
        ]),
      ],
      fencePolicy: '必须在 createZeusDatabase 和任何 repair/recovery 之前选择只读数据库端口；schema 不兼容时失败关闭，不能在验证进程中迁移副本。',
    }),
    startupRisk({
      id: 'codex_remote_control_restore',
      domain: 'Provider/Remote Control',
      startupBehavior: 'automatic_external_effect_possible',
      consequence: '副本中的 remote-control enabled 设置会在 Core 启动时 ensureReady，可能启动 Codex 进程并启用真实远程控制网络能力。',
      evidence: [
        startupEvidence('packages/local-server/src/index.ts', ['if (executionHostDispatchMayResume && codexNativeEnabled && codexRemoteControlEnabled)', '.ensureReady({', '.then(() => codexAppServerManager.enableRemoteControl())']),
      ],
      fencePolicy: '验证模式不得构造或启动 Provider manager，remote-control 恢复固定返回 blocked_by_read_only_validation。',
    }),
    startupRisk({
      id: 'codex_legacy_thread_migration',
      domain: 'Provider/Legacy Thread',
      startupBehavior: 'automatic_external_effect_possible',
      consequence: '只要 Codex enabled，启动即执行旧线程迁移；迁移可调用 Provider 列表/读取并写入副本数据库。',
      evidence: [startupEvidence('packages/local-server/src/index.ts', ['const migration = await migrateLegacyCodexThreads({', "action: 'conversation.legacy_codex_threads.migrate'"])],
      fencePolicy: '验证模式跳过迁移并暴露 migration_required 只读诊断，不得读取正式 CODEX_HOME 或启动 CLI。',
    }),
    startupRisk({
      id: 'codex_legacy_import_recovery',
      domain: 'Provider/Legacy Import',
      startupBehavior: 'automatic_external_effect_possible',
      consequence: '存在旧版导入根时，启动会恢复未完成导入；它可访问 Provider/文件系统并推进副本中的导入状态。',
      evidence: [startupEvidence('packages/local-server/src/index.ts', ['codexLegacyImportService = createCodexLegacyImportService({', 'await codexLegacyImportService.recover();'])],
      fencePolicy: '验证模式不创建恢复服务；仅返回复制库中既有导入状态和明确的 skipped_by_validation 诊断。',
    }),
    startupRisk({
      id: 'codex_native_conversation_recovery',
      domain: 'Provider/Codex Native',
      startupBehavior: 'automatic_external_effect_possible',
      consequence: '副本含原生绑定或 recoverable submission 时，启动调用 coordinator.recover，可启动/查询 Provider 并写恢复投影。',
      evidence: [startupEvidence('packages/local-server/src/index.ts', ["conversations.listNativeBoundRecords('codex').length > 0", 'conversationSubmissions.listRecoverable()', 'await codexNativeCoordinator.recover();'])],
      fencePolicy: '验证模式禁止 coordinator.recover 和任何 Provider write/read RPC；页面只展示复制库已有 Snapshot 与“Provider 未连接”标记。',
    }),
    startupRisk({
      id: 'codex_usage_background_refresh',
      domain: 'Provider/Usage',
      startupBehavior: 'automatic_external_effect_possible',
      consequence: '计时器本身不会冷启动 Codex，但一旦其他恢复把 manager 置为 ready，每 60 秒会访问真实 Provider 用量端口并更新副本投影。',
      evidence: [
        startupEvidence('packages/local-server/src/index.ts', ["if (codexAppServerManager.getState().type !== 'ready') return;", 'const official = await codexUsageService.refreshOfficialUsage();', 'usageRefreshTimer = setInterval(']),
      ],
      fencePolicy: '验证模式不安装用量刷新 timer；只返回副本中的 stale usage 投影。',
    }),
    startupRisk({
      id: 'task_integration_preparing_retry',
      domain: 'Git/Worktree/Provider',
      startupBehavior: 'automatic_external_effect_possible',
      consequence: '每个 preparing attempt 会在启动时自动 retry；后续读取分支 HEAD、创建/复用 integration worktree、写冲突草稿并启动 Codex/Pi 会话，既触碰真实仓库，也可能触碰 Provider。',
      evidence: [
        startupEvidence('packages/local-server/src/index.ts', ["taskIntegrationAttempts.listByState('preparing')", 'void retryTaskIntegrationAiPreparation(conversation, attempt)']),
        startupEvidence('packages/local-server/src/gitIntegrationOperations.ts', ['const started = await startTaskIntegrationAttempt({', 'await writeTaskIntegrationDraft(', 'const operation = await startNativeTaskConversationFromPlan({']),
      ],
      fencePolicy: '验证模式必须在遍历 preparing attempts 前停止；只报告精确 attempt/integration/workspace identity，不创建 worktree、不执行 Git、不派发 Provider。',
    }),
    startupRisk({
      id: 'runtime_session_reconciliation',
      domain: 'Runtime/OS Process',
      startupBehavior: 'automatic_local_copy_mutation',
      consequence: '启动会按副本中的 PID/PGID 与 process identity 检查当前真实 OS 进程，并把会话改为 orphan_detected/lost、追加日志/任务事件/审计；当前函数不自动 spawn 或 kill，但会让副本与正式进程产生身份交叉。',
      evidence: [
        startupEvidence('packages/local-server/src/index.ts', ['await recoverPersistedRuntimeSessions();']),
        startupEvidence('packages/local-server/src/localServerSupportOperations.ts', [
          'runtimeSessions.listUnfinishedForRecovery()',
          'inspectPersistedRuntimeProcessIdentity(',
          "status === 'orphan_detected'",
          "action: 'runtime.session.recovered'",
        ]),
      ],
      fencePolicy: '验证模式不得探测或控制复制记录中的 PID/PGID；仅把 runtime 标成 unverified_copy_projection，停止/附着入口全部拒绝。',
    }),
    startupRisk({
      id: 'pi_accepted_turn_recovery',
      domain: 'Provider/Pi',
      startupBehavior: 'automatic_local_copy_mutation',
      consequence: '启动把复制库中 Pi dispatching/running/waiting 轮次收敛为 interrupted 并暂停队列；实现明确不会自动重发，也不会启动 Pi Worker。',
      evidence: [startupEvidence('packages/local-server/src/index.ts', ['const recoverAcceptedPiTurnsAfterRestart = async () => {', 'ZEUS_PI_RUN_INTERRUPTED_BY_RESTART', '不会自动重发', 'await recoverAcceptedPiTurnsAfterRestart();'])],
      fencePolicy: '验证模式跳过终态收敛，保持复制快照原值并附加非耐久的 validation-only 标记；不构造 Pi Worker。',
    }),
    startupRisk({
      id: 'command_center_interrupted_run_recovery',
      domain: 'Command Center',
      startupBehavior: 'automatic_local_copy_mutation',
      consequence: 'Command Center 构造时创建脚本/运行目录，并把全部 active run 改为 rejected/failed、追加审计与 Realtime 后异步保存；不会自动恢复或停止真实 Runtime，但会改写复制事实。',
      evidence: [
        startupEvidence('packages/local-server/src/commandCenter.ts', [
          'mkdirSync(options.commandScriptsDirectory',
          'mkdirSync(options.commandRunsDirectory',
          'recoverInterruptedRuns();',
          'for (const run of runs.listActive())',
          'if (changed) void options.save();',
        ]),
      ],
      fencePolicy: '验证模式构造只读 Command Center 查询面，不建目录、不执行 recoverInterruptedRuns，所有 run start/stop/confirmation 写入口拒绝。',
    }),
    startupRisk({
      id: 'heavy_worker_pool_activation',
      domain: 'Heavy Worker',
      startupBehavior: 'capability_armed_without_startup_execution',
      consequence: 'Core 启动会重新开放进程内有界队列，但队列不持久化且 activate 本身不 pump、不创建 Worker；没有请求时不会因复制库自动扫描 Git 或仓库。',
      evidence: [
        startupEvidence('packages/local-server/src/index.ts', ['activateHeavyWorkerJobs();']),
        startupEvidence('packages/local-server/src/heavyWorkerPool.ts', ['const queue: QueuedHeavyJob[] = [];', 'export function activateHeavyWorkerJobs(): void {', 'function startJob(job: QueuedHeavyJob): void {', 'new Worker(']),
      ],
      fencePolicy: '验证模式保持池 closed，不接受 code-map/git-diff/git-status 作业；只读轻量查询必须使用已有投影。',
    }),
    startupRisk({
      id: 'telegram_polling_and_notification',
      domain: 'Telegram',
      startupBehavior: 'capability_armed_without_startup_execution',
      consequence: '复制设置与环境 token 会让 Telegram 能力可用，但 polling service/start timer 目前只在显式 POST 中创建；单纯启动没有自动 poll/send。后续 task status、Runtime 或 Command run 事件仍可触发真实通知。',
      evidence: [
        startupEvidence('packages/local-server/src/localServerPlatformRoutes.ts', ['registerTelegramPollingApi({', 'await sender.sendMessage(chatId, text);']),
        startupEvidence('packages/local-server/src/index.ts', ['void notifyTelegramCommandRunSession(session);']),
        startupEvidence('packages/local-server/src/telegramPollingApi.ts', [
          "options.server.post('/api/telegram/start'",
          "options.server.post('/api/telegram/polling/start'",
          'const status = await service!.start();',
          'const timer = setInterval(',
        ]),
      ],
      fencePolicy: '验证模式不读取/传递 Telegram token，不构造 sender/poller，并拒绝 start/poll/send；复制设置仅显示为 redacted configured/unavailable。',
    }),
    startupRisk({
      id: 'release_update_scheduler',
      domain: 'Release/Update',
      startupBehavior: 'test_distribution_gated_unless_override',
      consequence: '普通 Zeus Test 不创建自动更新 scheduler；但 ZEUS_ALLOW_UNTRUSTED_UPDATE_TEST=1 会重新启用定时检查/预取。显式检查、下载和安装 IPC 仍另列 pending。',
      evidence: [
        startupEvidence('apps/desktop/src/main/main.ts', [
          "const allowUntrustedReleaseUpdateTest = !readOnlyValidationDescriptor && isTestDistribution() && process.env.ZEUS_ALLOW_UNTRUSTED_UPDATE_TEST === '1';",
          'if (homebrewUpdateController && (!isTestDistribution() || allowUntrustedReleaseUpdateTest))',
          'await automaticUpdateScheduler.start();',
        ]),
      ],
      fencePolicy: '验证模式忽略所有 update override，不构造 scheduler/controller 的网络/安装能力，并拒绝菜单及 IPC 更新动作。',
    }),
    startupRisk({
      id: 'browser_host_state_restore',
      domain: 'Browser',
      startupBehavior: 'capability_armed_without_startup_execution',
      consequence: 'BrowserHost 构造只恢复 JSON 元数据、origin 规则和 tab snapshot 并配置 session；restore 不创建 WebContentsView、不 loadURL。导航/网页脚本/系统浏览器需后续显式入口。',
      evidence: [startupEvidence('apps/desktop/src/main/browserHost.ts', ['this.restorePersistedState();', 'this.configureSession();', 'private restorePersistedState(): void {', 'private ensureView(', 'view.webContents.loadURL('])],
      fencePolicy: '验证模式允许读取 snapshot，但禁止 ensureView/loadURL、Browser command、下载、网页权限与 shell.openExternal；UI 显示静态不可交互占位。',
    }),
  ];
}

function startupRisk({ id, domain, startupBehavior, consequence, evidence, fencePolicy }) {
  return {
    id,
    domain,
    startupBehavior,
    consequence,
    evidence,
    readOnlyFenceStatus: 'pending',
    readOnlyFencePolicy: fencePolicy,
  };
}

function startupEvidence(file, requiredMarkers) {
  return { file, requiredMarkers };
}

function verifyStartupTopology(sourceMap) {
  const localServer = [
    'packages/local-server/src/index.ts',
    'packages/local-server/src/localServerPlatformRoutes.ts',
    'packages/local-server/src/localServerSupportOperations.ts',
    'packages/local-server/src/gitIntegrationOperations.ts',
    'packages/local-server/src/taskRuntimeOperations.ts',
  ]
    .map((path) => sourceMap.get(path) ?? '')
    .join('\n');
  const telegramPollingApi = sourceMap.get('packages/local-server/src/telegramPollingApi.ts') ?? '';
  const browserHost = sourceMap.get('apps/desktop/src/main/browserHost.ts') ?? '';
  const heavyWorkerPool = sourceMap.get('packages/local-server/src/heavyWorkerPool.ts') ?? '';
  const commandCenter = sourceMap.get('packages/local-server/src/commandCenter.ts') ?? '';
  const main = sourceMap.get('apps/desktop/src/main/main.ts') ?? '';
  const localServerRuntime = sourceMap.get('apps/desktop/src/main/localServerRuntime.ts') ?? '';
  const executionHost = sourceMap.get('apps/desktop/src/main/executionHost.ts') ?? '';
  const executionHostProtocol = sourceMap.get('apps/desktop/src/main/executionHostProtocol.ts') ?? '';
  const manifestVerifier = sourceMap.get('apps/desktop/src/main/readOnlyValidationManifest.ts') ?? '';
  const beforeQuitCleanup = sourceMap.get('apps/desktop/src/main/beforeQuitCleanup.ts') ?? '';
  const ipcFence = sourceMap.get('apps/desktop/src/main/readOnlyValidationIpcFence.ts') ?? '';
  const blockedCodexManager = sourceMap.get('apps/desktop/src/main/readOnlyValidationCodexManager.ts') ?? '';
  const coreManifestVerifier = sourceMap.get('packages/local-server/src/readOnlyValidation.ts') ?? '';
  const storage = sourceMap.get('packages/storage/src/index.ts') ?? '';
  const copyTool = sourceMap.get('scripts/create-zeus-test-database-copy.ts') ?? '';
  const bootstrapSecurityVerifier = sourceMap.get('scripts/verify-read-only-validation-bootstrap-security.ts') ?? '';
  const fenceVerifier = sourceMap.get('scripts/verify-read-only-validation-fence.ts') ?? '';
  const ipcFenceVerifier = sourceMap.get('scripts/verify-read-only-validation-ipc-fence.ts') ?? '';
  const mainCommandVerifier = sourceMap.get('scripts/verify-main-command-ledger-behavior.ts') ?? '';
  const runtimeRecoveryBody = findNamedBodyText(sourceMap.get('packages/local-server/src/localServerSupportOperations.ts') ?? '', 'recoverPersistedRuntimeSessions');
  const browserRestoreBody = findNamedBodyText(browserHost, 'restorePersistedState');
  const heavyActivationBody = findNamedBodyText(heavyWorkerPool, 'activateHeavyWorkerJobs');
  const commandCenterRecoveryBody = findNamedBodyText(commandCenter, 'recoverInterruptedRuns');
  const taskClipboardReadBody = findNamedBodyText(main, 'readTaskClipboardResourcesFromNativeClipboard');
  const dataRootPreparationBody = findNamedBodyText(main, 'applyExplicitUserDataDirectory');
  const executionHostRunBody = findNamedBodyText(executionHost, 'runExecutionHost');
  const bootstrapWriterBody = findNamedBodyText(executionHostProtocol, 'writeExecutionHostBootstrap');
  const readOnlyValidationModeCurrentlyDeclared = startupEvidenceFiles.some((file) => (sourceMap.get(file) ?? '').includes('readOnlyValidation'));
  const readOnlyFenceGuards = {
    backupApiCopyPublishesBoundManifest:
      copyTool.includes("copyMethod: 'node:sqlite-backup-api'") &&
      copyTool.includes("format: 'zeus-read-only-validation-manifest'") &&
      copyTool.includes('onlineValidationManifestFormatVersion = 3') &&
      copyTool.includes("treeImmutability: 'online_backup_snapshot'") &&
      copyTool.includes('sourceDataVersionBefore') &&
      copyTool.includes('sourceDataVersionAfter') &&
      copyTool.includes('sourceAdvancedAfterBackup') &&
      copyTool.includes('nlink: 1') &&
      copyTool.includes("bundleId: 'dev.hypha.zeus.test'") &&
      copyTool.includes('databaseDevice'),
    packagedTestIdentityAndManifestVerified:
      manifestVerifier.includes('readMacOSBundleIdentifier(executablePath, input.packaged)') &&
      manifestVerifier.includes("if (!packaged || process.platform !== 'darwin')") &&
      coreManifestVerifier.includes("allowedApplication.bundleId !== 'dev.hypha.zeus.test'") &&
      manifestVerifier.includes('verifyReadOnlyValidationDescriptor(descriptor)'),
    mainVerifiesBeforeIpcAndCore:
      main.includes('await verifyDesktopReadOnlyValidationDescriptor(readOnlyValidationDescriptor)') &&
      main.includes('installReadOnlyValidationIpcFence(ipcMain, readOnlyValidationDescriptor)') &&
      main.indexOf('await verifyDesktopReadOnlyValidationDescriptor(readOnlyValidationDescriptor)') < main.lastIndexOf('setupIpc();'),
    desktopTrustRootFailsBeforeElectronProfileAndSingleInstanceWrites:
      manifestVerifier.includes("join(testIsolationBase, 'read-only-validation')") &&
      manifestVerifier.includes('descriptor.runId') &&
      manifestVerifier.includes('ZEUS_READ_ONLY_VALIDATION_TRUST_ROOT_MISMATCH') &&
      manifestVerifier.includes("join(homeDirectory, '.zeus')") &&
      dataRootPreparationBody.indexOf('loadDesktopReadOnlyValidationDescriptor({') >= 0 &&
      dataRootPreparationBody.indexOf('loadDesktopReadOnlyValidationDescriptor({') < dataRootPreparationBody.indexOf('applyReadOnlyValidationDataRoot(readOnlyValidationDescriptor)') &&
      main.indexOf('applyExplicitUserDataDirectory();') < main.indexOf('app.requestSingleInstanceLock()'),
    mainIpcAndBrowserCapabilitiesFailClosed:
      ipcFence.includes('ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED') &&
      ipcFence.includes('new WeakSet<object>()') &&
      ['handleOnce', 'on', 'addListener', 'once', 'prependListener', 'prependOnceListener'].every((method) => ipcFence.includes(`ipcMain.${method} =`) && ipcFenceVerifier.includes(`fakeIpcMain.${method}(`)) &&
      ipcFenceVerifier.includes('handleOnce/addListener/once/prependListener/prependOnceListener 别名不得绕过默认拒绝 Fence') &&
      browserHost.includes('if (this.options.readOnlyValidation)') &&
      browserHost.includes('只读验证模式禁止创建浏览器 WebContentsView'),
    readOnlyValidationQuitAndCleanupAreIsolated:
      main.includes("if (readOnlyValidationDescriptor) return 'final_quit';") && main.includes("if (!readOnlyValidationDescriptor && (mode === 'final_quit' || mode === 'force_quit') && app.isPackaged)"),
    quitCleanupFailureCannotMasqueradeAsSuccess:
      beforeQuitCleanup.includes('await resources.closeLocalServer?.(quitMode)') &&
      beforeQuitCleanup.includes('resources.exitApp(0)') &&
      beforeQuitCleanup.indexOf('await resources.closeLocalServer?.(quitMode)') < beforeQuitCleanup.indexOf('resources.exitApp(0)') &&
      beforeQuitCleanup.includes("if (action === 'force_quit')") &&
      beforeQuitCleanup.includes('resources.exitApp(1)') &&
      beforeQuitCleanup.includes('throw new AggregateError(cleanupErrors') &&
      main.includes("attemptCleanup('Detached Core'") &&
      main.includes('throw new AggregateError(cleanupErrors') &&
      main.includes("return result.response === 1 ? 'force_quit' : 'retry'") &&
      mainCommandVerifier.includes('rejectedCloseDidNotExitZero') &&
      mainCommandVerifier.includes('coreCloseAttemptedAfterEarlierFailure') &&
      mainCommandVerifier.includes('validationFailureExitCode') &&
      mainCommandVerifier.includes('successfulRetryExitCode'),
    taskClipboardResourceReadIsActuallyReadOnly:
      taskClipboardReadBody.includes('readTaskClipboardFileReferencesFromClipboard(') &&
      taskClipboardReadBody.includes('readTaskClipboardAttachmentsFromClipboard(') &&
      !taskClipboardReadBody.includes('saveTaskResourcePaths(') &&
      !taskClipboardReadBody.includes('saveTaskAttachmentPayloads(') &&
      !taskClipboardReadBody.includes('writeFile(') &&
      !taskClipboardReadBody.includes('rename('),
    detachedCoreIdentityPropagatedAndReverified:
      executionHostProtocol.includes('readOnlyValidation?: ReadOnlyValidationDescriptor') &&
      executionHost.includes('verifyReadOnlyValidationBeforeOwnedCoreLock(bootstrap.readOnlyValidation)') &&
      localServerRuntime.includes('sameReadOnlyValidationIdentity') &&
      localServerRuntime.includes('await verifyReadOnlyValidationDescriptor(options.readOnlyValidation)'),
    detachedCoreDoesNotHashSameDescriptorTwice:
      localServerRuntime.includes('new WeakSet<ReadOnlyValidationDescriptor>()') &&
      localServerRuntime.includes('readOnlyValidationVerifiedBeforeOwnedCoreLock.add(descriptor)') &&
      localServerRuntime.includes('readOnlyValidationVerifiedBeforeOwnedCoreLock.delete(options.readOnlyValidation)'),
    detachedBootstrapCanonicalSecureAndValidatedBeforeWrites:
      bootstrapWriterBody.indexOf('executionHostBootstrapDataLayout(input)') >= 0 &&
      bootstrapWriterBody.indexOf('executionHostBootstrapDataLayout(input)') < bootstrapWriterBody.indexOf('await mkdir(') &&
      executionHostProtocol.includes('fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW') &&
      executionHostProtocol.includes('before.dev !== after.dev') &&
      executionHostProtocol.includes('before.mtimeNs !== after.mtimeNs') &&
      executionHostProtocol.includes('maximumExecutionHostMetadataBytes') &&
      executionHostProtocol.includes('realpathSync(bootstrapDirectory) !== layout.executionHost') &&
      executionHostRunBody.indexOf('readExecutionHostBootstrap(bootstrapPath)') >= 0 &&
      executionHostRunBody.indexOf('readExecutionHostBootstrap(bootstrapPath)') < executionHostRunBody.indexOf('verifyReadOnlyValidationBeforeOwnedCoreLock(bootstrap.readOnlyValidation)') &&
      executionHostRunBody.indexOf('verifyReadOnlyValidationBeforeOwnedCoreLock(bootstrap.readOnlyValidation)') < executionHostRunBody.indexOf('await unlink(bootstrapPath)') &&
      executionHostRunBody.indexOf('await unlink(bootstrapPath)') < executionHostRunBody.indexOf('acquireExecutionHostLock(') &&
      localServerRuntime.includes('assertReadOnlyValidationDesktopOptions(options);') &&
      localServerRuntime.includes('codexConfigImportSourceRoot: options.readOnlyValidation ? dataLayout.codexHome'),
    storageIsQueryOnlyWithoutMigrationOrSave:
      storage.includes("accessMode: 'read_write' | 'read_only_validation'") &&
      storage.includes("nativeDb.exec('PRAGMA query_only = ON')") &&
      storage.includes('new ZeusStorageReadOnlyValidationError()') &&
      storage.includes("if (this.accessMode === 'read_only_validation')"),
    storageRevalidatesIdentityAtOpenDigestAndClose:
      storage.includes('captureReadOnlyValidationDatabasePathIdentity(filePath, descriptor)') &&
      storage.includes("assertReadOnlyValidationDatabaseIdentityStable(beforeOpen, afterOpen, 'SQLite open 前后')") &&
      storage.includes('verifyClosedReadOnlyValidationDatabase(this.readOnlyValidationIdentity)') &&
      storage.includes('digestClosedReadOnlyValidationDatabaseNoFollow') &&
      storage.includes('`${input.descriptor.database.path}-wal`') &&
      coreManifestVerifier.includes('assertPathStillPointsToIdentity(path, after, label)') &&
      coreManifestVerifier.includes('sourceStats.nlink !== 1n'),
    coreSkipsWorkersRecoveryAndExternalCapabilities:
      localServer.includes('if (!options.readOnlyValidation) activateHeavyWorkerJobs()') &&
      localServer.includes('else await closeHeavyWorkerJobs()') &&
      heavyWorkerPool.includes('let closed = true') &&
      heavyWorkerPool.includes('acceptingJobs: !closed') &&
      fenceVerifier.includes('heavyWorkers.body.acceptingJobs === false') &&
      localServer.includes('if (!readOnlyValidation) workManagementTaskEffects.recover()') &&
      localServer.includes('isReadOnlyValidationExternalRead(requestPath)') &&
      localServer.includes('resources\\/[^/]+\\/(?:open-intent|preview)') &&
      localServer.includes('change-set\\/[^/]+\\/files\\/[^/]+\\/(?:open-intent|preview)') &&
      blockedCodexManager.includes('只读验证模式未构造 Codex Provider manager'),
    descriptorBindsHashSchemaAndFileIdentity:
      coreManifestVerifier.includes('ZEUS_READ_ONLY_VALIDATION_DATABASE_HASH_MISMATCH') && coreManifestVerifier.includes('ZEUS_READ_ONLY_VALIDATION_SCHEMA_MISMATCH') && coreManifestVerifier.includes('device/inode/size'),
    behaviorVerifierProvesImmutableReadsAndZeroExternalCalls:
      fenceVerifier.includes('sourceDatabaseImmutable') &&
      fenceVerifier.includes('providerExternalCalls') &&
      fenceVerifier.includes('externalReadCount') &&
      fenceVerifier.includes('copiedPathReadsBlockedBeforeRecordResolution') &&
      fenceVerifier.includes('JSON.stringify(treeBefore) === JSON.stringify(treeAfter)'),
    bootstrapSecurityBehaviorVerifierCoversTrustRootSecureJsonAndSwap:
      bootstrapSecurityVerifier.includes('mixedDescriptorAlternateRootRejectedBeforeTreeWrite') &&
      bootstrapSecurityVerifier.includes('productionRootImpersonationRejected') &&
      bootstrapSecurityVerifier.includes('sourceTreeOverlapRejected') &&
      bootstrapSecurityVerifier.includes('directorySymlinkRejected') &&
      bootstrapSecurityVerifier.includes('broadPermissionsRejected') &&
      bootstrapSecurityVerifier.includes('oversizeRejected') &&
      bootstrapSecurityVerifier.includes('closePathSwapRejected') &&
      bootstrapSecurityVerifier.includes('mtimeCtimeMutationRejected') &&
      bootstrapSecurityVerifier.includes('treeUnchangedAcrossRejections'),
  };
  const readOnlyFenceIntegrated = Object.values(readOnlyFenceGuards).every(Boolean);
  return {
    guards: {
      telegramPollingStartsRemainExplicitOnly:
        countMatches(telegramPollingApi, /await service!\.start\(\)/gu) === 1 &&
        countMatches(telegramPollingApi, /const timer = setInterval/gu) === 1 &&
        telegramPollingApi.includes("options.server.post('/api/telegram/start'") &&
        telegramPollingApi.includes("options.server.post('/api/telegram/polling/start'") &&
        localServer.includes('registerTelegramPollingApi({'),
      browserRestoreDoesNotCreateViewOrNavigate: browserRestoreBody.length > 0 && !browserRestoreBody.includes('ensureView(') && !browserRestoreBody.includes('loadURL('),
      heavyActivationDoesNotSpawnOrDrain: heavyActivationBody.length > 0 && !heavyActivationBody.includes('new Worker(') && !heavyActivationBody.includes('pump('),
      runtimeStartupRecoveryDoesNotSpawnOrKill: runtimeRecoveryBody.length > 0 && !runtimeRecoveryBody.includes('startSession(') && !runtimeRecoveryBody.includes('stopSession(') && !runtimeRecoveryBody.includes('process.kill('),
      commandCenterRecoveryDoesNotResumeOrStopRuntime:
        commandCenterRecoveryBody.length > 0 && !commandCenterRecoveryBody.includes('startSession(') && !commandCenterRecoveryBody.includes('stopSession(') && !commandCenterRecoveryBody.includes('forceStop'),
      ...readOnlyFenceGuards,
    },
    observations: {
      readOnlyValidationModeCurrentlyDeclared,
      readOnlyFenceIntegrated,
      fenceState: readOnlyFenceIntegrated ? 'integrated_requires_runtime_acceptance' : readOnlyValidationModeCurrentlyDeclared ? 'implementation_incomplete' : 'not_implemented',
      detachedCoreRequiresProtocolPropagation:
        (sourceMap.get('apps/desktop/src/main/localServerRuntime.ts') ?? '').includes('writeExecutionHostBootstrap(') && (sourceMap.get('apps/desktop/src/main/executionHost.ts') ?? '').includes('startOwnedDesktopLocalServer({'),
    },
  };
}

function findNamedBodyText(content, name) {
  const sourceFile = ts.createSourceFile('startup-evidence.ts', content, ts.ScriptTarget.Latest, true);
  let body = '';
  const visit = (node) => {
    const declarationName = 'name' in node && node.name && ts.isIdentifier(node.name) ? node.name.text : null;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && declarationName === name && node.body) {
      body = node.body.getText(sourceFile);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      body = node.initializer.body.getText(sourceFile);
      return;
    }
    if (!body) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return body;
}

function countMatches(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function createProposedTestReadOnlyValidationFence(integrated) {
  return {
    status: integrated ? 'integrated_requires_runtime_acceptance' : 'implementation_incomplete',
    activation: {
      allRequired: [
        'packaged Zeus Test identity (bundle id dev.hypha.zeus.test and executable name Zeus Test)',
        'explicit validation manifest generated beside a fresh SQLite Backup API copy',
        'manifest binding to canonical user-data root plus destination database device/inode/sha256 and one validation run id',
        'Execution Host capability negotiation proving the attached Core supports the same validation mode and manifest hash',
      ],
      productionBehavior: 'production Zeus rejects the mode; a plain environment variable or copied database setting is insufficient authority.',
    },
    minimumConnectionSurface: [
      'Main computes and displays the mode before BrowserHost/Core construction.',
      'StartDesktopLocalServerOptions carries a typed validation descriptor, never an unvalidated boolean.',
      'ExecutionHostBootstrap, rendezvous capability and lease identity bind the descriptor hash; validation UI cannot attach to an unfenced existing Core.',
      'Execution Host forwards the descriptor into CreateLocalServerOptions before createZeusDatabase and startup recovery.',
      'Core selects a query-only database/application port, installs a global mutation admission fence and skips every automatic recovery listed in this report.',
      'BrowserHost and Main IPC share the same admission port so Browser navigation, shell/file writes, Git, update and clipboard writes fail closed.',
    ],
    allowed: ['bounded SQLite/Snapshot V2 reads and diagnostics', 'Renderer-local navigation and non-durable UI projection'],
    denied: [
      'Provider construction, remote control, usage refresh, legacy/native recovery and Pi Worker creation',
      'preparing task integration retry, worktree/Git writes and Heavy Worker jobs',
      'Runtime PID inspection/control and Command Center startup recovery',
      'Telegram token access, polling or notifications',
      'release/update network, download or install actions',
      'Browser WebContents navigation/download/automation and shell.openExternal',
      'all POST/PUT/PATCH/DELETE business routes plus Main filesystem/clipboard mutations',
    ],
    diagnostics: 'Expose a read-only status containing validation run id, manifest hash, database hash, active Core generation and per-domain skipped reason; never include credentials or copied payloads.',
    acceptanceProtocol: {
      status: integrated ? 'automated_behavior_verified_runtime_gui_pending' : 'implementation_incomplete',
      steps: [
        'create a fresh destination with the SQLite Backup API copy tool and never reuse or overwrite it',
        'run a fail-closed snapshot-state preflight for active/recoverable Provider, preparing integration, Runtime and Command Center identities before launch',
        'launch the isolated Zeus Test identity with Codex disabled',
        'use a Keychain service namespace derived from the isolated test data root and verify that the detached Core receives the same namespace',
      ],
      residualRisk: 'Static and isolated Core verification cannot replace the final packaged Zeus Test GUI run against a fresh Backup API copy; that run must recheck bundle identity, external-display placement and post-close file hashes.',
    },
    benefit: 'A formal-data copy can be inspected without contacting real Providers, repositories, processes, Telegram, update servers or websites, and the detached Core cannot silently lose the fence.',
    drawbacks: 'This mode cannot validate migrations, recovery completion, writes, Provider continuation or realistic end-to-end mutation performance; protocol/versioning and a second read-only composition path add maintenance cost.',
  };
}

function createIpcDeclarations() {
  return new Map([
    // BrowserHost 的精确只读入口。
    nonMutating('zeus:browser:get-snapshot', 'apps/desktop/src/main/browserHost.ts', '读取内存中的会话浏览器投影。', ['snapshotFor(']),
    nonMutating('zeus:browser:prepare-comments', 'apps/desktop/src/main/browserHost.ts', '只组装草稿批注与既有附件引用，不改变批注状态。', ['this.prepareComments(']),
    nonMutating('zeus:browser:comment-preview', 'apps/desktop/src/main/browserHost.ts', '只读取受托管根约束的 PNG 预览。', ['this.loadCommentPreview(']),
    nonMutating('zeus:browser:get-settings', 'apps/desktop/src/main/browserHost.ts', '只复制 BrowserHost 当前设置。', ['return { ...this.settings }']),
    nonMutating('zeus:browser-page:get-state', 'apps/desktop/src/main/browserHost.ts', '只读取页面批注投影与 annotation mode。', ['comments: tab.snapshot.comments.filter']),

    // Main 的精确只读入口。
    nonMutating('zeus:conversation-store-migration:get-status', 'apps/desktop/src/main/main.ts', '只读取迁移状态文件。', ['readUnifiedConversationStoreMigrationStatus(']),
    nonMutating('zeus:execution-host-maintenance:get-status', 'apps/desktop/src/main/main.ts', '只等待启动判定并返回维护投影。', ['return executionHostMaintenance']),
    nonMutating('zeus:get-local-server-config', 'apps/desktop/src/main/main.ts', '只刷新已运行 Core 的连接配置。', ['runtime.refreshConfig()']),
    nonMutating('zeus:project-git:load-workbench', 'apps/desktop/src/main/main.ts', '只执行 Git 状态发现与读取。', ['loadWorkbench(']),
    nonMutating('zeus:project-git:load-commit', 'apps/desktop/src/main/main.ts', '只读取指定 Git commit。', ['loadCommit(']),
    nonMutating('zeus:project-git:load-comparison', 'apps/desktop/src/main/main.ts', '只读取 Git comparison diff。', ['loadComparison(']),
    nonMutating('zeus:task-git-delivery:get-current-context', 'apps/desktop/src/main/main.ts', '只返回当前交付窗口的内存上下文。', ['return currentTaskGitDeliveryContext']),
    nonMutating('zeus:project-source:list-directory', 'apps/desktop/src/main/main.ts', '只列举项目目录。', ['listDirectory(']),
    nonMutating('zeus:project-source:search', 'apps/desktop/src/main/main.ts', '只搜索项目目录元数据。', ['.search(']),
    nonMutating('zeus:project-source:read-file', 'apps/desktop/src/main/main.ts', '只读取受项目根约束的源码文件。', ['.readFile(']),
    nonMutating('zeus:automatic-update-indicator:get', 'apps/desktop/src/main/main.ts', '只读取更新指示器投影。', ['getIndicatorState()']),
    nonMutating('zeus:conversation-resource:list-open-targets', 'apps/desktop/src/main/main.ts', '只列出已授权资源的可打开目标。', ['listConversationResourceOpenTargets(']),
    nonMutating('zeus:get-conversation-resource-preview', 'apps/desktop/src/main/main.ts', '只读取受托管根约束的会话资源预览。', ['conversationInputResources.preview(']),
    nonMutating('zeus:read-task-clipboard-resources', 'apps/desktop/src/main/main.ts', '只读取剪贴板文件引用、附件载荷或文字；写入由 Renderer 后续唯一 Main Command envelope 承接。', ['readTaskClipboardResourcesFromNativeClipboard()']),
    nonMutating('zeus:read-task-clipboard-attachments', 'apps/desktop/src/main/main.ts', '只读取剪贴板附件载荷，不落盘。', ['readTaskClipboardAttachmentsFromNativeClipboard()']),
    nonMutating('zeus:read-task-clipboard-image', 'apps/desktop/src/main/main.ts', '只读取首个剪贴板图片载荷，不落盘。', ['readTaskClipboardAttachmentsFromNativeClipboard()']),
    nonMutating('zeus:get-task-attachment-preview', 'apps/desktop/src/main/main.ts', '只读取已保存附件预览。', ['loadSavedTaskAttachmentPreview(']),
    nonMutating('zeus:zentao:parse-link', 'apps/desktop/src/main/main.ts', '只读取 ZenTao 页面和 Keychain 密码；不写 Keychain 或业务状态。', ['extractZentaoTaskInfo(']),
    nonMutating('zeus:import-settings-snapshot', 'apps/desktop/src/main/main.ts', '只由用户选择并解析快照；真正应用由后续 Local Server mutation 完成。', ['importSettingsSnapshotFromFile(']),
    nonMutating('zeus:import-business-data-snapshot', 'apps/desktop/src/main/main.ts', '只由用户选择并解析业务快照；本 IPC 不应用数据。', ['importBusinessDataSnapshotFromFile(']),
    nonMutating('zeus:requesting-window-foreground', 'apps/desktop/src/main/main.ts', '只查询发起窗口前台状态。', ['isRequestingWindowForeground(']),

    // Browser/UI 平台能力：逐 channel 声明，不按前缀放行。
    platform('zeus:browser:open-tab', 'apps/desktop/src/main/browserHost.ts', '创建内置浏览器 UI 标签和可重建状态缓存，不写 Core 业务事实。', '用户显式打开浏览器或资源。', 'Main 不自动重试；重复用户动作表示新的 tab。', ['this.openTab(']),
    platform('zeus:browser:activate-tab', 'apps/desktop/src/main/browserHost.ts', '切换当前 WebContentsView 可见性和活动投影。', '用户显式选择已有 tab。', '对同一 tab 重复激活为幂等的 latest-value 投影。', ['this.activateTab(']),
    platform('zeus:browser:close-tab', 'apps/desktop/src/main/browserHost.ts', '关闭 WebContentsView 与 UI 恢复缓存，不删除 Core 业务事实。', '用户显式关闭已有 tab。', 'Main 不重试；tab identity 消失后重复请求失败关闭。', [
      'this.closeTab(',
    ]),
    platform('zeus:browser:set-layout', 'apps/desktop/src/main/browserHost.ts', '只投影 BrowserView bounds/visibility。', '由受信 Renderer 当前布局直接驱动。', '完整 bounds 是 latest-value 幂等设置。', ['this.setLayout(']),
    platform('zeus:browser-page:set-annotation-mode', 'apps/desktop/src/main/browserHost.ts', '只改变浏览器批注 UI mode 及可重建浏览器状态缓存。', '用户在当前页面显式切换。', '布尔目标值是 latest-value 幂等设置。', [
      'annotationMode: enabled === true',
    ]),
    platform('zeus:browser-page:open-system-browser-link', 'apps/desktop/src/main/browserHost.ts', '调用系统默认浏览器打开经 http/https 校验的 URL。', '页面中的用户点击是一次性确认。', 'Main 不自动重试；重复点击是独立可见动作。', [
      'normalizeExternalWebUrl(',
      'this.options.openExternal(',
    ]),
    platform('zeus:conversation-store-migration:open-diagnostics', 'apps/desktop/src/main/main.ts', '在 Finder 中显示已存在的诊断文件。', '用户在迁移故障界面显式打开。', 'Main 不自动重试；重复打开仅重复 Finder 定位。', [
      'shell.showItemInFolder(',
    ]),
    platform('zeus:conversation-store-migration:exit', 'apps/desktop/src/main/main.ts', '退出当前 Electron 进程，不写业务事实。', '迁移故障界面的显式退出动作。', '第一次退出是终止屏障；同进程不会执行第二次。', ['app.quit()']),
    platform('zeus:execution-host-maintenance:retry', 'apps/desktop/src/main/main.ts', '仅在受信维护窗口触发 Electron relaunch/exit。', '维护页显式重试且必须仍处于 maintenance。', '进程退出是一次性屏障；Main 不做网络重试。', [
      'app.relaunch()',
      'app.exit(0)',
    ]),
    platform('zeus:execution-host-maintenance:exit', 'apps/desktop/src/main/main.ts', '仅在受信维护窗口退出应用。', '维护页显式退出且必须仍处于 maintenance。', '第一次退出终止当前进程。', ['app.quit()']),
    platform('zeus:task-git-delivery:open', 'apps/desktop/src/main/main.ts', '创建或激活任务代码交付窗口。', '受信主窗口中的显式打开动作。', 'task identity 复用同一窗口；重复调用收敛到窗口激活。', ['openTaskGitDeliveryWindow(']),
    platform('zeus:project-git-diff:open', 'apps/desktop/src/main/main.ts', '创建或激活只读 Git diff 窗口。', '受信主窗口中的显式打开动作。', '窗口按目标上下文复用；不重放 Git 写操作。', ['openProjectGitDiffWindow(']),
    platform('zeus:task-git-delivery:close', 'apps/desktop/src/main/main.ts', '关闭受信代码交付窗口。', '窗口自身显式关闭。', '关闭后 identity 消失，重复请求失败关闭。', ['requestingWindow.close()']),
    platform('zeus:task-git-delivery:current-context-changed', 'apps/desktop/src/main/main.ts', '更新窗口到任务上下文的内存映射并广播。', '受信主窗口报告当前选中上下文。', '以 window identity 为键的 latest-value 覆盖。', [
      'mainWindowTaskGitContexts.set(',
    ]),
    platform('zeus:task-git-delivery:changed', 'apps/desktop/src/main/main.ts', '向同任务窗口广播刷新提示。', '拥有该 task 的交付窗口发送。', '广播是无正文提示；重复消息只触发同一只读刷新。', [
      "webContents.send('zeus:task-git-delivery:changed'",
    ]),
    platform('zeus:task-git-delivery:open-conversation', 'apps/desktop/src/main/main.ts', '激活主窗口并发送会话导航事件。', '受信交付窗口显式选择会话。', '按 conversation identity 导航；重复动作收敛到同一视图。', [
      "webContents.send('zeus:task-git-delivery:open-conversation'",
    ]),
    platform('zeus:menu-bar-usage:hide', 'apps/desktop/src/main/main.ts', '隐藏菜单栏用量浮窗。', '浮窗自身显式关闭。', 'hide 对已隐藏窗口幂等。', ['hideMenuBarUsageWindow()']),
    platform('zeus:menu-bar-usage:show-main', 'apps/desktop/src/main/main.ts', '显示主窗口。', '菜单栏浮窗中的显式动作。', '重复调用只激活同一主窗口。', ['requestMainWindow()']),
    platform('zeus:menu-bar-usage:open-settings', 'apps/desktop/src/main/main.ts', '导航到现有设置页面锚点。', '菜单栏浮窗中的显式动作。', '同 category 的重复导航幂等。', ['openSettingsFromMenuBarUsage(']),
    platform('zeus:menu-bar-usage:quit', 'apps/desktop/src/main/main.ts', '发起应用退出生命周期。', '菜单栏浮窗中的显式退出动作。', '首次退出进入全局关闭屏障。', ['app.quit()']),
    platform('zeus:project-source:reveal-entry', 'apps/desktop/src/main/main.ts', '在 Finder 中显示经项目根校验的路径。', '用户显式选择 reveal。', 'Main 不自动重试；重复动作只重复 Finder 定位。', ['shell.showItemInFolder(']),
    platform('zeus:project-source:open-external', 'apps/desktop/src/main/main.ts', '由系统关联应用打开经项目根校验的路径。', '用户显式选择 open。', 'Main 不自动重试；重复动作是独立 OS 请求。', ['shell.openPath(']),
    platform('zeus:project-source:watch', 'apps/desktop/src/main/main.ts', '建立窗口所有的文件系统观察订阅。', '受信窗口打开源码工作区时建立。', '每个 sender 先关闭旧 watcher 再替换，按窗口幂等。', [
      'projectSourceWatchers.get(',
      'projectSourceWatchers.set(',
      '.watch(',
    ]),
    platform('zeus:project-source:unwatch', 'apps/desktop/src/main/main.ts', '关闭窗口所有的文件系统观察订阅。', '工作区关闭或卸载时发送。', '无现存 watcher 时为安全无操作。', [
      'projectSourceWatchers.get(',
      'projectSourceWatchers.delete(',
    ]),
    platform('zeus:renderer-bootstrap-failed', 'apps/desktop/src/main/main.ts', '记录 Renderer 启动失败的进程内诊断。', 'Renderer 生命周期事件，不是用户业务命令。', '同 sender 的最新失败投影覆盖，不触发业务重放。', [
      'rendererBootstrapMonitor.fail(',
    ]),
    platform('zeus:renderer-bootstrap-ready', 'apps/desktop/src/main/main.ts', '记录 Renderer 启动完成的进程内诊断。', 'Renderer 生命周期事件。', '同 sender 的 ready 标记幂等。', ['rendererBootstrapMonitor.markReady(']),
    platform('zeus:renderer-runtime-failed', 'apps/desktop/src/main/main.ts', '记录 Renderer 运行时失败的进程内诊断。', 'Renderer 生命周期事件。', '诊断按事件输出，不驱动业务副作用重试。', ['console.error(']),
    platform('zeus:task-table-layout-dirty-changed', 'apps/desktop/src/main/main.ts', '维护关闭保护所需的进程内 dirty 集合。', '受信 Renderer 报告当前 UI dirty 状态。', '按 window identity 的布尔 latest-value 设置。', [
      'taskTableLayoutDirtyWindowIds',
    ]),
    platform('zeus:unsaved-change-state', 'apps/desktop/src/main/main.ts', '维护关闭保护所需的未保存 key 集合。', '受信 Renderer 报告当前 UI 状态。', '按 window/key 的完整集合替换。', ['unsavedChangeKeysByWindow']),
    platform('zeus:sensitive-request-draft-changed', 'apps/desktop/src/main/main.ts', '维护关闭保护所需的敏感草稿集合。', '受信 Renderer 报告当前 UI 草稿状态。', '按 window/request identity 的集合投影。', [
      'sensitiveRequestDraftIdsByWindow',
    ]),
    platform('zeus:session-context-activity-changed', 'apps/desktop/src/main/main.ts', '维护快捷键关闭行为所需的当前上下文投影。', '受信 Renderer 报告 UI activity。', '按 window identity 的 latest-value 设置。', [
      'sessionContextActivityByWindow',
    ]),
    platform('zeus:app-close-layer-activity-changed', 'apps/desktop/src/main/main.ts', '维护关闭最上层 UI 的进程内 activity 标志。', '受信 Renderer 报告 UI activity。', '按 window identity 的布尔 latest-value 设置。', [
      'appCloseLayerActivityByWindow',
    ]),
    platform('zeus:task-table-layout-close-resolution', 'apps/desktop/src/main/main.ts', '消费一次 UI 关闭确认并关闭窗口或继续退出。', '用户在未保存布局确认框中明确选择。', 'pending window 集合确保一次确认只消费一次。', [
      'pendingTaskTableLayoutWindowCloseIds.delete(',
    ]),
    platform('zeus:unsaved-changes-close-resolution', 'apps/desktop/src/main/main.ts', '消费一次未保存更改关闭确认。', '用户在未保存更改确认框中明确选择。', 'pending window 集合与 approved 集合阻止重复消费。', [
      'taskTableLayoutCloseApprovedWindowIds.add(',
    ]),
    platform('zeus:open-external-https-url', 'apps/desktop/src/main/main.ts', '调用系统浏览器打开经过二次 https 校验的 URL。', '受信窗口中的显式链接动作。', 'Main 不自动重试；重复点击是独立可见动作。', [
      'openExternalHttpsUrl(',
      'shell.openExternal(',
    ]),
    platform('zeus:activate-requesting-window', 'apps/desktop/src/main/main.ts', '只激活 IPC sender 所属窗口。', '受信窗口自身请求前台显示。', '重复激活同一窗口幂等。', ['revealMainWindow(requestingWindow)']),
    platform('zeus:conversation-resource:open', 'apps/desktop/src/main/main.ts', '对已授权资源执行用户选择的系统打开、定位、复制或内置浏览器动作。', '用户从资源菜单明确选择目标。', 'Main 不自动重试；重复点击是独立 OS/UI 动作。', [
      'openConversationResource(',
    ]),
    platform('zeus:turn-change-file:open', 'apps/desktop/src/main/main.ts', '对已授权变更文件执行用户选择的系统打开或定位。', '用户从变更文件菜单明确选择。', 'Main 不自动重试；重复点击是独立 OS/UI 动作。', ['openTurnChangeFile(']),
    platform('zeus:window-drag-start', 'apps/desktop/src/main/main.ts', '建立进程内窗口拖动手势状态。', '当前指针手势本身即确认。', '按 sender identity 覆盖旧拖动状态。', ['manualWindowDragStates.set(']),
    platform('zeus:window-drag-move', 'apps/desktop/src/main/main.ts', '按当前拖动手势移动窗口。', '只接受已有 start 的同 sender 手势。', '绝对起点加当前坐标确定位置；不自动重试。', ['window.setPosition(']),
    platform('zeus:window-drag-end', 'apps/desktop/src/main/main.ts', '清理进程内拖动手势状态。', '手势结束事件。', '删除不存在的 sender 状态幂等。', ['manualWindowDragStates.delete(']),
    platform('zeus:choose-project-directory', 'apps/desktop/src/main/main.ts', '仅打开系统目录选择器并返回用户选择。', '系统选择器的确认按钮。', '取消为无操作；Main 不自动重开选择器。', ['dialog.showOpenDialog(']),
    platform('zeus:choose-recovery-backup-destinations', 'apps/desktop/src/main/main.ts', '仅打开两个恢复目的地的系统目录选择器，不执行备份。', '用户逐个在系统选择器确认。', '取消为无操作；路径选择不自动重试。', [
      'chooseExactlyTwoDirectories(',
    ]),
    platform('zeus:reveal-project-in-finder', 'apps/desktop/src/main/main.ts', '在 Finder 中显示经绝对路径和目录校验的项目。', '用户显式点击 reveal。', 'Main 不自动重试；重复动作只重复 Finder 定位。', ['revealProjectPathInFinder(']),
    platform('zeus:choose-conversation-resources', 'apps/desktop/src/main/main.ts', '仅选择并描述文件/目录，不复制或删除。', '系统选择器的确认按钮。', '取消为无操作；选择器不自动重试。', [
      'dialog.showOpenDialog(',
      'conversationInputResources.describePaths(',
    ]),
    platform('zeus:authorize-conversation-files', 'apps/desktop/src/main/main.ts', '为当前 drag/paste 路径生成无服务端状态的签名引用。', '用户拖放或粘贴动作提供一次性来源。', '相同规范路径生成可重复验证的 capability，不写业务状态。', [
      'conversationInputResources.describePaths(',
    ]),
    platform('zeus:open-conversation-input-resource', 'apps/desktop/src/main/main.ts', '系统打开经 grant 或托管根重新校验的资源。', '用户显式点击附件。', 'Main 不自动重试；重复点击是独立 OS 动作。', [
      'conversationInputResources.resolve(',
      'shell.openPath(',
    ]),
    platform('zeus:write-clipboard-text', 'apps/desktop/src/main/main.ts', '写入系统剪贴板，不写 Zeus 业务事实。', '用户显式复制动作。', '同一文本覆盖写是幂等的，并立即回读确认。', ['clipboard.writeText(', 'clipboard.readText() === text']),
    platform('zeus:open-task-attachment', 'apps/desktop/src/main/main.ts', '系统打开已保存且重新校验的任务附件。', '用户显式点击附件。', 'Main 不自动重试；重复点击是独立 OS 动作。', ['openSavedTaskAttachment(']),
    platform('zeus:export-settings-snapshot', 'apps/desktop/src/main/main.ts', '将脱敏设置快照写入用户在系统 Save Dialog 选择的文件。', 'Save Dialog 的确认按钮。', 'Main 不自动重试；每次确认代表一个独立导出。', [
      'exportSettingsSnapshotToFile(',
      'dialog.showSaveDialog(',
      'writeFile(',
    ]),
    platform('zeus:clear-network-cache', 'apps/desktop/src/main/main.ts', '清除可重建的 Electron 网络缓存，不改业务事实。', '设置页中的显式清理动作。', 'clearCache 对已空缓存幂等。', ['session.defaultSession.clearCache()']),
    platform('zeus:export-patch', 'apps/desktop/src/main/main.ts', '将只读 patch 写入用户选择的外部文件；不执行 git apply。', 'Save Dialog 的确认按钮。', 'Main 不自动重试；每次确认代表一个独立导出。', [
      'exportPatchToFile(',
      'dialog.showSaveDialog(',
      'writeFile(',
    ]),
    platform('zeus:open-graph-source', 'apps/desktop/src/main/main.ts', '系统打开经项目根和存在性校验的图谱源码。', '用户显式点击源码位置。', 'Main 不自动重试；重复点击是独立 OS 动作。', ['openGraphSourceLocation(', 'shell.openPath(']),
    platform('zeus:export-mermaid-diagram', 'apps/desktop/src/main/main.ts', '将 Mermaid 源码写入用户选择的外部文件。', 'Save Dialog 的确认按钮。', 'Main 不自动重试；每次确认代表一个独立导出。', [
      'exportMermaidDiagramToFile(',
      'writeFile(',
    ]),
    platform('zeus:export-plantuml-diagram', 'apps/desktop/src/main/main.ts', '将 PlantUML 源码写入用户选择的外部文件。', 'Save Dialog 的确认按钮。', 'Main 不自动重试；每次确认代表一个独立导出。', [
      'exportPlantUmlDiagramToFile(',
      'writeFile(',
    ]),
    platform('zeus:export-runtime-logs', 'apps/desktop/src/main/main.ts', '将经路径授权的日志写入用户选择的外部文件。', 'Save Dialog 的确认按钮。', 'Main 不自动重试；每次确认代表一个独立导出。', ['exportRuntimeLogsToFile(', 'writeFile(']),
    platform(
      'zeus:app-shell-settings-changed',
      'apps/desktop/src/main/main.ts',
      '把 Core 已保存设置投影到菜单、Tray、通知和 macOS login item。',
      '设置在 Core 入口已由用户显式保存；Main 只应用快照。',
      '完整设置快照与 setLoginItemSettings 均为 latest-value 幂等。',
      ['applyLoginItemSettings()', 'setupTraySafely()'],
    ),

    // Main Command ledger 已接管的真实副作用。requiredMarkers 必须同时证明精确 command type 与 pre-effect write marker。
    integrated('zeus:browser:command', 'apps/desktop/src/main/browserHost.ts', '浏览器命令在外部网页动作前写入稳定 operation marker；异常收敛为 unknown-after-write。', 'desktop.browser.command', [
      'this.runManualCommand(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:browser:mark-comments-sent', 'apps/desktop/src/main/browserHost.ts', '批注消费与业务提交复用稳定 renderer 意图身份，并在原子状态文件发布后返回 receipt。', 'desktop.browser.mark_comments_sent', [
      'this.markCommentsSent(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:browser:respond-approval', 'apps/desktop/src/main/browserHost.ts', '一次性批准绑定 approval scope、Command identity 与持久 receipt。', 'desktop.browser.respond_approval', [
      'this.respondToApproval(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:browser:update-settings', 'apps/desktop/src/main/browserHost.ts', 'Browser 设置以原子文件替换和 fsync 持久化。', 'desktop.browser.update_settings', ['this.updateSettings(', 'this.flushPersistence()']),
    integrated('zeus:browser:clear-data', 'apps/desktop/src/main/browserHost.ts', '复合清除在写出前封存 marker；部分失败明确 unknown，禁止盲重试。', 'desktop.browser.clear_data', ['this.clearBrowsingData(', 'command.markWriteStarted()']),
    integrated('zeus:browser-page:save-comment', 'apps/desktop/src/main/browserHost.ts', '批注截图与 Browser 状态使用原子发布，receipt 只在 fsync 后形成。', 'desktop.browser.save_comment', [
      'this.savePageComment(',
      'this.flushPersistence()',
    ]),
    integrated('zeus:conversation-store-migration:retry', 'apps/desktop/src/main/main.ts', '迁移先接纳并写 marker，receipt 落盘后才允许 relaunch/exit。', 'desktop.conversation_store_migration.retry', [
      'prepareDesktopConversationStoreMigration(',
      'command.markWriteStarted()',
    ]),
    integrated(
      'zeus:storage-recovery:preflight-and-restart',
      'apps/desktop/src/main/main.ts',
      '恢复 POST 使用稳定 operation identity；预检通过即先固化内存重启意图，finally 保证 receipt 再次失败也会调度。',
      'desktop.storage_recovery.preflight_restart',
      ['recovery-preflight', 'command.markWriteStarted()', 'storageRecoveryRestart.ensureScheduled('],
    ),
    integrated('zeus:project-git:execute-action', 'apps/desktop/src/main/main.ts', 'Git 写动作具有稳定 identity/write marker/四态 receipt；unknown 不自动重试。', 'desktop.project_git.execute_action', [
      'workbench.execute(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:project-source:save-file', 'apps/desktop/src/main/main.ts', '源码保存保留 revision CAS、临时文件 fsync 与原子 rename，并写 Main receipt。', 'desktop.project_source.save_file', [
      'workspace.saveFile(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:project-source:create-entry', 'apps/desktop/src/main/main.ts', '源码创建使用 exclusive create、目录 fsync 与 Main receipt。', 'desktop.project_source.create_entry', [
      'workspace.createEntry(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:project-source:move-entry', 'apps/desktop/src/main/main.ts', '源码移动校验源/目标后原子 rename，并 fsync 两侧目录。', 'desktop.project_source.move_entry', ['workspace.moveEntry(', 'command.markWriteStarted()']),
    integrated('zeus:project-source:trash-entry', 'apps/desktop/src/main/main.ts', '系统废纸篓动作先封存 marker，失败后结果 unknown 且不盲重试。', 'desktop.project_source.trash_entry', [
      'workspace.trashEntry(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:release:download-update', 'apps/desktop/src/main/main.ts', '更新下载以稳定 operation identity 记录 write marker 与有界 receipt。', 'desktop.release.download_update', ['service.download(', 'command.markWriteStarted()']),
    integrated('zeus:release:install-update', 'apps/desktop/src/main/main.ts', '安装 handoff 在 receipt 落盘后才退出 Main。', 'desktop.release.install_update', ['service.install(', 'command.markWriteStarted()']),
    integrated('zeus:automatic-update-indicator:open', 'apps/desktop/src/main/main.ts', '更新窗口/检查流程由稳定 Command identity 接管。', 'desktop.automatic_update.open', ['controller.showOrCheck(', 'command.markWriteStarted()']),
    integrated('zeus:automatic-update-indicator:record-manual-check', 'apps/desktop/src/main/main.ts', '调度水位写入具有 marker 与 receipt。', 'desktop.automatic_update.record_manual_check', [
      'scheduler.recordCheckCompleted(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:materialize-conversation-resources', 'apps/desktop/src/main/main.ts', '会话资源以 commandId 派生目标并用 staging+fsync+hard-link no-replace/CAS 发布。', 'desktop.conversation_resources.materialize', [
      'broker.materialize(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:read-conversation-clipboard-resources', 'apps/desktop/src/main/main.ts', '可能物化的剪贴板读取纳入同一 Command envelope。', 'desktop.conversation_resources.read_clipboard', [
      'broker.readClipboard(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:discard-conversation-resources', 'apps/desktop/src/main/main.ts', '精确资源删除在 marker 后执行并生成 receipt。', 'desktop.conversation_resources.discard', ['broker.discard(', 'command.markWriteStarted()']),
    integrated('zeus:choose-task-attachments', 'apps/desktop/src/main/main.ts', '一次选择意图对应一个 envelope；文件以 hard-link no-replace，目录以 O_EXCL claim 后原子发布。', 'desktop.task_resources.choose', [
      'saveTaskResourcePaths(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:store-task-resource-paths', 'apps/desktop/src/main/main.ts', '路径复制绑定 commandId，并以 no-replace/CAS 原子发布。', 'desktop.task_resources.store_paths', ['saveTaskResourcePaths(', 'command.markWriteStarted()']),
    integrated('zeus:materialize-task-resources', 'apps/desktop/src/main/main.ts', '任务载荷以内容摘要与 commandId 派生目标，并以 hard-link no-replace 原子发布。', 'desktop.task_resources.materialize', [
      'saveTaskAttachmentPayloads(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:save-task-clipboard-attachments', 'apps/desktop/src/main/main.ts', '剪贴板保存使用稳定意图与确定性资源路径。', 'desktop.task_resources.save_clipboard', [
      'readTaskClipboardResourcesFromNativeClipboard(',
      'command.markWriteStarted()',
    ]),
    integrated('zeus:save-task-pasted-attachments', 'apps/desktop/src/main/main.ts', '粘贴附件以 staging+fsync+hard-link no-replace 发布并记录 ArtifactRef receipt。', 'desktop.task_resources.save_pasted', [
      'saveTaskAttachmentPayloads(',
      'command.markWriteStarted()',
    ]),
  ]);
}

function createNativeActionDeclarations() {
  return new Map([
    ['openSettings', nativePlatform('导航到现有设置页，不写业务事实。', 'macOS 原生菜单显式点击。', '重复导航到同一设置页幂等。', ['openSettings: () => {', 'openSettingsFromMenu()'])],
    [
      'checkForUpdates',
      nativeIntegrated('原生更新检查使用稳定 Main Command identity；外部动作前写 marker，receipt 后才允许升级退出。', 'desktop.automatic_update.menu_check', [
        'checkForUpdates: () => {',
        'checkForUpdatesFromMenu()',
        "createSystemMainCommandEnvelope('desktop.automatic_update.menu_check'",
      ]),
    ],
    ['showMainWindow', nativePlatform('显示或激活现有主窗口。', 'macOS 菜单或 Tray 显式点击。', '重复显示同一窗口幂等。', ['showMainWindow: () => {', 'requestMainWindow()'])],
    ['openLogsDirectory', nativePlatform('创建并由系统打开本机日志目录，不改业务事实。', 'macOS 原生菜单显式点击。', '重复打开只重复 Finder 动作；目录创建 recursive 幂等。', ['openLogsDirectory: () => {', 'openLogsDirectoryFromMenu()'])],
    ['quit', nativePlatform('发起 Electron 全局关闭生命周期。', 'macOS 菜单或 Tray 显式退出。', '首次调用进入全局关闭屏障。', ['quit: () => app.quit()'])],
    [
      'createNewConversation',
      nativePlatform('只通知 Renderer 打开新的会话草稿；真正创建走后续业务入口。', 'macOS 原生菜单显式点击。', '每次点击表示新的草稿意图，Main 不自动重试。', ['createNewConversation: () => {', 'startNewConversationFromMenu()']),
    ],
    ['toggleDevTools', nativePlatform('切换当前主窗口 DevTools。', 'macOS 原生开发菜单显式点击。', 'toggle 是用户手势，不自动重试。', ['toggleDevTools: () => mainWindow?.webContents.toggleDevTools()'])],
    ['closeFocusedWindow', nativePlatform('关闭当前窗口或最前 UI layer。', 'macOS 原生关闭菜单/快捷键。', '当前焦点决定一次消费，不自动重试。', ['closeFocusedWindow: closeFocusedWindowOrContextTab'])],
    ['createWindow', nativePlatform('创建新的受控 Zeus 窗口。', 'Tray 菜单显式点击。', '每次点击表示一个独立窗口意图。', ['createWindow: () => {', 'void createWindow()'])],
  ]);
}

function nonMutating(channel, file, reason, requiredMarkers) {
  return [channel, { file, effect: 'non_mutating', reason, confirmation: '不适用；该入口不改变业务或平台状态。', idempotency: '只读请求可安全重复。', requiredMarkers }];
}

function platform(channel, file, reason, confirmation, idempotency, requiredMarkers) {
  return [channel, { file, effect: 'platform_capability', classification: 'platform_capability_excluded', reason, confirmation, idempotency, commandBoundary: null, requiredMarkers }];
}

function integrated(channel, file, reason, commandType, requiredMarkers) {
  const ledgerMarker = file.endsWith('/browserHost.ts') ? 'this.options.mainCommandLedger().execute' : 'activeMainCommandLedger().execute';
  return [
    channel,
    {
      file,
      effect: 'durable_or_external_mutation',
      classification: 'integrated',
      reason,
      confirmation: 'Renderer 或受控页面为一次用户意图生成并冻结一个 Command Envelope；Main 在任何真实写出前耐久接纳。',
      idempotency: '同一 identity 只回放 receipt；failed-before-write 明确失败，unknown-after-write 禁止自动重试；大结果仅以 ArtifactRef 持久化。',
      commandBoundary: `MainCommandLedger:${commandType}`,
      requiredMarkers: [`'${commandType}'`, ledgerMarker, ...requiredMarkers],
    },
  ];
}

function nativePlatform(reason, confirmation, idempotency, requiredMainMarkers) {
  return { effect: 'platform_capability', classification: 'platform_capability_excluded', reason, confirmation, idempotency, commandBoundary: null, requiredMainMarkers };
}

function nativeIntegrated(reason, commandType, requiredMainMarkers) {
  return {
    effect: 'durable_or_external_mutation',
    classification: 'integrated',
    reason,
    confirmation: 'macOS 原生菜单点击现场生成一个不可变 Command Envelope。',
    idempotency: '每次点击一个 identity；写出后 unknown 禁止自动重试，完成后仅回 receipt。',
    commandBoundary: `MainCommandLedger:${commandType}`,
    requiredMainMarkers: [...requiredMainMarkers, 'command.markWriteStarted()', 'activeMainCommandLedger().execute'],
  };
}

async function collectTypeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && /\.(?:cts|ts)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

function discoverIpcRegistrations(sourceMap) {
  const registrations = [];
  const seen = new Map();
  for (const [file, content] of sourceMap) {
    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'ipcMain' &&
        (node.expression.name.text === 'handle' || node.expression.name.text === 'on')
      ) {
        const channelNode = node.arguments[0];
        const handlerNode = node.arguments[1];
        if (!channelNode || !ts.isStringLiteralLike(channelNode) || !handlerNode) {
          throw new Error(`ipcMain registration at ${file}:${lineOf(sourceFile, node)} must use a literal channel and inline handler.`);
        }
        const channel = channelNode.text;
        if (seen.has(channel)) throw new Error(`Duplicate ipcMain channel ${channel} at ${seen.get(channel)} and ${file}:${lineOf(sourceFile, node)}.`);
        seen.set(channel, `${file}:${lineOf(sourceFile, node)}`);
        registrations.push({ file, line: lineOf(sourceFile, node), channel, registrationKind: node.expression.name.text, handlerText: handlerNode.getText(sourceFile) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return registrations.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

function discoverNativeMenuActions(sourceMap) {
  const file = 'apps/desktop/src/main/appShellPolicy.ts';
  const content = sourceMap.get(file) ?? '';
  const actions = new Map();
  for (const match of content.matchAll(/click:\s*actions\.([A-Za-z][A-Za-z0-9]*)/gu)) {
    const action = match[1];
    if (!actions.has(action)) actions.set(action, { action, file, line: 1 + content.slice(0, match.index).split('\n').length - 1 });
  }
  return [...actions.values()].sort((left, right) => left.action.localeCompare(right.action));
}

function verifySensitivePrimitives(sourceMap, sideEffects, reads) {
  const allMainSources = [...sourceMap.values()].join('\n');
  const mainSource = sourceMap.get('apps/desktop/src/main/main.ts') ?? '';
  const conversationResourceSource = sourceMap.get('apps/desktop/src/main/conversationInputResources.ts') ?? '';
  const gitSource = sourceMap.get('apps/desktop/src/main/projectGitWorkbench.ts') ?? '';
  const ledgerSource = sourceMap.get('apps/desktop/src/main/mainCommandLedger.ts') ?? '';
  const ledgerVerifier = startupSources.get('scripts/verify-main-command-ledger-behavior.ts') ?? '';
  const boundedReadBody = findNamedBodyText(ledgerSource, 'readBoundedBytes');
  const keychainMutationCalls = allMainSources.match(/\.(?:deleteSecret|setSecret)\s*\(/gu)?.length ?? 0;
  const keychainReadCalls = allMainSources.match(/\.getSecret\s*\(/gu)?.length ?? 0;
  const has = (channel, classification) => sideEffects.some((entry) => entry.channel === channel && entry.classification === classification);
  return {
    everyIpcRegistrationHasExactDeclaration: ipcRegistrations.length === ipcDeclarations.size,
    everyNativeActionHasExactDeclaration: nativeActions.length === nativeActionDeclarations.size,
    gitMutationPrimitiveMappedIntegrated: gitSource.includes('executeProjectGitAction(') && has('zeus:project-git:execute-action', 'integrated'),
    releaseDownloadAndInstallMappedIntegrated: mainSource.includes('service.download()') && mainSource.includes('service.install()') && has('zeus:release:download-update', 'integrated') && has('zeus:release:install-update', 'integrated'),
    publicFilesystemMutatorsMappedIntegrated: [
      'zeus:project-source:save-file',
      'zeus:project-source:create-entry',
      'zeus:project-source:move-entry',
      'zeus:project-source:trash-entry',
      'zeus:materialize-conversation-resources',
      'zeus:discard-conversation-resources',
    ].every((channel) => has(channel, 'integrated')),
    shellAndClipboardCapabilitiesArePerEntry: ['zeus:open-external-https-url', 'zeus:project-source:open-external', 'zeus:write-clipboard-text', 'zeus:open-graph-source'].every((channel) => has(channel, 'platform_capability_excluded')),
    noKeychainMutationCallsites: keychainMutationCalls === 0,
    singleScopedKeychainReadIsNonMutating: keychainReadCalls === 1 && reads.some((entry) => entry.channel === 'zeus:zentao:parse-link'),
    mainCommandIntegrationHasEnvelopeAndFourStateReceipt:
      ledgerSource.includes('parseCommandEnvelope(') &&
      ledgerSource.includes("state: writeStarted ? 'unknown_after_write' : 'failed_before_write'") &&
      ledgerSource.includes("state: 'receipted'") &&
      ledgerSource.includes('markWriteStarted') &&
      ledgerSource.includes('O_NOFOLLOW') &&
      sideEffects.filter((entry) => entry.classification === 'integrated').every((entry) => entry.commandBoundary?.startsWith('MainCommandLedger:')),
    mainCommandStableReplayAndInFlightIdentityVerified:
      ledgerSource.includes('identitySha256') &&
      !ledgerSource.slice(ledgerSource.indexOf('const envelopeRecord'), ledgerSource.indexOf('const created = await writeImmutableJson')).includes('acceptedAt') &&
      ledgerVerifier.includes('differentIdentityRejected') &&
      ledgerVerifier.includes('stableReceipt'),
    mainCommandCrashRecoveryAndDurableMarkerVerified:
      ledgerSource.includes('#sealOrphanEnvelopes') &&
      ledgerSource.indexOf('await writeAtomicJson(outcomePath, durableMarkerOutcome)') < ledgerSource.indexOf('writeStarted = true') &&
      ledgerVerifier.includes('markerPersistenceFailure') &&
      ledgerVerifier.includes('orphan: orphanOutcome?.state'),
    mainCommandReadsAreBoundedAndConcurrentGrowthVerified:
      boundedReadBody.includes('maximumBytes + 1 - totalBytes') &&
      boundedReadBody.includes('handle.read(') &&
      boundedReadBody.includes('handle.stat()') &&
      !boundedReadBody.includes('handle.readFile(') &&
      ledgerVerifier.includes('concurrentGrowthRejected') &&
      ledgerVerifier.includes('boundedReadRejected'),
    mainCommandReceiptSchemaAndArtifactPathVerified:
      ledgerSource.includes('parseMainCommandOutcome(') &&
      ledgerSource.includes('exactRecord(') &&
      ledgerSource.includes("reference.relativePath !== join('artifacts'") &&
      ledgerSource.includes('parseLedgerJson(') &&
      ledgerVerifier.includes('malformedJsonRejected') &&
      ledgerVerifier.includes('exactSchemaRejectedExtraKey') &&
      ledgerVerifier.includes('artifactPathEscapeRejected'),
    mainCommandFilesystemSecurityAndOversizeSemanticsVerified:
      ledgerSource.includes('O_NOFOLLOW') &&
      ledgerSource.includes('0o600') &&
      ledgerSource.includes('0o700') &&
      ledgerSource.includes("kind: 'result_omitted'") &&
      ledgerSource.includes('ZEUS_MAIN_COMMAND_RESULT_NOT_REPLAYABLE') &&
      ledgerVerifier.includes('symlinkRejected') &&
      ledgerVerifier.includes('oversizedKind'),
    localResourceAtomicCasVerified:
      conversationResourceSource.includes('await link(temporaryPath, destination)') &&
      conversationResourceSource.includes('CAS destination contains different bytes') &&
      mainSource.includes('async function publishTaskResourceFile') &&
      mainSource.includes('await link(staging, destination)') &&
      mainSource.includes("await open(claimPath, 'wx', 0o600)") &&
      ledgerVerifier.includes('concurrentPublicationCount') &&
      ledgerVerifier.includes('conflictingBytesRejected'),
  };
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function stableEntryId(kind, file, operation) {
  return `electron_main_${createHash('sha256').update(`${kind}\0${file}\0${operation}`).digest('hex').slice(0, 20)}`;
}

function compareEntries(left, right) {
  return left.file.localeCompare(right.file) || left.line - right.line || left.operation.localeCompare(right.operation);
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = selector(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
