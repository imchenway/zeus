import type { CommandDefinition, CommandDefinitionInput, CommandRun } from '@zeus/shared';
import type { CommandConfirmationResponse, CommandRunDetail, CommandRunTerminalOutput, CreateCommandConfirmationRequest, LoadCommandRunOptions, StartCommandRunRequest } from '../runtime/runtimeContracts.js';
import { buildCommandCenterCommandRequest, commandCenterClientCommandTypes } from './commandCenterCommandClient.js';
import type { LocalApiTransport } from '../../transport/localApiTransport.js';

export interface CommandCenterApiClient {
  loadGlobalCommands: () => Promise<CommandDefinition[]>;
  createGlobalCommand: (input: CommandDefinitionInput) => Promise<CommandDefinition>;
  updateGlobalCommand: (commandId: string, input: Partial<CommandDefinitionInput>, expectedRevision: number) => Promise<CommandDefinition>;
  deleteGlobalCommand: (commandId: string, expectedRevision: number) => Promise<CommandDefinition>;
  loadProjectCommands: (projectId: string) => Promise<CommandDefinition[]>;
  createProjectCommand: (projectId: string, input: CommandDefinitionInput) => Promise<CommandDefinition>;
  updateProjectCommand: (projectId: string, commandId: string, input: Partial<CommandDefinitionInput>, expectedRevision: number) => Promise<CommandDefinition>;
  deleteProjectCommand: (projectId: string, commandId: string, expectedRevision: number) => Promise<CommandDefinition>;
  createCommandConfirmation: (projectId: string, commandId: string, input: CreateCommandConfirmationRequest) => Promise<CommandConfirmationResponse>;
  startCommandRun: (projectId: string, commandId: string, input: StartCommandRunRequest) => Promise<CommandRun>;
  loadCommandRuns: (projectId: string, limit?: number) => Promise<CommandRun[]>;
  loadCommandRun: (runId: string, options?: LoadCommandRunOptions) => Promise<CommandRunDetail>;
  loadCommandRunTerminalOutput: (runId: string) => Promise<CommandRunTerminalOutput>;
  stopCommandRun: (runId: string) => Promise<CommandRun>;
  loadCommandArtifact: (artifactId: string) => Promise<Blob>;
}

