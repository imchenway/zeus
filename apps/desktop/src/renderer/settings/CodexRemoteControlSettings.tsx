import { useEffect, useState } from 'react';
import type { CodexRemoteControlPairing, CodexRemoteControlSnapshot, DashboardClient } from '../apiClient.js';

type RemoteControlClient = Pick<
  DashboardClient,
  'loadCodexRemoteControl' | 'enableCodexRemoteControl' | 'disableCodexRemoteControl' | 'startCodexRemoteControlPairing' | 'loadCodexRemoteControlPairingStatus' | 'revokeCodexRemoteControlClient'
>;

interface CodexRemoteControlSettingsProps {
  language: 'zh-CN' | 'en-US';
  client: RemoteControlClient | null;
}

const copy = {
  'zh-CN': {
    title: 'Codex 远程接管',
    intro: '让 Codex iOS 或其他已授权客户端接入 Zeus 当前执行现场。远端会看到并回答原始选项框；等待回答期间不会把普通消息当作答案。',
    unavailable: '当前环境没有可用的 Codex 远程接管接口。',
    loading: '正在读取远程接管状态…',
    refresh: '刷新',
    enable: '启用远程接管',
    disable: '关闭远程接管',
    pair: '配对新设备',
    enabled: '已启用',
    disabled: '未启用',
    connecting: '连接中',
    connected: '已连接',
    errored: '连接异常',
    statusHelp: '由本机 Codex CLI 的官方 Remote Control 提供；Zeus 不另造一套消息同步。',
    server: '本机名称',
    hostNameHelp: 'iOS 显示系统机器名，可能与 Codex App 宿主同名；请用 Zeus 项目名或会话标题区分。',
    environment: '远程环境',
    devices: '已授权设备',
    noDevices: '暂无已授权设备。',
    revoke: '撤销',
    revokeConfirm: '撤销后，这台设备将不能继续访问当前远程环境。确定继续吗？',
    disableConfirm: '关闭后，已连接设备会立即失去这个 Zeus 执行现场。确定继续吗？',
    pairingTitle: '在 Codex 移动端输入配对码',
    pairingCode: '配对码',
    manualCode: '手动码',
    expires: '失效时间',
    pairingWaiting: '等待移动端确认…',
    pairingClaimed: '设备已配对。',
    copy: '复制',
    copied: '已复制',
    failed: '远程接管操作失败。',
  },
  'en-US': {
    title: 'Codex Remote Control',
    intro: 'Lets Codex on iOS or another authorized client join the live Zeus execution. Remote clients answer the original prompt; ordinary messages are not treated as answers while it is pending.',
    unavailable: 'Codex Remote Control is unavailable in this environment.',
    loading: 'Loading Remote Control status…',
    refresh: 'Refresh',
    enable: 'Enable Remote Control',
    disable: 'Disable Remote Control',
    pair: 'Pair new device',
    enabled: 'Enabled',
    disabled: 'Disabled',
    connecting: 'Connecting',
    connected: 'Connected',
    errored: 'Connection error',
    statusHelp: 'Provided by the official Remote Control in the local Codex CLI. Zeus does not create a separate message mirror.',
    server: 'Host name',
    hostNameHelp: 'iOS shows the system host name, which can match a Codex App host. Identify Zeus by its project or conversation title.',
    environment: 'Remote environment',
    devices: 'Authorized devices',
    noDevices: 'No authorized devices.',
    revoke: 'Revoke',
    revokeConfirm: 'This device will no longer be able to access the remote environment. Continue?',
    disableConfirm: 'Connected devices will immediately lose access to this Zeus execution. Continue?',
    pairingTitle: 'Enter this pairing code in Codex mobile',
    pairingCode: 'Pairing code',
    manualCode: 'Manual code',
    expires: 'Expires',
    pairingWaiting: 'Waiting for the mobile client…',
    pairingClaimed: 'Device paired.',
    copy: 'Copy',
    copied: 'Copied',
    failed: 'Remote Control operation failed.',
  },
} as const;

