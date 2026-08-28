import { useEffect, useState } from 'react';
import type { SaveZentaoInstanceRequest, ZentaoInstanceRecord, ZentaoInstanceVerifyResult } from '@zeus/shared';
import type { DashboardClient } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { formatVisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

interface ZentaoInstanceDraft {
  id: string | null;
  baseUrl: string;
  account: string;
  password: string;
}

type ZentaoClient = Pick<DashboardClient, 'loadZentaoInstances' | 'createZentaoInstance' | 'updateZentaoInstance' | 'deleteZentaoInstance' | 'clearZentaoInstancePassword' | 'verifyZentaoInstance'>;

export function ZentaoSettingsPane(props: { language: 'zh-CN' | 'en-US'; client: ZentaoClient | null }) {
  const zh = props.language === 'zh-CN';
  const [instances, setInstances] = useState<ZentaoInstanceRecord[]>([]);
  const [draft, setDraft] = useState<ZentaoInstanceDraft>(() => emptyDraft());
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'deleting' | 'verifying'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let active = true;
    if (!props.client) {
      setStatus('idle');
      return () => {
        active = false;
      };
    }
    void props.client
      .loadZentaoInstances()
      .then((items) => {
        if (!active) return;
        setInstances(items);
        setStatus('idle');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
        setStatus('idle');
      });
    return () => {
      active = false;
    };
  }, [props.client]);

  const busy = status !== 'idle';
  const current = draft.id ? (instances.find((instance) => instance.id === draft.id) ?? null) : null;

  function selectInstance(instance: ZentaoInstanceRecord): void {
    setDraft({ id: instance.id, baseUrl: `${instance.host}${instance.basePath}`, account: instance.account, password: '' });
    setConfirmDelete(false);
    setMessage(null);
  }

  async function reloadInstances(preferredId?: string): Promise<void> {
    if (!props.client) return;
    const items = await props.client.loadZentaoInstances();
    setInstances(items);
    const selected = items.find((instance) => instance.id === preferredId);
    if (selected) setDraft({ id: selected.id, baseUrl: `${selected.host}${selected.basePath}`, account: selected.account, password: '' });
  }

  function buildSaveInput(): SaveZentaoInstanceRequest {
    return {
      baseUrl: draft.baseUrl,
      account: draft.account,
      ...(draft.password.trim() ? { password: draft.password } : {}),
    };
  }

  async function save(): Promise<void> {
    if (!props.client || busy) return;
    setStatus('saving');
    setMessage(null);
    try {
      const input = buildSaveInput();
      const saved = draft.id ? await props.client.updateZentaoInstance(draft.id, input) : await props.client.createZentaoInstance(input);
      await reloadInstances(saved.id);
      setMessage(input.password ? (zh ? '禅道实例已保存，密码只写入 macOS 钥匙串。' : 'ZenTao instance saved. The password is stored only in the macOS Keychain.') : zh ? '禅道实例已保存。' : 'ZenTao instance saved.');
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  async function verify(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setStatus('verifying');
    setMessage(null);
    try {
      const result: ZentaoInstanceVerifyResult = await props.client.verifyZentaoInstance(draft.id);
      setMessage(`${result.ok ? (zh ? '验证通过：' : 'Verified: ') : ''}${result.message}`);
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  async function clearPassword(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setStatus('saving');
    try {
      await props.client.clearZentaoInstancePassword(draft.id);
      await reloadInstances(draft.id);
      setMessage(zh ? '密码已从钥匙串清除，解析将回退为浏览器登录。' : 'Password cleared from Keychain. Parsing will fall back to browser sign-in.');
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  async function removeInstance(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setStatus('deleting');
    try {
      await props.client.deleteZentaoInstance(draft.id);
      const items = await props.client.loadZentaoInstances();
      setInstances(items);
      setDraft(emptyDraft());
      setConfirmDelete(false);
      setMessage(zh ? '禅道实例已删除。' : 'ZenTao instance deleted.');
    } catch (error) {
      setMessage(formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en'));
    } finally {
      setStatus('idle');
    }
  }

  return (
    <section className="settings-product-pane model-connections-settings" aria-label={zh ? '禅道实例' : 'ZenTao instances'}>
      <header className="settings-section-heading model-connections-heading">
        <span>
          <strong>{zh ? '禅道实例' : 'ZenTao instances'}</strong>
          <small>
            {zh
              ? '配置实例后，粘贴禅道链接会优先通过 REST 接口解析并自动填入任务信息；密码只保存到本机钥匙串。'
              : 'After configuring an instance, pasted ZenTao links are parsed through the REST API first and filled into tasks automatically. Passwords stay in the local Keychain.'}
          </small>
        </span>
        <Button variant="secondary" size="compact" onClick={() => setDraft(emptyDraft())} disabled={busy}>
          {zh ? '新建实例' : 'New instance'}
        </Button>
      </header>

      <div className="model-connections-layout">
        <nav className="model-connection-list" aria-label={zh ? '禅道实例列表' : 'ZenTao instance list'}>
          {instances.length === 0 ? <p>{zh ? '还没有禅道实例。' : 'No ZenTao instances yet.'}</p> : null}
          {instances.map((instance) => (
            <button key={instance.id} type="button" className={draft.id === instance.id ? 'selected' : ''} aria-current={draft.id === instance.id ? 'true' : undefined} onClick={() => selectInstance(instance)}>
              <span>
                <strong>{instance.host}</strong>
                <small>{instance.account || (zh ? '未配置账号' : 'No account')}</small>
              </span>
              <em data-configured={instance.passwordConfigured || undefined}>{instance.passwordConfigured ? (zh ? '密码已保存' : 'Password saved') : zh ? '未配置密码' : 'No password'}</em>
            </button>
          ))}
        </nav>

        <section className="model-connection-editor" aria-label={zh ? '禅道实例编辑器' : 'ZenTao instance editor'}>
          <div className="model-connection-field-grid">
            <label className="model-connection-wide-field">
              <span>{zh ? '实例地址' : 'Instance URL'}</span>
              <input
                value={draft.baseUrl}
                placeholder="https://zentao.example.com/zentao/"
                onChange={(event) => {
                  const baseUrl = event.currentTarget.value;
                  setDraft((value) => ({ ...value, baseUrl }));
                }}
              />
            </label>
            <label>
              <span>{zh ? '账号' : 'Account'}</span>
              <input
                autoComplete="off"
                value={draft.account}
                onChange={(event) => {
                  const account = event.currentTarget.value;
                  setDraft((value) => ({ ...value, account }));
                }}
              />
            </label>
            <label>
              <span>{current?.passwordConfigured ? (zh ? '替换密码' : 'Replace password') : zh ? '密码' : 'Password'}</span>
              <input
                type="password"
                autoComplete="off"
                value={draft.password}
                disabled={!draft.account.trim()}
                onChange={(event) => {
                  const password = event.currentTarget.value;
                  setDraft((value) => ({ ...value, password }));
                }}
              />
            </label>
          </div>

          <footer className="model-connection-actions">
            <Button variant="primary" size="compact" onClick={() => void save()} disabled={busy || !draft.baseUrl.trim()}>
              {zh ? '保存实例' : 'Save instance'}
            </Button>
            {draft.id ? (
              <Button variant="secondary" size="compact" onClick={() => void verify()} disabled={busy} busy={status === 'verifying'}>
                {zh ? '验证登录' : 'Verify sign-in'}
              </Button>
            ) : null}
            {draft.id && current?.passwordConfigured ? (
              <Button variant="secondary" size="compact" onClick={() => void clearPassword()} disabled={busy}>
                {zh ? '清除密码' : 'Clear password'}
              </Button>
            ) : null}
            {draft.id && !confirmDelete ? (
              <Button variant="secondary" size="compact" onClick={() => setConfirmDelete(true)} disabled={busy}>
                {zh ? '删除实例' : 'Delete instance'}
              </Button>
            ) : null}
          </footer>

          {draft.id && confirmDelete ? (
            <div className="model-connection-enabled" role="alert">
              <span>{zh ? '删除后会失去该实例配置，任务解析将回退为浏览器登录或手动填写。' : 'Deleting removes this instance configuration; task parsing falls back to browser sign-in or manual entry.'}</span>
              <Button variant="primary" size="compact" onClick={() => void removeInstance()} disabled={busy} busy={status === 'deleting'}>
                {zh ? '确认删除' : 'Confirm delete'}
              </Button>
              <Button variant="secondary" size="compact" onClick={() => setConfirmDelete(false)} disabled={busy}>
                {zh ? '取消' : 'Cancel'}
              </Button>
            </div>
          ) : null}

          {message ? (
            <p className="model-connection-message" role="status">
              {message}
            </p>
          ) : null}
        </section>
      </div>
    </section>
  );
}

function emptyDraft(): ZentaoInstanceDraft {
  return { id: null, baseUrl: '', account: '', password: '' };
}
