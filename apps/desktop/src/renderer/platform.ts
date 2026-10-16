/** 桌面快捷键和标题栏共用平台判断，浏览器预览也遵守当前系统习惯。 */
export function isMacOSPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');
}

/** 快捷键提示沿用系统符号；Windows 显示实际可用的 Ctrl、Alt 和 Shift。 */
export function platformShortcutLabel(label: string): string {
  return isMacOSPlatform() ? label : label.replaceAll('⌥⌘', 'Ctrl+Alt+').replaceAll('⇧⌘', 'Ctrl+Shift+').replaceAll('⌘ ', 'Ctrl+').replaceAll('⌘', 'Ctrl+').replaceAll('⌥', 'Alt+').replaceAll('⇧', 'Shift+');
}
