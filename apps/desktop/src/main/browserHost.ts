import { browserCredentialPromptHtml } from './browserCredentialPrompt.js';
import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  MessageChannelMain,
  nativeImage,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Rectangle,
  session,
  type Session,
  type WebContents,
  type WebFrameMain,
  WebContentsView,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { publishFile } from '@zeus/storage/platform-security';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { defaultBrowserTranslationService, isFreeBrowserTranslationService, serializeBrowserComments, validBrowserTranslationSegments } from '@zeus/shared';
import type { createBrowserTranslationClient } from './browserTranslationClient.js';
import type {
  ZeusBrowserApprovalDecision,
  ZeusBrowserApprovalRequest,
  ZeusBrowserCommand,
  ZeusBrowserComment,
  ZeusBrowserConversationSnapshot,
  ZeusBrowserDesignChange,
  ZeusBrowserEvent,
  ZeusBrowserPageAnchor,
  ZeusBrowserPreparedSubmission,
  ZeusBrowserSettings,
  ZeusBrowserTabSnapshot,
} from '@zeus/shared';
import {
  browserFrozenContractEntries,
  browserFrozenArgumentSchema,
  browserFrozenContractEntry,
  browserFrozenContractVersion,
  browserFrozenUnsupportedSurfaceKinds,
  type BrowserAutomationContentItem,
  type BrowserAutomationPort,
  type BrowserAutomationToolCall,
  type BrowserFrozenContractEntry,
} from '@zeus/local-server';
import { googleWorkspaceExportRequest, sanitizeBrowserArtifactName } from './browserArtifactExport.js';
import type { MainCommandLedger, MainCommandRequest } from './mainCommandLedger.js';
import type { RetiredNativeRuntimeCleanup } from './retiredNativeRuntimeCleanup.js';
import { BrowserPasswordStore, browserPasswordOrigin } from './browserPasswords.js';
import { BrowserCuaHost } from './browserCuaHost.js';
import type { BrowserCuaSurface } from './browserCuaBridge.js';
import type { ComputerHost } from './computerHost.js';
import type { BrowserPasswordFrameRequest } from '../preload/browserPasswordFrame.js';

/** 仅保存长期设置与书签；标签、活动页和分组随本次应用运行结束。 */
interface PersistedBrowserState {
  version: 1;
  settings: ZeusBrowserSettings;
  managementBookmarks?: ManagedBrowserBookmark[];
  managementAudit?: ManagedBrowserAuditEntry[];
}

interface LiveBrowserTab {
  /** 已填密码只用于清理工具返回和网页日志，关闭标签后释放。 */
  passwordValues?: Set<string>;
  snapshot: ZeusBrowserTabSnapshot;
  view?: WebContentsView;
  ownerWindowId?: number;
  documentGeneration: number;
  /** 当前文档的翻译身份与取消范围，关闭标签后不再请求外部服务。 */
  translation?: { id: string; serviceId: string; controller: AbortController; busy: boolean };
  /** 页面 preload 未启动时不能把未被接收的翻译指令显示为持续处理中。 */
  pagePreloadFailed?: boolean;
  /** 区分本页首次查找与上一处／下一处，换页后重新开始。 */
  findText?: string;
  consoleLogs: Array<{ level: number; message: string; line: number; sourceId: string; createdAt: string }>;
}

interface AdvancedBrowserHandle {
  id: string;
  kind: string;
  conversationId: string;
  turnId: string;
  tabId?: string;
  documentGeneration?: number;
  payload?: Record<string, unknown>;
}

interface AdvancedTabClaim {
  conversationId: string;
  tabId: string;
  title: string;
  url: string;
  documentGeneration: number;
  claimToken: string;
  createdAt: number;
}

interface PageAssetInventory {
  id: string;
  conversationId: string;
  turnId: string;
  tabId: string;
  documentGeneration: number;
  assets: Array<{ id: string; kind: 'script' | 'font' | 'image' | 'stylesheet' | 'video' | 'other'; name: string; url: string; contentType: string | null }>;
}

