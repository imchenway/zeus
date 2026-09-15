import { MotionPresence } from '../toolPageHost.js';
import { Collapsible } from '../toolPageHost.js';
import { FormDialog } from '../toolPageHost.js';
import { reportApplicationError } from '../toolPageHost.js';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { WarningIcon as Warning } from '@phosphor-icons/react/dist/csr/Warning';
import type { PluginApprovalMode, PluginDescriptor, PluginDirectSource, PluginInstallSource, PluginMarketplaceCatalog, PluginScope } from '../toolPageHost.js';
import type { NativeConversationAppClient } from '../toolPageHost.js';
import { Button } from '../toolPageHost.js';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { ZeusSelect } from '../toolPageHost.js';
import { ExtensionSourceFields, emptyExtensionSource, type ExtensionSourceDraft } from './ExtensionSourceFields.js';
import { ZeusApiError } from '../toolPageHost.js';
import { SkillsWorkspace } from './SkillsWorkspace.js';
import { skillCatalogChangedEvent } from '../toolPageHost.js';

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

/** 扩展管理统一承载插件、技能、来源目录及操作状态。 */
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
  /** 安装插件与添加来源使用同一份表单草稿。 */
  const [source, setSource] = useState<ExtensionSourceDraft>(emptyExtensionSource);
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
      setError(message(reason, zh ? 'zh-CN' : 'en'));
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
      setError(message(reason, zh ? 'zh-CN' : 'en'));
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  /** 仅接收系统目录选择器返回的路径。 */
  async function chooseLocalPath(): Promise<void> {
    const path = await props.onChooseDirectory?.();
    if (path) setSource((current) => ({ ...current, path }));
  }

  /** 将表单转换为服务支持的来源，空的可选字段不发送。 */
  function directSource(): PluginDirectSource {
    if (source.kind === 'local') return { kind: 'local', path: source.path.trim() };
    return {
      kind: 'git',
      repositoryUrl: source.repositoryUrl.trim(),
      ...(source.ref.trim() ? { ref: source.ref.trim() } : {}),
      ...(source.subdirectory.trim() ? { subdirectory: source.subdirectory.trim() } : {}),
    };
  }

  /** 市场来源进入已有条目选择列表，不擅自安装其中全部插件。 */
  async function install(event: FormEvent): Promise<void> {
    event.preventDefault();
    const installSource: PluginInstallSource = directSource();
    const succeeded = await mutate('install', async () => {
      try {
        await props.client!.installPlugin({ scope, projectId: scope === 'project' ? props.projectId : null, source: installSource });
      } catch (reason) {
        if (!(reason instanceof ZeusApiError) || reason.error !== 'ZEUS_PLUGIN_SOURCE_IS_MARKETPLACE') throw reason;
        await props.client!.addPluginMarketplace({ scope, projectId: scope === 'project' ? props.projectId : null, source: installSource });
        setTab('marketplaces');
      }
    });
    if (succeeded) {
      setInstallOpen(false);
      setSource(emptyExtensionSource());
    }
  }

  /** 来源添加成功后关闭表单并清空已提交草稿。 */
  async function addMarketplace(event: FormEvent): Promise<void> {
    event.preventDefault();
    const succeeded = await mutate('marketplace-add', () => props.client!.addPluginMarketplace({ scope, projectId: scope === 'project' ? props.projectId : null, source: directSource() }));
    if (succeeded) {
      setMarketplaceOpen(false);
      setSource(emptyExtensionSource());
    }
  }

  return (
    <section className="workspace-view skills-workspace extensions-workspace" aria-label={zh ? '扩展管理' : 'Extension management'}>
      <header className="skills-workspace-header">
        <div className="skills-workspace-title-row">
          <div>
            <h1>{zh ? '扩展管理' : 'Extension management'}</h1>
            <p>{zh ? '管理插件、技能和来源。更改用于新对话，进行中的对话保持原配置。' : 'Install and manage plugins here. Changes apply to conversations created afterward.'}</p>
          </div>
          {tab !== 'skills' ? (
            <Button variant="secondary" size="regular" busy={busyKey === 'load'} onClick={() => void load()} disabled={!props.client || Boolean(busyKey)}>
              <ArrowClockwise aria-hidden="true" /> {zh ? '刷新' : 'Refresh'}
            </Button>
          ) : null}
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
      {tab === 'marketplaces' ? <MarketplaceCatalog marketplaces={marketplaces} plugins={plugins} zh={zh} busyKey={busyKey} onAdd={() => setMarketplaceOpen(true)} onMutate={mutate} client={props.client} /> : null}

      <MotionPresence>
        {installOpen || marketplaceOpen ? (
          <SourceDialog
            title={marketplaceOpen ? (zh ? '添加插件市场' : 'Add marketplace') : zh ? '安装插件' : 'Install plugin'}
            submitLabel={marketplaceOpen ? (zh ? '添加' : 'Add') : zh ? '安装' : 'Install'}
            zh={zh}
            source={source}
            scope={scope}
            projectAvailable={Boolean(props.projectId)}
            busy={busyKey === 'install' || busyKey === 'marketplace-add'}
            onSource={setSource}
            onScope={setScope}
            onChoosePath={props.onChooseDirectory ? chooseLocalPath : undefined}
            onClose={() => {
              if (busyKey) return;
              setInstallOpen(false);
              setMarketplaceOpen(false);
              setSource(emptyExtensionSource());
            }}
            onSubmit={marketplaceOpen ? addMarketplace : install}
          />
        ) : null}
      </MotionPresence>
    </section>
  );
}

