import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import type { ProjectSourceEntryKind } from '@zeus/shared';
import type { ReactNode } from 'react';
import { Button, type ButtonProps } from '../ui/Button.js';
import { FileTypeIcon } from './FileTypeIcon.js';
import './fileTreeRow.css';

/** 文件栏共用行内容，调用方通过按钮属性选择文件或展开目录。 */
type FileTreeRowProps = {
  name: string;
  path?: string;
  depth: number;
  kind: ProjectSourceEntryKind;
  fileStatus?: string;
  trailing?: ReactNode;
  /** 无按钮属性时用目录的原生 summary 控制展开。 */
  button?: Pick<ButtonProps, 'role' | 'aria-selected' | 'aria-current' | 'aria-expanded' | 'aria-label' | 'disabled' | 'onClick' | 'onContextMenu' | 'onKeyDown'>;
};

/** 源码和审阅文件栏使用相同的行高、图标、状态和焦点样式。 */
export function FileTreeRow({ name, path, depth, kind, fileStatus, trailing, button }: FileTreeRowProps) {
  /** 目录沿用自身展开控件，文件行也预留相同的箭头位置。 */
  const directory = kind === 'directory';
  /** 源码树的选中项与审阅树的当前文件共用高亮。 */
  const selected = button?.['aria-selected'] === true || button?.['aria-current'] === 'true';
  /** 每个目录层级缩进 14 px，路径继续用于复制文件路径。 */
  const row = {
    className: selected ? 'file-tree-row selected' : 'file-tree-row',
    'data-file-path': path,
    'data-icon-tooltip': name,
    style: { paddingInlineStart: 10 + depth * 14 },
  };
  /** 文件名可截断，右侧元数据与目录层级共用行内布局。 */
  const content = (
    <>
      <span className="file-tree-row-disclosure" aria-hidden="true">
        {directory ? <CaretRight size={12} /> : null}
      </span>
      <FileTypeIcon path={path ?? name} kind={directory ? 'directory' : undefined} />
      <span data-file-status={fileStatus}>{name}</span>
      {kind === 'symlink' ? <small>↗</small> : null}
      {trailing}
    </>
  );
  return button ? (
    <Button {...button} {...row} type="button" unstyled data-busy-behavior="background">
      {content}
    </Button>
  ) : (
    <summary {...row}>{content}</summary>
  );
}
