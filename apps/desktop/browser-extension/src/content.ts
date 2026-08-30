/* Zeus 外部浏览器页面桥。源码保持为无需转译的 TypeScript 子集，MV3 构建时原样输出。 */
const zeusRefs = new Map();
let zeusRefGeneration = 0;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.channel !== 'zeus-page') return false;
  Promise.resolve()
    .then(() => invokePage(message.operation, message.params || {}))
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => sendResponse({ ok: false, error: { code: error.code || 'ZEUS_BROWSER_PAGE_OPERATION_FAILED', message: error.message || String(error) } }));
  return true;
});

function invokePage(operation, params) {
  if (operation === 'snapshot') return snapshot(params.maxElements);
  if (operation === 'content') return pageContent(params);
  if (operation === 'youtube_transcript') return youtubeTranscript();
  if (operation === 'element') return elementInfo(resolveTarget(params.target));
  if (operation === 'element_at_point') {
    const element = document.elementFromPoint(Number(params.x), Number(params.y));
    if (!element) throw failure('ZEUS_BROWSER_ELEMENT_NOT_FOUND', 'No visible element exists at the requested point.');
    return elementInfo(element);
  }
  if (operation === 'focused_element') {
    if (!(document.activeElement instanceof Element)) throw failure('ZEUS_BROWSER_FOCUSED_ELEMENT_MISSING', 'The page has no focused element.');
    return elementInfo(document.activeElement);
  }
  if (operation === 'coordinate_click') return coordinateClick(params);
  if (operation === 'coordinate_drag') return coordinateDrag(params);
  if (operation === 'coordinate_move') return coordinateMove(params);
  if (operation === 'coordinate_scroll') return coordinateScroll(params);
  if (operation === 'dom_scroll') return domScroll(params);
  if (operation === 'media_url') return mediaUrl(params);
  if (operation === 'ax_action') return accessibilityAction(params);
  if (operation === 'ax_click') return accessibilityClick(params);
  if (operation === 'file_input_multiple') {
    const element = resolveTarget(params.target);
    if (!(element instanceof HTMLInputElement) || element.type !== 'file') throw failure('ZEUS_BROWSER_FILE_INPUT_STALE', 'The file input no longer exists.');
    return element.multiple;
  }
  if (operation === 'select_text') return selectText(params);
  if (operation === 'locator') return locatorOperation(params);
  if (operation === 'wait_selector') return waitForSelector(params);
  if (operation === 'evaluate') return developerEvaluate(params);
  if (operation === 'browser_auth_validate') return browserAuthValidate(params);
  if (operation === 'browser_auth_fill') return browserAuthFill(params);
  if (operation === 'webmcp_tools') return webMcpTools();
  if (operation === 'webmcp_call') return webMcpCall(params);
  throw failure('ZEUS_BROWSER_PAGE_OPERATION_UNSUPPORTED', `Unsupported page operation: ${operation}`);
}

function snapshot(maxElements = 160) {
  zeusRefs.clear();
  zeusRefGeneration += 1;
  const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,summary,[role],[contenteditable="true"],[tabindex]'))
    .filter((element) => visible(element))
    .slice(0, Math.max(1, Math.min(Number(maxElements) || 160, 400)));
  const elements = candidates.map((element, index) => {
    const ref = `e${index + 1}`;
    zeusRefs.set(ref, element);
    return { ref, ...elementInfo(element) };
  });
  return {
    title: document.title,
    url: location.href,
    generation: zeusRefGeneration,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
    text: bounded(document.body?.innerText || '', 80_000),
    elements,
  };
}

function pageContent(params) {
  const kind = String(params.kind || 'text');
  const maximum = Math.max(1, Math.min(Number(params.maxCharacters) || 500_000, 12 * 1024 * 1024));
  if (kind === 'html') return bounded(document.documentElement.outerHTML, maximum);
  if (kind === 'links')
    return Array.from(document.links)
      .slice(0, 2000)
      .map((link) => ({ text: bounded(link.innerText || link.textContent || '', 1000), url: link.href }));
  if (kind === 'resources')
    return performance
      .getEntriesByType('resource')
      .slice(-2000)
      .map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType, duration: entry.duration, transferSize: entry.transferSize }));
  return bounded(document.body?.innerText || '', maximum);
}

