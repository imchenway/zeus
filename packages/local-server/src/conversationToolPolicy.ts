import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ConversationCollaborationMode, ConversationPermissionMode } from '@zeus/storage';

/** 计划模式由执行快照决定，不能被完全访问权限或下一轮草稿放宽。 */
export function effectiveToolPermission(permission: ConversationPermissionMode, mode: ConversationCollaborationMode): ConversationPermissionMode {
  return mode === 'plan' ? 'read-only' : permission;
}

/** 后续输入只能沿用更严格的权限；相同目录边界下人工审批比自动审批更严格。 */
export function restrictToolPermission(permission: ConversationPermissionMode, ceiling: ConversationPermissionMode): ConversationPermissionMode {
  const order: ConversationPermissionMode[] = ['read-only', 'auto', 'auto-review', 'full-access'];
  return order.indexOf(permission) <= order.indexOf(ceiling) ? permission : ceiling;
}

/** 文件与命令共用的隔离等级。 */
export function toolSandboxMode(permission: ConversationPermissionMode, mode: ConversationCollaborationMode): 'read-only' | 'workspace-write' | 'danger-full-access' {
  const effective = effectiveToolPermission(permission, mode);
  return effective === 'read-only' ? 'read-only' : effective === 'full-access' ? 'danger-full-access' : 'workspace-write';
}

/** 系统命令、动态库及开发工具的只读目录；文件工具与进程采用同一清单。 */
const systemReadableRoots = [
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/lib',
  '/usr/share',
  '/usr/local',
  '/opt/homebrew',
  '/Library/Apple',
  '/Library/Developer',
  '/System/Library',
  '/System/Volumes/Preboot',
  '/private/etc',
  '/private/var/db/timezone',
  '/private/var/db/DarwinDirectory/local/recordStore.data',
  '/dev',
];

/** 使用系统隔离组件，明确收紧系统默认规则，不能隐式放开整个临时目录。 */
export function conversationSandboxProfile(input: { cwd: string; scratchDirectory: string; permission: ConversationPermissionMode; workMode: ConversationCollaborationMode; readableRoots: readonly string[] }): string {
  const readable = [...new Set([...systemReadableRoots, input.cwd, input.scratchDirectory, ...input.readableRoots].map(canonicalToolPath))];
  const writable = [canonicalToolPath(input.scratchDirectory), ...(effectiveToolPermission(input.permission, input.workMode) === 'read-only' ? [] : [canonicalToolPath(input.cwd)])];
  // 动态加载器需要根目录本身的读取权限；仅限目录本身，不授权其后代。
  const readFilters = ['(literal "/")', ...readable.map((path) => `(subpath ${JSON.stringify(path)})`)];
  const writeFilters = [...writable.map((path) => `(subpath ${JSON.stringify(path)})`), '(literal "/dev/null")', '(literal "/dev/tty")', '(literal "/dev/ptmx")', '(regex #"^/dev/ttys[0-9]+$")'];
  return [
    '(version 1)(deny default)(import "system.sb")',
    '(allow process-fork process-exec sysctl-read)(allow signal (target same-sandbox))',
    '(allow file-read-metadata)(allow pseudo-tty)(allow file-ioctl (subpath "/dev"))',
    `(allow file-read* file-map-executable ${readFilters.join(' ')})`,
    `(allow file-write* ${writeFilters.join(' ')})`,
    `(deny file-read-data (require-all ${readFilters.map((filter) => `(require-not ${filter})`).join(' ')}))`,
    `(deny file-write* (require-all ${writeFilters.map((filter) => `(require-not ${filter})`).join(' ')}))`,
    '(deny network*)',
  ].join('\n');
}

/** 解析新文件时也沿真实父目录校验，不能用工作区里的链接绕过边界。 */
export function canonicalToolPath(value: string): string {
  const missing: string[] = [];
  let cursor = resolve(value);
  while (true) {
    try {
      const canonical = realpathSync(cursor);
      if (missing.length && !statSync(canonical).isDirectory()) throw new Error('目标父路径不是目录。');
      return resolve(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // 悬空链接不是待创建的普通文件；写入它可能实际落在工作区之外。
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw Object.assign(new Error('目标包含无法解析的符号链接。'), { code: 'ZEUS_TOOL_PATH_UNRESOLVED_LINK' });
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== 'ENOENT') throw inspectionError;
      }
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(cursor.slice(parent.length).replace(/^[/\\]+/u, ''));
      cursor = parent;
    }
  }
}

/** 路径授权使用完整目录边界，避免同名前缀或上级跳转。 */
export function toolPathInside(path: string, root: string): boolean {
  const difference = relative(root, path);
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

/** 只判定本次具体目标是否需要审批；调用方必须先审批、再执行一次。 */
export function resolveConversationToolPath(input: { cwd: string; path: string; permission: ConversationPermissionMode; workMode: ConversationCollaborationMode; write: boolean; readableRoots: readonly string[] }): {
  path: string;
  requiresApproval: boolean;
} {
  const permission = effectiveToolPermission(input.permission, input.workMode);
  if (input.write && permission === 'read-only') throw Object.assign(new Error('当前模式只允许读取，不能修改文件。'), { code: 'ZEUS_PI_TOOL_READ_ONLY' });
  const path = canonicalToolPath(resolve(input.cwd, input.path));
  if (permission === 'full-access' || toolPathInside(path, canonicalToolPath(input.cwd))) return { path, requiresApproval: false };
  if (!input.write && [...systemReadableRoots, ...input.readableRoots].some((root) => toolPathInside(path, canonicalToolPath(root)))) return { path, requiresApproval: false };
  return { path, requiresApproval: true };
}
