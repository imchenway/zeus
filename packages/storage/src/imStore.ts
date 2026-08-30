import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ImAgentPresetRef, ImConnectionState } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';

export const imSchemaMigrationId = '20260829_0001_im_connections_v1';

export interface ImConnectionRecord {
  id: string;
  channelId: 'telegram';
  projectId: string;
  agentPreset: ImAgentPresetRef;
  remoteApprovalEnabled: boolean;
  state: ImConnectionState;
  botId: string;
  botUsername: string;
  botDisplayName: string;
  tokenValidatedAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessfulPollAt: string | null;
  lastError: string | null;
  pollingOffset: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImTrustedEndpointRecord {
  id: string;
  connectionId: string;
  providerUserId: string;
  providerChatId: string;
  displayName: string | null;
  pairedAt: string;
  revokedAt: string | null;
}

export interface ImPairingSessionRecord {
  id: string;
  connectionId: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface ImChatBindingRecord {
  id: string;
  connectionId: string;
  endpointId: string;
  conversationId: string;
  taskId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImActionCapabilityRecord {
  id: string;
  connectionId: string;
  endpointId: string;
  tokenHash: string;
  actionKind: string;
  targetKind: string;
  targetId: string;
  expectedRevision: number | null;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface ImConnectionLogRecord {
  id: string;
  connectionId: string;
  level: 'info' | 'warning' | 'error';
  event: string;
  message: string;
  occurredAt: string;
}

interface ImConnectionRow {
  id: string;
  channel_id: string;
  project_id: string;
  agent_preset_kind: string;
  agent_preset_id: string | null;
  remote_approval_enabled: number;
  state: ImConnectionState;
  bot_id: string;
  bot_username: string;
  bot_display_name: string;
  token_validated_at: string | null;
  last_checked_at: string | null;
  last_successful_poll_at: string | null;
  last_error: string | null;
  polling_offset: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ImTrustedEndpointRow {
  id: string;
  connection_id: string;
  provider_user_id: string;
  provider_chat_id: string;
  display_name: string | null;
  paired_at: string;
  revoked_at: string | null;
}

interface ImPairingSessionRow {
  id: string;
  connection_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

interface ImChatBindingRow {
  id: string;
  connection_id: string;
  endpoint_id: string;
  conversation_id: string;
  task_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ImActionCapabilityRow {
  id: string;
  connection_id: string;
  endpoint_id: string;
  token_hash: string;
  action_kind: string;
  target_kind: string;
  target_id: string;
  expected_revision: number | null;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

interface ImConnectionLogRow {
  id: string;
  connection_id: string;
  level: 'info' | 'warning' | 'error';
  event: string;
  message: string;
  occurred_at: string;
}

export function migrateImSchema(db: ZeusDatabasePort): void {
  const checksumSource = ['im_connections:v1', 'im_trusted_endpoints:v1', 'im_pairing_sessions:v1', 'im_chat_bindings:v1', 'im_inbound_receipts:v1', 'im_delivery_cursors:v1', 'im_action_capabilities:v1', 'im_connection_logs:v1'].join(';');
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [imSchemaMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('IM 连接迁移账本与当前结构定义不一致。');
    db.execute(`
      CREATE TABLE IF NOT EXISTS im_connections (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        agent_preset_kind TEXT NOT NULL,
        agent_preset_id TEXT,
        remote_approval_enabled INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_username TEXT NOT NULL,
        bot_display_name TEXT NOT NULL,
        token_validated_at TEXT,
        last_checked_at TEXT,
        last_successful_poll_at TEXT,
        last_error TEXT,
        polling_offset INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT
      )
    `);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_connections_active_channel ON im_connections(channel_id) WHERE removed_at IS NULL`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_im_connections_project ON im_connections(project_id, removed_at)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS im_trusted_endpoints (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        provider_chat_id TEXT NOT NULL,
        display_name TEXT,
        paired_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY(connection_id) REFERENCES im_connections(id)
      )
    `);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_endpoint_active_connection ON im_trusted_endpoints(connection_id) WHERE revoked_at IS NULL`);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_endpoint_identity ON im_trusted_endpoints(connection_id, provider_user_id, provider_chat_id) WHERE revoked_at IS NULL`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS im_pairing_sessions (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(connection_id) REFERENCES im_connections(id)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_im_pairing_connection ON im_pairing_sessions(connection_id, created_at DESC)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS im_chat_bindings (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        task_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(connection_id) REFERENCES im_connections(id),
        FOREIGN KEY(endpoint_id) REFERENCES im_trusted_endpoints(id)
      )
    `);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_chat_binding_active ON im_chat_bindings(connection_id, endpoint_id)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_im_chat_binding_conversation ON im_chat_bindings(conversation_id)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS im_inbound_receipts (
        connection_id TEXT NOT NULL,
        update_id TEXT NOT NULL,
        operation_identity TEXT NOT NULL,
        state TEXT NOT NULL,
        error_code TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        PRIMARY KEY(connection_id, update_id),
        FOREIGN KEY(connection_id) REFERENCES im_connections(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS im_delivery_cursors (
        connection_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connection_id, conversation_id),
        FOREIGN KEY(connection_id) REFERENCES im_connections(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS im_action_capabilities (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        action_kind TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        expected_revision INTEGER,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(connection_id) REFERENCES im_connections(id),
        FOREIGN KEY(endpoint_id) REFERENCES im_trusted_endpoints(id)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_im_action_connection ON im_action_capabilities(connection_id, created_at DESC)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS im_connection_logs (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        message TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY(connection_id) REFERENCES im_connections(id)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_im_connection_logs_recent ON im_connection_logs(connection_id, occurred_at DESC)`);
    if (!existing) {
      db.execute(`INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
        imSchemaMigrationId,
        '新增 IM 连接、可信端点、配对、会话绑定、入站回执、同步游标、动作能力与诊断日志',
        checksum,
        new Date().toISOString(),
      ]);
    }
  });
}

export class ImRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  listConnections(): ImConnectionRecord[] {
    return this.db.select<ImConnectionRow>(`${selectConnectionFields} WHERE removed_at IS NULL ORDER BY created_at ASC`).map(mapConnection);
  }

  getConnection(id: string): ImConnectionRecord | undefined {
    const row = this.db.get<ImConnectionRow>(`${selectConnectionFields} WHERE id = ? AND removed_at IS NULL`, [id]);
    return row ? mapConnection(row) : undefined;
  }

  getConnectionByChannel(channelId: 'telegram'): ImConnectionRecord | undefined {
    const row = this.db.get<ImConnectionRow>(`${selectConnectionFields} WHERE channel_id = ? AND removed_at IS NULL`, [channelId]);
    return row ? mapConnection(row) : undefined;
  }

  createConnection(input: { id?: string; projectId: string; agentPreset: ImAgentPresetRef; botId: string; botUsername: string; botDisplayName: string; now: string }): ImConnectionRecord {
    const id = input.id ?? `im_connection_${nanoid(16)}`;
    this.db.execute(
      `INSERT INTO im_connections (id, channel_id, project_id, agent_preset_kind, agent_preset_id, state, bot_id, bot_username, bot_display_name, token_validated_at, last_checked_at, created_at, updated_at)
       VALUES (?, 'telegram', ?, ?, ?, 'pending_pairing', ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.projectId, input.agentPreset.kind, input.agentPreset.digitalEmployeeId, input.botId, input.botUsername, input.botDisplayName, input.now, input.now, input.now, input.now],
    );
    return this.getConnection(id)!;
  }

  updateConnectionConfig(id: string, input: { agentPreset?: ImAgentPresetRef; remoteApprovalEnabled?: boolean; expectedRevision: number; now: string }): ImConnectionRecord | null {
    const current = this.getConnection(id);
    if (!current || current.revision !== input.expectedRevision) return null;
    const preset = input.agentPreset ?? current.agentPreset;
    const approval = input.remoteApprovalEnabled ?? current.remoteApprovalEnabled;
    this.db.execute(
      `UPDATE im_connections
       SET agent_preset_kind = ?,
           agent_preset_id = ?,
           remote_approval_enabled = ?,
           state = CASE
             WHEN ? = 1 THEN CASE WHEN EXISTS (SELECT 1 FROM im_trusted_endpoints WHERE connection_id = im_connections.id AND revoked_at IS NULL) THEN 'active' ELSE 'pending_pairing' END
             ELSE state
           END,
           last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END,
           revision = revision + 1,
           updated_at = ?
       WHERE id = ? AND revision = ? AND removed_at IS NULL`,
      [preset.kind, preset.digitalEmployeeId, approval ? 1 : 0, input.agentPreset ? 1 : 0, input.agentPreset ? 1 : 0, input.now, id, input.expectedRevision],
    );
    return (this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) === 1 ? this.getConnection(id)! : null;
  }

  markChecked(id: string, input: { now: string; botId?: string; botUsername?: string; botDisplayName?: string; error?: string | null }): ImConnectionRecord {
    const current = this.getConnection(id);
    if (!current) throw new Error(`IM connection not found: ${id}`);
    const validated = input.error ? current.tokenValidatedAt : input.now;
    this.db.execute(`UPDATE im_connections SET bot_id = ?, bot_username = ?, bot_display_name = ?, token_validated_at = ?, last_checked_at = ?, last_error = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND removed_at IS NULL`, [
      input.botId ?? current.botId,
      input.botUsername ?? current.botUsername,
      input.botDisplayName ?? current.botDisplayName,
      validated,
      input.now,
      input.error ?? null,
      input.now,
      id,
    ]);
    return this.getConnection(id)!;
  }

  recordPoll(id: string, input: { offset: number; now: string; error?: string | null }): ImConnectionRecord {
    this.db.execute(`UPDATE im_connections SET polling_offset = ?, last_successful_poll_at = CASE WHEN ? IS NULL THEN ? ELSE last_successful_poll_at END, last_error = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL`, [
      input.offset,
      input.error ?? null,
      input.now,
      input.error ?? null,
      input.now,
      id,
    ]);
    const connection = this.getConnection(id);
    if (!connection) throw new Error(`IM connection not found: ${id}`);
    return connection;
  }

  markPresetUnavailable(id: string, now: string): void {
    this.db.execute(`UPDATE im_connections SET state = 'reconfiguration_required', last_error = 'Agent Preset 已停用或删除，请在桌面端重新选择。', revision = revision + 1, updated_at = ? WHERE id = ? AND removed_at IS NULL`, [now, id]);
  }

  removeConnection(id: string, now: string): void {
    this.db.transaction(() => {
      this.db.execute(`UPDATE im_trusted_endpoints SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL`, [now, id]);
      this.db.execute(`UPDATE im_pairing_sessions SET consumed_at = COALESCE(consumed_at, ?) WHERE connection_id = ?`, [now, id]);
      this.db.execute(`UPDATE im_connections SET state = 'disabled', removed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND removed_at IS NULL`, [now, now, id]);
    });
  }

  beginRepair(connectionId: string, now: string): void {
    this.db.transaction(() => {
      const endpoints = this.db.select<{ id: string }>(`SELECT id FROM im_trusted_endpoints WHERE connection_id = ? AND revoked_at IS NULL`, [connectionId]);
      this.db.execute(`UPDATE im_trusted_endpoints SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL`, [now, connectionId]);
      for (const endpoint of endpoints) {
        this.db.execute(`UPDATE im_action_capabilities SET consumed_at = COALESCE(consumed_at, ?) WHERE connection_id = ? AND endpoint_id = ?`, [now, connectionId, endpoint.id]);
      }
      this.db.execute(`UPDATE im_connections SET state = 'pending_pairing', last_error = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND removed_at IS NULL`, [now, connectionId]);
    });
  }

  createPairingSession(input: { connectionId: string; tokenHash: string; expiresAt: string; now: string }): ImPairingSessionRecord {
    const id = `im_pairing_${nanoid(16)}`;
    this.db.transaction(() => {
      this.db.execute(`UPDATE im_pairing_sessions SET consumed_at = COALESCE(consumed_at, ?) WHERE connection_id = ? AND consumed_at IS NULL`, [input.now, input.connectionId]);
      this.db.execute(`INSERT INTO im_pairing_sessions (id, connection_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`, [id, input.connectionId, input.tokenHash, input.expiresAt, input.now]);
    });
    return this.getPairingSession(id)!;
  }

  getPairingSession(id: string): ImPairingSessionRecord | undefined {
    const row = this.db.get<ImPairingSessionRow>(`SELECT id, connection_id, token_hash, expires_at, consumed_at, created_at FROM im_pairing_sessions WHERE id = ?`, [id]);
    return row ? mapPairing(row) : undefined;
  }

  getLatestPairing(connectionId: string): ImPairingSessionRecord | undefined {
    const row = this.db.get<ImPairingSessionRow>(`SELECT id, connection_id, token_hash, expires_at, consumed_at, created_at FROM im_pairing_sessions WHERE connection_id = ? ORDER BY created_at DESC LIMIT 1`, [connectionId]);
    return row ? mapPairing(row) : undefined;
  }

  consumePairing(input: { tokenHash: string; providerUserId: string; providerChatId: string; displayName?: string | null; now: string }): { connection: ImConnectionRecord; endpoint: ImTrustedEndpointRecord } | null {
    return this.db.transaction(() => {
      const pairingRow = this.db.get<ImPairingSessionRow>(`SELECT id, connection_id, token_hash, expires_at, consumed_at, created_at FROM im_pairing_sessions WHERE token_hash = ?`, [input.tokenHash]);
      if (!pairingRow || pairingRow.consumed_at || Date.parse(pairingRow.expires_at) <= Date.parse(input.now)) return null;
      const existingEndpoint = this.getTrustedEndpoint(pairingRow.connection_id);
      if (existingEndpoint) return null;
      this.db.execute(`UPDATE im_pairing_sessions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`, [input.now, pairingRow.id]);
      if ((this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) !== 1) return null;
      const endpointId = `im_endpoint_${nanoid(16)}`;
      this.db.execute(`INSERT INTO im_trusted_endpoints (id, connection_id, provider_user_id, provider_chat_id, display_name, paired_at) VALUES (?, ?, ?, ?, ?, ?)`, [
        endpointId,
        pairingRow.connection_id,
        input.providerUserId,
        input.providerChatId,
        input.displayName ?? null,
        input.now,
      ]);
      this.db.execute(`UPDATE im_connections SET state = 'active', last_error = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND removed_at IS NULL`, [input.now, pairingRow.connection_id]);
      return { connection: this.getConnection(pairingRow.connection_id)!, endpoint: this.getTrustedEndpoint(pairingRow.connection_id)! };
    });
  }

  getTrustedEndpoint(connectionId: string): ImTrustedEndpointRecord | undefined {
    const row = this.db.get<ImTrustedEndpointRow>(`SELECT id, connection_id, provider_user_id, provider_chat_id, display_name, paired_at, revoked_at FROM im_trusted_endpoints WHERE connection_id = ? AND revoked_at IS NULL`, [connectionId]);
    return row ? mapEndpoint(row) : undefined;
  }

  getBinding(connectionId: string, endpointId: string): ImChatBindingRecord | undefined {
    const row = this.db.get<ImChatBindingRow>(`SELECT id, connection_id, endpoint_id, conversation_id, task_id, revision, created_at, updated_at FROM im_chat_bindings WHERE connection_id = ? AND endpoint_id = ?`, [
      connectionId,
      endpointId,
    ]);
    return row ? mapBinding(row) : undefined;
  }

  setBinding(input: { connectionId: string; endpointId: string; conversationId: string; taskId?: string | null; now: string }): ImChatBindingRecord {
    const existing = this.getBinding(input.connectionId, input.endpointId);
    if (!existing) {
      const id = `im_binding_${nanoid(16)}`;
      this.db.execute(`INSERT INTO im_chat_bindings (id, connection_id, endpoint_id, conversation_id, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.connectionId,
        input.endpointId,
        input.conversationId,
        input.taskId ?? null,
        input.now,
        input.now,
      ]);
      return this.getBinding(input.connectionId, input.endpointId)!;
    }
    this.db.execute(`UPDATE im_chat_bindings SET conversation_id = ?, task_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?`, [input.conversationId, input.taskId ?? null, input.now, existing.id]);
    return this.getBinding(input.connectionId, input.endpointId)!;
  }

  clearBinding(connectionId: string, endpointId: string): void {
    this.db.execute(`DELETE FROM im_chat_bindings WHERE connection_id = ? AND endpoint_id = ?`, [connectionId, endpointId]);
  }

  reserveInbound(input: { connectionId: string; updateId: string; operationIdentity: string; now: string }): boolean {
    this.db.execute(`INSERT OR IGNORE INTO im_inbound_receipts (connection_id, update_id, operation_identity, state, received_at) VALUES (?, ?, ?, 'received', ?)`, [input.connectionId, input.updateId, input.operationIdentity, input.now]);
    if ((this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) === 1) return true;
    const existing = this.db.get<{ operation_identity: string; state: string }>(`SELECT operation_identity, state FROM im_inbound_receipts WHERE connection_id = ? AND update_id = ?`, [input.connectionId, input.updateId]);
    // polling 对 update 串行投递；崩溃后保留在 received 的 update 允许用同一稳定身份恢复。
    return existing?.state === 'received' && existing.operation_identity === input.operationIdentity;
  }

  completeInbound(input: { connectionId: string; updateId: string; now: string; errorCode?: string | null }): void {
    this.db.execute(`UPDATE im_inbound_receipts SET state = ?, error_code = ?, processed_at = ? WHERE connection_id = ? AND update_id = ?`, [
      input.errorCode ? 'failed' : 'processed',
      input.errorCode ?? null,
      input.now,
      input.connectionId,
      input.updateId,
    ]);
  }

  getDeliveryCursor(connectionId: string, conversationId: string): number {
    return this.db.get<{ last_sequence: number }>(`SELECT last_sequence FROM im_delivery_cursors WHERE connection_id = ? AND conversation_id = ?`, [connectionId, conversationId])?.last_sequence ?? 0;
  }

  setDeliveryCursor(connectionId: string, conversationId: string, sequence: number, now: string): void {
    this.db.execute(
      `INSERT INTO im_delivery_cursors (connection_id, conversation_id, last_sequence, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(connection_id, conversation_id) DO UPDATE SET last_sequence = excluded.last_sequence, updated_at = excluded.updated_at WHERE excluded.last_sequence >= im_delivery_cursors.last_sequence`,
      [connectionId, conversationId, sequence, now],
    );
  }

  listDeliveryCursorIdentities(connectionId: string, identityPrefix: string): string[] {
    const escapedPrefix = identityPrefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    return this.db
      .select<{ conversation_id: string }>(
        `SELECT conversation_id FROM im_delivery_cursors
         WHERE connection_id = ? AND conversation_id LIKE ? ESCAPE '\\'
         ORDER BY conversation_id ASC`,
        [connectionId, `${escapedPrefix}%`],
      )
      .map((row) => row.conversation_id);
  }

  createActionCapability(input: Omit<ImActionCapabilityRecord, 'id' | 'consumedAt' | 'createdAt'> & { now: string }): ImActionCapabilityRecord {
    const id = `im_capability_${nanoid(16)}`;
    this.db.execute(`INSERT INTO im_action_capabilities (id, connection_id, endpoint_id, token_hash, action_kind, target_kind, target_id, expected_revision, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      input.connectionId,
      input.endpointId,
      input.tokenHash,
      input.actionKind,
      input.targetKind,
      input.targetId,
      input.expectedRevision,
      input.expiresAt,
      input.now,
    ]);
    return this.getActionCapabilityByHash(input.tokenHash)!;
  }

  consumeActionCapability(tokenHash: string, input: { connectionId: string; endpointId: string; now: string }): ImActionCapabilityRecord | null {
    return this.db.transaction(() => {
      const capability = this.getActionCapabilityByHash(tokenHash);
      if (!capability || capability.connectionId !== input.connectionId || capability.endpointId !== input.endpointId || capability.consumedAt || Date.parse(capability.expiresAt) <= Date.parse(input.now)) return null;
      this.db.execute(`UPDATE im_action_capabilities SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`, [input.now, capability.id]);
      return (this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) === 1 ? { ...capability, consumedAt: input.now } : null;
    });
  }

  hasLiveActionCapability(input: { connectionId: string; endpointId: string; targetKind: string; targetId: string; now: string }): boolean {
    return Boolean(
      this.db.get<{ id: string }>(
        `SELECT id FROM im_action_capabilities
         WHERE connection_id = ? AND endpoint_id = ? AND target_kind = ? AND target_id = ?
           AND consumed_at IS NULL AND expires_at > ?
         LIMIT 1`,
        [input.connectionId, input.endpointId, input.targetKind, input.targetId, input.now],
      ),
    );
  }

  findLiveActionCapability(input: { connectionId: string; endpointId: string; now: string; actionPrefix: string }): ImActionCapabilityRecord | undefined {
    const row = this.db.get<ImActionCapabilityRow>(
      `SELECT id, connection_id, endpoint_id, token_hash, action_kind, target_kind, target_id, expected_revision, expires_at, consumed_at, created_at
       FROM im_action_capabilities
       WHERE connection_id = ? AND endpoint_id = ? AND action_kind LIKE ? ESCAPE '\\'
         AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.connectionId, input.endpointId, `${input.actionPrefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`, input.now],
    );
    return row ? mapActionCapability(row) : undefined;
  }

  consumeCapabilitiesForTarget(input: { connectionId: string; endpointId: string; targetKind: string; targetId: string; now: string }): void {
    this.db.execute(
      `UPDATE im_action_capabilities SET consumed_at = ?
       WHERE connection_id = ? AND endpoint_id = ? AND target_kind = ? AND target_id = ? AND consumed_at IS NULL`,
      [input.now, input.connectionId, input.endpointId, input.targetKind, input.targetId],
    );
  }

  appendLog(input: { connectionId: string; level: ImConnectionLogRecord['level']; event: string; message: string; now: string }): void {
    this.db.execute(`INSERT INTO im_connection_logs (id, connection_id, level, event, message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      `im_log_${nanoid(16)}`,
      input.connectionId,
      input.level,
      input.event.slice(0, 96),
      input.message.slice(0, 2_048),
      input.now,
    ]);
    this.db.execute(`DELETE FROM im_connection_logs WHERE connection_id = ? AND id NOT IN (SELECT id FROM im_connection_logs WHERE connection_id = ? ORDER BY occurred_at DESC LIMIT 200)`, [input.connectionId, input.connectionId]);
  }

  listLogs(connectionId: string, limit = 100): ImConnectionLogRecord[] {
    return this.db
      .select<ImConnectionLogRow>(`SELECT id, connection_id, level, event, message, occurred_at FROM im_connection_logs WHERE connection_id = ? ORDER BY occurred_at DESC LIMIT ?`, [connectionId, Math.max(1, Math.min(200, limit))])
      .map((row) => ({ id: row.id, connectionId: row.connection_id, level: row.level, event: row.event, message: row.message, occurredAt: row.occurred_at }));
  }

  private getActionCapabilityByHash(tokenHash: string): ImActionCapabilityRecord | undefined {
    const row = this.db.get<ImActionCapabilityRow>(
      `SELECT id, connection_id, endpoint_id, token_hash, action_kind, target_kind, target_id, expected_revision, expires_at, consumed_at, created_at FROM im_action_capabilities WHERE token_hash = ?`,
      [tokenHash],
    );
    return row ? mapActionCapability(row) : undefined;
  }
}

const selectConnectionFields = `SELECT id, channel_id, project_id, agent_preset_kind, agent_preset_id, remote_approval_enabled, state, bot_id, bot_username, bot_display_name, token_validated_at, last_checked_at, last_successful_poll_at, last_error, polling_offset, revision, created_at, updated_at FROM im_connections`;

function mapConnection(row: ImConnectionRow): ImConnectionRecord {
  const agentPreset: ImAgentPresetRef = row.agent_preset_kind === 'digital_employee' && row.agent_preset_id ? { kind: 'digital_employee', digitalEmployeeId: row.agent_preset_id } : { kind: 'zeus_default', digitalEmployeeId: null };
  return {
    id: row.id,
    channelId: 'telegram',
    projectId: row.project_id,
    agentPreset,
    remoteApprovalEnabled: row.remote_approval_enabled === 1,
    state: row.state,
    botId: row.bot_id,
    botUsername: row.bot_username,
    botDisplayName: row.bot_display_name,
    tokenValidatedAt: row.token_validated_at,
    lastCheckedAt: row.last_checked_at,
    lastSuccessfulPollAt: row.last_successful_poll_at,
    lastError: row.last_error,
    pollingOffset: row.polling_offset,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEndpoint(row: ImTrustedEndpointRow): ImTrustedEndpointRecord {
  return { id: row.id, connectionId: row.connection_id, providerUserId: row.provider_user_id, providerChatId: row.provider_chat_id, displayName: row.display_name, pairedAt: row.paired_at, revokedAt: row.revoked_at };
}

function mapPairing(row: ImPairingSessionRow): ImPairingSessionRecord {
  return { id: row.id, connectionId: row.connection_id, tokenHash: row.token_hash, expiresAt: row.expires_at, consumedAt: row.consumed_at, createdAt: row.created_at };
}

function mapBinding(row: ImChatBindingRow): ImChatBindingRecord {
  return { id: row.id, connectionId: row.connection_id, endpointId: row.endpoint_id, conversationId: row.conversation_id, taskId: row.task_id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapActionCapability(row: ImActionCapabilityRow): ImActionCapabilityRecord {
  return {
    id: row.id,
    connectionId: row.connection_id,
    endpointId: row.endpoint_id,
    tokenHash: row.token_hash,
    actionKind: row.action_kind,
    targetKind: row.target_kind,
    targetId: row.target_id,
    expectedRevision: row.expected_revision,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}
