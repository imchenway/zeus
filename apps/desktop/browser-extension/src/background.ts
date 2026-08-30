/* Zeus Chrome/Edge MV3 service worker。构建脚本替换三个受控占位符。 */
const ZEUS_SURFACE = '__ZEUS_SURFACE__';
const ZEUS_NATIVE_HOST = '__ZEUS_NATIVE_HOST__';
const ZEUS_CONTRACT_VERSION = '26.825.32147';
const generations = new Map();
const latestClaims = new Map();
const claimedTabs = new Map();
const zeusOwnedTabs = new Map();
const handles = new Map();
const managementAudit = [];
const cdpEvents = new Map();
const cdpAttachedTabs = new Set();
let cdpSequence = 0;
let nativePort = null;
let reconnectTimer = null;
const nativeConnectionId = crypto.randomUUID();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    generations.set(tabId, (generations.get(tabId) || 0) + 1);
    claimedTabs.delete(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  generations.delete(tabId);
  latestClaims.delete(tabId);
  claimedTabs.delete(tabId);
  zeusOwnedTabs.delete(tabId);
  for (const [id, handle] of handles) if (handle.tabId === tabId) handles.delete(id);
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  const events = cdpEvents.get(source.tabId) || [];
  events.push({ sequence: ++cdpSequence, method, params, source });
  if (events.length > 5000) events.splice(0, events.length - 5000);
  cdpEvents.set(source.tabId, events);
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) cdpAttachedTabs.delete(source.tabId);
});
connectNative();
chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
setInterval(() => nativePort?.postMessage({ type: 'poll', surface: ZEUS_SURFACE, connectionId: nativeConnectionId, at: Date.now() }), 5000);

function connectNative() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(ZEUS_NATIVE_HOST);
    nativePort.onMessage.addListener((message) => void receiveCommand(message));
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectNative, 2000);
    });
    nativePort.postMessage({ type: 'hello', surface: ZEUS_SURFACE, connectionId: nativeConnectionId, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version, contractVersion: ZEUS_CONTRACT_VERSION });
  } catch {
    nativePort = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectNative, 2000);
  }
}

async function receiveCommand(command) {
  if (!command || command.type === 'noop') return;
  if (command.type !== 'command' || typeof command.id !== 'string') return;
  try {
    const result = await executeCommand(command);
    nativePort?.postMessage({ type: 'result', connectionId: nativeConnectionId, id: command.id, success: true, ...result });
  } catch (error) {
    nativePort?.postMessage({ type: 'result', connectionId: nativeConnectionId, id: command.id, success: false, error: { code: error.code || 'ZEUS_BROWSER_EXTENSION_OPERATION_FAILED', message: error.message || String(error) } });
  }
}

async function executeCommand(command) {
  if (command.tool === '__preflight') return sensitivePreflight(command);
  if (command.tool === 'catalog') return { value: { contractVersion: ZEUS_CONTRACT_VERSION, surface: ZEUS_SURFACE } };
  if (command.tool === 'release_handles') {
    const requested = Array.isArray(command.arguments?.handles) ? new Set(command.arguments.handles.map(String)) : null;
    let released = 0;
    for (const [id, handle] of handles) {
      if (handle.turnId !== command.identity.turnId || (requested && !requested.has(id))) continue;
      handles.delete(id);
      released += 1;
    }
    return { value: { released } };
  }
  if (command.tool === 'invoke') return invokeAdvanced(command);
  return invokeConvenience(command);
}

async function sensitivePreflight(command) {
  const request = command.arguments?.original || {};
  const tool = String(request.tool || '');
  const args = normalizeMethodArguments(request.arguments || {});
  let tab;
  let info = null;
  if (tool === 'click' || tool === 'type') {
    tab = await resolveClaimedConvenienceTab(command, args.tabId);
    info = await sendPage(tab.id, 'element', { target: args.target });
  } else if (tool === 'press') {
    tab = await resolveClaimedConvenienceTab(command, args.tabId);
    info = await sendPage(tab.id, 'focused_element', {});
  } else if (tool === 'invoke') {
    const path = String(args.path || '');
    const methodArgs = args.arguments || {};
    tab = await tabForAdvanced(command, args, methodArgs);
    if (path.startsWith('PlaywrightLocator.')) {
      const handle = requireHandle(command, args.handle, 'PlaywrightLocator');
      info = await sendPage(tab.id, 'locator', { query: handle.payload.query, operation: 'info' });
    } else if (path.startsWith('AXAPI.')) {
      const target = axTarget(methodArgs);
      info = Array.isArray(target) ? await sendPage(tab.id, 'element_at_point', { x: target[0], y: target[1] }) : await sendPage(tab.id, 'element', { target });
    } else if (path.startsWith('DomCUAAPI.') && methodArgs.node_id) info = await sendPage(tab.id, 'element', { target: methodArgs.node_id });
    else if (path.startsWith('CUAAPI.') && methodArgs.x != null && methodArgs.y != null) info = await sendPage(tab.id, 'element_at_point', { x: methodArgs.x, y: methodArgs.y });
  }
  const descriptor = info ? `${info.role || ''} ${info.name || ''} ${info.text || ''} ${info.type || ''} ${info.navigationUrl || ''}`.trim().slice(0, 1000) : '';
  const sensitive = Boolean(
    info?.submitter ||
    info?.secure ||
    /\b(buy|purchase|pay|checkout|order|submit|send|publish|delete|remove|confirm|authorize|transfer|sign|login|password|otp|cvv|注册|登录|提交|发送|发布|购买|支付|下单|删除|确认|授权|转账|密码|验证码)\b/iu.test(descriptor),
  );
  return { value: { sensitive, descriptor, unknown: !info } };
}

async function invokeConvenience(command) {
  const args = command.arguments || {};
  if (command.tool === 'list_tabs') return { value: await openTabsForClaim() };
  if (command.tool === 'open') {
    const tab = await chrome.tabs.create({ url: requireUrl(args.url), active: true });
    zeusOwnedTabs.set(tab.id, command.identity.conversationId);
    await waitForTabReady(tab.id, args.timeoutMs);
    await startDialogMonitor(tab).catch(() => {});
    return { value: tabProjection(await chrome.tabs.get(tab.id)) };
  }
  const tab = await resolveClaimedConvenienceTab(command, args.tabId);
  if (command.tool === 'select_tab') {
    await chrome.tabs.update(tab.id, { active: true });
    return { value: tabProjection(await chrome.tabs.get(tab.id)) };
  }
  if (command.tool === 'close_tab') {
    await chrome.tabs.remove(tab.id);
    return { value: { closed: true, tabId: tab.id } };
  }
  if (command.tool === 'navigate') {
    await chrome.tabs.update(tab.id, { url: requireUrl(args.url) });
    await waitForTabReady(tab.id, args.timeoutMs);
    return { value: tabProjection(await chrome.tabs.get(tab.id)) };
  }
  if (command.tool === 'history') {
    if (args.action === 'back') await chrome.tabs.goBack(tab.id);
    else if (args.action === 'forward') await chrome.tabs.goForward(tab.id);
    else if (args.action === 'reload') await chrome.tabs.reload(tab.id);
    else if (args.action === 'stop') await chrome.tabs.executeScript?.(tab.id, { code: 'window.stop()' });
    else throw failure('ZEUS_BROWSER_HISTORY_ACTION_INVALID', `Unsupported history action: ${args.action}`);
    if (args.action !== 'stop') await waitForTabReady(tab.id, args.timeoutMs);
    return { value: tabProjection(await chrome.tabs.get(tab.id)) };
  }
  if (command.tool === 'screenshot') return captureTab(tab, args.options || {});
  if (command.tool === 'downloads') return { value: await requireOptionalPermission('downloads', () => chrome.downloads.search({ limit: 200 })) };
  if (command.tool === 'clipboard') return invokeClipboard(args);
  if (command.tool === 'developer') return invokeCdp(tab, args.method, args.params || {});
  if (command.tool === 'snapshot') return { value: await sendPage(tab.id, 'snapshot', args) };
  if (command.tool === 'element') return { value: await sendPage(tab.id, 'element', args) };
  if (command.tool === 'click') return { value: await sendPage(tab.id, 'locator', { query: targetQuery(args.target), operation: 'click' }) };
  if (command.tool === 'type') return { value: await sendPage(tab.id, 'locator', { query: targetQuery(args.target), operation: args.replace === false ? 'type' : 'fill', text: args.text }) };
  if (command.tool === 'press') return { value: await sendPage(tab.id, 'locator', { query: { selector: ':focus', visible: false }, operation: 'press', key: args.key }) };
  if (command.tool === 'scroll') return { value: await sendPage(tab.id, 'coordinate_scroll', { deltaX: args.x || 0, deltaY: args.y || 0 }) };
  if (command.tool === 'wait') return { value: await sendPage(tab.id, 'wait_selector', args) };
  throw failure('ZEUS_BROWSER_TOOL_UNSUPPORTED', `Unsupported browser tool: ${command.tool}`);
}

