import type { ConversationFileLocation, ConversationOpenTarget, ConversationResourceOpenTarget } from '@zeus/shared';

export interface MainAppShellSettingsChange {
  appLanguage: 'zh-CN' | 'en-US';
  appearance: 'light' | 'dark' | 'system';
  webviewDebugEnabled: boolean;
  multiWindowEnabled: boolean;
  backgroundModeEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  openAtLoginEnabled: boolean;
}

export interface GraphSourceOpenRequest {
  projectRoot?: string;
  sourceRef: string;
  lineStart?: number;
}

export interface GraphSourceOpenResult {
  opened: boolean;
  filePath: string | null;
  lineStart?: number | null;
}

export interface ExternalHttpsOpenResult {
  opened: boolean;
  url?: string;
  error?: string;
}

export interface RequestingWindowActivationResult {
  activated: boolean;
  error?: string;
}

export type AutomaticUpdateIndicatorPhase = 'idle' | 'available' | 'preparing' | 'retrying' | 'ready' | 'failed';

export interface AutomaticUpdateIndicatorState {
  phase: AutomaticUpdateIndicatorPhase;
  currentVersion: string;
  latestVersion: string | null;
  detail: string;
  updatedAt: string;
  progress?: number;
  retryAt?: string;
}

export interface ProjectRevealResult {
  revealed: boolean;
  path?: string;
  error?: string;
}

export interface AppShellBridgeWindow {
  zeus?: {
    notifyAppShellSettingsChanged?: (settings: MainAppShellSettingsChange) => Promise<{ applied: boolean }>;
    notifyTaskTableLayoutDirty?: (dirty: boolean) => void;
    resolveTaskTableLayoutCloseRequest?: (proceed: boolean) => void;
    onTaskTableLayoutCloseRequested?: (listener: () => void) => () => void;
    getRequestingWindowForeground?: () => Promise<{ foreground: boolean }>;
    onRequestingWindowForegroundChanged?: (listener: (foreground: boolean) => void) => () => void;
    openGraphSource?: (source: GraphSourceOpenRequest) => Promise<GraphSourceOpenResult>;
    openExternalHttpsUrl?: (url: string) => Promise<ExternalHttpsOpenResult>;
    activateRequestingWindow?: () => Promise<RequestingWindowActivationResult>;
    getAutomaticUpdateIndicator?: () => Promise<AutomaticUpdateIndicatorState | null>;
    openAutomaticUpdateIndicator?: () => Promise<{ opened: boolean }>;
    recordManualUpdateCheck?: () => Promise<{ recorded: boolean }>;
    onAutomaticUpdateIndicatorChanged?: (listener: (state: AutomaticUpdateIndicatorState) => void) => () => void;
    listConversationResourceOpenTargets?: (request: { projectId: string; conversationId: string; resourceId: string }) => Promise<{ resourceId: string; targets: ConversationResourceOpenTarget[] }>;
    openConversationResource?: (request: { projectId: string; conversationId: string; resourceId: string; target: ConversationOpenTarget; location?: ConversationFileLocation }) => Promise<{
      opened: boolean;
      resourceId: string;
      target: ConversationOpenTarget;
      mode?: 'zeus_source' | 'zeus_browser' | 'external' | 'file' | 'clipboard';
      error?: string;
    }>;
    openTurnChangeFile?: (request: { projectId: string; conversationId: string; turnId: string; changeSetId: string; fileId: string; target: ConversationOpenTarget; location?: ConversationFileLocation }) => Promise<{
      opened: boolean;
      resourceId: string;
      target: ConversationOpenTarget;
      mode?: 'zeus_source' | 'zeus_browser' | 'external' | 'file' | 'clipboard';
      error?: string;
    }>;
    revealProjectInFinder?: (projectPath: string) => Promise<ProjectRevealResult>;
  };
}

/** Renderer 保存设置后通知 Electron Main，使菜单、多窗口、后台驻留、系统通知和登录项策略立即生效。 */
export async function notifyMainAppShellSettingsChanged(input: { zeus: AppShellBridgeWindow['zeus']; settings: MainAppShellSettingsChange }): Promise<{ applied: boolean }> {
  if (!input.zeus?.notifyAppShellSettingsChanged) return { applied: false };
  return input.zeus.notifyAppShellSettingsChanged(input.settings);
}

/** 从 Renderer 请求 Electron Main 打开图谱来源文件；非 Electron 环境返回 no-op，供浏览器预览安全降级。 */
export async function openGraphSourceInMain(input: { zeus: AppShellBridgeWindow['zeus']; source: GraphSourceOpenRequest }): Promise<GraphSourceOpenResult> {
  if (!input.zeus?.openGraphSource)
    return {
      opened: false,
      filePath: null,
      lineStart: input.source.lineStart ?? null,
    };
  return input.zeus.openGraphSource(input.source);
}

