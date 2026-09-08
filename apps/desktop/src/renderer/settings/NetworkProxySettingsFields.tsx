import { defaultNetworkProxySettings, type NetworkProxySettings } from '@zeus/shared';
import { NativeControlRow } from '../features/workspace/workspaceSupport.js';
import { ZeusSelect } from '../ZeusSelect.js';

/** 代理只维护通用设置草稿，复用页面已有保存入口。 */
export function NetworkProxySettingsFields(props: {
  /** 当前界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 未配置时保留原网络行为。 */
  value: NetworkProxySettings | undefined;
  /** 保存期间禁止继续修改草稿。 */
  disabled: boolean;
  /** 由通用设置持有草稿，避免引入第二套保存状态。 */
  onChange: (value: NetworkProxySettings) => void;
}) {
  /** 新字段在旧设置中可能尚不存在。 */
  const value = props.value ?? defaultNetworkProxySettings;
  /** 跟随当前应用语言，无额外持久状态。 */
  const zh = props.language === 'zh-CN';
  return (
    <>
      <NativeControlRow
        title={zh ? '网络代理' : 'Network proxy'}
        description={
          zh
            ? '保存后，待任务结束，完全退出并重新打开 Zeus 生效；仅关闭窗口或保留后台任务不会生效。适用于 Zeus 网络请求、内置浏览器和新启动的模型进程。'
            : 'Save, let tasks finish, then fully quit and reopen Zeus to apply. Closing a window or keeping tasks in the background is insufficient. Applies to Zeus requests, the built-in browser and newly started model processes.'
        }
      >
        {/* 复用同页选择控件，保留下拉箭头和统一键盘操作。 */}
        <ZeusSelect<NetworkProxySettings['mode']>
          size="roomy"
          ariaLabel={zh ? '网络代理模式' : 'Network proxy mode'}
          value={value.mode}
          disabled={props.disabled}
          onChange={(mode) => props.onChange({ ...value, mode })}
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
              onChange={(event) => props.onChange({ ...value, url: event.currentTarget.value })}
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
              onChange={(event) => props.onChange({ ...value, bypass: event.currentTarget.value })}
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
    </>
  );
}
