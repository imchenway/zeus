import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { BrowserAutomationContentItem, BrowserAutomationPort, BrowserAutomationToolCall } from '@zeus/local-server';
import type { ZeusComputerSettings } from '@zeus/shared';
import type { MainCommandLedger, MainCommandRequest } from './mainCommandLedger.js';

interface ComputerServiceResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

interface PendingServiceRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ComputerElementSummary {
  element_index?: number;
  role?: string;
  subrole?: string;
  title?: string;
  description?: string;
  identifier?: string;
  value?: unknown;
  secure?: boolean;
  focused?: boolean;
  frame?: { x?: number; y?: number; width?: number; height?: number };
}

type ComputerPermissionKind = 'accessibility' | 'screen_capture';

interface CreateComputerHostOptions {
  statePath: string;
  artifactRoot: string;
  helperExecutable: string;
  parentPid: number;
  mainCommandLedger: () => MainCommandLedger;
  readOnlyValidation?: boolean;
  qaMode?: boolean;
  now?: () => string;
}

const serviceIdleTimeoutMs = 2 * 60_000;
const serviceRequestTimeoutMs = 120_000;
const maximumServiceLineBytes = 16 * 1024 * 1024;
const sensitiveActionPattern = /\b(buy|purchase|pay|checkout|order|submit|send|publish|delete|remove|erase|confirm|authorize|transfer|sign|login|注册|登录|提交|发送|发布|购买|支付|下单|删除|移除|确认|授权|转账|签署)\b/iu;
const secureFieldPattern = /\b(password|passcode|otp|one.?time|verification|cvv|cvc|card|iban|routing|account|ssn|身份证|密码|验证码|卡号|账户|密钥|secret|token)\b/iu;

