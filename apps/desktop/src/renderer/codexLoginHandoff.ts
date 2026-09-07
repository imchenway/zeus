import type { CodexAccountSnapshot } from './session/sessionTypes.js';
import type { CodexApiClient } from './features/codex/codexApiClient.js';
import { activateRequestingZeusWindowInMain, openExternalHttpsUrlInMain } from './appShellBridge.js';

/** 成功反馈保留短暂停顿，让用户确认已经回到 Zeus。 */
export const codexLoginSuccessFeedbackMs = 900;

/** 登录成功回交所需的当前请求校验与界面动作。 */
export interface CodexLoginHandoffInput {
  isCurrent: () => boolean;
  showSuccess: () => void;
  activateZeus: () => Promise<unknown>;
  recordActivationError: (error: unknown) => void;
  continueOriginalAction: () => void;
}

/**
 * 统一收口 Zeus 发起的 Codex 浏览器登录：先展示成功并回到原窗口，再继续用户原操作。
 * 登录已经取消或被新请求替代时，每个异步边界都会停止回交，避免旧轮询抢占窗口或重复提交。
 */
export async function completeCodexLoginHandoff(input: CodexLoginHandoffInput): Promise<boolean> {
  const activateZeus = async (): Promise<void> => {
    try {
      await input.activateZeus();
    } catch (error) {
      // 窗口激活是体验增强，失败不能把已经完成的账号认证改写为登录失败。
      input.recordActivationError(error);
    }
  };
  if (!input.isCurrent()) return false;
  input.showSuccess();
  await activateZeus();
  if (!input.isCurrent()) return false;
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, codexLoginSuccessFeedbackMs));
  if (!input.isCurrent()) return false;
  // 浏览器完成页可能在认证回执后仍发生一次导航；继续原操作前再次把 Zeus 带回前台，避免被外部产品抢回焦点。
  await activateZeus();
  if (!input.isCurrent()) return false;
  input.continueOriginalAction();
  return true;
}

/** 共享官方登录流程；所有入口都通过当前请求身份隔离取消和迟到回执。 */
export async function authenticateCodexWithBrowser(input: {
  client: Pick<CodexApiClient, 'startCodexChatGptLogin' | 'cancelCodexChatGptLogin' | 'loadCodexAccount' | 'activateCodexConfig'>;
  isCurrent: () => boolean;
  onLoginId: (loginId: string | null) => void;
  /** 认证完成后仍需等待当前账号的模型目录与容量就绪。 */
  onPreparingModels: () => void;
  showSuccess: (account: CodexAccountSnapshot) => void;
  continueOriginalAction: (account: CodexAccountSnapshot) => void;
  recordActivationError: (error: unknown) => void;
}): Promise<void> {
  // 登录任务身份只留在内存；认证地址和账号凭据不写入持久记录。
  let loginId: string | null = null;
  try {
    const login = await input.client.startCodexChatGptLogin();
    loginId = login.loginId;
    if (!input.isCurrent()) return;
    input.onLoginId(loginId);
    const opened = await openExternalHttpsUrlInMain({ zeus: typeof window === 'undefined' ? undefined : window.zeus, url: login.authUrl });
    if (!input.isCurrent()) return;
    if (!opened.opened) throw new Error('ZEUS_CODEX_LOGIN_BROWSER_OPEN_FAILED');
    // 沿用官方网页登录的五分钟等待与串行查询，避免重叠轮询。
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      if (!input.isCurrent()) return;
      const account = await input.client.loadCodexAccount();
      if (!input.isCurrent()) return;
      // 选择订阅登录时，API Key 或免认证供应商不能伪装成订阅登录成功。
      if (account.signedIn && account.accountType === 'chatgpt') {
        loginId = null;
        input.onLoginId(null);
        // 登录前的运行实例冻结了未认证目录；复用现有代际切换，保留旧实例正在执行的轮次。
        input.onPreparingModels();
        await input.client.activateCodexConfig();
        if (!input.isCurrent()) return;
        await completeCodexLoginHandoff({
          isCurrent: input.isCurrent,
          showSuccess: () => input.showSuccess(account),
          activateZeus: async () => {
            const result = await activateRequestingZeusWindowInMain({ zeus: typeof window === 'undefined' ? undefined : window.zeus });
            if (!result.activated) throw new Error(result.error ?? 'window_activation_failed');
          },
          recordActivationError: input.recordActivationError,
          continueOriginalAction: () => input.continueOriginalAction(account),
        });
        return;
      }
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 800));
    }
    throw new Error('ZEUS_CODEX_LOGIN_TIMED_OUT');
  } finally {
    if (loginId) await input.client.cancelCodexChatGptLogin(loginId).catch(() => undefined);
    if (input.isCurrent()) input.onLoginId(null);
  }
}