async function invokeAdvanced(command) {
  const request = command.arguments || {};
  const path = String(request.path || '');
  const split = path.lastIndexOf('.');
  if (split < 1) throw failure('ZEUS_BROWSER_METHOD_INVALID', `Invalid Browser contract path: ${path}`);
  const api = path.slice(0, split);
  const method = path.slice(split + 1);
  const args = normalizeMethodArguments(request.arguments || {});
  if (api === 'Agent' && method === 'browsers') return { value: rootHandle(command, 'Browsers') };
  if (api === 'Agent' && method === 'documentation') return { value: rootHandle(command, 'Documentation') };
  if (api === 'Browsers' && method === 'list')
    return {
      value: [
        {
          id: browserId(),
          name: ZEUS_SURFACE === 'edge' ? 'Microsoft Edge' : 'Google Chrome',
          family: 'chromium',
          type: 'external',
          capabilities: capabilities(),
          metadata: { surface: ZEUS_SURFACE, contractVersion: ZEUS_CONTRACT_VERSION },
        },
      ],
    };
  if (api === 'Browsers' && ['get', 'getDefault', 'getForUrl'].includes(method)) return { value: rootHandle(command, 'Browser', { browserId: browserId() }) };
  if (api === 'Browser' && method === 'browserId') return { value: browserId() };
  if (api === 'Browser' && method === 'capabilities') return { value: rootHandle(command, 'BrowserCapabilityCollection') };
  if (api === 'Browser' && method === 'tabs') return { value: rootHandle(command, 'Tabs') };
  if (api === 'Browser' && method === 'user') return { value: rootHandle(command, 'BrowserUser') };
  if (api === 'Browser' && method === 'documentation') return { value: rootHandle(command, 'Documentation') };
  if (api === 'Browser' && method === 'history') return browserHistory(args.options || {});
  if (api === 'Browser' && method === 'nameSession') {
    await chrome.storage.session.set({ zeusSessionName: String(args.name || '').slice(0, 200) });
    return { value: { name: String(args.name || '').slice(0, 200) } };
  }
  if (api === 'BrowserCapabilityCollection' && method === 'list') return { value: browserCapabilities() };
  if (api === 'BrowserCapabilityCollection' && method === 'get') {
    const kind = browserCapabilityKind(String(args.id || ''));
    if (!kind) throw failure('ZEUS_BROWSER_UNSUPPORTED_SURFACE', `unsupported_surface: Browser capability ${args.id} is not advertised by ${ZEUS_SURFACE}.`);
    return { value: rootHandle(command, kind) };
  }
  if (api === 'TabCapabilityCollection' && method === 'list') return { value: tabCapabilities() };
  if (api === 'TabCapabilityCollection' && method === 'get') {
    const kind = tabCapabilityKind(String(args.id || ''));
    if (!kind) throw failure('ZEUS_BROWSER_UNSUPPORTED_SURFACE', `unsupported_surface: Tab capability ${args.id} is not advertised by ${ZEUS_SURFACE}.`);
    return { value: handleFor(command, kind, await tabForAdvanced(command, request, args)) };
  }
  if (api === 'BrowserUser' && method === 'openTabs') return { value: await openTabsForClaim() };
  if (api === 'BrowserUser' && method === 'claimTab') return { value: await claimTab(command, args) };
  if (api === 'Tabs' && method === 'content') return { value: await extractTemporaryTabsContent(command, args.options || {}) };
  if (api === 'Tabs' && method === 'get') return { value: handleFor(command, 'Tab', await resolveClaimedConvenienceTab(command, args.tabId || args.id)) };
  if (api === 'Tabs' && method === 'list') return { value: (await chrome.tabs.query({})).filter((tab) => zeusOwnedTabs.get(tab.id) === command.identity.conversationId).map((tab) => handleFor(command, 'Tab', tab)) };
  if (api === 'Tabs' && method === 'selected') return { value: handleFor(command, 'Tab', await resolveClaimedConvenienceTab(command)) };
  if (api === 'Tabs' && method === 'new') {
    const tab = await chrome.tabs.create({ url: args.url ? requireUrl(args.url) : 'about:blank', active: args.active !== false });
    zeusOwnedTabs.set(tab.id, command.identity.conversationId);
    if (args.url) await waitForTabReady(tab.id, args.timeoutMs);
    await startDialogMonitor(tab).catch(() => {});
    return { value: handleFor(command, 'Tab', await chrome.tabs.get(tab.id)) };
  }
  if (api === 'Documentation' && method === 'get') return { value: { version: ZEUS_CONTRACT_VERSION, name: args.name } };
  if (api === 'BrowserUser') return invokeBrowserUser(method, args);
  if (api === 'VisibilityBrowserCapability') {
    const visibilityTab = await resolveClaimedConvenienceTab(command, args.tabId);
    const targetWindow = await chrome.windows.get(visibilityTab.windowId);
    if (method === 'get') return { value: targetWindow.state !== 'minimized' };
    await chrome.windows.update(visibilityTab.windowId, args.visible === false ? { state: 'minimized' } : { state: 'normal', focused: true });
    return { value: { visible: args.visible !== false, windowId: String(visibilityTab.windowId) } };
  }
  if (api === 'ViewportBrowserCapability') {
    const viewportTab = await resolveClaimedConvenienceTab(command, args.tabId);
    return invokeViewport(viewportTab, method, args);
  }
  const tab = await tabForAdvanced(command, request, args);
  if (api === 'Tab') return invokeTab(command, tab, method, args);
  if (api === 'AXAPI') return invokeAx(tab, method, args);
  if (api === 'ContentAPI') return invokeContentExport(tab, method, args);
  if (api === 'CUAAPI') return invokeCua(tab, method, args);
  if (api === 'DomCUAAPI') return invokeDomCua(tab, method, args);
  if (api === 'PlaywrightAPI') return invokePlaywright(command, tab, method, args);
  if (api === 'PlaywrightFrameLocator' || api === 'PlaywrightLocator') return invokeLocatorHandle(command, tab, api, method, request.handle, args);
  if (api === 'TabClipboardAPI') {
    if (args.__phase === 'validate') {
      const permission = /^read/iu.test(method) ? 'clipboardRead' : 'clipboardWrite';
      await requireOptionalPermission(permission, () => Promise.resolve());
      return { value: { validated: true, method } };
    }
    return invokeClipboard({ action: /read/iu.test(method) ? 'read' : 'write', text: args.text || args.value });
  }
  if (api === 'PlaywrightDownload') return invokeDownload(method, { ...args, handle: request.handle, identity: command.identity });
  if (api === 'PlaywrightFileChooser') return invokeFileChooser(tab, method, request.handle, { ...args, identity: command.identity });
  if (api === 'TabDevAPI' && method === 'logs') return invokeDevLogs(tab, args);
  if (api === 'ManagementBrowserCapability') return invokeManagementRoot(command, method);
  if (api === 'ManagementBookmarksAPI') return invokeManagementBookmarks(method, args);
  if (api === 'ManagementTabGroupsAPI') return invokeManagementTabGroups(method, args);
  if (api === 'ManagementTabsAPI') return invokeManagementTabs(method, args);
  if (api === 'CdpTabCapability') return invokeCdpCapability(tab, method, args);
  if (api === 'BotDetectionTabCapability' && method === 'report') return { value: { status: 'reported', reason: args.reason, hostname: safeOrigin(tab.url || '') } };
  if (api === 'BrowserAuthTabCapability' && method === 'request') return invokeBrowserAuth(command, tab, args);
  if (api === 'PageAssetsTabCapability') return invokePageAssets(tab, method, args);
  if (api === 'WebMcpTabCapability' && method === 'fetchTools') {
    const tools = await sendPage(tab.id, 'webmcp_tools', {});
    if (!Array.isArray(tools)) throw failure('ZEUS_BROWSER_UNSUPPORTED_SURFACE', 'unsupported_surface: The current page does not expose WebMCP.');
    return { value: handleFor(command, 'WebMcpTools', tab, { tools }) };
  }
  if (api === 'WebMcpTools') {
    const webHandle = requireHandle(command, request.handle, 'WebMcpTools');
    if (method === 'description') return { value: webHandle.payload.tools || [] };
    return { value: await sendPage(tab.id, 'webmcp_call', { name: args.name || args.tool, input: args.input || args.arguments || {} }) };
  }
  if (['AlertDialog', 'BeforeUnloadDialog', 'ConfirmDialog', 'PromptDialog'].includes(api)) return invokeDialog(command, tab, api, method, request.handle, args);
  throw failure('ZEUS_BROWSER_METHOD_UNSUPPORTED', `The ${ZEUS_SURFACE} adapter does not implement ${path}.`);
}

