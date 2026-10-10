/** 超过阈值的粘贴文本保存成附件，避免撑大输入框。 */
export const PENDING_RESOURCE_LONG_TEXT_THRESHOLD = 5_000;
/** 只有限定长度的文本支持恢复到输入框。 */
export const PENDING_RESOURCE_RESTORABLE_TEXT_LIMIT = 25_000;

/** 自动生成的文本附件按内容展示，原始身份仍用于打开与保存。 */
export function isPendingResourceText(name: string, kind?: string): boolean {
  return kind === 'pasted_text' || name === 'Pasted text.txt';
}

/** 自动生成的文本使用中性名称，原始身份继续用于打开。 */
export function pendingResourceDisplayName(name: string, language: 'zh-CN' | 'en-US', kind?: string): string {
  return isPendingResourceText(name, kind) ? (language === 'zh-CN' ? '文本内容' : 'Text document') : name;
}
