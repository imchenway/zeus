import {type FocusEvent, type KeyboardEvent, memo, useEffect, useId, useMemo, useRef, useState} from 'react';
import {CaretDownIcon as CaretDown} from '@phosphor-icons/react/dist/csr/CaretDown';
import {CheckCircleIcon as CheckCircle} from '@phosphor-icons/react/dist/csr/CheckCircle';
import {CircleIcon as Circle} from '@phosphor-icons/react/dist/csr/Circle';
import {CircleNotchIcon as CircleNotch} from '@phosphor-icons/react/dist/csr/CircleNotch';
import {BookOpenIcon as BookOpen} from '@phosphor-icons/react/dist/csr/BookOpen';
import {ImageIcon as Image} from '@phosphor-icons/react/dist/csr/Image';
import {ListChecksIcon as ListChecks} from '@phosphor-icons/react/dist/csr/ListChecks';
import {MagnifyingGlassIcon as MagnifyingGlass} from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import {PencilSimpleIcon as PencilSimple} from '@phosphor-icons/react/dist/csr/PencilSimple';
import {PlugsIcon as Plugs} from '@phosphor-icons/react/dist/csr/Plugs';
import {TerminalWindowIcon as TerminalWindow} from '@phosphor-icons/react/dist/csr/TerminalWindow';
import {WrenchIcon as Wrench} from '@phosphor-icons/react/dist/csr/Wrench';
import type {
    NativePendingRequest,
    NativeSessionItemBuffer,
    NativeTurnPlanSnapshot,
    NativeTurnSnapshot
} from './sessionTypes.js';
import type {SessionUiLanguage} from './ThreadItemView.js';

const operationalTypes = new Set(['commandexecution', 'command', 'mcptoolcall', 'dynamictoolcall', 'websearch', 'imageview', 'toolcall', 'tool', 'filechange', 'file', 'contextcompaction']);
const MAX_ACTIVITY_OUTPUT_CHARACTERS = 40_000;

export function isOperationalActivityItem(item: NativeSessionItemBuffer): boolean {
  const type = normalizeType(item.type);
  if (type === 'contextcompaction' && item.status === 'failed') return false;
  return operationalTypes.has(type);
}

export const SessionActivityGroup = memo(function SessionActivityGroup(props: {
    items: NativeSessionItemBuffer[];
    language: SessionUiLanguage
}) {
  const liveItem = [...props.items].reverse().find((item) => item.status !== 'completed' && item.status !== 'failed') ?? null;
  const active = Boolean(liveItem);
  const summary = activitySummary(props.items, props.language, active);
  const skillNames = activitySkillNames(props.items);
  const [open, setOpen] = useState(false);
  const previousActiveRef = useRef(active);
  const GroupIcon = activityItemIcon(liveItem ?? props.items[props.items.length - 1]!);

  useEffect(() => {
    if (previousActiveRef.current && !active) setOpen(false);
    previousActiveRef.current = active;
  }, [active]);

  return (
    <section className="session-activity-group" data-active={active || undefined} aria-label={props.language === 'zh-CN' ? '工作活动' : 'Work activity'}>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <GroupIcon aria-hidden="true" weight="regular" />
          <span>{summary}</span>
          <CaretDown className="session-activity-caret" aria-hidden="true" weight="bold" />
        </summary>
          {open ? (
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
          ) : null}
      </details>
      {liveItem && !open ? <ActivityLiveRow item={liveItem} language={props.language} /> : null}
    </section>
  );
}, sameActivityGroupProps);

function sameActivityGroupProps(previous: Readonly<{
    items: NativeSessionItemBuffer[];
    language: SessionUiLanguage
}>, next: Readonly<{ items: NativeSessionItemBuffer[]; language: SessionUiLanguage }>): boolean {
    if (previous.language !== next.language || previous.items.length !== next.items.length) return false;
    return previous.items.every((item, index) => item === next.items[index]);
}

function ActivityLiveRow(props: { item: NativeSessionItemBuffer; language: SessionUiLanguage }) {
  const Icon = activityItemIcon(props.item);
  return (
    <p className="session-activity-live" key={`${props.item.key}:${props.item.updatedAt ?? props.item.status}`} role="status" aria-live="polite" aria-atomic="true">
      <span className="session-activity-item-icon" aria-hidden="true">
        <Icon weight="regular" />
      </span>
      <span>{activityItemTitle(props.item, props.language)}</span>
    </p>
  );
}

