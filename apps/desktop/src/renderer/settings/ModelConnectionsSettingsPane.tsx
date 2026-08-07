import { useEffect, useState } from 'react';
import type {
  DashboardClient,
  ModelCapabilityState,
  ModelConnectionDiagnostic,
  ModelConnectionModel,
  ModelConnectionRecord,
  ModelConnectionTemplateId,
  ModelThinkingFormat,
  ModelThinkingLevel,
  SaveModelConnectionRequest,
} from '../apiClient.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';

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

const thinkingLevels: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const capabilityStates: Array<{ value: ModelCapabilityState; zh: string; en: string }> = [
  { value: 'unverified', zh: '未验证', en: 'Unverified' },
  { value: 'supported', zh: '支持', en: 'Supported' },
  { value: 'unsupported', zh: '不支持', en: 'Unsupported' },
];
const thinkingFormats: ModelThinkingFormat[] = ['openai', 'deepseek', 'qwen', 'zai', 'openrouter', 'together', 'qwen-chat-template', 'string-thinking', 'ant-ling'];

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

  async function save(): Promise<void> {
    if (!props.client || busy) return;
    setStatus('saving');
    setMessage(null);
    try {
      const input: SaveModelConnectionRequest = {
        name: draft.name,
        templateId: draft.templateId,
        baseUrl: draft.baseUrl,
        modelsPath: draft.modelsPath,
        enabled: draft.enabled,
        models: draft.models,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      };
      const saved = draft.id ? await props.client.updateModelConnection(draft.id, input) : await props.client.createModelConnection(input);
      await reloadConnections(saved.id);
      setDraft((value) => ({ ...value, id: saved.id, apiKey: '' }));
      setMessage(zh ? '连接配置已保存。' : 'Connection saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setStatus('idle');
    }
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
      setMessage(zh ? '连接已删除。' : 'Connection deleted.');
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
          <small>{zh ? '配置一次连接，项目再选择多个可用模型。API Key 只保存到本机钥匙串。' : 'Configure connections once, then let each project select multiple models. API keys stay in the local Keychain.'}</small>
        </span>
        <Button variant="secondary" size="compact" onClick={() => setDraft(emptyDraft())} disabled={busy}>
          {zh ? '新建连接' : 'New connection'}
        </Button>
      </header>

      <div className="model-connections-layout">
        <nav className="model-connection-list" aria-label={zh ? '模型连接列表' : 'Model connection list'}>
          {connections.length === 0 ? <p>{zh ? '还没有模型连接。' : 'No model connections yet.'}</p> : null}
          {connections.map((connection) => (
            <button key={connection.id} type="button" className={draft.id === connection.id ? 'selected' : ''} onClick={() => selectConnection(connection)}>
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

        <section className="model-connection-editor" aria-label={zh ? '模型连接编辑器' : 'Model connection editor'}>
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
                  <span>{zh ? '连接名称' : 'Connection name'}</span>
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
            <span>{zh ? '允许项目使用此连接' : 'Allow projects to use this connection'}</span>
          </label>

          <section className="model-definition-section">
            <header>
              <span>
                <strong>{zh ? '模型与能力档案' : 'Models and capability profiles'}</strong>
                <small>{zh ? '高速标签属于模型本身；首版 Pi Chat 不显示 Fast 服务档位。' : 'Speed labels describe models. Pi Chat does not expose a Fast service tier.'}</small>
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
              {zh ? '保存连接' : 'Save connection'}
            </Button>
            <Button variant="secondary" size="compact" onClick={() => void refreshModels()} disabled={busy || !draft.id || !current?.apiKeyConfigured} busy={status === 'refreshing'}>
              {zh ? '获取模型' : 'Fetch models'}
            </Button>
            <Button variant="secondary" size="compact" onClick={() => void diagnose()} disabled={busy || !draft.id}>
              {zh ? '连接诊断' : 'Diagnose'}
            </Button>
            {draft.id && current?.apiKeyConfigured ? (
              <Button variant="secondary" size="compact" onClick={() => void clearApiKey()} disabled={busy}>
                {zh ? '清除密钥' : 'Clear key'}
              </Button>
            ) : null}
            {draft.id ? (
              <Button variant="danger" size="compact" onClick={() => void removeConnection()} disabled={busy} busy={status === 'deleting'}>
                {zh ? '删除连接' : 'Delete'}
              </Button>
            ) : null}
          </footer>
        </section>
      </div>
    </section>
  );
}

function ModelDefinitionEditor(props: { language: 'zh-CN' | 'en-US'; model: ModelConnectionModel; readOnly: boolean; onChange: (model: ModelConnectionModel) => void; onRemove: () => void }) {
  const zh = props.language === 'zh-CN';
  const model = props.model;
  const updateEvidence = (field: 'tools' | 'imageInput', state: ModelCapabilityState): void => {
    props.onChange({
      ...model,
      capability: {
        ...model.capability,
        [field]: { source: 'manual', state, checkedAt: null, reason: zh ? '由用户手工声明，等待真实运行探针。' : 'Declared manually; awaiting a runtime probe.' },
      },
    });
  };
  return (
    <article className="model-definition-card">
      <header>
        <label>
          <input type="checkbox" checked={model.enabled} onChange={(event) => props.onChange({ ...model, enabled: event.currentTarget.checked })} />
          <strong>{model.id}</strong>
        </label>
        {props.readOnly ? null : (
          <button type="button" onClick={props.onRemove} aria-label={zh ? `移除模型 ${model.id}` : `Remove model ${model.id}`}>
            ×
          </button>
        )}
      </header>
      {props.readOnly ? (
        <p>
          {zh ? '思考深度' : 'Reasoning effort'}：
          {model.capability.reasoning.state === 'supported' ? model.capability.reasoning.levels.join(' / ') : zh ? '能力待确认，会话中隐藏' : 'Unverified; hidden in conversations'} · {zh ? '工具' : 'Tools'}：
          {model.capability.tools.state} · {zh ? '图片' : 'Images'}：{model.capability.imageInput.state}
        </p>
      ) : (
        <div className="model-definition-grid">
        <label>
          <span>{zh ? '显示名称' : 'Display name'}</span>
          <input value={model.displayName} onChange={(event) => props.onChange({ ...model, displayName: event.currentTarget.value })} />
        </label>
        <label>
          <span>{zh ? '速度标签' : 'Speed label'}</span>
          <ZeusSelect<ModelConnectionModel['speedLabel']>
            ariaLabel={zh ? '速度标签' : 'Speed label'}
            size="regular"
            value={model.speedLabel}
            onChange={(speedLabel) => props.onChange({ ...model, speedLabel })}
            options={(['standard', 'high_speed', 'flash', 'turbo'] as const).map((value) => ({ value, label: value }))}
          />
        </label>
        <label>
          <span>{zh ? '思考能力' : 'Reasoning'}</span>
          <ZeusSelect
            ariaLabel={zh ? '思考能力' : 'Reasoning'}
            size="regular"
            value={model.capability.reasoning.state}
            onChange={(state) =>
              props.onChange({
                ...model,
                capability: {
                  ...model.capability,
                  reasoning: { ...model.capability.reasoning, state, levels: state === 'supported' ? model.capability.reasoning.levels : ['off'], defaultLevel: state === 'supported' ? model.capability.reasoning.defaultLevel : 'off' },
                },
              })
            }
            options={capabilityStates.map((state) => ({ value: state.value, label: zh ? state.zh : state.en }))}
          />
        </label>
        <label>
          <span>{zh ? '思考参数格式' : 'Thinking format'}</span>
          <ZeusSelect
            ariaLabel={zh ? '思考参数格式' : 'Thinking format'}
            size="regular"
            value={model.capability.reasoning.thinkingFormat}
            onChange={(thinkingFormat) => props.onChange({ ...model, capability: { ...model.capability, reasoning: { ...model.capability.reasoning, thinkingFormat } } })}
            options={thinkingFormats.map((value) => ({ value, label: value }))}
          />
        </label>
        <label>
          <span>{zh ? '推理等级' : 'Reasoning levels'}</span>
          <input
            disabled={model.capability.reasoning.state !== 'supported'}
            value={model.capability.reasoning.levels.join(', ')}
            onChange={(event) => {
              const levels = thinkingLevels.filter((level) =>
                event.currentTarget.value
                  .split(',')
                  .map((item) => item.trim())
                  .includes(level),
              );
              const effective: ModelThinkingLevel[] = levels.length > 0 ? levels : ['off'];
              props.onChange({
                ...model,
                capability: {
                  ...model.capability,
                  reasoning: { ...model.capability.reasoning, levels: effective, defaultLevel: effective.includes(model.capability.reasoning.defaultLevel) ? model.capability.reasoning.defaultLevel : effective[0]! },
                },
              });
            }}
          />
        </label>
        <label>
          <span>{zh ? '默认推理等级' : 'Default reasoning'}</span>
          <ZeusSelect
            ariaLabel={zh ? '默认推理等级' : 'Default reasoning'}
            size="regular"
            value={model.capability.reasoning.defaultLevel}
            onChange={(defaultLevel) => props.onChange({ ...model, capability: { ...model.capability, reasoning: { ...model.capability.reasoning, defaultLevel } } })}
            options={model.capability.reasoning.levels.map((value) => ({ value, label: value }))}
          />
        </label>
        <label>
          <span>{zh ? '工具调用' : 'Tool calling'}</span>
          <ZeusSelect
            ariaLabel={zh ? '工具调用' : 'Tool calling'}
            size="regular"
            value={model.capability.tools.state}
            onChange={(state) => updateEvidence('tools', state)}
            options={capabilityStates.map((state) => ({ value: state.value, label: zh ? state.zh : state.en }))}
          />
        </label>
        <label>
          <span>{zh ? '图片输入' : 'Image input'}</span>
          <ZeusSelect
            ariaLabel={zh ? '图片输入' : 'Image input'}
            size="regular"
            value={model.capability.imageInput.state}
            onChange={(state) => updateEvidence('imageInput', state)}
            options={capabilityStates.map((state) => ({ value: state.value, label: zh ? state.zh : state.en }))}
          />
        </label>
        </div>
      )}
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
  const evidence = (reason: string) => ({ source: 'manual' as const, state: 'unverified' as const, checkedAt: null, reason });
  return {
    id,
    displayName: id,
    enabled: true,
    contextWindow: 128_000,
    maxTokens: 8_192,
    speedLabel,
    capability: {
      reasoning: { state: 'unverified', levels: ['off'], defaultLevel: 'off', thinkingFormat },
      tools: evidence('等待真实工具闭环探针。'),
      imageInput: evidence('等待真实图片输入探针。'),
      streaming: evidence('等待真实流式输出探针。'),
      usage: evidence('等待真实用量字段探针。'),
    },
  };
}

function cloneModel(model: ModelConnectionModel): ModelConnectionModel {
  return {
    ...model,
    capability: {
      reasoning: { ...model.capability.reasoning, levels: [...model.capability.reasoning.levels] },
      tools: { ...model.capability.tools },
      imageInput: { ...model.capability.imageInput },
      streaming: { ...model.capability.streaming },
      usage: { ...model.capability.usage },
    },
  };
}
