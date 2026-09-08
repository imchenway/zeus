import { CaretLeftIcon } from '@phosphor-icons/react/dist/csr/CaretLeft';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { Button } from '../ui/Button.js';

/** 设置中的长列表统一每页十条，避免将整个历史一次铺满页面。 */
export const settingsPageSize = 10;

/** 夹紧当前页；删除末页记录或收窄筛选后仍显示有效内容。 */
export function settingsPage(total: number, requestedPage: number): number {
  return Math.max(1, Math.min(requestedPage, Math.ceil(total / settingsPageSize)));
}

/** 用量、模型和归档列表共用的翻页控件，支持键盘直接选择页码。 */
export function SettingsPagination(props: {
  /** 过滤后的记录数。 */
  total: number;
  /** 从一开始的当前页。 */
  page: number;
  /** 当前界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 区分同页的多组分页。 */
  label: string;
  /** 加载期间保留页码，暂停翻页。 */
  disabled?: boolean;
  /** 更新列表页码。 */
  onChange: (page: number) => void;
}) {
  /** 页数随筛选和删除实时计算。 */
  const pages = Math.max(1, Math.ceil(props.total / settingsPageSize));
  /** 防止列表缩短后停留在空白页。 */
  const page = settingsPage(props.total, props.page);
  /** 文案跟随界面语言。 */
  const zh = props.language === 'zh-CN';
  if (props.total <= settingsPageSize) return null;
  return (
    <nav className="settings-pagination" aria-label={`${props.label} ${zh ? '分页' : 'pagination'}`}>
      <span role="status">
        {(page - 1) * settingsPageSize + 1}–{Math.min(page * settingsPageSize, props.total)} / {props.total} {zh ? '条' : 'items'}
      </span>
      <div>
        <Button size="compact" aria-label={`${props.label} ${zh ? '上一页' : 'previous page'}`} disabled={props.disabled || page === 1} onClick={() => props.onChange(page - 1)}>
          <CaretLeftIcon aria-hidden="true" />
        </Button>
        <label>
          <span className="visually-hidden">{zh ? '选择页码' : 'Choose page'}</span>
          <select value={page} disabled={props.disabled} onChange={(event) => props.onChange(Number(event.currentTarget.value))}>
            {Array.from({ length: pages }, (_, index) => (
              <option key={index + 1} value={index + 1}>
                {zh ? `第 ${index + 1} / ${pages} 页` : `${index + 1} / ${pages}`}
              </option>
            ))}
          </select>
        </label>
        <Button size="compact" aria-label={`${props.label} ${zh ? '下一页' : 'next page'}`} disabled={props.disabled || page === pages} onClick={() => props.onChange(page + 1)}>
          <CaretRightIcon aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
