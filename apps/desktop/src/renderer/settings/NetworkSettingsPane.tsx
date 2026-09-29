import { useEffect, useRef, useState } from 'react';
import type { AppShellSettings, DashboardClient } from '../apiClient.js';
import { NativeSettingsPane } from '../features/workspace/workspaceSupport.js';
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
  if (settings.mode === 'direct') return zh ? '直连，不使用代理' : 'Direct, no proxy';
  if (settings.mode === 'default') return zh ? '跟随系统与启动环境' : 'System and launch environment';
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
  /** 保存状态显示在独立页面标题旁。 */
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  /** 宿主启动时冻结的真实生效代理，与保存后的草稿分开显示。 */
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
        if (active) setActiveProxy(value);
      })
      .catch(() => {
        if (active) setActiveProxyUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [props.client]);

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
    } catch {
      if (currentRevision !== revision.current) return;
      setStatus('failed');
    }
  }

  return (
    <section className="settings-product-pane network-settings-pane" aria-label={zh ? '网络' : 'Network'}>
      <header className="settings-page-heading">
        <span>
          <h2 className="settings-page-title">{zh ? '网络' : 'Network'}</h2>
          <p>{zh ? '配置 Zeus 的统一代理，并分别验证网页链路与模型真实请求。' : 'Configure the shared Zeus proxy, then verify web paths and real model requests separately.'}</p>
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
      <div className="network-runtime-summary" aria-label={zh ? '代理生效状态' : 'Proxy activation status'}>
        <div>
          <span>{zh ? '当前运行' : 'Active now'}</span>
          <strong>{activeProxyUnavailable ? (zh ? '无法读取' : 'Unavailable') : describeNetworkProxy(activeProxy, zh)}</strong>
          <small>{zh ? '供应商真实请求使用这套配置' : 'Real provider requests use this configuration'}</small>
        </div>
        <div data-state={activeProxyUnavailable ? 'unknown' : sameNetworkProxy(activeProxy, latestProxy.current) ? 'active' : 'restart'}>
          <span>{zh ? '已保存' : 'Saved'}</span>
          <strong>{describeNetworkProxy(latestProxy.current, zh)}</strong>
          <small>
            {activeProxyUnavailable
              ? zh
                ? '无法判断是否需要重启'
                : 'Restart requirement is unknown'
              : sameNetworkProxy(activeProxy, latestProxy.current)
                ? zh
                  ? '已在当前宿主生效'
                  : 'Active in the current host'
                : zh
                  ? '待任务结束后完全退出并重开 Zeus'
                  : 'Fully quit and reopen Zeus after tasks finish'}
          </small>
        </div>
      </div>
      <NativeSettingsPane label={zh ? '网络代理与连接检测' : 'Network proxy and connection checks'}>
        <NetworkProxySettingsFields language={props.value.appLanguage} value={props.value.networkProxy} activeValue={activeProxy} disabled={!props.client} client={props.client} onChange={(networkProxy) => void save(networkProxy)} />
      </NativeSettingsPane>
    </section>
  );
}