function youtubeTranscript() {
  const segments = Array.from(document.querySelectorAll('ytd-transcript-segment-renderer, ytd-transcript-segment-list-renderer [class*="segment"]'));
  return segments
    .map((segment) => {
      const timestamp = (segment.querySelector('[class*="timestamp"]')?.textContent || '').trim();
      const text = (segment.querySelector('[class*="segment-text"]')?.textContent || segment.textContent || '').replace(/\s+/gu, ' ').trim();
      return timestamp && text ? `${timestamp}\t${text.replace(timestamp, '').trim()}` : text;
    })
    .filter(Boolean)
    .join('\n');
}

function resolveTarget(target) {
  if (typeof target !== 'string' || !target) throw failure('ZEUS_BROWSER_TARGET_REQUIRED', 'A page target is required.');
  const ref = zeusRefs.get(target);
  if (ref && ref.isConnected) return ref;
  if (target.startsWith('e') && /^e\d+$/u.test(target)) throw failure('ZEUS_BROWSER_ELEMENT_STALE', 'The snapshot ref is stale; refresh the page snapshot.');
  try {
    const element = document.querySelector(target);
    if (element) return element;
  } catch {
    throw failure('ZEUS_BROWSER_SELECTOR_INVALID', `Invalid selector: ${target}`);
  }
  throw failure('ZEUS_BROWSER_ELEMENT_NOT_FOUND', `No element matches: ${target}`);
}

function resolveQuery(query) {
  if (!query || typeof query !== 'object') throw failure('ZEUS_BROWSER_LOCATOR_INVALID', 'Locator query is required.');
  if (query.combine) {
    const left = resolveQuery(query.left);
    const right = resolveQuery(query.right);
    const rightSet = new Set(right);
    return query.combine === 'and' ? left.filter((element) => rightSet.has(element)) : Array.from(new Set([...left, ...right]));
  }
  let elements = [];
  const roots = query.parent ? resolveQuery(query.parent) : [frameRoot(query.frame) || document];
  if (query.ref) {
    const element = zeusRefs.get(String(query.ref));
    if (!element?.isConnected) throw failure('ZEUS_BROWSER_ELEMENT_STALE', 'The snapshot ref is stale; refresh the page snapshot.');
    elements = [element];
  } else if (query.selector) elements = roots.flatMap((root) => Array.from(root.querySelectorAll(String(query.selector))));
  else if (query.testId) elements = roots.flatMap((root) => Array.from(root.querySelectorAll(`[data-testid="${cssEscape(String(query.testId))}"]`)));
  else if (query.placeholder) elements = roots.flatMap((root) => Array.from(root.querySelectorAll('input,textarea'))).filter((element) => matchesText(element.getAttribute('placeholder') || '', query.placeholder, query.exact));
  else if (query.label) elements = roots.flatMap((root) => Array.from(root.querySelectorAll('input,textarea,select,button'))).filter((element) => matchesText(accessibleName(element), query.label, query.exact));
  else if (query.role)
    elements = roots
      .flatMap((root) => Array.from(root.querySelectorAll(`[role="${cssEscape(String(query.role))}"],${tagForRole(query.role)}`)))
      .filter((element) => !query.name || matchesText(accessibleName(element), query.name, query.exact));
  else if (query.text) elements = roots.flatMap((root) => Array.from(root.querySelectorAll('*'))).filter((element) => matchesText(element.textContent || '', query.text, query.exact));
  if (query.filter) {
    const filter = query.filter;
    elements = elements.filter((element) => {
      const text = element.textContent || '';
      if (filter.hasText !== undefined && !matchesText(text, filter.hasText, false)) return false;
      if (filter.hasNotText !== undefined && matchesText(text, filter.hasNotText, false)) return false;
      if (filter.has && !resolveQuery(filter.has).some((nested) => nested === element || element.contains(nested))) return false;
      if (filter.hasNot && resolveQuery(filter.hasNot).some((nested) => nested === element || element.contains(nested))) return false;
      if (typeof filter.visible === 'boolean' && visible(element) !== filter.visible) return false;
      return true;
    });
  }
  if (query.visible !== false) elements = elements.filter((element) => visible(element));
  if (typeof query.index === 'number') return elements[query.index] ? [elements[query.index]] : [];
  return elements;
}

