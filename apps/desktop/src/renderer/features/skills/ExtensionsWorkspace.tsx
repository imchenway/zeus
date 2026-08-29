import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { WarningIcon as Warning } from '@phosphor-icons/react/dist/csr/Warning';
import type { PluginApprovalMode, PluginDescriptor, PluginDirectSource, PluginInstallSource, PluginMarketplaceCatalog, PluginScope } from '../codex/codexContracts.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { SkillsWorkspace } from './SkillsWorkspace.js';
import { skillCatalogChangedEvent } from './SkillSelector.js';

type ExtensionsClient = Pick<
  NativeConversationAppClient,
  | 'loadSkills'
  | 'installSkill'
  | 'removeSkill'
  | 'loadPlugins'
  | 'loadPluginRuntimeStatus'
  | 'installPlugin'
  | 'updatePlugin'
  | 'setPluginEnabled'
  | 'removePlugin'
  | 'trustPluginHook'
  | 'setPluginHookEnabled'
  | 'loadPluginMarketplaces'
  | 'addPluginMarketplace'
  | 'refreshPluginMarketplace'
  | 'removePluginMarketplace'
  | 'bindPluginConnector'
  | 'revokePluginConnectorAuthorization'
  | 'setPluginMcpPolicy'
>;

type Tab = 'plugins' | 'skills' | 'marketplaces';
type SourceDraft = { kind: 'local' | 'git'; path: string; repositoryUrl: string; ref: string; subdirectory: string };
const emptySource = (): SourceDraft => ({ kind: 'local', path: '', repositoryUrl: '', ref: '', subdirectory: '' });