async function invokeTab(command, tab, method, args) {
  if (method === 'id') return { value: String(tab.id) };
  if (method === 'title') return { value: tab.title || '' };
  if (method === 'url') return { value: tab.url || '' };
  if (method === 'capabilities') return { value: handleFor(command, 'TabCapabilityCollection', tab) };
  if (method === 'ax') return { value: handleFor(command, 'AXAPI', tab) };
  if (method === 'clipboard') return { value: handleFor(command, 'TabClipboardAPI', tab) };
  if (method === 'content') return { value: handleFor(command, 'ContentAPI', tab) };
  if (method === 'cua') return { value: handleFor(command, 'CUAAPI', tab) };
  if (method === 'dev') return { value: handleFor(command, 'TabDevAPI', tab) };
  if (method === 'dom_cua') return { value: handleFor(command, 'DomCUAAPI', tab) };
  if (method === 'playwright') return { value: handleFor(command, 'PlaywrightAPI', tab) };
  if (method === 'goto') {
    await chrome.tabs.update(tab.id, { url: requireUrl(args.url) });
    await waitForTabReady(tab.id, args.timeoutMs);
    return { value: handleFor(command, 'Tab', await chrome.tabs.get(tab.id)) };
  }
  if (method === 'back') {
    await chrome.tabs.goBack(tab.id);
    await waitForTabReady(tab.id, args.timeoutMs);
    return { value: true };
  }
  if (method === 'forward') {
    await chrome.tabs.goForward(tab.id);
    await waitForTabReady(tab.id, args.timeoutMs);
    return { value: true };
  }
  if (method === 'reload') {
    await chrome.tabs.reload(tab.id);
    await waitForTabReady(tab.id, args.timeoutMs);
    return { value: true };
  }
  if (method === 'stop') {
    await invokeCdp(tab, 'Page.stopLoading', {});
    return { value: true };
  }
  if (method === 'close') {
    await chrome.tabs.remove(tab.id);
    return { value: true };
  }
  if (method === 'markDeliverable' || method === 'markHandoff' || method === 'requestManualHandoff') {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { value: { tabId: String(tab.id), state: method, userVisible: true } };
  }
  if (method === 'screenshot') return captureTab(tab, args.options || {});
  if (method === 'getJsDialog') return getJsDialog(command, tab);
  throw failure('ZEUS_BROWSER_TAB_METHOD_UNSUPPORTED', `Unsupported Tab method: ${method}`);
}

async function invokeCua(tab, method, args) {
  const options = args.options && typeof args.options === 'object' ? args.options : args;
  if (method === 'click' || method === 'double_click') return { value: await sendPage(tab.id, 'coordinate_click', { ...options, clickCount: method === 'double_click' ? 2 : 1 }) };
  if (method === 'drag') return { value: await sendPage(tab.id, 'coordinate_drag', options) };
  if (method === 'move') return { value: await sendPage(tab.id, 'coordinate_move', options) };
  if (method === 'scroll') return { value: await sendPage(tab.id, 'coordinate_scroll', { ...options, deltaX: options.scrollX, deltaY: options.scrollY }) };
  if (method === 'downloadMedia') return downloadPageMedia(tab, { x: options.x, y: options.y });
  if (method === 'type') return { value: await sendPage(tab.id, 'locator', { query: { selector: ':focus', visible: false }, operation: 'type', text: options.text }) };
  if (method === 'keypress') return { value: await sendPage(tab.id, 'locator', { query: { selector: ':focus', visible: false }, operation: 'press', key: options.keys?.join('+') }) };
  throw failure('ZEUS_BROWSER_CUA_METHOD_UNSUPPORTED', `Unsupported CUA method: ${method}`);
}

async function invokeDomCua(tab, method, args) {
  if (method === 'get_visible_dom') return { value: await sendPage(tab.id, 'snapshot', args) };
  const options = args.options && typeof args.options === 'object' ? args.options : args;
  if (method === 'type') return { value: await sendPage(tab.id, 'locator', { query: { selector: ':focus', visible: false }, operation: 'type', text: options.text }) };
  if (method === 'keypress') return { value: await sendPage(tab.id, 'locator', { query: { selector: ':focus', visible: false }, operation: 'press', key: options.keys?.join('+') }) };
  if (method === 'scroll' && !options.node_id) return { value: await sendPage(tab.id, 'coordinate_scroll', { deltaX: options.x, deltaY: options.y }) };
  const target = domTarget(options);
  if (method === 'click' || method === 'double_click') return { value: await sendPage(tab.id, 'locator', { query: targetQuery(target), operation: method === 'double_click' ? 'dblclick' : 'click' }) };
  if (method === 'scroll') return { value: await sendPage(tab.id, 'dom_scroll', { target, deltaX: options.x || 0, deltaY: options.y || 0 }) };
  if (method === 'downloadMedia') return downloadPageMedia(tab, { target });
  throw failure('ZEUS_BROWSER_DOM_CUA_METHOD_UNSUPPORTED', `Unsupported DOM CUA method: ${method}`);
}

async function invokeAx(tab, method, args) {
  if (method === 'get' || method === 'write') {
    const mode = String(args.mode || 'state');
    if (mode === 'screenshot') return captureTab(tab, {});
    const state = await sendPage(tab.id, 'snapshot', args.options || {});
    if (mode === 'both') {
      const screenshot = await captureTab(tab, {});
      return { value: state, image: screenshot.image };
    }
    return { value: state };
  }
  if (method === 'drag') {
    const from = axPoint(args.from, 'from');
    const to = axPoint(args.to, 'to');
    return { value: await sendPage(tab.id, 'coordinate_drag', { x: from[0], y: from[1], endX: to[0], endY: to[1] }) };
  }
  if (method === 'pressKey') return { value: await sendPage(tab.id, 'locator', { query: { selector: ':focus', visible: false }, operation: 'press', key: args.key }) };
  if (method === 'typeText') return { value: await sendPage(tab.id, 'locator', { query: { selector: ':focus', visible: false }, operation: 'type', text: args.text }) };
  const target = axTarget(args);
  if (method === 'click') return { value: await sendPage(tab.id, 'ax_click', { target, mouseButton: args.mouseButton, clickCount: args.clickCount || 1 }) };
  if (method === 'performSecondaryAction') return { value: await sendPage(tab.id, 'ax_action', { target, action: args.action }) };
  if (method === 'scroll')
    return {
      value: Array.isArray(target)
        ? await sendPage(tab.id, 'coordinate_scroll', {
            x: target[0],
            y: target[1],
            deltaY: ['up', 'down'].includes(args.direction) ? axScrollDelta(args.direction, args.pages) : 0,
            deltaX: ['left', 'right'].includes(args.direction) ? axScrollDelta(args.direction, args.pages) : 0,
          })
        : await sendPage(tab.id, 'dom_scroll', { target, direction: args.direction, pages: args.pages }),
    };
  if (method === 'selectText') return { value: await sendPage(tab.id, 'select_text', { target, text: args.text, ...args.options }) };
  if (method === 'setValue') return { value: await sendPage(tab.id, 'locator', { query: targetQuery(target), operation: 'fill', text: args.value }) };
  throw failure('ZEUS_BROWSER_AX_METHOD_UNSUPPORTED', `Unsupported AX method: ${method}`);
}

function axTarget(args) {
  if (Array.isArray(args.target)) return axPoint(args.target, 'target');
  if (Number.isInteger(args.target)) return `e${Number(args.target) + 1}`;
  if (typeof args.target === 'string') return args.target;
  if (Number.isInteger(args.elementIndex)) return `e${Number(args.elementIndex) + 1}`;
  if (Number.isInteger(args.element_index)) return `e${Number(args.element_index) + 1}`;
  throw failure('ZEUS_BROWSER_AX_TARGET_REQUIRED', 'AX operation requires an element index or viewport point.');
}

function axPoint(value, name) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((coordinate) => Number.isFinite(Number(coordinate)))) throw failure('ZEUS_BROWSER_AX_POINT_INVALID', `${name} must be a two-coordinate viewport point.`);
  return [Number(value[0]), Number(value[1])];
}

function axScrollDelta(direction, pages) {
  const amount = Math.max(0.1, Math.min(Number(pages) || 1, 100)) * 600;
  return direction === 'up' || direction === 'left' ? -amount : amount;
}

function domTarget(args) {
  if (typeof args.node_id === 'string') return args.node_id;
  if (typeof args.target === 'string') return args.target;
  if (typeof args.selector === 'string') return args.selector;
  throw failure('ZEUS_BROWSER_DOM_TARGET_REQUIRED', 'DOM CUA operation requires node_id.');
}

async function downloadPageMedia(tab, location) {
  const url = await sendPage(tab.id, 'media_url', location);
  return { value: await requireOptionalPermission('downloads', async () => ({ downloadId: await chrome.downloads.download({ url: String(url), saveAs: false }), url })) };
}

