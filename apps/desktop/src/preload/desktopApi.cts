import { createRendererBootstrapReporter, shouldReportRendererWindowError } from './rendererBootstrapState.cjs';

/** 桌面界面与宿主的通信契约；不向网页暴露底层通信对象。 */
export interface DesktopTransport {
  /** 命令来源标记；宿主仍须独立校验窗口身份及命令权限。 */
  readonly kind: 'electron-ipc' | 'chromium-native';
  /** 调用已登记的桌面方法，保留附件的二进制载荷。 */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** 发送无需响应的界面生命周期或状态通知。 */
  send(channel: string, ...args: unknown[]): void;
  /** 订阅业务载荷，返回准确释放本次订阅的函数。 */
  subscribe<T>(channel: string, listener: (value: T) => void): () => void;
  /** 获取用户选中文件的宿主路径；无路径时由既有物化链路处理。 */
  getPathForFile(file: File): string;
}

/** 为可信 Zeus 界面创建同一套桌面接口；每个界面上下文只初始化一次。 */
export function createDesktopApi(transport: DesktopTransport) {
  /** 主进程命令已支持的授权范围。 */
  type MainCommandScopeKind = 'project' | 'product_conversation' | 'approval' | 'git_repository' | 'artifact' | 'settings' | 'execution_host';

  /** 清除范围标识中的控制字符，沿用既有命令身份规则。 */
  function mainCommandScopeId(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const normalized = Array.from(value.trim())
      .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      })
      .join('')
      .slice(0, 256);
    return normalized || fallback;
  }

  /** 将受保护写操作封装为可审计、可去重的用户命令。 */
  async function invokeMainCommand(channel: string, commandType: string, scopeKind: MainCommandScopeKind, scopeId: string, body: unknown = null): Promise<unknown> {
    const commandId = globalThis.crypto.randomUUID();
    const envelope = Object.freeze({
      schemaGeneration: 'zeus-command-envelope-v1',
      commandId,
      commandType,
      actor: Object.freeze({ kind: 'user', id: 'desktop-renderer-user' }),
      scope: Object.freeze({ kind: scopeKind, id: mainCommandScopeId(scopeId, 'desktop-main') }),
      expectedRevision: null,
      idempotencyKey: `desktop-renderer:${commandId}`,
      issuedAt: new Date().toISOString(),
      payload: Object.freeze({ transport: transport.kind, channel }),
    });
    /** 核对与首次执行使用同一载荷，禁止生成新的命令身份。 */
    const request = Object.freeze({ envelope, body });
    try {
      return await transport.invoke(channel, request);
    } catch (error) {
      if (!['desktop.conversation_resources.choose', 'desktop.conversation_resources.store_paths', 'desktop.conversation_resources.materialize', 'desktop.conversation_resources.read_clipboard'].includes(commandType)) throw error;
      /** 核对入口只读副本和回执；核对本身失败时保留首次错误。 */
      const recovery = (await transport.invoke('zeus:reconcile-conversation-resources', request).catch(() => null)) as { recovered?: boolean; value?: unknown; error?: string } | null;
      if (recovery?.recovered) {
        if (typeof recovery.error === 'string') throw new Error(recovery.error);
        return recovery.value;
      }
      throw error;
    }
  }

  /** 为项目源码操作绑定所属项目。 */
  function invokeProjectSourceCommand(channel: string, commandType: string, input: unknown): Promise<unknown> {
    const candidate = input && typeof input === 'object' && !Array.isArray(input) ? (input as { projectId?: unknown }) : {};
    return invokeMainCommand(channel, commandType, 'project', mainCommandScopeId(candidate.projectId, 'project-source'), input);
  }

  /** 为浏览器操作绑定所属会话。 */
  function invokeBrowserConversationCommand(channel: string, commandType: string, input: unknown): Promise<unknown> {
    const candidate = input && typeof input === 'object' && !Array.isArray(input) ? (input as { conversationId?: unknown }) : {};
    return invokeMainCommand(channel, commandType, 'product_conversation', mainCommandScopeId(candidate.conversationId, 'browser-conversation'), input);
  }

  /** 读取剪贴板并复用受授权的附件存储链路。 */
  async function readTaskClipboardResources(): Promise<{ resources: unknown[]; text: string }> {
    const raw = (await transport.invoke('zeus:read-task-clipboard-resources')) as { paths?: unknown; attachments?: unknown; text?: unknown };
    const paths = Array.isArray(raw?.paths) ? raw.paths.filter((path): path is string => typeof path === 'string') : [];
    const attachments = Array.isArray(raw?.attachments) ? raw.attachments : [];
    if (paths.length > 0) {
      const resources = await invokeMainCommand('zeus:store-task-resource-paths', 'desktop.task_resources.store_paths', 'artifact', 'task-input-resources', paths);
      // 路径已变成附件，但正文里剩下的说明文字仍要回到输入框。
      return { resources: Array.isArray(resources) ? resources : [], text: typeof raw?.text === 'string' ? raw.text : '' };
    }
    if (attachments.length > 0) {
      const resources = await invokeMainCommand('zeus:materialize-task-resources', 'desktop.task_resources.materialize', 'artifact', 'task-input-resources', attachments);
      return { resources: Array.isArray(resources) ? resources : [], text: '' };
    }
    return { resources: [], text: typeof raw?.text === 'string' ? raw.text : '' };
  }

  /** 保留界面启动与运行失败的独立上报状态。 */
  const rendererBootstrapReporter = createRendererBootstrapReporter({
    send: (channel, message) => {
      if (message === undefined) transport.send(channel);
      else transport.send(channel, message);
    },
  });

  globalThis.addEventListener(
    'error',
    (event) => {
      if (!shouldReportRendererWindowError(rendererBootstrapReporter.getState(), event)) return;
      /** 资源加载失败没有 ErrorEvent.message，保留实际入口地址用于定位安装包缺失文件。 */
      const resource = event.target instanceof Element ? event.target.getAttribute('src') || event.target.getAttribute('href') : null;
      rendererBootstrapReporter.reportFailure(event.error ?? (event.message || `Renderer startup resource failed: ${resource ?? 'unknown'}`));
    },
    true,
  );
  globalThis.addEventListener('unhandledrejection', (event) => {
    rendererBootstrapReporter.reportFailure(event.reason);
  });

  /** 将用户粘贴或拖入的文件授权为当前输入资源。 */
  async function authorizePendingResourceFiles(
    files: File[],
    source: 'paste' | 'drop',
    pathChannel: string,
    materializeChannel: string,
  ): Promise<{
    resources: unknown[];
    failedCount: number;
    failureMessage?: string;
  }> {
    if (source === 'paste' && files.length === 1 && isUnsupportedPastedImage(files[0])) {
      const normalized =
        pathChannel === 'zeus:store-task-resource-paths'
          ? await readTaskClipboardResources()
          : ((await invokeMainCommand('zeus:read-conversation-clipboard-resources', 'desktop.conversation_resources.read_clipboard', 'artifact', 'conversation-input-resources')) as {
              resources?: unknown;
            });
      const resources = Array.isArray(normalized.resources) ? normalized.resources : [];
      if (resources.length > 0) return { resources, failedCount: 0 };
    }
    /** 有磁盘来源的文件继续通过宿主流式保存，不提前装入页面内存。 */
    const nativePaths: string[] = [];
    /** 无磁盘路径的图片从本次 File 读取，不重新访问剪贴板。 */
    const pathlessFiles: File[] = [];
    for (const file of files) {
      /** 路径仅从 Electron 文件对象提取，不接受页面自行声明路径。 */
      let nativePath = '';
      try {
        nativePath = transport.getPathForFile(file);
      } catch {
        // 截图/浏览器 Blob 没有稳定本地路径，转入 Main 物化链路。
      }
      if (nativePath) nativePaths.push(nativePath);
      else pathlessFiles.push(file);
    }
    /** 逐项保存读取结果，失败原因随同资源回执返回。 */
    const pathlessPayloadResults = await Promise.allSettled(
      pathlessFiles.map(async (file) => ({
        name: file.name,
        type: file.type,
        data: await file.arrayBuffer(),
        source,
      })),
    );
    /** 只有读取完整的内存内容才能交给宿主持久化。 */
    const pathlessPayloads = pathlessPayloadResults.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    /** 两类资源沿用各自命令身份，不因其中一类失败重放另一类。 */
    const storeNativePaths = (): Promise<unknown> => {
      if (!nativePaths.length) return Promise.resolve([]);
      if (pathChannel === 'zeus:store-task-resource-paths') {
        return invokeMainCommand(pathChannel, 'desktop.task_resources.store_paths', 'artifact', 'task-input-resources', nativePaths);
      }
      return invokeMainCommand(pathChannel, 'desktop.conversation_resources.store_paths', 'artifact', 'conversation-input-resources', { paths: nativePaths, source });
    };
    /** 二进制载荷沿用现有大小校验、副本保存与结果核对。 */
    const materializePayloads = (): Promise<unknown> => {
      if (!pathlessPayloads.length) return Promise.resolve([]);
      /** 会话与任务使用各自既有的保存通道。 */
      const conversation = materializeChannel === 'zeus:materialize-conversation-resources';
      return invokeMainCommand(
        materializeChannel,
        conversation ? 'desktop.conversation_resources.materialize' : 'desktop.task_resources.materialize',
        'artifact',
        conversation ? 'conversation-input-resources' : 'task-input-resources',
        pathlessPayloads,
      );
    };
    /** 两路独立导入都完成后再报告，保留成功资源及失败原因。 */
    const [authorizedResult, materializedResult] = await Promise.allSettled([storeNativePaths(), materializePayloads()]);
    /** 原生文件导入的成功结果。 */
    const authorized = authorizedResult.status === 'fulfilled' && Array.isArray(authorizedResult.value) ? authorizedResult.value : [];
    /** 无路径图片导入的成功结果。 */
    const materialized = materializedResult.status === 'fulfilled' && Array.isArray(materializedResult.value) ? materializedResult.value : [];
    /** 成功附件不能因为其他项失败而丢失。 */
    const resources = [...authorized, ...materialized];
    /** 读取错误与保存错误都保留，不再将异常转换成没有文件。 */
    const failures = [...pathlessPayloadResults, authorizedResult, materializedResult].filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    /** 首个真实原因足够定位本批失败，避免重复堆叠同类错误。 */
    const failureMessage = failures.length > 0 ? pendingResourceFailureMessage(failures[0]!.reason) : undefined;
    if (resources.length === 0 && failureMessage) throw new Error(failureMessage);
    return {
      resources,
      failedCount: Math.max(0, files.length - resources.length),
      ...(failureMessage ? { failureMessage } : {}),
    };
  }

  /** 跨上下文错误不依赖原型，保留宿主已提供的具体失败信息。 */
  function pendingResourceFailureMessage(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.trim()) return error.message;
    return typeof error === 'string' && error.trim() ? error : '附件读取或保存失败，未取得具体原因。';
  }

  function isUnsupportedPastedImage(file: File): boolean {
    const mimeType = file.type.trim().toLowerCase();
    if (['image/tiff', 'image/heic', 'image/heif', 'image/bmp'].includes(mimeType)) return true;
    return /\.(?:tiff?|heic|heif|bmp)$/iu.test(file.name);
  }

  return {
    /** 保留现有桌面应用名称。 */
    appName: 'Zeus',
    /** 读取会话存储迁移状态。 */
    getConversationStoreMigrationStatus: () => transport.invoke('zeus:conversation-store-migration:get-status'),
    /** 通过命令账本重试会话存储迁移。 */
    retryConversationStoreMigration: () => invokeMainCommand('zeus:conversation-store-migration:retry', 'desktop.conversation_store_migration.retry', 'execution_host', 'conversation-store-migration'),
    /** 打开当前迁移的诊断文件。 */
    openConversationStoreMigrationDiagnostics: () => transport.invoke('zeus:conversation-store-migration:open-diagnostics'),
    /** 退出处于存储迁移阶段的应用。 */
    exitConversationStoreMigration: () => transport.invoke('zeus:conversation-store-migration:exit'),
    /** 读取执行宿主维护状态。 */
    getExecutionHostMaintenanceStatus: () => transport.invoke('zeus:execution-host-maintenance:get-status'),
    /** 请求重新执行宿主维护启动流程。 */
    retryExecutionHostMaintenance: () => transport.invoke('zeus:execution-host-maintenance:retry'),
    /** 退出处于执行宿主维护阶段的应用。 */
    exitExecutionHostMaintenance: () => transport.invoke('zeus:execution-host-maintenance:exit'),
    /** 在启动失败后请求重启应用。 */
    restartAfterStartupFailure: () => transport.invoke('zeus:startup-failure:restart'),
    /** 在启动失败后退出应用。 */
    exitAfterStartupFailure: () => transport.invoke('zeus:startup-failure:exit'),
    /** 上报启动阶段及耗时，不包含业务正文。 */
    reportStartupSpan: (input: { stage: string; durationMs: number }) => transport.send('zeus:renderer-startup-span', input),
    /** 通知宿主主页已可交互。 */
    reportHomeInteractive: () => transport.send('zeus:renderer-home-interactive'),
    /** 读取宿主提供的初始界面设置。 */
    getStartupSettings: () => transport.invoke('zeus:startup-settings:get'),
    /** 读取当前界面获准使用的本地服务配置。 */
    getLocalServerConfig: () => transport.invoke('zeus:get-local-server-config'),
    /** 按项目与会话身份读取界面缓存。 */
    loadSessionViewCache: (identity: { projectId: string; conversationId: string }) => transport.invoke('zeus:session-view-cache:load', identity),
    /** 请求保存当前会话的界面缓存。 */
    persistSessionViewCache: (value: unknown) => transport.send('zeus:session-view-cache:persist', value),
    /** 执行存储恢复预检并请求重启。 */
    runStorageRecoveryPreflightAndRestart: () => invokeMainCommand('zeus:storage-recovery:preflight-and-restart', 'desktop.storage_recovery.preflight_restart', 'execution_host', 'storage-recovery'),
    /** 打开任务 Git 交付窗口。 */
    openTaskGitDeliveryWindow: (input: unknown) => transport.invoke('zeus:task-git-delivery:open', input),
    /** 关闭当前 Git 交付窗口。 */
    closeTaskGitDeliveryWindow: () => transport.invoke('zeus:task-git-delivery:close'),
    /** 读取交付窗口的当前任务上下文。 */
    getTaskGitDeliveryCurrentContext: () => transport.invoke('zeus:task-git-delivery:get-current-context'),
    /** 通知交付窗口上下文发生变化。 */
    notifyTaskGitDeliveryCurrentContext: (context: unknown) => transport.send('zeus:task-git-delivery:current-context-changed', context),
    /** 通知指定任务的 Git 交付状态发生变化。 */
    notifyTaskGitDeliveryChanged: (taskId: string) => transport.send('zeus:task-git-delivery:changed', taskId),
    /** 从交付窗口打开对应任务会话。 */
    openTaskGitDeliveryConversation: (input: unknown) => transport.invoke('zeus:task-git-delivery:open-conversation', input),
    /** 使用任务工作区及比较范围打开只读差异窗口。 */
    openTaskGitDiffWindow: (input: unknown) => transport.invoke('zeus:task-git-diff:open', input),
    /** 打开项目 Git 差异窗口。 */
    openProjectGitDiffWindow: (input: unknown) => transport.invoke('zeus:project-git-diff:open', input),
    /** 读取当前差异窗口的快照。 */
    loadProjectGitDiffSnapshot: () => transport.invoke('zeus:project-git-diff:load-snapshot'),
    /** 读取指定项目的 Git 工作台数据。 */
    loadProjectGitWorkbench: (projectId: string, includePatches = true) => transport.invoke('zeus:project-git:load-workbench', projectId, includePatches),
    /** 读取项目 Git 历史记录。 */
    loadProjectGitHistory: (input: unknown) => transport.invoke('zeus:project-git:load-history', input),
    /** 分页读取桌面工作台已落盘的操作记录，不触发 Git 执行。 */
    loadProjectGitOperations: (input: unknown) => transport.invoke('zeus:project-git:load-operations', input),
    /** 读取指定 Git 提交的内容。 */
    loadProjectGitCommit: (input: unknown) => transport.invoke('zeus:project-git:load-commit', input),
    /** 读取推送目标及待推送提交。 */
    loadProjectGitPushPreview: (input: unknown) => transport.invoke('zeus:project-git:load-push-preview', input),
    /** 读取指定比较范围的 Git 差异。 */
    loadProjectGitComparisonDiff: (input: unknown) => transport.invoke('zeus:project-git:load-comparison', input),
    /** 请求取消指定仓库中尚可取消的 Git 操作。 */
    cancelProjectGitAction: (repositoryId: string) => transport.invoke('zeus:project-git:cancel-action', repositoryId),
    /** 按仓库身份提交已授权的 Git 操作命令。 */
    executeProjectGitAction: (input: unknown) => {
      const candidate = input && typeof input === 'object' && !Array.isArray(input) ? (input as { repositoryId?: unknown }) : {};
      return invokeMainCommand('zeus:project-git:execute-action', 'desktop.project_git.execute_action', 'git_repository', mainCommandScopeId(candidate.repositoryId, 'project-git'), input);
    },
    /** 订阅交付窗口当前任务上下文变化。 */
    onTaskGitDeliveryCurrentContext: (listener: (context: unknown) => void) => {
      const handler = (context: unknown) => listener(context);
      return transport.subscribe('zeus:task-git-delivery:current-context', handler);
    },
    /** 订阅交付窗口外观设置变化。 */
    onTaskGitDeliveryAppearance: (listener: (settings: unknown) => void) => {
      const handler = (settings: unknown) => listener(settings);
      return transport.subscribe('zeus:task-git-delivery:appearance', handler);
    },
    /** 订阅独立仓库差异窗口的外观，卸载时释放监听。 */
    onProjectGitDiffAppearance: (listener: (appearance: 'light' | 'dark' | 'system') => void) => {
      /** 仅将合法主题传给界面。 */
      const handler = (appearance: unknown) => {
        if (appearance === 'light' || appearance === 'dark' || appearance === 'system') listener(appearance);
      };
      return transport.subscribe('zeus:project-git-diff:appearance', handler);
    },
    /** 订阅指定任务的交付状态变化。 */
    onTaskGitDeliveryChanged: (listener: (taskId: string) => void) => {
      const handler = (taskId: string) => listener(taskId);
      return transport.subscribe('zeus:task-git-delivery:changed', handler);
    },
    /** 接收从交付窗口打开会话的请求。 */
    onOpenTaskGitDeliveryConversation: (listener: (input: unknown) => void) => {
      const handler = (input: unknown) => listener(input);
      return transport.subscribe('zeus:task-git-delivery:open-conversation', handler);
    },
    /** 系统提醒只携带任务身份，Renderer 沿用现有导航和草稿保护。 */
    onOpenTaskNotification: (listener: (input: unknown) => void) => {
      /** 精确频道不向页面暴露通用 IPC 能力。 */
      const handler = (input: unknown) => listener(input);
      return transport.subscribe('zeus:task-notification:open', handler);
    },
    /** 接收会话通知的打开请求。 */
    onOpenConversationNotification: (listener: (input: unknown) => void) => {
      const handler = (input: unknown) => listener(input);
      return transport.subscribe('zeus:conversation-notification:open', handler);
    },
    /** 读取当前请求窗口的前后台状态。 */
    getRequestingWindowForeground: () => transport.invoke('zeus:requesting-window-foreground'),
    /** 订阅当前请求窗口的前后台状态变化。 */
    onRequestingWindowForegroundChanged: (listener: (foreground: boolean) => void) => {
      const handler = (foreground: boolean) => listener(foreground);
      return transport.subscribe('zeus:requesting-window-foreground-changed', handler);
    },
    /** 收起菜单栏用量窗口。 */
    hideMenuBarUsage: () => transport.invoke('zeus:menu-bar-usage:hide'),
    /** 将内容高度交给主进程校验，菜单栏浮窗宽度保持不变。 */
    resizeMenuBarUsage: (height: number) => transport.invoke('zeus:menu-bar-usage:resize', height),
    /** 在鼠标屏幕锚点旁显示独立透明费用明细窗口。 */
    showMenuBarUsageCostDetail: (input: unknown) => transport.invoke('zeus:menu-bar-usage:cost-detail-show', input),
    /** 指针离开触发器或明细窗口时延迟关闭。 */
    scheduleHideMenuBarUsageCostDetail: () => transport.invoke('zeus:menu-bar-usage:cost-detail-schedule-hide'),
    /** 指针进入任一关联窗口时取消延迟关闭。 */
    cancelHideMenuBarUsageCostDetail: () => transport.invoke('zeus:menu-bar-usage:cost-detail-cancel-hide'),
    /** 点击取消固定、Escape 或外部点击时立即关闭。 */
    hideMenuBarUsageCostDetail: () => transport.invoke('zeus:menu-bar-usage:cost-detail-hide'),
    /** 独立费用明细 Renderer 读取当前展示数据。 */
    getMenuBarUsageCostDetail: () => transport.invoke('zeus:menu-bar-usage:cost-detail-get'),
    /** 独立费用窗口按内容请求真实原生尺寸。 */
    resizeMenuBarUsageCostDetail: (width: number, height: number) => transport.invoke('zeus:menu-bar-usage:cost-detail-resize', width, height),
    /** 菜单栏主体和独立明细窗口同步当前展开内容。 */
    onMenuBarUsageCostDetailChanged: (listener: (payload: unknown) => void) => {
      const handler = (payload: unknown) => listener(payload);
      return transport.subscribe('zeus:menu-bar-usage:cost-detail-changed', handler);
    },
    /** 订阅菜单栏用量窗口的设置变化。 */
    onMenuBarUsageSettingsChanged: (listener: (settings: unknown) => void) => {
      const handler = (settings: unknown) => listener(settings);
      return transport.subscribe('zeus:menu-bar-usage:settings', handler);
    },
    /** 从菜单栏用量窗口显示主窗口。 */
    showMainWindowFromMenuBarUsage: () => transport.invoke('zeus:menu-bar-usage:show-main'),
    /** 从菜单栏用量窗口打开设置。 */
    openMenuBarUsageSettings: (category: 'usage' | 'runtime') => transport.invoke('zeus:menu-bar-usage:open-settings', category),
    /** 从菜单栏用量窗口请求退出应用。 */
    quitFromMenuBarUsage: () => transport.invoke('zeus:menu-bar-usage:quit'),
    /** 查询和选择项目的源码工作树。 */
    listProjectSourceWorktrees: (projectId: string) => transport.invoke('zeus:project-source:list-worktrees', projectId),
    selectProjectSourceWorktree: (input: { projectId: string; worktreeId: string }) => transport.invoke('zeus:project-source:select-worktree', input),
    /** 列出项目源码目录条目。 */
    listProjectSourceDirectory: (input: unknown) => transport.invoke('zeus:project-source:list-directory', input),
    /** 按名称搜索项目源码条目。 */
    searchProjectSourceEntries: (input: unknown) => transport.invoke('zeus:project-source:search', input),
    /** 搜索项目源码正文。 */
    searchProjectSourceContent: (input: unknown) => transport.invoke('zeus:project-source:search-content', input),
    /** 读取项目源码行的 Git 来源。 */
    loadProjectSourceBlame: (input: unknown) => transport.invoke('zeus:project-source:blame', input),
    /** 读取会话工作区源码行的 Git 来源。 */
    loadConversationSourceBlame: (input: unknown) => transport.invoke('zeus:conversation-resource:blame', input),

    // 预览只传递业务身份，资源地址与系统操作均由主进程授权。
    loadFilePreview: (input: unknown) => transport.invoke('zeus:file-preview:load', input),
    /** 保存文件预览内容，使用固定命令身份。 */
    saveFilePreview: (input: { id: string; content: string }) => invokeMainCommand('zeus:file-preview:save', 'desktop.file_preview.save', 'artifact', input.id, input),
    /** 撤销预览中的指定变更块。 */
    revertFilePreviewBlock: (input: { afterId: string }) => invokeMainCommand('zeus:file-preview:revert-block', 'desktop.file_preview.revert_block', 'artifact', input.afterId, input),
    /** 释放当前文件预览持有的资源。 */
    releaseFilePreview: (ids: string[]) => transport.invoke('zeus:file-preview:release', ids),
    /** 对已授权的交付文件执行所选操作。 */
    actOnGitDeliveryFiles: (input: import('@zeus/shared').GitDeliveryFileActionInput) =>
      invokeMainCommand(
        'zeus:git-delivery:file-action',
        'desktop.git_delivery.file_action',
        'artifact',
        input.requests[0]?.kind === 'task-git' ? input.requests[0].workspaceId : input.requests[0]?.kind === 'project-git' ? input.requests[0].repositoryId : 'delivery',
        input,
      ),
    /** 转交文件预览中的用户操作。 */
    actOnFilePreview: (id: string, action: string) => transport.invoke('zeus:file-preview:action', id, action),
    /** 将预览图片像素交给系统剪贴板或原生保存对话框。 */
    actOnImagePreview: (dataUrl: string, action: 'copy' | 'export', name: string) => transport.invoke('zeus:image-preview:action', dataUrl, action, name),
    /** 读取文件预览对应版本的来源。 */
    loadFilePreviewBlame: (id: string) => transport.invoke('zeus:file-preview:blame', id),
    /** 接收打开预览所属源码工作区的请求。 */
    onFilePreviewSourceWorkspaceRequested: (listener: (workspace: unknown) => void) => transport.subscribe('zeus:file-preview:source-open-workspace', listener),
    /** 读取项目源码文件。 */
    readProjectSourceFile: (input: unknown) => transport.invoke('zeus:project-source:read-file', input),
    /** 只向受信源码页提供草稿效果预览。 */
    prepareProjectSourcePreview: (input: unknown) => transport.invoke('zeus:project-source:prepare-preview', input),
    /** 关闭页面或切换文件后撤销资源授权。 */
    releaseProjectSourcePreview: (ids: string[]) => transport.invoke('zeus:project-source:release-preview', ids),
    /** 按项目身份提交源码保存命令。 */
    saveProjectSourceFile: (input: unknown) => invokeProjectSourceCommand('zeus:project-source:save-file', 'desktop.project_source.save_file', input),
    /** 按项目身份创建源码文件或目录。 */
    createProjectSourceEntry: (input: unknown) => invokeProjectSourceCommand('zeus:project-source:create-entry', 'desktop.project_source.create_entry', input),
    /** 按项目身份移动源码条目。 */
    moveProjectSourceEntry: (input: unknown) => invokeProjectSourceCommand('zeus:project-source:move-entry', 'desktop.project_source.move_entry', input),
    /** 按项目身份将源码条目移入回收站。 */
    trashProjectSourceEntry: (input: unknown) => invokeProjectSourceCommand('zeus:project-source:trash-entry', 'desktop.project_source.trash_entry', input),
    /** 在系统文件管理器中显示源码条目。 */
    revealProjectSourceEntry: (input: unknown) => transport.invoke('zeus:project-source:reveal-entry', input),
    /** 使用系统应用打开源码条目。 */
    openProjectSourceExternally: (input: unknown) => transport.invoke('zeus:project-source:open-external', input),
    /** 订阅项目源码目录变化。 */
    watchProjectSource: (projectId: string) => transport.invoke('zeus:project-source:watch', projectId),
    /** 释放项目源码目录变化订阅。 */
    unwatchProjectSource: () => transport.invoke('zeus:project-source:unwatch'),
    /** 接收项目源码变化通知。 */
    onProjectSourceEvent: (listener: (event: unknown) => void) => {
      const handler = (value: unknown) => listener(value);
      return transport.subscribe('zeus:project-source-event', handler);
    },
    /** 报告启动失败或运行失败，由共享报告器区分阶段。 */
    reportRendererFatalFailure: (message: string) => rendererBootstrapReporter.reportFailure(message),
    /** 向宿主上报界面运行错误。 */
    reportRendererRuntimeError: (message: string) => transport.send('zeus:renderer-runtime-log', message),
    /** 输入建议只上传有界诊断元数据，不通过日志 IPC 传递正文。 */
    reportInputSuggestionDiagnostic: (entry: unknown) => transport.send('zeus:input-suggestion-diagnostic', entry),
    /** 通知宿主界面已完成首次启动。 */
    reportRendererBootstrapReady: () => rendererBootstrapReporter.reportReady(),
    /** 通过原生选择器选择项目目录。 */
    chooseProjectDirectory: () => transport.invoke('zeus:choose-project-directory'),
    /** 通过宿主在系统文件管理器中显示项目。 */
    revealProjectInFinder: (projectPath: string) => transport.invoke('zeus:reveal-project-in-finder', projectPath),
    /** 通过原生选择器选择会话附件。 */
    chooseConversationResources: () => invokeMainCommand('zeus:choose-conversation-resources', 'desktop.conversation_resources.choose', 'artifact', 'conversation-input-resources'),
    /** 将粘贴或拖入的文件授权为会话输入资源。 */
    authorizeConversationFiles: (files: File[], source: 'paste' | 'drop') => authorizePendingResourceFiles(files, source, 'zeus:authorize-conversation-files', 'zeus:materialize-conversation-resources'),
    /** 将无本地路径的会话附件保存为受控资源。 */
    materializeConversationResources: (resources: unknown[]) => invokeMainCommand('zeus:materialize-conversation-resources', 'desktop.conversation_resources.materialize', 'artifact', 'conversation-input-resources', resources),
    /** 按会话资源权限读取剪贴板内容。 */
    readConversationClipboardResources: () => invokeMainCommand('zeus:read-conversation-clipboard-resources', 'desktop.conversation_resources.read_clipboard', 'artifact', 'conversation-input-resources'),
    /** 读取会话输入资源的预览。 */
    getConversationResourcePreview: (resource: unknown) => transport.invoke('zeus:get-conversation-resource-preview', resource),
    /** 打开已授权的会话输入资源。 */
    openConversationInputResource: (resource: unknown) => transport.invoke('zeus:open-conversation-input-resource', resource),
    /** 通过命令入口选择任务附件。 */
    chooseTaskAttachments: () => invokeMainCommand('zeus:choose-task-attachments', 'desktop.task_resources.choose', 'artifact', 'task-input-resources'),
    /** 将粘贴或拖入的文件授权为任务输入资源。 */
    authorizeTaskFiles: (files: File[], source: 'paste' | 'drop') => authorizePendingResourceFiles(files, source, 'zeus:store-task-resource-paths', 'zeus:materialize-task-resources'),
    /** 将无本地路径的任务附件保存为受控资源。 */
    materializeTaskResources: (resources: unknown[]) => invokeMainCommand('zeus:materialize-task-resources', 'desktop.task_resources.materialize', 'artifact', 'task-input-resources', resources),
    /** 复用任务剪贴板读取及资源授权流程。 */
    readTaskClipboardResources,
    /** 读取当前剪贴板中的任务附件候选。 */
    readTaskClipboardAttachments: () => transport.invoke('zeus:read-task-clipboard-attachments'),
    /** 读取当前剪贴板中的图片候选。 */
    readTaskClipboardImage: () => transport.invoke('zeus:read-task-clipboard-image'),
    /** 通过宿主写入用户要求复制的文本。 */
    writeClipboardText: (text: string) => transport.invoke('zeus:write-clipboard-text', text),
    /** 通过任务资源命令保存剪贴板附件。 */
    saveTaskClipboardAttachments: () => invokeMainCommand('zeus:save-task-clipboard-attachments', 'desktop.task_resources.save_clipboard', 'artifact', 'task-input-resources'),
    /** 通过任务资源命令保存粘贴的附件载荷。 */
    saveTaskPastedAttachments: (attachments: Array<{ name?: string; type?: string; data?: ArrayBuffer; text?: string; kind?: 'image' | 'file' | 'pasted_text' }>) =>
      invokeMainCommand('zeus:save-task-pasted-attachments', 'desktop.task_resources.save_pasted', 'artifact', 'task-input-resources', attachments),
    /** 读取任务附件的预览。 */
    getTaskAttachmentPreview: (path: string) => transport.invoke('zeus:get-task-attachment-preview', path),
    /** 通过宿主打开指定任务附件。 */
    openTaskAttachment: (path: string) => transport.invoke('zeus:open-task-attachment', path),
    /** 将第三方详情读取为可确认的任务草稿。 */
    parseThirdPartyTaskLink: (url: string) => invokeMainCommand('zeus:third-party-task:parse-link', 'desktop.task_resources.import_third_party', 'artifact', 'task-input-resources', url),
    /** 使用内置浏览器会话打开独立登录窗口。 */
    openThirdPartyTaskLogin: (url: string) => transport.invoke('zeus:third-party-task:open-login', url),
    /** 将设置快照导出为用户选定的文件。 */
    exportSettingsSnapshotToFile: (snapshot: unknown) => transport.invoke('zeus:export-settings-snapshot', snapshot),
    /** 通过原生选择器读取设置快照。 */
    importSettingsSnapshotFromFile: () => transport.invoke('zeus:import-settings-snapshot'),
    /** 通过原生选择器读取业务数据快照。 */
    importBusinessDataSnapshotFromFile: () => transport.invoke('zeus:import-business-data-snapshot'),
    /** 请求清理当前宿主的网络缓存。 */
    clearNetworkCache: () => transport.invoke('zeus:clear-network-cache'),
    /** 仅检查当前草稿，不保存或切换运行代理。 */
    checkNetworkProxyConnection: (settings: unknown, address: string, checkTarget: 'browser' | 'node') => transport.invoke('zeus:network-proxy:check', settings, address, checkTarget),
    /** 将补丁保存到用户选定的文件。 */
    exportPatchToFile: (patch: unknown) => transport.invoke('zeus:export-patch', patch),
    /** 打开具有明确来源的资源。 */
    openSource: (source: unknown) => transport.invoke('zeus:open-source', source),
    /** 通过系统浏览器打开经宿主校验的 HTTPS 地址。 */
    openExternalHttpsUrl: (url: string) => transport.invoke('zeus:open-external-https-url', url),
    /** 按用户操作激活发起请求的窗口。 */
    activateRequestingWindow: () => transport.invoke('zeus:activate-requesting-window'),
    /** 读取自动更新提示状态。 */
    getAutomaticUpdateIndicator: () => transport.invoke('zeus:automatic-update-indicator:get'),
    /** 通过宿主检查更新清单。 */
    checkReleaseUpdate: () => transport.invoke('zeus:release:check-update'),
    /** 通过命令入口打开更新提示。 */
    openAutomaticUpdateIndicator: () => invokeMainCommand('zeus:automatic-update-indicator:open', 'desktop.automatic_update.open', 'execution_host', 'desktop-update'),
    /** 记录用户主动检查更新的请求。 */
    recordManualUpdateCheck: () => invokeMainCommand('zeus:automatic-update-indicator:record-manual-check', 'desktop.automatic_update.record_manual_check', 'execution_host', 'desktop-update'),
    /** 订阅更新提示状态变化。 */
    onAutomaticUpdateIndicatorChanged: (listener: (state: unknown) => void) => {
      const handler = (state: unknown) => listener(state);
      return transport.subscribe('zeus:automatic-update-indicator:changed', handler);
    },
    /** 读取会话资源可用的打开方式。 */
    listConversationResourceOpenTargets: (request: unknown) => transport.invoke('zeus:conversation-resource:list-open-targets', request),
    /** 按所选目标打开已授权的会话资源。 */
    openConversationResource: (request: unknown) => transport.invoke('zeus:conversation-resource:open', request),
    /** 打开当前轮次变更涉及的文件。 */
    openTurnChangeFile: (request: unknown) => transport.invoke('zeus:turn-change-file:open', request),
    /** 通知宿主应用外壳设置已变化。 */
    notifyAppShellSettingsChanged: (settings: unknown) => transport.invoke('zeus:app-shell-settings-changed', settings),
    /** 通知宿主任务表布局存在未保存修改。 */
    notifyTaskTableLayoutDirty: (dirty: boolean) => transport.send('zeus:task-table-layout-dirty-changed', dirty),
    /** 设置当前窗口的未保存修改状态。 */
    setUnsavedChangeState: (key: string, dirty: boolean) => transport.send('zeus:unsaved-change-state', { key, dirty }),
    /** 通知宿主当前存在敏感请求草稿。 */
    notifySensitiveRequestDraft: (payload: { requestId: string; present: boolean }) => transport.send('zeus:sensitive-request-draft-changed', payload),
    /** 将终端焦点单独交给主进程路由快捷键。 */
    notifyTerminalActivity: (active: boolean) => transport.send('zeus:terminal-activity-changed', active),
    /** 通知宿主会话上下文区域的活动状态。 */
    notifySessionContextActivity: (payload: unknown) => transport.send('zeus:session-context-activity-changed', payload),
    /** 通知宿主当前可关闭界面层的活动状态。 */
    notifyAppCloseLayerActivity: (active: boolean) => transport.send('zeus:app-close-layer-activity-changed', active),
    /** 管理当前工作区的系统窗口。 */
    updateSystemWindow: (name: string, action: 'show' | 'close'): Promise<void> => transport.invoke('zeus:system-window:update', name, action) as Promise<void>,
    /** 接收系统窗口关闭请求。 */
    onSystemWindowCloseRequest: (listener: (name: string) => void) => transport.subscribe('zeus:system-window:close-request', listener),
    /** 返回任务表布局关闭请求的处理结果。 */
    resolveTaskTableLayoutCloseRequest: (proceed: boolean) => transport.send('zeus:task-table-layout-close-resolution', { proceed }),
    /** 返回未保存修改关闭请求的处理结果。 */
    resolveUnsavedChangesCloseRequest: (proceed: boolean) => transport.send('zeus:unsaved-changes-close-resolution', { proceed }),
    /** 订阅关闭任务表布局编辑的请求。 */
    onTaskTableLayoutCloseRequested: (listener: () => void) => {
      const handler = () => listener();
      return transport.subscribe('zeus:task-table-layout-close-requested', handler);
    },
    /** 订阅带未保存修改的窗口关闭请求。 */
    onUnsavedChangesCloseRequested: (listener: () => void) => {
      const handler = () => listener();
      return transport.subscribe('zeus:unsaved-changes-close-requested', handler);
    },
    /** 将脱敏运行日志导出到用户选择的文件。 */
    exportRuntimeLogsToFile: (payload: unknown) => transport.invoke('zeus:export-runtime-logs', payload),
    /** 通知原生宿主开始拖动窗口。 */
    beginWindowDrag: (point: unknown) => transport.invoke('zeus:window-drag-start', point),
    /** 向原生宿主更新窗口拖动位置。 */
    moveWindowDrag: (point: unknown) => transport.invoke('zeus:window-drag-move', point),
    /** 通知原生宿主结束窗口拖动。 */
    endWindowDrag: () => transport.invoke('zeus:window-drag-end'),
    /** 接收原生菜单新建会话请求。 */
    onNativeNewConversation: (listener: () => void) => {
      const handler = () => listener();
      return transport.subscribe('zeus:native-new-conversation', handler);
    },
    /** 终端与浏览器使用独立关闭事件，避免一次快捷键关闭两个标签。 */
    onNativeCloseActiveTerminalTab: (listener: () => void) => {
      /** 监听主进程菜单分发的关闭动作。 */
      const handler = () => listener();
      return transport.subscribe('zeus:terminal-close-active-tab', handler);
    },
    /** 接收原生快捷键关闭当前上下文标签的请求。 */
    onNativeCloseActiveContextTab: (listener: (ownerConversationId?: string) => void) => {
      return transport.subscribe<string | undefined>('zeus:session-context-close-active-tab', listener);
    },
    /** 接收原生快捷键关闭最前方界面层的请求。 */
    onNativeCloseFrontmostLayer: (listener: () => void) => {
      const handler = () => listener();
      return transport.subscribe('zeus:app-close-frontmost-layer', handler);
    },
    /** 打开系统浏览器菜单，仅返回用户选择，不直接执行动作。 */
    showBrowserMenu: (input: unknown) => transport.invoke('zeus:browser:show-menu', input),
    /** 按会话读取当前浏览器标签快照。 */
    getBrowserSnapshot: (conversationId: string) => transport.invoke('zeus:browser:get-snapshot', conversationId),
    /** 按会话身份打开内置浏览器标签。 */
    openBrowserTab: (input: unknown) => transport.invoke('zeus:browser:open-tab', input),
    /** 首发受理后把当前窗口的浏览器草稿归入真实会话。 */
    adoptBrowserDraft: (input: unknown) => transport.invoke('zeus:browser:adopt-draft', input),
    /** 选择所属会话中的已有浏览器标签。 */
    activateBrowserTab: (input: unknown) => transport.invoke('zeus:browser:activate-tab', input),
    /** 显式关闭所属会话中的指定浏览器标签。 */
    closeBrowserTab: (input: unknown) => transport.invoke('zeus:browser:close-tab', input),
    /** 明确关闭当前会话浏览器并释放全部标签。 */
    closeBrowserConversation: (conversationId: string) => transport.invoke('zeus:browser:close-conversation', conversationId),
    /** 按会话身份提交浏览器操作命令。 */
    runBrowserCommand: (input: unknown) => invokeBrowserConversationCommand('zeus:browser:command', 'desktop.browser.command', input),
    /** 更新内置浏览器区域的布局与可见状态。 */
    setBrowserLayout: (input: unknown) => transport.invoke('zeus:browser:set-layout', input),
    /** 准备当前浏览器页面的批注资源。 */
    prepareBrowserComments: (input: unknown) => transport.invoke('zeus:browser:prepare-comments', input),
    /** 读取浏览器批注资源的预览。 */
    getBrowserCommentPreview: (path: string) => transport.invoke('zeus:browser:comment-preview', path),
    /** 按会话身份记录批注已发送。 */
    markBrowserCommentsSent: (input: unknown) => invokeBrowserConversationCommand('zeus:browser:mark-comments-sent', 'desktop.browser.mark_comments_sent', input),
    /** 按审批请求身份提交用户决定。 */
    respondToBrowserApproval: (input: unknown) => {
      const candidate = input && typeof input === 'object' && !Array.isArray(input) ? (input as { requestId?: unknown }) : {};
      return invokeMainCommand('zeus:browser:respond-approval', 'desktop.browser.respond_approval', 'approval', mainCommandScopeId(candidate.requestId, 'browser-approval'), input);
    },
    /** 读取内置浏览器设置。 */
    getBrowserSettings: () => transport.invoke('zeus:browser:get-settings'),
    /** 通过命令账本保存内置浏览器设置。 */
    updateBrowserSettings: (input: unknown) => invokeMainCommand('zeus:browser:update-settings', 'desktop.browser.update_settings', 'settings', 'browser-settings', input),
    /** 通过命令入口清理内置浏览器数据。 */
    clearBrowserData: () => invokeMainCommand('zeus:browser:clear-data', 'desktop.browser.clear_data', 'settings', 'browser-settings'),
    /** 读取旧原生运行时的归档状态。 */
    getRetiredNativeRuntimeState: () => transport.invoke('zeus:browser:get-retired-runtime-state'),
    /** 通过命令入口归档旧原生运行时。 */
    archiveRetiredNativeRuntimes: () => invokeMainCommand('zeus:browser:archive-retired-runtimes', 'desktop.browser.archive_retired_runtimes', 'settings', 'retired-native-runtimes'),
    /** 通过命令入口恢复已归档的旧运行时。 */
    restoreRetiredNativeRuntimes: () => invokeMainCommand('zeus:browser:restore-retired-runtimes', 'desktop.browser.restore_retired_runtimes', 'settings', 'retired-native-runtimes'),
    /** 读取计算机控制设置。 */
    getComputerSettings: () => transport.invoke('zeus:computer:get-settings'),
    /** 只读获取对应会话的控制画面，不启动采集。 */
    getComputerPreview: (conversationId: string, imageId?: string | null) => transport.invoke('zeus:computer:get-preview', conversationId, imageId),
    /** 变化通知不带图片，页面按所属会话请求增量画面。 */
    onComputerPreviewChanged: (listener: (conversationId: string) => void) => {
      /** 原生 IPC 内容先核对类型。 */
      const handler = (conversationId: unknown) => {
        if (typeof conversationId === 'string') listener(conversationId);
      };
      return transport.subscribe('zeus:computer:preview-changed', handler);
    },
    /** 通过命令入口保存计算机控制设置。 */
    updateComputerSettings: (input: unknown) => invokeMainCommand('zeus:computer:update-settings', 'desktop.computer.update_settings', 'settings', 'computer-use-settings', input),
    /** 通过命令入口请求平台所需的计算机控制权限。 */
    requestComputerPermissions: () => invokeMainCommand('zeus:computer:request-permissions', 'desktop.computer.request_permissions', 'settings', 'computer-use-permissions'),
    /** 通过命令入口打开对应平台权限设置。 */
    openComputerPermissionSettings: (input: unknown) => invokeMainCommand('zeus:computer:open-permission-settings', 'desktop.computer.open_permission_settings', 'settings', 'computer-use-permissions', input),
    /** 会话按钮携带控制身份；设置中的全局停止保留原有语义。 */
    stopComputerUse: (input?: { conversationId: string; sessionId: string }) =>
      invokeMainCommand('zeus:computer:stop', 'desktop.computer.stop', input ? 'product_conversation' : 'settings', input?.conversationId ?? 'computer-use-settings', input),
    /** 订阅内置浏览器状态及审批事件。 */
    onBrowserEvent: (listener: (event: unknown) => void) => {
      const handler = (value: unknown) => listener(value);
      return transport.subscribe('zeus:browser-event', handler);
    },
  };
}
