import { type FocusEvent, type KeyboardEvent, memo, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon as Circle } from '@phosphor-icons/react/dist/csr/Circle';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { BookOpenIcon as BookOpen } from '@phosphor-icons/react/dist/csr/BookOpen';
import { ImageIcon as Image } from '@phosphor-icons/react/dist/csr/Image';
import { ListChecksIcon as ListChecks } from '@phosphor-icons/react/dist/csr/ListChecks';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PlugsIcon as Plugs } from '@phosphor-icons/react/dist/csr/Plugs';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { WrenchIcon as Wrench } from '@phosphor-icons/react/dist/csr/Wrench';
import type { ConversationFileLocation, ConversationOpenTarget, ConversationResource, ConversationResourcePreview } from '@zeus/shared';
import { ConversationResourceCards, defaultOpenTarget, isImageResource } from './ConversationResources.js';
import { isAssistantDeliverableItem, type NativePendingRequest, type NativeSessionItemBuffer, type NativeTurnPlanSnapshot, type NativeTurnSnapshot } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

const operationalTypes = new Set(['commandexecution', 'command', 'mcptoolcall', 'dynamictoolcall', 'websearch', 'imageview', 'toolcall', 'tool', 'filechange', 'file', 'contextcompaction', 'providerevent']);
const MAX_ACTIVITY_OUTPUT_CHARACTERS = 40_000;

export function isOperationalActivityItem(item: NativeSessionItemBuffer): boolean {
  if (isAssistantDeliverableItem(item)) return false;
  const type = normalizeType(item.type);
  if (type === 'contextcompaction' && item.status === 'failed') return false;
  return operationalTypes.has(type);
}

export type SessionActivityCategory = 'commands' | 'tools' | 'files' | 'context' | 'mixed';

export function activityCategory(item: NativeSessionItemBuffer): SessionActivityCategory {
  const type = normalizeType(item.type);
  if (type === 'commandexecution' || type === 'command') return 'commands';
  if (type === 'filechange' || type === 'file') return 'files';
  if (type === 'contextcompaction') return 'context';
  return 'tools';
}

interface SessionActivityGroupProps {
  items: NativeSessionItemBuffer[];
  language: SessionUiLanguage;
  category: SessionActivityCategory;
  motionActive?: boolean;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
}

export const SessionActivityGroup = memo(function SessionActivityGroup(props: SessionActivityGroupProps) {
  const liveItem = [...props.items].reverse().find((item) => item.status !== 'completed' && item.status !== 'failed') ?? null;
  const active = Boolean(liveItem);
  const summary = activitySummary(props.items, props.language, active);
  const imageResources = activityImageResources(props.items);
  const detailItems = imageResources.length > 0 ? props.items.filter((item) => normalizeType(item.type) !== 'imageview' || item.resources.length === 0) : props.items;
  const [open, setOpen] = useState(false);
  const previousActiveRef = useRef(active);
  const GroupIcon = activityGroupIcon(props.items, liveItem);

  useEffect(() => {
    if (previousActiveRef.current && !active) setOpen(false);
    previousActiveRef.current = active;
  }, [active]);

  return (
    <section className="session-activity-group" data-active={active || undefined} data-activity-category={props.category} data-item-count={props.items.length} data-motion-active={props.motionActive || undefined} aria-label={summary}>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className="session-activity-group-icon" aria-hidden="true">
            <GroupIcon weight="regular" />
          </span>
          <span>{summary}</span>
          <CaretDown className="session-activity-caret" aria-hidden="true" weight="bold" />
        </summary>
        {open ? (
          <div className="session-activity-body">
            {detailItems.length > 0 ? (
              <ol>
                {detailItems.map((item) => (
                  <ActivityItemRow key={item.key} item={item} language={props.language} motionActive={Boolean(active && props.motionActive && item.key === liveItem?.key)} onOpenResource={props.onOpenResource} />
                ))}
              </ol>
            ) : null}
            {imageResources.length > 0 ? (
              <div className="session-activity-images">
                <ConversationResourceCards resources={imageResources} language={props.language} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
              </div>
            ) : null}
          </div>
        ) : null}
      </details>
      {liveItem && !open ? <ActivityLiveRow item={liveItem} language={props.language} /> : null}
    </section>
  );
}, sameActivityGroupProps);

