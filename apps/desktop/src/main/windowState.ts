import {mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export interface WindowBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface WindowSize {
    width: number;
    height: number;
}

export interface WindowDisplaySnapshot {
    id: string | number;
    label: string;
    internal: boolean;
    rotation: number;
    scaleFactor: number;
    size: WindowSize;
    workArea: WindowBounds;
}

export interface PersistedWindowDisplayState {
    id: string;
    workArea: WindowBounds;
    label?: string;
    internal?: boolean;
    rotation?: number;
    scaleFactor?: number;
    size?: WindowSize;
}

export interface PersistedMainWindowState {
    version: 2;
    bounds: WindowBounds;
    display: PersistedWindowDisplayState;
    isMaximized: boolean;
    isFullScreen: boolean;
}

export type WindowDisplayMatchKind = 'exact-id' | 'full-fingerprint' | 'partial-fingerprint' | 'layout-nearest';

export interface WindowDisplayMatch {
    display: WindowDisplaySnapshot;
    kind: WindowDisplayMatchKind;
}

export interface ResolvedMainWindowState {
    bounds: WindowBounds;
    isMaximized: boolean;
    isFullScreen: boolean;
    targetDisplayId?: string;
    matchedSavedDisplay: boolean;
    matchKind: WindowDisplayMatchKind | 'first-launch' | 'primary-fallback' | 'unavailable';
}

export const defaultMainWindowSize = {width: 1240, height: 820} as const;
export const minimumMainWindowSize = {width: 360, height: 560} as const;

/** 从独立的 Main 进程状态文件读取窗口偏好；v1 会在内存中转成 v2，损坏数据只回退默认值。 */
export function readPersistedMainWindowState(filePath: string): PersistedMainWindowState | undefined {
    try {
        return normalizePersistedMainWindowState(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch {
        return undefined;
    }
}

/** 原子替换窗口状态文件，避免进程退出或断电时留下半截 JSON。 */
export function writePersistedMainWindowState(filePath: string, state: PersistedMainWindowState): boolean {
    const normalized = normalizePersistedMainWindowState(state);
    if (!normalized) return false;
    const temporaryPath = `${filePath}.tmp`;
    try {
        mkdirSync(dirname(filePath), {recursive: true});
        writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
        renameSync(temporaryPath, filePath);
        return true;
    } catch {
        try {
            unlinkSync(temporaryPath);
        } catch {
            // 临时文件可能尚未创建；窗口状态写入失败不应覆盖真实启动故障。
        }
        return false;
    }
}

export function createPersistedMainWindowState(input: {
    bounds: WindowBounds;
    display: WindowDisplaySnapshot;
    isMaximized: boolean;
    isFullScreen: boolean
}): PersistedMainWindowState | undefined {
    return normalizePersistedMainWindowState({
        version: 2,
        bounds: input.bounds,
        display: {
            id: String(input.display.id),
            label: input.display.label,
            internal: input.display.internal,
            rotation: input.display.rotation,
            scaleFactor: input.display.scaleFactor,
            size: input.display.size,
            workArea: input.display.workArea,
        },
        isMaximized: input.isMaximized,
        isFullScreen: input.isFullScreen,
    });
}

/**
 * 恢复窗口时按显示器 ID、完整指纹、部分指纹和旧布局距离逐级匹配。
 * 只有所有匹配方式都失败时才回退主屏，避免显示器重新枚举后无条件跳回 main display。
 */
export function findSavedWindowDisplay(persisted: PersistedMainWindowState, displays: readonly WindowDisplaySnapshot[]): WindowDisplayMatch | undefined {
    const availableDisplays = displays.map(normalizeDisplay).filter((display): display is WindowDisplaySnapshot => Boolean(display));
    const savedDisplay = persisted.display;
    const exactIdMatch = isUsableDisplayId(savedDisplay.id) ? availableDisplays.find((display) => String(display.id) === savedDisplay.id) : undefined;
    if (exactIdMatch) return {display: exactIdMatch, kind: 'exact-id'};
    if (!hasCompleteDisplayFingerprint(savedDisplay)) return undefined;

    const fullFingerprintMatches = availableDisplays.filter(
        (display) =>
            display.internal === savedDisplay.internal &&
            normalizeLabel(display.label) === normalizeLabel(savedDisplay.label) &&
            display.rotation === savedDisplay.rotation &&
            sizesEqual(display.size, savedDisplay.size) &&
            Math.abs(display.scaleFactor - savedDisplay.scaleFactor) < 0.01,
    );
    const fullFingerprintMatch = chooseDisplayMatch(fullFingerprintMatches, savedDisplay.workArea, 'full-fingerprint');
    if (fullFingerprintMatch) return fullFingerprintMatch;

    const partialFingerprintMatches = availableDisplays.filter((display) => display.internal === savedDisplay.internal && normalizeLabel(display.label) === normalizeLabel(savedDisplay.label) && display.rotation === savedDisplay.rotation);
    return chooseDisplayMatch(partialFingerprintMatches, savedDisplay.workArea, 'partial-fingerprint');
}

/**
 * 恢复窗口时优先找回原显示器，并按原显示器工作区偏移重建位置。
 * 显示器已移除时回退主屏居中；分辨率或排列变化时把窗口完整夹在可见工作区内。
 */
export function resolveMainWindowState(persisted: PersistedMainWindowState | undefined, displays: readonly WindowDisplaySnapshot[], primaryDisplay: WindowDisplaySnapshot): ResolvedMainWindowState {
    const normalizedPrimary = normalizeDisplay(primaryDisplay);
    const availableDisplays = displays.map(normalizeDisplay).filter((display): display is WindowDisplaySnapshot => Boolean(display));
    const primary = normalizedPrimary ?? availableDisplays[0];
    if (!primary) {
        return {
            bounds: {x: 0, y: 0, ...defaultMainWindowSize},
            isMaximized: false,
            isFullScreen: false,
            matchedSavedDisplay: false,
            matchKind: 'unavailable',
        };
    }

    if (!persisted) {
        return {
            bounds: centerWindow(defaultMainWindowSize, primary.workArea),
            isMaximized: false,
            isFullScreen: false,
            targetDisplayId: String(primary.id),
            matchedSavedDisplay: false,
            matchKind: 'first-launch',
        };
    }

    const displayMatch = findSavedWindowDisplay(persisted, availableDisplays);
    const targetDisplay = displayMatch?.display ?? primary;
    const size = fitWindowSize(persisted.bounds, targetDisplay.workArea);
    const desiredPosition = displayMatch
        ? {
            x: targetDisplay.workArea.x + (persisted.bounds.x - persisted.display.workArea.x),
            y: targetDisplay.workArea.y + (persisted.bounds.y - persisted.display.workArea.y),
        }
        : centerWindow(size, targetDisplay.workArea);

    return {
        bounds: clampWindowToWorkArea({...desiredPosition, ...size}, targetDisplay.workArea),
        isMaximized: persisted.isMaximized,
        isFullScreen: persisted.isFullScreen,
        targetDisplayId: String(targetDisplay.id),
        matchedSavedDisplay: Boolean(displayMatch),
        matchKind: displayMatch?.kind ?? 'primary-fallback',
    };
}

export function normalizePersistedMainWindowState(value: unknown): PersistedMainWindowState | undefined {
    if (!isRecord(value)) return undefined;
    if (value.version === 1) return normalizeLegacyPersistedMainWindowState(value);
    if (value.version !== 2) return undefined;

    const bounds = normalizeBounds(value.bounds);
    const display = normalizePersistedDisplay(value.display);
    if (!bounds || !display) return undefined;
    if (typeof value.isMaximized !== 'boolean' || typeof value.isFullScreen !== 'boolean') return undefined;
    return {
        version: 2,
        bounds,
        display,
        isMaximized: value.isMaximized,
        isFullScreen: value.isFullScreen,
    };
}

function normalizeLegacyPersistedMainWindowState(value: Record<string, unknown>): PersistedMainWindowState | undefined {
    const bounds = normalizeBounds(value.bounds);
    const workArea = normalizeBounds(value.displayWorkArea);
    if (!bounds || !workArea || (typeof value.displayId !== 'string' && typeof value.displayId !== 'number')) return undefined;
    if (typeof value.isMaximized !== 'boolean' || typeof value.isFullScreen !== 'boolean') return undefined;
    return {
        version: 2,
        bounds,
        display: {id: String(value.displayId), workArea},
        isMaximized: value.isMaximized,
        isFullScreen: value.isFullScreen,
    };
}

function normalizePersistedDisplay(value: unknown): PersistedWindowDisplayState | undefined {
    if (!isRecord(value) || (typeof value.id !== 'string' && typeof value.id !== 'number')) return undefined;
    const workArea = normalizeBounds(value.workArea);
    if (!workArea) return undefined;
    const normalized: PersistedWindowDisplayState = {id: String(value.id), workArea};
    const size = normalizeSize(value.size);
    const label = typeof value.label === 'string' ? value.label.trim() : undefined;
    const internal = typeof value.internal === 'boolean' ? value.internal : undefined;
    const rotation = normalizeRotation(value.rotation);
    const scaleFactor = typeof value.scaleFactor === 'number' && Number.isFinite(value.scaleFactor) && value.scaleFactor > 0 ? value.scaleFactor : undefined;
    if (label !== undefined && internal !== undefined && rotation !== undefined && scaleFactor !== undefined && size) {
        Object.assign(normalized, {label, internal, rotation, scaleFactor, size});
    }
    return normalized;
}

function normalizeDisplay(value: WindowDisplaySnapshot): WindowDisplaySnapshot | undefined {
    const workArea = normalizeBounds(value?.workArea);
    const size = normalizeSize(value?.size);
    const rotation = normalizeRotation(value?.rotation);
    if (!workArea || !size || rotation === undefined || (typeof value?.id !== 'string' && typeof value?.id !== 'number')) return undefined;
    if (typeof value.label !== 'string' || typeof value.internal !== 'boolean') return undefined;
    if (typeof value.scaleFactor !== 'number' || !Number.isFinite(value.scaleFactor) || value.scaleFactor <= 0) return undefined;
    return {
        id: value.id,
        label: value.label.trim(),
        internal: value.internal,
        rotation,
        scaleFactor: value.scaleFactor,
        size,
        workArea,
    };
}

function chooseDisplayMatch(candidates: readonly WindowDisplaySnapshot[], savedWorkArea: WindowBounds, uniqueKind: Exclude<WindowDisplayMatchKind, 'exact-id' | 'layout-nearest'>): WindowDisplayMatch | undefined {
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return {display: candidates[0], kind: uniqueKind};
    const ranked = candidates.map((display) => ({
        display,
        distance: squaredCenterDistance(display.workArea, savedWorkArea)
    })).sort((left, right) => left.distance - right.distance);
    if (ranked.length > 1 && ranked[0].distance === ranked[1].distance) return undefined;
    return {display: ranked[0].display, kind: 'layout-nearest'};
}

function squaredCenterDistance(left: WindowBounds, right: WindowBounds): number {
    const deltaX = left.x + left.width / 2 - (right.x + right.width / 2);
    const deltaY = left.y + left.height / 2 - (right.y + right.height / 2);
    return deltaX * deltaX + deltaY * deltaY;
}

function hasCompleteDisplayFingerprint(display: PersistedWindowDisplayState): display is PersistedWindowDisplayState & Required<Pick<PersistedWindowDisplayState, 'label' | 'internal' | 'rotation' | 'scaleFactor' | 'size'>> {
    return display.label !== undefined && display.internal !== undefined && display.rotation !== undefined && display.scaleFactor !== undefined && display.size !== undefined;
}

function normalizeBounds(value: unknown): WindowBounds | undefined {
    if (!isRecord(value)) return undefined;
    const {x, y, width, height} = value;
    if (![x, y, width, height].every((part) => typeof part === 'number' && Number.isFinite(part))) return undefined;
    if ((width as number) <= 0 || (height as number) <= 0) return undefined;
    return {
        x: Math.round(x as number),
        y: Math.round(y as number),
        width: Math.round(width as number),
        height: Math.round(height as number),
    };
}

function normalizeSize(value: unknown): WindowSize | undefined {
    if (!isRecord(value)) return undefined;
    const {width, height} = value;
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return undefined;
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined;
    return {width: Math.round(width), height: Math.round(height)};
}

function normalizeRotation(value: unknown): number | undefined {
    return typeof value === 'number' && [0, 90, 180, 270].includes(value) ? value : undefined;
}

function normalizeLabel(value: string): string {
    return value.trim().toLocaleLowerCase();
}

function sizesEqual(left: WindowSize, right: WindowSize): boolean {
    return left.width === right.width && left.height === right.height;
}

function isUsableDisplayId(id: string): boolean {
    return id !== '-1' && id !== '-10';
}

function fitWindowSize(bounds: Pick<WindowBounds, 'width' | 'height'>, workArea: WindowBounds): Pick<WindowBounds, 'width' | 'height'> {
    return {
        width: Math.min(workArea.width, Math.max(minimumMainWindowSize.width, bounds.width)),
        height: Math.min(workArea.height, Math.max(minimumMainWindowSize.height, bounds.height)),
    };
}

function centerWindow(size: Pick<WindowBounds, 'width' | 'height'>, workArea: WindowBounds): WindowBounds {
    const fitted = fitWindowSize(size, workArea);
    return {
        x: Math.round(workArea.x + (workArea.width - fitted.width) / 2),
        y: Math.round(workArea.y + (workArea.height - fitted.height) / 2),
        ...fitted,
    };
}

function clampWindowToWorkArea(bounds: WindowBounds, workArea: WindowBounds): WindowBounds {
    const size = fitWindowSize(bounds, workArea);
    return {
        x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - size.width),
        y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - size.height),
        ...size,
    };
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.round(Math.min(Math.max(value, minimum), Math.max(minimum, maximum)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
