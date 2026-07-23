import {type FocusEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState} from 'react';
import {CaretDownIcon as CaretDown} from '@phosphor-icons/react/dist/csr/CaretDown';
import {CheckCircleIcon as CheckCircle} from '@phosphor-icons/react/dist/csr/CheckCircle';
import {CircleIcon as Circle} from '@phosphor-icons/react/dist/csr/Circle';
import {CircleNotchIcon as CircleNotch} from '@phosphor-icons/react/dist/csr/CircleNotch';
import {FileTextIcon as FileText} from '@phosphor-icons/react/dist/csr/FileText';
import {ImageIcon as Image} from '@phosphor-icons/react/dist/csr/Image';
import {ListChecksIcon as ListChecks} from '@phosphor-icons/react/dist/csr/ListChecks';
import {MagnifyingGlassIcon as MagnifyingGlass} from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import {TerminalWindowIcon as TerminalWindow} from '@phosphor-icons/react/dist/csr/TerminalWindow';
import {WrenchIcon as Wrench} from '@phosphor-icons/react/dist/csr/Wrench';
import type {NativeSessionItemBuffer, NativeTurnPlanSnapshot, NativeTurnSnapshot} from './sessionTypes.js';
import type {SessionUiLanguage} from './ThreadItemView.js';

const operationalTypes = new Set(['commandexecution', 'command', 'mcptoolcall', 'dynamictoolcall', 'websearch', 'imageview', 'toolcall', 'tool', 'filechange', 'file']);

export function isOperationalActivityItem(item: NativeSessionItemBuffer): boolean {
    return operationalTypes.has(normalizeType(item.type));
}

export function SessionActivityGroup(props: { items: NativeSessionItemBuffer[]; language: SessionUiLanguage }) {
    const summary = activitySummary(props.items, props.language);
    const skillNames = activitySkillNames(props.items);
    return (
        <section className="session-activity-group"
                 aria-label={props.language === 'zh-CN' ? '工作活动' : 'Work activity'}>
            <details>
                <summary>
                    <Wrench aria-hidden="true" weight="regular"/>
                    <span>{summary}</span>
                    <CaretDown className="session-activity-caret" aria-hidden="true" weight="bold"/>
                </summary>
                <div className="session-activity-body">
                    {skillNames.length > 0 ? (
                        <p className="session-activity-skills">
                            <span>{props.language === 'zh-CN' ? '技能' : 'Skills'}</span>
                            {skillNames.map((name) => (
                                <code key={name}>{name}</code>
                            ))}
                        </p>
                    ) : null}
                    <ol>
                        {props.items.map((item) => (
                            <ActivityItemRow key={item.key} item={item} language={props.language}/>
                        ))}
                    </ol>
                </div>
            </details>
        </section>
    );
}

function ActivityItemRow(props: { item: NativeSessionItemBuffer; language: SessionUiLanguage }) {
    const title = activityItemTitle(props.item, props.language);
    const detail = activityItemDetail(props.item);
    const Icon = activityItemIcon(props.item);
    return (
        <li data-status={props.item.status}>
      <span className="session-activity-item-icon" aria-hidden="true">
        <Icon weight="regular"/>
      </span>
            <div className="session-activity-item-copy">
                {detail ? (
                    <details className="session-activity-item-detail">
                        <summary className="session-activity-item-summary">
                            <span className="session-activity-item-title">{title}</span>
                            <CaretDown className="session-activity-item-caret" aria-hidden="true" weight="bold"/>
                        </summary>
                        <div className="session-activity-item-detail-body">
                            {detail.command ? <code>{detail.command}</code> : null}
                            {detail.cwd ? <small>{detail.cwd}</small> : null}
                            {detail.output ? <pre>{detail.output}</pre> : null}
                        </div>
                    </details>
                ) : (
                    <span className="session-activity-item-title">{title}</span>
                )}
            </div>
        </li>
    );
}

