export const codexLoginSuccessFeedbackMs = 900;

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
