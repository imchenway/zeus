import { ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { BrowserAutomationContentItem, BrowserAutomationPort, BrowserAutomationToolCall } from '@zeus/local-server';
import type { ZeusComputerPreview, ZeusComputerSettings } from '@zeus/shared';
import type { MainCommandLedger, MainCommandRequest } from './mainCommandLedger.js';

interface ComputerServiceResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  /** 原生采集或用户交互产生的主动停止通知。 */
  event?: string;
  /** 通知所属的控制会话，防止旧采集回调停止新会话。 */
  sessionId?: string;
  /** 原生流主动提供的缩略图与暂停状态。 */
  preview?: unknown;
}

/** 每个轮次独立保存控制身份、观察与用户接管状态。 */
interface ComputerControlOwner {
  /** 本地随机会话身份，同时传给原生服务。 */
  id: string;
  /** 工具来源的完整身份；不接受模型参数覆盖。 */
  input: Pick<BrowserAutomationToolCall, 'conversationId' | 'threadId' | 'turnId'>;
  /** 元素代次不能被其他轮次的观察或动作覆盖。 */
  snapshots: Map<string, number>;
  /** 只向所属产品会话展示该轮次的画面。 */
  preview: ZeusComputerPreview | null;
  /** 用户接管等待不占用其他轮次的操作队列。 */
  userControlWaiters: Set<() => void>;
}

interface PendingServiceRequest {
  method: string;
  startedAt: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ComputerServiceProgress {
  requestId: string;
  stage: string;
  elementCount: number;
  elapsedMs: number;
}

type ComputerPermissionKind = 'accessibility' | 'screen_capture';

interface CreateComputerHostOptions {
  statePath: string;
  artifactRoot: string;
  helperExecutable: string;
  parentPid: number;
  mainCommandLedger: () => MainCommandLedger;
  readOnlyValidation?: boolean;
  now?: () => string;
}

const serviceIdleTimeoutMs = 2 * 60_000;
const serviceRequestTimeoutMs = 35_000;
const snapshotDeadlineMs = 30_000;
/** 长时间接管分段返回等待状态，避免跨进程 HTTP 请求超时结束原任务。 */
const userControlWaitTimeoutMs = 60_000;
const serviceTerminationGraceMs = 1_000;
const serviceTerminationKillWaitMs = 2_000;
const maximumServiceLineBytes = 16 * 1024 * 1024;
const maximumServiceDiagnosticBytes = 32 * 1024;
const serviceProgressPrefix = 'ZEUS_COMPUTER_PROGRESS ';

export class ComputerHost implements BrowserAutomationPort {
  private readonly now: () => string;
  private readonly statePath: string;
  private readonly artifactRoot: string;
  private readonly helperExecutable: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readonly pending = new Map<string, PendingServiceRequest>();
  private serviceRecovery: Promise<void> | null = null;
  private serviceRecoveryFailure: Error | null = null;
  private lastServiceProgress: ComputerServiceProgress | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private settings: ZeusComputerSettings;
  private ipcRegistered = false;
  private closed = false;
  /** 按完整轮次身份隔离状态；同一应用的冲突由原生进程身份判断。 */
  private readonly controlOwners = new Map<string, ComputerControlOwner>();
  /** 停止世代使目标检查、排队和启动中的请求一并失效。 */
  private controlGeneration = 0;
  /** 已撤销的轮次不允许自动恢复；随本宿主退出释放。 */
  private readonly revokedTurns = new Set<string>();
  /** 原生服务使用串行请求，避免快照和动作互相越过。 */
  private operationTail: Promise<void> = Promise.resolve();
  /** 设置入口和工具入口共用一次启动，避免生成两个 Helper。 */
  private serviceStartup: Promise<void> | null = null;

  constructor(private readonly options: CreateComputerHostOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.statePath = resolve(options.statePath);
    this.artifactRoot = resolve(options.artifactRoot);
    this.helperExecutable = resolve(options.helperExecutable);
    this.settings = {
      enabled: false,
      serviceState: 'disabled',
      accessibilityTrusted: false,
      screenCaptureAvailable: false,
    };
    this.restoreSettings();
  }