/** 插件列表展开权限与单个卸载操作，来源细节按需查看。 */
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
  /** 用户选中的卸载对象，确认前保留安装记录。 */
  const [pendingRemoval, setPendingRemoval] = useState<PluginDescriptor | null>(null);
  return (
    <section className="skills-catalog extension-catalog" aria-label={props.zh ? '插件目录' : 'Plugin catalog'}>
      <div className="skills-section-heading">
        <div>
          <h2>{props.zh ? '已安装插件' : 'Installed plugins'}</h2>
          <p>{props.zh ? '展开插件查看组件、权限和卸载操作。' : 'Expand a plugin to manage components, permissions, or uninstall it.'}</p>
        </div>
        <Button variant="primary" size="regular" onClick={props.onInstall} disabled={!props.client || Boolean(props.busyKey)}>
          <Plus aria-hidden="true" /> {props.zh ? '安装插件' : 'Install plugin'}
        </Button>
      </div>
      {props.plugins.length === 0 ? <div className="skills-empty-state">{props.zh ? '尚未安装插件。可以从本地目录或 Git 仓库安装。' : 'No plugins installed.'}</div> : null}
      <div className="extension-plugin-list">
        {props.plugins.map((descriptor) => {
          const plugin = descriptor.plugin;
          const revision = descriptor.revision;
          const open = props.expanded === plugin.id;
          const untrusted = descriptor.hooks.filter((hook) => hook.enabled && hook.trustedDefinitionSha256 !== hook.definitionSha256).length;
          return (
            <article key={plugin.id} className="extension-plugin-row" data-enabled={plugin.enabled ? 'true' : 'false'}>
              <header>
                <button type="button" className="extension-plugin-summary" aria-expanded={open} onClick={() => props.onExpanded(open ? null : plugin.id)}>
                  <CaretRight className="extension-expand-icon" aria-hidden="true" />
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
                  {descriptor.providerLegacyConflict ? <em className="is-danger">{props.zh ? '旧版配置冲突' : 'Legacy configuration conflict'}</em> : null}
                  {untrusted ? (
                    <em className="is-warning">
                      <Warning aria-hidden="true" /> {untrusted} {props.zh ? '项待审查' : 'to review'}
                    </em>
                  ) : null}
                  <em>{plugin.enabled ? connectionLabel(plugin.connectionState, props.zh) : props.zh ? '已停用' : 'Disabled'}</em>
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
              <Collapsible open={open}>
                <div className="extension-plugin-detail">
                  <p>{plugin.description || (props.zh ? '无描述' : 'No description')}</p>
                  <details className="extension-source-details">
                    <summary>{props.zh ? '来源与组件信息' : 'Source and components'}</summary>
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
                  </details>
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
                    <Button variant="danger" size="compact" busy={props.busyKey === `remove:${plugin.id}`} disabled={Boolean(props.busyKey)} onClick={() => setPendingRemoval(descriptor)}>
                      <Trash aria-hidden="true" /> {props.zh ? '卸载' : 'Uninstall'}
                    </Button>
                  </footer>
                </div>
              </Collapsible>
            </article>
          );
        })}
      </div>
      <MotionPresence>
        {pendingRemoval ? (
          <FormDialog
            title={props.zh ? `卸载“${pendingRemoval.plugin.displayName}”？` : `Uninstall “${pendingRemoval.plugin.displayName}”?`}
            description={
              props.zh
                ? '进行中的对话仍可使用当前版本。已连接应用的授权会保留，需要另外撤销；插件以后可以重新安装。'
                : 'Active conversations keep their current version. Connected app authorizations remain and must be revoked separately. You can reinstall later.'
            }
            zh={props.zh}
            busy={Boolean(props.busyKey)}
            danger
            submitLabel={props.zh ? '卸载' : 'Uninstall'}
            onClose={() => setPendingRemoval(null)}
            onSubmit={(event) => {
              event.preventDefault();
              void props
                .onMutate(`remove:${pendingRemoval.plugin.id}`, () => props.client!.removePlugin(pendingRemoval.plugin.id, pendingRemoval.plugin.revision))
                .then((removed) => {
                  if (removed) setPendingRemoval(null);
                });
            }}
          />
        ) : null}
      </MotionPresence>
    </section>
  );
}

