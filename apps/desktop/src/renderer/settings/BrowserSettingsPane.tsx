import { useEffect, useState, type ReactNode } from 'react';
import type { ZeusBrowserSettings, ZeusComputerSettings, ZeusRetiredNativeRuntimeState } from '@zeus/shared';
import { Button } from '../ui/Button.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';

interface BrowserSettingsPaneProps {
  language: 'zh-CN' | 'en-US';
}
const copy = {
  'zh-CN': {
    title: '内置浏览器',
    // 明确即时保存的开关与需要手动保存的其他输入。
    intro: 'Zeus 使用独立的浏览器资料。网站登录会在 Zeus 对话之间保留，但不与 Chrome 共享。开关修改后立即保存；其他设置请点击“保存浏览器设置”。',
    unavailable: '此处无法使用内置浏览器设置。',
    loading: '正在读取浏览器设置…',
    enabled: '启用内置浏览器',
    enabledHelp: '允许你在对话中打开和批注网页，并让 AI 按授权操作浏览器。',
    webLinks: '普通网页默认打开方式',
    webLinksHelp: '选择点击对话中的网页链接或网站卡片时使用的浏览器。',
    localWeb: '本地网页默认打开方式',
    localWebHelp: '单独控制项目内 HTML 和 localhost 链接。',
    files: '文件引用默认打开方式',
    filesHelp: '选择点击对话中的代码引用和本地文件时使用的应用。',
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
    allSites: '允许 AI 访问所有网站',
    allSitesHelp: '关闭时，每个站点首次由 Agent 读取或操作都需要确认；敏感动作始终另行确认。',
    fullCdp: '完整 CDP',
    fullCdpHelp: '允许 Agent 请求任意 Chrome DevTools Protocol 方法；每次调用仍需明确确认。',
    save: '保存浏览器设置',
    saved: '浏览器设置已保存。',
    // 单个开关保存不能暗示页面中的其他草稿也已保存。
    switchSaved: '开关设置已保存。',
    clear: '清除浏览器数据',
    clearHelp: '清除 Cookie、缓存、站点存储、站点授权和页面批注，并把现有标签重置为空白页。',
    cleared: '浏览器数据已清除。',
    clearConfirm: '将清除独立浏览器 Profile 中的登录态、站点数据、授权和批注。此操作不可撤销，确定继续吗？',
    allSitesConfirm: '允许所有站点后，Agent 不再逐站点询问即可读取和操作页面；敏感动作仍会单独确认。确定继续吗？',
    cdpConfirm: '完整 CDP 可绕过常规浏览器工具的能力边界并读取或修改页面。每次调用仍会确认。确定启用吗？',
    computerTitle: 'Computer Use',
    // 说明全局开关、系统权限和本轮启用分别需要完成。
    computerHelp: '启用并授予 macOS 辅助功能和录屏权限后，还需在发送消息前输入 / 并选择 Computer Use，为本轮允许 AI 操作其他应用。敏感操作会再次征求同意。',
    computerEnable: '启用 Computer Use',
    computerStop: '立即停止控制',
    computerAccessibility: '辅助功能',
    computerScreenCapture: '屏幕与系统音频录制',
    computerGranted: '已授权',
    computerMissing: '待授权',
    computerRequestPermissions: '申请或重新检查权限',
    computerOpenAccessibility: '打开辅助功能设置',
    computerOpenScreenCapture: '打开录屏设置',
    computerSettingsOpened: '已打开对应的 macOS 隐私设置；授权后请重新检查权限。',
    chromeEnable: '连接 Chrome 测试扩展',
    chromeHelp: '连接后，AI 可以在你授权的 Chrome 标签页中读取内容和操作页面。',
    edgeEnable: '连接 Edge 预览扩展',
    edgeHelp: '连接 Edge 浏览器，授权与 Chrome 分开管理。',
    retiredTitle: '旧版浏览器和电脑工具',
    retiredHelp: 'Zeus 已不再依赖 Codex Browser、Chrome、Computer Use 缓存或 Codex Computer Use.app。清理会把现有目录移入 Zeus 备份，不卸载插件，可随时恢复。',
    retiredArchive: '备份并移除旧工具',
    retiredRestore: '恢复最近归档',
    retiredArchiveConfirm: '将把检测到的旧 Browser/Computer 插件缓存与 Codex Computer Use.app 移入 Zeus 可恢复备份。不会卸载插件。确定继续吗？',
    retiredRestoreConfirm: '将恢复最近一次由 Zeus 归档的旧运行时；若原位置已有新内容会安全拒绝。确定继续吗？',
    retiredNone: '未检测到待归档旧运行时。',
    retiredArchived: '旧运行时已归档，可从最近备份恢复。',
    retiredRestored: '旧运行时已恢复。',
    saveFailed: '保存浏览器设置失败。',
    clearFailed: '清除浏览器数据失败。',
  },
  'en-US': {
    title: 'Built-in browser',
    // 英文说明保持相同的保存规则。
    intro: 'Zeus uses a separate browser profile. Website sign-ins persist across Zeus conversations but are not shared with Chrome. Switches save immediately; use “Save browser settings” for other changes.',
    unavailable: 'Built-in browser settings are unavailable here.',
    loading: 'Loading browser settings…',
    enabled: 'Enable built-in browser',
    enabledHelp: 'Open and annotate web pages in conversations, and let the AI use the browser with your permission.',
    webLinks: 'Default for web links',
    webLinksHelp: 'Choose the browser used when you open a web link or website card in a conversation.',
    localWeb: 'Default for local websites',
    localWebHelp: 'Controls project HTML and localhost links separately.',
    files: 'Default for file references',
    filesHelp: 'Choose the app used to open code references and local files in conversations.',
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
    allSites: 'Allow AI access to all websites',
    allSitesHelp: 'When off, the Agent must ask before first reading or operating each site. Sensitive actions always ask.',
    fullCdp: 'Full CDP',
    fullCdpHelp: 'Lets the Agent request arbitrary Chrome DevTools Protocol methods. Every call still requires explicit approval.',
    save: 'Save browser settings',
    saved: 'Browser settings saved.',
    // 只确认本次开关已经保存。
    switchSaved: 'Switch setting saved.',
    clear: 'Clear browser data',
    clearHelp: 'Clears cookies, cache, site storage, site grants, and page comments, then resets open tabs to blank pages.',
    cleared: 'Browser data cleared.',
    clearConfirm: 'This clears sign-in state, site data, grants, and comments from the independent browser profile. It cannot be undone. Continue?',
    allSitesConfirm: 'Allowing all sites lets the Agent read and operate pages without per-site prompts. Sensitive actions still ask. Continue?',
    cdpConfirm: 'Full CDP can bypass the normal browser-tool boundary to inspect or modify a page. Every call still asks. Enable it?',
    computerTitle: 'Computer Use',
    // 英文说明与中文保持相同的逐轮授权边界。
    computerHelp:
      'After enabling this and granting macOS Accessibility and Screen Recording permissions, type / and select Computer Use before sending a message to allow the AI to operate other apps for that turn. Sensitive actions will ask for approval again.',
    computerEnable: 'Enable Computer Use',
    computerStop: 'Stop control now',
    computerAccessibility: 'Accessibility',
    computerScreenCapture: 'Screen & System Audio Recording',
    computerGranted: 'Granted',
    computerMissing: 'Required',
    computerRequestPermissions: 'Request or recheck permissions',
    computerOpenAccessibility: 'Open Accessibility settings',
    computerOpenScreenCapture: 'Open Screen Recording settings',
    computerSettingsOpened: 'The matching macOS privacy settings are open. Recheck permissions after granting access.',
    chromeEnable: 'Connect Chrome test extension',
    chromeHelp: 'Once connected, the AI can read and operate Chrome tabs you authorize.',
    edgeEnable: 'Connect Edge preview extension',
    edgeHelp: 'Connect Edge with permissions managed separately from Chrome.',
    retiredTitle: 'Older browser and computer tools',
    retiredHelp: 'Zeus no longer depends on Codex Browser, Chrome, Computer Use caches, or Codex Computer Use.app. Cleanup moves existing directories into a Zeus backup without uninstalling plugins, and can be reversed.',
    retiredArchive: 'Back up and remove older tools',
    retiredRestore: 'Restore latest archive',
    retiredArchiveConfirm: 'Move detected Browser/Computer plugin caches and Codex Computer Use.app into a recoverable Zeus backup? Plugins will not be uninstalled.',
    retiredRestoreConfirm: 'Restore the latest Zeus archive? Restore safely fails if new content already exists at the original location.',
    retiredNone: 'No retired runtime is waiting to be archived.',
    retiredArchived: 'Retired runtimes were archived and remain recoverable.',
    retiredRestored: 'Retired runtimes were restored.',
    saveFailed: 'Browser settings could not be saved.',
    clearFailed: 'Browser data could not be cleared.',
  },
} as const;