export function ExtensionsWorkspace(props: { client: ExtensionsClient | null; language: 'zh-CN' | 'en-US'; projectId?: string | null; onChooseDirectory?: () => Promise<string | null> }) {
  const zh = props.language === 'zh-CN';
  const [tab, setTab] = useState<Tab>('plugins');
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  const [dangerousHookTrustBypass, setDangerousHookTrustBypass] = useState(false);
  const [marketplaces, setMarketplaces] = useState<PluginMarketplaceCatalog[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [scope, setScope] = useState<PluginScope>('personal');
  const [source, setSource] = useState<SourceDraft>(emptySource);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!props.client) return;
    setBusyKey('load');
    setError(null);
    try {
      const [nextPlugins, nextMarketplaces, runtimeStatus] = await Promise.all([
        props.client.loadPlugins(props.projectId ?? undefined),
        props.client.loadPluginMarketplaces(props.projectId ?? undefined),
        props.client.loadPluginRuntimeStatus(),
      ]);
      setPlugins(nextPlugins);
      setMarketplaces(nextMarketplaces);
      setDangerousHookTrustBypass(runtimeStatus.dangerouslyBypassHookTrust);
    } catch (reason) {
      setError(message(reason, zh ? '无法读取扩展目录。' : 'Unable to load extensions.'));
    } finally {
      setBusyKey(null);
    }
  }, [props.client, props.projectId, zh]);

  useEffect(() => void load(), [load]);

  async function mutate(key: string, operation: () => Promise<unknown>): Promise<boolean> {
    if (!props.client || busyKey) return false;
    setBusyKey(key);
    setError(null);
    try {
      await operation();
      const [nextPlugins, nextMarketplaces, runtimeStatus] = await Promise.all([
        props.client.loadPlugins(props.projectId ?? undefined),
        props.client.loadPluginMarketplaces(props.projectId ?? undefined),
        props.client.loadPluginRuntimeStatus(),
      ]);
      setPlugins(nextPlugins);
      setMarketplaces(nextMarketplaces);
      setDangerousHookTrustBypass(runtimeStatus.dangerouslyBypassHookTrust);
      window.dispatchEvent(new Event(skillCatalogChangedEvent));
      return true;
    } catch (reason) {
      setError(message(reason, zh ? '扩展操作失败。' : 'Extension operation failed.'));
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  async function chooseLocalPath(): Promise<void> {
    const path = await props.onChooseDirectory?.();
    if (path) setSource((current) => ({ ...current, path }));
  }

  function directSource(): PluginDirectSource {
    if (source.kind === 'local') return { kind: 'local', path: source.path.trim() };
    return {
      kind: 'git',
      repositoryUrl: source.repositoryUrl.trim(),
      ...(source.ref.trim() ? { ref: source.ref.trim() } : {}),
      ...(source.subdirectory.trim() ? { subdirectory: source.subdirectory.trim() } : {}),
    };
  }

  async function install(event: FormEvent): Promise<void> {
    event.preventDefault();
    const installSource: PluginInstallSource = directSource();
    const succeeded = await mutate('install', () => props.client!.installPlugin({ scope, projectId: scope === 'project' ? props.projectId : null, source: installSource }));
    if (succeeded) {
      setInstallOpen(false);
      setSource(emptySource());
    }
  }

  async function addMarketplace(event: FormEvent): Promise<void> {
    event.preventDefault();
    const succeeded = await mutate('marketplace-add', () => props.client!.addPluginMarketplace({ scope, projectId: scope === 'project' ? props.projectId : null, source: directSource() }));
    if (succeeded) {
      setMarketplaceOpen(false);
      setSource(emptySource());
    }
  }

  return (
    <section className="workspace-view skills-workspace extensions-workspace" aria-label={zh ? '扩展管理' : 'Extension management'}>
      <header className="skills-workspace-header">
        <span className="skills-workspace-kicker">ZEUS EXTENSIONS</span>
        <div className="skills-workspace-title-row">
          <div>
            <h1>{zh ? '扩展管理' : 'Extension management'}</h1>
            <p>{zh ? 'Plugin 安装、信任、连接和版本由 Zeus 统一管理，并投影到所有新会话。' : 'Zeus manages plugin installation, trust, connections, and versions for every new conversation.'}</p>
          </div>
          <Button variant="secondary" size="regular" busy={busyKey === 'load'} onClick={() => void load()} disabled={!props.client || Boolean(busyKey)}>
            <ArrowClockwise aria-hidden="true" /> {zh ? '刷新' : 'Refresh'}
          </Button>
        </div>
        <nav className="extension-tabs" aria-label={zh ? '扩展类型' : 'Extension type'}>
          {(['plugins', 'skills', 'marketplaces'] as const).map((value) => (
            <button key={value} type="button" className={tab === value ? 'is-active' : ''} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}>
              {tabLabel(value, zh)}
            </button>
          ))}
        </nav>
      </header>

      {error ? (
        <p className="skills-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {dangerousHookTrustBypass ? (
        <p className="skills-inline-error" role="alert">
          <Warning aria-hidden="true" />{' '}
          {zh
            ? '危险模式：本次启动已绕过全部 Plugin Hook 信任检查。关闭 Zeus 并移除启动参数后才会恢复保护。'
            : 'Dangerous mode: this launch bypasses every Plugin Hook trust check. Quit Zeus and remove the startup flag to restore protection.'}
        </p>
      ) : null}
      {tab === 'skills' ? <SkillsWorkspace client={props.client} language={props.language} onChooseDirectory={props.onChooseDirectory} embedded /> : null}
      {tab === 'plugins' ? <PluginCatalog plugins={plugins} zh={zh} busyKey={busyKey} expanded={expanded} onExpanded={setExpanded} onInstall={() => setInstallOpen(true)} onMutate={mutate} client={props.client} /> : null}
      {tab === 'marketplaces' ? <MarketplaceCatalog marketplaces={marketplaces} zh={zh} scope={scope} projectId={props.projectId} busyKey={busyKey} onAdd={() => setMarketplaceOpen(true)} onMutate={mutate} client={props.client} /> : null}

      {installOpen || marketplaceOpen ? (
        <SourceDialog
          title={marketplaceOpen ? (zh ? '添加 Marketplace' : 'Add marketplace') : zh ? '安装 Plugin' : 'Install plugin'}
          zh={zh}
          source={source}
          scope={scope}
          projectAvailable={Boolean(props.projectId)}
          busy={busyKey === 'install' || busyKey === 'marketplace-add'}
          onSource={setSource}
          onScope={setScope}
          onChoosePath={chooseLocalPath}
          onClose={() => {
            if (busyKey) return;
            setInstallOpen(false);
            setMarketplaceOpen(false);
            setSource(emptySource());
          }}
          onSubmit={marketplaceOpen ? addMarketplace : install}
        />
      ) : null}
    </section>
  );
}

