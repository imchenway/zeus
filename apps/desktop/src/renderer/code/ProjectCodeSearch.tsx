import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import type { ProjectSourceContentMatch, ProjectSourceContentSearchResult } from '@zeus/shared';
import { ModalPortal } from '../ui/ModalPortal.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { FileTypeIcon } from './FileTypeIcon.js';
import { projectGitFileStatuses } from '../git/projectGitWorkbenchState.js';
import type { ProjectGitWorkbenchSnapshot } from '../features/git/gitContracts.js';
import { fileStatusLabel } from './fileStatus.js';
import './projectCodeSearch.css';

/** 项目搜索只持有当前项目身份，文件打开仍交给现有源码导航。 */
interface ProjectCodeSearchProps {
  /** 复用源码和 Git 面板的快照，不为每个搜索命中另行读取。 */
  gitSnapshot?: ProjectGitWorkbenchSnapshot | null;
  /** 搜索范围固定为当前项目的本地根目录。 */
  project: { id: string; name: string; localPath: string };
  /** 收起保留本项目的检索词；切换项目由外层键重建状态。 */
  open: boolean;
  /** 界面语言沿用应用设置。 */
  language: 'zh-CN' | 'en-US';
  /** 关闭后由共享弹窗恢复入口焦点。 */
  onClose(): void;
  /** 命中打开复用原有草稿保护和源码编辑器。 */
  onOpenMatch(match: ProjectSourceContentMatch): void;
}

/** 每次查询都有独立身份，迟到的旧请求不能替换当前结果。 */
interface SearchResponse {
  /** 项目、检索词和匹配选项组成的查询身份。 */
  key: string;
  /** 成功时返回真实匹配列表。 */
  result?: ProjectSourceContentSearchResult;
  /** 失败独立展示，不能等同于零匹配。 */
  error?: string;
}

