import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Skill } from '@earendil-works/pi-coding-agent';
import type { LoadExtensionsResult, ResourceLoader } from '@earendil-works/pi-coding-agent/headless';
import type { AgentRunSkillActivation } from './agentRuntimeContracts.js';

interface PiHeadlessResourceLoaderOptions {
  cwd: string;
  agentDir: string;
}

export interface PiApplicationContextResource {
  fingerprint: string;
  manifest: string;
  content: string;
}

interface ContextFile {
  path: string;
  content: string;
}

interface GitPaths {
  repoDir: string;
  commonGitDir: string;
}

/**
 * Zeus 只保留 Pi 会话需要的项目上下文和 Zeus Skill，不加载扩展、主题和终端界面资源。
 */
export class PiHeadlessResourceLoader implements ResourceLoader {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly extensionsResult: LoadExtensionsResult;
  private agentsFiles: ContextFile[] = [];
  private applicationContext: PiApplicationContextResource | null = null;
  private activeSkill: Skill | null = null;

  constructor(options: PiHeadlessResourceLoaderOptions) {
    this.cwd = resolve(options.cwd);
    this.agentDir = resolve(options.agentDir);
    this.extensionsResult = {
      extensions: [],
      errors: [],
      runtime: createEmptyExtensionRuntime(),
    };
  }

  getExtensions(): LoadExtensionsResult {
    return this.extensionsResult;
  }

  getSkills() {
    return { skills: this.activeSkill ? [this.activeSkill] : [], diagnostics: [] };
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles(): { agentsFiles: ContextFile[] } {
    return { agentsFiles: this.agentsFiles };
  }

  getSystemPrompt(): undefined {
    return undefined;
  }

  getSystemPromptSource(): undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
    if (!this.applicationContext) return [];
    return [`Zeus application context manifest (application-owned):\n${this.applicationContext.manifest}`, ...(this.applicationContext.content ? [`Zeus application context (application-owned):\n${this.applicationContext.content}`] : [])];
  }

  getAppendSystemPromptSources(): Array<{ path: string }> {
    if (!this.applicationContext) return [];
    return [{ path: `zeus-context://${this.applicationContext.fingerprint}/manifest` }, ...(this.applicationContext.content ? [{ path: `zeus-context://${this.applicationContext.fingerprint}/application` }] : [])];
  }

  replaceApplicationContext(input: PiApplicationContextResource | null): PiApplicationContextResource | null {
    const previous = this.applicationContext;
    this.applicationContext = input ? { ...input } : null;
    return previous ? { ...previous } : null;
  }

  replaceActiveSkill(input: AgentRunSkillActivation | null): Skill | null {
    const previous = this.activeSkill;
    this.activeSkill = input
      ? {
          name: input.name,
          description: input.description,
          filePath: input.path,
          baseDir: dirname(input.path),
          sourceInfo: {
            path: input.path,
            source: 'zeus',
            scope: 'user',
            origin: 'top-level',
            baseDir: dirname(input.path),
          },
          disableModelInvocation: false,
        }
      : null;
    return previous ? { ...previous, sourceInfo: { ...previous.sourceInfo } } : null;
  }

  extendResources(): void {
    // Zeus 的 Pi 运行内核不接受扩展追加资源。
  }

  async reload(): Promise<void> {
    this.agentsFiles = loadProjectContextFiles(this.cwd, this.agentDir);
  }
}

function createEmptyExtensionRuntime(): LoadExtensionsResult['runtime'] {
  const notInitialized = () => {
    throw new Error('Pi 扩展运行时尚未初始化。');
  };
  const state: { staleMessage?: string } = {};
  const runtime: LoadExtensionsResult['runtime'] = {
    sendMessage: notInitialized,
    sendUserMessage: notInitialized,
    appendEntry: notInitialized,
    setSessionName: notInitialized,
    getSessionName: notInitialized,
    setLabel: notInitialized,
    getActiveTools: notInitialized,
    getAllTools: notInitialized,
    setActiveTools: notInitialized,
    refreshTools: () => undefined,
    getCommands: notInitialized,
    setModel: () => Promise.reject(new Error('Pi 扩展运行时尚未初始化。')),
    getThinkingLevel: notInitialized,
    setThinkingLevel: notInitialized,
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    pendingNativeProviderRegistrations: [],
    assertActive: () => {
      if (state.staleMessage) throw new Error(state.staleMessage);
    },
    invalidate: (message) => {
      state.staleMessage ??= message ?? 'Pi 会话已经失效。';
    },
    registerProvider: (name, config, extensionPath = '<zeus-headless>') => {
      runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
    },
    registerNativeProvider: (provider, extensionPath = '<zeus-headless>') => {
      runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath });
    },
    unregisterProvider: (name) => {
      runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((registration) => registration.name !== name);
      runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter((registration) => registration.provider.id !== name);
    },
  };
  return runtime;
}

function loadProjectContextFiles(cwd: string, agentDir: string): ContextFile[] {
  const contextFiles: ContextFile[] = [];
  const seenPaths = new Set<string>();
  const globalContext = loadContextFileFromDir(agentDir);
  if (globalContext) {
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }

  const ancestorContextFiles: ContextFile[] = [];
  const shadowedContextFile = findShadowedContextFile(cwd);
  let currentDir = cwd;
  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    const isShadowed = shadowedContextFile !== undefined && canonicalizePath(contextFile?.path ?? '') === shadowedContextFile;
    if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
      ancestorContextFiles.unshift(contextFile);
      seenPaths.add(contextFile.path);
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  contextFiles.push(...ancestorContextFiles);
  return contextFiles;
}

function loadContextFileFromDir(directory: string): ContextFile | null {
  for (const filename of ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']) {
    const filePath = join(directory, filename);
    try {
      if (!existsSync(filePath) || !statSync(filePath).isFile()) continue;
      return { path: filePath, content: readFileSync(filePath, 'utf8') };
    } catch {
      // 单个上下文文件不可读时继续查找其他候选文件。
    }
  }
  return null;
}

function findShadowedContextFile(cwd: string): string | undefined {
  const gitPaths = findGitPaths(cwd);
  if (!gitPaths) return undefined;
  const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
  const worktreeRoot = canonicalizePath(gitPaths.repoDir);
  const mainRepoRoot = dirname(commonGitDir);
  if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return undefined;
  if (canonicalizePath(join(mainRepoRoot, '.git')) !== commonGitDir) return undefined;
  const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
  return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
}

function findGitPaths(cwd: string): GitPaths | null {
  let directory = cwd;
  while (true) {
    const gitPath = join(directory, '.git');
    try {
      if (existsSync(gitPath)) {
        const stats = statSync(gitPath);
        if (stats.isFile()) {
          const content = readFileSync(gitPath, 'utf8').trim();
          if (content.startsWith('gitdir: ')) {
            const gitDir = resolve(directory, content.slice(8).trim());
            if (!existsSync(join(gitDir, 'HEAD'))) return null;
            const commonDirPath = join(gitDir, 'commondir');
            const commonGitDir = existsSync(commonDirPath) ? resolve(gitDir, readFileSync(commonDirPath, 'utf8').trim()) : gitDir;
            return { repoDir: directory, commonGitDir };
          }
        } else if (stats.isDirectory() && existsSync(join(gitPath, 'HEAD'))) {
          return { repoDir: directory, commonGitDir: gitPath };
        }
      }
    } catch {
      return null;
    }
    const parentDir = dirname(directory);
    if (parentDir === directory) return null;
    directory = parentDir;
  }
}

function canonicalizePath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}
