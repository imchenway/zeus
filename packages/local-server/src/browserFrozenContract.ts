import { browserFrozenPublicArgumentSchemas, browserFrozenUnsupportedSurfaces } from './browserFrozenPublicSchemas.js';

export const browserFrozenContractVersion = '26.825.32147' as const;

export type BrowserFrozenContractRisk = 'read' | 'interaction' | 'sensitive' | 'developer';

export interface BrowserFrozenContractEntry {
  path: string;
  group: string;
  kind: 'property' | 'method';
  risk: BrowserFrozenContractRisk;
  description: string;
}

export interface BrowserFrozenArgumentSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
}

const properties = (interfaceName: string, group: string, names: readonly string[]): BrowserFrozenContractEntry[] =>
  names.map((name) => ({
    path: `${interfaceName}.${name}`,
    group,
    kind: 'property',
    risk: 'read',
    description: `${interfaceName} ${name} capability from the frozen Browser contract.`,
  }));

const methods = (interfaceName: string, group: string, risk: BrowserFrozenContractRisk, names: readonly string[]): BrowserFrozenContractEntry[] =>
  names.map((name) => ({
    path: `${interfaceName}.${name}`,
    group,
    kind: 'method',
    risk,
    description: `${interfaceName} ${name} operation from the frozen Browser contract.`,
  }));

/**
 * 净室冻结目录只记录公开可观察的接口事实，不包含原插件源码、文档正文或私有实现。
 * 参数在 Zeus catalog 中使用独立 JSON Schema；真正调用仍由每个 surface 的适配器校验。
 */
