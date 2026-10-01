import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ToolResult } from '@trycua/cua-driver';
import type { BrowserAutomationContentItem, BrowserAutomationPort, BrowserAutomationToolCall } from '@zeus/local-server';
import type { ZeusComputerPreview, ZeusComputerSettings } from '@zeus/shared';
import type { MainCommandLedger, MainCommandRequest } from './mainCommandLedger.js';
import { ComputerDriverProxy, type ComputerDriver } from './computerDriverProxy.js';
import { computerSdkUrl } from './computerSdk.js';

/** CUA SDK 根模块的动态导入类型。 */
type CuaModule = typeof import('@trycua/cua-driver');
/** CUA Electron 权限适配模块的动态导入类型。 */
type CuaElectronModule = typeof import('@trycua/cua-driver/electron');
/** UniFFI 运行时在有序关闭后允许显式释放本地句柄。 */
type DestroyableCuaDriver = ComputerDriver;
/** Computer Use 设置页支持的系统权限。 */
type ComputerPermissionKind = 'accessibility' | 'screen_capture';

/** 创建 Computer Host 所需的宿主依赖。 */
interface CreateComputerHostOptions {
  /** 本地开关状态文件。 */
  statePath: string;
  /** 真实宿主应用身份，仅用于私有 worker 的系统权限诊断。 */
  hostBundleId: string;
  /** 主进程命令账本。 */
  mainCommandLedger: () => MainCommandLedger;
  /** 只读验证模式禁止加载原生 SDK。 */
  readOnlyValidation?: boolean;
  /** 可替换时钟用于稳定持久化字段。 */
  now?: () => string;
}

/** 单个产品轮次拥有一个 CUA 会话和一组精确窗口。 */
interface ComputerControlOwner {
  /** 不暴露给模型的 CUA 会话名。 */
  id: string;
  /** 产品侧完整轮次身份。 */
  input: Pick<BrowserAutomationToolCall, 'conversationId' | 'threadId' | 'turnId'>;
  /** 已由本轮成功观察并独占的窗口。 */
  windows: Set<string>;
  /** 会话页仅展示本轮最近一次 CUA 图像。 */
  preview: ZeusComputerPreview | null;
  /** 停止本轮时一并撤销的原生调用。 */
  controllers: Set<AbortController>;
  /** 每个轮次内部串行，避免动作越过其观察。 */
  operationTail: Promise<void>;
  /** 命名 CUA 会话是否已经建立。 */
  sessionStarted: boolean;
  /** 会话创建一经派发就记录实际 Driver，取消未知结果也必须结束原会话。 */
  sessionDriver: DestroyableCuaDriver | null;
  /** 一个原生命名会话只控制一个应用，切换应用时先释放原目标。 */
  controlledPid: number | null;
  /** 用户接管后，本轮禁止再次投递输入。 */
  paused: boolean;
  /** 暂停来源保持真实，让系统共享停止与实体接管可区分。 */
  pauseReason: 'ZEUS_COMPUTER_USER_CONTROL' | 'ZEUS_COMPUTER_SHARING_STOPPED' | null;
}

