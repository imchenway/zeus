import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorState, Prec } from '@codemirror/state';
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext, search, searchKeymap, searchPanelOpen, selectMatches, setSearchQuery, SearchQuery } from '@codemirror/search';
import { EditorView, keymap, panels, ViewPlugin, type Panel } from '@codemirror/view';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowsLeftRightIcon } from '@phosphor-icons/react/dist/csr/ArrowsLeftRight';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { Button } from '../ui/Button.js';
import './fileFind.css';

/** 结果栏与只读两侧各自保留真实文档范围。 */
export type FileFindSide = 'before' | 'after' | 'result';

/** 两栏差异共用一个面板位置，并记住最后聚焦的版本。 */
export interface FileFindGroup {
  /** 查找栏在差异标题和正文之间。 */
  host: RefObject<HTMLDivElement | null>;
  /** 只登记仍挂载的真实文档。 */
  views: Map<EditorView, FileFindSide>;
  /** 未操作任何一栏时使用的版本。 */
  defaultSide: FileFindSide;
  /** 冲突处理用本页面的版本名称。 */
  labels?: Partial<Record<FileFindSide, string>>;
  /** 最后操作的版本由编辑区焦点更新。 */
  active: EditorView | null;
  /** 预览正文尚在加载时，在编辑器挂载后打开查找。 */
  pending?: boolean;
  /** 合并编辑器在定位后展开命中的折叠行。 */
  reveal?: (view: EditorView) => void;
}

/** 创建单个差异文件的查找范围。 */
export function useFileFindGroup(defaultSide: FileFindSide = 'after'): FileFindGroup {
  const host = useRef<HTMLDivElement>(null);
  return useMemo(() => ({ host, views: new Map(), active: null, defaultSide }), [host, defaultSide]);
}

/** 编辑器与所属查找范围关联，工具栏可通过真实 DOM 找到该编辑器。 */
const groups = new WeakMap<EditorView, FileFindGroup | undefined>();

/** 一个文件的两侧共用当前打开的面板。 */
function activeFindPanel(view: EditorView): EditorView | undefined {
  const group = groups.get(view);
  return group ? [...group.views.keys()].find((candidate) => searchPanelOpen(candidate.state)) : searchPanelOpen(view.state) ? view : undefined;
}

/** 打开指定版本，转交已经打开的查找词和选项。 */
export function openFileFind(view: EditorView): boolean {
  const group = groups.get(view);
  const open = activeFindPanel(view);
  const previous = open !== view ? open : undefined;
  const query = previous ? getSearchQuery(previous.state) : undefined;
  if (previous) closeSearchPanel(previous);
  if (group) group.active = view;
  openSearchPanel(view);
  if (query) view.dispatch({ effects: setSearchQuery.of(query) });
  return true;
}

/** 复用原生跳转，并确保折叠范围内的命中能看到。 */
function navigateFind(view: EditorView, backwards: boolean): boolean {
  if (!searchPanelOpen(view.state)) return openFileFind(view);
  if (getSearchQuery(view.state).valid && (backwards ? findPrevious : findNext)(view)) groups.get(view)?.reveal?.(view);
  return true;
}

/** 工具栏打开当前文档，初次打开双栏时优先当前版本。 */
export function openFileFindIn(container: HTMLElement | null): boolean {
  const views = Array.from(container?.querySelectorAll<HTMLElement>('.cm-editor[data-file-find]') ?? [])
    .filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'))
    .map((element) => EditorView.findFromDOM(element))
    .filter((view): view is EditorView => Boolean(view));
  const first = views[0];
  if (!first) return false;
  const group = groups.get(first);
  const target = views.find((view) => view.hasFocus) ?? views.find((view) => view === group?.active) ?? views.find((view) => group?.views.get(view) === group?.defaultSide) ?? first;
  return openFileFind(target);
}

/** 多栏的工具栏可能先于编辑器显示，保留一次打开请求。 */
export function requestGroupedFileFind(group: FileFindGroup): void {
  group.pending = !openFileFindIn(group.host.current?.parentElement ?? null);
}

/** 文件工具栏可在焦点离开正文时响应文件级快捷键。 */
export function fileFindShortcut(event: KeyboardEvent<HTMLElement>, openSource?: () => void, allowFileFields = false): void {
  if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
  if (!allowFileFields && (event.target as HTMLElement).closest('input, textarea, select, [contenteditable=true]')) return;
  if (openFileFindIn(event.currentTarget)) event.preventDefault();
  else if (openSource) {
    event.preventDefault();
    openSource();
  }
}

