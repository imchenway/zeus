import { contextBridge, ipcRenderer, webFrame } from 'electron';
import globalSource from '../../assets/keepassxc-browser/common/global.js.txt?raw';
import sitesSource from '../../assets/keepassxc-browser/common/sites.js.txt?raw';
import uiSource from '../../assets/keepassxc-browser/content/ui.js.txt?raw';
import bannerSource from '../../assets/keepassxc-browser/content/banner.js.txt?raw';
import autocompleteSource from '../../assets/keepassxc-browser/content/autocomplete.js.txt?raw';
import credentialAutocompleteSource from '../../assets/keepassxc-browser/content/credential-autocomplete.js.txt?raw';
import customFieldsSource from '../../assets/keepassxc-browser/content/custom-fields-banner.js.txt?raw';
import fieldsSource from '../../assets/keepassxc-browser/content/fields.js.txt?raw';
import fillSource from '../../assets/keepassxc-browser/content/fill.js.txt?raw';
import formSource from '../../assets/keepassxc-browser/content/form.js.txt?raw';
import iconSource from '../../assets/keepassxc-browser/content/icon.js.txt?raw';
import iconHandlerSource from '../../assets/keepassxc-browser/content/icon-handler.js.txt?raw';
import contentSource from '../../assets/keepassxc-browser/content/keepassxc-browser.js.txt?raw';
import observerSource from '../../assets/keepassxc-browser/content/observer-helper.js.txt?raw';
import generatorSource from '../../assets/keepassxc-browser/content/pwgen.js.txt?raw';
import totpAutocompleteSource from '../../assets/keepassxc-browser/content/totp-autocomplete.js.txt?raw';
import totpFieldSource from '../../assets/keepassxc-browser/content/totp-field.js.txt?raw';
import usernameFieldSource from '../../assets/keepassxc-browser/content/username-field.js.txt?raw';
import defaultsSource from '../../assets/keepassxc-browser/background/page.js.txt?raw';
import englishSource from '../../assets/keepassxc-browser/_locales/en/messages.json.txt?raw';
import chineseSource from '../../assets/keepassxc-browser/_locales/zh_CN/messages.json.txt?raw';

/** 与网页及普通页面 preload 分开的内容脚本世界，网页不能调用凭据接口。 */
const autofillWorld = 1001;
/** 固定上游的自动启动块由宿主管理，识别、监听及填充函数保持原样。 */
const upstreamAutoStart = `if (document.readyState === 'complete' || (document.readyState !== 'loading' && !document.documentElement.doScroll)) {
    initContentScript();
} else {
    document.addEventListener('DOMContentLoaded', initContentScript);
}`;

/** 宿主身份只包含当前文档及语言，不含账号或密码。 */
interface AutofillContext {
  origin: string;
  generation: number;
  language: 'zh-CN' | 'en-US';
  tabId: number;
}

