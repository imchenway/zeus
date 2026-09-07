import { useLayoutEffect, useRef, type PointerEvent } from 'react';

/** 尺寸按比例保存；窗口缩放后仍保留可用的内容区域。 */
export function GitPaneSeparator(props: { name: string; label: string; axis?: 'x' | 'y'; initial: number; min?: number; max?: number; target?: string }) {
  const element = useRef<HTMLDivElement>(null);
  const value = useRef(props.initial);
  const start = useRef<{ coordinate: number; value: number; size: number } | null>(null);
  const axis = props.axis ?? 'x';
  const minimum = props.min ?? 15;
  const maximum = props.max ?? 65;
  const storageKey = `zeus.git.panes.v1.${props.name}`;
  const container = () => (props.target ? element.current?.closest<HTMLElement>(props.target) : element.current?.parentElement);
  const apply = (next: number, save = false) => {
    value.current = Math.max(minimum, Math.min(maximum, next));
    container()?.style.setProperty(`--git-${props.name}`, `${value.current}%`);
    element.current?.setAttribute('aria-valuenow', String(Math.round(value.current)));
    if (save) {
      try {
        localStorage.setItem(storageKey, String(value.current));
      } catch {
        /* 偏好存储不可用时继续允许拖拽。 */
      }
    }
  };
  useLayoutEffect(() => {
    let restored = props.initial;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null && Number.isFinite(Number(saved))) restored = Number(saved);
    } catch {
      /* 使用默认尺寸。 */
    }
    apply(restored);
  }, [storageKey, props.initial, minimum, maximum, props.target]);
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    element.current?.removeAttribute('data-dragging');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    apply(value.current, true);
  };
  return (
    <div
      ref={element}
      className={`git-pane-separator is-${axis} git-separator-${props.name}`}
      role="separator"
      tabIndex={0}
      aria-label={props.label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={props.initial}
      title={`${props.label} · 双击恢复默认`}
      onDoubleClick={() => apply(props.initial, true)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const bounds = container()?.getBoundingClientRect();
        if (!bounds) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        element.current?.setAttribute('data-dragging', 'true');
        start.current = { coordinate: axis === 'x' ? event.clientX : event.clientY, value: value.current, size: axis === 'x' ? bounds.width : bounds.height };
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const delta = (axis === 'x' ? event.clientX : event.clientY) - start.current.coordinate;
        apply(start.current.value + (delta / Math.max(1, start.current.size)) * 100);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(event) => {
        const previous = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const next = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        if (event.key === previous || event.key === next) {
          event.preventDefault();
          apply(value.current + (event.key === previous ? -2 : 2), true);
        } else if (event.key === 'Home' || event.key === 'Enter') {
          event.preventDefault();
          apply(props.initial, true);
        }
      }}
    />
  );
}
