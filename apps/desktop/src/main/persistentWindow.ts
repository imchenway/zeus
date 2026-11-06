import { app, BrowserWindow, screen, type BrowserWindowConstructorOptions, type Rectangle } from 'electron';
import { join } from 'node:path';
import { applyRestoredMainWindowPlacement, createWindowStatePersistenceGate, type WindowPlacementResult } from './windowRestoration.js';
import { createPersistedMainWindowState, readPersistedMainWindowState, resolveMainWindowState, writePersistedMainWindowState, type ResolvedMainWindowState } from './windowState.js';

/** 所有可调整的工作窗口共用创建、恢复和保存流程，文件名仅区分各类窗口的偏好。 */
export function createPersistentWindow(stateFileName: string, options: BrowserWindowConstructorOptions & Rectangle, initialState?: ResolvedMainWindowState): { window: BrowserWindow; reveal: (show?: () => void) => WindowPlacementResult } {
  /** 偏好与当前应用数据身份隔离，测试应用不会读写正式窗口记录。 */
  const filePath = join(app.getPath('userData'), stateFileName);
  /** 原屏幕不可用时使用调用入口所在的屏幕。 */
  const display = screen.getDisplayMatching(options);
  /** 读取最近成功保存的窗口状态。 */
  const persisted = readPersistedMainWindowState(filePath);
  /** 初次打开沿用各窗口自己的默认大小，后续按记录恢复。 */
  const restored =
    initialState ??
    (persisted
      ? resolveMainWindowState(persisted, screen.getAllDisplays(), display, { width: options.minWidth ?? 0, height: options.minHeight ?? 0 })
      : {
          bounds: { x: options.x, y: options.y, width: options.width, height: options.height },
          isMaximized: false,
          isFullScreen: false,
          targetDisplayId: String(display.id),
          matchedSavedDisplay: false,
          matchKind: 'first-launch' as const,
        });
  /** 原生窗口从创建时就使用恢复后的边界。 */
  const window = new BrowserWindow({
    ...options,
    parent: options.modal ? options.parent : undefined,
    movable: true,
    ...restored.bounds,
    minWidth: Math.min(options.minWidth ?? 0, restored.bounds.width),
    minHeight: Math.min(options.minHeight ?? 0, restored.bounds.height),
    show: false,
  });
  /** 首次展示产生的系统事件不得覆盖用户原有记录。 */
  const gate = createWindowStatePersistenceGate();
  /** 合并连续拖动产生的写盘请求。 */
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** 展示后再等待原生最大化、全屏恢复完成。 */
  let activationTimer: ReturnType<typeof setTimeout> | undefined;
  /** 同一窗口只应用一次恢复，后续唤回不重置用户调整。 */
  let placement: WindowPlacementResult | undefined;
  /** 最小化不清除之前的最大化和全屏状态。 */
  let maximized = restored.isMaximized;
  let fullScreen = restored.isFullScreen;

  /** 同步写入完整状态，关闭窗口时不依赖尚未执行的延迟任务。 */
  function flush(final = false): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    if (window.isDestroyed()) return;
    // 关闭或退出必须采集最终尺寸，不能依赖平台是否发出了最后一次 resize。
    if (final && gate.phase === 'active') gate.recordChange();
    if (!gate.shouldPersist()) return;
    /** 最大化和全屏时仍记录普通尺寸，便于下次还原。 */
    const bounds = window.getNormalBounds();
    /** 展开窗口以当前所在屏幕为准，普通边界保留相对原屏幕的偏移。 */
    const normalDisplay = screen.getDisplayMatching(bounds);
    const currentDisplay = screen.getDisplayMatching(window.getBounds());
    if (normalDisplay.id !== currentDisplay.id && (window.isMaximized() || window.isFullScreen())) {
      bounds.x += currentDisplay.workArea.x - normalDisplay.workArea.x;
      bounds.y += currentDisplay.workArea.y - normalDisplay.workArea.y;
    }
    /** 边界、显示器与展开状态在同一次写入中保存。 */
    const state = createPersistedMainWindowState({
      bounds,
      display: screen.getDisplayMatching(bounds),
      isMaximized: window.isMinimized() ? maximized : window.isMaximized(),
      isFullScreen: window.isMinimized() ? fullScreen : window.isFullScreen(),
    });
    if (state && writePersistedMainWindowState(filePath, state)) gate.markPersisted();
    else console.warn(`Zeus 窗口偏好保存失败：${stateFileName}`);
  }

  /** 普通变化短暂合并，避免拖动时连续写盘。 */
  function scheduleSave(): void {
    if (!gate.recordChange()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
    saveTimer.unref();
  }

  /** 明确的用户拖动不受首次展示保护期限制。 */
  function recordUserChange(): void {
    gate.activate();
    scheduleSave();
  }

  window.on('will-move', recordUserChange);
  window.on('will-resize', recordUserChange);
  window.on('move', scheduleSave);
  window.on('resize', scheduleSave);
  window.on('maximize', () => {
    maximized = true;
    scheduleSave();
  });
  window.on('unmaximize', () => {
    maximized = false;
    scheduleSave();
  });
  window.on('enter-full-screen', () => {
    fullScreen = true;
    scheduleSave();
  });
  window.on('leave-full-screen', () => {
    fullScreen = false;
    scheduleSave();
  });
  window.on('minimize', () => flush(true));
  // 原生拖动结束或切走窗口时立即保存，下一次打开无需等待防抖计时。
  window.on('resized', () => {
    recordUserChange();
    flush();
  });
  window.on('blur', () => flush());
  window.on('close', () => flush(true));
  // 共用退出链最终调用 app.exit，不触发窗口 close；退出请求时先同步保存尚未写盘的调整。
  /** 退出和所属窗口关闭均走最终状态保存。 */
  const saveBeforeQuit = (): void => flush(true);
  const closeWithOwner = (): void => {
    if (!window.isDestroyed()) window.close();
  };
  app.on('before-quit', saveBeforeQuit);
  options.parent?.once('closed', closeWithOwner);
  window.on('closed', () => {
    app.removeListener('before-quit', saveBeforeQuit);
    options.parent?.removeListener('closed', closeWithOwner);
    if (saveTimer) clearTimeout(saveTimer);
    if (activationTimer) clearTimeout(activationTimer);
  });

  return {
    window,
    /** 首次显示前复核真实边界与落屏，再开启保存；重复显示只唤回窗口。 */
    reveal(show = () => window.show()) {
      if (!placement) {
        placement = applyRestoredMainWindowPlacement({ window, restored, getDisplayMatching: (bounds) => screen.getDisplayMatching(bounds), reveal: show });
        activationTimer = setTimeout(() => {
          if (!window.isDestroyed()) gate.activate();
        }, 500);
        activationTimer.unref();
      } else show();
      return placement;
    },
  };
}
