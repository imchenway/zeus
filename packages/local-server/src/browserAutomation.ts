export interface BrowserAutomationToolCall {
  conversationId: string;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export type BrowserAutomationContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

/**
 * Electron Main 实现此端口；local-server 只负责编排 app-server 动态工具，
 * 不直接依赖 Electron、Chromium session 或窗口对象。
 */
export interface BrowserAutomationPort {
  invoke(input: BrowserAutomationToolCall): Promise<{
    contentItems: BrowserAutomationContentItem[];
    success: boolean;
  }>;
}