export const browserFrozenContractEntries: readonly BrowserFrozenContractEntry[] = [
  ...properties('Agent', 'agent', ['browsers', 'documentation']),
  ...methods('Browsers', 'browser', 'read', ['get', 'getDefault', 'getForUrl', 'list']),
  ...properties('Browser', 'browser', ['browserId', 'capabilities', 'tabs', 'user', 'documentation']),
  ...methods('Browser', 'browser', 'read', ['history']),
  ...methods('Browser', 'browser', 'interaction', ['nameSession']),
  ...methods('BrowserCapabilityCollection', 'browser-capability', 'read', ['get', 'list']),
  ...methods('BrowserUser', 'browser-user', 'read', ['openTabs']),
  ...methods('BrowserUser', 'browser-user', 'interaction', ['claimTab']),
  ...properties('Tabs', 'tabs', ['content']),
  ...methods('Tabs', 'tabs', 'read', ['get', 'list', 'selected']),
  ...methods('Tabs', 'tabs', 'interaction', ['new']),
  ...methods('TabCapabilityCollection', 'tab-capability', 'read', ['get', 'list']),
  ...properties('Tab', 'tab', ['ax', 'capabilities', 'clipboard', 'content', 'cua', 'dev', 'dom_cua', 'id', 'playwright', 'title', 'url']),
  ...methods('Tab', 'tab', 'read', ['getJsDialog', 'screenshot']),
  ...methods('Tab', 'tab', 'interaction', ['back', 'close', 'forward', 'goto', 'markDeliverable', 'markHandoff', 'reload', 'requestManualHandoff']),
  ...methods('AXAPI', 'ax', 'read', ['get']),
  ...methods('AXAPI', 'ax', 'interaction', ['click', 'drag', 'performSecondaryAction', 'pressKey', 'scroll', 'selectText', 'setValue', 'typeText', 'write']),
  ...methods('ContentAPI', 'content', 'read', ['export', 'exportGsuite', 'exportYouTubeTranscript']),
  ...methods('CUAAPI', 'cua', 'interaction', ['click', 'double_click', 'downloadMedia', 'drag', 'keypress', 'move', 'scroll', 'type']),
  ...methods('DomCUAAPI', 'dom-cua', 'read', ['get_visible_dom']),
  ...methods('DomCUAAPI', 'dom-cua', 'interaction', ['click', 'double_click', 'downloadMedia', 'keypress', 'scroll', 'type']),
  ...methods('PlaywrightAPI', 'playwright', 'read', [
    'domSnapshot',
    'elementInfo',
    'elementScreenshot',
    'frameLocator',
    'getByLabel',
    'getByPlaceholder',
    'getByRole',
    'getByTestId',
    'getByText',
    'locator',
    'waitForEvent',
    'waitForLoadState',
    'waitForTimeout',
    'waitForURL',
  ]),
  ...methods('PlaywrightAPI', 'playwright', 'developer', ['evaluate', 'expectNavigation']),
  ...methods('PlaywrightFrameLocator', 'playwright-frame', 'read', ['frameLocator', 'getByLabel', 'getByPlaceholder', 'getByRole', 'getByTestId', 'getByText', 'locator']),
  ...methods('PlaywrightLocator', 'playwright-locator', 'read', [
    'all',
    'allTextContents',
    'and',
    'count',
    'filter',
    'first',
    'getAttribute',
    'getByLabel',
    'getByPlaceholder',
    'getByRole',
    'getByTestId',
    'getByText',
    'innerText',
    'isEnabled',
    'isVisible',
    'last',
    'locator',
    'nth',
    'or',
    'textContent',
    'waitFor',
  ]),
  ...methods('PlaywrightLocator', 'playwright-locator', 'developer', ['evaluate', 'evaluateAll']),
  ...methods('PlaywrightLocator', 'playwright-locator', 'interaction', ['check', 'click', 'dblclick', 'downloadMedia', 'fill', 'press', 'pressSequentially', 'selectOption', 'setChecked', 'type', 'uncheck']),
  ...methods('PlaywrightDownload', 'download', 'read', ['path']),
  ...methods('PlaywrightFileChooser', 'file-chooser', 'read', ['isMultiple']),
  ...methods('PlaywrightFileChooser', 'file-chooser', 'sensitive', ['setFiles']),
  ...methods('TabClipboardAPI', 'clipboard', 'sensitive', ['read', 'readText', 'write', 'writeText']),
  ...methods('TabDevAPI', 'developer', 'developer', ['logs']),
  ...properties('ManagementBrowserCapability', 'management', ['bookmarks', 'tabGroups', 'tabs']),
  ...methods('ManagementBrowserCapability', 'management', 'read', ['getAuditTrail']),
  ...methods('ManagementBookmarksAPI', 'management', 'read', ['get', 'getChildren', 'getRecent', 'getSubTree', 'getTree', 'search']),
  ...methods('ManagementBookmarksAPI', 'management', 'interaction', ['create', 'move', 'update']),
  ...methods('ManagementBookmarksAPI', 'management', 'sensitive', ['remove', 'removeTree']),
  ...methods('ManagementTabGroupsAPI', 'management', 'read', ['get', 'query']),
  ...methods('ManagementTabGroupsAPI', 'management', 'interaction', ['move', 'update']),
  ...methods('ManagementTabsAPI', 'management', 'read', ['get', 'query']),
  ...methods('ManagementTabsAPI', 'management', 'interaction', ['group', 'move', 'ungroup', 'update']),
  ...methods('VisibilityBrowserCapability', 'visibility', 'read', ['get']),
  ...methods('VisibilityBrowserCapability', 'visibility', 'interaction', ['set']),
  ...methods('ViewportBrowserCapability', 'viewport', 'interaction', ['reset', 'set']),
  ...methods('CdpTabCapability', 'cdp', 'developer', ['readEvents', 'send']),
  ...methods('BotDetectionTabCapability', 'bot-detection', 'interaction', ['report']),
  ...methods('BrowserAuthTabCapability', 'browser-auth', 'sensitive', ['request']),
  ...methods('PageAssetsTabCapability', 'page-assets', 'read', ['list']),
  ...methods('PageAssetsTabCapability', 'page-assets', 'interaction', ['bundle']),
  ...methods('WebMcpTabCapability', 'webmcp', 'read', ['fetchTools']),
  ...methods('WebMcpTools', 'webmcp', 'read', ['description']),
  ...methods('WebMcpTools', 'webmcp', 'sensitive', ['call']),
  ...properties('AlertDialog', 'dialog', ['type']),
  ...methods('AlertDialog', 'dialog', 'interaction', ['dismiss']),
  ...properties('BeforeUnloadDialog', 'dialog', ['type']),
  ...methods('BeforeUnloadDialog', 'dialog', 'interaction', ['dismiss']),
  ...properties('ConfirmDialog', 'dialog', ['type']),
  ...methods('ConfirmDialog', 'dialog', 'interaction', ['accept', 'dismiss']),
  ...properties('PromptDialog', 'dialog', ['type']),
  ...methods('PromptDialog', 'dialog', 'sensitive', ['accept', 'dismiss']),
  ...methods('Documentation', 'documentation', 'read', ['get']),
] as const;

