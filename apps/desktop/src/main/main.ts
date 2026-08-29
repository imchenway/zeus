import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, session, shell, Tray } from 'electron';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { constants as fsConstants, existsSync, type FSWatcher, mkdtempSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { access, appendFile, chmod, copyFile, cp, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { type BeforeQuitCleanupFailureAction, createBeforeQuitCleanupHandler } from './beforeQuitCleanup.js';
import type { DesktopLocalServerRuntime, ExecutionHostMaintenanceStatus } from './localServerRuntime.js';
import { createStartupCoordinator } from './startupCoordinator.js';
import { createRendererBootstrapMonitor } from './rendererBootstrapMonitor.js';
import { exportMermaidDiagramToFile, exportPlantUmlDiagramToFile } from './mermaidExport.js';
import { exportPatchToFile } from './patchExport.js';
import { exportRuntimeLogsToFile } from './runtimeLogExport.js';
import { chooseProjectDirectory } from './projectDirectoryPicker.js';
import { exportSettingsSnapshotToFile, importBusinessDataSnapshotFromFile, importSettingsSnapshotFromFile } from './settingsPortability.js';
import { type GraphSourceLocation, openGraphSourceLocation } from './sourceOpen.js';
import { buildAppShellMenuTemplate, buildLoginItemSettings, buildMenuBarTrayTemplate, type MainAppShellSettings, shouldQuitWhenAllWindowsClosed, shouldUseSystemNotifications } from './appShellPolicy.js';
import { createSystemNotificationBridge, type SystemNotificationBridge } from './systemNotifications.js';
import { openLocalLogDirectory } from './localLogDirectory.js';
import { openExternalHttpsUrl } from './externalOpen.js';
import { readSessionViewCache, writeSessionViewCache } from './sessionViewCache.js';
import type { ZentaoExtractServices } from './zentaoTaskExtract.js';
import { extractZentaoTaskInfo } from './zentaoTaskExtract.js';
import {
  createPersistedMainWindowState,
  defaultMainWindowSize,
  findSavedWindowDisplay,
  minimumMainWindowSize,
  type PersistedMainWindowState,
  readPersistedMainWindowState,
  type ResolvedMainWindowState,
  resolveMainWindowState,
  writePersistedMainWindowState,
} from './windowState.js';
import { applyRestoredMainWindowPlacement, createWindowStatePersistenceGate, waitForSavedWindowDisplay, type WindowStatePersistenceGate } from './windowRestoration.js';
import { resolveTestDisplayPlacement } from './testDisplayPlacement.js';
import {
  buildTaskAttachmentPreviewDataUrl,
  coerceTaskClipboardAttachmentBuffer,
  inferTaskClipboardAttachmentMimeType,
  readTaskClipboardAttachmentsFromClipboard,
  readTaskClipboardFileReferencesFromClipboard,
  type TaskClipboardAttachmentPayload,
} from './taskClipboard.js';
import { type BrowserHost, createBrowserHost } from './browserHost.js';
import { type ConversationResourceRequest, listConversationResourceOpenTargets, openConversationResource, type OpenConversationResourceRequest, openTurnChangeFile, type OpenTurnChangeFileRequest } from './conversationResourceOpen.js';
import {
  type ConversationInputResourceBroker,
  type ConversationInputResourceSource,
  type ConversationResourcePayload,
  createConversationInputResourceBroker,
  readOrCreateConversationAttachmentGrantSecret,
} from './conversationInputResources.js';
import { cleanupStaleReleaseBackups, createReleaseUpdateService, type ReleaseUpdateService } from './releaseUpdateService.js';
import { createHomebrewUpdateService } from './homebrewUpdateService.js';
import { createHomebrewUpdateController, type HomebrewUpdateController, type HomebrewUpdateIndicatorState } from './homebrewUpdateController.js';
import { type AutomaticUpdateScheduler, createAutomaticUpdateScheduler } from './automaticUpdateScheduler.js';
import { createZeusDataLayout, type ZeusDataLayout } from '@zeus/local-server/zeus-data-layout';
import { readUnifiedConversationStoreMigrationStatus } from '@zeus/local-server';
import { prepareZeusDataRoot } from './zeusDataMigration.js';
import { loadDesktopReadOnlyValidationDescriptor, readOnlyValidationManifestEnvironmentName, verifyDesktopReadOnlyValidationDescriptor } from './readOnlyValidationManifest.js';
import { installReadOnlyValidationIpcFence } from './readOnlyValidationIpcFence.js';
import { ProjectSourceWorkspaceService } from './projectSourceWorkspace.js';
import { type ProjectGitProjectIdentity, ProjectGitWorkbenchService } from './projectGitWorkbench.js';
import { ElectronRecoveryBackupDestinationPort } from './recoveryBackupDestinationPort.js';
import {
  type CreateProjectSourceEntryInput,
  type MoveProjectSourceEntryInput,
  type ReadOnlyValidationDescriptor,
  type SaveProjectSourceFileInput,
  type TrashProjectSourceEntryInput,
  type ZentaoInstanceRecord,
  zentaoSecretAccount,
} from '@zeus/shared';
import { createMacOSKeychainStore } from '@zeus/security-core';
import { resolveDesktopKeychainService } from './secretServiceIdentity.js';
import { createSystemMainCommandEnvelope, MainCommandLedger, type MainCommandRequest } from './mainCommandLedger.js';
import { StorageRecoveryRestartCoordinator } from './storageRecoveryRestartCoordinator.js';
import { assertTestDataRootIsolation } from './testDataRootIsolation.js';
import { expectedBundleIdForDataRootProfile, readAndVerifyZeusDataRootIdentity, zeusDataRootHostIdentity, type ZeusDataRootIdentityMarker, type ZeusDataRootProfile } from './dataRootIdentity.js';

let mainWindow: BrowserWindow | undefined;
const windows = new Set<BrowserWindow>();
let tray: Tray | undefined;
let menuBarUsageWindow: BrowserWindow | undefined;
let menuBarUsageWindowBlurTimer: ReturnType<typeof setTimeout> | undefined;
const taskGitDeliveryWindows = new Map<string, BrowserWindow>();
const projectGitDiffWindows = new Set<BrowserWindow>();
const taskGitDeliveryTaskByWindowId = new Map<number, string>();
const taskGitDeliveryWindowSaveTimers = new Map<number, ReturnType<typeof setTimeout>>();
const taskGitDeliveryWindowPersistenceGates = new Map<number, WindowStatePersistenceGate>();
const mainWindowTaskGitContexts = new Map<number, TaskGitDeliveryCurrentContext>();
type SessionContextKind = 'browser' | 'subagents' | 'plan' | 'source' | 'turn_diff' | 'none';
const sessionContextActivityByWindow = new Map<number, { active: boolean; kind: SessionContextKind }>();
const appCloseLayerActivityByWindow = new Map<number, boolean>();
let currentTaskGitDeliveryContext: TaskGitDeliveryCurrentContext = { taskId: null, workspaceId: null };
let menuBarUsageMenu: Menu | undefined;
let localServerRuntime: DesktopLocalServerRuntime | undefined;
let resolveRendererRuntimeReady!: (runtime: DesktopLocalServerRuntime) => void;
let rejectRendererRuntimeReady!: (error: unknown) => void;
const rendererRuntimeReady = new Promise<DesktopLocalServerRuntime>((resolve, reject) => {
  resolveRendererRuntimeReady = resolve;
  rejectRendererRuntimeReady = reject;
});
// 启动失败会由统一致命错误流程退出；提前挂接拒绝处理，避免没有 Renderer 等待时产生未处理拒绝。
void rendererRuntimeReady.catch(() => undefined);
let executionHostMaintenance: ExecutionHostMaintenanceStatus | null = null;
let resolveRendererStartupDisposition!: () => void;
let rejectRendererStartupDisposition!: (error: unknown) => void;
const rendererStartupDisposition = new Promise<void>((resolve, reject) => {
  resolveRendererStartupDisposition = resolve;
  rejectRendererStartupDisposition = reject;
});
void rendererStartupDisposition.catch(() => undefined);
let releaseUpdateService: ReleaseUpdateService | undefined;
let homebrewUpdateController: HomebrewUpdateController | undefined;
let automaticUpdateScheduler: AutomaticUpdateScheduler | undefined;
let automaticUpdateIndicatorState: HomebrewUpdateIndicatorState | undefined;
let browserHost: BrowserHost | undefined;
let conversationInputResources: ConversationInputResourceBroker | undefined;
let systemNotificationBridge: SystemNotificationBridge | undefined;
let zeusDataRootPath: string | undefined;
let zeusDataLayout: ZeusDataLayout | undefined;
let zeusDataRootIdentity: ZeusDataRootIdentityMarker | undefined;
let dataRootPreparationError: unknown;
let readOnlyValidationDescriptor: ReadOnlyValidationDescriptor | undefined;
let projectSourceWorkspace: ProjectSourceWorkspaceService | undefined;
let projectGitWorkbench: ProjectGitWorkbenchService | undefined;
let mainCommandLedger: MainCommandLedger | undefined;
const recoveryBackupDestinationPort = new ElectronRecoveryBackupDestinationPort();
let fatalStartup = false;
const applicationStartupStartedAt = performance.now();
function traceApplicationStartup(stage: string): void {
  if (process.env.ZEUS_STARTUP_TIMING !== '1') return;
  console.info(`[Zeus app startup] ${stage} ${Math.round(performance.now() - applicationStartupStartedAt)}ms`);
}

function activeMainCommandLedger(): MainCommandLedger {
  if (readOnlyValidationDescriptor) {
    throw Object.assign(new Error('只读验证模式禁止创建 Main Command ledger。'), {
      code: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
      statusCode: 503,
    });
  }
  mainCommandLedger ??= new MainCommandLedger({ root: join(activeZeusDataLayout().root, 'main-command-ledger-v1') });
  return mainCommandLedger;
}
traceApplicationStartup('main_module_loaded');
let appShellSettings: MainAppShellSettings = {
  appLanguage: 'zh-CN',
  webviewDebugEnabled: false,
  multiWindowEnabled: true,
  backgroundModeEnabled: true,
  desktopNotificationsEnabled: true,
  openAtLoginEnabled: false,
};
const manualWindowDragStates = new Map<number, { pointerX: number; pointerY: number; windowX: number; windowY: number }>();
const windowStateSaveTimers = new Map<number, ReturnType<typeof setTimeout>>();
const windowStateActivationTimers = new Map<number, ReturnType<typeof setTimeout>>();
const windowStatePersistenceGates = new Map<number, WindowStatePersistenceGate>();
const taskTableLayoutDirtyWindowIds = new Set<number>();
const unsavedChangeKeysByWindow = new Map<number, Set<string>>();
const sensitiveRequestDraftIdsByWindow = new Map<number, Set<string>>();
const taskTableLayoutCloseApprovedWindowIds = new Set<number>();
const pendingTaskTableLayoutWindowCloseIds = new Set<number>();
const projectSourceWatchers = new Map<number, { projectId: string; watcher: FSWatcher }>();
let taskTableLayoutQuitPending = false;
let taskTableLayoutQuitApproved = false;
let upgradeHandoffRequested = false;
let fullRestartRequested = false;
let fullRestartRelaunchScheduled = false;
let pendingUpgradeHandoff: {
  activate: () => void | Promise<void>;
  result: Promise<boolean>;
  resolve: (accepted: boolean) => void;
} | null = null;

/** 所有“重新启动”入口都必须经过 before-quit，完整关闭 Core 和子进程。 */
function requestFullAppRestart(): void {
  fullRestartRequested = true;
  taskTableLayoutQuitApproved = true;
  app.quit();
}

/**
 * Electron 的 app.relaunch() 在 Main 启动早期失败时可能只退出旧进程而没有拉起新进程。
 * 独立小进程等待当前 Main 真正退出后，再用当前可执行文件、参数和环境精确重启；
 * 这样新 Main 不会在旧单实例锁尚未释放时被误判为“第二实例”而退出。
 */
function scheduleExactAppRelaunchAfterCurrentProcessExit(): void {
  if (fullRestartRelaunchScheduled) return;
  fullRestartRelaunchScheduled = true;
  const relauncher = spawn(
    '/bin/sh',
    [
      '-c',
      'old_pid="$1"; shift; attempts=0; while kill -0 "$old_pid" 2>/dev/null && [ "$attempts" -lt 600 ]; do sleep 0.1; attempts=$((attempts + 1)); done; kill -0 "$old_pid" 2>/dev/null && exit 1; exec "$@"',
      'zeus-relaunch',
      String(process.pid),
      process.execPath,
      ...process.argv.slice(1),
    ],
    {
      detached: true,
      env: process.env,
      stdio: 'ignore',
    },
  );
  relauncher.unref();
}

/** 升级接力只登记为待确认；辅助程序必须等活动工作确认通过后才能真正武装。 */
function requestUpgradeHandoffQuit(activate: () => void | Promise<void>): Promise<boolean> {
  if (pendingUpgradeHandoff) return pendingUpgradeHandoff.result;
  let resolveDecision: (accepted: boolean) => void = () => undefined;
  const result = new Promise<boolean>((resolve) => {
    resolveDecision = resolve;
  });
  pendingUpgradeHandoff = { activate, result, resolve: resolveDecision };
  upgradeHandoffRequested = true;
  taskTableLayoutQuitApproved = true;
  setImmediate(() => app.quit());
  return result;
}

const storageRecoveryRestart = new StorageRecoveryRestartCoordinator();
const execFile = promisify(execFileCallback);
const windowStateSaveDelayMs = 250;
const windowStateActivationDelayMs = 500;
const savedDisplayAvailabilityTimeoutMs = 2_000;
const testDistributionName = 'Zeus Test';
const menuBarUsageWindowSize = { width: 360, height: 520 } as const;
const menuBarUsageWindowGap = 6;
const menuBarUsageWindowBlurDelayMs = 150;

type MenuBarUsageClickAnchor = {
  bounds: Electron.Rectangle;
  position: Electron.Point;
};

type MenuBarUsageWindowPlacement = {
  anchorSource: 'bounds' | 'position';
  display: Electron.Display;
  x: number;
  y: number;
};
const taskGitDeliveryMinimumSize = { width: 920, height: 640 } as const;
const automaticUpdateIntervalMs = 60 * 60_000;
const automaticUpdateInitialDelayMs = 15_000;

interface TaskGitDeliveryCurrentContext {
  taskId: string | null;
  workspaceId: string | null;
}

/** macOS 以应用是否活跃为准；其他平台退化为是否存在聚焦窗口。 */
function isZeusApplicationForeground(): boolean {
  if (process.platform === 'darwin') return app.isActive();
  return BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused());
}

/** 已读还要求当前 Renderer 所属窗口本身就是 Zeus 的前台窗口。 */
function isRequestingWindowForeground(window: BrowserWindow | null): boolean {
  return Boolean(window && !window.isDestroyed() && isZeusApplicationForeground() && window.isFocused());
}

function isTestDistribution(): boolean {
  if (!app.isPackaged) return false;
  const executablePath = process.execPath;
  return basename(executablePath, extname(executablePath)) === testDistributionName;
}

function desktopDisplayName(): string {
  return isTestDistribution() ? testDistributionName : 'Zeus';
}

function broadcastAutomaticUpdateIndicator(state: HomebrewUpdateIndicatorState): void {
  automaticUpdateIndicatorState = { ...state };
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send('zeus:automatic-update-indicator:changed', automaticUpdateIndicatorState);
  }
}

function automaticUpdateTiming(defaultValue: number, environmentName: 'ZEUS_AUTO_UPDATE_INTERVAL_MS' | 'ZEUS_AUTO_UPDATE_INITIAL_DELAY_MS', allowTestOverride: boolean): number {
  if (!allowTestOverride) return defaultValue;
  const value = Number(process.env[environmentName]);
  return Number.isSafeInteger(value) && value >= 250 ? value : defaultValue;
}

function handleAutomaticUpdateResume(): void {
  automaticUpdateScheduler?.checkIfDue();
}

function defaultTestDataRoot(): string {
  // 每个打包 App 的路径代表一个任务 worktree，按路径隔离后多个任务可以并行验收而不共享 SQLite。
  const appIdentity = resolve(process.execPath);
  const identityHash = createHash('sha256').update(appIdentity).digest('hex').slice(0, 16);
  return join(homedir(), '.zeus-test', `instance-${identityHash}`);
}

/**
 * 移除 Chromium Safe Storage 对 macOS 钥匙串的读取申请。
 * 用户已明确要求 Zeus 不再弹出 `@zeus/desktop Safe Storage` 授权框；
 * 代价是 Chromium profile 内依赖系统钥匙串加密的浏览器态会降级为 mock keychain。
 */
function disableChromiumSafeStorageKeychainPrompt(): void {
  if (process.platform !== 'darwin') return;
  app.commandLine.appendSwitch('use-mock-keychain');
}

disableChromiumSafeStorageKeychainPrompt();

function applyExplicitUserDataDirectory(): void {
  if (isTestDistribution()) app.setName(testDistributionName);

  const configured = process.env.ZEUS_USER_DATA_DIR?.trim();
  readOnlyValidationDescriptor = loadDesktopReadOnlyValidationDescriptor({
    manifestPath: process.env[readOnlyValidationManifestEnvironmentName],
    packaged: app.isPackaged,
    executablePath: process.execPath,
  });
  if (readOnlyValidationDescriptor) {
    if (!configured || resolve(configured) !== readOnlyValidationDescriptor.validationRoot) {
      throw Object.assign(new Error('只读验证要求 ZEUS_USER_DATA_DIR 与 manifest 的 validationRoot 完全一致。'), {
        code: 'ZEUS_READ_ONLY_VALIDATION_ROOT_MISMATCH',
        failClosed: true as const,
      });
    }
    applyReadOnlyValidationDataRoot(readOnlyValidationDescriptor);
    return;
  }
  if (configured) {
    const configuredRoot = isTestDistribution() ? assertTestDataRootIsolation({ requestedRoot: resolve(configured), homeDirectory: homedir(), appDataDirectory: app.getPath('appData') }) : resolve(configured);
    applyPreparedDataRoot(configuredRoot, [], knownProductionDataRoots());
    return;
  }

  const profileName = activeDataRootProfile();
  const target = join(homedir(), profileName === 'production' ? '.zeus' : profileName === 'test' ? defaultTestDataRoot() : '.zeus-development');
  const legacyCandidates = profileName === 'production' ? [join(app.getPath('appData'), '@zeus', 'desktop'), join(app.getPath('appData'), desktopDisplayName())].filter((path, index, paths) => paths.indexOf(path) === index) : [];
  const targetInitialized = profileName === 'production' ? existsSync(join(target, 'data', 'zeus.db')) || existsSync(join(target, 'zeus.db')) || existsSync(join(target, 'zeus.config.json')) : existsSync(target);
  const legacy = legacyCandidates.find((path) => existsSync(join(path, 'zeus.db')) || existsSync(join(path, 'zeus.config.json')));
  if (app.isPackaged && !targetInitialized && legacy) {
    // 跨根目录的原始递归复制无法与 WAL 写入、平铺/分层宿主身份及控制凭据做原子仲裁。
    // 兼容发布先继续使用唯一旧根；后续只允许显式维护流程通过 SQLite Backup API
    // 生成一致候选库、校验资产清单后再切换，启动链不再拷贝活动数据或 runtime token。
    applyPreparedDataRoot(legacy, [], [target, ...legacyCandidates]);
    return;
  }
  applyPreparedDataRoot(target, legacyCandidates, [target, ...legacyCandidates]);
}