interface PendingApproval {
  request: ZeusBrowserApprovalRequest;
  resolve: (decision: ZeusBrowserApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BrowserDownload {
  conversationId: string;
  tabId: string;
  fileName: string;
  path?: string;
  state: 'started' | 'completed' | 'failed';
  createdAt: string;
}

interface ActiveBrowserJsDialog {
  /** 保存真实 CDP 参数，供后建立的 CUA 连接接续该对话框。 */
  parameters?: Record<string, unknown>;
  kind: 'AlertDialog' | 'BeforeUnloadDialog' | 'ConfirmDialog' | 'PromptDialog';
  type: 'alert' | 'beforeunload' | 'confirm' | 'prompt';
  message: string;
  defaultPrompt?: string;
  sequence: number;
}

interface ManagedBrowserBookmark {
  id: string;
  parentId?: string;
  index: number;
  title: string;
  url?: string;
  dateAdded: number;
}

interface ManagedBrowserTabGroup {
  id: string;
  title: string;
  color: string;
  collapsed: boolean;
  tabIds: string[];
  index: number;
}

interface ManagedBrowserAuditEntry {
  id: string;
  area: 'bookmarks' | 'tabGroups' | 'tabs';
  method: string;
  arguments: unknown[];
  before: unknown;
  after: unknown;
  createdAt: string;
}

interface CreateBrowserHostOptions {
  /** 密码库由当前资料根与系统凭据身份共同隔离。 */
  passwords: BrowserPasswordStore;
  /** Main 内唯一的 CUA 宿主，模型不能指定 Driver 或传输地址。 */
  computer?: () => ComputerHost;
  /** 免费服务和已配置模型都通过本机 Core 请求，不把凭据交给网页。 */
  translation?: ReturnType<typeof createBrowserTranslationClient>;
  /** 内置浏览器的授权和登录窗口跟随应用语言。 */
  language?: () => 'zh-CN' | 'en-US';
  statePath: string;
  preloadPath: string;
  attachmentRoot: string;
  defaultDownloadDirectory: string;
  openExternal: (url: string) => Promise<void>;
  mainCommandLedger: () => MainCommandLedger;
  legacySystemDownloadDirectory?: string;
  /** 正式数据隔离副本只读取设置；禁止创建 WebContentsView、导航、下载或持久化。 */
  readOnlyValidation?: boolean;
  configureExternalBrowsers?: (settings: Pick<ZeusBrowserSettings, 'externalChromeEnabled' | 'externalEdgeEnabled'>) => Promise<{
    state: NonNullable<ZeusBrowserSettings['externalConnectionState']>;
    detail?: string;
  }>;
  retiredNativeRuntimeCleanup?: RetiredNativeRuntimeCleanup;
  now?: () => string;
}

interface BrowserPageCommentInput {
  /** 编辑已有评论时保持原编号和草稿身份。 */
  commentId?: unknown;
  body?: unknown;
  anchor?: unknown;
  designChanges?: unknown;
}

export const browserPartition = 'persist:zeus-browser';
/** 每个标签最多保留的未发送批注数。 */
const maxDraftCommentsPerTab = 200;
const maxCommentBodyLength = 20_000;
const approvalTimeoutMs = 5 * 60_000;

function defaultSettings(options: CreateBrowserHostOptions): ZeusBrowserSettings {
  return {
    enabled: true,
    downloadDirectory: options.defaultDownloadDirectory,
    askWhereToSave: false,
    screenshotMode: 'always',
    webLinkOpenTarget: 'zeus_browser',
    localWebOpenTarget: 'zeus_browser',
    fileOpenTarget: 'zeus_source',
    externalChromeEnabled: false,
    externalEdgeEnabled: false,
    externalConnectionState: 'disabled',
  };
}

function emptyTabSnapshot(input: { id: string; conversationId: string; url: string; now: string }): ZeusBrowserTabSnapshot {
  return {
    id: input.id,
    conversationId: input.conversationId,
    url: input.url,
    title: input.url === 'about:blank' ? 'New tab' : input.url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    annotationMode: false,
    comments: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export class BrowserHost implements BrowserAutomationPort {
  /** 页面自动化复用 CUA，Zeus 只保留标签与应用生命周期。 */
  private readonly cua: BrowserCuaHost;
  readonly attachmentRoot: string;
  private readonly now: () => string;
  private readonly statePath: string;
  private readonly browserSession: Session;
  private readonly tabs = new Map<string, LiveBrowserTab>();
  private readonly windows = new Map<number, BrowserWindow>();
  private readonly visibleTabByWindow = new Map<number, string>();
  private readonly activeTabByConversation = new Map<string, string>();
  /** 页面暂停订阅时保留打开意图，普通后台标签不自动请求展开。 */
  private readonly pendingOpenRequests = new Set<string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly grantedWebPermissions = new Set<string>();
  private readonly downloads: BrowserDownload[] = [];
  private readonly advancedHandles = new Map<string, AdvancedBrowserHandle>();
  private readonly advancedTabClaims = new Map<string, AdvancedTabClaim>();
  private readonly sessionNames = new Map<string, string>();
  private readonly pageAssetInventories = new Map<string, PageAssetInventory>();
  private readonly cdpEvents = new Map<string, Array<{ sequence: number; method: string; params?: Record<string, unknown>; source: { tabId: string; sessionId?: string } }>>();
  private readonly cdpMonitoredContents = new WeakSet<WebContents>();
  private readonly activeJsDialogs = new Map<string, ActiveBrowserJsDialog>();
  private readonly managementBookmarks = new Map<string, ManagedBrowserBookmark>();
  private readonly managementTabGroups = new Map<string, ManagedBrowserTabGroup>();
  private readonly managementAudit: ManagedBrowserAuditEntry[] = [];
  private cdpSequence = 0;
  private settings: ZeusBrowserSettings;
  private persistenceTimer: ReturnType<typeof setTimeout> | undefined;
  private persistenceChain: Promise<void> = Promise.resolve();
  private closed = false;
  private ipcRegistered = false;

  /** 浏览器自身的提示使用应用语言，网页与工具返回的正文不改写。 */
  private text(zh: string, en: string): string {
    return this.options.language?.() === 'en-US' ? en : zh;
  }

  constructor(private readonly options: CreateBrowserHostOptions) {
    this.cua = new BrowserCuaHost(() => {
      const computer = options.computer?.();
      if (!computer) throw new Error('CUA 浏览器宿主尚未就绪。');
      return computer;
    });
    this.now = options.now ?? (() => new Date().toISOString());
    this.statePath = resolve(options.statePath);
    this.attachmentRoot = resolve(options.attachmentRoot);
    this.settings = defaultSettings(options);
    this.browserSession = session.fromPartition(browserPartition, { cache: true });
    this.restorePersistedState();
    this.configureSession();
  }

  registerWindow(window: BrowserWindow): void {
    if (this.closed || window.isDestroyed()) return;
    this.windows.set(window.id, window);
  }

  unregisterWindow(window: BrowserWindow): void {
    this.options.passwords.cancel(window.id);
    for (const tab of this.tabs.values()) {
      if (tab.ownerWindowId === window.id) void this.cua.releaseTab(tab.snapshot.id).catch((error) => console.warn('CUA browser window cleanup failed', error));
    }
    this.windows.delete(window.id);
    const visibleTabId = this.visibleTabByWindow.get(window.id);
    if (visibleTabId) this.detachTab(visibleTabId);
    this.visibleTabByWindow.delete(window.id);
    for (const tab of this.tabs.values()) {
      if (tab.ownerWindowId === window.id) tab.ownerWindowId = undefined;
    }
  }

  /** 判断当前键盘焦点是否位于该窗口正在显示的内置浏览器标签。 */
  isVisibleTabFocused(window: BrowserWindow): boolean {
    const tabId = this.visibleTabByWindow.get(window.id);
    const contents = tabId ? this.tabs.get(tabId)?.view?.webContents : undefined;
    return Boolean(contents && !contents.isDestroyed() && contents.isFocused());
  }

  /** 从原生网页或工具栏定位标签，多标签关闭时同步交接焦点。 */
  closeActiveContextTab(window: BrowserWindow, conversationId?: string): boolean {
    /** 工具栏提供所属会话；网页焦点则直接定位该窗口的原生标签。 */
    const tabId = this.isVisibleTabFocused(window) ? this.visibleTabByWindow.get(window.id) : conversationId ? this.activeTabByConversation.get(conversationId) : undefined;
    /** 只关闭当前窗口拥有的存活标签。 */
    const tab = tabId ? this.tabs.get(tabId) : undefined;
    if (!tab || tab.ownerWindowId !== window.id) return false;
    /** 关闭最后一页时先让 Renderer 收拢承载它的分栏。 */
    if (this.snapshotFor(tab.snapshot.conversationId).tabs.length === 1) {
      if (this.isVisibleTabFocused(window)) window.webContents.focus();
      window.webContents.send('zeus:session-context-close-active-tab', tab.snapshot.conversationId);
      return true;
    }
    this.closeTab(window, tab.snapshot.conversationId, tab.snapshot.id);
    return true;
  }

  registerIpc(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;
    ipcMain.handle('zeus:browser:get-snapshot', (event, conversationId: unknown) => {
      this.requireRendererWindow(event);
      return this.snapshotFor(requireNonEmptyString(conversationId, 'conversationId'));
    });
    // 系统菜单覆盖原生网页，选择结果仍交回现有操作入口执行。
    ipcMain.handle('zeus:browser:show-menu', async (event, input: unknown) => {
      /** 菜单只允许本应用渲染器打开，位置限制在所属窗口内。 */
      const window = this.requireRendererWindow(event);
      const value = asRecord(input);
      const english = value.language === 'en-US';
      /** 菜单状态来自当前标签，不能由渲染器伪造网址或导航能力。 */
      const tab = this.requireConversationTab(requireNonEmptyString(value.conversationId, 'conversationId'), requireNonEmptyString(value.tabId, 'tabId'));
      /** 等待目录期间页面可能关闭或导航，菜单只能用于原来的页面。 */
      const contents = this.ensureView(tab).webContents;
      const generation = tab.documentGeneration;
      /** 原生菜单弹出后不能追加模型项；两类目录并行读取并独立保留失败结果。 */
      const sources = ['codex', 'custom'] as const;
      const catalogs = await Promise.allSettled(sources.map((source) => this.loadTranslationServices(window, tab, source)));
      if (window.isDestroyed() || contents.isDestroyed() || generation !== tab.documentGeneration || this.visibleTabByWindow.get(window.id) !== tab.snapshot.id) return null;
      /** 使用等待结束后的窗口尺寸和真实缩放比例。 */
      const bounds = window.getContentBounds();
      const zoom = Math.round(contents.getZoomFactor() * 100);
      return new Promise<string | { action: 'translation_service'; serviceId: string } | null>((resolveSelection) => {
        /** 原生子菜单覆盖网页，不创建触发网页隐藏的 Renderer 浮层。 */
        const services = new Menu();
        /** 选中标记只来自已保存身份，避免 radio 分组默认勾选其他服务。 */
        const selectedId = this.settings.translationServiceId ?? defaultBrowserTranslationService;
        /** 模型目录失败不影响免费服务的展示和选择。 */
        for (const [id, label] of [
          ['free:microsoft', english ? 'Microsoft · Free' : '微软翻译 · 免费'],
          ['free:google', english ? 'Google · Free' : 'Google 翻译 · 免费'],
        ]) {
          services.append(new MenuItem({ label, type: 'checkbox', checked: selectedId === id, click: () => resolveSelection({ action: 'translation_service', serviceId: id! }) }));
        }
        /** 弹出前完整构建各类模型、登录入口和不可用提示。 */
        for (const [index, result] of catalogs.entries()) {
          services.append(new MenuItem({ type: 'separator' }));
          if (result.status === 'rejected') {
            services.append(new MenuItem({ label: sources[index] === 'codex' ? (english ? 'Codex models unavailable' : 'Codex 模型不可用') : english ? 'Provider models unavailable' : '供应商模型不可用', enabled: false }));
            continue;
          }
          /** 目录身份与翻译命令共用完整 modelRef。 */
          const catalog = result.value;
          for (const model of catalog.items) services.append(new MenuItem({ label: model.label, type: 'checkbox', checked: selectedId === model.id, click: () => resolveSelection({ action: 'translation_service', serviceId: model.id }) }));
          if (catalog.codexLoginRequired) services.append(new MenuItem({ label: english ? 'Sign in to Codex' : '登录 Codex', click: () => resolveSelection('translation_login') }));
          if (!catalog.items.length && !catalog.codexLoginRequired) services.append(new MenuItem({ label: catalog.warning || (english ? 'No available models' : '暂无可用模型'), enabled: false }));
        }
        /** 固定菜单项不接收网页提供的文案或可执行动作。 */
        const menu = Menu.buildFromTemplate([
          { label: english ? 'New tab' : '新建标签', click: () => resolveSelection('new_tab') },
          { label: english ? 'Close tab' : '关闭当前标签', click: () => resolveSelection('close_tab') },
          { label: english ? 'Close other tabs' : '关闭其他标签', enabled: this.snapshotFor(tab.snapshot.conversationId).tabs.length > 1, click: () => resolveSelection('close_other_tabs') },
          { type: 'separator' },
          { label: english ? 'Back' : '后退', enabled: tab.snapshot.canGoBack, click: () => resolveSelection('back') },
          { label: english ? 'Forward' : '前进', enabled: tab.snapshot.canGoForward, click: () => resolveSelection('forward') },
          { label: english ? 'Reload' : '重新加载', click: () => resolveSelection('reload') },
          { label: english ? 'Stop loading' : '停止加载', enabled: tab.snapshot.loading, click: () => resolveSelection('stop') },
          { type: 'separator' },
          { label: english ? 'Find on page…' : '在页面中查找…', click: () => resolveSelection('find') },
          { label: tab.snapshot.translation ? (english ? 'Restore original' : '恢复原文') : english ? 'Translate to Chinese' : '中英对照', click: () => resolveSelection(tab.snapshot.translation ? 'restore_original' : 'translate') },
          { label: english ? 'Translation service' : '翻译服务', submenu: services },
          { label: english ? 'Copy page link' : '复制页面链接', enabled: tab.snapshot.url !== 'about:blank', click: () => resolveSelection('copy_url') },
          { label: english ? 'Open in default browser' : '在默认浏览器中打开', enabled: Boolean(normalizeExternalWebUrl(tab.snapshot.url)), click: () => resolveSelection('open_external') },
          {
            label: english ? `Zoom · ${zoom}%` : `页面缩放 · ${zoom}%`,
            submenu: [
              { label: english ? 'Zoom in' : '放大', enabled: zoom < 300, click: () => resolveSelection('zoom_in') },
              { label: english ? 'Zoom out' : '缩小', enabled: zoom > 50, click: () => resolveSelection('zoom_out') },
              { label: english ? 'Actual size · 100%' : '实际大小 · 100%', click: () => resolveSelection('zoom_reset') },
            ],
          },
          { label: english ? 'Developer tools' : '开发者工具', click: () => resolveSelection('devtools') },
          { type: 'separator' },
          { label: value.expanded ? (english ? 'Restore split view' : '恢复左右分栏') : english ? 'Expand browser' : '展开浏览器', enabled: value.canSplit === true, click: () => resolveSelection('toggle_expanded') },
          { label: english ? 'Reset split width' : '恢复默认分栏宽度', enabled: value.canSplit === true, click: () => resolveSelection('reset_size') },
          { label: english ? 'Close browser' : '关闭浏览器', click: () => resolveSelection('close') },
        ]);
        menu.popup({
          window,
          x: Math.min(bounds.width, Math.max(0, Math.round(finiteNumber(value.x, 0)))),
          y: Math.min(bounds.height, Math.max(0, Math.round(finiteNumber(value.y, 0)))),
          callback: () => resolveSelection(null),
        });
      });
    });
    ipcMain.handle('zeus:browser:open-tab', async (event, input: unknown) => {
      const window = this.requireRendererWindow(event);
      const value = asRecord(input);
      return this.openTab(window, {
        conversationId: requireNonEmptyString(value.conversationId, 'conversationId'),
        ...(typeof value.url === 'string' ? { url: value.url } : {}),
      });
    });
    /** 首发受理后迁移草稿网页；只允许当前窗口接管自己创建的草稿标签。 */
    ipcMain.handle('zeus:browser:adopt-draft', (event, input: unknown) => {
      /** 请求必须来自已注册的应用窗口。 */
      const window = this.requireRendererWindow(event);
      /** 草稿与真实会话身份分别校验，不接受空值或任意会话迁移。 */
      const value = asRecord(input);
      /** 只迁移浏览器草稿，已有会话不能从此入口重绑定。 */
      const source = requireNonEmptyString(value.sourceConversationId, 'sourceConversationId');
      /** 真实身份由会话首发的受理结果提供。 */
      const target = requireNonEmptyString(value.conversationId, 'conversationId');
      if (!source.startsWith('browser-draft-') || target.startsWith('browser-draft-')) throw new Error('Only a browser draft can be adopted by a conversation.');
      /** 先检查全部标签归属，避免部分迁移后才发现跨窗口冲突。 */
      const tabs = [...this.tabs.values()].filter((tab) => tab.snapshot.conversationId === source);
      if (tabs.some((tab) => tab.ownerWindowId !== undefined && tab.ownerWindowId !== window.id)) throw new Error('The browser draft belongs to another window.');
      if (tabs.length === 0) return this.snapshotFor(target);
      /** 首发中明确提交的批注才标记为已发送。 */
      const sent = new Set(Array.isArray(value.commentIds) ? value.commentIds.filter((id): id is string => typeof id === 'string') : []);
      /** 迁移保留原网页实例、标签顺序和当前选中项。 */
      const active = this.activeTabByConversation.get(source);
      for (const tab of tabs) {
        void this.cua.releaseTab(tab.snapshot.id).catch((error) => console.warn('CUA browser draft cleanup failed', error));
        tab.snapshot = { ...tab.snapshot, conversationId: target, comments: tab.snapshot.comments.map((comment) => ({ ...comment, conversationId: target, status: sent.has(comment.id) ? 'sent' : comment.status })) };
        this.syncPageComments(tab);
      }
      if (active) this.activeTabByConversation.set(target, active);
      this.activeTabByConversation.delete(source);
      for (const download of this.downloads) if (download.conversationId === source) download.conversationId = target;
      this.emitSnapshot(source);
      this.emitSnapshot(target);
      return this.snapshotFor(target);
    });
    ipcMain.handle('zeus:browser:activate-tab', async (event, input: unknown) => {
      const window = this.requireRendererWindow(event);
      const value = asRecord(input);
      return this.activateTab(window, requireNonEmptyString(value.conversationId, 'conversationId'), requireNonEmptyString(value.tabId, 'tabId'));
    });
    ipcMain.handle('zeus:browser:close-tab', async (event, input: unknown) => {
      const window = this.requireRendererWindow(event);
      const value = asRecord(input);
      await this.closeTab(window, requireNonEmptyString(value.conversationId, 'conversationId'), requireNonEmptyString(value.tabId, 'tabId'));
      return this.snapshotFor(requireNonEmptyString(value.conversationId, 'conversationId'));
    });
    // 明确关闭浏览器时释放当前会话的全部标签；切换工作面只隐藏视图。
    ipcMain.handle('zeus:browser:close-conversation', (event, conversationId: unknown) => {
      /** 关闭范围只取经过校验的会话身份和主进程实时标签。 */
      const window = this.requireRendererWindow(event);
      const id = requireNonEmptyString(conversationId, 'conversationId');
      this.pendingOpenRequests.delete(id);
      for (const tab of this.snapshotFor(id).tabs) this.closeTab(window, id, tab.id);
      return this.snapshotFor(id);
    });
    ipcMain.handle('zeus:browser:command', async (event, request: MainCommandRequest) => {
      const window = this.requireRendererWindow(event);
      return this.options.mainCommandLedger().execute(request, 'desktop.browser.command', async (input, command) => {
        const value = asRecord(input);
        const conversationId = requireNonEmptyString(value.conversationId, 'conversationId');
        const tabId = requireNonEmptyString(value.tabId, 'tabId');
        await command.markWriteStarted();
        await this.runManualCommand(window, conversationId, tabId, value.command as ZeusBrowserCommand);
        await this.flushPersistence();
        return this.snapshotFor(conversationId);
      });
    });
    ipcMain.handle('zeus:browser:set-layout', async (event, input: unknown) => {
      const window = this.requireRendererWindow(event);
      const value = asRecord(input);
      const conversationId = requireNonEmptyString(value.conversationId, 'conversationId');
      const tabId = requireNonEmptyString(value.tabId, 'tabId');
      const visible = value.visible === true;
      const bounds = normalizeBounds(value.bounds);
      /** 只捕获当前窗口正在展示的同一标签，不读取其他会话的页面。 */
      const tab = this.tabs.get(tabId);
      /** 截图与隐藏并行，不能让原生网页等待截图期间盖住弹窗。 */
      const preview =
        value.capturePreview === true && !visible && this.visibleTabByWindow.get(window.id) === tabId && tab?.snapshot.conversationId === conversationId && tab.view && !tab.view.webContents.isDestroyed()
          ? tab.view.webContents
              .capturePage(undefined, { stayHidden: true })
              .then((image) => (image.isEmpty() ? undefined : image.toDataURL()))
              .catch((error) => {
                console.warn('Browser overlay preview capture failed', error);
                return undefined;
              })
          : undefined;
      /** 布局继续使用原有会话校验及网页实例；截图不写入文件或持久状态。 */
      const applied = await this.setLayout(window, conversationId, tabId, bounds, visible);
      /** 一次遮挡只返回当前可视区画面，恢复后由 Renderer 释放。 */
      const previewImageUrl = await preview;
      return { applied, ...(previewImageUrl ? { previewImageUrl } : {}) };
    });
    ipcMain.handle('zeus:browser:prepare-comments', async (event, input: unknown) => {
      this.requireRendererWindow(event);
      const value = asRecord(input);
      return this.prepareComments(
        requireNonEmptyString(value.conversationId, 'conversationId'),
        requireNonEmptyString(value.tabId, 'tabId'),
        Array.isArray(value.commentIds) ? value.commentIds.filter((id): id is string => typeof id === 'string') : undefined,
      );
    });
    ipcMain.handle('zeus:browser:comment-preview', async (event, path: unknown) => {
      this.requireRendererWindow(event);
      return this.loadCommentPreview(path);
    });
    ipcMain.handle('zeus:browser:mark-comments-sent', async (event, request: MainCommandRequest) => {
      this.requireRendererWindow(event);
      return this.options.mainCommandLedger().execute(request, 'desktop.browser.mark_comments_sent', async (input, command) => {
        const value = asRecord(input);
        const conversationId = requireNonEmptyString(value.conversationId, 'conversationId');
        const tabId = requireNonEmptyString(value.tabId, 'tabId');
        const commentIds = Array.isArray(value.commentIds) ? value.commentIds.filter((id): id is string => typeof id === 'string') : [];
        await command.markWriteStarted();
        await this.markCommentsSent(conversationId, tabId, commentIds);
        return this.snapshotFor(conversationId);
      });
    });
    ipcMain.handle('zeus:browser:respond-approval', (event, request: MainCommandRequest) => {
      this.requireRendererWindow(event);
      return this.options.mainCommandLedger().execute(request, 'desktop.browser.respond_approval', async (input, command) => {
        const value = asRecord(input);
        const requestId = requireNonEmptyString(value.requestId, 'requestId');
        const decision = normalizeApprovalDecision(value.decision);
        await command.markWriteStarted();
        const result = this.respondToApproval(requestId, decision);
        await this.flushPersistence();
        return result;
      });
    });
    ipcMain.handle('zeus:browser:get-settings', (event) => {
      this.requireRendererWindow(event);
      return { ...this.settings };
    });
    ipcMain.handle('zeus:browser:list-passwords', (event) => {
      this.requireRendererWindow(event);
      return this.options.passwords.list();
    });
    ipcMain.handle('zeus:browser:prepare-password-import', async (event) => {
      const window = this.requireRendererWindow(event);
      this.assertWritableBrowserCapability();
      const picked = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Chrome CSV', extensions: ['csv'] }] });
      if (picked.canceled || !picked.filePaths[0] || window.isDestroyed()) return null;
      const preview = await this.options.passwords.prepare(window.id, picked.filePaths[0]);
      if (window.isDestroyed()) {
        this.options.passwords.cancel(window.id);
        return null;
      }
      return preview;
    });
    ipcMain.handle('zeus:browser:cancel-password-import', (event, token: unknown) => {
      this.options.passwords.cancel(this.requireRendererWindow(event).id, requireNonEmptyString(token, 'token'));
    });
    ipcMain.handle('zeus:browser:commit-password-import', (event, request: MainCommandRequest) => {
      const window = this.requireRendererWindow(event);
      return this.options.mainCommandLedger().execute(request, 'desktop.browser.import_passwords', async (input, command) => {
        this.assertWritableBrowserCapability();
        const value = asRecord(input);
        const choices = asRecord(value.choices);
        if (Object.values(choices).some((row) => !Number.isSafeInteger(row) || Number(row) < 0)) throw new Error('密码导入选择无效。');
        return this.options.passwords.commit(window.id, requireNonEmptyString(value.token, 'token'), choices as Record<string, number>, () => command.markWriteStarted());
      });
    });
    ipcMain.handle('zeus:browser:delete-password', (event, request: MainCommandRequest) => {
      this.requireRendererWindow(event);
      return this.options.mainCommandLedger().execute(request, 'desktop.browser.delete_password', async (input, command) => {
        this.assertWritableBrowserCapability();
        await this.options.passwords.remove(requireNonEmptyString(asRecord(input).id, 'id'), () => command.markWriteStarted());
        return { deleted: true };
      });
    });
    /** 各 frame 只读取自身的运行身份，凭据由原生菜单在用户选择后交接。 */
    ipcMain.handle('zeus:browser-page:autofill-runtime', (event) => {
      this.requirePageTab(event);
      this.assertWritableBrowserCapability();
      const origin = browserPasswordFrameOrigin(event.sender, event.senderFrame);
      if (!origin || !this.settings.enabled) return null;
      return { origin, language: this.options.language?.() ?? 'zh-CN', tabId: event.sender.id };
    });
    ipcMain.handle('zeus:browser-page:show-passwords', async (event, request: MainCommandRequest) => {
      const tab = this.requirePageTab(event);
      const frame = event.senderFrame;
      const origin = browserPasswordFrameOrigin(event.sender, frame);
      if (!frame || !origin) return;
      const window = tab.ownerWindowId ? this.windows.get(tab.ownerWindowId) : undefined;
      if (!window || this.visibleTabByWindow.get(window.id) !== tab.snapshot.id || !this.settings.enabled) return;
      const { documentId } = asRecord(request?.body);
      if (typeof documentId !== 'string') return;
      const generation = tab.documentGeneration;
      try {
        if (!(await this.options.passwords.list(origin)).length) return;
        await this.options.mainCommandLedger().execute(request, 'desktop.browser.autofill', async (_input, command) => {
          if (generation !== tab.documentGeneration || browserPasswordFrameOrigin(event.sender, frame) !== origin) return { completed: false };
          await this.showPasswordMenu(window, tab, frame, () => command.markWriteStarted(), documentId);
          return { completed: true };
        });
      } catch (error) {
        this.emitError(tab, error);
      }
    });
    ipcMain.handle('zeus:browser:update-settings', async (event, request: MainCommandRequest) => {
      this.requireRendererWindow(event);
      return this.options.mainCommandLedger().execute(request, 'desktop.browser.update_settings', async (input, command) => {
        await command.markWriteStarted();
        await this.updateSettings(input);
        await this.flushPersistence();
        return { ...this.settings };
      });
    });
    ipcMain.handle('zeus:browser:clear-data', async (event, request: MainCommandRequest) => {
      this.requireRendererWindow(event);
      return this.options.mainCommandLedger().execute(request, 'desktop.browser.clear_data', async (_body, command) => {
        await command.markWriteStarted();
        await this.clearBrowsingData();
        return { cleared: true };
      });
    });
    ipcMain.handle('zeus:browser:get-retired-runtime-state', async (event) => {
      this.requireRendererWindow(event);
      return this.options.retiredNativeRuntimeCleanup?.inspect() ?? { sourceRoot: '', entries: [], latestBackupRoot: null };
    });
    ipcMain.handle('zeus:browser:archive-retired-runtimes', async (event, request: MainCommandRequest) => {
      this.requireRendererWindow(event);
      return this.options.mainCommandLedger().execute(request, 'desktop.browser.archive_retired_runtimes', async (_body, command) => {
        this.assertWritableBrowserCapability();
        if (!this.options.retiredNativeRuntimeCleanup) throw new Error('旧 Browser/Computer runtime 清理服务不可用。');
        await command.markWriteStarted();
        return this.options.retiredNativeRuntimeCleanup.archive();
      });
    });
    ipcMain.handle('zeus:browser:restore-retired-runtimes', async (event, request: MainCommandRequest) => {
      this.requireRendererWindow(event);
      return this.options.mainCommandLedger().execute(request, 'desktop.browser.restore_retired_runtimes', async (_body, command) => {
        this.assertWritableBrowserCapability();
        if (!this.options.retiredNativeRuntimeCleanup) throw new Error('旧 Browser/Computer runtime 恢复服务不可用。');
        await command.markWriteStarted();
        return this.options.retiredNativeRuntimeCleanup.restoreLatest();
      });
    });
    ipcMain.handle('zeus:browser-page:translate', async (event, input: unknown) => {
      /** 仅当前顶层文档的隔离预加载可以请求已开启的翻译。 */
      const tab = this.requirePageTab(event);
      const value = asRecord(input);
      const run = tab.translation;
      this.assertWritableBrowserCapability();
      if (event.senderFrame !== event.sender.mainFrame || !run || value.runId !== run.id || run.controller.signal.aborted || run.busy || !this.options.translation || !validBrowserTranslationSegments(value.segments))
        throw new Error('当前页面翻译请求已失效。');
      run.busy = true;
      try {
        return { segments: await this.options.translation.translate(run.serviceId, value.segments, run.controller.signal) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : this.text('翻译失败，请重试。', 'Translation failed. Retry.') };
      } finally {
        run.busy = false;
      }
    });
    ipcMain.on('zeus:browser-page:translation-state', (event, input: unknown) => {
      /** 迟到的文档状态不能影响新页面或另一标签。 */
      const tab = this.tabFromWebContents(event.sender);
      const value = asRecord(input);
      if (!tab?.translation || event.senderFrame !== event.sender.mainFrame || value.runId !== tab.translation.id || !['working', 'ready', 'error'].includes(String(value.state)) || !tab.snapshot.translation) return;
      tab.snapshot = {
        ...tab.snapshot,
        translation: { state: value.state as 'working' | 'ready' | 'error', serviceLabel: tab.snapshot.translation.serviceLabel, ...(typeof value.message === 'string' ? { message: value.message.slice(0, 500) } : {}) },
      };
      this.emitSnapshot(tab.snapshot.conversationId);
    });
    ipcMain.handle('zeus:browser-page:get-state', (event) => {
      const tab = this.requirePageTab(event);
      return {
        comments: tab.snapshot.comments.filter((comment) => comment.status === 'draft'),
        annotationMode: tab.snapshot.annotationMode,
      };
    });
    ipcMain.handle('zeus:browser-page:set-annotation-mode', (event, enabled: unknown) => {
      const tab = this.requirePageTab(event);
      tab.snapshot = { ...tab.snapshot, annotationMode: enabled === true, updatedAt: this.now() };
      tab.view?.webContents.send('zeus-browser-page:command', {
        type: 'set_annotation_mode',
        enabled: tab.snapshot.annotationMode,
      });
      this.schedulePersist();
      this.emitSnapshot(tab.snapshot.conversationId);
      return { annotationMode: tab.snapshot.annotationMode };
    });
    ipcMain.handle('zeus:browser-page:save-comment', async (event, request: MainCommandRequest<BrowserPageCommentInput>) => {
      const tab = this.requirePageTab(event);
      return this.options.mainCommandLedger().execute(request, 'desktop.browser.save_comment', async (input, command) => {
        await command.markWriteStarted();
        const comment = await this.savePageComment(tab, input);
        await this.flushPersistence();
        // 评论落盘后才加入会话输入框；消息仍由用户在会话中发送。
        this.emit({ type: 'comments_saved', conversationId: tab.snapshot.conversationId, prepared: await this.prepareComments(tab.snapshot.conversationId, tab.snapshot.id, [comment.id]) });
        return comment;
      });
    });
    ipcMain.handle('zeus:browser-page:open-system-browser-link', async (event, input: unknown) => {
      this.requirePageTab(event);
      this.assertWritableBrowserCapability();
      const url = normalizeExternalWebUrl(input);
      if (!url) return { opened: false, error: 'external_url_not_allowed' };
      try {
        await this.options.openExternal(url);
        return { opened: true, url };
      } catch {
        return { opened: false, error: 'external_url_open_failed' };
      }
    });
  }

  getSettings(): ZeusBrowserSettings {
    return { ...this.settings };
  }

  async openConversationResource(
    window: BrowserWindow,
    input: {
      conversationId: string;
      url: string;
    },
  ): Promise<ZeusBrowserConversationSnapshot> {
    await this.openTab(window, input);
    this.emitOpenRequested(input.conversationId);
    return this.snapshotFor(input.conversationId);
  }

  async invoke(input: BrowserAutomationToolCall): Promise<{
    contentItems: BrowserAutomationContentItem[];
    success: boolean;
  }> {
    try {
      const result = await this.invokeAutomation(input);
      return { ...result, contentItems: result.contentItems.map((item) => (item.type === 'inputText' ? { ...item, text: this.redactPasswordText(item.text) } : item)) };
    } catch (error) {
      const message = this.redactPasswordText(error instanceof Error ? error.message : String(error), true);
      if (error instanceof Error && message === error.message) throw error;
      const detail = error as { code?: string; statusCode?: number; failClosed?: boolean } | null;
      throw Object.assign(new Error(message), { code: detail?.code, statusCode: detail?.statusCode, failClosed: detail?.failClosed });
    }
  }

  /** 所有自动化入口共用返回脱敏，不增加读取已保存密码的模型工具。 */
  private async invokeAutomation(input: BrowserAutomationToolCall): Promise<{
    contentItems: BrowserAutomationContentItem[];
    success: boolean;
  }> {
    if (input.namespace && input.namespace !== 'zeus_browser') return toolText(`Unsupported automation namespace for BrowserHost: ${input.namespace}`, false);
    if (!this.settings.enabled) return toolText('The Zeus built-in browser is disabled in Settings.', false);
    const args = input.arguments;
    if (input.tool === 'catalog') return this.invokeAdvancedCatalog(args);
    if (input.tool === 'release_handles') {
      await this.cua.endTurn(input.conversationId, input.turnId);
      return this.releaseAdvancedHandles(input);
    }
    if (input.tool === 'invoke' && !/^(?:get_browser_state|browser_)/u.test(String(args.path ?? ''))) return this.invokeAdvancedTool(input);
    if (input.tool === 'list_tabs') {
      return toolJson(
        this.snapshotFor(input.conversationId).tabs.map(({ id, title, url, loading }) => ({
          id,
          title,
          url,
          loading,
        })),
      );
    }
    if (input.tool === 'open') {
      const url = normalizeBrowserUrl(requireNonEmptyString(args.url, 'url'));
      this.assertAgentUrlAllowed(url);
      const window = this.preferredWindow(input.conversationId);
      const snapshot = await this.openConversationResource(window, { conversationId: input.conversationId, url });
      if (url !== 'about:blank' && snapshot.activeTabId) {
        await this.waitForTabReady(this.requireConversationTab(input.conversationId, snapshot.activeTabId), 30_000);
      }
      return toolJson({ tabId: snapshot.activeTabId, url });
    }
    if (input.tool === 'clipboard') return this.invokeClipboardTool(input);
    if (input.tool === 'downloads') {
      return toolJson(this.downloads.filter((download) => download.conversationId === input.conversationId).slice(-50));
    }
    if (input.tool === 'select_tab') {
      const selected = this.requireConversationTab(input.conversationId, requireNonEmptyString(args.tabId, 'tabId'));
      this.assertAgentUrlAllowed(selected.snapshot.url);
      const window = this.preferredWindow(input.conversationId);
      await this.activateTab(window, input.conversationId, selected.snapshot.id);
      this.emitOpenRequested(input.conversationId);
      return toolJson({ selected: selected.snapshot.id, url: selected.snapshot.url });
    }
    if (input.tool === 'close_tab') {
      const closing = this.requireConversationTab(input.conversationId, requireNonEmptyString(args.tabId, 'tabId'));
      await this.closeTab(this.preferredWindow(input.conversationId), input.conversationId, closing.snapshot.id);
      return toolJson({ closed: closing.snapshot.id });
    }

    const tab = await this.resolveToolTab(input.conversationId, optionalString(args.tabId));
    if (input.tool === 'navigate') {
      const url = normalizeBrowserUrl(requireNonEmptyString(args.url, 'url'));
      this.assertAgentUrlAllowed(url);
      await this.ensureView(tab).webContents.loadURL(url);
      await this.waitForTabReady(tab, 30_000);
      this.emitOpenRequested(input.conversationId);
      return toolJson({ tabId: tab.snapshot.id, url });
    }

    this.assertAgentUrlAllowed(tab.snapshot.url);
    this.emitOpenRequested(input.conversationId);
    if (['snapshot', 'element', 'click', 'type', 'press', 'scroll', 'screenshot', 'invoke'].includes(input.tool)) {
      return this.cua.invoke({ ...input, arguments: { ...input.arguments, tabId: tab.snapshot.id } }, this.cuaSurface(tab));
    }
    switch (input.tool) {
      case 'history': {
        const action = requireNonEmptyString(args.action, 'action');
        const result = await this.invokeHistoryTool(tab, action);
        if (action !== 'stop') await this.waitForTabReady(tab, 30_000);
        return result;
      }
      case 'wait':
        if (args.query !== undefined) return this.cua.wait({ ...input, arguments: { ...args, tabId: tab.snapshot.id } }, this.cuaSurface(tab));
        return this.invokeWaitTool(tab, args);
      case 'developer':
        return this.invokeDeveloperTool(input, tab);
      default:
        return toolText(`Unsupported Zeus browser tool: ${input.tool}`, false);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.options.passwords.dispose();
    await this.cua.close();
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timer);
      pending.resolve('deny');
    }
    this.pendingApprovals.clear();
    for (const tab of this.tabs.values()) {
      this.stopTranslation(tab);
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    if (!this.options.readOnlyValidation) await this.persist();
  }

  /** 私有传输先于 CUA worker 创建；只读验证模式不创建服务。 */
  async initializeCua(): Promise<void> {
    if (!this.options.readOnlyValidation) await this.cua.initialize();
  }

  /** 只供 Main 组装原生 worker 环境，不通过 IPC 或工具结果返回。 */
  getCuaEndpoint(): string | undefined {
    return this.cua.endpoint;
  }

  /** 轮次结束撤销控制，不关闭用户网页。 */
  async endComputerUse(input: { conversationId: string; turnId: string }): Promise<void> {
    await this.cua.endTurn(input.conversationId, input.turnId);
  }

  /** 实时读取宿主拥有的页面、窗口及布局，页面脚本不能提供这些身份。 */
  private cuaSurface(tab: LiveBrowserTab): BrowserCuaSurface {
    const contents = this.ensureView(tab).webContents;
    const conversationId = tab.snapshot.conversationId;
    const window = (): BrowserWindow => {
      if (this.tabs.get(tab.snapshot.id) !== tab || contents.isDestroyed()) throw new Error('浏览器标签已经关闭。');
      this.requireConversationTab(conversationId, tab.snapshot.id);
      const owner = tab.ownerWindowId === undefined ? undefined : this.windows.get(tab.ownerWindowId);
      if (!owner || owner.isDestroyed()) throw new Error('网页所属窗口已经失效，请重新打开该标签后观察。');
      return owner;
    };
    return {
      contents,
      window,
      bounds: () => tab.view!.getBounds(),
      visible: () => this.visibleTabByWindow.get(window().id) === tab.snapshot.id && window().isVisible() && !window().isMinimized(),
      pendingDialog: () => this.activeJsDialogs.get(tab.snapshot.id)?.parameters,
      allowUrl: (url) => this.assertAgentUrlAllowed(normalizeBrowserUrl(url)),
    };
  }

  /** 在 Main 资源就绪后恢复已持久化的外部浏览器连接；构造期间绝不写浏览器 manifest。 */
  async initializeExternalBrowsers(): Promise<void> {
    if (!this.options.configureExternalBrowsers || this.options.readOnlyValidation) return;
    const external = await this.options.configureExternalBrowsers(this.settings);
    this.settings = { ...this.settings, externalConnectionState: external.state, ...(external.detail ? { externalConnectionDetail: external.detail } : {}) };
    this.schedulePersist();
  }

  /** 旧文件中的标签和分组不再恢复，登录状态仍由独立浏览器资料保存。 */
  private restorePersistedState(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PersistedBrowserState>;
      if (parsed.version !== 1) return;
      this.settings = normalizeSettings(parsed.settings, this.settings);
      if (this.options.legacySystemDownloadDirectory && resolve(this.settings.downloadDirectory) === resolve(this.options.legacySystemDownloadDirectory)) {
        // 旧版本把系统“下载”目录当作内置浏览器默认值，会让普通设置操作也触发 macOS 文件夹授权。
        this.settings = { ...this.settings, downloadDirectory: resolve(this.options.defaultDownloadDirectory) };
      }
      for (const bookmark of parsed.managementBookmarks ?? []) {
        if (bookmark && typeof bookmark.id === 'string' && typeof bookmark.title === 'string') this.managementBookmarks.set(bookmark.id, bookmark);
      }
      for (const audit of parsed.managementAudit ?? []) {
        if (audit && typeof audit.id === 'string') this.managementAudit.push(audit);
      }
    } catch {
      // 首次启动或损坏的本机浏览器元数据都回退到空状态；Chromium profile 不在此文件中。
    }
  }

  private configureSession(): void {
    this.browserSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      if (!webContents || !this.tabFromWebContents(webContents)) return false;
      const origin = safeOrigin(requestingOrigin);
      return Boolean(origin && this.grantedWebPermissions.has(`${origin}\u0000${permission}`));
    });
    this.browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const tab = this.tabFromWebContents(webContents);
      if (!tab) {
        callback(false);
        return;
      }
      if (String(permission) === 'sensors') {
        // 与 Codex 内置浏览器保持一致：网页可以继续访问，但不能读取本机传感器，也不打断用户。
        callback(false);
        return;
      }
      const origin = safeOrigin(details.requestingUrl || tab.snapshot.url);
      void this.requestApproval({
        conversationId: tab.snapshot.conversationId,
        tabId: tab.snapshot.id,
        kind: 'web_permission',
        origin,
        title: this.text(`允许网页使用 ${permission} 权限吗？`, `Allow ${permission}?`),
        detail: this.text(`${origin || this.text('这个网页', 'This page')} 请求浏览器权限 ${permission}。`, `${origin || 'This page'} requested the ${permission} browser permission.`),
      }).then((decision) => {
        const allowed = decision !== 'deny';
        if (allowed && origin) this.grantedWebPermissions.add(`${origin}\u0000${permission}`);
        callback(allowed);
      });
    });
    this.browserSession.on('will-download', (_event, item, webContents) => {
      const tab = this.tabFromWebContents(webContents);
      if (!tab) return;
      const fileName = basename(item.getFilename());
      const download: BrowserDownload = {
        conversationId: tab.snapshot.conversationId,
        tabId: tab.snapshot.id,
        fileName,
        state: 'started',
        createdAt: this.now(),
      };
      this.downloads.push(download);
      if (!this.settings.askWhereToSave) {
        const target = join(this.settings.downloadDirectory, fileName);
        item.setSavePath(target);
        download.path = target;
      } else {
        item.pause();
        void dialog
          .showSaveDialog(this.preferredWindow(tab.snapshot.conversationId), {
            title: this.text('保存下载文件', 'Save browser download'),
            defaultPath: join(this.settings.downloadDirectory, fileName),
          })
          .then((result) => {
            if (result.canceled || !result.filePath) {
              item.cancel();
              return;
            }
            download.path = result.filePath;
            item.setSavePath(result.filePath);
            item.resume();
          });
      }
      this.emitDownload(download);
      item.once('done', (_downloadEvent, state) => {
        download.state = state === 'completed' ? 'completed' : 'failed';
        this.emitDownload(download);
      });
    });
  }

  private requireRendererWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || !this.windows.has(window.id)) throw new Error('Browser request came from an untrusted Zeus window.');
    return window;
  }

  private requirePageTab(event: IpcMainInvokeEvent): LiveBrowserTab {
    const tab = this.tabFromWebContents(event.sender);
    if (!tab) throw new Error('Browser page request came from an untrusted WebContents.');
    return tab;
  }

  private preferredWindow(conversationId: string): BrowserWindow {
    const ownedTab = [...this.tabs.values()].find((tab) => tab.snapshot.conversationId === conversationId && tab.ownerWindowId && this.windows.has(tab.ownerWindowId));
    const preferred = ownedTab?.ownerWindowId ? this.windows.get(ownedTab.ownerWindowId) : undefined;
    const window = preferred ?? BrowserWindow.getFocusedWindow() ?? [...this.windows.values()][0];
    if (!window || window.isDestroyed()) throw new Error('No Zeus window is available for the built-in browser.');
    return window;
  }

  /** 同一会话中的相同地址复用标签并重新加载，空白页仍允许主动新建。 */
  private async openTab(
    window: BrowserWindow,
    input: {
      conversationId: string;
      url?: string;
    },
  ): Promise<ZeusBrowserConversationSnapshot> {
    if (!this.settings.enabled) throw new Error('The built-in browser is disabled in Settings.');
    /** 沿用统一地址校验与规范化，保留查询参数和锚点的页面语义。 */
    const url = input.url ? normalizeBrowserUrl(input.url) : 'about:blank';
    /** 在首次异步加载前登记标签，连续点击也只会命中同一实例。 */
    const existing = url === 'about:blank' ? undefined : [...this.tabs.values()].find((candidate) => candidate.snapshot.conversationId === input.conversationId && candidate.snapshot.url === url);
    /** 已打开标签沿用原身份和批注。 */
    const id = existing?.snapshot.id ?? `browser-tab-${randomUUID()}`;
    /** 新建与刷新共用加载、持久化和界面通知流程。 */
    const tab: LiveBrowserTab = existing ?? {
      snapshot: {
        ...emptyTabSnapshot({ id, conversationId: input.conversationId, url, now: this.now() }),
        loading: url !== 'about:blank',
      },
      ownerWindowId: window.id,
      documentGeneration: 1,
      consoleLogs: [],
    };
    if (tab.ownerWindowId !== undefined && tab.ownerWindowId !== window.id) this.detachTab(id);
    tab.ownerWindowId = window.id;
    tab.snapshot = { ...tab.snapshot, loading: url !== 'about:blank', updatedAt: this.now() };
    this.tabs.set(id, tab);
    this.activeTabByConversation.set(input.conversationId, id);
    const view = this.ensureView(tab, false);
    this.schedulePersist();
    this.emitSnapshot(input.conversationId);
    // 空白页也必须导航才能初始化文档；标签先可交互，加载继续走原生网页生命周期。
    void loadUserFacingBrowserUrl(view.webContents, url).then(() => {
      if (this.tabs.get(id) !== tab || view.webContents.isDestroyed()) return;
      // 连续刷新可能终止上一轮导航，加载状态始终以当前网页为准。
      tab.snapshot = { ...tab.snapshot, loading: view.webContents.isLoading(), updatedAt: this.now() };
      this.schedulePersist();
      this.emitSnapshot(input.conversationId);
    });
    return this.snapshotFor(input.conversationId);
  }

  private async activateTab(window: BrowserWindow, conversationId: string, tabId: string): Promise<ZeusBrowserConversationSnapshot> {
    const tab = this.requireConversationTab(conversationId, tabId);
    if (tab.ownerWindowId !== undefined && tab.ownerWindowId !== window.id) this.detachTab(tabId);
    tab.ownerWindowId = window.id;
    this.activeTabByConversation.set(conversationId, tabId);
    this.ensureView(tab);
    this.schedulePersist();
    this.emitSnapshot(conversationId);
    return this.snapshotFor(conversationId);
  }

  /** 同步释放标签，批量关闭期间不让新标签穿插进入清理范围。 */
  private closeTab(window: BrowserWindow, conversationId: string, tabId: string): void {
    const tab = this.requireConversationTab(conversationId, tabId);
    void this.cua.releaseTab(tabId).catch((error) => console.warn('CUA browser cleanup failed', error));
    /** 只有被关闭网页持有焦点时才把焦点交给下一网页。 */
    const focusedBounds = this.visibleTabByWindow.get(window.id) === tabId && this.isVisibleTabFocused(window) ? tab.view!.getBounds() : null;
    this.stopTranslation(tab);
    if (this.visibleTabByWindow.get(window.id) === tabId) this.detachTab(tabId);
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.tabs.delete(tabId);
    this.invalidateAdvancedHandlesForTab(tabId);
    for (const key of [...this.advancedTabClaims.keys()]) {
      if (this.advancedTabClaims.get(key)?.tabId === tabId) this.advancedTabClaims.delete(key);
    }
    const remaining = [...this.tabs.values()].filter((candidate) => candidate.snapshot.conversationId === conversationId);
    const next = remaining.at(-1)?.snapshot.id ?? null;
    if (next) this.activeTabByConversation.set(conversationId, next);
    else {
      this.activeTabByConversation.delete(conversationId);
      this.pendingOpenRequests.delete(conversationId);
    }
    if (next && focusedBounds) {
      // 在本次原生命令内完成页面和焦点交接，下一次 Cmd/Ctrl+W 仍有标签目标。
      // setLayout 在返回 Promise 前完成挂载；失败仍沿用浏览器的可见错误通道。
      void this.setLayout(window, conversationId, next, focusedBounds, true).catch((error) => this.emitError(tab, error));
      this.tabs.get(next)?.view?.webContents.focus();
    }
    this.schedulePersist();
    this.emitSnapshot(conversationId);
  }

  /** 关闭后的迟到布局请求直接失效，存活标签仍须通过会话归属校验。 */
  private async setLayout(window: BrowserWindow, conversationId: string, tabId: string, bounds: Rectangle, visible: boolean): Promise<boolean> {
    // 工具关闭标签先于界面收到快照，已排队的尺寸和浮层回调不再有可布局的目标。
    if (!this.tabs.has(tabId)) return false;
    // 存活标签继续复用共享校验，不能将真正的跨会话访问当成关闭处理。
    const tab = this.requireConversationTab(conversationId, tabId);
    // 清理旧标签只影响它自己，避免迟到的隐藏请求移除刚切换的新标签。
    const previous = this.visibleTabByWindow.get(window.id);
    if (!visible) {
      if (previous === tabId) this.detachTab(tabId);
      return true;
    }
    if (!this.settings.enabled) throw new Error('The built-in browser is disabled in Settings.');
    if (previous && previous !== tabId) this.detachTab(previous);
    if (tab.ownerWindowId !== undefined && tab.ownerWindowId !== window.id) this.detachTab(tabId);
    const view = this.ensureView(tab);
    const previousBounds = view.getBounds();
    if (previousBounds.x !== bounds.x || previousBounds.y !== bounds.y || previousBounds.width !== bounds.width || previousBounds.height !== bounds.height) {
      void this.cua.hideTabCursor(tabId).catch((error) => console.warn('CUA browser layout cleanup failed', error));
    }
    tab.ownerWindowId = window.id;
    if (this.visibleTabByWindow.get(window.id) !== tabId) {
      window.contentView.addChildView(view);
      this.visibleTabByWindow.set(window.id, tabId);
    }
    view.setBounds(bounds);
    view.setVisible(true);
    if (this.activeTabByConversation.get(conversationId) === tabId) this.pendingOpenRequests.delete(conversationId);
    return true;
  }

  private detachTab(tabId: string): void {
    void this.cua.hideTabCursor(tabId).catch((error) => console.warn('CUA browser visibility cleanup failed', error));
    const tab = this.tabs.get(tabId);
    if (!tab?.view || tab.ownerWindowId === undefined) return;
    const window = this.windows.get(tab.ownerWindowId);
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(tab.view);
      } catch {
        // 已从窗口移除时保持幂等。
      }
    }
    tab.view.setVisible(false);
    if (this.visibleTabByWindow.get(tab.ownerWindowId) === tabId) this.visibleTabByWindow.delete(tab.ownerWindowId);
  }

  private ensureView(tab: LiveBrowserTab, loadSnapshotUrl = true): WebContentsView {
    if (this.options.readOnlyValidation) {
      throw Object.assign(new Error('只读验证模式禁止创建浏览器 WebContentsView 或访问网页。'), {
        code: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
        statusCode: 503,
      });
    }
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view;
    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession,
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // Electron 用此选项把沙箱 preload 和 IPC 分发到子 frame。
        nodeIntegrationInSubFrames: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    /** 未挂载标签也有真实离屏 viewport；显示后仍由 renderer 提供实际浏览器布局。 */
    const owner = tab.ownerWindowId === undefined ? undefined : this.windows.get(tab.ownerWindowId);
    if (owner && !owner.isDestroyed()) {
      const { width, height } = owner.getContentBounds();
      view.setBounds({ x: 0, y: 0, width, height });
    }
    view.setVisible(false);
    tab.view = view;
    tab.findText = undefined;
    view.setBackgroundColor('#f8f9fb');
    const update = (): void => {
      if (view.webContents.isDestroyed()) return;
      tab.snapshot = {
        ...tab.snapshot,
        url: view.webContents.getURL() || tab.snapshot.url,
        title: view.webContents.getTitle() || tab.snapshot.title,
        loading: view.webContents.isLoading(),
        canGoBack: view.webContents.navigationHistory.canGoBack(),
        canGoForward: view.webContents.navigationHistory.canGoForward(),
        crashed: false,
        updatedAt: this.now(),
      };
      this.schedulePersist();
      this.emitSnapshot(tab.snapshot.conversationId);
    };
    view.webContents.on('did-start-loading', update);
    view.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      void this.cua.hideTabCursor(tab.snapshot.id).catch((error) => console.warn('CUA browser navigation cursor cleanup failed', error));
      this.stopTranslation(tab);
      tab.pagePreloadFailed = false;
      tab.findText = undefined;
      tab.documentGeneration += 1;
      this.invalidateAdvancedHandlesForTab(tab.snapshot.id);
    });
    view.webContents.on('did-stop-loading', update);
    view.webContents.on('did-navigate', update);
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      // 路由变化停止翻译；同页锚点滚动保留已开启的阅读状态。
      if (isMainFrame && url.split('#')[0] !== tab.snapshot.url.split('#')[0]) this.stopTranslation(tab);
      update();
    });
    view.webContents.on('page-title-updated', update);
    view.webContents.on('preload-error', (_event, preloadPath, error) => {
      tab.pagePreloadFailed = true;
      tab.consoleLogs.push({ level: 3, message: String(error.message).slice(0, 20_000), line: 0, sourceId: preloadPath, createdAt: this.now() });
      if (tab.consoleLogs.length > 500) tab.consoleLogs.splice(0, tab.consoleLogs.length - 500);
      if (tab.translation && tab.snapshot.translation) {
        tab.translation.controller.abort();
        tab.snapshot = { ...tab.snapshot, translation: { ...tab.snapshot.translation, state: 'error', message: this.text('页面功能加载失败，请重新加载网页。', 'Page features failed to load. Reload the page.') } };
        this.emitSnapshot(tab.snapshot.conversationId);
      }
    });
    view.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      tab.consoleLogs.push({ level, message: this.redactPasswordText(String(message), true).slice(0, 20_000), line, sourceId: this.redactPasswordText(String(sourceId), true).slice(0, 4_000), createdAt: this.now() });
      if (tab.consoleLogs.length > 500) tab.consoleLogs.splice(0, tab.consoleLogs.length - 500);
    });
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      tab.snapshot = { ...tab.snapshot, ...(favicons[0] ? { faviconUrl: favicons[0] } : {}), updatedAt: this.now() };
      this.emitSnapshot(tab.snapshot.conversationId);
    });
    view.webContents.on('dom-ready', () => {
      this.syncPageComments(tab);
      update();
    });
    view.webContents.on('did-finish-load', () => {
      this.syncPageComments(tab);
      update();
    });
    view.webContents.on('render-process-gone', () => {
      void this.cua.releaseTab(tab.snapshot.id).catch((error) => console.warn('CUA browser cleanup failed', error));
      this.stopTranslation(tab);
      this.activeJsDialogs.delete(tab.snapshot.id);
      tab.snapshot = { ...tab.snapshot, crashed: true, loading: false, updatedAt: this.now() };
      this.emitSnapshot(tab.snapshot.conversationId);
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      const ownerWindow = tab.ownerWindowId ? this.windows.get(tab.ownerWindowId) : undefined;
      if (ownerWindow && !ownerWindow.isDestroyed())
        void this.openTab(ownerWindow, {
          conversationId: tab.snapshot.conversationId,
          url,
        });
      return { action: 'deny' };
    });
    void this.ensureCdpMonitor(tab)
      .then((debuggerApi) => debuggerApi.sendCommand('Page.enable'))
      .catch((error) => {
        tab.consoleLogs.push({ level: 2, message: `Zeus dialog monitor unavailable: ${error instanceof Error ? error.message : String(error)}`, line: 0, sourceId: 'zeus-browser', createdAt: this.now() });
      });
    // 恢复持久化空白标签时，同样建立可读取的文档和预加载环境。
    if (loadSnapshotUrl && tab.snapshot.url) {
      void loadUserFacingBrowserUrl(view.webContents, tab.snapshot.url);
    }
    return view;
  }

  /** 显式选择和焦点触发共用原生菜单，始终填回同一个 frame 文档。 */
  private async showPasswordMenu(window: BrowserWindow, tab: LiveBrowserTab, frame: WebFrameMain, beforeFill?: () => Promise<void>, requestedDocumentId?: string): Promise<void> {
    this.assertWritableBrowserCapability();
    const contents = this.ensureView(tab).webContents;
    const origin = browserPasswordFrameOrigin(contents, frame);
    const quiet = requestedDocumentId !== undefined;
    if (!origin) {
      if (quiet) return;
      throw new Error(this.text('当前页面不支持密码填充。', 'Password filling is unavailable on this page.'));
    }
    const generation = tab.documentGeneration;
    /** 异步查询或等待选择期间，切页、换标签或关闭窗口都使请求失效。 */
    const isCurrent = (): boolean =>
      this.settings.enabled && !window.isDestroyed() && this.visibleTabByWindow.get(window.id) === tab.snapshot.id && tab.documentGeneration === generation && browserPasswordFrameOrigin(contents, frame) === origin;
    const accounts = await this.options.passwords.list(origin);
    if (!isCurrent()) return;
    if (!accounts.length && quiet) return;
    let documentId: unknown;
    if (accounts.length) {
      const reply = (await requestBrowserPasswordFrame(frame, { action: 'probe', origin })) as { documentId?: unknown } | null;
      documentId = reply?.documentId;
      if (!isCurrent() || (quiet && documentId !== requestedDocumentId)) return;
      if (typeof documentId !== 'string') {
        if (quiet) return;
        throw new Error(this.text('自动填充尚未就绪，或页面没有可填充的登录框。', 'Autofill is not ready, or no supported sign-in field was found.'));
      }
    }
    const selected = await new Promise<string | null>((resolveSelection) => {
      const menu = new Menu();
      if (accounts.length && origin !== contents.mainFrame.origin) menu.append(new MenuItem({ label: origin, enabled: false }));
      for (const account of accounts) menu.append(new MenuItem({ label: (account.username || this.text('无用户名', 'No username')).replace(/&/gu, '&&').slice(0, 240), click: () => resolveSelection(account.id) }));
      if (!accounts.length) menu.append(new MenuItem({ label: this.text('此站点没有已保存的密码', 'No saved passwords for this site'), enabled: false }));
      menu.popup({ window, callback: () => resolveSelection(null) });
    });
    if (!selected || typeof documentId !== 'string' || !isCurrent()) return;
    const credential = await this.options.passwords.credential(origin, selected);
    if (!isCurrent()) return;
    if (!credential) throw new Error(this.text('该账号已删除，请重新选择。', 'This account was deleted. Select an account again.'));
    await beforeFill?.();
    if (!isCurrent()) return;
    const { id, username, password } = credential;
    (tab.passwordValues ??= new Set()).add(password);
    const status = await requestBrowserPasswordFrame(frame, { action: 'fill', origin, documentId, selection: { id, username, password } });
    if (!isCurrent()) return;
    if (status === 'filled') return;
    if (status === 'unavailable') throw new Error(this.text('自动填充组件尚未就绪，请在页面加载后重试。', 'Autofill is not ready. Try again after the page loads.'));
    if (status === 'page_changed') throw new Error(this.text('页面已变化，请重新选择账号。', 'The page changed. Select an account again.'));
    throw new Error(
      status === 'multiple_forms' ? this.text('页面有多个登录表单，请先点击要填充的登录框。', 'Focus the sign-in field in the form you want to fill.') : this.text('未找到可填充的登录框。', 'No supported sign-in field was found.'),
    );
  }

  /** 已填密码从所有浏览器工具文字结果及网页控制台中移除。 */
  private redactPasswordText(text: string, includeShortFragments = false): string {
    const values = [...new Set([...this.tabs.values()].flatMap((tab) => [...(tab.passwordValues ?? [])]))];
    if (!values.length) return text;
    /** 先解析 JSON 再替换字符串，避免破坏数字、布尔值或转义字符。 */
    const scrub = (value: unknown): unknown => {
      /** 短密码只替换完整工具值，避免把 e1 等定位引用改坏；日志可过滤短片段。 */
      if (typeof value === 'string') return values.reduce((result, password) => (result === password || password.length >= 4 || includeShortFragments ? result.split(password).join('[redacted]') : result), value);
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, scrub(nested)]));
      return value;
    };
    try {
      return JSON.stringify(scrub(JSON.parse(text)));
    } catch {
      return scrub(text) as string;
    }
  }

  private async runManualCommand(window: BrowserWindow, conversationId: string, tabId: string, command: ZeusBrowserCommand): Promise<void> {
    if (!this.settings.enabled) throw new Error('The built-in browser is disabled in Settings.');
    const tab = this.requireConversationTab(conversationId, tabId);
    if (tab.ownerWindowId !== undefined && tab.ownerWindowId !== window.id) this.detachTab(tabId);
    tab.ownerWindowId = window.id;
    const view = this.ensureView(tab);
    if (!command || typeof command !== 'object' || typeof command.action !== 'string') throw new TypeError('Browser command is invalid.');
    switch (command.action) {
      case 'autofill':
        await this.showPasswordMenu(window, tab, view.webContents.focusedFrame ?? view.webContents.mainFrame);
        break;
      case 'navigate':
        await loadUserFacingBrowserUrl(view.webContents, normalizeBrowserUrl(command.url));
        break;
      case 'back':
        if (view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
        break;
      case 'forward':
        if (view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
        break;
      case 'reload':
        view.webContents.reload();
        break;
      case 'stop':
        view.webContents.stop();
        break;
      case 'find':
        if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 1000) throw new TypeError('查找内容必须为 1 至 1000 个字符。');
        view.webContents.findInPage(command.text, { forward: command.forward !== false, findNext: tab.findText !== command.text });
        tab.findText = command.text;
        break;
      case 'stop_find':
        view.webContents.stopFindInPage('clearSelection');
        tab.findText = undefined;
        break;
      case 'translate':
        await this.startTranslation(tab);
        break;
      case 'translation_google':
      case 'translation_microsoft':
        await this.selectTranslationService(tab, command.action === 'translation_google' ? 'free:google' : 'free:microsoft');
        break;
      case 'translation_service': {
        if (typeof command.serviceId !== 'string' || !command.serviceId || command.serviceId.length > 2000) throw new TypeError('翻译服务身份无效。');
        /** 重新核对模型目录，不接受已删除或未启用的模型身份。 */
        if (!isFreeBrowserTranslationService(command.serviceId)) {
          if (!this.options.translation) throw new Error(this.text('翻译服务不可用。', 'Translation is unavailable.'));
          const generation = tab.documentGeneration;
          const models = await this.options.translation.models(AbortSignal.timeout(30_000), command.serviceId);
          if (generation !== tab.documentGeneration || !tab.view || tab.view.webContents.isDestroyed()) return;
          if (!models.items.some((item) => item.id === command.serviceId)) throw new Error(this.text('翻译模型不可用，请重新选择。', 'The translation model is unavailable. Choose another model.'));
        }
        await this.selectTranslationService(tab, command.serviceId);
        break;
      }
      case 'restore_original':
        this.stopTranslation(tab);
        break;
      case 'copy_url':
        clipboard.writeText(tab.snapshot.url);
        break;
      case 'open_external': {
        /** 外部打开仍只允许无内嵌凭据的网页地址。 */
        const url = normalizeExternalWebUrl(tab.snapshot.url);
        if (!url) throw new TypeError('当前地址不能在默认浏览器中打开。');
        await this.options.openExternal(url);
        break;
      }
      case 'zoom_in':
      case 'zoom_out':
        view.webContents.setZoomFactor(Math.min(3, Math.max(0.5, Math.round((view.webContents.getZoomFactor() + (command.action === 'zoom_in' ? 0.1 : -0.1)) * 10) / 10)));
        break;
      case 'zoom_reset':
        view.webContents.setZoomFactor(1);
        break;
      case 'devtools':
        view.webContents.openDevTools({ mode: 'detach' });
        break;
      case 'set_annotation_mode':
        tab.snapshot = { ...tab.snapshot, annotationMode: command.enabled, updatedAt: this.now() };
        view.webContents.send('zeus-browser-page:command', { type: 'set_annotation_mode', enabled: command.enabled });
        this.emitSnapshot(conversationId);
        break;
      case 'clear_comments': {
        const draftComments = tab.snapshot.comments.filter((comment) => comment.status === 'draft');
        if (!draftComments.length) return;
        tab.snapshot = {
          ...tab.snapshot,
          comments: tab.snapshot.comments.filter((comment) => comment.status !== 'draft'),
          updatedAt: this.now(),
        };
        await Promise.all(draftComments.map((comment) => (comment.screenshotPath ? unlink(comment.screenshotPath).catch(() => undefined) : Promise.resolve())));
        this.syncPageComments(tab);
        this.schedulePersist();
        this.emitSnapshot(conversationId);
        this.emit({ type: 'comments_removed', conversationId, commentIds: draftComments.map((comment) => comment.id) });
        break;
      }
      case 'delete_comment': {
        const comment = tab.snapshot.comments.find((candidate) => candidate.id === command.commentId && candidate.status === 'draft');
        if (!comment) return;
        tab.snapshot = {
          ...tab.snapshot,
          comments: tab.snapshot.comments.filter((candidate) => candidate.id !== command.commentId),
          updatedAt: this.now(),
        };
        if (comment.screenshotPath) await unlink(comment.screenshotPath).catch(() => undefined);
        this.syncPageComments(tab);
        this.schedulePersist();
        this.emitSnapshot(conversationId);
        this.emit({ type: 'comments_removed', conversationId, commentIds: [comment.id] });
        break;
      }
      case 'focus_comment':
        view.webContents.send('zeus-browser-page:command', { type: 'focus_comment', commentId: command.commentId });
        break;
      default:
        throw new TypeError('不支持的浏览器操作。');
    }
  }

  /** 选择服务先保存设置；当前是已加载网页时立即用新服务重新翻译。 */
  private async selectTranslationService(tab: LiveBrowserTab, serviceId: string): Promise<void> {
    this.assertWritableBrowserCapability();
    this.settings = { ...this.settings, translationServiceId: serviceId };
    this.schedulePersist();
    if (!tab.snapshot.loading && /^(https?:|file:)/u.test(tab.snapshot.url)) await this.startTranslation(tab);
  }

  /** 打开服务选择时读取当前目录，页面关闭或导航后取消读取。 */
  private async loadTranslationServices(window: BrowserWindow, tab: LiveBrowserTab, source: 'codex' | 'custom') {
    this.assertWritableBrowserCapability();
    if (!this.options.translation || !tab.view) throw new Error(this.text('翻译服务不可用。', 'Translation is unavailable.'));
    const contents = tab.view.webContents;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    contents.once('did-start-navigation', cancel);
    contents.once('destroyed', cancel);
    window.once('closed', cancel);
    try {
      const models = await this.options.translation.models(AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), undefined, source);
      controller.signal.throwIfAborted();
      return { ...models, selectedId: this.settings.translationServiceId ?? defaultBrowserTranslationService };
    } finally {
      contents.off('did-start-navigation', cancel);
      contents.off('destroyed', cancel);
      window.off('closed', cancel);
    }
  }

  /** 开启当前选择的服务；默认免费服务不读取模型目录或要求模型登录。 */
  private async startTranslation(tab: LiveBrowserTab): Promise<void> {
    this.assertWritableBrowserCapability();
    if (!this.options.translation) throw new Error(this.text('翻译服务不可用。', 'Translation is unavailable.'));
    if (tab.snapshot.loading || !/^(https?:|file:)/u.test(tab.snapshot.url)) throw new Error(this.text('请在网页加载完成后开启中英对照。', 'Open a webpage and wait for it to load.'));
    if (tab.pagePreloadFailed) throw new Error(this.text('页面功能加载失败，请重新加载网页。', 'Page features failed to load. Reload the page.'));
    this.stopTranslation(tab);
    /** 未设置过服务的新用户直接使用免费翻译。 */
    const serviceId = this.settings.translationServiceId ?? defaultBrowserTranslationService;
    /** 换页或关闭立即取消服务准备和当前请求。 */
    const run = { id: randomUUID(), serviceId, controller: new AbortController(), busy: false };
    tab.translation = run;
    tab.snapshot = { ...tab.snapshot, translation: { state: 'working', serviceLabel: '' } };
    this.emitSnapshot(tab.snapshot.conversationId);
    try {
      /** 免费服务名称固定；AI 服务从当前目录获取显示名称。 */
      let label: string;
      if (isFreeBrowserTranslationService(serviceId)) {
        label = serviceId === 'free:microsoft' ? this.text('微软翻译 · 免费', 'Microsoft · Free') : this.text('Google 翻译 · 免费', 'Google · Free');
      } else {
        /** 只核对已选模型，不初始化无关供应商。 */
        const models = await this.options.translation.models(AbortSignal.any([run.controller.signal, AbortSignal.timeout(30_000)]), serviceId);
        /** 用户删除或禁用的模型不能自动替换为其他模型。 */
        const selected = models.items.find((entry) => entry.id === serviceId);
        if (!selected) throw new Error(this.text('翻译模型不可用，请在翻译服务菜单中重新选择。', 'The translation model is unavailable. Choose another translation service.'));
        label = selected.label;
      }
      if (run.controller.signal.aborted || tab.translation !== run) return;
      tab.snapshot = { ...tab.snapshot, translation: { state: 'working', serviceLabel: label } };
      tab.view!.webContents.send('zeus-browser-page:command', { type: 'start_translation', runId: run.id, serviceId });
      this.emitSnapshot(tab.snapshot.conversationId);
    } catch (error) {
      if (tab.translation !== run) return;
      this.stopTranslation(tab);
      throw error;
    }
  }

  /** 停止服务请求并清除译文；不改变原始 DOM 和已有批注。 */
  private stopTranslation(tab: LiveBrowserTab): void {
    if (!tab.translation && !tab.snapshot.translation) return;
    tab.translation?.controller.abort();
    tab.translation = undefined;
    tab.snapshot = { ...tab.snapshot, translation: undefined };
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.send('zeus-browser-page:command', { type: 'stop_translation' });
    this.emitSnapshot(tab.snapshot.conversationId);
  }

  private async savePageComment(tab: LiveBrowserTab, input: BrowserPageCommentInput): Promise<ZeusBrowserComment> {
    this.assertWritableBrowserCapability();
    /** 只允许更新当前标签中仍未发送的评论。 */
    const existing = typeof input.commentId === 'string' ? tab.snapshot.comments.find((comment) => comment.id === input.commentId && comment.status === 'draft') : undefined;
    if (input.commentId !== undefined && !existing) throw new Error('This comment is no longer available for editing.');
    if (!existing && tab.snapshot.comments.filter((comment) => comment.status === 'draft').length >= maxDraftCommentsPerTab) throw new Error('This browser tab already has the maximum number of draft comments.');
    const body = typeof input.body === 'string' ? input.body.trim().slice(0, maxCommentBodyLength) : '';
    if (!body) throw new Error('Browser comment text is required.');
    const anchor = normalizePageAnchor(input.anchor);
    const designChanges = normalizeDesignChanges(input.designChanges);
    const timestamp = this.now();
    const comment: ZeusBrowserComment = {
      id: existing?.id ?? `browser-comment-${randomUUID()}`,
      number: existing?.number ?? nextCommentNumber(tab.snapshot.comments),
      conversationId: tab.snapshot.conversationId,
      tabId: tab.snapshot.id,
      body,
      anchor,
      designChanges,
      status: 'draft',
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(existing?.screenshotPath ? { screenshotPath: existing.screenshotPath } : {}),
    };
    tab.snapshot = { ...tab.snapshot, comments: existing ? tab.snapshot.comments.map((candidate) => (candidate.id === existing.id ? comment : candidate)) : [...tab.snapshot.comments, comment], updatedAt: timestamp };
    this.syncPageComments(tab);
    const shouldCapture = this.settings.screenshotMode === 'always' || anchor.kind === 'region' || designChanges.length > 0;
    if (shouldCapture && tab.view && !tab.view.webContents.isDestroyed()) {
      try {
        await mkdir(this.attachmentRoot, { recursive: true, mode: 0o700 });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
        const screenshotPath = join(this.attachmentRoot, `${comment.id}.png`);
        const temporaryPath = join(this.attachmentRoot, `.${comment.id}.${randomUUID()}.tmp`);
        const image = await tab.view.webContents.capturePage();
        const screenshot = await open(temporaryPath, 'wx', 0o600);
        try {
          await screenshot.writeFile(image.toPNG());
          await screenshot.sync();
        } finally {
          await screenshot.close();
        }
        await publishFile(temporaryPath, screenshotPath, { replace: true });
        comment.screenshotPath = screenshotPath;
        comment.updatedAt = this.now();
        tab.snapshot = {
          ...tab.snapshot,
          comments: tab.snapshot.comments.map((candidate) => (candidate.id === comment.id ? { ...comment } : candidate)),
          updatedAt: comment.updatedAt,
        };
      } catch (error) {
        this.emitError(tab, new Error(`The comment was saved, but its screenshot could not be captured: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    this.schedulePersist();
    this.emitSnapshot(tab.snapshot.conversationId);
    return { ...comment };
  }

  private async loadCommentPreview(pathValue: unknown): Promise<{
    previewUrl: string;
    mimeType: 'image/png';
  } | null> {
    if (typeof pathValue !== 'string' || !pathValue) return null;
    try {
      const [rootPath, candidatePath] = await Promise.all([realpath(this.attachmentRoot), realpath(pathValue)]);
      const relativePath = relative(rootPath, candidatePath);
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
      const file = await stat(candidatePath);
      if (!file.isFile() || file.size <= 0 || file.size > 30 * 1024 * 1024 || !candidatePath.toLowerCase().endsWith('.png')) return null;
      const data = await readFile(candidatePath);
      return { previewUrl: `data:image/png;base64,${data.toString('base64')}`, mimeType: 'image/png' };
    } catch {
      return null;
    }
  }

  private async prepareComments(conversationId: string, tabId: string, requestedIds?: string[]): Promise<ZeusBrowserPreparedSubmission> {
    const tab = this.requireConversationTab(conversationId, tabId);
    const requested = requestedIds?.length ? new Set(requestedIds) : null;
    const comments = tab.snapshot.comments.filter((comment) => comment.status === 'draft' && (!requested || requested.has(comment.id)));
    if (comments.length === 0) throw new Error('There are no unsent browser comments.');
    const attachments: ZeusBrowserPreparedSubmission['attachments'] = [];
    const seenPaths = new Set<string>();
    for (const comment of comments) {
      if (!comment.screenshotPath || seenPaths.has(comment.screenshotPath)) continue;
      const file = await stat(comment.screenshotPath).catch(() => null);
      if (!file) continue;
      if (!file.isFile()) continue;
      seenPaths.add(comment.screenshotPath);
      attachments.push({
        name: basename(comment.screenshotPath),
        mime: 'image/png',
        size: file.size,
        localPath: comment.screenshotPath,
      });
    }
    return {
      tabId,
      commentIds: comments.map((comment) => comment.id),
      content: serializeBrowserComments(comments),
      comments: comments.map((comment) => structuredClone(comment)),
      attachments,
    };
  }

  private async markCommentsSent(conversationId: string, tabId: string, commentIds: string[]): Promise<void> {
    const tab = this.tabs.get(tabId);
    // 标签关闭时其批注也已从 BrowserHost 权威状态删除，补偿标记可按幂等成功处理。
    if (!tab) {
      if (this.persistenceTimer) {
        clearTimeout(this.persistenceTimer);
        this.persistenceTimer = undefined;
      }
      await this.persist();
      return;
    }
    if (tab.snapshot.conversationId !== conversationId) throw new Error('The browser tab does not belong to this conversation.');
    const sent = new Set(commentIds);
    const timestamp = this.now();
    tab.snapshot = {
      ...tab.snapshot,
      comments: tab.snapshot.comments.map((comment) =>
        sent.has(comment.id) && comment.status === 'draft'
          ? {
              ...comment,
              status: 'sent',
              updatedAt: timestamp,
            }
          : comment,
      ),
      updatedAt: timestamp,
    };
    this.syncPageComments(tab);
    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer);
      this.persistenceTimer = undefined;
    }
    // IPC 只有在原子文件替换完成后才返回；Renderer 随后删除补偿账本不会留下崩溃窗口。
    await this.persist();
    this.emitSnapshot(conversationId);
  }

  private syncPageComments(tab: LiveBrowserTab): void {
    if (!tab.view || tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.send('zeus-browser-page:command', {
      type: 'hydrate_comments',
      comments: tab.snapshot.comments.filter((comment) => comment.status === 'draft'),
      annotationMode: tab.snapshot.annotationMode,
    });
  }

  private snapshotFor(conversationId: string): ZeusBrowserConversationSnapshot {
    const tabs = [...this.tabs.values()]
      .filter((tab) => tab.snapshot.conversationId === conversationId)
      .map((tab) => structuredClone(tab.snapshot))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const activeCandidate = this.activeTabByConversation.get(conversationId);
    const activeTabId = tabs.some((tab) => tab.id === activeCandidate) ? activeCandidate! : (tabs.at(-1)?.id ?? null);
    return {
      conversationId,
      tabs,
      activeTabId,
      pendingApprovals: [...this.pendingApprovals.values()].map(({ request }) => request).filter((request) => request.conversationId === conversationId),
      openRequested: this.pendingOpenRequests.has(conversationId),
    };
  }

  private emitSnapshot(conversationId: string): void {
    this.emit({ type: 'snapshot', snapshot: this.snapshotFor(conversationId) });
  }

  private emitOpenRequested(conversationId: string): void {
    this.pendingOpenRequests.add(conversationId);
    this.emit({ type: 'open_requested', conversationId });
  }

  private emitDownload(download: BrowserDownload): void {
    this.emit({
      type: 'download',
      conversationId: download.conversationId,
      tabId: download.tabId,
      state: download.state,
      fileName: download.fileName,
      ...(download.path ? { path: download.path } : {}),
    });
  }

  private emitError(tab: LiveBrowserTab, error: unknown): void {
    this.emit({
      type: 'error',
      conversationId: tab.snapshot.conversationId,
      tabId: tab.snapshot.id,
      message: this.redactPasswordText(error instanceof Error ? error.message : String(error), true),
    });
  }

  private emit(event: ZeusBrowserEvent): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.webContents.send('zeus:browser-event', event);
    }
  }

  private requireConversationTab(conversationId: string, tabId: string): LiveBrowserTab {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.snapshot.conversationId !== conversationId) throw new Error('The browser tab does not belong to this conversation.');
    return tab;
  }

  private tabFromWebContents(webContents: WebContents): LiveBrowserTab | undefined {
    return [...this.tabs.values()].find((tab) => tab.view?.webContents === webContents);
  }

  private async resolveToolTab(conversationId: string, requestedTabId?: string): Promise<LiveBrowserTab> {
    if (requestedTabId) return this.requireConversationTab(conversationId, requestedTabId);
    const active = this.activeTabByConversation.get(conversationId);
    if (active) return this.requireConversationTab(conversationId, active);
    const snapshot = await this.openTab(this.preferredWindow(conversationId), { conversationId });
    return this.requireConversationTab(conversationId, snapshot.activeTabId!);
  }

  /** 网页操作直接执行，仅保留本地文件访问边界。 */
  private assertAgentUrlAllowed(targetUrl: string): void {
    const url = new URL(targetUrl);
    if (url.protocol === 'file:') throw new Error('Agent automation cannot navigate to local file URLs. Open the file manually in the built-in browser.');
  }

  /** 仅处理网页自身申请的设备等权限，不接收 AI 操作授权。 */
  private requestApproval(input: Omit<ZeusBrowserApprovalRequest, 'id' | 'createdAt'>): Promise<ZeusBrowserApprovalDecision> {
    const request: ZeusBrowserApprovalRequest = {
      ...input,
      id: `browser-approval-${randomUUID()}`,
      createdAt: this.now(),
    };
    return new Promise((resolveDecision) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(request.id);
        this.emitSnapshot(request.conversationId);
        resolveDecision('deny');
      }, approvalTimeoutMs);
      timer.unref();
      this.pendingApprovals.set(request.id, { request, resolve: resolveDecision, timer });
      this.emitSnapshot(request.conversationId);
      this.emitOpenRequested(request.conversationId);
    });
  }

  private respondToApproval(requestId: string, decision: ZeusBrowserApprovalDecision): { resolved: boolean } {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return { resolved: false };
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(requestId);
    pending.resolve(decision);
    this.schedulePersist();
    this.emitSnapshot(pending.request.conversationId);
    return { resolved: true };
  }

  /** 在允许的网址范围内执行历史导航。 */
  private async invokeHistoryTool(
    tab: LiveBrowserTab,
    action: string,
  ): Promise<{
    contentItems: BrowserAutomationContentItem[];
    success: boolean;
  }> {
    const webContents = this.ensureView(tab).webContents;
    const history = webContents.navigationHistory;
    const targetOffset = action === 'back' ? -1 : action === 'forward' ? 1 : 0;
    if (targetOffset !== 0) {
      const target = history.getAllEntries()[history.getActiveIndex() + targetOffset];
      if (target?.url && safeOrigin(target.url) !== safeOrigin(tab.snapshot.url)) {
        this.assertAgentUrlAllowed(target.url);
      }
    }
    if (action === 'back' && history.canGoBack()) history.goBack();
    else if (action === 'forward' && history.canGoForward()) history.goForward();
    else if (action === 'reload') webContents.reload();
    else if (action === 'stop') webContents.stop();
    else if (!['back', 'forward', 'reload', 'stop'].includes(action)) return toolText(`Unsupported history action: ${action}`, false);
    return toolJson({ action, url: webContents.getURL() });
  }

  /** 等待可见、可用或消失等真实页面状态，不把仅存在于 DOM 中误判为完成。 */
  private async invokeWaitTool(
    tab: LiveBrowserTab,
    args: Record<string, unknown>,
  ): Promise<{
    contentItems: BrowserAutomationContentItem[];
    success: boolean;
  }> {
    const selector = optionalString(args.selector);
    const state = optionalString(args.state) ?? 'visible';
    const expectedText = typeof args.text === 'string' ? args.text.replace(/\s+/g, ' ').trim() : undefined;
    if (!selector && (args.state !== undefined || args.text !== undefined)) throw new TypeError('state and text require selector.');
    if (!['attached', 'visible', 'hidden', 'detached', 'enabled'].includes(state)) throw new TypeError('state must be attached, visible, hidden, detached, or enabled.');
    if (expectedText !== undefined && ['hidden', 'detached'].includes(state)) throw new TypeError('text cannot be combined with hidden or detached state.');
    const timeoutMs = boundedInteger(args.timeoutMs, 5_000, 0, 30_000);
    const startedAt = Date.now();
    let lastObserved: Record<string, unknown> = {};
    while (Date.now() - startedAt <= timeoutMs) {
      if (!selector) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
        return toolJson({ waitedMs: timeoutMs });
      }
      const observed = await this.ensureView(tab).webContents.executeJavaScript(
        `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          const connected = Boolean(element?.isConnected);
          const style = connected ? getComputedStyle(element) : null;
          const visible = Boolean(connected && element.getClientRects().length && style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse' && style?.opacity !== '0');
          const enabled = Boolean(visible && !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[inert]'));
          const text = connected ? (('innerText' in element ? element.innerText : element.textContent) ?? '').replace(/\\s+/g, ' ').trim() : null;
          const states = { attached: connected, visible, hidden: !visible, detached: !connected, enabled };
          return { matched: states[${JSON.stringify(state)}] && (${JSON.stringify(expectedText ?? null)} === null || text === ${JSON.stringify(expectedText ?? null)}), connected, visible, enabled, text_matched: ${JSON.stringify(expectedText === undefined)} || text === ${JSON.stringify(expectedText ?? null)} };
        })()`,
        true,
      );
      lastObserved = asRecord(observed);
      if (lastObserved.matched === true) return toolJson({ selector, state, ...(expectedText === undefined ? {} : { text: expectedText }), waitedMs: Date.now() - startedAt });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(250, Math.max(0, timeoutMs - (Date.now() - startedAt)))));
    }
    return toolText(`Timed out waiting for ${state} selector ${selector}; last observed state: ${JSON.stringify(lastObserved)}`, false);
  }

  private async invokeClipboardTool(input: BrowserAutomationToolCall): Promise<{
    contentItems: BrowserAutomationContentItem[];
    success: boolean;
  }> {
    const action = requireNonEmptyString(input.arguments.action, 'action');
    if (action === 'read') return toolText(clipboard.readText(), true);
    if (action === 'write') {
      clipboard.writeText(requireString(input.arguments.text, 'text'));
      return toolJson({ written: true });
    }
    return toolText(`Unsupported clipboard action: ${action}`, false);
  }

  private async invokeDeveloperTool(
    input: BrowserAutomationToolCall,
    tab: LiveBrowserTab,
  ): Promise<{
    contentItems: BrowserAutomationContentItem[];
    success: boolean;
  }> {
    const method = requireNonEmptyString(input.arguments.method, 'method');
    const params = isPlainRecord(input.arguments.params) ? input.arguments.params : {};
    const debuggerApi = this.ensureView(tab).webContents.debugger;
    const attachedHere = !debuggerApi.isAttached();
    try {
      if (attachedHere) debuggerApi.attach('1.3');
      const result = await debuggerApi.sendCommand(method, params);
      return toolJson(result);
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }

  /** 页面能力读取 CUA 实际目录；导出、登录和窗口管理仍使用宿主能力。 */
  private async invokeAdvancedCatalog(args: Record<string, unknown>): Promise<ReturnType<typeof toolJson>> {
    const group = optionalString(args.group)?.toLocaleLowerCase();
    const query = optionalString(args.query)?.toLocaleLowerCase();
    const entries = browserFrozenContractEntries
      .filter((entry) => isHostBrowserMethod(entry.path))
      .filter((entry) => (!group || entry.group.toLocaleLowerCase() === group) && (!query || entry.path.toLocaleLowerCase().includes(query)))
      .map((entry) => ({
        path: entry.path,
        group: entry.group,
        kind: entry.kind,
        risk: entry.risk,
        description: entry.description,
        argumentSchema: browserFrozenArgumentSchema(entry.path),
        unsupportedOn: browserFrozenUnsupportedSurfaceKinds(entry.path),
      }));
    const native = !group || ['cua', 'cua-browser', 'browser'].includes(group) ? await this.cua.catalog(query) : toolJson({ engine: 'CUA', methods: [] });
    const catalog = JSON.parse(native.contentItems[0].type === 'inputText' ? native.contentItems[0].text : '{}') as Record<string, unknown>;
    return toolJson({ ...catalog, surface: 'built_in', hostMethods: entries });
  }

  private releaseAdvancedHandles(input: BrowserAutomationToolCall): ReturnType<typeof toolJson> {
    const requested = Array.isArray(input.arguments.handles) ? new Set(input.arguments.handles.filter((value): value is string => typeof value === 'string')) : null;
    let released = 0;
    for (const [id, handle] of this.advancedHandles) {
      if (handle.conversationId !== input.conversationId || handle.turnId !== input.turnId || (requested && !requested.has(id))) continue;
      this.advancedHandles.delete(id);
      released += 1;
    }
    return toolJson({ released });
  }

  private async invokeAdvancedTool(input: BrowserAutomationToolCall): Promise<{
    contentItems: BrowserAutomationContentItem[];
    success: boolean;
  }> {
    const path = requireNonEmptyString(input.arguments.path, 'path');
    if (!isHostBrowserMethod(path)) return toolText('内置浏览器的页面自动化已使用 CUA；请从 catalog 读取当前 CUA 方法，不调用旧的 Playwright/AX/DOM CUA 接口。', false);
    const contract = browserFrozenContractEntry(path);
    if (!contract) return toolText(`Method path is not in Browser ${browserFrozenContractVersion}: ${path}`, false);
    this.expireAdvancedHandlesOutsideTurn(input.conversationId, input.turnId);
    const args = normalizeAdvancedArguments(isPlainRecord(input.arguments.arguments) ? input.arguments.arguments : {});
    const handle = optionalString(input.arguments.handle) ? this.requireAdvancedHandle(input, requireNonEmptyString(input.arguments.handle, 'handle')) : undefined;
    const direct = await this.invokeAdvancedDirect(input, contract, args, handle);
    if (direct) return direct;
    const tab = await this.resolveAdvancedTab(input, handle, args);
    return this.invokeAdvancedTabCapability(input, contract, handle, tab, args);
  }

  private async invokeAdvancedDirect(
    input: BrowserAutomationToolCall,
    contract: BrowserFrozenContractEntry,
    args: Record<string, unknown>,
    handle: AdvancedBrowserHandle | undefined,
  ): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean } | null> {
    switch (contract.path) {
      case 'Agent.browsers':
        return toolJson(this.createAdvancedHandle(input, 'Browsers'));
      case 'Agent.documentation':
        return toolJson(this.createAdvancedHandle(input, 'Documentation'));
      case 'Browsers.list':
        return toolJson([
          {
            id: 'zeus-built-in',
            name: 'Zeus Built-in Browser',
            family: 'chromium',
            type: 'iab',
            capabilities: this.advancedCapabilities(),
            metadata: { surface: 'built_in', contractVersion: browserFrozenContractVersion },
          },
        ]);
      case 'Browsers.get':
      case 'Browsers.getDefault':
      case 'Browsers.getForUrl':
        return toolJson(this.createAdvancedHandle(input, 'Browser', undefined, { browserId: 'zeus-built-in' }));
      case 'Browser.browserId':
        return toolJson('zeus-built-in');
      case 'Browser.capabilities':
        return toolJson(this.createAdvancedHandle(input, 'BrowserCapabilityCollection'));
      case 'Browser.tabs':
        return toolJson(this.createAdvancedHandle(input, 'Tabs'));
      case 'Browser.user':
        return toolJson(this.createAdvancedHandle(input, 'BrowserUser'));
      case 'Browser.documentation':
        return toolJson(this.createAdvancedHandle(input, 'Documentation'));
      case 'BrowserCapabilityCollection.list':
        return toolJson(this.builtInBrowserCapabilities());
      case 'BrowserCapabilityCollection.get': {
        const id = requireNonEmptyString(args.id, 'id');
        const kind = this.builtInBrowserCapabilityKind(id);
        if (!kind) return toolText(`unsupported_surface: Browser capability ${id} is not advertised by the built-in surface.`, false);
        return toolJson(this.createAdvancedHandle(input, kind));
      }
      case 'TabCapabilityCollection.list':
        return toolJson(this.builtInTabCapabilities());
      case 'TabCapabilityCollection.get': {
        const id = requireNonEmptyString(args.id, 'id');
        const kind = this.builtInTabCapabilityKind(id);
        if (!kind) return toolText(`unsupported_surface: Tab capability ${id} is not advertised by the built-in surface.`, false);
        const tab = handle?.tabId ? this.requireConversationTab(input.conversationId, handle.tabId) : await this.resolveToolTab(input.conversationId, optionalString(args.tabId));
        return toolJson(this.createAdvancedHandle(input, kind, tab));
      }
      case 'VisibilityBrowserCapability.get':
        return toolJson([...this.visibleTabByWindow.values()].some((tabId) => this.tabs.get(tabId)?.snapshot.conversationId === input.conversationId));
      case 'VisibilityBrowserCapability.set': {
        const visible = args.visible === true;
        if (visible) this.emitOpenRequested(input.conversationId);
        else {
          for (const [windowId, tabId] of this.visibleTabByWindow) {
            if (this.tabs.get(tabId)?.snapshot.conversationId === input.conversationId) {
              this.detachTab(tabId);
              this.visibleTabByWindow.delete(windowId);
            }
          }
        }
        return toolJson({ visible });
      }
      case 'ManagementBrowserCapability.bookmarks':
        return toolJson(this.createAdvancedHandle(input, 'ManagementBookmarksAPI'));
      case 'ManagementBrowserCapability.tabGroups':
        return toolJson(this.createAdvancedHandle(input, 'ManagementTabGroupsAPI'));
      case 'ManagementBrowserCapability.tabs':
        return toolJson(this.createAdvancedHandle(input, 'ManagementTabsAPI'));
      case 'ManagementBrowserCapability.getAuditTrail':
        return toolJson({ changes: this.managementAudit.slice(-500).reverse() });
      case 'Browser.nameSession': {
        const name = requireNonEmptyString(args.name, 'name').slice(0, 200);
        this.sessionNames.set(input.conversationId, name);
        return toolJson({ name });
      }
      case 'Browser.history': {
        const options = asRecord(args.options);
        const from = parseDateBound(options.from, Number.NEGATIVE_INFINITY);
        const to = parseDateBound(options.to, Number.POSITIVE_INFINITY);
        const queries = Array.isArray(options.queries) ? options.queries.filter((value): value is string => typeof value === 'string').map((value) => value.toLocaleLowerCase()) : [];
        const limit = boundedInteger(options.limit, 100, 1, 1_000);
        const tabs = [...this.tabs.values()].filter((tab) => tab.snapshot.conversationId === input.conversationId);
        const entries = tabs
          .flatMap((tab) => {
            const view = tab.view;
            if (!view || view.webContents.isDestroyed()) return [{ dateVisited: tab.snapshot.updatedAt, title: tab.snapshot.title, url: tab.snapshot.url }];
            const activeIndex = view.webContents.navigationHistory.getActiveIndex();
            return view.webContents.navigationHistory.getAllEntries().map((entry, index) => ({ dateVisited: index === activeIndex ? tab.snapshot.updatedAt : tab.snapshot.createdAt, title: entry.title, url: entry.url }));
          })
          .filter((entry) => {
            const visited = Date.parse(entry.dateVisited);
            const searchable = `${entry.title} ${entry.url}`.toLocaleLowerCase();
            return visited >= from && visited <= to && queries.every((query) => searchable.includes(query));
          })
          .sort((left, right) => Date.parse(right.dateVisited) - Date.parse(left.dateVisited))
          .slice(0, limit);
        return toolJson(entries);
      }
      case 'BrowserUser.openTabs':
        return toolJson(this.openAdvancedTabClaims(input));
      case 'BrowserUser.claimTab':
        return this.claimAdvancedTab(input, args);
      case 'Tabs.list':
        return toolJson(this.listAdvancedTabs(input));
      case 'Tabs.get': {
        const tab = this.requireConversationTab(input.conversationId, requireNonEmptyString(args.tabId ?? args.id, 'tabId'));
        return toolJson(this.createAdvancedHandle(input, 'Tab', tab));
      }
      case 'Tabs.selected': {
        const tab = await this.resolveToolTab(input.conversationId, undefined);
        return toolJson(this.createAdvancedHandle(input, 'Tab', tab));
      }
      case 'Tabs.new': {
        const url = optionalString(args.url) ? normalizeBrowserUrl(requireNonEmptyString(args.url, 'url')) : 'about:blank';
        if (url !== 'about:blank') this.assertAgentUrlAllowed(url);
        const snapshot = await this.openConversationResource(this.preferredWindow(input.conversationId), { conversationId: input.conversationId, url });
        const tab = this.requireConversationTab(input.conversationId, snapshot.activeTabId!);
        if (url !== 'about:blank') await this.waitForTabReady(tab, boundedInteger(args.timeoutMs, 30_000, 0, 30_000));
        return toolJson(this.createAdvancedHandle(input, 'Tab', tab));
      }
      case 'Tabs.content': {
        return toolJson(await this.extractTemporaryTabsContent(input, asRecord(args.options)));
      }
      case 'Documentation.get': {
        const requestedPath = optionalString(args.name);
        const entries = browserFrozenContractEntries.filter((entry) => isHostBrowserMethod(entry.path) && (!requestedPath || entry.path === requestedPath));
        return toolJson({
          version: browserFrozenContractVersion,
          entries: entries.map((entry) => ({ ...entry, argumentSchema: browserFrozenArgumentSchema(entry.path), unsupportedOn: browserFrozenUnsupportedSurfaceKinds(entry.path) })),
        });
      }
      default:
        if (contract.path.startsWith('ManagementBookmarksAPI.')) return this.invokeBuiltInManagementBookmarks(contract.path.split('.')[1]!, args);
        if (contract.path.startsWith('ManagementTabGroupsAPI.')) return this.invokeBuiltInManagementTabGroups(contract.path.split('.')[1]!, args);
        if (contract.path.startsWith('ManagementTabsAPI.')) return this.invokeBuiltInManagementTabs(input, contract.path.split('.')[1]!, args);
        return null;
    }
  }

  private async invokeAdvancedTabCapability(
    input: BrowserAutomationToolCall,
    contract: BrowserFrozenContractEntry,
    handle: AdvancedBrowserHandle | undefined,
    tab: LiveBrowserTab,
    args: Record<string, unknown>,
  ): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const path = contract.path;
    const apiProperties: Record<string, string> = {
      'Tab.clipboard': 'TabClipboardAPI',
      'Tab.content': 'ContentAPI',
      'Tab.dev': 'TabDevAPI',
    };
    if (apiProperties[path]) return toolJson(this.createAdvancedHandle(input, apiProperties[path]!, tab));
    if (path === 'Tab.capabilities') return toolJson(this.createAdvancedHandle(input, 'TabCapabilityCollection', tab));
    if (path === 'Tab.id') return toolJson(tab.snapshot.id);
    if (path === 'Tab.title') return toolJson(tab.snapshot.title);
    if (path === 'Tab.url') return toolJson(tab.snapshot.url);
    if (path === 'Tab.screenshot') {
      return this.captureAdvancedTabScreenshot(tab, asRecord(args.options));
    }
    if (path === 'Tab.goto') {
      const url = normalizeBrowserUrl(requireNonEmptyString(args.url, 'url'));
      this.assertAgentUrlAllowed(url);
      await this.ensureView(tab).webContents.loadURL(url);
      await this.waitForTabReady(tab, boundedInteger(args.timeoutMs, 30_000, 0, 30_000));
      return toolJson({ url: tab.snapshot.url, documentGeneration: tab.documentGeneration });
    }
    if (path === 'Tab.back' || path === 'Tab.forward' || path === 'Tab.reload') {
      const action = path === 'Tab.back' ? 'back' : path === 'Tab.forward' ? 'forward' : 'reload';
      const result = await this.invokeHistoryTool(tab, action);
      await this.waitForTabReady(tab, boundedInteger(args.timeoutMs, 30_000, 0, 30_000));
      return result;
    }
    if (path === 'Tab.close') {
      await this.closeTab(this.preferredWindow(input.conversationId), input.conversationId, tab.snapshot.id);
      return toolJson({ closed: tab.snapshot.id });
    }
    if (path === 'Tab.getJsDialog') {
      await this.ensureCdpMonitor(tab).then((debuggerApi) => debuggerApi.sendCommand('Page.enable'));
      const active = this.activeJsDialogs.get(tab.snapshot.id);
      return toolJson(active ? this.createAdvancedHandle(input, active.kind, tab, { ...active }) : null);
    }
    if (path === 'Tab.markDeliverable' || path === 'Tab.markHandoff' || path === 'Tab.requestManualHandoff') {
      this.emitOpenRequested(input.conversationId);
      return toolJson({ tabId: tab.snapshot.id, state: path.split('.')[1], userVisible: true });
    }
    if (path.startsWith('ContentAPI.')) return this.invokeAdvancedContent(path.slice('ContentAPI.'.length), tab, args);
    if (path.startsWith('TabClipboardAPI.')) return this.invokeAdvancedTabClipboard(input, path.slice('TabClipboardAPI.'.length), args);
    if (path === 'TabDevAPI.logs') {
      const levels = Array.isArray(args.levels) ? new Set(args.levels.filter((value): value is string => typeof value === 'string').map((value) => (value === 'warning' ? 'warn' : value))) : null;
      const filter = optionalString(args.filter)?.toLocaleLowerCase();
      const logs = tab.consoleLogs
        .map((entry) => ({ ...entry, levelName: browserConsoleLevel(entry.level) }))
        .filter((entry) => (!levels || levels.has(entry.levelName)) && (!filter || `${entry.message} ${entry.sourceId}`.toLocaleLowerCase().includes(filter)))
        .slice(-boundedInteger(args.limit, 200, 1, 500));
      return toolJson(logs);
    }
    if (path.startsWith('CdpTabCapability.')) return this.invokeAdvancedCdp(path.slice('CdpTabCapability.'.length), tab, args);
    if (path === 'BotDetectionTabCapability.report') return toolJson({ status: 'reported', hostname: safeOrigin(tab.snapshot.url) ? new URL(tab.snapshot.url).hostname : null });
    if (path === 'BrowserAuthTabCapability.request') return this.invokeBrowserAuth(input, tab, args);
    if (path.startsWith('PageAssetsTabCapability.')) return this.invokePageAssets(input, path.slice('PageAssetsTabCapability.'.length), tab, args);
    if (path === 'WebMcpTabCapability.fetchTools') return this.invokeWebMcpFetch(input, tab);
    if (path.startsWith('WebMcpTools.')) return this.invokeWebMcpTools(input, path.slice('WebMcpTools.'.length), handle, tab, args);
    if (path.startsWith('ViewportBrowserCapability.')) return this.invokeViewport(path.slice('ViewportBrowserCapability.'.length), tab, args);
    if (/^(AlertDialog|BeforeUnloadDialog|ConfirmDialog|PromptDialog)\./u.test(path)) return this.invokeAdvancedJsDialog(path, handle, tab, args);
    return toolText(`Frozen Browser method is registered but has no built-in adapter: ${path}`, false);
  }

  private async invokeAdvancedContent(method: string, tab: LiveBrowserTab, args: Record<string, unknown>): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    if (method === 'exportYouTubeTranscript') {
      const url = new URL(tab.snapshot.url);
      if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com'].includes(url.hostname) || url.pathname !== '/watch') {
        return toolText('ZEUS_BROWSER_YOUTUBE_TRANSCRIPT_UNSUPPORTED_URL: transcript export requires an HTTPS youtube.com/watch tab.', false);
      }
      const transcript = (await this.ensureView(tab).webContents.executeJavaScript(`(${exportYouTubeTranscriptScript})()`, true)) as Record<string, unknown>;
      const text = typeof transcript.text === 'string' ? transcript.text.trim() : '';
      if (!text) return toolText('ZEUS_BROWSER_YOUTUBE_TRANSCRIPT_UNAVAILABLE: open the transcript panel or choose a video with an available transcript.', false);
      return toolJson(await this.writeBrowserExport('youtube-transcript.txt', Buffer.from(text, 'utf8')));
    }
    if (method === 'exportGsuite') {
      const type = requireNonEmptyString(args.type, 'type').toLocaleLowerCase();
      const exportRequest = googleWorkspaceExportRequest(tab.snapshot.url, type);
      if (!exportRequest) return toolText(`ZEUS_BROWSER_GSUITE_EXPORT_UNSUPPORTED: ${type} is not valid for this Google Workspace URL.`, false);
      const response = await this.browserSession.fetch(exportRequest.url, { method: 'GET', credentials: 'include', redirect: 'follow' });
      if (!response.ok) return toolText(`ZEUS_BROWSER_GSUITE_EXPORT_FAILED: HTTP ${response.status}.`, false);
      const bytes = Buffer.from(await response.arrayBuffer());
      return toolJson(await this.writeBrowserExport(`google-workspace.${exportRequest.extension}`, bytes));
    }
    const content = (await this.ensureView(tab).webContents.executeJavaScript(`(${exportPageContentScript})('html')`, true)) as Record<string, unknown>;
    return toolJson(await this.writeBrowserExport('page.html', Buffer.from(typeof content.content === 'string' ? content.content : '', 'utf8')));
  }

  private async captureAdvancedTabScreenshot(tab: LiveBrowserTab, options: Record<string, unknown>): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const clip = asRecord(options.clip);
    if (options.fullPage === true) {
      const debuggerApi = this.ensureView(tab).webContents.debugger;
      const attachedHere = !debuggerApi.isAttached();
      if (attachedHere) debuggerApi.attach('1.3');
      try {
        const metrics = (await debuggerApi.sendCommand('Page.getLayoutMetrics')) as { cssContentSize?: { x?: number; y?: number; width?: number; height?: number } };
        const size = metrics.cssContentSize ?? {};
        const result = (await debuggerApi.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: finiteNumber(size.x, 0), y: finiteNumber(size.y, 0), width: Math.max(1, finiteNumber(size.width, 1)), height: Math.max(1, finiteNumber(size.height, 1)), scale: 1 },
        })) as { data?: string };
        if (!result.data) return toolText('ZEUS_BROWSER_SCREENSHOT_FAILED: CDP returned no screenshot bytes.', false);
        const artifactPath = await this.writeBrowserExport('screenshot.png', Buffer.from(result.data, 'base64'));
        return {
          contentItems: [
            { type: 'inputText', text: JSON.stringify({ artifactPath, mimeType: 'image/png' }) },
            { type: 'inputImage', imageUrl: `data:image/png;base64,${result.data}` },
          ],
          success: true,
        };
      } finally {
        if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
      }
    }
    const rectangle =
      Object.keys(clip).length > 0
        ? { x: Math.max(0, Math.floor(finiteNumber(clip.x, 0))), y: Math.max(0, Math.floor(finiteNumber(clip.y, 0))), width: Math.max(1, Math.ceil(finiteNumber(clip.width, 1))), height: Math.max(1, Math.ceil(finiteNumber(clip.height, 1))) }
        : undefined;
    const image = await this.ensureView(tab).webContents.capturePage(rectangle);
    const artifactPath = await this.writeBrowserExport('screenshot.png', image.toPNG());
    return {
      contentItems: [
        { type: 'inputText', text: JSON.stringify({ artifactPath, mimeType: 'image/png' }) },
        { type: 'inputImage', imageUrl: image.toDataURL() },
      ],
      success: true,
    };
  }

  private async writeBrowserExport(name: string, bytes: Buffer): Promise<string> {
    if (bytes.byteLength > 128 * 1024 * 1024) throw Object.assign(new Error('Browser export exceeds 128 MiB.'), { code: 'ZEUS_BROWSER_EXPORT_TOO_LARGE' });
    const directoryPath = join(this.attachmentRoot, 'browser-exports', `${Date.now()}-${randomUUID()}`);
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const path = join(directoryPath, sanitizeBrowserArtifactName(name, 'browser-export.bin'));
    const temporaryPath = join(directoryPath, `.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishFile(temporaryPath, path, { replace: true });
    return path;
  }

  private async invokeAdvancedTabClipboard(input: BrowserAutomationToolCall, method: string, args: Record<string, unknown>): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    if (method === 'readText') return toolJson(clipboard.readText());
    if (method === 'read') {
      return toolJson([
        {
          entries: clipboard.availableFormats().map((mimeType) => {
            if (mimeType === 'text/plain') return { mimeType, text: clipboard.readText() };
            if (mimeType === 'text/html') return { mimeType, text: clipboard.readHTML() };
            if (mimeType === 'text/rtf') return { mimeType, text: clipboard.readRTF() };
            return { mimeType, base64: clipboard.readBuffer(mimeType).toString('base64') };
          }),
          presentationStyle: 'unspecified',
        },
      ]);
    }
    if (method === 'writeText') {
      clipboard.writeText(requireString(args.text, 'text'));
      return toolJson({ written: true, formats: ['text/plain'] });
    }
    const items = Array.isArray(args.items) ? args.items.map(asRecord) : [];
    const entries = items.flatMap((item) => (Array.isArray(item.entries) ? item.entries.map(asRecord) : []));
    if (entries.length === 0) return toolText('ZEUS_BROWSER_CLIPBOARD_FORMAT_INVALID: at least one clipboard entry is required.', false);
    const data: Electron.Data = {};
    const custom: Array<{ mimeType: string; bytes: Buffer }> = [];
    for (const entry of entries) {
      const mimeType = requireNonEmptyString(entry.mimeType, 'mimeType');
      const text = optionalString(entry.text);
      const bytes = optionalString(entry.base64) ? Buffer.from(requireNonEmptyString(entry.base64, 'base64'), 'base64') : text === undefined ? undefined : Buffer.from(text, 'utf8');
      if (mimeType === 'text/plain' && text !== undefined) data.text = text;
      else if (mimeType === 'text/html' && text !== undefined) data.html = text;
      else if (mimeType === 'text/rtf' && text !== undefined) data.rtf = text;
      else if (mimeType === 'image/png' && bytes) data.image = nativeImage.createFromBuffer(bytes);
      else if (bytes) custom.push({ mimeType, bytes });
    }
    if (Object.keys(data).length > 0) clipboard.write(data);
    for (const entry of custom) clipboard.writeBuffer(entry.mimeType, entry.bytes);
    return toolJson({ written: true, formats: entries.map((entry) => entry.mimeType) });
  }

  private async invokeAdvancedCdp(method: string, tab: LiveBrowserTab, args: Record<string, unknown>): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const debuggerApi = await this.ensureCdpMonitor(tab);
    if (method === 'send') {
      const command = requireNonEmptyString(args.method, 'method');
      const params = isPlainRecord(args.params) ? args.params : {};
      const options = isPlainRecord(args.options) ? args.options : {};
      const sessionId = optionalString(isPlainRecord(options.target) ? options.target.sessionId : undefined);
      return toolJson(await debuggerApi.sendCommand(command, params, sessionId));
    }
    const afterSequence = boundedInteger(args.afterSequence, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(args.limit, 200, 1, 1_000);
    const methods = Array.isArray(args.methods) ? new Set(args.methods.filter((value): value is string => typeof value === 'string')) : null;
    const allEvents = this.cdpEvents.get(tab.snapshot.id) ?? [];
    const matched = allEvents.filter((event) => event.sequence > afterSequence && (!methods || methods.has(event.method)));
    const events = matched.slice(0, limit);
    return toolJson({
      cursor: events.at(-1)?.sequence ?? Math.max(afterSequence, this.cdpSequence),
      events,
      hasMore: matched.length > events.length,
      truncated: afterSequence > 0 && allEvents.length > 0 && afterSequence < allEvents[0]!.sequence - 1,
    });
  }

  private async ensureCdpMonitor(tab: LiveBrowserTab): Promise<Electron.Debugger> {
    const contents = this.ensureView(tab).webContents;
    const debuggerApi = contents.debugger;
    if (!this.cdpMonitoredContents.has(contents)) {
      this.cdpMonitoredContents.add(contents);
      debuggerApi.on('message', (_event, eventMethod, params, sessionId) => {
        const parameters = isPlainRecord(params) ? params : {};
        const sequence = ++this.cdpSequence;
        const events = this.cdpEvents.get(tab.snapshot.id) ?? [];
        events.push({
          sequence,
          method: eventMethod,
          ...(Object.keys(parameters).length > 0 ? { params: parameters } : {}),
          source: { tabId: tab.snapshot.id, ...(sessionId ? { sessionId } : {}) },
        });
        if (events.length > 5_000) events.splice(0, events.length - 5_000);
        this.cdpEvents.set(tab.snapshot.id, events);
        if (eventMethod === 'Page.javascriptDialogOpening') {
          const type = normalizeJsDialogType(parameters.type);
          this.activeJsDialogs.set(tab.snapshot.id, {
            parameters,
            type,
            kind: jsDialogHandleKind(type),
            message: optionalString(parameters.message) ?? '',
            ...(optionalString(parameters.defaultPrompt) !== undefined ? { defaultPrompt: optionalString(parameters.defaultPrompt) } : {}),
            sequence,
          });
        } else if (eventMethod === 'Page.javascriptDialogClosed') {
          this.activeJsDialogs.delete(tab.snapshot.id);
        }
      });
      debuggerApi.on('detach', () => this.activeJsDialogs.delete(tab.snapshot.id));
    }
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    return debuggerApi;
  }

  private async waitForCdpEvent(
    tab: LiveBrowserTab,
    method: string,
    afterSequence: number,
    timeoutMs: number,
  ): Promise<{ sequence: number; method: string; params?: Record<string, unknown>; source: { tabId: string; sessionId?: string } } | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const event = (this.cdpEvents.get(tab.snapshot.id) ?? []).find((candidate) => candidate.sequence > afterSequence && candidate.method === method);
      if (event) return event;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    return null;
  }

  private async invokeAdvancedJsDialog(path: string, handle: AdvancedBrowserHandle | undefined, tab: LiveBrowserTab, args: Record<string, unknown>): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const [kind, method] = path.split('.') as [ActiveBrowserJsDialog['kind'], string];
    if (!handle || handle.kind !== kind) return toolText(`${kind} requires the matching live dialog handle.`, false);
    const payload = asRecord(handle.payload);
    const active = this.activeJsDialogs.get(tab.snapshot.id);
    if (!active || active.kind !== kind || active.sequence !== payload.sequence) {
      return toolText('ZEUS_BROWSER_DIALOG_STALE: The JavaScript dialog was already handled or replaced.', false);
    }
    if (method === 'type') return toolJson(active.type);
    const accept = method === 'accept';
    const debuggerApi = await this.ensureCdpMonitor(tab);
    await debuggerApi.sendCommand('Page.handleJavaScriptDialog', {
      accept,
      ...(accept && kind === 'PromptDialog' ? { promptText: requireNonEmptyString(args.text, 'text') } : {}),
    });
    this.activeJsDialogs.delete(tab.snapshot.id);
    return toolJson({ handled: true, action: method });
  }

  private async invokeViewport(method: string, tab: LiveBrowserTab, args: Record<string, unknown>): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const debuggerApi = this.ensureView(tab).webContents.debugger;
    const attachedHere = !debuggerApi.isAttached();
    if (attachedHere) debuggerApi.attach('1.3');
    try {
      if (method === 'reset') {
        await debuggerApi.sendCommand('Emulation.clearDeviceMetricsOverride');
        return toolJson({ reset: true });
      }
      const width = boundedInteger(args.width, 0, 200, 8_192);
      const height = boundedInteger(args.height, 0, 200, 8_192);
      if (!width || !height) return toolText('Viewport width and height are required.', false);
      await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: finiteNumber(args.deviceScaleFactor, 1), mobile: false });
      return toolJson({ width, height });
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }

  private async invokePageAssets(input: BrowserAutomationToolCall, method: string, tab: LiveBrowserTab, args: Record<string, unknown>): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    if (method === 'list') {
      const projection = (await this.ensureView(tab).webContents.executeJavaScript(
        `(() => {
        const kind = (url, element) => {
          const tag = element?.tagName?.toLowerCase();
          if (tag === 'img' || /\\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/iu.test(url)) return 'image';
          if (tag === 'video' || /\\.(?:mp4|webm|mov)(?:[?#]|$)/iu.test(url)) return 'video';
          if (tag === 'link' || /\\.css(?:[?#]|$)/iu.test(url)) return 'stylesheet';
          if (/\\.(?:woff2?|ttf|otf)(?:[?#]|$)/iu.test(url)) return 'font';
          if (tag === 'script' || /\\.m?js(?:[?#]|$)/iu.test(url)) return 'script';
          return 'other';
        };
        const values = new Map();
        const add = (url, element, source) => { try { const absolute = new URL(url, location.href).href; if (!/^https?:/u.test(absolute)) return; const existing = values.get(absolute) || { url: absolute, kind: kind(absolute, element), name: absolute.split('/').pop()?.split(/[?#]/u)[0] || 'asset', sources: [] }; existing.sources.push(source); values.set(absolute, existing); } catch {} };
        performance.getEntriesByType('resource').forEach((entry) => add(entry.name, null, { kind: 'resource' }));
        document.querySelectorAll('[src],[href],video[poster]').forEach((element) => { for (const attribute of ['src','href','poster']) { const value = element.getAttribute(attribute); if (value) add(value, element, { kind: 'attribute', property: attribute }); } });
        const inlineSvgs = Array.from(document.querySelectorAll('svg')).slice(0, 200).map((svg, index) => ({ id: 'svg-' + index, name: svg.getAttribute('aria-label') || svg.id || 'inline-' + index + '.svg', markup: svg.outerHTML.slice(0, 500000) }));
        return { assets: Array.from(values.values()).slice(0, 5000), inlineSvgs, pageUrl: location.href };
      })()`,
        true,
      )) as { assets?: Array<{ url?: unknown; kind?: unknown; name?: unknown; sources?: unknown }>; inlineSvgs?: unknown[]; pageUrl?: string };
      const id = `asset-inventory-${randomUUID()}`;
      const assets = (projection.assets ?? []).flatMap((asset, index) => {
        if (typeof asset.url !== 'string' || typeof asset.name !== 'string') return [];
        const kind = ['script', 'font', 'image', 'stylesheet', 'video', 'other'].includes(String(asset.kind)) ? (asset.kind as PageAssetInventory['assets'][number]['kind']) : 'other';
        return [{ id: `asset-${index}`, url: asset.url, name: sanitizeBrowserArtifactName(asset.name, `asset-${index}`), kind, contentType: null }];
      });
      this.pageAssetInventories.set(id, { id, conversationId: input.conversationId, turnId: input.turnId, tabId: tab.snapshot.id, documentGeneration: tab.documentGeneration, assets });
      const byKind = Object.fromEntries(['script', 'font', 'image', 'stylesheet', 'video', 'other'].map((kind) => [kind, assets.filter((asset) => asset.kind === kind).length]));
      return toolJson({
        id,
        assets: assets.map((asset, index) => ({ ...asset, sources: projection.assets?.[index]?.sources ?? [] })),
        inlineSvgs: projection.inlineSvgs ?? [],
        pageUrl: projection.pageUrl ?? tab.snapshot.url,
        summary: { totalCount: assets.length, inlineSvgCount: projection.inlineSvgs?.length ?? 0, byKind },
      });
    }
    const inventoryId = requireNonEmptyString(args.inventoryId, 'inventoryId');
    const inventory = this.pageAssetInventories.get(inventoryId);
    if (!inventory || inventory.conversationId !== input.conversationId || inventory.turnId !== input.turnId || inventory.tabId !== tab.snapshot.id || inventory.documentGeneration !== tab.documentGeneration) {
      return toolText('ZEUS_BROWSER_ASSET_INVENTORY_STALE: Refresh the asset inventory after navigation or turn change.', false);
    }
    const requestedIds = Array.isArray(args.assetIds) ? new Set(args.assetIds.filter((value): value is string => typeof value === 'string')) : null;
    const requestedKinds = Array.isArray(args.kinds) ? new Set(args.kinds.filter((value): value is string => typeof value === 'string')) : null;
    const selected = inventory.assets.filter((asset) => (!requestedIds || requestedIds.has(asset.id)) && (!requestedKinds || requestedKinds.has(asset.kind)));
    const directoryPath = join(this.attachmentRoot, 'page-assets', `${Date.now()}-${randomUUID()}`);
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const exported: Array<Record<string, unknown>> = [];
    const failures: Array<Record<string, unknown>> = [];
    let totalBytes = 0;
    const startedAt = Date.now();
    for (const [index, asset] of selected.entries()) {
      try {
        const response = await this.browserSession.fetch(asset.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        totalBytes += data.byteLength;
        if (data.byteLength > 16 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024) throw new Error('Asset bundle byte limit exceeded.');
        const path = join(directoryPath, `${String(index + 1).padStart(3, '0')}-${sanitizeBrowserArtifactName(asset.name, asset.id)}`);
        await writeFile(path, data, { mode: 0o600 });
        exported.push({ ...asset, path, contentType: response.headers.get('content-type') });
      } catch (error) {
        failures.push({ ...asset, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const manifestPath = join(directoryPath, 'manifest.json');
    const summary = { requestedCount: selected.length, downloadedCount: exported.length, failedCount: failures.length, elapsedMs: Date.now() - startedAt };
    await writeFile(manifestPath, `${JSON.stringify({ inventoryId, assets: exported, failures, summary }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return toolJson({ directoryPath, manifestPath, assets: exported, failures, summary });
  }

  private async invokeWebMcpFetch(input: BrowserAutomationToolCall, tab: LiveBrowserTab): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const tools = (await this.ensureView(tab).webContents.executeJavaScript(
      `(() => {
      const context = navigator.modelContext || navigator.webMCP || globalThis.webMCP;
      if (!context) return null;
      const source = typeof context.listTools === 'function' ? context.listTools() : context.tools;
      return Promise.resolve(source).then((value) => Array.isArray(value) ? value.map((tool) => ({ name: String(tool.name || tool.id || ''), description: String(tool.description || ''), inputSchema: tool.inputSchema || tool.parameters || {} })).filter((tool) => tool.name) : []);
    })()`,
      true,
    )) as unknown;
    if (!Array.isArray(tools)) return toolText('unsupported_surface: The current page does not expose WebMCP.', false);
    return toolJson(this.createAdvancedHandle(input, 'WebMcpTools', tab, { tools: { entries: tools } }));
  }

  private async invokeWebMcpTools(
    _input: BrowserAutomationToolCall,
    method: string,
    handle: AdvancedBrowserHandle | undefined,
    tab: LiveBrowserTab,
    args: Record<string, unknown>,
  ): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    if (!handle || handle.kind !== 'WebMcpTools') return toolText('WebMcpTools requires a matching handle.', false);
    const entries = asRecord(handle.payload?.tools).entries;
    if (method === 'description') return toolJson(Array.isArray(entries) ? entries : []);
    const name = requireNonEmptyString(args.name ?? args.tool, 'name');
    const result = await this.ensureView(tab).webContents.executeJavaScript(
      `(async () => {
      const context = navigator.modelContext || navigator.webMCP || globalThis.webMCP;
      if (!context) throw new Error('WebMCP is no longer available.');
      if (typeof context.callTool === 'function') return context.callTool(${JSON.stringify(name)}, ${JSON.stringify(args.input ?? args.arguments ?? {})});
      const tools = await Promise.resolve(context.tools);
      const tool = Array.isArray(tools) ? tools.find((candidate) => String(candidate.name || candidate.id) === ${JSON.stringify(name)}) : tools?.[${JSON.stringify(name)}];
      if (!tool) throw new Error('WebMCP tool is stale or missing.');
      const call = tool.call || tool.execute || tool.invoke;
      if (typeof call !== 'function') throw new Error('WebMCP tool is not callable.');
      return call.call(tool, ${JSON.stringify(args.input ?? args.arguments ?? {})});
    })()`,
      true,
    );
    return toolJson(result);
  }

  private async invokeBrowserAuth(input: BrowserAutomationToolCall, tab: LiveBrowserTab, args: Record<string, unknown>): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const requestedOrigin = requireNonEmptyString(args.origin, 'origin');
    if (safeOrigin(tab.snapshot.url) !== requestedOrigin) return toolJson({ status: 'origin_changed' });
    const generation = tab.documentGeneration;
    const fields = Array.isArray(args.fields) ? args.fields.filter(isPlainRecord).slice(0, 20) : [];
    const options = Array.isArray(args.options) ? args.options.filter(isPlainRecord).slice(0, 20) : [];
    const secure = await this.collectSecureBrowserCredentials(input.conversationId, requestedOrigin, fields, options);
    if (secure.status !== 'submitted') return toolJson({ status: secure.status, ...(secure.selectedOption ? { selected_option: secure.selectedOption } : {}) });
    if (tab.documentGeneration !== generation || safeOrigin(tab.snapshot.url) !== requestedOrigin) return toolJson({ status: 'page_changed' });
    try {
      for (const field of fields) {
        const value = typeof field.id === 'string' ? secure.values[field.id] : undefined;
        if (secureHtmlInputType(field.type) === 'password' && value) (tab.passwordValues ??= new Set()).add(value);
      }
      if (secure.selectedOption) {
        const selected = options.find((option) => option.id === secure.selectedOption);
        const selector = this.browserAuthSelector(input, selected?.selector);
        if (selector) await this.ensureView(tab).webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`, true);
      }
      for (const field of fields) {
        const id = typeof field.id === 'string' ? field.id : '';
        const value = secure.values[id];
        if (typeof value !== 'string') continue;
        const selector = this.browserAuthSelector(input, field.selector);
        if (!selector) return toolJson({ status: 'locator_invalid', locator_error: { field_id: id, reason: 'not_user_visible' } });
        const filled = await this.ensureView(tab).webContents.executeJavaScript(
          `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element || element.disabled || element.getClientRects().length === 0) return false;
          const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(element, ${JSON.stringify(value)}); else element.value = ${JSON.stringify(value)};
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`,
          true,
        );
        if (!filled) return toolJson({ status: 'locator_invalid', locator_error: { field_id: id, reason: 'not_user_visible' } });
      }
      const submit = isPlainRecord(args.submit) ? args.submit : {};
      const submitSelector = this.browserAuthSelector(input, submit.selector);
      if (submitSelector && submit.action === 'click') await this.ensureView(tab).webContents.executeJavaScript(`document.querySelector(${JSON.stringify(submitSelector)})?.click()`, true);
      else if (submitSelector && submit.action === 'press_enter') {
        const submitted = await this.cua.invoke({ ...input, tool: 'press', arguments: { tabId: tab.snapshot.id, key: 'Enter' } }, this.cuaSurface(tab));
        if (!submitted.success) return toolJson({ status: 'submission_unconfirmed', details: submitted.contentItems });
      }
      return toolJson({ status: 'submitted', ...(secure.selectedOption ? { selected_option: secure.selectedOption } : {}) });
    } finally {
      for (const key of Object.keys(secure.values)) secure.values[key] = '';
    }
  }

  private browserAuthSelector(input: BrowserAutomationToolCall, value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (!isPlainRecord(value)) return null;
    const record = value;
    const handleId = optionalString(record.handle);
    if (!handleId) return null;
    const handle = this.requireAdvancedHandle(input, handleId);
    const query = asRecord(handle.payload?.query);
    return typeof query.selector === 'string' ? query.selector : null;
  }

  private collectSecureBrowserCredentials(
    conversationId: string,
    origin: string,
    fields: Record<string, unknown>[],
    options: Record<string, unknown>[],
  ): Promise<{ status: 'submitted' | 'cancelled'; values: Record<string, string>; selectedOption?: string }> {
    const parent = this.preferredWindow(conversationId);
    const token = randomUUID();
    const channel = `zeus:browser-auth:${token}`;
    const authWindow = new BrowserWindow({
      parent,
      modal: true,
      show: false,
      width: 460,
      height: Math.min(720, 260 + fields.length * 74 + options.length * 44),
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: this.text('通过 Zeus 登录', 'Sign in with Zeus'),
      webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, devTools: false },
    });
    authWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    authWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    const safeFields = fields.map((field) => ({ id: String(field.id ?? ''), label: String(field.label ?? field.id ?? 'Credential').slice(0, 100), type: secureHtmlInputType(field.type), required: field.required === true }));
    const safeOptions = options.map((option) => ({ id: String(option.id ?? ''), label: String(option.label ?? option.id ?? 'Option').slice(0, 100) }));

    const html = browserCredentialPromptHtml({ origin, fields: safeFields, options: safeOptions, channel, token }, this.options.language?.());
    return new Promise((resolveCredentials) => {
      let resolved = false;
      const finish = (value: { status: 'submitted' | 'cancelled'; values: Record<string, string>; selectedOption?: string }) => {
        if (resolved) return;
        resolved = true;
        ipcMain.removeListener(channel, listener);
        if (!authWindow.isDestroyed()) authWindow.destroy();
        resolveCredentials(value);
      };
      const listener = (event: IpcMainEvent, payload: unknown) => {
        if (event.sender.id !== authWindow.webContents.id) return;
        const record = asRecord(payload);
        if (record.token !== token) return;
        const rawValues = asRecord(record.values);
        const values = Object.fromEntries(safeFields.map((field) => [field.id, typeof rawValues[field.id] === 'string' ? (rawValues[field.id] as string) : '']));
        finish({ status: record.status === 'submitted' ? 'submitted' : 'cancelled', values, ...(typeof record.selectedOption === 'string' ? { selectedOption: record.selectedOption } : {}) });
      };
      ipcMain.on(channel, listener);
      authWindow.once('closed', () => finish({ status: 'cancelled', values: {} }));
      void authWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => authWindow.show());
    });
  }

  private createAdvancedHandle(input: BrowserAutomationToolCall, kind: string, tab?: LiveBrowserTab, payload?: Record<string, unknown>): Record<string, unknown> {
    const id = `browser-handle-${randomUUID()}`;
    const handle: AdvancedBrowserHandle = {
      id,
      kind,
      conversationId: input.conversationId,
      turnId: input.turnId,
      ...(tab ? { tabId: tab.snapshot.id, documentGeneration: tab.documentGeneration } : {}),
      ...(payload ? { payload } : {}),
    };
    this.advancedHandles.set(id, handle);
    return {
      handle: id,
      kind,
      surface: 'built_in',
      ...(tab ? { tabId: tab.snapshot.id, documentGeneration: tab.documentGeneration } : {}),
    };
  }

  private invokeBuiltInManagementBookmarks(method: string, args: Record<string, unknown>): ReturnType<typeof toolJson> | ReturnType<typeof toolText> {
    const values = Array.isArray(args.args) ? args.args : [];
    const all = (): ManagedBrowserBookmark[] => [...this.managementBookmarks.values()];
    const children = (parentId: string): ManagedBrowserBookmark[] =>
      all()
        .filter((entry) => (entry.parentId ?? '0') === parentId)
        .sort((left, right) => left.index - right.index);
    const tree = (entry: ManagedBrowserBookmark): Record<string, unknown> => ({ ...entry, ...(!entry.url ? { children: children(entry.id).map(tree) } : {}) });
    if (method === 'getTree') return toolJson([{ id: '0', title: '', index: 0, dateAdded: 0, children: children('0').map(tree) }]);
    if (method === 'get') {
      const ids = (Array.isArray(values[0]) ? values[0] : [values[0]]).filter((value): value is string => typeof value === 'string');
      return toolJson(ids.map((id) => this.managementBookmarks.get(id)).filter(Boolean));
    }
    if (method === 'getChildren') return toolJson(children(requireNonEmptyString(values[0], 'args[0]')));
    if (method === 'getRecent')
      return toolJson(
        all()
          .sort((left, right) => right.dateAdded - left.dateAdded)
          .slice(0, boundedInteger(values[0], 10, 1, 1_000)),
      );
    if (method === 'getSubTree') {
      const entry = this.managementBookmarks.get(requireNonEmptyString(values[0], 'args[0]'));
      return toolJson(entry ? [tree(entry)] : []);
    }
    if (method === 'search') {
      const query = typeof values[0] === 'string' ? values[0] : (optionalString(asRecord(values[0]).query) ?? '');
      const normalized = query.toLocaleLowerCase();
      return toolJson(all().filter((entry) => `${entry.title} ${entry.url ?? ''}`.toLocaleLowerCase().includes(normalized)));
    }
    if (method === 'create') {
      const details = asRecord(values[0]);
      const parentId = optionalString(details.parentId) ?? '0';
      if (parentId !== '0' && !this.managementBookmarks.has(parentId)) return toolText('ZEUS_BROWSER_BOOKMARK_PARENT_MISSING: The requested bookmark parent does not exist.', false);
      const before = children(parentId);
      const entry: ManagedBrowserBookmark = {
        id: `bookmark-${randomUUID()}`,
        parentId,
        index: boundedInteger(details.index, before.length, 0, before.length),
        title: optionalString(details.title) ?? '',
        ...(optionalString(details.url) ? { url: normalizeBrowserUrl(requireNonEmptyString(details.url, 'url')) } : {}),
        dateAdded: Date.now(),
      };
      for (const sibling of before) if (sibling.index >= entry.index) sibling.index += 1;
      this.managementBookmarks.set(entry.id, entry);
      this.recordBuiltInManagement('bookmarks', method, values, before, entry);
      return toolJson(entry);
    }
    const id = requireNonEmptyString(values[0], 'args[0]');
    const entry = this.managementBookmarks.get(id);
    if (!entry) return toolText('ZEUS_BROWSER_BOOKMARK_MISSING: The requested bookmark no longer exists.', false);
    const before = { ...entry };
    if (method === 'move') {
      const destination = asRecord(values[1]);
      const parentId = optionalString(destination.parentId) ?? entry.parentId ?? '0';
      if (parentId !== '0' && !this.managementBookmarks.has(parentId)) return toolText('ZEUS_BROWSER_BOOKMARK_PARENT_MISSING: The requested bookmark parent does not exist.', false);
      entry.parentId = parentId;
      entry.index = boundedInteger(destination.index, children(parentId).length, 0, children(parentId).length);
    } else if (method === 'update') {
      const changes = asRecord(values[1]);
      if (typeof changes.title === 'string') entry.title = changes.title.slice(0, 1_000);
      if (typeof changes.url === 'string') entry.url = normalizeBrowserUrl(changes.url);
    } else if (method === 'remove' || method === 'removeTree') {
      if (method === 'remove' && children(id).length > 0) return toolText('ZEUS_BROWSER_BOOKMARK_NOT_EMPTY: Use removeTree for a bookmark folder with children.', false);
      const removeIds = new Set<string>([id]);
      if (method === 'removeTree') {
        let changed = true;
        while (changed) {
          changed = false;
          for (const candidate of all())
            if (candidate.parentId && removeIds.has(candidate.parentId) && !removeIds.has(candidate.id)) {
              removeIds.add(candidate.id);
              changed = true;
            }
        }
      }
      for (const removeId of removeIds) this.managementBookmarks.delete(removeId);
      this.recordBuiltInManagement('bookmarks', method, values, before, { removed: [...removeIds] });
      return toolJson(null);
    } else return toolText(`ZEUS_BROWSER_MANAGEMENT_METHOD_BLOCKED: Bookmark method is not allowlisted: ${method}`, false);
    this.recordBuiltInManagement('bookmarks', method, values, before, entry);
    return toolJson(entry);
  }

  private invokeBuiltInManagementTabGroups(method: string, args: Record<string, unknown>): ReturnType<typeof toolJson> | ReturnType<typeof toolText> {
    const values = Array.isArray(args.args) ? args.args : [];
    const projection = (group: ManagedBrowserTabGroup): Record<string, unknown> => ({ ...group, tabIds: group.tabIds.filter((tabId) => this.tabs.has(tabId)) });
    if (method === 'query') {
      const query = asRecord(values[0]);
      return toolJson(
        [...this.managementTabGroups.values()]
          .filter((group) => (query.title === undefined || group.title.includes(String(query.title))) && (query.color === undefined || group.color === query.color) && (query.collapsed === undefined || group.collapsed === query.collapsed))
          .map(projection),
      );
    }
    const id = String(values[0] ?? '');
    const group = this.managementTabGroups.get(id);
    if (!group) return toolText('ZEUS_BROWSER_TAB_GROUP_MISSING: The requested tab group no longer exists.', false);
    if (method === 'get') return toolJson(projection(group));
    const before = projection(group);
    if (method === 'move') group.index = boundedInteger(asRecord(values[1]).index, group.index, 0, 10_000);
    else if (method === 'update') {
      const changes = asRecord(values[1]);
      if (typeof changes.title === 'string') group.title = changes.title.slice(0, 1_000);
      if (typeof changes.color === 'string') group.color = changes.color;
      if (typeof changes.collapsed === 'boolean') group.collapsed = changes.collapsed;
    } else return toolText(`ZEUS_BROWSER_MANAGEMENT_METHOD_BLOCKED: Tab-group method is not allowlisted: ${method}`, false);
    this.recordBuiltInManagement('tabGroups', method, values, before, projection(group));
    return toolJson(projection(group));
  }

  private async invokeBuiltInManagementTabs(input: BrowserAutomationToolCall, method: string, args: Record<string, unknown>): Promise<ReturnType<typeof toolJson> | ReturnType<typeof toolText>> {
    const values = Array.isArray(args.args) ? args.args : [];
    const owned = (): LiveBrowserTab[] => [...this.tabs.values()].filter((tab) => tab.snapshot.conversationId === input.conversationId);
    const projection = (tab: LiveBrowserTab): Record<string, unknown> => {
      const groupId = [...this.managementTabGroups.values()].find((group) => group.tabIds.includes(tab.snapshot.id))?.id ?? '-1';
      return {
        id: tab.snapshot.id,
        title: tab.snapshot.title,
        url: tab.snapshot.url,
        status: tab.snapshot.loading ? 'loading' : 'complete',
        active: this.activeTabByConversation.get(input.conversationId) === tab.snapshot.id,
        groupId,
        documentGeneration: tab.documentGeneration,
      };
    };
    if (method === 'query') {
      const query = asRecord(values[0]);
      return toolJson(
        owned()
          .filter((tab) => query.active === undefined || Boolean(query.active) === (this.activeTabByConversation.get(input.conversationId) === tab.snapshot.id))
          .map(projection),
      );
    }
    if (method === 'get') return toolJson(projection(this.requireConversationTab(input.conversationId, String(values[0]))));
    if (method === 'group') {
      const options = asRecord(values[0]);
      const tabIds = (Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds]).filter((value): value is string => typeof value === 'string');
      for (const tabId of tabIds) this.requireConversationTab(input.conversationId, tabId);
      const existingId = optionalString(options.groupId);
      const group = existingId ? this.managementTabGroups.get(existingId) : undefined;
      const target = group ?? { id: `tab-group-${randomUUID()}`, title: '', color: 'grey', collapsed: false, tabIds: [], index: this.managementTabGroups.size };
      const before = group ? { ...group, tabIds: [...group.tabIds] } : null;
      target.tabIds = [...new Set([...target.tabIds, ...tabIds])];
      this.managementTabGroups.set(target.id, target);
      this.recordBuiltInManagement('tabs', method, values, before, { ...target, tabIds: [...target.tabIds] });
      return toolJson(target.id);
    }
    const ids = (Array.isArray(values[0]) ? values[0] : [values[0]]).filter((value): value is string => typeof value === 'string');
    if (method === 'ungroup') {
      for (const group of this.managementTabGroups.values()) group.tabIds = group.tabIds.filter((tabId) => !ids.includes(tabId));
      this.recordBuiltInManagement('tabs', method, values, ids, { ungrouped: ids });
      return toolJson(null);
    }
    const tab = this.requireConversationTab(input.conversationId, requireNonEmptyString(values[0], 'args[0]'));
    const before = projection(tab);
    if (method === 'update') {
      const changes = asRecord(values[1]);
      if (typeof changes.url === 'string') {
        const url = normalizeBrowserUrl(changes.url);
        this.assertAgentUrlAllowed(url);
        await this.ensureView(tab).webContents.loadURL(url);
        await this.waitForTabReady(tab, 30_000);
      }
      if (changes.active === true) this.activeTabByConversation.set(input.conversationId, tab.snapshot.id);
    } else if (method !== 'move') return toolText(`ZEUS_BROWSER_MANAGEMENT_METHOD_BLOCKED: Tab method is not allowlisted: ${method}`, false);
    const after = projection(tab);
    this.recordBuiltInManagement('tabs', method, values, before, after);
    return toolJson(after);
  }

  private recordBuiltInManagement(area: ManagedBrowserAuditEntry['area'], method: string, args: unknown[], before: unknown, after: unknown): void {
    this.managementAudit.push({ id: `management-${randomUUID()}`, area, method, arguments: args, before, after, createdAt: this.now() });
    if (this.managementAudit.length > 500) this.managementAudit.splice(0, this.managementAudit.length - 500);
    this.schedulePersist();
  }

  private requireAdvancedHandle(input: BrowserAutomationToolCall, id: string): AdvancedBrowserHandle {
    const handle = this.advancedHandles.get(id);
    if (!handle || handle.conversationId !== input.conversationId || handle.turnId !== input.turnId) {
      throw Object.assign(new Error('The Browser remote handle is missing, released, or belongs to another turn.'), { code: 'ZEUS_BROWSER_HANDLE_STALE' });
    }
    if (handle.tabId) {
      const tab = this.tabs.get(handle.tabId);
      if (!tab || handle.documentGeneration !== tab.documentGeneration) {
        this.advancedHandles.delete(id);
        throw Object.assign(new Error('The Browser remote handle became stale after navigation or tab close.'), { code: 'ZEUS_BROWSER_HANDLE_STALE' });
      }
    }
    return handle;
  }

  private async resolveAdvancedTab(input: BrowserAutomationToolCall, handle: AdvancedBrowserHandle | undefined, args: Record<string, unknown>): Promise<LiveBrowserTab> {
    if (handle?.tabId) return this.requireConversationTab(input.conversationId, handle.tabId);
    return this.resolveToolTab(input.conversationId, optionalString(args.tabId));
  }

  private expireAdvancedHandlesOutsideTurn(conversationId: string, turnId: string): void {
    for (const [id, handle] of this.advancedHandles) {
      if (handle.conversationId === conversationId && handle.turnId !== turnId) this.advancedHandles.delete(id);
    }
  }

  private invalidateAdvancedHandlesForTab(tabId: string): void {
    for (const [id, handle] of this.advancedHandles) {
      if (handle.tabId === tabId) this.advancedHandles.delete(id);
    }
  }

  private advancedCapabilities(): { browser: Array<{ id: string; description: string }>; tab: Array<{ id: string; description: string }> } {
    return {
      browser: this.builtInBrowserCapabilities(),
      tab: this.builtInTabCapabilities(),
    };
  }

  private builtInBrowserCapabilities(): Array<{ id: string; description: string }> {
    return [
      { id: 'management', description: 'Allowlisted Zeus bookmark, tab-group, and tab organization with a persistent audit trail.' },
      { id: 'visibility', description: 'Present or hide the Zeus built-in browser.' },
      { id: 'viewport', description: 'Apply a temporary Chromium viewport override.' },
    ];
  }

  private builtInTabCapabilities(): Array<{ id: string; description: string }> {
    return [
      { id: 'cdp', description: 'Approved raw Chrome DevTools Protocol access.' },
      { id: 'browserAuth', description: 'Secure, model-invisible browser credential handoff.' },
      { id: 'pageAssets', description: 'Inventory and bundle current page assets.' },
      { id: 'webmcp', description: 'Discover page-defined WebMCP tools when the page exposes them.' },
      { id: 'botDetection', description: 'Report a visible site-served bot-detection blocker.' },
    ];
  }

  private builtInBrowserCapabilityKind(id: string): string | null {
    return id === 'management' ? 'ManagementBrowserCapability' : id === 'visibility' ? 'VisibilityBrowserCapability' : id === 'viewport' ? 'ViewportBrowserCapability' : null;
  }

  private builtInTabCapabilityKind(id: string): string | null {
    const kinds: Record<string, string> = {
      cdp: 'CdpTabCapability',
      browserAuth: 'BrowserAuthTabCapability',
      pageAssets: 'PageAssetsTabCapability',
      webmcp: 'WebMcpTabCapability',
      botDetection: 'BotDetectionTabCapability',
    };
    return kinds[id] ?? null;
  }

  private openAdvancedTabClaims(input: BrowserAutomationToolCall): Array<Record<string, unknown>> {
    const tabs = [...this.tabs.values()].filter((tab) => tab.snapshot.conversationId === input.conversationId);
    return tabs.map((tab) => {
      const claim: AdvancedTabClaim = {
        conversationId: input.conversationId,
        tabId: tab.snapshot.id,
        title: tab.snapshot.title,
        url: tab.snapshot.url,
        documentGeneration: tab.documentGeneration,
        claimToken: randomUUID(),
        createdAt: Date.now(),
      };
      this.advancedTabClaims.set(`${input.conversationId}:${tab.snapshot.id}`, claim);
      return {
        id: claim.tabId,
        providerTabId: claim.tabId,
        lastOpened: tab.snapshot.updatedAt,
        browserId: 'zeus-built-in',
        tabId: claim.tabId,
        title: claim.title,
        url: claim.url,
        documentGeneration: claim.documentGeneration,
        claimToken: claim.claimToken,
      };
    });
  }

  private claimAdvancedTab(input: BrowserAutomationToolCall, args: Record<string, unknown>): ReturnType<typeof toolJson> {
    const requested = typeof args.tab === 'string' ? { id: args.tab } : asRecord(args.tab);
    const tabId = requireNonEmptyString(requested.id ?? requested.tabId, 'tab.id');
    const claim = this.advancedTabClaims.get(`${input.conversationId}:${tabId}`);
    const tab = this.requireConversationTab(input.conversationId, tabId);
    const exact =
      claim &&
      Date.now() - claim.createdAt <= 30_000 &&
      (requested.providerTabId === undefined || requested.providerTabId === 'zeus-built-in') &&
      (requested.claimToken === undefined || requested.claimToken === claim.claimToken) &&
      (requested.title === undefined || requested.title === claim.title) &&
      (requested.url === undefined || requested.url === claim.url) &&
      (requested.documentGeneration === undefined || Number(requested.documentGeneration) === claim.documentGeneration) &&
      tab.snapshot.title === claim.title &&
      tab.snapshot.url === claim.url &&
      tab.documentGeneration === claim.documentGeneration;
    if (!exact) throw Object.assign(new Error('The tab identity no longer matches the latest openTabs result.'), { code: 'ZEUS_BROWSER_TAB_CLAIM_STALE' });
    this.advancedTabClaims.delete(`${input.conversationId}:${tabId}`);
    return toolJson(this.createAdvancedHandle(input, 'Tab', tab));
  }

  private async extractTemporaryTabsContent(input: BrowserAutomationToolCall, options: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const urls = Array.isArray(options.urls) ? options.urls.filter((value): value is string => typeof value === 'string').slice(0, 20) : [];
    if (urls.length === 0) throw Object.assign(new Error('Tabs.content requires at least one URL.'), { code: 'ZEUS_BROWSER_ARGUMENT_INVALID' });
    const contentType = ['html', 'text', 'domSnapshot'].includes(String(options.contentType)) ? String(options.contentType) : 'text';
    const timeoutMs = boundedInteger(options.timeoutMs, 30_000, 0, 120_000);
    const window = this.preferredWindow(input.conversationId);
    const results: Array<Record<string, unknown>> = [];
    for (const requestedUrl of urls) {
      let tab: LiveBrowserTab | undefined;
      try {
        const url = normalizeBrowserUrl(requestedUrl);
        this.assertAgentUrlAllowed(url);
        const snapshot = await this.openTab(window, { conversationId: input.conversationId, url });
        tab = this.requireConversationTab(input.conversationId, snapshot.activeTabId!);
        await this.waitForTabReady(tab, timeoutMs);
        /** 快照导出只保存 CUA 观察正文；失败结果不能伪装成页面内容。 */
        let content: string;
        if (contentType === 'domSnapshot') {
          const observed = await this.cua.invoke({ ...input, tool: 'snapshot', arguments: { tabId: tab.snapshot.id, maxElements: 300 } }, this.cuaSurface(tab));
          if (!observed.success) throw new Error('CUA 无法读取当前页面。');
          content = observed.contentItems
            .filter((item) => item.type === 'inputText')
            .map((item) => item.text)
            .join('\n');
        } else {
          content = (await this.ensureView(tab).webContents.executeJavaScript(contentType === 'html' ? 'document.documentElement.outerHTML' : 'document.body?.innerText || ""', true)) as string;
        }
        results.push({ content: String(content).slice(0, 2_000_000), title: tab.snapshot.title || null, url: tab.snapshot.url || requestedUrl });
      } catch {
        results.push({ content: null, title: tab?.snapshot.title ?? null, url: tab?.snapshot.url ?? requestedUrl });
      } finally {
        if (tab && this.tabs.has(tab.snapshot.id)) await this.closeTab(window, input.conversationId, tab.snapshot.id);
      }
    }
    return results;
  }

  private listAdvancedTabs(input: BrowserAutomationToolCall): Array<Record<string, unknown>> {
    return [...this.tabs.values()]
      .filter((tab) => tab.snapshot.conversationId === input.conversationId)
      .map((tab) => ({
        ...this.createAdvancedHandle(input, 'Tab', tab),
        id: tab.snapshot.id,
        title: tab.snapshot.title,
        url: tab.snapshot.url,
        loading: tab.snapshot.loading,
      }));
  }

  private async waitForTabReady(tab: LiveBrowserTab, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (tab.snapshot.loading || this.ensureView(tab).webContents.isLoading()) {
      if (Date.now() - startedAt >= timeoutMs) throw Object.assign(new Error(`Timed out waiting for browser tab ${tab.snapshot.id} to finish loading.`), { code: 'ZEUS_BROWSER_LOAD_TIMEOUT' });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }

  private async updateSettings(input: unknown): Promise<void> {
    this.assertWritableBrowserCapability();
    const previousDownloadDirectory = this.settings.downloadDirectory;
    this.settings = normalizeSettings(input, this.settings);
    if (this.options.configureExternalBrowsers) {
      const external = await this.options.configureExternalBrowsers(this.settings);
      this.settings = { ...this.settings, externalConnectionState: external.state, ...(external.detail ? { externalConnectionDetail: external.detail } : {}) };
    }
    if (this.settings.downloadDirectory !== previousDownloadDirectory) {
      // 只有用户明确修改下载路径时才触碰目标目录，普通浏览器设置不得扩大本机文件权限。
      await mkdir(this.settings.downloadDirectory, { recursive: true });
    }
    if (!this.settings.enabled) {
      for (const tabId of [...this.visibleTabByWindow.values()]) this.detachTab(tabId);
    }
    this.schedulePersist();
  }

  private async clearBrowsingData(): Promise<void> {
    this.assertWritableBrowserCapability();
    await this.browserSession.clearCache();
    await this.browserSession.clearStorageData();
    await this.browserSession.clearAuthCache();
    await rm(this.attachmentRoot, { recursive: true, force: true });
    await mkdir(this.attachmentRoot, { recursive: true, mode: 0o700 });
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timer);
      pending.resolve('deny');
    }
    this.pendingApprovals.clear();
    this.grantedWebPermissions.clear();
    this.downloads.length = 0;
    for (const tab of this.tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        await tab.view.webContents.loadURL('about:blank');
        tab.view.webContents.navigationHistory.clear();
      }
      tab.snapshot = {
        ...tab.snapshot,
        url: 'about:blank',
        title: 'New tab',
        comments: [],
        annotationMode: false,
        updatedAt: this.now(),
      };
    }
    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer);
      this.persistenceTimer = undefined;
    }
    await this.persist();
    for (const conversationId of new Set([...this.tabs.values()].map((tab) => tab.snapshot.conversationId))) this.emitSnapshot(conversationId);
  }

  private schedulePersist(): void {
    if (this.closed || this.options.readOnlyValidation) return;
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined;
      void this.persist();
    }, 150);
    this.persistenceTimer.unref();
  }

  private async flushPersistence(): Promise<void> {
    if (this.persistenceTimer) {
      clearTimeout(this.persistenceTimer);
      this.persistenceTimer = undefined;
    }
    await this.persist();
  }

  private persist(): Promise<void> {
    if (this.options.readOnlyValidation) return Promise.resolve();
    const operation = this.persistenceChain.then(() => this.writePersistedState());
    this.persistenceChain = operation.catch(() => undefined);
    return operation;
  }

  /** 写入长期偏好，不保存下次启动会重新打开的标签数据。 */
  private async writePersistedState(): Promise<void> {
    const value: PersistedBrowserState = {
      version: 1,
      settings: this.settings,
      managementBookmarks: [...this.managementBookmarks.values()],
      managementAudit: this.managementAudit.slice(-500),
    };
    const directoryPath = dirname(this.statePath);
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishFile(temporaryPath, this.statePath, { replace: true });
  }

  private assertWritableBrowserCapability(): void {
    if (!this.options.readOnlyValidation) return;
    throw Object.assign(new Error('只读验证模式禁止浏览器导航、下载、自动化和状态修改。'), {
      code: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
      statusCode: 503,
    });
  }
}

