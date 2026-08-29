import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ZeusDatabasePort } from './databasePort.js';

export const pluginStoreSchemaMigrationId = '20260829_0001_zeus_plugin_host';
export const pluginStoreSourceIdentityMigrationId = '20260829_0002_plugin_source_identity';

export const pluginScopes = ['personal', 'project'] as const;
export const pluginSourceKinds = ['local', 'git', 'marketplace'] as const;
export const pluginConnectionStates = ['ready', 'needs_connection', 'incompatible'] as const;
export const pluginApprovalModes = ['prompt', 'approve', 'deny'] as const;

export type PluginScope = (typeof pluginScopes)[number];
export type PluginSourceKind = (typeof pluginSourceKinds)[number];
export type PluginConnectionState = (typeof pluginConnectionStates)[number];
export type PluginApprovalMode = (typeof pluginApprovalModes)[number];

export interface PluginRegistrationRecord {
  id: string;
  name: string;
  displayName: string;
  description: string;
  scope: PluginScope;
  projectId: string | null;
  sourceKind: PluginSourceKind;
  sourceLocator: string;
  sourceRef: string | null;
  sourceSubdirectory: string | null;
  marketplaceId: string | null;
  activeRevisionId: string;
  enabled: boolean;
  connectionState: PluginConnectionState;
  connectionReason: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PluginRevisionRecord {
  id: string;
  pluginId: string;
  version: string;
  contentSha256: string;
  installPath: string;
  manifest: Record<string, unknown>;
  components: PluginComponentSnapshot;
  createdAt: string;
  retiredAt: string | null;
}

export interface PluginComponentSnapshot {
  skills: Array<{ id: string; name: string; description: string; path: string }>;
  hooks: Array<{ id: string; event: string; matcher: string | null; definitionSha256: string; definition: Record<string, unknown> }>;
  mcpServers: Array<{ id: string; name: string; transport: 'stdio' | 'http'; config: Record<string, unknown> }>;
  apps: Array<{ id: string; technicalId: string; name: string }>;
  assets: Array<{ kind: string; path: string }>;
  hasMcpAppUi: boolean;
}

export interface PluginMarketplaceRecord {
  id: string;
  name: string;
  scope: PluginScope;
  projectId: string | null;
  sourceKind: 'local' | 'git';
  sourceLocator: string;
  sourceRef: string | null;
  sourceSubdirectory: string | null;
  snapshotPath: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PluginHookTrustRecord {
  pluginRevisionId: string;
  hookId: string;
  definitionSha256: string;
  trustedDefinitionSha256: string | null;
  enabled: boolean;
  trustedAt: string | null;
  updatedAt: string;
}

export interface PluginConnectorBindingRecord {
  pluginId: string;
  connectorId: string;
  appTechnicalId: string;
  serverConfig: Record<string, unknown>;
  secretAccount: string | null;
  connected: boolean;
  updatedAt: string;
}

export interface PluginMcpPolicyRecord {
  pluginId: string;
  serverId: string;
  toolName: string;
  enabled: boolean;
  approvalMode: PluginApprovalMode;
  updatedAt: string;
}

export interface ConversationPluginActivationRecord {
  conversationId: string;
  pluginId: string;
  pluginRevisionId: string;
  snapshot: Record<string, unknown>;
  createdAt: string;
}

export interface RecordPluginInstallationInput {
  pluginId?: string;
  name: string;
  displayName: string;
  description: string;
  scope: PluginScope;
  projectId?: string | null;
  sourceKind: PluginSourceKind;
  sourceLocator: string;
  sourceRef?: string | null;
  sourceSubdirectory?: string | null;
  marketplaceId?: string | null;
  version: string;
  contentSha256: string;
  installPath: string;
  manifest: Record<string, unknown>;
  components: PluginComponentSnapshot;
  connectionState: PluginConnectionState;
  connectionReason?: string | null;
  enabled?: boolean;
  createdAt?: string;
}

export function migratePluginStoreSchema(db: ZeusDatabasePort): void {
  const checksumSource = [
    'plugin_registrations:v1',
    'plugin_revisions:v1',
    'plugin_marketplaces:v1',
    'plugin_hook_trust:v1',
    'plugin_connector_bindings:v1',
    'plugin_mcp_policies:v1',
    'conversation_plugin_activations:v1',
    'conversation_plugin_activation_sets:v1',
  ].join(';');
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [pluginStoreSchemaMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('Plugin Host 迁移账本与当前结构定义不一致。');
    db.execute(`
      CREATE TABLE IF NOT EXISTS plugin_registrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        scope TEXT NOT NULL,
        project_id TEXT,
        source_kind TEXT NOT NULL,
        source_locator TEXT NOT NULL,
        source_ref TEXT,
        source_subdirectory TEXT,
        marketplace_id TEXT,
        active_revision_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        connection_state TEXT NOT NULL,
        connection_reason TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_registrations_identity ON plugin_registrations(scope, COALESCE(project_id, ''), name) WHERE deleted_at IS NULL`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_plugin_registrations_active ON plugin_registrations(enabled, scope, project_id, name) WHERE deleted_at IS NULL`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS plugin_revisions (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        version TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        install_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        components_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT,
        FOREIGN KEY (plugin_id) REFERENCES plugin_registrations(id)
      )
    `);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_revisions_content ON plugin_revisions(plugin_id, content_sha256)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_plugin_revisions_active_path ON plugin_revisions(plugin_id, retired_at, created_at DESC)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS plugin_marketplaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        project_id TEXT,
        source_kind TEXT NOT NULL,
        source_locator TEXT NOT NULL,
        source_ref TEXT,
        source_subdirectory TEXT,
        snapshot_path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id)
      )
    `);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_marketplaces_identity ON plugin_marketplaces(scope, COALESCE(project_id, ''), name) WHERE deleted_at IS NULL`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS plugin_hook_trust (
        plugin_revision_id TEXT NOT NULL,
        hook_id TEXT NOT NULL,
        definition_sha256 TEXT NOT NULL,
        trusted_definition_sha256 TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        trusted_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin_revision_id, hook_id),
        FOREIGN KEY (plugin_revision_id) REFERENCES plugin_revisions(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS plugin_connector_bindings (
        plugin_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        app_technical_id TEXT NOT NULL,
        server_config_json TEXT NOT NULL,
        secret_account TEXT,
        connected INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, connector_id),
        FOREIGN KEY (plugin_id) REFERENCES plugin_registrations(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS plugin_mcp_policies (
        plugin_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        approval_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, server_id, tool_name),
        FOREIGN KEY (plugin_id) REFERENCES plugin_registrations(id)
      )
    `);
    db.execute(`
      CREATE TABLE IF NOT EXISTS conversation_plugin_activations (
        conversation_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        plugin_revision_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, plugin_id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id),
        FOREIGN KEY (plugin_id) REFERENCES plugin_registrations(id),
        FOREIGN KEY (plugin_revision_id) REFERENCES plugin_revisions(id)
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_plugin_activations_revision ON conversation_plugin_activations(plugin_revision_id)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS conversation_plugin_activation_sets (
        conversation_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);
    if (!existing) {
      db.execute(`INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
        pluginStoreSchemaMigrationId,
        '新增 Zeus-owned Plugin 注册、不可变修订、Hook 信任、Connector、MCP 策略与会话快照',
        checksum,
        new Date().toISOString(),
      ]);
    }
  });
  const sourceIdentityChecksum = `sha256:${createHash('sha256').update('plugin_registrations:source-identity:v1').digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [pluginStoreSourceIdentityMigrationId]);
    if (existing && existing.checksum !== sourceIdentityChecksum) throw new Error('Plugin 来源身份迁移账本与当前结构定义不一致。');
    db.execute(`DROP INDEX IF EXISTS idx_plugin_registrations_identity`);
    db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_registrations_source_identity
       ON plugin_registrations(
         scope,
         COALESCE(project_id, ''),
         name,
         source_kind,
         source_locator,
         COALESCE(source_ref, ''),
         COALESCE(source_subdirectory, ''),
         COALESCE(marketplace_id, '')
       )
       WHERE deleted_at IS NULL`,
    );
    if (!existing) {
      db.execute(`INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
        pluginStoreSourceIdentityMigrationId,
        '允许同一作用域内的同名 Plugin 按来源身份并存',
        sourceIdentityChecksum,
        new Date().toISOString(),
      ]);
    }
  });
}