function frameRoot(frame) {
  if (!frame) return null;
  const parent = frame.parentFrame ? frameRoot(frame.parentFrame) || document : document;
  const element = parent.querySelector(String(frame.selector || 'iframe'));
  if (!(element instanceof HTMLIFrameElement)) throw failure('ZEUS_BROWSER_FRAME_NOT_FOUND', 'The frame locator did not resolve to an iframe.');
  if (!element.contentDocument) throw failure('ZEUS_BROWSER_FRAME_CROSS_ORIGIN', 'Cross-origin frames require the approved debugger capability on this surface.');
  return element.contentDocument;
}

async function locatorOperation(params) {
  const elements = resolveQuery(params.query);
  const operation = String(params.operation || 'info');
  if (operation === 'count') return elements.length;
  if (operation === 'allTextContents') return elements.map((element) => element.textContent || '');
  if (operation === 'allInnerTexts') return elements.map((element) => element.innerText || '');
  if (operation === 'waitFor') {
    const timeout = Math.max(0, Math.min(Number(params.options?.timeout || params.timeoutMs) || 30_000, 30_000));
    const state = String(params.options?.state || params.state || 'visible');
    const started = Date.now();
    while (Date.now() - started <= timeout) {
      const matches = resolveQuery(params.query);
      const ready = state === 'hidden' || state === 'detached' ? matches.length === 0 || !visible(matches[0]) : matches.length > 0 && (state !== 'visible' || visible(matches[0]));
      if (ready) return { state };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw failure('ZEUS_BROWSER_WAIT_TIMEOUT', `Timed out waiting for locator state: ${state}`);
  }
  const element = elements[0];
  if (!element) throw failure('ZEUS_BROWSER_ELEMENT_NOT_FOUND', 'The locator did not resolve to an element.');
  if (operation === 'info') return elementInfo(element);
  if (operation === 'click' || operation === 'dblclick') {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    if (operation === 'click' && typeof element.click === 'function') element.click();
    else element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, detail: 2 }));
    return true;
  }
  if (operation === 'hover') {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return true;
  }
  if (operation === 'focus') {
    element.focus();
    return true;
  }
  if (operation === 'blur') {
    element.blur();
    return true;
  }
  if (operation === 'fill' || operation === 'type' || operation === 'pressSequentially') {
    if (isSecure(element)) throw failure('ZEUS_BROWSER_SECURE_FIELD_BLOCKED', 'Secure values must be entered through Zeus Browser Auth.');
    const text = String(params.text ?? params.value ?? '');
    if (operation === 'fill') setNativeValue(element, '');
    setNativeValue(element, operation === 'fill' ? text : `${element.value || ''}${text}`);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { length: text.length };
  }
  if (operation === 'press') {
    element.dispatchEvent(keyEvent('keydown', params.key));
    element.dispatchEvent(keyEvent('keyup', params.key));
    return true;
  }
  if (operation === 'check' || operation === 'uncheck' || operation === 'setChecked') {
    element.checked = operation === 'check' || (operation === 'setChecked' && params.checked === true);
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (operation === 'selectOption') {
    const inputs = Array.isArray(params.value) ? params.value : Array.isArray(params.values) ? params.values : [params.value];
    const values = inputs.map((entry) => (typeof entry === 'string' ? { value: entry } : entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}));
    for (const [index, option] of Array.from(element.options || []).entries()) option.selected = values.some((value) => value.value === option.value || value.label === option.label || value.index === index);
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return Array.from(element.selectedOptions || []).map((option) => option.value);
  }
  if (operation === 'textContent') return element.textContent;
  if (operation === 'innerText') return element.innerText;
  if (operation === 'innerHTML') return element.innerHTML;
  if (operation === 'inputValue') {
    if (isSecure(element)) throw failure('ZEUS_BROWSER_SECURE_FIELD_BLOCKED', 'Secure fields cannot be read.');
    return element.value;
  }
  if (operation === 'getAttribute') return element.getAttribute(String(params.name || ''));
  if (operation === 'mediaUrl') {
    const candidate = element.currentSrc || element.src || element.href || element.closest?.('a')?.href;
    if (!candidate) throw failure('ZEUS_BROWSER_MEDIA_URL_MISSING', 'The locator does not expose downloadable media.');
    return new URL(candidate, location.href).href;
  }
  if (operation === 'isVisible') return visible(element);
  if (operation === 'isHidden') return !visible(element);
  if (operation === 'isEnabled') return !element.disabled;
  if (operation === 'isDisabled') return Boolean(element.disabled);
  if (operation === 'isEditable') return editable(element);
  if (operation === 'isChecked') return Boolean(element.checked);
  if (operation === 'boundingBox') return rect(element);
  if (operation === 'scrollIntoViewIfNeeded') {
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }
  if (operation === 'selectText') {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  if (operation === 'evaluate' || operation === 'evaluateAll') {
    const expression = String(params.expression || params.pageFunction || '');
    const callable = (0, eval)(`(${expression})`);
    return callable(operation === 'evaluateAll' ? elements : element, params.arg ?? params.argument);
  }
  throw failure('ZEUS_BROWSER_LOCATOR_OPERATION_UNSUPPORTED', `Unsupported locator operation: ${operation}`);
}

