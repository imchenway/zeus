import { ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CuaDriverLike, ToolResult } from '@trycua/cua-driver';
import type { BrowserAutomationContentItem, BrowserAutomationPort, BrowserAutomationToolCall } from '@zeus/local-server';
import type { ZeusComputerPreview, ZeusComputerSettings } from '@zeus/shared';
import type { MainCommandLedger, MainCommandRequest } from './mainCommandLedger.js';

/** CUA SDK 根模块的动态导入类型。 */
type CuaModule = typeof import('@trycua/cua-driver');
/** CUA Electron 权限适配模块的动态导入类型。 */
type CuaElectronModule = typeof import('@trycua/cua-driver/electron');
/** UniFFI 运行时在有序关闭后允许显式释放本地句柄。 */
type DestroyableCuaDriver = CuaDriverLike & { uniffiDestroy?: () => void };
/** Computer Use 设置页支持的系统权限。 */
type ComputerPermissionKind = 'accessibility' | 'screen_capture';

/** 创建 Computer Host 所需的宿主依赖。 */
interface CreateComputerHostOptions {
  /** 本地开关状态文件。 */
  statePath: string;
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
/** Zeus 允许模型调用的 CUA 工具白名单。 */
const supportedComputerTools = new Set(['list_apps', 'launch_app', 'list_windows', 'get_window_state', 'click', 'drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'invoke_menu', 'verify_state']);

/** 在 Electron 主进程内托管唯一 CUA Driver，并隔离各产品轮次。 */
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
  /** 应用生命周期内复用一个官方同进程 Driver。 */
  private driver: DestroyableCuaDriver | null = null;
  /** 并发启动合并为一个 Promise。 */
  private driverStartup: Promise<DestroyableCuaDriver> | null = null;
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

  /** 恢复本地开关，但构造阶段不加载原生 SDK 或触发权限。 */
  constructor(private readonly options: CreateComputerHostOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.statePath = resolve(options.statePath);
    this.settings = {
      enabled: false,
      serviceState: 'disabled',
      accessibilityTrusted: process.platform !== 'darwin',
      screenCaptureAvailable: process.platform !== 'darwin',
    };
    this.restoreSettings();
  }

  /** 注册设置、权限、停止和会话预览 IPC。 */
  registerIpc(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;
    ipcMain.handle('zeus:computer:get-settings', async () => {
      if (this.settings.enabled) await this.refreshPermissions();
      return this.getSettings();
    });
    ipcMain.handle('zeus:computer:get-preview', (_event, conversationId: unknown) => this.getPreview(conversationId));
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
  getPreview(conversationId: unknown): ZeusComputerPreview | null {
    return [...this.owners.values()].find((owner) => owner.input.conversationId === conversationId && owner.preview)?.preview ?? null;
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
      const operation = (owner?.operationTail ?? Promise.resolve()).then(() => this.invokeCua(boundedInput, generation, owner));
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
    await this.stop('closed', true);
  }

  /** 执行一次经过宿主收敛的 CUA 调用。 */
  private async invokeCua(input: BrowserAutomationToolCall, generation: number, owner: ComputerControlOwner | undefined): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    try {
      this.assertControlAllowed(input, generation);
      await this.refreshPermissions();
      if (!this.hasRequiredPermissions()) throw computerError('ZEUS_COMPUTER_PERMISSION_REQUIRED', computerPermissionDetail(this.settings.accessibilityTrusted, this.settings.screenCaptureAvailable));
      /** Driver 只在开关和系统权限都满足后初始化。 */
      const driver = await this.ensureDriver();
      this.assertControlAllowed(input, generation);
      if (owner) await this.ensureOwnerSession(driver, owner, input);
      /** 宿主删除前台、桌面、调试落盘和附加启动参数。 */
      const argumentsValue = this.prepareArguments(input, owner);
      if (exactWindowTools.has(input.tool)) this.assertOwnedWindow(argumentsValue, owner);
      /** 所有官方调用都继承同一个不可延长的取消信号。 */
      const result = await this.callWithDeadline(input, owner, (signal) => driver.callTool(input.tool, JSON.stringify(argumentsValue), { signal }));
      this.assertControlAllowed(input, generation);
      if (!result.isError && input.tool === 'get_window_state' && owner) this.claimObservedWindow(argumentsValue, owner);
      /** 动作后旧画面不再代表真实状态。 */
      this.updatePreview(owner, input, result);
      return projectToolResult(result);
    } catch (error) {
      this.settings = { ...this.settings, serviceState: this.driver ? 'ready' : 'error', detail: computerErrorMessage(error).slice(0, 1000) };
      /** 动作异常代表结果未知，明确阻止模型盲目重放。 */
      const uncertainty = mutatingTools.has(input.tool) ? ' 动作可能未执行、已执行或仅部分执行；不得自动重试，请先重新观察目标窗口。' : '';
      return computerText(`${computerErrorMessage(error)}${uncertainty}`.slice(0, 2000), false);
    }
  }

  /** 取得或创建完整轮次对应的宿主控制者。 */
  private ensureOwner(input: BrowserAutomationToolCall): ComputerControlOwner {
    /** 完整轮次键避免同会话并行轮次共享 CUA 状态。 */
    const key = computerTurnKey(input);
    const existing = this.owners.get(key);
    if (existing) return existing;
    /** UUID 作为不含用户内容的公开 CUA 会话标签。 */
    const owner: ComputerControlOwner = {
      id: `zeus-${randomUUID()}`,
      input: { conversationId: input.conversationId, threadId: input.threadId, turnId: input.turnId },
      windows: new Set(),
      preview: null,
      controllers: new Set(),
      operationTail: Promise.resolve(),
      sessionStarted: false,
    };
    this.owners.set(key, owner);
    return owner;
  }

  /** 为有状态轮次显式建立官方命名会话。 */
  private async ensureOwnerSession(driver: DestroyableCuaDriver, owner: ComputerControlOwner, input: BrowserAutomationToolCall): Promise<void> {
    if (owner.sessionStarted) return;
    await this.callWithDeadline(input, owner, (signal) => driver.startSession({ session: owner.id }, { signal }));
    owner.sessionStarted = true;
  }

  /** 清洗模型参数并注入不可覆盖的后台窗口策略。 */
  private prepareArguments(input: BrowserAutomationToolCall, owner: ComputerControlOwner | undefined): Record<string, unknown> {
    /** 拷贝后再删字段，绝不修改上游调用对象。 */
    const result = { ...input.arguments };
    for (const key of ['session', 'scope', 'target', 'delivery_mode', 'modifier', 'from_zoom', 'debug_image_out', 'screenshot_out_file', 'additional_arguments', 'webkit_inspector_port']) delete result[key];
    for (const key of Object.keys(result)) if (key.startsWith('_')) delete result[key];
    if (owner && input.tool !== 'launch_app') result.session = owner.id;
    /** 坐标必须成对出现，像素点击还必须绑定不可变 capture_id。 */
    const hasPixelCoordinates = result.x !== undefined || result.y !== undefined;
    if (hasPixelCoordinates && (typeof result.x !== 'number' || typeof result.y !== 'number')) throw computerError('ZEUS_COMPUTER_PIXEL_TARGET_INVALID', '像素目标必须同时提供 x 和 y。');
    if (input.tool === 'click' && hasPixelCoordinates && (typeof result.capture_id !== 'string' || result.capture_id.length === 0)) {
      throw computerError('ZEUS_COMPUTER_CAPTURE_REQUIRED', '像素点击必须携带同一次 get_window_state 返回的 capture_id。');
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
    owner.preview = {
      conversationId: owner.input.conversationId,
      sessionId: owner.id,
      appName: computerAppName(structured, input.arguments),
      needsObservation: mutatingTools.has(input.tool),
      imageUrl: image ? `data:${image.mimeType};base64,${image.dataBase64}` : (owner.preview?.imageUrl ?? null),
    };
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
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
      owner?.controllers.delete(controller);
    }
  }

  /** 延迟加载 CUA，且默认关闭嵌入依赖的内容无关遥测。 */
  private loadCuaModule(): Promise<CuaModule> {
    if (!this.cuaModule) {
      // Zeus 未提供第三方遥测告知与开关，因此在导入原生运行时前明确关闭。
      process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false';
      this.cuaModule = import('@trycua/cua-driver');
    }
    return this.cuaModule;
  }

  /** 权限入口使用官方 Electron 适配层。 */
  private async loadCuaElectronModule(): Promise<CuaElectronModule> {
    await this.loadCuaModule();
    return import('@trycua/cua-driver/electron');
  }

  /** 合并并发启动，在应用生命周期内复用同一 Driver。 */
  private async ensureDriver(): Promise<DestroyableCuaDriver> {
    if (this.driver) return this.driver;
    if (this.driverStartup) return this.driverStartup;
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
      /** 同进程 Driver 复用 Zeus 权限身份，不启动 daemon 或第二套服务。 */
      const driver = cua.CuaDriver.createConfigured(cua.ConfiguredDriverOptions.new({ claudeCodeCompatibility: false, authorization })) as DestroyableCuaDriver;
      if (this.closed || !this.settings.enabled) {
        await driver.shutdown();
        driver.uniffiDestroy?.();
        throw computerError('ZEUS_COMPUTER_STOPPED', 'Computer Use 已停止。');
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
      this.settings = { ...this.settings, accessibilityTrusted: true, screenCaptureAvailable: true };
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
        accessibilityTrusted: status.accessibility,
        screenCaptureAvailable: status.screenRecording,
        detail: computerPermissionDetail(status.accessibility, status.screenRecording),
      };
      if (permissionsLost) {
        await this.stop('permission_changed', true);
        this.settings = { ...this.settings, serviceState: 'idle', detail: computerPermissionDetail(status.accessibility, status.screenRecording) };
      }
    } catch (error) {
      this.settings = { ...this.settings, serviceState: 'error', detail: computerErrorMessage(error).slice(0, 1000) };
    }
    return this.getSettings();
  }

  /** 仅由用户设置动作触发 macOS 权限提示。 */
  private async requestPermissions(): Promise<ZeusComputerSettings> {
    if (process.platform === 'darwin') {
      /** 官方适配器同步返回本次请求后的当前权限状态。 */
      const cuaElectron = await this.loadCuaElectronModule();
      const status = cuaElectron.requestMacOSPermissions();
      this.settings = {
        ...this.settings,
        accessibilityTrusted: status.accessibility,
        screenCaptureAvailable: status.screenRecording,
        detail: computerPermissionDetail(status.accessibility, status.screenRecording),
      };
    } else {
      await this.refreshPermissions();
    }
    return this.getSettings();
  }

  /** 两项系统权限都就绪才允许创建 Driver。 */
  private hasRequiredPermissions(): boolean {
    return this.settings.accessibilityTrusted && this.settings.screenCaptureAvailable;
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
    this.revokedTurns.add(key);
    for (const controller of owner.controllers) controller.abort();
    owner.controllers.clear();
    for (const windowKey of owner.windows) {
      if (this.windowOwners.get(windowKey) === owner.id) this.windowOwners.delete(windowKey);
    }
    owner.windows.clear();
    if (!owner.sessionStarted || !this.driver) return;
    try {
      /** endSession 是幂等的官方生命周期出口。 */
      await this.driver.endSession({ session: owner.id });
    } catch {
      // Driver 全局关闭会同时结束会话，单会话清理失败不阻塞应用退出。
    }
  }

  /** 全局停止所有轮次，并按需销毁同进程 Driver。 */
  private async stop(reason: 'user' | 'disabled' | 'closed' | 'permission_changed', destroyDriver: boolean): Promise<void> {
    this.controlGeneration += 1;
    /** 拷贝后停止，避免遍历期间修改 Map。 */
    const owners = [...this.owners.values()];
    await Promise.all(owners.map((owner) => this.stopOwner(owner)));
    if (destroyDriver && this.driver) {
      /** 先停止接纳并等待已接纳调用，再释放 UniFFI 句柄。 */
      const driver = this.driver;
      this.driver = null;
      this.settings = { ...this.settings, serviceState: 'stopping' };
      try {
        await driver.shutdown();
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
  if (isRecord(error) && typeof error.code === 'string') return `${error.code}: ${error instanceof Error ? error.message : String(error.message ?? error)}`;
  return error instanceof Error ? error.message : String(error);
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
