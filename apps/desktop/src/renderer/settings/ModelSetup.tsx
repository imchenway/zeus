import { useEffect, useRef, useState } from 'react';
import type { AppShellSettings, CodexConfigImportPreview } from '../apiClient.js';
import type { CodexAccountSnapshot } from '../session/sessionTypes.js';
import { authenticateCodexWithBrowser } from '../codexLoginHandoff.js';
import { openExternalHttpsUrlInMain } from '../appShellBridge.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { formatVisibleApplicationError, modelSetupRequestedEvent } from '../ui/ApplicationErrorDialog.js';
import { ModelConnectionsSettingsPane } from './ModelConnectionsSettingsPane.js';
import {
  browserNativeConversationStartStorage,
  readCodexConfigImportPromptPreference,
  toAppShellSettingsSavePayload,
  writeCodexConfigImportPromptPreference,
  type NativeConversationAppClient,
} from '../features/workspace/workspaceSupport.js';

/** 首次接入与常驻设置共用同一流程，关闭只释放当前请求，不切换工作面。 */
export function useModelSetup(input: { client: NativeConversationAppClient | null; settings: AppShellSettings; onSettingsSaved: (settings: AppShellSettings) => void }) {
  /** 步骤状态属于当前窗口；是否再次自动显示由已持久化状态决定。 */
  const [step, setStep] = useState<'choose' | 'custom' | 'codex' | 'config' | null>(() => (input.settings.modelSetupStatus === 'pending' ? 'choose' : null));
  /** 异步阶段阻止重复提交，认证等待仍允许取消。 */
  const [operation, setOperation] = useState<'idle' | 'inspecting' | 'authenticating' | 'authenticated' | 'importing' | 'saving' | 'checking'>('idle');
  /** 当前步骤只展示脱敏后的可恢复错误。 */
  const [error, setError] = useState<string | null>(null);
  /** 账号事实来自现有认证接口，不由引导完成状态推断。 */
  const [account, setAccount] = useState<CodexAccountSnapshot | null>(null);
  /** 区分未查询与已确认未登录。 */
  const [accountChecked, setAccountChecked] = useState(false);
  /** 仅保存可跳过的普通配置导入预览。 */
  const [preview, setPreview] = useState<CodexConfigImportPreview | null>(null);
  /** 导入后启用失败只重试启用。 */
  const [needsActivation, setNeedsActivation] = useState(false);
  /** 保留已访问的普通配置编辑器，关闭后释放。 */
  const [customVisited, setCustomVisited] = useState(false);
  /** 供应商正在保存时暂停关闭和返回。 */
  const [editorBusy, setEditorBusy] = useState(false);
  /** 请求代次使取消、卸载和新操作后的旧回执失效。 */
  const requestRef = useRef(0);
  /** 当前官方登录身份只保存在内存中。 */
  const loginIdRef = useRef<string | null>(null);
  /** 异步完成时使用最新设置和客户端。 */
  const currentInputRef = useRef(input);
  currentInputRef.current = input;
  /** 沿用当前应用语言。 */
  const zh = input.settings.appLanguage === 'zh-CN';

  /** 取消已经取得身份的官方登录；尚未返回的身份由共享登录流程负责清理。 */
  function invalidate(): void {
    requestRef.current += 1;
    /** 提取当前等待身份用于取消清理。 */
    const loginId = loginIdRef.current;
    loginIdRef.current = null;
    if (loginId && input.client) void input.client.cancelCodexChatGptLogin(loginId).catch(() => undefined);
  }

  useEffect(() => {
    // 错误弹窗打开原地引导，避免路由切换销毁用户正在编辑的会话草稿。
    const openFromError = (event: Event): void => {
      /** 错误出口只允许选择已有接入步骤。 */
      const requested = (event as CustomEvent).detail;
      setStep(requested === 'codex' ? 'codex' : 'choose');
      setError(null);
    };
    window.addEventListener(modelSetupRequestedEvent, openFromError);
    return () => {
      window.removeEventListener(modelSetupRequestedEvent, openFromError);
      requestRef.current += 1;
      /** 提取当前等待身份用于取消清理。 */
      const loginId = loginIdRef.current;
      if (loginId) void currentInputRef.current.client?.cancelCodexChatGptLogin(loginId).catch(() => undefined);
    };
  }, []);

  /** 保存接入结果后才离开；引导状态不能替代账号或模型的运行事实。 */
  async function finish(reference: string | null, skipped = false): Promise<void> {
    /** 保存时读取最新普通设置，避免恢复旧快照。 */
    const current = currentInputRef.current;
    if (!current.client) throw new Error('Model setup client unavailable');
    setOperation('saving');
    setError(null);
    try {
      /** 持久化成功后才更新界面状态。 */
      const saved = await current.client.settings.saveAppShellSettings({
        ...toAppShellSettingsSavePayload(current.settings),
        modelSetupStatus: skipped ? 'skipped' : 'completed',
        ...(skipped ? {} : { newProjectDefaultModelRef: reference }),
      });
      current.onSettingsSaved(saved);
      setStep(null);
      setCustomVisited(false);
    } catch (failure) {
      setError(formatVisibleApplicationError(failure, zh ? 'zh-CN' : 'en'));
      throw failure;
    } finally {
      setOperation('idle');
    }
  }

  /** 关闭接入引导时保留已完成用户的状态，首次用户则记为稍后设置。 */
  function close(): void {
    if (operation === 'importing' || operation === 'saving' || editorBusy) return;
    invalidate();
    setOperation('idle');
    setError(null);
    if (input.settings.modelSetupStatus === 'pending') void finish(null, true).catch(() => undefined);
    else {
      setStep(null);
      setCustomVisited(false);
    }
  }

  /** 返回首屏保留供应商编辑器普通字段，编辑器自身负责清除密钥。 */
  function back(): void {
    if (operation === 'importing' || operation === 'saving' || editorBusy) return;
    invalidate();
    setOperation('idle');
    setPreview(null);
    setError(null);
    setStep('choose');
  }

  /** 所有认证动作都由显式点击触发，使用现有官方登录接口。 */
  async function login(): Promise<void> {
    if (!input.client) return;
    /** 记录本次操作身份，忽略取消后的迟到回执。 */
    const request = ++requestRef.current;
    setStep('codex');
    setOperation('authenticating');
    setError(null);
    try {
      await authenticateCodexWithBrowser({
        client: input.client,
        isCurrent: () => requestRef.current === request,
        onLoginId: (loginId) => {
          loginIdRef.current = loginId;
        },
        showSuccess: (value) => {
          setAccount(value);
          setAccountChecked(true);
          setOperation('authenticated');
        },
        continueOriginalAction: () => {
          void finish(null).catch(() => undefined);
        },
        recordActivationError: () => console.warn('[Zeus] 登录已成功，窗口自动激活未完成。'),
      });
    } catch (failure) {
      if (requestRef.current !== request) return;
      setOperation('idle');
      setError(modelSetupLoginError(failure, zh));
    }
  }

  /** 安全配置导入单独询问；预览失败不阻塞订阅登录。 */
  async function prepareCodex(): Promise<void> {
    if (!input.client || operation !== 'idle') return;
    /** 记录本次操作身份，忽略取消后的迟到回执。 */
    const request = ++requestRef.current;
    setStep('codex');
    setOperation('inspecting');
    setError(null);
    /** 复用任务推送已有的配置导入偏好。 */
    const preference = readCodexConfigImportPromptPreference(browserNativeConversationStartStorage());
    if (preference === 'activation-required') {
      setNeedsActivation(true);
      setStep('config');
      setOperation('idle');
      return;
    }
    if (preference !== 'answered') {
      try {
        /** 用户选择 Codex 后才读取普通配置预览。 */
        const value = await input.client.inspectCodexConfigImport();
        if (requestRef.current !== request) return;
        if (value.available && value.entries.length > 0) {
          setPreview(value);
          setNeedsActivation(false);
          setStep('config');
          setOperation('idle');
          return;
        }
      } catch {
        if (requestRef.current !== request) return;
      }
    }
    if (requestRef.current === request) await login();
  }

  /** 跳过仅记录普通偏好；不会复制其他应用账号。 */
  function skipImport(): void {
    writeCodexConfigImportPromptPreference(browserNativeConversationStartStorage(), 'answered');
    setPreview(null);
    void login();
  }

  /** 配置已经导入但尚未启用时，只重试启用，不重复复制文件。 */
  async function importConfig(): Promise<void> {
    if (!input.client || operation !== 'idle') return;
    /** 记录本次操作身份，忽略取消后的迟到回执。 */
    const request = ++requestRef.current;
    setOperation('importing');
    setError(null);
    try {
      if (needsActivation) await input.client.activateCodexConfig();
      else {
        /** 导入结果决定是否需要单独重试启用。 */
        const result = await input.client.importCodexConfig();
        if (result.imported.length > 0 && !result.runtimeReloaded) {
          writeCodexConfigImportPromptPreference(browserNativeConversationStartStorage(), 'activation-required');
          setNeedsActivation(true);
          throw new Error('ZEUS_CODEX_CONFIG_ACTIVATION_REQUIRED');
        }
      }
      if (requestRef.current !== request) return;
      writeCodexConfigImportPromptPreference(browserNativeConversationStartStorage(), 'answered');
      setNeedsActivation(false);
      setPreview(null);
      await login();
    } catch (failure) {
      if (requestRef.current !== request) return;
      setOperation('idle');
      setError(modelSetupLoginError(failure, zh));
    }
  }

  /** 只查询现有账号状态；未连接时展示未检查，不能宣称已经退出登录。 */
  async function checkAccount(): Promise<void> {
    if (!input.client || operation !== 'idle') return;
    /** 记录本次操作身份，忽略取消后的迟到回执。 */
    const request = ++requestRef.current;
    setOperation('checking');
    setError(null);
    try {
      /** 查询真实账号状态，不启动新的登录。 */
      const value = await input.client.loadCodexAccount();
      if (requestRef.current !== request) return;
      setAccount(value);
      setAccountChecked(true);
    } catch {
      if (requestRef.current !== request) return;
      setAccount(null);
      setAccountChecked(false);
      setError(zh ? '当前 Codex 服务尚未连接，无法确认账号状态。可以点击订阅登录。' : 'Codex is not connected, so account status cannot be confirmed. You can sign in with your subscription.');
    } finally {
      if (requestRef.current === request) setOperation('idle');
    }
  }

  /** 打开已有官方安装指引，不自动下载安装外部工具。 */
  async function openInstallGuide(): Promise<void> {
    /** 安装指引继续经过既有安全打开入口。 */
    const result = await openExternalHttpsUrlInMain({ zeus: window.zeus, url: 'https://developers.openai.com/codex/cli' });
    if (!result.opened) setError(zh ? '无法打开官方安装指引，请检查系统浏览器。' : 'Could not open the official installation guide. Check your system browser.');
  }

  return {
    input,
    step,
    setStep,
    operation,
    error,
    account,
    accountChecked,
    preview,
    needsActivation,
    customVisited,
    setCustomVisited,
    editorBusy,
    setEditorBusy,
    finish,
    close,
    back,
    prepareCodex,
    skipImport,
    importConfig,
    checkAccount,
    openInstallGuide,
  };
}

