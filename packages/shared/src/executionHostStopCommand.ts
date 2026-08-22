import type { CommandEnvelope } from './commandEnvelope.js';

/** “停止活动工作并退出”面向本机唯一 Core，而不是某个易变 PID 或 runtime generation。 */
export const executionHostStopActiveCommandType = 'execution_host.stop_active';
export const executionHostStopActiveScopeId = 'local-core';

export interface ExecutionHostStopActiveInput extends Record<string, unknown> {
  reason: 'user_stop_active_and_quit' | 'embedded_owner_retirement';
}

export interface ExecutionHostStopActiveCommandPayload extends Record<string, unknown> {
  operationIdentity: string;
  inputSha256: string;
}

export interface ExecutionHostStopActiveCommandRequest {
  command: CommandEnvelope<ExecutionHostStopActiveCommandPayload>;
  input: ExecutionHostStopActiveInput;
}

export interface ExecutionHostStopActiveFailure {
  conversationId: string;
  providerTurnId: string;
  message: string;
}

/** Provider interrupt 只等待 RPC 接纳，不等待远端 turn 终态；本机事实提交后才返回。 */
export interface ExecutionHostStopActiveResult {
  requestedTurnCount: number;
  providerInterruptFailureCount: number;
  closedSubmissionCount: number;
  failedRequestCount: number;
  stoppedRuntimeCount: number;
  stoppedCommandRunCount: number;
  failedGoalPauseCount: number;
  failedTurns: ExecutionHostStopActiveFailure[];
  providerOutcomeUnconfirmed: true;
  requestedAt: string;
}

export interface ExecutionHostStopActiveCommandResponse {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: ExecutionHostStopActiveResult;
}
