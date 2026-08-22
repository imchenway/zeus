import type { CodexRemoteControlPairing, CodexRemoteControlSnapshot } from './remoteControlContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildCodexPublicCommandRequest, codexPublicClientCommandTypes, codexPublicClientScopeIds } from '../codex/codexPublicCommandClient.js';

export interface RemoteControlApiClient {
  loadCodexRemoteControl: () => Promise<CodexRemoteControlSnapshot>;
  enableCodexRemoteControl: () => Promise<CodexRemoteControlSnapshot>;
  disableCodexRemoteControl: () => Promise<CodexRemoteControlSnapshot>;
  startCodexRemoteControlPairing: () => Promise<CodexRemoteControlPairing>;
  loadCodexRemoteControlPairingStatus: (input: { pairingCode?: string | null; manualPairingCode?: string | null }) => Promise<{ claimed: boolean }>;
  revokeCodexRemoteControlClient: (environmentId: string, clientId: string) => Promise<CodexRemoteControlSnapshot>;
}

export function createRemoteControlApiClient(transport: LocalApiTransport): RemoteControlApiClient {
  return {
    loadCodexRemoteControl: () => transport.request<CodexRemoteControlSnapshot>('/api/codex/remote-control'),
    enableCodexRemoteControl: async () =>
      transport.request<CodexRemoteControlSnapshot>(
        '/api/codex/remote-control/enable',
        jsonRequest(
          'POST',
          await buildCodexPublicCommandRequest({
            commandType: codexPublicClientCommandTypes.remoteControlEnable,
            scopeKind: 'provider_remote_control',
            scopeId: codexPublicClientScopeIds.remoteControl,
            operationPrefix: 'codex_remote_enable',
            value: {},
          }),
        ),
      ),
    disableCodexRemoteControl: async () =>
      transport.request<CodexRemoteControlSnapshot>(
        '/api/codex/remote-control/disable',
        jsonRequest(
          'POST',
          await buildCodexPublicCommandRequest({
            commandType: codexPublicClientCommandTypes.remoteControlDisable,
            scopeKind: 'provider_remote_control',
            scopeId: codexPublicClientScopeIds.remoteControl,
            operationPrefix: 'codex_remote_disable',
            value: {},
          }),
        ),
      ),
    startCodexRemoteControlPairing: async () =>
      transport.request<CodexRemoteControlPairing>(
        '/api/codex/remote-control/pairing',
        jsonRequest(
          'POST',
          await buildCodexPublicCommandRequest({
            commandType: codexPublicClientCommandTypes.remoteControlPairingStart,
            scopeKind: 'provider_remote_control',
            scopeId: codexPublicClientScopeIds.remoteControl,
            operationPrefix: 'codex_remote_pairing',
            value: {},
          }),
        ),
      ),
    loadCodexRemoteControlPairingStatus: (input) => transport.request<{ claimed: boolean }>('/api/codex/remote-control/pairing/status', jsonRequest('POST', input)),
    revokeCodexRemoteControlClient: async (environmentId, clientId) =>
      transport.request<CodexRemoteControlSnapshot>(
        `/api/codex/remote-control/clients/${encodeURIComponent(clientId)}?environmentId=${encodeURIComponent(environmentId)}`,
        jsonRequest(
          'DELETE',
          await buildCodexPublicCommandRequest({
            commandType: codexPublicClientCommandTypes.remoteControlClientRevoke,
            scopeKind: 'provider_remote_control',
            scopeId: codexPublicClientScopeIds.remoteControl,
            operationPrefix: 'codex_remote_client_revoke',
            value: { environmentId, clientId },
          }),
        ),
      ),
  };
}
