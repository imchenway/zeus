import type { CSSProperties } from 'react';
import { ZeusSelect, type ZeusSelectProps } from '../ZeusSelect.js';

/** 任务管理状态下拉使用配置中的色点和选中状态色。 */
export function TaskManagementStatusSelect<T extends string>(props: Omit<ZeusSelectProps<T>, 'style'>) {
  /** 未选择状态或旧状态已从配置移除时，触发器使用中性色。 */
  const color = props.options.find((option) => option.value === props.value)?.color ?? '#6b7280';
  return <ZeusSelect {...props} className={['task-status-select', 'task-status-custom', props.className].filter(Boolean).join(' ')} style={{ '--task-status-tone': color } as CSSProperties} />;
}
