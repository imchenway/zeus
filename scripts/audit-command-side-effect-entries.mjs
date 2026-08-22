import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const repositoryRoot = resolve(process.cwd());
const sourceRoot = join(repositoryRoot, 'packages/local-server/src');
const requireComplete = process.argv.includes('--require-complete');
const requireConversationSlice = process.argv.includes('--require-conversation-slice');
const requireConversationCommandSlice = process.argv.includes('--require-conversation-command-slice');
const requireConversationDispatchCommandSlice = process.argv.includes('--require-conversation-dispatch-command-slice');
const requireIntegrationCommandSlice = process.argv.includes('--require-integration-command-slice');
const requireSettingsCommandSlice = process.argv.includes('--require-settings-command-slice');
const requireGitCommandSlice = process.argv.includes('--require-git-command-slice');
const requireWorkspaceGitCommandSlice = process.argv.includes('--require-workspace-git-command-slice');
const requireWorkManagementTaskCommandSlice = process.argv.includes('--require-work-management-task-command-slice');
const requireExecutionHostStopCommandSlice = process.argv.includes('--require-execution-host-stop-command-slice');
const requireTelegramCommandSlice = process.argv.includes('--require-telegram-command-slice');
const requireGraphConversationCreateCommandSlice = process.argv.includes('--require-graph-conversation-create-command-slice');
const files = (await collectTypeScriptFiles(sourceRoot)).sort();
const entries = [];
const sourceHash = createHash('sha256');
const sources = new Map();

for (const absolutePath of files) {
  const content = await readFile(absolutePath, 'utf8');
  const file = relative(repositoryRoot, absolutePath).split('\\').join('/');
  sources.set(file, content);
  sourceHash.update(`${file}\0${content}\0`);
}

const providerRuntimeRecoveryRoute = sources.get('packages/local-server/src/providerRuntimeControlApi.ts') ?? '';
const providerRuntimeRecoveryService = sources.get('packages/local-server/src/providerRuntimeRecoveryService.ts') ?? '';
const piCoordinator = sources.get('packages/local-server/src/piNativeConversationCoordinator.ts') ?? '';
const piProviderCommandService = sources.get('packages/local-server/src/piProviderCommandDelivery.ts') ?? '';
const codexCoordinator = sources.get('packages/local-server/src/codexNativeConversationCoordinator.ts') ?? '';
const codexProviderCommandService = sources.get('packages/local-server/src/codexProviderCommandApplication.ts') ?? '';
const codexGoalApplication = sources.get('packages/local-server/src/codexGoalApplication.ts') ?? '';
const codexDynamicToolApplication = sources.get('packages/local-server/src/codexDynamicToolApplication.ts') ?? '';
const codexFinalShutdownApplication = sources.get('packages/local-server/src/codexFinalShutdownApplication.ts') ?? '';
const codexPortableContextCompaction = sources.get('packages/local-server/src/codexPortableContextCompaction.ts') ?? '';
const codexPublicCommandApplication = sources.get('packages/local-server/src/codexPublicCommandApplication.ts') ?? '';
const codexPublicCommandRoutes = sources.get('packages/local-server/src/codexPublicCommandRoutes.ts') ?? '';
const memoryContextApi = sources.get('packages/local-server/src/memoryContextApi.ts') ?? '';
const commandCenter = sources.get('packages/local-server/src/commandCenter.ts') ?? '';
const commandCenterApplication = sources.get('packages/local-server/src/commandCenterCommandApplication.ts') ?? '';
const workManagementApplication = sources.get('packages/local-server/src/workManagementCommandApplication.ts') ?? '';
const workManagementCoreRoutes = sources.get('packages/local-server/src/workManagementCoreCommandRoutes.ts') ?? '';
const workManagementCoreOperations = sources.get('packages/local-server/src/workManagementCoreOperations.ts') ?? '';
const workManagementProjectRoutes = sources.get('packages/local-server/src/workManagementProjectCommandRoutes.ts') ?? '';
const workManagementProjectOperations = sources.get('packages/local-server/src/workManagementProjectOperations.ts') ?? '';
const workManagementTaskRoutes = sources.get('packages/local-server/src/workManagementTaskCommandRoutes.ts') ?? '';
const workManagementTaskOperations = sources.get('packages/local-server/src/workManagementTaskOperations.ts') ?? '';
const workManagementTaskEffects = sources.get('packages/local-server/src/workManagementTaskEffectService.ts') ?? '';
const taskEventFileProjectionService = sources.get('packages/local-server/src/taskEventFileProjectionService.ts') ?? '';
const runtimeSessionApplication = sources.get('packages/local-server/src/runtimeSessionCommandApplication.ts') ?? '';
const runtimeSessionRoutes = sources.get('packages/local-server/src/runtimeSessionCommandRoutes.ts') ?? '';
const conversationCommandApplication = sources.get('packages/local-server/src/conversationCommandApplication.ts') ?? '';
const conversationDispatchCommandApplication = sources.get('packages/local-server/src/conversationDispatchCommandApplication.ts') ?? '';
const conversationDispatchCommandRoutes = sources.get('packages/local-server/src/conversationDispatchCommandRoutes.ts') ?? '';
const conversationQueueCoreMutationApplication = sources.get('packages/local-server/src/conversationQueueCoreMutationApplication.ts') ?? '';
const integrationCommandApplication = sources.get('packages/local-server/src/integrationCommandApplication.ts') ?? '';
const integrationCommandRoutes = sources.get('packages/local-server/src/integrationCommandRoutes.ts') ?? '';
const settingsCommandApplication = sources.get('packages/local-server/src/settingsCommandApplication.ts') ?? '';
const telegramCommandApplication = sources.get('packages/local-server/src/telegramCommandApplication.ts') ?? '';
const telegramPollingApi = sources.get('packages/local-server/src/telegramPollingApi.ts') ?? '';
const gitCommandApplication = sources.get('packages/local-server/src/gitCommandApplication.ts') ?? '';
const gitCommandRoutes = sources.get('packages/local-server/src/gitCommandRoutes.ts') ?? '';
const workspaceGitCommandApplication = sources.get('packages/local-server/src/workspaceGitCommandApplication.ts') ?? '';
const workspaceGitCommandRoutes = sources.get('packages/local-server/src/workspaceGitCommandRoutes.ts') ?? '';
const graphConversationCommandApplication = sources.get('packages/local-server/src/graphConversationCommandApplication.ts') ?? '';
const graphConversationCommandRoutes = sources.get('packages/local-server/src/graphConversationCommandRoutes.ts') ?? '';
const releaseUpdateApi = sources.get('packages/local-server/src/releaseUpdateApi.ts') ?? '';
const storageRecoveryPreflightApi = sources.get('packages/local-server/src/storageRecoveryPreflightApi.ts') ?? '';
const executionHostControlApi = sources.get('packages/local-server/src/executionHostControlApi.ts') ?? '';
const executionHostStopCommandApplication = sources.get('packages/local-server/src/executionHostStopCommandApplication.ts') ?? '';
const executionHostHandoffApi = sources.get('packages/local-server/src/executionHostHandoffApi.ts') ?? '';
const localServerRouteAssemblyFile = 'packages/local-server/src/localServerPlatformRoutes.ts';
const localServerComposition = [
  'packages/local-server/src/index.ts',
  localServerRouteAssemblyFile,
  'packages/local-server/src/localServerSupportOperations.ts',
  'packages/local-server/src/conversationApplicationOperations.ts',
  'packages/local-server/src/gitIntegrationOperations.ts',
  'packages/local-server/src/taskRuntimeOperations.ts',
]
  .map((path) => sources.get(path) ?? '')
  .join('\n');
const isLocalServerRouteAssemblyFile = (file) => file === 'packages/local-server/src/index.ts' || file === localServerRouteAssemblyFile;
const releaseNotesGeneration = sources.get('packages/local-server/src/releaseNotesGeneration.ts') ?? '';
const sharedCommandEnvelope = await readFile(join(repositoryRoot, 'packages/shared/src/commandEnvelope.ts'), 'utf8');
const codexAppServerManager = await readFile(join(repositoryRoot, 'packages/ai-runtime/src/codexAppServerManager.ts'), 'utf8');
const zarchGate = await readFile(join(repositoryRoot, 'scripts/verify-zarch-gates.mjs'), 'utf8');
const commandCenterRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/command-center/commandCenterCommandClient.ts'), 'utf8');
const workManagementRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/work-management/workManagementCommandClient.ts'), 'utf8');
const projectRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/projects/projectApiClient.ts'), 'utf8');
const taskRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/tasks/taskApiClient.ts'), 'utf8');
const codexPublicRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/codex/codexPublicCommandClient.ts'), 'utf8');
const desktopApiClient = (
  await Promise.all(
    [
      'apps/desktop/src/renderer/apiClient.ts',
      'apps/desktop/src/renderer/features/codex/codexApiClient.ts',
      'apps/desktop/src/renderer/features/command-center/commandCenterApiClient.ts',
      'apps/desktop/src/renderer/features/dashboard/dashboardApiClient.ts',
      'apps/desktop/src/renderer/features/graph/graphApiClient.ts',
      'apps/desktop/src/renderer/features/runtime/runtimeApiClient.ts',
    ].map((path) => readFile(join(repositoryRoot, path), 'utf8')),
  )
).join('\n');
const remoteControlRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/remote/remoteControlApiClient.ts'), 'utf8');
const runtimeSessionRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/runtime/runtimeSessionCommandClient.ts'), 'utf8');
const conversationCommandRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/conversations/conversationCommandClient.ts'), 'utf8');
const conversationDispatchCommandRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/conversations/conversationDispatchCommandClient.ts'), 'utf8');
const integrationCommandRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/integrations/integrationApiClient.ts'), 'utf8');
const integrationCommandEnvelopeClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/integrations/integrationCommandClient.ts'), 'utf8');
const settingsCommandRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/settings/settingsCommandClient.ts'), 'utf8');
const settingsRendererApiClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/settings/settingsApiClient.ts'), 'utf8');
const settingsCommandBehaviorVerifier = await readFile(join(repositoryRoot, 'scripts/verify-settings-command-behavior.ts'), 'utf8');
const telegramCommandRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/telegram/telegramCommandClient.ts'), 'utf8');
const telegramRendererApiClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/telegram/telegramApiClient.ts'), 'utf8');
const conversationRendererApiClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/conversations/conversationApiClient.ts'), 'utf8');
const gitCommandRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/git/gitCommandClient.ts'), 'utf8');
const workspaceGitCommandRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/git/workspaceGitCommandClient.ts'), 'utf8');
const graphConversationCommandRendererClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/conversations/graphConversationCommandClient.ts'), 'utf8');
const gitRendererApiClient = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/git/gitApiClient.ts'), 'utf8');
const desktopExecutionHostStopCommand = await readFile(join(repositoryRoot, 'apps/desktop/src/main/executionHostStopCommand.ts'), 'utf8');
const desktopExecutionHostProtocol = await readFile(join(repositoryRoot, 'apps/desktop/src/main/executionHostProtocol.ts'), 'utf8');
const desktopExecutionHost = await readFile(join(repositoryRoot, 'apps/desktop/src/main/executionHost.ts'), 'utf8');
const desktopLocalServerRuntime = await readFile(join(repositoryRoot, 'apps/desktop/src/main/localServerRuntime.ts'), 'utf8');
const desktopMain = await readFile(join(repositoryRoot, 'apps/desktop/src/main/main.ts'), 'utf8');
const executionHostStopBehaviorVerifier = await readFile(join(repositoryRoot, 'scripts/verify-execution-host-stop-command-behavior.ts'), 'utf8');
const piProviderCommandBehaviorVerifier = await readFile(join(repositoryRoot, 'scripts/verify-pi-provider-command-delivery.ts'), 'utf8');
const releaseUpdateReadOnlyOperations = new Set(['POST /api/release/check-update', 'POST /api/release/download-update', 'POST /api/release/install-update']);
const releaseUpdateSnapshotBlock = sourceBlock(releaseUpdateApi, 'const snapshot = async () =>', "\n  options.server.get('/api/release/update-status'");
const releaseUpdateReadOnlyReady =
  (releaseUpdateApi.match(/classification: 'read_only'/gu)?.length ?? 0) === 3 &&
  (releaseUpdateApi.match(/writesBusinessState: false/gu)?.length ?? 0) === 3 &&
  (releaseUpdateApi.match(/invokesDownload: false/gu)?.length ?? 0) === 3 &&
  (releaseUpdateApi.match(/invokesInstall: false/gu)?.length ?? 0) === 3 &&
  (releaseUpdateApi.match(/commandLedger: 'not_applicable'/gu)?.length ?? 0) === 3 &&
  releaseUpdateSnapshotBlock.includes('options.buildUpdateStatus()') &&
  releaseUpdateSnapshotBlock.includes('options.readExecutionHostStatus()') &&
  !['writeFile', 'download(', 'install(', 'app.quit', '.save(', '.setJson(', 'executeCore', 'executeExternal'].some((marker) => releaseUpdateSnapshotBlock.includes(marker)) &&
  sourceBlock(releaseUpdateApi, "options.server.post('/api/release/download-update'", "\n  options.server.post('/api/release/install-update'").includes('accepted: false') &&
  sourceBlock(releaseUpdateApi, "options.server.post('/api/release/install-update'", '\n}').includes('accepted: false');
const storageRecoveryPreflightBlock = sourceBlock(storageRecoveryPreflightApi, "options.server.post('/api/diagnostics/storage/recovery-preflight'", '\n}');
const storageRecoveryDiagnosticCapabilityReady =
  storageRecoveryPreflightApi.includes("classification: 'diagnostic_capability'") &&
  storageRecoveryPreflightApi.includes('writesBusinessState: false') &&
  storageRecoveryPreflightApi.includes('requiresWritableCommandLedger: false') &&
  storageRecoveryPreflightApi.includes('safelyRepeatable: true') &&
  storageRecoveryPreflightApi.includes("commandLedger: 'not_applicable'") &&
  storageRecoveryPreflightBlock.includes('options.db.runWriteRecoveryPreflight()') &&
  storageRecoveryPreflightBlock.includes('options.artifacts.runRecoveryPreflight()') &&
  !['executeCore', 'executeExternal', '.setJson(', 'appendAuditLog(', 'publishRealtimeEvent('].some((marker) => storageRecoveryPreflightBlock.includes(marker)) &&
  localServerComposition.includes('registerStorageRecoveryPreflightApi({ server, db, artifacts: artifactStore });');
const releaseNotesCapabilityRegistryBlock = sourceBlock(localServerComposition, 'const releaseNotesCapabilityPolicy = {', '\n\n  function appendAuditLog(');
const releaseNotesAuthorizationBlock = sourceBlock(localServerComposition, 'function authorizeReleaseNotesRequest(', '\n\n  function appendAuditLog(');
const releaseNotesRouteBlock = sourceBlock(localServerComposition, "server.post(\n    '/api/command-runs/:runId/release-notes'", '\n\n  const commandCenter =');
const releaseNotesEphemeralCapabilityReady =
  releaseNotesCapabilityRegistryBlock.includes("classification: 'ephemeral_capability'") &&
  releaseNotesCapabilityRegistryBlock.includes('ttlMs: 10 * 60 * 1_000') &&
  releaseNotesCapabilityRegistryBlock.includes('maximumEntries: 256') &&
  releaseNotesCapabilityRegistryBlock.includes('oneShot: true') &&
  releaseNotesCapabilityRegistryBlock.includes('durableReplay: false') &&
  releaseNotesCapabilityRegistryBlock.includes("commandLedger: 'not_applicable'") &&
  releaseNotesCapabilityRegistryBlock.includes('const releaseNotesAuthorizedRequests = new WeakSet<object>()') &&
  releaseNotesCapabilityRegistryBlock.includes('pruneReleaseNotesCapabilities()') &&
  releaseNotesCapabilityRegistryBlock.includes('existing.projectId !== input.projectId || existing.used') &&
  releaseNotesCapabilityRegistryBlock.includes('token: existing.token') &&
  releaseNotesCapabilityRegistryBlock.includes('releaseNotesCapabilities.size >= releaseNotesCapabilityPolicy.maximumEntries') &&
  releaseNotesCapabilityRegistryBlock.includes('expiresAt: Date.now() + releaseNotesCapabilityPolicy.ttlMs') &&
  releaseNotesAuthorizationBlock.includes('capability.used') &&
  releaseNotesAuthorizationBlock.includes('request.headers.authorization !== `Bearer ${capability.token}`') &&
  releaseNotesAuthorizationBlock.includes('capability.used = true') &&
  releaseNotesAuthorizationBlock.includes('runId = decodeURIComponent(') &&
  releaseNotesAuthorizationBlock.includes('catch {') &&
  releaseNotesAuthorizationBlock.includes('releaseNotesAuthorizedRequests.add(request)') &&
  releaseNotesRouteBlock.includes('releaseNotesAuthorizedRequests.has(request)') &&
  releaseNotesRouteBlock.includes('run.projectId !== capability.projectId') &&
  releaseNotesRouteBlock.includes('generateReleaseNotesWithDeepSeek(modelConnections, { model, prompt })') &&
  releaseNotesRouteBlock.includes('finally {') &&
  releaseNotesRouteBlock.includes('revokeReleaseNotesCapability(request.params.runId)') &&
  releaseNotesGeneration.includes('prompt.length > 400_000') &&
  !['executeCore(', 'executeExternal(', 'commandDeliveries.', 'db.save(', '.setJson(', 'appendAuditLog('].some((marker) => releaseNotesRouteBlock.includes(marker));
const executionHostHandoffPrepareBlock = sourceBlock(executionHostHandoffApi, "options.server.post('/api/execution-host/handoff/prepare'", "\n\n  options.server.get('/api/execution-host/handoff/:handoffId/prepared'");
const executionHostHandoffControlCapabilityReady =
  executionHostHandoffApi.includes("classification: 'handoff_control_capability'") &&
  executionHostHandoffApi.includes('writesBusinessState: false') &&
  executionHostHandoffApi.includes("durableJournal: 'execution_host_handoffs'") &&
  executionHostHandoffApi.includes('singleFlight: true') &&
  executionHostHandoffApi.includes("commandLedger: 'not_applicable'") &&
  executionHostHandoffApi.includes('let preparationPromise: Promise<') &&
  executionHostHandoffPrepareBlock.includes('if (preparationPromise) return preparationPromise') &&
  executionHostHandoffApi.includes("options.fence.transition('draining')") &&
  executionHostHandoffApi.includes('options.repository.startDraining({') &&
  executionHostHandoffApi.includes('await options.fence.waitForAdmittedMutations()') &&
  executionHostHandoffApi.includes('options.freezeBusinessMutationAdmission()') &&
  executionHostHandoffApi.includes('options.prepareJournal(handoffId, options.now().toISOString())') &&
  executionHostHandoffApi.includes("options.fence.transition('prepared')") &&
  executionHostHandoffApi.includes('options.requireRecoveryJournal(') &&
  !['commandDeliveries.', 'executeCore(', 'executeExternal('].some((marker) => executionHostHandoffApi.includes(marker));