export function BrowserSettingsPane(props: BrowserSettingsPaneProps) {
  const labels = copy[props.language];
  const [settings, setSettings] = useState<ZeusBrowserSettings | null>(null);
  const [computerSettings, setComputerSettings] = useState<ZeusComputerSettings | null>(null);
  const [retiredRuntimeState, setRetiredRuntimeState] = useState<ZeusRetiredNativeRuntimeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useApplicationErrorDialog(error, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
  });

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
        if (active) setError(loadError instanceof Error ? loadError : labels.unavailable);
      });
    if (bridge.getComputerSettings) {
      void bridge
        .getComputerSettings()
        .then((value) => {
          if (active) setComputerSettings(value);
        })
        .catch((loadError) => {
          if (active) setError(loadError instanceof Error ? loadError : labels.unavailable);
        });
    }
    if (bridge.getRetiredNativeRuntimeState) {
      void bridge
        .getRetiredNativeRuntimeState()
        .then((value) => {
          if (active) setRetiredRuntimeState(value);
        })
        .catch((loadError) => {
          if (active) setError(loadError instanceof Error ? loadError : labels.unavailable);
        });
    }
    return () => {
      active = false;
    };
  }, [labels.unavailable]);

  /** 开关直接保存单个字段，成功后更新显示，保留其他尚未保存的输入。 */
  async function setBoolean(key: 'enabled' | 'askWhereToSave' | 'allowAgentAllSites' | 'fullCdpEnabled' | 'externalChromeEnabled' | 'externalEdgeEnabled', value: boolean): Promise<void> {
    if (!settings || busy || !window.zeus?.updateBrowserSettings) return;
    if (value && key === 'allowAgentAllSites' && !window.confirm(labels.allSitesConfirm)) return;
    if (value && key === 'fullCdpEnabled' && !window.confirm(labels.cdpConfirm)) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      // 只提交点击的开关，避免顺带提交下载目录等草稿。
      const saved = await window.zeus.updateBrowserSettings({ [key]: value });
      setSettings((current) => (current ? { ...current, [key]: saved[key] } : current));
      setStatus(labels.switchSaved);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function setComputerEnabled(enabled: boolean): Promise<void> {
    if (!window.zeus?.updateComputerSettings) return;
    setBusy(true);
    setError(null);
    try {
      setComputerSettings(await window.zeus.updateComputerSettings({ enabled }));
    } catch (computerError) {
      setError(computerError);
    } finally {
      setBusy(false);
    }
  }

  async function stopComputer(): Promise<void> {
    if (!window.zeus?.stopComputerUse) return;
    setBusy(true);
    setError(null);
    try {
      setComputerSettings(await window.zeus.stopComputerUse());
    } catch (computerError) {
      setError(computerError);
    } finally {
      setBusy(false);
    }
  }

  async function requestComputerPermissions(): Promise<void> {
    if (!window.zeus?.requestComputerPermissions) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      setComputerSettings(await window.zeus.requestComputerPermissions());
    } catch (computerError) {
      setError(computerError);
    } finally {
      setBusy(false);
    }
  }

  async function openComputerPermissionSettings(permission: 'accessibility' | 'screen_capture'): Promise<void> {
    if (!window.zeus?.openComputerPermissionSettings) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await window.zeus.openComputerPermissionSettings({ permission });
      setStatus(labels.computerSettingsOpened);
    } catch (computerError) {
      setError(computerError);
    } finally {
      setBusy(false);
    }
  }

  async function archiveRetiredRuntimes(): Promise<void> {
    if (!window.zeus?.archiveRetiredNativeRuntimes || !window.confirm(labels.retiredArchiveConfirm)) return;
    setBusy(true);
    setError(null);
    try {
      setRetiredRuntimeState(await window.zeus.archiveRetiredNativeRuntimes());
      setStatus(labels.retiredArchived);
    } catch (archiveError) {
      setError(archiveError);
    } finally {
      setBusy(false);
    }
  }

  async function restoreRetiredRuntimes(): Promise<void> {
    if (!window.zeus?.restoreRetiredNativeRuntimes || !window.confirm(labels.retiredRestoreConfirm)) return;
    setBusy(true);
    setError(null);
    try {
      setRetiredRuntimeState(await window.zeus.restoreRetiredNativeRuntimes());
      setStatus(labels.retiredRestored);
    } catch (restoreError) {
      setError(restoreError);
    } finally {
      setBusy(false);
    }
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
      setError(saveError instanceof Error ? saveError : labels.saveFailed);
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
      setError(clearError instanceof Error ? clearError : labels.clearFailed);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <section className="settings-product-pane browser-settings-product-pane" aria-label={labels.title}>
        <h2 className="settings-page-title">{labels.title}</h2>
        <p className="browser-settings-status" role="status">
          {labels.loading}
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
          <BrowserSwitch label={labels.enabled} checked={settings.enabled} disabled={busy} onChange={(checked) => void setBoolean('enabled', checked)} />
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
          <BrowserSwitch label={labels.askWhere} checked={settings.askWhereToSave} disabled={busy} onChange={(checked) => void setBoolean('askWhereToSave', checked)} />
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.allSites} description={labels.allSitesHelp} danger>
          <BrowserSwitch label={labels.allSites} checked={settings.allowAgentAllSites} disabled={busy} onChange={(checked) => void setBoolean('allowAgentAllSites', checked)} />
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.fullCdp} description={labels.fullCdpHelp} danger>
          <BrowserSwitch label={labels.fullCdp} checked={settings.fullCdpEnabled} disabled={busy} onChange={(checked) => void setBoolean('fullCdpEnabled', checked)} />
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.chromeEnable} description={labels.chromeHelp}>
          <BrowserSwitch label={labels.chromeEnable} checked={settings.externalChromeEnabled} disabled={busy} onChange={(checked) => void setBoolean('externalChromeEnabled', checked)} />
        </BrowserSettingRow>
        <BrowserSettingRow title={labels.edgeEnable} description={labels.edgeHelp}>
          <BrowserSwitch label={labels.edgeEnable} checked={settings.externalEdgeEnabled} disabled={busy} onChange={(checked) => void setBoolean('externalEdgeEnabled', checked)} />
        </BrowserSettingRow>
        {computerSettings ? (
          <BrowserSettingRow title={labels.computerTitle} description={`${labels.computerHelp}${computerSettings.detail ? ` ${computerSettings.detail}` : ''}`} danger>
            <span className="computer-permission-panel">
              <span className="browser-settings-actions">
                <BrowserSwitch label={labels.computerEnable} checked={computerSettings.enabled} disabled={busy} onChange={(checked) => void setComputerEnabled(checked)} />
                <Button variant="danger" size="compact" onClick={() => void stopComputer()} busy={busy} disabled={!computerSettings.enabled && computerSettings.serviceState === 'disabled'}>
                  {labels.computerStop}
                </Button>
              </span>
              {computerSettings.enabled ? (
                <span className="computer-permission-details" role="status" aria-live="polite">
                  <span className={computerSettings.accessibilityTrusted ? 'granted' : 'missing'}>
                    {labels.computerAccessibility}：{computerSettings.accessibilityTrusted ? labels.computerGranted : labels.computerMissing}
                  </span>
                  <span className={computerSettings.screenCaptureAvailable ? 'granted' : 'missing'}>
                    {labels.computerScreenCapture}：{computerSettings.screenCaptureAvailable ? labels.computerGranted : labels.computerMissing}
                  </span>
                  <span className="browser-settings-actions">
                    <Button variant="secondary" size="compact" onClick={() => void requestComputerPermissions()} busy={busy}>
                      {labels.computerRequestPermissions}
                    </Button>
                    {!computerSettings.accessibilityTrusted ? (
                      <Button variant="secondary" size="compact" onClick={() => void openComputerPermissionSettings('accessibility')} busy={busy}>
                        {labels.computerOpenAccessibility}
                      </Button>
                    ) : null}
                    {!computerSettings.screenCaptureAvailable ? (
                      <Button variant="secondary" size="compact" onClick={() => void openComputerPermissionSettings('screen_capture')} busy={busy}>
                        {labels.computerOpenScreenCapture}
                      </Button>
                    ) : null}
                  </span>
                </span>
              ) : null}
            </span>
          </BrowserSettingRow>
        ) : null}
        {retiredRuntimeState ? (
          <BrowserSettingRow
            title={labels.retiredTitle}
            description={`${labels.retiredHelp} ${retiredRuntimeState.entries.length > 0 ? retiredRuntimeState.entries.join('、') : labels.retiredNone}${retiredRuntimeState.latestBackupRoot ? ` ${retiredRuntimeState.latestBackupRoot}` : ''}`}
          >
            <span className="browser-settings-actions">
              <Button variant="secondary" size="compact" onClick={() => void archiveRetiredRuntimes()} busy={busy} disabled={retiredRuntimeState.entries.length === 0}>
                {labels.retiredArchive}
              </Button>
              <Button variant="secondary" size="compact" onClick={() => void restoreRetiredRuntimes()} busy={busy} disabled={!retiredRuntimeState.latestBackupRoot || Boolean(retiredRuntimeState.restoredAt)}>
                {labels.retiredRestore}
              </Button>
            </span>
          </BrowserSettingRow>
        ) : null}
        <div className="browser-settings-actions">
          <Button variant="secondary" size="compact" onClick={() => void save()} busy={busy}>
            {labels.save}
          </Button>
          <Button variant="danger" size="compact" onClick={() => void clear()} busy={busy}>
            {labels.clear}
          </Button>
        </div>
      </section>
      {status ? (
        <p className="browser-settings-status" role="status">
          {status}
        </p>
      ) : null}
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