/** CUA 单次调用的宿主上限，不能被模型参数延长。 */
const cuaCallTimeoutMs = 120_000;
/** CUA 命名会话的不可变最长生命周期。 */
const cuaMaximumSessionTtlSeconds = 28_800n;
/** CUA 命名会话无活动时的不可变回收期限。 */
const cuaMaximumIdleTtlSeconds = 300n;
/** 会话缩略图最大 base64 字符数，避免主进程长期持有大图。 */
const maximumPreviewBase64Characters = 6 * 1024 * 1024;
/** 不创建控制会话的只读发现工具。 */
const discoveryTools = new Set(['list_apps', 'list_windows']);
/** 会改变应用状态且在异常后禁止盲目重试的工具。 */
const mutatingTools = new Set(['launch_app', 'click', 'drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'invoke_menu']);
/** 必须基于本轮已观察精确窗口运行的工具。 */
const exactWindowTools = new Set(['click', 'drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'invoke_menu', 'verify_state']);
/** 由宿主强制写入 CUA 精确窗口 target 的输入工具。 */
const backgroundTargetTools = new Set(['click', 'drag', 'type_text', 'press_key', 'hotkey', 'scroll']);
/** Zeus 自有启动协议只允许宿主生成，不能由模型附加任意启动参数。 */
export const computerBackgroundLaunchSwitch = 'zeus-computer-background-launch';
/** 首个自动化窗口必须在创建前选好非工作屏。 */
export const computerTargetDisplaySwitch = 'zeus-computer-target-display';
/** 自带光标主题沿用 CUA 渲染、命中点和点击穿透能力。 */
const computerCursorThemeId = 'dev.hypha.zeus.cursor';
/** Zeus 允许模型调用的 CUA 工具白名单。 */
const supportedComputerTools = new Set(['list_apps', 'launch_app', 'list_windows', 'get_window_state', 'click', 'drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'invoke_menu', 'verify_state']);

/** Electron 独占管理 CUA Driver，macOS 私有 worker 提供原生光标并隔离各产品轮次。 */
export class ComputerHost implements BrowserAutomationPort {
  /** 持久化使用的时钟。 */
  private readonly now: () => string;
  /** 规范化后的设置路径。 */
  private readonly statePath: string;
  /** 当前设置页状态。 */
  private settings: ZeusComputerSettings;
  /** IPC 只能注册一次。 */
  private ipcRegistered = false;
  /** 关闭后拒绝任何新调用。 */
  private closed = false;
  /** 应用生命周期内复用一个官方 Driver，关闭时一并回收私有 worker。 */
  private driver: DestroyableCuaDriver | null = null;
  /** 并发启动合并为一个 Promise。 */
  private driverStartup: Promise<DestroyableCuaDriver> | null = null;
  /** 启动阶段也能退出准确的 SDK 进程。 */
  private startingDriver: ComputerDriverProxy | null = null;
  /** 初始化只属于首先请求启动的轮次。 */
  private startingDriverOwnerId: string | null = null;
  /** 延迟加载 SDK，确保遥测策略先于原生运行时初始化。 */
  private cuaModule: Promise<CuaModule> | null = null;
  /** 每个完整轮次身份映射到独立命名会话。 */
  private readonly owners = new Map<string, ComputerControlOwner>();
  /** 精确窗口同一时间只允许一个产品轮次持有。 */
  private readonly windowOwners = new Map<string, string>();
  /** 已结束轮次不能被迟到工具调用重新建立。 */
  private readonly revokedTurns = new Set<string>();
  /** 即使尚未创建 CUA 会话，产品轮次终态也会拒绝其迟到调用。 */
  private readonly revokedProductTurns = new Set<string>();
  /** 全局停止世代使排队调用统一失效。 */
  private controlGeneration = 0;
  /** ponytail: 私有 worker 本身串行；确需原生并发时改为每轮私有 worker。 */
  private nativeTail: Promise<void> = Promise.resolve();
  /** SDK 返回的本任务私有 worker 身份，仅向该进程发送取消。 */
  private workerPid: number | null = null;
  /** 每次恢复合并为一个生命周期操作，不重放已派发输入。 */
  private workerRecovery: Promise<void> | null = null;
  /** 屏幕变化统一失效所有旧观察，不靠旧截图坐标继续操作。 */
  private readonly displayChanged = (): void => {
    for (const owner of [...this.owners.values()]) {
      owner.windows.clear();
      for (const controller of owner.controllers) controller.abort();
      this.patchPreview(owner, { needsObservation: true, detail: '显示器布局已变化，请重新观察目标窗口。' });
    }
  };

  /** 恢复本地开关，但构造阶段不加载原生 SDK 或触发权限。 */
  constructor(private readonly options: CreateComputerHostOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.statePath = resolve(options.statePath);
    this.settings = {
      enabled: false,
      serviceState: 'disabled',
      accessibilityTrusted: process.platform !== 'darwin',
      screenCaptureAvailable: process.platform !== 'darwin',
      permissionCheckState: process.platform === 'darwin' ? 'unchecked' : 'checked',
    };
    this.restoreSettings();
  }

  /** 注册设置、权限、停止和会话预览 IPC。 */
  registerIpc(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;
    screen.on('display-added', this.displayChanged);
    screen.on('display-removed', this.displayChanged);
    screen.on('display-metrics-changed', this.displayChanged);
    ipcMain.handle('zeus:computer:get-settings', async () => {
      if (this.settings.enabled) await this.refreshPermissions();
      return this.getSettings();
    });
    ipcMain.handle('zeus:computer:get-preview', (_event, conversationId: unknown, imageId: unknown) => this.getPreview(conversationId, imageId));
    ipcMain.handle('zeus:computer:update-settings', async (_event, request: MainCommandRequest) => {
      return this.options.mainCommandLedger().execute(request, 'desktop.computer.update_settings', async (input, command) => {
        this.assertWritable();
        await command.markWriteStarted();
        /** 只有显式 true 才开启高权限能力。 */
        const enabled = isRecord(input) && input.enabled === true;
        this.settings = {
          ...this.settings,
          enabled,
          serviceState: enabled ? 'idle' : 'disabled',
          detail: enabled ? 'Computer Use 已启用，等待核对 Zeus 的系统权限。' : 'Computer Use 已关闭。',
        };
        await this.persistSettings();
        if (!enabled) {
          await this.stop('disabled', true);
          return this.getSettings();
        }
        await this.requestPermissions();
        if (this.hasRequiredPermissions()) await this.ensureDriver();
        return this.getSettings();
      });
    });
    ipcMain.handle('zeus:computer:request-permissions', async (_event, request: MainCommandRequest) => {
      return this.options.mainCommandLedger().execute(request, 'desktop.computer.request_permissions', async (_input, command) => {
        this.assertWritable();
        if (!this.settings.enabled) throw computerError('ZEUS_COMPUTER_DISABLED', '请先启用 Computer Use。');
        await command.markWriteStarted();
        await this.requestPermissions();
        if (this.hasRequiredPermissions()) await this.ensureDriver();
        return this.getSettings();
      });
    });
    ipcMain.handle('zeus:computer:open-permission-settings', async (_event, request: MainCommandRequest) => {
      return this.options.mainCommandLedger().execute(request, 'desktop.computer.open_permission_settings', async (input, command) => {
        this.assertWritable();
        /** 权限类型来自受控设置页命令。 */
        const permission = computerPermissionKind(input);
        await command.markWriteStarted();
        if (permission === 'screen_capture' && process.platform === 'darwin') {
          /** 官方 Electron 适配器确保设置入口归属于 Zeus。 */
          const cuaElectron = await this.loadCuaElectronModule();
          await cuaElectron.openMacOSScreenRecordingSettings();
        } else {
          await shell.openExternal(computerPermissionSettingsUrl(permission));
        }
        return { opened: true as const, permission };
      });
    });
    ipcMain.handle('zeus:computer:stop', async (_event, request: MainCommandRequest) => {
      return this.options.mainCommandLedger().execute(request, 'desktop.computer.stop', async (input, command) => {
        this.assertWritable();
        await command.markWriteStarted();
        if (input == null) await this.stop('user', false);
        else await this.stopOwner(this.assertPreviewOwner(input));
        return this.getSettings();
      });
    });
  }

  /** 返回不可变的设置页快照。 */
  getSettings(): ZeusComputerSettings {
    return { ...this.settings };
  }

  /** 只向所属产品会话返回最近一次 CUA 窗口图像。 */
  getPreview(conversationId: unknown, imageId?: unknown): ZeusComputerPreview | null {
    /** 同一会话有多个线程时，展示最近活动的控制身份。 */
    const owner = [...this.owners.values()].filter((candidate) => candidate.input.conversationId === conversationId && candidate.preview).at(-1);
    if (!owner?.preview) return null;
    return { ...owner.preview, imageUrl: imageId === owner.preview.imageId ? null : owner.preview.imageUrl };
  }

  /** 动态工具统一入口；发现可并发，单轮次观察与动作严格串行。 */
  async invoke(input: BrowserAutomationToolCall): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    /** 上游未给期限时使用宿主硬上限。 */
    const boundedInput = { ...input, deadlineUnixMs: input.deadlineUnixMs ?? Date.now() + cuaCallTimeoutMs };
    if (boundedInput.namespace !== 'zeus_computer') return computerText(`ComputerHost 不支持命名空间：${String(boundedInput.namespace)}`, false);
    if (this.options.readOnlyValidation) return computerText('只读验证模式禁止启动或调用 Computer Use。', false);
    if (!this.settings.enabled) return computerText('Zeus Computer Use 尚未在设置中启用。', false);
    if (!supportedComputerTools.has(boundedInput.tool)) return computerText(`Computer Use 方法不受支持：${boundedInput.tool}`, false);
    /** 入队前记录停止世代，停止后的旧调用无法重新取得控制权。 */
    const generation = this.controlGeneration;
    try {
      this.assertControlAllowed(boundedInput, generation);
      /** 发现工具不创建有状态会话。 */
      const owner = discoveryTools.has(boundedInput.tool) ? undefined : this.ensureOwner(boundedInput);
      /** 同轮次操作串行，不阻塞其他精确窗口。 */
      const operation = this.nativeTail.then(() => this.invokeCua(boundedInput, generation, owner));
      this.nativeTail = operation.then(
        () => undefined,
        () => undefined,
      );
      if (owner) {
        owner.operationTail = operation.then(
          () => undefined,
          () => undefined,
        );
      }
      return await operation;
    } catch (error) {
      return computerText(computerErrorMessage(error), false);
    }
  }

  /** 轮次终态立即撤销其 CUA 会话和精确窗口所有权。 */
  async endComputerUse(input: { conversationId: string; turnId: string }): Promise<void> {
    /** 结束键不依赖 threadId，覆盖同一产品轮次可能存在的所有线程映射。 */
    this.revokedProductTurns.add(computerProductTurnKey(input));
    const matchingOwners = [...this.owners.entries()].filter(([, owner]) => owner.input.conversationId === input.conversationId && owner.input.turnId === input.turnId);
    for (const [key, owner] of matchingOwners) {
      this.revokedTurns.add(key);
      await this.stopOwner(owner);
    }
  }

  /** 应用退出时撤销全部调用并有序关闭官方 SDK。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    screen.removeListener('display-added', this.displayChanged);
    screen.removeListener('display-removed', this.displayChanged);
    screen.removeListener('display-metrics-changed', this.displayChanged);
    await this.stop('closed', true);
  }

  /** 执行一次经过宿主收敛的 CUA 调用。 */
  private async invokeCua(input: BrowserAutomationToolCall, generation: number, owner: ComputerControlOwner | undefined): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    /** 只有真正进入动作派发后，异常才意味着结果未知。 */
    let dispatched = false;
    /** 观察前先预留窗口，失败时只释放本次新占用。 */
    let reservation: { key: string; fresh: boolean } | undefined;
    try {
      this.assertControlAllowed(input, generation);
      /** 在原生调用前拒绝会借用用户焦点的输入路线。 */
      const argumentsValue = this.prepareArguments(input, owner);
      if (owner?.paused) throw computerError(owner.pauseReason ?? 'ZEUS_COMPUTER_USER_CONTROL', owner.preview?.detail ?? '本轮控制已暂停。继续时需要新指令和新观察。');
      if (owner)
        this.patchPreview(owner, {
          state: owner.paused ? 'paused' : input.tool === 'get_window_state' ? 'observing' : 'working',
          action: input.tool,
          pid: typeof argumentsValue.pid === 'number' ? argumentsValue.pid : (owner.preview?.pid ?? null),
          windowId: typeof argumentsValue.window_id === 'number' ? argumentsValue.window_id : (owner.preview?.windowId ?? null),
          detail: owner.paused ? (owner.preview?.detail ?? null) : null,
        });
      if (input.tool === 'get_window_state' && owner) {
        const key = computerWindowKey(argumentsValue);
        const current = this.windowOwners.get(key);
        if (current && current !== owner.id) throw computerError('ZEUS_COMPUTER_WINDOW_BUSY', '该窗口正在由另一个 Zeus 轮次控制。');
        reservation = { key, fresh: !current };
        this.windowOwners.set(key, owner.id);
        owner.windows.delete(key);
      }
      if (exactWindowTools.has(input.tool)) this.assertOwnedWindow(argumentsValue, owner);
      await this.refreshPermissions();
      if (this.settings.permissionCheckState === 'error') throw computerError('ZEUS_COMPUTER_RUNTIME_UNAVAILABLE', this.settings.detail ?? '无法检查 Computer Use 原生组件和权限。');
      if (!this.hasRequiredPermissions()) throw computerError('ZEUS_COMPUTER_PERMISSION_REQUIRED', computerPermissionDetail(this.settings.accessibilityTrusted, this.settings.screenCaptureAvailable));
      /** Driver 只在开关和系统权限都满足后初始化。 */
      this.assertControlAllowed(input, generation);
      const driver = await this.ensureDriver(owner);
      this.assertControlAllowed(input, generation);
      if (owner && input.tool === 'get_window_state' && typeof argumentsValue.pid === 'number') await this.retargetOwner(driver, owner, argumentsValue.pid);
      this.assertControlAllowed(input, generation);
      if (owner) await this.ensureOwnerSession(driver, owner, input);
      if (input.tool === 'launch_app') {
        /** 已运行应用仅返回窗口；冷启动必须先通过桌面保护检查。 */
        const reused = await this.prepareLaunch(driver, argumentsValue, input, owner);
        this.assertControlAllowed(input, generation);
        if (reused) {
          this.updatePreview(owner, input, reused);
          return projectToolResult(reused);
        }
      }
      this.assertControlAllowed(input, generation);
      /** CUA 的 target 与顶层 pid/window_id 互斥；原参数保留给宿主核对窗口所有权。 */
      const nativeArguments = backgroundTargetTools.has(input.tool) ? { ...argumentsValue, pid: undefined, window_id: undefined } : argumentsValue;
      /** 所有官方调用都继承同一个不可延长的取消信号。 */
      dispatched = true;
      const result = await this.callWithDeadline(input, owner, (signal) => driver.callTool(input.tool, JSON.stringify(nativeArguments), { signal }));
      this.assertControlAllowed(input, generation);
      if (!result.isError && input.tool === 'get_window_state' && owner) this.claimObservedWindow(argumentsValue, owner);
      /** 动作后旧画面不再代表真实状态。 */
      this.updatePreview(owner, input, result);
      if (result.isError && owner) {
        owner.windows.clear();
        this.patchPreview(owner, { state: owner.paused ? 'paused' : 'error', needsObservation: true, detail: owner.paused ? (owner.preview?.detail ?? null) : (result.structuredJson ?? result.rawJson).slice(0, 1000) });
      }
      return projectToolResult(result);
    } catch (error) {
      if (owner) {
        const detail = computerErrorMessage(error);
        if (detail.includes('ZEUS_COMPUTER_USER_CONTROL')) this.pauseApplication(owner.preview?.pid ?? null);
        else if (detail.includes('ZEUS_COMPUTER_SHARING_STOPPED')) this.pauseApplication(owner.preview?.pid ?? null, 'ZEUS_COMPUTER_SHARING_STOPPED');
        if (dispatched && mutatingTools.has(input.tool)) owner.windows.clear();
        this.patchPreview(owner, { state: owner.paused ? 'paused' : 'error', needsObservation: true, detail: owner.paused ? (owner.preview?.detail ?? detail.slice(0, 1000)) : detail.slice(0, 1000) });
      }
      if (computerWorkerFailed(error, this.driver)) await this.recoverWorker();
      this.settings = { ...this.settings, serviceState: this.driver ? 'ready' : this.settings.serviceState, detail: computerErrorMessage(error).slice(0, 1000) };
      /** 动作异常代表结果未知，明确阻止模型盲目重放。 */
      const uncertainty =
        dispatched && mutatingTools.has(input.tool) && !(isRecord(error) && isRecord(error.inner) && (error.inner.completion === 0 || (typeof error.inner.reason === 'string' && error.inner.reason.startsWith('input_not_started:'))))
          ? ' 动作可能未执行、已执行或仅部分执行；不得自动重试，请先重新观察目标窗口。'
          : '';
      return computerText(`${computerErrorMessage(error)}${uncertainty}`.slice(0, 2000), false);
    } finally {
      if (reservation?.fresh && owner && !owner.windows.has(reservation.key) && this.windowOwners.get(reservation.key) === owner.id) this.windowOwners.delete(reservation.key);
    }
  }

  /** 取得或创建完整轮次对应的宿主控制者。 */
  private ensureOwner(input: BrowserAutomationToolCall): ComputerControlOwner {
    /** 完整轮次键避免同会话并行轮次共享 CUA 状态。 */
    const key = computerTurnKey(input);
    const existing = this.owners.get(key);
    if (existing) return existing;
    /** Zeus 前缀用于光标标识，完整 UUID 保留并行轮次的隔离强度。 */
    const owner: ComputerControlOwner = {
      id: `Zeus ${randomUUID()}`,
      input: { conversationId: input.conversationId, threadId: input.threadId, turnId: input.turnId },
      windows: new Set(),
      preview: null,
      controllers: new Set(),
      operationTail: Promise.resolve(),
      sessionStarted: false,
      sessionDriver: null,
      controlledPid: null,
      paused: false,
      pauseReason: null,
    };
    this.owners.set(key, owner);
    this.patchPreview(owner, { state: 'starting', action: input.tool });
    return owner;
  }

  /** 同一轮次切换应用先释放旧共享和观察，用户操作旧应用不能暂停新目标。 */
  private async retargetOwner(driver: DestroyableCuaDriver, owner: ComputerControlOwner, pid: number): Promise<void> {
    if (owner.controlledPid === null || owner.controlledPid === pid) {
      owner.controlledPid = pid;
      return;
    }
    /** 当前新窗口的预留继续保留，只移除旧应用的观察与所有权。 */
    for (const [windowKey, identity] of this.windowOwners) if (identity === owner.id && !windowKey.startsWith(`${pid}:`)) this.windowOwners.delete(windowKey);
    owner.windows.clear();
    try {
      if (owner.sessionDriver === driver) await computerBounded(driver.endSession({ session: owner.id }), 1_500);
    } catch {
      if (this.driver === driver) await this.recoverWorker();
      throw computerError('ZEUS_COMPUTER_RUNTIME_UNAVAILABLE', '旧应用控制未及时释放，已回收驱动。请重新观察新目标。');
    }
    owner.sessionDriver = null;
    owner.sessionStarted = false;
    owner.controlledPid = pid;
  }

  /** 为有状态轮次显式建立官方命名会话。 */
  private async ensureOwnerSession(driver: DestroyableCuaDriver, owner: ComputerControlOwner, input: BrowserAutomationToolCall): Promise<void> {
    if (owner.sessionStarted) return;
    /** 创建会话即选中主题，避免第一帧仍显示普通小光标。 */
    const cua = await this.loadCuaModule();
    if (owner.paused || this.driver !== driver || this.owners.get(computerTurnKey(owner.input)) !== owner) throw computerError('ZEUS_COMPUTER_STOPPED', owner.preview?.detail ?? '当前控制已停止。');
    owner.sessionDriver = driver;
    await this.callWithDeadline(input, owner, (signal) => driver.startSession({ session: owner.id, cursorTheme: { themeId: computerCursorThemeId, reducedMotion: cua.CursorReducedMotion.Auto } }, { signal }));
    if (owner.paused || this.driver !== driver || this.owners.get(computerTurnKey(owner.input)) !== owner) throw computerError('ZEUS_COMPUTER_STOPPED', owner.preview?.detail ?? '当前控制已停止。');
    owner.sessionStarted = true;
  }

  /** 启动不是只读发现；复用已有窗口，拒绝无法在首帧保护桌面的第三方启动。 */
  private async prepareLaunch(driver: DestroyableCuaDriver, args: Record<string, unknown>, input: BrowserAutomationToolCall, owner: ComputerControlOwner | undefined): Promise<ToolResult | undefined> {
    /** 使用官方发现结果精确解析应用，名称歧义不能任意取第一个。 */
    const { apps } = await this.callWithDeadline(input, owner, (signal) => driver.listApps({}, { signal }));
    /** bundle_id 优先，名称只能精确匹配。 */
    const matches = apps.filter((candidate) => (typeof args.bundle_id === 'string' ? candidate.bundleId === args.bundle_id : typeof args.name === 'string' && candidate.name.toLowerCase() === args.name.toLowerCase()));
    /** 已运行实例优先，避免同一应用的安装记录造成假歧义。 */
    const running = matches.filter((candidate) => candidate.running && candidate.pid > 0);
    if (running.length > 1 || (!running.length && matches.length !== 1)) throw computerError('ZEUS_COMPUTER_APP_AMBIGUOUS', '应用不存在或匹配到多个实例，请先用 list_apps、list_windows 确定精确 PID。');
    /** 选中的应用身份只来自驱动发现。 */
    const target = running[0] ?? matches[0]!;
    /** URL 交接会触发目标应用自己的激活逻辑，不能当成普通复用。 */
    const hasUrls = Array.isArray(args.urls) && args.urls.length > 0;
    if (running.length === 1 && args.creates_new_application_instance !== true && !hasUrls) {
      /** 不再次调用 launch_app，避免 reopen AppleEvent 抬升已有窗口。 */
      const result = await this.callWithDeadline(input, owner, (signal) => driver.callTool('list_windows', JSON.stringify({ pid: target.pid }), { signal }));
      if (result.isError) return result;
      /** 保留官方窗口结构，只补充本次复用的应用身份。 */
      const structured = parseJson(result.structuredJson);
      return { ...result, structuredJson: JSON.stringify({ ...(isRecord(structured) ? structured : {}), pid: target.pid, bundle_id: target.bundleId, name: target.name, reused: true, launch_state: 'running' }) };
    }
    if (hasUrls || !['dev.hypha.zeus', 'dev.hypha.zeus.test'].includes(target.bundleId ?? '')) {
      throw computerError('ZEUS_COMPUTER_BACKGROUND_LAUNCH_UNSUPPORTED', '未启动应用：该应用无法保证冷启动、新实例或打开文件时不抢工作屏和焦点。请使用已运行的精确窗口；不要用 shell、open 或前台方式绕过。');
    }
    /** 物理指针仅用于判断用户工作屏，绝不移动它。 */
    const workingDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    /** 只从 Electron 提供的独立显示器中选择非主、非工作外接屏。 */
    const display = screen
      .getAllDisplays()
      .filter((candidate) => candidate.id !== workingDisplay.id && candidate.id !== screen.getPrimaryDisplay().id && !candidate.internal && candidate.detected !== false)
      .sort((left, right) => right.workArea.width * right.workArea.height - left.workArea.width * left.workArea.height || left.id - right.id)[0];
    if (!display) throw computerError('ZEUS_COMPUTER_BACKGROUND_DISPLAY_UNAVAILABLE', '未启动应用：没有可用的非工作外接屏。请使用已运行窗口，避免在当前工作屏弹出新应用。');
    args.bundle_id = target.bundleId;
    args.additional_arguments = [`--${computerBackgroundLaunchSwitch}`, `--${computerTargetDisplaySwitch}=${display.id}`];
  }

  /** 清洗模型参数并注入不可覆盖的后台窗口策略。 */
  private prepareArguments(input: BrowserAutomationToolCall, owner: ComputerControlOwner | undefined): Record<string, unknown> {
    /** 拷贝后再删字段，绝不修改上游调用对象。 */
    const result = { ...input.arguments };
    for (const key of ['session', 'scope', 'target', 'delivery_mode', 'modifier', 'from_zoom', 'debug_image_out', 'screenshot_out_file', 'additional_arguments', 'webkit_inspector_port']) delete result[key];
    for (const key of Object.keys(result)) if (key.startsWith('_')) delete result[key];
    if (owner && input.tool !== 'launch_app') result.session = owner.id;
    if (process.platform === 'darwin' && input.tool === 'invoke_menu') {
      throw computerError('ZEUS_COMPUTER_BACKGROUND_MENU_UNSUPPORTED', '未执行菜单操作：当前 macOS 驱动会主动激活并抬升目标窗口。请使用已观察到的菜单控件或后台快捷键；不可转用前台操作。');
    }
    /** 坐标必须成对出现，像素点击还必须绑定不可变 capture_id。 */
    const hasPixelCoordinates = result.x !== undefined || result.y !== undefined;
    if (hasPixelCoordinates && (typeof result.x !== 'number' || typeof result.y !== 'number')) throw computerError('ZEUS_COMPUTER_PIXEL_TARGET_INVALID', '像素目标必须同时提供 x 和 y。');
    if (input.tool === 'click' && hasPixelCoordinates && (typeof result.capture_id !== 'string' || result.capture_id.length === 0)) {
      throw computerError('ZEUS_COMPUTER_CAPTURE_REQUIRED', '像素点击必须携带同一次 get_window_state 返回的 capture_id。');
    }
    /** 无效语义身份不得让 CUA 悄悄降级到像素路线。 */
    const hasSemanticTarget = (typeof result.element_token === 'string' && result.element_token.length > 0) || (typeof result.element_index === 'number' && Number.isSafeInteger(result.element_index) && result.element_index >= 0);
    if (process.platform === 'darwin' && ((input.tool === 'click' && !hasSemanticTarget) || (input.tool === 'type_text' && hasPixelCoordinates))) {
      throw computerError('ZEUS_COMPUTER_BACKGROUND_FOCUS_UNSUPPORTED', '未执行点击：macOS 像素定位输入可能短暂借用用户的键盘焦点。请重新观察并使用 element_token 或 element_index；没有语义控件时停止，不要改用前台或系统鼠标。');
    }
    if (backgroundTargetTools.has(input.tool)) {
      /** 工具 Schema 已要求精确数值目标，这里再次在信任边界验证。 */
      const pid = positiveInteger(result.pid, 'pid');
      /** 原生窗口 ID 由发现工具返回。 */
      const windowId = positiveInteger(result.window_id, 'window_id');
      result.delivery_mode = 'background';
      result.target = { kind: 'window', pid, window_id: windowId };
    }
    return result;
  }

  /** 动作只能落在本轮成功观察并独占的精确窗口。 */
  private assertOwnedWindow(argumentsValue: Record<string, unknown>, owner: ComputerControlOwner | undefined): void {
    if (!owner) throw computerError('ZEUS_COMPUTER_SESSION_REQUIRED', '该窗口动作缺少产品轮次会话。');
    /** 所有动作与验证都必须携带精确窗口身份。 */
    const key = computerWindowKey(argumentsValue);
    if (!owner.windows.has(key) || this.windowOwners.get(key) !== owner.id) {
      throw computerError('ZEUS_COMPUTER_OBSERVATION_REQUIRED', '必须先在当前轮次调用 get_window_state 观察该精确窗口。');
    }
  }

  /** 成功观察后原子声明窗口所有权，拒绝跨轮次并发控制。 */
  private claimObservedWindow(argumentsValue: Record<string, unknown>, owner: ComputerControlOwner): void {
    /** 窗口键由精确 PID 和原生 window_id 组成。 */
    const key = computerWindowKey(argumentsValue);
    const currentOwner = this.windowOwners.get(key);
    if (currentOwner && currentOwner !== owner.id) throw computerError('ZEUS_COMPUTER_WINDOW_BUSY', '该窗口正在由另一个 Zeus 轮次控制。');
    this.windowOwners.set(key, owner.id);
    owner.windows.add(key);
  }

  /** 将 CUA 图像投影为会话内预览，不持久化到历史消息。 */
  private updatePreview(owner: ComputerControlOwner | undefined, input: BrowserAutomationToolCall, result: ToolResult): void {
    if (!owner || result.isError) return;
    /** 只保留一张有界图片，完整图仍随当前工具结果交给模型。 */
    const image = result.images.find((candidate) => candidate.mimeType.startsWith('image/') && candidate.dataBase64.length <= maximumPreviewBase64Characters);
    /** 结构化输出用于提取稳定的应用显示名。 */
    const structured = parseJson(result.structuredJson);
    if (input.tool === 'launch_app' && isRecord(structured) && typeof structured.pid === 'number') this.patchPreview(owner, { pid: structured.pid, windowId: null, windowTitle: '' });
    /** 仅新截图更新捕获时间，旧画面保持真实时间和图片身份。 */
    const imageUrl = image ? `data:${image.mimeType};base64,${image.dataBase64}` : (owner.preview?.imageUrl ?? null);
    const changedImage = imageUrl !== owner.preview?.imageUrl;
    /** 新图片使用原生系统帧的实际采集时间，未知时间保持未知。 */
    const captureUnixMs = isRecord(structured) ? structured.screenshot_captured_at_unix_ms : undefined;
    /** 日期必须在 JavaScript 可表示范围内，不能信任任意结构化字段。 */
    const captureDate = typeof captureUnixMs === 'number' && Number.isSafeInteger(captureUnixMs) ? new Date(captureUnixMs) : null;
    this.patchPreview(owner, {
      appName: computerAppName(structured, input.arguments),
      windowTitle: isRecord(structured) && typeof structured.window_title === 'string' ? structured.window_title : (owner.preview?.windowTitle ?? ''),
      needsObservation: input.tool === 'get_window_state' ? false : mutatingTools.has(input.tool) || !!owner.preview?.needsObservation,
      state: owner.paused ? 'paused' : 'working',
      imageUrl,
      imageId: changedImage ? randomUUID() : (owner.preview?.imageId ?? null),
      capturedAt: image ? (captureDate && Number.isFinite(captureDate.getTime()) ? captureDate.toISOString() : null) : (owner.preview?.capturedAt ?? null),
    });
    if (isRecord(structured) && isRecord(structured.zeus_control) && structured.zeus_control.paused === true)
      this.pauseApplication(owner.preview?.pid ?? null, structured.zeus_control.reason === 'ZEUS_COMPUTER_SHARING_STOPPED' ? 'ZEUS_COMPUTER_SHARING_STOPPED' : 'ZEUS_COMPUTER_USER_CONTROL');
  }

  /** 合并预览并只广播轻量变化通知，不向每个窗口重复投递图片。 */
  private patchPreview(owner: ComputerControlOwner, patch: Partial<ZeusComputerPreview>): void {
    if (this.owners.get(computerTurnKey(owner.input)) !== owner) return;
    /** 目标改变后不再沿用上一窗口的画面、标题和采集时间。 */
    const targetChanged = owner.preview !== null && ((patch.pid !== undefined && patch.pid !== owner.preview.pid) || (patch.windowId !== undefined && patch.windowId !== owner.preview.windowId));
    owner.preview = {
      conversationId: owner.input.conversationId,
      sessionId: owner.id,
      appName: 'Computer Use',
      windowTitle: '',
      pid: null,
      windowId: null,
      state: 'starting',
      action: '',
      detail: null,
      needsObservation: true,
      imageUrl: null,
      imageId: null,
      capturedAt: null,
      ...owner.preview,
      ...(targetChanged ? { appName: 'Computer Use', windowTitle: '', imageUrl: null, imageId: null, capturedAt: null } : {}),
      ...patch,
      updatedAt: this.now(),
    };
    /** 更新 Map 插入顺序，让会话预览选择真正最近活动的线程。 */
    this.owners.delete(computerTurnKey(owner.input));
    this.owners.set(computerTurnKey(owner.input), owner);
    this.notifyPreview(owner.input.conversationId);
  }

  /** 订阅通知只携带产品会话身份，图片由所属页面按需读取。 */
  private notifyPreview(conversationId: string): void {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('zeus:computer:preview-changed', conversationId);
  }

  /** 同一应用共享输入焦点，用户接管后撤销该应用所有轮次的旧观察。 */
  private pauseApplication(pid: number | null, reason: 'ZEUS_COMPUTER_USER_CONTROL' | 'ZEUS_COMPUTER_SHARING_STOPPED' = 'ZEUS_COMPUTER_USER_CONTROL'): void {
    if (pid === null) return;
    for (const owner of [...this.owners.values()]) {
      if (![...owner.windows].some((key) => key.startsWith(`${pid}:`)) && owner.preview?.pid !== pid) continue;
      if (owner.paused) continue;
      owner.paused = true;
      owner.pauseReason = reason;
      for (const controller of owner.controllers) controller.abort();
      for (const [windowKey, identity] of this.windowOwners) if (identity === owner.id) this.windowOwners.delete(windowKey);
      owner.windows.clear();
      this.patchPreview(owner, {
        state: 'paused',
        needsObservation: true,
        detail: reason === 'ZEUS_COMPUTER_SHARING_STOPPED' ? '系统窗口共享已停止，后台输入已暂停。继续时需要新指令和新观察。' : '你已接管受控应用，后台输入已暂停。继续时需要新指令和新观察。',
      });
      /** 保留真实暂停预览，同时释放原生命名会话；新指令才能重新获得控制。 */
      const driver = owner.sessionDriver;
      owner.sessionDriver = null;
      owner.sessionStarted = false;
      if (driver && this.driver === driver) {
        void computerBounded(driver.endSession({ session: owner.id }), 1_500).catch(async () => {
          if (this.driver === driver) await this.recoverWorker();
        });
      }
    }
  }

  /** 给 SDK 调用附加期限与轮次取消控制。 */
  private async callWithDeadline<T>(input: BrowserAutomationToolCall, owner: ComputerControlOwner | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    /** 调用期限取上游期限和宿主上限中更早者。 */
    const remainingMs = Math.min(cuaCallTimeoutMs, (input.deadlineUnixMs ?? Date.now() + cuaCallTimeoutMs) - Date.now());
    if (remainingMs <= 0) throw computerError('ZEUS_COMPUTER_DEADLINE_EXCEEDED', 'Computer Use 调用在执行前已超过期限。');
    /** 每次调用使用独立控制器，停止轮次只撤销自己的操作。 */
    const controller = new AbortController();
    owner?.controllers.add(controller);
    /** 计时器只负责触发标准 AbortSignal。 */
    const timer = setTimeout(() => controller.abort(), remainingMs);
    /** 捕获调用所属实例，迟到取消不得影响后来的恢复实例。 */
    const nativeDriver = this.driver;
    const nativePid = this.workerPid;
    /** 标准 AbortSignal 同时通知本任务原生输入循环停止，并保留抬起动作。 */
    const cancelNative = (): void => {
      if (nativePid !== null && this.driver === nativeDriver && this.workerPid === nativePid) {
        try {
          process.kill(nativePid, 'SIGUSR1');
        } catch {
          /* 已退出的私有 worker 无需再次取消。 */
        }
      }
    };
    controller.signal.addEventListener('abort', cancelNative, { once: true });
    try {
      if (owner && this.owners.get(computerTurnKey(owner.input)) !== owner) throw computerError('ZEUS_COMPUTER_STOPPED', '当前控制已停止。');
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancelNative);
      if (controller.signal.aborted && nativeDriver && this.driver === nativeDriver) {
        /** 私有通道串行，metadata 完成说明前一操作已释放；正常停止不清空其他会话。 */
        try {
          await computerBounded(nativeDriver.metadata(), 1_500);
        } catch {
          await this.recoverWorker();
        }
      }
      owner?.controllers.delete(controller);
    }
  }

  /** 延迟加载 CUA，且默认关闭嵌入依赖的内容无关遥测。 */
  private loadCuaModule(): Promise<CuaModule> {
    if (!this.cuaModule) {
      // Zeus 未提供第三方遥测告知与开关，因此在导入原生运行时前明确关闭。
      process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false';
      // 主题只从应用自带目录读取，避免写入或共享其他 CUA 应用的用户配置。
      process.env.CUA_DRIVER_CURSOR_THEME_DIR = resolve(app.getAppPath().replace(/\.asar$/u, '.asar.unpacked'), 'assets/computer-cursor');
      this.cuaModule = import(computerSdkUrl('@trycua/cua-driver')).catch((error: unknown) => {
        // 原始加载原因留在开发日志，设置页不把加载失败误报成权限缺失。
        console.error('Computer Use 原生 SDK 加载失败。', error);
        throw computerError('ZEUS_COMPUTER_RUNTIME_LOAD_FAILED', 'Computer Use 原生组件加载失败，尚未检查系统权限。请使用完整构建的应用包；重复授权不能修复组件加载问题。');
      }) as Promise<CuaModule>;
    }
    return this.cuaModule;
  }

  /** 权限入口使用官方 Electron 适配层。 */
  private async loadCuaElectronModule(): Promise<CuaElectronModule> {
    await this.loadCuaModule();
    return import(computerSdkUrl('@trycua/cua-driver/electron')) as Promise<CuaElectronModule>;
  }

  /** 合并并发启动，在应用生命周期内复用同一 Driver。 */
  private async ensureDriver(owner?: ComputerControlOwner): Promise<DestroyableCuaDriver> {
    if (this.workerRecovery) await this.workerRecovery;
    if (this.driver) return this.driver;
    if (this.driverStartup) return this.driverStartup;
    /** 异步加载期间的全局停止也会撤销尚未创建的 SDK 进程。 */
    const generation = this.controlGeneration;
    this.settings = { ...this.settings, serviceState: 'starting', detail: '正在初始化 CUA Driver。' };
    this.driverStartup = (async () => {
      /** 官方配置构造将权限上限固定为常规自动化，不能由模型升级。 */
      const cua = await this.loadCuaModule();
      const authorization = cua.RuntimeAuthorizationOptions.new({
        allowedModes: [cua.SessionPermissionMode.Standard],
        compatibilityMode: cua.SessionPermissionMode.Standard,
        unrestrictedAcknowledged: false,
        maxSessionTtlSeconds: cuaMaximumSessionTtlSeconds,
        maxIdleTtlSeconds: cuaMaximumIdleTtlSeconds,
      });
      /** 同进程与私有 worker 共用不可变授权边界，不开放独立 daemon 或 MCP 入口。 */
      const configuredDriver = cua.ConfiguredDriverOptions.new({ claudeCodeCompatibility: false, authorization });
      /** 仅传递 AppKit 所需的系统环境，不继承用户凭据或模型配置。 */
      const environment = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'PATH', 'LANG'].flatMap((name) => (process.env[name] === undefined ? [] : [{ name, value: process.env[name]! }]));
      environment.push({ name: 'CUA_DRIVER_RS_TELEMETRY_ENABLED', value: 'false' });
      /** 通知密钥仅在本次私有进程之间传递，防止应用文本伪造暂停事件。 */
      environment.push({ name: 'ZEUS_CUA_EVENT_TOKEN', value: randomBytes(32).toString('hex') });
      if (this.closed || !this.settings.enabled || generation !== this.controlGeneration || (owner && this.owners.get(computerTurnKey(owner.input)) !== owner)) throw computerError('ZEUS_COMPUTER_STOPPED', 'Computer Use 已停止。');
      /** 同步 FFI 初始化在专用 SDK 进程内执行，主线程保留启动阶段停止能力。 */
      const driver: ComputerDriver =
        process.platform === 'darwin'
          ? new ComputerDriverProxy(
              cua.PrivateWorkerOptions.new({
                binaryPath: resolve(app.getAppPath().replace(/\.asar$/u, '.asar.unpacked'), 'dist/native/ZeusComputerWorker'),
                hostBundleId: this.options.hostBundleId,
                configuredDriver,
                environment,
                inheritStderr: true,
              }),
              (event) => {
                /** 已核对的原生身份与当前实例同时匹配，旧进程通知不能撤销新控制。 */
                if (this.driver === driver && this.workerPid === event.workerPid) this.pauseApplication(event.pid, event.reason);
              },
            )
          : cua.CuaDriver.createConfigured(configuredDriver);
      try {
        if (driver instanceof ComputerDriverProxy) {
          this.startingDriver = driver;
          this.startingDriverOwnerId = owner?.id ?? null;
          await computerBounded(driver.initialize(), cuaCallTimeoutMs);
        }
        if (process.platform === 'darwin') {
          /** 仅核对本次 SDK 创建的真实子进程，不接受模型或页面提供的 PID。 */
          const metadata = await computerBounded(driver.metadata(), 1_500);
          const identity = await promisify(execFile)('/bin/ps', ['-p', String(metadata.pid), '-o', 'ppid=', '-o', 'comm='], { encoding: 'utf8', timeout: 1_500 });
          /** SDK 进程与原生可执行文件同时匹配，embedded 只描述子进程内部运行时。 */
          const expectedBinary = resolve(app.getAppPath().replace(/\.asar$/u, '.asar.unpacked'), 'dist/native/cua-driver');
          const match = identity.stdout.trim().match(/^(\d+)\s+(.+)$/u);
          if (!Number.isSafeInteger(metadata.pid) || metadata.pid <= 0 || metadata.pid === process.pid || Number(match?.[1]) !== (driver.workerParentPid ?? process.pid) || match?.[2] !== expectedBinary)
            throw computerError('ZEUS_COMPUTER_WORKER_IDENTITY_INVALID', '无法核对本任务私有 worker 身份。');
          this.workerPid = metadata.pid;
        }
        if (this.closed || !this.settings.enabled || generation !== this.controlGeneration || (owner && this.owners.get(computerTurnKey(owner.input)) !== owner)) throw computerError('ZEUS_COMPUTER_STOPPED', 'Computer Use 已停止。');
      } catch (error) {
        if (driver instanceof ComputerDriverProxy) await driver.abortStartup();
        else {
          try {
            await computerBounded(driver.shutdown(), 1_500);
          } finally {
            driver.uniffiDestroy?.();
          }
        }
        this.workerPid = null;
        throw error;
      } finally {
        if (this.startingDriver === driver) {
          this.startingDriver = null;
          this.startingDriverOwnerId = null;
        }
      }
      this.driver = driver;
      this.settings = { ...this.settings, serviceState: 'ready', detail: 'CUA Driver 已就绪；所有输入固定为精确窗口后台投递。' };
      return driver;
    })();
    try {
      return await this.driverStartup;
    } catch (error) {
      this.settings = { ...this.settings, serviceState: 'error', detail: computerErrorMessage(error).slice(0, 1000) };
      throw error;
    } finally {
      this.driverStartup = null;
    }
  }

  /** 读取 Zeus 当前进程的系统权限，不读取旧 Helper 身份。 */
  private async refreshPermissions(): Promise<ZeusComputerSettings> {
    if (process.platform !== 'darwin') {
      this.settings = { ...this.settings, accessibilityTrusted: true, screenCaptureAvailable: true, permissionCheckState: 'checked' };
      return this.getSettings();
    }
    try {
      /** 探针由官方 SDK 在当前 Electron 主进程内执行。 */
      const cua = await this.loadCuaModule();
      const status = cua.currentMacOsPermissionStatus();
      /** 权限撤销后必须销毁旧 Driver，不能继续复用其原生状态。 */
      const permissionsLost = this.driver !== null && (!status.accessibility || !status.screenRecording);
      this.settings = {
        ...this.settings,
        permissionCheckState: 'checked',
        accessibilityTrusted: status.accessibility,
        screenCaptureAvailable: status.screenRecording,
        detail: computerPermissionDetail(status.accessibility, status.screenRecording),
      };
      if (permissionsLost) {
        await this.stop('permission_changed', true);
        this.settings = { ...this.settings, serviceState: 'idle', detail: computerPermissionDetail(status.accessibility, status.screenRecording) };
      }
    } catch (error) {
      this.settings = { ...this.settings, serviceState: 'error', permissionCheckState: 'error', detail: computerErrorMessage(error).slice(0, 1000) };
    }
    return this.getSettings();
  }

  /** 仅由用户设置动作触发 macOS 权限提示。 */
  private async requestPermissions(): Promise<ZeusComputerSettings> {
    try {
      if (process.platform === 'darwin') {
        /** 官方适配器同步返回本次请求后的当前权限状态。 */
        const cuaElectron = await this.loadCuaElectronModule();
        const status = cuaElectron.requestMacOSPermissions();
        this.settings = {
          ...this.settings,
          permissionCheckState: 'checked',
          accessibilityTrusted: status.accessibility,
          screenCaptureAvailable: status.screenRecording,
          detail: computerPermissionDetail(status.accessibility, status.screenRecording),
        };
      } else {
        await this.refreshPermissions();
      }
    } catch (error) {
      this.settings = { ...this.settings, serviceState: 'error', permissionCheckState: 'error', detail: computerErrorMessage(error).slice(0, 1000) };
    }
    return this.getSettings();
  }

  /** 两项系统权限都就绪才允许创建 Driver。 */
  private hasRequiredPermissions(): boolean {
    return this.settings.permissionCheckState === 'checked' && this.settings.accessibilityTrusted && this.settings.screenCaptureAvailable;
  }

  /** 校验迟到调用、关闭状态、轮次撤销与期限。 */
  private assertControlAllowed(input: BrowserAutomationToolCall, generation: number): void {
    if (this.closed) throw computerError('ZEUS_COMPUTER_CLOSED', 'Computer Use 宿主已关闭。');
    if (generation !== this.controlGeneration) throw computerError('ZEUS_COMPUTER_STOPPED', 'Computer Use 已被用户停止。');
    if (this.revokedProductTurns.has(computerProductTurnKey(input))) throw computerError('ZEUS_COMPUTER_TURN_ENDED', '当前轮次的 Computer Use 已结束。');
    if (this.revokedTurns.has(computerTurnKey(input))) throw computerError('ZEUS_COMPUTER_TURN_ENDED', '当前轮次的 Computer Use 已结束。');
    if ((input.deadlineUnixMs ?? Number.POSITIVE_INFINITY) <= Date.now()) throw computerError('ZEUS_COMPUTER_DEADLINE_EXCEEDED', 'Computer Use 调用已超过期限。');
  }

  /** 会话按钮只能操作其显示的精确控制身份。 */
  private assertPreviewOwner(input: unknown): ComputerControlOwner {
    /** 设置页传入的控制身份不可信，必须与宿主记录同时匹配。 */
    const record = isRecord(input) ? input : {};
    const owner = [...this.owners.values()].find((candidate) => candidate.id === record.sessionId && candidate.input.conversationId === record.conversationId);
    if (!owner) throw computerError('ZEUS_COMPUTER_STOPPED', '该会话的屏幕控制已结束或发生变化。');
    return owner;
  }

  /** 停止单个命名会话并释放其窗口所有权。 */
  private async stopOwner(owner: ComputerControlOwner): Promise<void> {
    /** 先移除宿主身份，避免停止期间接纳新动作。 */
    const key = computerTurnKey(owner.input);
    this.owners.delete(key);
    this.notifyPreview(owner.input.conversationId);
    this.revokedTurns.add(key);
    for (const controller of owner.controllers) controller.abort();
    owner.controllers.clear();
    for (const [windowKey, identity] of this.windowOwners) if (identity === owner.id) this.windowOwners.delete(windowKey);
    owner.windows.clear();
    if (this.startingDriver && this.startingDriverOwnerId === owner.id) await this.startingDriver.abortStartup();
    /** 创建回复可能已经被取消；只结束最初派发会话的实例。 */
    const driver = owner.sessionDriver;
    owner.sessionDriver = null;
    owner.sessionStarted = false;
    if (!driver || this.driver !== driver) return;
    try {
      /** endSession 是幂等的官方生命周期出口。 */
      /** 原生取消先让输入循环抬起；超时只回收本任务私有 worker。 */
      await computerBounded(driver.endSession({ session: owner.id }), 1_500);
    } catch {
      if (this.driver === driver) await this.recoverWorker();
    }
  }

  /** 失联或取消后先有界等待原生会话释放，再重建服务；从不自动重放输入。 */
  private async recoverWorker(): Promise<void> {
    if (this.workerRecovery) return this.workerRecovery;
    const driver = this.driver;
    if (!driver) return;
    this.driver = null;
    const pid = this.workerPid;
    this.workerPid = null;
    this.workerRecovery = (async () => {
      try {
        await computerBounded(Promise.all([...this.owners.values()].filter((owner) => owner.sessionDriver === driver).map((owner) => driver.endSession({ session: owner.id }))), 1_500);
      } catch {
        if (pid !== null) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* 私有 worker 已结束。 */
          }
        }
      }
      try {
        await computerBounded(driver.shutdown(), 1_500);
      } catch {
        if (pid !== null) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* 私有 worker 已结束。 */
          }
        }
      }
      driver.uniffiDestroy?.();
      for (const owner of [...this.owners.values()]) {
        owner.sessionStarted = false;
        owner.sessionDriver = null;
        owner.windows.clear();
        this.patchPreview(owner, { needsObservation: true, state: owner.paused ? 'paused' : 'error', detail: '桌面驱动已回收；下一次调用会重建，请先重新观察窗口，勿重试结果未知的输入。' });
      }
      this.settings = { ...this.settings, serviceState: this.settings.enabled ? 'idle' : 'disabled' };
    })();
    try {
      await this.workerRecovery;
    } finally {
      this.workerRecovery = null;
    }
  }

  /** 全局停止所有轮次，并按需关闭 Driver 及其私有 worker。 */
  private async stop(reason: 'user' | 'disabled' | 'closed' | 'permission_changed', destroyDriver: boolean): Promise<void> {
    this.controlGeneration += 1;
    if (this.startingDriver) await this.startingDriver.abortStartup();
    /** 拷贝后停止，避免遍历期间修改 Map。 */
    const owners = [...this.owners.values()];
    await Promise.all(owners.map((owner) => this.stopOwner(owner)));
    if (destroyDriver && this.driver) {
      /** 先停止接纳并等待已接纳调用，再释放 UniFFI 句柄。 */
      const driver = this.driver;
      this.driver = null;
      const pid = this.workerPid;
      this.workerPid = null;
      this.settings = { ...this.settings, serviceState: 'stopping' };
      try {
        await computerBounded(driver.shutdown(), 1_500);
      } catch {
        if (pid !== null) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* 私有 worker 已结束。 */
          }
        }
      } finally {
        driver.uniffiDestroy?.();
      }
    }
    this.settings = {
      ...this.settings,
      serviceState: this.settings.enabled && (reason === 'user' || reason === 'permission_changed') ? (this.driver ? 'ready' : 'idle') : 'disabled',
      detail: reason === 'user' ? '当前 Computer Use 会话已停止。' : reason === 'permission_changed' ? this.settings.detail : reason === 'closed' ? 'Computer Use 宿主已关闭。' : 'Computer Use 已关闭。',
    };
  }

  /** 从权限开关文件恢复最小状态。 */
  private restoreSettings(): void {
    try {
      /** 文件只保存用户是否启用，不缓存易漂移的系统权限。 */
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as { enabled?: unknown };
      this.settings = {
        ...this.settings,
        enabled: parsed.enabled === true,
        serviceState: parsed.enabled === true ? 'idle' : 'disabled',
      };
    } catch {
      // 首次运行或损坏设置都安全回退为未启用，不加载 CUA。
    }
  }

  /** 原子持久化用户开关，不保存权限或 CUA 会话。 */
  private async persistSettings(): Promise<void> {
    /** 状态目录保持仅用户可访问。 */
    const directoryPath = dirname(this.statePath);
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    /** UUID 临时文件避免并发进程碰撞。 */
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ enabled: this.settings.enabled, updatedAt: this.now() }, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.statePath);
  }

  /** 只读验证模式拒绝任何设置或原生运行时写动作。 */
  private assertWritable(): void {
    if (this.options.readOnlyValidation) throw computerError('ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED', '只读验证模式禁止修改 Computer Use 设置或启动 CUA。');
  }
}

