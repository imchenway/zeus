export type ConversationEventDurabilityLevel = 'critical_fact' | 'coalescible_process' | 'ephemeral_ui';
export type ConversationEventFlowStage = 'provider' | 'sqlite' | 'websocket' | 'renderer';

export const conversationEventFlowBudgets = {
  provider: { maximumPendingBytes: 4 * 1024 * 1024, maximumCoalescingKeys: 256, maximumEventsPerKey: 2_048 },
  sqlite: { maximumPendingBytes: 4 * 1024 * 1024, maximumCoalescingKeys: 256, maximumEventBytes: 1024 * 1024 },
  websocket: { maximumBufferedBytes: 4 * 1024 * 1024, maximumReplayPageBytes: 4 * 1024 * 1024, maximumReplayEvents: 1_000 },
  renderer: { maximumPendingBytes: 8 * 1024 * 1024, maximumPendingEvents: 2_048, frameCoalesceMs: 16 },
} as const;

export interface ConversationEventFlowSnapshot {
  budgets: typeof conversationEventFlowBudgets;
  appendedByDurability: Record<ConversationEventDurabilityLevel, number>;
  coalescedProcessEvents: number;
  droppedEphemeralEvents: number;
  websocketSlowConsumerDisconnects: number;
  failClosedEvents: number;
  highWater: Record<ConversationEventFlowStage, { pendingBytes: number; pendingEvents: number }>;
}

/**
 * 会话事件耐久级别的精确单一来源。
 *
 * 新增字面量事件必须先登记；机器门禁会动态发现 Coordinator、publish/broadcast 与 durable
 * append 的事件类型。运行时遇到真正动态且尚未登记的 Provider 类型仍保守提升为 critical_fact，
 * 但不能再依赖前缀或 `.progress/.delta` 后缀把源码里的新事件静默降级。
 */
export const conversationEventTypeRegistry = {
  critical_fact: [
    'conversation.created',
    'conversation.thread.changed',
    'conversation.thread.archived',
    'conversation.thread.unarchived',
    'conversation.transport.changed',
    'conversation.turn.started',
    'conversation.turn.completed',
    'conversation.turn.change_set.changed',
    'conversation.request.created',
    'conversation.request.resolved',
    'conversation.request.snoozed',
    'conversation.submission.accepted',
    'conversation.submission.steering',
    'conversation.submission.steered',
    'conversation.queue.changed',
    'conversation.settings.changed',
    'conversation.provider.settings.updated',
    'conversation.provider.token_usage.updated',
    'conversation.goal.updated',
    'conversation.goal.cleared',
    'conversation.goal.pause_failed',
    'conversation.plan_implementation_request.changed',
    'conversation.attention.changed',
    'conversation.warning.changed',
    'conversation.item.started',
    'conversation.item.completed',
    'conversation.native.error',
    'conversation.native.recovery_failed',
    'conversation.native.queue_dispatch_failed',
    'conversation.native.steer_requeued',
    'conversation.native.ephemeral_interrupt_failed',
    'conversation.native.shutdown_interrupt_failed',
  ],
  coalescible_process: ['conversation.item.delta', 'conversation.item.updated', 'conversation.turn.plan.updated', 'conversation.tokenUsage.changed', 'conversation.rateLimits.changed', 'conversation.mcpStartup.changed'],
  // 当前产品没有把临时 UI 事件送进 Core；空集合本身也是受门禁保护的精确声明。
  ephemeral_ui: [],
} as const satisfies Readonly<Record<ConversationEventDurabilityLevel, readonly string[]>>;

export const conversationEventDurabilityRegistry: Readonly<Record<string, ConversationEventDurabilityLevel>> = Object.freeze(
  Object.fromEntries((Object.entries(conversationEventTypeRegistry) as Array<[ConversationEventDurabilityLevel, readonly string[]]>).flatMap(([level, types]) => types.map((type) => [type, level] as const))),
);

/**
 * 真正动态、未登记的 Provider 事件默认按关键事实处理，避免因版本漂移被丢弃。
 * 源码中的字面量事件由独立门禁要求精确登记，ephemeral 也不再通过前缀隐式放行。
 */
export function classifyConversationEventDurability(type: string): ConversationEventDurabilityLevel {
  return conversationEventDurabilityRegistry[type] ?? 'critical_fact';
}

/** 统一记录各级高水位与降级动作；计数只用于诊断，不参与业务事实判断。 */
export class ConversationEventFlowControl {
  private readonly appendedByDurability: Record<ConversationEventDurabilityLevel, number> = {
    critical_fact: 0,
    coalescible_process: 0,
    ephemeral_ui: 0,
  };
  private readonly highWater: ConversationEventFlowSnapshot['highWater'] = {
    provider: { pendingBytes: 0, pendingEvents: 0 },
    sqlite: { pendingBytes: 0, pendingEvents: 0 },
    websocket: { pendingBytes: 0, pendingEvents: 0 },
    renderer: { pendingBytes: 0, pendingEvents: 0 },
  };
  private coalescedProcessEvents = 0;
  private droppedEphemeralEvents = 0;
  private websocketSlowConsumerDisconnects = 0;
  private failClosedEvents = 0;

  observeAppend(level: ConversationEventDurabilityLevel): void {
    this.appendedByDurability[level] += 1;
  }

  observeHighWater(stage: ConversationEventFlowStage, pendingBytes: number, pendingEvents: number): void {
    const current = this.highWater[stage];
    current.pendingBytes = Math.max(current.pendingBytes, boundedNonNegativeInteger(pendingBytes));
    current.pendingEvents = Math.max(current.pendingEvents, boundedNonNegativeInteger(pendingEvents));
  }

  observeCoalescedProcessEvent(count = 1): void {
    this.coalescedProcessEvents += boundedNonNegativeInteger(count);
  }

  observeDroppedEphemeralEvent(count = 1): void {
    this.droppedEphemeralEvents += boundedNonNegativeInteger(count);
  }

  observeWebSocketSlowConsumerDisconnect(bufferedBytes: number): void {
    this.websocketSlowConsumerDisconnects += 1;
    this.observeHighWater('websocket', bufferedBytes, 1);
  }

  observeFailClosed(): void {
    this.failClosedEvents += 1;
  }

  snapshot(): ConversationEventFlowSnapshot {
    return {
      budgets: conversationEventFlowBudgets,
      appendedByDurability: { ...this.appendedByDurability },
      coalescedProcessEvents: this.coalescedProcessEvents,
      droppedEphemeralEvents: this.droppedEphemeralEvents,
      websocketSlowConsumerDisconnects: this.websocketSlowConsumerDisconnects,
      failClosedEvents: this.failClosedEvents,
      highWater: {
        provider: { ...this.highWater.provider },
        sqlite: { ...this.highWater.sqlite },
        websocket: { ...this.highWater.websocket },
        renderer: { ...this.highWater.renderer },
      },
    };
  }
}

function boundedNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}
