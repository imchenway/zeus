import type { FileReview } from '@zeus/shared';

/** 文件名使用真实 Git 状态；补丁中的新增不能代替工作区的未跟踪状态。 */
export type FileStatus = NonNullable<FileReview['status']>;

/** 状态说明供悬停与读屏使用，不在文件名旁重复显示。 */
const labels: Record<FileStatus, [string, string]> = {
  added: ['新增', 'Added'],
  modified: ['修改', 'Modified'],
  deleted: ['删除', 'Deleted'],
  renamed: ['重命名', 'Renamed'],
  copied: ['复制', 'Copied'],
  untracked: ['未跟踪', 'Untracked'],
  conflict: ['冲突', 'Conflict'],
  other: ['变更', 'Changed'],
  unchanged: ['未修改', 'Unchanged'],
  ignored: ['已忽略', 'Ignored'],
};

/** 各 Git 文件入口共享状态文案。 */
export function fileStatusLabel(status: FileStatus, zh: boolean): string {
  return labels[status][zh ? 0 : 1];
}
