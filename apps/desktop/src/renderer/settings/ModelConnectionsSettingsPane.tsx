import { MotionPresence } from '../ui/MotionPresence.js';
import { SettingsSaveStatus, type SettingsSaveState } from './useSettingsAutosave.js';
import { useEffect, useId, useRef, useState } from 'react';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { EyeSlashIcon } from '@phosphor-icons/react/dist/csr/EyeSlash';
import type {
  DashboardClient,
  ModelAuthenticationScheme,
  ModelCapabilityEvidence,
  ModelCapabilityProbeSummary,
  ModelConnectionDiagnostic,
  ModelConnectionModel,
  ModelConnectionRecord,
  ModelConnectionTemplateId,
  ModelProtocolFamily,
  ModelReasoningAuditResult,
  ModelReasoningBasis,
  ModelThinkingFormat,
  ModelThinkingLevel,
  SaveModelConnectionRequest,
  SelectablePiModel,
} from '../apiClient.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { Collapsible } from '../ui/Collapsible.js';
import { presentModelOptions, type ModelOptionSource } from '../modelOptionPresentation.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { SettingsPagination, settingsPage, settingsPageSize } from './SettingsPagination.js';

/** 编辑中的供应商；密钥只在当前编辑器内存中短暂保留。 */
interface ModelConnectionDraft extends SaveModelConnectionRequest {
  id: string | null;
  apiKey: string;
}

/** 沿用已有供应商模板的地址与模型目录。 */
/** Pi 认识的七个档位词；手工覆盖档位时用户从这里选，界面显示的仍是自己填的厂商词。 */
const PI_THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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
  | 'loadSelectablePiModels'
  | 'loadModelConnections'
  | 'createModelConnection'
  | 'updateModelConnection'
  | 'deleteModelConnection'
  | 'clearModelConnectionApiKey'
  | 'revealModelConnectionApiKey'
  | 'loadModelConnectionLastSent'
  | 'saveModelConnectionReasoningOptions'
  | 'auditModelConnectionReasoningLevels'
  | 'refreshModelConnectionModels'
  | 'probeModelConnectionModels'
  | 'diagnoseModelConnection'
>;

