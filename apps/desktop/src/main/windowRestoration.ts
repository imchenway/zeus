import {
    findSavedWindowDisplay,
    type PersistedMainWindowState,
    type ResolvedMainWindowState,
    type WindowBounds,
    type WindowDisplayMatch,
    type WindowDisplaySnapshot
} from './windowState.js';

export interface WindowPlacementHost {
    setBounds(bounds: WindowBounds, animate?: boolean): void;

    getBounds(): WindowBounds;

    maximize(): void;

    setFullScreen(fullScreen: boolean): void;
}

export interface WindowPlacementResult {
    actualDisplayId?: string;
    corrected: boolean;
}

export interface WaitForSavedWindowDisplayOptions {
    persisted: PersistedMainWindowState;
    getDisplays: () => readonly WindowDisplaySnapshot[];
    subscribe: (listener: () => void) => () => void;
    timeoutMs: number;
}

export interface WindowStatePersistenceGate {
    readonly phase: 'restoring' | 'active';

    recordChange(): boolean;

    shouldPersist(): boolean;

    activate(): void;

    markPersisted(): void;
}

/** 恢复阶段忽略系统产生的移动事件；进入 active 后才把真实用户变化标记为待保存。 */
export function createWindowStatePersistenceGate(): WindowStatePersistenceGate {
    let phase: 'restoring' | 'active' = 'restoring';
    let dirty = false;
    return {
        get phase() {
            return phase;
        },
        recordChange() {
            if (phase !== 'active') return false;
            dirty = true;
            return true;
        },
        shouldPersist() {
            return phase === 'active' && dirty;
        },
        activate() {
            phase = 'active';
        },
        markPersisted() {
            dirty = false;
        },
    };
}

/** 目标屏尚未枚举时短暂监听显示器变化；超时后由调用方执行主屏回退。 */
export async function waitForSavedWindowDisplay(options: WaitForSavedWindowDisplayOptions): Promise<WindowDisplayMatch | undefined> {
    const currentMatch = findSavedWindowDisplay(options.persisted, options.getDisplays());
    if (currentMatch) return currentMatch;

    return await new Promise<WindowDisplayMatch | undefined>((resolve) => {
        let finished = false;
        const timeout: { current?: ReturnType<typeof setTimeout> } = {};
        let unsubscribe: () => void = () => undefined;
        const finish = (match: WindowDisplayMatch | undefined) => {
            if (finished) return;
            finished = true;
            if (timeout.current) clearTimeout(timeout.current);
            unsubscribe();
            resolve(match);
        };
        const checkDisplays = () => {
            const match = findSavedWindowDisplay(options.persisted, options.getDisplays());
            if (match) finish(match);
        };

        const subscribedCleanup = options.subscribe(checkDisplays);
        unsubscribe = subscribedCleanup;
        if (finished) {
            unsubscribe();
            return;
        }
        checkDisplays();
        if (finished) return;
        timeout.current = setTimeout(() => finish(undefined), Math.max(0, options.timeoutMs));
    });
}

/**
 * 在首次展示前重新应用普通窗口边界并核对真实显示器；若落屏错误，只允许再纠正一次。
 * 最大化和全屏必须在普通边界确定后恢复，避免 macOS 先在主屏展开窗口。
 */
export function applyRestoredMainWindowPlacement(input: {
    window: WindowPlacementHost;
    restored: ResolvedMainWindowState;
    getDisplayMatching: (bounds: WindowBounds) => WindowDisplaySnapshot;
    reveal: () => void
}): WindowPlacementResult {
    input.window.setBounds(input.restored.bounds, false);
    let actualDisplay = input.getDisplayMatching(input.window.getBounds());
    let corrected = false;
    if (input.restored.targetDisplayId !== undefined && String(actualDisplay.id) !== input.restored.targetDisplayId) {
        input.window.setBounds(input.restored.bounds, false);
        actualDisplay = input.getDisplayMatching(input.window.getBounds());
        corrected = true;
    }
    if (input.restored.isMaximized) input.window.maximize();
    if (input.restored.isFullScreen) input.window.setFullScreen(true);
    input.reveal();
    return {actualDisplayId: actualDisplay ? String(actualDisplay.id) : undefined, corrected};
}
