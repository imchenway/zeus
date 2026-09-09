import { SettingsSaveStatus, type SettingsSaveState } from './useSettingsAutosave.js';
import { useEffect, useRef, useState } from 'react';
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { EyeSlashIcon } from '@phosphor-icons/react/dist/csr/EyeSlash';
import type { SaveZentaoInstanceRequest, ZentaoInstanceRecord, ZentaoInstanceVerifyResult } from '@zeus/shared';
import type { DashboardClient } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { reportApplicationError } from '../ui/ApplicationErrorDialog.js';

interface ZentaoInstanceDraft {
  id: string | null;
  baseUrl: string;
  account: string;
  password: string;
}

/** 实例编辑器只使用集成接口；密码读取必须由查看按钮触发。 */
type ZentaoClient = Pick<DashboardClient, 'loadZentaoInstances' | 'createZentaoInstance' | 'updateZentaoInstance' | 'deleteZentaoInstance' | 'clearZentaoInstancePassword' | 'verifyZentaoInstance' | 'revealZentaoInstancePassword'>;

export function ZentaoSettingsPane(props: { language: 'zh-CN' | 'en-US'; client: ZentaoClient | null }) {
  const zh = props.language === 'zh-CN';
  const [instances, setInstances] = useState<ZentaoInstanceRecord[]>([]);
  const [draft, setDraft] = useState<ZentaoInstanceDraft>(() => emptyDraft());
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'deleting' | 'verifying' | 'revealing'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  /** 保存结果与验证、删除反馈分别显示。 */
  const [saveState, setSaveState] = useState<SettingsSaveState>('idle');
  /** 保存指纹不包含钥匙串读取的密码。 */
  const savedDraft = useRef('');
  /** 防止失焦与点击在同一帧重复创建。 */
  const savingRef = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 保存过的密码与替换草稿分开，查看不会导致密码再次写入。 */
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  /** 页面默认遮挡密码，切换实例和保存后恢复遮挡。 */
  const [passwordVisible, setPasswordVisible] = useState(false);
  /** 页面离开或切换实例后丢弃迟到的密码响应。 */
  const passwordRequest = useRef(0);

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
        if (items[0]) selectInstance(items[0]);
        setStatus('idle');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
        setStatus('idle');
      });
    return () => {
      active = false;
      passwordRequest.current += 1;
    };
  }, [props.client]);

  const busy = status !== 'idle';
  const current = draft.id ? (instances.find((instance) => instance.id === draft.id) ?? null) : null;

  /** 选中实例即填入公开账号；密码保持空草稿并只显示遮挡提示。 */
  function selectInstance(instance: ZentaoInstanceRecord): void {
    hidePassword();
    /** 记录真实回读值用于跳过未修改的输入。 */
    const next = { id: instance.id, baseUrl: `${instance.host}${instance.basePath}`, account: instance.account, password: '' };
    savedDraft.current = JSON.stringify(next);
    setDraft(next);
    setSaveState('idle');
    setConfirmDelete(false);
    setMessage(null);
  }

  /** 隐藏时清除从钥匙串读取的副本，不清除用户正在输入的替换草稿。 */
  function hidePassword(): void {
    passwordRequest.current += 1;
    setRevealedPassword(null);
    setPasswordVisible(false);
  }

  /** 主动查看才读取已保存密码，密码不进入消息或错误详情。 */
  async function togglePassword(): Promise<void> {
    if (passwordVisible) {
      hidePassword();
      return;
    }
    if (draft.password || !current?.passwordConfigured) {
      setPasswordVisible(true);
      return;
    }
    if (!props.client || !draft.id || busy) return;
    /** 绑定本次请求与当前编辑器。 */
    const request = ++passwordRequest.current;
    setStatus('revealing');
    try {
      /** 返回值仅保留在当前组件状态。 */
      const result = await props.client.revealZentaoInstancePassword(draft.id);
      if (request !== passwordRequest.current) return;
      setRevealedPassword(result.password);
      setPasswordVisible(true);
      if (result.password === null) setMessage(zh ? '当前实例未保存密码。' : 'No password is saved for this instance.');
    } catch (error) {
      if (request === passwordRequest.current) setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
    } finally {
      if (request === passwordRequest.current) setStatus('idle');
    }
  }

  async function reloadInstances(preferredId?: string): Promise<void> {
    if (!props.client) return;
    const items = await props.client.loadZentaoInstances();
    setInstances(items);
    const selected = items.find((instance) => instance.id === preferredId);
    if (selected) selectInstance(selected);
  }

  function buildSaveInput(): SaveZentaoInstanceRequest {
    return {
      baseUrl: draft.baseUrl,
      account: draft.account,
      ...(draft.password.trim() ? { password: draft.password } : {}),
    };
  }

  async function save(): Promise<void> {
    if (!props.client || busy || savingRef.current || savedDraft.current === JSON.stringify(draft)) return;
    savingRef.current = true;
    setSaveState('saving');
    setStatus('saving');
    setMessage(null);
    try {
      const input = buildSaveInput();
      const saved = draft.id ? await props.client.updateZentaoInstance(draft.id, input) : await props.client.createZentaoInstance(input);
      await reloadInstances(saved.id);
      setSaveState('saved');
    } catch (error) {
      setSaveState('failed');
      setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
    } finally {
      savingRef.current = false;
      setStatus('idle');
    }
  }

  async function verify(): Promise<void> {
    if (!props.client || !draft.id || busy) return;
    setStatus('verifying');
    setMessage(null);
    try {
      const result: ZentaoInstanceVerifyResult = await props.client.verifyZentaoInstance(draft.id);
      setMessage(
        result.ok
          ? zh
            ? '已通过禅道登录验证。'
            : 'ZenTao sign-in verified.'
          : reportApplicationError({ ...result, cause: result.cause ?? { code: `ZEUS_ZENTAO_${result.code.toUpperCase()}`, message: result.message } }, { language: zh ? 'zh-CN' : 'en' }),
      );
    } catch (error) {
      setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
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
      setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
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
      hidePassword();
      setDraft(emptyDraft());
      setConfirmDelete(false);
      setMessage(zh ? '禅道实例已删除。' : 'ZenTao instance deleted.');
    } catch (error) {
      setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
    } finally {
      setStatus('idle');
    }
  }

  return (
    <section className="settings-product-pane zentao-settings-pane" aria-label={zh ? '第三方接入' : 'Third-party integrations'}>
      <header className="settings-page-heading">
        <span>
          <h2 className="settings-page-title">{zh ? '第三方接入' : 'Third-party integrations'}</h2>
          <p>{zh ? '连接外部任务系统，自动读取链接中的任务信息。' : 'Connect task systems and read task information from links.'}</p>
        </span>
        <SettingsSaveStatus status={saveState} language={props.language} />
      </header>
      <header className="settings-section-heading model-connections-heading">
        <span>
          <strong>{zh ? '禅道实例' : 'ZenTao instances'}</strong>
          <small>
            {zh
              ? '配置实例后，粘贴禅道链接会优先通过 REST 接口解析并自动填入任务信息；密码只保存到本机钥匙串。'
              : 'After configuring an instance, pasted ZenTao links are parsed through the REST API first and filled into tasks automatically. Passwords stay in the local Keychain.'}
          </small>
        </span>
        <Button
          variant="secondary"
          size="compact"
          onClick={() => {
            hidePassword();
            setDraft(emptyDraft());
            setConfirmDelete(false);
            setMessage(null);
          }}
          disabled={busy}
        >
          {zh ? '新建实例' : 'New instance'}
        </Button>
      </header>

      <div className="model-connections-layout">
        <nav className="model-connection-list" aria-label={zh ? '禅道实例列表' : 'ZenTao instance list'}>
          {instances.length === 0 ? <p>{zh ? '还没有禅道实例。' : 'No ZenTao instances yet.'}</p> : null}
          {instances.map((instance) => (
            <button key={instance.id} type="button" className={draft.id === instance.id ? 'selected' : ''} aria-current={draft.id === instance.id ? 'true' : undefined} disabled={busy} onClick={() => selectInstance(instance)}>
              <span>
                <strong>{instance.host}</strong>
                <small>{instance.account || (zh ? '未配置账号' : 'No account')}</small>
              </span>
              <em data-configured={instance.passwordConfigured || undefined}>{instance.passwordConfigured ? (zh ? '密码已保存' : 'Password saved') : zh ? '未配置密码' : 'No password'}</em>
            </button>
          ))}
        </nav>

        <fieldset
          onInput={() => setSaveState('idle')}
          disabled={busy}
          onBlurCapture={(event) => {
            if (draft.id && event.target instanceof HTMLInputElement) void save();
          }}
          className="model-connection-editor"
          aria-label={zh ? '禅道实例编辑器' : 'ZenTao instance editor'}
        >
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
              <span className="settings-secret-control">
                <input
                  type={passwordVisible ? 'text' : 'password'}
                  autoComplete="off"
                  value={passwordVisible ? (revealedPassword ?? draft.password) : draft.password}
                  placeholder={current?.passwordConfigured ? '••••••••' : undefined}
                  disabled={!draft.account.trim()}
                  onChange={(event) => {
                    const password = event.currentTarget.value;
                    setRevealedPassword(null);
                    setDraft((value) => ({ ...value, password }));
                  }}
                />
                <Button
                  size="compact"
                  aria-label={passwordVisible ? (zh ? '隐藏密码' : 'Hide password') : zh ? '查看密码' : 'Show password'}
                  aria-pressed={passwordVisible}
                  disabled={!draft.account.trim() || busy}
                  busy={status === 'revealing'}
                  onClick={() => void togglePassword()}
                >
                  {passwordVisible ? <EyeSlashIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
                </Button>
              </span>
              {current?.passwordConfigured ? <small>{zh ? '已保存在钥匙串；输入新密码即可替换。' : 'Saved in Keychain; enter a new password to replace it.'}</small> : null}
            </label>
          </div>

          <footer className="model-connection-actions">
            {!draft.id || saveState === 'failed' ? (
              <Button variant="primary" size="compact" onClick={() => void save()} disabled={busy || !draft.baseUrl.trim()}>
                {draft.id ? (zh ? '重试保存' : 'Retry save') : zh ? '创建实例' : 'Create instance'}
              </Button>
            ) : null}
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
        </fieldset>
      </div>
    </section>
  );
}

function emptyDraft(): ZentaoInstanceDraft {
  return { id: null, baseUrl: '', account: '', password: '' };
}
