import { createHash, randomUUID } from 'node:crypto';
import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, executionHostStopActiveCommandType, executionHostStopActiveScopeId, type ExecutionHostStopActiveCommandRequest, type ExecutionHostStopActiveInput } from '@zeus/shared';

/**
 * Main 是用户退出意图的唯一命令身份创建者。调用方必须复用返回对象完成 control/Core 网络重试，
 * 不得在 retry 分支再次调用本函数。
 */
export function createExecutionHostStopActiveCommandRequest(
  options: {
    reason?: ExecutionHostStopActiveInput['reason'];
    now?: () => Date;
    createId?: () => string;
  } = {},
): ExecutionHostStopActiveCommandRequest {
  const reason = options.reason ?? 'user_stop_active_and_quit';
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const input: ExecutionHostStopActiveInput = { reason };
  const operationIdentity = `execution-host-stop-active:${createId()}`;
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_execution_host_stop_active_${createId()}`,
      commandType: executionHostStopActiveCommandType,
      actor: reason === 'user_stop_active_and_quit' ? { kind: 'user', id: 'local-desktop-user' } : { kind: 'system', id: null },
      scope: { kind: 'execution_host', id: executionHostStopActiveScopeId },
      expectedRevision: null,
      idempotencyKey: operationIdentity,
      issuedAt: now().toISOString(),
      payload: {
        operationIdentity,
        inputSha256: createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex'),
      },
    },
    input,
  };
}