function applyReadOnlyValidationDataRoot(descriptor: ReadOnlyValidationDescriptor): void {
  const layout = createZeusDataLayout(descriptor.validationRoot);
  if (layout.database !== descriptor.database.path) throw new Error('只读验证 manifest 与 Zeus 分层数据路径不一致。');
  const keychainService = resolveDesktopKeychainService({ profile: 'test', dataRootPath: layout.root });
  zeusDataRootIdentity = readAndVerifyZeusDataRootIdentity(layout.root, {
    profile: 'test',
    bundleId: expectedBundleIdForDataRootProfile('test'),
    keychainService,
  });
  zeusDataRootPath = layout.root;
  zeusDataLayout = layout;
  // 不调用 prepareZeusDataRoot：验证进程禁止迁移、chmod、复制或创建正式数据目录。
  app.setPath('userData', layout.electronUserData);
}

function applyPreparedDataRoot(root: string, legacyRoots: readonly string[] = [], knownProductionAdoptionRoots: readonly string[] = []): void {
  const profile = activeDataRootProfile();
  const keychainService = resolveDesktopKeychainService({ profile, dataRootPath: root });
  const preparation = prepareZeusDataRoot(root, legacyRoots, {
    profile,
    bundleId: expectedBundleIdForDataRootProfile(profile),
    keychainService,
    knownProductionAdoptionRoots,
  });
  zeusDataRootPath = preparation.layout.root;
  zeusDataLayout = preparation.layout;
  zeusDataRootIdentity = preparation.rootIdentity;
  app.setPath('userData', preparation.layout.electronUserData);
}

function activeZeusDataLayout(): ZeusDataLayout {
  if (!zeusDataLayout || !zeusDataRootPath) throw new Error('Zeus 本机数据目录尚未准备完成。');
  return zeusDataLayout;
}

function activeDataRootIdentity(): ZeusDataRootIdentityMarker {
  if (!zeusDataRootIdentity) throw new Error('Zeus 本机数据根身份尚未准备完成。');
  return zeusDataRootIdentity;
}

function activeDataRootProfile(): ZeusDataRootProfile {
  return isTestDistribution() ? 'test' : app.isPackaged ? 'production' : 'development';
}

function knownProductionDataRoots(): string[] {
  if (activeDataRootProfile() !== 'production') return [];
  return [join(homedir(), '.zeus'), join(app.getPath('appData'), '@zeus', 'desktop'), join(app.getPath('appData'), 'Zeus')].map((path) => resolve(path));
}

/** 正式版固定复用历史 `Zeus` service；Test 只按已规范化的数据根派生隔离 service。 */
function activeDesktopKeychainService(): string {
  return resolveDesktopKeychainService({
    profile: activeDataRootIdentity().profile,
    dataRootPath: activeZeusDataLayout().root,
  });
}

// 打包验收可用隔离资料目录运行，禁止污染用户正在使用的 Zeus 数据。
traceApplicationStartup('data_root_preparation_started');
try {
  applyExplicitUserDataDirectory();
  traceApplicationStartup('data_root_ready');
} catch (error) {
  dataRootPreparationError = error;
  // 数据根准备发生在 app.whenReady() 之前；这里不能把异常交给 Electron 的原生阻塞弹窗。
  // 使用一次性 Chromium profile 只承载统一“启动失败”页，绝不读写用户业务数据。
  const failureProfile = mkdtempSync(join(tmpdir(), 'zeus-startup-failure-'));
  app.setPath('userData', failureProfile);
  console.error('Zeus data root preparation failed', error);
}

function desktopRoot(): string {
  return process.env.ZEUS_DESKTOP_DIR ?? app.getAppPath();
}

function nativeUpdateProgressHelperPath(): string {
  const root = desktopRoot();
  if (app.isPackaged && basename(root) === 'app.asar') return join(dirname(root), 'app.asar.unpacked', 'dist', 'native', 'ZeusUpdateProgress');
  return join(root, 'dist', 'native', 'ZeusUpdateProgress');
}

function currentAppBundlePath(): string {
  let candidate = resolve(process.execPath);
  while (dirname(candidate) !== candidate) {
    if (candidate.endsWith('.app')) return candidate;
    candidate = dirname(candidate);
  }
  throw new Error('Zeus 无法定位当前 App bundle。');
}

function resolveMainProjectRoot(): string {
  // packaged App 从 Finder 启动时 process.cwd() 可能是 "/"；禁止把全局 scan-current 兜底到整机根目录。
  return process.env.ZEUS_PROJECT_ROOT ?? (app.isPackaged ? desktopRoot() : process.cwd());
}

function mainWindowStatePath(): string {
  return join(app.getPath('userData'), 'main-window-state.json');
}

function taskGitDeliveryWindowStatePath(): string {
  return join(app.getPath('userData'), 'task-git-delivery-window-state.json');
}

function persistTaskGitDeliveryWindowState(window: BrowserWindow): boolean {
  if (window.isDestroyed()) return false;
  const bounds = window.getNormalBounds();
  const state = createPersistedMainWindowState({
    bounds,
    display: screen.getDisplayMatching(bounds),
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen(),
  });
  if (!state || !writePersistedMainWindowState(taskGitDeliveryWindowStatePath(), state)) return false;
  taskGitDeliveryWindowPersistenceGates.get(window.id)?.markPersisted();
  return true;
}

function flushTaskGitDeliveryWindowState(window: BrowserWindow): void {
  const timer = taskGitDeliveryWindowSaveTimers.get(window.id);
  if (timer) clearTimeout(timer);
  taskGitDeliveryWindowSaveTimers.delete(window.id);
  if (!taskGitDeliveryWindowPersistenceGates.get(window.id)?.shouldPersist()) return;
  persistTaskGitDeliveryWindowState(window);
}

function scheduleTaskGitDeliveryWindowStateSave(window: BrowserWindow): void {
  if (!taskGitDeliveryWindowPersistenceGates.get(window.id)?.recordChange()) return;
  const pendingTimer = taskGitDeliveryWindowSaveTimers.get(window.id);
  if (pendingTimer) clearTimeout(pendingTimer);
  const timer = setTimeout(() => {
    taskGitDeliveryWindowSaveTimers.delete(window.id);
    persistTaskGitDeliveryWindowState(window);
  }, windowStateSaveDelayMs);
  timer.unref();
  taskGitDeliveryWindowSaveTimers.set(window.id, timer);
}

function registerTaskGitDeliveryWindowStatePersistence(window: BrowserWindow): void {
  const gate = createWindowStatePersistenceGate();
  taskGitDeliveryWindowPersistenceGates.set(window.id, gate);
  const scheduleSave = () => scheduleTaskGitDeliveryWindowStateSave(window);
  window.on('move', scheduleSave);
  window.on('resize', scheduleSave);
  window.on('maximize', scheduleSave);
  window.on('unmaximize', scheduleSave);
  window.on('enter-full-screen', scheduleSave);
  window.on('leave-full-screen', scheduleSave);
  window.on('close', () => flushTaskGitDeliveryWindowState(window));
  const timer = setTimeout(() => {
    if (!window.isDestroyed()) gate.activate();
  }, windowStateActivationDelayMs);
  timer.unref();
}

function persistMainWindowState(window: BrowserWindow): boolean {
  if (window.isDestroyed()) return false;
  const bounds = window.getNormalBounds();
  const display = screen.getDisplayMatching(bounds);
  const state = createPersistedMainWindowState({
    bounds,
    display,
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen(),
  });
  if (!state || !writePersistedMainWindowState(mainWindowStatePath(), state)) return false;
  windowStatePersistenceGates.get(window.id)?.markPersisted();
  return true;
}

function flushMainWindowState(window: BrowserWindow): void {
  const timer = windowStateSaveTimers.get(window.id);
  if (timer) clearTimeout(timer);
  windowStateSaveTimers.delete(window.id);
  if (!windowStatePersistenceGates.get(window.id)?.shouldPersist()) return;
  persistMainWindowState(window);
}

function scheduleMainWindowStateSave(window: BrowserWindow): void {
  if (!windowStatePersistenceGates.get(window.id)?.recordChange()) return;
  const pendingTimer = windowStateSaveTimers.get(window.id);
  if (pendingTimer) clearTimeout(pendingTimer);
  const timer = setTimeout(() => {
    windowStateSaveTimers.delete(window.id);
    persistMainWindowState(window);
  }, windowStateSaveDelayMs);
  timer.unref();
  windowStateSaveTimers.set(window.id, timer);
}

function registerMainWindowStatePersistence(window: BrowserWindow): void {
  windowStatePersistenceGates.set(window.id, createWindowStatePersistenceGate());
  const scheduleSave = () => scheduleMainWindowStateSave(window);
  window.on('move', scheduleSave);
  window.on('resize', scheduleSave);
  window.on('maximize', scheduleSave);
  window.on('unmaximize', scheduleSave);
  window.on('enter-full-screen', scheduleSave);
  window.on('leave-full-screen', scheduleSave);
  window.on('close', (event) => {
    flushMainWindowState(window);
    if (taskTableLayoutQuitApproved || taskTableLayoutCloseApprovedWindowIds.has(window.id) || !taskTableLayoutDirtyWindowIds.has(window.id)) return;
    event.preventDefault();
    pendingTaskTableLayoutWindowCloseIds.add(window.id);
    window.webContents.send('zeus:unsaved-changes-close-requested');
  });
}

function activateMainWindowStatePersistence(window: BrowserWindow): void {
  const pendingTimer = windowStateActivationTimers.get(window.id);
  if (pendingTimer) clearTimeout(pendingTimer);
  const timer = setTimeout(() => {
    windowStateActivationTimers.delete(window.id);
    if (!window.isDestroyed()) windowStatePersistenceGates.get(window.id)?.activate();
  }, windowStateActivationDelayMs);
  timer.unref();
  windowStateActivationTimers.set(window.id, timer);
}

async function resolveMainWindowStateForLaunch(persisted: PersistedMainWindowState | undefined): Promise<ResolvedMainWindowState> {
  const displays = screen.getAllDisplays();
  const requestedTestDisplayId = process.env.ZEUS_TEST_DISPLAY_ID;
  if (isTestDistribution() && requestedTestDisplayId !== undefined) {
    const placement = resolveTestDisplayPlacement({
      requestedDisplayId: requestedTestDisplayId,
      displays,
      primaryDisplayId: screen.getPrimaryDisplay().id,
      preferredSize: persisted?.bounds ?? defaultMainWindowSize,
      minimumSize: minimumMainWindowSize,
    });
    return {
      bounds: placement.bounds,
      isMaximized: false,
      isFullScreen: false,
      targetDisplayId: placement.targetDisplayId,
      matchedSavedDisplay: false,
      matchKind: 'first-launch',
    };
  }
  if (persisted && !findSavedWindowDisplay(persisted, displays)) {
    await waitForSavedWindowDisplay({
      persisted,
      getDisplays: () => screen.getAllDisplays(),
      subscribe: (listener) => {
        screen.on('display-added', listener);
        screen.on('display-metrics-changed', listener);
        return () => {
          screen.off('display-added', listener);
          screen.off('display-metrics-changed', listener);
        };
      },
      timeoutMs: savedDisplayAvailabilityTimeoutMs,
    });
  }
  return resolveMainWindowState(persisted, screen.getAllDisplays(), screen.getPrimaryDisplay());
}

function revealMainWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  // macOS 直接启动、open 启动和 Codex Run 启动都必须把真实主窗口带到前台；
  // 否则用户会看到进程存在但没有可交互窗口，功能验证也无法继续。
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  app.focus({ steal: true });
}

/** macOS 再次点击 Dock/Finder 或第二个进程启动时，优先恢复已有窗口；没有窗口才新建。 */
async function revealOrCreateMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealMainWindow(mainWindow);
    return;
  }
  await createWindow();
}

function normalizeDragPoint(point: unknown): { screenX: number; screenY: number } | undefined {
  if (!point || typeof point !== 'object') return undefined;
  const candidate = point as { screenX?: unknown; screenY?: unknown };
  if (typeof candidate.screenX !== 'number' || typeof candidate.screenY !== 'number') return undefined;
  if (!Number.isFinite(candidate.screenX) || !Number.isFinite(candidate.screenY)) return undefined;
  return { screenX: candidate.screenX, screenY: candidate.screenY };
}

function isAllowedRendererNavigation(targetUrl: string, rendererUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    const renderer = new URL(rendererUrl);
    if (renderer.protocol === 'file:') return target.protocol === 'file:' && target.pathname === renderer.pathname;
    return target.origin === renderer.origin;
  } catch {
    return false;
  }
}

