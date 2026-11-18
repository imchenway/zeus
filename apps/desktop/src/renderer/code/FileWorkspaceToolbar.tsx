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
  /** 路径与操作区域的中英文名称。 */
  zh: boolean;
  /** 只接收当前文件的工作区相对父目录。 */
  onRevealDirectory?: (path: string) => void | Promise<void>;
}

/** 源码、预览和审阅统一渲染目录按钮和当前文件名。 */
export function FilePathBreadcrumbs({ path, copyPath, name, status, zh, onRevealDirectory, compact }: FilePathBreadcrumbsProps & { /** 项目源码页使用原有紧凑行高。 */ compact?: boolean }) {
  /** 同一条路径用于显示和累积工作区相对目录。 */
  const parts = path.split('/');
  return (
    <nav
      className={compact ? 'session-source-breadcrumbs project-source-breadcrumbs' : 'session-source-breadcrumbs'}
      aria-label={zh ? '文件路径' : 'File path'}
      tabIndex={0}
      data-file-path={copyPath ?? path}
      data-file-name={name}
      data-icon-tooltip={parts.join(compact ? ' / ' : ' › ')}
    >
      {parts.map((part, index) => (
        <span key={index} aria-current={index === parts.length - 1 ? 'page' : undefined} data-file-status={index === parts.length - 1 ? status : undefined}>
          {index > 0 ? <span aria-hidden="true">{compact ? '/' : '›'}</span> : null}
          {onRevealDirectory && index < parts.length - 1 ? (
            <Button unstyled type="button" className="file-path-directory" onClick={() => onRevealDirectory(parts.slice(0, index + 1).join('/'))}>
              {part}
            </Button>
          ) : (
            part
          )}
        </span>
      ))}
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
