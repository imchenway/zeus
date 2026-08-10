import { useEffect, useState, type ReactNode } from 'react';
import type { ZeusBrowserSettings } from '@zeus/shared';
import { Button } from '../ui/Button.js';

interface BrowserSettingsPaneProps {
  language: 'zh-CN' | 'en-US';
}
const copy = {
  'zh-CN': {
    title: '内置浏览器',
    intro: '使用独立、持久的本机浏览器 Profile；登录态在 Zeus 会话间共享，但不会与 Chrome 共享。',
    unavailable: '当前环境没有可用的内置浏览器设置桥接。',
    loading: '正在读取浏览器设置…',
    enabled: '启用内置浏览器',
    enabledHelp: '允许会话打开浏览器标签、批注页面，并向 Codex 暴露受控浏览器工具。',
    webLinks: '普通网页默认打开方式',
    webLinksHelp: '控制会话中的 HTTPS 链接和网站卡主操作。',
    localWeb: '本地网页默认打开方式',
    localWebHelp: '单独控制项目内 HTML 和 localhost 链接。',
    files: '文件引用默认打开方式',
    filesHelp: '控制会话中的源码引用和本地文件主操作；目标不可用时会安全回退。',
    zeusBrowser: 'Zeus 内置浏览器',
    externalBrowser: '系统默认浏览器',
    zeusPreview: 'Zeus 预览',
    systemDefault: '系统默认应用',
    screenshots: '批注截图',
    screenshotsHelp: '“始终”会为每条批注附图；“必要时”只为区域或 Adjust 变更附图。',
    always: '始终',
    necessary: '必要时',
    downloads: '下载目录',
    downloadsHelp: '默认保存在 Zeus 私有资料目录，不会申请系统“下载”文件夹权限；改为其他受保护目录后，保存设置时可能由 macOS 询问。',
    askWhere: '每次询问保存位置',
    askWhereHelp: '开启后，下载开始前显示本机保存对话框。',
    allSites: '允许 Agent 访问所有站点',
    allSitesHelp: '关闭时，每个站点首次由 Agent 读取或操作都需要确认；敏感动作始终另行确认。',
    fullCdp: '完整 CDP',
    fullCdpHelp: '允许 Agent 请求任意 Chrome DevTools Protocol 方法；每次调用仍需明确确认。',
    save: '保存浏览器设置',
    saved: '浏览器设置已保存。',
    clear: '清除浏览器数据',
    clearHelp: '清除 Cookie、缓存、站点存储、站点授权和页面批注，并把现有标签重置为空白页。',
    cleared: '浏览器数据已清除。',
    clearConfirm: '将清除独立浏览器 Profile 中的登录态、站点数据、授权和批注。此操作不可撤销，确定继续吗？',
    allSitesConfirm: '允许所有站点后，Agent 不再逐站点询问即可读取和操作页面；敏感动作仍会单独确认。确定继续吗？',
    cdpConfirm: '完整 CDP 可绕过常规浏览器工具的能力边界并读取或修改页面。每次调用仍会确认。确定启用吗？',
    saveFailed: '保存浏览器设置失败。',
    clearFailed: '清除浏览器数据失败。',
  },
  'en-US': {
    title: 'Built-in browser',
    intro: 'Uses an independent, persistent local browser profile. Sign-in state is shared across Zeus sessions, but not with Chrome.',
    unavailable: 'The built-in browser settings bridge is unavailable in this environment.',
    loading: 'Loading browser settings…',
    enabled: 'Enable built-in browser',
    enabledHelp: 'Lets sessions open browser tabs, annotate pages, and expose guarded browser tools to Codex.',
    webLinks: 'Default for web links',
    webLinksHelp: 'Controls the primary action for HTTPS links and website cards in conversations.',
    localWeb: 'Default for local websites',
    localWebHelp: 'Controls project HTML and localhost links separately.',
    files: 'Default for file references',
    filesHelp: 'Controls source citations and local-file primary actions, with safe fallback when unavailable.',
    zeusBrowser: 'Zeus built-in browser',
    externalBrowser: 'System default browser',
    zeusPreview: 'Zeus preview',
    systemDefault: 'System default app',
    screenshots: 'Comment screenshots',
    screenshotsHelp: 'Always attaches an image to each comment. Necessary only captures regions and Adjust changes.',
    always: 'Always',
    necessary: 'When necessary',
    downloads: 'Download directory',
    downloadsHelp: 'The default Zeus-managed folder does not require access to the system Downloads folder. macOS may ask when you save another protected folder.',
    askWhere: 'Ask where to save each file',
    askWhereHelp: 'Shows a native save dialog before a download starts.',
    allSites: 'Allow Agent access to all sites',
    allSitesHelp: 'When off, the Agent must ask before first reading or operating each site. Sensitive actions always ask.',
    fullCdp: 'Full CDP',
    fullCdpHelp: 'Lets the Agent request arbitrary Chrome DevTools Protocol methods. Every call still requires explicit approval.',
    save: 'Save browser settings',
    saved: 'Browser settings saved.',
    clear: 'Clear browser data',
    clearHelp: 'Clears cookies, cache, site storage, site grants, and page comments, then resets open tabs to blank pages.',
    cleared: 'Browser data cleared.',
    clearConfirm: 'This clears sign-in state, site data, grants, and comments from the independent browser profile. It cannot be undone. Continue?',
    allSitesConfirm: 'Allowing all sites lets the Agent read and operate pages without per-site prompts. Sensitive actions still ask. Continue?',
    cdpConfirm: 'Full CDP can bypass the normal browser-tool boundary to inspect or modify a page. Every call still asks. Enable it?',
    saveFailed: 'Browser settings could not be saved.',
    clearFailed: 'Browser data could not be cleared.',
  },
} as const;

