import type { SecuritySecretsSnapshot } from '../integrations/integrationContracts.js';
export type {
  CreateTelegramImConnectionInput,
  ImAgentPresetRef,
  ImConnectionSnapshot,
  ImPairingSessionSnapshot,
  ImSettingsSnapshot,
  ImTelegramConnectionCreated,
  ImTelegramConnectionLogEntry,
  UpdateTelegramImConnectionInput,
} from '@zeus/shared';

import type { ImAgentPresetRef } from '@zeus/shared';

export interface ImProjectSelectionOption {
  id: string;
  name: string;
  presets: Array<{ ref: ImAgentPresetRef; name: string }>;
}

export interface TelegramPollingStatus {
  running: boolean;
  offset: number;
  lastError: string | null;
  handledUpdates: number;
  lastSuccessfulPollAt?: string | null;
}

export interface TelegramPollingLogEntry {
  updateId: number | null;
  chatId: number | null;
  userId: number | null;
  command: string;
  allowed: boolean;
  error?: string;
}

export interface TelegramNotificationSettings {
  enabled: boolean;
  chatIds: number[];
  silentMode: boolean;
}

export interface TelegramTestConnectionResult {
  ok: boolean;
  chatIds: number[];
  attempts: number;
  sentAt: string;
}

export interface TelegramStatusSnapshot {
  configured: boolean;
  reason: string;
  polling: TelegramPollingStatus;
  notificationSettings: TelegramNotificationSettings;
  securitySettings: TelegramSecuritySettings;
}

export interface TelegramSettingsSnapshot {
  notificationSettings: TelegramNotificationSettings;
  securitySettings: TelegramSecuritySettings;
}

export interface UpdateTelegramSettingsRequest {
  enabled?: boolean;
  chatIds?: number[];
  silentMode?: boolean;
  allowedUserIds?: number[];
}

export interface TelegramSecuritySettings {
  allowedUserIds: number[];
}

export interface TelegramDispatchPreviewInput {
  updateId: number;
  chatId: number;
  userId: number;
  text: string;
  messageId?: number;
  callbackQueryId?: string;
  callbackData?: string;
}

export interface TelegramDispatchPreviewResult {
  allowed: boolean;
  command?: { command: string; args: string[] };
  reason?: string;
  auditEvent: { updateId: number; chatId: number; userId: number; command: string; allowed: boolean };
}

export interface SecurityResetResult {
  secrets: SecuritySecretsSnapshot;
  telegramNotificationSettings: TelegramNotificationSettings;
  telegramSecuritySettings: TelegramSecuritySettings;
}
