import { type ReactNode } from 'react';

/** 输入工具栏保留原包裹尺寸；共享提示管理器统一处理悬停、键盘和禁用状态。 */
export function IconTooltip(props: { label: string; children: ReactNode }) {
  return (
    <span className="zeus-icon-tooltip-trigger" data-icon-tooltip={props.label}>
      {props.children}
    </span>
  );
}