async function invokeDevLogs(tab, args) {
  await ensureDebugger(tab);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.enable', {}).catch(() => {});
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Log.enable', {}).catch(() => {});
  const levels = Array.isArray(args.levels) ? new Set(args.levels.map(String)) : null;
  const filter = String(args.filter || '').toLocaleLowerCase();
  const limit = Math.max(1, Math.min(Number(args.limit) || 200, 500));
  return {
    value: (cdpEvents.get(tab.id) || [])
      .filter((event) => event.method === 'Runtime.consoleAPICalled' || event.method === 'Log.entryAdded')
      .map((event) => ({
        sequence: event.sequence,
        method: event.method,
        level: event.params?.type || event.params?.entry?.level || 'log',
        text: event.params?.entry?.text || (event.params?.args || []).map((value) => value.value ?? value.description ?? '').join(' '),
        timestamp: event.params?.timestamp || event.params?.entry?.timestamp || null,
      }))
      .filter((entry) => (!levels || levels.has(entry.level)) && (!filter || String(entry.text).toLocaleLowerCase().includes(filter)))
      .slice(-limit),
  };
}

async function getJsDialog(command, tab) {
  await startDialogMonitor(tab);
  const latest = [...(cdpEvents.get(tab.id) || [])].reverse().find((event) => event.method === 'Page.javascriptDialogOpening' || event.method === 'Page.javascriptDialogClosed');
  if (!latest || latest.method !== 'Page.javascriptDialogOpening') return { value: null };
  const type = String(latest.params?.type || 'alert');
  const kind = type === 'beforeunload' ? 'BeforeUnloadDialog' : type === 'confirm' ? 'ConfirmDialog' : type === 'prompt' ? 'PromptDialog' : 'AlertDialog';
  return { value: handleFor(command, kind, tab, { type, sequence: latest.sequence }) };
}

async function invokeDialog(command, tab, api, method, handleId, args) {
  const handle = requireHandle(command, handleId, api);
  const latest = [...(cdpEvents.get(tab.id) || [])].reverse().find((event) => event.method === 'Page.javascriptDialogOpening' || event.method === 'Page.javascriptDialogClosed');
  if (!latest || latest.method !== 'Page.javascriptDialogOpening' || latest.sequence !== handle.payload.sequence) {
    throw failure('ZEUS_BROWSER_DIALOG_STALE', 'The JavaScript dialog was closed or replaced; call Tab.getJsDialog again.');
  }
  if (method === 'type') return { value: api.replace('Dialog', '').toLocaleLowerCase() };
  await ensureDebugger(tab);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.handleJavaScriptDialog', { accept: method === 'accept', ...(method === 'accept' && typeof args.text === 'string' ? { promptText: args.text } : {}) });
  return { value: { handled: true, action: method } };
}

async function invokePlaywright(command, tab, method, args) {
  if (method === 'evaluate') return { value: await sendPage(tab.id, 'evaluate', { expression: scriptExpression(args.pageFunction ?? args.expression), argument: args.arg ?? null }) };
  if (method === 'domSnapshot') return { value: await sendPage(tab.id, 'snapshot', args) };
  if (method === 'elementInfo') return { value: await sendPage(tab.id, 'element_at_point', { x: args.x, y: args.y }) };
  if (method === 'elementScreenshot') return captureElement(tab, args);
  if (method === 'waitForTimeout') {
    await new Promise((resolve) => setTimeout(resolve, Math.min(Number(args.timeout || args.timeoutMs) || 0, 30_000)));
    return { value: true };
  }
  if (method === 'expectNavigation') {
    if (!args.action || typeof args.action !== 'object' || args.action.path === 'PlaywrightAPI.expectNavigation')
      throw failure('ZEUS_BROWSER_NAVIGATION_ACTION_INVALID', 'expectNavigation requires a non-recursive frozen Browser action descriptor.');
    const result = await invokeAdvanced({ ...command, arguments: args.action });
    await waitForTabReady(tab.id, args.options?.timeoutMs);
    return result;
  }
  if (method === 'waitForLoadState') {
    await waitForTabReady(tab.id, args.options?.timeoutMs);
    return { value: { loaded: true, url: (await chrome.tabs.get(tab.id)).url, documentGeneration: generations.get(tab.id) || 1 } };
  }
  if (method === 'waitForURL') {
    const expected = String(args.url || args.pattern || '');
    const timeout = Math.min(Number(args.timeoutMs) || 30_000, 30_000);
    const started = Date.now();
    while (Date.now() - started <= timeout) {
      const current = (await chrome.tabs.get(tab.id)).url || '';
      if (current === expected || current.includes(expected)) return { value: { matched: true, url: current } };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw failure('ZEUS_BROWSER_WAIT_TIMEOUT', `Timed out waiting for URL: ${expected}`);
  }
  if (method === 'waitForEvent') return waitForPlaywrightEvent(command, tab, args);
  if (method === 'locator' || method.startsWith('getBy')) return { value: locatorHandle(command, tab, queryForMethod(method, args)) };
  if (method === 'frameLocator') return { value: handleFor(command, 'PlaywrightFrameLocator', tab, { query: { selector: args.frameSelector || args.selector } }) };
  if (method === 'getByTestId') return { value: locatorHandle(command, tab, { testId: args.testId || args.value }) };
  throw failure('ZEUS_BROWSER_PLAYWRIGHT_METHOD_UNSUPPORTED', `Unsupported Playwright method: ${method}`);
}

async function waitForPlaywrightEvent(command, tab, args) {
  const eventName = String(args.event || '');
  const timeoutMs = Math.max(1000, Math.min(Number(args.options?.timeoutMs) || 30_000, 120_000));
  await ensureDebugger(tab);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {});
  const afterSequence = cdpSequence;
  if (eventName === 'download') {
    await requireOptionalPermission('downloads', () => Promise.resolve());
    const event = await waitForCdpEvent(tab.id, 'Page.downloadWillBegin', afterSequence, timeoutMs);
    if (!event) throw failure('ZEUS_BROWSER_WAIT_TIMEOUT', 'Timed out waiting for a new download from the claimed tab.');
    const download = await findChromeDownload(event.params?.url, Date.now() - timeoutMs);
    return {
      value: handleFor(command, 'PlaywrightDownload', tab, {
        downloadId: download?.id ?? null,
        guid: event.params?.guid ?? null,
        suggestedFilename: event.params?.suggestedFilename ?? download?.filename ?? null,
        url: event.params?.url ?? download?.url ?? null,
      }),
    };
  }
  if (eventName === 'filechooser') {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.setInterceptFileChooserDialog', { enabled: true });
    const event = await waitForCdpEvent(tab.id, 'Page.fileChooserOpened', afterSequence, timeoutMs);
    if (!event) {
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
      throw failure('ZEUS_BROWSER_WAIT_TIMEOUT', 'Timed out waiting for a file chooser from the claimed tab.');
    }
    return { value: handleFor(command, 'PlaywrightFileChooser', tab, { backendNodeId: event.params?.backendNodeId, frameId: event.params?.frameId }) };
  }
  throw failure('ZEUS_BROWSER_EVENT_UNSUPPORTED', `Unsupported Playwright event: ${eventName}`);
}