/** 当前项目的文件内容查找，复用弹窗、文件图标和 Electron 搜索桥接。 */
export function ProjectCodeSearch(props: ProjectCodeSearchProps) {
  /** 文案与系统语言一致。 */
  const zh = props.language === 'zh-CN';
  /** 搜索保留命中顺序，文件状态按真实项目相对路径读取。 */
  const gitFileStatuses = useMemo(() => projectGitFileStatuses(props.gitSnapshot, props.project.id), [props.gitSnapshot, props.project.id]);
  /** 输入与结果列表共享稳定的无障碍标识。 */
  const id = useId();
  /** 打开时由共享弹窗聚焦此输入。 */
  const inputRef = useRef<HTMLInputElement>(null);
  /** 收起后保留上一次查找内容，避免反复输入。 */
  const [query, setQuery] = useState('');
  /** 默认按不区分大小写的字面量匹配。 */
  const [caseSensitive, setCaseSensitive] = useState(false);
  /** 整词匹配沿用后端的代码标识符边界。 */
  const [wholeWord, setWholeWord] = useState(false);
  /** 失败重试和文件变化后的刷新使用相同查询。 */
  const [revision, setRevision] = useState(0);
  /** 响应与请求身份绑定，查询改变时立即停止显示旧结果。 */
  const [response, setResponse] = useState<SearchResponse | null>(null);
  /** 键盘上下键选中匹配项，输入焦点仍保留在搜索框。 */
  const [activeIndex, setActiveIndex] = useState(0);
  /** 当前能力只查询本地已保存文件。 */
  const search = window.zeus?.searchProjectSourceContent;
  /** 查询首尾空格有意义，不做 trim 或小写转换。 */
  const requestKey = JSON.stringify([props.project.id, query, caseSensitive, wholeWord, revision]);
  /** 只接管当前查询的成功或失败结果。 */
  const current = response?.key === requestKey ? response : null;
  /** 文件分组按路径排序，同文件内继续按行列排序。 */
  const matches = useMemo(
    () => [...(current?.result?.matches ?? [])].filter((match) => match.matchKind === 'content').sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.line - right.line || left.column - right.column),
    [current],
  );
  /** 文件数量与命中次数分别展示。 */
  const fileCount = useMemo(() => new Set(matches.map((match) => match.relativePath)).size, [matches]);
  /** 查询为空或桥接未连接时不展示虚假的加载状态。 */
  const loading = Boolean(query && search && !current);

  useEffect(() => {
    if (!props.open || !query || !search) return;
    /** 清理时废弃旧回执，关闭和切换项目后不更新结果。 */
    let active = true;
    setResponse(null);
    /** 输入短暂停顿后再读取，避免每个按键都扫描项目。 */
    const timer = window.setTimeout(() => {
      void search({ projectId: props.project.id, query, contentOnly: true, caseSensitive, wholeWord }).then(
        (result) => {
          if (active) setResponse({ key: requestKey, result });
        },
        (error: unknown) => {
          if (active) setResponse({ key: requestKey, error: error instanceof Error ? error.message : zh ? '代码搜索失败，请重试。' : 'Code search failed. Please retry.' });
        },
      );
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [props.open, props.project.id, query, caseSensitive, wholeWord, search, requestKey, zh]);

  useEffect(() => setActiveIndex(0), [requestKey, props.open]);
  useEffect(() => {
    if (!props.open) return;
    document.getElementById(`${id}-match-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, activeIndex, props.open]);

  /** 打开结果前关闭搜索，后续文件导航沿用共享离开保护。 */
  function openMatch(match: ProjectSourceContentMatch): void {
    props.onClose();
    props.onOpenMatch(match);
  }

  /** 上下键选择、Enter 打开；输入法确认不触发文件跳转。 */
  function handleResultKeys(event: KeyboardEvent<HTMLElement>): void {
    if (event.nativeEvent.isComposing || !matches.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openMatch(matches[Math.min(activeIndex, matches.length - 1)]!);
    }
  }

  return (
    <MotionPresence>
      {props.open ? (
        <ModalPortal role="dialog" aria-labelledby={`${id}-title`} rootClassName="project-code-search-portal" onDismiss={props.onClose}>
          <section className="project-code-search-dialog zeus-solid-form-surface" data-modal-surface="dialog">
            <header className="project-code-search-heading">
              <strong id={`${id}-title`}>
                {props.project.name} · {zh ? '搜索代码' : 'Find in files'}
              </strong>
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
                  aria-label={zh ? '搜索当前项目代码内容' : 'Search current project code'}
                  aria-autocomplete="list"
                  aria-expanded={matches.length > 0}
                  aria-controls={`${id}-results`}
                  aria-activedescendant={matches.length ? `${id}-match-${Math.min(activeIndex, matches.length - 1)}` : undefined}
                  placeholder={zh ? '输入要查找的代码内容…' : 'Text to find in project files…'}
                  value={query}
                  maxLength={512}
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
              <div className="project-code-search-options">
                <label>
                  <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />
                  {zh ? '区分大小写' : 'Match case'}
                </label>
                <label>
                  <input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} />
                  {zh ? '整词匹配' : 'Whole words'}
                </label>
                <button type="button" disabled={!query || !search || loading} onClick={() => setRevision((value) => value + 1)}>
                  {zh ? '重新搜索' : 'Refresh'}
                </button>
              </div>
              <p className="project-code-search-scope" title={props.project.localPath}>
                {zh ? '范围：当前项目' : 'Scope: current project'} · {props.project.localPath}
              </p>
            </div>
            <div className="project-code-search-status" role="status" aria-live="polite">
              {!search
                ? zh
                  ? '本地代码搜索服务尚未连接。'
                  : 'Local code search is not connected.'
                : !query
                  ? zh
                    ? '输入内容，查找项目中的匹配代码。'
                    : 'Enter text to find matching code.'
                  : loading
                    ? zh
                      ? '正在搜索…'
                      : 'Searching…'
                    : current?.error
                      ? zh
                        ? '搜索失败'
                        : 'Search failed'
                      : matches.length
                        ? zh
                          ? `${fileCount} 个文件，${matches.length} 处匹配`
                          : `${matches.length} matches in ${fileCount} files`
                        : current?.result?.truncated
                          ? zh
                            ? '已搜索范围内没有匹配，搜索未完成。'
                            : 'No matches in the searched files. Search is incomplete.'
                          : zh
                            ? '没有找到匹配内容。'
                            : 'No matches found.'}
            </div>
            {current?.error ? (
              <p className="project-code-search-error" role="alert">
                {current.error}
              </p>
            ) : null}
            <div id={`${id}-results`} className="project-code-search-results" role="listbox" aria-label={zh ? '代码搜索结果' : 'Code search results'} aria-busy={loading} onKeyDown={handleResultKeys}>
              {matches.map((match, index) => (
                <Fragment key={`${match.relativePath}:${match.line}:${match.column}`}>
                  {index === 0 || matches[index - 1]?.relativePath !== match.relativePath ? (
                    <div className="project-code-search-file" role="presentation">
                      <FileTypeIcon path={match.relativePath} />
                      <span
                        data-file-status={gitFileStatuses[match.relativePath]}
                        data-icon-tooltip={gitFileStatuses[match.relativePath] ? `${match.relativePath} · ${fileStatusLabel(gitFileStatuses[match.relativePath]!, zh)}` : match.relativePath}
                      >
                        {match.relativePath}
                      </span>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    id={`${id}-match-${index}`}
                    className="project-code-search-match"
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-label={`${match.relativePath}:${match.line}:${match.column} ${match.preview}`}
                    tabIndex={-1}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => openMatch(match)}
                  >
                    <span className="project-code-search-line">
                      {match.line}:{match.column}
                    </span>
                    <code>
                      <SearchMatchPreview match={match} />
                    </code>
                  </button>
                </Fragment>
              ))}
            </div>
            <footer className="project-code-search-footer">
              {current?.result?.truncated ? (
                <p role="status">{zh ? '结果不完整：已达到搜索上限或部分文件无法读取。请使用更具体的关键词后重试。' : 'Results are incomplete: a search limit was reached or some files could not be read. Refine your search and retry.'}</p>
              ) : null}
              <span>{zh ? '搜索已保存的 UTF-8 文本；跳过 node_modules、dist 等目录、符号链接和超过 1 MiB 的文件。' : 'Searches saved UTF-8 text; skips node_modules, dist and similar folders, symlinks and files over 1 MiB.'}</span>
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
