/** 会话显示条目的持久位置；正文或状态更新不得改变这些字段。 */
export interface ConversationTranscriptPlacement {
  /** 产品会话内稳定的显示身份。 */
  entryId: string;
  /** 已接纳条目的统一位置；等待接纳的输入可以为空。 */
  order: number | null;
  /** 位置重建或重新编号的代次，不参与组件 key。 */
  orderEpoch: number;
  /** 位置或归属最后一次有效变化的修订。 */
  placementRevision: number;
  /** Zeus 本地轮次身份。 */
  turnId: string | null;
  /** 所属普通输入或隐藏轮次锚点。 */
  openingInputId: string | null;
  /** 所属持久展示阶段锚点。 */
  displayStageId: string | null;
}

/** 单个来源的内容修订；它不承担显示排序职责。 */
export interface ConversationTranscriptSourceStamp {
  /** 来源表或实体的稳定种类。 */
  domain: string;
  /** 运行分段等必要来源边界。 */
  scope: string;
  /** 来源记录原始身份。 */
  sourceId: string;
  /** 正文、思考、工具、资源等内容部分。 */
  facet: string;
  /** 该来源最后一次有效写入的修订。 */
  revision: number;
  /** 同一内容从活动记录转存确认历史时继承的修订。 */
  contentRevision: number;
}

/** 一次读取返回的显示位置及其来源修订。 */
export interface ConversationTranscriptEnvelope {
  /** 稳定显示位置。 */
  placement: ConversationTranscriptPlacement;
  /** 当前投影实际采用的来源。 */
  sources: ConversationTranscriptSourceStamp[];
}

/** 位置代次核对接口的有界请求。 */
export interface ConversationTranscriptPlacementRequest {
  /** 当前已加载的显示身份，服务端按原顺序去重。 */
  entryIds: string[];
  /** 客户端当前代次；不一致时仍返回服务端代次供原子接管。 */
  expectedOrderEpoch?: number;
}

/** 位置代次核对接口的有界响应。 */
export interface ConversationTranscriptPlacementBatch {
  /** 产品会话身份。 */
  conversationId: string;
  /** 本批全部位置所属的同一代次。 */
  orderEpoch: number;
  /** 本批读取时的索引修订。 */
  revision: number;
  /** 已覆盖的显示位置。 */
  placements: ConversationTranscriptPlacement[];
  /** 本批未找到或因预算未覆盖的身份；它们不表示删除。 */
  uncoveredEntryIds: string[];
  /** 只有明确业务删除才会出现的身份。 */
  removedEntryIds: string[];
}
