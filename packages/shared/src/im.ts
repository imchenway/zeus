/** 首期渠道目录；只有 Telegram 具有可用适配器，其余条目仅用于统一入口展示。 */
export const imChannelIds = ['wechat', 'feishu', 'dingtalk', 'wecom', 'qq', 'slack', 'telegram', 'discord', 'whatsapp', 'ai_office'] as const;
export type ImChannelId = (typeof imChannelIds)[number];

export type ImChannelAvailability = 'available' | 'unsupported';
export type ImConnectionState = 'pending_pairing' | 'active' | 'reconfiguration_required' | 'disabled';
export type ImAgentPresetRef = { kind: 'zeus_default'; digitalEmployeeId: null } | { kind: 'digital_employee'; digitalEmployeeId: string };

export interface ImChannelSnapshot {
  id: ImChannelId;
  name: string;
  availability: ImChannelAvailability;
}

export interface ImTrustedEndpointSnapshot {
  id: string;
  providerUserIdMasked: string;
  providerChatIdMasked: string;
  displayName: string | null;
  pairedAt: string;
}

export interface ImConnectionHealth {
  online: boolean;
  tokenValidated: boolean;
  polling: boolean;
  lastCheckedAt: string | null;
  lastSuccessfulPollAt: string | null;
  lastError: string | null;
  reason: string;
}

export interface ImConnectionSnapshot {
  id: string;
  channelId: 'telegram';
  projectId: string;
  projectName: string;
  agentPreset: ImAgentPresetRef;
  agentPresetName: string;
  remoteApprovalEnabled: boolean;
  state: ImConnectionState;
  bot: { idMasked: string; username: string; displayName: string };
  trustedEndpoint: ImTrustedEndpointSnapshot | null;
  health: ImConnectionHealth;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImPairingSessionSnapshot {
  id: string;
  connectionId: string;
  deepLink: string;
  qrCodeDataUrl: string | null;
  expiresAt: string;
  remainingSeconds: number;
  consumed: boolean;
}

export interface ImPairingStatusSnapshot {
  connection: ImConnectionSnapshot;
  pairing: ImPairingSessionSnapshot | null;
}

export interface ImTelegramConnectionLogEntry {
  id: string;
  occurredAt: string;
  level: 'info' | 'warning' | 'error';
  event: string;
  message: string;
}

export interface ImSettingsSnapshot {
  channels: ImChannelSnapshot[];
  connections: ImConnectionSnapshot[];
  legacyTelegramTokenPending?: boolean;
}

export interface CreateTelegramImConnectionInput {
  projectId: string;
  agentPreset: ImAgentPresetRef;
  botToken?: string;
  useLegacyToken?: boolean;
}

export interface UpdateTelegramImConnectionInput {
  expectedRevision: number;
  agentPreset?: ImAgentPresetRef;
  remoteApprovalEnabled?: boolean;
}

export interface ImTelegramConnectionCreated {
  connection: ImConnectionSnapshot;
  pairing: ImPairingSessionSnapshot;
}

export const imAttachmentLimits = Object.freeze({
  maximumFileBytes: 20 * 1024 * 1024,
  maximumFilesPerIntent: 10,
  maximumIntentBytes: 100 * 1024 * 1024,
  mediaGroupQuietWindowMs: 1_500,
});
