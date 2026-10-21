import { useEffect, useMemo, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Prec } from '@codemirror/state';
import { EditorView, GutterMarker, gutter } from '@codemirror/view';
import type { GitBlameLine } from '../features/git/gitContracts.js';
import { MenuSurface } from '../ui/MenuSurface.js';
import { formatBlameAuthor, hasBlameCommit } from './blamePresentation.js';
import './blameGutter.css';

/** 所有源码、预览和差异默认软换行并隐藏作者栏；同一窗口的菜单修改同步生效。 */
let readingOptions = { wrap: true, blame: false };
/** 阅读选项变化只通知已挂载的编辑器。 */
const listeners = new Set<() => void>();
/** React 订阅共享选项，卸载后释放监听。 */
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** 返回稳定快照，避免无变化时重复渲染。 */
function snapshot() {
  return readingOptions;
}

/** 阅读选项只控制布局和作者侧栏，源码当前行的真实提交详情保持原有行为。 */
function useCodeReadingPreferences() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 行号左侧的提交信息不进入文档，也不进入复制内容。 */
class AuthorMarker extends GutterMarker {
  /** 保存已映射到当前显示行的真实提交记录。 */
  constructor(
    private readonly blame: GitBlameLine,
    private readonly zh: boolean,
  ) {
    super();
  }
  /** 同一记录与语言复用节点。 */
  eq(other: AuthorMarker) {
    return this.blame === other.blame && this.zh === other.zh;
  }
  /** 日期和提交人使用统一格式，提交号和说明通过悬停查看。 */
  toDOM() {
    /** 侧栏文字保持单行，避免长作者名改变代码行高。 */
    const element = document.createElement('span');
    element.textContent = formatBlameAuthor(this.blame);
    element.dataset.iconTooltip = [element.textContent, new Date(this.blame.authorTime * 1000).toLocaleString(this.zh ? 'zh-CN' : 'en-US'), this.blame.shortHash, this.blame.subject].filter(Boolean).join('\n');
    return element;
  }
}

/** 源码、差异、评论预览共用菜单、软换行和逐行归属侧栏。 */
export function useCodeReadingOptions(hostRef: RefObject<HTMLElement | null>, lines?: GitBlameLine[], locale = 'zh-CN', hostIdentity?: unknown) {
  /** 两侧编辑器读取同一快照，菜单切换不会重建文档。 */
  const options = useCodeReadingPreferences();
  /** 菜单只从行号及其左侧打开，正文保留原生选择和右键行为。 */
  const [point, setPoint] = useState<{ x: number; y: number; document: Document } | null>(null);
  /** 当前文案语言。 */
  const zh = locale.startsWith('zh');
  /** 原始归属由调用方映射，空白补位不会借用相邻作者。 */
  const extension = useMemo(
    () => [
      options.wrap ? EditorView.lineWrapping : [],
      options.blame && lines?.some(hasBlameCommit)
        ? Prec.high(
            gutter({
              class: 'code-author-gutter',
              lineMarker: (view, line) => {
                /** 未提交行、差异补白和区块标题不显示归属占位，也不借用相邻行。 */
                const blame = lines[view.state.doc.lineAt(line.from).number - 1];
                return hasBlameCommit(blame) ? new AuthorMarker(blame, zh) : null;
              },
            }),
          )
        : [],
    ],
    [lines, options.wrap, options.blame, zh],
  );
  useEffect(() => {
    /** 使用 DOM 冒泡覆盖 React portal 渲染的差异行号，所有入口保留同一个菜单。 */
    const host = hostRef.current;
    if (!host) return;
    /** 只消费侧栏右键，不影响左键拖选和评论按钮。 */
    const onContextMenu = (event: MouseEvent) => {
      /** 独立预览文档的节点不一定属于主窗口的 Element 构造器。 */
      const target = event.target as Element;
      if (typeof target.closest !== 'function' || !target.closest('.cm-gutters')) return;
      event.preventDefault();
      event.stopPropagation();
      setPoint({ x: event.clientX, y: event.clientY, document: host.ownerDocument });
    };
    host.addEventListener('contextmenu', onContextMenu);
    return () => host.removeEventListener('contextmenu', onContextMenu);
  }, [hostRef, hostIdentity]);
  /** 两个选项都有可访问的选中状态，菜单关闭交给统一组件。 */
  const menu = point
    ? createPortal(
        <MenuSurface
          className="project-git-context-menu code-reading-menu"
          style={{ left: point.x, top: point.y }}
          aria-label={zh ? '代码阅读选项' : 'Code reading options'}
          onClose={() => setPoint(null)}
          onContextMenu={(event) => event.preventDefault()}
        >
          {(['wrap', 'blame'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={options[key]}
              onClick={() => {
                readingOptions = { ...readingOptions, [key]: !readingOptions[key] };
                listeners.forEach((listener) => listener());
                setPoint(null);
              }}
            >
              <span aria-hidden="true">{options[key] ? '✓' : '\u00a0'}</span>
              {key === 'wrap' ? (zh ? '软换行' : 'Soft wrap') : zh ? '提交人' : 'Commit author'}
            </button>
          ))}
        </MenuSurface>,
        point.document.querySelector('.macos-ai-app') ?? point.document.body,
      )
    : null;
  return { extension, menu };
}
