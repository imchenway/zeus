import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { temporaryWorkspaceId, type FilePreviewSourceWorkspace, type ProjectSourceContentMatch } from '@zeus/shared';
import type { DashboardClient, ProjectRecord, TaskRecord } from '../apiClient.js';
import type { TaskSummary } from '../features/tasks/taskContracts.js';
import type { NativeConversationChoice } from '../session/sessionTypes.js';
import type { ProjectConversationGroup } from '../session/ProjectConversationTree.js';
import { conversationDisplayTitle } from '../session/conversationDisplayTitle.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { FileTypeIcon } from './FileTypeIcon.js';
import { projectGitFileStatuses } from '../git/projectGitWorkbenchState.js';
import type { ProjectGitWorkbenchSnapshot } from '../features/git/gitContracts.js';
import { fileStatusLabel } from './fileStatus.js';
import './projectCodeSearch.css';

/** 内容分类与项目范围独立，全部分类保留各类结果的来源。 */
type SearchScope = 'all' | 'project' | 'task' | 'conversation' | 'source';
/** 会话保留所属项目和任务名称，点击仍使用原有导航身份。 */
interface SearchConversation {
  /** 原生会话身份。 */
  conversation: NativeConversationChoice;
  /** 所属项目。 */
  projectId: string;
  /** 所属任务标题。 */
  taskTitle: string;
}
/** 统一列表按内容种类跳转，不从显示文案推断身份。 */
type SearchSelection = { kind: 'project'; project: ProjectRecord } | { kind: 'task'; task: TaskSummary } | ({ kind: 'conversation' } & SearchConversation) | { kind: 'source'; project: ProjectRecord; match: ProjectSourceContentMatch };
/** 查询结果仅在文字、范围和匹配选项均一致时显示。 */
interface SearchResponse {
  /** 查询身份包含刷新次数。 */
  key: string;
  /** 服务端完整内容命中的任务摘要。 */
  tasks: TaskSummary[];
  /** 完整目录中的会话及其任务归属。 */
  conversations: SearchConversation[];
  /** 持久正文的命中身份。 */
  conversationIds: string[];
  /** 保留源项目的文件命中。 */
  sources: Array<{ project: ProjectRecord; match: ProjectSourceContentMatch }>;
  /** 失败单独呈现，成功项目仍可查看。 */
  errors: string[];
  /** 服务端达到预算时不声称已搜索全部内容。 */
  incomplete: boolean;
}
/** 复用既有读取与导航入口，搜索组件不修改项目或会话。 */
interface WorkspaceSearchProps {
  /** 当前源码页的授权工作树只替换所属项目的代码检索目录。 */
  sourceWorkspace?: FilePreviewSourceWorkspace | null;
  /** 已授权项目目录。 */
  projects: ProjectRecord[];
  /** 首屏已有的任务和会话支持即时标题命中。 */
  tasks: TaskRecord[];
  /** 本地会话目录。 */
  conversationGroups: ProjectConversationGroup[];
  /** 完整任务摘要查询。 */
  loadTaskSearchPage?: DashboardClient['tasks']['loadTaskSummaries'];
  /** 持久会话正文查询。 */
  searchConversationContent?: DashboardClient['conversations']['searchConversationContent'];
  /** 全局搜索补齐尚未打开项目的会话目录。 */
  loadConversationGroups?: DashboardClient['conversations']['loadProjectConversationChoiceGroups'];
  /** 文件状态仅使用当前已有的真实快照。 */
  gitSnapshot?: ProjectGitWorkbenchSnapshot | null;
  /** 搜索弹窗开关。 */
  open: boolean;
  /** 应用显示语言。 */
  language: 'zh-CN' | 'en-US';
  /** 共享弹窗负责恢复入口焦点。 */
  onClose(): void;
  /** 所有跳转沿用原来的离开保护。 */
  onOpenProject(project: ProjectRecord): void;
  /** 任务按身份打开，不把摘要充当详情。 */
  onOpenTask(taskId: string, projectId: string): void;
  /** 会话导航保留原生身份。 */
  onOpenConversation(conversation: NativeConversationChoice): void;
  /** 文件打开必须带上命中项目。 */
  onOpenSourceMatch(project: ProjectRecord, match: ProjectSourceContentMatch): void;
}
/** 单次可见结果有界；更多命中通过分类和项目范围继续缩小。 */
const searchResultLimit = 100;