export function BrowserSettingsPane(props: BrowserSettingsPaneProps) {
  const labels = copy[props.language];
  const [settings, setSettings] = useState<ZeusBrowserSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const bridge = window.zeus;
    if (!bridge?.getBrowserSettings) {
      setError(labels.unavailable);
      return;
    }
    void bridge
      .getBrowserSettings()
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : labels.unavailable);
      });
    return () => {
      active = false;
    };
  }, [labels.unavailable]);

  function setBoolean(key: 'enabled' | 'askWhereToSave' | 'allowAgentAllSites' | 'fullCdpEnabled', value: boolean): void {
    if (!settings) return;
    if (value && key === 'allowAgentAllSites' && !window.confirm(labels.allSitesConfirm)) return;
    if (value && key === 'fullCdpEnabled' && !window.confirm(labels.cdpConfirm)) return;
    setSettings({ ...settings, [key]: value });
    setStatus(null);
    setError(null);
  }

  async function save(): Promise<void> {
    if (!settings || !window.zeus?.updateBrowserSettings) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      setSettings(await window.zeus.updateBrowserSettings(settings));
      setStatus(labels.saved);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    if (!window.zeus?.clearBrowserData || !window.zeus.getBrowserSettings || !window.confirm(labels.clearConfirm)) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await window.zeus.clearBrowserData();
      setSettings(await window.zeus.getBrowserSettings());
      setStatus(labels.cleared);
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : labels.clearFailed);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <section className="settings-product-pane browser-settings-product-pane" aria-label={labels.title}>
        <h2 className="settings-page-title">{labels.title}</h2>
        <p className="browser-settings-status" role={error ? 'alert' : 'status'}>
          {error ?? labels.loading}
        </p>
      </section>
    );
  }

  return (
    <section className="settings-product-pane browser-settings-product-pane" aria-label={labels.title}>
      <h2 className="settings-page-title">{labels.title}</h2>
      <p className="browser-settings-intro">{labels.intro}</p>
      <section className="native-settings-pane browser-settings-pane" aria-label={labels.title}>
        <BrowserSettingRow title={labels.enabled} description={labels.enabledHelp}>
          <BrowserSwitch label={labels.enabled} checked={settings.enabled} disabled={busy} onChange={(checked) => setBoolean('enabled', checked)} />
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.webLinks} description={labels.webLinksHelp}>
          <select
            aria-label={labels.webLinks}
            value={settings.webLinkOpenTarget}
            disabled={busy}
            onChange={(event) =>
              setSettings({
                ...settings,
                webLinkOpenTarget: event.currentTarget.value as ZeusBrowserSettings['webLinkOpenTarget'],
              })
            }
          >
            <option value="zeus_browser">{labels.zeusBrowser}</option>
            <option value="system_default">{labels.externalBrowser}</option>
          </select>
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.localWeb} description={labels.localWebHelp}>
          <select
            aria-label={labels.localWeb}
            value={settings.localWebOpenTarget}
            disabled={busy}
            onChange={(event) =>
              setSettings({
                ...settings,
                localWebOpenTarget: event.currentTarget.value as ZeusBrowserSettings['localWebOpenTarget'],
              })
            }
          >
            <option value="zeus_browser">{labels.zeusBrowser}</option>
            <option value="system_default">{labels.externalBrowser}</option>
          </select>
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.files} description={labels.filesHelp}>
          <select
            aria-label={labels.files}
            value={settings.fileOpenTarget}
            disabled={busy}
            onChange={(event) =>
              setSettings({
                ...settings,
                fileOpenTarget: event.currentTarget.value as ZeusBrowserSettings['fileOpenTarget'],
              })
            }
          >
            <option value="zeus_source">{labels.zeusPreview}</option>
            <option value="system_default">{labels.systemDefault}</option>
            <option value="editor:vscode">Visual Studio Code</option>
            <option value="editor:vscode-insiders">Visual Studio Code - Insiders</option>
            <option value="editor:cursor">Cursor</option>
            <option value="editor:windsurf">Windsurf</option>
          </select>
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.screenshots} description={labels.screenshotsHelp}>
          <select aria-label={labels.screenshots} value={settings.screenshotMode} disabled={busy} onChange={(event) => setSettings({ ...settings, screenshotMode: event.currentTarget.value as ZeusBrowserSettings['screenshotMode'] })}>
            <option value="always">{labels.always}</option>
            <option value="necessary">{labels.necessary}</option>
          </select>
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.downloads} description={labels.downloadsHelp}>
          <input aria-label={labels.downloads} value={settings.downloadDirectory} disabled={busy} onChange={(event) => setSettings({ ...settings, downloadDirectory: event.currentTarget.value })} />
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.askWhere} description={labels.askWhereHelp}>
          <BrowserSwitch label={labels.askWhere} checked={settings.askWhereToSave} disabled={busy} onChange={(checked) => setBoolean('askWhereToSave', checked)} />
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.allSites} description={labels.allSitesHelp} danger>
          <BrowserSwitch label={labels.allSites} checked={settings.allowAgentAllSites} disabled={busy} onChange={(checked) => setBoolean('allowAgentAllSites', checked)} />
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.fullCdp} description={labels.fullCdpHelp} danger>
          <BrowserSwitch label={labels.fullCdp} checked={settings.fullCdpEnabled} disabled={busy} onChange={(checked) => setBoolean('fullCdpEnabled', checked)} />
        </BrowserSettingRow>
        <div className="browser-settings-actions">
          <Button variant="secondary" size="compact" onClick={() => void save()} busy={busy}>
            {labels.save}
          </Button>
          <Button variant="danger" size="compact" onClick={() => void clear()} busy={busy}>
            {labels.clear}
          </Button>
        </div>
      </section>
      <p className={`browser-settings-status ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
        {error ?? status}
      </p>
      <p className="browser-settings-clear-help">{labels.clearHelp}</p>
    </section>
  );
}

function BrowserSettingRow(props: { title: string; description: string; children: ReactNode; danger?: boolean }) {
  return (
    <div className={`native-control-row browser-settings-row ${props.danger ? 'danger' : ''}`}>
      <span className="native-control-copy">
        <strong>{props.title}</strong>
        <span className="native-control-description">{props.description}</span>
      </span>
      <span className="native-control-slot">{props.children}</span>
    </div>
  );
}

function BrowserSwitch(props: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <span className="settings-switch-state">
      <input className="native-switch-input" aria-label={props.label} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.currentTarget.checked)} />
      <span className="native-switch-track" aria-hidden="true" />
    </span>
  );
}
