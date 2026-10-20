import { useMemo, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Prec } from '@codemirror/state';
import { EditorView, GutterMarker, gutter } from '@codemirror/view';
import type { GitBlameLine } from '../features/git/gitContracts.js';
import { MenuSurface } from '../ui/MenuSurface.js';
import './blameGutter.css';

/** 同一窗口的源码、预览和左右差异共用阅读偏好，不修改文件内容。 */
let readingOptions = { wrap: false, blame: true };
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

/** 行尾归属与侧栏使用同一显示开关，关闭提交人后不残留作者文字。 */
export function useCodeReadingPreferences() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 行号左侧的提交信息不进入文档，也不进入复制内容。 */
class AuthorMarker extends GutterMarker {
  /** 保存已映射到当前显示行的真实提交记录。 */
  constructor(
    private readonly blame: GitBlameLine | undefined,
    private readonly zh: boolean,
  ) {
    super();
  }
  /** 同一记录与语言复用节点。 */
  eq(other: AuthorMarker) {
    return this.blame === other.blame && this.zh === other.zh;
  }
  /** 提交人常驻，时间、提交号和说明通过悬停查看。 */
  toDOM() {
    /** 侧栏文字保持单行，避免长作者名改变代码行高。 */
    const element = document.createElement('span');
    /** 全零提交号表示当前版本中尚未提交的内容。 */
    const uncommitted = this.blame && /^0+$/u.test(this.blame.commitHash);
    element.textContent = uncommitted ? (this.zh ? '未提交' : 'Uncommitted') : this.blame?.author || '—';
    element.dataset.iconTooltip = this.blame
      ? [element.textContent, this.blame.authorTime > 0 ? new Date(this.blame.authorTime * 1000).toLocaleString(this.zh ? 'zh-CN' : 'en-US') : '', this.blame.shortHash, this.blame.subject].filter(Boolean).join('\n')
      : this.zh
        ? '此行没有可用的提交信息'
        : 'No commit information for this line';
    return element;
  }
}

/** 源码、差异、评论预览共用菜单、软换行和逐行归属侧栏。 */
export function useCodeReadingOptions(lines?: GitBlameLine[], locale = 'zh-CN', showAuthorGutter = true) {
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
      options.blame && showAuthorGutter
        ? Prec.high(
            gutter({
              class: 'code-author-gutter',
              lineMarker: (view, line) => new AuthorMarker(lines?.[view.state.doc.lineAt(line.from).number - 1], zh),
            }),
          )
        : [],
    ],
    [lines, options.wrap, options.blame, zh, showAuthorGutter],
  );
  /** 只消费侧栏右键，不影响左键拖选和评论按钮。 */
  function onContextMenu(event: MouseEvent<HTMLElement>) {
    /** 独立预览文档的节点不一定属于主窗口的 Element 构造器。 */
    const target = event.target as Element;
    if (typeof target.closest !== 'function' || !target.closest('.cm-gutters')) return;
    event.preventDefault();
    event.stopPropagation();
    setPoint({ x: event.clientX, y: event.clientY, document: event.currentTarget.ownerDocument });
  }
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
  return { extension, onContextMenu, menu, wrap: options.wrap, blame: options.blame };
}
