import type { UserFacingErrorCause } from './userFacingError.js';

/** 所有会话共用的输入建议偏好，与主会话模型选择分开保存。 */
export interface InputSuggestionSettings {
  /** 仅显式启用后才自动生成，避免升级后增加模型用量。 */
  enabled: boolean;
  /** Codex 或模型连接中的完整模型身份；未选择时不生成。 */
  modelRef: string | null;
  /** 空值自动选择模型支持的最低档位，显式选择仅用于输入建议和润色。 */
  effort?: string | null;
}

/** 专用模型选择器只需要稳定身份和可读名称。 */
export interface InputSuggestionModelOption {
  /** 沿用现有模型目录身份，不由显示名称推断供应商。 */
  id: string;
  /** 模型目录提供的供应商及模型名称。 */
  label: string;
  /** 仅提供模型目录确认支持的档位，不由界面推测。 */
  supportedReasoningEfforts?: string[];
}

/** 自动建议与用户主动润色共用一次有界生成，不提交对话消息。 */
export interface InputSuggestionRequest {
  /** 空白输入预测下一句，有草稿时只润色用户表达。 */
  mode: 'suggest' | 'polish';
  /** 用户点击可以再次请求；自动触发仍受每轮一次约束。 */
  trigger: 'automatic' | 'manual';
  /** 已建立会话时必须同时传入所属项目和会话。 */
  projectId?: string;
  /** 新会话润色无需先创建会话。 */
  conversationId?: string;
  /** 自动请求必须绑定刚完成的轮次；主动请求由服务端读取最新状态。 */
  completedTurnId?: string;
  /** 只有用户主动点击才发送尚未提交的草稿。 */
  draft?: string;
  /** 已显示的建议只作辅助，不能覆盖草稿中的明确意思。 */
  suggestion?: string;
}

/** 建议回执携带轮次和模型身份，供输入框丢弃过期结果。 */
export interface InputSuggestionResult {
  /** 生成所依据的权威已完成轮次。 */
  completedTurnId: string | null;
  /** 实际使用的专用模型；未生成时允许为空。 */
  modelRef: string | null;
  /** 空值表示没有合理建议或功能不可用，不属于输入正文。 */
  text: string | null;
  /** 无正文时明确区分未生成、正常空结果和故障。 */
  reason: 'disabled' | 'context_unavailable' | 'model_unavailable' | 'effort_unavailable' | 'no_suggestion' | 'no_change' | 'timed_out' | 'failed' | 'cancelled' | null;
  /** 失败时保留有界、脱敏的原因，复用应用统一错误详情入口。 */
  cause?: UserFacingErrorCause;
}

/** 未配置的新旧用户均保持关闭，不隐式选择付费模型。 */
export const defaultInputSuggestionSettings: InputSuggestionSettings = { enabled: false, modelRef: null, effort: null };

/** 在设置读取和写入边界核对类型；缺少有效模型时不能启用。 */
export function normalizeInputSuggestionSettings(value: unknown): InputSuggestionSettings {
  /** 不信任导入文件或 HTTP 请求中的字段类型。 */
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  /** 模型身份遵循现有目录字符串格式，并限制持久化长度。 */
  const modelRef = typeof record.modelRef === 'string' && record.modelRef.trim() && record.modelRef.length <= 512 ? record.modelRef.trim() : null;
  /** 档位由服务端结合实时模型能力校验，旧设置缺失时采用自动最低。 */
  const effort = typeof record.effort === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(record.effort) ? record.effort : null;
  return { enabled: record.enabled === true && modelRef !== null, modelRef, effort };
}
