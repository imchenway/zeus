import type { CommandEnvelope, CommandScopeKind } from './commandEnvelope.js';

export const conversationDispatchWireCommandTypes = {
  changeSetUndo: 'conversation.turn.change_set.undo',
  changeSetReapply: 'conversation.turn.change_set.reapply',
  messageSubmit: 'conversation.message.submit',
  queueUpdate: 'conversation.queue.update',
  queueRetry: 'conversation.queue.retry',
  queueReroute: 'conversation.queue.reroute',
  queueDelete: 'conversation.queue.delete',
  queueSendNow: 'conversation.queue.send_now',
  queueResume: 'conversation.queue.resume',
  queueRecover: 'conversation.queue.recover',
  queueReorder: 'conversation.queue.reorder',
  turnInterrupt: 'conversation.turn.interrupt',
  serverRequestRespond: 'conversation.server_request.respond',
  planImplementationRespond: 'conversation.plan_implementation.respond',
  requestSnooze: 'conversation.request.snooze',
} as const;

export type ConversationDispatchWireCommandType = (typeof conversationDispatchWireCommandTypes)[keyof typeof conversationDispatchWireCommandTypes];
export type ConversationDispatchWireScopeKind = Extract<CommandScopeKind, 'product_conversation' | 'submission' | 'turn' | 'approval'>;

export interface ConversationDispatchWirePayload extends Record<string, unknown> {
  operationIdentity: string;
  inputSha256: string;
}

export interface ConversationDispatchWireRequest<TInput extends object> {
  command: CommandEnvelope<ConversationDispatchWirePayload>;
  input: TInput;
}
