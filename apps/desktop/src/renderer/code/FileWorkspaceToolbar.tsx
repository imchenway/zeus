import type { ReactNode } from 'react';
import './fileWorkspaceToolbar.css';

/** 源码预览和文件审阅共用路径、操作布局及窄面板换行规则。 */
export function FileWorkspaceToolbar(props: {
  /** 已授权文件的展示路径，不用于文件读写。 */
  path: string;
  /** 文件名用于路径菜单和无障碍提示。 */
  name?: string;
  /** 当前文件的实际 Git 状态。 */
  status?: string;
  /** 操作区域的中英文名称。 */
  zh: boolean;
  /** 文件所属页面提供的操作，保留原授权和事件处理。 */
  children: ReactNode;
}) {
  return (
    <div className="session-source-toolbar">
      <nav className="session-source-breadcrumbs" aria-label={props.zh ? '文件路径' : 'File path'} tabIndex={0} data-file-path={props.path} data-file-name={props.name} data-icon-tooltip={props.path.split('/').join('›')}>
        {props.path.split('/').map((part, index, parts) => (
          <span key={index} data-file-status={index === parts.length - 1 ? props.status : undefined}>
            {index > 0 ? <span aria-hidden="true">›</span> : null}
            {part}
          </span>
        ))}
      </nav>
      <div className="session-source-actions" role="group" aria-label={props.zh ? '文件操作' : 'File actions'}>
        {props.children}
      </div>
    </div>
  );
}