export function createCommandCenterApiClient(transport: LocalApiTransport): CommandCenterApiClient {
  return {
    loadGlobalCommands: () => transport.request<CommandDefinition[]>('/api/commands/global'),
    createGlobalCommand: async (input) => {
      const body = await buildCommandCenterCommandRequest({
        commandType: commandCenterClientCommandTypes.definitionCreate,
        scopeKind: 'command_definition',
        scopeId: (operationIdentity) => `global:${operationIdentity}`,
        expectedRevision: null,
        operationPrefix: 'command_definition',
        value: input,
      });
      return transport.request<CommandDefinition>('/api/commands/global', { method: 'POST', body: JSON.stringify(body) });
    },
    updateGlobalCommand: async (commandId, input, expectedRevision) => {
      const body = await buildCommandCenterCommandRequest({
        commandType: commandCenterClientCommandTypes.definitionUpdate,
        scopeKind: 'command_definition',
        scopeId: () => commandId,
        expectedRevision,
        operationPrefix: 'command_definition_update',
        value: input,
      });
      return transport.request<CommandDefinition>(`/api/commands/global/${encodeURIComponent(commandId)}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    deleteGlobalCommand: async (commandId, expectedRevision) => {
      const body = await buildCommandCenterCommandRequest({
        commandType: commandCenterClientCommandTypes.definitionDelete,
        scopeKind: 'command_definition',
        scopeId: () => commandId,
        expectedRevision,
        operationPrefix: 'command_definition_delete',
        value: {},
      });
      return transport.request<CommandDefinition>(`/api/commands/global/${encodeURIComponent(commandId)}`, { method: 'DELETE', body: JSON.stringify(body) });
    },
    loadProjectCommands: (projectId) => transport.request<CommandDefinition[]>(`/api/projects/${encodeURIComponent(projectId)}/commands`),
    createProjectCommand: async (projectId, input) => {
      const body = await buildCommandCenterCommandRequest({
        commandType: commandCenterClientCommandTypes.definitionCreate,
        scopeKind: 'command_definition',
        scopeId: (operationIdentity) => `project:${projectId}:${operationIdentity}`,
        expectedRevision: null,
        operationPrefix: 'command_definition',
        value: input,
      });
      return transport.request<CommandDefinition>(`/api/projects/${encodeURIComponent(projectId)}/commands`, { method: 'POST', body: JSON.stringify(body) });
    },
    updateProjectCommand: async (projectId, commandId, input, expectedRevision) => {
      const body = await buildCommandCenterCommandRequest({
        commandType: commandCenterClientCommandTypes.definitionUpdate,
        scopeKind: 'command_definition',
        scopeId: () => commandId,
        expectedRevision,
        operationPrefix: 'command_definition_update',
        value: input,
      });
      return transport.request<CommandDefinition>(`/api/projects/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    deleteProjectCommand: async (projectId, commandId, expectedRevision) => {
      const body = await buildCommandCenterCommandRequest({
        commandType: commandCenterClientCommandTypes.definitionDelete,
        scopeKind: 'command_definition',
        scopeId: () => commandId,
        expectedRevision,
        operationPrefix: 'command_definition_delete',
        value: {},
      });
      return transport.request<CommandDefinition>(`/api/projects/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}`, { method: 'DELETE', body: JSON.stringify(body) });
    },
    createCommandConfirmation: async (projectId, commandId, input) => {
      const body = await buildCommandCenterCommandRequest({
        commandType: commandCenterClientCommandTypes.confirmationCreate,
        scopeKind: 'command_run',
        scopeId: (operationIdentity) => operationIdentity,
        expectedRevision: null,
        operationPrefix: 'command_run',
        value: input,
      });
      return transport.request<CommandConfirmationResponse>(`/api/projects/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}/confirmations`, { method: 'POST', body: JSON.stringify(body) });
    },
    startCommandRun: async (projectId, commandId, input) => {
      const body = await buildCommandCenterCommandRequest({
        commandType: commandCenterClientCommandTypes.runStart,
        scopeKind: 'command_run',
        scopeId: () => input.runId,
        expectedRevision: null,
        operationPrefix: 'command_run_start',
        value: input,
      });
      return transport.request<CommandRun>(`/api/projects/${encodeURIComponent(projectId)}/commands/${encodeURIComponent(commandId)}/runs`, { method: 'POST', body: JSON.stringify(body) });
    },
    loadCommandRuns: (projectId, limit = 100) => transport.request<CommandRun[]>(`/api/projects/${encodeURIComponent(projectId)}/command-runs?limit=${encodeURIComponent(String(limit))}`),
    loadCommandRun: (runId, options = {}) => {
      const params = new URLSearchParams();
      if (options.afterSeq !== undefined) params.set('afterSeq', String(options.afterSeq));
      if (options.logLimit !== undefined) params.set('logLimit', String(options.logLimit));
      if (options.tail !== undefined) params.set('tail', String(options.tail));
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return transport.request<CommandRunDetail>(`/api/command-runs/${encodeURIComponent(runId)}${query}`);
    },
    loadCommandRunTerminalOutput: (runId) => transport.request<CommandRunTerminalOutput>(`/api/command-runs/${encodeURIComponent(runId)}/terminal-output`),
    stopCommandRun: async (runId) => {
      const body = await buildCommandCenterCommandRequest({
        commandType: commandCenterClientCommandTypes.runStop,
        scopeKind: 'command_run',
        scopeId: () => runId,
        expectedRevision: null,
        operationPrefix: 'command_run_stop',
        value: {},
      });
      return transport.request<CommandRun>(`/api/command-runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', body: JSON.stringify(body) });
    },
    loadCommandArtifact: (artifactId) => transport.requestBlob(`/api/command-artifacts/${encodeURIComponent(artifactId)}/content`),
  };
}
