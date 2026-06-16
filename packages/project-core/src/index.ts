export type ProjectWorkMode = 'plan' | 'develop' | 'review' | 'debug';
export type ProjectIndexScope = 'project' | 'src' | 'custom';

export interface ProjectConfigSnapshot {
  projectId: string;
  defaultModel: string | null;
  defaultWorkMode: ProjectWorkMode;
  defaultTaskPrompt: string;
  scan: {
    ignoreDirectories: string[];
    indexScope: ProjectIndexScope;
  };
  language: {
    primary: string;
    additional: string[];
  };
  dependencies: {
    packageManagers: string[];
    manifestPaths: string[];
  };
  vcs: {
    isGitRepository: boolean;
    gitRoot: string | null;
  };
  database: {
    connectionName: string | null;
    schemaPaths: string[];
  };
  telegram: {
    alias: string | null;
  };
  security: {
    allowShell: boolean;
    allowGitWrite: boolean;
  };
}

export interface UpdateProjectConfigBody {
  defaultModel?: unknown;
  defaultWorkMode?: unknown;
  defaultTaskPrompt?: unknown;
  scan?: { ignoreDirectories?: unknown; indexScope?: unknown };
  language?: { primary?: unknown; additional?: unknown };
  dependencies?: { packageManagers?: unknown; manifestPaths?: unknown };
  vcs?: { isGitRepository?: unknown; gitRoot?: unknown };
  database?: { connectionName?: unknown; schemaPaths?: unknown };
  telegram?: { alias?: unknown };
  security?: { allowShell?: unknown; allowGitWrite?: unknown };
}

const defaultProjectIgnoreDirectories = ['node_modules', 'dist', '.tmp', 'coverage'];

/**
 * 生成设计书约定的项目默认配置；默认值只表达用户偏好，不声明任何外部工具已经可用。
 */
export function createDefaultProjectConfig(projectId: string): ProjectConfigSnapshot {
  return {
    projectId,
    defaultModel: null,
    defaultWorkMode: 'plan',
    defaultTaskPrompt: '',
    scan: {
      ignoreDirectories: [...defaultProjectIgnoreDirectories],
      indexScope: 'project',
    },
    language: { primary: 'typescript', additional: [] },
    dependencies: { packageManagers: [], manifestPaths: [] },
    vcs: { isGitRepository: false, gitRoot: null },
    database: { connectionName: null, schemaPaths: [] },
    telegram: { alias: null },
    security: { allowShell: false, allowGitWrite: false },
  };
}

/**
 * 归一化项目偏好配置，并在发现越权路径或控制字符时整体拒绝，避免污染本地事实库。
 */
export function normalizeProjectConfig(projectId: string, value: unknown, fallback: ProjectConfigSnapshot): ProjectConfigSnapshot | null {
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as UpdateProjectConfigBody;
  const defaultModel = normalizeOptionalSingleLine(raw.defaultModel, 80, fallback.defaultModel);
  const defaultTaskPrompt = normalizeSingleLineText(raw.defaultTaskPrompt, 600, fallback.defaultTaskPrompt);
  const scanIgnoreDirectories = normalizeProjectIgnoreDirectories(raw.scan?.ignoreDirectories, fallback.scan.ignoreDirectories);
  const languagePrimary = normalizeIdentifierText(raw.language?.primary, fallback.language.primary);
  const languageAdditional = normalizeIdentifierList(raw.language?.additional, fallback.language.additional);
  const packageManagers = normalizeIdentifierList(raw.dependencies?.packageManagers, fallback.dependencies.packageManagers);
  const manifestPaths = normalizeSafeRelativePathList(raw.dependencies?.manifestPaths, fallback.dependencies.manifestPaths);
  const vcs = normalizeVcsConfig(raw.vcs, fallback.vcs);
  const connectionName = normalizeOptionalSingleLine(raw.database?.connectionName, 80, fallback.database.connectionName);
  const schemaPaths = normalizeSafeRelativePathList(raw.database?.schemaPaths, fallback.database.schemaPaths);
  const telegramAlias = normalizeOptionalSingleLine(raw.telegram?.alias, 80, fallback.telegram.alias);
  if (
    (defaultModel === null && raw.defaultModel !== undefined && raw.defaultModel !== null) ||
    defaultTaskPrompt === null ||
    scanIgnoreDirectories === null ||
    languagePrimary === null ||
    languageAdditional === null ||
    packageManagers === null ||
    manifestPaths === null ||
    vcs === null ||
    (connectionName === null && raw.database?.connectionName !== undefined && raw.database.connectionName !== null) ||
    schemaPaths === null ||
    (telegramAlias === null && raw.telegram?.alias !== undefined && raw.telegram.alias !== null)
  )
    return null;
  return {
    projectId,
    defaultModel,
    defaultWorkMode: isProjectWorkMode(raw.defaultWorkMode) ? raw.defaultWorkMode : fallback.defaultWorkMode,
    defaultTaskPrompt,
    scan: {
      ignoreDirectories: scanIgnoreDirectories,
      indexScope: isProjectIndexScope(raw.scan?.indexScope) ? raw.scan.indexScope : fallback.scan.indexScope,
    },
    language: { primary: languagePrimary, additional: languageAdditional },
    dependencies: { packageManagers, manifestPaths },
    vcs,
    database: { connectionName, schemaPaths },
    telegram: { alias: telegramAlias },
    security: {
      allowShell: typeof raw.security?.allowShell === 'boolean' ? raw.security.allowShell : fallback.security.allowShell,
      allowGitWrite: typeof raw.security?.allowGitWrite === 'boolean' ? raw.security.allowGitWrite : fallback.security.allowGitWrite,
    },
  };
}