  registerIpc(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;
    ipcMain.handle('zeus:computer:get-settings', () => this.getSettings());
    ipcMain.handle('zeus:computer:get-preview', (_event, conversationId: unknown) => this.getPreview(conversationId));
    ipcMain.handle('zeus:computer:update-settings', async (_event, request: MainCommandRequest) => {
      return this.options.mainCommandLedger().execute(request, 'desktop.computer.update_settings', async (input, command) => {
        this.assertWritable();
        await command.markWriteStarted();
        const record = isRecord(input) ? input : {};
        this.settings = {
          ...this.settings,
          enabled: record.enabled === true,
          serviceState: record.enabled === true ? (this.child ? 'ready' : 'idle') : 'disabled',
          detail: record.enabled === true ? 'Computer Use 已由用户全局启用；系统权限仍由 macOS 管理。' : 'Computer Use 已关闭。',
        };
        if (!this.settings.enabled) {
          await this.stop('disabled');
          await this.persistSettings();
          return this.getSettings();
        }
        await this.persistSettings();
        await this.ensureService();
        return this.requestPermissions({ accessibility: true, screenCapture: true });
      });
    });
    ipcMain.handle('zeus:computer:request-permissions', async (_event, request: MainCommandRequest) => {
      return this.options.mainCommandLedger().execute(request, 'desktop.computer.request_permissions', async (_input, command) => {
        this.assertWritable();
        if (!this.settings.enabled) throw Object.assign(new Error('请先启用 Computer Use。'), { code: 'ZEUS_COMPUTER_DISABLED' });
        await command.markWriteStarted();
        await this.ensureService();
        return this.requestPermissions({ accessibility: true, screenCapture: true });
      });
    });
    ipcMain.handle('zeus:computer:open-permission-settings', async (_event, request: MainCommandRequest) => {
      return this.options.mainCommandLedger().execute(request, 'desktop.computer.open_permission_settings', async (input, command) => {
        this.assertWritable();
        const permission = computerPermissionKind(input);
        await command.markWriteStarted();
        await shell.openExternal(computerPermissionSettingsUrl(permission));
        return { opened: true as const, permission };
      });
    });
    ipcMain.handle('zeus:computer:stop', async (_event, request: MainCommandRequest) => {
      return this.options.mainCommandLedger().execute(request, 'desktop.computer.stop', async (input, command) => {
        this.assertWritable();
        if (input != null) this.assertPreviewOwner(input);
        await command.markWriteStarted();
        await this.stopFromUser(input);
        return this.getSettings();
      });
    });
    ipcMain.handle('zeus:computer:resume', async (_event, request: MainCommandRequest) => {
      return this.options.mainCommandLedger().execute(request, 'desktop.computer.resume', async (input, command) => {
        this.assertWritable();
        this.assertPreviewOwner(input);
        await command.markWriteStarted();
        await this.resumeFromUser(input);
        return { resumed: true };
      });
    });
  }

  getSettings(): ZeusComputerSettings {
    return { ...this.settings };
  }

  /** 只读查询不会启动 Helper；其他会话看不到当前控制画面。 */
  getPreview(conversationId: unknown): ZeusComputerPreview | null {
    return [...this.controlOwners.values()].find((owner) => owner.input.conversationId === conversationId && owner.preview)?.preview ?? null;
  }

  /** 设置入口可以全局停止；会话按钮必须仍属于当前控制者。 */
  async stopFromUser(input?: unknown): Promise<void> {
    this.assertWritable();
    if (input != null) await this.stopOwner(this.assertPreviewOwner(input));
    else await this.stop('user');
  }

  /** 用户继续仅解除暂停，不启动新 Helper，也不恢复已结束的轮次。 */
  async resumeFromUser(input: unknown): Promise<void> {
    this.assertWritable();
    const owner = this.assertPreviewOwner(input);
    await this.callService('resume_control', { _control_session_id: owner.id });
    this.assertPreviewOwner(input);
  }

  /** 在每个用户命令的写入前复核会话与控制身份。 */
  private assertPreviewOwner(input: unknown): ComputerControlOwner {
    /** 同一会话旧轮次的按钮不能操作新控制。 */
    const owner = isRecord(input) ? [...this.controlOwners.values()].find((candidate) => candidate.id === input.sessionId && candidate.input.conversationId === input.conversationId) : undefined;
    if (!owner) throw Object.assign(new Error('该会话的屏幕控制已结束或发生变化，请查看当前会话状态。'), { code: 'ZEUS_COMPUTER_STOPPED' });
    return owner;
  }

