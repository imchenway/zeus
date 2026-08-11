import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ConversationFileLocation, ConversationOpenTarget, ConversationResourceOpenTarget, ZeusBrowserSettings } from '@zeus/shared';
import type { RendererLocalServerConfig } from './localServerRuntime.js';

interface ConversationResourceOpenIntent {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  itemId: string;
  kind: 'file' | 'website' | 'attachment';
  presentation: 'inline' | 'card';
  display: Record<string, unknown>;
  target: Record<string, unknown>;
  authority: Record<string, unknown>;
}

export interface ConversationResourceRequest {
  projectId: string;
  conversationId: string;
  resourceId: string;
}

export interface OpenConversationResourceRequest extends ConversationResourceRequest {
  target: ConversationOpenTarget;
  location?: ConversationFileLocation;
}

export interface TurnChangeFileRequest {
  projectId: string;
  conversationId: string;
  turnId: string;
  changeSetId: string;
  fileId: string;
}

export interface OpenTurnChangeFileRequest extends TurnChangeFileRequest {
  target: ConversationOpenTarget;
  location?: ConversationFileLocation;
}

export interface OpenConversationResourceResult {
  opened: boolean;
  resourceId: string;
  target: ConversationOpenTarget;
  mode?: 'zeus_source' | 'zeus_browser' | 'external' | 'file' | 'clipboard';
  error?: string;
}

interface EditorTargetDescriptor {
  id: Extract<ConversationOpenTarget, `editor:${string}`>;
  label: string;
  appName: string;
  appPaths: string[];
}