export function createBrowserHost(options: CreateBrowserHostOptions): BrowserHost {
  return new BrowserHost(options);
}

/**
 * 用户主动打开的网页由 Chromium 自己呈现网络、证书和协议失败页。
 * `loadURL` 对同一次失败还会拒绝 Promise；这里消费该拒绝，避免把页面级错误重复提升为 Zeus 全局错误弹窗。
 */
async function loadUserFacingBrowserUrl(webContents: WebContents, url: string): Promise<void> {
  try {
    await webContents.loadURL(url);
  } catch {
    // 浏览器页面已经展示可诊断的失败状态，Zeus 不再叠加模态遮罩。
  }
}

function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  if (/\s/u.test(trimmed) && !/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  const withProtocol = /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(:\d+)?(?:\/|$)/iu.test(trimmed) ? `http://${trimmed}` : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (!['http:', 'https:', 'file:', 'about:'].includes(url.protocol)) throw new TypeError(`Unsupported browser URL protocol: ${url.protocol}`);
  if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) throw new TypeError('Browser URLs with embedded credentials are not allowed.');
  if (url.protocol === 'about:' && url.href !== 'about:blank') throw new TypeError('Only about:blank is allowed.');
  return url.href;
}

function normalizeJsDialogType(value: unknown): ActiveBrowserJsDialog['type'] {
  return value === 'beforeunload' || value === 'confirm' || value === 'prompt' ? value : 'alert';
}

