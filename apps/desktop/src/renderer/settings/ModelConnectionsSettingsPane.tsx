import { formatZeusDateTime, type MeteredCharge, type ModelPrice } from '@zeus/shared';
import { MotionPresence } from '../ui/MotionPresence.js';
import { SettingsSaveStatus, type SettingsSaveState } from './useSettingsAutosave.js';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ModelConnectionQueryStore, modelConnectionQueryStore, type ModelConnectionJob } from '../features/integrations/modelConnectionQueryStore.js';
import { codexCapabilitiesChangedEvent } from '../features/integrations/modelCatalogEvents.js';
import { ResourceLoading } from '../ui/ResourceLoading.js';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { EyeSlashIcon } from '@phosphor-icons/react/dist/csr/EyeSlash';
import { GearIcon } from '@phosphor-icons/react/dist/csr/Gear';
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
import { compareModelNames, modelProviderOption, presentModelOptions, type ModelOptionSource } from '../modelOptionPresentation.js';
import { ModelProviderBadge } from '../modelProviderAppearance.js';
import { readModelConnectionIcon } from './modelConnectionIcon.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { useHoverIntent } from '../ui/useHoverIntent.js';
import { FormDialog } from '../ui/FormDialog.js';
import { SettingsPagination, settingsPage, settingsPageSize } from './SettingsPagination.js';

/** 编辑中的供应商；密钥只在当前编辑器内存中短暂保留。 */
interface ModelConnectionDraft extends Omit<SaveModelConnectionRequest, 'pricingUrl'> {
  id: string | null;
  apiKey: string;
}

