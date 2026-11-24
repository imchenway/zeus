import { app, BrowserWindow } from 'electron';

/** 交付窗口在透明状态恢复边界，整窗一起显隐，避免标题栏和正文分开绘制。 */
export function createGitDeliveryWindowPresentation(window: BrowserWindow, owner: BrowserWindow, restore: (show: () => void) => void) {
  /** Electron 在 macOS 和 Windows 支持原生窗口透明度。 */
  const animate = process.platform === 'darwin' || process.platform === 'win32';
  /** 未收到页面的系统动效偏好时直接显示或隐藏。 */
  let reduceMotion = true;
  /** 区分可操作窗体、透明等待和正在关闭的窗体。 */
  let phase: 'hidden' | 'opening' | 'visible' | 'closing' = 'hidden';
  /** 页面迟迟没有回报绘制帧时，显示窗口当前的加载或错误状态。 */
  let revealDeadline: ReturnType<typeof setTimeout> | undefined;
  /** 同一窗口只运行一段原生过渡。 */
  let opacityTimer: ReturnType<typeof setInterval> | undefined;
  /** 接纳完成可能在关闭过渡中到达，隐藏后使用最新的资源处置方式。 */
  let afterHide: (() => void) | undefined;

  /** 重开或窗口销毁时取消未完成的过渡。 */
  function cancelTimers(): void {
    clearTimeout(revealDeadline);
    clearInterval(opacityTimer);
  }

  /** 以窗体当前透明度开始，反向操作不会跳回过渡起点。 */
  function fade(to: 0 | 1, durationMs: number, complete: () => void): void {
    clearInterval(opacityTimer);
    if (!animate || reduceMotion) {
      if (animate) window.setOpacity(to);
      complete();
      return;
    }
    /** 用单调时钟计算进度，避免主进程暂忙时积累延迟。 */
    const start = performance.now();
    const from = window.getOpacity();
    if (from === to) {
      complete();
      return;
    }
    opacityTimer = setInterval(() => {
      /** 时间归一化后使用缓出，让尾部变化逐渐减小。 */
      const progress = Math.min(1, (performance.now() - start) / durationMs);
      window.setOpacity(from + (to - from) * (1 - (1 - progress) ** 3));
      if (progress < 1) return;
      clearInterval(opacityTimer);
      complete();
    }, 16);
  }

  /** 只有真正呈现后才把操作焦点交给交付窗口。 */
  function focus(): void {
    window.focus();
    // Windows 的 app.focus 会把焦点转向首个可见窗口。
    if (process.platform !== 'win32') app.focus({ steal: true });
  }

  /** 显示已经绘制的内容，或在读取仍未完成时显示现有加载状态。 */
  function present(): void {
    if (phase !== 'opening') return;
    cancelTimers();
    phase = 'visible';
    window.webContents.backgroundThrottling = true;
    window.setIgnoreMouseEvents(false);
    focus();
    fade(1, 160, () => undefined);
  }

  window.once('closed', cancelTimers);
  window.webContents.on('before-input-event', (event) => {
    if (phase === 'closing') event.preventDefault();
  });

  return {
    /** 显示前恢复实际尺寸，并让 Chromium 在最终尺寸上绘制。 */
    open(): void {
      if (phase === 'opening') return;
      if (phase === 'visible') {
        if (window.isMinimized()) window.restore();
        focus();
        window.webContents.send('zeus:task-git-delivery:request-frame');
        return;
      }
      /** 快速重开沿用正在退出的画面，隐藏后重开再从透明开始。 */
      const reopening = phase === 'closing' && window.isVisible();
      cancelTimers();
      afterHide = undefined;
      phase = 'opening';
      if (animate && !reopening) window.setOpacity(0);
      window.setIgnoreMouseEvents(true);
      window.webContents.backgroundThrottling = false;
      if (window.isMinimized()) window.restore();
      restore(() => window.showInactive());
      revealDeadline = setTimeout(present, 1200);
      window.webContents.send('zeus:task-git-delivery:request-frame');
    },
    /** 窗口外壳已经绘制时即可呈现，稍后到达的内容帧由窗口状态去重。 */
    frame(prefersReducedMotion: boolean): void {
      reduceMotion = prefersReducedMotion;
      present();
    },
    /** 保留正文直到退出过渡结束，再隐藏窗体并交还焦点。 */
    hide(complete?: () => void): void {
      if (complete) afterHide = complete;
      if (phase === 'closing') return;
      if (phase === 'hidden') {
        afterHide?.();
        afterHide = undefined;
        return;
      }
      /** 用户切去别处后，关闭动作不抢回焦点。 */
      const restoreFocus = window.isFocused();
      cancelTimers();
      phase = 'closing';
      window.setIgnoreMouseEvents(true);
      fade(0, 120, () => {
        phase = 'hidden';
        window.webContents.backgroundThrottling = true;
        window.hide();
        /** 系统焦点可能尚未离开刚隐藏的窗口，仍可交还原入口。 */
        const focused = BrowserWindow.getFocusedWindow();
        if (restoreFocus && !owner.isDestroyed() && owner.isVisible() && (!focused || focused === window)) owner.focus();
        /** 回调可能销毁当前原生窗口，先释放持有引用。 */
        const done = afterHide;
        afterHide = undefined;
        done?.();
      });
    },
  };
}
