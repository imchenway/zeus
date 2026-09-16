import { useEffect, useRef } from 'react';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TerminalIcon as TerminalGlyph } from '@phosphor-icons/react/dist/csr/Terminal';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { AiRuntimeSession } from '../../apiClient.js';
import './terminal.css';

/** 标签只呈现真实会话状态，生命周期和权限由调用入口管理。 */
interface TerminalTabsProps {
  /** 保持入口已有的显示顺序。 */
  sessions: readonly AiRuntimeSession[];
  /** 当前选中的后台会话身份。 */
  activeId: string | null;
  /** 与输出面板关联的唯一标识。 */
  panelId: string;
  /** 标签与操作提示的语言。 */
  language: 'zh-CN' | 'en-US';
  /** 隐藏面板时不触发滚动。 */
  visible: boolean;
  /** 新建期间显示进度。 */
  starting: boolean;
  /** 权限、忙碌或数量上限阻止新增。 */
  newDisabled: boolean;
  /** 当前关闭中的标签显示进度。 */
  closingId: string | null;
  /** 防止并发关闭与其他启停操作冲突。 */
  closeDisabled: boolean;
  /** 选择标签，输入和输出仍由入口处理。 */
  onSelect: (id: string) => void;
  /** 由入口新建终端。 */
  onNew: () => void;
  /** 由入口决定结束进程或移除已结束标签。 */
  onClose: (session: AiRuntimeSession) => void;
}

/** 两个入口共用会话式标签：目录名、状态点、独立关闭和紧随其后的新增按钮。 */
export function TerminalTabs(props: TerminalTabsProps) {
  /** 当前语言只影响文案，不影响终端身份。 */
  const zh = props.language === 'zh-CN';
  /** 选中标签变化后让它进入可视区域。 */
  const selectedRef = useRef<HTMLButtonElement>(null);
  /** 两个终端入口共用焦点归属和原生关闭动作。 */
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.visible) return;
    /** 面板包含标签与终端输入区，点击任意位置都切换快捷键归属。 */
    const panel = tabsRef.current?.closest('.session-terminal-panel, .project-terminal');
    if (!panel) return;
    /** 记录本面板是否曾取得焦点，避免覆盖其他工作面的通知。 */
    let active = false;
    /** 冒泡阶段在会话父容器通知之后更新终端归属。 */
    const updateActivity = (event?: Event): void => {
      /** 初次挂载读取当前焦点；后续采用真实事件目标。 */
      const target = event?.target ?? document.activeElement;
      /** 仅当前可见面板消费快捷键。 */
      const next = target instanceof Node && panel.contains(target);
      if (next || active) window.zeus?.notifyTerminalActivity?.(next);
      active = next;
    };
    document.addEventListener('focusin', updateActivity);
    document.addEventListener('pointerdown', updateActivity);
    updateActivity();
    /** 关闭复用标签按钮的流程和并发门禁。 */
    const unsubscribe = window.zeus?.onNativeCloseActiveTerminalTab?.(() => {
      if (!active || props.closeDisabled) return;
      /** 只关闭当前选中的后台会话。 */
      const session = props.sessions.find((item) => item.id === props.activeId);
      if (session) props.onClose(session);
    });
    return () => {
      document.removeEventListener('focusin', updateActivity);
      document.removeEventListener('pointerdown', updateActivity);
      unsubscribe?.();
      if (active) window.zeus?.notifyTerminalActivity?.(false);
    };
  }, [props.visible, props.activeId, props.sessions, props.closeDisabled, props.onClose]);
  /** 同目录的多个终端按当前显示顺序编号。 */
  const nameCounts = new Map<string, number>();
  /** 后台状态对应完整的可访问文字。 */
  const statusLabels = {
    running: zh ? '运行中' : 'Running',
    stopped: zh ? '已停止' : 'Stopped',
    exited: zh ? '已退出' : 'Exited',
    failed: zh ? '失败' : 'Failed',
    orphan_detected: zh ? '待清理' : 'Needs cleanup',
    lost: zh ? '已断开' : 'Disconnected',
  };
  useEffect(() => {
    if (props.visible) selectedRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [props.visible, props.activeId]);

  return (
    <div ref={tabsRef} className="zeus-terminal-tabs" role="tablist" aria-label={zh ? '终端' : 'Terminal'}>
      {props.sessions.map((session, index) => {
        /** 路径最后一段作为短标题，完整路径保留在悬浮提示。 */
        const base =
          session.cwd
            .split(/[\\/]+/u)
            .filter(Boolean)
            .at(-1) ?? 'terminal';
        /** 当前目录名已出现的次数。 */
        const count = (nameCounts.get(base) ?? 0) + 1;
        nameCounts.set(base, count);
        /** 多个同名目录添加序号，避免标签完全相同。 */
        const title = count > 1 ? `${base} ${count}` : base;
        /** 当前标签决定高亮与键盘入口。 */
        const active = session.id === props.activeId;
        /** 关闭状态使用文字和图标同时呈现。 */
        const closeLabel = `${zh ? '关闭终端标签' : 'Close terminal tab'}: ${title}`;
        return (
          <div key={session.id} className="zeus-terminal-tab-shell" data-active={active || undefined} role="presentation">
            <button
              ref={active ? selectedRef : undefined}
              type="button"
              role="tab"
              id={`${props.panelId}-${session.id}`}
              aria-controls={props.panelId}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={session.cwd}
              className="zeus-terminal-tab"
              onClick={() => props.onSelect(session.id)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                /** 方向键循环选择，首尾键直接定位边界。 */
                const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? props.sessions.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + props.sessions.length) % props.sessions.length;
                props.onSelect(props.sessions[nextIndex]!.id);
                /** 仅聚焦标签按钮，不把独立关闭按钮计入顺序。 */
                const tabs = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                tabs?.[nextIndex]?.focus();
              }}
            >
              <TerminalGlyph aria-hidden="true" />
              <span>{title}</span>
              <i data-status={session.status} aria-label={statusLabels[session.status]} title={statusLabels[session.status]} />
            </button>
            <button className="zeus-terminal-tab-close" type="button" aria-label={closeLabel} title={closeLabel} disabled={props.closeDisabled} onClick={() => props.onClose(session)}>
              {props.closingId === session.id ? <CircleNotch aria-hidden="true" className="zeus-terminal-spinner" /> : <X aria-hidden="true" />}
            </button>
          </div>
        );
      })}
      <button className="zeus-terminal-action" type="button" aria-label={zh ? '新建终端' : 'New terminal'} title={zh ? '新建终端' : 'New terminal'} disabled={props.newDisabled} onClick={props.onNew}>
        {props.starting ? <CircleNotch aria-hidden="true" className="zeus-terminal-spinner" /> : <Plus aria-hidden="true" />}
      </button>
    </div>
  );
}
