import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PluginComponentSnapshot } from '@zeus/storage';

const maximumPluginNodes = 10_000;
const maximumPluginBytes = 256 * 1024 * 1024;
const maximumJsonBytes = 2 * 1024 * 1024;
const supportedHookEvents = ['PermissionRequest', 'PostToolUse', 'PostCompact', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit', 'Stop'] as const;
const supportedManifestFields = new Set(['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'skills', 'mcpServers', 'apps', 'hooks', 'interface']);

export interface ZeusPluginManifestInspection {
  name: string;
  displayName: string;
  description: string;
  version: string;
  manifest: Record<string, unknown>;
  components: PluginComponentSnapshot;
  contentSha256: string;
  totalBytes: number;
  totalNodes: number;
}

export class ZeusPluginManifestError extends Error {
  readonly name = 'ZeusPluginManifestError';

  constructor(
    readonly code: 'ZEUS_PLUGIN_MANIFEST_MISSING' | 'ZEUS_PLUGIN_MANIFEST_INVALID' | 'ZEUS_PLUGIN_COMPONENT_UNSUPPORTED' | 'ZEUS_PLUGIN_UNSAFE_PATH' | 'ZEUS_PLUGIN_TOO_LARGE',
    message: string,
  ) {
    super(message);
  }
}

export async function inspectZeusPluginDirectory(pluginRootInput: string): Promise<ZeusPluginManifestInspection> {
  const pluginRoot = await requireSafeDirectory(pluginRootInput);
  const inventory = await inventoryPlugin(pluginRoot);
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = await readJsonRecord(manifestPath, 'Plugin Manifest').catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_MISSING', 'Plugin 缺少 .codex-plugin/plugin.json。');
    throw error;
  });
  const name = requiredKebabName(manifest.name, 'Plugin name');
  const version = optionalText(manifest.version, 120) ?? 'local';
  const description = optionalText(manifest.description, 4_000) ?? '';
  if (manifest.interface !== undefined && !isRecord(manifest.interface)) {
    throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', 'Manifest interface 必须是对象。');
  }
  const interfaceMetadata = isRecord(manifest.interface) ? manifest.interface : {};
  const displayName = optionalText(interfaceMetadata.displayName, 160) ?? name;

  rejectUnpublishedCapabilities(manifest);
  const skills = await inspectSkills(pluginRoot, manifest.skills);
  const hooks = await inspectHooks(pluginRoot, manifest.hooks);
  const mcpServers = await inspectMcpServers(pluginRoot, manifest.mcpServers);
  const apps = await inspectApps(pluginRoot, manifest.apps);
  const assets = await inspectAssets(pluginRoot, interfaceMetadata);
  if (skills.length === 0 && hooks.length === 0 && mcpServers.length === 0 && apps.length === 0) {
    throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', 'Plugin 未声明任何可运行组件。');
  }

  return {
    name,
    displayName,
    description,
    version,
    manifest,
    components: { skills, hooks, mcpServers, apps, assets, hasMcpAppUi: false },
    contentSha256: inventory.contentSha256,
    totalBytes: inventory.totalBytes,
    totalNodes: inventory.totalNodes,
  };
}

async function inventoryPlugin(pluginRoot: string): Promise<{ contentSha256: string; totalBytes: number; totalNodes: number }> {
  const entries: Array<{ path: string; mode: number; bytes: Buffer }> = [];
  let totalBytes = 0;
  let totalNodes = 0;
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      totalNodes += 1;
      if (totalNodes > maximumPluginNodes) throw new ZeusPluginManifestError('ZEUS_PLUGIN_TOO_LARGE', `Plugin 文件节点超过 ${maximumPluginNodes} 个。`);
      const absolutePath = join(directory, child.name);
      const childStat = await lstat(absolutePath);
      if (childStat.isSymbolicLink()) throw new ZeusPluginManifestError('ZEUS_PLUGIN_UNSAFE_PATH', `Plugin 不允许符号链接：${relative(pluginRoot, absolutePath)}`);
      if (childStat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!childStat.isFile()) throw new ZeusPluginManifestError('ZEUS_PLUGIN_UNSAFE_PATH', `Plugin 包含不支持的文件类型：${relative(pluginRoot, absolutePath)}`);
      totalBytes += childStat.size;
      if (totalBytes > maximumPluginBytes) throw new ZeusPluginManifestError('ZEUS_PLUGIN_TOO_LARGE', `Plugin 体积超过 ${maximumPluginBytes / 1024 / 1024} MiB。`);
      const bytes = await readFile(absolutePath);
      entries.push({ path: normalizedRelative(pluginRoot, absolutePath), mode: childStat.mode & 0o777, bytes });
    }
  }
  await visit(pluginRoot);
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(String(entry.mode));
    hash.update('\0');
    hash.update(entry.bytes);
    hash.update('\0');
  }
  return { contentSha256: hash.digest('hex'), totalBytes, totalNodes };
}

