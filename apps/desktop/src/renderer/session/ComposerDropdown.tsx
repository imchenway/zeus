import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { Fragment, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';

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

function filterOptions<Value extends string>(options: readonly ComposerDropdownOption<Value>[], query: string): readonly ComposerDropdownOption<Value>[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => `${option.group ?? ''} ${option.label} ${option.searchText ?? ''} ${option.value}`.toLocaleLowerCase().includes(normalizedQuery));
}

export function ComposerDropdown<Value extends string>(props: ComposerDropdownProps<Value>) {
  const generatedId = useId();
  const menuId = `session-composer-dropdown-${generatedId.replaceAll(':', '')}`;
  const listboxId = `${menuId}-listbox`;
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const fallbackTriggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = props.triggerRef ?? fallbackTriggerRef;
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<Value, HTMLButtonElement>());
  const selectedOption = props.options.find((option) => option.value === props.value) ?? props.options[0];
  const searchable = props.searchable ?? props.options.length > 8;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeValue, setActiveValue] = useState<Value>(selectedOption?.value ?? props.value);
  const visibleOptions = useMemo(() => (searchable ? filterOptions(props.options, query) : props.options), [props.options, query, searchable]);

  useEffect(() => {
    if (props.disabled && open) setOpen(false);
  }, [open, props.disabled]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeFromOutside);
    return () => document.removeEventListener('pointerdown', closeFromOutside);
  }, [open]);

  useEffect(() => {
    if (!open || !searchable) return;
    searchRef.current?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (!open || searchable) return;
    const element = optionRefs.current.get(activeValue);
    element?.focus();
    element?.scrollIntoView({ block: 'nearest' });
  }, [activeValue, open, searchable]);

  useEffect(() => {
    if (visibleOptions.some((option) => option.value === activeValue)) return;
    setActiveValue(visibleOptions[0]?.value ?? props.value);
  }, [activeValue, props.value, visibleOptions]);

  function openMenu(nextValue = selectedOption?.value ?? props.value): void {
    if (props.disabled || props.options.length === 0) return;
    setQuery('');
    setActiveValue(nextValue);
    setOpen(true);
  }

  function closeMenu(restoreFocus = true): void {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function moveActive(delta: number): void {
    if (visibleOptions.length === 0) return;
    const currentIndex = visibleOptions.findIndex((option) => option.value === activeValue);
    const nextIndex = (Math.max(0, currentIndex) + delta + visibleOptions.length) % visibleOptions.length;
    const nextValue = visibleOptions[nextIndex]?.value;
    if (nextValue === undefined) return;
    setActiveValue(nextValue);
    requestAnimationFrame(() => optionRefs.current.get(nextValue)?.focus());
  }

  function selectOption(option: ComposerDropdownOption<Value>): void {
    closeMenu();
    if (option.value !== props.value) void props.onChange(option.value);
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(props.options.at(-1)?.value ?? props.value);
    } else if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      openMenu(event.key === 'Home' ? (props.options[0]?.value ?? props.value) : (props.options.at(-1)?.value ?? props.value));
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, option: ComposerDropdownOption<Value>): void {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const nextValue = event.key === 'Home' ? visibleOptions[0]?.value : visibleOptions.at(-1)?.value;
      if (nextValue !== undefined) {
        setActiveValue(nextValue);
        requestAnimationFrame(() => optionRefs.current.get(nextValue)?.focus());
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectOption(option);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const nextValue = event.key === 'ArrowDown' ? visibleOptions[0]?.value : visibleOptions.at(-1)?.value;
      if (nextValue !== undefined) {
        setActiveValue(nextValue);
        requestAnimationFrame(() => optionRefs.current.get(nextValue)?.focus());
      }
    } else if (event.key === 'Enter') {
      const activeOption = visibleOptions.find((option) => option.value === activeValue) ?? visibleOptions[0];
      if (activeOption && query.trim()) {
        event.preventDefault();
        selectOption(activeOption);
      }
    }
  }

  return (
    <span
      ref={rootRef}
      className={`session-composer-dropdown${props.className ? ` ${props.className}` : ''}`}
      data-dropdown-placement="top"
      data-open={open || undefined}
      data-value={props.value}
      data-icon-only={props.hideSelectedLabel || undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className="session-composer-dropdown-trigger"
        aria-label={props.triggerLabel ?? props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        title={props.title ?? props.triggerLabel}
        disabled={props.disabled}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        {props.triggerIcon ? (
          <span className="session-composer-dropdown-trigger-icon" aria-hidden="true">
            {props.triggerIcon}
          </span>
        ) : null}
        {props.hideSelectedLabel ? null : <span>{props.displayLabel ?? selectedOption?.label ?? props.value}</span>}
        <CaretDownIcon size={12} weight="regular" aria-hidden="true" />
      </button>
      <span id={menuId} className="session-composer-dropdown-menu" hidden={!open}>
        {searchable ? (
          <label className="session-composer-dropdown-search">
            <span className="sr-only">{props.searchPlaceholder ?? props.label}</span>
            <input ref={searchRef} type="search" aria-controls={listboxId} placeholder={props.searchPlaceholder ?? props.label} value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={handleSearchKeyDown} />
          </label>
        ) : null}
        <span id={listboxId} className="session-composer-dropdown-options" role="listbox" aria-label={props.label}>
          {visibleOptions.length > 0 ? (
            visibleOptions.map((option, index) => (
              <Fragment key={`${option.value}-${index}`}>
                {option.group && visibleOptions[index - 1]?.group !== option.group ? (
                  <span className="session-composer-dropdown-group" role="presentation">
                    {option.group}
                  </span>
                ) : null}
                <button
                  ref={(element) => {
                    if (element) optionRefs.current.set(option.value, element);
                    else optionRefs.current.delete(option.value);
                  }}
                  type="button"
                  className="session-composer-dropdown-option"
                  role="option"
                  aria-label={option.group ? `${option.group}: ${option.label}` : option.label}
                  aria-selected={option.value === props.value}
                  data-value={option.value}
                  tabIndex={open && option.value === activeValue ? 0 : -1}
                  onClick={() => selectOption(option)}
                  onKeyDown={(event) => handleOptionKeyDown(event, option)}
                >
                  {option.label}
                </button>
              </Fragment>
            ))
          ) : (
            <span className="session-composer-dropdown-empty" role="status">
              {props.emptyLabel ?? 'No matching options'}
            </span>
          )}
        </span>
      </span>
    </span>
  );
}