function coordinateClick(params) {
  const element = document.elementFromPoint(Number(params.x), Number(params.y));
  if (!element) throw failure('ZEUS_BROWSER_COORDINATE_TARGET_MISSING', 'No element exists at the requested viewport coordinate.');
  const modifiers = modifierState(params.keypress);
  if (params.button === 'right' || params.button === 'r' || Number(params.button) === 3) element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Number(params.x), clientY: Number(params.y), button: 2, ...modifiers }));
  else if (params.button === 'middle' || params.button === 'm' || Number(params.button) === 2)
    element.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, clientX: Number(params.x), clientY: Number(params.y), button: 1, ...modifiers }));
  else {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: Number(params.x), clientY: Number(params.y), ...modifiers }));
    if (Number(params.clickCount) === 2) element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2, clientX: Number(params.x), clientY: Number(params.y), ...modifiers }));
  }
  return elementInfo(element);
}

function coordinateDrag(params) {
  const path = Array.isArray(params.path) ? params.path : [];
  const first = path[0] || {};
  const last = path.at(-1) || {};
  const startX = Number(params.x ?? params.from_x ?? first.x);
  const startY = Number(params.y ?? params.from_y ?? first.y);
  const endX = Number(params.endX ?? params.to_x ?? last.x);
  const endY = Number(params.endY ?? params.to_y ?? last.y);
  if (![startX, startY, endX, endY].every(Number.isFinite)) throw failure('ZEUS_BROWSER_DRAG_PATH_INVALID', 'A drag requires at least two finite path points.');
  const target = document.elementFromPoint(startX, startY);
  if (!target) throw failure('ZEUS_BROWSER_COORDINATE_TARGET_MISSING', 'No element exists at the drag start point.');
  const modifiers = modifierState(params.keys);
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX, clientY: startY, buttons: 1, ...modifiers }));
  const points = path.length >= 2 ? path.slice(1) : Array.from({ length: 12 }, (_value, index) => ({ x: startX + ((endX - startX) * (index + 1)) / 12, y: startY + ((endY - startY) * (index + 1)) / 12 }));
  for (const point of points) target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: Number(point.x), clientY: Number(point.y), buttons: 1, ...modifiers }));
  target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: endX, clientY: endY, buttons: 0, ...modifiers }));
  return { start: { x: startX, y: startY }, end: { x: endX, y: endY } };
}

function coordinateMove(params) {
  const x = Number(params.x);
  const y = Number(params.y);
  const target = document.elementFromPoint(x, y);
  if (!target) throw failure('ZEUS_BROWSER_COORDINATE_TARGET_MISSING', 'No element exists at the requested point.');
  target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, buttons: 0, ...modifierState(params.keys) }));
  return elementInfo(target);
}

function coordinateScroll(params) {
  const element = params.x != null && params.y != null ? document.elementFromPoint(Number(params.x), Number(params.y)) : document.scrollingElement;
  const deltaX = Number(params.deltaX ?? params.xDelta ?? 0);
  const deltaY = Number(params.deltaY ?? params.yDelta ?? 0);
  (element || document).dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: Number(params.x) || 0, clientY: Number(params.y) || 0, deltaX, deltaY, ...modifierState(params.keypress) }));
  (element || window).scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
  return { x: scrollX, y: scrollY };
}