const ActivityItemRow = memo(function ActivityItemRow(props: {
    item: NativeSessionItemBuffer;
    language: SessionUiLanguage
}) {
  const title = activityItemTitle(props.item, props.language);
  const detail = activityItemDetail(props.item);
    const [open, setOpen] = useState(false);
  const Icon = activityItemIcon(props.item);
    const outputPreview = open && detail?.output ? activityOutputPreview(detail.output) : null;
  return (
    <li data-status={props.item.status}>
      <span className="session-activity-item-icon" aria-hidden="true">
        <Icon weight="regular" />
      </span>
      <div className="session-activity-item-copy">
        {detail ? (
            <details className="session-activity-item-detail" open={open}
                     onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary className="session-activity-item-summary">
              <span className="session-activity-item-title">{title}</span>
              <CaretDown className="session-activity-item-caret" aria-hidden="true" weight="bold" />
            </summary>
                {open ? (
                    <div className="session-activity-item-detail-body">
                        {detail.command ? <code>{detail.command}</code> : null}
                        {detail.cwd ? <small>{detail.cwd}</small> : null}
                        {outputPreview ? <pre>{outputPreview.text}</pre> : null}
                        {outputPreview?.truncated ? (
                            <small>
                                {props.language === 'zh-CN'
                                    ? `输出较大，仅显示前 ${MAX_ACTIVITY_OUTPUT_CHARACTERS.toLocaleString('zh-CN')} 个字符。`
                                    : `Large output; showing the first ${MAX_ACTIVITY_OUTPUT_CHARACTERS.toLocaleString('en-US')} characters.`}
                            </small>
                        ) : null}
                    </div>
                ) : null}
          </details>
        ) : (
          <span className="session-activity-item-title">{title}</span>
        )}
      </div>
    </li>
  );
});

