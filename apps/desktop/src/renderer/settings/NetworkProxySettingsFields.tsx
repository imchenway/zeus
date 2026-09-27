import { useEffect, useId, useState } from 'react';
import {
  defaultNetworkProxySettings,
  networkProxyAddressFields,
  networkProxySettingsFromFields,
  type NetworkProxySettings,
  type NetworkProxyAddressFields,
  type NetworkProxyCheckResult,
  type NetworkProxyConnectionResult,
} from '@zeus/shared';
import type { DashboardClient, ModelConnectionRecord } from '../apiClient.js';
import { NativeControlRow } from '../features/workspace/workspaceSupport.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';

/** 网络页只读取现有模型连接并调用各自真实鉴权诊断。 */
type NetworkModelConnectionClient = Pick<DashboardClient, 'loadModelConnections' | 'diagnoseModelConnection' | 'diagnoseCodexConnection'>;

/** 一行对应一个实际模型来源，模型清单跟随“模型供应商”配置。 */
interface NetworkModelConnectionRow {
  /** Codex 使用固定身份，自定义连接沿用持久化身份。 */
  id: string;
  /** 用户在模型设置中看到的来源名称。 */
  name: string;
  /** 当前启用模型；Codex 在检查时刷新官方目录。 */
  modelIds: string[];
  /** 未检查时为空，检查后同时提供文字结论与延迟。 */
  result: { ok: boolean; latencyMs: number; message: string } | null;
}

