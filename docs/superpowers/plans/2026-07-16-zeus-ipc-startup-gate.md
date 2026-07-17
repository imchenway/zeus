# Zeus IPC 启动门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：** 已于 2026-07-17 完成实现与正式包验收。最终结果为 88 个测试文件、1410 项通过、4 项既有条件跳过；`typecheck`、lint、格式、diff、ASAR 健康检查与严格 codesign 均通过；正式包首次及第二实例触发后保持 1 个窗口、1 个 Renderer，禁用文案与启动错误日志均为 0 命中。

**执行补充：** 第一次正式冷启动暴露了 `sandbox: true` preload 无法加载相对 CommonJS 依赖的问题。处理过程先加入真实 ASAR 负例，再复用仓库已有 Vite 将 preload 打成单文件，并把该检查接入 `package:mac` 签名前门禁；未新增依赖。正常 `⌘Q` 后进程超过 10 秒仍存活被记录为独立退出清理缺陷，不属于本计划的启动前 IPC 门禁范围。

**Goal:** Zeus 的首次启动、macOS `activate` 与 `second-instance` 只在 Main 初始化和 IPC 注册完成后创建同一个主窗口；启动阶段只显示无文字 Zeus 品牌壳，真实失败只通过系统通用提示对用户可见。

**Architecture:** 用独立、可单测的 `startupCoordinator` 持有唯一 initialization Promise、唯一在途主窗口 Promise 和唯一致命错误 Promise；Electron Main 的所有主窗口恢复入口都经过该协调器。Renderer 在 dashboard 与设置数据加载成功前不挂载 React `App`，由 `index.html` 的静态品牌壳承接等待；Renderer bootstrap 异常通过受限 preload IPC 回传 Main，由同一致命错误出口记录详情、显示一次通用原生提示并退出。

**Tech Stack:** Electron、TypeScript、React 19、Vite、Vitest、macOS `app.asar` 打包与 ad-hoc codesign。

## 主依据与硬边界

- 主任务设计：`docs/TASK_20260716_001_Zeus本地服务IPC注册时序故障排查.html`。
- 已确认体验：不在产品页面展示 local-server、IPC、app-server、本机 API 的连接中或失败状态。
- 已确认失败文案：系统原生提示只显示“Zeus 无法启动，请重新打开应用。”；技术详情只写 Main / Renderer 日志。
- 保留显式“新建窗口”能力；只合并启动、激活、第二实例和“显示主窗口”类请求，不删除 Tray 中用户主动触发的多窗口入口。
- 不修改数据库、HTTP API、Codex 协议、权限模型、配置格式、依赖或数据迁移。
- 当前 `main` 工作区存在大量用户未提交改动，且本计划涉及的 Main、Preload、Renderer、样式与测试文件均已是 dirty；执行前后必须逐文件审查 diff，禁止覆盖或格式化掉无关改动。
- 用户未要求 worktree；在当前工作区执行。不得自行 commit、push、merge 或改写历史；只有用户另行明确授权后才可提交。

## 文件责任映射

- Create: `apps/desktop/src/main/startupCoordinator.ts` — 纯 TypeScript Promise 去重，不导入 Electron。
- Create: `apps/desktop/test/startup-coordinator.test.ts` — 证明“就绪前零窗口、就绪后一窗口、失败只上报一次”。
- Modify: `apps/desktop/src/main/main.ts:29-169,228-234,588-651` — 接入协调器、集中 Main 初始化、处理 bootstrap 失败、显示通用原生错误。
- Modify: `apps/desktop/test/main-runtime.test.ts:222-251` — Main 生命周期、错误边界和 Renderer 失败通道契约。
- Modify: `apps/desktop/src/preload/index.cts:1-33` — 暴露只写 bootstrap 失败上报函数。
- Modify: `apps/desktop/src/renderer/global.d.ts:4-61` — 声明上报函数。
- Modify: `apps/desktop/src/renderer/main.tsx:7-17,24-32,303-327` — 成功前不挂载 `App`，失败时通知 Main。
- Modify: `apps/desktop/src/renderer/ErrorBoundary.tsx:5-89` — 桌面入口 fatal 模式不渲染页内恢复面，改为通知 Main；其他独立使用保留现有安全恢复页。
- Modify: `apps/desktop/test/error-boundary.test.tsx:7-97` — 锁定 fatal 与普通恢复两种边界。
- Modify: `apps/desktop/index.html:1-16` — 无文字 Zeus 品牌启动壳与 reduced-motion 降级。
- Modify: `apps/desktop/src/renderer/App.tsx:143,596-618,1981-2003,3230-3253,5463-5464,5787-5788,7875-7879,8048,8094,8846,8955,13476-13488` — 删除 local client 技术状态模型、文案和组件。
- Modify: `apps/desktop/src/renderer/styles.css:5600-5633,8063-8065,8090-8092,8109-8111,8119-8132` — 删除废弃状态行样式。
- Modify: `apps/desktop/test/renderer.test.tsx:219-284,1375-1410` — 旧技术状态正向断言改为禁止出现的回归契约。
- Modify: `scripts/verify-packaged-app-health.mjs:47-67` — 验证实际 `app.asar` 启动壳和禁用文案。
- Modify: `scripts/package-mac.test.ts:113-125,560-572` — 固化 source / package 契约。
- Modify: `docs/TASK_20260716_001_Zeus本地服务IPC注册时序故障排查.html` — 实施后只写真实 RED、GREEN、打包和冷启动证据。

