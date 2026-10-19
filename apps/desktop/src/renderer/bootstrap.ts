// 启动入口不导入 React、样式或业务模块，确保这些资源失败时仍能通知 Main 显示恢复入口。
void import('./main.js').catch((error: unknown) => {
  /** 保留原始错误供开发者检查，跨 IPC 只传递错误说明。 */
  const detail = error instanceof Error ? error.message : String(error);
  console.error('Zeus renderer entry failed', error);
  window.zeus?.reportRendererFatalFailure?.(detail);
});
