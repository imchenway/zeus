import { useEffect, useRef, useState } from 'react';
import { userFacingErrorCause, type UserFacingErrorCause } from '@zeus/shared';
import type { AppShellSettings, CodexConfigImportPreview } from '../apiClient.js';
import type { CodexAccountSnapshot } from '../session/sessionTypes.js';
import type { AiRuntimeAdapterStatus } from '../features/runtime/runtimeContracts.js';
import { authenticateCodexWithBrowser, completeCodexSubscriptionSetup, type CodexSubscriptionSetupInput } from '../codexLoginHandoff.js';
import { openExternalHttpsUrlInMain } from '../appShellBridge.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { VisibleApplicationError, modelSetupRequestedEvent } from '../ui/ApplicationErrorDialog.js';
import { ModelConnectionsSettingsPane } from './ModelConnectionsSettingsPane.js';
import { CodexInstallationGuide } from './CodexInstallationGuide.js';
import {
  browserNativeConversationStartStorage,
  readCodexConfigImportPromptPreference,
  toAppShellSettingsSavePayload,
  writeCodexConfigImportPromptPreference,
  type NativeConversationAppClient,
} from '../features/workspace/workspaceSupport.js';

/** 任务接入返回原确认页，结果始终绑定发起时的项目和任务。 */
export interface TaskModelSetupContext {
  /** 发起接入的项目。 */
  projectId: string;
  /** 发起接入的任务。 */
  taskId: string;
  /** 接入期间保持用户正在处理的任务可见。 */
  label: string;
  /** 首次接入取消回到任务；确认页主动接入取消回到原表单。 */
  entry: 'before_confirmation' | 'from_confirmation';
  /** 只在用户取消本次接入时调用，登录完成不调用。 */
  onCancel: () => void;
  /** 只刷新确认页，不创建会话或发送消息。 */
  onComplete: (modelRef: string | null) => Promise<void>;
}

/** 新对话接入绑定原草稿；离开草稿后取消迟到结果。 */
export interface ConversationModelSetupContext {
  /** 仅为发起接入的项目启用模型。 */
  projectId: string;
  /** 草稿卸载或切换项目时失效，不保留待发送请求。 */
  signal: AbortSignal;
  /** 刷新草稿的可选模型，等待用户再次发送。 */
  onComplete: (modelRef: string | null) => Promise<void>;
}

