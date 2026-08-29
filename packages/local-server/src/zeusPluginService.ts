import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  PluginRepository,
  type ConversationPluginActivationRecord,
  type PluginApprovalMode,
  type PluginComponentSnapshot,
  type PluginConnectorBindingRecord,
  type PluginHookTrustRecord,
  type PluginMarketplaceRecord,
  type PluginMcpPolicyRecord,
  type PluginRegistrationRecord,
  type PluginRevisionRecord,
  type PluginScope,
} from '@zeus/storage';
import type { SecretStore } from '@zeus/security-core';
import { inspectZeusPluginDirectory, ZeusPluginManifestError, type ZeusPluginManifestInspection } from './zeusPluginManifest.js';
import { discoverMarketplace, inspectSafeSourceTree, materializePluginSource, ZeusPluginSourceError, type ZeusMarketplaceEntry, type ZeusPluginDirectSource } from './zeusPluginSource.js';

const maximumMarketplaceNodes = 25_000;
const maximumMarketplaceBytes = 512 * 1024 * 1024;

export type ZeusPluginInstallSource = ZeusPluginDirectSource | { kind: 'marketplace'; marketplaceId: string; pluginName: string };

export interface ZeusPluginDescriptor {
  plugin: PluginRegistrationRecord;
  revision: PluginRevisionRecord;
  hooks: PluginHookTrustRecord[];
  connectors: PluginConnectorBindingRecord[];
  mcpPolicies: PluginMcpPolicyRecord[];
  providerLegacyConflict: boolean;
  updateAvailable: boolean;
}

export interface ZeusPluginSkillDescriptor {
  id: string;
  namespace: string;
  pluginId: string;
  pluginName: string;
  pluginRevisionId: string;
  name: string;
  description: string;
  path: string;
  scope: PluginScope;
  sourceKind: PluginRegistrationRecord['sourceKind'];
}

export interface ZeusMarketplaceCatalog {
  marketplace: PluginMarketplaceRecord;
  displayName: string;
  entries: ZeusMarketplaceEntry[];
}

export interface PluginActivationSnapshot {
  pluginId: string;
  pluginRevisionId: string;
  name: string;
  version: string;
  contentSha256: string;
  installPath: string;
  components: PluginComponentSnapshot;
  hooks: PluginHookTrustRecord[];
  connectors: PluginConnectorBindingRecord[];
  mcpPolicies: PluginMcpPolicyRecord[];
  explicitReferences: Array<{ kind: 'plugin' | 'skill'; id: string }>;
  frozenAt: string;
}

export interface ZeusPluginService {
  list(input?: { projectId?: string | null }): Promise<ZeusPluginDescriptor[]>;
  listSkills(input?: { projectId?: string | null }): Promise<ZeusPluginSkillDescriptor[]>;
  install(input: { scope: PluginScope; projectId?: string | null; source: ZeusPluginInstallSource }): Promise<ZeusPluginDescriptor>;
  update(input: { pluginId: string }): Promise<ZeusPluginDescriptor>;
  remove(input: { pluginId: string; expectedRevision?: number }): Promise<{ removed: true; pluginId: string; retainedRevisionIds: string[] }>;
  setEnabled(input: { pluginId: string; enabled: boolean; expectedRevision?: number }): Promise<ZeusPluginDescriptor>;
  trustHook(input: { pluginId: string; pluginRevisionId: string; hookId: string; trusted: boolean }): Promise<PluginHookTrustRecord>;
  setHookEnabled(input: { pluginId: string; pluginRevisionId: string; hookId: string; enabled: boolean }): Promise<PluginHookTrustRecord>;
  addMarketplace(input: { scope: PluginScope; projectId?: string | null; source: ZeusPluginDirectSource }): Promise<ZeusMarketplaceCatalog>;
  refreshMarketplace(input: { marketplaceId: string }): Promise<ZeusMarketplaceCatalog>;
  removeMarketplace(input: { marketplaceId: string }): Promise<{ removed: true; marketplaceId: string }>;
  listMarketplaces(input?: { projectId?: string | null }): Promise<ZeusMarketplaceCatalog[]>;
  bindConnector(input: { pluginId: string; connectorId: string; appTechnicalId: string; serverConfig: Record<string, unknown>; secret?: string | null; connected: boolean }): Promise<PluginConnectorBindingRecord>;
  revokeConnectorAuthorization(input: { connectorId: string }): Promise<{ revoked: true; connectorId: string; affectedPluginIds: string[] }>;
  setMcpPolicy(input: { pluginId: string; serverId: string; toolName?: string; enabled: boolean; approvalMode: PluginApprovalMode }): Promise<PluginMcpPolicyRecord>;
  resolveExplicitReferences(input: { projectId?: string | null; text: string }): Promise<Array<{ kind: 'plugin' | 'skill'; id: string }>>;
  validateExplicitReferences(input: { projectId?: string | null; references: unknown }): Promise<Array<{ kind: 'plugin' | 'skill'; id: string }>>;
  validateConversationReferences(input: { conversationId: string; references: unknown }): Promise<Array<{ kind: 'plugin' | 'skill'; id: string }>>;
  getOrFreezeConversationActivations(input: { conversationId: string; projectId?: string | null; explicitReferences?: Array<{ kind: 'plugin' | 'skill'; id: string }> }): Promise<PluginActivationSnapshot[]>;
}

