import { useRef, useState } from 'react';
import type { AppShellSettings } from '../apiClient.js';
import type { SettingsApiClient } from '../features/settings/settingsApiClient.js';
import { NativeControlRow, NativeSettingsPane } from '../features/workspace/workspaceSupport.js';
import { notifyMainAppShellSettingsChanged } from '../appShellBridge.js';
import { reportApplicationError } from '../ui/ApplicationErrorDialog.js';
import { Button } from '../ui/Button.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { NetworkProxySettingsFields } from './NetworkProxySettingsFields.js';

/** 通用偏好只保存所属字段，避免自动保存顺带覆盖其他页面的配置。 */
type GeneralPreferences = Pick<AppShellSettings, 'appLanguage' | 'appearance' | 'desktopNotificationsEnabled' | 'networkProxy'>;

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

  /** 原始设置不含代理草稿，只有通过校验的代理配置进入队列。 */
  async function save(patch: Partial<GeneralPreferences>): Promise<void> {
    /** 立即刷新引用，连续事件不依赖下一次渲染。 */
    const next = { ...preferences.current, ...patch };
    preferences.current = next;
    props.onChange((value) => ({ ...value, ...patch }));
    /** 请求仅包含通用偏好，保留其余设置的服务端当前值。 */
    const input: GeneralPreferences = { appLanguage: next.appLanguage, appearance: next.appearance, desktopNotificationsEnabled: next.desktopNotificationsEnabled, networkProxy: next.networkProxy };
    /** 异步反馈的归属序号。 */
    const currentRevision = ++revision.current;
    setStatus('saving');
    try {
      if (!props.client) throw new Error(zh ? '本地设置服务暂不可用。' : 'Settings service is unavailable.');
      /** 服务端校验后再通知桌面宿主，通知失败也明确报告。 */
      const saved = await props.client.saveAppShellSettings(input);
      await notifyMainAppShellSettingsChanged({ zeus: window.zeus, settings: saved });
      if (currentRevision === revision.current) setStatus('saved');
    } catch (error) {
      if (currentRevision === revision.current) {
        setStatus('failed');
        reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' });
      }
    }
  }

  return (
    <section className="settings-product-pane general-settings-pane" aria-label={zh ? '通用' : 'General'}>
      <header className="settings-page-heading">
        <span>
          <h2 className="settings-page-title">{zh ? '通用' : 'General'}</h2>
          <p>{zh ? '调整界面与通知，修改后自动保存。' : 'Appearance and notifications. Changes save automatically.'}</p>
        </span>
        <span className="settings-save-status" role="status" data-state={status}>
          {status === 'saving' ? (zh ? '正在保存…' : 'Saving…') : status === 'saved' ? (zh ? '已保存' : 'Saved') : status === 'failed' ? (zh ? '未保存' : 'Not saved') : null}
          {status === 'failed' ? (
            <Button size="compact" onClick={() => save({})}>
              {zh ? '重试' : 'Retry'}
            </Button>
          ) : null}
        </span>
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
        <h3>{zh ? '网络' : 'Network'}</h3>
        <NativeSettingsPane label={zh ? '网络代理' : 'Network proxy'}>
          <NetworkProxySettingsFields language={props.value.appLanguage} value={props.value.networkProxy} disabled={!props.client} onChange={(networkProxy) => save({ networkProxy })} />
        </NativeSettingsPane>
      </section>
      <details className="settings-disclosure settings-permission-help">
        <summary>{zh ? 'AI 操作权限如何生效' : 'How AI permissions work'}</summary>
        <p>
          {zh
            ? '权限在每个会话的输入框中选择，也可在创建任务会话时设置。这里没有额外的全局权限开关。'
            : 'Choose permissions in each conversation composer or when creating a task conversation. There is no extra global permission switch here.'}
        </p>
        <dl>
          <div>
            <dt>{zh ? '只读' : 'Read only'}</dt>
            <dd>{zh ? '以读取和分析为主，不直接修改文件。' : 'Read and analyze without directly changing files.'}</dd>
          </div>
          <div>
            <dt>{zh ? '自动' : 'Auto'}</dt>
            <dd>{zh ? '在工作目录内处理任务；越界访问及需要授权的操作会发起确认。' : 'Work within the workspace. Access beyond it and other restricted actions require approval.'}</dd>
          </div>
          <div>
            <dt>{zh ? '完全访问' : 'Full access'}</dt>
            <dd>
              {zh
                ? '放开该会话的文件和命令限制。浏览器、电脑操作仍遵守各自的开关和敏感操作确认。'
                : 'Removes file and command restrictions for that conversation. Browser and computer controls still enforce their own settings and sensitive-action approvals.'}
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
