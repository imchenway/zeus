import { useId, useState } from 'react';
import {
  defaultNetworkProxySettings,
  networkProxyAddressFields,
  networkProxySettingsFromFields,
  type NetworkProxySettings,
  type NetworkProxyAddressFields,
  type NetworkProxyCheckResult,
  type NetworkProxyConnectionResult,
} from '@zeus/shared';
import { NativeControlRow } from '../features/workspace/workspaceSupport.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';

/** 代理主机和端口分别编辑，合法草稿仍沿用原有自动保存入口。 */
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
  /** 草稿保留未完成的主机和端口，不写入设置。 */
  const [draft, setDraft] = useState(() => ({ ...networkProxyAddressFields(props.value ?? defaultNetworkProxySettings), mode: props.value?.mode ?? 'default', bypass: props.value?.bypass ?? '' }));
  /** 输入错误就地展示，用户可以继续修正。 */
  const [error, setError] = useState<string | null>(null);
  /** 默认检查公开网页，用户可改成实际使用的网站。 */
  const [target, setTarget] = useState('https://example.com');
  /** 检查期间锁定草稿，避免把旧结果显示在新配置下。 */
  const [checking, setChecking] = useState(false);
  /** 两条网络链路分别报告，修改输入后清空旧结果。 */
  const [result, setResult] = useState<NetworkProxyCheckResult | null>(null);
  /** 检查失败与保存校验错误分别展示。 */
  const [checkError, setCheckError] = useState<string | null>(null);
  /** 同页多窗口控件具有独立的可访问性标识。 */
  const id = useId();
  /** 跟随当前应用语言，无额外持久状态。 */
  const zh = props.language === 'zh-CN';
  /** 检查时锁定输入，服务不可用时禁止保存。 */
  const disabled = props.disabled || checking;

  /** 修改草稿即废弃先前检查反馈；不丢弃已输入的手动配置。 */
  function edit(patch: Partial<typeof draft>): typeof draft {
    /** 合并本次字段，供选择模式或协议时即时提交。 */
    const next = { ...draft, ...patch };
    setDraft(next);
    setError(null);
    setResult(null);
    setCheckError(null);
    return next;
  }

  /** 输入完成后沿用服务端同一套地址校验。 */
  function commit(next = draft): void {
    try {
      /** 保留草稿中的独立端口，存储继续使用规范化 URL。 */
      const normalized = networkProxySettingsFromFields(next.mode, next, next.bypass);
      setError(null);
      props.onChange(normalized);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : zh ? '代理配置无效。' : 'Invalid proxy settings.');
    }
  }

  /** 当前草稿直接交给隔离检查，不修改任何运行中的网络会话。 */
  async function checkConnection(): Promise<void> {
    setResult(null);
    setCheckError(null);
    try {
      /** 检查与保存使用完全相同的字段组装和校验。 */
      const settings = networkProxySettingsFromFields(draft.mode, draft, draft.bypass);
      if (!window.zeus?.checkNetworkProxyConnection) throw new Error(zh ? '请在 Zeus 桌面应用中检查连接。' : 'Check the connection in the Zeus desktop app.');
      setChecking(true);
      setResult(await window.zeus.checkNetworkProxyConnection(settings, target));
    } catch (cause) {
      setCheckError(cause instanceof Error ? cause.message : zh ? '连接检查失败。' : 'Connection check failed.');
    } finally {
      setChecking(false);
    }
  }

  /** HTTP 拒绝响应仍表明网络可达，不能误报为网站或模型服务可用。 */
  function describeConnection(connection: NetworkProxyConnectionResult): string {
    if (connection.error === 'authentication') return zh ? '代理要求认证，请使用无需认证的 HTTP 端口。' : 'Proxy authentication required. Use an HTTP port without authentication.';
    if (connection.error === 'timeout') return zh ? '连接超时，请检查地址、端口和代理服务。' : 'Timed out. Check the address, port, and proxy service.';
    if (connection.error) return zh ? '连接失败，请检查网络及代理服务。' : 'Connection failed. Check your network and proxy service.';
    return zh ? `已收到网站响应（HTTP ${connection.statusCode}）` : `Received a response (HTTP ${connection.statusCode})`;
  }

  return (
    <>
      <NativeControlRow title={zh ? '代理模式' : 'Proxy mode'} description={zh ? '输入完成后自动保存。待任务结束，完全退出并重新打开 Zeus 生效。' : 'Saves when editing finishes. Let tasks finish, then fully quit and reopen Zeus to apply.'}>
        <div className="network-proxy-modes" role="radiogroup" aria-label={zh ? '网络代理模式' : 'Network proxy mode'}>
          {(
            [
              { value: 'direct', label: zh ? '不使用代理' : 'No proxy' },
              { value: 'default', label: zh ? '跟随系统与启动环境' : 'System and launch environment' },
              { value: 'manual', label: zh ? '手动配置代理' : 'Manual proxy configuration' },
            ] as const
          ).map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={`${id}-mode`}
                value={option.value}
                checked={draft.mode === option.value}
                disabled={disabled}
                onChange={() => {
                  /** 手动模式字段不完整时先保留草稿，避免写入空地址。 */
                  const next = edit({ mode: option.value });
                  if (next.mode !== 'manual' || (next.host && next.port)) commit(next);
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </NativeControlRow>
      {draft.mode === 'manual' ? (
        <>
          <NativeControlRow
            title={zh ? '代理协议' : 'Proxy protocol'}
            description={
              zh ? '选择代理服务器使用的协议。可使用本机代理客户端的 HTTP 端口；暂不支持 SOCKS 和账号密码。' : 'Choose the proxy server protocol. Use the HTTP port of your local proxy client. SOCKS and authentication are not supported.'
            }
          >
            <ZeusSelect<NetworkProxyAddressFields['protocol']>
              size="regular"
              ariaLabel={zh ? '代理协议' : 'Proxy protocol'}
              value={draft.protocol}
              disabled={disabled}
              options={[
                { value: 'http', label: 'HTTP' },
                { value: 'https', label: 'HTTPS' },
              ]}
              onChange={(protocol) => {
                /** 主机和端口齐全后，协议切换才自动保存。 */
                const next = edit({ protocol });
                if (next.host && next.port) commit(next);
              }}
            />
          </NativeControlRow>
          <NativeControlRow title={zh ? '主机名' : 'Host name'} description={zh ? '填写域名或 IP，不需要填写协议和端口。' : 'Enter a hostname or IP, without the protocol or port.'}>
            <input
              aria-label={zh ? '主机名' : 'Host name'}
              aria-describedby={error ? `${id}-error` : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="127.0.0.1"
              value={draft.host}
              disabled={disabled}
              onChange={(event) => edit({ host: event.currentTarget.value })}
              onBlur={() => commit()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </NativeControlRow>
          <NativeControlRow title={zh ? '端口号' : 'Port number'} description={zh ? '范围为 1–65535，与代理客户端的端口保持一致。' : 'Use a port from 1–65535, matching your proxy client.'}>
            <input
              className="network-proxy-port"
              aria-label={zh ? '端口号' : 'Port number'}
              aria-describedby={error ? `${id}-error` : undefined}
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              step={1}
              placeholder="7890"
              value={draft.port}
              disabled={disabled}
              onChange={(event) => edit({ port: event.currentTarget.value })}
              onBlur={() => commit()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </NativeControlRow>
          <NativeControlRow
            title={zh ? '不使用代理的地址' : 'No proxy for'}
            description={
              zh ? '可选，用逗号分隔域名、以点开头的域名后缀或 IPv4 地址。本机回环地址自动直连。' : 'Optional: comma-separated hosts, domain suffixes starting with a dot, or IPv4 addresses. Loopback addresses always connect directly.'
            }
          >
            <input
              aria-label={zh ? '不使用代理的地址' : 'No proxy for'}
              aria-describedby={error ? `${id}-error` : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder=".example.com,192.168.1.10"
              value={draft.bypass}
              disabled={disabled}
              onChange={(event) => edit({ bypass: event.currentTarget.value })}
              onBlur={() => commit()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </NativeControlRow>
        </>
      ) : draft.mode === 'default' ? (
        <p className="settings-field-note">
          {zh
            ? '内置浏览器使用系统代理；模型进程沿用 Zeus 启动时的环境。外部浏览器和工具仍自行管理网络设置。'
            : 'The built-in browser uses system proxy settings; model processes inherit the Zeus launch environment. External browsers and tools manage their own network settings.'}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="settings-field-error" role="alert">
          {error} {zh ? '尚未保存。' : 'Not saved.'}
        </p>
      ) : null}
      {draft.mode === 'manual' && (!draft.host || !draft.port) && !error ? (
        <p className="settings-field-note" role="status">
          {zh ? '填写主机名和端口号后自动保存，当前模式尚未保存。' : 'Enter a host and port to save. This mode has not been saved yet.'}
        </p>
      ) : null}
      <NativeControlRow
        className="network-proxy-check-row"
        title={zh ? '检查网址' : 'Check URL'}
        description={
          zh
            ? '使用当前填写的配置分别检查两条网络链路，不切换运行中的代理。收到响应不代表模型账号或 API 权限可用。'
            : 'Check both network paths using this form without changing the active proxy. A response does not verify model credentials or API access.'
        }
      >
        <span className="network-proxy-check">
          <input
            type="url"
            aria-label={zh ? '检查网址' : 'Check URL'}
            autoComplete="off"
            spellCheck={false}
            value={target}
            disabled={disabled}
            onChange={(event) => {
              setTarget(event.currentTarget.value);
              setResult(null);
              setCheckError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !disabled) void checkConnection();
            }}
          />
          <Button disabled={disabled || !window.zeus?.checkNetworkProxyConnection} busy={checking} onClick={() => void checkConnection()}>
            {checking ? (zh ? '正在检查…' : 'Checking…') : zh ? '检查连接' : 'Check connection'}
          </Button>
        </span>
      </NativeControlRow>
      {!window.zeus?.checkNetworkProxyConnection ? <p className="settings-field-note">{zh ? '请在 Zeus 桌面应用中检查连接。' : 'Check the connection in the Zeus desktop app.'}</p> : null}
      <div aria-live="polite" aria-busy={checking}>
        {checking ? <p className="settings-field-note">{zh ? '正在检查浏览器与模型网络，最多约 10 秒…' : 'Checking browser and model networks, up to about 10 seconds…'}</p> : null}
        {result ? (
          <dl className="network-proxy-results">
            <div>
              <dt>{zh ? '内置浏览器' : 'Built-in browser'}</dt>
              <dd>{describeConnection(result.browser)}</dd>
            </div>
            <div>
              <dt>{zh ? '模型网络' : 'Model network'}</dt>
              <dd>{describeConnection(result.node)}</dd>
            </div>
          </dl>
        ) : null}
      </div>
      {checkError ? (
        <p className="settings-field-error" role="alert">
          {checkError}
        </p>
      ) : null}
    </>
  );
}
