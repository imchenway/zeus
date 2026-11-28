import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectGitComparisonPageQuery, ProjectGitLogInfo, ProjectGitLogRead } from '@zeus/git-core';
import { ArrowsClockwiseIcon as Refresh } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check';
import { EyeIcon as Eye } from '@phosphor-icons/react/dist/csr/Eye';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { SortDescendingIcon as SortDescending } from '@phosphor-icons/react/dist/csr/SortDescending';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { ProjectGitRepositoryWorkbenchItem } from '../apiClient.js';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
import { Button } from '../ui/Button.js';
import { MenuSurface } from '../ui/MenuSurface.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { repositoryColor } from './repositoryColor.js';

/** 当前 Log 页的仓库、路径与提交筛选。null 根列表表示全部。 */
export interface GitLogScope {
  filter: ProjectGitComparisonPageQuery;
  roots: string[] | null;
  paths: Record<string, string[]>;
  dateLabel?: string;
}

/** 展示选项只改变历史行和图谱，不改变 Git 查询范围。 */
export interface GitLogPresentation {
  collapsed: boolean;
  /** 每次全局收起或展开都清除单条分支的覆盖。 */
  foldRevision: number;
  compactRefs: boolean;
  tagNames: boolean;
  longEdges: boolean;
  commitTimestamp: boolean;
  refsOnLeft: boolean;
  rootNames: boolean;
  author: boolean;
  date: boolean;
  hash: boolean;
  mergeHighlight: boolean;
  currentHighlight: boolean;
  myCommits: boolean;
  notCherryPicked: boolean;
}

/** 普通 Log 与用户新建的 Log 均使用 Git 提交日期排序。 */
export const initialGitLogScope: GitLogScope = { filter: { sort: 'date' }, roots: null, paths: {} };
/** 默认保留原有作者、日期、哈希和图谱。 */
export const initialGitLogPresentation: GitLogPresentation = {
  collapsed: false,
  foldRevision: 0,
  compactRefs: true,
  tagNames: true,
  longEdges: false,
  commitTimestamp: true,
  refsOnLeft: true,
  rootNames: false,
  author: true,
  date: true,
  hash: true,
  mergeHighlight: true,
  currentHighlight: true,
  myCommits: true,
  notCherryPicked: false,
};

/** Git 工具栏的操作或分组标题。checked 表示可切换项。 */
export interface GitToolbarItem {
  label: string;
  run?: () => void;
  checked?: boolean;
  color?: string;
  keepOpen?: boolean;
  disabled?: boolean;
}

