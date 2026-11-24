import { useEffect, useState } from 'react';
import { codexCapabilitiesChangedEvent, type AntigravityAccountCatalog } from '../features/codex/codexApiClient.js';
import type { NativeConversationAppClient } from '../features/workspace/workspaceSupport.js';
import { Button } from '../ui/Button.js';
import { ManagedCliProgress } from './ManagedCliProgress.js';
import { ModelProviderIdentity } from './ModelProviderIdentity.js';

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
  /** 操作期间避免再次发起登录或刷新。 */
  const [busy, setBusy] = useState(false);
  /** 保留当前操作的可读错误。 */
  const [error, setError] = useState<string | null>(null);
  /** 程序准备和浏览器授权共用同一可取消流程。 */
  const connecting = catalog?.status === 'installing' || catalog?.status === 'signing_in';
  /** 启动时恢复账号也会更新模型目录。 */
  const checking = catalog?.status === 'checking';

  useEffect(() => {
    if (!client) return;
    let active = true;
    void client.loadAntigravityAccount().then(
      (value) => {
        if (active) setCatalog(value);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (!client || (!connecting && !checking) || busy) return;
    let active = true;
    let timer: number;
    /** 只有上一轮读完才发出下一次状态查询。 */
    const poll = async () => {
      try {
        const value = await client.loadAntigravityAccount();
        if (!active) return;
        setCatalog(value);
        if (value.status === 'ready') window.dispatchEvent(new Event(codexCapabilitiesChangedEvent));
        if (value.status !== 'installing' && value.status !== 'signing_in' && value.status !== 'checking') return;
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      timer = window.setTimeout(() => void poll(), 1200);
    };
    timer = window.setTimeout(() => void poll(), 1200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [busy, checking, client, connecting]);

  /** 用户明确操作才刷新 CLI 或发起、取消浏览器登录。 */
  async function changeAccount(action: 'login' | 'refresh' | 'cancel'): Promise<void> {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      const value = await (action === 'login' ? client.startAntigravityLogin() : action === 'cancel' ? client.cancelAntigravityLogin() : client.refreshAntigravityAccount());
      setCatalog(value);
      if (action === 'refresh') window.dispatchEvent(new Event(codexCapabilitiesChangedEvent));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
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
      <div className="model-setup-actions">
        {!connecting ? (
          <Button variant="secondary" busy={busy} disabled={!client || busy || checking} onClick={() => void changeAccount('refresh')}>
            {zh ? '刷新状态' : onChooseModel ? 'Refresh status' : 'Refresh'}
          </Button>
        ) : null}
        {catalog?.status !== 'ready' ? (
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
            {zh ? '选择模型' : 'Choose a model'}
          </Button>
        ) : null}
      </div>
      {catalog?.status === 'installing' && installation ? <ManagedCliProgress program="Antigravity CLI" zh={zh} stage={installation.stage} progress={bytes?.total ? bytes.received / bytes.total : null} bytes={bytes} /> : null}
      {catalog?.status === 'ready' && catalog.models.length === 0 ? <p role="status">{zh ? '此账号暂无可用模型。' : 'No models are available for this account.'}</p> : null}
      {error || (catalog?.status === 'unavailable' && catalog.message) ? (
        <p className="model-connection-message" role="alert">
          {error ?? catalog?.message}
        </p>
      ) : null}
    </section>
  );
}