/** 展示脚本定义的信任状态与逐项控制。 */
function HookReview(props: { descriptor: PluginDescriptor; client: ExtensionsClient | null; zh: boolean; busyKey: string | null; onMutate(key: string, operation: () => Promise<unknown>): Promise<boolean> }) {
  if (!props.descriptor.hooks.length) return null;
  const definitions = new Map(props.descriptor.revision.components.hooks.map((hook) => [hook.id, hook]));
  return (
    <section className="extension-component-section">
      <h3>
        <ShieldCheck aria-hidden="true" /> {props.zh ? '自动执行脚本审查（Hook）' : 'Automatic script review (hooks)'}
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

/** 工具权限复用全局选择控件并写回现有策略接口。 */
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
              <small>{props.zh ? '适用于此服务的所有工具' : 'Applies to all tools from this server'}</small>
            </span>
            <span>
              <label>
                <input type="checkbox" checked={enabled} disabled={Boolean(props.busyKey)} onChange={(event) => void update(mode, event.currentTarget.checked)} /> {props.zh ? '启用' : 'Enabled'}
              </label>
              <ZeusSelect
                ariaLabel={`${server.name} ${props.zh ? '工具权限' : 'tool permissions'}`}
                size="regular"
                value={mode}
                disabled={Boolean(props.busyKey)}
                onChange={(value) => void update(value)}
                options={[
                  { value: 'prompt', label: props.zh ? '每次询问' : 'Prompt' },
                  { value: 'approve', label: props.zh ? '允许' : 'Allow' },
                  { value: 'deny', label: props.zh ? '拒绝' : 'Deny' },
                ]}
              />
            </span>
          </div>
        );
      })}
    </section>
  );
}

