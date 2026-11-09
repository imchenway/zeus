import { useEffect, useRef, useState } from 'react';
import type { NativeConversationAppClient } from '../features/workspace/workspaceSupport.js';
import type { CopilotAccountCatalog, CopilotLoginStep } from '../features/codex/codexApiClient.js';
import { codexCapabilitiesChangedEvent } from '../features/codex/codexApiClient.js';
import { openExternalHttpsUrlInMain } from '../appShellBridge.js';
import { Button } from '../ui/Button.js';

/** 模型供应商页内的 GitHub Copilot 账号和设备码登录入口。 */
export function CopilotAccountSettings(props: { client: NativeConversationAppClient | null; language: 'zh-CN' | 'en-US' }): React.JSX.Element {
  /** UI 文案随应用语言切换。 */
  const zh = props.language === 'zh-CN';
  /** 目录状态只取当前 SDK 账号的服务端快照。 */
  const [catalog, setCatalog] = useState<CopilotAccountCatalog | null>(null);
  /** 登录状态绑定服务端不透明 flow 身份。 */
  const [loginId, setLoginId] = useState<string | null>(null);
  /** 登录步骤显示设备码、验证地址和完成结果。 */
  const [step, setStep] = useState<CopilotLoginStep | null>(null);
  /** 用户输入仅用于 SDK 显式要求额外信息的步骤。 */
  const [loginInput, setLoginInput] = useState('');
  /** 并发按钮操作共用忙碌状态。 */
  const [busy, setBusy] = useState(false);
  /** 错误只显示当前账号操作的失败原因。 */
  const [error, setError] = useState<string | null>(null);
  /** 卸载时取消尚未完成的授权轮询。 */
  const pendingLoginRef = useRef<string | null>(null);
  pendingLoginRef.current = loginId && step?.kind !== 'completed' ? loginId : null;

  /** 首次打开设置页时主动读取账户与模型，避免把未知状态显示为未登录。 */
  useEffect(() => {
    if (!props.client) return;
    let active = true;
    setBusy(true);
    void props.client.refreshCopilotAccount().then((value) => {
      if (active) setCatalog(value);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [props.client]);

  /** 服务端推进授权期间只轮询同一 flow 的最新结果。 */
  useEffect(() => {
    if (!props.client || !loginId || step?.kind !== 'awaiting') return;
    let active = true;
    const timer = window.setInterval(() => {
      void props.client!.loadCopilotLoginStep(loginId).then(({ step: next }) => {
        if (!active) return;
        setStep(next);
        if (next.kind === 'completed') {
          setLoginId(null);
          void props.client!.refreshCopilotAccount().then((value) => {
            if (!active) return;
            setCatalog(value);
            window.dispatchEvent(new Event(codexCapabilitiesChangedEvent));
          }).catch((cause: unknown) => {
            if (active) setError(cause instanceof Error ? cause.message : String(cause));
          });
        } else if (next.kind === 'error') {
          setError(next.message ?? (zh ? 'Copilot 登录失败。' : 'Copilot sign-in failed.'));
          setLoginId(null);
        }
      }).catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 1200);
    return () => { active = false; window.clearInterval(timer); };
  }, [props.client, loginId, step?.kind, zh]);

  /** 退出供应商页时释放未完成的设备码登录。 */
  useEffect(() => () => {
    if (pendingLoginRef.current) void props.client?.cancelCopilotLogin(pendingLoginRef.current).catch(() => undefined);
  }, [props.client]);

  /** 请求 SDK 开始一次新的 GitHub 授权。 */
  async function beginLogin(): Promise<void> {
    if (!props.client) return;
    setBusy(true);
    setError(null);
    try {
      const result = await props.client.startCopilotLogin();
      setLoginId(result.loginId);
      setStep(result.step);
      if (result.step.kind === 'error') setError(result.step.message ?? (zh ? 'Copilot 登录失败。' : 'Copilot sign-in failed.'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  /** 打开 SDK 指定的 HTTPS 授权地址，浏览器仍由用户完成 GitHub 登录。 */
  async function openVerificationPage(): Promise<void> {
    const url = step?.verificationUri ?? step?.url;
    if (!url) return;
    const result = await openExternalHttpsUrlInMain({ zeus: window.zeus, url });
    if (!result.opened) setError(zh ? '无法打开 GitHub 授权页面。' : 'Could not open the GitHub verification page.');
  }

  /** 授权页面打开后推进原 flow，等待 SDK 返回完成状态。 */
  async function advanceLogin(): Promise<void> {
    if (!props.client || !loginId) return;
    setError(null);
    try {
      const result = await props.client.advanceCopilotLogin(loginId, step?.kind === 'input-required' ? loginInput : undefined);
      setStep(result.step);
      if (result.step.kind === 'completed') {
        setLoginId(null);
        setCatalog(await props.client.refreshCopilotAccount());
        window.dispatchEvent(new Event(codexCapabilitiesChangedEvent));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** 退出只影响当前 Copilot 账号，不更改 Codex 和自定义模型连接。 */
  async function logout(): Promise<void> {
    if (!props.client) return;
    setBusy(true);
    setError(null);
    try {
      setCatalog(await props.client.logoutCopilotAccount());
      window.dispatchEvent(new Event(codexCapabilitiesChangedEvent));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  /** 用户取消时结束当前 SDK 授权 flow，并恢复登录入口。 */
  async function cancelLogin(): Promise<void> {
    if (!props.client || !loginId) return;
    setBusy(true);
    try {
      await props.client.cancelCopilotLogin(loginId);
      setLoginId(null);
      setStep(null);
      setLoginInput('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  /** 当前登录可用模型由账号目录决定，禁用项不展示为可运行。 */
  const availableModels = catalog?.models.filter((model) => model.policy?.state !== 'disabled' && model.policy?.state !== 'unconfigured') ?? [];
  /** 只把官方账户快照中标记为权威预算的数量展示为剩余额度。 */
  const accountQuotas = catalog?.quotas.filter((quota) => quota.observationKind === 'account_snapshot' && quota.acquisitionStatus === 'succeeded' && quota.quantityKind === 'authoritative_budget') ?? [];
  return (
    <section className="settings-product-section model-setup-account" aria-label={zh ? 'GitHub Copilot 订阅' : 'GitHub Copilot subscription'}>
      <header className="settings-section-heading">
        <strong>GitHub Copilot</strong>
        <span className="account-sign-in-state" data-signed-in={catalog?.account?.authenticated || undefined}>
          {catalog?.account?.authenticated ? (zh ? `已登录 · ${catalog.account.login ?? 'GitHub'}` : `Signed in · ${catalog.account.login ?? 'GitHub'}`) : catalog ? (zh ? '未登录' : 'Not signed in') : (zh ? '正在读取账号状态…' : 'Loading account status…')}
        </span>
      </header>
      <div className="model-setup-actions">
        {catalog?.account?.authenticated ? <Button variant="secondary" disabled={busy} onClick={() => void logout()}>{zh ? '退出登录' : 'Sign out'}</Button> : <Button variant="primary" disabled={busy || !props.client || Boolean(loginId)} onClick={() => void beginLogin()}>{zh ? '登录 GitHub Copilot' : 'Sign in to GitHub Copilot'}</Button>}
        {loginId ? <Button variant="secondary" disabled={busy} onClick={() => void cancelLogin()}>{zh ? '取消登录' : 'Cancel sign-in'}</Button> : null}
      </div>
      {step?.kind === 'device-code' || step?.kind === 'open-url' || step?.kind === 'awaiting' || step?.kind === 'input-required' || step?.kind === 'needs-interaction' ? (
        <div className="codex-update-row" role="status">
          {step.userCode ? <strong>{step.userCode}</strong> : null}
          {step.verificationUri || step.url ? <Button variant="secondary" onClick={() => void openVerificationPage()}>{zh ? '打开 GitHub 授权页' : 'Open GitHub verification'}</Button> : null}
          {step.kind === 'input-required' ? <input aria-label={step.prompt ?? (zh ? '登录信息' : 'Sign-in input')} value={loginInput} onChange={(event) => setLoginInput(event.target.value)} /> : null}
          {step.kind !== 'awaiting' ? <Button variant="primary" onClick={() => void advanceLogin()}>{zh ? '已完成授权' : 'Continue sign-in'}</Button> : <span>{zh ? '正在等待 GitHub 授权…' : 'Waiting for GitHub authorization…'}</span>}
        </div>
      ) : null}
      {catalog?.account?.authenticated ? <section className="codex-available-models"><strong>{zh ? '当前可用模型' : 'Available models'} · {availableModels.length}</strong><ul>{availableModels.map((model) => <li key={model.id}>{model.name || model.id}</li>)}</ul></section> : null}
      {catalog?.account?.authenticated && accountQuotas.length > 0 ? (
        <section className="codex-available-models" aria-label={zh ? 'Copilot 官方额度' : 'Official Copilot quota'}>
          <strong>{zh ? '官方额度' : 'Official quota'}</strong>
          <ul>{accountQuotas.map((quota) => <li key={`${quota.service ?? ''}:${quota.quotaId}`}>{quota.service ?? quota.quotaId}：{quota.entitledQuantity === -1 ? (zh ? '不限量' : 'Unlimited') : quota.availableQuantity === null ? '—' : `${quota.availableQuantity} / ${quota.entitledQuantity ?? '—'} ${quota.unit}`}</li>)}</ul>
        </section>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
