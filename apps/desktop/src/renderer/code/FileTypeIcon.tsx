import type { CSSProperties } from 'react';
import { materialFileIconName, materialFolderIconName, materialIconUrl } from './materialFileIcon.js';
import './fileAppearance.css';

/** 文件列表和资源入口共用图标，尺寸按入口的排版密度选择。 */
type FileTypeIconProps = {
  path: string;
  kind?: 'file' | 'directory' | 'submodule';
  /** 图标宽高，单位为 CSS 像素。 */
  size?: number;
};

/** 子模块用 Git 标志，文件和目录按路径选择 Material 图标。 */
export function FileTypeIcon({ path, kind = 'file', size = 16 }: FileTypeIconProps) {
  /** 文件夹的默认和展开图标使用同一名称前缀。 */
  const name = kind === 'directory' ? materialFolderIconName(path) : kind === 'submodule' ? 'git' : materialFileIconName(path);
  /** 展开图标相对于页面路径解析，供独立样式表使用。 */
  const style = kind === 'directory' ? ({ '--file-type-open-icon': `url("${new URL(materialIconUrl(`${name}-open`), document.baseURI).href}")` } as CSSProperties) : undefined;
  return <img className="file-type-icon" data-file-kind={kind} src={materialIconUrl(name)} alt="" aria-hidden="true" width={size} height={size} draggable={false} style={style} />;
}
