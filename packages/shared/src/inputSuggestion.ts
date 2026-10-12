/** 所有会话共用的输入建议偏好，与主会话模型选择分开保存。 */
export interface InputSuggestionSettings {
  /** 仅显式启用后才自动生成，避免升级后增加模型用量。 */
  enabled: boolean;
  /** Codex 或模型连接中的完整模型身份；未选择时不生成。 */
  modelRef: string | null;
}

/** 专用模型选择器只需要稳定身份和可读名称。 */
export interface InputSuggestionModelOption {
  /** 沿用现有模型目录身份，不由显示名称推断供应商。 */
  id: string;
  /** 模型目录提供的供应商及模型名称。 */
  label: string;
}

/** 建议回执携带轮次和模型身份，供输入框丢弃过期结果。 */
export interface InputSuggestionResult {
  /** 生成所依据的权威已完成轮次。 */
  completedTurnId: string;
  /** 实际使用的专用模型；未生成时允许为空。 */
  modelRef: string | null;
  /** 空值表示没有合理建议或功能不可用，不属于输入正文。 */
  text: string | null;
}

/** 未配置的新旧用户均保持关闭，不隐式选择付费模型。 */
export const defaultInputSuggestionSettings: InputSuggestionSettings = { enabled: false, modelRef: null };

/** 在设置读取和写入边界核对类型；缺少有效模型时不能启用。 */
export function normalizeInputSuggestionSettings(value: unknown): InputSuggestionSettings {
  /** 不信任导入文件或 HTTP 请求中的字段类型。 */
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  /** 模型身份遵循现有目录字符串格式，并限制持久化长度。 */
  const modelRef = typeof record.modelRef === 'string' && record.modelRef.trim() && record.modelRef.length <= 512 ? record.modelRef.trim() : null;
  return { enabled: record.enabled === true && modelRef !== null, modelRef };
}