/** 右上角的统一搜索复用原代码弹窗、全文查询、文件高亮和导航保护。 */
export function WorkspaceSearch(props: WorkspaceSearchProps) {
  /** 标签跟随应用语言。 */
  const zh = props.language === 'zh-CN';
  /** 输入与结果列表共享稳定标识。 */
  const id = useId();
  /** 清空后恢复搜索输入焦点。 */
  const inputRef = useRef<HTMLInputElement>(null);
  /** 关闭保留检索词和用户选择的范围。 */
  const [query, setQuery] = useState('');
  /** 默认跨类型检索。 */
  const [scope, setScope] = useState<SearchScope>('all');
  /** 空值代表所有已授权项目。 */
  const [projectId, setProjectId] = useState('');
  /** 代码匹配选项不改变任务和会话的全文匹配口径。 */
  const [caseSensitive, setCaseSensitive] = useState(false);
  /** 代码整词匹配继续使用后端边界规则。 */
  const [wholeWord, setWholeWord] = useState(false);
  /** 重试复用当前检索条件。 */
  const [revision, setRevision] = useState(0);
  /** 响应只属于发起时的条件。 */
  const [response, setResponse] = useState<SearchResponse | null>(null);
  /** 输入焦点保留时，通过上下键选择结果。 */
  const [activeIndex, setActiveIndex] = useState(0);
  /** 目录删除后回到全部项目，不保留无效范围。 */
  const selectedProjectId = props.projects.some((project) => project.id === projectId) ? projectId : '';
  /** 范围变化时只读取相关项目。 */
  const projects = useMemo(() => props.projects.filter((project) => !selectedProjectId || project.id === selectedProjectId), [props.projects, selectedProjectId]);
  /** 目录对象更新不会重复查询相同项目。 */
  const projectsKey = JSON.stringify(projects.map((project) => project.id));
  /** 最新目录用于异步结果归属，不纳入查询触发条件。 */
  const projectsRef = useRef(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  /** 普通内容搜索忽略首尾空格和大小写。 */
  const normalizedQuery = query.trim().toLocaleLowerCase();
  /** 代码搜索保留用户原文，包括首尾空格。 */
  const hasQuery = scope === 'source' ? query.length > 0 : normalizedQuery.length > 0;
  /** 分类限制实际请求，不只隐藏已查出的结果。 */
  const includeTasks = scope === 'all' || scope === 'task';
  /** 会话正文与标题共用分类。 */
  const includeConversations = scope === 'all' || scope === 'conversation';
  /** 代码保留原有本地读取边界。 */
  const includeSource = scope === 'all' || scope === 'source';
  /** 所有异步条件组成唯一请求身份。 */
  const requestKey = JSON.stringify([projectsKey, query, scope, includeSource && caseSensitive, includeSource && wholeWord, includeSource && props.sourceWorkspace?.project.id, revision]);
  /** 当前条件改变后立即隔离旧结果。 */
  const current = response?.key === requestKey ? response : null;
  /** 只在弹窗打开且有异步分类时展示加载状态。 */
  const loading = props.open && hasQuery && scope !== 'project' && !current;
  /** 源码桥接复用原有安全文件搜索。 */
  const searchSource = window.zeus?.searchProjectSourceContent;

  useEffect(() => {
    if (!props.open || !hasQuery || scope === 'project') return;
    /** 任务和正文读取可取消；不可取消的文件与目录回执也不能覆盖后续查询。 */
    const controller = new AbortController();
    /** 输入停顿后才扫描完整内容。 */
    const timer = window.setTimeout(async () => {
      /** 每类查询独立失败，不丢弃其他成功结果。 */
      const next: SearchResponse = { key: requestKey, tasks: [], conversations: [], conversationIds: [], sources: [], errors: [], incomplete: false };
      /** 按项目聚合，不读取未授权目录。 */
      const jobs: Array<Promise<void>> = [];
      for (const project of projectsRef.current) {
        if (includeTasks)
          jobs.push(
            (async () => {
              if (!props.loadTaskSearchPage) {
                next.incomplete = true;
                return;
              }
              /** 游标覆盖未进入首屏的任务。 */
              let cursor: string | undefined;
              do {
                /** 只加载任务摘要，不复制完整正文。 */
                const page = await props.loadTaskSearchPage({ projectId: project.id, query: normalizedQuery, cursor, signal: controller.signal });
                next.tasks.push(...page.items);
                cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
              } while (cursor && !controller.signal.aborted);
            })().catch(() => {
              next.errors.push(`${project.name} · ${zh ? '任务搜索失败' : 'Task search failed'}`);
            }),
          );
        if (includeConversations)
          jobs.push(
            (async () => {
              /** 完整目录查询不依赖侧栏已加载到哪个项目。 */
              const [content, groups] = await Promise.allSettled([props.searchConversationContent?.(project.id, normalizedQuery, { signal: controller.signal }), props.loadConversationGroups?.(project.id)]);
              if (content.status === 'fulfilled' && content.value) {
                next.conversationIds.push(...content.value.conversationIds);
                next.incomplete ||= content.value.skipped;
              } else if (content.status === 'rejected') next.errors.push(`${project.name} · ${zh ? '会话正文搜索失败' : 'Conversation content search failed'}`);
              else next.incomplete = true;
              if (groups.status === 'fulfilled' && groups.value) {
                next.conversations.push(...groups.value.projectChoices.choices.map((conversation) => ({ conversation, projectId: project.id, taskTitle: '' })));
                for (const [taskId, choices] of Object.entries(groups.value.taskChoicesByTaskId)) {
                  /** 任务标题只取权威摘要，不从会话正文猜测。 */
                  const taskTitle = groups.value.tasks.find((task) => task.id === taskId)?.title ?? '';
                  next.conversations.push(...choices.choices.map((conversation) => ({ conversation, projectId: project.id, taskTitle })));
                }
              } else if (groups.status === 'rejected') next.errors.push(`${project.name} · ${zh ? '会话目录读取失败' : 'Conversation directory unavailable'}`);
              else next.incomplete = true;
            })().catch(() => {
              next.errors.push(`${project.name} · ${zh ? '会话搜索失败' : 'Conversation search failed'}`);
            }),
          );
        if (includeSource && project.id !== temporaryWorkspaceId)
          jobs.push(
            (async () => {
              if (!searchSource) {
                next.errors.push(zh ? '本地代码搜索服务尚未连接' : 'Local code search is not connected');
                return;
              }
              /** 任务与会话仍属于业务项目，源码按当前已授权工作树读取。 */
              const sourceProject = props.sourceWorkspace?.ownerProjectId === project.id ? { ...project, ...props.sourceWorkspace.project } : project;
              /** 全部检索保留文件路径命中，代码分类读取完整正文匹配，沿用原有文件边界。 */
              const result = await searchSource({ projectId: sourceProject.id, query, contentOnly: scope === 'source', caseSensitive, wholeWord });
              next.sources.push(...result.matches.map((match) => ({ project: sourceProject, match })));
              next.incomplete ||= result.truncated;
            })().catch(() => {
              next.errors.push(`${project.name} · ${zh ? '代码搜索失败' : 'Code search failed'}`);
            }),
          );
      }
      await Promise.all(jobs);
      if (!controller.signal.aborted) setResponse(next);
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    props.open,
    hasQuery,
    scope,
    projectsKey,
    normalizedQuery,
    query,
    includeTasks,
    includeConversations,
    includeSource,
    caseSensitive,
    wholeWord,
    requestKey,
    props.loadTaskSearchPage,
    props.searchConversationContent,
    props.loadConversationGroups,
    props.sourceWorkspace,
    searchSource,
    zh,
  ]);

  /** 本地标题立即命中，完整内容返回后按真实身份合并。 */
  const selections = useMemo<SearchSelection[]>(() => {
    if (!hasQuery) return [];
    /** 项目范围以同一个选择器为准。 */
    const projectIds = new Set(projects.map((project) => project.id));
    /** 文字查找与侧栏原先的名称、路径匹配一致。 */
    const matchesText = (values: Array<string | null | undefined>) => values.some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    /** 内容类别顺序固定，避免异步回执顺序改变分组顺序。 */
    const results: SearchSelection[] = [];
    if (scope === 'all' || scope === 'project') results.push(...projects.filter((project) => matchesText([project.name, project.localPath])).map((project) => ({ kind: 'project' as const, project })));
    if (includeTasks) {
      /** 服务端全文结果覆盖同身份的首屏摘要。 */
      const tasks = new Map<string, TaskSummary>(props.tasks.filter((task) => projectIds.has(task.projectId) && matchesText([task.title, task.taskCode, task.description, task.tags?.join(' ')])).map((task) => [task.id, task]));
      for (const task of current?.tasks ?? []) tasks.set(task.id, task);
      results.push(...[...tasks.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map((task) => ({ kind: 'task' as const, task })));
    }
    if (includeConversations) {
      /** 同一原生会话的不同导航入口保持各自身份。 */
      const conversations = new Map<string, SearchConversation>();
      for (const group of props.conversationGroups) {
        if (!projectIds.has(group.projectId)) continue;
        for (const conversation of group.conversations ?? []) conversations.set(conversation.navigationId ?? conversation.id, { conversation, projectId: group.projectId, taskTitle: '' });
        for (const task of group.tasks) for (const conversation of task.conversations) conversations.set(conversation.navigationId ?? conversation.id, { conversation, projectId: group.projectId, taskTitle: task.taskTitle });
      }
      for (const entry of current?.conversations ?? []) conversations.set(entry.conversation.navigationId ?? entry.conversation.id, entry);
      /** 持久正文的命中身份不需要将正文装入前端。 */
      const matchedIds = new Set(current?.conversationIds);
      results.push(
        ...[...conversations.values()]
          .filter(({ conversation, taskTitle }) => matchedIds.has(conversation.id) || matchesText([conversation.title, conversation.summary, taskTitle]))
          .sort((a, b) => (b.conversation.activityAt ?? b.conversation.updatedAt).localeCompare(a.conversation.activityAt ?? a.conversation.updatedAt))
          .map((entry) => ({ kind: 'conversation' as const, ...entry })),
      );
    }
    if (includeSource)
      results.push(
        ...[...(current?.sources ?? [])]
          .sort((a, b) => a.project.name.localeCompare(b.project.name) || a.match.relativePath.localeCompare(b.match.relativePath) || a.match.line - b.match.line || a.match.column - b.match.column)
          .map((entry) => ({ kind: 'source' as const, ...entry })),
      );
    return results;
  }, [hasQuery, projects, normalizedQuery, scope, includeTasks, includeConversations, includeSource, props.tasks, props.conversationGroups, current]);
  /** 各分类有独立可见上限，全部搜索不会被代码结果挤满。 */
  const visible = useMemo(() => {
    /** 每类独立计数，避免长结果列表重复扫描。 */
    const counts = new Map<SearchScope, number>();
    return selections.filter((item) => {
      /** 当前类别已保留的命中数量。 */
      const count = counts.get(item.kind) ?? 0;
      counts.set(item.kind, count + 1);
      return count < searchResultLimit;
    });
  }, [selections]);
  /** 同一项目的文件状态映射只计算一次，不随每条命中重复遍历。 */
  const gitFileStatuses = useMemo(() => new Map(projects.map((project) => [project.id, projectGitFileStatuses(props.gitSnapshot, project.id)])), [projects, props.gitSnapshot]);
  /** 每种内容都有明确的可选筛选标签。 */
  const labels: Record<SearchScope, string> = { all: zh ? '全部' : 'All', project: zh ? '项目' : 'Projects', task: zh ? '任务' : 'Tasks', conversation: zh ? '会话' : 'Conversations', source: zh ? '代码' : 'Code' };
  useEffect(() => setActiveIndex(0), [requestKey, props.open]);
  useEffect(() => {
    if (props.open) document.getElementById(`${id}-match-${Math.min(activeIndex, visible.length - 1)}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, activeIndex, props.open, visible.length]);
  /** 所有结果先关闭弹窗，再进入原有导航和未保存保护。 */
  function openSelection(selection: SearchSelection): void {
    props.onClose();
    if (selection.kind === 'project') props.onOpenProject(selection.project);
    else if (selection.kind === 'task') props.onOpenTask(selection.task.id, selection.task.projectId);
    else if (selection.kind === 'conversation') props.onOpenConversation(selection.conversation);
    else props.onOpenSourceMatch(selection.project, selection.match);
  }
  /** 输入法确认不触发跳转，方向键沿完整可见列表移动。 */
  function handleResultKeys(event: KeyboardEvent<HTMLElement>): void {
    if (event.nativeEvent.isComposing || !visible.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openSelection(visible[Math.min(activeIndex, visible.length - 1)]!);
    }
  }
  return (
    <MotionPresence>
      {props.open ? (
        <ModalPortal role="dialog" aria-labelledby={`${id}-title`} rootClassName="project-code-search-portal" onDismiss={props.onClose}>
          <section className="project-code-search-dialog zeus-solid-form-surface" data-modal-surface="dialog">
            <header className="project-code-search-heading">
              <strong id={`${id}-title`}>{zh ? '搜索' : 'Search'}</strong>
              <button type="button" className="project-code-search-close" aria-label={zh ? '关闭搜索' : 'Close search'} onClick={props.onClose}>
                <XIcon aria-hidden="true" />
              </button>
            </header>
            <div className="project-code-search-controls">
              <div className="project-code-search-field">
                <MagnifyingGlassIcon aria-hidden="true" />
                <input
                  ref={(input) => {
                    inputRef.current = input;
                    input?.setAttribute('autofocus', '');
                  }}
                  type="text"
                  role="combobox"
                  aria-label={zh ? '搜索项目、任务、会话或代码' : 'Search projects, tasks, conversations, or code'}
                  aria-autocomplete="list"
                  aria-expanded={visible.length > 0}
                  aria-controls={`${id}-results`}
                  aria-activedescendant={visible.length ? `${id}-match-${Math.min(activeIndex, visible.length - 1)}` : undefined}
                  placeholder={zh ? '搜索项目、任务、会话或代码…' : 'Search projects, tasks, conversations, or code…'}
                  value={query}
                  maxLength={256}
                  spellCheck={false}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleResultKeys}
                />
                {query ? (
                  <button
                    type="button"
                    aria-label={zh ? '清空搜索' : 'Clear search'}
                    onClick={() => {
                      setQuery('');
                      inputRef.current?.focus();
                    }}
                  >
                    <XIcon aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <div className="workspace-search-filters">
                <div className="workspace-search-scopes" role="group" aria-label={zh ? '搜索内容类型' : 'Content type'}>
                  {(Object.keys(labels) as SearchScope[]).map((value) => (
                    <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)}>
                      {labels[value]}
                    </button>
                  ))}
                </div>
                <ZeusSelect
                  size="compact"
                  ariaLabel={zh ? '搜索项目范围' : 'Project scope'}
                  value={selectedProjectId}
                  options={[{ value: '', label: zh ? '全部项目' : 'All projects' }, ...props.projects.map((project) => ({ value: project.id, label: project.name, searchText: project.localPath }))]}
                  onChange={setProjectId}
                />
              </div>
              <div className="project-code-search-options">
                {includeSource ? (
                  <>
                    <label>
                      <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />
                      {zh ? '代码区分大小写' : 'Code: match case'}
                    </label>
                    <label>
                      <input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} />
                      {zh ? '代码整词匹配' : 'Code: whole words'}
                    </label>
                  </>
                ) : null}
                <button type="button" disabled={!hasQuery || loading} onClick={() => setRevision((value) => value + 1)}>
                  {zh ? '重新搜索' : 'Refresh'}
                </button>
              </div>
            </div>
            <div className="project-code-search-status" role="status" aria-live="polite">
              {!hasQuery
                ? zh
                  ? '输入关键词，可按内容类型和项目缩小范围。'
                  : 'Enter a query; filter by content type or project.'
                : loading
                  ? zh
                    ? '正在搜索…'
                    : 'Searching…'
                  : visible.length
                    ? zh
                      ? `显示 ${visible.length} 条结果`
                      : `${visible.length} results shown`
                    : current?.errors.length || current?.incomplete
                      ? zh
                        ? '已搜索范围内没有匹配，部分内容尚未完成。'
                        : 'No matches in searched content; some searches are incomplete.'
                      : zh
                        ? '没有找到匹配内容。'
                        : 'No matches found.'}
            </div>
            {current?.errors.length ? (
              <p className="project-code-search-error" role="alert">
                {[...new Set(current.errors)].join('；')}
                {zh ? '。可点击重新搜索重试。' : '. Use Refresh to retry.'}
              </p>
            ) : null}
            <div id={`${id}-results`} className="project-code-search-results" role="listbox" aria-label={zh ? '搜索结果' : 'Search results'} aria-busy={loading} onKeyDown={handleResultKeys}>
              {visible.map((selection, index) => {
                /** 每条命中显示实际所属项目。 */
                const resultProjectId = selection.kind === 'project' || selection.kind === 'source' ? selection.project.id : selection.kind === 'task' ? selection.task.projectId : selection.projectId;
                /** 文件状态只读取匹配项目的已有快照。 */
                const projectName = selection.kind === 'source' ? selection.project.name : (props.projects.find((project) => project.id === resultProjectId)?.name ?? resultProjectId);
                /** 同类结果使用固定分组标题。 */
                const groupStart = index === 0 || visible[index - 1]?.kind !== selection.kind;
                /** 原生身份和文件位置组成稳定结果键。 */
                const key =
                  selection.kind === 'project'
                    ? selection.project.id
                    : selection.kind === 'task'
                      ? selection.task.id
                      : selection.kind === 'conversation'
                        ? (selection.conversation.navigationId ?? selection.conversation.id)
                        : `${selection.project.id}:${selection.match.matchKind}:${selection.match.relativePath}:${selection.match.line}:${selection.match.column}`;
                /** 非代码命中保留标题和来源摘要。 */
                const title =
                  selection.kind === 'project'
                    ? selection.project.name
                    : selection.kind === 'task'
                      ? selection.task.title
                      : selection.kind === 'conversation'
                        ? conversationDisplayTitle(selection.conversation.title, selection.taskTitle, props.language)
                        : selection.match.relativePath;
                /** 不使用完整正文填充结果行。 */
                const description =
                  selection.kind === 'project'
                    ? selection.project.localPath
                    : selection.kind === 'task'
                      ? [projectName, selection.task.taskCode, selection.task.contentPreview].filter(Boolean).join(' · ')
                      : selection.kind === 'conversation'
                        ? [projectName, selection.taskTitle, selection.conversation.summary].filter(Boolean).join(' · ')
                        : '';
                /** 源码文件分组保留项目，避免跨项目同路径混淆。 */
                const previous = visible[index - 1];
                /** 只有同项目同文件才合并代码行标题。 */
                const fileStart = selection.kind === 'source' && (previous?.kind !== 'source' || previous.project.id !== selection.project.id || previous.match.relativePath !== selection.match.relativePath);
                /** Git 颜色不跨项目复用。 */
                const fileStatus = selection.kind === 'source' ? gitFileStatuses.get(selection.project.id)?.[selection.match.relativePath] : undefined;
                return (
                  <Fragment key={`${selection.kind}:${key}`}>
                    {groupStart ? (
                      <div className="workspace-search-group" role="presentation">
                        {labels[selection.kind]}
                      </div>
                    ) : null}
                    {fileStart && selection.kind === 'source' ? (
                      <div className="project-code-search-file" role="presentation">
                        <FileTypeIcon path={selection.match.relativePath} />
                        <span data-file-status={fileStatus} data-icon-tooltip={fileStatus ? `${selection.match.relativePath} · ${fileStatusLabel(fileStatus, zh)}` : selection.match.relativePath}>
                          {projectName} · {selection.match.relativePath}
                        </span>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      id={`${id}-match-${index}`}
                      className={`project-code-search-match${selection.kind !== 'source' ? ' workspace-search-item' : ''}`}
                      role="option"
                      aria-label={selection.kind === 'source' ? `${projectName} · ${selection.match.relativePath}:${selection.match.line}:${selection.match.column} ${selection.match.preview}` : undefined}
                      aria-selected={index === Math.min(activeIndex, visible.length - 1)}
                      tabIndex={-1}
                      onFocus={() => setActiveIndex(index)}
                      onClick={() => openSelection(selection)}
                    >
                      {selection.kind === 'source' ? (
                        <>
                          <span className="project-code-search-line">{selection.match.matchKind === 'path' ? (zh ? '文件' : 'File') : `${selection.match.line}:${selection.match.column}`}</span>
                          <code>{selection.match.matchKind === 'path' ? selection.match.relativePath : <SearchMatchPreview match={selection.match} />}</code>
                        </>
                      ) : (
                        <>
                          <strong>{title}</strong>
                          <small>{description}</small>
                        </>
                      )}
                    </button>
                  </Fragment>
                );
              })}
            </div>
            <footer className="project-code-search-footer">
              {current?.incomplete ? <p role="status">{zh ? '部分内容达到搜索上限或暂不可用，请缩小范围后重试。' : 'Some content reached a search limit or is unavailable. Refine your search and retry.'}</p> : null}
              {visible.length < selections.length ? <p role="status">{zh ? `每类最多显示 ${searchResultLimit} 条，请选择项目或细化关键词。` : `Up to ${searchResultLimit} results per type. Select a project or refine the query.`}</p> : null}
              {includeSource ? <span>{zh ? '全部搜索包含文件路径；代码分类查看完整正文命中。仅搜索已保存的 UTF-8 文件。' : 'All includes file paths; Code shows full content matches in saved UTF-8 files.'}</span> : null}
              <span>{zh ? '↑ ↓ 选择 · Enter 打开 · Esc 关闭' : '↑ ↓ Select · Enter Open · Esc Close'}</span>
            </footer>
          </section>
        </ModalPortal>
      ) : null}
    </MotionPresence>
  );
}

/** 使用搜索服务给出的真实偏移高亮，不重新猜测大小写或单词边界。 */
function SearchMatchPreview({ match }: { match: ProjectSourceContentMatch }) {
  /** 没有偏移的旧摘要仍可直接显示正文。 */
  const start = match.previewMatchStart;
  /** 匹配长度由 UTF-16 行列映射直接给出。 */
  const length = match.previewMatchLength;
  if (start === undefined || length === undefined) return <>{match.preview}</>;
  return (
    <>
      {match.preview.slice(0, start)}
      <mark>{match.preview.slice(start, start + length)}</mark>
      {match.preview.slice(start + length)}
    </>
  );
}