const frozenPathSet = new Set(browserFrozenContractEntries.map((entry) => entry.path));

export function browserFrozenContractEntry(path: string): BrowserFrozenContractEntry | null {
  if (!frozenPathSet.has(path)) return null;
  return browserFrozenContractEntries.find((entry) => entry.path === path) ?? null;
}

export function browserFrozenUnsupportedSurfaceKinds(path: string): readonly string[] {
  return browserFrozenUnsupportedSurfaces[path] ?? [];
}

export function browserFrozenMethodSupportsSurface(path: string, surface: 'built_in' | 'chrome' | 'edge'): boolean {
  const adapterKind = surface === 'built_in' ? 'iab' : 'extension';
  return !browserFrozenUnsupportedSurfaceKinds(path).includes(adapterKind);
}

const value = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type, ...extra });
const object = (properties: Record<string, unknown> = {}, required: string[] = [], additionalProperties = false): BrowserFrozenArgumentSchema => ({ type: 'object', properties, required, additionalProperties });
const anyObject = value('object', { additionalProperties: true });
const string = value('string');
const number = value('number');
const integer = value('integer');
const boolean = value('boolean');
const stringArray = value('array', { items: string, maxItems: 1000 });

const frozenArgumentSchemas: Readonly<Record<string, BrowserFrozenArgumentSchema>> = {
  'Browsers.get': object({ id: string }, ['id']),
  'Browsers.getForUrl': object({ url: string }, ['url']),
  'Browser.history': object({ options: anyObject }),
  'Browser.nameSession': object({ name: string }, ['name']),
  'BrowserCapabilityCollection.get': object({ id: string }, ['id']),
  'BrowserUser.claimTab': object({ tab: {} }, ['tab']),
  'Tabs.content': object({ options: anyObject }, ['options']),
  'Tabs.get': object({ id: string }, ['id']),
  'TabCapabilityCollection.get': object({ id: string }, ['id']),
  'Tab.goto': object({ url: string, timeoutMs: integer }, ['url']),
  'Tab.screenshot': object({ options: anyObject }),
  'AXAPI.get': object({ mode: value('string', { enum: ['state', 'screenshot', 'both'] }), options: anyObject }),
  'AXAPI.click': object({ target: {}, options: anyObject }, ['target']),
  'AXAPI.drag': object({ from: anyObject, to: anyObject }, ['from', 'to']),
  'AXAPI.performSecondaryAction': object({ elementIndex: integer, action: string }, ['elementIndex', 'action']),
  'AXAPI.pressKey': object({ key: string }, ['key']),
  'AXAPI.scroll': object({ target: {}, direction: value('string', { enum: ['up', 'down', 'left', 'right'] }), pages: number }, ['target', 'direction']),
  'AXAPI.selectText': object({ elementIndex: integer, text: string, options: anyObject }, ['elementIndex', 'text']),
  'AXAPI.setValue': object({ elementIndex: integer, value: string }, ['elementIndex', 'value']),
  'AXAPI.typeText': object({ text: string }, ['text']),
  'AXAPI.write': object({ mode: value('string', { enum: ['state', 'screenshot', 'both'] }), options: anyObject }),
  'ContentAPI.exportGsuite': object({ type: value('string', { enum: ['pdf', 'md', 'xlsx', 'csv', 'docx', 'pptx'] }) }, ['type']),
  'CUAAPI.click': object({ x: number, y: number, button: integer, timeoutMs: integer }, ['x', 'y']),
  'CUAAPI.double_click': object({ x: number, y: number, button: integer, timeoutMs: integer }, ['x', 'y']),
  'CUAAPI.downloadMedia': object({ x: number, y: number, timeoutMs: integer }, ['x', 'y']),
  'CUAAPI.drag': object({ x: number, y: number, endX: number, endY: number, path: value('array', { items: anyObject }), timeoutMs: integer }),
  'CUAAPI.keypress': object({ key: string, keys: stringArray }, []),
  'CUAAPI.move': object({ x: number, y: number }, ['x', 'y']),
  'CUAAPI.scroll': object({ x: number, y: number, deltaX: number, deltaY: number }, ['deltaX', 'deltaY']),
  'CUAAPI.type': object({ text: string, replace: boolean }, ['text']),
  'DomCUAAPI.click': object({ node_id: string }, ['node_id']),
  'DomCUAAPI.double_click': object({ node_id: string }, ['node_id']),
  'DomCUAAPI.downloadMedia': object({ node_id: string, timeoutMs: integer }, ['node_id']),
  'DomCUAAPI.keypress': object({ key: string, keys: stringArray }),
  'DomCUAAPI.scroll': object({ node_id: string, deltaX: number, deltaY: number }, ['deltaX', 'deltaY']),
  'DomCUAAPI.type': object({ text: string, replace: boolean }, ['text']),
  'PlaywrightAPI.elementInfo': object({ x: number, y: number }, ['x', 'y']),
  'PlaywrightAPI.elementScreenshot': object({ x: number, y: number }),
  'PlaywrightAPI.evaluate': object({ pageFunction: string, expression: string, arg: {}, options: anyObject }),
  'PlaywrightAPI.expectNavigation': object({ action: anyObject, options: anyObject }, ['action']),
  'PlaywrightAPI.frameLocator': object({ frameSelector: string }, ['frameSelector']),
  'PlaywrightAPI.getByLabel': object({ text: {}, options: anyObject }, ['text']),
  'PlaywrightAPI.getByPlaceholder': object({ text: {}, options: anyObject }, ['text']),
  'PlaywrightAPI.getByRole': object({ role: string, options: anyObject }, ['role']),
  'PlaywrightAPI.getByTestId': object({ testId: string }, ['testId']),
  'PlaywrightAPI.getByText': object({ text: {}, options: anyObject }, ['text']),
  'PlaywrightAPI.locator': object({ selector: string }, ['selector']),
  'PlaywrightAPI.waitForEvent': object({ event: value('string', { enum: ['download', 'filechooser', 'dialog'] }), options: anyObject, selector: string }, ['event']),
  'PlaywrightAPI.waitForLoadState': object({ options: anyObject, timeoutMs: integer }),
  'PlaywrightAPI.waitForTimeout': object({ timeoutMs: integer }, ['timeoutMs']),
  'PlaywrightAPI.waitForURL': object({ url: string, options: anyObject, timeoutMs: integer }, ['url']),
  'PlaywrightFrameLocator.frameLocator': object({ frameSelector: string }, ['frameSelector']),
  'PlaywrightFrameLocator.getByLabel': object({ text: {}, options: anyObject }, ['text']),
  'PlaywrightFrameLocator.getByPlaceholder': object({ text: {}, options: anyObject }, ['text']),
  'PlaywrightFrameLocator.getByRole': object({ role: string, options: anyObject }, ['role']),
  'PlaywrightFrameLocator.getByTestId': object({ testId: string }, ['testId']),
  'PlaywrightFrameLocator.getByText': object({ text: {}, options: anyObject }, ['text']),
  'PlaywrightFrameLocator.locator': object({ selector: string }, ['selector']),
  'PlaywrightLocator.nth': object({ index: integer }, ['index']),
  'PlaywrightLocator.filter': object({ options: anyObject }, ['options']),
  'PlaywrightLocator.and': object({ locator: string }, ['locator']),
  'PlaywrightLocator.or': object({ locator: string }, ['locator']),
  'PlaywrightLocator.getAttribute': object({ name: string, options: anyObject }, ['name']),
  'PlaywrightLocator.locator': object({ selector: string, options: anyObject }, ['selector']),
  'PlaywrightLocator.press': object({ value: string, options: anyObject }, ['value']),
  'PlaywrightLocator.pressSequentially': object({ value: string, options: anyObject }, ['value']),
  'PlaywrightLocator.fill': object({ value: string, options: anyObject }, ['value']),
  'PlaywrightLocator.type': object({ value: string, options: anyObject }, ['value']),
  'PlaywrightLocator.selectOption': object({ value: {}, values: value('array'), options: anyObject }),
  'PlaywrightLocator.setChecked': object({ checked: boolean, options: anyObject }, ['checked']),
  'PlaywrightLocator.evaluate': object({ pageFunction: string, expression: string, arg: {}, options: anyObject }),
  'PlaywrightLocator.evaluateAll': object({ pageFunction: string, expression: string, arg: {}, options: anyObject }),
  'PlaywrightLocator.waitFor': object({ options: anyObject }),
  'PlaywrightDownload.path': object({ options: anyObject }),
  'PlaywrightFileChooser.setFiles': object({ files: value('array', { items: {} }), options: anyObject }, ['files']),
  'TabClipboardAPI.write': object({ items: value('array', { items: anyObject }) }, ['items']),
  'TabClipboardAPI.writeText': object({ text: string }, ['text']),
  'TabDevAPI.logs': object({ options: anyObject, limit: integer, levels: stringArray, filter: string }),
  'ManagementBookmarksAPI.get': object({ args: value('array') }, ['args']),
  'ManagementBookmarksAPI.getChildren': object({ args: value('array') }, ['args']),
  'ManagementBookmarksAPI.getRecent': object({ args: value('array') }, ['args']),
  'ManagementBookmarksAPI.getSubTree': object({ args: value('array') }, ['args']),
  'ManagementBookmarksAPI.getTree': object({ args: value('array') }),
  'ManagementBookmarksAPI.search': object({ args: value('array') }, ['args']),
  'ManagementBookmarksAPI.create': object({ args: value('array') }, ['args']),
  'ManagementBookmarksAPI.move': object({ args: value('array') }, ['args']),
  'ManagementBookmarksAPI.update': object({ args: value('array') }, ['args']),
  'ManagementBookmarksAPI.remove': object({ args: value('array') }, ['args']),
  'ManagementBookmarksAPI.removeTree': object({ args: value('array') }, ['args']),
  'ManagementTabGroupsAPI.get': object({ args: value('array') }, ['args']),
  'ManagementTabGroupsAPI.query': object({ args: value('array') }, ['args']),
  'ManagementTabGroupsAPI.move': object({ args: value('array') }, ['args']),
  'ManagementTabGroupsAPI.update': object({ args: value('array') }, ['args']),
  'ManagementTabsAPI.get': object({ args: value('array') }, ['args']),
  'ManagementTabsAPI.query': object({ args: value('array') }, ['args']),
  'ManagementTabsAPI.group': object({ args: value('array') }, ['args']),
  'ManagementTabsAPI.move': object({ args: value('array') }, ['args']),
  'ManagementTabsAPI.ungroup': object({ args: value('array') }, ['args']),
  'ManagementTabsAPI.update': object({ args: value('array') }, ['args']),
  'VisibilityBrowserCapability.set': object({ visible: boolean }, ['visible']),
  'ViewportBrowserCapability.set': object({ width: integer, height: integer, deviceScaleFactor: number }, ['width', 'height']),
  'CdpTabCapability.readEvents': object({ afterSequence: integer, limit: integer, methods: stringArray, target: anyObject, timeoutMs: integer }),
  'CdpTabCapability.send': object({ method: string, params: anyObject, options: anyObject }, ['method']),
  'BotDetectionTabCapability.report': object({ reason: value('string', { enum: ['captcha_failed', 'access_denied', 'challenge_loop', 'unexpected_bot_error'] }) }, ['reason']),
  'BrowserAuthTabCapability.request': object({ origin: string, fields: value('array', { items: anyObject, maxItems: 20 }), options: value('array', { items: anyObject, maxItems: 20 }), submit: anyObject, qr_code: boolean }, [
    'origin',
    'fields',
  ]),
  'PageAssetsTabCapability.bundle': object({ inventoryId: string, assetIds: stringArray, kinds: value('array', { items: value('string', { enum: ['font', 'image', 'stylesheet', 'video'] }) }) }, ['inventoryId']),
  'WebMcpTools.call': object({ name: string, input: anyObject }, ['name']),
  'PromptDialog.accept': object({ text: string }, ['text']),
  'Documentation.get': object({ name: string }, ['name']),
};

