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
  /** 使用无登录凭据的临时浏览器读取动态价格正文，不占用用户会话标签页。 */
  readPricingPage?(input: { url: string }): Promise<string>;
  invoke(input: BrowserAutomationToolCall): Promise<BrowserAutomationToolResult>;
  /** 轮次结束或用户中断时撤销桌面控制；浏览器会话不受影响。 */
  endComputerUse?(input: { conversationId: string; turnId: string }): Promise<void>;
}
