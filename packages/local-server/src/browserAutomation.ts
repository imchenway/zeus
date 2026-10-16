export interface BrowserAutomationToolCall {
  conversationId: string;
  threadId: string;
  turnId: string;
  callId: string;
  namespace?: 'zeus_browser' | 'zeus_computer' | 'zeus_work';
  tool: string;
  arguments: Record<string, unknown>;
  /** 调度端指定的调用截止时间，跨进程传递，不接受模型参数延长。 */
  deadlineUnixMs?: number;
}

export type BrowserAutomationContentItem = { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string };

export interface BrowserAutomationToolResult {
  contentItems: BrowserAutomationContentItem[];
  success: boolean;
}

/**
 * Electron Main 实现此端口；local-server 只负责编排 app-server 动态工具，
 * 不直接依赖 Electron、Chromium session 或窗口对象。
 */
export interface BrowserAutomationPort {
  /** 仅命令中心冻结微信模板调用；Main 校验安装身份后打开用户应用，CLI 仍在 Core Job 内执行。 */
  ensureWechatApplication?(input: { runId: string; cliPathHint?: string }): Promise<{ applicationPath: string; cliPath: string }>;
  /** 固定受管 Codex 安装的 Windows daemon 启动入口，不接受任意程序、参数或环境。 */
  ensureCodexRemoteControl?(): Promise<{ socketPath: string }>;
  /** 使用无登录凭据的临时浏览器读取动态价格正文，不占用用户会话标签页。 */
  readPricingPage?(input: { url: string }): Promise<string>;
  invoke(input: BrowserAutomationToolCall): Promise<BrowserAutomationToolResult>;
  /** 轮次结束或用户中断时撤销桌面控制；浏览器会话不受影响。 */
  endComputerUse?(input: { conversationId: string; turnId: string }): Promise<void>;
}
