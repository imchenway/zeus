/** 本机页面使用服务端登记的会话执行目录和产物目录。 */
export interface BrowserLocalFileScope {
  /** 当前会话实际执行的目录，任务会话使用独立工作区。 */
  projectRoot: string | null;
  /** 主项目真实目录用于核对工作区已映射的共享文件。 */
  registeredProjectRoot?: string;
  /** Zeus 产物目录只提供 HTML 预览。 */
  artifactsDirectory?: string;
}

export interface BrowserAutomationToolCall {
  conversationId: string;
  threadId: string;
  turnId: string;
  callId: string;
  namespace?: 'zeus_browser' | 'zeus_computer' | 'zeus_work' | 'zeus_conversation' | 'zeus_automation';
  tool: string;
  arguments: Record<string, unknown>;
  /** 调度端指定的调用截止时间，跨进程传递，不接受模型参数延长。 */
  deadlineUnixMs?: number;
  /** 文件范围由会话宿主填写，与模型传入的工具参数分开。 */
  localFileScope?: BrowserLocalFileScope;
}

export type BrowserAutomationContentItem = { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string };

export interface BrowserAutomationToolResult {
  contentItems: BrowserAutomationContentItem[];
  success: boolean;
}

/** 内置浏览器目录和调用入口共用的 CUA 指针操作。参数由同一个 CUA 驱动公布和校验。 */
export function isBrowserCuaPointerMethod(path: unknown): boolean {
  return path === 'browser_click' || path === 'browser_pointer';
}

/**
 * Electron Main 实现此端口；local-server 只负责编排 app-server 动态工具，
 * 不直接依赖 Electron、Chromium session 或窗口对象。
 */
export interface BrowserAutomationPort {
  /** 仅命令中心冻结微信模板调用；Main 校验安装身份后打开用户应用，CLI 仍在 Core Job 内执行。 */
  ensureWechatApplication?(input: { runId: string; cliPathHint?: string }): Promise<{ applicationPath: string; cliPath: string }>;
  /** 固定受管 Codex 安装的 Windows daemon 启动入口，不接受任意程序、参数或环境。 */
  ensureCodexRemoteControl?(retryProxyHandoff: boolean): Promise<{ socketPath: string }>;
  /** 使用无登录凭据的临时浏览器读取动态价格正文，不占用用户会话标签页。 */
  readPricingPage?(input: { url: string }): Promise<string>;
  invoke(input: BrowserAutomationToolCall): Promise<BrowserAutomationToolResult>;
  /** 轮次结束或用户中断时撤销桌面与浏览器控制；保留用户标签和登录态。 */
  endComputerUse?(input: { conversationId: string; turnId: string }): Promise<void>;
}