/** 管理插件声明的应用连接，表单保留失败时的输入。 */
function ConnectorPanel(props: { descriptor: PluginDescriptor; client: ExtensionsClient | null; zh: boolean; busyKey: string | null; onMutate(key: string, operation: () => Promise<unknown>): Promise<boolean> }) {
  /** 当前编辑的应用，关闭后销毁包含密钥的草稿。 */
  const [editing, setEditing] = useState<PluginDescriptor['revision']['components']['apps'][number] | null>(null);
  if (!props.descriptor.revision.components.apps.length) return null;
  return (
    <section className="extension-component-section">
      <h3>{props.zh ? '应用连接' : 'App connections'}</h3>
      {props.descriptor.revision.components.apps.map((app) => {
        /** 当前应用已经保存的连接。 */
        const binding = props.descriptor.connectors.find((candidate) => candidate.appTechnicalId === app.technicalId);
        return (
          <div key={app.id} className="extension-component-row">
            <span>
              <strong>{app.name}</strong>
              <small>{binding?.connected ? (props.zh ? '已连接' : 'Connected') : props.zh ? '需要连接' : 'Connection required'}</small>
            </span>
            <span>
              <Button size="compact" disabled={Boolean(props.busyKey)} onClick={() => setEditing(app)}>
                {binding?.connected ? (props.zh ? '编辑连接' : 'Edit connection') : props.zh ? '连接' : 'Connect'}
              </Button>
              {binding ? (
                <Button
                  variant="danger"
                  size="compact"
                  disabled={Boolean(props.busyKey)}
                  onClick={() => void props.onMutate(`connector-revoke:${binding.connectorId}`, () => props.client!.revokePluginConnectorAuthorization(binding.connectorId))}
                >
                  {props.zh ? '撤销授权' : 'Revoke authorization'}
                </Button>
              ) : null}
            </span>
          </div>
        );
      })}
      <MotionPresence>{editing ? <ConnectorDialog {...props} app={editing} onClose={() => setEditing(null)} /> : null}</MotionPresence>
    </section>
  );
}

/** 连接配置只接受 JSON 对象，密钥使用密码输入且不回填已保存的密钥。 */
function ConnectorDialog(props: {
  descriptor: PluginDescriptor;
  app: PluginDescriptor['revision']['components']['apps'][number];
  client: ExtensionsClient | null;
  zh: boolean;
  busyKey: string | null;
  onClose(): void;
  onMutate(key: string, operation: () => Promise<unknown>): Promise<boolean>;
}) {
  /** 当前应用的已保存配置，不读取钥匙串。 */
  const binding = props.descriptor.connectors.find((candidate) => candidate.appTechnicalId === props.app.technicalId);
  /** 连接标识保持可编辑，以沿用既有连接管理能力。 */
  const [connectorId, setConnectorId] = useState(binding?.connectorId ?? props.app.id);
  /** 原始配置保留换行，解析失败不丢失用户输入。 */
  const [config, setConfig] = useState(JSON.stringify(binding?.serverConfig ?? { url: 'https://' }, null, 2));
  /** 新输入的密钥仅保存在当前弹窗内。 */
  const [secret, setSecret] = useState('');
  /** 本地格式错误就地提示，无需再弹一个系统对话框。 */
  const [error, setError] = useState<string | null>(null);
  /** 校验格式后交给已有连接服务处理权限和密钥持久化。 */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (props.busyKey || !connectorId.trim()) return;
    /** 只允许对象作为服务配置，拒绝空值、数组和标量。 */
    let serverConfig: Record<string, unknown>;
    try {
      serverConfig = JSON.parse(config) as Record<string, unknown>;
      if (!serverConfig || typeof serverConfig !== 'object' || Array.isArray(serverConfig)) throw new Error('invalid');
    } catch {
      setError(props.zh ? '配置需要是 JSON 对象，请检查括号、引号和逗号。' : 'Configuration must be a JSON object. Check brackets, quotes, and commas.');
      return;
    }
    setError(null);
    if (
      await props.onMutate(`connector:${connectorId.trim()}`, () =>
        props.client!.bindPluginConnector(props.descriptor.plugin.id, connectorId.trim(), { appTechnicalId: props.app.technicalId, serverConfig, ...(secret ? { secret } : {}), connected: true }),
      )
    )
      props.onClose();
  }
  return (
    <FormDialog
      title={props.zh ? `连接 ${props.app.name}` : `Connect ${props.app.name}`}
      description={props.zh ? '填写服务提供的连接配置。' : 'Enter the connection configuration supplied by the service.'}
      zh={props.zh}
      busy={Boolean(props.busyKey)}
      submitLabel={props.zh ? '保存连接' : 'Save connection'}
      submitDisabled={!connectorId.trim() || !config.trim()}
      onClose={props.onClose}
      onSubmit={(event) => void submit(event)}
    >
      <label>
        <span>{props.zh ? '连接标识' : 'Connection ID'}</span>
        <input value={connectorId} onChange={(event) => setConnectorId(event.currentTarget.value)} required />
      </label>
      <label>
        <span>{props.zh ? '服务配置（JSON）' : 'Server configuration (JSON)'}</span>
        <textarea
          className="extension-connector-config"
          value={config}
          onChange={(event) => setConfig(event.currentTarget.value)}
          rows={6}
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'extension-connector-error' : undefined}
          required
        />
      </label>
      <label>
        <span>{props.zh ? '访问密钥（可选）' : 'Access token (optional)'}</span>
        <input type="password" value={secret} onChange={(event) => setSecret(event.currentTarget.value)} autoComplete="new-password" />
        <small>{props.zh ? '密钥保存在 macOS 钥匙串中；留空保留已有密钥。' : 'Stored in macOS Keychain. Leave blank to keep the existing token.'}</small>
      </label>
      {error ? (
        <p id="extension-connector-error" className="skills-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </FormDialog>
  );
}