function jsDialogHandleKind(type: ActiveBrowserJsDialog['type']): ActiveBrowserJsDialog['kind'] {
  if (type === 'beforeunload') return 'BeforeUnloadDialog';
  if (type === 'confirm') return 'ConfirmDialog';
  if (type === 'prompt') return 'PromptDialog';
  return 'AlertDialog';
}

function normalizeExternalWebUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeBounds(value: unknown): Rectangle {
  const record = asRecord(value);
  const x = Math.max(0, Math.round(finiteNumber(record.x, 0)));
  const y = Math.max(0, Math.round(finiteNumber(record.y, 0)));
  const width = Math.max(1, Math.round(finiteNumber(record.width, 1)));
  const height = Math.max(1, Math.round(finiteNumber(record.height, 1)));
  return { x, y, width, height };
}

function normalizeApprovalDecision(value: unknown): ZeusBrowserApprovalDecision {
  if (value === 'allow_once' || value === 'deny') return value;
  throw new TypeError('Browser approval decision is invalid.');
}

function normalizeSettings(value: unknown, fallback: ZeusBrowserSettings): ZeusBrowserSettings {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const downloadDirectory = typeof record.downloadDirectory === 'string' && isAbsolute(record.downloadDirectory.trim()) ? resolve(record.downloadDirectory.trim()) : fallback.downloadDirectory;
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    translationServiceId: typeof record.translationServiceId === 'string' && record.translationServiceId.length > 0 && record.translationServiceId.length <= 2000 ? record.translationServiceId : fallback.translationServiceId,
    downloadDirectory,
    askWhereToSave: typeof record.askWhereToSave === 'boolean' ? record.askWhereToSave : fallback.askWhereToSave,
    screenshotMode: record.screenshotMode === 'necessary' ? 'necessary' : record.screenshotMode === 'always' ? 'always' : fallback.screenshotMode,
    webLinkOpenTarget: webLinkOpenTarget(record.webLinkOpenTarget) ?? fallback.webLinkOpenTarget,
    localWebOpenTarget: webLinkOpenTarget(record.localWebOpenTarget) ?? fallback.localWebOpenTarget,
    fileOpenTarget: fileOpenTarget(record.fileOpenTarget) ?? fallback.fileOpenTarget,
    externalChromeEnabled: typeof record.externalChromeEnabled === 'boolean' ? record.externalChromeEnabled : fallback.externalChromeEnabled,
    externalEdgeEnabled: typeof record.externalEdgeEnabled === 'boolean' ? record.externalEdgeEnabled : fallback.externalEdgeEnabled,
    externalConnectionState:
      record.externalConnectionState === 'waiting' || record.externalConnectionState === 'connected' || record.externalConnectionState === 'store_id_pending' || record.externalConnectionState === 'error'
        ? record.externalConnectionState
        : record.externalConnectionState === 'disabled'
          ? 'disabled'
          : fallback.externalConnectionState,
    ...(optionalString(record.externalConnectionDetail) ? { externalConnectionDetail: optionalString(record.externalConnectionDetail) } : {}),
  };
}