export class ComputerHost implements BrowserAutomationPort {
  private readonly now: () => string;
  private readonly statePath: string;
  private readonly artifactRoot: string;
  private readonly helperExecutable: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private readonly pending = new Map<string, PendingServiceRequest>();
  private readonly latestElements = new Map<string, { generation: number; elements: ComputerElementSummary[] }>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private settings: ZeusComputerSettings;
  private ipcRegistered = false;
  private closed = false;
  private permissionPromptAttemptedForChild = false;

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
      return this.options.mainCommandLedger().execute(request, 'desktop.computer.stop', async (_input, command) => {
        this.assertWritable();
        await command.markWriteStarted();
        await this.stop('user');
        return this.getSettings();
      });
    });
  }

  getSettings(): ZeusComputerSettings {
    return { ...this.settings };
  }

  async invoke(input: BrowserAutomationToolCall): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    if (input.namespace !== 'zeus_computer') return computerText(`ComputerHost 不支持命名空间：${String(input.namespace)}`, false);
    if (this.options.readOnlyValidation) return computerText('只读验证模式禁止启动或调用 Computer Use。', false);
    if (!this.settings.enabled) return computerText('Zeus Computer Use 尚未在设置中全局启用。', false);
    if (!isComputerMethod(input.tool)) return computerText(`Computer Use 方法不受支持：${input.tool}`, false);
    try {
      await this.ensureService();
      await this.refreshServiceStatus();
      await this.requestMissingPermissionsForTool(input);
      await this.ensureSensitiveActionApproval(input);
      const serviceArguments = this.prepareServiceArguments(input);
      const result = await this.callService(input.tool, serviceArguments);
      if (input.tool === 'get_app_state') this.rememberAppState(input.arguments, result);
      else if (!['list_apps'].includes(input.tool)) this.latestElements.clear();
      const { textValue, image } = await this.projectResult(result);
      this.scheduleIdleStop();
      return {
        contentItems: [{ type: 'inputText', text: JSON.stringify(textValue, null, 2) }, ...(image ? [{ type: 'inputImage' as const, imageUrl: image }] : [])],
        success: true,
      };
    } catch (error) {
      this.scheduleIdleStop();
      const record = isRecord(error) ? error : {};
      const code = typeof record.code === 'string' ? record.code : 'ZEUS_COMPUTER_OPERATION_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      this.settings = { ...this.settings, serviceState: this.child ? 'ready' : 'error', detail: `${code}: ${message}`.slice(0, 1000) };
      return computerText(`${code}: ${message}`.slice(0, 2000), false);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stop('close');
  }

  private async ensureService(): Promise<void> {
    if (this.child && !this.child.killed) return;
    const executable = await stat(this.helperExecutable).catch(() => null);
    if (!executable?.isFile()) {
      throw Object.assign(new Error(`Zeus Computer Service 不存在：${this.helperExecutable}`), { code: 'ZEUS_COMPUTER_SERVICE_MISSING' });
    }
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    this.settings = { ...this.settings, serviceState: 'starting', detail: '正在启动 Zeus Computer Service…' };
    const child = spawn(this.helperExecutable, [], {
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: process.env.LANG ?? 'zh_CN.UTF-8',
        ZEUS_COMPUTER_ARTIFACT_ROOT: this.artifactRoot,
        ZEUS_PARENT_PID: String(this.options.parentPid),
        ZEUS_COMPUTER_QA_MODE: this.options.qaMode ? '1' : '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.permissionPromptAttemptedForChild = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const detail = chunk.trim().slice(0, 1000);
      if (detail) this.settings = { ...this.settings, detail };
    });
    child.once('error', (error) => this.handleServiceExit(error));
    child.once('exit', (code, signal) => this.handleServiceExit(new Error(`Zeus Computer Service 已退出（${String(code ?? signal ?? 'unknown')}）。`)));
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
    if (input.accessibility || input.screenCapture) this.permissionPromptAttemptedForChild = true;
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

  private async requestMissingPermissionsForTool(input: BrowserAutomationToolCall): Promise<void> {
    if (input.tool === 'list_apps' || this.permissionPromptAttemptedForChild) return;
    const needsAccessibility = !this.settings.accessibilityTrusted;
    const needsScreenCapture = input.tool === 'get_app_state' && input.arguments.include_screenshot !== false && !this.settings.screenCaptureAvailable;
    if (!needsAccessibility && !needsScreenCapture) return;
    await this.requestPermissions({ accessibility: needsAccessibility, screenCapture: needsScreenCapture });
  }

  private callService(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(Object.assign(new Error('Zeus Computer Service 未运行。'), { code: 'ZEUS_COMPUTER_SERVICE_OFFLINE' }));
    }
    const id = `computer-${randomUUID()}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(Object.assign(new Error(`Computer Use 调用超时：${method}`), { code: 'ZEUS_COMPUTER_SERVICE_TIMEOUT' }));
      }, serviceRequestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
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

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > maximumServiceLineBytes) {
      this.handleServiceExit(Object.assign(new Error('Zeus Computer Service 响应超过允许大小。'), { code: 'ZEUS_COMPUTER_RESPONSE_TOO_LARGE' }));
      void this.stop('protocol_error');
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
        this.handleServiceExit(Object.assign(new Error('Zeus Computer Service 返回了无效 JSON。'), { code: 'ZEUS_COMPUTER_RESPONSE_INVALID' }));
        void this.stop('protocol_error');
        return;
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

  private handleServiceExit(error: Error): void {
    const child = this.child;
    if (child) {
      child.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
    }
    this.child = null;
    this.permissionPromptAttemptedForChild = false;
    this.stdoutBuffer = '';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closed && this.settings.enabled) this.settings = { ...this.settings, serviceState: 'error', detail: error.message.slice(0, 1000) };
  }

  private async stop(reason: string): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const child = this.child;
    if (!child) {
      this.settings = { ...this.settings, serviceState: this.settings.enabled ? 'idle' : 'disabled' };
      return;
    }
    this.settings = { ...this.settings, serviceState: 'stopping', detail: `正在停止 Computer Use（${reason}）…` };
    this.child = null;
    this.permissionPromptAttemptedForChild = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('Computer Use 已停止。'), { code: 'ZEUS_COMPUTER_STOPPED' }));
    }
    this.pending.clear();
    child.removeAllListeners();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.kill('SIGTERM');
    this.latestElements.clear();
    this.settings = { ...this.settings, serviceState: this.settings.enabled ? 'idle' : 'disabled', detail: 'Computer Use 已停止。' };
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.stop('idle'), serviceIdleTimeoutMs);
    this.idleTimer.unref();
  }

  private rememberAppState(args: Record<string, unknown>, result: unknown): void {
    const record = asRecord(result);
    const appRecord = isRecord(record.application) ? record.application : isRecord(record.app) ? record.app : {};
    const appKeys = [args.app, typeof record.app === 'string' ? record.app : undefined, appRecord.name, appRecord.bundleId, appRecord.path].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const generation = typeof record.snapshot_generation === 'number' ? record.snapshot_generation : 0;
    const elements = Array.isArray(record.elements) ? record.elements.filter(isRecord).map((entry) => ({ ...entry })) : [];
    for (const key of appKeys) this.latestElements.set(key, { generation, elements });
    const status = isRecord(record.status) ? record.status : {};
    this.settings = {
      ...this.settings,
      accessibilityTrusted: status.accessibilityTrusted === true,
      screenCaptureAvailable: status.screenCaptureAvailable === true,
      serviceState: 'ready',
    };
  }

  private async ensureSensitiveActionApproval(input: BrowserAutomationToolCall): Promise<void> {
    let element = this.elementFor(input.arguments);
    if (!element && typeof input.arguments.app === 'string' && ['type_text', 'paste', 'press_key'].includes(input.tool)) {
      const refreshed = await this.callService('get_app_state', { app: input.arguments.app, include_screenshot: false, max_elements: 1000 });
      this.rememberAppState({ app: input.arguments.app }, refreshed);
      element = this.focusedElement(input.arguments.app);
    }
    if (!element && typeof input.arguments.app === 'string' && (typeof input.arguments.x === 'number' || typeof input.arguments.from_x === 'number')) {
      const refreshed = await this.callService('get_app_state', { app: input.arguments.app, include_screenshot: false, max_elements: 1000 });
      this.rememberAppState({ app: input.arguments.app }, refreshed);
      element = this.elementAtPoint(input.arguments.app, Number(input.arguments.x ?? input.arguments.from_x), Number(input.arguments.y ?? input.arguments.from_y));
    }
    const descriptor = `${element?.role ?? ''} ${element?.subrole ?? ''} ${element?.title ?? ''} ${element?.description ?? ''} ${element?.identifier ?? ''}`;
    if (element?.secure || secureFieldPattern.test(descriptor)) {
      if (['set_value', 'type_text', 'paste'].includes(input.tool)) {
        throw Object.assign(new Error('Zeus 不读取或填写密码、验证码及其他安全文本字段。'), { code: 'ZEUS_COMPUTER_SECURE_FIELD_BLOCKED' });
      }
    }
    const key = typeof input.arguments.key === 'string' ? input.arguments.key.toLocaleLowerCase() : '';
    const sensitive =
      sensitiveActionPattern.test(descriptor) ||
      (input.tool === 'press_key' && /(^|\+)(enter|return|delete|backspace)$/iu.test(key)) ||
      (['click', 'perform_secondary_action'].includes(input.tool) && Boolean(element && sensitiveActionPattern.test(descriptor))) ||
      (['click', 'perform_secondary_action'].includes(input.tool) && !element && typeof input.arguments.x === 'number');
    if (!sensitive) return;
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['允许一次', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '确认敏感 Computer Use 操作',
      message: 'Agent 请求执行可能产生外部影响的操作。',
      detail: `${input.tool} · ${(element?.title || element?.description || '目标应用').slice(0, 300)}`,
    };
    const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (result.response !== 0) throw Object.assign(new Error('用户已拒绝敏感 Computer Use 操作。'), { code: 'ZEUS_COMPUTER_SENSITIVE_ACTION_DECLINED' });
  }

  private elementFor(args: Record<string, unknown>): ComputerElementSummary | null {
    const app = typeof args.app === 'string' ? args.app : '';
    const index = typeof args.element_index === 'number' ? args.element_index : -1;
    const snapshot = this.latestElements.get(app);
    const generation = typeof args.snapshot_generation === 'number' ? args.snapshot_generation : snapshot?.generation;
    return snapshot && snapshot.generation === generation && index >= 0 ? (snapshot.elements[index] ?? null) : null;
  }

  private prepareServiceArguments(input: BrowserAutomationToolCall): Record<string, unknown> {
    const args = { ...input.arguments };
    const app = typeof args.app === 'string' ? args.app : '';
    const snapshot = app ? this.latestElements.get(app) : undefined;
    if (input.tool === 'get_app_state') {
      if (args.disableDiff !== true && args.previous_snapshot_generation === undefined && snapshot) args.previous_snapshot_generation = snapshot.generation;
      if (args.disableDiff === true) delete args.previous_snapshot_generation;
      return args;
    }
    if (typeof args.element_index === 'number' && args.snapshot_generation === undefined) {
      if (!snapshot) throw Object.assign(new Error('element_index 没有当前 AX 快照，请重新调用 get_app_state。'), { code: 'ZEUS_COMPUTER_ELEMENT_STALE' });
      args.snapshot_generation = snapshot.generation;
    }
    return args;
  }

  private elementAtPoint(app: string, x: number, y: number): ComputerElementSummary | null {
    const snapshot = this.latestElements.get(app);
    if (!snapshot || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return (
      [...snapshot.elements].reverse().find((element) => {
        const frame = element.frame;
        return (
          frame &&
          typeof frame.x === 'number' &&
          typeof frame.y === 'number' &&
          typeof frame.width === 'number' &&
          typeof frame.height === 'number' &&
          x >= frame.x &&
          y >= frame.y &&
          x <= frame.x + frame.width &&
          y <= frame.y + frame.height
        );
      }) ?? null
    );
  }

  private focusedElement(app: string): ComputerElementSummary | null {
    const snapshot = this.latestElements.get(app);
    return snapshot?.elements.find((element) => element.focused === true) ?? null;
  }

  private async projectResult(result: unknown): Promise<{ textValue: unknown; image: string | null }> {
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