/** 代理主机和端口分别编辑，合法草稿仍沿用原有自动保存入口。 */
export function NetworkProxySettingsFields(props: {
  /** 当前界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 未配置时保留原网络行为。 */
  value: NetworkProxySettings | undefined;
  /** 服务不可用时禁止修改。 */
  disabled: boolean;
  /** 复用模型供应商和 Codex 订阅的现有诊断接口。 */
  client: NetworkModelConnectionClient | null;
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
  /** 已配置模型来源随模型设置列表刷新，不维护第二份厂商目录。 */
  const [configuredConnections, setConfiguredConnections] = useState<ModelConnectionRecord[]>([]);
  /** 连接诊断结果按模型来源展示，Codex 订阅始终位于首行。 */
  const [modelConnectionResults, setModelConnectionResults] = useState<NetworkModelConnectionRow[] | null>(null);
  /** 读取配置与主动诊断分别反馈，避免把列表加载误报为外部检查。 */
  const [loadingConnections, setLoadingConnections] = useState(false);
  /** 模型连接检查与单网址检查互斥，避免并发操作混淆结果。 */
  const [checkingModelConnections, setCheckingModelConnections] = useState(false);
  /** 检查失败与保存校验错误分别展示。 */
  const [checkError, setCheckError] = useState<string | null>(null);
  /** 同页多窗口控件具有独立的可访问性标识。 */
  const id = useId();
  /** 跟随当前应用语言，无额外持久状态。 */
  const zh = props.language === 'zh-CN';
  /** 检查时锁定输入，服务不可用时禁止保存。 */
  const disabled = props.disabled || checking || checkingModelConnections;

  useEffect(() => {
    /** 卸载或切换本地服务后，迟到列表不能覆盖新页面。 */
    let active = true;
    if (!props.client) {
      setConfiguredConnections([]);
      return () => {
        active = false;
      };
    }
    setLoadingConnections(true);
    void props.client
      .loadModelConnections()
      .then((connections) => {
        if (!active) return;
        setConfiguredConnections(connections);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setCheckError(cause instanceof Error ? cause.message : zh ? '模型连接列表读取失败。' : 'Failed to load model connections.');
      })
      .finally(() => {
        if (active) setLoadingConnections(false);
      });
    return () => {
      active = false;
    };
  }, [props.client, zh]);

  /** 修改草稿即废弃先前检查反馈；不丢弃已输入的手动配置。 */
  function edit(patch: Partial<typeof draft>): typeof draft {
    /** 合并本次字段，供选择模式或协议时即时提交。 */
    const next = { ...draft, ...patch };
    setDraft(next);
    setError(null);
    setResult(null);
    setModelConnectionResults(null);
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

  /** 只取启用且至少配置一个启用模型的连接，保持与真实可选模型一致。 */
  function configuredModelConnections(connections: ModelConnectionRecord[]): Array<{ connection: ModelConnectionRecord; modelIds: string[] }> {
    return connections.flatMap((connection) => {
      /** 候选池里未启用的模型不属于当前可用列表。 */
      const modelIds = connection.models.filter((model) => model.enabled).map((model) => model.displayName || model.id);
      return connection.enabled && modelIds.length > 0 ? [{ connection, modelIds }] : [];
    });
  }

  /** 单个来源失败只落到自己的行，不能吞掉其他并行连接的结果。 */
  async function checkModelConnectionRow(target: Omit<NetworkModelConnectionRow, 'result'>, check: () => Promise<{ ok: boolean; latencyMs: number; message: string; modelIds?: string[] }>): Promise<NetworkModelConnectionRow> {
    /** 本地 API 传输失败时仍计算用户实际等待时间。 */
    const startedAt = performance.now();
    try {
      const diagnostic = await check();
      return {
        ...target,
        modelIds: diagnostic.modelIds ?? target.modelIds,
        result: { ok: diagnostic.ok, latencyMs: diagnostic.latencyMs, message: diagnostic.message },
      };
    } catch (cause) {
      return {
        ...target,
        result: {
          ok: false,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          message: cause instanceof Error ? cause.message : zh ? '连接检查失败。' : 'Connection check failed.',
        },
      };
    }
  }

  /** 并行调用真实鉴权目录：Codex 刷新订阅，自定义连接使用已保存 API Key。 */
  async function checkModelConnections(): Promise<void> {
    setModelConnectionResults(null);
    setCheckError(null);
    try {
      /** 冻结本次客户端，页面切换不会让同一批请求混用连接。 */
      const client = props.client;
      if (!client) throw new Error(zh ? '本地模型服务暂不可用。' : 'The local model service is unavailable.');
      setCheckingModelConnections(true);
      /** 每次点击先取最新连接，新增、删除和启用状态无需同步维护。 */
      const connections = await client.loadModelConnections();
      const targets = configuredModelConnections(connections);
      setConfiguredConnections(connections);
      /** 各连接互不依赖；并行检查并逐行吸收失败，避免按来源累加等待或整批丢失。 */
      setModelConnectionResults(
        await Promise.all([
          checkModelConnectionRow({ id: 'codex', name: zh ? 'Codex 订阅' : 'Codex subscription', modelIds: [] }, () => client.diagnoseCodexConnection()),
          ...targets.map(({ connection, modelIds }) => checkModelConnectionRow({ id: connection.id, name: connection.name, modelIds }, () => client.diagnoseModelConnection(connection.id))),
        ]),
      );
    } catch (cause) {
      setCheckError(cause instanceof Error ? cause.message : zh ? '模型连接检查失败。' : 'Model connection check failed.');
    } finally {
      setCheckingModelConnections(false);
    }
  }

  /** 长模型清单折叠为前四项和剩余数量，完整数量仍清楚可见。 */
  function describeModels(modelIds: string[]): string {
    if (modelIds.length === 0) return zh ? '未返回可用模型' : 'No available models returned';
    /** 四项足以识别来源，同时避免设置页被几十个模型撑开。 */
    const visible = modelIds.slice(0, 4).join('、');
    const remaining = modelIds.length - 4;
    return remaining > 0 ? (zh ? `${visible} 等 ${modelIds.length} 个模型` : `${visible} and ${remaining} more (${modelIds.length} total)`) : visible;
  }

  /** HTTP 拒绝响应仍表明网络可达，不能误报为网站或模型服务可用。 */
  function describeConnection(connection: NetworkProxyConnectionResult): string {
    if (connection.error === 'authentication') return zh ? `代理要求认证 · ${connection.latencyMs} 毫秒` : `Proxy authentication required · ${connection.latencyMs} ms`;
    if (connection.error === 'timeout') return zh ? '连接超时 · 超过 10 秒' : 'Timed out · over 10 s';
    if (connection.error) return zh ? `连接失败 · ${connection.latencyMs} 毫秒` : `Connection failed · ${connection.latencyMs} ms`;
    return zh ? `可达 · ${connection.latencyMs} 毫秒（HTTP ${connection.statusCode}）` : `Reachable · ${connection.latencyMs} ms (HTTP ${connection.statusCode})`;
  }

  /** 未检测前也展示真实配置清单；检测后用同一稳定身份替换状态。 */
  const modelConnectionRows = modelConnectionResults ?? [
    { id: 'codex', name: zh ? 'Codex 订阅' : 'Codex subscription', modelIds: [], result: null },
    ...configuredModelConnections(configuredConnections).map(({ connection, modelIds }) => ({ id: connection.id, name: connection.name, modelIds, result: null })),
  ];

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
      <NativeControlRow
        className="network-model-connection-check-row"
        title={zh ? '已配置模型连接' : 'Configured model connections'}
        description={
          zh
            ? '列表直接读取“模型供应商”中已启用的模型，并包含 Codex 订阅。使用已保存凭据检查鉴权和模型目录，不发送收费推理请求；代理修改需重启 Zeus 后才会用于此项检查。'
            : 'The list follows enabled models in Model Providers and includes the Codex subscription. Saved credentials verify authentication and model catalogs without paid inference; restart Zeus after proxy changes before running this check.'
        }
      >
        <Button disabled={disabled || !props.client || loadingConnections} busy={checkingModelConnections} onClick={() => void checkModelConnections()}>
          {checkingModelConnections ? (zh ? '正在检测…' : 'Checking…') : zh ? '检测已配置连接' : 'Check configured connections'}
        </Button>
      </NativeControlRow>
      <div className="network-model-connection-status" aria-live="polite" aria-busy={checkingModelConnections || loadingConnections}>
        {loadingConnections ? <p className="settings-field-note">{zh ? '正在读取已配置模型…' : 'Loading configured models…'}</p> : null}
        {checkingModelConnections ? <p className="settings-field-note">{zh ? '正在并行验证真实鉴权与模型目录，最多约 15 秒…' : 'Checking real authentication and model catalogs in parallel, up to about 15 seconds…'}</p> : null}
        {!loadingConnections ? (
          <ul className="network-model-connection-results" aria-label={zh ? '已配置模型连接结果' : 'Configured model connection results'}>
            {modelConnectionRows.map((row) => (
              <li key={row.id} data-state={row.result ? (row.result.ok ? 'success' : 'failed') : 'idle'}>
                <strong>{row.name}</strong>
                <small>{describeModels(row.modelIds)}</small>
                <span>
                  {row.result
                    ? row.result.ok
                      ? zh
                        ? `连接可用 · ${row.result.latencyMs} 毫秒`
                        : `Available · ${row.result.latencyMs} ms`
                      : `${row.result.message} · ${row.result.latencyMs} ${zh ? '毫秒' : 'ms'}`
                    : zh
                      ? '尚未检测'
                      : 'Not checked'}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}