function webLinkOpenTarget(value: unknown): ZeusBrowserSettings['webLinkOpenTarget'] | null {
  return value === 'zeus_browser' || value === 'system_default' ? value : null;
}

function fileOpenTarget(value: unknown): ZeusBrowserSettings['fileOpenTarget'] | null {
  return value === 'zeus_source' || value === 'system_default' || value === 'editor:vscode' || value === 'editor:vscode-insiders' || value === 'editor:cursor' || value === 'editor:windsurf' ? value : null;
}

function normalizePageAnchor(value: unknown): ZeusBrowserPageAnchor {
  const record = asRecord(value);
  const kind = record.kind === 'text' || record.kind === 'region' ? record.kind : record.kind === 'element' ? 'element' : null;
  if (!kind) throw new TypeError('Browser page anchor kind is invalid.');
  const rect = normalizeAnchorRect(record.rect);
  const markerRecord = record.marker && typeof record.marker === 'object' ? asRecord(record.marker) : null;
  const viewport = asRecord(record.viewport);
  const scroll = asRecord(record.scroll);
  const textRangeRecord = record.textRange && typeof record.textRange === 'object' ? asRecord(record.textRange) : null;
  return {
    kind,
    pageUrl: requireString(record.pageUrl, 'pageUrl').slice(0, 8_000),
    frameUrl: requireString(record.frameUrl, 'frameUrl').slice(0, 8_000),
    pageTitle: requireString(record.pageTitle, 'pageTitle').slice(0, 1_000),
    ...(optionalString(record.selector) ? { selector: optionalString(record.selector)!.slice(0, 4_000) } : {}),
    ...(optionalString(record.elementPath) ? { elementPath: optionalString(record.elementPath)!.slice(0, 8_000) } : {}),
    ...(Array.isArray(record.shadowHostPath)
      ? {
          shadowHostPath: record.shadowHostPath
            .filter((entry): entry is string => typeof entry === 'string')
            .slice(0, 20)
            .map((entry) => entry.slice(0, 1_000)),
        }
      : {}),
    frameDepth: boundedInteger(record.frameDepth, 0, 0, 32),
    ...(optionalString(record.role) ? { role: optionalString(record.role)!.slice(0, 200) } : {}),
    ...(optionalString(record.accessibleName) ? { accessibleName: optionalString(record.accessibleName)!.slice(0, 1_000) } : {}),
    ...(optionalString(record.tagName) ? { tagName: optionalString(record.tagName)!.slice(0, 100) } : {}),
    ...(optionalString(record.immediateText) ? { immediateText: optionalString(record.immediateText)!.slice(0, 4_000) } : {}),
    ...(optionalString(record.nearbyText) ? { nearbyText: optionalString(record.nearbyText)!.slice(0, 4_000) } : {}),
    rect,
    ...(markerRecord
      ? {
          marker: {
            x: finiteNumber(markerRecord.x, rect.x + rect.width / 2),
            y: finiteNumber(markerRecord.y, rect.y),
          },
        }
      : {}),
    ...(textRangeRecord
      ? {
          textRange: {
            text: requireString(textRangeRecord.text, 'selected text').slice(0, 20_000),
            ...(optionalString(textRangeRecord.startSelector) ? { startSelector: optionalString(textRangeRecord.startSelector)!.slice(0, 4_000) } : {}),
            ...(Number.isInteger(textRangeRecord.startOffset) ? { startOffset: Math.max(0, Number(textRangeRecord.startOffset)) } : {}),
            ...(optionalString(textRangeRecord.endSelector) ? { endSelector: optionalString(textRangeRecord.endSelector)!.slice(0, 4_000) } : {}),
            ...(Number.isInteger(textRangeRecord.endOffset) ? { endOffset: Math.max(0, Number(textRangeRecord.endOffset)) } : {}),
            ...(textRangeRecord.direction === 'backward' ? { direction: 'backward' as const } : { direction: 'forward' as const }),
            rects: Array.isArray(textRangeRecord.rects) ? textRangeRecord.rects.slice(0, 200).map(normalizeAnchorRect) : [rect],
          },
        }
      : {}),
    viewport: {
      width: Math.max(1, finiteNumber(viewport.width, 1)),
      height: Math.max(1, finiteNumber(viewport.height, 1)),
      deviceScaleFactor: Math.max(0.1, finiteNumber(viewport.deviceScaleFactor, 1)),
    },
    scroll: { x: finiteNumber(scroll.x, 0), y: finiteNumber(scroll.y, 0) },
    fixed: record.fixed === true,
  };
}

