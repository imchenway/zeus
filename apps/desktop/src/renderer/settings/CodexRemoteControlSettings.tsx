import { useEffect } from 'react';
import type { RemoteControlApiClient } from '../features/remote/remoteControlApiClient.js';
import { useRemoteControlFeatureController } from '../features/remote/useRemoteControlFeatureController.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';

interface CodexRemoteControlSettingsProps {
  language: 'zh-CN' | 'en-US';
  client: RemoteControlApiClient | null;
}

const copy = {
  'zh-CN': {
    title: 'Zeus 会话远程接管',
    intro: '让 Codex iOS 或其他已授权客户端远程操作 Zeus 执行现场。启用不会中断当前工作；已在进行的轮次保留在原宿主，完成后的后续轮次再接入远程。',
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
    statusHelp: '通过 Codex 官方 Remote Control 配对设备后，可以远程访问新对话和空闲对话。',
    standaloneTitle: 'Remote Control 独立版',
    standaloneReady: '已为 Zeus 安装',
    standaloneMissing: '需要单独安装',
    standaloneReadyHelp: '远程连接使用 Zeus 专用的 Codex 安装。',
    standaloneMissingHelp: '需要为 Zeus 单独安装并登录 Codex 远程服务。请复制命令到终端执行，完成登录后再刷新。',
    copyInstall: '复制安装命令',
    installCopied: '安装命令已复制。',
    connectionFailed: '远程接管未能启动',
    recoveryHelp: '请先解决下方提示的问题，再重新检测连接。',
    retry: '重新检测连接',
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
    title: 'Zeus Session Remote Control',
    intro:
      'Lets Codex on iOS or another authorized client remotely operate Zeus executions. Enabling it does not interrupt current work; in-progress turns stay on their original host, and later turns connect to Remote Control after they finish.',
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
    statusHelp: 'Pair a device using Codex’s official Remote Control to access new and idle conversations remotely.',
    standaloneTitle: 'Remote Control standalone',
    standaloneReady: 'Installed for Zeus',
    standaloneMissing: 'Separate install required',
    standaloneReadyHelp: 'Remote connections use the Codex installation dedicated to Zeus.',
    standaloneMissingHelp: 'Zeus needs a separate installation and sign-in for the Codex remote service. Copy the command, run it in Terminal, sign in, then refresh.',
    copyInstall: 'Copy install command',
    installCopied: 'Install command copied.',
    connectionFailed: 'Remote Control did not start',
    recoveryHelp: 'Resolve the issue shown below, then check the connection again.',
    retry: 'Check connection again',
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
  const controller = useRemoteControlFeatureController(props.client);
  const snapshot = controller.snapshot.value;
  const pairing = controller.snapshot.pairing;
  const refreshPairing = controller.refreshPairing;
  const busy = controller.snapshot.command !== 'idle';
  const message = controller.snapshot.message;
  const error = props.client ? (controller.snapshot.errorCause ?? controller.snapshot.error) : labels.unavailable;
  useApplicationErrorDialog(error, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
  });

  useEffect(() => {
    if (!props.client || !pairing || pairing.claimed || pairingExpiresAtMs(pairing.expiresAt) <= Date.now()) return;
    const timer = window.setInterval(() => {
      void refreshPairing(labels.pairingClaimed);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [labels.pairingClaimed, pairing, props.client, refreshPairing]);

  async function copyValue(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    controller.setMessage(labels.copied);
  }

  const stateLabel = snapshot ? labels[snapshot.status.status] : labels.loading;
  const managedStandalone = snapshot?.managedStandalone;
  const standaloneReady = managedStandalone?.available === true;
  const standaloneBlocked = managedStandalone?.available === false;
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
            <button type="button" disabled={busy || !props.client} onClick={() => void controller.reload()}>
              {labels.refresh}
            </button>
            {snapshot?.enabled ? (
              <button
                type="button"
                disabled={busy || !props.client}
                onClick={() => {
                  if (window.confirm(labels.disableConfirm)) void controller.disable();
                }}
              >
                {labels.disable}
              </button>
            ) : (
              <button type="button" disabled={busy || !props.client || standaloneBlocked} onClick={() => void controller.enable()}>
                {labels.enable}
              </button>
            )}
            <button type="button" disabled={busy || !props.client || standaloneBlocked} onClick={() => void controller.startPairing()}>
              {labels.pair}
            </button>
          </span>
        </section>
        {managedStandalone ? (
          <section className="settings-config-row codex-remote-control-standalone" aria-label={labels.standaloneTitle}>
            <span className="settings-row-copy">
              <strong>{labels.standaloneTitle}</strong>
              <small>{standaloneReady ? labels.standaloneReadyHelp : labels.standaloneMissingHelp}</small>
            </span>
            <span className="settings-row-field settings-evidence-list">
              <span>{standaloneReady ? labels.standaloneReady : labels.standaloneMissing}</span>
              <code>{standaloneReady ? managedStandalone.commandPath : managedStandalone.installCommand}</code>
            </span>
            <span className="settings-row-action-rail">
              {!standaloneReady ? (
                <button type="button" disabled={busy} onClick={() => void copyValue(managedStandalone.installCommand).then(() => controller.setMessage(labels.installCopied))}>
                  {labels.copyInstall}
                </button>
              ) : null}
            </span>
          </section>
        ) : null}
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
                      void controller.revoke(snapshot.status.environmentId, device.clientId);
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
    </section>
  );
}

function pairingExpiresAtMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}