export function SessionPlanProgress(props: { plan: NativeTurnPlanSnapshot; language: SessionUiLanguage }) {
    const [open, setOpen] = useState(false);
    const popoverId = useId();
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const steps = props.plan.steps;
    const inProgressIndex = steps.findIndex((step) => step.status === 'inProgress');
    const pendingIndex = steps.findIndex((step) => step.status === 'pending');
    const currentIndex = inProgressIndex >= 0 ? inProgressIndex : pendingIndex >= 0 ? pendingIndex : steps.length - 1;
    const current = steps[currentIndex];
    const summary = props.language === 'zh-CN' ? `第 ${currentIndex + 1} / ${steps.length} 步` : `Step ${currentIndex + 1} of ${steps.length}`;

    function cancelClose(): void {
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
    }

    function show(): void {
        cancelClose();
        setOpen(true);
    }

    function scheduleClose(): void {
        cancelClose();
        closeTimerRef.current = setTimeout(() => {
            setOpen(false);
            closeTimerRef.current = null;
        }, 120);
    }

    function handleBlur(event: FocusEvent<HTMLElement>): void {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        scheduleClose();
    }

    function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        event.stopPropagation();
        cancelClose();
        setOpen(false);
        triggerRef.current?.focus();
    }

    useEffect(
        () => () => {
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        },
        [],
    );

    if (steps.length === 0) return null;

    return (
        <section className="session-plan-dock" onPointerEnter={show} onPointerLeave={scheduleClose}
                 onFocusCapture={show} onBlurCapture={handleBlur} onKeyDown={handleKeyDown}>
            <div className="session-plan-progress" data-open={open || undefined}>
                <button ref={triggerRef} type="button" className="session-plan-trigger" aria-expanded={open}
                        aria-controls={popoverId} onClick={show}>
                    <ListChecks aria-hidden="true" weight="regular"/>
                    <span role="status" aria-live="polite" aria-atomic="true">
            <strong>{summary}</strong>
            <small>{current?.step}</small>
          </span>
                    <CaretDown className="session-plan-caret" aria-hidden="true" weight="bold"/>
                </button>
                <div id={popoverId} className="session-plan-popover" hidden={!open}>
                    <div className="session-plan-body">
                        {props.plan.explanation ? <p>{props.plan.explanation}</p> : null}
                        <ol>
                            {steps.map((step, index) => {
                                const StepIcon = step.status === 'completed' ? CheckCircle : step.status === 'inProgress' ? CircleNotch : Circle;
                                return (
                                    <li key={`${index}-${step.step}`} data-status={step.status}>
                                        <StepIcon aria-hidden="true"
                                                  weight={step.status === 'completed' ? 'fill' : 'regular'}/>
                                        <span>{step.step}</span>
                                        <small>{planStatusLabel(step.status, props.language)}</small>
                                    </li>
                                );
                            })}
                        </ol>
                    </div>
                </div>
            </div>
        </section>
    );
}

export function SessionTurnDuration(props: { turn: NativeTurnSnapshot; language: SessionUiLanguage }) {
    const [now, setNow] = useState(() => Date.now());
    const active = !props.turn.completedAt && (props.turn.status === 'running' || props.turn.status === 'waiting' || props.turn.status === 'dispatching');
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [active]);
    const duration = useMemo(() => turnDurationMs(props.turn, now), [now, props.turn]);
    if (duration === null) return null;
    const value = formatDuration(duration);
    const label = props.language === 'zh-CN' ? `已处理 ${value}` : active ? `Processing for ${value}` : `Processed in ${value}`;
    return (
        <p className="session-turn-duration" data-active={active || undefined}>
            <span aria-hidden="true"/>
            <time dateTime={`PT${Math.max(0, Math.round(duration / 1_000))}S`}>{label}</time>
            <span aria-hidden="true"/>
        </p>
    );
}

function activitySummary(items: NativeSessionItemBuffer[], language: SessionUiLanguage): string {
    const skills = activitySkillNames(items);
    if (skills.length > 0) return language === 'zh-CN' ? `已加载 ${skills.length} 个技能` : `Loaded ${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`;
    const commands = items.filter((item) => ['commandexecution', 'command'].includes(normalizeType(item.type))).length;
    const tools = items.length - commands;
    const actionTypes = new Set(items.flatMap((item) => commandActions(item).map((action) => primitive(action.type))).filter((value): value is string => Boolean(value)));
    if (commands > 0 && tools === 0) {
        if (language === 'zh-CN') {
            if (actionTypes.has('search')) return `已搜索文件并运行 ${commands} 个命令`;
            if (actionTypes.has('read') || actionTypes.has('listFiles')) return `已读取文件并运行 ${commands} 个命令`;
            return `已运行 ${commands} 个命令`;
        }
        if (actionTypes.has('search')) return `Searched files and ran ${commands} ${commands === 1 ? 'command' : 'commands'}`;
        if (actionTypes.has('read') || actionTypes.has('listFiles')) return `Read files and ran ${commands} ${commands === 1 ? 'command' : 'commands'}`;
        return `Ran ${commands} ${commands === 1 ? 'command' : 'commands'}`;
    }
    if (commands === 0) return language === 'zh-CN' ? `已使用 ${tools} 个工具` : `Used ${tools} ${tools === 1 ? 'tool' : 'tools'}`;
    return language === 'zh-CN' ? `已运行 ${commands} 个命令并使用 ${tools} 个工具` : `Ran ${commands} commands and used ${tools} tools`;
}

