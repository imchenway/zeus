import { useEffect, useRef, useState } from 'react';
import { userFacingErrorCause, type UserFacingErrorCause } from '@zeus/shared';
import type { AppShellSettings, CodexConfigImportPreview } from '../apiClient.js';
import type { CodexAccountSnapshot, CodexTaskPushModelCapability } from '../session/sessionTypes.js';
import type { AiRuntimeAdapterStatus, CodexRuntimeUpdateStatus } from '../features/runtime/runtimeContracts.js';
import { codexCapabilitiesChangedEvent, codexRuntimeUpdateCheckedEvent, codexRuntimeUpdateProgressEvent, isCodexRuntimeUpdateStage, type CodexRuntimeUpdateProgress } from '../features/codex/codexApiClient.js';
import { authenticateCodexWithBrowser, completeCodexSubscriptionSetup, type CodexSubscriptionSetupInput } from '../codexLoginHandoff.js';
import { openExternalHttpsUrlInMain } from '../appShellBridge.js';
import { modelSetupRequestedEvent } from '../ui/ApplicationErrorDialog.js';
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

/** 只展示当前原生 Codex 目录确认可运行的模型，第三方供应商留在独立区域。 */
function availableCodexModels(models: CodexTaskPushModelCapability[]): CodexTaskPushModelCapability[] {
  return models.filter((model) => (model.agentKind ?? 'codex') === 'codex' && (model.sourceId ?? 'codex') === 'codex' && model.available !== false);
}

