import { createPortal } from 'react-dom';
import { PushPinIcon } from '@phosphor-icons/react/dist/csr/PushPin';
import { useMotionPresence } from './ui/useMotionPresence.js';

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';

export interface ZeusSelectOption<T extends string> {
  value: T;
  label: string;
  color?: string;
  disabled?: boolean;
  group?: string;
  searchText?: string;
  /** 置顶后仍显示来源，避免不同供应商的同名选项混淆。 */
  description?: string;
}

/** 可选的本机置顶偏好；相同存储键的选择入口共用顺序。 */
export interface ZeusSelectPinning {
  /** 持久化完整选项身份，不按显示名称合并。 */
  storageKey: string;
  /** 顶部分组标题。 */
  groupLabel: string;
  /** 置顶操作文案。 */
  pinLabel: string;
  /** 取消置顶操作文案。 */
  unpinLabel: string;
  /** 存储失败时的可见说明。 */
  saveErrorLabel: string;
}

export interface ZeusSelectProps<T extends string> {
  ariaLabel: string;
  ariaDescribedBy?: string;
  value: T;
  selectedValues?: readonly T[];
  options: readonly ZeusSelectOption<T>[];
  onChange: (value: T) => void;
  triggerLabel?: string;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
  triggerTitle?: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  hideSelectedLabel?: boolean;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  searchable?: boolean;
  popoverMinWidth?: number;
  /** 启用后使用包含选择与置顶按钮的对话框，避免在选项内嵌套按钮。 */
  pinning?: ZeusSelectPinning;
  /** 弹层的局部外观，不影响同一选择器的其他使用位置。 */
  popoverClassName?: string;
  /** 列表之外的标题和操作区域，清除操作不应作为可选值。 */
  header?: ReactNode;
  /** 列表之外的独立操作区域，例如筛选结果的显示开关。 */
  footer?: ReactNode;
  size: 'compact' | 'regular' | 'roomy';
}

interface ZeusSelectPopoverLayout {
  top: number;
  left: number;
  width: number;
  placement: 'top' | 'bottom';
}

const tabbableSelector = ['a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])', 'textarea:not([disabled])', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'].join(',');

/** 焦点立即转交，关闭后不留下可回到旧菜单的延迟任务。 */
function focusElement(element: HTMLElement | undefined): void {
  if (!element || typeof window === 'undefined') return;
  element.focus({ preventScroll: true });
}

/** 本机偏好按字符串数组读取；损坏或不可访问的存储不影响模型选择。 */
function readPinnedValues(storageKey: string): string[] {
  try {
    /** 外部存储只接受非空字符串身份，并去除重复记录。 */
    const values: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))] : [];
  } catch {
    return [];
  }
}

function filterSelectOptions<T extends string>(options: readonly ZeusSelectOption<T>[], query: string): readonly ZeusSelectOption<T>[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => `${option.group ?? ''} ${option.label} ${option.searchText ?? ''} ${option.value}`.toLocaleLowerCase().includes(normalizedQuery));
}