function sameActivityGroupProps(previous: Readonly<SessionActivityGroupProps>, next: Readonly<SessionActivityGroupProps>): boolean {
  if (
    previous.language !== next.language ||
    previous.category !== next.category ||
    previous.motionActive !== next.motionActive ||
    previous.onOpenResource !== next.onOpenResource ||
    previous.onLoadResourcePreview !== next.onLoadResourcePreview ||
    previous.items.length !== next.items.length
  )
    return false;
  return previous.items.every((item, index) => item === next.items[index]);
}

export function isLiveActivityItem(item: Pick<NativeSessionItemBuffer, 'status'>): boolean {
  return item.status !== 'completed' && item.status !== 'failed';
}

function ActivityLiveRow(props: { item: NativeSessionItemBuffer; language: SessionUiLanguage }) {
  const Icon = activityItemIcon(props.item);
  return (
    <p className="session-activity-live" role="status" aria-live="polite" aria-atomic="true">
      <span className="session-activity-item-icon" aria-hidden="true">
        <Icon weight="regular" />
      </span>
      <span>{activityItemTitle(props.item, props.language)}</span>
    </p>
  );
}

const ActivityItemRow = memo(function ActivityItemRow(props: {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  motionActive?: boolean;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
}) {
  const title = activityItemTitle(props.item, props.language);
  const detail = activityItemDetail(props.item);
  const target = activityItemTarget(props.item, props.language);
  const [open, setOpen] = useState(false);
  const Icon = activityItemIcon(props.item);
  const outputPreview = open && detail?.output ? activityOutputPreview(detail.output) : null;
  const titleNode = target ? (
    <span className="session-activity-item-title">
      <span>{target.prefix}</span>{' '}
      <button type="button" className="session-activity-resource-link" title={target.title} onClick={() => void props.onOpenResource?.(target.resource, defaultOpenTarget(target.resource))}>
        {target.label}
      </button>
    </span>
  ) : (
    <span className="session-activity-item-title">{title}</span>
  );
  return (
    <li data-status={props.item.status} data-motion-active={props.motionActive || undefined}>
      <span className="session-activity-item-icon" aria-hidden="true">
        <Icon weight="regular" />
      </span>
      <div className="session-activity-item-copy">
        {detail ? (
          <details className="session-activity-item-detail" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary className="session-activity-item-summary">
              {titleNode}
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
          titleNode
        )}
      </div>
    </li>
  );
});