export class ZeusPluginServiceError extends Error {
  readonly name = 'ZeusPluginServiceError';

  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: 400 | 404 | 409 | 413 | 422 = 400,
  ) {
    super(message);
  }
}

export function createZeusPluginService(options: {
  bundlesRoot: string;
  dataRoot: string;
  runtimeRoot: string;
  codexHome?: string;
  repository: PluginRepository;
  secretStore: SecretStore;
  save(): Promise<void>;
  now?: () => Date;
}): ZeusPluginService {
  const bundlesRoot = requireAbsolutePath(options.bundlesRoot, 'Plugin 缓存目录');
  const dataRoot = requireAbsolutePath(options.dataRoot, 'Plugin 数据目录');
  const runtimeRoot = requireAbsolutePath(options.runtimeRoot, 'Plugin 临时目录');
  const codexHome = options.codexHome ? requireAbsolutePath(options.codexHome, 'Codex Home') : null;
  const now = options.now ?? (() => new Date());

  async function list(input: { projectId?: string | null } = {}): Promise<ZeusPluginDescriptor[]> {
    const legacyNames = await discoverProviderLegacyNames(codexHome);
    return options.repository.list({ projectId: input.projectId }).map((plugin) => toDescriptor(plugin, legacyNames.has(plugin.name)));
  }

  async function listSkills(input: { projectId?: string | null } = {}): Promise<ZeusPluginSkillDescriptor[]> {
    const plugins = await list(input);
    const skills: ZeusPluginSkillDescriptor[] = [];
    for (const descriptor of plugins) {
      if (!descriptor.plugin.enabled || descriptor.providerLegacyConflict) continue;
      for (const skill of descriptor.revision.components.skills) {
        skills.push({
          id: `plugin:${descriptor.plugin.id}:skill:${skill.id}`,
          namespace: `${descriptor.plugin.name}/${skill.name}`,
          pluginId: descriptor.plugin.id,
          pluginName: descriptor.plugin.name,
          pluginRevisionId: descriptor.revision.id,
          name: skill.name,
          description: skill.description,
          path: resolveComponentPath(descriptor.revision.installPath, skill.path),
          scope: descriptor.plugin.scope,
          sourceKind: descriptor.plugin.sourceKind,
        });
      }
    }
    skills.sort((left, right) => left.namespace.localeCompare(right.namespace) || left.pluginId.localeCompare(right.pluginId));
    return skills;
  }

  async function install(input: { scope: PluginScope; projectId?: string | null; source: ZeusPluginInstallSource }): Promise<ZeusPluginDescriptor> {
    validateScope(input.scope, input.projectId);
    const resolvedSource = await resolveInstallSource(input.source);
    return installResolved({
      scope: input.scope,
      projectId: input.scope === 'project' ? input.projectId! : null,
      resolvedSource,
      updatePluginId: null,
    });
  }

  async function update(input: { pluginId: string }): Promise<ZeusPluginDescriptor> {
    const plugin = requirePlugin(input.pluginId);
    const resolvedSource = await sourceForUpdate(plugin);
    return installResolved({ scope: plugin.scope, projectId: plugin.projectId, resolvedSource, updatePluginId: plugin.id });
  }

  async function installResolved(input: { scope: PluginScope; projectId: string | null; resolvedSource: ResolvedInstallSource; updatePluginId: string | null }): Promise<ZeusPluginDescriptor> {
    await mkdir(bundlesRoot, { recursive: true, mode: 0o700 });
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = await mkdtemp(join(runtimeRoot, '.plugin-install-'));
    let createdBundlePath: string | null = null;
    try {
      const sourceRoot = await materializePluginSource(input.resolvedSource.source, stagingRoot);
      const sourceInspection = await inspectZeusPluginDirectory(sourceRoot);
      if (input.resolvedSource.expectedName && input.resolvedSource.expectedName !== sourceInspection.name) {
        throw new ZeusPluginServiceError('ZEUS_PLUGIN_MARKETPLACE_NAME_MISMATCH', `Marketplace 条目 ${input.resolvedSource.expectedName} 指向了 Plugin ${sourceInspection.name}。`, 422);
      }
      const sameSourceInstallation = options.repository
        .listAll()
        .find((plugin) => plugin.scope === input.scope && plugin.projectId === input.projectId && plugin.name === sourceInspection.name && sameSourceIdentity(plugin, input.resolvedSource));
      if (!input.updatePluginId && sameSourceInstallation) {
        throw new ZeusPluginServiceError('ZEUS_PLUGIN_ALREADY_INSTALLED', `Plugin “${sourceInspection.name}” 已从相同来源安装；请使用更新入口。`, 409);
      }
      if (input.updatePluginId && sameSourceInstallation && sameSourceInstallation.id !== input.updatePluginId) {
        throw new ZeusPluginServiceError('ZEUS_PLUGIN_SOURCE_CONFLICT', `Plugin “${sourceInspection.name}”的该来源已由另一安装身份占用。`, 409);
      }

      const readyPath = join(stagingRoot, `ready-${randomUUID()}`);
      await cp(sourceRoot, readyPath, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      const stagedInspection = await inspectZeusPluginDirectory(readyPath);
      assertStableInspection(sourceInspection, stagedInspection);
      const finalPath = join(bundlesRoot, safeDirectoryName(stagedInspection.name), stagedInspection.contentSha256);
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      if (await pathExists(finalPath)) {
        const existingInspection = await inspectZeusPluginDirectory(finalPath);
        assertStableInspection(stagedInspection, existingInspection);
      } else {
        await rename(readyPath, finalPath);
        createdBundlePath = finalPath;
      }

      const providerLegacyConflict = (await discoverProviderLegacyNames(codexHome)).has(stagedInspection.name);
      const connection = deriveConnectionState(stagedInspection, providerLegacyConflict);
      const result = options.repository.recordInstallation({
        ...(input.updatePluginId ? { pluginId: input.updatePluginId } : {}),
        name: stagedInspection.name,
        displayName: stagedInspection.displayName,
        description: stagedInspection.description,
        scope: input.scope,
        projectId: input.projectId,
        sourceKind: input.resolvedSource.sourceKind,
        sourceLocator: input.resolvedSource.sourceLocator,
        sourceRef: input.resolvedSource.sourceRef,
        sourceSubdirectory: input.resolvedSource.sourceSubdirectory,
        marketplaceId: input.resolvedSource.marketplaceId,
        version: stagedInspection.version,
        contentSha256: stagedInspection.contentSha256,
        installPath: finalPath,
        manifest: stagedInspection.manifest,
        components: stagedInspection.components,
        connectionState: connection.state,
        connectionReason: connection.reason,
        enabled: !providerLegacyConflict,
        createdAt: now().toISOString(),
      });
      await mkdir(join(dataRoot, result.plugin.id), { recursive: true, mode: 0o700 });
      await options.save();
      createdBundlePath = null;
      await pruneUnreferencedRevisions(result.plugin.id, result.revision.id);
      return toDescriptor(result.plugin, providerLegacyConflict);
    } catch (error) {
      throw normalizeServiceError(error);
    } finally {
      if (createdBundlePath) await rm(createdBundlePath, { recursive: true, force: true }).catch(() => undefined);
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function remove(input: { pluginId: string; expectedRevision?: number }): Promise<{ removed: true; pluginId: string; retainedRevisionIds: string[] }> {
    const plugin = requirePlugin(input.pluginId);
    const revisions = options.repository.listRevisions(plugin.id);
    options.repository.remove(plugin.id, input.expectedRevision);
    await options.save();
    const retainedRevisionIds: string[] = [];
    for (const revision of revisions) {
      if (options.repository.countRevisionReferences(revision.id) > 0 || options.repository.countInstallPathReferences(revision.installPath) > 0) {
        retainedRevisionIds.push(revision.id);
        continue;
      }
      await rm(revision.installPath, { recursive: true, force: true }).catch(() => retainedRevisionIds.push(revision.id));
    }
    return { removed: true, pluginId: plugin.id, retainedRevisionIds };
  }

  async function setEnabled(input: { pluginId: string; enabled: boolean; expectedRevision?: number }): Promise<ZeusPluginDescriptor> {
    const plugin = requirePlugin(input.pluginId);
    const legacyConflict = (await discoverProviderLegacyNames(codexHome)).has(plugin.name);
    if (input.enabled && legacyConflict) {
      throw new ZeusPluginServiceError('ZEUS_PLUGIN_PROVIDER_LEGACY_CONFLICT', `Provider 已原生安装同名 Plugin “${plugin.name}”；Zeus 不会启用第二份并造成重复执行。`, 409);
    }
    const updated = options.repository.setEnabled(plugin.id, input.enabled, input.expectedRevision);
    await options.save();
    return toDescriptor(updated, legacyConflict);
  }

  async function trustHook(input: { pluginId: string; pluginRevisionId: string; hookId: string; trusted: boolean }): Promise<PluginHookTrustRecord> {
    requireOwnedRevision(input.pluginId, input.pluginRevisionId);
    const hook = options.repository.trustHook(input.pluginRevisionId, input.hookId, input.trusted);
    await options.save();
    return hook;
  }

  async function setHookEnabled(input: { pluginId: string; pluginRevisionId: string; hookId: string; enabled: boolean }): Promise<PluginHookTrustRecord> {
    requireOwnedRevision(input.pluginId, input.pluginRevisionId);
    const hook = options.repository.setHookEnabled(input.pluginRevisionId, input.hookId, input.enabled);
    await options.save();
    return hook;
  }

  async function addMarketplace(input: { scope: PluginScope; projectId?: string | null; source: ZeusPluginDirectSource }): Promise<ZeusMarketplaceCatalog> {
    validateScope(input.scope, input.projectId);
    return persistMarketplace({
      id: null,
      scope: input.scope,
      projectId: input.scope === 'project' ? input.projectId! : null,
      source: input.source,
    });
  }

  async function refreshMarketplace(input: { marketplaceId: string }): Promise<ZeusMarketplaceCatalog> {
    const marketplace = options.repository.getMarketplace(input.marketplaceId);
    if (!marketplace) throw new ZeusPluginServiceError('ZEUS_PLUGIN_MARKETPLACE_NOT_FOUND', 'Plugin Marketplace 不存在。', 404);
    const source: ZeusPluginDirectSource =
      marketplace.sourceKind === 'local'
        ? { kind: 'local', path: marketplace.sourceLocator }
        : {
            kind: 'git',
            repositoryUrl: marketplace.sourceLocator,
            ...(marketplace.sourceRef ? { ref: marketplace.sourceRef } : {}),
            ...(marketplace.sourceSubdirectory ? { subdirectory: marketplace.sourceSubdirectory } : {}),
          };
    return persistMarketplace({ id: marketplace.id, scope: marketplace.scope, projectId: marketplace.projectId, source });
  }

  async function persistMarketplace(input: { id: string | null; scope: PluginScope; projectId: string | null; source: ZeusPluginDirectSource }): Promise<ZeusMarketplaceCatalog> {
    await mkdir(bundlesRoot, { recursive: true, mode: 0o700 });
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = await mkdtemp(join(runtimeRoot, '.marketplace-install-'));
    let createdSnapshotPath: string | null = null;
    try {
      const materializedRoot = await materializePluginSource(input.source, stagingRoot);
      const sourceInventory = await inspectSafeSourceTree(materializedRoot, { maximumNodes: maximumMarketplaceNodes, maximumBytes: maximumMarketplaceBytes });
      const readyPath = join(stagingRoot, `ready-${randomUUID()}`);
      await cp(materializedRoot, readyPath, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      const readyInventory = await inspectSafeSourceTree(readyPath, { maximumNodes: maximumMarketplaceNodes, maximumBytes: maximumMarketplaceBytes });
      if (sourceInventory.contentSha256 !== readyInventory.contentSha256) throw new ZeusPluginServiceError('ZEUS_PLUGIN_SOURCE_CHANGED', 'Marketplace 来源在复制期间发生变化，请确认来源稳定后重试。', 422);
      const document = await discoverMarketplace(readyPath);
      const marketplaceId = input.id ?? `plugin_marketplace_${randomUUID().replaceAll('-', '')}`;
      const snapshotPath = join(bundlesRoot, '.marketplaces', marketplaceId, readyInventory.contentSha256);
      await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
      if (!(await pathExists(snapshotPath))) {
        await rename(readyPath, snapshotPath);
        createdSnapshotPath = snapshotPath;
      }
      const record = options.repository.upsertMarketplace({
        id: marketplaceId,
        name: document.name,
        scope: input.scope,
        projectId: input.projectId,
        sourceKind: input.source.kind,
        sourceLocator: input.source.kind === 'local' ? input.source.path : input.source.repositoryUrl,
        sourceRef: input.source.kind === 'git' ? (input.source.ref ?? null) : null,
        sourceSubdirectory: input.source.kind === 'git' ? (input.source.subdirectory ?? null) : null,
        snapshotPath,
        enabled: true,
      });
      await options.save();
      createdSnapshotPath = null;
      const installedDocument = await discoverMarketplace(snapshotPath);
      return { marketplace: record, displayName: installedDocument.displayName, entries: installedDocument.entries };
    } catch (error) {
      throw normalizeServiceError(error);
    } finally {
      if (createdSnapshotPath) await rm(createdSnapshotPath, { recursive: true, force: true }).catch(() => undefined);
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function removeMarketplace(input: { marketplaceId: string }): Promise<{ removed: true; marketplaceId: string }> {
    options.repository.removeMarketplace(input.marketplaceId);
    await options.save();
    return { removed: true, marketplaceId: input.marketplaceId };
  }

  async function listMarketplaces(input: { projectId?: string | null } = {}): Promise<ZeusMarketplaceCatalog[]> {
    const catalogs: ZeusMarketplaceCatalog[] = [];
    for (const marketplace of options.repository.listMarketplaces(input)) {
      try {
        const document = await discoverMarketplace(marketplace.snapshotPath);
        catalogs.push({ marketplace, displayName: document.displayName, entries: document.entries });
      } catch (error) {
        throw normalizeServiceError(error);
      }
    }
    return catalogs;
  }

  async function bindConnector(input: { pluginId: string; connectorId: string; appTechnicalId: string; serverConfig: Record<string, unknown>; secret?: string | null; connected: boolean }): Promise<PluginConnectorBindingRecord> {
    const plugin = requirePlugin(input.pluginId);
    const revision = requireRevision(plugin.activeRevisionId);
    if (!revision.components.apps.some((app) => app.technicalId === input.appTechnicalId)) {
      throw new ZeusPluginServiceError('ZEUS_PLUGIN_APP_NOT_FOUND', 'Plugin 未声明该 App 技术 ID。', 404);
    }
    const connectorId = requiredIdentity(input.connectorId, 'connectorId');
    const secretAccount = connectorSecretAccount(connectorId);
    if (input.secret !== undefined && input.secret !== null) {
      if (!input.secret || input.secret.length > 64 * 1024 || input.secret.includes('\0')) throw new ZeusPluginServiceError('ZEUS_PLUGIN_CONNECTOR_SECRET_INVALID', 'Connector 授权值无效。');
      await options.secretStore.setSecret(secretAccount, input.secret);
    }
    const hasStoredSecret = Boolean(await options.secretStore.getSecret(secretAccount));
    if (input.connected && requiresConnectorSecret(input.serverConfig) && !hasStoredSecret) {
      throw new ZeusPluginServiceError('ZEUS_PLUGIN_CONNECTOR_AUTH_REQUIRED', 'Connector 尚未完成授权；授权失败不等同于 Plugin 安装失败。', 409);
    }
    const binding = options.repository.upsertConnectorBinding({
      pluginId: plugin.id,
      connectorId,
      appTechnicalId: input.appTechnicalId,
      serverConfig: structuredClone(input.serverConfig),
      secretAccount: hasStoredSecret ? secretAccount : null,
      connected: input.connected,
      updatedAt: now().toISOString(),
    });
    const bindings = options.repository.listConnectorBindings(plugin.id);
    const allConnected = revision.components.apps.every((app) => bindings.some((candidate) => candidate.appTechnicalId === app.technicalId && candidate.connected));
    options.repository.setConnectionState(plugin.id, allConnected ? 'ready' : 'needs_connection', allConnected ? null : 'Plugin 包含尚未绑定或授权的 Connector。');
    await options.save();
    return binding;
  }

  async function revokeConnectorAuthorization(input: { connectorId: string }): Promise<{ revoked: true; connectorId: string; affectedPluginIds: string[] }> {
    const connectorId = requiredIdentity(input.connectorId, 'connectorId');
    await options.secretStore.deleteSecret(connectorSecretAccount(connectorId));
    const affectedPluginIds: string[] = [];
    for (const plugin of options.repository.listAll()) {
      const bindings = options.repository.listConnectorBindings(plugin.id);
      let changed = false;
      for (const binding of bindings) {
        if (binding.connectorId !== connectorId) continue;
        options.repository.upsertConnectorBinding({ ...binding, secretAccount: null, connected: false, updatedAt: now().toISOString() });
        changed = true;
      }
      if (!changed) continue;
      affectedPluginIds.push(plugin.id);
      options.repository.setConnectionState(plugin.id, 'needs_connection', 'Connector 授权已显式撤销。');
    }
    await options.save();
    return { revoked: true, connectorId, affectedPluginIds };
  }

  async function setMcpPolicy(input: { pluginId: string; serverId: string; toolName?: string; enabled: boolean; approvalMode: PluginApprovalMode }): Promise<PluginMcpPolicyRecord> {
    const plugin = requirePlugin(input.pluginId);
    const revision = requireRevision(plugin.activeRevisionId);
    if (!revision.components.mcpServers.some((server) => server.id === input.serverId) && !options.repository.listConnectorBindings(plugin.id).some((binding) => binding.connectorId === input.serverId)) {
      throw new ZeusPluginServiceError('ZEUS_PLUGIN_MCP_SERVER_NOT_FOUND', 'Plugin MCP Server 或 Connector 不存在。', 404);
    }
    const policy = options.repository.upsertMcpPolicy({
      pluginId: plugin.id,
      serverId: input.serverId,
      toolName: input.toolName?.trim() || '*',
      enabled: input.enabled,
      approvalMode: input.approvalMode,
      updatedAt: now().toISOString(),
    });
    await options.save();
    return policy;
  }

  async function resolveExplicitReferences(input: { projectId?: string | null; text: string }): Promise<Array<{ kind: 'plugin' | 'skill'; id: string }>> {
    if (typeof input.text !== 'string' || input.text.length > 1_000_000) throw new ZeusPluginServiceError('ZEUS_PLUGIN_REFERENCE_INVALID', 'Plugin/Skill 引用文本无效。');
    const descriptors = (await list({ projectId: input.projectId })).filter((descriptor) => descriptor.plugin.enabled && !descriptor.providerLegacyConflict);
    const skills = await listSkills({ projectId: input.projectId });
    const references: Array<{ kind: 'plugin' | 'skill'; id: string }> = [];
    for (const skill of skills) {
      if (hasMention(input.text, skill.namespace)) references.push({ kind: 'skill', id: skill.id });
    }
    for (const descriptor of descriptors) {
      if (!hasMention(input.text, descriptor.plugin.name)) continue;
      const sameName = descriptors.filter((candidate) => candidate.plugin.name === descriptor.plugin.name);
      if (sameName.length > 1) {
        throw new ZeusPluginServiceError('ZEUS_PLUGIN_SOURCE_SELECTION_REQUIRED', `Plugin “${descriptor.plugin.name}”来自多个来源，请在会话选择器中按安装身份明确选择。`, 409);
      }
      references.push({ kind: 'plugin', id: descriptor.plugin.id });
    }
    return normalizeExplicitReferences(references);
  }

  async function validateExplicitReferences(input: { projectId?: string | null; references: unknown }): Promise<Array<{ kind: 'plugin' | 'skill'; id: string }>> {
    if (!Array.isArray(input.references) || input.references.length > 64) {
      throw new ZeusPluginServiceError('ZEUS_PLUGIN_REFERENCE_INVALID', 'Plugin/Skill 结构化引用必须是最多 64 项的数组。');
    }
    const references = normalizeExplicitReferences(input.references as Array<{ kind: 'plugin' | 'skill'; id: string }>);
    const descriptors = (await list({ projectId: input.projectId })).filter((descriptor) => descriptor.plugin.enabled && !descriptor.providerLegacyConflict);
    const pluginIds = new Set(descriptors.map((descriptor) => descriptor.plugin.id));
    const skillIds = new Set((await listSkills({ projectId: input.projectId })).map((skill) => skill.id));
    for (const reference of references) {
      const available = reference.kind === 'plugin' ? pluginIds.has(reference.id) : skillIds.has(reference.id);
      if (!available) {
        throw new ZeusPluginServiceError('ZEUS_PLUGIN_REFERENCE_NOT_FOUND', `Plugin/Skill 引用 ${reference.id} 在当前项目不可用。`, 404);
      }
    }
    return references;
  }

  async function validateConversationReferences(input: { conversationId: string; references: unknown }): Promise<Array<{ kind: 'plugin' | 'skill'; id: string }>> {
    if (!Array.isArray(input.references) || input.references.length > 64) {
      throw new ZeusPluginServiceError('ZEUS_PLUGIN_REFERENCE_INVALID', 'Plugin/Skill 结构化引用必须是最多 64 项的数组。');
    }
    const references = normalizeExplicitReferences(input.references as Array<{ kind: 'plugin' | 'skill'; id: string }>);
    const activations = hydrateActivationRecords(options.repository.listConversationActivations(requiredIdentity(input.conversationId, 'conversationId')));
    const pluginIds = new Set(activations.map((activation) => activation.pluginId));
    const skillIds = new Set(activations.flatMap((activation) => activation.components.skills.map((skill) => `plugin:${activation.pluginId}:skill:${skill.id}`)));
    for (const reference of references) {
      const available = reference.kind === 'plugin' ? pluginIds.has(reference.id) : skillIds.has(reference.id);
      if (!available) {
        throw new ZeusPluginServiceError('ZEUS_PLUGIN_REFERENCE_NOT_IN_SNAPSHOT', `Plugin/Skill 引用 ${reference.id} 不属于该会话的冻结快照。`, 409);
      }
    }
    return references;
  }

  async function getOrFreezeConversationActivations(input: { conversationId: string; projectId?: string | null; explicitReferences?: Array<{ kind: 'plugin' | 'skill'; id: string }> }): Promise<PluginActivationSnapshot[]> {
    const conversationId = requiredIdentity(input.conversationId, 'conversationId');
    if (options.repository.hasConversationActivationSet(conversationId)) return hydrateActivationRecords(options.repository.listConversationActivations(conversationId));
    const legacyNames = await discoverProviderLegacyNames(codexHome);
    const explicitReferences = normalizeExplicitReferences(input.explicitReferences ?? []);
    let enabled = options.repository.list({ projectId: input.projectId }).filter((plugin) => plugin.enabled && !legacyNames.has(plugin.name));
    const duplicateNames = duplicateValues(enabled.map((plugin) => plugin.name));
    for (const duplicateName of duplicateNames) {
      const candidates = enabled.filter((plugin) => plugin.name === duplicateName);
      const selected = candidates.filter((plugin) => explicitReferences.some((reference) => reference.id === plugin.id || reference.id.startsWith(`plugin:${plugin.id}:skill:`)));
      if (selected.length !== 1) {
        throw new ZeusPluginServiceError('ZEUS_PLUGIN_SOURCE_SELECTION_REQUIRED', `Plugin “${duplicateName}”在多个来源或作用域中同名，必须显式选择其中一个安装身份。`, 409);
      }
      enabled = enabled.filter((plugin) => plugin.name !== duplicateName || plugin.id === selected[0]!.id);
    }
    const frozenAt = now().toISOString();
    const activations = enabled.map((plugin) => {
      const revision = requireRevision(plugin.activeRevisionId);
      const snapshot: PluginActivationSnapshot = {
        pluginId: plugin.id,
        pluginRevisionId: revision.id,
        name: plugin.name,
        version: revision.version,
        contentSha256: revision.contentSha256,
        installPath: revision.installPath,
        components: revision.components,
        hooks: options.repository.listHooks(revision.id),
        connectors: options.repository.listConnectorBindings(plugin.id),
        mcpPolicies: options.repository.listMcpPolicies(plugin.id),
        explicitReferences: explicitReferences.filter((reference) => (reference.kind === 'plugin' ? reference.id === plugin.id : reference.id.startsWith(`plugin:${plugin.id}:skill:`))),
        frozenAt,
      };
      return { plugin, revision, snapshot: snapshot as unknown as Record<string, unknown> };
    });
    const records = options.repository.freezeConversationActivations(conversationId, activations, frozenAt);
    await options.save();
    return hydrateActivationRecords(records);
  }

  async function resolveInstallSource(source: ZeusPluginInstallSource): Promise<ResolvedInstallSource> {
    if (!source || typeof source !== 'object') throw new ZeusPluginServiceError('ZEUS_PLUGIN_INPUT_INVALID', 'Plugin 安装来源无效。');
    if (source.kind === 'local') {
      return { source, sourceKind: 'local', sourceLocator: source.path, sourceRef: null, sourceSubdirectory: null, marketplaceId: null, expectedName: null };
    }
    if (source.kind === 'git') {
      return {
        source,
        sourceKind: 'git',
        sourceLocator: source.repositoryUrl,
        sourceRef: source.ref ?? null,
        sourceSubdirectory: source.subdirectory ?? null,
        marketplaceId: null,
        expectedName: null,
      };
    }
    if (source.kind !== 'marketplace') throw new ZeusPluginServiceError('ZEUS_PLUGIN_INPUT_INVALID', '不支持的 Plugin 安装来源。');
    const marketplace = options.repository.getMarketplace(requiredIdentity(source.marketplaceId, 'marketplaceId'));
    if (!marketplace || !marketplace.enabled) throw new ZeusPluginServiceError('ZEUS_PLUGIN_MARKETPLACE_NOT_FOUND', 'Plugin Marketplace 不存在或已停用。', 404);
    const document = await discoverMarketplace(marketplace.snapshotPath);
    const pluginName = requiredKebabName(source.pluginName, 'pluginName');
    const entry = document.entries.find((candidate) => candidate.name === pluginName);
    if (!entry) throw new ZeusPluginServiceError('ZEUS_PLUGIN_MARKETPLACE_ENTRY_NOT_FOUND', `Marketplace 中没有 Plugin “${pluginName}”。`, 404);
    if (entry.policy.installation === 'NOT_AVAILABLE') throw new ZeusPluginServiceError('ZEUS_PLUGIN_MARKETPLACE_ENTRY_UNAVAILABLE', `Marketplace 策略禁止安装 Plugin “${pluginName}”。`, 409);
    return {
      source: entry.source,
      sourceKind: 'marketplace',
      sourceLocator: `${marketplace.id}:${pluginName}`,
      sourceRef: entry.source.kind === 'git' ? (entry.source.ref ?? null) : null,
      sourceSubdirectory: entry.source.kind === 'git' ? (entry.source.subdirectory ?? null) : relative(document.root, entry.source.path),
      marketplaceId: marketplace.id,
      expectedName: pluginName,
    };
  }

  async function sourceForUpdate(plugin: PluginRegistrationRecord): Promise<ResolvedInstallSource> {
    if (plugin.sourceKind === 'marketplace') {
      if (!plugin.marketplaceId) throw new ZeusPluginServiceError('ZEUS_PLUGIN_SOURCE_UNAVAILABLE', 'Plugin 缺少 Marketplace 来源身份。', 404);
      return resolveInstallSource({ kind: 'marketplace', marketplaceId: plugin.marketplaceId, pluginName: plugin.name });
    }
    return resolveInstallSource(
      plugin.sourceKind === 'local'
        ? { kind: 'local', path: plugin.sourceLocator }
        : {
            kind: 'git',
            repositoryUrl: plugin.sourceLocator,
            ...(plugin.sourceRef ? { ref: plugin.sourceRef } : {}),
            ...(plugin.sourceSubdirectory ? { subdirectory: plugin.sourceSubdirectory } : {}),
          },
    );
  }

  function toDescriptor(plugin: PluginRegistrationRecord, providerLegacyConflict: boolean): ZeusPluginDescriptor {
    const revision = requireRevision(plugin.activeRevisionId);
    return {
      plugin,
      revision,
      hooks: options.repository.listHooks(revision.id),
      connectors: options.repository.listConnectorBindings(plugin.id),
      mcpPolicies: options.repository.listMcpPolicies(plugin.id),
      providerLegacyConflict,
      updateAvailable: false,
    };
  }

  function requirePlugin(id: string): PluginRegistrationRecord {
    const plugin = options.repository.get(requiredIdentity(id, 'pluginId'));
    if (!plugin) throw new ZeusPluginServiceError('ZEUS_PLUGIN_NOT_FOUND', 'Plugin 不存在。', 404);
    return plugin;
  }

  function requireRevision(id: string): PluginRevisionRecord {
    const revision = options.repository.getRevision(requiredIdentity(id, 'pluginRevisionId'));
    if (!revision) throw new ZeusPluginServiceError('ZEUS_PLUGIN_REVISION_NOT_FOUND', 'Plugin 修订不存在。', 404);
    return revision;
  }

  function requireOwnedRevision(pluginId: string, revisionId: string): PluginRevisionRecord {
    const plugin = requirePlugin(pluginId);
    const revision = requireRevision(revisionId);
    if (revision.pluginId !== plugin.id) throw new ZeusPluginServiceError('ZEUS_PLUGIN_REVISION_IDENTITY_MISMATCH', 'Plugin 修订不属于路径指定的 Plugin。', 409);
    return revision;
  }

  function hydrateActivationRecords(records: ConversationPluginActivationRecord[]): PluginActivationSnapshot[] {
    return records.map((record) => validateActivationSnapshot(record.snapshot));
  }

  async function pruneUnreferencedRevisions(pluginId: string, activeRevisionId: string): Promise<void> {
    for (const revision of options.repository.listRevisions(pluginId)) {
      if (revision.id === activeRevisionId || options.repository.countRevisionReferences(revision.id) > 0 || options.repository.countInstallPathReferences(revision.installPath) > 1) continue;
      await rm(revision.installPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    list,
    listSkills,
    install,
    update,
    remove,
    setEnabled,
    trustHook,
    setHookEnabled,
    addMarketplace,
    refreshMarketplace,
    removeMarketplace,
    listMarketplaces,
    bindConnector,
    revokeConnectorAuthorization,
    setMcpPolicy,
    resolveExplicitReferences,
    validateExplicitReferences,
    validateConversationReferences,
    getOrFreezeConversationActivations,
  };
}

function connectorSecretAccount(connectorId: string): string {
  return `plugin.connector.${connectorId}`;
}

function requiresConnectorSecret(serverConfig: Record<string, unknown>): boolean {
  return serverConfig.authentication !== 'none' && serverConfig.auth !== 'none';
}

interface ResolvedInstallSource {
  source: ZeusPluginDirectSource;
  sourceKind: PluginRegistrationRecord['sourceKind'];
  sourceLocator: string;
  sourceRef: string | null;
  sourceSubdirectory: string | null;
  marketplaceId: string | null;
  expectedName: string | null;
}

function sameSourceIdentity(plugin: PluginRegistrationRecord, source: ResolvedInstallSource): boolean {
  return (
    plugin.sourceKind === source.sourceKind &&
    plugin.sourceLocator === source.sourceLocator &&
    plugin.sourceRef === source.sourceRef &&
    plugin.sourceSubdirectory === source.sourceSubdirectory &&
    plugin.marketplaceId === source.marketplaceId
  );
}

function assertStableInspection(before: ZeusPluginManifestInspection, after: ZeusPluginManifestInspection): void {
  if (before.name !== after.name || before.contentSha256 !== after.contentSha256) {
    throw new ZeusPluginServiceError('ZEUS_PLUGIN_SOURCE_CHANGED', 'Plugin 来源在复制期间发生变化，请确认来源稳定后重试。', 422);
  }
}

function deriveConnectionState(inspection: ZeusPluginManifestInspection, providerLegacyConflict: boolean): { state: PluginRegistrationRecord['connectionState']; reason: string | null } {
  if (providerLegacyConflict) return { state: 'incompatible', reason: 'Provider 已原生安装同名 Plugin；为避免双重执行，Zeus 安装保持禁用。' };
  if (inspection.components.apps.length > 0) return { state: 'needs_connection', reason: 'Plugin 的 .app.json 注册连接需要绑定到 Zeus MCP Connector。' };
  return { state: 'ready', reason: null };
}

async function discoverProviderLegacyNames(codexHome: string | null): Promise<Set<string>> {
  const result = new Set<string>();
  if (!codexHome) return result;
  const pluginsRoot = join(codexHome, 'plugins');
  if (!(await pathExists(pluginsRoot))) return result;
  let visited = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 8 || visited > 20_000) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > 20_000) return;
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === '.codex-plugin') {
          const manifestPath = join(child, 'plugin.json');
          try {
            const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
            if (isRecord(parsed) && typeof parsed.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(parsed.name)) result.add(parsed.name);
          } catch {
            // Provider legacy 内容只用于冲突探测；损坏条目由 Provider 自己报告，Zeus 不接管。
          }
          continue;
        }
        await visit(child, depth + 1);
      }
    }
  }
  await visit(pluginsRoot, 0);
  return result;
}

function validateActivationSnapshot(value: Record<string, unknown>): PluginActivationSnapshot {
  if (
    typeof value.pluginId !== 'string' ||
    typeof value.pluginRevisionId !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.contentSha256 !== 'string' ||
    typeof value.installPath !== 'string' ||
    !isRecord(value.components) ||
    !Array.isArray(value.hooks) ||
    !Array.isArray(value.connectors) ||
    !Array.isArray(value.mcpPolicies) ||
    !Array.isArray(value.explicitReferences) ||
    typeof value.frozenAt !== 'string'
  ) {
    throw new ZeusPluginServiceError('ZEUS_PLUGIN_ACTIVATION_CORRUPT', '会话 Plugin 激活快照损坏，Zeus 不会改用当前版本。', 409);
  }
  return value as unknown as PluginActivationSnapshot;
}

function normalizeExplicitReferences(values: Array<{ kind: 'plugin' | 'skill'; id: string }>): Array<{ kind: 'plugin' | 'skill'; id: string }> {
  const seen = new Set<string>();
  const result: Array<{ kind: 'plugin' | 'skill'; id: string }> = [];
  for (const value of values) {
    if (!value || (value.kind !== 'plugin' && value.kind !== 'skill')) throw new ZeusPluginServiceError('ZEUS_PLUGIN_REFERENCE_INVALID', 'Plugin/Skill 引用无效。');
    const id = requiredIdentity(value.id, `${value.kind} reference`);
    const identity = `${value.kind}:${id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({ kind: value.kind, id });
  }
  return result;
}

function hasMention(text: string, namespace: string): boolean {
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/u.test(namespace)) return false;
  return new RegExp(`(^|\\s)@${namespace}(?=$|\\s|[.,;:!?，。；：！？、])`, 'u').test(text);
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function resolveComponentPath(pluginRoot: string, relativePath: string): string {
  const target = resolve(pluginRoot, relativePath);
  const path = relative(pluginRoot, target);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new ZeusPluginServiceError('ZEUS_PLUGIN_ACTIVATION_CORRUPT', 'Plugin 组件路径离开不可变安装根目录。', 409);
  return target;
}

function validateScope(scope: PluginScope, projectId: string | null | undefined): void {
  if (scope !== 'personal' && scope !== 'project') throw new ZeusPluginServiceError('ZEUS_PLUGIN_INPUT_INVALID', 'Plugin scope 无效。');
  if (scope === 'project') requiredIdentity(projectId, 'projectId');
}

function requiredKebabName(value: unknown, label: string): string {
  const text = requiredIdentity(value, label);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(text)) throw new ZeusPluginServiceError('ZEUS_PLUGIN_INPUT_INVALID', `${label} 必须使用 kebab-case。`);
  return text;
}

function requiredIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 512 || value.includes('\0')) throw new ZeusPluginServiceError('ZEUS_PLUGIN_INPUT_INVALID', `${label} 无效。`);
  return value.trim();
}

function requireAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new ZeusPluginServiceError('ZEUS_PLUGIN_CONFIGURATION_INVALID', `${label}必须是绝对路径。`);
  return resolve(value);
}

function safeDirectoryName(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) throw new ZeusPluginServiceError('ZEUS_PLUGIN_INPUT_INVALID', 'Plugin 目录名无效。');
  return value;
}

function normalizeServiceError(error: unknown): Error {
  if (error instanceof ZeusPluginServiceError) return error;
  if (error instanceof ZeusPluginSourceError) return new ZeusPluginServiceError(error.code, error.message, error.statusCode);
  if (error instanceof ZeusPluginManifestError) return new ZeusPluginServiceError(error.code, error.message, error.code === 'ZEUS_PLUGIN_MANIFEST_MISSING' ? 404 : 422);
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}