function normalizeAnchorRect(value: unknown) {
  const record = asRecord(value);
  return {
    x: finiteNumber(record.x, 0),
    y: finiteNumber(record.y, 0),
    width: Math.max(0, finiteNumber(record.width, 0)),
    height: Math.max(0, finiteNumber(record.height, 0)),
  };
}

function normalizeDesignChanges(value: unknown): ZeusBrowserDesignChange[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (record.kind !== 'text' && record.kind !== 'style') return [];
    if (typeof record.previous !== 'string' || typeof record.next !== 'string') return [];
    return [
      {
        kind: record.kind,
        ...(optionalString(record.selector) ? { selector: optionalString(record.selector)!.slice(0, 4_000) } : {}),
        ...(optionalString(record.property) ? { property: optionalString(record.property)!.slice(0, 200) } : {}),
        previous: record.previous.slice(0, 20_000),
        next: record.next.slice(0, 20_000),
      },
    ];
  });
}

function nextCommentNumber(comments: ZeusBrowserComment[]): number {
  return comments.reduce((maximum, comment) => Math.max(maximum, comment.number), 0) + 1;
}

/** 用 Chromium 的文档来源校验目标，拒绝继承来源的空白页和不透明的沙箱 frame。 */
function browserPasswordFrameOrigin(contents: WebContents, frame: WebFrameMain | null): string | undefined {
  if (!frame || contents.isDestroyed() || frame.isDestroyed() || frame.detached || frame.top?.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId) return undefined;
  try {
    const origin = browserPasswordOrigin(frame.url);
    return frame.origin === origin ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** 单次消息端口把命令定位到目标 preload，并在 frame 离开或失去响应时结束等待。 */
function requestBrowserPasswordFrame(frame: WebFrameMain, request: BrowserPasswordFrameRequest): Promise<unknown> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannelMain();
    /** 只等待 frame 探测或填充回执，用户选择账号的时间不在此限制内。 */
    const timeout = setTimeout(() => finish('unavailable'), 5000);
    /** 回复、断开及超时共用清理。 */
    const finish = (result: unknown): void => {
      clearTimeout(timeout);
      resolve(result);
      port1.removeAllListeners();
      port1.close();
    };
    port1.once('message', ({ data }) => finish(data));
    port1.once('close', () => finish('unavailable'));
    port1.start();
    try {
      frame.postMessage('zeus:browser-page:password-frame', request, [port2]);
    } catch {
      port2.close();
      finish('unavailable');
    }
  });
}

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'file:' ? 'file://' : url.origin;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object.');
  return value as Record<string, unknown>;
}

