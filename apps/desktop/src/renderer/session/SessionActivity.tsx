import { Collapsible } from '../ui/Collapsible.js';
import { AnimatedSize } from '../ui/AnimatedSize.js';
import { type FocusEvent, type KeyboardEvent, createContext, useContext, memo, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { BrowserIcon as Browser } from '@phosphor-icons/react/dist/csr/Browser';
import { DesktopIcon as Desktop } from '@phosphor-icons/react/dist/csr/Desktop';
import { CubeIcon as Cube } from '@phosphor-icons/react/dist/csr/Cube';
import { activityOutcome, activityOutcomeLabel, nativeActivityTitle, nativeActivityTool } from './activityPresentation.js';
import type { ConversationFileLocation, ConversationOpenTarget, ConversationResource, ConversationResourcePreview } from '@zeus/shared';
import { ConversationResourceCards, defaultOpenTarget, isImageResource } from './ConversationResources.js';
import { isAssistantDeliverableItem, type NativeConversationToolResultPage, type NativePendingRequest, type NativeSessionItemBuffer, type NativeTurnPlanSnapshot, type NativeTurnSnapshot } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import type { CodexApiClient } from '../features/codex/codexApiClient.js';

/** 会话及其子线程共用当前连接的技能清单读取入口。 */
export const ActivitySkillCatalogContext = createContext<CodexApiClient['loadSkills'] | undefined>(undefined);

/** 冻结路径仅用于定位清单，目录哈希不作为用户可见名称。 */
const frozenSkillPath = /(?:^|[\\/])skill-resources[\\/]([a-f0-9]{64})[\\/][a-f0-9]{24}[\\/]SKILL\.md$/u;

/** 只补充展示字段，原始命令、路径和历史身份保持不变。 */
function useNamedSkillItems(items: NativeSessionItemBuffer[]): NativeSessionItemBuffer[] {
  /** 读取入口由工作区提供，避免组件自行建立服务连接。 */
  const loadSkills = useContext(ActivitySkillCatalogContext);
  /** 只在实际读取的快照集合改变时加载，流式输出不重复触发请求。 */
  const snapshotIds = [
    ...new Set(
      items.flatMap((item) =>
        commandActions(item).flatMap((action) => {
          /** 普通文件与插件目录无需请求冻结清单。 */
          const match = primitive(action.path ?? action.filePath)?.match(frozenSkillPath);
          return match ? [match[1]!] : [];
        }),
      ),
    ),
  ]
    .sort()
    .join(',');
  /** 路径和名称来自同一不可变清单，不能从当前技能目录猜测旧名称。 */
  const [resolved, setResolved] = useState<{ loader: typeof loadSkills; names: Map<string, string> } | null>(null);
  useEffect(() => {
    if (!loadSkills || !snapshotIds) return;
    /** 旧请求返回后不能覆盖已经切换的会话或连接。 */
    let cancelled = false;
    void Promise.allSettled(snapshotIds.split(',').map((id) => loadSkills(undefined, false, id))).then((results) => {
      if (cancelled) return;
      /** 缺失清单降级为通用技能标题，其余清单仍正常显示。 */
      const names = new Map<string, string>();
      for (const result of results) if (result.status === 'fulfilled') for (const skill of result.value.skills) names.set(skill.path.replace(/\\/gu, '/'), skill.name);
      setResolved({ loader: loadSkills, names });
    });
    return () => {
      cancelled = true;
    };
  }, [loadSkills, snapshotIds]);
  return useMemo(
    () =>
      items.map((item) => {
        if (!resolved || resolved.loader !== loadSkills || !commandActions(item).some((action) => primitive(action.path ?? action.filePath)?.match(frozenSkillPath))) return item;
        return { ...item, payload: { ...item.payload, commandActions: commandActions(item).map((action) => ({ ...action, skillName: resolved.names.get((primitive(action.path ?? action.filePath) ?? '').replace(/\\/gu, '/')) })) } };
      }),
    [items, resolved, loadSkills],
  );
}

const operationalTypes = new Set(['commandexecution', 'command', 'mcptoolcall', 'dynamictoolcall', 'websearch', 'imageview', 'toolcall', 'tool', 'filechange', 'file', 'contextcompaction', 'providerevent']);
/** 单次展示按四万个字符推进，关闭命令时不挂载长输出。 */
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
  /** 外层已按阶段折叠时复用外层入口，整轮摘要内才独立折叠该段操作。 */
  collapsible?: boolean;
  /** 只让本轮真实新增的稳定条目播放一次入场，历史回放保持静止。 */
  enteringItemKeys?: ReadonlySet<string>;
  motionActive?: boolean;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  onLoadToolResult?: (handle: string, offset?: number) => Promise<NativeConversationToolResultPage>;
  /** 工具详情展开后沿用会话全文补载，恢复被分页截断的长命令。 */
  onLoadContent?: (handle: string) => Promise<void>;
}