async function waitForCdpEvent(tabId, method, afterSequence, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const event = (cdpEvents.get(tabId) || []).find((entry) => entry.sequence > afterSequence && entry.method === method);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function findChromeDownload(url, startedAfter) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= 2000) {
    const values = await chrome.downloads.search({ limit: 100, orderBy: ['-startTime'] });
    const match = values.find((entry) => (!url || entry.url === url || entry.finalUrl === url) && Date.parse(entry.startTime || '') >= startedAfter);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function invokeLocatorHandle(command, tab, api, method, handleId, args) {
  const handle = requireHandle(command, handleId, api);
  if (api === 'PlaywrightFrameLocator') {
    if (method === 'frameLocator') return { value: handleFor(command, 'PlaywrightFrameLocator', tab, { query: { selector: args.frameSelector || args.selector, parentFrame: handle.payload.query } }) };
    return { value: locatorHandle(command, tab, { ...queryForMethod(method, args), frame: handle.payload.query }) };
  }
  if (method === 'first') return { value: locatorHandle(command, tab, { ...handle.payload.query, index: 0 }) };
  if (method === 'last') {
    const count = await sendPage(tab.id, 'locator', { query: handle.payload.query, operation: 'count' });
    return { value: locatorHandle(command, tab, { ...handle.payload.query, index: Math.max(0, count - 1) }) };
  }
  if (method === 'nth') return { value: locatorHandle(command, tab, { ...handle.payload.query, index: Number(args.index) || 0 }) };
  if (method === 'filter') {
    const options = { ...(args.options || args) };
    if (options.has !== undefined) options.has = requireHandle(command, options.has, 'PlaywrightLocator').payload.query;
    if (options.hasNot !== undefined) options.hasNot = requireHandle(command, options.hasNot, 'PlaywrightLocator').payload.query;
    return { value: locatorHandle(command, tab, { ...handle.payload.query, filter: options }) };
  }
  if (method === 'and' || method === 'or') {
    const other = requireHandle(command, args.locator, 'PlaywrightLocator');
    return { value: locatorHandle(command, tab, { combine: method, left: handle.payload.query, right: other.payload.query }) };
  }
  if (method === 'locator' || method.startsWith('getBy')) return { value: locatorHandle(command, tab, { ...queryForMethod(method, args), parent: handle.payload.query }) };
  if (method === 'all') {
    const count = await sendPage(tab.id, 'locator', { query: handle.payload.query, operation: 'count' });
    return { value: Array.from({ length: count }, (_value, index) => locatorHandle(command, tab, { ...handle.payload.query, index })) };
  }
  if (method === 'downloadMedia') {
    const url = await sendPage(tab.id, 'locator', { query: handle.payload.query, operation: 'mediaUrl' });
    return { value: await requireOptionalPermission('downloads', async () => ({ downloadId: await chrome.downloads.download({ url: String(url), saveAs: false }), url })) };
  }
  const normalized = { ...args };
  if (method === 'press') normalized.key = args.value;
  if (method === 'pressSequentially' || method === 'type') normalized.text = args.value;
  if (method === 'evaluate' || method === 'evaluateAll') {
    normalized.argument = args.arg;
    normalized.expression = scriptExpression(args.pageFunction ?? args.expression);
  }
  return { value: await sendPage(tab.id, 'locator', { query: handle.payload.query, operation: method, ...normalized }) };
}

async function invokeBrowserUser(method, args) {
  if (method === 'getHistory')
    return { value: await requireOptionalPermission('history', () => chrome.history.search({ text: String(args.query || ''), maxResults: Math.min(Number(args.maxResults) || 100, 1000), startTime: Number(args.startTime) || 0 })) };
  if (method === 'getBookmarks') return { value: await requireOptionalPermission('bookmarks', () => chrome.bookmarks.getTree()) };
  if (method === 'getDownloads') return { value: await requireOptionalPermission('downloads', () => chrome.downloads.search({ limit: 1000 })) };
  if (method === 'getProfile')
    return { value: { surface: ZEUS_SURFACE, browserId: browserId(), extensionId: chrome.runtime.id, incognitoAccess: chrome.extension?.isAllowedIncognitoAccess ? await chrome.extension.isAllowedIncognitoAccess() : false } };
  if (method === 'getWindows') return { value: await chrome.windows.getAll({ populate: true }) };
  if (method === 'getTabGroups' && chrome.tabGroups) return { value: await chrome.tabGroups.query({}) };
  throw failure('ZEUS_BROWSER_USER_METHOD_UNSUPPORTED', `Unsupported BrowserUser method: ${method}`);
}

function invokeManagementRoot(command, method) {
  if (method === 'bookmarks') return { value: rootHandle(command, 'ManagementBookmarksAPI') };
  if (method === 'tabGroups') return { value: rootHandle(command, 'ManagementTabGroupsAPI') };
  if (method === 'tabs') return { value: rootHandle(command, 'ManagementTabsAPI') };
  if (method === 'getAuditTrail') return { value: { changes: managementAudit.slice(-500).reverse() } };
  throw failure('ZEUS_BROWSER_MANAGEMENT_METHOD_UNSUPPORTED', `Unsupported management method: ${method}`);
}

async function invokeManagementBookmarks(method, args) {
  const readMethods = new Set(['get', 'getChildren', 'getRecent', 'getSubTree', 'getTree', 'search']);
  const writeMethods = new Set(['create', 'move', 'update', 'remove', 'removeTree']);
  if (!readMethods.has(method) && !writeMethods.has(method)) throw failure('ZEUS_BROWSER_MANAGEMENT_METHOD_BLOCKED', `Bookmark method is not allowlisted: ${method}`);
  return {
    value: await requireOptionalPermission('bookmarks', async () => {
      const values = managementArgs(args);
      if (writeMethods.has(method)) {
        const details = method === 'create' ? values[0] : method === 'update' ? values[1] : null;
        if (details?.url) {
          const url = new URL(String(details.url));
          if (!['http:', 'https:'].includes(url.protocol)) throw failure('ZEUS_BROWSER_BOOKMARK_URL_BLOCKED', 'Bookmark URLs must use http or https.');
        }
        const before = method === 'create' ? {} : { bookmarks: await chrome.bookmarks.get(String(values[0])).catch(() => []) };
        const result = await chrome.bookmarks[method](...values);
        recordManagement('bookmarks', method, values, before, result);
        return result;
      }
      return chrome.bookmarks[method](...values);
    }),
  };
}

async function invokeManagementTabGroups(method, args) {
  if (!chrome.tabGroups) throw failure('ZEUS_BROWSER_TAB_GROUPS_UNAVAILABLE', 'This browser version does not expose tab groups.');
  const readMethods = new Set(['get', 'query']);
  const writeMethods = new Set(['move', 'update']);
  if (!readMethods.has(method) && !writeMethods.has(method)) throw failure('ZEUS_BROWSER_MANAGEMENT_METHOD_BLOCKED', `Tab-group method is not allowlisted: ${method}`);
  const values = managementArgs(args);
  if (writeMethods.has(method)) {
    const group = await chrome.tabGroups.get(Number(values[0]));
    if (group.shared) throw failure('ZEUS_BROWSER_SHARED_GROUP_BLOCKED', 'Shared tab groups cannot be modified by Zeus.');
    const result = await chrome.tabGroups[method](...values);
    recordManagement('tabGroups', method, values, { groups: [group] }, result);
    return { value: result };
  }
  return { value: await chrome.tabGroups[method](...values) };
}

async function invokeManagementTabs(method, args) {
  const readMethods = new Set(['get', 'query']);
  const writeMethods = new Set(['group', 'move', 'ungroup', 'update']);
  if (!readMethods.has(method) && !writeMethods.has(method)) throw failure('ZEUS_BROWSER_MANAGEMENT_METHOD_BLOCKED', `Tab method is not allowlisted: ${method}`);
  const values = managementArgs(args);
  if (method === 'update' && values[1] && typeof values[1] === 'object' && 'url' in values[1]) throw failure('ZEUS_BROWSER_MANAGEMENT_NAVIGATION_BLOCKED', 'The management capability cannot navigate tabs.');
  if (writeMethods.has(method)) {
    const tabs = await chrome.tabs.query({});
    const first = values[0];
    const rawIds = Array.isArray(first) ? first : Array.isArray(first?.tabIds) ? first.tabIds : [first?.tabId ?? first];
    const affectedIds = new Set(rawIds.map(Number).filter(Number.isInteger));
    const affectedWindows = new Set(tabs.filter((tab) => affectedIds.has(tab.id)).map((tab) => tab.windowId));
    if (chrome.tabGroups && affectedWindows.size > 0) {
      const groups = await chrome.tabGroups.query({});
      if (groups.some((group) => group.shared && affectedWindows.has(group.windowId))) throw failure('ZEUS_BROWSER_SHARED_GROUP_BLOCKED', 'Tab moves are blocked when an affected window contains a shared tab group.');
    }
    const result = await chrome.tabs[method](...values);
    recordManagement('tabs', method, values, { tabLayout: { tabs: tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, index: tab.index, groupId: tab.groupId, pinned: tab.pinned, autoDiscardable: tab.autoDiscardable })) } }, result);
    return { value: result };
  }
  return { value: await chrome.tabs[method](...values) };
}

function managementArgs(args) {
  if (Array.isArray(args.args)) return args.args;
  if (Array.isArray(args.arguments)) return args.arguments;
  if ('id' in args && 'changes' in args) return [args.id, args.changes];
  if ('id' in args && 'destination' in args) return [args.id, args.destination];
  if ('query' in args) return [args.query];
  if ('createDetails' in args) return [args.createDetails];
  if ('options' in args) return [args.options];
  return Object.keys(args).length ? [args] : [];
}

function recordManagement(namespace, method, args, before, result) {
  managementAudit.push({ createdAt: Date.now(), namespace, method, args, before, result: typeof result === 'number' ? result : result?.id ? { id: result.id } : undefined });
  if (managementAudit.length > 1000) managementAudit.splice(0, managementAudit.length - 1000);
}

async function invokeViewport(tab, method, args) {
  await ensureDebugger(tab);
  if (method === 'reset') {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Emulation.clearDeviceMetricsOverride', {});
    return { value: { reset: true } };
  }
  const width = Math.max(200, Math.min(Number(args.width) || 0, 8192));
  const height = Math.max(200, Math.min(Number(args.height) || 0, 8192));
  if (!width || !height) throw failure('ZEUS_BROWSER_VIEWPORT_INVALID', 'Viewport width and height are required.');
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: Number(args.deviceScaleFactor) || 1, mobile: false });
  return { value: { width, height } };
}