function activitySkillNames(items: NativeSessionItemBuffer[]): string[] {
    const names = items.flatMap((item) =>
        commandActions(item).flatMap((action) => {
            const path = primitive(action.path ?? action.filePath);
            if (!path || !/(^|[\\/])SKILL\.md$/u.test(path)) return [];
            const segments = path.split(/[\\/]/u).filter(Boolean);
            return segments.length >= 2 ? [segments[segments.length - 2]!] : [];
        }),
    );
    return [...new Set(names)];
}

function activityItemTitle(item: NativeSessionItemBuffer, language: SessionUiLanguage): string {
    const skills = activitySkillNames([item]);
    if (skills.length > 0) return language === 'zh-CN' ? `读取 ${skills.join('、')} 技能` : `Read ${skills.join(', ')} ${skills.length === 1 ? 'skill' : 'skills'}`;
    const payload = item.payload;
    const type = normalizeType(item.type);
    if (type === 'commandexecution' || type === 'command') {
        const command = singleLine(commandText(payload.command) ?? item.text.trim());
        const prefix = commandStatusPrefix(item.status, language);
        return command ? `${prefix} ${truncate(command, 120)}` : language === 'zh-CN' ? `${prefix}命令` : `${prefix} command`;
    }
    if (type === 'websearch') {
        const query = primitive(payload.query);
        return query ? (language === 'zh-CN' ? `搜索 ${query}` : `Searched ${query}`) : language === 'zh-CN' ? '搜索网页' : 'Searched the web';
    }
    if (type === 'imageview') return language === 'zh-CN' ? '查看图片' : 'Viewed image';
    if (type === 'filechange' || type === 'file') {
        const path = primitive(payload.path ?? payload.filePath);
        return path ? (language === 'zh-CN' ? `变更 ${path}` : `Changed ${path}`) : language === 'zh-CN' ? '变更文件' : 'Changed file';
    }
    const tool = primitive(payload.toolName ?? payload.name ?? payload.server);
    return tool ? (language === 'zh-CN' ? `使用 ${tool}` : `Used ${tool}`) : language === 'zh-CN' ? '使用工具' : 'Used tool';
}

function activityItemIcon(item: NativeSessionItemBuffer) {
    const type = normalizeType(item.type);
    if (type === 'commandexecution' || type === 'command') return TerminalWindow;
    if (type === 'websearch') return MagnifyingGlass;
    if (type === 'imageview') return Image;
    if (type === 'filechange' || type === 'file') return FileText;
    return Wrench;
}

function activityItemDetail(item: NativeSessionItemBuffer): {
    command: string | null;
    cwd: string | null;
    output: string | null
} | null {
    const command = commandText(item.payload.command);
    const cwd = primitive(item.payload.cwd);
    const output = primitive(item.payload.aggregatedOutput ?? item.payload.output ?? item.payload.stdout ?? item.payload.stderr);
    return command || cwd || output ? {command, cwd, output} : null;
}

function commandActions(item: NativeSessionItemBuffer): Record<string, unknown>[] {
    return Array.isArray(item.payload.commandActions) ? item.payload.commandActions.filter(isRecord) : [];
}

function commandText(value: unknown): string | null {
    if (Array.isArray(value)) {
        const parts = value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()));
        return parts.length > 0 ? parts.join(' ') : null;
    }
    return primitive(value);
}

function commandStatusPrefix(status: string, language: SessionUiLanguage): string {
    if (language === 'zh-CN') return status === 'completed' ? '已运行' : status === 'failed' ? '运行失败' : '正在运行';
    return status === 'completed' ? 'Ran' : status === 'failed' ? 'Failed' : 'Running';
}

function planStatusLabel(status: 'pending' | 'inProgress' | 'completed', language: SessionUiLanguage): string {
    if (language === 'zh-CN') return status === 'completed' ? '已完成' : status === 'inProgress' ? '进行中' : '待处理';
    return status === 'completed' ? 'Completed' : status === 'inProgress' ? 'In progress' : 'Pending';
}

function turnDurationMs(turn: NativeTurnSnapshot, now: number): number | null {
    if (!turn.startedAt) return null;
    const startedAt = Date.parse(turn.startedAt);
    const endedAt = turn.completedAt ? Date.parse(turn.completedAt) : now;
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return null;
    return endedAt - startedAt;
}

function formatDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return [hours > 0 ? `${hours}h` : null, minutes > 0 || hours > 0 ? `${minutes}m` : null, `${seconds}s`].filter(Boolean).join(' ');
}

function truncate(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function singleLine(value: string): string {
    return value.replace(/\s+/gu, ' ').trim();
}

function normalizeType(value: string): string {
    return value.toLocaleLowerCase().replace(/[\s_\-/]+/g, '');
}

function primitive(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
