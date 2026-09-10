import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useId, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationNavigationEntry, ConversationNavigationSnapshot } from '@zeus/shared';
import { useMotionPresence } from '../ui/useMotionPresence.js';

/** 目录条目附带当前正文行身份；未加载的条目使用同一身份占位。 */
export interface TranscriptNavigationEntry extends ConversationNavigationEntry {
  /** 与虚拟列表共享的稳定身份。 */
  rowKey: string;
  /** 真实用户消息是否已经进入正文投影。 */
  loaded: boolean;
}

/** 从发送到历史恢复沿用客户端身份，缺失时才使用模型或持久身份。 */
export function navigationRowKey(entry: Pick<ConversationNavigationEntry, 'clientUserMessageId' | 'providerItemId' | 'id'>): string {
  return `navigation:${encodeURIComponent(entry.clientUserMessageId ? `client:${entry.clientUserMessageId}` : entry.providerItemId ? `provider:${entry.providerItemId}` : `history:${entry.id}`)}`;
}

/** 完整目录提供顺序，实时投影只补充相同发言的内容与新发言。 */
export function mergeNavigationEntries(history: readonly ConversationNavigationEntry[], live: readonly TranscriptNavigationEntry[]): TranscriptNavigationEntry[] {
  /** 多种权威身份都可命中同一消息，禁止用相同正文猜测去重。 */
  const byIdentity = new Map<string, TranscriptNavigationEntry>();
  for (const entry of live) for (const identity of navigationIdentities(entry)) byIdentity.set(identity, entry);
  /** 已由持久目录接管的实时项不能再追加一条刻度。 */
  const matched = new Set<string>();
  /** 目录顺序保持稳定，已加载消息替换对应占位。 */
  const entries = history.map((entry): TranscriptNavigationEntry => {
    /** 同一条发言在模型确认前后可能有不同的技术消息身份。 */
    const current = navigationIdentities(entry)
      .map((identity) => byIdentity.get(identity))
      .find(Boolean);
    for (const identity of [...navigationIdentities(entry), ...(current ? navigationIdentities(current) : [])]) matched.add(identity);
    return { ...entry, rowKey: navigationRowKey(entry), loaded: Boolean(current), ...(current ? { prompt: current.prompt || entry.prompt, response: current.response || entry.response, status: current.status } : {}) };
  });
  for (const entry of live) {
    if (navigationIdentities(entry).some((identity) => matched.has(identity))) continue;
    entries.push(entry);
    for (const identity of navigationIdentities(entry)) matched.add(identity);
  }
  return entries;
}

/** 各身份加前缀，避免不同身份空间碰撞。 */
function navigationIdentities(entry: ConversationNavigationEntry): string[] {
  return [`history:${entry.id}`, ...(entry.clientUserMessageId ? [`client:${entry.clientUserMessageId}`] : []), ...(entry.providerItemId ? [`provider:${entry.providerItemId}`] : [])];
}

