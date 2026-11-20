import { Collapsible } from '../ui/Collapsible.js';
import { type ReactNode, useId, useRef, useState } from 'react';
import { ArrowsOutSimpleIcon as ArrowsOutSimple } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { DownloadIcon as Download } from '@phosphor-icons/react/dist/csr/Download';
import { LightbulbIcon as Lightbulb } from '@phosphor-icons/react/dist/csr/Lightbulb';
import { SidebarSimpleIcon as SidebarSimple } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { ThumbsDownIcon as ThumbsDown } from '@phosphor-icons/react/dist/csr/ThumbsDown';
import { ThumbsUpIcon as ThumbsUp } from '@phosphor-icons/react/dist/csr/ThumbsUp';
import type { NativeSessionItemBuffer } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { ConversationMarkdown, conversationMarkdownPhaseForStatus } from './ConversationMarkdown.js';
import { Button } from '../ui/Button.js';

/** 计划卡片复用右栏预览，卡片内部操作与正文选区保持独立。 */
export function PlanSummary(props: {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  motionActive?: boolean;
  panelOpen?: boolean;
  onSelectPlan?: (item: NativeSessionItemBuffer | null, trigger: HTMLButtonElement | null) => void;
}) {
  /** 会话内的计划入口在预览开合时保留，用于恢复焦点。 */
  const titleRef = useRef<HTMLButtonElement>(null);
  /** 内容身份用于折叠按钮的辅助阅读关联。 */
  const contentId = useId();
  /** 折叠只控制会话内正文，不影响右侧计划。 */
  const [collapsed, setCollapsed] = useState(false);
  /** 复制完成后短暂显示确认。 */
  const [copied, setCopied] = useState(false);
  /** 当前卡片的本地反馈状态。 */
  const [feedback, setFeedback] = useState<'good' | 'bad' | null>(null);
  /** 本卡片沿用会话语言。 */
  const zh = props.language === 'zh-CN';
  /** 计划正文使用共享流式阶段判断。 */
  const phase = conversationMarkdownPhaseForStatus(props.item.status);
  /** 编写期间保留现有状态显示。 */
  const streaming = phase === 'streaming';
  /** 标题同时作为预览按钮的可见名称。 */
  const title = streaming ? (zh ? '正在编写计划' : 'Writing plan') : zh ? '计划' : 'Plan';
  /** 右侧预览打开后，同一入口改为关闭操作。 */
  const previewLabel = props.panelOpen ? (zh ? '关闭计划预览' : 'Close plan preview') : zh ? '在右侧打开计划' : 'Open plan at right';
  /** 正文、标题与图标共用入口，关闭预览后将焦点交还标题。 */
  const selectPlan = () => props.onSelectPlan?.(props.panelOpen ? null : props.item, titleRef.current);
  /** 卡片操作使用原生按钮，父级点击不会接管其动作。 */
  const iconButton = (label: string, child: ReactNode, onClick: () => void, pressed?: boolean) => (
    <Button unstyled type="button" aria-label={label} data-icon-tooltip={label} aria-pressed={pressed} onClick={onClick}>
      {child}
    </Button>
  );

  return (
    <article
      className="session-plan-summary"
      data-streaming={streaming || undefined}
      data-motion-active={props.motionActive || undefined}
      data-collapsed={collapsed || undefined}
      data-panel-open={props.panelOpen || undefined}
      data-preview-enabled={(Boolean(props.onSelectPlan) && !props.panelOpen) || undefined}
      onClick={(event) => {
        if (!props.onSelectPlan || props.panelOpen || event.defaultPrevented) return;
        /** 链接、工具栏和正文内控件各自处理点击，不重复打开右栏。 */
        const target = event.target;
        if (target instanceof Element && target.closest('button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"]')) return;
        /** 拖选本卡片的文字只保留选区，不将鼠标释放视作预览操作。 */
        const selection = event.currentTarget.ownerDocument.defaultView?.getSelection();
        if (selection && !selection.isCollapsed && (event.currentTarget.contains(selection.anchorNode) || event.currentTarget.contains(selection.focusNode))) return;
        return selectPlan();
      }}
    >
      <header>
        <div className="session-plan-summary-heading">
          <Button
            unstyled
            ref={titleRef}
            type="button"
            className="session-plan-summary-title"
            disabled={!props.onSelectPlan}
            aria-expanded={props.onSelectPlan ? Boolean(props.panelOpen) : undefined}
            onClick={selectPlan}
            data-icon-tooltip={previewLabel}
          >
            <span className="session-plan-summary-symbol" aria-hidden="true">
              <Lightbulb />
            </span>
            <strong>{title}</strong>
            {props.panelOpen ? <SidebarSimple aria-hidden="true" size={14} /> : null}
          </Button>
          {!props.panelOpen ? (
            <Button
              unstyled
              data-icon-tooltip={collapsed ? (zh ? '展开计划内容' : 'Expand plan content') : zh ? '收起计划内容' : 'Collapse plan content'}
              type="button"
              className="session-plan-summary-collapse"
              onClick={() => setCollapsed((value) => !value)}
              aria-expanded={!collapsed}
              aria-controls={contentId}
              aria-label={collapsed ? (zh ? '展开计划内容' : 'Expand plan content') : zh ? '收起计划内容' : 'Collapse plan content'}
            >
              <CaretDown aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        {!streaming && !props.panelOpen ? (
          <nav aria-label={zh ? '计划操作' : 'Plan actions'}>
            {iconButton(zh ? '下载计划 Markdown' : 'Download plan Markdown', <Download aria-hidden="true" />, () => downloadPlan(props.item.text))}
            {iconButton(copied ? (zh ? '已复制' : 'Copied') : zh ? '复制计划 Markdown' : 'Copy plan Markdown', <Copy aria-hidden="true" />, () => {
              void navigator.clipboard?.writeText(props.item.text).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_400);
              });
            })}
            {iconButton(
              feedback === 'good' ? (zh ? '取消喜欢' : 'Remove like') : zh ? '喜欢此计划' : 'Like plan',
              <ThumbsUp aria-hidden="true" weight={feedback === 'good' ? 'fill' : 'regular'} />,
              () => setFeedback((value) => (value === 'good' ? null : 'good')),
              feedback === 'good',
            )}
            {iconButton(
              feedback === 'bad' ? (zh ? '取消不喜欢' : 'Remove dislike') : zh ? '不喜欢此计划' : 'Dislike plan',
              <ThumbsDown aria-hidden="true" weight={feedback === 'bad' ? 'fill' : 'regular'} />,
              () => setFeedback((value) => (value === 'bad' ? null : 'bad')),
              feedback === 'bad',
            )}
            {props.onSelectPlan ? iconButton(previewLabel, <ArrowsOutSimple aria-hidden="true" />, selectPlan) : null}
            {props.onSelectPlan ? iconButton(previewLabel, <SidebarSimple aria-hidden="true" />, selectPlan) : null}
          </nav>
        ) : null}
      </header>
      {!props.panelOpen ? (
        <Collapsible open={!collapsed}>
          <div id={contentId} className="session-plan-summary-content">
            {streaming && !props.item.text.trim() ? (
              <span className="session-thinking-pulse" aria-hidden="true" />
            ) : (
              <ConversationMarkdown text={props.item.text} streamId={`plan-summary:${props.item.itemId}`} phase={phase} language={props.language} />
            )}
          </div>
        </Collapsible>
      ) : null}
    </article>
  );
}

/** 下载当前计划的原始 Markdown，不切换右侧工作区。 */
function downloadPlan(markdown: string): void {
  /** 临时资源地址在点击完成后释放。 */
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  /** 使用浏览器原生下载能力。 */
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'plan.md';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
