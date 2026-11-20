import { ArrowsInIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { ArrowsOutIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { LightbulbIcon as Lightbulb } from '@phosphor-icons/react/dist/csr/Lightbulb';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { NativeSessionItemBuffer } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { ConversationMarkdown, conversationMarkdownPhaseForStatus } from './ConversationMarkdown.js';
import { useReadingScroll } from '../ui/readingState.js';
import { Button } from '../ui/Button.js';

/** 在会话共享顶栏下阅读计划 Markdown，并沿用当前分栏的关闭操作。 */
export function PlanWorkspace(props: {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  toolbarHost: HTMLDivElement | null;
  open: boolean;
  canSplit: boolean;
  fullWidth: boolean;
  onFullWidthChange: (fullWidth: boolean) => void;
  onClose: () => void;
}) {
  /** 每份计划保存独立阅读位置。 */
  const readingScroll = useReadingScroll(`plan:${props.item.key}`);
  /** 打开时聚焦标题，让原生关闭快捷键识别当前工作面。 */
  const titleRef = useRef<HTMLSpanElement>(null);
  /** 标题和操作沿用会话语言。 */
  const zh = props.language === 'zh-CN';
  /** 全宽和分栏使用同一个操作入口。 */
  const toggleLabel = props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width';
  useLayoutEffect(() => {
    if (props.open) titleRef.current?.focus({ preventScroll: true });
  }, [props.item.key, props.open, props.toolbarHost]);

  /** 标题和操作与文件预览共用顶栏样式。 */
  const header = (
    <header className="session-context-workspace-header">
      <span className="session-context-workspace-title" ref={titleRef} tabIndex={-1}>
        <Lightbulb aria-hidden="true" weight="regular" />
        <span>
          <strong>{zh ? '计划' : 'Plan'}</strong>
        </span>
      </span>
      <nav aria-label={zh ? '计划工作区操作' : 'Plan workspace actions'}>
        {props.canSplit ? (
          <Button unstyled type="button" aria-label={toggleLabel} data-icon-tooltip={toggleLabel} onClick={() => props.onFullWidthChange(!props.fullWidth)}>
            {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
          </Button>
        ) : null}
        <Button unstyled type="button" aria-label={zh ? '关闭计划工作区' : 'Close plan workspace'} data-icon-tooltip={zh ? '关闭' : 'Close'} onClick={props.onClose}>
          <X aria-hidden="true" />
        </Button>
      </nav>
    </header>
  );

  return (
    <aside className="session-plan-workspace" data-full-width={props.fullWidth || undefined} aria-label={zh ? '计划工作区' : 'Plan workspace'}>
      {props.toolbarHost ? createPortal(header, props.toolbarHost) : header}
      <section ref={readingScroll} className="session-plan-workspace-content">
        <ConversationMarkdown text={props.item.text} streamId={`plan-workspace:${props.item.itemId}`} phase={conversationMarkdownPhaseForStatus(props.item.status)} language={props.language} />
      </section>
    </aside>
  );
}
