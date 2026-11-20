import type { ReactNode } from 'react';
import { Button } from '../ui/Button.js';
import './fileWorkspaceToolbar.css';

/** 文件路径可在所属工作区提供逐级目录定位。 */
interface FilePathBreadcrumbsProps {
  /** 已授权文件的展示路径，不用于文件读写。 */
  path: string;
  /** 相对路径显示时保留调用方原有的复制路径。 */
  copyPath?: string;
  /** 文件名用于路径菜单和无障碍提示。 */
  name?: string;
  /** 当前文件的实际 Git 状态。 */
  status?: string;
  /** 上方标签已经显示当前文件名，路径栏只显示目录。 */
  fileNameInTab?: boolean;
  /** 路径与操作区域的中英文名称。 */
  zh: boolean;
  /** 只接收当前文件的工作区相对父目录。 */
  onRevealDirectory?: (path: string) => void | Promise<void>;
}

/** 按字素切分目录名，保留组合字符和文件扩展名的末尾。 */
const filenameSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 源码、预览和审阅共享逐级可点击的路径。 */
export function FilePathBreadcrumbs({ path, copyPath, name, status, fileNameInTab, zh, onRevealDirectory, compact }: FilePathBreadcrumbsProps & { /** 项目源码页使用原有紧凑行高。 */ compact?: boolean }) {
  /** 完整路径用于定位、复制和显示提示。 */
  const parts = path.split('/');
  /** 文件名位于标签时，路径栏只占用目录所需的空间。 */
  const displayedParts = fileNameInTab ? parts.slice(0, -1) : parts;
  if (!displayedParts.some(Boolean)) return null;

  return (
    <nav
      className={compact ? 'session-source-breadcrumbs project-source-breadcrumbs' : 'session-source-breadcrumbs'}
      aria-label={zh ? '文件路径' : 'File path'}
      tabIndex={0}
      data-file-path={copyPath ?? path}
      data-file-name={name}
      data-icon-tooltip={parts.join(compact ? ' / ' : ' › ')}
    >
      {displayedParts.map((part, index) => {
        if (!part) return null;
        /** 最后一段是文件，目录仍以原始相对路径定位。 */
        const isFile = index === parts.length - 1;
        /** 保留长名称最后三个字素，由 CSS 在前半部分的末尾绘制省略号。 */
        const graphemes = Array.from(filenameSegmenter.segment(part), ({ segment }) => segment);
        /** 短名称使用一个文本节点，优先完整显示。 */
        const hasSuffix = graphemes.length > 5;
        /** 屏幕阅读器和提示读取原始名称。 */
        const label = (
          <span className="file-path-label">
            <span>{hasSuffix ? graphemes.slice(0, -3).join('') : part}</span>
            {hasSuffix ? <span>{graphemes.slice(-3).join('')}</span> : null}
          </span>
        );
        return (
          <span key={index} data-abbreviate={hasSuffix || undefined} aria-current={isFile ? 'page' : undefined} data-file-status={isFile ? status : undefined} data-icon-tooltip={part}>
            {index > 0 ? <span aria-hidden="true">{compact ? '/' : '›'}</span> : null}
            {onRevealDirectory && !isFile ? (
              <Button unstyled type="button" className="file-path-directory" aria-label={part} data-icon-tooltip={part} onClick={() => onRevealDirectory(parts.slice(0, index + 1).join('/'))}>
                {label}
              </Button>
            ) : (
              label
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** 源码预览和文件审阅共用路径、操作布局及窄面板换行规则。 */
export function FileWorkspaceToolbar({
  children,
  ...breadcrumbs
}: FilePathBreadcrumbsProps & {
  /** 文件所属页面提供的操作，保留原授权和事件处理。 */
  children: ReactNode;
}) {
  return (
    <div className="session-source-toolbar">
      <FilePathBreadcrumbs {...breadcrumbs} />
      <div className="session-source-actions" role="group" aria-label={breadcrumbs.zh ? '文件操作' : 'File actions'}>
        {children}
      </div>
    </div>
  );
}
