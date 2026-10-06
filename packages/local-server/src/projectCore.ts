/** 项目仅保留仓库事实、连接资源和授权边界，不保存工作偏好。 */
export interface ProjectConfigSnapshot {
  projectId: string;
  vcs: { isGitRepository: boolean; gitRoot: string | null };
  database: { connectionName: string | null };
  security: { allowShell: boolean; allowGitWrite: boolean };
}

/** 项目资源接口只接受资源信息与显式授权。 */
export interface UpdateProjectConfigBody {
  vcs?: { isGitRepository?: unknown; gitRoot?: unknown };
  database?: { connectionName?: unknown };
  security?: { allowShell?: unknown; allowGitWrite?: unknown };
}

/** 新项目的授权默认关闭，避免精简设置时扩大权限。 */
export function createDefaultProjectConfig(projectId: string): ProjectConfigSnapshot {
  return {
    projectId,
    vcs: { isGitRepository: false, gitRoot: null },
    database: { connectionName: null },
    security: { allowShell: false, allowGitWrite: false },
  };
}

/** 读取旧数据时只提取项目资源，退役的独立偏好不再生效。 */
export function normalizeProjectConfig(projectId: string, value: unknown, fallback: ProjectConfigSnapshot): ProjectConfigSnapshot | null {
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as UpdateProjectConfigBody;
  const vcs = normalizeVcsConfig(raw.vcs, fallback.vcs);
  const connectionName = normalizeOptionalSingleLine(raw.database?.connectionName, 80, fallback.database.connectionName);
  if (vcs === null || (connectionName === null && raw.database?.connectionName !== undefined && raw.database.connectionName !== null)) return null;
  return {
    projectId,
    vcs,
    database: { connectionName },
    security: {
      allowShell: typeof raw.security?.allowShell === 'boolean' ? raw.security.allowShell : fallback.security.allowShell,
      allowGitWrite: typeof raw.security?.allowGitWrite === 'boolean' ? raw.security.allowGitWrite : fallback.security.allowGitWrite,
    },
  };
}

/** 校验仓库资源信息，保持非仓库项目没有 Git 根目录。 */
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

/** 校验可为空的单行资源标识。 */
function normalizeOptionalSingleLine(value: unknown, maxLength: number, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength || hasControlCharacter(text)) return null;
  return text;
}

/** 检测资源标识中的控制字符。 */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/** 阻止数据库连接密码进入普通项目设置。 */
export function hasDatabaseUriPassword(value: string | null | undefined): boolean {
  const text = value?.trim();
  if (!text || !/^(?:postgresql?|mysql|mariadb):/iu.test(text)) return false;
  try {
    return Boolean(new URL(text).password);
  } catch {
    // URI 格式不完整时也按 user:password@ 形态拦截，避免敏感信息落入本地设置表。
    return /:\/\/[^:@\s]+:[^@\s]+@/u.test(text);
  }
}
