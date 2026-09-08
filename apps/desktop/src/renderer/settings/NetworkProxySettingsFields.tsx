import { useState } from 'react';
import { defaultNetworkProxySettings, normalizeNetworkProxySettings, type NetworkProxySettings } from '@zeus/shared';
import { NativeControlRow } from '../features/workspace/workspaceSupport.js';
import { ZeusSelect } from '../ZeusSelect.js';

/** 代理草稿就地校验，结束输入后自动保存完整地址。 */
export function NetworkProxySettingsFields(props: {
  /** 当前界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 未配置时保留原网络行为。 */
  value: NetworkProxySettings | undefined;
  /** 服务不可用时禁止修改。 */
  disabled: boolean;
  /** 只有通过校验的配置交给通用自动保存入口。 */
  onChange: (value: NetworkProxySettings) => void;
}) {
  /** 新字段在旧设置中可能尚不存在。 */
  const [value, setValue] = useState(props.value ?? defaultNetworkProxySettings);
  /** 无效地址保留输入，避免保存半截地址或默默丢失草稿。 */
  const [error, setError] = useState<string | null>(null);
  /** 跟随当前应用语言，无额外持久状态。 */
  const zh = props.language === 'zh-CN';
  /** 输入完成后沿用服务端同一套校验。 */
  function commit(next: NetworkProxySettings): void {
    try {
      /** 规范化主机和绕过列表后才保存。 */
      const normalized = normalizeNetworkProxySettings(next);
      setValue(normalized);
      setError(null);
      props.onChange(normalized);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : zh ? '代理配置无效，尚未保存。' : 'Invalid proxy settings. Not saved.');
    }
  }
  return (
    <>
      <NativeControlRow
        title={zh ? '网络代理' : 'Network proxy'}
        description={zh ? '输入完成后自动保存。待任务结束，完全退出并重新打开 Zeus 生效。' : 'Saves when editing finishes. Let tasks finish, then fully quit and reopen Zeus to apply.'}
      >
        {/* 复用同页选择控件，保留下拉箭头和统一键盘操作。 */}
        <ZeusSelect<NetworkProxySettings['mode']>
          size="regular"
          ariaLabel={zh ? '网络代理模式' : 'Network proxy mode'}
          value={value.mode}
          disabled={props.disabled}
          onChange={(mode) => {
            /** 手动代理必须有完整地址，选择模式时先保留草稿。 */
            const next = { ...value, mode };
            setValue(next);
            setError(null);
            if (mode !== 'manual' || next.url) commit(next);
          }}
          options={[
            { value: 'default', label: zh ? '保持默认' : 'Keep defaults' },
            { value: 'direct', label: zh ? '直连（不使用代理）' : 'Direct (no proxy)' },
            { value: 'manual', label: zh ? '手动代理' : 'Manual proxy' },
          ]}
        />
      </NativeControlRow>
      {value.mode === 'manual' ? (
        <>
          <NativeControlRow
            title={zh ? '代理地址' : 'Proxy address'}
            description={zh ? '支持 HTTP/HTTPS 代理，不支持 SOCKS 或账号密码。可填写本机代理客户端的 HTTP 端口。' : 'Supports HTTP/HTTPS proxies without credentials. SOCKS is not supported. Use the HTTP port of your local proxy client.'}
          >
            <input
              aria-label={zh ? '代理地址' : 'Proxy address'}
              type="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://127.0.0.1:7890"
              value={value.url}
              disabled={props.disabled}
              onChange={(event) => setValue({ ...value, url: event.currentTarget.value })}
              onBlur={() => commit(value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </NativeControlRow>
          <NativeControlRow
            title={zh ? '绕过代理' : 'Bypass proxy'}
            description={
              zh ? '可选，用逗号分隔域名、以点开头的域名后缀或 IPv4 地址。本机回环地址自动直连。' : 'Optional: comma-separated hostnames, domain suffixes starting with a dot, or IPv4 addresses. Loopback addresses always connect directly.'
            }
          >
            <input
              aria-label={zh ? '绕过代理' : 'Bypass proxy'}
              autoComplete="off"
              spellCheck={false}
              placeholder=".example.com,192.168.1.10"
              value={value.bypass}
              disabled={props.disabled}
              onChange={(event) => setValue({ ...value, bypass: event.currentTarget.value })}
              onBlur={() => commit(value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </NativeControlRow>
        </>
      ) : value.mode === 'default' ? (
        <NativeControlRow
          title={zh ? '默认行为' : 'Default behavior'}
          description={
            zh
              ? '内置浏览器沿用系统代理；模型进程沿用 Zeus 启动时的环境。外部浏览器及工具自己的网络设置仍由其自行管理。'
              : 'The built-in browser follows system proxy settings; model processes inherit the Zeus launch environment. External browsers and tools manage their own network settings.'
          }
        >
          <span>{zh ? '不覆盖现有配置' : 'No override'}</span>
        </NativeControlRow>
      ) : null}
      {error ? (
        <p className="settings-field-error" role="alert">
          {error} {zh ? '尚未保存。' : 'Not saved.'}
        </p>
      ) : null}
      {value.mode === 'manual' && !value.url && !error ? (
        <p className="settings-field-note" role="status">
          {zh ? '填写代理地址后自动保存。' : 'Enter a proxy address to save.'}
        </p>
      ) : null}
    </>
  );
}
