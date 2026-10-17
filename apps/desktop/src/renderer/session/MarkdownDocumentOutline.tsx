import { ListBulletsIcon as ListBullets } from '@phosphor-icons/react/dist/csr/ListBullets';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '../ui/Button.js';
import { SourceListRow } from '../ui/SourceListRow.js';

/** 大纲对应已渲染的真实标题，避免代码块、重复标题和解析差异造成错误定位。 */
interface DocumentHeading {
  /** 标题所在的正文节点，定位时不修改应用路由。 */
  element: HTMLHeadingElement;
  /** Markdown 标题层级，用于展示缩进。 */
  level: number;
  /** 去除标记后的可读标题。 */
  title: string;
}

/** 四个文件预览入口共用文档内侧栏；关闭时不扫描正文，不改变会话渲染。 */
export function MarkdownDocumentOutline(props: {
  /** 当前文件正文的根节点。 */
  root: RefObject<HTMLDivElement | null>;
  /** 大纲跟随预览界面的语言。 */
  language: 'zh-CN' | 'en-US';
}) {
  /** 展开状态仅属于当前文件，父组件在文件切换时重新挂载。 */
  const [open, setOpen] = useState(false);
  /** 条目只引用当前实际存在的标题。 */
  const [headings, setHeadings] = useState<DocumentHeading[]>([]);
  /** 用户点击的章节保持选中，重复标题按节点区分。 */
  const [selected, setSelected] = useState<HTMLHeadingElement | null>(null);
  /** 关闭侧栏后将键盘焦点交回打开按钮。 */
  const toggle = useRef<HTMLButtonElement>(null);
  /** 侧栏独立滚动，不占用正文的滚动位置。 */
  const panel = useRef<HTMLElement>(null);
  /** 展开按钮与侧栏通过稳定身份关联。 */
  const panelId = useId();
  /** 所有可见文案使用同一界面语言。 */
  const zh = props.language === 'zh-CN';
  /** 标题与无障碍名称保持一致。 */
  const title = zh ? '大纲' : 'Outline';
  /** 按钮提示描述下一次点击的操作。 */
  const toggleLabel = open ? (zh ? '收起大纲' : 'Hide outline') : zh ? '显示大纲' : 'Show outline';

  /** 展开期间同步真实标题和可用高度，关闭时撤销全部观察。 */
  useLayoutEffect(() => {
    if (!open) return;
    /** 只扫描真实 Markdown 正文，不把侧栏文字加入目录。 */
    const markdown = props.root.current?.querySelector(':scope > .markstream-react');
    if (!markdown) return;
    /** 内容更新时同步标题，原生内容可见性不会删除屏外节点。 */
    const collect = () => {
      /** 使用实际标题元素，代码围栏中的井号不会变成目录条目。 */
      const next = [...markdown.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4, h5, h6')].map((element) => ({ element, level: Number(element.tagName.slice(1)), title: element.textContent?.trim() || (zh ? '无标题' : 'Untitled') }));
      setHeadings((previous) =>
        previous.length === next.length && previous.every((heading, index) => heading.element === next[index]?.element && heading.title === next[index]?.title && heading.level === next[index]?.level) ? previous : next,
      );
    };
    collect();
    /** 找到当前预览真正的滚动边界，兼顾文件页、源码页和成果弹窗。 */
    let scroller = props.root.current?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/u.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    /** 按当前预览边界限制侧栏高度，所有标题都可在侧栏内部滚动到达。 */
    const measure = () => {
      if (!panel.current) return;
      /** 取视口和实际滚动容器的交集，避免侧栏延伸到弹窗外。 */
      const bottom = Math.min(window.innerHeight, scroller?.getBoundingClientRect().bottom ?? window.innerHeight);
      panel.current.style.maxBlockSize = `${Math.max(80, bottom - panel.current.getBoundingClientRect().top - 8)}px`;
    };
    /** 正文重新解析时同步目录，普通滚动不重复扫描长文。 */
    const observer = new MutationObserver(collect);
    observer.observe(markdown, { childList: true, subtree: true, characterData: true });
    /** 分栏拖动和弹窗布局变化无需各入口重复处理。 */
    const resize = new ResizeObserver(measure);
    if (scroller) resize.observe(scroller);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    measure();
    panel.current?.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, props.root, zh]);

  /** 关闭按钮与 Escape 使用同一条恢复焦点的路径。 */
  function close() {
    setOpen(false);
    toggle.current?.focus({ preventScroll: true });
  }

  /** 只在当前正文内定位；窄分栏覆盖正文时，选章后让出阅读空间。 */
  function navigate(heading: DocumentHeading) {
    /** 是否为覆盖式侧栏由实际布局判断，不重复配置 CSS 断点。 */
    const body = props.root.current?.querySelector(':scope > .markstream-react');
    if (panel.current && body && panel.current.getBoundingClientRect().left < body.getBoundingClientRect().right) setOpen(false);
    setSelected(heading.element);
    heading.element.tabIndex = -1;
    heading.element.focus({ preventScroll: true });
    heading.element.scrollIntoView({ block: 'start', inline: 'nearest' });
  }

  return (
    <>
      <Button ref={toggle} size="compact" className="session-markdown-outline-toggle" aria-label={toggleLabel} aria-expanded={open} aria-controls={panelId} data-icon-tooltip={toggleLabel} onClick={() => setOpen((value) => !value)}>
        <ListBullets size={16} aria-hidden="true" />
        {title}
      </Button>
      {open ? (
        <nav
          ref={panel}
          id={panelId}
          className="session-markdown-outline"
          aria-label={title}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <header>
            <strong>{title}</strong>
            <Button size="compact" aria-label={zh ? '关闭大纲' : 'Close outline'} onClick={close}>
              <X size={14} aria-hidden="true" />
            </Button>
          </header>
          {headings.length ? (
            <ol>
              {headings.map((heading, index) => (
                <li key={index} style={{ paddingInlineStart: (heading.level - 1) * 12 }}>
                  <SourceListRow
                    level="nested"
                    surface="content"
                    icon={null}
                    label={heading.title}
                    selected={selected === heading.element}
                    buttonProps={{ type: 'button', onClick: () => navigate(heading), 'aria-current': selected === heading.element ? 'location' : undefined, title: heading.title }}
                  />
                </li>
              ))}
            </ol>
          ) : (
            <p role="status">{zh ? '此文档没有标题' : 'No headings in this document'}</p>
          )}
        </nav>
      ) : null}
    </>
  );
}
