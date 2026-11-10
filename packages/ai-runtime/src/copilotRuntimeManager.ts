import { CopilotClient, RuntimeConnection, type CopilotSession, type ModelInfo, type ResumeSessionConfig, type SessionConfig, type SessionEvent } from '@github/copilot-sdk';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Electron 的 spawn 不能执行 ASAR 虚拟路径；开发和显式指定程序时沿用 SDK 解析。 */
function packagedCopilotConnection(): RuntimeConnection | undefined {
  /** 从 SDK 所属依赖树解析平台包，避免依赖应用工作目录或 pnpm 的提升布局。 */
  const sdkEntry = createRequire(import.meta.url).resolve('@github/copilot-sdk');
  if (!/\.asar[\\/]/u.test(sdkEntry) || process.env.COPILOT_CLI_PATH) return undefined;
  /** macOS 和 Windows 安装包使用与当前进程架构一致的原生程序。 */
  const platform = `${process.platform}-${process.arch}`;
  /** 整个平台包已经解包，程序及相邻原生库必须使用同一个物理目录。 */
  const runtimeDirectory = dirname(createRequire(sdkEntry).resolve(`@github/copilot-sdk-${platform}/package.json`)).replace(/\.asar(?=[\\/])/u, '.asar.unpacked');
  return RuntimeConnection.forStdio({ path: join(runtimeDirectory, 'prebuilds', platform, process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime') });
}

/** 模型目录字段由 GitHub 官方 SDK 定义，Core 不维护静态模型副本。 */
export type CopilotModelInfo = ModelInfo;

/** Copilot 的账户状态只来自当前 SDK 进程，不以 Codex 账户或环境变量推断。 */
export interface CopilotAccountStatus {
  authenticated: boolean;
  login: string | null;
  host: string | null;
  authType: string | null;
  checkedAt: string;
}

/** 服务端明确返回的 Copilot 额度观察；缺少数量表示未知。 */
export interface CopilotQuotaSnapshot {
  quotaId: string;
  service: string | null;
  observationKind: string | null;
  acquisitionStatus: string | null;
  accessState: string;
  quantityKind: string | null;
  unit: string;
  availableQuantity: number | null;
  entitledQuantity: number | null;
  observedAt: string | null;
}

/** 交互登录的一步；flowId 仅由 Core 保存，浏览器只收到可展示的授权信息。 */
export interface CopilotLoginStep {
  kind: 'open-url' | 'device-code' | 'awaiting' | 'needs-interaction' | 'input-required' | 'completed' | 'error';
  url?: string;
  verificationUri?: string;
  userCode?: string;
  expiresIn?: number;
  prompt?: string;
  status?: string;
  message?: string;
}

/** 以 Zeus 专属数据根托管 Copilot CLI，并复用 SDK 的原生会话和认证。 */
export class CopilotRuntimeManager {
  private client: CopilotClient | null = null;
  private starting: Promise<CopilotClient> | null = null;
  private readonly logins = new Map<string, string>();
  private readonly loginSteps = new Map<string, CopilotLoginStep>();
  private readonly advancingLogins = new Set<string>();
  private loginSession: CopilotSession | null = null;
  private startingLoginSession: Promise<CopilotSession> | null = null;
  private status: CopilotAccountStatus | null = null;
  private models: ModelInfo[] = [];
  /** 账户快照与请求前准入观察分开保存，禁止推算发送后的余额。 */
  private readonly quotas = new Map<string, CopilotQuotaSnapshot>();

  /** 运行时只在显式登录、模型刷新或派发时启动，状态读取不产生进程。 */
  constructor(
    private readonly baseDirectory: string,
    private readonly workingDirectory: string,
  ) {}

  /** 读取最近一次账户证据；null 表示尚未启动或尚未查询。 */
  readAccount(): CopilotAccountStatus | null {
    return this.status ? { ...this.status } : null;
  }

  /** 读取最近一次模型目录；返回副本以免调用方修改 SDK 缓存。 */
  readModels(): ModelInfo[] {
    return this.models.map((model) => ({ ...model, capabilities: { ...model.capabilities, supports: { ...model.capabilities.supports }, limits: { ...model.capabilities.limits } } }));
  }

  /** 读取 SDK 最近明确给出的额度事实，不从 Token 用量反推订阅余额。 */
  readQuotas(): CopilotQuotaSnapshot[] {
    return [...this.quotas.values()].map((quota) => ({ ...quota }));
  }

  /** 临时额度事件按来源和观察类型保留最近一份。 */
  observeQuota(event: Extract<SessionEvent, { type: 'session.quota_observation' }>): void {
    const state = event.data.observation;
    const key = JSON.stringify([state.provider, state.service ?? null, state.quotaId, state.observationKind ?? null]);
    this.quotas.set(key, {
      quotaId: state.quotaId,
      service: state.service ?? null,
      observationKind: state.observationKind ?? null,
      acquisitionStatus: state.acquisitionStatus ?? null,
      accessState: state.accessState,
      quantityKind: state.quantityKind ?? null,
      unit: state.unit,
      availableQuantity: state.availableQuantity ?? null,
      entitledQuantity: state.entitledQuantity ?? null,
      observedAt: state.observedAt ?? event.timestamp,
    });
  }

  /** 启动同一个 SDK 进程；并发调用共用启动结果，失败后允许显式再试。 */
  async ensureReady(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    const client = new CopilotClient({ connection: packagedCopilotConnection(), baseDirectory: this.baseDirectory, workingDirectory: this.workingDirectory, mode: 'empty', logLevel: 'warning' });
    const starting = client
      .start()
      .then(() => {
        this.client = client;
        return client;
      })
      .catch(async (error: unknown) => {
        await client.forceStop().catch(() => undefined);
        throw error;
      })
      .finally(() => {
        if (this.starting === starting) this.starting = null;
      });
    this.starting = starting;
    return starting;
  }

  /** SDK 返回的已登录身份是模型目录和派发的前提。 */
  async refreshAccount(): Promise<CopilotAccountStatus> {
    const auth = await (await this.ensureReady()).getAuthStatus();
    this.status = {
      authenticated: auth.isAuthenticated,
      login: auth.login ?? null,
      host: auth.host ?? null,
      authType: auth.authType ?? null,
      checkedAt: new Date().toISOString(),
    };
    if (!auth.isAuthenticated) {
      this.models = [];
      this.quotas.clear();
    }
    return { ...this.status };
  }

  /** 模型只取 SDK 当前账号的官方目录，不维护会漂移的静态模型表。 */
  async refreshModels(): Promise<ModelInfo[]> {
    const client = await this.ensureReady();
    const auth = await this.refreshAccount();
    if (!auth.authenticated) {
      this.models = [];
      return [];
    }
    this.models = await client.listModels();
    return this.readModels();
  }

  /** 开始 GitHub 官方 device-code 登录，并以不透明标识保存 SDK flow。 */
  async beginLogin(): Promise<{ loginId: string; step: CopilotLoginStep }> {
    const started = await (await this.ensureLoginSession()).rpc.accounts.login.begin({ kind: 'githubDotCom', method: 'device-code' });
    const loginId = randomUUID();
    this.logins.set(loginId, started.flowId);
    const step = this.projectLoginStep(started.step);
    this.loginSteps.set(loginId, step);
    return { loginId, step };
  }

  /** 页面轮询只读本次授权状态，不重复提交 SDK 登录命令。 */
  readLoginStep(loginId: string): CopilotLoginStep | null {
    return this.loginSteps.get(loginId) ?? null;
  }

  /** 一次登录推进在后台执行；重复点击只读取同一结果。 */
  startLoginAdvance(loginId: string, input?: string): CopilotLoginStep {
    const step = this.loginSteps.get(loginId);
    if (!step || !this.logins.has(loginId)) throw new Error('Copilot 登录已结束或不存在。');
    if (this.advancingLogins.has(loginId)) return { kind: 'awaiting' };
    this.advancingLogins.add(loginId);
    this.loginSteps.set(loginId, { kind: 'awaiting' });
    void this.advanceLogin(loginId, input)
      .catch((error: unknown) => {
        if (this.logins.has(loginId)) {
          this.logins.delete(loginId);
          this.loginSteps.set(loginId, { kind: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      })
      .finally(() => this.advancingLogins.delete(loginId));
    return { kind: 'awaiting' };
  }

  /** 前进当前登录；一次 device-code advance 会等待用户完成授权，不能并发重放。 */
  async advanceLogin(loginId: string, input?: string): Promise<CopilotLoginStep> {
    const flowId = this.logins.get(loginId);
    if (!flowId) throw new Error('Copilot 登录已结束或不存在。');
    const step = await (await this.ensureLoginSession()).rpc.accounts.login.advance({ flowId, ...(input === undefined ? {} : { input }) });
    if (step.kind === 'completed' && (step.result.status === 'completed' || step.result.status === 'declined')) {
      this.logins.delete(loginId);
      await this.refreshAccount();
      this.models = [];
    }
    if (step.kind === 'error') this.logins.delete(loginId);
    const projected = this.projectLoginStep(step);
    if (this.logins.has(loginId) || projected.kind === 'completed') this.loginSteps.set(loginId, projected);
    return projected;
  }

  /** 取消当前登录，并让 SDK 释放授权轮询。 */
  async cancelLogin(loginId: string): Promise<void> {
    const flowId = this.logins.get(loginId);
    if (!flowId) return;
    this.logins.delete(loginId);
    this.loginSteps.delete(loginId);
    await (await this.ensureLoginSession()).rpc.accounts.login.cancel({ flowId });
  }

  /** 登出当前账号；运行中的会话应由上层先停止或完成交接。 */
  async logout(): Promise<CopilotAccountStatus> {
    await (await this.ensureLoginSession()).rpc.accounts.set({ command: { kind: 'logout' } });
    this.models = [];
    this.quotas.clear();
    return this.refreshAccount();
  }

  /** 会话配置由 Core 提供工具、权限和工作目录，管理器不扩大授权。 */
  async createSession(config: SessionConfig): Promise<CopilotSession> {
    return (await this.ensureReady()).createSession(config);
  }

  /** 恢复原生会话时重新提供工具及权限配置，不以默认 CLI 权限接管。 */
  async resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession> {
    return (await this.ensureReady()).resumeSession(sessionId, { ...config, continuePendingWork: false });
  }

  /** 宿主关闭时停止授权 flow 和 SDK 进程；持久会话由 SDK 留在专属数据根。 */
  async close(): Promise<void> {
    /** 并发启动必须先落定，避免关闭后迟到的启动把已释放进程重新登记为活动。 */
    await this.starting?.catch(() => null);
    await this.startingLoginSession?.catch(() => null);
    const client = this.client;
    const loginSession = this.loginSession;
    this.client = null;
    this.loginSession = null;
    this.startingLoginSession = null;
    this.status = null;
    this.models = [];
    this.quotas.clear();
    this.logins.clear();
    this.loginSteps.clear();
    this.advancingLogins.clear();
    if (loginSession) {
      await loginSession.disconnect();
      await client?.deleteSession(loginSession.sessionId);
    }
    if (client) await client.stop();
  }

  /** SDK 的交互账号 RPC 属于 session，使用无工具的专用会话承载登录。 */
  private async ensureLoginSession(): Promise<CopilotSession> {
    if (this.loginSession) return this.loginSession;
    if (this.startingLoginSession) return this.startingLoginSession;
    const starting = this.ensureReady()
      .then((client) =>
        client.createSession({
          sessionId: `zeus-copilot-login-${randomUUID()}`,
          workingDirectory: this.workingDirectory,
          availableTools: [],
        }),
      )
      .then((session) => {
        this.loginSession = session;
        return session;
      })
      .finally(() => {
        if (this.startingLoginSession === starting) this.startingLoginSession = null;
      });
    this.startingLoginSession = starting;
    return starting;
  }

  /** 将 SDK 登录变体裁剪为前端可显示字段，避免传出账号或凭据对象。 */
  private projectLoginStep(step: Awaited<ReturnType<CopilotSession['rpc']['accounts']['login']['advance']>>): CopilotLoginStep {
    switch (step.kind) {
      case 'open-url':
        return { kind: step.kind, url: step.url };
      case 'device-code':
        return { kind: step.kind, userCode: step.userCode, verificationUri: step.verificationUri, expiresIn: step.expiresIn };
      case 'input-required':
        return { kind: step.kind, prompt: step.prompt };
      case 'completed':
        return { kind: step.kind, status: step.result.status };
      case 'error':
        return { kind: step.kind, message: step.message };
      default:
        return { kind: step.kind };
    }
  }
}