function domScroll(params) {
  const element = resolveTarget(String(params.target));
  const direction = String(params.direction || '').toLocaleLowerCase();
  const pages = Math.max(0.1, Math.min(Number(params.pages) || 1, 100));
  const deltaX = params.deltaX != null ? Number(params.deltaX) : direction === 'left' || direction === 'l' ? -element.clientWidth * pages : direction === 'right' || direction === 'r' ? element.clientWidth * pages : 0;
  const deltaY = params.deltaY != null ? Number(params.deltaY) : direction === 'up' || direction === 'u' ? -element.clientHeight * pages : element.clientHeight * pages;
  element.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
  return { x: element.scrollLeft, y: element.scrollTop };
}

function mediaUrl(params) {
  const element = params.target ? resolveTarget(String(params.target)) : document.elementFromPoint(Number(params.x), Number(params.y));
  const candidate = element?.currentSrc || element?.src || element?.href || element?.closest?.('a')?.href;
  if (!candidate) throw failure('ZEUS_BROWSER_MEDIA_URL_MISSING', 'The target does not expose downloadable media.');
  return new URL(candidate, location.href).href;
}

function accessibilityAction(params) {
  const element = resolveTarget(String(params.target));
  const action = String(params.action || '').toLocaleLowerCase();
  if (action.includes('show') && action.includes('menu')) {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    return true;
  }
  if (action.includes('increment') && 'stepUp' in element) {
    element.stepUp();
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (action.includes('decrement') && 'stepDown' in element) {
    element.stepDown();
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (action.includes('press') || action.includes('pick') || action.includes('confirm')) {
    element.click();
    return true;
  }
  throw failure('ZEUS_BROWSER_AX_ACTION_UNSUPPORTED', `The DOM surface cannot perform accessibility action: ${params.action}`);
}

function accessibilityClick(params) {
  const element = Array.isArray(params.target) ? document.elementFromPoint(Number(params.target[0]), Number(params.target[1])) : resolveTarget(String(params.target));
  if (!element) throw failure('ZEUS_BROWSER_ELEMENT_NOT_FOUND', 'The accessibility click target no longer exists.');
  const button = String(params.mouseButton || 'left');
  const clickCount = Math.max(1, Math.min(Number(params.clickCount) || 1, 3));
  if (button === 'right' || button === 'r') element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  else if (button === 'middle' || button === 'm') element.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
  else {
    element.click();
    if (clickCount > 1) element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2 }));
  }
  return { ...elementInfo(element), mouseButton: button, clickCount };
}

function selectText(params) {
  const element = resolveTarget(params.target);
  const requested = typeof params.text === 'string' ? params.text : '';
  if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && requested) {
    const matches = textRanges(element.value, requested, params.prefix, params.suffix);
    if (matches.length !== 1) throw failure(matches.length ? 'ZEUS_BROWSER_TEXT_AMBIGUOUS' : 'ZEUS_BROWSER_TEXT_NOT_FOUND', matches.length ? 'The requested text is ambiguous.' : 'The requested text was not found.');
    const match = matches[0];
    const type = String(params.selectionType || params.selection_type || 'text');
    const start = type === 'cursor_after' ? match.end : match.start;
    const end = type === 'text' ? match.end : start;
    element.focus();
    element.setSelectionRange(start, end);
    return { selected: element.value.slice(start, end), start, end };
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return { selected: bounded(selection.toString(), 20_000) };
}

function textRanges(current, requested, prefix, suffix) {
  const matches = [];
  let offset = 0;
  while (offset <= current.length - requested.length) {
    const start = current.indexOf(requested, offset);
    if (start < 0) break;
    const end = start + requested.length;
    if ((!prefix || current.slice(0, start).endsWith(prefix)) && (!suffix || current.slice(end).startsWith(suffix))) matches.push({ start, end });
    offset = start + Math.max(1, requested.length);
  }
  return matches;
}