/** 目录独立加载，失败不阻断已读取的会话正文。 */
export function useConversationNavigation(input: { scopeKey: string | null; refreshKey: string; load?: () => Promise<ConversationNavigationSnapshot> }) {
  /** 每次目录读取只更新本组件状态，不写回会话事件水位。 */
  const [result, setResult] = useState<{ scope: string | null; snapshot: ConversationNavigationSnapshot | null; error: string | null; loading: boolean }>({ scope: null, snapshot: null, error: null, loading: false });
  /** 重试只由明确操作触发。 */
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!input.load || !input.scopeKey) return;
    /** 切换、重新连接或刷新后，旧响应不能覆盖新结果。 */
    let cancelled = false;
    setResult((previous) => ({ scope: input.scopeKey, snapshot: previous.scope === input.scopeKey ? previous.snapshot : null, error: null, loading: true }));
    void input
      .load()
      .then((snapshot) => {
        if (cancelled) return;
        if (snapshot.conversationId !== input.scopeKey || !Number.isSafeInteger(snapshot.throughEventSeq) || snapshot.throughEventSeq < 0 || !Array.isArray(snapshot.entries)) throw new Error('历史目录与当前会话不匹配。');
        /** 目录来自读取边界；拒绝无法可靠定位的损坏条目。 */
        const identities = new Set<string>();
        for (const entry of snapshot.entries) {
          if (
            !entry ||
            typeof entry.id !== 'string' ||
            !entry.id ||
            typeof entry.turnId !== 'string' ||
            !entry.turnId ||
            typeof entry.prompt !== 'string' ||
            typeof entry.response !== 'string' ||
            typeof entry.status !== 'string' ||
            typeof entry.occurredAt !== 'string' ||
            !Number.isSafeInteger(entry.sequence) ||
            entry.sequence < 1 ||
            ![entry.clientUserMessageId, entry.providerItemId, entry.providerTurnId].every((value) => value === null || typeof value === 'string')
          )
            throw new Error('历史目录包含无效消息。');
          /** 完整目录的身份必须唯一。 */
          const identity = navigationRowKey(entry);
          if (identities.has(identity)) throw new Error('历史目录包含重复消息。');
          identities.add(identity);
        }
        setResult({ scope: input.scopeKey, snapshot, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult((previous) => ({ ...previous, error: error instanceof Error ? error.message : '历史目录读取失败。', loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [input.scopeKey, input.refreshKey, input.load, retry]);
  /** 会话切换的首帧也不能显示上一条会话的刻度。 */
  const current = result.scope === input.scopeKey ? result : { snapshot: null, error: null, loading: Boolean(input.load) };
  return { ...current, retry: useCallback(() => setRetry((value) => value + 1), []) };
}

/** 左侧紧凑导航只订阅自身悬停状态，鼠标移动不重渲染正文。 */
export const ConversationNavigation = memo(function ConversationNavigation(props: {
  entries: readonly TranscriptNavigationEntry[];
  activeRowKey: string | null;
  language: string;
  shellRef: RefObject<HTMLDivElement | null>;
  onNavigate: (entry: TranscriptNavigationEntry) => void;
}) {
  /** 保留同一预览容器，切换条目时不重新播放入场动画。 */
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  /** 开关与内容分离，退出期间保留最后一条摘录。 */
  const [open, setOpen] = useState(false);
  /** 位置只在切换条目或视口变化时测量。 */
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  /** 完成退出动画后才卸载，快速重入接管当前动画。 */
  const presence = useMotionPresence<HTMLDivElement>(open);
  /** 导航容器负责内部滚动及键盘定位。 */
  const railRef = useRef<HTMLElement | null>(null);
  /** 每条刻度的真实元素用于定位预览和焦点。 */
  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  /** 首次悬停等待，邻近刻度共享这一次等待。 */
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 跨越刻度与卡片间隙时不立即关闭。 */
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 事件处理同步知道开关，避免同一帧重复等待。 */
  const openRef = useRef(false);
  /** 鼠标进入卡片时保留当前波峰。 */
  const [cardHovered, setCardHovered] = useState(false);
  /** 辅助技术通过同一个预览身份读取当前答复。 */
  const previewId = useId();
  /** 读取当前摘录，无回复时显示真实轮次状态。 */
  const preview = props.entries.find((entry) => entry.rowKey === previewKey);
  /** 文案随会话语言切换。 */
  const zh = props.language === 'zh-CN';

  /** 重入只撤销关闭，不重置动画起点。 */
  const cancelClose = useCallback(() => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = null;
  }, []);
  /** 键盘立即预览，鼠标首次停留后才显示。 */
  const show = useCallback(
    (rowKey: string, immediate = false) => {
      cancelClose();
      setPreviewKey(rowKey);
      if (immediate || openRef.current || presence.present) {
        if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
        enterTimerRef.current = null;
        openRef.current = true;
        setOpen(true);
      } else if (!enterTimerRef.current) {
        enterTimerRef.current = setTimeout(() => {
          enterTimerRef.current = null;
          openRef.current = true;
          setOpen(true);
        }, 250);
      }
    },
    [cancelClose, presence.present],
  );
  /** 退出保持 100ms 容错，淡出结束后由共享机制卸载。 */
  const hide = useCallback(
    (immediate = false) => {
      cancelClose();
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
      /** 关闭仅改变目标状态，不清空最后内容与位置。 */
      const close = () => {
        leaveTimerRef.current = null;
        openRef.current = false;
        setOpen(false);
        setCardHovered(false);
      };
      if (immediate) close();
      else leaveTimerRef.current = setTimeout(close, 100);
    },
    [cancelClose],
  );

  useEffect(
    () => () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open || !previewKey) return;
    /** 预览锚定被指向刻度，并在窗口内夹紧。 */
    const update = () => {
      /** 测量集中执行，位置变化不牵动正文。 */
      const button = buttonsRef.current.get(previewKey);
      /** 浮层尺寸取真实渲染结果，避免靠固定高度猜测。 */
      const card = presence.ref.current;
      if (!button || !card) return;
      /** 可见按钮与卡片分别只读取一次布局。 */
      const anchor = button.getBoundingClientRect();
      /** 卡片受到窄窗口宽度约束。 */
      const bounds = card.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(anchor.right, window.innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(anchor.top + anchor.height / 2 - bounds.height / 2, window.innerHeight - bounds.height - 8)) });
    };
    update();
    /** 行高、缩放及视口变化共用真实尺寸通知。 */
    const observer = new ResizeObserver(update);
    if (presence.ref.current) observer.observe(presence.ref.current);
    if (railRef.current) observer.observe(railRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, previewKey, presence.ref]);

  useEffect(() => {
    if (open || !props.activeRowKey) return;
    /** 正文滚动只让当前刻度进入导航视口，不使用会滚动祖先的 scrollIntoView。 */
    const button = buttonsRef.current.get(props.activeRowKey);
    /** 两层容器的 offsetTop 使用同一个导航坐标系。 */
    const rail = railRef.current;
    if (!button || !rail) return;
    if (button.offsetTop < rail.scrollTop) rail.scrollTop = button.offsetTop;
    else if (button.offsetTop + button.offsetHeight > rail.scrollTop + rail.clientHeight) rail.scrollTop = button.offsetTop + button.offsetHeight - rail.clientHeight;
  }, [props.activeRowKey, open]);

  useEffect(() => {
    if (!open || !previewKey) return;
    /** 只更新当前刻度的描述，不重建全部刻度。 */
    const button = buttonsRef.current.get(previewKey);
    button?.setAttribute('aria-describedby', previewId);
    return () => button?.removeAttribute('aria-describedby');
  }, [open, previewKey, previewId]);

  /** 卡片悬停时保持波峰；扫过刻度时由原生 CSS 直接响应。 */
  const heldKey = cardHovered ? previewKey : null;
  /** 鼠标切换摘录不重复构造全部刻度节点。 */
  const ticks = useMemo(
    () =>
      props.entries.map((entry, index) => (
        <button
          key={entry.rowKey}
          ref={(element) => {
            if (element) buttonsRef.current.set(entry.rowKey, element);
            else buttonsRef.current.delete(entry.rowKey);
          }}
          type="button"
          className="session-navigation-tick"
          data-navigation-row-key={entry.rowKey}
          data-preview={heldKey === entry.rowKey || undefined}
          aria-current={props.activeRowKey === entry.rowKey ? 'true' : undefined}
          aria-label={`${zh ? '跳到第' : 'Jump to message '}${index + 1}${zh ? '次发言：' : ': '}${entry.prompt}`}
          tabIndex={entry.rowKey === (props.activeRowKey ?? props.entries[0]?.rowKey) ? 0 : -1}
          onPointerEnter={() => show(entry.rowKey)}
          onFocus={(event) => {
            if (event.currentTarget.matches(':focus-visible')) show(entry.rowKey, true);
          }}
          onClick={() => {
            hide(true);
            props.onNavigate(entry);
          }}
        >
          <span aria-hidden="true" />
        </button>
      )),
    [props.entries, props.activeRowKey, props.onNavigate, heldKey, zh, show, hide],
  );

  /** 使用本会话主题，浮层从正文裁切区域外显示。 */
  const shell = props.shellRef.current?.closest('.session-codex-parity-v1');
  /** 系统主题无需复制静态颜色。 */
  const theme = shell?.classList.contains('theme-dark') ? 'theme-dark' : shell?.classList.contains('theme-light') ? 'theme-light' : 'theme-system';
  return (
    <>
      <nav
        ref={railRef}
        className="session-navigation-rail"
        aria-label={zh ? '全部用户发言' : 'All user messages'}
        onPointerEnter={() => {
          cancelClose();
          setCardHovered(false);
        }}
        onPointerLeave={() => hide()}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget) && !presence.ref.current?.contains(event.relatedTarget)) hide();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            hide(true);
            return;
          }
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          /** 键盘只改变选择，Enter 或空格由按钮完成跳转。 */
          const keys = props.entries.map((entry) => entry.rowKey);
          /** 当前焦点不依赖悬停预览的退出延迟。 */
          const index = keys.findIndex((key) => buttonsRef.current.get(key) === document.activeElement);
          /** 方向键在目录边界停止。 */
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : Math.max(0, Math.min(keys.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
          buttonsRef.current.get(keys[next]!)?.focus({ preventScroll: true });
          /** 仅滚动导航本身，不影响正文。 */
          const button = buttonsRef.current.get(keys[next]!);
          if (button && railRef.current) railRef.current.scrollTop = Math.max(0, button.offsetTop - railRef.current.clientHeight / 2);
        }}
      >
        {ticks}
      </nav>
      {presence.present &&
        preview &&
        createPortal(
          <div className={`macos-ai-app session-codex-parity-v1 session-navigation-portal ${theme}`}>
            <div
              ref={presence.ref}
              id={previewId}
              role="tooltip"
              className="session-navigation-preview"
              data-open={open || undefined}
              aria-hidden={!open}
              inert={!open}
              style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}
              onPointerEnter={() => {
                cancelClose();
                setCardHovered(true);
              }}
              onPointerLeave={() => hide()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  hide(true);
                }
              }}
            >
              <strong>{preview.prompt || (zh ? '用户发言' : 'User message')}</strong>
              <p>{preview.response || navigationStatusText(preview.status, zh)}</p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
});

/** 没有答复摘录时展示真实状态，不制造回答文本。 */
export function navigationStatusText(status: string, zh: boolean): string {
  if (status === 'failed') return zh ? '本次执行失败' : 'This turn failed';
  if (status === 'interrupted' || status === 'cancelled') return zh ? '本次执行已中断' : 'This turn was interrupted';
  if (status === 'completed') return zh ? '本次没有文字答复' : 'No text response';
  return zh ? '等待答复…' : 'Waiting for a response…';
}