async function invokeCdpCapability(tab, method, args) {
  await requireOptionalPermission('debugger', () => Promise.resolve());
  await ensureDebugger(tab);
  if (method === 'send') return { value: await chrome.debugger.sendCommand({ tabId: tab.id }, String(args.method || ''), args.params || {}) };
  if (method === 'readEvents') {
    const afterSequence = Math.max(0, Number(args.afterSequence) || 0);
    const limit = Math.max(1, Math.min(Number(args.limit) || 200, 1000));
    const methods = Array.isArray(args.methods) ? new Set(args.methods.map(String)) : null;
    const all = cdpEvents.get(tab.id) || [];
    const matched = all.filter((event) => event.sequence > afterSequence && (!methods || methods.has(event.method)));
    const events = matched.slice(0, limit);
    return { value: { cursor: events.at(-1)?.sequence || Math.max(afterSequence, cdpSequence), events, hasMore: matched.length > events.length, truncated: afterSequence > 0 && all.length > 0 && afterSequence < all[0].sequence - 1 } };
  }
  throw failure('ZEUS_BROWSER_CDP_METHOD_UNSUPPORTED', `Unsupported CDP capability method: ${method}`);
}

async function ensureDebugger(tab) {
  await requireOptionalPermission('debugger', () => Promise.resolve());
  if (cdpAttachedTabs.has(tab.id)) return;
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  cdpAttachedTabs.add(tab.id);
}

async function startDialogMonitor(tab) {
  await ensureDebugger(tab);
  await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable', {});
}

async function invokeBrowserAuth(command, tab, args) {
  const origin = safeOrigin(tab.url || '');
  if (!origin || origin !== String(args.origin || '')) return { value: { status: 'origin_changed' } };
  const fields = (Array.isArray(args.fields) ? args.fields : []).map((field) => ({ id: String(field.id || ''), query: selectorQuery(command, field.selector) }));
  const options = (Array.isArray(args.options) ? args.options : []).filter((option) => option.selector).map((option) => ({ id: String(option.id || ''), query: selectorQuery(command, option.selector) }));
  if (args.__phase === 'validate') return { value: await sendPage(tab.id, 'browser_auth_validate', { fields, options }) };
  if (args.__phase !== 'fill' || !args.__secureValues || typeof args.__secureValues !== 'object') return { value: { status: 'unavailable' } };
  const secureValues = args.__secureValues;
  try {
    const selected = Array.isArray(args.options) ? args.options.find((option) => option.id === args.__selectedOption) : null;
    const submit = args.submit?.selector ? { query: selectorQuery(command, args.submit.selector), action: args.submit.action } : null;
    const value = await sendPage(tab.id, 'browser_auth_fill', {
      origin,
      fields: fields.map((field) => ({ ...field, value: typeof secureValues[field.id] === 'string' ? secureValues[field.id] : '' })),
      option: selected?.selector ? { query: selectorQuery(command, selected.selector) } : null,
      submit,
    });
    return { value: { ...value, ...(args.__selectedOption ? { selected_option: args.__selectedOption } : {}) } };
  } finally {
    for (const key of Object.keys(secureValues)) secureValues[key] = '';
  }
}

function selectorQuery(command, selector) {
  if (typeof selector === 'string') return { selector };
  const handleId = selector?.handle;
  if (typeof handleId !== 'string') throw failure('ZEUS_BROWSER_AUTH_LOCATOR_INVALID', 'Browser Auth selectors must be CSS selectors or current locator handles.');
  const handle = requireHandle(command, handleId, 'PlaywrightLocator');
  return handle.payload.query;
}