---

### Task 1: 用纯协调器锁定启动并发语义

**Files:**
- Create: `apps/desktop/test/startup-coordinator.test.ts`
- Create: `apps/desktop/src/main/startupCoordinator.ts`

- [x] **Step 1: 写 deferred 初始化的失败行为测试**

创建 `apps/desktop/test/startup-coordinator.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { createStartupCoordinator } from '../src/main/startupCoordinator.js';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('Electron startup coordinator', () => {
  it('shares initialization and one in-flight main-window request across all startup entries', async () => {
    const initialization = createDeferred();
    const initialize = vi.fn(() => initialization.promise);
    const revealOrCreateMainWindow = vi.fn(async () => undefined);
    const onFatalStartupError = vi.fn(async () => undefined);
    const coordinator = createStartupCoordinator({ initialize, revealOrCreateMainWindow, onFatalStartupError });

    const initialStart = coordinator.requestMainWindow();
    const activate = coordinator.requestMainWindow();
    const secondInstance = coordinator.requestMainWindow();
    await Promise.resolve();

    expect(initialStart).toBe(activate);
    expect(activate).toBe(secondInstance);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(revealOrCreateMainWindow).not.toHaveBeenCalled();

    initialization.resolve();
    await Promise.all([initialStart, activate, secondInstance]);

    expect(revealOrCreateMainWindow).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).not.toHaveBeenCalled();
  });

  it('reuses successful initialization while allowing a later main-window reveal request', async () => {
    const initialize = vi.fn(async () => undefined);
    const revealOrCreateMainWindow = vi.fn(async () => undefined);
    const coordinator = createStartupCoordinator({
      initialize,
      revealOrCreateMainWindow,
      onFatalStartupError: vi.fn(async () => undefined),
    });

    await coordinator.requestMainWindow();
    await coordinator.requestMainWindow();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(revealOrCreateMainWindow).toHaveBeenCalledTimes(2);
  });

  it('reports initialization or window failures exactly once', async () => {
    const startupError = new Error('local runtime unavailable');
    const onFatalStartupError = vi.fn(async () => undefined);
    const coordinator = createStartupCoordinator({
      initialize: vi.fn(async () => {
        throw startupError;
      }),
      revealOrCreateMainWindow: vi.fn(async () => undefined),
      onFatalStartupError,
    });

    await Promise.all([coordinator.requestMainWindow(), coordinator.requestMainWindow()]);
    await coordinator.fail(new Error('later renderer failure'));

    expect(onFatalStartupError).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).toHaveBeenCalledWith(startupError);
  });
});
```

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm vitest run apps/desktop/test/startup-coordinator.test.ts --reporter=verbose
```

Expected: FAIL，错误明确指向 `../src/main/startupCoordinator.js` 不存在。

- [x] **Step 3: 写最小 Promise 去重实现**

创建 `apps/desktop/src/main/startupCoordinator.ts`：

```ts
export type StartupCoordinatorOptions = {
  initialize: () => Promise<void>;
  revealOrCreateMainWindow: () => Promise<void>;
  onFatalStartupError: (error: unknown) => void | Promise<void>;
};

export type StartupCoordinator = {
  requestMainWindow: () => Promise<void>;
  fail: (error: unknown) => Promise<void>;
};

