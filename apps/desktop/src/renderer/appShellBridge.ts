export interface MainAppShellSettingsChange {
  webviewDebugEnabled: boolean;
  multiWindowEnabled: boolean;
  backgroundModeEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  openAtLoginEnabled: boolean;
}

export interface GraphSourceOpenRequest {
  sourceRef: string;
  lineStart?: number;
}

export interface GraphSourceOpenResult {
  opened: boolean;
  filePath: string | null;
  lineStart?: number | null;
}

export interface AppShellBridgeWindow {
  zeus?: {
    notifyAppShellSettingsChanged?: (settings: MainAppShellSettingsChange) => Promise<{ applied: boolean }>;
    openGraphSource?: (source: GraphSourceOpenRequest) => Promise<GraphSourceOpenResult>;
  };
}

/** Renderer 保存设置后通知 Electron Main，使菜单、多窗口、后台驻留、系统通知和登录项策略立即生效。 */
export async function notifyMainAppShellSettingsChanged(input: { zeus: AppShellBridgeWindow['zeus']; settings: MainAppShellSettingsChange }): Promise<{ applied: boolean }> {
  if (!input.zeus?.notifyAppShellSettingsChanged) return { applied: false };
  return input.zeus.notifyAppShellSettingsChanged(input.settings);
}

/** 从 Renderer 请求 Electron Main 打开图谱来源文件；非 Electron 环境返回 no-op，方便 SSR 测试与浏览器预览。 */
export async function openGraphSourceInMain(input: { zeus: AppShellBridgeWindow['zeus']; source: GraphSourceOpenRequest }): Promise<GraphSourceOpenResult> {
  if (!input.zeus?.openGraphSource)
    return {
      opened: false,
      filePath: null,
      lineStart: input.source.lineStart ?? null,
    };
  return input.zeus.openGraphSource(input.source);
}