/** 市场条目直接读取已安装目录，安装、卸载和刷新后保持按钮状态一致。 */
function MarketplaceCatalog(props: {
  marketplaces: PluginMarketplaceCatalog[];
  plugins: PluginDescriptor[];
  client: ExtensionsClient | null;
  zh: boolean;
  busyKey: string | null;
  onAdd(): void;
  onMutate(key: string, operation: () => Promise<unknown>): Promise<boolean>;
}) {
  /** 删除市场只移除目录来源，保留已安装插件。 */
  const [pendingRemoval, setPendingRemoval] = useState<PluginMarketplaceCatalog | null>(null);
  return (
    <section className="skills-catalog extension-catalog">
      <div className="skills-section-heading">
        <div>
          <h2>{props.zh ? '插件市场' : 'Plugin marketplaces'}</h2>
          <p>{props.zh ? '添加来源，浏览并按需安装其中的插件。' : 'Add a marketplace.json catalog from a local folder or Git repository to browse and install its plugins.'}</p>
        </div>
        <Button variant="primary" size="regular" onClick={props.onAdd} disabled={!props.client || Boolean(props.busyKey)}>
          <Plus aria-hidden="true" /> {props.zh ? '添加来源' : 'Add source'}
        </Button>
      </div>
      {props.marketplaces.length === 0 ? <div className="skills-empty-state">{props.zh ? '尚未添加来源。添加一个插件市场后，即可选择插件安装。' : 'No sources yet. Add a marketplace to browse its plugins.'}</div> : null}
      {props.marketplaces.map((catalog) => (
        <article key={catalog.marketplace.id} className="extension-marketplace-source">
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
              <Button variant="danger" size="compact" disabled={Boolean(props.busyKey)} aria-label={props.zh ? `移除来源 ${catalog.displayName}` : `Remove source ${catalog.displayName}`} onClick={() => setPendingRemoval(catalog)}>
                <Trash aria-hidden="true" />
              </Button>
            </span>
          </header>
          <div>
            {catalog.entries.map((entry) => {
              /** 按市场、条目及作用域识别安装，其他来源的同名插件不影响此按钮。 */
              const installed = props.plugins.some(
                ({ plugin }) =>
                  plugin.sourceKind === 'marketplace' && plugin.marketplaceId === catalog.marketplace.id && plugin.name === entry.name && plugin.scope === catalog.marketplace.scope && plugin.projectId === catalog.marketplace.projectId,
              );
              /** 与共用操作状态保持同一标识，明确反馈当前条目的安装进度。 */
              const installKey = `market-install:${catalog.marketplace.id}:${entry.name}`;
              /** 安装请求及目录刷新完成前，按钮持续显示进行中。 */
              const installing = props.busyKey === installKey;
              return (
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
                    busy={installing}
                    disabled={!props.client || Boolean(props.busyKey) || installed}
                    title={installed ? (props.zh ? '已安装，可在插件页管理。' : 'Installed. Manage it in the Plugin tab.') : undefined}
                    onClick={() =>
                      void props.onMutate(installKey, () =>
                        props.client!.installPlugin({ scope: catalog.marketplace.scope, projectId: catalog.marketplace.projectId, source: { kind: 'marketplace', marketplaceId: catalog.marketplace.id, pluginName: entry.name } }),
                      )
                    }
                  >
                    <span role="status">{installing ? (props.zh ? '安装中…' : 'Installing…') : installed ? (props.zh ? '已安装' : 'Installed') : props.zh ? '安装' : 'Install'}</span>
                  </Button>
                </div>
              );
            })}
          </div>
        </article>
      ))}
      <MotionPresence>
        {pendingRemoval ? (
          <FormDialog
            title={props.zh ? `移除来源“${pendingRemoval.displayName}”？` : `Remove source “${pendingRemoval.displayName}”?`}
            description={props.zh ? '已安装的插件会保留。之后可以重新添加此来源。' : 'Installed plugins are kept. You can add this source again later.'}
            zh={props.zh}
            busy={Boolean(props.busyKey)}
            danger
            submitLabel={props.zh ? '移除来源' : 'Remove source'}
            onClose={() => setPendingRemoval(null)}
            onSubmit={(event) => {
              event.preventDefault();
              void props
                .onMutate(`market-remove:${pendingRemoval.marketplace.id}`, () => props.client!.removePluginMarketplace(pendingRemoval.marketplace.id))
                .then((removed) => {
                  if (removed) setPendingRemoval(null);
                });
            }}
          />
        ) : null}
      </MotionPresence>
    </section>
  );
}

