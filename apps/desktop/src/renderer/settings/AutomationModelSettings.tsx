import { useEffect, useState } from 'react';
import { normalizeAutomationModelSettings, type AutomationModelSelection, type InputSuggestionModelOption } from '@zeus/shared';
import type { AppShellSettings } from '../features/settings/settingsContracts.js';
import type { SettingsApiClient } from '../features/settings/settingsApiClient.js';
import { codexCapabilitiesChangedEvent } from '../features/codex/codexApiClient.js';
import { NativeControlRow } from '../features/workspace/workspaceSupport.js';
import { modelProviderOptionForRef, presentModelOptions } from '../modelOptionPresentation.js';
import { selectionFromEffectiveServiceTier, serviceTierOptions, serviceTierPickerValue, serviceTierWireOverride } from '../session/serviceTierSelection.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { SettingsSaveStatus } from './useSettingsAutosave.js';

/** 浏览器和桌面操作各自选择模型及其目录支持的速度。 */
export function AutomationModelSettings(props: {
  /** 主界面已加载的全局偏好。 */
  value: AppShellSettings;
  /** 保存使用现有串行设置命令。 */
  client: SettingsApiClient | null;
  /** 仅同步本组件拥有的操作模型设置。 */
  onChange: (update: (value: AppShellSettings) => AppShellSettings) => unknown;
}) {
  /** 文案跟随当前界面语言。 */
  const zh = props.value.appLanguage === 'zh-CN';
  /** 两个能力独立保存完整模型身份。 */
  const settings = normalizeAutomationModelSettings(props.value.automationModels);
  /** 复用登录账户和已有模型连接的目录。 */
  const [models, setModels] = useState<InputSuggestionModelOption[]>([]);
  /** 登录变化后重新读取，不定时请求目录。 */
  const [revision, setRevision] = useState(0);
  /** 加载期间保留已保存的模型身份。 */
  const [loading, setLoading] = useState(true);
  /** 两个控件共用本节保存状态，避免交叉覆盖。 */
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  /** 目录和保存错误保留在对应设置区域。 */
  const [error, setError] = useState<unknown>(null);
  /** 单个来源失效时仍显示其他可用模型。 */
  const [warning, setWarning] = useState('');
  /** 置顶沿用会话的目录 ID，保存时使用带来源的运行引用。 */
  const catalog = models.map((model) => ({ ...model, id: model.catalogId ?? model.id, modelRef: model.id, model: model.model ?? model.id, displayName: model.displayName ?? model.label }));

  useEffect(() => {
    /** 返回设置窗口或登录变化后更新可选目录。 */
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('focus', refresh);
    window.addEventListener(codexCapabilitiesChangedEvent, refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(codexCapabilitiesChangedEvent, refresh);
    };
  }, []);

  useEffect(() => {
    if (!props.client) {
      setLoading(false);
      return;
    }
    /** 退出页面后不接收旧目录结果。 */
    const controller = new AbortController();
    setLoading(true);
    void props.client
      .loadInputSuggestionModels(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setModels(result.items);
        setWarning(result.warning);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [props.client, revision]);

  /** 模型和速度一并保存，另一操作能力沿用服务端当前设置。 */
  async function save(capability: 'browser' | 'computer', selection: AutomationModelSelection | null): Promise<void> {
    if (!props.client || status === 'saving') return;
    setStatus('saving');
    setError(null);
    try {
      const saved = await props.client.saveAppShellSettings({ automationModels: { [capability]: selection } });
      props.onChange((current) => ({ ...current, automationModels: saved.automationModels }));
      setStatus('saved');
    } catch (cause) {
      setError(cause);
      setStatus('failed');
    }
  }

  return (
    <section className="settings-product-section">
      <header className="settings-page-heading">
        <h3>{zh ? '操作模型' : 'Operation models'}</h3>
        <SettingsSaveStatus language={props.value.appLanguage} status={status} />
      </header>
      <section className="native-settings-pane browser-settings-pane" aria-label={zh ? '操作模型' : 'Operation models'}>
        {(['browser', 'computer'] as const).map((capability) => {
          /** 两种操作分别保留固定模型；空值交给当前会话。 */
          const selected = settings[capability];
          /** 原有设置按带来源的引用查找，列表使用共享置顶身份。 */
          const model = catalog.find((item) => item.modelRef === selected?.modelRef);
          /** 目录离线或模型被移除时仍保留原选择。 */
          const selectedId = model?.id ?? selected?.modelRef ?? '';
          /** 供应商分组、排序、搜索、置顶沿用会话模型列表。 */
          const presentation = presentModelOptions(catalog, selectedId, props.value.appLanguage, { preserveMissingSelection: true });
          /** 跟随选项没有模型身份，不参与置顶。 */
          const options = [
            { value: '', label: zh ? '跟随当前会话' : 'Follow conversation' },
            ...presentation.options,
            ...(selected && !model ? [{ value: selectedId, label: `${selectedId}${loading ? '' : zh ? '（目录不可用）' : ' (unavailable)'}`, disabled: true, ...modelProviderOptionForRef(selectedId) }] : []),
          ];
          /** 只有目录提供加速档位的固定模型才需要速度选择。 */
          const speedModel = { serviceTiers: model?.serviceTiers ?? [] };
          /** 档位名称、标准速度及目录筛选与会话一致。 */
          const speeds = serviceTierOptions(speedModel, props.value.appLanguage);
          /** 行标题同时用于区分同一设置页的两个选择器。 */
          const title = capability === 'browser' ? 'Browser Use' : 'Computer Use';
          return (
            <NativeControlRow title={title} className="browser-settings-row automation-model-settings-row" key={capability}>
              <ZeusSelect
                size="regular"
                ariaLabel={zh ? `${title} 模型` : `${title} model`}
                value={selectedId}
                triggerLabel={model ? presentation.triggerLabel : undefined}
                triggerTitle={model ? presentation.triggerLabel : undefined}
                options={options}
                pinning={presentation.pinning}
                disabled={!props.client || status === 'saving'}
                onChange={(value) => {
                  if (value === selectedId) return;
                  /** 切换模型从标准速度开始；空选项跟随当前会话。 */
                  const next = catalog.find((item) => item.id === value);
                  if (next || !value) void save(capability, next ? { modelRef: next.modelRef, serviceTier: null } : null);
                }}
                searchable
                searchPlaceholder={zh ? '搜索模型' : 'Search models'}
                emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
              />
              {selected && speeds.length > 1 ? (
                <ZeusSelect
                  className="automation-model-speed-select"
                  size="regular"
                  ariaLabel={zh ? `${title} 速度` : `${title} speed`}
                  value={serviceTierPickerValue(selectionFromEffectiveServiceTier(selected.serviceTier), speedModel)}
                  options={speeds}
                  disabled={!props.client || status === 'saving'}
                  searchable={false}
                  onChange={(value) => void save(capability, { modelRef: selected.modelRef, ...serviceTierWireOverride(selectionFromEffectiveServiceTier(value)) })}
                />
              ) : null}
            </NativeControlRow>
          );
        })}
      </section>
      {error ? (
        <div role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        </div>
      ) : warning ? (
        <p className="browser-settings-status" role="status">
          {warning}
        </p>
      ) : null}
    </section>
  );
}
