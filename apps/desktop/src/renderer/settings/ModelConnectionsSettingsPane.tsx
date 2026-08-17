import { useEffect, useState } from 'react';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type {
  DashboardClient,
  ModelAuthenticationScheme,
  ModelCapabilityEvidence,
  ModelConnectionDiagnostic,
  ModelConnectionModel,
  ModelConnectionRecord,
  ModelConnectionTemplateId,
  ModelProtocolFamily,
  ModelThinkingFormat,
  SaveModelConnectionRequest,
} from '../apiClient.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';

interface ModelConnectionDraft extends SaveModelConnectionRequest {
  id: string | null;
  apiKey: string;
}

const templateDefaults: Record<ModelConnectionTemplateId, { name: string; baseUrl: string; modelsPath: string; thinkingFormat: ModelThinkingFormat }> = {
  custom: { name: '', baseUrl: '', modelsPath: '/models', thinkingFormat: 'openai' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelsPath: '/models', thinkingFormat: 'deepseek' },
  bailian: { name: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelsPath: '/models', thinkingFormat: 'qwen' },
  kimi: { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', modelsPath: '/models', thinkingFormat: 'openai' },
  zai: { name: 'Z.AI / GLM', baseUrl: 'https://api.z.ai/api/paas/v4', modelsPath: '/models', thinkingFormat: 'zai' },
};

type ModelConnectionClient = Pick<
  DashboardClient,
  'loadModelConnections' | 'createModelConnection' | 'updateModelConnection' | 'deleteModelConnection' | 'clearModelConnectionApiKey' | 'refreshModelConnectionModels' | 'diagnoseModelConnection'
>;

export function ModelConnectionsSettingsPane(props: { language: 'zh-CN' | 'en-US'; client: ModelConnectionClient | null }) {
  const zh = props.language === 'zh-CN';
  const [connections, setConnections] = useState<ModelConnectionRecord[]>([]);
  const [draft, setDraft] = useState<ModelConnectionDraft>(() => emptyDraft());
  const [newModelId, setNewModelId] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'refreshing' | 'deleting'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<ModelConnectionDiagnostic | null>(null);
  const [pendingInsecureHttpSave, setPendingInsecureHttpSave] = useState<SaveModelConnectionRequest | null>(null);

  useEffect(() => {
    let active = true;
    if (!props.client) {
      setStatus('idle');
      return () => {
        active = false;
      };
    }
    void props.client
      .loadModelConnections()
      .then((items) => {
        if (!active) return;
        setConnections(items);
        setStatus('idle');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setStatus('idle');
      });
    return () => {
      active = false;
    };
  }, [props.client]);

  const busy = status !== 'idle';
  const current = draft.id ? (connections.find((connection) => connection.id === draft.id) ?? null) : null;

  function selectConnection(connection: ModelConnectionRecord): void {
    setDraft({
      id: connection.id,
      name: connection.name,
      templateId: connection.templateId,
      baseUrl: connection.baseUrl,
      modelsPath: connection.modelsPath,
      enabled: connection.enabled,
      models: connection.models.map(cloneModel),
      apiKey: '',
    });
    setDiagnostic(null);
    setMessage(null);
  }

  function applyTemplate(templateId: ModelConnectionTemplateId): void {
    const template = templateDefaults[templateId];
    setDraft((value) => ({
      ...value,
      templateId,
      ...(templateId === 'custom' ? {} : { name: template.name, baseUrl: template.baseUrl, modelsPath: template.modelsPath }),
      models: value.models.map((model) => ({
        ...model,
        capability: {
          ...model.capability,
          reasoning: { ...model.capability.reasoning, thinkingFormat: template.thinkingFormat },
        },
      })),
    }));
  }

  function addManualModel(): void {
    const id = newModelId.trim();
    if (!id || draft.models.some((model) => model.id === id)) return;
    setDraft((value) => ({ ...value, models: [...value.models, createModel(id, templateDefaults[value.templateId].thinkingFormat)] }));
    setNewModelId('');
  }

  function updateModel(modelId: string, update: (model: ModelConnectionModel) => ModelConnectionModel): void {
    setDraft((value) => ({ ...value, models: value.models.map((model) => (model.id === modelId ? update(model) : model)) }));
  }

  async function reloadConnections(preferredId?: string): Promise<void> {
    if (!props.client) return;
    const items = await props.client.loadModelConnections();
    setConnections(items);
    const selected = items.find((connection) => connection.id === preferredId);
    if (selected) selectConnection(selected);
  }

  function createSaveInput(): SaveModelConnectionRequest {
    return {
      name: draft.name,
      templateId: draft.templateId,
      baseUrl: draft.baseUrl,
      modelsPath: draft.modelsPath,
      enabled: draft.enabled,
      models: draft.models,
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    };
  }

  async function persistConnection(input: SaveModelConnectionRequest): Promise<void> {
    if (!props.client || busy) return;
    setStatus('saving');
    setMessage(null);
    try {
      const saved = draft.id ? await props.client.updateModelConnection(draft.id, input) : await props.client.createModelConnection(input);
      await reloadConnections(saved.id);
      setDraft((value) => ({ ...value, id: saved.id, apiKey: '' }));
      setMessage(zh ? '供应商配置已保存。' : 'Provider saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setStatus('idle');
    }
  }

  async function save(): Promise<void> {
    const input = createSaveInput();
    if (requiresInsecureHttpConfirmation(input.baseUrl, current?.baseUrl)) {
      setPendingInsecureHttpSave(input);
      return;
    }
    await persistConnection(input);
  }

  async function refreshModels(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setStatus('refreshing');
    setMessage(null);
    try {
      const result = await props.client.refreshModelConnectionModels(draft.id);
      await reloadConnections(draft.id);
      setMessage(zh ? `发现 ${result.discoveredModelIds.length} 个模型，新增 ${result.addedModelIds.length} 个。` : `Discovered ${result.discoveredModelIds.length} models and added ${result.addedModelIds.length}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setStatus('idle');
    }
  }

  async function diagnose(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setStatus('loading');
    setMessage(null);
    try {
      setDiagnostic(await props.client.diagnoseModelConnection(draft.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setStatus('idle');
    }
  }

  async function clearApiKey(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setStatus('saving');
    try {
      await props.client.clearModelConnectionApiKey(draft.id);
      await reloadConnections(draft.id);
      setMessage(zh ? 'API Key 已从钥匙串清除。' : 'API key cleared from Keychain.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setStatus('idle');
    }
  }

  async function removeConnection(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setStatus('deleting');
    try {
      await props.client.deleteModelConnection(draft.id);
      const items = await props.client.loadModelConnections();
      setConnections(items);
      setDraft(emptyDraft());
      setDiagnostic(null);
      setMessage(zh ? '供应商已删除。' : 'Provider deleted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setStatus('idle');
    }
  }

  return (
    <section className="settings-product-pane model-connections-settings" aria-label={zh ? '模型供应商' : 'Model providers'}>
      <header className="settings-section-heading model-connections-heading">
        <span>
          <strong>{zh ? '模型供应商' : 'Model providers'}</strong>
          <small>{zh ? '配置供应商后，各项目可选择多个可运行模型。API Key 只保存到本机钥匙串。' : 'Configure providers once, then let each project select multiple runnable models. API keys stay in the local Keychain.'}</small>
        </span>
        <Button variant="secondary" size="compact" onClick={() => setDraft(emptyDraft())} disabled={busy}>
          {zh ? '新建供应商' : 'New provider'}
        </Button>
      </header>

      <div className="model-connections-layout">
        <nav className="model-connection-list" aria-label={zh ? '模型供应商列表' : 'Model provider list'}>
          {connections.length === 0 ? <p>{zh ? '还没有模型供应商。' : 'No model providers yet.'}</p> : null}
          {connections.map((connection) => (
            <button key={connection.id} type="button" className={draft.id === connection.id ? 'selected' : ''} aria-current={draft.id === connection.id ? 'true' : undefined} onClick={() => selectConnection(connection)}>
              <span>
                <strong>{connection.name}</strong>
                <small>
                  {connection.models.length} {zh ? '个模型' : 'models'}
                </small>
              </span>
              <em data-configured={connection.apiKeyConfigured || undefined}>{connection.apiKeyConfigured ? (zh ? '密钥已保存' : 'Key saved') : zh ? '未配置密钥' : 'No key'}</em>
            </button>
          ))}
        </nav>

        <section className="model-connection-editor" aria-label={zh ? '模型供应商编辑器' : 'Model provider editor'}>
          <div className="model-connection-field-grid">
            <label>
              <span>{zh ? '快捷模板' : 'Template'}</span>
              <ZeusSelect
                ariaLabel={zh ? '快捷模板' : 'Template'}
                size="regular"
                value={draft.templateId}
                onChange={applyTemplate}
                options={[
                  { value: 'custom', label: zh ? '自定义兼容供应商' : 'Custom compatible provider' },
                  { value: 'deepseek', label: 'DeepSeek' },
                  { value: 'bailian', label: zh ? '阿里云百炼' : 'Alibaba Bailian' },
                  { value: 'kimi', label: 'Kimi' },
                  { value: 'zai', label: 'Z.AI / GLM' },
                ]}
              />
            </label>
            {draft.templateId === 'custom' ? (
              <>
                <label>
                  <span>{zh ? '供应商名称' : 'Provider name'}</span>
                  <input
                    value={draft.name}
                    onChange={(event) => {
                      const name = event.currentTarget.value;
                      setDraft((value) => ({ ...value, name }));
                    }}
                  />
                </label>
                <label className="model-connection-wide-field">
                  <span>{zh ? '服务地址' : 'Base URL'}</span>
                  <input
                    value={draft.baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => {
                      const baseUrl = event.currentTarget.value;
                      setDraft((value) => ({ ...value, baseUrl }));
                    }}
                  />
                </label>
                <label>
                  <span>{zh ? '模型目录路径' : 'Models path'}</span>
                  <input
                    value={draft.modelsPath}
                    onChange={(event) => {
                      const modelsPath = event.currentTarget.value;
                      setDraft((value) => ({ ...value, modelsPath }));
                    }}
                  />
                </label>
              </>
            ) : null}
            <label>
              <span>{current?.apiKeyConfigured ? (zh ? '替换 API Key' : 'Replace API key') : 'API Key'}</span>
              <input
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                onChange={(event) => {
                  const apiKey = event.currentTarget.value;
                  setDraft((value) => ({ ...value, apiKey }));
                }}
              />
            </label>
          </div>

          <label className="model-connection-enabled">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                setDraft((value) => ({ ...value, enabled }));
              }}
            />
            <span>{zh ? '允许项目使用此供应商' : 'Allow projects to use this provider'}</span>
          </label>

          <section className="model-definition-section">
            <header>
              <span>
                <strong>{zh ? '模型路由与能力' : 'Model routing and capabilities'}</strong>
                <small>{zh ? '每个模型独立选择真实协议与认证；能力状态仍以当前渠道的运行证据为准。' : 'Choose the actual protocol and authentication per model. Capability states still depend on runtime evidence from this channel.'}</small>
              </span>
              {draft.templateId === 'custom' ? (
                <span className="model-add-row">
                  <input aria-label={zh ? '手工模型 ID' : 'Manual model ID'} placeholder={zh ? '手工模型 ID' : 'Manual model ID'} value={newModelId} onChange={(event) => setNewModelId(event.currentTarget.value)} />
                  <Button variant="secondary" size="compact" onClick={addManualModel} disabled={!newModelId.trim()}>
                    {zh ? '添加' : 'Add'}
                  </Button>
                </span>
              ) : null}
            </header>
            {draft.models.length === 0 ? (
              <p>
                {draft.templateId === 'custom'
                  ? zh
                    ? '可以先保存 API Key 后自动获取，也可以手工添加模型。'
                    : 'Save an API key to fetch models, or add models manually.'
                  : zh
                    ? '保存 API Key 后获取该渠道返回的候选模型。'
                    : 'Save the API key, then fetch the candidate models returned by this channel.'}
              </p>
            ) : null}
            <div className="model-definition-list">
              {draft.models.map((model) => (
                <ModelDefinitionEditor
                  key={model.id}
                  language={props.language}
                  model={model}
                  readOnly={draft.templateId !== 'custom'}
                  onChange={(next) => updateModel(model.id, () => next)}
                  onRemove={() => setDraft((value) => ({ ...value, models: value.models.filter((candidate) => candidate.id !== model.id) }))}
                />
              ))}
            </div>
          </section>

          {diagnostic ? <p className={`model-connection-diagnostic ${diagnostic.ok ? 'success' : 'warning'}`}>{diagnostic.message}</p> : null}
          {message ? (
            <p className="model-connection-message" role="status">
              {message}
            </p>
          ) : null}
          <footer className="model-connection-actions">
            <Button variant="primary" size="compact" onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.baseUrl.trim()} busy={status === 'saving'}>
              {zh ? '保存供应商' : 'Save provider'}
            </Button>
            <Button variant="secondary" size="compact" onClick={() => void refreshModels()} disabled={busy || !draft.id || !current?.apiKeyConfigured} busy={status === 'refreshing'}>
              {zh ? '获取模型' : 'Fetch models'}
            </Button>
            <Button variant="secondary" size="compact" onClick={() => void diagnose()} disabled={busy || !draft.id}>
              {zh ? '服务诊断' : 'Diagnose service'}
            </Button>
            {draft.id && current?.apiKeyConfigured ? (
              <Button variant="secondary" size="compact" onClick={() => void clearApiKey()} disabled={busy}>
                {zh ? '清除密钥' : 'Clear key'}
              </Button>
            ) : null}
            {draft.id ? (
              <Button variant="danger" size="compact" onClick={() => void removeConnection()} disabled={busy} busy={status === 'deleting'}>
                {zh ? '删除供应商' : 'Delete provider'}
              </Button>
            ) : null}
          </footer>
        </section>
      </div>
      {pendingInsecureHttpSave ? (
        <ModalPortal rootClassName="model-connection-http-risk-portal" dismissDisabled={busy} onDismiss={() => setPendingInsecureHttpSave(null)}>
          <section className="model-connection-http-risk-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="model-connection-http-risk-title" aria-describedby="model-connection-http-risk-description">
            <header>
              <strong id="model-connection-http-risk-title">{zh ? '确认使用明文 HTTP' : 'Confirm unencrypted HTTP'}</strong>
              <p id="model-connection-http-risk-description">
                {zh
                  ? 'HTTP 不会加密传输。API Key、请求内容和模型回复可能被同一网络中的其他人读取或篡改。请只在你信任该服务和网络时继续。'
                  : 'HTTP traffic is not encrypted. Other people on the network may read or alter the API key, request content, and model responses. Continue only if you trust the service and network.'}
              </p>
            </header>
            <footer>
              <Button variant="secondary" onClick={() => setPendingInsecureHttpSave(null)} disabled={busy}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button
                variant="danger"
                busy={busy}
                onClick={() => {
                  const input = pendingInsecureHttpSave;
                  setPendingInsecureHttpSave(null);
                  void persistConnection({ ...input, allowInsecureHttp: true });
                }}
              >
                {zh ? '仍然保存' : 'Save anyway'}
              </Button>
            </footer>
          </section>
        </ModalPortal>
      ) : null}
    </section>
  );
}

function requiresInsecureHttpConfirmation(baseUrl: string, existingBaseUrl?: string): boolean {
  try {
    const normalized = new URL(baseUrl.trim()).toString().replace(/\/+$/u, '');
    return normalized.startsWith('http://') && normalized !== existingBaseUrl;
  } catch {
    return false;
  }
}

function ModelDefinitionEditor(props: { language: 'zh-CN' | 'en-US'; model: ModelConnectionModel; readOnly: boolean; onChange: (model: ModelConnectionModel) => void; onRemove: () => void }) {
  const zh = props.language === 'zh-CN';
  const model = props.model;
  const routeDescription = protocolDescription(model.protocolFamily, zh);
  return (
    <article className="model-definition-card" data-enabled={model.enabled ? 'true' : 'false'}>
      <header className="model-definition-header">
        <label className="model-definition-identity">
          <input type="checkbox" checked={model.enabled} onChange={(event) => props.onChange({ ...model, enabled: event.currentTarget.checked })} />
          <span>
            <strong title={model.id}>{model.id}</strong>
            <small>{modelRouteLabel(model, zh)}</small>
          </span>
        </label>
        {props.readOnly ? null : (
          <button className="model-definition-remove" type="button" onClick={props.onRemove} aria-label={zh ? `移除模型 ${model.id}` : `Remove model ${model.id}`} title={zh ? '移除模型' : 'Remove model'}>
            <X aria-hidden="true" weight="bold" />
          </button>
        )}
      </header>
      {props.readOnly ? (
        <dl className="model-route-facts">
          <div>
            <dt>{zh ? '请求协议' : 'Request protocol'}</dt>
            <dd>{protocolLabel(model.protocolFamily)}</dd>
          </div>
          <div>
            <dt>{zh ? '认证方式' : 'Authentication'}</dt>
            <dd>{authenticationLabel(model.protocolFamily, model.authenticationScheme, zh)}</dd>
          </div>
        </dl>
      ) : (
        <div className="model-route-controls">
          <label>
            <span>{zh ? '请求协议' : 'Request protocol'}</span>
            <ZeusSelect<ModelProtocolFamily>
              ariaLabel={zh ? `${model.id} 请求协议` : `${model.id} request protocol`}
              className="model-protocol-select"
              size="compact"
              value={model.protocolFamily}
              disabled={props.readOnly}
              onChange={(protocolFamily) =>
                props.onChange({
                  ...model,
                  protocolFamily,
                  runtimeAdapter: protocolFamily === 'openai_responses' ? 'codex_app_server' : 'pi_sdk',
                  authenticationScheme: protocolFamily !== 'anthropic_messages' && model.authenticationScheme === 'x_api_key' ? 'protocol_default' : model.authenticationScheme,
                })
              }
              options={[
                { value: 'openai_completions', label: 'OpenAI Chat Completions' },
                { value: 'anthropic_messages', label: 'Anthropic Messages' },
                { value: 'openai_responses', label: 'OpenAI Responses', disabled: model.protocolFamily !== 'openai_responses' },
              ]}
            />
          </label>
          <label>
            <span>{zh ? '认证方式' : 'Authentication'}</span>
            <ZeusSelect<ModelAuthenticationScheme>
              ariaLabel={zh ? `${model.id} 认证方式` : `${model.id} authentication`}
              className="model-protocol-select"
              size="compact"
              value={model.authenticationScheme}
              disabled={props.readOnly}
              onChange={(authenticationScheme) => props.onChange({ ...model, authenticationScheme })}
              options={[
                { value: 'protocol_default', label: zh ? '协议默认' : 'Protocol default' },
                { value: 'bearer', label: 'Authorization: Bearer' },
                { value: 'x_api_key', label: 'x-api-key', disabled: model.protocolFamily !== 'anthropic_messages' },
              ]}
            />
          </label>
        </div>
      )}
      <p className="model-route-description">{routeDescription}</p>
      <dl className="model-capability-summary">
        <div>
          <dt>{zh ? '推理' : 'Reasoning'}</dt>
          <dd>{reasoningCapabilityLabel(model, zh)}</dd>
        </div>
        <div>
          <dt>{zh ? '工具调用' : 'Tool calling'}</dt>
          <dd>{capabilityStateLabel(model.capability.tools.state, zh)}</dd>
        </div>
        <div>
          <dt>{zh ? '图片输入' : 'Image input'}</dt>
          <dd>{capabilityStateLabel(model.capability.imageInput.state, zh)}</dd>
        </div>
      </dl>
      <details className="model-capability-evidence">
        <summary>{zh ? '查看能力依据' : 'View capability evidence'}</summary>
        <dl>
          <div>
            <dt>{zh ? '推理' : 'Reasoning'}</dt>
            <dd>{model.capability.reasoning.reason}</dd>
          </div>
          <div>
            <dt>{zh ? '工具调用' : 'Tool calling'}</dt>
            <dd>{model.capability.tools.reason}</dd>
          </div>
          <div>
            <dt>{zh ? '图片输入' : 'Image input'}</dt>
            <dd>{model.capability.imageInput.reason}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

function emptyDraft(): ModelConnectionDraft {
  return { id: null, name: '', templateId: 'custom', baseUrl: '', modelsPath: '/models', enabled: true, models: [], apiKey: '' };
}

function createModel(id: string, thinkingFormat: ModelThinkingFormat): ModelConnectionModel {
  const lower = id.toLowerCase();
  const speedLabel: ModelConnectionModel['speedLabel'] =
    lower.includes('highspeed') || lower.includes('high-speed') || lower.includes('fast') ? 'high_speed' : lower.includes('flash') ? 'flash' : lower.includes('turbo') ? 'turbo' : 'standard';
  const evidence = (reason: string) => ({ source: 'catalog' as const, state: 'unverified' as const, checkedAt: null, reason });
  return {
    id,
    displayName: id,
    enabled: true,
    contextWindow: 128_000,
    maxTokens: 8_192,
    speedLabel,
    runtimeAdapter: 'pi_sdk',
    protocolFamily: 'openai_completions',
    authenticationScheme: 'protocol_default',
    capability: {
      reasoning: {
        state: 'unverified',
        levels: ['off'],
        defaultLevel: 'off',
        thinkingFormat,
        levelMap: { off: null },
        source: 'catalog',
        checkedAt: null,
        reason: zhModelCapabilityPendingReason,
      },
      tools: evidence('等待真实工具闭环探针。'),
      imageInput: evidence('等待真实图片输入探针。'),
      streaming: evidence('等待真实流式输出探针。'),
      usage: evidence('等待真实用量字段探针。'),
    },
  };
}

function protocolDescription(protocolFamily: ModelProtocolFamily, zh: boolean): string {
  if (protocolFamily === 'anthropic_messages') {
    return zh ? 'Claude 原生 Messages 链路 · 支持缓存断点与缓存用量' : 'Native Claude Messages route · cache breakpoints and usage';
  }
  if (protocolFamily === 'openai_responses') {
    return zh ? '由已验证的官方 Responses 路由管理' : 'Managed by a verified official Responses route';
  }
  return zh ? 'OpenAI Chat Completions 兼容链路' : 'OpenAI Chat Completions-compatible route';
}

function protocolLabel(protocolFamily: ModelProtocolFamily): string {
  if (protocolFamily === 'anthropic_messages') return 'Anthropic Messages';
  if (protocolFamily === 'openai_responses') return 'OpenAI Responses';
  return 'OpenAI Chat Completions';
}

function authenticationLabel(protocolFamily: ModelProtocolFamily, authenticationScheme: ModelAuthenticationScheme, zh: boolean): string {
  if (authenticationScheme === 'bearer') return 'Authorization: Bearer';
  if (authenticationScheme === 'x_api_key') return 'x-api-key';
  return protocolFamily === 'anthropic_messages' ? (zh ? '协议默认 · x-api-key' : 'Protocol default · x-api-key') : zh ? '协议默认 · Bearer' : 'Protocol default · Bearer';
}

function modelRouteLabel(model: ModelConnectionModel, zh: boolean): string {
  return `${protocolLabel(model.protocolFamily)} · ${authenticationLabel(model.protocolFamily, model.authenticationScheme, zh)}`;
}

function reasoningCapabilityLabel(model: ModelConnectionModel, zh: boolean): string {
  const reasoning = model.capability.reasoning;
  if (reasoning.state !== 'supported') return capabilityStateLabel(reasoning.state, zh);
  return zh ? `默认 ${reasoning.defaultLevel} · ${reasoning.levels.length} 档` : `Default ${reasoning.defaultLevel} · ${reasoning.levels.length} levels`;
}

const zhModelCapabilityPendingReason = '待 Zeus 根据渠道和模型档案自动识别。';

function capabilityStateLabel(state: ModelCapabilityEvidence['state'], zh: boolean): string {
  if (state === 'supported') return zh ? '支持' : 'Supported';
  if (state === 'unsupported') return zh ? '不支持' : 'Unsupported';
  return zh ? '待检测' : 'Pending detection';
}

function cloneModel(model: ModelConnectionModel): ModelConnectionModel {
  return {
    ...model,
    capability: {
      reasoning: { ...model.capability.reasoning, levels: [...model.capability.reasoning.levels], levelMap: { ...model.capability.reasoning.levelMap } },
      tools: { ...model.capability.tools },
      imageInput: { ...model.capability.imageInput },
      streaming: { ...model.capability.streaming },
      usage: { ...model.capability.usage },
    },
  };
}
