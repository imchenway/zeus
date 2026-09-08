import { reportApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { useCallback, useEffect, useState } from 'react';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { FileTextIcon as FileText } from '@phosphor-icons/react/dist/csr/FileText';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { LockSimpleIcon as LockSimple } from '@phosphor-icons/react/dist/csr/LockSimple';
import { PlugsIcon as Plugs } from '@phosphor-icons/react/dist/csr/Plugs';
import { QrCodeIcon as QrCode } from '@phosphor-icons/react/dist/csr/QrCode';
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { SlidersHorizontalIcon as SlidersHorizontal } from '@phosphor-icons/react/dist/csr/SlidersHorizontal';
import { TelegramLogoIcon as TelegramLogo } from '@phosphor-icons/react/dist/csr/TelegramLogo';
import { UserCircleIcon as UserCircle } from '@phosphor-icons/react/dist/csr/UserCircle';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { Button } from '../../ui/Button.js';
import QRCode from 'qrcode';
import type { ImAgentPresetRef, ImConnectionSnapshot, ImPairingSessionSnapshot, ImProjectSelectionOption, ImSettingsSnapshot, ImTelegramConnectionLogEntry } from '../../apiClient.js';
import type { AppLanguage } from '../workspace/workspaceCopy.js';
import type { TelegramApiClient } from './telegramApiClient.js';
import './imRobotSettings.css';

/** 机器人设置页只接收接口客户端和显示语言。 */
export interface ImRobotSettingsPaneProps {
  client: TelegramApiClient | null;
  language: AppLanguage;
}

/** 区分正在执行的操作，统一阻止重复提交并显示进度。 */
type AsyncAction = 'create' | 'pairing' | 'check' | 'update' | 'remove' | 'logs' | null;

/** 管理机器人接入、私聊配对与连接维护的完整页面。 */
export function ImRobotSettingsPane(props: ImRobotSettingsPaneProps) {
  /** 页面文案跟随应用语言。 */
  const zh = props.language === 'zh-CN';
  /** 服务端快照保存渠道目录和唯一机器人连接。 */
  const [snapshot, setSnapshot] = useState<ImSettingsSnapshot | null>(null);
  /** 可绑定的项目与各项目的智能体配置。 */
  const [options, setOptions] = useState<ImProjectSelectionOption[]>([]);
  /** 接入表单中选中的项目。 */
  const [projectId, setProjectId] = useState('');
  /** 接入表单和连接设置当前显示的配置键。 */
  const [presetKey, setPresetKey] = useState('zeus_default');
  /** 密钥只保存在输入期间的内存中，创建成功后清空。 */
  const [botToken, setBotToken] = useState('');
  /** 用户是否选择导入本机已有密钥。 */
  const [useLegacyToken, setUseLegacyToken] = useState(false);
  /** 当前一次性私聊配对信息。 */
  const [pairing, setPairing] = useState<ImPairingSessionSnapshot | null>(null);
  /** 由配对链接生成的本地二维码。 */
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  /** 配对入口的剩余有效秒数。 */
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  /** 展开时加载的脱敏日志，空值表示收起。 */
  const [logs, setLogs] = useState<ImTelegramConnectionLogEntry[] | null>(null);
  /** 当前异步操作，用于禁用控件。 */
  const [action, setAction] = useState<AsyncAction>(null);
  /** 显式操作的可见错误。 */
  const [error, setError] = useState<string | null>(null);
  /** 成功操作的即时反馈。 */
  const [notice, setNotice] = useState<string | null>(null);

  /** 同时读取连接和项目选项，恢复当前绑定信息。 */
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

  /** 当前仅支持一个 Telegram 连接。 */
  const connection = snapshot?.connections[0] ?? null;
  /** 从项目目录派生表单的配置选项。 */
  const selectedProject = options.find((option) => option.id === projectId) ?? null;
  /** 所选项目允许使用的智能体配置。 */
  const presetOptions = selectedProject?.presets ?? [];
  /** 任一操作执行期间统一锁定变更入口。 */
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

  /** 统一维护异步操作的进度、错误和完成反馈。 */
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

  /** 验证密钥并创建需要私聊配对的连接。 */
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

  /** 撤销旧配对码并请求新的配对入口。 */
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

  /** 显式检查密钥和连接健康状况。 */
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

  /** 服务端确认后更新配置，失败时保持已保存的选择。 */
  const updatePreset = (value: string): void => {
    if (!props.client || !connection) return;
    void execute(
      'update',
      () => props.client!.updateTelegramImConnection(connection.id, { expectedRevision: connection.revision, agentPreset: parseAgentPresetKey(value) }),
      (updated) => {
        replaceConnection(setSnapshot, updated);
        setPresetKey(agentPresetKey(updated.agentPreset));
        setNotice(zh ? '默认智能体配置已更新，将用于之后新建的对话和任务。' : 'The default agent settings have been updated and will apply to new conversations and tasks.');
      },
    );
  };

  /** 开启远程审批前保留用户明确确认。 */
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

  /** 确认后移除接入并刷新页面，保留任务与会话历史。 */
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

  /** 按需读取或收起脱敏日志。 */
  const loadLogs = (): void => {
    if (!props.client || !connection) return;
    if (logs) {
      setLogs(null);
      return;
    }
    void execute('logs', () => props.client!.loadTelegramImConnectionLogs(connection.id), setLogs);
  };

  return (
    <section className="settings-product-pane im-robot-settings" aria-label={zh ? 'IM 机器人' : 'IM Bots'}>
      <header className="im-page-heading">
        <h2 className="settings-page-title">{zh ? 'IM 机器人' : 'IM Bots'}</h2>
        <p>{zh ? '在聊天中交办任务，随时查看项目进展。' : 'Delegate tasks in chat and follow your project’s progress.'}</p>
      </header>

      <div className="im-platform-bar">
        <div className="im-platform-identity">
          <TelegramMark />
          <strong>Telegram</strong>
          <span>{zh ? '私聊机器人' : 'Private chat bot'}</span>
        </div>
        {snapshot?.channels.some((channel) => channel.availability === 'unsupported') ? (
          <details className="im-platform-directory">
            <summary>
              {zh ? '更多平台' : 'More platforms'}
              <CaretDown aria-hidden="true" />
            </summary>
            <div className="im-platform-options">
              <p>{zh ? '以下平台暂未支持，当前可通过 Telegram 接入。' : 'These platforms are not supported yet. Connect with Telegram for now.'}</p>
              <ul>
                {snapshot.channels
                  .filter((channel) => channel.availability === 'unsupported')
                  .map((channel) => (
                    <li key={channel.id}>{channel.name}</li>
                  ))}
              </ul>
            </div>
          </details>
        ) : null}
      </div>

      {!props.client || error ? (
        <div className="im-state-message danger" role="alert">
          <WarningCircle aria-hidden="true" />
          {error ?? (zh ? '无法连接 Zeus 后台，暂时不能读取机器人状态。' : 'Zeus cannot connect to its background service to load the bot status.')}
        </div>
      ) : null}
      {notice ? (
        <div className="im-state-message success" role="status">
          <CheckCircle aria-hidden="true" />
          {notice}
        </div>
      ) : null}
      {props.client && !snapshot && !error ? (
        <div className="im-empty-state" role="status" aria-busy="true">
          {zh ? '正在读取连接状态…' : 'Loading connection status…'}
        </div>
      ) : null}

      {snapshot && !connection ? (
        <section className="im-connect-wizard" aria-labelledby="im-connect-title">
          <div className="im-section-title">
            <h3 id="im-connect-title">{zh ? '连接你的 Telegram 机器人' : 'Connect your Telegram bot'}</h3>
            <p>{zh ? '选择项目，验证机器人，然后在手机上完成私聊配对。' : 'Choose a project, verify your bot, then pair in a private chat on your phone.'}</p>
          </div>
          <ol className="im-step-list">
            <li>
              <span className="im-step-number" aria-hidden="true">
                1
              </span>
              <div className="im-step-body">
                <h4>{zh ? '选择工作范围' : 'Choose the workspace'}</h4>
                <div className="im-form-grid">
                  <label className="im-form-field">
                    <span>{zh ? '绑定项目' : 'Project'}</span>
                    <select
                      value={projectId}
                      onChange={(event) => {
                        setProjectId(event.currentTarget.value);
                        setPresetKey('zeus_default');
                      }}
                      disabled={busy || !options.length}
                    >
                      {!options.length ? <option value="">{zh ? '暂无可绑定项目' : 'No projects available'}</option> : null}
                      {options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="im-form-field">
                    <span>{zh ? '智能体配置' : 'Agent settings'}</span>
                    <select value={presetKey} onChange={(event) => setPresetKey(event.currentTarget.value)} disabled={busy || !presetOptions.length}>
                      {presetOptions.map((preset) => (
                        <option key={agentPresetKey(preset.ref)} value={agentPresetKey(preset.ref)}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {!options.length ? <p className="im-field-hint">{zh ? '请先在 Zeus 中添加项目，再回来连接机器人。' : 'Add a project in Zeus before connecting your bot.'}</p> : null}
              </div>
            </li>
            <li>
              <span className="im-step-number" aria-hidden="true">
                2
              </span>
              <div className="im-step-body">
                <h4>{zh ? '验证机器人' : 'Verify the bot'}</h4>
                <p className="im-field-hint">{zh ? '在 Telegram 的 @BotFather 中创建机器人，复制密钥并粘贴到下方。' : 'Create a bot with @BotFather in Telegram, then paste its token below.'}</p>
                {snapshot.legacyTelegramTokenPending ? (
                  <label className="im-legacy-token-choice">
                    <input type="checkbox" checked={useLegacyToken} onChange={(event) => setUseLegacyToken(event.currentTarget.checked)} disabled={busy} />
                    <span>
                      <strong>{zh ? '使用本机已有的机器人密钥' : 'Use the bot token already on this Mac'}</strong>
                      <small>{zh ? '导入后仍需重新配对，之前允许的用户不会自动获得访问权限。' : 'Pair again after importing. Previously allowed users will not automatically receive access.'}</small>
                    </span>
                  </label>
                ) : null}
                {!useLegacyToken ? (
                  <label className="im-form-field">
                    <span>{zh ? '机器人密钥（BotFather Token）' : 'BotFather token'}</span>
                    <input type="password" autoComplete="off" spellCheck={false} value={botToken} onChange={(event) => setBotToken(event.currentTarget.value)} placeholder="123456789:AA…" disabled={busy} />
                  </label>
                ) : null}
                <p className="im-field-hint">
                  <LockSimple aria-hidden="true" />
                  {zh ? '密钥仅保存在本机 macOS 钥匙串中。' : 'The token is stored in this Mac’s Keychain.'}
                </p>
                <Button className="im-primary-action" variant="primary" busy={action === 'create'} onClick={createConnection} disabled={busy || !projectId || (!useLegacyToken && !botToken.trim())}>
                  <QrCode aria-hidden="true" />
                  {action === 'create' ? (zh ? '正在校验…' : 'Verifying…') : zh ? '验证并开始配对' : 'Verify and pair'}
                </Button>
              </div>
            </li>
          </ol>
          <AccessNote zh={zh} />
        </section>
      ) : null}
      {connection ? (
        <>
          {connection.state === 'pending_pairing' ? <PairingPanel zh={zh} pairing={pairing} qrCodeDataUrl={qrCodeDataUrl} remainingSeconds={remainingSeconds} busy={busy} onRecreate={recreatePairing} /> : null}
          <ConnectionCard
            zh={zh}
            connection={connection}
            options={options}
            presetKey={presetKey}
            busy={busy}
            action={action}
            logs={logs}
            onPresetChange={updatePreset}
            onRemoteApprovalChange={updateRemoteApproval}
            onCheck={checkConnection}
            onPair={recreatePairing}
            onRemove={removeConnection}
            onToggleLogs={loadLogs}
          />
        </>
      ) : null}
    </section>
  );
}

/** 统一访问范围说明，避免把静态规则误展示为实时在线状态。 */
function AccessNote(props: { zh: boolean }) {
  return (
    <p className="im-access-note">
      <LockSimple aria-hidden="true" />
      {props.zh ? '仅已配对的私聊用户可访问，任务范围限定在绑定项目内。' : 'Only the paired private-chat user has access, limited to the connected project.'}
    </p>
  );
}

/** Telegram 标识使用已有品牌图标，圆形底色与普通功能图标区分。 */
function TelegramMark() {
  return (
    <span className="im-telegram-mark" aria-hidden="true">
      <TelegramLogo weight="fill" />
    </span>
  );
}

/** 展示一次性私聊配对入口及有效期，失效后引导重新生成。 */
function PairingPanel(props: { zh: boolean; pairing: ImPairingSessionSnapshot | null; qrCodeDataUrl: string | null; remainingSeconds: number; busy: boolean; onRecreate(): void }) {
  // 配对码过期后不再提供可点击的旧链接。
  const expired = Boolean(props.pairing && props.remainingSeconds <= 0);
  return (
    <section className="im-pairing-panel" aria-labelledby="im-pairing-title">
      <div className="im-section-title">
        <h3 id="im-pairing-title">{props.zh ? '在 Telegram 私聊完成配对' : 'Finish pairing in a Telegram private chat'}</h3>
        <p>{props.zh ? '配对码 10 分钟有效且只能使用一次；群聊和第二个用户会被拒绝。' : 'The code expires in 10 minutes and is single-use. Groups and second users are rejected.'}</p>
      </div>
      {props.pairing ? (
        <div className="im-pairing-content">
          <div className={`im-qr-frame${expired ? ' is-expired' : ''}`}>
            {props.qrCodeDataUrl && !expired ? <img src={props.qrCodeDataUrl} alt={props.zh ? 'Telegram 私聊配对二维码' : 'Telegram private-chat pairing QR code'} /> : <QrCode aria-hidden="true" />}
          </div>
          <div className="im-pairing-copy">
            <strong>{expired ? (props.zh ? '配对码已过期' : 'Pairing code expired') : `${props.zh ? '剩余' : 'Expires in'} ${formatCountdown(props.remainingSeconds)}`}</strong>
            <span>
              {expired
                ? props.zh
                  ? '请重新生成配对码，再使用手机扫码完成配对。'
                  : 'Generate a new code, then scan it with your phone to pair.'
                : props.zh
                  ? '使用手机相机扫码，在 Telegram 中确认进入正确的 Bot 私聊后点击 Start。'
                  : 'Scan with your phone camera, confirm the bot private chat in Telegram, and tap Start.'}
            </span>
            {!expired ? (
              <a className="im-primary-action" href={props.pairing.deepLink} target="_blank" rel="noreferrer">
                <TelegramLogo aria-hidden="true" />
                {props.zh ? '在 Telegram 中打开' : 'Open in Telegram'}
              </a>
            ) : null}
            <button type="button" className="im-secondary-action" onClick={props.onRecreate} disabled={props.busy}>
              {props.zh ? '撤销并重新生成' : 'Revoke and regenerate'}
            </button>
          </div>
        </div>
      ) : (
        <div className="im-state-message danger">
          <WarningCircle aria-hidden="true" />
          {props.zh ? '应用重启后，请重新生成配对码。' : 'Generate a new pairing code after restarting the app.'}
          <button type="button" className="im-secondary-action" onClick={props.onRecreate} disabled={props.busy}>
            {props.zh ? '重新生成' : 'Regenerate'}
          </button>
        </div>
      )}
    </section>
  );
}

/** 将账号概览、连接设置和维护操作按使用顺序展开。 */
function ConnectionCard(props: {
  zh: boolean;
  connection: ImConnectionSnapshot;
  options: ImProjectSelectionOption[];
  presetKey: string;
  busy: boolean;
  action: AsyncAction;
  logs: ImTelegramConnectionLogEntry[] | null;
  onPresetChange(value: string): void;
  onRemoteApprovalChange(enabled: boolean): void;
  onCheck(): void;
  onPair(): void;
  onRemove(): void;
  onToggleLogs(): void;
}) {
  // 当前项目决定可选配置。
  const project = props.options.find((item) => item.id === props.connection.projectId);
  // 健康详情保留服务端返回的原因和最近检查时间。
  const health = props.connection.health;
  // 已完成配对且连接正常时才显示绿色在线状态。
  const online = props.connection.state === 'active' && health.online;
  // 待配对、配置失效和停用状态优先于传输连接是否在线。
  const status =
    props.connection.state === 'pending_pairing'
      ? props.zh
        ? '等待配对'
        : 'Awaiting pairing'
      : props.connection.state === 'reconfiguration_required'
        ? props.zh
          ? '需更新配置'
          : 'Update required'
        : props.connection.state === 'disabled'
          ? props.zh
            ? '已停用'
            : 'Disabled'
          : online
            ? props.zh
              ? '运行正常'
              : 'Online'
            : props.zh
              ? '连接离线'
              : 'Offline';
  return (
    <section className="im-connection-section" aria-label={props.zh ? 'Telegram 连接' : 'Telegram connection'}>
      <article className="im-account-overview" aria-label={props.zh ? '机器人账号' : 'Bot account'}>
        <header className="im-account-heading">
          <TelegramMark />
          <div className="im-bot-identity">
            <h3>{props.connection.bot.displayName}</h3>
            <span>@{props.connection.bot.username}</span>
          </div>
          <span className={`im-connection-status ${online ? 'online' : 'offline'}`}>
            <i aria-hidden="true" />
            {status}
          </span>
        </header>
        <div className="im-health-detail">
          <p>{health.reason}</p>
          <span>
            {health.lastCheckedAt ? (
              <>
                {props.zh ? '最近检查 ' : 'Last checked '}
                <time dateTime={health.lastCheckedAt}>{formatDateTime(health.lastCheckedAt)}</time>
              </>
            ) : props.zh ? (
              '尚未检查'
            ) : (
              'Not checked yet'
            )}
          </span>
        </div>
        <dl className="im-binding-facts">
          <div>
            <Folder aria-hidden="true" />
            <dt>{props.zh ? '绑定项目' : 'Project'}</dt>
            <dd>{props.connection.projectName}</dd>
          </div>
          <div>
            <UserCircle aria-hidden="true" />
            <dt>{props.zh ? '已配对用户' : 'Paired user'}</dt>
            <dd>
              {props.connection.trustedEndpoint ? (
                <>
                  {props.connection.trustedEndpoint.displayName ?? (props.zh ? 'Telegram 用户' : 'Telegram user')}
                  <span className="im-masked-id"> · {props.connection.trustedEndpoint.providerUserIdMasked}</span>
                </>
              ) : props.zh ? (
                '等待私聊配对'
              ) : (
                'Waiting for private-chat pairing'
              )}
            </dd>
          </div>
        </dl>
      </article>

      <div className="im-connection-settings">
        <h3>{props.zh ? '连接设置' : 'Connection settings'}</h3>
        {props.connection.state === 'reconfiguration_required' ? (
          <div className="im-state-message danger" role="alert">
            <WarningCircle aria-hidden="true" />
            {props.zh ? '当前智能体配置已不可用。请选择可用配置后再发送新消息。' : 'The current agent settings are unavailable. Select an available configuration before sending new messages.'}
          </div>
        ) : null}
        <label className="im-setting-row im-preset-row">
          <SlidersHorizontal aria-hidden="true" />
          <span className="im-setting-copy">
            <strong>{props.zh ? '智能体配置' : 'Agent settings'}</strong>
            <small>{props.zh ? '用于新对话和新任务；进行中的对话保持原配置。' : 'Applies to new conversations and tasks. Ongoing conversations keep their settings.'}</small>
          </span>
          <select value={props.presetKey} onChange={(event) => props.onPresetChange(event.currentTarget.value)} disabled={props.busy || !project?.presets.length}>
            {!project?.presets.some((preset) => agentPresetKey(preset.ref) === props.presetKey) ? (
              <option value={props.presetKey} disabled>
                {props.connection.agentPresetName}
              </option>
            ) : null}
            {project?.presets.map((preset) => (
              <option key={agentPresetKey(preset.ref)} value={agentPresetKey(preset.ref)}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <label className="im-setting-row im-approval-row">
          <ShieldCheck aria-hidden="true" />
          <span className="im-setting-copy">
            <strong id="im-approval-label">{props.zh ? '远程审批' : 'Remote approvals'}</strong>
            <small id="im-approval-description">
              {props.zh ? '允许已配对用户在 Telegram 中批准或拒绝操作。' : 'Allow the paired user to approve or decline actions in Telegram.'}
              <br />
              {props.zh ? '开启时需确认账号仅由你使用。' : 'Confirm that only you can access the account before enabling.'}
            </small>
          </span>
          <input
            className="im-switch"
            type="checkbox"
            role="switch"
            aria-labelledby="im-approval-label"
            aria-describedby="im-approval-description"
            checked={props.connection.remoteApprovalEnabled}
            onChange={(event) => props.onRemoteApprovalChange(event.currentTarget.checked)}
            disabled={props.busy}
          />
        </label>
        <AccessNote zh={props.zh} />
      </div>

      <footer className="im-connection-actions">
        <Button className="im-danger-action" variant="danger" onClick={props.onRemove} disabled={props.busy} busy={props.action === 'remove'}>
          <Plugs aria-hidden="true" />
          {props.zh ? '移除接入' : 'Remove connection'}
        </Button>
        <div>
          {props.connection.state === 'pending_pairing' ? (
            <Button className="im-secondary-action" onClick={props.onPair} disabled={props.busy}>
              <QrCode aria-hidden="true" />
              {props.zh ? '重新配对' : 'Pair again'}
            </Button>
          ) : null}
          <Button className="im-secondary-action" onClick={props.onToggleLogs} disabled={props.busy} busy={props.action === 'logs'} aria-expanded={props.logs !== null} aria-controls="im-connection-logs">
            <FileText aria-hidden="true" />
            {props.action === 'logs' ? (props.zh ? '正在读取…' : 'Loading…') : props.logs ? (props.zh ? '收起日志' : 'Hide logs') : props.zh ? '查看日志' : 'View logs'}
          </Button>
          <Button className="im-secondary-action" onClick={props.onCheck} disabled={props.busy} busy={props.action === 'check'}>
            <ArrowsClockwise aria-hidden="true" />
            {props.action === 'check' ? (props.zh ? '正在检查…' : 'Checking…') : props.zh ? '检查连接' : 'Check connection'}
          </Button>
        </div>
      </footer>
      <div id="im-connection-logs" className="im-log-list" hidden={!props.logs} role="region" aria-label={props.zh ? 'Telegram 脱敏连接日志' : 'Redacted Telegram connection logs'}>
        <p>{props.zh ? '连接日志中的敏感信息已隐藏。' : 'Sensitive details are hidden in these connection logs.'}</p>
        {props.logs?.length ? (
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
    </section>
  );
}

/** 把配置引用转换为原生选择控件的稳定值。 */
function agentPresetKey(ref: ImAgentPresetRef): string {
  return ref.kind === 'zeus_default' ? 'zeus_default' : `digital_employee:${ref.digitalEmployeeId}`;
}

/** 将选项值还原为服务端配置引用。 */
function parseAgentPresetKey(value: string): ImAgentPresetRef {
  return value === 'zeus_default' ? { kind: 'zeus_default', digitalEmployeeId: null } : { kind: 'digital_employee', digitalEmployeeId: value.replace(/^digital_employee:/, '') };
}

/** 用服务端结果替换唯一连接，保留渠道目录。 */
function replaceConnection(setter: (value: ImSettingsSnapshot | null | ((current: ImSettingsSnapshot | null) => ImSettingsSnapshot | null)) => void, connection: ImConnectionSnapshot): void {
  setter((current) => (current ? { ...current, connections: [connection] } : current));
}

/** 将剩余秒数显示为分钟和秒。 */
function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 用本地日期格式显示检查时间与日志时间。 */
function formatDateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 显示当前语言的原因，并保留可展开的原始详情。 */
function errorMessage(error: unknown, language: 'zh-CN' | 'en'): string {
  return reportApplicationError(error, { language });
}