/** 设置与首次引导共享供应商编辑器，完成回调只接受已落库且可选的模型。 */
export function ModelConnectionsSettingsPane(props: {
  language: 'zh-CN' | 'en-US';
  /** 完整设置页在页面标题右侧显示回执。 */
  onSaveStateChange?: (status: SettingsSaveState) => void;
  client: ModelConnectionClient | null;
  /** 引导切回其他步骤时清除尚未保存的密钥，保留普通配置。 */
  active?: boolean;
  /** 首次引导在编辑器内选择新项目默认模型。 */
  onComplete?: (modelRef: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  /** 当前任务或对话只启用当前项目模型，不调整其他项目或全局默认。 */
  completionScope?: 'project' | 'conversation' | 'new_projects';
}) {
  const zh = props.language === 'zh-CN';
  /** 可见标签和读屏名称共用当前接入范围文案。 */
  const completionModelLabel =
    props.completionScope === 'conversation'
      ? zh
        ? '本次对话模型'
        : 'Model for this conversation'
      : props.completionScope === 'project'
        ? zh
          ? '本次任务模型'
          : 'Model for this task'
        : zh
          ? '新项目默认模型'
          : 'Default model for new projects';
  const [connections, setConnections] = useState<ModelConnectionRecord[]>([]);
  const [draft, setDraft] = useState<ModelConnectionDraft>(() => emptyDraft());
  const [newModelId, setNewModelId] = useState('');
  /** 搜索和分页只改变展示，不影响供应商保存的模型集合。 */
  const [modelQuery, setModelQuery] = useState('');
  /** 切换供应商或筛选时回到第一页。 */
  const [requestedModelPage, setRequestedModelPage] = useState(1);
  /** 展开只属于当前编辑器，跨搜索和分页保留，不写入模型配置。 */
  const [expandedModelIds, setExpandedModelIds] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'refreshing' | 'probing' | 'deleting' | 'revealing'>('loading');
  /** 已读取出来的密钥只活在这份状态里：隐藏、保存、切换连接都会立刻丢掉。 */
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** 保存反馈与模型诊断消息分开。 */
  const [saveState, setSaveState] = useState<SettingsSaveState>('idle');
  useEffect(() => props.onSaveStateChange?.(saveState), [saveState, props.onSaveStateChange]);
  /** 同一次失焦、点击不重复提交。 */
  const savingRef = useRef(false);
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
        if (!props.onComplete && items[0]) selectConnection(items[0]);
        setStatus('idle');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
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
  /** 换到别的连接（或清空草稿）时立刻丢掉上一条连接读出来的密钥，避免串台。 */
  useEffect(() => {
    setRevealedApiKey(null);
    setApiKeyVisible(false);
  }, [draft.id]);
  /** 界面列表只展示已启用模型：没勾选的候选只留在大纲下拉里，避免几十个候选刷屏。 */
  const enabledModels = draft.models.filter((model) => model.enabled);
  /** 本地筛选保留全部草稿，翻页不会遗失模型修改。 */
  const filteredModels = enabledModels.filter((model) => model.id.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()));
  /** 实际页随模型删除夹紧。 */
  const modelPage = settingsPage(filteredModels.length, requestedModelPage);
  /** 全部操作以当前搜索结果为范围，包含尚未翻到的页面。 */
  const allModelsExpanded = filteredModels.length > 0 && filteredModels.every((model) => expandedModelIds.has(model.id));
  /** 候选池里的模型全部进入分组下拉，勾选状态单独映射到模型的 enabled。 */
  const candidateModelOptions: ModelOptionSource[] = draft.models.map((model) => ({
    id: model.id,
    model: model.id,
    displayName: model.displayName,
    sourceName: current?.name || draft.name,
    available: true,
    supports1MContext: model.supports1MContext,
    speedLabel: model.speedLabel,
  }));
  const enablePresentation = presentModelOptions(candidateModelOptions, '', props.language);
  const enabledModelIds = enabledModels.map((model) => model.id);
  const enabledModelCount = enabledModelIds.length;

  /** 批量和单项展开共用同一状态，保留搜索范围之外的展开选择。 */
  function setModelsExpanded(ids: string[], expanded: boolean): void {
    setExpandedModelIds((currentIds) => {
      /** 新集合只更新本次操作涉及的模型。 */
      const nextIds = new Set(currentIds);
      for (const id of ids) {
        if (expanded) nextIds.add(id);
        else nextIds.delete(id);
      }
      return nextIds;
    });
  }

  /** 分组下拉勾选只翻转启用状态，协议、认证和容量仍由模型卡片维护。 */
  function toggleModelEnabled(modelId: string): void {
    const enabled = draft.models.some((model) => model.id === modelId && model.enabled);
    changeDraft({ ...draft, models: draft.models.map((model) => (model.id === modelId ? { ...model, enabled: !enabled } : model)) });
  }

  function selectConnection(connection: ModelConnectionRecord): void {
    setSaveState('idle');
    setModelQuery('');
    setRequestedModelPage(1);
    if (connection.id !== draft.id) setExpandedModelIds(new Set());
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

  /** 文字输入结束保存，选择项立即保存；新建和接入引导仍显式创建。 */
  function changeDraft(next: ModelConnectionDraft): void {
    setDraft(next);
    setSaveState('idle');
    if (next.id && !props.onComplete) void save(next);
  }

  function applyTemplate(templateId: ModelConnectionTemplateId): void {
    const template = templateDefaults[templateId];
    changeDraft({
      ...draft,
      templateId,
      ...(templateId === 'custom' ? {} : { name: template.name, baseUrl: template.baseUrl, modelsPath: template.modelsPath }),
      models: draft.models.map((model) => ({
        ...model,
        capability: {
          ...model.capability,
          reasoning: { ...model.capability.reasoning, thinkingFormat: template.thinkingFormat },
        },
      })),
    });
  }

  function addManualModel(): void {
    const id = newModelId.trim();
    if (!id || draft.models.some((model) => model.id === id)) return;
    changeDraft({ ...draft, models: [...draft.models, createModel(id, templateDefaults[draft.templateId].thinkingFormat)] });
    setModelsExpanded([id], true);
    setNewModelId('');
    setModelQuery('');
    // 手工添加的模型默认启用，因此它出现在已启用列表末尾。
    setRequestedModelPage(Math.ceil((enabledModelCount + 1) / settingsPageSize));
  }

  function updateModel(modelId: string, update: (model: ModelConnectionModel) => ModelConnectionModel): void {
    changeDraft({ ...draft, models: draft.models.map((model) => (model.id === modelId ? update(model) : model)) });
  }

  async function reloadConnections(preferredId?: string): Promise<void> {
    if (!props.client) return;
    const items = await props.client.loadModelConnections();
    setConnections(items);
    const selected = items.find((connection) => connection.id === preferredId);
    if (selected) selectConnection(selected);
  }

  function createSaveInput(value = draft): SaveModelConnectionRequest {
    return {
      name: value.name,
      templateId: value.templateId,
      baseUrl: value.baseUrl,
      modelsPath: value.modelsPath,
      enabled: value.enabled,
      models: value.models,
      ...(value.apiKey.trim() ? { apiKey: value.apiKey.trim() } : {}),
    };
  }

  async function persistConnection(input: SaveModelConnectionRequest): Promise<void> {
    if (!props.client || busy || savingRef.current) return;
    savingRef.current = true;
    setStatus('saving');
    setSaveState('saving');
    setMessage(null);
    try {
      const saved = draft.id ? await props.client.updateModelConnection(draft.id, input) : await props.client.createModelConnection(input);
      setConnections((items) => [...items.filter((item) => item.id !== saved.id), saved]);
      setRevealedApiKey(null);
      setApiKeyVisible(false);
      setDraft({ ...saved, id: saved.id, apiKey: '', models: saved.models.map(cloneModel) });
      setSaveState('saved');
      if (props.onComplete) await refreshDefaultModels(saved.id);
    } catch (error) {
      setSaveState('failed');
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      savingRef.current = false;
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
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  async function save(value = draft): Promise<void> {
    const input = createSaveInput(value);
    if (current && JSON.stringify(input) === JSON.stringify(createSaveInput({ ...current, apiKey: '' }))) return;
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
      setMessage(
        zh
          ? `候选池已同步：共 ${result.discoveredModelIds.length} 个模型，新增 ${result.addedModelIds.length} 个，移除 ${result.removedModelIds.length} 个。新模型默认未启用，请在“启用模型”中勾选。`
          : `Candidate pool synced: ${result.discoveredModelIds.length} discovered, ${result.addedModelIds.length} added, ${result.removedModelIds.length} removed. New models stay disabled until selected.`,
      );
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  /** 对已启用模型真实探测一次；探测结果由后端落库，界面只负责刷新与回执。 */
  async function probeModels(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setStatus('probing');
    setMessage(null);
    try {
      const summary = await props.client.probeModelConnectionModels(draft.id);
      await reloadConnections(draft.id);
      if (props.onComplete) await refreshDefaultModels(draft.id);
      setMessage(describeProbeResult(summary, zh));
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
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
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  /**
   * 用户主动查看当前连接的 API Key。
   * 只有点击眼睛才走独立读取入口；再次点击或切换连接立刻丢弃，不进草稿、不落盘、不预取。
   */
  async function toggleApiKeyVisibility(): Promise<void> {
    if (apiKeyVisible) {
      setApiKeyVisible(false);
      setRevealedApiKey(null);
      return;
    }
    if (!props.client || !draft.id || !current?.apiKeyConfigured) return;
    setStatus('revealing');
    try {
      const result = await props.client.revealModelConnectionApiKey(draft.id);
      if (!result.apiKey) {
        setMessage(zh ? '钥匙串里没有这项密钥，请重新填写后保存。' : 'No key found in Keychain. Enter and save a new one.');
        return;
      }
      setRevealedApiKey(result.apiKey);
      setApiKeyVisible(true);
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
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
      setRevealedApiKey(null);
      setApiKeyVisible(false);
      setMessage(zh ? 'API Key 已从钥匙串清除。' : 'API key cleared from Keychain.');
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
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
      setExpandedModelIds(new Set());
      setDiagnostic(null);
      setMessage(zh ? '供应商已删除。' : 'Provider deleted.');
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  // 首次引导已拥有模态面，HTTP 确认在同一界面内展示。
  const httpConfirmation = pendingInsecureHttpSave ? (
    <section
      className="model-connection-http-risk-dialog zeus-solid-form-surface"
      role={props.onComplete ? 'alert' : undefined}
      data-modal-surface={props.onComplete ? undefined : 'dialog'}
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
          <strong>{zh ? '自定义供应商' : 'Custom providers'}</strong>
          <small>
            {zh ? '填写服务地址和访问密钥（API Key），即可在项目中选择该服务的模型。密钥只保存在本机钥匙串。' : 'Enter the service address and API key to use its models in projects. The key is stored only in this Mac’s Keychain.'}
          </small>
        </span>
        <span className="settings-heading-actions">
          {!props.onSaveStateChange ? <SettingsSaveStatus status={saveState} language={props.language} /> : null}
          <Button
            hidden={Boolean(props.onComplete)}
            variant="secondary"
            size="compact"
            onClick={() => {
              setDraft(emptyDraft());
              setModelQuery('');
              setRequestedModelPage(1);
              setExpandedModelIds(new Set());
              setDiagnostic(null);
              setMessage(null);
            }}
            disabled={busy}
          >
            {zh ? '新建供应商' : 'New provider'}
          </Button>
        </span>
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
              setExpandedModelIds(new Set());
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

        <fieldset
          disabled={busy}
          onInput={() => setSaveState('idle')}
          onBlurCapture={(event) => {
            if (draft.id && !props.onComplete && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox' && event.target.type !== 'search') void save();
          }}
          className="model-connection-editor"
          aria-label={zh ? '模型供应商编辑器' : 'Model provider editor'}
        >
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
              </>
            ) : null}
            <label>
              <span>{current?.apiKeyConfigured ? (zh ? '替换 API Key' : 'Replace API key') : 'API Key'}</span>
              <span className="settings-secret-control">
                <input
                  type={apiKeyVisible ? 'text' : 'password'}
                  autoComplete="off"
                  value={apiKeyVisible ? (revealedApiKey ?? draft.apiKey) : draft.apiKey}
                  placeholder={current?.apiKeyConfigured ? (zh ? '已保存，留空保留现有密钥' : 'Saved; leave blank to keep the current key') : undefined}
                  onChange={(event) => {
                    const apiKey = event.currentTarget.value;
                    // 一旦开始输入新密钥，之前读出来的旧密钥立即丢弃。
                    setRevealedApiKey(null);
                    setDraft((value) => ({ ...value, apiKey }));
                  }}
                />
                <Button
                  size="compact"
                  aria-label={apiKeyVisible ? (zh ? '隐藏 API Key' : 'Hide API key') : zh ? '查看 API Key' : 'Show API key'}
                  aria-pressed={apiKeyVisible}
                  disabled={!current?.apiKeyConfigured || busy}
                  busy={status === 'revealing'}
                  onClick={() => void toggleApiKeyVisibility()}
                >
                  {apiKeyVisible ? <EyeSlashIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
                </Button>
              </span>
              {current?.apiKeyConfigured ? (
                <small>{zh ? '密钥只保存在本机钥匙串；点击眼睛查看当前密钥，每次查看都会写审计记录。' : 'Stored only in this Mac Keychain. Use the eye button to read the current key; every view is audited.'}</small>
              ) : null}
            </label>
            {draft.templateId === 'custom' ? (
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
            ) : null}
          </div>

          <label className="model-connection-enabled">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                changeDraft({ ...draft, enabled });
              }}
            />
            <span>{zh ? '允许项目使用此供应商' : 'Allow projects to use this provider'}</span>
          </label>

          <section className="model-definition-section">
            <header>
              <span>
                <strong>
                  {zh ? '已启用模型' : 'Enabled models'} <small>{enabledModelCount}</small>
                </strong>
                <small>
                  {zh
                    ? `获取模型只更新候选池（共 ${draft.models.length} 个）；下面只配置已勾选的模型，未勾选的候选不显示。`
                    : `Fetching only refreshes the candidate pool (${draft.models.length} in total). Only checked models are configured below; unchecked candidates stay hidden.`}
                </small>
              </span>
              <Button
                className="model-expand-all"
                variant="secondary"
                size="compact"
                disabled={filteredModels.length === 0}
                title={zh ? '作用于当前搜索结果的所有页面' : 'Applies to every page of the current search results'}
                onClick={() =>
                  setModelsExpanded(
                    filteredModels.map((model) => model.id),
                    !allModelsExpanded,
                  )
                }
              >
                {allModelsExpanded ? (zh ? '全部收起' : 'Collapse all') : zh ? '全部展开' : 'Expand all'}
              </Button>
            </header>
            {draft.models.length > 0 ? (
              <label className="model-enable-picker">
                <span>{zh ? '启用模型' : 'Enable models'}</span>
                <ZeusSelect
                  size="regular"
                  ariaLabel={zh ? '勾选要启用的模型' : 'Choose models to enable'}
                  value={enabledModelIds[0] ?? ''}
                  selectedValues={enabledModelIds}
                  triggerLabel={zh ? `已启用 ${enabledModelCount} 个模型` : `${enabledModelCount} enabled`}
                  options={enablePresentation.options}
                  searchable
                  searchPlaceholder={zh ? '搜索候选模型' : 'Search candidate models'}
                  onChange={toggleModelEnabled}
                />
                <small>{zh ? '下拉中勾选即启用，取消勾选即停用；候选模型不会自动启用。' : 'Check to enable and uncheck to disable; candidates are never enabled automatically.'}</small>
              </label>
            ) : null}
            <div className="model-definition-toolbar">
              {draft.models.length > 0 ? (
                <input
                  className="settings-list-search"
                  type="search"
                  aria-label={zh ? '搜索模型' : 'Search models'}
                  placeholder={zh ? '搜索模型名称' : 'Search model names'}
                  value={modelQuery}
                  onChange={(event) => {
                    setModelQuery(event.currentTarget.value);
                    setRequestedModelPage(1);
                  }}
                />
              ) : null}
              {draft.templateId === 'custom' || props.onComplete ? (
                <span className="model-add-row">
                  <input aria-label={zh ? '手工模型 ID' : 'Manual model ID'} placeholder={zh ? '手工模型 ID' : 'Manual model ID'} value={newModelId} onChange={(event) => setNewModelId(event.currentTarget.value)} />
                  <Button variant="secondary" size="compact" onClick={addManualModel} disabled={!newModelId.trim()}>
                    {zh ? '添加' : 'Add'}
                  </Button>
                </span>
              ) : null}
            </div>
            {enabledModelCount > 0 && filteredModels.length === 0 ? <p role="status">{zh ? '没有匹配的模型。' : 'No matching models.'}</p> : null}
            {enabledModelCount === 0 && draft.models.length > 0 ? (
              <p role="status">
                {zh ? '还没有启用模型。在上方“启用模型”下拉里勾选后，这里才会出现该模型的请求格式与登录方式。' : 'No models enabled yet. Check a model in the dropdown above to configure its request format and authentication here.'}
              </p>
            ) : null}
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
              {/* 设置与引导共用一层展开控件，避免连续展开两次才能修改模型。 */}
              {filteredModels.slice((modelPage - 1) * settingsPageSize, modelPage * settingsPageSize).map((model) => (
                <ModelDefinitionEditor
                  key={`${draft.id ?? 'new'}:${model.id}`}
                  language={props.language}
                  model={model}
                  expanded={expandedModelIds.has(model.id)}
                  onToggle={() => setModelsExpanded([model.id], !expandedModelIds.has(model.id))}
                  readOnly={draft.templateId !== 'custom'}
                  onChange={(next) => updateModel(model.id, () => next)}
                  onRemove={() => changeDraft({ ...draft, models: draft.models.filter((candidate) => candidate.id !== model.id) })}
                  reasoning={{ client: props.client, connectionId: draft.id, onSaved: () => reloadConnections(draft.id ?? undefined) }}
                />
              ))}
            </div>
            <SettingsPagination label={zh ? '可用模型' : 'Available models'} language={props.language} total={filteredModels.length} page={modelPage} onChange={setRequestedModelPage} />
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
              <span>{completionModelLabel}</span>
              <ZeusSelect size="regular" ariaLabel={completionModelLabel} value={defaultModelRef} onChange={setDefaultModelRef} options={selectableModels.map((model) => ({ value: model.id, label: model.displayName }))} />
              <small>
                {props.completionScope === 'conversation'
                  ? zh
                    ? '仅为当前项目启用。接入后返回草稿，确认后再发送。'
                    : 'Enable for this project only. Return to your draft to review and send.'
                  : props.completionScope === 'project'
                    ? zh
                      ? '仅为当前项目启用。接入后返回确认，不会开始执行。'
                      : 'Enable for this project only. Return to confirmation without starting the task.'
                    : zh
                      ? '只影响之后新建的项目。'
                      : 'Only affects new projects.'}{' '}
                {zh ? '模型目录可用不代表实际调用成功。' : 'A model listing does not verify actual calls.'}
              </small>
            </label>
          ) : null}
          <footer className="model-connection-actions">
            {!draft.id || props.onComplete || saveState === 'failed' ? (
              <Button variant="primary" size="compact" onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.baseUrl.trim()} busy={status === 'saving'}>
                {draft.id ? (zh ? '保存供应商' : 'Save provider') : zh ? '创建供应商' : 'Create provider'}
              </Button>
            ) : null}
            <Button variant="secondary" size="compact" onClick={() => void refreshModels()} disabled={busy || !draft.id || !current?.apiKeyConfigured} busy={status === 'refreshing'}>
              {zh ? '获取模型' : 'Fetch models'}
            </Button>
            <Button variant="secondary" size="compact" onClick={() => void diagnose()} disabled={busy || !draft.id}>
              {zh ? '服务诊断' : 'Diagnose service'}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              title={zh ? '对已启用模型真实发送一次请求，按观测结果更新工具、图片、流式、用量和推理档位' : 'Send one real request per enabled model and update tools, image, streaming, usage, and reasoning evidence'}
              onClick={() => void probeModels()}
              disabled={busy || !draft.id || !current?.apiKeyConfigured || enabledModelCount === 0}
              busy={status === 'probing'}
            >
              {zh ? '能力探测' : 'Probe capabilities'}
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
      <MotionPresence>
        {pendingInsecureHttpSave ? (
          props.onComplete ? (
            httpConfirmation
          ) : (
            <ModalPortal
              rootClassName="model-connection-http-risk-portal"
              dismissDisabled={busy}
              onDismiss={() => setPendingInsecureHttpSave(null)}
              role="dialog"
              aria-labelledby="model-connection-http-risk-title"
              aria-describedby="model-connection-http-risk-description"
            >
              {httpConfirmation}
            </ModalPortal>
          )
        ) : null}
      </MotionPresence>
    </section>
  );
}

/** 探测回执只陈述本次观测：未探测的模型必须写明，不能让人以为全都探测过了。 */
function describeProbeResult(summary: ModelCapabilityProbeSummary, zh: boolean): string {
  const succeeded = summary.results.filter((item) => item.ok).length;
  const failed = summary.results.length - succeeded;
  const skipped = summary.skippedModelIds.length > 0 ? (zh ? ` 本次未探测（单次上限 12 个）：${summary.skippedModelIds.join('、')}。` : ` Not probed (limit 12 per run): ${summary.skippedModelIds.join(', ')}.`) : '';
  if (summary.results.length === 0) return zh ? '没有已启用模型，未发起探测。请先在上方勾选要启用的模型。' : 'No enabled models, nothing was probed. Check the models you want to use first.';
  return (
    (zh
      ? `能力探测完成：${succeeded} 个模型成功完成真实请求，${failed} 个失败；逐模型结论见各卡片展开后的“能力探测”。`
      : `Capability probe finished: ${succeeded} models answered a real request, ${failed} failed. Per-model findings are in each card.`) + skipped
  );
}

/** 档位覆盖、逐档体检、最近一次实际发送共用的上下文；没有客户端时这些动作整体不可用。 */
interface ModelReasoningContext {
  client: ModelConnectionClient | null;
  /** 已保存的连接 ID；新连接还没落库时为 null。 */
  connectionId: string | null;
  /** 覆盖保存后重新载入连接，界面继续用服务端判定出来的档位。 */
  onSaved: () => Promise<void>;
}

/**
 * 模型推理档位的三件事：手工覆盖清单、逐档体检、以及最近一次真实发送的档位。
 * 覆盖会写进配置并立刻生效；体检只出证据，绝不改配置。
 */
function ModelReasoningSection(props: { language: 'zh-CN' | 'en-US'; model: ModelConnectionModel; context: ModelReasoningContext }) {
  const zh = props.language === 'zh-CN';
  const profile = props.model.capability.reasoning;
  const [rows, setRows] = useState<ModelReasoningOverrideRow[]>(() => profile.options.map((option) => ({ id: option.id, piLevel: option.piLevel, wire: option.wire ?? '' })));
  const [defaultId, setDefaultId] = useState<string>(profile.defaultId ?? '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'auditing' | 'loading'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [audit, setAudit] = useState<ModelReasoningAuditResult | null>(null);
  const [lastSent, setLastSent] = useState<{ effort: string | null; observedAt: string | null } | null>(null);
  const busy = status !== 'idle';

  /** 清单变化（保存、恢复自动判定、切换模型）时把编辑草稿同步回服务端事实。 */
  useEffect(() => {
    setRows(profile.options.map((option) => ({ id: option.id, piLevel: option.piLevel, wire: option.wire ?? '' })));
    setDefaultId(profile.defaultId ?? '');
    setAudit(null);
    setMessage(null);
  }, [profile.defaultId, profile.options, props.model.id]);
  useEffect(() => {
    const client = props.context.client;
    const connectionId = props.context.connectionId;
    if (!client || !connectionId) return;
    let active = true;
    setStatus('loading');
    void client
      .loadModelConnectionLastSent(connectionId, props.model.id)
      .then((result) => {
        if (active) setLastSent(result);
      })
      .catch(() => {
        if (active) setLastSent(null);
      })
      .finally(() => {
        if (active) setStatus('idle');
      });
    return () => {
      active = false;
    };
  }, [props.context.client, props.context.connectionId, props.model.id]);

  function updateRow(index: number, patch: Partial<ModelReasoningOverrideRow>): void {
    setRows((value) => value.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  }

  /** 把编辑草稿提交给服务端；校验交给服务端一处完成，界面只负责把错误原样显示。 */
  async function saveOverride(input: ModelReasoningOverrideRow[] | null): Promise<void> {
    const client = props.context.client;
    const connectionId = props.context.connectionId;
    if (!client || !connectionId || busy) return;
    setStatus('saving');
    try {
      if (input === null) {
        await client.saveModelConnectionReasoningOptions(connectionId, props.model.id, null);
        setMessage(zh ? '已恢复自动判定：档位重新按官方档案、模型目录或家族推断决定。' : 'Restored automatic detection.');
      } else {
        await client.saveModelConnectionReasoningOptions(connectionId, props.model.id, {
          options: input.map((row) => ({ id: row.id.trim(), piLevel: row.piLevel, wire: row.wire.trim() ? row.wire.trim() : null })),
          defaultId: defaultId.trim() ? defaultId.trim() : null,
        });
        setMessage(zh ? '已按你的清单生效；只有清空才回到自动判定。' : 'Saved. It stays until you clear it.');
      }
      await props.context.onSaved();
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  /** 逐档体检：每个档位各一次真实请求，只出证据不写配置。 */
  async function runAudit(): Promise<void> {
    const client = props.context.client;
    const connectionId = props.context.connectionId;
    if (!client || !connectionId || busy) return;
    setStatus('auditing');
    try {
      setAudit(await client.auditModelConnectionReasoningLevels(connectionId, props.model.id));
      setMessage(null);
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  const piLevelOptions = PI_THINKING_LEVELS.map((level) => ({ value: level, label: level }));
  return (
    <div className="model-reasoning-controls">
      <dt>{zh ? '档位设置' : 'Reasoning levels'}</dt>
      <dd>
        <table className="model-reasoning-table">
          <thead>
            <tr>
              <th>{zh ? '页面可选（厂商词）' : 'Shown'}</th>
              <th>{zh ? 'Pi 传输' : 'Pi level'}</th>
              <th>{zh ? '实际发送' : 'Wire value'}</th>
              <th>{zh ? '默认' : 'Default'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.id}:${index}`}>
                <td>
                  <input aria-label={zh ? '页面档位名' : 'Shown level'} value={row.id} disabled={busy} onChange={(event) => updateRow(index, { id: event.currentTarget.value })} />
                </td>
                <td>
                  <ZeusSelect<ModelThinkingLevel> ariaLabel={zh ? 'Pi 档位' : 'Pi level'} size="compact" value={row.piLevel} disabled={busy} options={piLevelOptions} onChange={(piLevel) => updateRow(index, { piLevel })} />
                </td>
                <td>
                  <input
                    aria-label={zh ? '实际发送取值' : 'Wire value'}
                    placeholder={zh ? '留空表示不发送取值' : 'blank = send no value'}
                    value={row.wire}
                    disabled={busy}
                    onChange={(event) => updateRow(index, { wire: event.currentTarget.value })}
                  />
                </td>
                <td>
                  <input type="radio" name={`reasoning-default-${props.model.id}`} aria-label={zh ? `默认档位 ${row.id}` : `Default level ${row.id}`} checked={defaultId === row.id} disabled={busy} onChange={() => setDefaultId(row.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <span className="model-reasoning-actions">
          <Button size="compact" variant="secondary" disabled={busy || rows.length === 0} onClick={() => setRows((value) => [...value, { id: '', piLevel: 'medium', wire: '' }])}>
            {zh ? '增加一档' : 'Add level'}
          </Button>
          <Button size="compact" variant="secondary" disabled={busy} onClick={() => setRows((value) => value.slice(0, -1))}>
            {zh ? '减少一档' : 'Remove last'}
          </Button>
          <Button size="compact" disabled={busy || props.context.connectionId === null} busy={status === 'saving'} onClick={() => void saveOverride(rows)}>
            {zh ? '保存清单' : 'Save list'}
          </Button>
          <Button size="compact" variant="secondary" disabled={busy || props.context.connectionId === null} onClick={() => void saveOverride(null)}>
            {zh ? '恢复自动判定' : 'Reset to automatic'}
          </Button>
          <Button size="compact" variant="secondary" disabled={busy || props.context.connectionId === null || profile.options.length === 0} busy={status === 'auditing'} onClick={() => void runAudit()}>
            {zh ? '逐档体检' : 'Audit each level'}
          </Button>
        </span>
        <small>
          {zh
            ? '体检会对每个档位各发一次真实请求并比较思考用量，是唯一能证明档位真的传到了模型的手段；它只出证据，不改配置。'
            : 'Auditing sends one real request per level and compares reasoning usage. It only reports evidence and never changes configuration.'}
        </small>
        {message ? <small className="model-reasoning-message">{message}</small> : null}
        {audit ? (
          <table className="model-reasoning-table">
            <thead>
              <tr>
                <th>{zh ? '档位' : 'Level'}</th>
                <th>{zh ? '请求' : 'Request'}</th>
                <th>{zh ? '看到思考' : 'Thinking seen'}</th>
                <th>{zh ? '思考 token' : 'Reasoning tokens'}</th>
              </tr>
            </thead>
            <tbody>
              {audit.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.id}</td>
                  <td>{entry.ok ? (zh ? '成功' : 'ok') : (entry.failure ?? (zh ? '失败' : 'failed'))}</td>
                  <td>{entry.thinkingSeen ? (zh ? '是' : 'yes') : zh ? '否' : 'no'}</td>
                  <td>{entry.reasoningTokens ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {audit ? <small className="model-reasoning-message">{audit.verdict}</small> : null}
        <small>
          {zh ? '最近一次实际发送：' : 'Last actually sent: '}
          {lastSent?.effort ? `${lastSent.effort}${lastSent.observedAt ? `（${lastSent.observedAt}）` : ''}` : zh ? '暂无记录' : 'no record yet'}
        </small>
      </dd>
    </div>
  );
}

/** 手工覆盖清单里的一行；wire 用空串表示"不发送取值"，提交前再还原成 null。 */
interface ModelReasoningOverrideRow {
  id: string;
  piLevel: ModelThinkingLevel;
  wire: string;
}

/** 能力证据只展示真实观测过的内容；没探测过的模型不显示空话。 */
function ModelCapabilityFacts(props: { language: 'zh-CN' | 'en-US'; model: ModelConnectionModel; reasoning?: ModelReasoningContext }) {
  const zh = props.language === 'zh-CN';
  const capability = props.model.capability;
  /** 四项独立探测结论，供合并展示与逐项展示共用。 */
  const rows: Array<{ label: string; evidence: ModelCapabilityEvidence }> = [
    { label: zh ? '工具调用' : 'Tool calling', evidence: capability.tools },
    { label: zh ? '图片输入' : 'Image input', evidence: capability.imageInput },
    { label: zh ? '流式输出' : 'Streaming', evidence: capability.streaming },
    { label: zh ? '用量字段' : 'Usage fields', evidence: capability.usage },
  ];
  const probed = rows.some((row) => row.evidence.source === 'probe') || capability.reasoning.checkedAt !== null;
  /** 版本优先级：真机观测 > 人工官方表 > 目录名/模型 ID；表会过期，所以真实观测永远赢。 */
  const observedVersion = props.model.servedModelId && props.model.servedModelId !== props.model.id ? props.model.servedModelId : null;
  const versionValue = observedVersion ?? props.model.officialVersion ?? props.model.displayName;
  const versionSource = observedVersion
    ? zh
      ? '服务端实际返回'
      : 'reported by the server'
    : props.model.officialVersion
      ? zh
        ? '官方文档登记，未真机验证'
        : 'from the official doc table, not machine-verified'
      : zh
        ? '上游目录名或模型 ID'
        : 'catalog name or model id';
  if (!probed && !props.model.officialVersion && !observedVersion) return null;
  /** 探测整体失败时多项会共享同一原因，合并成一行，避免同一句话重复多遍；图片声明等独立证据仍单独列出。 */
  const firstProbeRow = rows.find((row) => row.evidence.source === 'probe');
  const probeRows = rows.filter((row) => row.evidence.source === 'probe');
  const sharedReason = firstProbeRow && probeRows.length > 1 && probeRows.every((row) => row.evidence.reason === firstProbeRow.evidence.reason) ? firstProbeRow.evidence.reason : null;
  return (
    <dl className="model-route-facts">
      <div>
        <dt>{zh ? '模型版本' : 'Model version'}</dt>
        <dd>
          {versionValue}
          <small>{zh ? `（${versionSource}）` : ` (${versionSource})`}</small>
        </dd>
      </div>
      {sharedReason ? (
        <div>
          <dt>{zh ? '能力探测' : 'Capability probe'}</dt>
          <dd>{sharedReason}</dd>
        </div>
      ) : null}
      {rows
        .filter((row) => !sharedReason || row.evidence.source !== 'probe')
        .map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{capabilityEvidenceLabel(row.evidence, zh)}</dd>
          </div>
        ))}
      <div>
        <dt>{zh ? '推理档位' : 'Reasoning levels'}</dt>
        <dd>
          {capability.reasoning.options.length === 0
            ? zh
              ? '未识别：跟随模型默认，不发送任何档位字段'
              : 'Unidentified: follow the model default and send no thinking field'
            : capability.reasoning.options.map((option) => option.label || option.id).join(' / ')}
          {' · '}
          {reasoningBasisLabel(capability.reasoning.basis, zh)}
        </dd>
      </div>
      {props.reasoning?.connectionId ? <ModelReasoningSection language={props.language} model={props.model} context={props.reasoning} /> : null}
      {capability.reasoning.options.length > 0 ? (
        <div className="model-capability-reasoning-table">
          <dt>{zh ? '档位换算' : 'Level mapping'}</dt>
          <dd>
            <table>
              <thead>
                <tr>
                  <th>{zh ? '页面可选' : 'Shown'}</th>
                  <th>{zh ? 'Pi 传输' : 'Pi level'}</th>
                  <th>{zh ? '实际发送' : 'Wire value'}</th>
                </tr>
              </thead>
              <tbody>
                {capability.reasoning.options.map((option) => (
                  <tr key={option.id}>
                    <td>{option.label || option.id}</td>
                    <td>{option.piLevel}</td>
                    <td>{option.wire ?? (zh ? '不发送取值' : 'no value')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * 档位清单的来源标签。
 * 「真实支持」只有官方文档和真机逐档体检能确认，所以推断出来的来源必须写明是推断。
 */
function reasoningBasisLabel(basis: ModelReasoningBasis, zh: boolean): string {
  if (basis === 'official_endpoint') return zh ? '依据：官方端点声明' : 'Basis: official endpoint';
  if (basis === 'catalog') return zh ? '依据：内置目录声明（未逐档真机验证）' : 'Basis: built-in catalog (not verified level by level)';
  if (basis === 'catalog_default') return zh ? '依据：目录默认假设，未验证' : 'Basis: catalog default assumption, unverified';
  if (basis === 'model_name') return zh ? '依据：按模型名推断，未验证' : 'Basis: inferred from model name, unverified';
  if (basis === 'user') return zh ? '依据：你手工指定' : 'Basis: set by you';
  return zh ? '依据：未识别' : 'Basis: unidentified';
}

/** 目录声明不是真机结论，措辞必须和探测结果区分开。 */
function capabilityEvidenceLabel(evidence: ModelCapabilityEvidence, zh: boolean): string {
  const fromProbe = evidence.source === 'probe';
  if (evidence.state === 'supported') return fromProbe ? (zh ? '已确认支持' : 'Confirmed supported') : zh ? '目录声明支持' : 'Declared by catalog';
  if (evidence.state === 'unsupported') return fromProbe ? (zh ? '已确认不支持' : 'Confirmed unsupported') : zh ? '目录声明不支持' : 'Not in catalog support';
  return fromProbe ? evidence.reason : zh ? '未验证' : 'Unverified';
}

function requiresInsecureHttpConfirmation(baseUrl: string, existingBaseUrl?: string): boolean {
  try {
    const normalized = new URL(baseUrl.trim()).toString().replace(/\/+$/u, '');
    return normalized.startsWith('http://') && normalized !== existingBaseUrl;
  } catch {
    return false;
  }
}

/** 模型标题独立控制展开；启用、移除和配置修改沿用各自的业务入口。 */
function ModelDefinitionEditor(props: {
  language: 'zh-CN' | 'en-US';
  model: ModelConnectionModel;
  readOnly: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChange: (model: ModelConnectionModel) => void;
  onRemove: () => void;
  reasoning?: ModelReasoningContext;
}) {
  /** 将展开按钮与详细配置关联。 */
  const detailsId = useId();
  const zh = props.language === 'zh-CN';
  const model = props.model;
  /** 目录已明确容量时展示真实值，避免手工勾选在保存后被目录恢复。 */
  const contextDeclaration =
    model.contextWindowSource === 'catalog' ? (
      <span className="model-context-declaration-label">{model.contextWindow >= 1_000_000 ? `${model.contextWindow / 1_000_000}M` : `${model.contextWindow / 1_000}K`}</span>
    ) : (
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
        <span className="model-definition-enabled-state" data-enabled={model.enabled ? 'true' : 'false'}>
          {model.enabled ? (zh ? '已启用' : 'Enabled') : zh ? '候选' : 'Candidate'}
        </span>
        <button type="button" className="model-definition-identity" onClick={props.onToggle} aria-expanded={props.expanded} aria-controls={detailsId}>
          <span>
            <strong title={model.displayName || model.id}>{model.displayName || model.id}</strong>
            <small>{model.displayName && model.displayName !== model.id ? `${model.id} · ${modelRouteLabel(model, zh)}` : modelRouteLabel(model, zh)}</small>
          </span>
          <CaretDownIcon className="model-definition-chevron" aria-hidden="true" />
        </button>
        {props.readOnly ? null : (
          <button className="model-definition-remove" type="button" onClick={props.onRemove} aria-label={zh ? `移除模型 ${model.id}` : `Remove model ${model.id}`} title={zh ? '移除模型' : 'Remove model'}>
            <X aria-hidden="true" weight="bold" />
          </button>
        )}
      </header>
      <Collapsible id={detailsId} open={props.expanded}>
        <div className="model-definition-details">
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
          <ModelCapabilityFacts language={props.language} model={model} {...(props.reasoning ? { reasoning: props.reasoning } : {})} />
        </div>
      </Collapsible>
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
    protocolFamily: 'openai_completions',
    authenticationScheme: 'protocol_default',
    capability: {
      reasoning: {
        state: 'unverified',
        // 新模型先进「未识别」：界面不给档位下拉，请求也不发档位字段，等保存时按连接判定清单。
        options: [],
        defaultId: null,
        thinkingFormat,
        basis: 'unidentified',
        checkedAt: null,
      },
      tools: evidence('尚未检测工具调用功能。'),
      imageInput: evidence('尚未检测图片输入功能。'),
      streaming: evidence('尚未检测逐步显示回复的功能。'),
      usage: evidence('尚未检测服务是否提供用量信息。'),
    },
  };
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

function cloneModel(model: ModelConnectionModel): ModelConnectionModel {
  return {
    ...model,
    capability: {
      reasoning: { ...model.capability.reasoning, options: model.capability.reasoning.options.map((option) => ({ ...option })) },
      tools: { ...model.capability.tools },
      imageInput: { ...model.capability.imageInput },
      streaming: { ...model.capability.streaming },
      usage: { ...model.capability.usage },
    },
  };
}
