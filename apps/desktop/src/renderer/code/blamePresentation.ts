import type { GitBlameLine } from '../features/git/gitContracts.js';

/** 侧栏与行尾只展示真实提交；全零身份、缺失作者和无效时间不构成提交详情。 */
export function hasBlameCommit(line: GitBlameLine | undefined): line is GitBlameLine {
  return Boolean(
    line &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(line.commitHash) &&
    !/^0+$/u.test(line.commitHash) &&
    line.author.trim() &&
    // Git porcelain 解析器以 Unknown 表示缺失作者，不将占位文字当作真实提交人。
    line.author.trim() !== 'Unknown' &&
    line.authorTime > 0 &&
    Number.isFinite(new Date(line.authorTime * 1_000).getTime()),
  );
}

/** 侧栏统一使用本地日期和补零格式，不随页面语言改变年月日顺序。 */
export function formatBlameAuthor(line: GitBlameLine): string {
  /** Git 时间以秒存储，显示沿用源码页的本地时区。 */
  const date = new Date(line.authorTime * 1_000);
  /** 年月日均使用固定宽度，确保所有文件入口显示 YYYY/MM/DD。 */
  const day = [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('/');
  return `${day} ${line.author.trim()}`;
}