const executionHostStopRouteBlock = sourceBlock(executionHostControlApi, "options.server.post('/api/execution-host/stop-active'", '\n  return { readStatus };');
const detachedStopIdentityBlock = sourceBlock(desktopLocalServerRuntime, '      stopActiveWork: async () => {\n        // 一次用户动作只生成一次命令', '\n      close:');
const executionHostStopCommandMarkers = {
  stablePublicEnvelope:
    executionHostStopCommandApplication.includes("assertExactKeys(request, ['command', 'input']") &&
    executionHostStopCommandApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") &&
    executionHostStopCommandApplication.includes("command.scope.kind !== 'execution_host'") &&
    executionHostStopCommandApplication.includes('executionHostStopActiveScopeId') &&
    executionHostStopCommandApplication.includes('inputSha256 does not match Body.input'),
  externalLedgerAndFourOutcomes:
    executionHostStopCommandApplication.includes("classification: 'external_operation'") &&
    executionHostStopCommandApplication.includes("outcomes: ['failed_before_write', 'explicitly_rejected', 'outcome_unknown_after_write', 'accepted']") &&
    executionHostStopCommandApplication.includes('this.options.deliveries.acceptAndPrepare({') &&
    executionHostStopCommandApplication.includes("destinationKind: 'external_operation'") &&
    executionHostStopCommandApplication.includes('markExternalWriteStarted({') &&
    executionHostStopCommandApplication.includes("outcome: 'accepted'") &&
    executionHostStopCommandApplication.includes("'outcome_unknown_after_write'") &&
    executionHostStopCommandApplication.includes('automaticRetryAfterUnknown: false'),
  acceptedReplayAndConcurrentDuplicate:
    executionHostStopCommandApplication.includes('private readonly activeExecutions = new Map<') &&
    executionHostStopCommandApplication.includes('const active = this.activeExecutions.get(activeKey)') &&
    executionHostStopCommandApplication.includes("latest.outcome !== 'accepted'") &&
    executionHostStopCommandApplication.includes("state: 'accepted_replay'") &&
    executionHostStopCommandApplication.includes('readAcceptedResult(preparation.receipt)'),
  boundedRedactedReceipt:
    executionHostStopCommandApplication.includes('receiptMaximumBytes: 64 * 1024') &&
    executionHostStopCommandApplication.includes('errorMaximumBytes: 2 * 1024') &&
    executionHostStopCommandApplication.includes('failedTurnMaximumEntries: 16') &&
    executionHostStopCommandApplication.includes('failedTurnMessageMaximumBytes: 512') &&
    executionHostStopCommandApplication.includes('redactSensitiveText(value).text') &&
    executionHostStopCommandApplication.includes('assertJsonBudget(evidence, executionHostStopCommandPolicy.receiptMaximumBytes'),
  routeExecutesPreparedExternalCommand:
    executionHostStopRouteBlock.includes('Body: ExecutionHostStopActiveCommandRequest') &&
    executionHostStopRouteBlock.includes('executeStopCommand(options, request.body, reply)') &&
    executionHostControlApi.includes('const parsed = options.stopCommands.parse(request)') &&
    executionHostControlApi.includes('beforeWrite: async () => {') &&
    executionHostControlApi.includes('plan = prepareStopActiveWork(options, parsed)') &&
    executionHostControlApi.includes('invoke: () => stopActiveWork(options, requirePreparedPlan(plan))'),
  providerInterruptOnceInParallelWithoutTerminalWait:
    executionHostControlApi.includes('Promise.allSettled(plan.providerInterrupts.map((interrupt) => interrupt.invoke()))') &&
    executionHostControlApi.includes('const requestedTurns = new Set<string>()') &&
    executionHostControlApi.includes('options.codexManager.interruptTurn({') &&
    executionHostControlApi.includes('options.piCoordinator.interruptTurn({') &&
    !executionHostControlApi.includes('waitForTurnResult'),
  localInterruptionPersistsBeforeForcedQuit:
    executionHostControlApi.includes("status: 'interrupted'") &&
    executionHostControlApi.includes("options.submissions.updateStatus(submission.id, 'cancelled'") &&
    executionHostControlApi.includes('for (const request of plan.pendingRequests) options.requests.fail(') &&
    executionHostControlApi.includes('await options.save()') &&
    desktopMain.includes('await runtime.stopActiveWork();') &&
    desktopMain.includes("return 'force_quit';"),
  mainCreatesOnceAndRetriesSameIdentity:
    desktopExecutionHostStopCommand.includes('createExecutionHostStopActiveCommandRequest') &&
    desktopExecutionHostStopCommand.includes('payload: {') &&
    desktopExecutionHostStopCommand.includes("scope: { kind: 'execution_host', id: executionHostStopActiveScopeId }") &&
    detachedStopIdentityBlock.includes('const commandRequest = createExecutionHostStopActiveCommandRequest()') &&
    (detachedStopIdentityBlock.match(/client\.stopActiveWork\(commandRequest\)/gu)?.length ?? 0) === 2,
  detachedControlAndEmbeddedCorePreserveBody:
    desktopExecutionHostProtocol.includes('stopActiveWork: (input) =>') &&
    desktopExecutionHostProtocol.includes("request<ExecutionHostStopActiveCommandResponse>('/work/stop'") &&
    desktopExecutionHostProtocol.includes('body: JSON.stringify(input)') &&
    desktopExecutionHost.includes("if (request.method === 'POST' && request.url === '/work/stop')") &&
    desktopExecutionHost.includes('const body = await readJsonBody(request)') &&
    desktopExecutionHost.includes('services.stopActiveWork(body as ExecutionHostStopActiveCommandRequest)') &&
    desktopExecutionHost.includes('body: JSON.stringify(input)') &&
    desktopLocalServerRuntime.includes('const serializedBody = JSON.stringify(commandRequest)') &&
    desktopLocalServerRuntime.includes('body: serializedBody'),
  compositionInjectsSingleLedger:
    localServerComposition.includes('new ExecutionHostStopCommandApplication({ db, deliveries: commandDeliveries, redactSensitiveText') &&
    sourceBlock(localServerComposition, 'const executionHostControl = registerExecutionHostControlApi({', '\n  });').includes('stopCommands: executionHostStopCommands'),
  behaviorAndStructureVerifierInGate:
    zarchGate.includes("'execution-host-stop-command-behavior'") &&
    zarchGate.includes('scripts/verify-execution-host-stop-command-behavior.ts') &&
    zarchGate.includes("'execution-host-stop-command-slice'") &&
    zarchGate.includes("'--require-execution-host-stop-command-slice'") &&
    executionHostStopBehaviorVerifier.includes('byteIdentical: transportBodies[0] === transportBodies[1]') &&
    executionHostStopBehaviorVerifier.includes('replayCode: errorCode(unknownReplay)') &&
    executionHostStopBehaviorVerifier.includes("updatedSubmissions.every((entry) => entry.status === 'cancelled')"),
};
const executionHostStopCommandSliceReady = Object.values(executionHostStopCommandMarkers).every(Boolean);
const providerRuntimeRecoveryMarkers = {
  routeAcceptsEnvelope: providerRuntimeRecoveryRoute.includes('ports.recovery.execute(request.body)'),
  serviceParsesEnvelope: providerRuntimeRecoveryService.includes('parseCommandEnvelope<'),
  servicePreparesOutbox: providerRuntimeRecoveryService.includes('commandDeliveries.acceptAndPrepare('),
  serviceMarksWrite: providerRuntimeRecoveryService.includes('commandDeliveries.markProviderWriteStarted('),
  serviceRecordsAccepted: providerRuntimeRecoveryService.includes("outcome: 'accepted'"),
  serviceRecordsUnknown: providerRuntimeRecoveryService.includes("outcome: explicitlyRejected ? 'explicitly_rejected' : 'outcome_unknown_after_write'"),
  serviceRecordsExplicitRejection: providerRuntimeRecoveryService.includes("'explicitly_rejected'"),
  serviceBlocksConcurrentRecovery: providerRuntimeRecoveryService.includes('private active: ActiveRecovery | null = null'),
  compositionInjectsLedger: localServerComposition.includes('new ProviderRuntimeRecoveryApplicationService({') && localServerComposition.includes('commandDeliveries,'),
  compositionInjectsRoute: localServerComposition.includes('recovery: providerRuntimeRecovery'),
};
const providerRuntimeRecoverySliceReady = Object.values(providerRuntimeRecoveryMarkers).every(Boolean);
const piStartConversationBlock = sourceBlock(piCoordinator, 'async function startConversation(', '\n  async function submitMessage(');
const piSubmitMessageBlock = sourceBlock(piCoordinator, 'async function submitMessage(', '\n  async function queueHeldMessage(');
const piSteerMessageBlock = sourceBlock(piCoordinator, 'async function steerMessage(', '\n  async function handleRuntimeEvent(');
const piInterruptBlock = sourceBlock(piCoordinator, 'async interruptTurn(', '\n    async respondToRequest(');
const piCoordinatorCompositionBlock = sourceBlock(localServerComposition, 'const piNativeCoordinator =', '\n  const repairedPiConversationIdentityCount');
const piSessionAcceptedHelper = sourceBlock(piProviderCommandService, 'recordSessionAcceptedAtomically(', '\n\n  recordTurnAccepted(');
const piTurnAcceptedHelper = sourceBlock(piProviderCommandService, 'recordTurnAcceptedAtomically(', '\n\n  recordFailure(');
const piProviderCommandMarkers = {
  applicationServiceOwnsRepository: piProviderCommandService.includes('class PiProviderCommandApplicationService') && piProviderCommandService.includes('commandDeliveries.acceptAndPrepare('),
  sessionAndTurnDestinationsSeparated: piProviderCommandService.includes("? 'provider_session' : 'provider_turn'"),
  durableWriteMarker: piProviderCommandService.includes('markProviderWriteStarted({'),
  fourOutcomeReceipts:
    piProviderCommandService.includes("'accepted'") &&
    piProviderCommandService.includes("'explicitly_rejected'") &&
    piProviderCommandService.includes("'outcome_unknown_after_write'") &&
    piProviderCommandService.includes("'failed_before_write'"),
  sessionReceiptKeepsSessionOnly: piProviderCommandService.includes('nativeSessionId: input.nativeSessionId') && piProviderCommandService.includes('nativeTurnId: null'),
  turnReceiptKeepsSessionAndRun: piProviderCommandService.includes('nativeTurnId: input.nativeTurnId'),
  stableProviderChildIdentity:
    piProviderCommandService.includes('stableCommandId(input.operation, input.scope.kind, input.scope.id, input.commandKey)') &&
    piProviderCommandService.includes('stableIdempotencyKey(input.operation, input.idempotencyKey)') &&
    piStartConversationBlock.includes("scope: { kind: 'product_conversation', id: input.conversationId }") &&
    piStartConversationBlock.includes("scope: { kind: 'submission', id: input.submissionId }") &&
    piSubmitMessageBlock.includes("scope: { kind: 'submission', id: submission.id }"),
  boundedRedactedErrors:
    piProviderCommandService.includes('boundedErrorMessage(error.message, redactSensitiveText)') &&
    piProviderCommandService.includes('boundedUtf8(redactSensitiveText(value).text, 2 * 1024)') &&
    piCoordinatorCompositionBlock.includes('redactSensitiveText,'),
  acceptedBusinessProjectionAtomic:
    piSessionAcceptedHelper.includes('boundary.durableTransactionSync(() => {') &&
    piSessionAcceptedHelper.includes('boundary.projectNativeSession()') &&
    piSessionAcceptedHelper.includes('this.commandDeliveries.recordOutcomeInCurrentTransaction({') &&
    piSessionAcceptedHelper.lastIndexOf('this.settled = true;') > piSessionAcceptedHelper.indexOf('boundary.durableTransactionSync(() => {') &&
    piTurnAcceptedHelper.includes('boundary.durableTransactionSync(() => {') &&
    piTurnAcceptedHelper.includes('boundary.projectTurn()') &&
    piTurnAcceptedHelper.includes('this.commandDeliveries.recordOutcomeInCurrentTransaction({') &&
    piTurnAcceptedHelper.lastIndexOf('this.settled = true;') > piTurnAcceptedHelper.indexOf('boundary.durableTransactionSync(() => {') &&
    piStartConversationBlock.includes('sessionCommand.recordSessionAcceptedAtomically(') &&
    piStartConversationBlock.includes('durableTransactionSync: (operation) => {') &&
    piStartConversationBlock.includes('options.db.durableTransactionSync(operation);') &&
    piStartConversationBlock.includes('projectNativeSession: () => {') &&
    piStartConversationBlock.includes('input.segmentLifecycle.nativeSessionReady({') &&
    piStartConversationBlock.includes('input.segmentLifecycle.acceptSynchronously({') &&
    piStartConversationBlock.includes('runCommand!.recordTurnAcceptedAtomically(') &&
    piStartConversationBlock.includes('durableTransactionSync: (operation) => options.db.durableTransactionSync(operation)') &&
    piStartConversationBlock.includes('projectTurn: () => {') &&
    piSubmitMessageBlock.includes('input.segmentLifecycle.acceptSynchronously({') &&
    piSubmitMessageBlock.includes('runCommand!.recordTurnAcceptedAtomically(') &&
    piSubmitMessageBlock.includes('durableTransactionSync: (operation) => options.db.durableTransactionSync(operation)') &&
    piSubmitMessageBlock.includes('projectTurn: () => {') &&
    piSteerMessageBlock.includes('durableTransactionSync: (operation) => options.db.durableTransactionSync(operation)') &&
    piSteerMessageBlock.includes('projectTurn: () => {') &&
    piInterruptBlock.includes('durableTransactionSync: (operation) => options.db.durableTransactionSync(operation)') &&
    piInterruptBlock.includes('projectTurn: () => {'),
  behaviorVerifierInGate:
    zarchGate.includes("'pi-provider-command-delivery'") &&
    zarchGate.includes('scripts/verify-pi-provider-command-delivery.ts') &&
    piProviderCommandBehaviorVerifier.includes("sessionRollbackCode === 'ZEUS_PI_SESSION_PROJECTION_ROLLBACK'") &&
    piProviderCommandBehaviorVerifier.includes("sessionRollbackReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED'") &&
    piProviderCommandBehaviorVerifier.includes("rollbackCode === 'ZEUS_PI_ATOMIC_PROJECTION_ROLLBACK'") &&
    piProviderCommandBehaviorVerifier.includes("unknownReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED'") &&
    piProviderCommandBehaviorVerifier.includes("Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8') <= 2 * 1024"),
  startConversationCoversSessionAndRun:
    piStartConversationBlock.includes("operation: 'session_open'") &&
    piStartConversationBlock.includes('sessionCommand.markProviderWriteStarted()') &&
    piStartConversationBlock.includes('sessionCommand.recordSessionAcceptedAtomically(') &&
    piStartConversationBlock.includes("operation: 'run_start'") &&
    piStartConversationBlock.includes('input.segmentLifecycle?.bindCommandDelivery(') &&
    piStartConversationBlock.includes('driver.startRun('),
  submitMessageCoversRun: piSubmitMessageBlock.includes("operation: 'run_start'") && piSubmitMessageBlock.includes('input.segmentLifecycle?.bindCommandDelivery(') && piSubmitMessageBlock.includes('driver.startRun('),
  steerCoversOwnAttempt:
    piSteerMessageBlock.includes("operation: 'run_steer'") &&
    piSteerMessageBlock.includes('command.markProviderWriteStarted()') &&
    piSteerMessageBlock.includes('driver.steerRun(') &&
    piSteerMessageBlock.includes('command.recordTurnAcceptedAtomically('),
  interruptCoversOwnAttempt:
    piInterruptBlock.includes("operation: 'run_interrupt'") &&
    piInterruptBlock.includes('command.markProviderWriteStarted()') &&
    piInterruptBlock.includes('driver.interruptRun(') &&
    piInterruptBlock.includes('command.recordTurnAcceptedAtomically('),
  compositionInjectsLedger:
    piCoordinator.includes('commandDeliveries: CommandDeliveryRepository;') && piCoordinatorCompositionBlock.includes('createPiNativeConversationCoordinator({') && piCoordinatorCompositionBlock.includes('commandDeliveries,'),
};
const piProviderCommandSliceReady = Object.values(piProviderCommandMarkers).every(Boolean);
const codexSessionHelper = sourceBlock(codexCoordinator, 'function executeSessionCommand<', '\n  function executeTurnCommand<');
const codexTurnHelper = sourceBlock(codexCoordinator, 'function executeTurnCommand<', '\n  function hasPendingPlanImplementationRequest(');
const codexGoalExecuteHelper = sourceBlock(codexGoalApplication, 'const execute = <T>', '\n\n  async function setGoal(');
const codexProviderCommandMarkers = {
  applicationServiceOwnsRepository: codexProviderCommandService.includes('class CodexProviderCommandApplicationService') && codexProviderCommandService.includes('this.commandDeliveries.acceptAndPrepare({'),
  sessionAndTurnDestinationsSeparated:
    codexProviderCommandService.includes("destinationKind: 'provider_session' | 'provider_turn'") && codexProviderCommandService.includes("destinationKind === 'provider_session' ? 'codex:session' : 'codex:turn'"),
  durableWriteMarker: codexProviderCommandService.includes('this.commandDeliveries.markProviderWriteStarted({'),
  fourOutcomeReceipts:
    codexProviderCommandService.includes("outcome: 'accepted'") &&
    codexProviderCommandService.includes("'explicitly_rejected'") &&
    codexProviderCommandService.includes("'outcome_unknown_after_write'") &&
    codexProviderCommandService.includes("'failed_before_write'"),
  sessionReceiptKeepsSessionOnly: codexProviderCommandService.includes('nativeSessionId,') && codexProviderCommandService.includes('nativeTurnId: null'),
  turnReceiptKeepsSessionAndTurn: codexProviderCommandService.includes("requiredIdentity(input.nativeTurnId(result), 'nativeTurnId')") && codexProviderCommandService.includes('nativeTurnId,'),
  acceptedGenerationCanFollowNewThread: codexProviderCommandService.includes('acceptedProviderGenerationId?(result: T)') && codexProviderCommandService.includes('input.acceptedProviderGenerationId?.(result) ?? input.providerGenerationId'),
  coordinatorHelpersDelegate:
    codexSessionHelper.includes('providerCommands.executeSession({') &&
    codexTurnHelper.includes('providerCommands.executeTurn({') &&
    codexTurnHelper.includes("scope: { kind: 'turn'") &&
    codexTurnHelper.includes('nativeSessionId: input.threadId') &&
    codexTurnHelper.includes('nativeTurnId: () => input.turnId'),
  goalBoundaryDelegates: codexGoalExecuteHelper.includes('options.providerCommands.executeSession({') && codexGoalExecuteHelper.includes("scope: { kind: 'product_conversation'"),
  dynamicToolBoundaryDelegates:
    codexDynamicToolApplication.includes('options.providerCommands.executeTurn({') &&
    codexDynamicToolApplication.includes("operation: 'server_request_response'") &&
    codexDynamicToolApplication.includes('nativeSessionId: threadId') &&
    codexDynamicToolApplication.includes('nativeTurnId: () => turnId'),
  compactionBoundaryDelegates:
    codexPortableContextCompaction.includes('input.providerCommands.executeSession({') &&
    /input\.providerCommands\s*\.executeTurn\(\{/u.test(codexPortableContextCompaction) &&
    codexPortableContextCompaction.includes("operation: 'thread_archive'"),
  compactionUsesOwningGeneration:
    codexPortableContextCompaction.includes('acceptedProviderGenerationId: (result) => input.manager.generationForThread(result.id)') &&
    codexPortableContextCompaction.includes('const threadGenerationId = input.manager.generationForThread(thread.id) ?? input.providerGenerationId') &&
    codexPortableContextCompaction.match(/providerGenerationId: threadGenerationId/gu)?.length === 2,
  finalShutdownUsesAtomicRecoveryState:
    codexFinalShutdownApplication.includes('options.db.durableTransactionSync(() => {') &&
    codexFinalShutdownApplication.includes('options.requests.fail(request.id') &&
    codexFinalShutdownApplication.includes("status: 'failed'") &&
    codexFinalShutdownApplication.includes("pausedReason: 'recovery_required'") &&
    codexFinalShutdownApplication.includes("providerState: 'paused'") &&
    codexFinalShutdownApplication.includes('providerOutcomeUnconfirmed: true'),
  coordinatorFinalShutdownDelegates:
    codexCoordinator.includes('finalizeCodexPendingInteractionsForShutdown(') &&
    codexCoordinator.includes("input.mode === 'handoff'") &&
    codexCoordinator.indexOf('finalizeCodexPendingInteractionsForShutdown(') > codexCoordinator.indexOf("input.mode === 'handoff'"),
  behaviorVerifierInGate: zarchGate.includes("'codex-provider-command-delivery'") && zarchGate.includes('scripts/verify-codex-provider-command-delivery.ts'),
};
const codexProviderCommandSliceReady = Object.values(codexProviderCommandMarkers).every(Boolean);
const codexPairingStatusRoute = sourceBlock(codexPublicCommandRoutes, "server.post('/api/codex/remote-control/pairing/status'", '\n\n  server.');
const codexPairingStatusManagerMethod = sourceBlock(codexAppServerManager, 'async readRemoteControlPairingStatus(input) {', '\n    async listRemoteControlClients');
const codexPublicCommandMarkers = {
  publicEnvelopeHasTrueCodexScopes:
    ['provider_account', 'provider_remote_control', 'provider_configuration', 'provider_import'].every((scope) => sharedCommandEnvelope.includes(`'${scope}'`)) &&
    codexPublicCommandApplication.includes("Extract<CommandScopeKind, 'provider_account' | 'provider_remote_control' | 'provider_configuration' | 'provider_import'>"),
  bodySeparatesCommandAndInput: codexPublicCommandApplication.includes("assertExactKeys(request, ['command', 'input']") && codexPublicCommandApplication.includes('inputSha256 does not match Body.input'),
  payloadContainsOnlyStableIdentityAndHash:
    codexPublicCommandApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") &&
    codexPublicCommandApplication.includes('type CodexPublicCommandPayload = { operationIdentity: string; inputSha256: string }'),
  externalOperationProtocol:
    codexPublicCommandApplication.includes("destinationKind: 'external_operation'") &&
    codexPublicCommandApplication.includes('markExternalWriteStarted({') &&
    codexPublicCommandApplication.includes("outcome: 'accepted'") &&
    codexPublicCommandApplication.includes("'outcome_unknown_after_write'") &&
    codexPublicCommandApplication.includes("'failed_before_write'") &&
    codexPublicCommandApplication.includes("'explicitly_rejected'"),
  exactExplicitRejectionEvidence: codexPublicCommandApplication.includes("dispatchDisposition === 'runtime_rejected'") && codexAppServerManager.includes("dispatchDisposition: 'runtime_rejected' as const"),
  immutableArtifactReplay:
    codexPublicCommandApplication.includes('artifacts.putJson({') &&
    codexPublicCommandApplication.includes('resultArtifact: {') &&
    codexPublicCommandApplication.includes('artifacts.readAuthorized({') &&
    codexPublicCommandApplication.includes('maximumContentBytes: maximumReplayResultBytes'),
  concurrentDuplicateCollapsed: codexPublicCommandApplication.includes('private readonly activeExecutions = new Map<') && codexPublicCommandApplication.includes('const active = this.activeExecutions.get(activeKey)'),
  compositionInjectsSingleLedger:
    localServerComposition.includes('new CodexPublicCommandApplicationService({') &&
    sourceBlock(localServerComposition, 'new CodexPublicCommandApplicationService({', '\n  });').includes('deliveries: commandDeliveries') &&
    localServerComposition.includes('registerCodexPublicCommandRoutes({') &&
    localServerComposition.includes('application: codexPublicCommands'),
  rendererBuildsEnvelopeOnce:
    codexPublicRendererClient.includes('buildCodexPublicCommandRequest') &&
    codexPublicRendererClient.includes('payload: { operationIdentity, inputSha256 }') &&
    codexPublicRendererClient.includes('Local transport 的两个网络 attempt 复用此处一次生成的 Body') &&
    (desktopApiClient.match(/buildCodexPublicCommandRequest\(\{/gu)?.length ?? 0) >= 5 &&
    (remoteControlRendererClient.match(/buildCodexPublicCommandRequest\(\{/gu)?.length ?? 0) >= 4,
  behaviorVerifierInGate: zarchGate.includes("'codex-public-command-behavior'") && zarchGate.includes('scripts/verify-codex-public-command-behavior.ts'),
};
const codexPublicCommandSliceReady = Object.values(codexPublicCommandMarkers).every(Boolean);
const codexPairingStatusReadOnlyMarkers = {
  declarationNamesApplicationMethod:
    codexPublicCommandRoutes.includes("applicationMethod: 'readRemoteControlPairingStatus'") &&
    codexPublicCommandRoutes.includes("classification: 'read_only'") &&
    codexPublicCommandRoutes.includes('writesBusinessState: false') &&
    codexPublicCommandRoutes.includes("commandLedger: 'not_applicable'"),
  routeInvokesDeclaredReadPort: codexPairingStatusRoute.includes('options.remoteControl.readPairingStatus(') && !codexPairingStatusRoute.includes('application.executeExternal('),
  compositionMapsExactManagerRead: localServerComposition.includes('readPairingStatus: (input) => codexAppServerManager.readRemoteControlPairingStatus(input)'),
  managerImplementationIsReadRpc:
    codexPairingStatusManagerMethod.includes("rpc(capabilities.generationId, 'remoteControl/pairing/status'") &&
    !['remoteControlEnabled =', 'enableRemoteControl(', 'disableRemoteControl(', 'startRemoteControlPairing(', 'revokeRemoteControlClient('].some((marker) => codexPairingStatusManagerMethod.includes(marker)),
};
const codexPairingStatusReadOnly = Object.values(codexPairingStatusReadOnlyMarkers).every(Boolean);
const memoryCandidateMethod = sourceBlock(memoryContextApi, 'recordMemory(value: unknown)', '\n  supersedeMemory(');
const memorySupersedeMethod = sourceBlock(memoryContextApi, 'supersedeMemory(previousId: string, value: unknown)', '\n  tombstoneMemory(');
const memoryTombstoneMethod = sourceBlock(memoryContextApi, 'tombstoneMemory(id: string, value: unknown)', '\n  async previewContext(');
const memoryPreviewMethod = sourceBlock(memoryContextApi, 'async previewContext(', '\n  private executeMemoryMutation');
const memoryMutationExecutor = sourceBlock(memoryContextApi, 'private executeMemoryMutation<', '\n}\n\nexport class MemoryContextApiError');
const memoryCandidateRoute = sourceBlock(memoryContextApi, "server.post('/api/memory/candidates'", '\n\n  server.');
const memorySupersedeRoute = sourceBlock(memoryContextApi, "server.post('/api/memory/:id/supersede'", '\n\n  server.');
const memoryTombstoneRoute = sourceBlock(memoryContextApi, "server.delete('/api/memory/:id'", '\n\n  server.');
const memoryPreviewRoute = sourceBlock(memoryContextApi, "server.post('/api/projects/:projectId/tasks/:taskId/context/preview'", '\n}\n');
const memoryCommandMarkers = {
  publicEnvelopeHasMemoryScope: /commandScopeKinds\s*=\s*\[[\s\S]*?'memory'[\s\S]*?\]\s*as const/u.test(sharedCommandEnvelope) && memoryContextApi.includes("command.scope.kind !== 'memory'"),
  bodySeparatesCommandAndInput: memoryContextApi.includes("assertExactInputKeys(body, ['command', 'input']") && memoryContextApi.includes('inputSha256 does not match Body.input'),
  payloadContainsOnlyStableIdentityAndHash:
    memoryContextApi.includes("assertExactInputKeys(command.payload, ['inputSha256', 'operationIdentity']") && memoryContextApi.includes('type MemoryMutationCommandPayload = { operationIdentity: string; inputSha256: string }'),
  coreApplicationTransaction:
    memoryMutationExecutor.includes('commandDeliveries.executeCoreApplication({') && memoryMutationExecutor.includes('mutateBusinessState: () => {') && memoryMutationExecutor.includes('delivery.receipt.operationIdentity'),
  replayLoadsImmutableResult: memoryMutationExecutor.includes('delivery.created ? mutatedRecord : this.options.memory.getById(resultRecordId)') && memoryMutationExecutor.includes('replayed: !delivery.created'),
  publicResponseReturnsOperationResult: memoryCandidateRoute.includes('reply.code(201).send(result)') && !memorySupersedeRoute.includes(').record') && !memoryTombstoneRoute.includes(').record'),
  compositionInjectsLedger:
    sourceBlock(localServerComposition, 'new MemoryContextApplicationService({', '\n    }),').includes('commandDeliveries,') && !sourceBlock(localServerComposition, 'new MemoryContextApplicationService({', '\n    }),').includes('commit:'),
  candidateRouteConsumesCommandBody: memoryCandidateRoute.includes('Body: MemoryMutationRequest<NewMemoryCandidate>') && memoryCandidateRoute.includes('service.recordMemory(request.body)'),
  candidateUsesStableCommandType: memoryCandidateMethod.includes('this.executeMemoryMutation<NewMemoryCandidate>') && memoryCandidateMethod.includes('memoryCommandTypes.candidateRecord'),
  supersedeRouteConsumesCommandBody: memorySupersedeRoute.includes('Body: MemoryMutationRequest<SupersedingMemoryCandidate>') && memorySupersedeRoute.includes('service.supersedeMemory(request.params.id, request.body)'),
  supersedeUsesStableCommandType: memorySupersedeMethod.includes('this.executeMemoryMutation<SupersedingMemoryCandidate>') && memorySupersedeMethod.includes('memoryCommandTypes.recordSupersede'),
  tombstoneRouteConsumesCommandBody: memoryTombstoneRoute.includes('Body: MemoryMutationRequest<{ reason?: unknown }>') && memoryTombstoneRoute.includes('service.tombstoneMemory(request.params.id, request.body)'),
  tombstoneUsesStableCommandType: memoryTombstoneMethod.includes('this.executeMemoryMutation<{ reason?: unknown }>') && memoryTombstoneMethod.includes('memoryCommandTypes.recordTombstone'),
};
const memoryBaseCommandSliceReady = [
  memoryCommandMarkers.publicEnvelopeHasMemoryScope,
  memoryCommandMarkers.bodySeparatesCommandAndInput,
  memoryCommandMarkers.payloadContainsOnlyStableIdentityAndHash,
  memoryCommandMarkers.coreApplicationTransaction,
  memoryCommandMarkers.replayLoadsImmutableResult,
  memoryCommandMarkers.publicResponseReturnsOperationResult,
  memoryCommandMarkers.compositionInjectsLedger,
].every(Boolean);
const memoryCommandRouteStatus = new Map([
  ['POST /api/memory/candidates', memoryBaseCommandSliceReady && memoryCommandMarkers.candidateRouteConsumesCommandBody && memoryCommandMarkers.candidateUsesStableCommandType ? 'integrated' : 'pending'],
  ['POST /api/memory/:id/supersede', memoryBaseCommandSliceReady && memoryCommandMarkers.supersedeRouteConsumesCommandBody && memoryCommandMarkers.supersedeUsesStableCommandType ? 'integrated' : 'pending'],
  ['DELETE /api/memory/:id', memoryBaseCommandSliceReady && memoryCommandMarkers.tombstoneRouteConsumesCommandBody && memoryCommandMarkers.tombstoneUsesStableCommandType ? 'integrated' : 'pending'],
]);
const memoryPreviewReadOnlyMarkers = {
  declarationNamesApplicationMethod:
    memoryContextApi.includes("applicationMethod: 'previewContext'") &&
    memoryContextApi.includes("classification: 'read_only'") &&
    memoryContextApi.includes('writesBusinessState: false') &&
    memoryContextApi.includes("commandLedger: 'not_applicable'"),
  routeInvokesDeclaredMethod: memoryPreviewRoute.includes('service.previewContext({'),
  implementationHasNoWriteBoundary: !['recordCandidate(', '.supersede(', '.tombstone(', 'executeCoreApplication(', 'commandDeliveries.'].some((marker) => memoryPreviewMethod.includes(marker)),
};
const memoryPreviewReadOnly = Object.values(memoryPreviewReadOnlyMarkers).every(Boolean);
const commandCenterCommandMarkers = {
  publicEnvelopeHasCommandScopes:
    /commandScopeKinds\s*=\s*\[[\s\S]*?'command_definition'[\s\S]*?'command_run'[\s\S]*?\]\s*as const/u.test(sharedCommandEnvelope) && commandCenterApplication.includes("Extract<CommandScopeKind, 'command_definition' | 'command_run'>"),
  bodySeparatesCommandAndInput: commandCenterApplication.includes("assertExactKeys(request, ['command', 'input']") && commandCenterApplication.includes('inputSha256 does not match Body.input'),
  payloadContainsOnlyStableIdentityAndHash:
    commandCenterApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") && commandCenterApplication.includes('type CommandCenterCommandPayload = { operationIdentity: string; inputSha256: string }'),
  coreApplicationTransaction:
    commandCenterApplication.includes('this.options.deliveries.executeCoreApplication({') &&
    commandCenterApplication.includes('mutateBusinessState: () => {') &&
    commandCenterApplication.includes('readCommandCenterResult<TResult>(delivery.receipt)'),
  externalOperationProtocol:
    commandCenterApplication.includes("destinationKind: 'external_operation'") &&
    commandCenterApplication.includes('markExternalWriteStarted(') &&
    commandCenterApplication.includes('recordOutcomeInCurrentTransaction({') &&
    commandCenterApplication.includes('this.options.db.durableTransactionSync(() => {'),
  immutableReplayResult: commandCenterApplication.includes("state: 'accepted_replay'") && commandCenterApplication.includes('readCommandCenterResult<TResult>(accepted.receipt)'),
  compositionInjectsSingleLedger: commandCenter.includes('deliveries: options.commandDeliveries') && sourceBlock(localServerComposition, 'const commandCenter = createCommandCenter({', '\n  });').includes('commandDeliveries,'),
  rendererBuildsEnvelopeOnce:
    commandCenterRendererClient.includes('buildCommandCenterCommandRequest') &&
    commandCenterRendererClient.includes('payload: { operationIdentity, inputSha256 }') &&
    commandCenterRendererClient.includes('Local transport 重连只能复用该序列化 Body'),
  behaviorVerifierInGate: zarchGate.includes("'command-center-command-behavior'") && zarchGate.includes('scripts/verify-command-center-command-behavior.ts'),
};
const commandCenterCommandSliceReady = Object.values(commandCenterCommandMarkers).every(Boolean);
const workManagementCommandMarkers = {
  publicEnvelopeUsesTrueScopes: /commandScopeKinds\s*=\s*\[[\s\S]*?'project'[\s\S]*?'task'[\s\S]*?\]\s*as const/u.test(sharedCommandEnvelope) && workManagementApplication.includes("Extract<CommandScopeKind, 'project' | 'task'>"),
  bodySeparatesCommandAndInput: workManagementApplication.includes("assertExactKeys(request, ['command', 'input']") && workManagementApplication.includes('inputSha256 does not match Body.input'),
  payloadContainsOnlyStableIdentityAndHash:
    workManagementApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") && workManagementApplication.includes('type WorkManagementCommandPayload = { operationIdentity: string; inputSha256: string }'),
  coreApplicationTransaction:
    workManagementApplication.includes('this.options.deliveries.executeCoreApplication({') &&
    workManagementApplication.includes('mutateBusinessState: () => {') &&
    workManagementApplication.includes('readWorkManagementResult<TResult>(delivery.receipt'),
  immutableCoreReplay: workManagementApplication.includes('replayAcceptedCore<') && workManagementApplication.includes('Accepted work-management Core command replay must never execute its mutation.'),
  externalOperationProtocol:
    workManagementApplication.includes("destinationKind: 'external_operation'") &&
    workManagementApplication.includes('markExternalWriteStarted({') &&
    workManagementApplication.includes("'failed_before_write'") &&
    workManagementApplication.includes("'explicitly_rejected'") &&
    workManagementApplication.includes("'outcome_unknown_after_write'") &&
    workManagementApplication.includes("outcome: 'accepted'"),
  compositionInjectsSingleLedger:
    localServerComposition.includes('new WorkManagementCommandApplication({') && sourceBlock(localServerComposition, 'new WorkManagementCommandApplication({', '\n  const idempotencyRequests').includes('deliveries: commandDeliveries'),
  rendererBuildsEnvelopeOnce:
    workManagementRendererClient.includes('buildWorkManagementCommandRequest') &&
    workManagementRendererClient.includes('payload: { operationIdentity, inputSha256 }') &&
    workManagementRendererClient.includes('Local transport 重连复用此处一次生成的 Body') &&
    (projectRendererClient.match(/buildWorkManagementCommandRequest\(\{/gu)?.length ?? 0) >= 7 &&
    (taskRendererClient.match(/buildWorkManagementCommandRequest\(\{/gu)?.length ?? 0) >= 8,
  behaviorVerifierInGate: zarchGate.includes("'work-management-command-behavior'") && zarchGate.includes('scripts/verify-work-management-command-behavior.ts'),
};
const workManagementCommandSliceReady = Object.values(workManagementCommandMarkers).every(Boolean);
const taskEventRecordBlock = sourceBlock(localServerComposition, 'function recordTaskEvent(', '\n\n  let telegramPollingService');
const taskEventFileProjectionReady =
  taskEventRecordBlock.includes('const event = taskEvents.create(input)') &&
  taskEventRecordBlock.includes('taskEventFileProjectionOutbox.enqueue(event.taskId, event.id, event.createdAt)') &&
  taskEventRecordBlock.includes('db.afterCommit(() => taskEventFileProjection.schedule(event.taskId))') &&
  taskEventFileProjectionService.includes('task_events 是唯一事实') &&
  taskEventFileProjectionService.includes('this.options.outbox.markAccepted(') &&
  taskEventFileProjectionService.includes("pending.state === 'pending'") &&
  taskEventFileProjectionService.includes('await assertSafeOpenedProjectionFile(handle, path)') &&
  taskEventFileProjectionService.includes('metadata.nlink !== 1') &&
  taskEventFileProjectionService.includes('cleanupStaleProjectionTemporaryFiles(paths.directory)') &&
  taskEventFileProjectionService.includes('if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0') &&
  taskEventFileProjectionService.includes('singleLineProjectionField(event.taskId, 512)') &&
  !taskEventFileProjectionService.includes('appendFileSync(') &&
  zarchGate.includes("'work-management-command-behavior'");
const workManagementCoreRouteOperations = new Set([
  'PATCH /api/projects/:projectId/task-board',
  'POST /api/tasks/:taskId/retry',
  'POST /api/tasks',
  'POST /api/task-templates',
  'POST /api/task-templates/:templateId/tasks',
  'POST /api/projects/:projectId/conversations/:conversationId/tasks',
  'POST /api/graph/nodes/:nodeId/tasks',
  'POST /api/projects/:projectId/graph/nodes/:nodeId/create-task',
  'POST /api/projects/:projectId/graph/views/:viewId/create-task',
  'POST /api/tasks/:taskId/link-graph-node',
]);
const workManagementCoreRouteMarkers = {
  genericRouteConsumesEnvelope:
    workManagementCoreRoutes.includes('Body: WorkManagementMutationRequest<') &&
    workManagementCoreRoutes.includes('input.application.parse<TInput>({') &&
    workManagementCoreRoutes.includes('input.application.replayAcceptedCore<TInput, unknown>({') &&
    workManagementCoreRoutes.includes('input.application.executeCore({'),
  allTenCommandTypes:
    ['taskBoardUpdate', 'taskRetry', 'taskCreate', 'taskTemplateCreate', 'taskFromTemplateCreate', 'taskFromGraphConversationCreate', 'taskFromGraphNodeCreate', 'taskFromGraphViewCreate', 'taskGraphNodeLink'].every((commandType) =>
      workManagementCoreRoutes.includes(`workManagementCommandTypes.${commandType}`),
    ) && (workManagementCoreRoutes.match(/options\.server\.(?:post|patch)\(/gu)?.length ?? 0) === 10,
  operationsWriteOnlyCoreFacts:
    workManagementCoreOperations.includes('class WorkManagementCoreOperations') &&
    workManagementCoreOperations.includes('this.ports.recordTaskEvent(') &&
    workManagementCoreOperations.includes('this.ports.afterCommit(') &&
    !['projectionDatabases.', 'notifyTelegram', 'appendFile', 'executeProjectGitAction', 'startRuntime'].some((marker) => workManagementCoreOperations.includes(marker)),
  compositionRegistersExtractedRoutes:
    localServerComposition.includes('new WorkManagementCoreOperations({') &&
    localServerComposition.includes('registerWorkManagementCoreCommandRoutes({') &&
    sourceBlock(localServerComposition, 'registerWorkManagementCoreCommandRoutes({', '\n  });').includes('application: workManagementCommands'),
  rendererUsesStableImmutableEnvelope:
    ['taskBoardUpdate', 'taskRetry'].every((commandType) => taskRendererClient.includes(`workManagementClientCommandTypes.${commandType}`)) &&
    ['taskTemplateCreate', 'taskFromTemplateCreate', 'taskFromGraphConversationCreate', 'taskFromGraphNodeCreate', 'taskFromGraphViewCreate', 'taskGraphNodeLink'].every((commandType) =>
      desktopApiClient.includes(`workManagementClientCommandTypes.${commandType}`),
    ),
  taskEventProjectionDurable: taskEventFileProjectionReady,
};
const workManagementCoreRoutesReady = workManagementCommandSliceReady && Object.values(workManagementCoreRouteMarkers).every(Boolean);
const workManagementProjectRouteOperations = new Set([
  'POST /api/projects',
  'PATCH /api/projects/:projectId',
  'PUT /api/projects/:projectId/workspace-config',
  'DELETE /api/projects/:projectId',
  'POST /api/projects/:projectId/archive',
  'POST /api/projects/:projectId/restore',
  'PUT /api/projects/:projectId/default-template',
]);
const workManagementProjectRoutesReady =
  workManagementCommandSliceReady &&
  workManagementProjectRoutes.includes('options.application.parse<') &&
  workManagementProjectRoutes.includes('options.application.replayAcceptedCore<') &&
  workManagementProjectRoutes.includes('options.application.executeCore({') &&
  workManagementProjectRoutes.includes('function registerProjectMutation(') &&
  workManagementProjectOperations.includes('class WorkManagementProjectOperations') &&
  workManagementProjectOperations.includes('this.ports.afterCommit(') &&
  !['projectionDatabases.', 'notifyTelegram', 'appendFile', 'executeProjectGitAction', 'startRuntime'].some((marker) => workManagementProjectOperations.includes(marker));
const workManagementTaskRouteOperations = new Set([
  'PATCH /api/tasks/:taskId/status',
  'PATCH /api/tasks/:taskId/management-status',
  'POST /api/projects/:projectId/task-board/moves',
  'POST /api/tasks/:taskId/run',
  'POST /api/tasks/:taskId/pause',
  'POST /api/tasks/:taskId/continue',
  'POST /api/tasks/:taskId/cancel',
]);
const workManagementTaskCommandTypes = ['taskStatusUpdate', 'taskManagementStatusUpdate', 'taskBoardMove', 'taskRun', 'taskPause', 'taskContinue', 'taskCancel'];
const workManagementTaskCommandMarkers = {
  sevenExactPublicRoutes:
    workManagementTaskRouteOperations.size === 7 &&
    [...workManagementTaskRouteOperations].every((operation) => workManagementTaskRoutes.includes(`'${operation.slice(operation.indexOf(' ') + 1)}'`)) &&
    (workManagementTaskRoutes.match(/options\.server\.(?:post|patch)\(/gu)?.length ?? 0) === 7,
  exactCommandTypesAndEnvelope:
    workManagementTaskCommandTypes.every((commandType) => workManagementTaskRoutes.includes(`workManagementCommandTypes.${commandType}`)) &&
    workManagementTaskRoutes.includes('Body: WorkManagementMutationRequest<') &&
    workManagementTaskRoutes.includes('options.application.parse<') &&
    workManagementTaskRoutes.includes('options.application.replayAccepted<'),
  statusCoreAndTelegramChildOutbox:
    workManagementTaskRoutes.includes('options.application.executeCore({') &&
    workManagementTaskRoutes.includes('enqueueTaskStatusTelegramEffectInCurrentTransaction({') &&
    workManagementApplication.includes('acceptAndPrepareInCurrentTransaction({') &&
    workManagementApplication.includes('dispatchTaskStatusTelegramEffect<TResult>') &&
    workManagementTaskEffects.includes('listPreparedTaskStatusTelegramEffects') &&
    workManagementTaskEffects.includes('outcome_unknown_after_write') &&
    !localServerComposition.includes('notifyTelegramTaskStatus('),
  conditionalCoreAndExternalBoundary:
    (workManagementTaskRoutes.match(/if \(!prepared\.requiresExternal\)/gu)?.length ?? 0) === 2 &&
    workManagementTaskRoutes.includes('options.application.executeExternal({') &&
    workManagementTaskRoutes.includes('externalOperationId: `task-management-status:') &&
    workManagementTaskRoutes.includes('externalOperationId: `task-board-move:') &&
    workManagementTaskRoutes.includes('externalOperationId: `task-runtime-${action}:') &&
    workManagementTaskRoutes.includes("externalOutcome === 'outcome_unknown_after_write'") &&
    workManagementTaskRoutes.includes('Automatic replay is blocked'),
  coreFactsAndProjectionBoundaries:
    workManagementTaskOperations.includes('this.options.recordTaskEvent({') &&
    workManagementTaskOperations.includes('this.options.afterCommit(() =>') &&
    workManagementTaskOperations.includes('this.options.scheduleGraphCompletion(updated)') &&
    workManagementTaskOperations.includes('this.options.tasks.updateStatus(') &&
    workManagementTaskOperations.includes('this.options.taskBoards.replaceLaneOrder({') &&
    !['projectionDatabases.', 'createTelegramBotMessageClient', 'appendFileSync(', 'server.inject('].some((marker) => workManagementTaskOperations.includes(marker)),
  stableExternalIdentityAndBoundedEvidence:
    localServerComposition.includes('idempotencyKey: operationIdentity ? `work-management-runtime:') &&
    workManagementApplication.includes('const maximumReplayResultBytes = 64 * 1024') &&
    workManagementApplication.includes('const maximumErrorMessageBytes = 2 * 1024') &&
    workManagementTaskEffects.includes('bytes.byteLength <= 2_048'),
  rendererCreatesImmutableEnvelopeOnce:
    workManagementTaskCommandTypes.every((commandType) => taskRendererClient.includes(`workManagementClientCommandTypes.${commandType}`)) &&
    ['moveTaskBoardTask', 'runTask', 'pauseTask', 'continueTask', 'cancelTask', 'updateTaskStatus', 'updateTaskManagementStatus'].every((method) => taskRendererClient.includes(`${method}: async`)),
  compositionAndBehaviorGate:
    localServerComposition.includes('new WorkManagementTaskOperations<') &&
    localServerComposition.includes('new WorkManagementTaskEffectService({') &&
    sourceBlock(localServerComposition, 'registerWorkManagementTaskCommandRoutes({', '\n  });').includes('application: workManagementCommands') &&
    zarchGate.includes("'work-management-task-command-slice'") &&
    zarchGate.includes("'--require-work-management-task-command-slice'") &&
    zarchGate.includes("'work-management-command-behavior'"),
  oldInlineHandlersRemoved: [...workManagementTaskRouteOperations].every((operation) => !localServerComposition.includes(`server.${operation.startsWith('PATCH ') ? 'patch' : 'post'}('${operation.slice(operation.indexOf(' ') + 1)}'`)),
};
const workManagementTaskCommandSliceReady = workManagementCommandSliceReady && Object.values(workManagementTaskCommandMarkers).every(Boolean);
const runtimeConfirmationCreateBlock = sourceBlock(runtimeSessionRoutes, "server.post('/api/runtime/confirmations'", "\n\n  server.post('/api/runtime/confirmations/:confirmationId/reject'");
const runtimeConfirmationRejectBlock = sourceBlock(runtimeSessionRoutes, "server.post('/api/runtime/confirmations/:confirmationId/reject'", "\n\n  server.post('/api/runtime/confirmations/:confirmationId/confirm'");
const runtimeConfirmationConfirmBlock = sourceBlock(runtimeSessionRoutes, "server.post('/api/runtime/confirmations/:confirmationId/confirm'", "\n\n  server.post('/api/runtime/sessions'");
const runtimeSessionStartBlock = sourceBlock(runtimeSessionRoutes, "server.post('/api/runtime/sessions'", "\n\n  server.post('/api/runtime/sessions/:sessionId/capabilities/ephemeral'");
const runtimeSessionCommandMarkers = {
  publicEnvelopeUsesRuntimeScopes: sharedCommandEnvelope.includes("'runtime_segment'") && sharedCommandEnvelope.includes("'approval'") && runtimeSessionApplication.includes("Extract<CommandScopeKind, 'approval' | 'runtime_segment'>"),
  bodySeparatesCommandAndInput: runtimeSessionApplication.includes("assertExactKeys(request, ['command', 'input']") && runtimeSessionApplication.includes('inputSha256 does not match Body.input'),
  payloadContainsOnlyStableIdentityAndHash:
    runtimeSessionApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") && runtimeSessionApplication.includes('type RuntimeSessionCommandPayload = { operationIdentity: string; inputSha256: string }'),
  coreApplicationTransaction: runtimeSessionApplication.includes('this.options.deliveries.executeCoreApplication({') && runtimeSessionApplication.includes('readRuntimeResult<TResult>(delivery.receipt'),
  externalOperationFourStates:
    runtimeSessionApplication.includes("destinationKind: 'external_operation'") &&
    runtimeSessionApplication.includes('markExternalWriteStarted({') &&
    ["'failed_before_write'", "'explicitly_rejected'", "'outcome_unknown_after_write'", "outcome: 'accepted'"].every((marker) => runtimeSessionApplication.includes(marker)),
  confirmationIsBoundedEphemeralCapability:
    runtimeSessionApplication.includes('class RuntimeBoundedEphemeralReplayService') &&
    runtimeSessionRoutes.includes('class RuntimeConfirmationCapabilityRegistry') &&
    runtimeSessionRoutes.includes('private readonly maximumEntries = 256') &&
    [runtimeConfirmationCreateBlock, runtimeConfirmationRejectBlock, runtimeConfirmationConfirmBlock].every((block) => block.includes('confirmationReplay.') && !block.includes('application.executeCore(')),
  inputResizeUseLeaseSequence:
    runtimeSessionApplication.includes('class RuntimeEphemeralCapabilityService') &&
    runtimeSessionApplication.includes('sequence !== lease.lastSequence + 1') &&
    runtimeSessionApplication.includes('maximumRecentResults ?? 64') &&
    runtimeSessionRoutes.includes('ephemeralCapabilities.execute<RuntimeInputValue') &&
    runtimeSessionRoutes.includes('ephemeralCapabilities.execute<RuntimeResizeValue'),
  confirmationConsumedBeforeWriteMarker:
    runtimeSessionStartBlock.includes('beforeWrite: async () => {') &&
    runtimeSessionStartBlock.includes('consumeRuntimeConfirmation(') &&
    runtimeSessionApplication.indexOf('await input.beforeWrite?.();') < runtimeSessionApplication.indexOf('markExternalWriteStarted({'),
  compositionInjectsSingleLedger:
    localServerComposition.includes('new RuntimeSessionCommandApplication({ db, deliveries: commandDeliveries') &&
    localServerComposition.includes('registerRuntimeSessionCommandRoutes({') &&
    sourceBlock(localServerComposition, 'registerRuntimeSessionCommandRoutes({', '\n  });').includes('application: runtimeSessionCommands'),
  rendererBuildsStableEnvelopeAndLease:
    runtimeSessionRendererClient.includes('payload: { operationIdentity, inputSha256 }') &&
    runtimeSessionRendererClient.includes('stableRuntimeRendererClientId()') &&
    runtimeSessionRendererClient.includes('class RuntimeEphemeralCapabilityClient') &&
    (desktopApiClient.match(/buildRuntimeSessionCommandRequest\(\{/gu)?.length ?? 0) >= 12 &&
    desktopApiClient.includes("runtimeEphemeral.send(sessionId, 'input'") &&
    desktopApiClient.includes("runtimeEphemeral.send(sessionId, 'resize'"),
  behaviorVerifierInGate: zarchGate.includes("'runtime-session-command-behavior'") && zarchGate.includes('scripts/verify-runtime-session-command-behavior.ts'),
};
const runtimeSessionCommandSliceReady = Object.values(runtimeSessionCommandMarkers).every(Boolean);
const conversationCommandMarkers = {
  publicEnvelopeUsesConversationScope: sharedCommandEnvelope.includes("'product_conversation'") && conversationCommandApplication.includes("command.scope.kind !== 'product_conversation'"),
  bodySeparatesCommandAndInput: conversationCommandApplication.includes("assertExactKeys(request, ['command', 'input']") && conversationCommandApplication.includes('inputSha256 does not match Body.input'),
  payloadContainsOnlyStableIdentityAndHash:
    conversationCommandApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") &&
    conversationCommandApplication.includes('type ConversationCommandPayload = { operationIdentity: string; inputSha256: string }'),
  exactElevenCommandTypes: [
    'conversation.next_turn_settings.update',
    'conversation.permission_mode.update',
    'conversation.collaboration_mode.update',
    'conversation.goal.set',
    'conversation.goal.pause',
    'conversation.goal.resume',
    'conversation.goal.clear',
    'conversation.attention.acknowledge',
    'conversation.provider_thread.restore',
    'conversation.archive',
    'conversation.restore',
  ].every((commandType) => conversationCommandApplication.includes(`'${commandType}'`)),
  coreApplicationTransaction:
    conversationCommandApplication.includes('this.options.deliveries.executeCoreApplication({') &&
    conversationCommandApplication.includes('mutateBusinessState: () => {') &&
    conversationCommandApplication.includes('assertBoundedReceiptEvidence(evidence);') &&
    conversationCommandApplication.includes('readConversationResult<TResult>(delivery.receipt'),
  externalOperationFourStates:
    conversationCommandApplication.includes("destinationKind: 'external_operation'") &&
    conversationCommandApplication.includes('markExternalWriteStarted({') &&
    ["'failed_before_write'", "'explicitly_rejected'", "'outcome_unknown_after_write'", "outcome: 'accepted'"].every((marker) => conversationCommandApplication.includes(marker)),
  unknownBlocksAutomaticReplay:
    conversationCommandApplication.includes("outcome === 'outcome_unknown_after_write'") &&
    conversationCommandApplication.includes('throw outcomeUnknown(error, this.options.redactSensitiveText)') &&
    conversationCommandApplication.includes("error.code !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED'") &&
    conversationCommandApplication.includes("'ZEUS_CONVERSATION_COMMAND_OUTCOME_UNKNOWN'"),
  boundedReceiptAndRedactedError:
    conversationCommandApplication.includes('const maximumReceiptEvidenceBytes = 64 * 1024') &&
    conversationCommandApplication.includes('const maximumErrorMessageBytes = 2 * 1024') &&
    conversationCommandApplication.includes('large results require an ArtifactRef') &&
    conversationCommandApplication.includes('redactSensitiveText(error.message).text') === false &&
    conversationCommandApplication.includes('boundedErrorMessage(error.message, redactSensitiveText)'),
  concurrentDuplicateCollapsed: conversationCommandApplication.includes('private readonly activeExternalExecutions = new Map<') && conversationCommandApplication.includes('const active = this.activeExternalExecutions.get(activeKey)'),
  compositionInjectsSingleLedger:
    localServerComposition.includes('new ConversationCommandApplication({') &&
    localServerComposition.includes('deliveries: commandDeliveries') &&
    localServerComposition.includes('redactSensitiveText') &&
    localServerComposition.includes('registerConversationCommandRoutes({') &&
    sourceBlock(localServerComposition, 'registerConversationCommandRoutes({', '\n  });').includes('application: conversationCommands'),
  rendererBuildsEnvelopeOnce:
    conversationCommandRendererClient.includes('buildConversationCommandRequest') &&
    conversationCommandRendererClient.includes('payload: { operationIdentity, inputSha256 }') &&
    conversationCommandRendererClient.includes('Transport 内部重连或重试必须复用此处一次构造的不可变 Body') &&
    (conversationRendererApiClient.match(/buildConversationCommandRequest\(\{/gu)?.length ?? 0) === 11,
  behaviorVerifierInGate: zarchGate.includes("'conversation-command-behavior'") && zarchGate.includes('scripts/verify-conversation-command-behavior.ts'),
};
const conversationCommandSliceReady = Object.values(conversationCommandMarkers).every(Boolean);
const conversationDispatchCommandTypeValues = [
  'conversation.turn.change_set.undo',
  'conversation.turn.change_set.reapply',
  'conversation.message.submit',
  'conversation.side_chat.ask',
  'conversation.queue.update',
  'conversation.queue.retry',
  'conversation.queue.reroute',
  'conversation.queue.delete',
  'conversation.queue.send_now',
  'conversation.queue.resume',
  'conversation.queue.recover',
  'conversation.queue.reorder',
  'conversation.turn.interrupt',
  'conversation.server_request.respond',
  'conversation.plan_implementation.respond',
  'conversation.request.snooze',
];
const conversationDispatchCommandMarkers = {
  exactSixteenPublicCommands:
    conversationDispatchCommandTypeValues.every((commandType) => conversationDispatchCommandApplication.includes(`'${commandType}'`) && conversationDispatchCommandRendererClient.includes(`'${commandType}'`)) &&
    (conversationDispatchCommandRoutes.match(/\bserver\.(?:post|patch|delete)\s*\(/gu)?.length ?? 0) === 15,
  publicEnvelopeUsesTrueResourceScopes:
    ['product_conversation', 'submission', 'turn', 'approval'].every((scope) => sharedCommandEnvelope.includes(`'${scope}'`)) &&
    conversationDispatchCommandApplication.includes("Extract<CommandScopeKind, 'product_conversation' | 'submission' | 'turn' | 'approval'>"),
  bodySeparatesCommandAndInput:
    conversationDispatchCommandApplication.includes("assertExactKeys(request, ['command', 'input']") &&
    conversationDispatchCommandApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") &&
    conversationDispatchCommandApplication.includes('inputSha256 does not match Body.input'),
  coreFactsAndReceiptShareTransaction:
    conversationDispatchCommandApplication.includes('this.options.deliveries.executeCoreApplication({') &&
    conversationDispatchCommandApplication.includes('mutateBusinessState: () => {') &&
    conversationDispatchCommandApplication.includes('assertBoundedCoreEvidence(evidence);') &&
    conversationQueueCoreMutationApplication.includes('本类不保存、不广播，也不触发 Provider 派发') &&
    !['db.save(', 'publishRealtimeEvent(', 'codexNativeCoordinator', 'piNativeCoordinator', 'writeFile('].some((marker) => conversationQueueCoreMutationApplication.includes(marker)),
  externalOperationFourStates:
    conversationDispatchCommandApplication.includes("destinationKind: 'external_operation'") &&
    conversationDispatchCommandApplication.includes('markExternalWriteStarted({') &&
    ["'failed_before_write'", "'explicitly_rejected'", "'outcome_unknown_after_write'", "outcome: 'accepted'"].every((marker) => conversationDispatchCommandApplication.includes(marker)),
  unknownBlocksAutomaticReplay:
    conversationDispatchCommandApplication.includes("outcome === 'outcome_unknown_after_write'") &&
    conversationDispatchCommandApplication.includes('throw outcomeUnknown(error, this.options.redactSensitiveText)') &&
    conversationDispatchCommandApplication.includes("latest.outcome !== 'accepted'"),
  artifactReplayAndBoundedErrors:
    conversationDispatchCommandApplication.includes('const maximumExternalReplayResultBytes = 32 * 1024 * 1024') &&
    conversationDispatchCommandApplication.includes('const maximumCoreReceiptEvidenceBytes = 256 * 1024') &&
    conversationDispatchCommandApplication.includes('const maximumErrorMessageBytes = 2 * 1024') &&
    conversationDispatchCommandApplication.includes('artifacts.putJson({') &&
    conversationDispatchCommandApplication.includes('resultArtifact: {') &&
    conversationDispatchCommandApplication.includes('artifacts.readAuthorized({') &&
    conversationDispatchCommandApplication.includes('boundedErrorMessage(error.message, redactSensitiveText)'),
  concurrentDuplicateCollapsed:
    conversationDispatchCommandApplication.includes('private readonly activeExternalExecutions = new Map<') && conversationDispatchCommandApplication.includes('const active = this.activeExternalExecutions.get(activeKey)'),
  stableParentChildOperationIdentity:
    conversationDispatchCommandRoutes.includes('externalOperationId: `conversation-message:${request.params.conversationId}:${idempotencyKey}`') &&
    conversationDispatchCommandRoutes.includes('externalOperationId: `provider-turn-steer:${request.params.submissionId}`') &&
    conversationDispatchCommandRoutes.includes('externalOperationId: `provider-turn-interrupt:${request.params.turnId}`') &&
    localServerComposition.includes('acceptNativeConversationMessage(conversation, content, body, idempotencyKey, input.operationIdentity') &&
    localServerComposition.includes('idempotencyKey: input.operationIdentity') &&
    codexCoordinator.includes('const submissionIdentity = input.operationIdentity ?? operationId()'),
  compositionInjectsOnePublicLedgerAndExistingProviderCommands:
    localServerComposition.includes('new ConversationDispatchCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore') &&
    localServerComposition.includes('new ConversationQueueCoreMutationApplication({') &&
    localServerComposition.includes('registerConversationDispatchCommandRoutes({') &&
    sourceBlock(localServerComposition, 'registerConversationDispatchCommandRoutes({', '\n  });').includes('application: conversationDispatchCommands') &&
    sourceBlock(localServerComposition, 'registerConversationDispatchCommandRoutes({', '\n  });').includes('codexNativeCoordinator.') &&
    sourceBlock(localServerComposition, 'registerConversationDispatchCommandRoutes({', '\n  });').includes('piNativeCoordinator.'),
  rendererBuildsEnvelopeOnceAndReconnectReuses:
    conversationDispatchCommandRendererClient.includes('buildConversationDispatchCommandRequest') &&
    conversationDispatchCommandRendererClient.includes('payload: { operationIdentity, inputSha256 }') &&
    conversationDispatchCommandRendererClient.includes('const stableRequests = new Map<') &&
    conversationDispatchCommandRendererClient.includes('const maximumStableRequests = 256') &&
    conversationDispatchCommandRendererClient.includes('A reconnect identity cannot be reused with different conversation command input.') &&
    (conversationRendererApiClient.match(/buildConversationDispatchCommandRequest\(\{/gu)?.length ?? 0) === 15 &&
    (conversationRendererApiClient.match(/reconnectIdentity: input\.idempotencyKey/gu)?.length ?? 0) === 2,
  oldInlineHandlersRemoved:
    !localServerComposition.includes("server.post('/api/projects/:projectId/conversations/:conversationId/messages'") &&
    !localServerComposition.includes("server.patch('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId'") &&
    !localServerComposition.includes("server.post('/api/projects/:projectId/conversations/:conversationId/requests/:requestId/respond'"),
  behaviorAndStructureVerifierInGate:
    zarchGate.includes("'conversation-dispatch-command-behavior'") &&
    zarchGate.includes('scripts/verify-conversation-dispatch-command-behavior.ts') &&
    zarchGate.includes("'conversation-dispatch-command-slice'") &&
    zarchGate.includes("'--require-conversation-dispatch-command-slice'"),
};
const conversationDispatchCommandSliceReady = Object.values(conversationDispatchCommandMarkers).every(Boolean);
const integrationExternalCommandOperations = [
  ['POST /api/model-connections', 'modelConnectionCreate'],
  ['PUT /api/model-connections/:connectionId', 'modelConnectionUpdate'],
  ['DELETE /api/model-connections/:connectionId', 'modelConnectionDelete'],
  ['DELETE /api/model-connections/:connectionId/api-key', 'modelConnectionApiKeyClear'],
  ['POST /api/model-connections/:connectionId/models/refresh', 'modelConnectionModelsRefresh'],
  ['POST /api/zentao-instances', 'zentaoInstanceCreate'],
  ['PUT /api/zentao-instances/:instanceId', 'zentaoInstanceUpdate'],
  ['DELETE /api/zentao-instances/:instanceId', 'zentaoInstanceDelete'],
  ['DELETE /api/zentao-instances/:instanceId/password', 'zentaoInstancePasswordClear'],
  ['PUT /api/security/secrets/telegram-bot-token', 'telegramBotTokenPut'],
  ['DELETE /api/security/secrets/telegram-bot-token', 'telegramBotTokenDelete'],
  ['PUT /api/security/secrets/external-api-key', 'externalApiKeyPut'],
  ['DELETE /api/security/secrets/external-api-key', 'externalApiKeyDelete'],
];
const integrationCoreCommandOperations = [['PUT /api/projects/:projectId/model-selection', 'projectModelSelectionSave']];
const integrationReadOnlyProbeOperations = [
  ['POST /api/model-connections/:connectionId/diagnose', 'modelConnectionDiagnose'],
  ['POST /api/zentao-instances/:instanceId/verify', 'zentaoInstanceVerify'],
];
const integrationCommandOperations = [...integrationExternalCommandOperations, ...integrationCoreCommandOperations, ...integrationReadOnlyProbeOperations];
const integrationCommandTypeValues = [
  'integration.model_connection.create',
  'integration.model_connection.update',
  'integration.model_connection.delete',
  'integration.model_connection.api_key.clear',
  'integration.model_connection.models.refresh',
  'integration.model_connection.diagnose',
  'integration.zentao_instance.create',
  'integration.zentao_instance.update',
  'integration.zentao_instance.delete',
  'integration.zentao_instance.password.clear',
  'integration.zentao_instance.verify',
  'settings.project_model_selection.save',
  'integration.telegram_bot_token.put',
  'integration.telegram_bot_token.delete',
  'integration.external_api_key.put',
  'integration.external_api_key.delete',
];
const integrationReadOnlyProbeHelper = sourceBlock(integrationCommandApplication, 'executeReadOnlyProbe<TInput extends object, TResult>', '\n\n  probeSnapshot');
const integrationSecretPutHelper = sourceBlock(integrationCommandRoutes, 'function registerSecretPutRoute(', '\n\nfunction registerSecretDeleteRoute(');
const integrationSecretDeleteHelper = sourceBlock(integrationCommandRoutes, 'function registerSecretDeleteRoute(', '\n\nfunction parseResourceCommand<');
const integrationCommandMarkers = {
  exactSixteenPublicCommands:
    integrationCommandTypeValues.length === 16 &&
    integrationCommandTypeValues.every((commandType) => integrationCommandApplication.includes(`'${commandType}'`) && integrationCommandEnvelopeClient.includes(`'${commandType}'`)) &&
    integrationCommandOperations.length === 16 &&
    integrationCommandOperations.every(([operation]) => integrationCommandApplication.includes(`'${operation}'`)) &&
    (integrationCommandRoutes.match(/\bserver\.(?:post|put|delete)\s*\(\s*'/gu)?.length ?? 0) === 12 &&
    (integrationCommandRoutes.match(/registerSecret(?:Put|Delete)Route\(options,\s*\{/gu)?.length ?? 0) === 4,
  publicEnvelopeUsesTrueResourceScopes:
    ['settings', 'integration_account', 'provider_configuration', 'provider_account'].every((scope) => sharedCommandEnvelope.includes(`'${scope}'`)) &&
    integrationCommandApplication.includes("Extract<CommandScopeKind, 'settings' | 'integration_account' | 'provider_configuration' | 'provider_account'>"),
  bodySeparatesCommandAndInput:
    integrationCommandApplication.includes("assertExactKeys(request, ['command', 'input']") &&
    integrationCommandApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") &&
    integrationCommandApplication.includes('canonicalCommandInputJson(input)') &&
    integrationCommandApplication.includes('inputSha256 does not match Body.input'),
  coreFactAndAcceptedReceiptShareTransaction:
    integrationCommandApplication.includes('this.options.deliveries.executeCoreApplication({') &&
    integrationCommandApplication.includes('mutateBusinessState: () => {') &&
    integrationCommandApplication.includes('assertJsonBudget(evidence, maximumCoreEvidenceBytes') &&
    integrationCommandRoutes.includes('application.replayAcceptedCore<ProjectModelSelectionInput, ProjectModelSelection>') &&
    sourceBlock(integrationCommandRoutes, "server.put('/api/projects/:projectId/model-selection'", '\n\n  registerSecretPutRoute').includes('application.executeCore({'),
  conservativeExternalOperationProtocol:
    integrationCommandApplication.includes('this.options.deliveries.acceptAndPrepare({') &&
    integrationCommandApplication.includes("destinationKind: 'external_operation'") &&
    integrationCommandApplication.includes('markExternalWriteStarted({') &&
    integrationCommandApplication.includes("outcome: 'accepted'") &&
    integrationCommandApplication.includes("writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write'"),
  unknownBlocksBlindAutomaticRetry:
    integrationCommandApplication.includes("latest.outcome !== 'accepted'") &&
    integrationCommandApplication.includes("'ZEUS_INTEGRATION_COMMAND_OUTCOME_UNKNOWN'") &&
    integrationCommandApplication.includes('automaticRetryAfterUnknown: false'),
  immutableArtifactReplayAndBoundedEvidence:
    integrationCommandApplication.includes('const maximumReplayResultBytes = 8 * 1024 * 1024') &&
    integrationCommandApplication.includes('const maximumCoreEvidenceBytes = 64 * 1024') &&
    integrationCommandApplication.includes('const maximumErrorMessageBytes = 2 * 1024') &&
    integrationCommandApplication.includes('this.options.artifacts.putJson({') &&
    integrationCommandApplication.includes('resultArtifact: {') &&
    integrationCommandApplication.includes('this.options.artifacts.readAuthorized({') &&
    integrationCommandApplication.includes('stored.ref.generationId !== resultArtifactGeneration'),
  readOnlyProbeIsBoundedAndHasNoWal:
    integrationCommandApplication.includes('probeReplay: { durable: false, maximumEntries: 128, ttlMs: 30_000, maximumResultBytes: 1024 * 1024 }') &&
    integrationReadOnlyProbeHelper.includes('this.activeProbes.get(') &&
    integrationReadOnlyProbeHelper.includes('this.probeReplays.set(') &&
    integrationReadOnlyProbeHelper.includes('this.activeProbes.size + this.probeReplays.size >= maximumEntries') &&
    integrationReadOnlyProbeHelper.indexOf('this.activeProbes.size + this.probeReplays.size >= maximumEntries') < integrationReadOnlyProbeHelper.indexOf('const execution =') &&
    integrationReadOnlyProbeHelper.includes('ZEUS_INTEGRATION_PROBE_CAPACITY_EXCEEDED') &&
    !integrationReadOnlyProbeHelper.includes('this.options.deliveries.'),
  secretValuesStayOutsideCommandAuditAndArtifact:
    integrationCommandApplication.includes("secretPersistence: 'hash-only-command-envelope-and-non-secret-result-artifact'") &&
    integrationSecretPutHelper.includes('sensitiveValues: sensitiveValues(rawSecret, secret)') &&
    integrationSecretPutHelper.includes('return options.readSecuritySecrets()') &&
    integrationSecretPutHelper.includes('secretValueStored: false') &&
    integrationSecretDeleteHelper.includes('return options.readSecuritySecrets()') &&
    integrationCommandRoutes.includes('sensitiveValues: sensitiveValues(parsed.input.apiKey)') &&
    integrationCommandRoutes.includes('sensitiveValues: sensitiveValues(parsed.input.password)'),
  concurrentDuplicateCollapsed: integrationCommandApplication.includes('private readonly activeExternalExecutions = new Map<') && integrationCommandApplication.includes('const active = this.activeExternalExecutions.get(activeKey)'),
  compositionInjectsSingleLedgerAndArtifactStore:
    localServerComposition.includes('new IntegrationCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore') &&
    localServerComposition.includes('registerIntegrationCommandRoutes({') &&
    sourceBlock(localServerComposition, 'registerIntegrationCommandRoutes({', '\n  });').includes('application: integrationCommands'),
  rendererBuildsEnvelopeOnce:
    integrationCommandEnvelopeClient.includes('buildIntegrationCommandRequest') &&
    integrationCommandEnvelopeClient.includes('payload: { operationIdentity, inputSha256 }') &&
    integrationCommandEnvelopeClient.includes('连接刷新与 HTTP 重试复用同一个序列化 Body') &&
    integrationCommandOperations.every(([, commandName]) => integrationCommandRendererClient.includes(`integrationClientCommandTypes.${commandName}`)),
  plaintextPersistenceVerifierAndGatesPresent:
    zarchGate.includes("'integration-command-behavior'") &&
    zarchGate.includes('scripts/verify-integration-command-behavior.ts') &&
    zarchGate.includes("'integration-command-slice'") &&
    zarchGate.includes("'--require-integration-command-slice'") &&
    (await readFile(join(repositoryRoot, 'scripts/verify-integration-command-behavior.ts'), 'utf8')).includes('commandTablesContainSecret: durableText.includes(secretSentinel)'),
};
const integrationCommandSliceReady = Object.values(integrationCommandMarkers).every(Boolean);
const settingsCommandOperations = [
  ['PUT /api/projects/:projectId/database/secret', 'projectDatabaseSecretPut', 'external'],
  ['DELETE /api/projects/:projectId/database/secret', 'projectDatabaseSecretDelete', 'external'],
  ['PUT /api/projects/:projectId/config', 'projectConfigPut', 'core'],
  ['PUT /api/runtime/settings', 'runtimeSettingsPut', 'external'],
  ['PUT /api/settings/app-shell', 'appShellSettingsPut', 'core'],
  ['POST /api/settings/code-graph-cache/clear', 'projectionCacheClear', 'external'],
  ['POST /api/settings/cache/clear', 'projectionCacheClear', 'external'],
  ['POST /api/settings/import', 'settingsImport', 'external'],
  ['POST /api/data/import', 'dataImport', 'external'],
  ['PUT /api/code-map/settings', 'codeMapSettingsPut', 'core'],
];
const settingsCommandTypeValues = [
  'settings.project_database_secret.put',
  'settings.project_database_secret.delete',
  'settings.project_config.put',
  'settings.runtime.put',
  'settings.app_shell.put',
  'settings.projection_cache.clear',
  'settings.import',
  'settings.business_data.import',
  'settings.code_map.put',
];
const settingsImportRouteBlock = sourceBlock(localServerComposition, "server.post('/api/settings/import'", "\n\n  server.get('/api/data/export'");
const settingsDataImportRouteBlock = sourceBlock(localServerComposition, "'/api/data/import',", "\n\n  server.get('/api/code-map/settings'");
const settingsCacheHelper = sourceBlock(localServerComposition, 'const clearCodeGraphCache = async', "\n  server.post('/api/settings/code-graph-cache/clear'");
const settingsCommandMarkers = {
  exactTenPublicRoutes:
    settingsCommandOperations.length === 10 &&
    settingsCommandTypeValues.length === 9 &&
    settingsCommandTypeValues.every((commandType) => settingsCommandApplication.includes(`'${commandType}'`) && settingsCommandRendererClient.includes(`'${commandType}'`)) &&
    settingsCommandOperations.every(([operation]) => settingsCommandApplication.includes(`'${operation}'`)),
  publicHashOnlyEnvelopeAndTrueScopes:
    settingsCommandApplication.includes("assertExactKeys(request, ['command', 'input']") &&
    settingsCommandApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") &&
    settingsCommandApplication.includes("Extract<CommandScopeKind, 'project' | 'settings'>") &&
    settingsCommandApplication.includes('inputSha256 does not match Body.input'),
  coreFactAndReceiptAtomic:
    settingsCommandApplication.includes('this.options.deliveries.executeCoreApplication({') &&
    settingsCommandApplication.includes('mutateBusinessState: () => {') &&
    settingsCommandApplication.includes('assertJsonBudget(evidence, maximumCoreEvidenceBytes'),
  conservativeExternalFourStateProtocol:
    settingsCommandApplication.includes('this.options.deliveries.acceptAndPrepare({') &&
    settingsCommandApplication.includes("destinationKind: 'external_operation'") &&
    settingsCommandApplication.includes('markExternalWriteStarted({') &&
    settingsCommandApplication.includes("'failed_before_write'") &&
    settingsCommandApplication.includes("'explicitly_rejected'") &&
    settingsCommandApplication.includes("'outcome_unknown_after_write'") &&
    settingsCommandApplication.includes("outcome: 'accepted'") &&
    settingsCommandApplication.includes('automaticRetryAfterUnknown: false'),
  immutableArtifactReplayAndBoundedImports:
    settingsCommandApplication.includes('importBodyBudgets: { settingsBytes: 1024 * 1024, businessDataBytes: 32 * 1024 * 1024 }') &&
    settingsCommandApplication.includes('stageImportArtifact(') &&
    settingsCommandApplication.includes('this.options.artifacts.putJson({') &&
    settingsCommandApplication.includes('this.options.artifacts.readAuthorized({') &&
    settingsCommandApplication.includes('const maximumErrorMessageBytes = 2 * 1024'),
  importsFullyPlanBeforeMutation:
    settingsImportRouteBlock.includes('全部字段先完成 parse/normalize/关联约束计划') &&
    settingsImportRouteBlock.indexOf('plannedTelegramSecurity') < settingsImportRouteBlock.indexOf('settingsCommands.executeExternal({') &&
    settingsDataImportRouteBlock.includes('validateLocalBusinessDataImport(db, parsed.input)') &&
    settingsDataImportRouteBlock.indexOf('validateLocalBusinessDataImport(db, parsed.input)') < settingsDataImportRouteBlock.indexOf('settingsCommands.executeExternal({') &&
    settingsDataImportRouteBlock.includes('stageImportArtifact({'),
  secretPlaintextExcluded:
    settingsCommandApplication.includes("secretPersistence: 'hash-only-command-envelope-and-non-secret-result-artifact'") &&
    sourceBlock(localServerComposition, "'/api/projects/:projectId/database/secret',", '\n  server.delete(').includes('sensitiveValues: [password]') &&
    settingsCommandBehaviorVerifier.includes('durableContainsPlaintext: durableText.includes(secretSentinel)'),
  derivedBoundariesExplicit:
    settingsCommandApplication.includes("runtimeRetentionFact: 'runtime.settings.logRetentionDays'") &&
    settingsCommandApplication.includes("runtimeRetentionDerivedOperation: 'rebuildable_runtime_log_retention'") &&
    settingsCommandApplication.includes("projectionCacheFact: 'app.shell.settings.lastCacheClearAt'") &&
    settingsCommandApplication.includes("projectionCacheDerivedOperation: 'rebuildable_projection_database_cache'") &&
    settingsCacheHelper.includes('projectionDatabases.enqueueIndexWrite') &&
    settingsCacheHelper.includes('settingsCommands.executeExternal({'),
  concurrentDuplicateCollapsed: settingsCommandApplication.includes('private readonly activeExternalExecutions = new Map<') && settingsCommandApplication.includes('const active = this.activeExternalExecutions.get(activeKey)'),
  compositionUsesSingleLedgerAndArtifactStore: localServerComposition.includes('new SettingsCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore'),
  rendererBuildsEnvelopeOnce:
    settingsCommandRendererClient.includes('buildSettingsCommandRequest') &&
    settingsCommandRendererClient.includes('传输层刷新连接时复用同一 JSON body') &&
    settingsCommandOperations.every(([, commandName]) => `${settingsRendererApiClient}\n${projectRendererClient}\n${desktopApiClient}`.includes(`settingsClientCommandTypes.${commandName}`)),
  behaviorAndStructureVerifierInGate:
    zarchGate.includes("'settings-command-behavior'") && zarchGate.includes('scripts/verify-settings-command-behavior.ts') && zarchGate.includes("'settings-command-slice'") && zarchGate.includes("'--require-settings-command-slice'"),
};
const settingsCommandSliceReady = Object.values(settingsCommandMarkers).every(Boolean);
const telegramIndexCommandOperations = [
  ['POST /api/security/reset', 'securityReset', 'external'],
  ['PUT /api/telegram/notification-settings', 'notificationSettingsUpdate', 'core'],
  ['POST /api/telegram/test', 'connectionTest', 'external'],
  ['PUT /api/telegram/security-settings', 'securitySettingsUpdate', 'external'],
  ['POST /api/telegram/dispatch-preview', 'dispatchPreview', 'external'],
  ['PATCH /api/telegram/settings', 'settingsUpdate', 'external'],
];
const telegramPollingCommandOperations = [
  ['POST /api/telegram/start', 'pollingStart'],
  ['POST /api/telegram/stop', 'pollingStop'],
  ['POST /api/telegram/polling/start', 'pollingStart'],
  ['POST /api/telegram/polling/poll-once', 'pollingOnce'],
  ['POST /api/telegram/polling/stop', 'pollingStop'],
];
const telegramCommandOperations = [...telegramIndexCommandOperations.map(([operation]) => operation), ...telegramPollingCommandOperations.map(([operation]) => operation)];
const telegramCommandTypeValues = [
  'security.reset',
  'telegram.notification_settings.update',
  'telegram.connection.test',
  'telegram.security_settings.update',
  'telegram.dispatch_preview',
  'telegram.settings.update',
  'telegram.polling.start',
  'telegram.polling.stop',
  'telegram.polling.poll_once',
];
const telegramPollingStartHandler = sourceBlock(telegramPollingApi, 'const start = async (', '\n\n  const stop =');
const telegramPollingStopHandler = sourceBlock(telegramPollingApi, 'const stop = async (', '\n\n  const pollOnce =');
const telegramPollingOnceHandler = sourceBlock(telegramPollingApi, 'const pollOnce = async (', "\n\n  options.server.post('/api/telegram/start'");
const telegramCommandMarkers = {
  exactElevenPublicMutations:
    telegramCommandOperations.length === 11 &&
    telegramCommandTypeValues.length === 9 &&
    telegramCommandTypeValues.every((commandType) => telegramCommandApplication.includes(`'${commandType}'`) && telegramCommandRendererClient.includes(`'${commandType}'`)) &&
    telegramIndexCommandOperations.every(([operation]) => localServerComposition.includes(`'${operation.slice(operation.indexOf(' ') + 1)}'`)) &&
    telegramPollingCommandOperations.every(([operation]) => telegramPollingApi.includes(`'${operation.slice(operation.indexOf(' ') + 1)}'`)) &&
    (telegramPollingApi.match(/options\.server\.post\('/gu)?.length ?? 0) === 5,
  bodySeparatesCommandAndInput:
    telegramCommandApplication.includes("assertExactKeys(request, ['command', 'input']") &&
    telegramCommandApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") &&
    telegramCommandApplication.includes('canonicalCommandInputJson(input)') &&
    telegramCommandApplication.includes('inputSha256 does not match Body.input'),
  coreFactAndAcceptedReceiptShareTransaction:
    telegramCommandApplication.includes('this.options.deliveries.executeCoreApplication({') &&
    telegramCommandApplication.includes('mutateBusinessState: () => {') &&
    sourceBlock(localServerComposition, "server.put('/api/telegram/notification-settings'", "\n\n  server.post('/api/telegram/test'").includes('telegramCommands.executeCore({'),
  conservativeExternalOperationProtocol:
    telegramCommandApplication.includes('this.options.deliveries.acceptAndPrepare({') &&
    telegramCommandApplication.includes("destinationKind: 'external_operation'") &&
    telegramCommandApplication.includes('markExternalWriteStarted({') &&
    telegramCommandApplication.includes("outcome: 'accepted'") &&
    telegramCommandApplication.includes("'explicitly_rejected'") &&
    telegramCommandApplication.includes("writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write'"),
  acceptedReplayAndUnknownBlocksBlindRetry:
    telegramCommandApplication.includes("state: 'accepted_replay'") &&
    telegramCommandApplication.includes('readResult<TResult>(preparation.receipt') &&
    telegramCommandApplication.includes('ZEUS_TELEGRAM_COMMAND_OUTCOME_UNKNOWN') &&
    telegramCommandApplication.includes('automaticRetryAfterUnknown: false'),
  stableCompositeChildIdentities:
    telegramCommandApplication.includes('telegramChildOperation(operationIdentity: string, kind: string)') &&
    telegramCommandApplication.includes('childOperations: children') &&
    localServerComposition.includes("telegramChildOperation(parsed.operationIdentity, 'polling_service_stop')") &&
    localServerComposition.includes("telegramChildOperation(parsed.operationIdentity, 'telegram_token_delete')"),
  boundedRedactedReceipts:
    telegramCommandApplication.includes('maximumReceiptBytes: 64 * 1024') &&
    telegramCommandApplication.includes('maximumErrorBytes: 2 * 1024') &&
    telegramCommandApplication.includes('assertReceiptBudget(evidence)') &&
    telegramCommandApplication.includes('redactJsonValue(result, this.options.redactSensitiveText)') &&
    telegramCommandApplication.includes('truncateUtf8(redactor(raw).text'),
  pollingAliasesAndCapacity:
    telegramPollingStartHandler.includes('telegramCommandTypes.pollingStart') &&
    telegramPollingStopHandler.includes('telegramCommandTypes.pollingStop') &&
    telegramPollingOnceHandler.includes('telegramCommandTypes.pollingOnce') &&
    telegramPollingOnceHandler.includes("capacityGroup: 'poll_once'") &&
    telegramCommandApplication.includes('private readonly activeExternalExecutions = new Map<') &&
    telegramCommandApplication.includes('ZEUS_TELEGRAM_POLL_CAPACITY_EXCEEDED') &&
    telegramCommandApplication.includes('pollingOnceMaximumActive: 1'),
  noUncertainNetworkRetry:
    !localServerComposition.includes('sendTelegramNotificationWithRetry') &&
    localServerComposition.includes('sendTelegramNotificationOnce') &&
    localServerComposition.includes('超时无法证明 Telegram 是否已接纳') &&
    !sourceBlock(localServerComposition, "server.post('/api/telegram/test'", "\n\n  server.get('/api/telegram/security-settings'").includes('Promise.all('),
  compositionInjectsSingleLedger:
    localServerComposition.includes('new TelegramCommandApplication({ db, deliveries: commandDeliveries') &&
    localServerComposition.includes('registerTelegramPollingApi({') &&
    sourceBlock(localServerComposition, 'registerTelegramPollingApi({', '\n  });').includes('application: telegramCommands'),
  rendererBuildsEnvelopeOnce:
    telegramCommandRendererClient.includes('buildTelegramCommandRequest') &&
    telegramCommandRendererClient.includes('payload: { operationIdentity, inputSha256 }') &&
    telegramCommandRendererClient.includes('Local transport 的连接刷新会 byte-identical 重用该 Body') &&
    ['securityReset', 'notificationSettingsUpdate', 'connectionTest', 'securitySettingsUpdate', 'dispatchPreview', 'settingsUpdate', 'pollingStart', 'pollingStop', 'pollingOnce'].every((commandName) =>
      telegramRendererApiClient.includes(`telegramClientCommandTypes.${commandName}`),
    ),
  behaviorVerifierAndGatePresent:
    zarchGate.includes("'telegram-command-behavior'") &&
    zarchGate.includes('scripts/verify-telegram-command-behavior.ts') &&
    zarchGate.includes("'telegram-command-slice'") &&
    zarchGate.includes("'--require-telegram-command-slice'") &&
    (await readFile(join(repositoryRoot, 'scripts/verify-telegram-command-behavior.ts'), 'utf8')).includes('durableSecretPresent: durableText.includes(secretSentinel)'),
};
const telegramCommandSliceReady = Object.values(telegramCommandMarkers).every(Boolean);
const gitCommandOperations = [
  'POST /api/git/confirmations',
  'POST /api/git/confirmations/:confirmationId/reject',
  'POST /api/git/confirmations/:confirmationId/confirm',
  'POST /api/git/operations',
  'POST /api/projects/:projectId/git/branch',
  'POST /api/projects/:projectId/git/checkout',
  'POST /api/projects/:projectId/git/commit',
  'POST /api/projects/:projectId/git/stash',
  'POST /api/projects/:projectId/git/apply-stash',
  'POST /api/projects/:projectId/git/pull',
  'POST /api/projects/:projectId/git/push',
  'POST /api/tasks/:taskId/git/rollback',
];
const gitCommandTypeValues = [
  'git.confirmation.create',
  'git.confirmation.confirm',
  'git.confirmation.reject',
  'git.operation.execute',
  'git.project.branch',
  'git.project.checkout',
  'git.project.commit',
  'git.project.stash',
  'git.project.apply_stash',
  'git.project.pull',
  'git.project.push',
  'git.task.rollback',
];
const gitExternalExecutionHelper = sourceBlock(gitCommandRoutes, 'async function executeConfirmedOperation(', '\n\nfunction requireHighRiskGitOperation');
const gitCommandMarkers = {
  exactTwelvePublicCommands:
    gitCommandTypeValues.every((commandType) => gitCommandApplication.includes(`'${commandType}'`) && gitCommandRendererClient.includes(`'${commandType}'`)) &&
    gitCommandOperations.every((operation) => gitCommandRoutes.includes(`'${operation.slice('POST '.length)}'`)),
  bodySeparatesCommandAndInput:
    gitCommandApplication.includes("assertExactKeys(request, ['command', 'input']") &&
    gitCommandApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") &&
    gitCommandApplication.includes('inputSha256 does not match Body.input'),
  ephemeralConfirmationIsBoundedAndHasNoWal:
    gitCommandRoutes.includes('class GitConfirmationCapabilityService') &&
    gitCommandRoutes.includes('maximumConfirmations ?? 128') &&
    gitCommandRoutes.includes('maximumRecentCommands ?? 256') &&
    gitCommandRoutes.includes('replayTtlMs ?? 10 * 60 * 1_000') &&
    gitCommandRoutes.includes('ZEUS_GIT_CONFIRMATION_ALREADY_CONSUMED') &&
    !gitCommandRoutes.includes('executeCore') &&
    !gitCommandRoutes.includes('CommandDeliveryRepository'),
  confirmationConsumedBeforeDurableMarker:
    gitExternalExecutionHelper.includes('beforeWrite: async () => {') &&
    gitExternalExecutionHelper.includes('confirmationCapabilities.consume(') &&
    gitCommandApplication.indexOf('await input.beforeWrite?.();') >= 0 &&
    gitCommandApplication.indexOf('await input.beforeWrite?.();') < gitCommandApplication.indexOf('markExternalWriteStarted({'),
  externalOperationUsesStableConfirmationIdentity:
    gitExternalExecutionHelper.includes('externalOperationId: `git-confirmation:${confirmationId}`') && gitCommandApplication.includes("destinationKind: 'external_operation'") && gitCommandApplication.includes('markExternalWriteStarted({'),
  conservativeOutcomeAndReplayPolicy:
    gitCommandApplication.includes("writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write'") &&
    gitCommandApplication.includes("latest.outcome !== 'accepted'") &&
    !gitCommandApplication.includes("'explicitly_rejected'") &&
    gitCommandRoutes.includes('automaticRetryAfterUnknown: false'),
  immutableArtifactReplayIsBounded:
    gitCommandApplication.includes('const maximumReplayResultBytes = 32 * 1024 * 1024') &&
    gitCommandApplication.includes('assertReplayableResultSize(result)') &&
    gitCommandApplication.includes('artifacts.putJson({') &&
    gitCommandApplication.includes('resultArtifact: {') &&
    gitCommandApplication.includes('artifacts.readAuthorized({') &&
    gitCommandApplication.includes('maximumContentBytes: maximumReplayResultBytes') &&
    gitCommandApplication.includes('stored.ref.generationId !== resultArtifactGeneration'),
  boundedRedactedErrors:
    gitCommandApplication.includes('const maximumErrorMessageBytes = 2 * 1024') && gitCommandApplication.includes('boundedErrorMessage(error.message, redactSensitiveText)') && gitCommandRoutes.includes('boundedPublicErrorMessage('),
  concurrentDuplicateCollapsed: gitCommandApplication.includes('private readonly activeExternalExecutions = new Map<') && gitCommandApplication.includes('const active = this.activeExternalExecutions.get(activeKey)'),
  compositionInjectsSingleLedgerAndArtifactStore:
    localServerComposition.includes('new GitCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore') &&
    localServerComposition.includes('registerGitCommandRoutes({') &&
    sourceBlock(localServerComposition, 'registerGitCommandRoutes({', '\n  });').includes('application: gitCommands'),
  rendererBuildsEnvelopeOnce:
    gitCommandRendererClient.includes('buildGitCommandRequest') &&
    gitCommandRendererClient.includes('payload: { operationIdentity, inputSha256 }') &&
    gitCommandRendererClient.includes('LocalApiTransport 的连接刷新重试复用同一个序列化 Body') &&
    ['confirmationCreate', 'confirmationConfirm', 'confirmationReject', 'operationExecute', 'projectBranch', 'projectCheckout', 'projectCommit', 'projectStash', 'projectApplyStash', 'projectPull', 'projectPush', 'taskRollback'].every(
      (commandName) => gitRendererApiClient.includes(`gitClientCommandTypes.${commandName}`),
    ),
  behaviorAndStructureVerifierInGate:
    zarchGate.includes("'git-command-behavior'") && zarchGate.includes('scripts/verify-git-command-behavior.ts') && zarchGate.includes("'git-command-slice'") && zarchGate.includes("'--require-git-command-slice'"),
};
const gitCommandSliceReady = Object.values(gitCommandMarkers).every(Boolean);
const workspaceGitCommandOperations = [
  'POST /api/projects/:projectId/git/workbench/repositories/:repositoryId/actions',
  'POST /api/tasks/:taskId/git-workspaces/commit-all',
  'POST /api/tasks/:taskId/git-workspaces/push-all',
  'POST /api/tasks/:taskId/git-workspaces/:workspaceId/commit',
  'POST /api/tasks/:taskId/git-workspaces/:workspaceId/push',
  'POST /api/tasks/:taskId/git-workspaces/:workspaceId/stop-sessions',
  'POST /api/tasks/:taskId/git-workspaces/:workspaceId/reclaim',
  'POST /api/tasks/:taskId/git-workspaces/:workspaceId/discard',
  'POST /api/tasks/:taskId/git-workspaces/:workspaceId/integrate',
  'POST /api/tasks/:taskId/integrations/:integrationId/conflict/ai-session',
  'PUT /api/tasks/:taskId/integrations/:integrationId/conflict',
  'POST /api/tasks/:taskId/integrations/:integrationId/finalize',
  'POST /api/tasks/:taskId/integrations/:integrationId/push',
  'POST /api/projects/:projectId/git/snapshot',
  'POST /api/projects/:projectId/git/patch',
  'POST /api/projects/:projectId/codex-task-push-capabilities/repositories/:repositoryId/refresh-remote',
];
const workspaceGitCommandTypeValues = [
  'git.workbench.repository.action',
  'git.task_workspace.commit_all',
  'git.task_workspace.push_all',
  'git.task_workspace.commit',
  'git.task_workspace.push',
  'git.task_workspace.stop_sessions',
  'git.task_workspace.reclaim',
  'git.task_workspace.discard',
  'git.task_workspace.integrate',
  'git.task_integration.conflict_ai_session',
  'git.task_integration.conflict_resolve',
  'git.task_integration.finalize',
  'git.task_integration.push',
  'git.project.snapshot.create',
  'git.project.patch.export',
  'git.task_push.repository.refresh_remote',
];
const workspaceGitCommandMarkers = {
  exactSixteenExternalCommands:
    workspaceGitCommandOperations.length === 16 &&
    workspaceGitCommandTypeValues.length === 16 &&
    workspaceGitCommandTypeValues.every((commandType) => workspaceGitCommandApplication.includes(`'${commandType}'`) && workspaceGitCommandRendererClient.includes(`'${commandType}'`)) &&
    workspaceGitCommandOperations.every((operation) => workspaceGitCommandRoutes.includes(`'${operation.slice(operation.indexOf(' ') + 1)}'`)) &&
    (workspaceGitCommandRoutes.match(/\bserver\.(?:post|put)\s*\(/gu)?.length ?? 0) === 16,
  publicEnvelopeUsesTrueResourceScopes:
    sharedCommandEnvelope.includes("'task_workspace'") &&
    sharedCommandEnvelope.includes("'task_integration'") &&
    workspaceGitCommandApplication.includes("Extract<CommandScopeKind, 'project' | 'task' | 'task_workspace' | 'task_integration' | 'git_repository'>"),
  bodySeparatesCommandAndInput:
    workspaceGitCommandApplication.includes("assertExactKeys(request, ['command', 'input']") &&
    workspaceGitCommandApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") &&
    workspaceGitCommandApplication.includes('inputSha256 does not match Body.input'),
  conservativeExternalOperationProtocol:
    workspaceGitCommandApplication.includes('this.options.deliveries.acceptAndPrepare({') &&
    workspaceGitCommandApplication.includes("destinationKind: 'external_operation'") &&
    workspaceGitCommandApplication.includes('markExternalWriteStarted({') &&
    ["'failed_before_write'", "'explicitly_rejected'", "'outcome_unknown_after_write'", "outcome: 'accepted'"].every((marker) => workspaceGitCommandApplication.includes(marker)),
  unknownBlocksBlindAutomaticRetry:
    workspaceGitCommandApplication.includes("latest.outcome !== 'accepted'") &&
    workspaceGitCommandApplication.includes('ZEUS_WORKSPACE_GIT_COMMAND_OUTCOME_UNKNOWN') &&
    workspaceGitCommandRoutes.includes('automaticRetryAfterUnknown: false'),
  immutableArtifactReplayAndBoundedEvidence:
    workspaceGitCommandApplication.includes('const maximumReplayResultBytes = 32 * 1024 * 1024') &&
    workspaceGitCommandApplication.includes('const maximumErrorMessageBytes = 2 * 1024') &&
    workspaceGitCommandApplication.includes('this.options.artifacts.putJson({') &&
    workspaceGitCommandApplication.includes('resultArtifact: {') &&
    workspaceGitCommandApplication.includes('this.options.artifacts.readAuthorized({') &&
    workspaceGitCommandApplication.includes('stored.ref.generationId !== resultArtifactGeneration'),
  acceptedCoreProjectionSharesReceiptTransaction:
    workspaceGitCommandRoutes.includes('mutateAcceptedBusinessState: () => commitAccepted?.()') &&
    workspaceGitCommandApplication.includes('this.options.db.durableTransactionSync(() => {') &&
    workspaceGitCommandApplication.includes('input.mutateAcceptedBusinessState?.(result)') &&
    workspaceGitCommandApplication.includes('recordOutcomeInCurrentTransaction({'),
  concurrentDuplicateCollapsed: workspaceGitCommandApplication.includes('private readonly activeExternalExecutions = new Map<') && workspaceGitCommandApplication.includes('const active = this.activeExternalExecutions.get(activeKey)'),
  compositionInjectsSingleLedgerAndArtifactStore:
    localServerComposition.includes('new WorkspaceGitCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore') &&
    localServerComposition.includes('registerWorkspaceGitCommandRoutes({') &&
    sourceBlock(localServerComposition, 'registerWorkspaceGitCommandRoutes({', '\n  });').includes('application: workspaceGitCommands'),
  rendererBuildsEnvelopeOnce:
    workspaceGitCommandRendererClient.includes('buildWorkspaceGitCommandRequest') &&
    workspaceGitCommandRendererClient.includes('payload: { operationIdentity, inputSha256 }') &&
    workspaceGitCommandRendererClient.includes('const stableRequests = new Map<') &&
    workspaceGitCommandRendererClient.includes('const maximumStableRequests = 256') &&
    workspaceGitCommandRendererClient.includes('A reconnect identity cannot be reused with different Workspace Git command input.') &&
    workspaceGitCommandTypeValues.every((commandType) => workspaceGitCommandRendererClient.includes(`'${commandType}'`)) &&
    ['workbenchAction', 'projectSnapshotCreate', 'projectPatchExport'].every((commandName) => gitRendererApiClient.includes(`workspaceGitClientCommandTypes.${commandName}`)) &&
    [
      'taskWorkspaceCommitAll',
      'taskWorkspacePushAll',
      'taskWorkspaceCommit',
      'taskWorkspacePush',
      'taskWorkspaceStopSessions',
      'taskWorkspaceReclaim',
      'taskWorkspaceDiscard',
      'taskWorkspaceIntegrate',
      'taskIntegrationConflictAiSession',
      'taskIntegrationConflictResolve',
      'taskIntegrationFinalize',
      'taskIntegrationPush',
      'taskPushRepositoryRefreshRemote',
    ].every((commandName) => desktopApiClient.includes(`workspaceGitClientCommandTypes.${commandName}`)),
  oldInlineMutatorsRemoved:
    !localServerComposition.includes("server.post('/api/tasks/:taskId/git-workspaces/commit-all'") &&
    !localServerComposition.includes("server.post('/api/tasks/:taskId/git-workspaces/:workspaceId/integrate'") &&
    !localServerComposition.includes("server.post('/api/projects/:projectId/git/snapshot'"),
  behaviorAndStructureVerifierInGate:
    zarchGate.includes("'workspace-git-command-behavior'") &&
    zarchGate.includes('scripts/verify-workspace-git-command-behavior.ts') &&
    zarchGate.includes("'workspace-git-command-slice'") &&
    zarchGate.includes("'--require-workspace-git-command-slice'"),
};
const workspaceGitCommandSliceReady = Object.values(workspaceGitCommandMarkers).every(Boolean);
const graphConversationCommandOperations = [
  'POST /api/projects/:projectId/conversations',
  'POST /api/tasks/:taskId/conversations',
  'POST /api/projects/:projectId/scan',
  'POST /api/projects/:projectId/graph/views/generate',
  'POST /api/projects/:projectId/ask',
  'POST /api/graph/scan-current',
];
const graphConversationCommandTypeValues = ['conversation.project.create', 'conversation.task.create', 'graph.project.scan', 'graph.project.views.generate', 'graph.project.ask', 'graph.current.scan'];
const graphConversationCommandMarkers = {
  exactSixExternalCommands:
    graphConversationCommandOperations.length === 6 &&
    graphConversationCommandTypeValues.length === 6 &&
    graphConversationCommandTypeValues.every((commandType) => graphConversationCommandApplication.includes(`'${commandType}'`) && graphConversationCommandRendererClient.includes(`'${commandType}'`)) &&
    graphConversationCommandOperations.every((operation) => graphConversationCommandRoutes.includes(`'${operation.slice(operation.indexOf(' ') + 1)}'`)) &&
    (graphConversationCommandRoutes.match(/\bserver\.post\s*\(/gu)?.length ?? 0) === 6,
  publicEnvelopeUsesTrueResourceScopes:
    graphConversationCommandApplication.includes("Extract<CommandScopeKind, 'project' | 'task'>") && graphConversationCommandRoutes.includes("scopeKind: 'project'") && graphConversationCommandRoutes.includes("scopeKind: 'task'"),
  bodySeparatesCommandAndInput:
    graphConversationCommandApplication.includes("assertExactKeys(request, ['command', 'input']") &&
    graphConversationCommandApplication.includes("assertExactKeys(command.payload, ['inputSha256', 'operationIdentity']") &&
    graphConversationCommandApplication.includes('inputSha256 does not match Body.input'),
  conservativeExternalOperationProtocol:
    graphConversationCommandApplication.includes('this.options.deliveries.acceptAndPrepare({') &&
    graphConversationCommandApplication.includes("destinationKind: 'external_operation'") &&
    graphConversationCommandApplication.includes('await input.beforeWrite?.()') &&
    graphConversationCommandApplication.includes('markExternalWriteStarted({') &&
    ["'failed_before_write'", "'explicitly_rejected'", "'outcome_unknown_after_write'", "outcome: 'accepted'"].every((marker) => graphConversationCommandApplication.includes(marker)),
  unknownBlocksBlindAutomaticRetry:
    graphConversationCommandApplication.includes("latest.outcome !== 'accepted'") &&
    graphConversationCommandApplication.includes('ZEUS_GRAPH_CONVERSATION_COMMAND_OUTCOME_UNKNOWN') &&
    graphConversationCommandRoutes.includes('automaticRetryAfterUnknown: false'),
  immutableArtifactReplayAndBoundedEvidence:
    graphConversationCommandApplication.includes('const maximumReplayResultBytes = 32 * 1024 * 1024') &&
    graphConversationCommandApplication.includes('const maximumErrorMessageBytes = 2 * 1024') &&
    graphConversationCommandApplication.includes('this.options.artifacts.putJson({') &&
    graphConversationCommandApplication.includes('resultArtifact: {') &&
    graphConversationCommandApplication.includes('this.options.artifacts.readAuthorized({') &&
    graphConversationCommandApplication.includes('stored.ref.generationId !== resultArtifactGeneration'),
  acceptedCoreStatusSharesReceiptTransaction:
    graphConversationCommandRoutes.includes('mutateAcceptedBusinessState: (result) => operations.commitProjectScanAccepted') &&
    graphConversationCommandApplication.includes('this.options.db.durableTransactionSync(() => {') &&
    graphConversationCommandApplication.includes('input.mutateAcceptedBusinessState?.(result)') &&
    graphConversationCommandApplication.includes('recordOutcomeInCurrentTransaction({'),
  concurrentDuplicateCollapsed:
    graphConversationCommandApplication.includes('private readonly activeExternalExecutions = new Map<') && graphConversationCommandApplication.includes('const active = this.activeExternalExecutions.get(activeKey)'),
  stableChildIdentitiesAndBoundedProjection:
    localServerComposition.includes('stableGraphQuestionChildIdentity(parentOperationIdentity)') &&
    localServerComposition.includes('conversationId: `conversation_graph_${derive') &&
    localServerComposition.includes('submissionId: `conversation_submission_graph_${derive') &&
    localServerComposition.includes('id: childIdentity.runtimeSessionId') &&
    localServerComposition.includes('toPublicGraphScanResult(') &&
    localServerComposition.includes('delete publicResult.heavyWorkerResultRef'),
  compositionInjectsSingleLedgerAndArtifactStore:
    localServerComposition.includes('new GraphConversationCommandApplication({ db, deliveries: commandDeliveries, artifacts: artifactStore') &&
    localServerComposition.includes('registerGraphConversationCommandRoutes({') &&
    sourceBlock(localServerComposition, 'registerGraphConversationCommandRoutes({', '\n  });').includes('application: graphConversationCommands'),
  rendererBuildsEnvelopeOnce:
    graphConversationCommandRendererClient.includes('buildGraphConversationCommandRequest') &&
    graphConversationCommandRendererClient.includes('payload: { operationIdentity, inputSha256 }') &&
    graphConversationCommandRendererClient.includes('const stableRequests = new Map<') &&
    graphConversationCommandRendererClient.includes('const maximumStableRequests = 256') &&
    conversationRendererApiClient.includes('graphConversationClientCommandTypes.projectConversationCreate') &&
    conversationRendererApiClient.includes('graphConversationClientCommandTypes.taskConversationCreate') &&
    ['taskConversationCreate', 'currentGraphScan', 'projectGraphAsk', 'projectGraphScan'].every((commandName) => desktopApiClient.includes(`graphConversationClientCommandTypes.${commandName}`)),
  oldInlineMutatorsRemoved:
    !localServerComposition.includes("server.post('/api/projects/:projectId/scan'") &&
    !localServerComposition.includes("server.post('/api/projects/:projectId/graph/views/generate'") &&
    !localServerComposition.includes("server.post('/api/graph/scan-current'") &&
    !localServerComposition.includes("'/api/projects/:projectId/ask',\n    async"),
  behaviorAndStructureVerifierInGate:
    zarchGate.includes("'graph-conversation-command-behavior'") &&
    zarchGate.includes('scripts/verify-graph-conversation-command-behavior.ts') &&
    zarchGate.includes("'graph-conversation-command-slice'") &&
    zarchGate.includes("'--require-graph-conversation-create-command-slice'"),
};
const graphConversationCommandSliceReady = Object.values(graphConversationCommandMarkers).every(Boolean);
const projectArchiveConfirmationRoute = sourceBlock(workManagementProjectRoutes, "options.server.post('/api/projects/:projectId/archive-confirmation'", '\n  });');
const projectArchiveConfirmationReadOnly =
  workManagementProjectRoutes.includes('archiveConfirmation(projectId: string): unknown') &&
  projectArchiveConfirmationRoute.includes('options.archiveConfirmation(request.params.projectId)') &&
  workManagementProjectOperations.includes('archiveConfirmation(projectId: string)') &&
  workManagementProjectOperations.includes('return this.ports.projects.prepareArchive(this.requireProject(projectId).id)') &&
  !['projects.archive(', 'projects.update(', 'appendAuditLog(', 'executeCore(', 'executeExternal('].some((marker) => projectArchiveConfirmationRoute.includes(marker));
for (const [file, content] of sources) {
  entries.push(
    ...scanHttpMutators(file, content, {
      providerRuntimeRecoverySliceReady,
      memoryCommandRouteStatus,
      memoryPreviewReadOnly,
      commandCenterCommandSliceReady,
      workManagementCommandSliceReady,
      workManagementCoreRoutesReady,
      workManagementProjectRoutesReady,
      workManagementTaskCommandSliceReady,
      taskEventFileProjectionReady,
      projectArchiveConfirmationReadOnly,
      codexPublicCommandSliceReady,
      codexPairingStatusReadOnly,
      runtimeSessionCommandSliceReady,
      conversationCommandSliceReady,
      conversationDispatchCommandSliceReady,
      integrationCommandSliceReady,
      settingsCommandSliceReady,
      telegramCommandSliceReady,
      gitCommandSliceReady,
      workspaceGitCommandSliceReady,
      graphConversationCommandSliceReady,
      releaseUpdateReadOnlyReady,
      storageRecoveryDiagnosticCapabilityReady,
      releaseNotesEphemeralCapabilityReady,
      executionHostStopCommandSliceReady,
      executionHostHandoffControlCapabilityReady,
    }),
    ...scanIntegrationSecretRegistrations(file, content, integrationCommandSliceReady),
    ...scanGitProjectOperationRegistrations(file, content, gitCommandSliceReady),
    ...scanProviderHandoffs(file, content, { piProviderCommandSliceReady, codexProviderCommandSliceReady }),
  );
}

entries.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.id.localeCompare(right.id));
const statusCounts = countBy(entries, (entry) => entry.status);
const kindCounts = countBy(entries, (entry) => entry.kind);
const pending = entries.filter(
  (entry) =>
    entry.status !== 'integrated' &&
    entry.status !== 'read_only' &&
    entry.status !== 'read_only_external_probe' &&
    entry.status !== 'ephemeral_capability' &&
    entry.status !== 'diagnostic_capability' &&
    entry.status !== 'handoff_control_capability',
);
const conversationRoute = entries.find((entry) => entry.kind === 'http_mutator' && entry.operation === 'POST /api/projects/:projectId/conversations/:conversationId/messages');
const conversationProviderWrite = entries.find(
  (entry) => entry.kind === 'provider_handover' && entry.file === 'packages/local-server/src/codexNativeConversationCoordinator.ts' && entry.operation === 'manager.startTurn' && entry.status === 'integrated',
);
const conversationCoordinator = await readFile(join(sourceRoot, 'codexNativeConversationCoordinator.ts'), 'utf8');
const sliceMarkersPresent = ['commandDeliveries.acceptAndPrepare(', 'bindCommandDelivery(', 'markProviderWriteStarted(', "'outcome_unknown_after_write'"].every((marker) => conversationCoordinator.includes(marker));
const conversationRoutePath = "'/api/projects/:projectId/conversations/:conversationId/messages'";
const conversationRouteOffset = conversationDispatchCommandRoutes.indexOf(conversationRoutePath);
const conversationRouteEnd = conversationRouteOffset < 0 ? -1 : conversationDispatchCommandRoutes.indexOf('\n  server.', conversationRouteOffset + conversationRoutePath.length);
const conversationRouteBlock = conversationRouteOffset < 0 ? '' : conversationDispatchCommandRoutes.slice(conversationRouteOffset, conversationRouteEnd < 0 ? undefined : conversationRouteEnd);
const conversationHelperOffset = localServerComposition.indexOf('async function acceptNativeConversationMessage(');
const conversationHelperEnd = conversationHelperOffset < 0 ? -1 : localServerComposition.indexOf('\n  async function ', conversationHelperOffset + 1);
const conversationHelperBlock = conversationHelperOffset < 0 ? '' : localServerComposition.slice(conversationHelperOffset, conversationHelperEnd < 0 ? undefined : conversationHelperEnd);
const routeWiring = {
  routeRegistered: conversationRouteOffset >= 0,
  routeInvokesApplicationHelper: conversationRouteBlock.includes('application.executeExternal({') && conversationRouteBlock.includes('operations.message('),
  helperCreatesSegmentLifecycle: conversationHelperBlock.includes('conversationExecutionCoordinator.createLifecycle('),
  helperInvokesCodexCoordinator: conversationHelperBlock.includes('codexNativeCoordinator.'),
};
const conversationSliceReady = conversationRoute?.status === 'integrated' && Boolean(conversationProviderWrite) && sliceMarkersPresent && Object.values(routeWiring).every(Boolean);

const inventory = {
  schemaVersion: 1,
  generatedFrom: {
    root: 'packages/local-server/src',
    sha256: sourceHash.digest('hex'),
  },
  scope: {
    included: ['Local Server POST/PUT/PATCH/DELETE registration sites', 'Codex/Pi Provider mutating adapter calls'],
    excludedCoveredByIndependentAudits: [
      { scope: 'Electron Main IPC and OS bridges', gate: 'scripts/audit-electron-main-side-effect-entries.mjs' },
      { scope: 'Git/Core/background Worker internal callsites without a public adapter boundary', gate: 'scripts/audit-internal-side-effect-entries.ts --require-complete' },
    ],
  },
  summary: {
    total: entries.length,
    byKind: kindCounts,
    byStatus: statusCounts,
    complete: pending.length === 0,
    conversationVerticalSliceReady: conversationSliceReady,
  },
  verification: {
    conversationVerticalSlice: {
      ...routeWiring,
      coordinatorHasDurabilityMarkers: sliceMarkersPresent,
      providerTurnStartClassifiedIntegrated: Boolean(conversationProviderWrite),
    },
    providerRuntimeRecoveryVerticalSlice: {
      ...providerRuntimeRecoveryMarkers,
      routeClassifiedIntegrated: entries.some((entry) => entry.operation === 'POST /api/provider-runtimes/pi/recover' && entry.status === 'integrated'),
    },
    piProviderCommandVerticalSlice: {
      ...piProviderCommandMarkers,
      fiveProviderWritesClassifiedIntegrated: entries.filter((entry) => entry.file === 'packages/local-server/src/piNativeConversationCoordinator.ts' && entry.status === 'integrated').length === 5,
    },
    codexProviderCommandVerticalSlice: {
      ...codexProviderCommandMarkers,
      allDiscoveredProviderWritesClassifiedIntegrated: entries.filter((entry) => entry.kind === 'provider_handover' && entry.file.includes('/codex')).every((entry) => entry.status === 'integrated'),
    },
    codexPublicCommandVerticalSlice: {
      ...codexPublicCommandMarkers,
      discoveredRouteCount: entries.filter((entry) => entry.file === 'packages/local-server/src/codexPublicCommandRoutes.ts' && entry.kind === 'http_mutator').length,
      structurallyIntegratedRouteCount: entries.filter((entry) => entry.file === 'packages/local-server/src/codexPublicCommandRoutes.ts' && entry.kind === 'http_mutator' && entry.status === 'integrated').length,
      pairingStatus: {
        ...codexPairingStatusReadOnlyMarkers,
        classifiedReadOnly: entries.some((entry) => entry.operation === 'POST /api/codex/remote-control/pairing/status' && entry.status === 'read_only'),
      },
    },
    memoryCommandVerticalSlice: {
      ...memoryCommandMarkers,
      threeMemoryWritesClassifiedIntegrated: [...memoryCommandRouteStatus.values()].every((status) => status === 'integrated'),
      preview: {
        ...memoryPreviewReadOnlyMarkers,
        classifiedReadOnly: entries.some((entry) => entry.operation === 'POST /api/projects/:projectId/tasks/:taskId/context/preview' && entry.status === 'read_only'),
      },
    },
    commandCenterCommandVerticalSlice: {
      ...commandCenterCommandMarkers,
      discoveredRouteCount: entries.filter((entry) => entry.file === 'packages/local-server/src/commandCenter.ts' && entry.kind === 'http_mutator').length,
      structurallyIntegratedRouteCount: entries.filter((entry) => entry.file === 'packages/local-server/src/commandCenter.ts' && entry.kind === 'http_mutator' && entry.status === 'integrated').length,
      allDiscoveredRoutesClassifiedIntegrated: entries.filter((entry) => entry.file === 'packages/local-server/src/commandCenter.ts' && entry.kind === 'http_mutator').every((entry) => entry.status === 'integrated'),
    },
    workManagementCommandVerticalSlice: {
      ...workManagementCommandMarkers,
      ...workManagementCoreRouteMarkers,
      ...workManagementTaskCommandMarkers,
      structurallyIntegratedRouteCount: entries.filter((entry) => isLocalServerRouteAssemblyFile(entry.file) && entry.kind === 'http_mutator' && entry.commandBoundary?.startsWith('work_management')).length,
      extractedCoreRouteCount: entries.filter((entry) => entry.file === 'packages/local-server/src/workManagementCoreCommandRoutes.ts' && entry.kind === 'http_mutator' && entry.status === 'integrated').length,
      extractedTaskRouteCount: entries.filter((entry) => entry.file === 'packages/local-server/src/workManagementTaskCommandRoutes.ts' && entry.kind === 'http_mutator' && entry.status === 'integrated').length,
      projectArchiveConfirmationReadOnly,
      taskEventFileProjectionReady,
      taskStatusPostCommitBoundary: entries.find((entry) => entry.operation === 'PATCH /api/tasks/:taskId/status')?.status ?? 'missing',
    },
    runtimeSessionCommandVerticalSlice: {
      ...runtimeSessionCommandMarkers,
      discoveredRouteCount: entries.filter((entry) => entry.file === 'packages/local-server/src/runtimeSessionCommandRoutes.ts' && entry.kind === 'http_mutator').length,
      integratedRouteCount: entries.filter((entry) => entry.file === 'packages/local-server/src/runtimeSessionCommandRoutes.ts' && entry.status === 'integrated').length,
      ephemeralCapabilityRouteCount: entries.filter((entry) => entry.file === 'packages/local-server/src/runtimeSessionCommandRoutes.ts' && entry.status === 'ephemeral_capability').length,
      taskLinkPostCommitBoundary: entries.find((entry) => entry.operation === 'POST /api/runtime/sessions/:sessionId/tasks')?.status ?? 'missing',
    },
    conversationConfigurationLifecycleCommandVerticalSlice: {
      ...conversationCommandMarkers,
      discoveredRegistrationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/conversationCommandRoutes.ts' && entry.kind === 'http_mutator').length,
      integratedRegistrationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/conversationCommandRoutes.ts' && entry.status === 'integrated').length,
      coveredCommandTypeCount: 11,
      excludedBoundaries: ['Git', 'settings'],
    },
    conversationDispatchQueueCommandVerticalSlice: {
      ...conversationDispatchCommandMarkers,
      discoveredRegistrationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/conversationDispatchCommandRoutes.ts' && entry.kind === 'http_mutator').length,
      integratedRegistrationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/conversationDispatchCommandRoutes.ts' && entry.status === 'integrated').length,
      coveredCommandTypeCount: conversationDispatchCommandTypeValues.length,
      coreRegistrationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/conversationDispatchCommandRoutes.ts' && entry.commandBoundary?.includes('Core fact')).length,
      externalRegistrationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/conversationDispatchCommandRoutes.ts' && entry.commandBoundary?.includes('external operation')).length,
      excludedBoundaries: ['Git', 'Work Management', 'settings', 'security', 'model configuration', 'Zentao', 'release', 'Execution Host'],
    },
    integrationCredentialsAndModelConfigurationCommandVerticalSlice: {
      ...integrationCommandMarkers,
      discoveredRegistrationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/integrationCommandRoutes.ts' && entry.kind === 'http_mutator').length,
      integratedExternalOperationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/integrationCommandRoutes.ts' && entry.status === 'integrated' && entry.commandBoundary?.includes('external operation')).length,
      integratedCoreApplicationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/integrationCommandRoutes.ts' && entry.status === 'integrated' && entry.commandBoundary?.includes('Core application')).length,
      readOnlyExternalProbeCount: entries.filter((entry) => entry.file === 'packages/local-server/src/integrationCommandRoutes.ts' && entry.status === 'read_only_external_probe').length,
      allExpectedOperationsDiscovered: integrationCommandOperations.every(([operation]) => entries.some((entry) => entry.file === 'packages/local-server/src/integrationCommandRoutes.ts' && entry.operation === operation)),
      excludedBoundaries: ['general runtime settings', 'app shell settings', 'task integration Git workspaces', 'Telegram polling lifecycle'],
    },
    settingsImportAndCacheCommandVerticalSlice: {
      ...settingsCommandMarkers,
      discoveredRegistrationCount: entries.filter((entry) => isLocalServerRouteAssemblyFile(entry.file) && settingsCommandOperations.some(([operation]) => operation === entry.operation)).length,
      integratedExternalOperationCount: entries.filter(
        (entry) => isLocalServerRouteAssemblyFile(entry.file) && settingsCommandOperations.some(([operation, , classification]) => operation === entry.operation && classification === 'external') && entry.status === 'integrated',
      ).length,
      integratedCoreApplicationCount: entries.filter(
        (entry) => isLocalServerRouteAssemblyFile(entry.file) && settingsCommandOperations.some(([operation, , classification]) => operation === entry.operation && classification === 'core') && entry.status === 'integrated',
      ).length,
      allExpectedOperationsDiscovered: settingsCommandOperations.every(([operation]) => entries.some((entry) => isLocalServerRouteAssemblyFile(entry.file) && entry.operation === operation)),
      exactClassification: '7 external_operation + 3 core_application',
      realKeychainValidation: false,
    },
    telegramSecurityAndPollingCommandVerticalSlice: {
      ...telegramCommandMarkers,
      discoveredRegistrationCount: entries.filter((entry) => telegramCommandOperations.includes(entry.operation) && (isLocalServerRouteAssemblyFile(entry.file) || entry.file === 'packages/local-server/src/telegramPollingApi.ts')).length,
      integratedExternalOperationCount: entries.filter((entry) => telegramCommandOperations.includes(entry.operation) && entry.status === 'integrated' && entry.commandBoundary?.includes('Telegram external operation')).length,
      integratedCoreApplicationCount: entries.filter((entry) => telegramCommandOperations.includes(entry.operation) && entry.status === 'integrated' && entry.commandBoundary?.includes('Telegram Core application')).length,
      allExpectedOperationsDiscovered: telegramCommandOperations.every((operation) => entries.some((entry) => entry.operation === operation && entry.status === 'integrated')),
      exactClassification: '10 external_operation + 1 core_application',
      realTelegramAndKeychainValidation: false,
    },
    gitCommandVerticalSlice: {
      ...gitCommandMarkers,
      discoveredRegistrationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/gitCommandRoutes.ts' && entry.kind === 'http_mutator').length,
      integratedExternalOperationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/gitCommandRoutes.ts' && entry.status === 'integrated').length,
      ephemeralConfirmationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/gitCommandRoutes.ts' && entry.status === 'ephemeral_capability').length,
      allExpectedOperationsDiscovered: gitCommandOperations.every((operation) => entries.some((entry) => entry.file === 'packages/local-server/src/gitCommandRoutes.ts' && entry.operation === operation)),
      excludedBoundaries: ['Electron Main IPC Git', 'project workbench actions', 'task git-workspaces', 'task integration', 'settings'],
    },
    workspaceGitCommandVerticalSlice: {
      ...workspaceGitCommandMarkers,
      discoveredRegistrationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/workspaceGitCommandRoutes.ts' && entry.kind === 'http_mutator').length,
      integratedExternalOperationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/workspaceGitCommandRoutes.ts' && entry.status === 'integrated').length,
      allExpectedOperationsDiscovered: workspaceGitCommandOperations.every((operation) => entries.some((entry) => entry.file === 'packages/local-server/src/workspaceGitCommandRoutes.ts' && entry.operation === operation)),
      exactClassification: '16 external_operation',
      excludedBoundaries: ['formal Git command routes', 'project database secret/config/scan', 'settings', 'release', 'Execution Host'],
    },
    graphConversationCreateCommandVerticalSlice: {
      ...graphConversationCommandMarkers,
      discoveredRegistrationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/graphConversationCommandRoutes.ts' && entry.kind === 'http_mutator').length,
      integratedExternalOperationCount: entries.filter((entry) => entry.file === 'packages/local-server/src/graphConversationCommandRoutes.ts' && entry.status === 'integrated').length,
      allExpectedOperationsDiscovered: graphConversationCommandOperations.every((operation) => entries.some((entry) => entry.file === 'packages/local-server/src/graphConversationCommandRoutes.ts' && entry.operation === operation)),
      exactClassification: '6 external_operation',
      excludedBoundaries: ['project database/config/secret', 'settings/import', 'Telegram/security', 'work management', 'Git/runtime/integration'],
    },
    releaseUpdateReadOnlyCompatibilityRoutes: {
      implementationEvidenceReady: releaseUpdateReadOnlyReady,
      classifiedReadOnlyCount: entries.filter((entry) => entry.file === 'packages/local-server/src/releaseUpdateApi.ts' && entry.status === 'read_only').length,
      boundary: 'manifest/network query only; download/install remain accepted=false and invoke no filesystem or process mutation',
    },
    storageRecoveryDiagnosticCapability: {
      implementationEvidenceReady: storageRecoveryDiagnosticCapabilityReady,
      classifiedDiagnosticCapability: entries.some((entry) => entry.operation === 'POST /api/diagnostics/storage/recovery-preflight' && entry.status === 'diagnostic_capability'),
      boundary: 'works while Command WAL is faulted; only safely repeatable SQLite and Artifact staging probes; no business fact',
    },
    releaseNotesEphemeralCapability: {
      implementationEvidenceReady: releaseNotesEphemeralCapabilityReady,
      classifiedEphemeralCapability: entries.some((entry) => entry.operation === 'POST /api/command-runs/:runId/release-notes' && entry.status === 'ephemeral_capability'),
      boundary: 'one-shot bearer capability; 10 minute TTL; 256-entry hard capacity; no durable replay or Command WAL; provider prompt capped at 400000 characters',
    },
    executionHostStopCommandVerticalSlice: {
      ...executionHostStopCommandMarkers,
      classifiedIntegrated: entries.some((entry) => entry.file === 'packages/local-server/src/executionHostControlApi.ts' && entry.operation === 'POST /api/execution-host/stop-active' && entry.status === 'integrated'),
      boundary: 'Main creates one immutable command; detached /work/stop and embedded HTTP preserve it; external_operation marker precedes one parallel Provider interrupt; local interrupted/cancelled facts persist before force quit',
    },
    executionHostHandoffControlCapability: {
      implementationEvidenceReady: executionHostHandoffControlCapabilityReady,
      classifiedHandoffControlCapability: entries.some((entry) => entry.operation === 'POST /api/execution-host/handoff/prepare' && entry.status === 'handoff_control_capability'),
      boundary: 'switches the Command Ledger single writer; durable execution_host_handoffs journal plus checkpoint hash and single-flight; general Command Ledger intentionally unavailable',
    },
  },
  semantics: {
    integrated: '统一 Command Inbox/Outbox/receipt 已覆盖该精确接管边界。',
    read_only: '实现级无写证据与显式只读声明同时成立；该入口不应建立 Command 账本。',
    read_only_external_probe: '外部网络探针不创建业务事实；仅允许进程内 TTL、硬容量和同身份去重，不写 Command Inbox/Outbox/Receipt。',
    ephemeral_capability: '高频租约或一次性短期安全能力使用 TTL、硬容量和单调序列或一次消费语义；仅在明确不要求 durable replay 时免建 Command WAL。',
    diagnostic_capability: '存储恢复诊断必须在 Command WAL 不可写时仍能执行；仅允许可重复探针，不创建业务事实。',
    handoff_control_capability: 'Execution Host 交接控制面负责冻结并切换 Command Ledger 单写入者；必须使用独立同库 journal/CAS，不能依赖正在冻结的通用 Command Ledger。',
    partial: '当前纵切已生成或消费命令身份，但公开入口尚未完整接收 Command Envelope。',
    pending: '尚未迁移；不得据此宣称 ZARCH-030/031 全量完成。',
  },
  entries,
};

process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);

if (requireConversationSlice && !conversationSliceReady) {
  process.stderr.write('Command side-effect gate failed: conversation submission -> Codex turn/start vertical slice is incomplete.\n');
  process.exitCode = 2;
} else if (requireConversationCommandSlice && !conversationCommandSliceReady) {
  process.stderr.write('Command side-effect gate failed: Conversation configuration/lifecycle command slice is incomplete.\n');
  process.exitCode = 2;
} else if (
  requireConversationDispatchCommandSlice &&
  (!conversationDispatchCommandSliceReady || entries.filter((entry) => entry.file === 'packages/local-server/src/conversationDispatchCommandRoutes.ts' && entry.status === 'integrated').length !== 15)
) {
  process.stderr.write('Command side-effect gate failed: Conversation Dispatch/Queue slice must expose 15 integrated registrations covering 16 command types.\n');
  process.exitCode = 2;
} else if (
  requireIntegrationCommandSlice &&
  (!integrationCommandSliceReady ||
    entries.filter((entry) => entry.file === 'packages/local-server/src/integrationCommandRoutes.ts' && entry.status === 'integrated' && entry.commandBoundary?.includes('external operation')).length !== 13 ||
    entries.filter((entry) => entry.file === 'packages/local-server/src/integrationCommandRoutes.ts' && entry.status === 'integrated' && entry.commandBoundary?.includes('Core application')).length !== 1 ||
    entries.filter((entry) => entry.file === 'packages/local-server/src/integrationCommandRoutes.ts' && entry.status === 'read_only_external_probe').length !== 2)
) {
  process.stderr.write('Command side-effect gate failed: Integration slice must expose 13 external operations, 1 Core application, and 2 bounded read-only external probes.\n');
  process.exitCode = 2;
} else if (
  requireSettingsCommandSlice &&
  (!settingsCommandSliceReady ||
    entries.filter((entry) => isLocalServerRouteAssemblyFile(entry.file) && settingsCommandOperations.some(([operation, , classification]) => operation === entry.operation && classification === 'external') && entry.status === 'integrated')
      .length !== 7 ||
    entries.filter((entry) => isLocalServerRouteAssemblyFile(entry.file) && settingsCommandOperations.some(([operation, , classification]) => operation === entry.operation && classification === 'core') && entry.status === 'integrated')
      .length !== 3)
) {
  process.stderr.write('Command side-effect gate failed: Settings/import/cache slice must expose 7 external operations and 3 Core applications.\n');
  process.exitCode = 2;
} else if (
  requireTelegramCommandSlice &&
  (!telegramCommandSliceReady ||
    entries.filter((entry) => telegramCommandOperations.includes(entry.operation) && entry.status === 'integrated' && entry.commandBoundary?.includes('Telegram external operation')).length !== 10 ||
    entries.filter((entry) => telegramCommandOperations.includes(entry.operation) && entry.status === 'integrated' && entry.commandBoundary?.includes('Telegram Core application')).length !== 1)
) {
  process.stderr.write('Command side-effect gate failed: Telegram slice must expose 10 external operations and 1 Core application across all polling aliases.\n');
  process.exitCode = 2;
} else if (
  requireGitCommandSlice &&
  (!gitCommandSliceReady ||
    entries.filter((entry) => entry.file === 'packages/local-server/src/gitCommandRoutes.ts' && entry.status === 'integrated').length !== 9 ||
    entries.filter((entry) => entry.file === 'packages/local-server/src/gitCommandRoutes.ts' && entry.status === 'ephemeral_capability').length !== 3)
) {
  process.stderr.write('Command side-effect gate failed: Git command slice must expose 9 external operations and 3 ephemeral confirmations.\n');
  process.exitCode = 2;
} else if (
  requireWorkManagementTaskCommandSlice &&
  (!workManagementTaskCommandSliceReady ||
    entries.filter((entry) => entry.file === 'packages/local-server/src/workManagementTaskCommandRoutes.ts' && entry.status === 'integrated').length !== 7 ||
    ![...workManagementTaskRouteOperations].every((operation) => entries.some((entry) => entry.file === 'packages/local-server/src/workManagementTaskCommandRoutes.ts' && entry.operation === operation && entry.status === 'integrated')))
) {
  process.stderr.write('Command side-effect gate failed: Work Management task slice must expose exactly seven integrated Core/External operations.\n');
  process.exitCode = 2;
} else if (requireWorkspaceGitCommandSlice && (!workspaceGitCommandSliceReady || entries.filter((entry) => entry.file === 'packages/local-server/src/workspaceGitCommandRoutes.ts' && entry.status === 'integrated').length !== 16)) {
  process.stderr.write('Command side-effect gate failed: Workspace Git command slice must expose exactly 16 external operations.\n');
  process.exitCode = 2;
} else if (
  requireGraphConversationCreateCommandSlice &&
  (!graphConversationCommandSliceReady || entries.filter((entry) => entry.file === 'packages/local-server/src/graphConversationCommandRoutes.ts' && entry.status === 'integrated').length !== 6)
) {
  process.stderr.write('Command side-effect gate failed: Graph and conversation create slice must expose exactly 6 external operations.\n');
  process.exitCode = 2;
} else if (
  requireExecutionHostStopCommandSlice &&
  (!executionHostStopCommandSliceReady ||
    entries.filter((entry) => entry.file === 'packages/local-server/src/executionHostControlApi.ts' && entry.operation === 'POST /api/execution-host/stop-active' && entry.status === 'integrated').length !== 1)
) {
  process.stderr.write('Command side-effect gate failed: Execution Host stop-active must expose one integrated Main-to-Core external command boundary.\n');
  process.exitCode = 2;
} else if (requireComplete && pending.length > 0) {
  process.stderr.write(`Command side-effect gate failed closed: ${pending.length} entry point(s) are partial or pending.\n`);
  process.exitCode = 2;
}

function scanHttpMutators(file, content, context) {
  const matches = [];
  const pattern = /\b(?:options\.)?server\.(post|put|patch|delete)\s*\(\s*([`'"])(.*?)\2/gsu;
  for (const match of content.matchAll(pattern)) {
    const method = match[1].toUpperCase();
    const route = match[3].replace(/\s+/gu, ' ').trim();
    const operation = `${method} ${route}`;
    const line = lineNumber(content, match.index ?? 0);
    const isConversationMessage = operation === 'POST /api/projects/:projectId/conversations/:conversationId/messages';
    const isIntegratedProviderRuntimeRecovery = operation === 'POST /api/provider-runtimes/pi/recover' && context.providerRuntimeRecoverySliceReady;
    const memoryCommandStatus = file === 'packages/local-server/src/memoryContextApi.ts' ? context.memoryCommandRouteStatus.get(operation) : undefined;
    const isReadOnlyMemoryPreview = file === 'packages/local-server/src/memoryContextApi.ts' && operation === 'POST /api/projects/:projectId/tasks/:taskId/context/preview' && context.memoryPreviewReadOnly;
    const commandCenterEvidence = file === 'packages/local-server/src/commandCenter.ts' ? commandCenterRouteEvidence(content, match.index ?? 0, context.commandCenterCommandSliceReady) : null;
    const codexPublicEvidence = file === 'packages/local-server/src/codexPublicCommandRoutes.ts' ? codexPublicRouteEvidence(content, match.index ?? 0, context.codexPublicCommandSliceReady) : null;
    const workManagementEvidence = isLocalServerRouteAssemblyFile(file) ? workManagementRouteEvidence(content, match.index ?? 0, context.workManagementCommandSliceReady) : null;
    const workManagementCoreEvidence = file === 'packages/local-server/src/workManagementCoreCommandRoutes.ts' ? workManagementCoreRouteEvidence(content, match.index ?? 0, operation, context.workManagementCoreRoutesReady) : null;
    const workManagementProjectEvidence =
      file === 'packages/local-server/src/workManagementProjectCommandRoutes.ts' ? workManagementProjectRouteEvidence(content, match.index ?? 0, operation, context.workManagementProjectRoutesReady) : null;
    const workManagementTaskEvidence = file === 'packages/local-server/src/workManagementTaskCommandRoutes.ts' ? workManagementTaskRouteEvidence(content, match.index ?? 0, operation, context.workManagementTaskCommandSliceReady) : null;
    const runtimeSessionEvidence =
      file === 'packages/local-server/src/runtimeSessionCommandRoutes.ts' ? runtimeSessionRouteEvidence(content, match.index ?? 0, operation, context.runtimeSessionCommandSliceReady, context.taskEventFileProjectionReady) : null;
    const conversationCommandEvidence = file === 'packages/local-server/src/conversationCommandRoutes.ts' ? conversationCommandRouteEvidence(content, match.index ?? 0, context.conversationCommandSliceReady) : null;
    const conversationDispatchEvidence =
      file === 'packages/local-server/src/conversationDispatchCommandRoutes.ts' ? conversationDispatchCommandRouteEvidence(content, match.index ?? 0, operation, context.conversationDispatchCommandSliceReady) : null;
    const integrationCommandEvidence = file === 'packages/local-server/src/integrationCommandRoutes.ts' ? integrationCommandRouteEvidence(content, match.index ?? 0, operation, context.integrationCommandSliceReady) : null;
    const settingsCommandEvidence = isLocalServerRouteAssemblyFile(file) ? settingsCommandRouteEvidence(content, match.index ?? 0, operation, context.settingsCommandSliceReady) : null;
    const telegramCommandEvidence =
      isLocalServerRouteAssemblyFile(file) || file === 'packages/local-server/src/telegramPollingApi.ts' ? telegramCommandRouteEvidence(file, content, match.index ?? 0, operation, context.telegramCommandSliceReady) : null;
    const gitCommandEvidence = file === 'packages/local-server/src/gitCommandRoutes.ts' ? gitCommandRouteEvidence(content, match.index ?? 0, operation, context.gitCommandSliceReady) : null;
    const workspaceGitCommandEvidence = file === 'packages/local-server/src/workspaceGitCommandRoutes.ts' ? workspaceGitCommandRouteEvidence(content, match.index ?? 0, operation, context.workspaceGitCommandSliceReady) : null;
    const graphConversationCommandEvidence =
      file === 'packages/local-server/src/graphConversationCommandRoutes.ts' ? graphConversationCommandRouteEvidence(content, match.index ?? 0, operation, context.graphConversationCommandSliceReady) : null;
    const isReadOnlyCodexPairingStatus = file === 'packages/local-server/src/codexPublicCommandRoutes.ts' && operation === 'POST /api/codex/remote-control/pairing/status' && context.codexPairingStatusReadOnly;
    const isReadOnlyProjectArchiveConfirmation = file === 'packages/local-server/src/workManagementProjectCommandRoutes.ts' && operation === 'POST /api/projects/:projectId/archive-confirmation' && context.projectArchiveConfirmationReadOnly;
    const isReadOnlyReleaseUpdate = file === 'packages/local-server/src/releaseUpdateApi.ts' && releaseUpdateReadOnlyOperations.has(operation) && context.releaseUpdateReadOnlyReady;
    const isStorageRecoveryDiagnostic = file === 'packages/local-server/src/storageRecoveryPreflightApi.ts' && operation === 'POST /api/diagnostics/storage/recovery-preflight' && context.storageRecoveryDiagnosticCapabilityReady;
    const isReleaseNotesEphemeralCapability = isLocalServerRouteAssemblyFile(file) && operation === 'POST /api/command-runs/:runId/release-notes' && context.releaseNotesEphemeralCapabilityReady;
    const isExecutionHostStopCommand = file === 'packages/local-server/src/executionHostControlApi.ts' && operation === 'POST /api/execution-host/stop-active' && context.executionHostStopCommandSliceReady;
    const isExecutionHostHandoffControlCapability = file === 'packages/local-server/src/executionHostHandoffApi.ts' && operation === 'POST /api/execution-host/handoff/prepare' && context.executionHostHandoffControlCapabilityReady;
    const status =
      memoryCommandStatus ??
      (isStorageRecoveryDiagnostic
        ? 'diagnostic_capability'
        : isReleaseNotesEphemeralCapability
          ? 'ephemeral_capability'
          : isExecutionHostStopCommand
            ? 'integrated'
            : isExecutionHostHandoffControlCapability
              ? 'handoff_control_capability'
              : isReadOnlyMemoryPreview || isReadOnlyCodexPairingStatus || isReadOnlyProjectArchiveConfirmation || isReadOnlyReleaseUpdate
                ? 'read_only'
                : (graphConversationCommandEvidence?.status ??
                  workspaceGitCommandEvidence?.status ??
                  gitCommandEvidence?.status ??
                  telegramCommandEvidence?.status ??
                  settingsCommandEvidence?.status ??
                  integrationCommandEvidence?.status ??
                  conversationDispatchEvidence?.status ??
                  conversationCommandEvidence?.status ??
                  runtimeSessionEvidence?.status ??
                  workManagementProjectEvidence?.status ??
                  workManagementTaskEvidence?.status ??
                  workManagementCoreEvidence?.status ??
                  workManagementEvidence?.status ??
                  (isIntegratedProviderRuntimeRecovery || commandCenterEvidence?.integrated || codexPublicEvidence?.integrated ? 'integrated' : isConversationMessage ? 'partial' : 'pending')));
    matches.push({
      id: stableId('http_mutator', file, operation),
      kind: 'http_mutator',
      file,
      line,
      operation,
      status,
      commandBoundary:
        memoryCommandStatus === 'integrated'
          ? 'memory mutation / public {command,input} / core_application atomic Inbox-Outbox-accepted receipt / stable operation identity'
          : isStorageRecoveryDiagnostic
            ? 'storage recovery diagnostic / safely repeatable SQLite+Artifact probes / no business fact / Command WAL intentionally not required'
            : isReleaseNotesEphemeralCapability
              ? 'release notes generation / one-shot bearer capability / TTL+hard capacity / project-bound / no durable replay / no Command WAL'
              : isExecutionHostStopCommand
                ? 'execution host stop-active / Main-owned immutable {command,input} / detached+embedded identity preservation / external_operation write marker / four outcomes / unknown blocks replay / bounded receipt'
                : isExecutionHostHandoffControlCapability
                  ? 'execution host handoff prepare / same-SQLite durable journal+checkpoint CAS / single-flight / freezes general Command Ledger writer'
                  : graphConversationCommandEvidence?.boundary
                    ? graphConversationCommandEvidence.boundary
                    : workspaceGitCommandEvidence?.boundary
                      ? workspaceGitCommandEvidence.boundary
                      : gitCommandEvidence?.boundary
                        ? gitCommandEvidence.boundary
                        : telegramCommandEvidence?.boundary
                          ? telegramCommandEvidence.boundary
                          : settingsCommandEvidence?.boundary
                            ? settingsCommandEvidence.boundary
                            : integrationCommandEvidence?.boundary
                              ? integrationCommandEvidence.boundary
                              : conversationDispatchEvidence?.boundary
                                ? conversationDispatchEvidence.boundary
                                : conversationCommandEvidence?.boundary
                                  ? conversationCommandEvidence.boundary
                                  : runtimeSessionEvidence?.boundary
                                    ? runtimeSessionEvidence.boundary
                                    : workManagementProjectEvidence?.boundary
                                      ? workManagementProjectEvidence.boundary
                                      : workManagementTaskEvidence?.boundary
                                        ? workManagementTaskEvidence.boundary
                                        : workManagementCoreEvidence?.boundary
                                          ? workManagementCoreEvidence.boundary
                                          : codexPublicEvidence?.integrated
                                            ? codexPublicEvidence.boundary
                                            : workManagementEvidence?.boundary
                                              ? workManagementEvidence.boundary
                                              : commandCenterEvidence?.integrated
                                                ? commandCenterEvidence.boundary
                                                : isReadOnlyMemoryPreview || isReadOnlyCodexPairingStatus || isReadOnlyProjectArchiveConfirmation || isReadOnlyReleaseUpdate
                                                  ? 'explicit read_only declaration / implementation-level no-write evidence / Command ledger not applicable'
                                                  : isIntegratedProviderRuntimeRecovery
                                                    ? 'provider.runtime.pi.recover / public Command Envelope / single-writer Inbox-Outbox / four-outcome receipt'
                                                    : isConversationMessage
                                                      ? 'conversation.submission.dispatch is derived after request validation; client envelope migration remains pending'
                                                      : null,
    });
  }
  return matches;
}

/** 设置入口仍位于组合根；逐路由验证公开 Envelope 和真实 Core/External executor。 */
function settingsCommandRouteEvidence(content, routeOffset, operation, baseReady) {
  const expected = settingsCommandOperations.find(([candidate]) => candidate === operation);
  if (!baseReady || !expected) return { status: null, boundary: null };
  const [, commandName, classification] = expected;
  const nextRouteOffset = content.indexOf('\n  server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const evidenceBlock = commandName === 'projectionCacheClear' ? settingsCacheHelper : routeBlock;
  const consumesEnvelope = evidenceBlock.includes('SettingsCommandRequest<') && evidenceBlock.includes(`settingsCommandTypes.${commandName}`) && evidenceBlock.includes('settingsCommands.parse<');
  if (!consumesEnvelope) return { status: null, boundary: null };
  if (classification === 'core') {
    return evidenceBlock.includes('settingsCommands.executeCore({')
      ? { status: 'integrated', boundary: 'Settings Core application / public hash-only {command,input} / atomic business fact+Inbox-Outbox-accepted receipt / bounded evidence' }
      : { status: null, boundary: null };
  }
  return evidenceBlock.includes('settingsCommands.executeExternal({')
    ? {
        status: 'integrated',
        boundary: 'Settings external operation / stable child identity / durable write marker / four outcomes / ArtifactRef immutable replay / unknown blocks blind retry',
      }
    : { status: null, boundary: null };
}

/** Telegram 的六个设置/安全入口与五个 polling alias 必须逐项消费公开 Envelope。 */
function telegramCommandRouteEvidence(file, content, routeOffset, operation, baseReady) {
  if (!baseReady || !telegramCommandOperations.includes(operation)) return { status: null, boundary: null };
  if (file === 'packages/local-server/src/telegramPollingApi.ts') {
    const mapping = telegramPollingCommandOperations.find(([candidate]) => candidate === operation);
    if (!mapping) return { status: null, boundary: null };
    const commandName = mapping[1];
    const handler = commandName === 'pollingStart' ? telegramPollingStartHandler : commandName === 'pollingStop' ? telegramPollingStopHandler : telegramPollingOnceHandler;
    const ready = handler.includes(`telegramCommandTypes.${commandName}`) && handler.includes('options.application.executeExternal({') && handler.includes('TelegramCommandRequest<EmptyInput>');
    return ready
      ? {
          status: 'integrated',
          boundary: 'Telegram external operation / shared polling alias command type / durable write marker / bounded singleflight and capacity / unknown blocks blind retry',
        }
      : { status: null, boundary: null };
  }
  const mapping = telegramIndexCommandOperations.find(([candidate]) => candidate === operation);
  if (!mapping) return { status: null, boundary: null };
  const nextRouteOffset = content.indexOf('\n  server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const [, commandName, classification] = mapping;
  const consumesEnvelope = routeBlock.includes('TelegramCommandRequest<') && routeBlock.includes(`telegramCommandTypes.${commandName}`) && routeBlock.includes('telegramCommands.parse<');
  if (!consumesEnvelope) return { status: null, boundary: null };
  if (classification === 'core') {
    return routeBlock.includes('telegramCommands.executeCore({')
      ? {
          status: 'integrated',
          boundary: 'Telegram Core application / public hash-only {command,input} / atomic settings fact and accepted receipt / bounded redacted evidence',
        }
      : { status: null, boundary: null };
  }
  return routeBlock.includes('telegramCommands.executeExternal({')
    ? {
        status: 'integrated',
        boundary: 'Telegram external operation / public hash-only {command,input} / stable child identities / durable write marker / four outcomes / bounded redacted receipt',
      }
    : { status: null, boundary: null };
}

/**
 * Integration 直注册 handler 必须逐路由解析公开 Envelope，并按真实的 Core、External
 * 或只读网络探针执行器分类。目录名或统一 register 调用本身不能作为豁免。
 */
function integrationCommandRouteEvidence(content, routeOffset, operation, baseReady) {
  const expected = integrationCommandOperations.find(([candidate]) => candidate === operation);
  if (!baseReady || !expected) return { status: null, boundary: null };
  const nextRouteOffset = content.indexOf('\n  server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const commandName = expected[1];
  const consumesPublicEnvelope =
    routeBlock.includes('IntegrationCommandRequest<') && routeBlock.includes(`integrationCommandTypes.${commandName}`) && (routeBlock.includes('application.parse<') || routeBlock.includes('parseResourceCommand<'));
  if (!consumesPublicEnvelope) return { status: null, boundary: null };
  if (integrationReadOnlyProbeOperations.some(([candidate]) => candidate === operation)) {
    return routeBlock.includes('application.executeReadOnlyProbe({')
      ? {
          status: 'read_only_external_probe',
          boundary: 'Integration read-only external probe / public {command,input} / process-local TTL+capacity replay / no Command Inbox-Outbox-Receipt',
        }
      : { status: null, boundary: null };
  }
  if (integrationCoreCommandOperations.some(([candidate]) => candidate === operation)) {
    return routeBlock.includes('application.executeCore({') && routeBlock.includes('application.replayAcceptedCore<')
      ? {
          status: 'integrated',
          boundary: 'Integration Core application / public {command,input} / atomic business fact+Inbox-Outbox-accepted receipt / bounded inline evidence',
        }
      : { status: null, boundary: null };
  }
  return routeBlock.includes('application.executeExternal({')
    ? {
        status: 'integrated',
        boundary: 'Integration external operation / public {command,input} / durable write marker / conservative unknown / immutable ArtifactRef replay / bounded redacted error',
      }
    : { status: null, boundary: null };
}

/**
 * 四个 Secret 路由由两个动态 helper 注册；从每个调用点恢复精确 method、path、
 * commandType 与账号，避免把 `route.path` 或整个 security 目录当作审计豁免。
 */
function scanIntegrationSecretRegistrations(file, content, baseReady) {
  if (file !== 'packages/local-server/src/integrationCommandRoutes.ts') return [];
  const expected = new Map([
    ['PUT /api/security/secrets/telegram-bot-token', ['telegramBotTokenPut', 'telegram.botToken', 'token']],
    ['DELETE /api/security/secrets/telegram-bot-token', ['telegramBotTokenDelete', 'telegram.botToken', null]],
    ['PUT /api/security/secrets/external-api-key', ['externalApiKeyPut', 'external.apiKey', 'key']],
    ['DELETE /api/security/secrets/external-api-key', ['externalApiKeyDelete', 'external.apiKey', null]],
  ]);
  const matches = [];
  const pattern = /registerSecret(Put|Delete)Route\(options,\s*\{([\s\S]*?)\}\);/gu;
  for (const match of content.matchAll(pattern)) {
    const method = match[1] === 'Put' ? 'PUT' : 'DELETE';
    const registration = match[2];
    const path = /path:\s*'([^']+)'/u.exec(registration)?.[1] ?? '';
    const commandName = /commandType:\s*integrationCommandTypes\.(\w+)/u.exec(registration)?.[1] ?? '';
    const account = /account:\s*'([^']+)'/u.exec(registration)?.[1] ?? '';
    const inputKey = /inputKey:\s*'([^']+)'/u.exec(registration)?.[1] ?? null;
    const operation = `${method} ${path}`;
    const mapping = expected.get(operation);
    const helper = method === 'PUT' ? integrationSecretPutHelper : integrationSecretDeleteHelper;
    const helperReady =
      helper.includes(`options.server.${method === 'PUT' ? 'put' : 'delete'}(route.path`) &&
      helper.includes('parseResourceCommand<') &&
      helper.includes("'provider_account', route.account") &&
      helper.includes('options.application.executeExternal({') &&
      helper.includes('externalOperationId: externalOperationId(parsed)');
    const integrated = baseReady && helperReady && mapping?.[0] === commandName && mapping?.[1] === account && mapping?.[2] === inputKey;
    matches.push({
      id: stableId('http_mutator', file, operation),
      kind: 'http_mutator',
      file,
      line: lineNumber(content, match.index ?? 0),
      operation,
      status: integrated ? 'integrated' : 'pending',
      commandBoundary: integrated ? 'Integration secret external operation / public hash-only {command,input} identity / durable write marker / conservative unknown / non-secret ArtifactRef replay / plaintext redaction' : null,
    });
  }
  return matches;
}

/**
 * Project Git routes 通过带精确 path/commandType/operation 的注册调用生成；这里逐项解析
 * 七个静态注册，不能把动态 helper 或整个 Git 目录作为豁免。
 */
function scanGitProjectOperationRegistrations(file, content, baseReady) {
  if (file !== 'packages/local-server/src/gitCommandRoutes.ts') return [];
  const expected = new Map([
    ['/api/projects/:projectId/git/branch', ['projectBranch', 'branch']],
    ['/api/projects/:projectId/git/checkout', ['projectCheckout', 'switch_branch']],
    ['/api/projects/:projectId/git/commit', ['projectCommit', 'commit']],
    ['/api/projects/:projectId/git/stash', ['projectStash', 'stash']],
    ['/api/projects/:projectId/git/apply-stash', ['projectApplyStash', 'apply_stash']],
    ['/api/projects/:projectId/git/pull', ['projectPull', 'pull']],
    ['/api/projects/:projectId/git/push', ['projectPush', 'push']],
  ]);
  const matches = [];
  const pattern = /registerProjectOperation\(\{[^;]*?path:\s*'([^']+)'\s*,\s*commandType:\s*gitCommandTypes\.(\w+)\s*,\s*operation:\s*'([^']+)'\s*\}\);/gsu;
  for (const match of content.matchAll(pattern)) {
    const [path, commandName, operationName] = match.slice(1);
    const mapping = expected.get(path);
    const integrated = baseReady && mapping?.[0] === commandName && mapping?.[1] === operationName;
    matches.push({
      id: stableId('http_mutator', file, `POST ${path}`),
      kind: 'http_mutator',
      file,
      line: lineNumber(content, match.index ?? 0),
      operation: `POST ${path}`,
      status: integrated ? 'integrated' : 'pending',
      commandBoundary: integrated ? 'Git project operation / public {command,input} / one-shot confirmation / external_operation write marker / unknown blocks replay / ArtifactRef result' : null,
    });
  }
  return matches;
}

/** Git 的三个确认入口是短时安全能力；两个直接执行入口委托到统一 External helper。 */
function gitCommandRouteEvidence(content, routeOffset, operation, baseReady) {
  if (!baseReady) return { status: null, boundary: null };
  const nextRouteOffset = content.indexOf('\n  server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const consumesEnvelope = routeBlock.includes('GitCommandMutationRequest<') && routeBlock.includes('application.parse<');
  if (operation.startsWith('POST /api/git/confirmations')) {
    const ephemeral = consumesEnvelope && routeBlock.includes('confirmationCapabilities.execute(') && !routeBlock.includes('application.executeExternal(');
    return ephemeral ? { status: 'ephemeral_capability', boundary: 'Git confirmation / stable {command,input} identity / TTL+capacity / bounded replay / one-shot consumption / no Command WAL' } : { status: null, boundary: null };
  }
  const external = (operation === 'POST /api/git/operations' || operation === 'POST /api/tasks/:taskId/git/rollback') && consumesEnvelope && routeBlock.includes('executeConfirmedOperation(');
  return external ? { status: 'integrated', boundary: 'Git external operation / stable confirmation identity / durable write marker / conservative unknown / ArtifactRef immutable replay' } : { status: null, boundary: null };
}

/** Workspace Git 的 16 个入口只允许委托到同一个严格 Envelope 与 External 执行器。 */
function workspaceGitCommandRouteEvidence(content, routeOffset, operation, baseReady) {
  if (!baseReady || !workspaceGitCommandOperations.includes(operation)) return { status: null, boundary: null };
  const nextRouteOffset = content.indexOf('\n  server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const executeHelper = sourceBlock(content, 'async function execute<TParams extends Record<string, string>', '\n\n  function executePrepared');
  const preparedHelper = sourceBlock(content, 'function executePrepared<TInput extends object>', '\n  }\n}');
  const delegatesPublicEnvelope =
    routeBlock.includes('WorkspaceGitMutationRequest<') &&
    routeBlock.includes('execute(request, reply') &&
    executeHelper.includes('options.application.parse<TInput>({') &&
    executeHelper.includes('options.operations.prepare({') &&
    executeHelper.includes('executePrepared(parsed, prepared)') &&
    preparedHelper.includes('options.application.executeExternal({');
  return delegatesPublicEnvelope
    ? {
        status: 'integrated',
        boundary: 'Workspace Git external operation / public immutable {command,input} / true task-workspace-integration scope / durable write marker / four outcomes / ArtifactRef replay / unknown blocks blind retry',
      }
    : { status: null, boundary: null };
}

/** 会话首发与 Graph 六入口必须逐项消费公开 Envelope，并统一进入 External Application。 */
function graphConversationCommandRouteEvidence(content, routeOffset, operation, baseReady) {
  if (!baseReady || !graphConversationCommandOperations.includes(operation)) return { status: null, boundary: null };
  const nextRouteOffset = content.indexOf('\n  server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const projectScanHelper = sourceBlock(content, 'async function executeProjectScan(', '\n\n  function sendRouteError');
  const expectedCommandName = new Map([
    ['POST /api/projects/:projectId/conversations', 'projectConversationCreate'],
    ['POST /api/tasks/:taskId/conversations', 'taskConversationCreate'],
    ['POST /api/projects/:projectId/scan', 'projectGraphScan'],
    ['POST /api/projects/:projectId/graph/views/generate', 'projectGraphViewsGenerate'],
    ['POST /api/projects/:projectId/ask', 'projectGraphAsk'],
    ['POST /api/graph/scan-current', 'currentGraphScan'],
  ]).get(operation);
  if (!expectedCommandName || !routeBlock.includes(`graphConversationCommandTypes.${expectedCommandName}`)) return { status: null, boundary: null };
  const delegatedScan =
    (operation === 'POST /api/projects/:projectId/scan' || operation === 'POST /api/projects/:projectId/graph/views/generate') &&
    routeBlock.includes('executeProjectScan(request, reply,') &&
    projectScanHelper.includes('application.parse<EmptyInput>({') &&
    projectScanHelper.includes('application.executeExternal({') &&
    projectScanHelper.includes('mutateAcceptedBusinessState:') &&
    projectScanHelper.includes('mutateFailureBusinessState:');
  const directExternal = routeBlock.includes('GraphConversationMutationRequest<') && routeBlock.includes('application.parse<') && routeBlock.includes('application.executeExternal({') && routeBlock.includes('externalOperationId(');
  if (!delegatedScan && !directExternal) return { status: null, boundary: null };
  return {
    status: 'integrated',
    boundary:
      operation === 'POST /api/projects/:projectId/scan' || operation === 'POST /api/projects/:projectId/graph/views/generate' || operation === 'POST /api/graph/scan-current'
        ? 'Graph scan external operation / public immutable {command,input} / stable Worker operation / pre-write singleflight / accepted Core scan status plus receipt / ArtifactRef / unknown blocks replay'
        : operation.endsWith('/conversations')
          ? 'Conversation create external operation / public immutable {command,input} / stable conversation-submission-provider child identities / write marker / four outcomes / ArtifactRef replay'
          : 'Graph ask external operation / public immutable {command,input} / stable conversation-submission-runtime child identities / write marker / four outcomes / ArtifactRef replay',
  };
}

/**
 * Conversation Dispatch/Queue 路由必须逐 handler 消费公开 Envelope。resume/recover
 * 只允许委托到同模块的统一 External helper；同一个 registration 覆盖 undo/reapply 两种稳定 commandType。
 */
function conversationDispatchCommandRouteEvidence(content, routeOffset, operation, baseReady) {
  const nextRouteOffset = content.indexOf('\n  server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const consumesPublicEnvelope = routeBlock.includes('ConversationDispatchMutationRequest<') && routeBlock.includes('request');
  const directParse =
    routeBlock.includes('application.parse<') ||
    routeBlock.includes('parseConversationCommand(request,') ||
    routeBlock.includes('parseSubmissionCommand(request,') ||
    routeBlock.includes('parseTurnCommand(request,') ||
    routeBlock.includes('parseRequestCommand(request,');
  const directCore = routeBlock.includes('application.executeCore({');
  const directExternal = routeBlock.includes('application.executeExternal({');
  const externalHelper = sourceBlock(content, 'async function executeConversationExternal(', '\n\n  function afterCore(');
  const delegatedExternal =
    routeBlock.includes('executeConversationExternal(request, reply,') &&
    externalHelper.includes('parseConversationCommand(request, commandType)') &&
    externalHelper.includes('application.executeExternal({') &&
    externalHelper.includes('externalOperationId: `${externalOperationId}:${parsed.operationIdentity}`');
  if (!baseReady || !consumesPublicEnvelope || (!delegatedExternal && (!directParse || (!directCore && !directExternal)))) return { status: null, boundary: null };
  return {
    status: 'integrated',
    boundary: directCore
      ? 'conversation queue/request Core fact / public {command,input} / atomic Inbox-Outbox-business-receipt / bounded immutable replay'
      : `conversation dispatch external operation / ${operation.includes('change-set') ? 'stable file journal' : 'stable Provider child identity'} / write marker / four outcomes / ArtifactRef replay / unknown blocks blind retry`,
  };
}

/**
 * Conversation 配置与生命周期路由按 handler 的真实 Envelope 类型、稳定 commandType 与
 * Core/External Application 调用分类；archive/restore 只允许委托到同模块的统一 lifecycle helper。
 */
function conversationCommandRouteEvidence(content, routeOffset, baseReady) {
  const nextRouteOffset = content.indexOf('\n  server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const consumesPublicEnvelope = routeBlock.includes('Body: ConversationMutationRequest<') && routeBlock.includes('request');
  const parsesStableCommand = routeBlock.includes('parseCommand(request,') && routeBlock.includes('conversationCommandTypes.');
  const coreApplication = routeBlock.includes('application.executeCore({');
  const externalOperation = routeBlock.includes('application.executeExternal({');
  const lifecycleHelper = sourceBlock(content, 'async function executeLifecycle(', '\n\n  function parseCommand');
  const delegatedLifecycle =
    routeBlock.includes('executeLifecycle(request, reply,') &&
    lifecycleHelper.includes('parseCommand(request,') &&
    lifecycleHelper.includes('conversationCommandTypes.archive') &&
    lifecycleHelper.includes('conversationCommandTypes.restore') &&
    lifecycleHelper.includes('application.executeCore({') &&
    lifecycleHelper.includes('application.executeExternal({');
  if (!baseReady || !consumesPublicEnvelope || (!delegatedLifecycle && (!parsesStableCommand || (!coreApplication && !externalOperation)))) return { status: null, boundary: null };
  return {
    status: 'integrated',
    boundary: delegatedLifecycle
      ? 'conversation lifecycle / public {command,input} / legacy Core atomic receipt or native external_operation write marker / four outcomes / bounded immutable replay'
      : externalOperation
        ? 'conversation provider command / public {command,input} / external_operation write marker / four outcomes / bounded immutable replay / unknown blocks blind retry'
        : 'conversation configuration / public {command,input} / core_application atomic Inbox-Outbox-business-receipt / bounded immutable replay',
  };
}

/** Runtime 路由按真实 handler 的 durable command 或 ephemeral capability 协议分类。 */
function runtimeSessionRouteEvidence(content, routeOffset, operation, baseReady, taskEventProjectionReady) {
  if (!baseReady) return { status: null, boundary: null };
  const nextRouteOffset = content.indexOf('\n  server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const confirmationRoute = operation.startsWith('POST /api/runtime/confirmations');
  if (confirmationRoute && routeBlock.includes('RuntimeSessionMutationRequest<') && routeBlock.includes('application.parse<') && routeBlock.includes('confirmationReplay.')) {
    return { status: 'ephemeral_capability', boundary: 'runtime confirmation / stable {command,input} request identity / TTL+capacity / bounded immutable replay / no Command WAL' };
  }
  const leaseIssue = operation === 'POST /api/runtime/sessions/:sessionId/capabilities/ephemeral' && routeBlock.includes('ephemeralCapabilities.issue(');
  const highFrequency = (operation === 'POST /api/runtime/sessions/:sessionId/input' || operation === 'POST /api/runtime/sessions/:sessionId/resize') && routeBlock.includes('ephemeralCapabilities.execute<');
  if (leaseIssue || highFrequency) {
    return { status: 'ephemeral_capability', boundary: 'runtime input/resize / session lease / monotonic sequence / bounded dedupe / no synchronous Command WAL' };
  }
  let consumesEnvelope = routeBlock.includes('RuntimeSessionMutationRequest<') && (routeBlock.includes('application.parse<') || routeBlock.includes('parseEmptySessionCommand('));
  const externalOperation = routeBlock.includes('application.executeExternal');
  let coreApplication = routeBlock.includes('application.executeCore');
  if (operation === 'POST /api/runtime/sessions/:sessionId/archive' || operation === 'POST /api/runtime/sessions/:sessionId/restore') {
    const helper = sourceBlock(content, 'async function executeArchiveRestore(', "\n\n  server.post('/api/runtime/sessions/:sessionId/tasks'");
    consumesEnvelope = routeBlock.includes('RuntimeSessionMutationRequest<') && routeBlock.includes('executeArchiveRestore(') && helper.includes('parseEmptySessionCommand(');
    coreApplication = routeBlock.includes('executeArchiveRestore(') && helper.includes('application.executeCore');
  }
  if (!consumesEnvelope || (!externalOperation && !coreApplication)) return { status: null, boundary: null };
  const recordsProjectedTaskEvent = operation === 'POST /api/runtime/sessions/:sessionId/tasks' && routeBlock.includes('recordTaskEvent(');
  return {
    status: recordsProjectedTaskEvent && !taskEventProjectionReady ? 'partial' : 'integrated',
    boundary: recordsProjectedTaskEvent
      ? taskEventProjectionReady
        ? 'runtime core_application atomic business+receipt+task_event projection outbox / SQLite authority / async idempotent JSONL diagnostic projection'
        : 'runtime core_application atomic business+receipt; task event JSONL projection outbox remains incomplete'
      : externalOperation
        ? 'runtime external_operation / stable process identity / durable write marker / four outcomes / unknown blocks blind replay'
        : 'runtime core_application atomic Inbox-Outbox-business-receipt / immutable replay result',
  };
}

/** Work Management 路由必须在真实 handler 消费公开 Envelope 并进入 Core/External Application。 */
function workManagementRouteEvidence(content, routeOffset, baseReady) {
  const openParenthesis = content.indexOf('(', routeOffset);
  const closeParenthesis = matchingParenthesis(content, openParenthesis);
  const routeBlock = content.slice(routeOffset, closeParenthesis < 0 ? undefined : closeParenthesis + 1);
  const consumesPublicEnvelope = routeBlock.includes('Body: WorkManagementMutationRequest<') && routeBlock.includes('request.body');
  const parsesStableCommand = routeBlock.includes('workManagementCommands.parse<') && routeBlock.includes('workManagementCommandTypes.');
  const coreApplication = routeBlock.includes('workManagementCommands.executeCore({');
  const externalOperation = routeBlock.includes('workManagementCommands.executeExternal({');
  if (!baseReady || !consumesPublicEnvelope || !parsesStableCommand || (!coreApplication && !externalOperation)) return { status: null, boundary: null };
  const hasUngovernedPostCommitEffect = routeBlock.includes('projectionDatabases.enqueueIndexWrite(') || routeBlock.includes('notifyTelegramTaskStatus(');
  return {
    status: hasUngovernedPostCommitEffect ? 'partial' : 'integrated',
    boundary: hasUngovernedPostCommitEffect
      ? 'work_management core_application atomic Inbox-Outbox-business-receipt; projection or Telegram post-commit effect remains pending'
      : externalOperation
        ? 'work_management external_operation stable identity / durable write marker / four outcomes / immutable replay result'
        : 'work_management core_application atomic Inbox-Outbox-business-receipt / immutable replay result',
  };
}

/** 第二波七路由必须由抽离模块逐项声明稳定 Command；按真实 Core/External 边界精确分类。 */
function workManagementTaskRouteEvidence(content, routeOffset, operation, baseReady) {
  if (!baseReady || !workManagementTaskRouteOperations.has(operation)) return { status: null, boundary: null };
  const nextRouteOffset = content.indexOf('\n  options.server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const expectedCommandType = new Map([
    ['PATCH /api/tasks/:taskId/status', 'taskStatusUpdate'],
    ['PATCH /api/tasks/:taskId/management-status', 'taskManagementStatusUpdate'],
    ['POST /api/projects/:projectId/task-board/moves', 'taskBoardMove'],
    ['POST /api/tasks/:taskId/run', 'taskRun'],
    ['POST /api/tasks/:taskId/pause', 'taskPause'],
    ['POST /api/tasks/:taskId/continue', 'taskContinue'],
    ['POST /api/tasks/:taskId/cancel', 'taskCancel'],
  ]).get(operation);
  if (!expectedCommandType || !routeBlock.includes(`workManagementCommandTypes.${expectedCommandType}`)) return { status: null, boundary: null };
  if (operation === 'PATCH /api/tasks/:taskId/status') {
    if (!routeBlock.includes('options.application.executeCore({') || !routeBlock.includes('enqueueTaskStatusTelegramEffectInCurrentTransaction({')) return { status: null, boundary: null };
    return {
      status: 'integrated',
      boundary: 'work_management task status core_application / atomic Task fact + TaskEvent projection outbox + accepted receipt + prepared Telegram child command / graph rebuildable after-commit projection',
    };
  }
  if (operation === 'PATCH /api/tasks/:taskId/management-status' || operation === 'POST /api/projects/:projectId/task-board/moves') {
    if (!routeBlock.includes('if (!prepared.requiresExternal)') || !routeBlock.includes('options.application.executeCore({') || !routeBlock.includes('options.application.executeExternal({')) {
      return { status: null, boundary: null };
    }
    return {
      status: 'integrated',
      boundary: 'work_management conditional Core/external operation / pure fact atomic receipt / cleanup or restore write marker / four outcomes / unknown blocks replay',
    };
  }
  if (!workManagementTaskRoutes.includes('function runtimeHandler<') || !workManagementTaskRoutes.includes('options.application.executeExternal({')) return { status: null, boundary: null };
  return {
    status: 'integrated',
    boundary: 'work_management task Runtime external_operation / stable operation identity / durable write marker / four outcomes / accepted fact+receipt transaction / unknown blocks replay',
  };
}

/** 抽离路由只在逐项消费公开 Envelope、委托统一 Core helper 且整个 10 路纵切结构证据齐全时放行。 */
function workManagementCoreRouteEvidence(content, routeOffset, operation, baseReady) {
  if (!baseReady || !workManagementCoreRouteOperations.has(operation)) return { status: null, boundary: null };
  const nextRouteOffset = content.indexOf('\n  options.server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const consumesPublicEnvelope = routeBlock.includes('Body: WorkManagementMutationRequest<') && routeBlock.includes('request.body');
  const entersCoreApplication = routeBlock.includes('executeCoreRoute<') || routeBlock.includes('executeTaskCreationRoute<');
  const declaresStableCommandType = routeBlock.includes('workManagementCommandTypes.');
  if (!consumesPublicEnvelope || !entersCoreApplication || !declaresStableCommandType) return { status: null, boundary: null };
  return {
    status: 'integrated',
    boundary: 'work_management extracted core route / public immutable {command,input} / atomic Inbox-Outbox-business-receipt / bounded replay result / durable task-event projection outbox',
  };
}

/** 项目写入口必须统一进入 Work Management Core application；archive-confirmation 单独按只读能力核验。 */
function workManagementProjectRouteEvidence(content, routeOffset, operation, baseReady) {
  if (!baseReady || !workManagementProjectRouteOperations.has(operation)) return { status: null, boundary: null };
  const nextRouteOffset = content.indexOf('\n  options.server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const directCreate = operation === 'POST /api/projects';
  const entersCoreApplication = directCreate
    ? routeBlock.includes('options.application.parse<') && routeBlock.includes('options.application.executeCore({')
    : content.includes('function registerProjectMutation(') && content.includes('options.application.executeCore({');
  if (!entersCoreApplication) return { status: null, boundary: null };
  return {
    status: 'integrated',
    boundary: 'work_management project core_application / public immutable {command,input} / atomic Inbox-Outbox-business-receipt / bounded replay result / after-commit projection',
  };
}

/**
 * 不按 URL 白名单放行：从每个 Command Center 路由的真实 handler 解析它调用的 Application method，
 * 再要求该 method 同时具备 Envelope parse 与 Core/External 协议调用证据。
 */
function commandCenterRouteEvidence(content, routeOffset, baseReady) {
  const nextRouteOffset = content.indexOf('\n  options.server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const method = routeBlock.match(/runCommandRoute\(reply,\s*\(\)\s*=>\s*(\w+)\(/su)?.[1];
  if (!method) return { integrated: false, boundary: null };
  const methodBlock = localFunctionBlock(content, method);
  const consumesPublicEnvelope = routeBlock.includes('Body: CommandCenterMutationRequest<') && routeBlock.includes('request.body');
  const parsesStableCommand = methodBlock.includes('commandApplication.parse<') && methodBlock.includes('commandCenterCommandTypes.');
  const coreApplication = methodBlock.includes('commandApplication.executeCore({');
  const externalOperation = methodBlock.includes('commandApplication.prepareExternal<') && methodBlock.includes('commandApplication.markExternalWriteStarted(') && methodBlock.includes('commandApplication.resolveExternal({');
  const integrated = baseReady && consumesPublicEnvelope && parsesStableCommand && (coreApplication || externalOperation);
  return {
    integrated,
    boundary: integrated
      ? externalOperation
        ? `${method} / public {command,input} / external_operation stable identity / durable write marker / four outcomes / immutable replay result`
        : `${method} / public {command,input} / core_application atomic Inbox-Outbox-business-receipt / immutable replay result`
      : null,
  };
}

/** Codex 公开入口必须从真实 handler 消费 Envelope 并进入 External Operation Application。 */
function codexPublicRouteEvidence(content, routeOffset, baseReady) {
  const nextRouteOffset = content.indexOf('\n  server.', routeOffset + 1);
  const routeBlock = content.slice(routeOffset, nextRouteOffset < 0 ? undefined : nextRouteOffset);
  const consumesPublicEnvelope = routeBlock.includes('Body: CodexPublicMutationRequest<') && routeBlock.includes('request.body');
  const directApplication = routeBlock.includes('application.parse<') && routeBlock.includes('codexPublicCommandTypes.') && routeBlock.includes('application.executeExternal({');
  const toggleHelper = sourceBlock(content, 'async function executeRemoteToggle(', "\n\n  server.post('/api/codex/remote-control/pairing'");
  const delegatedToggle =
    routeBlock.includes('executeRemoteToggle(request.body, reply,') &&
    toggleHelper.includes('application.parse<') &&
    toggleHelper.includes('codexPublicCommandTypes.remoteControlEnable') &&
    toggleHelper.includes('codexPublicCommandTypes.remoteControlDisable') &&
    toggleHelper.includes('application.executeExternal({');
  const integrated = baseReady && consumesPublicEnvelope && (directApplication || delegatedToggle);
  return {
    integrated,
    boundary: integrated ? 'Codex public {command,input} / true provider scope / external_operation / durable write marker / four outcomes / ArtifactRef immutable replay' : null,
  };
}

function localFunctionBlock(content, name) {
  const marker = `async function ${name}(`;
  const start = content.indexOf(marker);
  if (start < 0) return '';
  const searchFrom = start + marker.length;
  const candidates = [content.indexOf('\n  async function ', searchFrom), content.indexOf('\n  function ', searchFrom)].filter((offset) => offset >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : content.length;
  return content.slice(start, end);
}

function scanProviderHandoffs(file, content, context) {
  const matches = [];
  const pattern =
    /\b(?:(options|input)\.manager\.(respondToServerRequest|setThreadGoal|clearThreadGoal|startThread|startTurn|steerTurn|interruptTurn|archiveThread|unarchiveThread)|(driver)\.(openSession|startRun|steerRun|interruptRun|closeSession))\s*\(/gsu;
  const dispatchStart = file === 'packages/local-server/src/codexNativeConversationCoordinator.ts' ? content.indexOf('async function dispatchSubmissionWithLease(') : -1;
  const dispatchEnd = dispatchStart >= 0 ? content.indexOf('\n  function attachDispatchLifecycle(', dispatchStart) : -1;
  for (const match of content.matchAll(pattern)) {
    const offset = match.index ?? 0;
    const owner = match[3] ? 'driver' : 'manager';
    const method = match[4] ?? match[2];
    const operation = `${owner}.${method}`;
    const integratedCodexTurnStart = file === 'packages/local-server/src/codexNativeConversationCoordinator.ts' && operation === 'manager.startTurn' && offset > dispatchStart && offset < dispatchEnd;
    const integratedCodexApplicationWrite = context.codexProviderCommandSliceReady && isCodexApplicationWrappedCall(file, content, offset);
    const integratedPiProviderWrite = file === 'packages/local-server/src/piNativeConversationCoordinator.ts' && context.piProviderCommandSliceReady;
    matches.push({
      id: stableId('provider_handover', file, `${operation}:${lineNumber(content, offset)}`),
      kind: 'provider_handover',
      file,
      line: lineNumber(content, offset),
      operation,
      status: integratedCodexTurnStart || integratedCodexApplicationWrite || integratedPiProviderWrite ? 'integrated' : 'pending',
      commandBoundary: integratedCodexApplicationWrite
        ? codexCommandBoundary(method)
        : integratedCodexTurnStart
          ? 'conversation.submission.dispatch / durable write marker / four-outcome receipt'
          : integratedPiProviderWrite
            ? method === 'openSession'
              ? 'provider.pi.session.open / provider_session / native session receipt / durable write marker / four outcomes'
              : `provider.pi.${method === 'startRun' ? 'run.start' : method === 'steerRun' ? 'run.steer' : 'run.interrupt'} / provider_turn / native session+run receipt / durable write marker / four outcomes`
            : null,
    });
  }
  return matches;
}

function isCodexApplicationWrappedCall(file, content, offset) {
  const wrappers =
    file === 'packages/local-server/src/codexNativeConversationCoordinator.ts'
      ? ['providerCommands.executeSession({', 'providerCommands.executeTurn({', 'executeSessionCommand({', 'executeTurnCommand({']
      : file === 'packages/local-server/src/codexGoalApplication.ts'
        ? ['execute({']
        : file === 'packages/local-server/src/codexDynamicToolApplication.ts'
          ? ['options.providerCommands.executeTurn({']
          : file === 'packages/local-server/src/codexProviderEventProjection.ts'
            ? ['executeTurnCommand({']
            : file === 'packages/local-server/src/codexPortableContextCompaction.ts'
              ? ['input.providerCommands.executeSession({', 'input.providerCommands\n      .executeSession({', 'input.providerCommands\n      .executeTurn({']
              : [];
  return wrappers.some((marker) => callRangeContains(content, marker, offset));
}

function callRangeContains(content, marker, targetOffset) {
  let markerOffset = content.lastIndexOf(marker, targetOffset);
  while (markerOffset >= 0) {
    const openParenthesis = content.indexOf('(', markerOffset);
    const closeParenthesis = matchingParenthesis(content, openParenthesis);
    if (openParenthesis >= 0 && closeParenthesis > targetOffset) return true;
    markerOffset = content.lastIndexOf(marker, markerOffset - 1);
  }
  return false;
}

function matchingParenthesis(content, openOffset) {
  if (openOffset < 0 || content[openOffset] !== '(') return -1;
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = openOffset; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === '\\') index += 1;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === "'" || current === '"' || current === '`') {
      quote = current;
      continue;
    }
    if (current === '(') depth += 1;
    if (current === ')' && --depth === 0) return index;
  }
  return -1;
}

function codexCommandBoundary(method) {
  const sessionMethod = method === 'startThread' || method === 'setThreadGoal' || method === 'clearThreadGoal' || method === 'archiveThread' || method === 'unarchiveThread';
  const operation =
    method === 'startThread'
      ? 'thread.start'
      : method === 'setThreadGoal'
        ? 'goal.set'
        : method === 'clearThreadGoal'
          ? 'goal.clear'
          : method === 'archiveThread'
            ? 'thread.archive'
            : method === 'unarchiveThread'
              ? 'thread.unarchive'
              : method === 'startTurn'
                ? 'turn.start'
                : method === 'steerTurn'
                  ? 'turn.steer'
                  : method === 'interruptTurn'
                    ? 'turn.interrupt'
                    : 'server_request.response';
  return `provider.codex.${operation} / ${sessionMethod ? 'provider_session / native thread receipt' : 'provider_turn / native thread+turn receipt'} / durable write marker / four outcomes`;
}

function sourceBlock(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  if (start < 0) return '';
  const end = content.indexOf(endMarker, start + startMarker.length);
  return content.slice(start, end < 0 ? undefined : end);
}

function stableId(kind, file, identity) {
  return `${kind}_${createHash('sha256').update(`${file}\0${identity}`).digest('hex').slice(0, 20)}`;
}

function lineNumber(content, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (content.charCodeAt(index) === 10) line += 1;
  return line;
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = selector(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function collectTypeScriptFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collectTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(path);
  }
  return result;
}
