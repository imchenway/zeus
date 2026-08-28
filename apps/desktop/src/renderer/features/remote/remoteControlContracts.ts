export interface CodexRemoteControlClient {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  lastSeenAt: number | null;
}

export interface CodexRemoteControlSnapshot {
  enabled: boolean;
  status: {
    status: 'disabled' | 'connecting' | 'connected' | 'errored';
    serverName: string;
    installationId: string;
    environmentId: string | null;
  };
  clients: CodexRemoteControlClient[];
  managedStandalone?: {
    available: boolean;
    commandPath: string | null;
    installCommand: string;
  };
}

export interface CodexRemoteControlPairing {
  pairingCode: string;
  manualPairingCode: string | null;
  environmentId: string;
  expiresAt: number;
  claimed: boolean;
}
