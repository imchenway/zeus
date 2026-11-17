import { ZeusSelect } from '../ZeusSelect.js';
import { SettingsSaveStatus, useSettingsAutosave } from './useSettingsAutosave.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ZeusBrowserSettings, ZeusComputerSettings, ZeusRetiredNativeRuntimeState } from '@zeus/shared';
import { Button } from '../ui/Button.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { BrowserPasswordsSection } from './BrowserPasswordsSection.js';
import { AutomationModelSettings } from './AutomationModelSettings.js';
import type { AppShellSettings } from '../features/settings/settingsContracts.js';
import type { SettingsApiClient } from '../features/settings/settingsApiClient.js';

interface BrowserSettingsPaneProps {
  language: 'zh-CN' | 'en-US';
  /** 操作模型沿用全局应用设置，与原生浏览器资料分开。 */
  appSettings: AppShellSettings;
  /** 复用设置命令的串行保存。 */
  client: SettingsApiClient | null;
  /** 更新主界面的操作模型快照。 */
  onAppSettingsChange: (update: (value: AppShellSettings) => AppShellSettings) => unknown;
}
const copy = {
  'zh-CN': {
    title: '内置浏览器',
    // 明确即时保存的开关与需要手动保存的其他输入。
    intro: 'Zeus 使用独立的浏览器资料。网站登录会在 Zeus 对话之间保留，但不与 Chrome 共享。开关修改后立即保存；其他设置请点击“保存浏览器设置”。',
    unavailable: '此处无法使用内置浏览器设置。',
    loading: '正在读取浏览器设置…',
    enabled: '启用内置浏览器',
    enabledHelp: '在对话中打开网页并添加评论，AI 可直接访问网站和操作页面，无需逐次确认。',
    webLinks: '普通网页默认打开方式',
    localWeb: '本地 HTML 与 localhost',
    files: '文件引用默认打开方式',
    zeusBrowser: 'Zeus 内置浏览器',
    externalBrowser: '系统默认浏览器',
    zeusPreview: 'Zeus 预览',
    systemDefault: '系统默认应用',
    screenshots: '评论截图',
    screenshotsHelp: '“始终”会为每条评论附图；“必要时”只为区域或 Adjust 变更附图。',
    always: '始终',
    necessary: '必要时',
    downloads: '下载目录',
    downloadsHelp: '默认保存在 Zeus 私有资料目录，不会申请系统“下载”文件夹权限；改为其他受保护目录后，保存设置时可能由 macOS 询问。',
    askWhere: '每次询问保存位置',
    save: '保存浏览器设置',
    saved: '浏览器设置已保存。',
    // 单个开关保存不能暗示页面中的其他草稿也已保存。
    switchSaved: '开关设置已保存。',
    clear: '清除浏览器数据',
    clearHelp: '清除 Cookie、缓存、站点存储、站点授权和页面评论，并把现有标签重置为空白页。已保存密码保留。',
    cleared: '浏览器数据已清除。',
    clearConfirm: '将清除独立浏览器 Profile 中的登录态、站点数据、授权和评论。此操作不可撤销，确定继续吗？',
    computerTitle: 'Computer Use',
    // 全局启用后会话即可按需使用，无需逐条消息选择。
    computerHelp: '通过内置 CUA Driver 操作已明确观察的应用窗口。Zeus 只使用后台投递，不会自动切到前台；应用不支持后台操作时会直接失败。首次授权后请重新启动 Zeus。',
    computerEnable: '启用 Computer Use',
    computerStop: '立即停止控制',
    computerAccessibility: '辅助功能',
    computerScreenCapture: '屏幕与系统音频录制',
    computerGranted: '已授权',
    computerMissing: '待授权',
    // 未完成探针时不引导用户反复授权。
    computerUnchecked: '尚未检查',
    computerUnavailable: '无法检查（组件错误）',
    computerRequestPermissions: '申请或重新检查权限',
    computerOpenAccessibility: '打开辅助功能设置',
    computerOpenScreenCapture: '打开录屏设置',
    computerSettingsOpened: '已打开对应的 macOS 隐私设置；授权后请重新启动 Zeus。',
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
    enabledHelp: 'Open web pages and add comments in conversations. The AI can access sites and operate pages without per-action confirmation.',
    webLinks: 'Default for web links',
    localWeb: 'Local HTML and localhost',
    files: 'Default for file references',
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
    save: 'Save browser settings',
    saved: 'Browser settings saved.',
    // 只确认本次开关已经保存。
    switchSaved: 'Switch setting saved.',
    clear: 'Clear browser data',
    clearHelp: 'Clears cookies, cache, site storage, site grants, and page comments, then resets open tabs to blank pages. Saved passwords are kept.',
    cleared: 'Browser data cleared.',
    clearConfirm: 'This clears sign-in state, site data, grants, and comments from the independent browser profile. It cannot be undone. Continue?',
    computerTitle: 'Computer Use',
    // 英文同步说明全局开关生效后的会话能力。
    computerHelp:
      'Use the embedded CUA Driver only on explicitly observed app windows. Zeus forces background delivery and never falls back to foreground activation; unsupported apps fail explicitly. Restart Zeus after the first permission grant.',
    computerEnable: 'Enable Computer Use',
    computerStop: 'Stop control now',
    computerAccessibility: 'Accessibility',
    computerScreenCapture: 'Screen & System Audio Recording',
    computerGranted: 'Granted',
    computerMissing: 'Required',
    // 组件失败与系统权限缺失分别显示。
    computerUnchecked: 'Not checked',
    computerUnavailable: 'Unavailable (component error)',
    computerRequestPermissions: 'Request or recheck permissions',
    computerOpenAccessibility: 'Open Accessibility settings',
    computerOpenScreenCapture: 'Open Screen Recording settings',
    computerSettingsOpened: 'The matching macOS privacy settings are open. Restart Zeus after granting access.',
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
  /** 浏览器偏好串行保存，电脑权限与旧资料迁移只锁定各自的操作组。 */
  const saving = useSettingsAutosave(window.zeus);
  const [computerBusy, setComputerBusy] = useState(false);
  const [retiredBusy, setRetiredBusy] = useState(false);
  /** 回滚只使用已确认的设置，不把上次未保存的值当成成功结果。 */
  const confirmedSettings = useRef<ZeusBrowserSettings | null>(null);
  const fieldRevisions = useRef<Partial<Record<keyof ZeusBrowserSettings, number>>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

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
        if (active) {
          confirmedSettings.current = value;
          setSettings(value);
        }
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

  /** 开关立即反馈，写入仍由同一偏好队列确认或回滚。 */
  async function setBoolean(key: 'enabled' | 'askWhereToSave' | 'externalChromeEnabled' | 'externalEdgeEnabled', value: boolean): Promise<void> {
    await save({ [key]: value });
  }

  async function setComputerEnabled(enabled: boolean): Promise<void> {
    if (!window.zeus?.updateComputerSettings) return;
    setComputerBusy(true);
    setError(null);
    try {
      setComputerSettings(await window.zeus.updateComputerSettings({ enabled }));
      setStatus(labels.saved);
    } catch (computerError) {
      setError(computerError);
    } finally {
      setComputerBusy(false);
    }
  }

  async function stopComputer(): Promise<void> {
    if (!window.zeus?.stopComputerUse) return;
    setComputerBusy(true);
    setError(null);
    try {
      setComputerSettings(await window.zeus.stopComputerUse());
    } catch (computerError) {
      setError(computerError);
    } finally {
      setComputerBusy(false);
    }
  }

  async function requestComputerPermissions(): Promise<void> {
    if (!window.zeus?.requestComputerPermissions) return;
    setComputerBusy(true);
    setStatus(null);
    setError(null);
    try {
      setComputerSettings(await window.zeus.requestComputerPermissions());
    } catch (computerError) {
      setError(computerError);
    } finally {
      setComputerBusy(false);
    }
  }

  async function openComputerPermissionSettings(permission: 'accessibility' | 'screen_capture'): Promise<void> {
    if (!window.zeus?.openComputerPermissionSettings) return;
    setComputerBusy(true);
    setStatus(null);
    setError(null);
    try {
      await window.zeus.openComputerPermissionSettings({ permission });
      setStatus(labels.computerSettingsOpened);
    } catch (computerError) {
      setError(computerError);
    } finally {
      setComputerBusy(false);
    }
  }

  async function archiveRetiredRuntimes(): Promise<void> {
    if (!window.zeus?.archiveRetiredNativeRuntimes || !window.confirm(labels.retiredArchiveConfirm)) return;
    setRetiredBusy(true);
    setError(null);
    try {
      setRetiredRuntimeState(await window.zeus.archiveRetiredNativeRuntimes());
      setStatus(labels.retiredArchived);
    } catch (archiveError) {
      setError(archiveError);
    } finally {
      setRetiredBusy(false);
    }
  }

  async function restoreRetiredRuntimes(): Promise<void> {
    if (!window.zeus?.restoreRetiredNativeRuntimes || !window.confirm(labels.retiredRestoreConfirm)) return;
    setRetiredBusy(true);
    setError(null);
    try {
      setRetiredRuntimeState(await window.zeus.restoreRetiredNativeRuntimes());
      setStatus(labels.retiredRestored);
    } catch (restoreError) {
      setError(restoreError);
    } finally {
      setRetiredBusy(false);
    }
  }

  /** 仅保存此次选择或输入完成的字段。 */
  async function save(patch: Partial<ZeusBrowserSettings>): Promise<void> {
    if (!settings || !window.zeus?.updateBrowserSettings) return;
    const keys = Object.keys(patch) as Array<keyof ZeusBrowserSettings>;
    const revisions = Object.fromEntries(keys.map((key) => [key, (fieldRevisions.current[key] = (fieldRevisions.current[key] ?? 0) + 1)]));
    setSettings((current) => (current ? { ...current, ...patch } : current));
    setStatus(null);
    setError(null);
    await saving.save(async () => {
      try {
        confirmedSettings.current = await window.zeus!.updateBrowserSettings!(patch);
        setStatus(labels.saved);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError : labels.saveFailed);
        throw saveError;
      } finally {
        /** 迟到回执只校准仍对应本次输入的字段，输入中的新草稿继续保留。 */
        setSettings((current) =>
          current && confirmedSettings.current
            ? {
                ...current,
                ...Object.fromEntries(keys.filter((key) => fieldRevisions.current[key] === revisions[key] && Object.is(current[key], patch[key])).map((key) => [key, confirmedSettings.current![key]])),
              }
            : current,
        );
      }
    });
  }

  async function clear(): Promise<void> {
    if (!window.zeus?.clearBrowserData || !window.confirm(labels.clearConfirm)) return;
    setStatus(null);
    setError(null);
    try {
      await window.zeus.clearBrowserData();
      setStatus(labels.cleared);
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError : labels.clearFailed);
    }
  }

  if (!settings) {
    return (
      <section className="settings-product-pane browser-settings-product-pane" aria-label={labels.title}>
        <h2 className="settings-page-title">{labels.title}</h2>
        <AutomationModelSettings value={props.appSettings} client={props.client} onChange={props.onAppSettingsChange} />
        <p className="browser-settings-status" role={error ? 'alert' : 'status'}>
          {error ? <VisibleApplicationError error={error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} /> : labels.loading}
        </p>
      </section>
    );
  }

  return (
    <section className="settings-product-pane browser-settings-product-pane" aria-label={labels.title}>
      <header className="settings-page-heading">
        <span>
          <h2 className="settings-page-title">{labels.title}</h2>
        </span>
        <SettingsSaveStatus language={props.language} status={saving.status} />
      </header>
      <AutomationModelSettings value={props.appSettings} client={props.client} onChange={props.onAppSettingsChange} />
      <section className="settings-product-section">
        <h3>{props.language === 'zh-CN' ? '打开方式' : 'Open preferences'}</h3>
        <section className="native-settings-pane browser-settings-pane" aria-label={props.language === 'zh-CN' ? '打开方式' : 'Open preferences'}>
          <BrowserSettingRow title={labels.enabled} description={labels.enabledHelp}>
            <BrowserSwitch label={labels.enabled} checked={settings.enabled} onChange={(checked) => setBoolean('enabled', checked)} />
          </BrowserSettingRow>
          <BrowserSettingRow title={labels.webLinks}>
            <ZeusSelect
              size="regular"
              ariaLabel={labels.webLinks}
              value={settings.webLinkOpenTarget}

              onChange={(value) => save({ webLinkOpenTarget: value })}
              options={[
                { value: 'zeus_browser', label: labels.zeusBrowser },
                { value: 'system_default', label: labels.externalBrowser },
              ]}
            />
          </BrowserSettingRow>
          <BrowserSettingRow title={labels.localWeb}>
            <ZeusSelect
              size="regular"
              ariaLabel={labels.localWeb}
              value={settings.localWebOpenTarget}

              onChange={(value) => save({ localWebOpenTarget: value })}
              options={[
                { value: 'zeus_browser', label: labels.zeusBrowser },
                { value: 'system_default', label: labels.externalBrowser },
              ]}
            />
          </BrowserSettingRow>
          <BrowserSettingRow title={labels.files}>
            <ZeusSelect
              size="regular"
              ariaLabel={labels.files}
              value={settings.fileOpenTarget}

              onChange={(value) => save({ fileOpenTarget: value })}
              options={[
                { value: 'zeus_source', label: labels.zeusPreview },
                { value: 'system_default', label: labels.systemDefault },
                { value: 'editor:vscode', label: 'Visual Studio Code' },
                { value: 'editor:vscode-insiders', label: 'Visual Studio Code - Insiders' },
                { value: 'editor:cursor', label: 'Cursor' },
                { value: 'editor:windsurf', label: 'Windsurf' },
              ]}
            />
          </BrowserSettingRow>
        </section>
      </section>
      <BrowserPasswordsSection language={props.language} />
      <section className="settings-product-section">
        <h3>{props.language === 'zh-CN' ? '下载' : 'Downloads'}</h3>
        <section className="native-settings-pane browser-settings-pane" aria-label={props.language === 'zh-CN' ? '下载' : 'Downloads'}>
          <BrowserSettingRow title={labels.downloads} description={labels.downloadsHelp}>
            <input
              aria-label={labels.downloads}
              value={settings.downloadDirectory}

              onChange={(event) => {
                setStatus(null);
                setSettings({ ...settings, downloadDirectory: event.currentTarget.value });
              }}
              onBlur={(event) => save({ downloadDirectory: event.currentTarget.value })}
            />
          </BrowserSettingRow>
          <BrowserSettingRow title={labels.askWhere}>
            <BrowserSwitch label={labels.askWhere} checked={settings.askWhereToSave} onChange={(checked) => setBoolean('askWhereToSave', checked)} />
          </BrowserSettingRow>
        </section>
      </section>
      <section className="settings-product-section">
        <h3>{props.language === 'zh-CN' ? '自动化与权限' : 'Automation and permissions'}</h3>
        <section className="native-settings-pane browser-settings-pane" aria-label={props.language === 'zh-CN' ? '自动化与权限' : 'Automation and permissions'}>
          <BrowserSettingRow title={labels.screenshots} description={labels.screenshotsHelp}>
            <ZeusSelect
              size="regular"
              ariaLabel={labels.screenshots}
              value={settings.screenshotMode}

              onChange={(value) => save({ screenshotMode: value })}
              options={[
                { value: 'always', label: labels.always },
                { value: 'necessary', label: labels.necessary },
              ]}
            />
          </BrowserSettingRow>
          <BrowserSettingRow title={labels.chromeEnable} description={labels.chromeHelp}>
            <BrowserSwitch label={labels.chromeEnable} checked={settings.externalChromeEnabled} onChange={(checked) => setBoolean('externalChromeEnabled', checked)} />
          </BrowserSettingRow>
          <BrowserSettingRow title={labels.edgeEnable} description={labels.edgeHelp}>
            <BrowserSwitch label={labels.edgeEnable} checked={settings.externalEdgeEnabled} onChange={(checked) => setBoolean('externalEdgeEnabled', checked)} />
          </BrowserSettingRow>
          {computerSettings ? (
            <BrowserSettingRow title={labels.computerTitle} description={`${labels.computerHelp}${computerSettings.detail ? ` ${computerSettings.detail}` : ''}`} danger>
              <span className="computer-permission-panel">
                <span className="browser-settings-actions">
                  <BrowserSwitch label={labels.computerEnable} checked={computerSettings.enabled} disabled={computerBusy} onChange={(checked) => setComputerEnabled(checked)} />
                  <Button variant="danger" size="compact" onClick={() => stopComputer()} disabled={computerBusy || (!computerSettings.enabled && computerSettings.serviceState === 'disabled')}>
                    {labels.computerStop}
                  </Button>
                </span>
                {computerSettings.enabled ? (
                  <span className="computer-permission-details" role="status" aria-live="polite">
                    <span className={computerSettings.permissionCheckState !== 'checked' ? undefined : computerSettings.accessibilityTrusted ? 'granted' : 'missing'}>
                      {labels.computerAccessibility}：
                      {computerSettings.permissionCheckState === 'error'
                        ? labels.computerUnavailable
                        : computerSettings.permissionCheckState !== 'checked'
                          ? labels.computerUnchecked
                          : computerSettings.accessibilityTrusted
                            ? labels.computerGranted
                            : labels.computerMissing}
                    </span>
                    <span className={computerSettings.permissionCheckState !== 'checked' ? undefined : computerSettings.screenCaptureAvailable ? 'granted' : 'missing'}>
                      {labels.computerScreenCapture}：
                      {computerSettings.permissionCheckState === 'error'
                        ? labels.computerUnavailable
                        : computerSettings.permissionCheckState !== 'checked'
                          ? labels.computerUnchecked
                          : computerSettings.screenCaptureAvailable
                            ? labels.computerGranted
                            : labels.computerMissing}
                    </span>
                    <span className="browser-settings-actions">
                      <Button variant="secondary" size="compact" disabled={computerBusy} onClick={() => requestComputerPermissions()}>
                        {labels.computerRequestPermissions}
                      </Button>
                      {computerSettings.permissionCheckState === 'checked' && !computerSettings.accessibilityTrusted ? (
                        <Button variant="secondary" size="compact" disabled={computerBusy} onClick={() => openComputerPermissionSettings('accessibility')}>
                          {labels.computerOpenAccessibility}
                        </Button>
                      ) : null}
                      {computerSettings.permissionCheckState === 'checked' && !computerSettings.screenCaptureAvailable ? (
                        <Button variant="secondary" size="compact" disabled={computerBusy} onClick={() => openComputerPermissionSettings('screen_capture')}>
                          {labels.computerOpenScreenCapture}
                        </Button>
                      ) : null}
                    </span>
                  </span>
                ) : null}
              </span>
            </BrowserSettingRow>
          ) : null}
        </section>
      </section>
      <section className="settings-product-section">
        <h3>{props.language === 'zh-CN' ? '浏览器数据' : 'Browser data'}</h3>
        <section className="native-settings-pane browser-settings-pane" aria-label={props.language === 'zh-CN' ? '浏览器数据' : 'Browser data'}>
          {retiredRuntimeState ? (
            <BrowserSettingRow
              title={labels.retiredTitle}
              description={`${labels.retiredHelp} ${retiredRuntimeState.entries.length > 0 ? retiredRuntimeState.entries.join('、') : labels.retiredNone}${retiredRuntimeState.latestBackupRoot ? ` ${retiredRuntimeState.latestBackupRoot}` : ''}`}
            >
              <span className="browser-settings-actions">
                <Button variant="secondary" size="compact" onClick={() => archiveRetiredRuntimes()} disabled={retiredBusy || retiredRuntimeState.entries.length === 0}>
                  {labels.retiredArchive}
                </Button>
                <Button variant="secondary" size="compact" onClick={() => restoreRetiredRuntimes()} disabled={retiredBusy || !retiredRuntimeState.latestBackupRoot || Boolean(retiredRuntimeState.restoredAt)}>
                  {labels.retiredRestore}
                </Button>
              </span>
            </BrowserSettingRow>
          ) : null}
          <div className="browser-settings-actions">
            <Button variant="danger" size="compact" onClick={() => clear()}>
              {labels.clear}
            </Button>
          </div>
        </section>
        <p className="browser-settings-clear-help">{labels.clearHelp}</p>
      </section>
      {status && status !== labels.saved && status !== labels.switchSaved ? (
        <p className="browser-settings-status" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="browser-settings-status" role="alert">
          <VisibleApplicationError error={error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
    </section>
  );
}

/** 浏览器设置复用设置行布局，仅在存在必要说明时占用说明行。 */
function BrowserSettingRow(props: { title: string; description?: string; children: ReactNode; danger?: boolean }) {
  return (
    <div className={`native-control-row browser-settings-row ${props.danger ? 'danger' : ''}`}>
      <span className="native-control-copy">
        <strong>{props.title}</strong>
        {props.description ? <span className="native-control-description">{props.description}</span> : null}
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
