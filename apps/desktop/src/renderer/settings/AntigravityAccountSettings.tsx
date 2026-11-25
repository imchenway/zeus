import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { openExternalHttpsUrlInMain } from '../appShellBridge.js';
import { codexCapabilitiesChangedEvent, type AntigravityAccountCatalog } from '../features/codex/codexApiClient.js';
import type { NativeConversationAppClient } from '../features/workspace/workspaceSupport.js';
import { Button } from '../ui/Button.js';
import { ManagedCliProgress } from './ManagedCliProgress.js';
import { ModelProviderAvailableModels, ModelProviderIdentity } from './ModelProviderIdentity.js';

/** 修改当前 Antigravity 接入状态的账号操作。 */
type AccountAction = 'login' | 'refresh' | 'cancel' | 'logout';

/** Google 验证完成后可能短暂仍返回挑战，回到前台最多复查三次。 */
const verificationRetryDelaysMs = [1_500, 3_000];

/** Antigravity 的官方 Google 登录和当前可用模型状态。 */
export function AntigravityAccountSettings({
  client,
  language,
  onChooseModel,
  choosingModel,
}: {
  client: NativeConversationAppClient | null;
  language: 'zh-CN' | 'en-US';
  onChooseModel?: () => Promise<void>;
  choosingModel?: boolean;
}): React.JSX.Element {
  /** 沿用应用语言。 */
  const zh = language === 'zh-CN';
  /** 账号状态仅从 Core 读取，凭据不进入设置页。 */
  const [catalog, setCatalog] = useState<AntigravityAccountCatalog | null>(null);
  /** 当前操作决定哪个按钮显示进度，其他按钮在此期间停用。 */
  const [busyAction, setBusyAction] = useState<AccountAction | 'verify' | null>(null);
  /** 自动检查与按钮操作共用同步锁，避免同一帧发出两个请求。 */
  const actionInFlight = useRef(false);
  /** 只接受最后一次读取或账号操作的回执。 */
  const catalogRevision = useRef(0);
  /** 发起验证后才复查。监听已在账号卡片挂载时建立。 */
  const awaitingVerification = useRef(false);
  const busy = busyAction !== null;
  /** 保留当前操作的可读错误。 */
  const [error, setError] = useState<string | null>(null);
  /** 程序准备和浏览器授权共用同一可取消流程。 */
  const connecting = catalog?.status === 'installing' || catalog?.status === 'signing_in';
  /** 启动时恢复账号也会更新模型目录。 */
  const checking = catalog?.status === 'checking';

  useEffect(() => {
    if (!client) return;
    let active = true;
    /** 读取冷启动、其他窗口或 ACP 报告的最新账号状态。 */
    const read = () => {
      if (actionInFlight.current) return;
      const revision = ++catalogRevision.current;
      void client.loadAntigravityAccount().then(
        (value) => {
          if (active && revision === catalogRevision.current) setCatalog(value);
        },
        (cause: unknown) => {
          if (active && revision === catalogRevision.current) setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    };
    read();
    window.addEventListener(codexCapabilitiesChangedEvent, read);
    return () => {
      active = false;
      window.removeEventListener(codexCapabilitiesChangedEvent, read);
    };
  }, [client]);

  useEffect(() => {
    if (!client || (!connecting && !checking) || busy) return;
    let active = true;
    let timer: number;
    /** 只有上一轮读完才发出下一次状态查询。 */
    const poll = async () => {
      if (actionInFlight.current) return;
      const revision = ++catalogRevision.current;
      try {
        const value = await client.loadAntigravityAccount();
        if (!active) return;
        if (revision === catalogRevision.current) setCatalog(value);
        if (value.status !== 'installing' && value.status !== 'signing_in' && value.status !== 'checking') return;
      } catch (cause) {
        if (!active) return;
        if (revision === catalogRevision.current) setError(cause instanceof Error ? cause.message : String(cause));
      }
      timer = window.setTimeout(() => void poll(), 1200);
    };
    timer = window.setTimeout(() => void poll(), 1200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [busy, checking, client, connecting]);

  /** 账号操作完成后更新卡片状态及模型目录。 */
  async function changeAccount(action: AccountAction): Promise<AntigravityAccountCatalog | null> {
    if (!client || actionInFlight.current) return null;
    actionInFlight.current = true;
    catalogRevision.current += 1;
    setBusyAction(action);
    setError(null);
    try {
      const update = { login: client.startAntigravityLogin, refresh: client.refreshAntigravityAccount, cancel: client.cancelAntigravityLogin, logout: client.logoutAntigravityAccount };
      /** Core 回执同时决定是否仍需等待验证。 */
      const next = await update[action]();
      setCatalog(next);
      if (next.status !== 'verification_required') awaitingVerification.current = false;
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      actionInFlight.current = false;
      setBusyAction(null);
    }
  }

  /** 复用显式刷新，确保界面和模型目录消费同一次 Core 检查。 */
  const refreshAfterVerification = useEffectEvent(() => changeAccount('refresh'));
  useEffect(() => {
    const bridge = window.zeus;
    if (!client || !bridge?.getRequestingWindowForeground || !bridge.onRequestingWindowForegroundChanged) return;
    let active = true;
    let foreground: boolean | undefined;
    let attempt = 0;
    let timer: number | undefined;
    let checkingAccount = false;
    /** 上一轮完成后才可重试，切到后台时取消等待中的重试。 */
    const check = async (): Promise<void> => {
      if (!active || !foreground || !awaitingVerification.current || checkingAccount) return;
      checkingAccount = true;
      const next = await refreshAfterVerification();
      checkingAccount = false;
      if (!active || !foreground || !awaitingVerification.current || (next && next.status !== 'verification_required')) return;
      const delay = verificationRetryDelaysMs[attempt++];
      if (delay !== undefined) timer = window.setTimeout(() => void check(), delay);
    };
    /** 使用 Electron 主进程报告的前台状态，避免隐藏窗口发起轮询。 */
    const observeForeground = (next: boolean): void => {
      if (!active || foreground === next) return;
      foreground = next;
      window.clearTimeout(timer);
      if (next) {
        attempt = 0;
        void check();
      }
    };
    const unsubscribe = bridge.onRequestingWindowForegroundChanged(observeForeground);
    void bridge.getRequestingWindowForeground().then(
      ({ foreground: current }) => {
        if (active && foreground === undefined) foreground = current;
      },
      () => undefined,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [client]);

  /** 通过系统浏览器打开 Google 的账号验证页面。 */
  async function openVerification(): Promise<void> {
    if (!client || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyAction('verify');
    setError(null);
    try {
      const { url } = await client.loadAntigravityVerification();
      if (!url) throw new Error(zh ? '验证链接已失效，请刷新状态。' : 'The verification link is unavailable. Refresh status.');
      awaitingVerification.current = true;
      const result = await openExternalHttpsUrlInMain({ zeus: window.zeus, url });
      if (!result.opened) throw new Error(zh ? '无法打开 Google 验证页面。' : 'Could not open the Google verification page.');
    } catch (cause) {
      awaitingVerification.current = false;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      actionInFlight.current = false;
      setBusyAction(null);
    }
  }

  /** 活跃状态文字供所有用户感知，不依赖颜色。 */
  const statusLabels = {
    idle: zh ? '未连接' : 'Not connected',
    checking: zh ? '正在检查连接' : 'Checking connection',
    missing_cli: zh ? '待准备 CLI' : 'CLI setup needed',
    installing: zh ? '安装中' : 'Installing',
    sign_in_required: zh ? '需要登录' : 'Sign-in required',
    signing_in: zh ? '等待浏览器授权' : 'Waiting for browser sign-in',
    verification_required: zh ? 'Google 账号待验证' : 'Google account verification required',
    ready: zh ? '已连接 Google 账号' : 'Google account connected',
    unavailable: zh ? '暂不可用' : 'Unavailable',
  };
  /** Core 下载字节以实际总量计算，其他阶段使用不定进度。 */
  const installation = catalog?.installation;
  /** 下载时即使总量未知也能展示已接收的字节。 */
  const bytes = installation?.stage === 'downloading' ? { received: installation.receivedBytes, total: installation.totalBytes } : undefined;
  return (
    <section className="settings-product-section model-setup-account" aria-label="Google Antigravity">
      <ModelProviderIdentity provider="antigravity" name="Google Antigravity" connected={catalog?.status === 'ready'} busy={connecting || checking || busy}>
        {catalog ? statusLabels[catalog.status] : zh ? '正在读取状态' : 'Checking status'}
      </ModelProviderIdentity>
      <div className="model-setup-actions" data-account-status={catalog?.status}>
        {!connecting ? (
          <Button variant="secondary" busy={busyAction === 'refresh'} disabled={!client || busy || checking} onClick={() => void changeAccount('refresh')}>
            {zh ? '刷新状态' : onChooseModel ? 'Refresh status' : 'Refresh'}
          </Button>
        ) : null}
        {catalog?.status === 'ready' || catalog?.status === 'verification_required' ? (
          <Button variant="secondary" busy={busyAction === 'logout'} disabled={!client || busy} onClick={() => void changeAccount('logout')}>
            {zh ? '退出登录' : 'Sign out'}
          </Button>
        ) : null}
        {catalog?.status === 'verification_required' && catalog.verificationAvailable ? (
          <Button variant="primary" busy={busyAction === 'verify'} disabled={!client || busy} onClick={() => void openVerification()}>
            {zh ? '验证账号' : 'Verify account'}
          </Button>
        ) : null}
        {catalog?.status !== 'ready' && catalog?.status !== 'verification_required' ? (
          <Button
            variant={connecting ? 'secondary' : 'primary'}
            aria-label={connecting ? undefined : zh ? '登录 Google' : 'Sign in with Google'}
            disabled={!client || busy || checking || !catalog}
            onClick={() => void changeAccount(connecting ? 'cancel' : 'login')}
          >
            {connecting ? (zh ? '取消登录' : 'Cancel sign-in') : onChooseModel ? (zh ? '登录 Google' : 'Sign in with Google') : zh ? '登录' : 'Sign in'}
          </Button>
        ) : null}
        {catalog?.status === 'ready' && onChooseModel && catalog.models.length > 0 ? (
          <Button variant="primary" disabled={busy} busy={choosingModel} onClick={onChooseModel}>
            {zh ? '选择模型' : 'Choose model'}
          </Button>
        ) : null}
      </div>
      {catalog?.status === 'installing' && installation ? <ManagedCliProgress program="Antigravity CLI" zh={zh} stage={installation.stage} progress={bytes?.total ? bytes.received / bytes.total : null} bytes={bytes} /> : null}
      {catalog?.status === 'verification_required' && !catalog.verificationAvailable ? <p role="status">{zh ? 'Google 暂未提供验证链接，请刷新状态。' : 'Google has not provided a verification link. Refresh status.'}</p> : null}
      {catalog?.status === 'ready' && !onChooseModel ? (
        <ModelProviderAvailableModels
          provider="antigravity"
          zh={zh}
          models={catalog.models.map((model) => ({ id: model.id, model: model.id, displayName: model.name }))}
          message={zh ? '此账号暂无可用模型。' : 'No models are available for this account.'}
        />
      ) : catalog?.status === 'ready' && catalog.models.length === 0 ? (
        <p role="status">{zh ? '此账号暂无可用模型。' : 'No models are available for this account.'}</p>
      ) : null}
      {error || (catalog?.status === 'unavailable' && catalog.message) ? (
        <p className="model-connection-message" role="alert">
          {error ?? catalog?.message}
        </p>
      ) : null}
    </section>
  );
}