/** 所有 Git 下拉操作使用共享菜单的键盘、定位和关闭行为。 */
export function GitToolbarMenu(props: { label: string; caption?: string; icon?: ReactNode; items: GitToolbarItem[]; onClear?: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  return (
    <div className="git-log-menu-anchor git-toolbar-controls">
      <Button
        unstyled
        ref={anchor}
        type="button"
        aria-label={props.label}
        data-icon-tooltip={props.caption ?? props.label}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={() => {
          const bounds = anchor.current?.getBoundingClientRect();
          setMenu(menu || !bounds ? undefined : { x: bounds.left, y: bounds.bottom + 4 });
        }}
      >
        {props.icon ?? (
          <>
            <span>{props.caption ?? props.label}</span>
            <CaretDown aria-hidden="true" />
          </>
        )}
      </Button>
      {props.onClear ? (
        <Button unstyled type="button" aria-label={'Clear ' + props.label} onClick={props.onClear}>
          <X aria-hidden="true" />
        </Button>
      ) : null}
      {menu
        ? createPortal(
            <MenuSurface onClose={() => setMenu(undefined)} toggleAnchor={anchor.current} role="menu" aria-label={props.label} className="zeus-context-menu git-log-toolbar-menu" style={{ left: menu.x, top: menu.y }}>
              {props.items.map((item, index) =>
                item.run ? (
                  <Button
                    unstyled
                    type="button"
                    key={index}
                    role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                    aria-checked={item.checked}
                    disabled={item.disabled}
                    onClick={() => {
                      if (!item.keepOpen) setMenu(undefined);
                      item.run?.();
                    }}
                  >
                    {item.color ? (
                      <i className="git-log-root-color" style={{ background: item.color }}>
                        {item.checked ? '✓' : ''}
                      </i>
                    ) : item.checked ? (
                      <Check aria-hidden="true" />
                    ) : null}
                    <span>{item.label}</span>
                  </Button>
                ) : (
                  <strong key={index}>{item.label}</strong>
                ),
              )}
            </MenuSurface>,
            document.querySelector('.macos-ai-app') ?? document.body,
          )
        : null}
    </div>
  );
}

/** 通过同一个项目仓库身份读取选择器数据。 */
export function readGitLogInfo(projectId: string, repositoryId: string, query: ProjectGitLogRead): Promise<ProjectGitLogInfo> {
  return window.zeus?.loadProjectGitLogInfo?.({ projectId, repositoryId, query }) ?? Promise.reject(new Error('Git Log is unavailable.'));
}

/** Git 引用完整值用于查询，UI 只显示分支或标签名称。 */
export function gitLogRefName(ref: string): string {
  return ref.replace(/^(?:HEAD -> |tag: )/u, '').replace(/^refs\/(?:heads|remotes|tags)\//u, '');
}

/** Git Log 的引用类型决定哪些仓库可以执行筛选。 */
export function repositoryHasHistoryRef(repository: ProjectGitRepositoryWorkbenchItem, ref: string): boolean {
  if (!ref || ref === 'HEAD' || /^[a-f0-9]{40,64}$/u.test(ref)) return true;
  const name = gitLogRefName(ref);
  if (ref.startsWith('refs/heads/')) return repository.snapshot.localBranches.includes(name);
  if (ref.startsWith('refs/remotes/')) return repository.snapshot.remoteBranches.includes(name);
  if (ref.startsWith('refs/tags/')) return repository.snapshot.tags.includes(name);
  return [...repository.snapshot.localBranches, ...repository.snapshot.remoteBranches, ...repository.snapshot.tags].includes(name);
}

/** Cherry-Pick 使用两枚樱桃区别于普通分支操作。 */
export function GitCherryPickIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6.5" cy="17.5" r="3.3" />
      <circle cx="17.2" cy="17.5" r="3.3" />
      <path d="M7.3 14.3C8.1 8.5 12.1 4 17 3c-2.4 3.6-2.9 8-.4 11.3" />
    </svg>
  );
}

