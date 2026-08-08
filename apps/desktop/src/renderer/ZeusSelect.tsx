import { createPortal } from 'react-dom';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface ZeusSelectOption<T extends string> {
  value: T;
  label: string;
  color?: string;
  disabled?: boolean;
  group?: string;
}

export interface ZeusSelectProps<T extends string> {
  ariaLabel: string;
  ariaDescribedBy?: string;
  value: T;
  options: readonly ZeusSelectOption<T>[];
  onChange: (value: T) => void;
  triggerLabel?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  searchable?: boolean;
  popoverMinWidth?: number;
  size: 'compact' | 'regular' | 'roomy';
}

interface ZeusSelectPopoverLayout {
  top: number;
  left: number;
  width: number;
  placement: 'top' | 'bottom';
}

const tabbableSelector = ['a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])', 'textarea:not([disabled])', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'].join(',');

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
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<T, HTMLButtonElement>());
  const enabledOptions = useMemo(() => props.options.filter((option) => !option.disabled), [props.options]);
  const searchable = props.searchable ?? props.options.length > 8;
  const selectedOption = props.options.find((option) => option.value === props.value) ?? props.options[0];
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<T>(props.value);
  const [query, setQuery] = useState('');
  const [popoverLayout, setPopoverLayout] = useState<ZeusSelectPopoverLayout | null>(null);
  const visibleOptions = useMemo(() => (searchable ? filterSelectOptions(props.options, query) : props.options), [props.options, query, searchable]);
  const enabledVisibleOptions = useMemo(() => visibleOptions.filter((option) => !option.disabled), [visibleOptions]);
  const rootId = `zeus-select-${generatedId}`;
  const listboxId = `${rootId}-listbox`;
  const activeOptionIndex = visibleOptions.findIndex((option) => option.value === activeValue);
  const activeOptionId = activeOptionIndex >= 0 ? `${listboxId}-option-${activeOptionIndex}` : undefined;
  const searchPlaceholder = props.searchPlaceholder ?? props.ariaLabel;
  const emptyLabel = props.emptyLabel ?? 'No matching options';

  const focusOption = (value: T) => focusElement(optionRefs.current.get(value));

  const focusAdjacentTabStop = (direction: 1 | -1): boolean => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return false;
    const tabbableElements = Array.from(trigger.ownerDocument.querySelectorAll<HTMLElement>(tabbableSelector)).filter((element) => {
      if (popoverRef.current?.contains(element) || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    const triggerIndex = tabbableElements.indexOf(trigger);
    const nextElement = triggerIndex >= 0 ? tabbableElements[triggerIndex + direction] : undefined;
    if (!nextElement) return false;
    focusElement(nextElement);
    return true;
  };

  const syncPopoverLayout = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const popoverGap = 6;
    const width = Math.min(Math.max(triggerRect.width, props.popoverMinWidth ?? 0), Math.max(0, window.innerWidth - viewportPadding * 2));
    const left = Math.min(Math.max(triggerRect.left, viewportPadding), Math.max(viewportPadding, window.innerWidth - width - viewportPadding));
    const popoverHeight = popoverRef.current?.offsetHeight ?? 0;
    const bottomTop = triggerRect.bottom + popoverGap;
    const availableBottomHeight = Math.max(0, window.innerHeight - bottomTop - viewportPadding);
    const placement = popoverHeight > 0 && popoverHeight > availableBottomHeight ? 'top' : 'bottom';
    const top = placement === 'top' ? triggerRect.top - popoverGap - popoverHeight : bottomTop;
    const nextLayout: ZeusSelectPopoverLayout = {
      top,
      left,
      width,
      placement,
    };
    setPopoverLayout((currentLayout) => {
      if (currentLayout?.top === nextLayout.top && currentLayout.left === nextLayout.left && currentLayout.width === nextLayout.width && currentLayout.placement === nextLayout.placement) {
        return currentLayout;
      }
      return nextLayout;
    });
  }, [props.popoverMinWidth]);

  const closeListbox = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) focusElement(triggerRef.current ?? undefined);
  };

  const openListbox = (nextActiveValue = props.value) => {
    if (props.disabled || enabledOptions.length === 0) return;
    const resolvedActiveValue = enabledOptions.some((option) => option.value === nextActiveValue) ? nextActiveValue : enabledOptions[0]?.value;
    if (!resolvedActiveValue) return;
    setQuery('');
    setActiveValue(resolvedActiveValue);
    syncPopoverLayout();
    setOpen(true);
    // 长列表优先聚焦搜索；任务工具栏这类短列表直接聚焦选项，避免顶部搜索灰区抢占视觉。
    focusElement(searchable ? (searchRef.current ?? undefined) : (optionRefs.current.get(resolvedActiveValue) ?? undefined));
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
    if (open && event.key === 'Escape') {
      event.preventDefault();
      closeListbox();
    } else if (open && event.key === 'Tab') {
      event.preventDefault();
      closeListbox(false);
      if (!focusAdjacentTabStop(event.shiftKey ? -1 : 1)) focusElement(triggerRef.current ?? undefined);
    } else if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
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
      event.preventDefault();
      closeListbox(false);
      if (!focusAdjacentTabStop(event.shiftKey ? -1 : 1)) focusElement(triggerRef.current ?? undefined);
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
      event.preventDefault();
      closeListbox(false);
      if (!focusAdjacentTabStop(event.shiftKey ? -1 : 1)) focusElement(triggerRef.current ?? undefined);
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (rootRef.current?.contains(event.target) || popoverRef.current?.contains(event.target))) return;
      closeListbox(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointerDown, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointerDown, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    syncPopoverLayout();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncPopoverLayout);
    if (triggerRef.current) resizeObserver?.observe(triggerRef.current);
    if (popoverRef.current) resizeObserver?.observe(popoverRef.current);
    window.addEventListener('resize', syncPopoverLayout);
    document.addEventListener('scroll', syncPopoverLayout, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', syncPopoverLayout);
      document.removeEventListener('scroll', syncPopoverLayout, true);
    };
  }, [open, syncPopoverLayout]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    const animationFrame = window.requestAnimationFrame(() => {
      focusElement(searchable ? (searchRef.current ?? undefined) : (optionRefs.current.get(activeValue) ?? undefined));
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeValue, open, searchable]);

  useEffect(() => {
    setActiveValue(props.value);
  }, [props.value]);

  useEffect(() => {
    if (!open) return;
    if (enabledVisibleOptions.some((option) => option.value === activeValue)) return;
    setActiveValue(enabledVisibleOptions[0]?.value ?? props.value);
  }, [activeValue, enabledVisibleOptions, open, props.value]);

  const portalHost = typeof document === 'undefined' ? null : (rootRef.current?.closest('.macos-ai-app') ?? document.body);
  const popover = open ? (
    <span className={portalHost === document.body ? 'macos-ai-app zeus-select-portal-root' : 'zeus-select-portal-root'} data-zeus-primitive="select-popover" data-control-size={props.size}>
      <span
        ref={popoverRef}
        className="zeus-select-popover"
        data-motion-surface="popover"
        data-zeus-select-placement={popoverLayout?.placement ?? 'bottom'}
        style={
          popoverLayout
            ? {
                top: popoverLayout.top,
                left: popoverLayout.left,
                width: popoverLayout.width,
              }
            : { visibility: 'hidden' }
        }
      >
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
              <Fragment key={`${option.value || 'empty'}-${index}`}>
                {option.group && visibleOptions[index - 1]?.group !== option.group ? (
                  <span className="zeus-select-option-group" role="presentation">
                    {option.group}
                  </span>
                ) : null}
                <button
                  ref={(element) => {
                    if (element) optionRefs.current.set(option.value, element);
                    else optionRefs.current.delete(option.value);
                  }}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  className="zeus-select-option"
                  role="option"
                  aria-label={option.group ? `${option.group}: ${option.label}` : option.label}
                  aria-selected={option.value === props.value}
                  tabIndex={open && option.value === activeValue ? 0 : -1}
                  disabled={option.disabled}
                  data-value={option.value}
                  onClick={() => selectOption(option.value)}
                  onKeyDown={(event) => handleOptionKeyDown(event, option)}
                >
                  {option.color ? <span className="zeus-select-option-color" style={{ backgroundColor: option.color }} aria-hidden="true" /> : null}
                  <span className="zeus-select-option-label">{option.label}</span>
                  <span className="zeus-select-option-check" aria-hidden="true">
                    {option.value === props.value ? '✓' : ''}
                  </span>
                </button>
              </Fragment>
            ))
          ) : (
            <span className="zeus-select-empty" role="status">
              {emptyLabel}
            </span>
          )}
        </span>
      </span>
    </span>
  ) : null;

  return (
    <span
      className={props.className ? `zeus-select ${props.className}` : 'zeus-select'}
      data-zeus-primitive="select"
      data-zeus-select-placement={open ? (popoverLayout?.placement ?? 'bottom') : 'bottom'}
      data-control-size={props.size}
      style={props.style}
      ref={rootRef}
    >
      {/* 触发器只保留在业务布局中；popover 通过 portal 提升到应用壳层，禁止扩大表单滚动区域。 */}
      <button
        ref={triggerRef}
        type="button"
        className="zeus-select-trigger"
        role="combobox"
        aria-label={props.ariaLabel}
        aria-describedby={props.ariaDescribedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? activeOptionId : undefined}
        disabled={props.disabled}
        onClick={() => (open ? closeListbox(false) : openListbox(props.value))}
        onKeyDown={handleTriggerKeyDown}
      >
        {selectedOption?.color ? <span className="zeus-select-value-color" style={{ backgroundColor: selectedOption.color }} aria-hidden="true" /> : null}
        <span className="zeus-select-value">{props.triggerLabel ?? selectedOption?.label ?? props.value}</span>
        <span className="zeus-select-chevron" aria-hidden="true" />
      </button>
      {popover && portalHost ? createPortal(popover, portalHost) : popover}
    </span>
  );
}
