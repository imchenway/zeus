export const TEXTAREA_MAX_VIEWPORT_RATIO = 0.34;

export function resolveAutosizeTextareaHeight(scrollHeight: number, viewportHeight: number, minHeight = 48, maxViewportRatio = TEXTAREA_MAX_VIEWPORT_RATIO): number {
    const safeScrollHeight = Number.isFinite(scrollHeight) ? Math.max(0, scrollHeight) : minHeight;
    const safeViewportHeight = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
    const maxHeight = Math.max(minHeight, Math.floor(safeViewportHeight * maxViewportRatio));
    return Math.min(maxHeight, Math.max(minHeight, safeScrollHeight));
}

export function autosizeTextarea(textarea: HTMLTextAreaElement, minHeight = 48, maxViewportRatio = TEXTAREA_MAX_VIEWPORT_RATIO): void {
    textarea.style.blockSize = 'auto';
    const viewportHeight = textarea.ownerDocument.defaultView?.innerHeight ?? 800;
    const nextHeight = resolveAutosizeTextareaHeight(textarea.scrollHeight, viewportHeight, minHeight, maxViewportRatio);
    textarea.style.blockSize = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > nextHeight ? 'auto' : 'hidden';
}