function activityOutputPreview(output: string): { text: string; truncated: boolean } {
    if (output.length <= MAX_ACTIVITY_OUTPUT_CHARACTERS) return {text: output, truncated: false};
    return {text: output.slice(0, MAX_ACTIVITY_OUTPUT_CHARACTERS), truncated: true};
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
    <section className="session-plan-dock" onPointerEnter={show} onPointerLeave={scheduleClose} onFocusCapture={show} onBlurCapture={handleBlur} onKeyDown={handleKeyDown}>
      <div className="session-plan-progress" data-open={open || undefined}>
        <button ref={triggerRef} type="button" className="session-plan-trigger" aria-expanded={open} aria-controls={popoverId} onClick={show}>
          <ListChecks aria-hidden="true" weight="regular" />
          <span role="status" aria-live="polite" aria-atomic="true">
            <strong>{summary}</strong>
            <small>{current?.step}</small>
          </span>
          <CaretDown className="session-plan-caret" aria-hidden="true" weight="bold" />
        </button>
        <div id={popoverId} className="session-plan-popover" hidden={!open}>
          <div className="session-plan-body">
            {props.plan.explanation ? <p className="zeus-fidelity-text">{props.plan.explanation}</p> : null}
            <ol>
              {steps.map((step, index) => {
                const StepIcon = step.status === 'completed' ? CheckCircle : step.status === 'inProgress' ? CircleNotch : Circle;
                return (
                  <li key={`${index}-${step.step}`} data-status={step.status}>
                    <StepIcon aria-hidden="true" weight={step.status === 'completed' ? 'fill' : 'regular'} />
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

export function SessionTurnDuration(props: { turn: NativeTurnSnapshot; requests: NativePendingRequest[]; language: SessionUiLanguage }) {
  const [now, setNow] = useState(() => Date.now());
  const active = !props.turn.completedAt && (props.turn.status === 'running' || props.turn.status === 'waiting' || props.turn.status === 'dispatching');
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const duration = useMemo(() => turnDurationMs(props.turn, props.requests, now), [now, props.requests, props.turn]);
  if (duration === null) return null;
  const value = formatDuration(duration);
  const label = props.language === 'zh-CN' ? `已处理 ${value}` : active ? `Processing for ${value}` : `Processed in ${value}`;
  return (
    <p className="session-turn-duration" data-active={active || undefined}>
      <time dateTime={`PT${Math.max(0, Math.round(duration / 1_000))}S`}>{label}</time>
    </p>
  );
}

function activitySummary(items: NativeSessionItemBuffer[], language: SessionUiLanguage, active = false): string {
  const compactions = items.filter((item) => normalizeType(item.type) === 'contextcompaction');
  if (compactions.length === items.length) {
    return language === 'zh-CN' ? (active ? '正在整理较早对话以继续工作' : '已整理较早对话') : active ? 'Organizing earlier conversation to continue' : 'Organized earlier conversation';
  }
  const skills = activitySkillNames(items);
  if (skills.length > 0) {
    if (language === 'zh-CN') return `${active ? '正在加载' : '已加载'} ${skills.length} 个技能`;
    return `${active ? 'Loading' : 'Loaded'} ${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}`;
  }
  const commands = items.filter((item) => ['commandexecution', 'command'].includes(normalizeType(item.type))).length;
  const tools = items.length - commands;
  const actionTypes = new Set(items.flatMap((item) => commandActions(item).map((action) => primitive(action.type))).filter((value): value is string => Boolean(value)));
  if (commands > 0 && tools === 0) {
    if (language === 'zh-CN') {
      if (actionTypes.has('search')) return `${active ? '正在搜索文件并运行' : '已搜索文件并运行'} ${commands} 个命令`;
      if (actionTypes.has('read') || actionTypes.has('listFiles')) return `${active ? '正在读取文件并运行' : '已读取文件并运行'} ${commands} 个命令`;
      return `${active ? '正在运行' : '已运行'} ${commands} 个命令`;
    }
    if (actionTypes.has('search')) return `${active ? 'Searching files and running' : 'Searched files and ran'} ${commands} ${commands === 1 ? 'command' : 'commands'}`;
    if (actionTypes.has('read') || actionTypes.has('listFiles')) return `${active ? 'Reading files and running' : 'Read files and ran'} ${commands} ${commands === 1 ? 'command' : 'commands'}`;
    return `${active ? 'Running' : 'Ran'} ${commands} ${commands === 1 ? 'command' : 'commands'}`;
  }
  if (commands === 0) return language === 'zh-CN' ? `${active ? '正在使用' : '已使用'} ${tools} 个工具` : `${active ? 'Using' : 'Used'} ${tools} ${tools === 1 ? 'tool' : 'tools'}`;
  return language === 'zh-CN' ? `${active ? '正在运行' : '已运行'} ${commands} 个命令并使用 ${tools} 个工具` : `${active ? 'Running' : 'Ran'} ${commands} commands and ${active ? 'using' : 'used'} ${tools} tools`;
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
  if (skills.length > 0) {
    const active = item.status !== 'completed' && item.status !== 'failed';
    return language === 'zh-CN' ? `${active ? '正在读取' : '已读取'} ${skills.join('、')} 技能` : `${active ? 'Reading' : 'Read'} ${skills.join(', ')} ${skills.length === 1 ? 'skill' : 'skills'}`;
  }
  const payload = item.payload;
  const type = normalizeType(item.type);
  if (type === 'contextcompaction') {
    const active = item.status !== 'completed' && item.status !== 'failed';
    return language === 'zh-CN' ? (active ? '正在整理较早对话以继续工作' : '已整理较早对话') : active ? 'Organizing earlier conversation to continue' : 'Organized earlier conversation';
  }
  if (type === 'commandexecution' || type === 'command') {
    const actionTitle = commandActionTitle(item, language);
    if (actionTitle) return actionTitle;
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
    const active = item.status !== 'completed' && item.status !== 'failed';
    return path
      ? language === 'zh-CN'
        ? `${active ? '正在变更' : '已变更'} ${path}`
        : `${active ? 'Changing' : 'Changed'} ${path}`
      : language === 'zh-CN'
        ? active
          ? '正在变更文件'
          : '已变更文件'
        : active
          ? 'Changing file'
          : 'Changed file';
  }
  const tool = primitive(payload.toolName ?? payload.name ?? payload.server);
  const progress = presentationLiveText(item);
  if (progress) return progress;
  const active = item.status !== 'completed' && item.status !== 'failed';
  return tool ? (language === 'zh-CN' ? `${active ? '正在使用' : '已使用'} ${tool}` : `${active ? 'Using' : 'Used'} ${tool}`) : language === 'zh-CN' ? (active ? '正在使用工具' : '已使用工具') : active ? 'Using tool' : 'Used tool';
}

function activityItemIcon(item: NativeSessionItemBuffer) {
  const type = normalizeType(item.type);
  if (type === 'commandexecution' || type === 'command') {
    const actionType = primitive(commandActions(item)[0]?.type);
    if (actionType === 'read' || actionType === 'listFiles') return BookOpen;
    if (actionType === 'search') return MagnifyingGlass;
    return TerminalWindow;
  }
  if (type === 'websearch') return MagnifyingGlass;
  if (type === 'imageview') return Image;
  if (type === 'contextcompaction') return BookOpen;
  if (type === 'filechange' || type === 'file') return PencilSimple;
  if (type === 'mcptoolcall') return Plugs;
  if (type === 'dynamictoolcall' || type === 'toolcall' || type === 'tool') return Wrench;
  return Wrench;
}

function activityItemDetail(item: NativeSessionItemBuffer): {
  command: string | null;
  cwd: string | null;
  output: string | null;
} | null {
  const command = commandText(item.payload.command);
  const cwd = primitive(item.payload.cwd);
  const output = primitive(item.payload.aggregatedOutput ?? item.payload.output ?? item.payload.stdout ?? item.payload.stderr) ?? presentationLiveText(item);
  return command || cwd || output ? { command, cwd, output } : null;
}

function commandActionTitle(item: NativeSessionItemBuffer, language: SessionUiLanguage): string | null {
  const action = commandActions(item)[0];
  const actionType = primitive(action?.type);
  if (!actionType) return null;
  const target = primitive(action?.path ?? action?.filePath ?? action?.query ?? action?.pattern);
  const active = item.status !== 'completed' && item.status !== 'failed';
  if (actionType === 'read' || actionType === 'listFiles') {
    const verb = language === 'zh-CN' ? (active ? '正在读取' : '已读取') : active ? 'Reading' : 'Read';
    return target ? `${verb} ${truncate(target, 120)}` : language === 'zh-CN' ? `${verb}文件` : `${verb} files`;
  }
  if (actionType === 'search') {
    const verb = language === 'zh-CN' ? (active ? '正在搜索' : '已搜索') : active ? 'Searching' : 'Searched';
    return target ? `${verb} ${truncate(target, 120)}` : language === 'zh-CN' ? `${verb}文件` : `${verb} files`;
  }
  return null;
}

function presentationLiveText(item: NativeSessionItemBuffer): string | null {
  const presentation = isRecord(item.payload.presentation) ? item.payload.presentation : {};
  return primitive(presentation.liveText);
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

function turnDurationMs(turn: NativeTurnSnapshot, requests: NativePendingRequest[], now: number): number | null {
  if (!turn.startedAt) return null;
  const startedAt = Date.parse(turn.startedAt);
  const endedAt = turn.completedAt ? Date.parse(turn.completedAt) : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return null;
  const waitIntervals = requests
    .filter((request) => request.turnId === turn.id || (turn.providerTurnId !== null && request.turnId === turn.providerTurnId))
    .flatMap((request) => {
      const waitStartedAt = Date.parse(request.createdAt);
      const waitEndedAt = request.resolvedAt ? Date.parse(request.resolvedAt) : endedAt;
      if (!Number.isFinite(waitStartedAt) || !Number.isFinite(waitEndedAt)) return [];
      const intervalStart = Math.max(startedAt, waitStartedAt);
      const intervalEnd = Math.min(endedAt, waitEndedAt);
      return intervalEnd > intervalStart ? [{ start: intervalStart, end: intervalEnd }] : [];
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let waitingMs = 0;
  let mergedStart = -1;
  let mergedEnd = -1;
  for (const interval of waitIntervals) {
    if (mergedStart < 0) {
      mergedStart = interval.start;
      mergedEnd = interval.end;
      continue;
    }
    if (interval.start <= mergedEnd) {
      mergedEnd = Math.max(mergedEnd, interval.end);
      continue;
    }
    waitingMs += mergedEnd - mergedStart;
    mergedStart = interval.start;
    mergedEnd = interval.end;
  }
  if (mergedStart >= 0) waitingMs += mergedEnd - mergedStart;
  return Math.max(0, endedAt - startedAt - waitingMs);
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
