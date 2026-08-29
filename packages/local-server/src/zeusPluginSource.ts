import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ZeusPluginDirectSource = { kind: 'local'; path: string } | { kind: 'git'; repositoryUrl: string; ref?: string; subdirectory?: string };

export interface ZeusMarketplaceEntry {
  name: string;
  source: { kind: 'local'; path: string } | { kind: 'git'; repositoryUrl: string; ref?: string; subdirectory?: string };
  category: string;
  policy: { installation: string; authentication: string };
  interface: Record<string, unknown>;
}

export interface ZeusMarketplaceDocument {
  name: string;
  displayName: string;
  root: string;
  path: string;
  entries: ZeusMarketplaceEntry[];
}

export class ZeusPluginSourceError extends Error {
  readonly name = 'ZeusPluginSourceError';

  constructor(
    readonly code: 'ZEUS_PLUGIN_INPUT_INVALID' | 'ZEUS_PLUGIN_SOURCE_UNAVAILABLE' | 'ZEUS_PLUGIN_UNSAFE_SOURCE' | 'ZEUS_PLUGIN_MARKETPLACE_INVALID',
    message: string,
    readonly statusCode: 400 | 404 | 422 = 400,
  ) {
    super(message);
  }
}

export async function materializePluginSource(source: ZeusPluginDirectSource, stagingRoot: string): Promise<string> {
  if (!source || typeof source !== 'object') throw new ZeusPluginSourceError('ZEUS_PLUGIN_INPUT_INVALID', 'Plugin 安装来源无效。');
  if (source.kind === 'local') return requireLocalDirectory(source.path, '本地 Plugin 路径');
  if (source.kind !== 'git') throw new ZeusPluginSourceError('ZEUS_PLUGIN_INPUT_INVALID', '仅支持本地目录或 Git Plugin 来源。');
  const repositoryUrl = boundedText(source.repositoryUrl, 'Git 仓库地址', 8_000);
  const requestedRef = optionalText(source.ref, 'Git ref', 512);
  const subdirectory = optionalRelativePath(source.subdirectory, 'Git 子目录');
  const cloneRoot = join(stagingRoot, 'repository');
  const cloneArgs = ['clone', '--depth', '1', '--filter=blob:none', '--no-tags', '--', repositoryUrl, cloneRoot];
  try {
    await runGit(cloneArgs, stagingRoot);
    if (requestedRef) {
      await runGit(['-C', cloneRoot, 'fetch', '--depth', '1', '--no-tags', 'origin', requestedRef], stagingRoot);
      await runGit(['-C', cloneRoot, 'checkout', '--detach', 'FETCH_HEAD'], stagingRoot);
    }
  } catch (error) {
    const detail = commandDiagnostic(error);
    throw new ZeusPluginSourceError('ZEUS_PLUGIN_SOURCE_UNAVAILABLE', detail ? `Git 来源读取失败：${detail}` : 'Git 来源读取失败，请检查地址、ref 与访问权限。', 404);
  }
  await rm(join(cloneRoot, '.git'), { recursive: true, force: true });
  const sourceRoot = subdirectory ? resolve(cloneRoot, subdirectory) : cloneRoot;
  if (!isInside(sourceRoot, cloneRoot)) throw new ZeusPluginSourceError('ZEUS_PLUGIN_UNSAFE_SOURCE', 'Git 子目录不能离开仓库根目录。', 422);
  await requireDirectoryWithoutRootSymlink(sourceRoot, 'Git Plugin 子目录');
  return sourceRoot;
}

export async function discoverMarketplace(snapshotRootInput: string, configuredSubdirectory?: string): Promise<ZeusMarketplaceDocument> {
  const snapshotRoot = await requireDirectoryWithoutRootSymlink(snapshotRootInput, 'Marketplace 根目录');
  const configured = optionalRelativePath(configuredSubdirectory, 'Marketplace 子目录');
  const candidateRoot = configured ? resolve(snapshotRoot, configured) : snapshotRoot;
  if (!isInside(candidateRoot, snapshotRoot)) throw new ZeusPluginSourceError('ZEUS_PLUGIN_UNSAFE_SOURCE', 'Marketplace 子目录不能离开来源根目录。', 422);
  const candidateStat = await stat(candidateRoot).catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) throw new ZeusPluginSourceError('ZEUS_PLUGIN_SOURCE_UNAVAILABLE', 'Marketplace 子目录不存在。', 404);
    throw error;
  });
  const candidates = candidateStat.isFile() ? [candidateRoot] : [join(candidateRoot, '.agents', 'plugins', 'marketplace.json'), join(candidateRoot, 'marketplace.json'), join(candidateRoot, '.claude-plugin', 'marketplace.json')];
  let marketplacePath: string | null = null;
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      marketplacePath = candidate;
      break;
    }
  }
  if (!marketplacePath) throw new ZeusPluginSourceError('ZEUS_PLUGIN_MARKETPLACE_INVALID', '来源中没有找到 marketplace.json。', 422);
  const document = await readMarketplaceJson(marketplacePath);
  const name = requiredKebabName(document.name, 'Marketplace name');
  const interfaceMetadata = isRecord(document.interface) ? document.interface : {};
  const displayName = optionalText(interfaceMetadata.displayName, 'Marketplace displayName', 160) ?? name;
  if (!Array.isArray(document.plugins)) throw new ZeusPluginSourceError('ZEUS_PLUGIN_MARKETPLACE_INVALID', 'Marketplace plugins 必须是数组。', 422);
  const marketplaceRoot = marketplaceRelativeRoot(marketplacePath, snapshotRoot);
  const entries = document.plugins.map((value, index) => parseMarketplaceEntry(value, index, marketplaceRoot));
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new ZeusPluginSourceError('ZEUS_PLUGIN_MARKETPLACE_INVALID', `Marketplace Plugin 名称重复：${entry.name}`, 422);
    names.add(entry.name);
  }
  return { name, displayName, root: marketplaceRoot, path: marketplacePath, entries };
}

