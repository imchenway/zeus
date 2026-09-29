import { useEffect, useId, useState } from 'react';
import {
  defaultNetworkProxySettings,
  networkProxyAddressFields,
  networkProxySettingsFromFields,
  type NetworkProxySettings,
  type NetworkProxyAddressFields,
  type NetworkProxyCheckTarget,
  type NetworkProxyConnectionResult,
} from '@zeus/shared';
import type { DashboardClient, ModelConnectionRecord } from '../apiClient.js';
import { NativeControlRow } from '../features/workspace/workspaceSupport.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';

/** 网络页只读取现有模型连接并调用各自最小真实请求诊断。 */
type NetworkModelConnectionClient = Pick<DashboardClient, 'loadModelConnections' | 'diagnoseModelConnection' | 'diagnoseCodexConnection'>;

/** 一行对应一个实际模型来源，模型清单跟随“模型供应商”配置。 */
interface NetworkModelConnectionRow {
  /** Codex 使用固定身份，自定义连接沿用持久化身份。 */
  id: string;
  /** 用户在模型设置中看到的来源名称。 */
  name: string;
  /** 当前启用模型；Codex 在检查时刷新官方目录。 */
  modelIds: string[];
  /** 每一行独立推进，快结果不等待其他供应商。 */
  status: 'idle' | 'checking' | 'success' | 'failed';
  /** 未检查时为空，检查后同时提供文字结论与延迟。 */
  result: { ok: boolean; latencyMs: number; message: string } | null;
}

/** 浏览器与模型宿主各自拥有独立状态和回执。 */
interface NetworkPathCheckState {
  /** 检查阶段用于实时更新单行。 */
  status: 'idle' | 'checking' | 'success' | 'failed';
  /** 网络请求返回的结构化结果。 */
  result: NetworkProxyConnectionResult | null;
  /** IPC 或输入边界失败时显示的用户可读原因。 */
  message: string | null;
}

/** 两条网址链路的初始状态每次都创建新对象，避免 React 状态共享引用。 */
function emptyNetworkPathChecks(): Record<NetworkProxyCheckTarget, NetworkPathCheckState> {
  return {
    browser: { status: 'idle', result: null, message: null },
    node: { status: 'idle', result: null, message: null },
  };
}

/** 设置页只显示无凭据代理地址；账号密码在共享校验层已被拒绝。 */
function describeProxy(settings: NetworkProxySettings | null, zh: boolean): string {
  if (!settings) return zh ? '生效配置读取中' : 'Loading active configuration';
  if (settings.mode === 'direct') return zh ? '直连' : 'Direct';
  if (settings.mode === 'default') return zh ? '系统与启动环境' : 'System and launch environment';
  return settings.url;
}