async function inspectSkills(pluginRoot: string, manifestValue: unknown): Promise<PluginComponentSnapshot['skills']> {
  if (manifestValue === undefined) return [];
  const skillsDirectory = await resolveManifestPath(pluginRoot, manifestValue, 'skills', true);
  const entries = await readdir(skillsDirectory, { withFileTypes: true });
  const skills: PluginComponentSnapshot['skills'] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const skillRoot = join(skillsDirectory, entry.name);
    const skillFile = join(skillRoot, 'SKILL.md');
    let content: string;
    try {
      content = await readFile(skillFile, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) continue;
      throw error;
    }
    const frontmatter = parseFrontmatter(content);
    const skillName = requiredKebabName(frontmatter.name ?? entry.name, `Skill ${entry.name} name`);
    const description = optionalText(frontmatter.description, 4_000);
    if (!description) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `Skill ${skillName} 缺少 description。`);
    skills.push({ id: skillName, name: skillName, description, path: normalizedRelative(pluginRoot, skillRoot) });
  }
  if (skills.length === 0) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', 'Manifest 的 skills 路径内没有有效 SKILL.md。');
  return uniqueById(skills, 'Skill');
}

async function inspectHooks(pluginRoot: string, manifestValue: unknown): Promise<PluginComponentSnapshot['hooks']> {
  const defaultPath = join(pluginRoot, 'hooks', 'hooks.json');
  const sources: unknown[] = [];
  if (manifestValue === undefined) {
    if (await pathExists(defaultPath)) sources.push(await readJsonRecord(defaultPath, 'Hook 配置'));
  } else {
    for (const entry of Array.isArray(manifestValue) ? manifestValue : [manifestValue]) {
      if (typeof entry === 'string') {
        const hookPath = await resolveManifestPath(pluginRoot, entry, 'hooks', false);
        sources.push(await readJsonRecord(hookPath, 'Hook 配置'));
      } else if (isRecord(entry)) {
        sources.push(entry);
      } else {
        throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', 'Manifest hooks 必须是 ./ 路径、内联对象或它们的数组。');
      }
    }
  }

  const hooks: PluginComponentSnapshot['hooks'] = [];
  for (const source of sources) {
    if (!isRecord(source) || !isRecord(source.hooks)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', 'Hook 配置缺少 hooks 对象。');
    for (const [event, groupsValue] of Object.entries(source.hooks)) {
      if (!supportedHookEvents.includes(event as (typeof supportedHookEvents)[number])) {
        throw new ZeusPluginManifestError('ZEUS_PLUGIN_COMPONENT_UNSUPPORTED', `不支持的 Hook 事件：${event}`);
      }
      if (!Array.isArray(groupsValue)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `Hook 事件 ${event} 必须是数组。`);
      for (const [groupIndex, groupValue] of groupsValue.entries()) {
        if (!isRecord(groupValue) || !Array.isArray(groupValue.hooks)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `Hook ${event}[${groupIndex}] 缺少 handlers。`);
        const matcher = groupValue.matcher === undefined ? null : requiredText(groupValue.matcher, `Hook ${event} matcher`, 2_000);
        if (matcher && matcher !== '*') {
          try {
            new RegExp(matcher);
          } catch {
            throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `Hook ${event} matcher 不是有效正则表达式。`);
          }
        }
        for (const [handlerIndex, handlerValue] of groupValue.hooks.entries()) {
          if (!isRecord(handlerValue)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `Hook ${event} handler 必须是对象。`);
          const type = requiredText(handlerValue.type, `Hook ${event} type`, 80);
          if (type === 'command') validateCommandHook(handlerValue, event);
          else if (type === 'mcp_tool') validateMcpHook(handlerValue, event);
          else if (type !== 'prompt' && type !== 'agent') {
            throw new ZeusPluginManifestError('ZEUS_PLUGIN_COMPONENT_UNSUPPORTED', `不支持的 Hook handler 类型：${type}`);
          }
          const definition = { event, matcher, handler: handlerValue };
          const definitionSha256 = sha256(canonicalJson(definition));
          hooks.push({ id: `${event}:${groupIndex}:${handlerIndex}`, event, matcher, definitionSha256, definition });
        }
      }
    }
  }
  return uniqueById(hooks, 'Hook');
}