function normalizeVcsConfig(value: unknown, fallback: ProjectConfigSnapshot['vcs']): ProjectConfigSnapshot['vcs'] | null {
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { isGitRepository?: unknown; gitRoot?: unknown };
  const isGitRepository = typeof raw.isGitRepository === 'boolean' ? raw.isGitRepository : fallback.isGitRepository;
  const gitRoot = normalizeOptionalSingleLine(raw.gitRoot, 260, fallback.gitRoot);
  if (gitRoot === null && raw.gitRoot !== undefined && raw.gitRoot !== null) return null;
  // Git Root 来自本地目录向上检测；不是 Git 仓库时强制清空，避免保存矛盾配置。
  return { isGitRepository, gitRoot: isGitRepository ? gitRoot : null };
}

function normalizeOptionalSingleLine(value: unknown, maxLength: number, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength || hasControlCharacter(text)) return null;
  return text;
}

function normalizeSingleLineText(value: unknown, maxLength: number, fallback: string): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length > maxLength || hasControlCharacter(text)) return null;
  return text;
}

function normalizeIdentifierText(value: unknown, fallback: string): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(text) ? text : null;
}

function normalizeIdentifierList(value: unknown, fallback: string[]): string[] | null {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 20) return null;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const normalized = normalizeIdentifierText(item, '');
    if (!normalized) return null;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      items.push(normalized);
    }
  }
  return items;
}

function normalizeProjectIgnoreDirectories(value: unknown, fallback: string[]): string[] | null {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 30) return null;
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const directory = item.trim();
    if (!directory || directory.startsWith('/') || directory.includes('..') || directory.includes('\\') || hasControlCharacter(directory) || directory.length > 80) return null;
    if (!/^[A-Za-z0-9._@-]+$/.test(directory)) return null;
    if (!seen.has(directory)) {
      seen.add(directory);
      directories.push(directory);
    }
  }
  return directories;
}

function normalizeSafeRelativePathList(value: unknown, fallback: string[]): string[] | null {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 50) return null;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const path = item.trim();
    if (!path || path.startsWith('/') || path.includes('..') || hasControlCharacter(path) || path.length > 180) return null;
    if (!/^[A-Za-z0-9._/@-]+$/.test(path)) return null;
    if (!seen.has(path)) {
      seen.add(path);
      items.push(path);
    }
  }
  return items;
}

function isProjectWorkMode(value: unknown): value is ProjectWorkMode {
  return value === 'plan' || value === 'develop' || value === 'review' || value === 'debug';
}

function isProjectIndexScope(value: unknown): value is ProjectIndexScope {
  return value === 'project' || value === 'src' || value === 'custom';
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