export function CodexRemoteControlSettings(props: CodexRemoteControlSettingsProps) {
  const labels = copy[props.language];
  const [snapshot, setSnapshot] = useState<CodexRemoteControlSnapshot | null>(null);
  const [pairing, setPairing] = useState<CodexRemoteControlPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!props.client) {
      setError(labels.unavailable);
      return;
    }
    void props.client
      .loadCodexRemoteControl()
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError, labels.failed));
      });
    return () => {
      active = false;
    };
  }, [labels.failed, labels.unavailable, props.client]);

  useEffect(() => {
    if (!props.client || !pairing || pairing.claimed || pairingExpiresAtMs(pairing.expiresAt) <= Date.now()) return;
    const timer = window.setInterval(() => {
      void props
        .client!.loadCodexRemoteControlPairingStatus({ pairingCode: pairing.pairingCode })
        .then(async ({ claimed }) => {
          if (!claimed) return;
          setPairing((current) => (current ? { ...current, claimed: true } : current));
          setMessage(labels.pairingClaimed);
          setSnapshot(await props.client!.loadCodexRemoteControl());
        })
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [labels.pairingClaimed, pairing, props.client]);

  async function run(action: () => Promise<CodexRemoteControlSnapshot>): Promise<void> {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      setSnapshot(await action());
    } catch (actionError) {
      setError(errorMessage(actionError, labels.failed));
    } finally {
      setBusy(false);
    }
  }

  async function pair(): Promise<void> {
    if (!props.client) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      let current = snapshot;
      if (!current?.enabled || current.status.status === 'disabled') {
        current = await props.client.enableCodexRemoteControl();
        setSnapshot(current);
      }
      setPairing(await props.client.startCodexRemoteControlPairing());
    } catch (pairError) {
      setError(errorMessage(pairError, labels.failed));
    } finally {
      setBusy(false);
    }
  }

  async function copyValue(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    setMessage(labels.copied);
  }

  const stateLabel = snapshot ? labels[snapshot.status.status] : labels.loading;
  return (
    <section className="settings-product-section codex-remote-control-settings" aria-labelledby="codex-remote-control-title">
      <header className="settings-section-heading">
        <strong id="codex-remote-control-title">{labels.title}</strong>
        <span>{labels.intro}</span>
      </header>
      <section className="native-settings-pane" aria-label={labels.title}>
        <section className="settings-config-row" aria-label={stateLabel}>
          <span className="settings-row-copy">
            <strong>{snapshot?.enabled ? labels.enabled : labels.disabled}</strong>
            <small>{labels.statusHelp}</small>
          </span>
          <span className="settings-row-field">
            <span>{stateLabel}</span>
          </span>
          <span className="settings-row-action-rail">
            <button type="button" disabled={busy || !props.client} onClick={() => void run(() => props.client!.loadCodexRemoteControl())}>
              {labels.refresh}
            </button>
            {snapshot?.enabled ? (
              <button
                type="button"
                disabled={busy || !props.client}
                onClick={() => {
                  if (window.confirm(labels.disableConfirm)) void run(() => props.client!.disableCodexRemoteControl());
                }}
              >
                {labels.disable}
              </button>
            ) : (
              <button type="button" disabled={busy || !props.client} onClick={() => void run(() => props.client!.enableCodexRemoteControl())}>
                {labels.enable}
              </button>
            )}
            <button type="button" disabled={busy || !props.client} onClick={() => void pair()}>
              {labels.pair}
            </button>
          </span>
        </section>
        {snapshot ? (
          <section className="settings-state-row" aria-label={labels.server}>
            <strong>{labels.server}</strong>
            <span>{snapshot.status.serverName}</span>
            <em>
              {labels.environment}: {snapshot.status.environmentId ?? '—'}
            </em>
            <small>{labels.hostNameHelp}</small>
          </section>
        ) : null}
        {pairing ? (
          <section className="settings-matrix-row" aria-label={labels.pairingTitle}>
            <span className="settings-row-copy">
              <strong>{labels.pairingTitle}</strong>
              <small>{pairing.claimed ? labels.pairingClaimed : labels.pairingWaiting}</small>
            </span>
            <span className="settings-row-field settings-evidence-list">
              <code>
                {labels.pairingCode}: {pairing.pairingCode}
              </code>
              {pairing.manualPairingCode ? (
                <code>
                  {labels.manualCode}: {pairing.manualPairingCode}
                </code>
              ) : null}
              <small>
                {labels.expires}: {new Date(pairingExpiresAtMs(pairing.expiresAt)).toLocaleString(props.language)}
              </small>
            </span>
            <span className="settings-row-action-rail">
              <button type="button" onClick={() => void copyValue(pairing.manualPairingCode ?? pairing.pairingCode)}>
                {labels.copy}
              </button>
            </span>
          </section>
        ) : null}
        <section className="settings-log-row" aria-label={labels.devices}>
          <span className="settings-row-copy">
            <strong>{labels.devices}</strong>
            <small>{snapshot?.clients.length ? `${snapshot.clients.length}` : labels.noDevices}</small>
          </span>
          <span className="settings-row-field settings-evidence-list">
            {snapshot?.clients.map((device) => (
              <span key={device.clientId}>
                <strong>{device.displayName || device.deviceModel || device.platform || device.clientId}</strong>
                <small>{[device.platform, device.osVersion, device.appVersion].filter(Boolean).join(' · ')}</small>
                <button
                  type="button"
                  disabled={busy || !snapshot.status.environmentId || !props.client}
                  onClick={() => {
                    if (snapshot.status.environmentId && window.confirm(labels.revokeConfirm)) {
                      void run(() => props.client!.revokeCodexRemoteControlClient(snapshot.status.environmentId!, device.clientId));
                    }
                  }}
                >
                  {labels.revoke}
                </button>
              </span>
            ))}
          </span>
        </section>
      </section>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function pairingExpiresAtMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}