/** 沿用已有供应商模板的地址与模型目录。 */
/** Pi 认识的七个档位词；手工覆盖档位时用户从这里选，界面显示的仍是自己填的厂商词。 */
const PI_THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const templateDefaults: Record<ModelConnectionTemplateId, { name: string; baseUrl: string; modelsPath: string; thinkingFormat: ModelThinkingFormat }> = {
  custom: { name: '', baseUrl: '', modelsPath: '/models', thinkingFormat: 'openai' },
  kilo: { name: 'Kilo', baseUrl: 'https://ai-gateway.kilo.ai/api/v1', modelsPath: '/models', thinkingFormat: 'openrouter' },
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
  | 'refreshModelConnectionPricing'
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
  /** 价格输入的标签与相邻更新按钮独立关联。 */
  const pricingInputId = useId();
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
  /** 列表和后台操作由当前客户端持有，设置页切换不会清空已有供应商。 */
  const query = useMemo(() => (props.client ? modelConnectionQueryStore(props.client) : new ModelConnectionQueryStore({ loadModelConnections: async () => [] })), [props.client]);
  const connectionSnapshot = useSyncExternalStore(query.connections.subscribe, query.connections.getSnapshot, query.connections.getSnapshot);
  const jobs = useSyncExternalStore(query.subscribe, query.getSnapshot, query.getSnapshot);
  const connections = connectionSnapshot.value ?? [];
  const [draft, setDraft] = useState<ModelConnectionDraft>(() => {
    const cached = query.connections.getSnapshot().value;
    const selected = !props.onComplete ? (cached?.find((connection) => connection.id === query.selectedConnectionId) ?? cached?.[0]) : undefined;
    return selected ? connectionDraft(selected) : emptyDraft();
  });
  /** 图片解码期间草稿仍可输入，合并到同一连接的最新表单。 */
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  /** 子编辑器保存期间允许切换供应商，迟到回执只更新原连接。 */
  const selectedConnectionId = useRef(draft.id);
  /** 文件选择仅由按钮触发，错误显示在字段旁。 */
  const iconInput = useRef<HTMLInputElement>(null);
  const [iconError, setIconError] = useState<string | null>(null);
  selectedConnectionId.current = draft.id;
  const [newModelId, setNewModelId] = useState('');
  /** 搜索和分页只改变展示，不影响供应商保存的模型集合。 */
  const [modelQuery, setModelQuery] = useState('');
  /** 切换供应商或筛选时回到第一页。 */
  const [requestedModelPage, setRequestedModelPage] = useState(1);
  /** 展开只属于当前编辑器，跨搜索和分页保留，不写入模型配置。 */
  const [expandedModelIds, setExpandedModelIds] = useState<ReadonlySet<string>>(() => new Set());
  const [localStatus, setStatus] = useState<'idle' | 'loading' | 'saving' | 'refreshing' | 'probing' | 'deleting' | 'revealing'>('idle');
  /** 当前编辑器只等待自己的远端操作，列表导航不受其他连接影响。 */
  const job = draft.id ? jobs[draft.id] : undefined;
  const status = localStatus === 'idle' && job?.pending ? (job.kind === 'diagnosing' ? 'loading' : job.kind) : localStatus;
  /** 新建、选择与异步首屏回填使用同一个选择代次。 */
  const selectionRevision = useRef(0);
  /** 首屏后台校准不能覆盖用户已经修改的草稿。 */
  const draftRevision = useRef(0);
  /** 同一个后台回执只应用一次，保留用户后续编辑。 */
  const appliedJob = useRef<ModelConnectionJob | null>(null);
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
  /** 价格地址单独编辑，普通供应商保存不会提交此草稿。 */
  const [pricingUrlDraft, setPricingUrlDraft] = useState<{ connectionId: string | null; value: string } | null>(null);
  /** 价目令牌只在价格源弹窗的临时状态中存在。 */
  const [pricingSourceDraft, setPricingSourceDraft] = useState<{ profile: string; token: string } | null>(null);

  useEffect(() => {
    let active = true;
    if (!props.client) {
      return () => {
        active = false;
      };
    }
    const revision = selectionRevision.current;
    const editRevision = draftRevision.current;
    const cached = query.connections.getSnapshot().value;
    void query.connections
      .load(true)
      .then((items) => {
        if (!active) return;
        if (!props.onComplete && selectionRevision.current === revision && draftRevision.current === editRevision) {
          const selected = items.find((item) => item.id === selectedConnectionId.current) ?? (!selectedConnectionId.current ? items[0] : undefined);
          if (selected && cached?.find((item) => item.id === selected.id)?.updatedAt !== selected.updatedAt) selectConnection(selected);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
      });
    return () => {
      active = false;
    };
  }, [props.client, query]);
  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      query.connections.invalidate();
      void query.connections.load().catch((error: unknown) => {
        if (active) setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
      });
    };
    window.addEventListener(codexCapabilitiesChangedEvent, refresh);
    return () => {
      active = false;
      window.removeEventListener(codexCapabilitiesChangedEvent, refresh);
    };
  }, [query, zh]);

  const busy = status !== 'idle';
  /** 只有正在保存或删除的表单暂时保护导航；远端检查不锁整个设置页。 */
  const navigationBusy = localStatus === 'saving' || localStatus === 'deleting' || localStatus === 'revealing';
  useEffect(() => {
    props.onBusyChange?.(navigationBusy);
    return () => props.onBusyChange?.(false);
  }, [navigationBusy, props.onBusyChange]);
  useEffect(() => {
    if (props.active !== false) return;
    setPricingSourceDraft(null);
    setDraft((value) => ({ ...value, apiKey: '' }));
    setPendingInsecureHttpSave(null);
  }, [props.active]);
  const current = draft.id ? (connections.find((connection) => connection.id === draft.id) ?? null) : null;
  /** null 表示本次恢复默认，undefined 时显示已保存图标。 */
  const draftAppearance = { sourceId: draft.id ?? undefined, sourceName: draft.name, templateId: draft.templateId, iconDataUrl: draft.iconDataUrl === undefined ? (current?.iconDataUrl ?? null) : draft.iconDataUrl };
  /** 已保存的地址为空时，显示目录使用的默认来源。 */
  const savedPricingUrl = current?.pricingUrl || current?.pricingCatalog?.url || '';
  /** 只展示当前供应商的草稿，包括有意清空的地址。 */
  const currentPricingUrlDraft = pricingUrlDraft?.connectionId === draft.id ? pricingUrlDraft : null;
  /** 编辑时展示草稿，未编辑时展示已生效的来源。 */
  const pricingUrl = currentPricingUrlDraft?.value ?? savedPricingUrl;
  /** 地址提交前不能给草稿配置令牌，令牌只会绑定已生效的来源。 */
  const pricingUrlChanged = pricingUrl.trim() !== savedPricingUrl;
  /** 更换连接时清除上一条连接的价格草稿和密钥。 */
  useEffect(() => {
    setPricingUrlDraft(null);
    setPricingSourceDraft(null);
    setRevealedApiKey(null);
    setApiKeyVisible(false);
  }, [draft.id]);
  useEffect(() => {
    if (!job || job.pending || appliedJob.current === job) return;
    appliedJob.current = job;
    if (job.error) {
      setMessage(formatVisibleApplicationError(job.error, zh ? 'zh-CN' : 'en'));
      return;
    }
    const result = job.result;
    if (!result) return;
    if ('stage' in result) {
      setDiagnostic(result);
      return;
    }
    const updated = query.connections.getSnapshot().value?.find((item) => item.id === draft.id);
    if (updated) selectConnection(updated);
    if ('results' in result) setMessage(describeProbeResult(result, zh));
    else if ('discoveredModelIds' in result)
      setMessage(
        zh
          ? `候选池已同步：共 ${result.discoveredModelIds.length} 个模型，新增 ${result.addedModelIds.length} 个，移除 ${result.removedModelIds.length} 个。新模型默认未启用，请在“启用模型”中勾选。`
          : `Candidate pool synced: ${result.discoveredModelIds.length} discovered, ${result.addedModelIds.length} added, ${result.removedModelIds.length} removed. New models stay disabled until selected.`,
      );
  }, [job, draft.id, query, zh]);
  /** 界面列表只展示已启用模型：没勾选的候选只留在大纲下拉里，避免几十个候选刷屏。 */
  const enabledModels = draft.models.filter((model) => model.enabled).sort((left, right) => compareModelNames(left.displayName?.trim() || left.id, right.displayName?.trim() || right.id) || compareModelNames(left.id, right.id));
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
    ...draftAppearance,
    available: true,
    supports1MContext: model.supports1MContext,
    speedLabel: model.speedLabel,
  }));
  const enablePresentation = presentModelOptions(candidateModelOptions, '', props.language);
  const enabledModelIds = enabledModels.map((model) => model.id);
  const enabledModelCount = enabledModelIds.length;
  /** 价格覆盖按正在展示的已启用模型计算，包含价目表未列出的模型。 */
  const pricingCatalog = current?.pricingCatalog;
  const pricedModelIds = new Set(pricingCatalog?.prices.map((price) => price.model));
  const missingPriceCount = pricingCatalog ? enabledModelIds.filter((id) => !pricedModelIds.has(id)).length : 0;
  /** 只有读取失败且仍可使用已确认的费率时，才说明沿用上次费率。 */
  const priceFailureSummary = pricingCatalog?.prices.length ? (zh ? '读取价格失败，沿用上次费率' : 'Price refresh failed. Using previous rates.') : zh ? '读取价格失败' : 'Price refresh failed';

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
    selectedConnectionId.current = connection.id;
    query.selectedConnectionId = connection.id;
    selectionRevision.current += 1;
    setSaveState('idle');
    setIconError(null);
    setModelQuery('');
    setRequestedModelPage(1);
    if (connection.id !== draft.id) setExpandedModelIds(new Set());
    setDraft(connectionDraft(connection));
    modelRequestRef.current += 1;
    setDefaultModelRef('');
    setSelectableModels([]);
    if (props.onComplete) void refreshDefaultModels(connection.id).catch((error) => setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en')));
    setDiagnostic(null);
    setMessage(null);
  }

  /** 文字输入结束保存，选择项立即保存；新建和接入引导仍显式创建。 */
  function changeDraft(next: ModelConnectionDraft): void {
    draftRevision.current += 1;
    setDraft(next);
    setSaveState('idle');
    if (next.id && !props.onComplete) void save(next);
  }

  /** 文件解码结束时仍须属于同一份未变更的草稿。 */
  async function replaceIcon(file: File): Promise<void> {
    const revision = ++draftRevision.current;
    const selection = selectionRevision.current;
    setIconError(null);
    try {
      const iconDataUrl = await readModelConnectionIcon(file);
      if (draftRevision.current === revision && selectionRevision.current === selection) changeDraft({ ...latestDraft.current, iconDataUrl });
    } catch {
      if (draftRevision.current === revision && selectionRevision.current === selection) setIconError(zh ? '请选择不超过 1 MB 的有效 PNG、JPEG 或 WebP 图片。' : 'Choose a valid PNG, JPEG, or WebP image up to 1 MB.');
    }
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
    query.connections.set(items);
    const selected = items.find((connection) => connection.id === preferredId);
    if (selected && selectedConnectionId.current === preferredId) selectConnection(selected);
  }

  /** 创建供应商时允许初始化价格地址，已有供应商的地址由价格操作单独提交。 */
  function createSaveInput(value = draft): SaveModelConnectionRequest {
    return {
      name: value.name,
      templateId: value.templateId,
      baseUrl: value.baseUrl,
      modelsPath: value.modelsPath,
      ...(value.id === null ? { pricingUrl: pricingUrl.trim() } : {}),
      enabled: value.enabled,
      models: value.models,
      ...(value.iconDataUrl !== undefined && value.iconDataUrl !== (current?.iconDataUrl ?? null) ? { iconDataUrl: value.iconDataUrl } : {}),
      ...(value.apiKey.trim() ? { apiKey: value.apiKey.trim() } : {}),
    };
  }

  /** 用户点击更新时才应用价格地址；地址未变时直接读取清单。 */
  async function refreshPricing(): Promise<void> {
    if (!props.client || busy || !current) return;
    setMessage(null);
    const client = props.client;
    /** 本次提交使用点击时的地址，不包含其他字段的草稿。 */
    const nextPricingUrl = pricingUrl.trim();
    await query.run(current.id, 'refreshing', async () => {
      if (pricingUrlChanged) {
        /** 地址已经生效时立即同步回执，即使接下来的价格读取失败。 */
        const saved = await client.updateModelConnection(current.id, { ...createSaveInput({ ...current, apiKey: '' }), pricingUrl: nextPricingUrl });
        query.upsert(saved);
      }
      setPricingUrlDraft((pending) => (pending === currentPricingUrlDraft ? null : pending));
      return client.refreshModelConnectionPricing(current.id);
    });
  }

  /** 保存供应商配置并按连接 ID 更新列表和编辑器。 */
  async function persistConnection(input: SaveModelConnectionRequest): Promise<void> {
    if (!props.client || busy || savingRef.current) return;
    savingRef.current = true;
    setStatus('saving');
    setSaveState('saving');
    setMessage(null);
    try {
      const saved = draft.id ? await props.client.updateModelConnection(draft.id, input) : await props.client.createModelConnection(input);
      query.upsert(saved);
      setRevealedApiKey(null);
      setApiKeyVisible(false);
      setDraft(connectionDraft(saved));
      setSaveState('saved');
      setPricingSourceDraft(null);
      if (props.onComplete) await refreshDefaultModels(saved.id);
    } catch (error) {
      setSaveState('failed');
      if (input.iconDataUrl !== undefined) setDraft((value) => ({ ...value, iconDataUrl: undefined }));
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
    setMessage(null);
    const client = props.client;
    const id = draft.id;
    await query.run(id, 'refreshing', () => client.refreshModelConnectionModels(id));
  }

  /** 对已启用模型真实探测一次；探测结果由后端落库，界面只负责刷新与回执。 */
  async function probeModels(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setMessage(null);
    const client = props.client;
    const id = draft.id;
    await query.run(id, 'probing', () => client.probeModelConnectionModels(id));
  }

  async function diagnose(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setMessage(null);
    const client = props.client;
    const id = draft.id;
    await query.run(id, 'diagnosing', () => client.diagnoseModelConnection(id));
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
      const updated = await props.client.clearModelConnectionApiKey(draft.id);
      query.upsert(updated);
      selectConnection(updated);
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
      query.remove(draft.id);
      selectedConnectionId.current = null;
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
            return persistConnection({ ...input, allowInsecureHttp: true });
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
        {!props.onComplete ? (
          <span>
            <strong>{zh ? '自定义供应商' : 'Custom providers'}</strong>
          </span>
        ) : null}
        <span className="settings-heading-actions">
          {!props.onSaveStateChange ? <SettingsSaveStatus status={saveState} language={props.language} /> : null}
          <Button
            hidden={Boolean(props.onComplete)}
            variant="secondary"
            size="compact"
            onClick={() => {
              selectionRevision.current += 1;
              selectedConnectionId.current = null;
              query.selectedConnectionId = null;
              setDraft(emptyDraft());
              setIconError(null);
              setPricingUrlDraft(null);
              setModelQuery('');
              setRequestedModelPage(1);
              setExpandedModelIds(new Set());
              setDiagnostic(null);
              setMessage(null);
            }}
            disabled={navigationBusy}
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
          options={[
            { value: '', label: zh ? '新建供应商' : 'New provider' },
            ...connections.map((connection) => ({
              value: connection.id,
              label: connection.name,
              ...modelProviderOption({ sourceId: connection.id, sourceName: connection.name, templateId: connection.templateId, iconDataUrl: connection.iconDataUrl }),
            })),
          ]}
          disabled={navigationBusy}
          onChange={(id) => {
            const connection = connections.find((item) => item.id === id);
            if (connection) selectConnection(connection);
            else {
              selectionRevision.current += 1;
              selectedConnectionId.current = null;
              query.selectedConnectionId = null;
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
        <nav hidden={Boolean(props.onComplete)} className="model-connection-list" aria-label={zh ? '模型供应商列表' : 'Model provider list'} aria-busy={connectionSnapshot.loading || undefined}>
          {connectionSnapshot.loading ? (
            <span className="model-connection-list-loading">
              <ResourceLoading label={zh ? '读取供应商' : 'Loading providers'} />
            </span>
          ) : connectionSnapshot.value && connections.length === 0 ? (
            <p>{zh ? '还没有模型供应商。' : 'No model providers yet.'}</p>
          ) : null}
          {connections.map((connection) => (
            <Button
              unstyled
              key={connection.id}
              type="button"
              className={draft.id === connection.id ? 'selected' : ''}
              aria-current={draft.id === connection.id ? 'true' : undefined}
              disabled={navigationBusy}
              aria-busy={jobs[connection.id]?.pending || undefined}
              data-busy-behavior="background"
              onClick={() => selectConnection(connection)}
            >
              <span>
                <strong className="model-connection-name">
                  <ModelProviderBadge sourceId={connection.id} sourceName={connection.name} templateId={connection.templateId} iconDataUrl={connection.iconDataUrl} />
                  <span>{connection.name}</span>
                </strong>
                <small>
                  {connection.models.length} {zh ? '个模型' : 'models'}
                </small>
              </span>
              <em data-pending={jobs[connection.id]?.pending || undefined} data-configured={connection.apiKeyConfigured || undefined}>
                {jobs[connection.id]?.pending ? (zh ? '进行中' : 'Working') : connection.apiKeyConfigured ? (zh ? '密钥已保存' : 'Key saved') : zh ? '未配置密钥' : 'No key'}
              </em>
            </Button>
          ))}
        </nav>

        <fieldset disabled={busy} className="model-connection-editor" key={draft.id ?? 'new'} aria-label={zh ? '模型供应商编辑器' : 'Model provider editor'}>
          <div className="model-connection-icon-editor">
            <span>{zh ? '供应商图标' : 'Provider icon'}</span>
            <ModelProviderBadge {...draftAppearance} />
            <Button variant="secondary" size="compact" type="button" onClick={() => iconInput.current?.click()}>
              {zh ? '更换图标' : 'Change icon'}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              type="button"
              disabled={!draftAppearance.iconDataUrl}
              onClick={() => {
                setIconError(null);
                changeDraft({ ...draft, iconDataUrl: null });
              }}
            >
              {zh ? '恢复默认' : 'Reset icon'}
            </Button>
            <input
              ref={iconInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void replaceIcon(file);
              }}
            />
            {iconError ? <p role="alert">{iconError}</p> : null}
          </div>
          <div
            className="model-connection-field-grid"
            onInput={() => setSaveState('idle')}
            onBlurCapture={(event) => {
              if (draft.id && !props.onComplete && event.target instanceof HTMLInputElement && event.target.type !== 'search') return save();
            }}
          >
            <label>
              <span>{zh ? '快捷模板' : 'Template'}</span>
              <ZeusSelect
                ariaLabel={zh ? '快捷模板' : 'Template'}
                size="regular"
                value={draft.templateId}
                onChange={applyTemplate}
                options={(
                  [
                    { value: 'custom', label: zh ? '自定义兼容供应商' : 'Custom compatible provider' },
                    { value: 'kilo', label: 'Kilo' },
                    { value: 'deepseek', label: 'DeepSeek' },
                    { value: 'bailian', label: zh ? '阿里云百炼' : 'Alibaba Bailian' },
                    { value: 'kimi', label: 'Kimi' },
                    { value: 'zai', label: 'Z.AI / GLM' },
                  ] as const
                ).map((option) => ({ ...option, ...modelProviderOption({ templateId: option.value, sourceName: option.label }) }))}
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
                  data-icon-tooltip={apiKeyVisible ? (zh ? '隐藏 API Key' : 'Hide API key') : zh ? '查看 API Key' : 'Show API key'}
                  size="compact"
                  aria-label={apiKeyVisible ? (zh ? '隐藏 API Key' : 'Hide API key') : zh ? '查看 API Key' : 'Show API key'}
                  aria-pressed={apiKeyVisible}
                  disabled={!current?.apiKeyConfigured || busy}
                  busy={status === 'revealing'}
                  onClick={() => toggleApiKeyVisibility()}
                >
                  {apiKeyVisible ? <EyeSlashIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
                </Button>
              </span>
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

          <section className="model-connection-pricing" aria-label={zh ? '价格源' : 'Pricing source'}>
            <div className="model-connection-pricing-field">
              <label htmlFor={pricingInputId}>{zh ? '价格源地址' : 'Pricing source URL'}</label>
              <span className="model-connection-pricing-input">
                <input
                  id={pricingInputId}
                  type="url"
                  value={pricingUrl}
                  placeholder={draft.templateId === 'custom' ? 'https://example.com/pricing' : zh ? '供应商默认价格页面' : 'Provider pricing page'}
                  onChange={(event) => {
                    draftRevision.current += 1;
                    setPricingUrlDraft({ connectionId: draft.id, value: event.currentTarget.value });
                  }}
                  disabled={busy}
                />
                <Button variant="secondary" size="compact" disabled={busy || !current} onClick={() => refreshPricing()}>
                  {zh ? '更新价格' : 'Refresh prices'}
                </Button>
                <Button
                  unstyled
                  type="button"
                  className="model-connection-pricing-source-button"
                  aria-label={zh ? '价格源配置' : 'Price source settings'}
                  data-icon-tooltip={pricingUrlChanged ? (zh ? '先更新价格源地址' : 'Update the pricing source URL first') : zh ? '价格源配置' : 'Price source settings'}
                  disabled={busy || !current || pricingUrlChanged}
                  onClick={() => setPricingSourceDraft({ profile: current?.pricingProfile ?? '', token: '' })}
                >
                  <GearIcon size={16} aria-hidden="true" />
                </Button>
              </span>
            </div>
            <div className="model-connection-pricing-status" role="status">
              {pricingCatalog?.retrievedAt ? (
                <small>
                  {zh ? '上次读取：' : 'Last read: '}
                  {formatZeusDateTime(pricingCatalog.retrievedAt, props.language)}
                </small>
              ) : null}
              {pricingCatalog && enabledModelCount > 0 ? <ProviderRatePopover key={current?.id} modelIds={enabledModelIds} prices={pricingCatalog.prices} language={props.language} provider={draftAppearance} /> : null}
              {missingPriceCount > 0 ? <small>{zh ? `${missingPriceCount}/${enabledModelCount} 缺价` : `${missingPriceCount}/${enabledModelCount} missing`}</small> : null}
            </div>
            {pricingCatalog?.error ? (
              <p className="model-connection-pricing-failure" role="alert">
                <VisibleApplicationError error={pricingCatalog.error} language={zh ? 'zh-CN' : 'en'} summary={priceFailureSummary} title={zh ? '读取价格失败' : 'Price refresh failed'} />
              </p>
            ) : null}
          </section>
          {pricingSourceDraft ? (
            <FormDialog
              title={zh ? '价格源配置' : 'Price source settings'}
              submitLabel={zh ? '保存' : 'Save'}
              submitBusyLabel={zh ? '保存中…' : 'Saving…'}
              zh={zh}
              busy={busy}
              onClose={() => setPricingSourceDraft(null)}
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                return persistConnection({
                  ...createSaveInput(),
                  pricingUrl: savedPricingUrl,
                  pricingProfile: pricingSourceDraft.profile.trim(),
                  ...(pricingSourceDraft.token.trim() ? { pricingAccessToken: pricingSourceDraft.token.trim() } : {}),
                });
              }}
            >
              <label>
                {zh ? '价目与回执映射（JSON）' : 'Price and usage mapping (JSON)'}
                <textarea rows={10} spellCheck={false} value={pricingSourceDraft.profile} onChange={(event) => setPricingSourceDraft({ ...pricingSourceDraft, profile: event.target.value })} />
              </label>
              <label>
                {zh ? '价格源令牌' : 'Price source token'}
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={current?.pricingCredentialId ? (zh ? '已保存' : 'Saved') : undefined}
                  value={pricingSourceDraft.token}
                  onChange={(event) => setPricingSourceDraft({ ...pricingSourceDraft, token: event.target.value })}
                />
              </label>
              {message ? <p role="alert">{message}</p> : null}
            </FormDialog>
          ) : null}

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
                  <ModelProviderBadge {...draftAppearance} />
                  <input aria-label={zh ? '手工模型 ID' : 'Manual model ID'} placeholder={zh ? '手工模型 ID' : 'Manual model ID'} value={newModelId} onChange={(event) => setNewModelId(event.currentTarget.value)} />
                  <Button variant="secondary" size="compact" onClick={addManualModel} disabled={!newModelId.trim()}>
                    {zh ? '添加' : 'Add'}
                  </Button>
                </span>
              ) : null}
            </div>
            {enabledModelCount > 0 && filteredModels.length === 0 ? <p role="status">{zh ? '没有匹配的模型。' : 'No matching models.'}</p> : null}
            {enabledModelCount === 0 && draft.models.length > 0 ? <p role="status">{zh ? '尚未启用模型。' : 'No enabled models.'}</p> : null}
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
                  provider={draftAppearance}
                  expanded={expandedModelIds.has(model.id)}
                  onToggle={() => setModelsExpanded([model.id], !expandedModelIds.has(model.id))}
                  readOnly={draft.templateId !== 'custom' && draft.templateId !== 'kilo'}
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
              <span className="model-provider-labelled">
                {diagnostic.testedModelId ? <ModelProviderBadge {...draftAppearance} /> : null}
                <span>
                  {diagnostic.ok ? (
                    zh ? (
                      diagnostic.message
                    ) : (
                      `Model ${diagnostic.testedModelId ?? ''} completed a real request. Image and tool capabilities still require separate probes.`
                    )
                  ) : (
                    <VisibleApplicationError error={diagnostic} language={zh ? 'zh-CN' : 'en'} />
                  )}
                </span>
              </span>
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
              <ZeusSelect
                size="regular"
                ariaLabel={completionModelLabel}
                value={defaultModelRef}
                onChange={setDefaultModelRef}
                options={selectableModels.map((model) => ({ value: model.id, label: model.displayName, ...modelProviderOption(model.sourceId === draft.id ? draftAppearance : model) }))}
              />
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
              <Button variant="primary" size="compact" onClick={() => save()} disabled={busy || !draft.name.trim() || !draft.baseUrl.trim()} busy={status === 'saving'} busyLabel={zh ? '保存中…' : 'Saving…'}>
                {draft.id ? (zh ? '保存供应商' : 'Save provider') : zh ? '创建供应商' : 'Create provider'}
              </Button>
            ) : null}
            <Button variant="secondary" size="compact" onClick={() => refreshModels()} disabled={busy || !draft.id || !current?.apiKeyConfigured} busy={status === 'refreshing'}>
              {zh ? '获取模型' : 'Fetch models'}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              title={zh ? '使用第一个已启用模型发送一次最小真实请求，可能产生少量用量' : 'Send one minimal real request with the first enabled model; minor usage may be billed'}
              onClick={() => diagnose()}
              disabled={busy || !draft.id || enabledModelCount === 0}
              busy={status === 'loading'}
            >
              {zh ? '验证真实请求' : 'Verify real request'}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              title={zh ? '对已启用模型真实发送一次请求，按观测结果更新工具、图片、流式、用量和推理档位' : 'Send one real request per enabled model and update tools, image, streaming, usage, and reasoning evidence'}
              onClick={() => probeModels()}
              disabled={busy || !draft.id || !current?.apiKeyConfigured || enabledModelCount === 0}
              busy={status === 'probing'}
            >
              {zh ? '能力探测' : 'Probe capabilities'}
            </Button>
            {props.onComplete ? (
              <Button
                variant="primary"
                size="compact"
                onClick={() => completeSetup()}
                disabled={
                  busy || !current?.apiKeyConfigured || !current.enabled || !defaultModelRef || Boolean(draft.apiKey) || pricingUrlChanged || JSON.stringify(createSaveInput()) !== JSON.stringify(createSaveInput({ ...current, apiKey: '' }))
                }
              >
                {zh ? '完成接入' : 'Finish setup'}
              </Button>
            ) : null}
            {draft.id && current?.apiKeyConfigured ? (
              <Button variant="secondary" size="compact" onClick={() => clearApiKey()} disabled={busy}>
                {zh ? '清除密钥' : 'Clear key'}
              </Button>
            ) : null}
            {draft.id ? (
              <Button variant="danger" size="compact" onClick={() => removeConnection()} disabled={busy} busy={status === 'deleting'}>
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
        setMessage(zh ? '已恢复自动判定。' : 'Restored automatic detection.');
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
      <div className="model-reasoning-body">
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
              <tr key={index}>
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
          <Button size="compact" variant="secondary" disabled={busy || rows.length === PI_THINKING_LEVELS.length} onClick={() => setRows((value) => [...value, { id: '', piLevel: 'medium', wire: '' }])}>
            {zh ? '增加一档' : 'Add level'}
          </Button>
          <Button size="compact" variant="secondary" disabled={busy || rows.length === 0} onClick={() => setRows((value) => value.slice(0, -1))}>
            {zh ? '减少一档' : 'Remove last'}
          </Button>
          <Button size="compact" disabled={busy || props.context.connectionId === null || rows.length === 0} busy={status === 'saving'} busyLabel={zh ? '保存中…' : 'Saving…'} onClick={() => saveOverride(rows)}>
            {zh ? '保存清单' : 'Save list'}
          </Button>
          <Button size="compact" variant="secondary" disabled={busy || props.context.connectionId === null} onClick={() => saveOverride(null)}>
            {zh ? '恢复自动判定' : 'Reset to automatic'}
          </Button>
          <Button size="compact" variant="secondary" disabled={busy || props.context.connectionId === null || profile.options.length === 0} busy={status === 'auditing'} onClick={() => runAudit()}>
            {zh ? '逐档体检' : 'Audit each level'}
          </Button>
        </span>
        <small>{zh ? '体检逐档各发一次真实请求，只出证据、不改配置。' : 'Auditing sends one real request per level. It only reports evidence.'}</small>
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
      </div>
    </div>
  );
}