/** 每段操作复用对应范围的数量入口，避免同一段嵌套两个相同入口。 */
export const SessionActivityGroup = memo(function SessionActivityGroup(props: SessionActivityGroupProps) {
  /** 关闭列表只读取真实状态与数量，不计算操作明细或请求技能清单。 */
  const active = props.items.some((item) => activityOutcome(item) === 'running');
  /** 明细组件只由对应范围的折叠容器按需挂载。 */
  const body = <SessionActivityGroupContent {...props} />;
  return (
    <section className="session-activity-group" data-active={active || undefined} data-activity-category={props.category} data-item-count={props.items.length} data-motion-active={props.motionActive || undefined}>
      {props.collapsible ? (
        <SessionTurnProcessDisclosure language={props.language} itemCount={props.items.length}>
          {body}
        </SessionTurnProcessDisclosure>
      ) : (
        body
      )}
    </section>
  );
}, sameActivityGroupProps);

/** 用户打开操作列表后才解析标题、图片和技能名称，继续复用客户端冻结清单缓存。 */
function SessionActivityGroupContent(props: SessionActivityGroupProps) {
  /** 活动行与展开详情使用同一份名称投影。 */
  const items = useNamedSkillItems(props.items);
  const liveItem = [...items].reverse().find((item) => activityOutcome(item) === 'running') ?? null;
  const active = Boolean(liveItem);
  const imageResources = activityImageResources(items);
  const detailItems = imageResources.length > 0 ? items.filter((item) => normalizeType(item.type) !== 'imageview' || item.resources.length === 0) : items;

  // 单条整理只有在没有正文详情、资源或可加载结果时才省去明细行。
  const singleCompaction = items.length === 1 && normalizeType(items[0]!.type) === 'contextcompaction' && items[0]!.status !== 'failed' ? items[0]! : null;
  if (singleCompaction && !activityItemDetail(singleCompaction) && !activityToolResult(singleCompaction) && singleCompaction.resources.length === 0) {
    return <ActivityLiveRow item={singleCompaction} language={props.language} />;
  }

  /** 操作列表与图片共用按需展示入口，数量变化不自动展开本段操作。 */
  return (
    <AnimatedSize changeKey={items}>
      <div className="session-activity-body">
        {detailItems.length > 0 ? (
          <ol>
            {detailItems.map((item) => (
              <ActivityItemRow
                key={item.key}
                item={item}
                language={props.language}
                animateEntrance={props.enteringItemKeys?.has(item.key)}
                motionActive={Boolean(active && props.motionActive && item.key === liveItem?.key)}
                onOpenResource={props.onOpenResource}
                onLoadToolResult={props.onLoadToolResult}
                onLoadContent={props.onLoadContent}
              />
            ))}
          </ol>
        ) : null}
        {imageResources.length > 0 ? (
          <div className="session-activity-images">
            <ConversationResourceCards resources={imageResources} language={props.language} onOpenResource={props.onOpenResource} onLoadResourcePreview={props.onLoadResourcePreview} />
          </div>
        ) : null}
      </div>
    </AnimatedSize>
  );
}

function sameActivityGroupProps(previous: Readonly<SessionActivityGroupProps>, next: Readonly<SessionActivityGroupProps>): boolean {
  if (
    previous.language !== next.language ||
    previous.category !== next.category ||
    previous.collapsible !== next.collapsible ||
    previous.motionActive !== next.motionActive ||
    previous.onOpenResource !== next.onOpenResource ||
    previous.onLoadResourcePreview !== next.onLoadResourcePreview ||
    previous.onLoadToolResult !== next.onLoadToolResult ||
    previous.onLoadContent !== next.onLoadContent ||
    previous.items.length !== next.items.length
  )
    return false;
  return previous.items.every((item, index) => item === next.items[index] && previous.enteringItemKeys?.has(item.key) === next.enteringItemKeys?.has(item.key));
}

