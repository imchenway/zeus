/** 产品功能的真实接入状态；未知允许尝试，明确缺失必须说明原因。 */
export interface ConversationFeatureAvailability {
  /** 接入、缺少配置、尚未探明或接口明确不支持。 */
  state: 'available' | 'needs_configuration' | 'unknown' | 'unsupported';
  /** 面向用户的具体依据。 */
  reason: string;
}

/** 与模型品牌无关的会话功能目录。 */
export type ConversationFeatureCatalog = Record<
  'skills' | 'imageInput' | 'imageGeneration' | 'questions' | 'plan' | 'processes' | 'steering' | 'goals' | 'subagents' | 'autoReview' | 'mcp' | 'search' | 'browser',
  ConversationFeatureAvailability
>;
