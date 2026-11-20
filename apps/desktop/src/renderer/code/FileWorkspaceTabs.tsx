import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './fileWorkspaceToolbar.css';

/** 从一行内可阅读的标签宽度计算可见数量，单位为 CSS 像素。 */
const tabSlotWidth = 144;
/** 下拉入口及相邻间距的保留宽度，单位为 CSS 像素。 */
const pickerSlotWidth = 32;

/** 文件标签留在单行，当前标签始终可见，其余标签按原顺序进入选择器。 */
export function FileWorkspaceTabs<T>({
  tabs,
  activeId,
  tabId,
  tabLabel,
  onSelect,
  renderTab,
  zh,
}: {
  /** 已打开文件，按打开顺序保留原标签身份。 */
  tabs: readonly T[];
  /** 当前选中文件的稳定身份。 */
  activeId: string | null;
  /** 提取标签身份，用于保留打开、关闭和键盘导航规则。 */
  tabId: (tab: T) => string;
  /** 选择器中显示可区分同名文件的路径。 */
  tabLabel: (tab: T) => string;
  /** 通过所属工作区切换文件。 */
  onSelect: (tab: T) => void | Promise<void>;
  /** 沿用调用方的文件图标、状态和关闭按钮。 */
  renderTab: (tab: T) => ReactNode;
  /** 标签栏及选择器使用的语言。 */
  zh: boolean;
}) {
  /** 实际宽度排除了加号、文件树按钮等同栏控件。 */
  const stripRef = useRef<HTMLDivElement>(null);
  /** 键盘选择隐藏文件后，需要等待选中标签进入 DOM。 */
  const focusTarget = useRef<string | null>(null);
  /** 标签与选择器可占用的宽度，单位为 CSS 像素。 */
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    /** 当前容器由父栏分配宽度，标签增减不会重设容器。 */
    const strip = stripRef.current;
    if (!strip) return;
    /** 布局改变时读取包含菜单的稳定宽度，避免反复切换菜单显隐。 */
    const measure = () => setWidth(strip.clientWidth);
    /** 拖动分栏与窗口缩放都通过容器实际宽度更新。 */
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!focusTarget.current || focusTarget.current !== activeId) return;
    focusTarget.current = null;
    stripRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, [activeId]);

  /** 装不下全部标签时，先给原生选择器留出一个固定槽位。 */
  const fitsAll = tabs.length <= Math.max(1, Math.floor(width / tabSlotWidth));
  /** 即使面板较窄，也给当前文件留一个可见槽位。 */
  const visibleCount = fitsAll ? tabs.length : Math.max(1, Math.floor((width - pickerSlotWidth) / tabSlotWidth));
  /** 使用原顺序计算首尾键和隐藏标签。 */
  const activeIndex = tabs.findIndex((tab) => tabId(tab) === activeId);
  /** 当前文件在可见范围之外时，腾出最后一个可见槽位。 */
  const headCount = visibleCount - (activeIndex >= visibleCount ? 1 : 0);
  /** 按打开顺序在原生菜单列出隐藏标签。 */
  const hiddenTabs = new Set(tabs.slice(headCount).filter((tab) => tabId(tab) !== activeId));
  /** 图标入口的可访问名称与悬浮提示一致。 */
  const pickerLabel = zh ? '更多已打开文件' : 'More open files';

  /** 方向键按完整标签顺序切换，隐藏标签选中后会立即显示。 */
  function selectAndFocus(tab: T): void {
    if (tabId(tab) === activeId) return;
    focusTarget.current = tabId(tab);
    void onSelect(tab);
  }

  return (
    <div className="file-workspace-tabs" ref={stripRef}>
      <div
        className="file-workspace-tab-list"
        role="tablist"
        aria-label={zh ? '已打开文件' : 'Open files'}
        onKeyDown={(event) => {
          if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          /** 首尾键直接定位，左右方向键循环切换。 */
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (activeIndex + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
          selectAndFocus(tabs[index]!);
        }}
      >
        {tabs.map((tab) => (hiddenTabs.has(tab) ? null : renderTab(tab)))}
      </div>
      {hiddenTabs.size ? (
        <label className="file-workspace-tab-picker">
          <CaretDown aria-hidden="true" />
          <select
            aria-label={pickerLabel}
            data-icon-tooltip={pickerLabel}
            value=""
            onChange={(event) => {
              /** 选择时通过原始身份查找文件，避免同名文件混淆。 */
              const tab = tabs.find((item) => tabId(item) === event.currentTarget.value);
              if (tab !== undefined) selectAndFocus(tab);
            }}
          >
            <option value="" disabled>
              {pickerLabel}
            </option>
            {Array.from(hiddenTabs, (tab) => (
              <option key={tabId(tab)} value={tabId(tab)}>
                {tabLabel(tab)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