/** 按需接入与常驻设置共用同一流程，关闭只释放当前请求，不切换工作面。 */
export function useModelSetup(input: {
  client: NativeConversationAppClient | null;
  settings: AppShellSettings;
  onSettingsSaved: (settings: AppShellSettings) => void;
  taskContext?: TaskModelSetupContext;
  /** 入口检查确认需要接入时打开对应步骤，普通渲染不触发接入。 */
  requestedTaskStep?: 'choose' | 'custom';
  /** 模型供应商页可见时自动恢复账号、程序和模型状态。 */
  settingsActive?: boolean;
}) {
  /** 接入只由用户操作打开，不在启动时打断工作。 */
  const [step, setStep] = useState<'choose' | 'custom' | 'codex' | 'config' | null>(null);
  /** 接入目标冻结到发起操作，迟到结果不能改变另一项任务。 */
  const targetRef = useRef<TaskModelSetupContext | ConversationModelSetupContext | null>(null);
  /** 异步阶段阻止重复提交，认证等待仍允许取消。 */
  const [operation, setOperation] = useState<'idle' | 'detecting' | 'configuring' | 'inspecting' | 'authenticating' | 'activating' | 'authenticated' | 'importing' | 'saving' | 'checking' | 'checking_update' | 'updating'>('idle');
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
  /** 当前账号实际可运行的 Codex 模型，不混入第三方供应商。 */
  const [models, setModels] = useState<CodexTaskPushModelCapability[]>([]);
  /** 区分目录尚未读取与真实空目录。 */
  const [modelsChecked, setModelsChecked] = useState(false);
  /** 保存最近一次手动检测或更新后的官方版本比较。 */
  const [updateCheck, setUpdateCheck] = useState<CodexRuntimeUpdateStatus | null>(null);
  /** 百分比只跟随服务端确认的真实下载字节，不按时间伪造推进。 */
  const [updateProgress, setUpdateProgress] = useState<CodexRuntimeUpdateProgress>({ stage: 'checking', progress: null });
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
  /** 同一窗口客户端只自动加载一次，切换设置分类不把已显示状态退回空白。 */
  const overviewClientRef = useRef<NativeConversationAppClient | null>(null);
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

  useEffect(() => {
    /** 首次进入模型供应商页自动恢复状态；同一客户端切换分类继续显示已有结果。 */
    const client = input.client;
    if (!input.settingsActive || !client || overviewClientRef.current === client) return;
    overviewClientRef.current = client;
    void refreshCodexOverview('check_update');
  }, [input.settingsActive, input.client]);

  useEffect(() => {
    /** 未知阶段或越界比例不能进入界面状态。 */
    const receiveUpdateProgress = (event: Event): void => {
      /** 窗口事件先按未知字段读取，再逐项校验。 */
      const detail = (event as CustomEvent<Partial<CodexRuntimeUpdateProgress>>).detail;
      if (!detail || !isCodexRuntimeUpdateStage(detail.stage) || !(detail.progress === null || (typeof detail.progress === 'number' && Number.isFinite(detail.progress) && detail.progress >= 0 && detail.progress <= 1))) return;
      /** 通过校验后再收窄为页面状态。 */
      const next = { stage: detail.stage, progress: detail.progress };
      setUpdateProgress(next);
    };
    window.addEventListener(codexRuntimeUpdateProgressEvent, receiveUpdateProgress);
    return () => window.removeEventListener(codexRuntimeUpdateProgressEvent, receiveUpdateProgress);
  }, []);

  useEffect(() => {
    /** 后台结果只更新同一份程序的提示，不能覆盖用户正在安装的版本。 */
    const receiveUpdateCheck = (event: Event): void => {
      /** 事件字段先核对再使用，缺失或其他安装路径的结果不进入当前页面。 */
      const checked = (event as CustomEvent<CodexRuntimeUpdateStatus | undefined>).detail;
      if (operation !== 'idle' || !checked || !['available', 'up_to_date', 'unavailable'].includes(checked.status) || typeof checked.managedInstallation !== 'boolean' || typeof checked.checkedAt !== 'string') return;
      if (!(checked.currentVersion === null || typeof checked.currentVersion === 'string') || !(checked.latestVersion === null || typeof checked.latestVersion === 'string')) return;
      if (!installationCheck?.resolvedCommandPath || checked.adapter?.resolvedCommandPath !== installationCheck.resolvedCommandPath) return;
      setUpdateCheck(checked);
    };
    window.addEventListener(codexRuntimeUpdateCheckedEvent, receiveUpdateCheck);
    return () => window.removeEventListener(codexRuntimeUpdateCheckedEvent, receiveUpdateCheck);
  }, [operation, installationCheck]);

  useEffect(() => {
    /** 登录或重新连接完成后原地刷新模型目录，不清空已经显示的账号状态。 */
    const client = input.client;
    if (!input.settingsActive || !client) return;
    /** 能力事件只读取已就绪目录，失败等待用户的下一次显式检测。 */
    const refreshModels = (): void => {
      void client
        .loadDigitalEmployeeCapabilities()
        .then((snapshot) => {
          setModels(availableCodexModels(snapshot.models));
          setModelsChecked(true);
        })
        .catch(() => undefined);
    };
    window.addEventListener(codexCapabilitiesChangedEvent, refreshModels);
    return () => window.removeEventListener(codexCapabilitiesChangedEvent, refreshModels);
  }, [input.settingsActive, input.client]);

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
          /** 供应商中已启用的模型全局可用；这里只核对引用可用，不再写项目级白名单。 */
          const catalog = await current.client.loadSelectablePiModels();
          if (!isCurrent()) return;
          const available = new Set(catalog.filter((model) => model.available).map((model) => model.id));
          if (!available.has(reference)) throw new Error('ZEUS_MODEL_UNAVAILABLE');
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

  /** 检查和安装是两个明确动作；安装只使用用户已看到的目标版本。 */
  async function refreshCodexOverview(action: 'refresh' | 'check_update' | 'install_update'): Promise<void> {
    /** 每次操作读取最新客户端，避免设置页切换后写回旧连接。 */
    const client = currentInputRef.current.client;
    if (!client || operation !== 'idle') return;
    /** 点击安装时冻结页面上的目标，后台检查不能替换本次确认内容。 */
    const targetVersion = action === 'install_update' && updateCheck?.status === 'available' && updateCheck.managedInstallation ? updateCheck.latestVersion : null;
    if (action === 'install_update' && !targetVersion) return;
    /** 三类状态并行读取，账号结果不再等待版本检测完成后才显示。 */
    const request = ++requestRef.current;
    setOperation(targetVersion ? 'updating' : action === 'check_update' ? 'checking_update' : 'checking');
    setError(null);
    if (action === 'check_update') {
      setUpdateCheck(null);
      setUpdateProgress({ stage: 'checking', progress: null });
    }
    /** 更新完成后必须再读一次账号和模型，避免保留热切换前的目录快照。 */
    const didUpdate = Boolean(targetVersion);
    if (didUpdate) setUpdateProgress({ stage: 'preparing', progress: null });
    /** 只读检查绝不接续安装，安装请求必须显式携带已确认版本。 */
    const runtimeRequest = (
      targetVersion
        ? client.updateCodex(targetVersion).then((updated) => ({ adapter: updated.adapter, update: updated }))
        : action === 'check_update'
          ? client.checkCodexUpdate().then((checked) => ({ adapter: checked.adapter, update: checked }))
          : client.checkRuntimeAdapter('codex').then((adapter) => ({ adapter, update: null }))
    ).then((runtime) => {
      if (requestRef.current === request) {
        setInstallationCheck(runtime.adapter);
        if (runtime.update) setUpdateCheck(runtime.update);
      }
      return runtime;
    });
    /** 账号先返回就先显示，不再被程序版本或公网更新检查阻塞。 */
    const accountRequest = client.loadCodexAccount().then((value) => {
      if (requestRef.current === request) {
        setAccount(value);
        setAccountChecked(true);
      }
      return value;
    });
    /** 模型目录与账号并行读取，任一成功都可以独立更新页面。 */
    const modelsRequest = client.loadDigitalEmployeeCapabilities().then((snapshot) => {
      if (requestRef.current === request) {
        setModels(availableCodexModels(snapshot.models));
        setModelsChecked(true);
      }
      return snapshot;
    });
    try {
      const [runtimeResult, accountResult, modelsResult] = await Promise.allSettled([runtimeRequest, accountRequest, modelsRequest]);
      if (requestRef.current !== request) return;
      /** 未更新时沿用首轮并行结果；更新后改以新实例的二次读取为准。 */
      let finalAccountAndModelResults: PromiseSettledResult<unknown>[] = [accountResult, modelsResult];
      if (didUpdate && runtimeResult.status === 'fulfilled') {
        /** 新实例就绪后覆盖并行阶段可能得到的旧账号与模型快照。 */
        const [refreshedAccount, refreshedModels] = await Promise.allSettled([client.loadCodexAccount(), client.loadDigitalEmployeeCapabilities()]);
        if (requestRef.current !== request) return;
        if (refreshedAccount.status === 'fulfilled') {
          setAccount(refreshedAccount.value);
          setAccountChecked(true);
        }
        if (refreshedModels.status === 'fulfilled') {
          setModels(availableCodexModels(refreshedModels.value.models));
          setModelsChecked(true);
        }
        finalAccountAndModelResults = [refreshedAccount, refreshedModels];
      }
      /** 部分查询成功时保留已得到的状态，同时把首个真实失败交给统一错误出口。 */
      const failed = [runtimeResult, ...finalAccountAndModelResults].find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        overviewClientRef.current = null;
        /** 安装结果不明时撤掉旧的安装按钮，先检测或重新连接，不能直接重发。 */
        if (didUpdate) setUpdateCheck(null);
        setError(userFacingErrorCause(failed.reason));
      }
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

  /** 重建当前 Codex 运行实例后回读账号、模型和程序状态，不要求已登录用户重复授权。 */
  async function reconnectCodex(): Promise<void> {
    /** 使用最新客户端，避免设置页切换期间操作旧连接。 */
    const client = currentInputRef.current.client;
    if (!client || operation !== 'idle') return;
    /** 重连与后续回读共用请求代次，迟到结果不能覆盖新操作。 */
    const request = ++requestRef.current;
    setOperation('activating');
    setError(null);
    try {
      await client.activateCodexConfig({ syncSubscriptionModels: true });
      if (requestRef.current !== request) return;
      /** 允许既有总览入口接手状态回读；它会建立自己的请求代次。 */
      setOperation('idle');
      overviewClientRef.current = null;
      await refreshCodexOverview('refresh');
    } catch (failure) {
      if (requestRef.current !== request) return;
      setOperation('idle');
      setError(userFacingErrorCause(failure));
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
      setModels([]);
      setModelsChecked(true);
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

  /** 官方账户管理经过既有安全链接入口，迟到失败不覆盖其他操作的状态。 */
  async function openUsageManagement(): Promise<void> {
    /** 只向发起打开操作的设置状态报告失败。 */
    const request = requestRef.current;
    try {
      /** 点数购买和扣费规则由官方页面管理，Zeus 只提供入口。 */
      const result = await openExternalHttpsUrlInMain({ zeus: window.zeus, url: 'https://chatgpt.com/codex/settings/usage' });
      if (requestRef.current === request && !result.opened) setError(zh ? '无法打开官方用量页面，请检查系统浏览器。' : 'Could not open the official usage page. Check your system browser.');
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
    models,
    modelsChecked,
    updateCheck,
    updateProgress,
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
    refreshCodexOverview,
    reconnectCodex,
    logoutAccount,
    openInstallGuide,
    openUsageManagement,
  };
}

/** 首次引导和设置面共用的窗口内控制状态。 */
export type ModelSetupController = ReturnType<typeof useModelSetup>;
