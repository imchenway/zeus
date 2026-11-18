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
import type { BrowserPasswordFrameRequest, BrowserPasswordSelection } from './browserPasswordFrame.js';

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
  language: 'zh-CN' | 'en-US';
  tabId: number;
  /** 同源 iframe 重新导航后也需要重新确认文档身份。 */
  documentId: string;
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
              autoRetrieveCredentials: false, autoCompleteUsernames: false, autoFillSingleEntry: false, autoFillRelevantCredential: false,
              autoSubmit: false, debugLogging: false, showLoginFormIcon: false, showOTPIcon: false,
              showLoginNotifications: false, showNotifications: false, usePasswordGeneratorIcons: false,
              sitePreferences: [], 'defined-custom-fields': {}
            };
            case 'get_status': case 'reconnect': return { keePassXCAvailable: true, databaseClosed: false };
            case 'is_connected': return true;
            case 'is_firefox': return false;
            case 'is_iframe_allowed': return self.origin === zeusContext.origin;
            case 'retrieve_credentials': return [];
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
    let zeusMenuInput = null;
    let zeusFilling = false;
    const zeusReady = async () => {
      if (!['text/html', 'application/xhtml+xml'].includes(document.contentType)) return false;
      if (kpxc.observer) return true;
      if (!zeusInitializing) zeusInitializing = initContentScript().finally(() => { zeusInitializing = null; });
      await zeusInitializing;
      return Boolean(kpxc.observer);
    };
    // 焦点可位于开放的 Shadow DOM 中。
    const zeusActiveInput = () => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active;
    };
    // 通过上游识别结果把菜单绑定到触发它的登录框。
    const zeusCombination = (input) => kpxc.combinations.find((item) => item.username === input || item.password === input);
    globalThis.zeusAutofill = {
      probe: async (origin) => {
        if (origin !== self.origin || origin !== zeusContext.origin || !await zeusReady()) return null;
        await kpxc.initCredentialFields();
        const found = zeusMenuInput ? zeusCombination(zeusMenuInput) : kpxc.combinations.length > 0;
        return found ? { documentId: zeusContext.documentId } : null;
      },
      fill: async (origin, documentId) => {
        if (origin !== self.origin || origin !== zeusContext.origin || documentId !== zeusContext.documentId) return 'page_changed';
        if (!await zeusReady()) return 'unavailable';
        zeusFilling = true;
        try {
          await kpxc.initCredentialFields();
          const combination = zeusMenuInput ? zeusCombination(zeusMenuInput) : zeusCombination(zeusActiveInput()) ?? kpxcFields.getCombinationFromAllInputs();
          if (!combination) return 'no_login_form';
          const selection = zeusHost.takeSelection();
          if (!selection) return 'unavailable';
          const { id, username, password } = selection;
          kpxc.credentials = [{ uuid: id, login: username, password, skipAutoSubmit: 'true' }];
          await sendMessage('page_set_login_id', id);
          await kpxcFill.fillInCredentials(combination, username, id);
          const filled = combination.password ? combination.password.value === password : combination.username?.value === username;
          return filled ? 'filled' : 'no_login_form';
        } finally {
          kpxc.credentials = [];
          zeusFilling = false;
        }
      }
    };
    // 点击已聚焦的输入框也能再次打开候选菜单。
    const zeusSuggest = async (event) => {
      const input = event.composedPath()[0];
      if (!event.isTrusted || !navigator.userActivation.isActive || zeusMenuInput || zeusFilling || !input?.matches?.('input')) return;
      zeusMenuInput = input;
      try {
        if (!await zeusReady()) return;
        await kpxc.initCredentialFields();
        if (input !== zeusActiveInput() || !zeusCombination(input)) return;
        await zeusHost.showPasswords();
      } catch { console.warn('Zeus saved-password suggestions are unavailable.'); }
      finally { zeusMenuInput = null; }
    };
    document.addEventListener('focusin', zeusSuggest, true);
    document.addEventListener('click', zeusSuggest, true);
    return true;
  `;
  return `(async () => { 'use strict';\n${transport}\n${source}\n${entry}\n})()`;
}

/** 在专属隔离世界启动完整上游脚本，普通网页拿不到 IPC 或凭据对象。 */
export function installBrowserPasswordAutofill(showPasswords: (documentId: string) => Promise<unknown>): void {
  if (!['https:', 'http:'].includes(location.protocol) || self.origin !== location.origin) return;
  /** 等待正文创建，保持上游 document_idle 的启动时机。 */
  const start = async (): Promise<void> => {
    const frame = (await ipcRenderer.invoke('zeus:browser-page:autofill-runtime')) as Omit<AutofillContext, 'documentId'> | null;
    if (!frame || frame.origin !== self.origin) return;
    /** 此标识随文档销毁，不依赖 URL 是否变化。 */
    const context: AutofillContext = { ...frame, documentId: crypto.getRandomValues(new Uint32Array(4)).join('-') };
    /** 填充期间仅向专属隔离世界交接一次，密码不插入脚本文本。 */
    let selection: BrowserPasswordSelection | undefined;
    webFrame.setIsolatedWorldInfo(autofillWorld, { securityOrigin: context.origin, csp: "default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline' data:; img-src data:" });
    contextBridge.exposeInIsolatedWorld(autofillWorld, 'zeusPasswordHost', {
      takeSelection: () => {
        const value = selection;
        selection = undefined;
        return value;
      },
      showPasswords: () => showPasswords(context.documentId),
    });
    await webFrame.executeJavaScriptInIsolatedWorld(autofillWorld, [{ code: autofillScript(context) }]);
    ipcRenderer.on('zeus:browser-page:password-frame', async ({ ports: [reply] }, request: BrowserPasswordFrameRequest) => {
      if (!reply) return;
      if (request.origin !== self.origin || (request.action === 'fill' && request.documentId !== context.documentId)) {
        reply.postMessage('page_changed');
        return;
      }
      const origin = JSON.stringify(request.origin);
      const code = request.action === 'probe' ? `globalThis.zeusAutofill.probe(${origin})` : `globalThis.zeusAutofill.fill(${origin},${JSON.stringify(context.documentId)})`;
      try {
        if (request.action === 'fill') selection = request.selection;
        reply.postMessage(await webFrame.executeJavaScriptInIsolatedWorld(autofillWorld, [{ code }], request.action === 'fill'));
      } catch {
        reply.postMessage('unavailable');
      } finally {
        if (request.action === 'fill') selection = undefined;
      }
    });
  };
  /** 初始化诊断不包含源码、凭据或库内容；显式填充入口会报告实际不可用。 */
  const initialize = (): void => {
    void start().catch(() => console.warn('Zeus password autofill initialization failed.'));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
}
