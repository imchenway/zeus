import type { ReactNode, RefObject } from 'react';
import { ZeusSelect, type ZeusSelectProps } from '../ZeusSelect.js';

export interface ComposerDropdownOption<Value extends string = string> {
  value: Value;
  label: string;
  description?: string;
  disabled?: boolean;
  group?: string;
  searchText?: string;
}

export interface ComposerDropdownProps<Value extends string = string> {
  label: string;
  value: Value;
  options: readonly ComposerDropdownOption<Value>[];
  disabled?: boolean;
  title?: string;
  className?: string;
  /** 浮层挂载到应用壳层，单独透传类名以限定业务选项样式。 */
  popoverClassName?: string;
  triggerLabel?: string;
  displayLabel?: string;
  triggerIcon?: ReactNode;
  hideSelectedLabel?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  /** 模型入口透传共享置顶配置，其他会话下拉保持原有行为。 */
  pinning?: ZeusSelectProps<Value>['pinning'];
  onChange: (value: Value) => void | Promise<void>;
}

/** 会话页只保留紧凑触发器，浮层、搜索、键盘和滚动统一交给全局选择原语。 */
export function ComposerDropdown<Value extends string>(props: ComposerDropdownProps<Value>) {
  return (
    <ZeusSelect
      ariaLabel={props.triggerLabel ?? props.label}
      className={['session-composer-dropdown', props.className].filter(Boolean).join(' ')}
      disabled={props.disabled}
      emptyLabel={props.emptyLabel}
      hideSelectedLabel={props.hideSelectedLabel}
      onChange={(value) => {
        if (value !== props.value) void props.onChange(value);
      }}
      options={props.options}
      pinning={props.pinning}
      popoverClassName={props.popoverClassName}
      popoverMinWidth={112}
      searchable={props.searchable}
      searchPlaceholder={props.searchPlaceholder}
      size="compact"
      triggerClassName="session-composer-dropdown-trigger"
      triggerIcon={props.triggerIcon}
      triggerLabel={props.displayLabel}
      triggerRef={props.triggerRef}
      triggerTitle={props.title ?? props.triggerLabel}
      value={props.value}
    />
  );
}