export class PluginRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  list(input: { projectId?: string | null } = {}): PluginRegistrationRecord[] {
    const rows = input.projectId
      ? this.db.select<PluginRegistrationRow>(`SELECT * FROM plugin_registrations WHERE deleted_at IS NULL AND (scope = 'personal' OR (scope = 'project' AND project_id = ?)) ORDER BY scope ASC, name ASC`, [input.projectId])
      : this.db.select<PluginRegistrationRow>(`SELECT * FROM plugin_registrations WHERE deleted_at IS NULL AND scope = 'personal' ORDER BY name ASC`);
    return rows.map(mapRegistration);
  }

  listAll(): PluginRegistrationRecord[] {
    return this.db.select<PluginRegistrationRow>(`SELECT * FROM plugin_registrations WHERE deleted_at IS NULL ORDER BY scope ASC, project_id ASC, name ASC`).map(mapRegistration);
  }

  get(id: string): PluginRegistrationRecord | undefined {
    const row = this.db.get<PluginRegistrationRow>(`SELECT * FROM plugin_registrations WHERE id = ? AND deleted_at IS NULL`, [requiredIdentity(id, 'pluginId')]);
    return row ? mapRegistration(row) : undefined;
  }

  getRevision(id: string): PluginRevisionRecord | undefined {
    const row = this.db.get<PluginRevisionRow>(`SELECT * FROM plugin_revisions WHERE id = ?`, [requiredIdentity(id, 'pluginRevisionId')]);
    return row ? mapPluginRevision(row) : undefined;
  }

  listRevisions(pluginId: string): PluginRevisionRecord[] {
    return this.db.select<PluginRevisionRow>(`SELECT * FROM plugin_revisions WHERE plugin_id = ? ORDER BY created_at DESC`, [requiredIdentity(pluginId, 'pluginId')]).map(mapPluginRevision);
  }

  getActiveRevision(pluginId: string): PluginRevisionRecord | undefined {
    const plugin = this.get(pluginId);
    return plugin ? this.getRevision(plugin.activeRevisionId) : undefined;
  }

  findByScopedName(scope: PluginScope, projectId: string | null, name: string): PluginRegistrationRecord | undefined {
    const row = this.db.get<PluginRegistrationRow>(`SELECT * FROM plugin_registrations WHERE scope = ? AND COALESCE(project_id, '') = COALESCE(?, '') AND name = ? AND deleted_at IS NULL`, [scope, projectId, requiredPluginName(name)]);
    return row ? mapRegistration(row) : undefined;
  }

  recordInstallation(input: RecordPluginInstallationInput): { plugin: PluginRegistrationRecord; revision: PluginRevisionRecord } {
    const timestamp = input.createdAt ?? new Date().toISOString();
    const existing = input.pluginId ? this.get(input.pluginId) : undefined;
    const pluginId = existing?.id ?? `plugin_${nanoid(16)}`;
    const revisionId = `plugin_revision_${nanoid(16)}`;
    const previousHooks = existing ? this.listHooks(existing.activeRevisionId) : [];
    this.db.transaction(() => {
      if (existing) {
        this.db.execute(
          `UPDATE plugin_registrations SET display_name = ?, description = ?, source_kind = ?, source_locator = ?, source_ref = ?, source_subdirectory = ?, marketplace_id = ?, active_revision_id = ?, enabled = ?, connection_state = ?, connection_reason = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
          [
            boundedText(input.displayName, 'displayName', 1, 160),
            boundedText(input.description, 'description', 0, 4_000),
            oneOf(input.sourceKind, pluginSourceKinds, 'sourceKind'),
            boundedText(input.sourceLocator, 'sourceLocator', 1, 8_000),
            optionalText(input.sourceRef, 512),
            optionalText(input.sourceSubdirectory, 2_000),
            optionalText(input.marketplaceId, 240),
            revisionId,
            input.enabled === false ? 0 : 1,
            oneOf(input.connectionState, pluginConnectionStates, 'connectionState'),
            optionalText(input.connectionReason, 2_000),
            timestamp,
            existing.id,
          ],
        );
        this.db.execute(`UPDATE plugin_revisions SET retired_at = COALESCE(retired_at, ?) WHERE plugin_id = ? AND id <> ?`, [timestamp, existing.id, revisionId]);
      } else {
        this.db.execute(
          `INSERT INTO plugin_registrations
           (id, name, display_name, description, scope, project_id, source_kind, source_locator, source_ref, source_subdirectory, marketplace_id, active_revision_id, enabled, connection_state, connection_reason, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            pluginId,
            requiredPluginName(input.name),
            boundedText(input.displayName, 'displayName', 1, 160),
            boundedText(input.description, 'description', 0, 4_000),
            oneOf(input.scope, pluginScopes, 'scope'),
            input.scope === 'project' ? requiredIdentity(input.projectId, 'projectId') : null,
            oneOf(input.sourceKind, pluginSourceKinds, 'sourceKind'),
            boundedText(input.sourceLocator, 'sourceLocator', 1, 8_000),
            optionalText(input.sourceRef, 512),
            optionalText(input.sourceSubdirectory, 2_000),
            optionalText(input.marketplaceId, 240),
            revisionId,
            input.enabled === false ? 0 : 1,
            oneOf(input.connectionState, pluginConnectionStates, 'connectionState'),
            optionalText(input.connectionReason, 2_000),
            timestamp,
            timestamp,
          ],
        );
      }
      this.db.execute(`INSERT INTO plugin_revisions (id, plugin_id, version, content_sha256, install_path, manifest_json, components_json, created_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`, [
        revisionId,
        pluginId,
        boundedText(input.version, 'version', 1, 120),
        requiredSha256(input.contentSha256),
        boundedText(input.installPath, 'installPath', 1, 16_000),
        serializeRecord(input.manifest, 'manifest', 2_000_000),
        serializeRecord(input.components, 'components', 4_000_000),
        timestamp,
      ]);
      for (const hook of input.components.hooks) {
        const previous = previousHooks.find((candidate) => candidate.hookId === hook.id && candidate.definitionSha256 === hook.definitionSha256);
        this.db.execute(`INSERT INTO plugin_hook_trust (plugin_revision_id, hook_id, definition_sha256, trusted_definition_sha256, enabled, trusted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
          revisionId,
          hook.id,
          hook.definitionSha256,
          previous?.trustedDefinitionSha256 ?? null,
          previous?.enabled === false ? 0 : 1,
          previous?.trustedAt ?? null,
          timestamp,
        ]);
      }
    });
    return { plugin: this.get(pluginId)!, revision: this.getRevision(revisionId)! };
  }

  setEnabled(id: string, enabled: boolean, expectedRevision?: number): PluginRegistrationRecord {
    const existing = this.require(id);
    if (expectedRevision !== undefined && expectedRevision !== existing.revision) throw pluginStoreError('ZEUS_PLUGIN_REVISION_CONFLICT', 'Plugin 已被其他操作更新。');
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE plugin_registrations SET enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL`, [enabled ? 1 : 0, timestamp, id, existing.revision]);
    assertChanged(this.db, 'Plugin 已被其他操作更新。');
    return this.get(id)!;
  }

  setConnectionState(id: string, state: PluginConnectionState, reason: string | null): PluginRegistrationRecord {
    const existing = this.require(id);
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE plugin_registrations SET connection_state = ?, connection_reason = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL`, [
      oneOf(state, pluginConnectionStates, 'connectionState'),
      optionalText(reason, 2_000),
      timestamp,
      id,
      existing.revision,
    ]);
    assertChanged(this.db, 'Plugin 已被其他操作更新。');
    return this.get(id)!;
  }

  remove(id: string, expectedRevision?: number): PluginRegistrationRecord {
    const existing = this.require(id);
    if (expectedRevision !== undefined && expectedRevision !== existing.revision) throw pluginStoreError('ZEUS_PLUGIN_REVISION_CONFLICT', 'Plugin 已被其他操作更新。');
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE plugin_registrations SET enabled = 0, deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL`, [timestamp, timestamp, id, existing.revision]);
    assertChanged(this.db, 'Plugin 已被其他操作更新。');
    return existing;
  }

  listHooks(pluginRevisionId: string): PluginHookTrustRecord[] {
    return this.db.select<PluginHookTrustRow>(`SELECT * FROM plugin_hook_trust WHERE plugin_revision_id = ? ORDER BY hook_id ASC`, [pluginRevisionId]).map(mapHookTrust);
  }

  trustHook(pluginRevisionId: string, hookId: string, trusted: boolean): PluginHookTrustRecord {
    const existing = this.db.get<PluginHookTrustRow>(`SELECT * FROM plugin_hook_trust WHERE plugin_revision_id = ? AND hook_id = ?`, [pluginRevisionId, hookId]);
    if (!existing) throw pluginStoreError('ZEUS_PLUGIN_HOOK_NOT_FOUND', 'Plugin Hook 不存在。');
    const timestamp = new Date().toISOString();
    this.db.execute(`UPDATE plugin_hook_trust SET trusted_definition_sha256 = ?, trusted_at = ?, updated_at = ? WHERE plugin_revision_id = ? AND hook_id = ?`, [
      trusted ? existing.definition_sha256 : null,
      trusted ? timestamp : null,
      timestamp,
      pluginRevisionId,
      hookId,
    ]);
    return mapHookTrust(this.db.get<PluginHookTrustRow>(`SELECT * FROM plugin_hook_trust WHERE plugin_revision_id = ? AND hook_id = ?`, [pluginRevisionId, hookId])!);
  }

  setHookEnabled(pluginRevisionId: string, hookId: string, enabled: boolean): PluginHookTrustRecord {
    const existing = this.db.get<PluginHookTrustRow>(`SELECT * FROM plugin_hook_trust WHERE plugin_revision_id = ? AND hook_id = ?`, [pluginRevisionId, hookId]);
    if (!existing) throw pluginStoreError('ZEUS_PLUGIN_HOOK_NOT_FOUND', 'Plugin Hook 不存在。');
    const timestamp = new Date().toISOString();
    this.db.execute(`UPDATE plugin_hook_trust SET enabled = ?, updated_at = ? WHERE plugin_revision_id = ? AND hook_id = ?`, [enabled ? 1 : 0, timestamp, pluginRevisionId, hookId]);
    return mapHookTrust(this.db.get<PluginHookTrustRow>(`SELECT * FROM plugin_hook_trust WHERE plugin_revision_id = ? AND hook_id = ?`, [pluginRevisionId, hookId])!);
  }

  listMarketplaces(input: { projectId?: string | null } = {}): PluginMarketplaceRecord[] {
    const rows = input.projectId
      ? this.db.select<PluginMarketplaceRow>(`SELECT * FROM plugin_marketplaces WHERE deleted_at IS NULL AND (scope = 'personal' OR (scope = 'project' AND project_id = ?)) ORDER BY scope ASC, name ASC`, [input.projectId])
      : this.db.select<PluginMarketplaceRow>(`SELECT * FROM plugin_marketplaces WHERE deleted_at IS NULL AND scope = 'personal' ORDER BY name ASC`);
    return rows.map(mapMarketplace);
  }

  upsertMarketplace(input: Omit<PluginMarketplaceRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: string }): PluginMarketplaceRecord {
    const timestamp = input.createdAt ?? new Date().toISOString();
    const existing = input.id ? this.getMarketplace(input.id) : undefined;
    const id = existing?.id ?? `plugin_marketplace_${nanoid(14)}`;
    if (existing) {
      this.db.execute(
        `UPDATE plugin_marketplaces SET name = ?, scope = ?, project_id = ?, source_kind = ?, source_locator = ?, source_ref = ?, source_subdirectory = ?, snapshot_path = ?, enabled = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
        [
          input.name,
          input.scope,
          input.scope === 'project' ? requiredIdentity(input.projectId, 'projectId') : null,
          input.sourceKind,
          input.sourceLocator,
          input.sourceRef,
          input.sourceSubdirectory,
          input.snapshotPath,
          input.enabled ? 1 : 0,
          timestamp,
          id,
        ],
      );
    } else {
      this.db.execute(
        `INSERT INTO plugin_marketplaces (id, name, scope, project_id, source_kind, source_locator, source_ref, source_subdirectory, snapshot_path, enabled, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          id,
          boundedText(input.name, 'marketplace.name', 1, 160),
          oneOf(input.scope, pluginScopes, 'marketplace.scope'),
          input.scope === 'project' ? requiredIdentity(input.projectId, 'projectId') : null,
          input.sourceKind,
          input.sourceLocator,
          input.sourceRef,
          input.sourceSubdirectory,
          input.snapshotPath,
          input.enabled ? 1 : 0,
          timestamp,
          timestamp,
        ],
      );
    }
    return this.getMarketplace(id)!;
  }

  getMarketplace(id: string): PluginMarketplaceRecord | undefined {
    const row = this.db.get<PluginMarketplaceRow>(`SELECT * FROM plugin_marketplaces WHERE id = ? AND deleted_at IS NULL`, [requiredIdentity(id, 'marketplaceId')]);
    return row ? mapMarketplace(row) : undefined;
  }

  removeMarketplace(id: string): PluginMarketplaceRecord {
    const existing = this.getMarketplace(id);
    if (!existing) throw pluginStoreError('ZEUS_PLUGIN_MARKETPLACE_NOT_FOUND', 'Plugin Marketplace 不存在。');
    const timestamp = nextTimestamp(existing.updatedAt);
    this.db.execute(`UPDATE plugin_marketplaces SET enabled = 0, deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, [timestamp, timestamp, id]);
    return existing;
  }

  listConnectorBindings(pluginId: string): PluginConnectorBindingRecord[] {
    return this.db.select<PluginConnectorBindingRow>(`SELECT * FROM plugin_connector_bindings WHERE plugin_id = ? ORDER BY connector_id ASC`, [pluginId]).map(mapConnectorBinding);
  }

  upsertConnectorBinding(input: PluginConnectorBindingRecord): PluginConnectorBindingRecord {
    this.require(input.pluginId);
    this.db.execute(
      `INSERT INTO plugin_connector_bindings (plugin_id, connector_id, app_technical_id, server_config_json, secret_account, connected, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plugin_id, connector_id) DO UPDATE SET app_technical_id = excluded.app_technical_id, server_config_json = excluded.server_config_json, secret_account = excluded.secret_account, connected = excluded.connected, updated_at = excluded.updated_at`,
      [
        input.pluginId,
        requiredIdentity(input.connectorId, 'connectorId'),
        boundedText(input.appTechnicalId, 'appTechnicalId', 1, 512),
        serializeRecord(input.serverConfig, 'serverConfig', 1_000_000),
        input.secretAccount,
        input.connected ? 1 : 0,
        input.updatedAt,
      ],
    );
    return this.listConnectorBindings(input.pluginId).find((entry) => entry.connectorId === input.connectorId)!;
  }

  listMcpPolicies(pluginId: string): PluginMcpPolicyRecord[] {
    return this.db.select<PluginMcpPolicyRow>(`SELECT * FROM plugin_mcp_policies WHERE plugin_id = ? ORDER BY server_id ASC, tool_name ASC`, [pluginId]).map(mapMcpPolicy);
  }

  upsertMcpPolicy(input: PluginMcpPolicyRecord): PluginMcpPolicyRecord {
    this.require(input.pluginId);
    this.db.execute(
      `INSERT INTO plugin_mcp_policies (plugin_id, server_id, tool_name, enabled, approval_mode, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(plugin_id, server_id, tool_name) DO UPDATE SET enabled = excluded.enabled, approval_mode = excluded.approval_mode, updated_at = excluded.updated_at`,
      [input.pluginId, requiredIdentity(input.serverId, 'serverId'), boundedText(input.toolName, 'toolName', 1, 512), input.enabled ? 1 : 0, oneOf(input.approvalMode, pluginApprovalModes, 'approvalMode'), input.updatedAt],
    );
    return this.listMcpPolicies(input.pluginId).find((entry) => entry.serverId === input.serverId && entry.toolName === input.toolName)!;
  }

  freezeConversationActivations(conversationId: string, activations: Array<{ plugin: PluginRegistrationRecord; revision: PluginRevisionRecord; snapshot: Record<string, unknown> }>, createdAt: string): ConversationPluginActivationRecord[] {
    this.db.transaction(() => {
      this.db.execute(`INSERT OR IGNORE INTO conversation_plugin_activation_sets (conversation_id, created_at) VALUES (?, ?)`, [conversationId, createdAt]);
      for (const activation of activations) {
        this.db.execute(`INSERT OR IGNORE INTO conversation_plugin_activations (conversation_id, plugin_id, plugin_revision_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)`, [
          conversationId,
          activation.plugin.id,
          activation.revision.id,
          serializeRecord(activation.snapshot, 'activationSnapshot', 2_000_000),
          createdAt,
        ]);
      }
    });
    return this.listConversationActivations(conversationId);
  }

  hasConversationActivationSet(conversationId: string): boolean {
    return Boolean(this.db.get<{ conversation_id: string }>(`SELECT conversation_id FROM conversation_plugin_activation_sets WHERE conversation_id = ?`, [conversationId]));
  }

  listConversationActivations(conversationId: string): ConversationPluginActivationRecord[] {
    return this.db.select<ConversationPluginActivationRow>(`SELECT * FROM conversation_plugin_activations WHERE conversation_id = ? ORDER BY plugin_id ASC`, [conversationId]).map(mapConversationActivation);
  }

  countRevisionReferences(pluginRevisionId: string): number {
    return this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM conversation_plugin_activations WHERE plugin_revision_id = ?`, [pluginRevisionId])?.count ?? 0;
  }

  countInstallPathReferences(installPath: string): number {
    return (
      this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM plugin_revisions revision
         LEFT JOIN plugin_registrations registration ON registration.id = revision.plugin_id AND registration.deleted_at IS NULL
         LEFT JOIN conversation_plugin_activations activation ON activation.plugin_revision_id = revision.id
         WHERE revision.install_path = ? AND (registration.id IS NOT NULL OR activation.plugin_revision_id IS NOT NULL)`,
        [boundedText(installPath, 'installPath', 1, 16_000)],
      )?.count ?? 0
    );
  }

  private require(id: string): PluginRegistrationRecord {
    const existing = this.get(id);
    if (!existing) throw pluginStoreError('ZEUS_PLUGIN_NOT_FOUND', 'Plugin 不存在。');
    return existing;
  }
}

export class PluginStoreError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: string,
    message: string,
    statusCode = 400,
  ) {
    super(message);
    this.name = 'PluginStoreError';
    this.statusCode = statusCode;
  }
}

function pluginStoreError(code: string, message: string, statusCode = 400): PluginStoreError {
  return new PluginStoreError(code, message, statusCode);
}

interface PluginRegistrationRow {
  id: string;
  name: string;
  display_name: string;
  description: string;
  scope: string;
  project_id: string | null;
  source_kind: string;
  source_locator: string;
  source_ref: string | null;
  source_subdirectory: string | null;
  marketplace_id: string | null;
  active_revision_id: string;
  enabled: number;
  connection_state: string;
  connection_reason: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface PluginRevisionRow {
  id: string;
  plugin_id: string;
  version: string;
  content_sha256: string;
  install_path: string;
  manifest_json: string;
  components_json: string;
  created_at: string;
  retired_at: string | null;
}

interface PluginMarketplaceRow {
  id: string;
  name: string;
  scope: string;
  project_id: string | null;
  source_kind: string;
  source_locator: string;
  source_ref: string | null;
  source_subdirectory: string | null;
  snapshot_path: string;
  enabled: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface PluginHookTrustRow {
  plugin_revision_id: string;
  hook_id: string;
  definition_sha256: string;
  trusted_definition_sha256: string | null;
  enabled: number;
  trusted_at: string | null;
  updated_at: string;
}

interface PluginConnectorBindingRow {
  plugin_id: string;
  connector_id: string;
  app_technical_id: string;
  server_config_json: string;
  secret_account: string | null;
  connected: number;
  updated_at: string;
}

interface PluginMcpPolicyRow {
  plugin_id: string;
  server_id: string;
  tool_name: string;
  enabled: number;
  approval_mode: string;
  updated_at: string;
}

interface ConversationPluginActivationRow {
  conversation_id: string;
  plugin_id: string;
  plugin_revision_id: string;
  snapshot_json: string;
  created_at: string;
}

function mapRegistration(row: PluginRegistrationRow): PluginRegistrationRecord {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    scope: oneOf(row.scope, pluginScopes, 'plugin.scope'),
    projectId: row.project_id,
    sourceKind: oneOf(row.source_kind, pluginSourceKinds, 'plugin.sourceKind'),
    sourceLocator: row.source_locator,
    sourceRef: row.source_ref,
    sourceSubdirectory: row.source_subdirectory,
    marketplaceId: row.marketplace_id,
    activeRevisionId: row.active_revision_id,
    enabled: row.enabled === 1,
    connectionState: oneOf(row.connection_state, pluginConnectionStates, 'plugin.connectionState'),
    connectionReason: row.connection_reason,
    revision: nonNegativeInteger(row.revision, 'plugin.revision'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPluginRevision(row: PluginRevisionRow): PluginRevisionRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    version: row.version,
    contentSha256: requiredSha256(row.content_sha256),
    installPath: row.install_path,
    manifest: parseRecord(row.manifest_json, 'plugin.manifest'),
    components: parseComponents(row.components_json),
    createdAt: row.created_at,
    retiredAt: row.retired_at,
  };
}

function mapMarketplace(row: PluginMarketplaceRow): PluginMarketplaceRecord {
  return {
    id: row.id,
    name: row.name,
    scope: oneOf(row.scope, pluginScopes, 'marketplace.scope'),
    projectId: row.project_id,
    sourceKind: oneOf(row.source_kind, ['local', 'git'] as const, 'marketplace.sourceKind'),
    sourceLocator: row.source_locator,
    sourceRef: row.source_ref,
    sourceSubdirectory: row.source_subdirectory,
    snapshotPath: row.snapshot_path,
    enabled: row.enabled === 1,
    revision: nonNegativeInteger(row.revision, 'marketplace.revision'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHookTrust(row: PluginHookTrustRow): PluginHookTrustRecord {
  return {
    pluginRevisionId: row.plugin_revision_id,
    hookId: row.hook_id,
    definitionSha256: requiredSha256(row.definition_sha256),
    trustedDefinitionSha256: row.trusted_definition_sha256 ? requiredSha256(row.trusted_definition_sha256) : null,
    enabled: row.enabled === 1,
    trustedAt: row.trusted_at,
    updatedAt: row.updated_at,
  };
}

function mapConnectorBinding(row: PluginConnectorBindingRow): PluginConnectorBindingRecord {
  return {
    pluginId: row.plugin_id,
    connectorId: row.connector_id,
    appTechnicalId: row.app_technical_id,
    serverConfig: parseRecord(row.server_config_json, 'connector.serverConfig'),
    secretAccount: row.secret_account,
    connected: row.connected === 1,
    updatedAt: row.updated_at,
  };
}

function mapMcpPolicy(row: PluginMcpPolicyRow): PluginMcpPolicyRecord {
  return {
    pluginId: row.plugin_id,
    serverId: row.server_id,
    toolName: row.tool_name,
    enabled: row.enabled === 1,
    approvalMode: oneOf(row.approval_mode, pluginApprovalModes, 'mcpPolicy.approvalMode'),
    updatedAt: row.updated_at,
  };
}

function mapConversationActivation(row: ConversationPluginActivationRow): ConversationPluginActivationRecord {
  return { conversationId: row.conversation_id, pluginId: row.plugin_id, pluginRevisionId: row.plugin_revision_id, snapshot: parseRecord(row.snapshot_json, 'activation.snapshot'), createdAt: row.created_at };
}

function parseComponents(value: string): PluginComponentSnapshot {
  const parsed = parseRecord(value, 'plugin.components');
  if (!Array.isArray(parsed.skills) || !Array.isArray(parsed.hooks) || !Array.isArray(parsed.mcpServers) || !Array.isArray(parsed.apps) || !Array.isArray(parsed.assets) || typeof parsed.hasMcpAppUi !== 'boolean') {
    throw pluginStoreError('ZEUS_PLUGIN_STORED_COMPONENTS_INVALID', 'Plugin 组件快照无效。', 500);
  }
  return parsed as unknown as PluginComponentSnapshot;
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw pluginStoreError('ZEUS_PLUGIN_STORED_JSON_INVALID', `${label} JSON 无效：${error instanceof Error ? error.message : String(error)}`, 500);
  }
}

function serializeRecord(value: object, label: string, maximumBytes: number): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) throw pluginStoreError('ZEUS_PLUGIN_RECORD_TOO_LARGE', `${label} 超出存储上限。`);
  return serialized;
}

function requiredPluginName(value: string): string {
  const name = boundedText(value, 'plugin.name', 1, 120);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/u.test(name)) throw pluginStoreError('ZEUS_PLUGIN_NAME_INVALID', 'Plugin name 必须使用小写字母、数字和连字符。');
  return name;
}

function requiredIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw pluginStoreError('ZEUS_PLUGIN_IDENTITY_INVALID', `${label} 无效。`);
  return value.trim();
}

function requiredSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw pluginStoreError('ZEUS_PLUGIN_SHA256_INVALID', 'Plugin SHA-256 无效。');
  return value;
}

function optionalText(value: string | null | undefined, maximum: number): string | null {
  if (value === null || value === undefined || !value.trim()) return null;
  return boundedText(value, 'optionalText', 1, maximum);
}

function boundedText(value: string, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw pluginStoreError('ZEUS_PLUGIN_TEXT_INVALID', `${label} 必须是字符串。`);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum) throw pluginStoreError('ZEUS_PLUGIN_TEXT_INVALID', `${label} 长度无效。`);
  return text;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw pluginStoreError('ZEUS_PLUGIN_ENUM_INVALID', `${label} 无效。`);
  return value as T;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw pluginStoreError('ZEUS_PLUGIN_INTEGER_INVALID', `${label} 无效。`, 500);
  return value;
}

function nextTimestamp(previous: string): string {
  const now = new Date().toISOString();
  return now > previous ? now : new Date(Date.parse(previous) + 1).toISOString();
}

function assertChanged(db: ZeusDatabasePort, message: string): void {
  if ((db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) !== 1) throw pluginStoreError('ZEUS_PLUGIN_REVISION_CONFLICT', message, 409);
}