/** Log 顶栏包括分支、作者、日期、路径及拓扑呈现操作。 */
export function GitLogControls(props: {
  projectId: string;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  repository: ProjectGitRepositoryWorkbenchItem | null;
  refName: string;
  excludedRef?: string;
  scope: GitLogScope;
  presentation?: GitLogPresentation;
  text: string;
  canCherryPick?: boolean;
  onText: (text: string) => void;
  onRef?: (ref: string) => void;
  onScope: (scope: GitLogScope) => void;
  onPresentation?: (presentation: GitLogPresentation) => void;
  onRefresh?: () => void;
  onCherryPick?: () => void;
  onJump?: (repository: ProjectGitRepositoryWorkbenchItem, hash: string) => void | Promise<void>;
  refreshShortcut?: string;
  /** Compare 的 Git 根和提交差集固定，其他筛选与动作照常提供。 */
  fixedRange?: boolean;
}) {
  const [dialog, setDialog] = useState<'author' | 'date' | 'paths' | 'tree' | 'jump'>();
  const [recent, setRecent] = useState<string[]>(() => readRecentAuthors(props.projectId));
  const [searches, setSearches] = useState<string[]>([]);
  const { scope, presentation = initialGitLogPresentation, repository } = props;
  const filter = scope.filter;
  const roots = scope.roots ?? props.repositories.map((item) => item.id);
  /** 选择器只读取当前 Log 可访问的仓库。 */
  const pickerRepositories = useMemo(
    () => props.repositories.filter((item) => (!scope.roots || scope.roots.includes(item.id)) && (dialog === 'jump' || repositoryHasHistoryRef(item, props.refName))),
    [props.repositories, scope.roots, dialog, props.refName],
  );
  /** 只更新一种筛选，其余条件保留。 */
  const setFilter = (change: Partial<ProjectGitComparisonPageQuery>) => props.onScope({ ...scope, filter: { ...filter, ...change } });
  /** 搜索菜单的展示设置由数据定义，点击时复用同一切换。 */
  const viewItem = (key: Exclude<keyof GitLogPresentation, 'foldRevision'>, label: string): GitToolbarItem => ({
    label,
    checked: presentation[key],
    keepOpen: true,
    run: () => props.onPresentation?.({ ...presentation, [key]: !presentation[key] }),
  });
  /** 最近作者与实际查询共同更新。 */
  function chooseAuthors(authors: string[], me = false): void {
    setFilter({ authors, me });
    const next = [...new Set([...(me ? ['me'] : authors), ...recent])].slice(0, 8);
    setRecent(next);
    window.localStorage.setItem('zeus.git.log.recent-authors:' + props.projectId, JSON.stringify(next));
  }
  /** 相对时间在选择时固定，翻页沿用同一时间边界。 */
  function datePreset(label: string, hours: number): void {
    props.onScope({ ...scope, dateLabel: label, filter: { ...filter, since: new Date(Date.now() - hours * 3600 * 1000).toISOString(), until: undefined } });
  }
  const branchItems: GitToolbarItem[] = [
    { label: 'All', checked: !props.refName, run: () => props.onRef?.('') },
    { label: 'HEAD', checked: props.refName === 'HEAD', run: () => props.onRef?.('HEAD') },
    ...(['localBranches', 'remoteBranches', 'tags'] as const).flatMap((kind) =>
      (repository?.snapshot[kind] ?? []).map((name) => {
        const ref = 'refs/' + (kind === 'localBranches' ? 'heads' : kind === 'remoteBranches' ? 'remotes' : 'tags') + '/' + name;
        return { label: name, checked: props.refName === ref, run: () => props.onRef?.(ref) };
      }),
    ),
  ];
  const pathCount = Object.values(scope.paths).reduce((count, paths) => count + paths.length, 0);
  return (
    <div className="git-log-toolbar git-toolbar-controls">
      <label className="git-branch-tree-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label="Text or hash"
          placeholder="Text or hash"
          value={props.text}
          onChange={(event) => props.onText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && props.text.trim()) setSearches((values) => [...new Set([props.text, ...values])].slice(0, 8));
          }}
        />
      </label>
      {searches.length ? <GitToolbarMenu label="Recent searches" icon={<CaretDown aria-hidden="true" />} items={searches.map((text) => ({ label: text, run: () => props.onText(text) }))} /> : null}
      <Button unstyled type="button" aria-label="Regex" data-icon-tooltip="Regex" aria-pressed={Boolean(filter.regex)} onClick={() => setFilter({ regex: !filter.regex })}>
        .*
      </Button>
      <Button unstyled type="button" aria-label="Match Case" data-icon-tooltip="Match Case" aria-pressed={Boolean(filter.matchCase)} onClick={() => setFilter({ matchCase: !filter.matchCase })}>
        Cc
      </Button>
      {!props.fixedRange ? <GitToolbarMenu label="Branch" caption={props.refName ? 'Branch: ' + gitLogRefName(props.refName) : 'Branch'} items={branchItems} onClear={props.refName ? () => props.onRef?.('') : undefined} /> : null}
      <GitToolbarMenu
        label="User"
        caption={filter.me ? 'User: me' : filter.authors?.length ? 'User (' + filter.authors.length + ')' : 'User'}
        onClear={filter.me || filter.authors?.length ? () => chooseAuthors([]) : undefined}
        items={[
          { label: 'Select...', run: () => setDialog('author') },
          { label: 'me', checked: Boolean(filter.me), run: () => chooseAuthors([], !filter.me) },
          ...(recent.length ? [{ label: 'Recent' }, ...recent.map((email) => ({ label: email, run: () => chooseAuthors(email === 'me' ? [] : [email], email === 'me') }))] : []),
        ]}
      />
      <GitToolbarMenu
        label="Date"
        caption={scope.dateLabel ? 'Date: ' + scope.dateLabel : 'Date'}
        onClear={scope.dateLabel ? () => props.onScope({ ...scope, dateLabel: undefined, filter: { ...filter, since: undefined, until: undefined } }) : undefined}
        items={[
          { label: 'Select...', run: () => setDialog('date') },
          { label: 'Last 24 hours', run: () => datePreset('Last 24 hours', 24) },
          { label: 'Last 7 days', run: () => datePreset('Last 7 days', 168) },
        ]}
      />
      <GitToolbarMenu
        label="Paths"
        caption={pathCount ? 'Paths (' + pathCount + ')' : 'Paths'}
        onClear={pathCount || scope.roots ? () => props.onScope({ ...scope, paths: {}, roots: null }) : undefined}
        items={[
          { label: 'Select...', run: () => setDialog('paths') },
          { label: 'Select in Tree...', run: () => setDialog('tree') },
          ...(props.fixedRange ? [] : [{ label: 'Roots' }]),
          ...(props.fixedRange ? [] : props.repositories).map((item) => ({
            label: item.name,
            color: repositoryColor(item.id),
            checked: roots.includes(item.id),
            keepOpen: true,
            run: () => props.onScope({ ...scope, roots: roots.includes(item.id) ? roots.filter((id) => id !== item.id) : [...roots, item.id] }),
          })),
        ]}
      />
      <GitToolbarMenu
        label="Graph Options"
        icon={<SortDescending aria-hidden="true" />}
        items={[
          { label: 'Sort' },
          { label: 'By Commit Date', checked: filter.sort !== 'topo', run: () => setFilter({ sort: 'date' }) },
          { label: 'Topologically', checked: filter.sort === 'topo', run: () => setFilter({ sort: 'topo' }) },
          { label: 'Options' },
          { label: 'First Parent', checked: Boolean(filter.firstParent), run: () => setFilter({ firstParent: !filter.firstParent }) },
          { label: 'No Merges', checked: Boolean(filter.noMerges), run: () => setFilter({ noMerges: !filter.noMerges }) },
          { label: 'Branch Actions' },
          { label: 'Collapse Linear Branches', run: () => props.onPresentation?.({ ...presentation, collapsed: true, foldRevision: presentation.foldRevision + 1 }) },
          { label: 'Expand Linear Branches', run: () => props.onPresentation?.({ ...presentation, collapsed: false, foldRevision: presentation.foldRevision + 1 }) },
        ]}
      />
      <div className="git-log-toolbar-actions git-toolbar-controls">
        <Button unstyled type="button" aria-label="Refresh" data-icon-tooltip={'Refresh ' + props.refreshShortcut} onClick={props.onRefresh}>
          <Refresh aria-hidden="true" />
        </Button>
        <Button unstyled type="button" aria-label="Cherry-Pick" data-icon-tooltip="Cherry-Pick" disabled={!props.canCherryPick} onClick={props.onCherryPick}>
          <GitCherryPickIcon />
        </Button>
        <GitToolbarMenu
          label="Presentation Settings"
          icon={<Eye aria-hidden="true" />}
          items={[
            { label: 'Show' },
            viewItem('compactRefs', 'Compact References View'),
            viewItem('tagNames', 'Tag Names'),
            viewItem('longEdges', 'Long Edges'),
            viewItem('commitTimestamp', 'Commit Timestamp'),
            viewItem('refsOnLeft', 'References on the Left'),
            viewItem('rootNames', 'Show Root Names'),
            { label: 'Columns' },
            viewItem('author', 'Author'),
            viewItem('date', 'Date'),
            viewItem('hash', 'Hash'),
            { label: 'Highlight' },
            viewItem('myCommits', 'My Commits'),
            viewItem('mergeHighlight', 'Merge Commits'),
            viewItem('currentHighlight', 'Current Branch'),
            viewItem('notCherryPicked', 'Not Cherry-Picked Commits'),
          ]}
        />
        <Button unstyled type="button" aria-label="Go to Hash/Branch/Tag" data-icon-tooltip="Go to Hash/Branch/Tag" onClick={() => setDialog('jump')}>
          <Search aria-hidden="true" />
        </Button>
      </div>
      {dialog ? (
        <GitLogFilterDialog
          kind={dialog}
          projectId={props.projectId}
          repositories={pickerRepositories}
          repository={repository}
          refName={props.refName}
          excludedRef={props.excludedRef}
          scope={scope}
          onClose={() => setDialog(undefined)}
          onAuthors={chooseAuthors}
          onScope={props.onScope}
          onJump={props.onJump}
        />
      ) : null}
    </div>
  );
}