/** 只保留宿主产品能力；页面定位、输入和观察统一由 CUA 提供。 */
function isHostBrowserMethod(path: string): boolean {
  return !/^(?:AXAPI|CUAAPI|DomCUAAPI|PlaywrightAPI|PlaywrightFrameLocator|PlaywrightLocator|PlaywrightDownload|PlaywrightFileChooser)\./u.test(path) && !['Tab.ax', 'Tab.cua', 'Tab.dom_cua', 'Tab.playwright'].includes(path);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string.`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const text = requireString(value, field).trim();
  if (!text) throw new TypeError(`${field} must not be empty.`);
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function parseDateBound(value: unknown, fallback: number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function secureHtmlInputType(value: unknown): 'text' | 'email' | 'tel' | 'password' {
  const type = typeof value === 'string' ? value.toLocaleLowerCase() : 'text';
  if (type === 'email' || type === 'tel' || type === 'password') return type;
  return 'text';
}

function toolText(text: string, success: boolean): { contentItems: BrowserAutomationContentItem[]; success: boolean } {
  return { contentItems: [{ type: 'inputText', text }], success };
}

function toolJson(value: unknown): { contentItems: BrowserAutomationContentItem[]; success: true } {
  return toolText(JSON.stringify(value, null, 2), true) as {
    contentItems: BrowserAutomationContentItem[];
    success: true;
  };
}

function browserConsoleLevel(level: number): 'debug' | 'info' | 'warn' | 'error' {
  if (level >= 3) return 'error';
  if (level === 2) return 'warn';
  if (level === 1) return 'info';
  return 'debug';
}

function normalizeAdvancedArguments(args: Record<string, unknown>): Record<string, unknown> {
  const options = isPlainRecord(args.options) ? args.options : {};
  return Object.keys(options).length > 0 ? { ...options, ...args } : args;
}

const exportPageContentScript = function exportPageContent(format: string) {
  const text = (document.body?.innerText || '').trim();
  const html = document.documentElement?.outerHTML || '';
  return {
    title: document.title,
    url: location.href,
    format,
    content: format === 'html' ? html.slice(0, 2_000_000) : text.slice(0, 2_000_000),
    characterCount: format === 'html' ? html.length : text.length,
    truncated: (format === 'html' ? html.length : text.length) > 2_000_000,
  };
}.toString();

const exportYouTubeTranscriptScript = function exportYouTubeTranscript() {
  const segments = [...document.querySelectorAll('ytd-transcript-segment-renderer, ytd-transcript-segment-list-renderer [class*="segment"]')];
  const lines = segments
    .map((segment) => {
      const timestamp = (segment.querySelector('[class*="timestamp"]')?.textContent || '').trim();
      const text = (segment.querySelector('[class*="segment-text"]')?.textContent || segment.textContent || '').replace(/\s+/gu, ' ').trim();
      return timestamp && text ? `${timestamp}\t${text.replace(timestamp, '').trim()}` : text;
    })
    .filter(Boolean);
  return { title: document.title, url: location.href, text: lines.join('\n') };
}.toString();