/** 文本、PDF 和表格共享查找输入、导航按钮及键盘行为。 */
export function FileFindControls(props: {
  zh: boolean;
  value: string;
  status: string;
  hasMatches: boolean;
  invalid?: boolean;
  request?: number;
  options?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  onChange(value: string): void;
  onNavigate(backwards: boolean): void;
  onClose(): void;
}) {
  /** 重复唤起选中现有查找词，跳转时保留输入焦点。 */
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [props.request]);

  /** 输入法组合期间保留输入法自身的键盘行为。 */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing) return;
    const modifier = event.ctrlKey || event.metaKey;
    const find = modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f';
    const navigate = (event.target === input.current && event.key === 'Enter') || event.key === 'F3' || (modifier && event.key.toLowerCase() === 'g');
    if (!find && !navigate && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') props.onClose();
    else if (find) {
      input.current?.focus();
      input.current?.select();
    } else if (props.hasMatches) props.onNavigate(event.shiftKey);
  }

  /** 文案同时用于按钮的读屏名称与提示。 */
  const findLabel = props.zh ? '查找' : 'Find';
  const up = props.zh ? '上一处匹配' : 'Previous match';
  const down = props.zh ? '下一处匹配' : 'Next match';
  const close = props.zh ? '关闭查找' : 'Close find';
  return (
    <div className="file-find-bar" role="search" aria-label={findLabel} onKeyDown={onKeyDown}>
      <div className="file-find-line">
        <div className="file-find-query">
          <input ref={input} main-field="true" aria-label={findLabel} placeholder={findLabel} value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)} spellCheck={false} aria-invalid={props.invalid} />
          <output aria-live="polite">{props.status}</output>
        </div>
        <div className="file-find-controls">
          {props.options}
          <Button unstyled type="button" aria-label={up} data-icon-tooltip={up} disabled={!props.hasMatches} onClick={() => props.onNavigate(true)}>
            <ArrowUpIcon aria-hidden="true" />
          </Button>
          <Button unstyled type="button" aria-label={down} data-icon-tooltip={down} disabled={!props.hasMatches} onClick={() => props.onNavigate(false)}>
            <ArrowDownIcon aria-hidden="true" />
          </Button>
          {props.actions}
          <Button unstyled type="button" aria-label={close} data-icon-tooltip={close} onClick={props.onClose}>
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
      {props.children}
    </div>
  );
}

/** 只读格式支持字面匹配与可选的大小写区分。 */
export function FileFindMatchCase(props: { zh: boolean; value: boolean; onChange(value: boolean): void }) {
  const label = props.zh ? '区分大小写' : 'Match case';
  return (
    <Button unstyled type="button" aria-label={label} data-icon-tooltip={label} aria-pressed={props.value} onClick={() => props.onChange(!props.value)}>
      Aa
    </Button>
  );
}

/** 所有文件工具栏使用同一查找入口和可访问名称。 */
export function FileFindButton(props: { zh: boolean; onFind(): void; disabled?: boolean }) {
  const label = props.zh ? '在文件中查找' : 'Find in file';
  return (
    <Button unstyled type="button" aria-label={label} data-icon-tooltip={label} onClick={props.onFind} disabled={props.disabled}>
      <MagnifyingGlassIcon size={16} aria-hidden="true" />
    </Button>
  );
}

/** 复用 CodeMirror 的匹配、选区和替换操作，为所有读写模式安装同一个面板。 */
export function fileFindExtension(zh: boolean, group?: FileFindGroup, side?: FileFindSide) {
  return [
    search({ top: true, createPanel: (view) => createFileFindPanel(view, zh, group) }),
    EditorState.phrases.of(zh ? { 'current match': '当前匹配', 'on line': '所在行' } : {}),
    group?.host.current ? panels({ topContainer: group.host.current }) : [],
    Prec.high(
      keymap.of([
        { key: 'Mod-f', run: openFileFind },
        {
          key: 'Escape',
          run: (view) => {
            const open = activeFindPanel(view);
            return open ? closeSearchPanel(open) : false;
          },
        },
        ...['Mod-g', 'F3'].map((key) => ({ key, run: (view: EditorView) => navigateFind(view, false), shift: (view: EditorView) => navigateFind(view, true) })),
        ...searchKeymap,
      ]),
    ),
    EditorView.domEventHandlers({
      focus(_event, view) {
        if (group) group.active = view;
      },
    }),
    ViewPlugin.define((view) => {
      groups.set(view, group);
      view.dom.dataset.fileFind = '';
      if (group && side) {
        group.views.set(view, side);
        if (group.pending)
          queueMicrotask(() => {
            if (group.pending && view.dom.isConnected) requestGroupedFileFind(group);
          });
      }
      return {
        destroy() {
          groups.delete(view);
          delete view.dom.dataset.fileFind;
          group?.views.delete(view);
          if (group?.active === view) group.active = null;
        },
      };
    }),
  ];
}

/** 面板跟随 CodeMirror 的打开和销毁，并用编辑器所属窗口创建控件。 */
function createFileFindPanel(view: EditorView, zh: boolean, group?: FileFindGroup): Panel {
  const dom = view.dom.ownerDocument.createElement('div');
  const root = createRoot(dom);
  /** 查询和选区变化只刷新已打开的查找栏。 */
  const render = () => root.render(<FileFindBar view={view} state={view.state} zh={zh} group={group} />);
  return {
    dom,
    top: true,
    mount: render,
    update(update) {
      if (update.docChanged || update.selectionSet || update.startState.readOnly !== update.state.readOnly || getSearchQuery(update.startState) !== getSearchQuery(update.state)) render();
    },
    destroy() {
      queueMicrotask(() => root.unmount());
    },
  };
}

