import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ArrowDownIcon as ArrowDown } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import './terminal.css';

/** 两个终端入口共用搜索状态，绑定和释放只针对现有 xterm 实例。 */
export function useTerminalSearch() {
  /** 插件随当前显示实例释放，不共享其他标签的缓冲区。 */
  const bindingRef = useRef<{ terminal: Terminal; addon: SearchAddon } | null>(null);
  /** 搜索框展开后取得输入焦点，不把搜索文字交给 Shell。 */
  const inputRef = useRef<HTMLInputElement>(null);
  /** 终端完成初始化前禁用工具栏入口。 */
  const [ready, setReady] = useState(false);
  /** 展开状态只属于当前显示的标签。 */
  const [open, setOpen] = useState(false);
  /** 普通文本查询不区分大小写。 */
  const [query, setQuery] = useState('');
  /** 只有非空查询未命中时显示反馈。 */
  const [found, setFound] = useState(true);

  /** 更换标签会创建新的显示实例，旧实例清理不能解除新实例的绑定。 */
  const bind = useCallback((terminal: Terminal): (() => void) => {
    /** 搜索直接交给官方插件处理换行、中文和缓冲区边界。 */
    const addon = new SearchAddon();
    terminal.loadAddon(addon);
    bindingRef.current = { terminal, addon };
    setReady(true);
    setOpen(false);
    setQuery('');
    setFound(true);
    return () => {
      addon.dispose();
      if (bindingRef.current?.addon !== addon) return;
      bindingRef.current = null;
      setReady(false);
      setOpen(false);
      setQuery('');
      setFound(true);
    };
  }, []);

  /** 重复打开时选中当前查询，首次打开时由展开后的焦点效果接管。 */
  const openSearch = useCallback(() => {
    if (!bindingRef.current) return;
    setOpen(true);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  /** 清空查询也清空插件缓存和选区，避免关闭后仍更新旧命中。 */
  const closeSearch = useCallback(() => {
    bindingRef.current?.addon.findNext('');
    setOpen(false);
    setQuery('');
    setFound(true);
    bindingRef.current?.terminal.focus();
  }, []);

  /** 增量输入保持当前匹配位置；显式前后查找沿用插件的首尾循环。 */
  const find = useCallback((text: string, previous = false, incremental = false) => {
    /** 清理后的控件不能搜索已经销毁的终端。 */
    const binding = bindingRef.current;
    if (!binding) return;
    setQuery(text);
    setFound(previous ? binding.addon.findPrevious(text, { caseSensitive: false }) : binding.addon.findNext(text, { caseSensitive: false, incremental }));
  }, []);

  /** 捕获终端范围内的查找与关闭按键，阻止其进入 xterm 输入处理。 */
  function onKeyDownCapture(event: KeyboardEvent<HTMLElement>): void {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f' && bindingRef.current) {
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    } else if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    }
  }

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  return { ready, open, query, found, inputRef, bind, openSearch, closeSearch, find, onKeyDownCapture };
}

/** 工具栏入口始终可发现，查询只在用户打开时覆盖于终端顶部。 */
export function TerminalSearchButton(props: { search: ReturnType<typeof useTerminalSearch>; language: 'zh-CN' | 'en-US' }) {
  /** 中英文入口共用相同操作和无障碍状态。 */
  const label = props.language === 'zh-CN' ? '搜索终端内容' : 'Search terminal contents';
  return (
    <button className="zeus-terminal-action" type="button" title={label} aria-label={label} aria-expanded={props.search.open} disabled={!props.search.ready} onClick={props.search.openSearch}>
      <MagnifyingGlass aria-hidden="true" />
    </button>
  );
}

/** 搜索栏不占终端网格高度，打开或关闭不会改变 PTY 尺寸。 */
export function TerminalSearchBar(props: { search: ReturnType<typeof useTerminalSearch>; language: 'zh-CN' | 'en-US' }) {
  /** 搜索控件和提示与界面语言一致。 */
  const zh = props.language === 'zh-CN';
  /** 共享控制器承载查询，终端面板仅提供布局和入口。 */
  const search = props.search;
  if (!search.open) return null;
  return (
    <div className="zeus-terminal-search-bar" role="search" aria-label={zh ? '终端搜索' : 'Terminal search'}>
      <input
        ref={search.inputRef}
        type="search"
        aria-label={zh ? '搜索终端内容' : 'Search terminal contents'}
        placeholder={zh ? '搜索终端内容' : 'Search terminal contents'}
        value={search.query}
        onChange={(event) => search.find(event.currentTarget.value, false, true)}
        onKeyDown={(event) => {
          // 输入框内的前后查找不提交表单，也不把回车交给 Shell。
          if (event.key !== 'Enter') return;
          event.preventDefault();
          event.stopPropagation();
          search.find(search.query, event.shiftKey);
        }}
      />
      {search.query && !search.found ? <span role="status">{zh ? '未找到' : 'No matches'}</span> : null}
      <button type="button" aria-label={zh ? '上一个匹配' : 'Previous match'} title={zh ? '上一个匹配' : 'Previous match'} disabled={!search.query} onClick={() => search.find(search.query, true)}>
        <ArrowUp aria-hidden="true" />
      </button>
      <button type="button" aria-label={zh ? '下一个匹配' : 'Next match'} title={zh ? '下一个匹配' : 'Next match'} disabled={!search.query} onClick={() => search.find(search.query)}>
        <ArrowDown aria-hidden="true" />
      </button>
      <button type="button" aria-label={zh ? '关闭搜索' : 'Close search'} title={zh ? '关闭搜索' : 'Close search'} onClick={search.closeSearch}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