/** 创建 Electron Computer Host。 */
export function createComputerHost(options: CreateComputerHostOptions): ComputerHost {
  return new ComputerHost(options);
}

/** 将官方 ToolResult 投影为现有动态工具内容协议。 */
function projectToolResult(result: ToolResult): { contentItems: BrowserAutomationContentItem[]; success: boolean } {
  /** 官方已提供完整 JSON 字符串，直接转发，避免维护第二套结果协议。 */
  const text = result.structuredJson ?? result.rawJson;
  /** CUA 已把图片与 JSON 分离，按原始 MIME 交给模型。 */
  const images: BrowserAutomationContentItem[] = result.images
    .filter((image) => image.mimeType.startsWith('image/') && image.dataBase64.length > 0)
    .map((image) => ({ type: 'inputImage', imageUrl: `data:${image.mimeType};base64,${image.dataBase64}` }));
  return { contentItems: [{ type: 'inputText', text }, ...images], success: !result.isError };
}

/** 生成纯文本动态工具结果。 */
function computerText(text: string, success: boolean): { contentItems: BrowserAutomationContentItem[]; success: boolean } {
  return { contentItems: [{ type: 'inputText', text }], success };
}

/** 构造带稳定错误码的宿主异常。 */
function computerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** 将未知异常投影为不泄露堆栈的模型文本。 */
function computerErrorMessage(error: unknown): string {
  if (isRecord(error) && isRecord(error.inner) && typeof error.inner.reason === 'string') return `${String(error.tag)}: ${error.inner.reason}`;
  if (isRecord(error) && typeof error.code === 'string') return `${error.code}: ${error instanceof Error ? error.message : String(error.message ?? error)}`;
  return error instanceof Error ? error.message : String(error);
}