/** 共用顶栏展示当前范围的查找词、匹配和编辑操作。 */
function FileFindBar({ view, state, zh, group }: { view: EditorView; state: EditorView['state']; zh: boolean; group?: FileFindGroup }) {
  const query = getSearchQuery(state);
  /** 固定匹配条件时，切换选区或输入替换文本不用重新扫描正文。 */
  const { search: text, caseSensitive, wholeWord, regexp } = query;
  const hits = useMemo(() => {
    const matcher = new SearchQuery({ search: text, caseSensitive, wholeWord, regexp });
    const offsets: number[] = [];
    if (matcher.valid) {
      const cursor = matcher.getCursor(state.doc);
      for (let match = cursor.next(); !match.done; match = cursor.next()) {
        offsets.push(match.value.from);
        // ponytail: 只统计前一万处，匹配跳转仍使用完整文档。
        if (offsets.length > 10_000) break;
      }
    }
    return offsets;
  }, [state.doc, text, caseSensitive, wholeWord, regexp]);
  const index = hits.indexOf(state.selection.main.from);
  const count = hits.length > 10_000 ? '10000+' : String(hits.length);
  const replacement = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState(false);
  useEffect(() => {
    if (replacing) replacement.current?.focus();
  }, [replacing]);

  /** 写入编辑器状态，沿用原生匹配和替换命令。 */
  function change(values: Partial<SearchQuery>): void {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...getSearchQuery(view.state), ...values })) });
  }

  /** 改变范围时聚焦新版本的查找输入，并沿用当前查询。 */
  function selectSide(side: string): void {
    const target = group && [...group.views].find(([, name]) => name === side)?.[0];
    if (target && target !== view) openFileFind(target);
  }

  /** 选项状态来自本次查询，保持图标与读屏一致。 */
  const options = [
    { key: 'caseSensitive', glyph: 'Aa', label: zh ? '区分大小写' : 'Match case' },
    { key: 'wholeWord', glyph: <u>ab</u>, label: zh ? '全字匹配' : 'Match whole word' },
    { key: 'regexp', glyph: '.*', label: zh ? '正则表达式' : 'Regular expression' },
  ] as const;
  const replace = zh ? '替换' : 'Replace';
  const all = zh ? '全选匹配' : 'Select all matches';

  return (
    <FileFindControls
      zh={zh}
      value={query.search}
      status={text ? (query.valid ? (hits.length ? (index < 0 ? count : `${index + 1} / ${count}`) : zh ? '无匹配' : 'No matches') : zh ? '正则无效' : 'Invalid regex') : ''}
      invalid={Boolean(text && !query.valid)}
      hasMatches={hits.length > 0}
      onChange={(search) => change({ search })}
      onNavigate={(backwards) => navigateFind(view, backwards)}
      onClose={() => closeSearchPanel(view)}
      options={
        <>
          {options.map(({ key, glyph, label }) => (
            <Button unstyled type="button" key={key} aria-label={label} data-icon-tooltip={label} aria-pressed={query[key]} onClick={() => change({ [key]: !query[key] })}>
              {glyph}
            </Button>
          ))}
          {group && group.views.size > 1 ? (
            <select aria-label={zh ? '查找版本' : 'Find in version'} value={group.views.get(view)} onChange={(event) => selectSide(event.currentTarget.value)}>
              {[...new Set(group.views.values())].map((side) => (
                <option key={side} value={side}>
                  {group.labels?.[side] ?? (side === 'before' ? (zh ? '旧版本' : 'Previous version') : zh ? '当前版本' : 'Current version')}
                </option>
              ))}
            </select>
          ) : null}
        </>
      }
      actions={
        <>
          <Button
            unstyled
            type="button"
            aria-label={all}
            data-icon-tooltip={all}
            disabled={!hits.length}
            onClick={() => {
              selectMatches(view);
            }}
          >
            ≡
          </Button>
          {!state.readOnly ? (
            <Button unstyled type="button" aria-label={replace} data-icon-tooltip={replace} aria-expanded={replacing} onClick={() => setReplacing(!replacing)}>
              <ArrowsLeftRightIcon aria-hidden="true" />
            </Button>
          ) : null}
        </>
      }
    >
      {replacing && !state.readOnly ? (
        <div className="file-find-replace">
          <input
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.stopPropagation();
              if (query.valid) replaceNext(view);
            }}
            ref={replacement}
            aria-label={zh ? '替换为' : 'Replace with'}
            placeholder={zh ? '替换为' : 'Replace with'}
            value={query.replace}
            onChange={(event) => change({ replace: event.currentTarget.value })}
          />
          <Button
            size="compact"
            disabled={!hits.length}
            onClick={() => {
              replaceNext(view);
            }}
          >
            {replace}
          </Button>
          <Button
            size="compact"
            disabled={!hits.length}
            onClick={() => {
              replaceAll(view);
            }}
          >
            {zh ? '全部替换' : 'Replace all'}
          </Button>
        </div>
      ) : null}
    </FileFindControls>
  );
}