async function invokePageAssets(tab, method, args) {
  if (method === 'list') {
    const resources = await sendPage(tab.id, 'content', { kind: 'resources' });
    const values = Array.isArray(resources) ? resources : [];
    const seen = new Set();
    const assets = [];
    for (const [index, entry] of values.entries()) {
      const url = String(entry.name || '');
      if (!/^https?:/u.test(url) || seen.has(url)) continue;
      seen.add(url);
      const kind = /\.(?:png|jpe?g|gif|webp|svg)(?:[?#]|$)/iu.test(url)
        ? 'image'
        : /\.css(?:[?#]|$)/iu.test(url)
          ? 'stylesheet'
          : /\.(?:woff2?|ttf|otf)(?:[?#]|$)/iu.test(url)
            ? 'font'
            : /\.(?:mp4|webm)(?:[?#]|$)/iu.test(url)
              ? 'video'
              : /\.m?js(?:[?#]|$)/iu.test(url)
                ? 'script'
                : 'other';
      assets.push({ id: `asset-${index}`, kind, name: url.split('/').pop()?.split(/[?#]/u)[0] || `asset-${index}`, sources: [{ kind: 'resource' }], url });
    }
    const id = `inventory-${crypto.randomUUID()}`;
    await chrome.storage.session.set({ [`zeusAsset:${id}`]: { tabId: tab.id, generation: generations.get(tab.id) || 1, assets } });
    return {
      value: {
        id,
        assets,
        inlineSvgs: [],
        pageUrl: tab.url || null,
        summary: { totalCount: assets.length, inlineSvgCount: 0, byKind: Object.fromEntries(['script', 'font', 'image', 'stylesheet', 'video', 'other'].map((kind) => [kind, assets.filter((asset) => asset.kind === kind).length])) },
      },
    };
  }
  const inventoryId = String(args.inventoryId || '');
  const stored = (await chrome.storage.session.get(`zeusAsset:${inventoryId}`))[`zeusAsset:${inventoryId}`];
  if (!stored || stored.tabId !== tab.id || stored.generation !== (generations.get(tab.id) || 1)) throw failure('ZEUS_BROWSER_ASSET_INVENTORY_STALE', 'Refresh the asset inventory after navigation.');
  const ids = Array.isArray(args.assetIds) ? new Set(args.assetIds.map(String)) : null;
  const kinds = Array.isArray(args.kinds) ? new Set(args.kinds.map(String)) : null;
  const selected = stored.assets.filter((asset) => (!ids || ids.has(asset.id)) && (!kinds || kinds.has(asset.kind))).slice(0, 100);
  const artifacts = [];
  const failures = [];
  let bytes = 0;
  for (const asset of selected) {
    try {
      const permission = originPermission(asset.url);
      if (!permission || !(await chrome.permissions.contains({ origins: [permission] }))) throw new Error(`Site access is missing for ${safeOrigin(asset.url)}.`);
      const response = await fetch(asset.url, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      bytes += buffer.byteLength;
      if (buffer.byteLength > 8 * 1024 * 1024 || bytes > 12 * 1024 * 1024) throw new Error('Asset bundle byte limit exceeded.');
      artifacts.push({ ...asset, contentType: response.headers.get('content-type'), data: arrayBufferBase64(buffer) });
    } catch (error) {
      failures.push({ ...asset, reason: error.message || String(error) });
    }
  }
  return { value: { inventoryId, failures, summary: { requestedCount: selected.length, downloadedCount: artifacts.length, failedCount: failures.length } }, artifacts };
}

async function invokeContentExport(tab, method, args) {
  if (method === 'export') {
    const html = await sendPage(tab.id, 'content', { kind: 'html', maxCharacters: 8 * 1024 * 1024 });
    return primaryArtifact('page.html', 'text/html; charset=utf-8', String(html || ''));
  }
  if (method === 'exportYouTubeTranscript') {
    const url = new URL(tab.url || 'about:blank');
    if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com'].includes(url.hostname) || url.pathname !== '/watch') {
      throw failure('ZEUS_BROWSER_YOUTUBE_TRANSCRIPT_UNSUPPORTED_URL', 'Transcript export requires an HTTPS youtube.com/watch tab.');
    }
    const transcript = await sendPage(tab.id, 'youtube_transcript', {});
    if (!String(transcript || '').trim()) throw failure('ZEUS_BROWSER_YOUTUBE_TRANSCRIPT_UNAVAILABLE', 'Open the transcript panel or choose a video with an available transcript.');
    return primaryArtifact('youtube-transcript.txt', 'text/plain; charset=utf-8', String(transcript));
  }
  if (method === 'exportGsuite') {
    const request = googleWorkspaceExportRequest(tab.url || '', String(args.type || '').toLocaleLowerCase());
    if (!request) throw failure('ZEUS_BROWSER_GSUITE_EXPORT_UNSUPPORTED', `${args.type} is not valid for this Google Workspace URL.`);
    const permission = originPermission(request.url);
    if (!permission || !(await chrome.permissions.contains({ origins: [permission] }))) {
      throw failure('ZEUS_BROWSER_PERMISSION_REQUIRED', `Google Workspace export requires site access for ${safeOrigin(request.url)}.`);
    }
    const response = await fetch(request.url, { credentials: 'include', redirect: 'follow' });
    if (!response.ok) throw failure('ZEUS_BROWSER_GSUITE_EXPORT_FAILED', `Google Workspace export returned HTTP ${response.status}.`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 8 * 1024 * 1024) throw failure('ZEUS_BROWSER_EXPORT_TOO_LARGE', 'External browser exports are limited to 8 MiB per Native Messaging call.');
    return { value: { __zeusPrimaryArtifact: true }, artifacts: [{ name: `google-workspace.${request.extension}`, contentType: response.headers.get('content-type') || 'application/octet-stream', data: arrayBufferBase64(buffer) }] };
  }
  throw failure('ZEUS_BROWSER_CONTENT_METHOD_UNSUPPORTED', `Unsupported content export: ${method}`);
}

function primaryArtifact(name, contentType, text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > 8 * 1024 * 1024) throw failure('ZEUS_BROWSER_EXPORT_TOO_LARGE', 'External browser exports are limited to 8 MiB per Native Messaging call.');
  return { value: { __zeusPrimaryArtifact: true }, artifacts: [{ name, contentType, data: arrayBufferBase64(bytes.buffer) }] };
}

function googleWorkspaceExportRequest(urlValue, type) {
  let source;
  try {
    source = new URL(urlValue);
  } catch {
    return null;
  }
  if (source.protocol !== 'https:' || source.hostname !== 'docs.google.com') return null;
  const match = source.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)/u);
  if (!match) return null;
  const formats = { document: { pdf: 'pdf', docx: 'docx', md: 'txt' }, spreadsheets: { pdf: 'pdf', xlsx: 'xlsx', csv: 'csv' }, presentation: { pdf: 'pdf', pptx: 'pptx' } };
  const format = formats[match[1]]?.[type];
  if (!format) return null;
  const target = new URL(`https://docs.google.com/${match[1]}/d/${encodeURIComponent(match[2])}/export`);
  target.searchParams.set('format', format);
  const resourceKey = source.searchParams.get('resourcekey');
  if (resourceKey) target.searchParams.set('resourcekey', resourceKey);
  return { url: target.toString(), extension: type };
}

function arrayBufferBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

async function invokeClipboard(args) {
  const permission = args.action === 'read' ? 'clipboardRead' : 'clipboardWrite';
  return {
    value: await requireOptionalPermission(permission, async () => {
      const document = (await chrome.offscreen?.hasDocument?.()) ? null : null;
      void document;
      throw failure('ZEUS_BROWSER_CLIPBOARD_CONTEXT_REQUIRED', 'Use the Zeus secure clipboard UI for external-browser clipboard access.');
    }),
  };
}

async function invokeDownload(method, args) {
  return {
    value: await requireOptionalPermission('downloads', async () => {
      const handle = requireHandle({ identity: args.identity || {} }, args.handle, 'PlaywrightDownload');
      const id = Number(args.id ?? handle.payload.downloadId);
      if (method === 'path') {
        const values = Number.isInteger(id) ? await chrome.downloads.search({ id }) : [];
        return values[0]?.filename || null;
      }
      if (method === 'cancel') {
        await chrome.downloads.cancel(Number(args.id));
        return true;
      }
      if (method === 'pause') {
        await chrome.downloads.pause(Number(args.id));
        return true;
      }
      if (method === 'resume') {
        await chrome.downloads.resume(Number(args.id));
        return true;
      }
      if (method === 'getFilePath') {
        const values = await chrome.downloads.search({ id: Number(args.id) });
        return values[0]?.filename || null;
      }
      return chrome.downloads.search({ id: Number(args.id) });
    }),
  };
}

async function invokeFileChooser(tab, method, handleId, args) {
  const handle = requireHandle({ identity: args.identity || {} }, handleId, 'PlaywrightFileChooser');
  const backendNodeId = Number(handle.payload.backendNodeId);
  if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw failure('ZEUS_BROWSER_FILE_INPUT_STALE', 'The intercepted file input is no longer available.');
  await ensureDebugger(tab);
  if (method === 'isMultiple') {
    const description = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.describeNode', { backendNodeId });
    const attributes = description.node?.attributes || [];
    return { value: attributes.some((value, index) => index % 2 === 0 && value === 'multiple') };
  }
  if (method !== 'setFiles') throw failure('ZEUS_BROWSER_FILE_CHOOSER_METHOD_UNSUPPORTED', `Unsupported FileChooser method: ${method}`);
  const files = (Array.isArray(args.files) ? args.files : [args.files]).map((entry) => (typeof entry === 'string' ? entry : '')).filter(Boolean);
  if (!files.length) throw failure('ZEUS_BROWSER_FILE_SELECTION_EMPTY', 'No local file paths were selected.');
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.setFileInputFiles', { files, backendNodeId });
    return { value: { selected: files.map((path) => path.split(/[\\/]/u).pop()), count: files.length } };
  } finally {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
}

async function invokeCdp(tab, method, params) {
  return {
    value: await requireOptionalPermission('debugger', async () => {
      const target = { tabId: tab.id };
      await ensureDebugger(tab);
      return chrome.debugger.sendCommand(target, String(method), params || {});
    }),
  };
}

async function sendPage(tabId, operation, params) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || '';
  const originPattern = originPermission(url);
  if (!originPattern || !(await chrome.permissions.contains({ origins: [originPattern] })))
    throw failure('ZEUS_BROWSER_SITE_PERMISSION_REQUIRED', `The Zeus extension needs site access for ${safeOrigin(url)}. Grant it from the extension popup.`);
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, { channel: 'zeus-page', operation, params });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      response = await chrome.tabs.sendMessage(tabId, { channel: 'zeus-page', operation, params });
    } catch (error) {
      throw failure('ZEUS_BROWSER_CONTENT_SCRIPT_INJECTION_FAILED', error.message || String(error));
    }
  }
  if (!response?.ok) throw failure(response?.error?.code || 'ZEUS_BROWSER_PAGE_OPERATION_FAILED', response?.error?.message || 'The page bridge failed.');
  return response.value;
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(tabProjection);
}

async function openTabsForClaim() {
  const tabs = await listTabs();
  latestClaims.clear();
  for (const tab of tabs) latestClaims.set(Number(tab.tabId), { browserId: tab.browserId, tabId: tab.tabId, title: tab.title, url: tab.url, documentGeneration: tab.documentGeneration });
  return tabs;
}

async function claimTab(command, args) {
  const requested = typeof args.tab === 'string' ? { id: args.tab } : args.tab || {};
  const tabId = Number(requested.id ?? requested.tabId);
  const expected = latestClaims.get(tabId);
  const actual = tabProjection(await chrome.tabs.get(tabId));
  if (
    !expected ||
    (requested.browserId != null && expected.browserId !== String(requested.browserId)) ||
    (requested.providerTabId != null && expected.tabId !== String(requested.providerTabId)) ||
    (requested.title != null && expected.title !== String(requested.title)) ||
    (requested.url != null && expected.url !== String(requested.url)) ||
    (requested.documentGeneration != null && expected.documentGeneration !== Number(requested.documentGeneration)) ||
    actual.title !== expected.title ||
    actual.url !== expected.url ||
    actual.documentGeneration !== expected.documentGeneration
  ) {
    throw failure('ZEUS_BROWSER_TAB_CLAIM_STALE', 'The browser, tab, title, URL, or document generation no longer matches the latest openTabs result.');
  }
  latestClaims.delete(tabId);
  claimedTabs.set(tabId, { turnId: command.identity.turnId, conversationId: command.identity.conversationId, documentGeneration: actual.documentGeneration });
  await startDialogMonitor(tab).catch(() => {});
  return handleFor(command, 'Tab', await chrome.tabs.get(tabId));
}

async function extractTemporaryTabsContent(command, options) {
  const urls = Array.isArray(options.urls) ? options.urls.slice(0, 20).map(String) : [];
  if (!urls.length) throw failure('ZEUS_BROWSER_ARGUMENT_INVALID', 'Tabs.content requires at least one URL.');
  const contentType = ['html', 'text', 'domSnapshot'].includes(String(options.contentType)) ? String(options.contentType) : 'text';
  const results = [];
  for (const requestedUrl of urls) {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: requireUrl(requestedUrl), active: false });
      zeusOwnedTabs.set(tab.id, command.identity.conversationId);
      tab = await waitForTabReady(tab.id, options.timeoutMs);
      const content = contentType === 'domSnapshot' ? JSON.stringify(await sendPage(tab.id, 'snapshot', { maxElements: 400 })) : await sendPage(tab.id, 'content', { kind: contentType, maxCharacters: 2_000_000 });
      results.push({ content: String(content).slice(0, 2_000_000), title: tab.title || null, url: tab.url || requestedUrl });
    } catch {
      results.push({ content: null, title: tab?.title || null, url: tab?.url || requestedUrl });
    } finally {
      if (tab?.id != null) await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  return results;
}

async function resolveClaimedConvenienceTab(command, requested) {
  const tab = await resolveTab(requested);
  const generation = generations.get(tab.id) || 1;
  const owned = zeusOwnedTabs.get(tab.id) === command.identity.conversationId;
  const claim = claimedTabs.get(tab.id);
  if (!owned && (!claim || claim.turnId !== command.identity.turnId || claim.conversationId !== command.identity.conversationId || claim.documentGeneration !== generation)) {
    throw failure('ZEUS_BROWSER_TAB_CLAIM_REQUIRED', 'Claim this exact external tab from the latest BrowserUser.openTabs result before inspecting or operating it.');
  }
  return tab;
}

async function tabForAdvanced(command, request, args) {
  if (request.handle) {
    const handle = requireHandle(command, request.handle);
    const tab = await chrome.tabs.get(handle.tabId);
    if ((generations.get(tab.id) || 1) !== handle.documentGeneration) throw failure('ZEUS_BROWSER_HANDLE_STALE', 'The remote handle became stale after navigation.');
    return tab;
  }
  return resolveClaimedConvenienceTab(command, args.tabId);
}

function handleFor(command, kind, tab, payload = {}) {
  const tabId = Number(tab.tabId ?? tab.id);
  const id = `zh-${crypto.randomUUID()}`;
  const handle = { id, kind, tabId, documentGeneration: Number(tab.documentGeneration ?? generations.get(tabId) ?? 1), turnId: command.identity.turnId, callId: command.identity.callId, payload };
  handles.set(id, handle);
  return { handle: id, kind, tabId: String(tabId), browserId: browserId(), documentGeneration: handle.documentGeneration, surface: ZEUS_SURFACE };
}

function rootHandle(command, kind, payload = {}) {
  const id = `zh-${crypto.randomUUID()}`;
  handles.set(id, { id, kind, turnId: command.identity.turnId, callId: command.identity.callId, payload });
  return { handle: id, kind, surface: ZEUS_SURFACE };
}

function locatorHandle(command, tab, query) {
  return handleFor(command, 'PlaywrightLocator', tab, { query });
}
function requireHandle(command, id, kind) {
  const handle = handles.get(String(id || ''));
  if (!handle || (kind && handle.kind !== kind)) throw failure('ZEUS_BROWSER_HANDLE_INVALID', 'The requested Browser remote handle is missing or has the wrong kind.');
  if (command.identity?.turnId && handle.turnId !== command.identity.turnId) throw failure('ZEUS_BROWSER_HANDLE_OWNER_MISMATCH', 'Browser handles cannot be reused across turns.');
  return handle;
}

async function resolveTab(requested) {
  if (requested != null && requested !== '') return chrome.tabs.get(Number(requested));
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active[0]) throw failure('ZEUS_BROWSER_TAB_MISSING', 'No active browser tab exists.');
  return active[0];
}

async function waitForTabReady(tabId, timeoutValue) {
  const timeout = Math.max(1000, Math.min(Number(timeoutValue) || 30_000, 120_000));
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw failure('ZEUS_BROWSER_LOAD_TIMEOUT', `Timed out waiting for tab ${tabId} to finish loading.`);
}

async function captureTab(tab, options = {}) {
  await ensureDebugger(tab);
  let clip = options.clip;
  if (options.fullPage) {
    const metrics = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getLayoutMetrics', {});
    clip = { ...metrics.cssContentSize, scale: 1 };
  }
  const result = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: Boolean(options.fullPage),
    ...(clip ? { clip: { x: Math.max(0, Number(clip.x) || 0), y: Math.max(0, Number(clip.y) || 0), width: Math.max(1, Number(clip.width) || 1), height: Math.max(1, Number(clip.height) || 1), scale: Number(clip.scale) || 1 } } : {}),
  });
  return { value: { tabId: tab.id, mimeType: 'image/png' }, image: `data:image/png;base64,${result.data}` };
}

async function browserHistory(options) {
  return {
    value: await requireOptionalPermission('history', async () => {
      const from = dateBound(options.from, 0);
      const to = dateBound(options.to, Date.now());
      const limit = Math.max(1, Math.min(Number(options.limit) || 100, 1000));
      const queries = Array.isArray(options.queries) && options.queries.length ? options.queries.map(String) : [''];
      const rows = (await Promise.all(queries.map((text) => chrome.history.search({ text, startTime: from, endTime: to, maxResults: limit })))).flat();
      const unique = new Map();
      for (const row of rows) if (row.url && (!unique.has(row.url) || Number(unique.get(row.url).lastVisitTime) < Number(row.lastVisitTime))) unique.set(row.url, row);
      return [...unique.values()]
        .sort((left, right) => Number(right.lastVisitTime) - Number(left.lastVisitTime))
        .slice(0, limit)
        .map((entry) => ({ dateVisited: new Date(entry.lastVisitTime || 0).toISOString(), ...(entry.title ? { title: entry.title } : {}), url: entry.url }));
    }),
  };
}

function dateBound(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function captureElement(tab, args) {
  const info = await sendPage(tab.id, 'element_at_point', { x: args.x, y: args.y });
  const rect = info?.rect;
  if (!rect) throw failure('ZEUS_BROWSER_ELEMENT_NOT_FOUND', 'No visible element exists at the requested point.');
  await ensureDebugger(tab);
  const result = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: Math.max(0, Number(rect.x)), y: Math.max(0, Number(rect.y)), width: Math.max(1, Number(rect.width)), height: Math.max(1, Number(rect.height)), scale: 1 },
  });
  return { value: { tabId: tab.id, mimeType: 'image/png', rect }, image: `data:image/png;base64,${result.data}` };
}

async function requireOptionalPermission(permission, operation) {
  if (!(await chrome.permissions.contains({ permissions: [permission] }))) throw failure('ZEUS_BROWSER_PERMISSION_REQUIRED', `The ${permission} permission has not been granted. Grant it from the Zeus extension popup.`);
  return operation();
}

function tabProjection(tab) {
  return {
    id: String(tab.id),
    providerTabId: String(tab.id),
    lastOpened: new Date(tab.lastAccessed || Date.now()).toISOString(),
    browserId: browserId(),
    tabId: String(tab.id),
    windowId: String(tab.windowId),
    title: tab.title || '',
    url: tab.url || '',
    loading: tab.status === 'loading',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    incognito: Boolean(tab.incognito),
    documentGeneration: generations.get(tab.id) || 1,
    surface: ZEUS_SURFACE,
  };
}

function targetQuery(target) {
  if (typeof target !== 'string') throw failure('ZEUS_BROWSER_TARGET_REQUIRED', 'A page target is required.');
  if (/^e\d+$/u.test(target)) return { ref: target };
  return { selector: target };
}
function normalizeMethodArguments(args) {
  const options = args.options && typeof args.options === 'object' && !Array.isArray(args.options) ? args.options : {};
  return Object.keys(options).length > 0 ? { ...options, ...args } : args;
}
function queryForMethod(method, args) {
  if (method === 'locator') return { selector: args.selector };
  if (method === 'getByLabel') return { label: args.text || args.label, exact: args.exact };
  if (method === 'getByPlaceholder') return { placeholder: args.text || args.placeholder, exact: args.exact };
  if (method === 'getByRole') return { role: args.role, name: args.name, exact: args.exact };
  if (method === 'getByTestId') return { testId: args.testId || args.value };
  return { text: args.text, exact: args.exact };
}
function scriptExpression(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value.expression || value.source) === 'string' && String(value.expression || value.source).trim()) return String(value.expression || value.source).trim();
  throw failure('ZEUS_BROWSER_EXPRESSION_REQUIRED', 'pageFunction must be a JavaScript source string or an approved expression descriptor.');
}
function requireUrl(value) {
  const url = new URL(String(value));
  if (!['http:', 'https:', 'file:'].includes(url.protocol) && url.href !== 'about:blank') throw failure('ZEUS_BROWSER_URL_INVALID', `Unsupported URL: ${value}`);
  return url.href;
}
function originPermission(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}/*` : null;
  } catch {
    return null;
  }
}
function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return 'this page';
  }
}
function browserId() {
  return `${ZEUS_SURFACE}:${chrome.runtime.id}`;
}
function capabilities() {
  return { contractVersion: ZEUS_CONTRACT_VERSION, surface: ZEUS_SURFACE, browser: browserCapabilities(), tab: tabCapabilities() };
}
function browserCapabilities() {
  return [
    { id: 'management', description: 'Allowlisted tab, tab-group, and bookmark organization with an audit trail.' },
    { id: 'visibility', description: 'Show or minimize the exact claimed external-browser window.' },
    { id: 'viewport', description: 'Temporary Chromium viewport override through approved debugger access.' },
  ];
}
function tabCapabilities() {
  return [
    { id: 'cdp', description: 'Approved raw Chrome DevTools Protocol access.' },
    { id: 'browserAuth', description: 'Secure, model-invisible credential handoff.' },
    { id: 'pageAssets', description: 'Inventory and bundle page assets.' },
    { id: 'webmcp', description: 'Page-defined WebMCP tools when exposed by the current page.' },
    { id: 'botDetection', description: 'Report a visible site-served bot-detection blocker.' },
  ];
}
function browserCapabilityKind(id) {
  return id === 'management' ? 'ManagementBrowserCapability' : id === 'visibility' ? 'VisibilityBrowserCapability' : id === 'viewport' ? 'ViewportBrowserCapability' : null;
}
function tabCapabilityKind(id) {
  return { cdp: 'CdpTabCapability', browserAuth: 'BrowserAuthTabCapability', pageAssets: 'PageAssetsTabCapability', webmcp: 'WebMcpTabCapability', botDetection: 'BotDetectionTabCapability' }[id] || null;
}
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