/** 拼接原始内容脚本，仅替换扩展通信和启动方式，不重写 DOM 算法。 */
function autofillScript(context: AutofillContext): string {
  /** Windows 检出可能使用 CRLF，只规范启动钩子的行结束符。 */
  const mainContentSource = contentSource.replace(/\r\n/gu, '\n');
  const defaultsEnd = defaultsSource.indexOf('const AUTO_SUBMIT_TIMEOUT');
  if (defaultsEnd < 0 || mainContentSource.split(upstreamAutoStart).length !== 2) throw new Error('固定的自动填充源码与宿主启动约定不一致。');
  const messages = JSON.parse(context.language === 'zh-CN' ? chineseSource : englishSource) as unknown;
  /** 设置及短期页面状态替代扩展后台，凭据读取仍由 Main 校验真实文档。 */
  const transport = `
    const zeusHost = globalThis.zeusPasswordHost;
    const zeusContext = ${JSON.stringify(context)};
    const zeusMessages = ${JSON.stringify(messages)};
    const zeusPage = { loginId: null, manualFill: 0, passwordFilled: false };
    const zeusListeners = new Set();
    const browser = {
      runtime: {
        getURL: (path = '') => 'data:application/octet-stream,' + encodeURIComponent(path),
        onMessage: {
          addListener: (listener) => zeusListeners.add(listener),
          removeListener: (listener) => zeusListeners.delete(listener),
          hasListener: (listener) => zeusListeners.has(listener)
        },
        sendMessage: async ({ action, args }) => {
          switch (action) {
            case 'load_settings': return { ...defaultSettings,
              autoCompleteUsernames: false, autoFillSingleEntry: false, autoFillRelevantCredential: false,
              autoSubmit: false, debugLogging: false, showLoginFormIcon: false, showOTPIcon: false,
              showLoginNotifications: false, showNotifications: false, usePasswordGeneratorIcons: false,
              sitePreferences: [], 'defined-custom-fields': {}
            };
            case 'get_status': case 'reconnect': return { keePassXCAvailable: true, databaseClosed: false };
            case 'is_connected': return true;
            case 'is_firefox': return false;
            case 'is_iframe_allowed': return window === window.top && location.origin === zeusContext.origin;
            case 'retrieve_credentials': return zeusHost.request({ action: 'credentials', url: location.href });
            case 'page_get_login_id': return zeusPage.loginId;
            case 'page_set_login_id': zeusPage.loginId = args; return true;
            case 'page_get_manual_fill': return zeusPage.manualFill;
            case 'page_set_manual_fill': zeusPage.manualFill = args; return true;
            case 'password_get_filled': return zeusPage.passwordFilled;
            case 'password_set_filled': zeusPage.passwordFilled = Boolean(args); return true;
            case 'page_get_submitted': return { submitted: false };
            case 'page_get_redirect_count': return 0;
            case 'get_connected_database': return { identifier: 'zeus-local' };
            case 'banner_get_position': return 0;
            case 'page_get_autosubmit_performed': return false;
            default: return false;
          }
        }
      },
      dom: { openOrClosedShadowRoot: (element) => element.shadowRoot },
      tabs: { query: async () => [{ id: zeusContext.tabId, active: true, url: location.href }] },
      notifications: { create: async () => '' },
      i18n: { getMessage: (key, substitutions = []) => {
        const entry = zeusMessages[key];
        if (!entry) return key;
        const values = Array.isArray(substitutions) ? substitutions : [substitutions];
        return entry.message.replace(/\\$([A-Za-z_][A-Za-z_0-9]*|[0-9]+)\\$/g, (match, name) => entry.placeholders?.[name.toLowerCase()]?.content ?? match)
          .replace(/\\$([0-9]+)/g, (match, index) => String(values[Number(index) - 1] ?? ''));
      } }
    };
  `;
  /** 顺序与固定发布版 manifest 一致；扩展 polyfill 由上面的宿主 API 替代。 */
  const source = [
    globalSource,
    sitesSource,
    uiSource,
    bannerSource,
    autocompleteSource,
    credentialAutocompleteSource,
    customFieldsSource,
    fieldsSource,
    fillSource,
    formSource,
    iconSource,
    iconHandlerSource,
    mainContentSource.replace(upstreamAutoStart, ''),
    observerSource,
    generatorSource,
    totpAutocompleteSource,
    totpFieldSource,
    usernameFieldSource,
    defaultsSource.slice(0, defaultsEnd),
  ].join('\n');
  /** 原生菜单只适配上游入口及回执，字段选择与事件触发交给原始引擎。 */
  const entry = `
    let zeusInitializing = null;
    let zeusMenuPending = false;
    let zeusFilling = false;
    const zeusReady = async () => {
      if (!['text/html', 'application/xhtml+xml'].includes(document.contentType)) return false;
      if (kpxc.observer) return true;
      if (!zeusInitializing) zeusInitializing = initContentScript().finally(() => { zeusInitializing = null; });
      await zeusInitializing;
      return Boolean(kpxc.observer);
    };
    globalThis.zeusAutofill = {
      probe: async (origin) => {
        if (origin !== location.origin || origin !== zeusContext.origin || !await zeusReady()) return false;
        await kpxc.initCredentialFields();
        return kpxc.combinations.length > 0;
      },
      fill: async (origin, uuid) => {
        if (origin !== location.origin || origin !== zeusContext.origin) return 'page_changed';
        if (!await zeusReady()) return 'unavailable';
        zeusFilling = true;
        try {
        await kpxc.initCredentialFields();
        kpxc.credentials = [];
        await kpxc.receiveCredentialsIfNecessary();
        if (location.origin !== origin) return 'page_changed';
        const credential = kpxc.credentials.find((item) => item.uuid === uuid);
        if (!credential) return 'account_missing';
        const combination = kpxcFields.getCombinationFromAllInputs();
        if (!combination) return 'no_login_form';
        await sendMessage('page_set_login_id', uuid);
        await kpxcFill.fillInCredentials(combination, credential.login, uuid);
        if (location.origin !== origin) return 'page_changed';
        const filled = combination.password
          ? combination.password.value === credential.password
          : combination.username?.value === credential.login;
        return filled ? 'filled' : 'no_login_form';
        } finally { zeusFilling = false; }
      }
    };
    document.addEventListener('focusin', async (event) => {
      if (!event.isTrusted || !navigator.userActivation.isActive || zeusMenuPending || zeusFilling || !event.composedPath()[0]?.matches?.('input')) return;
      zeusMenuPending = true;
      try {
        if (!await zeusReady()) return;
        await kpxc.initCredentialFields();
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        if (!kpxc.combinations.some((item) => item.username === active || item.password === active)) return;
        await zeusHost.showPasswords();
      } catch { console.warn('Zeus saved-password suggestions are unavailable.'); }
      finally { zeusMenuPending = false; }
    });
    void zeusReady();
    return true;
  `;
  return `(async () => { 'use strict';\n${transport}\n${source}\n${entry}\n})()`;
}

/** 在专属隔离世界启动完整上游脚本，普通网页拿不到 IPC 或凭据对象。 */
export function installBrowserPasswordAutofill(showPasswords: (generation: number) => Promise<unknown>): void {
  if (window !== window.top || !['https:', 'http:'].includes(location.protocol)) return;
  /** 等待正文创建，保持上游 document_idle 的启动时机。 */
  const start = async (): Promise<void> => {
    const context = (await ipcRenderer.invoke('zeus:browser-page:autofill-runtime', { action: 'context' })) as AutofillContext;
    if (!context || context.origin !== location.origin || !Number.isSafeInteger(context.generation)) return;
    webFrame.setIsolatedWorldInfo(autofillWorld, { securityOrigin: context.origin, csp: "default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline' data:; img-src data:" });
    contextBridge.exposeInIsolatedWorld(autofillWorld, 'zeusPasswordHost', {
      request: (request: unknown) => ipcRenderer.invoke('zeus:browser-page:autofill-runtime', { request, generation: context.generation }),
      showPasswords: () => showPasswords(context.generation),
    });
    await webFrame.executeJavaScriptInIsolatedWorld(autofillWorld, [{ code: autofillScript(context) }]);
  };
  /** 初始化诊断不包含源码、凭据或库内容；显式填充入口会报告实际不可用。 */
  const initialize = (): void => {
    void start().catch(() => console.warn('Zeus password autofill initialization failed.'));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
}
