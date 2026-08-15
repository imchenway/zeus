import type { ReactNode, RefObject } from 'react';
import { ZeusSelect } from '../ZeusSelect.js';

export interface ComposerDropdownOption<Value extends string = string> {
  value: Value;
  label: string;
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
  triggerLabel?: string;
  displayLabel?: string;
  triggerIcon?: ReactNode;
  hideSelectedLabel?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
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