/** 插件与市场复用来源表单，作用范围沿用全局选择控件。 */
function SourceDialog(props: {
  title: string;
  submitLabel: string;
  zh: boolean;
  source: ExtensionSourceDraft;
  scope: PluginScope;
  projectAvailable: boolean;
  busy: boolean;
  onSource(value: ExtensionSourceDraft): void;
  onScope(value: PluginScope): void;
  onChoosePath?: () => Promise<void>;
  onClose(): void;
  onSubmit(event: FormEvent): Promise<void>;
}) {
  /** 必须同时具有有效作用范围和非空来源。 */
  const valid = (props.scope === 'personal' || props.projectAvailable) && Boolean(props.source.kind === 'local' ? props.source.path.trim() : props.source.repositoryUrl.trim());
  return (
    <FormDialog title={props.title} zh={props.zh} busy={props.busy} submitLabel={props.submitLabel} submitDisabled={!valid} onClose={props.onClose} onSubmit={(event) => void props.onSubmit(event)}>
      <ExtensionSourceFields source={props.source} zh={props.zh} busy={props.busy} localLabel={props.zh ? '来源目录' : 'Source directory'} onSource={props.onSource} onChoosePath={props.onChoosePath} />
      <div className="extension-form-field">
        <span>{props.zh ? '使用范围' : 'Available to'}</span>
        <ZeusSelect
          ariaLabel={props.zh ? '使用范围' : 'Available to'}
          size="regular"
          value={props.scope}
          disabled={props.busy}
          onChange={props.onScope}
          options={[
            { value: 'personal', label: props.zh ? '个人 · 所有项目可用' : 'Personal · all projects' },
            { value: 'project', label: props.zh ? '仅当前项目' : 'Current project only', disabled: !props.projectAvailable },
          ]}
        />
      </div>
    </FormDialog>
  );
}

/** 导航使用当前语言的产品名称。 */
function tabLabel(tab: Tab, zh: boolean): string {
  if (tab === 'plugins') return zh ? '插件' : 'Plugins';
  if (tab === 'marketplaces') return zh ? '插件市场' : 'Marketplaces';
  return zh ? '技能' : 'Skills';
}

/** 将连接状态转换为用户可理解的当前语言文案。 */
function connectionLabel(state: PluginDescriptor['plugin']['connectionState'], zh: boolean): string {
  if (state === 'ready') return zh ? '已就绪' : 'Ready';
  if (state === 'needs_connection') return zh ? '需要连接' : 'Connection required';
  return zh ? '不兼容' : 'Incompatible';
}

/** 显示当前语言的原因，并保留可展开的原始详情。 */
function message(error: unknown, language: 'zh-CN' | 'en'): string {
  return reportApplicationError(error, { language });
}
