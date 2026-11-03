/** 新建会话工作树的来源和目标分支；项目目录模式不消费此配置。 */
export interface ConversationWorktreeBranchOptions {
  /** 来源属于本地分支或已获取的远端跟踪分支。 */
  sourceKind: 'local' | 'remote';
  /** 来源分支引用，远端引用包含 remote 名称。 */
  sourceRef: string;
  /** 新建或重用的会话工作树分支名。 */
  branchName: string;
}

/** 多仓库配置使用 Git 工作台返回的身份绑定各自来源，路径由宿主解析。 */
export interface ConversationRepositoryWorktreeOptions extends ConversationWorktreeBranchOptions {
  /** 桌面发现身份或网页登记身份；均须在所属项目内重新核对。 */
  repositoryId: string;
}

/** 根仓单独工作树与完整项目工作树共用发送入口。 */
export type ConversationWorktreeOptions = ConversationWorktreeBranchOptions | { repositories: ConversationRepositoryWorktreeOptions[] };

/** 新安装与旧设置缺省时使用的任务分支命名空间。 */
export const defaultTaskBranchPrefix = 'zeus';

/**
 * 将用户输入规范为不带结尾斜杠的 Git 分支前缀。
 * 这里只接受会稳定生成合法完整分支名的结构，完整分支仍由 Git 自身最终校验。
 */
export function normalizeTaskBranchPrefix(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  /** 设置界面允许用户自然地输入结尾斜杠，持久层统一去除。 */
  const normalized = value.trim().replace(/\/+$/u, '');
  if (!normalized || normalized.length > 100 || normalized === '@' || normalized.startsWith('-') || normalized.startsWith('/') || normalized.includes('..') || normalized.includes('@{') || normalized.includes('//')) return null;
  /** Git 禁止控制字符、空格和这些引用语法字符出现在分支名中。 */
  const containsForbiddenCharacter = Array.from(normalized).some((character) => {
    /** 单字符码点用于覆盖 Git 禁止的 ASCII 控制范围。 */
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || '~^:?*[\\'.includes(character);
  });
  if (containsForbiddenCharacter) return null;
  /** 每一段都必须能安全地作为 refs/heads 下的路径段。 */
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment.startsWith('.') || segment.endsWith('.') || segment.toLowerCase().endsWith('.lock'))) return null;
  return normalized;
}

/** 只接受包含来源、目标分支的完整工作树配置。 */
export function isConversationWorktreeOptions(value: unknown): value is ConversationWorktreeOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  /** 输入边界先检查成员结构，避免把混合的单仓与多仓配置接受为有效值。 */
  const entry = value as Record<string, unknown>;
  if ('repositories' in entry) {
    if (!Array.isArray(entry.repositories) || !entry.repositories.length || 'sourceKind' in entry || 'sourceRef' in entry || 'branchName' in entry) return false;
    /** 仓库登记身份在一次请求内只能出现一次。 */
    const identities = new Set<string>();
    return entry.repositories.every((member: unknown) => {
      if (typeof member !== 'object' || member === null || Array.isArray(member) || 'repositories' in member) return false;
      /** 路径不接受客户端指定，只保留登记身份与分支配置。 */
      const repository = member as Record<string, unknown>;
      /** 先保存身份，分支类型校验不会改变该身份的类型。 */
      const repositoryId = repository.repositoryId;
      if (typeof repositoryId !== 'string' || !repositoryId.trim() || identities.has(repositoryId) || !isConversationWorktreeOptions(repository)) return false;
      identities.add(repositoryId);
      return true;
    });
  }
  return (entry.sourceKind === 'local' || entry.sourceKind === 'remote') && typeof entry.sourceRef === 'string' && Boolean(entry.sourceRef.trim()) && typeof entry.branchName === 'string' && Boolean(entry.branchName.trim());
}