  async invoke(input: BrowserAutomationToolCall): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    // 直接宿主入口也必须有期限；已有调度期限不能因排队或目标检查而重新计时。
    input = { ...input, deadlineUnixMs: input.deadlineUnixMs ?? Date.now() + 120_000 };
    if (input.namespace !== 'zeus_computer') return computerText(`ComputerHost 不支持命名空间：${String(input.namespace)}`, false);
    if (this.options.readOnlyValidation) return computerText('只读验证模式禁止启动或调用 Computer Use。', false);
    if (!this.settings.enabled) return computerText('Zeus Computer Use 尚未在设置中全局启用。', false);
    if (!isComputerMethod(input.tool)) return computerText(`Computer Use 方法不受支持：${input.tool}`, false);
    // 入队前捕获停止世代，用户停止后不能由旧排队请求重新取得控制权。
    const generation = this.controlGeneration;
    /** 观察状态按轮次绑定，不再从第一次观察起独占整个宿主。 */
    let owner: ComputerControlOwner | undefined;
    try {
      this.assertControlAllowed(input, generation);
      if (input.tool !== 'list_apps') {
        /** 完整身份防止同一产品会话的不同原生轮次共用观察。 */
        const key = JSON.stringify([input.conversationId, input.threadId, input.turnId]);
        owner = this.controlOwners.get(key);
        if (!owner) {
          owner = { id: randomUUID(), input: { conversationId: input.conversationId, threadId: input.threadId, turnId: input.turnId }, snapshots: new Map(), preview: null, userControlWaiters: new Set() };
          this.controlOwners.set(key, owner);
        }
        // 新控制开始时取消此前只读查询留下的空闲回收计时。
        this.scheduleIdleStop();
        if (owner.preview?.paused) {
          await this.waitForUserControl(input, generation, owner);
          return this.userControlContinuation(owner, '当前请求尚未执行。');
        }
      }
    } catch (error) {
      return computerText(error instanceof Error ? error.message : String(error), false);
    }
    // 排队与实际执行分别计时，避免把调度等待归因于界面操作。
    const queuedAt = performance.now();
    const operation = this.operationTail.then(() => this.invokeSerial(input, generation, queuedAt, owner));
    this.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** 与文件、浏览器工具独立，仅串行执行桌面工具。 */
  private async invokeSerial(input: BrowserAutomationToolCall, generation: number, queuedAt: number, owner: ComputerControlOwner | undefined): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const startedAt = performance.now();
    try {
      this.assertControlAllowed(input, generation);
      await this.ensureService();
      this.assertControlAllowed(input, generation);
      await this.refreshServiceStatus();
      this.assertToolPermissions(input);
      this.assertControlAllowed(input, generation);
      if (owner?.preview?.paused) {
        return this.userControlContinuation(owner, '当前请求尚未执行。');
      }
      const serviceArguments = this.prepareServiceArguments(input, owner);
      await this.prepareActionTarget(input, serviceArguments, generation);
      this.assertControlAllowed(input, generation);
      // 读取时限从目标检查结束后计算，准备耗时不挤占动作后的观察预算。
      if (input.tool === 'get_app_state' || serviceArguments.wait_for !== undefined) serviceArguments._deadline_unix_ms = Date.now() + snapshotDeadlineMs;
      // 动作一旦发出就不能继续使用旧索引；只有实际回读成功才能恢复缓存。
      if (!['get_app_state', 'list_apps'].includes(input.tool)) owner?.snapshots.clear();
      const serviceStartedAt = performance.now();
      const result = await this.callService(input.tool, serviceArguments);
      const serviceFinishedAt = performance.now();
      this.assertControlAllowed(input, generation);
      if (owner && (owner.preview?.paused || asRecord(asRecord(result).control).paused === true || asRecord(asRecord(result).confirmation).code === 'ZEUS_COMPUTER_PAUSED')) {
        return this.userControlContinuation(owner, input.tool === 'get_app_state' ? '观察期间发生用户接管，旧观察已作废。' : '动作已经返回，可能已执行；不得重放，必须重新观察实际结果。');
      }
      if (isRecord(result) && typeof result.snapshot_generation === 'number') this.rememberAppState(input.arguments, result, owner);
      // 先记住动作回读的观察世代，再裁剪模型投影；目标检查始终读取实时控件。
      const { textValue, image } = await this.projectResult(result, input.arguments.full_output === true);
      if (isRecord(textValue)) {
        textValue.diagnostics = {
          ...asRecord(textValue.diagnostics),
          host_queue_ms: startedAt - queuedAt,
          host_prepare_ms: serviceStartedAt - startedAt,
          host_service_ms: serviceFinishedAt - serviceStartedAt,
          host_projection_ms: performance.now() - serviceFinishedAt,
          host_total_ms: performance.now() - queuedAt,
        };
      }
      this.assertControlAllowed(input, generation);
      this.scheduleIdleStop();
      return {
        contentItems: [{ type: 'inputText', text: JSON.stringify(textValue) }, ...(image ? [{ type: 'inputImage' as const, imageUrl: image }] : [])],
        success: true,
      };
    } catch (error) {
      if (input.tool !== 'list_apps') owner?.snapshots.clear();
      this.scheduleIdleStop();
      // 停止会使原生目标失效；按轮次撤销事实返回，不能要求已结束的轮次重新观察。
      try {
        this.assertControlAllowed(input, generation);
      } catch (interruption) {
        return computerText(interruption instanceof Error ? interruption.message : String(interruption), false);
      }
      const record = isRecord(error) ? error : {};
      const code = typeof record.code === 'string' ? record.code : 'ZEUS_COMPUTER_OPERATION_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      if (owner && (code === 'ZEUS_COMPUTER_PAUSED' || owner.preview?.paused)) {
        return this.userControlContinuation(owner, `请求被用户接管打断（${code}: ${message.slice(0, 500)}），可能尚未执行或仅部分执行；不得重放，必须重新观察实际结果。`);
      }
      this.settings = { ...this.settings, serviceState: this.child ? 'ready' : 'error', detail: `${code}: ${message}`.slice(0, 1000) };
      return computerText(`${code}: ${message}`.slice(0, 2000), false);
    }
  }

  /** 等待原生空闲通知，不占用原生请求超时，也不向服务投递恢复或旧动作。 */
  private async waitForUserControl(input: BrowserAutomationToolCall, generation: number, owner: ComputerControlOwner): Promise<void> {
    owner.snapshots.clear();
    this.assertControlAllowed(input, generation);
    /** 错误响应可能先于预览事件到达，先核对原生状态，不能误报已空闲。 */
    const status = asRecord(await this.callService('status', { _control_session_id: owner.id }));
    this.assertControlAllowed(input, generation);
    if (owner.preview?.paused || asRecord(status.control).paused === true)
      await new Promise<void>((resolveWait) => {
        /** 恢复、停止和等待上限共用清理出口，避免遗留计时器或回调。 */
        const finish = (): void => {
          clearTimeout(timer);
          owner.userControlWaiters.delete(finish);
          resolveWait();
        };
        /** 等待上限只返回继续等待的结果，不撤销控制或执行动作。 */
        const timer = setTimeout(finish, Math.min(userControlWaitTimeoutMs, (input.deadlineUnixMs ?? Date.now() + userControlWaitTimeoutMs) - Date.now()));
        owner.userControlWaiters.add(finish);
      });
    this.assertControlAllowed(input, generation);
  }

  /** 将临时接管作为可继续的工具结果，明确要求重新观察而非结束任务。 */
  private userControlContinuation(owner: ComputerControlOwner, outcome: string): { contentItems: BrowserAutomationContentItem[]; success: boolean } {
    /** 超时后仍在接管时继续等候，不谎报已恢复。 */
    const waiting = owner.preview?.paused === true;
    return computerText(
      JSON.stringify({
        status: waiting ? 'waiting_for_user' : 'user_control_resumed',
        requires_observation: true,
        action_replayed: false,
        message: `${outcome} ${waiting ? '用户仍在操作，请保留原任务并再次调用 get_app_state 继续等待，不要结束本轮。' : '用户操作等待已结束，请立即调用 get_app_state 获取新状态后继续原任务。'} 无需用户点击继续或发送新消息。`,
      }),
      true,
    );
  }

  /** 统一接收正常完成、失败和用户中断；旧轮次通知不得停止新轮次。 */
  async endComputerUse(input: { conversationId: string; turnId: string }): Promise<void> {
    this.revokedTurns.add(JSON.stringify([input.conversationId, input.turnId]));
    await Promise.all([...this.controlOwners.values()].filter((owner) => owner.input.conversationId === input.conversationId && owner.input.turnId === input.turnId).map((owner) => this.stopOwner(owner)));
  }

  /** 立即撤销指定轮次，原生停止命令不排在耗时观察之后，也不终止其他采集。 */
  private async stopOwner(owner: ComputerControlOwner): Promise<void> {
    this.revokedTurns.add(JSON.stringify([owner.input.conversationId, owner.input.turnId]));
    this.controlOwners.delete(JSON.stringify([owner.input.conversationId, owner.input.threadId, owner.input.turnId]));
    owner.preview = null;
    owner.snapshots.clear();
    for (const finish of owner.userControlWaiters) finish();
    if (this.child) await this.callService('stop_control', { _control_session_id: owner.id });
    this.scheduleIdleStop();
  }

  /** 所有异步边界复核同一停止世代，目标检查通过不代表已撤销控制可以恢复。 */
  private assertControlAllowed(input: BrowserAutomationToolCall, generation: number): void {
    if (input.deadlineUnixMs !== undefined && (!Number.isFinite(input.deadlineUnixMs) || Date.now() >= input.deadlineUnixMs)) {
      throw Object.assign(new Error('ZEUS_COMPUTER_CALL_EXPIRED: 本次调用期限已结束；不得继续或重放动作，请重新观察实际结果。'), { code: 'ZEUS_COMPUTER_CALL_EXPIRED' });
    }
    if (this.closed || !this.settings.enabled || generation !== this.controlGeneration || this.revokedTurns.has(JSON.stringify([input.conversationId, input.turnId]))) {
      throw Object.assign(new Error('ZEUS_COMPUTER_STOPPED: 本轮桌面控制已撤销；需要用户发起新轮次，禁止自动恢复或重试动作。'), { code: 'ZEUS_COMPUTER_STOPPED' });
    }
  }

  /** 先撤销所有排队和在途请求，再释放原生资源。 */
  private revokeControl(): void {
    this.controlGeneration += 1;
    for (const owner of this.controlOwners.values()) {
      this.revokedTurns.add(JSON.stringify([owner.input.conversationId, owner.input.turnId]));
      owner.preview = null;
      owner.snapshots.clear();
      for (const finish of owner.userControlWaiters) finish();
    }
    this.controlOwners.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stop('close');
  }

  private async ensureService(): Promise<void> {
    if (this.serviceStartup) return this.serviceStartup;
    const generation = this.controlGeneration;
    const startup = this.startService(generation);
    this.serviceStartup = startup;
    try {
      await startup;
    } finally {
      if (this.serviceStartup === startup) this.serviceStartup = null;
    }
  }

  /** 启动等待期间发生停止时，不创建新的原生进程。 */
  private async startService(generation: number): Promise<void> {
    if (this.serviceRecovery) await this.serviceRecovery;
    if (this.serviceRecoveryFailure) throw this.serviceRecoveryFailure;
    if (this.child && !this.child.killed) return;
    const executable = await stat(this.helperExecutable).catch(() => null);
    if (!executable?.isFile()) {
      throw Object.assign(new Error(`Zeus Computer Service 不存在：${this.helperExecutable}`), { code: 'ZEUS_COMPUTER_SERVICE_MISSING' });
    }
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    if (this.closed || !this.settings.enabled || generation !== this.controlGeneration) throw new Error('Computer Use 已关闭或本次启动已撤销。');
    this.settings = { ...this.settings, serviceState: 'starting', detail: '正在启动 Zeus Computer Service…' };
    const child = spawn(this.helperExecutable, [], {
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: process.env.LANG ?? 'zh_CN.UTF-8',
        ZEUS_COMPUTER_ARTIFACT_ROOT: this.artifactRoot,
        ZEUS_PARENT_PID: String(this.options.parentPid),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.lastServiceProgress = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(child, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.consumeStderr(child, chunk));
    child.once('error', (error) => this.handleServiceExit(child, error));
    child.once('exit', (code, signal) => this.handleServiceExit(child, new Error(`Zeus Computer Service 已退出（${String(code ?? signal ?? 'unknown')}）。`)));
    await this.refreshServiceStatus();
  }

  private async refreshServiceStatus(): Promise<ZeusComputerSettings> {
    const status = asRecord(await this.callService('status', {}));
    this.settings = {
      ...this.settings,
      serviceState: 'ready',
      accessibilityTrusted: status.accessibilityTrusted === true,
      screenCaptureAvailable: status.screenCaptureAvailable === true,
      detail: computerPermissionDetail(status.accessibilityTrusted === true, status.screenCaptureAvailable === true),
    };
    return this.getSettings();
  }

  private async requestPermissions(input: { accessibility: boolean; screenCapture: boolean }): Promise<ZeusComputerSettings> {
    const status = asRecord(await this.callService('request_permissions', input));
    this.settings = {
      ...this.settings,
      serviceState: 'ready',
      accessibilityTrusted: status.accessibilityTrusted === true,
      screenCaptureAvailable: status.screenCaptureAvailable === true,
      detail: computerPermissionDetail(status.accessibilityTrusted === true, status.screenCaptureAvailable === true),
    };
    return this.getSettings();
  }

  /** 使用期间只检查权限；申请入口仅保留在系统设置操作中。 */
  private assertToolPermissions(input: BrowserAutomationToolCall): void {
    if (input.tool === 'list_apps') return;
    if (!this.settings.accessibilityTrusted) {
      throw Object.assign(new Error('请前往 Zeus 系统设置的 Computer Use 完成 macOS 辅助功能与录屏授权；本次操作尚未执行，不会自动申请或重试。'), { code: 'ZEUS_COMPUTER_ACCESSIBILITY_PERMISSION_REQUIRED' });
    }
    if (!this.settings.screenCaptureAvailable) {
      throw Object.assign(new Error('请前往 Zeus 系统设置的 Computer Use 完成 macOS 录屏授权；本次操作尚未执行，不会自动申请或重试。'), { code: 'ZEUS_COMPUTER_SCREEN_CAPTURE_PERMISSION_REQUIRED' });
    }
  }

  private callService(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(Object.assign(new Error('Zeus Computer Service 未运行。'), { code: 'ZEUS_COMPUTER_SERVICE_OFFLINE' }));
    }
    const id = `computer-${randomUUID()}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.recycleTimedOutService(child, id);
      }, serviceRequestTimeoutMs);
      timer.unref();
      this.pending.set(id, { method, startedAt: Date.now(), resolve: resolveRequest, reject: rejectRequest, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private consumeStderr(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (child !== this.child) return;
    this.stderrBuffer += chunk;
    if (Buffer.byteLength(this.stderrBuffer, 'utf8') > maximumServiceDiagnosticBytes) this.stderrBuffer = this.stderrBuffer.slice(-maximumServiceDiagnosticBytes);
    while (true) {
      const newline = this.stderrBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stderrBuffer.slice(0, newline).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (!line) continue;
      if (!line.startsWith(serviceProgressPrefix)) {
        this.settings = { ...this.settings, detail: line.slice(0, 1000) };
        continue;
      }
      try {
        const progress = JSON.parse(line.slice(serviceProgressPrefix.length)) as Record<string, unknown>;
        if (typeof progress.requestId === 'string' && typeof progress.stage === 'string' && typeof progress.elementCount === 'number' && typeof progress.elapsedMs === 'number') {
          this.lastServiceProgress = {
            requestId: progress.requestId,
            stage: progress.stage,
            elementCount: progress.elementCount,
            elapsedMs: progress.elapsedMs,
          };
        }
      } catch {
        this.settings = { ...this.settings, detail: 'Zeus Computer Service 返回了无效进度诊断。' };
      }
    }
  }

  private consumeStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (child !== this.child) return;
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > maximumServiceLineBytes) {
      this.recycleFailedService(child, Object.assign(new Error('Zeus Computer Service 响应超过允许大小。'), { code: 'ZEUS_COMPUTER_RESPONSE_TOO_LARGE' }));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let response: ComputerServiceResponse;
      try {
        response = JSON.parse(line) as ComputerServiceResponse;
      } catch {
        this.recycleFailedService(child, Object.assign(new Error('Zeus Computer Service 返回了无效 JSON。'), { code: 'ZEUS_COMPUTER_RESPONSE_INVALID' }));
        return;
      }
      if (response.event === 'control_stopped') {
        /** 原生菜单或系统停止只撤销对应轮次。 */
        const owner = [...this.controlOwners.values()].find((candidate) => candidate.id === response.sessionId);
        if (owner) void this.stopOwner(owner).catch(() => undefined);
        continue;
      }
      if (response.event === 'control_preview') {
        this.rememberPreview(response);
        continue;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else {
        pending.reject(
          Object.assign(new Error(response.error?.message || 'Zeus Computer Service 调用失败。'), {
            code: response.error?.code || 'ZEUS_COMPUTER_OPERATION_FAILED',
          }),
        );
      }
    }
  }

  /** 拒绝旧控制及无效图像，原生身份由宿主映射为产品会话。 */
  private rememberPreview(response: ComputerServiceResponse): void {
    const owner = [...this.controlOwners.values()].find((candidate) => candidate.id === response.sessionId);
    const value = response.preview;
    if (!owner || response.sessionId !== owner.id || !isRecord(value) || typeof value.appName !== 'string' || typeof value.paused !== 'boolean' || typeof value.needsObservation !== 'boolean') return;
    if (value.imageUrl !== null && (typeof value.imageUrl !== 'string' || value.imageUrl.length > 1024 * 1024 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/u.test(value.imageUrl))) return;
    const point = isRecord(value.cursor) ? value.cursor : null;
    const cursor =
      point && typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 ? { x: point.x, y: point.y } : null;
    owner.preview = {
      conversationId: owner.input.conversationId,
      sessionId: owner.id,
      appName: value.appName.slice(0, 200),
      paused: value.paused,
      needsObservation: value.needsObservation,
      imageUrl: value.imageUrl as string | null,
      cursor,
    };
    if (value.paused || value.needsObservation) owner.snapshots.clear();
    if (!value.paused) {
      for (const finish of owner.userControlWaiters) finish();
    }
  }

  private handleServiceExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (!this.detachService(child, (id, pending) => serviceInterruptionError(id, pending, error.message, 'ZEUS_COMPUTER_SERVICE_OFFLINE', this.lastServiceProgress, child.pid))) return;
    if (!this.closed && this.settings.enabled) this.settings = { ...this.settings, serviceState: 'error', detail: error.message.slice(0, 1000) };
  }

  private recycleFailedService(child: ChildProcessWithoutNullStreams, error: Error): void {
    const detached = this.detachService(child, (id, pending) => serviceInterruptionError(id, pending, error.message, 'ZEUS_COMPUTER_SERVICE_OFFLINE', this.lastServiceProgress, child.pid));
    if (!detached) return;
    this.settings = { ...this.settings, serviceState: 'error', detail: error.message.slice(0, 1000) };
    this.beginServiceRecovery(child);
  }

  private detachService(child: ChildProcessWithoutNullStreams, rejection: (id: string, pending: PendingServiceRequest) => Error): boolean {
    if (child !== this.child) return false;
    this.revokeControl();
    child.removeAllListeners();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.stdin.destroy();
    this.child = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(rejection(id, pending));
    }
    this.pending.clear();
    return true;
  }

  private recycleTimedOutService(child: ChildProcessWithoutNullStreams, timedOutRequestId: string): void {
    const helperPid = child.pid;
    const detached = this.detachService(child, (id, pending) => {
      const message = id === timedOutRequestId ? `Computer Use 调用超时：${pending.method}` : `Computer Use 因同一 Helper 超时而中止：${pending.method}`;
      return serviceInterruptionError(id, pending, message, 'ZEUS_COMPUTER_SERVICE_TIMEOUT', this.lastServiceProgress, helperPid);
    });
    if (!detached) return;
    this.settings = { ...this.settings, serviceState: 'error', detail: `ZEUS_COMPUTER_SERVICE_TIMEOUT: helperPid=${String(helperPid ?? 'unknown')}` };
    this.beginServiceRecovery(child);
  }

  private beginServiceRecovery(child: ChildProcessWithoutNullStreams): void {
    const recovery = this.terminateService(child)
      .catch((error: unknown) => {
        this.serviceRecoveryFailure = error instanceof Error ? error : new Error(String(error));
        this.settings = { ...this.settings, serviceState: 'error', detail: this.serviceRecoveryFailure.message.slice(0, 1000) };
      })
      .finally(() => {
        if (this.serviceRecovery === recovery) this.serviceRecovery = null;
      });
    this.serviceRecovery = recovery;
  }

  private async terminateService(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (serviceHasExited(child)) return;
    const gracefulExit = waitForServiceExit(child, serviceTerminationGraceMs);
    child.kill('SIGTERM');
    if (await gracefulExit) return;
    const forcedExit = waitForServiceExit(child, serviceTerminationKillWaitMs);
    child.kill('SIGKILL');
    if (await forcedExit) return;
    throw Object.assign(new Error(`Zeus Computer Service 无法终止（pid=${String(child.pid ?? 'unknown')}）。`), { code: 'ZEUS_COMPUTER_SERVICE_TERMINATION_FAILED' });
  }

  private async stop(reason: string): Promise<void> {
    this.revokeControl();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    // 同步脱离旧进程，再等待退出；新轮次启动必须等回收完成，不能并存两个采集服务。
    const child = this.child;
    if (child) {
      this.settings = { ...this.settings, serviceState: 'stopping', detail: `正在停止 Computer Use（${reason}）…` };
      this.detachService(child, (id, pending) => serviceInterruptionError(id, pending, 'Computer Use 已停止。', 'ZEUS_COMPUTER_STOPPED', this.lastServiceProgress, child.pid));
      this.beginServiceRecovery(child);
    }
    if (this.serviceRecovery) await this.serviceRecovery;
    if (this.serviceRecoveryFailure) {
      this.settings = { ...this.settings, serviceState: 'error', detail: this.serviceRecoveryFailure.message.slice(0, 1000) };
      return;
    }
    this.settings = { ...this.settings, serviceState: this.settings.enabled ? 'idle' : 'disabled', detail: 'Computer Use 已停止。' };
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // 活跃采集由轮次生命周期结束；空闲 Helper 才采用延迟回收。
    if (this.controlOwners.size > 0) return;
    this.idleTimer = setTimeout(() => void this.stop('idle'), serviceIdleTimeoutMs);
    this.idleTimer.unref();
  }

  private rememberAppState(args: Record<string, unknown>, result: unknown, owner: ComputerControlOwner | undefined): void {
    const record = asRecord(result);
    const appRecord = isRecord(record.application) ? record.application : isRecord(record.app) ? record.app : {};
    const appKeys = [args.app, typeof record.app === 'string' ? record.app : undefined, appRecord.name, appRecord.bundleId, appRecord.path].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const generation = typeof record.snapshot_generation === 'number' ? record.snapshot_generation : 0;
    for (const key of appKeys) owner?.snapshots.set(key, generation);
    const status = isRecord(record.status) ? record.status : {};
    this.settings = {
      ...this.settings,
      accessibilityTrusted: status.accessibilityTrusted === true,
      screenCaptureAvailable: status.screenCaptureAvailable === true,
      serviceState: 'ready',
    };
  }

  /** Codex 与 Pi 共用全局授权，执行前绑定真实目标；允许已授权的登录输入。 */
  private async prepareActionTarget(input: BrowserAutomationToolCall, serviceArguments: Record<string, unknown>, generation: number): Promise<void> {
    if (!['click', 'drag', 'paste', 'perform_secondary_action', 'press_key', 'set_value', 'type_text'].includes(input.tool)) return;
    /** 控件及一次性校验凭据均来自实际原生窗口，不由调用者声明。 */
    const target = asRecord(await this.callService('describe_target', { ...serviceArguments, _action_tool: input.tool }));
    this.assertControlAllowed(input, generation);
    if (typeof target.token !== 'string' || !target.token || typeof target.appName !== 'string' || !target.appName || typeof target.windowId !== 'number' || typeof target.role !== 'string' || !target.role) {
      throw Object.assign(new Error('无法确认这次操作的目标控件；请重新读取目标窗口，动作尚未执行。'), { code: 'ZEUS_COMPUTER_TARGET_UNAVAILABLE' });
    }
    serviceArguments._action_token = target.token;
  }

  /** 内部身份与目标校验凭据只由宿主写入，模型参数不能伪造。 */
  private prepareServiceArguments(input: BrowserAutomationToolCall, owner: ComputerControlOwner | undefined): Record<string, unknown> {
    const args: Record<string, unknown> = { ...Object.fromEntries(Object.entries(input.arguments).filter(([key]) => !key.startsWith('_'))), _control_session_id: owner?.id };
    const app = typeof args.app === 'string' ? args.app : '';
    const snapshot = app ? owner?.snapshots.get(app) : undefined;
    if (input.tool === 'get_app_state' || args.wait_for !== undefined) {
      if (args.disableDiff !== true && args.previous_snapshot_generation === undefined && snapshot) args.previous_snapshot_generation = snapshot;
      if (args.disableDiff === true) delete args.previous_snapshot_generation;
      if (args.include_screenshot === undefined) args.include_screenshot = input.tool === 'get_app_state' && !snapshot;
    }
    if (typeof args.element_index === 'number' && args.snapshot_generation === undefined) {
      if (!snapshot) throw Object.assign(new Error('element_index 没有当前 AX 快照，请重新调用 get_app_state。'), { code: 'ZEUS_COMPUTER_ELEMENT_STALE' });
      args.snapshot_generation = snapshot;
    }
    return args;
  }

  /** 默认只投影一份紧凑树或更小的差异；完整原始快照由原生服务保留。 */
  private compactResult(result: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(result.elements)) return { ...result };
    /** 保留空 value、禁用和安全字段；省略几何信息及可由默认值还原的属性。 */
    const compactElement = (element: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(element).filter(
          ([key, value]) => key !== 'frame' && !(key !== 'value' && value === '') && !(key === 'enabled' && value === true) && !(['focused', 'secure'].includes(key) && value === false) && !(key === 'description' && value === element.title),
        ),
      );
    const projected = { ...result };
    const elements = result.elements.filter(isRecord).map(compactElement);
    delete projected.text;
    delete projected.diff;
    projected.elements = elements;
    // 差异缺失、不完整或比整树更大时直接返回整树，不让模型补读分页。
    const diff = asRecord(result.diff);
    if (diff.available === true && diff.truncated === false) {
      const compactDiff = {
        previous_generation: diff.previous_generation,
        current_generation: diff.current_generation,
        added: Array.isArray(diff.added) ? diff.added.filter(isRecord).map(compactElement) : [],
        changed: Array.isArray(diff.changed) ? diff.changed.filter(isRecord).map((change) => compactElement(asRecord(change.after))) : [],
        removed: Array.isArray(diff.removed) ? diff.removed.filter(isRecord).map((element) => element.element_index) : [],
      };
      if (JSON.stringify(compactDiff).length < JSON.stringify(elements).length) {
        delete projected.elements;
        projected.diff = compactDiff;
      }
    }
    return projected;
  }

  /** 截图产物校验与模型投影共用一个出口，既不暴露文件路径也不重复传树。 */
  private async projectResult(result: unknown, fullOutput = false): Promise<{ textValue: unknown; image: string | null }> {
    if (isRecord(result) && !fullOutput) result = this.compactResult(result);
    if (!isRecord(result) || !isRecord(result.screenshot)) return { textValue: result, image: null };
    const screenshot = result.screenshot;
    const artifactPath = typeof screenshot.artifactPath === 'string' ? resolve(screenshot.artifactPath) : '';
    const rootRelative = artifactPath ? relative(this.artifactRoot, artifactPath) : '..';
    if (!artifactPath || rootRelative.startsWith('..') || isAbsolute(rootRelative)) {
      return { textValue: { ...result, screenshot: { error: 'invalid_artifact_path' } }, image: null };
    }
    const file = await stat(artifactPath).catch(() => null);
    if (!file?.isFile() || file.size <= 0 || file.size > 30 * 1024 * 1024) {
      return { textValue: { ...result, screenshot: { error: 'artifact_unavailable' } }, image: null };
    }
    const data = await readFile(artifactPath);
    return {
      textValue: {
        ...result,
        screenshot: {
          mimeType: 'image/png',
          artifactHandle: basename(artifactPath),
          byteLength: file.size,
          width: screenshot.width,
          height: screenshot.height,
          window_id: screenshot.window_id,
          frame: screenshot.frame,
          scale: screenshot.scale,
          captured_at: screenshot.captured_at,
          frame_confirmed_at: screenshot.frame_confirmed_at,
          after_ax_read: screenshot.after_ax_read,
        },
      },
      image: `data:image/png;base64,${data.toString('base64')}`,
    };
  }

  private restoreSettings(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as { enabled?: unknown };
      this.settings = {
        ...this.settings,
        enabled: parsed.enabled === true,
        serviceState: parsed.enabled === true ? 'idle' : 'disabled',
      };
    } catch {
      // 首次运行或损坏设置都安全回退为未启用，不触发系统权限或 Helper 启动。
    }
  }

  private async persistSettings(): Promise<void> {
    const directoryPath = dirname(this.statePath);
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, enabled: this.settings.enabled, updatedAt: this.now() }, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.statePath);
  }

  private assertWritable(): void {
    if (!this.options.readOnlyValidation) return;
    throw Object.assign(new Error('只读验证模式禁止修改 Computer Use 设置或启动服务。'), { code: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED' });
  }
}

export function createComputerHost(options: CreateComputerHostOptions): ComputerHost {
  return new ComputerHost(options);
}

function isComputerMethod(value: string): boolean {
  return ['list_apps', 'get_app_state', 'click', 'drag', 'paste', 'perform_secondary_action', 'press_key', 'scroll', 'select_text', 'set_value', 'type_text'].includes(value);
}

function computerText(text: string, success: boolean): { contentItems: BrowserAutomationContentItem[]; success: boolean } {
  return { contentItems: [{ type: 'inputText', text }], success };
}

function computerPermissionKind(value: unknown): ComputerPermissionKind {
  const record = isRecord(value) ? value : {};
  if (record.permission === 'accessibility' || record.permission === 'screen_capture') return record.permission;
  throw Object.assign(new Error('Computer Use 权限设置类型无效。'), { code: 'ZEUS_COMPUTER_PERMISSION_KIND_INVALID' });
}

function computerPermissionSettingsUrl(permission: ComputerPermissionKind): string {
  return permission === 'accessibility' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
}

function computerPermissionDetail(accessibilityTrusted: boolean, screenCaptureAvailable: boolean): string {
  if (accessibilityTrusted && screenCaptureAvailable) return 'Zeus Computer Service 已获得辅助功能与屏幕录制权限。';
  if (!accessibilityTrusted && !screenCaptureAvailable) return '请授予 Zeus Computer Service 辅助功能与屏幕录制权限。';
  if (!accessibilityTrusted) return '请授予 Zeus Computer Service 辅助功能权限。';
  return '请授予 Zeus Computer Service 屏幕录制权限；辅助功能已就绪。';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function serviceInterruptionError(requestId: string, pending: PendingServiceRequest, message: string, fallbackCode: string, progress: ComputerServiceProgress | null, helperPid: number | undefined): Error {
  const elapsedMs = Date.now() - pending.startedAt;
  const stage = progress?.requestId === requestId ? progress.stage : 'queued_or_startup';
  const elementCount = progress?.requestId === requestId ? progress.elementCount : 0;
  const diagnostic = `helperPid=${String(helperPid ?? 'unknown')}, stage=${stage}, elements=${elementCount}, elapsedMs=${elapsedMs}`;
  if (computerServiceMethodMayHaveEffect(pending.method)) {
    return Object.assign(new Error(`${message}；动作可能已经生效，不得自动重试（${diagnostic}）。`), { code: 'ZEUS_COMPUTER_EFFECT_UNKNOWN' });
  }
  return Object.assign(new Error(`${message}（${diagnostic}）。`), { code: fallbackCode });
}

function computerServiceMethodMayHaveEffect(method: string): boolean {
  return ['request_permissions', 'click', 'drag', 'paste', 'perform_secondary_action', 'press_key', 'scroll', 'select_text', 'set_value', 'type_text'].includes(method);
}

function serviceHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForServiceExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (serviceHasExited(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      resolveWait(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(serviceHasExited(child));
    child.once('exit', onExit);
    child.once('error', onError);
    const timer = setTimeout(() => finish(serviceHasExited(child)), timeoutMs);
    timer.unref();
    if (serviceHasExited(child)) finish(true);
  });
}