export function browserFrozenArgumentSchema(path: string): BrowserFrozenArgumentSchema {
  return browserFrozenPublicArgumentSchemas[path] ?? frozenArgumentSchemas[path] ?? object();
}

export function validateBrowserFrozenArguments(path: string, input: unknown): string[] {
  const schema = browserFrozenArgumentSchema(path);
  return validateSchemaValue(schema as unknown as Record<string, unknown>, input, 'arguments');
}

function validateSchemaValue(schema: Record<string, unknown>, actual: unknown, path: string): string[] {
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isSchemaRecord) : [];
  if (alternatives.length > 0) {
    if (alternatives.some((alternative) => validateSchemaValue(alternative, actual, path).length === 0)) return [];
    return [`${path} does not match any allowed shape`];
  }
  const expected = schema.type;
  if (expected === 'string' && typeof actual !== 'string') return [`${path} must be a string`];
  if (expected === 'number' && (typeof actual !== 'number' || !Number.isFinite(actual))) return [`${path} must be a number`];
  if (expected === 'integer' && !Number.isSafeInteger(actual)) return [`${path} must be an integer`];
  if (expected === 'boolean' && typeof actual !== 'boolean') return [`${path} must be a boolean`];
  if (expected === 'null' && actual !== null) return [`${path} must be null`];
  if (expected === 'array') {
    if (!Array.isArray(actual)) return [`${path} must be an array`];
    const issues: string[] = [];
    const minimum = typeof schema.minItems === 'number' ? schema.minItems : undefined;
    const maximum = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
    if (minimum !== undefined && actual.length < minimum) issues.push(`${path} must contain at least ${minimum} items`);
    if (maximum !== undefined && actual.length > maximum) issues.push(`${path} must contain at most ${maximum} items`);
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems.filter(isSchemaRecord) : [];
    for (const [index, entry] of prefixItems.entries()) issues.push(...validateSchemaValue(entry, actual[index], `${path}[${index}]`));
    if (isSchemaRecord(schema.items)) for (const [index, value] of actual.entries()) issues.push(...validateSchemaValue(schema.items, value, `${path}[${index}]`));
    return issues;
  }
  if (expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return [`${path} must be an object`];
    const record = actual as Record<string, unknown>;
    const properties = isSchemaRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [];
    const issues: string[] = [];
    for (const key of required) if (!(key in record)) issues.push(`${path}.${key} is required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(record)) if (!(key in properties)) issues.push(`${path}.${key} is not allowed`);
    for (const [key, value] of Object.entries(record)) if (isSchemaRecord(properties[key])) issues.push(...validateSchemaValue(properties[key], value, `${path}.${key}`));
    return issues;
  }
  const allowed = Array.isArray(schema.enum) ? schema.enum : null;
  return allowed && !allowed.includes(actual) ? [`${path} is outside the allowed enum`] : [];
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