export async function inspectSafeSourceTree(rootInput: string, limits: { maximumNodes: number; maximumBytes: number }): Promise<{ contentSha256: string; totalNodes: number; totalBytes: number }> {
  const root = await requireDirectoryWithoutRootSymlink(rootInput, '来源根目录');
  const hash = createHash('sha256');
  let totalNodes = 0;
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      totalNodes += 1;
      if (totalNodes > limits.maximumNodes) throw new ZeusPluginSourceError('ZEUS_PLUGIN_UNSAFE_SOURCE', `来源节点超过 ${limits.maximumNodes} 个。`, 422);
      const absolutePath = join(directory, child.name);
      const childStat = await lstat(absolutePath);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (childStat.isSymbolicLink()) throw new ZeusPluginSourceError('ZEUS_PLUGIN_UNSAFE_SOURCE', `来源不允许符号链接：${relativePath}`, 422);
      if (childStat.isDirectory()) {
        hash.update(`d:${relativePath}\0`);
        await visit(absolutePath);
        continue;
      }
      if (!childStat.isFile()) throw new ZeusPluginSourceError('ZEUS_PLUGIN_UNSAFE_SOURCE', `来源包含不支持的文件类型：${relativePath}`, 422);
      totalBytes += childStat.size;
      if (totalBytes > limits.maximumBytes) throw new ZeusPluginSourceError('ZEUS_PLUGIN_UNSAFE_SOURCE', `来源体积超过 ${Math.floor(limits.maximumBytes / 1024 / 1024)} MiB。`, 422);
      hash.update(`f:${relativePath}:${childStat.mode & 0o777}\0`);
      hash.update(await readFile(absolutePath));
      hash.update('\0');
    }
  }
  await visit(root);
  return { contentSha256: hash.digest('hex'), totalNodes, totalBytes };
}

function parseMarketplaceEntry(value: unknown, index: number, marketplaceRoot: string): ZeusMarketplaceEntry {
  if (!isRecord(value)) throw new ZeusPluginSourceError('ZEUS_PLUGIN_MARKETPLACE_INVALID', `Marketplace plugins[${index}] 必须是对象。`, 422);
  const name = requiredKebabName(value.name, `Marketplace plugins[${index}].name`);
  const policyValue = isRecord(value.policy) ? value.policy : null;
  if (!policyValue) throw new ZeusPluginSourceError('ZEUS_PLUGIN_MARKETPLACE_INVALID', `Marketplace Plugin ${name} 缺少 policy。`, 422);
  const policy = {
    installation: boundedText(policyValue.installation, `${name}.policy.installation`, 80),
    authentication: boundedText(policyValue.authentication, `${name}.policy.authentication`, 80),
  };
  const category = boundedText(value.category, `${name}.category`, 160);
  const sourceValue = value.source;
  let source: ZeusMarketplaceEntry['source'];
  if (typeof sourceValue === 'string') {
    source = localMarketplaceSource(sourceValue, marketplaceRoot, name);
  } else if (isRecord(sourceValue)) {
    const kind = boundedText(sourceValue.source, `${name}.source.source`, 80);
    if (kind === 'local') source = localMarketplaceSource(sourceValue.path, marketplaceRoot, name);
    else if (kind === 'url' || kind === 'git-subdir') {
      source = {
        kind: 'git',
        repositoryUrl: boundedText(sourceValue.url, `${name}.source.url`, 8_000),
        ...(optionalText(sourceValue.ref ?? sourceValue.sha, `${name}.source.ref`, 512) ? { ref: optionalText(sourceValue.ref ?? sourceValue.sha, `${name}.source.ref`, 512)! } : {}),
        ...(kind === 'git-subdir' ? { subdirectory: optionalRelativePath(sourceValue.path, `${name}.source.path`) ?? undefined } : {}),
      };
    } else {
      throw new ZeusPluginSourceError('ZEUS_PLUGIN_MARKETPLACE_INVALID', `Marketplace Plugin ${name} 使用了不支持的来源 ${kind}；Zeus 本任务只导入本地与 Git。`, 422);
    }
  } else {
    throw new ZeusPluginSourceError('ZEUS_PLUGIN_MARKETPLACE_INVALID', `Marketplace Plugin ${name} source 无效。`, 422);
  }
  return { name, source, category, policy, interface: isRecord(value.interface) ? value.interface : {} };
}

