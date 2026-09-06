import { reportApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { useCallback, useEffect, useState } from 'react';
import { BuildingsIcon as Buildings } from '@phosphor-icons/react/dist/csr/Buildings';
import { ChatsCircleIcon as ChatsCircle } from '@phosphor-icons/react/dist/csr/ChatsCircle';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { DiscordLogoIcon as DiscordLogo } from '@phosphor-icons/react/dist/csr/DiscordLogo';
import { PaperPlaneTiltIcon as PaperPlaneTilt } from '@phosphor-icons/react/dist/csr/PaperPlaneTilt';
import { QrCodeIcon as QrCode } from '@phosphor-icons/react/dist/csr/QrCode';
import { RobotIcon as Robot } from '@phosphor-icons/react/dist/csr/Robot';
import { SlackLogoIcon as SlackLogo } from '@phosphor-icons/react/dist/csr/SlackLogo';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { WechatLogoIcon as WechatLogo } from '@phosphor-icons/react/dist/csr/WechatLogo';
import { WhatsappLogoIcon as WhatsappLogo } from '@phosphor-icons/react/dist/csr/WhatsappLogo';
import QRCode from 'qrcode';
import type { ImChannelId } from '@zeus/shared';
import type { ImAgentPresetRef, ImConnectionSnapshot, ImPairingSessionSnapshot, ImProjectSelectionOption, ImSettingsSnapshot, ImTelegramConnectionLogEntry } from '../../apiClient.js';
import type { AppLanguage } from '../workspace/workspaceCopy.js';
import type { TelegramApiClient } from './telegramApiClient.js';
import './imRobotSettings.css';

export interface ImRobotSettingsPaneProps {
  client: TelegramApiClient | null;
  language: AppLanguage;
}

type AsyncAction = 'create' | 'pairing' | 'check' | 'update' | 'remove' | 'logs' | null;

export function ImRobotSettingsPane(props: ImRobotSettingsPaneProps) {
  const zh = props.language === 'zh-CN';
  const [snapshot, setSnapshot] = useState<ImSettingsSnapshot | null>(null);
  const [options, setOptions] = useState<ImProjectSelectionOption[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<ImChannelId>('telegram');
  const [projectId, setProjectId] = useState('');
  const [presetKey, setPresetKey] = useState('zeus_default');
  const [botToken, setBotToken] = useState('');
  const [useLegacyToken, setUseLegacyToken] = useState(false);
  const [pairing, setPairing] = useState<ImPairingSessionSnapshot | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [logs, setLogs] = useState<ImTelegramConnectionLogEntry[] | null>(null);
  const [action, setAction] = useState<AsyncAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!props.client) return;
    const [nextSnapshot, nextOptions] = await Promise.all([props.client.loadImSettings(), props.client.loadImOptions()]);
    setSnapshot(nextSnapshot);
    setOptions(nextOptions);
    setProjectId((current) => current || nextOptions[0]?.id || '');
    const connection = nextSnapshot.connections[0];
    if (connection) {
      setProjectId(connection.projectId);
      setPresetKey(agentPresetKey(connection.agentPreset));
    }
  }, [props.client]);

  useEffect(() => {
    let active = true;
    if (!props.client) return undefined;
    setError(null);
    void refresh().catch((reason) => {
      if (active) setError(errorMessage(reason, zh ? 'zh-CN' : 'en'));
    });
    return () => {
      active = false;
    };
  }, [props.client, refresh, zh]);

  useEffect(() => {
    if (!pairing) {
      setQrCodeDataUrl(null);
      return;
    }
    let active = true;
    void QRCode.toDataURL(pairing.deepLink, { width: 236, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } })
      .then((value) => {
        if (active) setQrCodeDataUrl(value);
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason, zh ? 'zh-CN' : 'en'));
      });
    return () => {
      active = false;
    };
  }, [pairing, zh]);

  useEffect(() => {
    if (!pairing) return undefined;
    const update = (): void => setRemainingSeconds(Math.max(0, Math.floor((new Date(pairing.expiresAt).getTime() - Date.now()) / 1_000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const connection = snapshot?.connections[0] ?? null;
  const selectedProject = options.find((option) => option.id === projectId) ?? null;
  const selectedChannelSnapshot = snapshot?.channels.find((channel) => channel.id === selectedChannel) ?? null;
  const supported = selectedChannelSnapshot?.availability === 'available';
  const presetOptions = selectedProject?.presets ?? [];
  const busy = action !== null;

  useEffect(() => {
    if (!props.client || !connection || connection.state !== 'pending_pairing') return undefined;
    let active = true;
    let inFlight = false;
    const poll = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await props.client!.loadTelegramImPairing(connection.id);
        if (!active) return;
        replaceConnection(setSnapshot, next.connection);
        setPairing(next.pairing);
        if (next.connection.state === 'active') {
          setNotice(zh ? 'Telegram 私聊已完成安全配对。' : 'Telegram private chat paired securely.');
        }
      } catch {
        // 配对状态轮询失败不覆盖用户正在操作的表单；显式“检查连接”仍会给出完整错误。
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connection?.id, connection?.state, props.client, zh]);

  useEffect(() => {
    if (!props.client || !connection || connection.state === 'pending_pairing') return undefined;
    let active = true;
    let inFlight = false;
    const poll = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await props.client!.loadImSettings();
        if (active) setSnapshot(next);
      } catch {
        // 后台健康刷新不覆盖显式操作结果；“检查连接”提供可见诊断。
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connection?.id, connection?.state, props.client]);

  const execute = useCallback(
    async <T,>(nextAction: Exclude<AsyncAction, null>, operation: () => Promise<T>, onSuccess: (result: T) => void | Promise<void>) => {
      setAction(nextAction);
      setError(null);
      setNotice(null);
      try {
        const result = await operation();
        await onSuccess(result);
      } catch (reason) {
        setError(errorMessage(reason, zh ? 'zh-CN' : 'en'));
      } finally {
        setAction(null);
      }
    },
    [zh],
  );

  const createConnection = (): void => {
    if (!props.client || !projectId) return;
    const agentPreset = parseAgentPresetKey(presetKey);
    void execute(
      'create',
      () => props.client!.createTelegramImConnection({ projectId, agentPreset, ...(useLegacyToken ? { useLegacyToken: true } : { botToken: botToken.trim() }) }),
      async (created) => {
        setSnapshot((current) => (current ? { ...current, connections: [created.connection], legacyTelegramTokenPending: false } : current));
        setPairing(created.pairing);
        setBotToken('');
        setNotice(zh ? '机器人已验证。请在 Telegram 私聊中完成配对。' : 'Bot verified. Complete pairing in a Telegram private chat.');
        await refresh();
      },
    );
  };

  const recreatePairing = (): void => {
    if (!props.client || !connection) return;
    void execute(
      'pairing',
      () => props.client!.recreateTelegramImPairing(connection.id),
      async (created) => {
        setPairing(created.pairing);
        setSnapshot((current) => (current ? { ...current, connections: [created.connection] } : current));
        setNotice(zh ? '旧配对码已撤销，新的配对码将在 10 分钟后过期。' : 'The old code was revoked. The new pairing code expires in 10 minutes.');
      },
    );
  };

  const checkConnection = (): void => {
    if (!props.client || !connection) return;
    void execute(
      'check',
      () => props.client!.checkTelegramImConnection(connection.id),
      (updated) => {
        replaceConnection(setSnapshot, updated);
        setNotice(zh ? '已检查机器人密钥并更新连接状态。' : 'Checked the bot token and updated the connection status.');
      },
    );
  };

  const updatePreset = (value: string): void => {
    if (!props.client || !connection) return;
    setPresetKey(value);
    void execute(
      'update',
      () => props.client!.updateTelegramImConnection(connection.id, { expectedRevision: connection.revision, agentPreset: parseAgentPresetKey(value) }),
      (updated) => {
        replaceConnection(setSnapshot, updated);
        setNotice(zh ? '默认智能体配置已更新，将用于之后新建的对话和任务。' : 'The default agent settings have been updated and will apply to new conversations and tasks.');
      },
    );
  };

  const updateRemoteApproval = (enabled: boolean): void => {
    if (!props.client || !connection) return;
    if (
      enabled &&
      !window.confirm(
        zh
          ? '开启后，已配对的 Telegram 用户可以在私聊中批准或拒绝 AI 的操作请求。请确认只有你能访问该账号。确定开启？'
          : 'Once enabled, the paired Telegram user can approve or decline the AI’s action requests in private chat. Make sure only you can access that account. Enable remote approvals?',
      )
    )
      return;
    void execute(
      'update',
      () => props.client!.updateTelegramImConnection(connection.id, { expectedRevision: connection.revision, remoteApprovalEnabled: enabled }),
      (updated) => {
        replaceConnection(setSnapshot, updated);
        setNotice(enabled ? (zh ? '远程审批已开启。' : 'Remote approvals enabled.') : zh ? '远程审批已关闭。' : 'Remote approvals disabled.');
      },
    );
  };

  const removeConnection = (): void => {
    if (!props.client || !connection) return;
    if (
      !window.confirm(zh ? '移除后将停止轮询、撤销配对并清除 Keychain Token；任务与会话历史会保留。确定移除？' : 'This stops polling, revokes pairing, and clears the Keychain token. Task and conversation history is preserved. Remove it?')
    )
      return;
    void execute(
      'remove',
      () => props.client!.removeTelegramImConnection(connection.id),
      async () => {
        setPairing(null);
        setLogs(null);
        setSnapshot((current) => (current ? { ...current, connections: [] } : current));
        setNotice(zh ? '连接已移除；任务与会话历史未删除。' : 'Connection removed. Task and conversation history was preserved.');
        await refresh();
      },
    );
  };

  const loadLogs = (): void => {
    if (!props.client || !connection) return;
    if (logs) {
      setLogs(null);
      return;
    }
    void execute('logs', () => props.client!.loadTelegramImConnectionLogs(connection.id), setLogs);
  };

  if (!props.client) {
    return (
      <section className="settings-product-pane im-robot-settings" aria-label={zh ? 'IM 机器人' : 'IM Bots'}>
        <h2 className="settings-page-title">{zh ? 'IM 机器人' : 'IM Bots'}</h2>
        <div className="im-state-message danger" role="alert">
          <WarningCircle aria-hidden="true" />
          {zh ? '无法连接 Zeus 后台，暂时不能读取机器人状态。' : 'Zeus cannot connect to its background service to load the bot status.'}
        </div>
      </section>
    );
  }

  return (
    <section className="settings-product-pane im-robot-settings" aria-label={zh ? 'IM 机器人' : 'IM Bots'}>
      <header className="im-page-heading">
        <span className="im-page-kicker">{zh ? 'IM 机器人' : 'IM BOTS'}</span>
        <h2 className="settings-page-title">{zh ? '机器人接入' : 'Bot connections'}</h2>
        <p>
          {zh
            ? '连接聊天机器人，将指定项目的任务交给 AI，并在私聊中查看进展。每个连接只能配对一位用户。'
            : 'Connect a chat bot to work with AI on a selected project and follow progress in private chat. Each connection can pair with one user.'}
        </p>
      </header>

      <div className="im-safety-bar" role="status" aria-label={zh ? '机器人访问范围' : 'Bot access'}>
        <SafetyFact text={zh ? '仅接受已配对私聊' : 'Paired private chats only'} />
        <SafetyFact text={connection ? `${zh ? '项目已锁定' : 'Project locked'}：${connection.projectName}` : zh ? '连接后锁定项目范围' : 'Project scope locks on connect'} />
        <SafetyFact text={connection?.remoteApprovalEnabled ? (zh ? '远程审批已明确开启' : 'Remote approvals enabled') : zh ? '远程审批默认关闭' : 'Remote approvals off by default'} />
      </div>

      {error ? (
        <div className="im-state-message danger" role="alert">
          <WarningCircle aria-hidden="true" />
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="im-state-message success" role="status">
          <CheckCircle aria-hidden="true" />
          {notice}
        </div>
      ) : null}

      <div className="im-settings-layout">
        <nav className="im-channel-list" aria-label={zh ? 'IM 渠道' : 'IM channels'}>
          {snapshot?.channels.map((channel) => (
            <button key={channel.id} type="button" className={selectedChannel === channel.id ? 'selected' : ''} aria-current={selectedChannel === channel.id ? 'page' : undefined} onClick={() => setSelectedChannel(channel.id)}>
              <ChannelIcon channelId={channel.id} />
              <span>{channel.name}</span>
              {channel.availability === 'unsupported' ? <small>{zh ? '暂未支持' : 'Coming later'}</small> : null}
            </button>
          ))}
        </nav>

        <div className="im-channel-detail">
          {!snapshot ? (
            <div className="im-empty-state" aria-busy="true">
              {zh ? '正在读取连接状态…' : 'Loading connection status…'}
            </div>
          ) : null}
          {snapshot && !supported ? (
            <div className="im-empty-state">
              <ChannelIcon channelId={selectedChannel} large />
              <strong>{selectedChannelSnapshot?.name}</strong>
              <span>{zh ? '暂不支持此渠道，请选择 Telegram。' : 'This channel is not supported yet. Select Telegram.'}</span>
            </div>
          ) : null}
          {snapshot && supported ? (
            <>
              {!connection ? (
                <section className="im-connect-wizard" aria-labelledby="im-connect-title">
                  <div className="im-section-title">
                    <span className="im-section-icon">
                      <PaperPlaneTilt aria-hidden="true" weight="fill" />
                    </span>
                    <span>
                      <strong id="im-connect-title">{zh ? '接入 Telegram 机器人' : 'Connect a Telegram bot'}</strong>
                      <small>{zh ? '机器人密钥（Token）会保存在本机 macOS 钥匙串中。' : 'The bot token is stored in this Mac’s Keychain.'}</small>
                    </span>
                  </div>
                  <ol className="im-step-list">
                    <li>
                      <span className="im-step-number">1</span>
                      <label className="im-form-field">
                        <span>{zh ? '绑定项目' : 'Project'}</span>
                        <select
                          value={projectId}
                          onChange={(event) => {
                            setProjectId(event.currentTarget.value);
                            setPresetKey('zeus_default');
                          }}
                          disabled={busy}
                        >
                          {options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="im-form-field">
                        <span>Agent Preset</span>
                        <select value={presetKey} onChange={(event) => setPresetKey(event.currentTarget.value)} disabled={busy}>
                          {presetOptions.map((preset) => (
                            <option key={agentPresetKey(preset.ref)} value={agentPresetKey(preset.ref)}>
                              {preset.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </li>
                    <li>
                      <span className="im-step-number">2</span>
                      {snapshot.legacyTelegramTokenPending ? (
                        <label className="im-legacy-token-choice">
                          <input type="checkbox" checked={useLegacyToken} onChange={(event) => setUseLegacyToken(event.currentTarget.checked)} disabled={busy} />
                          <span>
                            <strong>{zh ? '迁移现有 Telegram Token' : 'Migrate existing Telegram token'}</strong>
                            <small>
                              {zh ? '导入密钥后仍需重新配对 Telegram 用户，之前允许的用户不会自动获得访问权限。' : 'After importing the token, pair the Telegram user again. Previously allowed users will not automatically receive access.'}
                            </small>
                          </span>
                        </label>
                      ) : null}
                      {!useLegacyToken ? (
                        <label className="im-form-field im-token-field">
                          <span>BotFather Token</span>
                          <input type="password" autoComplete="off" value={botToken} onChange={(event) => setBotToken(event.currentTarget.value)} placeholder="123456789:AA…" disabled={busy} />
                        </label>
                      ) : null}
                      <button type="button" className="im-primary-action" onClick={createConnection} disabled={busy || !projectId || (!useLegacyToken && !botToken.trim())}>
                        <QrCode aria-hidden="true" />
                        {action === 'create' ? (zh ? '正在校验…' : 'Verifying…') : zh ? '校验并生成配对码' : 'Verify and create pairing code'}
                      </button>
                    </li>
                  </ol>
                </section>
              ) : (
                <>
                  {connection.state === 'pending_pairing' ? <PairingPanel zh={zh} pairing={pairing} qrCodeDataUrl={qrCodeDataUrl} remainingSeconds={remainingSeconds} busy={busy} onRecreate={recreatePairing} /> : null}
                  <ConnectionCard
                    zh={zh}
                    connection={connection}
                    options={options}
                    presetKey={presetKey}
                    busy={busy}
                    logs={logs}
                    onPresetChange={updatePreset}
                    onRemoteApprovalChange={updateRemoteApproval}
                    onCheck={checkConnection}
                    onPair={recreatePairing}
                    onRemove={removeConnection}
                    onToggleLogs={loadLogs}
                  />
                </>
              )}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SafetyFact(props: { text: string }) {
  return (
    <span>
      <i aria-hidden="true" />
      {props.text}
    </span>
  );
}

function PairingPanel(props: { zh: boolean; pairing: ImPairingSessionSnapshot | null; qrCodeDataUrl: string | null; remainingSeconds: number; busy: boolean; onRecreate(): void }) {
  const expired = Boolean(props.pairing && props.remainingSeconds <= 0);
  return (
    <section className="im-pairing-panel" aria-labelledby="im-pairing-title">
      <div className="im-section-title">
        <span className="im-section-icon">
          <QrCode aria-hidden="true" />
        </span>
        <span>
          <strong id="im-pairing-title">{props.zh ? '在 Telegram 私聊完成配对' : 'Finish pairing in a Telegram private chat'}</strong>
          <small>{props.zh ? '配对码 10 分钟有效且只能使用一次；群聊和第二个用户会被拒绝。' : 'The code expires in 10 minutes and is single-use. Groups and second users are rejected.'}</small>
        </span>
      </div>
      {props.pairing ? (
        <div className="im-pairing-content">
          <div className="im-qr-frame">{props.qrCodeDataUrl ? <img src={props.qrCodeDataUrl} alt={props.zh ? 'Telegram 私聊配对二维码' : 'Telegram private-chat pairing QR code'} /> : <QrCode aria-hidden="true" />}</div>
          <div className="im-pairing-copy">
            <strong>{expired ? (props.zh ? '配对码已过期' : 'Pairing code expired') : `${props.zh ? '剩余' : 'Expires in'} ${formatCountdown(props.remainingSeconds)}`}</strong>
            <span>{props.zh ? '使用手机相机扫码，在 Telegram 中确认进入正确的 Bot 私聊后点击 Start。' : 'Scan with your phone camera, confirm the bot private chat in Telegram, and tap Start.'}</span>
            <a className="im-primary-action" href={props.pairing.deepLink} target="_blank" rel="noreferrer">
              {props.zh ? '在 Telegram 中打开' : 'Open in Telegram'}
            </a>
            <button type="button" className="im-secondary-action" onClick={props.onRecreate} disabled={props.busy}>
              {props.zh ? '撤销并重新生成' : 'Revoke and regenerate'}
            </button>
          </div>
        </div>
      ) : (
        <div className="im-state-message danger">
          <WarningCircle aria-hidden="true" />
          {props.zh ? '应用重启后，请重新生成配对码。' : 'Generate a new pairing code after restarting the app.'}
          <button type="button" onClick={props.onRecreate} disabled={props.busy}>
            {props.zh ? '重新生成' : 'Regenerate'}
          </button>
        </div>
      )}
    </section>
  );
}

function ConnectionCard(props: {
  zh: boolean;
  connection: ImConnectionSnapshot;
  options: ImProjectSelectionOption[];
  presetKey: string;
  busy: boolean;
  logs: ImTelegramConnectionLogEntry[] | null;
  onPresetChange(value: string): void;
  onRemoteApprovalChange(enabled: boolean): void;
  onCheck(): void;
  onPair(): void;
  onRemove(): void;
  onToggleLogs(): void;
}) {
  const project = props.options.find((item) => item.id === props.connection.projectId);
  const health = props.connection.health;
  return (
    <section className="im-connection-section" aria-labelledby="im-connections-title">
      <div className="im-connection-heading">
        <span>
          <strong id="im-connections-title">{props.zh ? '已接入的 Telegram 账号' : 'Connected Telegram account'}</strong>
          <small>1 / 1</small>
        </span>
        <span className={`im-health-pill ${health.online ? 'online' : 'offline'}`}>
          <i aria-hidden="true" />
          {health.online ? (props.zh ? '运行正常' : 'Online') : props.zh ? '未在线' : 'Offline'}
        </span>
      </div>
      <article className="im-connection-card">
        <header>
          <span className="im-bot-avatar">
            <PaperPlaneTilt aria-hidden="true" weight="fill" />
          </span>
          <span className="im-bot-identity">
            <strong>{props.connection.bot.displayName}</strong>
            <code>@{props.connection.bot.username}</code>
          </span>
          <span className="im-health-copy">
            <strong>{health.reason}</strong>
            <small>{health.lastCheckedAt ? `${props.zh ? '最近检查' : 'Last checked'} ${formatDateTime(health.lastCheckedAt)}` : props.zh ? '尚未检查' : 'Not checked yet'}</small>
          </span>
        </header>
        <dl className="im-binding-facts">
          <div>
            <dt>{props.zh ? '绑定项目' : 'Project'}</dt>
            <dd>{props.connection.projectName}</dd>
          </div>
          <div>
            <dt>{props.zh ? '已配对用户' : 'Paired user'}</dt>
            <dd>
              {props.connection.trustedEndpoint
                ? `${props.connection.trustedEndpoint.displayName ?? (props.zh ? 'Telegram 用户' : 'Telegram user')} · ${props.connection.trustedEndpoint.providerUserIdMasked}`
                : props.zh
                  ? '等待私聊配对'
                  : 'Waiting for private-chat pairing'}
            </dd>
          </div>
        </dl>
        {props.connection.state === 'reconfiguration_required' ? (
          <div className="im-state-message danger" role="alert">
            <WarningCircle aria-hidden="true" />
            {props.zh ? '当前智能体配置已不可用。请选择可用配置后再发送新消息。' : 'The current agent configuration is unavailable. Select an available configuration before sending new messages.'}
          </div>
        ) : null}
        <label className="im-card-field">
          <span>
            <strong>Agent Preset</strong>
            <small>{props.zh ? '更改将用于新对话和新任务，正在进行的对话继续使用原配置。' : 'Changes apply to new conversations and tasks. Ongoing conversations keep their existing settings.'}</small>
          </span>
          <select value={props.presetKey} onChange={(event) => props.onPresetChange(event.currentTarget.value)} disabled={props.busy}>
            {project?.presets.map((preset) => (
              <option key={agentPresetKey(preset.ref)} value={agentPresetKey(preset.ref)}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <label className="im-approval-toggle">
          <span>
            <strong>{props.zh ? '允许 Telegram 远程审批' : 'Allow Telegram remote approvals'}</strong>
            <small>{props.zh ? '默认关闭；开启前需要明确确认。' : 'Off by default and requires explicit confirmation.'}</small>
          </span>
          <input type="checkbox" role="switch" checked={props.connection.remoteApprovalEnabled} onChange={(event) => props.onRemoteApprovalChange(event.currentTarget.checked)} disabled={props.busy} />
        </label>
        <footer>
          {props.connection.state === 'pending_pairing' ? (
            <button type="button" className="im-secondary-action" onClick={props.onPair} disabled={props.busy}>
              {props.zh ? '重新配对' : 'Pair again'}
            </button>
          ) : null}
          <button type="button" className="im-secondary-action" onClick={props.onToggleLogs} disabled={props.busy}>
            {props.logs ? (props.zh ? '收起日志' : 'Hide logs') : props.zh ? '查看脱敏日志' : 'View redacted logs'}
          </button>
          <button type="button" className="im-secondary-action" onClick={props.onCheck} disabled={props.busy}>
            {props.zh ? '检查连接' : 'Check connection'}
          </button>
          <button type="button" className="im-danger-action" onClick={props.onRemove} disabled={props.busy}>
            {props.zh ? '移除接入' : 'Remove'}
          </button>
        </footer>
        {props.logs ? (
          <div className="im-log-list" aria-label={props.zh ? 'Telegram 脱敏连接日志' : 'Redacted Telegram connection logs'}>
            {props.logs.length ? (
              props.logs.slice(0, 20).map((entry) => (
                <div key={entry.id} className={entry.level}>
                  <time dateTime={entry.occurredAt}>{formatDateTime(entry.occurredAt)}</time>
                  <code>{entry.event}</code>
                  <span>{entry.message}</span>
                </div>
              ))
            ) : (
              <span>{props.zh ? '暂无连接日志。' : 'No connection logs.'}</span>
            )}
          </div>
        ) : null}
      </article>
    </section>
  );
}

function ChannelIcon(props: { channelId: ImChannelId; large?: boolean }) {
  const className = `im-channel-icon channel-${props.channelId}${props.large ? ' large' : ''}`;
  const icon = (() => {
    switch (props.channelId) {
      case 'wechat':
        return <WechatLogo weight="fill" />;
      case 'slack':
        return <SlackLogo weight="fill" />;
      case 'telegram':
        return <PaperPlaneTilt weight="fill" />;
      case 'discord':
        return <DiscordLogo weight="fill" />;
      case 'whatsapp':
        return <WhatsappLogo weight="fill" />;
      case 'wecom':
        return <Buildings weight="fill" />;
      case 'ai_office':
        return <Robot weight="fill" />;
      default:
        return <ChatsCircle weight="fill" />;
    }
  })();
  return (
    <span className={className} aria-hidden="true">
      {icon}
    </span>
  );
}

function agentPresetKey(ref: ImAgentPresetRef): string {
  return ref.kind === 'zeus_default' ? 'zeus_default' : `digital_employee:${ref.digitalEmployeeId}`;
}

function parseAgentPresetKey(value: string): ImAgentPresetRef {
  return value === 'zeus_default' ? { kind: 'zeus_default', digitalEmployeeId: null } : { kind: 'digital_employee', digitalEmployeeId: value.replace(/^digital_employee:/, '') };
}

function replaceConnection(setter: (value: ImSettingsSnapshot | null | ((current: ImSettingsSnapshot | null) => ImSettingsSnapshot | null)) => void, connection: ImConnectionSnapshot): void {
  setter((current) => (current ? { ...current, connections: [connection] } : current));
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 显示当前语言的原因，并保留可展开的原始详情。 */
function errorMessage(error: unknown, language: 'zh-CN' | 'en'): string {
  return reportApplicationError(error, { language });
}