/** 首次引导和设置面共用的窗口内控制状态。 */
type ModelSetupController = ReturnType<typeof useModelSetup>;

/** 模型供应商设置顶部的常驻订阅入口，状态来自实际账号查询。 */
export function CodexAccountSettings({ controller }: { controller: ModelSetupController }) {
  /** 沿用当前应用语言。 */
  const zh = controller.input.settings.appLanguage === 'zh-CN';
  /** 显示最近一次真实账号查询结果。 */
  const account = controller.account;
  /** 只有 ChatGPT 账号认证成功才表示订阅已登录。 */
  const signedIn = account?.signedIn && account.accountType === 'chatgpt';
  return (
    <section className="settings-product-section model-setup-account" aria-label={zh ? 'Codex 订阅' : 'Codex subscription'}>
      <header className="settings-section-heading">
        <strong>Codex {zh ? '订阅' : 'subscription'}</strong>
        <span>
          {signedIn
            ? zh
              ? `已登录${account.planType ? ` · ${account.planType}` : ''}`
              : `Signed in${account.planType ? ` · ${account.planType}` : ''}`
            : controller.accountChecked
              ? zh
                ? '未登录订阅账号'
                : 'Subscription account is not signed in'
              : zh
                ? '账号状态尚未检查'
                : 'Account status not checked'}
        </span>
      </header>
      <p>{zh ? '使用 ChatGPT 账号授权 Codex。Zeus 的登录独立于其他应用；也可以在下方配置自定义供应商。' : 'Authorize Codex with your ChatGPT account. Zeus signs in independently; custom providers can also be configured below.'}</p>
      <div className="model-setup-actions">
        <Button onClick={() => controller.setStep('codex')}>{zh ? '使用 Codex 订阅登录' : 'Sign in with Codex subscription'}</Button>
        <Button variant="secondary" disabled={controller.operation !== 'idle'} busy={controller.operation === 'checking'} onClick={() => void controller.checkAccount()}>
          {zh ? '检查状态' : 'Check status'}
        </Button>
        <Button variant="secondary" onClick={() => controller.setStep('choose')}>
          {zh ? '重新选择接入方式' : 'Choose connection method'}
        </Button>
      </div>
      {!controller.step && controller.error ? <p role="status">{controller.error}</p> : null}
    </section>
  );
}

