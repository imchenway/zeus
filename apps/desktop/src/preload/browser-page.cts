import { ipcRenderer } from 'electron';

function invokeBrowserPageCommand(commandType: string, body: unknown): Promise<unknown> {
  const commandId = globalThis.crypto.randomUUID();
  const envelope = Object.freeze({
    schemaGeneration: 'zeus-command-envelope-v1',
    commandId,
    commandType,
    actor: Object.freeze({ kind: 'user', id: 'desktop-browser-page-user' }),
    scope: Object.freeze({ kind: 'artifact', id: 'browser-page-comment' }),
    expectedRevision: null,
    idempotencyKey: `desktop-browser-page:${commandId}`,
    issuedAt: new Date().toISOString(),
    payload: Object.freeze({ transport: 'electron-ipc', channel: 'zeus:browser-page:save-comment' }),
  });
  return ipcRenderer.invoke('zeus:browser-page:save-comment', Object.freeze({ envelope, body }));
}

type Rect = { x: number; y: number; width: number; height: number };
type DesignChange = { kind: 'text' | 'style'; selector?: string; property?: string; previous: string; next: string };
type PageAnchor = {
  kind: 'element' | 'text' | 'region';
  pageUrl: string;
  frameUrl: string;
  pageTitle: string;
  selector?: string;
  elementPath?: string;
  shadowHostPath?: string[];
  frameDepth: number;
  role?: string;
  accessibleName?: string;
  tagName?: string;
  immediateText?: string;
  nearbyText?: string;
  rect: Rect;
  marker?: { x: number; y: number };
  textRange?: {
    text: string;
    startSelector?: string;
    startOffset?: number;
    endSelector?: string;
    endOffset?: number;
    direction: 'forward' | 'backward';
    rects: Rect[];
  };
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scroll: { x: number; y: number };
  fixed: boolean;
};
type BrowserComment = {
  id: string;
  number: number;
  body: string;
  anchor: PageAnchor;
  designChanges: DesignChange[];
  status: 'draft' | 'sent';
};
type SpeechRecognitionResultLike = { isFinal?: boolean; 0?: { transcript?: string } };
type SpeechRecognitionEventLike = { results: ArrayLike<SpeechRecognitionResultLike> };
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const overlayRootId = 'zeus-browser-annotation-root';
const state = {
  enabled: false,
  comments: [] as BrowserComment[],
  hoverTarget: null as Element | null,
  pointerStart: null as { x: number; y: number } | null,
  pointerCurrent: null as { x: number; y: number } | null,
  suppressNextClick: false,
  editorAnchor: null as PageAnchor | null,
  editorPoint: null as { x: number; y: number } | null,
  editorTarget: null as HTMLElement | null,
  originalText: null as string | null,
  editorTextNode: null as Text | null,
  originalTextNodeValue: null as string | null,
  originalInlineStyles: new Map<string, string>(),
  originalInlinePriorities: new Map<string, string>(),
  originalComputedStyles: new Map<string, string>(),
  adjustedProperties: new Set<string>(),
  renderScheduled: false,
};

let rootHost: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let hoverOutline: HTMLDivElement | null = null;
let regionOutline: HTMLDivElement | null = null;
let markerLayer: HTMLDivElement | null = null;
let editorPin: HTMLDivElement | null = null;
let editor: HTMLDivElement | null = null;
let speechRecognition: SpeechRecognitionLike | null = null;