function parseCssPixel(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function measurePopoverContentWidth(popover: HTMLElement, maxWidth: number): number {
  const previousWidth = popover.style.width;
  const previousMinWidth = popover.style.minWidth;
  const previousMaxWidth = popover.style.maxWidth;
  const previousMeasuringState = popover.dataset.zeusSelectMeasuring;
  const labelMeasurements: Array<{ option: HTMLElement; clone: HTMLElement }> = [];
  popover.dataset.zeusSelectMeasuring = 'true';
  popover.style.width = 'max-content';
  popover.style.minWidth = '0px';
  popover.style.maxWidth = `${maxWidth}px`;

  try {
    for (const label of popover.querySelectorAll<HTMLElement>('.zeus-select-option-label')) {
      const option = label.closest<HTMLElement>('.zeus-select-option');
      if (!option) continue;
      const clone = label.cloneNode(true) as HTMLElement;
      clone.style.inlineSize = 'max-content';
      clone.style.maxInlineSize = 'none';
      clone.style.minInlineSize = 'max-content';
      clone.style.overflow = 'visible';
      clone.style.pointerEvents = 'none';
      clone.style.position = 'absolute';
      clone.style.textOverflow = 'clip';
      clone.style.visibility = 'hidden';
      clone.style.whiteSpace = 'nowrap';
      popover.appendChild(clone);
      labelMeasurements.push({ option, clone });
    }

    const popoverStyle = window.getComputedStyle(popover);
    const popoverHorizontalInset = parseCssPixel(popoverStyle.paddingInlineStart) + parseCssPixel(popoverStyle.paddingInlineEnd) + parseCssPixel(popoverStyle.borderInlineStartWidth) + parseCssPixel(popoverStyle.borderInlineEndWidth);
    const searchRow = popover.querySelector<HTMLElement>('.zeus-select-search-row');
    const searchMeasure = popover.querySelector<HTMLElement>('.zeus-select-search-width-measure');
    let searchRowWidth = 0;
    if (searchRow && searchMeasure) {
      const searchRowStyle = window.getComputedStyle(searchRow);
      const searchIcon = searchRow.querySelector<HTMLElement>('.zeus-select-search-icon');
      const firstGridTrack = searchRowStyle.gridTemplateColumns.split(' ')[0];
      const searchIconWidth = Math.max(searchIcon?.getBoundingClientRect().width ?? 0, parseCssPixel(firstGridTrack));
      searchRowWidth = parseCssPixel(searchRowStyle.paddingInlineStart) + parseCssPixel(searchRowStyle.paddingInlineEnd) + searchIconWidth + parseCssPixel(searchRowStyle.columnGap) + searchMeasure.getBoundingClientRect().width;
    }
    let optionWidth = 0;
    for (const { option, clone } of labelMeasurements) {
      const optionStyle = window.getComputedStyle(option);
      const hasColor = option.querySelector('.zeus-select-option-color') !== null;
      const markerWidth = hasColor ? 10 : 0;
      // 标记可在文字前后展示，宽度不再依赖最后一列的位置。
      const checkWidth = Math.max(16, option.querySelector('.zeus-select-option-check')?.getBoundingClientRect().width ?? 0);
      const gapCount = hasColor ? 2 : 1;
      /** 置顶按钮占据独立列，测量时为图钉和列间距预留空间。 */
      const pinWidth = option.parentElement?.classList.contains('zeus-select-option-row') ? 32 : 0;
      const rowWidth =
        parseCssPixel(optionStyle.paddingInlineStart) + parseCssPixel(optionStyle.paddingInlineEnd) + markerWidth + checkWidth + parseCssPixel(optionStyle.columnGap) * gapCount + clone.getBoundingClientRect().width + pinWidth;
      optionWidth = Math.max(optionWidth, rowWidth);
    }
    const measuredWidth = popover.getBoundingClientRect().width;
    return Math.min(Math.max(measuredWidth, optionWidth + popoverHorizontalInset, searchRowWidth + popoverHorizontalInset), maxWidth);
  } finally {
    for (const { clone } of labelMeasurements) clone.remove();
    popover.style.width = previousWidth;
    popover.style.minWidth = previousMinWidth;
    popover.style.maxWidth = previousMaxWidth;
    if (previousMeasuringState === undefined) delete popover.dataset.zeusSelectMeasuring;
    else popover.dataset.zeusSelectMeasuring = previousMeasuringState;
  }
}

export function ZeusSelect<T extends string>(props: ZeusSelectProps<T>) {
  const generatedId = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const fallbackTriggerRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = props.triggerRef ?? fallbackTriggerRef;
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<T, HTMLButtonElement>());
  const popoverContentWidthRef = useRef(0);
  const enabledOptions = useMemo(() => props.options.filter((option) => !option.disabled), [props.options]);
  const selectedValues = useMemo(() => new Set(props.selectedValues), [props.selectedValues]);
  const multiple = props.selectedValues !== undefined;
  const searchable = props.searchable ?? props.options.length > 8;
  const selectedOption = props.options.find((option) => option.value === props.value);
  const [open, setOpen] = useState(false);
  /** 下拉关闭立即结束交互，视觉内容在退出过渡结束后卸载。 */
  const { ref: popoverRef, present: popoverPresent } = useMotionPresence<HTMLSpanElement>(open);
  const [activeValue, setActiveValue] = useState<T>(props.value);
  const [query, setQuery] = useState('');
  /** 每次打开重新读取，其他模型入口的最新置顶立即可见。 */
  const [pinnedValues, setPinnedValues] = useState<string[]>([]);
  /** 只有持久化成功才更新置顶状态。 */
  const [pinSaveFailed, setPinSaveFailed] = useState(false);
  const [popoverLayout, setPopoverLayout] = useState<ZeusSelectPopoverLayout | null>(null);
  /** 已不可用的身份只保留偏好，不重新插入当前可选目录。 */
  const pinnedOptions = useMemo(() => {
    if (!props.pinning) return [];
    /** 按完整身份索引当前目录，置顶数量增加时也只遍历一遍模型。 */
    const optionsByValue = new Map<string, ZeusSelectOption<T>>(props.options.filter((option) => !option.disabled).map((option) => [option.value, option]));
    return pinnedValues.flatMap((value) => optionsByValue.get(value) ?? []);
  }, [pinnedValues, props.options, props.pinning]);
  /** 置顶项只出现一次，未置顶项沿用业务原有分组顺序。 */
  const orderedOptions = useMemo(() => [...pinnedOptions, ...props.options.filter((option) => !pinnedOptions.includes(option))], [pinnedOptions, props.options]);
  const visibleOptions = useMemo(() => (searchable ? filterSelectOptions(orderedOptions, query) : orderedOptions), [orderedOptions, query, searchable]);
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
      if (popoverRef.current?.contains(element) || element.hidden || element.closest('[inert], [aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(element);
      return element.checkVisibility() && style.display !== 'none' && style.visibility !== 'hidden' && element.getAttribute('aria-disabled') !== 'true';
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
    /** 模型长名称截断显示，避免单个长名称把菜单撑成横跨页面的大面板。 */
    const maxWidth = Math.max(0, Math.min(window.innerWidth - viewportPadding * 2, props.pinning ? 360 : Number.POSITIVE_INFINITY));
    if (popoverRef.current) {
      popoverContentWidthRef.current = Math.max(popoverContentWidthRef.current, measurePopoverContentWidth(popoverRef.current, maxWidth));
    }
    const width = Math.min(Math.max(triggerRect.width, props.popoverMinWidth ?? 0, popoverContentWidthRef.current), maxWidth);
    const left = Math.min(Math.max(triggerRect.left, viewportPadding), Math.max(viewportPadding, window.innerWidth - width - viewportPadding));
    const popoverHeight = popoverRef.current?.offsetHeight ?? 0;
    const bottomTop = triggerRect.bottom + popoverGap;
    const availableBottomHeight = Math.max(0, window.innerHeight - bottomTop - viewportPadding);
    const placement = popoverHeight > 0 && popoverHeight > availableBottomHeight ? 'top' : 'bottom';
    const top = Math.max(viewportPadding, placement === 'top' ? triggerRect.top - popoverGap - popoverHeight : bottomTop);
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
  }, [props.popoverMinWidth, props.pinning]);

  const closeListbox = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) focusElement(triggerRef.current ?? undefined);
  };

  const openListbox = (nextActiveValue = props.value) => {
    if (props.disabled || enabledOptions.length === 0) return;
    const resolvedActiveValue = enabledOptions.some((option) => option.value === nextActiveValue) ? nextActiveValue : enabledOptions[0]?.value;
    if (resolvedActiveValue === undefined) return;
    setQuery('');
    if (props.pinning) setPinnedValues(readPinnedValues(props.pinning.storageKey));
    setPinSaveFailed(false);
    setActiveValue(resolvedActiveValue);
    popoverContentWidthRef.current = 0;
    setPopoverLayout(null);
    setOpen(true);
    // 长列表优先聚焦搜索；任务工具栏这类短列表直接聚焦选项，避免顶部搜索灰区抢占视觉。
    focusElement(searchable ? (searchRef.current ?? undefined) : (optionRefs.current.get(resolvedActiveValue) ?? undefined));
  };

  const selectOption = (value: T) => {
    props.onChange(value);
    setActiveValue(value);
    if (!multiple) closeListbox();
  };

  /** 置顶只保存显示偏好，不触发模型切换，也不关闭浮层。 */
  const togglePin = (option: ZeusSelectOption<T>, button: HTMLButtonElement) => {
    if (!props.pinning || !option.value || option.disabled) return;
    /** 写入前读取最新偏好，保留其他入口或项目中暂不可见的置顶。 */
    const current = readPinnedValues(props.pinning.storageKey);
    /** 新置顶排在末尾，已有置顶的相对顺序保持稳定。 */
    const next = current.includes(option.value) ? current.filter((value) => value !== option.value) : [...current, option.value];
    try {
      window.localStorage.setItem(props.pinning.storageKey, JSON.stringify(next));
      setPinnedValues(next);
      setPinSaveFailed(false);
      window.requestAnimationFrame(() => {
        button.focus({ preventScroll: true });
        // 新置顶先展示顶部分组；大量置顶时仍确保当前图钉处于可见区域。
        if (next.includes(option.value)) popoverRef.current?.querySelector('.zeus-select-listbox')?.scrollTo({ top: 0 });
        button.scrollIntoView({ block: 'nearest' });
      });
    } catch {
      setPinSaveFailed(true);
    }
  };

  /** 顶部操作、选项、置顶与底部开关共用 Tab 顺序；离开边界时回到原页面。 */
  const handlePopoverKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if ((!props.pinning && !props.header && !props.footer) || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeListbox();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      /** 普通列表保留单焦点导航，置顶对话框保留每个可用按钮的停靠点。 */
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(tabbableSelector)).filter((element) => element.tabIndex >= 0 && !element.matches(':disabled, [aria-disabled="true"]') && element.checkVisibility());
      /** 当前焦点可能落在控件内部，按所属控件计算前后顺序。 */
      const index = controls.findIndex((element) => element.contains(event.target as Node));
      /** 移动方向沿用浏览器的 Tab 与 Shift+Tab 约定。 */
      const direction = event.shiftKey ? -1 : 1;
      /** 到达边界才关闭，列表与独立操作之间可以连续切换。 */
      const next = index >= 0 ? controls[index + direction] : undefined;
      if (next) focusElement(next);
      else {
        closeListbox(false);
        if (!focusAdjacentTabStop(direction)) focusElement(triggerRef.current ?? undefined);
      }
    }
  };

  const moveActiveOption = (direction: 1 | -1 | 'first' | 'last') => {
    if (enabledVisibleOptions.length === 0) return;
    const currentIndex = enabledVisibleOptions.findIndex((option) => option.value === activeValue);
    const nextIndex = direction === 'first' ? 0 : direction === 'last' ? enabledVisibleOptions.length - 1 : Math.min(Math.max(currentIndex + direction, 0), enabledVisibleOptions.length - 1);
    const nextValue = enabledVisibleOptions[nextIndex]?.value;
    if (nextValue === undefined) return;
    setActiveValue(nextValue);
    focusOption(nextValue);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
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
      event.stopPropagation();
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
    } else if (event.key === 'Tab' && !props.pinning && !props.header && !props.footer) {
      event.preventDefault();
      closeListbox(false);
      if (!focusAdjacentTabStop(event.shiftKey ? -1 : 1)) focusElement(triggerRef.current ?? undefined);
    }
  };

  const handleSearchChange = (value: string) => {
    setQuery(value);
    const nextVisibleOptions = filterSelectOptions(orderedOptions, value).filter((option) => !option.disabled);
    const selectedVisibleOption = nextVisibleOptions.find((option) => option.value === props.value);
    setActiveValue(selectedVisibleOption?.value ?? nextVisibleOptions[0]?.value ?? props.value);
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeListbox();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextValue = enabledVisibleOptions.find((option) => option.value === activeValue)?.value ?? enabledVisibleOptions[0]?.value;
      if (nextValue !== undefined) {
        setActiveValue(nextValue);
        focusOption(nextValue);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const nextValue = enabledVisibleOptions.at(-1)?.value;
      if (nextValue !== undefined) {
        setActiveValue(nextValue);
        focusOption(nextValue);
      }
    } else if (event.key === 'Enter') {
      const activeOption = enabledVisibleOptions.find((option) => option.value === activeValue);
      if (activeOption && query.trim()) {
        event.preventDefault();
        selectOption(activeOption.value);
      }
    } else if (event.key === 'Tab' && !props.pinning && !props.header && !props.footer) {
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
  }, [open, searchPlaceholder, searchable, syncPopoverLayout, visibleOptions]);

  // 只在打开时自动聚焦；方向键移动后不能把焦点抢回搜索框。
  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    // 选项已挂载即可聚焦，避免旧帧在关闭后把焦点带回退出中的菜单。
    focusElement(searchable ? (searchRef.current ?? undefined) : (optionRefs.current.get(activeValue) ?? undefined));
  }, [open, searchable]);
  useEffect(() => {
    setActiveValue(props.value);
  }, [props.value]);

  useEffect(() => {
    if (!open) return;
    if (enabledVisibleOptions.some((option) => option.value === activeValue)) return;
    setActiveValue(enabledVisibleOptions[0]?.value ?? props.value);
  }, [activeValue, enabledVisibleOptions, open, props.value]);

  const portalHost = typeof document === 'undefined' ? null : (rootRef.current?.closest('.macos-ai-app') ?? document.body);
  const popover = popoverPresent ? (
    <span className={portalHost === document.body ? 'macos-ai-app zeus-select-portal-root' : 'zeus-select-portal-root'} data-zeus-primitive="select-popover" data-control-size={props.size} inert={!open} aria-hidden={!open}>
      <span
        ref={popoverRef}
        id={props.pinning ? `${rootId}-dialog` : undefined}
        role={props.pinning ? 'dialog' : undefined}
        aria-label={props.pinning ? props.ariaLabel : undefined}
        className={`zeus-select-popover${props.popoverClassName ? ` ${props.popoverClassName}` : ''}`}
        data-pinnable={props.pinning ? 'true' : undefined}
        onKeyDown={handlePopoverKeyDown}
        data-motion-surface="popover"
        data-motion-state={open ? 'open' : 'closing'}
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
        {props.header ? <span className="zeus-select-header">{props.header}</span> : null}
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
            <span className="zeus-select-search-width-measure" aria-hidden="true">
              {searchPlaceholder}
            </span>
          </span>
        ) : null}
        {pinSaveFailed ? (
          <span className="zeus-select-empty" role="alert">
            {props.pinning?.saveErrorLabel}
          </span>
        ) : null}
        <span id={listboxId} className="zeus-select-listbox" role={props.pinning ? 'list' : 'listbox'} aria-label={props.ariaLabel} aria-multiselectable={(!props.pinning && multiple) || undefined}>
          {visibleOptions.length > 0 ? (
            visibleOptions.map((option, index) => {
              const selected = multiple ? selectedValues.has(option.value) : option.value === props.value;
              /** 置顶区与供应商区分开判断，避免名称碰巧相同时合并标题。 */
              const pinned = pinnedOptions.includes(option);
              /** 跨供应商置顶使用统一标题，来源仍显示在模型名称下面。 */
              const group = pinned ? props.pinning?.groupLabel : option.group;
              /** 操作文案包含来源，读屏与悬停均能区分同名模型。 */
              const optionLabel = `${option.description ?? option.group ?? ''} ${option.label}`.trim();
              return (
                <Fragment key={option.value}>
                  {group && (index === 0 || pinned !== pinnedOptions.includes(visibleOptions[index - 1]!) || (!pinned && visibleOptions[index - 1]?.group !== group)) ? (
                    <span className="zeus-select-option-group" role="presentation">
                      {pinned ? <PushPinIcon size={12} weight="fill" aria-hidden="true" /> : null}
                      {group}
                    </span>
                  ) : null}
                  <span className={props.pinning ? 'zeus-select-option-row' : undefined} role={props.pinning ? 'listitem' : 'presentation'}>
                    <button
                      ref={(element) => {
                        if (element) optionRefs.current.set(option.value, element);
                        else optionRefs.current.delete(option.value);
                      }}
                      id={`${listboxId}-option-${index}`}
                      type="button"
                      className="zeus-select-option"
                      role={props.pinning ? undefined : 'option'}
                      aria-label={optionLabel}
                      aria-selected={props.pinning ? undefined : selected}
                      aria-pressed={props.pinning ? selected : undefined}
                      data-selected={selected}
                      tabIndex={open && (props.pinning || option.value === activeValue) ? 0 : -1}
                      disabled={option.disabled}
                      data-value={option.value}
                      title={optionLabel}
                      onFocus={() => setActiveValue(option.value)}
                      onClick={() => selectOption(option.value)}
                      onKeyDown={(event) => handleOptionKeyDown(event, option)}
                    >
                      {option.color ? <span className="zeus-select-option-color" style={{ backgroundColor: option.color }} aria-hidden="true" /> : null}
                      <span className="zeus-select-option-label">
                        {option.label}
                        {option.description || (pinned && option.group) ? <small className="zeus-select-option-description">{option.description ?? option.group}</small> : null}
                      </span>
                      <span className="zeus-select-option-check" aria-hidden="true">
                        {selected ? '✓' : ''}
                      </span>
                    </button>
                    {props.pinning && option.value && !option.disabled ? (
                      <button
                        type="button"
                        className="zeus-select-pin"
                        aria-label={`${pinned ? props.pinning.unpinLabel : props.pinning.pinLabel} ${optionLabel}`}
                        title={pinned ? props.pinning.unpinLabel : props.pinning.pinLabel}
                        aria-pressed={pinned}
                        onClick={(event) => togglePin(option, event.currentTarget)}
                      >
                        <PushPinIcon size={15} weight={pinned ? 'fill' : 'regular'} aria-hidden="true" />
                      </button>
                    ) : null}
                  </span>
                </Fragment>
              );
            })
          ) : (
            <span className="zeus-select-empty" role="status">
              {emptyLabel}
            </span>
          )}
        </span>
        {props.footer ? <span className="zeus-select-footer">{props.footer}</span> : null}
      </span>
    </span>
  ) : null;

  return (
    <span
      className={props.className ? `zeus-select ${props.className}` : 'zeus-select'}
      data-zeus-primitive="select"
      data-zeus-select-placement={open ? (popoverLayout?.placement ?? 'bottom') : 'bottom'}
      data-control-size={props.size}
      data-open={open || undefined}
      data-value={props.value}
      data-icon-only={props.hideSelectedLabel || undefined}
      style={props.style}
      ref={rootRef}
    >
      {/* 触发器只保留在业务布局中；popover 通过 portal 提升到应用壳层，禁止扩大表单滚动区域。 */}
      <button
        ref={triggerRef}
        type="button"
        className={props.triggerClassName ? `zeus-select-trigger ${props.triggerClassName}` : 'zeus-select-trigger'}
        role={props.pinning ? undefined : 'combobox'}
        aria-label={props.ariaLabel}
        aria-describedby={props.ariaDescribedBy}
        aria-haspopup={props.pinning ? 'dialog' : 'listbox'}
        aria-expanded={open}
        aria-controls={props.pinning ? `${rootId}-dialog` : listboxId}
        aria-activedescendant={open && !props.pinning ? activeOptionId : undefined}
        title={props.triggerTitle}
        disabled={props.disabled}
        onClick={() => (open ? closeListbox(false) : openListbox(props.value))}
        onKeyDown={handleTriggerKeyDown}
      >
        {props.triggerIcon ? (
          <span className="zeus-select-trigger-icon" aria-hidden="true">
            {props.triggerIcon}
          </span>
        ) : null}
        {selectedOption?.color ? <span className="zeus-select-value-color" style={{ backgroundColor: selectedOption.color }} aria-hidden="true" /> : null}
        {props.hideSelectedLabel ? null : <span className="zeus-select-value">{props.triggerLabel ?? selectedOption?.label ?? props.value}</span>}
        <span className="zeus-select-chevron" aria-hidden="true" />
      </button>
      {popover && portalHost ? createPortal(popover, portalHost) : popover}
    </span>
  );
}