function PluginCatalog(props: {
  plugins: PluginDescriptor[];
  client: ExtensionsClient | null;
  zh: boolean;
  busyKey: string | null;
  expanded: string | null;
  onExpanded(value: string | null): void;
  onInstall(): void;
  onMutate(key: string, operation: () => Promise<unknown>): Promise<boolean>;
}) {
  return (
    <section className="skills-catalog extension-catalog" aria-label={props.zh ? 'Plugin 目录' : 'Plugin catalog'}>
      <div className="skills-section-heading">
        <div>
          <h2>{props.zh ? '已安装 Plugin' : 'Installed plugins'}</h2>
          <p>{props.zh ? '启停与更新只影响之后创建的会话；活动会话继续使用已冻结修订。' : 'Enable, disable, and update affect only later conversations; active conversations retain their frozen revision.'}</p>
        </div>
        <Button variant="primary" size="regular" onClick={props.onInstall} disabled={!props.client || Boolean(props.busyKey)}>
          <Plus aria-hidden="true" /> {props.zh ? '安装 Plugin' : 'Install plugin'}
        </Button>
      </div>
      {props.plugins.length === 0 ? <div className="skills-empty-state">{props.zh ? '尚未安装 Plugin。' : 'No plugins installed.'}</div> : null}
      <div className="extension-plugin-list">
        {props.plugins.map((descriptor) => {
          const plugin = descriptor.plugin;
          const revision = descriptor.revision;
          const open = props.expanded === plugin.id;
          const untrusted = descriptor.hooks.filter((hook) => hook.enabled && hook.trustedDefinitionSha256 !== hook.definitionSha256).length;
          return (
            <article key={plugin.id} className="extension-plugin-card" data-enabled={plugin.enabled ? 'true' : 'false'}>
              <header>
                <button type="button" className="extension-plugin-summary" aria-expanded={open} onClick={() => props.onExpanded(open ? null : plugin.id)}>
                  <span className="skill-list-glyph" aria-hidden="true">
                    {plugin.displayName.slice(0, 1).toLocaleUpperCase()}
                  </span>
                  <span>
                    <strong>{plugin.displayName}</strong>
                    <small>
                      @{plugin.name} · {revision.version} · {plugin.scope === 'personal' ? (props.zh ? '个人' : 'Personal') : props.zh ? '项目' : 'Project'}
                    </small>
                  </span>
                </button>
                <span className="extension-statuses">
                  {descriptor.providerLegacyConflict ? <em className="is-danger">Provider legacy</em> : null}
                  {untrusted ? (
                    <em className="is-warning">
                      <Warning aria-hidden="true" /> {untrusted} {props.zh ? '项待审查' : 'to review'}
                    </em>
                  ) : null}
                  <em>{connectionLabel(plugin.connectionState, props.zh)}</em>
                </span>
                <Button
                  variant="secondary"
                  size="compact"
                  busy={props.busyKey === `enable:${plugin.id}`}
                  disabled={Boolean(props.busyKey) || descriptor.providerLegacyConflict}
                  onClick={() => void props.onMutate(`enable:${plugin.id}`, () => props.client!.setPluginEnabled(plugin.id, !plugin.enabled, plugin.revision))}
                >
                  {plugin.enabled ? (props.zh ? '停用' : 'Disable') : props.zh ? '启用' : 'Enable'}
                </Button>
              </header>
              {open ? (
                <div className="extension-plugin-detail">
                  <p>{plugin.description || (props.zh ? '无描述' : 'No description')}</p>
                  <dl>
                    <div>
                      <dt>SHA-256</dt>
                      <dd>
                        <code>{revision.contentSha256}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{props.zh ? '来源' : 'Source'}</dt>
                      <dd>
                        {plugin.sourceKind} · <code>{plugin.sourceLocator}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{props.zh ? '组件' : 'Components'}</dt>
                      <dd>
                        {revision.components.skills.length} Skill · {revision.components.hooks.length} Hook · {revision.components.mcpServers.length} MCP · {revision.components.apps.length} Connector
                      </dd>
                    </div>
                  </dl>
                  <HookReview descriptor={descriptor} {...props} />
                  <McpPolicyPanel descriptor={descriptor} {...props} />
                  <ConnectorPanel descriptor={descriptor} {...props} />
                  <footer>
                    <Button
                      variant="secondary"
                      size="compact"
                      busy={props.busyKey === `update:${plugin.id}`}
                      disabled={Boolean(props.busyKey)}
                      onClick={() => void props.onMutate(`update:${plugin.id}`, () => props.client!.updatePlugin(plugin.id))}
                    >
                      <ArrowClockwise aria-hidden="true" /> {props.zh ? '更新' : 'Update'}
                    </Button>
                    <Button
                      variant="danger"
                      size="compact"
                      busy={props.busyKey === `remove:${plugin.id}`}
                      disabled={Boolean(props.busyKey)}
                      onClick={() => {
                        if (
                          !window.confirm(
                            props.zh
                              ? `卸载 Plugin“${plugin.displayName}”？活动会话引用的旧修订会保留，Connector 授权不会自动删除。`
                              : `Uninstall “${plugin.displayName}”? Revisions used by active conversations and connector authorization are retained.`,
                          )
                        )
                          return;
                        void props.onMutate(`remove:${plugin.id}`, () => props.client!.removePlugin(plugin.id, plugin.revision));
                      }}
                    >
                      <Trash aria-hidden="true" /> {props.zh ? '卸载' : 'Uninstall'}
                    </Button>
                  </footer>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function HookReview(props: { descriptor: PluginDescriptor; client: ExtensionsClient | null; zh: boolean; busyKey: string | null; onMutate(key: string, operation: () => Promise<unknown>): Promise<boolean> }) {
  if (!props.descriptor.hooks.length) return null;
  const definitions = new Map(props.descriptor.revision.components.hooks.map((hook) => [hook.id, hook]));
  return (
    <section className="extension-component-section">
      <h3>
        <ShieldCheck aria-hidden="true" /> {props.zh ? 'Hook 审查' : 'Hook review'}
      </h3>
      {props.descriptor.hooks.map((trust) => {
        const definition = definitions.get(trust.hookId);
        const trusted = trust.trustedDefinitionSha256 === trust.definitionSha256;
        return (
          <div key={trust.hookId} className="extension-component-row">
            <span>
              <strong>{definition?.event ?? trust.hookId}</strong>
              <small>
                {definition?.matcher || '*'} · <code>{trust.definitionSha256.slice(0, 12)}</code>
              </small>
            </span>
            <span>
              <Button
                variant="secondary"
                size="compact"
                disabled={Boolean(props.busyKey)}
                onClick={() => void props.onMutate(`hook-enable:${trust.hookId}`, () => props.client!.setPluginHookEnabled(props.descriptor.plugin.id, props.descriptor.revision.id, trust.hookId, !trust.enabled))}
              >
                {trust.enabled ? (props.zh ? '禁用' : 'Disable') : props.zh ? '启用' : 'Enable'}
              </Button>
              <Button
                variant={trusted ? 'secondary' : 'primary'}
                size="compact"
                disabled={Boolean(props.busyKey) || !trust.enabled}
                onClick={() => void props.onMutate(`hook-trust:${trust.hookId}`, () => props.client!.trustPluginHook(props.descriptor.plugin.id, props.descriptor.revision.id, trust.hookId, !trusted))}
              >
                {trusted ? (props.zh ? '撤销信任' : 'Revoke trust') : props.zh ? '信任此定义' : 'Trust definition'}
              </Button>
            </span>
          </div>
        );
      })}
    </section>
  );
}

function McpPolicyPanel(props: { descriptor: PluginDescriptor; client: ExtensionsClient | null; zh: boolean; busyKey: string | null; onMutate(key: string, operation: () => Promise<unknown>): Promise<boolean> }) {
  if (!props.descriptor.revision.components.mcpServers.length) return null;
  return (
    <section className="extension-component-section">
      <h3>MCP {props.zh ? '工具权限' : 'tool permissions'}</h3>
      {props.descriptor.revision.components.mcpServers.map((server) => {
        const policy = props.descriptor.mcpPolicies.find((candidate) => candidate.serverId === server.id && candidate.toolName === '*');
        const mode = policy?.approvalMode ?? 'prompt';
        const enabled = policy?.enabled ?? true;
        const update = (nextMode: PluginApprovalMode, nextEnabled = enabled) =>
          props.onMutate(`mcp:${server.id}`, () => props.client!.setPluginMcpPolicy(props.descriptor.plugin.id, server.id, { toolName: '*', enabled: nextEnabled, approvalMode: nextMode }));
        return (
          <div key={server.id} className="extension-component-row">
            <span>
              <strong>{server.name}</strong>
              <small>
                {server.transport} · {props.zh ? '单工具覆盖可通过 API 设置' : 'Per-tool overrides are available through the API'}
              </small>
            </span>
            <span>
              <label>
                <input type="checkbox" checked={enabled} disabled={Boolean(props.busyKey)} onChange={(event) => void update(mode, event.currentTarget.checked)} /> {props.zh ? '启用' : 'Enabled'}
              </label>
              <select value={mode} disabled={Boolean(props.busyKey)} onChange={(event) => void update(event.currentTarget.value as PluginApprovalMode)}>
                <option value="prompt">{props.zh ? '每次询问' : 'Prompt'}</option>
                <option value="approve">{props.zh ? '允许' : 'Allow'}</option>
                <option value="deny">{props.zh ? '拒绝' : 'Deny'}</option>
              </select>
            </span>
          </div>
        );
      })}
    </section>
  );
}

function ConnectorPanel(props: { descriptor: PluginDescriptor; client: ExtensionsClient | null; zh: boolean; busyKey: string | null; onMutate(key: string, operation: () => Promise<unknown>): Promise<boolean> }) {
  if (!props.descriptor.revision.components.apps.length) return null;
  return (
    <section className="extension-component-section">
      <h3>Connector</h3>
      {props.descriptor.revision.components.apps.map((app) => {
        const binding = props.descriptor.connectors.find((candidate) => candidate.appTechnicalId === app.technicalId);
        return (
          <div key={app.id} className="extension-component-row">
            <span>
              <strong>{app.name}</strong>
              <small>
                {binding?.connected ? (props.zh ? '已连接' : 'Connected') : props.zh ? '需要连接' : 'Connection required'} · <code>{app.technicalId}</code>
              </small>
            </span>
            <span>
              <Button
                variant="secondary"
                size="compact"
                disabled={Boolean(props.busyKey)}
                onClick={() => {
                  const connectorId = window.prompt(props.zh ? 'Connector ID' : 'Connector ID', binding?.connectorId ?? app.id)?.trim();
                  if (!connectorId) return;
                  const raw = window.prompt(props.zh ? '输入 MCP Server JSON（command/args 或 url/headers）' : 'Enter MCP server JSON (command/args or url/headers)', binding ? JSON.stringify(binding.serverConfig) : '{"url":"https://"}');
                  if (!raw) return;
                  let serverConfig: Record<string, unknown>;
                  try {
                    serverConfig = JSON.parse(raw) as Record<string, unknown>;
                  } catch {
                    window.alert(props.zh ? 'JSON 无效。' : 'Invalid JSON.');
                    return;
                  }
                  const secret = window.prompt(props.zh ? '可选：Bearer 密钥（只写入 Keychain）' : 'Optional bearer secret (stored only in Keychain)') ?? undefined;
                  void props.onMutate(`connector:${connectorId}`, () =>
                    props.client!.bindPluginConnector(props.descriptor.plugin.id, connectorId, { appTechnicalId: app.technicalId, serverConfig, ...(secret ? { secret } : {}), connected: true }),
                  );
                }}
              >
                {binding?.connected ? (props.zh ? '重新绑定' : 'Rebind') : props.zh ? '绑定连接' : 'Bind connection'}
              </Button>
              {binding ? (
                <Button
                  variant="danger"
                  size="compact"
                  disabled={Boolean(props.busyKey)}
                  onClick={() => void props.onMutate(`connector-revoke:${binding.connectorId}`, () => props.client!.revokePluginConnectorAuthorization(binding.connectorId))}
                >
                  {props.zh ? '撤销授权' : 'Revoke auth'}
                </Button>
              ) : null}
            </span>
          </div>
        );
      })}
    </section>
  );
}

function MarketplaceCatalog(props: {
  marketplaces: PluginMarketplaceCatalog[];
  client: ExtensionsClient | null;
  zh: boolean;
  scope: PluginScope;
  projectId?: string | null;
  busyKey: string | null;
  onAdd(): void;
  onMutate(key: string, operation: () => Promise<unknown>): Promise<boolean>;
}) {
  return (
    <section className="skills-catalog extension-catalog">
      <div className="skills-section-heading">
        <div>
          <h2>Marketplace</h2>
          <p>{props.zh ? '仅读取用户明确添加的本地或 Git marketplace.json，不代理官方公共目录。' : 'Only explicit local or Git marketplace.json sources are read; public catalogs are not proxied.'}</p>
        </div>
        <Button variant="primary" size="regular" onClick={props.onAdd} disabled={!props.client || Boolean(props.busyKey)}>
          <Plus aria-hidden="true" /> {props.zh ? '添加来源' : 'Add source'}
        </Button>
      </div>
      {props.marketplaces.map((catalog) => (
        <article key={catalog.marketplace.id} className="extension-marketplace-card">
          <header>
            <span>
              <strong>{catalog.displayName}</strong>
              <small>
                {catalog.marketplace.sourceKind} · {catalog.marketplace.sourceLocator}
              </small>
            </span>
            <span>
              <Button
                variant="secondary"
                size="compact"
                disabled={Boolean(props.busyKey)}
                onClick={() => void props.onMutate(`market-refresh:${catalog.marketplace.id}`, () => props.client!.refreshPluginMarketplace(catalog.marketplace.id))}
              >
                <ArrowClockwise aria-hidden="true" /> {props.zh ? '刷新' : 'Refresh'}
              </Button>
              <Button variant="danger" size="compact" disabled={Boolean(props.busyKey)} onClick={() => void props.onMutate(`market-remove:${catalog.marketplace.id}`, () => props.client!.removePluginMarketplace(catalog.marketplace.id))}>
                <Trash aria-hidden="true" />
              </Button>
            </span>
          </header>
          <div>
            {catalog.entries.map((entry) => (
              <div key={entry.name} className="extension-component-row">
                <span>
                  <strong>{entry.name}</strong>
                  <small>
                    {entry.description} {entry.version ? `· ${entry.version}` : ''}
                  </small>
                </span>
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={Boolean(props.busyKey)}
                  onClick={() =>
                    void props.onMutate(`market-install:${catalog.marketplace.id}:${entry.name}`, () =>
                      props.client!.installPlugin({ scope: catalog.marketplace.scope, projectId: catalog.marketplace.projectId, source: { kind: 'marketplace', marketplaceId: catalog.marketplace.id, pluginName: entry.name } }),
                    )
                  }
                >
                  {props.zh ? '安装' : 'Install'}
                </Button>
              </div>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

function SourceDialog(props: {
  title: string;
  zh: boolean;
  source: SourceDraft;
  scope: PluginScope;
  projectAvailable: boolean;
  busy: boolean;
  onSource(value: SourceDraft): void;
  onScope(value: PluginScope): void;
  onChoosePath(): Promise<void>;
  onClose(): void;
  onSubmit(event: FormEvent): Promise<void>;
}) {
  const valid = props.scope === 'personal' || props.projectAvailable;
  return (
    <ModalPortal rootClassName="skill-install-portal-root" backdropClassName="skill-install-backdrop" dismissDisabled={props.busy} onDismiss={props.onClose}>
      <form className="skill-install-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" onSubmit={(event) => void props.onSubmit(event)}>
        <header>
          <div>
            <span>ZEUS PLUGIN</span>
            <h2>{props.title}</h2>
          </div>
          <button type="button" onClick={props.onClose} disabled={props.busy} aria-label={props.zh ? '关闭' : 'Close'}>
            ×
          </button>
        </header>
        <div className="skill-install-source-tabs">
          <button type="button" className={props.source.kind === 'local' ? 'is-active' : ''} onClick={() => props.onSource({ ...props.source, kind: 'local' })}>
            {props.zh ? '本地目录' : 'Local directory'}
          </button>
          <button type="button" className={props.source.kind === 'git' ? 'is-active' : ''} onClick={() => props.onSource({ ...props.source, kind: 'git' })}>
            Git
          </button>
        </div>
        <div className="skill-install-fields">
          <label>
            <span>{props.zh ? '作用域' : 'Scope'}</span>
            <select value={props.scope} onChange={(event) => props.onScope(event.currentTarget.value as PluginScope)}>
              <option value="personal">{props.zh ? '个人' : 'Personal'}</option>
              <option value="project" disabled={!props.projectAvailable}>
                {props.zh ? '当前项目' : 'Current project'}
              </option>
            </select>
          </label>
          {props.source.kind === 'local' ? (
            <label>
              <span>{props.zh ? 'Plugin 目录' : 'Plugin directory'}</span>
              <span className="skill-install-path-control">
                <input value={props.source.path} onChange={(event) => props.onSource({ ...props.source, path: event.currentTarget.value })} required />
                <Button variant="secondary" size="compact" type="button" onClick={() => void props.onChoosePath()}>
                  {props.zh ? '选择' : 'Choose'}
                </Button>
              </span>
            </label>
          ) : (
            <div className="skill-install-grid">
              <label>
                <span>Git URL</span>
                <input value={props.source.repositoryUrl} onChange={(event) => props.onSource({ ...props.source, repositoryUrl: event.currentTarget.value })} required />
              </label>
              <label>
                <span>Ref</span>
                <input value={props.source.ref} onChange={(event) => props.onSource({ ...props.source, ref: event.currentTarget.value })} />
              </label>
              <label>
                <span>{props.zh ? '子目录' : 'Subdirectory'}</span>
                <input value={props.source.subdirectory} onChange={(event) => props.onSource({ ...props.source, subdirectory: event.currentTarget.value })} />
              </label>
            </div>
          )}
        </div>
        <footer>
          <Button variant="secondary" size="regular" type="button" onClick={props.onClose} disabled={props.busy}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button variant="primary" size="regular" type="submit" busy={props.busy} disabled={!valid}>
            {props.zh ? '确认' : 'Confirm'}
          </Button>
        </footer>
      </form>
    </ModalPortal>
  );
}

function tabLabel(tab: Tab, zh: boolean): string {
  if (tab === 'plugins') return 'Plugin';
  if (tab === 'marketplaces') return 'Marketplace';
  return zh ? 'Skill' : 'Skills';
}

function connectionLabel(state: PluginDescriptor['plugin']['connectionState'], zh: boolean): string {
  if (state === 'ready') return zh ? '已就绪' : 'Ready';
  if (state === 'needs_connection') return zh ? '需要连接' : 'Connection required';
  return zh ? '不兼容' : 'Incompatible';
}

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