function activityOutputPreview(output: string): { text: string; truncated: boolean } {
  if (output.length <= MAX_ACTIVITY_OUTPUT_CHARACTERS) return { text: output, truncated: false };
  return { text: output.slice(0, MAX_ACTIVITY_OUTPUT_CHARACTERS), truncated: true };
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
                    <span className="session-plan-step-icon" aria-hidden="true">
                      <StepIcon weight={step.status === 'completed' ? 'fill' : 'regular'} />
                    </span>
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

export function isActiveSessionTurn(turn: NativeTurnSnapshot): boolean {
  return !turn.completedAt && (turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching');
}

export function SessionTurnDuration(props: { turn: NativeTurnSnapshot; requests: NativePendingRequest[]; language: SessionUiLanguage; children?: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  const active = isActiveSessionTurn(props.turn);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const duration = useMemo(() => turnDurationMs(props.turn, props.requests, now), [now, props.requests, props.turn]);
  if (duration === null) return null;
  const value = formatDuration(duration, props.language);
  const label = props.language === 'zh-CN' ? `已处理 ${value}` : active ? `Processing for ${value}` : `Processed in ${value}`;
  const hasDetails = props.children !== undefined && props.children !== null;
  const time = <time dateTime={`PT${Math.max(0, Math.round(duration / 1_000))}S`}>{label}</time>;
  return (
    <section className="session-turn-duration" data-active={active || undefined}>
      {hasDetails ? <div className="session-turn-duration-body">{props.children}</div> : null}
      <p>{time}</p>
    </section>
  );
}

export function SessionTurnProcessDisclosure(props: {
  language: SessionUiLanguage;
  children: ReactNode;
  onOpen?: () => void | Promise<void>;
  loading?: boolean;
  error?: string | null;
  labelKind?: 'process' | 'details';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = props.open ?? internalOpen;
  const bodyId = useId();
  const label =
    props.labelKind === 'details'
      ? props.language === 'zh-CN'
        ? open
          ? '收起轮次详情'
          : '查看轮次详情'
        : open
          ? 'Hide turn details'
          : 'View turn details'
      : props.language === 'zh-CN'
        ? open
          ? '收起处理过程'
          : '查看处理过程'
        : open
          ? 'Hide process'
          : 'View process';
  return (
    <section className="session-turn-process" data-open={open || undefined} aria-busy={props.loading || undefined}>
      <div className="session-turn-process-control">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            const nextOpen = !open;
            if (props.open === undefined) setInternalOpen(nextOpen);
            props.onOpenChange?.(nextOpen);
            if (nextOpen) void Promise.resolve(props.onOpen?.()).catch(() => undefined);
          }}
        >
          <span>{label}</span>
          <CaretDown className="session-turn-process-caret" aria-hidden="true" weight="bold" />
        </button>
      </div>
      <div id={bodyId} className="session-turn-process-body" hidden={!open}>
        {open ? (
          <>
            {props.children}
            {props.loading ? (
              <p className="session-v2-page-status" role="status">
                {props.labelKind === 'details' ? (props.language === 'zh-CN' ? '正在读取这轮的详情…' : 'Loading this turn’s details…') : props.language === 'zh-CN' ? '正在读取这轮的处理过程…' : 'Loading this turn’s process…'}
              </p>
            ) : null}
            {props.error ? (
              <p className="session-v2-page-error" role="alert">
                {props.error}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function activitySummary(items: NativeSessionItemBuffer[], language: SessionUiLanguage, active = false): string {
  const compactions = items.filter((item) => normalizeType(item.type) === 'contextcompaction');
  if (compactions.length === items.length) {
    return language === 'zh-CN' ? (active ? '正在整理较早对话以继续工作' : '已整理较早对话') : active ? 'Organizing earlier conversation to continue' : 'Organized earlier conversation';
  }
  const fileChanges = items.filter((item) => ['filechange', 'file'].includes(normalizeType(item.type))).length;
  const skills = activitySkillNames(items);
  const commandItems = items.filter((item) => ['commandexecution', 'command'].includes(normalizeType(item.type)));
  const webSearches = items.filter((item) => normalizeType(item.type) === 'websearch').length;
  const imageViews = items.filter((item) => normalizeType(item.type) === 'imageview').length;
  const actionTypes = new Set(commandItems.flatMap((item) => commandActions(item).map((action) => normalizeType(primitive(action.type) ?? ''))));
  const genericCommandCount = commandItems.filter((item) => {
    const actions = commandActions(item);
    if (actions.length === 0) return true;
    if (activitySkillNames([item]).length > 0 && actions.every((action) => ['read', 'listfiles'].includes(normalizeType(primitive(action.type) ?? '')))) return false;
    return actions.some((action) => !['read', 'listfiles', 'search'].includes(normalizeType(primitive(action.type) ?? '')));
  }).length;
  const otherTools = items.filter((item) => !['commandexecution', 'command', 'websearch', 'imageview', 'filechange', 'file', 'contextcompaction'].includes(normalizeType(item.type))).length;
  if (language === 'zh-CN') {
    if (active) {
      const activeParts = [
        fileChanges > 0 ? '编辑文件' : null,
        actionTypes.has('read') || actionTypes.has('listfiles') ? '读取文件' : null,
        actionTypes.has('search') ? '搜索文件' : null,
        webSearches > 0 ? '搜索网页' : null,
        skills.length > 0 ? '读取技能' : null,
        imageViews > 0 ? '查看图像' : null,
        genericCommandCount > 0 ? '运行命令' : null,
        otherTools > 0 ? '使用工具' : null,
      ].filter(Boolean);
      return `正在处理：${activeParts.join('、')}`;
    }
    const completedParts = [
      fileChanges > 0 ? '编辑了文件' : null,
      actionTypes.has('read') || actionTypes.has('listfiles') ? '读取文件' : null,
      actionTypes.has('search') ? '搜索文件' : null,
      webSearches > 0 ? '搜索了网页' : null,
      skills.length > 0 ? `读取了${skills.length === 1 ? skills[0] : `${skills.length} 个`}技能` : null,
      imageViews > 0 ? `查看了 ${imageViews} 张图像` : null,
      genericCommandCount > 0 ? '运行了命令' : null,
      otherTools > 0 ? '使用了工具' : null,
    ].filter(Boolean);
    return completedParts.join('') || '完成了处理';
  }
  const englishParts = [
    fileChanges > 0 ? (active ? 'editing files' : 'edited files') : null,
    actionTypes.has('read') || actionTypes.has('listfiles') ? (active ? 'reading files' : 'read files') : null,
    actionTypes.has('search') ? (active ? 'searching files' : 'searched files') : null,
    webSearches > 0 ? (active ? 'searching the web' : 'searched the web') : null,
    skills.length > 0 ? `${active ? 'reading' : 'read'} ${skills.length === 1 ? skills[0] : `${skills.length} skills`}` : null,
    imageViews > 0 ? `${active ? 'viewing' : 'viewed'} ${imageViews} ${imageViews === 1 ? 'image' : 'images'}` : null,
    genericCommandCount > 0 ? (active ? 'running commands' : 'ran commands') : null,
    otherTools > 0 ? (active ? 'using tools' : 'used tools') : null,
  ].filter(Boolean);
  return `${active ? 'Working: ' : ''}${englishParts.join(', ') || (active ? 'processing' : 'completed work')}`;
}

function activityImageResources(items: NativeSessionItemBuffer[]): ConversationResource[] {
  const resources = items.flatMap((item) => item.resources).filter(isImageResource);
  const unique = new Map<string, ConversationResource>();
  for (const resource of resources)
    unique.set(
      resource.id,
      resource.presentation === 'card'
        ? resource
        : {
            ...resource,
            presentation: 'card',
          },
    );
  return [...unique.values()];
}

function activityGroupIcon(items: NativeSessionItemBuffer[], liveItem: NativeSessionItemBuffer | null) {
  if (items.some((item) => ['filechange', 'file'].includes(normalizeType(item.type)))) return PencilSimple;
  if (items.every((item) => normalizeType(item.type) === 'imageview')) return Image;
  if (items.every((item) => activitySkillNames([item]).length > 0)) return Wrench;
  if (liveItem) return activityItemIcon(liveItem);
  if (items.some((item) => commandActions(item).some((action) => normalizeType(primitive(action.type) ?? '') === 'search') || normalizeType(item.type) === 'websearch')) return MagnifyingGlass;
  if (items.some((item) => commandActions(item).some((action) => ['read', 'listfiles'].includes(normalizeType(primitive(action.type) ?? ''))))) return BookOpen;
  return activityItemIcon(items[items.length - 1]!);
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
        ? `${active ? '正在编辑' : '已编辑'} ${path}`
        : `${active ? 'Changing' : 'Changed'} ${path}`
      : language === 'zh-CN'
        ? active
          ? '正在编辑文件'
          : '已编辑文件'
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

function activityItemTarget(
  item: NativeSessionItemBuffer,
  language: SessionUiLanguage,
): {
  prefix: string;
  label: string;
  title: string;
  resource: ConversationResource;
} | null {
  const resource = item.resources.find((candidate) => candidate.kind === 'file' || candidate.kind === 'website');
  if (!resource) return null;
  const type = normalizeType(item.type);
  const actionType = normalizeType(primitive(commandActions(item)[0]?.type) ?? '');
  const active = isLiveActivityItem(item);
  const prefix =
    language === 'zh-CN'
      ? type === 'filechange' || type === 'file'
        ? active
          ? '正在编辑'
          : '已编辑'
        : actionType === 'read' || actionType === 'listfiles'
          ? active
            ? '正在读取'
            : '已读取'
          : type === 'websearch' || actionType === 'search'
            ? active
              ? '正在搜索'
              : '已搜索'
            : active
              ? '正在使用'
              : '已使用'
      : type === 'filechange' || type === 'file'
        ? active
          ? 'Editing'
          : 'Edited'
        : actionType === 'read' || actionType === 'listfiles'
          ? active
            ? 'Reading'
            : 'Read'
          : type === 'websearch' || actionType === 'search'
            ? active
              ? 'Searching'
              : 'Searched'
            : active
              ? 'Using'
              : 'Used';
  return {
    prefix,
    label: resource.displayName,
    title: resource.kind === 'file' ? resource.projectRelativePath : resource.url,
    resource,
  };
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

function formatDuration(durationMs: number, language: SessionUiLanguage): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (language === 'zh-CN') {
    return [hours > 0 ? `${hours}时` : null, minutes > 0 || hours > 0 ? `${minutes}分` : null, `${seconds}秒`].filter(Boolean).join('');
  }
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
