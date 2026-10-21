import { useRef, useState } from 'react';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { MenuSurface } from '../ui/MenuSurface.js';

/** 全部差异入口使用同一组范围、定位与次要操作。 */
export function DiffReviewToolbar(props: {
  /** 文案使用所在页面语言。 */
  zh: boolean;
  /** 全文只在两侧真实内容均可用时开放。 */
  full: boolean;
  fullAvailable: boolean;
  onFullChange: (full: boolean) => void;
  /** 当前差异序号从零开始，未定位时为负数。 */
  current: number;
  count: number;
  onNavigate: (direction: -1 | 1) => void;
  /** 布局属于次要设置，不与显示范围混用。 */
  unified: boolean;
  /** 新增或删除文件只有有效单侧，不提供无效的布局切换。 */
  allowLayout: boolean;
  onUnifiedChange: (unified: boolean) => void;
  /** 纯补丁快照不提供文件预览或重新读取。 */
  onPreview?: () => void;
  onRefresh?: () => void;
}) {
  /** 菜单定位只在用户打开时读取，滚动时由共享菜单关闭。 */
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  /** 关闭菜单后返回触发按钮，保持键盘操作连续。 */
  const trigger = useRef<HTMLButtonElement>(null);
  /** 没有次要操作时不显示空菜单入口。 */
  const hasOptions = props.allowLayout || Boolean(props.onPreview || props.onRefresh);
  /** 执行菜单选项后收起并恢复焦点。 */
  function choose(action: () => void): void {
    action();
    setMenu(null);
    trigger.current?.focus();
  }
  return (
    <div className="diff-review-toolbar" role="group" aria-label={props.zh ? '差异操作' : 'Diff actions'}>
      <span className="diff-review-range" role="group" aria-label={props.zh ? '显示范围' : 'Visible range'}>
        <button type="button" aria-pressed={!props.full} onClick={() => props.onFullChange(false)}>
          {props.zh ? '差异附近' : 'Changes'}
        </button>
        <button type="button" aria-pressed={props.full} disabled={!props.fullAvailable} title={!props.fullAvailable ? (props.zh ? '完整文件不可用' : 'Complete files unavailable') : undefined} onClick={() => props.onFullChange(true)}>
          {props.zh ? '全文' : 'Full file'}
        </button>
      </span>
      <span className="diff-review-navigation" role="group" aria-label={props.zh ? '定位差异' : 'Navigate changes'}>
        <button type="button" aria-label={props.zh ? '上一处差异' : 'Previous change'} data-icon-tooltip={props.zh ? '上一处差异' : 'Previous change'} disabled={props.current <= 0} onClick={() => props.onNavigate(-1)}>
          <ArrowUpIcon size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={props.zh ? '下一处差异' : 'Next change'}
          data-icon-tooltip={props.zh ? '下一处差异' : 'Next change'}
          disabled={props.count === 0 || props.current >= props.count - 1}
          onClick={() => props.onNavigate(1)}
        >
          <ArrowDownIcon size={16} aria-hidden="true" />
        </button>
        <span className="diff-review-position" aria-live="polite">
          {props.current < 0 ? (props.zh ? `${props.count} 处差异` : `${props.count} changes`) : `${props.current + 1} / ${props.count}`}
        </span>
      </span>
      {hasOptions ? (
        <button
          ref={trigger}
          type="button"
          aria-label={props.zh ? '更多差异操作' : 'More diff actions'}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          onClick={() => {
            /** 菜单保持在视口内，窄窗口仍能访问全部选项。 */
            const rect = trigger.current!.getBoundingClientRect();
            /** 跨窗口门户使用触发按钮所属的视口。 */
            const ownerWindow = trigger.current!.ownerDocument.defaultView ?? window;
            setMenu(menu ? null : { left: Math.max(8, Math.min(rect.right - 180, ownerWindow.innerWidth - 188)), top: rect.bottom + 4 });
          }}
        >
          <DotsThreeIcon size={18} aria-hidden="true" />
        </button>
      ) : null}
      {menu && hasOptions ? (
        <MenuSurface className="diff-review-menu" style={{ position: 'fixed', ...menu }} onClose={() => setMenu(null)}>
          {props.allowLayout ? (
            <>
              <button type="button" role="menuitemradio" aria-checked={!props.unified} onClick={() => choose(() => props.onUnifiedChange(false))}>
                {props.zh ? '左右两栏' : 'Side by side'}
              </button>
              <button type="button" role="menuitemradio" aria-checked={props.unified} onClick={() => choose(() => props.onUnifiedChange(true))}>
                {props.zh ? '统一视图' : 'Unified view'}
              </button>
            </>
          ) : null}
          {props.onPreview ? (
            <button type="button" role="menuitem" onClick={() => choose(props.onPreview!)}>
              {props.zh ? '内容预览' : 'Preview content'}
            </button>
          ) : null}
          {props.onRefresh ? (
            <button type="button" role="menuitem" onClick={() => choose(props.onRefresh!)}>
              {props.zh ? '刷新文件' : 'Refresh file'}
            </button>
          ) : null}
        </MenuSurface>
      ) : null}
    </div>
  );
}