export function isLiveActivityItem(item: Pick<NativeSessionItemBuffer, 'status'>): boolean {
  return item.status !== 'completed' && item.status !== 'failed';
}

/** 简洁活动行显示当前或最近动作；只有进行中的变化需要主动播报。 */
function ActivityLiveRow(props: { item: NativeSessionItemBuffer; language: SessionUiLanguage }) {
  // 状态播报跟随真实条目，回看已完成记录时不重复宣告进度。
  const active = isLiveActivityItem(props.item);
  // 沿用活动类型对应的现有图标。
  const Icon = activityItemIcon(props.item);
  return (
    <p className="session-activity-live" role={active ? 'status' : undefined} aria-live={active ? 'polite' : undefined} aria-atomic={active ? true : undefined}>
      <span className="session-activity-item-icon" aria-hidden="true">
        <Icon weight="regular" />
      </span>
      <span>{activityItemTitle(props.item, props.language)}</span>
    </p>
  );
}

/** 操作标题随外层过程展示，命令详情默认收起且只在用户展开后挂载。 */
const ActivityItemRow = memo(function ActivityItemRow(props: {
  item: NativeSessionItemBuffer;
  language: SessionUiLanguage;
  /** 入场只由外层稳定身份判定，组件重渲染不会重复播放。 */
  animateEntrance?: boolean;
  motionActive?: boolean;
  onOpenResource?: (resource: ConversationResource, target: ConversationOpenTarget, location?: ConversationFileLocation) => void | Promise<void>;
  onLoadToolResult?: (handle: string, offset?: number) => Promise<NativeConversationToolResultPage>;
  /** 与思考正文共用现有内容句柄读取入口。 */
  onLoadContent?: (handle: string) => Promise<void>;
}) {
  const title = activityItemTitle(props.item, props.language);
  const detail = activityItemDetail(props.item);
  const target = activityItemTarget(props.item, props.language);
  /** 技能链接显示完整名称标题，保留原有文件打开入口。 */
  const skillActivity = activitySkillNames([props.item]).length > 0;
  /** 打开处理过程不自动打开命令，也不提前读取截断正文。 */
  const [open, setOpen] = useState(false);
  const Icon = activityItemIcon(props.item);
  const toolResult = activityToolResult(props.item);
  const titleNode = target ? (
    <span className="session-activity-item-title">
      {!skillActivity ? (
        <>
          <span>{target.prefix}</span>{' '}
        </>
      ) : null}
      <button type="button" className="session-activity-resource-link" title={target.title} onClick={() => void props.onOpenResource?.(target.resource, defaultOpenTarget(target.resource))}>
        {skillActivity ? title : target.label}
      </button>
    </span>
  ) : (
    <span className="session-activity-item-title">{title}</span>
  );
  return (
    <li className={props.animateEntrance ? 'is-entering' : undefined} data-status={activityOutcome(props.item)} data-motion-active={props.motionActive || undefined}>
      <span className="session-activity-item-icon" aria-hidden="true">
        <Icon weight="regular" />
      </span>
      <div className="session-activity-item-copy">
        {detail ? (
          <details
            className="session-activity-item-detail"
            open={open}
            onToggle={(event) => {
              setOpen(event.currentTarget.open);
              if (event.currentTarget.open && props.item.payload.v2ContentTruncated === true && typeof props.item.payload.v2ContentHandle === 'string') {
                void props.onLoadContent?.(props.item.payload.v2ContentHandle).catch(() => undefined);
              }
            }}
          >
            <summary className="session-activity-item-summary">
              {titleNode}
              <CaretDown className="session-activity-item-caret" aria-hidden="true" weight="bold" />
            </summary>
            {open ? (
              <div className="session-activity-item-detail-body">
                {/* 旧缓存可能只有详情句柄，读取完成前保留明确的进度反馈。 */}
                {!detail.command && !detail.cwd && !detail.output && !toolResult && props.item.payload.v2ContentTruncated === true ? <small role="status">{props.language === 'zh-CN' ? '正在读取命令…' : 'Loading command…'}</small> : null}
                {detail.command ? <code>{detail.command}</code> : null}
                {detail.cwd ? <small>{detail.cwd}</small> : null}
                {detail.output || toolResult ? <ActivityItemOutput key={toolResult?.handle ?? props.item.key} output={detail.output} toolResult={toolResult} language={props.language} onLoadToolResult={props.onLoadToolResult} /> : null}
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

/** 打开命令后按输出滚动位置补齐正文，不增加“展开剩余内容”等操作入口。 */
function ActivityItemOutput(props: { output: string | null; toolResult: ActivityToolResult | null; language: SessionUiLanguage; onLoadToolResult?: (handle: string, offset?: number) => Promise<NativeConversationToolResultPage> }) {
  /** 当前已读的不可变页，按真实偏移保留连续顺序。 */
  const [pages, setPages] = useState<NativeConversationToolResultPage[]>([]);
  /** 长的本地输出与远端输出使用相同的分段展示上限。 */
  const [visibleCharacters, setVisibleCharacters] = useState(MAX_ACTIVITY_OUTPUT_CHARACTERS);
  /** 加载状态只播报，不要求用户再点一次展开。 */
  const [loading, setLoading] = useState(false);
  /** 失败时保留已读输出并停止自动请求。 */
  const [loadError, setLoadError] = useState<unknown>(null);
  /** 同一命令一次只读取一页。 */
  const loadingRef = useRef(false);
  /** 命令收起后不把迟到的结果写回已卸载的内容。 */
  const mountedRef = useRef(true);
  /** 复用现有输出滚动区，只有读到末尾才继续展示或读取。 */
  const outputRef = useRef<HTMLPreElement>(null);
  /** 输出正文只在投影或已读页变化时合并，滚动不重复解析协议。 */
  const outputText = useMemo(() => {
    /** 已读正文不足投影长度时继续保留投影，避免首个完整页使内容缩短。 */
    const projected = normalizeActivityToolText(props.output ?? props.toolResult?.projection ?? '').text ?? '';
    /** 远端页按偏移连接后再提取工具正文。 */
    const loaded = normalizeActivityToolText(pages.map((page) => page.text).join('')).text ?? '';
    return { text: pages.at(-1)?.nextOffset === null || loaded.length >= projected.length ? loaded : projected, loadedCharacters: loaded.length, projectedCharacters: projected.length };
  }, [pages, props.output, props.toolResult?.projection]);
  /** 已读完整页优先，首段正文尚未追上投影时保留原有可见内容。 */
  const sourceOutput = outputText.text;
  /** 同一滚动区逐段增加已读文本，避免首次挂载巨量输出。 */
  const outputPreview = activityOutputPreview(sourceOutput, visibleCharacters);
  /** 后续读取沿真实游标推进，结束页不再发起请求。 */
  const lastPage = pages.at(-1) ?? null;
  /** 只有确实截断且有读取入口时才读取远端页。 */
  const canLoadMore = Boolean(props.toolResult?.handle && props.onLoadToolResult && (pages.length > 0 ? lastPage?.nextOffset !== null : props.toolResult.projectionTruncated));
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** 每次打开只准备首个有界页，之后读取由输出末尾的位置决定。 */
  const loadNextPage = useCallback(async (): Promise<void> => {
    if (!props.toolResult?.handle || !props.onLoadToolResult || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      /** 已读页必须来自同一份结果，不能拼接变化后的正文。 */
      const page = await props.onLoadToolResult(props.toolResult.handle, lastPage?.nextOffset ?? 0);
      if (!mountedRef.current) return;
      if (lastPage && (page.sha256 !== lastPage.sha256 || page.totalCharacters !== lastPage.totalCharacters)) throw new Error('工具输出在分页期间发生变化。');
      setPages((current) => [...current.filter((candidate) => candidate.offset !== page.offset), page].sort((left, right) => left.offset - right.offset));
    } catch (error) {
      if (mountedRef.current) setLoadError(error);
    } finally {
      loadingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [lastPage, props.onLoadToolResult, props.toolResult?.handle]);
  useEffect(() => {
    /** 短的投影先读取正文；内容不足一屏时补齐，长输出等待用户继续滚动。 */
    const output = outputRef.current;
    if (!output || loading || loadError || !canLoadMore) return;
    if (!lastPage || outputText.loadedCharacters < Math.min(visibleCharacters, outputText.projectedCharacters) || (!outputPreview.truncated && output.scrollHeight - output.clientHeight - output.scrollTop <= 24)) void loadNextPage();
  }, [canLoadMore, lastPage, loadError, loadNextPage, loading, outputPreview.truncated, outputText.loadedCharacters, outputText.projectedCharacters, visibleCharacters]);

  return (
    <div className="session-activity-item-output" aria-busy={loading || undefined}>
      <pre
        ref={outputRef}
        tabIndex={0}
        onScroll={(event) => {
          /** 键盘和鼠标共用原生滚动，末尾每次只推进一个展示段或远端页。 */
          const output = event.currentTarget;
          if (output.scrollHeight - output.clientHeight - output.scrollTop > 24) return;
          if (outputPreview.truncated) setVisibleCharacters((current) => current + MAX_ACTIVITY_OUTPUT_CHARACTERS);
          else if (canLoadMore && !loadError) void loadNextPage();
        }}
      >
        {outputPreview.text}
      </pre>
      {loading ? <small role="status">{props.language === 'zh-CN' ? '正在读取输出…' : 'Loading output…'}</small> : null}
      {loadError ? (
        <small className="session-v2-page-error" role="alert">
          <VisibleApplicationError error={loadError} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
        </small>
      ) : null}
    </div>
  );
}

interface ActivityToolResult {
  handle: string;
  projection: string | null;
  projectionTruncated: boolean;
}

function activityToolResult(item: NativeSessionItemBuffer): ActivityToolResult | null {
  const result = isRecord(item.payload.toolResult) ? item.payload.toolResult : null;
  const handle = primitive(result?.handle);
  if (!handle) return null;
  const rawProjection = typeof result?.projection === 'string' ? result.projection : '';
  const parsedProjection = parseToolResultProjection(rawProjection);
  return {
    handle,
    projection: parsedProjection.text,
    projectionTruncated: result?.projectionTruncated === true || parsedProjection.truncated,
  };
}

function parseToolResultProjection(value: string): { text: string | null; truncated: boolean } {
  if (!value.trim()) return { text: null, truncated: false };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed) && typeof parsed.text === 'string') {
      const normalized = normalizeActivityToolText(parsed.text);
      return { text: normalized.text, truncated: parsed.truncated === true || normalized.truncated };
    }
  } catch {
    // Snapshot V2 会对描述符本身做有界截断；下方只提取开头的 text 字段，不展示协议 JSON。
  }
  const text = extractJsonStringField(value, 'text');
  if (text === null) return normalizeActivityToolText(value, true);
  const normalized = normalizeActivityToolText(text, true);
  return { text: normalized.text, truncated: true };
}

function normalizeActivityToolText(value: string, truncated = false): { text: string | null; truncated: boolean } {
  const trimmed = value.trim();
  if (!trimmed) return { text: null, truncated };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      if (typeof parsed.text === 'string') return normalizeActivityToolText(parsed.text, truncated || parsed.truncated === true);
      if (isCommandExecutionRecord(parsed)) {
        return {
          text: primitive(parsed.aggregatedOutput ?? parsed.output ?? parsed.stdout ?? parsed.stderr),
          truncated,
        };
      }
    }
  } catch {
    // 历史资源可能只返回协议 JSON 的一个有界片段，继续按字段提取，不能回退展示协议正文。
  }
  if (looksLikeCommandExecutionProtocol(trimmed)) {
    const output = ['aggregatedOutput', 'output', 'stdout', 'stderr'].map((field) => extractJsonStringField(trimmed, field)).find((candidate) => candidate !== null) ?? null;
    return { text: output, truncated: true };
  }
  return { text: value, truncated };
}

function isCommandExecutionRecord(value: Record<string, unknown>): boolean {
  const type = normalizeType(primitive(value.type) ?? '');
  return type === 'commandexecution' || type === 'command';
}

function looksLikeCommandExecutionProtocol(value: string): boolean {
  return /^\s*\{/u.test(value) && /"type"\s*:\s*"(?:commandExecution|command)"/iu.test(value);
}

function extractJsonStringField(value: string, field: string): string | null {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, 'u').exec(value);
  if (match?.[1] === undefined) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replaceAll('\\n', '\n').replaceAll('\\r', '\r').replaceAll('\\t', '\t').replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
}

/** 已打开的长输出按用户阅读位置逐段显示。 */
function activityOutputPreview(output: string, visibleCharacters: number): { text: string; truncated: boolean } {
  if (output.length <= visibleCharacters) return { text: output, truncated: false };
  return { text: output.slice(0, visibleCharacters), truncated: true };
}

export function SessionPlanProgress(props: { plan: NativeTurnPlanSnapshot; language: SessionUiLanguage }) {
  const [open, setOpen] = useState(false);
  /** 鼠标离开后仍在面板内输入时保留展开。 */
  const dockRef = useRef<HTMLElement>(null);
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
      if (!dockRef.current?.contains(document.activeElement)) setOpen(false);
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
    <section
      ref={dockRef}
      className="session-plan-dock"
      onPointerEnter={show}
      onPointerLeave={scheduleClose}
      onFocusCapture={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) show();
      }}
      onBlurCapture={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <div className="session-plan-progress" data-open={open || undefined}>
        <button ref={triggerRef} type="button" className="session-plan-trigger" aria-expanded={open} aria-controls={popoverId} onClick={show}>
          <ListChecks aria-hidden="true" weight="regular" />
          <span role="status" aria-live="polite" aria-atomic="true">
            <strong>{summary}</strong>
            <small>{current?.step}</small>
          </span>
          <CaretDown className="session-plan-caret" aria-hidden="true" weight="bold" />
        </button>
        <div id={popoverId} className="session-plan-popover" data-motion-surface="popover" hidden={!open} inert={!open} aria-hidden={!open}>
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

/** 耗时沿用轮次计时与等待扣除规则，可直接嵌入处理过程按钮。 */
export function SessionTurnDuration(props: { turn: NativeTurnSnapshot; requests: NativePendingRequest[]; language: SessionUiLanguage; fallback?: string; /** 正文可见后显示用时，真实轮次结束前继续沿用现有计时。 */ replyVisible?: boolean }) {
  /** 只有活动轮次需要刷新当前时间。 */
  const [now, setNow] = useState(() => Date.now());
  /** 终态停止计时，回看历史时不继续增长。 */
  const active = isActiveSessionTurn(props.turn);
  /** 过程展示随正文切换，后台轮次的终态和结束时间继续由真实事件决定。 */
  const processing = active && !props.replyVisible;
  useEffect(() => {
    if (!active) return;
    /** 沿用每秒刷新频率。 */
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  /** 无有效起止时间时保留原有过程入口文案，不虚构耗时。 */
  const duration = useMemo(() => turnDurationMs(props.turn, props.requests, now), [now, props.requests, props.turn]);
  if (duration === null) return props.fallback ?? null;
  /** 紧凑时长与参考布局一致。 */
  const value = formatDuration(duration);
  /** 失败和中断仍明确区分于正常完成。 */
  const terminalStatus = props.turn.status === 'interrupted' || props.turn.status === 'failed' ? props.turn.status : 'completed';
  /** 状态文案随界面语言变化。 */
  const label =
    props.language === 'zh-CN'
      ? processing
        ? `处理中 ${value}`
        : terminalStatus === 'interrupted'
          ? `处理已中断（${value}）`
          : terminalStatus === 'failed'
            ? `处理失败（${value}）`
            : `用时 ${value}`
      : processing
        ? `Processing for ${value}`
        : terminalStatus === 'interrupted'
          ? `Interrupted after ${value}`
          : terminalStatus === 'failed'
            ? `Failed after ${value}`
            : `Took ${value}`;
  return (
    <time className="session-turn-duration" dateTime={`PT${Math.max(0, Math.round(duration / 1_000))}S`} data-active={active || undefined} data-status={active ? 'active' : terminalStatus}>
      {label}
    </time>
  );
}

/** 阶段入口显示真实操作数，整轮入口沿用轮次用时，时间缺失时保留原有文案。 */
export function SessionTurnProcessDisclosure(props: {
  language: SessionUiLanguage;
  children: ReactNode;
  onOpen?: () => void | Promise<void>;
  loading?: boolean;
  error?: string | null;
  /** 入口可表达整轮处理过程或补载的轮次详情。 */
  labelKind?: 'process' | 'details';
  /** 整轮入口使用真实轮次用时，缺失时间时显示原文案。 */
  turn?: NativeTurnSnapshot;
  /** 计时扣除本轮等待用户回应的时间。 */
  requests?: NativePendingRequest[];
  /** 阶段内已加载的真实操作数量；整轮回看不传该值。 */
  itemCount?: number;
  /** 最终正文已经显示，用于切换用时文案，真实计时仍随轮次终态停止。 */
  replyVisible?: boolean;
  open?: boolean;
  /** 触发元素用于上层在内容增高时保持精确的阅读锚点。 */
  onOpenChange?: (open: boolean, trigger: HTMLButtonElement) => void;
}) {
  /** 未受外层控制的阶段列表保留独立开合选择。 */
  const [internalOpen, setInternalOpen] = useState(false);
  /** 受控整轮入口沿用时间线保存的开合状态。 */
  const open = props.open ?? internalOpen;
  /** 展开时读取最新回调，不因回调引用变化重复补载。 */
  const onOpenRef = useRef(props.onOpen);
  onOpenRef.current = props.onOpen;
  /** 固定内容区身份供原生按钮与辅助技术关联。 */
  const bodyId = useId();
  useEffect(() => {
    if (!open || !onOpenRef.current) return;
    void Promise.resolve(onOpenRef.current()).catch(() => undefined);
  }, [open]);
  /** 数量由当前真实条目生成，作为阶段入口的固定摘要。 */
  const countLabel = props.itemCount ? (props.language === 'zh-CN' ? `${props.itemCount} 项操作` : `${props.itemCount} ${props.itemCount === 1 ? 'operation' : 'operations'}`) : null;
  /** 轮次过程和补载详情共用同一个入口组件。 */
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
  /** 阶段入口保持固定数量，整轮入口未传数量时显示真实用时。 */
  const visibleCountLabel = props.labelKind !== 'details' ? countLabel : null;
  /** 悬停提示和无障碍名称仍说明查看或收起动作，并保留真实操作数量。 */
  const accessibleLabel = countLabel ? `${label}${props.language === 'zh-CN' ? '，' : ', '}${countLabel}` : label;
  return (
    <section className="session-turn-process" data-label-kind={props.labelKind ?? 'process'} data-open={open || undefined} aria-busy={props.loading || undefined}>
      <div className="session-turn-process-control">
        <button
          type="button"
          aria-label={accessibleLabel}
          title={accessibleLabel}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={(event) => {
            const nextOpen = !open;
            if (props.open === undefined) setInternalOpen(nextOpen);
            props.onOpenChange?.(nextOpen, event.currentTarget);
          }}
        >
          <span>{visibleCountLabel ?? (props.turn ? <SessionTurnDuration turn={props.turn} requests={props.requests ?? []} language={props.language} fallback={label} replyVisible={props.replyVisible} /> : label)}</span>
          <CaretDown className="session-turn-process-caret" aria-hidden="true" weight="bold" />
        </button>
      </div>
      <Collapsible id={bodyId} open={open} revealWithinViewport>
        <div className="session-turn-process-body">
          {props.loading ? (
            <p className="session-v2-page-status" role="status" aria-live="polite">
              {props.language === 'zh-CN' ? '正在读取处理过程…' : 'Loading process…'}
            </p>
          ) : null}
          {props.children}
          {props.error ? (
            <p className="session-v2-page-error" role="alert">
              <VisibleApplicationError error={props.error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
            </p>
          ) : null}
        </div>
      </Collapsible>
    </section>
  );
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

/** 按读取路径去重；无法确认名称时保留技能计数，绝不显示目录哈希。 */
function activitySkillNames(items: NativeSessionItemBuffer[]): Array<string | null> {
  /** 不同技能可以同名，读取同一个文件则只计一次。 */
  const names = new Map<string, string | null>();
  for (const item of items)
    for (const action of commandActions(item)) {
      /** 只把读取技能入口识别为技能活动，搜索或写入仍按原动作显示。 */
      const path = primitive(action.path ?? action.filePath)?.replace(/\\/gu, '/');
      if (normalizeType(primitive(action.type) ?? '') !== 'read' || !path || !/(^|\/)SKILL\.md$/u.test(path)) continue;
      /** 未冻结的技能继续使用具名目录；不透明目录统一等待真实名称。 */
      const directory = path.split('/').at(-2);
      names.set(path, primitive(action.skillName) ?? (directory && !/^[a-f0-9]{24,64}$/iu.test(directory) ? directory : null));
    }
  return [...names.values()];
}

/** 实时行和展开详情共享技能标题，未知名称不回退到内部目录标识。 */
function activityItemTitle(item: NativeSessionItemBuffer, language: SessionUiLanguage): string {
  /** 原生工具按来源、动作和真实结果展示，内部名称留在详情。 */
  const nativeTitle = nativeActivityTitle(item, language === 'zh-CN');
  if (nativeTitle) return nativeTitle;
  /** 非成功结果不再沿用“已读取”“已编辑”等成功式措辞。 */
  const outcome = activityOutcome(item);
  if (outcome !== 'completed' && outcome !== 'running') {
    /** 失败状态仍保留原命令或文件目标，便于直接定位问题。 */
    const target = commandText(item.payload.command) ?? primitive(item.payload.path ?? item.payload.filePath ?? commandActions(item)[0]?.path ?? item.payload.toolName ?? item.payload.tool);
    return `${activityOutcomeLabel(outcome, language === 'zh-CN')} · ${target ? truncate(singleLine(target), 120) : language === 'zh-CN' ? '操作' : 'Operation'}`;
  }
  const skills = activitySkillNames([item]);
  if (skills.length > 0) {
    const active = item.status !== 'completed' && item.status !== 'failed';
    /** 未解析名称不泄漏哈希，多技能仍保留实际数量。 */
    const label = skills.every(Boolean) ? skills.join(language === 'zh-CN' ? '、' : ', ') : skills.length > 1 ? String(skills.length) : '';
    return language === 'zh-CN' ? `${active ? '正在读取' : '已读取'}${label ? ` ${label} ` : ''}技能` : `${active ? 'Reading' : 'Read'} ${label ? `${label} ` : ''}${skills.length === 1 ? 'skill' : 'skills'}`;
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
  // 原生标题已经包含来源、目标和动作，资源链接不能将其覆盖为“已使用”。
  if (nativeActivityTool(item.payload)) return null;
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
    prefix: ['completed', 'running'].includes(activityOutcome(item)) ? prefix : activityOutcomeLabel(activityOutcome(item), language === 'zh-CN'),
    label: resource.displayName,
    title: resource.kind === 'file' ? resource.projectRelativePath : resource.url,
    resource,
  };
}

/** 同一类别的实时行与历史行共用图标，技能与普通文件读取明确区分。 */
function activityItemIcon(item: NativeSessionItemBuffer) {
  /** 名称必须命中原生注册命名空间才显示操作环境图标。 */
  const tool = nativeActivityTool(item.payload);
  if (tool) return tool.kind === 'browser' ? Browser : Desktop;
  if (activitySkillNames([item]).length > 0) return Cube;
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

/** 预览字段为空时仍保留不可变详情句柄的展开入口，点击后才读取全文。 */
function activityItemDetail(item: NativeSessionItemBuffer): {
  command: string | null;
  cwd: string | null;
  output: string | null;
} | null {
  /** 原始工具身份保留在展开详情，摘要不暴露内部命名。 */
  const nativeTool = nativeActivityTool(item.payload);
  const command = commandText(item.payload.command) ?? (nativeTool ? `zeus_${nativeTool.kind}.${nativeTool.method}` : null);
  const cwd = primitive(item.payload.cwd);
  /** 原生工具的文本返回同样可以展开，图片仍走已有资源预览。 */
  const nativeOutput = Array.isArray(item.payload.contentItems)
    ? item.payload.contentItems
        .filter(isRecord)
        .filter((part) => part.type === 'inputText')
        .map((part) => primitive(part.text) ?? '')
        .join('\n')
    : null;
  const output = primitive(item.payload.aggregatedOutput ?? item.payload.output ?? item.payload.stdout ?? item.payload.stderr) ?? activityToolResult(item)?.projection ?? nativeOutput ?? presentationLiveText(item);
  /** 历史长记录可能在命令字段前截断，缺少预览不代表没有可读取的详情。 */
  const deferredDetail = item.payload.v2ContentTruncated === true && typeof item.payload.v2ContentHandle === 'string' && Boolean(item.payload.v2ContentHandle);
  return command || cwd || output || deferredDetail || activityToolResult(item) ? { command, cwd, output } : null;
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
  // 已结束但缺少结束时间时不以当前时间代替，避免历史耗时持续增长。
  if (!isActiveSessionTurn(turn) && !turn.completedAt) return null;
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

/** 所有语言共用紧凑时长单位，状态词仍由界面语言决定。 */
function formatDuration(durationMs: number): string {
  /** 四舍五入到秒，避免显示负数。 */
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  /** 超过一小时仍保留小时部分。 */
  const hours = Math.floor(totalSeconds / 3_600);
  /** 分钟只显示当前小时内的余量。 */
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  /** 秒始终显示，便于短轮次识别。 */
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
