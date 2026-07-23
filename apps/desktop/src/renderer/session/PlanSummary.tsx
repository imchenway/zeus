import {type ReactNode, useState} from 'react';
import {ArrowsOutIcon as ArrowsOut} from '@phosphor-icons/react/dist/csr/ArrowsOut';
import {CaretDownIcon as CaretDown} from '@phosphor-icons/react/dist/csr/CaretDown';
import {CopyIcon as Copy} from '@phosphor-icons/react/dist/csr/Copy';
import {DownloadSimpleIcon as DownloadSimple} from '@phosphor-icons/react/dist/csr/DownloadSimple';
import {LightbulbIcon as Lightbulb} from '@phosphor-icons/react/dist/csr/Lightbulb';
import {SidebarSimpleIcon as SidebarSimple} from '@phosphor-icons/react/dist/csr/SidebarSimple';
import {ThumbsDownIcon as ThumbsDown} from '@phosphor-icons/react/dist/csr/ThumbsDown';
import {ThumbsUpIcon as ThumbsUp} from '@phosphor-icons/react/dist/csr/ThumbsUp';
import type {NativeSessionItemBuffer} from './sessionTypes.js';
import {SafeMarkdown, type SessionUiLanguage} from './ThreadItemView.js';

export function PlanSummary(props: {
    item: NativeSessionItemBuffer;
    language: SessionUiLanguage;
    panelOpen?: boolean;
    onOpenPanel?: (item: NativeSessionItemBuffer) => void
}) {
    const [collapsed, setCollapsed] = useState(false);
    const [copied, setCopied] = useState(false);
    const [feedback, setFeedback] = useState<'good' | 'bad' | null>(null);
    const zh = props.language === 'zh-CN';
    const streaming = props.item.status !== 'completed';
    const title = streaming ? (zh ? '正在编写计划' : 'Writing plan') : zh ? '计划' : 'Plan';
    const iconButton = (label: string, child: ReactNode, onClick: () => void, pressed?: boolean) => (
        <button type="button" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}>
            {child}
        </button>
    );

    if (props.panelOpen) {
        return (
            <button type="button" className="session-plan-entry" onClick={() => props.onOpenPanel?.(props.item)}>
                <span>{title}</span>
                <SidebarSimple aria-hidden="true"/>
            </button>
        );
    }

    return (
        <article className="session-plan-summary" data-streaming={streaming || undefined}
                 data-collapsed={collapsed || undefined}>
            <header>
                <button type="button" className="session-plan-summary-title"
                        onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
                    <Lightbulb className="session-plan-summary-symbol" aria-hidden="true"/>
                    <strong>{title}</strong>
                    <CaretDown aria-hidden="true"/>
                </button>
                {!streaming ? (
                    <nav aria-label={zh ? '计划操作' : 'Plan actions'}>
                        {iconButton(zh ? '下载 plan.md' : 'Download plan.md', <DownloadSimple
                            aria-hidden="true"/>, () => downloadPlan(props.item.text))}
                        {iconButton(copied ? (zh ? '已复制' : 'Copied') : zh ? '复制 Markdown' : 'Copy Markdown', <Copy
                            aria-hidden="true"/>, () => {
                            void navigator.clipboard?.writeText(props.item.text).then(() => {
                                setCopied(true);
                                window.setTimeout(() => setCopied(false), 1_400);
                            });
                        })}
                        {iconButton(zh ? '喜欢此计划' : 'Like plan', <ThumbsUp aria-hidden="true"
                                                                               weight={feedback === 'good' ? 'fill' : 'regular'}/>, () => setFeedback((value) => (value === 'good' ? null : 'good')), feedback === 'good')}
                        {iconButton(zh ? '不喜欢此计划' : 'Dislike plan', <ThumbsDown aria-hidden="true"
                                                                                      weight={feedback === 'bad' ? 'fill' : 'regular'}/>, () => setFeedback((value) => (value === 'bad' ? null : 'bad')), feedback === 'bad')}
                        {iconButton(zh ? '展开完整计划' : 'Expand plan', <ArrowsOut
                            aria-hidden="true"/>, () => props.onOpenPanel?.(props.item))}
                        {iconButton(zh ? '在右侧打开计划' : 'Open plan at right', <SidebarSimple
                            aria-hidden="true"/>, () => props.onOpenPanel?.(props.item))}
                    </nav>
                ) : null}
            </header>
            {!collapsed ? (
                <div className="session-plan-summary-content">{streaming && !props.item.text.trim() ?
                    <span className="session-thinking-pulse" aria-hidden="true"/> :
                    <SafeMarkdown text={props.item.text} language={props.language}/>}</div>
            ) : null}
        </article>
    );
}

function downloadPlan(markdown: string): void {
    const url = URL.createObjectURL(new Blob([markdown], {type: 'text/markdown;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'plan.md';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