function validateCommandHook(handler: Record<string, unknown>, event: string): void {
  requiredText(handler.command, `Hook ${event} command`, 16_000);
  validateTimeout(handler.timeout, event);
  if (handler.async !== undefined && typeof handler.async !== 'boolean') throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `Hook ${event} async 必须是布尔值。`);
  if (event === 'SessionEnd' && handler.async === true) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', 'SessionEnd Hook 不支持异步执行。');
}

function validateMcpHook(handler: Record<string, unknown>, event: string): void {
  if (event === 'SessionEnd') throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', 'SessionEnd Hook 不支持 mcp_tool。');
  requiredKebabName(handler.server, `Hook ${event} server`);
  requiredText(handler.tool, `Hook ${event} tool`, 512);
  if (handler.input !== undefined && !isRecord(handler.input)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `Hook ${event} input 必须是对象。`);
  validateTimeout(handler.timeout, event);
}

function validateTimeout(value: unknown, event: string): void {
  if (value === undefined) return;
  const maximum = event === 'SessionEnd' ? 3 : 600;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `Hook ${event} timeout 必须在 0 到 ${maximum} 秒之间。`);
  }
}

async function inspectMcpServers(pluginRoot: string, manifestValue: unknown): Promise<PluginComponentSnapshot['mcpServers']> {
  if (manifestValue === undefined) return [];
  const mcpPath = await resolveManifestPath(pluginRoot, manifestValue, 'mcpServers', false);
  const document = await readJsonRecord(mcpPath, 'MCP 配置');
  const serversValue = isRecord(document.mcpServers) ? document.mcpServers : isRecord(document.mcp_servers) ? document.mcp_servers : document;
  const servers: PluginComponentSnapshot['mcpServers'] = [];
  for (const [name, rawConfig] of Object.entries(serversValue)) {
    const id = requiredKebabName(name, 'MCP server name');
    if (!isRecord(rawConfig)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `MCP Server ${name} 配置必须是对象。`);
    const config = structuredClone(rawConfig);
    const command = optionalText(config.command, 4_000);
    const url = optionalText(config.url, 8_000);
    if ((command ? 1 : 0) + (url ? 1 : 0) !== 1) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `MCP Server ${name} 必须且只能声明 command 或 url。`);
    if (command) {
      if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((entry) => typeof entry !== 'string'))) {
        throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `MCP Server ${name} args 必须是字符串数组。`);
      }
      if (config.env !== undefined && (!isRecord(config.env) || Object.values(config.env).some((entry) => typeof entry !== 'string'))) {
        throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `MCP Server ${name} env 必须是字符串映射。`);
      }
      servers.push({ id, name, transport: 'stdio', config });
      continue;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url!);
    } catch {
      throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `MCP Server ${name} url 无效。`);
    }
    if (parsedUrl.protocol !== 'https:' && !isLoopbackHttp(parsedUrl)) {
      throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `MCP Server ${name} 必须使用 HTTPS；仅本机地址允许 HTTP。`);
    }
    if (parsedUrl.username || parsedUrl.password) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `MCP Server ${name} URL 不能内嵌凭据。`);
    if (config.headers !== undefined && (!isRecord(config.headers) || Object.values(config.headers).some((entry) => typeof entry !== 'string'))) {
      throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `MCP Server ${name} headers 必须是字符串映射。`);
    }
    servers.push({ id, name, transport: 'http', config });
  }
  if (servers.length === 0) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', 'MCP 配置没有 Server。');
  return uniqueById(servers, 'MCP Server');
}

async function inspectApps(pluginRoot: string, manifestValue: unknown): Promise<PluginComponentSnapshot['apps']> {
  if (manifestValue === undefined) return [];
  const appPath = await resolveManifestPath(pluginRoot, manifestValue, 'apps', false);
  const document = await readJsonRecord(appPath, 'App 配置');
  const mappings = isRecord(document.apps) ? document.apps : document;
  const apps: PluginComponentSnapshot['apps'] = [];
  for (const [name, value] of Object.entries(mappings)) {
    const technicalId = typeof value === 'string' ? value : isRecord(value) ? optionalText(value.id ?? value.appId ?? value.app_id, 512) : null;
    if (!technicalId?.startsWith('plugin_asdk_app')) {
      throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `App ${name} 缺少 plugin_asdk_app 技术 ID。`);
    }
    const appName = requiredKebabName(name, 'App name');
    apps.push({ id: appName, technicalId, name: appName });
  }
  if (apps.length === 0) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', 'App 配置没有注册连接映射。');
  return uniqueById(apps, 'App');
}

