export type CodexLegacyImportRunStatus = 'prepared' | 'waiting' | 'completed' | 'failed';

export interface CodexLegacyImportEligibleSession {
  sourceConversationId: string;
  title: string;
  cwd: string;
}

export interface CodexLegacyImportRun {
  id: string;
  importId: string | null;
  sourceConversationId: string;
  targetConversationId: string | null;
  status: CodexLegacyImportRunStatus;
  targetThreadId: string | null;
  failureStage: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CodexLegacyImportSnapshot {
  eligible: CodexLegacyImportEligibleSession[];
  runs: CodexLegacyImportRun[];
}

export interface CodexLegacyImportResult {
  importId: string;
  status: 'waiting' | 'completed' | 'failed';
  runs: CodexLegacyImportRun[];
}

export interface CodexConfigImportEntry {
  path: string;
  kind: 'file' | 'directory';
  nodeCount: number;
}

export interface CodexConfigImportPreview {
  available: boolean;
  sourceRoot: string;
  targetRoot: string;
  entries: CodexConfigImportEntry[];
  skipped: Array<{
    path: string;
    reason: 'missing' | 'symbolic_link' | 'unsupported_type' | 'contains_sensitive_assignment' | 'too_large' | 'generated_runtime';
  }>;
}

export interface CodexConfigImportResult extends CodexConfigImportPreview {
  imported: string[];
  backupRoot: string | null;
  importedAt: string;
  restartRequired: boolean;
  runtimeReloaded: boolean;
  runtimeGenerationId: string | null;
  runtimeError: string | null;
}

export interface CodexConfigActivationResult {
  runtimeReloaded: true;
  runtimeGenerationId: string;
  restartRequired: false;
}

export type SkillScope = 'user' | 'repo' | 'system' | 'admin' | 'plugin-personal' | 'plugin-project';

export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  shortDescription?: string;
  invocation: string;
  path: string;
  scope: SkillScope;
  removable: boolean;
  source?: 'skill' | 'plugin';
  pluginId?: string;
  pluginName?: string;
  pluginRevisionId?: string;
  interface?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
}

export interface SkillCatalog {
  cwd: string;
  skills: SkillDescriptor[];
  plugins?: Array<{
    id: string;
    name: string;
    displayName: string;
    description: string;
    scope: PluginScope;
    pluginRevisionId: string;
    sourceKind: 'local' | 'git' | 'marketplace';
    sourceLocator: string;
    sourceRef?: string | null;
  }>;
  errors: Array<Record<string, unknown>>;
  refreshedAt: string;
}

export type SkillInstallSource = { kind: 'local'; path: string } | { kind: 'git'; repositoryUrl: string; ref?: string; subdirectory?: string };

export interface SkillInstallResult {
  skill: SkillDescriptor;
  installedAt: string;
}

export type PluginScope = 'personal' | 'project';
export type PluginApprovalMode = 'prompt' | 'approve' | 'deny';
export type PluginDirectSource = { kind: 'local'; path: string } | { kind: 'git'; repositoryUrl: string; ref?: string; subdirectory?: string };
export type PluginInstallSource = PluginDirectSource | { kind: 'marketplace'; marketplaceId: string; pluginName: string };

export interface PluginHookTrust {
  pluginRevisionId: string;
  hookId: string;
  definitionSha256: string;
  trustedDefinitionSha256: string | null;
  enabled: boolean;
  trustedAt: string | null;
  updatedAt: string;
}

export interface PluginConnectorBinding {
  pluginId: string;
  connectorId: string;
  appTechnicalId: string;
  serverConfig: Record<string, unknown>;
  secretAccount: string | null;
  connected: boolean;
  updatedAt: string;
}

export interface PluginMcpPolicy {
  pluginId: string;
  serverId: string;
  toolName: string;
  enabled: boolean;
  approvalMode: PluginApprovalMode;
  updatedAt: string;
}

export interface PluginDescriptor {
  plugin: {
    id: string;
    name: string;
    displayName: string;
    description: string;
    scope: PluginScope;
    projectId: string | null;
    sourceKind: 'local' | 'git' | 'marketplace';
    sourceLocator: string;
    sourceRef: string | null;
    sourceSubdirectory: string | null;
    marketplaceId: string | null;
    activeRevisionId: string;
    enabled: boolean;
    connectionState: 'ready' | 'needs_connection' | 'incompatible';
    connectionReason: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
  };
  revision: {
    id: string;
    pluginId: string;
    version: string;
    contentSha256: string;
    installPath: string;
    manifest: Record<string, unknown>;
    components: {
      skills: Array<{ id: string; name: string; description: string; path: string }>;
      hooks: Array<{ id: string; event: string; matcher: string | null; definitionSha256: string; definition: Record<string, unknown> }>;
      mcpServers: Array<{ id: string; name: string; transport: 'stdio' | 'http'; config: Record<string, unknown> }>;
      apps: Array<{ id: string; technicalId: string; name: string }>;
      assets: Array<{ kind: string; path: string }>;
      hasMcpAppUi: boolean;
    };
    createdAt: string;
    retiredAt: string | null;
  };
  hooks: PluginHookTrust[];
  connectors: PluginConnectorBinding[];
  mcpPolicies: PluginMcpPolicy[];
  providerLegacyConflict: boolean;
  updateAvailable: boolean;
}

export interface PluginMarketplaceCatalog {
  marketplace: {
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
  };
  displayName: string;
  entries: Array<{ name: string; description: string; version: string | null; source: PluginDirectSource }>;
}