/** 自定义档位弹窗：只有用户点开才会出现，关闭即回到 Zeus 的默认判定。 */
function ModelReasoningDialog(props: { language: 'zh-CN' | 'en-US'; model: ModelConnectionModel; provider: Parameters<typeof ModelProviderBadge>[0]; context: ModelReasoningContext; onClose: () => void }) {
  const zh = props.language === 'zh-CN';
  const titleId = `model-reasoning-dialog-title-${props.model.id}`;
  return (
    <ModalPortal rootClassName="model-reasoning-portal" role="dialog" aria-labelledby={titleId} onDismiss={props.onClose}>
      <section className="model-reasoning-dialog zeus-solid-form-surface">
        <header>
          <strong id={titleId} className="model-provider-labelled">
            <ModelProviderBadge {...props.provider} />
            <span>{zh ? `自定义推理档位：${props.model.id}` : `Customize reasoning levels: ${props.model.id}`}</span>
          </strong>
        </header>
        <ModelReasoningSection language={props.language} model={props.model} context={props.context} />
        <footer>
          <Button variant="secondary" onClick={props.onClose}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

/** 手工覆盖清单里的一行；wire 用空串表示"不发送取值"，提交前再还原成 null。 */
interface ModelReasoningOverrideRow {
  id: string;
  piLevel: ModelThinkingLevel;
  wire: string;
}

/** 能力证据只展示真实观测过的内容；没探测过的模型不显示空话。 */
function ModelCapabilityFacts(props: { language: 'zh-CN' | 'en-US'; model: ModelConnectionModel; provider: Parameters<typeof ModelProviderBadge>[0]; reasoning?: ModelReasoningContext }) {
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
  /** 自定义档位是低频动作：默认完全展开太吵，收进小按钮后面的弹窗。 */
  const [reasoningDialogOpen, setReasoningDialogOpen] = useState(false);
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
          <span className="model-provider-labelled">
            <ModelProviderBadge {...props.provider} />
            {versionValue}
          </span>
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
          <span className="model-reasoning-summary">
            {capability.reasoning.options.length === 0
              ? zh
                ? '跟随供应商默认值'
                : 'Use provider default'
              : `${capability.reasoning.options.map((option) => option.label || option.id).join(' / ')} · ${reasoningBasisLabel(capability.reasoning.basis, zh)}`}
          </span>
          {props.reasoning?.connectionId ? (
            <Button
              size="compact"
              variant="secondary"
              className="model-reasoning-open"
              aria-label={zh ? `自定义 ${props.model.id} 的推理档位` : `Customize reasoning levels for ${props.model.id}`}
              data-icon-tooltip={zh ? '自定义推理档位' : 'Customize reasoning levels'}
              onClick={() => setReasoningDialogOpen(true)}
            >
              <GearIcon aria-hidden="true" />
            </Button>
          ) : null}
        </dd>
      </div>
      {reasoningDialogOpen && props.reasoning ? <ModelReasoningDialog language={props.language} model={props.model} provider={props.provider} context={props.reasoning} onClose={() => setReasoningDialogOpen(false)} /> : null}
    </dl>
  );
}

/**
 * 档位清单的来源标签。
 * 「真实支持」只有官方文档和真机逐档体检能确认，所以推断出来的来源必须写明是推断。
 */
function reasoningBasisLabel(basis: ModelReasoningBasis, zh: boolean): string {
  if (basis === 'official_endpoint') return zh ? '依据：官方端点声明（官方文档核对）' : 'Basis: official endpoint (verified against vendor docs)';
  if (basis === 'vendor_docs') return zh ? '依据：厂商文档档位表（同族通用，未逐个渠道验证）' : 'Basis: vendor documentation (same family, per-channel unverified)';
  if (basis === 'codex_catalog') return zh ? '依据：Codex 模型目录（渠道未逐档验证）' : 'Basis: Codex model catalog (channel unverified)';
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

/** 已启用模型共用一个原生费率浮层，缺价保留空单价。 */
function ProviderRatePopover(props: { modelIds: string[]; prices: ModelPrice[]; language: 'zh-CN' | 'en-US'; provider: Parameters<typeof ModelProviderBadge>[0] }) {
  const id = useId();
  const anchor = `--provider-rates-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const surface = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverIntent = useHoverIntent(() => showRates());
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const zh = props.language === 'zh-CN';
  const title = zh ? '费率' : 'Rates';

  /** 焦点和鼠标进入均显示锚定浮层。 */
  function showRates(): void {
    hoverIntent.cancel();
    clearTimeout(closeTimer.current);
    if (!surface.current?.matches(':popover-open')) surface.current?.showPopover();
  }

  /** 从按钮移到浮层或用 Tab 进入列表时给指针和焦点留出过渡时间。 */
  function closeRatesLater(): void {
    hoverIntent.cancel();
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!trigger.current?.matches(':hover, :focus-visible') && !surface.current?.matches(':hover, :focus-within')) surface.current?.hidePopover();
    }, 120);
  }

  return (
    <div
      className="model-connection-rate-control"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !surface.current?.matches(':popover-open')) return;
        event.preventDefault();
        event.stopPropagation();
        surface.current.hidePopover();
      }}
    >
      <Button
        ref={trigger}
        variant="secondary"
        size="compact"
        aria-haspopup="dialog"
        popoverTarget={id}
        popoverTargetAction="show"
        style={{ anchorName: anchor }}
        onPointerEnter={(event) => {
          clearTimeout(closeTimer.current);
          if (event.pointerType !== 'touch' && event.buttons === 0) hoverIntent.schedule(event.currentTarget);
        }}
        onPointerLeave={closeRatesLater}
        onFocus={(event) => {
          if (event.currentTarget.matches(':focus-visible')) showRates();
        }}
        onBlur={closeRatesLater}
      >
        {title}
      </Button>
      <div
        ref={surface}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={title}
        tabIndex={0}
        className="model-connection-rate-popover"
        style={{ positionAnchor: anchor }}
        onPointerEnter={() => clearTimeout(closeTimer.current)}
        onPointerLeave={closeRatesLater}
        onFocus={() => clearTimeout(closeTimer.current)}
        onBlur={closeRatesLater}
      >
        <ProviderRateTable {...props} />
      </div>
    </div>
  );
}

/** 费率表保留币种、计费单位及适用条件，所有数值为空的列自动省略。 */
function ProviderRateTable(props: { modelIds: string[]; prices: ModelPrice[]; language: 'zh-CN' | 'en-US'; provider: Parameters<typeof ModelProviderBadge>[0] }) {
  const zh = props.language === 'zh-CN';
  const rows = props.modelIds.flatMap<{ model: string; price?: ModelPrice; charge?: MeteredCharge }>((model) => {
    const prices = props.prices.filter((price) => price.model === model);
    if (!prices.length) return [{ model }];
    return prices.flatMap<{ model: string; price: ModelPrice; charge?: MeteredCharge }>((price) => (price.metered ? price.metered.charges.map((charge) => ({ model, price, charge })) : [{ model, price }]));
  });
  const columns: Array<{ label: string; numeric?: boolean; value(price: ModelPrice | undefined, charge?: MeteredCharge): string | number | null | undefined }> = [
    { label: zh ? '币种' : 'Currency', value: (price) => price?.currency },
    { label: zh ? '计量' : 'Meter', value: (_price, charge) => charge?.meter },
    { label: zh ? '单位' : 'Unit', value: (_price, charge) => charge && `${charge.quantityPerPrice} ${charge.unit}` },
    { label: zh ? '单价' : 'Rate', numeric: true, value: (_price, charge) => charge?.amount },
    { label: zh ? '输入 / 百万 Token' : 'Input / 1M tokens', numeric: true, value: (price) => price?.perMillion?.input },
    { label: zh ? '输出 / 百万 Token' : 'Output / 1M tokens', numeric: true, value: (price) => price?.perMillion?.output },
    { label: zh ? '缓存读 / 百万 Token' : 'Cache read / 1M tokens', numeric: true, value: (price) => price?.perMillion?.cachedInput },
    { label: zh ? '缓存写 / 百万 Token' : 'Cache write / 1M tokens', numeric: true, value: (price) => price?.perMillion?.cacheWrite },
    { label: zh ? '单价 / 次' : 'Per request', numeric: true, value: (price) => price?.perRequest },
    { label: zh ? '输入区间（Token）' : 'Input range (tokens)', value: (price) => price?.inputRange && `(${price.inputRange.minExclusive}, ${price.inputRange.maxInclusive}]` },
    { label: zh ? '排除时段（UTC）' : 'Excluded hours (UTC)', value: (price) => (price?.excludedUtcWindows?.length ? excludedRateHours(price.excludedUtcWindows, props.language) : undefined) },
    { label: zh ? '适用条件' : 'Conditions', value: (price) => price?.metered && meteredRateConditions(price.metered, props.language) },
    { label: zh ? '状态' : 'Status', value: (price) => (price ? undefined : zh ? '缺价' : 'Missing') },
  ];
  const visibleColumns = columns.filter((column) => rows.some(({ price, charge }) => column.value(price, charge) != null));
  return (
    <table className="model-connection-rate-table">
      <thead>
        <tr>
          <th scope="col">{zh ? '模型' : 'Model'}</th>
          {visibleColumns.map((column) => (
            <th scope="col" key={column.label} data-numeric={column.numeric}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ model, price, charge }, index) => (
          <tr key={`${model}:${index}`}>
            <th scope="row">
              <span className="model-provider-labelled">
                <ModelProviderBadge {...props.provider} />
                {model}
              </span>
            </th>
            {visibleColumns.map((column) => (
              <td key={column.label} data-numeric={column.numeric}>
                {column.value(price, charge) ?? '—'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 价格表同时呈现已确认的有效区间、匹配字段与地域时间窗口。 */
function meteredRateConditions(rule: NonNullable<ModelPrice['metered']>, language: string): string | undefined {
  const windows = rule.windows?.map((window) => `${excludedRateHours([window], language)} ${window.timeZone}`) ?? [];
  return [...Object.entries(rule.attributes ?? {}).map(([key, value]) => `${key}=${value}`), ...windows, rule.validFrom && `≥ ${rule.validFrom}`, rule.validUntil && `< ${rule.validUntil}`].filter(Boolean).join(' · ') || undefined;
}

/** 已知的排除时段保留星期和 UTC，避免把分时费率当成全天价格。 */
function excludedRateHours(windows: NonNullable<ModelPrice['excludedUtcWindows']>, language: string): string {
  const weekday = new Intl.DateTimeFormat(language, { timeZone: 'UTC', weekday: 'short' });
  /** 从 UTC 的星期日开始生成星期标签，与 UTC 时段编号一致。 */
  const sunday = 4; // 1970 年 1 月 4 日
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return windows.map((window) => `${window.weekdays.map((day) => weekday.format(Date.UTC(1970, 0, sunday + day))).join(' ')} ${clock(window.startMinute)}–${clock(window.endMinute)}`).join(' · ');
}

/** 模型标题独立控制展开；启用、移除和配置修改沿用各自的业务入口。 */
function ModelDefinitionEditor(props: {
  language: 'zh-CN' | 'en-US';
  model: ModelConnectionModel;
  /** 模型卡片与启用菜单使用同一供应商外观。 */
  provider: Parameters<typeof ModelProviderBadge>[0];
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
        <Button unstyled type="button" className="model-definition-identity" onClick={props.onToggle} aria-expanded={props.expanded} aria-controls={detailsId}>
          <span>
            <strong className="model-connection-name" data-icon-tooltip={model.displayName || model.id} data-icon-tooltip-provider>
              <ModelProviderBadge {...props.provider} />
              <span>{model.displayName || model.id}</span>
            </strong>
            <small>{model.displayName && model.displayName !== model.id ? `${model.id} · ${modelRouteLabel(model, zh)}` : modelRouteLabel(model, zh)}</small>
          </span>
          <CaretDownIcon className="model-definition-chevron" aria-hidden="true" />
        </Button>
        {props.readOnly ? null : (
          <Button unstyled className="model-definition-remove" type="button" onClick={props.onRemove} aria-label={zh ? `移除模型 ${model.id}` : `Remove model ${model.id}`} data-icon-tooltip={zh ? '移除模型' : 'Remove model'}>
            <X aria-hidden="true" weight="bold" />
          </Button>
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
                <dd>{authenticationLabel(model.authenticationScheme, zh)}</dd>
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
                      authenticationScheme: protocolFamily !== 'anthropic_messages' && model.authenticationScheme === 'x_api_key' ? 'bearer' : model.authenticationScheme,
                    })
                  }
                  options={[
                    { value: 'openai_completions', label: 'OpenAI Chat Completions' },
                    { value: 'anthropic_messages', label: 'Anthropic Messages' },
                    { value: 'openai_responses', label: 'OpenAI Responses' },
                    { value: 'openai_images', label: 'OpenAI Images' },
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
                    { value: 'bearer', label: authenticationLabel('bearer', zh) },
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
          <ModelCapabilityFacts language={props.language} model={model} provider={props.provider} {...(props.reasoning ? { reasoning: props.reasoning } : {})} />
        </div>
      </Collapsible>
    </article>
  );
}

/** 展示缓存只恢复配置字段，密钥输入始终重新留空。 */
function connectionDraft(connection: ModelConnectionRecord): ModelConnectionDraft {
  return {
    id: connection.id,
    name: connection.name,
    templateId: connection.templateId,
    baseUrl: connection.baseUrl,
    modelsPath: connection.modelsPath,
    enabled: connection.enabled,
    models: connection.models.map(cloneModel),
    apiKey: '',
  };
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
    authenticationScheme: 'bearer',
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

/** 认证列表和详情共用同一标签，直接在默认选项后标注默认。 */
function authenticationLabel(authenticationScheme: ModelAuthenticationScheme, zh: boolean): string {
  if (authenticationScheme === 'x_api_key') return 'x-api-key';
  return zh ? 'Authorization: Bearer（默认）' : 'Authorization: Bearer (default)';
}

function modelRouteLabel(model: ModelConnectionModel, zh: boolean): string {
  return `${protocolLabel(model.protocolFamily)} · ${authenticationLabel(model.authenticationScheme, zh)}`;
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
