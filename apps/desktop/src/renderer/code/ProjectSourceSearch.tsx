import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { findProjectSourceTextMatches, projectSourceTextSearchLimit, type ProjectSourceRevision, type ProjectSourceTextSearchFile, type ProjectSourceTextSearchResult } from '@zeus/shared';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { ModalPortal } from '../ui/ModalPortal.js';
import { Button } from '../ui/Button.js';

export interface SourceSearchBuffer {
  relativePath: string;
  content: string;
  revision: ProjectSourceRevision;
}

/** 草稿命中保留搜索时的内容；替换前与实时编辑器再次核对。 */
export interface SourceSearchFile extends ProjectSourceTextSearchFile {
  bufferContent?: string;
}

export function ProjectSourceSearch(props: {
  projectId: string;
  zh: boolean;
  buffers: SourceSearchBuffer[];
  children: ReactNode;
  onOpen(path: string, line: number, column: number): void;
  onReplace(file: SourceSearchFile, replacement: string): Promise<'draft' | 'saved'>;
}) {
  const { zh, projectId, buffers, onReplace } = props;
  const bridge = window.zeus;
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<(ProjectSourceTextSearchResult & { key: string }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const replacingRef = useRef(false);
  const mounted = useRef(true);
  const searchKey = JSON.stringify([projectId, query, matchCase, wholeWord, refresh]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setError('');
    setLoading(Boolean(query));
    if (!query) {
      setResult(null);
      return;
    }
    const timer = window.setTimeout(() => {
      if (!bridge?.searchProjectSourceText) {
        setError(zh ? '搜索功能尚未加载，请完全退出并重新打开应用后重试。' : 'Search is not loaded. Quit and reopen the app to try again.');
        setLoading(false);
        return;
      }
      void bridge
        .searchProjectSourceText({ projectId, query, matchCase, wholeWord })
        .then((next) => {
          if (active) setResult({ ...next, key: searchKey });
        })
        .catch((failure: unknown) => {
          if (active) {
            setResult(null);
            const message = failure instanceof Error ? failure.message : String(failure);
            setError(/No handler registered for .*zeus:project-source:search-text/u.test(message) ? (zh ? '搜索功能已更新，请完全退出并重新打开应用后重试。' : 'Search has been updated. Quit and reopen the app to try again.') : message);
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [bridge, projectId, query, matchCase, wholeWord, searchKey, zh]);

  useEffect(() => {
    if (!query || !bridge?.onProjectSourceEvent) return;
    let timer: ReturnType<typeof setTimeout>;
    const dispose = bridge.onProjectSourceEvent((event) => {
      if (event.projectId !== projectId) return;
      clearTimeout(timer);
      timer = setTimeout(() => setRefresh((value) => value + 1), 250);
    });
    return () => {
      clearTimeout(timer);
      dispose();
    };
  }, [bridge, projectId, query]);

  const current = result?.key === searchKey ? result : null;
  const { files, truncated } = useMemo(() => {
    if (!current || !query) return { files: [], truncated: false };
    const byPath = new Map<string, SourceSearchFile>(current.files.map((file) => [file.relativePath, file]));
    let limited = current.truncated;
    for (const buffer of buffers) {
      const found = findProjectSourceTextMatches(buffer.content, query, { matchCase, wholeWord });
      byPath.delete(buffer.relativePath);
      if (found.matches.length) byPath.set(buffer.relativePath, { relativePath: buffer.relativePath, revision: buffer.revision, matches: found.matches, bufferContent: buffer.content });
      limited ||= found.truncated;
    }
    let count = 0;
    const visible: SourceSearchFile[] = [];
    for (const file of [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      const available = projectSourceTextSearchLimit - count;
      if (file.matches.length > available) limited = true;
      if (available > 0) visible.push({ ...file, matches: file.matches.slice(0, available) });
      count += file.matches.length;
    }
    return { files: visible, truncated: limited };
  }, [current, query, buffers, matchCase, wholeWord]);
  const count = files.reduce((total, file) => total + file.matches.length, 0);
  const pending = loading || (Boolean(query) && !current && !error);
  const disabled = pending || replacing || Boolean(error);

  async function replaceFiles(targets: SourceSearchFile[]): Promise<void> {
    if (replacingRef.current || disabled || !targets.length) return;
    replacingRef.current = true;
    setReplacing(true);
    setConfirmation(false);
    setNotice('');
    setError('');
    let replaced = 0;
    let drafts = 0;
    let path = '';
    try {
      for (const file of targets) {
        if (!mounted.current) break;
        path = file.relativePath;
        if ((await onReplace(file, replacement)) === 'draft') drafts += 1;
        replaced += file.matches.length;
      }
      if (mounted.current) setNotice(zh ? `已替换 ${replaced} 处${drafts ? `，${drafts} 个已打开文件待保存` : ''}。` : `Replaced ${replaced} matches.${drafts ? ` Save ${drafts} open files to keep the changes.` : ''}`);
    } catch (failure) {
      if (mounted.current) setNotice(zh ? `已替换 ${replaced} 处；${path} 未替换，后续文件未处理：${failure instanceof Error ? failure.message : String(failure)}` : `Replaced ${replaced} matches. Stopped at ${path}: ${String(failure)}`);
    } finally {
      replacingRef.current = false;
      if (mounted.current) {
        setReplacing(false);
        setResult(null);
        setRefresh((value) => value + 1);
      }
    }
  }

  const replaceLabel = replaceOpen ? (zh ? '收起替换' : 'Hide replace') : zh ? '展开替换' : 'Show replace';
  return (
    <>
      <div className="project-source-content-search">
        <div className="project-source-search-row">
          <button type="button" className="source-search-icon" title={replaceLabel} aria-label={replaceLabel} aria-expanded={replaceOpen} onClick={() => setReplaceOpen((value) => !value)} disabled={replacing}>
            <CaretRight className={replaceOpen ? 'expanded' : ''} />
          </button>
          <div className="project-source-search-input">
            <input
              type="search"
              aria-label={zh ? '搜索文件内容' : 'Search file contents'}
              placeholder={zh ? '搜索文件内容' : 'Search file contents'}
              maxLength={1024}
              value={query}
              disabled={replacing}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setNotice('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('');
              }}
            />
            <button type="button" title={zh ? '区分大小写' : 'Match case'} aria-label={zh ? '区分大小写' : 'Match case'} aria-pressed={matchCase} disabled={replacing} onClick={() => setMatchCase((value) => !value)}>
              Aa
            </button>
            <button
              type="button"
              className="source-search-word"
              title={zh ? '全字匹配' : 'Match whole word'}
              aria-label={zh ? '全字匹配' : 'Match whole word'}
              aria-pressed={wholeWord}
              disabled={replacing}
              onClick={() => setWholeWord((value) => !value)}
            >
              ab
            </button>
          </div>
        </div>
        {replaceOpen ? (
          <div className="project-source-search-row source-search-replacement">
            <input aria-label={zh ? '替换为' : 'Replace with'} placeholder={zh ? '替换' : 'Replace'} value={replacement} disabled={replacing} onChange={(event) => setReplacement(event.currentTarget.value)} />
            <button type="button" className="source-search-icon" aria-label={zh ? '全部替换' : 'Replace all'} title={zh ? '全部替换' : 'Replace all'} disabled={disabled || !count || truncated} onClick={() => setConfirmation(true)}>
              <ArrowsClockwise />
            </button>
          </div>
        ) : null}
        {query ? (
          <div className="source-search-status">
            <span role="status">{pending ? (zh ? '正在搜索…' : 'Searching…') : error ? (zh ? '搜索失败' : 'Search failed') : zh ? `${files.length} 文件 · ${count} 处` : `${files.length} files · ${count} matches`}</span>
            <button type="button" className="source-search-icon" aria-label={zh ? '刷新搜索' : 'Refresh search'} title={zh ? '刷新搜索' : 'Refresh search'} disabled={replacing} onClick={() => setRefresh((value) => value + 1)}>
              <ArrowClockwise />
            </button>
            <button type="button" className="source-search-icon" aria-label={zh ? '清空搜索' : 'Clear search'} title={zh ? '清空搜索' : 'Clear search'} disabled={replacing} onClick={() => setQuery('')}>
              <X />
            </button>
          </div>
        ) : null}
        {error ? (
          <p className="source-search-feedback" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="source-search-feedback" role="status">
            {notice}
          </p>
        ) : null}
        {truncated ? <p className="source-search-feedback">{zh ? '搜索结果不完整，请缩小范围后批量替换。' : 'Results are incomplete. Refine the search before replacing all.'}</p> : null}
      </div>
      {query ? (
        <div className="project-source-content-results" aria-label={zh ? '文件内容搜索结果' : 'File content results'} aria-busy={pending || replacing}>
          {!pending && !error && !files.length ? <p className="project-source-empty">{zh ? '没有匹配的内容。' : 'No matching content.'}</p> : null}
          {files.map((file) => (
            <details key={file.relativePath} className="source-search-file" open>
              <summary title={file.relativePath}>
                <File aria-hidden="true" />
                <span>{file.relativePath}</span>
                <small>{file.matches.length}</small>
                {replaceOpen ? (
                  <button
                    type="button"
                    className="source-search-icon"
                    title={zh ? `替换 ${file.relativePath} 中的匹配` : `Replace matches in ${file.relativePath}`}
                    aria-label={zh ? `替换 ${file.relativePath} 中的匹配` : `Replace matches in ${file.relativePath}`}
                    disabled={disabled || truncated}
                    onClick={(event) => {
                      event.preventDefault();
                      void replaceFiles([file]);
                    }}
                  >
                    <ArrowsClockwise />
                  </button>
                ) : null}
              </summary>
              {file.matches.map((match) => (
                <div key={match.offset} className="source-search-match">
                  <button
                    type="button"
                    className="source-search-location"
                    disabled={replacing}
                    aria-label={`${file.relativePath}:${match.line}:${match.column} ${match.preview}`}
                    title={`${file.relativePath}:${match.line}:${match.column}`}
                    onClick={() => props.onOpen(file.relativePath, match.line, match.column)}
                  >
                    <small>{match.line}</small>
                    <span>
                      {match.preview.slice(0, match.previewColumn)}
                      <mark>{match.preview.slice(match.previewColumn, match.previewColumn + match.length)}</mark>
                      {match.preview.slice(match.previewColumn + match.length)}
                    </span>
                  </button>
                  {replaceOpen ? (
                    <button
                      type="button"
                      className="source-search-icon"
                      title={zh ? '替换此处' : 'Replace this match'}
                      aria-label={zh ? `替换 ${file.relativePath}:${match.line}:${match.column}` : `Replace ${file.relativePath}:${match.line}:${match.column}`}
                      disabled={disabled}
                      onClick={() => void replaceFiles([{ ...file, matches: [match] }])}
                    >
                      <ArrowsClockwise />
                    </button>
                  ) : null}
                </div>
              ))}
            </details>
          ))}
        </div>
      ) : (
        props.children
      )}
      {confirmation ? (
        <ModalPortal rootClassName="project-source-modal-root" backdropClassName="project-source-modal-backdrop" role="dialog" aria-label={zh ? '全部替换' : 'Replace all'} onDismiss={() => setConfirmation(false)}>
          <section className="project-source-operation-modal">
            <header>
              <strong>{zh ? '全部替换' : 'Replace all'}</strong>
            </header>
            <p>{zh ? `将 ${files.length} 个文件中的 ${count} 处“${query}”替换为“${replacement || '（空文本）'}”。` : `Replace ${count} matches of “${query}” in ${files.length} files with “${replacement}”.`}</p>
            <p>{zh ? '已打开文件保留为未保存修改，其余文件直接保存。' : 'Open files keep unsaved edits. Other files are saved immediately.'}</p>
            <footer>
              <Button variant="secondary" onClick={() => setConfirmation(false)}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button disabled={disabled || !count || truncated} onClick={() => void replaceFiles(files)}>
                {zh ? '替换' : 'Replace'}
              </Button>
            </footer>
          </section>
        </ModalPortal>
      ) : null}
    </>
  );
}