function configureWindowSecurity(window: BrowserWindow, rendererUrl: string): void {
  // Renderer 只允许 Zeus 自身入口导航；所有外部链接必须走显式 shell.openExternal 审计路径。
  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, rendererUrl)) {
      event.preventDefault();
    }
  });
  // Zeus 不需要摄像头、麦克风、定位等浏览器权限；默认拒绝可避免第三方内容误触权限弹窗。
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function rendererEntryUrl(surface?: 'menu-bar-usage' | 'task-git-delivery' | 'project-git-diff', parameters?: Record<string, string>): string {
  const url = new URL(process.env.ZEUS_DEV_SERVER_URL ?? pathToFileURL(join(desktopRoot(), 'dist/renderer/index.html')).toString());
  if (surface) url.searchParams.set('surface', surface);
  for (const [key, value] of Object.entries(parameters ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

async function openProjectGitDiffWindow(
  parent: BrowserWindow,
  input: {
    projectId: string;
    repositoryId: string;
    filePath: string;
    stage: 'combined' | 'staged' | 'unstaged';
    commitHash?: string;
    comparisonRef?: string;
    comparisonMode?: 'current' | 'working-tree';
  },
): Promise<{ opened: true }> {
  const workArea = screen.getDisplayMatching(parent.getBounds()).workArea;
  const width = Math.min(workArea.width, Math.max(900, Math.round(workArea.width * 0.84)));
  const height = Math.min(workArea.height, Math.max(620, Math.round(workArea.height * 0.82)));
  const window = new BrowserWindow({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
    minWidth: Math.min(760, width),
    minHeight: Math.min(520, height),
    parent,
    modal: false,
    title: appShellSettings.appLanguage === 'zh-CN' ? '仓库差异 · Zeus' : 'Repository Diff · Zeus',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(desktopRoot(), 'dist/preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  projectGitDiffWindows.add(window);
  window.on('closed', () => {
    projectGitDiffWindows.delete(window);
    appCloseLayerActivityByWindow.delete(window.id);
  });
  const rendererUrl = rendererEntryUrl('project-git-diff', {
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    filePath: input.filePath,
    stage: input.stage,
    ...(input.commitHash ? { commitHash: input.commitHash } : {}),
    ...(input.comparisonRef ? { comparisonRef: input.comparisonRef } : {}),
    ...(input.comparisonMode ? { comparisonMode: input.comparisonMode } : {}),
  });
  configureWindowSecurity(window, rendererUrl);
  window.once('ready-to-show', () => {
    window.show();
    window.focus();
  });
  await window.loadURL(rendererUrl);
  return { opened: true };
}

function normalizeTaskGitDeliveryContext(value: unknown): TaskGitDeliveryCurrentContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { taskId?: unknown; workspaceId?: unknown };
  const taskId = candidate.taskId === null ? null : typeof candidate.taskId === 'string' && candidate.taskId.trim() ? candidate.taskId : undefined;
  const workspaceId = candidate.workspaceId === null ? null : typeof candidate.workspaceId === 'string' && candidate.workspaceId.trim() ? candidate.workspaceId : undefined;
  if (taskId === undefined || workspaceId === undefined || (!taskId && workspaceId)) return undefined;
  return { taskId, workspaceId };
}

function broadcastTaskGitDeliveryCurrentContext(context: TaskGitDeliveryCurrentContext): void {
  currentTaskGitDeliveryContext = context;
  for (const window of taskGitDeliveryWindows.values()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('zeus:task-git-delivery:current-context', context);
  }
}

function initialTaskGitDeliveryWindowBounds(parent: BrowserWindow): { bounds: Electron.Rectangle; isMaximized: boolean; isFullScreen: boolean } {
  const persisted = readPersistedMainWindowState(taskGitDeliveryWindowStatePath());
  if (persisted) {
    const resolved = resolveMainWindowState(persisted, screen.getAllDisplays(), screen.getDisplayMatching(parent.getBounds()));
    return { bounds: resolved.bounds, isMaximized: resolved.isMaximized, isFullScreen: resolved.isFullScreen };
  }
  const workArea = screen.getDisplayMatching(parent.getBounds()).workArea;
  const width = Math.min(workArea.width, Math.max(Math.min(taskGitDeliveryMinimumSize.width, workArea.width), Math.round(workArea.width * 0.9)));
  const height = Math.min(workArea.height, Math.max(Math.min(taskGitDeliveryMinimumSize.height, workArea.height), Math.round(workArea.height * 0.9)));
  return {
    bounds: {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      width,
      height,
    },
    isMaximized: false,
    isFullScreen: false,
  };
}

function revealTaskGitDeliveryWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  app.focus({ steal: true });
}

async function openTaskGitDeliveryWindow(parent: BrowserWindow, taskId: string): Promise<{ opened: true; reused: boolean; taskId: string }> {
  const existing = taskGitDeliveryWindows.get(taskId);
  if (existing && !existing.isDestroyed()) {
    revealTaskGitDeliveryWindow(existing);
    return { opened: true, reused: true, taskId };
  }

  const restored = initialTaskGitDeliveryWindowBounds(parent);
  const window = new BrowserWindow({
    ...restored.bounds,
    minWidth: Math.min(taskGitDeliveryMinimumSize.width, restored.bounds.width),
    minHeight: Math.min(taskGitDeliveryMinimumSize.height, restored.bounds.height),
    parent,
    modal: false,
    title: appShellSettings.appLanguage === 'zh-CN' ? '代码交付 · Zeus' : 'Code Delivery · Zeus',
    show: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(desktopRoot(), 'dist/preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  taskGitDeliveryWindows.set(taskId, window);
  taskGitDeliveryTaskByWindowId.set(window.id, taskId);
  registerTaskGitDeliveryWindowStatePersistence(window);
  window.on('closed', () => {
    const timer = taskGitDeliveryWindowSaveTimers.get(window.id);
    if (timer) clearTimeout(timer);
    taskGitDeliveryWindowSaveTimers.delete(window.id);
    taskGitDeliveryWindowPersistenceGates.delete(window.id);
    taskGitDeliveryTaskByWindowId.delete(window.id);
    appCloseLayerActivityByWindow.delete(window.id);
    if (taskGitDeliveryWindows.get(taskId) === window) taskGitDeliveryWindows.delete(taskId);
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) console.warn(`Zeus 代码交付窗口加载失败：${validatedUrl} ${errorDescription} (${errorCode})`);
  });
  window.once('ready-to-show', () => {
    if (restored.isMaximized) window.maximize();
    if (restored.isFullScreen) window.setFullScreen(true);
    revealTaskGitDeliveryWindow(window);
    window.webContents.send('zeus:task-git-delivery:current-context', currentTaskGitDeliveryContext);
  });
  const rendererUrl = rendererEntryUrl('task-git-delivery', { taskId });
  configureWindowSecurity(window, rendererUrl);
  try {
    await window.loadURL(rendererUrl);
  } catch (error) {
    window.destroy();
    throw error;
  }
  return { opened: true, reused: false, taskId };
}

/** 创建 Zeus 主窗口；preload 会读取 Main 中启动的本地服务配置。 */
async function createWindow(): Promise<void> {
  traceApplicationStartup('window_creation_started');
  if (!appShellSettings.multiWindowEnabled && mainWindow && !mainWindow.isDestroyed()) {
    revealMainWindow(mainWindow);
    return;
  }

  const persistedWindowState = windows.size === 0 ? readPersistedMainWindowState(mainWindowStatePath()) : undefined;
  const restoredWindowState = await resolveMainWindowStateForLaunch(persistedWindowState);
  traceApplicationStartup('window_state_ready');
  const window = new BrowserWindow({
    ...restoredWindowState.bounds,
    // ZEUS-0240：询问与授权的输入、目标和操作必须保持同行，640px 是仍可完整操作的主窗口下限。
    minWidth: 640,
    minHeight: 560,
    title: desktopDisplayName(),
    // 隐藏 macOS 原生标题栏，让内容贴近窗口顶部；标题仅保留给系统菜单与辅助功能。
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    show: false,
    webPreferences: {
      preload: join(desktopRoot(), 'dist/preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  traceApplicationStartup('browser_window_created');
  window.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle(desktopDisplayName());
  });
  browserHost?.registerWindow(window);

  registerMainWindowStatePersistence(window);

  rendererBootstrapMonitor.watch(window);

  window.webContents.once('preload-error', (_event, preloadPath, error) => {
    const detail = error instanceof Error ? error.message : String(error);
    rendererBootstrapMonitor.fail(window, new Error(`Renderer preload failed (${preloadPath}): ${detail}`));
  });
  window.webContents.once('render-process-gone', (_event, details) => {
    rendererBootstrapMonitor.fail(window, new Error(`Renderer process exited during bootstrap (${details.reason}, exit ${details.exitCode})`));
  });
  window.on('unresponsive', () => {
    rendererBootstrapMonitor.fail(window, new Error('Renderer became unresponsive during bootstrap'));
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    rendererBootstrapMonitor.fail(window, new Error(`Renderer failed to load ${validatedURL}: ${errorDescription} (${errorCode})`));
  });

  windows.add(window);
  mainWindow = window;
  window.on('focus', () => {
    window.webContents.send('zeus:requesting-window-foreground-changed', true);
    const context = mainWindowTaskGitContexts.get(window.id);
    if (context) broadcastTaskGitDeliveryCurrentContext(context);
  });
  window.on('blur', () => {
    window.webContents.send('zeus:requesting-window-foreground-changed', false);
  });
  const sourceWatcherKey = window.webContents.id;
  window.on('closed', () => {
    browserHost?.unregisterWindow(window);
    const timer = windowStateSaveTimers.get(window.id);
    if (timer) clearTimeout(timer);
    windowStateSaveTimers.delete(window.id);
    const activationTimer = windowStateActivationTimers.get(window.id);
    if (activationTimer) clearTimeout(activationTimer);
    windowStateActivationTimers.delete(window.id);
    windowStatePersistenceGates.delete(window.id);
    taskTableLayoutDirtyWindowIds.delete(window.id);
    unsavedChangeKeysByWindow.delete(window.id);
    sensitiveRequestDraftIdsByWindow.delete(window.id);
    taskTableLayoutCloseApprovedWindowIds.delete(window.id);
    pendingTaskTableLayoutWindowCloseIds.delete(window.id);
    projectSourceWatchers.get(sourceWatcherKey)?.watcher.close();
    projectSourceWatchers.delete(sourceWatcherKey);
    mainWindowTaskGitContexts.delete(window.id);
    sessionContextActivityByWindow.delete(window.id);
    appCloseLayerActivityByWindow.delete(window.id);
    rendererBootstrapMonitor.dispose(window);
    windows.delete(window);
    if (mainWindow === window) mainWindow = [...windows].at(-1);
    if (
      windows.size === 0 &&
      (isTestDistribution() ||
        shouldQuitWhenAllWindowsClosed({
          platform: process.platform,
          backgroundModeEnabled: appShellSettings.backgroundModeEnabled,
        }))
    ) {
      menuBarUsageWindow?.destroy();
    }
  });

  let didRevealMainWindow = false;
  const revealMainWindowOnce = () => {
    if (didRevealMainWindow) return;
    didRevealMainWindow = true;
    const placement = applyRestoredMainWindowPlacement({
      window,
      restored: restoredWindowState,
      getDisplayMatching: (bounds) => screen.getDisplayMatching(bounds),
      reveal: () => revealMainWindow(window),
    });
    activateMainWindowStatePersistence(window);
    console.info(
      'Zeus main window restoration',
      JSON.stringify({
        matchKind: restoredWindowState.matchKind,
        targetDisplayId: restoredWindowState.targetDisplayId ?? null,
        actualDisplayId: placement.actualDisplayId ?? null,
        corrected: placement.corrected,
        bounds: window.getBounds(),
      }),
    );
    traceApplicationStartup('main_window_revealed');
  };

  window.once('ready-to-show', revealMainWindowOnce);
  const rendererUrl = rendererEntryUrl();
  configureWindowSecurity(window, rendererUrl);
  traceApplicationStartup('renderer_load_started');
  if (process.env.ZEUS_DEV_SERVER_URL) {
    await window.loadURL(rendererUrl);
  } else {
    await window.loadURL(rendererUrl);
  }
  traceApplicationStartup('renderer_load_finished');
  // 某些 packaged file:// + asar 状态下 ready-to-show 可能错过或延迟；兜底显示窗口，避免只剩后台进程。
  setTimeout(revealMainWindowOnce, 1200);
}

function setupMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppShellMenuTemplate({
        settings: appShellSettings,
        createNewConversation: () => {
          void startNewConversationFromMenu();
        },
        toggleDevTools: () => mainWindow?.webContents.toggleDevTools(),
        openSettings: () => {
          void openSettingsFromMenu();
        },
        checkForUpdates: () => {
          void checkForUpdatesFromMenu();
        },
        openLogsDirectory: () => {
          void openLogsDirectoryFromMenu();
        },
        showMainWindow: () => {
          void requestMainWindow();
        },
        closeFocusedWindow: closeFocusedWindowOrContextTab,
        quit: () => app.quit(),
      }) as Electron.MenuItemConstructorOptions[],
    ),
  );
}

/** Cmd+W 依次关闭最上层模态层、活动的会话右侧标签和当前 macOS 窗口。 */
function closeFocusedWindowOrContextTab(): void {
  const window = BrowserWindow.getFocusedWindow();
  if (!window || window.isDestroyed()) return;
  if (appCloseLayerActivityByWindow.get(window.id)) {
    window.webContents.send('zeus:app-close-frontmost-layer');
    return;
  }
  const contextActivity = sessionContextActivityByWindow.get(window.id);
  if (browserHost?.isVisibleTabFocused(window) || contextActivity?.active) {
    window.webContents.send('zeus:session-context-close-active-tab');
    return;
  }
  window.close();
}

function isTrustedZeusRendererWindow(window: BrowserWindow): boolean {
  return windows.has(window) || taskGitDeliveryTaskByWindowId.has(window.id) || projectGitDiffWindows.has(window) || menuBarUsageWindow === window;
}

/** Cmd+N 是会话级动作：恢复主窗口并通知 Renderer 打开新会话草稿，不再创建额外窗口。 */
async function startNewConversationFromMenu(): Promise<void> {
  await requestMainWindow();
  if (fatalStartup) return;
  mainWindow?.webContents.send('zeus:native-new-conversation');
}

/** 从 macOS 原生 Settings 菜单进入设置区域；只跳转页面锚点，不伪造任何设置状态。 */
async function openSettingsFromMenu(): Promise<void> {
  await requestMainWindow();
  if (fatalStartup) return;
  await mainWindow?.webContents.executeJavaScript('globalThis.location.hash = "#settings-general";', true).catch(() => undefined);
}

/** 菜单栏浮窗只能跳转到已存在的设置页，不复制用量或账户配置流程。 */
async function openSettingsFromMenuBarUsage(category: 'usage' | 'runtime'): Promise<void> {
  hideMenuBarUsageWindow();
  await requestMainWindow();
  if (fatalStartup) return;
  await mainWindow?.webContents.executeJavaScript(`globalThis.location.hash = "#settings-${category}";`, true).catch(() => undefined);
}

/** 从 macOS 原生菜单触发真实更新检查；结果、预取和重启决策全部留在非阻断原生窗口。 */
async function checkForUpdatesFromMenu(): Promise<void> {
  const envelope = createSystemMainCommandEnvelope('desktop.automatic_update.menu_check', 'desktop-update');
  await activeMainCommandLedger().execute({ envelope, body: null }, 'desktop.automatic_update.menu_check', async (_body, command) => {
    await requestMainWindow();
    if (fatalStartup) throw new Error('Zeus 启动失败，无法检查更新。');
    if (!homebrewUpdateController) throw new Error('Zeus 更新控制器尚未就绪。');
    await command.markWriteStarted();
    await homebrewUpdateController.showOrCheck();
    return { opened: true, externalOperationId: command.externalOperationId };
  });
}

/** 打开本机日志目录；长日志和导出文件留在用户 Mac 上，不发送到远端渠道。 */
async function openLogsDirectoryFromMenu(): Promise<void> {
  await openLocalLogDirectory({
    dbPath: localServerRuntime?.dbPath,
    fallbackLogsPath: app.getPath('logs'),
    ensureDirectory: async (path, options) => {
      await mkdir(path, options);
    },
    openPath: (path) => shell.openPath(path),
  }).catch(() => undefined);
}

async function revealProjectPathInFinder(value: unknown): Promise<{ revealed: true; path: string }> {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value.trim())) {
    throw new TypeError('Project path must be an absolute local path.');
  }
  const projectPath = resolve(value.trim());
  const projectPathStat = await stat(projectPath);
  if (!projectPathStat.isDirectory()) {
    throw new TypeError('Project path must point to a local directory.');
  }
  // showItemInFolder 会在 Finder 中选中项目目录；不能退化成 openPath，否则用户会进入目录而不是定位目录本身。
  shell.showItemInFolder(projectPath);
  return { revealed: true, path: projectPath };
}

function conversationResourceOpenServices(requestingWindow: BrowserWindow) {
  if (!localServerRuntime) throw new Error('Zeus local server is not ready.');
  return {
    config: localServerRuntime.config,
    fetchJson: async (url: string, init: { headers: Record<string, string> }) => {
      const response = await fetch(url, init);
      const payload = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) {
        const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
        throw Object.assign(new Error(typeof record.message === 'string' ? record.message : `Local resource authority failed with HTTP ${response.status}.`), {
          code: typeof record.error === 'string' ? record.error : 'ZEUS_CONVERSATION_RESOURCE_AUTHORITY_FAILED',
        });
      }
      return payload;
    },
    pathExists: async (path: string) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    openExternal: (url: string) => shell.openExternal(url),
    openPath: (path: string) => shell.openPath(path),
    showItemInFolder: (path: string) => shell.showItemInFolder(path),
    writeClipboardText: (text: string) => clipboard.writeText(text),
    openBrowser: async (input: { conversationId: string; url: string }) => {
      if (!browserHost) throw new Error('Zeus BrowserHost is not ready.');
      return browserHost.openConversationResource(requestingWindow, input);
    },
    executeFile: (file: string, args: string[]) => execFile(file, args),
    applicationHome: app.getPath('home'),
    getSettings: () => {
      if (!browserHost) throw new Error('Zeus BrowserHost is not ready.');
      return browserHost.getSettings();
    },
  };
}

async function loadProjectRootForSourceWorkspace(projectId: string): Promise<string> {
  return (await loadProjectIdentity(projectId)).localPath;
}

async function loadProjectIdentity(projectId: string): Promise<ProjectGitProjectIdentity> {
  if (!localServerRuntime) throw new Error('Zeus local server is not ready.');
  const config = await localServerRuntime.refreshConfig();
  const response = await fetch(`${config.baseUrl}/api/projects/${encodeURIComponent(projectId)}`, {
    headers: { authorization: `Bearer ${config.apiToken}` },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw Object.assign(new Error(typeof payload.message === 'string' ? payload.message : '项目不存在。'), {
      code: typeof payload.error === 'string' ? payload.error : 'ZEUS_PROJECT_NOT_FOUND',
    });
  }
  if (payload.id !== projectId || typeof payload.name !== 'string' || !payload.name.trim() || typeof payload.localPath !== 'string' || !payload.localPath.trim()) throw new Error('项目身份或项目目录不可用。');
  return { id: projectId, name: payload.name, localPath: payload.localPath };
}

async function loadZentaoExtractServices(): Promise<ZentaoExtractServices | undefined> {
  if (!localServerRuntime) return undefined;
  const secretStore = createMacOSKeychainStore({ service: activeDesktopKeychainService() });
  return {
    loadInstances: async () => {
      if (!localServerRuntime) return [];
      const config = await localServerRuntime.refreshConfig();
      const response = await fetch(`${config.baseUrl}/api/zentao-instances`, {
        headers: { authorization: `Bearer ${config.apiToken}` },
      });
      if (!response.ok) return [];
      const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
      if (!Array.isArray(payload.items)) return [];
      return payload.items.filter((item): item is ZentaoInstanceRecord => typeof item === 'object' && item !== null && typeof (item as ZentaoInstanceRecord).id === 'string' && typeof (item as ZentaoInstanceRecord).host === 'string');
    },
    readPassword: async (instanceId) => secretStore.getSecret(zentaoSecretAccount(instanceId)),
  };
}

function requireProjectSourceWorkspace(event: Electron.IpcMainInvokeEvent): ProjectSourceWorkspaceService {
  const requestingWindow = BrowserWindow.fromWebContents(event.sender);
  if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !projectSourceWorkspace) {
    throw new Error('项目源码请求来自不受信任窗口或源码服务尚未就绪。');
  }
  return projectSourceWorkspace;
}

function requireProjectGitWorkbench(event: Electron.IpcMainInvokeEvent): ProjectGitWorkbenchService {
  const requestingWindow = BrowserWindow.fromWebContents(event.sender);
  const trustedWindow = requestingWindow && !requestingWindow.isDestroyed() && (windows.has(requestingWindow) || projectGitDiffWindows.has(requestingWindow));
  if (!trustedWindow || !projectGitWorkbench) throw new Error('项目 Git 请求来自不受信任窗口或 Git 服务尚未就绪。');
  return projectGitWorkbench;
}

function auditProjectSourceStructure(action: 'create' | 'move' | 'trash', projectId: string, relativePath: string, targetRelativePath?: string): void {
  // 结构审计只记录动作和相对路径，绝不记录源码正文。
  console.info('[project-source-audit]', JSON.stringify({ action, projectId, relativePath, ...(targetRelativePath ? { targetRelativePath } : {}) }));
}

function sanitizeRendererRuntimeLogDetail(message: unknown): string {
  const raw = typeof message === 'string' && message.trim() ? message.trim() : 'Renderer operation failed without detail';
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, 'sk-[redacted]')
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*([^\s,;]+)/giu, '$1=[redacted]')
    .replace(/([?&](?:access_token|api_key|token|password|secret)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/\s+/gu, ' ')
    .slice(0, 2_000);
}

function setupIpc(): void {
  ipcMain.handle('zeus:conversation-store-migration:get-status', () => {
    if (dataRootPreparationError !== undefined) return null;
    return readUnifiedConversationStoreMigrationStatus(activeZeusDataLayout());
  });
  ipcMain.handle('zeus:conversation-store-migration:retry', async (_event, request: MainCommandRequest) => {
    const status = await activeMainCommandLedger().execute(request, 'desktop.conversation_store_migration.retry', async (_body, command) => {
      const { prepareDesktopConversationStoreMigration } = await import('./localServerRuntime.js');
      await command.markWriteStarted();
      return prepareDesktopConversationStoreMigration(activeZeusDataLayout().root, zeusDataRootHostIdentity(activeDataRootIdentity()), activeZeusDataLayout());
    });
    if (status.phase === 'completed' || status.phase === 'not_required') {
      requestFullAppRestart();
    }
    return status;
  });
  ipcMain.handle('zeus:conversation-store-migration:open-diagnostics', async () => {
    const status = readUnifiedConversationStoreMigrationStatus(activeZeusDataLayout());
    if (!status) throw new Error('统一会话迁移诊断尚不存在。');
    return shell.showItemInFolder(status.diagnosticPath);
  });
  ipcMain.handle('zeus:conversation-store-migration:exit', () => app.quit());
  ipcMain.handle('zeus:execution-host-maintenance:get-status', async () => {
    if (dataRootPreparationError !== undefined) return null;
    await rendererStartupDisposition;
    return executionHostMaintenance;
  });
  ipcMain.handle('zeus:execution-host-maintenance:retry', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !isTrustedZeusRendererWindow(requestingWindow) || !executionHostMaintenance) {
      throw new Error('执行宿主维护重试来自不受信任窗口或当前不在维护模式。');
    }
    requestFullAppRestart();
  });
  ipcMain.handle('zeus:execution-host-maintenance:exit', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !isTrustedZeusRendererWindow(requestingWindow) || !executionHostMaintenance) {
      throw new Error('执行宿主维护退出来自不受信任窗口或当前不在维护模式。');
    }
    app.quit();
  });
  ipcMain.handle('zeus:startup-failure:restart', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !isTrustedZeusRendererWindow(requestingWindow)) {
      throw new Error('启动恢复请求来自不受信任窗口。');
    }
    requestFullAppRestart();
  });
  ipcMain.handle('zeus:startup-failure:exit', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !isTrustedZeusRendererWindow(requestingWindow)) {
      throw new Error('启动失败退出请求来自不受信任窗口。');
    }
    app.quit();
  });
  ipcMain.handle('zeus:get-local-server-config', async () => {
    const runtime = localServerRuntime ?? (await rendererRuntimeReady);
    return runtime.refreshConfig();
  });
  ipcMain.handle('zeus:session-view-cache:load', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !isTrustedZeusRendererWindow(requestingWindow) || readOnlyValidationDescriptor || dataRootPreparationError !== undefined) return null;
    const cache = readSessionViewCache(join(activeZeusDataLayout().electronUserData, 'session-view-cache-v1.json'));
    traceApplicationStartup(cache ? 'session_view_cache_loaded' : 'session_view_cache_missed');
    return cache;
  });
  ipcMain.on('zeus:session-view-cache:persist', (event, value: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !isTrustedZeusRendererWindow(requestingWindow) || readOnlyValidationDescriptor || dataRootPreparationError !== undefined) return;
    writeSessionViewCache(join(activeZeusDataLayout().electronUserData, 'session-view-cache-v1.json'), value);
  });
  ipcMain.handle('zeus:storage-recovery:preflight-and-restart', async (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !isTrustedZeusRendererWindow(requestingWindow)) {
      throw new Error('存储恢复请求来自不受信任的 Zeus 窗口。');
    }
    try {
      return await activeMainCommandLedger().execute(request, 'desktop.storage_recovery.preflight_restart', async (_body, command) => {
        if (storageRecoveryRestart.isRequested()) throw new Error('Zeus Core 恢复重启已经安排。');
        const runtime = localServerRuntime ?? (await rendererRuntimeReady);
        const config = await runtime.refreshConfig();
        await command.markWriteStarted();
        const response = await fetch(`${config.baseUrl}/api/diagnostics/storage/recovery-preflight`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${config.apiToken}`,
          },
        });
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          throw new Error(typeof payload.message === 'string' ? payload.message : `存储恢复预检失败（HTTP ${response.status}）。`);
        }
        const artifacts = payload.artifacts && typeof payload.artifacts === 'object' && !Array.isArray(payload.artifacts) ? (payload.artifacts as Record<string, unknown>) : null;
        const eligible =
          payload.eligibleForCoreRestart === true &&
          payload.coreRestartRequired === true &&
          payload.transactionRolledBack === true &&
          payload.quickCheck === 'ok' &&
          payload.walCheckpoint === 'ok' &&
          payload.foreignKeyCheck === 'ok' &&
          payload.commandLedgerCheck === 'ok' &&
          payload.commandLedgerViolations === 0 &&
          typeof payload.preparedCommands === 'number' &&
          Number.isSafeInteger(payload.preparedCommands) &&
          payload.preparedCommands >= 0 &&
          typeof payload.providerWritesAwaitingReconciliation === 'number' &&
          Number.isSafeInteger(payload.providerWritesAwaitingReconciliation) &&
          payload.providerWritesAwaitingReconciliation >= 0 &&
          typeof payload.recoveryRequiredCommands === 'number' &&
          Number.isSafeInteger(payload.recoveryRequiredCommands) &&
          payload.recoveryRequiredCommands >= 0 &&
          artifacts?.stagingWrite === 'ok' &&
          artifacts.freeSpace === 'ok' &&
          artifacts.eligibleForCoreRestart === true &&
          typeof payload.faultId === 'string' &&
          payload.faultId.length > 0 &&
          typeof payload.checkedAt === 'string';
        if (!eligible) {
          throw new Error('存储恢复预检未全部通过；Zeus 将继续保持只读，不会退出或重启 Core。');
        }
        storageRecoveryRestart.request();
        return {
          faultId: payload.faultId,
          transactionRolledBack: true as const,
          quickCheck: 'ok' as const,
          walCheckpoint: 'ok' as const,
          foreignKeyCheck: 'ok' as const,
          commandLedgerCheck: 'ok' as const,
          commandLedgerViolations: 0 as const,
          preparedCommands: payload.preparedCommands as number,
          providerWritesAwaitingReconciliation: payload.providerWritesAwaitingReconciliation as number,
          recoveryRequiredCommands: payload.recoveryRequiredCommands as number,
          artifactStagingWrite: 'ok' as const,
          artifactFreeSpace: 'ok' as const,
          eligibleForCoreRestart: true as const,
          coreRestartRequired: true as const,
          checkedAt: payload.checkedAt,
          restartScheduled: true as const,
        };
      });
    } finally {
      // 预检一旦通过，即使 Main receipt 的最后一次持久化再次失败，也不能留下“已安排但没有 timer”的假状态。
      storageRecoveryRestart.ensureScheduled(() => {
        setTimeout(() => {
          requestFullAppRestart();
        }, 0);
      });
    }
  });
  ipcMain.handle('zeus:task-git-delivery:open', async (event, input: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('代码交付窗口请求来自不受信任的主窗口。');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('代码交付窗口请求无效。');
    const candidate = input as { taskId?: unknown; workspaceId?: unknown };
    if (typeof candidate.taskId !== 'string' || !candidate.taskId.trim()) throw new TypeError('代码交付任务身份无效。');
    if (candidate.workspaceId !== undefined && candidate.workspaceId !== null && (typeof candidate.workspaceId !== 'string' || !candidate.workspaceId.trim())) throw new TypeError('代码交付工作区身份无效。');
    if (typeof candidate.workspaceId === 'string') {
      const context = { taskId: candidate.taskId, workspaceId: candidate.workspaceId };
      mainWindowTaskGitContexts.set(requestingWindow.id, context);
      broadcastTaskGitDeliveryCurrentContext(context);
    }
    return openTaskGitDeliveryWindow(requestingWindow, candidate.taskId);
  });
  ipcMain.handle('zeus:project-git-diff:open', async (event, input: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('仓库差异窗口请求来自不受信任的主窗口。');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('仓库差异窗口请求无效。');
    const candidate = input as Record<string, unknown>;
    const required = ['projectId', 'repositoryId', 'filePath'] as const;
    for (const key of required) if (typeof candidate[key] !== 'string') throw new TypeError(`仓库差异窗口缺少 ${key}。`);
    const stage = candidate.stage === 'staged' || candidate.stage === 'unstaged' ? candidate.stage : 'combined';
    return openProjectGitDiffWindow(requestingWindow, {
      projectId: candidate.projectId as string,
      repositoryId: candidate.repositoryId as string,
      filePath: candidate.filePath as string,
      stage,
      ...(typeof candidate.commitHash === 'string' && candidate.commitHash ? { commitHash: candidate.commitHash } : {}),
      ...(typeof candidate.comparisonRef === 'string' && candidate.comparisonRef ? { comparisonRef: candidate.comparisonRef } : {}),
      ...(candidate.comparisonMode === 'working-tree' ? { comparisonMode: 'working-tree' as const } : candidate.comparisonMode === 'current' ? { comparisonMode: 'current' as const } : {}),
    });
  });
  ipcMain.handle('zeus:project-git:load-workbench', (event, projectId: unknown) => {
    if (typeof projectId !== 'string') throw new TypeError('项目 Git 工作台请求缺少项目身份。');
    return requireProjectGitWorkbench(event).loadWorkbench(projectId);
  });
  ipcMain.handle('zeus:project-git:load-commit', (event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('项目 Git 提交请求无效。');
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.projectId !== 'string' || typeof candidate.repositoryId !== 'string' || typeof candidate.commitHash !== 'string') throw new TypeError('项目 Git 提交请求身份无效。');
    return requireProjectGitWorkbench(event).loadCommit(candidate.projectId, candidate.repositoryId, candidate.commitHash);
  });
  ipcMain.handle('zeus:project-git:load-comparison', (event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('项目 Git 比较请求无效。');
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.projectId !== 'string' || typeof candidate.repositoryId !== 'string' || typeof candidate.ref !== 'string' || (candidate.mode !== 'current' && candidate.mode !== 'working-tree')) {
      throw new TypeError('项目 Git 比较请求身份无效。');
    }
    return requireProjectGitWorkbench(event).loadComparison(candidate.projectId, candidate.repositoryId, candidate.ref, candidate.mode);
  });
  ipcMain.handle('zeus:project-git:execute-action', (event, request: MainCommandRequest) => {
    const workbench = requireProjectGitWorkbench(event);
    return activeMainCommandLedger().execute(request, 'desktop.project_git.execute_action', async (input, command) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('项目 Git 动作请求无效。');
      const candidate = input as Record<string, unknown>;
      if (typeof candidate.projectId !== 'string' || typeof candidate.repositoryId !== 'string' || !candidate.action || typeof candidate.action !== 'object' || Array.isArray(candidate.action)) {
        throw new TypeError('项目 Git 动作请求身份无效。');
      }
      await command.markWriteStarted();
      return workbench.execute(candidate.projectId, candidate.repositoryId, candidate.action);
    });
  });
  ipcMain.handle('zeus:task-git-delivery:close', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    const taskId = requestingWindow ? taskGitDeliveryTaskByWindowId.get(requestingWindow.id) : undefined;
    if (!requestingWindow || requestingWindow.isDestroyed() || !taskId) throw new Error('当前窗口不是受信任的代码交付窗口。');
    requestingWindow.close();
    return { closed: true, taskId };
  });
  ipcMain.handle('zeus:task-git-delivery:get-current-context', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !taskGitDeliveryTaskByWindowId.has(requestingWindow.id)) throw new Error('当前会话上下文请求来自不受信任的代码交付窗口。');
    return currentTaskGitDeliveryContext;
  });
  ipcMain.on('zeus:task-git-delivery:current-context-changed', (event, value: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    const context = normalizeTaskGitDeliveryContext(value);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !context) return;
    mainWindowTaskGitContexts.set(requestingWindow.id, context);
    if (requestingWindow.isFocused() || requestingWindow === mainWindow) broadcastTaskGitDeliveryCurrentContext(context);
  });
  ipcMain.on('zeus:task-git-delivery:changed', (event, taskId: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    const ownedTaskId = requestingWindow ? taskGitDeliveryTaskByWindowId.get(requestingWindow.id) : undefined;
    if (!ownedTaskId || taskId !== ownedTaskId) return;
    for (const window of windows) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('zeus:task-git-delivery:changed', ownedTaskId);
    }
  });
  ipcMain.handle('zeus:task-git-delivery:open-conversation', async (event, input: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    const ownedTaskId = requestingWindow ? taskGitDeliveryTaskByWindowId.get(requestingWindow.id) : undefined;
    if (!ownedTaskId || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('冲突处理会话请求来自不受信任的代码交付窗口。');
    const candidate = input as { taskId?: unknown; conversationId?: unknown };
    if (candidate.taskId !== ownedTaskId || typeof candidate.conversationId !== 'string' || !candidate.conversationId.trim()) throw new TypeError('冲突处理会话身份无效。');
    await requestMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Zeus 主窗口当前不可用。');
    revealMainWindow(mainWindow);
    mainWindow.webContents.send('zeus:task-git-delivery:open-conversation', { taskId: ownedTaskId, conversationId: candidate.conversationId });
    return { opened: true };
  });
  ipcMain.handle('zeus:menu-bar-usage:hide', (event) => {
    requireMenuBarUsageWindow(event);
    hideMenuBarUsageWindow();
    return { hidden: true };
  });
  ipcMain.handle('zeus:menu-bar-usage:show-main', async (event) => {
    requireMenuBarUsageWindow(event);
    hideMenuBarUsageWindow();
    await requestMainWindow();
    return { shown: !fatalStartup };
  });
  ipcMain.handle('zeus:menu-bar-usage:open-settings', async (event, category: unknown) => {
    requireMenuBarUsageWindow(event);
    if (category !== 'usage' && category !== 'runtime') throw new TypeError('菜单栏用量浮窗设置目标无效。');
    await openSettingsFromMenuBarUsage(category);
    return { opened: !fatalStartup, category };
  });
  ipcMain.handle('zeus:menu-bar-usage:quit', (event) => {
    requireMenuBarUsageWindow(event);
    hideMenuBarUsageWindow();
    app.quit();
    return { quitting: true };
  });
  ipcMain.handle('zeus:project-source:list-directory', (event, input: { projectId?: unknown; relativePath?: unknown }) => {
    const service = requireProjectSourceWorkspace(event);
    if (typeof input?.projectId !== 'string' || (input.relativePath !== undefined && typeof input.relativePath !== 'string')) throw new TypeError('项目源码目录请求无效。');
    return service.listDirectory(input.projectId, input.relativePath ?? '');
  });
  ipcMain.handle('zeus:project-source:search', (event, input: { projectId?: unknown; query?: unknown }) => {
    const service = requireProjectSourceWorkspace(event);
    if (typeof input?.projectId !== 'string' || typeof input.query !== 'string') throw new TypeError('项目源码搜索请求无效。');
    return service.search(input.projectId, input.query);
  });
  ipcMain.handle('zeus:project-source:read-file', (event, input: { projectId?: unknown; relativePath?: unknown }) => {
    const service = requireProjectSourceWorkspace(event);
    if (typeof input?.projectId !== 'string' || typeof input.relativePath !== 'string') throw new TypeError('项目源码读取请求无效。');
    return service.readFile(input.projectId, input.relativePath);
  });
  ipcMain.handle('zeus:project-source:save-file', (event, request: MainCommandRequest<SaveProjectSourceFileInput>) => {
    const workspace = requireProjectSourceWorkspace(event);
    return activeMainCommandLedger().execute(request, 'desktop.project_source.save_file', async (input, command) => {
      if (!input || typeof input.projectId !== 'string' || typeof input.relativePath !== 'string' || typeof input.content !== 'string' || !input.expectedRevision || typeof input.expectedRevision.sha256 !== 'string') {
        throw new TypeError('项目源码保存请求无效。');
      }
      await command.markWriteStarted();
      return workspace.saveFile(input);
    });
  });
  ipcMain.handle('zeus:project-source:create-entry', async (event, request: MainCommandRequest<CreateProjectSourceEntryInput>) => {
    const workspace = requireProjectSourceWorkspace(event);
    return activeMainCommandLedger().execute(request, 'desktop.project_source.create_entry', async (input, command) => {
      if (!input || typeof input.projectId !== 'string' || typeof input.parentRelativePath !== 'string' || typeof input.name !== 'string' || (input.kind !== 'file' && input.kind !== 'directory')) {
        throw new TypeError('项目源码新建请求无效。');
      }
      await command.markWriteStarted();
      const entry = await workspace.createEntry(input);
      auditProjectSourceStructure('create', input.projectId, entry.relativePath);
      return entry;
    });
  });
  ipcMain.handle('zeus:project-source:move-entry', async (event, request: MainCommandRequest<MoveProjectSourceEntryInput>) => {
    const workspace = requireProjectSourceWorkspace(event);
    return activeMainCommandLedger().execute(request, 'desktop.project_source.move_entry', async (input, command) => {
      if (!input || typeof input.projectId !== 'string' || typeof input.relativePath !== 'string' || typeof input.targetParentRelativePath !== 'string' || typeof input.targetName !== 'string') {
        throw new TypeError('项目源码移动请求无效。');
      }
      await command.markWriteStarted();
      const entry = await workspace.moveEntry(input);
      auditProjectSourceStructure('move', input.projectId, input.relativePath, entry.relativePath);
      return entry;
    });
  });
  ipcMain.handle('zeus:project-source:trash-entry', async (event, request: MainCommandRequest<TrashProjectSourceEntryInput>) => {
    const workspace = requireProjectSourceWorkspace(event);
    return activeMainCommandLedger().execute(request, 'desktop.project_source.trash_entry', async (input, command) => {
      if (!input || typeof input.projectId !== 'string' || typeof input.relativePath !== 'string') throw new TypeError('项目源码删除请求无效。');
      await command.markWriteStarted();
      const result = await workspace.trashEntry(input.projectId, input.relativePath);
      auditProjectSourceStructure('trash', input.projectId, input.relativePath);
      return result;
    });
  });
  ipcMain.handle('zeus:project-source:reveal-entry', async (event, input: { projectId?: unknown; relativePath?: unknown }) => {
    const service = requireProjectSourceWorkspace(event);
    if (typeof input?.projectId !== 'string' || typeof input.relativePath !== 'string') throw new TypeError('项目源码定位请求无效。');
    const path = await service.revealPath(input.projectId, input.relativePath);
    shell.showItemInFolder(path);
    return { revealed: true, relativePath: input.relativePath };
  });
  ipcMain.handle('zeus:project-source:open-external', async (event, input: { projectId?: unknown; relativePath?: unknown }) => {
    const service = requireProjectSourceWorkspace(event);
    if (typeof input?.projectId !== 'string' || typeof input.relativePath !== 'string') throw new TypeError('项目源码外部打开请求无效。');
    const path = await service.revealPath(input.projectId, input.relativePath);
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
    return { opened: true, relativePath: input.relativePath };
  });
  ipcMain.handle('zeus:project-source:watch', async (event, projectId: unknown) => {
    const service = requireProjectSourceWorkspace(event);
    if (typeof projectId !== 'string') throw new TypeError('项目源码监听请求无效。');
    projectSourceWatchers.get(event.sender.id)?.watcher.close();
    const watcher = await service.watch(projectId, (sourceEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send('zeus:project-source-event', sourceEvent);
    });
    projectSourceWatchers.set(event.sender.id, { projectId, watcher });
    return { watching: true, projectId };
  });
  ipcMain.handle('zeus:project-source:unwatch', (event) => {
    requireProjectSourceWorkspace(event);
    projectSourceWatchers.get(event.sender.id)?.watcher.close();
    projectSourceWatchers.delete(event.sender.id);
    return { watching: false };
  });
  ipcMain.on('zeus:renderer-bootstrap-failed', (event, message: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
    const detail = typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : 'Renderer bootstrap failed without detail';
    rendererBootstrapMonitor.fail(requestingWindow, new Error(`Renderer bootstrap failed: ${detail}`));
  });
  ipcMain.on('zeus:renderer-bootstrap-ready', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
    if (rendererBootstrapMonitor.markReady(requestingWindow)) traceApplicationStartup('renderer_bootstrap_ready');
  });
  ipcMain.on('zeus:renderer-runtime-failed', (event, message: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !rendererBootstrapMonitor.isReady(requestingWindow)) return;
    const detail = typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : 'Renderer runtime failed without detail';
    // 界面已完成启动后，运行期错误交给 Renderer 的可恢复页处理；主进程不得把它误判为启动失败并退出整个应用。
    console.error(`Renderer runtime failed: ${detail}`);
  });
  ipcMain.on('zeus:renderer-runtime-log', (event, message: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
    const detail = sanitizeRendererRuntimeLogDetail(message);
    console.error(`Renderer operation failed: ${detail}`);
    if (readOnlyValidationDescriptor || dataRootPreparationError !== undefined) return;
    const logDirectory = activeZeusDataLayout().executionHost;
    void mkdir(logDirectory, { recursive: true })
      .then(() =>
        appendFile(
          join(logDirectory, 'host.log'),
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            event: 'renderer_runtime_error',
            pid: process.pid,
            detail,
          })}\n`,
          { encoding: 'utf8', mode: 0o600 },
        ),
      )
      .catch((error) => console.error('Zeus Renderer 运行日志写入失败。', error));
  });
  ipcMain.on('zeus:task-table-layout-dirty-changed', (event, dirty: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
    const keys = unsavedChangeKeysByWindow.get(requestingWindow.id) ?? new Set<string>();
    if (dirty === true) keys.add('task-table-layout');
    else keys.delete('task-table-layout');
    if (keys.size > 0) {
      unsavedChangeKeysByWindow.set(requestingWindow.id, keys);
      taskTableLayoutDirtyWindowIds.add(requestingWindow.id);
    } else {
      unsavedChangeKeysByWindow.delete(requestingWindow.id);
      taskTableLayoutDirtyWindowIds.delete(requestingWindow.id);
    }
  });
  ipcMain.on('zeus:unsaved-change-state', (event, payload: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !payload || typeof payload !== 'object') return;
    const key = typeof (payload as { key?: unknown }).key === 'string' ? (payload as { key: string }).key.trim() : '';
    if (!/^[a-z0-9:-]{1,80}$/u.test(key)) return;
    const keys = unsavedChangeKeysByWindow.get(requestingWindow.id) ?? new Set<string>();
    if ((payload as { dirty?: unknown }).dirty === true) keys.add(key);
    else keys.delete(key);
    if (keys.size > 0) {
      unsavedChangeKeysByWindow.set(requestingWindow.id, keys);
      taskTableLayoutDirtyWindowIds.add(requestingWindow.id);
    } else {
      unsavedChangeKeysByWindow.delete(requestingWindow.id);
      taskTableLayoutDirtyWindowIds.delete(requestingWindow.id);
    }
  });
  ipcMain.on('zeus:sensitive-request-draft-changed', (event, payload: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !payload || typeof payload !== 'object') return;
    const requestId = typeof (payload as { requestId?: unknown }).requestId === 'string' ? (payload as { requestId: string }).requestId.trim() : '';
    const present = (payload as { present?: unknown }).present === true;
    if (!requestId || requestId.length > 200) return;
    const requestIds = sensitiveRequestDraftIdsByWindow.get(requestingWindow.id) ?? new Set<string>();
    if (present) requestIds.add(requestId);
    else requestIds.delete(requestId);
    if (requestIds.size > 0) sensitiveRequestDraftIdsByWindow.set(requestingWindow.id, requestIds);
    else sensitiveRequestDraftIdsByWindow.delete(requestingWindow.id);
  });
  ipcMain.on('zeus:session-context-activity-changed', (event, payload: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !payload || typeof payload !== 'object') return;
    const value = payload as { active?: unknown; kind?: unknown };
    const kind = value.kind;
    if (kind !== 'browser' && kind !== 'subagents' && kind !== 'plan' && kind !== 'source' && kind !== 'turn_diff' && kind !== 'none') return;
    sessionContextActivityByWindow.set(requestingWindow.id, { active: value.active === true && kind !== 'none', kind });
  });
  ipcMain.on('zeus:app-close-layer-activity-changed', (event, active: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !isTrustedZeusRendererWindow(requestingWindow) || typeof active !== 'boolean') return;
    if (active) appCloseLayerActivityByWindow.set(requestingWindow.id, true);
    else appCloseLayerActivityByWindow.delete(requestingWindow.id);
  });
  ipcMain.on('zeus:task-table-layout-close-resolution', (event, resolution: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
    const proceed = Boolean(resolution && typeof resolution === 'object' && (resolution as { proceed?: unknown }).proceed === true);
    if (!proceed) {
      pendingTaskTableLayoutWindowCloseIds.delete(requestingWindow.id);
      taskTableLayoutQuitPending = false;
      taskTableLayoutQuitApproved = false;
      return;
    }
    taskTableLayoutDirtyWindowIds.delete(requestingWindow.id);
    unsavedChangeKeysByWindow.delete(requestingWindow.id);
    taskTableLayoutCloseApprovedWindowIds.add(requestingWindow.id);
    if (taskTableLayoutQuitPending) {
      if (taskTableLayoutDirtyWindowIds.size === 0) {
        taskTableLayoutQuitApproved = true;
        taskTableLayoutQuitPending = false;
        app.quit();
      }
      return;
    }
    if (pendingTaskTableLayoutWindowCloseIds.delete(requestingWindow.id)) requestingWindow.close();
  });
  ipcMain.on('zeus:unsaved-changes-close-resolution', (event, resolution: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
    const proceed = Boolean(resolution && typeof resolution === 'object' && (resolution as { proceed?: unknown }).proceed === true);
    if (!proceed) {
      pendingTaskTableLayoutWindowCloseIds.delete(requestingWindow.id);
      taskTableLayoutQuitPending = false;
      taskTableLayoutQuitApproved = false;
      return;
    }
    taskTableLayoutDirtyWindowIds.delete(requestingWindow.id);
    unsavedChangeKeysByWindow.delete(requestingWindow.id);
    taskTableLayoutCloseApprovedWindowIds.add(requestingWindow.id);
    if (taskTableLayoutQuitPending) {
      if (taskTableLayoutDirtyWindowIds.size === 0) {
        taskTableLayoutQuitApproved = true;
        taskTableLayoutQuitPending = false;
        app.quit();
      }
      return;
    }
    if (pendingTaskTableLayoutWindowCloseIds.delete(requestingWindow.id)) requestingWindow.close();
  });
  ipcMain.handle('zeus:open-external-https-url', (event, url: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return { opened: false, error: 'external_open_untrusted_sender' };
    return openExternalHttpsUrl({
      url,
      openExternal: (url) => shell.openExternal(url),
    });
  });
  ipcMain.handle('zeus:activate-requesting-window', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return { activated: false, error: 'window_activation_untrusted_sender' };
    // 只允许 Renderer 激活自身所属窗口，登录完成后不能借 IPC 指定或抢占其他窗口。
    revealMainWindow(requestingWindow);
    return { activated: true };
  });
  ipcMain.handle('zeus:release:download-update', (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('Release update request came from an untrusted window.');
    if (!releaseUpdateService) throw new Error('Zeus release update service is not ready.');
    const service = releaseUpdateService;
    return activeMainCommandLedger().execute(request, 'desktop.release.download_update', async (_body, command) => {
      await command.markWriteStarted();
      return service.download();
    });
  });
  ipcMain.handle('zeus:release:install-update', async (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('Release update request came from an untrusted window.');
    if (!releaseUpdateService) throw new Error('Zeus release update service is not ready.');
    if (taskTableLayoutDirtyWindowIds.size > 0) {
      throw new Error('请先保存或放弃尚未保存的任务表布局，再安装更新。');
    }
    if ([...sensitiveRequestDraftIdsByWindow.values()].some((requestIds) => requestIds.size > 0)) {
      throw new Error('存在尚未提交的敏感回答。请先提交或清空敏感内容，再安装更新。');
    }
    const service = releaseUpdateService;
    const result = await activeMainCommandLedger().execute(request, 'desktop.release.install_update', async (_body, command) => {
      await command.markWriteStarted();
      return service.install();
    });
    return result;
  });
  ipcMain.handle('zeus:automatic-update-indicator:get', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('Automatic update status request came from an untrusted window.');
    return automaticUpdateIndicatorState ?? homebrewUpdateController?.getIndicatorState() ?? null;
  });
  ipcMain.handle('zeus:automatic-update-indicator:open', async (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('Automatic update open request came from an untrusted window.');
    const controller = homebrewUpdateController;
    const result = await activeMainCommandLedger().execute(request, 'desktop.automatic_update.open', async (_body, command) => {
      if (!controller) throw new Error('Automatic update controller is unavailable.');
      await command.markWriteStarted();
      await controller.showOrCheck();
      return { opened: true, externalOperationId: command.externalOperationId };
    });
    return result;
  });
  ipcMain.handle('zeus:automatic-update-indicator:record-manual-check', (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('Automatic update scheduling request came from an untrusted window.');
    const scheduler = automaticUpdateScheduler;
    return activeMainCommandLedger().execute(request, 'desktop.automatic_update.record_manual_check', async (_body, command) => {
      if (!scheduler) throw new Error('Automatic update scheduler is unavailable.');
      await command.markWriteStarted();
      scheduler.recordCheckCompleted();
      return { recorded: true };
    });
  });
  ipcMain.handle('zeus:conversation-resource:list-open-targets', (event, request: ConversationResourceRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) {
      throw new Error('Conversation resource request came from an untrusted window.');
    }
    return listConversationResourceOpenTargets(request, conversationResourceOpenServices(requestingWindow));
  });
  ipcMain.handle('zeus:conversation-resource:open', (event, request: OpenConversationResourceRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) {
      throw new Error('Conversation resource request came from an untrusted window.');
    }
    return openConversationResource(request, conversationResourceOpenServices(requestingWindow));
  });
  ipcMain.handle('zeus:turn-change-file:open', (event, request: OpenTurnChangeFileRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) {
      throw new Error('Turn change file request came from an untrusted window.');
    }
    return openTurnChangeFile(request, conversationResourceOpenServices(requestingWindow));
  });
  ipcMain.handle('zeus:window-drag-start', (event, point: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dragPoint = normalizeDragPoint(point);
    if (!window || window.isDestroyed() || window.isFullScreen() || !dragPoint) return { dragging: false };
    const [windowX, windowY] = window.getPosition();
    // Electron 的 app-region 在 hiddenInset + file:// asar 组合下可能不触发原生拖动；
    // Main 进程用真实屏幕坐标移动窗口，确保顶部空白区一定可拖。
    manualWindowDragStates.set(event.sender.id, {
      pointerX: dragPoint.screenX,
      pointerY: dragPoint.screenY,
      windowX,
      windowY,
    });
    return { dragging: true };
  });
  ipcMain.handle('zeus:window-drag-move', (event, point: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dragPoint = normalizeDragPoint(point);
    const dragState = manualWindowDragStates.get(event.sender.id);
    if (!window || window.isDestroyed() || window.isFullScreen() || !dragPoint || !dragState) return { dragging: false };
    const nextX = Math.round(dragState.windowX + dragPoint.screenX - dragState.pointerX);
    const nextY = Math.round(dragState.windowY + dragPoint.screenY - dragState.pointerY);
    window.setPosition(nextX, nextY, false);
    return { dragging: true, x: nextX, y: nextY };
  });
  ipcMain.handle('zeus:window-drag-end', (event) => {
    manualWindowDragStates.delete(event.sender.id);
    return { dragging: false };
  });
  ipcMain.handle('zeus:choose-project-directory', () =>
    chooseProjectDirectory(() =>
      dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: '选择 Zeus 项目代码库',
      }),
    ),
  );
  ipcMain.handle('zeus:choose-recovery-backup-destinations', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) {
      throw new Error('恢复包目的地选择请求来自不受信任窗口。');
    }
    return recoveryBackupDestinationPort.chooseExactlyTwoDirectories(requestingWindow);
  });
  ipcMain.handle('zeus:reveal-project-in-finder', (event, projectPath: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) {
      throw new Error('Project reveal request came from an untrusted window.');
    }
    return revealProjectPathInFinder(projectPath);
  });
  ipcMain.handle('zeus:choose-conversation-resources', async (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation resource picker is unavailable for this window.');
    }
    const selected = await dialog.showOpenDialog(requestingWindow, {
      title: '选择文件或文件夹',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    if (selected.canceled) return [];
    return conversationInputResources.describePaths(selected.filePaths, 'picker');
  });
  ipcMain.handle('zeus:authorize-conversation-files', async (event, paths: unknown, source: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation file authorization is unavailable for this window.');
    }
    const filePaths = Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
    const normalizedSource: ConversationInputResourceSource = source === 'drop' ? 'drop' : 'paste';
    return conversationInputResources.describePaths(filePaths, normalizedSource);
  });
  ipcMain.handle('zeus:materialize-conversation-resources', async (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation resource materialization is unavailable for this window.');
    }
    const broker = conversationInputResources;
    return activeMainCommandLedger().execute(request, 'desktop.conversation_resources.materialize', async (payloads, command) => {
      const normalized = Array.isArray(payloads) ? payloads.filter((payload): payload is ConversationResourcePayload => Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)) : [];
      await command.markWriteStarted();
      return broker.materialize(normalized, command.envelope.commandId);
    });
  });
  ipcMain.handle('zeus:read-conversation-clipboard-resources', async (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation clipboard access is unavailable for this window.');
    }
    const broker = conversationInputResources;
    return activeMainCommandLedger().execute(request, 'desktop.conversation_resources.read_clipboard', async (_body, command) => {
      await command.markWriteStarted();
      return broker.readClipboard(command.envelope.commandId);
    });
  });
  ipcMain.handle('zeus:get-conversation-resource-preview', async (event, resource: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation resource preview is unavailable for this window.');
    }
    const record = resource && typeof resource === 'object' && !Array.isArray(resource) ? (resource as { localPath?: string; uploadRef?: string }) : {};
    return conversationInputResources.preview(record);
  });
  ipcMain.handle('zeus:open-conversation-input-resource', async (event, resource: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      return { opened: false, error: 'conversation_input_resource_unavailable' };
    }
    const record = resource && typeof resource === 'object' && !Array.isArray(resource) ? (resource as { localPath?: string; uploadRef?: string }) : {};
    const path = await conversationInputResources.resolve(record);
    if (!path) return { opened: false, error: 'conversation_input_resource_not_allowed' };
    try {
      const openError = await shell.openPath(path);
      return openError ? { opened: false, error: openError } : { opened: true };
    } catch (error) {
      return { opened: false, error: error instanceof Error ? error.message : 'open_conversation_input_resource_failed' };
    }
  });
  ipcMain.handle('zeus:discard-conversation-resources', async (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation resource cleanup is unavailable for this window.');
    }
    const broker = conversationInputResources;
    return activeMainCommandLedger().execute(request, 'desktop.conversation_resources.discard', async (resources, command) => {
      const records = Array.isArray(resources) ? resources.flatMap((resource) => (resource && typeof resource === 'object' && !Array.isArray(resource) ? [resource as { localPath?: string; uploadRef?: string }] : [])) : [];
      await command.markWriteStarted();
      return broker.discard(records);
    });
  });
  ipcMain.handle('zeus:choose-task-attachments', async (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('任务附件选择来自不受信任窗口。');
    return activeMainCommandLedger().execute(request, 'desktop.task_resources.choose', async (_body, command) => {
      await command.markWriteStarted();
      const selected = await dialog.showOpenDialog(requestingWindow, {
        title: '选择文件或文件夹',
        properties: ['openFile', 'openDirectory', 'multiSelections'],
      });
      if (selected.canceled) return [];
      const resources = await saveTaskResourcePaths(selected.filePaths, command.envelope.commandId);
      if (selected.filePaths.length > 0 && resources.length === 0) {
        throw new Error('No selected task resources could be copied into Zeus storage.');
      }
      return resources;
    });
  });
  ipcMain.handle('zeus:store-task-resource-paths', (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('任务附件存储来自不受信任窗口。');
    return activeMainCommandLedger().execute(request, 'desktop.task_resources.store_paths', async (paths, command) => {
      await command.markWriteStarted();
      return saveTaskResourcePaths(Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [], command.envelope.commandId);
    });
  });
  ipcMain.handle('zeus:materialize-task-resources', (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('任务附件物化来自不受信任窗口。');
    return activeMainCommandLedger().execute(request, 'desktop.task_resources.materialize', async (resources, command) => {
      await command.markWriteStarted();
      return saveTaskAttachmentPayloads(Array.isArray(resources) ? (resources as TaskResourcePayload[]) : [], command.envelope.commandId);
    });
  });
  ipcMain.handle('zeus:read-task-clipboard-resources', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('任务剪贴板读取来自不受信任窗口。');
    return readTaskClipboardResourcesFromNativeClipboard();
  });
  ipcMain.handle('zeus:read-task-clipboard-attachments', () => readTaskClipboardAttachmentsFromNativeClipboard());
  ipcMain.handle('zeus:save-task-clipboard-attachments', async (event, request: MainCommandRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('任务剪贴板存储来自不受信任窗口。');
    return activeMainCommandLedger().execute(request, 'desktop.task_resources.save_clipboard', async (_body, command) => {
      const result = await readTaskClipboardResourcesFromNativeClipboard();
      await command.markWriteStarted();
      if (result.paths.length > 0) return saveTaskResourcePaths(result.paths, command.envelope.commandId);
      if (result.attachments.length > 0) return saveTaskAttachmentPayloads(result.attachments, command.envelope.commandId);
      return [];
    });
  });
  ipcMain.handle('zeus:write-clipboard-text', (_event, text: unknown) => {
    if (typeof text !== 'string') throw new TypeError('Clipboard text must be a string.');
    clipboard.writeText(text);
    return { written: clipboard.readText() === text };
  });
  ipcMain.handle('zeus:read-task-clipboard-image', async () => {
    const [firstAttachment] = await readTaskClipboardAttachmentsFromNativeClipboard();
    return firstAttachment ?? null;
  });
  ipcMain.handle('zeus:save-task-pasted-attachments', async (event, request: MainCommandRequest<TaskResourcePayload[]>) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('任务粘贴附件存储来自不受信任窗口。');
    return activeMainCommandLedger().execute(request, 'desktop.task_resources.save_pasted', async (attachments, command) => {
      await command.markWriteStarted();
      return saveTaskAttachmentPayloads(Array.isArray(attachments) ? attachments : [], command.envelope.commandId);
    });
  });
  ipcMain.handle('zeus:get-task-attachment-preview', (_event, path: string) => loadSavedTaskAttachmentPreview(path));
  ipcMain.handle('zeus:open-task-attachment', (_event, path: string) => openSavedTaskAttachment(path));
  ipcMain.handle('zeus:zentao:parse-link', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !url.trim()) return { kind: 'unsupported', sourceUrl: typeof url === 'string' ? url : '' };
    return extractZentaoTaskInfo(url.trim(), await loadZentaoExtractServices());
  });
  ipcMain.handle('zeus:export-settings-snapshot', (_event, snapshot: unknown) =>
    exportSettingsSnapshotToFile({
      snapshot,
      chooseFile: () =>
        dialog.showSaveDialog({
          title: '导出 Zeus 设置快照',
          defaultPath: 'zeus-settings.json',
          filters: [{ name: 'Zeus Settings JSON', extensions: ['json'] }],
        }),
      writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:import-settings-snapshot', () =>
    importSettingsSnapshotFromFile({
      chooseFile: () =>
        dialog.showOpenDialog({
          title: '导入 Zeus 设置快照',
          properties: ['openFile'],
          filters: [{ name: 'Zeus Settings JSON', extensions: ['json'] }],
        }),
      readTextFile: (path) => readFile(path, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:import-business-data-snapshot', () =>
    importBusinessDataSnapshotFromFile({
      chooseFile: () =>
        dialog.showOpenDialog({
          title: '导入 Zeus 业务数据快照',
          properties: ['openFile'],
          filters: [{ name: 'Zeus Business Data JSON', extensions: ['json'] }],
        }),
      readTextFile: (path) => readFile(path, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:clear-network-cache', async (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('Network cache cleanup is unavailable for this window.');
    await session.defaultSession.clearCache();
    return { cleared: true, clearedAt: new Date().toISOString() };
  });
  ipcMain.handle('zeus:export-patch', (_event, patch: unknown) =>
    exportPatchToFile({
      patch: patch as { fileName: string; mimeType: string; patchText: string },
      chooseFile: () =>
        dialog.showSaveDialog({
          title: '导出 Zeus Patch',
          defaultPath: (patch as { fileName?: string }).fileName ?? 'zeus-diff.patch',
          filters: [{ name: 'Patch File', extensions: ['patch'] }],
        }),
      writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:open-graph-source', (_event, source: GraphSourceLocation) =>
    openGraphSourceLocation({
      projectRoot: resolveMainProjectRoot(),
      source,
      // 只检查文件存在性，不读取内容；打开动作交由 macOS 默认编辑器或文件关联处理。
      fileExists: async (filePath) => {
        try {
          await access(filePath);
          return true;
        } catch {
          return false;
        }
      },
      openPath: (filePath) => shell.openPath(filePath),
    }),
  );
  ipcMain.handle('zeus:export-mermaid-diagram', (_event, payload: unknown) =>
    exportMermaidDiagramToFile({
      payload: payload as {
        fileName: string;
        mimeType: string;
        content: string;
      },
      chooseFile: () =>
        dialog.showSaveDialog({
          title: '导出 Mermaid 源码',
          defaultPath: (payload as { fileName?: string }).fileName ?? 'zeus-graph.mmd',
          filters: [{ name: 'Mermaid Diagram', extensions: ['mmd'] }],
        }),
      writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:export-plantuml-diagram', (_event, payload: unknown) =>
    exportPlantUmlDiagramToFile({
      payload: payload as {
        fileName: string;
        mimeType: string;
        content: string;
      },
      chooseFile: () =>
        dialog.showSaveDialog({
          title: '导出 PlantUML 源码',
          defaultPath: (payload as { fileName?: string }).fileName ?? 'zeus-graph.puml',
          filters: [{ name: 'PlantUML Diagram', extensions: ['puml', 'plantuml'] }],
        }),
      writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:export-runtime-logs', (_event, payload: unknown) =>
    exportRuntimeLogsToFile({
      payload: payload as {
        fileName: string;
        mimeType: string;
        sessionId: string;
        sourceFilePath?: string;
        logs: Array<{ createdAt: string; stream: string; text: string }>;
      },
      chooseFile: () =>
        dialog.showSaveDialog({
          title: '导出 Zeus Runtime 日志',
          defaultPath: (payload as { fileName?: string }).fileName ?? 'zeus-runtime.log',
          filters: [{ name: 'Runtime Log', extensions: ['log', 'txt'] }],
        }),
      isAllowedSourceFile: isRuntimeLogSourcePathAllowed,
      readTextFile: (path) => readFile(path, 'utf8'),
      writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:app-shell-settings-changed', (_event, settings: Partial<MainAppShellSettings> & { appearance?: unknown }) => {
    appShellSettings = {
      appLanguage: settings.appLanguage === 'en-US' ? 'en-US' : 'zh-CN',
      webviewDebugEnabled: settings.webviewDebugEnabled === true,
      multiWindowEnabled: typeof settings.multiWindowEnabled === 'boolean' ? settings.multiWindowEnabled : appShellSettings.multiWindowEnabled,
      backgroundModeEnabled: typeof settings.backgroundModeEnabled === 'boolean' ? settings.backgroundModeEnabled : appShellSettings.backgroundModeEnabled,
      desktopNotificationsEnabled: typeof settings.desktopNotificationsEnabled === 'boolean' ? settings.desktopNotificationsEnabled : appShellSettings.desktopNotificationsEnabled,
      openAtLoginEnabled: typeof settings.openAtLoginEnabled === 'boolean' ? settings.openAtLoginEnabled : appShellSettings.openAtLoginEnabled,
    };
    const deliveryAppearance = settings.appearance === 'light' || settings.appearance === 'dark' ? settings.appearance : 'system';
    for (const window of taskGitDeliveryWindows.values()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('zeus:task-git-delivery:appearance', { language: appShellSettings.appLanguage, appearance: deliveryAppearance });
      }
    }
    if (menuBarUsageWindow && !menuBarUsageWindow.isDestroyed() && !menuBarUsageWindow.webContents.isDestroyed()) {
      menuBarUsageWindow.webContents.send('zeus:menu-bar-usage:settings', { language: appShellSettings.appLanguage, appearance: deliveryAppearance });
    }
    setupMenu();
    setupTraySafely();
    applySystemNotificationBridge();
    applyLoginItemSettings();
    return { applied: true };
  });
  ipcMain.handle('zeus:requesting-window-foreground', (event) => ({
    foreground: isRequestingWindowForeground(BrowserWindow.fromWebContents(event.sender)),
  }));
  browserHost?.registerIpc();
}

/** 解析 Telegram 白名单，非法值直接忽略，避免把错误配置当作授权用户。 */
function parseTelegramAllowedUserIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item));
}

function requireMenuBarUsageWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const requestingWindow = BrowserWindow.fromWebContents(event.sender);
  if (!requestingWindow || requestingWindow.isDestroyed() || requestingWindow !== menuBarUsageWindow) {
    throw new Error('菜单栏用量浮窗请求来自不受信任窗口。');
  }
  return requestingWindow;
}

function cancelMenuBarUsageWindowBlurHide(): void {
  if (!menuBarUsageWindowBlurTimer) return;
  clearTimeout(menuBarUsageWindowBlurTimer);
  menuBarUsageWindowBlurTimer = undefined;
}

function hideMenuBarUsageWindow(): void {
  cancelMenuBarUsageWindowBlurHide();
  if (menuBarUsageWindow && !menuBarUsageWindow.isDestroyed()) menuBarUsageWindow.hide();
}

function scheduleMenuBarUsageWindowBlurHide(window: BrowserWindow): void {
  cancelMenuBarUsageWindowBlurHide();
  menuBarUsageWindowBlurTimer = setTimeout(() => {
    menuBarUsageWindowBlurTimer = undefined;
    if (menuBarUsageWindow === window && !window.isDestroyed()) window.hide();
  }, menuBarUsageWindowBlurDelayMs);
}

function isFiniteScreenPoint(point: Electron.Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isUsableTrayBounds(bounds: Electron.Rectangle): boolean {
  return Number.isFinite(bounds.x) && Number.isFinite(bounds.y) && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0;
}

function resolveMenuBarUsageWindowPlacement(anchor: MenuBarUsageClickAnchor): MenuBarUsageWindowPlacement | undefined {
  const useBounds = isUsableTrayBounds(anchor.bounds);
  if (!useBounds && !isFiniteScreenPoint(anchor.position)) return undefined;

  const anchorX = useBounds ? anchor.bounds.x + anchor.bounds.width / 2 : anchor.position.x;
  const anchorY = useBounds ? anchor.bounds.y + anchor.bounds.height / 2 : anchor.position.y;
  const display = screen.getDisplayNearestPoint({ x: Math.round(anchorX), y: Math.round(anchorY) });
  const { workArea } = display;
  const preferredX = Math.round(anchorX - menuBarUsageWindowSize.width / 2);
  const minX = workArea.x + menuBarUsageWindowGap;
  const maxX = workArea.x + workArea.width - menuBarUsageWindowSize.width - menuBarUsageWindowGap;
  const minY = workArea.y + menuBarUsageWindowGap;
  const maxY = workArea.y + workArea.height - menuBarUsageWindowSize.height - menuBarUsageWindowGap;
  const belowTrayY = useBounds ? Math.round(anchor.bounds.y + anchor.bounds.height + menuBarUsageWindowGap) : minY;
  const preferredY = belowTrayY <= maxY ? belowTrayY : useBounds ? Math.round(anchor.bounds.y - menuBarUsageWindowSize.height - menuBarUsageWindowGap) : minY;

  return {
    anchorSource: useBounds ? 'bounds' : 'position',
    display,
    x: Math.min(Math.max(preferredX, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(preferredY, minY), Math.max(minY, maxY)),
  };
}

function positionMenuBarUsageWindow(window: BrowserWindow, placement: MenuBarUsageWindowPlacement): void {
  window.setPosition(placement.x, placement.y, false);
}

async function createMenuBarUsageWindow(): Promise<BrowserWindow> {
  if (menuBarUsageWindow && !menuBarUsageWindow.isDestroyed()) return menuBarUsageWindow;
  const window = new BrowserWindow({
    ...menuBarUsageWindowSize,
    title: appShellSettings.appLanguage === 'zh-CN' ? 'Zeus 用量' : 'Zeus Usage',
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: join(desktopRoot(), 'dist/preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  menuBarUsageWindow = window;
  window.setAlwaysOnTop(true, 'pop-up-menu');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.on('blur', () => scheduleMenuBarUsageWindowBlurHide(window));
  window.on('focus', () => cancelMenuBarUsageWindowBlurHide());
  window.on('closed', () => {
    cancelMenuBarUsageWindowBlurHide();
    appCloseLayerActivityByWindow.delete(window.id);
    if (menuBarUsageWindow === window) menuBarUsageWindow = undefined;
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) console.warn(`Zeus 菜单栏用量浮窗加载失败：${validatedUrl} ${errorDescription} (${errorCode})`);
  });
  const rendererUrl = rendererEntryUrl('menu-bar-usage');
  configureWindowSecurity(window, rendererUrl);
  try {
    await window.loadURL(rendererUrl);
    return window;
  } catch (error) {
    window.destroy();
    throw error;
  }
}

async function toggleMenuBarUsageWindow(anchor: MenuBarUsageClickAnchor): Promise<void> {
  if (fatalStartup) return;
  const window = await createMenuBarUsageWindow();
  const placement = resolveMenuBarUsageWindowPlacement(anchor);
  if (!placement) {
    console.warn('Zeus 菜单栏用量浮窗无法解析本次点击位置。', { bounds: anchor.bounds, position: anchor.position });
    return;
  }
  const wasVisible = window.isVisible();
  if (wasVisible && screen.getDisplayMatching(window.getBounds()).id === placement.display.id) {
    window.hide();
    return;
  }
  positionMenuBarUsageWindow(window, placement);
  window.show();
  window.focus();
  console.info(
    'Zeus menu bar usage window placement',
    JSON.stringify({
      action: wasVisible ? 'move' : 'show',
      targetDisplayId: placement.display.id,
      anchorSource: placement.anchorSource,
      clickBounds: anchor.bounds,
      clickPosition: anchor.position,
      windowBounds: window.getBounds(),
    }),
  );
}

function setupTray(): void {
  if (!tray) {
    const trayIconPath = join(desktopRoot(), 'assets/trayTemplate.png');
    const trayIcon = nativeImage.createFromBuffer(readFileSync(trayIconPath));
    if (trayIcon.isEmpty()) throw new Error(`Zeus tray icon is empty: ${trayIconPath}`);
    trayIcon.setTemplateImage(true);
    tray = new Tray(trayIcon);
    tray.setToolTip('Zeus');
    tray.setIgnoreDoubleClickEvents(true);
  }
  menuBarUsageMenu = Menu.buildFromTemplate(
    buildMenuBarTrayTemplate({
      settings: appShellSettings,
      showMainWindow: () => {
        hideMenuBarUsageWindow();
        void requestMainWindow();
      },
      createWindow: () => {
        hideMenuBarUsageWindow();
        if (fatalStartup) return;
        void createWindow().catch((error: unknown) => {
          void startupCoordinator.fail(error);
        });
      },
      quit: () => app.quit(),
    }) as Electron.MenuItemConstructorOptions[],
  );
  tray.removeAllListeners('click');
  tray.removeAllListeners('right-click');
  tray.on('click', (_event, bounds, position) => {
    cancelMenuBarUsageWindowBlurHide();
    const clickAnchor: MenuBarUsageClickAnchor = {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      position: { x: position.x, y: position.y },
    };
    void toggleMenuBarUsageWindow(clickAnchor).catch((error: unknown) => console.warn('Zeus 菜单栏用量浮窗无法打开。', error));
  });
  tray.on('right-click', () => {
    hideMenuBarUsageWindow();
    if (menuBarUsageMenu) tray?.popUpContextMenu(menuBarUsageMenu);
  });
}

function setupTraySafely(): void {
  try {
    setupTray();
  } catch (error) {
    tray = undefined;
    // 托盘图标缺失或 macOS 拒绝创建 Tray 时，不阻断设置保存和主窗口功能。
    console.warn('Zeus tray is unavailable; continuing without menu bar tray.', error);
  }
}

function isImageAttachmentPath(filePath: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic'].includes(extname(filePath).toLowerCase());
}

type TaskStoredResourceKind = 'image' | 'file' | 'directory' | 'pasted_text';

type TaskStoredResource = {
  path: string;
  name: string;
  kind: TaskStoredResourceKind;
  mimeType?: string;
  size?: number;
  characterCount?: number;
  previewUrl?: string;
  restorableText?: string;
};

type TaskResourcePayload = {
  name?: string;
  type?: string;
  data?: ArrayBuffer | Uint8Array;
  text?: string;
  kind?: TaskStoredResourceKind;
};

type TaskClipboardResourceRead = {
  paths: string[];
  attachments: TaskResourcePayload[];
  text: string;
};

const maximumTaskResourceCount = 100;
const maximumTaskResourceBytes = 100 * 1024 * 1024;
const maximumTaskResourceBatchBytes = 256 * 1024 * 1024;
const maximumTaskDirectoryEntries = 2_000;
const maximumTaskRestorableTextCharacters = 25_000;
const taskLongPasteThreshold = 5_000;

function taskAttachmentDirectory(): string {
  return activeZeusDataLayout().taskAttachments;
}

function isInsideTaskAttachmentDirectory(filePath: string): boolean {
  const directory = taskAttachmentDirectory();
  const resolvedDirectory = resolve(directory);
  const resolvedFilePath = resolve(filePath);
  const relativePath = relative(resolvedDirectory, resolvedFilePath);
  return relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function sanitizeTaskAttachmentFileName(fileName: string): string {
  const safeName = basename(fileName)
    .replace(/[^\p{L}\p{N}._ ()[\]-]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
  // 文件名为空或只有非法字符时保留稳定 fallback，避免 userData 附件目录出现不可读文件。
  return safeName || 'pasted-task-attachment';
}

function readTaskClipboardAttachmentsFromNativeClipboard(): Promise<TaskClipboardAttachmentPayload[]> {
  return readTaskClipboardAttachmentsFromClipboard(
    {
      readImage: () => clipboard.readImage(),
      availableFormats: () => clipboard.availableFormats(),
      readBuffer: (format) => clipboard.readBuffer(format),
      readText: () => clipboard.readText(),
      readHTML: () => clipboard.readHTML(),
    },
    {
      readSystemFileReferences: readMacOSClipboardFileReferences,
    },
  );
}

async function readTaskClipboardResourcesFromNativeClipboard(): Promise<TaskClipboardResourceRead> {
  const clipboardReader = {
    readImage: () => clipboard.readImage(),
    availableFormats: () => clipboard.availableFormats(),
    readBuffer: (format: string) => clipboard.readBuffer(format),
    readText: () => clipboard.readText(),
    readHTML: () => clipboard.readHTML(),
  };
  const readOptions = { readSystemFileReferences: readMacOSClipboardFileReferences };
  const referencedPaths = await readTaskClipboardFileReferencesFromClipboard(clipboardReader, readOptions);
  if (referencedPaths.length > 0) {
    return { paths: referencedPaths, attachments: [], text: '' };
  }
  const attachments = await readTaskClipboardAttachmentsFromClipboard(clipboardReader, readOptions);
  if (attachments.length > 0) {
    return { paths: [], attachments, text: '' };
  }
  let text = '';
  try {
    text = clipboard.readText();
  } catch {
    // 剪贴板文字读取失败时按空内容处理，保留用户当前任务表单。
  }
  if (text.length >= taskLongPasteThreshold) {
    return {
      paths: [],
      attachments: [{ name: 'Pasted text.txt', type: 'text/plain', text, kind: 'pasted_text' }],
      text: '',
    };
  }
  return { paths: [], attachments: [], text };
}

async function readMacOSClipboardFileReferences(): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await execFile(
      '/usr/bin/osascript',
      [
        '-e',
        `try
  set fileReference to the clipboard as «class furl»
  return POSIX path of fileReference
on error
  return ""
end try`,
      ],
      { timeout: 1000, maxBuffer: 64 * 1024 },
    );
    return stdout
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/'));
  } catch {
    // Finder 复制文件时 Electron 可能只暴露文件图标；osascript 读不到 furl 时继续走 bitmap 回退。
    return [];
  }
}

async function loadSavedTaskAttachmentPreview(path: string): Promise<{ previewUrl: string; mimeType: string } | null> {
  if (typeof path !== 'string' || !isInsideTaskAttachmentDirectory(path)) return null;
  const mimeType = inferTaskClipboardAttachmentMimeType(path);
  if (!mimeType.startsWith('image/')) return null;
  const data = await readFile(path);
  const previewUrl = buildTaskAttachmentPreviewDataUrl(data, mimeType);
  return previewUrl ? { previewUrl, mimeType } : null;
}

async function openSavedTaskAttachment(path: string): Promise<{ opened: boolean; error?: string }> {
  if (typeof path !== 'string' || !isInsideTaskAttachmentDirectory(path)) return { opened: false, error: 'attachment_not_allowed' };
  try {
    const openError = await shell.openPath(path);
    return openError ? { opened: false, error: openError } : { opened: true };
  } catch (error) {
    return { opened: false, error: error instanceof Error ? error.message : 'open_attachment_failed' };
  }
}

function taskCommandResourceKey(commandId: string): string {
  if (typeof commandId !== 'string' || !commandId.trim() || commandId.length > 256 || commandId.includes('\0')) throw new TypeError('Task resource command identity is invalid.');
  return `command-${createHash('sha256').update(commandId).digest('hex').slice(0, 24)}`;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishTaskResourceFile(staging: string, destination: string, parentDirectory: string): Promise<void> {
  // 同一目录 hard-link 发布是原子 no-replace；不会覆盖检查后被并发创建的目标。
  await link(staging, destination);
  await unlink(staging);
  await syncDirectory(parentDirectory);
}

async function publishTaskResourceDirectory(staging: string, destination: string, parentDirectory: string): Promise<void> {
  // Node 没有暴露 renameat2(RENAME_NOREPLACE)。以同目录 O_EXCL claim 串行化协作写者，
  // 在 claim 内再次核对目标不存在，再原子 rename 发布完整目录树。
  const claimPath = join(parentDirectory, `.${basename(destination)}.cas-lock`);
  const claim = await open(claimPath, 'wx', 0o600);
  try {
    await claim.writeFile(`${basename(destination)}\n`);
    await claim.sync();
  } finally {
    await claim.close();
  }
  await syncDirectory(parentDirectory);
  try {
    const destinationExists = await lstat(destination).then(
      () => true,
      (error: unknown) => {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      },
    );
    if (destinationExists) {
      throw Object.assign(new Error('Task resource directory CAS destination already exists.'), { code: 'EEXIST' });
    }
    await rename(staging, destination);
    await syncDirectory(parentDirectory);
  } finally {
    await unlink(claimPath).catch(() => undefined);
    await syncDirectory(parentDirectory);
  }
}

async function hardenAndSyncTaskResourceTree(root: string): Promise<void> {
  const directories = [root];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const entryStat = await lstat(path);
      if (entryStat.isSymbolicLink()) throw new Error('Task attachment staging tree contains a symbolic link.');
      if (entryStat.isDirectory()) {
        directories.push(path);
        pending.push(path);
      } else if (entryStat.isFile()) {
        await chmod(path, 0o600);
        await syncFile(path);
      } else {
        throw new Error('Task attachment staging tree contains an unsupported entry.');
      }
    }
  }
  for (const directory of directories.reverse()) await syncDirectory(directory);
}

async function saveTaskResourcePaths(paths: string[], commandId: string): Promise<TaskStoredResource[]> {
  if (paths.length === 0) return [];
  const attachmentDirectory = taskAttachmentDirectory();
  await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
  const operationKey = taskCommandResourceKey(commandId);
  const resources: TaskStoredResource[] = [];
  const seen = new Set<string>();
  let batchBytes = 0;
  for (const [index, path] of paths.slice(0, maximumTaskResourceCount).entries()) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) continue;
    try {
      const canonicalPath = await realpath(path);
      if (seen.has(canonicalPath)) continue;
      seen.add(canonicalPath);
      const sourceStat = await lstat(canonicalPath);
      if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory())) continue;
      const summary = sourceStat.isDirectory() ? await inspectTaskResourceTree(canonicalPath) : { bytes: sourceStat.size, entries: 1 };
      if (summary.bytes > maximumTaskResourceBytes || batchBytes + summary.bytes > maximumTaskResourceBatchBytes) {
        continue;
      }
      batchBytes += summary.bytes;
      const safeName = sanitizeTaskAttachmentFileName(basename(canonicalPath) || 'task-resource');
      const destination = join(attachmentDirectory, `${operationKey}-${index + 1}-${safeName}`);
      const staging = join(attachmentDirectory, `.${basename(destination)}.${randomUUID()}.tmp`);
      if (sourceStat.isDirectory()) {
        try {
          await cp(canonicalPath, staging, {
            recursive: true,
            errorOnExist: true,
            force: false,
            filter: async (source) => !(await lstat(source)).isSymbolicLink(),
          });
          await hardenAndSyncTaskResourceTree(staging);
          await publishTaskResourceDirectory(staging, destination, attachmentDirectory);
        } catch (error) {
          await rm(staging, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        resources.push({
          path: destination,
          name: safeName,
          kind: 'directory',
          mimeType: 'inode/directory',
          size: summary.bytes,
        });
        continue;
      }
      try {
        await copyFile(canonicalPath, staging, fsConstants.COPYFILE_EXCL);
        await chmod(staging, 0o600);
        await syncFile(staging);
        await publishTaskResourceFile(staging, destination, attachmentDirectory);
      } catch (error) {
        await unlink(staging).catch(() => undefined);
        throw error;
      }
      const mimeType = inferTaskClipboardAttachmentMimeType(destination);
      const kind = mimeType.startsWith('image/') || isImageAttachmentPath(destination) ? 'image' : 'file';
      const previewUrl = kind === 'image' && sourceStat.size <= maximumTaskResourceBytes ? buildTaskAttachmentPreviewDataUrl(await readFile(destination), mimeType) : undefined;
      resources.push({
        path: destination,
        name: safeName,
        kind,
        mimeType,
        size: sourceStat.size,
        ...(previewUrl ? { previewUrl } : {}),
      });
    } catch {
      // 单个文件、目录或复制动作失败时保留同批次中的其他可用资源。
    }
  }
  return resources;
}

async function inspectTaskResourceTree(rootPath: string): Promise<{ bytes: number; entries: number }> {
  const pending = [rootPath];
  let bytes = 0;
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) throw new Error('Task attachment directories cannot contain symbolic links.');
      entries += 1;
      if (entries > maximumTaskDirectoryEntries) throw new Error('Task attachment directory contains too many entries.');
      if (entryStat.isDirectory()) pending.push(entryPath);
      else if (entryStat.isFile()) bytes += entryStat.size;
      else throw new Error('Task attachment directory contains an unsupported entry.');
      if (bytes > maximumTaskResourceBytes) throw new Error('Task attachment directory is too large.');
    }
  }
  return { bytes, entries };
}

async function saveTaskAttachmentPayloads(attachments: TaskResourcePayload[], commandId: string): Promise<TaskStoredResource[]> {
  if (attachments.length === 0) return [];
  const attachmentDirectory = taskAttachmentDirectory();
  await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
  const operationKey = taskCommandResourceKey(commandId);
  const savedAttachments: TaskStoredResource[] = [];
  let batchBytes = 0;
  for (const [index, attachment] of attachments.slice(0, maximumTaskResourceCount).entries()) {
    const text = typeof attachment?.text === 'string' ? attachment.text : undefined;
    const attachmentBuffer = text === undefined ? coerceTaskClipboardAttachmentBuffer(attachment?.data) : Buffer.from(text, 'utf8');
    if (!attachment || !attachmentBuffer || attachmentBuffer.byteLength === 0) continue;
    if (attachmentBuffer.byteLength > maximumTaskResourceBytes || batchBytes + attachmentBuffer.byteLength > maximumTaskResourceBatchBytes) {
      continue;
    }
    batchBytes += attachmentBuffer.byteLength;
    const safeName = sanitizeTaskAttachmentFileName(attachment.name || `pasted-task-attachment-${index + 1}`);
    const contentHash = createHash('sha256').update(attachmentBuffer).digest('hex');
    const filePath = join(attachmentDirectory, `${operationKey}-${index + 1}-${contentHash.slice(0, 16)}-${safeName}`);
    const staging = join(attachmentDirectory, `.${basename(filePath)}.${randomUUID()}.tmp`);
    // 粘贴得到的是剪贴板二进制内容；Main 进程落到本机 userData 后，只把路径回传给任务上下文。
    const handle = await open(staging, 'wx', 0o600);
    try {
      await handle.writeFile(attachmentBuffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await publishTaskResourceFile(staging, filePath, attachmentDirectory);
    } catch (error) {
      await unlink(staging).catch(() => undefined);
      throw error;
    }
    const mimeType = attachment.type || inferTaskClipboardAttachmentMimeType(filePath);
    const pastedText = text !== undefined || attachment.kind === 'pasted_text';
    const kind: TaskStoredResourceKind = pastedText ? 'pasted_text' : mimeType.startsWith('image/') || isImageAttachmentPath(filePath) ? 'image' : 'file';
    savedAttachments.push({
      path: filePath,
      name: safeName,
      kind,
      mimeType,
      size: attachmentBuffer.byteLength,
      ...(pastedText ? { characterCount: text?.length ?? 0 } : {}),
      ...(pastedText && text !== undefined && text.length <= maximumTaskRestorableTextCharacters ? { restorableText: text } : {}),
      ...(kind === 'image' ? { previewUrl: buildTaskAttachmentPreviewDataUrl(attachmentBuffer, mimeType) } : {}),
    });
  }
  return savedAttachments;
}

async function initializeApplication(): Promise<void> {
  traceApplicationStartup('initialization_started');
  await app.whenReady();
  traceApplicationStartup('electron_ready');
  if (readOnlyValidationDescriptor) {
    await verifyDesktopReadOnlyValidationDescriptor(readOnlyValidationDescriptor);
    installReadOnlyValidationIpcFence(ipcMain, readOnlyValidationDescriptor);
    traceApplicationStartup('read_only_validation_verified');
  }
  setupIpc();
  // 窗口与本地服务并行启动：HTML 启动界面先出现，Renderer 会等待真实服务配置后再挂载业务界面。
  const initialWindowPromise = createWindow();
  void initialWindowPromise.catch(() => undefined);
  traceApplicationStartup('initial_window_requested');
  try {
    if (dataRootPreparationError !== undefined) {
      rejectRendererStartupDisposition(dataRootPreparationError);
      rejectRendererRuntimeReady(dataRootPreparationError);
      await initialWindowPromise;
      throw dataRootPreparationError;
    }
    const dataLayout = activeZeusDataLayout();
    const userDataPath = dataLayout.root;
    const browserAttachmentRoot = dataLayout.browserComments;
    const conversationAttachmentRoot = dataLayout.conversationAttachments;
    const conversationAttachmentGrantSecretPath = dataLayout.conversationAttachmentGrantSecret;
    const conversationAttachmentGrantSecret = readOnlyValidationDescriptor
      ? createHash('sha256').update(`zeus-read-only-validation-grant:${readOnlyValidationDescriptor.runId}:${readOnlyValidationDescriptor.manifestHash}`).digest('base64url')
      : await readOrCreateConversationAttachmentGrantSecret(conversationAttachmentGrantSecretPath);
    if (!readOnlyValidationDescriptor) {
      conversationInputResources = createConversationInputResourceBroker({
        attachmentRoot: conversationAttachmentRoot,
        grantSecret: conversationAttachmentGrantSecret,
        clipboard: {
          readImage: () => clipboard.readImage(),
          availableFormats: () => clipboard.availableFormats(),
          readBuffer: (format) => clipboard.readBuffer(format),
          readText: () => clipboard.readText(),
          readHTML: () => clipboard.readHTML(),
        },
        clipboardReadOptions: { readSystemFileReferences: readMacOSClipboardFileReferences },
      });
    }
    browserHost = createBrowserHost({
      statePath: dataLayout.browserState,
      preloadPath: join(desktopRoot(), 'dist/preload/browser-page.cjs'),
      attachmentRoot: browserAttachmentRoot,
      defaultDownloadDirectory: dataLayout.browserDownloads,
      openExternal: (url) => shell.openExternal(url),
      mainCommandLedger: activeMainCommandLedger,
      legacySystemDownloadDirectory: app.getPath('downloads'),
      readOnlyValidation: Boolean(readOnlyValidationDescriptor),
    });
    for (const window of windows) browserHost.registerWindow(window);
    browserHost.registerIpc();
    traceApplicationStartup('local_resources_ready');
    const mainProjectRoot = readOnlyValidationDescriptor?.validationRoot ?? resolveMainProjectRoot();
    const codexNativeEnabled = !readOnlyValidationDescriptor && process.env.ZEUS_CODEX_NATIVE_ENABLED !== '0';
    const allowUntrustedReleaseUpdateTest = !readOnlyValidationDescriptor && isTestDistribution() && process.env.ZEUS_ALLOW_UNTRUSTED_UPDATE_TEST === '1';
    const keychainService = activeDesktopKeychainService();
    // Main 只持有窗口、BrowserHost 与短期连接凭据；独立 Zeus Core 是唯一业务 SQLite 写入者。
    const { startDesktopLocalServer } = await import('./localServerRuntime.js');
    traceApplicationStartup('local_server_module_ready');
    localServerRuntime = await startDesktopLocalServer({
      userDataPath,
      dataLayout,
      projectRoot: mainProjectRoot,
      dataRootIdentity: zeusDataRootHostIdentity(activeDataRootIdentity()),
      appVersion: app.getVersion(),
      keychainService,
      telegramToken: readOnlyValidationDescriptor ? undefined : process.env.ZEUS_TELEGRAM_BOT_TOKEN,
      telegramAllowedUserIds: readOnlyValidationDescriptor ? undefined : parseTelegramAllowedUserIds(process.env.ZEUS_TELEGRAM_ALLOWED_USER_IDS),
      codexNativeEnabled,
      codexLegacyImportRoot: readOnlyValidationDescriptor ? undefined : dataLayout.codexLegacyImports,
      codexHome: readOnlyValidationDescriptor ? undefined : dataLayout.codexHome,
      codexConfigImportSourceRoot: readOnlyValidationDescriptor ? undefined : join(homedir(), '.codex'),
      releaseUpdateManifestUrl: allowUntrustedReleaseUpdateTest ? process.env.ZEUS_RELEASE_UPDATE_MANIFEST_URL : undefined,
      allowUntrustedReleaseUpdateTest,
      taskAttachmentRoot: dataLayout.taskAttachments,
      browserAttachmentRoot,
      conversationAttachmentRoot,
      conversationAttachmentGrantSecret,
      conversationAttachmentGrantSecretPath,
      browserAutomation: browserHost,
      readOnlyValidation: readOnlyValidationDescriptor,
      onRestarted: () => {
        // 本地服务异常重启后，依赖旧 WebSocket 的系统通知桥必须重建，避免继续挂在旧端口。
        if (!readOnlyValidationDescriptor) applySystemNotificationBridge();
        for (const window of [...windows, ...taskGitDeliveryWindows.values()]) {
          if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
          // 宿主端点完成交接后由 Main 刷新真实 BrowserWindow，避免 Renderer 自导航留下空白页。
          window.webContents.reloadIgnoringCache();
        }
      },
    });
    traceApplicationStartup('local_server_ready');
    if (!readOnlyValidationDescriptor) {
      projectSourceWorkspace = new ProjectSourceWorkspaceService({
        loadProjectRoot: loadProjectRootForSourceWorkspace,
        trashItem: (path) => shell.trashItem(path),
      });
      projectGitWorkbench = new ProjectGitWorkbenchService(loadProjectIdentity);
    }
    if (app.isPackaged && !readOnlyValidationDescriptor) {
      releaseUpdateService = createReleaseUpdateService({
        userDataPath,
        currentAppPath: currentAppBundlePath(),
        currentExecutablePath: process.execPath,
        currentAppVersion: app.getVersion(),
        localServerConfig: () => {
          if (!localServerRuntime) throw new Error('Zeus local server is not ready.');
          return localServerRuntime.config;
        },
        isPackaged: true,
        testMode: isTestDistribution(),
        allowUntrustedTestUpdate: allowUntrustedReleaseUpdateTest,
        onInstallReady: requestUpgradeHandoffQuit,
      });
      homebrewUpdateController = createHomebrewUpdateController({
        helperPath: nativeUpdateProgressHelperPath(),
        language: () => appShellSettings.appLanguage,
        loadUpdateStatus: () => {
          if (!releaseUpdateService) throw new Error('Zeus 发布更新服务尚未就绪。');
          return releaseUpdateService.check();
        },
        homebrew: createHomebrewUpdateService({
          currentAppPath: currentAppBundlePath(),
          currentAppVersion: app.getVersion(),
          bundleId: isTestDistribution() ? 'dev.hypha.zeus.test' : 'dev.hypha.zeus',
          testMode: isTestDistribution(),
        }),
        currentVersion: app.getVersion(),
        canInstall: () => {
          if (taskTableLayoutDirtyWindowIds.size > 0 || [...unsavedChangeKeysByWindow.values()].some((keys) => keys.size > 0)) {
            throw new Error('请先保存或放弃尚未保存的界面更改，再安装更新。');
          }
          if ([...sensitiveRequestDraftIdsByWindow.values()].some((requestIds) => requestIds.size > 0)) {
            throw new Error('存在尚未提交的敏感回答。请先提交或清空敏感内容，再安装更新。');
          }
        },
        onInstallReady: requestUpgradeHandoffQuit,
      });
    }
    appShellSettings = await loadMainAppShellSettings(localServerRuntime.config);
    traceApplicationStartup('app_shell_settings_ready');
    if (homebrewUpdateController && (!isTestDistribution() || allowUntrustedReleaseUpdateTest)) {
      automaticUpdateScheduler = createAutomaticUpdateScheduler({
        statePath: join(dataLayout.releaseUpdates, 'automatic-update-state.json'),
        intervalMs: automaticUpdateTiming(automaticUpdateIntervalMs, 'ZEUS_AUTO_UPDATE_INTERVAL_MS', allowUntrustedReleaseUpdateTest),
        initialDelayMs: automaticUpdateTiming(automaticUpdateInitialDelayMs, 'ZEUS_AUTO_UPDATE_INITIAL_DELAY_MS', allowUntrustedReleaseUpdateTest),
        controller: homebrewUpdateController,
        onIndicatorChange: broadcastAutomaticUpdateIndicator,
        notifyReady: (latestVersion, showProgress) => {
          if (isZeusApplicationForeground() || !appShellSettings.desktopNotificationsEnabled || !Notification.isSupported()) return false;
          const notification = new Notification({
            title: appShellSettings.appLanguage === 'zh-CN' ? 'Zeus 更新已下载' : 'Zeus Update Downloaded',
            body: appShellSettings.appLanguage === 'zh-CN' ? `Zeus ${latestVersion} 已通过校验，等待你选择何时重启。` : `Zeus ${latestVersion} passed verification and is waiting for you to choose when to restart.`,
          });
          notification.on('click', showProgress);
          notification.show();
          return true;
        },
      });
      await automaticUpdateScheduler.start();
      powerMonitor.on('resume', handleAutomaticUpdateResume);
    }
    traceApplicationStartup('update_scheduler_ready');
    if (!readOnlyValidationDescriptor) applyLoginItemSettings();
    if (readOnlyValidationDescriptor) {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Zeus Test · 只读验证', submenu: [{ role: 'quit' }] }]));
    } else setupMenu();
    if (!readOnlyValidationDescriptor) {
      setupTraySafely();
      applySystemNotificationBridge();
    }
    resolveRendererRuntimeReady(localServerRuntime);
    resolveRendererStartupDisposition();
    await initialWindowPromise;
    traceApplicationStartup('initialization_finished');
  } catch (error) {
    if (isConversationStoreMigrationError(error)) {
      console.error('Zeus unified conversation store migration paused startup', error);
      return;
    }
    const maintenance = normalizeExecutionHostMaintenanceStatus(error);
    if (maintenance) {
      executionHostMaintenance = maintenance;
      resolveRendererStartupDisposition();
      console.error('Zeus execution-host protocol is incompatible; startup entered maintenance mode', maintenance);
      await initialWindowPromise;
      traceApplicationStartup('execution_host_maintenance_ready');
      return;
    }
    rejectRendererStartupDisposition(error);
    rejectRendererRuntimeReady(error);
    throw error;
  }
}

function normalizeExecutionHostMaintenanceStatus(error: unknown): ExecutionHostMaintenanceStatus | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const candidate = error as { code?: unknown; maintenance?: unknown };
  const maintenanceCodes = new Set([
    'ZEUS_EXECUTION_HOST_PROTOCOL_INCOMPATIBLE',
    'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH',
    'ZEUS_EXECUTION_HOST_OWNER_METADATA_CONFLICT',
    'ZEUS_EXECUTION_HOST_OWNER_UNCONFIRMED',
    'ZEUS_EXECUTION_HOST_STARTUP_TIMEOUT',
  ]);
  if (typeof candidate.code !== 'string' || !maintenanceCodes.has(candidate.code) || !candidate.maintenance || typeof candidate.maintenance !== 'object' || Array.isArray(candidate.maintenance)) return null;
  const maintenance = candidate.maintenance as Record<string, unknown>;
  if (
    typeof maintenance.code !== 'string' ||
    !maintenanceCodes.has(maintenance.code) ||
    !Number.isInteger(maintenance.currentProtocolVersion) ||
    !(maintenance.hostProtocolVersion === null || Number.isInteger(maintenance.hostProtocolVersion)) ||
    !(maintenance.hostAppVersion === null || (typeof maintenance.hostAppVersion === 'string' && Boolean(maintenance.hostAppVersion.trim()))) ||
    !(maintenance.hostPid === null || (Number.isInteger(maintenance.hostPid) && Number(maintenance.hostPid) > 1)) ||
    !(maintenance.hostGenerationId === null || (typeof maintenance.hostGenerationId === 'string' && Boolean(maintenance.hostGenerationId.trim()))) ||
    !(maintenance.stage === null || (typeof maintenance.stage === 'string' && Boolean(maintenance.stage.trim()))) ||
    typeof maintenance.detectedAt !== 'string' ||
    !Number.isFinite(Date.parse(maintenance.detectedAt)) ||
    typeof maintenance.message !== 'string' ||
    !maintenance.message.trim()
  )
    return null;
  return maintenance as unknown as ExecutionHostMaintenanceStatus;
}

function isConversationStoreMigrationError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && error.code.startsWith('ZEUS_CONVERSATION_MIGRATION_');
}

function handleFatalStartupError(error: unknown): void {
  fatalStartup = true;
  // Renderer 已通过被拒绝的启动配置进入唯一“启动失败”页；Main 只记录日志，
  // 不再叠加原生错误弹窗或主动退出造成白屏。
  console.error('Zeus startup failed', error);
  void revealOrCreateMainWindow().catch((windowError) => {
    console.error('Zeus 启动失败页无法创建窗口。', windowError);
    app.exit(1);
  });
}

const startupCoordinator = createStartupCoordinator({
  initialize: initializeApplication,
  revealOrCreateMainWindow,
  onFatalStartupError: handleFatalStartupError,
});
const rendererBootstrapMonitor = createRendererBootstrapMonitor<BrowserWindow>({
  onFailure: (_window, error) => {
    void startupCoordinator.fail(error);
  },
});

function requestMainWindow(): Promise<void> {
  if (fatalStartup) return Promise.resolve();
  return startupCoordinator.requestMainWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    void requestMainWindow();
  });
  void requestMainWindow();
}

async function resolveDesktopQuitMode(): Promise<'continue_in_background' | 'upgrade_handoff' | 'final_quit' | 'force_quit' | 'cancel'> {
  // 只读验收副本不得使用正式数据投影中的历史活动计数阻塞退出。
  if (readOnlyValidationDescriptor) return 'final_quit';
  if (storageRecoveryRestart.isRequested()) return 'final_quit';
  const runtime = localServerRuntime;
  if (!runtime) {
    if (!fullRestartRequested && !upgradeHandoffRequested) return 'final_quit';
    const confirmed = await confirmRequestedRestart('Zeus 当前无法取得 Core 状态。继续重启可能中断尚未完成的工作。');
    return confirmed ? requestedRestartQuitMode() : cancelRequestedRestart();
  }
  let status;
  try {
    status = await runtime.getStatus();
  } catch {
    if (!fullRestartRequested && !upgradeHandoffRequested) return 'cancel';
    const confirmed = await confirmRequestedRestart('Zeus 无法读取当前 Core 的活动数量。继续重启可能中断尚未完成的轮次、等待交互、其他 Runtime 或命令执行。');
    if (!confirmed) return cancelRequestedRestart();
    try {
      await runtime.stopActiveWork();
    } catch (error) {
      console.error('Zeus 无法读取活动数量，且显式停止活动工作失败；已取消重启。', error);
      await showRestartCancelled('当前 Core 无法确认活动数量，也未能安全记录中断状态。本次重启已取消。');
      return cancelRequestedRestart();
    }
    return requestedRestartQuitMode();
  }
  if (!status.hasActiveWork) return requestedRestartQuitMode();
  if (fullRestartRequested || upgradeHandoffRequested) {
    const effectfulTurnDetail = typeof status.effectfulTurnCount === 'number' ? `其中已进入副作用阶段 ${status.effectfulTurnCount} 个` : '其中已进入副作用阶段的数量无法由当前 Core 确认';
    const confirmed = await confirmRequestedRestart(
      `重启会停止正在执行的轮次 ${status.activeTurnCount} 个（${effectfulTurnDetail}）、等待交互 ${status.waitingRequestCount} 个、其他 Runtime ${status.activeRuntimeCount} 个、命令执行 ${status.activeCommandRunCount} 个。`,
    );
    if (!confirmed) return cancelRequestedRestart();
    try {
      await runtime.stopActiveWork();
      return requestedRestartQuitMode();
    } catch (error) {
      console.error('Zeus 完整重启前未能安全记录全部活动工作的中断状态；已取消重启。', error);
      await showRestartCancelled('活动工作未能安全停止，本次重启已取消。');
      return cancelRequestedRestart();
    }
  }
  const mayContinueInBackground = !isTestDistribution() && appShellSettings.backgroundModeEnabled;
  const options = {
    type: 'warning' as const,
    title: '仍有任务正在运行',
    message: '退出 Zeus 时如何处理正在运行的任务？',
    detail: `正在执行的轮次 ${status.activeTurnCount} 个，等待交互 ${status.waitingRequestCount} 个，其他 Runtime ${status.activeRuntimeCount} 个，命令执行 ${status.activeCommandRunCount} 个。`,
    buttons: mayContinueInBackground ? ['关闭界面，任务继续运行', '停止活动工作并退出', '取消'] : ['停止活动工作并退出', '取消'],
    defaultId: mayContinueInBackground ? 2 : 1,
    cancelId: mayContinueInBackground ? 2 : 1,
    noLink: true,
  };
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = targetWindow ? await dialog.showMessageBox(targetWindow, options) : await dialog.showMessageBox(options);
  if (mayContinueInBackground && result.response === 0) return 'continue_in_background';
  const stopResponse = mayContinueInBackground ? 1 : 0;
  const cancelResponse = mayContinueInBackground ? 2 : 1;
  if (result.response === cancelResponse) return 'cancel';
  if (result.response !== stopResponse) return 'cancel';
  try {
    await runtime.stopActiveWork();
    return 'final_quit';
  } catch (error) {
    console.error('Zeus 未能记录全部活动工作的中断状态，已取消本次退出。', error);
    return 'cancel';
  }
}

async function requestedRestartQuitMode(): Promise<'upgrade_handoff' | 'final_quit' | 'cancel'> {
  if (upgradeHandoffRequested) {
    const handoff = pendingUpgradeHandoff;
    if (!handoff) {
      await showRestartCancelled('升级接力信息已经失效。本次重启已取消，更新保持等待重启。');
      return cancelRequestedRestart();
    }
    try {
      await handoff.activate();
    } catch (error) {
      console.error('Zeus 无法在确认后启动升级接力；已取消重启。', error);
      await showRestartCancelled('升级辅助程序未能安全启动。本次重启已取消，更新保持等待重启。');
      return cancelRequestedRestart();
    }
    handoff.resolve(true);
    pendingUpgradeHandoff = null;
    return 'upgrade_handoff';
  }
  if (fullRestartRequested) scheduleExactAppRelaunchAfterCurrentProcessExit();
  return 'final_quit';
}

function cancelRequestedRestart(): 'cancel' {
  pendingUpgradeHandoff?.resolve(false);
  pendingUpgradeHandoff = null;
  fullRestartRequested = false;
  upgradeHandoffRequested = false;
  taskTableLayoutQuitApproved = false;
  return 'cancel';
}

async function confirmRequestedRestart(detail: string): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    title: '重启会停止活动工作',
    message: '确认停止活动工作并完整重启 Zeus？',
    detail,
    buttons: ['停止活动工作并重启', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = targetWindow ? await dialog.showMessageBox(targetWindow, options) : await dialog.showMessageBox(options);
  return result.response === 0;
}

async function showRestartCancelled(detail: string): Promise<void> {
  const options = {
    type: 'warning' as const,
    title: '重启已取消',
    message: 'Zeus 没有关闭当前 Core。',
    detail,
    buttons: ['知道了'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  if (targetWindow) await dialog.showMessageBox(targetWindow, options);
  else await dialog.showMessageBox(options);
}

app.on(
  'before-quit',
  createBeforeQuitCleanupHandler({
    shouldDeferQuit: () => !taskTableLayoutQuitApproved && taskTableLayoutDirtyWindowIds.size > 0,
    requestQuitConfirmation: () => {
      if (taskTableLayoutQuitPending) return;
      taskTableLayoutQuitPending = true;
      for (const window of windows) {
        if (!window.isDestroyed() && taskTableLayoutDirtyWindowIds.has(window.id)) {
          window.webContents.send('zeus:unsaved-changes-close-requested');
        }
      }
    },
    closeSystemNotifications: () => {
      const cleanupErrors: unknown[] = [];
      try {
        systemNotificationBridge?.close();
        systemNotificationBridge = undefined;
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        recoveryBackupDestinationPort.releaseAll();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Zeus 系统通知或恢复目的地资源未能完整关闭。');
    },
    resolveQuitMode: resolveDesktopQuitMode,
    closeLocalServer: async (mode) => {
      const cleanupErrors: unknown[] = [];
      const attemptCleanup = async (label: string, operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          cleanupErrors.push(Object.assign(new Error(`Zeus 退出清理失败：${label}`), { cause: error }));
        }
      };
      await attemptCleanup('自动更新调度器', () => {
        automaticUpdateScheduler?.stop();
        automaticUpdateScheduler = undefined;
      });
      await attemptCleanup('电源监听器', () => {
        powerMonitor.removeListener('resume', handleAutomaticUpdateResume);
      });
      await attemptCleanup('Homebrew 更新控制器', () => {
        if (mode !== 'upgrade_handoff') homebrewUpdateController?.close();
        homebrewUpdateController = undefined;
      });
      await attemptCleanup('内置浏览器宿主', async () => {
        await browserHost?.close();
        browserHost = undefined;
      });
      conversationInputResources = undefined;
      // 即使任一前序 UI/平台资源清理失败，Detached Core 关闭也必须独立尝试。
      await attemptCleanup('Detached Core', async () => {
        await localServerRuntime?.close(mode);
        localServerRuntime = undefined;
      });
      if (!readOnlyValidationDescriptor && (mode === 'final_quit' || mode === 'force_quit') && app.isPackaged) {
        await attemptCleanup('旧 App 备份', async () => {
          await cleanupStaleReleaseBackups(currentAppBundlePath());
        });
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Zeus 退出时一个或多个资源未能完整关闭。');
    },
    onCleanupError: async (error): Promise<BeforeQuitCleanupFailureAction> => {
      if (readOnlyValidationDescriptor) {
        console.error('只读验收关闭失败；禁止以成功状态退出。', error);
        return 'force_quit';
      }
      // 退出链已经有界等待并完成持久化优先收口；剩余技术错误只进运行日志，禁止再弹模态框卡住应用。
      console.error('Zeus 退出清理未完整成功，将使用进程退出兜底。', error);
      return 'force_quit';
    },
    exitApp: (code) => app.exit(code),
  }),
);

app.on('window-all-closed', () => {
  // 测试身份关闭最后一个窗口即结束验收，避免不同 worktree 的测试包长期残留在 Dock 和后台进程中。
  if (
    isTestDistribution() ||
    shouldQuitWhenAllWindowsClosed({
      platform: process.platform,
      backgroundModeEnabled: appShellSettings.backgroundModeEnabled,
    })
  )
    app.quit();
});

app.on('activate', () => {
  void requestMainWindow();
});

async function loadMainAppShellSettings(config: { baseUrl: string; apiToken: string }): Promise<MainAppShellSettings> {
  try {
    const response = await fetch(`${config.baseUrl}/api/settings/app-shell`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
    });
    if (!response.ok) return appShellSettings;
    const body = (await response.json()) as Partial<MainAppShellSettings>;
    return {
      appLanguage: body.appLanguage === 'en-US' ? 'en-US' : 'zh-CN',
      webviewDebugEnabled: body.webviewDebugEnabled === true,
      multiWindowEnabled: typeof body.multiWindowEnabled === 'boolean' ? body.multiWindowEnabled : true,
      backgroundModeEnabled: typeof body.backgroundModeEnabled === 'boolean' ? body.backgroundModeEnabled : true,
      desktopNotificationsEnabled: typeof body.desktopNotificationsEnabled === 'boolean' ? body.desktopNotificationsEnabled : true,
      openAtLoginEnabled: typeof body.openAtLoginEnabled === 'boolean' ? body.openAtLoginEnabled : false,
    };
  } catch {
    return appShellSettings;
  }
}

/** 限制 Renderer 传入的 Runtime 日志源路径，避免借导出能力读取任意本机敏感文件。 */
function isRuntimeLogSourcePathAllowed(sourceFilePath: string): boolean {
  if (!localServerRuntime) return false;
  const sessionsRoot = activeZeusDataLayout().runtimeSessions;
  const resolvedSourcePath = resolve(sourceFilePath);
  return basename(resolvedSourcePath) === 'terminal.normalized.log' && resolvedSourcePath.startsWith(`${sessionsRoot}${sep}`);
}

/** 按当前本机设置重建系统通知订阅，确保关闭开关后不会继续弹出 native notification。 */
function applySystemNotificationBridge(): void {
  systemNotificationBridge?.close();
  systemNotificationBridge = undefined;
  if (!localServerRuntime) return;
  if (
    !shouldUseSystemNotifications({
      desktopNotificationsEnabled: appShellSettings.desktopNotificationsEnabled,
      notificationSupported: Notification.isSupported(),
    })
  )
    return;
  systemNotificationBridge = startSystemNotificationBridge(localServerRuntime.config);
}

/** 将本机开机启动偏好应用到 macOS 登录项；失败不影响 Zeus 主流程启动。 */
function applyLoginItemSettings(): void {
  try {
    app.setLoginItemSettings(
      buildLoginItemSettings({
        openAtLoginEnabled: appShellSettings.openAtLoginEnabled,
      }),
    );
  } catch {
    // 某些开发或受限运行环境可能不允许写入登录项，设置页仍保留用户偏好以便下次真实 App 启动时重试。
  }
}

function startSystemNotificationBridge(config: { baseUrl: string; apiToken: string }): SystemNotificationBridge | undefined {
  if (!Notification.isSupported()) return undefined;
  try {
    return createSystemNotificationBridge({
      baseUrl: config.baseUrl,
      apiToken: config.apiToken,
      openWebSocket: (url, protocol) =>
        new (
          globalThis as unknown as {
            WebSocket: new (
              url: string,
              protocol?: string,
            ) => {
              addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
              close(): void;
            };
          }
        ).WebSocket(url, protocol),
      showNotification: (payload) => {
        // 系统通知只展示真实事件摘要，不包含 token、证书、命令明文等敏感数据。
        const notification = new Notification({ title: payload.title, body: payload.body });
        if (payload.projectId && payload.conversationId) {
          notification.on('click', () => {
            void requestMainWindow().then(() => {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              revealMainWindow(mainWindow);
              mainWindow.webContents.send('zeus:conversation-notification:open', {
                projectId: payload.projectId,
                conversationId: payload.conversationId,
              });
            });
          });
        }
        notification.show();
      },
      shouldNotify: () => !isZeusApplicationForeground(),
    });
  } catch {
    return undefined;
  }
}