async function waitForSelector(params) {
  const timeout = Math.max(0, Math.min(Number(params.timeoutMs) || 5000, 30_000));
  const started = Date.now();
  while (Date.now() - started <= timeout) {
    if (!params.selector || document.querySelector(String(params.selector))) return { found: Boolean(params.selector), readyState: document.readyState };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw failure('ZEUS_BROWSER_WAIT_TIMEOUT', `Timed out waiting for selector: ${params.selector}`);
}

function developerEvaluate(params) {
  if (typeof params.expression !== 'string') throw failure('ZEUS_BROWSER_EXPRESSION_REQUIRED', 'Developer evaluation requires an expression.');
  // 此入口只在 Main 完成独立开发者审批后可达；扩展自身不接受任意工具路径。
  const candidate = globalThis.eval(`(${params.expression})`);
  return typeof candidate === 'function' ? candidate(params.argument) : candidate;
}

function browserAuthValidate(params) {
  const fields = Array.isArray(params.fields) ? params.fields : [];
  const options = Array.isArray(params.options) ? params.options : [];
  const validate = (entry) => {
    const elements = resolveQuery(entry.query);
    const element = elements[0];
    return {
      id: entry.id,
      valid: elements.length === 1 && Boolean(element) && visible(element) && !element.disabled,
      multiple: elements.length !== 1,
      type: element?.getAttribute?.('type') || '',
      secure: element ? isSecure(element) : false,
    };
  };
  return { origin: location.origin, url: location.href, fields: fields.map(validate), options: options.map(validate) };
}

function browserAuthFill(params) {
  if (String(params.origin) !== location.origin) throw failure('ZEUS_BROWSER_AUTH_ORIGIN_CHANGED', 'The authentication origin changed.');
  for (const field of Array.isArray(params.fields) ? params.fields : []) {
    const elements = resolveQuery(field.query);
    const element = elements[0];
    if (elements.length !== 1 || !visible(element) || element.disabled) throw failure('ZEUS_BROWSER_AUTH_LOCATOR_INVALID', `Credential field is no longer valid: ${field.id}`);
    setNativeValue(element, String(field.value || ''));
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (params.option?.query) {
    const elements = resolveQuery(params.option.query);
    if (elements.length !== 1 || !visible(elements[0]) || elements[0].disabled) throw failure('ZEUS_BROWSER_AUTH_LOCATOR_INVALID', 'The selected sign-in option changed.');
    elements[0].click();
  }
  if (params.submit?.query) {
    const elements = resolveQuery(params.submit.query);
    if (elements.length !== 1 || !visible(elements[0]) || elements[0].disabled) throw failure('ZEUS_BROWSER_AUTH_LOCATOR_INVALID', 'The submit control changed.');
    if (params.submit.action === 'press_enter') elements[0].dispatchEvent(keyEvent('keydown', 'Enter'));
    else elements[0].click();
  }
  return { status: 'submitted' };
}

async function webMcpTools() {
  const context = navigator.modelContext || navigator.webMCP || globalThis.webMCP;
  if (!context) return null;
  const source = typeof context.listTools === 'function' ? await context.listTools() : await Promise.resolve(context.tools);
  if (!Array.isArray(source)) return [];
  return source.map((tool) => ({ name: String(tool.name || tool.id || ''), description: String(tool.description || ''), inputSchema: tool.inputSchema || tool.parameters || {} })).filter((tool) => tool.name);
}

async function webMcpCall(params) {
  const context = navigator.modelContext || navigator.webMCP || globalThis.webMCP;
  if (!context) throw failure('ZEUS_BROWSER_WEBMCP_STALE', 'WebMCP is no longer available.');
  if (typeof context.callTool === 'function') return context.callTool(String(params.name), params.input || {});
  const tools = await Promise.resolve(context.tools);
  const tool = Array.isArray(tools) ? tools.find((candidate) => String(candidate.name || candidate.id) === String(params.name)) : tools?.[String(params.name)];
  const call = tool?.call || tool?.execute || tool?.invoke;
  if (typeof call !== 'function') throw failure('ZEUS_BROWSER_WEBMCP_STALE', 'The WebMCP tool is stale or not callable.');
  return call.call(tool, params.input || {});
}

function elementInfo(element) {
  const box = rect(element);
  return {
    tagName: element.tagName?.toLowerCase() || '',
    type: element.getAttribute?.('type') || '',
    role: element.getAttribute?.('role') || implicitRole(element),
    name: accessibleName(element),
    text: bounded(element.innerText || element.textContent || '', 4000),
    href: element.href || '',
    disabled: Boolean(element.disabled || element.getAttribute?.('aria-disabled') === 'true'),
    editable: editable(element),
    fileInput: element.tagName === 'INPUT' && element.type === 'file',
    submitter: element.type === 'submit' || element.tagName === 'BUTTON',
    secure: isSecure(element),
    rect: box,
  };
}

function accessibleName(element) {
  const labelledBy = element.getAttribute?.('aria-labelledby');
  if (labelledBy)
    return labelledBy
      .split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ')
      .trim();
  if (element.getAttribute?.('aria-label')) return element.getAttribute('aria-label');
  if (element.labels?.length)
    return Array.from(element.labels)
      .map((label) => label.innerText || label.textContent || '')
      .join(' ')
      .trim();
  return (element.innerText || element.textContent || element.getAttribute?.('title') || element.getAttribute?.('placeholder') || '').trim();
}

function implicitRole(element) {
  const tag = element.tagName;
  if (tag === 'A') return 'link';
  if (tag === 'BUTTON') return 'button';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'SELECT') return 'combobox';
  if (tag === 'INPUT') return ['button', 'submit', 'reset'].includes(element.type) ? 'button' : ['checkbox', 'radio'].includes(element.type) ? element.type : 'textbox';
  return '';
}

function tagForRole(role) {
  const values = {
    button: 'button,input[type="button"],input[type="submit"]',
    link: 'a[href]',
    textbox: 'input:not([type]),input[type="text"],textarea',
    checkbox: 'input[type="checkbox"]',
    radio: 'input[type="radio"]',
    combobox: 'select',
  };
  return values[String(role)] || `[data-zeus-no-implicit-role="${cssEscape(String(role))}"]`;
}

function visible(element) {
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 && box.width > 0 && box.height > 0;
}

function editable(element) {
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}
function isSecure(element) {
  return (
    (element.tagName === 'INPUT' && ['password'].includes(String(element.type).toLowerCase())) ||
    /password|otp|one.?time|cvv|cvc|secret|token|密码|验证码|卡号/iu.test(`${element.autocomplete || ''} ${element.name || ''} ${element.id || ''} ${accessibleName(element)}`)
  );
}
function rect(element) {
  const value = element.getBoundingClientRect();
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
function bounded(value, maximum) {
  return Array.from(String(value)).slice(0, Math.max(0, maximum)).join('');
}
function matchesText(actual, expected, exact) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && typeof expected.source === 'string') {
    try {
      return new RegExp(expected.source, typeof expected.flags === 'string' ? expected.flags.replace(/[^dgimsuvy]/gu, '') : 'u').test(String(actual));
    } catch {
      return false;
    }
  }
  return exact ? String(actual).trim() === String(expected).trim() : String(actual).toLocaleLowerCase().includes(String(expected).toLocaleLowerCase());
}
function modifierState(values) {
  const keys = Array.isArray(values) ? values.map((value) => String(value).toLocaleLowerCase()) : [];
  return {
    metaKey: keys.some((key) => ['meta', 'cmd', 'command'].includes(key)),
    ctrlKey: keys.some((key) => ['ctrl', 'control'].includes(key)),
    altKey: keys.some((key) => ['alt', 'option'].includes(key)),
    shiftKey: keys.includes('shift'),
  };
}
function cssEscape(value) {
  return globalThis.CSS?.escape ? CSS.escape(value) : value.replace(/["\\]/gu, '\\$&');
}
function setNativeValue(element, value) {
  const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}
function keyEvent(type, key) {
  const text = String(key || '');
  const pieces = text.split('+');
  const value = pieces.pop() || '';
  return new KeyboardEvent(type, {
    key: value,
    code: value,
    bubbles: true,
    cancelable: true,
    metaKey: pieces.some((part) => /meta|cmd|command/iu.test(part)),
    ctrlKey: pieces.some((part) => /ctrl|control/iu.test(part)),
    altKey: pieces.some((part) => /alt|option/iu.test(part)),
    shiftKey: pieces.some((part) => /shift/iu.test(part)),
  });
}
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