function localMarketplaceSource(value: unknown, marketplaceRoot: string, name: string): { kind: 'local'; path: string } {
  const relativePath = requiredRelativePath(value, `${name}.source.path`);
  const absolutePath = resolve(marketplaceRoot, relativePath);
  if (!isInside(absolutePath, marketplaceRoot)) throw new ZeusPluginSourceError('ZEUS_PLUGIN_UNSAFE_SOURCE', `Marketplace Plugin ${name} 路径不能离开 Marketplace 根目录。`, 422);
  return { kind: 'local', path: absolutePath };
}

function marketplaceRelativeRoot(marketplacePath: string, snapshotRoot: string): string {
  const normalized = marketplacePath.split(sep).join('/');
  if (normalized.endsWith('/.agents/plugins/marketplace.json') || normalized.endsWith('/.claude-plugin/marketplace.json')) return dirname(dirname(dirname(marketplacePath)));
  return snapshotRoot;
}

async function readMarketplaceJson(path: string): Promise<Record<string, unknown>> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > 2 * 1024 * 1024) throw new Error('size');
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed)) throw new Error('shape');
    return parsed;
  } catch (error) {
    if (error instanceof ZeusPluginSourceError) throw error;
    throw new ZeusPluginSourceError('ZEUS_PLUGIN_MARKETPLACE_INVALID', `Marketplace JSON 无效：${basename(path)}`, 422);
  }
}

async function requireLocalDirectory(value: unknown, label: string): Promise<string> {
  const path = boundedText(value, label, 16_000);
  if (!isAbsolute(path)) throw new ZeusPluginSourceError('ZEUS_PLUGIN_INPUT_INVALID', `${label} 必须是绝对路径。`);
  try {
    return await requireDirectoryWithoutRootSymlink(path, label);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) throw new ZeusPluginSourceError('ZEUS_PLUGIN_SOURCE_UNAVAILABLE', `${label}不存在。`, 404);
    throw error;
  }
}

async function requireDirectoryWithoutRootSymlink(path: string, label: string): Promise<string> {
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink()) throw new ZeusPluginSourceError('ZEUS_PLUGIN_UNSAFE_SOURCE', `${label}不能是符号链接。`, 422);
  if (!pathStat.isDirectory()) throw new ZeusPluginSourceError('ZEUS_PLUGIN_SOURCE_UNAVAILABLE', `${label}必须是目录。`, 404);
  return realpath(path);
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=10' },
  });
}

function commandDiagnostic(error: unknown): string {
  if (!isRecord(error)) return '';
  const stderr = typeof error.stderr === 'string' ? error.stderr : '';
  return stderr.replaceAll(/\s+/gu, ' ').trim().slice(0, 1_000);
}

function requiredRelativePath(value: unknown, label: string): string {
  const path = boundedText(value, label, 4_000);
  if (!path.startsWith('./') || isAbsolute(path)) throw new ZeusPluginSourceError('ZEUS_PLUGIN_MARKETPLACE_INVALID', `${label} 必须以 ./ 开头。`, 422);
  return path;
}

function optionalRelativePath(value: unknown, label: string): string | null {
  const path = optionalText(value, label, 4_000);
  if (!path) return null;
  if (isAbsolute(path) || path.includes('\0')) throw new ZeusPluginSourceError('ZEUS_PLUGIN_INPUT_INVALID', `${label}必须是相对路径。`);
  const normalized = path.startsWith('./') ? path.slice(2) : path;
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.split(/[\\/]/u).includes('..')) {
    throw new ZeusPluginSourceError('ZEUS_PLUGIN_UNSAFE_SOURCE', `${label}不能离开来源根目录。`, 422);
  }
  return normalized;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || value.includes('\0')) throw new ZeusPluginSourceError('ZEUS_PLUGIN_INPUT_INVALID', `${label}无效。`);
  return value.trim();
}

function optionalText(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return boundedText(value, label, maximum);
}

function requiredKebabName(value: unknown, label: string): string {
  const text = boundedText(value, label, 120);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(text)) throw new ZeusPluginSourceError('ZEUS_PLUGIN_MARKETPLACE_INVALID', `${label} 必须使用 kebab-case。`, 422);
  return text;
}

function isInside(target: string, root: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
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
