import { useEffect, useState } from 'react';
import type { ZeusBrowserPasswordAccount, ZeusBrowserPasswordImportPreview } from '@zeus/shared';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

/** 密码设置只显示账号和来源行，不向 Renderer 请求密码或密钥。 */
export function BrowserPasswordsSection({ language }: { language: 'zh-CN' | 'en-US' }) {
  /** 中英文共用相同的导入、冲突确认和删除行为。 */
  const zh = language === 'zh-CN';
  const [accounts, setAccounts] = useState<ZeusBrowserPasswordAccount[] | null>(null);
  const [preview, setPreview] = useState<ZeusBrowserPasswordImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let active = true;
    if (!window.zeus?.listBrowserPasswords) {
      setError(zh ? '密码管理在当前宿主不可用。' : 'Password management is unavailable in this host.');
      return;
    }
    void window.zeus
      .listBrowserPasswords()
      .then((items) => {
        if (active) setAccounts(items);
      })
      .catch((failure) => {
        if (active) setError(failure);
      });
    return () => {
      active = false;
    };
  }, [zh]);

  useEffect(
    () => () => {
      if (preview) void window.zeus?.cancelBrowserPasswordImport(preview.token).catch(() => undefined);
    },
    [preview?.token],
  );

  /** 串行处理当前设置操作，失败时保留已有列表及冲突选择以便重试。 */
  async function run(operation: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus('');
    try {
      await operation();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  /** 原生文件选择结束后只接收主进程提供的预览。 */
  async function prepare(): Promise<void> {
    await run(async () => {
      const value = await window.zeus!.prepareBrowserPasswordImport();
      if (!value) return;
      setChoices({});
      setPreview(value);
    });
  }

  /** 完成增量导入后重新读取权威账号列表，失败时保留回执或预览。 */
  async function commit(): Promise<void> {
    if (!preview) return;
    await run(async () => {
      const result = await window.zeus!.commitBrowserPasswordImport({ token: preview.token, choices });
      setPreview(null);
      setStatus(
        zh
          ? `新增 ${result.added} 个账号，更新 ${result.updated} 个账号，跳过 ${result.skipped} 条记录，无效 ${result.invalid} 条。`
          : `Added ${result.added} accounts, updated ${result.updated} accounts, skipped ${result.skipped} records, invalid ${result.invalid}.`,
      );
      setAccounts(await window.zeus!.listBrowserPasswords());
    });
  }

  /** 取消确认并释放主进程中尚未导入的明文候选。 */
  async function cancel(): Promise<void> {
    if (!preview) return;
    await run(async () => {
      await window.zeus!.cancelBrowserPasswordImport(preview.token);
      setPreview(null);
    });
  }

  /** 删除必须确认具体账号，不改变其他账号或浏览器登录态。 */
  async function remove(account: ZeusBrowserPasswordAccount): Promise<void> {
    if (!window.confirm(zh ? `删除 ${account.origin} 的账号“${account.username || '无用户名'}”及其密码？` : `Delete the saved password for “${account.username || 'No username'}” at ${account.origin}?`)) return;
    await run(async () => {
      await window.zeus!.deleteBrowserPassword(account.id);
      setAccounts(await window.zeus!.listBrowserPasswords());
    });
  }

  return (
    <section className="settings-product-section browser-password-section" aria-labelledby="browser-password-heading">
      <header className="browser-password-heading">
        <h3 id="browser-password-heading">{zh ? '密码' : 'Passwords'}</h3>
        <Button size="compact" disabled={busy || (accounts === null && !error)} onClick={() => (accounts === null ? run(async () => setAccounts(await window.zeus!.listBrowserPasswords())) : prepare())}>
          {accounts === null && error ? (zh ? '重试读取' : 'Retry') : zh ? '导入 Chrome CSV' : 'Import Chrome CSV'}
        </Button>
      </header>
      {error ? (
        <div role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        </div>
      ) : null}
      {status ? (
        <p className="browser-settings-status" role="status">
          {status}
        </p>
      ) : null}
      {preview ? (
        <section className="browser-password-import" aria-label={zh ? '确认密码导入' : 'Confirm password import'} aria-busy={busy}>
          <strong className="browser-password-file">{preview.fileName}</strong>
          <p className="browser-settings-status">
            {zh
              ? `新增 ${preview.added} · 相同 ${preview.unchanged} · 冲突 ${preview.conflicts.length} · 无效 ${preview.invalidRows.length}`
              : `New ${preview.added} · Unchanged ${preview.unchanged} · Conflicts ${preview.conflicts.length} · Invalid ${preview.invalidRows.length}`}
          </p>
          {preview.conflicts.length ? (
            <ul className="browser-password-list">
              {preview.conflicts.map((conflict) => (
                <li key={conflict.id} className="browser-password-row">
                  <span className="browser-password-account">
                    <strong>{conflict.origin}</strong>
                    <span>{conflict.username || (zh ? '无用户名' : 'No username')}</span>
                  </span>
                  <ZeusSelect
                    size="regular"
                    ariaLabel={`${conflict.origin} ${conflict.username} ${zh ? '密码冲突' : 'password conflict'}`}
                    disabled={busy}
                    value={String(choices[conflict.id] ?? 0)}
                    onChange={(value) => setChoices((current) => ({ ...current, [conflict.id]: Number(value) }))}
                    options={[
                      { value: '0', label: conflict.hasExisting ? (zh ? '保留已有密码' : 'Keep saved password') : zh ? '跳过此账号' : 'Skip this account' },
                      ...conflict.rows.map((row) => ({ value: String(row), label: zh ? `使用 CSV 第 ${row} 条记录` : `Use CSV record ${row}` })),
                    ]}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {preview.invalidRows.length ? (
            <ul className="browser-password-invalid">
              {preview.invalidRows.map((row) => (
                <li key={row.row}>
                  {zh ? `记录 ${row.row}` : `Record ${row.row}`} · {row.reason}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="browser-password-actions">
            <Button size="compact" disabled={busy} onClick={() => cancel()}>
              {zh ? '取消' : 'Cancel'}
            </Button>
            <Button size="compact" variant="primary" busy={busy} onClick={() => commit()}>
              {zh ? '确认导入' : 'Import'}
            </Button>
          </div>
        </section>
      ) : null}
      {accounts?.length ? (
        <ul className="browser-password-list" aria-label={zh ? '已保存的账号' : 'Saved accounts'}>
          {accounts.map((account) => (
            <li key={account.id} className="browser-password-row">
              <span className="browser-password-account">
                <strong>{account.origin}</strong>
                <span>{account.username || (zh ? '无用户名' : 'No username')}</span>
              </span>
              <Button
                size="compact"
                variant="danger"
                disabled={busy || Boolean(preview)}
                aria-label={zh ? `删除 ${account.origin} 的 ${account.username || '无用户名'} 账号` : `Delete ${account.username || 'No username'} at ${account.origin}`}
                onClick={() => remove(account)}
              >
                {zh ? '删除' : 'Delete'}
              </Button>
            </li>
          ))}
        </ul>
      ) : accounts === null && !error ? (
        <p className="browser-settings-status" role="status">
          {zh ? '正在读取密码…' : 'Loading passwords…'}
        </p>
      ) : accounts !== null ? (
        <p className="browser-settings-status">{zh ? '尚未保存密码' : 'No saved passwords'}</p>
      ) : null}
    </section>
  );
}