/** 代理主机和端口分别编辑，合法草稿仍沿用原有自动保存入口。 */
export function NetworkProxySettingsFields(props: {
  /** 当前界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 未配置时保留原网络行为。 */
  value: NetworkProxySettings | undefined;
  /** 本次宿主启动时实际使用的代理；供应商检查只走这套配置。 */
  activeValue: NetworkProxySettings | null;
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
  /** 两条网络链路分别报告，任何一条完成就立即更新。 */
  const [networkPathChecks, setNetworkPathChecks] = useState<Record<NetworkProxyCheckTarget, NetworkPathCheckState>>(emptyNetworkPathChecks);
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
    setNetworkPathChecks(emptyNetworkPathChecks());
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
    setCheckError(null);
    try {
      /** 检查与保存使用完全相同的字段组装和校验。 */
      const settings = networkProxySettingsFromFields(draft.mode, draft, draft.bypass);
      /** 冻结本次桌面桥接，两个并行检查使用同一实现。 */
      const checkNetworkProxyConnection = window.zeus?.checkNetworkProxyConnection;
      if (!checkNetworkProxyConnection) throw new Error(zh ? '请在 Zeus 桌面应用中检查连接。' : 'Check the connection in the Zeus desktop app.');
      setChecking(true);
      setNetworkPathChecks({
        browser: { status: 'checking', result: null, message: null },
        node: { status: 'checking', result: null, message: null },
      });
      /** 两个 IPC 独立返回；Node 成功不会再被 Chromium 代理切换超时压住。 */
      const checks = (['browser', 'node'] as const).map(async (checkTarget) => {
        try {
          const checkResult = await checkNetworkProxyConnection(settings, target, checkTarget);
          setNetworkPathChecks((current) => ({
            ...current,
            [checkTarget]: { status: checkResult.error ? 'failed' : 'success', result: checkResult, message: null },
          }));
        } catch (cause) {
          setNetworkPathChecks((current) => ({
            ...current,
            [checkTarget]: {
              status: 'failed',
              result: null,
              message: cause instanceof Error ? cause.message : zh ? '连接检查失败。' : 'Connection check failed.',
            },
          }));
        }
      });
      await Promise.all(checks);
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
  async function checkModelConnectionRow(
    target: Omit<NetworkModelConnectionRow, 'result' | 'status'>,
    check: () => Promise<{ ok: boolean; latencyMs: number; message: string; modelIds?: string[]; testedModelId?: string | null }>,
  ): Promise<NetworkModelConnectionRow> {
    /** 本地 API 传输失败时仍计算用户实际等待时间。 */
    const startedAt = performance.now();
    try {
      const diagnostic = await check();
      return {
        ...target,
        modelIds: diagnostic.modelIds ?? target.modelIds,
        status: diagnostic.ok ? 'success' : 'failed',
        /** 展示从 Renderer 发起到收到完整回执的墙钟时间，与用户实际等待一致。 */
        result: {
          ok: diagnostic.ok,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          message: diagnostic.ok && !zh ? `Model ${diagnostic.testedModelId ?? target.name} completed a real request. This does not verify image or tool capabilities.` : diagnostic.message,
        },
      };
    } catch (cause) {
      return {
        ...target,
        status: 'failed',
        result: {
          ok: false,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          message: cause instanceof Error ? cause.message : zh ? '连接检查失败。' : 'Connection check failed.',
        },
      };
    }
  }

  /** 并行调用真实模型请求：Codex 使用订阅，自定义连接使用已保存 API Key。 */
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
      /** 所有供应商先进入检查中，随后每个回执单独替换自己的稳定行。 */
      const rows: Array<Omit<NetworkModelConnectionRow, 'result' | 'status'> & { check: () => Promise<{ ok: boolean; latencyMs: number; message: string; modelIds?: string[]; testedModelId?: string | null }> }> = [
        { id: 'codex', name: zh ? 'Codex 订阅' : 'Codex subscription', modelIds: [], check: () => client.diagnoseCodexConnection() },
        ...targets.map(({ connection, modelIds }) => ({ id: connection.id, name: connection.name, modelIds, check: () => client.diagnoseModelConnection(connection.id) })),
      ];
      setModelConnectionResults(rows.map((row) => ({ id: row.id, name: row.name, modelIds: row.modelIds, status: 'checking', result: null })));
      /** Promise.all 只负责恢复批次按钮，不再承担结果呈现。 */
      await Promise.all(
        rows.map(async ({ check, ...row }) => {
          const checked = await checkModelConnectionRow(row, check);
          setModelConnectionResults((current) => current?.map((candidate) => (candidate.id === checked.id ? checked : candidate)) ?? [checked]);
        }),
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

  /** 单条网址链路按自己的阶段描述，不依赖批次是否结束。 */
  function describeNetworkPath(state: NetworkPathCheckState): string {
    if (state.status === 'checking') return zh ? '检查中…' : 'Checking…';
    if (state.message) return state.message;
    if (state.result) return describeConnection(state.result);
    return zh ? '尚未检查' : 'Not checked';
  }

  /** 未检测前也展示真实配置清单；检测后用同一稳定身份替换状态。 */
  const modelConnectionRows = modelConnectionResults ?? [
    { id: 'codex', name: zh ? 'Codex 订阅' : 'Codex subscription', modelIds: [], status: 'idle' as const, result: null },
    ...configuredModelConnections(configuredConnections).map(({ connection, modelIds }) => ({ id: connection.id, name: connection.name, modelIds, status: 'idle' as const, result: null })),
  ];

  /** 批次进度只统计已完成行，不等待慢项才给出反馈。 */
  const completedModelChecks = modelConnectionRows.filter((row) => row.status === 'success' || row.status === 'failed').length;

  return (
    <>
      <section className="network-settings-group" aria-labelledby={`${id}-proxy-heading`}>
        <header className="network-settings-group-heading">
          <span aria-hidden="true">1</span>
          <div>
            <h3 id={`${id}-proxy-heading`}>{zh ? '代理配置' : 'Proxy configuration'}</h3>
            <p>{zh ? '统一保存 Zeus 的浏览器和模型网络出口，修改后需完整重启。' : 'Save one network route for Zeus browser and model traffic; changes require a full restart.'}</p>
          </div>
        </header>
        <NativeControlRow
          title={zh ? '代理模式' : 'Proxy mode'}
          description={zh ? '输入完成后自动保存。待任务结束，完全退出并重新打开 Zeus 生效。' : 'Saves when editing finishes. Let tasks finish, then fully quit and reopen Zeus to apply.'}
        >
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
                zh
                  ? '选择代理服务器自身使用的协议。访问 HTTPS 网站时，本机代理通常仍应选择 HTTP 端口。暂不支持 SOCKS 和账号密码。'
                  : 'Choose the protocol used by the proxy server itself. A local HTTP proxy can still reach HTTPS sites. SOCKS and authentication are not supported.'
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
            <NativeControlRow title={zh ? '端口号' : 'Port number'} description={zh ? '范围为 1–65535，与代理客户端显示的同协议端口一致。' : 'Use a port from 1–65535 that matches the same protocol in your proxy client.'}>
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
              description={zh ? '可选，用逗号分隔域名、域名后缀或 IPv4 地址；本机回环地址自动直连。' : 'Optional: comma-separated hosts, domain suffixes, or IPv4 addresses. Loopback addresses always connect directly.'}
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
              ? '内置浏览器使用系统代理；模型进程沿用 Zeus 启动时的环境。外部浏览器和工具自行管理网络设置。'
              : 'The built-in browser uses system proxy settings; model processes inherit the Zeus launch environment. External browsers and tools manage their own settings.'}
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
      </section>

      <section className="network-settings-group" aria-labelledby={`${id}-path-heading`}>
        <header className="network-settings-group-heading">
          <span aria-hidden="true">2</span>
          <div>
            <h3 id={`${id}-path-heading`}>{zh ? '网址链路' : 'URL paths'}</h3>
            <p>{zh ? '使用当前表单草稿分别检查内置浏览器与模型宿主；不修改运行中的代理。' : 'Check the built-in browser and model host with the current form draft without changing the active proxy.'}</p>
          </div>
        </header>
        <NativeControlRow
          className="network-proxy-check-row"
          title={zh ? '检查网址' : 'Check URL'}
          description={zh ? '收到 HTTP 响应只证明链路可达，不证明模型账号、额度或对话可用。' : 'An HTTP response proves only path reachability, not model credentials, quota, or conversations.'}
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
                setNetworkPathChecks(emptyNetworkPathChecks());
                setCheckError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !disabled) void checkConnection();
              }}
            />
            <Button disabled={disabled || !window.zeus?.checkNetworkProxyConnection} busy={checking} onClick={() => void checkConnection()}>
              {checking ? (zh ? '检查中…' : 'Checking…') : zh ? '检查两条链路' : 'Check both paths'}
            </Button>
          </span>
        </NativeControlRow>
        {!window.zeus?.checkNetworkProxyConnection ? <p className="settings-field-note">{zh ? '请在 Zeus 桌面应用中检查连接。' : 'Check the connection in the Zeus desktop app.'}</p> : null}
        <dl className="network-proxy-results" aria-label={zh ? '网址链路检查结果' : 'URL path check results'}>
          {(
            [
              ['browser', zh ? '内置浏览器' : 'Built-in browser'],
              ['node', zh ? '模型宿主' : 'Model host'],
            ] as const
          ).map(([checkTarget, label]) => (
            <div key={checkTarget} data-state={networkPathChecks[checkTarget].status}>
              <dt>{label}</dt>
              <dd role="status" aria-live="polite">
                {describeNetworkPath(networkPathChecks[checkTarget])}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="network-settings-group" aria-labelledby={`${id}-provider-heading`}>
        <header className="network-settings-group-heading">
          <span aria-hidden="true">3</span>
          <div>
            <h3 id={`${id}-provider-heading`}>{zh ? '供应商真实请求' : 'Real provider requests'}</h3>
            <p>
              {zh
                ? `使用当前运行配置（${describeProxy(props.activeValue, zh)}）和已保存凭据；每个供应商发送一次最小请求，可能产生少量用量。`
                : `Use the active configuration (${describeProxy(props.activeValue, zh)}) and saved credentials. One minimal request per provider may incur minor usage.`}
            </p>
          </div>
        </header>
        <NativeControlRow
          className="network-model-connection-check-row"
          title={zh ? '已启用供应商' : 'Enabled providers'}
          description={
            zh
              ? '列表跟随“模型供应商”中的启用状态，并包含 Codex 订阅。成功只表示本次文本对话完成；图片和工具能力需单独探测。'
              : 'The list follows enabled Model Providers and includes Codex. Success means this text request completed; image and tool capabilities require separate probes.'
          }
        >
          <Button disabled={disabled || !props.client || loadingConnections} busy={checkingModelConnections} onClick={() => void checkModelConnections()}>
            {checkingModelConnections ? (zh ? `${completedModelChecks}/${modelConnectionRows.length} 已完成` : `${completedModelChecks}/${modelConnectionRows.length} complete`) : zh ? '验证真实请求' : 'Verify real requests'}
          </Button>
        </NativeControlRow>
        <div className="network-model-connection-status">
          {loadingConnections ? (
            <p className="settings-field-note" role="status">
              {zh ? '正在读取已配置模型…' : 'Loading configured models…'}
            </p>
          ) : null}
          {!loadingConnections ? (
            <ul className="network-model-connection-results" aria-label={zh ? '供应商真实请求结果' : 'Real provider request results'}>
              {modelConnectionRows.map((row) => (
                <li key={row.id} data-state={row.status}>
                  <strong>{row.name}</strong>
                  <small>{describeModels(row.modelIds)}</small>
                  <div className="network-model-result">
                    <span role="status" aria-live="polite">
                      {row.status === 'checking'
                        ? zh
                          ? '正在发送真实请求…'
                          : 'Sending a real request…'
                        : row.result
                          ? row.result.ok
                            ? zh
                              ? `真实请求成功 · ${row.result.latencyMs} 毫秒`
                              : `Real request succeeded · ${row.result.latencyMs} ms`
                            : zh
                              ? `真实请求失败 · ${row.result.latencyMs} 毫秒`
                              : `Real request failed · ${row.result.latencyMs} ms`
                          : zh
                            ? '尚未验证'
                            : 'Not verified'}
                    </span>
                    {row.result ? <small>{row.result.message}</small> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
      {checkError ? (
        <p className="settings-field-error" role="alert">
          {checkError}
        </p>
      ) : null}
    </>
  );
}