/** 单一模态面按步骤展示登录和配置，供应商编辑器在返回首屏时保留普通字段。 */
export function ModelSetupDialog({ controller: c }: { controller: ModelSetupController }) {
  /** 沿用当前应用语言。 */
  const zh = c.input.settings.appLanguage === 'zh-CN';
  /** 持久化期间保持当前工作面，避免中途丢失结果。 */
  const locked = c.operation === 'importing' || c.operation === 'saving' || c.editorBusy;
  if (!c.step) return null;
  return (
    <ModalPortal rootClassName="model-setup-portal" dismissDisabled={locked} onDismiss={c.close}>
      <section className="model-setup-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="model-setup-title" aria-describedby="model-setup-description">
        <header className="model-setup-heading">
          <div>
            <strong id="model-setup-title">
              {c.step === 'choose'
                ? zh
                  ? '欢迎使用 Zeus'
                  : 'Welcome to Zeus'
                : c.step === 'custom'
                  ? zh
                    ? '连接自定义供应商'
                    : 'Connect a custom provider'
                  : c.step === 'config'
                    ? zh
                      ? '导入 Codex 配置'
                      : 'Import Codex configuration'
                    : zh
                      ? '使用 Codex 订阅'
                      : 'Use a Codex subscription'}
            </strong>
            <p id="model-setup-description">{zh ? '选择模型接入方式。完成后即可为新项目使用模型，也可以稍后设置。' : 'Choose how to connect a model for new projects. You can also set this up later.'}</p>
          </div>
          <Button variant="secondary" aria-label={zh ? '关闭接入引导' : 'Close model setup'} disabled={locked} onClick={c.close}>
            ×
          </Button>
        </header>
        <div className="model-setup-body">
          {c.step === 'choose' ? (
            <div className="model-setup-options">
              <Button variant="secondary" onClick={() => void c.prepareCodex()} disabled={c.operation !== 'idle'}>
                <strong>{zh ? '使用 Codex 订阅' : 'Use Codex subscription'}</strong>
                <span>{zh ? '通过官方网页登录 ChatGPT 账号' : 'Sign in to ChatGPT on the official website'}</span>
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  c.setCustomVisited(true);
                  c.setStep('custom');
                }}
              >
                <strong>{zh ? '连接自定义供应商' : 'Connect a custom provider'}</strong>
                <span>{zh ? '填写服务地址与 API Key，选择模型' : 'Enter a service URL and API key, then choose a model'}</span>
              </Button>
            </div>
          ) : null}
          <div hidden={c.step !== 'custom'}>
            {c.customVisited ? (
              <ModelConnectionsSettingsPane language={c.input.settings.appLanguage} client={c.input.client} active={c.step === 'custom'} onBusyChange={c.setEditorBusy} onComplete={(reference) => c.finish(reference)} />
            ) : null}
          </div>
          {c.step === 'codex' ? (
            <div className="model-setup-codex" role="status" aria-live="polite">
              <p>
                {c.operation === 'inspecting'
                  ? zh
                    ? '正在准备登录…'
                    : 'Preparing sign-in…'
                  : c.operation === 'authenticating'
                    ? zh
                      ? '请在官方网页完成登录，Zeus 会自动返回并继续，无需点击网页中的其他产品按钮。'
                      : 'Complete sign-in on the official page. Zeus will return automatically; no other product buttons are needed.'
                    : c.operation === 'authenticated'
                      ? zh
                        ? '登录成功，正在返回 Zeus…'
                        : 'Signed in, returning to Zeus…'
                      : zh
                        ? '登录将打开系统浏览器中的官方授权页。Zeus 不会复制其他应用的账号、密钥或历史会话。'
                        : 'Sign-in opens the official authorization page in your system browser. Zeus will not copy accounts, keys, or history from other apps.'}
              </p>
              <Button disabled={c.operation !== 'idle'} busy={c.operation === 'inspecting' || c.operation === 'authenticating'} onClick={() => void c.prepareCodex()}>
                {zh ? '登录 Codex 订阅' : 'Sign in with Codex subscription'}
              </Button>
              <Button variant="secondary" disabled={locked} onClick={() => void c.openInstallGuide()}>
                {zh ? '查看官方安装指引' : 'Official installation guide'}
              </Button>
            </div>
          ) : null}
          {c.step === 'config' ? (
            <div className="model-setup-import">
              <p>
                {c.needsActivation
                  ? zh
                    ? '配置已导入，需启用后继续；重试不会重复导入。'
                    : 'Configuration was imported; activate it to continue without importing again.'
                  : zh
                    ? '可导入普通偏好、指令、规则、技能及工具配置；不会导入账号、密钥或历史会话。'
                    : 'Import preferences, instructions, rules, skills and tool configuration. Accounts, keys and history are excluded.'}
              </p>
              <ul>
                {c.preview?.entries.map((entry) => (
                  <li key={entry.path}>
                    {entry.path} · {entry.nodeCount}
                  </li>
                ))}
              </ul>
              <div className="model-setup-actions">
                <Button disabled={c.operation !== 'idle'} busy={c.operation === 'importing'} onClick={() => void c.importConfig()}>
                  {c.needsActivation ? (zh ? '重试启用' : 'Retry activation') : zh ? '导入并继续' : 'Import and continue'}
                </Button>
                {!c.needsActivation ? (
                  <Button variant="secondary" disabled={locked} onClick={c.skipImport}>
                    {zh ? '暂不导入' : 'Skip import'}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {c.error ? (
            <p className="model-setup-error" role="alert">
              {c.error}
            </p>
          ) : null}
        </div>
        <footer className="model-setup-actions">
          <Button variant="secondary" disabled={locked} onClick={c.step === 'choose' ? c.close : c.back}>
            {c.step === 'choose' ? (zh ? '稍后设置' : 'Set up later') : zh ? '返回选择' : 'Back to choices'}
          </Button>
          <small>{zh ? '可随时在“设置 → 模型供应商”再次接入。' : 'You can reconnect in Settings → Model providers at any time.'}</small>
        </footer>
      </section>
    </ModalPortal>
  );
}

/** 认证失败使用明确且不包含密钥或授权地址的提示。 */
function modelSetupLoginError(error: unknown, zh: boolean): string {
  if (error instanceof Error && error.message === 'ZEUS_CODEX_LOGIN_TIMED_OUT') return zh ? '登录等待超时，配置已保留。请重新登录。' : 'Sign-in timed out. Your configuration is preserved; try again.';
  if (error instanceof Error && error.message === 'ZEUS_CODEX_LOGIN_BROWSER_OPEN_FAILED') return zh ? '无法打开官方登录页，请检查系统浏览器后重试。' : 'Could not open the official sign-in page. Check your system browser and retry.';
  if (error instanceof Error && error.message === 'ZEUS_CODEX_CONFIG_ACTIVATION_REQUIRED') return zh ? '配置已导入，但尚未启用。请重试启用。' : 'Configuration was imported but is not active. Retry activation.';
  return formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en');
}
