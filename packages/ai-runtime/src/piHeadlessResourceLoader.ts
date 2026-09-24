import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Skill } from '@earendil-works/pi-coding-agent';
import type { LoadExtensionsResult, ResourceLoader } from '@earendil-works/pi-coding-agent/headless';
import type { AgentRunSkillActivation } from './agentRuntimeContracts.js';

interface PiHeadlessResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  pluginSkills?: PiPluginSkillResource[];
  /** Zeus 统一目录中的普通 Skill。 */
  skillCatalog?: PiPluginSkillResource[];
  pluginInstructions?: string;
}

export interface PiPluginSkillResource {
  id: string;
  name: string;
  description: string;
  path: string;
}

export interface PiApplicationContextResource {
  fingerprint: string;
  manifest: string;
  content: string;
  /** 编译结果已包含规则片段时为 true；此时不再注入内核原生 AGENTS.md，避免重复规则。 */
  agentRulesIncluded?: boolean;
}

interface ContextFile {
  path: string;
  content: string;
}

interface GitPaths {
  repoDir: string;
  commonGitDir: string;
}

/** Pi 在 Zeus 中交付文件和操作浏览器的宿主约定，与公共资源预览入口一致。 */
const piConversationResourceInstructions = `在 Zeus 会话中交付或引用本地文件时，使用 Markdown 链接：[显示名称](/绝对路径/文件)。需要定位代码时可追加 :行号；路径含空格时用尖括号包住链接目标。不要只用反引号包裹路径代替可点击链接。HTML 文件同样提供文件链接，Zeus 会展示网页卡片，点击默认进入内置浏览器；代码文件点击进入源码预览。
view_image 只用于让模型检查本地图片，不会把图片交付给用户。需要向用户展示本地图片时，必须在最终答复正文中使用 Markdown 图片语法 ![说明](/绝对路径/image.png) 明确引用；不要用“上图”“下图”等文字代替图片本身。
用户未明确指定 Chrome 或 Edge 时，网页打开、导航和检查优先使用 Zeus 原生 zeus_browser 工具，surface 省略或使用 built_in。浏览器插件没有连接不代表 Zeus 内置浏览器不可用；不要自行改用 Chrome、系统 open 命令或外部 Playwright。用户明确选择其他浏览器时尊重该选择。`;

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
  private readonly pluginSkills: Skill[];
  /** 每轮准备时替换，执行期间保持冻结。 */
  private skillCatalog: PiPluginSkillResource[];
  private readonly pluginInstructions: string;

  constructor(options: PiHeadlessResourceLoaderOptions) {
    this.cwd = resolve(options.cwd);
    this.agentDir = resolve(options.agentDir);
    this.extensionsResult = {
      extensions: [],
      errors: [],
      runtime: createEmptyExtensionRuntime(),
    };
    this.skillCatalog = options.skillCatalog ?? [];
    this.pluginSkills = (options.pluginSkills ?? []).map(toPiSkill);
    this.pluginInstructions = options.pluginInstructions?.trim() ?? '';
  }

  getExtensions(): LoadExtensionsResult {
    return this.extensionsResult;
  }

  getSkills() {
    const active = this.activeSkill;
    const candidates = [...(active ? [active] : []), ...this.skillCatalog.map(toPiSkill), ...this.pluginSkills];
    const skills = candidates.filter((skill, index) => candidates.findIndex((candidate) => candidate.filePath === skill.filePath || candidate.name === skill.name) === index);
    return { skills, diagnostics: [] };
  }

  /** 原子替换普通 Skill 目录，返回旧值供运行预检失败时恢复。 */
  replaceSkillCatalog(skills: PiPluginSkillResource[]): PiPluginSkillResource[] {
    const previous = this.skillCatalog;
    this.skillCatalog = skills;
    return previous;
  }

  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }

  getThemes() {
    return { themes: [], diagnostics: [] };
  }

  getAgentsFiles(): { agentsFiles: ContextFile[] } {
    /**
     * 规则现在由 Zeus 上下文编译统一注入（含全局、项目与子目录索引）。
     * 只有在整轮没有编译上下文时才回退到内核原生 AGENTS.md，避免同一份规则注入两次。
     */
    return { agentsFiles: this.applicationContext?.agentRulesIncluded ? [] : this.agentsFiles };
  }

  getSystemPrompt(): undefined {
    return undefined;
  }

  getSystemPromptSource(): undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
    return [
      piConversationResourceInstructions,
      ...(this.pluginInstructions ? [this.pluginInstructions] : []),
      ...(this.applicationContext
        ? [`Zeus application context manifest (application-owned):\n${this.applicationContext.manifest}`, ...(this.applicationContext.content ? [`Zeus application context (application-owned):\n${this.applicationContext.content}`] : [])]
        : []),
    ];
  }

  getAppendSystemPromptSources(): Array<{ path: string }> {
    return [
      { path: 'zeus-context://conversation-resource-instructions' },
      ...(this.pluginInstructions ? [{ path: 'zeus-plugin://activation-snapshot/instructions' }] : []),
      ...(this.applicationContext
        ? [{ path: `zeus-context://${this.applicationContext.fingerprint}/manifest` }, ...(this.applicationContext.content ? [{ path: `zeus-context://${this.applicationContext.fingerprint}/application` }] : [])]
        : []),
    ];
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

function toPiSkill(input: PiPluginSkillResource): Skill {
  const baseDir = dirname(input.path);
  return {
    name: input.name,
    description: input.description,
    filePath: input.path,
    baseDir,
    sourceInfo: {
      path: input.path,
      source: 'zeus-plugin',
      scope: 'user',
      origin: 'top-level',
      baseDir,
    },
    disableModelInvocation: false,
  };
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