/** 按需接入与常驻设置共用同一流程，关闭只释放当前请求，不切换工作面。 */
export function useModelSetup(input: {
  client: NativeConversationAppClient | null;
  settings: AppShellSettings;
  onSettingsSaved: (settings: AppShellSettings) => void;
  taskContext?: TaskModelSetupContext;
  /** 入口检查确认需要接入时打开对应步骤，普通渲染不触发接入。 */
  requestedTaskStep?: 'choose' | 'custom';
}) {
  /** 接入只由用户操作打开，不在启动时打断工作。 */
  const [step, setStep] = useState<'choose' | 'custom' | 'codex' | 'config' | null>(null);
  /** 接入目标冻结到发起操作，迟到结果不能改变另一项任务。 */
  const targetRef = useRef<TaskModelSetupContext | ConversationModelSetupContext | null>(null);
  /** 异步阶段阻止重复提交，认证等待仍允许取消。 */
  const [operation, setOperation] = useState<'idle' | 'detecting' | 'configuring' | 'inspecting' | 'authenticating' | 'activating' | 'authenticated' | 'importing' | 'saving' | 'checking'>('idle');
  /** 安装状态只来自主动检测，账号状态与程序就绪分别展示。 */
  const [installationCheck, setInstallationCheck] = useState<AiRuntimeAdapterStatus | null>(null);
  /** 官方认证已完成时，只重试模型准备，不要求用户重复登录。 */
  const [modelsPending, setModelsPending] = useState(false);
  /** 普通提示保留原文；失败保留脱敏原因，供统一错误出口展示摘要和详情。 */
  const [error, setError] = useState<string | UserFacingErrorCause | null>(null);
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

  /** 打开时冻结目标，设置入口不继承任务接入的作用范围。 */
  function open(next: 'choose' | 'codex' | 'custom' = 'choose', target: TaskModelSetupContext | ConversationModelSetupContext | null = null): void {
    invalidate();
    targetRef.current = target;
    setOperation('idle');
    setError(null);
    setInstallationCheck(null);
    setModelsPending(false);
    if (next === 'custom') setCustomVisited(true);
    setStep(next);
    if (next === 'codex') void checkInstallation();
  }

  /** 任务按工作面身份校验，新对话按原草稿生命周期校验。 */
  function isTargetCurrent(target: typeof targetRef.current): boolean {
    if (!target) return true;
    if ('signal' in target) return !target.signal.aborted;
    return target.taskId === currentInputRef.current.taskContext?.taskId && target.projectId === currentInputRef.current.taskContext?.projectId;
  }

  useEffect(() => {
    if (isTargetCurrent(targetRef.current)) return;
    invalidate();
    targetRef.current = null;
    setStep(null);
    setCustomVisited(false);
    setOperation('idle');
  }, [input.taskContext?.taskId, input.taskContext?.projectId]);

  useEffect(() => {
    /** 接入期间离开原草稿，立即关闭弹窗并停止等待登录。 */
    const target = targetRef.current;
    if (!target || !('signal' in target)) return;
    /** 不等待下一次渲染才取消，避免旧结果写回新工作面。 */
    const cancel = (): void => {
      if (targetRef.current !== target) return;
      invalidate();
      targetRef.current = null;
      setStep(null);
      setCustomVisited(false);
      setOperation('idle');
    };
    if (target.signal.aborted) cancel();
    else target.signal.addEventListener('abort', cancel, { once: true });
    return () => target.signal.removeEventListener('abort', cancel);
  }, [step]);

  useEffect(() => {
    if (input.taskContext && input.requestedTaskStep) open(input.requestedTaskStep, input.taskContext);
  }, [input.requestedTaskStep, input.taskContext?.taskId, input.taskContext?.projectId]);

  useEffect(() => {
    // 错误弹窗打开原地引导，避免路由切换销毁用户正在编辑的会话草稿。
    const openFromError = (event: Event): void => {
      /** 错误出口只允许选择已有接入步骤。 */
      const requested = (event as CustomEvent).detail;
      if (requested?.conversationContext) open('choose', requested.conversationContext);
      else open(requested === 'codex' ? 'codex' : 'choose', currentInputRef.current.taskContext ?? null);
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
    /** 保存期间只允许当前目标接收完成通知。 */
    const target = targetRef.current;
    const request = ++requestRef.current;
    const isCurrent = (): boolean => requestRef.current === request && isTargetCurrent(target);
    setOperation('saving');
    setError(null);
    try {
      if (target) {
        if (reference) {
          /** 合并当前项目选择；只有缺失或失效的默认模型才被替换。 */
          const [selection, catalog] = await Promise.all([current.client.loadProjectModelSelection(target.projectId), current.client.loadSelectablePiModels()]);
          if (!isCurrent()) return;
          const available = new Set(catalog.filter((model) => model.available).map((model) => model.id));
          if (!available.has(reference)) throw new Error('ZEUS_MODEL_UNAVAILABLE');
          await current.client.saveProjectModelSelection(target.projectId, {
            ...selection,
            allowedModelRefs: [...new Set([...selection.allowedModelRefs, reference])],
            defaultModelRef: selection.defaultModelRef && available.has(selection.defaultModelRef) ? selection.defaultModelRef : reference,
          });
        }
        if (!isCurrent()) return;
        await target.onComplete(reference);
        if (!isCurrent()) return;
        setStep(null);
        setCustomVisited(false);
        targetRef.current = null;
        return;
      }
      /** 持久化成功后才更新界面状态。 */
      const saved = await current.client.settings.saveAppShellSettings({
        ...toAppShellSettingsSavePayload(current.settings),
        modelSetupStatus: skipped ? 'skipped' : 'completed',
        ...(skipped ? {} : { newProjectDefaultModelRef: reference }),
      });
      if (!isCurrent()) return;
      current.onSettingsSaved(saved);
      setStep(null);
      setCustomVisited(false);
    } catch (failure) {
      if (!isCurrent()) return;
      setError(userFacingErrorCause(failure));
      throw failure;
    } finally {
      if (isCurrent()) setOperation('idle');
    }
  }

  /** 关闭只回到原工作面，不写入默认模型或引导状态。 */
  function close(): void {
    if (operation === 'importing' || operation === 'saving' || operation === 'configuring' || editorBusy) return;
    invalidate();
    setOperation('idle');
    setError(null);
    /** 先清除本次目标，再执行该入口对应的返回动作。 */
    const target = targetRef.current;
    targetRef.current = null;
    setStep(null);
    setCustomVisited(false);
    if (target && 'taskId' in target) target.onCancel();
  }

  /** 返回首屏保留供应商编辑器普通字段，编辑器自身负责清除密钥。 */
  function back(): void {
    if (operation === 'importing' || operation === 'saving' || operation === 'configuring' || editorBusy) return;
    invalidate();
    setOperation('idle');
    setPreview(null);
    setError(null);
    setStep('choose');
  }

  /** 读取本次登录真正使用的程序，取消后的检测不再修改界面。 */
  async function readInstallation(request: number): Promise<AiRuntimeAdapterStatus | null> {
    if (!input.client) throw new Error('Model setup client unavailable');
    /** 服务端每次解析最新设置与终端环境，不使用安装前的缓存。 */
    const value = await input.client.checkRuntimeAdapter('codex');
    if (requestRef.current !== request) return null;
    setInstallationCheck(value);
    return value;
  }

  /** 打开订阅页或点击重新检测时只准备程序，不自动打开授权网页。 */
  async function checkInstallation(): Promise<void> {
    /** 新检测替换当前等待，迟到结果不能恢复已关闭的引导。 */
    const request = ++requestRef.current;
    setOperation('detecting');
    setError(null);
    try {
      await readInstallation(request);
    } catch (failure) {
      if (requestRef.current !== request) return;
      setInstallationCheck(null);
      setError(userFacingErrorCause(failure));
    } finally {
      if (requestRef.current === request) setOperation('idle');
    }
  }

  /** 只更新 Codex 程序路径，保留其他适配器和运行设置。 */
  async function saveCodexPath(path: string): Promise<void> {
    if (!input.client || operation !== 'idle' || installationCheck?.installation?.mode === 'remote') return;
    /** 保存期间禁止关闭，避免用户误以为路径没有提交。 */
    const request = ++requestRef.current;
    setOperation('configuring');
    setError(null);
    try {
      /** 保存前读取最新设置，不能覆盖其他入口刚刚修改的配置。 */
      const current = await input.client.settings.loadRuntimeSettings();
      if (requestRef.current !== request) return;
      /** 空值删除显式路径，恢复现有自动发现方式。 */
      const adapterCliPaths = { ...current.adapterCliPaths };
      if (path.trim()) adapterCliPaths.codex = path.trim();
      else delete adapterCliPaths.codex;
      await input.client.settings.saveRuntimeSettings({ ...current, adapterCliPaths });
      if (requestRef.current !== request) return;
      await readInstallation(request);
    } catch (failure) {
      if (requestRef.current !== request) return;
      setInstallationCheck(null);
      setError(userFacingErrorCause(failure));
    } finally {
      if (requestRef.current === request) setOperation('idle');
    }
  }

  /** 首次认证和目录重试共享同一成功回交，始终保留发起任务。 */
  function subscriptionSetup(request: number): CodexSubscriptionSetupInput {
    if (!input.client) throw new Error('Model setup client unavailable');
    return {
      client: input.client,
      isCurrent: () => requestRef.current === request,
      onPreparingModels: () => {
        setModelsPending(true);
        setOperation('activating');
      },
      showSuccess: (value) => {
        setModelsPending(false);
        setAccount(value);
        setAccountChecked(true);
        setOperation('authenticated');
      },
      continueOriginalAction: () => {
        void finish(null).catch(() => undefined);
      },
      recordActivationError: () => console.warn('[Zeus] 登录已成功，窗口自动激活未完成。'),
    };
  }

  /** 认证成功后的模型失败只重试同步，避免重复打开授权页。 */
  async function retrySubscriptionModels(): Promise<void> {
    if (!input.client || operation !== 'idle' || !modelsPending) return;
    /** 继续复用取消与迟到结果隔离。 */
    const request = ++requestRef.current;
    setOperation('detecting');
    setError(null);
    try {
      /** 重试时程序仍可能被移动，先检查当前安装。 */
      const installation = await readInstallation(request);
      if (!installation?.available) {
        if (requestRef.current === request) setOperation('idle');
        return;
      }
      await completeCodexSubscriptionSetup(subscriptionSetup(request));
    } catch (failure) {
      if (requestRef.current !== request) return;
      setOperation('idle');
      setError(userFacingErrorCause(failure));
    }
  }

  /** 所有认证动作先检查程序；缺少时留在安装步骤，不发起登录。 */
  async function login(): Promise<void> {
    if (!input.client) return;
    /** 记录本次操作身份，忽略取消后的迟到回执。 */
    const request = ++requestRef.current;
    setStep('codex');
    setOperation('detecting');
    setError(null);
    setModelsPending(false);
    try {
      /** 登录前再次检测，防止打开引导后程序被移动或删除。 */
      const installation = await readInstallation(request);
      if (!installation?.available) {
        if (requestRef.current === request) setOperation('idle');
        return;
      }
      setOperation('inspecting');
      await authenticateCodexWithBrowser({
        ...subscriptionSetup(request),
        client: input.client,
        onLoginId: (loginId) => {
          loginIdRef.current = loginId;
          if (loginId) setOperation('authenticating');
        },
      });
    } catch (failure) {
      if (requestRef.current !== request) return;
      setOperation('idle');
      setError(userFacingErrorCause(failure));
    }
  }

  /** 安全配置导入单独询问；预览失败不阻塞订阅登录。 */
  async function inspectConfig(): Promise<void> {
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
    try {
      /** 普通配置预览不读取账号、密钥或会话。 */
      const value = await input.client.inspectCodexConfigImport();
      if (requestRef.current !== request) return;
      if (value.available && value.entries.length > 0) {
        setPreview(value);
        setNeedsActivation(false);
        setStep('config');
      } else setError(zh ? '没有可导入的配置，可以直接登录。' : 'No configuration to import. You can sign in directly.');
    } catch (failure) {
      if (requestRef.current === request) setError(userFacingErrorCause(failure));
    } finally {
      if (requestRef.current === request) setOperation('idle');
    }
  }

  /** 跳过仅记录普通偏好；不会复制其他应用账号。 */
  function skipImport(): void {
    writeCodexConfigImportPromptPreference(browserNativeConversationStartStorage(), 'answered');
    setPreview(null);
    setStep('codex');
  }

  /** 用户选择订阅后先检查程序，只有就绪才进入官方授权。 */
  async function prepareCodex(): Promise<void> {
    if (operation === 'idle') await login();
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
      setStep('codex');
      setOperation('idle');
    } catch (failure) {
      if (requestRef.current !== request) return;
      setOperation('idle');
      setError(userFacingErrorCause(failure));
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
      /** 检查状态同样先确认程序，缺少时原地提供安装步骤。 */
      const installation = await readInstallation(request);
      if (!installation?.available) {
        if (requestRef.current === request) {
          setAccount(null);
          setAccountChecked(false);
          setStep('codex');
        }
        return;
      }
      /** 查询真实账号状态，不启动新的登录。 */
      const value = await input.client.loadCodexAccount();
      if (requestRef.current !== request) return;
      setAccount(value);
      setAccountChecked(true);
    } catch (failure) {
      if (requestRef.current !== request) return;
      setAccount(null);
      setAccountChecked(false);
      setError(userFacingErrorCause(failure));
    } finally {
      if (requestRef.current === request) setOperation('idle');
    }
  }

  /** 仅在官方退出成功后清除显示；发生未知结果时要求重新检查。 */
  async function logoutAccount(): Promise<void> {
    if (!input.client || operation !== 'idle') return;
    if (!window.confirm(zh ? '退出 Zeus 的 Codex 订阅账号？之后使用订阅模型需要重新登录。' : 'Sign out of Codex in Zeus? Subscription models will require signing in again.')) return;
    /** 使此前的账号检查回执失效。 */
    const request = ++requestRef.current;
    setOperation('checking');
    setError(null);
    try {
      await input.client.logoutCodexAccount();
      if (requestRef.current !== request) return;
      setAccount(null);
      setAccountChecked(true);
    } catch (failure) {
      if (requestRef.current !== request) return;
      setAccount(null);
      setAccountChecked(false);
      setError(userFacingErrorCause(failure));
    } finally {
      if (requestRef.current === request) setOperation('idle');
    }
  }

  /** 打开已有官方安装指引，不自动下载安装外部工具。 */
  async function openInstallGuide(): Promise<void> {
    /** 打开浏览器后的迟到失败不能污染另一项任务的引导。 */
    const request = requestRef.current;
    try {
      /** 安装指引继续经过既有安全打开入口。 */
      const result = await openExternalHttpsUrlInMain({ zeus: window.zeus, url: 'https://developers.openai.com/codex/cli' });
      if (requestRef.current === request && !result.opened) setError(zh ? '无法打开官方安装指引，请检查系统浏览器。' : 'Could not open the official installation guide. Check your system browser.');
    } catch (failure) {
      if (requestRef.current === request) setError(userFacingErrorCause(failure));
    }
  }

  return {
    input,
    step,
    setStep,
    open,
    taskTarget: targetRef.current && 'taskId' in targetRef.current ? targetRef.current : null,
    conversationTarget: targetRef.current && 'signal' in targetRef.current ? targetRef.current : null,
    operation,
    installationCheck,
    checkInstallation,
    saveCodexPath,
    modelsPending,
    retrySubscriptionModels,
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
    inspectConfig,
    skipImport,
    importConfig,
    checkAccount,
    logoutAccount,
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
        <span className="account-sign-in-state" data-signed-in={signedIn || undefined}>
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
      <p>{zh ? '通过 ChatGPT 账号登录，仅用于 Zeus。第三方模型服务在下方管理。' : 'Sign in with ChatGPT for Zeus. Manage third-party model services below.'}</p>
      <div className="model-setup-actions">
        {signedIn ? (
          <Button variant="secondary" disabled={controller.operation !== 'idle'} onClick={() => void controller.logoutAccount()}>
            {zh ? '退出登录' : 'Sign out'}
          </Button>
        ) : (
          <Button variant="primary" disabled={controller.operation !== 'idle'} onClick={() => controller.open('codex')}>
            {zh ? '登录 Codex' : 'Sign in to Codex'}
          </Button>
        )}
        <Button variant="secondary" disabled={controller.operation !== 'idle'} busy={controller.operation === 'checking'} onClick={() => void controller.checkAccount()}>
          {zh ? '检查状态' : 'Check status'}
        </Button>
      </div>
      {!controller.step && controller.error ? <p role="status">{typeof controller.error === 'string' ? controller.error : <VisibleApplicationError error={controller.error} language={zh ? 'zh-CN' : 'en'} />}</p> : null}
    </section>
  );
}

/** 单一模态面按步骤展示登录和配置，供应商编辑器在返回首屏时保留普通字段。 */
export function ModelSetupDialog({ controller: c }: { controller: ModelSetupController }) {
  /** 沿用当前应用语言。 */
  const zh = c.input.settings.appLanguage === 'zh-CN';
  /** 持久化期间保持当前工作面，避免中途丢失结果。 */
  const locked = c.operation === 'importing' || c.operation === 'saving' || c.operation === 'configuring' || c.editorBusy;
  if (!c.step) return null;
  return (
    <ModalPortal rootClassName="model-setup-portal" dismissDisabled={locked} onDismiss={c.close}>
      <section className="model-setup-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="model-setup-title" aria-describedby="model-setup-description">
        <header className="model-setup-heading">
          <div>
            <strong id="model-setup-title">
              {c.step === 'choose'
                ? zh
                  ? '连接模型'
                  : 'Connect a model'
                : c.step === 'custom'
                  ? zh
                    ? 'API Key 与已有供应商'
                    : 'API key or existing provider'
                  : c.step === 'config'
                    ? zh
                      ? '导入 Codex 配置'
                      : 'Import Codex configuration'
                    : zh
                      ? '使用 Codex 订阅'
                      : 'Use a Codex subscription'}
            </strong>
            <p id="model-setup-description">
              {c.taskTarget
                ? zh
                  ? '接入后进入推送确认，检查设置后再开始。'
                  : 'Continue to push confirmation after setup. Review your settings before starting.'
                : c.conversationTarget
                  ? zh
                    ? '接入后返回新对话，已输入的内容会保留，确认后再发送。'
                    : 'Return to your new conversation after setup. Your draft is preserved for you to review and send.'
                  : zh
                    ? '选择模型接入方式，或使用已有供应商。'
                    : 'Choose how to connect, or select an existing provider.'}
            </p>
            {c.taskTarget ? <small className="model-setup-task-context">{c.taskTarget.label}</small> : null}
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
                <strong>{zh ? 'API Key 与已有供应商' : 'API key or existing provider'}</strong>
                <span>{zh ? '填写服务地址与 API Key，选择模型' : 'Enter a service URL and API key, then choose a model'}</span>
              </Button>
            </div>
          ) : null}
          <div hidden={c.step !== 'custom'}>
            {c.customVisited ? (
              <ModelConnectionsSettingsPane
                language={c.input.settings.appLanguage}
                client={c.input.client}
                active={c.step === 'custom'}
                onBusyChange={c.setEditorBusy}
                completionScope={c.conversationTarget ? 'conversation' : c.taskTarget ? 'project' : 'new_projects'}
                onComplete={(reference) => c.finish(reference)}
              />
            ) : null}
          </div>
          {c.step === 'codex' ? (
            <div className="model-setup-codex">
              <p role="status" aria-live="polite">
                {c.operation === 'detecting'
                  ? zh
                    ? '正在检测 Codex 程序…'
                    : 'Checking the Codex installation…'
                  : c.operation === 'configuring'
                    ? zh
                      ? '正在保存路径并重新检测…'
                      : 'Saving the path and checking again…'
                    : c.operation === 'inspecting'
                      ? zh
                        ? '正在准备登录…'
                        : 'Preparing sign-in…'
                      : c.operation === 'authenticating'
                        ? zh
                          ? '请在官方网页完成登录。完成后返回这里确认设置。'
                          : 'Complete sign-in on the official page, then return here to review your settings.'
                        : c.operation === 'activating'
                          ? zh
                            ? '正在加载订阅模型…'
                            : 'Loading subscription models…'
                          : c.operation === 'authenticated'
                            ? zh
                              ? '登录成功，正在返回 Zeus…'
                              : 'Signed in, returning to Zeus…'
                            : c.modelsPending && c.installationCheck?.available
                              ? zh
                                ? '订阅登录已完成，模型同步尚未完成。可以直接重试同步。'
                                : 'Sign-in completed, but model synchronization is pending. Retry synchronization to continue.'
                              : c.installationCheck && !c.installationCheck.available
                                ? zh
                                  ? '完成程序准备后，即可继续订阅登录。'
                                  : 'Prepare Codex to continue signing in.'
                                : zh
                                  ? '登录将打开系统浏览器中的官方授权页。Zeus 不会复制其他应用的账号、密钥或历史会话。'
                                  : 'Sign-in opens the official authorization page in your system browser. Zeus will not copy accounts, keys, or history from other apps.'}
              </p>
              {c.installationCheck ? (
                <CodexInstallationGuide key={c.installationCheck.checkedAt} zh={zh} status={c.installationCheck} busy={c.operation !== 'idle'} onCheck={c.checkInstallation} onSavePath={c.saveCodexPath} onOpenGuide={c.openInstallGuide} />
              ) : null}
              {c.installationCheck?.available ? (
                <>
                  <Button
                    disabled={c.operation !== 'idle'}
                    busy={c.operation === 'inspecting' || c.operation === 'authenticating' || c.operation === 'activating'}
                    onClick={() => void (c.modelsPending ? c.retrySubscriptionModels() : c.prepareCodex())}
                  >
                    {c.modelsPending ? (zh ? '重试同步模型' : 'Retry model synchronization') : zh ? '登录 Codex 订阅' : 'Sign in with Codex subscription'}
                  </Button>
                  {c.modelsPending ? (
                    <Button variant="secondary" disabled={c.operation !== 'idle'} onClick={() => void c.prepareCodex()}>
                      {zh ? '重新登录' : 'Sign in again'}
                    </Button>
                  ) : null}
                  <Button variant="secondary" disabled={c.operation !== 'idle'} onClick={() => void c.inspectConfig()}>
                    {zh ? '导入已有配置（可选）' : 'Import configuration (optional)'}
                  </Button>
                </>
              ) : !c.installationCheck ? (
                <Button variant="secondary" disabled={c.operation !== 'idle'} busy={c.operation === 'detecting'} onClick={() => void c.checkInstallation()}>
                  {zh ? '重新检测 Codex' : 'Check Codex again'}
                </Button>
              ) : null}
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
              {typeof c.error === 'string' ? c.error : <VisibleApplicationError error={c.error} language={zh ? 'zh-CN' : 'en'} />}
            </p>
          ) : null}
        </div>
        <footer className="model-setup-actions">
          <Button variant="secondary" disabled={locked} onClick={c.step === 'choose' ? c.close : c.back}>
            {c.step === 'choose'
              ? c.taskTarget
                ? c.taskTarget.entry === 'before_confirmation'
                  ? zh
                    ? '返回任务详情'
                    : 'Back to task'
                  : zh
                    ? '返回推送确认'
                    : 'Back to confirmation'
                : zh
                  ? '稍后设置'
                  : 'Set up later'
              : zh
                ? '返回选择'
                : 'Back to choices'}
          </Button>
          <small>{zh ? '可随时在“设置 → 模型供应商”再次接入。' : 'You can reconnect in Settings → Model providers at any time.'}</small>
        </footer>
      </section>
    </ModalPortal>
  );
}