export function createStartupCoordinator(options: StartupCoordinatorOptions): StartupCoordinator {
  let initializationPromise: Promise<void> | undefined;
  let mainWindowRequestPromise: Promise<void> | undefined;
  let fatalStartupPromise: Promise<void> | undefined;

  const initialize = (): Promise<void> => {
    initializationPromise ??= Promise.resolve().then(() => options.initialize());
    return initializationPromise;
  };

  const fail = (error: unknown): Promise<void> => {
    fatalStartupPromise ??= Promise.resolve().then(() => options.onFatalStartupError(error));
    return fatalStartupPromise;
  };

  const requestMainWindow = (): Promise<void> => {
    if (mainWindowRequestPromise) return mainWindowRequestPromise;
    const pendingRequest = initialize()
      .then(() => options.revealOrCreateMainWindow())
      .catch((error: unknown) => fail(error))
      .finally(() => {
        if (mainWindowRequestPromise === pendingRequest) mainWindowRequestPromise = undefined;
      });
    mainWindowRequestPromise = pendingRequest;
    return pendingRequest;
  };

  return { requestMainWindow, fail };
}
```

- [x] **Step 4: 运行聚焦测试并确认 GREEN**

Run:

```bash
pnpm vitest run apps/desktop/test/startup-coordinator.test.ts --reporter=verbose
```

Expected: 3 tests PASS；deferred resolve 前窗口调用 0 次，resolve 后 1 次，致命错误回调 1 次。

- [x] **Step 5: 检查本任务 diff 边界**

Run:

```bash
git status --short -- apps/desktop/src/main/startupCoordinator.ts apps/desktop/test/startup-coordinator.test.ts
! rg -n '[[:blank:]]+$' apps/desktop/src/main/startupCoordinator.ts apps/desktop/test/startup-coordinator.test.ts
```

Expected: status 只列出上述两个新文件；尾随空白搜索无输出。用户明确授权 commit 前保持未提交。

---

### Task 2: 让所有主窗口入口等待同一个 Main 初始化

**Files:**
- Modify: `apps/desktop/test/main-runtime.test.ts:242-251`
- Modify: `apps/desktop/src/main/main.ts:8-20,171-213,442-465,588-651`

- [x] **Step 1: 增加 Main wiring 与致命错误边界的失败测试**

在 `Electron main window responsive bounds` describe 中加入：

```ts
it('gates initial launch, activate, second-instance, and reveal actions behind one startup coordinator', async () => {
  const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');

  expect(source).toContain("import { createStartupCoordinator } from './startupCoordinator.js';");
  expect(source).toContain('async function initializeApplication(): Promise<void>');
  expect(source).toContain('const startupCoordinator = createStartupCoordinator({');
  expect(source).toMatch(/app\.on\('second-instance',[\s\S]*void requestMainWindow\(\);/);
  expect(source).toMatch(/app\.on\('activate', \(\) => \{\s*void requestMainWindow\(\);/);
  expect(source).toMatch(/if \(!hasSingleInstanceLock\)[\s\S]*else \{[\s\S]*void requestMainWindow\(\);/);
  expect(source).not.toMatch(/app\.whenReady\(\)\.then\(async/);
  expect(source).not.toMatch(/app\.on\('activate'[\s\S]*await revealOrCreateMainWindow\(\)/);
});

it('keeps fatal startup detail in logs while showing one generic native error', async () => {
  const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');

  expect(source).toContain("console.error('Zeus startup failed', error)");
  expect(source).toContain("dialog.showErrorBox('Zeus', 'Zeus 无法启动，请重新打开应用。')");
  expect(source).toMatch(/try \{[\s\S]*dialog\.showErrorBox[\s\S]*\} finally \{\s*app\.quit\(\);\s*\}/);
});
```

把现有 activate 断言改为：

```ts
expect(source).toMatch(/app\.on\('activate', \(\) => \{\s*void requestMainWindow\(\);/);
```

- [x] **Step 2: 运行 Main 测试并确认 RED**

Run:

```bash
pnpm vitest run apps/desktop/test/main-runtime.test.ts -t "startup coordinator|fatal startup|activation and second-instance" --reporter=verbose
```

Expected: coordinator / native error 断言 FAIL；现有直接窗口路径被捕获。

- [x] **Step 3: 把原 whenReady 链提取为唯一初始化函数**

在 `main.ts` imports 加入：

```ts
import { createStartupCoordinator } from './startupCoordinator.js';
```

用以下结构替换当前 single-instance 与 `app.whenReady().then(...)`；`startDesktopLocalServer({...})` 内现有参数和 `onRestarted` 回调逐字保留：

```ts
async function initializeApplication(): Promise<void> {
  await app.whenReady();
  const userDataPath = app.getPath('userData');
  const mainProjectRoot = resolveMainProjectRoot();
  const codexNativeEnabled = parseCodexNativeEnabled(process.env.ZEUS_CODEX_NATIVE_ENABLED);
  const codexRuntimeCommandPath = codexNativeEnabled
    ? await resolveCodexRuntimePath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        projectRoot: mainProjectRoot,
        arch: process.arch,
      })
    : undefined;
  localServerRuntime = await startDesktopLocalServer({
    userDataPath,
    projectRoot: mainProjectRoot,
    telegramToken: process.env.ZEUS_TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: parseTelegramAllowedUserIds(process.env.ZEUS_TELEGRAM_ALLOWED_USER_IDS),
    codexNativeEnabled,
    codexRuntimeCommandPath,
    codexLegacyImportRoot: join(userDataPath, 'codex-legacy-import'),
    onRestarted: () => {
      applySystemNotificationBridge();
    },
  });
  appShellSettings = await loadMainAppShellSettings(localServerRuntime.config);
  applyLoginItemSettings();
  setupMenu();
  setupIpc();
  setupTraySafely();
  applySystemNotificationBridge();
}

function handleFatalStartupError(error: unknown): void {
  console.error('Zeus startup failed', error);
  try {
    dialog.showErrorBox('Zeus', 'Zeus 无法启动，请重新打开应用。');
  } finally {
    app.quit();
  }
}

const startupCoordinator = createStartupCoordinator({
  initialize: initializeApplication,
  revealOrCreateMainWindow,
  onFatalStartupError: handleFatalStartupError,
});

function requestMainWindow(): Promise<void> {
  return startupCoordinator.requestMainWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    void requestMainWindow();
  });
  void requestMainWindow();
}
```

把 `activate` 改为：

```ts
app.on('activate', () => {
  void requestMainWindow();
});
```

- [x] **Step 4: 主窗口恢复动作复用门禁，同时保留显式多窗口动作**

在 `setupMenu()`、`startNewConversationFromMenu()`、`openSettingsFromMenu()`、`openReleaseStatusFromMenu()` 和 Tray 的 `showMainWindow` 回调中，把 `revealOrCreateMainWindow()` 替换为 `requestMainWindow()`。Tray 的 `createWindow: () => { void createWindow(); }` 保持不变，因为它在初始化完成后才可见且代表用户主动新建窗口。

Run:

```bash
rg -n "revealOrCreateMainWindow\(" apps/desktop/src/main/main.ts
```

Expected: 只剩函数定义、函数内部的 `createWindow()` 和 coordinator option，没有 lifecycle / menu / tray-show 的直接调用。

- [x] **Step 5: 运行 coordinator 与 Main 测试并确认 GREEN**

Run:

```bash
pnpm vitest run apps/desktop/test/startup-coordinator.test.ts apps/desktop/test/main-runtime.test.ts --reporter=verbose
```

Expected: 两个测试文件全部 PASS；原 Main 契约不回归。

---

### Task 3: 将 Renderer bootstrap 异常统一交给 Main 致命错误出口

**Files:**
- Modify: `apps/desktop/test/main-runtime.test.ts`
- Modify: `apps/desktop/test/renderer.test.tsx`
- Modify: `apps/desktop/src/main/main.ts:117-169,228-234`
- Modify: `apps/desktop/src/preload/index.cts:3-33`
- Modify: `apps/desktop/src/renderer/global.d.ts:4-61`
- Modify: `apps/desktop/src/renderer/main.tsx:7-17,24-32,303-327`
- Modify: `apps/desktop/src/renderer/ErrorBoundary.tsx:5-89`
- Modify: `apps/desktop/test/error-boundary.test.tsx:7-97`

- [x] **Step 1: 写失败的桥接与延迟挂载契约**

在 `main-runtime.test.ts` 加入：

```ts
it('routes trusted renderer bootstrap failures into the shared fatal startup exit', async () => {
  const mainSource = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  const preloadSource = await readFile(new URL('../src/preload/index.cts', import.meta.url), 'utf8');
  const globalSource = await readFile(new URL('../src/renderer/global.d.ts', import.meta.url), 'utf8');

  expect(mainSource).toContain("ipcMain.on('zeus:renderer-bootstrap-failed'");
  expect(mainSource).toContain('BrowserWindow.fromWebContents(event.sender)');
  expect(mainSource).toContain('windows.has(requestingWindow)');
  expect(mainSource).toContain('startupCoordinator.fail');
  expect(mainSource).toContain("window.webContents.once('preload-error'");
  expect(preloadSource).toContain("ipcRenderer.send('zeus:renderer-bootstrap-failed', message)");
  expect(globalSource).toContain('reportRendererBootstrapFailure: (message: string) => void;');
});
```

在 `renderer.test.tsx` 加入：

```ts
it('mounts the product App only after hydration succeeds and reports bootstrap failures to Main', () => {
  const source = readFileSync(new URL('../src/renderer/main.tsx', import.meta.url), 'utf8');
  const settingsLoadedAt = source.indexOf('await client.loadAppShellSettings()');
  const rootCreatedAt = source.indexOf('const reactRoot = createRoot(root)');

  expect(settingsLoadedAt).toBeGreaterThan(-1);
  expect(rootCreatedAt).toBeGreaterThan(settingsLoadedAt);
  expect(source).toContain('window.zeus?.reportRendererBootstrapFailure?.(formatHydrationError(error))');
  expect(source).not.toContain('<App localClientStatus="connecting"');
  expect(source).not.toContain('<App localClientStatus="failed"');
});
```

在 `error-boundary.test.tsx` 加入 fatal 模式测试，并更新现有 entry source 断言：

```tsx
it('reports desktop-entry render failures without showing the in-page recovery surface', () => {
  const html = renderToString(
    <RendererErrorBoundary initialError={new Error('bootstrap failed')} onFatalError={() => undefined}>
      <section>正常内容</section>
    </RendererErrorBoundary>,
  );
  const source = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'ErrorBoundary.tsx'), 'utf8');

  expect(html).toBe('');
  expect(source).toContain('this.props.onFatalError?.(error, info)');
});
```

把 `wraps the desktop renderer entry...` 中的精确开标签断言改为：

```ts
expect(entry).toContain('<RendererErrorBoundary');
expect(entry).toContain('onFatalError={reportRendererBootstrapFailure}');
```

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm vitest run apps/desktop/test/main-runtime.test.ts apps/desktop/test/renderer.test.tsx apps/desktop/test/error-boundary.test.tsx -t "renderer bootstrap|mounts the product App|desktop-entry render failures" --reporter=verbose
```

Expected: IPC bridge、preload-error 和延迟 `createRoot` 断言 FAIL。

- [x] **Step 3: 增加只写 preload bridge 与可信发送方校验**

在 `preload/index.cts` 的 expose 对象中加入：

```ts
reportRendererBootstrapFailure: (message: string) => ipcRenderer.send('zeus:renderer-bootstrap-failed', message),
```

在 `global.d.ts` 的 `window.zeus` 类型中加入：

```ts
reportRendererBootstrapFailure: (message: string) => void;
```

在 `setupIpc()` 的 `get-local-server-config` handler 之后加入：

```ts
ipcMain.on('zeus:renderer-bootstrap-failed', (event, message: unknown) => {
  const requestingWindow = BrowserWindow.fromWebContents(event.sender);
  if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
  const detail = typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : 'Renderer bootstrap failed without detail';
  void startupCoordinator.fail(new Error(`Renderer bootstrap failed: ${detail}`));
});
```

在 `createWindow()` 创建 `BrowserWindow` 后、`loadURL()` 前加入：

```ts
window.webContents.once('preload-error', (_event, preloadPath, error) => {
  const detail = error instanceof Error ? error.message : String(error);
  void startupCoordinator.fail(new Error(`Renderer preload failed (${preloadPath}): ${detail}`));
});
```

- [x] **Step 4: 成功前不创建 React root，失败时不渲染 App**

从 `main.tsx:12-17` 删除模块级 `const reactRoot = createRoot(root)` 和第一次 `<App localClientStatus="connecting" />` render。

在 `renderWithClient()` 中，将下面一行精确插入到两个数据 await 之后、现有 `reactRoot.render(...)` 之前：

```ts
const reactRoot = createRoot(root);
```

从成功 `<App>` 删除：

```tsx
localClientStatus="ready"
```

在 `main.tsx` 增加统一上报函数：

```ts
function reportRendererBootstrapFailure(error: unknown): void {
  window.zeus?.reportRendererBootstrapFailure?.(formatHydrationError(error));
}
```

为成功渲染的边界增加：

```tsx
onFatalError={reportRendererBootstrapFailure}
```

把 catch 精确替换为：

```ts
hydrateDashboard().catch((error: unknown) => {
  console.error('Zeus dashboard hydration failed', error);
  reportRendererBootstrapFailure(error);
});
```

`renderWithClient()` 中现有 `onCreateCurrentProject` 至 `onExecuteGitOperation` 的所有真实 callbacks 逐行保留，不做重排或格式化；本任务只移动 `createRoot` 并删除 status prop。

- [x] **Step 5: 让桌面入口的 ErrorBoundary 使用 fatal 模式**

给 `RendererErrorBoundaryProps` 增加：

```ts
onFatalError?: (error: Error, info: ErrorInfo) => void;
```

在 `componentDidCatch()` 现有 `console.error(...)` 之后加入：

```ts
this.props.onFatalError?.(error, info);
```

在 `render()` 的现有恢复页分支之前加入：

```ts
if (this.state.hasError && this.props.onFatalError) return null;
```

未传 `onFatalError` 的 ErrorBoundary 继续渲染当前中英文安全恢复页，不删除其 copy 或样式。

- [x] **Step 6: 运行桥接与 Renderer 聚焦测试并确认 GREEN**

Run:

```bash
pnpm vitest run apps/desktop/test/main-runtime.test.ts apps/desktop/test/renderer.test.tsx apps/desktop/test/error-boundary.test.tsx --reporter=verbose
```

Expected: 三个文件全部 PASS；Main 拒绝非 Zeus 窗口发送方，Renderer catch 中没有失败 `App`，桌面入口 fatal 边界不渲染页内恢复面。

---

### Task 4: 用无文字 Zeus 品牌壳承接启动等待并写入包健康门禁

**Files:**
- Modify: `apps/desktop/test/renderer.test.tsx`
- Modify: `scripts/package-mac.test.ts`
- Modify: `apps/desktop/index.html`
- Modify: `scripts/verify-packaged-app-health.mjs:47-67`

- [x] **Step 1: 写启动壳与 package 失败契约**

在 `renderer.test.tsx` 加入：

```ts
it('keeps the static startup shell text-free, unfocusable, and reduced-motion safe', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  expect(html).toContain('<div class="zeus-startup-loader" aria-hidden="true">');
  expect(html).toContain('src="./assets/icon.svg"');
  expect(html).toContain('alt=""');
  expect(html).toContain('tabindex="-1"');
  expect(html).toContain('@media (prefers-reduced-motion: reduce)');
  expect(html).toMatch(/prefers-reduced-motion:[\s\S]*\.zeus-startup-icon[\s\S]*animation:\s*none/);
  for (const forbidden of ['正在启动本地服务', '本地服务连接失败', '本机 API 暂不可用', 'Connecting local service', 'Local service unavailable', 'Local API temporarily unavailable']) {
    expect(html).not.toContain(forbidden);
  }
});
```

在 `package-mac.test.ts` 加入：

```ts
it('verifies the packaged renderer keeps the text-free Zeus startup shell', () => {
  const rendererHtml = readFileSync(join(process.cwd(), 'apps', 'desktop', 'index.html'), 'utf8');
  const healthScript = readFileSync(join(process.cwd(), 'scripts', 'verify-packaged-app-health.mjs'), 'utf8');

  expect(rendererHtml).toContain('zeus-startup-loader');
  expect(rendererHtml).toContain('./assets/icon.svg');
  expect(rendererHtml).toContain('prefers-reduced-motion');
  expect(healthScript).toContain('zeus-startup-loader');
  expect(healthScript).toContain('forbiddenStartupCopy');
});
```

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts -t "startup shell" --reporter=verbose
```

Expected: `zeus-startup-loader` 与 package health 断言 FAIL。

- [x] **Step 3: 用本地 Zeus icon 实现静态 HTML 启动壳**

把 `apps/desktop/index.html` 改为：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    />
    <title>Zeus</title>
    <style>
      html,
      body,
      #root {
        width: 100%;
        height: 100%;
        margin: 0;
      }

      body {
        overflow: hidden;
        background: #f7f7f8;
      }

      .zeus-startup-loader {
        position: fixed;
        inset: 0;
        display: grid;
        place-items: center;
        pointer-events: none;
        user-select: none;
      }

      .zeus-startup-icon {
        width: 72px;
        height: 72px;
        animation: zeus-startup-pulse 1.4s ease-in-out infinite;
      }

      @keyframes zeus-startup-pulse {
        0%,
        100% {
          opacity: 0.76;
          transform: scale(0.98);
        }
        50% {
          opacity: 1;
          transform: scale(1);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .zeus-startup-icon {
          animation: none;
        }
      }
    </style>
  </head>
  <body>
    <div id="root">
      <div class="zeus-startup-loader" aria-hidden="true">
        <img class="zeus-startup-icon" src="./assets/icon.svg" alt="" tabindex="-1" draggable="false" />
      </div>
    </div>
    <script type="module" src="/src/renderer/main.tsx"></script>
  </body>
</html>
```

- [x] **Step 4: 让实际 app.asar 健康检查拒绝旧文案或缺失启动壳**

在 `assertPackagedRendererEntrypoint()` 读取 `html` 后加入：

```js
const forbiddenStartupCopy = [
  '正在启动本地服务',
  '本地服务连接失败',
  '本机 API 暂不可用',
  'Connecting local service',
  'Local service unavailable',
  'Local API temporarily unavailable',
];
if (!html.includes('zeus-startup-loader') || !html.includes('prefers-reduced-motion')) {
  throw new Error('packaged renderer is missing the Zeus startup shell contract');
}
for (const forbidden of forbiddenStartupCopy) {
  if (html.includes(forbidden)) {
    throw new Error(`packaged renderer exposes forbidden startup infrastructure copy: ${forbidden}`);
  }
}
```

已有 `assetRefs` 循环继续验证 Vite 构建后的 icon 和脚本引用真实存在；不新增依赖。

- [x] **Step 5: 运行 Renderer 与 package 契约并确认 GREEN**

Run:

```bash
pnpm vitest run apps/desktop/test/renderer.test.tsx scripts/package-mac.test.ts --reporter=verbose
```

Expected: 两个文件全部 PASS；CSP、相对资源路径和原有签名/健康检查契约不回归。

---

### Task 5: 从产品 App 与样式中删除本地服务技术状态旧模式

**Files:**
- Modify: `apps/desktop/test/renderer.test.tsx:219-284,1375-1410`
- Modify: `apps/desktop/src/renderer/App.tsx:143,596-618,1981-2003,3230-3253,5463-5464,5787-5788,7875-7879,8048,8094,8846,8955,13476-13488`
- Modify: `apps/desktop/src/renderer/styles.css:5600-5633,8063-8065,8090-8092,8109-8111,8119-8132`
- Modify: `apps/desktop/src/renderer/main.tsx:27-34`

- [x] **Step 1: 把旧正向测试改为禁止技术状态进入产品 UI**

用以下两个测试替换 `keeps action buttons disabled before...` 和 `normalizes the local client notice...`：

```ts
it('keeps repository actions honest without exposing startup infrastructure state', () => {
  const html = renderToStaticMarkup(<App />);

  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>选择真实本地代码库<\/button>/);
  for (const forbidden of ['正在连接本地服务', '本地服务连接失败', '本机 API 暂不可用', 'Connecting local service', 'Local service unavailable', 'Local API temporarily unavailable']) {
    expect(html).not.toContain(forbidden);
  }
});

it('removes the retired local-client notice model from source, styles, and both languages', () => {
  const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
  const rendered = [renderToStaticMarkup(<App />), renderToStaticMarkup(<App initialAppShellSettings={createAppShellSettings('en-US')} />)].join('\n');

  expect(source).not.toContain('LocalClientStatus');
  expect(source).not.toContain('LocalClientNotice');
  expect(source).not.toContain('localClientNotice');
  expect(source).not.toContain('localClientStatus');
  expect(css).not.toContain('local-client-notice');
  for (const forbidden of ['正在连接本地服务', '本地服务连接失败', '本机 API 暂不可用', 'Connecting local service', 'Local service unavailable', 'Local API temporarily unavailable']) {
    expect(`${source}\n${rendered}`).not.toContain(forbidden);
  }
});
```

从其他测试 JSX 中删除 `localClientStatus="ready"`；保留原 callbacks 和 snapshot。

- [x] **Step 2: 运行两个新用例并确认 RED**

Run:

```bash
pnpm vitest run apps/desktop/test/renderer.test.tsx -t "startup infrastructure state|retired local-client" --reporter=verbose
```

Expected: 旧 copy、`LocalClientNotice` 与 CSS class 断言 FAIL。

- [x] **Step 3: 删除 App 的状态模型、copy、props 和可见组件**

在 `App.tsx` 执行以下精确变更：

1. 删除 `export type LocalClientStatus = 'connecting' | 'ready' | 'failed';`。
2. 从中英文 copy 和 `satisfies` 类型中删除整个 `localClientNotice`；从 `sidebar` 删除 `connectingRepository`、`localServerFailed`。
3. 从 `App` props 删除 `localClientStatus`、`localClientError`。
4. 用下面一行替换 `localClientStatus` / `localClientReady` 两行：

```ts
const projectCreationReady = Boolean(props.onCreateCurrentProject);
```

5. 把 repository label 函数替换为：

```ts
function repositoryPickerLabel(): string {
  if (actionState === 'creating-project') return uiCopy.sidebar.creatingRepository;
  return uiCopy.sidebar.selectRepository;
}
```

6. 把创建能力判断分别改为：

```tsx
canCreateProject={projectCreationReady && !creatingProjectBusy}
```

```ts
disabled: !projectCreationReady || creatingProjectBusy,
```

7. 把任务列表状态改为：

```tsx
listState={!props.snapshot ? 'loading' : 'ready'}
```

8. 删除 workspace 顶部的 `LocalClientNotice` 渲染和文件末尾整个 `LocalClientNotice` 函数。
9. 从 `main.tsx` 成功渲染的 `<App>` 删除 `localClientStatus="ready"`。

- [x] **Step 4: 删除只服务于旧状态行的 CSS，并收紧组合选择器**

删除 `styles.css:5600-5633` 整个 `.local-client-notice-*` 块；从三组空态 `:where(...)` 中删除 `.local-client-notice-row`。把组合规则替换为：

```css
.macos-ai-app .project-inline-recovery-row {
  grid-template-columns: minmax(0, 1fr) auto;
}

@media (max-width: 860px) {
  .macos-ai-app .project-inline-recovery-row {
    align-items: stretch;
    grid-template-columns: minmax(0, 1fr);
  }
}
```

同步从 `keeps empty error and waiting states compact...` 测试的 className 数组删除 `local-client-notice-row`，并把两条组合选择器断言改为只断言 `.project-inline-recovery-row`。

- [x] **Step 5: 运行 Renderer 全文件并确认 GREEN**

Run:

```bash
pnpm vitest run apps/desktop/test/renderer.test.tsx --reporter=verbose
```

Expected: 文件全部 PASS；`<App />` 没有基础设施文案，缺少真实 callback 时“选择真实本地代码库”仍 disabled。

- [x] **Step 6: 反向搜索用户明确拒绝的旧模式**

Run:

```bash
! rg -n "正在连接本地服务|本地服务连接失败|本机 API 暂不可用|Connecting local service|Local service unavailable|Local API temporarily unavailable" apps/desktop/src apps/desktop/index.html
! rg -n "local-client-notice|LocalClientNotice|localClientNotice|localClientStatus|localClientError" apps/desktop/src apps/desktop/test/renderer.test.tsx
```

Expected: 两条命令均 exit 0 且无输出。其他业务语境中的“本地服务”设置、日志或源码标识不在本次删除范围内。

---

### Task 6: 完整验证、正式打包与真实冷启动取证

**Files:**
- Modify after evidence: `docs/TASK_20260716_001_Zeus本地服务IPC注册时序故障排查.html`

- [x] **Step 1: 运行本任务聚焦回归**

Run:

```bash
pnpm vitest run apps/desktop/test/startup-coordinator.test.ts apps/desktop/test/main-runtime.test.ts apps/desktop/test/renderer.test.tsx apps/desktop/test/error-boundary.test.tsx scripts/package-mac.test.ts --reporter=verbose
```

Expected: 5 个测试文件全部 PASS，无 unhandled rejection；失败必须回到对应 Task 修复，不能放宽断言跳过。

- [x] **Step 2: 运行全仓质量门禁**

逐条执行并分别保存 exit code 与测试计数：

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test
git diff --check
```

Expected: 全部 exit 0。由于工作区原本已有大量改动，任何失败都要区分“本任务引入”与“既有 dirty 变更”，但两类都不能被误报为通过。

- [x] **Step 3: 做最终反向扫描与启动路径审计**

Run:

```bash
! rg -n "正在连接本地服务|本地服务连接失败|本机 API 暂不可用|Connecting local service|Local service unavailable|Local API temporarily unavailable" apps/desktop/src apps/desktop/index.html
rg -n "createWindow\(|requestMainWindow\(|revealOrCreateMainWindow\(|app\.on\('activate'|second-instance|setupIpc" apps/desktop/src/main/main.ts
```

Expected: 禁用文案搜索无输出；启动路径能逐项证明 initial / activate / second-instance / show-main 全部进入 `requestMainWindow()`，只有初始化后的显式 Tray 新建窗口直接调用 `createWindow()`。

- [x] **Step 4: 在不终止用户进程的前提下正式打包**

Run:

```bash
pnpm package:mac
```

如果脚本报告打包 Zeus 正在运行，立即停止，不执行 `pkill`；请用户正常退出该 App 后重跑。Expected: build、electron-builder、ad-hoc codesign 和 strict verify 全部 exit 0。

随后运行：

```bash
node scripts/verify-packaged-app-health.mjs dist/mac-arm64/Zeus.app
/usr/bin/codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Zeus.app
```

Expected: health 输出包含 `packaged-health=Zeus`，codesign 返回 `valid on disk` / `satisfies its Designated Requirement`。

- [x] **Step 5: 做一次真实 Finder / Dock 等价冷启动**

在确认没有其他 Zeus 实例后执行：

```bash
APP_PATH="$(pwd)/dist/mac-arm64/Zeus.app"
open -na "$APP_PATH"
sleep 5
/bin/ps -ax -o pid=,ppid=,args= | rg "Zeus Helper \(Renderer\).*--type=renderer"
```

Expected: 只出现 1 条属于该 bundle 的 Renderer 进程。采集 Appshot：首个可见窗口只出现 Zeus 图标、没有技术状态文字，随后同一窗口进入正常工作区；不得出现第二窗口。

再运行：

```bash
/usr/bin/log show --last 2m --style compact --predicate '(process == "Zeus") OR (process == "Zeus Helper (Renderer)")' | rg -n "No handler registered|Zeus startup failed|dashboard hydration failed"
```

Expected: 无匹配输出。若有匹配，保留完整时间戳、PID 和 Appshot，回到 Task 2/3，不能把测试通过当作冷启动通过。

- [x] **Step 6: 回到原始需求逐项验收并更新主任务 HTML**

只根据真实输出更新：

- F1：coordinator 行为测试的用例数和命令。
- F2：source/index 反向扫描、reduced-motion 和无文字启动壳测试。
- V1：全仓门禁、`package:mac`、asar health、codesign、Renderer 进程数、日志扫描和 Appshot 时间。
- 任一项未执行或受外部状态阻塞时保留“未执行/部分验证”，不得改成“通过”。
- footer 增加本实施计划路径，保持主 HTML 是任务总入口。

- [x] **Step 7: 最终审查受影响 Git 范围**

Run:

```bash
git status --short -- apps/desktop/src/main/startupCoordinator.ts apps/desktop/src/main/main.ts apps/desktop/src/preload/index.cts apps/desktop/src/renderer/global.d.ts apps/desktop/src/renderer/main.tsx apps/desktop/src/renderer/ErrorBoundary.tsx apps/desktop/src/renderer/App.tsx apps/desktop/src/renderer/styles.css apps/desktop/index.html apps/desktop/test/startup-coordinator.test.ts apps/desktop/test/main-runtime.test.ts apps/desktop/test/renderer.test.tsx apps/desktop/test/error-boundary.test.tsx scripts/verify-packaged-app-health.mjs scripts/package-mac.test.ts docs/TASK_20260716_001_Zeus本地服务IPC注册时序故障排查.html docs/superpowers/plans/2026-07-16-zeus-ipc-startup-gate.md
git diff --stat -- apps/desktop/src/main apps/desktop/src/preload/index.cts apps/desktop/src/renderer apps/desktop/index.html apps/desktop/test scripts/verify-packaged-app-health.mjs scripts/package-mac.test.ts docs/TASK_20260716_001_Zeus本地服务IPC注册时序故障排查.html docs/superpowers/plans/2026-07-16-zeus-ipc-startup-gate.md
```

Expected: 只把本任务新增/修改块归因于本任务；同文件内用户既有改动必须保留并在交付摘要中区分。没有用户明确授权时，不执行 `git add` 或 commit。

## 回滚顺序

1. 恢复 `main.ts` 原 lifecycle wiring 前，先删除 `startupCoordinator` import 和对应新测试，避免编译悬空。
2. 恢复 Renderer 旧 bootstrap 前，成组回滚 Main IPC、preload bridge、`global.d.ts` 和 `main.tsx`，不能只回滚一侧。
3. 恢复 `index.html` 前，同时撤销 package health 中 `zeus-startup-loader` 契约；CSP 和相对资源检查必须保留。
4. App 技术状态行不作为推荐回滚目标；若启动门禁回滚，优先保留无技术文案原则并继续使用原生通用提示，而不是恢复用户已拒绝的页面提示。
5. 本任务不含 DB、配置或数据迁移，因此不需要数据回滚。

## Self-review

- Spec coverage：initial / activate / second-instance、零预就绪窗口、单在途窗口、无文字 Zeus 启动壳、reduced-motion、Renderer bootstrap 回传、一次性系统提示、日志详情、打包与真实冷启动均有对应 Task 和验收命令。
- File responsibility：Promise 语义集中在纯 `startupCoordinator.ts`；Electron 生命周期留在 `main.ts`；等待视觉只在 `index.html`；产品 `App` 不再拥有基础设施启动状态。
- Type consistency：`reportRendererBootstrapFailure(message: string): void` 在 preload、global type 和 Renderer 调用处一致；`startupCoordinator.fail(error: unknown): Promise<void>` 同时服务 Main 初始化、preload 和 Renderer bootstrap。
- Placeholder scan：所有新增函数、测试、命令和 expected outcome 均已给出；`main.tsx` 约 250 行现有业务 callbacks 被明确限定为逐行保留，避免计划复制后覆盖用户 dirty 改动。
- Dirty-worktree safety：每阶段均有聚焦 diff 检查；不自动格式化全文件，不自动 kill 正在运行的打包 App，不自行执行 Git 历史或远端动作。