export interface ConversationResourceOpenServices {
  config: RendererLocalServerConfig;
  fetchJson: (url: string, init: { headers: Record<string, string> }) => Promise<unknown>;
  pathExists: (path: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  openPath: (path: string) => Promise<string>;
  showItemInFolder: (path: string) => void;
  writeClipboardText: (text: string) => void;
  openBrowser: (input: { conversationId: string; url: string }) => Promise<unknown>;
  executeFile: (file: string, args: string[]) => Promise<unknown>;
  applicationHome: string;
  getSettings: () => ZeusBrowserSettings;
}

const editorTargets: EditorTargetDescriptor[] = [
  {
    id: 'editor:vscode',
    label: 'Visual Studio Code',
    appName: 'Visual Studio Code',
    appPaths: ['/Applications/Visual Studio Code.app'],
  },
  {
    id: 'editor:vscode-insiders',
    label: 'Visual Studio Code - Insiders',
    appName: 'Visual Studio Code - Insiders',
    appPaths: ['/Applications/Visual Studio Code - Insiders.app'],
  },
  {
    id: 'editor:cursor',
    label: 'Cursor',
    appName: 'Cursor',
    appPaths: ['/Applications/Cursor.app'],
  },
  {
    id: 'editor:windsurf',
    label: 'Windsurf',
    appName: 'Windsurf',
    appPaths: ['/Applications/Windsurf.app'],
  },
];

export async function listConversationResourceOpenTargets(request: ConversationResourceRequest, services: ConversationResourceOpenServices): Promise<{ resourceId: string; targets: ConversationResourceOpenTarget[] }> {
  const intent = await loadConversationResourceIntent(request, services);
  return listOpenTargetsForIntent(intent, services);
}

async function listOpenTargetsForIntent(intent: ConversationResourceOpenIntent, services: ConversationResourceOpenServices): Promise<{ resourceId: string; targets: ConversationResourceOpenTarget[] }> {
  const targets: ConversationResourceOpenTarget[] = [];
  if (intent.kind === 'website') {
    const url = authorizedWebsiteUrl(intent);
    if (url.protocol !== 'mailto:') {
      const browserEnabled = services.getSettings().enabled;
      targets.push({
        id: 'zeus_browser',
        label: 'Zeus Browser',
        available: browserEnabled,
        exactLocation: false,
        ...(!browserEnabled ? { reason: 'built_in_browser_disabled' } : {}),
      });
    }
    targets.push({ id: 'system_default', label: 'Default browser', available: true, exactLocation: false });
    targets.push({ id: 'copy_link', label: 'Copy link', available: true, exactLocation: false });
    return { resourceId: intent.id, targets };
  }

  const file = await authorizedFile(intent);
  const sourcePreviewable = isSourcePreviewable(file.absolutePath);
  const imagePreviewable = isImagePreviewable(file.absolutePath);
  const localHtml = ['.html', '.htm'].includes(extname(file.absolutePath).toLocaleLowerCase());
  if (sourcePreviewable || imagePreviewable) {
    targets.push({
      id: 'zeus_source',
      label: sourcePreviewable ? 'Zeus source preview' : 'Zeus image preview',
      available: true,
      exactLocation: sourcePreviewable,
    });
  }
  if (localHtml) {
    const browserEnabled = services.getSettings().enabled;
    targets.push({
      id: 'zeus_browser',
      label: 'Zeus Browser',
      available: browserEnabled,
      exactLocation: false,
      ...(!browserEnabled ? { reason: 'built_in_browser_disabled' } : {}),
    });
  }
  if (sourcePreviewable) {
    for (const editor of editorTargets) {
      const available = await editorAvailable(editor, services);
      targets.push({
        id: editor.id,
        label: editor.label,
        available,
        exactLocation: available,
        ...(!available ? { reason: 'application_not_installed' } : {}),
      });
    }
  }
  targets.push({ id: 'system_default', label: 'System default', available: true, exactLocation: false });
  targets.push({ id: 'file_manager', label: 'Show in Finder', available: true, exactLocation: false });
  targets.push({ id: 'copy_path', label: 'Copy path', available: true, exactLocation: false });
  return { resourceId: intent.id, targets };
}

export async function openConversationResource(request: OpenConversationResourceRequest, services: ConversationResourceOpenServices): Promise<OpenConversationResourceResult> {
  const intent = await loadConversationResourceIntent(request, services);
  return openResourceIntent(intent, request, services);
}

export async function openTurnChangeFile(request: OpenTurnChangeFileRequest, services: ConversationResourceOpenServices): Promise<OpenConversationResourceResult> {
  const intent = await loadTurnChangeFileIntent(request, services);
  return openResourceIntent(intent, request, services);
}

async function openResourceIntent(
  intent: ConversationResourceOpenIntent,
  request: { target: ConversationOpenTarget; location?: ConversationFileLocation },
  services: ConversationResourceOpenServices,
): Promise<OpenConversationResourceResult> {
  const available = await listOpenTargetsForIntent(intent, services);
  const preferredTarget = request.target === 'preferred' ? preferredOpenTarget(intent, services.getSettings()) : request.target;
  const preferredAvailable = available.targets.some((candidate) => candidate.id === preferredTarget && candidate.available);
  const target = request.target === 'preferred' && !preferredAvailable ? fallbackOpenTarget(intent, available.targets) : preferredAvailable ? preferredTarget : null;
  if (!target) {
    throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_TARGET_UNAVAILABLE', 'The selected open target is unavailable for this resource.');
  }

  if (intent.kind === 'website') {
    const url = authorizedWebsiteUrl(intent);
    if (target === 'zeus_browser') {
      await services.openBrowser({ conversationId: intent.conversationId, url: url.href });
      return { opened: true, resourceId: intent.id, target, mode: 'zeus_browser' };
    }
    if (target === 'system_default') {
      await services.openExternal(url.href);
      return { opened: true, resourceId: intent.id, target, mode: 'external' };
    }
    if (target === 'copy_link') {
      services.writeClipboardText(url.href);
      return { opened: true, resourceId: intent.id, target, mode: 'clipboard' };
    }
  }

  const file = await authorizedFile(intent);
  if (target === 'zeus_source') {
    return { opened: true, resourceId: intent.id, target, mode: 'zeus_source' };
  }
  if (target === 'zeus_browser') {
    await services.openBrowser({ conversationId: intent.conversationId, url: pathToFileURL(file.absolutePath).href });
    return { opened: true, resourceId: intent.id, target, mode: 'zeus_browser' };
  }
  if (target === 'system_default') {
    const error = await services.openPath(file.absolutePath);
    if (error) throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_SYSTEM_OPEN_FAILED', error);
    return { opened: true, resourceId: intent.id, target, mode: 'file' };
  }
  if (target === 'file_manager') {
    services.showItemInFolder(file.absolutePath);
    return { opened: true, resourceId: intent.id, target, mode: 'file' };
  }
  if (target === 'copy_path') {
    services.writeClipboardText(file.absolutePath);
    return { opened: true, resourceId: intent.id, target, mode: 'clipboard' };
  }
  if (target.startsWith('editor:')) {
    const editor = editorTargets.find((candidate) => candidate.id === target);
    if (!editor || !(await editorAvailable(editor, services))) {
      throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_TARGET_UNAVAILABLE', 'The selected editor is not installed.');
    }
    const location = normalizeLocation(request.location) ?? normalizeLocation(intent.target.location);
    await validateLocation(file.absolutePath, location?.line);
    const targetPath = location?.line ? `${file.absolutePath}:${location.line}${location.column ? `:${location.column}` : ''}` : file.absolutePath;
    await services.executeFile('/usr/bin/open', ['-a', editor.appName, '--args', '--goto', targetPath]);
    return { opened: true, resourceId: intent.id, target, mode: 'file' };
  }
  throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_TARGET_UNAVAILABLE', 'The selected open target is unavailable for this resource.');
}

function preferredOpenTarget(intent: ConversationResourceOpenIntent, settings: ZeusBrowserSettings): ConversationOpenTarget {
  if (intent.kind === 'website') {
    const url = authorizedWebsiteUrl(intent);
    if (url.protocol === 'mailto:') return 'system_default';
    return intent.display.local === true ? settings.localWebOpenTarget : settings.webLinkOpenTarget;
  }
  const absolutePath = typeof intent.target.absolutePath === 'string' ? intent.target.absolutePath : '';
  if (['.htm', '.html'].includes(extname(absolutePath).toLocaleLowerCase())) return settings.localWebOpenTarget;
  if (isImagePreviewable(absolutePath)) return 'zeus_source';
  return settings.fileOpenTarget;
}

function fallbackOpenTarget(intent: ConversationResourceOpenIntent, targets: ConversationResourceOpenTarget[]): ConversationOpenTarget | null {
  const fallbackOrder: ConversationOpenTarget[] = intent.kind === 'website' ? ['zeus_browser', 'system_default', 'copy_link'] : ['zeus_source', 'system_default', 'file_manager', 'copy_path'];
  return fallbackOrder.find((id) => targets.some((target) => target.id === id && target.available)) ?? null;
}

async function loadConversationResourceIntent(request: ConversationResourceRequest, services: ConversationResourceOpenServices): Promise<ConversationResourceOpenIntent> {
  const projectId = requireIdentifier(request.projectId, 'projectId');
  const conversationId = requireIdentifier(request.conversationId, 'conversationId');
  const resourceId = requireIdentifier(request.resourceId, 'resourceId');
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/resources/${encodeURIComponent(resourceId)}/open-intent`, services.config.baseUrl);
  const raw = await services.fetchJson(url.href, { headers: { authorization: `Bearer ${services.config.apiToken}` } });
  const intent = asRecord(raw);
  if (
    intent.id !== resourceId ||
    intent.projectId !== projectId ||
    intent.conversationId !== conversationId ||
    (intent.kind !== 'file' && intent.kind !== 'website' && intent.kind !== 'attachment') ||
    (intent.presentation !== 'inline' && intent.presentation !== 'card')
  ) {
    throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_AUTHORITY_INVALID', 'The local resource authority response is invalid.');
  }
  return {
    id: resourceId,
    projectId,
    conversationId,
    turnId: requireIdentifier(intent.turnId, 'turnId'),
    itemId: requireIdentifier(intent.itemId, 'itemId'),
    kind: intent.kind,
    presentation: intent.presentation,
    display: asRecord(intent.display),
    target: asRecord(intent.target),
    authority: asRecord(intent.authority),
  };
}

async function loadTurnChangeFileIntent(request: TurnChangeFileRequest, services: ConversationResourceOpenServices): Promise<ConversationResourceOpenIntent> {
  const projectId = requireIdentifier(request.projectId, 'projectId');
  const conversationId = requireIdentifier(request.conversationId, 'conversationId');
  const turnId = requireIdentifier(request.turnId, 'turnId');
  const changeSetId = requireIdentifier(request.changeSetId, 'changeSetId');
  const fileId = requireIdentifier(request.fileId, 'fileId');
  const url = new URL(
    `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/change-set/${encodeURIComponent(changeSetId)}/files/${encodeURIComponent(fileId)}/open-intent`,
    services.config.baseUrl,
  );
  const raw = await services.fetchJson(url.href, { headers: { authorization: `Bearer ${services.config.apiToken}` } });
  const intent = asRecord(raw);
  const expectedResourceId = `turn_change_file_open_${fileId}`;
  if (intent.id !== expectedResourceId || intent.projectId !== projectId || intent.conversationId !== conversationId || intent.kind !== 'file' || intent.presentation !== 'inline') {
    throw resourceOpenError('ZEUS_TURN_CHANGE_FILE_AUTHORITY_INVALID', 'The local changed-file authority response is invalid.');
  }
  return {
    id: expectedResourceId,
    projectId,
    conversationId,
    turnId: requireIdentifier(intent.turnId, 'turnId'),
    itemId: requireIdentifier(intent.itemId, 'itemId'),
    kind: 'file',
    presentation: 'inline',
    display: asRecord(intent.display),
    target: asRecord(intent.target),
    authority: asRecord(intent.authority),
  };
}

function authorizedWebsiteUrl(intent: ConversationResourceOpenIntent): URL {
  if (intent.kind !== 'website' || typeof intent.target.url !== 'string' || intent.target.url.length > 8_192) {
    throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_URL_INVALID', 'Conversation website resource URL is invalid.');
  }
  const url = new URL(intent.target.url);
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) {
    throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_URL_FORBIDDEN', 'Conversation website resource URL is not allowed.');
  }
  return url;
}

async function authorizedFile(intent: ConversationResourceOpenIntent): Promise<{ absolutePath: string; allowedRoot: string }> {
  if (intent.kind === 'website' || typeof intent.target.absolutePath !== 'string' || typeof intent.authority.allowedRoot !== 'string') {
    throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_PATH_INVALID', 'Conversation file resource path authority is invalid.');
  }
  const absolutePath = resolve(intent.target.absolutePath);
  const allowedRoot = resolve(intent.authority.allowedRoot);
  if (!isAbsolute(intent.target.absolutePath) || !isAbsolute(intent.authority.allowedRoot) || absolutePath === allowedRoot || !isInsideRoot(absolutePath, allowedRoot)) {
    throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_PATH_FORBIDDEN', 'Conversation file resource is outside its authorized root.');
  }
  const [rootRealPath, fileRealPath] = await Promise.all([realPath(allowedRoot), realPath(absolutePath)]);
  if (!rootRealPath || !fileRealPath || !isInsideRoot(fileRealPath, rootRealPath)) {
    throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_PATH_FORBIDDEN', 'Conversation file resource resolves outside its authorized root.');
  }
  return { absolutePath: fileRealPath, allowedRoot: rootRealPath };
}

async function realPath(path: string): Promise<string | null> {
  try {
    const { realpath, stat } = await import('node:fs/promises');
    const resolved = await realpath(path);
    const pathStat = await stat(resolved);
    return pathStat.isFile() || pathStat.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function editorAvailable(editor: EditorTargetDescriptor, services: ConversationResourceOpenServices): Promise<boolean> {
  const paths = [...editor.appPaths, ...editor.appPaths.map((path) => resolve(services.applicationHome, 'Applications', basename(path)))];
  const results = await Promise.all(paths.map((path) => services.pathExists(path)));
  return results.some(Boolean);
}

async function validateLocation(path: string, line: number | undefined): Promise<void> {
  if (!line) return;
  const bytes = await readFile(path);
  if (bytes.includes(0)) {
    throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_LOCATION_INVALID', 'A source line cannot be opened in a binary file.');
  }
  const lineCount = sourceLineCount(bytes.toString('utf8'));
  if (line > lineCount) {
    throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_LOCATION_INVALID', `Requested source line ${line} exceeds the file length ${lineCount}.`);
  }
}

function sourceLineCount(content: string): number {
  const normalized = content.replace(/\r\n?/gu, '\n');
  if (normalized === '') return 1;
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n').length;
}

function normalizeLocation(value: unknown): { line?: number; column?: number; endLine?: number } | null {
  const record = asRecord(value);
  const line = positiveInteger(record.line);
  const column = positiveInteger(record.column);
  const endLine = positiveInteger(record.endLine);
  if (!line && !column && !endLine) return null;
  return {
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
    ...(endLine ? { endLine } : {}),
  };
}

function isSourcePreviewable(path: string): boolean {
  return ['.c', '.cc', '.cpp', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json', '.jsx', '.kt', '.md', '.php', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.swift', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'].includes(
    extname(path).toLocaleLowerCase(),
  );
}

function isImagePreviewable(path: string): boolean {
  return ['.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.webp'].includes(extname(path).toLocaleLowerCase());
}

function isInsideRoot(candidate: string, root: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')) {
    throw resourceOpenError('ZEUS_CONVERSATION_RESOURCE_REQUEST_INVALID', `${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function resourceOpenError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
