import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface ZeusSelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface ZeusSelectProps<T extends string> {
  ariaLabel: string;
  value: T;
  options: readonly ZeusSelectOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  searchable?: boolean;
}

function focusElement(element: HTMLElement | undefined): void {
  if (!element || typeof window === 'undefined') return;
  window.requestAnimationFrame(() => element.focus());
}

function filterSelectOptions<T extends string>(options: readonly ZeusSelectOption<T>[], query: string): readonly ZeusSelectOption<T>[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => `${option.label} ${option.value}`.toLocaleLowerCase().includes(normalizedQuery));
}

export function ZeusSelect<T extends string>(props: ZeusSelectProps<T>) {
  const generatedId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<T, HTMLButtonElement>());
  const enabledOptions = useMemo(() => props.options.filter((option) => !option.disabled), [props.options]);
  const searchable = props.searchable ?? props.options.length > 8;
  const selectedOption = props.options.find((option) => option.value === props.value) ?? props.options[0];
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<T>(props.value);
  const [query, setQuery] = useState('');
  const visibleOptions = useMemo(() => (searchable ? filterSelectOptions(props.options, query) : props.options), [props.options, query, searchable]);
  const enabledVisibleOptions = useMemo(() => visibleOptions.filter((option) => !option.disabled), [visibleOptions]);
  const rootId = `zeus-select-${generatedId}`;
  const listboxId = `${rootId}-listbox`;
  const activeOptionIndex = visibleOptions.findIndex((option) => option.value === activeValue);
  const activeOptionId = activeOptionIndex >= 0 ? `${listboxId}-option-${activeOptionIndex}` : undefined;
  const searchPlaceholder = props.searchPlaceholder ?? props.ariaLabel;
  const emptyLabel = props.emptyLabel ?? 'No matching options';

  const focusOption = (value: T) => focusElement(optionRefs.current.get(value));

  const closeListbox = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) focusElement(triggerRef.current ?? undefined);
  };

  const openListbox = (nextActiveValue = props.value) => {
    if (props.disabled || enabledOptions.length === 0) return;
    setQuery('');
    setActiveValue(nextActiveValue);
    setOpen(true);
    // 长列表优先聚焦搜索；任务工具栏这类短列表直接聚焦选项，避免顶部搜索灰区抢占视觉。
    focusElement(searchable ? (searchRef.current ?? undefined) : (optionRefs.current.get(nextActiveValue) ?? undefined));
  };

  const selectOption = (value: T) => {
    props.onChange(value);
    setActiveValue(value);
    closeListbox();
  };

  const moveActiveOption = (direction: 1 | -1 | 'first' | 'last') => {
    if (enabledVisibleOptions.length === 0) return;
    const currentIndex = enabledVisibleOptions.findIndex((option) => option.value === activeValue);
    const nextIndex = direction === 'first' ? 0 : direction === 'last' ? enabledVisibleOptions.length - 1 : Math.min(Math.max(currentIndex + direction, 0), enabledVisibleOptions.length - 1);
    const nextValue = enabledVisibleOptions[nextIndex]?.value;
    if (!nextValue) return;
    setActiveValue(nextValue);
    focusOption(nextValue);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openListbox(props.value);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openListbox(enabledOptions.at(-1)?.value ?? props.value);
    }
  };

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, option: ZeusSelectOption<T>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeListbox();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActiveOption(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActiveOption(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveActiveOption('first');
    } else if (event.key === 'End') {
      event.preventDefault();
      moveActiveOption('last');
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!option.disabled) selectOption(option.value);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  const handleSearchChange = (value: string) => {
    setQuery(value);
    const nextVisibleOptions = filterSelectOptions(props.options, value).filter((option) => !option.disabled);
    const selectedVisibleOption = nextVisibleOptions.find((option) => option.value === props.value);
    setActiveValue(selectedVisibleOption?.value ?? nextVisibleOptions[0]?.value ?? props.value);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeListbox();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextValue = enabledVisibleOptions.find((option) => option.value === activeValue)?.value ?? enabledVisibleOptions[0]?.value;
      if (nextValue) {
        setActiveValue(nextValue);
        focusOption(nextValue);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const nextValue = enabledVisibleOptions.at(-1)?.value;
      if (nextValue) {
        setActiveValue(nextValue);
        focusOption(nextValue);
      }
    } else if (event.key === 'Enter') {
      const activeOption = enabledVisibleOptions.find((option) => option.value === activeValue);
      if (activeOption && query.trim()) {
        event.preventDefault();
        selectOption(activeOption.value);
      }
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      closeListbox(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointerDown, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointerDown, true);
  }, [open]);

  useEffect(() => {
    setActiveValue(props.value);
  }, [props.value]);

  useEffect(() => {
    if (!open) return;
    if (enabledVisibleOptions.some((option) => option.value === activeValue)) return;
    setActiveValue(enabledVisibleOptions[0]?.value ?? props.value);
  }, [activeValue, enabledVisibleOptions, open, props.value]);

  return (
    <span className={props.className ? `zeus-select ${props.className}` : 'zeus-select'} data-zeus-select-placement="bottom" ref={rootRef}>
      {/* 自控 popover 固定从触发器下方展开，避免 macOS 原生 select 把已选项覆盖到控件上方。 */}
      <button
        ref={triggerRef}
        type="button"
        className="zeus-select-trigger"
        role="combobox"
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? activeOptionId : undefined}
        disabled={props.disabled}
        onClick={() => (open ? closeListbox(false) : openListbox(props.value))}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="zeus-select-value">{selectedOption?.label ?? props.value}</span>
        <span className="zeus-select-chevron" aria-hidden="true" />
      </button>
      <span className="zeus-select-popover" hidden={!open} data-motion-surface="popover">
        {searchable ? (
          <span className="zeus-select-search-row">
            <span className="zeus-select-search-icon" aria-hidden="true" />
            <input
              ref={searchRef}
              className="zeus-select-search-input"
              type="search"
              aria-label={searchPlaceholder}
              aria-controls={listboxId}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => handleSearchChange(event.currentTarget.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </span>
        ) : null}
        <span id={listboxId} className="zeus-select-listbox" role="listbox" aria-label={props.ariaLabel}>
          {visibleOptions.length > 0 ? (
            visibleOptions.map((option, index) => (
              <button
                key={`${option.value || 'empty'}-${index}`}
                ref={(element) => {
                  if (element) optionRefs.current.set(option.value, element);
                  else optionRefs.current.delete(option.value);
                }}
                id={`${listboxId}-option-${index}`}
                type="button"
                className="zeus-select-option"
                role="option"
                aria-selected={option.value === props.value}
                tabIndex={open && option.value === activeValue ? 0 : -1}
                disabled={option.disabled}
                data-value={option.value}
                onClick={() => selectOption(option.value)}
                onKeyDown={(event) => handleOptionKeyDown(event, option)}
              >
                <span className="zeus-select-option-label">{option.label}</span>
                <span className="zeus-select-option-check" aria-hidden="true">
                  {option.value === props.value ? '✓' : ''}
                </span>
              </button>
            ))
          ) : (
            <span className="zeus-select-empty" role="status">
              {emptyLabel}
            </span>
          )}
        </span>
      </span>
    </span>
  );
}
