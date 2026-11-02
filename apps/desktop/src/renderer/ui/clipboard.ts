/** 优先使用原生剪贴板，网页入口沿用浏览器与选区复制。 */
export async function copyText(
  text: string,
  services: {
    writeNative?: (value: string) => Promise<{ written: boolean } | undefined>;
    writeWeb?: (value: string) => Promise<void>;
    writeLegacy?: (value: string) => boolean;
  } = {},
): Promise<boolean> {
  const writeNative = services.writeNative ?? ((value: string) => globalThis.window?.zeus?.writeClipboardText?.(value));
  try {
    const result = await writeNative(text);
    if (result?.written) return true;
  } catch {
    // 原生桥不可用时继续尝试浏览器与选区兜底。
  }
  const writeWeb = services.writeWeb ?? globalThis.navigator?.clipboard?.writeText?.bind(globalThis.navigator.clipboard);
  try {
    if (writeWeb) {
      await writeWeb(text);
      return true;
    }
  } catch {
    // file:// 页面通常没有 Clipboard API 权限，继续使用同步选区兜底。
  }
  return (services.writeLegacy ?? copyTextWithSelection)(text);
}

/** Clipboard API 不可用时通过原生选区复制文本。 */
function copyTextWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') return false;
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.inset = '0 auto auto -10000px';
  textarea.style.opacity = '0';
  textarea.style.position = 'fixed';
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
  return copied;
}