/** Renderer 先拒绝非 HTTPS/含凭据 URL；Main 进程仍会独立复验后才打开系统浏览器。 */
export async function openExternalHttpsUrlInMain(input: { zeus: AppShellBridgeWindow['zeus']; url: unknown }): Promise<ExternalHttpsOpenResult> {
  const url = normalizeRendererExternalHttpsUrl(input.url);
  if (!url) return { opened: false, error: 'external_url_not_allowed' };
  if (!input.zeus?.openExternalHttpsUrl) return { opened: false, error: 'external_open_unavailable' };
  return input.zeus.openExternalHttpsUrl(url);
}

/** 外部登录完成后只激活发起请求的受信 Zeus 窗口；非 Electron 预览环境安全降级。 */
export async function activateRequestingZeusWindowInMain(input: { zeus: AppShellBridgeWindow['zeus'] }): Promise<RequestingWindowActivationResult> {
  if (!input.zeus?.activateRequestingWindow) return { activated: false, error: 'window_activation_unavailable' };
  return input.zeus.activateRequestingWindow();
}

export async function loadAutomaticUpdateIndicatorFromMain(input: { zeus: AppShellBridgeWindow['zeus'] }): Promise<AutomaticUpdateIndicatorState | null> {
  return input.zeus?.getAutomaticUpdateIndicator ? input.zeus.getAutomaticUpdateIndicator() : null;
}

export async function openAutomaticUpdateIndicatorInMain(input: { zeus: AppShellBridgeWindow['zeus'] }): Promise<{ opened: boolean }> {
  return input.zeus?.openAutomaticUpdateIndicator ? input.zeus.openAutomaticUpdateIndicator() : { opened: false };
}

export async function recordManualUpdateCheckInMain(input: { zeus: AppShellBridgeWindow['zeus'] }): Promise<{ recorded: boolean }> {
  return input.zeus?.recordManualUpdateCheck ? input.zeus.recordManualUpdateCheck() : { recorded: false };
}

export async function listConversationResourceOpenTargetsInMain(input: {
  zeus: AppShellBridgeWindow['zeus'];
  projectId: string;
  conversationId: string;
  resourceId: string;
}): Promise<{ resourceId: string; targets: ConversationResourceOpenTarget[] }> {
  if (!input.zeus?.listConversationResourceOpenTargets) return { resourceId: input.resourceId, targets: [] };
  return input.zeus.listConversationResourceOpenTargets({
    projectId: input.projectId,
    conversationId: input.conversationId,
    resourceId: input.resourceId,
  });
}

export async function openConversationResourceInMain(input: { zeus: AppShellBridgeWindow['zeus']; projectId: string; conversationId: string; resourceId: string; target: ConversationOpenTarget; location?: ConversationFileLocation }) {
  if (!input.zeus?.openConversationResource) {
    return { opened: false, resourceId: input.resourceId, target: input.target, error: 'conversation_resource_open_unavailable' } as const;
  }
  return input.zeus.openConversationResource({
    projectId: input.projectId,
    conversationId: input.conversationId,
    resourceId: input.resourceId,
    target: input.target,
    ...(input.location ? { location: input.location } : {}),
  });
}

export async function openTurnChangeFileInMain(input: {
  zeus: AppShellBridgeWindow['zeus'];
  projectId: string;
  conversationId: string;
  turnId: string;
  changeSetId: string;
  fileId: string;
  target: ConversationOpenTarget;
  location?: ConversationFileLocation;
}) {
  if (!input.zeus?.openTurnChangeFile) {
    return { opened: false, resourceId: `turn_change_file_open_${input.fileId}`, target: input.target, error: 'turn_change_file_open_unavailable' } as const;
  }
  return input.zeus.openTurnChangeFile({
    projectId: input.projectId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    changeSetId: input.changeSetId,
    fileId: input.fileId,
    target: input.target,
    ...(input.location ? { location: input.location } : {}),
  });
}

/** 项目菜单只接受绝对本地路径；Main 进程会再次校验目录存在且请求来自受信窗口。 */
export async function revealProjectInFinderInMain(input: { zeus: AppShellBridgeWindow['zeus']; projectPath: unknown }): Promise<ProjectRevealResult> {
  const projectPath = normalizeRendererProjectPath(input.projectPath);
  if (!projectPath) return { revealed: false, error: 'project_path_not_allowed' };
  if (!input.zeus?.revealProjectInFinder) return { revealed: false, error: 'project_reveal_unavailable' };
  return input.zeus.revealProjectInFinder(projectPath);
}

function normalizeRendererExternalHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeRendererProjectPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  return path && path.startsWith('/') && !path.includes('\0') ? path : null;
}