async function inspectAssets(pluginRoot: string, interfaceMetadata: Record<string, unknown>): Promise<PluginComponentSnapshot['assets']> {
  const candidates: Array<{ kind: string; value: unknown }> = [
    { kind: 'composerIcon', value: interfaceMetadata.composerIcon },
    { kind: 'logo', value: interfaceMetadata.logo },
    ...(Array.isArray(interfaceMetadata.screenshots) ? interfaceMetadata.screenshots : []).map((value) => ({ kind: 'screenshot', value })),
  ];
  const assets: PluginComponentSnapshot['assets'] = [];
  for (const candidate of candidates) {
    if (candidate.value === undefined) continue;
    const assetPath = await resolveManifestPath(pluginRoot, candidate.value, `interface.${candidate.kind}`, false);
    const extension = extname(assetPath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(extension)) {
      throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `展示资产 ${candidate.kind} 的格式不受支持。`);
    }
    assets.push({ kind: candidate.kind, path: normalizedRelative(pluginRoot, assetPath) });
  }
  return assets;
}

async function resolveManifestPath(pluginRoot: string, value: unknown, label: string, directory: boolean): Promise<string> {
  const raw = requiredText(value, `Manifest ${label}`, 4_000);
  if (!raw.startsWith('./') || isAbsolute(raw)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_UNSAFE_PATH', `Manifest ${label} 必须是以 ./ 开头的相对路径。`);
  const resolved = resolve(pluginRoot, raw);
  if (!isInside(resolved, pluginRoot)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_UNSAFE_PATH', `Manifest ${label} 不能离开 Plugin 根目录。`);
  const resolvedRealpath = await realpath(resolved).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `Manifest ${label} 指向的路径不存在。`);
    throw error;
  });
  if (!isInside(resolvedRealpath, pluginRoot)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_UNSAFE_PATH', `Manifest ${label} 解析后离开 Plugin 根目录。`);
  const resolvedStat = await stat(resolvedRealpath);
  if (directory ? !resolvedStat.isDirectory() : !resolvedStat.isFile()) {
    throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `Manifest ${label} 指向的路径类型不正确。`);
  }
  return resolvedRealpath;
}

async function requireSafeDirectory(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_UNSAFE_PATH', 'Plugin 根目录必须是绝对路径。');
  const rootStat = await lstat(input);
  if (rootStat.isSymbolicLink()) throw new ZeusPluginManifestError('ZEUS_PLUGIN_UNSAFE_PATH', 'Plugin 根目录不能是符号链接。');
  if (!rootStat.isDirectory()) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', 'Plugin 根路径必须是目录。');
  return realpath(input);
}

async function readJsonRecord(path: string, label: string): Promise<Record<string, unknown>> {
  const fileStat = await stat(path);
  if (fileStat.size > maximumJsonBytes) throw new ZeusPluginManifestError('ZEUS_PLUGIN_TOO_LARGE', `${label} 超过 ${maximumJsonBytes / 1024 / 1024} MiB。`);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed)) throw new Error('not-object');
    return parsed;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) throw error;
    throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `${label} 不是有效 JSON 对象：${basename(path)}`);
  }
}

function rejectUnpublishedCapabilities(manifest: Record<string, unknown>): void {
  const unsupported = ['browserExtensions', 'browserExtension', 'scheduledTasks', 'scheduledTaskTemplates', 'x-zeus'].filter((key) => manifest[key] !== undefined);
  if (unsupported.length > 0) {
    throw new ZeusPluginManifestError('ZEUS_PLUGIN_COMPONENT_UNSUPPORTED', `Manifest 包含 Zeus 尚不导入的能力：${unsupported.join(', ')}`);
  }
  const unknown = Object.keys(manifest).filter((key) => !supportedManifestFields.has(key));
  if (unknown.length > 0) {
    throw new ZeusPluginManifestError('ZEUS_PLUGIN_COMPONENT_UNSUPPORTED', `Manifest 包含当前公开规范之外的字段：${unknown.join(', ')}`);
  }
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return {};
  const normalized = content.replaceAll('\r\n', '\n');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (!key || !raw) continue;
    result[key] = stripYamlString(raw);
  }
  return result;
}

function stripYamlString(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1).trim();
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedRelative(root: string, target: string): string {
  return `./${relative(root, target).split(sep).join('/')}`;
}

function isInside(target: string, root: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

function requiredKebabName(value: unknown, label: string): string {
  const text = requiredText(value, label, 120);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(text)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `${label} 必须使用 kebab-case。`);
  return text;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || value.includes('\0')) {
    throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `${label} 无效。`);
  }
  return value.trim();
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, '可选文本', maximum);
}

function uniqueById<T extends { id: string }>(items: T[], label: string): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new ZeusPluginManifestError('ZEUS_PLUGIN_MANIFEST_INVALID', `${label} 名称重复：${item.id}`);
    seen.add(item.id);
  }
  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}
