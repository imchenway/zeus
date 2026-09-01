import {type CommandEnvelope, type CommandScopeKind} from '@zeus/shared';
import {buildRendererCommandRequest, randomIdentity, type RendererCommandPayload} from '../../commandRequest.js';

export const commandCenterClientCommandTypes = {
  definitionCreate: 'command_center.definition.create',
  definitionUpdate: 'command_center.definition.update',
  definitionDelete: 'command_center.definition.delete',
  confirmationCreate: 'command_center.confirmation.create',
  runStart: 'command_center.run.start',
  runStop: 'command_center.run.stop',
} as const;

export type CommandCenterClientCommandType = (typeof commandCenterClientCommandTypes)[keyof typeof commandCenterClientCommandTypes];

/** 构造一次不可变请求体；Local transport 重连只能复用该序列化 Body，不能重新生成命令身份。 */
export async function buildCommandCenterCommandRequest<TInput extends object>(input: {
  commandType: CommandCenterClientCommandType;
  scopeKind: Extract<CommandScopeKind, 'command_definition' | 'command_run'>;
  scopeId(operationIdentity: string): string;
  expectedRevision: number | null;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<RendererCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
    return buildRendererCommandRequest({
        ...input,
        scopeId: input.scopeId(operationIdentity),
        operationIdentity,
        commandIdPrefix: 'command_command_center_',
        actorId: 'zeus-desktop-command-center',
    });
}
