import { useEffect, useRef, useState } from 'react';
import { defaultInputSuggestionSettings, normalizeTaskBranchPrefix, type InputSuggestionModelOption } from '@zeus/shared';
import { codexCapabilitiesChangedEvent } from '../features/codex/codexApiClient.js';
import type { AppShellSettings } from '../apiClient.js';
import type { SettingsApiClient } from '../features/settings/settingsApiClient.js';
import { NativeControlRow, NativeSettingsPane } from '../features/workspace/workspaceSupport.js';
import { notifyMainAppShellSettingsChanged } from '../appShellBridge.js';
import { Button } from '../ui/Button.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { SettingsSaveStatus } from './useSettingsAutosave.js';

/** 通用偏好只保存所属字段，避免自动保存顺带覆盖其他页面的配置。 */
type GeneralPreferences = Pick<AppShellSettings, 'appLanguage' | 'appearance' | 'mainLayout' | 'taskBranchPrefix' | 'desktopNotificationsEnabled' | 'inputSuggestions'>;

/** 通用设置即时应用、顺序保存；失败后保留当前选择并提供重试。 */
export function GeneralSettingsPane(props: {
  /** 已加载的应用设置。 */
  value: AppShellSettings;
  /** 复用已有设置接口。 */
  client: SettingsApiClient | null;
  /** 同步全局界面语言、主题和偏好。 */
  onChange: (update: (value: AppShellSettings) => AppShellSettings) => unknown;
}) {
  /** 本页只显示一种语言。 */
  const zh = props.value.appLanguage === 'zh-CN';
  /** 每次交互发送完整通用偏好，后续成功写入也会涵盖此前失败的修改。 */
  const preferences = useRef<GeneralPreferences>(props.value);
  preferences.current = props.value;
  /** 只有最后一次操作可以更新反馈。 */
  const revision = useRef(0);
  /** 保存反馈不打断页面输入。 */
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  /** 前缀格式错误属于当前字段，不弹全局错误对话框。 */
  const [taskBranchPrefixError, setTaskBranchPrefixError] = useState<string | null>(null);
  /** 专用模型与会话默认模型分开，旧用户没有隐式模型。 */
  const suggestions = props.value.inputSuggestions ?? defaultInputSuggestionSettings;
  /** 模型目录只在通用设置打开或用户刷新时读取。 */
  const [suggestionModels, setSuggestionModels] = useState<InputSuggestionModelOption[]>([]);
  /** 目录失败只在本设置区提示，不弹窗或更换已保存模型。 */
  const [suggestionModelWarning, setSuggestionModelWarning] = useState('');
  /** 刷新序号避免旧目录覆盖用户刚刷新后的结果。 */
  const [modelsRevision, setModelsRevision] = useState(0);
  /** 加载期间保持已保存的选择，不自动挑选第一个模型。 */
  const [modelsLoading, setModelsLoading] = useState(false);
  /** 档位只来自已选模型，切换模型时重新采用自动最低。 */
  const selectedSuggestionModel = suggestionModels.find((model) => model.id === suggestions.modelRef);
  /** 已失效的显式档位保留可见提示，不静默改用其他档位。 */
  const suggestionEfforts = selectedSuggestionModel?.supportedReasoningEfforts ?? [];

  useEffect(() => {
    /** 返回窗口或登录能力变化后重新读取目录，省去常驻刷新按钮。 */
    const refresh = () => setModelsRevision((value) => value + 1);
    window.addEventListener('focus', refresh);
    window.addEventListener(codexCapabilitiesChangedEvent, refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(codexCapabilitiesChangedEvent, refresh);
    };
  }, []);

  useEffect(() => {
    if (!props.client) return;
    /** 设置页退出或重新刷新时停止接收旧目录。 */
    const controller = new AbortController();
    setModelsLoading(true);
    void props.client
      .loadInputSuggestionModels(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSuggestionModels(result.items);
        setSuggestionModelWarning(result.warning);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSuggestionModelWarning(zh ? '模型目录暂不可用，请刷新。' : 'Models are unavailable. Refresh to retry.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setModelsLoading(false);
      });
    return () => controller.abort();
  }, [props.client, modelsRevision, zh]);

  /** 原始设置不含代理草稿，只有通过校验的代理配置进入队列。 */
  async function save(patch: Partial<GeneralPreferences>): Promise<void> {
    /** 立即刷新引用，连续事件不依赖下一次渲染。 */
    const next = { ...preferences.current, ...patch };
    preferences.current = next;
    props.onChange((value) => ({ ...value, ...patch }));
    /** 请求仅包含通用偏好，保留其余设置的服务端当前值。 */
    const input: GeneralPreferences = {
      appLanguage: next.appLanguage,
      appearance: next.appearance,
      mainLayout: next.mainLayout,
      taskBranchPrefix: next.taskBranchPrefix,
      desktopNotificationsEnabled: next.desktopNotificationsEnabled,
      inputSuggestions: next.inputSuggestions,
    };
    /** 异步反馈的归属序号。 */
    const currentRevision = ++revision.current;
    setStatus('saving');
    try {
      if (!props.client) throw new Error(zh ? '本地设置服务暂不可用。' : 'Settings service is unavailable.');
      /** 服务端校验后再通知桌面宿主，通知失败也明确报告。 */
      const saved = await props.client.saveAppShellSettings(input);
      await notifyMainAppShellSettingsChanged({ zeus: window.zeus, settings: saved });
      if (currentRevision === revision.current) setStatus('saved');
    } catch {
      if (currentRevision === revision.current) {
        setStatus('failed');
      }
    }
  }

  return (
    <section className="settings-product-pane general-settings-pane" aria-label={zh ? '通用' : 'General'}>
      <header className="settings-page-heading">
        <span>
          <h2 className="settings-page-title">{zh ? '通用' : 'General'}</h2>
          <p>{zh ? '调整界面、通知与输入建议，修改后自动保存。' : 'Appearance, notifications and input suggestions. Changes save automatically.'}</p>
        </span>
        {status === 'failed' ? (
          <div className="settings-heading-actions">
            <SettingsSaveStatus status={status} language={props.value.appLanguage} />
            <Button size="compact" onClick={() => save({})}>
              {zh ? '重试' : 'Retry'}
            </Button>
          </div>
        ) : null}
      </header>
      <NativeSettingsPane label={zh ? '界面与通知' : 'Appearance and notifications'}>
        <NativeControlRow title={zh ? '应用语言' : 'Language'} description={zh ? '选择 Zeus 的界面语言。' : 'Choose the Zeus interface language.'}>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '应用语言' : 'Language'}
            value={props.value.appLanguage}
            onChange={(appLanguage) => save({ appLanguage })}
            options={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en-US', label: 'English' },
            ]}
          />
        </NativeControlRow>
        <NativeControlRow title={zh ? '外观' : 'Appearance'} description={zh ? '跟随系统，或固定为浅色、深色。' : 'Follow the system or choose a light or dark theme.'}>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '外观' : 'Appearance'}
            value={props.value.appearance}
            onChange={(appearance) => save({ appearance })}
            options={[
              { value: 'system', label: zh ? '跟随系统' : 'System' },
              { value: 'light', label: zh ? '浅色' : 'Light' },
              { value: 'dark', label: zh ? '深色' : 'Dark' },
            ]}
          />
        </NativeControlRow>
        <NativeControlRow title={zh ? '主界面布局' : 'Main layout'} description={zh ? '选择主界面布局，修改后立即生效。' : 'Choose the main interface layout. Changes apply immediately.'}>
          <ZeusSelect
            size="regular"
            ariaLabel={zh ? '主界面布局' : 'Main layout'}
            value={props.value.mainLayout}
            onChange={(mainLayout) => save({ mainLayout })}
            options={[
              { value: 'upstream', label: zh ? '经典布局' : 'Classic layout' },
              { value: 'current', label: zh ? '紧凑布局' : 'Compact layout' },
            ]}
          />
        </NativeControlRow>
        <NativeControlRow title={zh ? '桌面通知' : 'Desktop notifications'} description={zh ? '在任务完成或需要你处理时提醒。' : 'Notify when work finishes or needs your attention.'}>
          <label className="settings-switch-state">
            <input
              className="native-switch-input"
              aria-label={zh ? '桌面通知' : 'Desktop notifications'}
              type="checkbox"
              checked={props.value.desktopNotificationsEnabled}
              onChange={(event) => save({ desktopNotificationsEnabled: event.currentTarget.checked })}
            />
            <span className="native-switch-track" aria-hidden="true" />
          </label>
        </NativeControlRow>
      </NativeSettingsPane>
      <section className="settings-product-section">
        <h3>{zh ? '输入建议' : 'Input suggestions'}</h3>
        <NativeSettingsPane label={zh ? '输入建议' : 'Input suggestions'}>
          <NativeControlRow
            title={zh ? '自动显示输入建议' : 'Automatic input suggestions'}
            description={
              zh
                ? '回复结束后显示灰字，按 Tab 采纳。关闭后仍可点击输入框星光按钮。每次生成会使用专用模型。'
                : 'Show a gray suggestion after a reply; press Tab to accept. The sparkle button remains available when this is off. Each request uses the suggestion model.'
            }
          >
            <label className="settings-switch-state">
              <input
                className="native-switch-input"
                type="checkbox"
                aria-label={zh ? '启用自动输入建议' : 'Enable automatic input suggestions'}
                checked={suggestions.enabled}
                disabled={!props.client || !suggestions.modelRef}
                onChange={(event) => void save({ inputSuggestions: { ...suggestions, enabled: event.currentTarget.checked } })}
              />
              <span className="native-switch-track" aria-hidden="true" />
            </label>
          </NativeControlRow>
          <NativeControlRow
            title={zh ? '专用模型' : 'Suggestion model'}
            description={zh ? '独立于会话模型；未选择或模型不可用时不生成建议。' : 'Independent of the conversation model. No suggestion is generated without an available model.'}
          >
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '输入建议专用模型' : 'Input suggestion model'}
              value={suggestions.modelRef ?? ''}
              disabled={!props.client || (modelsLoading && !suggestionModels.length)}
              onChange={(value) => void save({ inputSuggestions: { enabled: suggestions.enabled && Boolean(value), modelRef: value || null, effort: null } })}
              options={[
                { value: '', label: zh ? '请选择模型' : 'Choose a model' },
                ...suggestionModels.map((model) => ({ value: model.id, label: model.label })),
                ...(suggestions.modelRef && !suggestionModels.some((model) => model.id === suggestions.modelRef) ? [{ value: suggestions.modelRef, label: `${suggestions.modelRef} (${zh ? '不可用' : 'unavailable'})`, disabled: true }] : []),
              ]}
            />
          </NativeControlRow>
          <NativeControlRow
            title={zh ? '推理深度' : 'Reasoning effort'}
            description={zh ? '仅用于输入建议和润色。较高档位可能更慢、用量更多；每次最多等待 20 秒。' : 'Applies to suggestions and polishing only. Higher effort may take longer and use more tokens. Each request has a 20-second limit.'}
          >
            <ZeusSelect
              size="regular"
              ariaLabel={zh ? '输入建议推理深度' : 'Input suggestion reasoning effort'}
              value={suggestions.effort ?? ''}
              disabled={!props.client || !selectedSuggestionModel || (!suggestionEfforts.length && !suggestions.effort)}
              searchable={false}
              onChange={(effort) => void save({ inputSuggestions: { ...suggestions, effort: effort || null } })}
              options={[
                { value: '', label: suggestionEfforts.length ? (zh ? '自动（最低档位）' : 'Automatic (lowest effort)') : zh ? '模型未提供可选档位' : 'No selectable effort' },
                ...suggestionEfforts.map((effort) => ({ value: effort, label: effort })),
                ...(suggestions.effort && !suggestionEfforts.includes(suggestions.effort) ? [{ value: suggestions.effort, label: `${suggestions.effort} (${zh ? '不可用' : 'unavailable'})`, disabled: true }] : []),
              ]}
            />
          </NativeControlRow>
          {suggestionModelWarning ? (
            <p className="settings-field-error" role="status">
              {suggestionModelWarning}
              <Button size="compact" disabled={!props.client || modelsLoading} onClick={() => setModelsRevision((value) => value + 1)}>
                {zh ? '重试加载' : 'Retry loading'}
              </Button>
            </p>
          ) : null}
        </NativeSettingsPane>
      </section>
      <section className="settings-product-section">
        <h3>Git</h3>
        <NativeSettingsPane label={zh ? '分支命名' : 'Branch naming'}>
          <NativeControlRow
            title={zh ? '任务分支前缀' : 'Task branch prefix'}
            description={zh ? '用于后续新建的任务分支和会话工作树；无需输入结尾斜杠。' : 'Used for new task branches and conversation worktrees. Do not include a trailing slash.'}
          >
            <input
              key={props.value.taskBranchPrefix}
              aria-label={zh ? '任务分支前缀' : 'Task branch prefix'}
              aria-describedby={taskBranchPrefixError ? 'task-branch-prefix-error' : undefined}
              aria-invalid={Boolean(taskBranchPrefixError)}
              autoComplete="off"
              spellCheck={false}
              placeholder="zeus"
              defaultValue={props.value.taskBranchPrefix}
              disabled={!props.client}
              onChange={() => setTaskBranchPrefixError(null)}
              onBlur={(event) => {
                /** 交互结束时规范化一次，避免每个按键都写设置。 */
                const taskBranchPrefix = normalizeTaskBranchPrefix(event.currentTarget.value);
                if (!taskBranchPrefix) {
                  setTaskBranchPrefixError(zh ? '请输入合法的 Git 分支前缀。' : 'Enter a valid Git branch prefix.');
                  return;
                }
                event.currentTarget.value = taskBranchPrefix;
                setTaskBranchPrefixError(null);
                if (taskBranchPrefix !== props.value.taskBranchPrefix) void save({ taskBranchPrefix });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </NativeControlRow>
          {taskBranchPrefixError ? (
            <p id="task-branch-prefix-error" className="settings-field-error" role="alert">
              {taskBranchPrefixError}
            </p>
          ) : null}
        </NativeSettingsPane>
      </section>
    </section>
  );
}