function install(): void {
  if (document.getElementById(overlayRootId)) return;
  rootHost = document.createElement('div');
  rootHost.id = overlayRootId;
  rootHost.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  shadow = rootHost.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; color-scheme: light dark; }
    * { box-sizing: border-box; }
    .outline { position: fixed; pointer-events: none; border: 2px solid #1689e8; border-radius: 4px; background: rgb(22 137 232 / 14%); display: none; }
    .region { border-style: dashed; border-radius: 8px; background: rgb(22 137 232 / 12%); }
    .markers { position: fixed; inset: 0; pointer-events: none; }
    .marker { position: fixed; width: 23px; height: 23px; border: 2px solid white; border-radius: 999px; background: #1689e8; color: white; display: grid; place-items: center; font: 650 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; box-shadow: 0 3px 12px rgb(15 23 42 / 24%); pointer-events: auto; cursor: pointer; transition: transform 120ms ease, box-shadow 120ms ease; }
    .marker:hover,.marker[data-focus="true"] { transform: scale(1.12); box-shadow: 0 4px 16px rgb(22 137 232 / 38%); }
    .editor-pin { position: fixed; width: 26px; height: 26px; border: 2px solid white; border-radius: 999px; background: #1689e8; box-shadow: 0 3px 12px rgb(15 23 42 / 24%); display: none; pointer-events: none; transform: translate(-50%, -50%); }
    .editor-pin::after { position: absolute; left: 2px; bottom: -3px; width: 8px; height: 8px; border: 2px solid white; border-top: 0; border-right: 0; border-radius: 0 0 0 6px; background: #1689e8; content: ""; transform: rotate(-18deg); }
    .editor { position: fixed; width: min(296px, calc(100vw - 24px)); padding: 4px 5px; border: 1px solid rgb(23 23 23 / 10%); border-radius: 999px; background: rgb(255 255 255 / 98%); color: #202124; box-shadow: 0 8px 28px rgb(15 23 42 / 18%); backdrop-filter: blur(20px); pointer-events: auto; font: 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .editor[data-expanded="true"] { width: min(360px, calc(100vw - 24px)); border-radius: 20px; }
    .editor[hidden] { display: none; }
    .editor-row { align-items: center; display: flex; gap: 3px; min-height: 36px; }
    .editor textarea { flex: 1 1 auto; width: 100%; min-width: 0; min-height: 28px; max-height: 112px; resize: none; overflow-y: auto; border: 0; padding: 4px 5px; background: transparent; color: #202124; font: inherit; outline: none; }
    .editor textarea::placeholder { color: #8b8b8b; }
    .editor button { appearance: none; align-items: center; background: transparent; border: 0; border-radius: 999px; color: #737373; cursor: pointer; display: inline-flex; flex: 0 0 auto; height: 30px; justify-content: center; padding: 0; width: 30px; }
    .editor button:hover { background: rgb(0 0 0 / 6%); color: #202124; }
    .editor button svg { height: 18px; width: 18px; }
    .editor button.editor-save { background: #181818; color: white; }
    .editor button.editor-save:hover { background: #000; }
    .editor button[hidden] { display: none; }
    .editor button[data-listening="true"] { background: rgb(11 130 246 / 12%); color: #0b82f6; }
    .editor button:focus-visible,.editor input:focus-visible,.editor textarea:focus-visible { outline: 2px solid #0b82f6; outline-offset: 2px; }
    .editor textarea:focus-visible { outline: 0; }
    .adjust { margin: 2px 5px 5px; padding: 10px 4px 3px; border-top: 1px solid rgb(32 33 36 / 10%); display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .adjust[hidden] { display: none; }
    .adjust label { display: grid; gap: 4px; color: #6f6f6f; font-size: 11px; }
    .adjust label.wide { grid-column: 1 / -1; }
    .adjust input { width: 100%; height: 30px; border: 1px solid rgb(32 33 36 / 15%); border-radius: 8px; padding: 0 8px; background: white; color: #202124; }
    .adjust input[type="color"] { padding: 3px; }
    @media (max-width: 360px) { .editor,.editor[data-expanded="true"] { width: calc(100vw - 24px); } }
    @media (prefers-reduced-motion: reduce) { .marker { transition: none; } }
  `;
  shadow.append(style);
  hoverOutline = document.createElement('div');
  hoverOutline.className = 'outline';
  regionOutline = document.createElement('div');
  regionOutline.className = 'outline region';
  markerLayer = document.createElement('div');
  markerLayer.className = 'markers';
  editorPin = document.createElement('div');
  editorPin.className = 'editor-pin';
  editor = document.createElement('div');
  editor.className = 'editor';
  editor.hidden = true;
  shadow.append(hoverOutline, regionOutline, markerLayer, editorPin, editor);
  (document.documentElement || document.body).append(rootHost);
  window.addEventListener('pointermove', handlePointerMove, true);
  window.addEventListener('pointerdown', handlePointerDown, true);
  window.addEventListener('pointerup', handlePointerUp, true);
  window.addEventListener('click', handleClick, true);
  window.addEventListener(
    'keydown',
    (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== '.') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void ipcRenderer.invoke('zeus:browser-page:set-annotation-mode', !state.enabled);
    },
    true,
  );
  window.addEventListener('scroll', scheduleRender, true);
  window.addEventListener('resize', scheduleRender, true);
  new MutationObserver((records) => {
    if (records.some((record) => !isOverlayNode(record.target))) scheduleRender();
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  render();
  void hydrateFromHost();
}

async function hydrateFromHost(): Promise<void> {
  try {
    const message = (await ipcRenderer.invoke('zeus:browser-page:get-state')) as { comments?: unknown; annotationMode?: unknown };
    state.enabled = message.annotationMode === true;
    hydrateComments(Array.isArray(message.comments) ? (message.comments as BrowserComment[]) : []);
  } catch {
    // 页面关闭或导航竞态时由下一次 dom-ready 同步恢复。
  }
}

function handlePointerMove(event: PointerEvent): void {
  if (!state.enabled || isOverlayEvent(event)) return;
  if (editor && !editor.hidden) return;
  state.pointerCurrent = { x: event.clientX, y: event.clientY };
  if (state.pointerStart && distance(state.pointerStart, state.pointerCurrent) > 7) {
    drawRect(regionOutline, rectangleFromPoints(state.pointerStart, state.pointerCurrent));
  } else {
    state.hoverTarget = annotationTargetFromEvent(event);
    if (state.hoverTarget) drawTargetRect(hoverOutline, state.hoverTarget);
  }
}

function handlePointerDown(event: PointerEvent): void {
  if (!state.enabled || event.button !== 0 || isOverlayEvent(event)) return;
  state.pointerStart = { x: event.clientX, y: event.clientY };
  state.pointerCurrent = state.pointerStart;
}

function handlePointerUp(event: PointerEvent): void {
  if (!state.enabled || event.button !== 0 || isOverlayEvent(event) || !state.pointerStart) return;
  state.pointerCurrent = { x: event.clientX, y: event.clientY };
  const start = state.pointerStart;
  const current = state.pointerCurrent;
  state.pointerStart = null;
  hide(regionOutline);
  hide(hoverOutline);
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim()) {
    const anchor = textAnchor(selection);
    anchor.marker = current;
    state.suppressNextClick = true;
    openEditor(anchor, commonSelectionElement(selection), current);
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (distance(start, current) > 7) {
    const anchor = regionAnchor(rectangleFromPoints(start, current));
    anchor.marker = current;
    state.suppressNextClick = true;
    openEditor(anchor, null, current);
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  const target = annotationTargetFromEvent(event);
  if (target) {
    const anchor = elementAnchor(target);
    anchor.marker = current;
    state.suppressNextClick = true;
    openEditor(anchor, target instanceof HTMLElement ? target : null, current);
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function handleClick(event: MouseEvent): void {
  const externalUrl = systemBrowserUrlFromEvent(event);
  if (externalUrl) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void ipcRenderer.invoke('zeus:browser-page:open-system-browser-link', externalUrl).catch(() => undefined);
    return;
  }
  if (!state.enabled || isOverlayEvent(event)) return;
  if (!state.suppressNextClick) return;
  state.suppressNextClick = false;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function systemBrowserUrlFromEvent(event: MouseEvent): string | null {
  if (!event.isTrusted || event.button !== 0 || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || state.enabled || isOverlayEvent(event)) return null;
  const anchor = event
    .composedPath()
    .filter((candidate): candidate is Element => candidate instanceof Element)
    .map((candidate) => candidate.closest('a[href]'))
    .find((candidate): candidate is HTMLAnchorElement => candidate instanceof HTMLAnchorElement);
  if (!anchor) return null;
  try {
    const url = new URL(anchor.href, document.baseURI);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function openEditor(
  anchor: PageAnchor,
  target: HTMLElement | null,
  point: { x: number; y: number } = anchor.marker ?? {
    x: anchor.rect.x + anchor.rect.width / 2,
    y: anchor.rect.y,
  },
): void {
  if (!editor) return;
  restorePreview();
  state.editorAnchor = anchor;
  state.editorPoint = point;
  state.editorTarget = target;
  state.originalText = target?.textContent ?? null;
  state.editorTextNode = target ? editableTextNode(target) : null;
  state.originalTextNodeValue = state.editorTextNode?.data ?? null;
  state.originalInlineStyles.clear();
  state.originalInlinePriorities.clear();
  state.originalComputedStyles.clear();
  state.adjustedProperties.clear();
  editor.dataset.expanded = 'false';
  editor.innerHTML = `
    <div class="editor-row">
      <button type="button" data-action="adjust" aria-label="Adjust" title="Adjust">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M4 7h7M15 7h5M4 17h4M12 17h8"></path>
          <circle cx="13" cy="7" r="2"></circle><circle cx="10" cy="17" r="2"></circle>
        </svg>
      </button>
      <textarea rows="1" aria-label="Browser comment" placeholder="Add a comment…"></textarea>
      <button type="button" data-action="voice" aria-label="Voice input" title="Voice input">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"></path>
        </svg>
      </button>
      <button type="button" class="editor-save" data-action="save" aria-label="Save comment" title="Save comment" hidden>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 12.5 4 4L18.5 8"></path>
        </svg>
      </button>
    </div>
    <div class="adjust" hidden>
      <label class="wide">Text<input data-adjust="text" type="text" value=""></label>
      <label>Font size<input data-adjust="font-size" type="text" placeholder="e.g. 16px"></label>
      <label>Padding<input data-adjust="padding" type="text" placeholder="e.g. 12px"></label>
      <label>Text color<input data-adjust="color" type="color" value="#1f2937"></label>
      <label>Background<input data-adjust="background-color" type="color" value="#ffffff"></label>
    </div>
  `;
  const textarea = editor.querySelector<HTMLTextAreaElement>('textarea')!;
  const textInput = editor.querySelector<HTMLInputElement>('[data-adjust="text"]')!;
  textInput.value = (state.originalTextNodeValue ?? target?.textContent ?? '').trim().slice(0, 2_000);
  editor.querySelector('[data-action="adjust"]')?.addEventListener('click', () => {
    const controls = editor?.querySelector<HTMLElement>('.adjust');
    if (!controls || !editor) return;
    controls.hidden = !controls.hidden;
    editor.dataset.expanded = String(!controls.hidden);
    positionEditor(anchor);
  });
  editor.querySelector('[data-action="save"]')?.addEventListener('click', () => void saveComment());
  const voiceButton = editor.querySelector<HTMLButtonElement>('[data-action="voice"]');
  if (voiceButton) installVoiceInput(voiceButton, textarea);
  textarea.addEventListener('input', () => syncEditorActions(textarea));
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEditor();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void saveComment();
    }
  });
  for (const input of editor.querySelectorAll<HTMLInputElement>('[data-adjust]')) {
    input.addEventListener('input', () => applyPreview(input));
  }
  editor.hidden = false;
  if (target) drawTargetRect(hoverOutline, target);
  else drawRect(hoverOutline, anchor.rect);
  positionEditor(anchor);
  syncEditorActions(textarea);
  queueMicrotask(() => textarea.focus({ preventScroll: true }));
}

function positionEditor(anchor: PageAnchor): void {
  if (!editor || editor.hidden) return;
  const width = Math.min(editor.offsetWidth || 296, Math.max(1, window.innerWidth - 24));
  const height = editor.offsetHeight || 46;
  const point = state.editorPoint ??
    anchor.marker ?? {
      x: anchor.rect.x + anchor.rect.width / 2,
      y: anchor.rect.y,
    };
  const gap = 24;
  const preferredRight = point.x + gap;
  const preferredLeft = point.x - width - gap;
  const x = preferredRight + width + 12 <= window.innerWidth ? preferredRight : Math.max(12, Math.min(window.innerWidth - width - 12, preferredLeft));
  const y = Math.max(12, Math.min(window.innerHeight - height - 12, point.y - height / 2));
  editor.style.left = `${x}px`;
  editor.style.top = `${y}px`;
  if (editorPin) {
    editorPin.style.display = 'block';
    editorPin.style.left = `${point.x}px`;
    editorPin.style.top = `${point.y}px`;
  }
}

function syncEditorActions(textarea: HTMLTextAreaElement): void {
  if (!editor) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(112, Math.max(28, textarea.scrollHeight))}px`;
  const hasBody = Boolean(textarea.value.trim());
  const saveButton = editor.querySelector<HTMLButtonElement>('[data-action="save"]');
  const voiceButton = editor.querySelector<HTMLButtonElement>('[data-action="voice"]');
  if (saveButton) saveButton.hidden = !hasBody;
  if (voiceButton) voiceButton.hidden = hasBody;
  if (state.editorAnchor) positionEditor(state.editorAnchor);
}

function installVoiceInput(button: HTMLButtonElement, textarea: HTMLTextAreaElement): void {
  const Recognition =
    (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor; SpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition;
  if (!Recognition) {
    button.title = 'Focus this field, then use system dictation';
    button.addEventListener('click', () => textarea.focus());
    return;
  }
  button.addEventListener('click', () => {
    if (speechRecognition) {
      speechRecognition.stop();
      return;
    }
    const recognition = new Recognition();
    speechRecognition = recognition;
    recognition.lang = document.documentElement.lang || navigator.language || 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = [...Array(event.results.length).keys()]
        .map((index) => event.results[index]?.[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (!transcript) return;
      textarea.value = [textarea.value.trim(), transcript].filter(Boolean).join(' ');
      syncEditorActions(textarea);
    };
    const finish = (): void => {
      button.dataset.listening = 'false';
      speechRecognition = null;
    };
    recognition.onend = finish;
    recognition.onerror = finish;
    button.dataset.listening = 'true';
    recognition.start();
  });
}

async function saveComment(): Promise<void> {
  if (!editor || !state.editorAnchor) return;
  const textarea = editor.querySelector<HTMLTextAreaElement>('textarea');
  const body = textarea?.value.trim() ?? '';
  if (!body) {
    textarea?.focus();
    return;
  }
  const buttons = [...editor.querySelectorAll<HTMLButtonElement>('button')];
  for (const button of buttons) button.disabled = true;
  const designChanges = collectDesignChanges();
  editor.hidden = true;
  render();
  try {
    await invokeBrowserPageCommand('desktop.browser.save_comment', {
      body,
      anchor: state.editorAnchor,
      designChanges,
    });
    closeEditor(false);
  } catch (error) {
    editor.hidden = false;
    render();
    for (const button of buttons) button.disabled = false;
    textarea?.setCustomValidity(error instanceof Error ? error.message : String(error));
    textarea?.reportValidity();
  }
}

function applyPreview(input: HTMLInputElement): void {
  if (!editor || !state.editorTarget) return;
  const target = state.editorTarget;
  const property = input.dataset.adjust;
  if (!property) return;
  state.adjustedProperties.add(property);
  if (property === 'text') {
    if (state.editorTextNode && state.originalTextNodeValue !== null) {
      state.editorTextNode.data = replaceTextNodeValue(state.originalTextNodeValue, input.value);
    } else if (state.originalText !== null) {
      target.textContent = input.value;
    }
  } else {
    if (!state.originalInlineStyles.has(property)) {
      state.originalInlineStyles.set(property, target.style.getPropertyValue(property));
      state.originalInlinePriorities.set(property, target.style.getPropertyPriority(property));
      state.originalComputedStyles.set(property, getComputedStyle(target).getPropertyValue(property).trim());
    }
    const value = input.value.trim();
    if (value) target.style.setProperty(property, value, 'important');
    else {
      const original = state.originalInlineStyles.get(property);
      if (original) target.style.setProperty(property, original, state.originalInlinePriorities.get(property) || '');
      else target.style.removeProperty(property);
    }
  }
  scheduleRender();
}

function collectDesignChanges(): DesignChange[] {
  if (!editor || !state.editorTarget || !state.editorAnchor) return [];
  const changes: DesignChange[] = [];
  const textInput = editor.querySelector<HTMLInputElement>('[data-adjust="text"]');
  const previousText = state.originalTextNodeValue?.trim() ?? state.originalText;
  if (state.adjustedProperties.has('text') && textInput && previousText !== null && textInput.value !== previousText) {
    changes.push({ kind: 'text', selector: state.editorAnchor.selector, previous: previousText, next: textInput.value });
  }
  for (const property of state.adjustedProperties) {
    if (property === 'text') continue;
    const input = editor.querySelector<HTMLInputElement>(`[data-adjust="${CSS.escape(property)}"]`);
    if (!input) continue;
    const next = input.value.trim();
    if (!next) continue;
    const previous = state.originalComputedStyles.get(property) ?? state.originalInlineStyles.get(property) ?? '';
    if (previous.trim() !== next) changes.push({ kind: 'style', selector: state.editorAnchor.selector, property, previous: previous.trim(), next });
  }
  return changes;
}

function restorePreview(): void {
  const target = state.editorTarget;
  if (!target) return;
  if (state.editorTextNode && state.originalTextNodeValue !== null) {
    state.editorTextNode.data = state.originalTextNodeValue;
  } else if (state.originalText !== null) {
    target.textContent = state.originalText;
  }
  for (const [property, value] of state.originalInlineStyles) {
    if (value) target.style.setProperty(property, value, state.originalInlinePriorities.get(property) || '');
    else target.style.removeProperty(property);
  }
}

function closeEditor(restore = true): void {
  if (speechRecognition) {
    speechRecognition.stop();
    speechRecognition = null;
  }
  if (restore) restorePreview();
  if (editor) {
    editor.hidden = true;
    editor.innerHTML = '';
    editor.dataset.expanded = 'false';
  }
  hide(editorPin);
  hide(hoverOutline);
  hide(regionOutline);
  state.editorAnchor = null;
  state.editorPoint = null;
  state.editorTarget = null;
  state.originalText = null;
  state.editorTextNode = null;
  state.originalTextNodeValue = null;
  state.originalInlineStyles.clear();
  state.originalInlinePriorities.clear();
  state.originalComputedStyles.clear();
  state.adjustedProperties.clear();
  window.getSelection()?.removeAllRanges();
}

function elementAnchor(element: Element): PageAnchor {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const role = element.getAttribute('role') || implicitRole(element);
  const explicitAccessibleName = element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || '';
  const inputValue = element instanceof HTMLInputElement ? element.value : '';
  const semanticText = element instanceof HTMLElement ? editableTextNode(element)?.data : element.textContent;
  const accessibleName = explicitAccessibleName || (role === 'button' || role === 'link' || role === 'heading' ? normalizedText(inputValue || semanticText || element.textContent, 1_000) : '');
  return baseAnchor('element', rect, {
    selector: selectorFor(element),
    elementPath: elementPath(element),
    shadowHostPath: shadowHostPath(element),
    role,
    accessibleName,
    tagName: element.tagName,
    immediateText: normalizedText(element.textContent, 2_000),
    nearbyText: normalizedText(element.parentElement?.textContent, 2_000),
    fixed: style.position === 'fixed' || style.position === 'sticky',
  });
}

function regionAnchor(rect: Rect): PageAnchor {
  const element = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return baseAnchor('region', rect, {
    ...(element ? { selector: selectorFor(element), elementPath: elementPath(element), nearbyText: normalizedText(element.parentElement?.textContent, 2_000) } : {}),
  });
}

function textAnchor(selection: Selection): PageAnchor {
  const range = selection.getRangeAt(0);
  const rects = [...range.getClientRects()].map(toRect);
  const rect = unionRects(rects);
  const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  return baseAnchor('text', rect, {
    ...(startElement ? { selector: selectorFor(startElement), elementPath: elementPath(startElement), nearbyText: normalizedText(startElement.parentElement?.textContent, 2_000) } : {}),
    immediateText: normalizedText(selection.toString(), 20_000),
    textRange: {
      text: selection.toString(),
      ...(startElement ? { startSelector: selectorFor(startElement) } : {}),
      startOffset: range.startOffset,
      ...(endElement ? { endSelector: selectorFor(endElement) } : {}),
      endOffset: range.endOffset,
      direction: selection.anchorNode === range.startContainer && selection.anchorOffset === range.startOffset ? 'forward' : 'backward',
      rects,
    },
  });
}

function baseAnchor(kind: PageAnchor['kind'], rect: DOMRect | Rect, details: Partial<PageAnchor>): PageAnchor {
  return {
    kind,
    pageUrl: topPageUrl(),
    frameUrl: location.href,
    pageTitle: document.title,
    frameDepth: frameDepth(),
    rect: toRect(rect),
    viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 },
    scroll: { x: window.scrollX, y: window.scrollY },
    fixed: false,
    ...details,
  };
}

function selectorFor(element: Element): string {
  if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
  for (const attribute of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const selector = `${element.tagName.toLowerCase()}[${attribute}="${CSS.escape(value)}"]`;
    if (document.querySelectorAll(selector).length === 1) return selector;
  }
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement && parts.length < 10) {
    let part = current.tagName.toLowerCase();
    const siblings = current.parentElement ? [...current.parentElement.children].filter((candidate) => candidate.tagName === current!.tagName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    parts.unshift(part);
    const candidate = parts.join(' > ');
    try {
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    } catch {
      // 继续构造父路径。
    }
    current = current.parentElement;
  }
  return parts.join(' > ') || element.tagName.toLowerCase();
}

function elementPath(element: Element): string {
  const parts: string[] = [];
  let current: Node | null = element;
  while (current instanceof Element && parts.length < 24) {
    const parent: Element | null = current.parentElement;
    const index = parent ? [...parent.children].indexOf(current) : 0;
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    const root: Node = current.getRootNode();
    if (root instanceof ShadowRoot) {
      current = root.host;
      parts.unshift('::shadow');
    } else {
      current = parent;
    }
  }
  return parts.join('/');
}

function shadowHostPath(element: Element): string[] {
  const hosts: string[] = [];
  let current: Node = element;
  while (true) {
    const root = current.getRootNode();
    if (!(root instanceof ShadowRoot)) break;
    hosts.unshift(selectorFor(root.host));
    current = root.host;
  }
  return hosts;
}

function implicitRole(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (element instanceof HTMLInputElement) {
    if (['button', 'submit', 'reset', 'image'].includes(element.type)) return 'button';
    if (element.type === 'checkbox') return 'checkbox';
    if (element.type === 'radio') return 'radio';
    if (element.type === 'range') return 'slider';
    if (element.type === 'number') return 'spinbutton';
    if (element.type === 'search') return 'searchbox';
    return 'textbox';
  }
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (/^h[1-6]$/u.test(tag)) return 'heading';
  if (tag === 'img') return 'img';
  return '';
}

function topPageUrl(): string {
  try {
    return window.top?.location.href || location.href;
  } catch {
    return document.referrer || location.href;
  }
}

function frameDepth(): number {
  let depth = 0;
  let current: Window = window;
  try {
    while (current !== current.top && depth < 32) {
      depth += 1;
      current = current.parent;
    }
  } catch {
    return Math.max(1, depth);
  }
  return depth;
}

function hydrateComments(comments: BrowserComment[]): void {
  state.comments = comments.filter((comment) => comment.status === 'draft' && comment.anchor.frameUrl === location.href);
  for (const comment of state.comments) applyPersistedDesignChanges(comment);
  renderMarkers();
}

function applyPersistedDesignChanges(comment: BrowserComment): void {
  const selector = comment.anchor.selector;
  if (!selector) return;
  let target: HTMLElement | null = null;
  try {
    target = document.querySelector(selector);
  } catch {
    return;
  }
  if (!target) return;
  for (const change of comment.designChanges) {
    if (change.kind === 'text') {
      const textNode = editableTextNode(target);
      if (textNode) textNode.data = replaceTextNodeValue(textNode.data, change.next);
      else target.textContent = change.next;
    } else if (change.property) target.style.setProperty(change.property, change.next, 'important');
  }
}

function renderMarkers(): void {
  if (!markerLayer) return;
  markerLayer.replaceChildren();
  for (const comment of state.comments) {
    const marker = document.createElement('button');
    marker.className = 'marker';
    marker.type = 'button';
    marker.textContent = String(comment.number);
    marker.dataset.commentId = comment.id;
    marker.setAttribute('aria-label', `Browser comment ${comment.number}: ${comment.body}`);
    marker.addEventListener('click', () => focusComment(comment.id));
    markerLayer.append(marker);
  }
  render();
}

function focusComment(commentId: string): void {
  const comment = state.comments.find((candidate) => candidate.id === commentId);
  if (!comment) return;
  if (comment.anchor.selector) {
    try {
      document.querySelector(comment.anchor.selector)?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    } catch {
      // 失效锚点仍保留编号和结构化上下文。
    }
  }
  for (const marker of markerLayer?.querySelectorAll<HTMLElement>('.marker') ?? []) marker.dataset.focus = String(marker.dataset.commentId === commentId);
  setTimeout(() => {
    for (const marker of markerLayer?.querySelectorAll<HTMLElement>('.marker') ?? []) delete marker.dataset.focus;
  }, 1200);
}

function scheduleRender(): void {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(render);
}

function render(): void {
  state.renderScheduled = false;
  if (rootHost) rootHost.style.display = state.enabled || state.comments.length || !editor?.hidden ? 'block' : 'none';
  if (state.editorAnchor && editor && !editor.hidden) {
    if (state.editorTarget) drawTargetRect(hoverOutline, state.editorTarget);
    else drawRect(hoverOutline, resolveAnchorRect(state.editorAnchor));
    positionEditor({ ...state.editorAnchor, rect: resolveAnchorRect(state.editorAnchor) });
  }
  for (const marker of markerLayer?.querySelectorAll<HTMLElement>('.marker') ?? []) {
    const comment = state.comments.find((candidate) => candidate.id === marker.dataset.commentId);
    if (!comment) continue;
    const point = resolveCommentMarker(comment);
    marker.style.left = `${Math.max(3, Math.min(window.innerWidth - 26, point.x - 11))}px`;
    marker.style.top = `${Math.max(3, Math.min(window.innerHeight - 26, point.y - 11))}px`;
  }
}

function resolveAnchorRect(anchor: PageAnchor): Rect {
  if (anchor.selector) {
    try {
      const element = document.querySelector(anchor.selector);
      if (element) return toRect(element.getBoundingClientRect());
    } catch {
      // 使用保存时几何回退。
    }
  }
  return {
    ...anchor.rect,
    x: anchor.fixed ? anchor.rect.x : anchor.rect.x + anchor.scroll.x - window.scrollX,
    y: anchor.fixed ? anchor.rect.y : anchor.rect.y + anchor.scroll.y - window.scrollY,
  };
}

function resolveCommentMarker(comment: BrowserComment): { x: number; y: number } {
  const marker = comment.anchor.marker;
  const fallback = marker ?? {
    x: comment.anchor.rect.x + comment.anchor.rect.width - 1,
    y: comment.anchor.rect.y,
  };
  if (comment.anchor.selector) {
    try {
      const element = document.querySelector(comment.anchor.selector);
      if (element) {
        const current = element.getBoundingClientRect();
        return {
          x: current.x + (fallback.x - comment.anchor.rect.x),
          y: current.y + (fallback.y - comment.anchor.rect.y),
        };
      }
    } catch {
      // 使用保存时的落点和滚动差值。
    }
  }
  return {
    x: comment.anchor.fixed ? fallback.x : fallback.x + comment.anchor.scroll.x - window.scrollX,
    y: comment.anchor.fixed ? fallback.y : fallback.y + comment.anchor.scroll.y - window.scrollY,
  };
}

function isOverlayEvent(event: Event): boolean {
  return event.composedPath().some((candidate) => isOverlayNode(candidate));
}

function annotationTargetFromEvent(event: Event): Element | null {
  const raw = event.composedPath().find((candidate): candidate is Element => candidate instanceof Element && !isOverlayNode(candidate));
  if (!raw) return null;
  return raw.closest('button,a[href],input,textarea,select,summary,[role],[contenteditable="true"]') ?? raw;
}

function isOverlayNode(value: unknown): boolean {
  return value === rootHost || value === shadow || (value instanceof Node && Boolean(shadow?.contains(value)));
}

function drawRect(element: HTMLElement | null, rect: DOMRect | Rect): void {
  if (!element) return;
  element.style.display = 'block';
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${Math.max(0, rect.width)}px`;
  element.style.height = `${Math.max(0, rect.height)}px`;
}

function drawTargetRect(outline: HTMLElement | null, target: Element): void {
  if (!outline) return;
  drawRect(outline, target.getBoundingClientRect());
  const radius = getComputedStyle(target).borderRadius;
  outline.style.borderRadius = radius && radius !== '0px' ? radius : '4px';
}

function hide(element: HTMLElement | null): void {
  if (element) element.style.display = 'none';
}

function rectangleFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): Rect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function toRect(rect: DOMRect | Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function unionRects(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizedText(value: string | null | undefined, maximum: number): string {
  return (value || '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function editableTextNode(element: HTMLElement): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text && node.data.trim()) {
      const parent = node.parentElement;
      const style = parent ? getComputedStyle(parent) : null;
      if (parent && !parent.closest('script,style,noscript,[aria-hidden="true"]') && style?.display !== 'none' && style?.visibility !== 'hidden') return node;
    }
    node = walker.nextNode();
  }
  return null;
}

function replaceTextNodeValue(original: string, next: string): string {
  const leading = original.match(/^\s*/u)?.[0] ?? '';
  const trailing = original.match(/\s*$/u)?.[0] ?? '';
  return `${leading}${next}${trailing}`;
}

function commonSelectionElement(selection: Selection): HTMLElement | null {
  if (!selection.rangeCount) return null;
  const container = selection.getRangeAt(0).commonAncestorContainer;
  return container instanceof HTMLElement ? container : container.parentElement;
}

ipcRenderer.on('zeus-browser-page:command', (_event, message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const command = message as { type?: unknown; enabled?: unknown; comments?: unknown; annotationMode?: unknown; commentId?: unknown };
  if (command.type === 'set_annotation_mode') {
    state.enabled = command.enabled === true;
    if (!state.enabled) {
      hide(hoverOutline);
      hide(regionOutline);
      closeEditor();
    }
    render();
  } else if (command.type === 'hydrate_comments') {
    state.enabled = command.annotationMode === true;
    hydrateComments(Array.isArray(command.comments) ? (command.comments as BrowserComment[]) : []);
  } else if (command.type === 'focus_comment' && typeof command.commentId === 'string') {
    focusComment(command.commentId);
  }
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
