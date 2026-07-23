import {CaretDownIcon} from '@phosphor-icons/react/dist/csr/CaretDown';
import {type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState} from 'react';

export interface ComposerDropdownOption<Value extends string = string> {
    value: Value;
    label: string;
}

export interface ComposerDropdownProps<Value extends string = string> {
    label: string;
    value: Value;
    options: readonly ComposerDropdownOption<Value>[];
    disabled?: boolean;
    title?: string;
    className?: string;
    triggerRef?: RefObject<HTMLButtonElement | null>;
    onChange: (value: Value) => void | Promise<void>;
}

export function ComposerDropdown<Value extends string>(props: ComposerDropdownProps<Value>) {
    const generatedId = useId();
    const menuId = `session-composer-dropdown-${generatedId.replaceAll(':', '')}`;
    const rootRef = useRef<HTMLSpanElement | null>(null);
    const fallbackTriggerRef = useRef<HTMLButtonElement | null>(null);
    const triggerRef = props.triggerRef ?? fallbackTriggerRef;
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const selectedIndex = Math.max(
        0,
        props.options.findIndex((option) => option.value === props.value),
    );
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(selectedIndex);
    const selectedOption = props.options[selectedIndex] ?? props.options[0];

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
        if (!open) return;
        optionRefs.current[activeIndex]?.focus();
        optionRefs.current[activeIndex]?.scrollIntoView({block: 'nearest'});
    }, [activeIndex, open]);

    function openMenu(index = selectedIndex): void {
        if (props.disabled || props.options.length === 0) return;
        setActiveIndex(index);
        setOpen(true);
    }

    function closeMenu(restoreFocus = true): void {
        setOpen(false);
        if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
    }

    function moveActive(delta: number): void {
        if (props.options.length === 0) return;
        setActiveIndex((current) => (current + delta + props.options.length) % props.options.length);
    }

    function selectOption(option: ComposerDropdownOption<Value>): void {
        closeMenu();
        if (option.value !== props.value) void props.onChange(option.value);
    }

    function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu(selectedIndex === 0 ? props.options.length - 1 : selectedIndex - 1);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu(Math.min(selectedIndex + 1, props.options.length - 1));
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            openMenu(event.key === 'Home' ? 0 : props.options.length - 1);
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
            setActiveIndex(event.key === 'Home' ? 0 : props.options.length - 1);
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

    return (
        <span ref={rootRef} className={`session-composer-dropdown${props.className ? ` ${props.className}` : ''}`}
              data-dropdown-placement="top" data-open={open || undefined}>
      <button
          ref={triggerRef}
          type="button"
          className="session-composer-dropdown-trigger"
          aria-label={props.label}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={menuId}
          title={props.title}
          disabled={props.disabled}
          onClick={() => (open ? closeMenu(false) : openMenu())}
          onKeyDown={handleTriggerKeyDown}
      >
        <span>{selectedOption?.label ?? props.value}</span>
        <CaretDownIcon size={12} weight="regular" aria-hidden="true"/>
      </button>
      <span id={menuId} className="session-composer-dropdown-menu" role="listbox" aria-label={props.label}
            hidden={!open}>
        {props.options.map((option, index) => (
            <button
                key={option.value}
                ref={(element) => {
                    optionRefs.current[index] = element;
                }}
                type="button"
                role="option"
                aria-selected={option.value === props.value}
                data-value={option.value}
                tabIndex={open && index === activeIndex ? 0 : -1}
                onClick={() => selectOption(option)}
                onKeyDown={(event) => handleOptionKeyDown(event, option)}
            >
                {option.label}
            </button>
        ))}
      </span>
    </span>
    );
}
