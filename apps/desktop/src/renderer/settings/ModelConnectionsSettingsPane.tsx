import { redactUserFacingErrorDetails } from '@zeus/shared';
import { useEffect, useRef, useState } from 'react';
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
  SelectablePiModel,
} from '../apiClient.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import {
    formatVisibleApplicationError,
    reportApplicationError,
    VisibleApplicationError
} from '../ui/ApplicationErrorDialog.js';
import { ModalPortal } from '../ui/ModalPortal.js';

/** 编辑中的供应商；密钥只在当前编辑器内存中短暂保留。 */
interface ModelConnectionDraft extends SaveModelConnectionRequest {
  id: string | null;
  apiKey: string;
}

/** 沿用已有供应商模板的地址与模型目录。 */
const templateDefaults: Record<ModelConnectionTemplateId, { name: string; baseUrl: string; modelsPath: string; thinkingFormat: ModelThinkingFormat }> = {
  custom: { name: '', baseUrl: '', modelsPath: '/models', thinkingFormat: 'openai' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelsPath: '/models', thinkingFormat: 'deepseek' },
  bailian: { name: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelsPath: '/models', thinkingFormat: 'qwen' },
  kimi: { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', modelsPath: '/models', thinkingFormat: 'openai' },
  zai: { name: 'Z.AI / GLM', baseUrl: 'https://api.z.ai/api/paas/v4', modelsPath: '/models', thinkingFormat: 'zai' },
};

/** 共享编辑器使用现有模型读写接口。 */
type ModelConnectionClient = Pick<
  DashboardClient,
  'loadSelectablePiModels' | 'loadModelConnections' | 'createModelConnection' | 'updateModelConnection' | 'deleteModelConnection' | 'clearModelConnectionApiKey' | 'refreshModelConnectionModels' | 'diagnoseModelConnection'
>;

/** 设置与首次引导共享供应商编辑器，完成回调只接受已落库且可选的模型。 */
export function ModelConnectionsSettingsPane(props: {
  language: 'zh-CN' | 'en-US';
  client: ModelConnectionClient | null;
  /** 引导切回其他步骤时清除尚未保存的密钥，保留普通配置。 */
  active?: boolean;
  /** 首次引导在编辑器内选择新项目默认模型。 */
  onComplete?: (modelRef: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const zh = props.language === 'zh-CN';
  const [connections, setConnections] = useState<ModelConnectionRecord[]>([]);
  const [draft, setDraft] = useState<ModelConnectionDraft>(() => emptyDraft());
  const [newModelId, setNewModelId] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'refreshing' | 'deleting'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<ModelConnectionDiagnostic | null>(null);
  /** 切换供应商后忽略旧目录回执。 */
  const modelRequestRef = useRef(0);
  /** 完整模型引用保留供应商身份；手工模型保存后也从真实目录选择。 */
  const [selectableModels, setSelectableModels] = useState<SelectablePiModel[]>([]);
  /** 引导为后续新项目选定的完整模型引用。 */
  const [defaultModelRef, setDefaultModelRef] = useState('');
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
        setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
        setStatus('idle');
      });
    return () => {
      active = false;
    };
  }, [props.client]);

  const busy = status !== 'idle';
  useEffect(() => {
    props.onBusyChange?.(busy);
    return () => props.onBusyChange?.(false);
  }, [busy, props.onBusyChange]);
  useEffect(() => {
    if (props.active !== false) return;
    setDraft((value) => ({ ...value, apiKey: '' }));
    setPendingInsecureHttpSave(null);
  }, [props.active]);
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
    modelRequestRef.current += 1;
    setDefaultModelRef('');
    setSelectableModels([]);
    if (props.onComplete) void refreshDefaultModels(connection.id).catch((error) => setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en')));
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
      setConnections((items) => [...items.filter((item) => item.id !== saved.id), saved]);
      setDraft({ ...saved, id: saved.id, apiKey: '', models: saved.models.map(cloneModel) });
      setMessage(zh ? '供应商配置已保存；实际模型调用尚未验证。' : 'Provider configuration saved; actual model calls have not been verified.');
      if (props.onComplete) await refreshDefaultModels(saved.id);
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  /** 读取现有本地模型目录，不向外部供应商发送推理请求。 */
  async function refreshDefaultModels(connectionId: string): Promise<void> {
    if (!props.client) return;
    // 当前查询身份用于隔离供应商切换后的迟到结果。
    const request = ++modelRequestRef.current;
    // 可选目录已经合并配置启用状态和本机密钥是否存在。
    const models = (await props.client.loadSelectablePiModels()).filter((model) => model.sourceId === connectionId && model.available);
    if (modelRequestRef.current !== request) return;
    setSelectableModels(models);
    setDefaultModelRef((reference) => (models.some((model) => model.id === reference) ? reference : (models[0]?.id ?? '')));
  }

  /** 配置与默认模型均已保存后才离开引导；失败继续保留编辑器。 */
  async function completeSetup(): Promise<void> {
    if (!props.onComplete || !current || !defaultModelRef || busy) return;
    setStatus('saving');
    setMessage(null);
    try {
      await props.onComplete(defaultModelRef);
    } catch (error) {
      setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
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
      if (props.onComplete) await refreshDefaultModels(draft.id);
      setMessage(zh ? `发现 ${result.discoveredModelIds.length} 个模型，新增 ${result.addedModelIds.length} 个。` : `Discovered ${result.discoveredModelIds.length} models and added ${result.addedModelIds.length}.`);
    } catch (error) {
      setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
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
      setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
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
      setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
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
      setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
    } finally {
      setStatus('idle');
    }
  }

  // 首次引导已拥有模态面，HTTP 确认在同一界面内展示。
  const httpConfirmation = pendingInsecureHttpSave ? (
    <section
      className="model-connection-http-risk-dialog zeus-solid-form-surface"
      role={props.onComplete ? 'alert' : 'dialog'}
      aria-modal={props.onComplete ? undefined : true}
      aria-labelledby="model-connection-http-risk-title"
      aria-describedby="model-connection-http-risk-description"
    >
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
  ) : null;

  return (
    <section className="settings-product-pane model-connections-settings" aria-label={zh ? '模型供应商' : 'Model providers'}>
      <header className="settings-section-heading model-connections-heading">
        <span>
          <strong>{zh ? '模型供应商' : 'Model providers'}</strong>
          <small>
            {zh ? '填写服务地址和访问密钥（API Key），即可在项目中选择该服务的模型。密钥只保存在本机钥匙串。' : 'Enter the service address and API key to use its models in projects. The key is stored only in this Mac’s Keychain.'}
          </small>
        </span>
        <Button hidden={Boolean(props.onComplete)} variant="secondary" size="compact" onClick={() => setDraft(emptyDraft())} disabled={busy}>
          {zh ? '新建供应商' : 'New provider'}
        </Button>
      </header>

      {props.onComplete && connections.length > 0 ? (
        <ZeusSelect
          size="regular"
          ariaLabel={zh ? '选择已保存供应商' : 'Choose a saved provider'}
          value={draft.id ?? ''}
          options={[{ value: '', label: zh ? '新建供应商' : 'New provider' }, ...connections.map((connection) => ({ value: connection.id, label: connection.name }))]}
          disabled={busy}
          onChange={(id) => {
            const connection = connections.find((item) => item.id === id);
            if (connection) selectConnection(connection);
            else {
              modelRequestRef.current += 1;
              setDraft(emptyDraft());
              setSelectableModels([]);
              setDefaultModelRef('');
            }
          }}
        />
      ) : null}
      <div className={`model-connections-layout${props.onComplete ? ' model-setup-editor-layout' : ''}`}>
        <nav hidden={Boolean(props.onComplete)} className="model-connection-list" aria-label={zh ? '模型供应商列表' : 'Model provider list'}>
          {connections.length === 0 ? <p>{zh ? '还没有模型供应商。' : 'No model providers yet.'}</p> : null}
          {connections.map((connection) => (
            <button key={connection.id} type="button" className={draft.id === connection.id ? 'selected' : ''} aria-current={draft.id === connection.id ? 'true' : undefined} disabled={busy} onClick={() => selectConnection(connection)}>
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

        <fieldset disabled={busy} className="model-connection-editor" aria-label={zh ? '模型供应商编辑器' : 'Model provider editor'}>
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
                <details open={props.onComplete ? undefined : true} className="model-setup-advanced">
                  <summary>{zh ? '高级连接设置' : 'Advanced connection settings'}</summary>
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
                </details>
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
                <strong>{zh ? '模型连接与功能' : 'Model connections and features'}</strong>
                <small>
                  {zh
                    ? '为每个模型选择服务支持的请求格式和登录方式。功能是否可用以检测结果为准。'
                    : 'Choose the request format and authentication supported by the service for each model. Feature availability is based on checks of that connection.'}
                </small>
              </span>
              {draft.templateId === 'custom' || props.onComplete ? (
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
              {draft.models.map((model) => {
                // 引导先选择模型，协议与能力仍可在高级设置中调整。
                const editor = (
                  <ModelDefinitionEditor
                    key={model.id}
                    language={props.language}
                    model={model}
                    readOnly={draft.templateId !== 'custom'}
                    onChange={(next) => updateModel(model.id, () => next)}
                    onRemove={() => setDraft((value) => ({ ...value, models: value.models.filter((candidate) => candidate.id !== model.id) }))}
                  />
                );
                return props.onComplete ? (
                  <details key={model.id} className="model-setup-advanced">
                    <summary>
                      {model.id} · {zh ? '高级设置' : 'Advanced settings'}
                    </summary>
                    {editor}
                  </details>
                ) : (
                  editor
                );
              })}
            </div>
          </section>

          {diagnostic ? (
            <p className={`model-connection-diagnostic ${diagnostic.ok ? 'success' : 'warning'}`}>
              {diagnostic.ok ? (
                zh ? (
                  `已连接并读取到 ${diagnostic.discoveredModelCount ?? 0} 个模型。模型是否支持图片或工具调用仍需分别检查。`
                ) : (
                  `Connected and found ${diagnostic.discoveredModelCount ?? 0} models. Image input and tool support still need to be checked separately.`
                )
              ) : (
                <VisibleApplicationError error={diagnostic} language={zh ? 'zh-CN' : 'en'} />
              )}
            </p>
          ) : null}
          {message ? (
            <p className="model-connection-message" role="status">
              {message}
            </p>
          ) : null}
          {props.onComplete ? (
            <label className="model-setup-default-model">
              <span>{zh ? '新项目默认模型' : 'Default model for new projects'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? '新项目默认模型' : 'Default model for new projects'}
                value={defaultModelRef}
                onChange={setDefaultModelRef}
                options={selectableModels.map((model) => ({ value: model.id, label: model.displayName }))}
              />
              <small>{zh ? '只影响之后新建的项目。当前配置不代表实际模型调用已经验证。' : 'Only affects new projects. Configuration does not prove actual model calls.'}</small>
            </label>
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
            {props.onComplete ? (
              <Button
                variant="primary"
                size="compact"
                onClick={() => void completeSetup()}
                disabled={
                  busy ||
                  !current?.apiKeyConfigured ||
                  !current.enabled ||
                  !defaultModelRef ||
                  Boolean(draft.apiKey) ||
                  JSON.stringify(createSaveInput()) !== JSON.stringify({ name: current.name, templateId: current.templateId, baseUrl: current.baseUrl, modelsPath: current.modelsPath, enabled: current.enabled, models: current.models })
                }
              >
                {zh ? '完成接入' : 'Finish setup'}
              </Button>
            ) : null}
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
        </fieldset>
      </div>
      {pendingInsecureHttpSave ? (
        props.onComplete ? (
          httpConfirmation
        ) : (
          <ModalPortal rootClassName="model-connection-http-risk-portal" dismissDisabled={busy} onDismiss={() => setPendingInsecureHttpSave(null)}>
            {httpConfirmation}
          </ModalPortal>
        )
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
  const contextDeclaration = (
    <>
      <input
        type="checkbox"
        aria-label={zh ? '支持 1M 上下文' : 'Supports 1M context'}
        checked={model.supports1MContext}
        onChange={(event) =>
          props.onChange({
            ...model,
            supports1MContext: event.currentTarget.checked,
            contextWindow: event.currentTarget.checked ? 1_000_000 : 256_000,
            // 取消 1M 后旧 maxTokens 可能超过 256K 窗口，就地收敛避免保存报错。
            maxTokens: event.currentTarget.checked ? model.maxTokens : Math.min(model.maxTokens, 256_000),
          })
        }
      />
      <span className="model-context-declaration-label">{zh ? '支持 1M 上下文' : 'Supports 1M context'}</span>
    </>
  );
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
          <div>
            <dt>{zh ? '上下文窗口' : 'Context window'}</dt>
            <dd>
              <span className="model-context-declaration-value">{contextDeclaration}</span>
            </dd>
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
                  runtimeAdapter: 'pi_sdk',
                  authenticationScheme: protocolFamily !== 'anthropic_messages' && model.authenticationScheme === 'x_api_key' ? 'protocol_default' : model.authenticationScheme,
                })
              }
              options={[
                { value: 'openai_completions', label: 'OpenAI Chat Completions' },
                { value: 'anthropic_messages', label: 'Anthropic Messages' },
                { value: 'openai_responses', label: 'OpenAI Responses' },
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
          <label className="model-context-declaration">
            <span>{zh ? '上下文窗口' : 'Context window'}</span>
            <span className="model-context-declaration-value">{contextDeclaration}</span>
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
            <dd>{capabilityEvidenceText(model.capability.reasoning, zh)}</dd>
          </div>
          <div>
            <dt>{zh ? '工具调用' : 'Tool calling'}</dt>
            <dd>{capabilityEvidenceText(model.capability.tools, zh)}</dd>
          </div>
          <div>
            <dt>{zh ? '图片输入' : 'Image input'}</dt>
            <dd>{capabilityEvidenceText(model.capability.imageInput, zh)}</dd>
          </div>
        </dl>
        <details>
          <summary>{zh ? '检测记录（原文）' : 'Original check details'}</summary>
          <pre>{[model.capability.reasoning.reason, model.capability.tools.reason, model.capability.imageInput.reason].map(redactUserFacingErrorDetails).join('\n')}</pre>
        </details>
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
    supports1MContext: false,
    contextWindow: 256_000,
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
      tools: evidence('尚未检测工具调用功能。'),
      imageInput: evidence('尚未检测图片输入功能。'),
      streaming: evidence('尚未检测逐步显示回复的功能。'),
      usage: evidence('尚未检测服务是否提供用量信息。'),
    },
  };
}

function protocolDescription(protocolFamily: ModelProtocolFamily, zh: boolean): string {
  if (protocolFamily === 'anthropic_messages') {
    return zh ? 'Anthropic Messages 请求格式 · 支持缓存设置与用量信息' : 'Anthropic Messages format · cache settings and usage';
  }
  if (protocolFamily === 'openai_responses') {
    return zh ? 'OpenAI Responses 请求格式 · 支持对话缓存' : 'OpenAI Responses format · conversation caching';
  }
  return zh ? 'OpenAI Chat Completions 兼容格式' : 'OpenAI Chat Completions-compatible format';
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

const zhModelCapabilityPendingReason = '等待识别此服务中该模型支持的功能。';

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

/** 根据已记录的检测状态解释能力来源，原始诊断不当作普通说明。 */
function capabilityEvidenceText(evidence: Pick<ModelCapabilityEvidence, 'source' | 'state'>, zh: boolean): string {
  if (evidence.source === 'catalog') return zh ? '来自模型资料，尚需检查当前连接是否支持。' : 'Based on model information. Support still needs to be checked for this connection.';
  if (evidence.state === 'supported') return zh ? '当前记录显示此连接支持该功能。' : 'The current record indicates that this connection supports the feature.';
  if (evidence.state === 'unsupported') return zh ? '当前记录显示此连接不支持该功能。' : 'The current record indicates that this connection does not support the feature.';
  return zh ? '尚未确认此连接是否支持该功能。' : 'Support for this feature has not been confirmed on this connection.';
}
