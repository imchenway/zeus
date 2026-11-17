import { useEffect, useRef, useState } from 'react';
import type { AppShellSettings, DashboardClient } from '../apiClient.js';
import { notifyMainAppShellSettingsChanged } from '../appShellBridge.js';
import { Button } from '../ui/Button.js';
import { NetworkProxySettingsFields } from './NetworkProxySettingsFields.js';
import { SettingsSaveStatus } from './useSettingsAutosave.js';
import type { NetworkProxySettings } from '@zeus/shared';

/** 网络页只依赖代理保存与两类现有模型连接诊断。 */
type NetworkSettingsClient = Pick<DashboardClient, 'loadModelConnections' | 'diagnoseModelConnection' | 'diagnoseCodexConnection'> & {
  /** 设置写入仍由原有设置边界拥有。 */
  settings: Pick<DashboardClient['settings'], 'loadActiveNetworkProxy' | 'saveAppShellSettings'>;
};

/** 用用户操作语言概括代理，不把协议、主机和端口藏在内部字段里。 */
function describeNetworkProxy(settings: NetworkProxySettings | null, zh: boolean): string {
  if (!settings) return zh ? '读取中…' : 'Loading…';
  if (settings.mode === 'direct') return zh ? '强制直连' : 'Force direct connection';
  if (settings.mode === 'default') return zh ? '跟随系统代理' : 'Use system proxy';
  return `${settings.url}${settings.bypass ? (zh ? ` · 绕过 ${settings.bypass}` : ` · bypass ${settings.bypass}`) : ''}`;
}

/** 三个持久字段完全一致才表示当前宿主已经使用最新保存值。 */
function sameNetworkProxy(left: NetworkProxySettings | null, right: NetworkProxySettings): boolean {
  return left !== null && left.mode === right.mode && left.url === right.url && left.bypass === right.bypass;
}

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
  /** 连续编辑按提交顺序应用，避免较早的保存覆盖最新代理。 */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  /** 保存状态显示在独立页面标题旁。 */
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  /** 生效值由正式出口读取，保存成功后立即刷新。 */
  const [activeProxy, setActiveProxy] = useState<NetworkProxySettings | null>(null);
  /** 生效配置读取失败时明确显示未知，不猜测为最新保存值。 */
  const [activeProxyUnavailable, setActiveProxyUnavailable] = useState(false);

  useEffect(() => {
    /** 设置导入或其他窗口更新后，摘要跟随最新已保存值。 */
    latestProxy.current = props.value.networkProxy ?? { mode: 'default', url: '', bypass: '' };
  }, [props.value.networkProxy]);

  useEffect(() => {
    /** 页面切换后迟到请求不能覆盖新客户端状态。 */
    let active = true;
    /** 初始读取不能覆盖随后完成的即时切换。 */
    const currentRevision = revision.current;
    setActiveProxy(null);
    setActiveProxyUnavailable(false);
    if (!props.client) {
      setActiveProxyUnavailable(true);
      return () => {
        active = false;
      };
    }
    void props.client.settings
      .loadActiveNetworkProxy()
      .then((value) => {
        if (active && currentRevision === revision.current) setActiveProxy(value);
      })
      .catch(() => {
        if (active && currentRevision === revision.current) setActiveProxyUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [props.client]);

  /** 保存即切换正式出口，检查请求等待此操作成功后再发出。 */
  async function save(networkProxy = latestProxy.current): Promise<void> {
    latestProxy.current = networkProxy;
    props.onChange((value) => ({ ...value, networkProxy }));
    /** 异步回执只归属本次保存。 */
    const currentRevision = ++revision.current;
    setStatus('saving');
    /** 每次先核对正式出口，连续失焦与检查不会重复切断相同配置的连接。 */
    const operation = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (!props.client) throw new Error(zh ? '本地设置服务暂不可用。' : 'Settings service is unavailable.');
        /** 先读取当前出口，其他窗口修改后也以真实状态为准。 */
        let applied = await props.client.settings.loadActiveNetworkProxy();
        if (!sameNetworkProxy(applied, networkProxy)) {
          /** 只提交本页拥有的字段，避免覆盖其他设置。 */
          const saved = await props.client.settings.saveAppShellSettings({ networkProxy });
          await notifyMainAppShellSettingsChanged({ zeus: window.zeus, settings: saved });
          applied = await props.client.settings.loadActiveNetworkProxy();
        }
        if (!sameNetworkProxy(applied, networkProxy)) throw new Error(zh ? '代理配置尚未生效，请重试。' : 'Proxy settings have not been applied. Please retry.');
        if (currentRevision === revision.current) {
          setActiveProxy(applied);
          setActiveProxyUnavailable(false);
          setStatus('saved');
        }
      });
    saveQueue.current = operation;
    try {
      await operation;
    } catch {
      if (currentRevision === revision.current) setStatus('failed');
      throw new Error(zh ? '代理配置应用失败，请重试。' : 'Failed to apply proxy settings. Please retry.');
    }
  }

  /** 检查只等待已有保存并读取正式配置，不能把其他窗口的新配置覆盖回旧草稿。 */
  async function beforeCheck(): Promise<NetworkProxySettings> {
    await saveQueue.current;
    if (!props.client) throw new Error(zh ? '本地设置服务暂不可用。' : 'Settings service is unavailable.');
    /** 外部保存和导入完成后，以同一份正式配置刷新摘要与表单。 */
    const active = await props.client.settings.loadActiveNetworkProxy();
    latestProxy.current = active;
    setActiveProxy(active);
    setActiveProxyUnavailable(false);
    props.onChange((value) => ({ ...value, networkProxy: active }));
    return active;
  }

  return (
    <section className="settings-product-pane network-settings-pane" aria-label={zh ? '网络' : 'Network'}>
      <header className="settings-page-heading">
        <span>
          <h2 className="settings-page-title">{zh ? '网络' : 'Network'}</h2>
        </span>
        <div className="settings-heading-actions">
          <SettingsSaveStatus status={status} language={props.value.appLanguage} />
          {status === 'failed' ? (
            <Button size="compact" onClick={() => save()}>
              {zh ? '重试' : 'Retry'}
            </Button>
          ) : null}
        </div>
      </header>
      <div className="network-runtime-summary" aria-label={zh ? '代理生效状态' : 'Proxy activation status'}>
        <div>
          <span>{zh ? '当前生效' : 'Active now'}</span>
          <strong role="status" aria-live="polite">
            {activeProxyUnavailable ? (zh ? '无法读取' : 'Unavailable') : describeNetworkProxy(activeProxy, zh)}
          </strong>
        </div>
      </div>
      <div className="settings-group-stack">
        <NetworkProxySettingsFields language={props.value.appLanguage} value={props.value.networkProxy} activeValue={activeProxy} disabled={!props.client} client={props.client} onChange={save} beforeCheck={beforeCheck} />
      </div>
    </section>
  );
}
