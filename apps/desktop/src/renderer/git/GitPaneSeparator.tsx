import { useLayoutEffect, useRef, type PointerEvent } from 'react';

/** 同文档分隔条同步偏好；跨窗口由原生 storage 事件同步。 */
const paneSizeChangeEvent = 'zeus:git-pane-size-change';

/** 面板按名称共用尺寸偏好，支持比例和固定像素宽度。 */
export function GitPaneSeparator(props: {
  name: string;
  label: string;
  axis?: 'x' | 'y';
  /** 像素尺寸跨窗口保持相同宽度，比例用于等分阅读区。 */ unit?: 'px' | '%';
  initial: number;
  min?: number;
  max?: number;
  target?: string;
  /** 贴底或贴右的面板反向调整自身占比。 */ reverse?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const value = useRef(props.initial);
  const start = useRef<{ coordinate: number; value: number; size: number } | null>(null);
  const axis = props.axis ?? 'x';
  /** 保存值、拖动距离和 CSS 长度使用同一单位。 */
  const unit = props.unit ?? '%';
  /** 底部面板向上拖动时增大高度，读数仍表示面板自身占比。 */
  const direction = props.reverse ? -1 : 1;
  const minimum = props.min ?? 15;
  const maximum = props.max ?? 65;
  const storageKey = `zeus.git.panes.v1.${props.name}${unit === 'px' ? '.px' : ''}`;
  const container = () => (props.target ? element.current?.closest<HTMLElement>(props.target) : element.current?.parentElement);
  const apply = (next: number, save = false) => {
    value.current = Math.max(minimum, Math.min(maximum, next));
    container()?.style.setProperty(`--git-${props.name}`, `${value.current}${unit}`);
    element.current?.setAttribute('aria-valuenow', String(Math.round(value.current)));
    if (save) {
      try {
        /** 当前窗口立即同步同名面板，其他窗口读取同一个存储键。 */
        const ownerWindow = element.current?.ownerDocument.defaultView;
        ownerWindow?.localStorage.setItem(storageKey, String(value.current));
        ownerWindow?.dispatchEvent(new CustomEvent(paneSizeChangeEvent, { detail: { key: storageKey, value: value.current } }));
      } catch {
        /* 偏好存储不可用时继续允许拖拽。 */
      }
    }
  };
  useLayoutEffect(() => {
    let restored = props.initial;
    try {
      const saved = element.current?.ownerDocument.defaultView?.localStorage.getItem(storageKey);
      if (saved != null && Number.isFinite(Number(saved))) restored = Number(saved);
    } catch {
      /* 使用默认尺寸。 */
    }
    apply(restored);
    /** 监听所属窗口，系统门户不会误用主窗口的事件。 */
    const ownerWindow = element.current?.ownerDocument.defaultView;
    if (!ownerWindow) return;
    /** 外部更新不覆盖正在拖动的面板，也不回写存储形成循环。 */
    const sync = (next: number): void => {
      if (!start.current && Number.isFinite(next)) apply(next);
    };
    /** 其他窗口的拖动、键盘调整及重置都即时生效。 */
    const onStorage = (event: StorageEvent): void => {
      if (event.key === storageKey || event.key === null) sync(event.newValue === null ? props.initial : Number(event.newValue));
    };
    /** 同文档实例共享原保存值。 */
    const onLocalChange = (event: Event): void => {
      const detail = (event as CustomEvent<{ key: string; value: number }>).detail;
      if (detail?.key === storageKey) sync(detail.value);
    };
    ownerWindow.addEventListener('storage', onStorage);
    ownerWindow.addEventListener(paneSizeChangeEvent, onLocalChange);
    return () => {
      ownerWindow.removeEventListener('storage', onStorage);
      ownerWindow.removeEventListener(paneSizeChangeEvent, onLocalChange);
    };
  }, [storageKey, props.initial, minimum, maximum, props.target, unit]);
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
      data-icon-tooltip={`${props.label} · 双击恢复默认`}
      onDoubleClick={() => apply(props.initial, true)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const bounds = container()?.getBoundingClientRect();
        if (!bounds) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        element.current?.setAttribute('data-dragging', 'true');
        /** CSS 最小宽高可能限制保存比例；从当前可见分界开始，避免缩窗后拖动跳跃。 */
        const separatorBounds = event.currentTarget.getBoundingClientRect();
        const size = axis === 'x' ? bounds.width : bounds.height;
        const offset = axis === 'x' ? (props.reverse ? bounds.right - separatorBounds.right : separatorBounds.left - bounds.left) : props.reverse ? bounds.bottom - separatorBounds.bottom : separatorBounds.top - bounds.top;
        const actual = unit === 'px' ? offset : (offset / Math.max(1, size)) * 100;
        start.current = { coordinate: axis === 'x' ? event.clientX : event.clientY, value: actual, size };
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const delta = (axis === 'x' ? event.clientX : event.clientY) - start.current.coordinate;
        apply(start.current.value + direction * (unit === 'px' ? delta : (delta / Math.max(1, start.current.size)) * 100));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(event) => {
        const previous = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const next = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        if (event.key === previous || event.key === next) {
          event.preventDefault();
          apply(value.current + direction * (event.key === previous ? -1 : 1) * (unit === 'px' ? 16 : 2), true);
        } else if (event.key === 'Home' || event.key === 'Enter') {
          event.preventDefault();
          apply(props.initial, true);
        }
      }}
    />
  );
}
