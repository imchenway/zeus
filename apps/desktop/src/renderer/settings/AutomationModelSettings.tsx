import { useEffect, useState } from 'react';
import { normalizeAutomationModelSettings, type InputSuggestionModelOption } from '@zeus/shared';
import type { AppShellSettings } from '../features/settings/settingsContracts.js';
import type { SettingsApiClient } from '../features/settings/settingsApiClient.js';
import { codexCapabilitiesChangedEvent } from '../features/codex/codexApiClient.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { SettingsSaveStatus } from './useSettingsAutosave.js';

/** 浏览器和桌面模型沿用现有设置存储、目录查询和下拉控件。 */
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

  /** 局部更新不改变主会话模型，也不触碰浏览器资料和权限。 */
  async function save(capability: 'browser' | 'computer', model: string): Promise<void> {
    if (!props.client || status === 'saving') return;
    setStatus('saving');
    setError(null);
    try {
      const saved = await props.client.saveAppShellSettings({ automationModels: { [capability]: model || null } });
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
          /** 目录离线或模型被移除时仍保留原选择，避免显示成跟随模式。 */
          const selected = settings[capability];
          /** 选项名称来自真实模型目录，未配置的能力沿用当前会话。 */
          const options = [
            { value: '', label: zh ? '跟随当前会话' : 'Follow conversation' },
            ...models.map((model) => ({ value: model.id, label: model.label })),
            ...(selected && !models.some((model) => model.id === selected) ? [{ value: selected, label: `${selected}${loading ? '' : zh ? '（目录不可用）' : ' (unavailable)'}` }] : []),
          ];
          return (
            <div className="native-control-row browser-settings-row" key={capability}>
              <span>{capability === 'browser' ? 'Browser Use' : 'Computer Use'}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={capability === 'browser' ? 'Browser Use model' : 'Computer Use model'}
                value={selected ?? ''}
                options={options}
                disabled={!props.client || status === 'saving'}
                onChange={(value) => void save(capability, value)}
                searchPlaceholder={zh ? '搜索模型' : 'Search models'}
                emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
              />
            </div>
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