/** SDK 的传输故障触发重建；工具拒绝和权限错误保留明确原因。 */
function computerWorkerFailed(error: unknown, driver: DestroyableCuaDriver | null): boolean {
  if (!isRecord(error)) return false;
  /** 完成状态未知可能来自工具让权；只有真实服务失联才重建。 */
  if (error.tag === 'ActionInterrupted') return driver !== null && !driver.isAvailable();
  /** worker 也封装执行前的明确拒绝，不能因此重启其他应用的控制。 */
  /** 原生明确拒绝的原因在回调前收敛为字符串。 */
  const reason = isRecord(error.inner) && typeof error.inner.reason === 'string' ? error.inner.reason : '';
  if (['ZEUS_COMPUTER_USER_CONTROL', 'ZEUS_COMPUTER_SHARING_STOPPED', 'ZEUS_COMPUTER_DISPLAY_CHANGED', 'ZEUS_COMPUTER_STOPPED', 'ZEUS_COMPUTER_INPUT_MONITOR_UNAVAILABLE'].some((code) => reason.includes(code))) return false;
  return ['Worker', 'Transport', 'Protocol', 'Shutdown'].includes(String(error.tag));
}

/** 为生命周期退出提供有界等待，防止停止按钮被失联服务挂住。 */
async function computerBounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  /** 超时句柄必须在完成和失败时都释放。 */
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(computerError('ZEUS_COMPUTER_WORKER_TIMEOUT', '桌面驱动未及时确认停止。')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 解析设置页权限类型。 */
function computerPermissionKind(value: unknown): ComputerPermissionKind {
  /** IPC 输入必须按未知值处理。 */
  const record = isRecord(value) ? value : {};
  if (record.permission === 'accessibility' || record.permission === 'screen_capture') return record.permission;
  throw computerError('ZEUS_COMPUTER_PERMISSION_KIND_INVALID', 'Computer Use 权限设置类型无效。');
}

/** 返回系统权限设置 URL。 */
function computerPermissionSettingsUrl(permission: ComputerPermissionKind): string {
  return permission === 'accessibility' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
}

/** 生成面向用户的 Zeus 权限状态。 */
function computerPermissionDetail(accessibilityTrusted: boolean, screenCaptureAvailable: boolean): string {
  if (accessibilityTrusted && screenCaptureAvailable) return 'Zeus 已获得辅助功能与屏幕录制权限。';
  if (!accessibilityTrusted && !screenCaptureAvailable) return '请授予 Zeus 辅助功能与屏幕录制权限；授权后需要重新启动 Zeus。';
  if (!accessibilityTrusted) return '请授予 Zeus 辅助功能权限；授权后需要重新启动 Zeus。';
  return '请授予 Zeus 屏幕录制权限；授权后需要重新启动 Zeus。';
}

/** 把完整轮次身份编码为本地 Map 键。 */
function computerTurnKey(input: Pick<BrowserAutomationToolCall, 'conversationId' | 'threadId' | 'turnId'>): string {
  return JSON.stringify([input.conversationId, input.threadId, input.turnId]);
}

/** 把不依赖 Provider 线程的产品轮次身份编码为本地 Set 键。 */
function computerProductTurnKey(input: Pick<BrowserAutomationToolCall, 'conversationId' | 'turnId'>): string {
  return JSON.stringify([input.conversationId, input.turnId]);
}

/** 把精确 PID 与窗口 ID 编码为所有权键。 */
function computerWindowKey(input: Record<string, unknown>): string {
  /** 进程 ID 必须为正整数。 */
  const pid = positiveInteger(input.pid, 'pid');
  /** 窗口 ID 必须来自官方发现结果。 */
  const windowId = positiveInteger(input.window_id, 'window_id');
  return `${pid}:${windowId}`;
}

/** 校验 CUA 数值身份。 */
function positiveInteger(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw computerError('ZEUS_COMPUTER_EXACT_TARGET_REQUIRED', `${name} 必须是发现工具返回的正整数。`);
}

/** 尽力从 CUA 输出提取预览应用名。 */
function computerAppName(structured: unknown, input: Record<string, unknown>): string {
  /** 官方窗口快照当前使用 app_name。 */
  const record = isRecord(structured) ? structured : {};
  if (typeof record.app_name === 'string' && record.app_name.length > 0) return record.app_name;
  if (typeof input.name === 'string' && input.name.length > 0) return input.name;
  if (typeof input.bundle_id === 'string' && input.bundle_id.length > 0) return input.bundle_id;
  return typeof input.pid === 'number' ? `PID ${input.pid}` : 'Computer Use';
}

/** 安全解析可选 JSON 字符串。 */
function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** 判断未知值是否为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
