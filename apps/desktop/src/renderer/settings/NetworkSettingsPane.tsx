import { useRef, useState } from 'react';
import type { AppShellSettings, DashboardClient } from '../apiClient.js';
import { NativeSettingsPane } from '../features/workspace/workspaceSupport.js';
import { notifyMainAppShellSettingsChanged } from '../appShellBridge.js';
import { reportApplicationError } from '../ui/ApplicationErrorDialog.js';
import { Button } from '../ui/Button.js';
import { NetworkProxySettingsFields } from './NetworkProxySettingsFields.js';
import { SettingsSaveStatus } from './useSettingsAutosave.js';
import type { NetworkProxySettings } from '@zeus/shared';

/** 网络页只依赖代理保存与两类现有模型连接诊断。 */
type NetworkSettingsClient = Pick<DashboardClient, 'loadModelConnections' | 'diagnoseModelConnection' | 'diagnoseCodexConnection'> & {
  /** 设置写入仍由原有设置边界拥有。 */
  settings: Pick<DashboardClient['settings'], 'saveAppShellSettings'>;
};

/** 网络设置独立保存代理字段，不携带通用页面的旧快照。 */
export function NetworkSettingsPane(props: {
  /** 已加载的应用设置。 */
  value: AppShellSettings;
  /** 复用已有局部设置接口。 */
  client: NetworkSettingsClient | null;
  /** 保存前同步当前界面草稿。 */
  onChange: (update: (value: AppShellSettings) => AppShellSettings) => unknown;
}) {
  /** 本页文案跟随当前应用语言。 */
  const zh = props.value.appLanguage === 'zh-CN';
  /** 最后一次合法配置用于失败后的明确重试。 */
  const latestProxy = useRef<NetworkProxySettings>(props.value.networkProxy ?? { mode: 'default', url: '', bypass: '' });
  /** 只有最新保存操作可以更新页面反馈。 */
  const revision = useRef(0);
  /** 保存状态显示在独立页面标题旁。 */
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  /** 保存代理配置并通知 Main；实际任务网络仍按产品规则在完全重启后切换。 */
  async function save(networkProxy = latestProxy.current): Promise<void> {
    latestProxy.current = networkProxy;
    props.onChange((value) => ({ ...value, networkProxy }));
    /** 异步回执只归属本次保存。 */
    const currentRevision = ++revision.current;
    setStatus('saving');
    try {
      if (!props.client) throw new Error(zh ? '本地设置服务暂不可用。' : 'Settings service is unavailable.');
      /** 只提交本页拥有的字段，避免覆盖其他设置。 */
      const saved = await props.client.settings.saveAppShellSettings({ networkProxy });
      await notifyMainAppShellSettingsChanged({ zeus: window.zeus, settings: saved });
      if (currentRevision === revision.current) setStatus('saved');
    } catch (error) {
      if (currentRevision !== revision.current) return;
      setStatus('failed');
      reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' });
    }
  }

  return (
    <section className="settings-product-pane network-settings-pane" aria-label={zh ? '网络' : 'Network'}>
      <header className="settings-page-heading">
        <span>
          <h2 className="settings-page-title">{zh ? '网络' : 'Network'}</h2>
          <p>{zh ? '配置代理，并检查浏览器、模型宿主与当前已配置模型的连接。' : 'Configure a proxy and check browser, model-host, and currently configured model connections.'}</p>
        </span>
        <div className="settings-heading-actions">
          <SettingsSaveStatus status={status} language={props.value.appLanguage} />
          {status === 'failed' ? (
            <Button size="compact" onClick={() => void save()}>
              {zh ? '重试' : 'Retry'}
            </Button>
          ) : null}
        </div>
      </header>
      <NativeSettingsPane label={zh ? '网络代理与连接检测' : 'Network proxy and connection checks'}>
        <NetworkProxySettingsFields language={props.value.appLanguage} value={props.value.networkProxy} disabled={!props.client} client={props.client} onChange={(networkProxy) => void save(networkProxy)} />
      </NativeSettingsPane>
    </section>
  );
}