/** 最近作者可在同一项目的新 Log 和比较视图中复用。 */
function readRecentAuthors(projectId: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem('zeus.git.log.recent-authors:' + projectId) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

/** 实际仓库范围由下拉控件选择，日期、作者和路径取消后不修改活动过滤器。 */
function GitLogFilterDialog(props: {
  kind: 'author' | 'date' | 'paths' | 'tree' | 'jump';
  projectId: string;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  repository: ProjectGitRepositoryWorkbenchItem | null;
  refName: string;
  excludedRef?: string;
  scope: GitLogScope;
  onClose: () => void;
  onAuthors: (authors: string[], me: boolean) => void;
  onScope: (scope: GitLogScope) => void;
  onJump?: (repository: ProjectGitRepositoryWorkbenchItem, hash: string) => void | Promise<void>;
}) {
  const [repositoryId, setRepositoryId] = useState(() => props.repositories.find((item) => item.id === props.repository?.id)?.id ?? props.repositories[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [authors, setAuthors] = useState(props.scope.filter.authors ?? []);
  const [me, setMe] = useState(Boolean(props.scope.filter.me));
  const [since, setSince] = useState(props.scope.filter.since?.slice(0, 10) ?? '');
  const [until, setUntil] = useState(props.scope.filter.until?.slice(0, 10) ?? '');
  const [paths, setPaths] = useState<Record<string, string[]>>(props.scope.paths);
  const [data, setData] = useState<ProjectGitLogInfo>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { kind, projectId, refName, excludedRef, repositories } = props;
  const [chosenRef, setChosenRef] = useState<GitJumpChoice>();
  const [resolvedChoices, setResolvedChoices] = useState<GitJumpChoice[]>();
  useEffect(() => {
    if (kind !== 'author' && kind !== 'tree' && kind !== 'paths') return;
    let active = true;
    setData(undefined);
    setError('');
    const roots = kind === 'author' ? repositories : repositories.filter((item) => item.id === repositoryId);
    if (!roots.length) {
      setError('No Git roots selected.');
      return;
    }
    void Promise.allSettled(roots.map((item) => readGitLogInfo(projectId, item.id, { kind: kind === 'author' ? 'authors' : 'history_paths', ref: refName || undefined, before: excludedRef }))).then((result) => {
      if (!active) return;
      const available = result.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : []));
      const failed = roots.filter((_, index) => result[index]?.status === 'rejected');
      if (failed.length) setError('Could not read Git history for ' + failed.map((item) => item.name).join(', ') + '.');
      if (kind !== 'author') {
        setData(available[0]);
        return;
      }
      const authors = new Map(available.flatMap((root) => (root.authors ?? []).map((author) => [author.email.toLowerCase(), author] as const)));
      setData({ authors: [...authors.values()].sort((left, right) => left.name.localeCompare(right.name) || left.email.localeCompare(right.email)) });
    });
    return () => {
      active = false;
    };
  }, [kind, projectId, repositories, repositoryId, refName, excludedRef]);
  const title = { author: 'Select Users', date: 'Select Date Range', paths: 'Select Paths', tree: 'Select in Tree', jump: 'Go to Hash/Branch/Tag' }[kind];
  /** 平面选择和树选择共用按仓库保存的相对路径集合。 */
  const setRepositoryPaths = (values: string[]) => setPaths((current) => ({ ...current, [repositoryId]: values }));
  const selectedPaths = paths[repositoryId] ?? [];
  const searchText = query.trim().toLocaleLowerCase();
  /** Git 返回文件名，父目录从同一份树中提取。 */
  const pathChoices = useMemo(() => {
    if (kind !== 'paths' || !data?.paths) return [];
    const choices = new Set<string>(data.paths);
    for (const path of data.paths) {
      for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) choices.add(path.slice(0, slash));
    }
    return [...choices].sort((left, right) => left.localeCompare(right));
  }, [kind, data]);
  const refs = useMemo(() => (kind === 'jump' ? repositories.flatMap(gitJumpRefs) : []), [kind, repositories]);
  const matches = resolvedChoices ?? refs.filter((item) => (item.label + ' ' + item.ref + ' ' + item.repository.name).toLocaleLowerCase().includes(searchText)).slice(0, 60);
  /** 按真实查询结果导航，失败保留输入。 */
  async function apply(): Promise<void> {
    if (kind === 'jump') {
      setBusy(true);
      setError('');
      try {
        const typed = query.trim();
        const exact = refs.filter((item) => item.label === typed || item.ref === typed);
        const candidates = chosenRef ? [chosenRef] : exact.length ? exact : repositories.map((repository) => ({ id: repository.id, label: typed, ref: typed, repository }));
        const found = await Promise.allSettled(
          candidates.map(async (item) => {
            const { revision } = await readGitLogInfo(projectId, item.repository.id, { kind: 'resolve', ref: item.ref });
            return revision ? { ...item, revision } : null;
          }),
        );
        const resolved = found.flatMap((item) => (item.status === 'fulfilled' && item.value ? [item.value] : []));
        if (resolved.length === 0) throw new Error('No matching hash, branch or tag in the selected Git roots.');
        if (resolved.length > 1) {
          setResolvedChoices(resolved);
          setError('Select a reference and repository.');
          return;
        }
        await props.onJump?.(resolved[0]!.repository, resolved[0]!.revision);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return;
      } finally {
        setBusy(false);
      }
    } else if (kind === 'author') props.onAuthors(authors, me);
    else if (kind === 'date') props.onScope({ ...props.scope, dateLabel: since || until ? [since, until].filter(Boolean).join(' – ') : undefined, filter: { ...props.scope.filter, since: since || undefined, until: until || undefined } });
    else
      props.onScope({
        ...props.scope,
        paths: Object.fromEntries(
          Object.entries(paths)
            .map(([id, values]) => [id, [...new Set(values.filter(Boolean))]])
            .filter(([, values]) => values.length),
        ),
      });
    props.onClose();
  }
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" role="dialog" aria-label={title} onDismiss={props.onClose} dismissDisabled={busy}>
      <section className="project-git-reference-dialog git-log-filter-dialog" data-modal-surface="dialog">
        <header>
          <strong>{title}</strong>
        </header>
        <main>
          {(kind === 'paths' || kind === 'tree') && repositories.length > 1 ? (
            <label>
              Repository
              <select value={repositoryId} onChange={(event) => setRepositoryId(event.currentTarget.value)}>
                {props.repositories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {kind === 'author' ? (
            <>
              <input autoFocus type="search" aria-label="Search authors" placeholder="Search authors" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
              <div className="git-log-picker-list">
                <label>
                  <input type="checkbox" checked={me} onChange={(event) => setMe(event.currentTarget.checked)} /> me
                </label>
                {data?.authors
                  ?.filter((author) => (author.name + ' ' + author.email).toLocaleLowerCase().includes(searchText))
                  .map((author) => (
                    <label key={author.email}>
                      <input type="checkbox" checked={authors.includes(author.email)} onChange={(event) => setAuthors(event.currentTarget.checked ? [...authors, author.email] : authors.filter((email) => email !== author.email))} />
                      {author.name} <small>{author.email}</small>
                    </label>
                  ))}
              </div>
            </>
          ) : null}
          {kind === 'date' ? (
            <>
              <label>
                From
                <input type="date" value={since} max={until || undefined} onChange={(event) => setSince(event.currentTarget.value)} />
              </label>
              <label>
                To
                <input type="date" value={until} min={since || undefined} onChange={(event) => setUntil(event.currentTarget.value)} />
              </label>
            </>
          ) : null}
          {kind === 'paths' || kind === 'tree' ? (
            <>
              <input autoFocus type="search" aria-label="Search paths" placeholder="Search paths" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
              <div className="git-log-picker-list">
                {kind === 'tree' ? (
                  <GitLogPathTree paths={data?.paths ?? []} search={searchText} selected={selectedPaths} onChange={setRepositoryPaths} />
                ) : (
                  [...new Set([...pathChoices, ...selectedPaths])]
                    .filter((path) => path.toLocaleLowerCase().includes(searchText))
                    .map((path) => (
                      <label key={path} title={path}>
                        <input type="checkbox" checked={selectedPaths.includes(path)} onChange={(event) => setRepositoryPaths(event.currentTarget.checked ? [...selectedPaths, path] : selectedPaths.filter((value) => value !== path))} />
                        {path}
                      </label>
                    ))
                )}
              </div>
            </>
          ) : null}
          {kind === 'jump' ? (
            <>
              <input
                autoFocus
                aria-label="Hash, branch or tag"
                placeholder="Hash, branch or tag"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setChosenRef(undefined);
                  setResolvedChoices(undefined);
                  setError('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && query.trim() && !busy) void apply();
                }}
              />
              <div className="git-log-picker-list">
                {matches.map((item) => (
                  <Button
                    unstyled
                    key={item.id}
                    disabled={busy}
                    aria-pressed={item.id === chosenRef?.id}
                    title={item.ref}
                    onClick={() => {
                      setQuery(item.label);
                      setChosenRef(item);
                      setError('');
                    }}
                  >
                    <i className="git-log-root-color" style={{ background: repositoryColor(item.repository.id) }} />
                    {item.label} <small>{item.repository.name}</small>
                  </Button>
                ))}
              </div>
            </>
          ) : null}
          {!data && !error && (kind === 'tree' || kind === 'paths' || kind === 'author') ? <span role="status">Loading...</span> : null}
          {error ? <span role="alert">{error}</span> : null}
        </main>
        <footer>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={busy || (kind === 'jump' && !query.trim()) || Boolean(since && until && since > until)} onClick={apply}>
            {kind === 'jump' ? 'Go to Commit' : 'Apply'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

/** 定位列表保留仓库和完整引用，允许同名本地分支、远端分支或标签。 */
type GitJumpChoice = { id: string; label: string; ref: string; repository: ProjectGitRepositoryWorkbenchItem };

/** 同一个提交可有多条引用，每条仍以其完整 Git 引用作为目标。 */
function gitJumpRefs(repository: ProjectGitRepositoryWorkbenchItem): GitJumpChoice[] {
  if (!repository.snapshot.headSha) return [];
  const snapshot = repository.snapshot;
  const make = (ref: string, label: string) => ({ id: repository.id + ':' + ref, label, ref, repository });
  return [
    make('HEAD', 'HEAD'),
    ...snapshot.localBranches.map((name) => make('refs/heads/' + name, name)),
    ...snapshot.remoteBranches.map((name) => make('refs/remotes/' + name, name)),
    ...snapshot.tags.map((name) => make('refs/tags/' + name, name)),
  ];
}

/** 路径树的目录节点支持整段选择，闭合目录延迟渲染其后代。 */
interface GitLogPathNode {
  path: string;
  name: string;
  children: Map<string, GitLogPathNode>;
}

export function GitLogPathTree(props: { paths: string[]; search?: string; selected: string[]; onChange?: (paths: string[]) => void; onOpen?: (path: string) => void }) {
  const tree = useMemo(() => {
    const root: GitLogPathNode = { path: '', name: '', children: new Map() };
    for (const path of props.paths) {
      if (props.search && !path.toLocaleLowerCase().includes(props.search)) continue;
      let parent = root;
      for (const name of path.split('/')) {
        const child = parent.children.get(name) ?? { path: parent.path ? parent.path + '/' + name : name, name, children: new Map() };
        parent.children.set(name, child);
        parent = child;
      }
    }
    return root;
  }, [props.paths, props.search]);
  return (
    <>
      {[...tree.children.values()].map((node) => (
        <GitLogPathEntry key={node.path} node={node} {...props} />
      ))}
    </>
  );
}

/** 勾选目录允许 Git 在历史查询中涵盖该目录下的旧路径。 */
function GitLogPathEntry(props: { node: GitLogPathNode } & Omit<Parameters<typeof GitLogPathTree>[0], 'paths'>) {
  const { node } = props;
  const [open, setOpen] = useState(Boolean(props.search));
  useEffect(() => setOpen(Boolean(props.search)), [props.search]);
  const checkbox = (
    <label>
      <input type="checkbox" checked={props.selected.includes(node.path)} onChange={(event) => props.onChange?.(event.currentTarget.checked ? [...props.selected, node.path] : props.selected.filter((value) => value !== node.path))} />
      {node.name}
    </label>
  );
  if (!node.children.size && props.onOpen)
    return (
      <Button unstyled className="git-log-path-file" title={node.path} aria-pressed={props.selected.includes(node.path)} onClick={() => props.onOpen?.(node.path)}>
        <FileTypeIcon path={node.path} /> <span>{node.name}</span>
      </Button>
    );
  return node.children.size ? (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {props.onOpen ? (
          <>
            <FileTypeIcon path={node.path} kind="directory" /> <span>{node.name}</span>
          </>
        ) : (
          checkbox
        )}
      </summary>
      {open ? [...node.children.values()].map((child) => <GitLogPathEntry key={child.path} {...props} node={child} />) : null}
    </details>
  ) : (
    checkbox
  );
}
